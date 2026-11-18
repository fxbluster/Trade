import { describe, it, expect, beforeEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import polka, { type Request, type Response } from 'polka';
import { initializeDatabase } from '../../db/sqlite.js';
import { TradeManager } from '../../services/tradeManager.js';
import { registerRoutes, type AppContext } from '../routes.js';
import { SESSION_TOKEN, PORT } from '../../config.js';
import type { BrokerAdapter } from '../../exchange/broker.js';
import type { AccountInfo, OpenOrderInfo } from '@tradeos/shared';
import type { DatabaseSync } from 'node:sqlite';

function createMockBroker(): BrokerAdapter {
  return {
    mode: 'BINANCE_DEMO',
    getAccount: vi.fn().mockResolvedValue({
      walletBalance: 5000.0,
      equity: 5000.0,
      availableBalance: 4500.0,
      unrealizedPnl: 0.0,
      currency: 'USDT'
    } as AccountInfo),
    getPosition: vi.fn().mockResolvedValue(null),
    openOrder: vi.fn().mockResolvedValue({
      orderId: 'mock-order-1',
      clientOrderId: 'tos_1_ent',
      status: 'FILLED',
      executedQty: 10,
      avgPrice: 150
    }),
    createAlgoOrder: vi.fn().mockResolvedValue({
      algoId: 'mock-algo-1',
      symbol: 'SOLUSDT',
      status: 'NEW'
    }),
    closePosition: vi.fn().mockResolvedValue({
      orderId: 'mock-close-1',
      status: 'FILLED'
    }),
    cancelOrder: vi.fn().mockResolvedValue(true),
    cancelAllOrders: vi.fn().mockResolvedValue(true),
    moveToBreakeven: vi.fn().mockResolvedValue({
      newSlId: 'mock-be-sl-1'
    }),
    getOpenOrders: vi.fn().mockResolvedValue([] as OpenOrderInfo[])
  };
}

describe('TradeOS v2 16 REST Routes', () => {
  let db: DatabaseSync;
  let mockBroker: BrokerAdapter;
  let tradeManager: TradeManager;
  let ctx: AppContext;
  let app: ReturnType<typeof polka>;

  beforeEach(() => {
    db = initializeDatabase(':memory:');
    mockBroker = createMockBroker();
    tradeManager = new TradeManager({
      db,
      broker: mockBroker,
      getMarkPrice: () => 150.0
    });

    ctx = {
      tradeManager,
      broker: mockBroker,
      db,
      activeSymbol: 'SOLUSDT',
      getMarkPrice: () => 150.0,
      getIndicators: () => null,
      getKlines: vi.fn().mockResolvedValue([
        { time: 1700000000, open: 150, high: 151, low: 149, close: 150.5, volume: 1000 }
      ])
    };

    app = polka();
    registerRoutes(app, ctx);
  });

  async function invokeRoute(
    method: string,
    url: string,
    body?: unknown,
    headers: Record<string, string> = {}
  ): Promise<{ status: number; headers: Record<string, string>; body: any }> {
    const parsedUrl = new URL(`http://127.0.0.1:${PORT}${url}`);
    const reqHeaders: Record<string, string> = {
      host: `127.0.0.1:${PORT}`,
      authorization: `Bearer ${SESSION_TOKEN}`,
      ...headers
    };

    const emitter = new EventEmitter();
    const req = Object.assign(emitter, {
      method,
      url,
      path: parsedUrl.pathname,
      headers: reqHeaders,
      params: {},
      query: Object.fromEntries(parsedUrl.searchParams),
      body: {}
    }) as unknown as Request;

    const resHeaders: Record<string, string> = {};
    let statusCode = 200;
    let responseBody = '';

    return new Promise((resolve) => {
      const res = {
        statusCode: 200,
        setHeader(k: string, v: string) {
          resHeaders[k.toLowerCase()] = v;
        },
        getHeader(k: string) {
          return resHeaders[k.toLowerCase()];
        },
        end(data?: string) {
          if (data) responseBody = data;
          let parsedBody: any;
          try {
            parsedBody = responseBody ? JSON.parse(responseBody) : null;
          } catch {
            parsedBody = responseBody;
          }
          resolve({ status: statusCode, headers: resHeaders, body: parsedBody });
        }
      } as unknown as Response;

      Object.defineProperty(res, 'statusCode', {
        get: () => statusCode,
        set: (val: number) => {
          statusCode = val;
        }
      });

      app.handler(req, res, { pathname: parsedUrl.pathname, query: Object.fromEntries(parsedUrl.searchParams) });

      process.nextTick(() => {
        if (body !== undefined) {
          emitter.emit('data', Buffer.from(JSON.stringify(body)));
        }
        emitter.emit('end');
      });
    });
  }

  it('1. GET /api/health returns health status without auth', async () => {
    const res = await invokeRoute('GET', '/api/health', undefined, { authorization: '' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.brokerMode).toBe('BINANCE_DEMO');
  });

  it('2. GET /api/auth/session provides session token without auth', async () => {
    const res = await invokeRoute('GET', '/api/auth/session', undefined, { authorization: '' });
    expect(res.status).toBe(200);
    expect(res.body.token).toBe(SESSION_TOKEN);
  });

  it('3. GET /api/state returns comprehensive cockpit state snapshot', async () => {
    const res = await invokeRoute('GET', '/api/state');
    expect(res.status).toBe(200);
    expect(res.body.symbol).toBe('SOLUSDT');
    expect(res.body.account.walletBalance).toBe(5000.0);
    expect(res.body.brokerMode).toBe('BINANCE_DEMO');
  });

  it('4. GET /api/klines returns candles array', async () => {
    const res = await invokeRoute('GET', '/api/klines?symbol=SOLUSDT&interval=1m&limit=10');
    expect(res.status).toBe(200);
    expect(res.body.symbol).toBe('SOLUSDT');
    expect(Array.isArray(res.body.klines)).toBe(true);
  });

  it('5. GET /api/scanner returns top market pairs', async () => {
    const res = await invokeRoute('GET', '/api/scanner');
    expect(res.status).toBe(200);
  });

  it('6. POST /api/symbol updates active trading symbol', async () => {
    const res = await invokeRoute('POST', '/api/symbol', { symbol: 'BTCUSDT' });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.symbol).toBe('BTCUSDT');
  });

  it('7. POST /api/broker/mode switches between broker modes', async () => {
    const res = await invokeRoute('POST', '/api/broker/mode', { mode: 'LOCAL_PAPER' });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.mode).toBe('LOCAL_PAPER');
  });

  it('8. POST /api/orders/preview calculates accurate order parameters', async () => {
    const res = await invokeRoute('POST', '/api/orders/preview', {
      symbol: 'SOLUSDT',
      side: 'BUY',
      orderType: 'MARKET',
      marginUsd: 100,
      leverage: 5,
      stopLoss: 145
    });
    expect(res.status).toBe(200);
    expect(res.body.quantity).toBeGreaterThan(0);
    expect(res.body.deadSlSafe).toBe(true);
  });

  it('9. POST /api/orders/open opens a new position with bracket protection', async () => {
    const res = await invokeRoute('POST', '/api/orders/open', {
      symbol: 'SOLUSDT',
      side: 'BUY',
      orderType: 'MARKET',
      marginUsd: 100,
      leverage: 5,
      stopLoss: 145,
      tp1: 160
    });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.trade.id).toBeDefined();
  });

  it('10. POST /api/orders/close closes open position', async () => {
    // Open position first
    await invokeRoute('POST', '/api/orders/open', {
      symbol: 'SOLUSDT',
      side: 'BUY',
      orderType: 'MARKET',
      marginUsd: 100,
      leverage: 5,
      stopLoss: 145
    });

    const res = await invokeRoute('POST', '/api/orders/close', { symbol: 'SOLUSDT' });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  it('11. POST /api/orders/breakeven moves stop loss to breakeven', async () => {
    await invokeRoute('POST', '/api/orders/open', {
      symbol: 'SOLUSDT',
      side: 'BUY',
      orderType: 'MARKET',
      marginUsd: 100,
      leverage: 5,
      stopLoss: 145
    });

    // Simulate price moving into profit so pre-flight BE buffer is satisfied
    ctx.getMarkPrice = () => 155.0;
    tradeManager.setMarkPriceCallback(() => 155.0);

    const res = await invokeRoute('POST', '/api/orders/breakeven', { symbol: 'SOLUSDT' });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  it('12. DELETE /api/orders/:orderId cancels specific order', async () => {
    const res = await invokeRoute('DELETE', '/api/orders/order-123?symbol=SOLUSDT&isAlgo=true');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  it('13. POST /api/sync triggers exchange reconciliation', async () => {
    const res = await invokeRoute('POST', '/api/sync');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.syncedAt).toBeDefined();
  });

  it('14. GET /api/journal retrieves closed trades and metrics', async () => {
    const res = await invokeRoute('GET', '/api/journal?limit=20');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.trades)).toBe(true);
    expect(res.body.winRate).toBeDefined();
  });

  it('15. POST /api/cooldown/bypass unlocks cooldown with mandatory reason', async () => {
    const res = await invokeRoute('POST', '/api/cooldown/bypass', {
      reason: 'User manual override after high volatility passed'
    });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.bypassedAt).toBeDefined();
  });

  it('16. POST /api/mentor/chat interacts with Sokrat mentor', async () => {
    const res = await invokeRoute('POST', '/api/mentor/chat', {
      message: 'Mən hazırda hansı risklərə diqqət yetirməliyəm?'
    });
    expect(res.status).toBe(200);
    expect(res.body.reply).toBeDefined();
    expect(res.body.mode).toBeDefined();
  });
});
