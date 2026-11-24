/**
 * LIQ_CLUSTERS Alpha Factor (8% default weight)
 *
 * Evaluates:
 * - High-leverage liquidation clusters (10x, 25x, 50x, 100x) projected from Open Interest
 * - Tightened 0.45x ATR proximity magnet trigger:
 *     Price within 0.45x ATR of SHORT liquidation pool (above price) -> Bullish magnet draw
 *     Price within 0.45x ATR of LONG liquidation pool (below price) -> Bearish magnet draw
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
import { LiquidationEngine, type LiquidationCluster } from '../liquidationEngine.js';

const FACTOR_ID = 'LIQ_CLUSTERS';
const FACTOR_NAME = 'Liquidation Clusters';
const DEFAULT_WEIGHT = 0.08;
const PROXIMITY_ATR_MULTIPLIER = 0.45; // 0.45x ATR proximity threshold

export class LiqClustersFactor implements IAlphaFactor {
  readonly id = FACTOR_ID;
  readonly name = FACTOR_NAME;
  readonly defaultWeight = DEFAULT_WEIGHT;

  private readonly liquidationEngine: LiquidationEngine;
  private customClusters: LiquidationCluster[] = [];

  constructor(liquidationEngine?: LiquidationEngine) {
    this.liquidationEngine = liquidationEngine ?? new LiquidationEngine();
  }

  async initialize(_db: DatabaseSync): Promise<void> {}

  warmup(_candles: KlineCandle[]): void {}

  /**
   * Set custom liquidation clusters (e.g. from exchange liquidation stream).
   */
  public setClusters(clusters: LiquidationCluster[]): void {
    this.customClusters = clusters.slice();
  }

  computeFactor(context: FactorEvaluationContext): FactorOutput {
    const currentPrice = context.currentPrice;
    const atr14 = context.indicators?.atr14 ?? (currentPrice * 0.01); // Fallback 1% ATR
    const openInterestUsd = context.cvd?.openInterestUsd ?? null;

    if (currentPrice <= 0 || atr14 <= 0) {
      return neutral(context.timestamp);
    }

    // Project or retrieve clusters
    const clusters =
      this.customClusters.length > 0
        ? this.customClusters
        : this.liquidationEngine.projectClusters(currentPrice, openInterestUsd);

    if (clusters.length === 0) {
      return neutral(context.timestamp);
    }

    const proximityThreshold = PROXIMITY_ATR_MULTIPLIER * atr14;

    let nearestShortDist = Infinity;
    let nearestShortCluster: LiquidationCluster | null = null;
    let nearestLongDist = Infinity;
    let nearestLongCluster: LiquidationCluster | null = null;

    for (const cluster of clusters) {
      if (cluster.side === 'SHORT_LIQ' && cluster.price >= currentPrice) {
        const dist = cluster.price - currentPrice;
        if (dist < nearestShortDist) {
          nearestShortDist = dist;
          nearestShortCluster = cluster;
        }
      } else if (cluster.side === 'LONG_LIQ' && cluster.price <= currentPrice) {
        const dist = currentPrice - cluster.price;
        if (dist < nearestLongDist) {
          nearestLongDist = dist;
          nearestLongCluster = cluster;
        }
      }
    }

    let rawAlpha = 0;
    let confidence = 0;

    const shortTriggered = nearestShortCluster && nearestShortDist <= proximityThreshold;
    const longTriggered = nearestLongCluster && nearestLongDist <= proximityThreshold;

    if (shortTriggered && !longTriggered) {
      // Short liquidation pool is within 0.45x ATR above price -> Bullish magnet draw
      const proximityRatio = Math.max(0, 1 - nearestShortDist / proximityThreshold);
      rawAlpha = 0.5 + proximityRatio * 0.5;
      confidence = Math.min(1.0, 0.6 + proximityRatio * 0.4);
    } else if (longTriggered && !shortTriggered) {
      // Long liquidation pool is within 0.45x ATR below price -> Bearish magnet draw
      const proximityRatio = Math.max(0, 1 - nearestLongDist / proximityThreshold);
      rawAlpha = -(0.5 + proximityRatio * 0.5);
      confidence = Math.min(1.0, 0.6 + proximityRatio * 0.4);
    } else if (shortTriggered && longTriggered) {
      // Price is flanked by both clusters within 0.45x ATR: compare volumes and proximity
      const shortRatio = 1 - nearestShortDist / proximityThreshold;
      const longRatio = 1 - nearestLongDist / proximityThreshold;
      const netRatio = shortRatio - longRatio;
      rawAlpha = Math.max(-0.8, Math.min(0.8, netRatio));
      confidence = 0.5;
    } else {
      // Not within 0.45x ATR threshold: mild directional pull toward the closer cluster
      if (nearestShortDist < nearestLongDist) {
        rawAlpha = Math.min(0.3, (proximityThreshold / nearestShortDist) * 0.3);
      } else if (nearestLongDist < nearestShortDist) {
        rawAlpha = -Math.min(0.3, (proximityThreshold / nearestLongDist) * 0.3);
      }
      confidence = 0.2;
    }

    rawAlpha = Math.max(-1.0, Math.min(1.0, rawAlpha));
    const bias = rawAlpha > 0.1 ? 'BULLISH' : rawAlpha < -0.1 ? 'BEARISH' : 'NEUTRAL';

    return {
      factorId: FACTOR_ID,
      bias,
      rawAlpha,
      confidence,
      uncertainty: 1 - confidence,
      halfLifeMs: 15 * 60_000,
      metadata: {
        atr14,
        proximityThreshold,
        nearestShortDist: nearestShortDist === Infinity ? null : nearestShortDist,
        nearestLongDist: nearestLongDist === Infinity ? null : nearestLongDist,
        shortTriggered: !!shortTriggered,
        longTriggered: !!longTriggered,
      },
    };
  }

  onCandleClosed(_candle: KlineCandle, _interval: string): void {}

  async teardown(): Promise<void> {
    this.customClusters = [];
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
    metadata: { reason: 'NO_CLUSTERS_OR_PRICE' },
  };
}
