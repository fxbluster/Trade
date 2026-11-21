# Goldfish Annotated Review Report

**Target:** `C:\Users\HP\TradeOS-v2\design_draft.md` (`FeatureRange: lines 1..191`)  
**Status:** In Review

---

## Prioritized Findings & AI Suggestions

### 1. Double-Leverage Math Error & Missing Valuation Columns [`egm-design`] - Severity: Blocker
* **Affected Scope:** Lines 111–132, 154–164 (`### 3. Friction-Adjusted Counterfactual Valuation Formula`)
* **Discrepancy Description:** Line 159 calculates Net PnL USD by multiplying Notional Value by Leverage. Since Notional is already Margin * Leverage, leverage is multiplied twice ($L^2$), causing a 1,000% PnL inflation on 10x positions. Also, `decision_logs` lacks `margin_usd` and `leverage` columns.
* **Rationale:** A blocked setup has no filled trade record. Without recording simulated margin allocation and leverage at decision time, dollar PnL cannot be calculated deterministically when the setup resolves.
* ***AI Suggestion:*** PROPOSE FIX
* ***Justification:** The critique is mathematically accurate. Leverage must only be applied once, and simulated allocation must be recorded at decision time.
* ***Proposed Edit:***
  * Location: Schema DDL and Valuation section.
  * Change: Add `margin_usd REAL NOT NULL` and `leverage INTEGER NOT NULL` to `decision_logs`. Replace formula with:
    $$\text{Position Size} = \frac{\text{Margin USD} \times \text{Leverage}}{\text{Entry Price}}$$
    $$\text{Gross PnL USD} = \text{Direction} \times (\text{Exit Price} - \text{Entry Price}) \times \text{Position Size}$$
    $$\text{Net PnL USD} = \text{Gross PnL USD} - (\text{Notional Value} \times 0.0015)$$

---

### 2. Inverted and Missing Short/Sell Valuation Logic [`egm-design`, `egm-structural`] - Severity: Blocker
* **Affected Scope:** Lines 154–164 (`### 3. Friction-Adjusted Counterfactual Valuation Formula`)
* **Discrepancy Description:** Formula logic is only specified for Long setups. For a Short trade, Stop Loss is above entry and Take Profit is below entry. Applying `low <= shadow_sl` falsely classifies profitable downward moves as SL hits.
* **Rationale:** A quantitative trading engine must possess complete, symmetric bidirectional state machine specifications.
* ***AI Suggestion:*** PROPOSE FIX
* ***Justification:** Valid and essential. Complete formulas for `SELL` must be explicitly specified.
* ***Proposed Edit:***
  * Location: Section 3.
  * Change: Add complete rules for `SELL` side:
    - Gross PnL Pct = $(Entry - Exit) / Entry$
    - SL triggers when $high \ge shadow\_sl \implies \text{SAVED\_CAPITAL}$
    - TP triggers when $low \le shadow\_tp$ (net gain > 0.15%) $\implies \text{MISSED\_PROFIT}$
    - Intra-bar dual touch: If both triggers occur on the same candle, classify as `RESOLVED_AMBIGUOUS_VOLATILITY` with PnL = $0.00.

---

### 3. Execution Throttling via Shared Hysteresis Latch [`egm-design`] - Severity: Blocker
* **Affected Scope:** Lines 78–107 (Architecture Pipeline)
* **Discrepancy Description:** Real AutoPilot order executions are routed through the pre-trade hysteresis latch. If a setup is vetoed and triggers a 180s cooldown, subsequent genuine order executions within that window are suppressed from the audit log. Also, the action enum lacks a `FAILED` state for exchange-rejected orders.
* **Rationale:** Real execution logs must never be rate-limited by pre-trade veto filters.
* ***AI Suggestion:*** PROPOSE FIX
* ***Justification:** Completely valid. Execution events must bypass the pre-trade rate limiter.
* ***Proposed Edit:***
  * Location: Pipeline architecture and schema DDL.
  * Change: AutoPilot live execution writes directly to `decision_logs` (`action = 'EXECUTED'`). Update action enum to `'EXECUTED' | 'BLOCKED' | 'FAILED' | 'MANUAL'` with optional `error_message TEXT`.

---

### 4. Missing Mandatory "Risks & Limits" Section [`egm-structural`] - Severity: Blocker
* **Affected Scope:** Structural layout between lines 183 and 184
* **Discrepancy Description:** `feature-spec-standard` requires an explicit `## Risks & Limits` section detailing constraints, failure modes, and security mitigations.
* **Rationale:** Missing top-level standard section.
* ***AI Suggestion:*** PROPOSE FIX
* ***Justification:** Required by standard.
* ***Proposed Edit:***
  * Location: Insert `## Risks & Limits` before Non-Functional Requirements.
  * Change: Add subsections covering Main-Thread SQLite Concurrency, Downtime Candle Gap Reconciliation, and API Rate Limiting.

