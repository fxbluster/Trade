# Multi-Symbol Autonomous Auto-Pilot Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Monitor `SOLUSDT`, `BTCUSDT`, `ETHUSDT`, and `XRPUSDT` in parallel with isolated per-symbol quantitative state and enter the first qualifying setup under a strict global 1-open-position and 10-daily-trade cap.

**Architecture:** Wrap per-symbol stateful engines (`CvdEngine`, `NoiseBandEngine`, `AlphaRegistry` + 7 factors, `ConfluenceEngine`) inside a `SymbolQuantRegistry` keyed by uppercase symbol, while sharing symbol-keyed/stateless subsystems (`HierarchicalMtfManager`, `NativeSmcEngine`, `SentimentHarvester`, `EconomicEventGuard`, `TradeManager`). Route multiplexed WebSocket/REST streams in `index.ts` by `event.symbol`, cache 15m VWAP per symbol, and enforce cross-symbol `openTrade` / `LIMIT_CHASING` guards and a global daily trade cap in `AutoPilotManager`.

**Tech Stack:** TypeScript (ESM NodeNext, Node 24), Vitest, Polka, `ws`, `node:sqlite`.

**Spec:** `C:\Users\HP\.gemini\antigravity\brain\f118e799-662c-474b-b92a-67a6cc893f4b\design_draft.md`

## Global Constraints

- Default watchlist is `['SOLUSDT', 'BTCUSDT', 'ETHUSDT', 'XRPUSDT']`, overridable via `AUTOPILOT_SYMBOLS` comma-separated env var.
- Global 1-open-position cap across all watched symbols (`AutoPilotManager` `PLACING_ORDER` mutex + `TradeManager` global pre-trade mutex).
- Global `maxDailyTrades` cap (`10`) across all watched symbols combined (not per-symbol).
- Windows shell constraint: execute all `npm`/`vitest`/`git` commands via `run_workflow` with `Cwd: "D:\\Antigravity_Projects\\Active_Projects\\TradeOS-v2"` (`run_command` fails on UNC path).
- Do not break existing single-symbol constructor defaults or existing unit tests.

## Review Focus

1. **`parseWatchlistSymbols` malformed input** — empty strings, whitespace-only, lowercase (`btcusdt, solusdt`), or duplicate entries (`SOLUSDT,SOLUSDT`) must normalize cleanly and fall back to `DEFAULT_AUTOPILOT_SYMBOLS` when empty (pinned in Task 1).
2. **Cross-symbol `onTick` during `POSITION_OPEN` or `LIMIT_CHASING`** — an incoming `BTCUSDT` tick while `ETHUSDT` is open or chasing must immediately `return` without touching `manageOpenPosition`, `WATCHDOG_STOP_LOSS`, or `PropFirmRiskGuard` (pinned in Task 2).
3. **Global daily trade cap across 4 symbols** — `maxDailyTrades: 2` with 1 filled `SOLUSDT` trade and 1 filled `ETHUSDT` trade must block a 3rd entry on `BTCUSDT` (pinned in Task 2).
4. **Non-primary symbol REST query & open-position chart switching** — `GET /api/confluence?symbol=BTCUSDT` must return `BTCUSDT` while `activeSymbol` is `SOLUSDT`, and `POST /api/symbol` switching between watchlist symbols must succeed even when a trade is open (pinned in Task 3).
5. **Non-destructive `switchActiveSymbol`** — switching the UI chart from `SOLUSDT` to `BTCUSDT` must not unsubscribe `SOLUSDT` or wipe warmed `CvdEngine`/`NoiseBandEngine`/`ConfluenceEngine` state (pinned in Task 4).

---

### Task 1: `SymbolQuantRegistry` & Watchlist Parser

**Files:**
- Create: `apps/server/src/quant/symbolQuantRegistry.ts`
- Test: `apps/server/src/quant/__tests__/symbolQuantRegistry.test.ts`

**Interfaces:**
- Consumes: `HierarchicalMtfManager`, `NativeSmcEngine`, `SentimentHarvester`, `EconomicEventGuard`, `AlphaRegistry`, `ConfluenceEngine`, `CvdEngine`, `NoiseBandEngine`, `DatabaseSync`.
- Produces:
  - `DEFAULT_AUTOPILOT_SYMBOLS: readonly string[]`
  - `parseWatchlistSymbols(envVal?: string): string[]`
  - `SymbolQuantContext` (`{ symbol: string; cvdEngine: CvdEngine; noiseBandEngine: NoiseBandEngine; alphaRegistry: AlphaRegistry; confluenceEngine: ConfluenceEngine }`)
  - `SymbolQuantRegistry` (`getOrCreate(symbol)`, `get(symbol)`, `getAll()`, `getLatestSnapshot(symbol)`, `setConsensusThreshold(threshold)`, `applyCalibratedWeights(weights)`, `initializeAll(db)`)

