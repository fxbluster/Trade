import type { DatabaseSync } from 'node:sqlite';
import crypto from 'node:crypto';
import type {
  BrokerMode,
  AccountInfo,
  OpenOrderRequest,
  OpenOrderInfo,
} from '@tradeos/shared';
import { SettingsRepo } from '../db/sqlite.js';
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
  isAlgo: boolean;
  reduceOnly: boolean;
}

/**
 * Isolated Paper Trading Broker Adapter.
 * Applies 3bps slippage (0.0003) and 0.05% fee (0.0005) on all executions,
 * persists balance in SQLite settings table (key: 'paper_wallet_balance'),
 * and listens to live Mainnet mark prices to evaluate SL/TP execution.
 */
export class LocalPaperAdapter implements BrokerAdapter {
  public readonly mode: BrokerMode = 'LOCAL_PAPER';
  public readonly SLIPPAGE_BPS = 0.0003; // 3 basis points (0.03%)
  public readonly FEE_RATE = 0.0005;     // 0.05% taker fee

  private settingsRepo: SettingsRepo;
  private defaultBalance: number;

  private positions: Map<string, PaperPosition> = new Map();
  private openOrders: Map<string, PaperOrder> = new Map();
  private markPrices: Map<string, number> = new Map();

  constructor(options: LocalPaperAdapterOptions) {
    this.settingsRepo = new SettingsRepo(options.db);
    this.defaultBalance = options.initialBalance ?? 10000.0;
    this.ensureInitialized();
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
   * Attaches live mark price tick from Mainnet streams to evaluate paper SL/TP orders.
   */
  onMarkPriceTick(symbol: string, price: number): void {
    const symUpper = symbol.toUpperCase();
    this.markPrices.set(symUpper, price);

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
        this.closePosition(symUpper, order.quantity).catch((err) => {
          console.error(`[PAPER] Failed to trigger paper algo close on ${symUpper}:`, err);
        });
        break;
      }
    }
  }

  async getAccount(): Promise<AccountInfo> {
    const { balance, currency } = this.getBalanceRecord();

    let totalUnrealizedPnl = 0;
    for (const [sym, pos] of this.positions.entries()) {
      const currentPrice = this.markPrices.get(sym) || pos.entryPrice;
      const pnl =
        pos.side === 'BUY'
          ? (currentPrice - pos.entryPrice) * pos.quantity
          : (pos.entryPrice - currentPrice) * pos.quantity;
      totalUnrealizedPnl += pnl;
    }

    const equity = balance + totalUnrealizedPnl;
    return {
      walletBalance: balance,
      equity: Number(equity.toFixed(4)),
      availableBalance: balance,
      unrealizedPnl: Number(totalUnrealizedPnl.toFixed(4)),
      currency,
    };
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

    // Record position
    this.positions.set(symUpper, {
      symbol: symUpper,
      side: req.side,
      entryPrice: execPrice,
      quantity: qty,
      leverage: req.leverage,
      marginUsd: req.marginUsd,
      openedAt: Date.now(),
    });

    const orderId = `paper_order_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
    const clientOrderId = req.clientOrderId || `tos_paper_${orderId}`;

    return {
      orderId,
      clientOrderId,
      status: 'FILLED',
      executedQty: qty,
      avgPrice: execPrice,
    };
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

  async closePosition(symbol: string, qty?: number): Promise<{ orderId: string; status: string }> {
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

    const orderId = `paper_close_${Date.now()}`;
    return { orderId, status: 'FILLED' };
  }

  async cancelOrder(symbol: string, orderId: string, _isAlgo?: boolean): Promise<boolean> {
    return this.openOrders.delete(orderId);
  }

  async cancelAllOrders(symbol: string): Promise<boolean> {
    const symUpper = symbol.toUpperCase();
    for (const [id, ord] of this.openOrders.entries()) {
      if (ord.symbol === symUpper) {
        this.openOrders.delete(id);
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

  async setLeverage(symbol: string, leverage: number): Promise<number> {
    const symUpper = symbol.toUpperCase();
    const pos = this.positions.get(symUpper);
    if (pos) {
      pos.leverage = leverage;
    }
    return leverage;
  }
}
