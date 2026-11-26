/**
 * CVD_ABSORPTION Alpha Factor (15% default weight)
 *
 * Evaluates:
 * - Rolling 15-minute volume delta Z-score absorption divergence:
 *     Bullish: Passive buyers absorb aggressive market sells
 *              (Z_delta <= -2.0 while price delta >= 0 or stabilizes)
 *     Bearish: Passive sellers absorb aggressive market buys
 *              (Z_delta >= +2.0 while price delta <= 0 or stabilizes)
 * - Trailing CVD momentum vs price action
 *
 * rawAlpha in [-1.0, +1.0]
 */

import type { DatabaseSync } from 'node:sqlite';
import type {
  FactorOutput,
  FactorEvaluationContext,
  KlineCandle,
} from '@tradeos/shared';
import type { IAlphaFactor } from '../alphaRegistry.js';

const FACTOR_ID = 'CVD_ABSORPTION';
const FACTOR_NAME = 'CVD Absorption';
const DEFAULT_WEIGHT = 0.15;
const Z_SCORE_THRESHOLD = 2.0;
const HISTORY_WINDOW = 60; // 60 samples for rolling Z-score calculation

export class CvdAbsorptionFactor implements IAlphaFactor {
  readonly id = FACTOR_ID;
  readonly name = FACTOR_NAME;
  readonly defaultWeight = DEFAULT_WEIGHT;

  private deltaHistory: number[] = [];
  private lastPrice: number = 0;

  async initialize(_db: DatabaseSync): Promise<void> {}

  warmup(candles: KlineCandle[]): void {
    if (candles && candles.length > 0) {
      this.lastPrice = candles[candles.length - 1]!.close;
      // Synthesize approximate delta from candle body and volume
      for (const c of candles.slice(-HISTORY_WINDOW)) {
        const body = c.close - c.open;
        const range = c.high - c.low || 1;
        const estDelta = c.volume * (body / range);
        this.deltaHistory.push(estDelta);
      }
    }
  }

