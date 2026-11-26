/**
 * TradeOS v2 — Pluggable Alpha Factor Registry
 *
 * Implements:
 * - IAlphaFactor backend execution interface
 * - AlphaRegistry with lifecycle management
 * - Modified Gram-Schmidt (MGS) orthogonalization with Tikhonov regularization (epsilon=1e-7)
 * - Bayesian Dirichlet-regularized posterior weight synthesis
 * - Composite conviction score synthesis in [0, 100]
 */

import type { DatabaseSync } from 'node:sqlite';
import type {
  FactorOutput,
  FactorDetail,
  FactorEvaluationContext,
  KlineCandle,
} from '@tradeos/shared';

export type { FactorDetail };

// ---------------------------------------------------------------------------
// IAlphaFactor — Backend Execution Interface
// ---------------------------------------------------------------------------

export interface IAlphaFactor {
  readonly id: string;
  readonly name: string;
  readonly defaultWeight: number;
  initialize(db: DatabaseSync): Promise<void>;
  warmup(candles: KlineCandle[]): void;
  computeFactor(context: FactorEvaluationContext): FactorOutput;
  onCandleClosed(candle: KlineCandle, interval: string): void;
  teardown(): Promise<void>;
}

export interface CompositeFactorEvaluation {
  compositeBias: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
  compositeScore: number; // [0, 100]
  rawConviction: number;  // [-1, 1] before normalization
  details: FactorDetail[];
  evaluatedAt: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const MGS_WINDOW = 60;
export const MGS_EPSILON = 1e-7;
export const MGS_COLLINEAR_THRESHOLD = 1e-6;
export const DIRICHLET_ALPHA = 1.0; // Dirichlet prior concentration
export const MIN_CALIBRATED_WEIGHT = 0.05;

interface FactorWindowState {
  alphaHistory: number[]; // rolling window of rawAlpha values
}

// ---------------------------------------------------------------------------
// AlphaRegistry
// ---------------------------------------------------------------------------

export class AlphaRegistry {
  private readonly factors: IAlphaFactor[] = [];
  private readonly windowStates: Map<string, FactorWindowState> = new Map();
  private readonly calibratedWeights: Map<string, number> = new Map();
  private db: DatabaseSync | null = null;

  /**
   * Register a new alpha factor.
   */
  public registerFactor(factor: IAlphaFactor): void {
    if (this.factors.some((f) => f.id === factor.id)) {
      throw new Error(`Factor with id '${factor.id}' is already registered.`);
    }
    this.factors.push(factor);
    this.windowStates.set(factor.id, { alphaHistory: [] });
    this.calibratedWeights.set(factor.id, factor.defaultWeight);
  }

  /**
   * Get registered factor by id.
   */
  public getFactor(id: string): IAlphaFactor | undefined {
    return this.factors.find((f) => f.id === id);
  }

  /**
   * Initialize all registered factors (connects to DB, loads historical state).
   */
  public async initialize(db: DatabaseSync): Promise<void> {
    this.db = db;
    for (const factor of this.factors) {
      await factor.initialize(db);
    }
  }

  /**
   * Warm up all factors with historical candles.
   */
  public warmup(candles: KlineCandle[]): void {
    for (const factor of this.factors) {
      factor.warmup(candles);
    }
  }

  /**
   * Dispatch candle-closed event to all factors.
   */
  public onCandleClosed(candle: KlineCandle, interval: string): void {
    for (const factor of this.factors) {
      factor.onCandleClosed(candle, interval);
    }
  }

  /**
   * Override calibrated prior weight for a factor (clamped to >= 0.05 floor).
   */
  public setCalibratedWeight(factorId: string, weight: number): void {
    const safeWeight = Number.isFinite(weight)
      ? Math.max(MIN_CALIBRATED_WEIGHT, weight)
      : MIN_CALIBRATED_WEIGHT;
    this.calibratedWeights.set(factorId, safeWeight);
  }

  /**
   * Batch-apply calibrated prior weights from StrategyDecayEngine or config.
   */
  public applyCalibratedWeights(weights: Record<string, number>): void {
    for (const [factorId, weight] of Object.entries(weights)) {
      this.setCalibratedWeight(factorId, weight);
    }
  }

  /**
   * Get active prior weight for a factor (calibrated override, registered default, or 0).
   */
  public getCalibratedWeight(factorId: string): number {
    const calibrated = this.calibratedWeights.get(factorId);
    if (calibrated !== undefined) {
      return calibrated;
    }
    return this.getFactor(factorId)?.defaultWeight ?? 0;
  }

