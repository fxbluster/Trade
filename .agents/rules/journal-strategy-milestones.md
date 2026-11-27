# Journal Strategy Milestones Rule (`STRATEGY_MILESTONES`)

When modifying `TradeOS-v2`:

1. **MUST add a new entry to `STRATEGY_MILESTONES`** in `apps/web/src/components/TradeJournalPanel.tsx` (and update `apps/web/src/components/__tests__/TradeJournalPanel.test.tsx`) **ONLY** when deploying changes to:
   - Trading / AutoPilot strategy logic (`AutoPilotManager`, `ConfluenceEngine`, `AlphaRegistry`, factors, `NoiseBandEngine`, `LiquidationEngine`, `PillarAttributionService`)
   - Order execution, chasing, sizing, breakeven, SL/TP, or risk guards (`ChasingExecutionEngine`, `TradeManager`, `PropFirmRiskGuard`, `math.ts`)
   - Paper/Live broker simulation & fill/price parity (`LocalPaperAdapter`, `BinanceDemoAdapter`, `PnlService`)
   - Especially any fixes originating from `/trade-quant-audit`.

2. **MUST NOT add entries** for UI-only, cosmetic, button, layout, chart pan/zoom, or non-trading changes.

3. **Entry format:**
   - Prepend the newest version (`v2.X` / `v2.X.Y`) at the top of `STRATEGY_MILESTONES` (descending order by `timestampMs`).
   - Use exact UTC `Date.parse('YYYY-MM-DDTHH:MM:SSZ')` matching deploy/activation time, Baku (UTC+4) `HH:MM` for `timeLabel`, and a concise Azerbaijani `summary` of the logic change.
