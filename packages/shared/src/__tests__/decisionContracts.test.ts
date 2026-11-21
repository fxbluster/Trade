import { describe, it, expect } from 'vitest';
import type {
  ShadowSetupStatus,
  DecisionAction,
  DecisionLogRecord,
  DailyAuditSummary,
  DailyAuditResponse,
  TradeSide,
  MacroRegime,
} from '../contracts.js';

describe('TradeOS v2 — Decision & Audit Contracts (@tradeos/shared)', () => {
  it('validates ShadowSetupStatus enum values', () => {
    const statuses: ShadowSetupStatus[] = [
      'OPEN',
      'SAVED_CAPITAL',
      'MISSED_PROFIT',
      'EXPIRED',
      'RESOLVED_AMBIGUOUS_VOLATILITY',
    ];
    expect(statuses).toHaveLength(5);
    expect(statuses).toContain('OPEN');
    expect(statuses).toContain('SAVED_CAPITAL');
    expect(statuses).toContain('MISSED_PROFIT');
    expect(statuses).toContain('EXPIRED');
    expect(statuses).toContain('RESOLVED_AMBIGUOUS_VOLATILITY');
  });

  it('validates DecisionAction enum values', () => {
    const actions: DecisionAction[] = ['EXECUTED', 'BLOCKED', 'FAILED'];
    expect(actions).toHaveLength(3);
    expect(actions).toContain('EXECUTED');
    expect(actions).toContain('BLOCKED');
    expect(actions).toContain('FAILED');
  });

  it('instantiates valid DecisionLogRecord with all fields', () => {
    const side: TradeSide = 'BUY';
    const regime: MacroRegime = 'MACRO_BULLISH';
    const action: DecisionAction = 'BLOCKED';
    const shadowStatus: ShadowSetupStatus = 'OPEN';

    const record: DecisionLogRecord = {
      id: 'dec-uuid-1',
      timestamp: 1700000000000,
      symbol: 'SOLUSDT',
      side,
      action,
      composite_score: 72.5,
      pillars_json: JSON.stringify({ MACRO_REGIME: { score: 80, bias: 'BULLISH' } }),
      macro_regime: regime,
      macro_veto_active: 1,
      veto_reasons_json: JSON.stringify(['MACRO_VETO_BELOW_EMA200']),
      execution_price: 150.25,
      margin_usd: 500,
      leverage: 10,
      atr: 2.35,
      trade_id: null,
      shadow_status: shadowStatus,
      shadow_sl: 145.5,
      shadow_tp: 159.75,
      shadow_pnl_usd: null,
      expires_at: 1700003600000,
      shadow_closed_at: null,
      error_message: null,
      created_at: 1700000000000,
    };

    expect(record.id).toBe('dec-uuid-1');
    expect(record.side).toBe('BUY');
    expect(record.action).toBe('BLOCKED');
    expect(record.macro_veto_active).toBe(1);
    expect(record.shadow_status).toBe('OPEN');
    expect(record.shadow_sl).toBe(145.5);
    expect(record.shadow_tp).toBe(159.75);
    expect(record.trade_id).toBeNull();
  });

  it('instantiates valid DailyAuditSummary and DailyAuditResponse', () => {
    const summary: DailyAuditSummary = {
      total_setups: 10,
      executed_trades: 4,
      blocked_setups: 6,
      capital_saved_usd: 1250.5,
      missed_profit_usd: 320.0,
      expired_pnl_usd: -15.2,
      net_risk_value_usd: 915.3,
      veto_breakdown: {
        MACRO_VETO_BELOW_EMA200: 4,
        RVOL_TOO_LOW: 2,
      },
    };

    expect(summary.total_setups).toBe(10);
    expect(summary.capital_saved_usd).toBe(1250.5);
    expect(summary.veto_breakdown['MACRO_VETO_BELOW_EMA200']).toBe(4);

    const response: DailyAuditResponse = {
      summary,
      records: [],
      generated_at: 1700000000000,
    };

    expect(response.records).toEqual([]);
    expect(response.generated_at).toBe(1700000000000);
    expect(response.summary.total_setups).toBe(10);
  });
});
