import { describe, it, expect, vi } from 'vitest';
import { ChasingExecutionEngine } from '../chasingExecutionEngine.js';
import type { BrokerAdapter } from '../../exchange/broker.js';
import { BinanceApiError } from '../../exchange/binanceClient.js';

function createMockBroker(extra: Record<string, unknown> = {}): BrokerAdapter {
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
    modifyOrder: vi.fn(async () => ({ status: 'NEW' })),
    ...extra,
  };
}

describe('ChasingExecutionEngine symbol tickSize & precision [DEF-01 / ARCH-13]', () => {
  it('resolves symbol-specific tickSize when constructor tickSize is omitted', () => {
    const engine = new ChasingExecutionEngine(createMockBroker());
    expect(engine.getTickSize('BTCUSDT')).toBe(0.1);
    expect(engine.getTickSize('ETHUSDT')).toBe(0.01);
    expect(engine.getTickSize('SOLUSDT')).toBe(0.01);
    expect(engine.getTickSize('XRPUSDT')).toBe(0.0001);
  });

  it('snaps BTCUSDT penny-jump price to 0.1 tickSize (never 0.01) without float artifacts', async () => {
    const engine = new ChasingExecutionEngine(createMockBroker(), {
      debouncMs: 20,
      timeoutMs: 2000,
    });

    const placedPrices: number[] = [];
    const result = await engine.chase({
      symbol: 'BTCUSDT',
      side: 'BUY',
      quantity: 0.0159,
      anchorPrice: 61578.8,
      getDepth: async () => ({ bestBid: 61578.8, bestAsk: 61579.5 }),
      checkFill: async () => ({ status: 'FILLED', fillPrice: 61578.9, fillQty: 0.015 }),
      placeOrder: async (price) => {
        placedPrices.push(price);
        return 'ord_btc_1';
      },
    });

    expect(result.status).toBe('FILLED');
    expect(placedPrices).toEqual([61578.9]);
  });

  it('snaps SOLUSDT modifyOrder price and quantity to symbol rules during amendment', async () => {
    const modifyCalls: Array<{ price: number; qty: number }> = [];
    const broker = createMockBroker({
      modifyOrder: vi.fn(async (_sym: string, _id: string | number, price: number, qty: number) => {
        modifyCalls.push({ price, qty });
        return { status: 'NEW' };
      }),
    });

    const engine = new ChasingExecutionEngine(broker, {
      debouncMs: 20,
      timeoutMs: 2000,
    });

    let iter = 0;
    const result = await engine.chase({
      symbol: 'SOLUSDT',
      side: 'BUY',
      quantity: 1.234567,
      anchorPrice: 142.3,
      getDepth: async () => {
        iter++;
        if (iter === 1) return { bestBid: 142.3, bestAsk: 142.35 };
        return { bestBid: 142.32, bestAsk: 142.38 };
      },
      checkFill: async () => {
        if (iter >= 2) {
          return { status: 'FILLED', fillPrice: 142.33, fillQty: 1.23 };
        }
        return null;
      },
      placeOrder: async () => 'ord_sol_1',
    });

    expect(result.status).toBe('FILLED');
    expect(modifyCalls[0]).toEqual({ price: 142.33, qty: 1.23 });
  });

  it('handles -5022 backoff on BTCUSDT using 0.1 tickSize cleanly', async () => {
    const engine = new ChasingExecutionEngine(createMockBroker(), {
      debouncMs: 20,
      timeoutMs: 2000,
    });

    const placedPrices: number[] = [];
    const result = await engine.chase({
      symbol: 'BTCUSDT',
      side: 'BUY',
      quantity: 0.05,
      anchorPrice: 61578.8,
      getDepth: async () => ({ bestBid: 61578.8, bestAsk: 61579.2 }),
      checkFill: async () => ({ status: 'FILLED', fillPrice: 61578.8, fillQty: 0.05 }),
      placeOrder: async (price) => {
        placedPrices.push(price);
        if (placedPrices.length === 1) {
          throw new BinanceApiError('Post Only reject', 400, -5022);
        }
        return 'ord_btc_retry';
      },
    });

    expect(placedPrices).toEqual([61578.9, 61578.8]);
    expect(result.status).toBe('FILLED');
  });
});
