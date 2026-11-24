import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import {
  initializeDatabase,
  ensureNextGenTelemetrySchema,
  DecisionLogsRepo,
  FactorTelemetryRecordsRepo,
} from '../sqlite.js';
import type {
  DecisionLogRecord,
  FactorTelemetryEvent,
} from '@tradeos/shared';

function makeTempDbPath(name: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tradeos-ft-repo-'));
  return path.join(dir, `${name}.db`);
}

function removeTempDb(dbPath: string | null): void {
  if (!dbPath) return;
  const dir = path.dirname(dbPath);
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {}
}

function makeSampleDecisionLog(overrides?: Partial<DecisionLogRecord>): DecisionLogRecord {
  return {
    id: 'dec-1',
    timestamp: 1_700_000_000_000,
    symbol: 'SOLUSDT',
    side: 'BUY',
    action: 'EXECUTED',
    composite_score: 84,
    pillars_json: '[]',
    macro_regime: 'MACRO_BULLISH',
    macro_veto_active: 0,
    veto_reasons_json: null,
    execution_price: 145.5,
    margin_usd: 1200,
    leverage: 10,
    atr: 1.4,
    trade_id: null,
    shadow_status: null,
    shadow_sl: null,
    shadow_tp: null,
    shadow_pnl_usd: null,
    expires_at: null,
    shadow_closed_at: null,
    error_message: null,
    created_at: 1_700_000_000_000,
    ...overrides,
  };
}

function makeSampleTelemetryEvent(overrides?: Partial<FactorTelemetryEvent>): FactorTelemetryEvent {
  return {
    eventId: 'evt-default-1',
    timestamp: 1_700_000_000_000,
    symbol: 'SOLUSDT',
    triggerType: 'POSITION_ENTERED',
    markPrice: 145.5,
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
        rawAlpha: 0.78,
        orthogonalAlpha: 0.72,
        effectiveWeight: 0.546,
        isCollinear: false,
        confidence: 0.91,
        summaryText: 'Depth Imbalance 1.8x Bid',
      },
      {
        factorId: 'CVD_ABSORPTION',
        name: 'CVD Absorption',
        bias: 'BULLISH',
        rawAlpha: 0.61,
        orthogonalAlpha: 0.49,
        effectiveWeight: 0.307,
        isCollinear: false,
        confidence: 0.84,
        summaryText: 'Spot CVD Absorption +2.1M',
      },
    ],
    collinearFactors: ['NATIVE_SMC', 'MACRO_REGIME'],
    chasingTelemetry: {
      orderId: 'chase-1',
      status: 'FILLED',
      anchorMarkPrice: 145.5,
      currentLimitPrice: 145.48,
      spreadPennyJumps: 2,
      amendmentCount: 2,
      durationMs: 840,
      realizedFeeUsd: 0.95,
      feeSavedVsTakerUsd: 1.42,
    },
    sizingTelemetry: {
      allocatedMarginUsd: 1200,
      allocatedMarginPct: 25.0,
      baseConvictionMargin: 0.21,
      quarterKellyMultiplier: 0.85,
      volatilityParityMultiplier: 1.1,
      circuitBreakerMultiplier: 1.0,
      solvencyAirbagOk: true,
    },
    ...overrides,
  };
}

