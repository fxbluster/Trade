/**
 * MACRO_REGIME Alpha Factor (18% default weight)
 *
 * Evaluates:
 * - 1h Yang-Zhang multi-timeframe volatility estimator (unbiased open-jump & Rogers-Satchell estimator)
 * - EMA200 and EMA50 macro trend filter
 * - ADX trend strength / plateau filter
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
import { calculateEMA } from '../indicators.js';

const FACTOR_ID = 'MACRO_REGIME';
const FACTOR_NAME = 'Macro Regime';
const DEFAULT_WEIGHT = 0.18;
const MIN_CANDLES_FOR_YZ = 10;
const EMA_LONG_PERIOD = 200;
const EMA_SHORT_PERIOD = 50;

export class MacroRegimeFactor implements IAlphaFactor {
  readonly id = FACTOR_ID;
  readonly name = FACTOR_NAME;
  readonly defaultWeight = DEFAULT_WEIGHT;

  private candles: KlineCandle[] = [];

  async initialize(_db: DatabaseSync): Promise<void> {}

  warmup(candles: KlineCandle[]): void {
    if (candles && candles.length > 0) {
      this.candles = candles.slice();
    }
  }

  computeFactor(context: FactorEvaluationContext): FactorOutput {
    const candles = context.candles.length > 0 ? context.candles : this.candles;
    const currentPrice = context.currentPrice;

    if (candles.length < 5) {
      return neutral(context.timestamp);
    }

    const closePrices = candles.map((c) => c.close);
    // Include current price if latest candle close differs
    if (closePrices.length > 0 && closePrices[closePrices.length - 1] !== currentPrice) {
      closePrices.push(currentPrice);
    }

    // 1. Trend Filter: EMA200 & EMA50
    const ema200 =
      context.indicators?.ema200 ??
      calculateEMA(closePrices, EMA_LONG_PERIOD) ??
      calculateEMA(closePrices, Math.min(closePrices.length, 50));
    const ema50 =
      context.indicators?.ema50 ??
      calculateEMA(closePrices, EMA_SHORT_PERIOD) ??
      calculateEMA(closePrices, Math.min(closePrices.length, 20));

    let trendScore = 0;
    if (ema200 && ema50) {
      const priceVsEma200 = (currentPrice - ema200) / ema200;
      const ema50VsEma200 = (ema50 - ema200) / ema200;

      if (priceVsEma200 > 0.002 && ema50VsEma200 > 0) {
        // Bullish macro alignment
        trendScore = Math.min(1.0, 0.4 + priceVsEma200 * 20);
      } else if (priceVsEma200 < -0.002 && ema50VsEma200 < 0) {
        // Bearish macro alignment
        trendScore = Math.max(-1.0, -0.4 + priceVsEma200 * 20);
      } else {
        // Ranging / conflicting EMAs
        trendScore = Math.max(-0.3, Math.min(0.3, priceVsEma200 * 10));
      }
    } else {
      // Fallback: simple price vs average close
      const avg = closePrices.reduce((s, p) => s + p, 0) / closePrices.length;
      trendScore = Math.max(-0.5, Math.min(0.5, (currentPrice - avg) / avg * 10));
    }

    // 2. Yang-Zhang Volatility Estimator
    const yzVol = computeYangZhangVolatility(candles.slice(-MIN_CANDLES_FOR_YZ * 3));

    // 3. ADX Modulation (if indicators provided)
    let adxMultiplier = 1.0;
    const adx = context.indicators?.adx14?.adx;
    if (adx !== undefined && adx !== null) {
      if (adx >= 25) {
        adxMultiplier = 1.2; // Strong trending market expands signal
      } else if (adx < 18) {
        adxMultiplier = 0.7; // Chop / weak trend contracts signal
      }
    }

    // Modulate trendScore with ADX and Volatility
    let rawAlpha = trendScore * adxMultiplier;
    rawAlpha = Math.max(-1.0, Math.min(1.0, rawAlpha));

    const confidence = Math.min(1.0, Math.abs(rawAlpha) * 0.8 + (yzVol > 0 ? 0.2 : 0));
    const bias = rawAlpha > 0.1 ? 'BULLISH' : rawAlpha < -0.1 ? 'BEARISH' : 'NEUTRAL';

    return {
      factorId: FACTOR_ID,
      bias,
      rawAlpha,
      confidence,
      uncertainty: 1 - confidence,
      halfLifeMs: 60 * 60_000, // 1 hour for macro regime
      metadata: {
        ema200,
        ema50,
        trendScore,
        yangZhangVolatility: yzVol,
        adx: adx ?? null,
      },
    };
  }

  onCandleClosed(candle: KlineCandle, _interval: string): void {
    this.candles.push(candle);
    if (this.candles.length > 500) {
      this.candles.shift();
    }
  }

  async teardown(): Promise<void> {
    this.candles = [];
  }
}

/**
 * Computes Yang-Zhang (2000) historical volatility estimator.
 * Unbiased for both opening jump drift and continuous Rogers-Satchell intraday diffusion.
 */
export function computeYangZhangVolatility(candles: KlineCandle[]): number {
  const n = candles.length;
  if (n < 4) return 0;

  // k constant for Yang-Zhang
  const k = 0.34 / (1.34 + (n + 1) / (n - 1));

  let sumOpenSq = 0;
  let sumOpen = 0;
  let sumCloseSq = 0;
  let sumClose = 0;
  let sumRs = 0;

  for (let i = 1; i < n; i++) {
    const curr = candles[i]!;
    const prev = candles[i - 1]!;

    if (curr.open <= 0 || prev.close <= 0 || curr.high <= 0 || curr.low <= 0 || curr.close <= 0) {
      continue;
    }

    // Overnight jump
    const u = Math.log(curr.open / prev.close);
    sumOpen += u;
    sumOpenSq += u * u;

    // Open-to-close drift
    const c = Math.log(curr.close / curr.open);
    sumClose += c;
    sumCloseSq += c * c;

    // Rogers-Satchell continuous variance component
    const h = Math.log(curr.high / curr.open);
    const l = Math.log(curr.low / curr.open);
    const cBar = Math.log(curr.close / curr.open);
    const rs = h * (h - cBar) + l * (l - cBar);
    sumRs += rs;
  }

  const denom = n - 1;
  const meanOpen = sumOpen / denom;
  const varOpen = (sumOpenSq - denom * meanOpen * meanOpen) / (denom - 1 || 1);

  const meanClose = sumClose / denom;
  const varClose = (sumCloseSq - denom * meanClose * meanClose) / (denom - 1 || 1);

  const varRs = sumRs / denom;

  const yzVariance = Math.max(0, varOpen + k * varClose + (1 - k) * varRs);
  return Math.sqrt(yzVariance);
}

function neutral(_timestamp: number): FactorOutput {
  return {
    factorId: FACTOR_ID,
    bias: 'NEUTRAL',
    rawAlpha: 0,
    confidence: 0,
    uncertainty: 1,
    halfLifeMs: 60 * 60_000,
    metadata: { reason: 'INSUFFICIENT_CANDLES' },
  };
}
