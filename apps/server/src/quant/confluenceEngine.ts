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
import { calculateCompositeConfluenceScore } from '@tradeos/shared';
import { HierarchicalMtfManager } from './hierarchicalMtfManager.js';
import { NativeSmcEngine } from './nativeSmcEngine.js';
import { OrderFlowEngine, type DepthLevel } from './orderFlowEngine.js';
import { SentimentHarvester } from './sentimentHarvester.js';
import { LiquidationEngine } from './liquidationEngine.js';
import { NoiseBandEngine, noiseBandEngine } from './noiseBandEngine.js';
import { EconomicEventGuard, economicEventGuard } from './economicEventGuard.js';
import type { AlphaRegistry, CompositeFactorEvaluation } from './alphaRegistry.js';

/**
 * [ARCH-15] Recalibrated 7-pillar Bayesian weights (strictly summing to 1.0):
 * - Reduces NATIVE_SMC from 25% to 17.5%
 * - Redistributes +7.5% across MOMENTUM_RVOL (5% -> 9%) and LIQ_CLUSTERS (7.5% -> 11%)
 */
export const CALIBRATED_CONFLUENCE_WEIGHTS: Record<ConfluencePillarId, number> = {
  MACRO_REGIME: 0.25,
  NATIVE_SMC: 0.175,
  CVD_ABSORPTION: 0.20,
  ORDER_FLOW_L2: 0.15,
  LIQ_CLUSTERS: 0.11,
  MOMENTUM_RVOL: 0.09,
  SENTIMENT_MACRO: 0.025,
};

export interface ConfluenceMarketData {
  symbol: string;
  currentPrice: number;
  indicators: TechnicalSummary | null;
  cvd: CvdSnapshot | null;
  recentHigh?: number;
  recentLow?: number;
  candle15m?: KlineCandle;
  prevCandle15m?: KlineCandle;
  candles?: KlineCandle[];
  vwap?: number;
  timestamp?: number;
  depth?: { bids: DepthLevel[]; asks: DepthLevel[] };
  fundingRate?: number;
  spotPrice?: number;
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
    // Use 15m ATR(14) from mtfManager when available so 1m ATR never falsely triggers 15m breakout bypass.
    const candles15mForNoise = this.mtfManager.getCandles(symbol, '15m');
    const atr14ForNoiseBand =
      this.compute15mAtr14(candles15mForNoise) ?? indicators?.atr14 ?? undefined;
    const gateCheck = this.checkPreTradeGates(
      symbol,
      currentPrice,
      data.candle15m,
      data.vwap,
      now,
      data.prevCandle15m,
      atr14ForNoiseBand
    );

    const blockReason: BlockReason | null = gateCheck.blocked ? (gateCheck.reason ?? null) : null;
    const eventBlackoutActive = gateCheck.reason === 'BLOCKED_EVENT_BLACKOUT';
    const noiseBandActive = gateCheck.reason === 'BLOCKED_NOISE_BAND';

