import { describe, it, expect, beforeEach, vi } from 'vitest';
import { LiquidationEngine } from '../liquidationEngine.js';
import { ConfluenceEngine, CALIBRATED_CONFLUENCE_WEIGHTS } from '../confluenceEngine.js';
import { EconomicEventGuard } from '../economicEventGuard.js';
import { NoiseBandEngine } from '../noiseBandEngine.js';
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
        macd: { macd: 3.0, signal: 1.0, histogram: 2.0 },
      });

      const snap = engine.evaluate({
        symbol: 'SOLUSDT',
        currentPrice: 105.5,
        indicators,
        cvd: createMockCvd({ cvd: 10000, delta: 5000, openInterestUsd: 50_000_000 }),
        recentHigh: 105.7,
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

    it('honors Next-Gen percentage Quant Conviction Thresholds (60%, 65%, 70%, 75%) in score mode', () => {
      const isolatedEngine = new ConfluenceEngine({
        economicEventGuard: new EconomicEventGuard(),
        noiseBandEngine: new NoiseBandEngine(),
      });
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
      isolatedEngine.mtfManager.setInitialCandles('SOLUSDT', '1h', candles1h);

      isolatedEngine.setAlphaRegistry({
        evaluate: () => ({
          compositeBias: 'BULLISH',
          compositeScore: 68,
          rawConviction: 0.36,
          details: [
            {
              factorId: 'ORDER_FLOW_L2',
              name: 'Order Flow L2',
              rawAlpha: 0.72,
              orthogonalAlpha: 0.72,
              posteriorWeight: 1,
              bias: 'BULLISH',
              confidence: 0.85,
              isCollinear: false,
              informationRatio: 1.4,
            },
          ],
          evaluatedAt: Date.now(),
        }),
      } as any);

      // With threshold = 65%, score 68 MUST pass consensusMet=true
      isolatedEngine.setConsensusThreshold(65);
      const snapPass = isolatedEngine.evaluate({
        symbol: 'SOLUSDT',
        currentPrice: 108,
        indicators: createMockIndicators(),
        cvd: null,
      });
      expect(snapPass.compositeScore).toBe(68);
      expect(snapPass.consensusMet).toBe(true);
      expect(snapPass.recommendedAction).toBe('BUY');

      // With threshold = 70%, score 68 MUST stay WAIT and consensusMet=false
      isolatedEngine.setConsensusThreshold(70);
      const snapFail = isolatedEngine.evaluate({
        symbol: 'SOLUSDT',
        currentPrice: 108,
        indicators: createMockIndicators(),
        cvd: null,
      });
      expect(snapFail.compositeScore).toBe(68);
      expect(snapFail.consensusMet).toBe(false);
      expect(snapFail.recommendedAction).toBe('WAIT');
    });

    it('[ARCH-15] recalibrates CALIBRATED_CONFLUENCE_WEIGHTS to sum to 1.0, reducing NATIVE_SMC (25% -> 17.5%) and lifting MOMENTUM_RVOL (5% -> 9%) & LIQ_CLUSTERS (7.5% -> 11%)', () => {
      const total = Object.values(CALIBRATED_CONFLUENCE_WEIGHTS).reduce((acc, w) => acc + w, 0);
      expect(total).toBeCloseTo(1.0, 10);
      expect(CALIBRATED_CONFLUENCE_WEIGHTS.MACRO_REGIME).toBeCloseTo(0.25, 4);
      expect(CALIBRATED_CONFLUENCE_WEIGHTS.NATIVE_SMC).toBeCloseTo(0.175, 4);
      expect(CALIBRATED_CONFLUENCE_WEIGHTS.CVD_ABSORPTION).toBeCloseTo(0.20, 4);
      expect(CALIBRATED_CONFLUENCE_WEIGHTS.ORDER_FLOW_L2).toBeCloseTo(0.15, 4);
      expect(CALIBRATED_CONFLUENCE_WEIGHTS.LIQ_CLUSTERS).toBeCloseTo(0.11, 4);
      expect(CALIBRATED_CONFLUENCE_WEIGHTS.MOMENTUM_RVOL).toBeCloseTo(0.09, 4);
      expect(CALIBRATED_CONFLUENCE_WEIGHTS.SENTIMENT_MACRO).toBeCloseTo(0.025, 4);

      const snap = engine.evaluate({
        symbol: 'SOLUSDT',
        currentPrice: 105,
        indicators: createMockIndicators(),
        cvd: createMockCvd(),
      });
      const cvdFactor = snap.telemetryEvent?.activeFactors.find((f) => f.factorId === 'CVD_ABSORPTION');
      const smcFactor = snap.telemetryEvent?.activeFactors.find((f) => f.factorId === 'NATIVE_SMC');
      const liqFactor = snap.telemetryEvent?.activeFactors.find((f) => f.factorId === 'LIQ_CLUSTERS');
      const momFactor = snap.telemetryEvent?.activeFactors.find((f) => f.factorId === 'MOMENTUM_RVOL');
      expect(cvdFactor?.effectiveWeight).toBeCloseTo(CALIBRATED_CONFLUENCE_WEIGHTS.CVD_ABSORPTION, 4);
      expect(smcFactor?.effectiveWeight).toBeCloseTo(CALIBRATED_CONFLUENCE_WEIGHTS.NATIVE_SMC, 4);
      expect(liqFactor?.effectiveWeight).toBeCloseTo(CALIBRATED_CONFLUENCE_WEIGHTS.LIQ_CLUSTERS, 4);
      expect(momFactor?.effectiveWeight).toBeCloseTo(CALIBRATED_CONFLUENCE_WEIGHTS.MOMENTUM_RVOL, 4);
    });

    it('passes full MTF candles and market context to AlphaRegistry instead of a 1-candle array', () => {
      const isolatedEngine = new ConfluenceEngine({
        economicEventGuard: new EconomicEventGuard(),
        noiseBandEngine: new NoiseBandEngine(),
      });
      const candles15m: KlineCandle[] = [];
      for (let i = 0; i < 30; i++) {
        candles15m.push({
          time: 1000 + i * 900,
          open: 100 + i * 0.2,
          high: 101 + i * 0.2,
          low: 99 + i * 0.2,
          close: 100.5 + i * 0.2,
          volume: 1500,
        });
      }
      isolatedEngine.mtfManager.setInitialCandles('SOLUSDT', '15m', candles15m);

      const mockEvaluate = vi.fn().mockReturnValue({
        compositeBias: 'BULLISH',
        compositeScore: 80,
        rawConviction: 0.6,
        details: [],
        evaluatedAt: Date.now(),
      });
      isolatedEngine.setAlphaRegistry({ evaluate: mockEvaluate } as any);

      isolatedEngine.evaluate({
        symbol: 'SOLUSDT',
        currentPrice: 106.5,
        indicators: createMockIndicators(),
        cvd: createMockCvd(),
        candle15m: candles15m[candles15m.length - 1],
        prevCandle15m: candles15m[candles15m.length - 2],
        vwap: 102,
        fundingRate: -0.0004,
        spotPrice: 106.6,
      });

      expect(mockEvaluate).toHaveBeenCalledTimes(1);
      const passedCtx = mockEvaluate.mock.calls[0]![0];
      expect(passedCtx.candles.length).toBe(30);
      expect(passedCtx.indicators).toBeDefined();
      expect(passedCtx.cvd).toBeDefined();
      expect(passedCtx.depth).toBeDefined();
      expect(passedCtx.fundingRate).toBe(-0.0004);
      expect(passedCtx.spotPrice).toBe(106.6);
    });

    it('never blocks BEARISH short signals when macroVetoActive is true (price below 1h EMA200)', () => {
      const isolatedEngine = new ConfluenceEngine({ economicEventGuard: new EconomicEventGuard() });
      isolatedEngine.setConsensusThreshold(60);
      vi.spyOn(isolatedEngine.mtfManager, 'getMacroBias').mockReturnValue({
        regime: 'MACRO_BEARISH',
        adx: 28,
        ema200: 110,
        supertrendDirection: 'BEARISH',
        macroVetoActive: true,
      } as any);
      isolatedEngine.setAlphaRegistry({
        evaluate: vi.fn().mockReturnValue({
          compositeBias: 'BEARISH',
          compositeScore: 68,
          rawConviction: -0.5,
          details: [{ factorId: 'ORDER_FLOW_L2', name: 'Order Flow L2', rawAlpha: -0.8, orthogonalAlpha: -0.8, posteriorWeight: 1, bias: 'BEARISH', confidence: 0.9, isCollinear: false, informationRatio: 1.5 }],
          evaluatedAt: Date.now(),
        }),
      } as any);

      const dummyCandles: KlineCandle[] = [{ time: 1000, open: 105, high: 106, low: 104, close: 105, volume: 1000 }];

      const snap = isolatedEngine.evaluate({
        symbol: 'SOLUSDT',
        currentPrice: 105,
        indicators: createMockIndicators(),
        cvd: createMockCvd(),
        candles: dummyCandles,
      });

      expect(snap.macroVetoActive).toBe(true);
      expect(snap.recommendedAction).toBe('SELL');
      expect(snap.consensusMet).toBe(true);
    });

    it('applies -10 soft penalty to BULLISH longs in MACRO_RANGING below EMA200, while hard-vetoing MACRO_BEARISH longs', () => {
      const isolatedEngine = new ConfluenceEngine({ economicEventGuard: new EconomicEventGuard() });
      isolatedEngine.setConsensusThreshold(60);
      isolatedEngine.setAlphaRegistry({
        evaluate: vi.fn().mockReturnValue({
          compositeBias: 'BULLISH',
          compositeScore: 73,
          rawConviction: 0.6,
          details: [{ factorId: 'ORDER_FLOW_L2', name: 'Order Flow L2', rawAlpha: 0.8, orthogonalAlpha: 0.8, posteriorWeight: 1, bias: 'BULLISH', confidence: 0.9, isCollinear: false, informationRatio: 1.5 }],
          evaluatedAt: Date.now(),
        }),
      } as any);

      vi.spyOn(isolatedEngine.mtfManager, 'getMacroBias').mockReturnValue({
        regime: 'MACRO_RANGING',
        adx: 24.9,
        ema200: 110,
        supertrendDirection: 'NEUTRAL',
        macroVetoActive: true,
      } as any);

      const dummyCandles: KlineCandle[] = [{ time: 1000, open: 109, high: 110, low: 108, close: 109.5, volume: 1000 }];

      const rangingLong = isolatedEngine.evaluate({
        symbol: 'SOLUSDT',
        currentPrice: 109.5,
        indicators: createMockIndicators(),
        cvd: createMockCvd(),
        candles: dummyCandles,
      });
      expect(rangingLong.compositeScore).toBe(63);
      expect(rangingLong.recommendedAction).toBe('BUY');
      expect(rangingLong.consensusMet).toBe(true);

      vi.spyOn(isolatedEngine.mtfManager, 'getMacroBias').mockReturnValue({
        regime: 'MACRO_BEARISH',
        adx: 28,
        ema200: 110,
        supertrendDirection: 'BEARISH',
        macroVetoActive: true,
      } as any);

      const bearishLong = isolatedEngine.evaluate({
        symbol: 'SOLUSDT',
        currentPrice: 105,
        indicators: createMockIndicators(),
        cvd: createMockCvd(),
        candles: dummyCandles,
      });
      expect(bearishLong.recommendedAction).toBe('WAIT');
      expect(bearishLong.consensusMet).toBe(false);
    });
  });
});
