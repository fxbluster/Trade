import { describe, it, expect, beforeEach } from 'vitest';
import { OrderFlowEngine } from '../orderFlowEngine.js';
import { CvdAbsorptionFactor } from '../factors/cvdAbsorptionFactor.js';
import { OrderFlowFactor } from '../factors/orderFlowFactor.js';
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

  it('expires aggressive trade volume older than 60 seconds (60-bucket rolling ring buffer)', () => {
    const t0 = 1700000000000;
    engine.updateDepth([[100, 10]], [[101, 10]]);

    // Trade at t0
    engine.processTrade(1000, false, t0);
    // At t0 + 10s, trade is still active in the 60s window
    const activeResult = engine.evaluate(100, t0 + 10000);
    expect(activeResult.bias).toBe('BULLISH');
    expect(activeResult.confirmed).toBe(true);

    // At t0 + 65s, trade has expired outside the 60s window
    const expiredResult = engine.evaluate(100, t0 + 65000);
    expect(expiredResult.bias).toBe('NEUTRAL');
    expect(expiredResult.confirmed).toBe(false);
  });

  it('formats separate Depth and 60s Flow telemetry in subText', () => {
    engine.updateDepth([[100, 80]], [[101, 60]]);
    const t0 = 1700000000000;
    engine.processTrade(50, true, t0); // Sell flow

    const evalResult = engine.evaluate(100, t0);
    expect(evalResult.subText).toContain('Bids:');
    expect(evalResult.subText).toContain('Asks:');
    expect(evalResult.subText).toContain('Flow:');
  });

  it('resets state cleanly', () => {
    engine.updateDepth([[100, 500]], [[101, 10]]);
    engine.reset();

    const evalResult = engine.evaluate(100);
    expect(evalResult.bias).toBe('NEUTRAL');
    expect(evalResult.confirmed).toBe(false);
  });

  it('[DEF-01] triggers BEARISH/BULLISH when |Z| >= 2.0 and price moves with aggressive flow (never Equilibrium NEUTRAL)', () => {
    const t0 = 1700000000000;
    for (let i = 1; i <= 15; i++) {
      const delta = (i % 2 === 0 ? 1 : -1) * 100;
      engine.addMinuteBar({
        minuteTimestamp: Math.floor(t0 / 60000) - (16 - i),
        delta,
      });
    }

    // Z <= -2.0 and price drops (100 -> 98): directional bearish expansion
    engine.processTrade(350, true, t0, 100);
    engine.processTrade(10, true, t0 + 5000, 98);
    const bearRes = engine.evaluateAbsorption(98, t0 + 10000);
    expect(bearRes.bias).toBe('BEARISH');
    expect(bearRes.confirmed).toBe(true);
    expect(bearRes.score).toBeGreaterThanOrEqual(70);
    expect(bearRes.subText).not.toContain('-2.0 < Z < +2.0');

    // Reset and test Z >= +2.0 and price rises (100 -> 102): directional bullish expansion
    engine.reset();
    for (let i = 1; i <= 15; i++) {
      const delta = (i % 2 === 0 ? 1 : -1) * 100;
      engine.addMinuteBar({
        minuteTimestamp: Math.floor(t0 / 60000) - (16 - i),
        delta,
      });
    }
    engine.processTrade(350, false, t0, 100);
    engine.processTrade(10, false, t0 + 5000, 102);
    const bullRes = engine.evaluateAbsorption(102, t0 + 10000);
    expect(bullRes.bias).toBe('BULLISH');
    expect(bullRes.confirmed).toBe(true);
    expect(bullRes.score).toBeGreaterThanOrEqual(70);
    expect(bullRes.subText).not.toContain('-2.0 < Z < +2.0');
  });

  it('[DEF-02] prioritizes >= 3.0x 60s taker flow over passive L2 depth (18.1x Sell vs $4.5M Bids / $3.3M Asks)', () => {
    const t0 = 1700000000000;
    // Passive Bids ($4.5M) > Passive Asks ($3.3M)
    engine.updateDepth([[100, 45000]], [[101, 32673]]);

    // 18.1x Sell 60s taker flow (e.g., 1810 sell vs 100 buy at $100)
    engine.processTrade(100, false, t0, 100);
    engine.processTrade(1810, true, t0 + 1000, 100);

    const l2Eval = engine.evaluateL2(100, t0 + 2000);
    expect(l2Eval.bias).toBe('BEARISH');
    expect(l2Eval.confirmed).toBe(true);
    expect(l2Eval.score).toBeGreaterThanOrEqual(75);
    expect(l2Eval.subText).toContain('18.1x Sell');
  });
});

