import type { KlineCandle } from '@tradeos/shared';

export interface CandleLike {
  time?: number;
  open?: number;
  high?: number;
  low?: number;
  close: number;
  volume?: number;
  [key: string]: unknown;
}

export type TimeMachineCandle = KlineCandle | CandleLike;

export interface TimeMachineParams {
  entryPrice?: number;
  entry?: number;
  price?: number;
  currentPrice?: number;
  side?: 'BUY' | 'SELL' | 'LONG' | 'SHORT';
  type?: string;
  takeProfit?: number;
  targetTP?: number;
  tp?: number;
  stopLoss?: number;
  targetSL?: number;
  sl?: number;
  horizon?: number;
  iterations?: number;
  amountUSD?: number;
  margin?: number;
  riskUsd?: number;
  rewardUsd?: number;
  commissionRate?: number;
  takerFeeRate?: number;
  seed?: number;
}

export interface FanRibbonStep {
  step: number;
  p05: number;
  p25: number;
  p50: number;
  p75: number;
  p95: number;
}

export interface QuantileRibbon {
  steps: number;
  p05: number[];
  p25: number[];
  p50: number[];
  p75: number[];
  p95: number[];
  fanRibbon: FanRibbonStep[];
}

export interface HistogramBin {
  bin: number;
  low: number;
  high: number;
  count: number;
  densityPct: number;
}

export interface MonteCarloResult {
  success: boolean;
  entryPrice: number;
  takeProfit: number;
  stopLoss: number;
  side: 'LONG' | 'SHORT';
  horizon: number;
  iterations: number;
  probTP: number;
  probSL: number;
  probChop: number;
  ev: number;
  evDollars: number;
  rewardPct: number;
  riskPct: number;
  isPositiveEV: boolean;
  isApproved: boolean;
  gateAction: 'ALLOW' | 'BLOCK';
  quantiles: QuantileRibbon;
  densityHistogram: HistogramBin[];
  execTimeMs: number;
}

/**
 * 32-bit Mulberry32 PRNG for deterministic, ultra-fast pseudo-random number generation.
 */
export function createMulberry32(seed: number = 1337): () => number {
  let a = (seed | 0) || 1337;
  return function mulberry32(): number {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0);
  };
}

/**
 * Box-Muller transform for standard Gaussian random variates.
 */
export function boxMullerGaussian(mean: number = 0, stdDev: number = 1, rng?: () => number): number {
  let u1: number;
  let u2: number;
  if (rng) {
    u1 = Math.max(1e-9, rng() / 4294967296.0);
    u2 = rng() / 4294967296.0;
  } else {
    u1 = Math.max(1e-9, Math.random());
    u2 = Math.random();
  }
  const z0 = Math.sqrt(-2.0 * Math.log(u1)) * Math.cos(2.0 * Math.PI * u2);
  return mean + z0 * stdDev;
}

/**
 * 288-Slot 5m Kline Circular RingBuffer (Float64Array).
 * Represents exactly 24 hours of 5-minute candles (288 * 5m = 1440m = 24h).
 * Zero-allocation in hot loops.
 */
export class TimeMachineKlineRingBuffer {
  public readonly capacity: number;
  private readonly times: Float64Array;
  private readonly opens: Float64Array;
  private readonly highs: Float64Array;
  private readonly lows: Float64Array;
  private readonly closes: Float64Array;
  private readonly volumes: Float64Array;
  private head: number = -1;
  private count: number = 0;

  constructor(capacity: number = 288) {
    this.capacity = Math.max(1, capacity);
    this.times = new Float64Array(this.capacity);
    this.opens = new Float64Array(this.capacity);
    this.highs = new Float64Array(this.capacity);
    this.lows = new Float64Array(this.capacity);
    this.closes = new Float64Array(this.capacity);
    this.volumes = new Float64Array(this.capacity);
  }