  computeFactor(context: FactorEvaluationContext): FactorOutput {
    const cvd = context.cvd;
    const currentPrice = context.currentPrice;

    if (!cvd) {
      return neutral(context.timestamp);
    }

    // Record delta
    const currentDelta = cvd.delta;
    this.deltaHistory.push(currentDelta);
    if (this.deltaHistory.length > HISTORY_WINDOW) {
      this.deltaHistory.shift();
    }

    if (this.deltaHistory.length < 5) {
      // Need at least 5 observations for meaningful statistics
      this.lastPrice = currentPrice;
      return neutral(context.timestamp);
    }

    // Calculate rolling mean and std of volume delta
    const n = this.deltaHistory.length;
    const mean = this.deltaHistory.reduce((s, d) => s + d, 0) / n;
    const variance =
      this.deltaHistory.reduce((s, d) => s + (d - mean) ** 2, 0) / (n - 1);
    const std = Math.sqrt(variance);

    // Z-score of current delta
    const zDelta = std > 1e-6 ? (currentDelta - mean) / std : 0;

    // Price change since last tick
    const priceChange = this.lastPrice > 0 ? (currentPrice - this.lastPrice) / this.lastPrice : 0;
    this.lastPrice = currentPrice;

    // Multi-candle recent price move to detect sustained selloffs/rallies vs stalling
    const candles = context.candles || [];
    let recentMovePct = priceChange;
    if (candles.length > 0) {
      const lookbackIdx = Math.max(0, candles.length - 5);
      const refOpen = candles[lookbackIdx]!.open;
      if (refOpen > 0) {
        recentMovePct = (currentPrice - refOpen) / refOpen;
      }
    }

    // Regime & flow context
    const adx14 = context.indicators?.adx14 ?? null;
    const isStrongTrend = adx14 !== null && adx14.adx >= 25;

    const totalFlow = cvd.buyVolume + cvd.sellVolume;
    const minFlow = Math.min(cvd.buyVolume, cvd.sellVolume);
    const maxFlow = Math.max(cvd.buyVolume, cvd.sellVolume);
    const flowRatio = totalFlow > 0 ? (minFlow > 0 ? maxFlow / minFlow : maxFlow) : 1.0;
    const flowSignedImbalance = totalFlow > 0 ? (cvd.buyVolume - cvd.sellVolume) / totalFlow : 0;
    const isHighFlow = totalFlow > 0 && flowRatio >= 3.0;

    // Directional momentum confirmation in strong trend or high-flow directional regimes
    // (prevents contrarian signals during violent selloffs/rallies)
    const isViolentSelloff = recentMovePct <= -0.004 || priceChange <= -0.002;
    const isViolentRally = recentMovePct >= 0.004 || priceChange >= 0.002;

    let rawAlpha = 0;
    let confidence = 0;

    if (
      (isStrongTrend && adx14!.mdi > adx14!.pdi && (currentDelta < 0 || isViolentSelloff)) ||
      (isHighFlow && flowSignedImbalance < 0 && (isViolentSelloff || isStrongTrend))
    ) {
      // Strong bearish trend / high sell-flow regime: confirm bearish momentum
      const zContrib = zDelta < 0 ? Math.min(0.4, Math.abs(zDelta) / 6) : 0;
      const flowContrib = Math.min(0.6, Math.abs(flowSignedImbalance) * 0.6);
      rawAlpha = -Math.max(0.35, Math.min(1.0, zContrib + flowContrib));
      confidence = Math.min(1.0, Math.max(0.55, Math.abs(flowSignedImbalance)));
    } else if (
      (isStrongTrend && adx14!.pdi > adx14!.mdi && (currentDelta > 0 || isViolentRally)) ||
      (isHighFlow && flowSignedImbalance > 0 && (isViolentRally || isStrongTrend))
    ) {
      // Strong bullish trend / high buy-flow regime: confirm bullish momentum
      const zContrib = zDelta > 0 ? Math.min(0.4, zDelta / 6) : 0;
      const flowContrib = Math.min(0.6, Math.abs(flowSignedImbalance) * 0.6);
      rawAlpha = Math.max(0.35, Math.min(1.0, zContrib + flowContrib));
      confidence = Math.min(1.0, Math.max(0.55, Math.abs(flowSignedImbalance)));
    } else if (zDelta <= -Z_SCORE_THRESHOLD) {
      // Aggressive sell wave: contrarian absorption ONLY in low-ADX / ranging & price-stalling divergence
      const priceStalling = priceChange >= -0.0002 && recentMovePct > -0.004;
      if (!isStrongTrend && priceStalling) {
        const absorptionStrength = Math.min(1.0, (Math.abs(zDelta) - Z_SCORE_THRESHOLD) / 2 + 0.5);
        rawAlpha = absorptionStrength;
        confidence = Math.min(1.0, Math.abs(zDelta) / 4);
      } else {
        // Market sells pushed price down normally (continuation, not absorption)
        rawAlpha = Math.max(-0.85, -Math.abs(zDelta) / 3.5);
        confidence = Math.min(0.85, Math.max(0.45, Math.abs(zDelta) / 4));
      }
    } else if (zDelta >= Z_SCORE_THRESHOLD) {
      // Aggressive buy wave: contrarian absorption ONLY in low-ADX / ranging & price-stalling divergence
      const priceStalling = priceChange <= 0.0002 && recentMovePct < 0.004;
      if (!isStrongTrend && priceStalling) {
        const absorptionStrength = Math.min(1.0, (zDelta - Z_SCORE_THRESHOLD) / 2 + 0.5);
        rawAlpha = -absorptionStrength;
        confidence = Math.min(1.0, zDelta / 4);
      } else {
        // Market buys pushed price up normally (continuation, not absorption)
        rawAlpha = Math.min(0.85, zDelta / 3.5);
        confidence = Math.min(0.85, Math.max(0.45, zDelta / 4));
      }
    } else {
      // Sub-threshold z-delta: avoid contrarian drift against active directional flow/selloff
      if (isViolentSelloff && flowSignedImbalance < 0) {
        rawAlpha = -Math.max(0.25, Math.min(0.6, Math.abs(flowSignedImbalance) * 0.6));
        confidence = Math.abs(rawAlpha);
      } else if (isViolentRally && flowSignedImbalance > 0) {
        rawAlpha = Math.max(0.25, Math.min(0.6, Math.abs(flowSignedImbalance) * 0.6));
        confidence = Math.abs(rawAlpha);
      } else {
        rawAlpha = Math.max(-0.3, Math.min(0.3, zDelta / (Z_SCORE_THRESHOLD * 2)));
        confidence = Math.abs(rawAlpha);
      }
    }

    rawAlpha = Math.max(-1.0, Math.min(1.0, rawAlpha));
    const bias = rawAlpha > 0.1 ? 'BULLISH' : rawAlpha < -0.1 ? 'BEARISH' : 'NEUTRAL';

    return {
      factorId: FACTOR_ID,
      bias,
      rawAlpha,
      confidence,
      uncertainty: Math.max(0, 1 - confidence),
      halfLifeMs: 15 * 60_000, // 15-minute half-life
      metadata: {
        zDelta,
        currentDelta,
        meanDelta: mean,
        stdDelta: std,
        priceChange,
      },
    };
  }

  onCandleClosed(candle: KlineCandle, _interval: string): void {
    this.lastPrice = candle.close;
  }

  async teardown(): Promise<void> {
    this.deltaHistory = [];
  }
}

function neutral(_timestamp: number): FactorOutput {
  return {
    factorId: FACTOR_ID,
    bias: 'NEUTRAL',
    rawAlpha: 0,
    confidence: 0,
    uncertainty: 1,
    halfLifeMs: 15 * 60_000,
    metadata: { reason: 'INSUFFICIENT_CVD_DATA' },
  };
}
