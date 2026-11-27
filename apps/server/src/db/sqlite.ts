import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import type {
  TradeRecord,
  FillRecord,
  RiskStateRecord,
  AuditLogRecord,
  BrokerMode,
  DecisionLogRecord,
  ShadowSetupStatus,
  TradeSide,
  TrajectoryHorizon,
  ImpulseTriggerType,
  TelemetryStatus,
  TrajectoryOutcome,
  PillarAttributionStatus,
  PillarSnapshotJson,
  PillarTelemetryRecord,
  PillarHorizonEvaluation,
  PillarScorecardItem,
  PillarAttributionResponse,
  PillarDailyScorecardRecord,
  ConfluencePillarId,
  EconomicEvent,
  FactorTelemetryEvent,
  FactorTelemetryDbRecord,
  FactorTelemetryTriggerType,
  FactorStateDetail,
  QuantConvictionArchetype,
  PropFirmChallengeCycle,
  PropFirmCycleStatus,
  PropFirmDailySnapshot,
} from '@tradeos/shared';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Initializes SQLite database with WAL pragma and creates all required tables.
 * Safely creates the parent directory if a file path is supplied.
 */
export function initializeDatabase(dbPath: string): DatabaseSync {
  if (dbPath !== ':memory:') {
    fs.mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });
  }

  const db = new DatabaseSync(dbPath);

  // Read schema SQL definition
  const schemaPath = path.join(__dirname, 'schema.sql');
  const schemaSql = fs.readFileSync(schemaPath, 'utf-8');

  // Execute schema DDL
  db.exec(schemaSql);

  // Schema migrations for existing databases
  try {
    db.exec('ALTER TABLE trades ADD COLUMN peak_price REAL;');
  } catch {}
  try {
    db.exec('ALTER TABLE trades ADD COLUMN peak_mfe REAL;');
  } catch {}
  try {
    db.exec('ALTER TABLE trades ADD COLUMN trailing_stop_active INTEGER DEFAULT 0;');
  } catch {}
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS economic_events (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        impact TEXT NOT NULL,
        currency TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_economic_events_ts ON economic_events(timestamp);
    `);
  } catch {}
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS factor_telemetry (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp INTEGER NOT NULL,
        symbol TEXT NOT NULL,
        factor_id TEXT NOT NULL,
        raw_alpha REAL NOT NULL,
        orthogonal_alpha REAL NOT NULL,
        confidence REAL NOT NULL,
        uncertainty REAL NOT NULL,
        weight REAL NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_factor_telemetry_sym_factor ON factor_telemetry(symbol, factor_id, timestamp);
      CREATE INDEX IF NOT EXISTS idx_factor_telemetry_ts ON factor_telemetry(timestamp);
    `);
  } catch {}
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS execution_chase_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        trade_id TEXT NOT NULL,
        symbol TEXT NOT NULL,
        anchor_price REAL NOT NULL,
        amend_count INTEGER NOT NULL,
        duration_ms INTEGER NOT NULL,
        final_status TEXT NOT NULL,
        effective_price REAL NOT NULL,
        fee_saved_usd REAL NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_execution_chase_trade_id ON execution_chase_logs(trade_id);
      CREATE INDEX IF NOT EXISTS idx_execution_chase_sym_ts ON execution_chase_logs(symbol, created_at);
    `);
  } catch {}

  ensureNextGenTelemetrySchema(db);
  ensurePropFirmSchema(db);

  return db;
}

const FACTOR_TELEMETRY_RECORDS_DDL = `
  CREATE TABLE IF NOT EXISTS factor_telemetry_records (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    decision_log_id TEXT REFERENCES decision_logs(id) ON DELETE CASCADE,
    event_id TEXT NOT NULL,
    trigger_type TEXT NOT NULL,
    timestamp INTEGER NOT NULL,
    symbol TEXT NOT NULL,
    consensus_side TEXT NOT NULL,
    entry_price REAL NOT NULL,
    composite_score REAL NOT NULL,
    factor_id TEXT NOT NULL,
    raw_alpha REAL NOT NULL,
    orthogonal_alpha REAL NOT NULL,
    effective_weight REAL NOT NULL,
    is_collinear INTEGER NOT NULL,
    confidence REAL DEFAULT 0,
    summary_text TEXT,
    telemetry_payload_json TEXT,
    status TEXT DEFAULT 'EVALUATING',
    settle_timestamp INTEGER,
    post_1m_mfe REAL,
    post_1m_mae REAL,
    post_5m_mfe REAL,
    post_5m_mae REAL,
    post_15m_mfe REAL,
    post_15m_mae REAL,
    post_1h_mfe REAL,
    post_1h_mae REAL
  );
  CREATE INDEX IF NOT EXISTS idx_factor_telemetry_factor_time ON factor_telemetry_records(factor_id, timestamp);
  CREATE INDEX IF NOT EXISTS idx_factor_telemetry_status ON factor_telemetry_records(status, symbol, timestamp);
  CREATE INDEX IF NOT EXISTS idx_factor_telemetry_event_id ON factor_telemetry_records(event_id);
`;

/**
 * Idempotently upgrades pre-Next-Gen SQLite databases with WAL autocheckpoint,
 * decision_logs JSON telemetry columns, and factor_telemetry_records table/indexes.
 */
export function ensureNextGenTelemetrySchema(db: DatabaseSync): void {
  db.exec('PRAGMA wal_autocheckpoint = 1000;');
  try {
    db.exec('ALTER TABLE decision_logs ADD COLUMN factor_telemetry_json TEXT;');
  } catch {}
  try {
    db.exec('ALTER TABLE decision_logs ADD COLUMN execution_chase_json TEXT;');
  } catch {}
  try {
    db.exec('ALTER TABLE decision_logs ADD COLUMN sizing_breakdown_json TEXT;');
  } catch {}
  try {
    db.exec('ALTER TABLE decision_logs ADD COLUMN noise_band_state INTEGER DEFAULT 0;');
  } catch {}
  try {
    db.exec(FACTOR_TELEMETRY_RECORDS_DDL);
  } catch {}
}

const PROPFIRM_SCHEMA_DDL = `
  CREATE TABLE IF NOT EXISTS propfirm_challenge_cycles (
    id TEXT PRIMARY KEY,
    cycle_number INTEGER NOT NULL,
    status TEXT NOT NULL,
    starting_balance_usd REAL NOT NULL,
    current_equity_usd REAL NOT NULL,
    high_water_mark_usd REAL NOT NULL,
    contractual_trailing_floor_usd REAL NOT NULL,
    internal_trailing_floor_usd REAL NOT NULL,
    is_floor_locked INTEGER NOT NULL DEFAULT 0,
    profit_target_usd REAL NOT NULL,
    net_pnl_usd REAL NOT NULL DEFAULT 0,
    realized_pnl_usd REAL NOT NULL DEFAULT 0,
    net_pnl_pct REAL NOT NULL DEFAULT 0,
    max_drawdown_usd REAL NOT NULL DEFAULT 0,
    trades_count INTEGER NOT NULL DEFAULT 0,
    win_count INTEGER NOT NULL DEFAULT 0,
    loss_count INTEGER NOT NULL DEFAULT 0,
    started_at INTEGER NOT NULL,
    closed_at INTEGER
  );

  CREATE INDEX IF NOT EXISTS idx_propfirm_cycles_num ON propfirm_challenge_cycles(cycle_number DESC);
  CREATE INDEX IF NOT EXISTS idx_propfirm_cycles_status ON propfirm_challenge_cycles(status);

  CREATE TABLE IF NOT EXISTS propfirm_daily_snapshots (
    utc_date TEXT NOT NULL,
    cycle_id TEXT NOT NULL REFERENCES propfirm_challenge_cycles(id) ON DELETE CASCADE,
    day_start_equity_usd REAL NOT NULL,
    current_equity_usd REAL NOT NULL,
    daily_pnl_usd REAL NOT NULL DEFAULT 0,
    daily_min_equity_usd REAL NOT NULL,
    daily_halted INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (utc_date, cycle_id)
  );

  CREATE INDEX IF NOT EXISTS idx_propfirm_daily_date ON propfirm_daily_snapshots(utc_date DESC);
