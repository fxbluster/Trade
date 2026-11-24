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
  KlineCandle,
  BlockReason,
  FactorOutput,
  FactorDetail,
  FactorEvaluationContext,
  NoiseBandTelemetry,
  QuantConvictionArchetype,
  FactorStateDetail,
  FactorTelemetryEvent,
} from '@tradeos/shared';
import { calculateCompositeConfluenceScore, EMPIRICAL_CONFLUENCE_WEIGHTS } from '@tradeos/shared';
import { HierarchicalMtfManager } from './hierarchicalMtfManager.js';
import { NativeSmcEngine } from './nativeSmcEngine.js';
import { OrderFlowEngine, type DepthLevel } from './orderFlowEngine.js';
import { SentimentHarvester } from './sentimentHarvester.js';
import { LiquidationEngine } from './liquidationEngine.js';
import { NoiseBandEngine, noiseBandEngine } from './noiseBandEngine.js';
import { EconomicEventGuard, economicEventGuard } from './economicEventGuard.js';
import type { AlphaRegistry, CompositeFactorEvaluation } from './alphaRegistry.js';

export interface ConfluenceMarketData {
  symbol: string;
  currentPrice: number;
  indicators: TechnicalSummary | null;
  cvd: CvdSnapshot | null;
  recentHigh?: number;
  recentLow?: number;
  candle15m?: KlineCandle;
  candles?: KlineCandle[];
  vwap?: number;
  timestamp?: number;
  depth?: { bids: DepthLevel[]; asks: DepthLevel[] };
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
  noiseBandEngine?: NoiseBandEngine;
  economicEventGuard?: EconomicEventGuard;
  alphaRegistry?: AlphaRegistry;
}

/**
 * ConfluenceEngine — Institutional Quantitative Confluence Engine & Autonomous Market Intelligence.
 *
 * Evaluates the 7 institutional pillars with calibrated Bayesian probabilistic weighting:
 * 1. ORDER_FLOW_L2 (20%): Depth pressure & 60s aggressive taker flow (Alpha Leader)
 * 2. NATIVE_SMC (23%): Algorithmic Fair Value Gaps (FVG), Order Blocks (OB), and Sweeps
 * 3. CVD_ABSORPTION (17%): Signed Z-score absorption divergence
 * 4. MACRO_REGIME (20%): 1h EMA200, SuperTrend (10, 3.0), and ADX (14) smooth plateau [20-23]
 * 5. LIQ_CLUSTERS (8%): Leverage liquidation clusters with tightened 0.45x ATR proximity
 * 6. MOMENTUM_RVOL (6%): Volatility-adjusted RSI & MACD momentum
 * 7. SENTIMENT_MACRO (6%): Macro news and funding sentiment
 */