- [ ] **Step 1: Write failing tests in `apps/server/src/quant/__tests__/symbolQuantRegistry.test.ts`**

```ts
import { describe, it, expect } from 'vitest';
import {
  DEFAULT_AUTOPILOT_SYMBOLS,
  parseWatchlistSymbols,
  SymbolQuantRegistry,
} from '../symbolQuantRegistry.js';

describe('parseWatchlistSymbols & SymbolQuantRegistry', () => {
  it('parses, uppercases, trims, deduplicates, and falls back to DEFAULT_AUTOPILOT_SYMBOLS', () => {
    expect(parseWatchlistSymbols(undefined)).toEqual(DEFAULT_AUTOPILOT_SYMBOLS);
    expect(parseWatchlistSymbols('   ')).toEqual(DEFAULT_AUTOPILOT_SYMBOLS);
    expect(parseWatchlistSymbols(' btcusdt, ethusdt , BTCUSDT, solusdt ')).toEqual([
      'BTCUSDT',
      'ETHUSDT',
      'SOLUSDT',
    ]);
  });

  it('isolates CvdEngine, OrderFlowEngine, NoiseBandEngine, and AlphaRegistry per symbol', () => {
    const registry = new SymbolQuantRegistry({});
    const sol = registry.getOrCreate('SOLUSDT');
    const btc = registry.getOrCreate('BTCUSDT');

    expect(sol.cvdEngine).not.toBe(btc.cvdEngine);
    expect(sol.noiseBandEngine).not.toBe(btc.noiseBandEngine);
    expect(sol.alphaRegistry).not.toBe(btc.alphaRegistry);
    expect(sol.confluenceEngine).not.toBe(btc.confluenceEngine);

    const now = Date.now();
    btc.cvdEngine.processTrade(50_000, false, now);
    btc.confluenceEngine.orderFlowEngine.processTrade(50_000, false, now, 95_000);
    btc.confluenceEngine.orderFlowEngine.updateDepth([[95_000, 100]], [[95_010, 10]]);

    expect(sol.cvdEngine.getSnapshot().delta).toBe(0);
    expect(sol.confluenceEngine.orderFlowEngine.getDepth().bids.length).toBe(0);
    expect(btc.cvdEngine.getSnapshot().delta).toBeGreaterThan(0);
  });

  it('propagates consensusThreshold across all symbol contexts', () => {
    const registry = new SymbolQuantRegistry({});
    const sol = registry.getOrCreate('SOLUSDT');
    const eth = registry.getOrCreate('ETHUSDT');
    registry.setConsensusThreshold(65);
    expect(sol.confluenceEngine.getConsensusThreshold()).toBe(65);
    expect(eth.confluenceEngine.getConsensusThreshold()).toBe(65);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run apps/server/src/quant/__tests__/symbolQuantRegistry.test.ts` (via `run_workflow`)
Expected: FAIL with module not found `../symbolQuantRegistry.js`

- [ ] **Step 3: Implement `apps/server/src/quant/symbolQuantRegistry.ts`**

Create `SymbolQuantRegistry` with:
- `DEFAULT_AUTOPILOT_SYMBOLS = ['SOLUSDT', 'BTCUSDT', 'ETHUSDT', 'XRPUSDT']`
- `parseWatchlistSymbols(envVal?: string): string[]`
- `SymbolQuantRegistry` constructor taking optional shared `{ mtfManager?, smcEngine?, sentimentHarvester?, economicEventGuard? }` (creating defaults if omitted so tests stay lightweight).
- `getOrCreate(symbol: string): SymbolQuantContext`: instantiates per-symbol `CvdEngine(sym)`, `NoiseBandEngine()`, `AlphaRegistry()` (registering all 7 factors: `OrderFlowFactor`, `NativeSmcFactor`, `CvdAbsorptionFactor`, `MacroRegimeFactor`, `FundingArbitrageFactor`, `CrossExchangeSweepFactor`, `LiqClustersFactor`), and `ConfluenceEngine({ mtfManager, smcEngine, sentimentHarvester, economicEventGuard, noiseBandEngine, alphaRegistry })`.
- `async initializeAll(db: DatabaseSync): Promise<void>` calling `ctx.alphaRegistry.initialize(db)` on all registered contexts.
- `get(symbol)`, `getAll()`, `getLatestSnapshot(symbol)`, `setConsensusThreshold(threshold)`, `applyCalibratedWeights(weights)`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run apps/server/src/quant/__tests__/symbolQuantRegistry.test.ts`
Expected: PASS (3/3 tests, EXIT 0)

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/quant/symbolQuantRegistry.ts apps/server/src/quant/__tests__/symbolQuantRegistry.test.ts
git commit -m "feat(quant): add SymbolQuantRegistry for isolated per-symbol quant state"
```

