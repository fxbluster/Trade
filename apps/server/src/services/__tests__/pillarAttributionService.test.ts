import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { initializeDatabase, PillarTelemetryRepo } from '../../db/sqlite.js';
import { PillarAttributionService } from '../pillarAttributionService.js';
import type {
  ConfluenceSnapshot,
  KlineCandle,
  PillarEvaluation,
  ConfluencePillarId,
} from '@tradeos/shared';

describe('PillarAttributionService — Bulldog Quantitative Engine', () => {
  let db: DatabaseSync;
  let repo: PillarTelemetryRepo;
  let service: PillarAttributionService;

  beforeEach(() => {
    db = initializeDatabase(':memory:');
    repo = new PillarTelemetryRepo(db);
    // Disable automatic background timer during unit tests by passing flushIntervalMs: 0
    service = new PillarAttributionService(repo, { flushIntervalMs: 0 });
  });

  afterEach(() => {
    service.destroy();
  });

  const createDummyPillars = (
    overrides: Partial<Record<ConfluencePillarId, { bias: 'BULLISH' | 'BEARISH' | 'NEUTRAL'; score: number }>> = {}
  ): PillarEvaluation[] => {
    const defaultPillars: Array<{ id: ConfluencePillarId; title: string }> = [
      { id: 'MACRO_REGIME', title: 'Macro Regime' },
      { id: 'NATIVE_SMC', title: 'Native SMC' },
      { id: 'CVD_ABSORPTION', title: 'CVD Absorption' },
      { id: 'ORDER_FLOW_L2', title: 'Order Flow L2' },
      { id: 'LIQ_CLUSTERS', title: 'Liquidity Clusters' },
      { id: 'MOMENTUM_RVOL', title: 'Momentum & rVol' },
      { id: 'SENTIMENT_MACRO', title: 'Macro Sentiment' },
    ];

    return defaultPillars.map((p) => {
      const custom = overrides[p.id];
      return {
        id: p.id,
        title: p.title,
        score: custom?.score ?? 50,
        bias: custom?.bias ?? 'NEUTRAL',
        valueText: custom?.bias ?? 'NEUTRAL',
        subText: 'ok',
        confirmed: custom ? custom.bias !== 'NEUTRAL' : false,
        updatedAt: Date.now(),
      };
    });
  };

  const createDummySnapshot = (
    pillarOverrides: Partial<Record<ConfluencePillarId, { bias: 'BULLISH' | 'BEARISH' | 'NEUTRAL'; score: number }>> = {},
    compositeScore: number = 48
  ): ConfluenceSnapshot => ({
    symbol: 'SOLUSDT',
    pillars: createDummyPillars(pillarOverrides),
    bullishCount: 2,
    bearishCount: 0,
    neutralCount: 5,
    consensusBias: 'NEUTRAL',
    consensusMet: false,
    threshold: 4,
    compositeScore,
    recommendedAction: 'WAIT',
    macroVetoActive: false,
    macroRegime: 'MACRO_RANGING',
    activeFvgs: [],
    activeOrderBlocks: [],
    latestSweep: null,
  });

  // 1. In-memory ring-buffer queue and zero synchronous SQLite I/O on hot tick
  describe('1. In-Memory Ring Buffer & Zero-Lock Decoupling', () => {
    it('pushes events to in-memory queue without synchronous SQLite writes until flushed', () => {
      const snapshot = createDummySnapshot({
        MOMENTUM_RVOL: { bias: 'BULLISH', score: 80 },
      });

      // evaluateTick on hot loop
      service.evaluateTick('SOLUSDT', 150.0, 2.0, snapshot);

      // Verify ZERO SQLite I/O
      expect(repo.getOpenEvents()).toHaveLength(0);
      expect(service.getQueueLength()).toBe(1);

      // Flush queue
      const ids = service.flush();
      expect(ids).toHaveLength(1);
      expect(service.getQueueLength()).toBe(0);

      // Now event is in SQLite
      const openEvents = repo.getOpenEvents('SOLUSDT');
      expect(openEvents).toHaveLength(1);
      expect(openEvents[0].symbol).toBe('SOLUSDT');
      expect(openEvents[0].p6_vote).toBe('BUY');
      expect(openEvents[0].consensus_side).toBe('BUY');
      expect(openEvents[0].trigger_type).toBe('PILLAR_DIVERGENCE');
    });

    it('enforces ring buffer ceiling and drops oldest record when capacity exceeded', () => {
      const smallQueueService = new PillarAttributionService(repo, {
        flushIntervalMs: 0,
        maxQueueSize: 3,
      });

      for (let i = 1; i <= 5; i++) {
        // Change vote each tick to force transition
        const bias = i % 2 === 0 ? 'BULLISH' : 'BEARISH';
        const snapshot = createDummySnapshot({
          MOMENTUM_RVOL: { bias, score: 70 },
        });
        smallQueueService.evaluateTick('SOLUSDT', 150 + i, 2.0, snapshot);
      }

      // Max capacity is 3
      expect(smallQueueService.getQueueLength()).toBe(3);
      smallQueueService.destroy();
    });
  });

  // 2. Per-pillar debouncing and 10s coalescing window on impulses
  describe('2. Per-Pillar State Tracking & 10s Coalescing Window', () => {
    it('coalesces confirming indicator transitions within 10s into a single event', () => {
      const now = Date.now();
      vi.spyOn(Date, 'now').mockReturnValue(now);

      // T0: Momentum & rVol fires BUY
      const snap1 = createDummySnapshot({
        MOMENTUM_RVOL: { bias: 'BULLISH', score: 80 },
      });
      service.evaluateTick('SOLUSDT', 150.0, 2.0, snap1);
      expect(service.getQueueLength()).toBe(1);

      // T0 + 4s: Sentiment Macro confirms with BUY (same direction)
      vi.spyOn(Date, 'now').mockReturnValue(now + 4000);
      const snap2 = createDummySnapshot({
        MOMENTUM_RVOL: { bias: 'BULLISH', score: 80 },
        SENTIMENT_MACRO: { bias: 'BULLISH', score: 75 },
      });
      service.evaluateTick('SOLUSDT', 150.5, 2.0, snap2);

      // Still only 1 coalesced event in queue!
      expect(service.getQueueLength()).toBe(1);

      service.flush();
      const openEvents = repo.getOpenEvents('SOLUSDT');
      expect(openEvents).toHaveLength(1);
      expect(openEvents[0].p6_vote).toBe('BUY');
      expect(openEvents[0].p7_vote).toBe('BUY');
      expect(openEvents[0].active_pillars_count).toBe(2);

      // T0 + 15s (outside 10s window): CVD Absorption fires BUY -> triggers a NEW event
      vi.spyOn(Date, 'now').mockReturnValue(now + 15000);
      const snap3 = createDummySnapshot({
        CVD_ABSORPTION: { bias: 'BULLISH', score: 85 },
      });
      service.evaluateTick('SOLUSDT', 151.0, 2.0, snap3);
      expect(service.getQueueLength()).toBe(1);

      service.flush();
      const allOpen = repo.getOpenEvents('SOLUSDT');
      expect(allOpen).toHaveLength(2);

      vi.restoreAllMocks();
    });

    it('updates already-flushed event in SQLite if confirmation joins within 10s', () => {
      const now = Date.now();
      vi.spyOn(Date, 'now').mockReturnValue(now);

      // T0: Momentum fires BUY
      const snap1 = createDummySnapshot({
        MOMENTUM_RVOL: { bias: 'BULLISH', score: 80 },
      });
      service.evaluateTick('SOLUSDT', 150.0, 2.0, snap1);
      // Background flusher runs at 1s
      service.flush();

      let open = repo.getOpenEvents('SOLUSDT');
      expect(open).toHaveLength(1);
      expect(open[0].p6_vote).toBe('BUY');
      expect(open[0].p7_vote).toBe('WAIT');
      expect(open[0].active_pillars_count).toBe(1);

      // T0 + 3s: Sentiment joins in the same direction
      vi.spyOn(Date, 'now').mockReturnValue(now + 3000);
      const snap2 = createDummySnapshot({
        MOMENTUM_RVOL: { bias: 'BULLISH', score: 80 },
        SENTIMENT_MACRO: { bias: 'BULLISH', score: 75 },
      });
      service.evaluateTick('SOLUSDT', 150.2, 2.0, snap2);

      // SQLite row should be updated with new vote and active count
      open = repo.getOpenEvents('SOLUSDT');
      expect(open).toHaveLength(1);
      expect(open[0].p6_vote).toBe('BUY');
      expect(open[0].p7_vote).toBe('BUY');
      expect(open[0].active_pillars_count).toBe(2);

      vi.restoreAllMocks();
    });
  });

  // 3. Multi-Horizon chronological path evaluation (MFE/MAE and path-dependent stopout)
  describe('3. Multi-Horizon Chronological Path Evaluation', () => {
    it('evaluates confirmed bullish expansion when running MFE >= 1.0 * ATR%', () => {
      const now = 1000;
      vi.spyOn(Date, 'now').mockReturnValue(now);

      // Entry at 100.0, ATR = 2.0 (ATR% = 2.0%). Expansion threshold = 2.0% (price >= 102.0)
      // NATIVE_SMC (25%) votes BUY, ORDER_FLOW_L2 (15%) votes SELL -> BUY wins tie-break (25 > 15)
      const snap = createDummySnapshot({
        NATIVE_SMC: { bias: 'BULLISH', score: 80 },
        ORDER_FLOW_L2: { bias: 'BEARISH', score: 70 },
      });
      service.evaluateTick('SOLUSDT', 100.0, 2.0, snap);
      service.flush();

      // Closed 1m candle (time: 60s, open 100, high 102.5, low 99.5, close 102.0)
      // High 102.5 -> MFE = 2.5% >= 2.0% ATR% -> BULLISH_EXPANSION
      const candle1m: KlineCandle = {
        time: 60,
        open: 100.0,
        high: 102.5,
        low: 99.5,
        close: 102.0,
        volume: 500,
      };

      service.onClosedCandle('SOLUSDT', candle1m);

      const evals = repo.getEvaluationsForEvent(1);
      expect(evals).toHaveLength(1);
      expect(evals[0].horizon).toBe('1m');
      expect(evals[0].directional_outcome).toBe('BULLISH_EXPANSION');
      expect(evals[0].mfe_pct).toBe(2.5);
      expect(evals[0].mae_pct).toBe(0.5);

      // Native SMC (p2) voted BUY -> TRUE_POSITIVE
      expect(evals[0].p2_status).toBe('TRUE_POSITIVE');
      // Order Flow (p4) voted SELL -> FALSE_POSITIVE
      expect(evals[0].p4_status).toBe('FALSE_POSITIVE');
      // Macro Regime (p1) voted WAIT -> FALSE_NEGATIVE
      expect(evals[0].p1_status).toBe('FALSE_NEGATIVE');

      vi.restoreAllMocks();
    });

    it('terminates immediately with ADVERSE_STOPOUT when running MAE >= 1.5 * ATR% before expansion', () => {
      const now = 1000;
      vi.spyOn(Date, 'now').mockReturnValue(now);

      // Entry at 100.0, ATR = 2.0 (ATR% = 2.0%). Stopout threshold = 1.5 * 2.0% = 3.0% (price <= 97.0)
      const snap = createDummySnapshot({
        MOMENTUM_RVOL: { bias: 'BULLISH', score: 80 },
      });
      service.evaluateTick('SOLUSDT', 100.0, 2.0, snap);
      service.flush();

      // Candle drops to 96.0 (MAE = 4.0% >= 3.0% stopout) before reaching high
      const candle1m: KlineCandle = {
        time: 60,
        open: 100.0,
        high: 100.5,
        low: 96.0,
        close: 96.5,
        volume: 800,
      };

      service.onClosedCandle('SOLUSDT', candle1m);

      const evals = repo.getEvaluationsForEvent(1);
      // All remaining horizons settled as ADVERSE_STOPOUT immediately
      expect(evals.length).toBeGreaterThanOrEqual(1);
      expect(evals[0].directional_outcome).toBe('ADVERSE_STOPOUT');
      // Buyer receives FALSE_POSITIVE
      expect(evals[0].p6_status).toBe('FALSE_POSITIVE');
      // Inactive pillars receive TRUE_NEGATIVE
      expect(evals[0].p1_status).toBe('TRUE_NEGATIVE');

      // Parent event is marked SETTLED
      const ev = repo.getById(1);
      expect(ev?.status).toBe('SETTLED');

      vi.restoreAllMocks();
    });

    it('evaluates CHOP when neither expansion nor stopout occurs at horizon', () => {
      const now = 1000;
      vi.spyOn(Date, 'now').mockReturnValue(now);

      const snap = createDummySnapshot({
        MOMENTUM_RVOL: { bias: 'BULLISH', score: 80 },
      });
      service.evaluateTick('SOLUSDT', 100.0, 2.0, snap);
      service.flush();

      // Range is narrow: High 100.5 (MFE 0.5% < 2%), Low 99.5 (MAE 0.5% < 3%)
      const candle1m: KlineCandle = {
        time: 60,
        open: 100.0,
        high: 100.5,
        low: 99.5,
        close: 100.1,
        volume: 200,
      };

      service.onClosedCandle('SOLUSDT', candle1m);

      const evals = repo.getEvaluationsForEvent(1);
      expect(evals).toHaveLength(1);
      expect(evals[0].directional_outcome).toBe('CHOP');
      // In Chop: directional vote receives FALSE_POSITIVE
      expect(evals[0].p6_status).toBe('FALSE_POSITIVE');
      // WAIT receives TRUE_NEGATIVE (correct inaction)
      expect(evals[0].p1_status).toBe('TRUE_NEGATIVE');

      vi.restoreAllMocks();
    });
  });

  // 4. Zero active vote resilience & Bayesian shrinkage
  describe('4. Bayesian Shrinkage & Zero Active Vote Resilience', () => {
    it('generates regularized scorecards without division-by-zero or NaN when no data exists', () => {
      const scorecard = service.generateScorecard('SOLUSDT', '15m');
      expect(scorecard.symbol).toBe('SOLUSDT');
      expect(scorecard.sampleSize).toBe(0);
      expect(scorecard.scorecards).toHaveLength(7);

      let totalWeight = 0;
      for (const item of scorecard.scorecards) {
        expect(Number.isFinite(item.recommendedWeightPct)).toBe(true);
        expect(Number.isNaN(item.recommendedWeightPct)).toBe(false);
        expect(item.recommendedWeightPct).toBeGreaterThanOrEqual(2.5);
        expect(item.recommendedWeightPct).toBeLessThanOrEqual(35.0);
        totalWeight += item.recommendedWeightPct;
      }

      // Normalized simplex sum to 100%
      expect(Math.round(totalWeight)).toBe(100);
    });
  });

  // 5. Retroactive downtime gap recovery
  describe('5. Downtime Gap Reconciliation', () => {
    it('retroactively evaluates open events using historical klines from BinanceClient', async () => {
      const now = 1000;
      vi.spyOn(Date, 'now').mockReturnValue(now);

      const snap = createDummySnapshot({
        MOMENTUM_RVOL: { bias: 'BULLISH', score: 80 },
      });
      service.evaluateTick('SOLUSDT', 100.0, 2.0, snap);
      service.flush();

      // Mock Binance client returning 1m kline
      const mockClient = {
        getKlines: vi.fn().mockResolvedValue([
          [60000, '100.0', '103.0', '99.5', '102.5', '1000'],
        ]),
      } as any;

      await service.recoverDowntimeGaps(mockClient);

      expect(mockClient.getKlines).toHaveBeenCalledWith(
        'SOLUSDT',
        '1m',
        1000,
        expect.any(Number),
        expect.any(Number)
      );

      const evals = repo.getEvaluationsForEvent(1);
      expect(evals).toHaveLength(1);
      expect(evals[0].directional_outcome).toBe('BULLISH_EXPANSION');
      expect(evals[0].p6_status).toBe('TRUE_POSITIVE');

      vi.restoreAllMocks();
    });
  });

  // 6. Volatility expansion alone trigger
  describe('6. Volatility Expansion Alone Trigger', () => {
    it('triggers VOLATILITY_EXPANSION when candle range >= 1.5 ATR even with zero active votes', () => {
      const neutralSnap = createDummySnapshot({}, 30);
      const volatileCandle: KlineCandle = {
        time: 120,
        open: 100.0,
        high: 104.0, // range 4.0 >= 1.5 * 2.0 = 3.0
        low: 100.0,
        close: 103.5, // Bullish candle
        volume: 2000,
      };

      service.evaluateTick('SOLUSDT', 103.5, 2.0, neutralSnap, volatileCandle);
      service.flush();

      const open = repo.getOpenEvents('SOLUSDT');
      expect(open).toHaveLength(1);
      expect(open[0].trigger_type).toBe('VOLATILITY_EXPANSION');
      expect(open[0].consensus_side).toBe('BUY');
      expect(open[0].active_pillars_count).toBe(0);
    });
  });
});
