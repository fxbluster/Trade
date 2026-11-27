import type { ConfluencePillarId, PillarEvaluation } from '@tradeos/shared';

export interface LiquidationCluster {
  price: number;
  estimatedVolumeUsd: number;
  side: 'LONG_LIQ' | 'SHORT_LIQ'; // LONG_LIQ is below current price, SHORT_LIQ is above
  leverage?: number;
}

export interface LiquidationEngineInput {
  currentPrice: number;
  atr14: number | null;
  recentHigh?: number;
  recentLow?: number;
  openInterestUsd?: number | null;
  clusters?: LiquidationCluster[];
  pillarId?: ConfluencePillarId;
  triggerAtrMultiplier?: number;
}

/**
 * LiquidationEngine — Evaluates price proximity to liquidation magnet clusters.
 *
 * Pillar 5: LIQ_CLUSTERS / LIQ_MAGNET (Weight: 7.5% - 10%)
 * Projects leverage clusters (10x, 25x, 50x, 100x) from live Open Interest:
 * - 100x (weight 15%): P_mark * (1 ± 0.01)
 * - 50x  (weight 35%): P_mark * (1 ± 0.02)
 * - 25x  (weight 35%): P_mark * (1 ± 0.04)
 * - 10x  (weight 15%): P_mark * (1 ± 0.10)
 * Confirmation condition: Proximity within 1.0x - 1.2x ATR to dominant liquidation pool.
 */
export class LiquidationEngine {
  private readonly LEVERAGE_TIERS = [
    { leverage: 100, weight: 0.15, deltaPct: 0.01 },
    { leverage: 50,  weight: 0.35, deltaPct: 0.02 },
    { leverage: 25,  weight: 0.35, deltaPct: 0.04 },
    { leverage: 10,  weight: 0.15, deltaPct: 0.10 },
  ];

  /**
   * Projects theoretical leverage liquidation clusters (10x, 25x, 50x, 100x) from Open Interest.
   */
  public projectClusters(
    currentPrice: number,
    openInterestUsd?: number | null
  ): LiquidationCluster[] {
    if (!currentPrice || currentPrice <= 0) return [];

    const oi = openInterestUsd && openInterestUsd > 0 ? openInterestUsd : 0;
    const clusters: LiquidationCluster[] = [];
    const priceDecimals = currentPrice < 0.1 ? 6 : currentPrice < 10 ? 4 : 2;

    for (const tier of this.LEVERAGE_TIERS) {
      const tierVol = oi * tier.weight;
      const sideVol = tierVol * 0.5;

      // Short liquidation pool (above current price)
      const shortLiqPrice = Number((currentPrice * (1 + tier.deltaPct)).toFixed(priceDecimals));
      clusters.push({
        price: shortLiqPrice,
        estimatedVolumeUsd: sideVol,
        side: 'SHORT_LIQ',
        leverage: tier.leverage,
      });

      // Long liquidation pool (below current price)
      const longLiqPrice = Number((currentPrice * (1 - tier.deltaPct)).toFixed(priceDecimals));
      clusters.push({
        price: longLiqPrice,
        estimatedVolumeUsd: sideVol,
        side: 'LONG_LIQ',
        leverage: tier.leverage,
      });
    }

    return clusters;
  }

