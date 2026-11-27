/**
 * CROSS_EXCHANGE_SWEEP Alpha Factor (9% default weight)
 *
 * Evaluates:
 * - Lead-lag cross-venue liquidity voids (Binance vs Bybit / OKX)
 * - CVD exhaustion sweeps: aggressive taker bursts into thin liquidity that trigger immediate mean-reversion
 * - Liquidity vacuum detection where price overshoots on low volume
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

const FACTOR_ID = 'CROSS_EXCHANGE_SWEEP';
const FACTOR_NAME = 'Cross Exchange Sweep';
const DEFAULT_WEIGHT = 0.09;
const SPREAD_DISLOCATION_THRESHOLD = 0.0015; // 0.15% dislocation between exchanges

interface VenueQuote {
  venue: string;
  price: number;
  timestamp: number;
  cvdDelta?: number;
}

export class CrossExchangeSweepFactor implements IAlphaFactor {
  readonly id = FACTOR_ID;
  readonly name = FACTOR_NAME;
  readonly defaultWeight = DEFAULT_WEIGHT;

  private venueQuotes: Map<string, VenueQuote> = new Map();
  private recentCandles: KlineCandle[] = [];

  async initialize(_db: DatabaseSync): Promise<void> {}

  warmup(candles: KlineCandle[]): void {
    if (candles && candles.length > 0) {
      this.recentCandles = candles.slice(-50);
    }
  }

  /**
   * Update external venue pricing feed (e.g. Bybit, OKX).
   */
  public updateVenueQuote(venue: string, price: number, cvdDelta?: number): void {
    this.venueQuotes.set(venue.toUpperCase(), {
      venue: venue.toUpperCase(),
      price,
      timestamp: Date.now(),
      cvdDelta,
    });
  }

  computeFactor(context: FactorEvaluationContext): FactorOutput {
    const currentPrice = context.currentPrice;
    const now = context.timestamp || Date.now();

    // 1. Cross-venue dislocation check
    let venueDislocationSignal = 0;
    let validVenueCount = 0;

    for (const [venue, quote] of this.venueQuotes.entries()) {
      if (now - quote.timestamp < 30_000) {
        // Fresh quote within 30s
        validVenueCount++;
        const spread = (currentPrice - quote.price) / quote.price;
        if (spread > SPREAD_DISLOCATION_THRESHOLD) {
          // Local exchange overshot higher than other exchange (liquidity vacuum sweep)
          // Mean-reversion pressure -> Bearish
          venueDislocationSignal -= Math.min(1.0, spread / (SPREAD_DISLOCATION_THRESHOLD * 2));
        } else if (spread < -SPREAD_DISLOCATION_THRESHOLD) {
          // Local exchange overshot lower than other exchange
          // Mean-reversion pressure -> Bullish
          venueDislocationSignal += Math.min(1.0, -spread / (SPREAD_DISLOCATION_THRESHOLD * 2));
        }
      }
    }

    if (validVenueCount > 0) {
      venueDislocationSignal /= validVenueCount;
    }

    // 2. CVD Exhaustion Sweep (on primary exchange)
    // When volume is high and candle has long wick opposite to the push
    let exhaustionSignal = 0;
    const candles = context.candles.length > 0 ? context.candles : this.recentCandles;
    if (candles.length >= 3) {
      const lastCandle = candles[candles.length - 1]!;
      const range = lastCandle.high - lastCandle.low;
      if (range > 0) {
        const upperWick = lastCandle.high - Math.max(lastCandle.open, lastCandle.close);
        const lowerWick = Math.min(lastCandle.open, lastCandle.close) - lastCandle.low;

        // Long lower wick after down-move: buy sweep exhaustion
        if (lowerWick / range > 0.55 && context.cvd && context.cvd.delta < 0) {
          exhaustionSignal = Math.min(0.8, (lowerWick / range - 0.5) * 2);
        }
        // Long upper wick after up-move: sell sweep exhaustion
        else if (upperWick / range > 0.55 && context.cvd && context.cvd.delta > 0) {
          exhaustionSignal = -Math.min(0.8, (upperWick / range - 0.5) * 2);
        }
      }
    }

    // Combine: if external venues available, 50% each; else 100% exhaustion
    let rawAlpha = 0;
    if (validVenueCount > 0) {
      rawAlpha = venueDislocationSignal * 0.5 + exhaustionSignal * 0.5;
    } else {
      rawAlpha = exhaustionSignal;
    }
    rawAlpha = Math.max(-1.0, Math.min(1.0, rawAlpha));

    const isDead = validVenueCount === 0 && Math.abs(rawAlpha) <= 1e-6;
    const confidence = isDead
      ? 0
      : Math.min(1.0, Math.abs(rawAlpha) * 0.85 + (validVenueCount > 0 ? 0.15 : 0.05));
    const bias = rawAlpha > 0.1 ? 'BULLISH' : rawAlpha < -0.1 ? 'BEARISH' : 'NEUTRAL';

    return {
      factorId: FACTOR_ID,
      bias,
      rawAlpha,
      confidence,
      uncertainty: 1 - confidence,
      halfLifeMs: 2 * 60_000, // 2 minutes for fast sweeps
      metadata: {
        validVenueCount,
        venueDislocationSignal,
        exhaustionSignal,
        deadFactor: isDead,
      },
    };
  }

  onCandleClosed(candle: KlineCandle, _interval: string): void {
    this.recentCandles.push(candle);
    if (this.recentCandles.length > 50) {
      this.recentCandles.shift();
    }
  }

  async teardown(): Promise<void> {
    this.venueQuotes.clear();
    this.recentCandles = [];
  }
}
