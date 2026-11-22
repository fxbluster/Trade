# TradeOS Decision Audit Trail & Counterfactual Shadow Tracking Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement a deterministic decision audit trail and crash-resilient counterfactual shadow tracking engine in TradeOS v2 to log every qualifying setup (>= 60%), evaluate simulated 1.5 ATR trades against closed 1m candles with a 0.15% friction haircut, and expose a downloadable daily session audit report in JSON and Markdown.

**Architecture:** A stateful rising-edge hysteresis latch captures decision snapshots directly to SQLite `decision_logs` via `node:sqlite`. Vetoed setups instantiate passive shadow records that evaluate lazily on incoming 1m closed candles where `(candle.time * 1000) >= setup.timestamp`. Production Auto-Pilot executions dispatch through a dedicated callback to write immediate audit records and disarm the latch. A protected REST endpoint `GET /api/audit/daily` streams dynamic summaries to the Cockpit HUD.

**Tech Stack:** TypeScript, Node.js `node:sqlite` (WAL mode), Polka HTTP server, Vitest, React, Tailwind CSS, Lucide icons.

**Spec:** [design_draft.md](file:///C:/Users/HP/TradeOS-v2/design_draft.md)

## Global Constraints

* Database: `node:sqlite` `DatabaseSync` in WAL mode with `PRAGMA busy_timeout = 5000;`. All repo writes must be direct and synchronous.
* Candle Timestamp Unit: `KlineCandle.time` is in Unix seconds. All comparisons against millisecond timestamps must use `(candle.time * 1000) >= setup.timestamp` and `(candle.time * 1000) >= expires_at`.
* Friction Haircut: 0.15% notional deduction ($\text{Friction USD} = \text{Margin USD} \times \text{Leverage} \times 0.0015$).
* TP Trigger Decoupling: Physical price contact terminates the setup immediately. If `Net PnL > 0` => `MISSED_PROFIT`; if `Net PnL <= 0` => `SAVED_CAPITAL`. Under no circumstance does a trade remain open after target price is touched.
* Intra-Bar Dual-Wick Conflict: Both SL and TP hit in the same candle => `RESOLVED_AMBIGUOUS_VOLATILITY` with `$0.00` Net PnL.
* Authentication: `GET /api/audit/daily` must be guarded by `requireSessionToken(SESSION_TOKEN)`.
* Zero Breaking Changes: Existing 23 test suites and 280+ tests must remain 100% green.

## Review Focus

1. **Intra-bar wick touches both SL and TP**: Verify `RESOLVED_AMBIGUOUS_VOLATILITY` is assigned with exactly $0.00 PnL and does not skew `capital_saved_usd` or `missed_profit_usd`.
2. **Sub-friction scratch trade touching TP**: Verify a trade that hits TP price where gross gain does not cover 0.15% friction is categorized as `SAVED_CAPITAL` (not `MISSED_PROFIT`).
3. **Birth candle look-behind bias**: Verify that closed candles whose timestamp precedes setup creation (`candle.time * 1000 < setup.timestamp`) are strictly ignored.
4. **Cross-symbol candle contamination**: Verify that a BTCUSDT 1m candle close event does not evaluate or alter pending SOLUSDT shadow setups.
5. **Auto-Pilot execution latch reset**: Verify that when Auto-Pilot fills an order, the hysteresis latch for `(symbol, side)` is immediately disarmed, preventing duplicate shadow setups on subsequent ticks.

---

### Task 1: Database Schema DDL & Shared Type Contracts

**Files:**
- Modify: `apps/server/src/db/schema.sql:85-89`
- Modify: `packages/shared/src/contracts.ts:390-422`
- Test: `packages/shared/src/__tests__/contracts.test.ts` (or build check)

**Interfaces:**
- Produces: `DecisionLogRecord`, `ShadowSetupStatus`, `DecisionAction`, `DailyAuditSummary`, `DailyAuditResponse` exported from `@tradeos/shared`.
- Database Table: `decision_logs` table with composite index `idx_decision_logs_sym_ts`.

- [ ] **Step 1: Write failing type test for shared contracts**

```typescript
// packages/shared/src/__tests__/decisionContracts.test.ts
import { describe, it, expect } from 'vitest';
import type {
  DecisionLogRecord,
  ShadowSetupStatus,
  DecisionAction,
  DailyAuditSummary,
  DailyAuditResponse,
} from '../contracts.js';

describe('Decision Audit Contracts', () => {
  it('validates contract structure', () => {
    const status: ShadowSetupStatus = 'SAVED_CAPITAL';
    const action: DecisionAction = 'BLOCKED';
    expect(status).toBe('SAVED_CAPITAL');
    expect(action).toBe('BLOCKED');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/shared/src/__tests__/decisionContracts.test.ts`
Expected: FAIL with "Cannot find module" or type error.

- [ ] **Step 3: Implement contract interfaces in `packages/shared/src/contracts.ts` and append `schema.sql`**

Append DDL to `apps/server/src/db/schema.sql`:
```sql
CREATE TABLE IF NOT EXISTS decision_logs (
    id TEXT PRIMARY KEY,
    timestamp INTEGER NOT NULL,
    symbol TEXT NOT NULL,
    side TEXT NOT NULL,
    action TEXT NOT NULL,
    composite_score REAL NOT NULL,
    pillars_json TEXT NOT NULL,
    macro_regime TEXT NOT NULL,
    macro_veto_active INTEGER DEFAULT 0,
    veto_reasons_json TEXT,
    execution_price REAL NOT NULL,
    margin_usd REAL NOT NULL,
    leverage INTEGER NOT NULL,
    atr REAL NOT NULL,
    trade_id TEXT REFERENCES trades(id) ON DELETE SET NULL,
    shadow_status TEXT,
    shadow_sl REAL,
    shadow_tp REAL,
    shadow_pnl_usd REAL,
    expires_at INTEGER,
    shadow_closed_at INTEGER,
    error_message TEXT,
    created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_decision_logs_ts ON decision_logs(timestamp);
CREATE INDEX IF NOT EXISTS idx_decision_logs_sym_ts ON decision_logs(symbol, timestamp);
CREATE INDEX IF NOT EXISTS idx_decision_logs_shadow ON decision_logs(shadow_status, expires_at);
```

Export TypeScript types in `packages/shared/src/contracts.ts`:
- `ShadowSetupStatus`
- `DecisionAction`
- `DecisionLogRecord`
- `DailyAuditSummary`
- `DailyAuditResponse`

- [ ] **Step 4: Build shared package and run test**

Run: `npm --workspace=@tradeos/shared run build && npx vitest run packages/shared/src/__tests__/decisionContracts.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/contracts.ts apps/server/src/db/schema.sql packages/shared/src/__tests__/decisionContracts.test.ts
git commit -m "feat(audit): add decision_logs DDL and shared TypeScript contracts"
```

---

### Task 2: SQLite Repository Implementation (`DecisionLogsRepo`)

**Files:**
- Modify: `apps/server/src/db/sqlite.ts:320-335`
- Test: `apps/server/src/db/__tests__/decisionLogsRepo.test.ts`

**Interfaces:**
- Consumes: `DatabaseSync` from `node:sqlite`, `DecisionLogRecord`, `ShadowSetupStatus`, `TradeSide` from `@tradeos/shared`.
- Produces: `DecisionLogsRepo` class with synchronous methods:
  - `insert(record: DecisionLogRecord): void`
  - `getOpenShadowSetups(symbol?: string): DecisionLogRecord[]`
  - `hasOpenShadowSetup(symbol: string, side: TradeSide): boolean`
  - `updateShadowOutcome(id: string, status: ShadowSetupStatus, pnlUsd: number, closedAt: number): void`
  - `listSessionDecisions(sinceMs: number): DecisionLogRecord[]`
  - `pruneOldRecords(retentionDays?: number): number`

- [ ] **Step 1: Write failing unit test for `DecisionLogsRepo`**

```typescript
// apps/server/src/db/__tests__/decisionLogsRepo.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { initializeDatabase, DecisionLogsRepo } from '../sqlite.js';
import type { DecisionLogRecord } from '@tradeos/shared';

describe('DecisionLogsRepo', () => {
  let repo: DecisionLogsRepo;

  beforeEach(() => {
    const db = initializeDatabase(':memory:');
    repo = new DecisionLogsRepo(db);
  });

  it('inserts and retrieves open shadow setups', () => {
    const record: DecisionLogRecord = {
      id: 'dec_1',
      timestamp: 1000,
      symbol: 'SOLUSDT',
      side: 'BUY',
      action: 'BLOCKED',
      composite_score: 65,
      pillars_json: '{}',
      macro_regime: 'MACRO_BULLISH',
      macro_veto_active: 1,
      veto_reasons_json: '["MACRO_VETO"]',
      execution_price: 70.0,
      margin_usd: 100,
      leverage: 10,
      atr: 1.0,
      trade_id: null,
      shadow_status: 'OPEN',
      shadow_sl: 68.5,
      shadow_tp: 71.5,
      shadow_pnl_usd: null,
      expires_at: 4600,
      shadow_closed_at: null,
      error_message: null,
      created_at: 1000,
    };

    repo.insert(record);
    const open = repo.getOpenShadowSetups('SOLUSDT');
    expect(open).toHaveLength(1);
    expect(open[0].id).toBe('dec_1');
    expect(repo.hasOpenShadowSetup('SOLUSDT', 'BUY')).toBe(true);
    expect(repo.hasOpenShadowSetup('SOLUSDT', 'SELL')).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run apps/server/src/db/__tests__/decisionLogsRepo.test.ts`
Expected: FAIL with "DecisionLogsRepo is not defined"

- [ ] **Step 3: Implement `DecisionLogsRepo` in `apps/server/src/db/sqlite.ts`**

Implement direct synchronous prepared statements for `insert`, `getOpenShadowSetups`, `hasOpenShadowSetup`, `updateShadowOutcome`, `listSessionDecisions`, and `pruneOldRecords`. Export `DecisionLogsRepo`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run apps/server/src/db/__tests__/decisionLogsRepo.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/db/sqlite.ts apps/server/src/db/__tests__/decisionLogsRepo.test.ts
git commit -m "feat(db): implement synchronous DecisionLogsRepo in SQLite"
```

---

### Task 3: Bounded Kline Range Query in `BinanceClient`

**Files:**
- Modify: `apps/server/src/exchange/binanceClient.ts:389-400`
- Test: `apps/server/src/exchange/__tests__/binanceClientKlines.test.ts`

**Interfaces:**
- Produces: Updated `getKlines(symbol: string, interval?: string, limit?: number, startTime?: number, endTime?: number): Promise<any[]>` supporting optional range bounds.

- [ ] **Step 1: Write failing unit test for `getKlines` range parameters**

```typescript
// apps/server/src/exchange/__tests__/binanceClientKlines.test.ts
import { describe, it, expect, vi } from 'vitest';
import { BinanceClient } from '../binanceClient.js';

describe('BinanceClient.getKlines range support', () => {
  it('forwards startTime and endTime when provided', async () => {
    const client = new BinanceClient({ apiKey: 'k', apiSecret: 's' });
    const spy = vi.spyOn(client as any, 'request').mockResolvedValue([]);

    await client.getKlines('SOLUSDT', '1m', 50, 1000000, 2000000);

    expect(spy).toHaveBeenCalledWith('/fapi/v1/klines', expect.objectContaining({
      params: expect.objectContaining({
        symbol: 'SOLUSDT',
        interval: '1m',
        limit: 50,
        startTime: 1000000,
        endTime: 2000000,
      }),
    }));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run apps/server/src/exchange/__tests__/binanceClientKlines.test.ts`
Expected: FAIL (params do not contain startTime/endTime).

- [ ] **Step 3: Update `getKlines` in `apps/server/src/exchange/binanceClient.ts`**

Add optional `startTime?: number` and `endTime?: number` parameters to `getKlines` and include them in `params` if defined.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run apps/server/src/exchange/__tests__/binanceClientKlines.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/exchange/binanceClient.ts apps/server/src/exchange/__tests__/binanceClientKlines.test.ts
git commit -m "feat(exchange): support startTime and endTime in BinanceClient.getKlines"
```

---

### Task 4: AutoPilotManager Order Dispatch Hook

**Files:**
- Modify: `apps/server/src/services/autoPilotManager.ts:23-35, 260-270, 380-388`
- Test: `apps/server/src/services/__tests__/autoPilotOrderHook.test.ts`

**Interfaces:**
- Consumes: `TradeSide`, `DecisionAction` from `@tradeos/shared`.
- Produces: `onOrderDispatched?: (event: { symbol: string; side: TradeSide; action: DecisionAction; price: number; marginUsd: number; leverage: number; atr: number; tradeId?: string; errorMessage?: string }) => void` in `AutoPilotManagerOptions`.

- [ ] **Step 1: Write failing unit test for `AutoPilotManager` dispatch callback**

```typescript
// apps/server/src/services/__tests__/autoPilotOrderHook.test.ts
import { describe, it, expect, vi } from 'vitest';
import { AutoPilotManager } from '../autoPilotManager.js';
import { initializeDatabase } from '../../db/sqlite.js';

describe('AutoPilotManager onOrderDispatched hook', () => {
  it('calls onOrderDispatched when order executes', async () => {
    const db = initializeDatabase(':memory:');
    const onOrderDispatched = vi.fn();
    const manager = new AutoPilotManager({
      db,
      tradeManager: { openPosition: vi.fn().mockResolvedValue({ id: 't_1', entry_price: 100 }) } as any,
      broker: { getAccount: vi.fn().mockResolvedValue({ walletBalance: 1000, availableBalance: 1000 }) } as any,
      confluenceEngine: { getSnapshot: vi.fn().mockReturnValue(null), liquidationEngine: { projectClusters: vi.fn().mockReturnValue([]) } } as any,
      getMarkPrice: () => 100,
      onOrderDispatched,
    } as any);

    await (manager as any).executeAutoEntry('SOLUSDT', 'BUY', 100);
    expect(onOrderDispatched).toHaveBeenCalledWith(expect.objectContaining({
      symbol: 'SOLUSDT',
      side: 'BUY',
      action: 'EXECUTED',
      tradeId: 't_1',
    }));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run apps/server/src/services/__tests__/autoPilotOrderHook.test.ts`
Expected: FAIL with `onOrderDispatched` not called.

- [ ] **Step 3: Modify `AutoPilotManager` in `apps/server/src/services/autoPilotManager.ts`**

Store `onOrderDispatched` option. In `executeAutoEntry`, invoke it upon successful `openPosition` with `action: 'EXECUTED'`. In catch block or failure checks, invoke with `action: 'FAILED'`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run apps/server/src/services/__tests__/autoPilotOrderHook.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/services/autoPilotManager.ts apps/server/src/services/__tests__/autoPilotOrderHook.test.ts
git commit -m "feat(autopilot): add onOrderDispatched audit notification hook"
```

---

### Task 5: DecisionAuditService Core Engine (TDD)

**Files:**
- Create: `apps/server/src/services/decisionAuditService.ts`
- Create: `apps/server/src/services/__tests__/decisionAuditService.test.ts`

**Interfaces:**
- Consumes: `DecisionLogsRepo`, `BinanceClient`, `ConfluenceSnapshot`, `KlineCandle`, `DailyAuditResponse`.
- Produces: `DecisionAuditService` with:
  - `evaluateSnapshot(snapshot: ConfluenceSnapshot, atr: number, markPrice: number): void`
  - `recordExecution(params: { symbol: string; side: TradeSide; action: DecisionAction; price: number; marginUsd: number; leverage: number; atr: number; tradeId?: string; errorMessage?: string }): void`
  - `onCandleClose(symbol: string, candle: KlineCandle): void`
  - `recoverDowntimeGaps(client: BinanceClient): Promise<void>`
  - `generateSessionSummary(sinceMs?: number): DailyAuditResponse`
  - `formatMarkdownReport(response: DailyAuditResponse): string`

- [ ] **Step 1: Write comprehensive test suite in `apps/server/src/services/__tests__/decisionAuditService.test.ts`**

Test scenarios:
1. Rising-edge latch arming (< 50% arms, >= 60% triggers, 180s cooldown blocks duplicate trigger).
2. Existing open shadow setup prevents second overlapping setup for same (symbol, side).
3. Production execution writes `EXECUTED` and resets latch state.
4. Long setup Stop-Loss trigger -> `SAVED_CAPITAL` with net PnL (including 0.15% friction haircut).
5. Long setup Take-Profit trigger -> `MISSED_PROFIT` with net PnL.
6. Short setup Stop-Loss trigger -> `SAVED_CAPITAL`.
7. Short setup Take-Profit trigger -> `MISSED_PROFIT`.
8. Scratch trade touching TP with net PnL <= 0 -> `SAVED_CAPITAL`.
9. Dual-wick in same candle -> `RESOLVED_AMBIGUOUS_VOLATILITY` ($0.00 PnL).
10. Expiration after 60m (`candle.time * 1000 >= expires_at`) -> `EXPIRED`.
11. Candle boundary: `candle.time * 1000 < setup.timestamp` is ignored.
12. Multi-symbol isolation: BTC candle does not trigger SOL shadow setups.
13. Summary aggregation: `capital_saved_usd`, `missed_profit_usd`, `expired_pnl_usd`, `net_risk_value_usd`.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run apps/server/src/services/__tests__/decisionAuditService.test.ts`
Expected: FAIL ("Cannot find module ../decisionAuditService.js")

- [ ] **Step 3: Implement `DecisionAuditService` in `apps/server/src/services/decisionAuditService.ts`**

Implement stateful hysteresis latch, lazy candle evaluation, valuation formulas with 0.15% friction, dual-wick detection, downtime recovery, and Markdown formatter.

- [ ] **Step 4: Run test to verify all 13 test scenarios pass**

Run: `npx vitest run apps/server/src/services/__tests__/decisionAuditService.test.ts`
Expected: PASS (100% tests passing)

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/services/decisionAuditService.ts apps/server/src/services/__tests__/decisionAuditService.test.ts
git commit -m "feat(audit): implement DecisionAuditService with counterfactual shadow tracking"
```

---

### Task 6: REST API Route & Server Wiring

**Files:**
- Modify: `apps/server/src/api/routes.ts:50-65, 300-330`
- Modify: `apps/server/src/index.ts:70-80, 255-270, 320-375, 410-445`
- Test: `apps/server/src/api/__tests__/dailyAuditRoute.test.ts`

**Interfaces:**
- Route: `GET /api/audit/daily?session=current&format=json|markdown`
- Security: Protected by `requireSessionToken(SESSION_TOKEN)`.

- [ ] **Step 1: Write failing route integration test**

```typescript
// apps/server/src/api/__tests__/dailyAuditRoute.test.ts
import { describe, it, expect, vi } from 'vitest';
import polka from 'polka';
import http from 'node:http';
import { registerRoutes } from '../routes.js';
import { SESSION_TOKEN } from '../../config.js';

describe('GET /api/audit/daily route', () => {
  it('returns JSON summary when authorized with session token', async () => {
    const app = polka();
    const mockAuditService = {
      generateSessionSummary: vi.fn().mockReturnValue({
        summary: { total_setups: 5, executed_trades: 1, blocked_setups: 4, capital_saved_usd: 30, missed_profit_usd: 10, expired_pnl_usd: 0, net_risk_value_usd: 20, veto_breakdown: { MACRO_VETO: 4 } },
        records: [],
        generated_at: Date.now(),
      }),
      formatMarkdownReport: vi.fn().mockReturnValue('# Daily Audit Report'),
    };

    registerRoutes(app, {
      decisionAuditService: mockAuditService,
    } as any);

    const server = http.createServer(app.handler);
    await new Promise<void>((r) => server.listen(0, r));
    const port = (server.address() as any).port;

    const res = await fetch(`http://127.0.0.1:${port}/api/audit/daily?session=current`, {
      headers: { Authorization: `Bearer ${SESSION_TOKEN}` },
    });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.summary.total_setups).toBe(5);

    server.close();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run apps/server/src/api/__tests__/dailyAuditRoute.test.ts`
Expected: FAIL (404 Not Found)

- [ ] **Step 3: Update `apps/server/src/api/routes.ts` and `apps/server/src/index.ts`**

In `routes.ts`:
- Add `decisionAuditService?: DecisionAuditService` to `AppContext`.
- Register `GET /api/audit/daily`. If `?format=markdown`, stream markdown with `Content-Type: text/markdown; charset=utf-8` and `Content-Disposition: attachment; filename="audit-<date>.md"`. Default: `application/json`.

In `index.ts`:
- Instantiate `DecisionLogsRepo` and `DecisionAuditService`.
- Pass `onOrderDispatched` to `AutoPilotManager`.
- Call `decisionAuditService.evaluateSnapshot(snapshot, atr, markPrice)` in 4Hz throttled tick handler.
- Call `decisionAuditService.onCandleClose(event.symbol, event.candle)` in `streamsManager.onKline` on 1m candle close (`event.isFinal && event.interval === '1m'`).
- Call `decisionAuditService.recoverDowntimeGaps(client)` after streams start.
- Pass `decisionAuditService` into `registerRoutes`.

- [ ] **Step 4: Run route test and verify it passes**

Run: `npx vitest run apps/server/src/api/__tests__/dailyAuditRoute.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/api/routes.ts apps/server/src/index.ts apps/server/src/api/__tests__/dailyAuditRoute.test.ts
git commit -m "feat(server): wire DecisionAuditService to tick stream, candle close, and REST endpoint"
```

---

### Task 7: Frontend HUD Integration (`apiClient.ts` & `TopBar.tsx`)

**Files:**
- Modify: `apps/web/src/lib/apiClient.ts:180-209`
- Modify: `apps/web/src/components/TopBar.tsx:145-165`

**Interfaces:**
- Produces: `apiClient.downloadDailyAudit(format?: 'json' | 'markdown', session?: string): Promise<void>`
- UI Component: Daily Audit download button with `FileText` icon in `TopBar.tsx`.

- [ ] **Step 1: Implement `downloadDailyAudit` in `apps/web/src/lib/apiClient.ts`**

```typescript
export async function downloadDailyAudit(
  format: 'json' | 'markdown' = 'markdown',
  session: string = 'current'
): Promise<void> {
  const token = await getSessionToken();
  const res = await fetch(`/api/audit/daily?session=${encodeURIComponent(session)}&format=${format}`, {
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });
  if (!res.ok) {
    throw new Error(`Failed to download daily audit: ${res.status} ${res.statusText}`);
  }
  const blob = await res.blob();
  const url = window.URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `audit-${new Date().toISOString().slice(0, 10)}.${format === 'json' ? 'json' : 'md'}`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  window.URL.revokeObjectURL(url);
}
```

- [ ] **Step 2: Add Daily Audit button to `apps/web/src/components/TopBar.tsx`**

Import `FileText` from `lucide-react`. Add a button adjacent to Scanner and 10k Sim buttons:
```tsx
{/* Daily Audit Export */}
<button
  onClick={async () => {
    try {
      await downloadDailyAudit('markdown', 'current');
    } catch (err: any) {
      console.error('Audit export failed:', err);
    }
  }}
  className="flex items-center space-x-1 px-2 py-1 rounded bg-[#020305] border border-[#151d2c] text-[#7d8590] hover:text-[#e6edf3] hover:border-[#7d8590] transition-colors"
  title="Download Daily Decision Audit & Shadow Report"
>
  <FileText className="w-3.5 h-3.5 text-[#0ecb81]" />
  <span className="hidden sm:inline">Daily Audit</span>
</button>
```

- [ ] **Step 3: Compile Web Bundle to verify zero build or lint errors**

Run: `npm --workspace=@tradeos/web run build`
Expected: Build successful (code 0).

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/lib/apiClient.ts apps/web/src/components/TopBar.tsx
git commit -m "feat(web): add Daily Audit report download button to Cockpit TopBar"
```

---

### Task 8: Full Monorepo Compilation & Test Suite Verification

**Files:**
- Entire codebase across `@tradeos/shared`, `@tradeos/server`, `@tradeos/web`.

- [ ] **Step 1: Run complete Vitest suite across all workspaces**

Run: `npx vitest run`
Expected: 24/24 test files pass, 300+ tests pass (100% success rate).

- [ ] **Step 2: Verify Monorepo compilation build**

Run: `npm run build`
Expected: All 3 workspaces compile with 0 TypeScript or bundling errors.

- [ ] **Step 3: Verify Live API Response**

Run: `curl -H "Authorization: Bearer test_token" http://127.0.0.1:3400/api/audit/daily?session=current`
Expected: HTTP 200 with JSON summary.

- [ ] **Step 4: Final Git Commit**

```bash
git add .
git commit -m "feat(audit): complete TradeOS Decision Audit Trail & Counterfactual Shadow Tracking Engine"
```
