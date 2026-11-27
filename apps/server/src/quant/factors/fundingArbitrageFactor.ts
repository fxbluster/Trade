/**
 * FUNDING_ARBITRAGE Alpha Factor (10% default weight)
 *
 * Evaluates:
 * - Spot-Perp and Perp-Perp funding basis spreads
 * - Perpetual funding rate regime (crowded longs vs crowded shorts)
 * - Mean-reversion pressure from excessive carry costs:
 *     Excessive positive funding (> 0.03% / 8h): Long crowding, basis exhaustion (Bearish drag)
 *     Excessive negative funding (< -0.02% / 8h): Short crowding, squeeze potential (Bullish boost)
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

const FACTOR_ID = 'FUNDING_ARBITRAGE';
const FACTOR_NAME = 'Funding Arbitrage';
const DEFAULT_WEIGHT = 0.10;

// Funding rate thresholds (per 8-hour period)
const NEUTRAL_FUNDING_BAND = 0.0001; // 0.01%
const HIGH_FUNDING_THRESHOLD = 0.0003; // 0.03% (annualized ~33%)
const EXTREME_FUNDING_THRESHOLD = 0.0008; // 0.08% (annualized ~88%)
const NEGATIVE_FUNDING_THRESHOLD = -0.0002; // -0.02%

export class FundingArbitrageFactor implements IAlphaFactor {
  readonly id = FACTOR_ID;
  readonly name = FACTOR_NAME;
  readonly defaultWeight = DEFAULT_WEIGHT;

  private latestFundingRate: number | null = null;
  private spotPrice: number | null = null;
  private perpPrice: number | null = null;

  async initialize(_db: DatabaseSync): Promise<void> {}

  warmup(_candles: KlineCandle[]): void {}

  /**
   * External feed update for live funding rate and spot benchmark price.
   */
  public updateFundingState(fundingRate: number, spotPrice?: number, perpPrice?: number): void {
    this.latestFundingRate = fundingRate;
    if (spotPrice !== undefined) this.spotPrice = spotPrice;
    if (perpPrice !== undefined) this.perpPrice = perpPrice;
  }

  computeFactor(context: FactorEvaluationContext): FactorOutput {
    const currentPrice = context.currentPrice;
    const rawFunding = (context as any).fundingRate ?? this.latestFundingRate;
    const spot = (context as any).spotPrice ?? this.spotPrice;
    const hasFundingFeed = typeof rawFunding === 'number' && Number.isFinite(rawFunding);
    const hasSpotFeed = typeof spot === 'number' && Number.isFinite(spot) && spot > 0;

    if (!hasFundingFeed && !hasSpotFeed) {
      return {
        factorId: FACTOR_ID,
        bias: 'NEUTRAL',
        rawAlpha: 0,
        confidence: 0,
        uncertainty: 1,
        halfLifeMs: 4 * 60 * 60_000,
        metadata: {
          reason: 'NO_FUNDING_DATA',
          deadFactor: true,
        },
      };
    }

    const fundingRate = hasFundingFeed ? rawFunding : 0;

    // 1. Evaluate Funding Rate Crowding
    let fundingSignal = 0;
    if (fundingRate > HIGH_FUNDING_THRESHOLD) {
      // Longs are crowded and paying excessive funding to shorts.
      // Mean-reversion / long-flush pressure -> Bearish alpha
      const excess = fundingRate - HIGH_FUNDING_THRESHOLD;
      fundingSignal = -Math.min(1.0, 0.4 + (excess / (EXTREME_FUNDING_THRESHOLD - HIGH_FUNDING_THRESHOLD)) * 0.6);
    } else if (fundingRate < NEGATIVE_FUNDING_THRESHOLD) {
      // Shorts are crowded and paying funding to longs.
      // Short squeeze potential -> Bullish alpha
      const excess = Math.abs(fundingRate - NEGATIVE_FUNDING_THRESHOLD);
      fundingSignal = Math.min(1.0, 0.4 + (excess / 0.0005) * 0.6);
    } else if (Math.abs(fundingRate) <= NEUTRAL_FUNDING_BAND) {
      fundingSignal = 0; // Balanced funding
    } else {
      // Mild drift
      fundingSignal = -fundingRate / HIGH_FUNDING_THRESHOLD * 0.3;
    }

    // 2. Evaluate Spot-Perp Basis Spread (if spot price available)
    let basisSignal = 0;
    if (hasSpotFeed) {
      const basisSpread = (currentPrice - spot) / spot;
      // If Perp is at a wide premium to spot while funding is positive, basis compression is imminent
      if (basisSpread > 0.002) {
        basisSignal = -Math.min(0.8, basisSpread * 100);
      } else if (basisSpread < -0.002) {
        basisSignal = Math.min(0.8, -basisSpread * 100);
      }
    }

    // Combine funding signal (70%) and basis signal (30%)
    let rawAlpha = fundingSignal;
    if (basisSignal !== 0) {
      rawAlpha = fundingSignal * 0.7 + basisSignal * 0.3;
    }
    rawAlpha = Math.max(-1.0, Math.min(1.0, rawAlpha));

    const isDead = Math.abs(rawAlpha) <= 1e-6;
    const confidence = isDead ? 0 : Math.min(1.0, Math.abs(rawAlpha) * 0.9 + 0.1);
    const bias = rawAlpha > 0.1 ? 'BULLISH' : rawAlpha < -0.1 ? 'BEARISH' : 'NEUTRAL';

    return {
      factorId: FACTOR_ID,
      bias,
      rawAlpha,
      confidence,
      uncertainty: 1 - confidence,
      halfLifeMs: 4 * 60 * 60_000, // 4 hours for funding regimes
      metadata: {
        fundingRate,
        spotPrice: hasSpotFeed ? spot : null,
        basisSpread: hasSpotFeed ? (currentPrice - spot) / spot : null,
        fundingSignal,
        basisSignal,
        deadFactor: isDead,
      },
    };
  }

  onCandleClosed(_candle: KlineCandle, _interval: string): void {}

  async teardown(): Promise<void> {
    this.latestFundingRate = null;
    this.spotPrice = null;
    this.perpPrice = null;
  }
}
