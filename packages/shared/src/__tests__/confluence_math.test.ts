import { describe, it, expect } from 'vitest';
import {
  calculateCompositeConfluenceScore,
  CONFLUENCE_WEIGHTS,
} from '../math.js';
import type { ConfluencePillarId, PillarEvaluation } from '../contracts.js';

describe('TradeOS v2 — Confluence Math Engine (@tradeos/shared)', () => {
  it('verifies institutional weights table sums exactly to 1.0 (100%)', () => {
    const totalWeight = Object.values(CONFLUENCE_WEIGHTS).reduce((a, b) => a + b, 0);
    expect(totalWeight).toBeCloseTo(1.0, 5);

    // Explicit check on each pillar's weight per spec
    expect(CONFLUENCE_WEIGHTS.MTF_TREND).toBe(0.20);
    expect(CONFLUENCE_WEIGHTS.MOMENTUM).toBe(0.15);
    expect(CONFLUENCE_WEIGHTS.ORDER_FLOW).toBe(0.20);
    expect(CONFLUENCE_WEIGHTS.CVD).toBe(0.15);
    expect(CONFLUENCE_WEIGHTS.LIQ_MAGNET).toBe(0.10);
    expect(CONFLUENCE_WEIGHTS.NLP_NEWS).toBe(0.10);
    expect(CONFLUENCE_WEIGHTS.PINE_SMC).toBe(0.10);
  });

  function createPillar(
    id: ConfluencePillarId,
    bias: 'BULLISH' | 'BEARISH' | 'NEUTRAL',
    score: number = 100
  ): PillarEvaluation {
    return {
      id,
      title: id,
      score,
      bias,
      valueText: 'test',
      subText: 'test',
      confirmed: score >= 60,
      updatedAt: Date.now(),
    };
  }

  describe('calculateCompositeConfluenceScore', () => {
    it('returns 0 score, NEUTRAL bias, and GÖZLƏ on empty or null pillars', () => {
      const res1 = calculateCompositeConfluenceScore([]);
      expect(res1).toEqual({
        compositeScore: 0,
        bias: 'NEUTRAL',
        recommendedAction: 'GÖZLƏ',
      });

      const res2 = calculateCompositeConfluenceScore(null as any);
      expect(res2).toEqual({
        compositeScore: 0,
        bias: 'NEUTRAL',
        recommendedAction: 'GÖZLƏ',
      });
    });

    it('evaluates unanimous BULLISH signals across all 7 pillars', () => {
      const allPillars: ConfluencePillarId[] = [
        'MTF_TREND',
        'MOMENTUM',
        'ORDER_FLOW',
        'CVD',
        'LIQ_MAGNET',
        'NLP_NEWS',
        'PINE_SMC',
      ];

      // Strong Buy (>= 85)
      const strongBuyPillars = allPillars.map((id) => createPillar(id, 'BULLISH', 90));
      const resStrong = calculateCompositeConfluenceScore(strongBuyPillars);
      expect(resStrong.bias).toBe('BULLISH');
      expect(resStrong.compositeScore).toBe(90);
      expect(resStrong.recommendedAction).toBe('STRONG_BUY');

      // Regular Buy (>= 65 and < 85)
      const buyPillars = allPillars.map((id) => createPillar(id, 'BULLISH', 70));
      const resBuy = calculateCompositeConfluenceScore(buyPillars);
      expect(resBuy.bias).toBe('BULLISH');
      expect(resBuy.compositeScore).toBe(70);
      expect(resBuy.recommendedAction).toBe('BUY');

      // Low confidence Bullish (< 65) -> GÖZLƏ
      const lowBullish = allPillars.map((id) => createPillar(id, 'BULLISH', 50));
      const resLow = calculateCompositeConfluenceScore(lowBullish);
      expect(resLow.bias).toBe('BULLISH');
      expect(resLow.compositeScore).toBe(50);
      expect(resLow.recommendedAction).toBe('GÖZLƏ');
    });

    it('evaluates unanimous BEARISH signals across all 7 pillars', () => {
      const allPillars: ConfluencePillarId[] = [
        'MTF_TREND',
        'MOMENTUM',
        'ORDER_FLOW',
        'CVD',
        'LIQ_MAGNET',
        'NLP_NEWS',
        'PINE_SMC',
      ];

      // Strong Sell (>= 85)
      const strongSellPillars = allPillars.map((id) => createPillar(id, 'BEARISH', 95));
      const resStrong = calculateCompositeConfluenceScore(strongSellPillars);
      expect(resStrong.bias).toBe('BEARISH');
      expect(resStrong.compositeScore).toBe(95);
      expect(resStrong.recommendedAction).toBe('STRONG_SELL');

      // Regular Sell (>= 65 and < 85)
      const sellPillars = allPillars.map((id) => createPillar(id, 'BEARISH', 75));
      const resSell = calculateCompositeConfluenceScore(sellPillars);
      expect(resSell.bias).toBe('BEARISH');
      expect(resSell.compositeScore).toBe(75);
      expect(resSell.recommendedAction).toBe('SELL');

      // Low confidence Bearish (< 65) -> GÖZLƏ
      const lowBearish = allPillars.map((id) => createPillar(id, 'BEARISH', 40));
      const resLow = calculateCompositeConfluenceScore(lowBearish);
      expect(resLow.bias).toBe('BEARISH');
      expect(resLow.compositeScore).toBe(40);
      expect(resLow.recommendedAction).toBe('GÖZLƏ');
    });

    it('handles 4-pillar consensus with remaining pillars in opposition (Spec CUJ 1)', () => {
      // 4 Bullish confirming: MTF Trend (20%), Momentum (15%), Order Flow (20%), CVD (15%) = 70% weight
      // 3 Bearish: Liq Magnet (10%), NLP News (10%), Pine SMC (10%) = 30% weight
      const mixedPillars: PillarEvaluation[] = [
        createPillar('MTF_TREND', 'BULLISH', 100), // 20
        createPillar('MOMENTUM', 'BULLISH', 100),  // 15
        createPillar('ORDER_FLOW', 'BULLISH', 100),// 20
        createPillar('CVD', 'BULLISH', 100),       // 15 -> sum 70
        createPillar('LIQ_MAGNET', 'BEARISH', 80), // 8
        createPillar('NLP_NEWS', 'BEARISH', 80),   // 8
        createPillar('PINE_SMC', 'BEARISH', 80),   // 8 -> sum 24
      ];

      const res = calculateCompositeConfluenceScore(mixedPillars);
      expect(res.bias).toBe('BULLISH');
      expect(res.compositeScore).toBe(70);
      expect(res.recommendedAction).toBe('BUY');
    });

    it('validates exact threshold boundaries (85, 65, 64)', () => {
      // Create exact score 85 BULLISH
      // 85 / 100 on all pillars
      const pillars85: PillarEvaluation[] = [
        createPillar('MTF_TREND', 'BULLISH', 85),
        createPillar('MOMENTUM', 'BULLISH', 85),
        createPillar('ORDER_FLOW', 'BULLISH', 85),
        createPillar('CVD', 'BULLISH', 85),
        createPillar('LIQ_MAGNET', 'BULLISH', 85),
        createPillar('NLP_NEWS', 'BULLISH', 85),
        createPillar('PINE_SMC', 'BULLISH', 85),
      ];
      expect(calculateCompositeConfluenceScore(pillars85).recommendedAction).toBe('STRONG_BUY');

      // Create exact score 65 BULLISH
      const pillars65: PillarEvaluation[] = [
        createPillar('MTF_TREND', 'BULLISH', 65),
        createPillar('MOMENTUM', 'BULLISH', 65),
        createPillar('ORDER_FLOW', 'BULLISH', 65),
        createPillar('CVD', 'BULLISH', 65),
        createPillar('LIQ_MAGNET', 'BULLISH', 65),
        createPillar('NLP_NEWS', 'BULLISH', 65),
        createPillar('PINE_SMC', 'BULLISH', 65),
      ];
      expect(calculateCompositeConfluenceScore(pillars65).recommendedAction).toBe('BUY');

      // Create score 64 BULLISH -> GÖZLƏ
      const pillars64: PillarEvaluation[] = [
        createPillar('MTF_TREND', 'BULLISH', 64),
        createPillar('MOMENTUM', 'BULLISH', 64),
        createPillar('ORDER_FLOW', 'BULLISH', 64),
        createPillar('CVD', 'BULLISH', 64),
        createPillar('LIQ_MAGNET', 'BULLISH', 64),
        createPillar('NLP_NEWS', 'BULLISH', 64),
        createPillar('PINE_SMC', 'BULLISH', 64),
      ];
      expect(calculateCompositeConfluenceScore(pillars64).recommendedAction).toBe('GÖZLƏ');
    });

    it('clamps out-of-range scores and safely handles NaN / Infinity', () => {
      const edgePillars: PillarEvaluation[] = [
        createPillar('MTF_TREND', 'BULLISH', 150), // should clamp to 100 -> 20
        createPillar('MOMENTUM', 'BULLISH', -20),  // should clamp to 0 -> 0
        createPillar('ORDER_FLOW', 'BULLISH', NaN),// should treat as 0 -> 0
        createPillar('CVD', 'BULLISH', 100),       // 15
      ];
      // Total bullish = 20 + 0 + 0 + 15 = 35
      const res = calculateCompositeConfluenceScore(edgePillars);
      expect(res.bias).toBe('BULLISH');
      expect(res.compositeScore).toBe(35);
      expect(res.recommendedAction).toBe('GÖZLƏ');
    });

    it('returns NEUTRAL and GÖZLƏ when Bullish and Bearish scores are tied', () => {
      const tiedPillars: PillarEvaluation[] = [
        createPillar('MTF_TREND', 'BULLISH', 100),  // 20
        createPillar('ORDER_FLOW', 'BEARISH', 100), // 20
      ];
      const res = calculateCompositeConfluenceScore(tiedPillars);
      expect(res.bias).toBe('NEUTRAL');
      expect(res.recommendedAction).toBe('GÖZLƏ');
    });
  });
});
