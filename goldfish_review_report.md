# Goldfish Annotated Review Report

**Target:** `docs/designs/confluence-autopilot-pinescript.md` (Lines 1–358)
**Status:** resolved (All 21 Proposed Fixes Batch-Accepted and Applied in Round 1)

## Executive Summary
A comprehensive multi-agent audit was executed across three specialized Goldfish lenses:
1. **EGM Hostile Design Critic (`egm-design`)**: Evaluated architecture, failure modes, race conditions, and solvency limits.
2. **EGM Structural Layout Validator (`egm-structural`)**: Evaluated document blueprint compliance, section completeness, heading taxonomy, and Mermaid syntax.
3. **EGM Implementation Readiness Reviewer (`egm-implementation-readiness`)**: Evaluated actionability of the 15-file plan, missing files, test phasing, and runtime execution hazards.

The review uncovered **7 Blockers, 9 Majors, and 5 Nits**. Below is the prioritized catalogue of findings with precise proposed fixes.

---

## Prioritized Findings & AI Suggestions

### Issue 1 [egm-structural & egm-design] - Severity: Blocker
* **Affected Scope:** `docs/designs/confluence-autopilot-pinescript.md#L1-L358` (Global Structure)
* **Discrepancy Description:** The document completely lacks a mandatory `## Risks & Mitigations` section mandated by the Feature Specification Standard. Failure modes like network disconnects during open positions, rate limits, and NLP timeouts have no centralized architectural mitigation matrix.
* **AI Suggestion:** `PROPOSE FIX`
* **Justification:** Adding a dedicated section resolves the standard violation and explicitly details mitigations for all 4 critical production risk vectors.
* **Proposed Edit:**
  * Location: Insert after `## Proposed Architecture` (before `## Alternatives Considered`).
  * Content: Add `## Risks & Mitigations` detailing (1) WebSocket drop failsafes, (2) 4Hz tick rate limit management, (3) 10x leverage liquidation guards, and (4) Stale news NLP fail-soft mechanisms.

---

### Issue 2 [egm-design & egm-implementation-readiness] - Severity: Blocker
* **Affected Scope:** `docs/designs/confluence-autopilot-pinescript.md#L33`, `L99`, `L160`, `L327-L328`; `apps/server/src/quant/riskEngine.ts#L54-L74`
* **Discrepancy Description:** Adding margin presets up to 50.0% contradicts `riskEngine.ts` Gate 3, which hardcodes a 10% margin cap (`ERR_MARGIN_CAP_EXCEEDED`). Furthermore, in Auto-Pilot mode, 50% margin at 10x leverage creates catastrophic account blowout risk on a single 1.5x ATR tick.
* **AI Suggestion:** `PROPOSE FIX`
* **Justification:** Bifurcate risk policies cleanly between Auto-Pilot and Manual mode:
  1. Auto-Pilot Mode is strictly capped at max 10% margin allocation (or user-chosen 2.5%, 5%, 10%).
  2. Manual Discretionary Mode allows presets up to 50%, with `riskEngine.ts` Gate 3 updated to permit discretionary allocation up to 50% only when `mode !== 'AUTO_PILOT'`.
* **Proposed Edit:** Update Goal G6, `AutoPilotConfig`, and add `apps/server/src/quant/riskEngine.ts` to the touched files list to codify this risk policy bifurcation.

---

### Issue 3 [egm-design] - Severity: Blocker
* **Affected Scope:** `docs/designs/confluence-autopilot-pinescript.md#L175-L182` (Auto-Pilot Execution Loop)
* **Discrepancy Description:** 4Hz tick concurrency race condition: while `tradeManager.openPosition` executes over 150ms–500ms network round-trip, subsequent 4Hz ticks will evaluate `consensusMet === true` and trigger redundant duplicate orders before SQLite records the trade.
* **AI Suggestion:** `PROPOSE FIX`
* **Justification:** Implement a synchronous in-memory state latch inside `autoPilotManager.ts` (`state: 'IDLE' | 'EVALUATING' | 'PLACING_ORDER' | 'POSITION_OPEN' | 'CLOSING'`).
* **Proposed Edit:** State transitions synchronously to `PLACING_ORDER` before dispatching `openPosition`, locking out any concurrent tick triggers until the position confirmation promise settles.

---

### Issue 4 [egm-implementation-readiness] - Severity: Blocker
* **Affected Scope:** `docs/designs/confluence-autopilot-pinescript.md#L41-L45` (Open Questions) & `L175-L185`
* **Discrepancy Description:** Retaining Open Questions violates the Zero-Decision Rule of implementation readiness. Question 1 (Order Type) and Question 2 (Re-Entry Lockout) must be resolved.
* **AI Suggestion:** `PROPOSE FIX`
* **Justification:**
  - *Order Type:* Marketable `LIMIT` order with Time-In-Force `IOC` (Immediate-Or-Cancel), priced with 0.10% slippage tolerance (`markPrice * 1.0010` for Long, `markPrice * 0.9990` for Short) to guarantee non-slipping execution.
  - *Re-Entry Lockout:* Minimum 3 completed 1-minute bars (180 seconds) lockout on the symbol after any position close before auto-re-entry can trigger.
