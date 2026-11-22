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
  ConfluencePillarId
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
  { id: 'NATIVE_SMC', title: 'Native SMC', baselineWeight: 25.0, pKey: 'p2' },
  { id: 'CVD_ABSORPTION', title: 'CVD Absorption', baselineWeight: 20.0, pKey: 'p3' },
  { id: 'ORDER_FLOW_L2', title: 'Order Flow L2', baselineWeight: 15.0, pKey: 'p4' },
  { id: 'LIQ_CLUSTERS', title: 'Liquidity Clusters', baselineWeight: 7.5, pKey: 'p5' },
  { id: 'MOMENTUM_RVOL', title: 'Momentum & rVol', baselineWeight: 5.0, pKey: 'p6' },
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