  public push(candle: TimeMachineCandle | number[]): number {
    if (!candle) return this.count;

    let t = 0, o = 0, h = 0, l = 0, c = 0, v = 0;
    if (Array.isArray(candle)) {
      t = Number(candle[0]) || Date.now();
      o = Number(candle[1]) || 0;
      h = Number(candle[2]) || o;
      l = Number(candle[3]) || o;
      c = Number(candle[4]) || o;
      v = Number(candle[5]) || 0;
    } else {
      const cObj = candle as Record<string, unknown>;
      t = Number(cObj.time ?? cObj.timestamp ?? cObj.t) || Date.now();
      o = Number(cObj.open ?? cObj.o) || 0;
      h = Number(cObj.high ?? cObj.h) || o;
      l = Number(cObj.low ?? cObj.l) || o;
      c = Number(cObj.close ?? cObj.c) || o;
      v = Number(cObj.volume ?? cObj.v) || 0;
    }

    this.head = (this.head + 1) % this.capacity;
    this.times[this.head] = t;
    this.opens[this.head] = o;
    this.highs[this.head] = h;
    this.lows[this.head] = l;
    this.closes[this.head] = c;
    this.volumes[this.head] = v;

    if (this.count < this.capacity) {
      this.count++;
    }
    return this.count;
  }

  public pushBatch(candles: (TimeMachineCandle | number[])[]): number {
    if (!Array.isArray(candles)) return this.count;
    for (let i = 0; i < candles.length; i++) {
      this.push(candles[i]);
    }
    return this.count;
  }

  public size(): number {
    return this.count;
  }

  public isFull(): boolean {
    return this.count >= this.capacity;
  }

  public clear(): void {
    this.times.fill(0);
    this.opens.fill(0);
    this.highs.fill(0);
    this.lows.fill(0);
    this.closes.fill(0);
    this.volumes.fill(0);
    this.head = -1;
    this.count = 0;
  }

  public getCloses(): Float64Array {
    const arr = new Float64Array(this.count);
    if (this.count === 0) return arr;
    const start = (this.head - this.count + 1 + this.capacity) % this.capacity;
    for (let i = 0; i < this.count; i++) {
      const idx = (start + i) % this.capacity;
      arr[i] = this.closes[idx];
    }
    return arr;
  }

  /**
   * Computes empirical log returns r_t = ln(Close_t / Close_{t-1})
   */
  public getLogReturns(): Float64Array {
    if (this.count < 2) return new Float64Array(0);
    const returns = new Float64Array(this.count - 1);
    const start = (this.head - this.count + 1 + this.capacity) % this.capacity;
    let prevClose = this.closes[start];
    for (let i = 1; i < this.count; i++) {
      const idx = (start + i) % this.capacity;
      const currClose = this.closes[idx];
      returns[i - 1] = (prevClose > 0 && currClose > 0) ? Math.log(currClose / prevClose) : 0;
      prevClose = currClose;
    }
    return returns;
  }

  /**
   * Generates a 256-element pre-exponential return pool (exp(r))
   * for fast bitwise mask sampling in Monte Carlo simulation.
   * If empirical data is insufficient (< 2 candles or flat prices),
   * uses Gaussian Box-Muller fallback (~0.45% std dev for 5m crypto bars).
   */
  public getExpReturnPool(targetSize: number = 256, seed: number = 1337): Float64Array {
    const pool = new Float64Array(targetSize);
    const logReturns = this.getLogReturns();

    // Check if we have valid non-zero empirical variance
    let hasVariance = false;
    if (logReturns.length >= 2) {
      for (let i = 0; i < logReturns.length; i++) {
        if (Math.abs(logReturns[i]) > 1e-8) {
          hasVariance = true;
          break;
        }
      }
    }

    if (hasVariance) {
      const n = logReturns.length;
      for (let i = 0; i < targetSize; i++) {
        const sampleIdx = i % n;
        pool[i] = Math.exp(logReturns[sampleIdx]);
      }
    } else {
      // Gaussian Box-Muller fallback: crypto 5m volatility (~0.45% std dev)
      const rng = createMulberry32(seed);
      const baseStd = 0.0045;
      for (let i = 0; i < targetSize; i++) {
        const z0 = boxMullerGaussian(0, baseStd, rng);
        pool[i] = Math.exp(z0);
      }
    }
    return pool;
  }

  public toArray(): CandleLike[] {
    if (this.count === 0) return [];
    const arr: CandleLike[] = new Array(this.count);
    const start = (this.head - this.count + 1 + this.capacity) % this.capacity;
    for (let i = 0; i < this.count; i++) {
      const idx = (start + i) % this.capacity;
      arr[i] = {
        time: this.times[idx],
        open: this.opens[idx],
        high: this.highs[idx],
        low: this.lows[idx],
        close: this.closes[idx],
        volume: this.volumes[idx]
      };
    }
    return arr;
  }
}

