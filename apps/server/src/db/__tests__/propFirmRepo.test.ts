import { describe, it, expect, beforeEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import {
  initializeDatabase,
  ensurePropFirmSchema,
  PropFirmRepo,
} from '../sqlite.js';
import {
  UPCOMERS_1STEP_50K_DEFAULT,
  type PropFirmChallengeCycle,
  type PropFirmDailySnapshot,
} from '@tradeos/shared';

function makeCycle(
  overrides: Partial<PropFirmChallengeCycle> = {}
): PropFirmChallengeCycle {
  const startingBalance = overrides.startingBalanceUsd ?? UPCOMERS_1STEP_50K_DEFAULT.accountSizeUsd;
  return {
    id: overrides.id ?? 'cycle-1',
    cycleNumber: overrides.cycleNumber ?? 1,
    status: overrides.status ?? 'ACTIVE',
    startingBalanceUsd: startingBalance,
    currentEquityUsd: overrides.currentEquityUsd ?? startingBalance,
    highWaterMarkUsd: overrides.highWaterMarkUsd ?? startingBalance,
    contractualTrailingFloorUsd:
      overrides.contractualTrailingFloorUsd ??
      startingBalance - UPCOMERS_1STEP_50K_DEFAULT.contractualTrailingLossUsd,
    internalTrailingFloorUsd:
      overrides.internalTrailingFloorUsd ??
      startingBalance - UPCOMERS_1STEP_50K_DEFAULT.internalTrailingHaltUsd,
    isFloorLocked: overrides.isFloorLocked ?? false,
    profitTargetUsd: overrides.profitTargetUsd ?? UPCOMERS_1STEP_50K_DEFAULT.profitTargetUsd,
    netPnlUsd: overrides.netPnlUsd ?? 0,
    netPnlPct: overrides.netPnlPct ?? 0,
    maxDrawdownUsd: overrides.maxDrawdownUsd ?? 0,
    tradesCount: overrides.tradesCount ?? 0,
    winCount: overrides.winCount ?? 0,
    lossCount: overrides.lossCount ?? 0,
    startedAt: overrides.startedAt ?? 1_700_000_000_000,
    closedAt: overrides.closedAt ?? null,
  };
}

describe('PropFirmRepo & SQLite Schema Migrations', () => {
  let db: DatabaseSync;
  let repo: PropFirmRepo;

  beforeEach(() => {
    db = initializeDatabase(':memory:');
    repo = new PropFirmRepo(db);
  });

  describe('Fresh DB creation & idempotent schema setup', () => {
    it('creates propfirm tables and indexes on fresh DB and is idempotent on re-run', () => {
      const tables = db
        .prepare(
          `SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'propfirm_%' ORDER BY name ASC`
        )
        .all() as Array<{ name: string }>;
      expect(tables.map((t) => t.name)).toEqual([
        'propfirm_challenge_cycles',
        'propfirm_daily_snapshots',
      ]);

      const indexes = db
        .prepare(
          `SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_propfirm_%' ORDER BY name ASC`
        )
        .all() as Array<{ name: string }>;
      expect(indexes.map((i) => i.name)).toEqual([
        'idx_propfirm_cycles_num',
        'idx_propfirm_cycles_status',
        'idx_propfirm_daily_date',
      ]);

      // Calling ensurePropFirmSchema repeatedly on existing DB or bare DB must succeed
      expect(() => ensurePropFirmSchema(db)).not.toThrow();
      const bareDb = new DatabaseSync(':memory:');
      expect(() => ensurePropFirmSchema(bareDb)).not.toThrow();
      const bareRepo = new PropFirmRepo(bareDb);
      expect(bareRepo.getNextCycleNumber()).toBe(1);
    });

    it('creates, retrieves active/latest cycles, and tracks getNextCycleNumber', () => {
      expect(repo.getActiveCycle()).toBeNull();
      expect(repo.getLatestCycle()).toBeNull();
      expect(repo.listCycles()).toEqual([]);
      expect(repo.getNextCycleNumber()).toBe(1);

      const cycle1 = makeCycle({
        id: 'cycle-001',
        cycleNumber: 1,
        status: 'ACTIVE',
        startedAt: 1_700_000_000_000,
      });

      const created = repo.createCycle(cycle1);
      expect(created).toEqual(cycle1);

      const active = repo.getActiveCycle();
      expect(active).toEqual(cycle1);
      expect(active?.isFloorLocked).toBe(false);
      expect(active?.closedAt).toBeNull();

      expect(repo.getLatestCycle()).toEqual(cycle1);
      expect(repo.getNextCycleNumber()).toBe(2);

      // Halted non-terminal statuses must still be returned by getActiveCycle()
      repo.updateCycle('cycle-001', { status: 'HALTED_DAILY_BUFFER' });
      expect(repo.getActiveCycle()?.status).toBe('HALTED_DAILY_BUFFER');

      repo.updateCycle('cycle-001', { status: 'HALTED_TRAILING_BUFFER' });
      expect(repo.getActiveCycle()?.status).toBe('HALTED_TRAILING_BUFFER');
    });
  });

  describe('Monotonic HWM, floor lock updates, and terminal transitions', () => {
    it('updates HWM, locks trailing floor at $50,000, and transitions to PASSED / FAILED_DAILY', () => {
      const cycle1 = makeCycle({ id: 'cycle-lock-1', cycleNumber: 1 });
      repo.createCycle(cycle1);

      // Update HWM >= $53,000 and lock floor at $50,000
      repo.updateCycle('cycle-lock-1', {
        currentEquityUsd: 53_100,
        highWaterMarkUsd: 53_100,
        contractualTrailingFloorUsd: 50_000,
        internalTrailingFloorUsd: 50_500,
        isFloorLocked: true,
        netPnlUsd: 3_100,
        netPnlPct: 6.2,
        maxDrawdownUsd: 420.5,
        tradesCount: 4,
        winCount: 3,
        lossCount: 1,
      });

      // Verify raw SQLite storage uses integer 1 for boolean is_floor_locked
      const rawRow = db
        .prepare('SELECT is_floor_locked FROM propfirm_challenge_cycles WHERE id = ?')
        .get('cycle-lock-1') as { is_floor_locked: number };
      expect(rawRow.is_floor_locked).toBe(1);

      const updated = repo.getActiveCycle();
      expect(updated).not.toBeNull();
      expect(updated?.highWaterMarkUsd).toBe(53_100);
      expect(updated?.contractualTrailingFloorUsd).toBe(50_000);
      expect(updated?.internalTrailingFloorUsd).toBe(50_500);
      expect(updated?.isFloorLocked).toBe(true);
      expect(updated?.maxDrawdownUsd).toBe(420.5);
      expect(updated?.tradesCount).toBe(4);
      expect(updated?.winCount).toBe(3);
      expect(updated?.lossCount).toBe(1);

      // Empty patch must be a safe no-op
      expect(() => repo.updateCycle('cycle-lock-1', {})).not.toThrow();

      // Transition to PASSED
      const closedAt = 1_700_005_000_000;
      repo.updateCycle('cycle-lock-1', {
        status: 'PASSED',
        closedAt,
      });

      expect(repo.getActiveCycle()).toBeNull();
      const latest = repo.getLatestCycle();
      expect(latest?.status).toBe('PASSED');
      expect(latest?.closedAt).toBe(closedAt);

      // Create second cycle and transition to FAILED_DAILY
      const cycle2 = makeCycle({
        id: 'cycle-fail-2',
        cycleNumber: 2,
        startedAt: 1_700_010_000_000,
      });
      repo.createCycle(cycle2);
      repo.updateCycle('cycle-fail-2', {
        status: 'FAILED_DAILY',
        currentEquityUsd: 48_450,
        netPnlUsd: -1_550,
        netPnlPct: -3.1,
        maxDrawdownUsd: 1_550,
        closedAt: 1_700_020_000_000,
      });

      expect(repo.getActiveCycle()).toBeNull();
      const listed = repo.listCycles(10);
      expect(listed.map((c) => c.cycleNumber)).toEqual([2, 1]);
      expect(listed[0]?.status).toBe('FAILED_DAILY');
      expect(listed[1]?.status).toBe('PASSED');
      expect(repo.listCycles(1)).toHaveLength(1);
    });
  });

  describe('countConsecutivePassedCycles()', () => {
    it('returns 5 for 5 consecutive PASSED cycles and ignores non-terminal head cycle', () => {
      expect(repo.countConsecutivePassedCycles()).toBe(0);

      for (let i = 1; i <= 5; i++) {
        repo.createCycle(
          makeCycle({
            id: `passed-${i}`,
            cycleNumber: i,
            status: 'PASSED',
            currentEquityUsd: 52_500,
            highWaterMarkUsd: 52_500,
            netPnlUsd: 2_500,
            netPnlPct: 5.0,
            startedAt: 1_700_000_000_000 + i * 100_000,
            closedAt: 1_700_000_050_000 + i * 100_000,
          })
        );
      }

      expect(repo.countConsecutivePassedCycles()).toBe(5);

      // An active or transiently halted head cycle must not erase the 5-cycle passed streak
      repo.createCycle(
        makeCycle({
          id: 'active-6',
          cycleNumber: 6,
          status: 'ACTIVE',
          startedAt: 1_700_001_000_000,
        })
      );
      expect(repo.countConsecutivePassedCycles()).toBe(5);

      repo.updateCycle('active-6', { status: 'HALTED_DAILY_BUFFER' });
      expect(repo.countConsecutivePassedCycles()).toBe(5);

      repo.updateCycle('active-6', { status: 'HALTED_TRAILING_BUFFER' });
      expect(repo.countConsecutivePassedCycles()).toBe(5);
    });

    it('breaks streak on FAILED_DAILY and FAILED_TRAILING', () => {
      repo.createCycle(
        makeCycle({ id: 'c1', cycleNumber: 1, status: 'PASSED', closedAt: 100 })
      );
      repo.createCycle(
        makeCycle({ id: 'c2', cycleNumber: 2, status: 'PASSED', closedAt: 200 })
      );
      repo.createCycle(
        makeCycle({ id: 'c3', cycleNumber: 3, status: 'FAILED_DAILY', closedAt: 300 })
      );
      repo.createCycle(
        makeCycle({ id: 'c4', cycleNumber: 4, status: 'PASSED', closedAt: 400 })
      );

      // Cycle 3 FAILED_DAILY breaks the older 2-cycle streak -> only Cycle 4 counts
      expect(repo.countConsecutivePassedCycles()).toBe(1);

      // A trailing failure at Cycle 5 resets the streak to 0 even if Cycle 6 is ACTIVE
      repo.createCycle(
        makeCycle({ id: 'c5', cycleNumber: 5, status: 'FAILED_TRAILING', closedAt: 500 })
      );
      repo.createCycle(
        makeCycle({ id: 'c6', cycleNumber: 6, status: 'ACTIVE', closedAt: null })
      );
      expect(repo.countConsecutivePassedCycles()).toBe(0);
    });
  });

  describe('upsertDailySnapshot() & getDailySnapshot()', () => {
    it('inserts 00:00 UTC baseline and updates EOD metrics idempotently on (utc_date, cycle_id)', () => {
      const cycle = makeCycle({ id: 'cycle-snap-1', cycleNumber: 1 });
      repo.createCycle(cycle);

      expect(repo.getDailySnapshot('2026-11-25', 'cycle-snap-1')).toBeNull();

      const baseline: PropFirmDailySnapshot = {
        utcDate: '2026-11-25',
        cycleId: 'cycle-snap-1',
        dayStartEquityUsd: 50_000,
        currentEquityUsd: 50_000,
        dailyPnlUsd: 0,
        dailyMinEquityUsd: 50_000,
        dailyHalted: false,
        updatedAt: 1_795_564_800_000,
      };
      repo.upsertDailySnapshot(baseline);

      const loadedBaseline = repo.getDailySnapshot('2026-11-25', 'cycle-snap-1');
      expect(loadedBaseline).toEqual(baseline);
      expect(loadedBaseline?.dailyHalted).toBe(false);

      // Upsert same (utc_date, cycle_id) with EOD loss & halt triggered
      const eodUpdate: PropFirmDailySnapshot = {
        utcDate: '2026-11-25',
        cycleId: 'cycle-snap-1',
        dayStartEquityUsd: 50_000,
        currentEquityUsd: 48_740,
        dailyPnlUsd: -1_260,
        dailyMinEquityUsd: 48_740,
        dailyHalted: true,
        updatedAt: 1_795_600_000_000,
      };
      repo.upsertDailySnapshot(eodUpdate);

      const loadedUpdate = repo.getDailySnapshot('2026-11-25', 'cycle-snap-1');
      expect(loadedUpdate).toEqual(eodUpdate);
      expect(loadedUpdate?.dailyHalted).toBe(true);

      // Confirm no duplicate row was created and raw integer 1 is stored
      const countRow = db
        .prepare(
          'SELECT COUNT(*) as cnt, MAX(daily_halted) as halted FROM propfirm_daily_snapshots WHERE utc_date = ? AND cycle_id = ?'
        )
        .get('2026-11-25', 'cycle-snap-1') as { cnt: number; halted: number };
      expect(countRow.cnt).toBe(1);
      expect(countRow.halted).toBe(1);

      // Next UTC day creates a distinct row
      const nextDay: PropFirmDailySnapshot = {
        utcDate: '2026-11-26',
        cycleId: 'cycle-snap-1',
        dayStartEquityUsd: 48_740,
        currentEquityUsd: 49_200,
        dailyPnlUsd: 460,
        dailyMinEquityUsd: 48_740,
        dailyHalted: false,
        updatedAt: 1_795_651_200_000,
      };
      repo.upsertDailySnapshot(nextDay);
      expect(repo.getDailySnapshot('2026-11-26', 'cycle-snap-1')).toEqual(nextDay);
      expect(repo.getDailySnapshot('2026-11-25', 'cycle-snap-1')).toEqual(eodUpdate);

      // Deleting parent cycle cascades to snapshots
      db.prepare('DELETE FROM propfirm_challenge_cycles WHERE id = ?').run('cycle-snap-1');
      expect(repo.getDailySnapshot('2026-11-25', 'cycle-snap-1')).toBeNull();
      expect(repo.getDailySnapshot('2026-11-26', 'cycle-snap-1')).toBeNull();
    });
  });
});
