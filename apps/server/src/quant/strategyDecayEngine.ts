/**
 * TradeOS v2 — Strategy Decay & Autonomous Calibration Engine
 *
 * Implements:
 * 1. CUSUM (Cumulative Sum) change-point detection:
 *    - S_k = max(0, S_{k-1} + (x_k - mu_0) - k)
 *    - Parameter slack: k = 0.5 * sigma
 *    - Decision threshold: h = 4.0 * sigma
 *    - On S_k > h: marks factor decayed, down-scales weight by 50% towards 5.0% floor.
 * 2. Worker Thread Lifecycle & Offloading:
 *    - Offloads 5,000-run Monte Carlo Walk-Forward Analysis (WFA) simulations
 *      to isolated Node.js worker_threads (monteCarloWorker.ts) without blocking event loop.
 */

import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import crypto from 'node:crypto';
import type { AutoPilotState } from '@tradeos/shared';
import type {
  MonteCarloWorkerRequest,
  MonteCarloWorkerResponse,
} from './workers/monteCarloWorker.js';
import { runMonteCarloSimulation } from './workers/monteCarloWorker.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ---------------------------------------------------------------------------
// Types & Contracts
// ---------------------------------------------------------------------------

export interface FactorDecayConfig {
  factorId: string;
  initialWeight: number;
  minWeightFloor?: number; // default: 0.05 (5%)
  mu0?: number;            // default: 0.0 (expected mean performance / zero drift)
  sigma?: number;          // default: 1.0 (baseline standard deviation)
}

export interface FactorDecayState {
  factorId: string;
  initialWeight: number;
  currentWeight: number;
  minWeightFloor: number;
  isDecayed: boolean;
  decayCount: number;
  lastDecayAt?: number;
  cusumS: number;
  cusumUpper: number;
  cusumLower: number;
  mu0: number;
  sigma: number;
  k: number;
  h: number;
  observationCount: number;
  lastObservation?: number;
}

export interface CusumUpdateResult {
  factorId: string;
  observation: number;
  cusumS: number;
  cusumUpper: number;
  cusumLower: number;
  threshold: number;
  isDecayed: boolean;
  currentWeight: number;
  triggered: boolean;
  decayCount: number;
}

export interface StrategyDecayEngineOptions {
  defaultMinWeightFloor?: number; // default 0.05 (5%)
  workerTimeoutMs?: number;       // default 30,000ms
}

// ---------------------------------------------------------------------------
// Worker Path Resolution
// ---------------------------------------------------------------------------

function resolveWorkerPath(): string {
  const tsPath = path.resolve(__dirname, 'workers', 'monteCarloWorker.ts');
  if (fs.existsSync(tsPath)) {
    return tsPath;
  }
  const jsPath = path.resolve(__dirname, 'workers', 'monteCarloWorker.js');
  if (fs.existsSync(jsPath)) {
    return jsPath;
  }
  return tsPath;
}

// ---------------------------------------------------------------------------
// StrategyDecayEngine Class
// ---------------------------------------------------------------------------

export class StrategyDecayEngine {
  private readonly factors: Map<string, FactorDecayState> = new Map();
  private readonly pendingWeightUpdates: Map<string, number> = new Map();
  private readonly defaultMinWeightFloor: number;
  private readonly workerTimeoutMs: number;

  private worker: Worker | null = null;
  private workerReady: boolean = false;
  private pendingRequests: Map<
    string,
    {
      resolve: (res: MonteCarloWorkerResponse) => void;
      reject: (err: Error) => void;
      timeoutTimer: NodeJS.Timeout;
    }
  > = new Map();

  constructor(options: StrategyDecayEngineOptions = {}) {
    this.defaultMinWeightFloor = options.defaultMinWeightFloor ?? 0.05;
    this.workerTimeoutMs = options.workerTimeoutMs ?? 30_000;
  }

  // -------------------------------------------------------------------------
  // Factor Registration & Baseline Calibration
  // -------------------------------------------------------------------------

  /**
   * Register a quantitative factor for decay monitoring.
   */
  public registerFactor(
    factorId: string,
    initialWeight: number,
    options?: {
      minWeightFloor?: number;
      mu0?: number;
      sigma?: number;
    }
  ): FactorDecayState {
    const minWeightFloor = options?.minWeightFloor ?? this.defaultMinWeightFloor;
    const mu0 = options?.mu0 ?? 0.0;
    const sigma = options?.sigma && options.sigma > 0 ? options.sigma : 1.0;
    const k = 0.5 * sigma;
    const h = 4.0 * sigma;

    const state: FactorDecayState = {
      factorId,
      initialWeight,
      currentWeight: initialWeight,
      minWeightFloor,
      isDecayed: false,
      decayCount: 0,
      cusumS: 0,
      cusumUpper: 0,
      cusumLower: 0,
      mu0,
      sigma,
      k,
      h,
      observationCount: 0,
    };

    this.factors.set(factorId, state);
    return state;
  }

