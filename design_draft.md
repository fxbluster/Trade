# TradeOS Decision Audit Trail & Counterfactual Shadow Tracking Engine

* **Author:** fxbluster
* **Status:** Approved & Verified (Stage 8/9 Remediated - Ready for Implementation)
* **Date:** 2026-11-21

--------------------------------------------------------------------------------

## Overview

This technical specification defines the architecture, schema, state machine, and API contracts for the **TradeOS Decision Audit Trail & Counterfactual Shadow Tracking Engine**.

During live trading sessions running 4 to 8 hours, TradeOS evaluates composite confluence at 4Hz (250ms interval) and executes autonomous trades via Auto-Pilot. However, once a session ends, operators currently have zero structured visibility into why specific trades were executed, why borderline setups were blocked, or whether blocked setups would have resulted in capital preservation or missed profits.

This engine introduces:
1. **Deterministic Decision Event Logging**: Captures structured snapshots into a dedicated SQLite `decision_logs` table whenever a setup crosses the 60% composite score threshold or Auto-Pilot executes an order.
2. **Crash-Resilient Counterfactual Shadow Tracking**: Instantiates passive shadow setups for vetoed qualifying setups (>= 60% score) with virtual 1.5 ATR Stop-Loss (matching production Auto-Pilot), 1.5 ATR Take-Profit, an explicit 60-minute expiration horizon (`expires_at`), and a mandatory 0.15% fee/slippage friction haircut. Evaluates outcomes lazily against subsequent closed 1m klines (starting from `(candle.time * 1000) >= setup.timestamp`) to deterministically categorize decisions as `SAVED_CAPITAL`, `MISSED_PROFIT`, `EXPIRED`, or `RESOLVED_AMBIGUOUS_VOLATILITY`.
3. **Session Audit & Dynamic Export**: Formats and streams structured Markdown and JSON reports dynamically via `GET /api/audit/daily` (supporting `?session=current`, `?since=<ms>`, and `?format=json|markdown`), accessible via a dedicated Daily Audit export control in the Cockpit HUD `TopBar.tsx`.

## The Problem

1. **Ephemeral Reasoning Loss:** Confluence scores and veto matrix layers are computed continuously in memory. When a setup occurs, its 7-pillar breakdown and veto rationale scroll past in terminal logs and are permanently lost upon process restart.
2. **Hindsight Bias in Veto Evaluation:** Operators cannot objectively assess whether risk filters (Macro Veto, Cooldown, Dead-SL Armor) are effectively protecting capital or starving profitable setups. Without simulated shadow tracking, risk tuning remains guesswork.
3. **Unthrottled Disk Write Contention:** Naive tick-level database writes would trigger thousands of disk operations per hour in oscillating markets, blocking the single-threaded Node.js event loop and introducing latency spikes into WebSocket telemetry.
4. **Unmodeled Execution Friction:** Theoretical price targets (e.g., +1.5 ATR) ignore 10x leverage exchange taker fees (0.10% round-trip) and bid-ask slippage (0.05%), creating illusory "missed profit" claims that would have lost money in live execution.

## Goals

* **Deterministic Decision Logging:** Record complete decision snapshots (timestamp, symbol, side, composite score, 7-pillar breakdown, macro regime, veto rationale, execution status, simulated margin and leverage) in SQLite via `node:sqlite`.
* **Stateful Rising-Edge Hysteresis Latch:** Restrict pre-trade shadow logging to genuine transitions (score rising from < 50% to >= 60%) keyed by `(symbol, side)` with a 3-minute symbol cooldown, capping session log volume to 10–40 meaningful records. Real Auto-Pilot order executions bypass this latch, write immediately, and reset/disarm the latch for that symbol.
* **Passive Crash-Resilient Shadow Tracking:** Store shadow setups directly in SQLite in an `OPEN` state with explicit `expires_at` (60m TTL) and evaluate them lazily against closed 1m candle highs/lows without persistent in-memory timers (`setTimeout`), recovering pending setups upon process restart.
* **Symmetric Friction-Adjusted Counterfactual Valuation:** Deduct a synthetic 0.15% notional friction haircut and evaluate both Long and Short setups with exact futures position sizing, strict entry-candle boundary enforcement (`candle.time * 1000 >= setup.timestamp`), and dual-wick volatility safeguards.
* **Daily Export & Cockpit HUD Integration:** Expose `GET /api/audit/daily` in `routes.ts` with session query parameters (default JSON, format=markdown for report download) and add a Daily Audit export button to `apps/web/src/components/TopBar.tsx` using `apiClient.ts` to trigger authenticated in-memory downloads.

