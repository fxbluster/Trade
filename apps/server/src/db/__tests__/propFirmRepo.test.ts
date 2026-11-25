import { describe, it, expect, beforeEach } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import {
  initializeDatabase,
  ensurePropFirmSchema,
  PropFirmRepo,
  PropFirmConflictError,
  TradesRepo,
} from '../sqlite.js';
import type { PropFirmChallengeCycle, TradeRecord, TradeStatus } from '@tradeos/shared';

function makeCycle(overrides: Partial<PropFirmChallengeCycle> = {}): PropFirmChallengeCycle {
  const startedAt = overrides.startedAt ?? 1_700_000_000_000;
  return {
    id: overrides.id ?? 'cycle_1',
    cycleNumber: overrides.cycleNumber ?? 1,
    status: overrides.status ?? 'ACTIVE',
    startingBalanceUsd: 50_000,
    currentEquityUsd: 50_000,
    highWaterMarkUsd: 50_000,
    contractualTrailingFloorUsd: 47_000,
    internalTrailingFloorUsd: 47_500,
    isFloorLocked: false,
    profitTargetUsd: 2_500,
    netPnlUsd: 0,
    realizedPnlUsd: 0,
    netPnlPct: 0,
    maxDrawdownUsd: 0,
    tradesCount: 0,
    winCount: 0,
    lossCount: 0,
    startedAt,
    closedAt: null,
    ...overrides,
  };
}

function makeTrade(overrides: Partial<TradeRecord> = {}): TradeRecord {
  return {
    id: overrides.id ?? 'trade_1',
    symbol: overrides.symbol ?? 'BTCUSDT',
    broker_mode: overrides.broker_mode ?? 'BINANCE_DEMO',
    side: overrides.side ?? 'BUY',
    status: overrides.status ?? 'OPEN',
    entry_price: 90_000,
    exit_price: null,
    quantity: 0.1,
    remaining_qty: 0.1,
    leverage: 10,
    margin_usd: 900,
    stop_loss: 89_000,
    tp1: 91_000,
    tp2: 92_000,
    be_price: null,
    is_breakeven: 0,
    client_order_id: 'cli_1',
    client_sl_id: null,
    client_tp1_id: null,
    client_tp2_id: null,
    entry_order_id: 'ent_1',
    sl_algo_id: null,
    tp1_algo_id: null,
    tp2_algo_id: null,
    realized_pnl: 0,
    fees_usd: 0,
    exit_reason: null,
    opened_at: 1_700_000_000_000,
    closed_at: null,
    ...overrides,
  };
}

