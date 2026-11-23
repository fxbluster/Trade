import { describe, it, expect, beforeEach } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import { initializeDatabase, TradesRepo, SettingsRepo } from '../../db/sqlite.js';
import { TradeManager } from '../tradeManager.js';
import { AutoPilotManager } from '../autoPilotManager.js';
import { ConfluenceEngine } from '../../quant/confluenceEngine.js';
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
  WsServerMessage,
  TradeRecord,
  ConfluenceSnapshot,
} from '@tradeos/shared';

class MockBroker implements BrokerAdapter {
  readonly mode: BrokerMode = 'BINANCE_DEMO';
  public account: AccountInfo = {
    walletBalance: 1000,
    equity: 1000,
    availableBalance: 1000,
    unrealizedPnl: 0,
    currency: 'USDT',
  };
  public position: PositionInfo | null = null;
  public openOrders: OpenOrderInfo[] = [];

  public openOrderCalls: any[] = [];
  public createAlgoOrderCalls: any[] = [];
  public closePositionCalls: any[] = [];
  public cancelOrderCalls: any[] = [];
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
    this.createAlgoOrderCalls.push(params);
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
    this.cancelOrderCalls.push({ symbol, orderId, isAlgo });
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
    return { newSlId: 'new_be_sl_123' };
  }

  async getOpenOrders(symbol?: string): Promise<OpenOrderInfo[]> {
    return this.openOrders;
  }
}

