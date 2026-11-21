import { describe, it, expect, beforeEach, vi } from 'vitest';
import { BinanceClient } from '../../exchange/binanceClient.js';
import { calculateSuperTrend } from '../indicators.js';
import { HierarchicalMtfManager } from '../hierarchicalMtfManager.js';
import { NativeSmcEngine } from '../nativeSmcEngine.js';
import { OrderFlowEngine } from '../orderFlowEngine.js';
import { LiquidationEngine } from '../liquidationEngine.js';
import type { KlineCandle } from '@tradeos/shared';

describe('Server Quant Unit Test Suite', () => {
  // --------------------------------------------------------------------------
  // 1. BinanceClient getOpenInterest
  // --------------------------------------------------------------------------
  describe('BinanceClient.getOpenInterest', () => {
    it('requests /fapi/v1/openInterest with uppercase symbol and returns open interest', async () => {
      const client = new BinanceClient();
      const mockResponse = {
        symbol: 'BTCUSDT',
        openInterest: '20403.42',
        time: 1700000000000,
      };

      const requestSpy = vi.spyOn(client, 'request').mockResolvedValueOnce(mockResponse);

      const res = await client.getOpenInterest('btcusdt');

      expect(requestSpy).toHaveBeenCalledWith('/fapi/v1/openInterest', {
        method: 'GET',
        isPublicData: true,
        priority: 'P2',
        params: { symbol: 'BTCUSDT' },
      });
      expect(res).toEqual(mockResponse);
      expect(res.symbol).toBe('BTCUSDT');
      expect(parseFloat(res.openInterest)).toBeGreaterThan(0);
    });
  });

  // --------------------------------------------------------------------------
  // 2. Indicators: calculateSuperTrend
  // --------------------------------------------------------------------------
  describe('indicators: calculateSuperTrend', () => {
    it('handles empty or invalid inputs gracefully', () => {
      expect(calculateSuperTrend([], [], [])).toEqual({ supertrend: [], direction: [] });
      expect(calculateSuperTrend([100], [90], [])).toEqual({ supertrend: [], direction: [] });
    });

    it('computes SuperTrend and tracks BULLISH/BEARISH direction flips', () => {
      // 15 bars of trending price
      const highs: number[] = [];
      const lows: number[] = [];
      const closes: number[] = [];

      // Start flat, then rally strongly
      for (let i = 0; i < 20; i++) {
        const base = 100 + i * 2;
        highs.push(base + 2);
        lows.push(base - 2);
        closes.push(base + 1);
      }

      const res = calculateSuperTrend(highs, lows, closes, 10, 3.0);
      expect(res.supertrend.length).toBe(20);
      expect(res.direction.length).toBe(20);

      // In a strong uptrend, final direction should be BULLISH
      const lastDir = res.direction[res.direction.length - 1];
      expect(lastDir).toBe('BULLISH');
      expect(res.supertrend[19]).toBeLessThan(closes[19]!);

      // Now introduce a sharp dump
      for (let i = 20; i < 25; i++) {
        const base = 140 - (i - 19) * 10;
        highs.push(base + 1);
        lows.push(base - 5);
        closes.push(base - 4);
      }

      const resDump = calculateSuperTrend(highs, lows, closes, 10, 3.0);
      const flippedDir = resDump.direction[resDump.direction.length - 1];
      expect(flippedDir).toBe('BEARISH');
      expect(resDump.supertrend[24]).toBeGreaterThan(closes[24]!);
    });
  });

  // --------------------------------------------------------------------------
  // 3. HierarchicalMtfManager
  // --------------------------------------------------------------------------
  describe('HierarchicalMtfManager', () => {
    let mtf: HierarchicalMtfManager;

    beforeEach(() => {
      mtf = new HierarchicalMtfManager();
    });

    it('manages 200-candle circular ring buffers and evicts oldest', () => {
      const candles: KlineCandle[] = [];
      for (let i = 0; i < 220; i++) {
        candles.push({
          time: 1000 + i * 60,
          open: 100,
          high: 105,
          low: 95,
          close: 102,
          volume: 10,
        });
      }

      mtf.setInitialCandles('BTCUSDT', '1m', candles);
      const stored = mtf.getCandles('BTCUSDT', '1m');
      expect(stored.length).toBe(200);
      expect(stored[0]!.time).toBe(1000 + 20 * 60); // First 20 evicted
      expect(stored[199]!.time).toBe(1000 + 219 * 60);
    });

    it('updates active candle in-place when timestamp matches', () => {
      const c1: KlineCandle = { time: 1000, open: 100, high: 105, low: 95, close: 101, volume: 5 };
      mtf.updateCandle('BTCUSDT', '15m', c1);

      const c1Updated: KlineCandle = { time: 1000, open: 100, high: 110, low: 95, close: 108, volume: 12 };
      mtf.updateCandle('BTCUSDT', '15m', c1Updated);

      const stored = mtf.getCandles('BTCUSDT', '15m');
      expect(stored.length).toBe(1);
      expect(stored[0]!.high).toBe(110);
      expect(stored[0]!.volume).toBe(12);
    });

    it('fail-closes to DEGRADED and engages macroVetoActive after 120s timeout', () => {
      const t0 = 1700000000000;
      const c1h: KlineCandle = { time: Math.floor(t0 / 1000), open: 100, high: 105, low: 95, close: 102, volume: 50 };
      mtf.setInitialCandles('BTCUSDT', '1h', [c1h], t0);

      // Fresh evaluation at t0 + 10s: not timed out
      const freshBias = mtf.getMacroBias('BTCUSDT', 102, t0 + 10_000);
      expect(freshBias.regime).not.toBe('DEGRADED');

      // Stale evaluation at t0 + 125s: timed out!
      const staleBias = mtf.getMacroBias('BTCUSDT', 102, t0 + 125_000);
      expect(staleBias.regime).toBe('DEGRADED');
      expect(staleBias.macroVetoActive).toBe(true);

      const pillar = mtf.evaluatePillar('BTCUSDT', 102, t0 + 125_000);
      expect(pillar.confirmed).toBe(false);
      expect(pillar.valueText).toContain('DEGRADED');
    });

    it('evaluates MACRO_BULLISH when Price > 1h EMA200 & SuperTrend Bullish & ADX >= 25', () => {
      const t0 = Date.now();
      const candles: KlineCandle[] = [];
      // Build 205 candles trending upwards
      for (let i = 0; i < 205; i++) {
        const price = 100 + i * 2;
        candles.push({
          time: Math.floor((t0 - (205 - i) * 3600000) / 1000),
          open: price - 1,
          high: price + 2,
          low: price - 2,
          close: price + 1,
          volume: 100,
        });
      }

      mtf.setInitialCandles('ETHUSDT', '1h', candles);
      const bias = mtf.getMacroBias('ETHUSDT', 550, t0);

      expect(bias.regime).toBe('MACRO_BULLISH');
      expect(bias.macroVetoActive).toBe(false);
      expect(bias.ema200).not.toBeNull();
      expect(bias.supertrendDirection).toBe('BULLISH');

      const pillar = mtf.evaluatePillar('ETHUSDT', 550, t0);
      expect(pillar.bias).toBe('BULLISH');
      expect(pillar.confirmed).toBe(true);
    });

    it('sets macroVetoActive=true when price is below 1h EMA200', () => {
      const t0 = Date.now();
      const candles: KlineCandle[] = [];
      for (let i = 0; i < 205; i++) {
        const price = 200 + i;
        candles.push({
          time: Math.floor((t0 - (205 - i) * 3600000) / 1000),
          open: price,
          high: price + 2,
          low: price - 2,
          close: price,
          volume: 100,
        });
      }

      mtf.setInitialCandles('ETHUSDT', '1h', candles);
      // EMA200 is around ~300. Price at 250 is below EMA200
      const bias = mtf.getMacroBias('ETHUSDT', 250, t0);
      expect(bias.macroVetoActive).toBe(true);
    });
  });

  // --------------------------------------------------------------------------
  // 4. NativeSmcEngine
  // --------------------------------------------------------------------------
  describe('NativeSmcEngine', () => {
    let smc: NativeSmcEngine;

    beforeEach(() => {
      smc = new NativeSmcEngine();
    });

    it('detects 3-candle closed Bullish Fair Value Gap (FVG)', () => {
      // Bullish FVG: Low(candle 2) > High(candle 0)
      const candles: KlineCandle[] = [
        { time: 100, open: 100, high: 102, low: 99, close: 101, volume: 10 },   // C0: high 102
        { time: 200, open: 101, high: 110, low: 101, close: 109, volume: 50 },  // C1: expansion
        { time: 300, open: 109, high: 112, low: 106, close: 111, volume: 20 },  // C2: low 106
      ];

      const fvgs = smc.detectFairValueGaps(candles, '15m');
      expect(fvgs.length).toBe(1);
      expect(fvgs[0]!.type).toBe('BULLISH');
      expect(fvgs[0]!.low).toBe(102);   // High of C0
      expect(fvgs[0]!.high).toBe(106);  // Low of C2
      expect(fvgs[0]!.mitigated).toBe(false);
    });

    it('mitigates Bullish FVG when subsequent candle wicks completely overlap', () => {
      const candles: KlineCandle[] = [
        { time: 100, open: 100, high: 102, low: 99, close: 101, volume: 10 },
        { time: 200, open: 101, high: 110, low: 101, close: 109, volume: 50 },
        { time: 300, open: 109, high: 112, low: 106, close: 111, volume: 20 },
        { time: 400, open: 111, high: 111, low: 101, close: 103, volume: 30 }, // Dips to 101 (below low 102)
      ];

      const fvgs = smc.detectFairValueGaps(candles, '15m');
      expect(fvgs.length).toBe(1);
      expect(fvgs[0]!.mitigated).toBe(true);
    });

    it('detects Order Block with expansion candle >= 1.8x ATR and 5-bar BOS', () => {
      const candles: KlineCandle[] = [];
      // 5 baseline candles with swing high at 105
      for (let i = 0; i < 5; i++) {
        candles.push({
          time: 100 + i * 60,
          open: 100,
          high: 105,
          low: 98,
          close: 101,
          volume: 20,
        });
      }
      // Candidate Order Block candle (C5)
      candles.push({
        time: 400,
        open: 101,
        high: 103,
        low: 99,
        close: 100,
        volume: 30,
      });
      // Expansion candle (C6) with large body breaking BOS above 105
      candles.push({
        time: 460,
        open: 100,
        high: 125,
        low: 100,
        close: 124, // Body = 24, breaks highest5 (105)
        volume: 100,
      });

      const obs = smc.detectOrderBlocks(candles, '15m', 5);
      expect(obs.length).toBeGreaterThanOrEqual(1);
      const ob = obs[0]!;
      expect(ob.type).toBe('BULLISH');
      expect(ob.invalidationPrice).toBe(99); // Low of candidate OB
    });

    it('detects Liquidity Sweep when price sweeps 20-candle swing low and reclaims', () => {
      const candles: KlineCandle[] = [];
      // 20 candles with swing low at 95
      for (let i = 0; i < 20; i++) {
        candles.push({
          time: 100 + i * 60,
          open: 100,
          high: 105,
          low: 95,
          close: 102,
          volume: 10,
        });
      }
      // Sweep candle: wicks to 92 (below 95), closes at 97 (reclaim)
      candles.push({
        time: 1300,
        open: 98,
        high: 101,
        low: 92,
        close: 97,
        volume: 80,
      });

      const sweep = smc.detectLiquiditySweeps(candles, 20);
      expect(sweep).not.toBeNull();
      expect(sweep!.direction).toBe('SWEEP_LOW');
      expect(sweep!.sweepPrice).toBe(92);
      expect(sweep!.reclaimPrice).toBe(97);
    });

    it('performs O(1) tick check and mitigates active FVG on real-time price tick', () => {
      const closedCandles: KlineCandle[] = [
        { time: 100, open: 100, high: 102, low: 99, close: 101, volume: 10 },
        { time: 200, open: 101, high: 110, low: 101, close: 109, volume: 50 },
        { time: 300, open: 109, high: 112, low: 106, close: 111, volume: 20 },
      ];

      smc.onCandleClosed('BTCUSDT', '15m', closedCandles);
      expect(smc.getActiveFvgs('BTCUSDT').length).toBe(1);

      // Price tick inside FVG: 104
      const tickInside = smc.onTick('BTCUSDT', 104);
      expect(tickInside.insideFvg).not.toBeNull();
      expect(tickInside.insideFvg!.low).toBe(102);

      // Price tick below FVG low: 101 (mitigates and evicts)
      smc.onTick('BTCUSDT', 101);
      expect(smc.getActiveFvgs('BTCUSDT').length).toBe(0);
    });
  });

  // --------------------------------------------------------------------------
  // 5. OrderFlowEngine
  // --------------------------------------------------------------------------
  describe('OrderFlowEngine Absorption & Volume Profile', () => {
    let ofe: OrderFlowEngine;

    beforeEach(() => {
      ofe = new OrderFlowEngine();
    });

    it('detects Bullish signed Z-score absorption divergence (Z_delta <= -2.0, deltaPrice >= 0)', () => {
      const t0 = 1700000000000;

      // Seed 15 minutes of baseline delta distribution with mean ~ 0, stdDev ~ 100
      for (let i = 1; i <= 15; i++) {
        const delta = (i % 2 === 0 ? 1 : -1) * 100;
        ofe.addMinuteBar({
          minuteTimestamp: Math.floor(t0 / 60000) - (16 - i),
          delta,
        });
      }

      // 60-second burst: Extreme aggressive seller delta (-350 -> Z_delta <= -2.0)
      // but price ticks higher from 100 to 102 (deltaPrice >= 0)
      ofe.processTrade(350, true, t0, 100);  // Sell taker
      ofe.processTrade(10, false, t0 + 10000, 102); // Price rose to 102

      const evalResult = ofe.evaluateAbsorption(102, t0 + 15000);
      expect(evalResult.bias).toBe('BULLISH');
      expect(evalResult.confirmed).toBe(true);
      expect(evalResult.valueText).toContain('Bullish Absorption');
    });

    it('detects Bearish signed Z-score absorption divergence (Z_delta >= +2.0, deltaPrice <= 0)', () => {
      const t0 = 1700000000000;

      for (let i = 1; i <= 15; i++) {
        const delta = (i % 2 === 0 ? 1 : -1) * 100;
        ofe.addMinuteBar({
          minuteTimestamp: Math.floor(t0 / 60000) - (16 - i),
          delta,
        });
      }

      // Extreme aggressive buyer delta (+350 -> Z_delta >= +2.0)
      // but price ticks lower from 100 to 98 (deltaPrice <= 0)
      ofe.processTrade(350, false, t0, 100); // Buy taker
      ofe.processTrade(10, true, t0 + 10000, 98); // Price fell to 98

      const evalResult = ofe.evaluateAbsorption(98, t0 + 15000);
      expect(evalResult.bias).toBe('BEARISH');
      expect(evalResult.confirmed).toBe(true);
      expect(evalResult.valueText).toContain('Bearish Absorption');
    });

    it('computes Micro Volume Profile POC, VAH (70%), and VAL', () => {
      const t0 = 1700000000000;

      // Trades clustered heavily around 100 (POC)
      ofe.processTrade(100, false, t0, 98);
      ofe.processTrade(500, false, t0 + 1000, 100); // POC
      ofe.processTrade(150, false, t0 + 2000, 102);
      ofe.processTrade(50, false, t0 + 3000, 105);

      const vp = ofe.getVolumeProfile();
      expect(vp).not.toBeNull();
      expect(vp!.poc).toBe(100);
      expect(vp!.totalVolume).toBe(800);
      expect(vp!.vah).toBeGreaterThanOrEqual(100);
      expect(vp!.val).toBeLessThanOrEqual(100);
    });
  });

  // --------------------------------------------------------------------------
  // 6. LiquidationEngine
  // --------------------------------------------------------------------------
  describe('LiquidationEngine Leverage Projections', () => {
    let liq: LiquidationEngine;

    beforeEach(() => {
      liq = new LiquidationEngine();
    });

    it('projects 10x, 25x, 50x, 100x leverage clusters accurately from Open Interest', () => {
      const markPrice = 100;
      const openInterestUsd = 100_000_000; // $100M

      const clusters = liq.projectClusters(markPrice, openInterestUsd);

      // Should project 8 clusters (4 leverage tiers * 2 sides)
      expect(clusters.length).toBe(8);

      const liq100Short = clusters.find((c) => c.leverage === 100 && c.side === 'SHORT_LIQ');
      const liq50Short = clusters.find((c) => c.leverage === 50 && c.side === 'SHORT_LIQ');
      const liq25Short = clusters.find((c) => c.leverage === 25 && c.side === 'SHORT_LIQ');
      const liq10Short = clusters.find((c) => c.leverage === 10 && c.side === 'SHORT_LIQ');

      // 100x: P * 1.01 = 101
      expect(liq100Short?.price).toBe(101);
      // 50x: P * 1.02 = 102
      expect(liq50Short?.price).toBe(102);
      // 25x: P * 1.04 = 104
      expect(liq25Short?.price).toBe(104);
      // 10x: P * 1.10 = 110
      expect(liq10Short?.price).toBe(110);

      // Weights check: 100x: 15% ($7.5M), 50x: 35% ($17.5M), 25x: 35% ($17.5M), 10x: 15% ($7.5M)
      expect(liq100Short?.estimatedVolumeUsd).toBe(7_500_000);
      expect(liq50Short?.estimatedVolumeUsd).toBe(17_500_000);
      expect(liq25Short?.estimatedVolumeUsd).toBe(17_500_000);
      expect(liq10Short?.estimatedVolumeUsd).toBe(7_500_000);
    });

    it('activates BULLISH liquidation magnet when price is attracted upward toward short stop cluster', () => {
      // Price at 100.3, ATR 1.0. 100x Short pool is at 101.3 (from 100.3 * 1.01).
      // If we project from baseline 100 with currentPrice: 100.2, distance to short (101.2) is closer than to long (99.2).
      // Let's pass currentPrice: 100.2
      const res = liq.evaluate({
        currentPrice: 100.2,
        atr14: 1.0,
        openInterestUsd: 50_000_000,
        clusters: [
          { price: 101.0, estimatedVolumeUsd: 10_000_000, side: 'SHORT_LIQ' }, // dist 0.8 <= 1.2x ATR
          { price: 98.0, estimatedVolumeUsd: 10_000_000, side: 'LONG_LIQ' },   // dist 2.2 > 1.2x ATR
        ],
      });

      expect(res.bias).toBe('BULLISH');
      expect(res.confirmed).toBe(true);
      expect(res.valueText).toContain('Short Liq Magnet: $101');
    });

    it('evaluates to NEUTRAL when ATR is tiny and nearest cluster is outside trigger', () => {
      // Current price 100, ATR 0.2. Nearest 100x cluster is at 101 (distance 1.0 = 5.0x ATR > 1.2x)
      const res = liq.evaluate({
        currentPrice: 100,
        atr14: 0.2,
        openInterestUsd: 50_000_000,
      });

      expect(res.bias).toBe('NEUTRAL');
      expect(res.confirmed).toBe(false);
      expect(res.valueText).toContain('Dispersed');
    });
  });
});