---

### Task 2: `AutoPilotManager` Multi-Symbol Guards & Global Daily Cap

**Files:**
- Modify: `apps/server/src/services/autoPilotManager.ts`
- Test: `apps/server/src/services/__tests__/autoPilotManager.test.ts`

**Interfaces:**
- Consumes: `SymbolQuantContext` from Task 1 (`apps/server/src/quant/symbolQuantRegistry.ts`).
- Produces:
  - Extended `AutoPilotManagerOptions` with optional `getSymbolQuantContext?: (symbol: string) => SymbolQuantContext | undefined`, `forEachQuantContext?: (cb: (ctx: SymbolQuantContext) => void) => void`, `watchlistSymbols?: string[]`.
  - Updated `getStatusPayload()` returning optional `watchlistSymbols`.

- [ ] **Step 1: Write failing tests in `apps/server/src/services/__tests__/autoPilotManager.test.ts`**

Add 3 tests inside the `describe` block:
1. `'enters ETHUSDT when SOLUSDT is WAIT and ETHUSDT qualifies, and ignores BTCUSDT ticks while ETHUSDT is open or LIMIT_CHASING'` — verifies `onTick('BTCUSDT', 95000)` does NOT trigger `manageOpenPosition` (`closePosition`) or a second `openOrder` while `ETHUSDT` is open (`openTradeId` set) or during `LIMIT_CHASING` (`activeEntryContext.symbol === 'ETHUSDT'`).
2. `'enforces global maxDailyTrades across all symbols combined'` — seeds 1 filled `SOLUSDT` trade and 1 filled `ETHUSDT` trade in SQLite, sets `maxDailyTrades: 2`, and verifies `onTick('BTCUSDT', ...)` is blocked with `SESSION_CAP_REACHED` (`FILLED_TODAY: 2`).

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run apps/server/src/services/__tests__/autoPilotManager.test.ts`
Expected: FAIL (`BTCUSDT` triggers false `manageOpenPosition` or bypasses `maxDailyTrades: 2`)

- [ ] **Step 3: Update `apps/server/src/services/autoPilotManager.ts`**

1. Add `getSymbolQuantContext`, `forEachQuantContext`, and `watchlistSymbols` fields to `AutoPilotManagerOptions` and `AutoPilotManager`.
2. In `constructor` & `updateConfig`: propagate `consensusThreshold` via `this.forEachQuantContext?.((ctx) => ctx.confluenceEngine.setConsensusThreshold(this.config.consensusThreshold))` in addition to `this.confluenceEngine`.
3. In `onTick(symbol, markPrice)`:
   - Normalize `const sym = symbol.toUpperCase().trim();`.
   - If `this.openTradeId`: look up `const openTrade = this.tradesRepo.getById(this.openTradeId);`. If `openTrade && openTrade.symbol !== sym`, `return;` immediately!
   - If `!this.openTradeId && this.state !== 'IDLE'`: if `this.activeEntryContext && this.activeEntryContext.symbol !== sym`, `return;` immediately!
4. Add private helper `private getConfluenceForSymbol(symbol: string): ConfluenceEngine { return this.getSymbolQuantContextFn?.(symbol)?.confluenceEngine ?? this.confluenceEngine; }` and use it in `onTick`, `manageOpenPosition`, `evaluateEntry` (including `orderFlowEngine` / `liquidationEngine`), and chasing callbacks.
5. At `tradesRepo.getFilledTradeCountToday(...)`: pass `undefined` for `symbol` (`this.tradesRepo.getFilledTradeCountToday(this.broker.mode, undefined, tradeCountStartMs)`) so `maxDailyTrades` is global.
6. In `getStatusPayload()`: include `...(this.watchlistSymbols ? { watchlistSymbols: this.watchlistSymbols } : {})`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run apps/server/src/services/__tests__/autoPilotManager.test.ts`
Expected: PASS (all tests including new multi-symbol & global cap tests, EXIT 0)

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/services/autoPilotManager.ts apps/server/src/services/__tests__/autoPilotManager.test.ts
git commit -m "feat(autopilot): enforce cross-symbol tick guards and global daily trade cap"
```

---

### Task 3: `routes.ts` Per-Symbol Context & Non-Blocking Chart Switch

**Files:**
- Modify: `apps/server/src/api/routes.ts`
- Test: `apps/server/src/api/__tests__/routes.test.ts`

**Interfaces:**
- Consumes: `ConfluenceSnapshot`, `CvdSnapshot`, `ConfluenceEngine` from `SymbolQuantRegistry`.
- Produces: Extended `AppContext` (`getConfluenceSnapshot?`, `getCvdSnapshot?`, `getConfluenceEngine?`, `watchlistSymbols?`), per-symbol `GET /api/confluence`, `GET /api/state`, `POST /api/webhook`, and watchlist-safe `POST /api/symbol`.

- [ ] **Step 1: Write failing tests in `apps/server/src/api/__tests__/routes.test.ts`**

Add 2 tests:
1. `'GET /api/confluence?symbol=BTCUSDT reads from getConfluenceSnapshot even when activeSymbol is SOLUSDT'`
2. `'POST /api/symbol allows switching between watchlistSymbols when a trade is open, while still blocking non-watchlist switches'`

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run apps/server/src/api/__tests__/routes.test.ts`
Expected: FAIL (`POST /api/symbol` returns `409 OPEN_POSITION_EXISTS`, `GET /api/confluence` ignores `getConfluenceSnapshot`)

