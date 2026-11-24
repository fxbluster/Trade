import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import { initializeDatabase, ExecutionChaseLogsRepo, TradesRepo } from '../src/db/sqlite.js';
import { TradeManager } from '../src/services/tradeManager.js';
import { AutoPilotManager } from '../src/services/autoPilotManager.js';
import { ConfluenceEngine } from '../src/quant/confluenceEngine.js';
import { AdaptiveSizingEngine } from '../src/quant/adaptiveSizingEngine.js';
import { ChasingExecutionEngine } from '../src/services/chasingExecutionEngine.js';
import { TwapExecutionSlicer } from '../src/services/twapExecutionSlicer.js';
import type {
  BrokerAdapter,
  PositionInfo,
  OrderExecutionResult,
  AlgoOrderParams,
  AlgoOrderResult,
} from '../src/exchange/broker.js';
import type {
  AccountInfo,
  OpenOrderInfo,
  BrokerMode,
  ConfluenceSnapshot,
} from '@tradeos/shared';

class MockBroker implements BrokerAdapter {
  readonly mode: BrokerMode = 'BINANCE_DEMO';
  public account: AccountInfo = {
    walletBalance: 10_000,
    equity: 10_000,
    availableBalance: 8_000,
    unrealizedPnl: 0,
    currency: 'USDT',
  };
  public position: PositionInfo | null = null;
  public openOrders: OpenOrderInfo[] = [];
  public openOrderCalls: any[] = [];
  public createAlgoOrderCalls: any[] = [];
  public closePositionCalls: any[] = [];
  public modifyOrderCalls: any[] = [];

  async getAccount(): Promise<AccountInfo> {
    return this.account;
  }

  async getPosition(symbol: string): Promise<PositionInfo | null> {
    return this.position;
  }

  async openOrder(req: any): Promise<OrderExecutionResult> {
    this.openOrderCalls.push(req);
    return {
      orderId: 'chase_order_' + Math.random().toString(36).slice(2, 8),
      clientOrderId: req.clientOrderId || 'tos_ent',
      status: 'NEW',
      executedQty: 0,
      avgPrice: req.limitPrice || 100,
    };
  }

