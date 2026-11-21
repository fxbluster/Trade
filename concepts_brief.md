# TradeOS Decision Audit Trail & Counterfactual Shadow Tracking Engine

* **Author:** fxbluster
* **Date:** 2026-11-21

## Overview

TradeOS runs continuous 60fps institutional confluence evaluation and autonomous Auto-Pilot execution. However, during 4-8 hour live trading sessions, operators currently have no persistent visibility into why specific trades fired, why marginal setups were vetoed, or whether vetoed setups would have succeeded or failed.

This feature introduces the **TradeOS Decision Audit Trail & Counterfactual Shadow Tracking Engine**:
1. **Deterministic Decision Event Logging**: Captures structured snapshots into a dedicated SQLite `decision_logs` table whenever a setup crosses the 60% composite score threshold or Auto-Pilot executes an order. Records timestamp, symbol, side, composite score, 7-pillar breakdown, active macro regime, exact veto rationale (Macro Veto, Cooldown, Consensus Threshold, Dead-SL armor), and execution outcome.
2. **Crash-Resilient Counterfactual Shadow Tracking**: When a high-conviction setup (>= 60% score) is vetoed or blocked, the engine instantiates a passive shadow setup record with virtual entry, 1.0 ATR stop-loss, 1.5 ATR take-profit, and a mandatory 0.15% fee/slippage friction haircut. Outcomes are evaluated lazily against subsequent closed 1m/5m candle highs and lows (zero background timers, zero memory leaks, persists across restarts). Each blocked setup is deterministically classified as `SAVED_CAPITAL` (veto prevented a loss), `MISSED_PROFIT` (veto blocked a net profitable runner), or `EXPIRED_NEUTRAL`.
3. **Daily Session Audit & 1-Click Export**: Generates structured Markdown and JSON reports at `data/reports/audit-YYYY-MM-DD.md` and exposes a secure `GET /api/audit/daily` endpoint. Operators can click a single button in the Cockpit HUD at the end of the day to download the report or paste it into AI chat for deep forensic performance reviews.

## Analysis

### 1. Rising-Edge Hysteresis Latch (Controlling Write Volume)
In choppy or consolidating markets, composite scores oscillate across the 60% threshold multiple times per second. Logging every tick above 60% would trigger an I/O storm of 10,000+ records per hour, degrading SQLite performance.
- **Solution:** A rising-edge hysteresis detector. Logging triggers **only** when the composite score transitions from below 50% to >= 60% (a 10% deadband). Once triggered, a 3-minute cooldown is latched per symbol. This caps logging volume to genuine trade setups (~10 to 30 events per session) without missing legitimate market opportunities.

### 2. Passive Snapshot vs. Active In-Memory Threads (Zero Leak, Crash Proof)
Maintaining active 60-minute in-memory JavaScript timers (`setTimeout`) across dozens of symbols causes memory bloat and total state loss whenever the server restarts or the PC sleeps.
- **Solution:** Shadow setups are persisted immediately to SQLite in an `OPEN` state. On every closed candle event (or upon query), pending shadow setups are evaluated against candle `high` and `low`. This eliminates timers entirely, guarantees zero memory leaks, and allows instant recovery across server restarts.

### 3. Execution Friction Haircut (Eliminating Hindsight Bias)
A theoretical price tap of 1.5 ATR does not guarantee real profit due to 10x leverage taker fees (0.10% round-trip) and bid-ask spread slippage (0.05%).
- **Solution:** The counterfactual evaluator applies a synthetic 0.15% notional friction haircut. A setup is only classified as `MISSED_PROFIT` if gross price movement cleared the 1.5 ATR target plus friction costs.

### 4. Intra-Bar Conflict Resolution (Conservative Valuation)
If an individual candle's wick spans both the virtual SL and TP levels, it is impossible to determine tick sequence from kline data alone.
- **Solution:** Worst-case principle. In case of ambiguous simultaneous reach within the same candle, the engine assumes the Stop Loss was hit first (`SAVED_CAPITAL`). This prevents falsely accusing risk filters of missing profits.

### 5. Architectural Synergy with Existing SQLite Infrastructure
`apps/server/src/db/sqlite.ts` already implements `DatabaseSync` via `node:sqlite` with `WAL` journal mode and `5000ms` busy timeout. Adding a `decision_logs` table requires zero external dependencies, maintains sub-millisecond write latency, and integrates seamlessly into the existing repository pattern.

## Goals vs. Non-Goals

* **In-Scope Goals:**
  * Add `decision_logs` table and `DecisionLogsRepo` to `apps/server/src/db/schema.sql` and `sqlite.ts`.
  * Implement `DecisionAuditService` in `apps/server/src/services/decisionAuditService.ts` with rising-edge hysteresis and 3m cooldown latching.
  * Implement lazy counterfactual evaluation against closed klines with 0.15% friction haircut.
  * Expose authenticated `GET /api/audit/daily` endpoint returning both JSON statistics and formatted Markdown.
  * Auto-generate `data/reports/audit-YYYY-MM-DD.md` on daily rollover or on-demand trigger.
  * Add a 1-click `Daily Audit [📥]` button in the Cockpit HUD header next to Scanner and Sim buttons.

* **Out-of-Scope Non-Goals:**
  * High-frequency tick-by-tick raw data logging (CVD ticks and order book depth remain in their respective circular ring buffers).
  * Automated dynamic parameter tuning or machine learning weight adjustments based on audit logs (audit is strictly for human and LLM review).
  * External third-party database dependencies (PostgreSQL, Redis, ClickHouse).

## Alternatives Weighed

1. **Active In-Memory Shadow Timers (`setTimeout` / `setInterval`):**
   * *Rejected:* In-memory timers leak memory if unresolved, spike CPU on tick bursts, and lose all state if the supervisor restarts the server. Passive candle-close evaluation is strictly superior.
2. **Flat JSON Lines (`.jsonl`) Append-Only Log:**
   * *Rejected:* While simple, flat files lack ACID transaction guarantees and indexing, leading to file-lock contention and race conditions when the web server reads daily statistics while new decisions are being appended.
3. **External Timeseries Database (TimescaleDB / InfluxDB):**
   * *Rejected:* Violates the project's zero-external-dependency requirement and adds operational deployment friction for local single-user execution.
4. **Logging Every 250ms Calculation Cycle:**
   * *Rejected:* Floods disk with repetitive identical evaluations when price is stationary. Rising-edge latching preserves signal-to-noise ratio.

## Key Decisions & Staging for Next Steps

* **Decision 1: Storage Layer:** Use `node:sqlite` in `apps/server/src/db/sqlite.ts` with dedicated `decision_logs` table and indexed `created_at` / `symbol` / `action` columns.
* **Decision 2: Latching Parameters:** Trigger threshold = 60%, Reset threshold = 50%, Cooldown = 180 seconds per symbol.
* **Decision 3: Counterfactual Horizon:** 60 minutes or maximum 12 closed 5m bars. Stop Loss = 1.0 ATR, Take Profit = 1.5 ATR, Friction Haircut = 0.15%.
* **Decision 4: Staging:**
  * Step A: Update `schema.sql` & `sqlite.ts` with `decision_logs` table and repository methods.
  * Step B: Create `decisionAuditService.ts` wired to `confluenceEngine` evaluations and `autoPilotManager` order triggers.
  * Step C: Add REST endpoint `GET /api/audit/daily` in `apps/server/src/index.ts`.
  * Step D: Add `Daily Audit [📥]` export button in `apps/web/src/components/Header.tsx`.
