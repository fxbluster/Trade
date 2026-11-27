import type { DatabaseSync } from 'node:sqlite';
import crypto from 'node:crypto';
import type {
  BrokerMode,
  AccountInfo,
  OpenOrderRequest,
  OpenOrderInfo,
  TradeSide,
  FillRecord,
} from '@tradeos/shared';
import { SettingsRepo } from '../db/sqlite.js';
import { BinanceApiError } from './binanceClient.js';
import type {
  BrokerAdapter,
  PositionInfo,
  OrderExecutionResult,
  AlgoOrderParams,
  AlgoOrderResult,
} from './broker.js';

export interface LocalPaperAdapterOptions {
  db: DatabaseSync;
  initialBalance?: number;
}

export interface PaperAlgoTriggerEvent {
  symbol: string;
  algoId: string;
  clientAlgoId?: string;
  side: 'BUY' | 'SELL';
  orderType: string;
  triggerPrice: number;
  fillPrice: number;
  executedQty: number;
}

interface PaperPosition {
  symbol: string;
  side: 'BUY' | 'SELL';
  entryPrice: number;
  quantity: number;
  leverage: number;
  marginUsd: number;
  openedAt: number;
}

interface PaperOrder {
  orderId: string;
  clientOrderId?: string;
  symbol: string;
  side: 'BUY' | 'SELL';
  type: string;
  price?: number;
  triggerPrice?: number;
  quantity: number;
  leverage?: number;
  marginUsd?: number;
  timeInForce?: string;
  isAlgo: boolean;
  reduceOnly: boolean;
}

/**
 * Isolated Paper Trading Broker Adapter.
 * Applies 3bps slippage (0.0003) and 0.05% fee (0.0005) on all executions,
 * persists balance in SQLite settings table (key: 'paper_wallet_balance'),
 * and listens to live Mainnet mark prices to evaluate SL/TP and resting LIMIT execution.
 */
export class LocalPaperAdapter implements BrokerAdapter {
  public readonly mode: BrokerMode = 'LOCAL_PAPER';
  public readonly SLIPPAGE_BPS = 0.0003; // 3 basis points (0.03%)
  public readonly FEE_RATE = 0.0005;     // 0.05% taker fee
  public readonly MAKER_FEE_RATE = 0.0002; // 0.02% maker fee

  private settingsRepo: SettingsRepo;
  private defaultBalance: number;
  private onAlgoTrigger?: (event: PaperAlgoTriggerEvent) => void | Promise<void>;

  private positions: Map<string, PaperPosition> = new Map();
  private openOrders: Map<string, PaperOrder> = new Map();
  private ordersById: Map<string, OrderExecutionResult> = new Map();
  private userTrades: FillRecord[] = [];
  private markPrices: Map<string, number> = new Map();

  constructor(options: LocalPaperAdapterOptions) {
    this.settingsRepo = new SettingsRepo(options.db);
    this.defaultBalance = options.initialBalance ?? 5000.0;
    this.ensureInitialized();
    this.rehydrateFromDb(options.db);
  }