- [ ] **Step 3: Update `apps/server/src/api/routes.ts`**

1. Extend `AppContext` with `getConfluenceSnapshot?: (symbol: string) => ConfluenceSnapshot | null`, `getCvdSnapshot?: (symbol: string) => CvdSnapshot | null`, `getConfluenceEngine?: (symbol: string) => ConfluenceEngine | undefined`, `watchlistSymbols?: string[]`.
2. In `GET /api/state`: read `ctx.getCvdSnapshot?.(symbol) ?? ctx.cvdEngine?.getSnapshot() ?? ...`.
3. In `GET /api/confluence`: read `ctx.getConfluenceSnapshot?.(symbol) ?? ctx.confluenceEngine?.getSnapshot(symbol)`.
4. In `POST /api/webhook`: resolve `const targetEngine = ctx.getConfluenceEngine?.(payload.symbol) ?? ctx.confluenceEngine;`.
5. In `POST /api/symbol`: allow switch if `ctx.watchlistSymbols?.includes(requestedSymbol)` even when `activePos` is open; keep `409 OPEN_POSITION_EXISTS` for non-watchlist symbols.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run apps/server/src/api/__tests__/routes.test.ts`
Expected: PASS (all tests including new multi-symbol route tests, EXIT 0)

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/api/routes.ts apps/server/src/api/__tests__/routes.test.ts
git commit -m "feat(api): route confluence, state, webhook, and watchlist symbol switch per symbol"
```

---

### Task 4: Wire `SymbolQuantRegistry` & Staggered 4-Symbol Streams in `index.ts`

**Files:**
- Modify: `apps/server/src/index.ts`

**Interfaces:**
- Consumes: `SymbolQuantRegistry`, `parseWatchlistSymbols` (Task 1), `AutoPilotManager` multi-symbol options (Task 2), `AppContext` extensions (Task 3).

- [ ] **Step 1: Update `apps/server/src/index.ts`**