  /**
   * Tear down all registered factors.
   */
  public async teardown(): Promise<void> {
    for (const factor of this.factors) {
      await factor.teardown();
    }
    this.factors.length = 0;
    this.windowStates.clear();
    this.calibratedWeights.clear();
    this.db = null;
  }

  /**
   * Evaluate all registered factors and produce an orthogonalized composite signal.
   *
   * Pipeline:
   * 1. Compute raw factor outputs.
   * 2. Update sliding window history.
   * 3. Sort factors descending by Information Ratio:
   *    IR_i = Mean(alpha_i) / (Std(alpha_i) + eps) over sliding window (N=60).
   * 4. Modified Gram-Schmidt orthogonalization with Tikhonov regularization (epsilon=1e-7).
   *    Subtract projection onto earlier orthogonal basis vectors:
   *    u_k = u_k - (<u_k, u_j> / (<u_j, u_j> + eps)) * u_j.
   *    If ||u_k||^2 < 1e-6, flag factor as collinear and set marginal weight to 0.
   * 5. Bayesian Dirichlet-regularized posterior weight synthesis.
   * 6. Synthesize composite conviction score S in [0, 100], composite bias, and per-factor details.
   */
  public evaluate(context: FactorEvaluationContext): CompositeFactorEvaluation {
    if (this.factors.length === 0) {
      return {
        compositeBias: 'NEUTRAL',
        compositeScore: 50,
        rawConviction: 0,
        details: [],
        evaluatedAt: Date.now(),
      };
    }

    // 1. Compute raw outputs
    const outputs: FactorOutput[] = this.factors.map((f) =>
      f.computeFactor(context)
    );

    // 2. Update sliding-window history
    for (let i = 0; i < this.factors.length; i++) {
      const factor = this.factors[i]!;
      const output = outputs[i]!;
      const state = this.windowStates.get(factor.id)!;
      state.alphaHistory.push(output.rawAlpha);
      if (state.alphaHistory.length > MGS_WINDOW) {
        state.alphaHistory.shift();
      }
    }

    // 3. Compute Information Ratios and sort descending
    const factorEntries = this.factors.map((factor, i) => {
      const state = this.windowStates.get(factor.id)!;
      const ir = computeInformationRatio(state.alphaHistory);
      return { factor, output: outputs[i]!, ir, history: state.alphaHistory.slice() };
    });
    factorEntries.sort((a, b) => b.ir - a.ir);

    // 4. MGS Orthogonalization over sliding-window history vectors
    const maxHistLen = Math.max(...factorEntries.map((e) => e.history.length));

    let orthogonalAlphas: number[];
    let isCollinear: boolean[];

    // Only run MGS across factors when history dimension >= number of factors (and >= 2)
    // to avoid rank-deficiency artificially zeroing active factors on early ticks.
    if (maxHistLen >= Math.max(2, factorEntries.length)) {
      // Separate time-varying factors from steady-state (constant) factors so slow-timeframe
      // factors (e.g. 1h MACRO_REGIME, 15m NATIVE_SMC) are not projected onto each other's
      // constant subspace and zeroed as collinear.
      const varyingIndices: number[] = [];
      const varyingVectors: number[][] = [];

      for (let k = 0; k < factorEntries.length; k++) {
        const h = factorEntries[k]!.history;
        const padded =
          h.length < maxHistLen
            ? [...new Array(maxHistLen - h.length).fill(h[0] ?? 0), ...h]
            : h;
        if (!isConstantSeries(padded)) {
          varyingIndices.push(k);
          varyingVectors.push(padded);
        }
      }

      isCollinear = factorEntries.map((e) => Math.abs(e.output.rawAlpha) <= 1e-6);
      orthogonalAlphas = factorEntries.map((e) =>
        Math.abs(e.output.rawAlpha) <= 1e-6 ? 0 : e.output.rawAlpha
      );

      if (varyingVectors.length >= 2) {
        const res = mgsOrthogonalizeVectors(varyingVectors);
        for (let idx = 0; idx < varyingIndices.length; idx++) {
          const k = varyingIndices[idx]!;
          isCollinear[k] = res.isCollinear[idx]!;
          if (res.isCollinear[idx]) {
            orthogonalAlphas[k] = 0;
          } else {
            const v = res.orthogonalVectors[idx]!;
            const lastVal = v[v.length - 1] ?? 0;
            orthogonalAlphas[k] = Math.max(-1.0, Math.min(1.0, lastVal));
          }
        }
      }
    } else {
      // Early ticks before history dimension >= factor count: factors are independent
      isCollinear = factorEntries.map((e) => Math.abs(e.output.rawAlpha) <= 1e-6);
      orthogonalAlphas = factorEntries.map((e) =>
        Math.abs(e.output.rawAlpha) <= 1e-6 ? 0 : e.output.rawAlpha
      );
    }

    // 5. Bayesian Dirichlet-regularized posterior weight synthesis
    const priorWeights = factorEntries.map((e) =>
      this.getCalibratedWeight(e.factor.id)
    );
    const posteriorWeights = dirichletPosterior(
      priorWeights,
      orthogonalAlphas,
      isCollinear,
      DIRICHLET_ALPHA
    );

    // 6. Synthesize composite conviction
    let rawConviction = 0;
    for (let k = 0; k < factorEntries.length; k++) {
      if (!isCollinear[k]) {
        rawConviction += orthogonalAlphas[k]! * posteriorWeights[k]!;
      }
    }
    rawConviction = Math.max(-1, Math.min(1, rawConviction));

    // Map rawConviction [-1, 1] to composite score [0, 100]
    const compositeScore = Math.round(50 + rawConviction * 50);

    // Determine bias with threshold 0.10
    let compositeBias: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
    if (rawConviction > 0.10) {
      compositeBias = 'BULLISH';
    } else if (rawConviction < -0.10) {
      compositeBias = 'BEARISH';
    } else {
      compositeBias = 'NEUTRAL';
    }

    // Build details
    const details: FactorDetail[] = factorEntries.map((entry, k) => ({
      factorId: entry.factor.id,
      name: entry.factor.name,
      rawAlpha: entry.output.rawAlpha,
      orthogonalAlpha: orthogonalAlphas[k]!,
      posteriorWeight: posteriorWeights[k]!,
      bias: entry.output.bias,
      confidence: entry.output.confidence,
      isCollinear: isCollinear[k]!,
      informationRatio: entry.ir,
    }));

    return {
      compositeBias,
      compositeScore,
      rawConviction,
      details,
      evaluatedAt: Date.now(),
    };
  }