  /**
   * Restores any open/partially-closed LOCAL_PAPER trades and their SL/TP algo orders
   * from SQLite after a server restart so live PnL, availableBalance, and SL/TP triggers stay intact.
   */
  private rehydrateFromDb(db: DatabaseSync): void {
    try {
      const rows = db
        .prepare(
          `SELECT * FROM trades WHERE broker_mode = 'LOCAL_PAPER' AND status IN ('OPEN', 'PARTIALLY_CLOSED')`
        )
        .all() as Array<any>;
      for (const t of rows) {
        const sym = String(t.symbol).toUpperCase();
        const remQty = Number(t.remaining_qty || t.quantity || 0);
        if (remQty <= 0) continue;
        this.positions.set(sym, {
          symbol: sym,
          side: t.side === 'SELL' ? 'SELL' : 'BUY',
          entryPrice: Number(t.entry_price),
          quantity: remQty,
          leverage: Number(t.leverage || 10),
          marginUsd: Number(t.margin_usd || 0),
          openedAt: Number(t.opened_at || Date.now()),
        });
        const oppSide: 'BUY' | 'SELL' = t.side === 'BUY' ? 'SELL' : 'BUY';
        if (t.sl_algo_id && t.stop_loss > 0) {
          this.openOrders.set(String(t.sl_algo_id), {
            orderId: String(t.sl_algo_id),
            clientOrderId: t.client_sl_id || undefined,
            symbol: sym,
            side: oppSide,
            type: 'STOP_MARKET',
            triggerPrice: Number(t.stop_loss),
            quantity: remQty,
            isAlgo: true,
            reduceOnly: true,
          });
        }
        if (t.tp1_algo_id && t.tp1 > 0 && t.status === 'OPEN') {
          this.openOrders.set(String(t.tp1_algo_id), {
            orderId: String(t.tp1_algo_id),
            clientOrderId: t.client_tp1_id || undefined,
            symbol: sym,
            side: oppSide,
            type: 'TAKE_PROFIT_MARKET',
            triggerPrice: Number(t.tp1),
            quantity: Number((remQty * 0.5).toFixed(4)),
            isAlgo: true,
            reduceOnly: true,
          });
        }
        if (t.tp2_algo_id && t.tp2 > 0) {
          this.openOrders.set(String(t.tp2_algo_id), {
            orderId: String(t.tp2_algo_id),
            clientOrderId: t.client_tp2_id || undefined,
            symbol: sym,
            side: oppSide,
            type: 'TAKE_PROFIT_MARKET',
            triggerPrice: Number(t.tp2),
            quantity: t.status === 'OPEN' ? Number((remQty * 0.5).toFixed(4)) : remQty,
            isAlgo: true,
            reduceOnly: true,
          });
        }
      }
    } catch {
      // Tolerate minimal test DBs without trades table
    }
  }

  public setOnAlgoTrigger(
    cb: ((event: PaperAlgoTriggerEvent) => void | Promise<void>) | undefined
  ): void {
    this.onAlgoTrigger = cb;
  }

  private ensureInitialized(): void {
    const existing = this.settingsRepo.get<{ balance: number; currency: string }>(
      'paper_wallet_balance'
    );
    if (!existing || typeof existing.balance !== 'number') {
      this.settingsRepo.set('paper_wallet_balance', {
        balance: this.defaultBalance,
        currency: 'USDT',
      });
    }
  }

  /**
   * Reads persisted paper balance from SQLite settings.
   */
  private getBalanceRecord(): { balance: number; currency: string } {
    const existing = this.settingsRepo.get<{ balance: number; currency: string }>(
      'paper_wallet_balance'
    );
    if (existing && typeof existing.balance === 'number') {
      return existing;
    }
    const def = { balance: this.defaultBalance, currency: 'USDT' };
    this.settingsRepo.set('paper_wallet_balance', def);
    return def;
  }

  /**
   * Updates persisted paper balance in SQLite settings.
   */
  private updateBalance(newBalance: number): void {
    this.settingsRepo.set('paper_wallet_balance', {
      balance: Math.max(0, Number(newBalance.toFixed(4))),
      currency: 'USDT',
    });
  }