  /**
   * Sets or updates baseline parameters (mu0, sigma) for a factor.
   * Recalculates k = 0.5*sigma and h = 4.0*sigma.
   */
  public setBaseline(factorId: string, mu0: number, sigma: number): void {
    const state = this.factors.get(factorId);
    if (!state) {
      throw new Error(`Factor '${factorId}' is not registered in StrategyDecayEngine.`);
    }
    const safeSigma = sigma > 0 ? sigma : 1.0;
    state.mu0 = mu0;
    state.sigma = safeSigma;
    state.k = 0.5 * safeSigma;
    state.h = 4.0 * safeSigma;
  }

  /**
   * Calibrates mu0 and sigma from a sample of baseline historical observations.
   */
  public calibrateBaseline(factorId: string, observations: number[]): void {
    if (observations.length === 0) return;
    const N = observations.length;
    const mean = observations.reduce((a, b) => a + b, 0) / N;
    const variance =
      observations.reduce((acc, v) => acc + (v - mean) * (v - mean), 0) /
      Math.max(1, N - 1);
    const sigma = Math.sqrt(variance);
    this.setBaseline(factorId, mean, sigma > 1e-6 ? sigma : 1.0);
  }

  // -------------------------------------------------------------------------
  // CUSUM Change-Point Detection
  // -------------------------------------------------------------------------

  /**
   * Updates factor state with a new performance observation x_k.
   *
   * Evaluates CUSUM:
   * S_k^+ = max(0, S_{k-1}^+ + (x_k - mu_0) - k)
   * S_k^- = max(0, S_{k-1}^- + (mu_0 - x_k) - k)
   * S_k = max(S_k^+, S_k^-)
   *
   * When S_k > h (4.0 * sigma):
   * - Marks factor as decayed
   * - Scales weight down by 50% toward 5% floor (minWeightFloor)
   * - Resets CUSUM accumulators to 0
   */
  public updateFactor(factorId: string, observation: number): CusumUpdateResult {
    const state = this.factors.get(factorId);
    if (!state) {
      throw new Error(`Factor '${factorId}' is not registered in StrategyDecayEngine.`);
    }

    state.observationCount++;
    state.lastObservation = observation;

    const { mu0, k, h } = state;

    // CUSUM equations with k = 0.5 * sigma
    // Upper shift (e.g. tracking deviation or error expansion)
    const nextUpper = Math.max(0, state.cusumUpper + (observation - mu0) - k);
    // Lower shift (e.g. tracking IC or return deterioration below baseline)
    const nextLower = Math.max(0, state.cusumLower + (mu0 - observation) - k);

    state.cusumUpper = nextUpper;
    state.cusumLower = nextLower;
    // S_k is the maximal deviation across both sides
    state.cusumS = Math.max(nextUpper, nextLower);

    let triggered = false;

    // Check decision threshold h = 4.0 * sigma
    if (state.cusumS > h) {
      triggered = true;
      state.isDecayed = true;
      state.decayCount++;
      state.lastDecayAt = Date.now();

      // Down-scale weight by 50% toward minWeightFloor (default 0.05)
      const downscaled = state.currentWeight * 0.5;
      state.currentWeight = Math.max(state.minWeightFloor, downscaled);
      this.pendingWeightUpdates.set(factorId, state.currentWeight);

      // Reset CUSUM accumulators after change-point trigger
      state.cusumS = 0;
      state.cusumUpper = 0;
      state.cusumLower = 0;
    }

    return {
      factorId,
      observation,
      cusumS: state.cusumS,
      cusumUpper: state.cusumUpper,
      cusumLower: state.cusumLower,
      threshold: h,
      isDecayed: state.isDecayed,
      currentWeight: state.currentWeight,
      triggered,
      decayCount: state.decayCount,
    };
  }

  // -------------------------------------------------------------------------
  // State Inspection & Control
  // -------------------------------------------------------------------------

  public getFactorState(factorId: string): FactorDecayState | undefined {
    return this.factors.get(factorId);
  }

  public getAllFactorStates(): FactorDecayState[] {
    return Array.from(this.factors.values());
  }

  public isFactorDecayed(factorId: string): boolean {
    return this.factors.get(factorId)?.isDecayed ?? false;
  }

  public getFactorWeight(factorId: string): number {
    const factor = this.factors.get(factorId);
    return factor ? factor.currentWeight : 0;
  }

  public setFactorWeight(factorId: string, weight: number): void {
    const factor = this.factors.get(factorId);
    if (factor) {
      const safeWeight = Number.isFinite(weight)
        ? Math.max(factor.minWeightFloor, weight)
        : factor.minWeightFloor;
      factor.currentWeight = safeWeight;
      this.pendingWeightUpdates.set(factorId, factor.currentWeight);
    }
  }

  /**
   * Returns a snapshot of queued factor weight updates awaiting IDLE synchronization.
   */
  public getPendingWeightUpdates(): Record<string, number> {
    return Object.fromEntries(this.pendingWeightUpdates.entries());
  }

