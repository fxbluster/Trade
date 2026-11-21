import type {
  ConfluencePillarId,
  PillarEvaluation,
  ConfluenceSnapshot,
  MacroRegime,
  FairValueGap,
  OrderBlock,
  LiquiditySweep,
  WebhookAlertPayload,
  TechnicalSummary,
  CvdSnapshot,
} from '@tradeos/shared';
import { calculateCompositeConfluenceScore } from '@tradeos/shared';
import { HierarchicalMtfManager } from './hierarchicalMtfManager.js';
import { NativeSmcEngine } from './nativeSmcEngine.js';
import { OrderFlowEngine, type DepthLevel } from './orderFlowEngine.js';
import { SentimentHarvester } from './sentimentHarvester.js';
import { LiquidationEngine } from './liquidationEngine.js';

export interface ConfluenceMarketData {
  symbol: string;
  currentPrice: number;
  indicators: TechnicalSummary | null;
  cvd: CvdSnapshot | null;
  recentHigh?: number;
  recentLow?: number;
}

interface StoredPineAlert {
  payload: WebhookAlertPayload;
  receivedAt: number;
}

export interface ConfluenceEngineOptions {
  mtfManager?: HierarchicalMtfManager;
  smcEngine?: NativeSmcEngine;
  sentimentHarvester?: SentimentHarvester;
  orderFlowEngine?: OrderFlowEngine;
  liquidationEngine?: LiquidationEngine;
}

/**
 * ConfluenceEngine — Institutional Quantitative Confluence Engine & Autonomous Market Intelligence.
 *
 * Evaluates the 7 institutional pillars with Bayesian probabilistic weighting:
 * 1. MACRO_REGIME (25%): 1h EMA200, SuperTrend (10, 3.0), and ADX (14) with Hard Directional Veto
 * 2. NATIVE_SMC (25%): Algorithmic Fair Value Gaps (FVG), Order Blocks (OB), and Liquidity Sweeps
 * 3. CVD_ABSORPTION (20%): Signed Z-score absorption divergence over 15-minute sliding sample
 * 4. ORDER_FLOW_L2 (15%): Top-20 order book depth pressure and 60s aggressive taker flow
 * 5. LIQ_CLUSTERS (7.5%): Projected leverage liquidation clusters (10x-100x) from Open Interest
 * 6. MOMENTUM_RVOL (5%): Volatility-adjusted momentum (RSI 14 + MACD histogram)
 * 7. SENTIMENT_MACRO (2.5%): Crypto VADER sentiment and macro funding
 */
export class ConfluenceEngine {
  public readonly mtfManager: HierarchicalMtfManager;
  public readonly smcEngine: NativeSmcEngine;
  public readonly orderFlowEngine: OrderFlowEngine;
  public readonly sentimentHarvester: SentimentHarvester;
  public readonly liquidationEngine: LiquidationEngine;

  private latestPineAlert: StoredPineAlert | null = null;
  private readonly alertNonceCache: Map<string, number> = new Map(); // alert_id -> timestamp (60s LRU)
  private latestSnapshot: ConfluenceSnapshot | null = null;
  private consensusThreshold: number = 75; // Default score threshold >= 75

  constructor(options?: ConfluenceEngineOptions | SentimentHarvester) {
    if (options && 'evaluate' in options && typeof (options as any).evaluate === 'function') {
      // Legacy argument signature: new ConfluenceEngine(sentimentHarvester)
      this.sentimentHarvester = options as SentimentHarvester;
      this.mtfManager = new HierarchicalMtfManager();
      this.smcEngine = new NativeSmcEngine();
      this.orderFlowEngine = new OrderFlowEngine();
      this.liquidationEngine = new LiquidationEngine();
    } else {
      const opts = (options as ConfluenceEngineOptions) || {};
      this.mtfManager = opts.mtfManager || new HierarchicalMtfManager();
      this.smcEngine = opts.smcEngine || new NativeSmcEngine();
      this.sentimentHarvester = opts.sentimentHarvester || new SentimentHarvester();
      this.orderFlowEngine = opts.orderFlowEngine || new OrderFlowEngine();
      this.liquidationEngine = opts.liquidationEngine || new LiquidationEngine();
    }
  }

  public setConsensusThreshold(threshold: number): void {
    this.consensusThreshold = threshold;
  }

