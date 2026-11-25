# TradeOS Upcomers $50,000 "1-Step Thunderbolt" Challenge Simulation & Risk Guard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement a 1:1 Upcomers 1-Step Thunderbolt ($50,000) challenge simulation, fail-closed intraday/trailing risk guard ($1,250 daily halt, $2,500 trailing halt with $50k floor lock at $53k HWM, $250/trade max risk clamp), SQLite cycle & daily snapshot persistence, REST/WS status endpoints, 5-cycle consistency certificate API, and the "Sadə Dildə" `PropFirmChallengeHUD.tsx` mounted above `ConfluenceHUD.tsx`.

**Architecture:** A stateless/SQLite-backed `PropFirmRiskGuard` evaluates continuous equity (`00:00 UTC` daily delta and monotonic High-Water Mark trailing floor) and computes $250 risk-clamped position sizes. `AutoPilotManager` checks `PropFirmRiskGuard.canOpenTrade()` before order entry, clamps trade quantity via `clampQuantityByMaxRisk()`, and runs an intra-tick floating-PnL circuit breaker that flattens positions before Upcomers' contractual -$1,500/-$3,000 breach limits. `WsHub` pushes throttled `PROPFIRM_STATUS` updates alongside `GET /api/propfirm/status` and `GET /api/propfirm/certificate` to drive the `PropFirmChallengeHUD` React component.

**Tech Stack:** TypeScript, Node.js (`node:sqlite` WAL mode), Polka HTTP server, `ws`, Vitest, React 18, Zustand, Tailwind CSS, Lucide icons.

