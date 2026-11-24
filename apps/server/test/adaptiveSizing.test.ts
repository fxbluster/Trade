import { describe, it, expect } from 'vitest';
import {
  AdaptiveSizingEngine,
  calculateRawMargin,
  getSizingArchetype,
  calculateQuarterKelly,
  calculateVolatilityParity,
  calculateDrawdownCircuit,
} from '../src/quant/adaptiveSizingEngine.js';

describe('AdaptiveSizingEngine', () => {
  const engine = new AdaptiveSizingEngine();

  describe('Convex Formula & Archetype Mapping', () => {
    it('evaluates Sub-Threshold (< 70) as vetoed with 0 margin', () => {
      expect(getSizingArchetype(65)).toBe('Sub-Threshold');
      expect(calculateRawMargin(65)).toBe(0);

      const result = engine.calculateSizing({
        confluenceScore: 68,
        walletBalance: 10000,
        availableBalance: 10000,
      });
      expect(result.archetype).toBe('Sub-Threshold');
      expect(result.finalMarginPct).toBe(0);
      expect(result.marginUsd).toBe(0);
      expect(result.notionalUsd).toBe(0);
    });

    it('evaluates Exploratory Probe (70 - 74) starting at 5% base', () => {
      expect(getSizingArchetype(70)).toBe('Exploratory Probe');
      expect(calculateRawMargin(70)).toBe(0.05);

      const result = engine.calculateSizing({
        confluenceScore: 70,
        walletBalance: 10000,
        availableBalance: 10000,
        fKelly: 1.0,
        wVol: 1.0,
      });
      expect(result.archetype).toBe('Exploratory Probe');
      expect(result.finalMarginPct).toBe(0.05);
      expect(result.marginUsd).toBe(500);
      expect(result.notionalUsd).toBe(5000); // 10x leverage
    });

    it('evaluates Standard Institutional (75 - 84)', () => {
      expect(getSizingArchetype(80)).toBe('Standard Institutional');
      const raw = calculateRawMargin(80);
      expect(raw).toBeGreaterThan(0.075);
      expect(raw).toBeLessThan(0.165);
    });

    it('evaluates High-Conviction Core (85 - 94)', () => {
      expect(getSizingArchetype(90)).toBe('High-Conviction Core');
      const raw = calculateRawMargin(90);
      expect(raw).toBeGreaterThan(0.165);
      expect(raw).toBeLessThan(0.255);
    });

    it('evaluates A+ Institutional Setup (95 - 100) reaching 30% cap', () => {
      expect(getSizingArchetype(100)).toBe('A+ Institutional Setup');
      expect(calculateRawMargin(100)).toBe(0.30);

      const result = engine.calculateSizing({
        confluenceScore: 100,
        walletBalance: 10000,
        availableBalance: 10000,
        fKelly: 1.0,
        wVol: 1.0,
      });
      expect(result.archetype).toBe('A+ Institutional Setup');
      expect(result.finalMarginPct).toBe(0.30);
      expect(result.marginUsd).toBe(3000);
      expect(result.notionalUsd).toBe(30000);
    });
  });

  describe('Quarter-Kelly Dampener', () => {
    it('clamps Kelly dampener to [0.50, 1.00]', () => {
      // Extremely low win rate -> floors at 0.50
      const lowKelly = calculateQuarterKelly({ winRate: 0.10, rewardRiskRatio: 1.0 });
      expect(lowKelly).toBe(0.50);

      // Extremely high win rate -> caps at 1.00
      const highKelly = calculateQuarterKelly({ winRate: 0.95, rewardRiskRatio: 3.0 });
      expect(highKelly).toBe(1.00);
    });

    it('smoothes win-rate with Beta(12, 8) prior', () => {
      // Prior mean is 12 / 20 = 0.60
      const defaultKelly = calculateQuarterKelly({});
      expect(defaultKelly).toBeGreaterThanOrEqual(0.50);
      expect(defaultKelly).toBeLessThanOrEqual(1.00);
    });
  });

  describe('Volatility Parity', () => {
    it('clamps W_Vol = Median(ATR_100)/ATR_14 to [0.60, 1.25]', () => {
      // Low volatility regime: Median(100) = 2.0, ATR(14) = 1.0 -> ratio 2.0 -> clamped to 1.25
      const lowVol = calculateVolatilityParity(2.0, 1.0);
      expect(lowVol).toBe(1.25);

      // High volatility regime: Median(100) = 1.0, ATR(14) = 2.5 -> ratio 0.4 -> clamped to 0.60
      const highVol = calculateVolatilityParity(1.0, 2.5);
      expect(highVol).toBe(0.60);

      // Equal volatility -> 1.00
      const equalVol = calculateVolatilityParity(1.5, 1.5);
      expect(equalVol).toBe(1.00);
    });
  });

  describe('Drawdown Circuit Breakers', () => {
    it('throttles margin allocation based on consecutive losses', () => {
      expect(calculateDrawdownCircuit(0)).toBe(1.00);
      expect(calculateDrawdownCircuit(1)).toBe(1.00);
      expect(calculateDrawdownCircuit(2)).toBe(0.75);
      expect(calculateDrawdownCircuit(3)).toBe(0.50);
      expect(calculateDrawdownCircuit(4)).toBe(0.00); // Circuit Lock
      expect(calculateDrawdownCircuit(5)).toBe(0.00);
    });

    it('returns 0 margin when Circuit Lock is triggered (4 consecutive losses)', () => {
      const result = engine.calculateSizing({
        confluenceScore: 95,
        walletBalance: 10000,
        availableBalance: 10000,
        consecutiveLosses: 4,
      });

      expect(result.circuitMultiplier).toBe(0);
      expect(result.finalMarginPct).toBe(0);
      expect(result.marginUsd).toBe(0);
    });
  });

  describe('Hard Solvency Airbag (20%)', () => {
    it('fails solvency airbag if available balance < 20% of wallet balance', () => {
      const result = engine.calculateSizing({
        confluenceScore: 90,
        walletBalance: 10000,
        availableBalance: 1500, // < 2000 (20% airbag)
      });

      expect(result.solvencyAirbagOk).toBe(false);
      expect(result.finalMarginPct).toBe(0);
      expect(result.marginUsd).toBe(0);
    });

    it('clamps margin so that post-trade available balance preserves 20% airbag', () => {
      // Wallet = 10,000, minReserve = 2,000. Available = 2,600.
      // Max allowed margin = 600.
      const result = engine.calculateSizing({
        confluenceScore: 95, // raw margin ~24.5% -> 2,450 USD
        walletBalance: 10000,
        availableBalance: 2600,
        fKelly: 1.0,
        wVol: 1.0,
      });

      expect(result.solvencyAirbagOk).toBe(true);
      expect(result.marginUsd).toBe(600);
      expect(result.finalMarginPct).toBe(0.06);
    });
  });

  describe('5% to 30% Dynamic Clamping', () => {
    it('never allocates below 5% for valid trades (score >= 70)', () => {
      const result = engine.calculateSizing({
        confluenceScore: 71,
        walletBalance: 10000,
        availableBalance: 10000,
        fKelly: 0.50, // heavy Kelly penalty
        wVol: 0.60,   // heavy vol penalty
        circuitMultiplier: 0.75, // 2 losses
      });

      // Raw unadjusted = ~0.05 * 0.50 * 0.60 * 0.75 = 0.01125
      // Clamped to minimum 0.05
      expect(result.finalMarginPct).toBe(0.05);
    });

    it('never allocates above 30% cap', () => {
      const result = engine.calculateSizing({
        confluenceScore: 100,
        walletBalance: 10000,
        availableBalance: 10000,
        fKelly: 1.00,
        wVol: 1.25, // vol bonus
      });

      // Raw unadjusted = 0.30 * 1.25 = 0.375
      // Clamped to maximum 0.30
      expect(result.finalMarginPct).toBe(0.30);
    });
  });
});
