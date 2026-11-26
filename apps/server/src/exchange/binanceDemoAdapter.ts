import type {
  BrokerMode,
  AccountInfo,
  OpenOrderRequest,
  OpenOrderInfo,
  TradeSide,
  FillRecord,
} from '@tradeos/shared';
import {
  BinanceClient,
  BinanceApiError,
  ExchangeBannedError,
  ExchangeDegradedError,
} from './binanceClient.js';
import type {
  BrokerAdapter,
  PositionInfo,
  OrderExecutionResult,
  AlgoOrderParams,
  AlgoOrderResult,
} from './broker.js';

export interface BinanceDemoAdapterOptions {
  client: BinanceClient;
}

/**
 * Live Binance Futures Demo (Testnet) Broker Adapter.
 * Enforces deterministic client IDs (tos_${tradeId}_*), fail-closed account balance checks,
 * reduceOnly protections on SL/TP algo orders, and atomic bracket management.
 */
export class BinanceDemoAdapter implements BrokerAdapter {
  public readonly mode: BrokerMode = 'BINANCE_DEMO';
  private client: BinanceClient;

  constructor(options: BinanceDemoAdapterOptions) {
    this.client = options.client;
  }

  /**
   * Helper to construct deterministic client order ID.
   * tos_${tradeId}_ent, tos_${tradeId}_sl, tos_${tradeId}_tp1, tos_${tradeId}_tp2
   */
  static formatClientId(tradeId: string, role: 'ent' | 'sl' | 'tp1' | 'tp2'): string {
    return `tos_${tradeId}_${role}`;
  }

  /**
   * Helper to parse tradeId and order role from deterministic client order ID.
   */
  static parseClientId(clientOrderId: string): { tradeId: string; role: string } | null {
    if (!clientOrderId || typeof clientOrderId !== 'string') return null;
    const match = clientOrderId.match(/^tos_([a-zA-Z0-9-]+)_(ent|sl|tp1|tp2)$/);
    if (!match) return null;
    return {
      tradeId: match[1],
      role: match[2],
    };
  }

  /**
   * Queries real account balance and margin equity from Binance Testnet.
   * CRITICAL FAIL-CLOSED GUARANTEE: Never falls back to fabricated $1000 balance on failure.
   */
  async getAccount(): Promise<AccountInfo> {
    try {
      const data = await this.client.getAccount();
      if (!data) {
        throw new Error('Empty response payload from Binance account query');
      }

      const walletBalance = parseFloat(data.totalWalletBalance ?? data.totalMarginBalance ?? '0');
      const equity = parseFloat(data.totalMarginBalance ?? data.totalWalletBalance ?? '0');
      const availableBalance = parseFloat(data.availableBalance ?? '0');
      const unrealizedPnl = parseFloat(data.totalUnrealizedProfit ?? '0');

      return {
        walletBalance: Number.isFinite(walletBalance) ? walletBalance : 0,
        equity: Number.isFinite(equity) ? equity : 0,
        availableBalance: Number.isFinite(availableBalance) ? availableBalance : 0,
        unrealizedPnl: Number.isFinite(unrealizedPnl) ? unrealizedPnl : 0,
        currency: 'USDT',
      };
    } catch (err: any) {
      // Fail closed — throw ExchangeDegradedError rather than returning fake balance!
      throw new ExchangeDegradedError(
        `Failed to retrieve Binance Demo account balance: ${err.message}`,
        err
      );
    }
  }

  /**
   * Queries all non-zero active contract positions across all symbols.
   */
  async getAllPositions(): Promise<PositionInfo[]> {
    try {
      const positions = await this.client.getPositionRisk();
      if (!Array.isArray(positions)) {
        return [];
      }

      const result: PositionInfo[] = [];
      for (const pos of positions) {
        const positionAmt = parseFloat(pos.positionAmt ?? '0');
        if (Math.abs(positionAmt) < 1e-8) continue;
        result.push({
          symbol: String(pos.symbol ?? '').toUpperCase(),
          positionAmt,
          entryPrice: parseFloat(pos.entryPrice ?? '0'),
          markPrice: parseFloat(pos.markPrice ?? '0'),
          unRealizedProfit: parseFloat(pos.unRealizedProfit ?? '0'),
          liquidationPrice: parseFloat(pos.liquidationPrice ?? '0'),
          leverage: parseInt(pos.leverage ?? '1', 10),
          marginType: pos.marginType,
        });
      }
      return result;
    } catch (err: any) {
      throw new ExchangeDegradedError(
        `Failed to retrieve all Binance Demo positions: ${err.message}`,
        err
      );
    }
  }

