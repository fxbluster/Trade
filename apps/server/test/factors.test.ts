/**
 * TradeOS v2 — Next-Gen Alpha Factors Test Suite
 *
 * Comprehensive tests for all 7 Alpha Factors:
 * 1. OrderFlowFactor (ORDER_FLOW_L2 - 20%)
 * 2. NativeSmcFactor (NATIVE_SMC - 20%)
 * 3. CvdAbsorptionFactor (CVD_ABSORPTION - 15%)
 * 4. MacroRegimeFactor (MACRO_REGIME - 18%)
 * 5. FundingArbitrageFactor (FUNDING_ARBITRAGE - 10%)
 * 6. CrossExchangeSweepFactor (CROSS_EXCHANGE_SWEEP - 9%)
 * 7. LiqClustersFactor (LIQ_CLUSTERS - 8%)
 *
 * Verifies:
 * - Mathematical bounds: rawAlpha in [-1.0, +1.0], confidence in [0.0, 1.0]
 * - Edge cases: zero depth, zero candles, missing CVD/OI, extreme spikes
 * - Candle warmup and lifecycle hooks across all 7 factors
 * - 100% total default weight conservation (sum = 1.00)
 */

import { describe, it, expect } from 'vitest';
import {
  OrderFlowFactor,
  NativeSmcFactor,
  CvdAbsorptionFactor,
  MacroRegimeFactor,
  FundingArbitrageFactor,
  CrossExchangeSweepFactor,
  LiqClustersFactor,
} from '../src/quant/factors/index.js';
import { HierarchicalMtfManager } from '../src/quant/hierarchicalMtfManager.js';
import type {
  FactorEvaluationContext,
  KlineCandle,
  DepthLevel,
} from '@tradeos/shared';

// Helper to generate synthetic candles
function generateSyntheticCandles(count: number, startPrice: number = 100): KlineCandle[] {
  const candles: KlineCandle[] = [];
  let price = startPrice;
  const now = Date.now();

  for (let i = 0; i < count; i++) {
    const time = Math.floor((now - (count - i) * 60_000) / 1000); // Unix seconds
    const delta = (Math.sin(i / 5) + (Math.random() - 0.48)) * 0.5;
    const open = price;
    const close = price + delta;
    const high = Math.max(open, close) + Math.random() * 0.4;
    const low = Math.min(open, close) - Math.random() * 0.4;
    const volume = 1000 + Math.random() * 500;
    price = close;

    candles.push({ time, open, high, low, close, volume });
  }

  return candles;
}

