/**
 * TradeOS v2 — Monte Carlo Walk-Forward Analysis (WFA) Worker Thread
 *
 * Runs 5,000-iteration Monte Carlo bootstrap simulations off the main event loop.
 * Evaluates:
 * - 95% and 99% Value-at-Risk (VaR)
 * - Maximum Drawdown (MDD) confidence intervals (50th, 95th, 99th percentiles)
 * - Expected and median cumulative return
 * - Path-averaged Sharpe ratio and probability of capital loss
 */

import { parentPort, isMainThread } from 'node:worker_threads';

// ---------------------------------------------------------------------------
// Worker Message Contracts
// ---------------------------------------------------------------------------

export interface MonteCarloWorkerRequest {
  id: string;
  returns: number[];
  initialEquity?: number;
  iterations?: number;
  confidenceLevel?: number;
  seed?: number;
}

export interface MonteCarloWorkerResponse {
  id: string;
  success: boolean;
  error?: string;
  durationMs: number;
  iterations: number;
  sampleSize: number;
  var95: number;
  var99: number;
  expectedReturn: number;
  medianReturn: number;
  maxDrawdownMean: number;
  maxDrawdownMedian: number;
  maxDrawdown95: number;
  maxDrawdown99: number;
  worstCaseDrawdown: number;
  sharpeRatioMean: number;
  probabilityOfLoss: number;
}

// ---------------------------------------------------------------------------
// Deterministic 32-bit PRNG (Mulberry32)
// ---------------------------------------------------------------------------

function createMulberry32(seed: number) {
  let s = seed >>> 0;
  return function next(): number {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------------
// Pure Simulation Logic
// ---------------------------------------------------------------------------

/**
 * Runs 5,000 (or custom N) Monte Carlo bootstrap simulation paths.
 */
export function runMonteCarloSimulation(
  request: MonteCarloWorkerRequest
): MonteCarloWorkerResponse {
  const startMs = Date.now();
  const {
    id,
    returns,
    initialEquity = 10_000,
    iterations = 5_000,
    seed = 42,
  } = request;

  if (!returns || returns.length === 0) {
    return {
      id,
      success: false,
      error: 'Empty or invalid returns array provided',
      durationMs: Date.now() - startMs,
      iterations: 0,
      sampleSize: 0,
      var95: 0,
      var99: 0,
      expectedReturn: 0,
      medianReturn: 0,
      maxDrawdownMean: 0,
      maxDrawdownMedian: 0,
      maxDrawdown95: 0,
      maxDrawdown99: 0,
      worstCaseDrawdown: 0,
      sharpeRatioMean: 0,
      probabilityOfLoss: 0,
    };
  }

  const K = returns.length;
  const prng = createMulberry32(seed);

  const finalReturns: number[] = new Array(iterations);
  const maxDrawdowns: number[] = new Array(iterations);
  const sharpeRatios: number[] = new Array(iterations);
  let lossCount = 0;

  for (let m = 0; m < iterations; m++) {
    let currentEquity = initialEquity;
    let peakEquity = initialEquity;
    let mdd = 0;

    let sumR = 0;
    let sumSqR = 0;

    for (let t = 0; t < K; t++) {
      const idx = Math.floor(prng() * K);
      const r = returns[idx]!;

      sumR += r;
      sumSqR += r * r;

      currentEquity += r;
      if (currentEquity > peakEquity) {
        peakEquity = currentEquity;
      }

      if (peakEquity > 0) {
        const dd = (peakEquity - currentEquity) / peakEquity;
        if (dd > mdd) {
          mdd = dd;
        }
      }
    }

    const pathReturn = (currentEquity - initialEquity) / initialEquity;
    finalReturns[m] = pathReturn;
    maxDrawdowns[m] = mdd;

    if (pathReturn < 0) {
      lossCount++;
    }

    const meanR = sumR / K;
    const varianceR = Math.max(0, sumSqR / K - meanR * meanR);
    const stdR = Math.sqrt(varianceR);
    sharpeRatios[m] = stdR > 1e-8 ? meanR / stdR : 0;
  }

  // Sort distributions for percentile extraction
  finalReturns.sort((a, b) => a - b);
  maxDrawdowns.sort((a, b) => a - b);

  // Value-at-Risk (lower tail of returns)
  // 95% VaR is the 5th percentile return
  const idxVar95 = Math.max(0, Math.min(iterations - 1, Math.floor(iterations * 0.05)));
  const idxVar99 = Math.max(0, Math.min(iterations - 1, Math.floor(iterations * 0.01)));
  const var95 = finalReturns[idxVar95]!;
  const var99 = finalReturns[idxVar99]!;

  // Mean & median return
  const expectedReturn = finalReturns.reduce((acc, v) => acc + v, 0) / iterations;
  const medianReturn = finalReturns[Math.floor(iterations * 0.5)]!;

  // Drawdown percentiles
  const maxDrawdownMean = maxDrawdowns.reduce((acc, v) => acc + v, 0) / iterations;
  const maxDrawdownMedian = maxDrawdowns[Math.floor(iterations * 0.5)]!;
  const idxMdd95 = Math.max(0, Math.min(iterations - 1, Math.floor(iterations * 0.95)));
  const idxMdd99 = Math.max(0, Math.min(iterations - 1, Math.floor(iterations * 0.99)));
  const maxDrawdown95 = maxDrawdowns[idxMdd95]!;
  const maxDrawdown99 = maxDrawdowns[idxMdd99]!;
  const worstCaseDrawdown = maxDrawdowns[iterations - 1]!;

  // Mean Sharpe
  const sharpeRatioMean = sharpeRatios.reduce((acc, v) => acc + v, 0) / iterations;
  const probabilityOfLoss = lossCount / iterations;

  return {
    id,
    success: true,
    durationMs: Date.now() - startMs,
    iterations,
    sampleSize: K,
    var95,
    var99,
    expectedReturn,
    medianReturn,
    maxDrawdownMean,
    maxDrawdownMedian,
    maxDrawdown95,
    maxDrawdown99,
    worstCaseDrawdown,
    sharpeRatioMean,
    probabilityOfLoss,
  };
}

// ---------------------------------------------------------------------------
// Worker Thread Event Listener
// ---------------------------------------------------------------------------

if (!isMainThread && parentPort) {
  parentPort.on('message', (request: MonteCarloWorkerRequest) => {
    try {
      const response = runMonteCarloSimulation(request);
      parentPort?.postMessage(response);
    } catch (err) {
      parentPort?.postMessage({
        id: request?.id ?? 'error',
        success: false,
        error: err instanceof Error ? err.message : String(err),
        durationMs: 0,
        iterations: 0,
        sampleSize: 0,
        var95: 0,
        var99: 0,
        expectedReturn: 0,
        medianReturn: 0,
        maxDrawdownMean: 0,
        maxDrawdownMedian: 0,
        maxDrawdown95: 0,
        maxDrawdown99: 0,
        worstCaseDrawdown: 0,
        sharpeRatioMean: 0,
        probabilityOfLoss: 0,
      });
    }
  });
}
