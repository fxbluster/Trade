PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;
PRAGMA wal_autocheckpoint = 1000;

CREATE TABLE IF NOT EXISTS trades (
    id TEXT PRIMARY KEY,                       -- UUID v4
    symbol TEXT NOT NULL,
    broker_mode TEXT NOT NULL,                 -- 'BINANCE_DEMO' | 'LOCAL_PAPER'
    side TEXT NOT NULL,                        -- 'BUY' | 'SELL'
    status TEXT NOT NULL,                      -- 'OPEN' | 'PARTIALLY_CLOSED' | 'CLOSING' | 'CLOSED'
    entry_price REAL NOT NULL,
    exit_price REAL,
    quantity REAL NOT NULL,
    remaining_qty REAL NOT NULL,               -- Remaining quantity after partial TP1 exit
    leverage INTEGER NOT NULL,
    margin_usd REAL NOT NULL,
    stop_loss REAL,
    tp1 REAL,
    tp2 REAL,
    be_price REAL,
    is_breakeven INTEGER DEFAULT 0,
    peak_price REAL,
    peak_mfe REAL,
    trailing_stop_active INTEGER DEFAULT 0,
    client_order_id TEXT,                      -- tos_${id}_ent
    client_sl_id TEXT,                         -- tos_${id}_sl
    client_tp1_id TEXT,                        -- tos_${id}_tp1
    client_tp2_id TEXT,                        -- tos_${id}_tp2
    entry_order_id TEXT,
    sl_algo_id TEXT,
    tp1_algo_id TEXT,
    tp2_algo_id TEXT,
    realized_pnl REAL DEFAULT 0,
    fees_usd REAL DEFAULT 0,
    exit_reason TEXT,
    opened_at INTEGER NOT NULL,                -- UTC Unix ms
    closed_at INTEGER                          -- UTC Unix ms
);

CREATE INDEX IF NOT EXISTS idx_trades_status ON trades(status);
CREATE INDEX IF NOT EXISTS idx_trades_symbol ON trades(symbol);

