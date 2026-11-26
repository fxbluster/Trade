/**
 * ORDER_FLOW_L2 Alpha Factor (20% default weight)
 *
 * Evaluates:
 * - Top-20 depth pressure ratio (bid vs ask volume imbalance)
 * - 60-second aggressive taker flow imbalance
 *
 * rawAlpha in [-1.0, +1.0]:
 *   +1.0 = strong bullish order flow
 *   -1.0 = strong bearish order flow
 *    0.0 = neutral
 */

import type { DatabaseSync } from 'node:sqlite';
import type { FactorOutput, FactorEvaluationContext, KlineCandle } from '@tradeos/shared';
import type { IAlphaFactor } from '../alphaRegistry.js';

const FACTOR_ID = 'ORDER_FLOW_L2';
const FACTOR_NAME = 'Order Flow L2';
const DEFAULT_WEIGHT = 0.20;
const TOP_N_LEVELS = 20;
const DEPTH_PRESSURE_THRESHOLD = 1.5; // 1.5x ratio = strong signal
const FLOW_IMBALANCE_THRESHOLD = 0.6; // 60% directional taker flow = signal

export class OrderFlowFactor implements IAlphaFactor {
  readonly id = FACTOR_ID;
  readonly name = FACTOR_NAME;
  readonly defaultWeight = DEFAULT_WEIGHT;

  async initialize(_db: DatabaseSync): Promise<void> {
    // No DB state required for this factor
  }

  warmup(_candles: KlineCandle[]): void {
    // No warmup state required; depth & flow are real-time
  }

  computeFactor(context: FactorEvaluationContext): FactorOutput {
    const depth = context.depth;
    const cvd = context.cvd;
    const hasDepth = Boolean(depth && depth.bids.length > 0 && depth.asks.length > 0);
    const hasFlow = Boolean(cvd && cvd.buyVolume + cvd.sellVolume > 0);

    // If neither depth nor taker flow data is available, return neutral
    if (!hasDepth && !hasFlow) {
      return neutral(context.timestamp);
    }

    // Top-20 depth slices
    const topBids = hasDepth ? depth!.bids.slice(0, TOP_N_LEVELS) : [];
    const topAsks = hasDepth ? depth!.asks.slice(0, TOP_N_LEVELS) : [];

    const bidVolume = topBids.reduce((s, l) => s + l.qty, 0);
    const askVolume = topAsks.reduce((s, l) => s + l.qty, 0);
    const totalDepthVolume = bidVolume + askVolume;

    // Depth pressure ratio signal [-1, 1]
    let depthSignal = 0;
    if (totalDepthVolume > 0) {
      // ratio > 1 means more bid support (bullish); < 1 means ask (bearish)
      const ratio = bidVolume / (askVolume + 1e-9);
      if (ratio >= DEPTH_PRESSURE_THRESHOLD) {
        depthSignal = Math.min(1.0, (ratio - 1) / (DEPTH_PRESSURE_THRESHOLD * 2));
      } else if (ratio <= 1 / DEPTH_PRESSURE_THRESHOLD) {
        depthSignal = Math.max(-1.0, -(1 / ratio - 1) / (DEPTH_PRESSURE_THRESHOLD * 2));
      } else {
        // Linear interpolation between -1 and +1
        depthSignal = (ratio - 1) / DEPTH_PRESSURE_THRESHOLD;
      }
      depthSignal = Math.max(-1.0, Math.min(1.0, depthSignal));
    }

    // 60-second taker flow imbalance from CVD snapshot
    let flowSignal = 0;
    let takerRatio = 1.0;
    if (hasFlow && cvd) {
      const totalFlow = cvd.buyVolume + cvd.sellVolume;
      const flowRatio = cvd.buyVolume / totalFlow;
      const minFlow = Math.min(cvd.buyVolume, cvd.sellVolume);
      const maxFlow = Math.max(cvd.buyVolume, cvd.sellVolume);
      takerRatio = minFlow > 0 ? maxFlow / minFlow : maxFlow;

      // flowRatio > FLOW_IMBALANCE_THRESHOLD => bullish taker flow
      if (flowRatio > FLOW_IMBALANCE_THRESHOLD) {
        flowSignal = Math.min(1.0, (flowRatio - 0.5) * 2);
      } else if (flowRatio < 1 - FLOW_IMBALANCE_THRESHOLD) {
        flowSignal = Math.max(-1.0, (flowRatio - 0.5) * 2);
      }
      flowSignal = Math.max(-1.0, Math.min(1.0, flowSignal));
    }

    // [DEF-02 / ARCH-02] Give aggressive 60s taker flow (>= 3.0x) clear priority over passive depth
    let rawAlpha: number;
    if (hasFlow && takerRatio >= 3.0) {
      rawAlpha = Math.max(-1.0, Math.min(1.0, flowSignal * 0.85 + depthSignal * 0.15));
    } else if (!hasDepth) {
      rawAlpha = flowSignal;
    } else {
      // Combine: 60% weight on depth pressure, 40% on taker flow
      rawAlpha = Math.max(-1.0, Math.min(1.0, depthSignal * 0.6 + flowSignal * 0.4));
    }

    const bias = rawAlpha > 0.1 ? 'BULLISH' : rawAlpha < -0.1 ? 'BEARISH' : 'NEUTRAL';
    const confidence = Math.abs(rawAlpha);

    return {
      factorId: FACTOR_ID,
      bias,
      rawAlpha,
      confidence,
      uncertainty: 1 - confidence,
      halfLifeMs: 60_000, // 1 minute for microstructure
      metadata: {
        bidVolume,
        askVolume,
        depthSignal,
        flowSignal,
        takerRatio,
        topLevelsUsed: hasDepth ? Math.min(TOP_N_LEVELS, depth!.bids.length) : 0,
      },
    };
  }

  onCandleClosed(_candle: KlineCandle, _interval: string): void {
    // Real-time factor; no candle-based state
  }

  async teardown(): Promise<void> {}
}

function neutral(timestamp: number): FactorOutput {
  return {
    factorId: FACTOR_ID,
    bias: 'NEUTRAL',
    rawAlpha: 0,
    confidence: 0,
    uncertainty: 1,
    halfLifeMs: 60_000,
    metadata: { reason: 'NO_DEPTH_DATA' },
  };
}
