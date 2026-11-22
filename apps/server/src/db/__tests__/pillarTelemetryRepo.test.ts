import { describe, it, expect, beforeEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import {
  initializeDatabase,
  PillarTelemetryRepo,
  PILLAR_CONFIGS,
} from '../sqlite.js';
import type {
  PillarTelemetryRecord,
  PillarHorizonEvaluation,
} from '@tradeos/shared';

describe('PillarTelemetryRepo — SQLite Bulldog Telemetry Storage', () => {
  let db: DatabaseSync;
  let repo: PillarTelemetryRepo;

  beforeEach(() => {
    db = initializeDatabase(':memory:');
    repo = new PillarTelemetryRepo(db);
  });

  const createSampleEvent = (
    overrides?: Partial<PillarTelemetryRecord>
  ): Omit<PillarTelemetryRecord, 'id'> => ({
    timestamp: 1000,
    symbol: 'SOLUSDT',
    trigger_type: 'PILLAR_DIVERGENCE',
    mark_price: 150.0,
    atr_14: 2.0,
    composite_score: 52.0,
    consensus_side: 'BUY',
    active_pillars_count: 2,
    p1_vote: 'WAIT',
    p2_vote: 'WAIT',
    p3_vote: 'WAIT',
    p4_vote: 'WAIT',
    p5_vote: 'WAIT',
    p6_vote: 'BUY',
    p7_vote: 'BUY',
    p1_macro_regime: JSON.stringify({ state: 'RANGE', bias: 'NEUTRAL', score: 50 }),
    p2_native_smc: JSON.stringify({ state: 'WAIT', bias: 'NEUTRAL', score: 50 }),
    p3_cvd_absorption: JSON.stringify({ state: 'WAIT', bias: 'NEUTRAL', score: 50 }),
    p4_order_flow_l2: JSON.stringify({ state: 'WAIT', bias: 'NEUTRAL', score: 50 }),
    p5_liq_clusters: JSON.stringify({ state: 'WAIT', bias: 'NEUTRAL', score: 50 }),
    p6_momentum_rvol: JSON.stringify({ state: 'EXPANSION', bias: 'BULLISH', score: 80 }),
    p7_sentiment_macro: JSON.stringify({ state: 'BULLISH', bias: 'BULLISH', score: 75 }),
    status: 'EVALUATING',
    ...overrides,
  });

  describe('insertBatch and getOpenEvents', () => {
    it('handles empty events gracefully', () => {
      const ids = repo.insertBatch([]);
      expect(ids).toEqual([]);
    });

    it('inserts events in batch and retrieves open events', () => {
      const ev1 = createSampleEvent({ timestamp: 1000, symbol: 'SOLUSDT' });
      const ev2 = createSampleEvent({ timestamp: 2000, symbol: 'SOLUSDT' });
      const ev3 = createSampleEvent({ timestamp: 3000, symbol: 'BTCUSDT' });

      const ids = repo.insertBatch([ev1, ev2, ev3]);
      expect(ids).toHaveLength(3);
      expect(ids[0]).toBe(1);
      expect(ids[1]).toBe(2);
      expect(ids[2]).toBe(3);

      const openAll = repo.getOpenEvents();
      expect(openAll).toHaveLength(3);
      expect(openAll[0].id).toBe(1);
      expect(openAll[0].symbol).toBe('SOLUSDT');
      expect(openAll[0].p6_vote).toBe('BUY');

      const openSol = repo.getOpenEvents('SOLUSDT');
      expect(openSol).toHaveLength(2);

      const openBtc = repo.getOpenEvents('BTCUSDT');
      expect(openBtc).toHaveLength(1);

      expect(repo.countOpenEvents('SOLUSDT')).toBe(2);
      expect(repo.countOpenEvents('BTCUSDT')).toBe(1);
      expect(repo.countOpenEvents()).toBe(3);
    });
  });

  describe('recordHorizonEvaluation', () => {
    it('records multi-horizon trajectory evaluations and auto-settles event on 60m', () => {
      const ev = createSampleEvent({ timestamp: 1000, symbol: 'SOLUSDT' });
      const [eventId] = repo.insertBatch([ev]);

      const eval1m: Omit<PillarHorizonEvaluation, 'id'> = {
        event_id: eventId,
        horizon: '1m',
        settle_timestamp: 61000,
        settle_price: 151.0,
        price_change_abs: 1.0,
        price_change_pct: 0.67,
        mfe_pct: 0.8,
        mae_pct: 0.1,
        directional_outcome: 'BULLISH_EXPANSION',
        p1_status: 'FALSE_NEGATIVE',
        p2_status: 'FALSE_NEGATIVE',
        p3_status: 'FALSE_NEGATIVE',
        p4_status: 'FALSE_NEGATIVE',
        p5_status: 'FALSE_NEGATIVE',
        p6_status: 'TRUE_POSITIVE',
        p7_status: 'TRUE_POSITIVE',
      };

      const evalId1 = repo.recordHorizonEvaluation(eval1m);
      expect(evalId1).toBeGreaterThan(0);

      // Event should still be EVALUATING after 1m
      let eventRecord = repo.getById(eventId);
      expect(eventRecord?.status).toBe('EVALUATING');

      // Now record 60m horizon evaluation
      const eval60m: Omit<PillarHorizonEvaluation, 'id'> = {
        event_id: eventId,
        horizon: '60m',
        settle_timestamp: 3601000,
        settle_price: 153.5,
        price_change_abs: 3.5,
        price_change_pct: 2.33,
        mfe_pct: 2.5,
        mae_pct: 0.3,
        directional_outcome: 'BULLISH_EXPANSION',
        p1_status: 'FALSE_NEGATIVE',
        p2_status: 'FALSE_NEGATIVE',
        p3_status: 'FALSE_NEGATIVE',
        p4_status: 'FALSE_NEGATIVE',
        p5_status: 'FALSE_NEGATIVE',
        p6_status: 'TRUE_POSITIVE',
        p7_status: 'TRUE_POSITIVE',
      };

      repo.recordHorizonEvaluation(eval60m);

      // Event should now be automatically SETTLED
      eventRecord = repo.getById(eventId);
      expect(eventRecord?.status).toBe('SETTLED');

      const evals = repo.getEvaluationsForEvent(eventId);
      expect(evals).toHaveLength(2);
      expect(evals.map((e) => e.horizon)).toEqual(['1m', '60m']);
    });
  });

  describe('getAggregatedScorecard', () => {
    it('returns valid 7-pillar baseline scorecard with zero NaN when no samples exist', () => {
      const scorecards = repo.getAggregatedScorecard('SOLUSDT', '15m');
      expect(scorecards).toHaveLength(7);

      const totalWeight = scorecards.reduce((sum, item) => sum + item.recommendedWeightPct, 0);
      expect(Math.round(totalWeight)).toBe(100);

      for (const item of scorecards) {
        expect(item.totalActiveVotes).toBe(0);
        expect(item.hitRatePct).toBe(0);
        expect(item.avgMfePct).toBe(0);
        expect(item.avgMaePct).toBe(0);
        expect(Number.isNaN(item.recommendedWeightPct)).toBe(false);
      }
    });

    it('calculates hit rates, Bayesian shrinkage, and simplex normalization accurately with real evaluations', () => {
      const ev = createSampleEvent({ timestamp: 1000, symbol: 'SOLUSDT' });
      const [eventId] = repo.insertBatch([ev]);

      repo.recordHorizonEvaluation({
        event_id: eventId,
        horizon: '15m',
        settle_timestamp: 901000,
        settle_price: 152.0,
        price_change_abs: 2.0,
        price_change_pct: 1.33,
        mfe_pct: 1.5,
        mae_pct: 0.2,
        directional_outcome: 'BULLISH_EXPANSION',
        p1_status: 'FALSE_NEGATIVE',
        p2_status: 'NEUTRAL',
        p3_status: 'FALSE_POSITIVE',
        p4_status: 'NEUTRAL',
        p5_status: 'NEUTRAL',
        p6_status: 'TRUE_POSITIVE',
        p7_status: 'TRUE_POSITIVE',
      });

      const scorecards = repo.getAggregatedScorecard('SOLUSDT', '15m');
      expect(scorecards).toHaveLength(7);

      const p6 = scorecards.find((s) => s.pillarId === 'MOMENTUM_RVOL')!;
      expect(p6.truePositives).toBe(1);
      expect(p6.falsePositives).toBe(0);
      expect(p6.totalActiveVotes).toBe(1);
      expect(p6.hitRatePct).toBe(100.0);
      expect(p6.avgMfePct).toBe(1.5);

      const p3 = scorecards.find((s) => s.pillarId === 'CVD_ABSORPTION')!;
      expect(p3.truePositives).toBe(0);
      expect(p3.falsePositives).toBe(1);
      expect(p3.totalActiveVotes).toBe(1);
      expect(p3.hitRatePct).toBe(0.0);

      const totalWeight = scorecards.reduce((sum, item) => sum + item.recommendedWeightPct, 0);
      expect(Math.round(totalWeight)).toBe(100);

      const resp = repo.getAttributionResponse('SOLUSDT', '15m');
      expect(resp.symbol).toBe('SOLUSDT');
      expect(resp.horizon).toBe('15m');
      expect(resp.sampleSize).toBe(1);
      expect(resp.scorecards).toHaveLength(7);
    });
  });

  describe('archiveDailyScorecards and pruneStaleEvents', () => {
    it('archives daily scorecards and prunes stale records', () => {
      const now = Date.now();
      const oldTimestamp = now - 40 * 86_400_000; // 40 days ago

      const evOld = createSampleEvent({ timestamp: oldTimestamp, symbol: 'SOLUSDT', status: 'SETTLED' });
      const [oldId] = repo.insertBatch([evOld]);

      repo.recordHorizonEvaluation({
        event_id: oldId,
        horizon: '60m',
        settle_timestamp: oldTimestamp + 3600000,
        settle_price: 150.0,
        price_change_abs: 0.0,
        price_change_pct: 0.0,
        mfe_pct: 0.5,
        mae_pct: 0.2,
        directional_outcome: 'CHOP',
        p1_status: 'TRUE_NEGATIVE',
        p2_status: 'TRUE_NEGATIVE',
        p3_status: 'TRUE_NEGATIVE',
        p4_status: 'TRUE_NEGATIVE',
        p5_status: 'TRUE_NEGATIVE',
        p6_status: 'FALSE_POSITIVE',
        p7_status: 'FALSE_POSITIVE',
      });

      // Archive scorecards
      const archivedCount = repo.archiveDailyScorecards('2026-11-20');
      expect(archivedCount).toBe(4); // 4 horizons for 1 symbol

      // Query archived table
      const row = db
        .prepare('SELECT * FROM pillar_daily_scorecards WHERE date = ? AND horizon = ?')
        .get('2026-11-20', '60m') as { sample_size: number; scorecards_json: string } | undefined;
      expect(row).toBeDefined();
      expect(row?.sample_size).toBe(1);

      // Prune stale events older than 30 days
      const deletedCount = repo.pruneStaleEvents(30);
      expect(deletedCount).toBe(1);

      // Verify cascading delete removed the evaluation too
      const oldEval = db
        .prepare('SELECT * FROM pillar_horizon_evaluations WHERE event_id = ?')
        .get(oldId);
      expect(oldEval).toBeUndefined();
    });
  });
});
