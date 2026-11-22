# 📌 Cari İcraat Vəziyyəti (TASK_STATE.md)
- **Son Yenilənmə:** 2026-11-22 22:12 (Baku UTC+4)
- **Aktiv Rejim:** Single-Agent
- **Aktiv Məqsəd:** TradeOS Bulldog Engine (Pillar Analytics, Sub-Threshold Impulse Tracking, Bayesian Shrinkage Calibration, Cockpit HUD)

## 1. Tamamlananlar (Faktiki Sübutlu)
- [x] **Dizayn və EGM Rəyləri:** `docs/designs/pillar-analytics-bulldog-engine.md` sənədi 15 Goldfish düzəlişi ilə tamamlandı (`commit 571d251`).
- [x] **Data Müqavilələri və Verilənlər Bazası (`bd-contracts`, `commit 6d310b9`):**
  - `packages/shared/src/contracts.ts`: `TrajectoryHorizon`, `ImpulseTriggerType`, `PillarTelemetryRecord`, `PillarHorizonEvaluation`, `PillarScorecardItem`, `PillarAttributionResponse`.
  - `apps/server/src/db/schema.sql`: `pillar_telemetry_events`, `pillar_horizon_evaluations`, `pillar_daily_scorecards` cədvəlləri və kompozit indekslər.
  - `apps/server/src/db/sqlite.ts`: `PillarTelemetryRepo` (Bayesian shrinkage, $N \ge 30$ gating, $[2.5\%, 35.0\%]$ bounds, $\pm 5\%$ delta caps).
  - 23/23 DB testi 100% PASS.
- [x] **İstifadəçi İnterfeysi (`bd-ui`, `commit 2fca1f1`):**
  - `apps/web/src/lib/apiClient.ts`: `getPillarScorecard(symbol, horizon)` inteqrasiyası.
  - `apps/web/src/components/TopBar.tsx`: "Pillar Matrix" HUD düyməsi.
  - `apps/web/src/components/PillarScorecardModal.tsx`: 7 matrix sütununun analitik cədvəli, win-rate %, MFE/MAE %, mövcud və tövsiyə olunan çəkilər, Bayesian shrinkage metodologiyası.
  - `apps/web/src/App.tsx`: `<PillarScorecardModal />` quraşdırıldı.
  - 25/25 web testi və Vite build 100% PASS.
- [x] **Kvant Mühərriki (`bd-engine`, `commit a5749cb`):**
  - `apps/server/src/services/pillarAttributionService.ts`: In-memory ring-buffer queue, 1000ms asinxron batch flusher (4Hz loop-da sıfır SQLite bloklanması), 10s coalescing window, xronoloji multi-horizon (1m, 5m, 15m, 60m) path-dependent stopout və MFE/MAE qiymətləndirməsi.
  - `apps/server/src/services/decisionAuditService.ts`: `PillarTelemetryRepo` inteqrasiyası, `sub_threshold_impulses` xülasəsi və Markdown hesabatı.
  - 46/46 xidmət testi 100% PASS.
- [x] **API və Server İnteqrasiyası (`bd-api`, `commit ec2e770`):**
  - `apps/server/src/api/routes.ts`: `GET /api/audit/pillars` marşrutu (`symbol`, `horizon` parametrləri, 400 validation, Bearer auth).
  - `apps/server/src/index.ts`: `recoverDowntimeGaps(client)` startup hook-u, 4Hz tick hook-u və 1m closed candle hook-u.
  - 5/5 API testi 100% PASS.
- [x] **Tam Sistem Yoxlanışı (`bd-verifier`):**
  - Vitest: 34 test faylı, 343 test (100% PASS, 0 failure).
  - Monorepo Build: `@tradeos/shared` (tsc clean), `@tradeos/server` (tsc clean), `@tradeos/web` (vite build 1621 modulyar clean).
- [x] **Canlı Sistem və Port 3400 Təsdiqi:**
  - `http://127.0.0.1:3400/api/health`: 200 OK (`exchangeHealth: HEALTHY`, `wsConnected: true`).
  - `http://127.0.0.1:3400/api/audit/pillars?symbol=SOLUSDT&horizon=15m`: 200 OK (bütün 7 sütun üzrə scorecard qaytarır).
  - `http://127.0.0.1:3400/api/audit/daily`: 200 OK (artıq sub-threshold impulsları canlı qeydə alır).
  - `http://127.0.0.1:3400/api/audit/daily?format=markdown`: 200 OK (Markdown cədvəl formatında ixrac olunur).

## 2. Cari Addım
- Bütün Swarm işçiləri təqaüdə çıxarıldı, sistem tam istehsala hazırdır və canlı rejimdə işləyir.
