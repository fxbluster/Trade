import { describe, it, expect, beforeEach } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import { initializeDatabase, TradesRepo, SettingsRepo } from '../../db/sqlite.js';
import { TradeManager } from '../../services/tradeManager.js';
import { AutoPilotManager } from '../../services/autoPilotManager.js';
import { ConfluenceEngine } from '../confluenceEngine.js';
import type {
  BrokerAdapter,
  PositionInfo,
  OrderExecutionResult,
  AlgoOrderParams,
  AlgoOrderResult,
} from '../../exchange/broker.js';
import type {
  AccountInfo,
  OpenOrderInfo,
  BrokerMode,
  TradeRecord,
} from '@tradeos/shared';

class MockBroker implements BrokerAdapter {
  readonly mode: BrokerMode = 'BINANCE_DEMO';
  public account: AccountInfo = {
    walletBalance: 10000,
    equity: 10000,
    availableBalance: 10000,
    unrealizedPnl: 0,
    currency: 'USDT',
  };
  public position: PositionInfo | null = null;
  public openOrders: OpenOrderInfo[] = [];

  public openOrderCalls: any[] = [];
  public closePositionCalls: any[] = [];
  public cancelAllOrdersCalls: any[] = [];

  async getAccount(): Promise<AccountInfo> {
    return this.account;
  }

  async getPosition(symbol: string): Promise<PositionInfo | null> {
    return this.position;
  }

  async openOrder(req: any): Promise<OrderExecutionResult> {
    this.openOrderCalls.push(req);
    const executedQty = req.quantity || (req.marginUsd * req.leverage) / (req.limitPrice || 100);
    const avgPrice = req.limitPrice || 100;
    this.position = {
      symbol: req.symbol,
      positionAmt: req.side === 'BUY' ? executedQty : -executedQty,
      entryPrice: avgPrice,
      markPrice: avgPrice,
      unRealizedProfit: 0,
      liquidationPrice: 80,
      leverage: req.leverage,
    };
    return {
      orderId: 'ent_' + Math.random().toString(36).slice(2, 8),
      clientOrderId: req.clientOrderId || 'tos_ent',
      status: 'FILLED',
      executedQty,
      avgPrice,
    };
  }

  async createAlgoOrder(params: AlgoOrderParams): Promise<AlgoOrderResult> {
    return {
      algoId: 'algo_' + Math.random().toString(36).slice(2, 8),
      clientAlgoId: params.clientAlgoId,
      symbol: params.symbol,
      status: 'NEW',
    };
  }

  async closePosition(
    symbol: string,
    qty?: number
  ): Promise<{ orderId: string; status: string; avgPrice?: number }> {
    this.closePositionCalls.push({ symbol, qty });
    const p = this.position;
    this.position = null;
    return {
      orderId: 'close_999',
      status: 'FILLED',
      avgPrice: p?.markPrice || 100,
    };
  }

  async cancelOrder(symbol: string, orderId: string, isAlgo?: boolean): Promise<boolean> {
    return true;
  }

  async cancelAllOrders(symbol: string): Promise<boolean> {
    this.cancelAllOrdersCalls.push(symbol);
    return true;
  }

  async moveToBreakeven(
    symbol: string,
    bePrice: number,
    currentSlId?: string
  ): Promise<{ newSlId: string }> {
    return {
      newSlId: 'be_123',
    };
  }

  async getOpenOrders(symbol: string): Promise<OpenOrderInfo[]> {
    return this.openOrders;
  }
}

