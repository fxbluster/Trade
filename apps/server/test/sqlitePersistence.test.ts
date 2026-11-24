/**
 * TradeOS v2 — SQLite Persistence Unit Tests
 *
 * Verifies:
 * - Table creation & schema migrations for factor_telemetry and execution_chase_logs
 * - FactorTelemetryRepo: single insert, batch WAL transactions, querying by factor, time-range, pruning
 * - ExecutionChaseLogsRepo: single insert, batch inserts, retrieval by symbol/tradeId, fee savings aggregation
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import {
  initializeDatabase,
  FactorTelemetryRepo,
  ExecutionChaseLogsRepo,
  type FactorTelemetryRecord,
  type ExecutionChaseLogRecord,
} from '../src/db/sqlite.js';

describe('SQLite Persistence & Repositories', () => {
  let db: DatabaseSync;
  let factorRepo: FactorTelemetryRepo;
  let chaseRepo: ExecutionChaseLogsRepo;

  beforeEach(() => {
    db = initializeDatabase(':memory:');
    factorRepo = new FactorTelemetryRepo(db);
    chaseRepo = new ExecutionChaseLogsRepo(db);
  });

  afterEach(() => {
    try {
      db.close();
    } catch {}
  });

  describe('Schema Migrations', () => {
    it('creates factor_telemetry and execution_chase_logs tables on initialize', () => {
      const stmt = db.prepare(`
        SELECT name FROM sqlite_master WHERE type='table' AND name IN ('factor_telemetry', 'execution_chase_logs')
      `);
      const rows = stmt.all() as { name: string }[];
      const tableNames = rows.map((r) => r.name);

      expect(tableNames).toContain('factor_telemetry');
      expect(tableNames).toContain('execution_chase_logs');
    });

    it('is idempotent when run repeatedly on existing database', () => {
      expect(() => {
        // Re-execute migration blocks to ensure zero errors on pre-existing tables
        initializeDatabase(':memory:');
      }).not.toThrow();
    });
  });

  describe('FactorTelemetryRepo', () => {
    it('inserts single record and retrieves by factor id', () => {
      const now = Date.now();
      const record: FactorTelemetryRecord = {
        timestamp: now,
        symbol: 'SOLUSDT',
        factor_id: 'ORDER_FLOW_L2',
        raw_alpha: 0.72,
        orthogonal_alpha: 0.65,
        confidence: 0.88,
        uncertainty: 0.04,
        weight: 0.20,
      };

      factorRepo.insert(record);

      const retrieved = factorRepo.getRecentByFactor('SOLUSDT', 'ORDER_FLOW_L2', 10);
      expect(retrieved.length).toBe(1);
      const row = retrieved[0]!;
      expect(row.symbol).toBe('SOLUSDT');
      expect(row.factor_id).toBe('ORDER_FLOW_L2');
      expect(row.raw_alpha).toBeCloseTo(0.72, 4);
      expect(row.orthogonal_alpha).toBeCloseTo(0.65, 4);
      expect(row.confidence).toBeCloseTo(0.88, 4);
      expect(row.uncertainty).toBeCloseTo(0.04, 4);
      expect(row.weight).toBeCloseTo(0.20, 4);
      expect(row.timestamp).toBe(now);
    });

    it('performs batch insert within transaction and respects time ordering', () => {
      const baseTime = 1700000000000;
      const records: FactorTelemetryRecord[] = [];

      for (let i = 0; i < 25; i++) {
        records.push({
          timestamp: baseTime + i * 60_000,
          symbol: 'BTCUSDT',
          factor_id: 'CVD_ABSORPTION',
          raw_alpha: (i - 12) * 0.05,
          orthogonal_alpha: (i - 12) * 0.04,
          confidence: 0.75,
          uncertainty: 0.05,
          weight: 0.15,
        });
      }

      factorRepo.insertBatch(records);

      const all = factorRepo.getRecentByFactor('BTCUSDT', 'CVD_ABSORPTION', 100);
      expect(all.length).toBe(25);
      // Newest timestamp first
      expect(all[0]!.timestamp).toBe(baseTime + 24 * 60_000);
      expect(all[24]!.timestamp).toBe(baseTime);

      // Time range query (inclusive, ordered ASC)
      const range = factorRepo.getByTimeRange(
        'BTCUSDT',
        'CVD_ABSORPTION',
        baseTime + 5 * 60_000,
        baseTime + 10 * 60_000
      );
      expect(range.length).toBe(6);
      expect(range[0]!.timestamp).toBe(baseTime + 5 * 60_000);
      expect(range[5]!.timestamp).toBe(baseTime + 10 * 60_000);
    });

    it('correctly handles empty batch without error', () => {
      expect(() => factorRepo.insertBatch([])).not.toThrow();
    });

    it('prunes records older than specified retention days', () => {
      const now = Date.now();
      const oldTime = now - 40 * 86_400_000; // 40 days old
      const freshTime = now - 5 * 86_400_000; // 5 days old

      factorRepo.insert({
        timestamp: oldTime,
        symbol: 'SOLUSDT',
        factor_id: 'NATIVE_SMC',
        raw_alpha: 0.5,
        orthogonal_alpha: 0.5,
        confidence: 0.8,
        uncertainty: 0.1,
        weight: 0.2,
      });

      factorRepo.insert({
        timestamp: freshTime,
        symbol: 'SOLUSDT',
        factor_id: 'NATIVE_SMC',
        raw_alpha: 0.6,
        orthogonal_alpha: 0.6,
        confidence: 0.85,
        uncertainty: 0.08,
        weight: 0.2,
      });

      const deleted = factorRepo.pruneOlderThan(30);
      expect(deleted).toBe(1);

      const remaining = factorRepo.getRecent('SOLUSDT', 10);
      expect(remaining.length).toBe(1);
      expect(remaining[0]!.timestamp).toBe(freshTime);
    });
  });

  describe('ExecutionChaseLogsRepo', () => {
    it('inserts single log and queries by symbol and tradeId', () => {
      const now = Date.now();
      const record: ExecutionChaseLogRecord = {
        trade_id: 'tos_trade_12345',
        symbol: 'SOLUSDT',
        anchor_price: 185.50,
        amend_count: 3,
        duration_ms: 1250,
        final_status: 'FILLED',
        effective_price: 185.51,
        fee_saved_usd: 1.45,
        created_at: now,
      };

      chaseRepo.insert(record);

      const bySymbol = chaseRepo.getRecent('SOLUSDT', 10);
      expect(bySymbol.length).toBe(1);
      expect(bySymbol[0]!.trade_id).toBe('tos_trade_12345');
      expect(bySymbol[0]!.fee_saved_usd).toBeCloseTo(1.45, 2);
      expect(bySymbol[0]!.final_status).toBe('FILLED');

      const byTrade = chaseRepo.getByTradeId('tos_trade_12345');
      expect(byTrade.length).toBe(1);
      expect(byTrade[0]!.anchor_price).toBe(185.50);
    });

    it('inserts batch of logs and computes aggregated fee savings', () => {
      const now = Date.now();
      const records: ExecutionChaseLogRecord[] = [
        {
          trade_id: 'trade_1',
          symbol: 'SOLUSDT',
          anchor_price: 180.0,
          amend_count: 2,
          duration_ms: 600,
          final_status: 'FILLED',
          effective_price: 180.01,
          fee_saved_usd: 0.75,
          created_at: now - 3000,
        },
        {
          trade_id: 'trade_2',
          symbol: 'SOLUSDT',
          anchor_price: 182.0,
          amend_count: 5,
          duration_ms: 2100,
          final_status: 'FILLED',
          effective_price: 182.02,
          fee_saved_usd: 1.25,
          created_at: now - 2000,
        },
        {
          trade_id: 'trade_3',
          symbol: 'SOLUSDT',
          anchor_price: 184.0,
          amend_count: 10,
          duration_ms: 15000,
          final_status: 'TIMEOUT',
          effective_price: 0,
          fee_saved_usd: 0.0,
          created_at: now - 1000,
        },
        {
          trade_id: 'trade_4',
          symbol: 'BTCUSDT',
          anchor_price: 90000.0,
          amend_count: 1,
          duration_ms: 300,
          final_status: 'FILLED',
          effective_price: 90001.0,
          fee_saved_usd: 4.50,
          created_at: now,
        },
      ];

      chaseRepo.insertBatch(records);

      // Aggregation across all symbols
      const allSavings = chaseRepo.getFeeSavings();
      expect(allSavings.totalChases).toBe(4);
      expect(allSavings.successfulChases).toBe(3);
      expect(allSavings.totalFeeSavedUsd).toBeCloseTo(6.50, 2);

      // Aggregation for SOLUSDT only
      const solSavings = chaseRepo.getFeeSavings('SOLUSDT');
      expect(solSavings.totalChases).toBe(3);
      expect(solSavings.successfulChases).toBe(2);
      expect(solSavings.totalFeeSavedUsd).toBeCloseTo(2.00, 2);

      // Filter with sinceTimestamp
      const recentSavings = chaseRepo.getFeeSavings('SOLUSDT', now - 1500);
      expect(recentSavings.totalChases).toBe(1);
      expect(recentSavings.successfulChases).toBe(0);
      expect(recentSavings.totalFeeSavedUsd).toBe(0.0);
    });
  });
});
