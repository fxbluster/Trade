# Upcomers $50K Challenge Remediation & Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remediate the four Upcomers $50K Challenge defects (cycle rollover deadlock, phantom `PASSED` on unrealized profit, HUD dollar truncation + mixed-language top-up banner, and missing `?format=markdown` certificate export) alongside crash-safe realized-PnL tracking, 4Hz close-error recovery, and multi-cycle Auto-Pilot continuity.

**Architecture:** Persist `realized_pnl_usd` separately from live `net_pnl_usd` in SQLite and execute transactional cycle rollovers via `PropFirmRepo.rolloverCycle()` (`BEGIN IMMEDIATE`). Require two-phase target-hit settlement (`PROPFIRM_TARGET_REACHED` cushioned by ~5 bps estimated close fee -> centralized `TradeManager` close hook -> idempotent `recordTradeClosed()` -> `PASSED`), add `POST /api/propfirm/new-cycle` + `?format=markdown` export, and rebalance `PropFirmChallengeHUD.tsx` into unclipped 2-row cards with an Azerbaijani top-up banner and clickable Binance Demo Faucet link.

**Tech Stack:** TypeScript (`@tradeos/shared`, Polka HTTP/WebSocket server, `node:sqlite`), React 18 + Zustand + Tailwind CSS (`apps/web`), Vitest (`jsdom` + Node).

