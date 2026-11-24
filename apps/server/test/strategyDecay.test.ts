/**
 * TradeOS v2 — Strategy Decay & Autonomous Calibration Unit Tests
 *
 * Verifies:
 * - CUSUM change-point detection (S_k = max(0, S_{k-1} + (x_k - mu_0) - k))
 * - Slack k = 0.5 * sigma and decision threshold h = 4.0 * sigma
 * - Factor decay trigger on simulated decaying series
 * - Down-scaling weight by 50% on trigger toward 5% floor
 * - Multiple consecutive triggers clamping at 5% floor
 * - Node.js worker_threads offloading for 5,000-run Monte Carlo WFA
 * - Worker messaging, VaR 95%, and Max Drawdown confidence intervals
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  StrategyDecayEngine,
  type FactorDecayState,
} from '../src/quant/strategyDecayEngine.js';
import { AlphaRegistry } from '../src/quant/alphaRegistry.js';

describe('StrategyDecayEngine & CUSUM Change-Point Detection', () => {
  let engine: StrategyDecayEngine;

  beforeEach(() => {
    engine = new StrategyDecayEngine({
      defaultMinWeightFloor: 0.05,
      workerTimeoutMs: 15_000,
    });
  });

  afterEach(async () => {
    await engine.dispose();
  });

  describe('Factor Registration & Initialization', () => {
    it('registers factor with default weights and calculates k and h thresholds', () => {
      const state = engine.registerFactor('ORDER_FLOW_L2', 0.20, {
        mu0: 0.0,
        sigma: 1.0,
        minWeightFloor: 0.05,
      });

      expect(state.factorId).toBe('ORDER_FLOW_L2');
      expect(state.currentWeight).toBe(0.20);
      expect(state.minWeightFloor).toBe(0.05);
      expect(state.isDecayed).toBe(false);
      expect(state.cusumS).toBe(0);
      // k = 0.5 * sigma = 0.5
      expect(state.k).toBeCloseTo(0.5, 4);
      // h = 4.0 * sigma = 4.0
      expect(state.h).toBeCloseTo(4.0, 4);
    });

    it('calibrates baseline from historical sample', () => {
      engine.registerFactor('NATIVE_SMC', 0.20);
      // Sample with mean ~ 0.10, std ~ 0.05
      const baseline = [0.08, 0.12, 0.09, 0.11, 0.10, 0.10, 0.13, 0.07];
      engine.calibrateBaseline('NATIVE_SMC', baseline);

      const state = engine.getFactorState('NATIVE_SMC')!;
      expect(state.mu0).toBeCloseTo(0.10, 2);
      expect(state.sigma).toBeGreaterThan(0);
      expect(state.k).toBeCloseTo(0.5 * state.sigma, 4);
      expect(state.h).toBeCloseTo(4.0 * state.sigma, 4);
    });
  });

  describe('Stationary Series (No Decay Triggered)', () => {
    it('does not trigger decay on stationary noise around mean', () => {
      engine.registerFactor('MACRO_REGIME', 0.18, { mu0: 0.0, sigma: 1.0 });

      // Observations fluctuating around mu0 within slack k = 0.5
      const stationarySeries = [0.2, -0.3, 0.1, -0.2, 0.3, -0.1, 0.4, -0.4];

      for (const val of stationarySeries) {
        const res = engine.updateFactor('MACRO_REGIME', val);
        expect(res.triggered).toBe(false);
        expect(res.isDecayed).toBe(false);
        expect(res.currentWeight).toBe(0.18);
        expect(res.cusumS).toBeLessThan(4.0);
      }
    });
  });

  describe('CUSUM Trigger on Simulated Decaying Series (h = 4.0 * sigma)', () => {
    it('triggers CUSUM when cumulative drift exceeds h = 4.0 * sigma', () => {
      // mu0 = 0.0, sigma = 1.0 -> k = 0.5, h = 4.0
      engine.registerFactor('CVD_ABSORPTION', 0.20, {
        mu0: 0.0,
        sigma: 1.0,
        minWeightFloor: 0.05,
      });

      // Drift observations: each observation = 1.5
      // Delta per step = (1.5 - 0.0) - 0.5 = 1.0
      // Step 1: S_1 = 1.0
      // Step 2: S_2 = 2.0
      // Step 3: S_3 = 3.0
      // Step 4: S_4 = 4.0 (equal to h, not strictly > h)
      // Step 5: S_5 = 5.0 (> 4.0 -> TRIGGERS DECAY)

      const r1 = engine.updateFactor('CVD_ABSORPTION', 1.5);
      expect(r1.triggered).toBe(false);
      expect(r1.cusumS).toBeCloseTo(1.0, 4);

      const r2 = engine.updateFactor('CVD_ABSORPTION', 1.5);
      expect(r2.triggered).toBe(false);
      expect(r2.cusumS).toBeCloseTo(2.0, 4);

      const r3 = engine.updateFactor('CVD_ABSORPTION', 1.5);
      expect(r3.triggered).toBe(false);
      expect(r3.cusumS).toBeCloseTo(3.0, 4);

      const r4 = engine.updateFactor('CVD_ABSORPTION', 1.5);
      expect(r4.triggered).toBe(false);
      expect(r4.cusumS).toBeCloseTo(4.0, 4);

      const r5 = engine.updateFactor('CVD_ABSORPTION', 1.5);
      expect(r5.triggered).toBe(true);
      expect(r5.isDecayed).toBe(true);
      expect(r5.decayCount).toBe(1);

      // Down-scaled by 50%: 0.20 -> 0.10
      expect(r5.currentWeight).toBeCloseTo(0.10, 4);

      // CUSUM accumulators reset after trigger
      expect(r5.cusumS).toBe(0);
    });

    it('detects negative performance deterioration (downward alpha collapse)', () => {
      // Baseline healthy IC: mu0 = 0.20, sigma = 0.10 -> k = 0.05, h = 0.40
      engine.registerFactor('FUNDING_ARBITRAGE', 0.15, {
        mu0: 0.20,
        sigma: 0.10,
        minWeightFloor: 0.05,
      });

      // Factor decays with negative returns/IC = -0.10
      // Lower delta per step = (mu0 - x_k) - k = (0.20 - (-0.10)) - 0.05 = 0.25
      // Step 1: S_1 = 0.25 < 0.40
      // Step 2: S_2 = 0.50 > 0.40 -> TRIGGERS

      const s1 = engine.updateFactor('FUNDING_ARBITRAGE', -0.10);
      expect(s1.triggered).toBe(false);
      expect(s1.cusumS).toBeCloseTo(0.25, 4);

      const s2 = engine.updateFactor('FUNDING_ARBITRAGE', -0.10);
      expect(s2.triggered).toBe(true);
      expect(s2.isDecayed).toBe(true);
      // Down-scaled by 50%: 0.15 -> 0.075
      expect(s2.currentWeight).toBeCloseTo(0.075, 4);
    });
  });

  describe('Down-scaling by 50% Toward 5% Floor', () => {
    it('clamps weight at 5% floor across multiple consecutive decay triggers', () => {
      // Initial weight: 0.20, Floor: 0.05 (5%)
      engine.registerFactor('CROSS_EXCHANGE_SWEEP', 0.20, {
        mu0: 0.0,
        sigma: 1.0,
        minWeightFloor: 0.05,
      });

      // Helper to trigger decay once (observation = 5.0 -> S = (5.0 - 0.5) = 4.5 > 4.0)
      const triggerOnce = () => engine.updateFactor('CROSS_EXCHANGE_SWEEP', 5.0);

      // 1st decay: 0.20 -> 0.10
      const dec1 = triggerOnce();
      expect(dec1.triggered).toBe(true);
      expect(dec1.currentWeight).toBeCloseTo(0.10, 4);
      expect(dec1.decayCount).toBe(1);

      // 2nd decay: 0.10 -> 0.05 (exact 5% floor reached)
      const dec2 = triggerOnce();
      expect(dec2.triggered).toBe(true);
      expect(dec2.currentWeight).toBeCloseTo(0.05, 4);
      expect(dec2.decayCount).toBe(2);

      // 3rd decay: 0.05 * 0.5 = 0.025, but clamped to 0.05 floor!
      const dec3 = triggerOnce();
      expect(dec3.triggered).toBe(true);
      expect(dec3.currentWeight).toBeCloseTo(0.05, 4);
      expect(dec3.decayCount).toBe(3);

      // 4th decay: stays clamped at 0.05
      const dec4 = triggerOnce();
      expect(dec4.triggered).toBe(true);
      expect(dec4.currentWeight).toBeCloseTo(0.05, 4);
      expect(dec4.decayCount).toBe(4);
    });

    it('allows resetting factor back to healthy initial state', () => {
      engine.registerFactor('LIQ_CLUSTERS', 0.08, { mu0: 0.0, sigma: 1.0 });
      engine.updateFactor('LIQ_CLUSTERS', 5.0);

      expect(engine.isFactorDecayed('LIQ_CLUSTERS')).toBe(true);
      expect(engine.getFactorWeight('LIQ_CLUSTERS')).toBeCloseTo(0.05, 4); // clamped floor

      engine.resetFactor('LIQ_CLUSTERS');
      expect(engine.isFactorDecayed('LIQ_CLUSTERS')).toBe(false);
      expect(engine.getFactorWeight('LIQ_CLUSTERS')).toBeCloseTo(0.08, 4);
    });
  });

  describe('Monte Carlo Worker Thread Offloading (5,000 WFA Simulations)', () => {
    it('executes 5,000 Monte Carlo bootstrap paths via worker thread off the main event loop', async () => {
      const sampleReturns = [
        0.015, -0.008, 0.022, -0.012, 0.005, 0.031, -0.025, 0.018, -0.004,
        0.011, 0.007, -0.015, 0.028, -0.009, 0.014, -0.002, 0.019, -0.011,
      ];

      const response = await engine.runMonteCarloWfa({
        returns: sampleReturns,
        iterations: 5_000,
        initialEquity: 10_000,
        seed: 12345,
      });

      expect(response.success).toBe(true);
      expect(response.iterations).toBe(5_000);
      expect(response.sampleSize).toBe(sampleReturns.length);
      expect(response.durationMs).toBeGreaterThan(0);

      // 95% VaR must be a finite number
      expect(typeof response.var95).toBe('number');
      expect(Number.isFinite(response.var95)).toBe(true);

      // 99% VaR is more adverse than or equal to 95% VaR
      expect(response.var99).toBeLessThanOrEqual(response.var95);

      // Drawdown confidence intervals
      expect(response.maxDrawdownMean).toBeGreaterThan(0);
      expect(response.maxDrawdownMedian).toBeGreaterThan(0);
      expect(response.maxDrawdown95).toBeGreaterThanOrEqual(response.maxDrawdownMedian);
      expect(response.maxDrawdown99).toBeGreaterThanOrEqual(response.maxDrawdown95);
      expect(response.worstCaseDrawdown).toBeGreaterThanOrEqual(response.maxDrawdown99);

      // Return & Sharpe telemetry
      expect(typeof response.expectedReturn).toBe('number');
      expect(typeof response.sharpeRatioMean).toBe('number');
      expect(response.probabilityOfLoss).toBeGreaterThanOrEqual(0);
      expect(response.probabilityOfLoss).toBeLessThanOrEqual(1);
    });

    it('produces consistent deterministic results when given fixed PRNG seed', () => {
      const returns = [0.02, -0.01, 0.015, -0.025, 0.03];
      const r1 = engine.runMonteCarloInline({
        returns,
        iterations: 1_000,
        initialEquity: 10_000,
        seed: 999,
      });
      const r2 = engine.runMonteCarloInline({
        returns,
        iterations: 1_000,
        initialEquity: 10_000,
        seed: 999,
      });

      expect(r1.var95).toBeCloseTo(r2.var95, 6);
      expect(r1.maxDrawdown95).toBeCloseTo(r2.maxDrawdown95, 6);
      expect(r1.expectedReturn).toBeCloseTo(r2.expectedReturn, 6);
    });

    it('gracefully handles empty returns array', async () => {
      const response = await engine.runMonteCarloWfa({
        returns: [],
        iterations: 100,
      });

      expect(response.success).toBe(false);
      expect(response.error).toContain('Empty or invalid returns');
    });
  });

  describe('IDLE Synchronization Barrier', () => {
    it('queues decayed factor weights on CUSUM trigger and blocks application during LIMIT_CHASING and POSITION_OPEN until IDLE', () => {
      engine.registerFactor('ORDER_FLOW_L2', 0.40, {
        mu0: 0.0,
        sigma: 1.0,
        minWeightFloor: 0.05,
      });

      // Trigger CUSUM decay: (5.0 - 0.0) - 0.5 = 4.5 > 4.0 -> 0.40 * 0.5 = 0.20
      const res = engine.updateFactor('ORDER_FLOW_L2', 5.0);
      expect(res.triggered).toBe(true);
      expect(res.currentWeight).toBeCloseTo(0.20, 4);
      expect(engine.getPendingWeightUpdates()).toEqual({ ORDER_FLOW_L2: 0.20 });

      const applyFn = vi.fn();

      // Blocked during active chasing or open position
      expect(engine.flushPendingWeightsIfIdle('LIMIT_CHASING', applyFn)).toBe(false);
      expect(applyFn).not.toHaveBeenCalled();
      expect(engine.getPendingWeightUpdates()).toEqual({ ORDER_FLOW_L2: 0.20 });

      expect(engine.flushPendingWeightsIfIdle('POSITION_OPEN', applyFn)).toBe(false);
      expect(applyFn).not.toHaveBeenCalled();
      expect(engine.getPendingWeightUpdates()).toEqual({ ORDER_FLOW_L2: 0.20 });

      // Applied when AutoPilot transitions to IDLE and queue is cleared
      expect(engine.flushPendingWeightsIfIdle('IDLE', applyFn)).toBe(true);
      expect(applyFn).toHaveBeenCalledTimes(1);
      expect(applyFn).toHaveBeenCalledWith({ ORDER_FLOW_L2: 0.20 });
      expect(engine.getPendingWeightUpdates()).toEqual({});

      // Subsequent IDLE flush with empty queue returns false and does not re-apply
      expect(engine.flushPendingWeightsIfIdle('IDLE', applyFn)).toBe(false);
      expect(applyFn).toHaveBeenCalledTimes(1);
    });

    it('does not queue pending updates when CUSUM update does not trigger decay', () => {
      engine.registerFactor('MACRO_REGIME', 0.25, { mu0: 0.0, sigma: 1.0 });

      const res = engine.updateFactor('MACRO_REGIME', 0.2);
      expect(res.triggered).toBe(false);
      expect(engine.getPendingWeightUpdates()).toEqual({});

      const applyFn = vi.fn();
      expect(engine.flushPendingWeightsIfIdle('IDLE', applyFn)).toBe(false);
      expect(applyFn).not.toHaveBeenCalled();
    });

    it('queues manual setFactorWeight changes (clamped to floor) and syncs with AlphaRegistry at IDLE', () => {
      const registry = new AlphaRegistry();
      registry.registerFactor({
        id: 'CVD_ABSORPTION',
        name: 'CVD Absorption',
        defaultWeight: 0.30,
        initialize: async () => {},
        warmup: () => {},
        computeFactor: () => ({
          factorId: 'CVD_ABSORPTION',
          bias: 'NEUTRAL',
          rawAlpha: 0,
          confidence: 0.5,
          uncertainty: 0.5,
          halfLifeMs: 60_000,
          metadata: {},
        }),
        onCandleClosed: () => {},
        teardown: async () => {},
      });

      engine.registerFactor('CVD_ABSORPTION', 0.30, { minWeightFloor: 0.05 });
      engine.setFactorWeight('CVD_ABSORPTION', 0.01);

      expect(engine.getPendingWeightUpdates()).toEqual({ CVD_ABSORPTION: 0.05 });
      expect(
        engine.flushPendingWeightsIfIdle('EVALUATING', (w) =>
          registry.applyCalibratedWeights(w)
        )
      ).toBe(false);
      expect(registry.getCalibratedWeight('CVD_ABSORPTION')).toBeCloseTo(0.30, 6);

      expect(
        engine.flushPendingWeightsIfIdle('IDLE', (w) =>
          registry.applyCalibratedWeights(w)
        )
      ).toBe(true);
      expect(registry.getCalibratedWeight('CVD_ABSORPTION')).toBeCloseTo(0.05, 6);
      expect(engine.getPendingWeightUpdates()).toEqual({});
    });
  });
});