## Non-Goals

* High-frequency tick-by-tick logging (raw order flow and order book depth remain in in-memory ring buffers).
* Machine learning or automated retuning of pillar weights based on audit statistics (engine outputs audits strictly for human and LLM review).
* Introducing external third-party database dependencies (PostgreSQL, Redis, ClickHouse).

## Resolved Architectural Decisions

* **Decision 1: SQLite Concurrency & Storage**: Reusing existing `apps/server/src/db/sqlite.ts` `DatabaseSync` with `PRAGMA journal_mode = WAL;` and `PRAGMA busy_timeout = 5000;`. All write operations are executed directly and synchronously via prepared statements. At ~10–40 inserts per 8-hour session (< 0.2ms each), direct synchronous inserts guarantee crash resilience without in-memory buffering complexity.
* **Decision 2: Intra-Bar Dual-Wick Conflict Resolution**: If an individual candle's wick touches both SL and TP and sub-candle 1m sequence cannot be verified, classify the setup as `RESOLVED_AMBIGUOUS_VOLATILITY` with PnL = $0.00 to avoid survivorship bias in favor of risk filters.
* **Decision 3: Execution Order Path Decoupling & Latch Reset**: Real Auto-Pilot execution events (`EXECUTED` or `FAILED`) write directly to `decision_logs`, never wait on the pre-trade 180s cooldown, and immediately disarm the hysteresis latch for `(symbol, side)` to prevent duplicate shadow setups while the live trade is open.
* **Decision 4: Entry-Candle Boundary Enforcement**: Closed 1m candle evaluations evaluate only bars where `(candle.time * 1000) >= setup.timestamp`, eliminating retrospective look-behind bias from wicks prior to setup instantiation.
* **Decision 5: Decoupled TP State Machine**: Take-profit triggers strictly on price level contact (`candle.high >= shadow_tp` for BUY, `candle.low <= shadow_tp` for SELL) and terminates immediately. If Net PnL > 0, status is `MISSED_PROFIT`; if Net PnL <= 0, status is `SAVED_CAPITAL` (scratch trade saved from friction drag).

## Critical User Journeys (CUJs)

### CUJ 1: Execution Audit on Auto-Pilot Firing
* **Given**: Auto-Pilot is armed with Consensus Threshold 4/7 and SOLUSDT composite score reaches 78% (Macro Bullish, SMC FVG tap, CVD absorption).
* **When**: Auto-Pilot triggers an automated market Long order on Binance Demo.
* **Then**: `AutoPilotManager` invokes the `onOrderDispatched` callback. `DecisionAuditService` immediately writes an `EXECUTED` decision record with full pillar breakdown, execution price, margin ($100), leverage (10x), and assigned trade ID. The hysteresis latch for `(SOLUSDT, BUY)` is reset to disarmed.

### CUJ 2: Counterfactual Shadow Tracking on Macro Veto
* **Given**: SOLUSDT prints a 1m price impulse with composite score 65%, but 1h price is below 1h EMA200 (`macroVetoActive = true`).
* **When**: Auto-Pilot blocks the order due to `MACRO_VETO: Longs blocked below 1h EMA200`.
* **Then**: `DecisionAuditService` records a `BLOCKED` decision event, captures a passive shadow setup with `entryPrice = 70.50`, `sl = 69.45 (1.5 ATR)`, `tp = 71.55 (1.5 ATR)`, `expires_at = timestamp + 3600000`, and status `OPEN`. Over subsequent closed 1m candles (`(candle.time * 1000) >= setup.timestamp`):
  * If price touches 69.45 first, status updates to `SAVED_CAPITAL` (Veto prevented a -$15.00 loss).
  * If price touches 71.55 first: if Net PnL > 0, status updates to `MISSED_PROFIT`; if Net PnL <= 0, status updates to `SAVED_CAPITAL`.
  * If both levels are touched within the same candle without verifiable sub-candle order, status updates to `RESOLVED_AMBIGUOUS_VOLATILITY`.
  * If 60 minutes elapse without touching SL or TP (`(candle.time * 1000) >= expires_at`), status updates to `EXPIRED`.

