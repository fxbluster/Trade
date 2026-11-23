import { describe, it, expect } from 'vitest';
import { NoiseBandEngine } from '../noiseBandEngine.js';
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

  it('calculates hourly Mean True Range (MTR) and sets threshold to MTR * 1.25', () => {
    // Generate 1,920 candles (20 days * 96 candles/day) with constant range = 2.0
    const candles = generateMockCandles(1920, 100, 2.0);
    const engine = new NoiseBandEngine(candles);

    // Each candle has TR = high - low = 2.0
    // Expected threshold = 2.0 * 1.25 = 2.50
    for (let h = 0; h < 24; h++) {
      const threshold = engine.getThreshold(h);
      expect(threshold).toBeCloseTo(2.5, 2);
    }
  });

  it('detects noise when current 15m candle range is below the dynamic threshold', () => {
    const candles = generateMockCandles(96, 100, 2.0); // MTR = 2.0 -> threshold = 2.50
    const engine = new NoiseBandEngine(candles);

    // Sub-threshold candle: range = 1.2 (< 2.50)
    const tightCandle: KlineCandle = {
      time: 1795132800, // UTC 00:00
      open: 100,
      high: 100.6,
      low: 99.4,
      close: 100.2,
      volume: 500,
    };

    const isNoise = engine.isNoise(tightCandle, 95.0); // VWAP is far, but range is small
    expect(isNoise).toBe(true);
  });

  it('detects noise when price is too close to rolling 15m VWAP (distance < threshold * 0.5)', () => {
    const candles = generateMockCandles(96, 100, 2.0); // threshold = 2.50 -> 0.5 * threshold = 1.25
    const engine = new NoiseBandEngine(candles);

    // Wide candle: range = 3.0 (> 2.50), but mark price is right at VWAP (distance = 0.2 < 1.25)
    const wideCandleAtVwap: KlineCandle = {
      time: 1795132800,
      open: 100,
      high: 101.5,
      low: 98.5,
      close: 100.1,
      volume: 500,
    };

    const isNoise = engine.isNoise(wideCandleAtVwap, 100.0, 100.1);
    expect(isNoise).toBe(true);
  });

  it('passes noise check when range exceeds threshold and price expands away from VWAP', () => {
    const candles = generateMockCandles(96, 100, 2.0); // threshold = 2.50, 0.5*thresh = 1.25
    const engine = new NoiseBandEngine(candles);

    // Strong impulse candle: range = 4.0 (> 2.50), price is at 103.5 with VWAP at 100.0 (distance = 3.5 > 1.25)
    const impulseCandle: KlineCandle = {
      time: 1795132800,
      open: 100,
      high: 104.0,
      low: 100.0,
      close: 103.5,
      volume: 5000,
    };

    const isNoise = engine.isNoise(impulseCandle, 100.0, 103.5);
    expect(isNoise).toBe(false);
  });

  it('produces a comprehensive NoiseBandSnapshot telemetry payload', () => {
    const candles = generateMockCandles(96, 100, 2.0);
    const engine = new NoiseBandEngine(candles);

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
    expect(snapshot.noiseThreshold).toBeCloseTo(2.5, 2);
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
});