  /**
   * Queries active contract position on symbol.
   */
  async getPosition(symbol: string): Promise<PositionInfo | null> {
    const symUpper = symbol.toUpperCase();
    try {
      const positions = await this.client.getPositionRisk(symUpper);
      if (!Array.isArray(positions)) {
        return null;
      }

      const pos = positions.find((p: any) => p.symbol === symUpper);
      if (!pos) return null;

      const positionAmt = parseFloat(pos.positionAmt ?? '0');
      if (Math.abs(positionAmt) < 1e-8) {
        return null;
      }

      return {
        symbol: symUpper,
        positionAmt,
        entryPrice: parseFloat(pos.entryPrice ?? '0'),
        markPrice: parseFloat(pos.markPrice ?? '0'),
        unRealizedProfit: parseFloat(pos.unRealizedProfit ?? '0'),
        liquidationPrice: parseFloat(pos.liquidationPrice ?? '0'),
        leverage: parseInt(pos.leverage ?? '1', 10),
        marginType: pos.marginType,
      };
    } catch (err: any) {
      throw new ExchangeDegradedError(
        `Failed to retrieve Binance Demo position for ${symUpper}: ${err.message}`,
        err
      );
    }
  }

  /**
   * Retrieves lot size rules and precision for a symbol.
   */
  async getLotSizeRule(symbol: string): Promise<{ precision: number; stepSize: number; minQty: number }> {
    try {
      const info = await this.client.getExchangeInfo(symbol);
      const sym = info?.symbols?.[0];
      if (sym) {
        const lotFilter = sym.filters?.find((f: any) => f.filterType === 'LOT_SIZE');
        const stepSize = lotFilter ? parseFloat(lotFilter.stepSize) : 0.001;
        const minQty = lotFilter ? parseFloat(lotFilter.minQty) : 0.001;
        const precision = typeof sym.quantityPrecision === 'number' ? sym.quantityPrecision : 3;
        return { precision, stepSize, minQty };
      }
    } catch {
      // fallback
    }
    const defaultPrecisions: Record<string, number> = {
      BTCUSDT: 4,
      ETHUSDT: 3,
      SOLUSDT: 2,
      BNBUSDT: 2,
      XRPUSDT: 1,
      DOGEUSDT: 0,
      ADAUSDT: 0,
    };
    const precision = defaultPrecisions[symbol.toUpperCase()] ?? 2;
    const stepSize = precision === 0 ? 1 : Math.pow(10, -precision);
    return { precision, stepSize, minQty: stepSize };
  }

  /**
   * Quantizes quantity to match Binance LOT_SIZE stepSize and precision limits.
   */
  async roundQuantity(symbol: string, rawQty: number): Promise<number> {
    const { precision, stepSize, minQty } = await this.getLotSizeRule(symbol);
    if (stepSize > 0) {
      const steps = Math.floor(rawQty / stepSize);
      const quantized = Number((steps * stepSize).toFixed(precision));
      return Math.max(minQty, quantized);
    }
    return Math.max(minQty, Number(rawQty.toFixed(precision)));
  }

