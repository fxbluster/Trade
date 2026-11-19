import { describe, it, expect, beforeEach } from 'vitest';
import { OrderFlowEngine } from '../orderFlowEngine.js';
import { SentimentHarvester, analyzeText } from '../sentimentHarvester.js';

describe('OrderFlowEngine', () => {
  let engine: OrderFlowEngine;

  beforeEach(() => {
    engine = new OrderFlowEngine();
  });

  it('evaluates to NEUTRAL when no L2 depth is available', () => {
    const evalResult = engine.evaluate(150);
    expect(evalResult.id).toBe('ORDER_FLOW');
    expect(evalResult.bias).toBe('NEUTRAL');
    expect(evalResult.confirmed).toBe(false);
    expect(evalResult.score).toBe(50);
  });

  it('detects >= 3.0x bid/ask imbalance as BULLISH confirmed', () => {
    // 3.5x bid dominance ($35,000 bids vs $10,000 asks)
    engine.updateDepth(
      [
        [100, 200], // $20,000
        [99, 150],  // $14,850
      ],
      [
        [101, 50],  // $5,050
        [102, 48],  // $4,896
      ]
    );

    const evalResult = engine.evaluate(100);
    expect(evalResult.bias).toBe('BULLISH');
    expect(evalResult.confirmed).toBe(true);
    expect(evalResult.score).toBeGreaterThan(60);
    expect(evalResult.valueText).toContain('Buy Imbalance');
  });

  it('detects >= 3.0x ask/bid imbalance as BEARISH confirmed', () => {
    // 4.0x ask dominance ($40,000 asks vs $10,000 bids)
    engine.updateDepth(
      [
        [100, 100], // $10,000
      ],
      [
        [101, 200], // $20,200
        [102, 200], // $20,400
      ]
    );

    const evalResult = engine.evaluate(100);
    expect(evalResult.bias).toBe('BEARISH');
    expect(evalResult.confirmed).toBe(true);
    expect(evalResult.score).toBeGreaterThan(60);
    expect(evalResult.valueText).toContain('Sell Imbalance');
  });

  it('evaluates to NEUTRAL when book depth is balanced (< 3.0x)', () => {
    engine.updateDepth(
      [[100, 100]], // $10,000
      [[101, 90]]   // $9,090 (~1.1x ratio)
    );

    const evalResult = engine.evaluate(100);
    expect(evalResult.bias).toBe('NEUTRAL');
    expect(evalResult.confirmed).toBe(false);
    expect(evalResult.score).toBe(50);
    expect(evalResult.valueText).toContain('Balanced');
  });

  it('incorporates aggressive taker trade volume into flow pressure', () => {
    // Balanced depth
    engine.updateDepth([[100, 10]], [[101, 10]]);

    // Massive aggressive buying (taker buy = isBuyerMaker false)
    engine.processTrade(500, false);

    const evalResult = engine.evaluate(100);
    expect(evalResult.bias).toBe('BULLISH');
    expect(evalResult.confirmed).toBe(true);
  });

  it('resets state cleanly', () => {
    engine.updateDepth([[100, 500]], [[101, 10]]);
    engine.reset();

    const evalResult = engine.evaluate(100);
    expect(evalResult.bias).toBe('NEUTRAL');
    expect(evalResult.confirmed).toBe(false);
  });
});

describe('SentimentHarvester & VADER Crypto Lexicon', () => {
  it('correctly scores strong positive crypto headlines (compound > +0.25)', () => {
    const text = 'Bitcoin surge! Massive institutional adoption and ETF approval sparks huge rally to new ATH';
    const result = analyzeText(text);

    expect(result.compound).toBeGreaterThan(0.25);
    expect(result.positive).toBeGreaterThan(0);
    expect(result.negative).toBe(0);
  });

  it('correctly scores strong negative crypto headlines (compound < -0.25)', () => {
    const text = 'Crypto crash panic! Major exchange hacked with massive exploit and SEC lawsuit causing dump';
    const result = analyzeText(text);

    expect(result.compound).toBeLessThan(-0.25);
    expect(result.negative).toBeGreaterThan(0);
  });

  it('handles intensifiers and negations properly', () => {
    const normal = analyzeText('market dump');
    const intensified = analyzeText('massive dump');
    expect(intensified.compound).toBeLessThan(normal.compound);

    const negated = analyzeText('not dumping');
    expect(negated.compound).toBeGreaterThan(normal.compound);
  });

  it('updates SentimentHarvester evaluation from headlines and confirms pillar', () => {
    const harvester = new SentimentHarvester();

    // Default neutral
    expect(harvester.evaluate().bias).toBe('NEUTRAL');
    expect(harvester.evaluate().confirmed).toBe(false);

    // Bullish headlines
    harvester.setHeadlines([
      'Solana breakout confirms huge surge with record inflows and institutional accumulation',
      'Fed approves digital asset integration as market soars'
    ]);

    const bullEval = harvester.evaluate();
    expect(bullEval.bias).toBe('BULLISH');
    expect(bullEval.confirmed).toBe(true);
    expect(bullEval.score).toBeGreaterThan(60);

    // Bearish headlines
    harvester.setHeadlines([
      'Crypto exchange insolvent bankruptcy declaration triggers flash crash and panic liquidation'
    ]);

    const bearEval = harvester.evaluate();
    expect(bearEval.bias).toBe('BEARISH');
    expect(bearEval.confirmed).toBe(true);
    expect(bearEval.score).toBeGreaterThan(60);
  });
});