describe('CvdAbsorptionFactor & OrderFlowFactor ([ARCH-01], [ARCH-02])', () => {
  it('[ARCH-01] confirms BEARISH momentum during a -1.6% selloff with 18.1x Sell flow instead of contrarian BULLISH', () => {
    const factor = new CvdAbsorptionFactor();
    const baseTime = 1700000000000;

    // Warmup with candles showing a -1.6% selloff (100 -> 98.4)
    const candles = [
      { time: 1, open: 100.0, high: 100.2, low: 99.5, close: 99.6, volume: 1000 },
      { time: 2, open: 99.6, high: 99.7, low: 99.0, close: 99.1, volume: 1200 },
      { time: 3, open: 99.1, high: 99.2, low: 98.7, close: 98.8, volume: 1400 },
      { time: 4, open: 98.8, high: 98.9, low: 98.4, close: 98.5, volume: 1600 },
      { time: 5, open: 98.5, high: 98.6, low: 98.3, close: 98.4, volume: 1800 },
    ];
    factor.warmup(candles);

    // Even if current tick is flat (98.4 -> 98.4) and delta is less negative than prior bars,
    // 18.1x Sell flow during -1.6% selloff must emit BEARISH, never contrarian BULLISH
    const out = factor.computeFactor({
      symbol: 'SOLUSDT',
      currentPrice: 98.4,
      candles,
      cvd: {
        symbol: 'SOLUSDT',
        cvd: -5000,
        buyVolume: 100,
        sellVolume: 1810,
        delta: -1710,
        openInterestUsd: null,
        timestamp: baseTime,
      },
      indicators: {
        ema9: 98.7,
        ema21: 99.2,
        ema50: 99.8,
        ema200: 101.0,
        rsi14: 28,
        atr14: 0.4,
        macd: null,
        bollingerBands: null,
        adx14: { adx: 34, pdi: 12, mdi: 38 },
        support: 98.0,
        resistance: 100.0,
        volumeSma20: 1000,
      },
      timestamp: baseTime,
    });

    expect(out.bias).toBe('BEARISH');
    expect(out.rawAlpha).toBeLessThan(-0.1);
  });

  it('[ARCH-01] preserves contrarian BULLISH absorption in low-ADX ranging / price-stalling divergence', () => {
    const factor = new CvdAbsorptionFactor();
    const baseTime = 1700000000000;
    const flatCandles = Array.from({ length: 10 }, (_, i) => ({
      time: i + 1,
      open: 100,
      high: 100.1,
      low: 99.9,
      close: 100,
      volume: 100,
    }));
    factor.warmup(flatCandles);

    // Extreme negative delta (Z <= -2.0) while price stalls/ticks up slightly in low-ADX range
    const out = factor.computeFactor({
      symbol: 'SOLUSDT',
      currentPrice: 100.01,
      candles: flatCandles,
      cvd: {
        symbol: 'SOLUSDT',
        cvd: -500,
        buyVolume: 200,
        sellVolume: 700,
        delta: -500,
        openInterestUsd: null,
        timestamp: baseTime,
      },
      indicators: {
        ema9: 100,
        ema21: 100,
        ema50: 100,
        ema200: 100,
        rsi14: 48,
        atr14: 0.2,
        macd: null,
        bollingerBands: null,
        adx14: { adx: 16, pdi: 18, mdi: 19 },
        support: 99.8,
        resistance: 100.2,
        volumeSma20: 100,
      },
      timestamp: baseTime,
    });

    expect(out.bias).toBe('BULLISH');
    expect(out.rawAlpha).toBeGreaterThan(0.4);
  });

  it('[ARCH-02] OrderFlowFactor emits BEARISH on 18.1x Sell flow even when passive Bids exceed Asks', () => {
    const factor = new OrderFlowFactor();
    const out = factor.computeFactor({
      symbol: 'SOLUSDT',
      currentPrice: 100,
      candles: [],
      depth: {
        bids: [{ price: 100, qty: 45000 }], // $4.5M
        asks: [{ price: 101, qty: 32673 }], // $3.3M
      },
      cvd: {
        symbol: 'SOLUSDT',
        cvd: -1710,
        buyVolume: 100,
        sellVolume: 1810,
        delta: -1710,
        openInterestUsd: null,
        timestamp: 1700000000000,
      },
      timestamp: 1700000000000,
    });

    expect(out.bias).toBe('BEARISH');
    expect(out.rawAlpha).toBeLessThan(-0.5);
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
