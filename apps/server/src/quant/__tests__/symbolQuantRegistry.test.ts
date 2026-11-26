import { describe, it, expect } from 'vitest';
import {
  DEFAULT_AUTOPILOT_SYMBOLS,
  parseWatchlistSymbols,
  SymbolQuantRegistry,
} from '../symbolQuantRegistry.js';

describe('parseWatchlistSymbols & SymbolQuantRegistry', () => {
  it('parses, uppercases, trims, deduplicates, and falls back to DEFAULT_AUTOPILOT_SYMBOLS', () => {
    expect(parseWatchlistSymbols(undefined)).toEqual(DEFAULT_AUTOPILOT_SYMBOLS);
    expect(parseWatchlistSymbols('')).toEqual(DEFAULT_AUTOPILOT_SYMBOLS);
    expect(parseWatchlistSymbols('   ')).toEqual(DEFAULT_AUTOPILOT_SYMBOLS);
    expect(parseWatchlistSymbols(' , , ')).toEqual(DEFAULT_AUTOPILOT_SYMBOLS);
    expect(parseWatchlistSymbols(' btcusdt, ethusdt , BTCUSDT, solusdt ')).toEqual([
      'BTCUSDT',
      'ETHUSDT',
      'SOLUSDT',
    ]);
  });

  it('isolates CvdEngine, OrderFlowEngine, NoiseBandEngine, and AlphaRegistry per symbol', () => {
    const registry = new SymbolQuantRegistry({});
    const sol = registry.getOrCreate('SOLUSDT');
    const btc = registry.getOrCreate('btcusdt');

    expect(btc.symbol).toBe('BTCUSDT');
    expect(sol.cvdEngine).not.toBe(btc.cvdEngine);
    expect(sol.noiseBandEngine).not.toBe(btc.noiseBandEngine);
    expect(sol.alphaRegistry).not.toBe(btc.alphaRegistry);
    expect(sol.confluenceEngine).not.toBe(btc.confluenceEngine);
    expect(registry.get('BTCUSDT')).toBe(btc);
    expect(registry.get('ETHUSDT')).toBeUndefined();
    expect(registry.getAll()).toHaveLength(2);

    const now = Date.now();
    btc.cvdEngine.processTrade({ q: 50_000, m: false, T: now });
    btc.confluenceEngine.orderFlowEngine.processTrade(50_000, false, now, 95_000);
    btc.confluenceEngine.orderFlowEngine.updateDepth([[95_000, 100]], [[95_010, 10]]);

    expect(sol.cvdEngine.getSnapshot().delta).toBe(0);
    expect(sol.confluenceEngine.orderFlowEngine.getDepth().bids.length).toBe(0);
    expect(btc.cvdEngine.getSnapshot().delta).toBeGreaterThan(0);
    expect(btc.confluenceEngine.orderFlowEngine.getDepth().bids.length).toBe(1);
  });

  it('propagates consensusThreshold and calibrated weights across all symbol contexts', () => {
    const registry = new SymbolQuantRegistry({});
    const sol = registry.getOrCreate('SOLUSDT');
    const eth = registry.getOrCreate('ETHUSDT');

    registry.setConsensusThreshold(65);
    expect(sol.confluenceEngine.getConsensusThreshold()).toBe(65);
    expect(eth.confluenceEngine.getConsensusThreshold()).toBe(65);

    registry.applyCalibratedWeights({
      ORDER_FLOW_L2: 0.35,
      MACRO_REGIME: 0.28,
    });
    expect(sol.alphaRegistry.getCalibratedWeight('ORDER_FLOW_L2')).toBe(0.35);
    expect(eth.alphaRegistry.getCalibratedWeight('ORDER_FLOW_L2')).toBe(0.35);
    expect(sol.alphaRegistry.getCalibratedWeight('MACRO_REGIME')).toBe(0.28);
    expect(eth.alphaRegistry.getCalibratedWeight('MACRO_REGIME')).toBe(0.28);
    expect(registry.getLatestSnapshot('SOLUSDT')).toBeNull();
  });
});
