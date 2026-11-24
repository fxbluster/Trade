import { describe, it, expect, vi } from 'vitest';
import { TwapExecutionSlicer } from '../src/services/twapExecutionSlicer.js';
import { ChasingExecutionEngine } from '../src/services/chasingExecutionEngine.js';
import type { BrokerAdapter } from '../src/exchange/broker.js';

function createMockBroker(): BrokerAdapter {
  return {
    mode: 'LOCAL_PAPER',
    getAccount: vi.fn(),
    getPosition: vi.fn(),
    openOrder: vi.fn(),
    createAlgoOrder: vi.fn(),
    closePosition: vi.fn(),
    cancelOrder: vi.fn().mockResolvedValue(true),
    cancelAllOrders: vi.fn().mockResolvedValue(true),
    moveToBreakeven: vi.fn(),
    getOpenOrders: vi.fn(),
    modifyOrder: vi.fn().mockResolvedValue({ status: 'NEW' }),
  };
}

describe('TwapExecutionSlicer', () => {
  const broker = createMockBroker();
  const engine = new ChasingExecutionEngine(broker);
  const slicer = new TwapExecutionSlicer(engine, {
    thresholdUsd: 5000,
    numSlices: 5,
    baseIntervalMs: 50, // Short intervals for fast tests
  });

  describe('Threshold & Slicing Configuration', () => {
    it('intercepts orders >= $5,000 threshold', () => {
      expect(slicer.shouldSlice(4999)).toBe(false);
      expect(slicer.shouldSlice(5000)).toBe(true);
      expect(slicer.shouldSlice(10000)).toBe(true);
    });

    it('conserves total quantity exactly across all 5 child slices', () => {
      const totalQty = 100.0;
      const slices = slicer.generateSliceQuantities(totalQty);

      expect(slices.length).toBe(5);
      const sum = slices.reduce((acc, q) => acc + q, 0);
      expect(sum).toBeCloseTo(totalQty, 6);
    });

    it('applies ±20% size jitter around base child size', () => {
      const totalQty = 6500; // base = 1300
      const slices = slicer.generateSliceQuantities(totalQty);

      expect(slices.length).toBe(5);
      // First 4 slices should be within [1300 * 0.80, 1300 * 1.20] = [1040, 1560]
      for (let i = 0; i < 4; i++) {
        expect(slices[i]).toBeGreaterThanOrEqual(1040 * 0.99);
        expect(slices[i]).toBeLessThanOrEqual(1560 * 1.01);
      }
    });

    it('applies ±25% timing jitter to intervals', () => {
      const intervals = slicer.generateIntervals();
      expect(intervals.length).toBe(4); // 4 intervals between 5 slices
      for (const interval of intervals) {
        // Base 50ms -> [37.5ms, 62.5ms]
        expect(interval).toBeGreaterThanOrEqual(37.5 * 0.99);
        expect(interval).toBeLessThanOrEqual(62.5 * 1.01);
      }
    });
  });

  describe('Sequential Execution Flow', () => {
    it('executes child slices strictly sequentially and completes', async () => {
      const executedOrderIds: string[] = [];
      let activeOrderCount = 0;
      let maxConcurrentOrders = 0;

      // Mock engine.chase to track sequence
      const spyChase = vi.spyOn(engine, 'chase').mockImplementation(async (params) => {
        activeOrderCount++;
        maxConcurrentOrders = Math.max(maxConcurrentOrders, activeOrderCount);
        const orderId = `child_${executedOrderIds.length + 1}`;
        executedOrderIds.push(orderId);
        // Small delay to simulate in-flight execution
        await new Promise((r) => setTimeout(r, 10));
        activeOrderCount--;
        return {
          orderId,
          status: 'FILLED',
          fillPrice: 50000,
          fillQty: params.quantity,
          amendCount: 0,
        };
      });

      const result = await slicer.execute({
        symbol: 'BTCUSDT',
        side: 'BUY',
        totalQty: 10,
        anchorPrice: 50000,
        getDepth: async () => ({ bestBid: 50000, bestAsk: 50001 }),
        checkFill: async () => ({ fillPrice: 50000, fillQty: 2 }),
        placeOrder: async (_p, _q) => 'placed_id',
      });

      expect(result.status).toBe('COMPLETED');
      expect(result.slices.length).toBe(5);
      expect(result.filledQty).toBeCloseTo(10, 6);
      expect(executedOrderIds.length).toBe(5);
      // Strictly sequential: at most 1 active order at any moment
      expect(maxConcurrentOrders).toBe(1);

      spyChase.mockRestore();
    });

    it('aborts remaining slices if a child slice encounters timeout/abort', async () => {
      let callCount = 0;
      const spyChase = vi.spyOn(engine, 'chase').mockImplementation(async () => {
        callCount++;
        if (callCount === 2) {
          return {
            orderId: 'child_2_timeout',
            status: 'TIMEOUT',
            amendCount: 1,
          };
        }
        return {
          orderId: `child_${callCount}`,
          status: 'FILLED',
          fillPrice: 50000,
          fillQty: 2,
          amendCount: 0,
        };
      });

      const result = await slicer.execute({
        symbol: 'BTCUSDT',
        side: 'BUY',
        totalQty: 10,
        anchorPrice: 50000,
        getDepth: async () => ({ bestBid: 50000, bestAsk: 50001 }),
        checkFill: async () => null,
        placeOrder: async () => 'placed_id',
      });

      expect(result.status).toBe('PARTIAL');
      expect(callCount).toBe(2); // Aborted after slice 2; slices 3, 4, 5 not called
      expect(result.slices[0].status).toBe('FILLED');
      expect(result.slices[1].status).toBe('ABORTED');
      expect(result.slices[2].status).toBe('ABORTED');

      spyChase.mockRestore();
    });
  });
});