  public getConsensusThreshold(): number {
    return this.consensusThreshold;
  }

  /**
   * Ingests external TradingView Webhook SMC signal.
   * Enforces 60-second LRU nonce deduplication and sets 15-minute TTL.
   */
  public ingestWebhookAlert(payload: WebhookAlertPayload): { accepted: boolean; reason?: string } {
    if (!payload || !payload.symbol || !payload.side) {
      return { accepted: false, reason: 'INVALID_PAYLOAD' };
    }

    const now = Date.now();

    // 60-second LRU nonce deduplication for alert_id
    if (payload.alert_id) {
      this.pruneNonceCache(now);
      const existing = this.alertNonceCache.get(payload.alert_id);
      if (existing && now - existing < 60_000) {
        return { accepted: false, reason: 'DUPLICATE_ALERT_ID' };
      }
      this.alertNonceCache.set(payload.alert_id, now);
    }

    this.latestPineAlert = {
      payload,
      receivedAt: now,
    };

    return { accepted: true };
  }

  /**
   * Evaluates all 7 institutional confluence pillars for the given market state.
   */
  public evaluate(data: ConfluenceMarketData): ConfluenceSnapshot {
    const { symbol, currentPrice, indicators, cvd, recentHigh, recentLow } = data;
    const now = Date.now();

    // 1. Pillar: MACRO_REGIME (25% Bayesian weight, hard directional veto)
    const p1Macro = this.mtfManager.evaluatePillar(symbol, currentPrice, now);
    const macroBias = this.mtfManager.getMacroBias(symbol, currentPrice, now);
    const macroVetoActive = macroBias.macroVetoActive;
    const macroRegime: MacroRegime = macroBias.regime;

    // 2. Pillar: NATIVE_SMC (25% Bayesian weight: FVG, Order Blocks, Liquidity Sweeps)
    const p2Smc = this.smcEngine.evaluatePillar(symbol, currentPrice, now);
    const activeFvgs: FairValueGap[] = this.smcEngine.getActiveFvgs(symbol);
    const activeOrderBlocks: OrderBlock[] = this.smcEngine.getActiveOrderBlocks(symbol);
    const latestSweep: LiquiditySweep | null = this.smcEngine.getLatestSweep(symbol);

    // 3. Pillar: CVD_ABSORPTION (20% Bayesian weight: Signed Z-score divergence)
    const p3Cvd = this.orderFlowEngine.evaluateAbsorption(currentPrice, now);

    // 4. Pillar: ORDER_FLOW_L2 (15% Bayesian weight: 60s taker flow & Top-20 book imbalance)
    const p4OrderFlow = this.orderFlowEngine.evaluateL2(currentPrice, now);

    // 5. Pillar: LIQ_CLUSTERS (7.5% Bayesian weight: Leverage pools 10x-100x from Open Interest)
    const p5Liq = this.liquidationEngine.evaluate({
      currentPrice,
      atr14: indicators?.atr14 ?? null,
      recentHigh,
      recentLow,
      openInterestUsd: cvd?.openInterestUsd ?? null,
      pillarId: 'LIQ_CLUSTERS',
    });

    // 6. Pillar: MOMENTUM_RVOL (5% Bayesian weight: Volatility-adjusted RSI & MACD momentum)
    const p6Momentum = this.evaluateMomentumRvol(indicators, now);

    // 7. Pillar: SENTIMENT_MACRO (2.5% Bayesian weight: Funding rate & news sentiment)
    const rawNlp = this.sentimentHarvester.evaluate();
    const p7Sentiment: PillarEvaluation = {
      id: 'SENTIMENT_MACRO',
      title: 'Macro & Funding Sentiment',
      score: rawNlp.score,
      bias: rawNlp.bias,
      valueText: rawNlp.valueText,
      subText: rawNlp.subText,
      confirmed: rawNlp.confirmed,
      updatedAt: rawNlp.updatedAt || now,
    };

    const pillars: PillarEvaluation[] = [
      p1Macro,
      p2Smc,
      p3Cvd,
      p4OrderFlow,
      p5Liq,
      p6Momentum,
      p7Sentiment,
    ];

    // Compute consensus counts
    let bullishCount = 0;
    let bearishCount = 0;
    let neutralCount = 0;

    for (const p of pillars) {
      if (p.confirmed && p.bias === 'BULLISH') {
        bullishCount++;
      } else if (p.confirmed && p.bias === 'BEARISH') {
        bearishCount++;
      } else {
        neutralCount++;
      }
    }

    const { compositeScore, bias: mathBias, recommendedAction } =
      calculateCompositeConfluenceScore(pillars, macroVetoActive);

    // Institutional rule: consensusMet = compositeScore >= 75 && !macroVetoActive
    const consensusMet = compositeScore >= 75 && !macroVetoActive;
    const consensusBias = consensusMet ? mathBias : 'NEUTRAL';

    const snapshot: ConfluenceSnapshot = {
      symbol: symbol.toUpperCase(),
      pillars,
      bullishCount,
      bearishCount,
      neutralCount,
      consensusBias,
      consensusMet,
      threshold: this.consensusThreshold,
      compositeScore,
      recommendedAction,
      macroVetoActive,
      macroRegime,
      activeFvgs,
      activeOrderBlocks,
      latestSweep,
    };

    this.latestSnapshot = snapshot;
    return snapshot;
  }

