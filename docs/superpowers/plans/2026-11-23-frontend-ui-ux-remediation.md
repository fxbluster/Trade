# Frontend UI/UX Remediation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Resolve all 20 UI/UX forensic defects across TradeOS-v2 frontend presentation tier without breaking contracts, test suites, or tsc compilation.

**Architecture:** Presentation-tier decoupling separating analytical chart overlays from execution price axes, standardizing global currency formatting (`-$XX.XX`) with zero-guards, implementing adaptive 2-row layouts for narrow docked sidebars, and retaining optimistic state during WebSocket reconnects.

**Tech Stack:** React 18, TypeScript 5.7, Tailwind CSS, Lightweight Charts v4, Zustand, Vitest.

**Spec:** [`docs/designs/frontend-ui-ux-stabilization-and-remediation.md`](file:///C:/Users/HP/TradeOS-v2/docs/designs/frontend-ui-ux-stabilization-and-remediation.md)

## Global Constraints

*   Zero modifications to backend WebSocket contracts, schema definitions, or SQLite database.
*   Preserve all existing testing anchors (`data-testid="pnl-summary-btn"`, `data-testid="refresh-scorecard-btn"`, etc.).
*   Zero TypeScript compilation errors (`npx tsc --noEmit -p apps/web/tsconfig.json`).
*   Pass all 26 server test files (273 tests) and all web test suites without regression.
*   Dark-mode fintech styling (#020305, #080c14, #151d2c, emerald #0ecb81, rose #f6465d) preserved.

## Review Focus

*   Signed zero edge cases (`-0`, `-0.001`, `0`, `0.004`) returning `$0.00` regardless of `showPlus`.
*   Non-finite inputs (`NaN`, `Infinity`, `null`, `undefined`) falling back safely to `$0.00`.
*   Crosshair time formatting in `ChartCanvas.tsx` removing seconds without passing invalid option objects.
*   Confluence directional consensus enforcing `>= 4` directional pillars on `BULLISH` and `BEARISH` without false flashing on `NEUTRAL`.
*   Horizontal table scrolling in `TradeJournalPanel.tsx` remaining intact on screens < 800px.

---

### Task 1: Shared Financial Formatter & Unit Tests

**Files:**
- Create: `apps/web/src/lib/formatters.ts`
- Create: `apps/web/src/lib/__tests__/formatters.test.ts`

**Interfaces:**
- Produces: `formatUsd(val: number | null | undefined, showPlus?: boolean): string`

- [ ] **Step 1: Write the failing tests for `formatUsd`**

Create `apps/web/src/lib/__tests__/formatters.test.ts` testing:
- Negative values format as `-$XX.XX` (`-107.7` -> `-$107.70`, `-15.56` -> `-$15.56`).
- Zero and near-zero values format strictly as `$0.00` even with `showPlus=true` (`0` -> `$0.00`, `-0` -> `$0.00`, `-0.001` -> `$0.00`, `0.004` -> `$0.00`).
- Positive values format with `+` only when `showPlus=true` (`19.89` -> `+$19.89` or `$19.89`).
- Non-finite inputs (`NaN`, `Infinity`, `null`, `undefined`) return `$0.00`.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run apps/web/src/lib/__tests__/formatters.test.ts`
Expected: FAIL with module not found or undefined export.

- [ ] **Step 3: Implement `formatUsd` in `apps/web/src/lib/formatters.ts`**

Implement pre-allocated `Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })` with strict finite and epsilon guards (`Math.abs(val) < 0.005 ? '$0.00'`).

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run apps/web/src/lib/__tests__/formatters.test.ts`
Expected: PASS (all assertions green).

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/lib/formatters.ts apps/web/src/lib/__tests__/formatters.test.ts
git commit -m "feat(web): add hardened formatUsd financial formatter with zero-guard"
```

---

### Task 2: Chart Canvas Y-Axis Decoupling & Crosshair Localization

**Files:**
- Modify: `apps/web/src/components/ChartCanvas.tsx:27-36,516,526,547,557,573`

**Interfaces:**
- Consumes: `formatLocalTime(timestampSec: number): string`

- [ ] **Step 1: Inspect `ChartCanvas.tsx` price lines and time formatter**

Verify current `axisLabelVisible: true` on lines 516 (FVG High), 526 (FVG Low), 547 (OB High), 557 (OB Low), 573 (Sweep line), and verify `second: '2-digit'` in `formatLocalTime`.

- [ ] **Step 2: Suppress axis labels on secondary SMC lines**

Set `axisLabelVisible: false` on:
- Line 516 (FVG High price line)
- Line 526 (FVG Low price line)
- Line 547 (OB High price line)
- Line 557 (OB Low price line)
- Line 573 (Sweep price line)
Retain `axisLabelVisible: true` strictly on active trade execution levels (Entry, SL, TP1, TP2, Breakeven, Liq).

- [ ] **Step 3: Remove seconds from crosshair time localization**

In `formatLocalTime` (lines 27–36), change `toLocaleTimeString('az-AZ', ...)` to specify solely `hour: '2-digit', minute: '2-digit', hour12: false`.

- [ ] **Step 4: Verify TypeScript compilation**

Run: `npx tsc --noEmit -p apps/web/tsconfig.json`
Expected: PASS (exit code 0).

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/ChartCanvas.tsx
git commit -m "fix(chart): decouple secondary SMC price labels from Y-axis and format crosshair time"
```

