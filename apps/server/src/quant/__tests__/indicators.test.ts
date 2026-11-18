import { describe, it, expect } from 'vitest';
import {
  calculateEMA,
  calculateRSI,
  calculateATR,
  calculateMACD,
  calculateBollingerBands,
  calculateADX,
  findSupportResistance,
  calculateVolumeSMA,
  calculateIndicators,
} from '../indicators.js';
import type { KlineCandle } from '@tradeos/shared';

describe('TradeOS v2 — Technical Indicators Engine', () => {
  // Generate dummy candle list
  function generateCandles(count: number, basePrice: number = 100, trend: number = 0.5): KlineCandle[] {
    const candles: KlineCandle[] = [];
    let price = basePrice;
    for (let i = 0; i < count; i++) {
      const open = price;
      price += trend;
      const high = price + 1.0;
      const low = open - 1.0;
      const close = price;
      candles.push({
        time: 1700000000 + i * 60,
        open,
        high,
        low,
        close,
        volume: 100 + i * 10,
      });
    }
    return candles;
  }

  describe('calculateEMA', () => {
    it('returns null when prices array has fewer elements than period', () => {
      expect(calculateEMA([10, 11, 12], 9)).toBeNull();
      expect(calculateEMA([], 9)).toBeNull();
    });

    it('calculates correct EMA with period 9 and formats to tickSize', () => {
      const prices = [10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20];
      const ema = calculateEMA(prices, 9, 0.01);
      expect(ema).not.toBeNull();
      expect(typeof ema).toBe('number');
      // Price is trending up, so EMA should be between SMA and latest price
      expect(ema!).toBeGreaterThan(14);
      expect(ema!).toBeLessThan(20);
    });
  });

  describe('calculateRSI', () => {
    it('returns null when insufficient prices (< period + 1)', () => {
      expect(calculateRSI([10, 11, 12], 14)).toBeNull();
    });

    it('returns 100 for strictly monotonic upward prices', () => {
      const prices: number[] = [];
      for (let i = 0; i < 20; i++) prices.push(100 + i * 2);
      expect(calculateRSI(prices, 14)).toBe(100);
    });

    it('returns 0 for strictly monotonic downward prices', () => {
      const prices: number[] = [];
      for (let i = 0; i < 20; i++) prices.push(100 - i * 2);
      expect(calculateRSI(prices, 14)).toBe(0);
    });

    it('returns 50 for completely flat prices', () => {
      const prices = new Array(25).fill(100);
      expect(calculateRSI(prices, 14)).toBe(50);
    });

    it('calculates realistic oscillation RSI', () => {
      const prices = [10, 12, 11, 13, 12, 14, 13, 15, 14, 16, 15, 17, 16, 18, 17, 19, 18];
      const rsi = calculateRSI(prices, 14);
      expect(rsi).not.toBeNull();
      expect(rsi!).toBeGreaterThan(50);
      expect(rsi!).toBeLessThan(100);
    });
  });

  describe('calculateATR', () => {
    it('returns null when insufficient candles (< period + 1)', () => {
      const candles = generateCandles(10);
      expect(calculateATR(candles, 14)).toBeNull();
    });

    it('calculates average true range correctly across candles', () => {
      const candles = generateCandles(30, 100, 0); // Flat trend, high-low is always 2.0
      const atr = calculateATR(candles, 14, 0.01);
      expect(atr).not.toBeNull();
      expect(atr).toBe(2.0);
    });
  });

  describe('calculateMACD', () => {
    it('returns null when prices length < slow + signal (26 + 9 = 35)', () => {
      const prices = new Array(30).fill(100);
      expect(calculateMACD(prices, 12, 26, 9)).toBeNull();
    });

    it('calculates macd, signal, and histogram for sufficient data', () => {
      const candles = generateCandles(50, 100, 1);
      const closes = candles.map((c) => c.close);
      const macd = calculateMACD(closes, 12, 26, 9);
      expect(macd).not.toBeNull();
      expect(macd).toHaveProperty('macd');
      expect(macd).toHaveProperty('signal');
      expect(macd).toHaveProperty('histogram');
      expect(typeof macd!.macd).toBe('number');
      expect(typeof macd!.signal).toBe('number');
      expect(typeof macd!.histogram).toBe('number');
    });
  });

  describe('calculateBollingerBands', () => {
    it('returns null when prices length < period', () => {
      expect(calculateBollingerBands([10, 20, 30], 20)).toBeNull();
    });

    it('calculates upper, middle, and lower bands correctly', () => {
      const prices = new Array(20).fill(100);
      // Zero variance
      const bb = calculateBollingerBands(prices, 20, 2, 0.01);
      expect(bb).not.toBeNull();
      expect(bb!.middle).toBe(100);
      expect(bb!.upper).toBe(100);
      expect(bb!.lower).toBe(100);

      // Varying prices
      const trending = generateCandles(30, 100, 1).map((c) => c.close);
      const bbTrend = calculateBollingerBands(trending, 20, 2, 0.01);
      expect(bbTrend).not.toBeNull();
      expect(bbTrend!.upper).toBeGreaterThan(bbTrend!.middle);
      expect(bbTrend!.middle).toBeGreaterThan(bbTrend!.lower);
    });
  });

  describe('calculateADX', () => {
    it('returns null when candle count < period * 2 (28)', () => {
      const candles = generateCandles(20);
      expect(calculateADX(candles, 14)).toBeNull();
    });

    it('calculates adx, pdi, and mdi for trending market', () => {
      const candles = generateCandles(40, 100, 2.0); // Strong uptrend
      const adx = calculateADX(candles, 14);
      expect(adx).not.toBeNull();
      expect(adx!.pdi).toBeGreaterThan(adx!.mdi);
      expect(adx!.adx).toBeGreaterThan(0);
    });
  });

  describe('findSupportResistance', () => {
    it('returns nulls for empty candles', () => {
      const sr = findSupportResistance([]);
      expect(sr.support).toBeNull();
      expect(sr.resistance).toBeNull();
    });

    it('identifies highest high and lowest low within lookback', () => {
      const candles = generateCandles(30, 100, 1);
      const sr = findSupportResistance(candles, 30, 0.01);
      expect(sr.support).not.toBeNull();
      expect(sr.resistance).not.toBeNull();
      expect(sr.resistance!).toBeGreaterThan(sr.support!);
    });
  });

  describe('calculateVolumeSMA', () => {
    it('returns null when candles < 20', () => {
      const candles = generateCandles(15);
      expect(calculateVolumeSMA(candles, 20)).toBeNull();
    });

    it('computes 20-period volume average correctly', () => {
      const candles = generateCandles(25, 100, 0); // volume starts at 100 + i*10
      const volSma = calculateVolumeSMA(candles, 20);
      expect(volSma).not.toBeNull();
      expect(volSma!).toBeGreaterThan(100);
    });
  });

  describe('calculateIndicators', () => {
    it('returns all nulls on empty candle array (Zero Mock Policy)', () => {
      const summary = calculateIndicators([]);
      expect(summary.ema9).toBeNull();
      expect(summary.ema21).toBeNull();
      expect(summary.ema50).toBeNull();
      expect(summary.ema200).toBeNull();
      expect(summary.rsi14).toBeNull();
      expect(summary.atr14).toBeNull();
      expect(summary.macd).toBeNull();
      expect(summary.bollingerBands).toBeNull();
      expect(summary.adx14).toBeNull();
      expect(summary.support).toBeNull();
      expect(summary.resistance).toBeNull();
      expect(summary.volumeSma20).toBeNull();
    });

    it('calculates full TechnicalSummary when sufficient candles exist', () => {
      const candles = generateCandles(210, 100, 0.5);
      const summary = calculateIndicators(candles, 0.01);
      expect(summary.ema9).not.toBeNull();
      expect(summary.ema21).not.toBeNull();
      expect(summary.ema50).not.toBeNull();
      expect(summary.ema200).not.toBeNull();
      expect(summary.rsi14).not.toBeNull();
      expect(summary.atr14).not.toBeNull();
      expect(summary.macd).not.toBeNull();
      expect(summary.bollingerBands).not.toBeNull();
      expect(summary.adx14).not.toBeNull();
      expect(summary.support).not.toBeNull();
      expect(summary.resistance).not.toBeNull();
      expect(summary.volumeSma20).not.toBeNull();
    });
  });
});