  /** Return registered factor count */
  public get factorCount(): number {
    return this.factors.length;
  }

  /** Return copy of registered factor ids */
  public getFactorIds(): string[] {
    return this.factors.map((f) => f.id);
  }
}

// ---------------------------------------------------------------------------
// Mathematical Helpers
// ---------------------------------------------------------------------------

/** Check if a time series has near-zero variance (steady-state / slow-timeframe factor) */
function isConstantSeries(history: number[], stdThreshold: number = 1e-4): boolean {
  if (history.length < 2) return true;
  const mean = history.reduce((s, v) => s + v, 0) / history.length;
  const variance =
    history.reduce((s, v) => s + (v - mean) ** 2, 0) / history.length;
  return Math.sqrt(variance) < stdThreshold;
}

/**
 * Compute Information Ratio of a time series over sliding window:
 * IR = Mean(alpha) / (Std(alpha) + eps)
 */
export function computeInformationRatio(history: number[], epsilon: number = MGS_EPSILON): number {
  if (!history || history.length === 0) return 0;
  const n = history.length;
  const mean = history.reduce((s, v) => s + v, 0) / n;
  if (n === 1) return mean / (Math.abs(mean) * 0.1 + epsilon);

  const variance =
    history.reduce((s, v) => s + (v - mean) ** 2, 0) / (n - 1);
  const std = Math.sqrt(variance);
  return mean / (std + epsilon);
}

/** Vector dot product: <a, b> */
export function dotProduct(a: number[], b: number[]): number {
  const len = Math.min(a.length, b.length);
  let sum = 0;
  for (let i = 0; i < len; i++) {
    sum += a[i]! * b[i]!;
  }
  return sum;
}

/** Vector squared L2 norm: ||a||^2 */
export function normSquared(a: number[]): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    sum += a[i]! * a[i]!;
  }
  return sum;
}

