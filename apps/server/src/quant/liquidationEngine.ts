import type { PillarEvaluation } from '@tradeos/shared';

export interface LiquidationCluster {
  price: number;
  estimatedVolumeUsd: number;
  side: 'LONG_LIQ' | 'SHORT_LIQ'; // LONG_LIQ is below current price, SHORT_LIQ is above
}

export interface LiquidationEngineInput {
  currentPrice: number;
  atr14: number | null;
  recentHigh?: number;
  recentLow?: number;
  openInterestUsd?: number | null;
  clusters?: LiquidationCluster[];
}

/**
 * LiquidationEngine — Evaluates price proximity to liquidation magnet clusters.
 *
 * Pillar 5: LIQ_MAGNET (Weight: 10%)
 * Confirmation condition: Proximity within 1.0x ATR to dominant liquidation pool.
 */
export class LiquidationEngine {
  /**
   * Evaluates proximity to liquidation pools based on price and ATR.
   */
  public evaluate(input: LiquidationEngineInput): PillarEvaluation {
    const { currentPrice, atr14, recentHigh, recentLow, clusters } = input;
    const now = Date.now();

    if (!currentPrice || currentPrice <= 0 || !atr14 || atr14 <= 0) {
      return {
        id: 'LIQ_MAGNET',
        title: 'Liquidation Magnet',
        score: 50,
        bias: 'NEUTRAL',
        valueText: 'Dispersed',
        subText: 'Insufficient ATR / price data',
        confirmed: false,
        updatedAt: now,
      };
    }

    // Identify or derive nearest clusters
    let poolAbove: number | null = null;
    let poolBelow: number | null = null;

    if (clusters && clusters.length > 0) {
      for (const c of clusters) {
        if (c.price > currentPrice && (poolAbove === null || c.price < poolAbove)) {
          poolAbove = c.price;
        } else if (c.price < currentPrice && (poolBelow === null || c.price > poolBelow)) {
          poolBelow = c.price;
        }
      }
    } else {
      // Derive theoretical leverage sweep pools:
      // High-frequency liquidation thresholds for 25x (4%) / 50x (2%) leverage
      const rHigh = recentHigh && recentHigh > currentPrice ? recentHigh : currentPrice * 1.02;
      const rLow = recentLow && recentLow < currentPrice ? recentLow : currentPrice * 0.98;

      poolAbove = rHigh;
      poolBelow = rLow;
    }

    const distAbove = poolAbove !== null ? poolAbove - currentPrice : Infinity;
    const distBelow = poolBelow !== null ? currentPrice - poolBelow : Infinity;

    const atrRatioAbove = distAbove / atr14;
    const atrRatioBelow = distBelow / atr14;

    // Check confirmation condition: within 1.0x ATR
    if (atrRatioAbove <= 1.0 && atrRatioAbove < atrRatioBelow) {
      const proximityFactor = Math.max(0, 1 - atrRatioAbove);
      const score = Math.min(100, Math.round(50 + proximityFactor * 40));
      return {
        id: 'LIQ_MAGNET',
        title: 'Liquidation Magnet',
        score,
        bias: 'BULLISH',
        valueText: `Short Liq Magnet: $${poolAbove!.toFixed(2)} (${atrRatioAbove.toFixed(1)}x ATR)`,
        subText: 'Price attracted upward toward short stop cluster',
        confirmed: true,
        updatedAt: now,
      };
    }

    if (atrRatioBelow <= 1.0 && atrRatioBelow <= atrRatioAbove) {
      const proximityFactor = Math.max(0, 1 - atrRatioBelow);
      const score = Math.min(100, Math.round(50 + proximityFactor * 40));
      return {
        id: 'LIQ_MAGNET',
        title: 'Liquidation Magnet',
        score,
        bias: 'BEARISH',
        valueText: `Long Liq Magnet: $${poolBelow!.toFixed(2)} (${atrRatioBelow.toFixed(1)}x ATR)`,
        subText: 'Price attracted downward toward long stop cluster',
        confirmed: true,
        updatedAt: now,
      };
    }

    // Beyond 1.0x ATR threshold -> Neutral
    const nearestSide = atrRatioAbove < atrRatioBelow ? 'Short' : 'Long';
    const nearestDist = Math.min(atrRatioAbove, atrRatioBelow);
    return {
      id: 'LIQ_MAGNET',
      title: 'Liquidation Magnet',
      score: 50,
      bias: 'NEUTRAL',
      valueText: `Dispersed (${nearestDist.toFixed(1)}x ATR)`,
      subText: `Nearest ${nearestSide} pool outside 1.0x ATR trigger`,
      confirmed: false,
      updatedAt: now,
    };
  }
}
