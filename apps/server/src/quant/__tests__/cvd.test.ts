import { describe, it, expect, beforeEach } from 'vitest';
import { CvdEngine } from '../cvd.js';

describe('CvdEngine', () => {
  let engine: CvdEngine;

  beforeEach(() => {
    engine = new CvdEngine('SOLUSDT', 500);
  });

  describe('Initialization and Zero Fabricated Numbers', () => {
    it('initializes with null openInterestUsd (no mock balances or fake OI)', () => {
      const snap = engine.getSnapshot();
      expect(snap.symbol).toBe('SOLUSDT');
      expect(snap.openInterestUsd).toBeNull();
      expect(snap.cvd).toBe(0);
      expect(snap.buyVolume).toBe(0);
      expect(snap.sellVolume).toBe(0);
      expect(snap.delta).toBe(0);
      expect(engine.getCount()).toBe(0);
      expect(engine.getCapacity()).toBe(500);
    });

    it('sets open interest correctly when fetched from exchange', () => {
      engine.setOpenInterest(125430000.50);
      expect(engine.getSnapshot().openInterestUsd).toBe(125430000.50);
      expect(engine.getOpenInterest()).toBe(125430000.50);

      engine.setOpenInterest(null);
      expect(engine.getSnapshot().openInterestUsd).toBeNull();
    });
  });

  describe('Buy/Sell Classification via m (isBuyerMaker) flag', () => {
    it('classifies trade with m=false as aggressive Market BUY (delta > 0)', () => {
      engine.processTrade({
        p: '150.25',
        q: '10.5',
        m: false,
        T: 1700000000000
      });

      const snap = engine.getSnapshot();
      expect(snap.buyVolume).toBe(10.5);
      expect(snap.sellVolume).toBe(0);
      expect(snap.cvd).toBe(10.5);
      expect(snap.delta).toBe(10.5);
      expect(snap.timestamp).toBe(1700000000000);
    });

    it('classifies trade with m=true as aggressive Market SELL (delta < 0)', () => {
      engine.processTrade({
        p: '150.25',
        q: '4.2',
        m: true,
        T: 1700000001000
      });

      const snap = engine.getSnapshot();
      expect(snap.buyVolume).toBe(0);
      expect(snap.sellVolume).toBe(4.2);
      expect(snap.cvd).toBe(-4.2);
      expect(snap.delta).toBe(-4.2);
      expect(snap.timestamp).toBe(1700000001000);
    });

    it('correctly parses string and numeric quantities', () => {
      engine.processTrade({ q: '5.5', m: false });
      engine.processTrade({ q: 2.5, m: true });

      const snap = engine.getSnapshot();
      expect(snap.buyVolume).toBe(5.5);
      expect(snap.sellVolume).toBe(2.5);
      expect(snap.cvd).toBe(3.0);
      expect(snap.delta).toBe(3.0);
    });

    it('ignores invalid or non-positive trade quantities', () => {
      engine.processTrade({ q: 0, m: false });
      engine.processTrade({ q: -5, m: false });
      engine.processTrade({ q: 'invalid', m: true });

      const snap = engine.getSnapshot();
      expect(snap.cvd).toBe(0);
      expect(snap.buyVolume).toBe(0);
      expect(snap.sellVolume).toBe(0);
      expect(engine.getCount()).toBe(0);
    });
  });

  describe('Delta Accumulation and Ring Buffer Sliding', () => {
    it('accumulates multiple trades in 500-sample ring buffer', () => {
      for (let i = 0; i < 100; i++) {
        engine.processTrade({ q: 2, m: false }); // +2
        engine.processTrade({ q: 1, m: true });  // -1
      }
      // 100 * (+2 - 1) = +100
      const snap = engine.getSnapshot();
      expect(snap.buyVolume).toBe(200);
      expect(snap.sellVolume).toBe(100);
      expect(snap.cvd).toBe(100);
      expect(snap.delta).toBe(100);
      expect(engine.getCount()).toBe(200);
    });

    it('slides ring buffer properly when trades exceed capacity', () => {
      const smallEngine = new CvdEngine('SOLUSDT', 5);

      // Add 5 buy trades of 10.0 each (total delta = 50.0)
      for (let i = 0; i < 5; i++) {
        smallEngine.processTrade({ q: 10, m: false });
      }
      expect(smallEngine.getCount()).toBe(5);
      expect(smallEngine.getSnapshot().delta).toBe(50.0);
      expect(smallEngine.getSnapshot().cvd).toBe(50.0);

      // Push 6th trade: Sell trade of 20.0 (delta = -20)
      // Oldest trade (first +10) is replaced with -20
      // Rolling delta should be: 50 - 10 + (-20) = 20.0
      // Cumulative delta (cvd) continues: 50 - 20 = 30.0
      smallEngine.processTrade({ q: 20, m: true });

      expect(smallEngine.getCount()).toBe(5);
      expect(smallEngine.getSnapshot().delta).toBe(20.0);
      expect(smallEngine.getSnapshot().cvd).toBe(30.0);
      expect(smallEngine.getSnapshot().buyVolume).toBe(50.0);
      expect(smallEngine.getSnapshot().sellVolume).toBe(20.0);

      // Verify ring buffer content matches exactly
      const buf = smallEngine.getRingBuffer();
      const sum = buf.reduce((a, b) => a + b, 0);
      expect(sum).toBe(20.0);
    });

    it('accurately tracks 500 trades buffer over 1000 arrivals', () => {
      // 500 buys of 1.0
      for (let i = 0; i < 500; i++) {
        engine.processTrade({ q: 1.0, m: false });
      }
      expect(engine.getSnapshot().delta).toBe(500);

      // Followed by 500 sells of 1.0
      for (let i = 0; i < 500; i++) {
        engine.processTrade({ q: 1.0, m: true });
      }
      // Since ring buffer holds only the last 500 trades, all are sells (-1.0)
      const snap = engine.getSnapshot();
      expect(snap.delta).toBe(-500);
      // Cumulative delta across all 1000 trades is 500 - 500 = 0
      expect(snap.cvd).toBe(0);
      expect(snap.buyVolume).toBe(500);
      expect(snap.sellVolume).toBe(500);
    });
  });

  describe('Reset and Symbol Switching', () => {
    it('preserves openInterestUsd when reset is called for the same symbol', () => {
      engine.setOpenInterest(50000000);
      engine.processTrade({ q: 100, m: false });

      engine.reset(); // Same symbol

      const snap = engine.getSnapshot();
      expect(snap.cvd).toBe(0);
      expect(snap.delta).toBe(0);
      expect(snap.buyVolume).toBe(0);
      expect(snap.sellVolume).toBe(0);
      expect(snap.openInterestUsd).toBe(50000000); // Preserved!
      expect(engine.getCount()).toBe(0);
    });

    it('resets openInterestUsd to null when switched to a new symbol', () => {
      engine.setOpenInterest(50000000);
      engine.processTrade({ q: 100, m: false });

      engine.reset('BTCUSDT'); // New symbol

      const snap = engine.getSnapshot();
      expect(snap.symbol).toBe('BTCUSDT');
      expect(snap.cvd).toBe(0);
      expect(snap.openInterestUsd).toBeNull(); // Reset for new symbol
      expect(engine.getSymbol()).toBe('BTCUSDT');
    });

    it('clears openInterestUsd when clearOi is explicitly set to true', () => {
      engine.setOpenInterest(50000000);
      engine.reset(undefined, true);
      expect(engine.getSnapshot().openInterestUsd).toBeNull();
    });
  });
});