  /**
   * IDLE Synchronization Barrier:
   * Applies pending factor weight updates via applyFn and clears the queue ONLY
   * when autoPilotState === 'IDLE', returning true if applied or false otherwise.
   */
  public flushPendingWeightsIfIdle(
    autoPilotState: AutoPilotState | string,
    applyFn: (weights: Record<string, number>) => void
  ): boolean {
    if (autoPilotState !== 'IDLE' || this.pendingWeightUpdates.size === 0) {
      return false;
    }
    const updates = Object.fromEntries(this.pendingWeightUpdates.entries());
    applyFn(updates);
    this.pendingWeightUpdates.clear();
    return true;
  }

  /**
   * Resets decay status and restores factor weight to initial or specified level.
   */
  public resetFactor(factorId: string, restoredWeight?: number): void {
    const state = this.factors.get(factorId);
    if (state) {
      state.isDecayed = false;
      state.cusumS = 0;
      state.cusumUpper = 0;
      state.cusumLower = 0;
      state.currentWeight = restoredWeight ?? state.initialWeight;
    }
  }

  // -------------------------------------------------------------------------
  // Monte Carlo Worker Thread Management
  // -------------------------------------------------------------------------

  /**
   * Ensures the persistent worker thread is spawned and listening.
   */
  private ensureWorker(): Worker {
    if (this.worker && this.workerReady) {
      return this.worker;
    }

    const workerPath = resolveWorkerPath();
    const isTs = workerPath.endsWith('.ts');

    const worker = new Worker(workerPath, {
      execArgv: isTs ? ['--import', 'tsx'] : undefined,
    });

    worker.on('message', (response: MonteCarloWorkerResponse) => {
      const pending = this.pendingRequests.get(response.id);
      if (pending) {
        clearTimeout(pending.timeoutTimer);
        this.pendingRequests.delete(response.id);
        if (response.success) {
          pending.resolve(response);
        } else {
          pending.reject(new Error(response.error ?? 'Monte Carlo simulation failed'));
        }
      }
    });

    worker.on('error', (err: Error) => {
      this.handleWorkerCrash(err);
    });

    worker.on('exit', (code: number) => {
      if (code !== 0) {
        this.handleWorkerCrash(new Error(`Monte Carlo worker exited with code ${code}`));
      }
    });

    this.worker = worker;
    this.workerReady = true;
    return worker;
  }

  private handleWorkerCrash(err: Error): void {
    this.workerReady = false;
    this.worker = null;
    for (const [id, pending] of this.pendingRequests.entries()) {
      clearTimeout(pending.timeoutTimer);
      pending.reject(err);
      this.pendingRequests.delete(id);
    }
  }

  /**
   * Offloads 5,000-run Monte Carlo Walk-Forward Analysis to worker thread.
   * If worker thread fails to spawn, gracefully falls back to inline simulation.
   */
  public async runMonteCarloWfa(
    request: Omit<MonteCarloWorkerRequest, 'id'> & { id?: string }
  ): Promise<MonteCarloWorkerResponse> {
    const requestId = request.id ?? crypto.randomUUID();
    const fullRequest: MonteCarloWorkerRequest = {
      ...request,
      id: requestId,
      iterations: request.iterations ?? 5_000,
    };

    try {
      const worker = this.ensureWorker();
      return await new Promise<MonteCarloWorkerResponse>((resolve, reject) => {
        const timeoutTimer = setTimeout(() => {
          this.pendingRequests.delete(requestId);
          reject(
            new Error(
              `Monte Carlo simulation timed out after ${this.workerTimeoutMs}ms`
            )
          );
        }, this.workerTimeoutMs);

        this.pendingRequests.set(requestId, { resolve, reject, timeoutTimer });
        worker.postMessage(fullRequest);
      });
    } catch {
      // Fallback to inline execution if worker_threads spawn encounters an issue
      return runMonteCarloSimulation(fullRequest);
    }
  }

  /**
   * Runs Monte Carlo simulation directly on the current thread (synchronous/inline).
   */
  public runMonteCarloInline(
    request: Omit<MonteCarloWorkerRequest, 'id'> & { id?: string }
  ): MonteCarloWorkerResponse {
    const requestId = request.id ?? crypto.randomUUID();
    return runMonteCarloSimulation({
      ...request,
      id: requestId,
      iterations: request.iterations ?? 5_000,
    });
  }

  /**
   * Gracefully terminates worker thread and clears all pending requests.
   */
  public async terminateWorker(): Promise<void> {
    if (this.worker) {
      for (const [, pending] of this.pendingRequests.entries()) {
        clearTimeout(pending.timeoutTimer);
        pending.reject(new Error('StrategyDecayEngine worker terminated.'));
      }
      this.pendingRequests.clear();

      await this.worker.terminate();
      this.worker = null;
      this.workerReady = false;
    }
  }

  /**
   * Teardown engine resources.
   */
  public async dispose(): Promise<void> {
    await this.terminateWorker();
    this.factors.clear();
    this.pendingWeightUpdates.clear();
  }
}
