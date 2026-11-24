import type { TradeSide } from '@tradeos/shared';
import type { ChasingExecutionEngine, DepthSnapshot, ChasingResult } from './chasingExecutionEngine.js';

export interface TwapSlicerOptions {
  /** Notional threshold (USD) above which TWAP slicing is triggered (default 5000) */
  thresholdUsd?: number;
  /** Number of slices (default 5) */
  numSlices?: number;
  /** Base interval between slices in ms (default 12000) */
  baseIntervalMs?: number;
  /** Jitter fraction +/- (default 0.25 = ±25%) */
  intervalJitterFraction?: number;
  /** Base slice fraction of total (default 1/numSlices = 0.20) */
  sliceFraction?: number;
  /** Slice size jitter +/- (default 0.20 = ±20%) */
  sliceJitterFraction?: number;
}

export interface TwapSliceRecord {
  sliceIndex: number;
  quantity: number;
  intervalMs: number;
  status: 'PENDING' | 'FILLED' | 'CANCELED' | 'ABORTED';
  fillPrice?: number;
  orderId?: string;
}

export interface TwapResult {
  totalQty: number;
  filledQty: number;
  slices: TwapSliceRecord[];
  status: 'COMPLETED' | 'PARTIAL' | 'ABORTED';
}

/**
 * Sequential Stealth TWAP Execution Slicer.
 *
 * Intercepts orders >= $5,000 notional and executes them as 5 randomized
 * child slices (±20% size jitter) with randomized inter-slice intervals
 * (12s ±25%). Slices execute strictly sequentially via ChasingExecutionEngine.
 */
export class TwapExecutionSlicer {
  private readonly thresholdUsd: number;
  private readonly numSlices: number;
  private readonly baseIntervalMs: number;
  private readonly intervalJitterFraction: number;
  private readonly sliceJitterFraction: number;

  constructor(
    private readonly engine: ChasingExecutionEngine,
    options: TwapSlicerOptions = {}
  ) {
    this.thresholdUsd = options.thresholdUsd ?? 5_000;
    this.numSlices = options.numSlices ?? 5;
    this.baseIntervalMs = options.baseIntervalMs ?? 12_000;
    this.intervalJitterFraction = options.intervalJitterFraction ?? 0.25;
    this.sliceJitterFraction = options.sliceJitterFraction ?? 0.20;
  }

  /**
   * Check if the notional exceeds the TWAP threshold.
   */
  shouldSlice(notionalUsd: number): boolean {
    return notionalUsd >= this.thresholdUsd;
  }

  /**
   * Generate randomized child slice quantities that conserve total quantity.
   * Base weight per slice = 1/numSlices. Each slice gets ±20% jitter.
   * Final slice absorbs the rounding remainder to conserve total.
   */
  generateSliceQuantities(totalQty: number): number[] {
    const base = totalQty / this.numSlices;
    const slices: number[] = [];
    let allocated = 0;

    for (let i = 0; i < this.numSlices - 1; i++) {
      const jitter = 1 + (Math.random() * 2 - 1) * this.sliceJitterFraction;
      const qty = base * jitter;
      slices.push(qty);
      allocated += qty;
    }

    // Final slice = remainder to conserve total quantity
    const remainder = totalQty - allocated;
    slices.push(Math.max(remainder, 0));
    return slices;
  }

  /**
   * Generate randomized inter-slice intervals.
   * Base 12s ±25%.
   */
  generateIntervals(): number[] {
    const intervals: number[] = [];
    for (let i = 0; i < this.numSlices - 1; i++) {
      const jitter = 1 + (Math.random() * 2 - 1) * this.intervalJitterFraction;
      intervals.push(this.baseIntervalMs * jitter);
    }
    return intervals;
  }

  /**
   * Execute a large order via sequential stealth TWAP slicing.
   *
   * @param symbol - Symbol (e.g. 'BTCUSDT')
   * @param side - 'BUY' | 'SELL'
   * @param totalQty - Total quantity to execute
   * @param anchorPrice - Current mark price (anchor for runaway guard)
   * @param getDepth - Supplier for real-time order book depth
   * @param checkFill - Check if a given orderId is filled
   * @param placeOrder - Place initial GTX limit order at given price, returns orderId
   */
  async execute(params: {
    symbol: string;
    side: TradeSide;
    totalQty: number;
    anchorPrice: number;
    getDepth: () => Promise<DepthSnapshot>;
    checkFill: (orderId: string) => Promise<{ fillPrice: number; fillQty: number } | null>;
    placeOrder: (price: number, qty: number) => Promise<string>;
  }): Promise<TwapResult> {
    const { symbol, side, totalQty, anchorPrice } = params;

    const sliceQtys = this.generateSliceQuantities(totalQty);
    const intervals = this.generateIntervals();

    const sliceRecords: TwapSliceRecord[] = sliceQtys.map((qty, i) => ({
      sliceIndex: i,
      quantity: qty,
      intervalMs: i < intervals.length ? intervals[i] : 0,
      status: 'PENDING',
    }));

    let totalFilled = 0;

    for (let i = 0; i < this.numSlices; i++) {
      const record = sliceRecords[i];
      const sliceQty = record.quantity;

      // Execute slice k via ChasingExecutionEngine
      let result: ChasingResult;
      try {
        result = await this.engine.chase({
          symbol,
          side,
          quantity: sliceQty,
          anchorPrice,
          getDepth: params.getDepth,
          checkFill: params.checkFill,
          placeOrder: (price) => params.placeOrder(price, sliceQty),
        });
      } catch {
        record.status = 'ABORTED';
        // Abort remaining slices on unexpected error
        for (let j = i + 1; j < this.numSlices; j++) {
          sliceRecords[j].status = 'ABORTED';
        }
        return {
          totalQty,
          filledQty: totalFilled,
          slices: sliceRecords,
          status: totalFilled > 0 ? 'PARTIAL' : 'ABORTED',
        };
      }

      record.orderId = result.orderId;

      if (result.status === 'FILLED') {
        record.status = 'FILLED';
        record.fillPrice = result.fillPrice;
        totalFilled += sliceQty;
      } else if (result.status === 'CANCELLED') {
        record.status = 'CANCELED';
      } else {
        // TIMEOUT or ABORTED
        record.status = 'ABORTED';
        // Abort remaining slices
        for (let j = i + 1; j < this.numSlices; j++) {
          sliceRecords[j].status = 'ABORTED';
        }
        return {
          totalQty,
          filledQty: totalFilled,
          slices: sliceRecords,
          status: totalFilled > 0 ? 'PARTIAL' : 'ABORTED',
        };
      }

      // Wait the randomized interval before next slice (not after the last one)
      if (i < this.numSlices - 1) {
        await sleep(record.intervalMs);
      }
    }

    const allFilled = sliceRecords.every((s) => s.status === 'FILLED');
    return {
      totalQty,
      filledQty: totalFilled,
      slices: sliceRecords,
      status: allFilled ? 'COMPLETED' : 'PARTIAL',
    };
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