  /**
   * Evaluates proximity to liquidation pools based on price and ATR.
   */
  public evaluate(input: LiquidationEngineInput): PillarEvaluation {
    const {
      currentPrice,
      atr14,
      recentHigh,
      recentLow,
      openInterestUsd,
      clusters: explicitClusters,
      pillarId = 'LIQ_MAGNET' as any,
    } = input;
    const now = Date.now();

    if (!currentPrice || currentPrice <= 0 || !atr14 || atr14 <= 0) {
      return {
        id: pillarId,
        title: 'Liquidation Heat Clusters',
        score: 50,
        bias: 'NEUTRAL',
        valueText: 'Dispersed',
        subText: 'Insufficient ATR / price data',
        confirmed: false,
        updatedAt: now,
      };
    }

    const clusters =
      explicitClusters && explicitClusters.length > 0
        ? explicitClusters
        : this.projectClusters(currentPrice, openInterestUsd);

    let poolAbove: number | null = null;
    let poolAboveVol = 0;
    let poolBelow: number | null = null;
    let poolBelowVol = 0;

    if (clusters.length > 0) {
      for (const c of clusters) {
        if (c.price > currentPrice && (poolAbove === null || c.price < poolAbove)) {
          poolAbove = c.price;
          poolAboveVol = c.estimatedVolumeUsd;
        } else if (c.price < currentPrice && (poolBelow === null || c.price > poolBelow)) {
          poolBelow = c.price;
          poolBelowVol = c.estimatedVolumeUsd;
        }
      }
    }

    if (recentHigh && recentHigh > currentPrice && (poolAbove === null || recentHigh < poolAbove)) {
      poolAbove = recentHigh;
      poolAboveVol = (openInterestUsd ?? 10_000_000) * 0.15;
    }
    if (recentLow && recentLow < currentPrice && (poolBelow === null || recentLow > poolBelow)) {
      poolBelow = recentLow;
      poolBelowVol = (openInterestUsd ?? 10_000_000) * 0.15;
    }

    if (!poolAbove) {
      poolAbove = recentHigh && recentHigh > currentPrice ? recentHigh : currentPrice * 1.01;
    }
    if (!poolBelow) {
      poolBelow = recentLow && recentLow < currentPrice ? recentLow : currentPrice * 0.99;
    }

    const distAbove = poolAbove !== null ? poolAbove - currentPrice : Infinity;
    const distBelow = poolBelow !== null ? currentPrice - poolBelow : Infinity;

    // Percentage / bps normalization so <$1 assets scale identically to >$100 assets
    const atrPct = atr14 / currentPrice;
    const distAbovePct = distAbove / currentPrice;
    const distBelowPct = distBelow / currentPrice;

    const atrRatioAbove = distAbovePct / atrPct;
    const atrRatioBelow = distBelowPct / atrPct;

    const threshold = input.triggerAtrMultiplier ?? (openInterestUsd ? 1.2 : 1.0);
    const fmtPrice = (p: number): string =>
      p < 1 ? p.toFixed(4) : p < 10 ? p.toFixed(3) : p.toFixed(2);

    const formatVol = (v: number): string => {
      if (v >= 1e6) return `$${(v / 1e6).toFixed(1)}M`;
      if (v >= 1e3) return `$${(v / 1e3).toFixed(1)}K`;
      return `$${v.toFixed(0)}`;
    };

    // Check confirmation condition: within threshold ATR
    if (atrRatioAbove <= threshold && atrRatioAbove < atrRatioBelow) {
      const proximityFactor = Math.max(0, 1 - atrRatioAbove / threshold);
      const score = Math.min(100, Math.round(50 + proximityFactor * 40));
      const volInfo = poolAboveVol > 0 ? ` (${formatVol(poolAboveVol)})` : '';
      return {
        id: pillarId,
        title: 'Liquidation Heat Clusters',
        score,
        bias: 'BULLISH',
        valueText: `Short Liq Magnet: $${fmtPrice(poolAbove!)} (${atrRatioAbove.toFixed(1)}x ATR)${volInfo}`,
        subText: 'Price attracted upward toward short stop cluster',
        confirmed: true,
        updatedAt: now,
      };
    }

    if (atrRatioBelow <= threshold && atrRatioBelow <= atrRatioAbove) {
      const proximityFactor = Math.max(0, 1 - atrRatioBelow / threshold);
      const score = Math.min(100, Math.round(50 + proximityFactor * 40));
      const volInfo = poolBelowVol > 0 ? ` (${formatVol(poolBelowVol)})` : '';
      return {
        id: pillarId,
        title: 'Liquidation Heat Clusters',
        score,
        bias: 'BEARISH',
        valueText: `Long Liq Magnet: $${fmtPrice(poolBelow!)} (${atrRatioBelow.toFixed(1)}x ATR)${volInfo}`,
        subText: 'Price attracted downward toward long stop cluster',
        confirmed: true,
        updatedAt: now,
      };
    }

    const nearestSide = atrRatioAbove < atrRatioBelow ? 'Short' : 'Long';
    const nearestDist = Math.min(atrRatioAbove, atrRatioBelow);
    return {
      id: pillarId,
      title: 'Liquidation Heat Clusters',
      score: 50,
      bias: 'NEUTRAL',
      valueText: `Dispersed (${nearestDist.toFixed(1)}x ATR)`,
      subText: `Nearest ${nearestSide} pool outside ${threshold.toFixed(1)}x ATR trigger`,
      confirmed: false,
      updatedAt: now,
    };
  }
}
