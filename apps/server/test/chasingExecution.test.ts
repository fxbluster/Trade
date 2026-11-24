import { describe, it, expect, vi } from 'vitest';
import { ChasingExecutionEngine } from '../src/services/chasingExecutionEngine.js';
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
    const engine = new ChasingExecutionEngine(broker, { tickSize: 0.01 });

    it('BUY: penny-jumps inside wide spread', () => {
      // spread = 100.10 - 100.00 = 0.10 > 0.01
      // min(100.00 + 0.01, 100.10 - 0.01) = 100.01
      const price = engine.computeTargetBuy(100.00, 100.10);
      expect(price).toBeCloseTo(100.01, 4);
    });

    it('BUY: falls back to bestBid when spread <= 1 tick', () => {
      // spread = 100.01 - 100.00 = 0.01 <= 0.01 -> joins bestBid
      const price = engine.computeTargetBuy(100.00, 100.01);
      expect(price).toBe(100.00);
    });

    it('SELL: penny-jumps inside wide spread', () => {
      // spread = 100.10 - 100.00 = 0.10 > 0.01
      // max(100.10 - 0.01, 100.00 + 0.01) = 100.09
      const price = engine.computeTargetSell(100.00, 100.10);
      expect(price).toBeCloseTo(100.09, 4);
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
            return { fillPrice: 50000.01, fillQty: 0.1 };
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
            return { fillPrice: 50003, fillQty: 0.1 };
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
            return { fillPrice: 50001, fillQty: 0.1 };
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
  });
});
