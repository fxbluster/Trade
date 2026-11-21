import { describe, it, expect, beforeEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import {
  initializeDatabase,
  DecisionLogsRepo,
  TradesRepo,
} from '../sqlite.js';
import type { DecisionLogRecord, TradeRecord } from '@tradeos/shared';

describe('DecisionLogsRepo — SQLite Decision Audit Storage', () => {
  let db: DatabaseSync;
  let repo: DecisionLogsRepo;
  let tradesRepo: TradesRepo;

  beforeEach(() => {
    db = initializeDatabase(':memory:');
    repo = new DecisionLogsRepo(db);
    tradesRepo = new TradesRepo(db);
  });

  const createSampleRecord = (overrides?: Partial<DecisionLogRecord>): DecisionLogRecord => ({
    id: 'dec-1',
    timestamp: 1000,
    symbol: 'SOLUSDT',
    side: 'BUY',
    action: 'BLOCKED',
    composite_score: 65.0,
    pillars_json: JSON.stringify({ MACRO_REGIME: { score: 60 } }),
    macro_regime: 'MACRO_BULLISH',
    macro_veto_active: 1,
    veto_reasons_json: JSON.stringify(['MACRO_VETO_BELOW_EMA200']),
    execution_price: 150.0,
    margin_usd: 100.0,
    leverage: 10,
    atr: 2.5,
    trade_id: null,
    shadow_status: 'OPEN',
    shadow_sl: 145.0,
    shadow_tp: 160.0,
    shadow_pnl_usd: null,
    expires_at: 4600,
    shadow_closed_at: null,
    error_message: null,
    created_at: 1000,
    ...overrides,
  });

  describe('insert and getOpenShadowSetups', () => {
    it('inserts and retrieves open shadow setups by symbol and overall', () => {
      const rec1 = createSampleRecord({ id: 'dec-1', symbol: 'SOLUSDT', shadow_status: 'OPEN' });
      const rec2 = createSampleRecord({ id: 'dec-2', symbol: 'BTCUSDT', shadow_status: 'OPEN', side: 'SELL' });
      const rec3 = createSampleRecord({ id: 'dec-3', symbol: 'SOLUSDT', shadow_status: 'SAVED_CAPITAL' });

      repo.insert(rec1);
      repo.insert(rec2);
      repo.insert(rec3);

      const openAll = repo.getOpenShadowSetups();
      expect(openAll).toHaveLength(2);
      expect(openAll.map((r) => r.id)).toEqual(['dec-1', 'dec-2']);

      const openSol = repo.getOpenShadowSetups('SOLUSDT');
      expect(openSol).toHaveLength(1);
      expect(openSol[0].id).toBe('dec-1');
      expect(openSol[0].symbol).toBe('SOLUSDT');
      expect(openSol[0].composite_score).toBe(65.0);
      expect(openSol[0].macro_veto_active).toBe(1);

      const openBtc = repo.getOpenShadowSetups('BTCUSDT');
      expect(openBtc).toHaveLength(1);
      expect(openBtc[0].id).toBe('dec-2');

      const openEth = repo.getOpenShadowSetups('ETHUSDT');
      expect(openEth).toHaveLength(0);
    });
  });

  describe('hasOpenShadowSetup', () => {
    it('returns true only when an open setup exists for matching symbol and side', () => {
      repo.insert(createSampleRecord({ id: 'dec-1', symbol: 'SOLUSDT', side: 'BUY', shadow_status: 'OPEN' }));

      expect(repo.hasOpenShadowSetup('SOLUSDT', 'BUY')).toBe(true);
      expect(repo.hasOpenShadowSetup('SOLUSDT', 'SELL')).toBe(false);
      expect(repo.hasOpenShadowSetup('BTCUSDT', 'BUY')).toBe(false);

      // Close the setup
      repo.updateShadowOutcome('dec-1', 'SAVED_CAPITAL', 50.0, 2000);
      expect(repo.hasOpenShadowSetup('SOLUSDT', 'BUY')).toBe(false);
    });
  });

  describe('updateShadowOutcome', () => {
    it('updates shadow_status, shadow_pnl_usd, and shadow_closed_at', () => {
      repo.insert(createSampleRecord({ id: 'dec-update', shadow_status: 'OPEN' }));

      repo.updateShadowOutcome('dec-update', 'SAVED_CAPITAL', 125.75, 5000);

      const records = repo.listSessionDecisions(0);
      const updated = records.find((r) => r.id === 'dec-update');
      expect(updated).toBeDefined();
      expect(updated?.shadow_status).toBe('SAVED_CAPITAL');
      expect(updated?.shadow_pnl_usd).toBe(125.75);
      expect(updated?.shadow_closed_at).toBe(5000);
    });
  });

  describe('listSessionDecisions', () => {
    it('retrieves decisions filtered by timestamp >= sinceMs ordered by timestamp ASC', () => {
      repo.insert(createSampleRecord({ id: 'd-100', timestamp: 100 }));
      repo.insert(createSampleRecord({ id: 'd-300', timestamp: 300 }));
      repo.insert(createSampleRecord({ id: 'd-200', timestamp: 200 }));

      const all = repo.listSessionDecisions(0);
      expect(all.map((r) => r.id)).toEqual(['d-100', 'd-200', 'd-300']);

      const filtered = repo.listSessionDecisions(200);
      expect(filtered.map((r) => r.id)).toEqual(['d-200', 'd-300']);

      const none = repo.listSessionDecisions(500);
      expect(none).toEqual([]);
    });
  });

  describe('pruneOldRecords', () => {
    it('deletes records older than retentionDays cutoff and returns count of removed rows', () => {
      const now = Date.now();
      const tenDaysAgo = now - 10 * 86_400_000;
      const fortyDaysAgo = now - 40 * 86_400_000;
      const fiftyDaysAgo = now - 50 * 86_400_000;

      repo.insert(createSampleRecord({ id: 'old-1', timestamp: fiftyDaysAgo }));
      repo.insert(createSampleRecord({ id: 'old-2', timestamp: fortyDaysAgo }));
      repo.insert(createSampleRecord({ id: 'recent-1', timestamp: tenDaysAgo }));

      // Prune with retentionDays = 30 (deletes records older than 30 days)
      const deletedCount = repo.pruneOldRecords(30);
      expect(deletedCount).toBe(2);

      const remaining = repo.listSessionDecisions(0);
      expect(remaining).toHaveLength(1);
      expect(remaining[0].id).toBe('recent-1');
    });

    it('defaults to 30 days when retentionDays is not passed', () => {
      const now = Date.now();
      const sixtyDaysAgo = now - 60 * 86_400_000;

      repo.insert(createSampleRecord({ id: 'old-default', timestamp: sixtyDaysAgo }));

      const deleted = repo.pruneOldRecords();
      expect(deleted).toBe(1);

      expect(repo.listSessionDecisions(0)).toHaveLength(0);
    });
  });

  describe('Foreign key constraints and ON DELETE SET NULL', () => {
    it('nullifies trade_id in decision_logs when associated trade is deleted', () => {
      const tradeId = 'trade-fk-1';
      const sampleTrade: TradeRecord = {
        id: tradeId,
        symbol: 'SOLUSDT',
        broker_mode: 'LOCAL_PAPER',
        side: 'BUY',
        status: 'CLOSED',
        entry_price: 150.0,
        exit_price: 155.0,
        quantity: 1.0,
        remaining_qty: 0,
        leverage: 5,
        margin_usd: 30.0,
        stop_loss: 145.0,
        tp1: 155.0,
        tp2: 160.0,
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
        realized_pnl: 5.0,
        fees_usd: 0.1,
        exit_reason: 'TP1',
        opened_at: 1000,
        closed_at: 2000,
      };

      tradesRepo.insert(sampleTrade);

      repo.insert(
        createSampleRecord({
          id: 'dec-with-trade',
          trade_id: tradeId,
          action: 'EXECUTED',
        })
      );

      let record = repo.listSessionDecisions(0).find((r) => r.id === 'dec-with-trade');
      expect(record?.trade_id).toBe(tradeId);

      // Delete trade from trades table
      db.prepare('DELETE FROM trades WHERE id = ?').run(tradeId);

      record = repo.listSessionDecisions(0).find((r) => r.id === 'dec-with-trade');
      expect(record?.trade_id).toBeNull();
    });
  });
});
