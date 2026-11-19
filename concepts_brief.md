# TradeOS v2: 6-Pillar Confluence Engine, Autonomous Execution & PineScript v6 Integration

* **Author:** fxbluster
* **Date:** 2026-11-20
* **Status:** Step 1 - Brainstorming & Iterative Problem Drilling

## Overview

This proposal unifies the complete analytical and execution arsenal from TradeOS v1 into TradeOS v2. It defines:
1. **The 6 Institutional Confluence Pillars (Visual Status Cards):**
   - **Pillar 1 (MTF & Trend):** Multi-timeframe trend alignment (1m / 15m / 1h) via EMA 9/21/50/200 and ADX trend strength.
   - **Pillar 2 (Momentum & Volatility):** RSI 14, MACD histogram momentum, and dynamic ATR volatility bands.
   - **Pillar 3 (Order Flow Imbalance):** Real-time tick auction footprint and bid/ask volume aggression (>300% imbalance).
   - **Pillar 4 (CVD Divergence & Absorption):** Cumulative Volume Delta tracking spot vs perpetual absorption.
   - **Pillar 5 (Liquidation Magnet & Trajectory):** High-density short/long liquidation cluster proximity.
   - **Pillar 6 (Live News & NLP Sentiment):** CryptoPanic and RSS headlines parsed via VADER lexicon (-1.0 to +1.0).

2. **Dual-Mode Execution Architecture (Manual vs Auto-Pilot):**
   - **Manual Mode:** Visual cards indicate individual OK/WARNING status; entry requires holding the 400ms physical button with pre-calculated bracket SL/TP.
   - **Auto-Pilot Mode:** Triggers automated bracket entry (Limit or Market) when a configurable consensus threshold (e.g., >= 4 of 6 or >= 5 of 6 pillars) aligns, with algorithmic position lifecycle management (auto-breakeven migration, partial TP1 closure, trailing SL, and emergency stop).

3. **TradingView 822-Line PineScript v6 Indicator Integration:**
   - Incorporating Smart Money Concepts (SMC: Order Blocks, Breaker Blocks), Market Structure (BOS, CHoCH), and Fair Value Gaps (FVG).
   - Bi-directional webhook bridge (`POST /api/webhook`) with HMAC-SHA256 signature verification and replay defense.

## Critical Stress-Testing & System Contradictions

### 1. Whipsaw & Ranging Market Risk in Auto-Pilot
* *Flaw:* In sideways (ranging) markets, momentum oscillators (RSI/MACD) and trend indicators (EMA) frequently generate conflicting or late signals. An autonomous engine without strict consolidation filters will experience rapid consecutive stop-outs ("death by a thousand cuts").
* *Defense Requirement:* Auto-pilot must require ADX >= 25 (confirmed trend) or Order Flow Imbalance >= 2.5x before opening. It must enforce a strict circuit-breaker (e.g., maximum 2 consecutive losses or 5% session drawdown pauses auto-pilot for 60 minutes).

### 2. Execution Latency & Slippage Discrepancy
* *Flaw:* A webhook signal generated on TradingView takes 300ms–1500ms to reach the local server, validate, and execute on Binance. In fast volatile moves (SOL/BTC), market price can slip past the entry trigger.
* *Defense Requirement:* The system must calculate a maximum slippage threshold (e.g., 0.10%). If current mark price drifted beyond entry bounds, the order must be aborted rather than chased.

### 3. Asynchronous News Scraper Hangs
* *Flaw:* External public RSS feeds and CryptoPanic endpoints frequently timeout or throttle.
* *Defense Requirement:* Pillar 6 (NLP Sentiment) must operate as an isolated background cron task with a 3-minute staleness cache. Network timeouts must fail-soft to `NEUTRAL` (0.0) without stalling trade execution.

## Goals vs. Non-Goals

* **In-Scope Goals:**
  * Clean TypeScript implementation of all 6 mathematical calculation modules in `@tradeos/shared` and `apps/server/src/quant`.
  * Visual 6-Card Confluence HUD on the frontend displaying real-time Green (OK) / Red (Bear) / Gray (Neutral) statuses.
  * Deterministic Auto-Pilot state machine with hard risk limits: max 1 concurrent open position, strict 10x leverage, and mandatory bracket stops.
  * Modernized PineScript v6 indicator with clean alert payloads matching the server's webhook schema.

* **Out-of-Scope Non-Goals:**
  * Multi-position stacking or martingale averaging down.
  * Re-creating the obsolete Windows WPF/Electron overlay (all visuals live in the responsive web HUD).
  * Paid third-party data subscriptions.

## Alternatives Weighed

1. *All-or-Nothing Consensus (6 out of 6):* Rejected because markets rarely align all 6 disparate metrics simultaneously, resulting in zero trades executed.
2. *Uncapped Martingale Auto-Pilot:* Rejected as high risk. TradeOS strictly adheres to fixed fractional sizing (e.g., 5-10% margin).
3. *Direct Webhook Execution without Risk Validation:* Rejected. Every webhook must pass through `riskEngine.ts` and `validateOrderRisk`.

## Open Clarifications & Key Decision Points

1. Threshold requirement: How many pillars out of 6 must confirm before an auto-trade is allowed (4 of 6, or 5 of 6)?
2. Order type preference in Auto-Pilot: Should the engine use Maker Limit orders at Order Block / FVG levels to save fees, or Taker Market orders to ensure fills?
3. Position management: Should Auto-Pilot hold until TP/SL, or close early if the 6 pillars flip to the opposite direction?
