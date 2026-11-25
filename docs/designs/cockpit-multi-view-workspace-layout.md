# TradeOS Cockpit 3-View Multi-Workspace Architecture (`Ticarət` / `Fon Hesabı` / `Kvant & Loqlar`)

* **Author:** fxbluster
* **Status:** Proposed
* **Date:** 2026-11-25

---

## Overview

The current TradeOS v2 Cockpit renders every major subsystem—`TopBar`, `PropFirmChallengeHUD`, `ConfluenceHUD` (7-card Orthogonal Alpha Matrix), `ChartCanvas`, and the bottom `Active Position / Open Orders / Trade Journal / Agent Loqları` panel—simultaneously inside a locked single-viewport container (`h-screen overflow-hidden`). On standard laptop and desktop screens (768px–1080px height), the fixed top widgets consume ~460px of vertical height, crushing the bottom **Active Position / Open Orders / Trade Journal** panel into an unusable ~50px strip where active trades cannot be read.

This design partitions the Cockpit's main workspace into **3 clean, instant-switch Workspace Views** controlled by a dedicated slim Workspace Navigation Bar directly beneath `TopBar`:
1. **`📊 Ticarət` (`TRADING`)**: Dedicated to Chart (~58% height) + Active Position / Open Orders / Trade Journal (~42% height, `min-h-[240px]`), paired with a compact 1-line status strip showing live Upcomers PnL and Quant Score.
2. **`🏆 Fon Hesabı ($50K)` (`PROPFIRM`)**: Dedicated to the full Upcomers $50K Thunderbolt monitor, expanded cycle history table, Markdown certificate download button, and Verified Trade Journal.
3. **`🧠 Kvant & Loqlar` (`QUANT`)**: Dedicated to the full Institutional Confluence Matrix, 7 Orthogonal Alpha Factor cards (MGS Gram-Schmidt), Noise Band / Macro Veto banners, and spacious full-width live `Agent Loqları` telemetry.

The right-hand **AutoPilot & Execution Rail** remains pinned across all 3 views so the operator can arm/disarm Auto-Pilot or inspect order controls from any view without losing context.

---

## Problem Statement

1. **Vertical Viewport Starvation:** Stacking `TopBar` (~52px) + `PropFirmChallengeHUD` (~140px) + `ConfluenceHUD` (~270px) with `flex-shrink-0` leaves insufficient vertical height for `ChartCanvas` and the bottom `Active Position` panel inside `h-screen overflow-hidden`.
2. **Cognitive Overload for Non-Trader Operators:** Displaying 7 orthogonal factor math cards, Upcomers drawdown meters, candlestick chart, active positions, and order execution controls on one screen overwhelms the operator and obscures the primary question: *"What is my active trade doing right now?"*
3. **TopBar Horizontal Density Limit:** `TopBar` already contains 12+ controls across the header. Adding 3 workspace navigation tabs directly into `TopBar` would cause horizontal overflow on 1366px–1440px viewports.

---

## Goals

* **G-1 (Unobstructed Active Trades & Chart):** On the default `Ticarət` view, guarantee `Active Position / Open Orders / Trade Journal` receives at least `40%` of the main column height (`min-h-[240px]`), while `ChartCanvas` receives `~60%` (`min-h-[300px]`).
* **G-2 (3-Tab Instant Workspace Switcher):** Introduce a slim (~36px) Workspace Navigation Bar directly beneath `TopBar` with 3 views (`Ticarət`, `Fon Hesabı ($50K)`, `Kvant & Loqlar`), switching instantaneously via Zustand state (`useUiStore`) without page reloads or WebSocket disconnects.
* **G-3 (Persistent 1-Line Live Telemetry Strip):** On the right side of the Workspace Navigation Bar, always display live clickable summary pills for Upcomers verdict/PnL, Quant Conviction score, and a compact `Top-Up $50K ↗` pill when `needsTopUp === true`.
* **G-4 (Dedicated Funded Account & Quant Views):** Give `PropFirmChallengeHUD` (with cycle history table expanded by default + Markdown certificate download button) and `ConfluenceHUD` + `AgentTelemetryPanel` their own spacious, scrollable dedicated workspaces.
* **G-5 (Zero Chart Corruption on Tab Switch):** Ensure switching away from `Ticarət` and returning immediately renders `ChartCanvas` with all candles, SMC overlays, and proper dimensions without blank canvas glitches.

