import fs from 'node:fs';
import path from 'node:path';
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
  TradeSide
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

  return db;
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
    throw err;
  }
}

/**
 * Repository for trades table.
 */
export class TradesRepo {
  constructor(private db: DatabaseSync) {}

  insert(trade: TradeRecord): void {
    const stmt = this.db.prepare(`
      INSERT INTO trades (
        id, symbol, broker_mode, side, status, entry_price, exit_price,
        quantity, remaining_qty, leverage, margin_usd, stop_loss, tp1, tp2,
        be_price, is_breakeven, client_order_id, client_sl_id, client_tp1_id,
        client_tp2_id, entry_order_id, sl_algo_id, tp1_algo_id, tp2_algo_id,
        realized_pnl, fees_usd, exit_reason, opened_at, closed_at
      ) VALUES (
        ?, ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?,
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
  }

  getById(id: string): TradeRecord | null {
    const stmt = this.db.prepare('SELECT * FROM trades WHERE id = ?');
    const row = stmt.get(id);
    return row ? (row as unknown as TradeRecord) : null;
  }

  getActivePosition(brokerMode: BrokerMode, symbol?: string): TradeRecord | null {
    if (symbol) {
      const stmt = this.db.prepare(`
        SELECT * FROM trades 
        WHERE broker_mode = ? AND symbol = ? AND status IN ('OPEN', 'PARTIALLY_CLOSED', 'CLOSING')
        ORDER BY opened_at DESC LIMIT 1
      `);
      const row = stmt.get(brokerMode, symbol);
      return row ? (row as unknown as TradeRecord) : null;
    } else {
      const stmt = this.db.prepare(`
        SELECT * FROM trades 
        WHERE broker_mode = ? AND status IN ('OPEN', 'PARTIALLY_CLOSED', 'CLOSING')
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
        expires_at, shadow_closed_at, error_message, created_at
      ) VALUES (
        ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?,
        ?, ?, ?, ?, ?,
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
      record.created_at
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

