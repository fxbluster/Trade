import { describe, it, expect, vi } from 'vitest';
import { ChasingExecutionEngine } from '../src/services/chasingExecutionEngine.js';
import { TwapExecutionSlicer } from '../src/services/twapExecutionSlicer.js';
import type { BrokerAdapter } from '../src/exchange/broker.js';
import { BinanceApiError } from '../src/exchange/binanceClient.js';

function createMockBroker(modifyOrderImpl?: (symbol: string, orderId: string | number, price: number, qty: number) => Promise<any>): BrokerAdapter {
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
    modifyOrder: vi.fn(modifyOrderImpl || (async () => ({ status: 'NEW' }))),
  };
}

describe('ChasingExecutionEngine', () => {
  describe('Penny-Jumping Arithmetic', () => {
    const broker = createMockBroker();
    const engine = new ChasingExecutionEngine(broker, { tickSize: 0.01, passiveOffsetTicks: 0 });

    it('BUY: penny-jumps inside wide spread', () => {
      // With passiveOffsetTicks: 0, joins bestBid = 100.00 (no aggressive cross-spread jump)
      const price = engine.computeTargetBuy(100.00, 100.10);
      expect(price).toBeCloseTo(100.00, 4);
    });

    it('BUY: falls back to bestBid when spread <= 1 tick', () => {
      // spread = 100.01 - 100.00 = 0.01 <= 0.01 -> joins bestBid
      const price = engine.computeTargetBuy(100.00, 100.01);
      expect(price).toBe(100.00);
    });

    it('SELL: penny-jumps inside wide spread', () => {
      // With passiveOffsetTicks: 0, joins bestAsk = 100.10 (no aggressive cross-spread jump)
      const price = engine.computeTargetSell(100.00, 100.10);
      expect(price).toBeCloseTo(100.10, 4);
    });

    it('SELL: falls back to bestAsk when spread <= 1 tick', () => {
      // spread = 100.01 - 100.00 = 0.01 <= 0.01 -> joins bestAsk
      const price = engine.computeTargetSell(100.00, 100.01);
      expect(price).toBe(100.01);
    });
  });

  describe('Execution Flow', () => {
    it('successfully fills order on first check without amendments', async () => {
      const broker = createMockBroker();
      const engine = new ChasingExecutionEngine(broker, { debouncMs: 50, timeoutMs: 2000 });

      let checked = false;
      const result = await engine.chase({
        symbol: 'BTCUSDT',
        side: 'BUY',
        quantity: 0.1,
        anchorPrice: 50000,
        getDepth: async () => ({ bestBid: 50000, bestAsk: 50001 }),
        checkFill: async () => {
          if (!checked) {
            checked = true;
            return { status: 'FILLED', fillPrice: 50000.01, fillQty: 0.1 };
          }
          return null;
        },
        placeOrder: async (price) => 'order_123',
      });

      expect(result.status).toBe('FILLED');
      expect(result.fillPrice).toBe(50000.01);
      expect(result.orderId).toBe('order_123');
      expect(broker.cancelOrder).not.toHaveBeenCalled();
    });

    it('amends order when book moves within deviation threshold', async () => {
      const broker = createMockBroker();
      const engine = new ChasingExecutionEngine(broker, {
        debouncMs: 50,
        timeoutMs: 2000,
        tickSize: 1,
      });

      let iteration = 0;
      const depths = [
        { bestBid: 50000, bestAsk: 50010 },
        { bestBid: 50002, bestAsk: 50010 },
      ];

      const result = await engine.chase({
        symbol: 'BTCUSDT',
        side: 'BUY',
        quantity: 0.1,
        anchorPrice: 50000,
        getDepth: async () => {
          const d = depths[Math.min(iteration, depths.length - 1)];
          iteration++;
          return d;
        },
        checkFill: async () => {
          // Fill after 2 iterations
          if (iteration >= 2) {
            return { status: 'FILLED', fillPrice: 50003, fillQty: 0.1 };
          }
          return null;
        },
        placeOrder: async () => 'order_amend_test',
      });

      expect(result.status).toBe('FILLED');
      expect(broker.modifyOrder).toHaveBeenCalled();
    });

    it('handles -5022 Post-Only rejection by backing off 1 tick', async () => {
      let rejectedOnce = false;
      const broker = createMockBroker(async (_sym, _id, _price, _qty) => {
        if (!rejectedOnce) {
          rejectedOnce = true;
          throw new BinanceApiError('Post Only order would immediately trigger as taker', 400, -5022);
        }
        return { status: 'NEW' };
      });

      const engine = new ChasingExecutionEngine(broker, {
        debouncMs: 20,
        timeoutMs: 2000,
        tickSize: 1,
        passiveOffsetTicks: 0,
      });

      let iteration = 0;
      const result = await engine.chase({
        symbol: 'BTCUSDT',
        side: 'BUY',
        quantity: 0.1,
        anchorPrice: 50000,
        getDepth: async () => {
          iteration++;
          if (iteration >= 2) {
            // Market moves up, prompting price amendment
            return { bestBid: 50002, bestAsk: 50010 };
          }
          return { bestBid: 50000, bestAsk: 50010 };
        },
        checkFill: async () => {
          if (rejectedOnce) {
            return { status: 'FILLED', fillPrice: 50001, fillQty: 0.1 };
          }
          return null;
        },
        placeOrder: async () => 'order_5022',
      });

      expect(rejectedOnce).toBe(true);
      expect(result.status).toBe('FILLED');
    });

    it('aborts on hard 15s timeout and cancels open order', async () => {
      const broker = createMockBroker();
      const engine = new ChasingExecutionEngine(broker, {
        debouncMs: 50,
        timeoutMs: 150, // Short timeout for test speed
      });

      const result = await engine.chase({
        symbol: 'BTCUSDT',
        side: 'BUY',
        quantity: 0.1,
        anchorPrice: 50000,
        getDepth: async () => ({ bestBid: 50000, bestAsk: 50001 }),
        checkFill: async () => null, // Never fills
        placeOrder: async () => 'order_timeout',
      });

      expect(result.status).toBe('TIMEOUT');
      expect(broker.cancelOrder).toHaveBeenCalledWith('BTCUSDT', 'order_timeout', false);
    });

    it('aborts on toxic runaway price deviation > 0.20%', async () => {
      const broker = createMockBroker();
      const engine = new ChasingExecutionEngine(broker, {
        debouncMs: 20,
        timeoutMs: 2000,
        maxDeviationPct: 0.002, // 0.20%
      });

      let iteration = 0;
      const result = await engine.chase({
        symbol: 'BTCUSDT',
        side: 'BUY',
        quantity: 0.1,
        anchorPrice: 50000,
        getDepth: async () => {
          iteration++;
          if (iteration >= 2) {
            // Price surges 0.5% (above 0.20% ceiling)
            return { bestBid: 50300, bestAsk: 50310 };
          }
          return { bestBid: 50000, bestAsk: 50010 };
        },
        checkFill: async () => null,
        placeOrder: async () => 'order_runaway',
      });

      expect(result.status).toBe('CANCELLED');
      expect(broker.cancelOrder).toHaveBeenCalledWith('BTCUSDT', 'order_runaway', false);
    });

    it('aborts immediately with CANCELLED and fillQty=0 when checkFill returns TERMINAL', async () => {
      const broker = createMockBroker();
      const engine = new ChasingExecutionEngine(broker, { debouncMs: 20, timeoutMs: 2000 });

      const result = await engine.chase({
        symbol: 'BTCUSDT',
        side: 'BUY',
        quantity: 0.1,
        anchorPrice: 50000,
        getDepth: async () => ({ bestBid: 50000, bestAsk: 50001 }),
        checkFill: async () => ({ status: 'TERMINAL', reason: 'EXPIRED' }),
        placeOrder: async () => 'order_terminal',
      });

      expect(result.status).toBe('CANCELLED');
      expect(result.fillQty).toBe(0);
      expect(broker.cancelOrder).not.toHaveBeenCalled();
    });

    it('retries initial placeOrder once with 1-tick backoff on -5022', async () => {
      const broker = createMockBroker();
      const engine = new ChasingExecutionEngine(broker, {
        debouncMs: 20,
        timeoutMs: 2000,
        tickSize: 1,
        passiveOffsetTicks: 0,
      });

      const placedPrices: number[] = [];
      const result = await engine.chase({
        symbol: 'BTCUSDT',
        side: 'SELL',
        quantity: 0.1,
        anchorPrice: 50000,
        getDepth: async () => ({ bestBid: 49990, bestAsk: 50000 }),
        checkFill: async () => ({ status: 'FILLED', fillPrice: 50000, fillQty: 0.1 }),
        placeOrder: async (price) => {
          placedPrices.push(price);
          if (placedPrices.length === 1) {
            throw new BinanceApiError('Post Only reject', 400, -5022);
          }
          return 'order_init_retry';
        },
      });

      // initial SELL target = 50000; backedOff (+2 ticks) = 50002
      expect(placedPrices).toEqual([50000, 50002]);
      expect(result.status).toBe('FILLED');
    });

    it('SELL -5022 amend backoff uses Math.max (moves ask higher/passive) and passes side', async () => {
      const amendCalls: Array<{ price: number; side?: string }> = [];
      let rejectedOnce = false;
      const broker = createMockBroker();
      broker.modifyOrder = vi.fn(async (_sym, _id, price, _qty, side?: string) => {
        amendCalls.push({ price, side });
        if (!rejectedOnce) {
          rejectedOnce = true;
          throw new BinanceApiError('Post Only reject', 400, -5022);
        }
        return { status: 'NEW' };
      });

      const engine = new ChasingExecutionEngine(broker, {
        debouncMs: 20,
        timeoutMs: 2000,
        tickSize: 1,
        passiveOffsetTicks: 0,
      });

      let depthCall = 0;
      const result = await engine.chase({
        symbol: 'BTCUSDT',
        side: 'SELL',
        quantity: 0.1,
        anchorPrice: 50000,
        getDepth: async () => {
          depthCall++;
          if (depthCall === 1) return { bestBid: 49990, bestAsk: 50000 }; // initial target = 49999
          if (depthCall === 2) return { bestBid: 49990, bestAsk: 49998 }; // newTarget = 49997 -> -5022
          return { bestBid: 49990, bestAsk: 49998 }; // freshDepth -> requoted = 49997, backedOff = 49999 + 1 = 50000
        },
        checkFill: async () => {
          if (rejectedOnce) {
            return { status: 'FILLED', fillPrice: 50000, fillQty: 0.1 };
          }
          return null;
        },
        placeOrder: async () => 'order_sell_5022',
      });

      expect(result.status).toBe('FILLED');
      expect(amendCalls[0]).toEqual({ price: 49998, side: 'SELL' });
      expect(amendCalls[1]).toEqual({ price: 50002, side: 'SELL' });
    });

    it('supports setBroker() hot-swap and unique TwapExecutionSlicer clientOrderIds', async () => {
      const broker1 = createMockBroker();
      const broker2 = createMockBroker();
      const engine = new ChasingExecutionEngine(broker1, { debouncMs: 20, timeoutMs: 2000 });
      engine.setBroker(broker2);

      await engine.chase({
        symbol: 'BTCUSDT',
        side: 'BUY',
        quantity: 0.1,
        anchorPrice: 50000,
        getDepth: async () => ({ bestBid: 50000, bestAsk: 50001 }),
        checkFill: async () => ({ status: 'TERMINAL', reason: 'CANCELED' }),
        placeOrder: async () => 'order_swap',
      });

      const slicer = new TwapExecutionSlicer(engine, {
        thresholdUsd: 5000,
        numSlices: 3,
        baseIntervalMs: 0,
      });

      const clientIds: string[] = [];
      const twapRes = await slicer.execute({
        symbol: 'BTCUSDT',
        side: 'BUY',
        totalQty: 3,
        anchorPrice: 50000,
        tradeId: '0123456789abcdef',
        getDepth: async () => ({ bestBid: 50000, bestAsk: 50001 }),
        checkFill: async () => ({ status: 'FILLED', fillPrice: 50000, fillQty: 1 }),
        placeOrder: async (_p, _q, clientOrderId) => {
          if (clientOrderId) clientIds.push(clientOrderId);
          return `ord_${clientIds.length}`;
        },
      });

      expect(twapRes.status).toBe('COMPLETED');
      expect(clientIds).toEqual([
        'tos_0123456789abcdef_s0',
        'tos_0123456789abcdef_s1',
        'tos_0123456789abcdef_s2',
      ]);
      expect(clientIds.every((id) => id.length <= 36)).toBe(true);
    });
  });
});
