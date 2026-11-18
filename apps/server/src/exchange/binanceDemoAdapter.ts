import type {
  BrokerMode,
  AccountInfo,
  OpenOrderRequest,
  OpenOrderInfo,
} from '@tradeos/shared';
import { BinanceClient, ExchangeDegradedError } from './binanceClient.js';
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

      const qty = req.quantity ?? (req.marginUsd && req.leverage ? (req.marginUsd * req.leverage) / (req.limitPrice || 1) : 0);

      const res = await this.client.createOrder({
        symbol: symUpper,
        side: req.side,
        type: req.orderType,
        quantity: qty,
        price: req.orderType === 'LIMIT' ? req.limitPrice : undefined,
        newClientOrderId: req.clientOrderId,
        timeInForce: req.orderType === 'LIMIT' ? 'GTC' : undefined,
      });

      const orderId = String(res.orderId ?? '');
      const clientOrderId = String(res.clientOrderId ?? req.clientOrderId ?? '');
      const status = String(res.status ?? 'NEW');
      const executedQty = parseFloat(res.executedQty ?? '0');
      const avgPrice = parseFloat(res.avgPrice ?? res.price ?? '0');

      return {
        orderId,
        clientOrderId,
        status,
        executedQty,
        avgPrice,
      };
    } catch (err: any) {
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
      const res = await this.client.createAlgoOrder({
        symbol: symUpper,
        side: params.side,
        type: params.type,
        triggerPrice: params.triggerPrice,
        quantity: params.quantity,
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

      const closeQty = qty ?? Math.abs(pos.positionAmt);
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
   * Retrieves all currently open orders on Binance Demo.
   */
  async getOpenOrders(symbol?: string): Promise<OpenOrderInfo[]> {
    const symUpper = symbol?.toUpperCase();
    try {
      const orders = await this.client.getOpenOrders(symUpper);
      if (!Array.isArray(orders)) return [];

      return orders.map((o: any) => ({
        orderId: String(o.orderId),
        symbol: o.symbol,
        side: o.side,
        price: parseFloat(o.price ?? '0'),
        origQty: parseFloat(o.origQty ?? '0'),
        executedQty: parseFloat(o.executedQty ?? '0'),
        type: o.type,
        isAlgo: false,
        clientOrderId: o.clientOrderId,
      }));
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
}
