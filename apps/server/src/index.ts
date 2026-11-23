import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import polka, { type Request, type Response, type NextHandler } from 'polka';
import type {
  CockpitState,
  KlineCandle,
  TechnicalSummary,
  ExchangeHealth,
  BrokerMode,
} from '@tradeos/shared';
import {
  PORT,
  HOST,
  DB_PATH,
  SESSION_TOKEN,
  BINANCE_DEMO_API_KEY,
  BINANCE_DEMO_API_SECRET,
  CRYPTOPANIC_API_KEY,
} from './config.js';
import { initializeDatabase, TradesRepo, RiskStateRepo, DecisionLogsRepo, PillarTelemetryRepo } from './db/sqlite.js';
import { DecisionAuditService } from './services/decisionAuditService.js';
import { PillarAttributionService } from './services/pillarAttributionService.js';
import { BinanceClient } from './exchange/binanceClient.js';
import { BinanceStreamsManager } from './exchange/binanceStreams.js';
import { BrokerFactory } from './exchange/broker.js';
import { CvdEngine } from './quant/cvd.js';
import { calculateIndicators } from './quant/indicators.js';
import { generateMentorBrief } from './quant/sokratMentor.js';
import { SentimentHarvester } from './quant/sentimentHarvester.js';
import { HierarchicalMtfManager } from './quant/hierarchicalMtfManager.js';
import { NativeSmcEngine } from './quant/nativeSmcEngine.js';
import { ConfluenceEngine } from './quant/confluenceEngine.js';
import { TradeManager } from './services/tradeManager.js';
import { AutoPilotManager } from './services/autoPilotManager.js';
import { WsHub } from './api/wsHub.js';
import { registerRoutes } from './api/routes.js';

// Global crash prevention for unhandled async rejections and exceptions
process.on('unhandledRejection', (reason) => {
  console.error('[TradeOS v2] Unhandled Rejection:', reason);
});
process.on('uncaughtException', (error) => {
  console.error('[TradeOS v2] Uncaught Exception:', error);
});

// Safe environment loading
try {
  if (fs.existsSync('.env')) {
    process.loadEnvFile('.env');
  } else if (fs.existsSync(path.resolve(process.cwd(), '../../.env'))) {
    process.loadEnvFile(path.resolve(process.cwd(), '../../.env'));
  }
} catch {
  // Silent fallback if .env does not exist or was loaded by runner
}

