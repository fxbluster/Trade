/**
 * Unit tests for DEF-04, DEF-05 / ARCH-03, and ARCH-04 fixes:
 * - Low-price (<$1) ATR precision and percentage/bps normalization in Indicators, LiquidationEngine, LiqClustersFactor, PillarAttributionService
 * - MacroRegimeFactor 1h candle preference over 1m indicators
 * - FundingArbitrageFactor & CrossExchangeSweepFactor dead-factor guards
 * - NoiseBandEngine 0.65x default MTR multiplier and runtime configurability
 */

import { describe, it, expect } from 'vitest';
import type { KlineCandle } from '@tradeos/shared';
import { calculateIndicators, calculateATR } from '../src/quant/indicators.js';
import { LiquidationEngine } from '../src/quant/liquidationEngine.js';
import { LiqClustersFactor } from '../src/quant/factors/liqClustersFactor.js';
import { MacroRegimeFactor } from '../src/quant/factors/macroRegimeFactor.js';
import { FundingArbitrageFactor } from '../src/quant/factors/fundingArbitrageFactor.js';
import { CrossExchangeSweepFactor } from '../src/quant/factors/crossExchangeSweepFactor.js';
import {
  NoiseBandEngine,
  DEFAULT_NOISE_BAND_MULTIPLIER,
} from '../src/quant/noiseBandEngine.js';
import { PillarAttributionService } from '../src/services/pillarAttributionService.js';
import { initializeDatabase } from '../src/db/sqlite.js';

function makeLowPriceCandles(count: number, basePrice = 0.52, stepRange = 0.0018): KlineCandle[] {
  const candles: KlineCandle[] = [];
  const startSec = Math.floor(Date.now() / 1000) - count * 60;
  for (let i = 0; i < count; i++) {
    const close = basePrice + Math.sin(i * 0.2) * 0.002;
    candles.push({
      time: startSec + i * 60,
      open: close - stepRange * 0.2,
      high: close + stepRange * 0.5,
      low: close - stepRange * 0.5,
      close,
      volume: 100_000,
    });
  }
  return candles;
}

describe('DEF-05 / ARCH-03: Low-price (<$1) ATR & bps normalization', () => {
  it('preserves sub-cent atr14 in calculateATR and calculateIndicators even when caller passes 0.01 tickSize', () => {
    const candles = makeLowPriceCandles(40, 0.52, 0.0018);
    const atr = calculateATR(candles, 14, 0.01);
    expect(atr).not.toBeNull();
    expect(atr!).toBeGreaterThan(0);

    const ind = calculateIndicators(candles, 0.01);
    expect(ind.atr14).not.toBeNull();
    expect(ind.atr14!).toBeGreaterThan(0);
    expect(ind.ema9).not.toBeNull();
    expect(ind.ema9!).toBeGreaterThan(0.5);
    expect(ind.ema9!).toBeLessThan(0.55);
  });

  it('evaluates LiquidationEngine and LiqClustersFactor on <$1 assets using percentage/bps scaling', () => {
    const engine = new LiquidationEngine();
    const price = 0.52;
    const atr14 = 0.012; // ~2.3% ATR so 1% 100x cluster is within 0.45x ATR

    const evalRes = engine.evaluate({
      currentPrice: price,
      atr14,
      recentHigh: 0.524,
      recentLow: 0.517,
      openInterestUsd: 50_000_000,
      pillarId: 'LIQ_CLUSTERS',
      triggerAtrMultiplier: 0.45,
    });

    expect(evalRes.subText).not.toContain('Insufficient ATR');
    expect(evalRes.confirmed).toBe(true);
    expect(evalRes.bias).not.toBe('NEUTRAL');

    const factor = new LiqClustersFactor(engine);
    factor.setClusters([
      { side: 'SHORT_LIQ', price: 0.522, leverage: 100, estimatedVolumeUsd: 1_000_000 },
    ]);
    const factorOut = factor.computeFactor({
      symbol: 'XRPUSDT',
      currentPrice: price,
      candles: [],
      indicators: {
        ema9: null,
        ema21: null,
        ema50: null,
        ema200: null,
        rsi14: null,
        atr14,
        macd: null,
        bollingerBands: null,
        adx14: null,
        support: null,
        resistance: null,
        volumeSma20: null,
      },
      cvd: {
        symbol: 'XRPUSDT',
        cvd: 0,
        buyVolume: 100,
        sellVolume: 100,
        delta: 0,
        openInterestUsd: 50_000_000,
        timestamp: Date.now(),
      },
      timestamp: Date.now(),
    });

    expect(factorOut.bias).not.toBe('NEUTRAL');
    expect(Math.abs(factorOut.rawAlpha)).toBeGreaterThan(0.1);
  });

  it('guards PillarAttributionService against zero ATR on <$1 assets', () => {
    const db = initializeDatabase(':memory:');
    const svc = new PillarAttributionService(db, { flushIntervalMs: 0 });
    const candle = makeLowPriceCandles(1, 0.52, 0.002)[0]!;

    svc.evaluateTick(
      'XRPUSDT',
      0.52,
      0, // simulate missing/zero ATR
      {
        symbol: 'XRPUSDT',
        pillars: [
          {
            id: 'MACRO_REGIME',
            title: 'Macro',
            score: 80,
            bias: 'BULLISH',
            valueText: 'Bullish',
            subText: 'Test',
            confirmed: true,
            updatedAt: Date.now(),
          },
        ],
        bullishCount: 1,
        bearishCount: 0,
        neutralCount: 6,
        consensusBias: 'BULLISH',
        consensusMet: false,
        threshold: 75,
        compositeScore: 65,
        recommendedAction: 'WAIT',
        macroVetoActive: false,
        macroRegime: 'MACRO_BULLISH',
        activeFvgs: [],
        activeOrderBlocks: [],
        latestSweep: null,
        blockReason: null,
        eventBlackoutActive: false,
        noiseBandActive: false,
      },
      candle
    );

    const ids = svc.flush();
    expect(ids.length).toBe(1);
    const saved = svc.getRepo().getById(ids[0]!);
    expect(saved).not.toBeNull();
    expect(saved!.atr_14).toBeGreaterThan(0);
    db.close();
  });
});

