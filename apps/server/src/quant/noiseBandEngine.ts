/**
 * TradeOS v2 — Volatility Noise Band Engine
 *
 * Implements a 20-day rolling hourly-bucketed 15m True Range distribution filter.
 * Rejects low-volatility consolidation ranges and micro-noise to prevent commission drag.
 */

import type { KlineCandle, NoiseBandSnapshot } from '@tradeos/shared';

export const DEFAULT_NOISE_BAND_MULTIPLIER = 0.5;

export class NoiseBandEngine {
  private hourlyMtr: Map<number, number> = new Map();
  private defaultThreshold: number = 0;
  private readonly multiplier: number;

  constructor(candles?: KlineCandle[], multiplier: number = DEFAULT_NOISE_BAND_MULTIPLIER) {
    this.multiplier = multiplier;
    if (candles && candles.length > 0) {
      this.loadKlines(candles);
    }
  }

  /**
   * Pre-load historical 15m klines (ideally 20 days = 1,920 candles)
   * Groups True Range values by UTC hour of the day (0..23).
   */
  public loadKlines(candles: KlineCandle[]): void {
    if (!candles || candles.length === 0) return;

    const hourlyTrs = new Map<number, number[]>();
    for (let h = 0; h < 24; h++) {
      hourlyTrs.set(h, []);
    }

    let allTrSum = 0;
    let allTrCount = 0;

    for (let i = 0; i < candles.length; i++) {
      const current = candles[i]!;
      const prev = i > 0 ? candles[i - 1]! : null;
      const hl = current.high - current.low;
      const hc = prev ? Math.abs(current.high - prev.close) : hl;
      const lc = prev ? Math.abs(current.low - prev.close) : hl;
      const tr = Math.max(hl, hc, lc);

      const d = current.time > 1e11 ? new Date(current.time) : new Date(current.time * 1000);
      const h = d.getUTCHours();
      hourlyTrs.get(h)?.push(tr);
      allTrSum += tr;
      allTrCount++;
    }

    const overallMeanTr = allTrCount > 0 ? allTrSum / allTrCount : 0;
    this.defaultThreshold = overallMeanTr * this.multiplier;

    for (let h = 0; h < 24; h++) {
      const trs = hourlyTrs.get(h) ?? [];
      if (trs.length > 0) {
        const sum = trs.reduce((acc, val) => acc + val, 0);
        const mean = sum / trs.length;
        this.hourlyMtr.set(h, mean);
      } else {
        this.hourlyMtr.set(h, overallMeanTr);
      }
    }
  }

  /**
   * Returns the 20-day Mean True Range (MTR) for the given UTC hour (0..23).
   */
  public getMeanTrueRange(hourOfDay: number): number {
    const mtr = this.hourlyMtr.get(hourOfDay);
    if (mtr !== undefined && mtr > 0) {
      return Number(mtr.toFixed(4));
    }
    const fallback = this.multiplier > 0 ? this.defaultThreshold / this.multiplier : 0;
    return Number(fallback.toFixed(4));
  }

  /**
   * Returns the dynamic noise threshold for the given UTC hour (0..23).
   * NoiseThreshold_h = MTR_h * multiplier
   */
  public getThreshold(hourOfDay: number): number {
    const mtr = this.hourlyMtr.get(hourOfDay);
    if (mtr !== undefined && mtr > 0) {
      return Number((mtr * this.multiplier).toFixed(4));
    }
    return Number(this.defaultThreshold.toFixed(4));
  }

  /**
   * Evaluates whether a setup is inside the market noise band.
   * Blocked if:
   * 1. Effective 15m candle range (max of current developing & previous closed 15m candle) < NoiseThreshold_h, OR
   * 2. Distance between mark price and rolling 15m VWAP < NoiseThreshold_h * 0.5.
   */
  public isNoise(
    candle15m: KlineCandle,
    vwap: number,
    markPrice?: number,
    prevClosedCandle15m?: KlineCandle
  ): boolean {
    const d = candle15m.time > 1e11 ? new Date(candle15m.time) : new Date(candle15m.time * 1000);
    const hour = d.getUTCHours();
    const threshold = this.getThreshold(hour);
    const currentRange = candle15m.high - candle15m.low;
    const prevRange = prevClosedCandle15m ? prevClosedCandle15m.high - prevClosedCandle15m.low : 0;
    const effectiveRange = Math.max(currentRange, prevRange);
    const price = markPrice ?? candle15m.close;
    const vwapDist = Math.abs(price - vwap);

    return effectiveRange < threshold || vwapDist < threshold * 0.5;
  }

  /**
   * Generates a telemetry snapshot of the current noise band metrics.
   */
  public getSnapshot(
    candle15m: KlineCandle,
    vwap: number,
    markPrice?: number,
    prevClosedCandle15m?: KlineCandle
  ): NoiseBandSnapshot {
    const d = candle15m.time > 1e11 ? new Date(candle15m.time) : new Date(candle15m.time * 1000);
    const hour = d.getUTCHours();
    const threshold = this.getThreshold(hour);
    const currentRange = candle15m.high - candle15m.low;
    const prevRange = prevClosedCandle15m ? prevClosedCandle15m.high - prevClosedCandle15m.low : 0;
    const effectiveRange = Number(Math.max(currentRange, prevRange).toFixed(4));
    const noise = this.isNoise(candle15m, vwap, markPrice, prevClosedCandle15m);
    const ts = candle15m.time > 1e11 ? candle15m.time : candle15m.time * 1000;

    return {
      hourOfDay: hour,
      noiseThreshold: threshold,
      currentRange: effectiveRange,
      isNoise: noise,
      timestamp: ts,
    };
  }

  /**
   * Calculates rolling VWAP across 15m candles.
   */
  public calculateVWAP(candles: KlineCandle[]): number {
    if (!candles || candles.length === 0) return 0;
    let cumTypicalVol = 0;
    let cumVol = 0;
    for (const c of candles) {
      const typical = (c.high + c.low + c.close) / 3;
      const vol = c.volume > 0 ? c.volume : 1;
      cumTypicalVol += typical * vol;
      cumVol += vol;
    }
    return cumVol > 0 ? cumTypicalVol / cumVol : candles[candles.length - 1]!.close;
  }
}

export const noiseBandEngine = new NoiseBandEngine();
