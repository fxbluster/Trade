/**
 * TradeOS v2 — Alpha Registry & MGS Orthogonalization Unit Tests
 *
 * Verifies:
 * - Factor registration, duplicate prevention, and registry query methods
 * - Lifecycle hooks (initialize, warmup, onCandleClosed, teardown)
 * - Modified Gram-Schmidt (MGS) numerical orthogonality with epsilon = 1e-7
 * - Collinearity detection and zeroing (||u_k||^2 < 1e-6)
 * - Information Ratio (IR) computation and factor sorting
 * - Bayesian Dirichlet-regularized posterior weight synthesis
 * - Composite conviction score S in [0, 100] and directional bias
 */

import { describe, it, expect, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import {
  AlphaRegistry,
  computeInformationRatio,
  dotProduct,
  normSquared,
  mgsOrthogonalizeVectors,
  mgsOrthogonalize,
  dirichletPosterior,
  MGS_EPSILON,
  MGS_COLLINEAR_THRESHOLD,
  type IAlphaFactor,
} from '../src/quant/alphaRegistry.js';
import type {
  FactorEvaluationContext,
  FactorOutput,
  KlineCandle,
} from '@tradeos/shared';

// Helper to create a mock alpha factor
function createMockFactor(
  id: string,
  name: string,
  defaultWeight: number,
  outputStub: Partial<FactorOutput> = {}
): IAlphaFactor {
  return {
    id,
    name,
    defaultWeight,
    initialize: vi.fn().mockResolvedValue(undefined),
    warmup: vi.fn(),
    computeFactor: vi.fn().mockReturnValue({
      factorId: id,
      bias: 'NEUTRAL',
      rawAlpha: 0,
      confidence: 0.5,
      uncertainty: 0.5,
      halfLifeMs: 60_000,
      metadata: {},
      ...outputStub,
    }),
    onCandleClosed: vi.fn(),
    teardown: vi.fn().mockResolvedValue(undefined),
  };
}

describe('AlphaRegistry', () => {
  describe('Factor Registration & Lookup', () => {
    it('registers factors and retrieves them', () => {
      const registry = new AlphaRegistry();
      const f1 = createMockFactor('F1', 'Factor One', 0.5);
      const f2 = createMockFactor('F2', 'Factor Two', 0.5);

      registry.registerFactor(f1);
      registry.registerFactor(f2);

      expect(registry.factorCount).toBe(2);
      expect(registry.getFactorIds()).toEqual(['F1', 'F2']);
      expect(registry.getFactor('F1')).toBe(f1);
      expect(registry.getFactor('F2')).toBe(f2);
      expect(registry.getFactor('UNKNOWN')).toBeUndefined();
    });

    it('throws when registering a factor with duplicate id', () => {
      const registry = new AlphaRegistry();
      const f1 = createMockFactor('F1', 'Factor One', 0.5);
      const f1Duplicate = createMockFactor('F1', 'Factor One Dup', 0.5);

      registry.registerFactor(f1);
      expect(() => registry.registerFactor(f1Duplicate)).toThrowError(
        /already registered/
      );
    });
  });

  describe('Lifecycle Hooks', () => {
    it('propagates initialize to all registered factors with DatabaseSync', async () => {
      const registry = new AlphaRegistry();
      const f1 = createMockFactor('F1', 'Factor One', 0.5);
      const f2 = createMockFactor('F2', 'Factor Two', 0.5);
      registry.registerFactor(f1);
      registry.registerFactor(f2);

      const db = new DatabaseSync(':memory:');
      await registry.initialize(db);

      expect(f1.initialize).toHaveBeenCalledWith(db);
      expect(f2.initialize).toHaveBeenCalledWith(db);
    });

    it('propagates warmup candles to all registered factors', () => {
      const registry = new AlphaRegistry();
      const f1 = createMockFactor('F1', 'Factor One', 0.5);
      registry.registerFactor(f1);

      const candles: KlineCandle[] = [
        { time: 1000, open: 100, high: 105, low: 99, close: 104, volume: 1000 },
      ];
      registry.warmup(candles);

      expect(f1.warmup).toHaveBeenCalledWith(candles);
    });

    it('propagates onCandleClosed event to all factors', () => {
      const registry = new AlphaRegistry();
      const f1 = createMockFactor('F1', 'Factor One', 0.5);
      registry.registerFactor(f1);

      const candle: KlineCandle = {
        time: 2000,
        open: 104,
        high: 108,
        low: 103,
        close: 107,
        volume: 2000,
      };
      registry.onCandleClosed(candle, '15m');

      expect(f1.onCandleClosed).toHaveBeenCalledWith(candle, '15m');
    });

    it('propagates teardown and cleans up registry state', async () => {
      const registry = new AlphaRegistry();
      const f1 = createMockFactor('F1', 'Factor One', 0.5);
      registry.registerFactor(f1);

      await registry.teardown();
      expect(f1.teardown).toHaveBeenCalled();
      expect(registry.factorCount).toBe(0);
      expect(registry.getFactorIds()).toEqual([]);
    });
  });

  describe('Modified Gram-Schmidt (MGS) Numerical Orthogonality', () => {
    it('produces mutually orthogonal vectors within tolerance 1e-6', () => {
      // 3 linearly independent vectors in R^3
      const v1 = [1.0, 0.0, 0.0];
      const v2 = [1.0, 1.0, 0.0];
      const v3 = [1.0, 1.0, 1.0];

      const { orthogonalVectors, isCollinear } = mgsOrthogonalizeVectors(
        [v1, v2, v3],
        MGS_EPSILON
      );

      expect(isCollinear).toEqual([false, false, false]);
      expect(orthogonalVectors).toHaveLength(3);

      const u1 = orthogonalVectors[0]!;
      const u2 = orthogonalVectors[1]!;
      const u3 = orthogonalVectors[2]!;

      // Pairwise inner products must be approximately 0
      const dot12 = dotProduct(u1, u2);
      const dot13 = dotProduct(u1, u3);
      const dot23 = dotProduct(u2, u3);

      expect(Math.abs(dot12)).toBeLessThan(1e-6);
      expect(Math.abs(dot13)).toBeLessThan(1e-6);
      expect(Math.abs(dot23)).toBeLessThan(1e-6);

      // u1 = [1, 0, 0], u2 = [0, 1, 0], u3 = [0, 0, 1]
      expect(u1[0]).toBeCloseTo(1.0, 4);
      expect(u2[1]).toBeCloseTo(1.0, 4);
      expect(u3[2]).toBeCloseTo(1.0, 4);
    });

    it('maintains stability with Tikhonov regularization epsilon = 1e-7 on near-zero vectors', () => {
      const vZero = [1e-9, 1e-9, 1e-9];
      const vNormal = [1.0, 2.0, 3.0];

      const { orthogonalVectors, isCollinear } = mgsOrthogonalizeVectors(
        [vZero, vNormal],
        1e-7
      );

      // vZero norm^2 is < 1e-6, must be marked collinear/zeroed
      expect(isCollinear[0]).toBe(true);
      expect(orthogonalVectors[0]).toEqual([0, 0, 0]);
      // vNormal is non-zero
      expect(isCollinear[1]).toBe(false);
      expect(normSquared(orthogonalVectors[1]!)).toBeGreaterThan(0);
    });

    it('handles convenience wrapper mgsOrthogonalize for 2D vectors and 1D scalars', () => {
      const v = [
        [2, 0],
        [0, 3],
      ];
      const res = mgsOrthogonalize(v);
      expect(res.orthogonalVectors).toHaveLength(2);
      expect(res.isCollinear).toEqual([false, false]);

      const scalars = [0.8, -0.5, 0.2];
      const resScalars = mgsOrthogonalize(scalars);
      expect(resScalars.orthogonalAlphas).toHaveLength(3);
    });
  });

  describe('Collinearity Detection and Zeroing', () => {
    it('flags exact scalar multiples as collinear and zeros their marginal residual', () => {
      // v2 is exactly 2.0 * v1 -> 100% collinear
      const v1 = [1.0, 2.0, 3.0, 4.0];
      const v2 = [2.0, 4.0, 6.0, 8.0];

      const { orthogonalVectors, isCollinear } = mgsOrthogonalizeVectors(
        [v1, v2],
        MGS_EPSILON
      );

      expect(isCollinear[0]).toBe(false);
      expect(isCollinear[1]).toBe(true); // Flagged collinear!
      expect(normSquared(orthogonalVectors[1]!)).toBeLessThan(MGS_COLLINEAR_THRESHOLD);
      expect(orthogonalVectors[1]).toEqual([0, 0, 0, 0]);
    });

    it('zeros weight for collinear factor in Dirichlet posterior', () => {
      const defaultWeights = [0.4, 0.3, 0.3];
      const orthogonalAlphas = [0.8, 0.0, 0.5];
      const isCollinear = [false, true, false]; // Second factor collinear

      const weights = dirichletPosterior(
        defaultWeights,
        orthogonalAlphas,
        isCollinear
      );

      expect(weights[1]).toBe(0.0); // Collinear receives 0 weight!
      expect(weights[0]! + weights[2]!).toBeCloseTo(1.0, 6);
      expect(weights[0]).toBeGreaterThan(0);
      expect(weights[2]).toBeGreaterThan(0);
    });
  });

  describe('Information Ratio (IR) & Factor Sorting', () => {
    it('computes Information Ratio = Mean / (Std + eps)', () => {
      const stablePositive = [0.5, 0.5, 0.5, 0.5];
      const irStable = computeInformationRatio(stablePositive);
      // Std is 0, so IR is large positive
      expect(irStable).toBeGreaterThan(100);

      const noisy = [0.8, -0.6, 0.7, -0.5];
      const irNoisy = computeInformationRatio(noisy);
      expect(irNoisy).toBeLessThan(irStable);

      const negative = [-0.5, -0.6, -0.4];
      const irNegative = computeInformationRatio(negative);
      expect(irNegative).toBeLessThan(0);

      expect(computeInformationRatio([])).toBe(0);
    });

    it('sorts factors descending by IR in evaluate() so best factor gets rank 0', () => {
      const registry = new AlphaRegistry();

      // Factor A: noisy alpha
      const factorA = createMockFactor('A', 'Factor A', 0.5, {
        rawAlpha: 0.1,
      });
      // Factor B: strong consistent alpha
      const factorB = createMockFactor('B', 'Factor B', 0.5, {
        rawAlpha: 0.9,
      });

      registry.registerFactor(factorA);
      registry.registerFactor(factorB);

      const context: FactorEvaluationContext = {
        symbol: 'SOLUSDT',
        currentPrice: 100,
        candles: [],
        timestamp: Date.now(),
      };

      // Run multiple iterations so history accumulates
      for (let i = 0; i < 5; i++) {
        registry.evaluate(context);
      }
      const evalResult = registry.evaluate(context);

      // Factor B has higher rawAlpha and higher IR, so it must be evaluated first (rank 0)
      expect(evalResult.details[0]!.factorId).toBe('B');
      expect(evalResult.details[1]!.factorId).toBe('A');
      expect(evalResult.details[0]!.informationRatio).toBeGreaterThanOrEqual(
        evalResult.details[1]!.informationRatio
      );
    });
  });

  describe('Bayesian Dirichlet Posterior Weight Synthesis', () => {
    it('normalizes weights to sum to 1.0 across active factors', () => {
      const defaults = [0.2, 0.2, 0.2, 0.2, 0.2];
      const alphas = [0.5, 0.3, -0.2, 0.7, 0.1];
      const isCollinear = [false, false, false, false, false];

      const weights = dirichletPosterior(defaults, alphas, isCollinear);
      const sum = weights.reduce((s, w) => s + w, 0);

      expect(sum).toBeCloseTo(1.0, 6);
      weights.forEach((w) => expect(w).toBeGreaterThanOrEqual(0));
    });

    it('upweights factor with stronger orthogonal alpha signal', () => {
      const defaults = [0.5, 0.5];
      const alphas = [0.9, 0.1]; // Factor 0 has much stronger alpha
      const isCollinear = [false, false];

      const weights = dirichletPosterior(defaults, alphas, isCollinear);
      expect(weights[0]).toBeGreaterThan(weights[1]!);
    });

    it('handles all collinear factors gracefully by returning zeros', () => {
      const defaults = [0.5, 0.5];
      const alphas = [0.0, 0.0];
      const isCollinear = [true, true];

      const weights = dirichletPosterior(defaults, alphas, isCollinear);
      expect(weights).toEqual([0, 0]);
    });
  });

  describe('Composite Conviction Score & Directional Bias', () => {
    const dummyContext: FactorEvaluationContext = {
      symbol: 'SOLUSDT',
      currentPrice: 150.0,
      candles: [],
      timestamp: Date.now(),
    };

    it('returns score 50 and NEUTRAL for empty registry', () => {
      const registry = new AlphaRegistry();
      const res = registry.evaluate(dummyContext);

      expect(res.compositeScore).toBe(50);
      expect(res.compositeBias).toBe('NEUTRAL');
      expect(res.rawConviction).toBe(0);
      expect(res.details).toEqual([]);
    });

    it('synthesizes high conviction BULLISH score (S >= 70) when factors are bullish', () => {
      const registry = new AlphaRegistry();
      registry.registerFactor(
        createMockFactor('F1', 'F1', 0.5, { rawAlpha: 0.8, bias: 'BULLISH' })
      );
      registry.registerFactor(
        createMockFactor('F2', 'F2', 0.5, { rawAlpha: 0.7, bias: 'BULLISH' })
      );

      const res = registry.evaluate(dummyContext);
      expect(res.compositeScore).toBeGreaterThanOrEqual(70);
      expect(res.compositeBias).toBe('BULLISH');
      expect(res.rawConviction).toBeGreaterThan(0.1);
    });

    it('synthesizes low conviction BEARISH score (S <= 30) when factors are bearish', () => {
      const registry = new AlphaRegistry();
      registry.registerFactor(
        createMockFactor('F1', 'F1', 0.5, { rawAlpha: -0.8, bias: 'BEARISH' })
      );
      registry.registerFactor(
        createMockFactor('F2', 'F2', 0.5, { rawAlpha: -0.7, bias: 'BEARISH' })
      );

      const res = registry.evaluate(dummyContext);
      expect(res.compositeScore).toBeLessThanOrEqual(30);
      expect(res.compositeBias).toBe('BEARISH');
      expect(res.rawConviction).toBeLessThan(-0.1);
    });

    it('clamps compositeScore strictly within [0, 100]', () => {
      const registry = new AlphaRegistry();
      // Extreme inputs
      registry.registerFactor(
        createMockFactor('F1', 'F1', 1.0, { rawAlpha: 1.0 })
      );
      const resBull = registry.evaluate(dummyContext);
      expect(resBull.compositeScore).toBeLessThanOrEqual(100);
      expect(resBull.compositeScore).toBeGreaterThanOrEqual(0);

      const regBear = new AlphaRegistry();
      regBear.registerFactor(
        createMockFactor('F2', 'F2', 1.0, { rawAlpha: -1.0 })
      );
      const resBear = regBear.evaluate(dummyContext);
      expect(resBear.compositeScore).toBeLessThanOrEqual(100);
      expect(resBear.compositeScore).toBeGreaterThanOrEqual(0);
    });
  });

  describe('Calibrated Weight Overrides', () => {
    const context: FactorEvaluationContext = {
      symbol: 'SOLUSDT',
      currentPrice: 150.0,
      candles: [],
      timestamp: Date.now(),
    };

    it('initializes calibrated weights from factor defaultWeight and returns 0 for unregistered factors', () => {
      const registry = new AlphaRegistry();
      registry.registerFactor(createMockFactor('ORDER_FLOW_L2', 'Order Flow L2', 0.4));
      registry.registerFactor(createMockFactor('CVD_ABSORPTION', 'CVD Absorption', 0.3));

      expect(registry.getCalibratedWeight('ORDER_FLOW_L2')).toBeCloseTo(0.4, 6);
      expect(registry.getCalibratedWeight('CVD_ABSORPTION')).toBeCloseTo(0.3, 6);
      expect(registry.getCalibratedWeight('UNKNOWN_FACTOR')).toBe(0);
    });

    it('clamps calibrated weights to the 0.05 floor in setCalibratedWeight and applyCalibratedWeights', () => {
      const registry = new AlphaRegistry();
      registry.registerFactor(createMockFactor('ORDER_FLOW_L2', 'Order Flow L2', 0.4));
      registry.registerFactor(createMockFactor('CVD_ABSORPTION', 'CVD Absorption', 0.3));

      registry.setCalibratedWeight('ORDER_FLOW_L2', 0.01);
      expect(registry.getCalibratedWeight('ORDER_FLOW_L2')).toBeCloseTo(0.05, 6);

      registry.setCalibratedWeight('CVD_ABSORPTION', -0.25);
      expect(registry.getCalibratedWeight('CVD_ABSORPTION')).toBeCloseTo(0.05, 6);

      registry.applyCalibratedWeights({
        ORDER_FLOW_L2: 0.02,
        CVD_ABSORPTION: 0.65,
      });
      expect(registry.getCalibratedWeight('ORDER_FLOW_L2')).toBeCloseTo(0.05, 6);
      expect(registry.getCalibratedWeight('CVD_ABSORPTION')).toBeCloseTo(0.65, 6);
    });

    it('shifts Dirichlet posterior synthesis weights away from decayed factors while preserving >= 0.05 floor and sum == 1.0', () => {
      const registry = new AlphaRegistry();

      const orderFlow = createMockFactor('ORDER_FLOW_L2', 'Order Flow L2', 0.5);
      vi.mocked(orderFlow.computeFactor)
        .mockReturnValueOnce({
          factorId: 'ORDER_FLOW_L2',
          bias: 'BULLISH',
          rawAlpha: 0.5,
          confidence: 0.8,
          uncertainty: 0.2,
          halfLifeMs: 60_000,
          metadata: {},
        })
        .mockReturnValueOnce({
          factorId: 'ORDER_FLOW_L2',
          bias: 'BEARISH',
          rawAlpha: -0.5,
          confidence: 0.8,
          uncertainty: 0.2,
          halfLifeMs: 60_000,
          metadata: {},
        });

      const cvd = createMockFactor('CVD_ABSORPTION', 'CVD Absorption', 0.5, {
        rawAlpha: 0.5,
        bias: 'BULLISH',
        confidence: 0.8,
      });

      registry.registerFactor(orderFlow);
      registry.registerFactor(cvd);

      // Tick 1: equal calibrated weights (0.5 / 0.5) and equal |alpha| (0.5) -> equal posterior (0.5 / 0.5)
      const before = registry.evaluate(context);
      const beforeOrderFlow = before.details.find((d) => d.factorId === 'ORDER_FLOW_L2')!;
      const beforeCvd = before.details.find((d) => d.factorId === 'CVD_ABSORPTION')!;
      expect(beforeOrderFlow.posteriorWeight).toBeCloseTo(0.5, 6);
      expect(beforeCvd.posteriorWeight).toBeCloseTo(0.5, 6);

      // Decay ORDER_FLOW_L2 below floor (0.01 -> clamped to 0.05)
      registry.applyCalibratedWeights({ ORDER_FLOW_L2: 0.01 });
      expect(registry.getCalibratedWeight('ORDER_FLOW_L2')).toBeCloseTo(0.05, 6);

      // Tick 2: histories [0.5, -0.5] and [0.5, 0.5] are strictly orthogonal (<u1, u2> = 0),
      // both |orthogonalAlpha| = 0.5, so shift is driven solely by calibrated prior weights.
      const after = registry.evaluate(context);
      const afterOrderFlow = after.details.find((d) => d.factorId === 'ORDER_FLOW_L2')!;
      const afterCvd = after.details.find((d) => d.factorId === 'CVD_ABSORPTION')!;

      expect(afterOrderFlow.isCollinear).toBe(false);
      expect(afterCvd.isCollinear).toBe(false);
      expect(afterOrderFlow.posteriorWeight).toBeLessThan(beforeOrderFlow.posteriorWeight);
      expect(afterCvd.posteriorWeight).toBeGreaterThan(beforeCvd.posteriorWeight);
      expect(afterOrderFlow.posteriorWeight).toBeGreaterThanOrEqual(0.05);
      expect(afterOrderFlow.posteriorWeight + afterCvd.posteriorWeight).toBeCloseTo(1.0, 6);
      expect(after.rawConviction).toBeGreaterThan(0);
    });
  });
});
