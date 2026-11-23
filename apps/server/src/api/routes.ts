import crypto from 'node:crypto';
import polka, { type PolkaInstance, type Request, type Response } from 'polka';
import type { DatabaseSync } from 'node:sqlite';
import {
  computeOrderPreview,
  type OpenOrderRequest,
  type OrderPreviewResponse,
  type BrokerMode,
  type CockpitState,
  type TechnicalSummary,
  type KlineCandle,
  type JournalSummary,
  type TrajectoryHorizon,
  type PillarAttributionResponse
} from '@tradeos/shared';
import {
  TradesRepo,
  RiskStateRepo,
  AuditLogRepo,
  SettingsRepo
} from '../db/sqlite.js';
import {
  TradeManager,
  TradeManagerError
} from '../services/tradeManager.js';
import {
  BrokerFactory,
  type BrokerAdapter,
  ExchangeDegradedError,
  ExchangeBannedError
} from '../exchange/broker.js';
import type { BinanceStreamsManager } from '../exchange/binanceStreams.js';
import type { CvdEngine } from '../quant/cvd.js';
import {
  calculateKellyCriterion,
  calculateMaxDrawdown,
  calculateProfitFactor
} from '../quant/riskEngine.js';
import { generateMentorBrief } from '../quant/sokratMentor.js';
import { scanMarket } from '../quant/scanner.js';
import { promptGeminiMentor } from '../services/geminiClient.js';
import {
  validateHost,
  validateOrigin,
  requireSessionToken,
  jsonBodyParser
} from '../security/auth.js';
import { SESSION_TOKEN, WEBHOOK_SECRET } from '../config.js';
import type { ConfluenceEngine } from '../quant/confluenceEngine.js';
import type { AutoPilotManager } from '../services/autoPilotManager.js';
import type { DecisionAuditService } from '../services/decisionAuditService.js';
import type { PillarAttributionService } from '../services/pillarAttributionService.js';

export interface AppContext {
  tradeManager: TradeManager;
  broker: BrokerAdapter;
  db: DatabaseSync;
  streamsManager?: BinanceStreamsManager;
  cvdEngine?: CvdEngine;
  confluenceEngine?: ConfluenceEngine;
  autoPilotManager?: AutoPilotManager;
  decisionAuditService?: DecisionAuditService;
  pillarAttributionService?: PillarAttributionService;
  activeSymbol?: string;
  getMarkPrice?: (symbol: string) => number;
  setActiveSymbol?: (symbol: string) => void;
  getIndicators?: (symbol: string) => TechnicalSummary | null;
  getKlines?: (symbol: string, interval: string, limit: number) => Promise<KlineCandle[]>;
  getFunding?: (symbol: string) => { rate: number | null; nextTime: number | null };
  onBrokerModeChange?: (adapter: BrokerAdapter) => void;
}

export type RouteOptions = AppContext;

function sendJson(res: Response, statusCode: number, data: unknown): void {
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(data));
}

/**
 * Registers all 16 TradeOS v2 REST endpoints on the Polka application.
 */
