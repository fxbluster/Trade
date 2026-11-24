# Next-Gen Quant Decision Telemetry, Autonomous Audit Trail & AI Continuous Learning Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the legacy 7-pillar telemetry and audit pipeline with continuous Modified Gram-Schmidt orthogonal alpha vector logging, 180s hysteresis/ring-buffered SQLite WAL persistence, real-time `FACTOR_TELEMETRY` WebSocket streaming to `AgentTelemetryPanel.tsx`, an `IDLE`-barrier-gated Bayesian decay calibration loop, and a `< 4,000`-token AI Markdown/JSON daily audit export.

**Architecture:** `ConfluenceEngine.evaluate()` remains pure (no SQLite coupling) and emits a structured `FactorTelemetryEvent` via `ConfluenceSnapshot.telemetryEvent` while `AutoPilotManager`/`ChasingExecutionEngine` emit execution/sizing snapshots (`SIGNAL_CONFIRMED`, `ORDER_AMENDED`, `POSITION_ENTERED`, `POSITION_EXITED`). `DecisionAuditService` enforces a 180s rising-edge latch for `SUB_THRESHOLD_IMPULSE`, buffers high-frequency `ORDER_AMENDED` events through a 500ms async ring-buffer into `factor_telemetry_records` and `decision_logs`, settles `1m`/`5m`/`15m`/`60m` MFE/MAE horizons on 1m candle closes, computes rolling Spearman IC/IR, feeds `StrategyDecayEngine` behind an `IDLE` synchronization barrier before updating `AlphaRegistry`, and broadcasts `< 4KB` `FACTOR_TELEMETRY` events over `WsHub` to a refactored `AgentTelemetryPanel.tsx`.

**Tech Stack:** TypeScript 5.7, Node.js (`node:sqlite` WAL, `node:worker_threads`), Polka, `ws`, Vitest, React 19, Zustand 5, Tailwind CSS, Lucide React, Vite 6.

**Spec:** [quant-decision-telemetry-and-ai-audit-pipeline.md](../../designs/quant-decision-telemetry-and-ai-audit-pipeline.md)

---

## Global Constraints

- **Workspace Sync (`@tradeos/shared`):** `node_modules/@tradeos/shared` is a physical directory, not a symlink. After modifying files in `packages/shared/src/`, always copy updated files into `node_modules/@tradeos/shared/src/` so `apps/server` and `apps/web` TypeScript/Vitest resolve the changes.
- **Zero Node Builtins in `@tradeos/shared`:** `packages/shared/src/` must contain zero imports of `node:sqlite`, `node:fs`, `node:path`, or other Node built-in modules to preserve browser bundling.
- **Backward-Compatible Contracts & Existing Tests:** Preserve existing required fields on `DecisionLogRecord` (`execution_price`, `pillars_json`, `shadow_status`, etc.) and `DailyAuditResponse` (`summary`, `records`, `generated_at`) so `decisionContracts.test.ts` and `decisionLogsRepo.test.ts` remain valid; extend with Next-Gen optional fields and new telemetry contracts.
- **SQLite PRAGMAs & Table Separation:** Configure `PRAGMA wal_autocheckpoint = 1000;` alongside `PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;`. Retain existing `factor_telemetry` (`FactorTelemetryRepo`) and `execution_chase_logs` (`ExecutionChaseLogsRepo`) tables untouched; add new `factor_telemetry_records` (`FactorTelemetryRecordsRepo`) and migrate `decision_logs` idempotently.
- **Latency & Payload Ceilings:** Telemetry JSON serialization $\le 1.5\text{ms}$; WebSocket `FACTOR_TELEMETRY` messages $\le 4\text{KB}$; `?format=markdown` audit report deterministically clamped $< 4{,}000$ tokens ($\le 14{,}000$ chars); zero synchronous SQLite writes on the tick/chasing amendment hot path.
- **Purge Legacy Cockpit Artifacts:** Zero occurrences of `P1`–`P7`, `P1 (Makro)`, `P6 (Momentum)`, `P7 (Xəbər)`, `${count}/7 Aktiv`, or the 5-second `setInterval` polling loop inside `AgentTelemetryPanel.tsx` and Next-Gen Markdown audit sections.
- **Verification Scripts:** Root `package.json` exposes `npm test` (`vitest run`), `npm run build` (`npm run build --workspaces`), `npm run check` (`tsc --noEmit && vitest run`), and eslint runs via `npx eslint .`. Live DOM verification targets `http://127.0.0.1:3400`.

## Review Focus

- **Foreign Key / Nullable `decision_log_id` Constraint Failure:** `SUB_THRESHOLD_IMPULSE` and `ORDER_AMENDED` events arrive with no parent `decision_logs` row (`decision_log_id = null`), while `PRAGMA foreign_keys = ON` enforces referential integrity. Schema and `FactorTelemetryRecordsRepo` must allow nullable `decision_log_id` while preserving `ON DELETE CASCADE` for non-null parent IDs (pinned in Task 2).
- **Ring-Buffer Overflow & Unflushed Terminal State Loss:** High-frequency `ORDER_AMENDED` events (>500 within 500ms) or server shutdown before the 500ms timer ticks must evict oldest non-terminal `ORDER_AMENDED` items instead of losing terminal transitions (`POSITION_ENTERED`, `POSITION_EXITED`, `FILLED`, `CANCELED`, `ABORTED`), and `dispose()` must synchronously drain pending batches before closing SQLite (pinned in Task 3).
- **Markdown Audit Context Window Explosion (`> 4,000` tokens):** Sessions with hundreds of records, long `error_message` strings, or verbose veto arrays will exceed 4,000 tokens if concatenated naively. Deterministic table capping (Top 5 best / Top 5 worst trades, truncated error snippets, excluded raw impulse streams, strict character ceiling $\le 14{,}000$ chars) guarantees $< 4{,}000$ tokens even under adversarial volume (pinned in Task 3).
- **Out-of-Order Candles, Zero-Variance Spearman IC & Expired `INCOMPLETE_FEED` Settlement:** Replay of pre-creation candles (`candle.time * 1000 < record.timestamp`), zero-variance factor series (`std = 0`), or disconnected market feeds lasting past the 1h horizon + grace window must avoid NaN/look-behind corruption and deterministically mark stale open horizons as `INCOMPLETE_FEED` (pinned in Task 3).
- **Mid-Chase Factor Weight Flip & Oversized/Malformed WebSocket Telemetry:** Applying decayed weights from `StrategyDecayEngine` while `AutoPilotManager.getState() === 'LIMIT_CHASING'` or `'POSITION_OPEN'` violates the `IDLE` synchronization barrier; weights must buffer until `IDLE`. On the client/WS edge, `WsHub` payloads $> 4\text{KB}$ must be compactly trimmed before send, and `useMarketStore` must safely ignore malformed events and cap the telemetry array at 50 entries (pinned in Tasks 4, 5, and 6).