---

### Task 3: Confluence HUD Text Compacting & Consensus Threshold

**Files:**
- Modify: `apps/web/src/components/ConfluenceHUD.tsx:120-170,250-275`

**Interfaces:**
- Produces: `compactText(t?: string): string`, `isEffectiveConsensusMet: boolean`

- [ ] **Step 1: Implement safe `compactText` helper**

Add `compactText(t?: string): string` with undefined guard and replacements for `Equilibrium (No Active Zones)` -> `No Active Zones`, `Delta flow within normal bounds` -> `Normal Bounds`, `unmitigated FVGs` -> `FVGs`, and `Order Blocks` -> `OB`.

- [ ] **Step 2: Enforce directional consensus threshold**

Update consensus calculation:
```typescript
const isEffectiveConsensusMet = Boolean(
  consensusMet &&
  ((consensusBias === 'BULLISH' && bullishCount >= 4) ||
   (consensusBias === 'BEARISH' && bearishCount >= 4))
);
```
Use `isEffectiveConsensusMet` for driving green/red pulsing badge. When directional pillars `< 4`, display neutral styling `${Math.max(bullishCount, bearishCount)}/7 Pillars (Min 4 Req)`.

- [ ] **Step 3: Optimize card padding and line-clamp**

In card render:
- Reduce padding from `p-2` to `p-1.5`.
- Replace `truncate` on line 264 and 267 with `line-clamp-1 break-words`.
- Apply `compactText` to `pillar.valueText` and `pillar.subText`.
- Bind `${pillar.valueText} - ${pillar.subText}` to container `title`.

- [ ] **Step 4: Verify TypeScript compilation**

Run: `npx tsc --noEmit -p apps/web/tsconfig.json`
Expected: PASS (exit code 0).

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/ConfluenceHUD.tsx
git commit -m "fix(confluence): prevent card text truncation and enforce 4-pillar consensus threshold"
```

---

### Task 4: Sidebar Telemetry Layout & Dynamic Pillar Badges

**Files:**
- Modify: `apps/web/src/components/AgentTelemetryPanel.tsx:240-335`

**Interfaces:**
- Produces: `getPillarBadgeColor(bias?: string): string`

- [ ] **Step 1: Implement dynamic `getPillarBadgeColor` helper**

Define helper mapping `BULLISH` / `BUY` to `border bg-[#0ecb81]/10 text-[#0ecb81] border-[#0ecb81]/30`, `BEARISH` / `SELL` to `border bg-[#f6465d]/10 text-[#f6465d] border-[#f6465d]/30`, and default to `border bg-[#151d2c] text-[#7d8590] border-[#151d2c]`. Apply to P7 news badge on lines 317–331.

- [ ] **Step 2: Restructure summary row for `isDockedRight`**

When `isDockedRight === true`:
- Structure into a two-row flex container:
  - Row 1: Time, Symbol, Side, Composite score.
  - Row 2: Mark price (`$XX.XX font-mono`), Consensus pill, Status indicator, Chevron.
Prevent mark price and consensus pill from colliding or breaking unexpectedly.

- [ ] **Step 3: Verify TypeScript compilation**

Run: `npx tsc --noEmit -p apps/web/tsconfig.json`
Expected: PASS (exit code 0).

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/components/AgentTelemetryPanel.tsx
git commit -m "fix(telemetry): implement 2-row docked rail layout and semantic pillar badge coloring"
```

---

### Task 5: Modals, Currency Formatting & Table Alignment

**Files:**
- Modify: `apps/web/src/components/PnLSummaryModal.tsx:160,231,248,253,284,296,303,328,344,349,353`
- Modify: `apps/web/src/components/ScannerModal.tsx:128-194`
- Modify: `apps/web/src/components/TimeMachineModal.tsx:204-211`
- Modify: `apps/web/src/components/PillarScorecardModal.tsx:248,252`

**Interfaces:**
- Consumes: `formatUsd` from `apps/web/src/lib/formatters.ts`

- [ ] **Step 1: Standardize `PnLSummaryModal.tsx` currency and breakeven stats**

- Import `formatUsd`.
- Replace string interpolations on lines 160, 231, 248, 284, 328, 344 with `formatUsd(val, true)`.
- Format commissions on lines 253, 296, 349 with `formatUsd(val, false)` (no plus sign).
- On line 303, calculate `const beCount = Math.max(0, data.threeDays.tradeCount - data.threeDays.winCount - data.threeDays.lossCount)` and display `{data.threeDays.lossCount} ({beCount} Breakeven)`.
- On line 353, render dynamic label: `{data.threeDays.netPnl >= 0 ? 'Müsbət (' : 'Mənfi ('}{formatUsd(data.threeDays.netPnl, true)})`.

- [ ] **Step 2: Align `ScannerModal.tsx` financial columns**

Apply `text-right tabular-nums font-mono` to columns 2–5 (`Price`, `24h Change`, `24h Volume`, `Funding`) and add `justify-end` to inner header flex containers on lines 137, 146.

- [ ] **Step 3: Guard `TimeMachineModal.tsx` Monte Carlo bar**

Replace lines 204–211 with strict boolean ternary: `{timeoutProb !== null && timeoutProb > 0.01 ? <div .../> : null}`.

- [ ] **Step 4: Guard `PillarScorecardModal.tsx` MFE/MAE signed zeros**

- Line 248: `{Math.abs(row.avgMfePct) < 0.005 ? '0.00%' : `+${row.avgMfePct.toFixed(2)}%`}`
- Line 252: `{Math.abs(row.avgMaePct) < 0.005 ? '0.00%' : `-${row.avgMaePct.toFixed(2)}%`}`

- [ ] **Step 5: Verify TypeScript compilation**

Run: `npx tsc --noEmit -p apps/web/tsconfig.json`
Expected: PASS (exit code 0).

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/components/PnLSummaryModal.tsx apps/web/src/components/ScannerModal.tsx apps/web/src/components/TimeMachineModal.tsx apps/web/src/components/PillarScorecardModal.tsx
git commit -m "fix(modals): apply formatUsd, table tabular alignment, and zero-guards across modal dialogs"
```