describe('Giveback-Half Trailing Stop Engine [CUJ 1]', () => {
  let db: DatabaseSync;
  let mockBroker: MockBroker;
  let tradesRepo: TradesRepo;
  let tradeManager: TradeManager;
  let confluenceEngine: ConfluenceEngine;
  let autoPilot: AutoPilotManager;
  let currentMarkPrice = 100;
  const currentAtr = 1.0; // ATR = 1.0 -> 2.0x ATR = 2.0

  beforeEach(() => {
    db = initializeDatabase(':memory:');
    tradesRepo = new TradesRepo(db);
    mockBroker = new MockBroker();
    tradeManager = new TradeManager({
      db,
      broker: mockBroker,
      brokerMode: 'BINANCE_DEMO',
      getMarkPrice: () => currentMarkPrice,
    });
    confluenceEngine = new ConfluenceEngine();

    autoPilot = new AutoPilotManager({
      db,
      tradeManager,
      broker: mockBroker,
      confluenceEngine,
      getMarkPrice: () => currentMarkPrice,
      getAtr: () => currentAtr,
      config: {
        enabled: true,
        oppositeExitEnabled: false, // Isolate trailing stop evaluation
      },
    });
  });

  it('Long position: activates at 2.0x ATR, survives < 50% pullback, and exits at exactly 50% MFE giveback', async () => {
    // 1. Manually insert an open Long trade in DB
    const tradeId = 'long_trailing_test';
    const entryPrice = 100.0;
    const initialTrade: TradeRecord = {
      id: tradeId,
      symbol: 'SOLUSDT',
      broker_mode: 'BINANCE_DEMO',
      side: 'BUY',
      status: 'OPEN',
      entry_price: entryPrice,
      exit_price: null,
      quantity: 10,
      remaining_qty: 10,
      leverage: 10,
      margin_usd: 100,
      stop_loss: 98.0,
      tp1: 102.0,
      tp2: 105.0,
      be_price: 100.25,
      is_breakeven: 0,
      peak_price: entryPrice,
      peak_mfe: 0,
      trailing_stop_active: 0,
      client_order_id: `tos_${tradeId}_ent`,
      client_sl_id: `tos_${tradeId}_sl`,
      client_tp1_id: `tos_${tradeId}_tp1`,
      client_tp2_id: `tos_${tradeId}_tp2`,
      entry_order_id: null,
      sl_algo_id: null,
      tp1_algo_id: null,
      tp2_algo_id: null,
      realized_pnl: 0,
      fees_usd: 0,
      exit_reason: null,
      opened_at: Date.now() - 60_000,
      closed_at: null,
    };
    tradesRepo.insert(initialTrade);

    // Initial tick at 100
    currentMarkPrice = 100.0;
    await autoPilot.onTick('SOLUSDT', currentMarkPrice);
    expect(autoPilot.getState()).toBe('POSITION_OPEN');

    // 2. Price expands to 101.50 (MFE = 1.50, which is < 2.0 * ATR = 2.00)
    currentMarkPrice = 101.50;
    await autoPilot.onTick('SOLUSDT', currentMarkPrice);
    let record = tradesRepo.getById(tradeId)!;
    expect(record.peak_price).toBe(101.50);
    expect(record.peak_mfe).toBe(1.50);
    expect(record.trailing_stop_active).toBe(0); // Not yet activated

    // 3. Price surges to 104.00 (MFE = 4.00, which is >= 2.0 * ATR) -> Activates Trailing Stop!
    currentMarkPrice = 104.00;
    await autoPilot.onTick('SOLUSDT', currentMarkPrice);
    record = tradesRepo.getById(tradeId)!;
    expect(record.peak_price).toBe(104.00);
    expect(record.peak_mfe).toBe(4.00);
    expect(record.trailing_stop_active).toBe(1); // Activated!

    // Floor price = peak_price - 0.35 * peak_mfe = 104.00 - 1.40 = 102.60
    const trailingState = autoPilot.getTrailingStopState('SOLUSDT')!;
    expect(trailingState.active).toBe(true);
    expect(trailingState.givebackFloorPrice).toBe(102.60);

    // 4. Minor pullback to 103.00 (pullback = 1.00 < 1.40 giveback threshold) -> Stays open
    currentMarkPrice = 103.00;
    await autoPilot.onTick('SOLUSDT', currentMarkPrice);
    expect(autoPilot.getState()).toBe('POSITION_OPEN');
    record = tradesRepo.getById(tradeId)!;
    expect(record.status).toBe('OPEN');

    // 5. Deeper pullback to 102.50 (below floor 102.60) -> Triggers Giveback Exit!
    currentMarkPrice = 102.50;
    await autoPilot.onTick('SOLUSDT', currentMarkPrice);

    record = tradesRepo.getById(tradeId)!;
    expect(record.status).toBe('CLOSED');
    expect(record.exit_reason).toBe('TRAILING_GIVEBACK_HALF');
    expect(mockBroker.cancelAllOrdersCalls.length).toBeGreaterThan(0);
    // 1st closePosition = 50% partial TP at Breakeven [ARCH-16], 2nd = remaining 50% runner on trailing giveback
    expect(mockBroker.closePositionCalls.length).toBe(2);
    expect(autoPilot.getState()).toBe('IDLE');
  });

  it('Short position: activates at 2.0x ATR and triggers exit on 50% rebound', async () => {
    const tradeId = 'short_trailing_test';
    const entryPrice = 100.0;
    const initialTrade: TradeRecord = {
      id: tradeId,
      symbol: 'SOLUSDT',
      broker_mode: 'BINANCE_DEMO',
      side: 'SELL',
      status: 'OPEN',
      entry_price: entryPrice,
      exit_price: null,
      quantity: 10,
      remaining_qty: 10,
      leverage: 10,
      margin_usd: 100,
      stop_loss: 102.0,
      tp1: 98.0,
      tp2: 95.0,
      be_price: 99.75,
      is_breakeven: 0,
      peak_price: entryPrice,
      peak_mfe: 0,
      trailing_stop_active: 0,
      client_order_id: `tos_${tradeId}_ent`,
      client_sl_id: `tos_${tradeId}_sl`,
      client_tp1_id: `tos_${tradeId}_tp1`,
      client_tp2_id: `tos_${tradeId}_tp2`,
      entry_order_id: null,
      sl_algo_id: null,
      tp1_algo_id: null,
      tp2_algo_id: null,
      realized_pnl: 0,
      fees_usd: 0,
      exit_reason: null,
      opened_at: Date.now() - 60_000,
      closed_at: null,
    };
    tradesRepo.insert(initialTrade);

    // Initial tick
    currentMarkPrice = 100.0;
    await autoPilot.onTick('SOLUSDT', currentMarkPrice);
    expect(autoPilot.getState()).toBe('POSITION_OPEN');

    // Price drops to 96.00 (MFE = 4.00 >= 2.0 * ATR) -> Activates!
    currentMarkPrice = 96.00;
    await autoPilot.onTick('SOLUSDT', currentMarkPrice);
    let record = tradesRepo.getById(tradeId)!;
    expect(record.peak_price).toBe(96.00);
    expect(record.peak_mfe).toBe(4.00);
    expect(record.trailing_stop_active).toBe(1);

    // Floor price for Short = peak_price + 0.35 * peak_mfe = 96.00 + 1.40 = 97.40
    const trailingState = autoPilot.getTrailingStopState('SOLUSDT')!;
    expect(trailingState.active).toBe(true);
    expect(trailingState.givebackFloorPrice).toBe(97.40);

    // Minor bounce to 97.00 (rebound = 1.00 < 1.40) -> Stays open
    currentMarkPrice = 97.00;
    await autoPilot.onTick('SOLUSDT', currentMarkPrice);
    expect(autoPilot.getState()).toBe('POSITION_OPEN');

    // Rebound crosses 97.40 (reaches 97.50) -> Triggers Giveback Exit!
    currentMarkPrice = 97.50;
    await autoPilot.onTick('SOLUSDT', currentMarkPrice);

    record = tradesRepo.getById(tradeId)!;
    expect(record.status).toBe('CLOSED');
    expect(record.exit_reason).toBe('TRAILING_GIVEBACK_HALF');
  });
});