---

### Task 1: Shared Telemetry Contracts & WebSocket Types

**Files:**
- Modify: `packages/shared/src/contracts.ts:252-296,76-100,417-472,730-745`
- Modify: `packages/shared/src/index.ts:1-33`
- Sync: `node_modules/@tradeos/shared/src/contracts.ts`, `node_modules/@tradeos/shared/src/index.ts`
- Test: `packages/shared/src/__tests__/contracts.test.ts:290-336`
- Test: `packages/shared/src/__tests__/decisionContracts.test.ts:1-108`

**Interfaces:**
- Consumes: `TradeSide`, `DecisionAction`, `MacroRegime`, `ConfluenceSnapshot` (`packages/shared/src/contracts.ts`)
- Produces:
  - `QuantConvictionArchetype`: `'SUB_THRESHOLD' | 'EXPLORATORY_PROBE' | 'STANDARD_INSTITUTIONAL' | 'HIGH_CONVICTION_CORE' | 'A_PLUS_INSTITUTIONAL'`
  - `FactorStateDetail`, `ChasingTelemetrySnapshot`, `SizingTelemetrySnapshot`, `FactorTelemetryTriggerType`, `FactorTelemetryEvent`, `FactorAttributionSummaryItem`, `FactorTelemetryRecordStatus` (`'EVALUATING' | 'SETTLED' | 'INCOMPLETE_FEED'`), `FactorTelemetryDbRecord`
  - Extended `DecisionLogRecord` (adds `factor_telemetry_json?`, `execution_chase_json?`, `sizing_breakdown_json?`, `noise_band_state?`)
  - Extended `DailyAuditSummary` & `DailyAuditResponse` (adds optional Next-Gen fields `date?`, `maker_fee_savings_usd?`, `win_rate?`, `gross_pnl_usd?`, `net_pnl_usd?`, `factor_telemetry_events?`, `factor_attribution_summary?`, `execution_chase_summary?`)
  - Extended `ConfluenceSnapshot` (`telemetryEvent?: FactorTelemetryEvent`)
  - Extended `WsServerMessage` (`| { type: 'FACTOR_TELEMETRY'; data: FactorTelemetryEvent }`)

- [ ] **Step 1: Write failing contract tests in `packages/shared/src/__tests__/contracts.test.ts` and `decisionContracts.test.ts`**

Add tests validating `FactorTelemetryEvent` shapes (`SUB_THRESHOLD_IMPULSE`..`POSITION_EXITED`), `FactorStateDetail`, `ChasingTelemetrySnapshot`, `SizingTelemetrySnapshot`, `WsServerMessage` `FACTOR_TELEMETRY` union, the 4 optional JSON/state columns on `DecisionLogRecord`, and `factor_telemetry_events` / `factor_attribution_summary` on `DailyAuditResponse`.

```typescript
// In packages/shared/src/__tests__/decisionContracts.test.ts
import type {
  FactorTelemetryEvent,
  FactorStateDetail,
  ChasingTelemetrySnapshot,
  SizingTelemetrySnapshot,
  WsServerMessage,
} from '../contracts.js';

it('supports Next-Gen JSON telemetry columns on DecisionLogRecord and attribution fields on DailyAuditResponse', () => {
  const factorDetail: FactorStateDetail = {
    factorId: 'ORDER_FLOW_L2',
    name: 'Order Flow L2',
    bias: 'BULLISH',
    rawAlpha: 0.78,
    orthogonalAlpha: 0.72,
    effectiveWeight: 0.546,
    isCollinear: false,
    confidence: 0.91,
    summaryText: 'Depth Imbalance 1.8x Bid',
  };
  const telemetryEvent: FactorTelemetryEvent = {
    timestamp: 1700000000000,
    symbol: 'SOLUSDT',
    triggerType: 'POSITION_ENTERED',
    markPrice: 145.5,
    compositeScore: 84,
    convictionArchetype: 'HIGH_CONVICTION_CORE',
    consensusSide: 'BUY',
    noiseBandActive: false,
    macroVetoActive: false,
    activeFactors: [factorDetail],
    collinearFactors: ['NATIVE_SMC', 'MACRO_REGIME'],
    chasingTelemetry: {
      orderId: 'chase-1',
      status: 'FILLED',
      anchorMarkPrice: 145.5,
      currentLimitPrice: 145.48,
      spreadPennyJumps: 2,
      amendmentCount: 2,
      durationMs: 840,
      realizedFeeUsd: 0.95,
      feeSavedVsTakerUsd: 1.42,
    },
    sizingTelemetry: {
      allocatedMarginUsd: 1200,
      allocatedMarginPct: 25.0,
      baseConvictionMargin: 0.21,
      quarterKellyMultiplier: 0.85,
      volatilityParityMultiplier: 1.1,
      circuitBreakerMultiplier: 1.0,
      solvencyAirbagOk: true,
    },
  };
  const wsMsg: WsServerMessage = { type: 'FACTOR_TELEMETRY', data: telemetryEvent };
  expect(wsMsg.type).toBe('FACTOR_TELEMETRY');
  expect(wsMsg.data.collinearFactors).toContain('NATIVE_SMC');

  const upgradedRecord: DecisionLogRecord = {
    id: 'dec-ng-1',
    timestamp: 1700000000000,
    symbol: 'SOLUSDT',
    side: 'BUY',
    action: 'EXECUTED',
    composite_score: 84,
    pillars_json: '[]',
    macro_regime: 'MACRO_BULLISH',
    macro_veto_active: 0,
    veto_reasons_json: null,
    execution_price: 145.48,
    margin_usd: 1200,
    leverage: 10,
    atr: 1.4,
    trade_id: 'tr-1',
    shadow_status: null,
    shadow_sl: null,
    shadow_tp: null,
    shadow_pnl_usd: null,
    expires_at: null,
    shadow_closed_at: null,
    error_message: null,
    created_at: 1700000000000,
    factor_telemetry_json: JSON.stringify(telemetryEvent.activeFactors),
    execution_chase_json: JSON.stringify(telemetryEvent.chasingTelemetry),
    sizing_breakdown_json: JSON.stringify(telemetryEvent.sizingTelemetry),
    noise_band_state: 0,
  };
  expect(upgradedRecord.noise_band_state).toBe(0);
});
```

- [ ] **Step 2: Run test to verify failure**

Run: `npx vitest run packages/shared/src/__tests__/decisionContracts.test.ts`
Expected: FAIL with TypeScript / module export errors (`FactorTelemetryEvent` is not exported from `../contracts.js`).