---

## Non-Goals

* **NG-1 (Backend API Modifications):** No new backend endpoints are required; all data is already served by existing WebSocket streams and REST endpoints (`/api/propfirm/status`, `/api/propfirm/certificate?format=markdown`, `/api/audit/daily`).
* **NG-2 (URL Router Library Adoption):** Introducing `react-router-dom` is unnecessary overhead for a single-page real-time trading cockpit. Lightweight Zustand state + `sessionStorage` persistence is sufficient.

---

## Technical Plan (Architecture)

### Component Hierarchy

```text
App.tsx (h-screen w-screen flex flex-col overflow-hidden)
├── TopBar (52px — unchanged, zero extra horizontal bloat)
├── WorkspaceNavBar (36px — NEW slim sub-bar)
│   ├── Left: 3 Workspace Tabs
│   │   ├── [📊 Ticarət]        (+ green badge "1 Açıq" when activePosition exists)
│   │   ├── [🏆 Fon Hesabı]     (+ amber dot when needsTopUp or HALT; cycle # badge)
│   │   └── [🧠 Kvant & Loqlar] (+ live score badge e.g. "46% WAIT")
│   └── Right: Always-Visible 1-Line Live Status Pills (clickable to jump views)
│       ├── Upcomers Pill: "Upcomers: $0.00 / +$2,500" -> switches to PROPFIRM
│       ├── Quant Pill: "Skor: 46% WAIT" -> switches to QUANT
│       └── Top-Up Pill (if needsTopUp): "⚠️ Top-Up $50K ↗" -> testnet.binancefuture.com
└── Main 70 / 30 Two-Column Split (flex-1 flex overflow-hidden p-2 gap-2)
    ├── Left 70% Workspace Canvas (flex-[7] flex flex-col min-w-0 h-full overflow-hidden)
    │   ├── IF activeWorkspaceView === 'TRADING':
    │   │   ├── ChartCanvas Wrapper (flex-[6] min-h-[280px] overflow-hidden)
    │   │   └── Bottom Tabs Panel (flex-[4] min-h-[240px] flex flex-col overflow-hidden)
    │   │       └── Active Position | Open Orders | Trade Journal | Agent Loqları
    │   ├── IF activeWorkspaceView === 'PROPFIRM':
    │   │   └── Scrollable Container (flex-1 overflow-y-auto space-y-2 pr-1)
    │   │       ├── PropFirmChallengeHUD (defaultHistoryOpen={true}, Markdown cert download btn)
    │   │       └── TradeJournalPanel (Verified Trade Journal & Quant Analytics)
    │   └── IF activeWorkspaceView === 'QUANT':
    │       └── Scrollable Container (flex-1 overflow-y-auto space-y-2 pr-1)
    │           ├── ConfluenceHUD (Full Institutional & Orthogonal Alpha Matrix)
    │           └── AgentTelemetryPanel (min-h-[380px] full-width live thought stream)
    └── Right 30% Pinned Rail (unchanged: AutoPilotControls + OrderTicket/Mentor | Agent Loqları)
```

### Key Technical Contracts & Edge Cases

1. **`useUiStore.ts` Extensions:**
   * Export `export type WorkspaceViewType = 'TRADING' | 'PROPFIRM' | 'QUANT';`
   * Add `activeWorkspaceView: WorkspaceViewType` (initialized from `sessionStorage.getItem('tradeos_workspace_view')`, validated against the 3 allowed values, defaulting to `'TRADING'`).
   * Add `setActiveWorkspaceView: (view: WorkspaceViewType) => void` (updates state + writes to `sessionStorage` inside `try/catch`).

