# SDD ledger — plan: docs/designs/cockpit-stabilization-and-forensics.md

Baseline: commit f7d6fda, 20 test files, 230 passed.

## Phases
- [ ] Phase 1: Shared Domain & Risk Math Armor (`packages/shared/src/math.ts`, `packages/shared/src/__tests__/math.test.ts`)
- [ ] Phase 2: Server Risk Engine & Quant Telemetry (`apps/server/src/quant/riskEngine.ts`, `apps/server/src/services/tradeManager.ts`, `apps/server/src/quant/orderFlowEngine.ts`)
- [ ] Phase 3: Chart Engine & Store Decoupling (`apps/web/src/store/useMarketStore.ts`, `apps/web/src/components/ChartCanvas.tsx`, tests)
- [ ] Phase 4: Cockpit Layout & Resilient Modals (`apps/web/src/App.tsx`, `apps/web/src/components/OrderTicket.tsx`, modals)
- [ ] Phase 5: Verification & Full Monorepo Build