export async function bootstrapServer(): Promise<{
  server: http.Server;
  wsHub: WsHub;
  tradeManager: TradeManager;
  db: ReturnType<typeof initializeDatabase>;
  streamsManager: BinanceStreamsManager;
  confluenceEngine: ConfluenceEngine;
  autoPilotManager: AutoPilotManager;
  sentimentHarvester: SentimentHarvester;
  mtfManager: HierarchicalMtfManager;
  smcEngine: NativeSmcEngine;
  decisionAuditService: DecisionAuditService;
  pillarAttributionService: PillarAttributionService;
  close: () => Promise<void>;
}> {
  // 1. Initialize SQLite WAL Database Engine
  const db = initializeDatabase(DB_PATH);
  const tradesRepo = new TradesRepo(db);
  const riskRepo = new RiskStateRepo(db);
  const decisionLogsRepo = new DecisionLogsRepo(db);
  const pillarRepo = new PillarTelemetryRepo(db);
  const decisionAuditService = new DecisionAuditService(decisionLogsRepo, pillarRepo);
  const pillarAttributionService = new PillarAttributionService(pillarRepo);

  // 2. Initialize Binance REST Client & Adapters
  const client = new BinanceClient({
    apiKey: BINANCE_DEMO_API_KEY,
    apiSecret: BINANCE_DEMO_API_SECRET,
  });

  const logger = {
    error: (obj: unknown, msg?: string) => console.error(msg, obj),
    warn: (obj: unknown, msg?: string) => console.warn(msg, obj),
    info: (obj: unknown, msg?: string) => console.log(msg, obj),
  };

  decisionAuditService.recoverDowntimeGaps(client).catch((err) => {
    logger.error({ err }, 'Failed to recover downtime shadow gaps');
  });

  await pillarAttributionService.recoverDowntimeGaps(client).catch((err) => {
    logger.error({ err }, 'Failed to recover downtime pillar gaps');
  });

  const broker = BrokerFactory.getAdapter('BINANCE_DEMO', { client, db });
  let activeBroker = broker;

  // 3. State and Cache Management
  let activeSymbol = 'SOLUSDT';
  const markPriceMap = new Map<string, number>([['SOLUSDT', 0]]);
  const fundingRateMap = new Map<string, { rate: number | null; nextTime: number | null }>();
  const candleHistoryMap = new Map<string, KlineCandle[]>();

  const cvdEngine = new CvdEngine(activeSymbol);

  // 4. Initialize Binance Public & User Streams Manager
  const streamsManager = new BinanceStreamsManager({ client });

  // 5. Initialize Polka App and HTTP Server
  const app = polka();
  const server = http.createServer(app.handler);

  // 6. Build Cockpit State Snapshot
  const buildCockpitState = async (symbol: string = activeSymbol): Promise<CockpitState> => {
    const sym = symbol.toUpperCase();
    let markPrice = markPriceMap.get(sym) || 0;
    if (markPrice === 0) {
      try {
        const mpData = await client.getMarkPrice(sym);
        markPrice = parseFloat(mpData?.markPrice || '0');
        if (markPrice > 0) {
          markPriceMap.set(sym, markPrice);
        }
      } catch {}
    }
    const funding = fundingRateMap.get(sym) || { rate: null, nextTime: null };

    const account = await activeBroker.getAccount().catch(() => ({
      walletBalance: 0,
      equity: 0,
      availableBalance: 0,
      unrealizedPnl: 0,
      currency: 'USDT',
    }));

    const activePosition = tradesRepo.getActivePosition(activeBroker.mode, sym);
    const openOrders = await activeBroker.getOpenOrders(sym).catch(() => []);

    const candles = candleHistoryMap.get(sym) || [];
    const indicators = calculateIndicators(candles, 0.01);
    const cvdSnapshot = cvdEngine.getSnapshot();

    const currentRisk = riskRepo.get(activeBroker.mode) || {
      broker_mode: activeBroker.mode,
      consecutive_losses: 0,
      cooldown_until: 0,
      cooldown_reason: null,
      session_net_pnl: 0,
      session_started_at: Date.now(),
      updated_at: Date.now(),
    };

    const sokrat = generateMentorBrief(
      {
        indicators,
        markPrice,
      },
      currentRisk
    );

    const isConnected = (streamsManager as any).publicWs?.readyState === 1;
    const exchangeHealth: ExchangeHealth = client.isBanned()
      ? 'BANNED'
      : isConnected
      ? 'HEALTHY'
      : 'DEGRADED';

    return {
      symbol: sym,
      markPrice,
      fundingRate: funding.rate,
      nextFundingTime: funding.nextTime,
      account,
      activePosition,
      openOrders,
      indicators,
      cvd: cvdSnapshot,
      risk: currentRisk,
      sokrat,
      exchangeHealth,
      brokerMode: activeBroker.mode,
    };
  };

  // 7a. Initialize Institutional Quantitative Engine Subsystems
  const mtfManager = new HierarchicalMtfManager();
  const smcEngine = new NativeSmcEngine();
  const sentimentHarvester = new SentimentHarvester(CRYPTOPANIC_API_KEY);
  sentimentHarvester.start();

  const confluenceEngine = new ConfluenceEngine({
    mtfManager,
    smcEngine,
    sentimentHarvester,
  });

  // 7b. Initialize WebSocket Hub on /ws
  const wsHub = new WsHub({
    server,
    path: '/ws',
    sessionToken: SESSION_TOKEN,
    getSnapshot: (sym) => buildCockpitState(sym || activeSymbol),
    onSubscribeSymbol: (sym) => {
      activeSymbol = sym.toUpperCase();
      cvdEngine.reset(activeSymbol);
      mtfManager.reset(activeSymbol);
      smcEngine.reset(activeSymbol);
      confluenceEngine.reset(activeSymbol);
      streamsManager.subscribeSymbol(activeSymbol);

      // Pre-warm 1m candle history for smooth tick updates
      client.getKlines(activeSymbol, '1m', 100).then((raw) => {
        if (Array.isArray(raw)) {
          const klines = raw.map((k: any) => ({
            time: Math.floor(Number(k[0]) / 1000),
            open: Number(k[1]),
            high: Number(k[2]),
            low: Number(k[3]),
            close: Number(k[4]),
            volume: Number(k[5]),
          }));
          candleHistoryMap.set(activeSymbol, klines);
          mtfManager.setInitialCandles(activeSymbol, '1m', klines);
        }
      }).catch(() => {});

      // Pre-warm 15m candle history via REST (200 candles) for SMC and Intermediate Structure
      client.getKlines(activeSymbol, '15m', 200).then((raw) => {
        if (Array.isArray(raw)) {
          const klines = raw.map((k: any) => ({
            time: Math.floor(Number(k[0]) / 1000),
            open: Number(k[1]),
            high: Number(k[2]),
            low: Number(k[3]),
            close: Number(k[4]),
            volume: Number(k[5]),
          }));
          mtfManager.setInitialCandles(activeSymbol, '15m', klines);
          smcEngine.onCandleClosed(activeSymbol, '15m', klines);
        }
      }).catch(() => {});

      // Pre-warm 1h candle history via REST (200 candles) for Macro Directional Regime
      client.getKlines(activeSymbol, '1h', 200).then((raw) => {
        if (Array.isArray(raw)) {
          const klines = raw.map((k: any) => ({
            time: Math.floor(Number(k[0]) / 1000),
            open: Number(k[1]),
            high: Number(k[2]),
            low: Number(k[3]),
            close: Number(k[4]),
            volume: Number(k[5]),
          }));
          mtfManager.setInitialCandles(activeSymbol, '1h', klines);
        }
      }).catch(() => {});
    },
  });

  // 8. Initialize TradeManager Atomic Orchestrator
  const tradeManager = new TradeManager({
    db,
    broker: activeBroker,
    brokerMode: activeBroker.mode,
    getMarkPrice: (sym) => markPriceMap.get(sym) || 0,
    broadcastWs: (msg) => wsHub.broadcast(msg),
  });

  // 8b. Initialize Autonomous Auto-Pilot Manager
  const autoPilotManager = new AutoPilotManager({
    db,
    tradeManager,
    broker: activeBroker,
    confluenceEngine,
    getMarkPrice: (sym) => markPriceMap.get(sym) || 0,
    getAtr: (sym) => {
      const candles = candleHistoryMap.get(sym) || [];
      const ind = calculateIndicators(candles, 0.01);
      return ind?.atr14 || (markPriceMap.get(sym) || 100) * 0.005;
    },
    broadcastWs: (msg) => wsHub.broadcast(msg),
    onOrderDispatched: (event) => decisionAuditService.recordExecution(event),
  });

  // 9. Wire Stream Events to TradeManager, CvdEngine, and WsHub
  streamsManager.onMarkPrice((event) => {
    markPriceMap.set(event.symbol, event.markPrice);
    fundingRateMap.set(event.symbol, {
      rate: event.fundingRate,
      nextTime: event.nextFundingTime,
    });

    if (activeBroker.mode === 'LOCAL_PAPER' && 'onMarkPriceTick' in activeBroker) {
      (activeBroker as any).onMarkPriceTick(event.symbol, event.markPrice);
    }

    // Throttled tick broadcast (<= 4Hz)
    const candles = candleHistoryMap.get(event.symbol) || [];
    let latestCandle = candles[candles.length - 1];
    if (latestCandle) {
      const p = event.markPrice;
      latestCandle = {
        ...latestCandle,
        high: Math.max(latestCandle.high, p),
        low: Math.min(latestCandle.low, p),
        close: p,
      };
      candles[candles.length - 1] = latestCandle;
    } else {
      latestCandle = {
        time: Math.floor(event.time / 1000),
        open: event.markPrice,
        high: event.markPrice,
        low: event.markPrice,
        close: event.markPrice,
        volume: 0,
      };
      candleHistoryMap.set(event.symbol, [latestCandle]);
    }

    const activePos = tradesRepo.getActivePosition(activeBroker.mode, event.symbol);
    let uPnl = 0;
    if (activePos && activePos.remaining_qty > 0) {
      uPnl =
        activePos.side === 'BUY'
          ? (event.markPrice - activePos.entry_price) * activePos.remaining_qty
          : (activePos.entry_price - event.markPrice) * activePos.remaining_qty;
    }

    wsHub.broadcastTick({
      symbol: event.symbol,
      markPrice: event.markPrice,
      candle: latestCandle,
      cvd: cvdEngine.getSnapshot().cvd,
      unrealizedPnl: Number(uPnl.toFixed(4)),
    });

    // 6+1 Confluence Matrix Evaluation & Throttled 2Hz Broadcast
    const ind = calculateIndicators(candles, 0.01);
    const cvdSnap = cvdEngine.getSnapshot();
    const recentHigh = candles.length > 0 ? Math.max(...candles.slice(-20).map(c => c.high)) : undefined;
    const recentLow = candles.length > 0 ? Math.min(...candles.slice(-20).map(c => c.low)) : undefined;
    const confluenceSnapshot = confluenceEngine.evaluate({
      symbol: event.symbol,
      currentPrice: event.markPrice,
      indicators: ind,
      cvd: cvdSnap,
      recentHigh,
      recentLow,
    });
    wsHub.broadcastConfluence(confluenceSnapshot);

    const atr = ind?.atr14 || (markPriceMap.get(event.symbol) || event.markPrice || 100) * 0.005;
    decisionAuditService.evaluateSnapshot(confluenceSnapshot, atr, event.markPrice);
    pillarAttributionService.evaluateTick(
      event.symbol,
      event.markPrice,
      atr,
      confluenceSnapshot,
      latestCandle
    );

    // Autonomous Auto-Pilot Tick Evaluation
    autoPilotManager.onTick(event.symbol, event.markPrice).catch(() => {});
  });

  streamsManager.onKline((event) => {
    const sym = event.symbol.toUpperCase();
    const interval = event.interval;

    // Feed MTF Manager ring buffers for 1m, 15m, and 1h
    if (interval === '1m' || interval === '15m' || interval === '1h') {
      mtfManager.updateCandle(sym, interval as any, event.candle, event.isFinal);
    }

    if (interval === '1m') {
      const existing = candleHistoryMap.get(sym) || [];
      if (existing.length === 0) {
        candleHistoryMap.set(sym, [event.candle]);
      } else {
        const lastIdx = existing.length - 1;
        if (existing[lastIdx]!.time === event.candle.time) {
          existing[lastIdx] = event.candle;
        } else {
          existing.push(event.candle);
          if (existing.length > 500) existing.shift();
        }
      }
    }

    // Trigger SMC closed-candle geometry updates on confirmed 15m/1h candle close
    if (event.isFinal && (interval === '15m' || interval === '1h')) {
      const closedCandles = mtfManager.getCandles(sym, interval as any);
      smcEngine.onCandleClosed(sym, interval, closedCandles);
    }

    // Trigger Decision Audit shadow tracking on confirmed 1m candle close
    if (event.isFinal && interval === '1m') {
      decisionAuditService.onCandleClose(sym, event.candle);
      pillarAttributionService.onClosedCandle(sym, event.candle);
    }
  });

  streamsManager.onDepth((event) => {
    if (event.symbol && event.symbol.toUpperCase() !== activeSymbol) return;
    confluenceEngine.orderFlowEngine.updateDepth(event.bids, event.asks);
  });

  streamsManager.onAggTrade((event) => {
    if (event.symbol !== activeSymbol) return;
    cvdEngine.processTrade({
      p: event.price,
      q: event.qty,
      m: event.isBuyerMaker,
      s: event.symbol,
      T: event.time,
    });
    confluenceEngine.orderFlowEngine.processTrade(event.qty, event.isBuyerMaker, event.time, event.price);
  });

  streamsManager.onUserData((event) => {
    tradeManager.handleOrderTradeUpdate(event).catch(() => {});
  });

  streamsManager.onReconcile(() => {
    tradeManager.reconcileWithExchange().catch(() => {});
  });

  // 10. Register 16 REST API Endpoints
  registerRoutes(app, {
    tradeManager,
    decisionAuditService,
    pillarAttributionService,
    get broker() {
      return activeBroker;
    },
    set broker(b) {
      activeBroker = b;
    },
    onBrokerModeChange: (newAdapter) => {
      activeBroker = newAdapter;
    },
    db,
    streamsManager,
    cvdEngine,
    confluenceEngine,
    autoPilotManager,
    activeSymbol,
    getMarkPrice: (sym) => markPriceMap.get(sym) || 0,
    getFunding: (sym) => fundingRateMap.get(sym) || { rate: null, nextTime: null },
    setActiveSymbol: (sym) => {
      activeSymbol = sym.toUpperCase();
      cvdEngine.reset(activeSymbol);
      streamsManager.subscribeSymbol(activeSymbol);
    },
    getIndicators: (sym) => {
      const candles = candleHistoryMap.get(sym) || [];
      return calculateIndicators(candles, 0.01);
    },
    getKlines: async (sym, interval, limit) => {
      try {
        const raw = await client.getKlines(sym, interval, limit);
        return raw.map((k: any) => ({
          time: Math.floor(Number(k[0]) / 1000),
          open: Number(k[1]),
          high: Number(k[2]),
          low: Number(k[3]),
          close: Number(k[4]),
          volume: Number(k[5]),
        }));
      } catch {
        return candleHistoryMap.get(sym) || [];
      }
    },
  });

  // 11. Static SPA Hosting with Native Fast File Serving
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  const webDistCandidates = [
    path.resolve(process.cwd(), 'apps/web/dist'),
    path.resolve(process.cwd(), '../web/dist'),
    path.resolve(__dirname, '../../web/dist'),
    path.resolve(__dirname, '../../../apps/web/dist'),
  ];
  const webDistPath = webDistCandidates.find((c) => fs.existsSync(c)) || webDistCandidates[0];

  const MIME_TYPES: Record<string, string> = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
    '.woff2': 'font/woff2',
  };

  if (fs.existsSync(webDistPath)) {
    app.use((req: Request, res: Response, next: NextHandler) => {
      if (req.url && (req.url.startsWith('/api') || req.url.startsWith('/ws'))) {
        return next();
      }

      const cleanUrl = (req.url || '/').split('?')[0]!;
      let relativePath = cleanUrl === '/' ? '/index.html' : cleanUrl;
      let targetFile = path.normalize(path.join(webDistPath, relativePath));

      // Security check: ensure path is within webDistPath
      if (!targetFile.startsWith(path.normalize(webDistPath))) {
        res.writeHead(403);
        res.end('Forbidden');
        return;
      }

      // SPA fallback to index.html if file doesn't exist
      if (!fs.existsSync(targetFile) || fs.statSync(targetFile).isDirectory()) {
        targetFile = path.join(webDistPath, 'index.html');
      }

      if (!fs.existsSync(targetFile)) {
        return next();
      }

      try {
        const ext = path.extname(targetFile).toLowerCase();
        const contentType = MIME_TYPES[ext] || 'application/octet-stream';
        const fileContent = fs.readFileSync(targetFile);

        res.setHeader('Content-Type', contentType);
        res.setHeader('Content-Length', fileContent.length);

        if (ext === '.html') {
          res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
          res.setHeader('Pragma', 'no-cache');
          res.setHeader('Expires', '0');
        } else {
          res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        }

        res.writeHead(200);
        res.end(fileContent);
      } catch (err) {
        console.error('[STATIC] Error serving file:', err);
        next();
      }
    });
  }

  // 12. Bind Exclusively to 127.0.0.1:3400 (Localhost Security Bound)
  await new Promise<void>((resolve, reject) => {
    server.on('error', reject);
    server.listen(PORT, HOST, () => {
      console.log(`[TradeOS v2] Server running strictly on http://${HOST}:${PORT}`);
      resolve();
    });
  });

  // Start Binance WebSocket streams for active symbol
  await streamsManager.start([activeSymbol]);

  // Pre-fetch initial mark price and candle history
  try {
    const mpData = await client.getMarkPrice(activeSymbol);
    const p = parseFloat(mpData?.markPrice || '0');
    if (p > 0) markPriceMap.set(activeSymbol, p);
  } catch {}

  // Pre-load 200 historical klines for immediate indicator warmup across 1m, 15m, and 1h
  const fetchBootKlines = async (sym: string, interval: string, limit: number = 200): Promise<KlineCandle[]> => {
    try {
      const rawKlines = await client.getKlines(sym, interval, limit);
      if (Array.isArray(rawKlines) && rawKlines.length > 0) {
        return rawKlines.map((k: any) => ({
          time: Math.floor(Number(k[0]) / 1000),
          open: Number(k[1]),
          high: Number(k[2]),
          low: Number(k[3]),
          close: Number(k[4]),
          volume: Number(k[5]),
        }));
      }
    } catch {
      // Demo testnet timed out or failed, try production public REST fallback
    }

    try {
      const res = await fetch(`https://fapi.binance.com/fapi/v1/klines?symbol=${sym}&interval=${interval}&limit=${limit}`, {
        signal: AbortSignal.timeout(5000),
      });
      if (res.ok) {
        const raw = (await res.json()) as any[];
        if (Array.isArray(raw) && raw.length > 0) {
          return raw.map((k: any) => ({
            time: Math.floor(Number(k[0]) / 1000),
            open: Number(k[1]),
            high: Number(k[2]),
            low: Number(k[3]),
            close: Number(k[4]),
            volume: Number(k[5]),
          }));
        }
      }
    } catch {}

    return [];
  };

  try {
    const candles1m = await fetchBootKlines(activeSymbol, '1m', 200);
    if (candles1m.length > 0) {
      candleHistoryMap.set(activeSymbol, candles1m);
      mtfManager.setInitialCandles(activeSymbol, '1m', candles1m);
      console.log(`[BOOT] Preloaded ${candles1m.length} 1m candles for ${activeSymbol}. Indicators fully warmed up!`);
    }

    const candles15m = await fetchBootKlines(activeSymbol, '15m', 200);
    if (candles15m.length > 0) {
      mtfManager.setInitialCandles(activeSymbol, '15m', candles15m);
      smcEngine.onCandleClosed(activeSymbol, '15m', candles15m);
      console.log(`[BOOT] Preloaded ${candles15m.length} 15m candles for ${activeSymbol}. Native SMC initialized!`);
    }

    const candles1h = await fetchBootKlines(activeSymbol, '1h', 200);
    if (candles1h.length > 0) {
      mtfManager.setInitialCandles(activeSymbol, '1h', candles1h);
      console.log(`[BOOT] Preloaded ${candles1h.length} 1h candles for ${activeSymbol}. Macro Regime & ADX initialized!`);
    }
  } catch (err: any) {
    console.warn(`[BOOT] Failed to preload historical klines: ${err.message}`);
  }

  // Preload initial L2 order book depth for Order Flow Engine
  try {
    const depthResp = await fetch(`https://fapi.binance.com/fapi/v1/depth?symbol=${activeSymbol}&limit=20`, {
      signal: AbortSignal.timeout(5000),
    });
    if (depthResp.ok) {
      const depthData = (await depthResp.json()) as any;
      confluenceEngine.orderFlowEngine.updateDepth(depthData.bids, depthData.asks);
      console.log(`[BOOT] Preloaded initial L2 depth for ${activeSymbol}.`);
    }
  } catch (err: any) {
    console.warn(`[BOOT] Failed to preload L2 depth: ${err.message}`);
  }

  // Graceful shutdown helper
  const close = async () => {
    try {
      pillarAttributionService.destroy();
    } catch {}
    try {
      sentimentHarvester.stop();
    } catch {}
    try {
      await streamsManager.stop();
    } catch {}
    try {
      await wsHub.close();
    } catch {}
    try {
      db.close();
    } catch {}
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  };

  return {
    server,
    wsHub,
    tradeManager,
    db,
    streamsManager,
    confluenceEngine,
    autoPilotManager,
    sentimentHarvester,
    mtfManager,
    smcEngine,
    decisionAuditService,
    pillarAttributionService,
    close,
  };
}

// Auto-start if invoked directly via node/tsx
const isMainModule =
  process.argv[1] &&
  (process.argv[1].endsWith('index.ts') || process.argv[1].endsWith('index.js'));

if (isMainModule) {
  bootstrapServer()
    .then(({ close }) => {
      const shutdown = async () => {
        console.log('\n[TradeOS v2] Gracefully shutting down server...');
        await close();
        process.exit(0);
      };
      process.on('SIGINT', shutdown);
      process.on('SIGTERM', shutdown);
    })
    .catch((err) => {
      console.error('[TradeOS v2] Fatal bootstrap error:', err);
      process.exit(1);
    });
}
