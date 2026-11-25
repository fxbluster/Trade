# TradeOS Design & Code Drift Report (2026-11-25)

## quant-decision-telemetry-and-ai-audit-pipeline.md

* **Document & Sitemap Lifecycle Drift Resolved:** Updated document header from `Status: In Review` to `Status: Implemented` and synced `docs/designs/SITEMAP.md` from `Proposed` to `Implemented`.
* **Schema Column Naming Note:** Doc Section 2 DDL uses `price` whereas the live database schema (`apps/server/src/db/schema.sql`) and `DecisionLogRecord` preserve `execution_price` for backward compatibility with earlier `decision-audit-and-shadow-tracking.md` queries; both `factor_telemetry_records` (`entry_price`) and Next-Gen JSON columns (`factor_telemetry_json`, `execution_chase_json`, `sizing_breakdown_json`, `noise_band_state`) match.

## next-gen-modular-quant-architecture.md

* **Quant Conviction Percentage Threshold Bug (Fixed):** `AutoPilotControls.tsx` dispatches Next-Gen conviction thresholds (`60`, `65`, `70`, `75`) to `AutoPilotManager.updateConfig()`, which passes `consensusThreshold` to `ConfluenceEngine.setConsensusThreshold()`. Previously, `ConfluenceEngine.evaluate()` always checked `directionalCount >= this.consensusThreshold` (impossible `0..7 >= 60..75`) and hardcoded `compositeScore >= 75` for unconditional entry, silently ignoring `60%`, `65%`, and `70%` settings. Fixed `ConfluenceEngine.evaluate()` to distinguish percentage conviction mode (`consensusThreshold >= 20`) from legacy pillar-count mode (`< 20`) and added regression coverage in `apps/server/src/quant/__tests__/confluenceEngine.test.ts`.
* **Document & Sitemap Lifecycle Drift Resolved:** Updated document header from `Status: Approved` to `Status: Implemented` and `docs/designs/SITEMAP.md` from `Draft` to `Implemented`.
* **Factor Count Prose Note:** Doc Section 3 prose mentions "6 factors" while Section 3.5 Inventory lists all 7 factors (`ORDER_FLOW_L2`, `NATIVE_SMC`, `CVD_ABSORPTION`, `MACRO_REGIME`, `FUNDING_ARBITRAGE`, `CROSS_EXCHANGE_SWEEP`, `LIQ_CLUSTERS`), all 7 of which are implemented and registered in `apps/server/src/index.ts`.

## frontend-ui-ux-stabilization-and-remediation.md

* **Intentionally Superseded HUD Sections:** Legacy 7-pillar cards in `ConfluenceHUD.tsx` and legacy `P1..P7` badges in `AgentTelemetryPanel.tsx` were intentionally replaced by `next-gen-modular-quant-architecture.md` and `quant-decision-telemetry-and-ai-audit-pipeline.md` (Orthogonal Alpha Matrix & `FACTOR_TELEMETRY` WebSocket stream).
* **WsStatus Naming Divergence (Minor):** `apps/web/src/lib/wsClient.ts` defines `WsStatus = 'CONNECTED' | 'DISCONNECTED' | 'CONNECTING'` rather than `'RECONNECTING'`; optimistic snapshot retention is actively implemented in `useMarketStore.ts:applySnapshot`.
* **Sitemap Status Updated:** Updated `docs/designs/SITEMAP.md` from `Proposed` to `Implemented`.
* All ChartCanvas (`axisLabelVisible: false`, `visible: false`, no seconds in `formatLocalTime`), `formatUsd`, TopBar (`data-testid="pnl-summary-btn"`, `min-w-[108px]`), modals, and table alignment fixes remain intact.

## quantitative-edge-and-execution-upgrade.md

* **Session Daily Trade Cap Configurable Default:** Design `G-02`/`CUJ 4` specified a fixed cap of `2` filled trades/day; `AutoPilotManager` and `AutoPilotControls.tsx` evolved this into a user-selectable cap `[2, 3, 5, 10]` defaulting to `5`.
* **Test File Relocation:** Planned tests under `apps/server/test/quant/{trailingStop,noiseBand,economicEventGuard}.test.ts` live at `apps/server/src/quant/__tests__/{trailingStop,noiseBand,economicEventGuard}.test.ts` (all passing).
* **Static Weights Superseded:** Static 7-pillar weight updates (`20/23/17/20/8/6/6`) are preserved as legacy fallback in `@tradeos/shared`, while primary live scoring delegates to `AlphaRegistry` (MGS orthogonalization + Dirichlet posteriors).
* **Sitemap Status Updated:** Updated `docs/designs/SITEMAP.md` from `Ready for Review` to `Implemented`.

## autonomous-backtesting-and-decay-engine.md

* **Sitemap Entry Missing (Fixed):** `autonomous-backtesting-and-decay-engine.md` existed in `docs/designs/` without an entry in `docs/designs/SITEMAP.md`; added with status `Partially Superseded`.
* **Superseded Persistence Tables & Unimplemented Auto-WFA Optimizer:** Speculative DDL tables `pillar_decay_scorecards`, `backtest_simulation_runs`, and `dynamic_weight_adjustments` plus automated 30d/7d Walk-Forward Efficiency (`WFE`) / `PlateauCurvature` scanning and `ProjectToSimplex` softmax optimizer were superseded by `AlphaRegistry` (MGS + Dirichlet), `StrategyDecayEngine` (`CUSUM k=0.5σ, h=4.0σ` + 5,000-iter `monteCarloWorker.ts` + `IDLE` barrier), `factor_telemetry`, `execution_chase_logs`, and `factor_telemetry_records`.

## pillar-analytics-bulldog-engine.md

No code drift detected (legacy tables and `GET /api/audit/pillars` endpoint retained intact alongside Next-Gen telemetry).

## decision-audit-and-shadow-tracking.md

No code drift detected (`DecisionLogsRepo`, `DecisionAuditService`, counterfactual shadow tracking, and `GET /api/audit/daily` verified).

## institutional-confluence-and-smc.md

* **Sitemap Status Updated:** Updated `docs/designs/SITEMAP.md` from `Approved` to `Implemented`.
* No code drift detected across `HierarchicalMtfManager`, `NativeSmcEngine`, `OrderFlowEngine`, `LiquidationEngine`, and `ChartCanvas` SMC overlays.

## cockpit-stabilization-and-forensics.md

* **Sitemap Status Updated:** Updated `docs/designs/SITEMAP.md` from `Approved` to `Implemented`.
* No code drift detected across 60fps decoupled chart streaming, Dead-SL armor, Order Flow 60s ring buffer, pinned AutoPilot controls, Scanner cache fallback, TimeMachine bounds, and Cooldown Diagnostics.

## binance-testnet-and-chart-sync.md

* **Sitemap Status Updated:** Updated `docs/designs/SITEMAP.md` from `Approved` to `Implemented`.
* No code drift detected.

## confluence-autopilot-pinescript.md

Correctly marked `Superseded` in `docs/designs/SITEMAP.md`. Legacy webhook ingress (`POST /api/webhook`) and AutoPilot state machine remain backward-compatible.
