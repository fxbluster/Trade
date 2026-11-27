import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import {
  initializeDatabase,
  ExecutionChaseLogsRepo,
  TradesRepo,
  DecisionLogsRepo,
  FactorTelemetryRecordsRepo,
} from '../src/db/sqlite.js';
import { TradeManager } from '../src/services/tradeManager.js';
import { AutoPilotManager } from '../src/services/autoPilotManager.js';
import { DecisionAuditService } from '../src/services/decisionAuditService.js';
import { ConfluenceEngine } from '../src/quant/confluenceEngine.js';
import { AlphaRegistry } from '../src/quant/alphaRegistry.js';
import {
  OrderFlowFactor,
  NativeSmcFactor,
  CvdAbsorptionFactor,
} from '../src/quant/factors/index.js';
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
  FactorTelemetryEvent,
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

  it('synthesizes FactorTelemetryEvent on ConfluenceEngine.evaluate() with archetype and collinear factors', () => {
    const registry = new AlphaRegistry();
    registry.registerFactor(new OrderFlowFactor());
    registry.registerFactor(new NativeSmcFactor());
    registry.registerFactor(new CvdAbsorptionFactor());

    const engineWithRegistry = new ConfluenceEngine({ alphaRegistry: registry });
    const now = Date.now();
    engineWithRegistry.orderFlowEngine.updateDepth([[100.0, 2000]], [[100.1, 200]]);
    for (let i = 0; i < 3; i++) {
      engineWithRegistry.orderFlowEngine.processTrade(100, false, now - (3 - i) * 1000, 100 + i * 0.1);
    }

    const snap = engineWithRegistry.evaluate({
      symbol: 'SOLUSDT',
      currentPrice: 100,
      indicators: null,
      cvd: null,
    });

    expect(snap.telemetryEvent).toBeDefined();
    expect(snap.telemetryEvent!.symbol).toBe('SOLUSDT');
    expect(Array.isArray(snap.telemetryEvent!.activeFactors)).toBe(true);
    expect(Array.isArray(snap.telemetryEvent!.collinearFactors)).toBe(true);
    expect(snap.telemetryEvent!.activeFactors.length + snap.telemetryEvent!.collinearFactors.length).toBeGreaterThan(0);
    expect([
      'SUB_THRESHOLD',
      'EXPLORATORY_PROBE',
      'STANDARD_INSTITUTIONAL',
      'HIGH_CONVICTION_CORE',
      'A_PLUS_INSTITUTIONAL',
    ]).toContain(snap.telemetryEvent!.convictionArchetype);
  });

  it('emits SIGNAL_CONFIRMED, ORDER_AMENDED, POSITION_ENTERED, POSITION_EXITED and onStateTransition("IDLE") across trade lifecycle', async () => {
    const telemetryEvents: FactorTelemetryEvent[] = [];
    const stateTransitions: string[] = [];
    const logsRepo = new DecisionLogsRepo(db);
    const factorRecordsRepo = new FactorTelemetryRecordsRepo(db);
    const auditService = new DecisionAuditService(logsRepo, undefined, {
      factorTelemetryRecordsRepo: factorRecordsRepo,
      executionChaseLogsRepo: executionLogsRepo,
      flushIntervalMs: 0,
    });

    const localChasing = new ChasingExecutionEngine(broker, {
      debouncMs: 5,
      timeoutMs: 2000,
      tickSize: 0.01,
    });

    const wiredAutoPilot = new AutoPilotManager({
      db,
      tradeManager,
      broker,
      confluenceEngine,
      adaptiveSizingEngine,
      chasingExecutionEngine: localChasing,
      twapExecutionSlicer: new TwapExecutionSlicer(localChasing, { thresholdUsd: 50_000 }),
      executionChaseLogsRepo: executionLogsRepo,
      getMarkPrice: () => currentMarkPrice,
      getAtr: () => 2.0,
      onTelemetryEvent: (ev) => {
        telemetryEvents.push(ev);
        auditService.recordFactorTelemetry(ev);
      },
      onStateTransition: (newState) => {
        stateTransitions.push(newState);
      },
      onOrderDispatched: (ev) => auditService.recordExecution(ev),
      config: {
        enabled: true,
        consensusThreshold: 4,
        marginAllocationPct: 10,
        leverage: 10,
        maxDailyTrades: 10,
      },
    });

    broker.account.walletBalance = 1000;
    broker.account.availableBalance = 800;

    // Seed L2 depth so ChasingExecutionEngine places & amends at least once before filling
    confluenceEngine.orderFlowEngine.updateDepth([[99.9, 500]], [[100.1, 500]]);

    const snap: ConfluenceSnapshot = {
      symbol: 'SOLUSDT',
      pillars: [],
      bullishCount: 5,
      bearishCount: 0,
      neutralCount: 2,
      consensusBias: 'BULLISH',
      consensusMet: true,
      threshold: 4,
      compositeScore: 84,
      recommendedAction: 'STRONG_BUY',
      macroVetoActive: false,
      macroRegime: 'MACRO_BULLISH',
      activeFvgs: [],
      activeOrderBlocks: [],
      latestSweep: null,
      noiseBandActive: false,
      telemetryEvent: {
        timestamp: Date.now(),
        symbol: 'SOLUSDT',
        triggerType: 'SIGNAL_CONFIRMED',
        markPrice: 100,
        compositeScore: 84,
        convictionArchetype: 'HIGH_CONVICTION_CORE',
        consensusSide: 'BUY',
        noiseBandActive: false,
        macroVetoActive: false,
        activeFactors: [
          {
            factorId: 'ORDER_FLOW_L2',
            name: 'Order Flow L2',
            bias: 'BULLISH',
            rawAlpha: 0.8,
            orthogonalAlpha: 0.72,
            effectiveWeight: 0.65,
            isCollinear: false,
            confidence: 0.9,
            summaryText: 'Bid imbalance 2.1x',
          },
        ],
        collinearFactors: ['Native SMC'],
      },
    };
    confluenceEngine.getSnapshot = () => snap;

    let openOrderChecks = 0;
    vi.spyOn(broker, 'openOrder').mockImplementation(async (req: any) => {
      const orderId = 'chase_ord_1';
      broker.openOrders = [
        {
          orderId,
          symbol: req.symbol,
          side: req.side,
          price: req.limitPrice,
          origQty: req.quantity,
          executedQty: 0,
          type: 'LIMIT',
          isAlgo: false,
        },
      ];
      return {
        orderId,
        clientOrderId: 'tos_ent',
        status: 'NEW',
        executedQty: 0,
        avgPrice: req.limitPrice,
      };
    });

    vi.spyOn(broker, 'getOpenOrders').mockImplementation(async () => {
      openOrderChecks += 1;
      if (openOrderChecks === 1) {
        // Shift depth so ChasingExecutionEngine performs an in-flight amendment
        confluenceEngine.orderFlowEngine.updateDepth([[99.95, 500]], [[100.15, 500]]);
        return broker.openOrders;
      }
      // Second check: mark as filled by clearing openOrders
      broker.openOrders = [];
      return [];
    });

    (broker as any).getOrder = vi.fn().mockImplementation(async (_sym: string, orderId: string) => {
      openOrderChecks += 1;
      if (openOrderChecks === 1) {
        // Shift depth so ChasingExecutionEngine performs an in-flight amendment
        confluenceEngine.orderFlowEngine.updateDepth([[99.95, 500]], [[100.15, 500]]);
        return {
          orderId,
          clientOrderId: 'tos_ent',
          status: 'NEW',
          executedQty: 0,
          avgPrice: broker.openOrders[0]?.price ?? 100,
        };
      }
      const fillPrice = broker.openOrders[0]?.price ?? 100;
      const fillQty = broker.openOrders[0]?.origQty ?? 1;
      broker.openOrders = [];
      return {
        orderId,
        clientOrderId: 'tos_ent',
        status: 'FILLED',
        executedQty: fillQty,
        avgPrice: fillPrice,
      };
    });

    await wiredAutoPilot.onTick('SOLUSDT', 100);

    const triggers = telemetryEvents.map((e) => e.triggerType);
    expect(triggers).toContain('SIGNAL_CONFIRMED');
    expect(triggers).toContain('ORDER_AMENDED');
    expect(triggers).toContain('POSITION_ENTERED');

    const amendedEv = telemetryEvents.find((e) => e.triggerType === 'ORDER_AMENDED')!;
    expect(amendedEv.chasingTelemetry).toBeDefined();
    expect(amendedEv.chasingTelemetry!.anchorMarkPrice).toBe(100);

    const enteredEv = telemetryEvents.find((e) => e.triggerType === 'POSITION_ENTERED')!;
    expect(enteredEv.chasingTelemetry).toBeDefined();
    expect(enteredEv.chasingTelemetry!.status).toBe('FILLED');
    expect(enteredEv.chasingTelemetry!.amendmentCount).toBeGreaterThanOrEqual(1);
    expect(enteredEv.sizingTelemetry).toBeDefined();
    expect(enteredEv.sizingTelemetry!.allocatedMarginUsd).toBeGreaterThan(0);

    // Verify decision_logs received serialized Next-Gen vectors
    const logs = logsRepo.listSessionDecisions(0);
    expect(logs.length).toBeGreaterThanOrEqual(1);
    const execLog = logs.find((l) => l.action === 'EXECUTED')!;
    expect(execLog.factor_telemetry_json).toBeTruthy();
    expect(execLog.execution_chase_json).toBeTruthy();
    expect(execLog.sizing_breakdown_json).toBeTruthy();
    expect(execLog.noise_band_state).toBe(0);

    // Trigger Watchdog SL close -> emits POSITION_EXITED and transitions to IDLE
    stateTransitions.length = 0;
    currentMarkPrice = 95;
    await wiredAutoPilot.onTick('SOLUSDT', 95);

    expect(telemetryEvents.some((e) => e.triggerType === 'POSITION_EXITED')).toBe(true);
    expect(stateTransitions).toContain('IDLE');
    expect(wiredAutoPilot.getState()).toBe('IDLE');

    auditService.dispose();
  });

  describe('ARCH-05..08a Calibration', () => {
    it('[ARCH-05] enforces 0.60% MFE trailing activation floor and 35% giveback trigger', async () => {
      const tradesRepo = new TradesRepo(db);
      const tradeId = 'arch05_trade_1';
      tradesRepo.insert({
        id: tradeId,
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
        is_breakeven: 1,
        peak_price: 100,
        peak_mfe: 0,
        trailing_stop_active: 0,
        client_order_id: 'tos_arch05_ent',
        client_sl_id: 'tos_arch05_sl',
        client_tp1_id: 'tos_arch05_tp1',
        client_tp2_id: null,
        entry_order_id: 'ent_arch05',
        sl_algo_id: 'sl_arch05',
        tp1_algo_id: 'tp1_arch05',
        tp2_algo_id: null,
        realized_pnl: 0,
        fees_usd: 0.2,
        exit_reason: null,
        opened_at: Date.now(),
        closed_at: null,
      });

      // Use small ATR (0.1) so 0.60% floor (0.60) governs over 2.5 * ATR (0.25)
      const localAutoPilot = new AutoPilotManager({
        db,
        tradeManager,
        broker,
        confluenceEngine,
        getMarkPrice: () => currentMarkPrice,
        getAtr: () => 0.1,
        config: {
          enabled: true,
          consensusThreshold: 4,
          marginAllocationPct: 10,
          leverage: 10,
          maxDailyTrades: 10,
        },
      });
      (localAutoPilot as any).state = 'POSITION_OPEN';
      (localAutoPilot as any).openTradeId = tradeId;

      // 0.40% MFE (< 0.60% floor) -> trailing_stop_active stays 0
      currentMarkPrice = 100.4;
      await localAutoPilot.onTick('SOLUSDT', 100.4);
      expect(tradesRepo.getById(tradeId)!.trailing_stop_active).toBe(0);

      // 1.00% MFE (>= 0.60% floor) -> trailing_stop_active becomes 1
      currentMarkPrice = 101.0;
      await localAutoPilot.onTick('SOLUSDT', 101.0);
      expect(tradesRepo.getById(tradeId)!.trailing_stop_active).toBe(1);

      // 30% pullback (100.70, giveback 0.30 < 0.35) -> should NOT close
      currentMarkPrice = 100.7;
      await localAutoPilot.onTick('SOLUSDT', 100.7);
      expect(broker.closePositionCalls.length).toBe(0);

      // 35% pullback (100.65, giveback 0.35 >= 0.35 * 1.0) -> triggers TRAILING_GIVEBACK_HALF
      const closeSpy = vi.spyOn(tradeManager, 'closePosition');
      currentMarkPrice = 100.65;
      await localAutoPilot.onTick('SOLUSDT', 100.65);
      expect(closeSpy).toHaveBeenCalledWith('SOLUSDT', 'TRAILING_GIVEBACK_HALF');
    });

    it('[ARCH-06] recalculates SL/TP1/TP2 anchored on Maker Limit Chasing effectivePrice', async () => {
      broker.account.walletBalance = 1000;
      broker.account.availableBalance = 800;
      setConfluenceSnapshot(75, 'BUY');

      // Signal arrives at markPrice = 100, but Maker Limit Chasing fills at effectivePrice = 102
      vi.spyOn(chasingEngine, 'chase').mockResolvedValue({
        orderId: 'chase_fill_arch06',
        status: 'FILLED',
        fillPrice: 102,
        fillQty: 7.5,
        amendCount: 1,
      });

      const localAutoPilot = new AutoPilotManager({
        db,
        tradeManager,
        broker,
        confluenceEngine,
        adaptiveSizingEngine,
        chasingExecutionEngine: chasingEngine,
        executionChaseLogsRepo: executionLogsRepo,
        getMarkPrice: () => 100,
        getAtr: () => 1.0,
        config: {
          enabled: true,
          consensusThreshold: 4,
          marginAllocationPct: 10,
          leverage: 10,
          maxDailyTrades: 10,
        },
      });

      await localAutoPilot.onTick('SOLUSDT', 100);

      const tradesRepo = new TradesRepo(db);
      const active = tradesRepo.getActivePosition('BINANCE_DEMO', 'SOLUSDT');
      expect(active).not.toBeNull();
      expect(active!.entry_price).toBe(102);
      // Anchored on 102 with ATR=1.0 -> minSlDist=1.5 -> SL=100.50 (not 98.50 from markPrice=100)
      expect(active!.stop_loss).toBe(100.5);
      const slAlgo = broker.createAlgoOrderCalls.find((c) => c.type === 'STOP_MARKET');
      expect(slAlgo?.triggerPrice).toBe(100.5);
      expect(active!.tp1).toBeGreaterThan(102);
      expect(active!.tp2).toBeGreaterThan(active!.tp1!);
    });

    it('[ARCH-07] does not emit FAILED spam when calculated margin < 5.0 USD', async () => {
      const dispatched: any[] = [];
      broker.account.walletBalance = 20;
      broker.account.availableBalance = 15;
      setConfluenceSnapshot(75, 'BUY');

      const localAutoPilot = new AutoPilotManager({
        db,
        tradeManager,
        broker,
        confluenceEngine,
        adaptiveSizingEngine,
        getMarkPrice: () => 100,
        getAtr: () => 2.0,
        onOrderDispatched: (ev) => dispatched.push(ev),
        config: {
          enabled: true,
          consensusThreshold: 4,
          marginAllocationPct: 10,
          leverage: 10,
          maxDailyTrades: 10,
        },
      });

      await localAutoPilot.onTick('SOLUSDT', 100);
      expect(localAutoPilot.getState()).toBe('IDLE');
      expect(dispatched.filter((e) => e.action === 'FAILED')).toHaveLength(0);
    });

    it('[ARCH-08a] requires >= 75 opposite conviction during first 180s and >= 70 thereafter', async () => {
      const tradesRepo = new TradesRepo(db);
      const tradeId = 'arch08a_trade_1';
      tradesRepo.insert({
        id: tradeId,
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
        stop_loss: 95,
        tp1: 106,
        tp2: 112,
        be_price: 100.15,
        is_breakeven: 0,
        peak_price: 100,
        peak_mfe: 0,
        trailing_stop_active: 0,
        client_order_id: 'tos_arch08a_ent',
        client_sl_id: 'tos_arch08a_sl',
        client_tp1_id: 'tos_arch08a_tp1',
        client_tp2_id: null,
        entry_order_id: 'ent_arch08a',
        sl_algo_id: 'sl_arch08a',
        tp1_algo_id: 'tp1_arch08a',
        tp2_algo_id: null,
        realized_pnl: 0,
        fees_usd: 0.2,
        exit_reason: null,
        opened_at: Date.now(),
        closed_at: null,
      });

      const localAutoPilot = new AutoPilotManager({
        db,
        tradeManager,
        broker,
        confluenceEngine,
        getMarkPrice: () => 100,
        getAtr: () => 2.0,
        config: {
          enabled: true,
          consensusThreshold: 4,
          marginAllocationPct: 10,
          leverage: 10,
          maxDailyTrades: 10,
          oppositeExitEnabled: true,
        },
      });
      (localAutoPilot as any).state = 'POSITION_OPEN';
      (localAutoPilot as any).openTradeId = tradeId;

      const closeSpy = vi.spyOn(tradeManager, 'closePosition');

      // Within 180s: opposite conviction 72 (< 75) for 2 ticks -> must NOT close
      setConfluenceSnapshot(72, 'SELL');
      await localAutoPilot.onTick('SOLUSDT', 100);
      await localAutoPilot.onTick('SOLUSDT', 100);
      expect(closeSpy).not.toHaveBeenCalled();

      // After 180s: opposite conviction 65 (< 70) for 2 ticks -> must NOT close
      tradesRepo.update(tradeId, { opened_at: Date.now() - 200_000 });
      setConfluenceSnapshot(65, 'SELL');
      await localAutoPilot.onTick('SOLUSDT', 100);
      await localAutoPilot.onTick('SOLUSDT', 100);
      expect(closeSpy).not.toHaveBeenCalled();

      // After 180s: opposite conviction 70 (>= 70) sustained >= 30s -> closes with OPPOSITE_CONFLUENCE_REVERSAL
      setConfluenceSnapshot(70, 'SELL');
      await localAutoPilot.onTick('SOLUSDT', 100);
      (localAutoPilot as any).oppositeFirstSeenAtBySymbol.set('SOLUSDT', Date.now() - 35_000);
      await localAutoPilot.onTick('SOLUSDT', 100);
      expect(closeSpy).toHaveBeenCalledWith('SOLUSDT', 'OPPOSITE_CONFLUENCE_REVERSAL');
    });
  });
});