`;

/**
 * Idempotently creates Upcomers $50K Prop Firm challenge tables and indexes.
 */
export function ensurePropFirmSchema(db: DatabaseSync): void {
  db.exec(PROPFIRM_SCHEMA_DDL);
  try {
    db.exec('ALTER TABLE propfirm_challenge_cycles ADD COLUMN realized_pnl_usd REAL NOT NULL DEFAULT 0;');
  } catch {}
}

/**
 * Executes a function within an IMMEDIATE transaction with automatic rollback on error.
 */
export function runTransaction<T>(db: DatabaseSync, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE;');
  try {
    const result = fn();
    db.exec('COMMIT;');
    return result;
  } catch (err) {
    db.exec('ROLLBACK;');
    TradesRepo.invalidateActiveCacheForDb(db);
    throw err;
  }
}

const ACTIVE_TRADE_STATUSES = new Set([
  'OPEN',
  'PARTIALLY_CLOSED',
  'CLOSING',
  'CLOSING_IN_PROGRESS',
]);

/**
 * Repository for trades table.
 */
export class TradesRepo {
  private static readonly cacheByDb = new WeakMap<
    DatabaseSync,
    Map<string, TradeRecord | null>
  >();

  public static invalidateActiveCacheForDb(
    db: DatabaseSync,
    brokerMode?: BrokerMode,
    symbol?: string
  ): void {
    const cache = TradesRepo.cacheByDb.get(db);
    if (!cache) return;
    if (brokerMode && symbol) {
      cache.delete(`${brokerMode}:${symbol.toUpperCase()}`);
      return;
    }
    if (brokerMode) {
      const prefix = `${brokerMode}:`;
      for (const key of cache.keys()) {
        if (key.startsWith(prefix)) {
          cache.delete(key);
        }
      }
      return;
    }
    cache.clear();
  }

  private readonly activePositionCache: Map<string, TradeRecord | null>;

  constructor(private db: DatabaseSync) {
    let shared = TradesRepo.cacheByDb.get(db);
    if (!shared) {
      shared = new Map<string, TradeRecord | null>();
      TradesRepo.cacheByDb.set(db, shared);
    }
    this.activePositionCache = shared;
  }

  private cacheKey(brokerMode: BrokerMode, symbol: string): string {
    return `${brokerMode}:${symbol.toUpperCase()}`;
  }

  public getActivePositionCached(brokerMode: BrokerMode, symbol: string): TradeRecord | null {
    const key = this.cacheKey(brokerMode, symbol);
    if (this.activePositionCache.has(key)) {
      return this.activePositionCache.get(key) ?? null;
    }
    const pos = this.getActivePosition(brokerMode, symbol.toUpperCase());
    this.activePositionCache.set(key, pos ? { ...pos } : null);
    return pos;
  }

  public invalidateActiveCache(brokerMode?: BrokerMode, symbol?: string): void {
    TradesRepo.invalidateActiveCacheForDb(this.db, brokerMode, symbol);
  }

  insert(trade: TradeRecord): void {
    const stmt = this.db.prepare(`
      INSERT INTO trades (
        id, symbol, broker_mode, side, status, entry_price, exit_price,
        quantity, remaining_qty, leverage, margin_usd, stop_loss, tp1, tp2,
        be_price, is_breakeven, peak_price, peak_mfe, trailing_stop_active,
        client_order_id, client_sl_id, client_tp1_id,
        client_tp2_id, entry_order_id, sl_algo_id, tp1_algo_id, tp2_algo_id,
        realized_pnl, fees_usd, exit_reason, opened_at, closed_at
      ) VALUES (
        ?, ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?,
        ?, ?, ?,
        ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?
      )
    `);

    stmt.run(
      trade.id,
      trade.symbol,
      trade.broker_mode,
      trade.side,
      trade.status,
      trade.entry_price,
      trade.exit_price ?? null,
      trade.quantity,
      trade.remaining_qty,
      trade.leverage,
      trade.margin_usd,
      trade.stop_loss ?? null,
      trade.tp1 ?? null,
      trade.tp2 ?? null,
      trade.be_price ?? null,
      trade.is_breakeven,
      trade.peak_price ?? null,
      trade.peak_mfe ?? null,
      trade.trailing_stop_active ?? 0,
      trade.client_order_id ?? null,
      trade.client_sl_id ?? null,
      trade.client_tp1_id ?? null,
      trade.client_tp2_id ?? null,
      trade.entry_order_id ?? null,
      trade.sl_algo_id ?? null,
      trade.tp1_algo_id ?? null,
      trade.tp2_algo_id ?? null,
      trade.realized_pnl,
      trade.fees_usd,
      trade.exit_reason ?? null,
      trade.opened_at,
      trade.closed_at ?? null
    );

    const key = this.cacheKey(trade.broker_mode, trade.symbol);
    if (ACTIVE_TRADE_STATUSES.has(trade.status)) {
      this.activePositionCache.set(key, { ...trade });
    } else if (this.activePositionCache.get(key)?.id === trade.id) {
      this.activePositionCache.set(key, null);
    }
  }

  getById(id: string): TradeRecord | null {
    const stmt = this.db.prepare('SELECT * FROM trades WHERE id = ?');
    const row = stmt.get(id);
    return row ? (row as unknown as TradeRecord) : null;
  }

  getActivePosition(brokerMode: BrokerMode, symbol?: string): TradeRecord | null {
    if (symbol) {
      const symUpper = symbol.toUpperCase();
      const stmt = this.db.prepare(`
        SELECT * FROM trades 
        WHERE broker_mode = ? AND symbol = ? AND status IN ('OPEN', 'PARTIALLY_CLOSED', 'CLOSING', 'CLOSING_IN_PROGRESS')
        ORDER BY opened_at DESC LIMIT 1
      `);
      const row = stmt.get(brokerMode, symUpper);
      const pos = row ? (row as unknown as TradeRecord) : null;
      this.activePositionCache.set(this.cacheKey(brokerMode, symUpper), pos ? { ...pos } : null);
      return pos;
    } else {
      const stmt = this.db.prepare(`
        SELECT * FROM trades 
        WHERE broker_mode = ? AND status IN ('OPEN', 'PARTIALLY_CLOSED', 'CLOSING', 'CLOSING_IN_PROGRESS')
        ORDER BY opened_at DESC LIMIT 1
      `);
      const row = stmt.get(brokerMode);
      return row ? (row as unknown as TradeRecord) : null;
    }
  }

  getActivePositions(brokerMode: BrokerMode): TradeRecord[] {
    const stmt = this.db.prepare(`
      SELECT * FROM trades 
      WHERE broker_mode = ? AND status IN ('OPEN', 'PARTIALLY_CLOSED', 'CLOSING', 'CLOSING_IN_PROGRESS')
      ORDER BY opened_at DESC
    `);
    return stmt.all(brokerMode) as unknown as TradeRecord[];
  }

  getAllActivePositions(brokerMode: BrokerMode): TradeRecord[] {
    const stmt = this.db.prepare(`
      SELECT * FROM trades 
      WHERE broker_mode = ? AND status IN ('OPEN', 'PARTIALLY_CLOSED', 'CLOSING', 'CLOSING_IN_PROGRESS')
      ORDER BY opened_at DESC
    `);
    return stmt.all(brokerMode) as unknown as TradeRecord[];
  }

  getActiveSymbols(brokerMode: BrokerMode): string[] {
    const stmt = this.db.prepare(`
      SELECT DISTINCT symbol FROM trades
      WHERE broker_mode = ? AND status IN ('OPEN', 'PARTIALLY_CLOSED', 'CLOSING', 'CLOSING_IN_PROGRESS')
    `);
    const rows = stmt.all(brokerMode) as Array<{ symbol: string }>;
    return rows.map((r) => r.symbol.toUpperCase());
  }

  getLatestTrade(brokerMode: BrokerMode, symbol?: string): TradeRecord | null {
    if (symbol) {
      const stmt = this.db.prepare(`
        SELECT * FROM trades 
        WHERE broker_mode = ? AND symbol = ?
        ORDER BY opened_at DESC LIMIT 1
      `);
      const row = stmt.get(brokerMode, symbol);
      return row ? (row as unknown as TradeRecord) : null;
    } else {
      const stmt = this.db.prepare(`
        SELECT * FROM trades 
        WHERE broker_mode = ?
        ORDER BY opened_at DESC LIMIT 1
      `);
      const row = stmt.get(brokerMode);
      return row ? (row as unknown as TradeRecord) : null;
    }
  }

  update(id: string, updates: Partial<TradeRecord>): void {
    const keys = Object.keys(updates).filter(k => k !== 'id');
    if (keys.length === 0) return;

    const setClauses = keys.map(k => `${k} = ?`).join(', ');
    const values = keys.map(k => (updates as Record<string, unknown>)[k] ?? null) as (string | number | null)[];

    const stmt = this.db.prepare(`UPDATE trades SET ${setClauses} WHERE id = ?`);
    stmt.run(...values, id);

    const updated = this.getById(id);
    if (updated) {
      const key = this.cacheKey(updated.broker_mode, updated.symbol);
      if (ACTIVE_TRADE_STATUSES.has(updated.status)) {
        this.activePositionCache.set(key, { ...updated });
      } else {
        // Re-sync cache entry (null if no other active trade for this mode+symbol)
        this.getActivePosition(updated.broker_mode, updated.symbol);
      }
    }
  }

  listClosed(brokerMode: BrokerMode, limit: number = 50, offset: number = 0, symbol?: string): TradeRecord[] {
    if (symbol) {
      const stmt = this.db.prepare(`
        SELECT * FROM trades 
        WHERE broker_mode = ? AND symbol = ? AND status = 'CLOSED'
        ORDER BY closed_at DESC LIMIT ? OFFSET ?
      `);
      return stmt.all(brokerMode, symbol, limit, offset) as unknown as TradeRecord[];
    } else {
      const stmt = this.db.prepare(`
        SELECT * FROM trades 
        WHERE broker_mode = ? AND status = 'CLOSED'
        ORDER BY closed_at DESC LIMIT ? OFFSET ?
      `);
      return stmt.all(brokerMode, limit, offset) as unknown as TradeRecord[];
    }
  }

  listClosedAsc(brokerMode: BrokerMode, symbol?: string): TradeRecord[] {
    if (symbol) {
      const stmt = this.db.prepare(`
        SELECT * FROM trades
        WHERE broker_mode = ? AND symbol = ? AND status = 'CLOSED'
        ORDER BY closed_at ASC, opened_at ASC
      `);
      return stmt.all(brokerMode, symbol) as unknown as TradeRecord[];
    } else {
      const stmt = this.db.prepare(`
        SELECT * FROM trades
        WHERE broker_mode = ? AND status = 'CLOSED'
        ORDER BY closed_at ASC, opened_at ASC
      `);
      return stmt.all(brokerMode) as unknown as TradeRecord[];
    }
  }

  countClosed(brokerMode: BrokerMode, symbol?: string): number {
    if (symbol) {
      const stmt = this.db.prepare(`
        SELECT COUNT(*) as count FROM trades 
        WHERE broker_mode = ? AND symbol = ? AND status = 'CLOSED'
      `);
      const row = stmt.get(brokerMode, symbol) as { count: number } | undefined;
      return row?.count ?? 0;
    } else {
      const stmt = this.db.prepare(`
        SELECT COUNT(*) as count FROM trades 
        WHERE broker_mode = ? AND status = 'CLOSED'
      `);
      const row = stmt.get(brokerMode) as { count: number } | undefined;
      return row?.count ?? 0;
    }
  }

  getFilledTradeCountToday(brokerMode: BrokerMode, symbol: string, startOfDayMs: number): number {
    const stmt = this.db.prepare(`
      SELECT COUNT(*) as count FROM trades 
      WHERE broker_mode = ? AND symbol = ? AND opened_at >= ?
    `);
    const row = stmt.get(brokerMode, symbol, startOfDayMs) as { count: number } | undefined;
    return row?.count ?? 0;
  }

  getDailyRealizedPnl(brokerMode: BrokerMode, startOfDayMs: number): { realizedPnl: number; feesUsd: number; netPnl: number } {
    const stmt = this.db.prepare(`
      SELECT 
        COALESCE(SUM(realized_pnl), 0) as realizedPnl,
        COALESCE(SUM(fees_usd), 0) as feesUsd
      FROM trades
      WHERE broker_mode = ? AND (closed_at >= ? OR opened_at >= ?)
    `);
    const row = stmt.get(brokerMode, startOfDayMs, startOfDayMs) as { realizedPnl: number; feesUsd: number } | undefined;
    const realizedPnl = row?.realizedPnl ?? 0;
    const feesUsd = row?.feesUsd ?? 0;
    return {
      realizedPnl,
      feesUsd,
      netPnl: realizedPnl - feesUsd,
    };
  }
}

/**
 * Repository for fills table.
 */
export class FillsRepo {
  constructor(private db: DatabaseSync) {}

  insert(fill: FillRecord): void {
    const stmt = this.db.prepare(`
      INSERT INTO fills (
        binance_trade_id, trade_id, order_id, symbol, side,
        price, qty, realized_pnl, commission, commission_asset, filled_at
      ) VALUES (
        ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?, ?
      )
    `);

    stmt.run(
      fill.binance_trade_id,
      fill.trade_id,
      fill.order_id,
      fill.symbol,
      fill.side,
      fill.price,
      fill.qty,
      fill.realized_pnl,
      fill.commission,
      fill.commission_asset ?? null,
      fill.filled_at
    );
  }

  getByTradeId(tradeId: string): FillRecord[] {
    const stmt = this.db.prepare('SELECT * FROM fills WHERE trade_id = ? ORDER BY filled_at ASC');
    return stmt.all(tradeId) as unknown as FillRecord[];
  }

  exists(binanceTradeId: string): boolean {
    const stmt = this.db.prepare('SELECT 1 FROM fills WHERE binance_trade_id = ?');
    return !!stmt.get(binanceTradeId);
  }
}

/**
 * Repository for risk_state table.
 */
export class RiskStateRepo {
  constructor(private db: DatabaseSync) {}

  get(brokerMode: BrokerMode): RiskStateRecord | null {
    const stmt = this.db.prepare('SELECT * FROM risk_state WHERE broker_mode = ?');
    const row = stmt.get(brokerMode);
    return row ? (row as unknown as RiskStateRecord) : null;
  }

  update(record: RiskStateRecord): void {
    const stmt = this.db.prepare(`
      INSERT INTO risk_state (
        broker_mode, consecutive_losses, cooldown_until,
        cooldown_reason, session_net_pnl, session_started_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(broker_mode) DO UPDATE SET
        consecutive_losses = excluded.consecutive_losses,
        cooldown_until = excluded.cooldown_until,
        cooldown_reason = excluded.cooldown_reason,
        session_net_pnl = excluded.session_net_pnl,
        session_started_at = excluded.session_started_at,
        updated_at = excluded.updated_at
    `);

    stmt.run(
      record.broker_mode,
      record.consecutive_losses,
      record.cooldown_until,
      record.cooldown_reason ?? null,
      record.session_net_pnl,
      record.session_started_at,
      record.updated_at
    );
  }

  resetSession(brokerMode: BrokerMode): void {
    const now = Date.now();
    const stmt = this.db.prepare(`
      UPDATE risk_state
      SET consecutive_losses = 0,
          cooldown_until = 0,
          cooldown_reason = NULL,
          session_net_pnl = 0.0,
          session_started_at = ?,
          updated_at = ?
      WHERE broker_mode = ?
    `);
    stmt.run(now, now, brokerMode);
  }
}

/**
 * Repository for settings table.
 */
export class SettingsRepo {
  constructor(private db: DatabaseSync) {}

  get<T = unknown>(key: string): T | null {
    const stmt = this.db.prepare('SELECT value_json FROM settings WHERE key = ?');
    const row = stmt.get(key) as { value_json: string } | undefined;
    if (!row) return null;
    try {
      return JSON.parse(row.value_json) as T;
    } catch {
      return null;
    }
  }

  set<T = unknown>(key: string, value: T): void {
    const now = Date.now();
    const valueJson = JSON.stringify(value);
    const stmt = this.db.prepare(`
      INSERT INTO settings (key, value_json, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET
        value_json = excluded.value_json,
        updated_at = excluded.updated_at
    `);
    stmt.run(key, valueJson, now);
  }

  delete(key: string): void {
    const stmt = this.db.prepare('DELETE FROM settings WHERE key = ?');
    stmt.run(key);
  }
}

/**
 * Repository for audit_log table.
 */
export class AuditLogRepo {
  constructor(private db: DatabaseSync) {}

  insert(entry: AuditLogRecord): void {
    const stmt = this.db.prepare(`
      INSERT INTO audit_log (id, event_type, actor, reason, payload_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      entry.id,
      entry.event_type,
      entry.actor,
      entry.reason,
      entry.payload_json ?? null,
      entry.created_at
    );
  }

  listRecent(limit: number = 100): AuditLogRecord[] {
    const stmt = this.db.prepare('SELECT * FROM audit_log ORDER BY created_at DESC LIMIT ?');
    return stmt.all(limit) as unknown as AuditLogRecord[];
  }
}