### CUJ 3: Post-Session Audit Export
* **Given**: The operator runs TradeOS for 5 hours during the European/US overlap.
* **When**: The operator clicks Daily Audit in the Cockpit HUD header (`TopBar.tsx`).
* **Then**: `apiClient.downloadDailyAudit('markdown', 'current')` fetches `GET /api/audit/daily?session=current&format=markdown` with Bearer auth, downloading `audit-2026-11-21.md` containing session stats: total setups evaluated, trades executed, veto breakdown (Macro Veto: 4, Cooldown: 1), capital saved ($45.20), missed profit ($18.50), expired PnL ($0.00), and net risk value ($26.70). An API client calling without `format=markdown` receives `application/json` by default.

## Technical Plan (Architecture)

### System Flow & Decision Lifecycle

```text
 Binance WebSocket Tick / Analysis (4Hz)
                   │
                   ▼
       [ Confluence Evaluator ]
                   │
         Composite Score Calculated
                   │
                   ├──────────────────────────────────┐
                   │ Live Order Execution             │ Pre-Trade Veto Setup
                   ▼                                  ▼
     ┌────────────────────────────┐     ┌────────────────────────────┐
     │ Auto-Pilot Order Action    │     │  Rising-Edge Latch         │
     │ (EXECUTED or FAILED)       │     │  (Score >= 60% AND         │
     │                            │     │   isArmed == true AND      │
     │ Direct Write & Disarm Latch│     │   (Symbol, Side) Cooldown) │
     └─────────────┬──────────────┘     └─────────────┬──────────────┘
                   │                                  │ YES
                   ▼                                  ▼
              SQLite Log                         SQLite Log
             decision_logs                      decision_logs
           (Action: EXECUTED)                 (Action: BLOCKED)
                                                      │
                                                      ▼
                                                 Instantiate
                                                 Shadow Setup
                                                (Status: OPEN,
                                                 TTL: 60 min)
                                                      │
                                                      ▼ (On 1m Candle Close,
                                                         candle.time * 1000 >= setup.timestamp)
                                                 Evaluate SL/TP
                                                 with 0.15% Haircut
                                                      │
                                                      ▼
                                                 Update SQLite
                                                 (SAVED_CAPITAL /
                                                  MISSED_PROFIT /
                                                  EXPIRED /
                                                  RESOLVED_AMBIGUOUS_VOLATILITY)
```

### 1. Database Schema DDL (`schema.sql`)

```sql
CREATE TABLE IF NOT EXISTS decision_logs (
    id TEXT PRIMARY KEY,                       -- UUID v4 (dec_${uuid})
    timestamp INTEGER NOT NULL,                -- UTC Unix ms
    symbol TEXT NOT NULL,
    side TEXT NOT NULL,                        -- 'BUY' | 'SELL'
    action TEXT NOT NULL,                      -- 'EXECUTED' | 'BLOCKED' | 'FAILED'
    composite_score REAL NOT NULL,
    pillars_json TEXT NOT NULL,                -- Serialized 7-pillar breakdown
    macro_regime TEXT NOT NULL,                -- 'MACRO_BULLISH' | 'MACRO_BEARISH' | 'MACRO_RANGING' | 'DEGRADED'
    macro_veto_active INTEGER DEFAULT 0,
    veto_reasons_json TEXT,                    -- Array of string veto reasons
    execution_price REAL NOT NULL,             -- Reference mid-price for BLOCKED, or fill price for EXECUTED/FAILED
    margin_usd REAL NOT NULL,                  -- Simulated or real margin allocation
    leverage INTEGER NOT NULL,                 -- Configured leverage (e.g. 10)
    atr REAL NOT NULL,
    trade_id TEXT REFERENCES trades(id) ON DELETE SET NULL, -- References trades(id) if EXECUTED
    shadow_status TEXT,                        -- 'OPEN' | 'SAVED_CAPITAL' | 'MISSED_PROFIT' | 'EXPIRED' | 'RESOLVED_AMBIGUOUS_VOLATILITY'
    shadow_sl REAL,
    shadow_tp REAL,
    shadow_pnl_usd REAL,                       -- True trade PnL (negative for losses, positive for gains)
    expires_at INTEGER,                        -- UTC Unix ms (timestamp + 3600000)
    shadow_closed_at INTEGER,
    error_message TEXT,                        -- Set if action = 'FAILED'
    created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_decision_logs_ts ON decision_logs(timestamp);
CREATE INDEX IF NOT EXISTS idx_decision_logs_sym_ts ON decision_logs(symbol, timestamp);
CREATE INDEX IF NOT EXISTS idx_decision_logs_shadow ON decision_logs(shadow_status, expires_at);
```

