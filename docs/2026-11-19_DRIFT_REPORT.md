# EGM Drift Report (2026-11-19)

**Target Repository:** `c:\Users\HP\TradeOS-v2`  
**Design Document Directory:** `c:\Users\HP\TradeOS\docs\designs`  
**Standard:** Elephant & Goldfish Model (EGM) Drift Detection Standard

---

## tradeos_v2_architecture.md

No drift detected.

The implementation in `c:\Users\HP\TradeOS-v2` fully and faithfully realizes all architectural specifications, data contracts, security invariants, and operational scripts defined in `tradeos_v2_architecture.md`:

- **Shared Core (`packages/shared`)**: All 11 files implemented. Precision rounding (`formatByStepSize`, `formatByTickSize`), asymmetric liquidation calculation (`calculateLiquidationPrice`), Dead-SL gatekeeper, Breakeven fee buffer (`0.15%`), and full DTO/WS message unions match specifications with 27/27 passing unit tests.
- **Database & WAL Engine (`apps/server/src/db`)**: SQLite WAL database schema matches all 5 tables (`trades`, `fills`, `risk_state`, `audit_log`, `settings`) including `remaining_qty`, `tp1/2_algo_id`, `client_order_id` prefixes, and `broker_mode` primary key partitioning with automated directory creation (`fs.mkdirSync`).
- **Quant & Risk Engine (`apps/server/src/quant`)**: TA indicators (EMA, RSI, ATR, MACD, BB, ADX, S/R, Volume SMA), real `@aggTrade` + OI 500-sample ring-buffer CVD engine, 30s-cached market scanner, 10k Monte Carlo FHT simulator, `LiquidationGuard`, dynamic drawdown, 15m Cooldown, and deterministic Azerbaijani Sokrat mentor are fully implemented with 82/82 passing tests.
- **Exchange Integration & TradeManager (`apps/server/src/exchange`, `services`)**: HMAC-SHA256 signing, `AbortSignal.timeout(5000)` on all REST calls, rate limit tracking (`x-mbx-used-weight-1m`, `x-mbx-order-count-10s/1m`), HTTP `418` ban circuit-breaker with `Retry-After` freezing, listenKey keepalive auto-recovery (`ws.terminate()` + fresh key + reconcile), 45s safety sync, deterministic client IDs (`tos_${tradeId}_*`), fail-closed bracket compensation market unwinds, and fail-closed Breakeven unwinds are fully operational with 27/27 passing tests.
- **HTTP API & WebSocket Hub (`apps/server/src/api`, `security`)**: Host guard (`127.0.0.1:3400`, `localhost:3400`), Origin allowlist, 256-bit Bearer session token verification, 256KB body parsing limit, 16 REST routes, `/ws` subprotocol authentication with 3s handshake timeout, and $\le 4\text{ Hz}$ throttled TICK broadcasts match specifications with 38/38 passing tests.
- **Web Cockpit (`apps/web`)**: React 19 + Vite + Tailwind Obsidian theme, direct `ISeriesApi` ref updating from WS ticks (60fps re-render-free), all 6 live/preview price lines, OrderTicket with 10% equity cap chips, leverage slider, ATR presets, 400ms hold-to-confirm, position/open orders/journal tabs, Sokrat mentor panel, and modals are fully implemented with production bundle compiled in `dist/`.
- **Cutover & Launcher Tools (`scripts`, Root)**: `scripts/cutover_cleanup.ps1` dynamically terminates orphaned v1 processes via WMI without hardcoded PIDs and neutralizes the startup VBS hook. `TradeOS.cmd` launches the server and opens Microsoft Edge in standalone app mode (`--app=http://127.0.0.1:3400`).
- **Total Test Suite**: 14 test files, 174/174 tests passing (100% PASS), and `npm run check` (`tsc --noEmit && vitest run`) exits with 0 errors across the entire monorepo.