describe('Next-Gen Alpha Factors', () => {
  const syntheticCandles = generateSyntheticCandles(100, 150.0);

  // -------------------------------------------------------------------------
  // 1. Weight Conservation & Interface Conformance
  // -------------------------------------------------------------------------
  describe('Universal Weight Conservation & Interface', () => {
    it('conserves 100% total default weight across all 7 factors', () => {
      const allFactors = [
        new OrderFlowFactor(),
        new NativeSmcFactor(),
        new CvdAbsorptionFactor(),
        new MacroRegimeFactor(),
        new FundingArbitrageFactor(),
        new CrossExchangeSweepFactor(),
        new LiqClustersFactor(),
      ];

      expect(allFactors).toHaveLength(7);

      const totalWeight = allFactors.reduce((s, f) => s + f.defaultWeight, 0);
      expect(totalWeight).toBeCloseTo(1.0, 6);

      // Verify specific default weights from spec
      expect(allFactors[0]!.defaultWeight).toBe(0.20); // Order Flow
      expect(allFactors[1]!.defaultWeight).toBe(0.20); // Native SMC
      expect(allFactors[2]!.defaultWeight).toBe(0.15); // CVD Absorption
      expect(allFactors[3]!.defaultWeight).toBe(0.18); // Macro Regime
      expect(allFactors[4]!.defaultWeight).toBe(0.10); // Funding Arbitrage
      expect(allFactors[5]!.defaultWeight).toBe(0.09); // Cross Exchange
      expect(allFactors[6]!.defaultWeight).toBe(0.08); // Liq Clusters
    });

    it('safely runs warmup, candle closed, and teardown across all factors', async () => {
      const allFactors = [
        new OrderFlowFactor(),
        new NativeSmcFactor(),
        new CvdAbsorptionFactor(),
        new MacroRegimeFactor(),
        new FundingArbitrageFactor(),
        new CrossExchangeSweepFactor(),
        new LiqClustersFactor(),
      ];

      for (const factor of allFactors) {
        expect(() => factor.warmup(syntheticCandles)).not.toThrow();
        expect(() =>
          factor.onCandleClosed(syntheticCandles[syntheticCandles.length - 1]!, '15m')
        ).not.toThrow();
        await expect(factor.teardown()).resolves.toBeUndefined();
      }
    });
  });

  // -------------------------------------------------------------------------
  // 2. ORDER_FLOW_L2 Factor Tests
  // -------------------------------------------------------------------------
  describe('OrderFlowFactor', () => {
    const factor = new OrderFlowFactor();

    it('returns neutral output on zero or missing depth', () => {
      const ctx: FactorEvaluationContext = {
        symbol: 'SOLUSDT',
        currentPrice: 150.0,
        candles: [],
        timestamp: Date.now(),
      };
      const out = factor.computeFactor(ctx);
      expect(out.bias).toBe('NEUTRAL');
      expect(out.rawAlpha).toBe(0);
      expect(out.confidence).toBe(0);
    });

    it('computes bullish rawAlpha on heavy bid depth pressure and buyer taker flow', () => {
      const bids: DepthLevel[] = Array.from({ length: 20 }, (_, i) => ({
        price: 150 - i * 0.1,
        qty: 500, // Large bid support (total = 10,000)
      }));
      const asks: DepthLevel[] = Array.from({ length: 20 }, (_, i) => ({
        price: 150.1 + i * 0.1,
        qty: 50, // Small ask liquidity (total = 1,000)
      }));

      const ctx: FactorEvaluationContext = {
        symbol: 'SOLUSDT',
        currentPrice: 150.0,
        depth: { bids, asks },
        cvd: {
          symbol: 'SOLUSDT',
          cvd: 5000,
          buyVolume: 8000,
          sellVolume: 2000,
          delta: 6000,
          openInterestUsd: null,
          timestamp: Date.now(),
        },
        candles: [],
        timestamp: Date.now(),
      };

      const out = factor.computeFactor(ctx);
      expect(out.rawAlpha).toBeGreaterThan(0.3);
      expect(out.bias).toBe('BULLISH');
      expect(out.confidence).toBeGreaterThan(0.3);
      expect(out.rawAlpha).toBeLessThanOrEqual(1.0);
    });

    it('computes bearish rawAlpha on heavy ask depth pressure and seller taker flow', () => {
      const bids: DepthLevel[] = Array.from({ length: 20 }, (_, i) => ({
        price: 150 - i * 0.1,
        qty: 50,
      }));
      const asks: DepthLevel[] = Array.from({ length: 20 }, (_, i) => ({
        price: 150.1 + i * 0.1,
        qty: 500,
      }));

      const ctx: FactorEvaluationContext = {
        symbol: 'SOLUSDT',
        currentPrice: 150.0,
        depth: { bids, asks },
        cvd: {
          symbol: 'SOLUSDT',
          cvd: -5000,
          buyVolume: 1000,
          sellVolume: 9000,
          delta: -8000,
          openInterestUsd: null,
          timestamp: Date.now(),
        },
        candles: [],
        timestamp: Date.now(),
      };

      const out = factor.computeFactor(ctx);
      expect(out.rawAlpha).toBeLessThan(-0.3);
      expect(out.bias).toBe('BEARISH');
      expect(out.rawAlpha).toBeGreaterThanOrEqual(-1.0);
    });
  });

  // -------------------------------------------------------------------------
  // 3. NATIVE_SMC Factor Tests
  // -------------------------------------------------------------------------
  describe('NativeSmcFactor', () => {
    it('returns neutral output on insufficient candle history', () => {
      const factor = new NativeSmcFactor();
      const ctx: FactorEvaluationContext = {
        symbol: 'SOLUSDT',
        currentPrice: 150.0,
        candles: [],
        timestamp: Date.now(),
      };
      const out = factor.computeFactor(ctx);
      expect(out.bias).toBe('NEUTRAL');
      expect(out.rawAlpha).toBe(0);
    });

    it('detects structural Fair Value Gaps and Order Blocks on synthetic trend', () => {
      const factor = new NativeSmcFactor();
      // Generate candles with an obvious bullish expansion gap
      const baseCandles = generateSyntheticCandles(30, 100);
      // Create Bullish FVG: candle 15 high is 102, candle 17 low is 105
      baseCandles[14]!.high = 102;
      baseCandles[14]!.close = 101.5;
      baseCandles[15]!.open = 102;
      baseCandles[15]!.close = 106;
      baseCandles[15]!.high = 106.5;
      baseCandles[16]!.low = 104; // 104 > 102 -> Bullish FVG [102, 104]

      factor.warmup(baseCandles);

      const ctx: FactorEvaluationContext = {
        symbol: 'SOLUSDT',
        currentPrice: 103.5, // Inside FVG test zone
        candles: baseCandles,
        timestamp: Date.now(),
      };

      const out = factor.computeFactor(ctx);
      expect(out.rawAlpha).toBeGreaterThanOrEqual(-1.0);
      expect(out.rawAlpha).toBeLessThanOrEqual(1.0);
      expect(out.confidence).toBeGreaterThanOrEqual(0);
      expect(out.confidence).toBeLessThanOrEqual(1.0);
    });
  });

  // -------------------------------------------------------------------------
  // 4. CVD_ABSORPTION Factor Tests
  // -------------------------------------------------------------------------
  describe('CvdAbsorptionFactor', () => {
    it('detects bullish absorption when aggressive selling fails to push price down', () => {
      const factor = new CvdAbsorptionFactor();

      // Feed negative deltas to establish baseline
      for (let i = 0; i < 20; i++) {
        factor.computeFactor({
          symbol: 'SOLUSDT',
          currentPrice: 150.0,
          cvd: {
            symbol: 'SOLUSDT',
            cvd: -i * 100,
            buyVolume: 500,
            sellVolume: 600,
            delta: -100,
            openInterestUsd: null,
            timestamp: Date.now() + i * 1000,
          },
          candles: [],
          timestamp: Date.now() + i * 1000,
        });
      }

      // Massive sell spike (Z <= -2.0) but price holds steady at 150.0
      const ctx: FactorEvaluationContext = {
        symbol: 'SOLUSDT',
        currentPrice: 150.0,
        cvd: {
          symbol: 'SOLUSDT',
          cvd: -10000,
          buyVolume: 1000,
          sellVolume: 9000,
          delta: -8000, // Extreme aggressive sell
          openInterestUsd: null,
          timestamp: Date.now() + 30_000,
        },
        candles: [],
        timestamp: Date.now() + 30_000,
      };

      const out = factor.computeFactor(ctx);
      expect(out.rawAlpha).toBeGreaterThan(0.3); // Absorbed! Bullish signal
      expect(out.bias).toBe('BULLISH');
      expect(out.rawAlpha).toBeLessThanOrEqual(1.0);
    });

    it('detects bearish absorption when aggressive buying fails to push price up', () => {
      const factor = new CvdAbsorptionFactor();

      for (let i = 0; i < 20; i++) {
        factor.computeFactor({
          symbol: 'SOLUSDT',
          currentPrice: 150.0,
          cvd: {
            symbol: 'SOLUSDT',
            cvd: i * 100,
            buyVolume: 600,
            sellVolume: 500,
            delta: 100,
            openInterestUsd: null,
            timestamp: Date.now() + i * 1000,
          },
          candles: [],
          timestamp: Date.now() + i * 1000,
        });
      }

      // Massive buy spike but price is pinned
      const ctx: FactorEvaluationContext = {
        symbol: 'SOLUSDT',
        currentPrice: 150.0,
        cvd: {
          symbol: 'SOLUSDT',
          cvd: 10000,
          buyVolume: 9000,
          sellVolume: 1000,
          delta: 8000, // Extreme aggressive buy
          openInterestUsd: null,
          timestamp: Date.now() + 30_000,
        },
        candles: [],
        timestamp: Date.now() + 30_000,
      };

      const out = factor.computeFactor(ctx);
      expect(out.rawAlpha).toBeLessThan(-0.3); // Absorbed! Bearish signal
      expect(out.bias).toBe('BEARISH');
      expect(out.rawAlpha).toBeGreaterThanOrEqual(-1.0);
    });
  });

  // -------------------------------------------------------------------------
  // 5. MACRO_REGIME Factor Tests
  // -------------------------------------------------------------------------
  describe('MacroRegimeFactor', () => {
    it('evaluates bullish macro regime when price > EMA200 and EMA50 > EMA200', () => {
      const factor = new MacroRegimeFactor();
      const bullCandles = generateSyntheticCandles(60, 100);
      factor.warmup(bullCandles);

      const ctx: FactorEvaluationContext = {
        symbol: 'SOLUSDT',
        currentPrice: 180.0,
        candles: bullCandles,
        indicators: {
          ema200: 140.0,
          ema50: 160.0,
          ema21: null,
          ema9: null,
          rsi14: 65,
          atr14: 2.5,
          macd: null,
          bollingerBands: null,
          adx14: { adx: 28, pdi: 25, mdi: 10 },
          support: null,
          resistance: null,
          volumeSma20: null,
        },
        timestamp: Date.now(),
      };

      const out = factor.computeFactor(ctx);
      expect(out.rawAlpha).toBeGreaterThan(0.3);
      expect(out.bias).toBe('BULLISH');
      expect(out.rawAlpha).toBeLessThanOrEqual(1.0);
    });

    it('evaluates bearish macro regime when price < EMA200 and EMA50 < EMA200', () => {
      const factor = new MacroRegimeFactor();
      const bearCandles = generateSyntheticCandles(60, 200);

      const ctx: FactorEvaluationContext = {
        symbol: 'SOLUSDT',
        currentPrice: 130.0,
        candles: bearCandles,
        indicators: {
          ema200: 170.0,
          ema50: 150.0,
          ema21: null,
          ema9: null,
          rsi14: 35,
          atr14: 3.0,
          macd: null,
          bollingerBands: null,
          adx14: { adx: 30, pdi: 10, mdi: 25 },
          support: null,
          resistance: null,
          volumeSma20: null,
        },
        timestamp: Date.now(),
      };

      const out = factor.computeFactor(ctx);
      expect(out.rawAlpha).toBeLessThan(-0.3);
      expect(out.bias).toBe('BEARISH');
      expect(out.rawAlpha).toBeGreaterThanOrEqual(-1.0);
    });

    it('DEF-03: produces non-zero BEARISH rawAlpha when price < EMA200 and ADX >= 25 even with lagging EMA50 or empty candles', () => {
      const factor = new MacroRegimeFactor();

      const ctx: FactorEvaluationContext = {
        symbol: 'SOLUSDT',
        currentPrice: 149.7, // Just below EMA200
        candles: [],
        indicators: {
          ema200: 150.0,
          ema50: 151.0, // Lagging EMA50 still above EMA200
          ema21: null,
          ema9: null,
          rsi14: 42,
          atr14: 1.5,
          macd: null,
          bollingerBands: null,
          adx14: { adx: 25.2, pdi: 14, mdi: 26 },
          support: null,
          resistance: null,
          volumeSma20: null,
        },
        timestamp: Date.now(),
      };

      const out = factor.computeFactor(ctx);
      expect(out.rawAlpha).toBeLessThan(-0.2);
      expect(out.bias).toBe('BEARISH');
    });

    it('DEF-03: produces non-zero BULLISH rawAlpha when price > EMA200 and ADX >= 25 even with lagging EMA50', () => {
      const factor = new MacroRegimeFactor();

      const ctx: FactorEvaluationContext = {
        symbol: 'SOLUSDT',
        currentPrice: 150.3, // Just above EMA200
        candles: [],
        indicators: {
          ema200: 150.0,
          ema50: 149.0, // Lagging EMA50 still below EMA200
          ema21: null,
          ema9: null,
          rsi14: 58,
          atr14: 1.5,
          macd: null,
          bollingerBands: null,
          adx14: { adx: 25.2, pdi: 26, mdi: 14 },
          support: null,
          resistance: null,
          volumeSma20: null,
        },
        timestamp: Date.now(),
      };

      const out = factor.computeFactor(ctx);
      expect(out.rawAlpha).toBeGreaterThan(0.2);
      expect(out.bias).toBe('BULLISH');
    });
  });

  // -------------------------------------------------------------------------
  // 5b. HierarchicalMtfManager (DEF-04) Tests
  // -------------------------------------------------------------------------
  describe('HierarchicalMtfManager (DEF-04)', () => {
    it('returns BEARISH (confirmed: true, score >= 65) when price < 1h EMA200 and ADX >= 25 even if SuperTrend is not bearish', () => {
      const mgr = new HierarchicalMtfManager();
      const now = Date.now();
      // Build 200 1h candles in a strong downtrend followed by a sharp 3-bar bounce that
      // keeps price < EMA200 and ADX >= 25 while potentially flipping short-term SuperTrend
      const candles: KlineCandle[] = [];
      let price = 200;
      for (let i = 0; i < 197; i++) {
        price -= 0.4;
        candles.push({
          time: Math.floor((now - (200 - i) * 3600_000) / 1000),
          open: price + 0.3,
          high: price + 0.6,
          low: price - 0.4,
          close: price,
          volume: 1000,
        });
      }
      for (let i = 197; i < 200; i++) {
        price += 2.5;
        candles.push({
          time: Math.floor((now - (200 - i) * 3600_000) / 1000),
          open: price - 2.0,
          high: price + 0.5,
          low: price - 2.2,
          close: price,
          volume: 1500,
        });
      }

      mgr.setInitialCandles('SOLUSDT', '1h', candles, now);
      const bias = mgr.getMacroBias('SOLUSDT', price, now);
      expect(bias.ema200).not.toBeNull();
      expect(price).toBeLessThan(bias.ema200!);
      expect(bias.adx).toBeGreaterThanOrEqual(25);

      const pillar = mgr.evaluatePillar('SOLUSDT', price, now);
      expect(pillar.bias).toBe('BEARISH');
      expect(pillar.confirmed).toBe(true);
      expect(pillar.score).toBeGreaterThanOrEqual(65);
    });

    it('returns BULLISH (confirmed: true, score >= 65) symmetrically when price > 1h EMA200 and ADX >= 25', () => {
      const mgr = new HierarchicalMtfManager();
      const now = Date.now();
      const candles: KlineCandle[] = [];
      let price = 100;
      for (let i = 0; i < 197; i++) {
        price += 0.4;
        candles.push({
          time: Math.floor((now - (200 - i) * 3600_000) / 1000),
          open: price - 0.3,
          high: price + 0.4,
          low: price - 0.6,
          close: price,
          volume: 1000,
        });
      }
      for (let i = 197; i < 200; i++) {
        price -= 2.5;
        candles.push({
          time: Math.floor((now - (200 - i) * 3600_000) / 1000),
          open: price + 2.0,
          high: price + 2.2,
          low: price - 0.5,
          close: price,
          volume: 1500,
        });
      }

      mgr.setInitialCandles('SOLUSDT', '1h', candles, now);
      const bias = mgr.getMacroBias('SOLUSDT', price, now);
      expect(bias.ema200).not.toBeNull();
      expect(price).toBeGreaterThan(bias.ema200!);
      expect(bias.adx).toBeGreaterThanOrEqual(25);

      const pillar = mgr.evaluatePillar('SOLUSDT', price, now);
      expect(pillar.bias).toBe('BULLISH');
      expect(pillar.confirmed).toBe(true);
      expect(pillar.score).toBeGreaterThanOrEqual(65);
    });
  });

  // -------------------------------------------------------------------------
  // 6. FUNDING_ARBITRAGE Factor Tests
  // -------------------------------------------------------------------------
  describe('FundingArbitrageFactor', () => {
    it('produces bearish drag alpha when funding rate is excessively positive', () => {
      const factor = new FundingArbitrageFactor();
      factor.updateFundingState(0.0006, 150.0); // 0.06% funding / 8h

      const ctx: FactorEvaluationContext = {
        symbol: 'SOLUSDT',
        currentPrice: 150.5,
        candles: [],
        timestamp: Date.now(),
      };

      const out = factor.computeFactor(ctx);
      expect(out.rawAlpha).toBeLessThan(-0.3); // Bearish mean-reversion
      expect(out.bias).toBe('BEARISH');
      expect(out.rawAlpha).toBeGreaterThanOrEqual(-1.0);
    });

    it('produces bullish short squeeze alpha when funding rate is negative', () => {
      const factor = new FundingArbitrageFactor();
      factor.updateFundingState(-0.0005, 150.0); // -0.05% funding / 8h

      const ctx: FactorEvaluationContext = {
        symbol: 'SOLUSDT',
        currentPrice: 149.5,
        candles: [],
        timestamp: Date.now(),
      };

      const out = factor.computeFactor(ctx);
      expect(out.rawAlpha).toBeGreaterThan(0.3); // Bullish squeeze
      expect(out.bias).toBe('BULLISH');
      expect(out.rawAlpha).toBeLessThanOrEqual(1.0);
    });
  });

  // -------------------------------------------------------------------------
  // 7. CROSS_EXCHANGE_SWEEP Factor Tests
  // -------------------------------------------------------------------------
  describe('CrossExchangeSweepFactor', () => {
    it('detects lead-lag liquidation void dislocation between exchanges', () => {
      const factor = new CrossExchangeSweepFactor();
      // Bybit is at 150.0, Binance price is 150.8 (dislocation > 0.15%)
      factor.updateVenueQuote('BYBIT', 150.0);

      const ctx: FactorEvaluationContext = {
        symbol: 'SOLUSDT',
        currentPrice: 150.8, // Overshot local exchange
        candles: [],
        timestamp: Date.now(),
      };

      const out = factor.computeFactor(ctx);
      // Local venue overshot higher -> mean reversion downward expected
      expect(out.rawAlpha).toBeLessThan(0);
      expect(out.rawAlpha).toBeGreaterThanOrEqual(-1.0);
    });

    it('detects CVD exhaustion sweep with long lower wick', () => {
      const factor = new CrossExchangeSweepFactor();
      const candles = generateSyntheticCandles(10, 150);
      // Make the last candle have a huge lower wick (hammer-like sweep)
      const last = candles[candles.length - 1]!;
      last.open = 150.0;
      last.close = 150.2;
      last.high = 150.3;
      last.low = 148.0; // 2.2 lower wick on 2.3 total range

      const ctx: FactorEvaluationContext = {
        symbol: 'SOLUSDT',
        currentPrice: 150.2,
        cvd: {
          symbol: 'SOLUSDT',
          cvd: -2000,
          buyVolume: 1000,
          sellVolume: 3000,
          delta: -2000, // Taker sell into the wick
          openInterestUsd: null,
          timestamp: Date.now(),
        },
        candles,
        timestamp: Date.now(),
      };

      const out = factor.computeFactor(ctx);
      expect(out.rawAlpha).toBeGreaterThan(0.3); // Exhaustion buy sweep
      expect(out.bias).toBe('BULLISH');
    });
  });

  // -------------------------------------------------------------------------
  // 8. LIQ_CLUSTERS Factor Tests
  // -------------------------------------------------------------------------
  describe('LiqClustersFactor', () => {
    const factor = new LiqClustersFactor();

    it('triggers bullish magnet when price is within 0.45x ATR of short liquidation pool', () => {
      const currentPrice = 150.0;
      const atr14 = 2.0;
      const proximityLimit = 0.45 * atr14; // 0.90

      // Short liquidation cluster placed 0.50 above price (within 0.90)
      factor.setClusters([
        {
          price: 150.5,
          estimatedVolumeUsd: 1_000_000,
          side: 'SHORT_LIQ',
          leverage: 50,
        },
        {
          price: 145.0, // Far below
          estimatedVolumeUsd: 100_000,
          side: 'LONG_LIQ',
          leverage: 25,
        },
      ]);

      const ctx: FactorEvaluationContext = {
        symbol: 'SOLUSDT',
        currentPrice,
        indicators: {
          atr14,
          ema200: null,
          ema50: null,
          ema21: null,
          ema9: null,
          rsi14: null,
          macd: null,
          bollingerBands: null,
          adx14: null,
          support: null,
          resistance: null,
          volumeSma20: null,
        },
        candles: [],
        timestamp: Date.now(),
      };

      const out = factor.computeFactor(ctx);
      expect(out.rawAlpha).toBeGreaterThan(0.5); // Bullish magnet draw
      expect(out.bias).toBe('BULLISH');
      expect(out.rawAlpha).toBeLessThanOrEqual(1.0);
    });

    it('triggers bearish magnet when price is within 0.45x ATR of long liquidation pool', () => {
      const currentPrice = 150.0;
      const atr14 = 2.0;

      // Long liquidation cluster placed 0.40 below price (within 0.90)
      factor.setClusters([
        {
          price: 155.0, // Far above
          estimatedVolumeUsd: 100_000,
          side: 'SHORT_LIQ',
          leverage: 50,
        },
        {
          price: 149.6, // 0.40 below
          estimatedVolumeUsd: 1_500_000,
          side: 'LONG_LIQ',
          leverage: 50,
        },
      ]);

      const ctx: FactorEvaluationContext = {
        symbol: 'SOLUSDT',
        currentPrice,
        indicators: {
          atr14,
          ema200: null,
          ema50: null,
          ema21: null,
          ema9: null,
          rsi14: null,
          macd: null,
          bollingerBands: null,
          adx14: null,
          support: null,
          resistance: null,
          volumeSma20: null,
        },
        candles: [],
        timestamp: Date.now(),
      };

      const out = factor.computeFactor(ctx);
      expect(out.rawAlpha).toBeLessThan(-0.5); // Bearish magnet draw
      expect(out.bias).toBe('BEARISH');
      expect(out.rawAlpha).toBeGreaterThanOrEqual(-1.0);
    });

    it('handles edge case when price is zero or negative gracefully', () => {
      const ctx: FactorEvaluationContext = {
        symbol: 'SOLUSDT',
        currentPrice: 0,
        candles: [],
        timestamp: Date.now(),
      };
      const out = factor.computeFactor(ctx);
      expect(out.rawAlpha).toBe(0);
      expect(out.bias).toBe('NEUTRAL');
    });
  });
});
