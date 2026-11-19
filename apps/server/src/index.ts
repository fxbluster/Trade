import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import polka, { type Request, type Response, type NextHandler } from 'polka';
import sirv from 'sirv';
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
} from './config.js';
import { initializeDatabase, TradesRepo, RiskStateRepo } from './db/sqlite.js';
import { BinanceClient } from './exchange/binanceClient.js';
import { BinanceStreamsManager } from './exchange/binanceStreams.js';
import { BrokerFactory } from './exchange/broker.js';
import { CvdEngine } from './quant/cvd.js';
import { calculateIndicators } from './quant/indicators.js';
import { generateMentorBrief } from './quant/sokratMentor.js';
import { TradeManager } from './services/tradeManager.js';
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
  close: () => Promise<void>;
}> {
  // 1. Initialize SQLite WAL Database Engine
  const db = initializeDatabase(DB_PATH);
  const tradesRepo = new TradesRepo(db);
  const riskRepo = new RiskStateRepo(db);

  // 2. Initialize Binance REST Client & Adapters
  const client = new BinanceClient({
    apiKey: BINANCE_DEMO_API_KEY,
    apiSecret: BINANCE_DEMO_API_SECRET,
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
    const markPrice = markPriceMap.get(sym) || 0;
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

  // 7. Initialize WebSocket Hub on /ws
  const wsHub = new WsHub({
    server,
    path: '/ws',
    sessionToken: SESSION_TOKEN,
    getSnapshot: (sym) => buildCockpitState(sym || activeSymbol),
    onSubscribeSymbol: (sym) => {
      activeSymbol = sym.toUpperCase();
      cvdEngine.reset(activeSymbol);
      streamsManager.subscribeSymbol(activeSymbol);
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
    const latestCandle = candles[candles.length - 1] || {
      time: Math.floor(event.time / 1000),
      open: event.markPrice,
      high: event.markPrice,
      low: event.markPrice,
      close: event.markPrice,
      volume: 0,
    };

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
  });

  streamsManager.onKline((event) => {
    if (event.interval === '1m') {
      const existing = candleHistoryMap.get(event.symbol) || [];
      if (existing.length === 0) {
        candleHistoryMap.set(event.symbol, [event.candle]);
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

  // 11. Static SPA Hosting via Sirv for apps/web/dist
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  const webDistCandidates = [
    path.resolve(process.cwd(), 'apps/web/dist'),
    path.resolve(process.cwd(), '../web/dist'),
    path.resolve(__dirname, '../../web/dist'),
    path.resolve(__dirname, '../../../apps/web/dist'),
  ];
  const webDistPath = webDistCandidates.find((c) => fs.existsSync(c)) || webDistCandidates[0];

  if (fs.existsSync(webDistPath)) {
    const serveStatic = sirv(webDistPath, {
      dev: false,
      setHeaders(res, pathname) {
        if (pathname === '/' || pathname.endsWith('.html')) {
          res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
          res.setHeader('Pragma', 'no-cache');
          res.setHeader('Expires', '0');
        }
      },
    });
    app.use((req: Request, res: Response, next: NextHandler) => {
      if (req.url && (req.url.startsWith('/api') || req.url.startsWith('/ws'))) {
        return next();
      }
      serveStatic(req, res, () => {
        if (req.method === 'GET' && !req.url?.startsWith('/api') && !req.url?.startsWith('/ws')) {
          const indexPath = path.join(webDistPath, 'index.html');
          if (fs.existsSync(indexPath)) {
            res.setHeader('Content-Type', 'text/html; charset=utf-8');
            res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
            res.setHeader('Pragma', 'no-cache');
            res.setHeader('Expires', '0');
            fs.createReadStream(indexPath).pipe(res);
            return;
          }
        }
        next();
      });
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

  // Graceful shutdown helper
  const close = async () => {
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