  async modifyOrder(symbol: string, orderId: string, price: number, qty?: number): Promise<any> {
    this.modifyOrderCalls.push({ symbol, orderId, price, qty });
    return { orderId, status: 'MODIFIED', price, qty };
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

  async closePosition(symbol: string, qty?: number): Promise<any> {
    this.closePositionCalls.push({ symbol, qty });
    this.position = null;
    return { orderId: 'close_1', status: 'FILLED' };
  }

  async cancelOrder(symbol: string, orderId: string, isAlgo?: boolean): Promise<boolean> {
    return true;
  }

  async cancelAllOrders(symbol: string): Promise<boolean> {
    return true;
  }

  async moveToBreakeven(symbol: string, bePrice: number, currentSlId?: string): Promise<any> {
    return { newSlId: 'be_sl_1' };
  }

  async getOpenOrders(symbol?: string): Promise<OpenOrderInfo[]> {
    return this.openOrders;
  }
}

describe('AutoPilotManager Next-Gen Modular Integration', () => {
  let db: DatabaseSync;
  let broker: MockBroker;
  let tradeManager: TradeManager;
  let confluenceEngine: ConfluenceEngine;
  let adaptiveSizingEngine: AdaptiveSizingEngine;
  let chasingEngine: ChasingExecutionEngine;
  let twapSlicer: TwapExecutionSlicer;
  let executionLogsRepo: ExecutionChaseLogsRepo;
  let autoPilot: AutoPilotManager;
  let currentMarkPrice: number;

  beforeEach(() => {
    db = initializeDatabase(':memory:');
    broker = new MockBroker();
    currentMarkPrice = 100;
    tradeManager = new TradeManager({
      db,
      broker,
      brokerMode: 'BINANCE_DEMO',
      getMarkPrice: () => currentMarkPrice,
    });
    confluenceEngine = new ConfluenceEngine();
    adaptiveSizingEngine = new AdaptiveSizingEngine();
    chasingEngine = new ChasingExecutionEngine(broker, { debouncMs: 10, timeoutMs: 2000 });
    twapSlicer = new TwapExecutionSlicer(chasingEngine, { thresholdUsd: 5000, numSlices: 3, baseIntervalMs: 0 });
    executionLogsRepo = new ExecutionChaseLogsRepo(db);

    autoPilot = new AutoPilotManager({
      db,
      tradeManager,
      broker,
      confluenceEngine,
      adaptiveSizingEngine,
      chasingExecutionEngine: chasingEngine,
      twapExecutionSlicer: twapSlicer,
      executionChaseLogsRepo: executionLogsRepo,
      getMarkPrice: () => currentMarkPrice,
      getAtr: () => 2.0,
      config: {
        enabled: true,
        consensusThreshold: 4,
        marginAllocationPct: 10,
        leverage: 10,
        maxDailyTrades: 10,
      },
    });
  });

  function setConfluenceSnapshot(score: number, side: 'BUY' | 'SELL' = 'BUY') {
    const fullSnapshot: ConfluenceSnapshot = {
      symbol: 'SOLUSDT',
      pillars: [],
      bullishCount: side === 'BUY' ? 5 : 0,
      bearishCount: side === 'SELL' ? 5 : 0,
      neutralCount: 2,
      consensusBias: side === 'BUY' ? 'BULLISH' : 'BEARISH',
      consensusMet: true,
      threshold: 4,
      compositeScore: score,
      recommendedAction: score >= 75 ? (side === 'BUY' ? 'STRONG_BUY' : 'STRONG_SELL') : (side === 'BUY' ? 'BUY' : 'SELL'),
      macroVetoActive: false,
      macroRegime: side === 'BUY' ? 'MACRO_BULLISH' : 'MACRO_BEARISH',
      activeFvgs: [],
      activeOrderBlocks: [],
      latestSweep: null,
    };
    confluenceEngine.getSnapshot = () => fullSnapshot;
  }

  it('calculates dynamic margin allocation clamped within [5.0%, 30.0%]', async () => {
    // Conviction score 75 on $1000 wallet -> notional $800 < $5,000 -> routes to ChasingExecutionEngine
    broker.account.walletBalance = 1000;
    broker.account.availableBalance = 800;
    setConfluenceSnapshot(75, 'BUY');

    // Mock depth and immediate fill on chase
    vi.spyOn(chasingEngine, 'chase').mockResolvedValue({
      orderId: 'chase_fill_1',
      status: 'FILLED',
      fillPrice: 100,
      fillQty: 7.6,
      amendCount: 1,
    });

    await autoPilot.onTick('SOLUSDT', 100);

    const tradesRepo = new TradesRepo(db);
    const active = tradesRepo.getActivePosition('BINANCE_DEMO', 'SOLUSDT');
    expect(active).not.toBeNull();
    // Clamped in [5.0%, 30.0%]: $50 <= marginUsd <= $300
    expect(active!.margin_usd).toBeGreaterThanOrEqual(50);
    expect(active!.margin_usd).toBeLessThanOrEqual(300);
    expect(autoPilot.getState()).toBe('POSITION_OPEN');
  });

  it('routes high notional orders (>= $5,000) to TwapExecutionSlicer and logs to ExecutionChaseLogsRepo', async () => {
    // S=90 conviction on $10,000 wallet with 10x leverage produces > $5,000 notional
    setConfluenceSnapshot(90, 'BUY');

    const twapSpy = vi.spyOn(twapSlicer, 'execute').mockResolvedValue({
      totalQty: 200,
      filledQty: 200,
      slices: [
        { sliceIndex: 0, quantity: 65, intervalMs: 0, status: 'FILLED', fillPrice: 100 },
        { sliceIndex: 1, quantity: 65, intervalMs: 0, status: 'FILLED', fillPrice: 100 },
        { sliceIndex: 2, quantity: 70, intervalMs: 0, status: 'FILLED', fillPrice: 100 },
      ],
      status: 'COMPLETED',
    });

    await autoPilot.onTick('SOLUSDT', 100);

    expect(twapSpy).toHaveBeenCalled();

    // Verify logged to execution_chase_logs
    const logs = executionLogsRepo.getRecent('SOLUSDT', 10);
    expect(logs.length).toBeGreaterThanOrEqual(1);
    expect(logs[0].final_status).toBe('FILLED');
    expect(logs[0].amend_count).toBe(3); // 3 slices executed
    expect(logs[0].fee_saved_usd).toBeGreaterThan(0);
  });

  it('does not block open position risk management during LIMIT_CHASING', async () => {
    // Open an existing trade in SQLite
    const tradesRepo = new TradesRepo(db);
    const existingTradeId = 'existing_open_trade_1';
    tradesRepo.insert({
      id: existingTradeId,
      symbol: 'SOLUSDT',
      broker_mode: 'BINANCE_DEMO',
      side: 'BUY',
      status: 'OPEN',
      entry_price: 100,
      exit_price: null,
      quantity: 10,
      remaining_qty: 10,
      leverage: 10,
      margin_usd: 100,
      stop_loss: 97,
      tp1: 104,
      tp2: 108,
      be_price: 100.15,
      is_breakeven: 0,
      peak_price: 100,
      peak_mfe: 0,
      trailing_stop_active: 0,
      client_order_id: 'tos_ent_1',
      client_sl_id: 'tos_sl_1',
      client_tp1_id: 'tos_tp1_1',
      client_tp2_id: null,
      entry_order_id: 'ent_1',
      sl_algo_id: 'sl_1',
      tp1_algo_id: 'tp1_1',
      tp2_algo_id: null,
      realized_pnl: 0,
      fees_usd: 0.2,
      exit_reason: null,
      opened_at: Date.now(),
      closed_at: null,
    });

    // Manually put autoPilot in LIMIT_CHASING state
    (autoPilot as any).state = 'LIMIT_CHASING';
    (autoPilot as any).openTradeId = existingTradeId;

    // Price advances to $104 (profit $4 >= 1.5 * ATR $3), should trigger Breakeven migration
    currentMarkPrice = 104;
    await autoPilot.onTick('SOLUSDT', 104);

    const updated = tradesRepo.getById(existingTradeId);
    expect(updated?.is_breakeven).toBe(1);
  });
});
