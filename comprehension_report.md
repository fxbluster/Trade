# Stage 6 Comprehension Test Report

* **Target:** `design_draft.md` (lines 1–233)
* **Date:** 2026-11-21
* **Reviewer:** `egm-comprehension` (Naive Reader)

---

### What this proposes
The document proposes an audit trail and counterfactual shadow tracking engine for TradeOS that records trade decisions into a local SQLite table (`decision_logs`) whenever composite confluence scores cross 60% or Auto-Pilot executes. For setups blocked by risk vetoes, the system instantiates passive virtual shadow trades with 1.0 ATR stop-loss and 1.5 ATR take-profit thresholds adjusted for a 0.15% fee/slippage haircut. These shadow positions are lazily evaluated against subsequent closed candles to determine whether the veto preserved capital or missed profit, and the results can be exported as daily Markdown and JSON reports via a REST endpoint or a 1-click Cockpit HUD button.

### How the existing system works, per this document
TradeOS evaluates market confluence in real time during 4-to-8-hour live trading sessions and autonomously executes trades via an Auto-Pilot feature when consensus criteria are met. Confluence scores and veto matrix layers are computed purely in-memory in a single-threaded Node.js event loop backed by an existing SQLite instance configured with WAL mode. Because decision reasoning and 7-pillar confluence breakdowns currently scroll past in terminal logs without structured persistence, all decision contexts and veto rationales are permanently lost when a session ends or the server restarts.

---

### Audit Findings

#### 🔴 Blocker

1. **Severity**: Blocker  
   **Affected Scope**: Section 3 (Lines 154–164) & Section 1 (Lines 111–132)  
   **Discrepancy Description & Rationale**: Missing Short Valuation Formula & Missing Schema Valuation Inputs.  
   - The document specifies that trades can be `BUY` or `SELL`, but Section 3 only provides valuation logic for Longs. The inverse formulas for Short setups (Gross PnL = $(Entry - Exit) / Entry$, SL triggering when $high \ge shadow\_sl$, and TP triggering when $low \le shadow\_tp$) are completely omitted.  
   - Furthermore, the formula calculates USD impact as $\text{Net PnL USD} = \text{Net PnL Pct} \times \text{Notional Value} \times \text{Leverage}$. However, neither `notional_value` nor `leverage` exist as columns in the `decision_logs` schema, nor are they defined as global constants. When closed candles arrive later, `DecisionLogsRepo.updateShadowOutcome()` cannot compute `shadow_pnl_usd` without these missing values.  
   - Lastly, the formula fails to define how `EXPIRED` status is evaluated: if neither SL nor TP is hit within the observation window, is PnL marked to market at the close of the final candle or set to $0?

2. **Severity**: Blocker  
   **Affected Scope**: Lines 17, 59–60, 126, and 206  
   **Discrepancy Description & Rationale**: Contradictory Shadow Status State Machine Enums Across Sections.  
   The document introduces four different, mutually conflicting naming conventions for the shadow status lifecycle:  
   - Overview (Line 17): `SAVED_CAPITAL`, `MISSED_PROFIT`, `EXPIRED_NEUTRAL`.  
   - CUJ 2 (Lines 59–60): `RESOLVED_SAVED_CAPITAL`, `RESOLVED_MISSED_PROFIT`.  
   - Database Schema DDL (Line 126): `'NONE' | 'OPEN' | 'SAVED_CAPITAL' | 'MISSED_PROFIT' | 'EXPIRED'`.  
   - Contracts scope (Line 206): `ShadowSetupStatus`.  
   This inconsistency will break type safety and database constraint validation across packages.

---

#### 🟡 Major

3. **Severity**: Major  
   **Affected Scope**: Line 13 vs. Line 70 & Line 186  
   **Discrepancy Description & Rationale**: Execution Frequency Contradiction (60fps vs. 4Hz).  
   Line 13 states that "TradeOS evaluates institutional confluence at 60fps" (~16.6ms / 60Hz), whereas the Architecture diagram specifies "Binance WebSocket Tick / Analysis (4Hz)" and Non-Functional Requirements mandate throttled tick cycles of "<= 4Hz" (250ms). A 15x discrepancy in core loop execution rate creates confusion over whether calculations run at frame rate or throttled tick intervals.

4. **Severity**: Major  
   **Affected Scope**: Lines 17, 58, 100, and 210  
   **Discrepancy Description & Rationale**: Candle Timeframe Ambiguity and Missing Expiration Mechanics.  
   Line 17 states that shadow outcomes are evaluated against "subsequent closed 1m/5m klines", while CUJ 2 specifies "Over the next 12 closed 5m candles". Line 210 proposes an `onCandleClose(kline)` handler without defining which candle timeframe triggers evaluation. Furthermore, the 12-candle TTL mentioned in CUJ 2 is never specified as an architectural rule or parameter in Section 2.

5. **Severity**: Major  
   **Affected Scope**: Lines 22–23, Line 51, and Line 119  
   **Discrepancy Description & Rationale**: Undefined Project-Specific Terminology and Incomplete Pillar Specifications.  
   - Only 4 of the 7 pillars are mentioned in CUJ 1 (`macroRegime`, `smc`, `cvd`, `orderFlow`). The remaining 3 pillars are never identified, leaving `pillars_json` undefined.  
   - "Dead-SL Armor" is listed as a risk filter alongside Macro Veto and Cooldown, but never defined or explained.  
   - Acronyms such as "SMC FVG" (Smart Money Concepts Fair Value Gap) and "CVD" (Cumulative Volume Delta) are introduced without definition.

6. **Severity**: Major  
   **Affected Scope**: Lines 18, 64–65, 202, 214, and 229  
   **Discrepancy Description & Rationale**: Conflicting Contract and Responsibilities for `GET /api/audit/daily`.  
   The document is inconsistent about whether `GET /api/audit/daily` returns JSON or downloads Markdown: Verification Plan tests HTTP 200 with a "JSON summary", CUJ 3 states clicking `Daily Audit [📥]` downloads `audit-2026-11-21.md`, and Line 18 states the engine generates Markdown and JSON reports at `data/reports/audit-YYYY-MM-DD.md`.

7. **Severity**: Major  
   **Affected Scope**: Line 187 vs. Lines 194–222  
   **Discrepancy Description & Rationale**: Missing Retention Pruning Implementation in Detailed Plan.  
   Line 187 requires that "Automatic retention pruning retains raw logs for 14 days", but the Detailed Implementation Plan lists no methods, queries, or scheduled lifecycle tasks for deleting records older than 14 days.

---

#### 🟢 Nit

8. **Severity**: Nit (Line 30): Unsubstantiated "Zero-GC" assertion for standard TypeScript object interfaces (`LatchState`).
9. **Severity**: Nit (Line 117): Undefined `'MANUAL'` action state in schema when document only covers Auto-Pilot automated setups.
10. **Severity**: Nit (Line 124): Unspecified ATR period (14) and timeframe for sampling `atr REAL`.
11. **Severity**: Nit (Line 18): Vague "secure endpoint" description without specifying authentication mechanism.
