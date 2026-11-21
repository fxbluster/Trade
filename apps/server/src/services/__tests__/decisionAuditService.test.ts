import { describe, it, expect, beforeEach, vi } from 'vitest';
import { initializeDatabase, DecisionLogsRepo, TradesRepo } from '../../db/sqlite.js';
import { DecisionAuditService } from '../decisionAuditService.js';
import type { ConfluenceSnapshot, KlineCandle, TradeRecord } from '@tradeos/shared';

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
});
