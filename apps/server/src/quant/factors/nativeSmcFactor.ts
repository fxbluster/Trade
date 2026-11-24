/**
 * NATIVE_SMC Alpha Factor (20% default weight)
 *
 * Evaluates algorithmic Smart Money Concepts:
 * - Fair Value Gaps (FVGs): 3-candle imbalance zones
 * - Order Blocks (OBs): Institutional accumulation/distribution blocks
 * - Liquidity Sweeps: Stop-hunt patterns with reclaim
 *
 * rawAlpha in [-1.0, +1.0]
 */

import type { DatabaseSync } from 'node:sqlite';
import type {
  FactorOutput,
  FactorEvaluationContext,
  KlineCandle,
  FairValueGap,
  OrderBlock,
  LiquiditySweep,
} from '@tradeos/shared';
import type { IAlphaFactor } from '../alphaRegistry.js';

const FACTOR_ID = 'NATIVE_SMC';
const FACTOR_NAME = 'Native SMC';
const DEFAULT_WEIGHT = 0.20;
const FVG_MIN_SIZE_RATIO = 0.0005; // Min FVG size as ratio of price
const OB_ATR_MULTIPLIER = 1.8;     // Order block expansion candle threshold
const SWEEP_LOOKBACK = 20;          // Swing high/low lookback

export class NativeSmcFactor implements IAlphaFactor {
  readonly id = FACTOR_ID;
  readonly name = FACTOR_NAME;
  readonly defaultWeight = DEFAULT_WEIGHT;

  private candles: KlineCandle[] = [];

  async initialize(_db: DatabaseSync): Promise<void> {}

  warmup(candles: KlineCandle[]): void {
    this.candles = candles.slice();
  }