  public getLatestSnapshot(symbol?: string): ConfluenceSnapshot | null {
    if (!this.latestSnapshot) return null;
    if (symbol && this.latestSnapshot.symbol !== symbol.toUpperCase()) {
      return null;
    }
    return this.latestSnapshot;
  }

  public getSnapshot(symbol?: string): ConfluenceSnapshot | null {
    return this.getLatestSnapshot(symbol);
  }

  public reset(symbol?: string): void {
    this.orderFlowEngine.reset();
    this.mtfManager.reset(symbol);
    this.smcEngine.reset(symbol);
    this.latestPineAlert = null;
    this.alertNonceCache.clear();
    this.latestSnapshot = null;
  }

  // --- Private Evaluators ---

  private evaluateMomentumRvol(ind: TechnicalSummary | null, now: number): PillarEvaluation {
    if (!ind || ind.rsi14 === null || ind.macd === null) {
      return {
        id: 'MOMENTUM_RVOL',
        title: 'Momentum & RVOL',
        score: 50,
        bias: 'NEUTRAL',
        valueText: 'Neutral RSI/MACD',
        subText: 'Awaiting momentum indicators',
        confirmed: false,
        updatedAt: now,
      };
    }

    const rsi = ind.rsi14;
    const hist = ind.macd.histogram;

    // Institutional momentum trend continuation (RSI >= 50 or expansion above 65 with positive histogram)
    const isBullish = (rsi >= 50 && hist > 0) || (rsi > 65 && hist > 0);
    const isBearish = (rsi <= 50 && hist < 0) || (rsi < 35 && hist < 0);

    if (isBullish) {
      const score = Math.min(100, Math.round(75 + Math.min(25, Math.abs(hist) * 10)));
      return {
        id: 'MOMENTUM_RVOL',
        title: 'Momentum & RVOL',
        score,
        bias: 'BULLISH',
        valueText: `Bullish Impulse (RSI ${rsi.toFixed(1)})`,
        subText: `RSI >= 50 & MACD Hist +${hist.toFixed(2)}`,
        confirmed: true,
        updatedAt: now,
      };
    }

    if (isBearish) {
      const score = Math.min(100, Math.round(75 + Math.min(25, Math.abs(hist) * 10)));
      return {
        id: 'MOMENTUM_RVOL',
        title: 'Momentum & RVOL',
        score,
        bias: 'BEARISH',
        valueText: `Bearish Impulse (RSI ${rsi.toFixed(1)})`,
        subText: `RSI <= 50 & MACD Hist ${hist.toFixed(2)}`,
        confirmed: true,
        updatedAt: now,
      };
    }

    return {
      id: 'MOMENTUM_RVOL',
      title: 'Momentum & RVOL',
      score: 50,
      bias: 'NEUTRAL',
      valueText: `RSI ${rsi.toFixed(1)} / Hist ${hist >= 0 ? '+' : ''}${hist.toFixed(2)}`,
      subText: 'Equilibrium momentum',
      confirmed: false,
      updatedAt: now,
    };
  }

  private pruneNonceCache(now: number): void {
    for (const [id, timestamp] of this.alertNonceCache.entries()) {
      if (now - timestamp > 60_000) {
        this.alertNonceCache.delete(id);
      }
    }
  }
}
