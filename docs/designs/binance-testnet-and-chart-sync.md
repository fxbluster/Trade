# Binance Futures Testnet & Real-Time Chart Synchronization Design Document

*   **Author:** HP / TradeOS Core Engineering
*   **Status:** Approved
*   **Date:** 2026-11-19

--------------------------------------------------------------------------------

## Overview

This technical design document specifies the architecture, data flow, and implementation requirements for synchronizing TradeOS v2 with Binance Futures Testnet (Demo) and localizing the real-time charting subsystem. It addresses the user environment disconnect between the Binance Mobile App and Binance Developer Testnet, hardens client order ID generation to comply with Binance's 36-character constraint, localizes the candlestick chart timescale to the user's local timezone (Baku UTC+4), and establishes 4Hz intra-candle tick streaming so candles update second-by-second in real time.

--------------------------------------------------------------------------------

## The Problem

1.  **Environment Mismatch & Invisible Balance:**
    Users configuring API keys generated on `testnet.binancefuture.com` expect those balances and orders to appear in their phone's Binance mobile app. In reality, Binance Developer Testnet is a completely segregated sandbox with mock assets (e.g. 4,960.89 USDT). Mainnet keys fail on Testnet (`HTTP 401`), and Testnet orders never sync to the mobile app. The UI lacks explicit environment badging, causing severe confusion.

2.  **Order Placement Length Rejection:**
    Binance Futures API restricts `newClientOrderId` to a maximum of 36 characters. Previous TradeOS implementations generated strings of the form `tos_${crypto.randomUUID()}_ent` (44 characters), causing the exchange to reject orders with:
    `Client order id length should be less than 36 chars`.

3.  **Chart Timezone Desynchronization:**
    Binance kline endpoints and streams index candles using UTC epoch timestamps. Lightweight Charts renders timestamps on the horizontal axis in UTC by default. For users in Baku (UTC+4), candles appear 4 hours behind system wall-clock time (e.g., 15:10 displayed at 19:10). Furthermore, mark-price tick updates were not updating the current candle's high, low, and close dynamically, making the chart feel frozen.

--------------------------------------------------------------------------------

## Goals

*   **Goal 1 (Verified Testnet Balance):** Display live, verified Binance Testnet balances ($4,960.90 USDT) in the cockpit TopBar and ensure `/api/state` returns accurate equity.
*   **Goal 2 (Compliant Order Placement):** Ensure all orders sent to `testnet.binancefuture.com` use deterministic client order IDs strictly <= 36 characters (24 characters: `tos_<16hex>_ent`).
*   **Goal 3 (Local Timezone Formatting):** Localize the chart timescale to the browser's local timezone (Baku UTC+4) using `localization.timeFormatter` without mutating underlying UTC epoch numbers.
*   **Goal 4 (Real-Time Intra-Candle Animation):** Update the rightmost candlestick at up to 4Hz with incoming mark-price ticks, dynamically adjusting `high`, `low`, and `close`.
*   **Goal 5 (Zero Regressions):** Maintain 100% pass rate across the 14-file, 175-test monorepo test suite.

--------------------------------------------------------------------------------

## Non-Goals

*   **Non-Goal 1:** Connecting to Binance Mainnet with real capital is strictly out of scope for this release.
*   **Non-Goal 2:** Multi-exchange routing (e.g., Bybit, OKX, Hyperliquid) is out of scope.
*   **Non-Goal 3:** Arbitrary local timestamp rewriting inside SQLite or backend domain contracts.

--------------------------------------------------------------------------------

## Open Questions

*   **Question 1 (Resolved):** *Are the user's API keys for Mainnet or Testnet?*
    **Resolution:** Probed both endpoints with the configured keys (`OpsI...`). Testnet returned `HTTP 200` with 4,960.89 USDT, while Mainnet returned `HTTP 401`. The keys are verified Testnet keys.
*   **Question 2 (Resolved):** *Should chart time modification be done on the server or client?*
    **Resolution:** Exclusively on the client via `timeFormatter`. Modifying raw Unix epoch seconds on the server breaks exchange signature calculations, candle intervals, and caching.

--------------------------------------------------------------------------------

## Critical User Journeys (CUJs)

### CUJ 1: Observing Live Market & Local Chart Time

*   **Given**: User opens TradeOS cockpit at `http://127.0.0.1:3400` in Baku (UTC+4).
*   **When**: The application loads the active symbol (`SOLUSDT`) and connects to WebSocket.
*   **Then**: The chart timescale displays timestamps matching the user's local clock (e.g., `19:25`), and price fluctuations immediately update the current candle wick and body.

### CUJ 2: Placing Entry & Bracket Order on Binance Demo

*   **Given**: User selects leverage (e.g., 5x), enters margin ($50), sets Stop Loss, and holds "HOLD TO SHORT" for 400ms.
*   **When**: Frontend dispatches `POST /api/orders/open` with order parameters.
*   **Then**: Backend generates a 24-character `clientOrderId`, validates risk, submits the order to `testnet.binancefuture.com`, registers bracket orders, and updates the UI without length errors.

### CUJ 3: Inspecting Account Balance & Environment Badge

*   **Given**: User views the TopBar header.
*   **When**: The page renders.
*   **Then**: A prominent amber/green badge reads `BINANCE DEMO (TESTNET)` alongside wallet balance `$4,960.90 USDT`, with a tooltip clarifying isolation from the real mobile app.

--------------------------------------------------------------------------------

## Technical Plan (Architecture)

### Architectural Decisions

1.  **Client-Side Timescale Localization (`ChartCanvas.tsx`):**
    Lightweight Charts chart creation options configure `localization.timeFormatter` and `timeScale.tickMarkFormatter` using `Intl.DateTimeFormat` with `timeZone: 'Asia/Baku'`. This leaves candle series data strictly in standard UTC epoch seconds while presenting the user's wall-clock time on the chart axis.

2.  **Intra-Candle Tick Aggregation (`ChartCanvas.tsx` & `index.ts`):**
    When WebSocket tick arrives with a live price `p`:
    - If `p > candle.high`, set `candle.high = p`.
    - If `p < candle.low`, set `candle.low = p`.
    - Set `candle.close = p`.
    The candle series updates via `candleSeries.update(candle)` at 4Hz, providing smooth second-by-second movement.

3.  **Deterministic 24-Character Client Order ID (`tradeManager.ts`):**
    `tos_<16hex>_ent` (24 characters), well below Binance's 36-character maximum.

--------------------------------------------------------------------------------

## Verification Plan

*   **Compilation/Build:**
    - Backend: `npm --prefix apps/server run build` -> Clean exit 0
    - Frontend: `npm --prefix apps/web run build` -> Clean exit 0
*   **Unit & Integration Tests:**
    - Run monorepo test suite: `npm test` across all 14 test suites (177 tests passing).
*   **Live E2E Verification:**
    - `http://127.0.0.1:3400/api/health` -> `{'ok': True, 'exchangeHealth': 'HEALTHY', 'brokerMode': 'BINANCE_DEMO'}`
    - `http://127.0.0.1:3400/api/state` -> `Account: {'walletBalance': 4960.898..., 'currency': 'USDT'}`

--------------------------------------------------------------------------------

*Drafted and verified with EGM & Superpowers*