describe('AutoPilotManager — Autonomous Algorithmic State Machine', () => {
  let db: DatabaseSync;
  let mockBroker: MockBroker;
  let tradeManager: TradeManager;
  let confluenceEngine: ConfluenceEngine;
  let autoPilot: AutoPilotManager;
  let wsMessages: WsServerMessage[];
  let markPrice: number;

  beforeEach(() => {
    db = initializeDatabase(':memory:');
    mockBroker = new MockBroker();
    wsMessages = [];
    markPrice = 100;

    tradeManager = new TradeManager({
      db,
      broker: mockBroker,
      brokerMode: 'BINANCE_DEMO',
      getMarkPrice: () => markPrice,
      broadcastWs: (m) => wsMessages.push(m),
    });

    confluenceEngine = new ConfluenceEngine();

    autoPilot = new AutoPilotManager({
      db,
      tradeManager,
      broker: mockBroker,
      confluenceEngine,
      getMarkPrice: () => markPrice,
      getAtr: () => 1.5,
      broadcastWs: (m) => wsMessages.push(m),
      config: {
        enabled: true,
        consensusThreshold: 4,
        marginAllocationPct: 10,
        leverage: 10,
        oppositeExitEnabled: true,
        circuitBreakerConsecutiveLosses: 2,
        circuitBreakerCooldownMs: 60 * 60 * 1000,
      },
    });
  });

  function setConfluenceSnapshot(snapshot: Partial<ConfluenceSnapshot>) {
    const fullSnapshot: ConfluenceSnapshot = {
      symbol: 'SOLUSDT',
      pillars: [],
      bullishCount: 5,
      bearishCount: 0,
      neutralCount: 2,
      consensusBias: 'BULLISH',
      consensusMet: true,
      threshold: 4,
      compositeScore: 78,
      recommendedAction: 'BUY',
      macroVetoActive: false,
      macroRegime: 'MACRO_BULLISH',
      activeFvgs: [],
      activeOrderBlocks: [],
      latestSweep: null,
      ...snapshot,
    };
    confluenceEngine.getSnapshot = () => fullSnapshot;
    confluenceEngine.getLatestSnapshot = () => fullSnapshot;
    confluenceEngine.evaluate = () => fullSnapshot;
    (confluenceEngine as any).latestSnapshot = fullSnapshot;
  }

  // --------------------------------------------------------------------------
  // Test 1: PLACING_ORDER mutex prevents tick concurrency races
  // --------------------------------------------------------------------------
  it('prevents concurrent entry orders on rapid 4Hz ticks via synchronous state latch', async () => {
    // Set confluence to BUY consensus
    setConfluenceSnapshot({
      symbol: 'SOLUSDT',
      pillars: [],
      bullishCount: 5,
      bearishCount: 0,
      neutralCount: 2,
      consensusBias: 'BULLISH',
      consensusMet: true,
      threshold: 4,
      compositeScore: 78,
      recommendedAction: 'BUY',
    });

    // Fire 5 rapid ticks simultaneously
    const promises = [
      autoPilot.onTick('SOLUSDT', 100),
      autoPilot.onTick('SOLUSDT', 100.1),
      autoPilot.onTick('SOLUSDT', 100.2),
      autoPilot.onTick('SOLUSDT', 100.3),
      autoPilot.onTick('SOLUSDT', 100.4),
    ];

    await Promise.all(promises);

    // Exactly 1 order must have been placed
    expect(mockBroker.openOrderCalls.length).toBe(1);
    expect(autoPilot.getState()).toBe('POSITION_OPEN');
    expect(autoPilot.getOpenTradeId()).not.toBeNull();
  });

  // --------------------------------------------------------------------------
  // Test 2: Auto-entry executes with 10% margin cap, 10x leverage, and IOC limit
  // --------------------------------------------------------------------------
  it('places marketable IOC limit order with 0.10% slippage ceiling and ATR-based bracket stop-loss', async () => {
    setConfluenceSnapshot({
      symbol: 'SOLUSDT',
      pillars: [],
      bullishCount: 4,
      bearishCount: 1,
      neutralCount: 2,
      consensusBias: 'BULLISH',
      consensusMet: true,
      threshold: 4,
      compositeScore: 70,
      recommendedAction: 'BUY',
    });

    await autoPilot.onTick('SOLUSDT', 100);

    expect(mockBroker.openOrderCalls.length).toBe(1);
    const orderReq = mockBroker.openOrderCalls[0];

    // Verify 10% margin cap ($100 on $1000 balance)
    expect(orderReq.marginUsd).toBe(100);
    expect(orderReq.leverage).toBe(10);
    expect(orderReq.side).toBe('BUY');
    expect(orderReq.orderType).toBe('LIMIT');

    // Slippage ceiling: markPrice * 1.0010 = 100.10
    expect(orderReq.limitPrice).toBe(100.10);

    // Stop loss at 1.5x ATR (1.5 * 1.5 = 2.25) -> 100 - 2.25 = 97.75
    expect(orderReq.stopLoss).toBe(97.75);

    // Dynamic TP1 pins to nearest liquidation cluster (25x short liq at 104.10, R:R >= 1.5)
    expect(orderReq.tp1).toBe(104.10);
    // Dynamic TP2 runner scales with TP1 ratio: 100 + (4.10 * 2) = 108.20
    expect(orderReq.tp2).toBe(108.20);

    expect(autoPilot.getState()).toBe('POSITION_OPEN');
  });

  // --------------------------------------------------------------------------
  // Test 3: Auto-Breakeven migration
  // --------------------------------------------------------------------------
  it('migrates Stop-Loss to Breakeven when profit reaches Math.max(1.5*ATR, 0.25%)', async () => {
    // 1. Enter position
    setConfluenceSnapshot({
      symbol: 'SOLUSDT',
      pillars: [],
      bullishCount: 4,
      bearishCount: 0,
      neutralCount: 3,
      consensusBias: 'BULLISH',
      consensusMet: true,
      threshold: 4,
      compositeScore: 72,
      recommendedAction: 'BUY',
    });
    await autoPilot.onTick('SOLUSDT', 100);

    const tradeId = autoPilot.getOpenTradeId()!;
    const tradesRepo = new TradesRepo(db);
    const trade = tradesRepo.getById(tradeId)!;
    expect(trade.is_breakeven).toBe(0);

    // 2. Advance price to $103 (profit per unit $3 > Math.max(1.5 * 1.5 = 2.25, 0.25))
    markPrice = 103;
    await autoPilot.onTick('SOLUSDT', markPrice);

    const updated = tradesRepo.getById(tradeId)!;
    expect(updated.is_breakeven).toBe(1);
    expect(updated.be_price).toBeCloseTo(trade.entry_price * 1.0015, 2);
  });

  // --------------------------------------------------------------------------
  // Test 4: Opposite-Confluence Exit (persisting for 2 consecutive ticks)
  // --------------------------------------------------------------------------
  it('triggers emergency early exit when market consensus reverses for 2 consecutive ticks', async () => {
    // 1. Enter LONG position
    setConfluenceSnapshot({
      symbol: 'SOLUSDT',
      pillars: [],
      bullishCount: 5,
      bearishCount: 0,
      neutralCount: 2,
      consensusBias: 'BULLISH',
      consensusMet: true,
      threshold: 4,
      compositeScore: 75,
      recommendedAction: 'BUY',
    });
    await autoPilot.onTick('SOLUSDT', 100);
    expect(autoPilot.getState()).toBe('POSITION_OPEN');

    // 2. Confluence flips to BEARISH
    setConfluenceSnapshot({
      symbol: 'SOLUSDT',
      pillars: [],
      bullishCount: 1,
      bearishCount: 5,
      neutralCount: 1,
      consensusBias: 'BEARISH',
      consensusMet: true,
      threshold: 4,
      compositeScore: 25,
      recommendedAction: 'SELL',
    });

    // Tick 1 of opposite consensus -> Position should remain open (monitoring)
    await autoPilot.onTick('SOLUSDT', 100);
    expect(autoPilot.getState()).toBe('POSITION_OPEN');
    expect(mockBroker.closePositionCalls.length).toBe(0);

    // Tick 2 of opposite consensus -> Must trigger emergency early exit!
    await autoPilot.onTick('SOLUSDT', 99.8);
    expect(mockBroker.closePositionCalls.length).toBe(1);
    expect(mockBroker.closePositionCalls[0].symbol).toBe('SOLUSDT');
    expect(autoPilot.getState()).toBe('IDLE');
    expect(autoPilot.getOpenTradeId()).toBeNull();
  });

  // --------------------------------------------------------------------------
  // Test 5: Re-entry 180s symbol lockout
  // --------------------------------------------------------------------------
  it('enforces mandatory 180s re-entry symbol lockout after position close', async () => {
    // 1. Enter and close a position
    setConfluenceSnapshot({
      symbol: 'SOLUSDT',
      pillars: [],
      bullishCount: 5,
      bearishCount: 0,
      neutralCount: 2,
      consensusBias: 'BULLISH',
      consensusMet: true,
      threshold: 4,
      compositeScore: 80,
      recommendedAction: 'BUY',
    });
    await autoPilot.onTick('SOLUSDT', 100);

    // Manually close position through tradeManager
    await tradeManager.closePosition('SOLUSDT', 'MANUAL_TEST_CLOSE');

    // Notify autoPilot by ticking
    await autoPilot.onTick('SOLUSDT', 100);
    expect(autoPilot.getState()).toBe('IDLE');
    expect(mockBroker.openOrderCalls.length).toBe(1);

    // 2. Immediate tick with valid BUY consensus within 180s should be rejected by lockout
    await autoPilot.onTick('SOLUSDT', 100);
    expect(mockBroker.openOrderCalls.length).toBe(1); // No new order placed!
  });

  // --------------------------------------------------------------------------
  // Test 6: 2-consecutive-loss circuit breaker persists 60m cooldown in SQLite
  // --------------------------------------------------------------------------
  it('triggers 60-minute circuit-breaker cooldown upon 2 consecutive losses and persists to SQLite', async () => {
    setConfluenceSnapshot({
      symbol: 'SOLUSDT',
      pillars: [],
      bullishCount: 5,
      bearishCount: 0,
      neutralCount: 2,
      consensusBias: 'BULLISH',
      consensusMet: true,
      threshold: 4,
      compositeScore: 80,
      recommendedAction: 'BUY',
    });

    // Trade 1: Open and close with loss
    await autoPilot.onTick('SOLUSDT', 100);
    const trade1Id = autoPilot.getOpenTradeId()!;
    const tradesRepo = new TradesRepo(db);
    tradesRepo.update(trade1Id, { status: 'CLOSED', realized_pnl: -15.0 });
    await autoPilot.onTick('SOLUSDT', 98); // processes close

    // Simulate bypassing 180s lockout for testing second trade
    (autoPilot as any).lastExitTime = Date.now() - 200_000;

    // Trade 2: Open and close with loss
    await autoPilot.onTick('SOLUSDT', 100);
    const trade2Id = autoPilot.getOpenTradeId()!;
    tradesRepo.update(trade2Id, { status: 'CLOSED', realized_pnl: -20.0 });
    await autoPilot.onTick('SOLUSDT', 97); // processes close

    // AutoPilot must now be in COOLDOWN_ACTIVE state!
    expect(autoPilot.getState()).toBe('COOLDOWN_ACTIVE');
    expect(autoPilot.isCooldownActive()).toBe(true);
    expect(autoPilot.getCooldownRemainingSec()).toBeGreaterThan(3500);

    // Verify persisted in SQLite settings table
    const settingsRepo = new SettingsRepo(db);
    const stored = settingsRepo.get<{ until: number }>('autopilot_cooldown_until');
    expect(stored).not.toBeNull();
    expect(stored!.until).toBeGreaterThan(Date.now() + 3500 * 1000);
  });

  // --------------------------------------------------------------------------
  // Test 7: [DEF-12] Session Trade Cap halts and broadcasts BLOCKED_SESSION_TRADE_CAP
  // --------------------------------------------------------------------------
  it('halts with BLOCKED_SESSION_TRADE_CAP state and broadcasts telemetry when daily filled trades reach cap', async () => {
    setConfluenceSnapshot({
      symbol: 'SOLUSDT',
      bullishCount: 5,
      consensusMet: true,
      recommendedAction: 'BUY',
    });

    // Configure maxDailyTrades = 2
    autoPilot.updateConfig({ maxDailyTrades: 2 });
    expect(autoPilot.getConfig().maxDailyTrades).toBe(2);

    // Record 2 filled trades today in SQLite
    const tradesRepo = new TradesRepo(db);
    const nowUtc = new Date();
    const startOfUtcDay = Date.UTC(nowUtc.getUTCFullYear(), nowUtc.getUTCMonth(), nowUtc.getUTCDate());

    tradesRepo.insert({
      id: 'trade_cap_1',
      symbol: 'SOLUSDT',
      broker_mode: 'BINANCE_DEMO',
      side: 'BUY',
      status: 'CLOSED',
      entry_price: 100,
      exit_price: 102,
      quantity: 1,
      remaining_qty: 0,
      leverage: 10,
      margin_usd: 10,
      stop_loss: 95,
      tp1: 105,
      tp2: 110,
      be_price: null,
      is_breakeven: 0,
      peak_price: 102,
      peak_mfe: 2,
      trailing_stop_active: 0,
      client_order_id: 'c1',
      client_sl_id: null,
      client_tp1_id: null,
      client_tp2_id: null,
      entry_order_id: null,
      sl_algo_id: null,
      tp1_algo_id: null,
      tp2_algo_id: null,
      realized_pnl: 2.0,
      fees_usd: 0.1,
      exit_reason: 'TAKE_PROFIT_1',
      opened_at: startOfUtcDay + 1000,
      closed_at: startOfUtcDay + 5000,
    });
    tradesRepo.insert({
      id: 'trade_cap_2',
      symbol: 'SOLUSDT',
      broker_mode: 'BINANCE_DEMO',
      side: 'BUY',
      status: 'CLOSED',
      entry_price: 100,
      exit_price: 101.5,
      quantity: 1,
      remaining_qty: 0,
      leverage: 10,
      margin_usd: 10,
      stop_loss: 95,
      tp1: 105,
      tp2: 110,
      be_price: null,
      is_breakeven: 0,
      peak_price: 101.5,
      peak_mfe: 1.5,
      trailing_stop_active: 0,
      client_order_id: 'c2',
      client_sl_id: null,
      client_tp1_id: null,
      client_tp2_id: null,
      entry_order_id: null,
      sl_algo_id: null,
      tp1_algo_id: null,
      tp2_algo_id: null,
      realized_pnl: 1.5,
      fees_usd: 0.1,
      exit_reason: 'TAKE_PROFIT_1',
      opened_at: startOfUtcDay + 6000,
      closed_at: startOfUtcDay + 9000,
    });

    wsMessages = [];
    await autoPilot.onTick('SOLUSDT', 100);

    // No order should be placed
    expect(mockBroker.openOrderCalls.length).toBe(0);
    // State should be BLOCKED_SESSION_TRADE_CAP
    expect(autoPilot.getState()).toBe('BLOCKED_SESSION_TRADE_CAP');

    // Telemetry broadcast should notify UI of session cap
    const capMsg = wsMessages.find(
      (m: any) => m.type === 'AUTOPILOT_STATUS' && m.data.state === 'BLOCKED_SESSION_TRADE_CAP'
    );
    expect(capMsg).toBeDefined();
    expect((capMsg as any).data.blockReason).toBe('BLOCKED_SESSION_TRADE_CAP');
    expect((capMsg as any).data.filledToday).toBe(2);
    expect((capMsg as any).data.maxDailyTrades).toBe(2);

    // When cap is raised to 5, state returns to IDLE and permits execution
    autoPilot.updateConfig({ maxDailyTrades: 5 });
    await autoPilot.onTick('SOLUSDT', 100);
    expect(mockBroker.openOrderCalls.length).toBe(1);
    expect(autoPilot.getState()).toBe('POSITION_OPEN');
  });

  // --------------------------------------------------------------------------
  // Test 8: [DEF-13] Proactive 2% Daily Drawdown Ceiling halts onTick
  // --------------------------------------------------------------------------
  it('proactively halts and enters COOLDOWN_ACTIVE onTick when daily net loss reaches 2% equity', async () => {
    setConfluenceSnapshot({
      symbol: 'SOLUSDT',
      bullishCount: 5,
      consensusMet: true,
      recommendedAction: 'BUY',
    });

    // Account balance = 1000 -> 2% drawdown ceiling = $20.00
    // Record -$25.00 loss today
    const tradesRepo = new TradesRepo(db);
    const nowUtc = new Date();
    const startOfUtcDay = Date.UTC(nowUtc.getUTCFullYear(), nowUtc.getUTCMonth(), nowUtc.getUTCDate());

    tradesRepo.insert({
      id: 'trade_loss_1',
      symbol: 'SOLUSDT',
      broker_mode: 'BINANCE_DEMO',
      side: 'BUY',
      status: 'CLOSED',
      entry_price: 100,
      exit_price: 97.5,
      quantity: 1,
      remaining_qty: 0,
      leverage: 10,
      margin_usd: 10,
      stop_loss: 95,
      tp1: 105,
      tp2: 110,
      be_price: null,
      is_breakeven: 0,
      peak_price: 100,
      peak_mfe: 0,
      trailing_stop_active: 0,
      client_order_id: 'c_loss',
      client_sl_id: null,
      client_tp1_id: null,
      client_tp2_id: null,
      entry_order_id: null,
      sl_algo_id: null,
      tp1_algo_id: null,
      tp2_algo_id: null,
      realized_pnl: -25.0,
      fees_usd: 0.1,
      exit_reason: 'STOP_LOSS',
      opened_at: startOfUtcDay + 1000,
      closed_at: startOfUtcDay + 5000,
    });

    wsMessages = [];
    await autoPilot.onTick('SOLUSDT', 100);

    // No order should be placed
    expect(mockBroker.openOrderCalls.length).toBe(0);
    // Cooldown must be active until tomorrow 00:00 UTC
    expect(autoPilot.getState()).toBe('COOLDOWN_ACTIVE');
    expect(autoPilot.isCooldownActive()).toBe(true);

    const drawdownMsg = wsMessages.find(
      (m: any) => m.type === 'AUTOPILOT_STATUS' && m.data.blockReason === 'BLOCKED_DAILY_MAX_LOSS'
    );
    expect(drawdownMsg).toBeDefined();
    expect((drawdownMsg as any).data.state).toBe('COOLDOWN_ACTIVE');
  });
});
