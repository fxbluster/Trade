# Binance Futures Testnet & Chart Real-Time Synchronization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Synchronize Binance Futures Testnet balance display and trade execution with hardened 24-character client order IDs, and synchronize Lightweight Charts with local Baku timezone (UTC+4) and real-time 4Hz tick streaming.

**Architecture:** Frontend `ChartCanvas.tsx` gets a localized timeFormatter to convert UTC epoch timestamps to local browser time (Baku UTC+4) and an aligned tick updater. The backend `index.ts` stream tick coalescing is aligned to candle bucket bounds. `TopBar.tsx` displays an explicit "BINANCE FUTURES TESTNET (DEMO)" environment badge with live balance ($4,960.90 USDT) to resolve user ambiguity.

**Tech Stack:** TypeScript, React, Vite, Zustand, Lightweight Charts (v4), Node.js Polka REST, WebSocket (ws), Binance Futures Testnet REST API.

**Spec:** `C:\Users\HP\.gemini\antigravity\brain\f41bbc02-73e8-4d36-8dcd-17ed640e8a33\concepts_brief.md`

## Global Constraints
- Maximum `newClientOrderId` length is strictly 36 characters (Binance limit). Our format `tos_<16hex>_<type>` is 24 characters.
- Binance klines are delivered in UTC epoch seconds. The frontend must format the timescale in the user's local timezone without modifying the underlying numeric timestamp in candle data.
- All existing 175 tests across 14 test files must pass with 0 regressions.

## Review Focus
- Local time formatting must not cause NaN or broken dates when switching intervals (1m, 5m, 15m, 1h).
- Real-time tick update must correctly adjust high and low prices when mark price breaches current candle boundaries.
- TopBar balance display must format available and wallet balances to 2 decimal places with currency symbol ($USDT).
- Testnet error reporting in OrderTicket must surface clear messages instead of generic unhandled exceptions.
- Chart resize and symbol change must not leave phantom price lines or desynchronized scales.

---

### Task 1: Chart Local Timezone Formatting & Tick Price Update

**Files:**
- Modify: `apps/web/src/components/ChartCanvas.tsx:40-140`
- Test: `apps/web/src/components/__tests__/ChartCanvas.test.tsx` (or vitest check)

**Interfaces:**
- Consumes: `useMarketStore.symbol`, `klines`, `wsClient.subscribeTick`
- Produces: Correctly rendered candlestick chart with local time on timescale and real-time intra-candle tick updates.

- [ ] **Step 1: Write/Update test for ChartCanvas timezone formatting**
Verify that timestamp formatting helper outputs valid localized time strings for UTC epoch timestamps.

- [ ] **Step 2: Run test to verify behavior**
Run: `npm --prefix apps/web test`

- [ ] **Step 3: Implement local timeFormatter and intra-candle tick aggregation in `ChartCanvas.tsx`**
In `createChart` options, add `localization.timeFormatter` using `Intl.DateTimeFormat` for local time (HH:mm:ss for intraday). In `handleTick`, update the latest candle's `close`, `high` (if tick > high), and `low` (if tick < low).

- [ ] **Step 4: Verify chart build and formatting**
Run: `npm --prefix apps/web run build`

- [ ] **Step 5: Commit**
```bash
git add apps/web/src/components/ChartCanvas.tsx
git commit -m "fix(chart): add local timezone formatting and intra-candle tick updates"
```

---

### Task 2: Backend Candle Tick Bucket Alignment in Stream Manager

**Files:**
- Modify: `apps/server/src/index.ts:180-230`
- Test: `apps/server/src/exchange/__tests__/binanceDemoAdapter.test.ts`

**Interfaces:**
- Consumes: `streamsManager.onMarkPrice`, `streamsManager.onKline`
- Produces: `wsHub.broadcastTick` with properly bucketed `latestCandle` matching the active symbol.

- [ ] **Step 1: Verify current tick broadcast candle creation in `apps/server/src/index.ts`**
Review lines 185-215 of `apps/server/src/index.ts`.

- [ ] **Step 2: Implement dynamic candle bucket resolution in `index.ts`**
Ensure that when a markPrice event arrives, `latestCandle` reflects the updated high, low, and close for the current candle period instead of an empty zero-volume fallback.

- [ ] **Step 3: Run backend test suite**
Run: `npm --prefix apps/server test`

- [ ] **Step 4: Commit**
```bash
git add apps/server/src/index.ts
git commit -m "fix(server): align mark price tick broadcast with live candle buckets"
```

---

### Task 3: TopBar Testnet Environment Badge & Real Balance Display

**Files:**
- Modify: `apps/web/src/components/TopBar.tsx:50-120`

**Interfaces:**
- Consumes: `useMarketStore.account`, `useMarketStore.brokerMode`, `useMarketStore.exchangeHealth`
- Produces: Visual clarity badge ("BINANCE TESTNET") with formatted wallet balance and tooltips.

- [ ] **Step 1: Inspect `TopBar.tsx` current balance rendering**
Locate balance and broker mode indicators.

- [ ] **Step 2: Enhance `TopBar.tsx`**
Add an explicit badge showing `BINANCE FUTURES DEMO` (or `LOCAL PAPER`), format `walletBalance` as `$4,960.90 USDT`, and add a title/tooltip explaining that this is a simulated sandbox isolated from the live mobile app.

- [ ] **Step 3: Build web app and verify clean compilation**
Run: `npm --prefix apps/web run build`

- [ ] **Step 4: Commit**
```bash
git add apps/web/src/components/TopBar.tsx
git commit -m "feat(ui): add clear Binance Testnet environment badge and formatted balance"
```

---

### Task 4: End-to-End Verification of Order Placement on Testnet

**Files:**
- Test / Verify: `apps/server/src/services/tradeManager.ts`, `apps/server/src/exchange/binanceDemoAdapter.ts`

**Interfaces:**
- Consumes: 24-character client order IDs (`tos_<16hex>_ent`)
- Produces: Successful order creation on `testnet.binancefuture.com` without client order ID length error.

- [ ] **Step 1: Run comprehensive monorepo test suite**
Run: `npm test` across the monorepo.
Expected: 14 test files, 175+ tests passing.

- [ ] **Step 2: Run a live integration verification script**
Send an authenticated REST probe to `/api/state` and `/api/order/preview` to verify balance ($4,960.90) and order calculation.

- [ ] **Step 3: Commit final verification**
```bash
git commit --allow-empty -m "chore: verify live testnet integration and chart synchronization"
```
