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
  CRYPTOPANIC_API_KEY,
} from './config.js';
import {
  initializeDatabase,
  TradesRepo,
  RiskStateRepo,
  DecisionLogsRepo,
  PillarTelemetryRepo,
  FactorTelemetryRepo,
  FactorTelemetryRecordsRepo,
  ExecutionChaseLogsRepo,
  PropFirmRepo,
} from './db/sqlite.js';
import { DecisionAuditService, computeSpearmanIC } from './services/decisionAuditService.js';
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
import { EconomicEventGuard } from './quant/economicEventGuard.js';
import { NoiseBandEngine } from './quant/noiseBandEngine.js';
import { AlphaRegistry } from './quant/alphaRegistry.js';
import {
  SymbolQuantRegistry,
  parseWatchlistSymbols,
} from './quant/symbolQuantRegistry.js';
import { AdaptiveSizingEngine } from './quant/adaptiveSizingEngine.js';
import { ChasingExecutionEngine } from './services/chasingExecutionEngine.js';
import { TwapExecutionSlicer } from './services/twapExecutionSlicer.js';
import { StrategyDecayEngine } from './quant/strategyDecayEngine.js';
import { PropFirmRiskGuard } from './quant/propFirmRiskGuard.js';
import { AlertNotifier } from './services/alertNotifier.js';
import { TradeManager } from './services/tradeManager.js';
import { AutoPilotManager } from './services/autoPilotManager.js';
import { PnlService } from './services/pnlService.js';
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
  economicEventGuard: EconomicEventGuard;
  noiseBandEngine: NoiseBandEngine;
  alphaRegistry?: AlphaRegistry;
  adaptiveSizingEngine?: AdaptiveSizingEngine;
  chasingExecutionEngine?: ChasingExecutionEngine;
  twapExecutionSlicer?: TwapExecutionSlicer;
  strategyDecayEngine?: StrategyDecayEngine;
  factorTelemetryRepo?: FactorTelemetryRepo;
  executionChaseLogsRepo?: ExecutionChaseLogsRepo;
  propFirmRiskGuard: PropFirmRiskGuard;
  close: () => Promise<void>;
}> {
  // 1. Initialize SQLite WAL Database Engine
  const db = initializeDatabase(DB_PATH);
  const tradesRepo = new TradesRepo(db);
  const riskRepo = new RiskStateRepo(db);
  const decisionLogsRepo = new DecisionLogsRepo(db);
  const pillarRepo = new PillarTelemetryRepo(db);
  const factorTelemetryRepo = new FactorTelemetryRepo(db);
  const factorTelemetryRecordsRepo = new FactorTelemetryRecordsRepo(db);
  const executionChaseLogsRepo = new ExecutionChaseLogsRepo(db);
  const propFirmRepo = new PropFirmRepo(db);
  let wsHub: WsHub | null = null;
  const alertNotifier = new AlertNotifier();
  const propFirmRiskGuard = new PropFirmRiskGuard(propFirmRepo, {}, (st) =>
    wsHub?.broadcastPropFirmStatus(st)
  );
  const decisionAuditService = new DecisionAuditService(decisionLogsRepo, pillarRepo, {
    factorTelemetryRecordsRepo,
    executionChaseLogsRepo,
    onTelemetryEvent: (ev) => wsHub?.broadcastFactorTelemetry(ev),
  });
  const pillarAttributionService = new PillarAttributionService(pillarRepo);

  // 2. Initialize Binance REST Client & Adapters
  const client = new BinanceClient({
    apiKey: BINANCE_DEMO_API_KEY,
    apiSecret: BINANCE_DEMO_API_SECRET,
    onIpBan: (retryAfterSec, statusCode) => {
      void alertNotifier.notifyCriticalEvent(
        'BINANCE_IP_BAN_418',
        `Binance HTTP ${statusCode} rate-limit / IP ban triggered (retryAfter=${retryAfterSec}s)`,
        { statusCode, retryAfterSec }
      );
    },
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

  propFirmRiskGuard.setOnCriticalTransition((ev) => {
    if (activeBroker.mode !== 'BINANCE_DEMO') return;
    void alertNotifier.notifyCriticalEvent(
      ev.reason,
      `Upcomers $50K ${ev.reason}: ${ev.prevStatus} -> ${ev.nextStatus}`,
      {
        cycleId: ev.status.cycle.id,
        cycleNumber: ev.status.cycle.cycleNumber,
        currentEquityUsd: ev.status.cycle.currentEquityUsd,
        dailyPnlUsd: ev.status.dailyPnlUsd,
      }
    );
  });

  // 3. State and Cache Management
  const watchlistSymbols = parseWatchlistSymbols(process.env.AUTOPILOT_SYMBOLS);
  const watchlistSet = new Set(watchlistSymbols);
  let activeSymbol = watchlistSymbols[0] || 'SOLUSDT';
  let lastWalletBalanceUsd = 0;
  let lastPropFirmEvalAt = 0;
  const markPriceMap = new Map<string, number>(watchlistSymbols.map((s) => [s, 0]));
  const fundingRateMap = new Map<string, { rate: number | null; nextTime: number | null }>();
  const candleHistoryMap = new Map<string, KlineCandle[]>();
  const vwap15mMap = new Map<string, number>();

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
    if (Number.isFinite(account.walletBalance) && account.walletBalance > 0) {
      lastWalletBalanceUsd = account.walletBalance;
    }

    let activePosition = tradesRepo.getActivePositionCached(activeBroker.mode, sym);
    if (activePosition) {
      try {
        const livePos = await activeBroker.getPosition(sym);
        if (livePos && livePos.entryPrice > 0 && Math.abs(livePos.entryPrice - activePosition.entry_price) > 0.0001) {
          tradesRepo.update(activePosition.id, { entry_price: Number(livePos.entryPrice.toFixed(4)) });
          activePosition = tradesRepo.getById(activePosition.id)!;
        }
      } catch {}
    }
    const openOrders = await activeBroker.getOpenOrders(sym).catch(() => []);

    const candles = candleHistoryMap.get(sym) || [];
    const indicators = calculateIndicators(candles, 0.01);
    const cvdSnapshot = symbolQuantRegistry.getOrCreate(sym).cvdEngine.getSnapshot();

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

  const economicEventGuard = new EconomicEventGuard(db);

  // Next-Gen Modular Quant Architecture: Per-Symbol SymbolQuantRegistry
  const symbolQuantRegistry = new SymbolQuantRegistry({
    mtfManager,
    smcEngine,
    sentimentHarvester,
    economicEventGuard,
  });
  for (const sym of watchlistSymbols) {
    symbolQuantRegistry.getOrCreate(sym);
  }
  await symbolQuantRegistry.initializeAll(db);

  const defaultQuantCtx = symbolQuantRegistry.getOrCreate(activeSymbol);
  const cvdEngine = defaultQuantCtx.cvdEngine;
  const noiseBandEngine = defaultQuantCtx.noiseBandEngine;
  const alphaRegistry = defaultQuantCtx.alphaRegistry;
  const confluenceEngine = defaultQuantCtx.confluenceEngine;

  // Strategy Decay Engine & CUSUM drift detection
  const strategyDecayEngine = new StrategyDecayEngine();
  strategyDecayEngine.registerFactor('ORDER_FLOW_L2', 0.20);
  strategyDecayEngine.registerFactor('NATIVE_SMC', 0.20);
  strategyDecayEngine.registerFactor('CVD_ABSORPTION', 0.15);
  strategyDecayEngine.registerFactor('MACRO_REGIME', 0.18);
  strategyDecayEngine.registerFactor('FUNDING_ARBITRAGE', 0.10);
  strategyDecayEngine.registerFactor('CROSS_EXCHANGE_SWEEP', 0.09);
  strategyDecayEngine.registerFactor('LIQ_CLUSTERS', 0.08);

  let autoPilotManagerRef: AutoPilotManager | null = null;

  const prewarmSymbolKlines = (sym: string): void => {
    const ctx = symbolQuantRegistry.getOrCreate(sym);

    // Pre-warm 1m candle history (500 candles) for smooth chart & indicator feeds
    client.getKlines(sym, '1m', 500).then((raw) => {
      if (Array.isArray(raw) && raw.length > 0) {
        const klines = raw.map((k: any) => ({
          time: Math.floor(Number(k[0]) / 1000),
          open: Number(k[1]),
          high: Number(k[2]),
          low: Number(k[3]),
          close: Number(k[4]),
          volume: Number(k[5]),
        }));
        candleHistoryMap.set(sym, klines);
        mtfManager.setInitialCandles(sym, '1m', klines);
        ctx.alphaRegistry.warmup(klines);
      }
    }).catch(() => {});

    // Pre-warm 15m candle history via REST (1000 candles) for SMC, Intermediate Structure & NoiseBandEngine
    client.getKlines(sym, '15m', 1000).then((raw) => {
      if (Array.isArray(raw)) {
        const klines = raw.map((k: any) => ({
          time: Math.floor(Number(k[0]) / 1000),
          open: Number(k[1]),
          high: Number(k[2]),
          low: Number(k[3]),
          close: Number(k[4]),
          volume: Number(k[5]),
        }));
        mtfManager.setInitialCandles(sym, '15m', klines);
        smcEngine.onCandleClosed(sym, '15m', klines);
        ctx.noiseBandEngine.loadKlines(klines);
        vwap15mMap.set(sym, ctx.noiseBandEngine.calculateVWAP(klines));
        ctx.alphaRegistry.warmup(klines);
      }
    }).catch(() => {});

    // Pre-warm 1h candle history via REST (200 candles) for Macro Directional Regime
    client.getKlines(sym, '1h', 200).then((raw) => {
      if (Array.isArray(raw)) {
        const klines = raw.map((k: any) => ({
          time: Math.floor(Number(k[0]) / 1000),
          open: Number(k[1]),
          high: Number(k[2]),
          low: Number(k[3]),
          close: Number(k[4]),
          volume: Number(k[5]),
        }));
        mtfManager.setInitialCandles(sym, '1h', klines);
        ctx.alphaRegistry.warmup(klines);
      }
    }).catch(() => {});
  };

  const switchActiveSymbol = (sym: string): void => {
    const nextSymbol = sym.trim().toUpperCase();
    if (!nextSymbol) return;
    const prevSymbol = activeSymbol;

    if (prevSymbol !== nextSymbol && !watchlistSet.has(prevSymbol)) {
      const prevOpen = tradesRepo.getActivePositionCached(activeBroker.mode, prevSymbol);
      if (!prevOpen) {
        streamsManager.unsubscribeSymbol(prevSymbol);
      }
    }

    activeSymbol = nextSymbol;
    autoPilotManagerRef?.setActiveSymbol(nextSymbol);

    if (watchlistSet.has(nextSymbol) && candleHistoryMap.has(nextSymbol)) {
      void buildCockpitState(nextSymbol)
        .then((snapshot) => {
          createdWsHub.broadcast({ type: 'SNAPSHOT', data: snapshot });
        })
        .catch(() => {});
      return;
    }

    const nextCtx = symbolQuantRegistry.getOrCreate(nextSymbol);
    nextCtx.cvdEngine.reset(nextSymbol);
    mtfManager.reset(nextSymbol);
    smcEngine.reset(nextSymbol);
    nextCtx.confluenceEngine.reset(nextSymbol);
    streamsManager.subscribeSymbol(nextSymbol);
    prewarmSymbolKlines(nextSymbol);
  };

  // 7b. Initialize WebSocket Hub on /ws
  const createdWsHub = new WsHub({
    server,
    path: '/ws',
    sessionToken: SESSION_TOKEN,
    getSnapshot: (sym) => buildCockpitState(sym || activeSymbol),
    getAutoPilotStatus: () => autoPilotManagerRef?.getStatusPayload() ?? null,
    onSubscribeSymbol: (sym) => switchActiveSymbol(sym),
  });
  wsHub = createdWsHub;

  // 8. Initialize TradeManager Atomic Orchestrator
  const tradeManager = new TradeManager({
    db,
    broker: activeBroker,
    brokerMode: activeBroker.mode,
    propFirmRiskGuard,
    alertNotifier,
    getMarkPrice: (sym) => markPriceMap.get(sym) || 0,
    broadcastWs: (msg) => wsHub?.broadcast(msg),
    onTradeOpened: (trade) => {
      void alertNotifier.notifyTradeOpened(trade);
    },
    onTradeClosed: (trade) => {
      if (trade.broker_mode === 'BINANCE_DEMO') {
        const realizedNetPnlUsd = Number(
          ((trade.realized_pnl ?? 0) - (trade.fees_usd ?? 0)).toFixed(2)
        );
        propFirmRiskGuard.recordTradeClosed({
          tradeId: trade.id,
          realizedNetPnlUsd,
          liveWalletBalanceUsd: lastWalletBalanceUsd,
        });
      }
      void alertNotifier.notifyTradeClosed(trade);
    },
  });

  // Next-Gen Execution & Sizing Engines
  const adaptiveSizingEngine = new AdaptiveSizingEngine();
  const chasingExecutionEngine = new ChasingExecutionEngine(activeBroker);
  const twapExecutionSlicer = new TwapExecutionSlicer(chasingExecutionEngine);

  // 8b. Initialize Autonomous Auto-Pilot Manager
  const autoPilotManager = new AutoPilotManager({
    db,
    tradeManager,
    broker: activeBroker,
    confluenceEngine,
    adaptiveSizingEngine,
    propFirmRiskGuard,
    chasingExecutionEngine,
    twapExecutionSlicer,
    executionChaseLogsRepo,
    getSymbolQuantContext: (s) => symbolQuantRegistry.get(s),
    forEachQuantContext: (cb) => symbolQuantRegistry.getAll().forEach(cb),
    watchlistSymbols,
    alertNotifier,
    getMarkPrice: (sym) => markPriceMap.get(sym) || 0,
    getAtr: (sym) => {
      const candles = candleHistoryMap.get(sym) || [];
      const ind = calculateIndicators(candles, 0.01);
      return ind?.atr14 || (markPriceMap.get(sym) || 100) * 0.005;
    },
    broadcastWs: (msg) => wsHub?.broadcast(msg),
    onOrderDispatched: (event) => decisionAuditService.recordExecution(event),
    onTelemetryEvent: (ev) => {
      decisionAuditService.recordFactorTelemetry(ev);
    },
    onStateTransition: (newState) => {
      if (newState === 'IDLE') {
        strategyDecayEngine.flushPendingWeightsIfIdle(newState, (w) =>
          symbolQuantRegistry.applyCalibratedWeights(w)
        );
      }
    },
  });
  autoPilotManagerRef = autoPilotManager;

  if (process.env.AUTOPILOT_AUTO_START === 'true') {
    const currentCfg = autoPilotManager.getConfig();
    autoPilotManager.updateConfig({
      enabled: true,
      consensusThreshold: currentCfg.consensusThreshold >= 20 ? currentCfg.consensusThreshold : 60,
      maxDailyTrades: (currentCfg.maxDailyTrades ?? 0) >= 10 ? currentCfg.maxDailyTrades : 10,
    });
  }

  // 8c. Initialize Multi-Period PnL Performance Service
  const pnlService = new PnlService(
    db,
    tradesRepo,
    client,
    (sym) => markPriceMap.get(sym) || 0,
    () => ({
      mode: activeBroker.mode,
      getAccount: async () => {
        const acc = await activeBroker.getAccount();
        if (acc && Number.isFinite(acc.walletBalance) && acc.walletBalance > 0) {
          lastWalletBalanceUsd = acc.walletBalance;
        }
        return acc;
      },
    })
  );

  const lastTickTelemetryAt = new Map<string, number>();

  // 9. Wire Stream Events to TradeManager, CvdEngine, and WsHub
  streamsManager.onMarkPrice((event) => {
    const sym = event.symbol.toUpperCase();
    if (!watchlistSet.has(sym) && sym !== activeSymbol) return;
    markPriceMap.set(sym, event.markPrice);
    fundingRateMap.set(sym, {
      rate: event.fundingRate,
      nextTime: event.nextFundingTime,
    });

    if (activeBroker.mode === 'LOCAL_PAPER' && 'onMarkPriceTick' in activeBroker) {
      (activeBroker as any).onMarkPriceTick(sym, event.markPrice);
    }

    // Throttled tick broadcast (<= 4Hz)
    const candles = candleHistoryMap.get(sym) || [];
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
      candleHistoryMap.set(sym, [latestCandle]);
    }

    const ctx = symbolQuantRegistry.getOrCreate(sym);
    const cvdSnap = ctx.cvdEngine.getSnapshot();

    if (sym === activeSymbol) {
      const activePos = tradesRepo.getActivePositionCached(activeBroker.mode, sym);
      let uPnl = 0;
      if (activePos && activePos.remaining_qty > 0) {
        uPnl =
          activePos.side === 'BUY'
            ? (event.markPrice - activePos.entry_price) * activePos.remaining_qty
            : (activePos.entry_price - event.markPrice) * activePos.remaining_qty;
      }

      createdWsHub.broadcastTick({
        symbol: sym,
        markPrice: event.markPrice,
        candle: latestCandle,
        cvd: cvdSnap.cvd,
        unrealizedPnl: Number(uPnl.toFixed(4)),
      });
    }

    // 6+1 Confluence Matrix Evaluation & Throttled 2Hz Broadcast
    const ind = calculateIndicators(candles, 0.01);
    const recentHigh = candles.length > 0 ? Math.max(...candles.slice(-20).map(c => c.high)) : undefined;
    const recentLow = candles.length > 0 ? Math.min(...candles.slice(-20).map(c => c.low)) : undefined;

    const candles15m = mtfManager.getCandles(sym, '15m');
    const candle15m = candles15m.length > 0 ? candles15m[candles15m.length - 1] : undefined;
    const prevCandle15m = candles15m.length > 1 ? candles15m[candles15m.length - 2] : undefined;
    const rollingVwap15m = vwap15mMap.get(sym) ?? event.markPrice;

    const confluenceSnapshot = ctx.confluenceEngine.evaluate({
      symbol: sym,
      currentPrice: event.markPrice,
      indicators: ind,
      cvd: cvdSnap,
      recentHigh,
      recentLow,
      candle15m,
      prevCandle15m,
      vwap: rollingVwap15m,
      fundingRate: fundingRateMap.get(sym)?.rate ?? undefined,
    });
    if (sym === activeSymbol) {
      createdWsHub.broadcastConfluence(confluenceSnapshot);
    }

    const atr = ind?.atr14 || (markPriceMap.get(sym) || event.markPrice || 100) * 0.005;
    decisionAuditService.evaluateSnapshot(confluenceSnapshot, atr, event.markPrice);
    if (confluenceSnapshot.telemetryEvent) {
      const te = confluenceSnapshot.telemetryEvent;
      if (te.compositeScore < 70) {
        decisionAuditService.recordFactorTelemetry({
          ...te,
          triggerType: 'SUB_THRESHOLD_IMPULSE',
        });
      } else if (!autoPilotManager.getConfig().enabled || !confluenceSnapshot.consensusMet) {
        const key = `${te.symbol}:${te.consensusSide}`;
        const nowTs = Date.now();
        if (nowTs - (lastTickTelemetryAt.get(key) ?? 0) >= 180_000) {
          lastTickTelemetryAt.set(key, nowTs);
          decisionAuditService.recordFactorTelemetry(te);
        }
      }
    }
    pillarAttributionService.evaluateTick(
      sym,
      event.markPrice,
      atr,
      confluenceSnapshot,
      latestCandle
    );

    // Autonomous Auto-Pilot Tick Evaluation & Live Prop Firm Equity Watchdog
    autoPilotManager
      .onTick(sym, event.markPrice)
      .catch(() => {})
      .finally(() => {
        if (activeBroker.mode !== 'BINANCE_DEMO') return;
        const nowPropFirmTs = Date.now();
        if (nowPropFirmTs - lastPropFirmEvalAt >= 500) {
          lastPropFirmEvalAt = nowPropFirmTs;
          const openPos = tradesRepo.getActivePositionCached(activeBroker.mode, sym);
          let liveUnrealizedPnl = 0;
          if (openPos && openPos.remaining_qty > 0) {
            const rawFloating =
              openPos.side === 'BUY'
                ? (event.markPrice - openPos.entry_price) * openPos.remaining_qty
                : (openPos.entry_price - event.markPrice) * openPos.remaining_qty;
            liveUnrealizedPnl = Number(
              (rawFloating + (openPos.realized_pnl ?? 0) - (openPos.fees_usd ?? 0)).toFixed(2)
            );
          }
          propFirmRiskGuard.evaluateLiveEquity({
            realizedCyclePnlUsd: propFirmRiskGuard.getCurrentRealizedCyclePnl(),
            unrealizedPnlUsd: liveUnrealizedPnl,
            liveWalletBalanceUsd: lastWalletBalanceUsd,
            hasOpenPosition: Boolean(openPos),
            nowMs: nowPropFirmTs,
          });
        }
      });
  });

  streamsManager.onKline((event) => {
    const sym = event.symbol.toUpperCase();
    if (!watchlistSet.has(sym) && sym !== activeSymbol) return;
    const interval = event.interval;
    const ctx = symbolQuantRegistry.getOrCreate(sym);

    // Feed MTF Manager ring buffers for 1m, 15m, and 1h
    if (interval === '1m' || interval === '15m' || interval === '1h') {
      mtfManager.updateCandle(sym, interval as any, event.candle, event.isFinal);
    }

    if (event.isFinal) {
      ctx.alphaRegistry.onCandleClosed(event.candle, interval);
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
      if (interval === '15m') {
        ctx.noiseBandEngine.loadKlines(closedCandles);
        vwap15mMap.set(sym, ctx.noiseBandEngine.calculateVWAP(closedCandles));
      }
    }

    // Trigger Decision Audit shadow tracking on confirmed 1m candle close
    if (event.isFinal && interval === '1m') {
      decisionAuditService.onCandleClose(sym, event.candle);
      pillarAttributionService.onClosedCandle(sym, event.candle);

      const latestSnapshot = symbolQuantRegistry.getLatestSnapshot(sym);
      if (latestSnapshot && latestSnapshot.factorDetails && latestSnapshot.factorDetails.length > 0) {
        const records = latestSnapshot.factorDetails.map((f) => ({
          timestamp: Date.now(),
          symbol: sym,
          factor_id: f.factorId,
          raw_alpha: f.rawAlpha,
          orthogonal_alpha: f.orthogonalAlpha,
          confidence: f.confidence,
          uncertainty: Number((1 - f.confidence).toFixed(4)),
          weight: f.posteriorWeight,
        }));
        try {
          factorTelemetryRepo.insertBatch(records);
        } catch (err) {
          logger.error({ err }, 'Failed to persist factor telemetry batch');
        }

        const candleReturnSign = event.candle.close >= event.candle.open ? 1 : -1;
        for (const f of latestSnapshot.factorDetails) {
          let observation = f.orthogonalAlpha * candleReturnSign;
          try {
            const settled = factorTelemetryRecordsRepo.getSettledByFactor(f.factorId, 60);
            if (settled.length >= 2) {
              const predictions: number[] = [];
              const outcomes: number[] = [];
              for (const row of settled) {
                const sideSign = row.consensus_side === 'SELL' ? -1 : 1;
                const mfe =
                  row.post_1h_mfe ??
                  row.post_15m_mfe ??
                  row.post_5m_mfe ??
                  row.post_1m_mfe ??
                  0;
                const mae =
                  row.post_1h_mae ??
                  row.post_15m_mae ??
                  row.post_5m_mae ??
                  row.post_1m_mae ??
                  0;
                predictions.push(sideSign * row.orthogonal_alpha);
                outcomes.push(mfe - Math.abs(mae));
              }
              observation = computeSpearmanIC(predictions, outcomes);
            }
          } catch {}

          try {
            strategyDecayEngine.updateFactor(f.factorId, observation);
          } catch {}
        }

        strategyDecayEngine.flushPendingWeightsIfIdle(autoPilotManager.getState(), (w) =>
          symbolQuantRegistry.applyCalibratedWeights(w)
        );
      }
    }
  });

  streamsManager.onDepth((event) => {
    const sym = event.symbol ? event.symbol.toUpperCase() : activeSymbol;
    if (!watchlistSet.has(sym) && sym !== activeSymbol) return;
    symbolQuantRegistry.getOrCreate(sym).confluenceEngine.orderFlowEngine.updateDepth(
      event.bids,
      event.asks
    );
  });

  streamsManager.onAggTrade((event) => {
    const sym = event.symbol.toUpperCase();
    if (!watchlistSet.has(sym) && sym !== activeSymbol) return;
    const ctx = symbolQuantRegistry.getOrCreate(sym);
    ctx.cvdEngine.processTrade({
      p: event.price,
      q: event.qty,
      m: event.isBuyerMaker,
      s: sym,
      T: event.time,
    });
    ctx.confluenceEngine.orderFlowEngine.processTrade(
      event.qty,
      event.isBuyerMaker,
      event.time,
      event.price
    );
  });

  streamsManager.onUserData((event) => {
    tradeManager.handleOrderTradeUpdate(event).catch(() => {});
  });

  streamsManager.onReconcile(() => {
    tradeManager.reconcileWithExchange().catch(() => {});
  });

  // 10. Register REST API Endpoints
  registerRoutes(app, {
    tradeManager,
    decisionAuditService,
    pillarAttributionService,
    pnlService,
    propFirmRiskGuard,
    getPropFirmWalletBalance: () => lastWalletBalanceUsd,
    get broker() {
      return activeBroker;
    },
    set broker(b) {
      activeBroker = b;
    },
    onBrokerModeChange: (newAdapter) => {
      activeBroker = newAdapter;
      tradesRepo.invalidateActiveCache();
      autoPilotManager.setBroker(newAdapter);
      newAdapter
        .getAccount()
        .then((acc) => {
          if (acc && Number.isFinite(acc.walletBalance) && acc.walletBalance > 0) {
            lastWalletBalanceUsd = acc.walletBalance;
          }
        })
        .catch(() => null);
    },
    db,
    binanceClient: client,
    streamsManager,
    cvdEngine,
    confluenceEngine,
    getConfluenceSnapshot: (sym) => symbolQuantRegistry.getLatestSnapshot(sym),
    getCvdSnapshot: (sym) => symbolQuantRegistry.get(sym)?.cvdEngine.getSnapshot() ?? null,
    getConfluenceEngine: (sym) => symbolQuantRegistry.get(sym)?.confluenceEngine,
    watchlistSymbols,
    autoPilotManager,
    activeSymbol,
    getActiveSymbol: () => activeSymbol,
    getMarkPrice: (sym) => markPriceMap.get(sym) || 0,
    getFunding: (sym) => fundingRateMap.get(sym) || { rate: null, nextTime: null },
    setActiveSymbol: (sym) => switchActiveSymbol(sym),
    getIndicators: (sym) => {
      const candles = candleHistoryMap.get(sym) || [];
      return calculateIndicators(candles, 0.01);
    },
    getKlines: async (sym, interval, limit) => {
      try {
        const raw = await client.getKlines(sym, interval, limit);
        if (Array.isArray(raw) && raw.length > 50) {
          return raw.map((k: any) => ({
            time: Math.floor(Number(k[0]) / 1000),
            open: Number(k[1]),
            high: Number(k[2]),
            low: Number(k[3]),
            close: Number(k[4]),
            volume: Number(k[5]),
          }));
        }
      } catch (err) {
        console.warn('Binance client getKlines failed, trying public REST:', err);
      }

      // Fallback: public Binance futures REST
      try {
        const url = `https://fapi.binance.com/fapi/v1/klines?symbol=${encodeURIComponent(sym)}&interval=${encodeURIComponent(interval)}&limit=${limit}`;
        const response = await fetch(url, { signal: AbortSignal.timeout(5000) });
        if (response.ok) {
          const raw = (await response.json()) as (string | number)[][];
          if (Array.isArray(raw) && raw.length > 0) {
            return raw.map((row) => ({
              time: Math.floor(Number(row[0]) / 1000),
              open: Number(row[1]),
              high: Number(row[2]),
              low: Number(row[3]),
              close: Number(row[4]),
              volume: Number(row[5]),
            }));
          }
        }
      } catch (e) {
        console.warn('Public REST fallback failed:', e);
      }

      return candleHistoryMap.get(sym) || [];
    },
  });

  // 11. Static SPA Hosting with sirv
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
      single: true,
      setHeaders: (res, pathname) => {
        if (pathname.endsWith('.html') || pathname === '/') {
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
      serveStatic(req as unknown as http.IncomingMessage, res as unknown as http.ServerResponse, next);
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

  // Start Binance WebSocket streams for all watchlist symbols
  await streamsManager.start(watchlistSymbols);

  // Seed live wallet balance cache once on startup for PropFirmRiskGuard HUD
  activeBroker
    .getAccount()
    .then((acc) => {
      if (acc && Number.isFinite(acc.walletBalance) && acc.walletBalance > 0) {
        lastWalletBalanceUsd = acc.walletBalance;
        if (activeBroker.mode === 'BINANCE_DEMO') {
          wsHub?.broadcastPropFirmStatus(propFirmRiskGuard.getStatus(lastWalletBalanceUsd));
        }
      }
    })
    .catch(() => null);

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

  // Staggered boot preloader across all watchlist symbols (250ms per symbol)
  for (let i = 0; i < watchlistSymbols.length; i++) {
    const sym = watchlistSymbols[i]!;
    if (i > 0) {
      await new Promise((r) => setTimeout(r, 250));
    }
    const ctx = symbolQuantRegistry.getOrCreate(sym);

    try {
      const mpData = await client.getMarkPrice(sym);
      const p = parseFloat(mpData?.markPrice || '0');
      if (p > 0) markPriceMap.set(sym, p);
    } catch {}

    try {
      const candles1m = await fetchBootKlines(sym, '1m', 200);
      if (candles1m.length > 0) {
        candleHistoryMap.set(sym, candles1m);
        mtfManager.setInitialCandles(sym, '1m', candles1m);
        ctx.alphaRegistry.warmup(candles1m);
        console.log(`[BOOT] Preloaded ${candles1m.length} 1m candles for ${sym}. Indicators fully warmed up!`);
      }

      const candles15m = await fetchBootKlines(sym, '15m', 1000);
      if (candles15m.length > 0) {
        mtfManager.setInitialCandles(sym, '15m', candles15m);
        smcEngine.onCandleClosed(sym, '15m', candles15m);
        ctx.noiseBandEngine.loadKlines(candles15m);
        vwap15mMap.set(sym, ctx.noiseBandEngine.calculateVWAP(candles15m));
        ctx.alphaRegistry.warmup(candles15m);
        console.log(`[BOOT] Preloaded ${candles15m.length} 15m candles for ${sym}. Native SMC & NoiseBandEngine initialized!`);
      }

      const candles1h = await fetchBootKlines(sym, '1h', 200);
      if (candles1h.length > 0) {
        mtfManager.setInitialCandles(sym, '1h', candles1h);
        ctx.alphaRegistry.warmup(candles1h);
        console.log(`[BOOT] Preloaded ${candles1h.length} 1h candles for ${sym}. Macro Regime & ADX initialized!`);
      }
    } catch (err: any) {
      console.warn(`[BOOT] Failed to preload historical klines for ${sym}: ${err.message}`);
    }

    try {
      const depthResp = await fetch(`https://fapi.binance.com/fapi/v1/depth?symbol=${sym}&limit=20`, {
        signal: AbortSignal.timeout(5000),
      });
      if (depthResp.ok) {
        const depthData = (await depthResp.json()) as any;
        ctx.confluenceEngine.orderFlowEngine.updateDepth(depthData.bids, depthData.asks);
        console.log(`[BOOT] Preloaded initial L2 depth for ${sym}.`);
      }
    } catch (err: any) {
      console.warn(`[BOOT] Failed to preload L2 depth for ${sym}: ${err.message}`);
    }
  }

  // Start hourly economic event calendar ingestion cron and fetch initial events
  await economicEventGuard.fetchCalendar().catch((err: any) => {
    console.warn('[BOOT] Initial economic calendar fetch failed, using DB cache:', err?.message || err);
  });
  economicEventGuard.startCron();
  console.log(`[BOOT] EconomicEventGuard loaded. ${economicEventGuard.getUpcomingEvents(168).length} events tracked.`);

  // Schedule hourly 7-day sub-threshold impulse pruning
  const impulsePruneTimer = setInterval(() => {
    try {
      decisionAuditService.pruneExpiredImpulses(7);
    } catch {}
  }, 3_600_000);
  if (typeof impulsePruneTimer.unref === 'function') {
    impulsePruneTimer.unref();
  }

  // Graceful shutdown helper
  const close = async () => {
    clearInterval(impulsePruneTimer);
    try {
      decisionAuditService.dispose();
    } catch {}
    try {
      await strategyDecayEngine.dispose();
    } catch {}
    try {
      for (const ctx of symbolQuantRegistry.getAll()) {
        await ctx.alphaRegistry.teardown();
      }
    } catch {}
    try {
      economicEventGuard.stopCron();
    } catch {}
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
      await createdWsHub.close();
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
    wsHub: createdWsHub,
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
    economicEventGuard,
    noiseBandEngine,
    alphaRegistry,
    adaptiveSizingEngine,
    chasingExecutionEngine,
    twapExecutionSlicer,
    strategyDecayEngine,
    factorTelemetryRepo,
    executionChaseLogsRepo,
    propFirmRiskGuard,
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