/**
 * Repository for decision_logs table.
 */
export class DecisionLogsRepo {
  constructor(private db: DatabaseSync) {}

  insert(record: DecisionLogRecord): void {
    const stmt = this.db.prepare(`
      INSERT INTO decision_logs (
        id, timestamp, symbol, side, action, composite_score,
        pillars_json, macro_regime, macro_veto_active, veto_reasons_json,
        execution_price, margin_usd, leverage, atr, trade_id,
        shadow_status, shadow_sl, shadow_tp, shadow_pnl_usd,
        expires_at, shadow_closed_at, error_message, created_at,
        factor_telemetry_json, execution_chase_json, sizing_breakdown_json, noise_band_state
      ) VALUES (
        ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?,
        ?, ?, ?, ?, ?,
        ?, ?, ?, ?,
        ?, ?, ?, ?,
        ?, ?, ?, ?
      )
    `);

    stmt.run(
      record.id,
      record.timestamp,
      record.symbol,
      record.side,
      record.action,
      record.composite_score,
      record.pillars_json,
      record.macro_regime,
      record.macro_veto_active ?? 0,
      record.veto_reasons_json ?? null,
      record.execution_price,
      record.margin_usd,
      record.leverage,
      record.atr,
      record.trade_id ?? null,
      record.shadow_status ?? null,
      record.shadow_sl ?? null,
      record.shadow_tp ?? null,
      record.shadow_pnl_usd ?? null,
      record.expires_at ?? null,
      record.shadow_closed_at ?? null,
      record.error_message ?? null,
      record.created_at,
      record.factor_telemetry_json ?? null,
      record.execution_chase_json ?? null,
      record.sizing_breakdown_json ?? null,
      record.noise_band_state ?? 0
    );
  }

  getOpenShadowSetups(symbol?: string): DecisionLogRecord[] {
    if (symbol) {
      const stmt = this.db.prepare(`
        SELECT * FROM decision_logs 
        WHERE shadow_status = 'OPEN' AND symbol = ? 
        ORDER BY timestamp ASC
      `);
      return stmt.all(symbol) as unknown as DecisionLogRecord[];
    } else {
      const stmt = this.db.prepare(`
        SELECT * FROM decision_logs 
        WHERE shadow_status = 'OPEN' 
        ORDER BY timestamp ASC
      `);
      return stmt.all() as unknown as DecisionLogRecord[];
    }
  }

  hasOpenShadowSetup(symbol: string, side: TradeSide): boolean {
    const stmt = this.db.prepare(`
      SELECT 1 FROM decision_logs 
      WHERE shadow_status = 'OPEN' AND symbol = ? AND side = ? 
      LIMIT 1
    `);
    return !!stmt.get(symbol, side);
  }

  updateShadowOutcome(id: string, status: ShadowSetupStatus, pnlUsd: number, closedAt: number): void {
    const stmt = this.db.prepare(`
      UPDATE decision_logs
      SET shadow_status = ?,
          shadow_pnl_usd = ?,
          shadow_closed_at = ?
      WHERE id = ?
    `);
    stmt.run(status, pnlUsd, closedAt, id);
  }

  listSessionDecisions(sinceMs: number): DecisionLogRecord[] {
    const stmt = this.db.prepare(`
      SELECT * FROM decision_logs 
      WHERE timestamp >= ? 
      ORDER BY timestamp ASC
    `);
    return stmt.all(sinceMs) as unknown as DecisionLogRecord[];
  }

  pruneOldRecords(retentionDays: number = 30): number {
    const cutoffMs = Date.now() - retentionDays * 86_400_000;
    const stmt = this.db.prepare('DELETE FROM decision_logs WHERE timestamp < ?');
    const result = stmt.run(cutoffMs) as { changes?: number | bigint };
    return Number(result.changes ?? 0);
  }
}

/**
 * Pillar configurations with baseline weights according to Confluence Matrix design.
 */
export const PILLAR_CONFIGS: Array<{
  id: ConfluencePillarId;
  title: string;
  baselineWeight: number; // e.g. 25.0
  pKey: 'p1' | 'p2' | 'p3' | 'p4' | 'p5' | 'p6' | 'p7';
}> = [
  { id: 'MACRO_REGIME', title: 'Macro Regime', baselineWeight: 25.0, pKey: 'p1' },
  { id: 'NATIVE_SMC', title: 'Native SMC', baselineWeight: 17.5, pKey: 'p2' },
  { id: 'CVD_ABSORPTION', title: 'CVD Absorption', baselineWeight: 20.0, pKey: 'p3' },
  { id: 'ORDER_FLOW_L2', title: 'Order Flow L2', baselineWeight: 15.0, pKey: 'p4' },
  { id: 'LIQ_CLUSTERS', title: 'Liquidity Clusters', baselineWeight: 11.0, pKey: 'p5' },
  { id: 'MOMENTUM_RVOL', title: 'Momentum & rVol', baselineWeight: 9.0, pKey: 'p6' },
  { id: 'SENTIMENT_MACRO', title: 'Macro Sentiment', baselineWeight: 2.5, pKey: 'p7' },
];

/**
 * Repository for pillar_telemetry_events, pillar_horizon_evaluations, and pillar_daily_scorecards tables.
 */
export class PillarTelemetryRepo {
  constructor(private db: DatabaseSync) {}

  /**
   * Inserts a batch of telemetry events within a single IMMEDIATE transaction.
   * Assigns and returns the generated autoincrement IDs.
   */
  insertBatch(events: Array<Omit<PillarTelemetryRecord, 'id'> & { id?: number }>): number[] {
    if (!events || events.length === 0) return [];

    return runTransaction(this.db, () => {
      const stmt = this.db.prepare(`
        INSERT INTO pillar_telemetry_events (
          timestamp, symbol, trigger_type, mark_price, atr_14,
          composite_score, consensus_side, active_pillars_count,
          p1_vote, p2_vote, p3_vote, p4_vote, p5_vote, p6_vote, p7_vote,
          p1_macro_regime, p2_native_smc, p3_cvd_absorption, p4_order_flow_l2,
          p5_liq_clusters, p6_momentum_rvol, p7_sentiment_macro, status
        ) VALUES (
          ?, ?, ?, ?, ?,
          ?, ?, ?,
          ?, ?, ?, ?, ?, ?, ?,
          ?, ?, ?, ?,
          ?, ?, ?, ?
        )
      `);

      const ids: number[] = [];
      for (const ev of events) {
        const info = stmt.run(
          ev.timestamp,
          ev.symbol,
          ev.trigger_type,
          ev.mark_price,
          ev.atr_14,
          ev.composite_score,
          ev.consensus_side,
          ev.active_pillars_count,
          ev.p1_vote,
          ev.p2_vote,
          ev.p3_vote,
          ev.p4_vote,
          ev.p5_vote,
          ev.p6_vote,
          ev.p7_vote,
          ev.p1_macro_regime,
          ev.p2_native_smc,
          ev.p3_cvd_absorption,
          ev.p4_order_flow_l2,
          ev.p5_liq_clusters,
          ev.p6_momentum_rvol,
          ev.p7_sentiment_macro,
          ev.status || 'EVALUATING'
        );
        const id = Number(info.lastInsertRowid);
        ev.id = id;
        ids.push(id);
      }
      return ids;
    });
  }