- [ ] **Step 3: Implement shared types in `packages/shared/src/contracts.ts`, re-export in `index.ts`, and sync `node_modules/@tradeos/shared/src/`**

1. In `packages/shared/src/contracts.ts`, export `QuantConvictionArchetype`, `FactorStateDetail`, `ChasingTelemetrySnapshot`, `SizingTelemetrySnapshot`, `FactorTelemetryTriggerType` (`'SUB_THRESHOLD_IMPULSE' | 'SIGNAL_CONFIRMED' | 'ORDER_AMENDED' | 'POSITION_ENTERED' | 'POSITION_EXITED'`), `FactorTelemetryEvent`, `FactorAttributionSummaryItem` (`factorId`, `name`, `empiricalHitRate`, `informationRatio`, `informationCoefficient`, `effectiveWeight`, `sampleSize`), `FactorTelemetryRecordStatus` (`'EVALUATING' | 'SETTLED' | 'INCOMPLETE_FEED'`), and `FactorTelemetryDbRecord` (matching `factor_telemetry_records` SQLite columns).
2. Extend `DecisionLogRecord` (`packages/shared/src/contracts.ts:252-276`) with optional `factor_telemetry_json?: string | null`, `execution_chase_json?: string | null`, `sizing_breakdown_json?: string | null`, `noise_band_state?: number`.
3. Extend `DailyAuditSummary` (`contracts.ts:278-288`) with optional `total_trades?: number`, `successful_trades?: number`, `failed_trades?: number`, `win_rate?: number`, `gross_pnl_usd?: number`, `maker_fee_savings_usd?: number`, `net_pnl_usd?: number`, and extend `DailyAuditResponse` (`contracts.ts:290-295`) with optional `date?: string`, `factor_telemetry_events?: FactorTelemetryEvent[]`, `factor_attribution_summary?: FactorAttributionSummaryItem[]`, `execution_chase_summary?: { totalFeeSavedUsd: number; totalChases: number; successfulChases: number }`.
4. Add `telemetryEvent?: FactorTelemetryEvent;` to `ConfluenceSnapshot` (`contracts.ts:76-100`).
5. Add `| { type: 'FACTOR_TELEMETRY'; data: FactorTelemetryEvent }` to `WsServerMessage` (`contracts.ts:417-471`).
6. Re-export all new types from `packages/shared/src/index.ts`.
7. Copy updated `packages/shared/src/*.ts` to `node_modules/@tradeos/shared/src/`.

- [ ] **Step 4: Run shared typecheck and tests to verify pass**

Run: `npx tsc --noEmit -p packages/shared/tsconfig.json && npx vitest run packages/shared`
Expected: `tsc` exits 0; all tests in `packages/shared` (including zero Node.js native imports check in `contracts.test.ts`) PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/contracts.ts packages/shared/src/index.ts packages/shared/src/__tests__/contracts.test.ts packages/shared/src/__tests__/decisionContracts.test.ts
git commit -m "feat(shared): add Next-Gen FactorTelemetryEvent, audit attribution, and FACTOR_TELEMETRY WS contracts"
```

---

### Task 2: SQLite WAL Persistence, Defensive Migrations & `FactorTelemetryRecordsRepo`

**Files:**
- Modify: `apps/server/src/db/schema.sql:1-5,94-123,225-232`
- Modify: `apps/server/src/db/sqlite.ts:1-110,468-571,1330-1341`
- Test (Create): `apps/server/src/db/__tests__/factorTelemetryRepo.test.ts`

**Interfaces:**
- Consumes: `DecisionLogRecord`, `FactorTelemetryEvent`, `FactorTelemetryDbRecord`, `FactorTelemetryRecordStatus` from `@tradeos/shared`; `runTransaction`, `DecisionLogsRepo` from `apps/server/src/db/sqlite.ts`
- Produces:
  - Updated `DecisionLogsRepo.insert(record: DecisionLogRecord): void` persisting `factor_telemetry_json`, `execution_chase_json`, `sizing_breakdown_json`, `noise_band_state`
  - Exported class `FactorTelemetryRecordsRepo(db: DatabaseSync)` with:
    - `insertEventBatch(event: FactorTelemetryEvent, decisionLogId?: string | null): number[]`
    - `getPendingEvaluations(symbol?: string): FactorTelemetryDbRecord[]`
    - `updateHorizonExcursions(id: number, patch: Partial<Pick<FactorTelemetryDbRecord, 'post_1m_mfe' | 'post_1m_mae' | 'post_5m_mfe' | 'post_5m_mae' | 'post_15m_mfe' | 'post_15m_mae' | 'post_1h_mfe' | 'post_1h_mae' | 'status' | 'settle_timestamp'>>): void`
    - `getSettledByFactor(factorId: string, limit?: number): FactorTelemetryDbRecord[]`
    - `listRecentEvents(sinceMs: number, limit?: number, offset?: number): FactorTelemetryEvent[]`
    - `pruneOldSubThresholdImpulses(retentionDays?: number): number`

- [ ] **Step 1: Write failing repository and migration tests in `apps/server/src/db/__tests__/factorTelemetryRepo.test.ts`**

Include tests covering:
1. Fresh DB creation sets `PRAGMA wal_autocheckpoint = 1000`, creates `factor_telemetry_records` table and `idx_factor_telemetry_factor_time` index, and creates all 4 new columns on `decision_logs`.
2. Defensive migration on a legacy pre-Next-Gen SQLite DB lacking the 4 columns on `decision_logs` and lacking `factor_telemetry_records` succeeds idempotently when re-running migrations (`ensureNextGenTelemetrySchema(db)` / `initializeDatabase`).
3. **Review Focus #1 (Nullable FK vs Cascade):** Inserting `SUB_THRESHOLD_IMPULSE` with `decisionLogId = null` succeeds under `PRAGMA foreign_keys = ON`, whereas linking a valid `decision_logs.id` cascades deletion cleanly when the parent `decision_logs` row is deleted.
4. `updateHorizonExcursions()` updates `post_1m_mfe`/`mae`, `post_5m_mfe`/`mae`, `post_15m_mfe`/`mae`, `post_1h_mfe`/`mae`, and sets `status = 'SETTLED'` or `'INCOMPLETE_FEED'`.
5. `pruneOldSubThresholdImpulses(7)` deletes `SUB_THRESHOLD_IMPULSE` rows older than 7 days while preserving `POSITION_ENTERED`/`SIGNAL_CONFIRMED` rows older than 7 days indefinitely.
6. `listRecentEvents(sinceMs, limit, offset)` reconstructs distinct `FactorTelemetryEvent[]` ordered newest-first with pagination.

- [ ] **Step 2: Run test to verify failure**

Run: `npx vitest run apps/server/src/db/__tests__/factorTelemetryRepo.test.ts`
Expected: FAIL with `"FactorTelemetryRecordsRepo is not exported"` / missing table errors.

- [ ] **Step 3: Implement schema upgrades and `FactorTelemetryRecordsRepo` in `apps/server/src/db/schema.sql` and `apps/server/src/db/sqlite.ts`**

1. In `schema.sql`:
   - Add `PRAGMA wal_autocheckpoint = 1000;` at line 4.
   - Add `factor_telemetry_json TEXT`, `execution_chase_json TEXT`, `sizing_breakdown_json TEXT`, `noise_band_state INTEGER DEFAULT 0` to `CREATE TABLE IF NOT EXISTS decision_logs`.
   - Append `CREATE TABLE IF NOT EXISTS factor_telemetry_records (...)` with `decision_log_id TEXT REFERENCES decision_logs(id) ON DELETE CASCADE`, `event_id TEXT NOT NULL`, `trigger_type TEXT NOT NULL`, `timestamp INTEGER NOT NULL`, `symbol TEXT NOT NULL`, `consensus_side TEXT NOT NULL`, `entry_price REAL NOT NULL`, `composite_score REAL NOT NULL`, `factor_id TEXT NOT NULL`, `raw_alpha REAL NOT NULL`, `orthogonal_alpha REAL NOT NULL`, `effective_weight REAL NOT NULL`, `is_collinear INTEGER NOT NULL`, `confidence REAL DEFAULT 0`, `summary_text TEXT`, `telemetry_payload_json TEXT`, `status TEXT DEFAULT 'EVALUATING'`, `settle_timestamp INTEGER`, and the 8 `post_*_mfe`/`mae` `REAL` columns, plus `idx_factor_telemetry_factor_time ON factor_telemetry_records (factor_id, timestamp)` and `idx_factor_telemetry_status ON factor_telemetry_records (status, symbol, timestamp)`.
2. In `sqlite.ts:initializeDatabase()`:
   - Execute `PRAGMA wal_autocheckpoint = 1000;`.
   - Add idempotent `ALTER TABLE decision_logs ADD COLUMN ...` statements wrapped in `try {} catch {}` for the 4 new columns and `CREATE TABLE IF NOT EXISTS factor_telemetry_records ...` migration block so existing on-disk databases upgrade safely on boot.
3. Update `DecisionLogsRepo.insert()` (`sqlite.ts:474-516`) to include `factor_telemetry_json`, `execution_chase_json`, `sizing_breakdown_json`, and `noise_band_state` (defaulting to `null` / `0`).
4. Implement `FactorTelemetryRecordsRepo` in `sqlite.ts`:
   - `insertEventBatch()` inserts one row per active factor AND one entry per collinear factor (or stores full `FactorTelemetryEvent` JSON on the primary/first row's `telemetry_payload_json` column so `listRecentEvents` reconstructs exact `FactorTelemetryEvent` objects including `chasingTelemetry`, `sizingTelemetry`, `collinearFactors`, and `activeFactors` in one query without losing collinear lists even when `activeFactors` is empty!). Note: if `activeFactors` is empty and no collinear factors exist, insert a single synthetic `'COMPOSITE'` factor row so the event is never dropped.

- [ ] **Step 4: Run repository tests to verify pass**

Run: `npx vitest run apps/server/src/db/__tests__/factorTelemetryRepo.test.ts apps/server/src/db/__tests__/decisionLogsRepo.test.ts apps/server/test/sqlitePersistence.test.ts`
Expected: PASS (100% pass across all 3 database test suites).

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/db/schema.sql apps/server/src/db/sqlite.ts apps/server/src/db/__tests__/factorTelemetryRepo.test.ts
git commit -m "feat(db): add factor_telemetry_records table, WAL autocheckpoint pragma, and defensive decision_logs migrations"
```