  computeFactor(context: FactorEvaluationContext): FactorOutput {
    const candles = context.candles.length > 0 ? context.candles : this.candles;
    if (candles.length < 5) {
      return neutral(context.timestamp);
    }

    const price = context.currentPrice;
    const fvgs = detectFVGs(candles, price);
    const obs = detectOrderBlocks(candles, price);
    const sweep = detectLatestSweep(candles);

    // Score FVGs: bullish FVG below price = support = bullish signal
    let fvgScore = 0;
    let fvgCount = 0;
    for (const fvg of fvgs) {
      if (fvg.mitigated) continue;
      fvgCount++;
      if (fvg.type === 'BULLISH' && price > fvg.low && price < fvg.high * 1.05) {
        fvgScore += 0.5; // Price is testing bullish FVG
      } else if (fvg.type === 'BULLISH' && price > fvg.high) {
        fvgScore += 0.3; // Bullish FVG below price = support
      } else if (fvg.type === 'BEARISH' && price < fvg.high && price > fvg.low * 0.95) {
        fvgScore -= 0.5; // Price is testing bearish FVG
      } else if (fvg.type === 'BEARISH' && price < fvg.low) {
        fvgScore -= 0.3; // Bearish FVG above price = resistance
      }
    }
    if (fvgCount > 0) fvgScore = Math.max(-1, Math.min(1, fvgScore));

    // Score Order Blocks
    let obScore = 0;
    let obCount = 0;
    for (const ob of obs) {
      obCount++;
      if (ob.type === 'BULLISH' && price >= ob.low && price <= ob.high * 1.02) {
        obScore += 0.6; // Price in bullish OB = strong buy signal
      } else if (ob.type === 'BULLISH' && price > ob.high) {
        obScore += 0.2; // Above bullish OB = support
      } else if (ob.type === 'BEARISH' && price <= ob.high && price >= ob.low * 0.98) {
        obScore -= 0.6; // Price in bearish OB = strong sell signal
      } else if (ob.type === 'BEARISH' && price < ob.low) {
        obScore -= 0.2; // Below bearish OB = resistance
      }
    }
    if (obCount > 0) obScore = Math.max(-1, Math.min(1, obScore));

    // Score latest sweep
    let sweepScore = 0;
    if (sweep) {
      const timeSinceSweep = context.timestamp - sweep.time;
      const recency = Math.max(0, 1 - timeSinceSweep / (15 * 60_000)); // decay over 15m
      if (sweep.direction === 'SWEEP_LOW' && price > sweep.reclaimPrice) {
        sweepScore = 0.7 * recency; // Bullish sweep reclaim
      } else if (sweep.direction === 'SWEEP_HIGH' && price < sweep.reclaimPrice) {
        sweepScore = -0.7 * recency; // Bearish sweep reclaim
      }
    }

    // Composite: weighted sum of signals
    const fvgW = fvgCount > 0 ? 0.35 : 0;
    const obW = obCount > 0 ? 0.45 : 0;
    const sweepW = sweep ? 0.20 : 0;
    const totalW = fvgW + obW + sweepW;

    let rawAlpha = 0;
    if (totalW > 0) {
      rawAlpha = (fvgScore * fvgW + obScore * obW + sweepScore * sweepW) / totalW;
    } else {
      // No structures found
      return neutral(context.timestamp);
    }

    rawAlpha = Math.max(-1.0, Math.min(1.0, rawAlpha));
    const bias = rawAlpha > 0.1 ? 'BULLISH' : rawAlpha < -0.1 ? 'BEARISH' : 'NEUTRAL';
    const confidence = Math.abs(rawAlpha) * 0.8 + (fvgCount + obCount > 0 ? 0.2 : 0);

    return {
      factorId: FACTOR_ID,
      bias,
      rawAlpha,
      confidence: Math.min(1, confidence),
      uncertainty: 1 - Math.min(1, confidence),
      halfLifeMs: 15 * 60_000, // 15 minutes for structure-based
      metadata: {
        activeFvgs: fvgs.filter((f) => !f.mitigated).length,
        activeOBs: obs.length,
        hasSweep: !!sweep,
        fvgScore,
        obScore,
        sweepScore,
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

// ---------------------------------------------------------------------------
// Algorithmic detectors
// ---------------------------------------------------------------------------

function detectFVGs(candles: KlineCandle[], currentPrice: number): FairValueGap[] {
  const fvgs: FairValueGap[] = [];
  const n = candles.length;
  if (n < 3) return fvgs;

  for (let i = 2; i < n; i++) {
    const c0 = candles[i - 2]!;
    const c1 = candles[i - 1]!;
    const c2 = candles[i]!;

    // Bullish FVG: low of c2 > high of c0
    if (c2.low > c0.high) {
      const fvgSize = c2.low - c0.high;
      const minSize = currentPrice * FVG_MIN_SIZE_RATIO;
      if (fvgSize >= minSize) {
        // Check mitigation
        let mitigated = false;
        for (let k = i + 1; k < n; k++) {
          if (candles[k]!.low <= c0.high) {
            mitigated = true;
            break;
          }
        }
        fvgs.push({
          id: `fvg_bull_${c1.time}`,
          timeframe: '1m',
          type: 'BULLISH',
          high: c2.low,
          low: c0.high,
          mitigated,
          formedAt: c1.time,
        });
      }
    }

    // Bearish FVG: high of c2 < low of c0
    if (c2.high < c0.low) {
      const fvgSize = c0.low - c2.high;
      const minSize = currentPrice * FVG_MIN_SIZE_RATIO;
      if (fvgSize >= minSize) {
        let mitigated = false;
        for (let k = i + 1; k < n; k++) {
          if (candles[k]!.high >= c0.low) {
            mitigated = true;
            break;
          }
        }
        fvgs.push({
          id: `fvg_bear_${c1.time}`,
          timeframe: '1m',
          type: 'BEARISH',
          high: c0.low,
          low: c2.high,
          mitigated,
          formedAt: c1.time,
        });
      }
    }
  }

  return fvgs.slice(-10); // Return most recent 10
}

function computeATR(candles: KlineCandle[], period: number): number {
  if (candles.length < 2) return 0;
  let atrSum = 0;
  const n = Math.min(period, candles.length - 1);
  for (let i = candles.length - n; i < candles.length; i++) {
    const c = candles[i]!;
    const p = candles[i - 1]!;
    const tr = Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close));
    atrSum += tr;
  }
  return atrSum / n;
}

function detectOrderBlocks(candles: KlineCandle[], _currentPrice: number): OrderBlock[] {
  const obs: OrderBlock[] = [];
  if (candles.length < 15) return obs;

  const atr = computeATR(candles, 14);
  if (atr <= 0) return obs;

  for (let i = 2; i < candles.length - 2; i++) {
    const c = candles[i]!;
    const nextC = candles[i + 1]!;
    const candleRange = c.high - c.low;

    // Bullish OB: bearish candle followed by expansion up candle >= 1.8x ATR
    if (c.close < c.open && nextC.close > nextC.open) {
      const expansion = nextC.high - nextC.low;
      if (expansion >= OB_ATR_MULTIPLIER * atr) {
        obs.push({
          id: `ob_bull_${c.time}`,
          timeframe: '1m',
          type: 'BULLISH',
          high: c.open,
          low: c.low,
          invalidationPrice: c.low * 0.999,
          volume: c.volume,
        });
      }
    }

    // Bearish OB: bullish candle followed by expansion down candle >= 1.8x ATR
    if (c.close > c.open && nextC.close < nextC.open) {
      const expansion = nextC.high - nextC.low;
      if (expansion >= OB_ATR_MULTIPLIER * atr) {
        obs.push({
          id: `ob_bear_${c.time}`,
          timeframe: '1m',
          type: 'BEARISH',
          high: c.high,
          low: c.open,
          invalidationPrice: c.high * 1.001,
          volume: c.volume,
        });
      }
    }
  }

  return obs.slice(-5);
}

function detectLatestSweep(candles: KlineCandle[]): LiquiditySweep | null {
  if (candles.length < SWEEP_LOOKBACK + 2) return null;

  const n = candles.length;
  const lookback = Math.min(SWEEP_LOOKBACK, n - 2);

  // Find recent swing high and low
  let swingHigh = -Infinity;
  let swingLow = Infinity;
  for (let i = n - lookback - 1; i < n - 1; i++) {
    swingHigh = Math.max(swingHigh, candles[i]!.high);
    swingLow = Math.min(swingLow, candles[i]!.low);
  }

  const lastCandle = candles[n - 1]!;
  const prevCandle = candles[n - 2]!;

  // Sweep high: last candle swept above swingHigh then reclaimed
  if (lastCandle.high > swingHigh && lastCandle.close < swingHigh) {
    return {
      id: `sweep_high_${lastCandle.time}`,
      direction: 'SWEEP_HIGH',
      sweepPrice: lastCandle.high,
      reclaimPrice: swingHigh,
      time: lastCandle.time,
    };
  }

  // Sweep low: last candle swept below swingLow then reclaimed
  if (lastCandle.low < swingLow && lastCandle.close > swingLow) {
    return {
      id: `sweep_low_${lastCandle.time}`,
      direction: 'SWEEP_LOW',
      sweepPrice: lastCandle.low,
      reclaimPrice: swingLow,
      time: lastCandle.time,
    };
  }

  return null;
}

function neutral(_timestamp: number): FactorOutput {
  return {
    factorId: FACTOR_ID,
    bias: 'NEUTRAL',
    rawAlpha: 0,
    confidence: 0,
    uncertainty: 1,
    halfLifeMs: 15 * 60_000,
    metadata: { reason: 'INSUFFICIENT_DATA' },
  };
}