  /**
   * Attaches live mark price tick from Mainnet streams to evaluate paper LIMIT & SL/TP orders.
   */
  onMarkPriceTick(symbol: string, price: number): void {
    const symUpper = symbol.toUpperCase();
    this.markPrices.set(symUpper, price);

    // Check resting LIMIT orders for fills
    for (const [orderId, ord] of this.openOrders.entries()) {
      if (ord.symbol !== symUpper || ord.isAlgo || ord.type !== 'LIMIT' || ord.price === undefined) {
        continue;
      }
      const crossed =
        (ord.side === 'BUY' && price <= ord.price) ||
        (ord.side === 'SELL' && price >= ord.price);
      if (crossed) {
        this.openOrders.delete(orderId);
        const execPrice = ord.price;
        const fee = execPrice * ord.quantity * this.MAKER_FEE_RATE;
        const { balance } = this.getBalanceRecord();
        this.updateBalance(balance - fee);

        const lev = ord.leverage ?? 10;
        const margin = ord.marginUsd ?? (execPrice * ord.quantity) / lev;
        this.positions.set(symUpper, {
          symbol: symUpper,
          side: ord.side,
          entryPrice: execPrice,
          quantity: ord.quantity,
          leverage: lev,
          marginUsd: margin,
          openedAt: Date.now(),
        });

        this.ordersById.set(orderId, {
          orderId,
          clientOrderId: ord.clientOrderId || '',
          status: 'FILLED',
          executedQty: ord.quantity,
          avgPrice: execPrice,
        });

        this.userTrades.push({
          binance_trade_id: `paper_fill_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`,
          trade_id: '',
          order_id: orderId,
          symbol: symUpper,
          side: ord.side,
          price: execPrice,
          qty: ord.quantity,
          realized_pnl: 0,
          commission: fee,
          commission_asset: 'USDT',
          filled_at: Date.now(),
        });
      }
    }

    const pos = this.positions.get(symUpper);
    if (!pos) return;

    // Check open algo orders for SL / TP breaches
    for (const [orderId, order] of this.openOrders.entries()) {
      if (order.symbol !== symUpper || !order.isAlgo || !order.triggerPrice) continue;

      let triggered = false;
      if (pos.side === 'BUY') {
        // Long position
        if (order.type === 'STOP_MARKET' && price <= order.triggerPrice) {
          triggered = true;
        } else if (order.type === 'TAKE_PROFIT_MARKET' && price >= order.triggerPrice) {
          triggered = true;
        }
      } else {
        // Short position
        if (order.type === 'STOP_MARKET' && price >= order.triggerPrice) {
          triggered = true;
        } else if (order.type === 'TAKE_PROFIT_MARKET' && price <= order.triggerPrice) {
          triggered = true;
        }
      }

      if (triggered) {
        this.openOrders.delete(orderId);
        const slippageMultiplier =
          pos.side === 'BUY' ? 1 - this.SLIPPAGE_BPS : 1 + this.SLIPPAGE_BPS;
        const fillPrice = Number((price * slippageMultiplier).toFixed(4));
        const execQty =
          order.quantity > 0 ? Math.min(order.quantity, pos.quantity) : pos.quantity;
        const triggerEvent: PaperAlgoTriggerEvent = {
          symbol: symUpper,
          algoId: orderId,
          clientAlgoId: order.clientOrderId,
          side: order.side,
          orderType: order.type,
          triggerPrice: order.triggerPrice,
          fillPrice,
          executedQty: execQty,
        };
        this.closePosition(symUpper, order.quantity)
          .then((closeRes) => {
            if (closeRes.avgPrice && closeRes.avgPrice > 0) {
              triggerEvent.fillPrice = closeRes.avgPrice;
            }
            if (closeRes.executedQty && closeRes.executedQty > 0) {
              triggerEvent.executedQty = closeRes.executedQty;
            }
            if (this.onAlgoTrigger) {
              void Promise.resolve(this.onAlgoTrigger(triggerEvent)).catch((err) => {
                console.error(`[PAPER] onAlgoTrigger callback failed on ${symUpper}:`, err);
              });
            }
          })
          .catch((err) => {
            console.error(`[PAPER] Failed to trigger paper algo close on ${symUpper}:`, err);
          });
        break;
      }
    }
  }

  async getAccount(): Promise<AccountInfo> {
    const { balance, currency } = this.getBalanceRecord();

    let totalUnrealizedPnl = 0;
    let totalUsedMargin = 0;
    for (const [sym, pos] of this.positions.entries()) {
      const currentPrice = this.markPrices.get(sym) || pos.entryPrice;
      const pnl =
        pos.side === 'BUY'
          ? (currentPrice - pos.entryPrice) * pos.quantity
          : (pos.entryPrice - currentPrice) * pos.quantity;
      totalUnrealizedPnl += pnl;
      totalUsedMargin += pos.marginUsd || 0;
    }

    const equity = balance + totalUnrealizedPnl;
    const availableBalance = Math.max(0, equity - totalUsedMargin);
    return {
      walletBalance: balance,
      equity: Number(equity.toFixed(4)),
      availableBalance: Number(availableBalance.toFixed(4)),
      unrealizedPnl: Number(totalUnrealizedPnl.toFixed(4)),
      currency,
    };
  }

  async getAllPositions(): Promise<PositionInfo[]> {
    const result: PositionInfo[] = [];
    for (const sym of this.positions.keys()) {
      const pos = await this.getPosition(sym);
      if (pos) result.push(pos);
    }
    return result;
  }

