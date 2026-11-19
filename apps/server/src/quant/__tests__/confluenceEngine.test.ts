import { describe, it, expect, beforeEach } from 'vitest';
import { LiquidationEngine } from '../liquidationEngine.js';
import { ConfluenceEngine } from '../confluenceEngine.js';
import type { TechnicalSummary, CvdSnapshot } from '@tradeos/shared';

describe('LiquidationEngine', () => {
  let engine: LiquidationEngine;

  beforeEach(() => {
    engine = new LiquidationEngine();
  });

  it('evaluates to BULLISH when short liquidation pool is within 1.0x ATR', () => {
    // Current price $100, ATR $5. Short pool at $103.50 (distance $3.50 = 0.7x ATR <= 1.0x)
    const result = engine.evaluate({
      currentPrice: 100,
      atr14: 5,
      clusters: [
        { price: 103.5, estimatedVolumeUsd: 5000000, side: 'SHORT_LIQ' },
        { price: 92.0, estimatedVolumeUsd: 1000000, side: 'LONG_LIQ' }, // distance $8 = 1.6x ATR
      ],
    });

    expect(result.id).toBe('LIQ_MAGNET');
    expect(result.bias).toBe('BULLISH');
    expect(result.confirmed).toBe(true);
    expect(result.valueText).toContain('Short Liq Magnet');
  });

  it('evaluates to BEARISH when long liquidation pool is within 1.0x ATR', () => {
    // Current price $100, ATR $4. Long pool at $97.00 (distance $3.00 = 0.75x ATR <= 1.0x)
    const result = engine.evaluate({
      currentPrice: 100,
      atr14: 4,
      clusters: [
        { price: 107.0, estimatedVolumeUsd: 1000000, side: 'SHORT_LIQ' }, // 1.75x ATR
        { price: 97.0, estimatedVolumeUsd: 4000000, side: 'LONG_LIQ' },   // 0.75x ATR
      ],
    });

    expect(result.bias).toBe('BEARISH');
    expect(result.confirmed).toBe(true);
    expect(result.valueText).toContain('Long Liq Magnet');
  });

  it('evaluates to NEUTRAL when nearest pool is beyond 1.0x ATR', () => {
    // Current price $100, ATR $2. Nearest pool is at $104 (2.0x ATR)
    const result = engine.evaluate({
      currentPrice: 100,
      atr14: 2,
      clusters: [
        { price: 104.0, estimatedVolumeUsd: 2000000, side: 'SHORT_LIQ' },
        { price: 95.0, estimatedVolumeUsd: 2000000, side: 'LONG_LIQ' },
      ],
    });

    expect(result.bias).toBe('NEUTRAL');
    expect(result.confirmed).toBe(false);
  });
});

