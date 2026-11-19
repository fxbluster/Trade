import type {
  ConfluencePillarId,
  PillarEvaluation,
  ConfluenceSnapshot,
  WebhookAlertPayload,
  TechnicalSummary,
  CvdSnapshot,
} from '@tradeos/shared';
import { calculateCompositeConfluenceScore } from '@tradeos/shared';
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

/**
 * ConfluenceEngine — 6+1 Confluence Matrix Aggregator.
 *
 * Evaluates the 7 quantitative pillars:
 * 1. MTF_TREND (20%): EMA 9/21/50/200 stack + ADX
 * 2. MOMENTUM (15%): RSI 14 + MACD Histogram
 * 3. ORDER_FLOW (20%): L2 Depth & Tick Imbalance (>= 3.0x)
 * 4. CVD (15%): Delta absorption & divergence
 * 5. LIQ_MAGNET (10%): Proximity to liquidation pools (within 1.0x ATR)
 * 6. NLP_NEWS (10%): Crypto VADER sentiment (-1.0 to +1.0)
 * 7. PINE_SMC (10%): TradingView Webhook SMC Signal (15m TTL)
 */
export class ConfluenceEngine {
  public readonly orderFlowEngine: OrderFlowEngine;
  public readonly sentimentHarvester: SentimentHarvester;
  public readonly liquidationEngine: LiquidationEngine;

  private latestPineAlert: StoredPineAlert | null = null;
  private readonly alertNonceCache: Map<string, number> = new Map(); // alert_id -> timestamp (60s LRU)
  private latestSnapshot: ConfluenceSnapshot | null = null;
  private consensusThreshold: number = 4;

  constructor(sentimentHarvester?: SentimentHarvester) {
    this.orderFlowEngine = new OrderFlowEngine();
    this.sentimentHarvester = sentimentHarvester || new SentimentHarvester();
    this.liquidationEngine = new LiquidationEngine();
  }