export class ConfluenceEngine {
  public readonly mtfManager: HierarchicalMtfManager;
  public readonly smcEngine: NativeSmcEngine;
  public readonly orderFlowEngine: OrderFlowEngine;
  public readonly sentimentHarvester: SentimentHarvester;
  public readonly liquidationEngine: LiquidationEngine;
  public readonly noiseBandEngine: NoiseBandEngine;
  public readonly economicEventGuard: EconomicEventGuard;
  public alphaRegistry: AlphaRegistry | null = null;

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
      this.noiseBandEngine = noiseBandEngine;
      this.economicEventGuard = economicEventGuard;
      this.alphaRegistry = null;
    } else {
      const opts = (options as ConfluenceEngineOptions) || {};
      this.mtfManager = opts.mtfManager || new HierarchicalMtfManager();
      this.smcEngine = opts.smcEngine || new NativeSmcEngine();
      this.sentimentHarvester = opts.sentimentHarvester || new SentimentHarvester();
      this.orderFlowEngine = opts.orderFlowEngine || new OrderFlowEngine();
      this.liquidationEngine = opts.liquidationEngine || new LiquidationEngine();
      this.noiseBandEngine = opts.noiseBandEngine || noiseBandEngine;
      this.economicEventGuard = opts.economicEventGuard || economicEventGuard;
      this.alphaRegistry = opts.alphaRegistry || null;
    }
  }

  public setAlphaRegistry(registry: AlphaRegistry): void {
    this.alphaRegistry = registry;
  }

  public getAlphaRegistry(): AlphaRegistry | null {
    return this.alphaRegistry;
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

    // 5. Pillar: LIQ_CLUSTERS (8% Bayesian weight: Leverage pools 10x-100x from Open Interest)
    const p5Liq = this.liquidationEngine.evaluate({
      currentPrice,
      atr14: indicators?.atr14 ?? null,
      recentHigh,
      recentLow,
      openInterestUsd: cvd?.openInterestUsd ?? null,
      pillarId: 'LIQ_CLUSTERS',
      triggerAtrMultiplier: 0.45,
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

    // Pre-consensus gates: Economic Event Blackout & Noise Band Filter
    const gateCheck = this.checkPreTradeGates(
      symbol,
      currentPrice,
      data.candle15m,
      data.vwap,
      now
    );

    const blockReason: BlockReason | null = gateCheck.blocked ? (gateCheck.reason ?? null) : null;
    const eventBlackoutActive = gateCheck.reason === 'BLOCKED_EVENT_BLACKOUT';
    const noiseBandActive = gateCheck.reason === 'BLOCKED_NOISE_BAND';

    const noiseBandTelemetry: NoiseBandTelemetry | undefined =
      data.candle15m && data.vwap !== undefined
        ? {
            active: noiseBandActive,
            currentTrueRange15m: Number((data.candle15m.high - data.candle15m.low).toFixed(4)),
            meanTrueRange20d: this.noiseBandEngine.getThreshold(new Date(now).getUTCHours()) / 1.25,
            noiseThreshold: this.noiseBandEngine.getThreshold(new Date(now).getUTCHours()),
            isNoise: noiseBandActive,
            currentPrice,
            vwap: data.vwap,
            vwapDistancePct:
              data.vwap > 0
                ? Number((Math.abs(currentPrice - data.vwap) / data.vwap).toFixed(6))
                : 0,
          }
        : undefined;

    // Quantitative factor evaluation via AlphaRegistry (invoked if pre-trade gates pass)
    let alphaEval: CompositeFactorEvaluation | null = null;
    if (!eventBlackoutActive && this.alphaRegistry) {
      const candles =
        data.candles ||
        (data.candle15m ? [data.candle15m] : this.mtfManager.getCandles(symbol, '1m'));
      const depth = data.depth || this.orderFlowEngine.getDepth();
      const context: FactorEvaluationContext = {
        symbol,
        currentPrice,
        depth,
        cvd: cvd ?? undefined,
        candles,
        indicators: indicators ?? undefined,
        timestamp: now,
      };
      try {
        alphaEval = this.alphaRegistry.evaluate(context);
      } catch (err) {
        console.warn('[ConfluenceEngine] AlphaRegistry evaluation error:', err);
      }
    }

    let compositeScore: number;
    let mathBias: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
    let baseRecommendedAction: 'STRONG_BUY' | 'BUY' | 'WAIT' | 'SELL' | 'STRONG_SELL' = 'WAIT';

    if (alphaEval && alphaEval.details && alphaEval.details.length > 0) {
      compositeScore = alphaEval.compositeScore;
      mathBias = alphaEval.compositeBias;
      if (macroVetoActive) {
        baseRecommendedAction = 'WAIT';
      } else if (mathBias === 'BULLISH') {
        baseRecommendedAction = compositeScore >= 75 ? 'STRONG_BUY' : compositeScore >= 60 ? 'BUY' : 'WAIT';
      } else if (mathBias === 'BEARISH') {
        baseRecommendedAction = compositeScore >= 75 ? 'STRONG_SELL' : compositeScore >= 60 ? 'SELL' : 'WAIT';
      } else {
        baseRecommendedAction = 'WAIT';
      }
    } else {
      const legacyResult = calculateCompositeConfluenceScore(
        pillars,
        macroVetoActive,
        EMPIRICAL_CONFLUENCE_WEIGHTS
      );
      compositeScore = legacyResult.compositeScore;
      mathBias = legacyResult.bias;
      baseRecommendedAction = legacyResult.recommendedAction;
    }

    // Institutional consensus rule:
    // 1. Either compositeScore >= 75 (STRONG signal)
    // 2. OR compositeScore >= 60 AND active directional pillars >= this.consensusThreshold (standard institutional consensus)
    // 3. No macro veto is active
    const directionalCount = mathBias === 'BULLISH' ? bullishCount : mathBias === 'BEARISH' ? bearishCount : 0;
    const thresholdMet = directionalCount >= this.consensusThreshold;
    const isActionable =
      baseRecommendedAction === 'BUY' ||
      baseRecommendedAction === 'STRONG_BUY' ||
      baseRecommendedAction === 'SELL' ||
      baseRecommendedAction === 'STRONG_SELL';

    const consensusMet =
      !gateCheck.blocked &&
      !macroVetoActive &&
      (compositeScore >= 75 || (compositeScore >= 60 && thresholdMet && isActionable));
    const consensusBias = consensusMet ? mathBias : 'NEUTRAL';
    const finalRecommendedAction = gateCheck.blocked ? 'WAIT' : baseRecommendedAction;

    const factorDetails: FactorDetail[] | undefined = alphaEval?.details;
    const factorOutputs: FactorOutput[] | undefined = alphaEval?.details?.map((d) => ({
      factorId: d.factorId,
      bias: d.bias,
      rawAlpha: d.rawAlpha,
      confidence: d.confidence,
      uncertainty: Number((1 - d.confidence).toFixed(4)),
      halfLifeMs: 900_000,
      metadata: {
        name: d.name,
        orthogonalAlpha: d.orthogonalAlpha,
        posteriorWeight: d.posteriorWeight,
        isCollinear: d.isCollinear,
        informationRatio: d.informationRatio,
      },
    }));

    const macroVetoReason = macroVetoActive
      ? p1Macro.valueText || `Macro Regime: ${macroRegime}`
      : eventBlackoutActive
        ? gateCheck.details
        : undefined;

    const telemetryEvent = synthesizeTelemetryEvent({
      timestamp: now,
      symbol: symbol.toUpperCase(),
      markPrice: currentPrice,
      compositeScore,
      consensusBias,
      mathBias,
      consensusMet,
      noiseBandActive,
      macroVetoActive,
      macroVetoReason,
      alphaDetails: alphaEval?.details,
      pillars,
    });

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
      recommendedAction: finalRecommendedAction,
      macroVetoActive,
      macroRegime,
      activeFvgs,
      activeOrderBlocks,
      latestSweep,
      blockReason,
      eventBlackoutActive,
      noiseBandActive,
      noiseBand: noiseBandTelemetry,
      factorOutputs,
      factorDetails,
      telemetryEvent,
    };

    this.latestSnapshot = snapshot;
    return snapshot;
  }

  /**
   * Evaluates pre-trade volatility and economic event gates.
   */
  public checkPreTradeGates(
    symbol: string,
    currentPrice: number,
    candle15m?: KlineCandle,
    vwap?: number,
    timestamp?: number
  ): { blocked: boolean; reason?: BlockReason; details?: string } {
    const now = timestamp ?? Date.now();

    // 1. Economic Event Blackout Gate (+/- 15m)
    const blackout = this.economicEventGuard.isBlackoutActive(now);
    if (blackout.active) {
      return {
        blocked: true,
        reason: 'BLOCKED_EVENT_BLACKOUT',
        details: `Blackout active for ${blackout.eventName ?? 'Economic Event'} (${blackout.remainingSeconds ?? 0}s remaining)`,
      };
    }

    // 2. Volatility Noise Band Filter Gate
    if (candle15m && vwap !== undefined) {
      const isNoise = this.noiseBandEngine.isNoise(candle15m, vwap, currentPrice);
      if (isNoise) {
        return {
          blocked: true,
          reason: 'BLOCKED_NOISE_BAND',
          details: 'Market range is within the 20-day 15m True Range noise threshold',
        };
      }
    }

    return { blocked: false };
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

export function mapConvictionArchetype(compositeScore: number): QuantConvictionArchetype {
  if (compositeScore >= 95) return 'A_PLUS_INSTITUTIONAL';
  if (compositeScore >= 85) return 'HIGH_CONVICTION_CORE';
  if (compositeScore >= 75) return 'STANDARD_INSTITUTIONAL';
  if (compositeScore >= 70) return 'EXPLORATORY_PROBE';
  return 'SUB_THRESHOLD';
}

export function synthesizeTelemetryEvent(params: {
  timestamp: number;
  symbol: string;
  markPrice: number;
  compositeScore: number;
  consensusBias: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
  mathBias: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
  consensusMet: boolean;
  noiseBandActive: boolean;
  macroVetoActive: boolean;
  macroVetoReason?: string;
  alphaDetails?: FactorDetail[];
  pillars: PillarEvaluation[];
}): FactorTelemetryEvent {
  const {
    timestamp,
    symbol,
    markPrice,
    compositeScore,
    consensusBias,
    mathBias,
    consensusMet,
    noiseBandActive,
    macroVetoActive,
    macroVetoReason,
    alphaDetails,
    pillars,
  } = params;

  const effectiveBias = consensusBias !== 'NEUTRAL' ? consensusBias : mathBias;
  const consensusSide: FactorTelemetryEvent['consensusSide'] =
    effectiveBias === 'BULLISH' ? 'BUY' : effectiveBias === 'BEARISH' ? 'SELL' : 'NEUTRAL';

  let activeFactors: FactorStateDetail[];
  let collinearFactors: string[];

  if (alphaDetails && alphaDetails.length > 0) {
    activeFactors = alphaDetails
      .filter((d) => !d.isCollinear)
      .map((d) => {
        const matchedPillar = pillars.find((p) => p.id === d.factorId);
        const summaryText = matchedPillar?.valueText
          ? `${matchedPillar.valueText} (IR ${d.informationRatio.toFixed(2)})`
          : `${d.bias} α=${d.orthogonalAlpha.toFixed(2)} (IR ${d.informationRatio.toFixed(2)})`;
        return {
          factorId: d.factorId,
          name: d.name,
          bias: d.bias,
          rawAlpha: d.rawAlpha,
          orthogonalAlpha: d.orthogonalAlpha,
          effectiveWeight: d.posteriorWeight,
          isCollinear: false,
          confidence: d.confidence,
          summaryText,
        };
      });
    collinearFactors = alphaDetails.filter((d) => d.isCollinear).map((d) => d.name);
  } else {
    const rawWeights = pillars.map((p) => EMPIRICAL_CONFLUENCE_WEIGHTS[p.id] ?? 1 / Math.max(1, pillars.length));
    const totalWeight = rawWeights.reduce((sum, w) => sum + w, 0) || 1;
    activeFactors = pillars.map((p, idx) => {
      const signedMag = Math.max(0, Math.min(1, Math.abs(p.score - 50) / 50));
      const signedAlpha =
        p.bias === 'BULLISH' ? signedMag : p.bias === 'BEARISH' ? -signedMag : 0;
      return {
        factorId: p.id,
        name: p.title,
        bias: p.bias,
        rawAlpha: Number(signedAlpha.toFixed(4)),
        orthogonalAlpha: Number(signedAlpha.toFixed(4)),
        effectiveWeight: Number(((rawWeights[idx] ?? 0) / totalWeight).toFixed(4)),
        isCollinear: false,
        confidence: Number(Math.max(0, Math.min(1, p.score / 100)).toFixed(4)),
        summaryText: p.valueText || p.subText || p.title,
      };
    });
    collinearFactors = [];
  }

  return {
    timestamp,
    symbol,
    triggerType: compositeScore >= 70 && consensusMet ? 'SIGNAL_CONFIRMED' : 'SUB_THRESHOLD_IMPULSE',
    markPrice,
    compositeScore,
    convictionArchetype: mapConvictionArchetype(compositeScore),
    consensusSide,
    noiseBandActive,
    macroVetoActive,
    ...(macroVetoReason ? { macroVetoReason } : {}),
    activeFactors,
    collinearFactors,
  };
}