---

### Task 3: `DecisionAuditService` Upgrade — Hysteresis Latch, Ring-Buffer Micro-Batching, Horizon MFE/MAE & Spearman IC/IR, Gap Recovery & 4K-Token Markdown Report

**Files:**
- Modify: `apps/server/src/services/decisionAuditService.ts:1-556`
- Modify: `apps/server/src/services/__tests__/decisionAuditService.test.ts:1-683`

**Interfaces:**
- Consumes: `DecisionLogsRepo`, `PillarTelemetryRepo` (optional legacy fallback), `FactorTelemetryRecordsRepo`, `ExecutionChaseLogsRepo` (`apps/server/src/db/sqlite.ts`); `FactorTelemetryEvent`, `FactorAttributionSummaryItem`, `DailyAuditResponse`, `KlineCandle`, `ConfluenceSnapshot` (`@tradeos/shared`); `BinanceClient`
- Produces:
  - Exported pure helper `computeSpearmanIC(predictions: number[], outcomes: number[]): number`
  - Exported pure helper `estimateTokenCount(text: string): number` and `clampMarkdownToTokenBudget(markdown: string, maxTokens?: number): string`
  - Extended `RecordExecutionParams` accepting optional `factorTelemetryJson?`, `executionChaseJson?`, `sizingBreakdownJson?`, `noiseBandState?`
  - `DecisionAuditService`:
    - Updated backward-compatible constructor `constructor(repoOrDb, pillarRepo?, options?: { factorTelemetryRecordsRepo?: FactorTelemetryRecordsRepo; executionChaseLogsRepo?: ExecutionChaseLogsRepo; flushIntervalMs?: number; maxRingBufferSize?: number; onTelemetryEvent?: (event: FactorTelemetryEvent) => void; horizonGraceMs?: number })`
    - `recordFactorTelemetry(event: FactorTelemetryEvent, decisionLogId?: string | null): boolean` (180s rising-edge hysteresis on `SUB_THRESHOLD_IMPULSE`, async ring-buffer queuing for `ORDER_AMENDED`, micro-batch flushing on terminal events / 500ms timer, calls `onTelemetryEvent`)
    - `flushTelemetryBuffer(): number`
    - `onCandleClose(symbol: string, candle: KlineCandle): void` (settles shadow setups + settles `1m`/`5m`/`15m`/`60m` `factor_telemetry_records` horizons + marks overdue disconnected records `'INCOMPLETE_FEED'`)
    - `recoverDowntimeGaps(client: BinanceClient): Promise<void>` (reconciles both open shadow setups and `'EVALUATING'` `factor_telemetry_records`)
    - `generateSessionSummary(sinceMs?: number, opts?: { limit?: number; offset?: number }): DailyAuditResponse`
    - `formatMarkdownReport(response: DailyAuditResponse): string` (clamped $< 4{,}000$ tokens, zero `P1`–`P7`, includes Factor Attribution IC/IR matrix, Maker Execution Attribution, and Top 5 Best / Worst Trade Deep-Dives)
    - `pruneExpiredImpulses(retentionDays?: number): number` & `dispose(): void`