describe('PropFirmRepo — Transactional Rollover & Realized PnL Persistence', () => {
  let db: DatabaseSync;
  let repo: PropFirmRepo;
  let tradesRepo: TradesRepo;

  beforeEach(() => {
    db = initializeDatabase(':memory:');
    repo = new PropFirmRepo(db);
    tradesRepo = new TradesRepo(db);
  });

  it.each<TradeStatus>(['OPEN', 'PARTIALLY_CLOSED', 'CLOSING', 'CLOSING_IN_PROGRESS'])(
    'rolloverCycle rejects active trade status %s across all symbols with PropFirmConflictError(OPEN_POSITION_EXISTS)',
    (tradeStatus) => {
      repo.createCycle(
        makeCycle({
          id: 'cycle_1',
          cycleNumber: 1,
          status: 'PASSED',
          closedAt: 1_700_000_100_000,
        })
      );

      tradesRepo.insert(
        makeTrade({
          id: `trade_${tradeStatus}`,
          symbol: 'ETHUSDT',
          status: tradeStatus,
        })
      );

      const nextCycle = makeCycle({
        id: 'cycle_2',
        cycleNumber: 2,
        status: 'ACTIVE',
        startedAt: 1_700_000_200_000,
      });

      let caught: unknown;
      try {
        repo.rolloverCycle(nextCycle);
      } catch (err) {
        caught = err;
      }

      expect(caught).toBeInstanceOf(PropFirmConflictError);
      expect((caught as PropFirmConflictError).code).toBe('OPEN_POSITION_EXISTS');
      expect(repo.listCycles()).toHaveLength(1);
    }
  );

  it.each(['ACTIVE', 'HALTED_DAILY_BUFFER'] as const)(
    'rolloverCycle rejects %s cycle with PropFirmConflictError(CYCLE_STILL_ACTIVE)',
    (cycleStatus) => {
      repo.createCycle(
        makeCycle({
          id: 'cycle_1',
          cycleNumber: 1,
          status: cycleStatus,
        })
      );

      const nextCycle = makeCycle({
        id: 'cycle_2',
        cycleNumber: 2,
        status: 'ACTIVE',
        startedAt: 1_700_000_200_000,
      });

      let caught: unknown;
      try {
        repo.rolloverCycle(nextCycle);
      } catch (err) {
        caught = err;
      }

      expect(caught).toBeInstanceOf(PropFirmConflictError);
      expect((caught as PropFirmConflictError).code).toBe('CYCLE_STILL_ACTIVE');
      expect(repo.listCycles()).toHaveLength(1);
    }
  );

  it('rolloverCycle atomically finalizes HALTED_TRAILING_BUFFER -> FAILED_TRAILING with closedAt and inserts Cycle N+1 with realizedPnlUsd: 0', () => {
    repo.createCycle(
      makeCycle({
        id: 'cycle_1',
        cycleNumber: 1,
        status: 'HALTED_TRAILING_BUFFER',
        netPnlUsd: -2_510,
        realizedPnlUsd: -2_510,
        closedAt: null,
      })
    );

    // Closed trade on another symbol should not block rollover
    tradesRepo.insert(
      makeTrade({
        id: 'closed_trade_1',
        symbol: 'SOLUSDT',
        status: 'CLOSED',
        closed_at: 1_700_000_150_000,
      })
    );

    const rolloverTime = 1_700_000_300_000;
    const inserted = repo.rolloverCycle(
      makeCycle({
        id: 'cycle_2',
        cycleNumber: 2,
        status: 'ACTIVE',
        realizedPnlUsd: 0,
        startedAt: rolloverTime,
      })
    );

    expect(inserted.id).toBe('cycle_2');
    expect(inserted.cycleNumber).toBe(2);
    expect(inserted.realizedPnlUsd).toBe(0);

    const cycles = repo.listCycles();
    expect(cycles).toHaveLength(2);

    const cycle1 = cycles.find((c) => c.id === 'cycle_1');
    const cycle2 = cycles.find((c) => c.id === 'cycle_2');

    expect(cycle1?.status).toBe('FAILED_TRAILING');
    expect(cycle1?.closedAt).toBe(rolloverTime);
    expect(cycle2?.status).toBe('ACTIVE');
    expect(cycle2?.realizedPnlUsd).toBe(0);
    expect(repo.countConsecutivePassedCycles()).toBe(0);
  });

  it('rolloverCycle allows rollover from PASSED and preserves streak', () => {
    repo.createCycle(
      makeCycle({
        id: 'cycle_1',
        cycleNumber: 1,
        status: 'PASSED',
        netPnlUsd: 2_550,
        realizedPnlUsd: 2_550,
        closedAt: 1_700_000_100_000,
      })
    );

    const inserted = repo.rolloverCycle(
      makeCycle({
        id: 'cycle_2',
        cycleNumber: 2,
        status: 'ACTIVE',
        startedAt: 1_700_000_200_000,
      })
    );

    expect(inserted.cycleNumber).toBe(2);
    expect(repo.getActiveCycle()?.id).toBe('cycle_2');
    expect(repo.countConsecutivePassedCycles()).toBe(1);
  });

  it('realized_pnl_usd persists separately from net_pnl_usd across reads and idempotent schema migration', () => {
    repo.createCycle(
      makeCycle({
        id: 'cycle_1',
        cycleNumber: 1,
        status: 'ACTIVE',
        netPnlUsd: 0,
        realizedPnlUsd: 0,
      })
    );

    repo.updateCycle('cycle_1', {
      netPnlUsd: 500,
      realizedPnlUsd: 100,
      currentEquityUsd: 50_500,
    });

    const active = repo.getActiveCycle();
    expect(active?.netPnlUsd).toBe(500);
    expect(active?.realizedPnlUsd).toBe(100);

    // Idempotent schema re-run should not throw or clobber realized_pnl_usd
    expect(() => ensurePropFirmSchema(db)).not.toThrow();
    const afterMigration = repo.getLatestCycle();
    expect(afterMigration?.netPnlUsd).toBe(500);
    expect(afterMigration?.realizedPnlUsd).toBe(100);
  });
});