  /**
   * Retrieves all open telemetry events pending trajectory evaluation (status = 'EVALUATING').
   */
  getOpenEvents(symbol?: string): PillarTelemetryRecord[] {
    if (symbol) {
      const stmt = this.db.prepare(`
        SELECT * FROM pillar_telemetry_events
        WHERE status = 'EVALUATING' AND symbol = ?
        ORDER BY timestamp ASC
      `);
      return stmt.all(symbol) as unknown as PillarTelemetryRecord[];
    } else {
      const stmt = this.db.prepare(`
        SELECT * FROM pillar_telemetry_events
        WHERE status = 'EVALUATING'
        ORDER BY timestamp ASC
      `);
      return stmt.all() as unknown as PillarTelemetryRecord[];
    }
  }

  /**
   * Records a multi-horizon trajectory evaluation.
   * Automatically transitions parent event to 'SETTLED' if 60m horizon is evaluated.
   */
  recordHorizonEvaluation(evalRecord: Omit<PillarHorizonEvaluation, 'id'> & { id?: number }): number {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO pillar_horizon_evaluations (
        event_id, horizon, settle_timestamp, settle_price, price_change_abs,
        price_change_pct, mfe_pct, mae_pct, directional_outcome,
        p1_status, p2_status, p3_status, p4_status, p5_status, p6_status, p7_status
      ) VALUES (
        ?, ?, ?, ?, ?,
        ?, ?, ?, ?,
        ?, ?, ?, ?, ?, ?, ?
      )
    `);

    const info = stmt.run(
      evalRecord.event_id,
      evalRecord.horizon,
      evalRecord.settle_timestamp,
      evalRecord.settle_price,
      evalRecord.price_change_abs,
      evalRecord.price_change_pct,
      evalRecord.mfe_pct,
      evalRecord.mae_pct,
      evalRecord.directional_outcome,
      evalRecord.p1_status,
      evalRecord.p2_status,
      evalRecord.p3_status,
      evalRecord.p4_status,
      evalRecord.p5_status,
      evalRecord.p6_status,
      evalRecord.p7_status
    );

    const insertId = Number(info.lastInsertRowid);
    if (!evalRecord.id) evalRecord.id = insertId;

    // Check if 60m horizon was evaluated or all horizons settled
    if (evalRecord.horizon === '60m') {
      const updateStmt = this.db.prepare(`
        UPDATE pillar_telemetry_events
        SET status = 'SETTLED'
        WHERE id = ? AND status = 'EVALUATING'
      `);
      updateStmt.run(evalRecord.event_id);
    }

    return insertId;
  }

  /**
   * Retrieves single event by id.
   */
  getById(id: number): PillarTelemetryRecord | null {
    const stmt = this.db.prepare('SELECT * FROM pillar_telemetry_events WHERE id = ?');
    const row = stmt.get(id);
    return row ? (row as unknown as PillarTelemetryRecord) : null;
  }

  /**
   * Retrieves all settled evaluations for an event.
   */
  getEvaluationsForEvent(eventId: number): PillarHorizonEvaluation[] {
    const stmt = this.db.prepare(`
      SELECT * FROM pillar_horizon_evaluations
      WHERE event_id = ?
      ORDER BY settle_timestamp ASC
    `);
    return stmt.all(eventId) as unknown as PillarHorizonEvaluation[];
  }

  /**
   * Updates the status of an event ('EVALUATING', 'SETTLED', 'EXPIRED').
   */
  updateEventStatus(id: number, status: TelemetryStatus): void {
    const stmt = this.db.prepare(`
      UPDATE pillar_telemetry_events
      SET status = ?
      WHERE id = ?
    `);
    stmt.run(status, id);
  }

  /**
   * Updates coalesced votes and snapshots for an existing telemetry event.
   */
  updateEventDetails(event: PillarTelemetryRecord): void {
    if (!event.id) return;
    const stmt = this.db.prepare(`
      UPDATE pillar_telemetry_events SET
        composite_score = ?,
        active_pillars_count = ?,
        p1_vote = ?, p2_vote = ?, p3_vote = ?, p4_vote = ?, p5_vote = ?, p6_vote = ?, p7_vote = ?,
        p1_macro_regime = ?, p2_native_smc = ?, p3_cvd_absorption = ?, p4_order_flow_l2 = ?,
        p5_liq_clusters = ?, p6_momentum_rvol = ?, p7_sentiment_macro = ?
      WHERE id = ?
    `);
    stmt.run(
      event.composite_score,
      event.active_pillars_count,
      event.p1_vote,
      event.p2_vote,
      event.p3_vote,
      event.p4_vote,
      event.p5_vote,
      event.p6_vote,
      event.p7_vote,
      event.p1_macro_regime,
      event.p2_native_smc,
      event.p3_cvd_absorption,
      event.p4_order_flow_l2,
      event.p5_liq_clusters,
      event.p6_momentum_rvol,
      event.p7_sentiment_macro,
      event.id
    );
  }

  /**
   * Lists events since a given timestamp ms.
   */
  listEventsSince(sinceMs: number, symbol?: string): PillarTelemetryRecord[] {
    if (symbol) {
      const stmt = this.db.prepare(`
        SELECT * FROM pillar_telemetry_events
        WHERE timestamp >= ? AND symbol = ?
        ORDER BY timestamp ASC
      `);
      return stmt.all(sinceMs, symbol) as unknown as PillarTelemetryRecord[];
    } else {
      const stmt = this.db.prepare(`
        SELECT * FROM pillar_telemetry_events
        WHERE timestamp >= ?
        ORDER BY timestamp ASC
      `);
      return stmt.all(sinceMs) as unknown as PillarTelemetryRecord[];
    }
  }

  /**
   * Counts open evaluation events for a symbol or globally.
   */
  countOpenEvents(symbol?: string): number {
    if (symbol) {
      const stmt = this.db.prepare(`
        SELECT COUNT(*) as cnt FROM pillar_telemetry_events
        WHERE status = 'EVALUATING' AND symbol = ?
      `);
      const row = stmt.get(symbol) as { cnt: number } | undefined;
      return row?.cnt ?? 0;
    } else {
      const stmt = this.db.prepare(`
        SELECT COUNT(*) as cnt FROM pillar_telemetry_events
        WHERE status = 'EVALUATING'
      `);
      const row = stmt.get() as { cnt: number } | undefined;
      return row?.cnt ?? 0;
    }
  }

  /**
   * Gets total sample count (evaluations) for a symbol and horizon.
   */
  getSampleCount(symbol: string, horizon: TrajectoryHorizon): number {
    const stmt = this.db.prepare(`
      SELECT COUNT(*) as cnt
      FROM pillar_horizon_evaluations h
      JOIN pillar_telemetry_events e ON h.event_id = e.id
      WHERE h.horizon = ? AND e.symbol = ?
    `);
    const row = stmt.get(horizon, symbol) as { cnt: number } | undefined;
    return row?.cnt ?? 0;
  }

  /**
   * Computes the aggregated scorecard for all 7 pillars over a specific horizon
   * applying Bayesian shrinkage and regularized weight recommendations.
   */
  getAggregatedScorecard(symbol: string, horizon: TrajectoryHorizon): PillarScorecardItem[] {
    const sql = `
      SELECT
        COUNT(*) as sample_size,
        -- p1 Macro Regime
        SUM(CASE WHEN h.p1_status = 'TRUE_POSITIVE' THEN 1 ELSE 0 END) as p1_tp,
        SUM(CASE WHEN h.p1_status = 'FALSE_POSITIVE' THEN 1 ELSE 0 END) as p1_fp,
        SUM(CASE WHEN h.p1_status = 'FALSE_NEGATIVE' THEN 1 ELSE 0 END) as p1_fn,
        AVG(CASE WHEN h.p1_status IN ('TRUE_POSITIVE', 'FALSE_POSITIVE') THEN h.mfe_pct ELSE NULL END) as p1_avg_mfe,
        AVG(CASE WHEN h.p1_status IN ('TRUE_POSITIVE', 'FALSE_POSITIVE') THEN h.mae_pct ELSE NULL END) as p1_avg_mae,
        -- p2 Native SMC
        SUM(CASE WHEN h.p2_status = 'TRUE_POSITIVE' THEN 1 ELSE 0 END) as p2_tp,
        SUM(CASE WHEN h.p2_status = 'FALSE_POSITIVE' THEN 1 ELSE 0 END) as p2_fp,
        SUM(CASE WHEN h.p2_status = 'FALSE_NEGATIVE' THEN 1 ELSE 0 END) as p2_fn,
        AVG(CASE WHEN h.p2_status IN ('TRUE_POSITIVE', 'FALSE_POSITIVE') THEN h.mfe_pct ELSE NULL END) as p2_avg_mfe,
        AVG(CASE WHEN h.p2_status IN ('TRUE_POSITIVE', 'FALSE_POSITIVE') THEN h.mae_pct ELSE NULL END) as p2_avg_mae,
        -- p3 CVD Absorption
        SUM(CASE WHEN h.p3_status = 'TRUE_POSITIVE' THEN 1 ELSE 0 END) as p3_tp,
        SUM(CASE WHEN h.p3_status = 'FALSE_POSITIVE' THEN 1 ELSE 0 END) as p3_fp,
        SUM(CASE WHEN h.p3_status = 'FALSE_NEGATIVE' THEN 1 ELSE 0 END) as p3_fn,
        AVG(CASE WHEN h.p3_status IN ('TRUE_POSITIVE', 'FALSE_POSITIVE') THEN h.mfe_pct ELSE NULL END) as p3_avg_mfe,
        AVG(CASE WHEN h.p3_status IN ('TRUE_POSITIVE', 'FALSE_POSITIVE') THEN h.mae_pct ELSE NULL END) as p3_avg_mae,
        -- p4 Order Flow L2
        SUM(CASE WHEN h.p4_status = 'TRUE_POSITIVE' THEN 1 ELSE 0 END) as p4_tp,
        SUM(CASE WHEN h.p4_status = 'FALSE_POSITIVE' THEN 1 ELSE 0 END) as p4_fp,
        SUM(CASE WHEN h.p4_status = 'FALSE_NEGATIVE' THEN 1 ELSE 0 END) as p4_fn,
        AVG(CASE WHEN h.p4_status IN ('TRUE_POSITIVE', 'FALSE_POSITIVE') THEN h.mfe_pct ELSE NULL END) as p4_avg_mfe,
        AVG(CASE WHEN h.p4_status IN ('TRUE_POSITIVE', 'FALSE_POSITIVE') THEN h.mae_pct ELSE NULL END) as p4_avg_mae,
        -- p5 Liquidity Clusters
        SUM(CASE WHEN h.p5_status = 'TRUE_POSITIVE' THEN 1 ELSE 0 END) as p5_tp,
        SUM(CASE WHEN h.p5_status = 'FALSE_POSITIVE' THEN 1 ELSE 0 END) as p5_fp,
        SUM(CASE WHEN h.p5_status = 'FALSE_NEGATIVE' THEN 1 ELSE 0 END) as p5_fn,
        AVG(CASE WHEN h.p5_status IN ('TRUE_POSITIVE', 'FALSE_POSITIVE') THEN h.mfe_pct ELSE NULL END) as p5_avg_mfe,
        AVG(CASE WHEN h.p5_status IN ('TRUE_POSITIVE', 'FALSE_POSITIVE') THEN h.mae_pct ELSE NULL END) as p5_avg_mae,
        -- p6 Momentum & rVol
        SUM(CASE WHEN h.p6_status = 'TRUE_POSITIVE' THEN 1 ELSE 0 END) as p6_tp,
        SUM(CASE WHEN h.p6_status = 'FALSE_POSITIVE' THEN 1 ELSE 0 END) as p6_fp,
        SUM(CASE WHEN h.p6_status = 'FALSE_NEGATIVE' THEN 1 ELSE 0 END) as p6_fn,
        AVG(CASE WHEN h.p6_status IN ('TRUE_POSITIVE', 'FALSE_POSITIVE') THEN h.mfe_pct ELSE NULL END) as p6_avg_mfe,
        AVG(CASE WHEN h.p6_status IN ('TRUE_POSITIVE', 'FALSE_POSITIVE') THEN h.mae_pct ELSE NULL END) as p6_avg_mae,
        -- p7 Sentiment Macro
        SUM(CASE WHEN h.p7_status = 'TRUE_POSITIVE' THEN 1 ELSE 0 END) as p7_tp,
        SUM(CASE WHEN h.p7_status = 'FALSE_POSITIVE' THEN 1 ELSE 0 END) as p7_fp,
        SUM(CASE WHEN h.p7_status = 'FALSE_NEGATIVE' THEN 1 ELSE 0 END) as p7_fn,
        AVG(CASE WHEN h.p7_status IN ('TRUE_POSITIVE', 'FALSE_POSITIVE') THEN h.mfe_pct ELSE NULL END) as p7_avg_mfe,
        AVG(CASE WHEN h.p7_status IN ('TRUE_POSITIVE', 'FALSE_POSITIVE') THEN h.mae_pct ELSE NULL END) as p7_avg_mae
      FROM pillar_horizon_evaluations h
      JOIN pillar_telemetry_events e ON h.event_id = e.id
      WHERE h.horizon = ? AND e.symbol = ?
    `;

    const stmt = this.db.prepare(sql);
    const row = stmt.get(horizon, symbol) as Record<string, number | null> | undefined;

    // Calculate raw scores and prepare Bayesian shrinkage
    const rawScores: number[] = [];
    const stats = PILLAR_CONFIGS.map((cfg) => {
      const p = cfg.pKey;
      const tp = Number(row?.[`${p}_tp`] ?? 0);
      const fp = Number(row?.[`${p}_fp`] ?? 0);
      const fn = Number(row?.[`${p}_fn`] ?? 0);
      const avgMfe = Number(row?.[`${p}_avg_mfe`] ?? 0);
      const avgMae = Number(row?.[`${p}_avg_mae`] ?? 0);
      const activeVotes = tp + fp;

      // Minimum Sample Size Gating (N_k >= 30)
      const hitRate = activeVotes >= 30 ? tp / activeVotes : 0.50;
      const rawScore = Math.max(0.01, hitRate) * Math.max(0.01, avgMfe);
      rawScores.push(rawScore);

      return {
        cfg,
        tp,
        fp,
        fn,
        avgMfe,
        avgMae,
        activeVotes,
        hitRate,
        rawScore,
      };
    });

    const sumRawScore = rawScores.reduce((acc, v) => acc + v, 0);

    // Apply shrinkage and bounds
    const intermediateWeights: number[] = [];
    for (let i = 0; i < stats.length; i++) {
      const item = stats[i];
      const baseline = item.cfg.baselineWeight;

      // Empirical weight percentage
      const wEmpirical = sumRawScore > 0 ? (item.rawScore / sumRawScore) * 100 : baseline;

      // Shrinkage lambda_k = min(0.50, N_k / 100)
      const lambda = Math.min(0.50, item.activeVotes / 100);
      const wRecommended = (1 - lambda) * baseline + lambda * wEmpirical;

      // Clamping: [2.5%, 35.0%] and max delta <= 5.0%
      let clamped = Math.max(2.5, Math.min(35.0, wRecommended));
      if (clamped > baseline + 5.0) clamped = baseline + 5.0;
      if (clamped < baseline - 5.0) clamped = baseline - 5.0;

      intermediateWeights.push(clamped);
    }

    // Simplex Normalization to ensure sum equals exactly 100.0%
    const sumClamped = intermediateWeights.reduce((acc, v) => acc + v, 0);
    const normalizedWeights = intermediateWeights.map(w =>
      sumClamped > 0 ? (w / sumClamped) * 100 : w
    );

    // Build final PillarScorecardItem array
    return stats.map((item, idx) => {
      const normalizedWeight = Number(normalizedWeights[idx].toFixed(2));
      const delta = Number((normalizedWeight - item.cfg.baselineWeight).toFixed(2));
      const actualHitRatePct = item.activeVotes > 0
        ? Number(((item.tp / item.activeVotes) * 100).toFixed(1))
        : 0.0;

      return {
        pillarId: item.cfg.id,
        title: item.cfg.title,
        currentWeightPct: item.cfg.baselineWeight,
        recommendedWeightPct: normalizedWeight,
        weightDeltaPct: delta,
        totalActiveVotes: item.activeVotes,
        truePositives: item.tp,
        falsePositives: item.fp,
        falseNegatives: item.fn,
        hitRatePct: actualHitRatePct,
        avgMfePct: Number(item.avgMfe.toFixed(3)),
        avgMaePct: Number(item.avgMae.toFixed(3)),
      };
    });
  }

  /**
   * Returns a complete PillarAttributionResponse for API and services.
   */
  getAttributionResponse(symbol: string, horizon: TrajectoryHorizon): PillarAttributionResponse {
    const scorecards = this.getAggregatedScorecard(symbol, horizon);
    const sampleSize = this.getSampleCount(symbol, horizon);
    return {
      symbol,
      horizon,
      sampleSize,
      generatedAt: Date.now(),
      scorecards,
    };
  }

  /**
   * Archives current daily scorecards into pillar_daily_scorecards table for permanent history.
   */
  archiveDailyScorecards(date?: string): number {
    const targetDate = date ?? new Date().toISOString().slice(0, 10);
    const now = Date.now();

    // Find all distinct symbols in events
    const symbolRows = this.db.prepare(`
      SELECT DISTINCT symbol FROM pillar_telemetry_events
    `).all() as Array<{ symbol: string }>;

    const symbols = symbolRows.length > 0 ? symbolRows.map(r => r.symbol) : ['SOLUSDT'];
    const horizons: TrajectoryHorizon[] = ['1m', '5m', '15m', '60m'];

    const upsertStmt = this.db.prepare(`
      INSERT INTO pillar_daily_scorecards (
        date, symbol, horizon, scorecards_json, sample_size, created_at
      ) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(date, symbol, horizon) DO UPDATE SET
        scorecards_json = excluded.scorecards_json,
        sample_size = excluded.sample_size,
        created_at = excluded.created_at
    `);

    let archivedCount = 0;
    for (const sym of symbols) {
      for (const hz of horizons) {
        const scorecards = this.getAggregatedScorecard(sym, hz);
        const sampleSize = this.getSampleCount(sym, hz);

        upsertStmt.run(
          targetDate,
          sym,
          hz,
          JSON.stringify(scorecards),
          sampleSize,
          now
        );
        archivedCount++;
      }
    }

    return archivedCount;
  }

  /**
   * Prunes telemetry events older than retentionDays (default 30 days).
   * Cascading foreign key automatically deletes associated evaluations.
   */
  pruneStaleEvents(retentionDays: number = 30): number {
    const cutoffMs = Date.now() - retentionDays * 86_400_000;
    const stmt = this.db.prepare('DELETE FROM pillar_telemetry_events WHERE timestamp < ?');
    const result = stmt.run(cutoffMs) as { changes?: number | bigint };
    return Number(result.changes ?? 0);
  }
}

/**
 * Repository for economic_events table.
 */
export class EconomicEventsRepo {
  constructor(private db: DatabaseSync) {}

  public upsert(event: EconomicEvent): void {
    const stmt = this.db.prepare(`
      INSERT INTO economic_events (id, name, timestamp, impact, currency)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        timestamp = excluded.timestamp,
        impact = excluded.impact,
        currency = excluded.currency
    `);
    stmt.run(event.id, event.name, event.timestamp, event.impact, event.currency);
  }

  public getEventsInRange(startMs: number, endMs: number): EconomicEvent[] {
    const stmt = this.db.prepare(`
      SELECT id, name, timestamp, impact, currency
      FROM economic_events
      WHERE timestamp >= ? AND timestamp <= ?
      ORDER BY timestamp ASC
    `);
    return stmt.all(startMs, endMs) as unknown as EconomicEvent[];
  }

  public getAll(): EconomicEvent[] {
    const stmt = this.db.prepare(`
      SELECT id, name, timestamp, impact, currency
      FROM economic_events
      ORDER BY timestamp ASC
    `);
    return stmt.all() as unknown as EconomicEvent[];
  }
}

/**
 * Record representing factor telemetry data stored in SQLite.
 */
export interface FactorTelemetryRecord {
  id?: number;
  timestamp: number;
  symbol: string;
  factor_id: string;
  raw_alpha: number;
  orthogonal_alpha: number;
  confidence: number;
  uncertainty: number;
  weight: number;
}

/**
 * Repository for factor_telemetry table.
 */
export class FactorTelemetryRepo {
  constructor(private db: DatabaseSync) {}

  public insert(record: FactorTelemetryRecord): void {
    const stmt = this.db.prepare(`
      INSERT INTO factor_telemetry (
        timestamp, symbol, factor_id, raw_alpha, orthogonal_alpha, confidence, uncertainty, weight
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      record.timestamp,
      record.symbol,
      record.factor_id,
      record.raw_alpha,
      record.orthogonal_alpha,
      record.confidence,
      record.uncertainty,
      record.weight
    );
  }