The 7 pillars captured in `pillars_json` match the production `ConfluencePillarId` in `@tradeos/shared`:
1. `'MACRO_REGIME'` (Trend & EMA200 alignment)
2. `'NATIVE_SMC'` (FVG, Order Blocks, Liquidity Sweeps)
3. `'CVD_ABSORPTION'` (Delta volume vs price divergence)
4. `'ORDER_FLOW_L2'` (Order book bid/ask pressure)
5. `'LIQ_CLUSTERS'` (Proximity to liquidation pools)
6. `'MOMENTUM_RVOL'` (RSI, MACD, and relative volume)
7. `'SENTIMENT_MACRO'` (Macro news and market-wide sentiment score)

### 2. Shared Type Contracts (`packages/shared/src/contracts.ts`)

```typescript
export type ShadowSetupStatus =
  | 'OPEN'
  | 'SAVED_CAPITAL'
  | 'MISSED_PROFIT'
  | 'EXPIRED'
  | 'RESOLVED_AMBIGUOUS_VOLATILITY';

export type DecisionAction = 'EXECUTED' | 'BLOCKED' | 'FAILED';

export interface DecisionLogRecord {
  id: string;
  timestamp: number;
  symbol: string;
  side: TradeSide;
  action: DecisionAction;
  composite_score: number;
  pillars_json: string;
  macro_regime: MacroRegime;
  macro_veto_active: number;
  veto_reasons_json: string | null;
  execution_price: number;
  margin_usd: number;
  leverage: number;
  atr: number;
  trade_id: string | null;
  shadow_status: ShadowSetupStatus | null;
  shadow_sl: number | null;
  shadow_tp: number | null;
  shadow_pnl_usd: number | null;
  expires_at: number | null;
  shadow_closed_at: number | null;
  error_message: string | null;
  created_at: number;
}

export interface DailyAuditSummary {
  total_setups: number;
  executed_trades: number;
  blocked_setups: number;
  capital_saved_usd: number;     // Sum of Math.abs(shadow_pnl_usd) for SAVED_CAPITAL
  missed_profit_usd: number;     // Sum of shadow_pnl_usd for MISSED_PROFIT
  expired_pnl_usd: number;       // Sum of shadow_pnl_usd for EXPIRED
  net_risk_value_usd: number;    // capital_saved_usd - missed_profit_usd
  veto_breakdown: Record<string, number>;
}

export interface DailyAuditResponse {
  summary: DailyAuditSummary;
  records: DecisionLogRecord[];
  generated_at: number;
}
```

### 3. Stateful Rising-Edge Hysteresis Latch

```typescript
export interface LatchKey {
  symbol: string;
  side: 'BUY' | 'SELL';
}

export interface LatchState {
  lastScore: number;
  lastTriggeredAt: number;
  isArmed: boolean; // Transitions to true when score falls below 50% reset deadband
}

// Latching parameters:
const TRIGGER_THRESHOLD = 60;
const RESET_DEADBAND = 50;
const COOLDOWN_MS = 180_000; // 3 minutes per (symbol, side)

/**
 * Latch evaluation rules:
 * 1. Arming: When score < RESET_DEADBAND (50%), set state.isArmed = true.
 * 2. Normal Trigger: If state.isArmed === true && score >= TRIGGER_THRESHOLD (60%) && (now - lastTriggeredAt >= COOLDOWN_MS):
 *    - Check if there is already an active 'OPEN' shadow setup for (symbol, side). If so, suppress duplicate setup.
 *    - Trigger decision event.
 *    - Set state.isArmed = false, state.lastTriggeredAt = now.
 * 3. Production Execution: When Auto-Pilot executes an order (EXECUTED), immediately set state.isArmed = false, state.lastTriggeredAt = now.
 */
```

### 4. Friction-Adjusted Counterfactual Valuation Formulas

Position Sizing & Notional Baseline:
$$\text{Position Size} = \frac{\text{Margin USD} \times \text{Leverage}}{\text{Entry Price}}$$
$$\text{Notional Value} = \text{Margin USD} \times \text{Leverage}$$
$$\text{Friction USD} = \text{Notional Value} \times 0.0015$$

