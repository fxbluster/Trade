import { describe, it, expect, beforeEach } from 'vitest';
import { OrderFlowEngine } from '../orderFlowEngine.js';

describe('OrderFlowEngine — [DEF-04 / ARCH-15] Imbalance Winsorization', () => {
  let engine: OrderFlowEngine;

  beforeEach(() => {
    engine = new OrderFlowEngine();
  });

  it('clamps extreme negative taker imbalance to -500% when opposite volume is tiny', () => {
    const now = Date.now();
    engine.processTrade(1786.2, true, now, 100);
    engine.processTrade(0.01, false, now + 10, 100);

    const res = engine.evaluateL2(100, now + 20);
    expect(res.bias).toBe('BEARISH');
    expect(res.confirmed).toBe(true);
    expect(res.valueText).toBe('-500% Sell Imbalance');
  });

  it('clamps extreme positive taker imbalance to +500% when opposite flow is zero', () => {
    const now = Date.now();
    engine.processTrade(5000, false, now, 100);

    const res = engine.evaluateL2(100, now + 20);
    expect(res.bias).toBe('BULLISH');
    expect(res.confirmed).toBe(true);
    expect(res.valueText).toBe('+500% Buy Imbalance');
  });

  it('clamps extreme L2 book depth imbalance to [-500%, +500%]', () => {
    const now = Date.now();
    engine.updateDepth([[100, 0.001]], [[101, 10000]]);

    const res = engine.evaluateL2(100, now);
    expect(res.bias).toBe('BEARISH');
    expect(res.confirmed).toBe(true);
    expect(res.valueText).toBe('-500% Sell Imbalance');
  });

  it('preserves moderate imbalance percentages within [-500%, +500%]', () => {
    const now = Date.now();
    engine.processTrade(40, false, now, 100);
    engine.processTrade(10, true, now + 10, 100);

    const res = engine.evaluateL2(100, now + 20);
    expect(res.bias).toBe('BULLISH');
    expect(res.confirmed).toBe(true);
    expect(res.valueText).toBe('+300% Buy Imbalance');
  });
});