2. **`PropFirmChallengeHUD.tsx` Enhancements:**
   * Add optional prop `defaultHistoryOpen?: boolean` (default `false`; passed as `true` in `PROPFIRM` view so the cycle history table is immediately visible).
   * Add a **"Sertifikatı Yüklə (.md)"** button (`data-testid="propfirm-download-cert-btn"`) calling `apiClient.getPropFirmCertificate('markdown')` and triggering a browser download of the Upcomers 5-cycle Markdown report.

3. **`ChartCanvas.tsx` Re-Mount Integrity:**
   * Because `TRADING` unmounts `ChartCanvas` when switching to `PROPFIRM` or `QUANT` and remounts it upon returning, verify that `ChartCanvas` immediately populates its Lightweight-Charts series from `useMarketStore.getState().candles` on mount without requiring a new REST fetch and cleanly disposes ResizeObserver/chart instances on unmount (zero memory leaks).

4. **`apiClient.ts` Addition:**
   * Add `downloadPropFirmCertificateMarkdown()` (or support `format: 'json' | 'markdown'` in `getPropFirmCertificate(format)`) using the existing authenticated session header.

---

## Alternatives Considered

* **Collapsible Drawers on One Page:** Rejected because expanding both Upcomers and the 7-card Orthogonal Matrix recreates the exact same bottom-panel squashing problem.
* **Single Vertical Scrollable Page:** Rejected because operators must constantly scroll up and down to compare active positions against Upcomers rules and right-rail AutoPilot controls.

---

## Detailed Implementation Plan

### Phase 1: UI Store & Workspace Navigation Bar
* **`apps/web/src/store/useUiStore.ts` (Modify):** Add `WorkspaceViewType`, `activeWorkspaceView`, `setActiveWorkspaceView` with safe `sessionStorage` persistence.
* **`apps/web/src/components/WorkspaceNavBar.tsx` (Create):** Implement the 36px 3-tab navigation bar (`Ticarət`, `Fon Hesabı ($50K)`, `Kvant & Loqlar`) with live active-position badge, Upcomers PnL summary pill, Quant Score pill, and compact `Top-Up $50K ↗` link.

### Phase 2: App.tsx 3-View Layout & PropFirm Enhancements
* **`apps/web/src/App.tsx` (Modify):** Mount `WorkspaceNavBar` below `TopBar` and conditionally render the 3 dedicated workspaces inside the left 70% column while keeping the right 30% AutoPilot/Order rail pinned. Ensure `TRADING` gives `ChartCanvas` `flex-[6]` and the bottom `Active Position` panel `flex-[4] min-h-[240px]` (or full height when `isBottomExpanded` is toggled).
* **`apps/web/src/components/PropFirmChallengeHUD.tsx` (Modify):** Support `defaultHistoryOpen?: boolean` and add Markdown certificate download button.
* **`apps/web/src/lib/apiClient.ts` (Modify):** Support `format: 'markdown'` in `getPropFirmCertificate` returning raw Markdown text.

### Phase 3: Tests, Build & Multi-View Live Browser Verification
* **`apps/web/src/components/__tests__/WorkspaceNavBar.test.tsx` (Create):** Verify tab rendering, active view switching, open-position badge, and top-up pill behavior.
* **`apps/web/src/components/__tests__/PropFirmChallengeHUD.test.tsx` (Modify):** Verify `defaultHistoryOpen={true}` and certificate download button.
* **Verification Gate:**
  * `npm test` passes 100% (`Exit code: 0`).
  * `npm run build` passes 100% (`Exit code: 0`).
  * Live Chrome DevTools verification on `http://127.0.0.1:3400/` across all 3 views (`Ticarət`, `Fon Hesabı`, `Kvant & Loqlar`) confirming `Active Position` panel is fully visible (`>= 240px`) and `ChartCanvas` renders cleanly after switching tabs and returning.

---

*Drafted with EGM*