Evaluation Boundary:
* Setups evaluate closed 1m candles where $(\text{candle.time} \times 1000) \ge \text{setup.timestamp}$ to eliminate retrospective look-behind bias.

For `BUY` (Long) Setups:
* $\text{Gross PnL USD} = (\text{Exit Price} - \text{Entry Price}) \times \text{Position Size}$
* $\text{Net PnL USD} = \text{Gross PnL USD} - \text{Friction USD}$
* Stop Loss Trigger: $\text{candle.low} \le \text{shadow\_sl} \implies \text{SAVED\_CAPITAL}$ ($\text{Exit Price} = \text{shadow\_sl}$)
* Take Profit Trigger: $\text{candle.high} \ge \text{shadow\_tp}$ ($\text{Exit Price} = \text{shadow\_tp}$):
  * If $\text{Net PnL USD} > 0 \implies \text{MISSED\_PROFIT}$
  * If $\text{Net PnL USD} \le 0 \implies \text{SAVED\_CAPITAL}$ (capital saved from negative friction drag)

For `SELL` (Short) Setups:
* $\text{Gross PnL USD} = (\text{Entry Price} - \text{Exit Price}) \times \text{Position Size}$
* $\text{Net PnL USD} = \text{Gross PnL USD} - \text{Friction USD}$
* Stop Loss Trigger: $\text{candle.high} \ge \text{shadow\_sl} \implies \text{SAVED\_CAPITAL}$ ($\text{Exit Price} = \text{shadow\_sl}$)
* Take Profit Trigger: $\text{candle.low} \le \text{shadow\_tp}$ ($\text{Exit Price} = \text{shadow\_tp}$):
  * If $\text{Net PnL USD} > 0 \implies \text{MISSED\_PROFIT}$
  * If $\text{Net PnL USD} \le 0 \implies \text{SAVED\_CAPITAL}$

Dual-Wick & Expiration Safeguards:
* Dual-Wick Conflict: If both SL and TP triggers fire within the same candle and sub-candle 1m order cannot be verified, classify as `RESOLVED_AMBIGUOUS_VOLATILITY` with $\text{Net PnL USD} = 0.00$.
* Expiration Horizon: If $(\text{candle.time} \times 1000) \ge \text{expires\_at}$, classify as `EXPIRED` with mark-to-market net PnL calculated from candle close.

## Alternatives Considered

### Alternative A: Active In-Memory JavaScript Timers (`setTimeout`)
* **Pros**: Simple to prototype.
* **Cons**: Consumes V8 heap, crashes on tick storms, and loses all active shadow state upon server restart or PC wake.
* **Reason for Rejection**: Passive SQLite persistence with closed-candle evaluation eliminates timer-based retention and recovers pending setups upon process restart.

### Alternative B: Flat JSON Lines (`.jsonl`) Append-Only Log
* **Pros**: Zero database schema modification.
* **Cons**: No indexation by symbol or shadow status; concurrent reads during daily export can cause partial file read errors.
* **Reason for Rejection**: `node:sqlite` is already integrated with WAL mode, offering ACID transactions and indexed queries with zero extra dependencies.

### Alternative C: Unlatched Continuous Logging (Every 250ms Calculation)
* **Pros**: Captures every microsecond tick.
* **Cons**: Creates 14,000+ duplicate rows per hour during consolidations, polluting daily summaries and causing I/O wear.
* **Reason for Rejection**: Rising-edge hysteresis captures the true decision transition without disk flooding.

--------------------------------------------------------------------------------

## Risks & Limits

1. **Main-Thread SQLite Event Loop Latency**:
   * *Risk*: `DatabaseSync` is synchronous; prolonged filesystem lock acquisition could delay tick processing.
   * *Mitigation*: Direct synchronous inserts in WAL mode take < 0.2ms. With session volume capped to 10–40 records, no asynchronous buffer is required, ensuring 100% crash resilience without race conditions.
2. **Offline Downtime Candle Gap**:
   * *Risk*: Setups reaching SL/TP while the server is stopped or restarted remain unresolved.
   * *Mitigation*: On server boot, `DecisionAuditService` queries open setups, detects the downtime interval, and queries Binance REST `/fapi/v1/klines` with `startTime` and `endTime` capped to $[\text{created\_at}, \min(\text{Date.now()}, \text{expires\_at})]$ ($\le 60$ candles per setup) wrapped in `try/catch` to settle offline outcomes deterministically.