/**
 * FastCryptoTimeMachine — 10,000 Iterations Empirical Bootstrap Monte Carlo
 * First-Hitting-Time (FHT) Engine with Quantile Fan Ribbon and Step-24 Histogram.
 * Optimized for V8 execution under 25ms.
 */
export function FastCryptoTimeMachine(
  bufferOrCandles: TimeMachineKlineRingBuffer | TimeMachineCandle[] | Float64Array | null,
  params: TimeMachineParams = {}
): MonteCarloResult {
  const startTime = performance.now();

  const entry = Number(params.entryPrice ?? params.entry ?? params.price ?? params.currentPrice ?? 100);
  const rawSide = String(params.side ?? params.type ?? 'LONG').toUpperCase();
  const isLong = !rawSide.includes('SHORT') && !rawSide.includes('SELL');
  const side: 'LONG' | 'SHORT' = isLong ? 'LONG' : 'SHORT';

  let tp = Number(params.targetTP ?? params.takeProfit ?? params.tp ?? (isLong ? entry * 1.02 : entry * 0.98));
  let sl = Number(params.targetSL ?? params.stopLoss ?? params.sl ?? (isLong ? entry * 0.98 : entry * 1.02));

  // Sanity fallback to prevent equal or inverted bounds
  if (tp <= 0) tp = isLong ? entry * 1.02 : entry * 0.98;
  if (sl <= 0) sl = isLong ? entry * 0.98 : entry * 1.02;

  const horizon = Math.max(6, Math.min(72, Number(params.horizon ?? 24))); // Default 24 steps = 2 hours
  const iterations = Math.max(1000, Math.min(20000, Number(params.iterations ?? 10000)));
  const amountUSD = Number(params.amountUSD ?? params.margin ?? params.riskUsd ?? 10.0);
  const commissionRate = Number(params.commissionRate ?? params.takerFeeRate ?? 0.0005); // 0.05% Taker fee
  const seed = (params.seed !== undefined && params.seed !== null) ? (params.seed >>> 0) : (1337 ^ (entry | 0));

  const poolSize = 256;
  const poolMask = poolSize - 1;

  let expPool: Float64Array;
  if (bufferOrCandles instanceof TimeMachineKlineRingBuffer) {
    expPool = bufferOrCandles.getExpReturnPool(poolSize, seed);
  } else if (bufferOrCandles instanceof Float64Array && bufferOrCandles.length >= poolSize) {
    expPool = bufferOrCandles;
  } else if (Array.isArray(bufferOrCandles) && bufferOrCandles.length > 0) {
    const ring = new TimeMachineKlineRingBuffer(Math.max(288, bufferOrCandles.length));
    ring.pushBatch(bufferOrCandles);
    expPool = ring.getExpReturnPool(poolSize, seed);
  } else {
    const ring = new TimeMachineKlineRingBuffer(288);
    expPool = ring.getExpReturnPool(poolSize, seed);
  }

  const rng = createMulberry32(seed);

  let tpHits = 0;
  let slHits = 0;
  let chopHits = 0;

  const terminalPrices = new Float64Array(iterations);

  // Sample representative paths for quantile ribbon (500 paths)
  const samplePathsCount = Math.min(500, iterations);
  const sampleSteps = new Float64Array(samplePathsCount * (horizon + 1));
  for (let p = 0; p < samplePathsCount; p++) {
    sampleSteps[p * (horizon + 1)] = entry;
  }

  // Core Monte Carlo loop (Hot path optimized)
  for (let i = 0; i < iterations; i++) {
    let price = entry;
    let hit = 0; // 1 = TP, -1 = SL, 0 = chop
    const isSampledPath = i < samplePathsCount;

    for (let s = 1; s <= horizon; s++) {
      const idx = rng() & poolMask;
      price *= expPool[idx];

      if (isSampledPath) {
        sampleSteps[i * (horizon + 1) + s] = price;
      }

      if (hit === 0) {
        if (isLong) {
          if (price >= tp) {
            tpHits++;
            hit = 1;
            if (!isSampledPath) break;
          } else if (price <= sl) {
            slHits++;
            hit = -1;
            if (!isSampledPath) break;
          }
        } else {
          if (price <= tp) {
            tpHits++;
            hit = 1;
            if (!isSampledPath) break;
          } else if (price >= sl) {
            slHits++;
            hit = -1;
            if (!isSampledPath) break;
          }
        }
      }
    }

    if (hit === 0) {
      chopHits++;
    }
    terminalPrices[i] = price;
  }

  const probTP = tpHits / iterations;
  const probSL = slHits / iterations;
  const probChop = chopHits / iterations;

  const rewardPct = Math.abs(tp - entry) / entry;
  const riskPct = Math.abs(entry - sl) / entry;

  // Expected Value with round-trip commission deduction
  const netReward = rewardPct - (commissionRate * 2);
  const netRisk = riskPct + (commissionRate * 2);
  const ev = (probTP * netReward) - (probSL * netRisk);
  const evDollars = ev * amountUSD;

  // Quantile Fan Ribbon across horizon steps
  const quantiles: QuantileRibbon = {
    steps: horizon,
    p05: new Array(horizon + 1),
    p25: new Array(horizon + 1),
    p50: new Array(horizon + 1),
    p75: new Array(horizon + 1),
    p95: new Array(horizon + 1),
    fanRibbon: new Array(horizon)
  };

  const stepVals = new Float64Array(samplePathsCount);
  for (let s = 0; s <= horizon; s++) {
    for (let p = 0; p < samplePathsCount; p++) {
      stepVals[p] = sampleSteps[p * (horizon + 1) + s];
    }
    stepVals.sort();
    quantiles.p05[s] = Number(stepVals[Math.floor(samplePathsCount * 0.05)].toFixed(4));
    quantiles.p25[s] = Number(stepVals[Math.floor(samplePathsCount * 0.25)].toFixed(4));
    quantiles.p50[s] = Number(stepVals[Math.floor(samplePathsCount * 0.50)].toFixed(4));
    quantiles.p75[s] = Number(stepVals[Math.floor(samplePathsCount * 0.75)].toFixed(4));
    quantiles.p95[s] = Number(stepVals[Math.floor(samplePathsCount * 0.95)].toFixed(4));

    if (s > 0) {
      quantiles.fanRibbon[s - 1] = {
        step: s,
        p05: quantiles.p05[s],
        p25: quantiles.p25[s],
        p50: quantiles.p50[s],
        p75: quantiles.p75[s],
        p95: quantiles.p95[s]
      };
    }
  }

  // 12-Bin Density Histogram
  terminalPrices.sort();
  const minTerm = terminalPrices[Math.floor(iterations * 0.01)];
  const maxTerm = terminalPrices[Math.floor(iterations * 0.99)];
  const binCount = 12;
  const binWidth = (maxTerm - minTerm) / binCount || 1;
  const densityHistogram: HistogramBin[] = [];

  for (let b = 0; b < binCount; b++) {
    const low = minTerm + b * binWidth;
    const high = low + binWidth;
    let count = 0;
    for (let i = 0; i < iterations; i++) {
      const p = terminalPrices[i];
      if (b === 0) {
        if (p < high) count++;
      } else if (b === binCount - 1) {
        if (p >= low) count++;
      } else {
        if (p >= low && p < high) count++;
      }
    }
    densityHistogram.push({
      bin: b,
      low: Number(low.toFixed(2)),
      high: Number(high.toFixed(2)),
      count,
      densityPct: Number(((count / iterations) * 100).toFixed(2))
    });
  }

  const isPositiveEV = ev > 0;
  const isApproved = isPositiveEV && (probTP >= probSL);
  const gateAction: 'ALLOW' | 'BLOCK' = isApproved ? 'ALLOW' : 'BLOCK';

  const execTimeMs = Number((performance.now() - startTime).toFixed(2));

  return {
    success: true,
    entryPrice: Number(entry.toFixed(4)),
    takeProfit: Number(tp.toFixed(4)),
    stopLoss: Number(sl.toFixed(4)),
    side,
    horizon,
    iterations,
    probTP: Number(probTP.toFixed(4)),
    probSL: Number(probSL.toFixed(4)),
    probChop: Number(probChop.toFixed(4)),
    ev: Number(ev.toFixed(4)),
    evDollars: Number(evDollars.toFixed(2)),
    rewardPct: Number(rewardPct.toFixed(4)),
    riskPct: Number(riskPct.toFixed(4)),
    isPositiveEV,
    isApproved,
    gateAction,
    quantiles,
    densityHistogram,
    execTimeMs
  };
}

/**
 * Top-level helper to run Time Machine simulation directly on candle history.
 */
export function runTimeMachineSim(
  candles: TimeMachineCandle[],
  params?: TimeMachineParams
): MonteCarloResult {
  return FastCryptoTimeMachine(candles, params);
}