  async getPosition(symbol: string): Promise<PositionInfo | null> {
    const symUpper = symbol.toUpperCase();
    const pos = this.positions.get(symUpper);
    if (!pos || pos.quantity <= 0) return null;

    const currentPrice = this.markPrices.get(symUpper) || pos.entryPrice;
    const positionAmt = pos.side === 'BUY' ? pos.quantity : -pos.quantity;
    const unRealizedProfit =
      pos.side === 'BUY'
        ? (currentPrice - pos.entryPrice) * pos.quantity
        : (pos.entryPrice - currentPrice) * pos.quantity;

    // Approximate liquidation price
    const liqDistance = (pos.entryPrice / pos.leverage) * 0.9;
    const liquidationPrice =
      pos.side === 'BUY'
        ? Math.max(0, pos.entryPrice - liqDistance)
        : pos.entryPrice + liqDistance;

    return {
      symbol: symUpper,
      positionAmt,
      entryPrice: pos.entryPrice,
      markPrice: currentPrice,
      unRealizedProfit: Number(unRealizedProfit.toFixed(4)),
      liquidationPrice: Number(liquidationPrice.toFixed(2)),
      leverage: pos.leverage,
      marginType: 'cross',
    };
  }

  async openOrder(
    req: OpenOrderRequest & { clientOrderId?: string; quantity?: number; currentPrice?: number }
  ): Promise<OrderExecutionResult> {
    const symUpper = req.symbol.toUpperCase();
    const knownMark = req.currentPrice ?? this.markPrices.get(symUpper);
    const tif = req.timeInForce ?? 'GTC';

    const orderId = `paper_order_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
    const clientOrderId = req.clientOrderId || `tos_paper_${orderId}`;

    if (req.orderType === 'LIMIT') {
      const limitPrice = req.limitPrice ?? knownMark ?? 100.0;

      if (tif === 'GTX' && knownMark !== undefined) {
        const crosses =
          req.side === 'BUY' ? limitPrice >= knownMark : limitPrice <= knownMark;
        if (crosses) {
          throw new BinanceApiError(
            'Post Only order would immediately match and take.',
            400,
            -5022
          );
        }
      }

      const isNonCrossing =
        knownMark !== undefined &&
        ((req.side === 'BUY' && limitPrice < knownMark) ||
          (req.side === 'SELL' && limitPrice > knownMark));

      if (isNonCrossing || (tif === 'GTX' && knownMark === undefined)) {
        const qty =
          req.quantity ??
          (req.marginUsd && req.leverage
            ? Number(((req.marginUsd * req.leverage) / limitPrice).toFixed(4))
            : 1);

        this.openOrders.set(orderId, {
          orderId,
          clientOrderId,
          symbol: symUpper,
          side: req.side,
          type: 'LIMIT',
          price: limitPrice,
          quantity: qty,
          leverage: req.leverage,
          marginUsd: req.marginUsd,
          timeInForce: tif,
          isAlgo: false,
          reduceOnly: false,
        });

        const restingResult: OrderExecutionResult = {
          orderId,
          clientOrderId,
          status: 'NEW',
          executedQty: 0,
          avgPrice: 0,
        };
        this.ordersById.set(orderId, restingResult);
        return restingResult;
      }
    }

    const rawPrice =
      req.limitPrice || req.currentPrice || this.markPrices.get(symUpper) || 100.0;

    // Apply 3bps slippage: BUY pays +3bps, SELL receives -3bps
    const slippageMultiplier =
      req.side === 'BUY' ? 1 + this.SLIPPAGE_BPS : 1 - this.SLIPPAGE_BPS;
    const execPrice = Number((rawPrice * slippageMultiplier).toFixed(4));

    const qty =
      req.quantity ??
      (req.marginUsd && req.leverage
        ? Number(((req.marginUsd * req.leverage) / execPrice).toFixed(4))
        : 1);

    // 0.05% execution fee
    const fee = execPrice * qty * this.FEE_RATE;

    // Deduct entry fee from paper wallet balance in SQLite
    const { balance } = this.getBalanceRecord();
    this.updateBalance(balance - fee);

    const filledAt = Date.now();

    // Record position
    this.positions.set(symUpper, {
      symbol: symUpper,
      side: req.side,
      entryPrice: execPrice,
      quantity: qty,
      leverage: req.leverage,
      marginUsd: req.marginUsd,
      openedAt: filledAt,
    });

    const filledResult: OrderExecutionResult = {
      orderId,
      clientOrderId,
      status: 'FILLED',
      executedQty: qty,
      avgPrice: execPrice,
    };
    this.ordersById.set(orderId, filledResult);
    this.userTrades.push({
      binance_trade_id: `paper_fill_${filledAt}_${crypto.randomBytes(4).toString('hex')}`,
      trade_id: '',
      order_id: orderId,
      symbol: symUpper,
      side: req.side,
      price: execPrice,
      qty,
      realized_pnl: 0,
      commission: fee,
      commission_asset: 'USDT',
      filled_at: filledAt,
    });

    return filledResult;
  }

  async createAlgoOrder(params: AlgoOrderParams): Promise<AlgoOrderResult> {
    const symUpper = params.symbol.toUpperCase();
    const algoId = `paper_algo_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;

    this.openOrders.set(algoId, {
      orderId: algoId,
      clientOrderId: params.clientAlgoId,
      symbol: symUpper,
      side: params.side,
      type: params.type,
      triggerPrice: params.triggerPrice,
      quantity: params.quantity || 0,
      isAlgo: true,
      reduceOnly: params.reduceOnly ?? true,
    });

    return {
      algoId,
      clientAlgoId: params.clientAlgoId,
      symbol: symUpper,
      status: 'NEW',
    };
  }