---

### 5. Backend Calculation Rate Contradiction (60fps vs. 4Hz) [`egm-style`] - Severity: Blocker
* **Affected Scope:** Lines 13, 70, 177, 186
* **Discrepancy Description:** Line 13 asserts "60fps" for backend confluence evaluation, contradicting Lines 70 and 186 which state 4Hz (250ms).
* **Rationale:** 60fps is a client rendering frame rate, not a server sampling rate.
* ***AI Suggestion:*** PROPOSE FIX
* ***Justification:** Correct technical calibration.
* ***Proposed Edit:***
  * Location: Line 13.
  * Change: Replace "at 60fps" with "at 4Hz (250ms interval)".

---

### 6. State Machine Enum Terminology Drift [`egm-style`, `egm-structural`] - Severity: Major
* **Affected Scope:** Lines 17, 59–60, 106, 126
* **Discrepancy Description:** 4 conflicting names for shadow statuses (`SAVED_CAPITAL` vs `RESOLVED_SAVED_CAPITAL` vs `'OPEN' | 'SAVED_CAPITAL' | 'MISSED_PROFIT' | 'EXPIRED'`).
* **Rationale:** Type safety breaks without a unified authoritative enum.
* ***AI Suggestion:*** PROPOSE FIX
* ***Justification:** Clean standardization.
* ***Proposed Edit:***
  * Location: All status occurrences.
  * Change: Unify to `'OPEN' | 'SAVED_CAPITAL' | 'MISSED_PROFIT' | 'EXPIRED' | 'RESOLVED_AMBIGUOUS_VOLATILITY'`.

---

### 7. Zombie Shadow Accumulation & Missing Expiration Mechanics [`egm-design`] - Severity: Major
* **Affected Scope:** Lines 17, 31, 58, 126
* **Discrepancy Description:** The schema contains no `expires_at` column, causing non-touching setups to remain open forever.
* **Rationale:** Active shadow setups leak memory and DB query time without an expiration horizon.
* ***AI Suggestion:*** PROPOSE FIX
* ***Justification:** Essential for lifecycle bounding.
* ***Proposed Edit:***
  * Location: Schema DDL.
  * Change: Add `expires_at INTEGER NOT NULL` ($T_0 + 3600\text{s}$) to schema and close expired records on candle close.

---

### 8. Offline Server Restart Downtime Gap Reconciliation [`egm-design`] - Severity: Major
* **Affected Scope:** Lines 31, 100–106
* **Discrepancy Description:** If the server is offline during a session, setups hitting SL/TP during downtime are never settled.
* **Rationale:** Server restarts must reconcile candle gaps via REST historical klines.
* ***AI Suggestion:*** PROPOSE FIX
* ***Justification:** Guarantees true crash resilience.
* ***Proposed Edit:***
  * Location: Architecture and Lifecycle.
  * Change: Add startup boot reconciliation querying Binance REST `/fapi/v1/klines` for closed bars during downtime.

---

### 9. Alignment with Production AutoPilot SL Parameters [`egm-design`] - Severity: Major
* **Affected Scope:** Lines 17, 58, 124
* **Discrepancy Description:** Draft specifies 1.0 ATR SL, whereas AutoPilot production uses 1.5 ATR SL.
* **Rationale:** A tighter simulated SL stops out trades that live AutoPilot would have kept alive.
* ***AI Suggestion:*** PROPOSE FIX
* ***Justification:** True counterfactual fidelity requires matching live strategy parameters.
* ***Proposed Edit:***
  * Location: Lines 17, 58.
  * Change: Set shadow SL to 1.5 ATR (matching `autoPilotManager.ts:307`).

---

### 10. Multi-Session Overnight Reporting Support [`egm-design`] - Severity: Major
* **Affected Scope:** Lines 18, 64–65
* **Discrepancy Description:** Daily calendar export truncates sessions crossing 00:00 UTC.
* **Rationale:** Trading sessions often span midnight.
* ***AI Suggestion:*** PROPOSE FIX
* ***Justification:** Practical operator UX improvement.
* ***Proposed Edit:***
  * Location: API endpoint spec.
  * Change: Add support for `?session=current` and `?since=<ms>` query parameters in `GET /api/audit/daily`.

---

### 11. Section Heading Cleanup & Markdown Formatting [`egm-structural`, `egm-style`] - Severity: Nit
* **Affected Scope:** Lines 41–47, 69, 161–162
* **Discrepancy Description:** Retitle resolved questions, add language identifier (`text`) to ASCII fence, and fix trailing spaces.
* ***AI Suggestion:*** PROPOSE FIX
* ***Proposed Edit:***
  * Location: Section headings and fences.
  * Change: Retitle to `## Resolved Architectural Decisions`, add `text` to fence, clean line breaks.