* **Proposed Edit:** Remove Open Questions 1 & 2 and incorporate their deterministic answers into Section 2.C of the Technical Plan.

---

### Issue 5 [egm-implementation-readiness] - Severity: Blocker
* **Affected Scope:** `docs/designs/confluence-autopilot-pinescript.md#L226-L358` (Detailed Implementation Plan)
* **Discrepancy Description:** The implementation plan is an unpartitioned flat list of 15 files with zero phasing, milestone boundaries, or intermediate testable checkpoints.
* **AI Suggestion:** `PROPOSE FIX`
* **Justification:** Partition into 6 logical, buildable phases:
  - Phase 1: Shared contracts & quant math (`@tradeos/shared`).
  - Phase 2: Micro-engines & Confluence core (`apps/server/src/quant`).
  - Phase 3: Webhook ingress & security bypass (`apps/server/src/api`).
  - Phase 4: Auto-Pilot state machine & TradeManager execution (`apps/server/src/services`).
  - Phase 5: Web Cockpit Confluence HUD, controls, and ticket (`apps/web`).
  - Phase 6: End-to-end integration & circuit-breaker test verification.
* **Proposed Edit:** Re-structure Section 5 with clear Phased Milestones and build/test gates.

---

### Issue 6 [egm-implementation-readiness] - Severity: Blocker
* **Affected Scope:** `docs/designs/confluence-autopilot-pinescript.md#L228-L341` (Touched Files List)
* **Discrepancy Description:** Incorrect file paths and missing runtime dependencies:
  1. `types.ts` does not exist -> it is `packages/shared/src/contracts.ts`.
  2. `OrderForm.tsx` does not exist -> it is `apps/web/src/components/OrderTicket.tsx`.
  3. Missing: `apps/server/src/quant/riskEngine.ts` (10% margin cap update).
  4. Missing: `apps/server/src/security/auth.ts` (exempt `/api/webhook` from Bearer session token).
  5. Missing: `apps/server/src/config.ts` (export `WEBHOOK_SECRET` and `CRYPTOPANIC_API_KEY`).
  6. Missing: `apps/server/src/index.ts` (bootstrap and wire new engines into router).
* **AI Suggestion:** `PROPOSE FIX`
* **Justification:** Add the missing files and correct the file paths to ensure zero runtime obstacles during code execution.
* **Proposed Edit:** Update Target Files list with exact workspace paths and explicit modification scopes.

---

### Issue 7 [egm-implementation-readiness] - Severity: Blocker
* **Affected Scope:** `docs/designs/confluence-autopilot-pinescript.md#L187-L193`, `L336-L341`
* **Discrepancy Description:** TradingView alerts cannot compute HMAC-SHA256 signatures or attach custom HTTP headers (`x-tradeos-signature`).
* **AI Suggestion:** `PROPOSE FIX`
* **Justification:** Standardize TradingView authentication to a shared secret in the alert JSON payload (e.g., `{"secret": "YOUR_SECRET", "symbol": "...", ...}`) or URL query string (`/api/webhook?secret=...`), verified via constant-time `crypto.timingSafeEqual`.
* **Proposed Edit:** Replace HMAC header instructions with payload passphrase verification.

---

### Issue 8 [egm-design] - Severity: Major
* **Affected Scope:** `docs/designs/confluence-autopilot-pinescript.md#L184-L185` (Opposite-Confluence Exit)
* **Discrepancy Description:** Microstructure metrics (Order Flow, CVD) fluctuate rapidly during consolidation, causing frequent opposite-confluence flips and fee-churn death spirals.
* **AI Suggestion:** `PROPOSE FIX`
* **Justification:** Require opposite consensus to persist for at least 2 consecutive 4Hz ticks or 1 candle close before triggering an early exit, and enforce a 180-second post-exit cooldown before re-entry.
* **Proposed Edit:** Update opposite-confluence exit rules in Section 2.C.

---

### Issue 9 [egm-design] - Severity: Major
* **Affected Scope:** `docs/designs/confluence-autopilot-pinescript.md#L187-L193`
* **Discrepancy Description:** Webhooks lack replay defense (no nonce check), and Pillar 7 has no TTL decay, allowing an hours-old TradingView alert to artificially trigger consensus on a stale setup.
* **AI Suggestion:** `PROPOSE FIX`
* **Justification:** Track incoming `alert_id` in an in-memory 60-second LRU cache to block replay attacks. Add a 15-minute TTL decay: Pillar 7 automatically reverts to `NEUTRAL` if no new alert arrives within 15 minutes.
* **Proposed Edit:** Add nonce tracking and 15-minute TTL decay specification to `confluenceEngine.ts`.

---