describe('FactorTelemetryRecordsRepo & Next-Gen SQLite Schema', () => {
  let db: DatabaseSync;
  let decisionRepo: DecisionLogsRepo;
  let factorRecordsRepo: FactorTelemetryRecordsRepo;
  let tempDbPath: string | null = null;

  beforeEach(() => {
    db = initializeDatabase(':memory:');
    decisionRepo = new DecisionLogsRepo(db);
    factorRecordsRepo = new FactorTelemetryRecordsRepo(db);
    tempDbPath = null;
  });

  afterEach(() => {
    try {
      db.close();
    } catch {}
    removeTempDb(tempDbPath);
  });

  describe('Schema Initialization, PRAGMAs & Defensive Migrations', () => {
    it('configures PRAGMA wal_autocheckpoint = 1000 and creates factor_telemetry_records + indexes + decision_logs columns', () => {
      tempDbPath = makeTempDbPath('wal-pragma');
      const diskDb = initializeDatabase(tempDbPath);
      try {
        const autocheckpoint = diskDb.prepare('PRAGMA wal_autocheckpoint;').get() as {
          wal_autocheckpoint: number;
        };
        const fk = diskDb.prepare('PRAGMA foreign_keys;').get() as {
          foreign_keys: number;
        };
        const journal = diskDb.prepare('PRAGMA journal_mode;').get() as {
          journal_mode: string;
        };

        expect(autocheckpoint.wal_autocheckpoint).toBe(1000);
        expect(fk.foreign_keys).toBe(1);
        expect(journal.journal_mode.toLowerCase()).toBe('wal');

        const decisionCols = (
          diskDb.prepare('PRAGMA table_info(decision_logs);').all() as Array<{ name: string }>
        ).map((c) => c.name);
        expect(decisionCols).toContain('factor_telemetry_json');
        expect(decisionCols).toContain('execution_chase_json');
        expect(decisionCols).toContain('sizing_breakdown_json');
        expect(decisionCols).toContain('noise_band_state');

        const ftCols = (
          diskDb.prepare('PRAGMA table_info(factor_telemetry_records);').all() as Array<{
            name: string;
            notnull: number;
          }>
        );
        const ftColNames = ftCols.map((c) => c.name);
        expect(ftColNames).toEqual([
          'id',
          'decision_log_id',
          'event_id',
          'trigger_type',
          'timestamp',
          'symbol',
          'consensus_side',
          'entry_price',
          'composite_score',
          'factor_id',
          'raw_alpha',
          'orthogonal_alpha',
          'effective_weight',
          'is_collinear',
          'confidence',
          'summary_text',
          'telemetry_payload_json',
          'status',
          'settle_timestamp',
          'post_1m_mfe',
          'post_1m_mae',
          'post_5m_mfe',
          'post_5m_mae',
          'post_15m_mfe',
          'post_15m_mae',
          'post_1h_mfe',
          'post_1h_mae',
        ]);
        const decisionLogIdCol = ftCols.find((c) => c.name === 'decision_log_id');
        expect(decisionLogIdCol?.notnull).toBe(0);

        const indexes = (
          diskDb
            .prepare(
              "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'factor_telemetry_records';"
            )
            .all() as Array<{ name: string }>
        ).map((idx) => idx.name);
        expect(indexes).toContain('idx_factor_telemetry_factor_time');
        expect(indexes).toContain('idx_factor_telemetry_status');
        expect(indexes).toContain('idx_factor_telemetry_event_id');
      } finally {
        diskDb.close();
      }
    });

    it('idempotently migrates a legacy pre-Next-Gen database lacking the 4 decision_logs columns and factor_telemetry_records table', () => {
      tempDbPath = makeTempDbPath('legacy-migration');
      const legacyDb = new DatabaseSync(tempDbPath);
      legacyDb.exec(`
        PRAGMA journal_mode = WAL;
        PRAGMA foreign_keys = ON;
        CREATE TABLE trades (
          id TEXT PRIMARY KEY,
          symbol TEXT NOT NULL,
          broker_mode TEXT NOT NULL,
          side TEXT NOT NULL,
          status TEXT NOT NULL,
          entry_price REAL NOT NULL,
          quantity REAL NOT NULL,
          remaining_qty REAL NOT NULL,
          leverage INTEGER NOT NULL,
          margin_usd REAL NOT NULL,
          opened_at INTEGER NOT NULL
        );
        CREATE TABLE decision_logs (
          id TEXT PRIMARY KEY,
          timestamp INTEGER NOT NULL,
          symbol TEXT NOT NULL,
          side TEXT NOT NULL,
          action TEXT NOT NULL,
          composite_score REAL NOT NULL,
          pillars_json TEXT NOT NULL,
          macro_regime TEXT NOT NULL,
          macro_veto_active INTEGER DEFAULT 0,
          veto_reasons_json TEXT,
          execution_price REAL NOT NULL,
          margin_usd REAL NOT NULL,
          leverage INTEGER NOT NULL,
          atr REAL NOT NULL,
          trade_id TEXT REFERENCES trades(id) ON DELETE SET NULL,
          shadow_status TEXT,
          shadow_sl REAL,
          shadow_tp REAL,
          shadow_pnl_usd REAL,
          expires_at INTEGER,
          shadow_closed_at INTEGER,
          error_message TEXT,
          created_at INTEGER NOT NULL
        );
        INSERT INTO decision_logs (
          id, timestamp, symbol, side, action, composite_score, pillars_json,
          macro_regime, macro_veto_active, execution_price, margin_usd, leverage, atr, created_at
        ) VALUES (
          'legacy-dec-1', 1699999999000, 'SOLUSDT', 'BUY', 'BLOCKED', 62.5, '[]',
          'MACRO_RANGING', 0, 140.0, 100.0, 10, 1.2, 1699999999000
        );
      `);
      legacyDb.close();

      // First migration run via initializeDatabase
      const migratedDb1 = initializeDatabase(tempDbPath);
      migratedDb1.close();

      // Second migration run + explicit ensureNextGenTelemetrySchema must remain idempotent
      const migratedDb2 = initializeDatabase(tempDbPath);
      try {
        expect(() => ensureNextGenTelemetrySchema(migratedDb2)).not.toThrow();

        const cols = (
          migratedDb2.prepare('PRAGMA table_info(decision_logs);').all() as Array<{ name: string }>
        ).map((c) => c.name);
        expect(cols).toContain('factor_telemetry_json');
        expect(cols).toContain('execution_chase_json');
        expect(cols).toContain('sizing_breakdown_json');
        expect(cols).toContain('noise_band_state');

        const migratedRepo = new DecisionLogsRepo(migratedDb2);
        const rows = migratedRepo.listSessionDecisions(0);
        expect(rows).toHaveLength(1);
        expect(rows[0]!.id).toBe('legacy-dec-1');
        expect(rows[0]!.noise_band_state).toBe(0);
        expect(rows[0]!.factor_telemetry_json).toBeNull();
        expect(rows[0]!.execution_chase_json).toBeNull();
        expect(rows[0]!.sizing_breakdown_json).toBeNull();

        const ftTable = migratedDb2
          .prepare(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'factor_telemetry_records';"
          )
          .get() as { name: string } | undefined;
        expect(ftTable?.name).toBe('factor_telemetry_records');
      } finally {
        migratedDb2.close();
      }
    });
  });

  describe('DecisionLogsRepo.insert Next-Gen fields', () => {
    it('persists Next-Gen JSON columns and noise_band_state and defaults omitted fields to null / 0', () => {
      const event = makeSampleTelemetryEvent();
      decisionRepo.insert(
        makeSampleDecisionLog({
          id: 'dec-ng-1',
          timestamp: 1_700_000_001_000,
          factor_telemetry_json: JSON.stringify(event.activeFactors),
          execution_chase_json: JSON.stringify(event.chasingTelemetry),
          sizing_breakdown_json: JSON.stringify(event.sizingTelemetry),
          noise_band_state: 1,
        })
      );
      decisionRepo.insert(
        makeSampleDecisionLog({
          id: 'dec-legacy-shape',
          timestamp: 1_700_000_002_000,
        })
      );

      const rows = decisionRepo.listSessionDecisions(0);
      expect(rows).toHaveLength(2);

      const ng = rows.find((r) => r.id === 'dec-ng-1')!;
      expect(JSON.parse(ng.factor_telemetry_json!)).toHaveLength(2);
      expect(JSON.parse(ng.execution_chase_json!).feeSavedVsTakerUsd).toBe(1.42);
      expect(JSON.parse(ng.sizing_breakdown_json!).allocatedMarginUsd).toBe(1200);
      expect(ng.noise_band_state).toBe(1);

      const legacyShape = rows.find((r) => r.id === 'dec-legacy-shape')!;
      expect(legacyShape.factor_telemetry_json).toBeNull();
      expect(legacyShape.execution_chase_json).toBeNull();
      expect(legacyShape.sizing_breakdown_json).toBeNull();
      expect(legacyShape.noise_band_state).toBe(0);
    });
  });

  describe('Nullable FK vs ON DELETE CASCADE & Batch Insertion', () => {
    it('allows nullable decision_log_id for SUB_THRESHOLD_IMPULSE and ORDER_AMENDED under foreign_keys=ON, rejects dangling FKs, and cascades parent deletes', () => {
      const impulseEvent = makeSampleTelemetryEvent({
        eventId: 'evt-impulse-1',
        triggerType: 'SUB_THRESHOLD_IMPULSE',
        compositeScore: 48,
        convictionArchetype: 'SUB_THRESHOLD',
      });

      const impulseIds = factorRecordsRepo.insertEventBatch(impulseEvent, null);
      expect(impulseIds).toHaveLength(4); // 2 active + 2 collinear

      const amendEvent = makeSampleTelemetryEvent({
        eventId: 'evt-amend-1',
        triggerType: 'ORDER_AMENDED',
      });
      const amendIds = factorRecordsRepo.insertEventBatch(amendEvent);
      expect(amendIds).toHaveLength(4);

      // Non-existent parent decision_log_id must fail foreign key constraint
      expect(() =>
        factorRecordsRepo.insertEventBatch(
          makeSampleTelemetryEvent({ eventId: 'evt-bad-fk' }),
          'non-existent-decision-id'
        )
      ).toThrow();

      // Valid parent decision_logs row links cleanly and cascades on delete
      decisionRepo.insert(makeSampleDecisionLog({ id: 'dec-parent-1' }));
      const linkedIds = factorRecordsRepo.insertEventBatch(
        makeSampleTelemetryEvent({ eventId: 'evt-linked-1' }),
        'dec-parent-1'
      );
      expect(linkedIds).toHaveLength(4);
      expect(factorRecordsRepo.getPendingEvaluations()).toHaveLength(12);

      db.prepare('DELETE FROM decision_logs WHERE id = ?').run('dec-parent-1');

      const remaining = factorRecordsRepo.getPendingEvaluations();
      expect(remaining).toHaveLength(8);
      expect(remaining.every((r) => r.decision_log_id === null)).toBe(true);
    });

    it('inserts a synthetic COMPOSITE row when both activeFactors and collinearFactors are empty', () => {
      const emptyFactorEvent = makeSampleTelemetryEvent({
        eventId: 'evt-empty-factors',
        activeFactors: [],
        collinearFactors: [],
      });

      const ids = factorRecordsRepo.insertEventBatch(emptyFactorEvent, null);
      expect(ids).toHaveLength(1);

      const pending = factorRecordsRepo.getPendingEvaluations('SOLUSDT');
      expect(pending).toHaveLength(1);
      expect(pending[0]!.factor_id).toBe('COMPOSITE');
      expect(pending[0]!.is_collinear).toBe(0);
      expect(pending[0]!.telemetry_payload_json).not.toBeNull();
    });
  });

  describe('Horizon Excursions & Settled Queries', () => {
    it('updates MFE/MAE horizons incrementally and retrieves settled rows by factorId newest-first', () => {
      const ids1 = factorRecordsRepo.insertEventBatch(
        makeSampleTelemetryEvent({
          eventId: 'evt-settle-1',
          timestamp: 1_700_000_010_000,
          collinearFactors: [],
        }),
        null
      );
      const ids2 = factorRecordsRepo.insertEventBatch(
        makeSampleTelemetryEvent({
          eventId: 'evt-settle-2',
          timestamp: 1_700_000_020_000,
          collinearFactors: [],
        }),
        null
      );
      const ids3 = factorRecordsRepo.insertEventBatch(
        makeSampleTelemetryEvent({
          eventId: 'evt-incomplete-3',
          timestamp: 1_700_000_030_000,
          collinearFactors: [],
        }),
        null
      );

      // Incremental 1m -> 5m -> 15m -> 1h + SETTLED on ids1[0] (ORDER_FLOW_L2)
      factorRecordsRepo.updateHorizonExcursions(ids1[0]!, {
        post_1m_mfe: 0.004,
        post_1m_mae: -0.001,
      });
      factorRecordsRepo.updateHorizonExcursions(ids1[0]!, {
        post_5m_mfe: 0.011,
        post_5m_mae: -0.002,
      });
      factorRecordsRepo.updateHorizonExcursions(ids1[0]!, {
        post_15m_mfe: 0.018,
        post_15m_mae: -0.003,
        post_1h_mfe: 0.032,
        post_1h_mae: -0.004,
        status: 'SETTLED',
        settle_timestamp: 1_700_003_610_000,
      });

      // Settle newer event ids2[0]
      factorRecordsRepo.updateHorizonExcursions(ids2[0]!, {
        post_1m_mfe: 0.006,
        post_1m_mae: -0.002,
        post_1h_mfe: 0.025,
        post_1h_mae: -0.005,
        status: 'SETTLED',
        settle_timestamp: 1_700_003_620_000,
      });

      // Mark ids3[0] as INCOMPLETE_FEED
      factorRecordsRepo.updateHorizonExcursions(ids3[0]!, {
        status: 'INCOMPLETE_FEED',
        settle_timestamp: 1_700_003_930_000,
      });

      const settledOrderFlow = factorRecordsRepo.getSettledByFactor('ORDER_FLOW_L2', 10);
      expect(settledOrderFlow).toHaveLength(2);
      // Newest first
      expect(settledOrderFlow[0]!.event_id).toBe('evt-settle-2');
      expect(settledOrderFlow[1]!.event_id).toBe('evt-settle-1');
      expect(settledOrderFlow[1]!.post_1m_mfe).toBeCloseTo(0.004, 6);
      expect(settledOrderFlow[1]!.post_5m_mfe).toBeCloseTo(0.011, 6);
      expect(settledOrderFlow[1]!.post_15m_mfe).toBeCloseTo(0.018, 6);
      expect(settledOrderFlow[1]!.post_1h_mfe).toBeCloseTo(0.032, 6);
      expect(settledOrderFlow[1]!.status).toBe('SETTLED');

      // Limit works
      expect(factorRecordsRepo.getSettledByFactor('ORDER_FLOW_L2', 1)).toHaveLength(1);

      // Pending evaluations exclude SETTLED and INCOMPLETE_FEED rows
      const stillPending = factorRecordsRepo.getPendingEvaluations();
      expect(stillPending.some((r) => r.id === ids1[0] || r.id === ids2[0] || r.id === ids3[0])).toBe(
        false
      );
      expect(stillPending.some((r) => r.id === ids1[1])).toBe(true);
    });
  });

  describe('listRecentEvents Reconstruction & Pagination', () => {
    it('reconstructs distinct FactorTelemetryEvents newest-first with sinceMs, limit, and offset pagination', () => {
      const ev1 = makeSampleTelemetryEvent({
        eventId: 'evt-1',
        timestamp: 1_700_000_001_000,
        symbol: 'BTCUSDT',
        triggerType: 'SIGNAL_CONFIRMED',
      });
      const ev2 = makeSampleTelemetryEvent({
        eventId: 'evt-2',
        timestamp: 1_700_000_002_000,
        symbol: 'ETHUSDT',
        triggerType: 'ORDER_AMENDED',
      });
      const ev3 = makeSampleTelemetryEvent({
        eventId: 'evt-3',
        timestamp: 1_700_000_003_000,
        symbol: 'SOLUSDT',
        triggerType: 'POSITION_ENTERED',
        macroVetoActive: true,
        macroVetoReason: 'CPI Blackout',
      });

      factorRecordsRepo.insertEventBatch(ev1, null);
      factorRecordsRepo.insertEventBatch(ev2, null);
      factorRecordsRepo.insertEventBatch(ev3, null);

      const page1 = factorRecordsRepo.listRecentEvents(1_700_000_000_000, 2, 0);
      expect(page1).toHaveLength(2);
      expect(page1.map((e) => e.eventId)).toEqual(['evt-3', 'evt-2']);
      expect(page1[0]!.macroVetoReason).toBe('CPI Blackout');
      expect(page1[0]!.collinearFactors).toEqual(['NATIVE_SMC', 'MACRO_REGIME']);
      expect(page1[0]!.chasingTelemetry?.feeSavedVsTakerUsd).toBe(1.42);
      expect(page1[0]!.sizingTelemetry?.allocatedMarginPct).toBe(25.0);

      const page2 = factorRecordsRepo.listRecentEvents(1_700_000_000_000, 2, 2);
      expect(page2).toHaveLength(1);
      expect(page2[0]!.eventId).toBe('evt-1');

      const filteredSince = factorRecordsRepo.listRecentEvents(1_700_000_002_500, 10, 0);
      expect(filteredSince).toHaveLength(1);
      expect(filteredSince[0]!.eventId).toBe('evt-3');
    });
  });

  describe('pruneOldSubThresholdImpulses', () => {
    it('deletes SUB_THRESHOLD_IMPULSE rows older than retentionDays while retaining recent impulses and confirmed/executed telemetry indefinitely', () => {
      const now = Date.now();
      const eightDaysAgo = now - 8 * 86_400_000;
      const twoDaysAgo = now - 2 * 86_400_000;

      // Old sub-threshold impulse (4 rows: 2 active + 2 collinear) -> MUST be pruned
      factorRecordsRepo.insertEventBatch(
        makeSampleTelemetryEvent({
          eventId: 'evt-old-impulse',
          timestamp: eightDaysAgo,
          triggerType: 'SUB_THRESHOLD_IMPULSE',
        }),
        null
      );

      // Recent sub-threshold impulse -> MUST be kept
      factorRecordsRepo.insertEventBatch(
        makeSampleTelemetryEvent({
          eventId: 'evt-recent-impulse',
          timestamp: twoDaysAgo,
          triggerType: 'SUB_THRESHOLD_IMPULSE',
        }),
        null
      );

      // Old executed/confirmed events -> MUST be retained indefinitely
      factorRecordsRepo.insertEventBatch(
        makeSampleTelemetryEvent({
          eventId: 'evt-old-entered',
          timestamp: eightDaysAgo - 29 * 86_400_000,
          triggerType: 'POSITION_ENTERED',
        }),
        null
      );
      factorRecordsRepo.insertEventBatch(
        makeSampleTelemetryEvent({
          eventId: 'evt-old-confirmed',
          timestamp: eightDaysAgo - 30 * 86_400_000,
          triggerType: 'SIGNAL_CONFIRMED',
        }),
        null
      );

      const deletedCount = factorRecordsRepo.pruneOldSubThresholdImpulses(7);
      expect(deletedCount).toBe(4);

      const remainingEvents = factorRecordsRepo.listRecentEvents(0, 20, 0);
      expect(remainingEvents.map((e) => e.eventId)).toEqual([
        'evt-recent-impulse',
        'evt-old-entered',
        'evt-old-confirmed',
      ]);
    });
  });
});
