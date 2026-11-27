import { describe, it, expect } from 'vitest';
import { NoiseBandEngine } from '../noiseBandEngine.js';
import { ConfluenceEngine } from '../confluenceEngine.js';
import type { KlineCandle } from '@tradeos/shared';

describe('NoiseBandEngine — 20-Day 15m Volatility Noise Band Filter', () => {
  function generateMockCandles(count: number, basePrice = 100, range = 1.0): KlineCandle[] {
    const candles: KlineCandle[] = [];
    // Start at a known timestamp (e.g. 2026-11-20T00:00:00Z)
    const startSec = 1795132800; // 00:00 UTC
    for (let i = 0; i < count; i++) {
      const time = startSec + i * 15 * 60; // 15-minute intervals
      const open = basePrice;
      const high = basePrice + range / 2;
      const low = basePrice - range / 2;
      const close = basePrice + 0.1;
      candles.push({
        time,
        open,
        high,
        low,
        close,
        volume: 1000 + (i % 10) * 100,
      });
    }
    return candles;
  }

  it('calculates hourly Mean True Range (MTR) and sets threshold to MTR * 0.5', () => {
    // Generate 1,920 candles (20 days * 96 candles/day) with constant range = 2.0
    const candles = generateMockCandles(1920, 100, 2.0);
    const engine = new NoiseBandEngine(candles, 0.5);

    // Each candle has TR = high - low = 2.0
    // Expected threshold = 2.0 * 0.5 = 1.00
    for (let h = 0; h < 24; h++) {
      const threshold = engine.getThreshold(h);
      expect(threshold).toBeCloseTo(1.0, 2);
      expect(engine.getMeanTrueRange(h)).toBeCloseTo(2.0, 2);
    }
  });

  it('detects noise when current 15m candle range is below the dynamic threshold', () => {
    const candles = generateMockCandles(96, 100, 2.0); // MTR = 2.0 -> threshold = 1.00
    const engine = new NoiseBandEngine(candles);

    // Sub-threshold candle: range = 0.4 (< 1.00)
    const tightCandle: KlineCandle = {
      time: 1795132800, // UTC 00:00
      open: 100,
      high: 100.2,
      low: 99.8,
      close: 100.1,
      volume: 500,
    };

    const isNoise = engine.isNoise(tightCandle, 95.0); // VWAP is far, but range is small
    expect(isNoise).toBe(true);
  });

  it('uses previous closed 15m candle range for continuity when a new 15m candle just opened', () => {
    const candles = generateMockCandles(96, 100, 2.0); // threshold = 1.00
    const engine = new NoiseBandEngine(candles);

    // Newly opened tight candle (range = 0.1)
    const freshCandle: KlineCandle = {
      time: 1795132800,
      open: 100,
      high: 100.05,
      low: 99.95,
      close: 100.02,
      volume: 100,
    };
    // Previous closed 15m candle had healthy range = 1.5 (>= 1.00)
    const activePrevCandle: KlineCandle = {
      time: 1795131900,
      open: 99,
      high: 100.5,
      low: 99.0,
      close: 100.0,
      volume: 2000,
    };
    // Quiet previous closed 15m candle (range = 0.3 < 1.00)
    const quietPrevCandle: KlineCandle = {
      time: 1795131900,
      open: 100,
      high: 100.15,
      low: 99.85,
      close: 100.0,
      volume: 200,
    };

    expect(engine.isNoise(freshCandle, 95.0, 100.02, activePrevCandle)).toBe(false);
    expect(engine.isNoise(freshCandle, 95.0, 100.02, quietPrevCandle)).toBe(true);
  });

  it('detects noise when price is too close to rolling 15m VWAP (distance < threshold * 0.5)', () => {
    const candles = generateMockCandles(96, 100, 2.0); // threshold = 1.00 -> 0.5 * threshold = 0.50
    const engine = new NoiseBandEngine(candles);

    // Wide candle: range = 1.6 (> 1.00), but mark price is right at VWAP (distance = 0.2 < 0.50)
    const wideCandleAtVwap: KlineCandle = {
      time: 1795132800,
      open: 100,
      high: 100.8,
      low: 99.2,
      close: 100.1,
      volume: 500,
    };

    const isNoise = engine.isNoise(wideCandleAtVwap, 100.0, 100.1);
    expect(isNoise).toBe(true);
  });

  it('passes noise check when range exceeds threshold and price expands away from VWAP', () => {
    const candles = generateMockCandles(96, 100, 2.0); // threshold = 1.00, 0.5*thresh = 0.50
    const engine = new NoiseBandEngine(candles);

    // Strong impulse candle: range = 2.0 (> 1.00), price is at 101.5 with VWAP at 100.0 (distance = 1.5 > 0.50)
    const impulseCandle: KlineCandle = {
      time: 1795132800,
      open: 100,
      high: 102.0,
      low: 100.0,
      close: 101.5,
      volume: 5000,
    };

    const isNoise = engine.isNoise(impulseCandle, 100.0, 101.5);
    expect(isNoise).toBe(false);
  });

  it('produces a comprehensive NoiseBandSnapshot telemetry payload', () => {
    const candles = generateMockCandles(96, 100, 2.0);
    const engine = new NoiseBandEngine(candles, 0.5);

    const candle: KlineCandle = {
      time: 1795132800, // 00:00 UTC
      open: 100,
      high: 103.0,
      low: 99.0,
      close: 102.5,
      volume: 2000,
    };

    const snapshot = engine.getSnapshot(candle, 100.0);
    expect(snapshot.hourOfDay).toBe(0);
    expect(snapshot.noiseThreshold).toBeCloseTo(1.0, 2);
    expect(snapshot.currentRange).toBe(4.0);
    expect(snapshot.isNoise).toBe(false);
    expect(snapshot.timestamp).toBe(1795132800 * 1000);
  });

  it('correctly calculates rolling volume-weighted average price (VWAP)', () => {
    const engine = new NoiseBandEngine();
    const testCandles: KlineCandle[] = [
      { time: 1000, open: 100, high: 110, low: 90, close: 100, volume: 100 }, // typical = 100, vol = 100 -> 10,000
      { time: 1900, open: 100, high: 120, low: 100, close: 110, volume: 200 }, // typical = 110, vol = 200 -> 22,000
    ];
    // sum typical*vol = 32,000; sum vol = 300 -> vwap = 32,000 / 300 = 106.6667
    const vwap = engine.calculateVWAP(testCandles);
    expect(vwap).toBeCloseTo(106.67, 2);
  });

  it('blocks consensus in ConfluenceEngine with BLOCKED_NOISE_BAND when 15m candle is inside noise band', () => {
    const candles = generateMockCandles(96, 100, 2.0); // threshold = 1.00
    const engine = new NoiseBandEngine(candles);
    const confluence = new ConfluenceEngine({ noiseBandEngine: engine });

    // Sub-threshold candle: range = 0.4 (< 1.00)
    const tightCandle: KlineCandle = {
      time: 1795132800,
      open: 100,
      high: 100.2,
      low: 99.8,
      close: 100.1,
      volume: 500,
    };

    const snap = confluence.evaluate({
      symbol: 'SOLUSDT',
      currentPrice: 100.1,
      indicators: null,
      cvd: null,
      candle15m: tightCandle,
      vwap: 95.0,
    });

    expect(snap.blockReason).toBe('BLOCKED_NOISE_BAND');
    expect(snap.noiseBandActive).toBe(true);
    expect(snap.consensusMet).toBe(false);
    expect(snap.recommendedAction).toBe('WAIT');
  });

  it('bypasses NoiseBand immediately when effectiveRange >= threshold and >= 1.5 * atr14 (sharp directional impulse)', () => {
    const candles = generateMockCandles(96, 100, 4.0); // MTR = 4.0 -> threshold = 2.00, 0.5*thresh = 1.00
    const engine = new NoiseBandEngine(candles);

    // Range = 3.0 (>= threshold 2.00), but price is right at VWAP (dist = 0.2 < 1.00),
    // and atr14 = 2.0 so effectiveRange (3.0) >= 1.5 * atr14 (3.0) -> impulse bypass clears VWAP proximity.
    const impulseCandle: KlineCandle = {
      time: 1795132800,
      open: 100,
      high: 101.5,
      low: 98.5,
      close: 98.8,
      volume: 5000,
    };

    expect(engine.isNoise(impulseCandle, 99.0, 98.8)).toBe(true); // without atr14 -> blocked by VWAP proximity
    expect(engine.isNoise(impulseCandle, 99.0, 98.8, undefined, 2.0)).toBe(false); // with atr14=2.0 -> bypassed
    expect(engine.getSnapshot(impulseCandle, 99.0, 98.8, undefined, 2.0).isNoise).toBe(false);
  });

  it('still blocks low-volatility chop when effectiveRange < threshold and effectiveRange < 1.5 * atr14', () => {
    const candles = generateMockCandles(96, 100, 4.0); // MTR = 4.0 -> threshold = 2.00
    const engine = new NoiseBandEngine(candles);

    const chopCandle: KlineCandle = {
      time: 1795132800,
      open: 100,
      high: 100.4,
      low: 99.6,
      close: 100.1,
      volume: 300,
    };

    // effectiveRange = 0.8 < threshold (2.00) and < 1.5 * atr14 (1.5 * 1.0 = 1.5)
    expect(engine.isNoise(chopCandle, 95.0, 100.1, undefined, 1.0)).toBe(true);
    // atr14 <= 0 does not trigger bypass
    expect(engine.isNoise(chopCandle, 95.0, 100.1, undefined, 0)).toBe(true);
  });

  it('[DEF-02 / ARCH-14] never bypasses NoiseBand in dead chop when effectiveRange < threshold even with small atr14', () => {
    // SOL-like MTR = 0.3934 -> threshold = 0.1967
    const candles = generateMockCandles(96, 100, 0.3934);
    const engine = new NoiseBandEngine(candles, 0.5);

    // Dead chop 15m candle: range = 0.15 (< 0.1967)
    const chopCandle: KlineCandle = {
      time: 1795132800,
      open: 100,
      high: 100.08,
      low: 99.93,
      close: 100.02,
      volume: 400,
    };

    // Even if 1m atr14 = 0.06 (so 0.15 >= 1.5 * 0.06 = 0.09), sub-threshold chop MUST remain isNoise: true
    expect(engine.isNoise(chopCandle, 99.0, 100.02, undefined, 0.06)).toBe(true);
    const snap = engine.getSnapshot(chopCandle, 99.0, 100.02, undefined, 0.06);
    expect(snap.isNoise).toBe(true);
    expect(snap.currentRange).toBeCloseTo(0.15, 4);
    expect(snap.noiseThreshold).toBeCloseTo(0.1967, 4);

    const confluence = new ConfluenceEngine({ noiseBandEngine: engine });
    const confSnap = confluence.evaluate({
      symbol: 'SOLUSDT',
      currentPrice: 100.02,
      indicators: {
        ema9: 100,
        ema21: 100,
        ema50: 100,
        ema200: 100,
        rsi14: 50,
        atr14: 0.06,
        macd: { macd: 0, signal: 0, histogram: 0 },
        bollingerBands: { upper: 101, middle: 100, lower: 99 },
        adx14: { adx: 15, pdi: 15, mdi: 15 },
        support: 99,
        resistance: 101,
        volumeSma20: 1000,
      },
      cvd: null,
      candle15m: chopCandle,
      vwap: 99.0,
    });
    expect(confSnap.noiseBandActive).toBe(true);
    expect(confSnap.noiseBand?.isNoise).toBe(true);
    expect(confSnap.noiseBand?.active).toBe(true);
    expect(confSnap.blockReason).toBe('BLOCKED_NOISE_BAND');
  });

  it('clears BLOCKED_NOISE_BAND in ConfluenceEngine when indicators.atr14 triggers breakout bypass above threshold', () => {
    const candles = generateMockCandles(96, 100, 4.0); // threshold = 2.00
    const engine = new NoiseBandEngine(candles);
    const confluence = new ConfluenceEngine({ noiseBandEngine: engine });

    const crashCandle: KlineCandle = {
      time: 1795132800,
      open: 100,
      high: 101.5,
      low: 98.5,
      close: 98.7,
      volume: 8000,
    };

    // effectiveRange = 3.0 (>= threshold 2.00) and >= 1.5 * atr14 (1.5 * 1.8 = 2.7) -> clears NoiseBand
    const snapBypass = confluence.evaluate({
      symbol: 'SOLUSDT',
      currentPrice: 98.7,
      indicators: {
        ema9: 100,
        ema21: 101,
        ema50: 102,
        ema200: 105,
        rsi14: 32,
        atr14: 1.8,
        macd: { macd: -1, signal: -0.5, histogram: -0.5 },
        bollingerBands: { upper: 105, middle: 100, lower: 95 },
        adx14: { adx: 28, pdi: 12, mdi: 30 },
        support: 95,
        resistance: 105,
        volumeSma20: 1000,
      },
      cvd: null,
      candle15m: crashCandle,
      vwap: 99.0,
    });

    expect(snapBypass.noiseBandActive).toBe(false);
    expect(snapBypass.blockReason).not.toBe('BLOCKED_NOISE_BAND');
  });
});