---

### Task 6: Cockpit Stabilization, Reconnect Snapshot & TestID Preservation

**Files:**
- Modify: `apps/web/src/components/TopBar.tsx:152,196-230,263-298`
- Modify: `apps/web/src/components/TradeJournalPanel.tsx:114,150`
- Modify: `apps/web/src/components/ActivePositionPanel.tsx:122`
- Modify: `apps/web/src/store/useMarketStore.ts:80-150`
- Modify: `apps/web/src/App.tsx:114-119`

**Interfaces:**
- Consumes: `formatUsd` from `apps/web/src/lib/formatters.ts`

- [ ] **Step 1: Stabilize `TopBar.tsx` layout and testid**

- Transfer `data-testid="pnl-summary-btn"` to center summary pill button on line 196.
- Remove redundant right toolbar button on lines 222–230.
- Place `DollarSign` icon before text and eliminate trailing `$`.
- Add vertical divider between Mark Price and Equity (`border-r border-[#151d2c] pr-3 mr-2`).
- Add `shadow-2xl ring-1 ring-white/10` to symbol dropdown on line 152.
- Set `min-w-[108px] text-center justify-center` on `[Daily Audit]` export button.
- Format unrealized PnL and session net PnL with `formatUsd(val, true)` (lines 213–214).

- [ ] **Step 2: Fix `TradeJournalPanel.tsx` scrolling and formatting**

- Update container on line 114 to `overflow-x-auto overflow-y-auto max-h-[160px] custom-scrollbar`.
- On line 150, format realized PnL with `formatUsd(t.realized_pnl, true)`.
- Apply `text-right tabular-nums font-mono` to Entry, Exit, Qty, PnL, and Fees columns.

- [ ] **Step 3: Fix `ActivePositionPanel.tsx` currency formatting**

On line 122, format unrealized PnL with `formatUsd(unrealizedPnlUsd, true)` to eliminate `($-XX.XX)`.

- [ ] **Step 4: Implement optimistic retention in `useMarketStore.ts`**

In `useMarketStore.ts`, when handling reconnect or connection drop, preserve the previous valid non-zero `account` and `activePosition` state until new WebSocket snapshot arrives.

- [ ] **Step 5: Enforce viewport constraints in `App.tsx`**

Bound expanded bottom dock to `max-h-[45vh] min-h-[300px]` while ensuring `ChartCanvas` container maintains `min-h-[220px]`.

- [ ] **Step 6: Run full verification suite**

1. `npx tsc --noEmit -p apps/web/tsconfig.json` -> Exit code 0
2. `npx vitest run apps/web/src/lib/__tests__/formatters.test.ts` -> 100% pass
3. `npm --workspace=apps/server test` -> 26 files, 273 tests pass
4. `npm --workspace=apps/web run build` -> Clean bundle generation

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/components/TopBar.tsx apps/web/src/components/TradeJournalPanel.tsx apps/web/src/components/ActivePositionPanel.tsx apps/web/src/store/useMarketStore.ts apps/web/src/App.tsx
git commit -m "fix(cockpit): stabilize TopBar testids, journal scrolling, and reconnect state retention"
```