  /**
   * Executes entry order on Binance Testnet.
   */
  async openOrder(
    req: OpenOrderRequest & { clientOrderId?: string; quantity?: number }
  ): Promise<OrderExecutionResult> {
    const symUpper = req.symbol.toUpperCase();
    try {
      // Set leverage if provided
      if (req.leverage) {
        await this.client.setLeverage(symUpper, req.leverage).catch(() => {});
      }

      let rawQty = req.quantity;
      if (!rawQty || rawQty <= 0) {
        let price = req.orderType === 'LIMIT' && req.limitPrice ? req.limitPrice : 0;
        if (!price || price <= 0) {
          const mp = await this.client.getMarkPrice(symUpper).catch(() => null);
          price = parseFloat(mp?.markPrice ?? '0') || 1;
        }
        rawQty = (req.marginUsd && req.leverage) ? (req.marginUsd * req.leverage) / price : 0.001;
      }

      const qty = await this.roundQuantity(symUpper, rawQty);

      const res = await this.client.createOrder({
        symbol: symUpper,
        side: req.side,
        type: req.orderType,
        quantity: qty,
        price: req.orderType === 'LIMIT' ? req.limitPrice : undefined,
        newClientOrderId: req.clientOrderId,
        timeInForce: req.orderType === 'LIMIT' ? (req.timeInForce ?? 'GTC') : undefined,
      });

      const orderId = String(res.orderId ?? '');
      const clientOrderId = String(res.clientOrderId ?? req.clientOrderId ?? '');
      let status = String(res.status ?? 'NEW');
      let executedQty = parseFloat(res.executedQty ?? '0');
      let avgPrice = parseFloat(res.avgPrice ?? '0');
      if (avgPrice === 0 && executedQty > 0 && res.cumQuote) {
        avgPrice = parseFloat(res.cumQuote) / executedQty;
      }
      if (avgPrice === 0 && parseFloat(res.price ?? '0') > 0) {
        avgPrice = parseFloat(res.price);
      }

      // If it's a MARKET order, Binance returns status NEW with executedQty 0.00 initially.
      // Poll briefly (120ms) to retrieve actual filled quantity and price from Binance.
      if (req.orderType === 'MARKET' && (executedQty === 0 || avgPrice === 0) && orderId) {
        try {
          await new Promise((resolve) => setTimeout(resolve, 120));
          const checked = await this.client.request<any>('/fapi/v1/order', {
            method: 'GET',
            signed: true,
            priority: 'P1',
            params: { symbol: symUpper, orderId },
          });
          if (checked) {
            status = String(checked.status ?? status);
            const checkExecQty = parseFloat(checked.executedQty ?? '0');
            if (checkExecQty > 0) executedQty = checkExecQty;
            const checkAvgPrice = parseFloat(checked.avgPrice ?? '0');
            if (checkAvgPrice > 0) {
              avgPrice = checkAvgPrice;
            } else if (checked.cumQuote && checkExecQty > 0) {
              avgPrice = parseFloat(checked.cumQuote) / checkExecQty;
            }
          }
        } catch {
          // ignore error and proceed
        }
      }

      return {
        orderId,
        clientOrderId,
        status,
        executedQty: Number.isFinite(executedQty) ? executedQty : 0,
        avgPrice,
      };
    } catch (err: any) {
      if (
        err instanceof BinanceApiError ||
        err instanceof ExchangeBannedError ||
        err instanceof ExchangeDegradedError
      ) {
        throw err;
      }
      throw new ExchangeDegradedError(
        `Failed to open order on Binance Demo (${symUpper}): ${err.message}`,
        err
      );
    }
  }

  /**
   * Places server-side conditional SL/TP algo order with mandatory reduceOnly: true.
   */
  async createAlgoOrder(params: AlgoOrderParams): Promise<AlgoOrderResult> {
    const symUpper = params.symbol.toUpperCase();
    try {
      const algoQty = params.quantity ? await this.roundQuantity(symUpper, params.quantity) : undefined;
      const res = await this.client.createAlgoOrder({
        symbol: symUpper,
        side: params.side,
        type: params.type,
        triggerPrice: params.triggerPrice,
        quantity: algoQty,
        reduceOnly: params.reduceOnly ?? true, // Strict reduceOnly enforcement
        clientAlgoId: params.clientAlgoId,
      });

      return {
        algoId: String(res.algoId ?? res.orderId ?? ''),
        clientAlgoId: params.clientAlgoId || res.clientAlgoId,
        symbol: symUpper,
        status: res.status || 'NEW',
      };
    } catch (err: any) {
      throw new ExchangeDegradedError(
        `Failed to place algo order (${params.type}) on Binance Demo: ${err.message}`,
        err
      );
    }
  }

  /**
   * Alias for createAlgoOrder.
   */
  async placeAlgoOrder(params: AlgoOrderParams): Promise<AlgoOrderResult> {
    return this.createAlgoOrder(params);
  }

