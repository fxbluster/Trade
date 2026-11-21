# Stage 5 Zoom Out & Inventive Catalyst Review Report

* **Target:** `design_draft.md` (lines 1–233)
* **Date:** 2026-11-21
* **Reviewers:** `egm-zoom-out` (Skeptical Architect) & `egm-inventive-catalyst` (TRIZ Specialist)

---

## Executive Summary

Both reviewers concur that while the core objective—post-session auditability and counterfactual risk filter verification—is essential, the initial design draft contains critical architectural compromises, state machine leaks, and mathematical errors that must be resolved before proceeding to code.

---

## 🔴 Blockers (Must Be Fixed Before Implementation)

### 1. Mathematical Leverage Squaring & Sizing Undefined
* **Finding:** Line 159 defines $\text{Net PnL USD} = \text{Net PnL Pct} \times \text{Notional Value} \times \text{Leverage}$. In perpetual futures, $\text{Notional Value} = \text{Margin} \times \text{Leverage}$. Multiplying by leverage again squares leverage ($L^2$), inflating simulated PnL by $10\times$. Furthermore, a blocked order has no executed margin, making USD PnL calculation at candle close non-deterministic unless simulated margin allocation is stored at decision time.
* **Fix:** Correct the formula:
  $$\text{Position Size} = \frac{\text{Simulated Margin USD} \times \text{Leverage}}{\text{Entry Price}}$$
  $$\text{Gross PnL USD} = \text{Direction} \times (\text{Exit Price} - \text{Entry Price}) \times \text{Position Size}$$
  $$\text{Net PnL USD} = \text{Gross PnL USD} - (\text{Simulated Notional} \times 0.0015)$$
  Record `simulated_margin_usd` and `simulated_leverage` directly in the decision snapshot.

### 2. Standalone Hysteresis Latch Generates Phantom Audits
* **Finding:** The standalone latch runs on raw `confluenceEngine` scores outside `AutoPilotManager`. It logs "BLOCKED" decisions and spawns shadow trades even when Auto-Pilot is disarmed, when the 180s re-entry lockout is active, during circuit-breaker cooldown, or when a real position is already open on that symbol.
* **Fix:** Eliminate the decoupled latch. Wire audit events directly into `AutoPilotManager.onTick()` where real execution and veto gating actually happen.

### 3. Mutating Lifecycle State Inside an Append-Only Audit Trail
* **Finding:** `decision_logs` conflates an immutable audit event with a mutable paper trading simulation (`shadow_status`, `shadow_sl`, `shadow_tp`, `shadow_pnl_usd`). Mutating audit records across candles violates audit trail immutability.
* **Fix:** Separate concerns into two clean tables:
  1. `decision_logs`: Immutable, append-only decision snapshot.
  2. `shadow_setups`: Lightweight virtual position state with explicit `expires_at` (max 60 minutes) and `status`.

### 4. Missing Expiration Mechanics & Unbounded Shadow State Leak
* **Finding:** The draft specifies evaluating setups over 12 candles, but includes no `expires_at` or `candles_elapsed` columns in SQLite. If market price drifts without touching SL or TP, shadow records remain permanently `OPEN`.
* **Fix:** Add `expires_at INTEGER NOT NULL` (e.g., $T_0 + 3600\text{s}$) to `shadow_setups`. In candle close sweeps, any `OPEN` setup where `candle.time >= expires_at` is deterministically resolved to `EXPIRED_NEUTRAL`.

---

## 🟡 Majors (Architectural Alignment & Reliability)

### 1. Dual-Wick Confirmation Bias in Intra-Bar Touches
* **Finding:** Automatically classifying bars touching both SL and TP as `SAVED_CAPITAL` creates survivorship bias in favor of risk filters. On sudden expansion spikes, TP is often reached within seconds before retracing.
* **Fix:** If sub-candle 1m kline sequence cannot be verified from the local ring buffer, classify as `RESOLVED_AMBIGUOUS_VOLATILITY` with `shadow_pnl_usd = 0.0` rather than artificially claiming saved capital.

### 2. Main-Thread SQLite Event Loop Latency
* **Finding:** `DatabaseSync` executes synchronously on the Node.js event loop. If disk I/O stalls or WAL checkpoints run, a 5-second `busy_timeout` can freeze WebSocket processing and live stop-loss execution.
* **Fix:** Decouple writes via an in-memory write buffer queue flushed asynchronously via `setImmediate` or a 1-second unref interval.

### 3. Redundant Server Disk File Accumulation
* **Finding:** Writing physical `.md` files to `data/reports/` creates disk clutter without retention cleanup.
* **Fix:** Generate and stream the Markdown/JSON report dynamically in-memory on demand via `GET /api/audit/daily`.

### 4. Codebase Path Mismatches
* **Finding:** The draft targets non-existent `apps/web/src/components/Header.tsx` (the real file is `TopBar.tsx`) and assumes a 5m kline stream in `index.ts` (the active pipeline routes `1m`, `15m`, and `1h`).
* **Fix:** Correct the target component to `TopBar.tsx` (or `TradeJournalPanel.tsx`) and evaluate shadow setups on closed `1m` candles (max 60 bars) or `15m` structural bars.

---

## 🟢 Nits

1. **Formula Prolixity:** Remove unnecessary LaTeX derivations for basic percentage math and prioritize clean contract definitions.
2. **Denormalized Redundancy:** Store the complete evaluation object in `pillars_json` and `veto_reasons_json` rather than fragmenting duplicate scalar columns.

---

## Remediation Roadmap for `design_draft.md`
1. Re-anchor audit triggers inside `AutoPilotManager`.
2. Split schema into immutable `decision_logs` and stateful `shadow_setups` (with TTL).
3. Correct futures PnL formula and add simulated margin baseline.
4. Replace server-side physical file writes with dynamic HTTP stream generation.
5. Update target UI component to `TopBar.tsx` and evaluate on `1m` closed klines.