  async placeAlgoOrder(params: AlgoOrderParams): Promise<AlgoOrderResult> {
    return this.createAlgoOrder(params);
  }

  async closePosition(
    symbol: string,
    qty?: number
  ): Promise<{ orderId: string; status: string; executedQty?: number; avgPrice?: number }> {
    const symUpper = symbol.toUpperCase();
    const pos = this.positions.get(symUpper);
    if (!pos || pos.quantity <= 0) {
      return { orderId: '', status: 'ALREADY_CLOSED' };
    }

    const closeQty = qty ? Math.min(qty, pos.quantity) : pos.quantity;
    const rawPrice = this.markPrices.get(symUpper) || pos.entryPrice;

    // Apply 3bps slippage: Closing BUY sells (-3bps), Closing SELL buys (+3bps)
    const slippageMultiplier =
      pos.side === 'BUY' ? 1 - this.SLIPPAGE_BPS : 1 + this.SLIPPAGE_BPS;
    const exitPrice = Number((rawPrice * slippageMultiplier).toFixed(4));

    // Calculate exit fee (0.05%)
    const exitFee = exitPrice * closeQty * this.FEE_RATE;

    // Calculate gross & net realized PnL
    const grossPnl =
      pos.side === 'BUY'
        ? (exitPrice - pos.entryPrice) * closeQty
        : (pos.entryPrice - exitPrice) * closeQty;
    const netPnl = grossPnl - exitFee;

    // Update paper wallet balance in SQLite
    const { balance } = this.getBalanceRecord();
    this.updateBalance(balance + netPnl);

    // Update remaining position
    if (closeQty >= pos.quantity) {
      this.positions.delete(symUpper);
      // Cancel associated pending algo orders
      for (const [id, ord] of this.openOrders.entries()) {
        if (ord.symbol === symUpper) {
          this.openOrders.delete(id);
        }
      }
    } else {
      pos.quantity -= closeQty;
    }

    const filledAt = Date.now();
    const orderId = `paper_close_${filledAt}`;
    this.userTrades.push({
      binance_trade_id: `paper_fill_${filledAt}_${crypto.randomBytes(4).toString('hex')}`,
      trade_id: '',
      order_id: orderId,
      symbol: symUpper,
      side: pos.side === 'BUY' ? 'SELL' : 'BUY',
      price: exitPrice,
      qty: closeQty,
      realized_pnl: Number(grossPnl.toFixed(4)),
      commission: Number(exitFee.toFixed(4)),
      commission_asset: 'USDT',
      filled_at: filledAt,
    });
    return {
      orderId,
      status: 'FILLED',
      executedQty: closeQty,
      avgPrice: exitPrice,
    };
  }