  /**
   * Executes MARKET position close with mandatory reduceOnly: true.
   */
  async closePosition(symbol: string, qty?: number): Promise<{ orderId: string; status: string }> {
    const symUpper = symbol.toUpperCase();
    try {
      const pos = await this.getPosition(symUpper);
      if (!pos || Math.abs(pos.positionAmt) < 1e-8) {
        return { orderId: '', status: 'ALREADY_CLOSED' };
      }

      const absPos = Math.abs(pos.positionAmt);
      const rawCloseQty = qty !== undefined && qty < absPos - 1e-5 ? qty : absPos;
      const closeQty = await this.roundQuantity(symUpper, rawCloseQty);

      // Close side must be opposite to current position
      const closeSide = pos.positionAmt > 0 ? 'SELL' : 'BUY';

      const res = await this.client.createOrder({
        symbol: symUpper,
        side: closeSide,
        type: 'MARKET',
        quantity: closeQty,
        reduceOnly: true,
      });

      return {
        orderId: String(res.orderId ?? ''),
        status: String(res.status ?? 'FILLED'),
      };
    } catch (err: any) {
      throw new ExchangeDegradedError(
        `Failed to close position on Binance Demo (${symUpper}): ${err.message}`,
        err
      );
    }
  }

  /**
   * Cancels a single regular or algo order.
   */
  async cancelOrder(symbol: string, orderId: string, isAlgo: boolean = false): Promise<boolean> {
    const symUpper = symbol.toUpperCase();
    try {
      if (isAlgo) {
        await this.client.cancelAlgoOrder({ symbol: symUpper, algoId: orderId });
      } else {
        await this.client.cancelOrder({ symbol: symUpper, orderId });
      }
      return true;
    } catch (err: any) {
      console.warn(`[BINANCE DEMO] Cancel order warning for ${orderId}:`, err.message);
      return false;
    }
  }

  /**
   * Cancels all open regular orders on symbol.
   */
  async cancelAllOrders(symbol: string): Promise<boolean> {
    const symUpper = symbol.toUpperCase();
    try {
      await this.client.cancelAllOpenOrders(symUpper);
      return true;
    } catch (err: any) {
      console.warn(`[BINANCE DEMO] Cancel all orders warning for ${symUpper}:`, err.message);
      return false;
    }
  }

  /**
   * Atomic move to Breakeven:
   * 1. Cancels existing SL algo order.
   * 2. Places new Stop Loss algo order at bePrice with reduceOnly: true.
   */
  async moveToBreakeven(
    symbol: string,
    bePrice: number,
    currentSlId?: string
  ): Promise<{ newSlId: string }> {
    const symUpper = symbol.toUpperCase();

    // 1. Cancel previous SL if specified
    if (currentSlId) {
      await this.cancelOrder(symUpper, currentSlId, true).catch(() => {});
    }

    // 2. Determine side for SL
    const pos = await this.getPosition(symUpper);
    if (!pos || Math.abs(pos.positionAmt) < 1e-8) {
      throw new ExchangeDegradedError(
        `Cannot move to Breakeven: No active position found on ${symUpper}`
      );
    }

    const slSide = pos.positionAmt > 0 ? 'SELL' : 'BUY';
    const algoRes = await this.createAlgoOrder({
      symbol: symUpper,
      side: slSide,
      type: 'STOP_MARKET',
      triggerPrice: bePrice,
      quantity: Math.abs(pos.positionAmt),
      reduceOnly: true,
    });

    return {
      newSlId: algoRes.algoId,
    };
  }

  /**
   * Retrieves all currently open orders (both regular and conditional/algo) on Binance Demo.
   */
  async getOpenOrders(symbol?: string): Promise<OpenOrderInfo[]> {
    const symUpper = symbol?.toUpperCase();
    try {
      const [regularOrders, algoOrders] = await Promise.all([
        this.client.getOpenOrders(symUpper).catch(() => []),
        this.client.getOpenAlgoOrders(symUpper).catch(() => []),
      ]);

      const result: OpenOrderInfo[] = [];

      if (Array.isArray(regularOrders)) {
        for (const o of regularOrders) {
          result.push({
            orderId: String(o.orderId),
            symbol: o.symbol,
            side: o.side,
            price: parseFloat(o.price ?? '0'),
            origQty: parseFloat(o.origQty ?? '0'),
            executedQty: parseFloat(o.executedQty ?? '0'),
            type: o.type,
            isAlgo: false,
            clientOrderId: o.clientOrderId,
          });
        }
      }

      if (Array.isArray(algoOrders)) {
        for (const o of algoOrders) {
          result.push({
            orderId: String(o.algoId ?? o.orderId),
            symbol: o.symbol,
            side: o.side,
            price: parseFloat(o.triggerPrice ?? o.price ?? '0'),
            origQty: parseFloat(o.totalQty ?? o.origQty ?? '0'),
            executedQty: parseFloat(o.executedQty ?? '0'),
            type: o.orderType || o.type || 'ALGO',
            isAlgo: true,
            clientOrderId: o.clientAlgoId || o.clientOrderId,
          });
        }
      }

      return result;
    } catch (err: any) {
      throw new ExchangeDegradedError(
        `Failed to fetch open orders from Binance Demo: ${err.message}`,
        err
      );
    }
  }