export function registerRoutes(app: PolkaInstance, ctx: AppContext): PolkaInstance {
  const tradesRepo = new TradesRepo(ctx.db);
  const riskRepo = new RiskStateRepo(ctx.db);
  const auditRepo = new AuditLogRepo(ctx.db);
  const settingsRepo = new SettingsRepo(ctx.db);

  let activeSymbol = (ctx.activeSymbol || 'SOLUSDT').toUpperCase();

  // Apply security and auth middlewares
  app.use(validateHost);
  app.use(validateOrigin);
  app.use(requireSessionToken);
  app.use(jsonBodyParser);

  const bootTimeMs = Date.now() - Math.floor(process.uptime() * 1000);

  // 1. GET /api/health — Public liveliness & exchange status check
  app.get('/api/health', (req: Request, res: Response) => {
    const exchangeHealth = (ctx.broker as unknown as { getHealth?: () => string })?.getHealth?.() || 'HEALTHY';
    const wsConnected = ctx.streamsManager
      ? (ctx.streamsManager as unknown as { isWsConnected?: () => boolean })?.isWsConnected?.() ?? true
      : true;

    sendJson(res, 200, {
      ok: true,
      uptimeSec: Math.floor(process.uptime()),
      bootTimeMs,
      exchangeHealth,
      wsConnected,
      brokerMode: ctx.broker.mode
    });
  });

  // 2. GET /api/auth/session — Session token acquisition for localhost client
  app.get('/api/auth/session', (req: Request, res: Response) => {
    sendJson(res, 200, { token: SESSION_TOKEN });
  });

  // 3. GET /api/state — Full cockpit snapshot
  app.get('/api/state', async (req: Request, res: Response) => {
    try {
      const sym = activeSymbol;
      const markPrice = ctx.tradeManager.getMarkPrice(sym);
      const funding = ctx.getFunding ? ctx.getFunding(sym) : { rate: null, nextTime: null };
      const account = await ctx.broker.getAccount().catch(() => ({
        walletBalance: 0,
        equity: 0,
        availableBalance: 0,
        unrealizedPnl: 0,
        currency: 'USDT',
      }));
      const activePosition = tradesRepo.getActivePosition(ctx.broker.mode, sym);
      const openOrders = await ctx.broker.getOpenOrders(sym).catch(() => []);
      const indicators = ctx.getIndicators ? ctx.getIndicators(sym) : null;
      const cvd = ctx.cvdEngine ? ctx.cvdEngine.getSnapshot() : null;
      const risk = riskRepo.get(ctx.broker.mode) || {
        broker_mode: ctx.broker.mode,
        consecutive_losses: 0,
        cooldown_until: 0,
        cooldown_reason: null,
        session_net_pnl: 0,
        session_started_at: Date.now(),
        updated_at: Date.now()
      };
      const sokrat = generateMentorBrief({ indicators, markPrice }, risk);
      const exchangeHealth = (ctx.broker as unknown as { getHealth?: () => string })?.getHealth?.() || 'HEALTHY';

      const state: CockpitState = {
        symbol: sym,
        markPrice,
        fundingRate: funding.rate,
        nextFundingTime: funding.nextTime,
        account,
        activePosition,
        openOrders,
        indicators,
        cvd,
        risk,
        sokrat,
        exchangeHealth: exchangeHealth as CockpitState['exchangeHealth'],
        brokerMode: ctx.broker.mode
      };

      sendJson(res, 200, state);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      sendJson(res, 500, { error: `Failed to retrieve cockpit state: ${msg}` });
    }
  });

  // 4. GET /api/klines — Chart candle feed
  app.get('/api/klines', async (req: Request, res: Response) => {
    try {
      const query = (req.query || {}) as Record<string, string>;
      const symbol = (query.symbol || activeSymbol).toUpperCase();
      const interval = query.interval || '1m';
      const limit = Math.min(Number(query.limit) || 400, 1000);

      if (ctx.getKlines) {
        const klines = await ctx.getKlines(symbol, interval, limit);
        return sendJson(res, 200, { symbol, interval, klines });
      }

      // Fallback: direct public Binance futures REST
      const url = `https://fapi.binance.com/fapi/v1/klines?symbol=${encodeURIComponent(symbol)}&interval=${encodeURIComponent(interval)}&limit=${limit}`;
      const response = await fetch(url, { signal: AbortSignal.timeout(5000) });
      if (!response.ok) {
        return sendJson(res, response.status, { error: 'Failed to fetch klines from exchange' });
      }

      const raw = await response.json() as (string | number)[][];
      const klines: KlineCandle[] = raw.map(row => ({
        time: Math.floor(Number(row[0]) / 1000),
        open: Number(row[1]),
        high: Number(row[2]),
        low: Number(row[3]),
        close: Number(row[4]),
        volume: Number(row[5])
      }));

      sendJson(res, 200, { symbol, interval, klines });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      sendJson(res, 502, { error: `Error fetching klines: ${msg}` });
    }
  });

  // 5. GET /api/scanner — Top Binance Futures USDT-M pairs
  app.get('/api/scanner', async (req: Request, res: Response) => {
    try {
      const items = await scanMarket();
      sendJson(res, 200, items);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      sendJson(res, 502, { error: `Market scan failed: ${msg}` });
    }
  });

  // 6. POST /api/symbol — Change active trading symbol
  app.post('/api/symbol', (req: Request, res: Response) => {
    const { symbol } = (req.body || {}) as { symbol?: string };
    if (!symbol || typeof symbol !== 'string') {
      return sendJson(res, 400, { error: 'Missing or invalid symbol string' });
    }

    const cleanSymbol = symbol.trim().toUpperCase();
    activeSymbol = cleanSymbol;

    if (ctx.setActiveSymbol) {
      ctx.setActiveSymbol(cleanSymbol);
    }
    if (ctx.streamsManager) {
      ctx.streamsManager.subscribeSymbol(cleanSymbol);
    }
    if (ctx.cvdEngine) {
      ctx.cvdEngine.reset(cleanSymbol);
    }

    sendJson(res, 200, { success: true, symbol: cleanSymbol });
  });

  // 7. POST /api/broker/mode — Switch between BINANCE_DEMO and LOCAL_PAPER
  app.post('/api/broker/mode', (req: Request, res: Response) => {
    const { mode } = (req.body || {}) as { mode?: BrokerMode };
    if (!mode || (mode !== 'BINANCE_DEMO' && mode !== 'LOCAL_PAPER')) {
      return sendJson(res, 400, { error: 'Invalid broker mode. Must be BINANCE_DEMO or LOCAL_PAPER' });
    }

    // Guard: conflict if active open position exists
    const active = tradesRepo.getActivePosition(ctx.broker.mode);
    if (active && (active.status === 'OPEN' || active.status === 'PARTIALLY_CLOSED' || active.status === 'CLOSING')) {
      return sendJson(res, 409, { error: 'Cannot switch broker mode while an active position is open' });
    }

    try {
      const newAdapter = BrokerFactory.getAdapter(mode, { db: ctx.db });
      ctx.broker = newAdapter;
      ctx.tradeManager.setBroker(newAdapter);
      ctx.tradeManager.setBrokerMode(mode);
      if (ctx.onBrokerModeChange) {
        ctx.onBrokerModeChange(newAdapter);
      }

      sendJson(res, 200, { success: true, mode });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      sendJson(res, 500, { error: `Failed to switch broker mode: ${msg}` });
    }
  });

  // 8. POST /api/orders/preview — Pre-trade calculation & Dead-SL armor preview
  app.post('/api/orders/preview', (req: Request, res: Response) => {
    const orderReq = req.body as OpenOrderRequest;
    if (!orderReq || !orderReq.symbol || !orderReq.side || !orderReq.marginUsd || !orderReq.leverage) {
      return sendJson(res, 400, { error: 'Missing required order preview fields' });
    }

    const markPrice = ctx.tradeManager.getMarkPrice(orderReq.symbol) || orderReq.limitPrice || 100;
    const tickSize = 0.01;
    const stepSize = 0.001;
    const mmr = 0.005;

    const preview: OrderPreviewResponse = computeOrderPreview(
      orderReq,
      markPrice,
      tickSize,
      stepSize,
      mmr
    );

    sendJson(res, 200, preview);
  });

  // 9. POST /api/orders/open — Open leveraged bracket position with risk armor
  app.post('/api/orders/open', async (req: Request, res: Response) => {
    const orderReq = req.body as OpenOrderRequest;
    if (!orderReq || !orderReq.symbol || !orderReq.side || !orderReq.marginUsd || !orderReq.leverage) {
      return sendJson(res, 400, { error: 'Missing required fields in open order request' });
    }

    try {
      const trade = await ctx.tradeManager.openPosition(orderReq);
      sendJson(res, 200, { success: true, trade });
    } catch (err: unknown) {
      if (err instanceof TradeManagerError) {
        if (err.code === 'ERR_COOLDOWN_ACTIVE') {
          return sendJson(res, 423, { error: err.message, code: err.code });
        }
        if (err.code === 'ERR_EXCHANGE_DEGRADED' || err.code === 'ERR_EXCHANGE_BANNED') {
          return sendJson(res, 503, { error: err.message, code: err.code });
        }
        if (err.code === 'ERR_BRACKET_COMPENSATION_UNWIND' || err.code === 'ERR_EMERGENCY_UNWIND_FAILED') {
          return sendJson(res, 502, { error: err.message, code: err.code });
        }
        return sendJson(res, err.statusCode || 400, { error: err.message, code: err.code });
      }

      if (err instanceof ExchangeBannedError || err instanceof ExchangeDegradedError) {
        return sendJson(res, 503, { error: err.message });
      }

      const msg = err instanceof Error ? err.message : String(err);
      sendJson(res, 500, { error: `Failed to open order: ${msg}` });
    }
  });

  // 10. POST /api/orders/close — Emergency or market exit with OCO cancellation
  app.post('/api/orders/close', async (req: Request, res: Response) => {
    const { symbol, reason } = (req.body || {}) as { symbol?: string; reason?: string };
    const sym = (symbol || activeSymbol).toUpperCase();

    try {
      const trade = await ctx.tradeManager.closePosition(sym, reason || 'USER_MANUAL');
      sendJson(res, 200, { success: true, trade });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      const status = err instanceof TradeManagerError ? err.statusCode : 500;
      sendJson(res, status, { error: `Close position failed: ${msg}` });
    }
  });

  // 11. POST /api/orders/breakeven — Fail-closed Breakeven SL migration
  app.post('/api/orders/breakeven', async (req: Request, res: Response) => {
    const { symbol } = (req.body || {}) as { symbol?: string };
    const sym = (symbol || activeSymbol).toUpperCase();

    try {
      const trade = await ctx.tradeManager.moveToBreakeven(sym);
      sendJson(res, 200, { success: true, trade });
    } catch (err: unknown) {
      if (err instanceof TradeManagerError) {
        if (err.code === 'ERR_BREAKEVEN_RESTORE_FAILED_UNWOUND') {
          return sendJson(res, 502, { error: err.message, code: err.code });
        }
        return sendJson(res, err.statusCode || 400, { error: err.message, code: err.code });
      }
      const msg = err instanceof Error ? err.message : String(err);
      sendJson(res, 500, { error: `Breakeven adjustment failed: ${msg}` });
    }
  });

  // 12. DELETE /api/orders/:orderId — Cancel active limit or algo order
  app.delete('/api/orders/:orderId', async (req: Request, res: Response) => {
    const { orderId } = req.params;
    const query = (req.query || {}) as Record<string, string>;
    const symbol = (query.symbol || activeSymbol).toUpperCase();
    const isAlgo = query.isAlgo === 'true' || (req.body as { isAlgo?: boolean })?.isAlgo === true;

    try {
      const success = await ctx.broker.cancelOrder(symbol, orderId, isAlgo);
      sendJson(res, 200, { success, orderId });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      sendJson(res, 500, { error: `Failed to cancel order: ${msg}` });
    }
  });

  // 13. POST /api/sync — Immediate exchange reconciliation
  app.post('/api/sync', async (req: Request, res: Response) => {
    try {
      await ctx.tradeManager.reconcileWithExchange();
      sendJson(res, 200, { success: true, syncedAt: Date.now() });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      sendJson(res, 502, { error: `Reconciliation sync failed: ${msg}` });
    }
  });

  // 14. GET /api/journal — Closed trade log and institutional metrics
  app.get('/api/journal', (req: Request, res: Response) => {
    const query = (req.query || {}) as Record<string, string>;
    const limit = Math.min(Number(query.limit) || 50, 200);
    const offset = Math.max(Number(query.offset) || 0, 0);
    const symbol = query.symbol ? query.symbol.toUpperCase() : undefined;

    const trades = tradesRepo.listClosed(ctx.broker.mode, limit, offset, symbol);
    const totalTrades = tradesRepo.countClosed(ctx.broker.mode, symbol);

    const winRate = trades.length > 0
      ? Number(((trades.filter(t => (t.realized_pnl - t.fees_usd) > 0).length / trades.length) * 100).toFixed(2))
      : 0;

    const summary: JournalSummary = {
      trades,
      totalTrades,
      winRate,
      profitFactor: calculateProfitFactor(trades),
      maxDrawdown: calculateMaxDrawdown(trades),
      kellyCriterion: calculateKellyCriterion(trades)
    };

    sendJson(res, 200, summary);
  });

  // 15. POST /api/cooldown/bypass — Audited 15-minute anti-gambling lock release
  app.post('/api/cooldown/bypass', (req: Request, res: Response) => {
    const { reason } = (req.body || {}) as { reason?: string };
    if (!reason || typeof reason !== 'string' || reason.trim().length < 5) {
      return sendJson(res, 400, { error: 'A clear explanation (min 5 characters) is required to bypass Cooldown' });
    }

    // 1. Audit log persistence
    auditRepo.insert({
      id: crypto.randomUUID(),
      event_type: 'COOLDOWN_BYPASS',
      actor: 'USER',
      reason: reason.trim(),
      payload_json: JSON.stringify({ brokerMode: ctx.broker.mode, bypassedAt: Date.now() }),
      created_at: Date.now()
    });

    // 2. Clear cooldown in SQLite risk_state
    const risk = riskRepo.get(ctx.broker.mode);
    if (risk) {
      risk.cooldown_until = 0;
      risk.cooldown_reason = null;
      risk.updated_at = Date.now();
      riskRepo.update(risk);
    }

    sendJson(res, 200, { success: true, bypassedAt: Date.now() });
  });

  // 16. POST /api/mentor/chat — Sokrat mentor chat dialogue
  app.post('/api/mentor/chat', async (req: Request, res: Response) => {
    const { message } = (req.body || {}) as { message?: string };
    if (!message || typeof message !== 'string') {
      return sendJson(res, 400, { error: 'Missing or empty message in mentor chat request' });
    }

    const risk = riskRepo.get(ctx.broker.mode) || {
      broker_mode: ctx.broker.mode,
      consecutive_losses: 0,
      cooldown_until: 0,
      cooldown_reason: null,
      session_net_pnl: 0,
      session_started_at: Date.now(),
      updated_at: Date.now()
    };

    const markPrice = ctx.tradeManager.getMarkPrice(activeSymbol);
    const indicators = ctx.getIndicators ? ctx.getIndicators(activeSymbol) : null;
    const brief = generateMentorBrief({ indicators, markPrice }, risk);

    let reply: string | null = null;
    try {
      reply = await promptGeminiMentor(message);
    } catch {
      reply = null;
    }

    if (!reply) {
      // Deterministic Azerbaijani counsel fallback
      reply = `${brief.headlineAz}\n\n${brief.adviceAz}`;
    }

    sendJson(res, 200, {
      reply,
      mode: brief.mode,
      timestamp: Date.now()
    });
  });

  // 17. POST /api/webhook — TradingView PineScript v6 webhook alert ingestion
  app.post('/api/webhook', (req: Request, res: Response) => {
    const payload = (req.body || {}) as any;

    // Constant-time passphrase comparison against WEBHOOK_SECRET
    const secret = payload.secret;
    if (!secret || typeof secret !== 'string') {
      return sendJson(res, 401, { error: 'Unauthorized: Missing webhook secret passphrase' });
    }
    const a = Buffer.from(secret);
    const b = Buffer.from(WEBHOOK_SECRET);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      return sendJson(res, 401, { error: 'Unauthorized: Invalid webhook secret passphrase' });
    }

    // 30-second timestamp drift ceiling
    if (payload.time && Math.abs(Date.now() - Number(payload.time)) > 30_000) {
      return sendJson(res, 400, { error: 'Bad Request: Webhook timestamp drift exceeds 30 seconds' });
    }

    if (!payload.symbol || !payload.side) {
      return sendJson(res, 400, { error: 'Bad Request: Missing symbol or side in webhook payload' });
    }

    if (ctx.confluenceEngine) {
      const result = ctx.confluenceEngine.ingestWebhookAlert(payload);
      if (!result.accepted) {
        return sendJson(res, 400, { error: result.reason || 'Webhook rejected' });
      }
    }

    sendJson(res, 200, {
      ok: true,
      status: 'INGESTED',
      symbol: payload.symbol,
      side: payload.side,
      ingestedAt: Date.now(),
    });
  });

  // 18. GET /api/confluence — Live 6+1 Confluence snapshot
  app.get('/api/confluence', (req: Request, res: Response) => {
    const symbol = ((req.query?.symbol as string) || activeSymbol).toUpperCase();
    if (ctx.confluenceEngine) {
      const snapshot = ctx.confluenceEngine.getSnapshot(symbol);
      return sendJson(res, 200, snapshot);
    }
    sendJson(res, 404, { error: 'ConfluenceEngine not initialized' });
  });

  // 19. POST /api/autopilot/config — Update Auto-Pilot configuration
  app.post('/api/autopilot/config', (req: Request, res: Response) => {
    const rawBody = (req.body || {}) as any;
    const body = (rawBody.config && typeof rawBody.config === 'object') ? rawBody.config : rawBody;
    if (body.marginAllocationPct !== undefined && body.marginAllocationPct > 10.0) {
      return sendJson(res, 400, { error: 'Bad Request: Auto-Pilot margin allocation cannot exceed 10.0%' });
    }

    if (ctx.autoPilotManager) {
      ctx.autoPilotManager.updateConfig(body);
      return sendJson(res, 200, {
        ok: true,
        config: ctx.autoPilotManager.getConfig(),
      });
    }
    sendJson(res, 404, { error: 'AutoPilotManager not initialized' });
  });

  // 20. POST /api/autopilot/toggle — Enable/Disable Auto-Pilot state machine
  app.post('/api/autopilot/toggle', (req: Request, res: Response) => {
    const body = (req.body || {}) as any;
    if (ctx.autoPilotManager) {
      const current = ctx.autoPilotManager.getConfig().enabled;
      const target = body.enabled !== undefined ? Boolean(body.enabled) : !current;
      ctx.autoPilotManager.setEnabled(target);
      return sendJson(res, 200, {
        ok: true,
        enabled: target,
        state: ctx.autoPilotManager.getState(),
      });
    }
    sendJson(res, 404, { error: 'AutoPilotManager not initialized' });
  });

  // 21. GET /api/audit/daily — Daily decision audit summary & counterfactual report
  app.get('/api/audit/daily', (req: Request, res: Response) => {
    if (!ctx.decisionAuditService) {
      return sendJson(res, 503, { error: 'DecisionAuditService not initialized' });
    }

    const query = (req.query || {}) as Record<string, string>;
    const session = query.session || 'current';
    const format = query.format || 'json';

    const sinceMs = session === 'current' ? Date.now() - 28_800_000 : undefined;
    const summary = ctx.decisionAuditService.generateSessionSummary(sinceMs);

    if (format === 'markdown') {
      res.statusCode = 200;
      res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="tradeos-session-audit-${new Date().toISOString().slice(0, 10)}.md"`
      );
      res.end(ctx.decisionAuditService.formatMarkdownReport(summary));
      return;
    }

    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify(summary));
  });

  // 22. GET /api/audit/pillars — Pillar attribution & empirical matrix calibration scorecard
  app.get('/api/audit/pillars', (req: Request, res: Response) => {
    if (!ctx.pillarAttributionService) {
      return sendJson(res, 503, { error: 'PillarAttributionService not initialized' });
    }

    const query = (req.query || {}) as Record<string, string>;
    const symbol = (query.symbol || ctx.activeSymbol || 'SOLUSDT').toUpperCase().trim();
    const horizon = (query.horizon || '15m') as TrajectoryHorizon;

    const validHorizons: TrajectoryHorizon[] = ['1m', '5m', '15m', '60m'];
    if (!validHorizons.includes(horizon)) {
      return sendJson(res, 400, {
        error: `Invalid horizon '${horizon}'. Must be one of: 1m, 5m, 15m, 60m`,
      });
    }

    try {
      const scorecard = typeof (ctx.pillarAttributionService as any).getScorecard === 'function'
        ? (ctx.pillarAttributionService as any).getScorecard(symbol, horizon)
        : ctx.pillarAttributionService.generateScorecard(symbol, horizon);

      sendJson(res, 200, scorecard);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      sendJson(res, 500, { error: `Failed to generate pillar scorecard: ${msg}` });
    }
  });

  return app;
}

/**
 * Creates and configures a Polka app with all endpoints.
 */
export function createRouter(ctx: AppContext): PolkaInstance {
  const app = polka();
  return registerRoutes(app, ctx);
}

export const createRoutes = registerRoutes;