**Spec:** [design_draft.md](file:///C:/Users/HP/.gemini/antigravity/brain/7a2ce988-d260-48e7-a50a-20e8f26d0277/design_draft.md) (Approved `2026-11-25`)

## Global Constraints

- Upcomers limits remain fixed: `$50,000` starting equity, `+$2,500` profit target (`$52,500`), `-$1,500` contractual / `-$1,250` internal daily halt, `-$3,000` contractual / `-$2,500` internal trailing halt (`$50,000` floor lock at `$53,000` HWM), `$250` per-trade Stop-Loss clamp.
- Never format negative USD as `$-XX.XX`; always format as `-$XX.XX` (verified in Markdown export and React HUD).
- Protected endpoints (`POST /api/propfirm/new-cycle`, `GET /api/propfirm/certificate`, `POST /api/symbol`) remain behind `validateHost`, `validateOrigin`, and `requireSessionToken`.
- Manual `OrderTicket` entries (`TradeManager.openPosition()`) are not blocked or risk-clamped by `PropFirmRiskGuard`; `index.ts` does not auto-close manual trades.
- External links MUST include `target="_blank" rel="noopener noreferrer"`; collapsed HUD height at `1280×768` stays `<= 116px` (`<= 148px` with top-up banner), `ChartCanvas >= 220px`, `scrollWidth <= clientWidth`.
- Preserve existing UI test substrings in `PropFirmChallengeHUD.test.tsx` (`Hədəf: +$2,500.00`, `Gündəlik Zərər Həddi: $1,250.00`, `Maksimum Geriləmə Həddi: $2,500.00`, `Qalan Haqq:`).

## Review Focus

1. **Double-counting unrealized PnL on server crash/restart:** Restarting while a trade has `+$500` floating profit previously seeded `realizedCyclePnlByCycleId` from `netPnlUsd`, doubling unrealized equity on the next tick. Pinned in Task 2 test (`realizedPnlUsd` persistence across fresh `PropFirmRiskGuard` instantiation).
2. **Naked-position deadlock after transient Binance `closePosition()` failure:** `TradeManager.closePosition()` cancels SL/TP algos before submitting the close order; if the market close rejects, leaving `CLOSING_IN_PROGRESS` as a skip lock would strand a naked trade. Pinned in Task 3 test (rejected close restores active trade status and retries on the next tick).
3. **Target-hit closing taker fee (`~5 bps`) leaving post-close realized equity below `$52,500`:** Triggering at raw `+$2,500.00` without exit-fee buffer leaves `~$52,475 < $52,500`. Pinned in Task 2 (`estimatedCloseFeeUsd` cushion keeps `ACTIVE` at `+$2,505` with `$12` close fee, triggers `PROPFIRM_TARGET_REACHED` once cushion cleared) & Task 3 tests.
4. **Concurrent `POST /api/propfirm/new-cycle` & open-position / active-cycle races (`HTTP 409`):** Concurrent requests or open trades across any symbol must fail closed without creating duplicate `ACTIVE` cycles or clearing active trades. Pinned in Task 1 (`rolloverCycle` transaction) & Task 4 (`HTTP 409` route integration tests).
5. **Same-day Cycle #2 blocked by legacy `-$92.12` (`$4,606 * 2%`) Testnet cooldown or 180s lockout:** Passing Cycle #1 after small losses or multiple trades on a `$4,606.01` Testnet wallet would freeze Cycle #2 unless overridden/reset on rollover. Pinned in Task 3 test (`AutoPilotManager` allows Cycle #2 entry on `$4,606.01` wallet immediately after `clearPropFirmBlock()`).

---

### Task 1: Shared Domain Contracts & Transactional SQLite Schema (`PropFirmRepo`)

**Files:**
- Modify: `packages/shared/src/types.ts:9-33`
- Modify: `packages/shared/src/contracts.ts:920-939`
- Modify: `apps/server/src/db/sqlite.ts:181-205, 1806-2042`
- Test: `apps/server/src/quant/__tests__/propFirmRiskGuard.test.ts`

**Interfaces:**
- Produces (`@tradeos/shared`):
  - `ExitReason` includes `'PROPFIRM_TARGET_REACHED'`
  - `BlockReason` includes `'CYCLE_TERMINAL'`
  - `PropFirmChallengeCycle.realizedPnlUsd?: number`
- Produces (`apps/server/src/db/sqlite.ts`):
  - `PropFirmConflictError extends Error` (`code: 'OPEN_POSITION_EXISTS' | 'CYCLE_STILL_ACTIVE'`)
  - `PropFirmRepo.rolloverCycle(nextCycle: PropFirmChallengeCycle): PropFirmChallengeCycle`

- [ ] **Step 1: Write the failing test**

Add tests in `apps/server/src/quant/__tests__/propFirmRiskGuard.test.ts` for `PropFirmRepo`:
1. `rolloverCycle_rejectsOpenTrade`: inserts an `'OPEN'` row into `trades` for `'BTCUSDT'` while latest cycle is `'PASSED'`, calls `repo.rolloverCycle(nextCycle)` and asserts it throws `PropFirmConflictError` with `code === 'OPEN_POSITION_EXISTS'` and leaves only 1 cycle row.
2. `rolloverCycle_rejectsActiveAndDailyHaltAndFinalizesTrailingHalt`: verifies `'ACTIVE'` and `'HALTED_DAILY_BUFFER'` throw `PropFirmConflictError` with `code === 'CYCLE_STILL_ACTIVE'`, whereas `'HALTED_TRAILING_BUFFER'` transitions to `'FAILED_TRAILING'` with non-null `closedAt` in the same transaction as inserting Cycle `N+1` with `realizedPnlUsd: 0`.
3. `realizedPnlUsd_columnPersistsSeparatelyFromNetPnl`: creates a cycle, patches `netPnlUsd: 500` and `realizedPnlUsd: 100`, reloads via `repo.getActiveCycle()` and asserts `realizedPnlUsd === 100` while `netPnlUsd === 500`.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run apps/server/src/quant/__tests__/propFirmRiskGuard.test.ts`
Expected: FAIL (`PropFirmConflictError` / `rolloverCycle` / `realizedPnlUsd` not defined).

- [ ] **Step 3: Update shared types, SQLite migration, and `PropFirmRepo.rolloverCycle`**

1. In `packages/shared/src/types.ts`, add `'PROPFIRM_TARGET_REACHED'` to `ExitReason` and `'CYCLE_TERMINAL'` to `BlockReason`.
2. In `packages/shared/src/contracts.ts`, add `realizedPnlUsd?: number;` to `PropFirmChallengeCycle`.
3. In `apps/server/src/db/sqlite.ts`:
   - Add `realized_pnl_usd REAL NOT NULL DEFAULT 0` to `PROPFIRM_SCHEMA_DDL` and idempotent migration `try { db.exec('ALTER TABLE propfirm_challenge_cycles ADD COLUMN realized_pnl_usd REAL NOT NULL DEFAULT 0;'); } catch {}` in `ensurePropFirmSchema(db)`.
   - Map `realized_pnl_usd` in `PropFirmChallengeCycleRow`, `mapPropFirmCycleRow` (default `Number(row.realized_pnl_usd ?? 0)`), `PROPFIRM_CYCLE_PATCH_COLUMNS` (`{ key: 'realizedPnlUsd', column: 'realized_pnl_usd' }`), and `createCycle` `INSERT` (`normalized.realizedPnlUsd ?? 0`).
   - Export `PropFirmConflictError` and add `PropFirmRepo.rolloverCycle(nextCycle: PropFirmChallengeCycle): PropFirmChallengeCycle` wrapped in `runTransaction(this.db, ...)`:
     - Check `SELECT 1 FROM trades WHERE status IN ('OPEN', 'PARTIALLY_CLOSED', 'CLOSING', 'CLOSING_IN_PROGRESS') LIMIT 1` -> throw `PropFirmConflictError('OPEN_POSITION_EXISTS', 'Açıq mövqe və ya icra edilən əmr olduğu halda yeni dövrə başladılmır.')`.
     - Load latest cycle via `this.getLatestCycle()`; if status is `'ACTIVE'` or `'HALTED_DAILY_BUFFER'` -> throw `PropFirmConflictError('CYCLE_STILL_ACTIVE', 'Yeni dövrə yalnız cari dövrə PASSED, FAILED və ya HALTED_TRAILING_BUFFER olduqda başlana bilər.')`.
     - If latest cycle status is `'HALTED_TRAILING_BUFFER'`, call `this.updateCycle(latest.id, { status: 'FAILED_TRAILING', closedAt: nextCycle.startedAt })`.
     - Call `this.createCycle(nextCycle)` and return it.

- [ ] **Step 4: Run test and shared typecheck to verify pass**

Run: `npm --workspace=packages/shared run check && npx vitest run apps/server/src/quant/__tests__/propFirmRiskGuard.test.ts`
Expected: PASS (exit code 0).

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/types.ts packages/shared/src/contracts.ts apps/server/src/db/sqlite.ts apps/server/src/quant/__tests__/propFirmRiskGuard.test.ts
git commit -m "feat(propfirm): add shared target-exit/terminal types and transactional rolloverCycle with realized_pnl_usd"
```

---

### Task 2: Two-Phase `PROPFIRM_TARGET_REACHED` Fee-Cushioned Guard, Ledger Isolation & Markdown Formatter

**Files:**
- Modify: `apps/server/src/quant/propFirmRiskGuard.ts:15-688`
- Test: `apps/server/src/quant/__tests__/propFirmRiskGuard.test.ts`

**Interfaces:**
- Consumes: Task 1 (`ExitReason`, `PropFirmChallengeCycle.realizedPnlUsd`, `PropFirmRepo.rolloverCycle`, `PropFirmConflictError`)
- Produces (`apps/server/src/quant/propFirmRiskGuard.ts`):
  - `EvaluateLiveEquityParams` extended with `hasOpenPosition?: boolean; estimatedCloseFeeUsd?: number;`
  - `EvaluateLiveEquityResult.emergencyExitReason`: `'UPCOMERS_DAILY_HALT' | 'UPCOMERS_TRAILING_HALT' | 'PROPFIRM_TARGET_REACHED' | null`
  - `RecordTradeClosedParams` extended with `tradeId?: string;`
  - `PropFirmRiskGuard.startNewCycle(liveWalletBalanceUsd?: number, nowMs?: number): PropFirmStatusResponse` (delegates to `repo.rolloverCycle`)
  - `formatPropFirmCertificateMarkdown(cert: PropFirmCertificateResponse): string`

- [ ] **Step 1: Write the failing tests**

In `apps/server/src/quant/__tests__/propFirmRiskGuard.test.ts`, add specs verifying:
1. `evaluateLiveEquity_defersPassedWhenOpenAndAppliesFeeCushion`: with `$2,505` floating profit and `hasOpenPosition: true, estimatedCloseFeeUsd: 12` (`50_000 + 2505 - 12 = 52_493 < 52_500`), returns `status.cycle.status === 'ACTIVE'` and `emergencyExitReason === null`. At `$2,515` floating (`52_515 - 12 = 52_503 >= 52_500`), keeps `status.cycle.status === 'ACTIVE'`, `closedAt === null`, `cycleJustPassed === false`, and returns `emergencyExitReason === 'PROPFIRM_TARGET_REACHED'`. Drawdown halt checks still fire if equity subsequently drops before close settles.
2. `recordTradeClosed_idempotentAndCrashSafeRealizedPnl`: records `realizedNetPnlUsd: 2_503` with `tradeId: 't_1'` twice (second call with same `tradeId` is a no-op -> `tradesCount === 1`, `status === 'PASSED'`); separately verifies a crash-restart test where cycle has `netPnlUsd: 500, realizedPnlUsd: 0` before instantiating a new `PropFirmRiskGuard(repo)` — next `evaluateLiveEquity({ realizedCyclePnlUsd: guard2.getCurrentRealizedCyclePnl(), unrealizedPnlUsd: 500, liveWalletBalanceUsd: 50_000, hasOpenPosition: true })` yields `netPnlUsd === 500` (NOT `1000`). Also tests funded wallet (`55_000` stale cache) still computes `currentEquityUsd = 50_000 + realized + unrealized`.
3. `topUpMessage_localizedAndFormatMarkdown`: asserts `guard.getStatus(4_606.01).topUpMessage` is pure Azerbaijani containing `'Binance Demo Faucet'` and `'$50,000.00'`, and `formatPropFirmCertificateMarkdown(cert)` formats negative net PnL as `-$1,250.00` (zero `'$-'`), displays `X / 5`, and lists every cycle row in Markdown table format.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run apps/server/src/quant/__tests__/propFirmRiskGuard.test.ts`
Expected: FAIL (`formatPropFirmCertificateMarkdown` not exported, `PROPFIRM_TARGET_REACHED` missing, crash-restart test doubles floating PnL).

- [ ] **Step 3: Implement `PropFirmRiskGuard` updates and `formatPropFirmCertificateMarkdown`**

In `apps/server/src/quant/propFirmRiskGuard.ts`:
1. Replace `TOP_UP_MESSAGE` with:
   `'Binance Testnet balansı $50,000.00 həddindən aşağıdır. Simulyasiya $50,000.00 kapitala sabitlənib; real ölçülü test üçün Binance Demo Faucet vasitəsilə USDT balansını $50,000.00-ə tamamlayın.'`
2. Track `private readonly recordedTradeIds = new Set<string>();` on `PropFirmRiskGuard`.
3. In constructor and `getOrInitCycle()`, seed `realizedCyclePnlByCycleId` from `existing.realizedPnlUsd ?? 0` (when `existing.realizedPnlUsd !== undefined`, falling back only if legacy row with no open position: use `existing.realizedPnlUsd ?? existing.netPnlUsd` strictly when `existing.tradesCount > 0 && existing.realizedPnlUsd === undefined`, or default `0` for active rows — explicitly: seed `existing.realizedPnlUsd ?? 0` for newly migrated rows and persist `realizedPnlUsd: 0` on `createFreshCycle`).
4. In `computeChallengeEquityUsd()`: always return `round2(cycle.startingBalanceUsd + realizedCyclePnlUsd + unrealizedPnlUsd)`. Keep `liveWalletBalanceUsd < TOP_UP_THRESHOLD_USD` solely in `buildStatusResponse()` for `needsTopUp`.
5. In `evaluateLiveEquity()`:
   - Resolve `const positionOpen = params.hasOpenPosition ?? Math.abs(safeUnrealized) > 0;`.
   - Resolve `const safeCloseFee = positionOpen && Number.isFinite(params.estimatedCloseFeeUsd) ? Math.max(0, params.estimatedCloseFeeUsd!) : 0;`.
   - Widen local `let emergencyExitReason: EvaluateLiveEquityResult['emergencyExitReason'] = null;`.
   - Keep trailing & daily drawdown transitions first. In the `else if (nextStatus === 'ACTIVE' && currentEquityUsd - safeCloseFee >= cycle.startingBalanceUsd + cycle.profitTargetUsd)` branch:
     - If `positionOpen`: `emergencyExitReason = 'PROPFIRM_TARGET_REACHED'` (keep `nextStatus = 'ACTIVE'`, `cycleJustPassed = false`, `closedAt = null`).
     - Else: `nextStatus = 'PASSED'`, `cycleJustPassed = true`, `closedAt = closedAt ?? nowMs`.
6. In `recordTradeClosed()`:
   - If `params.tradeId` is set and `this.recordedTradeIds.has(params.tradeId)`, return `this.getStatus(params.liveWalletBalanceUsd, nowMs)`.
   - Add `params.tradeId` to `this.recordedTradeIds`.
   - Persist `realizedPnlUsd: nextRealized` alongside `tradesCount`, `winCount`, `lossCount` via `this.repo.updateCycle(...)`.
   - Call `this.evaluateLiveEquity({ realizedCyclePnlUsd: nextRealized, unrealizedPnlUsd: 0, liveWalletBalanceUsd: params.liveWalletBalanceUsd, hasOpenPosition: false, nowMs })`.
7. In `startNewCycle()`: construct `nextCycle` with `this.repo.getNextCycleNumber()` and `this.config` values (`realizedPnlUsd: 0`), pass to `this.repo.rolloverCycle(nextCycle)` (letting `PropFirmConflictError` propagate), set `realizedCyclePnlByCycleId.set(cycle.id, 0)`, initialize daily snapshot, emit WS update, return `status`. Re-export `PropFirmConflictError` from `propFirmRiskGuard.ts`.
8. Export `formatPropFirmCertificateMarkdown(cert: PropFirmCertificateResponse): string` using helper `formatSignedUsdMd(val)` (`val < 0 ? '-$' + absFormatted : (val > 0 ? '+$' + absFormatted : '$0.00')`) outputting title, certification badge (`TƏSDİQLƏNDİ` / `DAVAM EDİR`), streak (`X / 5`), remaining cycles, ISO timestamp, and Markdown cycles table.

- [ ] **Step 4: Run test to verify pass**

Run: `npx vitest run apps/server/src/quant/__tests__/propFirmRiskGuard.test.ts`
Expected: PASS (exit code 0).

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/quant/propFirmRiskGuard.ts apps/server/src/quant/__tests__/propFirmRiskGuard.test.ts
git commit -m "feat(propfirm): implement two-phase target close with fee cushion, crash-safe realized PnL, and markdown formatter"
```

---

### Task 3: Centralized `TradeManager` Settlement Hook, `AutoPilotManager` 4Hz Lock & Cycle Rollover Clear, and `index.ts` Wiring

**Files:**
- Modify: `apps/server/src/services/tradeManager.ts:45-105, 591-630, 1058-1112, 1275-1287` (and check `emergencyUnwindPosition`)
- Modify: `apps/server/src/services/autoPilotManager.ts:115-160, 535-650, 1309-1360, 1562-1629`
- Modify: `apps/server/src/index.ts:365-372, 540-557`
- Test: `apps/server/src/quant/__tests__/propFirmRiskGuard.test.ts`

**Interfaces:**
- Consumes: Task 1 (`BlockReason: 'CYCLE_TERMINAL'`, `ExitReason: 'PROPFIRM_TARGET_REACHED'`), Task 2 (`PropFirmRiskGuard` updated signatures)
- Produces:
  - `TradeManagerOptions.onTradeClosed?: (trade: TradeRecord) => void`
  - `AutoPilotManager.clearPropFirmBlock(): void`

- [ ] **Step 1: Write the failing tests**

Before editing `tradeManager.ts`, read `emergencyUnwindPosition` lines inside `apps/server/src/services/tradeManager.ts` (if between lines 120–510) so every `'CLOSED'` path is verified. Then add integration tests in `apps/server/src/quant/__tests__/propFirmRiskGuard.test.ts` covering:
1. `autoPilot_targetReachedClosesPositionThenPasses`: opens/inserts an open `SOLUSDT` position at `$100` (`qty = 250`), ticks mark price to `$110.07` (`+$2,517.50` minus `~$13.76` close fee `>= $52,500`), verifies `closePosition` called with `'PROPFIRM_TARGET_REACHED'`, trade saved `'CLOSED'`, cycle status `'PASSED'`, `consecutivePassedCycles === 1`, and subsequent re-entry blocked with `autoPilot.blockReason === 'CYCLE_TERMINAL'` (`statusMessage === null` when idle? Wait: when blocked by `CYCLE_TERMINAL` on entry, `blockReason === 'CYCLE_TERMINAL'`, and after `handlePositionClosed()` before next blocked tick, closing message is cleared).
2. `autoPilot_failedCloseRestoresStatusAndRetriesWithoutNakedWedge`: mocks `broker.closePosition` rejecting once with `Error('Network timeout')` when `PROPFIRM_TARGET_REACHED` triggers; verifies trade SQLite status reverts cleanly from `'CLOSING_IN_PROGRESS'` back to `'OPEN'`, `handlePositionClosed` is NOT called while still open, and on the next `onTick()` `closePosition` retries and closes the trade cleanly into `PASSED`.
3. `tradeManager_manualCloseAndUserDataFillUpdatePropFirmLedger`: instantiates `TradeManager` with `onTradeClosed` wired to `guard.recordTradeClosed({ tradeId: trade.id, ... })`; executes `tradeManager.closePosition('SOLUSDT', 'USER_MANUAL')` and UserData SL fill without calling `AutoPilotManager` and asserts cycle `realizedPnlUsd` and `tradesCount` increment once per closed trade.
4. `autoPilot_cycle2AllowedImmediatelyOn4606WalletAfterClearPropFirmBlock`: sets Cycle #1 `PASSED` on a `$4,606.01` wallet after losing `-$150` then winning `+$2,650`, rolls over via `guard.startNewCycle(4_606.01)` + `autoPilot.clearPropFirmBlock()`, sets a `BUY` snapshot, and asserts `autoPilot.onTick('SOLUSDT', 100)` executes a Cycle #2 entry without blocking on `-$92.12` (`2%` of `$4,606.01`), `COOLDOWN_ACTIVE`, `180s` lockout, or `maxDailyTrades`.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run apps/server/src/quant/__tests__/propFirmRiskGuard.test.ts`
Expected: FAIL (`clearPropFirmBlock` not defined, `PROPFIRM_TARGET_REACHED` not fired, `onTradeClosed` missing).

- [ ] **Step 3: Implement `TradeManager`, `AutoPilotManager`, and `index.ts` changes**

1. In `apps/server/src/services/tradeManager.ts`:
   - Add `onTradeClosed?: (trade: TradeRecord) => void` to `TradeManagerOptions` and store `private onTradeClosedFn`.
   - Call `this.notifyTradeClosed(closedTrade)` immediately after every `status: 'CLOSED'` persistence (`closePosition`, `handleOrderTradeUpdate` TP1 full fill / TP2 / SL / BE, `emergencyUnwindPosition`, and `reconcileWithExchange` Case 2). Wrap listener in `try/catch` so listener errors never break trade cleanup.
2. In `apps/server/src/services/autoPilotManager.ts`:
   - Add fields: `private isManagingPosition = false;` and `private cycleStartedAtMs: number = 0;`.
   - In `onTick()`: return immediately if `this.isManagingPosition` before entering `manageOpenPosition()`; wrap `manageOpenPosition()` calls in `try { this.isManagingPosition = true; ... } finally { this.isManagingPosition = false; }`.
   - Map `guardCheck.reason === 'CYCLE_TERMINAL'` directly to `BlockReason` `'CYCLE_TERMINAL'`, and call `this.clearPropFirmBlock()` when `guardCheck.allowed === true` and `this.blockReason` is one of `'UPCOMERS_DAILY_HALT' | 'UPCOMERS_TRAILING_HALT' | 'CYCLE_TERMINAL'`.
   - When `this.propFirmRiskGuard` is defined: use `Math.max(startOfUtcDay, this.cycleStartedAtMs)` for `getFilledTradeCountToday(...)`, and skip the legacy `cachedBalance * dailyDrawdownLimitPct` cooldown block (lines 622–638), deferring daily drawdown enforcement to `PropFirmRiskGuard`.
   - Add `public clearPropFirmBlock(): void`: resets `this.blockReason` (if Upcomers/Terminal or `BLOCKED_SESSION_TRADE_CAP`), clears `this.statusMessage = null`, clears `this.cooldownUntil = 0` (+ persists `autopilot_cooldown_until: { until: 0 }`), resets `this.consecutiveLosses = 0`, `this.lastExitTime = 0`, sets `this.cycleStartedAtMs = Date.now()`, resets `this.state` from `'COOLDOWN_ACTIVE'`/`'BLOCKED_SESSION_TRADE_CAP'` to `'IDLE'`, and calls `this.broadcastStatus()`.
   - In `manageOpenPosition()`: add top-of-method `if (this.state === 'CLOSING') return;`. In `Case 1b`, compute `estimatedCloseFeeUsd = Number((markPrice * qty * 0.0005).toFixed(2))` and pass `hasOpenPosition: true, estimatedCloseFeeUsd` to `evaluateLiveEquity()`. Save `prevStatus = trade.status` before writing `'CLOSING_IN_PROGRESS'`. Set `this.blockReason = null` when `emergencyExitReason === 'PROPFIRM_TARGET_REACHED'` (or set `this.blockReason = emergencyExitReason` for halts). Inside `try { await this.tradeManager.closePosition(...); } catch { const current = this.tradesRepo.getById(trade.id); if (current && current.status !== 'CLOSED') { this.tradesRepo.update(trade.id, { status: prevStatus }); this.state = 'POSITION_OPEN'; this.broadcastStatus(); } return; } finally { ... }` — call `this.handlePositionClosed(updated)` only when `!updated || updated.status === 'CLOSED'`.
   - In `handlePositionClosed()`: clear `this.statusMessage = null` and guard against duplicate `recordTradeClosed` (`propFirmRiskGuard.recordTradeClosed({ tradeId: trade.id, ... })` stays idempotent alongside `TradeManager`).
3. In `apps/server/src/index.ts`:
   - Pass `onTradeClosed` to `TradeManager` forwarding `(trade.realized_pnl ?? 0) - (trade.fees_usd ?? 0)` with `tradeId: trade.id` and `lastWalletBalanceUsd` to `propFirmRiskGuard.recordTradeClosed(...)`.
   - Pass `hasOpenPosition: Boolean(openPos)` inside `streamsManager.onMarkPrice` `propFirmRiskGuard.evaluateLiveEquity(...)`.

- [ ] **Step 4: Run tests to verify pass**

Run: `npx vitest run apps/server/src/quant/__tests__/propFirmRiskGuard.test.ts`
Expected: PASS (exit code 0).

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/services/tradeManager.ts apps/server/src/services/autoPilotManager.ts apps/server/src/index.ts apps/server/src/quant/__tests__/propFirmRiskGuard.test.ts
git commit -m "feat(propfirm): wire TradeManager closed-trade sync, AutoPilot 4Hz close recovery, and cycle-2 limit overrides"
```

---

### Task 4: Authenticated Rollover, Symbol-Switch Conflict Guard & Markdown Certificate API

**Files:**
- Modify: `apps/server/src/api/routes.ts:228-248, 680-728`
- Test: `apps/server/src/api/__tests__/propFirmRoutes.test.ts`

**Interfaces:**
- Consumes: Task 1 (`PropFirmConflictError`), Task 2 (`PropFirmRiskGuard.startNewCycle`, `formatPropFirmCertificateMarkdown`), Task 3 (`AutoPilotManager.clearPropFirmBlock`)
- Produces:
  - `POST /api/propfirm/new-cycle` -> `200 { ok: true, status, autoPilotState }` | `401` | `409 { error, code }` | `503`
  - `GET /api/propfirm/certificate?format=json|markdown` -> `200` (`application/json` | `text/markdown; charset=utf-8` + `Content-Disposition`) | `400` | `401` | `503`
  - `POST /api/symbol` -> `409` when open position exists

- [ ] **Step 1: Write the failing tests**

In `apps/server/src/api/__tests__/propFirmRoutes.test.ts`, add route integration specs:
1. `newCycle_requiresAuthAndRejectsOpenOrActiveAndAllowsTerminalOrTrailingHalt`:
   - Unauthenticated `POST /api/propfirm/new-cycle` returns `401`.
   - While Cycle #1 is `'ACTIVE'` or `'HALTED_DAILY_BUFFER'`, returns `409` with `{ code: 'CYCLE_STILL_ACTIVE' }` and Azerbaijani `error`.
   - When Cycle #1 is `'PASSED'` (or `'HALTED_TRAILING_BUFFER'`) AND an open trade exists in `trades` (or mocked `autoPilotManager.getState()` is `'PLACING_ORDER'`), returns `409` with `{ code: 'OPEN_POSITION_EXISTS' }`.
   - When flat and `'PASSED'` or `'HALTED_TRAILING_BUFFER'`, returns `200` `{ ok: true, status, autoPilotState }`, finalizes `'HALTED_TRAILING_BUFFER'` -> `'FAILED_TRAILING'`, invokes `autoPilotManager.clearPropFirmBlock()`, and sets Cycle #2 `'ACTIVE'`.
   - Concurrent `Promise.all([invoke('POST', '/api/propfirm/new-cycle'), invoke('POST', '/api/propfirm/new-cycle')])` leaves exactly 1 Cycle #2 (`200` + `409`).
2. `certificate_supportsMarkdownAndRejectsInvalidFormat`:
   - Record Cycle #1 failed (`-$1,520.00`) + Cycle #2 passed (`+$2,510.00`); call `GET /api/propfirm/certificate?format=markdown` and assert `200`, `headers['content-type'] === 'text/markdown; charset=utf-8'`, `headers['content-disposition']` matches `/attachment; filename="upcomers-50k-certificate-\d{4}-\d{2}-\d{2}\.md"/`, body contains `'-$1,520.00'` and NOT `'$-'`.
   - Call `GET /api/propfirm/certificate?format=xml` -> assert `400`.
3. `symbol_rejectsSwitchWhenPositionOpen`: inserts open `SOLUSDT` row, calls `POST /api/symbol` with `{ symbol: 'BTCUSDT' }` -> asserts `409`.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run apps/server/src/api/__tests__/propFirmRoutes.test.ts`
Expected: FAIL (`404` on `/api/propfirm/new-cycle`, JSON returned for `?format=markdown`, `200` returned on symbol switch).

- [ ] **Step 3: Implement route handlers in `apps/server/src/api/routes.ts`**

1. Extract helper `async function resolvePropFirmWalletBalance(ctx: AppContext): Promise<number>` from lines 686–705 and reuse in `GET /api/propfirm/status` and `POST /api/propfirm/new-cycle`.
2. Add active-position `409` guard in `POST /api/symbol` matching `POST /api/broker/mode` (`tradesRepo.getActivePosition(ctx.broker.mode)`).
3. Update `GET /api/propfirm/certificate` (`_req` -> `req`): parse `format = String(((req.query || {}) as Record<string, string>).format || 'json').trim().toLowerCase()`; return JSON for `'json'`, `text/markdown; charset=utf-8` + `Content-Disposition` for `'markdown'`, and `400` `{ error }` otherwise.
4. Register `POST /api/propfirm/new-cycle`: check `ctx.propFirmRiskGuard` (`503`), check `ctx.autoPilotManager?.getState()` against `['PLACING_ORDER', 'LIMIT_CHASING', 'POSITION_OPEN', 'CLOSING']` (`409` `{ error, code: 'OPEN_POSITION_EXISTS' }`), resolve `walletBalance`, call `ctx.propFirmRiskGuard.startNewCycle(walletBalance)`, catch `PropFirmConflictError` -> `409 { error: err.message, code: err.code }`, call `ctx.autoPilotManager?.clearPropFirmBlock()`, return `200 { ok: true, status, autoPilotState: ctx.autoPilotManager?.getState() }`.

- [ ] **Step 4: Run test to verify pass**

Run: `npx vitest run apps/server/src/api/__tests__/propFirmRoutes.test.ts`
Expected: PASS (exit code 0).

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/api/routes.ts apps/server/src/api/__tests__/propFirmRoutes.test.ts
git commit -m "feat(api): add POST /api/propfirm/new-cycle, certificate markdown export, and symbol switch lock"
```

---

### Task 5: Frontend Store Error Extraction, Unclipped Responsive HUD & Final Full-Stack Verification

**Files:**
- Modify: `apps/web/src/lib/apiClient.ts:92-105, 263-270`
- Modify: `apps/web/src/store/useMarketStore.ts:114-116, 429-442`
- Modify: `apps/web/src/components/PropFirmChallengeHUD.tsx:133-332`
- Test: `apps/web/src/components/__tests__/PropFirmChallengeHUD.test.tsx`

**Interfaces:**
- Consumes: Task 4 (`POST /api/propfirm/new-cycle` returning `{ ok: true, status, autoPilotState }` and `{ error, code }` on `409`)
- Produces:
  - `apiClient.startNewPropFirmCycle(): Promise<{ ok: boolean; status: PropFirmStatusResponse; autoPilotState?: string }>`
  - `useMarketStore.startNewPropFirmCycle(): Promise<PropFirmStatusResponse>`
  - `PropFirmChallengeHUD.tsx` testids: `propfirm-faucet-link`, `propfirm-new-cycle-btn`, `propfirm-new-cycle-error`

- [ ] **Step 1: Write the failing tests**

In `apps/web/src/components/__tests__/PropFirmChallengeHUD.test.tsx`, add specs verifying:
1. `rendersClickableFaucetLinkAndPureAzerbaijaniBanner`: renders `needsTopUp: true` and asserts `[data-testid="propfirm-faucet-link"]` is an `<a>` with `href === 'https://testnet.binancefuture.com'`, `target === '_blank'`, `rel === 'noopener noreferrer'`.
2. `removesTruncateFromTargetAndBufferAmounts`: asserts no element inside `[data-testid="propfirm-target-progress"]`, `[data-testid="propfirm-daily-buffer"]`, or `[data-testid="propfirm-trailing-buffer"]` carrying `$2,500.00` or `Qalan` has the CSS `truncate` class (`className` does not contain `'truncate'`), while preserving `Hədəf: +$2,500.00`, `Gündəlik Zərər Həddi: $1,250.00`, `Maksimum Geriləmə Həddi: $2,500.00`, `Qalan:`, and `Qalan Haqq:` assertions.
3. `newCycleButton_visibilityDisabledStatesClickAndInlineError`:
   - Hidden when `cycle.status === 'ACTIVE'` or `'HALTED_DAILY_BUFFER'`.
   - Visible when `'PASSED'`, `'FAILED_DAILY'`, `'FAILED_TRAILING'`, or `'HALTED_TRAILING_BUFFER'`.
   - Disabled when `activePosition` has non-`CLOSED` status OR `autoPilot.state` is `'PLACING_ORDER' | 'LIMIT_CHASING' | 'POSITION_OPEN' | 'CLOSING'`.
   - Clicking when flat invokes `useMarketStore.getState().startNewPropFirmCycle()`, updates `propFirmStatus` to Cycle #2, and displays `[data-testid="propfirm-new-cycle-error"]` if the promise rejects with an Azerbaijani error string.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run apps/web/src/components/__tests__/PropFirmChallengeHUD.test.tsx`
Expected: FAIL (`propfirm-faucet-link` and `propfirm-new-cycle-btn` not found, `truncate` still present).

- [ ] **Step 3: Implement `apiClient.ts`, `useMarketStore.ts`, and `PropFirmChallengeHUD.tsx`**

1. In `apps/web/src/lib/apiClient.ts`:
   - In `request()` (`lines 96–103`), set `errMsg = errJson.message || errJson.error || errMsg;` and attach `error.code = errJson.code ?? errJson.error;`.
   - Add `startNewPropFirmCycle(): Promise<{ ok: boolean; status: PropFirmStatusResponse; autoPilotState?: string }>` posting `{}` (or no body) to `'/api/propfirm/new-cycle'`.
2. In `apps/web/src/store/useMarketStore.ts`: add `startNewPropFirmCycle` calling `apiClient.startNewPropFirmCycle()`, updating `propFirmStatus: res.status`, and returning `res.status`.
3. In `apps/web/src/components/PropFirmChallengeHUD.tsx`:
   - Read `activePosition`, `autoPilot`, and `startNewPropFirmCycle` from `useMarketStore`. Manage local `isStartingCycle` & `cycleError` states.
   - Top-up banner (`propfirm-topup-banner`): render Azerbaijani message + `<a data-testid="propfirm-faucet-link" href="https://testnet.binancefuture.com" target="_blank" rel="noopener noreferrer" ...>Binance Demo Faucet ↗</a>`.
   - Header bar: render `"Yeni Dövrə Başlat"` button (`data-testid="propfirm-new-cycle-btn"`) when `cycle && (cycle.status === 'PASSED' || cycle.status === 'FAILED_DAILY' || cycle.status === 'FAILED_TRAILING' || cycle.status === 'HALTED_TRAILING_BUFFER')`, disabled when `(activePosition !== null && activePosition.status !== 'CLOSED') || isStartingCycle || ['PLACING_ORDER', 'LIMIT_CHASING', 'POSITION_OPEN', 'CLOSING'].includes(autoPilot.state)`, plus dismissible `[data-testid="propfirm-new-cycle-error"]` alert when `cycleError` is non-null.
   - Grid & Unclipped Cards: rebalance `lg:grid-cols-12` to `lg:col-span-3` (Verdict Box), `lg:col-span-4` (Target Progress Card), and `lg:col-span-5` (Daily & Trailing Buffer Card); replace `truncate` spans with fixed 2-row `flex items-center justify-between gap-2` headers (`whitespace-nowrap tabular-nums`, no `flex-wrap`) preserving exact Azerbaijani label & buffer substrings.

- [ ] **Step 4: Run component tests, monorepo typechecks, lint, full suite, and build**

Run:
1. `npx vitest run apps/web/src/components/__tests__/PropFirmChallengeHUD.test.tsx`
2. `npm --workspace=packages/shared run check && npm --workspace=apps/server exec tsc -- --noEmit && npm --workspace=apps/web exec tsc -- --noEmit`
3. `npx eslint apps/server/src apps/web/src packages/shared/src`
4. `npm test`
5. `npm run build`
Expected: All commands exit 0 with 0 errors and 0 skipped PropFirm tests.

- [ ] **Step 5: Live Port 3400 REST & Chrome DevTools visual verification**

After restarting the production server (`http://127.0.0.1:3400`):
1. Acquire `SESSION_TOKEN` from `/api/auth/session` and verify:
   - Unauthenticated `POST /api/propfirm/new-cycle` -> `401`
   - Authenticated `POST /api/propfirm/new-cycle` on `ACTIVE` cycle -> `409` `{ error, code: 'CYCLE_STILL_ACTIVE' }`
   - Authenticated `GET /api/propfirm/certificate?format=markdown` -> `200`, `text/markdown; charset=utf-8`, `Content-Disposition: attachment`, zero `'$-'`
   - Authenticated `GET /api/propfirm/certificate?format=xml` -> `400`
2. Inspect `http://127.0.0.1:3400/` via Chrome DevTools at `1280×768` and `1920×1080`: capture screenshots and verify `propfirm-challenge-hud` collapsed height `<= 148px` (with top-up banner) / `<= 116px` (without banner), `ChartCanvas` height `>= 220px`, `scrollWidth <= clientWidth` across target/buffer blocks, clickable Faucet link, and zero clipped numbers.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/lib/apiClient.ts apps/web/src/store/useMarketStore.ts apps/web/src/components/PropFirmChallengeHUD.tsx apps/web/src/components/__tests__/PropFirmChallengeHUD.test.tsx
git commit -m "feat(web): add cycle rollover control, localized faucet link, and unclipped 2-row PropFirm HUD"
```
