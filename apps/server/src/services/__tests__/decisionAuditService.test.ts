import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  initializeDatabase,
  DecisionLogsRepo,
  TradesRepo,
  PillarTelemetryRepo,
  FactorTelemetryRecordsRepo,
  ExecutionChaseLogsRepo,
} from '../../db/sqlite.js';
import {
  DecisionAuditService,
  computeSpearmanIC,
  estimateTokenCount,
  clampMarkdownToTokenBudget,
} from '../decisionAuditService.js';
import type {
  ConfluenceSnapshot,
  DailyAuditResponse,
  DecisionLogRecord,
  FactorTelemetryEvent,
  KlineCandle,
  TradeRecord,
} from '@tradeos/shared';

describe('DecisionAuditService', () => {
  let db: any;
  let repo: DecisionLogsRepo;
  let tradesRepo: TradesRepo;
  let service: DecisionAuditService;

  beforeEach(() => {
    db = initializeDatabase(':memory:');
    repo = new DecisionLogsRepo(db);
    tradesRepo = new TradesRepo(db);
    service = new DecisionAuditService(repo);
  });

  const createDummyTrade = (id: string = 'trade_123'): TradeRecord => ({
    id,
    symbol: 'SOLUSDT',
    broker_mode: 'LOCAL_PAPER',
    side: 'BUY',
    status: 'OPEN',
    entry_price: 100.0,
    exit_price: null,
    quantity: 10.0,
    remaining_qty: 10.0,
    leverage: 10,
    margin_usd: 100.0,
    stop_loss: 98.5,
    tp1: 101.5,
    tp2: null,
    be_price: null,
    is_breakeven: 0,
    client_order_id: null,
    client_sl_id: null,
    client_tp1_id: null,
    client_tp2_id: null,
    entry_order_id: null,
    sl_algo_id: null,
    tp1_algo_id: null,
    tp2_algo_id: null,
    realized_pnl: 0,
    fees_usd: 0,
    exit_reason: null,
    opened_at: Date.now(),
    closed_at: null,
  });

  const createDummySnapshot = (overrides: Partial<ConfluenceSnapshot> = {}): ConfluenceSnapshot => ({
    symbol: 'SOLUSDT',
    pillars: [],
    bullishCount: 5,
    bearishCount: 1,
    neutralCount: 1,
    consensusBias: 'BULLISH',
    consensusMet: true,
    threshold: 4,
    compositeScore: 65,
    recommendedAction: 'BUY',
    macroVetoActive: true,
    macroRegime: 'MACRO_BEARISH',
    activeFvgs: [],
    activeOrderBlocks: [],
    latestSweep: null,
    ...overrides,
  });

  // Test 1: Stateful rising-edge hysteresis latch arming and cooldown
  it('1. arms latch when score < 50%, triggers BLOCKED at >= 60%, and enforces 180s cooldown', () => {
    const symbol = 'SOLUSDT';

    // Initial state: not armed
    expect(service.getLatchState(symbol, 'BUY').isArmed).toBe(false);

    // Call evaluateSnapshot with score 45% -> should arm
    const lowSnapshot = createDummySnapshot({ compositeScore: 45, consensusBias: 'BULLISH' });
    service.evaluateSnapshot(lowSnapshot, 1.0, 100);
    expect(service.getLatchState(symbol, 'BUY').isArmed).toBe(true);
    expect(repo.getOpenShadowSetups(symbol)).toHaveLength(0);

    // Call with score 65% -> should trigger and insert BLOCKED setup
    const highSnapshot = createDummySnapshot({ compositeScore: 65, consensusBias: 'BULLISH' });
    service.evaluateSnapshot(highSnapshot, 1.0, 100);

    const setups = repo.getOpenShadowSetups(symbol);
    expect(setups).toHaveLength(1);
    expect(setups[0].action).toBe('BLOCKED');
    expect(setups[0].shadow_status).toBe('OPEN');
    expect(setups[0].shadow_sl).toBe(98.5); // 100 - 1.5 * 1.0
    expect(setups[0].shadow_tp).toBe(101.5); // 100 + 1.5 * 1.0

    // After trigger, latch is disarmed
    expect(service.getLatchState(symbol, 'BUY').isArmed).toBe(false);

    // Repeated call with score 65% immediately -> must NOT trigger duplicate
    service.evaluateSnapshot(highSnapshot, 1.0, 100);
    expect(repo.getOpenShadowSetups(symbol)).toHaveLength(1);
  });

  // Test 2: Suppression of duplicate shadow setups
  it('2. suppresses duplicate shadow setup if one is already open for same (symbol, side)', () => {
    const symbol = 'SOLUSDT';
    // Arm latch
    service.evaluateSnapshot(createDummySnapshot({ compositeScore: 40 }), 1.0, 100);
    // Trigger
    service.evaluateSnapshot(createDummySnapshot({ compositeScore: 65 }), 1.0, 100);
    expect(repo.getOpenShadowSetups(symbol)).toHaveLength(1);

    // Force re-arm and bypass cooldown
    (service as any).latches.get('SOLUSDT:BUY').isArmed = true;
    (service as any).latches.get('SOLUSDT:BUY').lastTriggeredAt = 0;

    // Trigger again while setup is still open in repo
    service.evaluateSnapshot(createDummySnapshot({ compositeScore: 65 }), 1.0, 100);

    // Still exactly 1 setup (duplicate suppressed)
    expect(repo.getOpenShadowSetups(symbol)).toHaveLength(1);
  });

  // Test 3: Production execution recording and latch disarm
  it('3. recordExecution inserts EXECUTED or FAILED record directly and disarms latch', () => {
    const symbol = 'SOLUSDT';
    tradesRepo.insert(createDummyTrade('trade_123'));

    // Arm latch
    service.evaluateSnapshot(createDummySnapshot({ compositeScore: 40 }), 1.0, 100);
    expect(service.getLatchState(symbol, 'BUY').isArmed).toBe(true);

    // AutoPilot fills order
    service.recordExecution({
      symbol: 'SOLUSDT',
      side: 'BUY',
      action: 'EXECUTED',
      price: 100.05,
      marginUsd: 100,
      leverage: 10,
      atr: 1.0,
      tradeId: 'trade_123',
    });

    // Latch must be immediately disarmed
    expect(service.getLatchState(symbol, 'BUY').isArmed).toBe(false);

    // Check SQLite record
    const all = repo.listSessionDecisions(0);
    expect(all).toHaveLength(1);
    expect(all[0].action).toBe('EXECUTED');
    expect(all[0].trade_id).toBe('trade_123');
    expect(all[0].execution_price).toBe(100.05);

    // Record FAILED
    service.recordExecution({
      symbol: 'SOLUSDT',
      side: 'SELL',
      action: 'FAILED',
      price: 100,
      marginUsd: 100,
      leverage: 10,
      atr: 1.0,
      errorMessage: 'Insufficient margin balance',
    });

    const failed = repo.listSessionDecisions(0);
    expect(failed).toHaveLength(2);
    expect(failed[1].action).toBe('FAILED');
    expect(failed[1].error_message).toBe('Insufficient margin balance');
  });

  // Test 4: Long (BUY) Stop-Loss trigger -> SAVED_CAPITAL
  it('4. evaluates Long Stop-Loss trigger -> SAVED_CAPITAL with 0.15% friction deduction', () => {
    // Setup: entry 100, ATR 1.0, 10x leverage, margin $100 -> SL 98.5, TP 101.5
    // Notional = $1000, Position Size = 10 units, Friction = 1000 * 0.0015 = $1.50
    // SL exit = 98.5 -> Gross = (98.5 - 100) * 10 = -$15.00 -> Net = -15 - 1.5 = -$16.50
    const now = Date.now();
    service.evaluateSnapshot(createDummySnapshot({ compositeScore: 40 }), 1.0, 100);
    service.evaluateSnapshot(createDummySnapshot({ compositeScore: 70 }), 1.0, 100);

    const setup = repo.getOpenShadowSetups('SOLUSDT')[0];
    expect(setup).toBeDefined();

    // Candle hits SL: low = 98.0 <= 98.5, high = 100.5
    const candle: KlineCandle = {
      time: Math.floor((now + 60_000) / 1000), // seconds
      open: 100,
      high: 100.5,
      low: 98.0,
      close: 98.5,
      volume: 1000,
    };

    service.onCandleClose('SOLUSDT', candle);

    expect(repo.getOpenShadowSetups('SOLUSDT')).toHaveLength(0);
    const settled = repo.listSessionDecisions(0)[0];
    expect(settled.shadow_status).toBe('SAVED_CAPITAL');
    expect(settled.shadow_pnl_usd).toBe(-16.50);
  });

  // Test 5: Long (BUY) Take-Profit trigger -> MISSED_PROFIT
  it('5. evaluates Long Take-Profit trigger -> MISSED_PROFIT with 0.15% friction deduction', () => {
    // TP exit = 101.5 -> Gross = (101.5 - 100) * 10 = +$15.00 -> Net = +15 - 1.5 = +$13.50
    const now = Date.now();
    service.evaluateSnapshot(createDummySnapshot({ compositeScore: 40 }), 1.0, 100);
    service.evaluateSnapshot(createDummySnapshot({ compositeScore: 70 }), 1.0, 100);

    // Candle hits TP: high = 102.0 >= 101.5, low = 99.5
    const candle: KlineCandle = {
      time: Math.floor((now + 60_000) / 1000),
      open: 100,
      high: 102.0,
      low: 99.5,
      close: 101.5,
      volume: 1000,
    };

    service.onCandleClose('SOLUSDT', candle);

    expect(repo.getOpenShadowSetups('SOLUSDT')).toHaveLength(0);
    const settled = repo.listSessionDecisions(0)[0];
    expect(settled.shadow_status).toBe('MISSED_PROFIT');
    expect(settled.shadow_pnl_usd).toBe(13.50);
  });

  // Test 6: Short (SELL) Stop-Loss trigger -> SAVED_CAPITAL
  it('6. evaluates Short Stop-Loss trigger -> SAVED_CAPITAL with 0.15% friction deduction', () => {
    // Short setup: entry 100, ATR 1.0 -> SL 101.5, TP 98.5
    // SL exit = 101.5 -> Gross = (100 - 101.5) * 10 = -$15.00 -> Net = -15 - 1.5 = -$16.50
    const now = Date.now();
    service.evaluateSnapshot(createDummySnapshot({ compositeScore: 40 }), 1.0, 100);
    service.evaluateSnapshot(
      createDummySnapshot({
        compositeScore: 70,
        consensusBias: 'BEARISH',
        recommendedAction: 'SELL',
      }),
      1.0,
      100
    );

    const setup = repo.getOpenShadowSetups('SOLUSDT')[0];
    expect(setup.side).toBe('SELL');
    expect(setup.shadow_sl).toBe(101.5);
    expect(setup.shadow_tp).toBe(98.5);

    // Candle hits Short SL: high = 102.0 >= 101.5, low = 99.5
    const candle: KlineCandle = {
      time: Math.floor((now + 60_000) / 1000),
      open: 100,
      high: 102.0,
      low: 99.5,
      close: 101.5,
      volume: 1000,
    };

    service.onCandleClose('SOLUSDT', candle);

    const settled = repo.listSessionDecisions(0)[0];
    expect(settled.shadow_status).toBe('SAVED_CAPITAL');
    expect(settled.shadow_pnl_usd).toBe(-16.50);
  });

  // Test 7: Short (SELL) Take-Profit trigger -> MISSED_PROFIT
  it('7. evaluates Short Take-Profit trigger -> MISSED_PROFIT with 0.15% friction deduction', () => {
    // TP exit = 98.5 -> Gross = (100 - 98.5) * 10 = +$15.00 -> Net = +15 - 1.5 = +$13.50
    const now = Date.now();
    service.evaluateSnapshot(createDummySnapshot({ compositeScore: 40 }), 1.0, 100);
    service.evaluateSnapshot(
      createDummySnapshot({
        compositeScore: 70,
        consensusBias: 'BEARISH',
        recommendedAction: 'SELL',
      }),
      1.0,
      100
    );

    // Candle hits Short TP: low = 98.0 <= 98.5, high = 100.2
    const candle: KlineCandle = {
      time: Math.floor((now + 60_000) / 1000),
      open: 100,
      high: 100.2,
      low: 98.0,
      close: 98.5,
      volume: 1000,
    };

    service.onCandleClose('SOLUSDT', candle);

    const settled = repo.listSessionDecisions(0)[0];
    expect(settled.shadow_status).toBe('MISSED_PROFIT');
    expect(settled.shadow_pnl_usd).toBe(13.50);
  });

  // Test 8: Scratch trade touching TP with Net PnL <= 0 -> SAVED_CAPITAL
  it('8. categorizes scratch trade hitting TP with Net PnL <= 0 as SAVED_CAPITAL', () => {
    // If gross gain does not cover $1.50 friction, it was capital saved from negative friction drag
    // Directly insert record with tiny target: entry 100, tp 100.10 (Gross = +$1.00, Friction = $1.50 -> Net = -$0.50)
    const now = Date.now();
    repo.insert({
      id: 'scratch_test',
      timestamp: now,
      symbol: 'SOLUSDT',
      side: 'BUY',
      action: 'BLOCKED',
      composite_score: 65,
      pillars_json: '[]',
      macro_regime: 'MACRO_BEARISH',
      macro_veto_active: 1,
      veto_reasons_json: '["MACRO_VETO"]',
      execution_price: 100,
      margin_usd: 100,
      leverage: 10,
      atr: 0.0667,
      trade_id: null,
      shadow_status: 'OPEN',
      shadow_sl: 98.0,
      shadow_tp: 100.10,
      shadow_pnl_usd: null,
      expires_at: now + 3600000,
      shadow_closed_at: null,
      error_message: null,
      created_at: now,
    });

    const candle: KlineCandle = {
      time: Math.floor((now + 60_000) / 1000),
      open: 100,
      high: 100.20,
      low: 99.80,
      close: 100.10,
      volume: 1000,
    };

    service.onCandleClose('SOLUSDT', candle);

    const settled = repo.listSessionDecisions(0)[0];
    expect(settled.shadow_status).toBe('SAVED_CAPITAL');
    expect(settled.shadow_pnl_usd).toBe(-0.50);
  });

  // Test 9: Dual-wick in same candle -> RESOLVED_AMBIGUOUS_VOLATILITY
  it('9. resolves intra-bar dual-wick hitting both SL and TP as RESOLVED_AMBIGUOUS_VOLATILITY with $0.00 PnL', () => {
    const now = Date.now();
    service.evaluateSnapshot(createDummySnapshot({ compositeScore: 40 }), 1.0, 100);
    service.evaluateSnapshot(createDummySnapshot({ compositeScore: 70 }), 1.0, 100);

    // Candle wick extends both below SL (98.5) and above TP (101.5)
    const candle: KlineCandle = {
      time: Math.floor((now + 60_000) / 1000),
      open: 100,
      high: 102.5,
      low: 97.5,
      close: 100,
      volume: 5000,
    };

    service.onCandleClose('SOLUSDT', candle);

    const settled = repo.listSessionDecisions(0)[0];
    expect(settled.shadow_status).toBe('RESOLVED_AMBIGUOUS_VOLATILITY');
    expect(settled.shadow_pnl_usd).toBe(0.00);
  });

  // Test 10: Expiration after 60 minutes -> EXPIRED
  it('10. marks setup as EXPIRED with mark-to-market close price after 60 minutes', () => {
    const now = Date.now();
    service.evaluateSnapshot(createDummySnapshot({ compositeScore: 40 }), 1.0, 100);
    service.evaluateSnapshot(createDummySnapshot({ compositeScore: 70 }), 1.0, 100);

    const setup = repo.getOpenShadowSetups('SOLUSDT')[0];
    const expiresAt = setup.expires_at!;

    // Candle closes at or after expiresAt without hitting SL (98.5) or TP (101.5)
    // Close = 100.5 -> Gross = (100.5 - 100) * 10 = +$5.00 -> Net = +5 - 1.5 = +$3.50
    const candle: KlineCandle = {
      time: Math.ceil(expiresAt / 1000) + 1,
      open: 100.2,
      high: 100.8,
      low: 99.8,
      close: 100.5,
      volume: 1000,
    };

    service.onCandleClose('SOLUSDT', candle);

    const settled = repo.listSessionDecisions(0)[0];
    expect(settled.shadow_status).toBe('EXPIRED');
    expect(settled.shadow_pnl_usd).toBe(3.50);
  });

  // Test 11: Birth candle look-behind bias prevention
  it('11. strictly ignores candles where candle.time * 1000 < setup.timestamp', () => {
    const now = Date.now();
    service.evaluateSnapshot(createDummySnapshot({ compositeScore: 40 }), 1.0, 100);
    service.evaluateSnapshot(createDummySnapshot({ compositeScore: 70 }), 1.0, 100);

    // Candle from 60 seconds PRIOR to setup creation touches SL price
    const priorCandle: KlineCandle = {
      time: Math.floor((now - 60_000) / 1000),
      open: 99,
      high: 99.5,
      low: 97.0, // Touches SL
      close: 98.0,
      volume: 1000,
    };

    service.onCandleClose('SOLUSDT', priorCandle);

    // Setup must remain OPEN (not triggered by historical candle)
    const open = repo.getOpenShadowSetups('SOLUSDT');
    expect(open).toHaveLength(1);
    expect(open[0].shadow_status).toBe('OPEN');
  });

  // Test 12: Multi-symbol isolation
  it('12. isolates symbols so BTC candle close does not alter or evaluate SOL shadow setups', () => {
    const now = Date.now();
    service.evaluateSnapshot(createDummySnapshot({ symbol: 'SOLUSDT', compositeScore: 40 }), 1.0, 100);
    service.evaluateSnapshot(createDummySnapshot({ symbol: 'SOLUSDT', compositeScore: 70 }), 1.0, 100);

    expect(repo.getOpenShadowSetups('SOLUSDT')).toHaveLength(1);

    // BTC candle arrives touching SOL SL price
    const btcCandle: KlineCandle = {
      time: Math.floor((now + 60_000) / 1000),
      open: 95000,
      high: 96000,
      low: 94000,
      close: 95500,
      volume: 1000,
    };

    service.onCandleClose('BTCUSDT', btcCandle);

    // SOL setup remains unaffected and OPEN
    const solOpen = repo.getOpenShadowSetups('SOLUSDT');
    expect(solOpen).toHaveLength(1);
    expect(solOpen[0].shadow_status).toBe('OPEN');
  });

  // Test 13: Summary aggregation and Markdown report formatting
  it('13. computes session summary statistics and formats valid Markdown report', () => {
    const now = Date.now();
    tradesRepo.insert(createDummyTrade('t_1'));

    // Insert 1 EXECUTED record
    repo.insert({
      id: 'dec_exec_1',
      timestamp: now - 3000,
      symbol: 'SOLUSDT',
      side: 'BUY',
      action: 'EXECUTED',
      composite_score: 80,
      pillars_json: '[]',
      macro_regime: 'MACRO_BULLISH',
      macro_veto_active: 0,
      veto_reasons_json: null,
      execution_price: 100,
      margin_usd: 100,
      leverage: 10,
      atr: 1.0,
      trade_id: 't_1',
      shadow_status: null,
      shadow_sl: null,
      shadow_tp: null,
      shadow_pnl_usd: null,
      expires_at: null,
      shadow_closed_at: null,
      error_message: null,
      created_at: now - 3000,
    });

    // Insert 1 SAVED_CAPITAL (saved loss of -$15.00)
    repo.insert({
      id: 'dec_saved_1',
      timestamp: now - 2000,
      symbol: 'SOLUSDT',
      side: 'BUY',
      action: 'BLOCKED',
      composite_score: 65,
      pillars_json: '[]',
      macro_regime: 'MACRO_BEARISH',
      macro_veto_active: 1,
      veto_reasons_json: '["MACRO_VETO"]',
      execution_price: 100,
      margin_usd: 100,
      leverage: 10,
      atr: 1.0,
      trade_id: null,
      shadow_status: 'SAVED_CAPITAL',
      shadow_sl: 98.5,
      shadow_tp: 101.5,
      shadow_pnl_usd: -15.00,
      expires_at: now + 3600000,
      shadow_closed_at: now - 1000,
      error_message: null,
      created_at: now - 2000,
    });

    // Insert 1 MISSED_PROFIT (missed gain of +$10.00)
    repo.insert({
      id: 'dec_missed_1',
      timestamp: now - 1500,
      symbol: 'SOLUSDT',
      side: 'BUY',
      action: 'BLOCKED',
      composite_score: 62,
      pillars_json: '[]',
      macro_regime: 'MACRO_BEARISH',
      macro_veto_active: 1,
      veto_reasons_json: '["MACRO_VETO", "COOLDOWN_ACTIVE"]',
      execution_price: 100,
      margin_usd: 100,
      leverage: 10,
      atr: 1.0,
      trade_id: null,
      shadow_status: 'MISSED_PROFIT',
      shadow_sl: 98.5,
      shadow_tp: 101.5,
      shadow_pnl_usd: 10.00,
      expires_at: now + 3600000,
      shadow_closed_at: now - 500,
      error_message: null,
      created_at: now - 1500,
    });

    // Insert 1 EXPIRED (pnl $2.00)
    repo.insert({
      id: 'dec_exp_1',
      timestamp: now - 1000,
      symbol: 'SOLUSDT',
      side: 'BUY',
      action: 'BLOCKED',
      composite_score: 61,
      pillars_json: '[]',
      macro_regime: 'MACRO_BEARISH',
      macro_veto_active: 1,
      veto_reasons_json: '["MACRO_VETO"]',
      execution_price: 100,
      margin_usd: 100,
      leverage: 10,
      atr: 1.0,
      trade_id: null,
      shadow_status: 'EXPIRED',
      shadow_sl: 98.5,
      shadow_tp: 101.5,
      shadow_pnl_usd: 2.00,
      expires_at: now,
      shadow_closed_at: now,
      error_message: null,
      created_at: now - 1000,
    });

    const response = service.generateSessionSummary();
    const { summary, records } = response;

    expect(summary.total_setups).toBe(4);
    expect(summary.executed_trades).toBe(1);
    expect(summary.blocked_setups).toBe(3);
    expect(summary.capital_saved_usd).toBe(15.00); // | -15.00 |
    expect(summary.missed_profit_usd).toBe(10.00);
    expect(summary.expired_pnl_usd).toBe(2.00);
    expect(summary.net_risk_value_usd).toBe(5.00); // 15.00 - 10.00
    expect(summary.veto_breakdown['MACRO_VETO']).toBe(3);
    expect(summary.veto_breakdown['COOLDOWN_ACTIVE']).toBe(1);
    expect(records).toHaveLength(4);

    // Test Markdown report format
    const md = service.formatMarkdownReport(response);
    expect(md).toContain('# TradeOS Daily Decision Audit & Shadow Report');
    expect(md).toContain('| Capital Saved | $15.00 |');
    expect(md).toContain('| Missed Profit | $10.00 |');
    expect(md).toContain('| **Net Risk Value** | **$5.00** |');
    expect(md).toContain('| MACRO_VETO | 3 |');
  });

  // Test 14: Downtime gap recovery with BinanceClient
  it('14. recovers downtime gaps using BinanceClient.getKlines and settles bars sequentially', async () => {
    const now = Date.now();
    // Insert an open setup from downtime
    repo.insert({
      id: 'dec_gap_1',
      timestamp: now - 120_000,
      symbol: 'SOLUSDT',
      side: 'BUY',
      action: 'BLOCKED',
      composite_score: 68,
      pillars_json: '[]',
      macro_regime: 'MACRO_BEARISH',
      macro_veto_active: 1,
      veto_reasons_json: '["MACRO_VETO"]',
      execution_price: 100,
      margin_usd: 100,
      leverage: 10,
      atr: 1.0,
      trade_id: null,
      shadow_status: 'OPEN',
      shadow_sl: 98.5,
      shadow_tp: 101.5,
      shadow_pnl_usd: null,
      expires_at: now + 3600000,
      shadow_closed_at: null,
      error_message: null,
      created_at: now - 120_000,
    });

    const mockKlines = [
      // bar 1: no hit
      [now - 60_000, '100', '100.5', '99.5', '100.2', '100'],
      // bar 2: hits TP 101.5
      [now - 30_000, '100.2', '102.0', '100.1', '101.8', '200'],
    ];

    const mockClient = {
      getKlines: vi.fn().mockResolvedValue(mockKlines),
    } as any;

    await service.recoverDowntimeGaps(mockClient);

    expect(mockClient.getKlines).toHaveBeenCalledWith(
      'SOLUSDT',
      '1m',
      60,
      now - 120_000,
      expect.any(Number)
    );

    const open = repo.getOpenShadowSetups('SOLUSDT');
    expect(open).toHaveLength(0);

    const settled = repo.listSessionDecisions(0)[0];
    expect(settled.shadow_status).toBe('MISSED_PROFIT');
    expect(settled.shadow_pnl_usd).toBe(13.50);
  });

  it('15. persists Next-Gen telemetry columns, computes attribution & chase summary, and renders Next-Gen Markdown without legacy P1-P7 tags', () => {
    const ftRepo = new FactorTelemetryRecordsRepo(db);
    const chaseRepo = new ExecutionChaseLogsRepo(db);
    const ngService = new DecisionAuditService(db, undefined, {
      factorTelemetryRecordsRepo: ftRepo,
      executionChaseLogsRepo: chaseRepo,
      flushIntervalMs: 0,
    });

    tradesRepo.insert(createDummyTrade('trade_ng_1'));
    chaseRepo.insert({
      trade_id: 'trade_ng_1',
      symbol: 'SOLUSDT',
      anchor_price: 145.5,
      amend_count: 2,
      duration_ms: 840,
      final_status: 'FILLED',
      effective_price: 145.48,
      fee_saved_usd: 1.42,
      created_at: Date.now() - 1000,
    });

    const activeFactors = [
      {
        factorId: 'ORDER_FLOW_L2',
        name: 'Order Flow L2',
        bias: 'BULLISH' as const,
        rawAlpha: 0.78,
        orthogonalAlpha: 0.72,
        effectiveWeight: 0.546,
        isCollinear: false,
        confidence: 0.91,
        summaryText: 'Depth Imbalance 1.8x Bid',
      },
    ];
    const chasing = {
      orderId: 'chase-1',
      status: 'FILLED' as const,
      anchorMarkPrice: 145.5,
      currentLimitPrice: 145.48,
      spreadPennyJumps: 2,
      amendmentCount: 2,
      durationMs: 840,
      realizedFeeUsd: 0.95,
      feeSavedVsTakerUsd: 1.42,
    };
    const sizing = {
      allocatedMarginUsd: 1200,
      allocatedMarginPct: 25.0,
      baseConvictionMargin: 0.21,
      quarterKellyMultiplier: 0.85,
      volatilityParityMultiplier: 1.1,
      circuitBreakerMultiplier: 1.0,
      solvencyAirbagOk: true,
    };

    // recordExecution with Next-Gen columns
    ngService.recordExecution({
      symbol: 'SOLUSDT',
      side: 'BUY',
      action: 'EXECUTED',
      price: 145.48,
      marginUsd: 1200,
      leverage: 10,
      atr: 1.4,
      tradeId: 'trade_ng_1',
      compositeScore: 84,
      factorTelemetryJson: JSON.stringify(activeFactors),
      executionChaseJson: JSON.stringify(chasing),
      sizingBreakdownJson: JSON.stringify(sizing),
      noiseBandState: 0,
    });

    // evaluateSnapshot with Next-Gen snapshot metadata (use SELL side so SOLUSDT:BUY recordExecution disarm doesn't suppress it)
    ngService.evaluateSnapshot(createDummySnapshot({ compositeScore: 40, consensusBias: 'BEARISH', recommendedAction: 'SELL' }), 1.4, 145.5);
    ngService.evaluateSnapshot(
      createDummySnapshot({
        compositeScore: 66,
        consensusBias: 'BEARISH',
        recommendedAction: 'SELL',
        noiseBandActive: true,
        blockReason: 'BLOCKED_NOISE_BAND',
        telemetryEvent: {
          timestamp: Date.now(),
          symbol: 'SOLUSDT',
          triggerType: 'SUB_THRESHOLD_IMPULSE',
          markPrice: 145.5,
          compositeScore: 66,
          convictionArchetype: 'SUB_THRESHOLD',
          consensusSide: 'SELL',
          noiseBandActive: true,
          macroVetoActive: true,
          activeFactors,
          collinearFactors: ['NATIVE_SMC'],
        },
      }),
      1.4,
      145.5
    );

    const rows = repo.listSessionDecisions(0);
    expect(rows).toHaveLength(2);
    const execRow = rows.find((r) => r.action === 'EXECUTED')!;
    expect(execRow.factor_telemetry_json).toContain('ORDER_FLOW_L2');
    expect(execRow.execution_chase_json).toContain('chase-1');
    expect(execRow.sizing_breakdown_json).toContain('quarterKellyMultiplier');
    expect(execRow.noise_band_state).toBe(0);

    const blockedRow = rows.find((r) => r.action === 'BLOCKED')!;
    expect(blockedRow.noise_band_state).toBe(1);
    expect(blockedRow.factor_telemetry_json).toContain('ORDER_FLOW_L2');

    // Insert settled factor row for attribution summary
    const ids = ftRepo.insertEventBatch(
      {
        eventId: 'evt-ng-settled-1',
        timestamp: Date.now() - 3_700_000,
        symbol: 'SOLUSDT',
        triggerType: 'POSITION_ENTERED',
        markPrice: 145.5,
        compositeScore: 84,
        convictionArchetype: 'HIGH_CONVICTION_CORE',
        consensusSide: 'BUY',
        noiseBandActive: false,
        macroVetoActive: false,
        activeFactors,
        collinearFactors: [],
        chasingTelemetry: chasing,
        sizingTelemetry: sizing,
      },
      execRow.id
    );
    ftRepo.updateHorizonExcursions(ids[0]!, {
      post_1m_mfe: 0.005,
      post_1m_mae: -0.001,
      post_5m_mfe: 0.012,
      post_5m_mae: -0.002,
      post_15m_mfe: 0.02,
      post_15m_mae: -0.002,
      post_1h_mfe: 0.035,
      post_1h_mae: -0.003,
      status: 'SETTLED',
      settle_timestamp: Date.now(),
    });

    const summaryRes = ngService.generateSessionSummary(0, { limit: 10, offset: 0 });
    expect(summaryRes.date).toBeDefined();
    expect(summaryRes.summary.total_trades).toBe(1);
    expect(summaryRes.summary.maker_fee_savings_usd).toBeCloseTo(1.42, 2);
    expect(summaryRes.execution_chase_summary).toEqual({
      totalFeeSavedUsd: 1.42,
      totalChases: 1,
      successfulChases: 1,
    });
    expect(summaryRes.factor_telemetry_events).toHaveLength(1);
    expect(summaryRes.factor_attribution_summary).toHaveLength(1);
    expect(summaryRes.factor_attribution_summary![0]!.factorId).toBe('ORDER_FLOW_L2');

    const md = ngService.formatMarkdownReport(summaryRes);
    expect(md).toContain('# TradeOS Daily Decision Audit & Shadow Report');
    expect(md).toContain('Orthogonal Factor Attribution Matrix');
    expect(md).toContain('Trade Execution Attribution');
    expect(md).toContain('ORDER_FLOW_L2');
    expect(md).not.toMatch(/\bP[1-7]:/);
    expect(md).not.toContain('Sub-Threshold Market Impulses');
    ngService.dispose();
  });

  // Test 16: Hysteresis latch, async ring-buffer for ORDER_AMENDED, queueMicrotask for terminal events, safe callback
  it('16. enforces 180s hysteresis for SUB_THRESHOLD_IMPULSE, queues ORDER_AMENDED without sync SQLite write, and flushes terminal events via microtask', async () => {
    const ftRepo = new FactorTelemetryRecordsRepo(db);
    const received: FactorTelemetryEvent[] = [];
    const onTelemetryEvent = vi.fn((ev: FactorTelemetryEvent) => {
      received.push(ev);
      if (ev.symbol === 'ERRUSDT') {
        throw new Error('WS broadcast failure');
      }
    });

    const ngService = new DecisionAuditService(db, undefined, {
      factorTelemetryRecordsRepo: ftRepo,
      flushIntervalMs: 500,
      maxRingBufferSize: 500,
      onTelemetryEvent,
    });

    const t0 = 1_700_000_000_000;
    const makeEvent = (overrides: Partial<FactorTelemetryEvent> = {}): FactorTelemetryEvent => ({
      eventId: `evt-${Math.random().toString(36).slice(2)}`,
      timestamp: t0,
      symbol: 'SOLUSDT',
      triggerType: 'SUB_THRESHOLD_IMPULSE',
      markPrice: 145.5,
      compositeScore: 48,
      convictionArchetype: 'SUB_THRESHOLD',
      consensusSide: 'BUY',
      noiseBandActive: false,
      macroVetoActive: false,
      activeFactors: [
        {
          factorId: 'ORDER_FLOW_L2',
          name: 'Order Flow L2',
          bias: 'BULLISH',
          rawAlpha: 0.4,
          orthogonalAlpha: 0.35,
          effectiveWeight: 0.5,
          isCollinear: false,
          confidence: 0.7,
          summaryText: 'Bid imbalance',
        },
      ],
      collinearFactors: [],
      ...overrides,
    });

    // 1. First SUB_THRESHOLD_IMPULSE accepted
    expect(ngService.recordFactorTelemetry(makeEvent({ eventId: 'imp-1', timestamp: t0 }))).toBe(true);
    // 2. Duplicate within 180s suppressed for same (SOLUSDT, BUY)
    expect(ngService.recordFactorTelemetry(makeEvent({ eventId: 'imp-2', timestamp: t0 + 10_000 }))).toBe(false);
    // 3. Different side (SELL) or different symbol (BTCUSDT) allowed independently
    expect(
      ngService.recordFactorTelemetry(makeEvent({ eventId: 'imp-sell', timestamp: t0 + 10_000, consensusSide: 'SELL' }))
    ).toBe(true);
    expect(
      ngService.recordFactorTelemetry(makeEvent({ eventId: 'imp-btc', timestamp: t0 + 10_000, symbol: 'BTCUSDT' }))
    ).toBe(true);
    // 4. After 180s cooldown, same (SOLUSDT, BUY) accepted again
    expect(ngService.recordFactorTelemetry(makeEvent({ eventId: 'imp-3', timestamp: t0 + 180_000 }))).toBe(true);

    // 5. SIGNAL_CONFIRMED & POSITION_ENTERED bypass hysteresis immediately (no suppression within 180s)
    expect(
      ngService.recordFactorTelemetry(
        makeEvent({
          eventId: 'sig-1',
          timestamp: t0 + 181_000,
          triggerType: 'SIGNAL_CONFIRMED',
          compositeScore: 82,
          convictionArchetype: 'HIGH_CONVICTION_CORE',
        })
      )
    ).toBe(true);
    await Promise.resolve(); // allow queueMicrotask flush

    // 6. ORDER_AMENDED enqueued in ring buffer WITHOUT synchronous SQLite write on hot path
    const countBeforeAmend = ftRepo.listRecentEvents(0, 100, 0).length;
    expect(
      ngService.recordFactorTelemetry(
        makeEvent({
          eventId: 'amend-1',
          timestamp: t0 + 182_000,
          triggerType: 'ORDER_AMENDED',
          compositeScore: 82,
          chasingTelemetry: {
            orderId: 'c1',
            status: 'AMENDING',
            anchorMarkPrice: 145.5,
            currentLimitPrice: 145.51,
            spreadPennyJumps: 1,
            amendmentCount: 1,
            durationMs: 250,
            realizedFeeUsd: 0,
            feeSavedVsTakerUsd: 0,
          },
        })
      )
    ).toBe(true);
    // Still NOT written synchronously
    expect(ftRepo.listRecentEvents(0, 100, 0).length).toBe(countBeforeAmend);

    // 7. Throwing onTelemetryEvent must not crash recordFactorTelemetry
    expect(
      ngService.recordFactorTelemetry(
        makeEvent({
          eventId: 'err-cb-1',
          symbol: 'ERRUSDT',
          timestamp: t0 + 183_000,
          triggerType: 'POSITION_ENTERED',
          compositeScore: 85,
          chasingTelemetry: {
            orderId: 'c1',
            status: 'FILLED',
            anchorMarkPrice: 145.5,
            currentLimitPrice: 145.51,
            spreadPennyJumps: 1,
            amendmentCount: 1,
            durationMs: 300,
            realizedFeeUsd: 0.5,
            feeSavedVsTakerUsd: 1.2,
          },
        })
      )
    ).toBe(true);

    // Microtask flushes both amend-1 and terminal err-cb-1
    await new Promise((r) => setTimeout(r, 10));
    const eventsAfterMicrotask = ftRepo.listRecentEvents(0, 100, 0);
    expect(eventsAfterMicrotask.some((e) => e.eventId === 'amend-1')).toBe(true);
    expect(eventsAfterMicrotask.some((e) => e.eventId === 'err-cb-1')).toBe(true);
    expect(received.length).toBeGreaterThanOrEqual(6);

    ngService.dispose();
  });

  // Test 17: Ring-buffer overflow (550 ORDER_AMENDED + 1 POSITION_ENTERED into 500-cap buffer) & dispose flush
  it('17. evicts oldest non-terminal ORDER_AMENDED on overflow, preserves terminal events, and flushes on dispose()', () => {
    const ftRepo = new FactorTelemetryRecordsRepo(db);
    const ngService = new DecisionAuditService(db, undefined, {
      factorTelemetryRecordsRepo: ftRepo,
      flushIntervalMs: 60_000, // Long interval so only explicit flush/dispose writes
      maxRingBufferSize: 500,
    });

    const baseTs = 1_700_000_000_000;
    for (let i = 0; i < 550; i++) {
      ngService.recordFactorTelemetry({
        eventId: `amend-${i}`,
        timestamp: baseTs + i,
        symbol: 'SOLUSDT',
        triggerType: 'ORDER_AMENDED',
        markPrice: 145.5,
        compositeScore: 80,
        convictionArchetype: 'STANDARD_INSTITUTIONAL',
        consensusSide: 'BUY',
        noiseBandActive: false,
        macroVetoActive: false,
        activeFactors: [],
        collinearFactors: [],
        chasingTelemetry: {
          orderId: 'c-overflow',
          status: 'AMENDING',
          anchorMarkPrice: 145.5,
          currentLimitPrice: 145.5,
          spreadPennyJumps: 1,
          amendmentCount: i,
          durationMs: i * 10,
          realizedFeeUsd: 0,
          feeSavedVsTakerUsd: 0,
        },
      });
    }

    // Push terminal POSITION_ENTERED synchronously BEFORE microtask runs
    ngService.recordFactorTelemetry({
      eventId: 'terminal-entered-1',
      timestamp: baseTs + 600,
      symbol: 'SOLUSDT',
      triggerType: 'POSITION_ENTERED',
      markPrice: 145.5,
      compositeScore: 85,
      convictionArchetype: 'HIGH_CONVICTION_CORE',
      consensusSide: 'BUY',
      noiseBandActive: false,
      macroVetoActive: false,
      activeFactors: [],
      collinearFactors: [],
      chasingTelemetry: {
        orderId: 'c-overflow',
        status: 'FILLED',
        anchorMarkPrice: 145.5,
        currentLimitPrice: 145.49,
        spreadPennyJumps: 2,
        amendmentCount: 550,
        durationMs: 5500,
        realizedFeeUsd: 0.9,
        feeSavedVsTakerUsd: 1.5,
      },
    });

    // dispose() synchronously flushes remaining 500 buffered items to SQLite
    ngService.dispose();

    const stored = ftRepo.listRecentEvents(0, 600, 0);
    expect(stored).toHaveLength(500);
    expect(stored.some((e) => e.eventId === 'terminal-entered-1')).toBe(true);
    // Oldest ORDER_AMENDED items (amend-0 .. amend-50) were evicted
    expect(stored.some((e) => e.eventId === 'amend-0')).toBe(false);
    expect(stored.some((e) => e.eventId === 'amend-50')).toBe(false);
    expect(stored.some((e) => e.eventId === 'amend-51')).toBe(true);
    expect(stored.some((e) => e.eventId === 'amend-549')).toBe(true);

    // Also verify pruneExpiredImpulses removes old SUB_THRESHOLD_IMPULSE only
    const oldTs = Date.now() - 10 * 86_400_000;
    ftRepo.insertEventBatch({
      eventId: 'old-impulse-prune',
      timestamp: oldTs,
      symbol: 'SOLUSDT',
      triggerType: 'SUB_THRESHOLD_IMPULSE',
      markPrice: 100,
      compositeScore: 45,
      convictionArchetype: 'SUB_THRESHOLD',
      consensusSide: 'BUY',
      noiseBandActive: false,
      macroVetoActive: false,
      activeFactors: [],
      collinearFactors: [],
    });
    const pruned = ngService.pruneExpiredImpulses(7);
    expect(pruned).toBeGreaterThanOrEqual(1);
    const afterPrune = ftRepo.listRecentEvents(0, 600, 0);
    expect(afterPrune.some((e) => e.eventId === 'old-impulse-prune')).toBe(false);
    expect(afterPrune.some((e) => e.eventId === 'terminal-entered-1')).toBe(true);
  });

  // Test 18: Spearman IC, 1m/5m/15m/60m horizon settlement across 60-bar series & empirical IR
  it('18. computes exact Spearman IC (monotonic, inverted, ties, zero-variance) and settles 1m/5m/15m/60m horizons across 60 observations', () => {
    expect(computeSpearmanIC([1, 2, 3, 4, 5], [10, 20, 30, 40, 50])).toBeCloseTo(1.0, 6);
    expect(computeSpearmanIC([1, 2, 3, 4, 5], [50, 40, 30, 20, 10])).toBeCloseTo(-1.0, 6);
    expect(computeSpearmanIC([1], [10])).toBe(0);
    expect(computeSpearmanIC([0.5, 0.5, 0.5, 0.5], [1, 2, 3, 4])).toBe(0);
    // Tie-aware fractional ranking check
    const tieIc = computeSpearmanIC([10, 20, 20, 30], [1, 2, 3, 4]);
    expect(tieIc).toBeGreaterThan(0.9);
    expect(tieIc).toBeLessThanOrEqual(1.0);

    const ftRepo = new FactorTelemetryRecordsRepo(db);
    const ngService = new DecisionAuditService(db, undefined, {
      factorTelemetryRecordsRepo: ftRepo,
      flushIntervalMs: 0,
    });

    const baseTs = 1_700_000_000_000;
    for (let i = 1; i <= 60; i++) {
      const evTs = baseTs + i * 4_000_000;
      const alpha = i / 60;
      ftRepo.insertEventBatch({
        eventId: `evt-60-${i}`,
        timestamp: evTs,
        symbol: 'SOLUSDT',
        triggerType: 'SIGNAL_CONFIRMED',
        markPrice: 100,
        compositeScore: 80,
        convictionArchetype: 'HIGH_CONVICTION_CORE',
        consensusSide: 'BUY',
        noiseBandActive: false,
        macroVetoActive: false,
        activeFactors: [
          {
            factorId: 'ORDER_FLOW_L2',
            name: 'Order Flow L2',
            bias: 'BULLISH',
            rawAlpha: alpha,
            orthogonalAlpha: alpha,
            effectiveWeight: 0.6,
            isCollinear: false,
            confidence: 0.9,
            summaryText: 'Monotonic alpha',
          },
          {
            factorId: 'CONTRARIAN_FADE',
            name: 'Contrarian Fade',
            bias: 'BEARISH',
            rawAlpha: -alpha,
            orthogonalAlpha: -alpha,
            effectiveWeight: 0.3,
            isCollinear: false,
            confidence: 0.8,
            summaryText: 'Inverted alpha',
          },
          {
            factorId: 'CONST_FACTOR',
            name: 'Constant Factor',
            bias: 'BULLISH',
            rawAlpha: 0.5,
            orthogonalAlpha: 0.5,
            effectiveWeight: 0.1,
            isCollinear: false,
            confidence: 0.5,
            summaryText: 'Zero variance',
          },
        ],
        collinearFactors: [],
      });

      const stepPct = i * 0.001;
      const candleOffsets = [
        { dt: 60_000, high: 100 * (1 + stepPct * 0.25), low: 99.99 },
        { dt: 300_000, high: 100 * (1 + stepPct * 0.5), low: 99.98 },
        { dt: 900_000, high: 100 * (1 + stepPct * 0.75), low: 99.97 },
        { dt: 3_600_000, high: 100 * (1 + stepPct), low: 99.95 },
      ];
      for (const c of candleOffsets) {
        ngService.onCandleClose('SOLUSDT', {
          time: Math.floor((evTs + c.dt) / 1000),
          open: 100,
          high: c.high,
          low: c.low,
          close: c.high,
          volume: 1000,
        });
      }
    }

    expect(ftRepo.getPendingEvaluations('SOLUSDT')).toHaveLength(0);
    const settledFlow = ftRepo.getSettledByFactor('ORDER_FLOW_L2', 60);
    expect(settledFlow).toHaveLength(60);
    expect(settledFlow[0]!.post_1m_mfe).not.toBeNull();
    expect(settledFlow[0]!.post_5m_mfe).not.toBeNull();
    expect(settledFlow[0]!.post_15m_mfe).not.toBeNull();
    expect(settledFlow[0]!.post_1h_mfe).not.toBeNull();

    const summaryRes = ngService.generateSessionSummary(0);
    const attr = summaryRes.factor_attribution_summary!;
    const flowAttr = attr.find((a) => a.factorId === 'ORDER_FLOW_L2')!;
    const fadeAttr = attr.find((a) => a.factorId === 'CONTRARIAN_FADE')!;
    const constAttr = attr.find((a) => a.factorId === 'CONST_FACTOR')!;

    expect(flowAttr.sampleSize).toBe(60);
    expect(flowAttr.informationCoefficient).toBeCloseTo(1.0, 4);
    expect(flowAttr.informationRatio).toBeGreaterThan(1.0);
    expect(flowAttr.empiricalHitRate).toBe(1.0);

    expect(fadeAttr.informationCoefficient).toBeCloseTo(-1.0, 4);
    expect(fadeAttr.informationRatio).toBeLessThan(-1.0);
    expect(fadeAttr.empiricalHitRate).toBe(0);

    expect(constAttr.informationCoefficient).toBe(0);
    ngService.dispose();
  });

  // Test 19: Look-behind guard, INCOMPLETE_FEED on missed horizons past grace, and recoverDowntimeGaps for factor records
  it('19. prevents look-behind on prior candles, marks stale gaps INCOMPLETE_FEED, and settles/recovers pending factor records via recoverDowntimeGaps', async () => {
    const ftRepo = new FactorTelemetryRecordsRepo(db);
    const ngService = new DecisionAuditService(db, undefined, {
      factorTelemetryRecordsRepo: ftRepo,
      flushIntervalMs: 0,
      horizonGraceMs: 600_000,
    });

    const t0 = 1_700_000_000_000;
    ftRepo.insertEventBatch({
      eventId: 'evt-incomplete-1',
      timestamp: t0,
      symbol: 'SOLUSDT',
      triggerType: 'POSITION_ENTERED',
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
          rawAlpha: 0.7,
          orthogonalAlpha: 0.7,
          effectiveWeight: 1.0,
          isCollinear: false,
          confidence: 0.9,
          summaryText: 'Bid pressure',
        },
      ],
      collinearFactors: [],
    });

    // 1. Prior candle (before t0) MUST be ignored (zero look-behind)
    ngService.onCandleClose('SOLUSDT', {
      time: Math.floor((t0 - 60_000) / 1000),
      open: 100,
      high: 120,
      low: 80,
      close: 100,
      volume: 1000,
    });
    expect(ftRepo.getPendingEvaluations('SOLUSDT')).toHaveLength(1);
    expect(ftRepo.getPendingEvaluations('SOLUSDT')[0]!.post_1m_mfe).toBeNull();

    // 2. Candle arriving past 60m + grace (4,200,000 + 60,000) with unsettled intermediate horizons -> INCOMPLETE_FEED
    ngService.onCandleClose('SOLUSDT', {
      time: Math.floor((t0 + 3_600_000 + 600_000 + 60_000) / 1000),
      open: 100,
      high: 103,
      low: 99,
      close: 102,
      volume: 1000,
    });
    expect(ftRepo.getPendingEvaluations('SOLUSDT')).toHaveLength(0);
    const dbRowIncomplete = db
      .prepare("SELECT status FROM factor_telemetry_records WHERE event_id = 'evt-incomplete-1'")
      .get() as { status: string };
    expect(dbRowIncomplete.status).toBe('INCOMPLETE_FEED');

    // 3. Downtime recovery settles complete kline history and marks expired feed-error records INCOMPLETE_FEED
    const recentTs = Date.now() - 3_700_000;
    const expiredErrTs = Date.now() - 4_500_000;

    ftRepo.insertEventBatch({
      eventId: 'evt-recover-ok',
      timestamp: recentTs,
      symbol: 'SOLUSDT',
      triggerType: 'POSITION_ENTERED',
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
          orthogonalAlpha: 0.8,
          effectiveWeight: 1.0,
          isCollinear: false,
          confidence: 0.9,
          summaryText: 'Recovery ok',
        },
      ],
      collinearFactors: [],
    });

    ftRepo.insertEventBatch({
      eventId: 'evt-recover-err',
      timestamp: expiredErrTs,
      symbol: 'BTCUSDT',
      triggerType: 'SIGNAL_CONFIRMED',
      markPrice: 50000,
      compositeScore: 78,
      convictionArchetype: 'STANDARD_INSTITUTIONAL',
      consensusSide: 'BUY',
      noiseBandActive: false,
      macroVetoActive: false,
      activeFactors: [
        {
          factorId: 'ORDER_FLOW_L2',
          name: 'Order Flow L2',
          bias: 'BULLISH',
          rawAlpha: 0.6,
          orthogonalAlpha: 0.6,
          effectiveWeight: 1.0,
          isCollinear: false,
          confidence: 0.8,
          summaryText: 'Recovery err',
        },
      ],
      collinearFactors: [],
    });

    const mockClient = {
      getKlines: vi.fn(async (sym: string) => {
        if (sym === 'BTCUSDT') {
          throw new Error('Exchange feed unavailable');
        }
        return [
          [recentTs + 60_000, '100', '101', '99.5', '100.8', '100'],
          [recentTs + 300_000, '100.8', '102', '100', '101.5', '100'],
          [recentTs + 900_000, '101.5', '103', '101', '102.5', '100'],
          [recentTs + 3_600_000, '102.5', '105', '102', '104.5', '100'],
        ];
      }),
    } as any;

    await ngService.recoverDowntimeGaps(mockClient);

    expect(ftRepo.getPendingEvaluations()).toHaveLength(0);
    const recoveredRow = db
      .prepare("SELECT status, post_1h_mfe FROM factor_telemetry_records WHERE event_id = 'evt-recover-ok'")
      .get() as { status: string; post_1h_mfe: number };
    expect(recoveredRow.status).toBe('SETTLED');
    expect(recoveredRow.post_1h_mfe).toBeCloseTo(0.05, 4);

    const errRow = db
      .prepare("SELECT status FROM factor_telemetry_records WHERE event_id = 'evt-recover-err'")
      .get() as { status: string };
    expect(errRow.status).toBe('INCOMPLETE_FEED');
    ngService.dispose();
  });

  // Test 20: 300-row adversarial Markdown report clamped < 4,000 tokens (<= 14,000 chars) with Top 5 deep-dives & zero legacy tags
  it('20. clamps 300-row adversarial Markdown audit report strictly under 4,000 tokens (<= 14,000 chars) with Top 5 deep-dives', () => {
    const longError = 'ERR_EXCHANGE_TIMEOUT_'.repeat(25); // 525 chars
    const records: DecisionLogRecord[] = [];
    const baseTs = 1_700_000_000_000;

    for (let i = 0; i < 300; i++) {
      const isExecuted = i % 3 === 0;
      const isFailed = i % 10 === 1;
      records.push({
        id: `dec-adv-${i}`,
        timestamp: baseTs + i * 1000,
        symbol: i % 2 === 0 ? 'SOLUSDT' : 'BTCUSDT',
        side: i % 2 === 0 ? 'BUY' : 'SELL',
        action: isFailed ? 'FAILED' : isExecuted ? 'EXECUTED' : 'BLOCKED',
        composite_score: isExecuted ? 84 : 64,
        pillars_json: '[]',
        macro_regime: 'MACRO_BULLISH',
        macro_veto_active: !isExecuted && !isFailed ? 1 : 0,
        veto_reasons_json: !isExecuted && !isFailed ? '["MACRO_VETO"]' : null,
        execution_price: 145 + i * 0.01,
        margin_usd: 500,
        leverage: 10,
        atr: 1.5,
        trade_id: isExecuted ? `tr-${i}` : null,
        shadow_status: !isExecuted && !isFailed ? (i % 4 === 0 ? 'SAVED_CAPITAL' : 'MISSED_PROFIT') : null,
        shadow_sl: !isExecuted && !isFailed ? 140 : null,
        shadow_tp: !isExecuted && !isFailed ? 150 : null,
        shadow_pnl_usd: !isExecuted && !isFailed ? (i % 4 === 0 ? -25 - i * 0.1 : 10 + i * 0.2) : null,
        expires_at: baseTs + 3_600_000,
        shadow_closed_at: baseTs + 60_000,
        error_message: isFailed ? longError : null,
        created_at: baseTs + i * 1000,
        execution_chase_json: isExecuted
          ? JSON.stringify({
              orderId: `chase-${i}`,
              status: 'FILLED',
              anchorMarkPrice: 145.0,
              currentLimitPrice: 145.0 + (i % 7) * 0.05,
              spreadPennyJumps: 2,
              amendmentCount: 3,
              durationMs: 700,
              realizedFeeUsd: 0.8,
              feeSavedVsTakerUsd: 1.5 + (i % 5),
            })
          : null,
      });
    }

    const adversarialResponse: DailyAuditResponse = {
      date: '2026-11-25',
      summary: {
        total_setups: 300,
        executed_trades: 100,
        blocked_setups: 170,
        sub_threshold_impulses: 150,
        capital_saved_usd: 2500.5,
        missed_profit_usd: 900.25,
        expired_pnl_usd: 0,
        net_risk_value_usd: 1600.25,
        veto_breakdown: { MACRO_VETO: 170 },
        total_trades: 100,
        successful_trades: 68,
        failed_trades: 30,
        win_rate: 0.68,
        gross_pnl_usd: 3420.0,
        maker_fee_savings_usd: 280.4,
        net_pnl_usd: 3310.0,
      },
      records,
      factor_telemetry_events: Array.from({ length: 150 }, (_, idx) => ({
        eventId: `imp-adv-${idx}`,
        timestamp: baseTs + idx * 180_000,
        symbol: 'SOLUSDT',
        triggerType: 'SUB_THRESHOLD_IMPULSE' as const,
        markPrice: 145,
        compositeScore: 48,
        convictionArchetype: 'SUB_THRESHOLD' as const,
        consensusSide: 'NEUTRAL' as const,
        noiseBandActive: false,
        macroVetoActive: false,
        activeFactors: [],
        collinearFactors: [],
      })),
      factor_attribution_summary: [
        {
          factorId: 'ORDER_FLOW_L2',
          name: 'Order Flow L2',
          empiricalHitRate: 0.68,
          informationRatio: 1.82,
          informationCoefficient: 0.34,
          effectiveWeight: 0.546,
          sampleSize: 60,
        },
        {
          factorId: 'CVD_ABSORPTION',
          name: 'CVD Absorption',
          empiricalHitRate: 0.61,
          informationRatio: 1.15,
          informationCoefficient: 0.22,
          effectiveWeight: 0.307,
          sampleSize: 60,
        },
      ],
      execution_chase_summary: {
        totalFeeSavedUsd: 280.4,
        totalChases: 100,
        successfulChases: 96,
      },
      generated_at: baseTs,
    };

    const md = service.formatMarkdownReport(adversarialResponse);
    expect(estimateTokenCount(md)).toBeLessThan(4000);
    expect(md.length).toBeLessThanOrEqual(14_000);
    expect(md).toContain('# TradeOS Daily Decision Audit & Shadow Report');
    expect(md).toContain('Orthogonal Factor Attribution Matrix');
    expect(md).toContain('Trade Execution Attribution');
    expect(md).toContain('Top 5');
    expect(md).not.toContain('Sub-Threshold Market Impulses');
    expect(md).not.toMatch(/\bP[1-7]:/);

    // Pure helper clamping check on huge synthetic input
    const huge = '# Huge Report\n' + 'Line with telemetry payload data and metrics.\n'.repeat(600);
    const clamped = clampMarkdownToTokenBudget(huge, 4000);
    expect(estimateTokenCount(clamped)).toBeLessThan(4000);
    expect(clamped.length).toBeLessThanOrEqual(14_000);
  });
});