### Issue 10 [egm-design] - Severity: Major
* **Affected Scope:** `docs/designs/confluence-autopilot-pinescript.md#L175-L176`
* **Discrepancy Description:** If Auto-Pilot manages `SOLUSDT` and the user browses `BTCUSDT` in the UI, `activeSymbol` changes, starving the `SOLUSDT` auto-pilot monitor of tick evaluations.
* **AI Suggestion:** `PROPOSE FIX`
* **Justification:** Decouple `autoPilotManager` from the UI's ephemeral `activeSymbol`. It must maintain an independent tick subscription for any active managed position.
* **Proposed Edit:** Document independent symbol subscription in `autoPilotManager.ts`.

---

### Issue 11 [egm-design] - Severity: Major
* **Affected Scope:** `docs/designs/confluence-autopilot-pinescript.md#L183`
* **Discrepancy Description:** If ATR is tight (ATR < 0.10%), a `1.5x ATR` profit trigger is less than the 0.15% fee buffer, causing `tradeManager.moveToBreakeven()` to throw `ERR_BREAKEVEN_BUFFER_VIOLATION`.
* **AI Suggestion:** `PROPOSE FIX`
* **Justification:** Update the Breakeven profit trigger formula: `triggerProfitUsd = max(1.5 * ATR, entryPrice * 0.0025)`.
* **Proposed Edit:** Update Breakeven calculation in Section 2.C.

---

### Issue 12 [egm-design & egm-implementation-readiness] - Severity: Major
* **Affected Scope:** `docs/designs/confluence-autopilot-pinescript.md#L31`, `L164`
* **Discrepancy Description:** Discrepancy between 60-minute circuit-breaker and 15-minute manual cooldown in `riskEngine.ts`, plus in-memory volatility of the cooldown timer on node restart.
* **AI Suggestion:** `PROPOSE FIX`
* **Justification:** Persist `autopilot_cooldown_until` in SQLite `settings` table via `SettingsRepo`. Keep 15-minute cooldown for manual trades, and apply 60-minute cooldown specifically to autonomous auto-pilot mode.
* **Proposed Edit:** Document SQLite persistence in `autoPilotManager.ts`.

---

### Issue 13 [egm-implementation-readiness] - Severity: Major
* **Affected Scope:** `docs/designs/confluence-autopilot-pinescript.md#L125-L167`
* **Discrepancy Description:** Composite score formula lacks explicit pillar weights and threshold tables.
* **AI Suggestion:** `PROPOSE FIX`
* **Justification:** Codify explicit weights: MTF Trend (20%), Momentum/Volatility (15%), Order Flow (20%), CVD (15%), Liquidation Magnet (10%), News NLP (10%), PineScript SMC (10%) = 100%.
* **Proposed Edit:** Add explicit weighting table and threshold matrix in Section 2.B.

---

### Issue 14 [egm-implementation-readiness] - Severity: Major
* **Affected Scope:** `docs/designs/confluence-autopilot-pinescript.md#L237-L244`
* **Discrepancy Description:** `math.ts` duplicates MACD, Bollinger Bands, and ADX already implemented in `apps/server/src/quant/indicators.ts`.
* **AI Suggestion:** `PROPOSE FIX`
* **Justification:** Keep technical indicators in `indicators.ts` and re-export them; restrict `math.ts` to shared financial math and composite weighting.
* **Proposed Edit:** Update description of `math.ts` and `indicators.ts`.

---

### Issue 15 [egm-structural] - Severity: Major
* **Affected Scope:** `docs/designs/confluence-autopilot-pinescript.md#L96-L121`
* **Discrepancy Description:** Nodes `D3` (Margin Presets) and `D4` (Pine Overlay Toggle) in the Mermaid diagram are disconnected orphans.
* **AI Suggestion:** `PROPOSE FIX`
* **Justification:** Connect `D3` to `C1/C3` execution layer and `D4` to `B7` rendering feed to ensure valid closed diagram topology.
* **Proposed Edit:** Update Mermaid edge definitions.

---

### Issue 16 [egm-structural] - Severity: Major
* **Affected Scope:** `docs/designs/confluence-autopilot-pinescript.md#L207-L222`
* **Discrepancy Description:** `*Rejected by author: ...*` prefix without issue links violates the unlinked maintainer attribution standard.
* **AI Suggestion:** `PROPOSE FIX`
* **Justification:** Rephrase rejection rationales strictly in terms of technical, latency, and solvency invariants.
* **Proposed Edit:** Remove `Rejected by author:` prefixes.

---

### Issues 17–21 [egm-structural, egm-design, egm-implementation-readiness] - Severity: Nit
* **Affected Scope:** Heading taxonomy, backticks in headings, unlinked URLs, contract paths, Pine marker Zustand storage.
* **AI Suggestion:** `PROPOSE FIX`
* **Justification:** Clean up typography, demote H4 file headings to a structured table, format links properly, and define Pine marker storage contract in `useMarketStore`.
