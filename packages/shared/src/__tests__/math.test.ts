import { describe, it, expect } from 'vitest';
import {
  getPrecision,
  formatByStepSize,
  formatByTickSize,
  calculateLiquidationPrice,
  computeOrderPreview,
  calculateCompositeConfluenceScore,
  CONFLUENCE_WEIGHTS,
} from '../math.js';
import type { ConfluencePillarId, OpenOrderRequest, PillarEvaluation } from '../contracts.js';

describe('TradeOS v2 — Math Engine (@tradeos/shared/math)', () => {
  describe('getPrecision', () => {
    it('returns 0 for integer steps', () => {
      expect(getPrecision(1)).toBe(0);
      expect(getPrecision(10)).toBe(0);
      expect(getPrecision(100)).toBe(0);
    });

    it('returns correct decimal places for typical exchange step/tick sizes', () => {
      expect(getPrecision(0.1)).toBe(1);
      expect(getPrecision(0.01)).toBe(2);
      expect(getPrecision(0.001)).toBe(3);
      expect(getPrecision(0.0001)).toBe(4);
      expect(getPrecision(0.00001)).toBe(5);
      expect(getPrecision(0.05)).toBe(2);
    });

    it('safely handles scientific notation e.g. 1e-5', () => {
      expect(getPrecision(1e-5)).toBe(5);
      expect(getPrecision(1e-4)).toBe(4);
    });

    it('returns 0 for non-positive or non-finite inputs', () => {
      expect(getPrecision(0)).toBe(0);
      expect(getPrecision(-0.01)).toBe(0);
      expect(getPrecision(NaN)).toBe(0);
      expect(getPrecision(Infinity)).toBe(0);
    });
  });

  describe('formatByStepSize', () => {
    it('formats basic quantities to step size', () => {
      expect(formatByStepSize(1.2345, 0.001)).toBe(1.234);
      expect(formatByStepSize(10.55, 0.1)).toBe(10.5);
      expect(formatByStepSize(25.9, 1)).toBe(25);
      expect(formatByStepSize(125, 10)).toBe(120);
    });

    it('eliminates IEEE 754 precision artifacts', () => {
      // 0.1 + 0.2 in JS is 0.30000000000000004
      const sum = 0.1 + 0.2;
      expect(formatByStepSize(sum, 0.1)).toBe(0.3);

      // 0.007000000000000001 artifact
      expect(formatByStepSize(0.007000000000000001, 0.001)).toBe(0.007);

      // Subtraction artifact 0.5 - 0.2 = 0.29999999999999993
      const sub = 0.5 - 0.2;
      expect(formatByStepSize(sub, 0.1)).toBe(0.3);

      // 1.0000000000000002 artifact
      expect(formatByStepSize(1.0000000000000002, 0.001)).toBe(1.0);
    });

    it('floors by default to never exceed allocated margin', () => {
      expect(formatByStepSize(0.1239, 0.001)).toBe(0.123);
      expect(formatByStepSize(5.9999, 1)).toBe(5);
    });

    it('supports round mode when explicitly requested', () => {
      expect(formatByStepSize(0.1236, 0.001, 'round')).toBe(0.124);
      expect(formatByStepSize(0.1234, 0.001, 'round')).toBe(0.123);
    });

    it('handles edge cases gracefully', () => {
      expect(formatByStepSize(0, 0.01)).toBe(0);
      expect(formatByStepSize(-5, 0.01)).toBe(0);
      expect(formatByStepSize(NaN, 0.01)).toBe(0);
      expect(formatByStepSize(1.23, 0)).toBe(1.23);
      expect(formatByStepSize(1.23, -1)).toBe(1.23);
    });
  });

  describe('formatByTickSize', () => {
    it('rounds price to nearest tick size', () => {
      expect(formatByTickSize(100.124, 0.01)).toBe(100.12);
      expect(formatByTickSize(100.126, 0.01)).toBe(100.13);
      expect(formatByTickSize(95.44, 0.1)).toBe(95.4);
      expect(formatByTickSize(95.46, 0.1)).toBe(95.5);
    });

    it('handles high precision ticks (0.00001, 0.0001)', () => {
      expect(formatByTickSize(0.000014, 0.00001)).toBe(0.00001);
      expect(formatByTickSize(0.000016, 0.00001)).toBe(0.00002);
      expect(formatByTickSize(0.00018, 0.0001)).toBe(0.0002);
    });

    it('eliminates IEEE 754 precision artifacts', () => {
      expect(formatByTickSize(0.30000000000000004, 0.1)).toBe(0.3);
      expect(formatByTickSize(45000.100000000006, 0.1)).toBe(45000.1);
    });

    it('handles edge cases gracefully', () => {
      expect(formatByTickSize(0, 0.01)).toBe(0);
      expect(formatByTickSize(-10, 0.01)).toBe(0);
      expect(formatByTickSize(NaN, 0.01)).toBe(0);
      expect(formatByTickSize(100.5, 0)).toBe(100.5);
      expect(formatByTickSize(100.5, -0.1)).toBe(100.5);
    });
  });

  describe('calculateLiquidationPrice', () => {
    it('calculates separate asymmetric Long liquidation prices: P * (1 - 1/L) / (1 - MMR)', () => {
      // Entry 100, Leverage 10, default MMR 0.005
      // 100 * (1 - 0.1) / (1 - 0.005) = 90 / 0.995 = ~90.45226
      const liq10Long = calculateLiquidationPrice('BUY', 100, 10);
      expect(liq10Long).toBeCloseTo(90.45226, 4);

      // Entry 100, Leverage 20
      // 100 * (1 - 0.05) / 0.995 = 95 / 0.995 = ~95.47738
      const liq20Long = calculateLiquidationPrice('BUY', 100, 20);
      expect(liq20Long).toBeCloseTo(95.47738, 4);

      // Entry 100, Leverage 100
      // 100 * (1 - 0.01) / 0.995 = 99 / 0.995 = ~99.49748
      const liq100Long = calculateLiquidationPrice('BUY', 100, 100);
      expect(liq100Long).toBeCloseTo(99.49748, 4);

      // Entry 100, Leverage 1 -> Long cannot be liquidated
      const liq1Long = calculateLiquidationPrice('BUY', 100, 1);
      expect(liq1Long).toBe(0);
    });

    it('calculates separate asymmetric Short liquidation prices: P * (1 + 1/L) / (1 + MMR)', () => {
      // Entry 100, Leverage 10, default MMR 0.005
      // 100 * (1 + 0.1) / (1 + 0.005) = 110 / 1.005 = ~109.45273
      const liq10Short = calculateLiquidationPrice('SELL', 100, 10);
      expect(liq10Short).toBeCloseTo(109.45273, 4);

      // Entry 100, Leverage 20
      // 100 * (1 + 0.05) / 1.005 = 105 / 1.005 = ~104.47761
      const liq20Short = calculateLiquidationPrice('SELL', 100, 20);
      expect(liq20Short).toBeCloseTo(104.47761, 4);

      // Entry 100, Leverage 100
      // 100 * (1 + 0.01) / 1.005 = 101 / 1.005 = ~100.49751
      const liq100Short = calculateLiquidationPrice('SELL', 100, 100);
      expect(liq100Short).toBeCloseTo(100.49751, 4);

      // Entry 100, Leverage 1
      // 100 * (1 + 1) / 1.005 = 200 / 1.005 = ~199.00497
      const liq1Short = calculateLiquidationPrice('SELL', 100, 1);
      expect(liq1Short).toBeCloseTo(199.00497, 4);
    });

    it('supports custom maintenance margin rate (MMR)', () => {
      // MMR = 0.01 (1%)
      // Long: 100 * 0.9 / 0.99 = ~90.90909
      expect(calculateLiquidationPrice('BUY', 100, 10, 0.01)).toBeCloseTo(90.90909, 4);
      // Short: 100 * 1.1 / 1.01 = ~108.91089
      expect(calculateLiquidationPrice('SELL', 100, 10, 0.01)).toBeCloseTo(108.91089, 4);
    });

    it('accepts LONG and SHORT aliases', () => {
      expect(calculateLiquidationPrice('LONG' as any, 100, 10)).toBeCloseTo(90.45226, 4);
      expect(calculateLiquidationPrice('SHORT' as any, 100, 10)).toBeCloseTo(109.45273, 4);
    });

    it('returns 0 for invalid entry prices', () => {
      expect(calculateLiquidationPrice('BUY', 0, 10)).toBe(0);
      expect(calculateLiquidationPrice('BUY', -100, 10)).toBe(0);
      expect(calculateLiquidationPrice('SELL', NaN, 10)).toBe(0);
    });
  });

  describe('computeOrderPreview', () => {
    const baseLongReq: OpenOrderRequest = {
      symbol: 'SOLUSDT',
      side: 'BUY',
      orderType: 'MARKET',
      marginUsd: 50,
      leverage: 10,
      stopLoss: 95,
      tp1: 115,
      tp2: 125,
    };

    it('computes correct quantity, notional, and liquidation for Long MARKET order', () => {
      const preview = computeOrderPreview(baseLongReq, 100, 0.01, 0.01);

      // Notional = 50 * 10 = 500, Qty = 500 / 100 = 5.0
      expect(preview.quantity).toBe(5);
      expect(preview.notionalUsd).toBe(500);

      // Liquidation = 100 * 0.9 / 0.995 = 90.45
      expect(preview.estimatedLiquidation).toBe(90.45);

      // Breakeven price: 100 * (1 + 0.0025) = 100.25
      expect(preview.breakevenPrice).toBe(100.25);

      // Max loss: (100 - 95) * 5 = 25.00
      expect(preview.maxLossUsd).toBe(25);

      // R:R ratio: (115 - 100) / (100 - 95) = 15 / 5 = 3.0
      expect(preview.rrRatio).toBe(3);

      // SL 95 > Liq 90.45 -> safe
      expect(preview.deadSlSafe).toBe(true);
    });

    it('computes correct metrics for Short MARKET order', () => {
      const shortReq: OpenOrderRequest = {
        symbol: 'SOLUSDT',
        side: 'SELL',
        orderType: 'MARKET',
        marginUsd: 50,
        leverage: 10,
        stopLoss: 105,
        tp1: 85,
      };

      const preview = computeOrderPreview(shortReq, 100, 0.01, 0.01);

      expect(preview.quantity).toBe(5);
      expect(preview.notionalUsd).toBe(500);

      // Short liquidation = 100 * 1.1 / 1.005 = 109.45
      expect(preview.estimatedLiquidation).toBe(109.45);

      // Breakeven price: 100 * (1 - 0.0025) = 99.75
      expect(preview.breakevenPrice).toBe(99.75);

      // Max loss: (105 - 100) * 5 = 25.00
      expect(preview.maxLossUsd).toBe(25);

      // R:R ratio: (100 - 85) / (105 - 100) = 15 / 5 = 3.0
      expect(preview.rrRatio).toBe(3);

      // SL 105 < Liq 109.45 -> safe
      expect(preview.deadSlSafe).toBe(true);
    });

    describe('Dead Stop-Loss Armor Validation', () => {
      it('flags deadSlSafe = false when Long SL is at or below liquidation price', () => {
        // Long estimated liq is 90.45
        const reqSlBelowLiq: OpenOrderRequest = {
          ...baseLongReq,
          stopLoss: 89.0, // Below liq 90.45 -> Liquidation fires before SL!
        };
        const previewBelow = computeOrderPreview(reqSlBelowLiq, 100, 0.01, 0.01);
        expect(previewBelow.deadSlSafe).toBe(false);

        const reqSlAtLiq: OpenOrderRequest = {
          ...baseLongReq,
          stopLoss: 90.45, // Exactly at liq
        };
        const previewAt = computeOrderPreview(reqSlAtLiq, 100, 0.01, 0.01);
        expect(previewAt.deadSlSafe).toBe(false);

        const reqSlAboveLiq: OpenOrderRequest = {
          ...baseLongReq,
          stopLoss: 91.0, // Above liq 90.45 -> Safe
        };
        const previewAbove = computeOrderPreview(reqSlAboveLiq, 100, 0.01, 0.01);
        expect(previewAbove.deadSlSafe).toBe(true);
      });

      it('flags deadSlSafe = false when Short SL is at or above liquidation price', () => {
        // Short estimated liq is 109.45
        const baseShort: OpenOrderRequest = {
          symbol: 'SOLUSDT',
          side: 'SELL',
          orderType: 'MARKET',
          marginUsd: 50,
          leverage: 10,
        };

        const reqSlAboveLiq: OpenOrderRequest = {
          ...baseShort,
          stopLoss: 111.0, // Above liq 109.45 -> Liquidation fires before SL!
        };
        expect(computeOrderPreview(reqSlAboveLiq, 100, 0.01, 0.01).deadSlSafe).toBe(false);

        const reqSlAtLiq: OpenOrderRequest = {
          ...baseShort,
          stopLoss: 109.45, // Exactly at liq
        };
        expect(computeOrderPreview(reqSlAtLiq, 100, 0.01, 0.01).deadSlSafe).toBe(false);

        const reqSlBelowLiq: OpenOrderRequest = {
          ...baseShort,
          stopLoss: 108.0, // Below liq 109.45 -> Safe
        };
        expect(computeOrderPreview(reqSlBelowLiq, 100, 0.01, 0.01).deadSlSafe).toBe(true);
      });

      it('flags deadSlSafe = false when no stop-loss is set (mandatory SL invariant)', () => {
        const noSlReq: OpenOrderRequest = {
          symbol: 'SOLUSDT',
          side: 'BUY',
          orderType: 'MARKET',
          marginUsd: 50,
          leverage: 10,
        };
        const preview = computeOrderPreview(noSlReq, 100, 0.01, 0.01);
        expect(preview.deadSlSafe).toBe(false);
        expect(preview.maxLossUsd).toBe(50); // Entire margin
      });

      it('flags deadSlSafe = false when stopLoss is 0 or negative', () => {
        const zeroSlReq: OpenOrderRequest = {
          symbol: 'SOLUSDT',
          side: 'BUY',
          orderType: 'MARKET',
          marginUsd: 50,
          leverage: 10,
          stopLoss: 0,
        };
        expect(computeOrderPreview(zeroSlReq, 100, 0.01, 0.01).deadSlSafe).toBe(false);

        const negSlReq: OpenOrderRequest = {
          ...zeroSlReq,
          stopLoss: -10,
        };
        expect(computeOrderPreview(negSlReq, 100, 0.01, 0.01).deadSlSafe).toBe(false);
      });
    });

    describe('LIMIT order support', () => {
      it('uses limitPrice instead of markPrice when orderType is LIMIT and limitPrice > 0', () => {
        const limitReq: OpenOrderRequest = {
          symbol: 'BTCUSDT',
          side: 'BUY',
          orderType: 'LIMIT',
          limitPrice: 90000,
          marginUsd: 100,
          leverage: 10,
          stopLoss: 88000,
          tp1: 96000,
        };

        // markPrice is 95000, but limitPrice is 90000
        const preview = computeOrderPreview(limitReq, 95000, 0.1, 0.001);

        // Target notional = 100 * 10 = 1000. Qty = 1000 / 90000 = 0.01111... -> 0.011
        expect(preview.quantity).toBe(0.011);
        expect(preview.notionalUsd).toBe(990);

        // Breakeven: 90000 * 1.0025 = 90225
        expect(preview.breakevenPrice).toBe(90225);

        // R:R: (96000 - 90000) / (90000 - 88000) = 6000 / 2000 = 3.0
        expect(preview.rrRatio).toBe(3);
      });
    });

    describe('R:R Ratio variations', () => {
      it('falls back to tp2 if tp1 is not set', () => {
        const req: OpenOrderRequest = {
          symbol: 'SOLUSDT',
          side: 'BUY',
          orderType: 'MARKET',
          marginUsd: 50,
          leverage: 10,
          stopLoss: 90,
          tp2: 120,
        };
        const preview = computeOrderPreview(req, 100, 0.01, 0.01);
        // (120 - 100) / (100 - 90) = 20 / 10 = 2.0
        expect(preview.rrRatio).toBe(2);
      });

      it('returns rrRatio = 0 if TP or SL is absent or invalid', () => {
        const noTpReq: OpenOrderRequest = {
          ...baseLongReq,
          tp1: undefined,
          tp2: undefined,
        };
        expect(computeOrderPreview(noTpReq, 100, 0.01, 0.01).rrRatio).toBe(0);

        const invertedReq: OpenOrderRequest = {
          ...baseLongReq,
          stopLoss: 105, // SL above entry on Long!
        };
        expect(computeOrderPreview(invertedReq, 100, 0.01, 0.01).rrRatio).toBe(0);
      });
    });

    describe('Zero and boundary handling', () => {
      it('returns safe zero preview when margin, leverage or markPrice <= 0', () => {
        const zeroMargin = computeOrderPreview({ ...baseLongReq, marginUsd: 0 }, 100, 0.01, 0.01);
        expect(zeroMargin.quantity).toBe(0);
        expect(zeroMargin.notionalUsd).toBe(0);
        expect(zeroMargin.estimatedLiquidation).toBe(0);

        const zeroPrice = computeOrderPreview(baseLongReq, 0, 0.01, 0.01);
        expect(zeroPrice.quantity).toBe(0);
        expect(zeroPrice.notionalUsd).toBe(0);
      });
    });
  });

  describe('calculateCompositeConfluenceScore (Bayesian 7-Pillar Confluence & Macro Veto)', () => {
    function makePillar(
      id: ConfluencePillarId,
      bias: 'BULLISH' | 'BEARISH' | 'NEUTRAL',
      score: number = 100
    ): PillarEvaluation {
      return {
        id,
        title: id,
        score,
        bias,
        valueText: `${id}:${score}`,
        subText: 'test',
        confirmed: score >= 60,
        updatedAt: Date.now(),
      };
    }

    const allPillars: ConfluencePillarId[] = [
      'MACRO_REGIME',
      'NATIVE_SMC',
      'CVD_ABSORPTION',
      'ORDER_FLOW_L2',
      'LIQ_CLUSTERS',
      'MOMENTUM_RVOL',
      'SENTIMENT_MACRO',
    ];

    it('verifies 100% total weight normalization across all 7 pillars', () => {
      const sum = Object.values(CONFLUENCE_WEIGHTS).reduce((a, b) => a + b, 0);
      expect(sum).toBeCloseTo(1.0, 5);

      // Verify exact individual weights
      expect(CONFLUENCE_WEIGHTS.MACRO_REGIME).toBe(0.25);
      expect(CONFLUENCE_WEIGHTS.NATIVE_SMC).toBe(0.25);
      expect(CONFLUENCE_WEIGHTS.CVD_ABSORPTION).toBe(0.20);
      expect(CONFLUENCE_WEIGHTS.ORDER_FLOW_L2).toBe(0.15);
      expect(CONFLUENCE_WEIGHTS.LIQ_CLUSTERS).toBe(0.075);
      expect(CONFLUENCE_WEIGHTS.MOMENTUM_RVOL).toBe(0.05);
      expect(CONFLUENCE_WEIGHTS.SENTIMENT_MACRO).toBe(0.025);
    });

    it('verifies neutral 50 baseline score preventing consensus starvation', () => {
      // 1. When all pillars are neutral, score is baseline 50, bias is NEUTRAL, action is WAIT
      const allNeutral = allPillars.map((id) => makePillar(id, 'NEUTRAL', 0));
      const neutralRes = calculateCompositeConfluenceScore(allNeutral);
      expect(neutralRes.compositeScore).toBe(50);
      expect(neutralRes.bias).toBe('NEUTRAL');
      expect(neutralRes.recommendedAction).toBe('WAIT');

      // 2. Consensus starvation prevention:
      // 4 Tier 1/2 pillars Bullish at 80 (sum = 20 + 20 + 16 + 12 = 68)
      // 3 Tier 3 tactical pillars Neutral (0.15 weight * 50 = 7.5 baseline)
      // Total = 68 + 7.5 = 75.5 -> 76 (STRONG_BUY)
      const mixedPillars: PillarEvaluation[] = [
        makePillar('MACRO_REGIME', 'BULLISH', 80),
        makePillar('NATIVE_SMC', 'BULLISH', 80),
        makePillar('CVD_ABSORPTION', 'BULLISH', 80),
        makePillar('ORDER_FLOW_L2', 'BULLISH', 80),
        makePillar('LIQ_CLUSTERS', 'NEUTRAL', 0),
        makePillar('MOMENTUM_RVOL', 'NEUTRAL', 0),
        makePillar('SENTIMENT_MACRO', 'NEUTRAL', 0),
      ];
      const mixedRes = calculateCompositeConfluenceScore(mixedPillars);
      expect(mixedRes.compositeScore).toBe(76);
      expect(mixedRes.bias).toBe('BULLISH');
      expect(mixedRes.recommendedAction).toBe('STRONG_BUY');
    });

    it('verifies macroVetoActive latch sets recommendedAction = WAIT while preserving compositeScore', () => {
      const strongBuyPillars = allPillars.map((id) => makePillar(id, 'BULLISH', 90));

      // Without veto: STRONG_BUY with natural score 90
      const noVeto = calculateCompositeConfluenceScore(strongBuyPillars, false);
      expect(noVeto.compositeScore).toBe(90);
      expect(noVeto.bias).toBe('BULLISH');
      expect(noVeto.recommendedAction).toBe('STRONG_BUY');

      // With veto: latch to WAIT, natural compositeScore 90 strictly preserved
      const vetoed = calculateCompositeConfluenceScore(strongBuyPillars, true);
      expect(vetoed.compositeScore).toBe(90);
      expect(vetoed.bias).toBe('BULLISH');
      expect(vetoed.recommendedAction).toBe('WAIT');
    });

    it('verifies score thresholds: >= 75% STRONG_BUY / STRONG_SELL, 60-74% BUY / SELL, < 60% WAIT', () => {
      // Exactly 75 Bullish -> STRONG_BUY
      const p75Bull = allPillars.map((id) => makePillar(id, 'BULLISH', 75));
      const res75Bull = calculateCompositeConfluenceScore(p75Bull);
      expect(res75Bull.compositeScore).toBe(75);
      expect(res75Bull.recommendedAction).toBe('STRONG_BUY');

      // Exactly 74 Bullish -> BUY
      const p74Bull = allPillars.map((id) => makePillar(id, 'BULLISH', 74));
      const res74Bull = calculateCompositeConfluenceScore(p74Bull);
      expect(res74Bull.compositeScore).toBe(74);
      expect(res74Bull.recommendedAction).toBe('BUY');

      // Exactly 60 Bullish -> BUY
      const p60Bull = allPillars.map((id) => makePillar(id, 'BULLISH', 60));
      const res60Bull = calculateCompositeConfluenceScore(p60Bull);
      expect(res60Bull.compositeScore).toBe(60);
      expect(res60Bull.recommendedAction).toBe('BUY');

      // 59 Bullish (< 60) -> WAIT
      const p59Bull = allPillars.map((id) => makePillar(id, 'BULLISH', 59));
      const res59Bull = calculateCompositeConfluenceScore(p59Bull);
      expect(res59Bull.compositeScore).toBe(59);
      expect(res59Bull.recommendedAction).toBe('WAIT');

      // Exactly 75 Bearish -> STRONG_SELL
      const p75Bear = allPillars.map((id) => makePillar(id, 'BEARISH', 75));
      const res75Bear = calculateCompositeConfluenceScore(p75Bear);
      expect(res75Bear.compositeScore).toBe(75);
      expect(res75Bear.recommendedAction).toBe('STRONG_SELL');

      // Exactly 65 Bearish -> SELL
      const p65Bear = allPillars.map((id) => makePillar(id, 'BEARISH', 65));
      const res65Bear = calculateCompositeConfluenceScore(p65Bear);
      expect(res65Bear.compositeScore).toBe(65);
      expect(res65Bear.recommendedAction).toBe('SELL');

      // 55 Bearish (< 60) -> WAIT
      const p55Bear = allPillars.map((id) => makePillar(id, 'BEARISH', 55));
      const res55Bear = calculateCompositeConfluenceScore(p55Bear);
      expect(res55Bear.compositeScore).toBe(55);
      expect(res55Bear.recommendedAction).toBe('WAIT');
    });

    it('safely handles empty or null input', () => {
      expect(calculateCompositeConfluenceScore([])).toEqual({
        compositeScore: 0,
        bias: 'NEUTRAL',
        recommendedAction: 'WAIT',
      });
      expect(calculateCompositeConfluenceScore(null as any)).toEqual({
        compositeScore: 0,
        bias: 'NEUTRAL',
        recommendedAction: 'WAIT',
      });
    });
  });
});
