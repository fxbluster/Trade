# Stage 7 Critic Review Report: FeatureRange (Lines 1..191)

* **Target:** `design_draft.md` (lines 1–191)
* **Date:** 2026-11-21
* **Reviewers:** `egm-design` (Hostile Critic), `egm-structural` (Document Architect), `egm-style` (Copy Editor)

---

## Executive Summary

All three reviewers independently identified critical mathematical errors, inverted Sell-side valuation logic, architectural coupling traps, and missing template sections. 

---

## 🔴 Blockers (Must Be Fixed Before Advancing)

### 1. Mathematical Leverage Squaring & Missing Valuation Columns
* **Findings (`egm-design`, `egm-style`):** Line 159 calculates $\text{Net PnL USD} = \text{Net PnL Pct} \times \text{Notional Value} \times \text{Leverage}$. In crypto futures, $\text{Notional Value} = \text{Margin} \times \text{Leverage}$, squaring leverage ($L^2$) and causing a 1,000% PnL inflation on 10x leverage. Furthermore, the `decision_logs` DDL lacks `margin_usd` and `leverage` columns, making USD valuation non-deterministic when setups resolve later.
* **Remediation:**
  - Correct formula: $\text{Net PnL USD} = \text{Net PnL Pct} \times (\text{Simulated Margin USD} \times \text{Leverage})$.
  - Add `margin_usd REAL NOT NULL` and `leverage INTEGER NOT NULL` to `decision_logs` (capturing active AutoPilot config at decision time).

### 2. Inverted and Missing Short/Sell Counterfactual Valuation Formula
* **Findings (`egm-design`, `egm-structural`):** The specification defines valuation logic exclusively for Long setups. For a Short trade (`side = 'SELL'`), Stop Loss is above entry and Take Profit is below entry. Applying `low <= shadow_sl` falsely classifies profitable down-moves as Stop Loss hits.
* **Remediation:**
  - For `SELL`: $\text{Gross PnL Pct} = \frac{\text{Entry Price} - \text{Exit Price}}{\text{Entry Price}}$.
  - SL triggers when $\text{high} \ge \text{shadow\_sl} \implies \text{SAVED\_CAPITAL}$.
  - TP triggers when $\text{low} \le \text{shadow\_tp}$ (with net gain > 0.15%) $\implies \text{MISSED\_PROFIT}$.
  - Dual-wick conflict: if both are touched in the same candle and 1m sequence cannot be resolved, classify as `RESOLVED_AMBIGUOUS_VOLATILITY` ($\text{PnL} = \$0.0$).

### 3. Execution Throttling via Shared Hysteresis Latch & Missing Rejection State
* **Findings (`egm-design`):** Architecture routes real AutoPilot orders through the pre-trade hysteresis latch (`SymbolCooldownElapsed`). A vetoed setup locks the 180s cooldown, which would suppress subsequent genuine order execution logs. Additionally, the schema lacks a state for exchange-rejected orders.
* **Remediation:**
  - Real AutoPilot execution events must bypass the hysteresis latch and write directly to `decision_logs` (`action = 'EXECUTED'`).
  - Add `FAILED` to the action enum (`'EXECUTED' | 'BLOCKED' | 'FAILED' | 'MANUAL'`) with an optional `error_message TEXT` column.

### 4. Missing Mandatory Section: "Risks & Limits" (Template Non-Compliance)
* **Findings (`egm-structural`):** `feature-spec-standard` mandates a dedicated `## Risks & Limits` / `## Risks & Mitigations` section detailing constraints, failure modes, and security implications. This section is completely missing.
* **Remediation:** Add `## Risks & Limits` covering event loop blocking mitigations, SQLite write contention, and offline downtime candle reconciliation.

### 5. Backend Calculation Rate Contradiction (60fps vs. 4Hz)
* **Findings (`egm-style`):** Line 13 asserts TradeOS evaluates confluence at "60fps" (a frontend rendering rate), directly contradicting Lines 70, 177, and 186 which specify "4Hz / 250ms interval".
* **Remediation:** Standardize on factual backend terminology: *"evaluates 7-pillar confluence at 4Hz (250ms interval)"*.

---

## 🟡 Majors (Architecture & Precision)

### 1. State Machine Terminology Drift
* **Findings (`egm-style`, `egm-structural`):** Inconsistent naming across prose, CUJs, and DDL (`SAVED_CAPITAL` vs `RESOLVED_SAVED_CAPITAL` vs `'OPEN' | 'SAVED_CAPITAL' | 'MISSED_PROFIT' | 'EXPIRED'`).
* **Remediation:** Unify all references to match the authoritative DDL: `'OPEN' | 'SAVED_CAPITAL' | 'MISSED_PROFIT' | 'EXPIRED' | 'AMBIGUOUS_VOLATILITY'`.

### 2. Zombie Shadow Accumulation & Missing Expiration Engine
* **Findings (`egm-design`, `egm-structural`):** The schema lacks `expires_at` or `max_candles`, allowing consolidating setups to stay `OPEN` indefinitely.
* **Remediation:** Add `expires_at INTEGER NOT NULL` ($T_0 + 3600\text{s}$) and enforce automatic expiration in `onCandleClose()`.

### 3. Downtime & Server Restart Gap Reconciliation
* **Findings (`egm-design`):** Setups hitting SL/TP during server restart or downtime remain open without historical candle backfill.
* **Remediation:** Add a startup reconciliation step that queries Binance REST `/fapi/v1/klines` for closed candles between `created_at` and boot time.

### 4. Alignment with Production AutoPilot Parameters
* **Findings (`egm-design`):** The draft specifies 1.0 ATR SL and 1.5 ATR TP, while production AutoPilot (`autoPilotManager.ts:307`) uses 1.5 ATR SL and 1.5 ATR TP1. Hardcoding 1.0 ATR introduces artificial stop-outs.
* **Remediation:** Align shadow SL with production AutoPilot (1.5 ATR SL, 1.5 ATR TP1).

### 5. Multi-Session Overnight Reporting Support
* **Findings (`egm-design`):** `GET /api/audit/daily` splitting at 00:00 UTC truncates overnight sessions.
* **Remediation:** Support `?session=current` or `?since=<ms>` query parameters in `GET /api/audit/daily`.

---

## 🟢 Nits

1. **Section Heading Cleanup:** Retitle `## Open Questions` (where all items are marked `(Resolved)`) to `## Resolved Architectural Decisions`.
2. **Promotional Wording:** Strip "Zero-GC", "institutional confluence", and "1-click button" hyperbole.
3. **Markdown Linting:** Fix trailing double-space line breaks in valuation formulas and add language identifiers (`text`) to ASCII fences.
4. **Composite Index:** Add `idx_decision_logs_sym_ts` on `(symbol, timestamp)` for fast daily queries.