describe('DEF-04 & ARCH-04: MacroRegimeFactor 1h preference, Dead Factor Guards, and NoiseBandEngine', () => {
  it('prefers candles1h over 1m indicators in MacroRegimeFactor to avoid timeframe sign inversion', () => {
    const factor = new MacroRegimeFactor();
    const nowSec = Math.floor(Date.now() / 1000);
    // Downtrending 1h candles
    const candles1h: KlineCandle[] = Array.from({ length: 60 }, (_, i) => {
      const p = 200 - i * 1.5;
      return {
        time: nowSec - (60 - i) * 3600,
        open: p + 0.5,
        high: p + 1,
        low: p - 1,
        close: p,
        volume: 1000,
      };
    });

    const out = factor.computeFactor({
      symbol: 'SOLUSDT',
      currentPrice: 110,
      candles: [],
      candles1h,
      // Stale/opposite 1m indicators that would otherwise invert the sign
      indicators: {
        ema9: 109,
        ema21: 108,
        ema50: 105,
        ema200: 100, // price 110 > 1m ema200
        rsi14: 60,
        atr14: 0.5,
        macd: null,
        bollingerBands: null,
        adx14: { adx: 30, pdi: 30, mdi: 10 },
        support: null,
        resistance: null,
        volumeSma20: null,
      },
      timestamp: Date.now(),
    } as any);

    expect(out.bias).toBe('BEARISH');
    expect(out.rawAlpha).toBeLessThan(0);
  });

  it('marks unfed FundingArbitrageFactor and CrossExchangeSweepFactor as deadFactor with confidence 0', () => {
    const funding = new FundingArbitrageFactor();
    const fOut = funding.computeFactor({
      symbol: 'SOLUSDT',
      currentPrice: 150,
      candles: [],
      timestamp: Date.now(),
    });
    expect(fOut.rawAlpha).toBe(0);
    expect(fOut.confidence).toBe(0);
    expect(fOut.metadata?.deadFactor).toBe(true);

    const sweep = new CrossExchangeSweepFactor();
    const sOut = sweep.computeFactor({
      symbol: 'SOLUSDT',
      currentPrice: 150,
      candles: [],
      timestamp: Date.now(),
    });
    expect(sOut.rawAlpha).toBe(0);
    expect(sOut.confidence).toBe(0);
    expect(sOut.metadata?.deadFactor).toBe(true);
  });

  it('uses 0.65x default MTR multiplier in NoiseBandEngine and supports runtime configuration', () => {
    expect(DEFAULT_NOISE_BAND_MULTIPLIER).toBe(0.65);
    const candles = makeLowPriceCandles(30, 0.52, 0.002);
    const nb = new NoiseBandEngine(candles);
    expect(nb.getMultiplier()).toBe(0.65);

    const hour = new Date(candles[0]!.time * 1000).getUTCHours();
    const t65 = nb.getThreshold(hour);
    nb.setMultiplier(0.5);
    const t50 = nb.getThreshold(hour);
    expect(nb.getMultiplier()).toBe(0.5);
    expect(t50).toBeLessThan(t65);
  });
});