- [ ] **Step 1: Write failing Next-Gen audit service tests in `apps/server/src/services/__tests__/decisionAuditService.test.ts`**

Preserve existing tests 1–14 intact; update Test 15 to verify Next-Gen `factor_telemetry_records` attribution instead of legacy `P1:`–`P7:` Markdown rows, and add Tests 16–20 covering:
1. `recordFactorTelemetry()` enforces 180s hysteresis latch for `SUB_THRESHOLD_IMPULSE` per `(symbol, consensusSide)` while bypassing hysteresis for `POSITION_ENTERED` / `SIGNAL_CONFIRMED`, and routes `ORDER_AMENDED` into the in-memory ring buffer without synchronous SQLite writes until `500ms` timer or `flushTelemetryBuffer()` fires.
2. **Review Focus #2 (Overflow & Terminal Preservation):** Pushing 550 `ORDER_AMENDED` events then 1 `POSITION_ENTERED` event into a 500-capacity buffer evicts oldest non-terminal `ORDER_AMENDED` events, flushes terminal `POSITION_ENTERED` reliably, and `dispose()` flushes remaining buffered items before teardown.
3. `computeSpearmanIC()` and `onCandleClose()`: settling `1m`, `5m`, `15m`, and `60m` MFE/MAE across a 60-bar synthetic series computes exact Spearman rank IC (`+1.0` on monotonic alignment, `-1.0` on inverted, `0` on constant zero-variance series) and empirical `informationRatio`.
4. **Review Focus #4 (`INCOMPLETE_FEED` & Look-Behind Guard):** Candles older than `record.timestamp` are ignored; a candle arriving past `timestamp + 3_600_000 + horizonGraceMs` when intermediate horizons never settled transitions the pending record to `INCOMPLETE_FEED`; `recoverDowntimeGaps()` replays Binance klines to settle `'EVALUATING'` factor records after boot.
5. **Review Focus #3 (Token Budget & Zero Legacy Tags):** Generating `formatMarkdownReport()` with 300 decision rows, 500-character error messages, and 150 `sub_threshold_impulses` produces valid Markdown strictly $< 4{,}000$ tokens (`estimateTokenCount(md) <= 4000`, `md.length <= 14_000`), omits raw impulse tables, contains zero `P1`–`P7` strings, and still retains Executive Summary, Orthogonal Factor Matrix (`IC`, `IR`), Execution Attribution, and Top 5 Best / Top 5 Worst Trades.

- [ ] **Step 2: Run test to verify failure**

Run: `npx vitest run apps/server/src/services/__tests__/decisionAuditService.test.ts`
Expected: FAIL because `recordFactorTelemetry`, `flushTelemetryBuffer`, `computeSpearmanIC`, and Next-Gen `formatMarkdownReport` methods do not exist yet.

- [ ] **Step 3: Implement Next-Gen `DecisionAuditService` in `apps/server/src/services/decisionAuditService.ts`**

1. Export `computeSpearmanIC(predictions: number[], outcomes: number[]): number` using average fractional tie-ranks:
   $$\rho = \frac{\sum (r_x - \bar{r}_x)(r_y - \bar{r}_y)}{\sqrt{\sum (r_x - \bar{r}_x)^2 \sum (r_y - \bar{r}_y)^2}}$$
   Return `0` if `n < 2` or denominator $< 10^{-12}$.
2. Implement 500ms ring buffer (`TelemetryQueueItem`) in `DecisionAuditService`:
   - Start `setInterval(..., flushIntervalMs).unref()` when `factorTelemetryRecordsRepo` is configured and `flushIntervalMs > 0`.
   - When `buffer.length >= maxRingBufferSize`, evict the first `'ORDER_AMENDED'` item (never evicting terminal items).
   - Schedule async flush via `queueMicrotask` / timer on terminal trigger types (`'SIGNAL_CONFIRMED'`, `'POSITION_ENTERED'`, `'POSITION_EXITED'`, or `chasingTelemetry?.status` in `['FILLED', 'CANCELED', 'ABORTED']`).
   - Emit `onTelemetryEvent?.(event)` safely inside `try/catch`.
3. Implement `SUB_THRESHOLD_IMPULSE` 180s latch separate from shadow setup latch (or sharing clean per-`(symbol, consensusSide)` timestamp map) so repeated 4Hz ticks do not spam SQLite, while also allowing `evaluateSnapshot()` to attach `snapshot.factorDetails`, `snapshot.noiseBand`, etc. into `decision_logs`'s new JSON columns!
4. Extend `onCandleClose(symbol, candle)` to settle `'EVALUATING'` `factor_telemetry_records` (`1m` @ 60s, `5m` @ 300s, `15m` @ 900s, `60m` @ 3600s), updating cumulative MFE/MAE from `entry_price` for `'BUY'`/`'SELL'` (skipping `candleMs < record.timestamp`), marking `'SETTLED'` at `>= 60m`, or `'INCOMPLETE_FEED'` when `candleMs > record.timestamp + 3_600_000 + horizonGraceMs` if earlier horizons are missing.
5. Upgrade `generateSessionSummary()` and `formatMarkdownReport()`:
   - Aggregate `factor_attribution_summary` from settled `FactorTelemetryRecordsRepo` rows (`empiricalHitRate`, Spearman `informationCoefficient` over rolling `N = 60`, `informationRatio`, `effectiveWeight`).
   - Include `execution_chase_summary` from `ExecutionChaseLogsRepo.getFeeSavings(undefined, sinceMs)`.
   - Populate `factor_telemetry_events` paginated by `limit`/`offset`.
   - Build `formatMarkdownReport()` with Executive Summary (retaining `| Capital Saved | ... |`, `| Missed Profit | ... |`, `| **Net Risk Value** | ... |` rows expected by tests 13!), Veto Breakdown, Orthogonal Factor Attribution Matrix, Trade Execution Attribution Table, Top 5 Profitable & Top 5 Worst-Slippage Trade Deep-Dives (with cell truncation), and hard `clampMarkdownToTokenBudget(md, 4000)` clamping to $\le 14{,}000$ chars. Remove all `P1:`–`P7:` vote formatting and raw `sub_threshold_impulses` tables from Markdown!

- [ ] **Step 4: Run `DecisionAuditService` tests to verify pass**

