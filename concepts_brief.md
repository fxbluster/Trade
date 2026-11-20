# TradeOS v2: Cockpit Stabilization & Forensic Remediation

* **Author:** fxbluster
* **Date:** 2026-11-20

## Overview

This proposal unifies the complete stabilization plan for the TradeOS v2 trading cockpit, resolving the critical 4Hz UI thread freeze reported during live testing, alongside seven user experience, risk enforcement, and quantitative telemetry defects identified in the forensic analysis of session recording `D:\Recording 2026-11-20 185617.mp4`.

The core value proposition is restoring an ultra-smooth, 60fps institutional trading interface that guarantees execution safety under extreme market volatility, prevents unhedged naked orders, and presents mathematically verified exchange telemetry.

## Analysis

### 1. Root Cause Analysis: The 4Hz UI Thread Freeze
* **Mechanics:** In `useMarketStore.ts`, the `applyTick` method mutates the store by recreating the `klines` array reference up to 4 times per second (`updatedKlines = [...updatedKlines.slice(0, -1), tick.candle]`). In `ChartCanvas.tsx`, a `useEffect` hook depends directly on `[klines, symbol]`. Consequently, every tick executes a full map of 400 candles and triggers `candleSeriesRef.current.setData(candleData)` and `chartRef.current?.timeScale().fitContent()`.
* **Impact:** Rebuilding the entire canvas DOM geometry and resetting viewport boundaries 4 times every second locks the JavaScript main thread. User gestures (scrolling, zooming, panning) freeze, producing severe stuttering ("özü baya takılır").
* **Inventive Solution (TRIZ Principle 24 - Intermediary & Principle 10 - Preliminary Action):** Decouple streaming tick rendering entirely from the React component lifecycle. Live price ticks stream directly via `wsClient.subscribeTick` to `candleSeries.update(...)` at 60fps without touching Zustand `klines`. `setData` and `fitContent` execute strictly during discrete events: initial kline fetch, symbol change, or interval switch.

### 2. Risk Enforcement & Dead-SL Armor Invariant
* **Mechanics:** In `packages/shared/src/math.ts`, `deadSlSafe` defaults to `true` when Stop Loss is omitted or zero. This allows users to place unhedged orders with empty Stop Loss inputs, violating institutional LiquidationGuard mandates.
* **Inventive Solution (TRIZ Principle 25 - Self-Service):** Auto-arm the Order Ticket. When a trader clicks a margin allocation preset (e.g. 2.5%, 10%), the ticket automatically populates a default Stop Loss at $-1.5\text{x ATR}$ and projects the red SL price line directly onto the chart. Order submission remains disabled until an active Stop Loss is armed.

### 3. Quantitative Telemetry & Order Flow Disentanglement
* **Mechanics:** In `orderFlowEngine.ts`, rolling trade volume accumulates without time decay. Historic aggressive sells overwhelm real-time book depth ($8.0M bids vs $6.0M asks), displaying an inverted and contradictory status (`Balanced (2.7x Sell)`).
* **Solution:** Introduce a 60-second sliding window / exponential decay for aggressive trade delta, and clearly separate Level 2 Book Depth Ratio from Taker Volume Delta in the HUD.

### 4. Cockpit Flight Deck Layout & Ergonomics
* **Mechanics:** The right 30% sidebar places Auto-Pilot controls, Order Ticket, and Sokrat Mentor in a single scrollable container. Scrolling down to adjust leverage or margin pushes Auto-Pilot controls completely off-screen, eliminating operator visibility of autonomous states and emergency halt switches.
* **Solution:** Split the sidebar into a pinned, fixed-height Executive Header (Auto-Pilot status, kill switch, consensus meter) and a secondary scrollable ticket container.

### 5. Resilient Market Scanner & Monte Carlo Simulation
* **Mechanics:** The scanner modal fails open to a blank black box under network jitter, and the Monte Carlo simulation displays detached 58%/38% probabilities when SL/TP targets are blank.
* **Solution:** Add skeleton loading with client-side fallback to pre-cached top-50 symbols in `ScannerModal.tsx`, and dynamically derive Monte Carlo simulation boundaries from real-time ATR ($\pm 1.5\text{x ATR}$ SL, $\pm 2.0\text{x ATR}$ TP) when user inputs are empty.

## Goals vs. Non-Goals

* **In-Scope Goals:**
  * Eliminate `setData` and `fitContent` re-renders from the live tick path in `ChartCanvas.tsx` and `useMarketStore.ts`.
  * Suppress volume series Y-axis labels on the right chart scale to eliminate number collision.
  * Auto-arm Stop Loss to $-1.5\text{x ATR}$ on preset selection and enforce `deadSlSafe = false` when SL is absent in `@tradeos/shared`.
  * Fix rolling trade decay in `orderFlowEngine.ts` to prevent Order Flow signal inversion.
  * Pin `<AutoPilotControls />` above the scrollable right rail in `App.tsx`.
  * Add skeleton loading and cached fallbacks to `ScannerModal.tsx`.
  * Dynamically bind `TimeMachineModal.tsx` simulation boundaries to ATR.
  * Render neutral operational diagnostics in `CooldownModal.tsx` when no cooldown is active.

* **Out-of-Scope Non-Goals:**
  * Rewriting Lightweight Charts with an external third-party charting library.
  * Allowing unhedged naked futures positions without a Stop Loss.
  * Restyling global color schemes or dark mode themes.

## Alternatives Weighed

1. *Throttling React re-renders with `useThrottle` (Rejected):* Even throttled to 2Hz, invoking `setData(400)` and `fitContent()` continues to reset user viewport zoom and causes noticeable UI stutter. Direct series mutation via `candleSeries.update(...)` is the standard pattern.
2. *Blocking order entry with pop-up modal error alerts (Rejected):* Pop-up modals interrupt fast-paced trading. Auto-arming Stop Loss to $-1.5\text{x ATR}$ provides an immediate, zero-friction safety default that the trader can visually fine-tune.
3. *Lazy-loading all 767 Binance symbols on modal open (Rejected):* A fresh REST fetch over tunnel connections takes up to 1.5s. Caching top-50 volume pairs in memory on startup ensures sub-100ms instant modal display.

## Key Decisions & Staging for Next Steps

* **Decision 1 (Chart Architecture):** Live ticks belong strictly to `wsClient` -> `candleSeries.update(...)`. `useMarketStore` maintains scalar values (`markPrice`, `pnl`, `equity`), leaving `klines` immutable during streaming.
* **Decision 2 (Execution Armor):** Stop Loss is mandatory. Margin presets auto-calculate $-1.5\text{x ATR}$ SL to ensure the `HOLD 400MS` button is always safely armed upon click.
* **Decision 3 (Flight Deck):** Auto-Pilot panel is permanently pinned at the top of the right rail.