  public insertBatch(records: FactorTelemetryRecord[]): void {
    if (records.length === 0) return;
    const stmt = this.db.prepare(`
      INSERT INTO factor_telemetry (
        timestamp, symbol, factor_id, raw_alpha, orthogonal_alpha, confidence, uncertainty, weight
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    runTransaction(this.db, () => {
      for (const rec of records) {
        stmt.run(
          rec.timestamp,
          rec.symbol,
          rec.factor_id,
          rec.raw_alpha,
          rec.orthogonal_alpha,
          rec.confidence,
          rec.uncertainty,
          rec.weight
        );
      }
    });
  }

  public getRecentByFactor(symbol: string, factorId: string, limit: number = 100): FactorTelemetryRecord[] {
    const stmt = this.db.prepare(`
      SELECT id, timestamp, symbol, factor_id, raw_alpha, orthogonal_alpha, confidence, uncertainty, weight
      FROM factor_telemetry
      WHERE symbol = ? AND factor_id = ?
      ORDER BY timestamp DESC
      LIMIT ?
    `);
    return stmt.all(symbol, factorId, limit) as unknown as FactorTelemetryRecord[];
  }

  public getRecent(symbol: string, limit: number = 100): FactorTelemetryRecord[] {
    const stmt = this.db.prepare(`
      SELECT id, timestamp, symbol, factor_id, raw_alpha, orthogonal_alpha, confidence, uncertainty, weight
      FROM factor_telemetry
      WHERE symbol = ?
      ORDER BY timestamp DESC
      LIMIT ?
    `);
    return stmt.all(symbol, limit) as unknown as FactorTelemetryRecord[];
  }

  public getByTimeRange(
    symbol: string,
    factorId: string,
    startTime: number,
    endTime: number
  ): FactorTelemetryRecord[] {
    const stmt = this.db.prepare(`
      SELECT id, timestamp, symbol, factor_id, raw_alpha, orthogonal_alpha, confidence, uncertainty, weight
      FROM factor_telemetry
      WHERE symbol = ? AND factor_id = ? AND timestamp >= ? AND timestamp <= ?
      ORDER BY timestamp ASC
    `);
    return stmt.all(symbol, factorId, startTime, endTime) as unknown as FactorTelemetryRecord[];
  }

  public pruneOlderThan(retentionDays: number = 30): number {
    const cutoffMs = Date.now() - retentionDays * 86_400_000;
    const stmt = this.db.prepare('DELETE FROM factor_telemetry WHERE timestamp < ?');
    const result = stmt.run(cutoffMs) as { changes?: number | bigint };
    return Number(result.changes ?? 0);
  }
}

/**
 * Record representing maker limit chasing telemetry stored in SQLite.
 */
export interface ExecutionChaseLogRecord {
  id?: number;
  trade_id: string;
  symbol: string;
  anchor_price: number;
  amend_count: number;
  duration_ms: number;
  final_status: string;
  effective_price: number;
  fee_saved_usd: number;
  created_at: number;
}

/**
 * Repository for execution_chase_logs table.
 */
export class ExecutionChaseLogsRepo {
  constructor(private db: DatabaseSync) {}

  public insert(record: ExecutionChaseLogRecord): void {
    const stmt = this.db.prepare(`
      INSERT INTO execution_chase_logs (
        trade_id, symbol, anchor_price, amend_count, duration_ms,
        final_status, effective_price, fee_saved_usd, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      record.trade_id,
      record.symbol,
      record.anchor_price,
      record.amend_count,
      record.duration_ms,
      record.final_status,
      record.effective_price,
      record.fee_saved_usd,
      record.created_at
    );
  }

  public insertBatch(records: ExecutionChaseLogRecord[]): void {
    if (records.length === 0) return;
    const stmt = this.db.prepare(`
      INSERT INTO execution_chase_logs (
        trade_id, symbol, anchor_price, amend_count, duration_ms,
        final_status, effective_price, fee_saved_usd, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    runTransaction(this.db, () => {
      for (const rec of records) {
        stmt.run(
          rec.trade_id,
          rec.symbol,
          rec.anchor_price,
          rec.amend_count,
          rec.duration_ms,
          rec.final_status,
          rec.effective_price,
          rec.fee_saved_usd,
          rec.created_at
        );
      }
    });
  }

  public getRecent(symbol: string, limit: number = 100): ExecutionChaseLogRecord[] {
    const stmt = this.db.prepare(`
      SELECT id, trade_id, symbol, anchor_price, amend_count, duration_ms,
             final_status, effective_price, fee_saved_usd, created_at
      FROM execution_chase_logs
      WHERE symbol = ?
      ORDER BY created_at DESC
      LIMIT ?
    `);
    return stmt.all(symbol, limit) as unknown as ExecutionChaseLogRecord[];
  }

  public getByTradeId(tradeId: string): ExecutionChaseLogRecord[] {
    const stmt = this.db.prepare(`
      SELECT id, trade_id, symbol, anchor_price, amend_count, duration_ms,
             final_status, effective_price, fee_saved_usd, created_at
      FROM execution_chase_logs
      WHERE trade_id = ?
      ORDER BY created_at ASC
    `);
    return stmt.all(tradeId) as unknown as ExecutionChaseLogRecord[];
  }

  public getFeeSavings(
    symbol?: string,
    sinceTimestamp?: number
  ): { totalFeeSavedUsd: number; totalChases: number; successfulChases: number } {
    let query = `
      SELECT
        COALESCE(SUM(fee_saved_usd), 0) AS totalFeeSavedUsd,
        COUNT(*) AS totalChases,
        SUM(CASE WHEN final_status = 'FILLED' THEN 1 ELSE 0 END) AS successfulChases
      FROM execution_chase_logs
      WHERE 1=1
    `;
    const params: (string | number)[] = [];
    if (symbol) {
      query += ` AND symbol = ?`;
      params.push(symbol);
    }
    if (sinceTimestamp !== undefined) {
      query += ` AND created_at >= ?`;
      params.push(sinceTimestamp);
    }

    const stmt = this.db.prepare(query);
    const row = (params.length > 0 ? stmt.get(...params) : stmt.get()) as {
      totalFeeSavedUsd: number;
      totalChases: number;
      successfulChases: number;
    } | undefined;

    return {
      totalFeeSavedUsd: Number(row?.totalFeeSavedUsd ?? 0),
      totalChases: Number(row?.totalChases ?? 0),
      successfulChases: Number(row?.successfulChases ?? 0),
    };
  }
}

export type FactorHorizonExcursionPatch = Partial<
  Pick<
    FactorTelemetryDbRecord,
    | 'post_1m_mfe'
    | 'post_1m_mae'
    | 'post_5m_mfe'
    | 'post_5m_mae'
    | 'post_15m_mfe'
    | 'post_15m_mae'
    | 'post_1h_mfe'
    | 'post_1h_mae'
    | 'status'
    | 'settle_timestamp'
  >
>;

const HORIZON_PATCH_COLUMNS: ReadonlyArray<keyof FactorHorizonExcursionPatch> = [
  'post_1m_mfe',
  'post_1m_mae',
  'post_5m_mfe',
  'post_5m_mae',
  'post_15m_mfe',
  'post_15m_mae',
  'post_1h_mfe',
  'post_1h_mae',
  'status',
  'settle_timestamp',
];

interface PendingFactorDbRow {
  factorId: string;
  rawAlpha: number;
  orthogonalAlpha: number;
  effectiveWeight: number;
  isCollinear: number;
  confidence: number;
  summaryText: string | null;
}

function deriveConvictionArchetype(compositeScore: number): QuantConvictionArchetype {
  if (compositeScore >= 95) return 'A_PLUS_INSTITUTIONAL';
  if (compositeScore >= 85) return 'HIGH_CONVICTION_CORE';
  if (compositeScore >= 75) return 'STANDARD_INSTITUTIONAL';
  if (compositeScore >= 70) return 'EXPLORATORY_PROBE';
  return 'SUB_THRESHOLD';
}

function buildFactorRows(event: FactorTelemetryEvent): PendingFactorDbRow[] {
  const rows: PendingFactorDbRow[] = [];
  const activeFactors = event.activeFactors ?? [];
  const collinearFactors = event.collinearFactors ?? [];

  for (const factor of activeFactors) {
    rows.push({
      factorId: factor.factorId,
      rawAlpha: factor.rawAlpha,
      orthogonalAlpha: factor.orthogonalAlpha,
      effectiveWeight: factor.effectiveWeight,
      isCollinear: factor.isCollinear ? 1 : 0,
      confidence: factor.confidence ?? 0,
      summaryText: factor.summaryText ?? null,
    });
  }

  for (const collinearEntry of collinearFactors) {
    const alreadyInActive = activeFactors.some(
      (f) => f.isCollinear && (f.factorId === collinearEntry || f.name === collinearEntry)
    );
    if (!alreadyInActive) {
      rows.push({
        factorId: collinearEntry,
        rawAlpha: 0,
        orthogonalAlpha: 0,
        effectiveWeight: 0,
        isCollinear: 1,
        confidence: 0,
        summaryText: 'Collinear suppressed',
      });
    }
  }

  if (rows.length === 0) {
    rows.push({
      factorId: 'COMPOSITE',
      rawAlpha: 0,
      orthogonalAlpha: 0,
      effectiveWeight: 1,
      isCollinear: 0,
      confidence: 0,
      summaryText: null,
    });
  }

  return rows;
}

function reconstructEventFromRows(rows: FactorTelemetryDbRecord[]): FactorTelemetryEvent {
  const primaryRow = rows.find((r) => r.telemetry_payload_json != null) ?? rows[0]!;
  if (primaryRow.telemetry_payload_json) {
    try {
      const parsed = JSON.parse(primaryRow.telemetry_payload_json) as FactorTelemetryEvent;
      return {
        ...parsed,
        id: primaryRow.id,
        eventId: primaryRow.event_id,
      };
    } catch {
      // Fall back to row-level reconstruction if payload JSON is malformed
    }
  }

  const activeFactors: FactorStateDetail[] = [];
  const collinearFactors: string[] = [];

  for (const row of rows) {
    if (row.is_collinear === 1) {
      collinearFactors.push(row.factor_id);
      continue;
    }
    if (row.factor_id === 'COMPOSITE') {
      continue;
    }
    const bias: FactorStateDetail['bias'] =
      row.orthogonal_alpha > 0 ? 'BULLISH' : row.orthogonal_alpha < 0 ? 'BEARISH' : 'NEUTRAL';
    activeFactors.push({
      factorId: row.factor_id,
      name: row.factor_id,
      bias,
      rawAlpha: row.raw_alpha,
      orthogonalAlpha: row.orthogonal_alpha,
      effectiveWeight: row.effective_weight,
      isCollinear: false,
      confidence: row.confidence,
      summaryText: row.summary_text ?? '',
    });
  }

  return {
    id: primaryRow.id,
    eventId: primaryRow.event_id,
    timestamp: primaryRow.timestamp,
    symbol: primaryRow.symbol,
    triggerType: primaryRow.trigger_type as FactorTelemetryTriggerType,
    markPrice: primaryRow.entry_price,
    compositeScore: primaryRow.composite_score,
    convictionArchetype: deriveConvictionArchetype(primaryRow.composite_score),
    consensusSide: primaryRow.consensus_side,
    noiseBandActive: false,
    macroVetoActive: false,
    activeFactors,
    collinearFactors,
  };
}

/**
 * Repository for Next-Gen orthogonal factor telemetry records and horizon outcome tracking.
 */
export class FactorTelemetryRecordsRepo {
  constructor(private db: DatabaseSync) {}

  /**
   * Atomically persists a FactorTelemetryEvent as factor-level evaluation rows
   * with nullable decision_log_id and full payload JSON on the primary row.
   */
  public insertEventBatch(
    event: FactorTelemetryEvent,
    decisionLogId?: string | null
  ): number[] {
    const eventId = event.eventId && event.eventId.length > 0 ? event.eventId : randomUUID();
    const resolvedDecisionLogId = decisionLogId ?? null;
    const factorRows = buildFactorRows(event);
    const payloadJson = JSON.stringify({ ...event, eventId });

    return runTransaction(this.db, () => {
      const stmt = this.db.prepare(`
        INSERT INTO factor_telemetry_records (
          decision_log_id, event_id, trigger_type, timestamp, symbol,
          consensus_side, entry_price, composite_score, factor_id,
          raw_alpha, orthogonal_alpha, effective_weight, is_collinear,
          confidence, summary_text, telemetry_payload_json, status
        ) VALUES (
          ?, ?, ?, ?, ?,
          ?, ?, ?, ?,
          ?, ?, ?, ?,
          ?, ?, ?, 'EVALUATING'
        )
      `);

      const insertedIds: number[] = [];
      for (let i = 0; i < factorRows.length; i++) {
        const row = factorRows[i]!;
        const info = stmt.run(
          resolvedDecisionLogId,
          eventId,
          event.triggerType,
          event.timestamp,
          event.symbol,
          event.consensusSide,
          event.markPrice,
          event.compositeScore,
          row.factorId,
          row.rawAlpha,
          row.orthogonalAlpha,
          row.effectiveWeight,
          row.isCollinear,
          row.confidence,
          row.summaryText,
          i === 0 ? payloadJson : null
        );
        insertedIds.push(Number(info.lastInsertRowid));
      }
      return insertedIds;
    });
  }

  /**
   * Lists all factor telemetry records awaiting post-trade horizon settlement.
   */
  public getPendingEvaluations(symbol?: string): FactorTelemetryDbRecord[] {
    if (symbol) {
      const stmt = this.db.prepare(`
        SELECT * FROM factor_telemetry_records
        WHERE status = 'EVALUATING' AND symbol = ?
        ORDER BY timestamp ASC, id ASC
      `);
      return stmt.all(symbol) as unknown as FactorTelemetryDbRecord[];
    }
    const stmt = this.db.prepare(`
      SELECT * FROM factor_telemetry_records
      WHERE status = 'EVALUATING'
      ORDER BY timestamp ASC, id ASC
    `);
    return stmt.all() as unknown as FactorTelemetryDbRecord[];
  }

  /**
   * Updates post-trade horizon MFE/MAE excursions and settlement state for a factor record.
   */
  public updateHorizonExcursions(id: number, patch: FactorHorizonExcursionPatch): void {
    const clauses: string[] = [];
    const values: Array<string | number | null> = [];

    for (const col of HORIZON_PATCH_COLUMNS) {
      const val = patch[col];
      if (val !== undefined) {
        clauses.push(`${col} = ?`);
        values.push(val);
      }
    }

    if (clauses.length === 0) return;

    const stmt = this.db.prepare(
      `UPDATE factor_telemetry_records SET ${clauses.join(', ')} WHERE id = ?`
    );
    stmt.run(...values, id);
  }

  /**
   * Retrieves the most recent settled factor records for IC/IR attribution queries.
   */
  public getSettledByFactor(factorId: string, limit: number = 60): FactorTelemetryDbRecord[] {
    const safeLimit = Math.max(0, Math.floor(limit));
    if (safeLimit === 0) return [];

    const stmt = this.db.prepare(`
      SELECT * FROM factor_telemetry_records
      WHERE factor_id = ? AND status = 'SETTLED'
      ORDER BY timestamp DESC, id DESC
      LIMIT ?
    `);
    return stmt.all(factorId, safeLimit) as unknown as FactorTelemetryDbRecord[];
  }

  /**
   * Reconstructs distinct FactorTelemetryEvent objects ordered newest-first with pagination.
   */
  public listRecentEvents(
    sinceMs: number,
    limit: number = 50,
    offset: number = 0
  ): FactorTelemetryEvent[] {
    const safeLimit = Math.max(0, Math.floor(limit));
    const safeOffset = Math.max(0, Math.floor(offset));
    if (safeLimit === 0) return [];

    const eventKeys = this.db
      .prepare(`
        SELECT event_id, MAX(timestamp) AS max_ts, MIN(id) AS min_id
        FROM factor_telemetry_records
        WHERE timestamp >= ?
        GROUP BY event_id
        ORDER BY max_ts DESC, min_id DESC
        LIMIT ? OFFSET ?
      `)
      .all(sinceMs, safeLimit, safeOffset) as Array<{ event_id: string }>;

    if (eventKeys.length === 0) return [];

    const placeholders = eventKeys.map(() => '?').join(', ');
    const rows = this.db
      .prepare(`
        SELECT * FROM factor_telemetry_records
        WHERE event_id IN (${placeholders})
        ORDER BY id ASC
      `)
      .all(...eventKeys.map((k) => k.event_id)) as unknown as FactorTelemetryDbRecord[];

    const grouped = new Map<string, FactorTelemetryDbRecord[]>();
    for (const row of rows) {
      let bucket = grouped.get(row.event_id);
      if (!bucket) {
        bucket = [];
        grouped.set(row.event_id, bucket);
      }
      bucket.push(row);
    }

    const events: FactorTelemetryEvent[] = [];
    for (const { event_id } of eventKeys) {
      const eventRows = grouped.get(event_id);
      if (eventRows && eventRows.length > 0) {
        events.push(reconstructEventFromRows(eventRows));
      }
    }
    return events;
  }

  /**
   * Deletes expired SUB_THRESHOLD_IMPULSE rows older than retentionDays while
   * preserving executed and confirmed trade telemetry indefinitely.
   */
  public pruneOldSubThresholdImpulses(retentionDays: number = 7): number {
    const cutoffMs = Date.now() - retentionDays * 86_400_000;
    const stmt = this.db.prepare(`
      DELETE FROM factor_telemetry_records
      WHERE trigger_type = 'SUB_THRESHOLD_IMPULSE' AND timestamp < ?
    `);
    const result = stmt.run(cutoffMs) as { changes?: number | bigint };
    return Number(result.changes ?? 0);
  }
}

interface PropFirmChallengeCycleRow {
  id: string;
  cycle_number: number;
  status: string;
  starting_balance_usd: number;
  current_equity_usd: number;
  high_water_mark_usd: number;
  contractual_trailing_floor_usd: number;
  internal_trailing_floor_usd: number;
  is_floor_locked: number;
  profit_target_usd: number;
  net_pnl_usd: number;
  realized_pnl_usd?: number;
  net_pnl_pct: number;
  max_drawdown_usd: number;
  trades_count: number;
  win_count: number;
  loss_count: number;
  started_at: number;
  closed_at: number | null;
}

interface PropFirmDailySnapshotRow {
  utc_date: string;
  cycle_id: string;
  day_start_equity_usd: number;
  current_equity_usd: number;
  daily_pnl_usd: number;
  daily_min_equity_usd: number;
  daily_halted: number;
  updated_at: number;
}

function mapPropFirmCycleRow(row: PropFirmChallengeCycleRow): PropFirmChallengeCycle {
  return {
    id: row.id,
    cycleNumber: Number(row.cycle_number),
    status: row.status as PropFirmCycleStatus,
    startingBalanceUsd: Number(row.starting_balance_usd),
    currentEquityUsd: Number(row.current_equity_usd),
    highWaterMarkUsd: Number(row.high_water_mark_usd),
    contractualTrailingFloorUsd: Number(row.contractual_trailing_floor_usd),
    internalTrailingFloorUsd: Number(row.internal_trailing_floor_usd),
    isFloorLocked: Boolean(row.is_floor_locked),
    profitTargetUsd: Number(row.profit_target_usd),
    netPnlUsd: Number(row.net_pnl_usd),
    realizedPnlUsd: Number(row.realized_pnl_usd ?? 0),
    netPnlPct: Number(row.net_pnl_pct),
    maxDrawdownUsd: Number(row.max_drawdown_usd),
    tradesCount: Number(row.trades_count),
    winCount: Number(row.win_count),
    lossCount: Number(row.loss_count),
    startedAt: Number(row.started_at),
    closedAt: row.closed_at === null || row.closed_at === undefined ? null : Number(row.closed_at),
  };
}

function mapPropFirmDailySnapshotRow(row: PropFirmDailySnapshotRow): PropFirmDailySnapshot {
  return {
    utcDate: row.utc_date,
    cycleId: row.cycle_id,
    dayStartEquityUsd: Number(row.day_start_equity_usd),
    currentEquityUsd: Number(row.current_equity_usd),
    dailyPnlUsd: Number(row.daily_pnl_usd),
    dailyMinEquityUsd: Number(row.daily_min_equity_usd),
    dailyHalted: Boolean(row.daily_halted),
    updatedAt: Number(row.updated_at),
  };
}

const PROPFIRM_CYCLE_PATCH_COLUMNS: ReadonlyArray<{
  key: keyof Omit<PropFirmChallengeCycle, 'id'>;
  column: string;
  isBoolean?: boolean;
}> = [
  { key: 'cycleNumber', column: 'cycle_number' },
  { key: 'status', column: 'status' },
  { key: 'startingBalanceUsd', column: 'starting_balance_usd' },
  { key: 'currentEquityUsd', column: 'current_equity_usd' },
  { key: 'highWaterMarkUsd', column: 'high_water_mark_usd' },
  { key: 'contractualTrailingFloorUsd', column: 'contractual_trailing_floor_usd' },
  { key: 'internalTrailingFloorUsd', column: 'internal_trailing_floor_usd' },
  { key: 'isFloorLocked', column: 'is_floor_locked', isBoolean: true },
  { key: 'profitTargetUsd', column: 'profit_target_usd' },
  { key: 'netPnlUsd', column: 'net_pnl_usd' },
  { key: 'realizedPnlUsd', column: 'realized_pnl_usd' },
  { key: 'netPnlPct', column: 'net_pnl_pct' },
  { key: 'maxDrawdownUsd', column: 'max_drawdown_usd' },
  { key: 'tradesCount', column: 'trades_count' },
  { key: 'winCount', column: 'win_count' },
  { key: 'lossCount', column: 'loss_count' },
  { key: 'startedAt', column: 'started_at' },
  { key: 'closedAt', column: 'closed_at' },
];

export type PropFirmConflictCode = 'OPEN_POSITION_EXISTS' | 'CYCLE_STILL_ACTIVE';

export class PropFirmConflictError extends Error {
  public readonly code: PropFirmConflictCode;

  constructor(code: PropFirmConflictCode, message: string) {
    super(message);
    this.name = 'PropFirmConflictError';
    this.code = code;
  }
}

/**
 * Repository for Upcomers $50K Prop Firm challenge cycles and UTC daily snapshots.
 */
export class PropFirmRepo {
  constructor(private db: DatabaseSync) {}

  public createCycle(cycle: PropFirmChallengeCycle): PropFirmChallengeCycle {
    const normalized: PropFirmChallengeCycle = {
      ...cycle,
      isFloorLocked: Boolean(cycle.isFloorLocked),
      realizedPnlUsd: cycle.realizedPnlUsd ?? 0,
      closedAt: cycle.closedAt ?? null,
    };

    const stmt = this.db.prepare(`
      INSERT INTO propfirm_challenge_cycles (
        id, cycle_number, status, starting_balance_usd, current_equity_usd,
        high_water_mark_usd, contractual_trailing_floor_usd, internal_trailing_floor_usd,
        is_floor_locked, profit_target_usd, net_pnl_usd, realized_pnl_usd, net_pnl_pct,
        max_drawdown_usd, trades_count, win_count, loss_count,
        started_at, closed_at
      ) VALUES (
        ?, ?, ?, ?, ?,
        ?, ?, ?,
        ?, ?, ?, ?, ?,
        ?, ?, ?, ?,
        ?, ?
      )
    `);

    stmt.run(
      normalized.id,
      normalized.cycleNumber,
      normalized.status,
      normalized.startingBalanceUsd,
      normalized.currentEquityUsd,
      normalized.highWaterMarkUsd,
      normalized.contractualTrailingFloorUsd,
      normalized.internalTrailingFloorUsd,
      normalized.isFloorLocked ? 1 : 0,
      normalized.profitTargetUsd,
      normalized.netPnlUsd,
      normalized.realizedPnlUsd ?? 0,
      normalized.netPnlPct,
      normalized.maxDrawdownUsd,
      normalized.tradesCount,
      normalized.winCount,
      normalized.lossCount,
      normalized.startedAt,
      normalized.closedAt
    );

    return normalized;
  }

  /**
   * Atomically validates no active trades across any symbol, enforces terminal/halted-trailing
   * cycle status, finalizes HALTED_TRAILING_BUFFER -> FAILED_TRAILING, and inserts Cycle N+1.
   */
  public rolloverCycle(nextCycle: PropFirmChallengeCycle): PropFirmChallengeCycle {
    return runTransaction(this.db, () => {
      const openTrade = this.db
        .prepare(
          `SELECT 1 FROM trades WHERE status IN ('OPEN', 'PARTIALLY_CLOSED', 'CLOSING', 'CLOSING_IN_PROGRESS') LIMIT 1`
        )
        .get();
      if (openTrade) {
        throw new PropFirmConflictError(
          'OPEN_POSITION_EXISTS',
          'Açıq mövqe və ya icra edilən əmr olduğu halda yeni dövrə başladılmır.'
        );
      }

      const latest = this.getLatestCycle();
      if (latest && (latest.status === 'ACTIVE' || latest.status === 'HALTED_DAILY_BUFFER')) {
        throw new PropFirmConflictError(
          'CYCLE_STILL_ACTIVE',
          'Yeni dövrə yalnız cari dövrə PASSED, FAILED və ya HALTED_TRAILING_BUFFER olduqda başlana bilər.'
        );
      }

      if (latest && latest.status === 'HALTED_TRAILING_BUFFER') {
        this.updateCycle(latest.id, {
          status: 'FAILED_TRAILING',
          closedAt: nextCycle.startedAt,
        });
      }

      return this.createCycle({
        ...nextCycle,
        realizedPnlUsd: nextCycle.realizedPnlUsd ?? 0,
      });
    });
  }

  public getActiveCycle(): PropFirmChallengeCycle | null {
    const stmt = this.db.prepare(`
      SELECT * FROM propfirm_challenge_cycles
      WHERE status IN ('ACTIVE', 'HALTED_DAILY_BUFFER', 'HALTED_TRAILING_BUFFER')
      ORDER BY cycle_number DESC, started_at DESC
      LIMIT 1
    `);
    const row = stmt.get() as PropFirmChallengeCycleRow | undefined;
    return row ? mapPropFirmCycleRow(row) : null;
  }

  public getLatestCycle(): PropFirmChallengeCycle | null {
    const stmt = this.db.prepare(`
      SELECT * FROM propfirm_challenge_cycles
      ORDER BY cycle_number DESC, started_at DESC
      LIMIT 1
    `);
    const row = stmt.get() as PropFirmChallengeCycleRow | undefined;
    return row ? mapPropFirmCycleRow(row) : null;
  }

  public listCycles(limit: number = 50): PropFirmChallengeCycle[] {
    const safeLimit = Math.max(0, Math.floor(limit));
    if (safeLimit === 0) return [];

    const stmt = this.db.prepare(`
      SELECT * FROM propfirm_challenge_cycles
      ORDER BY cycle_number DESC, started_at DESC
      LIMIT ?
    `);
    const rows = stmt.all(safeLimit) as unknown as PropFirmChallengeCycleRow[];
    return rows.map(mapPropFirmCycleRow);
  }

  public updateCycle(id: string, patch: Partial<PropFirmChallengeCycle>): void {
    const clauses: string[] = [];
    const values: Array<string | number | null> = [];

    for (const { key, column, isBoolean } of PROPFIRM_CYCLE_PATCH_COLUMNS) {
      const val = patch[key];
      if (val !== undefined) {
        clauses.push(`${column} = ?`);
        if (isBoolean) {
          values.push(val ? 1 : 0);
        } else {
          values.push((val as string | number | null) ?? null);
        }
      }
    }

    if (clauses.length === 0) return;

    const stmt = this.db.prepare(
      `UPDATE propfirm_challenge_cycles SET ${clauses.join(', ')} WHERE id = ?`
    );
    stmt.run(...values, id);
  }

  public listClosedTradeIdsSince(
    startedAtMs: number,
    brokerMode: BrokerMode = 'BINANCE_DEMO'
  ): string[] {
    const stmt = this.db.prepare(`
      SELECT id FROM trades
      WHERE broker_mode = ? AND status = 'CLOSED' AND closed_at >= ?
    `);
    const rows = stmt.all(brokerMode, startedAtMs) as Array<{ id: string }>;
    return rows.map((r) => r.id);
  }

  public getNextCycleNumber(): number {
    const stmt = this.db.prepare(
      'SELECT COALESCE(MAX(cycle_number), 0) AS max_num FROM propfirm_challenge_cycles'
    );
    const row = stmt.get() as { max_num: number } | undefined;
    return Number(row?.max_num ?? 0) + 1;
  }

  public countConsecutivePassedCycles(): number {
    const stmt = this.db.prepare(`
      SELECT status FROM propfirm_challenge_cycles
      ORDER BY cycle_number DESC, started_at DESC
    `);
    const rows = stmt.all() as unknown as Array<{ status: PropFirmCycleStatus }>;

    let consecutive = 0;
    let seenTerminal = false;

    for (const row of rows) {
      if (row.status === 'PASSED') {
        seenTerminal = true;
        consecutive += 1;
      } else if (row.status === 'FAILED_DAILY' || row.status === 'FAILED_TRAILING') {
        break;
      } else if (!seenTerminal) {
        // Skip non-terminal active/halted cycle(s) at the head
        continue;
      } else {
        break;
      }
    }

    return consecutive;
  }

  public getDailySnapshot(utcDate: string, cycleId: string): PropFirmDailySnapshot | null {
    const stmt = this.db.prepare(`
      SELECT * FROM propfirm_daily_snapshots
      WHERE utc_date = ? AND cycle_id = ?
    `);
    const row = stmt.get(utcDate, cycleId) as PropFirmDailySnapshotRow | undefined;
    return row ? mapPropFirmDailySnapshotRow(row) : null;
  }

  public upsertDailySnapshot(snapshot: PropFirmDailySnapshot): void {
    const stmt = this.db.prepare(`
      INSERT INTO propfirm_daily_snapshots (
        utc_date, cycle_id, day_start_equity_usd, current_equity_usd,
        daily_pnl_usd, daily_min_equity_usd, daily_halted, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(utc_date, cycle_id) DO UPDATE SET
        day_start_equity_usd = excluded.day_start_equity_usd,
        current_equity_usd = excluded.current_equity_usd,
        daily_pnl_usd = excluded.daily_pnl_usd,
        daily_min_equity_usd = excluded.daily_min_equity_usd,
        daily_halted = excluded.daily_halted,
        updated_at = excluded.updated_at
    `);

    stmt.run(
      snapshot.utcDate,
      snapshot.cycleId,
      snapshot.dayStartEquityUsd,
      snapshot.currentEquityUsd,
      snapshot.dailyPnlUsd,
      snapshot.dailyMinEquityUsd,
      snapshot.dailyHalted ? 1 : 0,
      snapshot.updatedAt
    );
  }
}