1. Parse `const watchlistSymbols = parseWatchlistSymbols(process.env.AUTOPILOT_SYMBOLS);` and `const watchlistSet = new Set(watchlistSymbols);`.
2. Instantiate `const symbolQuantRegistry = new SymbolQuantRegistry({ mtfManager, smcEngine, sentimentHarvester, economicEventGuard });`, initialize `watchlistSymbols` via `await symbolQuantRegistry.initializeAll(db)` (pre-creating all watchlist contexts). Keep `activeSymbol` defaulting to `watchlistSymbols[0] || 'SOLUSDT'`.
3. Maintain `const vwap15mMap = new Map<string, number>();`.
4. Update `buildCockpitState(symbol)`: read `cvdEngine` from `symbolQuantRegistry.getOrCreate(symbol).cvdEngine`.
5. Update `switchActiveSymbol(nextSymbol)`: if `watchlistSet.has(prevSymbol)`, do NOT call `streamsManager.unsubscribeSymbol(prevSymbol)`. If `watchlistSet.has(nextSymbol)` and `candleHistoryMap.has(nextSymbol)`, do NOT call `.reset()` on `mtfManager`/`smcEngine`/`cvdEngine`/`confluenceEngine` and do NOT re-prewarm; simply update `activeSymbol = nextSymbol` and broadcast `SNAPSHOT` for `nextSymbol`.
6. Update `autoPilotManager` constructor & `onStateTransition`: pass `getSymbolQuantContext: (s) => symbolQuantRegistry.get(s)`, `forEachQuantContext: (cb) => symbolQuantRegistry.getAll().forEach(cb)`, `watchlistSymbols`, and update `strategyDecayEngine.flushPendingWeightsIfIdle` to call `symbolQuantRegistry.applyCalibratedWeights(w)`.
7. Update `streamsManager` listeners:
   - `onMarkPrice`: process **all** `watchlistSet.has(sym)` (or `sym === activeSymbol`), evaluate `symbolQuantRegistry.getOrCreate(sym).confluenceEngine.evaluate(...)` using cached `vwap15mMap.get(sym) ?? event.markPrice`, call `autoPilotManager.onTick(sym, event.markPrice)`, and only call `wsHub.broadcastTick` / `wsHub.broadcastConfluence` when `sym === activeSymbol`.
   - `onKline`: process all `watchlistSet.has(sym)`, update `vwap15mMap` and `ctx.noiseBandEngine.loadKlines(closedCandles)` on `15m`, run `ctx.alphaRegistry.onCandleClosed(event.candle, interval)` on closed candles, and read `symbolQuantRegistry.getLatestSnapshot(sym)` for `strategyDecayEngine` on `1m` close.
   - `onAggTrade`: route `event.symbol` to `ctx.cvdEngine` and `ctx.confluenceEngine.orderFlowEngine`.
   - `onDepth`: route `event.symbol` to `ctx.confluenceEngine.orderFlowEngine`.
8. Update `streamsManager.start(watchlistSymbols)` and boot preloader loop over `watchlistSymbols` with `250ms` stagger per symbol (`200` `1m`, `1000` `15m`, `200` `1h`, `20` `depth`), computing initial `vwap15mMap.set(sym, ctx.noiseBandEngine.calculateVWAP(candles15m))`.
9. Pass `getConfluenceSnapshot`, `getCvdSnapshot`, `getConfluenceEngine`, and `watchlistSymbols` to `registerRoutes(...)`.

- [ ] **Step 2: Run full build and full test suite**

Run: `npm run build` and `npm test` (via `run_workflow`, `Cwd: "D:\\Antigravity_Projects\\Active_Projects\\TradeOS-v2"`)
Expected: `npm run build` `EXIT 0`, `npm test` `64/64` test files passed, `0` failed, `EXIT 0`.

- [ ] **Step 3: Commit, push via SSH, and verify Railway deployment**

```bash
git add apps/server/src/index.ts
git commit -m "feat(server): wire 4-symbol multiplexed streams, staggered boot, and VWAP cache"
git push origin master
```
Verify Railway deploy reaches `[SUCCESS]` and `GET /api/confluence?symbol=SOLUSDT`, `BTCUSDT`, `ETHUSDT`, `XRPUSDT` all return HTTP `200`.

---

## Self-Review Results

- **Spec coverage:** Every requirement in `design_draft.md` (per-symbol `SymbolQuantRegistry` + `AlphaRegistry`, `AutoPilotManager` `onTick` cross-symbol guard + global `maxDailyTrades`, non-destructive `switchActiveSymbol`, `POST /api/symbol` & `POST /api/webhook` routing, staggered `250ms` boot, `15m` VWAP cache, all 5 Review Focus test cases) maps directly to Tasks 1–4.
- **Type consistency:** `SymbolQuantContext`, `SymbolQuantRegistry`, `parseWatchlistSymbols`, `getSymbolQuantContext`, `forEachQuantContext`, `getConfluenceSnapshot`, `getCvdSnapshot`, `getConfluenceEngine`, and `watchlistSymbols` match identically across Tasks 1–4.
- **Proportion:** Concise task boundaries and exact interfaces; no transcript-length code dumps.