CREATE TABLE IF NOT EXISTS fills (
    binance_trade_id TEXT PRIMARY KEY,
    trade_id TEXT NOT NULL REFERENCES trades(id) ON DELETE CASCADE,
    order_id TEXT NOT NULL,
    symbol TEXT NOT NULL,
    side TEXT NOT NULL,
    price REAL NOT NULL,
    qty REAL NOT NULL,
    realized_pnl REAL DEFAULT 0,
    commission REAL DEFAULT 0,
    commission_asset TEXT,
    filled_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_fills_trade_id ON fills(trade_id);

CREATE TABLE IF NOT EXISTS risk_state (
    broker_mode TEXT PRIMARY KEY,              -- 'BINANCE_DEMO' | 'LOCAL_PAPER'
    consecutive_losses INTEGER DEFAULT 0,
    cooldown_until INTEGER DEFAULT 0,          -- UTC Unix ms
    cooldown_reason TEXT,
    session_net_pnl REAL DEFAULT 0,
    session_started_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);

-- Seed initial risk state rows for both broker modes
INSERT OR IGNORE INTO risk_state (broker_mode, consecutive_losses, cooldown_until, cooldown_reason, session_net_pnl, session_started_at, updated_at) 
VALUES 
    ('BINANCE_DEMO', 0, 0, NULL, 0.0, strftime('%s','now')*1000, strftime('%s','now')*1000),
    ('LOCAL_PAPER', 0, 0, NULL, 0.0, strftime('%s','now')*1000, strftime('%s','now')*1000);

CREATE TABLE IF NOT EXISTS audit_log (
    id TEXT PRIMARY KEY,                       -- UUID v4
    event_type TEXT NOT NULL,
    actor TEXT NOT NULL,
    reason TEXT NOT NULL,
    payload_json TEXT,
    created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,                      -- e.g. 'paper_wallet_balance'
    value_json TEXT NOT NULL,
    updated_at INTEGER NOT NULL
);

-- Seed initial paper wallet balance ($10,000 USDT)
INSERT OR IGNORE INTO settings (key, value_json, updated_at)
VALUES ('paper_wallet_balance', '{"balance": 10000.0, "currency": "USDT"}', strftime('%s','now')*1000);

CREATE TABLE IF NOT EXISTS decision_logs (
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
    created_at INTEGER NOT NULL,
    factor_telemetry_json TEXT,
    execution_chase_json TEXT,
    sizing_breakdown_json TEXT,
    noise_band_state INTEGER DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_decision_logs_ts ON decision_logs(timestamp);
CREATE INDEX IF NOT EXISTS idx_decision_logs_sym_ts ON decision_logs(symbol, timestamp);
CREATE INDEX IF NOT EXISTS idx_decision_logs_shadow ON decision_logs(shadow_status, expires_at);

-- Table 1: Initial Impulse & Pillar Telemetry Snapshot
CREATE TABLE IF NOT EXISTS pillar_telemetry_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp INTEGER NOT NULL,
  symbol TEXT NOT NULL,
  trigger_type TEXT NOT NULL, -- 'PILLAR_DIVERGENCE', 'VOLATILITY_EXPANSION', 'CONSENSUS_ATTEMPT'
  mark_price REAL NOT NULL,
  atr_14 REAL NOT NULL,
  composite_score REAL NOT NULL,
  consensus_side TEXT NOT NULL, -- 'BUY', 'SELL', 'NEUTRAL'
  active_pillars_count INTEGER NOT NULL,
  p1_vote TEXT NOT NULL DEFAULT 'WAIT',
  p2_vote TEXT NOT NULL DEFAULT 'WAIT',
  p3_vote TEXT NOT NULL DEFAULT 'WAIT',
  p4_vote TEXT NOT NULL DEFAULT 'WAIT',
  p5_vote TEXT NOT NULL DEFAULT 'WAIT',
  p6_vote TEXT NOT NULL DEFAULT 'WAIT',
  p7_vote TEXT NOT NULL DEFAULT 'WAIT',
  p1_macro_regime TEXT NOT NULL,    -- JSON: {state, score, raw}
  p2_native_smc TEXT NOT NULL,       -- JSON: {state, score, raw}
  p3_cvd_absorption TEXT NOT NULL,   -- JSON: {state, score, raw}
  p4_order_flow_l2 TEXT NOT NULL,    -- JSON: {state, score, raw}
  p5_liq_clusters TEXT NOT NULL,     -- JSON: {state, score, raw}
  p6_momentum_rvol TEXT NOT NULL,    -- JSON: {state, score, raw}
  p7_sentiment_macro TEXT NOT NULL,  -- JSON: {state, score, raw}
  status TEXT NOT NULL DEFAULT 'EVALUATING' -- 'EVALUATING', 'SETTLED', 'EXPIRED'
);

CREATE INDEX IF NOT EXISTS idx_pillar_events_ts ON pillar_telemetry_events(timestamp);
CREATE INDEX IF NOT EXISTS idx_pillar_events_sym_status ON pillar_telemetry_events(symbol, status);

-- Table 2: Multi-Horizon Outcome Settlement
CREATE TABLE IF NOT EXISTS pillar_horizon_evaluations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id INTEGER NOT NULL REFERENCES pillar_telemetry_events(id) ON DELETE CASCADE,
  horizon TEXT NOT NULL, -- '1m', '5m', '15m', '60m'
  settle_timestamp INTEGER NOT NULL,
  settle_price REAL NOT NULL,
  price_change_abs REAL NOT NULL,
  price_change_pct REAL NOT NULL,
  mfe_pct REAL NOT NULL, -- Maximum Favorable Excursion
  mae_pct REAL NOT NULL, -- Maximum Adverse Excursion
  directional_outcome TEXT NOT NULL, -- 'BULLISH_EXPANSION', 'BEARISH_EXPANSION', 'ADVERSE_STOPOUT', 'CHOP'
  p1_status TEXT NOT NULL DEFAULT 'NEUTRAL' CHECK(p1_status IN ('TRUE_POSITIVE','FALSE_POSITIVE','FALSE_NEGATIVE','TRUE_NEGATIVE','NEUTRAL')),
  p2_status TEXT NOT NULL DEFAULT 'NEUTRAL' CHECK(p2_status IN ('TRUE_POSITIVE','FALSE_POSITIVE','FALSE_NEGATIVE','TRUE_NEGATIVE','NEUTRAL')),
  p3_status TEXT NOT NULL DEFAULT 'NEUTRAL' CHECK(p3_status IN ('TRUE_POSITIVE','FALSE_POSITIVE','FALSE_NEGATIVE','TRUE_NEGATIVE','NEUTRAL')),
  p4_status TEXT NOT NULL DEFAULT 'NEUTRAL' CHECK(p4_status IN ('TRUE_POSITIVE','FALSE_POSITIVE','FALSE_NEGATIVE','TRUE_NEGATIVE','NEUTRAL')),
  p5_status TEXT NOT NULL DEFAULT 'NEUTRAL' CHECK(p5_status IN ('TRUE_POSITIVE','FALSE_POSITIVE','FALSE_NEGATIVE','TRUE_NEGATIVE','NEUTRAL')),
  p6_status TEXT NOT NULL DEFAULT 'NEUTRAL' CHECK(p6_status IN ('TRUE_POSITIVE','FALSE_POSITIVE','FALSE_NEGATIVE','TRUE_NEGATIVE','NEUTRAL')),
  p7_status TEXT NOT NULL DEFAULT 'NEUTRAL' CHECK(p7_status IN ('TRUE_POSITIVE','FALSE_POSITIVE','FALSE_NEGATIVE','TRUE_NEGATIVE','NEUTRAL'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_horizon_event_horizon ON pillar_horizon_evaluations(event_id, horizon);
CREATE INDEX IF NOT EXISTS idx_horizon_eval_horizon_settle ON pillar_horizon_evaluations(horizon, settle_timestamp);

-- Table 3: Permanent Daily Pillar Scorecards (Archived Rollup)
CREATE TABLE IF NOT EXISTS pillar_daily_scorecards (
  date TEXT NOT NULL, -- 'YYYY-MM-DD'
  symbol TEXT NOT NULL,
  horizon TEXT NOT NULL,
  scorecards_json TEXT NOT NULL,
  sample_size INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (date, symbol, horizon)
);

CREATE TABLE IF NOT EXISTS economic_events (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  timestamp INTEGER NOT NULL,
  impact TEXT NOT NULL,
  currency TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_economic_events_ts ON economic_events(timestamp);

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