  public setConsensusThreshold(threshold: number): void {
    this.consensusThreshold = Math.max(1, Math.min(7, threshold));
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
   * Evaluates all 7 confluence pillars for the given market state.
   */
  public evaluate(data: ConfluenceMarketData): ConfluenceSnapshot {
    const { symbol, currentPrice, indicators, cvd, recentHigh, recentLow } = data;
    const now = Date.now();

    // 1. Pillar: MTF_TREND (20%)
    const p1Trend = this.evaluateMtfTrend(currentPrice, indicators, now);

    // 2. Pillar: MOMENTUM (15%)
    const p2Momentum = this.evaluateMomentum(indicators, now);

    // 3. Pillar: ORDER_FLOW (20%)
    const p3OrderFlow = this.orderFlowEngine.evaluate(currentPrice);

    // 4. Pillar: CVD (15%)
    const p4Cvd = this.evaluateCvd(cvd, now);

    // 5. Pillar: LIQ_MAGNET (10%)
    const p5Liq = this.liquidationEngine.evaluate({
      currentPrice,
      atr14: indicators?.atr14 ?? null,
      recentHigh,
      recentLow,
      openInterestUsd: cvd?.openInterestUsd ?? null,
    });

    // 6. Pillar: NLP_NEWS (10%)
    const p6Nlp = this.sentimentHarvester.evaluate();

    // 7. Pillar: PINE_SMC (10%)
    const p7Pine = this.evaluatePineSmc(symbol, now);

    const pillars: PillarEvaluation[] = [
      p1Trend,
      p2Momentum,
      p3OrderFlow,
      p4Cvd,
      p5Liq,
      p6Nlp,
      p7Pine,
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

    const { compositeScore, bias: mathBias, recommendedAction: rawAction } =
      calculateCompositeConfluenceScore(pillars);

    const maxConfirming = Math.max(bullishCount, bearishCount);
    const consensusMet = maxConfirming >= this.consensusThreshold;
    const consensusBias = consensusMet
      ? (bullishCount >= this.consensusThreshold ? 'BULLISH' : 'BEARISH')
      : 'NEUTRAL';

    let recommendedAction = rawAction;
    if (consensusMet && recommendedAction === 'GÖZLƏ') {
      recommendedAction = consensusBias === 'BULLISH' ? 'BUY' : 'SELL';
    }

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
    this.latestPineAlert = null;
    this.alertNonceCache.clear();
    this.latestSnapshot = null;
  }

  // --- Private Pillar Evaluators ---

  private evaluateMtfTrend(
    price: number,
    ind: TechnicalSummary | null,
    now: number
  ): PillarEvaluation {
    if (!ind || price <= 0 || !ind.ema200 || !ind.ema9 || !ind.ema21) {
      return {
        id: 'MTF_TREND',
        title: 'MTF Trend Stack',
        score: 50,
        bias: 'NEUTRAL',
        valueText: 'Neutral Stack',
        subText: 'Awaiting 200-period candle history',
        confirmed: false,
        updatedAt: now,
      };
    }

    const adx = ind.adx14?.adx ?? 0;
    const isBullish = price > ind.ema200 && ind.ema9 > ind.ema21 && adx > 22;
    const isBearish = price < ind.ema200 && ind.ema9 < ind.ema21 && adx > 22;

    if (isBullish) {
      const score = Math.min(100, Math.round(75 + Math.min(25, (adx - 22) * 2)));
      return {
        id: 'MTF_TREND',
        title: 'MTF Trend Stack',
        score,
        bias: 'BULLISH',
        valueText: `Bullish Stack (ADX ${adx.toFixed(1)})`,
        subText: `Price > EMA200 ($${ind.ema200.toFixed(2)}) & EMA9 > 21`,
        confirmed: true,
        updatedAt: now,
      };
    }

    if (isBearish) {
      const score = Math.min(100, Math.round(75 + Math.min(25, (adx - 22) * 2)));
      return {
        id: 'MTF_TREND',
        title: 'MTF Trend Stack',
        score,
        bias: 'BEARISH',
        valueText: `Bearish Stack (ADX ${adx.toFixed(1)})`,
        subText: `Price < EMA200 ($${ind.ema200.toFixed(2)}) & EMA9 < 21`,
        confirmed: true,
        updatedAt: now,
      };
    }

    return {
      id: 'MTF_TREND',
      title: 'MTF Trend Stack',
      score: 50,
      bias: 'NEUTRAL',
      valueText: `Neutral (${adx > 22 ? 'Trend Clashing' : 'Range Bound'})`,
      subText: `ADX: ${adx.toFixed(1)} | EMA9: $${ind.ema9.toFixed(2)}`,
      confirmed: false,
      updatedAt: now,
    };
  }

  private evaluateMomentum(ind: TechnicalSummary | null, now: number): PillarEvaluation {
    if (!ind || ind.rsi14 === null || ind.macd === null) {
      return {
        id: 'MOMENTUM',
        title: 'Momentum & Volatility',
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

    const isBullish = rsi >= 45 && rsi <= 65 && hist > 0;
    const isBearish = rsi >= 35 && rsi <= 55 && hist < 0;

    if (isBullish) {
      const score = Math.min(100, Math.round(75 + Math.min(25, Math.abs(hist) * 10)));
      return {
        id: 'MOMENTUM',
        title: 'Momentum & Volatility',
        score,
        bias: 'BULLISH',
        valueText: `Bullish Impulse (RSI ${rsi.toFixed(1)})`,
        subText: `RSI in sweet zone (45-65) & MACD Hist +${hist.toFixed(2)}`,
        confirmed: true,
        updatedAt: now,
      };
    }

    if (isBearish) {
      const score = Math.min(100, Math.round(75 + Math.min(25, Math.abs(hist) * 10)));
      return {
        id: 'MOMENTUM',
        title: 'Momentum & Volatility',
        score,
        bias: 'BEARISH',
        valueText: `Bearish Impulse (RSI ${rsi.toFixed(1)})`,
        subText: `RSI in sweet zone (35-55) & MACD Hist ${hist.toFixed(2)}`,
        confirmed: true,
        updatedAt: now,
      };
    }

    return {
      id: 'MOMENTUM',
      title: 'Momentum & Volatility',
      score: 50,
      bias: 'NEUTRAL',
      valueText: `RSI ${rsi.toFixed(1)} / Hist ${hist >= 0 ? '+' : ''}${hist.toFixed(2)}`,
      subText: rsi > 65 ? 'Overbought warning' : rsi < 35 ? 'Oversold warning' : 'Flat momentum',
      confirmed: false,
      updatedAt: now,
    };
  }

  private evaluateCvd(cvd: CvdSnapshot | null, now: number): PillarEvaluation {
    if (!cvd) {
      return {
        id: 'CVD',
        title: 'CVD Volume Delta',
        score: 50,
        bias: 'NEUTRAL',
        valueText: 'No CVD Stream',
        subText: 'Awaiting aggTrade events',
        confirmed: false,
        updatedAt: now,
      };
    }

    const { delta, cvd: cumDelta } = cvd;

    // Positive delta accumulation -> Bullish absorption / buying
    if (delta > 0 && cumDelta > 0) {
      return {
        id: 'CVD',
        title: 'CVD Volume Delta',
        score: 75,
        bias: 'BULLISH',
        valueText: `Bullish Delta (+${delta.toFixed(1)})`,
        subText: `Cumulative CVD: +${cumDelta.toFixed(1)} (Aggressive Buyers)`,
        confirmed: true,
        updatedAt: cvd.timestamp || now,
      };
    }

    // Negative delta accumulation -> Bearish fakeout / selling
    if (delta < 0 && cumDelta < 0) {
      return {
        id: 'CVD',
        title: 'CVD Volume Delta',
        score: 75,
        bias: 'BEARISH',
        valueText: `Bearish Delta (${delta.toFixed(1)})`,
        subText: `Cumulative CVD: ${cumDelta.toFixed(1)} (Aggressive Sellers)`,
        confirmed: true,
        updatedAt: cvd.timestamp || now,
      };
    }

    return {
      id: 'CVD',
      title: 'CVD Volume Delta',
      score: 50,
      bias: 'NEUTRAL',
      valueText: `Convergent (Delta ${delta >= 0 ? '+' : ''}${delta.toFixed(1)})`,
      subText: `Total CVD: ${cumDelta.toFixed(1)}`,
      confirmed: false,
      updatedAt: cvd.timestamp || now,
    };
  }

  private evaluatePineSmc(symbol: string, now: number): PillarEvaluation {
    if (!this.latestPineAlert) {
      return {
        id: 'PINE_SMC',
        title: 'TradingView Pine SMC',
        score: 50,
        bias: 'NEUTRAL',
        valueText: 'No Active Signal',
        subText: 'Awaiting TradingView webhook alert',
        confirmed: false,
        updatedAt: now,
      };
    }

    const { payload, receivedAt } = this.latestPineAlert;
    const ageMs = now - receivedAt;
    const ttlMs = 15 * 60 * 1000; // 15-minute TTL

    // Signal expired after 15m
    if (ageMs > ttlMs) {
      this.latestPineAlert = null;
      return {
        id: 'PINE_SMC',
        title: 'TradingView Pine SMC',
        score: 50,
        bias: 'NEUTRAL',
        valueText: 'Signal Expired',
        subText: 'Prior signal decayed after 15 minutes',
        confirmed: false,
        updatedAt: now,
      };
    }

    // Check symbol match if applicable
    if (payload.symbol && payload.symbol.toUpperCase() !== symbol.toUpperCase()) {
      return {
        id: 'PINE_SMC',
        title: 'TradingView Pine SMC',
        score: 50,
        bias: 'NEUTRAL',
        valueText: 'Other Symbol Alert',
        subText: `Alert was for ${payload.symbol.toUpperCase()}`,
        confirmed: false,
        updatedAt: receivedAt,
      };
    }

    const isBuy = payload.side === 'BUY';
    const ageMinutes = Math.max(0, Math.floor(ageMs / 60000));

    return {
      id: 'PINE_SMC',
      title: 'TradingView Pine SMC',
      score: 85,
      bias: isBuy ? 'BULLISH' : 'BEARISH',
      valueText: `SMC ${payload.side} @ $${payload.entryPrice.toFixed(2)}`,
      subText: `TP: $${payload.tp1} | SL: $${payload.stopLoss} (${ageMinutes}m ago)`,
      confirmed: true,
      updatedAt: receivedAt,
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