describe('ConfluenceEngine (6+1 Confluence Matrix Aggregator)', () => {
  let engine: ConfluenceEngine;

  beforeEach(() => {
    engine = new ConfluenceEngine();
  });

  const createMockIndicators = (overrides: Partial<TechnicalSummary> = {}): TechnicalSummary => ({
    ema9: 105,
    ema21: 102,
    ema50: 98,
    ema200: 90,
    rsi14: 55,
    atr14: 2.5,
    macd: { macd: 1.5, signal: 1.0, histogram: 0.5 },
    bollingerBands: { upper: 110, middle: 100, lower: 90 },
    adx14: { adx: 28, pdi: 24, mdi: 12 },
    support: 95,
    resistance: 110,
    volumeSma20: 10000,
    ...overrides,
  });

  const createMockCvd = (overrides: Partial<CvdSnapshot> = {}): CvdSnapshot => ({
    symbol: 'SOLUSDT',
    cvd: 5000,
    buyVolume: 8000,
    sellVolume: 3000,
    delta: 5000,
    openInterestUsd: 150000000,
    timestamp: Date.now(),
    ...overrides,
  });

  it('evaluates MTF_TREND correctly based on EMA stack and ADX', () => {
    // Bullish stack: Price > EMA200 & EMA9 > EMA21 & ADX > 22
    const bullData = {
      symbol: 'SOLUSDT',
      currentPrice: 108,
      indicators: createMockIndicators(),
      cvd: null,
    };
    const snapBull = engine.evaluate(bullData);
    const p1 = snapBull.pillars.find(p => p.id === 'MTF_TREND')!;
    expect(p1.bias).toBe('BULLISH');
    expect(p1.confirmed).toBe(true);

    // Bearish stack: Price < EMA200 & EMA9 < EMA21 & ADX > 22
    const bearData = {
      symbol: 'SOLUSDT',
      currentPrice: 85,
      indicators: createMockIndicators({
        ema9: 86,
        ema21: 89,
        ema200: 100,
        adx14: { adx: 30, pdi: 10, mdi: 28 },
      }),
      cvd: null,
    };
    const snapBear = engine.evaluate(bearData);
    const p1Bear = snapBear.pillars.find(p => p.id === 'MTF_TREND')!;
    expect(p1Bear.bias).toBe('BEARISH');
    expect(p1Bear.confirmed).toBe(true);
  });

  it('evaluates MOMENTUM correctly based on RSI and MACD Histogram', () => {
    // Sweet spot RSI 55 + positive MACD hist -> Bullish
    const bullData = {
      symbol: 'SOLUSDT',
      currentPrice: 100,
      indicators: createMockIndicators({ rsi14: 55, macd: { macd: 1, signal: 0.5, histogram: 0.5 } }),
      cvd: null,
    };
    const snapBull = engine.evaluate(bullData);
    const p2 = snapBull.pillars.find(p => p.id === 'MOMENTUM')!;
    expect(p2.bias).toBe('BULLISH');
    expect(p2.confirmed).toBe(true);

    // Sweet spot RSI 45 + negative MACD hist -> Bearish
    const bearData = {
      symbol: 'SOLUSDT',
      currentPrice: 100,
      indicators: createMockIndicators({ rsi14: 45, macd: { macd: -1, signal: -0.5, histogram: -0.5 } }),
      cvd: null,
    };
    const snapBear = engine.evaluate(bearData);
    const p2Bear = snapBear.pillars.find(p => p.id === 'MOMENTUM')!;
    expect(p2Bear.bias).toBe('BEARISH');
    expect(p2Bear.confirmed).toBe(true);
  });

  describe('TradingView Webhook SMC Signal Ingestion (Pillar 7)', () => {
    it('ingests valid webhook alert and activates Pillar 7 (PINE_SMC)', () => {
      const res = engine.ingestWebhookAlert({
        secret: 'test-secret',
        alert_id: 'alert-001',
        symbol: 'SOLUSDT',
        side: 'BUY',
        entryPrice: 140.5,
        stopLoss: 136.0,
        tp1: 145.0,
        tp2: 150.0,
        time: Date.now(),
      });

      expect(res.accepted).toBe(true);

      const snap = engine.evaluate({
        symbol: 'SOLUSDT',
        currentPrice: 141.0,
        indicators: null,
        cvd: null,
      });

      const p7 = snap.pillars.find(p => p.id === 'PINE_SMC')!;
      expect(p7.bias).toBe('BULLISH');
      expect(p7.confirmed).toBe(true);
      expect(p7.score).toBe(85);
      expect(p7.valueText).toContain('SMC BUY @ $140.50');
    });

    it('enforces 60-second LRU nonce deduplication rejecting duplicate alert_id', () => {
      const alert = {
        secret: 'test-secret',
        alert_id: 'duplicate-nonce-123',
        symbol: 'SOLUSDT',
        side: 'BUY' as const,
        entryPrice: 140.0,
        stopLoss: 135.0,
        tp1: 145.0,
        tp2: 150.0,
        time: Date.now(),
      };

      const first = engine.ingestWebhookAlert(alert);
      expect(first.accepted).toBe(true);

      // Replay attempt with same alert_id within 60s
      const replay = engine.ingestWebhookAlert(alert);
      expect(replay.accepted).toBe(false);
      expect(replay.reason).toBe('DUPLICATE_ALERT_ID');
    });
  });

  describe('Consensus Evaluation (Threshold >= 4 of 7)', () => {
    it('triggers consensusMet=true when 4 pillars confirm BULLISH simultaneously', () => {
      // 1. MTF_TREND: Bullish
      const indicators = createMockIndicators({
        ema9: 105,
        ema21: 102,
        ema200: 90,
        adx14: { adx: 30, pdi: 25, mdi: 10 },
      });

      // 2. MOMENTUM: Bullish
      // (rsi14=55, hist=0.5 already inside createMockIndicators)

      // 3. ORDER_FLOW: Bullish (3.5x bid imbalance)
      engine.orderFlowEngine.updateDepth([[108, 350]], [[109, 100]]);

      // 4. CVD: Bullish
      const cvd = createMockCvd({ cvd: 10000, delta: 5000 });

      // 5. PineScript Webhook: Bullish SMC Long (Spec CUJ 1)
      engine.ingestWebhookAlert({
        secret: 'test-secret',
        symbol: 'SOLUSDT',
        side: 'BUY',
        entryPrice: 108,
        stopLoss: 104,
        tp1: 112,
        tp2: 116,
        time: Date.now(),
      });

      const snap = engine.evaluate({
        symbol: 'SOLUSDT',
        currentPrice: 108,
        indicators,
        cvd,
      });

      expect(snap.bullishCount).toBeGreaterThanOrEqual(4);
      expect(snap.consensusMet).toBe(true);
      expect(snap.consensusBias).toBe('BULLISH');
      expect(['BUY', 'STRONG_BUY']).toContain(snap.recommendedAction);
      expect(snap.compositeScore).toBeGreaterThanOrEqual(65);
    });

    it('remains consensusMet=false when only 2-3 pillars confirm', () => {
      // Only Trend & Momentum Bullish, Order Flow balanced, CVD null, Liq null, News neutral, Pine neutral
      const snap = engine.evaluate({
        symbol: 'SOLUSDT',
        currentPrice: 108,
        indicators: createMockIndicators(),
        cvd: null,
      });

      expect(snap.bullishCount).toBeLessThan(4);
      expect(snap.consensusMet).toBe(false);
      expect(snap.consensusBias).toBe('NEUTRAL');
      expect(snap.recommendedAction).toBe('GÖZLƏ');
    });

    it('triggers consensusMet=true when 4 pillars confirm BEARISH', () => {
      // 1. MTF_TREND: Bearish
      const indicators = createMockIndicators({
        ema9: 80,
        ema21: 85,
        ema200: 100,
        adx14: { adx: 28, pdi: 10, mdi: 25 },
        rsi14: 40, // 2. MOMENTUM: Bearish
        macd: { macd: -1.0, signal: -0.5, histogram: -0.5 },
      });

      // 3. ORDER_FLOW: Bearish (4.0x ask dominance)
      engine.orderFlowEngine.updateDepth([[75, 100]], [[76, 400]]);

      // 4. CVD: Bearish
      const cvd = createMockCvd({ cvd: -10000, delta: -5000 });

      const snap = engine.evaluate({
        symbol: 'SOLUSDT',
        currentPrice: 75,
        indicators,
        cvd,
      });

      expect(snap.bearishCount).toBeGreaterThanOrEqual(4);
      expect(snap.consensusMet).toBe(true);
      expect(snap.consensusBias).toBe('BEARISH');
      expect(['SELL', 'STRONG_SELL']).toContain(snap.recommendedAction);
    });
  });
});
