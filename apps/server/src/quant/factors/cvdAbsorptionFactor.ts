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

    // Absorption Divergence Logic:
    // 1. Extreme aggressive selling (zDelta <= -Z_SCORE_THRESHOLD) but price does not drop:
    //    Bullish absorption (passive limit buyers absorbed all aggressive market sells).
    // 2. Extreme aggressive buying (zDelta >= +Z_SCORE_THRESHOLD) but price does not rise:
    //    Bearish absorption (passive limit sellers absorbed all aggressive market buys).
    let rawAlpha = 0;
    let confidence = 0;

    if (zDelta <= -Z_SCORE_THRESHOLD) {
      // Aggressive sell wave
      if (priceChange >= -0.0002) {
        // Absorbed! Strong Bullish
        const absorptionStrength = Math.min(1.0, (Math.abs(zDelta) - Z_SCORE_THRESHOLD) / 2 + 0.5);
        rawAlpha = absorptionStrength;
        confidence = Math.min(1.0, Math.abs(zDelta) / 4);
      } else {
        // Market sells pushed price down normally (continuation, not absorption)
        rawAlpha = Math.max(-0.6, -Math.abs(zDelta) / 4);
        confidence = 0.4;
      }
    } else if (zDelta >= Z_SCORE_THRESHOLD) {
      // Aggressive buy wave
      if (priceChange <= 0.0002) {
        // Absorbed! Strong Bearish
        const absorptionStrength = Math.min(1.0, (zDelta - Z_SCORE_THRESHOLD) / 2 + 0.5);
        rawAlpha = -absorptionStrength;
        confidence = Math.min(1.0, zDelta / 4);
      } else {
        // Market buys pushed price up normally (continuation, not absorption)
        rawAlpha = Math.min(0.6, zDelta / 4);
        confidence = 0.4;
      }
    } else {
      // Sub-threshold z-delta: mild directional drift
      rawAlpha = Math.max(-0.3, Math.min(0.3, zDelta / (Z_SCORE_THRESHOLD * 2)));
      confidence = Math.abs(rawAlpha);
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