/**
 * Modified Gram-Schmidt (MGS) Orthogonalization with Tikhonov regularization (epsilon = 1e-7).
 *
 * For each vector k:
 *   u_k = v_k
 * For j = 0 to M - 1:
 *   For k = j + 1 to M - 1:
 *     u_k = u_k - (<u_k, u_j> / (<u_j, u_j> + eps)) * u_j
 *
 * If ||u_k||^2 < 1e-6, flag factor as collinear and set to zero.
 */
export function mgsOrthogonalizeVectors(
  vectors: number[][],
  epsilon: number = MGS_EPSILON
): {
  orthogonalVectors: number[][];
  isCollinear: boolean[];
} {
  const M = vectors.length;
  if (M === 0) {
    return { orthogonalVectors: [], isCollinear: [] };
  }

  const D = vectors[0]!.length;
  const u: number[][] = vectors.map((v) => v.slice());
  const isCollinear: boolean[] = new Array(M).fill(false);

  for (let j = 0; j < M; j++) {
    const uj_normSq = normSquared(u[j]!);
    if (uj_normSq < MGS_COLLINEAR_THRESHOLD) {
      isCollinear[j] = true;
      u[j] = new Array(D).fill(0);
      continue;
    }

    for (let k = j + 1; k < M; k++) {
      const dot_kj = dotProduct(u[k]!, u[j]!);
      const projScale = dot_kj / (uj_normSq + epsilon);
      for (let d = 0; d < D; d++) {
        u[k]![d] -= projScale * u[j]![d]!;
      }
    }
  }

  // Check remaining norms for collinearity
  for (let k = 0; k < M; k++) {
    if (!isCollinear[k] && normSquared(u[k]!) < MGS_COLLINEAR_THRESHOLD) {
      isCollinear[k] = true;
      u[k] = new Array(D).fill(0);
    }
  }

  return { orthogonalVectors: u, isCollinear };
}

/**
 * Convenience wrapper for 1D scalar or 2D vector arrays.
 */
export function mgsOrthogonalize(
  inputs: number[] | number[][],
  epsilon: number = MGS_EPSILON
): {
  orthogonalAlphas: number[];
  orthogonalVectors?: number[][];
  isCollinear: boolean[];
} {
  if (inputs.length === 0) {
    return { orthogonalAlphas: [], isCollinear: [] };
  }

  if (Array.isArray(inputs[0])) {
    const res = mgsOrthogonalizeVectors(inputs as number[][], epsilon);
    const orthogonalAlphas = res.orthogonalVectors.map(
      (v, k) => (res.isCollinear[k] ? 0 : v[v.length - 1] ?? 0)
    );
    return {
      orthogonalAlphas,
      orthogonalVectors: res.orthogonalVectors,
      isCollinear: res.isCollinear,
    };
  } else {
    // 1D scalars wrapped into 2D [val, index] vectors
    const scalars = inputs as number[];
    const vectors = scalars.map((val, idx) => [val, idx === 0 ? 1 : 0]);
    const res = mgsOrthogonalizeVectors(vectors, epsilon);
    const orthogonalAlphas = res.orthogonalVectors.map(
      (v, k) => (res.isCollinear[k] ? 0 : v[0] ?? 0)
    );
    return {
      orthogonalAlphas,
      orthogonalVectors: res.orthogonalVectors,
      isCollinear: res.isCollinear,
    };
  }
}

/**
 * Bayesian Dirichlet-regularized posterior weight synthesis.
 */
export function dirichletPosterior(
  defaultWeights: number[],
  orthogonalAlphas: number[],
  isCollinear: boolean[],
  concentration: number = DIRICHLET_ALPHA
): number[] {
  const M = defaultWeights.length;
  if (M === 0) return [];

  const sumDefault = defaultWeights.reduce((s, w) => s + w, 0) || 1;
  const prior = defaultWeights.map((w) => concentration * (w / sumDefault));

  const posterior = prior.map((p, k) => {
    if (isCollinear[k]) return 0;
    return p + Math.abs(orthogonalAlphas[k] ?? 0);
  });

  const sumPosterior = posterior.reduce((s, v) => s + v, 0);
  if (sumPosterior < MGS_EPSILON) {
    const nonCollinearCount = isCollinear.filter((c) => !c).length;
    if (nonCollinearCount === 0) {
      return new Array(M).fill(0);
    }
    return posterior.map((_, k) => (isCollinear[k] ? 0 : 1 / nonCollinearCount));
  }

  return posterior.map((v) => v / sumPosterior);
}