**Spec:** [prop-firm-50k-challenge-and-risk-guard.md](file:///D:/Antigravity_Projects/Active_Projects/TradeOS-v2/docs/designs/prop-firm-50k-challenge-and-risk-guard.md)

## Global Constraints

* Contractual Upcomers $50K 1-Step Thunderbolt Rules: starting baseline `$50,000.00`, profit target `+$2,500.00` (`+5.0%` => `$52,500.00`), contractual daily loss limit `-$1,500.00` (`-3.0%` from `00:00 UTC` balance), contractual trailing loss limit `-$3,000.00` (`-6.0%` from HWM), unlimited time/days, no consistency rule.
* Internal Pre-Violation Safety Buffers: auto-halt new entries and emergency-close open positions at `-$1,250.00` daily loss (`-2.5%`) and `-$2,500.00` trailing drawdown (`-5.0%`), keeping a `$500.00` cushion inside contractual limits.
* Trailing Floor Lock: contractual floor is `HWM - $3,000` when `HWM < $53,000`, and locks permanently at `$50,000.00` once `HWM >= $53,000`; internal pre-violation trailing floor is `contractualFloor + $500` (`HWM - $2,500` below `$53,000`, `$50,500` once locked).
* Per-Trade Risk Clamp: `maxRiskPerTradeUsd = $250.00` (`0.50%`), enforced via `maxQty = 250 / |entryPrice - stopLossPrice|`; Stop-Loss must be placed within `<= 200ms` of entry fill (handled fail-closed by existing bracket guard + latency check). No averaging down or grid stacking (`maxConcurrentPositions = 1`).
* Testnet Top-Up Detection & Baseline Alignment: if real exchange wallet balance deviates from `$50,000` (`walletBalance < 49_000`), flag `needsTopUp: true` with Binance Demo Faucet instructions while computing simulated challenge PnL cleanly against `$50,000` without instant false disqualification.
* All new REST routes (`/api/propfirm/status`, `/api/propfirm/certificate`) are automatically gated behind `requireSessionToken(SESSION_TOKEN)` in `apps/server/src/api/routes.ts`.
* Negative dollar values in `PropFirmChallengeHUD.tsx` MUST format via `formatUsd` (`-$XX.XX`, never `$-XX.XX`).
* Isomorphic `@tradeos/shared` rule: zero `node:*` imports in `packages/shared/src/**`; sync `packages/shared/src/` into `node_modules/@tradeos/shared/src/` if edited so monorepo runtime/Vitest resolution sees identical source.

## File Structure

| File | Action | Responsibility |
| :--- | :--- | :--- |
| `packages/shared/src/types.ts` | Modify | Add `UPCOMERS_DAILY_HALT`, `UPCOMERS_TRAILING_HALT` to `BlockReason` and `ExitReason`. |
| `packages/shared/src/contracts.ts` | Modify | Export `UPCOMERS_1STEP_50K_DEFAULT`, `UpcomersChallengeConfig`, `PropFirmCycleStatus`, `PropFirmQuestionState`, `PropFirmChallengeCycle`, `PropFirmDailySnapshot`, `PropFirmStatusResponse`, `PropFirmCertificateResponse`, and `PROPFIRM_STATUS` in `WsServerMessage`. |
| `packages/shared/src/index.ts` | Modify | Re-export all new Prop Firm types and constants. |
| `apps/server/src/db/schema.sql` | Modify | Add `propfirm_challenge_cycles` and `propfirm_daily_snapshots` DDL + indexes. |
| `apps/server/src/db/sqlite.ts` | Modify | Add idempotent `ensurePropFirmSchema(db)` and `PropFirmRepo`. |
| `apps/server/src/quant/propFirmRiskGuard.ts` | Create | Implement `PropFirmRiskGuard` (daily `00:00 UTC` reset, HWM floor lock at `$53k -> $50k`, `$1,250`/`$2,500` auto-halt, `$250` max risk quantity clamp, cycle rollover, 5-cycle consistency certificate evaluator). |
| `apps/server/src/services/autoPilotManager.ts` | Modify | Enforce `propFirmRiskGuard.canOpenTrade()`, `$250` quantity clamp, intra-tick floating drawdown halt + flatten, and cycle stat recording on close. |
| `apps/server/src/api/wsHub.ts` | Modify | Add `broadcastPropFirmStatus(status: PropFirmStatusResponse)`. |
| `apps/server/src/api/routes.ts` | Modify | Register `GET /api/propfirm/status` and `GET /api/propfirm/certificate`. |
| `apps/server/src/index.ts` | Modify | Instantiate `PropFirmRepo` + `PropFirmRiskGuard`, inject into `AutoPilotManager`, `registerRoutes`, tick loop, and `WsHub`. |
| `apps/web/src/lib/apiClient.ts` | Modify | Add `getPropFirmStatus()` and `getPropFirmCertificate()`. |
| `apps/web/src/lib/wsClient.ts` | Modify | Handle `PROPFIRM_STATUS` server message. |
| `apps/web/src/store/useMarketStore.ts` | Modify | Add `propFirmStatus` state slice and `refreshPropFirmStatus()` action. |
| `apps/web/src/components/PropFirmChallengeHUD.tsx` | Create | Implement "Upcomers $50K Challenge (Sadə Dildə)" widget + Testnet Faucet banner + 5-cycle consistency progress + expandable session table. |
| `apps/web/src/App.tsx` | Modify | Wire `PROPFIRM_STATUS` WS handler, initial fetch, and mount `<PropFirmChallengeHUD />` above `<ConfluenceHUD />`. |

## Review Focus

1. **UTC Midnight Daily Baseline Rollover (`00:00 UTC`):** Server running continuously across `00:00 UTC` must automatically create a new `propfirm_daily_snapshots` baseline row, reset daily loss measurement from the new UTC day equity, and lift a transient `HALTED_DAILY_BUFFER` (while never resurrecting permanently failed `FAILED_DAILY` / `FAILED_TRAILING` cycles).
2. **Intra-Tick Floating Drawdown Violation:** Unrealized floating loss pushing daily loss `<= -$1,250` or trailing equity `<= internalTrailingFloor` must trigger synchronous halt + emergency market close on live tick before reaching contractual `-$1,500` / `-$3,000`, without re-entering on subsequent 4Hz ticks.
3. **Zero / NaN Stop-Loss Distance in `$250` Quantity Clamp:** `calculateUpcomersMaxQty(entryPrice, stopLossPrice)` must fail-closed to `0` (never `Infinity` or `NaN`) when `|entryPrice - stopLossPrice| <= 0` or inputs are non-finite.
4. **Monotonic HWM Lock at `$53,000` & Restart Durability:** Once `HWM >= $53,000`, subsequent equity drawdowns must keep contractual trailing floor permanently locked at `$50,000.00` (and persisted across SQLite restarts), and `PARTIALLY_CLOSED` fills must not double-count `trades_count` or `consecutivePassedCycles`.
5. **Sub-$50K Testnet Balance Resilience (`$4,606.01` Wallet):** When Testnet wallet is below `$49,000`, challenge PnL/drawdown tracking anchors to `$50,000 + cycleCumulativePnl` (instead of falsely tripping `-90% FAIL` on boot) while surfacing `needsTopUp: true` with Faucet instructions and clamping live order notional safely within actual wallet liquidity.

---

### Task 1: Shared Upcomers $50K Challenge Contracts (`@tradeos/shared`)

**Files:**
- Modify: `packages/shared/src/types.ts:9-40`
- Modify: `packages/shared/src/contracts.ts:437-496,870-885`
- Modify: `packages/shared/src/index.ts:1-47`
- Test: `packages/shared/src/__tests__/propFirmContracts.test.ts` (Create)

**Interfaces:**
- Produces in `@tradeos/shared`:
  - `UPCOMERS_1STEP_50K_DEFAULT: UpcomersChallengeConfig`
  - `UpcomersChallengeConfig`, `PropFirmCycleStatus`, `PropFirmQuestionVerdict`, `PropFirmChallengeCycle`, `PropFirmDailySnapshot`, `PropFirmStatusResponse`, `PropFirmCertificateResponse`
  - `BlockReason` additions: `'UPCOMERS_DAILY_HALT' | 'UPCOMERS_TRAILING_HALT'`
  - `ExitReason` additions: `'UPCOMERS_DAILY_HALT' | 'UPCOMERS_TRAILING_HALT'`
  - `WsServerMessage` addition: `{ type: 'PROPFIRM_STATUS'; data: PropFirmStatusResponse }`

- [ ] **Step 1: Write failing unit test for shared Prop Firm contracts**

Create `packages/shared/src/__tests__/propFirmContracts.test.ts`:
```typescript
import { describe, it, expect } from 'vitest';
import {
  UPCOMERS_1STEP_50K_DEFAULT,
  type PropFirmStatusResponse,
  type PropFirmCertificateResponse,
  type BlockReason,
  type ExitReason,
  type WsServerMessage,
} from '../index.js';

describe('Upcomers 50K Prop Firm Shared Contracts', () => {
  it('exports exact Upcomers 1-Step Thunderbolt defaults and zero-halt tolerances', () => {
    expect(UPCOMERS_1STEP_50K_DEFAULT).toEqual({
      accountSizeUsd: 50_000,
      profitTargetUsd: 2_500,
      contractualDailyLossUsd: 1_500,
      internalDailyHaltUsd: 1_250,
      contractualTrailingLossUsd: 3_000,
      internalTrailingHaltUsd: 2_500,
      trailingLockHwmUsd: 53_000,
      lockedTrailingFloorUsd: 50_000,
      maxRiskPerTradeUsd: 250,
      maxConcurrentPositions: 1,
    });
  });

  it('supports UPCOMERS_DAILY_HALT and UPCOMERS_TRAILING_HALT reasons and WS message', () => {
    const b1: BlockReason = 'UPCOMERS_DAILY_HALT';
    const b2: BlockReason = 'UPCOMERS_TRAILING_HALT';
    const e1: ExitReason = 'UPCOMERS_DAILY_HALT';
    const e2: ExitReason = 'UPCOMERS_TRAILING_HALT';
    expect([b1, b2, e1, e2]).toHaveLength(4);

    const status: PropFirmStatusResponse = {
      cycle: {
        id: 'cycle_1',
        cycleNumber: 1,
        status: 'ACTIVE',
        startingBalanceUsd: 50_000,
        currentEquityUsd: 50_840.5,
        highWaterMarkUsd: 50_900,
        contractualTrailingFloorUsd: 47_900,
        internalTrailingFloorUsd: 48_400,
        isFloorLocked: false,
        profitTargetUsd: 2_500,
        netPnlUsd: 840.5,
        netPnlPct: 1.681,
        maxDrawdownUsd: 120,
        tradesCount: 3,
        winCount: 2,
        lossCount: 1,
        startedAt: 1000,
        closedAt: null,
      },
      verdict: 'YES_PROFIT',
      dailyBaselineEquityUsd: 50_000,
      dailyPnlUsd: 840.5,
      dailyLossUsedUsd: 0,
      dailyBufferRemainingUsd: 1_250,
      dailyBufferRemainingPct: 100,
      trailingLossUsedUsd: 59.5,
      trailingBufferRemainingUsd: 2_440.5,
      trailingBufferRemainingPct: 97.62,
      targetProgressPct: 33.62,
      targetRemainingUsd: 1_659.5,
      liveWalletBalanceUsd: 4_606.01,
      needsTopUp: true,
      topUpMessage: 'Binance Testnet top-up required to match $50,000.00 challenge capital',
      consecutivePassedCycles: 0,
      requiredPassedCycles: 5,
      canTrade: true,
      haltReason: null,
      cycles: [],
      updatedAt: 1000,
    };

    const msg: WsServerMessage = { type: 'PROPFIRM_STATUS', data: status };
    const cert: PropFirmCertificateResponse = {
      certified: false,
      consecutivePassedCycles: 0,
      requiredPassedCycles: 5,
      remainingCycles: 5,
      totalCompletedCycles: 0,
      cycles: [],
      generatedAt: 1000,
    };
    expect(msg.type).toBe('PROPFIRM_STATUS');
    expect(cert.requiredPassedCycles).toBe(5);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx.cmd vitest run packages/shared/src/__tests__/propFirmContracts.test.ts`
Expected: FAIL with missing exports `UPCOMERS_1STEP_50K_DEFAULT`, etc.

- [ ] **Step 3: Implement shared contracts in `types.ts`, `contracts.ts`, and `index.ts`**

- In `packages/shared/src/types.ts`: append `'UPCOMERS_DAILY_HALT' | 'UPCOMERS_TRAILING_HALT'` to both `ExitReason` and `BlockReason`.
- In `packages/shared/src/contracts.ts`:
  - Define and export `UPCOMERS_1STEP_50K_DEFAULT` (`as const`), `UpcomersChallengeConfig`, `PropFirmCycleStatus` (`'ACTIVE' | 'PASSED' | 'FAILED_DAILY' | 'FAILED_TRAILING' | 'HALTED_DAILY_BUFFER' | 'HALTED_TRAILING_BUFFER'`), `PropFirmQuestionVerdict` (`'YES_PROFIT' | 'NO_LOSS' | 'WAITING'`), `PropFirmChallengeCycle`, `PropFirmDailySnapshot`, `PropFirmStatusResponse`, and `PropFirmCertificateResponse`.
  - Add `| { type: 'PROPFIRM_STATUS'; data: PropFirmStatusResponse }` to `WsServerMessage`.
- In `packages/shared/src/index.ts`: export `UPCOMERS_1STEP_50K_DEFAULT` and all new Prop Firm type exports (no `node:*` imports anywhere in `packages/shared`).

- [ ] **Step 4: Sync `node_modules/@tradeos/shared/src/`, compile, and verify test passes**

Run:
- Sync modified files (`types.ts`, `contracts.ts`, `index.ts`) into `node_modules/@tradeos/shared/src/` (matching monorepo layout)
- `npx.cmd tsc --noEmit -p packages/shared/tsconfig.json && npx.cmd vitest run packages/shared/src/__tests__/propFirmContracts.test.ts packages/shared/src/__tests__/contracts.test.ts`
Expected: EXIT 0, all tests PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/types.ts packages/shared/src/contracts.ts packages/shared/src/index.ts packages/shared/src/__tests__/propFirmContracts.test.ts
git commit -m "feat(shared): add Upcomers 50K challenge contracts, halt reasons, and WS message"
```

---

### Task 2: SQLite Persistence Schema & `PropFirmRepo` (`apps/server/src/db`)

**Files:**
- Modify: `apps/server/src/db/schema.sql:265-272`
- Modify: `apps/server/src/db/sqlite.ts` (append `ensurePropFirmSchema` in `initializeDatabase` and export `PropFirmRepo`)
- Test: `apps/server/src/db/__tests__/propFirmRepo.test.ts` (Create)

**Interfaces:**
- Consumes: `PropFirmChallengeCycle`, `PropFirmDailySnapshot`, `PropFirmCycleStatus`, `UPCOMERS_1STEP_50K_DEFAULT` from `@tradeos/shared`.
- Produces in `apps/server/src/db/sqlite.ts`:
  - Tables: `propfirm_challenge_cycles`, `propfirm_daily_snapshots` (with idempotent `CREATE TABLE IF NOT EXISTS` in `schema.sql` and `ensurePropFirmSchema(db)`).
  - Class `PropFirmRepo(db: DatabaseSync)`:
    - `createCycle(cycle: PropFirmChallengeCycle): PropFirmChallengeCycle`
    - `getActiveCycle(): PropFirmChallengeCycle | null`
    - `getLatestCycle(): PropFirmChallengeCycle | null`
    - `listCycles(limit?: number): PropFirmChallengeCycle[]`
    - `updateCycle(id: string, patch: Partial<PropFirmChallengeCycle>): void`
    - `getNextCycleNumber(): number`
    - `countConsecutivePassedCycles(): number` (counts trailing uninterrupted `'PASSED'` terminal cycles ordered by `cycle_number DESC`, ignoring `'ACTIVE'` / transient halt if no terminal fail precedes; stops as soon as any `'FAILED_*'` cycle appears)
    - `getDailySnapshot(utcDate: string, cycleId: string): PropFirmDailySnapshot | null`
    - `upsertDailySnapshot(snapshot: PropFirmDailySnapshot): void`

- [ ] **Step 1: Write failing unit tests for `PropFirmRepo` & schema migrations**

Create `apps/server/src/db/__tests__/propFirmRepo.test.ts` covering:
1. Creating and retrieving an active `propfirm_challenge_cycles` record on fresh in-memory DB.
2. Updating monotonic High-Water Mark, `isFloorLocked`, `maxDrawdownUsd`, and transitioning status to `PASSED` / `FAILED_DAILY`.
3. `countConsecutivePassedCycles()` returning `5` after 5 consecutive `PASSED` cycles and resetting to `1` if an older cycle had `FAILED_DAILY` before the latest `PASSED` cycle.
4. `upsertDailySnapshot(utcDate, cycleId)` inserting a `00:00 UTC` daily baseline and updating EOD metrics idempotently on `(utc_date, cycle_id)`.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx.cmd vitest run apps/server/src/db/__tests__/propFirmRepo.test.ts`
Expected: FAIL with `PropFirmRepo` not exported.

- [ ] **Step 3: Add DDL in `schema.sql` and implement `ensurePropFirmSchema` + `PropFirmRepo` in `sqlite.ts`**

Append to `apps/server/src/db/schema.sql`:
```sql
CREATE TABLE IF NOT EXISTS propfirm_challenge_cycles (
  id TEXT PRIMARY KEY,
  cycle_number INTEGER NOT NULL,
  status TEXT NOT NULL,
  starting_balance_usd REAL NOT NULL,
  current_equity_usd REAL NOT NULL,
  high_water_mark_usd REAL NOT NULL,
  contractual_trailing_floor_usd REAL NOT NULL,
  internal_trailing_floor_usd REAL NOT NULL,
  is_floor_locked INTEGER NOT NULL DEFAULT 0,
  profit_target_usd REAL NOT NULL,
  net_pnl_usd REAL NOT NULL DEFAULT 0,
  net_pnl_pct REAL NOT NULL DEFAULT 0,
  max_drawdown_usd REAL NOT NULL DEFAULT 0,
  trades_count INTEGER NOT NULL DEFAULT 0,
  win_count INTEGER NOT NULL DEFAULT 0,
  loss_count INTEGER NOT NULL DEFAULT 0,
  started_at INTEGER NOT NULL,
  closed_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_propfirm_cycles_num ON propfirm_challenge_cycles(cycle_number DESC);
CREATE INDEX IF NOT EXISTS idx_propfirm_cycles_status ON propfirm_challenge_cycles(status);

CREATE TABLE IF NOT EXISTS propfirm_daily_snapshots (
  utc_date TEXT NOT NULL,
  cycle_id TEXT NOT NULL REFERENCES propfirm_challenge_cycles(id) ON DELETE CASCADE,
  day_start_equity_usd REAL NOT NULL,
  current_equity_usd REAL NOT NULL,
  daily_pnl_usd REAL NOT NULL DEFAULT 0,
  daily_min_equity_usd REAL NOT NULL,
  daily_halted INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (utc_date, cycle_id)
);

CREATE INDEX IF NOT EXISTS idx_propfirm_daily_date ON propfirm_daily_snapshots(utc_date DESC);
```
Implement `ensurePropFirmSchema(db)` in `sqlite.ts` (invoked inside `initializeDatabase()`) and `PropFirmRepo` mapping snake_case SQLite rows cleanly to camelCase `PropFirmChallengeCycle` / `PropFirmDailySnapshot`. Note: store `is_floor_locked` and `daily_halted` as SQLite integers `0 | 1` and convert cleanly to booleans.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx.cmd vitest run apps/server/src/db/__tests__/propFirmRepo.test.ts apps/server/src/db/__tests__/sqlite.test.ts`
Expected: EXIT 0, all tests PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/db/schema.sql apps/server/src/db/sqlite.ts apps/server/src/db/__tests__/propFirmRepo.test.ts
git commit -m "feat(db): add propfirm_challenge_cycles, propfirm_daily_snapshots, and PropFirmRepo"
```

---

### Task 3: `PropFirmRiskGuard` & `AutoPilotManager` Enforcement (`apps/server`)

**Files:**
- Create: `apps/server/src/quant/propFirmRiskGuard.ts`
- Modify: `apps/server/src/services/autoPilotManager.ts:53-160,550-775,1120-1280`
- Test: `apps/server/src/quant/__tests__/propFirmRiskGuard.test.ts` (Create)

**Interfaces:**
- Consumes: `PropFirmRepo`, `UPCOMERS_1STEP_50K_DEFAULT`, `UpcomersChallengeConfig`, `PropFirmStatusResponse`, `PropFirmCertificateResponse` from `@tradeos/shared` & `../db/sqlite.js`.
- Produces in `apps/server/src/quant/propFirmRiskGuard.ts`:
  - `calculateUpcomersMaxQty(entryPrice: number, stopLossPrice: number, maxRiskUsd?: number): number`
  - `calculateUpcomersTrailingFloors(highWaterMarkUsd: number, config?: UpcomersChallengeConfig): { contractualFloorUsd: number; internalHaltFloorUsd: number; isFloorLocked: boolean }`
  - `class PropFirmRiskGuard(repo: PropFirmRepo, config?: Partial<UpcomersChallengeConfig>, onStatusUpdate?: (status: PropFirmStatusResponse) => void)`:
    - `canOpenTrade(nowMs?: number): { allowed: boolean; reason?: 'UPCOMERS_DAILY_HALT' | 'UPCOMERS_TRAILING_HALT' | 'CYCLE_TERMINAL'; details?: string }`
    - `clampEntryQuantity(params: { desiredQty: number; entryPrice: number; stopLossPrice: number }): { qty: number; clampedByRisk: boolean; maxRiskQty: number; riskUsdAtStop: number }`
    - `evaluateLiveEquity(params: { realizedCyclePnlUsd: number; unrealizedPnlUsd: number; liveWalletBalanceUsd: number; nowMs?: number }): { status: PropFirmStatusResponse; emergencyExitReason: 'UPCOMERS_DAILY_HALT' | 'UPCOMERS_TRAILING_HALT' | null; cycleJustPassed: boolean }`
    - `recordTradeClosed(params: { realizedNetPnlUsd: number; liveWalletBalanceUsd: number; nowMs?: number }): PropFirmStatusResponse`
    - `startNewCycle(liveWalletBalanceUsd?: number, nowMs?: number): PropFirmStatusResponse`
    - `getStatus(liveWalletBalanceUsd?: number, nowMs?: number): PropFirmStatusResponse`
    - `getCertificateStatus(nowMs?: number): PropFirmCertificateResponse`

**Algorithm & Edge-Case Invariants:**
1. **Virtual Challenge Baseline vs Exchange Wallet (Review Focus #5):** Challenge equity = `startingBalanceUsd (50_000) + realizedCyclePnlUsd + unrealizedPnlUsd` whenever `liveWalletBalanceUsd < 49_000` (e.g. current `$4,606.01` Demo balance), and uses `liveWalletBalanceUsd + unrealizedPnlUsd` when Testnet wallet is topped up near `$50,000` (`>= 49_000 && <= 55_000` on initial boot, reconciled cleanly). Whenever `liveWalletBalanceUsd < 49_000`, `needsTopUp = true` and `topUpMessage` includes instructions to top up Binance Futures Demo USDT to `$50,000.00`.
2. **Contractual vs Internal Trailing Floors & Monotonic `$53,000` Lock (Review Focus #4):**
   - `highWaterMarkUsd = Math.max(cycle.highWaterMarkUsd, currentEquityUsd)` (monotonic).
   - If `highWaterMarkUsd >= 53_000`: `isFloorLocked = true`, `contractualFloorUsd = 50_000`, `internalHaltFloorUsd = 50_500`.
   - Else (`< 53_000`): `isFloorLocked = false`, `contractualFloorUsd = highWaterMarkUsd - 3_000`, `internalHaltFloorUsd = highWaterMarkUsd - 2_500`.
   - If `currentEquityUsd >= startingBalanceUsd + profitTargetUsd` (`$52,500.00`) -> transition cycle to `'PASSED'` (`closedAt = nowMs`).
3. **UTC Midnight Baseline Rollover (Review Focus #1):**
   - `utcDate = new Date(nowMs).toISOString().slice(0, 10)`.
   - When no `propfirm_daily_snapshots` row exists for `(utcDate, cycle.id)`, create one anchored at `dayStartEquityUsd = currentEquityUsd`!
   - If the previous UTC day had triggered `HALTED_DAILY_BUFFER` (internal pre-violation buffer `-1,250`, NOT contractual `FAILED_DAILY`), transition `cycle.status` back to `'ACTIVE'` on the new UTC day! Permanent states (`PASSED`, `FAILED_DAILY`, `FAILED_TRAILING`) never unlock on midnight rollover.
4. **Intra-Tick Floating Drawdown Watchdog (Review Focus #2):**
   - `dailyPnlUsd = currentEquityUsd - dailySnapshot.dayStartEquityUsd`.
   - Check Trailing first, then Daily:
     - If `currentEquityUsd <= contractualFloorUsd`: cycle becomes `'FAILED_TRAILING'`, returns `emergencyExitReason: 'UPCOMERS_TRAILING_HALT'`.
     - Else if `currentEquityUsd <= internalHaltFloorUsd` (`$2,500` trailing loss reached): cycle becomes `'HALTED_TRAILING_BUFFER'`, returns `emergencyExitReason: 'UPCOMERS_TRAILING_HALT'`.
     - Else if `dailyPnlUsd <= -contractualDailyLossUsd` (`-$1,500`): cycle becomes `'FAILED_DAILY'`, returns `emergencyExitReason: 'UPCOMERS_DAILY_HALT'`.
     - Else if `dailyPnlUsd <= -internalDailyHaltUsd` (`-$1,250`): cycle becomes `'HALTED_DAILY_BUFFER'`, returns `emergencyExitReason: 'UPCOMERS_DAILY_HALT'`.
5. **Zero-Distance / Non-Finite SL Guard in `$250` Clamp (Review Focus #3):**
   - `calculateUpcomersMaxQty(entry, sl, maxRisk = 250)`: if `!Number.isFinite(entry) || !Number.isFinite(sl) || Math.abs(entry - sl) <= 1e-8`, return `0`. Else `Number((maxRisk / Math.abs(entry - sl)).toFixed(4))`.
6. **Sadə Dildə Verdict:**
   - `netPnlUsd > 0.005` -> `'YES_PROFIT'`, `netPnlUsd < -0.005` -> `'NO_LOSS'`, else `'WAITING'`.

- [ ] **Step 1: Write failing unit tests in `apps/server/src/quant/__tests__/propFirmRiskGuard.test.ts`**

Test assertions covering all 5 Review Focus cases + G-1..G-5:
1. `calculateUpcomersMaxQty(100, 99.5, 250)` -> `500`, and `calculateUpcomersMaxQty(100, 100, 250)` -> `0` (Review Focus #3).
2. `$1,250` internal daily halt triggers `emergencyExitReason: 'UPCOMERS_DAILY_HALT'` & `canOpenTrade().allowed === false` while staying safely inside `-$1,500` contractual limit; floating unrealized loss also triggers it (Review Focus #2).
3. Trailing floor tracks `HWM - $3,000` (internal `HWM - $2,500`) below `$53,000` HWM, permanently locks contractual floor at `$50,000` (`isFloorLocked === true`) once HWM hits `$53,000`, and remains locked if equity pulls back (Review Focus #4).
4. Crossing `00:00 UTC` into next day creates new `propfirm_daily_snapshots` baseline and restores `HALTED_DAILY_BUFFER` -> `ACTIVE`, while `FAILED_DAILY` remains permanently closed (Review Focus #1).
5. With `liveWalletBalanceUsd = 4606.01`, `needsTopUp === true` and challenge starts safely at `$50,000.00` without instant fail; once profit hits `+$2,500`, status becomes `'PASSED'`, and 5 consecutive `'PASSED'` cycles set `certificate.certified === true` (Review Focus #5 & G-5).

- [ ] **Step 2: Run test to verify it fails**

Run: `npx.cmd vitest run apps/server/src/quant/__tests__/propFirmRiskGuard.test.ts`
Expected: FAIL (`Cannot find module ../propFirmRiskGuard.js`).

- [ ] **Step 3: Implement `PropFirmRiskGuard` and wire into `AutoPilotManager`**

- Create `apps/server/src/quant/propFirmRiskGuard.ts` implementing the full logic above.
- Update `apps/server/src/services/autoPilotManager.ts`:
  - Accept optional `propFirmRiskGuard?: PropFirmRiskGuard` in `AutoPilotManagerOptions`.
  - In `evaluateMarketTick()` (before opening new trade): if `propFirmRiskGuard` exists and has an open position, compute floating unrealized PnL + cumulative cycle realized PnL, call `propFirmRiskGuard.evaluateLiveEquity(...)`; if `emergencyExitReason !== null`, transition `state = 'CLOSING'`, close open position via `tradeManager.closePosition(symbol, emergencyExitReason)`, and call `handlePositionClosed`. Even when flat, check `propFirmRiskGuard.canOpenTrade()`; if `!allowed`, do not enter `PLACING_ORDER`.
  - In `executeAutoEntry()`: after computing `stopLoss` and `targetQty`, if `this.propFirmRiskGuard` is present, call `clampEntryQuantity({ desiredQty: targetQty, entryPrice: refPrice, stopLossPrice: stopLoss })`; if `qty <= 0`, abort safely to `IDLE` with `onOrderDispatched` failure telemetry; else replace `targetQty` and adjust `marginUsd = Number(((targetQty * refPrice) / leverage).toFixed(2))` so trade risk at SL never exceeds `$250.00`.
  - In `handlePositionClosed(closedTrade)`: only when `closedTrade && closedTrade.status === 'CLOSED'` (avoid double counting `PARTIALLY_CLOSED`, Review Focus #4), invoke `this.propFirmRiskGuard?.recordTradeClosed(...)`.

- [ ] **Step 4: Run `PropFirmRiskGuard` & `AutoPilot` integration tests**

Run: `npx.cmd vitest run apps/server/src/quant/__tests__/propFirmRiskGuard.test.ts apps/server/src/services/__tests__/autoPilotManager.test.ts apps/server/test/autoPilotIntegration.test.ts apps/server/test/riskHardening.test.ts`
Expected: EXIT 0, all tests PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/quant/propFirmRiskGuard.ts apps/server/src/services/autoPilotManager.ts apps/server/src/quant/__tests__/propFirmRiskGuard.test.ts
git commit -m "feat(risk): implement Upcomers PropFirmRiskGuard ($250 clamp, $1250/$2500 halts) and wire into AutoPilotManager"
```

---

### Task 4: REST Endpoints, `WsHub` Broadcast & Server Wiring (`apps/server`)

**Files:**
- Modify: `apps/server/src/api/wsHub.ts:350-471`
- Modify: `apps/server/src/api/routes.ts:50-75,660-680`
- Modify: `apps/server/src/index.ts:350-480,680-810`
- Test: `apps/server/src/api/__tests__/propFirmRoutes.test.ts` (Create)

**Interfaces:**
- Consumes: `PropFirmRiskGuard`, `PropFirmStatusResponse`, `PropFirmCertificateResponse`
- Produces:
  - `WsHub.broadcastPropFirmStatus(status: PropFirmStatusResponse): void` (throttled max 2Hz / 500ms so 4Hz ticks don't spam WS)
  - `GET /api/propfirm/status` (authenticated via `requireSessionToken`) returning `200 PropFirmStatusResponse` or `503` if uninitialized
  - `GET /api/propfirm/certificate` (authenticated via `requireSessionToken`) returning `200 PropFirmCertificateResponse` or `503` if uninitialized

- [ ] **Step 1: Write failing route integration tests in `apps/server/src/api/__tests__/propFirmRoutes.test.ts`**

Test assertions:
1. Unauthenticated `GET /api/propfirm/status` returns `401`.
2. Authenticated `GET /api/propfirm/status` returns `200` with live balance top-up check, `verdict`, `dailyBufferRemainingUsd`, `trailingBufferRemainingUsd`, and `cycles` list.
3. Authenticated `GET /api/propfirm/certificate` returns `200` with `certified: true` when `consecutivePassedCycles >= 5` and `certified: false` when `< 5`.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx.cmd vitest run apps/server/src/api/__tests__/propFirmRoutes.test.ts`
Expected: FAIL (`404 Not Found` / missing route).

- [ ] **Step 3: Implement `WsHub.broadcastPropFirmStatus`, `routes.ts` endpoints, and `index.ts` wiring**

- `apps/server/src/api/wsHub.ts`: add 500ms-throttled `broadcastPropFirmStatus(status: PropFirmStatusResponse)` sending `{ type: 'PROPFIRM_STATUS', data: status }` to authenticated clients.
- `apps/server/src/api/routes.ts`: add `propFirmRiskGuard?: PropFirmRiskGuard` and `getPropFirmWalletBalance?: () => number` to `AppContext`; register `GET /api/propfirm/status` and `GET /api/propfirm/certificate`.
- `apps/server/src/index.ts`: instantiate `PropFirmRepo(db)` and `PropFirmRiskGuard(propFirmRepo, {}, (st) => wsHub?.broadcastPropFirmStatus(st))`, pass `propFirmRiskGuard` to `AutoPilotManager` and `registerRoutes`, and evaluate live account equity inside the throttled tick / account refresh path.

- [ ] **Step 4: Run server compilation & route tests**

Run: `npx.cmd tsc --noEmit -p apps/server/tsconfig.json && npx.cmd vitest run apps/server/src/api/__tests__/propFirmRoutes.test.ts apps/server/src/api/__tests__/routes.test.ts`
Expected: EXIT 0, all tests PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/api/wsHub.ts apps/server/src/api/routes.ts apps/server/src/index.ts apps/server/src/api/__tests__/propFirmRoutes.test.ts
git commit -m "feat(api): add /api/propfirm/status, /api/propfirm/certificate, and PROPFIRM_STATUS WS stream"
```

---

### Task 5: Cockpit Monitor "Upcomers $50K Challenge (Sadə Dildə)" & End-to-End Verification (`apps/web`)

**Files:**
- Modify: `apps/web/src/lib/apiClient.ts:245-318`
- Modify: `apps/web/src/lib/wsClient.ts:60-220`
- Modify: `apps/web/src/store/useMarketStore.ts:80-115,380-419`
- Create: `apps/web/src/components/PropFirmChallengeHUD.tsx`
- Modify: `apps/web/src/App.tsx:1-125`
- Test: `apps/web/src/components/__tests__/PropFirmChallengeHUD.test.tsx` (Create)

**Interfaces:**
- Consumes: `PropFirmStatusResponse`, `PropFirmCertificateResponse` from `@tradeos/shared`; `formatUsd` from `../lib/formatters`; `useMarketStore`.
- Produces:
  - `apiClient.getPropFirmStatus(): Promise<PropFirmStatusResponse>` and `apiClient.getPropFirmCertificate(): Promise<PropFirmCertificateResponse>`
  - `wsClient` handler `onPropFirmStatus?: (status: PropFirmStatusResponse) => void`
  - `useMarketStore`: `propFirmStatus: PropFirmStatusResponse | null`, `setPropFirmStatus`, `refreshPropFirmStatus`
  - `<PropFirmChallengeHUD />` component (`data-testid="propfirm-challenge-hud"`).

**UI Copy & Element Invariants (Verbatim from Spec Section 2):**
1. **Top-Up Reminder Banner (`needsTopUp === true`):** Amber alert banner showing current Testnet balance (`formatUsd(liveWalletBalanceUsd)`) vs `$50,000.00` challenge target with Binance Demo Faucet top-up instructions.
2. **Header + `"Doğurdan Qazanırammı?"` Box:**
   - Green badge: `BƏLİ, QAZANCDASAN` with `formatUsd(netPnlUsd, true)` and `(+X.XX%)` when `verdict === 'YES_PROFIT'`.
   - Red badge: `XEYR, ZƏRƏRDƏSƏN` with `formatUsd(netPnlUsd, true)` when `verdict === 'NO_LOSS'`.
   - Gray badge: `GÖZLƏMƏDƏ` when `verdict === 'WAITING'`.
3. **`Upcomers $2,500 Hədəf Barı`:** Renders `Hədəf: +$2,500.00 | Cari: ... (X% Tamamlandı) | Qalan: ...` and a visual progress bar clamped `[0%, 100%]`.
4. **Daily & Trailing Drawdown Gauges + Floor Lock & 5-Cycle Badge:**
   - Daily: `Gündəlik Zərər Həddi: $1,250.00 | Qalan Haqq: ...` (`Safe` / `HALT` indicator).
   - Trailing: `Maksimum Geriləmə Həddi: $2,500.00 | Qalan Haqq: ...` + `FLOOR LOCKED: $50,000` badge when `isFloorLocked === true`.
   - Consistency badge: `Sertifikat: {consecutivePassedCycles} / 5 Uğurlu Dövrə`.
5. **`Açılan Tarixçə Cədvəli` (Expandable Cycle History Accordion):**
   - Toggles open/closed showing `Dövrə #`, `Qazanc/Ziyan` (formatted with `formatUsd(..., true)`), `Max Drawdown`, `Tarix`, and status (`✓ UĞURLU`, `LİMİT HALT`, `LİMİT AŞILDI`, `AKTİV`).

- [ ] **Step 1: Write failing React tests in `apps/web/src/components/__tests__/PropFirmChallengeHUD.test.tsx`**

Test assertions:
1. Renders `"BƏLİ, QAZANCDASAN"` when `verdict === 'YES_PROFIT'`, `"XEYR, ZƏRƏRDƏSƏN"` with `-$120.00` (never `$-120.00`) when `verdict === 'NO_LOSS'`, and `"GÖZLƏMƏDƏ"` when `WAITING`.
2. Renders `$2,500` target bar, `$1,250` daily buffer, `$2,500` trailing buffer, `FLOOR LOCKED: $50,000` when `isFloorLocked === true`, and `needsTopUp` Faucet reminder banner when `liveWalletBalanceUsd === 4606.01`.
3. Expands the session history table (`Açılan Tarixçə Cədvəli`) on click and renders historical rows with `✓ UĞURLU` and `LİMİT HALT`.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx.cmd vitest run apps/web/src/components/__tests__/PropFirmChallengeHUD.test.tsx`
Expected: FAIL (`Cannot find module ../PropFirmChallengeHUD`).

- [ ] **Step 3: Implement API/WS/Store slices, `PropFirmChallengeHUD.tsx`, and mount in `App.tsx`**

- Update `apps/web/src/lib/apiClient.ts`, `apps/web/src/lib/wsClient.ts`, and `apps/web/src/store/useMarketStore.ts`.
- Create `apps/web/src/components/PropFirmChallengeHUD.tsx` implementing all 5 widgets and `formatUsd`.
- Update `apps/web/src/App.tsx`: wire `onPropFirmStatus` WS handler, invoke `refreshPropFirmStatus()` in bootstrap `useEffect`, and mount `<PropFirmChallengeHUD />` immediately above `<ConfluenceHUD />`.

- [ ] **Step 4: Run full monorepo verification (`tsc`, `eslint`, `vitest`, `build`)**

Run:
- `npx.cmd tsc --noEmit -p packages/shared/tsconfig.json && npx.cmd tsc --noEmit -p apps/server/tsconfig.json && npx.cmd tsc --noEmit -p apps/web/tsconfig.json`
- `npx.cmd eslint .`
- `npx.cmd vitest run`
- `npm.cmd run build`
Expected: All exit codes `0`, 100% tests pass, zero lint errors, Vite bundle clean.

- [ ] **Step 5: Live Port 3400 Deployment & Chrome DevTools Verification + Commit**

Restart TradeOS supervisor on `http://127.0.0.1:3400`, verify `/api/health`, `/api/propfirm/status`, `/api/propfirm/certificate` return `HTTP 200`, inspect rendered `<PropFirmChallengeHUD />` in Chrome DevTools (`take_screenshot` + `evaluate_script` confirming `"Doğurdan Qazanırammı?"` and zero `$-` malformed negative currencies), update `docs/designs/SITEMAP.md` + header status to `Implemented`, and commit cleanly.

```bash
git add apps/web/src/ docs/designs/SITEMAP.md docs/designs/prop-firm-50k-challenge-and-risk-guard.md
git commit -m "feat(web): add Upcomers 50K Challenge (Sadə Dildə) HUD and wire live telemetry"
```
