import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import type {
  FactorOutput,
  FactorEvaluationContext,
  DepthLevel,
  AlphaFactorMetadata,
  AlphaFactorCategory,
  ChasingOrderState,
  ChasingStatus,
  SizingBreakdown,
  SizingArchetype,
  NoiseBandTelemetry,
  BlockReason,
  ExitReason,
  AutoPilotState,
  TradeSide,
  QuantConvictionArchetype,
  FactorStateDetail,
  ChasingTelemetrySnapshot,
  SizingTelemetrySnapshot,
  FactorTelemetryTriggerType,
  FactorTelemetryEvent,
  FactorAttributionSummaryItem,
  FactorTelemetryRecordStatus,
  FactorTelemetryDbRecord,
  ConfluenceSnapshot,
  WsServerMessage,
} from '../contracts.js';
import type {
  QuantConvictionArchetype as IndexQuantConvictionArchetype,
  FactorTelemetryEvent as IndexFactorTelemetryEvent,
  FactorAttributionSummaryItem as IndexFactorAttributionSummaryItem,
  FactorTelemetryDbRecord as IndexFactorTelemetryDbRecord,
} from '../index.js';

describe('TradeOS Next-Gen Modular Quant Architecture Contracts (@tradeos/shared)', () => {
  it('instantiates valid FactorOutput with bounded rawAlpha and confidence', () => {
    const factor: FactorOutput = {
      factorId: 'ORDER_FLOW_L2',
      bias: 'BULLISH',
      rawAlpha: 0.85,
      confidence: 0.92,
      uncertainty: 0.08,
      halfLifeMs: 60000,
      metadata: {
        depthRatio: 1.84,
        takerImbalance: 2.1,
      },
    };

    expect(factor.factorId).toBe('ORDER_FLOW_L2');
    expect(factor.bias).toBe('BULLISH');
    expect(factor.rawAlpha).toBeGreaterThanOrEqual(-1.0);
    expect(factor.rawAlpha).toBeLessThanOrEqual(1.0);
    expect(factor.confidence).toBeGreaterThanOrEqual(0.0);
    expect(factor.confidence).toBeLessThanOrEqual(1.0);
    expect(factor.uncertainty).toBe(0.08);
    expect(factor.halfLifeMs).toBe(60000);
    expect(factor.metadata.depthRatio).toBe(1.84);

    // Boundary check for rawAlpha and confidence
    const minFactor: FactorOutput = {
      factorId: 'BEARISH_PROBE',
      bias: 'BEARISH',
      rawAlpha: -1.0,
      confidence: 0.0,
      uncertainty: 0.5,
      halfLifeMs: 30000,
      metadata: {},
    };
    expect(minFactor.rawAlpha).toBe(-1.0);
    expect(minFactor.confidence).toBe(0.0);

    const neutralFactor: FactorOutput = {
      factorId: 'CHOP_FILTER',
      bias: 'NEUTRAL',
      rawAlpha: 0.0,
      confidence: 0.5,
      uncertainty: 0.25,
      halfLifeMs: 120000,
      metadata: {},
    };
    expect(neutralFactor.bias).toBe('NEUTRAL');
    expect(neutralFactor.rawAlpha).toBe(0.0);
  });

  it('instantiates valid FactorEvaluationContext with optional depth and cvd', () => {
    const depthLevel: DepthLevel = { price: 64250.5, qty: 12.45 };
    expect(depthLevel.price).toBe(64250.5);
    expect(depthLevel.qty).toBe(12.45);

    const context: FactorEvaluationContext = {
      symbol: 'BTCUSDT',
      currentPrice: 64250.0,
      depth: {
        bids: [{ price: 64249.5, qty: 15.2 }],
        asks: [{ price: 64250.5, qty: 10.8 }],
      },
      candles: [
        {
          time: 1700000000,
          open: 64200,
          high: 64280,
          low: 64190,
          close: 64250,
          volume: 245.5,
        },
      ],
      timestamp: 1700000000000,
    };

    expect(context.symbol).toBe('BTCUSDT');
    expect(context.currentPrice).toBe(64250.0);
    expect(context.depth?.bids).toHaveLength(1);
    expect(context.depth?.asks).toHaveLength(1);
    expect(context.candles).toHaveLength(1);
    expect(context.timestamp).toBe(1700000000000);
  });

  it('validates AlphaFactorMetadata and category categories', () => {
    const categories: AlphaFactorCategory[] = [
      'MICROSTRUCTURE',
      'STRUCTURE',
      'MOMENTUM',
      'ARBITRAGE',
      'VOLATILITY',
    ];
    expect(categories).toHaveLength(5);

    const metadata: AlphaFactorMetadata = {
      id: 'NATIVE_SMC',
      name: 'Smart Money Concepts',
      category: 'STRUCTURE',
      defaultWeight: 0.2,
      currentWeight: 0.22,
      hitRate: 0.68,
      sharpeRatio: 2.15,
      isDecayed: false,
    };

    expect(metadata.id).toBe('NATIVE_SMC');
    expect(metadata.name).toBe('Smart Money Concepts');
    expect(metadata.category).toBe('STRUCTURE');
    expect(metadata.defaultWeight).toBe(0.2);
    expect(metadata.currentWeight).toBe(0.22);
    expect(metadata.hitRate).toBe(0.68);
    expect(metadata.sharpeRatio).toBe(2.15);
    expect(metadata.isDecayed).toBe(false);
  });

  it('instantiates valid ChasingOrderState across all statuses', () => {
    const statuses: ChasingStatus[] = [
      'IDLE',
      'PENDING',
      'CHASING',
      'AMENDING',
      'FILLED',
      'CANCELLED',
      'TIMEOUT',
      'FAILED',
    ];
    expect(statuses).toHaveLength(8);

    const side: TradeSide = 'BUY';
    const activeChasing: ChasingOrderState = {
      active: true,
      orderId: 'binance-chase-9872',
      symbol: 'SOLUSDT',
      side,
      anchorPrice: 154.2,
      currentLimitPrice: 154.22,
      amendCount: 3,
      startTime: 1700000000000,
      timeoutMs: 15000,
      status: 'CHASING',
      feeSavedUsd: 1.42,
    };

    expect(activeChasing.active).toBe(true);
    expect(activeChasing.orderId).toBe('binance-chase-9872');
    expect(activeChasing.symbol).toBe('SOLUSDT');
    expect(activeChasing.side).toBe('BUY');
    expect(activeChasing.anchorPrice).toBe(154.2);
    expect(activeChasing.currentLimitPrice).toBe(154.22);
    expect(activeChasing.amendCount).toBe(3);
    expect(activeChasing.timeoutMs).toBe(15000);
    expect(activeChasing.status).toBe('CHASING');
    expect(activeChasing.feeSavedUsd).toBe(1.42);

    const idleChasing: ChasingOrderState = {
      active: false,
      orderId: null,
      symbol: 'BTCUSDT',
      side: 'SELL',
      anchorPrice: 0,
      currentLimitPrice: 0,
      amendCount: 0,
      startTime: 0,
      timeoutMs: 15000,
      status: 'IDLE',
      feeSavedUsd: 0,
    };
    expect(idleChasing.active).toBe(false);
    expect(idleChasing.orderId).toBeNull();
  });

  it('instantiates valid SizingBreakdown with convex archetype clamping', () => {
    const archetypes: SizingArchetype[] = [
      'Sub-Threshold',
      'Exploratory Probe',
      'Standard Institutional',
      'High-Conviction Core',
      'A+ Institutional Setup',
    ];
    expect(archetypes).toHaveLength(5);

    const breakdown: SizingBreakdown = {
      confluenceScore: 92,
      archetype: 'A+ Institutional Setup',
      rawMarginPct: 0.265,
      kellyDampener: 0.85,
      volatilityParity: 1.05,
      circuitMultiplier: 1.0,
      finalMarginPct: 0.236,
      marginUsd: 1180.0,
      notionalUsd: 11800.0,
      solvencyAirbagOk: true,
    };

    expect(breakdown.confluenceScore).toBe(92);
    expect(breakdown.archetype).toBe('A+ Institutional Setup');
    expect(breakdown.rawMarginPct).toBe(0.265);
    expect(breakdown.kellyDampener).toBe(0.85);
    expect(breakdown.volatilityParity).toBe(1.05);
    expect(breakdown.circuitMultiplier).toBe(1.0);
    expect(breakdown.finalMarginPct).toBe(0.236);
    expect(breakdown.marginUsd).toBe(1180.0);
    expect(breakdown.notionalUsd).toBe(11800.0);
    expect(breakdown.solvencyAirbagOk).toBe(true);
  });

  it('instantiates valid NoiseBandTelemetry with ATR and VWAP metrics', () => {
    const noiseTelemetry: NoiseBandTelemetry = {
      active: true,
      currentTrueRange15m: 0.18,
      meanTrueRange20d: 0.22,
      noiseThreshold: 0.275,
      isNoise: true,
      currentPrice: 73.0,
      vwap: 73.05,
      vwapDistancePct: 0.068,
    };

    expect(noiseTelemetry.active).toBe(true);
    expect(noiseTelemetry.currentTrueRange15m).toBe(0.18);
    expect(noiseTelemetry.meanTrueRange20d).toBe(0.22);
    expect(noiseTelemetry.noiseThreshold).toBe(0.275);
    expect(noiseTelemetry.isNoise).toBe(true);
    expect(noiseTelemetry.currentPrice).toBe(73.0);
    expect(noiseTelemetry.vwap).toBe(73.05);
    expect(noiseTelemetry.vwapDistancePct).toBe(0.068);
  });

  it('validates extended BlockReason, ExitReason, and AutoPilotState variants', () => {
    const blockReasons: BlockReason[] = [
      'BLOCKED_NOISE_BAND',
      'BLOCKED_EVENT_BLACKOUT',
      'BLOCKED_SESSION_TRADE_CAP',
      'BLOCKED_CHASING_TIMEOUT',
      'BLOCKED_AIRBAG_VIOLATION',
      'BLOCKED_DAILY_MAX_LOSS',
      'BLOCKED_MACRO_VETO',
    ];
    expect(blockReasons).toContain('BLOCKED_NOISE_BAND');
    expect(blockReasons).toContain('BLOCKED_EVENT_BLACKOUT');
    expect(blockReasons).toContain('BLOCKED_SESSION_TRADE_CAP');
    expect(blockReasons).toContain('BLOCKED_CHASING_TIMEOUT');
    expect(blockReasons).toContain('BLOCKED_AIRBAG_VIOLATION');

    const exitReasons: ExitReason[] = [
      'STOP_LOSS',
      'TAKE_PROFIT_1',
      'TAKE_PROFIT_2',
      'BREAKEVEN',
      'TRAILING_GIVEBACK_HALF',
      'OPPOSITE_CONFLUENCE_REVERSAL',
      'MANUAL_CLOSE',
      'EVENT_BLACKOUT_UNWIND',
    ];
    expect(exitReasons).toContain('TRAILING_GIVEBACK_HALF');
    expect(exitReasons).toContain('EVENT_BLACKOUT_UNWIND');

    const autoPilotStates: AutoPilotState[] = [
      'IDLE',
      'EVALUATING',
      'PLACING_ORDER',
      'LIMIT_CHASING',
      'POSITION_OPEN',
      'CLOSING',
      'COOLDOWN_ACTIVE',
      'BLOCKED_SESSION_TRADE_CAP',
    ];
    expect(autoPilotStates).toContain('LIMIT_CHASING');
  });

  it('guarantees ZERO Node.js native dependencies in @tradeos/shared to preserve browser bundling', () => {
    // Resolve src directory of packages/shared
    const srcDir = path.resolve(__dirname, '..');
    const sourceFiles = fs
      .readdirSync(srcDir)
      .filter((file) => file.endsWith('.ts') && !file.includes('.test.'));

    expect(sourceFiles.length).toBeGreaterThan(0);

    const forbiddenImports = [
      'node:sqlite',
      'node:fs',
      'node:path',
      'node:crypto',
      'node:os',
      'node:child_process',
      'node:worker_threads',
      'node:stream',
      'node:events',
      'node:buffer',
      'node:net',
      'node:http',
      'node:https',
    ];

    for (const file of sourceFiles) {
      const fullPath = path.join(srcDir, file);
      const content = fs.readFileSync(fullPath, 'utf-8');

      // Check for 'node:' protocol imports
      for (const forbidden of forbiddenImports) {
        expect(
          content.includes(forbidden),
          `File ${file} must not contain native import ${forbidden}`
        ).toBe(false);
      }

      // Check regex for any node: prefix
      const nodeMatch = content.match(/from\s+['"]node:([^'"]+)['"]/);
      expect(
        nodeMatch,
        `File ${file} contains node:* import: ${nodeMatch?.[0]}`
      ).toBeNull();
    }
  });

  it('instantiates Next-Gen FactorTelemetryEvent, FactorStateDetail, Chasing/Sizing snapshots, ConfluenceSnapshot.telemetryEvent, and WsServerMessage FACTOR_TELEMETRY', () => {
    const archetypes: QuantConvictionArchetype[] = [
      'SUB_THRESHOLD',
      'EXPLORATORY_PROBE',
      'STANDARD_INSTITUTIONAL',
      'HIGH_CONVICTION_CORE',
      'A_PLUS_INSTITUTIONAL',
    ];
    expect(archetypes).toHaveLength(5);

    const triggerTypes: FactorTelemetryTriggerType[] = [
      'SUB_THRESHOLD_IMPULSE',
      'SIGNAL_CONFIRMED',
      'ORDER_AMENDED',
      'POSITION_ENTERED',
      'POSITION_EXITED',
    ];
    expect(triggerTypes).toHaveLength(5);

    const statuses: FactorTelemetryRecordStatus[] = [
      'EVALUATING',
      'SETTLED',
      'INCOMPLETE_FEED',
    ];
    expect(statuses).toHaveLength(3);

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

    const snapshot: ConfluenceSnapshot = {
      symbol: 'SOLUSDT',
      pillars: [],
      bullishCount: 4,
      bearishCount: 1,
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
      telemetryEvent,
    };
    expect(snapshot.telemetryEvent?.convictionArchetype).toBe('HIGH_CONVICTION_CORE');

    const wsMsg: WsServerMessage = {
      type: 'FACTOR_TELEMETRY',
      data: telemetryEvent,
    };
    expect(wsMsg.type).toBe('FACTOR_TELEMETRY');
    if (wsMsg.type === 'FACTOR_TELEMETRY') {
      expect(wsMsg.data.activeFactors[0].factorId).toBe('ORDER_FLOW_L2');
      expect(wsMsg.data.chasingTelemetry?.feeSavedVsTakerUsd).toBe(1.42);
      expect(wsMsg.data.sizingTelemetry?.solvencyAirbagOk).toBe(true);
    }

    // Verify index.ts re-exports match contracts.ts
    const idxArchetype: IndexQuantConvictionArchetype = telemetryEvent.convictionArchetype;
    const idxEvent: IndexFactorTelemetryEvent = telemetryEvent;
    const idxAttr: IndexFactorAttributionSummaryItem = {
      factorId: 'ORDER_FLOW_L2',
      name: 'Order Flow L2',
      empiricalHitRate: 0.64,
      informationRatio: 1.82,
      informationCoefficient: 0.31,
      effectiveWeight: 0.546,
      sampleSize: 45,
    };
    const idxDbRecord: IndexFactorTelemetryDbRecord = {
      id: 1,
      decision_log_id: null,
      event_id: 'evt-1',
      trigger_type: 'SUB_THRESHOLD_IMPULSE',
      timestamp: 1700000000000,
      symbol: 'SOLUSDT',
      consensus_side: 'NEUTRAL',
      entry_price: 145.5,
      composite_score: 52,
      factor_id: 'ORDER_FLOW_L2',
      raw_alpha: 0.4,
      orthogonal_alpha: 0.38,
      effective_weight: 0.3,
      is_collinear: 0,
      confidence: 0.8,
      summary_text: 'Depth Imbalance 1.3x Bid',
      telemetry_payload_json: JSON.stringify(telemetryEvent),
      status: 'EVALUATING',
      settle_timestamp: null,
      post_1m_mfe: null,
      post_1m_mae: null,
      post_5m_mfe: null,
      post_5m_mae: null,
      post_15m_mfe: null,
      post_15m_mae: null,
      post_1h_mfe: null,
      post_1h_mae: null,
    };
    const dbRec: FactorTelemetryDbRecord = idxDbRecord;
    const attrItem: FactorAttributionSummaryItem = idxAttr;
    expect(idxArchetype).toBe('HIGH_CONVICTION_CORE');
    expect(idxEvent.symbol).toBe('SOLUSDT');
    expect(attrItem.sampleSize).toBe(45);
    expect(dbRec.status).toBe('EVALUATING');
  });
});