  async cancelOrder(_symbol: string, orderId: string, _isAlgo?: boolean): Promise<boolean> {
    const deleted = this.openOrders.delete(orderId);
    if (deleted) {
      const existing = this.ordersById.get(orderId);
      if (existing && existing.status === 'NEW') {
        this.ordersById.set(orderId, { ...existing, status: 'CANCELED' });
      }
    }
    return deleted;
  }

  async cancelAllOrders(symbol: string): Promise<boolean> {
    const symUpper = symbol.toUpperCase();
    for (const [id, ord] of this.openOrders.entries()) {
      if (ord.symbol === symUpper) {
        this.openOrders.delete(id);
        const existing = this.ordersById.get(id);
        if (existing && existing.status === 'NEW') {
          this.ordersById.set(id, { ...existing, status: 'CANCELED' });
        }
      }
    }
    return true;
  }

  async moveToBreakeven(
    symbol: string,
    bePrice: number,
    currentSlId?: string
  ): Promise<{ newSlId: string }> {
    const symUpper = symbol.toUpperCase();
    if (currentSlId) {
      this.openOrders.delete(currentSlId);
    }

    const pos = this.positions.get(symUpper);
    if (!pos) {
      throw new Error(`Cannot move to Breakeven: No paper position found for ${symUpper}`);
    }

    const slSide = pos.side === 'BUY' ? 'SELL' : 'BUY';
    const algoRes = await this.createAlgoOrder({
      symbol: symUpper,
      side: slSide,
      type: 'STOP_MARKET',
      triggerPrice: bePrice,
      quantity: pos.quantity,
      reduceOnly: true,
    });

    return { newSlId: algoRes.algoId };
  }

  async getOpenOrders(symbol?: string): Promise<OpenOrderInfo[]> {
    const symUpper = symbol?.toUpperCase();
    const result: OpenOrderInfo[] = [];

    for (const ord of this.openOrders.values()) {
      if (symUpper && ord.symbol !== symUpper) continue;
      result.push({
        orderId: ord.orderId,
        symbol: ord.symbol,
        side: ord.side,
        price: ord.price || ord.triggerPrice || 0,
        origQty: ord.quantity,
        executedQty: 0,
        type: ord.type,
        isAlgo: ord.isAlgo,
        clientOrderId: ord.clientOrderId,
      });
    }

    return result;
  }

  async getOrder(_symbol: string, orderId: string): Promise<OrderExecutionResult | null> {
    return this.ordersById.get(String(orderId)) ?? null;
  }

  async getSymbolUserTrades(symbol: string, startTimeMs: number): Promise<FillRecord[]> {
    const symUpper = symbol.toUpperCase();
    return this.userTrades.filter(
      (f) => f.symbol === symUpper && f.filled_at >= startTimeMs
    );
  }

  async setLeverage(symbol: string, leverage: number): Promise<number> {
    const symUpper = symbol.toUpperCase();
    const pos = this.positions.get(symUpper);
    if (pos) {
      pos.leverage = leverage;
    }
    return leverage;
  }

  /**
   * In-memory modifyOrder: updates the simulated open order's price and quantity.
   * Throws -5022 if order is Post-Only (GTX) and amended price crosses mark.
   */
  async modifyOrder(
    symbol: string,
    orderId: string | number,
    price: number,
    quantity: number,
    side?: TradeSide
  ): Promise<any> {
    const symUpper = symbol.toUpperCase();
    const orderIdStr = String(orderId);
    const ord = this.openOrders.get(orderIdStr);
    const mark = this.markPrices.get(symUpper);

    if (ord && ord.symbol === symUpper) {
      const effSide = side ?? ord.side;
      if (ord.timeInForce === 'GTX' && mark !== undefined) {
        const crosses = effSide === 'BUY' ? price >= mark : price <= mark;
        if (crosses) {
          throw new BinanceApiError(
            'Post Only order would immediately trigger as taker order.',
            400,
            -5022
          );
        }
      }
      ord.price = price;
      ord.quantity = quantity;
    }

    return {
      orderId: orderIdStr,
      symbol: symUpper,
      price,
      origQty: quantity,
      status: 'NEW',
    };
  }
}