    const noiseBandTelemetry: NoiseBandTelemetry | undefined =
      data.candle15m && data.vwap !== undefined
        ? {
            active: noiseBandActive,
            currentTrueRange15m: Number(
              Math.max(
                data.candle15m.high - data.candle15m.low,
                data.prevCandle15m ? data.prevCandle15m.high - data.prevCandle15m.low : 0
              ).toFixed(4)
            ),
            meanTrueRange20d: this.noiseBandEngine.getMeanTrueRange(new Date(now).getUTCHours()),
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
      const candles = this.resolveFactorCandles(symbol, data.candles);
      const depth = data.depth || this.orderFlowEngine.getDepth();
      const context: FactorEvaluationContext & { fundingRate?: number; spotPrice?: number } = {
        symbol,
        currentPrice,
        depth,
        cvd: cvd ?? undefined,
        candles,
        indicators: indicators ?? undefined,
        timestamp: now,
        ...(data.fundingRate !== undefined ? { fundingRate: data.fundingRate } : {}),
        ...(data.spotPrice !== undefined ? { spotPrice: data.spotPrice } : {}),
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
    const isScoreThresholdMode = this.consensusThreshold >= 20;
    const minConvictionScore = isScoreThresholdMode ? this.consensusThreshold : 60;

    let isHardLongVeto = false;

    if (alphaEval && alphaEval.details && alphaEval.details.length > 0) {
      // [ARCH-03] AlphaRegistry emits signed conviction (50 = neutral, <50 = bearish).
      // Convert BEARISH conviction (< 50) to symmetric magnitude [0..100] so SELL/STRONG_SELL fire symmetrically.
      compositeScore =
        alphaEval.compositeBias === 'BEARISH' && alphaEval.compositeScore < 50
          ? 100 - alphaEval.compositeScore
          : alphaEval.compositeScore;
      mathBias = alphaEval.compositeBias;

      // macroVeto only constrains LONG entries:
      // - Hard veto when 1h macro regime is confirmed BEARISH
      // - Soft -10 penalty when 1h is RANGING below EMA200 (allows high-conviction V-reversals)
      // - Never blocks SHORT entries
      isHardLongVeto = macroVetoActive && mathBias === 'BULLISH' && macroRegime === 'MACRO_BEARISH';
      const isSoftLongPenalty =
        macroVetoActive &&
        macroBias.ema200 !== null &&
        mathBias === 'BULLISH' &&
        macroRegime !== 'MACRO_BEARISH';
      if (isSoftLongPenalty) {
        compositeScore = Math.max(0, compositeScore - 10);
      }

      if (isHardLongVeto) {
        baseRecommendedAction = 'WAIT';
      } else if (mathBias === 'BULLISH') {
        baseRecommendedAction =
          compositeScore >= Math.max(75, minConvictionScore)
            ? 'STRONG_BUY'
            : compositeScore >= minConvictionScore
              ? 'BUY'
              : 'WAIT';
      } else if (mathBias === 'BEARISH') {
        baseRecommendedAction =
          compositeScore >= Math.max(75, minConvictionScore)
            ? 'STRONG_SELL'
            : compositeScore >= minConvictionScore
              ? 'SELL'
              : 'WAIT';
      } else {
        baseRecommendedAction = 'WAIT';
      }
    } else {
      const legacyResult = calculateCompositeConfluenceScore(
        pillars,
        macroVetoActive,
        CALIBRATED_CONFLUENCE_WEIGHTS
      );
      compositeScore = legacyResult.compositeScore;
      mathBias = legacyResult.bias;
      baseRecommendedAction = legacyResult.recommendedAction;
      isHardLongVeto = macroVetoActive && mathBias === 'BULLISH';
    }

    // Institutional consensus rule:
    // - Next-Gen % score mode (threshold >= 20, e.g. 60/65/70/75 from Cockpit HUD): compositeScore >= threshold
    // - Legacy pillar-count mode (threshold < 20, e.g. 4/7 pillars): compositeScore >= 75 OR (>= 60 && >= threshold pillars)
    // - Blocked if pre-trade gates or hard long macro veto are active
    const directionalCount = mathBias === 'BULLISH' ? bullishCount : mathBias === 'BEARISH' ? bearishCount : 0;
    const thresholdMet = isScoreThresholdMode
      ? compositeScore >= this.consensusThreshold
      : directionalCount >= this.consensusThreshold;
    const isActionable =
      baseRecommendedAction === 'BUY' ||
      baseRecommendedAction === 'STRONG_BUY' ||
      baseRecommendedAction === 'SELL' ||
      baseRecommendedAction === 'STRONG_SELL';

    const consensusMet =
      !gateCheck.blocked &&
      !isHardLongVeto &&
      (isScoreThresholdMode
        ? thresholdMet && isActionable
        : compositeScore >= 75 || (compositeScore >= 60 && thresholdMet && isActionable));
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
    timestamp?: number,
    prevCandle15m?: KlineCandle,
    atr14?: number
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
      const isNoise = this.noiseBandEngine.isNoise(candle15m, vwap, currentPrice, prevCandle15m, atr14);
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

  private compute15mAtr14(candles: KlineCandle[]): number | undefined {
    if (candles.length < 15) return undefined;
    const slice = candles.slice(-15);
    let trSum = 0;
    for (let i = 1; i < slice.length; i++) {
      const cur = slice[i]!;
      const prev = slice[i - 1]!;
      const tr = Math.max(
        cur.high - cur.low,
        Math.abs(cur.high - prev.close),
        Math.abs(cur.low - prev.close)
      );
      trSum += tr;
    }
    return trSum / 14;
  }

  private resolveFactorCandles(symbol: string, explicitCandles?: KlineCandle[]): KlineCandle[] {
    if (explicitCandles && explicitCandles.length > 0) {
      return explicitCandles;
    }
    const mtf15m = this.mtfManager.getCandles(symbol, '15m');
    if (mtf15m.length >= 5) return mtf15m;
    const mtf1h = this.mtfManager.getCandles(symbol, '1h');
    if (mtf1h.length >= 5) return mtf1h;
    const mtf1m = this.mtfManager.getCandles(symbol, '1m');
    if (mtf1m.length >= 5) return mtf1m;
    if (mtf15m.length > 0) return mtf15m;
    if (mtf1h.length > 0) return mtf1h;
    return mtf1m;
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
    const rawWeights = pillars.map((p) => CALIBRATED_CONFLUENCE_WEIGHTS[p.id] ?? 1 / Math.max(1, pillars.length));
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