Run: `npx vitest run apps/server/src/services/__tests__/decisionAuditService.test.ts`
Expected: PASS (all 19+ tests in `decisionAuditService.test.ts` PASS).

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/services/decisionAuditService.ts apps/server/src/services/__tests__/decisionAuditService.test.ts
git commit -m "feat(audit): implement hysteresis telemetry ingestion, ring-buffer flusher, horizon IC/IR tracker, and 4k-token Markdown audit"
```

---

### Task 4: `AlphaRegistry` Calibrated Weight Overrides & `StrategyDecayEngine` `IDLE` Synchronization Barrier

**Files:**
- Modify: `apps/server/src/quant/alphaRegistry.ts:75-268`
- Modify: `apps/server/src/quant/strategyDecayEngine.ts:98-305`
- Test: `apps/server/test/alphaRegistry.test.ts`
- Test: `apps/server/test/strategyDecay.test.ts`

**Interfaces:**
- Consumes: `AlphaRegistry`, `dirichletPosterior` (`apps/server/src/quant/alphaRegistry.ts`); `StrategyDecayEngine`, `FactorDecayState` (`apps/server/src/quant/strategyDecayEngine.ts`); `AutoPilotState` (`@tradeos/shared`)
- Produces:
  - `AlphaRegistry.setCalibratedWeight(factorId: string, weight: number): void`
  - `AlphaRegistry.applyCalibratedWeights(weights: Record<string, number>): void`
  - `AlphaRegistry.getCalibratedWeight(factorId: string): number`
  - `StrategyDecayEngine.getPendingWeightUpdates(): Record<string, number>`
  - `StrategyDecayEngine.flushPendingWeightsIfIdle(autoPilotState: AutoPilotState | string, applyFn: (weights: Record<string, number>) => void): boolean`

- [ ] **Step 1: Write failing tests for calibrated weights and `IDLE` synchronization barrier in `apps/server/test/alphaRegistry.test.ts` and `apps/server/test/strategyDecay.test.ts`**

Add assertions verifying:
1. `AlphaRegistry.applyCalibratedWeights({ ORDER_FLOW_L2: 0.05 })` shifts posterior synthesis away from decayed factor weights (preserving $\ge 0.05$ floor and normalization sum $= 1.0$).
2. **Review Focus #5 (IDLE Barrier):** When `StrategyDecayEngine.updateFactor()` triggers CUSUM decay (`S_k > 4.0 * sigma`), calling `flushPendingWeightsIfIdle('LIMIT_CHASING', applyFn)` or `'POSITION_OPEN'` returns `false` and does NOT invoke `applyFn`; subsequent call with `'IDLE'` returns `true`, invokes `applyFn` once with the decayed weights, and empties `getPendingWeightUpdates()`.

- [ ] **Step 2: Run tests to verify failure**

Run: `npx vitest run apps/server/test/alphaRegistry.test.ts apps/server/test/strategyDecay.test.ts`
Expected: FAIL (`applyCalibratedWeights` / `flushPendingWeightsIfIdle` is not a function).

- [ ] **Step 3: Implement weight calibration overrides in `alphaRegistry.ts` and `IDLE` barrier queue in `strategyDecayEngine.ts`**

1. In `alphaRegistry.ts`: add `private readonly calibratedWeights: Map<string, number> = new Map()`, seeded in `registerFactor(factor)` with `factor.defaultWeight`; add `setCalibratedWeight` / `applyCalibratedWeights` / `getCalibratedWeight`; update `evaluate()` line 206 so `dirichletPosterior(...)` receives `this.getCalibratedWeight(e.factor.id)` instead of frozen `e.factor.defaultWeight`.
2. In `strategyDecayEngine.ts`: add `private readonly pendingWeightUpdates: Map<string, number> = new Map()`; inside `updateFactor()` when `triggered === true` (and `setFactorWeight`), record `this.pendingWeightUpdates.set(factorId, state.currentWeight)`; implement `getPendingWeightUpdates()` and `flushPendingWeightsIfIdle(autoPilotState, applyFn)`.

- [ ] **Step 4: Run tests to verify pass**

Run: `npx vitest run apps/server/test/alphaRegistry.test.ts apps/server/test/strategyDecay.test.ts`
Expected: PASS (100%).

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/quant/alphaRegistry.ts apps/server/src/quant/strategyDecayEngine.ts apps/server/test/alphaRegistry.test.ts apps/server/test/strategyDecay.test.ts
git commit -m "feat(quant): add calibrated weight synthesis to AlphaRegistry and IDLE sync barrier to StrategyDecayEngine"
```

---

### Task 5: `ConfluenceEngine` Telemetry Synthesis, Execution Routing, `WsHub` Broadcast, AI Audit API & Server Wiring

**Files:**
- Modify: `apps/server/src/quant/confluenceEngine.ts:158-375`
- Modify: `apps/server/src/services/chasingExecutionEngine.ts:134-150`
- Modify: `apps/server/src/services/autoPilotManager.ts:1-60,627-895,1130-1161`
- Modify: `apps/server/src/api/wsHub.ts:280-335`
- Modify: `apps/server/src/api/routes.ts:585-612`
- Modify: `apps/server/src/index.ts:108-140,258-276,353-380,455-555,833-863`
- Modify: `apps/server/src/api/__tests__/dailyAuditRoute.test.ts:1-180`
- Modify: `apps/server/test/autoPilotIntegration.test.ts`

**Interfaces:**
- Consumes: `FactorTelemetryEvent`, `FactorStateDetail`, `QuantConvictionArchetype`, `DailyAuditResponse`, `SizingBreakdown` (`@tradeos/shared`); `DecisionAuditService` (Task 3); `FactorTelemetryRecordsRepo` (Task 2); `StrategyDecayEngine.flushPendingWeightsIfIdle` & `AlphaRegistry.applyCalibratedWeights` (Task 4)
- Produces:
  - `ConfluenceEngine.evaluate()` attaching `telemetryEvent: FactorTelemetryEvent` onto `ConfluenceSnapshot`
  - `WsHub.broadcastFactorTelemetry(event: FactorTelemetryEvent): void` (`<= 4096` byte guard)
  - `AutoPilotManagerOptions.onTelemetryEvent?: (event: FactorTelemetryEvent) => void` + `onStateTransition?: (newState: AutoPilotState) => void`
  - `GET /api/audit/daily` supporting `session=current|all`, `format=json|markdown`, `limit`, `offset`

- [ ] **Step 1: Write failing route, WS hub payload limit, and integration tests in `dailyAuditRoute.test.ts` and `autoPilotIntegration.test.ts`**

