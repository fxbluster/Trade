PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;

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
    created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_decision_logs_ts ON decision_logs(timestamp);
CREATE INDEX IF NOT EXISTS idx_decision_logs_sym_ts ON decision_logs(symbol, timestamp);
CREATE INDEX IF NOT EXISTS idx_decision_logs_shadow ON decision_logs(shadow_status, expires_at);

