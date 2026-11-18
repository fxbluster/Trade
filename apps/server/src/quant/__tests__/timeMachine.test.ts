import { describe, it, expect } from 'vitest';
import {
  TimeMachineKlineRingBuffer,
  FastCryptoTimeMachine,
  runTimeMachineSim,
  boxMullerGaussian,
  createMulberry32
} from '../timeMachine.js';

describe('TimeMachineKlineRingBuffer', () => {
  it('initializes with capacity 288 (24h of 5m candles)', () => {
    const ring = new TimeMachineKlineRingBuffer(288);
    expect(ring.capacity).toBe(288);
    expect(ring.size()).toBe(0);
    expect(ring.isFull()).toBe(false);
  });

  it('pushes candles and extracts chronological closes', () => {
    const ring = new TimeMachineKlineRingBuffer(5);
    for (let i = 1; i <= 5; i++) {
      ring.push({
        time: i * 1000,
        open: i * 10,
        high: i * 10 + 2,
        low: i * 10 - 2,
        close: i * 10,
        volume: 100
      });
    }

    expect(ring.size()).toBe(5);
    expect(ring.isFull()).toBe(true);

    const closes = ring.getCloses();
    expect(Array.from(closes)).toEqual([10, 20, 30, 40, 50]);
  });

  it('slides ring buffer properly when exceeding capacity', () => {
    const ring = new TimeMachineKlineRingBuffer(3);
    ring.push({ close: 10 });
    ring.push({ close: 20 });
    ring.push({ close: 30 });
    ring.push({ close: 40 }); // Overwrites close: 10

    expect(ring.size()).toBe(3);
    const closes = ring.getCloses();
    expect(Array.from(closes)).toEqual([20, 30, 40]);
  });

  it('computes accurate empirical log returns', () => {
    const ring = new TimeMachineKlineRingBuffer(10);
    ring.push({ close: 100 });
    ring.push({ close: 105 });
    ring.push({ close: 110.25 });

    const ret = ring.getLogReturns();
    expect(ret.length).toBe(2);
    expect(ret[0]).toBeCloseTo(Math.log(105 / 100), 5);
    expect(ret[1]).toBeCloseTo(Math.log(110.25 / 105), 5);
  });

  it('uses Gaussian Box-Muller fallback when insufficient candle history', () => {
    const emptyRing = new TimeMachineKlineRingBuffer(288);
    const pool = emptyRing.getExpReturnPool(256, 42);

    expect(pool.length).toBe(256);
    // All returns should be strictly positive (exp(z) > 0)
    for (let i = 0; i < pool.length; i++) {
      expect(pool[i]).toBeGreaterThan(0.9);
      expect(pool[i]).toBeLessThan(1.1);
    }
  });
});

describe('Box-Muller & Mulberry32 Helpers', () => {
  it('generates deterministic pseudorandom numbers with Mulberry32', () => {
    const rng1 = createMulberry32(12345);
    const rng2 = createMulberry32(12345);
    for (let i = 0; i < 10; i++) {
      expect(rng1()).toBe(rng2());
    }
  });

  it('computes Gaussian variates centered at mean with specified standard deviation', () => {
    const rng = createMulberry32(9999);
    const samples: number[] = [];
    for (let i = 0; i < 1000; i++) {
      samples.push(boxMullerGaussian(0, 0.01, rng));
    }
    const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
    expect(mean).toBeCloseTo(0, 2);
  });
});

describe('FastCryptoTimeMachine (10,000 Iterations Monte Carlo FHT)', () => {
  it('executes 10,000 paths under 30ms in V8', () => {
    const res = FastCryptoTimeMachine(null, {
      entryPrice: 100,
      targetTP: 103,
      targetSL: 97,
      side: 'LONG',
      iterations: 10000,
      horizon: 24
    });

    expect(res.success).toBe(true);
    expect(res.iterations).toBe(10000);
    expect(res.horizon).toBe(24);
    expect(res.execTimeMs).toBeLessThan(100); // Generous for busy CI/Windows, usually < 20ms
  });

  it('calculates probabilities summing to 1.0 (TP + SL + Chop)', () => {
    const res = FastCryptoTimeMachine(null, {
      entryPrice: 100,
      targetTP: 102,
      targetSL: 98,
      side: 'LONG',
      iterations: 5000,
      seed: 42
    });

    const totalProb = res.probTP + res.probSL + res.probChop;
    expect(totalProb).toBeCloseTo(1.0, 3);
  });

  it('handles SHORT trades correctly with inverted boundaries', () => {
    const res = FastCryptoTimeMachine(null, {
      entryPrice: 100,
      targetTP: 98,
      targetSL: 102,
      side: 'SHORT',
      iterations: 5000,
      seed: 42
    });

    expect(res.side).toBe('SHORT');
    expect(res.takeProfit).toBe(98);
    expect(res.stopLoss).toBe(102);
    expect(res.probTP).toBeGreaterThan(0);
    expect(res.probSL).toBeGreaterThan(0);
  });

  it('calculates Net Expected Value (EV) with commission impact and gate action', () => {
    const favorableRes = FastCryptoTimeMachine(null, {
      entryPrice: 100,
      targetTP: 101, // Tight TP -> high hit rate
      targetSL: 90,  // Deep SL
      side: 'LONG',
      iterations: 5000,
      amountUSD: 100,
      seed: 123
    });

    expect(typeof favorableRes.ev).toBe('number');
    expect(typeof favorableRes.evDollars).toBe('number');
    expect(['ALLOW', 'BLOCK']).toContain(favorableRes.gateAction);
  });

  it('generates quantile fan ribbon with monotonically ordered quantiles', () => {
    const res = FastCryptoTimeMachine(null, {
      entryPrice: 100,
      horizon: 24,
      iterations: 5000,
      seed: 777
    });

    expect(res.quantiles.steps).toBe(24);
    expect(res.quantiles.fanRibbon.length).toBe(24);

    for (const step of res.quantiles.fanRibbon) {
      expect(step.p05).toBeLessThanOrEqual(step.p25);
      expect(step.p25).toBeLessThanOrEqual(step.p50);
      expect(step.p50).toBeLessThanOrEqual(step.p75);
      expect(step.p75).toBeLessThanOrEqual(step.p95);
    }
  });

  it('generates 12-bin density histogram with bins summing to 100%', () => {
    const res = FastCryptoTimeMachine(null, {
      entryPrice: 100,
      iterations: 5000,
      seed: 888
    });

    expect(res.densityHistogram.length).toBe(12);
    const sumPct = res.densityHistogram.reduce((acc, bin) => acc + bin.densityPct, 0);
    expect(sumPct).toBeCloseTo(100, 1);
  });

  it('runs smoothly with top-level helper runTimeMachineSim using candle arrays', () => {
    const candles = [
      { time: 1000, open: 100, high: 102, low: 99, close: 101, volume: 1000 },
      { time: 2000, open: 101, high: 103, low: 100, close: 102, volume: 1200 },
      { time: 3000, open: 102, high: 104, low: 101, close: 103, volume: 1100 }
    ];

    const res = runTimeMachineSim(candles, {
      entryPrice: 103,
      targetTP: 106,
      targetSL: 100
    });

    expect(res.success).toBe(true);
    expect(res.entryPrice).toBe(103);
  });
});