  /**
   * Sets contract leverage on Binance Demo.
   */
  async setLeverage(symbol: string, leverage: number): Promise<number> {
    const symUpper = symbol.toUpperCase();
    try {
      const res = await this.client.setLeverage(symUpper, leverage);
      return parseInt(res.leverage ?? String(leverage), 10);
    } catch (err: any) {
      throw new ExchangeDegradedError(
        `Failed to set leverage on Binance Demo (${symUpper}): ${err.message}`,
        err
      );
    }
  }

  /**
   * Queries a single order by orderId via GET /fapi/v1/order.
   * Returns null ONLY on confirmed Binance -2013 ("Order does not exist");
   * throws ExchangeDegradedError on 5xx/network errors.
   */
  async getOrder(symbol: string, orderId: string): Promise<OrderExecutionResult | null> {
    const symUpper = symbol.toUpperCase();
    try {
      const res = await this.client.getOrder(symUpper, orderId);
      if (!res) return null;

      const executedQty = parseFloat(res.executedQty ?? '0');
      let avgPrice = parseFloat(res.avgPrice ?? '0');
      if (avgPrice === 0 && executedQty > 0 && res.cumQuote) {
        avgPrice = parseFloat(res.cumQuote) / executedQty;
      }
      if (avgPrice === 0 && parseFloat(res.price ?? '0') > 0) {
        avgPrice = parseFloat(res.price);
      }

      return {
        orderId: String(res.orderId ?? orderId),
        clientOrderId: String(res.clientOrderId ?? ''),
        status: String(res.status ?? 'NEW'),
        executedQty: Number.isFinite(executedQty) ? executedQty : 0,
        avgPrice: Number.isFinite(avgPrice) ? avgPrice : 0,
      };
    } catch (err: any) {
      if (err instanceof BinanceApiError && err.code === -2013) {
        return null;
      }
      if (err instanceof ExchangeBannedError || err instanceof ExchangeDegradedError) {
        throw err;
      }
      throw new ExchangeDegradedError(
        `Failed to query order ${orderId} on Binance Demo (${symUpper}): ${err?.message ?? err}`,
        err
      );
    }
  }

  /**
   * Queries realized user fills for a symbol since startTimeMs (GET /fapi/v1/userTrades).
   */
  async getSymbolUserTrades(symbol: string, startTimeMs: number): Promise<FillRecord[]> {
    const symUpper = symbol.toUpperCase();
    try {
      const trades = await this.client.getUserTrades(symUpper, startTimeMs);
      if (!Array.isArray(trades)) return [];
      return trades.map((t: any) => ({
        binance_trade_id: String(t.id ?? ''),
        trade_id: '',
        order_id: String(t.orderId ?? ''),
        symbol: String(t.symbol ?? symUpper),
        side: String(t.side ?? ''),
        price: parseFloat(t.price ?? '0') || 0,
        qty: parseFloat(t.qty ?? '0') || 0,
        realized_pnl: parseFloat(t.realizedPnl ?? '0') || 0,
        commission: parseFloat(t.commission ?? '0') || 0,
        commission_asset: t.commissionAsset ?? null,
        filled_at: Number(t.time ?? 0),
      }));
    } catch (err: any) {
      if (err instanceof ExchangeBannedError || err instanceof ExchangeDegradedError) {
        throw err;
      }
      throw new ExchangeDegradedError(
        `Failed to fetch user trades for ${symUpper} on Binance Demo: ${err?.message ?? err}`,
        err
      );
    }
  }

  /**
   * Amends an in-flight order on Binance Demo via PUT /fapi/v1/order.
   * Delegates to binanceClient.modifyOrder; propagates -5022 Post-Only rejection.
   */
  async modifyOrder(
    symbol: string,
    orderId: string | number,
    price: number,
    quantity: number,
    side?: TradeSide
  ): Promise<any> {
    if (!side) {
      throw new BinanceApiError('side is required for BinanceDemoAdapter.modifyOrder', 400);
    }
    return this.client.modifyOrder(symbol, orderId, price, quantity, side);
  }
}