3. **Session Rollover Across Midnight UTC**:
   * *Risk*: Fixed-date queries truncate overnight trading sessions.
   * *Mitigation*: Support `?session=current` and `?since=<ms>` query parameters in `GET /api/audit/daily`.
4. **API Access Control & Payload Options**:
   * *Risk*: Exposing internal decision logs over HTTP without authorization or returning wrong mime types.
   * *Mitigation*: Gate `GET /api/audit/daily` with `requireSessionToken(SESSION_TOKEN)`. Default response is `application/json`; return `text/markdown` when `?format=markdown` is requested.

--------------------------------------------------------------------------------

## Non-Functional Requirements

* **Performance & Latency**: `DecisionLogsRepo.insert()` must complete in under 2ms. All evaluations must run on candle close or throttled tick cycles (<= 4Hz).
* **Storage Footprint**: Capped to ~50 records per 8-hour session (~50KB/day). Startup retention pruning executes `DELETE FROM decision_logs WHERE timestamp < ?` (14-day retention).
* **Rollout & Backward Compatibility**: `CREATE TABLE IF NOT EXISTS` ensures existing database files upgrade automatically on startup without manual migration scripts.

--------------------------------------------------------------------------------

## Open Questions

All core architecture, latching rules, pricing mathematics, and database schema decisions have been resolved and approved across review rounds. Zero open architectural questions remain.

--------------------------------------------------------------------------------

## Detailed Implementation Plan

### Target Files to Create/Modify

#### 1. `apps/server/src/db/schema.sql` (Modify)
* **Scope**: Database schema definition.
* **Proposed Changes**: Append `decision_logs` DDL with foreign key `trade_id REFERENCES trades(id) ON DELETE SET NULL` and composite index `idx_decision_logs_sym_ts`.

#### 2. `apps/server/src/db/sqlite.ts` (Modify)
* **Scope**: SQLite repository implementation.
* **Proposed Changes**: Implement `DecisionLogsRepo` class with synchronous methods:
  - `insert(record: DecisionLogRecord): void`
  - `getOpenShadowSetups(symbol?: string): DecisionLogRecord[]`
  - `hasOpenShadowSetup(symbol: string, side: TradeSide): boolean`
  - `updateShadowOutcome(id: string, status: ShadowSetupStatus, pnlUsd: number, closedAt: number): void`
  - `listSessionDecisions(sinceMs: number): DecisionLogRecord[]`
  - `pruneOldRecords(retentionDays?: number): number`

#### 3. `packages/shared/src/contracts.ts` (Modify)
* **Scope**: Shared TypeScript contract types.
* **Proposed Changes**: Export `DecisionLogRecord`, `ShadowSetupStatus`, `DecisionAction`, `DailyAuditSummary`, and `DailyAuditResponse`.

#### 4. `apps/server/src/exchange/binanceClient.ts` (Modify)
* **Scope**: Binance REST API client.
* **Proposed Changes**: Update `getKlines(symbol, interval, limit, startTime?, endTime?)` to pass optional `startTime` and `endTime` query parameters for bounded downtime recovery.

#### 5. `apps/server/src/services/decisionAuditService.ts` (Create)
* **Scope**: Core audit and shadow tracking service.
* **Proposed Changes**: Implement `DecisionAuditService` with:
  - `evaluateSnapshot(snapshot: ConfluenceSnapshot, atr: number, markPrice: number): void` (evaluates hysteresis latch, creates `BLOCKED` log and `OPEN` shadow setup)
  - `recordExecution(params: { symbol: string; side: TradeSide; action: DecisionAction; price: number; marginUsd: number; leverage: number; atr: number; tradeId?: string; errorMessage?: string }): void` (writes `EXECUTED`/`FAILED` log and resets latch)
  - `onCandleClose(symbol: string, candle: KlineCandle): void` (evaluates SL/TP for open shadow setups of that symbol where `candle.time * 1000 >= setup.timestamp`)
  - `recoverDowntimeGaps(client: BinanceClient): Promise<void>` (reconciles offline candles on server boot)
  - `generateSessionSummary(sinceMs?: number): DailyAuditResponse`
  - `formatMarkdownReport(response: DailyAuditResponse): string`

