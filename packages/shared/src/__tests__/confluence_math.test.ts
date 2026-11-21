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

    // Explicit check on each pillar's weight per Bayesian 7-pillar spec
    expect(CONFLUENCE_WEIGHTS.MACRO_REGIME).toBe(0.25);
    expect(CONFLUENCE_WEIGHTS.NATIVE_SMC).toBe(0.25);
    expect(CONFLUENCE_WEIGHTS.CVD_ABSORPTION).toBe(0.20);
    expect(CONFLUENCE_WEIGHTS.ORDER_FLOW_L2).toBe(0.15);
    expect(CONFLUENCE_WEIGHTS.LIQ_CLUSTERS).toBe(0.075);
    expect(CONFLUENCE_WEIGHTS.MOMENTUM_RVOL).toBe(0.05);
    expect(CONFLUENCE_WEIGHTS.SENTIMENT_MACRO).toBe(0.025);
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

  const allPillars: ConfluencePillarId[] = [
    'MACRO_REGIME',
    'NATIVE_SMC',
    'CVD_ABSORPTION',
    'ORDER_FLOW_L2',
    'LIQ_CLUSTERS',
    'MOMENTUM_RVOL',
    'SENTIMENT_MACRO',
  ];

  describe('calculateCompositeConfluenceScore', () => {
    it('returns 0 score, NEUTRAL bias, and WAIT on empty or null pillars', () => {
      const res1 = calculateCompositeConfluenceScore([]);
      expect(res1).toEqual({
        compositeScore: 0,
        bias: 'NEUTRAL',
        recommendedAction: 'WAIT',
      });

      const res2 = calculateCompositeConfluenceScore(null as any);
      expect(res2).toEqual({
        compositeScore: 0,
        bias: 'NEUTRAL',
        recommendedAction: 'WAIT',
      });
    });

    it('evaluates unanimous BULLISH signals across all 7 pillars', () => {
      // Strong Buy (>= 75)
      const strongBuyPillars = allPillars.map((id) => createPillar(id, 'BULLISH', 90));
      const resStrong = calculateCompositeConfluenceScore(strongBuyPillars);
      expect(resStrong.bias).toBe('BULLISH');
      expect(resStrong.compositeScore).toBe(90);
      expect(resStrong.recommendedAction).toBe('STRONG_BUY');

      // Regular Buy (>= 60 and < 75)
      const buyPillars = allPillars.map((id) => createPillar(id, 'BULLISH', 65));
      const resBuy = calculateCompositeConfluenceScore(buyPillars);
      expect(resBuy.bias).toBe('BULLISH');
      expect(resBuy.compositeScore).toBe(65);
      expect(resBuy.recommendedAction).toBe('BUY');

      // Low confidence Bullish (< 60) -> WAIT
      const lowBullish = allPillars.map((id) => createPillar(id, 'BULLISH', 55));
      const resLow = calculateCompositeConfluenceScore(lowBullish);
      expect(resLow.bias).toBe('BULLISH');
      expect(resLow.compositeScore).toBe(55);
      expect(resLow.recommendedAction).toBe('WAIT');
    });

    it('evaluates unanimous BEARISH signals across all 7 pillars', () => {
      // Strong Sell (>= 75)
      const strongSellPillars = allPillars.map((id) => createPillar(id, 'BEARISH', 95));
      const resStrong = calculateCompositeConfluenceScore(strongSellPillars);
      expect(resStrong.bias).toBe('BEARISH');
      expect(resStrong.compositeScore).toBe(95);
      expect(resStrong.recommendedAction).toBe('STRONG_SELL');

      // Regular Sell (>= 60 and < 75)
      const sellPillars = allPillars.map((id) => createPillar(id, 'BEARISH', 70));
      const resSell = calculateCompositeConfluenceScore(sellPillars);
      expect(resSell.bias).toBe('BEARISH');
      expect(resSell.compositeScore).toBe(70);
      expect(resSell.recommendedAction).toBe('SELL');

      // Low confidence Bearish (< 60) -> WAIT
      const lowBearish = allPillars.map((id) => createPillar(id, 'BEARISH', 40));
      const resLow = calculateCompositeConfluenceScore(lowBearish);
      expect(resLow.bias).toBe('BEARISH');
      expect(resLow.compositeScore).toBe(40);
      expect(resLow.recommendedAction).toBe('WAIT');
    });

    it('handles structural 4-pillar consensus with neutral tactical pillars', () => {
      // 4 Tier 1/2 pillars Bullish at 80: 0.25*80 + 0.25*80 + 0.20*80 + 0.15*80 = 68
      // 3 Tier 3 tactical pillars Neutral (0.075 + 0.05 + 0.025 = 0.15 * 50 = 7.5 baseline)
      // Total = 75.5 -> 76 (STRONG_BUY)
      const mixedPillars: PillarEvaluation[] = [
        createPillar('MACRO_REGIME', 'BULLISH', 80),
        createPillar('NATIVE_SMC', 'BULLISH', 80),
        createPillar('CVD_ABSORPTION', 'BULLISH', 80),
        createPillar('ORDER_FLOW_L2', 'BULLISH', 80),
        createPillar('LIQ_CLUSTERS', 'NEUTRAL', 0),
        createPillar('MOMENTUM_RVOL', 'NEUTRAL', 0),
        createPillar('SENTIMENT_MACRO', 'NEUTRAL', 0),
      ];

      const res = calculateCompositeConfluenceScore(mixedPillars);
      expect(res.bias).toBe('BULLISH');
      expect(res.compositeScore).toBe(76);
      expect(res.recommendedAction).toBe('STRONG_BUY');
    });

    it('validates exact threshold boundaries (75, 74, 60, 59)', () => {
      // Create exact score 75 BULLISH -> STRONG_BUY
      const pillars75: PillarEvaluation[] = allPillars.map((id) => createPillar(id, 'BULLISH', 75));
      expect(calculateCompositeConfluenceScore(pillars75).recommendedAction).toBe('STRONG_BUY');

      // Create exact score 74 BULLISH -> BUY
      const pillars74: PillarEvaluation[] = allPillars.map((id) => createPillar(id, 'BULLISH', 74));
      expect(calculateCompositeConfluenceScore(pillars74).recommendedAction).toBe('BUY');

      // Create exact score 60 BULLISH -> BUY
      const pillars60: PillarEvaluation[] = allPillars.map((id) => createPillar(id, 'BULLISH', 60));
      expect(calculateCompositeConfluenceScore(pillars60).recommendedAction).toBe('BUY');

      // Create score 59 BULLISH -> WAIT
      const pillars59: PillarEvaluation[] = allPillars.map((id) => createPillar(id, 'BULLISH', 59));
      expect(calculateCompositeConfluenceScore(pillars59).recommendedAction).toBe('WAIT');
    });

    it('clamps out-of-range scores and safely handles NaN / Infinity', () => {
      const edgePillars: PillarEvaluation[] = [
        createPillar('MACRO_REGIME', 'BULLISH', 150), // should clamp to 100 -> 25
        createPillar('NATIVE_SMC', 'BULLISH', -20),   // should clamp to 0 -> 0
        createPillar('CVD_ABSORPTION', 'BULLISH', NaN),// should treat as 0 -> 0
        createPillar('ORDER_FLOW_L2', 'BULLISH', 100), // 15
        // remaining 3 pillars neutral -> 0.15 * 50 = 7.5
        createPillar('LIQ_CLUSTERS', 'NEUTRAL', 0),
        createPillar('MOMENTUM_RVOL', 'NEUTRAL', 0),
        createPillar('SENTIMENT_MACRO', 'NEUTRAL', 0),
      ];
      // Bullish = 25 + 0 + 0 + 15 + 7.5 = 47.5 -> 48
      const res = calculateCompositeConfluenceScore(edgePillars);
      expect(res.bias).toBe('BULLISH');
      expect(res.compositeScore).toBe(48);
      expect(res.recommendedAction).toBe('WAIT');
    });

    it('returns NEUTRAL and WAIT when Bullish and Bearish scores are tied', () => {
      const tiedPillars: PillarEvaluation[] = [
        createPillar('MACRO_REGIME', 'BULLISH', 100),  // 25
        createPillar('NATIVE_SMC', 'BEARISH', 100),    // 25
        createPillar('CVD_ABSORPTION', 'NEUTRAL', 0),
        createPillar('ORDER_FLOW_L2', 'NEUTRAL', 0),
        createPillar('LIQ_CLUSTERS', 'NEUTRAL', 0),
        createPillar('MOMENTUM_RVOL', 'NEUTRAL', 0),
        createPillar('SENTIMENT_MACRO', 'NEUTRAL', 0),
      ];
      const res = calculateCompositeConfluenceScore(tiedPillars);
      expect(res.bias).toBe('NEUTRAL');
      expect(res.recommendedAction).toBe('WAIT');
    });
  });
});
