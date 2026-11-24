import { describe, it, expect } from 'vitest';
import type {
  ShadowSetupStatus,
  DecisionAction,
  DecisionLogRecord,
  DailyAuditSummary,
  DailyAuditResponse,
  TradeSide,
  MacroRegime,
  FactorTelemetryEvent,
  FactorStateDetail,
  ChasingTelemetrySnapshot,
  SizingTelemetrySnapshot,
  FactorAttributionSummaryItem,
  FactorTelemetryDbRecord,
  WsServerMessage,
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

  it('supports Next-Gen JSON telemetry columns on DecisionLogRecord and attribution fields on DailyAuditResponse', () => {
    const factorDetail: FactorStateDetail = {
      factorId: 'ORDER_FLOW_L2',
      name: 'Order Flow L2',
      bias: 'BULLISH',
      rawAlpha: 0.78,
      orthogonalAlpha: 0.72,
      effectiveWeight: 0.546,
      isCollinear: false,
      confidence: 0.91,
      summaryText: 'Depth Imbalance 1.8x Bid',
    };
    const chasingTelemetry: ChasingTelemetrySnapshot = {
      orderId: 'chase-1',
      status: 'FILLED',
      anchorMarkPrice: 145.5,
      currentLimitPrice: 145.48,
      spreadPennyJumps: 2,
      amendmentCount: 2,
      durationMs: 840,
      realizedFeeUsd: 0.95,
      feeSavedVsTakerUsd: 1.42,
    };
    const sizingTelemetry: SizingTelemetrySnapshot = {
      allocatedMarginUsd: 1200,
      allocatedMarginPct: 25.0,
      baseConvictionMargin: 0.21,
      quarterKellyMultiplier: 0.85,
      volatilityParityMultiplier: 1.1,
      circuitBreakerMultiplier: 1.0,
      solvencyAirbagOk: true,
    };
    const telemetryEvent: FactorTelemetryEvent = {
      timestamp: 1700000000000,
      symbol: 'SOLUSDT',
      triggerType: 'POSITION_ENTERED',
      markPrice: 145.5,
      compositeScore: 84,
      convictionArchetype: 'HIGH_CONVICTION_CORE',
      consensusSide: 'BUY',
      noiseBandActive: false,
      macroVetoActive: false,
      activeFactors: [factorDetail],
      collinearFactors: ['NATIVE_SMC', 'MACRO_REGIME'],
      chasingTelemetry,
      sizingTelemetry,
    };

    const wsMsg: WsServerMessage = { type: 'FACTOR_TELEMETRY', data: telemetryEvent };
    expect(wsMsg.type).toBe('FACTOR_TELEMETRY');
    expect(wsMsg.data.collinearFactors).toContain('NATIVE_SMC');

    const upgradedRecord: DecisionLogRecord = {
      id: 'dec-ng-1',
      timestamp: 1700000000000,
      symbol: 'SOLUSDT',
      side: 'BUY',
      action: 'EXECUTED',
      composite_score: 84,
      pillars_json: '[]',
      macro_regime: 'MACRO_BULLISH',
      macro_veto_active: 0,
      veto_reasons_json: null,
      execution_price: 145.48,
      margin_usd: 1200,
      leverage: 10,
      atr: 1.4,
      trade_id: 'tr-1',
      shadow_status: null,
      shadow_sl: null,
      shadow_tp: null,
      shadow_pnl_usd: null,
      expires_at: null,
      shadow_closed_at: null,
      error_message: null,
      created_at: 1700000000000,
      factor_telemetry_json: JSON.stringify(telemetryEvent.activeFactors),
      execution_chase_json: JSON.stringify(telemetryEvent.chasingTelemetry),
      sizing_breakdown_json: JSON.stringify(telemetryEvent.sizingTelemetry),
      noise_band_state: 0,
    };
    expect(upgradedRecord.noise_band_state).toBe(0);
    expect(upgradedRecord.factor_telemetry_json).toContain('ORDER_FLOW_L2');

    const attributionItem: FactorAttributionSummaryItem = {
      factorId: 'ORDER_FLOW_L2',
      name: 'Order Flow L2',
      empiricalHitRate: 0.65,
      informationRatio: 1.82,
      informationCoefficient: 0.34,
      effectiveWeight: 0.546,
      sampleSize: 60,
    };

    const summary: DailyAuditSummary = {
      total_setups: 5,
      executed_trades: 2,
      blocked_setups: 3,
      capital_saved_usd: 420.0,
      missed_profit_usd: 80.0,
      expired_pnl_usd: 0,
      net_risk_value_usd: 340.0,
      veto_breakdown: { NOISE_BAND: 2 },
      total_trades: 2,
      successful_trades: 2,
      failed_trades: 0,
      win_rate: 1.0,
      gross_pnl_usd: 185.0,
      maker_fee_savings_usd: 3.8,
      net_pnl_usd: 181.2,
    };

    const response: DailyAuditResponse = {
      date: '2026-11-25',
      summary,
      records: [upgradedRecord],
      factor_telemetry_events: [telemetryEvent],
      factor_attribution_summary: [attributionItem],
      execution_chase_summary: {
        totalFeeSavedUsd: 3.8,
        totalChases: 2,
        successfulChases: 2,
      },
      generated_at: 1700000000000,
    };
    expect(response.date).toBe('2026-11-25');
    expect(response.factor_telemetry_events).toHaveLength(1);
    expect(response.factor_attribution_summary?.[0].informationRatio).toBe(1.82);
    expect(response.execution_chase_summary?.successfulChases).toBe(2);

    const dbRecord: FactorTelemetryDbRecord = {
      decision_log_id: 'dec-ng-1',
      event_id: 'evt-1',
      trigger_type: 'POSITION_ENTERED',
      timestamp: 1700000000000,
      symbol: 'SOLUSDT',
      consensus_side: 'BUY',
      entry_price: 145.48,
      composite_score: 84,
      factor_id: 'ORDER_FLOW_L2',
      raw_alpha: 0.78,
      orthogonal_alpha: 0.72,
      effective_weight: 0.546,
      is_collinear: 0,
      confidence: 0.91,
      summary_text: 'Depth Imbalance 1.8x Bid',
      telemetry_payload_json: JSON.stringify(telemetryEvent),
      status: 'SETTLED',
      settle_timestamp: 1700003600000,
      post_1m_mfe: 0.25,
      post_1m_mae: -0.05,
      post_5m_mfe: 0.6,
      post_5m_mae: -0.1,
      post_15m_mfe: 1.2,
      post_15m_mae: -0.15,
      post_1h_mfe: 2.1,
      post_1h_mae: -0.2,
    };
    expect(dbRecord.status).toBe('SETTLED');
    expect(dbRecord.post_1h_mfe).toBe(2.1);
  });
});