#### 6. `apps/server/src/services/autoPilotManager.ts` (Modify)
* **Scope**: Auto-Pilot execution state machine.
* **Proposed Changes**: Add `onOrderDispatched?: (event: ...)` callback to `AutoPilotManagerOptions`. Call this callback on successful position open (`EXECUTED`) and on entry order rejection (`FAILED`).

#### 7. `apps/server/src/api/routes.ts` (Modify)
* **Scope**: Centralized REST API routing.
* **Proposed Changes**: Add `decisionAuditService?: DecisionAuditService` to `AppContext`. Register `GET /api/audit/daily` endpoint protected by `requireSessionToken(SESSION_TOKEN)`, resolving session start timestamp from `risk_state` or `?since=`, returning JSON or streaming Markdown when `?format=markdown`.

#### 8. `apps/server/src/index.ts` (Modify)
* **Scope**: Server bootstrap and lifecycle wiring.
* **Proposed Changes**:
  - Instantiate `DecisionAuditService` with `db` and `decisionLogsRepo`.
  - Pass `onOrderDispatched` callback to `AutoPilotManager`.
  - Wire `decisionAuditService.evaluateSnapshot` to throttled tick loop (4Hz).
  - Wire `decisionAuditService.onCandleClose(event.symbol, event.candle)` to `streamsManager.onKline` when `event.interval === '1m' && event.isFinal`.
  - Pass `decisionAuditService` into `AppContext` for `registerRoutes`.
  - Trigger `decisionAuditService.recoverDowntimeGaps(client)` asynchronously after boot.

#### 9. `apps/web/src/lib/apiClient.ts` (Modify)
* **Scope**: Frontend HTTP API client.
* **Proposed Changes**: Add `downloadDailyAudit(format?: 'json' | 'markdown', session?: string): Promise<void>` using authenticated `fetch` with `getSessionToken()` and DOM blob download trigger.

#### 10. `apps/web/src/components/TopBar.tsx` (Modify)
* **Scope**: Cockpit HUD top header toolbar.
* **Proposed Changes**: Add Daily Audit export button (`FileText` icon) next to Scanner / Sim buttons, triggering `apiClient.downloadDailyAudit('markdown', 'current')`.

#### 11. `apps/server/src/services/__tests__/decisionAuditService.test.ts` (Create)
* **Scope**: Comprehensive unit test suite.
* **Proposed Changes**: Test:
  - Rising-edge hysteresis latch arming and cooldown suppression.
  - Latch reset on production order execution.
  - Long (`BUY`) shadow setup SL trigger -> `SAVED_CAPITAL` (entry 100, ATR 1.0, 10x leverage, margin $100 -> SL 98.5 triggers, net PnL -$16.50).
  - Long (`BUY`) shadow setup TP trigger -> `MISSED_PROFIT` (TP 101.5 triggers, net PnL +$13.50 after $1.50 friction).
  - Short (`SELL`) shadow setup SL trigger -> `SAVED_CAPITAL` (entry 100, ATR 1.0 -> SL 101.5 triggers).
  - Short (`SELL`) shadow setup TP trigger -> `MISSED_PROFIT` (TP 98.5 triggers).
  - Scratch trade fee haircut: TP touched but Net PnL <= 0 -> `SAVED_CAPITAL`.
  - Intra-bar dual-wick trigger -> `RESOLVED_AMBIGUOUS_VOLATILITY` ($0.00 PnL).
  - Expiration after 60 minutes -> `EXPIRED` with mark-to-market close.
  - Entry-candle boundary: candles with `candle.time * 1000 < setup.timestamp` are strictly ignored.
  - Multi-symbol isolation: BTC candle does not trigger SOL shadow setups.
  - Summary aggregation math: `capital_saved_usd`, `missed_profit_usd`, `net_risk_value_usd`.

### Verification Plan

* **Compilation/Build**: `npm run build` across monorepo packages (`@tradeos/shared`, `@tradeos/server`, `@tradeos/web`).
* **Unit Tests**: `npx vitest run apps/server/src/services/__tests__/decisionAuditService.test.ts` with 100% test pass rate.
* **Full Test Suite**: `npx vitest run` ensuring all 24 test suites and 300+ tests pass.
* **API Verification**: Execute `curl http://127.0.0.1:3400/api/audit/daily?session=current` returning HTTP 200 with JSON summary.

--------------------------------------------------------------------------------

*Drafted with EGM*