Add tests verifying:
1. `GET /api/audit/daily?format=json&limit=2&offset=1` forwards pagination options to `generateSessionSummary(sinceMs, { limit: 2, offset: 1 })`.
2. `GET /api/audit/daily?format=markdown` returns `< 4,000` tokens when served from a real `DecisionAuditService`.
3. `WsHub.broadcastFactorTelemetry(oversizedEvent)` trims `summaryText` / bounds payload strictly $\le 4{,}096$ bytes (checking serialized payload length!) and emits `{ type: 'FACTOR_TELEMETRY', data }` (**Review Focus #5**).
4. `AutoPilotManager` dispatches `'SIGNAL_CONFIRMED'`, `'ORDER_AMENDED'`, `'POSITION_ENTERED'` (containing `chasingTelemetry` and `sizingTelemetry`), and `'POSITION_EXITED'` events via `onTelemetryEvent` and fires `onStateTransition('IDLE')` on position close.

- [ ] **Step 2: Run tests to verify failure**

Run: `npx vitest run apps/server/src/api/__tests__/dailyAuditRoute.test.ts apps/server/test/autoPilotIntegration.test.ts`
Expected: FAIL (`broadcastFactorTelemetry` undefined / missing `telemetryEvent` hook).

- [ ] **Step 3: Implement wiring across `confluenceEngine.ts`, `wsHub.ts`, `autoPilotManager.ts`, `routes.ts`, and `index.ts`**

1. **`confluenceEngine.ts`:** Build helper `synthesizeTelemetryEvent(...)` producing `FactorTelemetryEvent` with `convictionArchetype` mapped from `compositeScore` (`<70`, `70-74`, `75-84`, `85-94`, `>=95`), `activeFactors` from `alphaEval.details` (or non-legacy mapped factor descriptors with concise `summaryText`), `collinearFactors` array (`details.filter(d => d.isCollinear).map(d => d.name)`), `noiseBandActive`, `macroVetoActive`, `macroVetoReason`, and set `snapshot.telemetryEvent`.
2. **`wsHub.ts`:** Implement `broadcastFactorTelemetry(event: FactorTelemetryEvent)` compacting `summaryText` if `Buffer.byteLength(json, 'utf8') > 4096` before calling `this.broadcast({ type: 'FACTOR_TELEMETRY', data: compactEvent })`.
3. **`autoPilotManager.ts`:** Accept `onTelemetryEvent` and `onStateTransition` in `AutoPilotManagerOptions`. Emit `'SIGNAL_CONFIRMED'`, forward chasing progress as `'ORDER_AMENDED'` (`chasingTelemetry` mapped from `ChasingOrderState` + `spreadPennyJumps` / `feeSavedVsTakerUsd`), emit `'POSITION_ENTERED'` with full `chasingTelemetry` & `sizingTelemetry` on fill, and emit `'POSITION_EXITED'` + `onStateTransition('IDLE')` inside `handlePositionClosed` / `resetCooldown`. Pass serialized `factorTelemetryJson`, `executionChaseJson`, `sizingBreakdownJson`, `noiseBandState` inside `onOrderDispatched` so `DecisionAuditService.recordExecution()` persists full vectors into `decision_logs`!
4. **`routes.ts`:** Parse `limit` and `offset` on `GET /api/audit/daily` (`parseInt` with finite bounds `limit in [1, 200]`, `offset >= 0`) and pass to `ctx.decisionAuditService.generateSessionSummary(sinceMs, opts)`.
5. **`index.ts`:** Instantiate `FactorTelemetryRecordsRepo(db)`, wire into `DecisionAuditService` alongside `executionChaseLogsRepo` and `onTelemetryEvent: (ev) => wsHub.broadcastFactorTelemetry(ev)`, route `confluenceSnapshot.telemetryEvent` into `decisionAuditService.recordFactorTelemetry`, wire `autoPilotManager` telemetry + `IDLE` barrier flushing `strategyDecayEngine.flushPendingWeightsIfIdle(...)` into `alphaRegistry.applyCalibratedWeights(...)`, schedule daily pruning `setInterval(..., 3_600_000).unref()`, and call `decisionAuditService.dispose()` in `close()`.

- [ ] **Step 4: Run server test suite to verify pass**

Run: `npx tsc --noEmit -p apps/server/tsconfig.json && npx vitest run apps/server/src/api/__tests__/dailyAuditRoute.test.ts apps/server/test/autoPilotIntegration.test.ts apps/server/src/quant/__tests__/confluenceEngine.test.ts apps/server/src/services/__tests__/autoPilotManager.test.ts`
Expected: PASS (0 TS errors; 100% pass).

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/quant/confluenceEngine.ts apps/server/src/services/autoPilotManager.ts apps/server/src/api/wsHub.ts apps/server/src/api/routes.ts apps/server/src/index.ts apps/server/src/api/__tests__/dailyAuditRoute.test.ts apps/server/test/autoPilotIntegration.test.ts
git commit -m "feat(server): wire FactorTelemetryEvent synthesis, WS broadcast, execution routing, and IDLE decay barrier"
```

---

### Task 6: Presentation Tier Refactor — `AgentTelemetryPanel.tsx`, WebSocket Sliding Buffer & Zero Legacy Tags

**Files:**
- Modify: `apps/web/src/lib/wsClient.ts:15-71,185-196`
- Modify: `apps/web/src/store/useMarketStore.ts:46-83,135-155,321-365`
- Modify: `apps/web/src/App.tsx:70-82`
- Modify: `apps/web/src/components/AgentTelemetryPanel.tsx:1-459`
- Test (Create): `apps/web/src/components/__tests__/AgentTelemetryPanel.test.tsx`

**Interfaces:**
- Consumes: `FactorTelemetryEvent`, `DailyAuditResponse`, `QuantConvictionArchetype` (`@tradeos/shared`); `apiClient.getDailyAudit` (`apps/web/src/lib/apiClient.ts`); `wsClient` (`apps/web/src/lib/wsClient.ts`); `useMarketStore` (`apps/web/src/store/useMarketStore.ts`)
- Produces:
  - `WsClient` `onFactorTelemetry?: (event: FactorTelemetryEvent) => void` handler
  - `useMarketStore`: `telemetryEvents: FactorTelemetryEvent[]`, `setTelemetryEvents`, `addTelemetryEvent` (bounded 50-item sliding window)
  - Refactored `AgentTelemetryPanel` component (0 `setInterval` timers, 0 `P1`–`P7` strings, 0 `${n}/7 Aktiv` tags)

- [ ] **Step 1: Write failing UI and store tests in `apps/web/src/components/__tests__/AgentTelemetryPanel.test.tsx`**

Test assertions:
1. On mount, calls `apiClient.getDailyAudit('current')` ONCE to bootstrap historical `factor_telemetry_events`; advancing fake timers by `30_000ms` triggers ZERO repeated `getDailyAudit` polling calls!
2. Renders `Orthogonal Quant Conviction` header score badge (`Score: 84% (High-Conviction Core)`), `Noise Band: CLEAR` / `ACTIVE` badge, independent factor badges with Gram-Schmidt weights (`Order Flow L2`, `54.6% wt`, `BULLISH`), and grouped `[COLLINEAR]:` tag for suppressed factors (`Native SMC, Macro Regime`).
3. Expanding a row toggles execution telemetry accordion (`Maker Chasing`: amendments, duration, `feeSavedVsTakerUsd`) and dynamic sizing breakdown (`Margin`, `Kelly`, `Vol Parity`).
4. **Review Focus #5 (Sliding Window & Zero Legacy Strings):** Dispatching 60 `addTelemetryEvent` WS updates keeps `useMarketStore.getState().telemetryEvents` bounded at 50 items, ignores malformed/null payloads without throwing, and rendered `container.textContent` contains ZERO matches for `/\bP[1-7]\b/` or `/\d+\/7\s*Aktiv/i` or `Makro` / `Xəbər`.

- [ ] **Step 2: Run test to verify failure**

Run: `npx vitest run apps/web/src/components/__tests__/AgentTelemetryPanel.test.tsx`
Expected: FAIL (`setTelemetryEvents` missing / DOM still renders legacy `P1..P7` and `4/7 Aktiv` / polling interval triggers extra fetches).

- [ ] **Step 3: Implement WebSocket sliding window and refactor `AgentTelemetryPanel.tsx`**

1. **`wsClient.ts`:** Add `onFactorTelemetry?: (data: FactorTelemetryEvent) => void` to `MessageHandlers` and handle `case 'FACTOR_TELEMETRY'` cleanly.
2. **`useMarketStore.ts`:** Add `telemetryEvents: []`, `setTelemetryEvents(events)` (sanitizing & slicing to 50 items newest-first), and `addTelemetryEvent(event)` (validating non-null `event.symbol` & `Array.isArray(event.activeFactors)`, prepending and `.slice(0, 50)`).
3. **`App.tsx`:** Pass `onFactorTelemetry: (ev) => useMarketStore.getState().addTelemetryEvent(ev)` in `wsClient.setHandlers`.
4. **`AgentTelemetryPanel.tsx`:**
   - Remove the `setInterval(..., 5000)` `useEffect` and `autoRefresh` polling state completely.
   - Bootstrap initial events on mount via `apiClient.getDailyAudit('current')` -> `setTelemetryEvents(resp.factor_telemetry_events ?? [])`. Keep manual `Yenilə` button + `sideFilter` (`ALL` / `BUY` / `SELL`) + dock/expand layout buttons (`Aşağı Keçir` / `Sağa Keçir` / `Böyüt`).
   - Display `Orthogonal Quant Conviction` score + archetype label, `Noise Band: CLEAR | ACTIVE`, `MACRO VETO` badge, independent factor badges (`name`, `${(f.effectiveWeight * 100).toFixed(1)}% wt`, `f.bias`), `[COLLINEAR]` grouped badge, and expandable accordion displaying `chasingTelemetry` and `sizingTelemetry` + per-factor raw/orthogonal details.

- [ ] **Step 4: Run web typecheck and UI tests to verify pass**

Run: `npx tsc --noEmit -p apps/web/tsconfig.json && npx vitest run apps/web`
Expected: 0 TS errors; all web test suites (including `AgentTelemetryPanel.test.tsx`) PASS 100%.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/lib/wsClient.ts apps/web/src/store/useMarketStore.ts apps/web/src/App.tsx apps/web/src/components/AgentTelemetryPanel.tsx apps/web/src/components/__tests__/AgentTelemetryPanel.test.tsx
git commit -m "feat(web): refactor AgentTelemetryPanel to orthogonal quant WS stream with 50-item buffer and zero legacy pillars"
```

---

### Task 7: Monorepo Verification, Production Build & Live Cockpit DOM Audit

**Files:**
- Verify all workspaces + live server `http://127.0.0.1:3400`

**Interfaces:**
- Consumes: Complete workspace after Tasks 1–6

- [ ] **Step 1: Run full static typecheck, linting, test suite, and workspace build**

Run:
```bash
npx tsc --noEmit -p packages/shared/tsconfig.json && npx tsc --noEmit -p apps/server/tsconfig.json && npx tsc --noEmit -p apps/web/tsconfig.json && npx eslint . && npm test && npm run build
```
Expected: All 3 `tsc` commands exit 0, `eslint` exits 0 with 0 errors/warnings, `vitest run` (`npm test`) passes 100%, and `npm run build` succeeds across all workspaces.

- [ ] **Step 2: Restart Port 3400 server (if stale) and verify AI Audit API endpoints**

Run session-authenticated `GET /api/audit/daily?format=markdown` and `GET /api/audit/daily?format=json`:
Expected: Both return HTTP 200 OK; Markdown output has `< 4,000` tokens (`length <= 14_000`) and zero `P1:`–`P7:` pillar lines; JSON contains `summary`, `records`, `factor_telemetry_events`, `factor_attribution_summary`.

- [ ] **Step 3: Perform Chrome DevTools MCP DOM & visual verification on `http://127.0.0.1:3400`**

Inspect the `Agent Loqları & Canlı Düşüncə Telemetriyası` panel via Chrome DevTools (`navigate_page`, `take_snapshot`, `take_screenshot`):
Expected: DOM snapshot confirms Orthogonal Quant Conviction badges, active Gram-Schmidt weights, `[COLLINEAR]` grouping, and **0 occurrences** of `P1`, `P6`, `P7`, or `4/7 Aktiv`.

---

## Self-Review Checklist Applied

1. **Spec Coverage:** Every phase (`packages/shared` contracts, `schema.sql` + `sqlite.ts` defensive migrations + `FactorTelemetryRecordsRepo` + `PRAGMA wal_autocheckpoint = 1000`, `DecisionAuditService` 180s hysteresis + 500ms ring-buffer + 1m/5m/15m/60m MFE/MAE + Spearman IC + downtime recovery + 7d pruning, `AlphaRegistry` + `StrategyDecayEngine` `IDLE` sync barrier, `ConfluenceEngine` + `AutoPilotManager` triggers + `WsHub` `<4KB` broadcast + `GET /api/audit/daily` `<4000` tokens, `AgentTelemetryPanel` WS HUD + Chrome DevTools audit) maps directly to Tasks 1–7.
2. **Codebase Accuracy:** Paths (`apps/server/src/api/wsHub.ts`, `node_modules/@tradeos/shared/src/`), existing method names (`onCandleClose`, `generateSessionSummary`, `formatMarkdownReport`), and existing tests (`decisionContracts.test.ts`, `dailyAuditRoute.test.ts`) were checked directly against disk files before writing.
3. **Review Focus Coverage:** Every one of the 5 failure modes has an explicit test requirement in its owning task (Task 2 FK nullability, Task 3 ring-buffer overflow/flush & token budget & `INCOMPLETE_FEED`, Tasks 4/5/6 `IDLE` sync barrier & `<4KB` WS cap & 50-item UI sliding window).
