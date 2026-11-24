import { describe, it, expect, beforeEach, vi } from 'vitest';
import { LiquidationEngine } from '../liquidationEngine.js';
import { ConfluenceEngine } from '../confluenceEngine.js';
import type { TechnicalSummary, CvdSnapshot, KlineCandle } from '@tradeos/shared';

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

describe('ConfluenceEngine (Institutional 7-Pillar Confluence Engine)', () => {
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

  it('evaluates MACRO_REGIME correctly based on MTF Manager state and timeout fail-closed', () => {
    // When no 1h candle stream exists, fail-closes to DEGRADED and macroVetoActive = true
    const snapNoData = engine.evaluate({
      symbol: 'SOLUSDT',
      currentPrice: 108,
      indicators: createMockIndicators(),
      cvd: null,
    });
    const p1NoData = snapNoData.pillars.find((p) => p.id === 'MACRO_REGIME')!;
    expect(p1NoData.bias).toBe('NEUTRAL');
    expect(snapNoData.macroRegime).toBe('DEGRADED');
    expect(snapNoData.macroVetoActive).toBe(true);

    // Feed 1h candles into mtfManager (Price > EMA200 with strong ADX)
    const candles1h: KlineCandle[] = [];
    for (let i = 0; i < 200; i++) {
      candles1h.push({
        time: 1000 + i * 3600,
        open: 80 + i * 0.1,
        high: 82 + i * 0.1,
        low: 79 + i * 0.1,
        close: 81 + i * 0.1,
        volume: 1000,
      });
    }
    engine.mtfManager.setInitialCandles('SOLUSDT', '1h', candles1h);

    const snapBull = engine.evaluate({
      symbol: 'SOLUSDT',
      currentPrice: 108,
      indicators: createMockIndicators(),
      cvd: null,
    });
    const p1Bull = snapBull.pillars.find((p) => p.id === 'MACRO_REGIME')!;
    expect(snapBull.macroRegime).toBe('MACRO_BULLISH');
    expect(snapBull.macroVetoActive).toBe(false);
    expect(p1Bull.bias).toBe('BULLISH');
    expect(p1Bull.confirmed).toBe(true);
  });

  it('evaluates MOMENTUM_RVOL correctly based on RSI and MACD Histogram', () => {
    // Sweet spot RSI 55 + positive MACD hist -> Bullish
    const bullData = {
      symbol: 'SOLUSDT',
      currentPrice: 100,
      indicators: createMockIndicators({ rsi14: 55, macd: { macd: 1, signal: 0.5, histogram: 0.5 } }),
      cvd: null,
    };
    const snapBull = engine.evaluate(bullData);
    const p2 = snapBull.pillars.find((p) => p.id === 'MOMENTUM_RVOL')!;
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
    const p2Bear = snapBear.pillars.find((p) => p.id === 'MOMENTUM_RVOL')!;
    expect(p2Bear.bias).toBe('BEARISH');
    expect(p2Bear.confirmed).toBe(true);
  });

  describe('TradingView Webhook Alert Ingestion Compatibility', () => {
    it('ingests valid webhook alert and accepts payload', () => {
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

  describe('Consensus Evaluation (Institutional Threshold >= 75% & !macroVetoActive)', () => {
    it('triggers consensusMet=true when compositeScore >= 75 and !macroVetoActive', () => {
      // 1. MACRO_REGIME: Bullish (1h candles)
      const candles1h: KlineCandle[] = [];
      for (let i = 0; i < 200; i++) {
        candles1h.push({
          time: 1000 + i * 3600,
          open: 80 + i * 0.1,
          high: 82 + i * 0.1,
          low: 79 + i * 0.1,
          close: 81 + i * 0.1,
          volume: 1000,
        });
      }
      engine.mtfManager.setInitialCandles('SOLUSDT', '1h', candles1h);

      // 2. NATIVE_SMC: Bullish FVG
      engine.smcEngine.onCandleClosed('SOLUSDT', '15m', [
        { time: 1000, open: 100, high: 104, low: 99, close: 103, volume: 100 },
        { time: 1900, open: 103, high: 112, low: 103, close: 111, volume: 500 },
        { time: 2800, open: 111, high: 116, low: 106, close: 115, volume: 300 },
      ]);

      // 3. CVD_ABSORPTION & ORDER_FLOW_L2: Strong Bullish
      const now = Date.now();
      // Provide varying 15-minute delta sample so stdDev > 0
      for (let m = 15; m >= 1; m--) {
        engine.orderFlowEngine.processTrade(m * 10, false, now - m * 60_000, 105);
      }
      // Aggressive seller absorption: large market sells fail to push price down (price rises 105 -> 105.5)
      engine.orderFlowEngine.processTrade(600, true, now - 2000, 105);
      engine.orderFlowEngine.processTrade(600, true, now - 1000, 105.5);
      // Heavy Level 2 bid depth pressure
      engine.orderFlowEngine.updateDepth([[105.5, 5000]], [[106, 50]]);

      // 4. SENTIMENT_MACRO: Bullish headlines
      engine.sentimentHarvester.setHeadlines([
        'Massive institutional inflows accelerate across all major crypto spot and futures markets',
      ]);

      const indicators = createMockIndicators({
        rsi14: 58,
        macd: { macd: 1.5, signal: 1.0, histogram: 0.8 },
      });

      const snap = engine.evaluate({
        symbol: 'SOLUSDT',
        currentPrice: 105.5,
        indicators,
        cvd: createMockCvd({ cvd: 10000, delta: 5000 }),
      });

      expect(snap.macroVetoActive).toBe(false);
      expect(snap.compositeScore).toBeGreaterThanOrEqual(75);
      expect(snap.consensusMet).toBe(true);
      expect(snap.consensusBias).toBe('BULLISH');
      expect(['BUY', 'STRONG_BUY']).toContain(snap.recommendedAction);
    });

    it('remains consensusMet=false and recommendedAction=WAIT when Macro Veto is active', () => {
      // No 1h candles -> DEGRADED -> macroVetoActive = true
      const snap = engine.evaluate({
        symbol: 'SOLUSDT',
        currentPrice: 108,
        indicators: createMockIndicators(),
        cvd: null,
      });

      expect(snap.macroVetoActive).toBe(true);
      expect(snap.consensusMet).toBe(false);
      expect(snap.consensusBias).toBe('NEUTRAL');
      expect(snap.recommendedAction).toBe('WAIT');
    });

    it('evaluates directional bias for BEARISH setups while respecting Macro Veto', () => {
      // 1. MACRO_REGIME: Bearish (1h candles trending down)
      const candles1h: KlineCandle[] = [];
      for (let i = 0; i < 200; i++) {
        candles1h.push({
          time: 1000 + i * 3600,
          open: 120 - i * 0.1,
          high: 121 - i * 0.1,
          low: 118 - i * 0.1,
          close: 119 - i * 0.1,
          volume: 1000,
        });
      }
      engine.mtfManager.setInitialCandles('SOLUSDT', '1h', candles1h);

      // 2. NATIVE_SMC: Bearish FVG
      engine.smcEngine.onCandleClosed('SOLUSDT', '15m', [
        { time: 1000, open: 85, high: 86, low: 80, close: 81, volume: 100 },
        { time: 1900, open: 81, high: 81, low: 70, close: 71, volume: 500 },
        { time: 2800, open: 71, high: 75, low: 68, close: 69, volume: 300 },
      ]);

      // 3. ORDER_FLOW_L2: 10.0x ask dominance
      engine.orderFlowEngine.updateDepth([[72, 50]], [[73, 500]]);

      const indicators = createMockIndicators({
        ema9: 70,
        ema21: 75,
        ema200: 100,
        adx14: { adx: 30, pdi: 10, mdi: 28 },
        rsi14: 35,
        macd: { macd: -1.5, signal: -1.0, histogram: -0.8 },
      });

      const snap = engine.evaluate({
        symbol: 'SOLUSDT',
        currentPrice: 72,
        indicators,
        cvd: createMockCvd({ cvd: -10000, delta: -5000 }),
      });

      expect(snap.macroRegime).toBe('MACRO_BEARISH');
      expect(snap.macroVetoActive).toBe(true);
      expect(snap.recommendedAction).toBe('WAIT'); // Blocked by Macro Veto
    });

    it('delegates to AlphaRegistry when registered and pre-trade gates pass', () => {
      const mockEvaluate = vi.fn().mockReturnValue({
        compositeBias: 'BULLISH',
        compositeScore: 91,
        rawConviction: 0.82,
        details: [
          {
            factorId: 'ORDER_FLOW_L2',
            name: 'Order Flow L2',
            rawAlpha: 0.85,
            orthogonalAlpha: 0.85,
            posteriorWeight: 0.25,
            bias: 'BULLISH',
            confidence: 0.9,
            isCollinear: false,
            informationRatio: 1.8,
          },
        ],
        evaluatedAt: Date.now(),
      });

      const mockRegistry = {
        evaluate: mockEvaluate,
      } as any;

      engine.setAlphaRegistry(mockRegistry);

      const snap = engine.evaluate({
        symbol: 'SOLUSDT',
        currentPrice: 100,
        indicators: createMockIndicators(),
        cvd: null,
      });

      expect(mockEvaluate).toHaveBeenCalled();
      expect(snap.compositeScore).toBe(91);
      expect(snap.factorDetails).toBeDefined();
      expect(snap.factorDetails?.length).toBe(1);
      expect(snap.factorDetails?.[0].factorId).toBe('ORDER_FLOW_L2');
      expect(snap.factorOutputs).toBeDefined();
      expect(snap.factorOutputs?.[0].rawAlpha).toBe(0.85);
    });

    it('blocks AlphaRegistry evaluation when EconomicEventGuard blackout is active', () => {
      const mockEvaluate = vi.fn();
      const mockRegistry = { evaluate: mockEvaluate } as any;
      engine.setAlphaRegistry(mockRegistry);

      engine.economicEventGuard.addEvent({
        id: 'test_event_cpi',
        name: 'US CPI Release',
        timestamp: Date.now(),
        impact: 'HIGH',
        currency: 'USD',
      });

      const snap = engine.evaluate({
        symbol: 'SOLUSDT',
        currentPrice: 100,
        indicators: createMockIndicators(),
        cvd: null,
      });

      expect(snap.blockReason).toBe('BLOCKED_EVENT_BLACKOUT');
      expect(snap.eventBlackoutActive).toBe(true);
      expect(snap.recommendedAction).toBe('WAIT');
      expect(mockEvaluate).not.toHaveBeenCalled();
    });
  });
});
