import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import polka, { type Request, type Response } from 'polka';
import { initializeDatabase, TradesRepo } from '../../db/sqlite.js';
import { TradeManager } from '../../services/tradeManager.js';
import { registerRoutes, type AppContext } from '../routes.js';
import { SESSION_TOKEN, PORT } from '../../config.js';
import { BrokerFactory, type BrokerAdapter } from '../../exchange/broker.js';
import { BinanceClient } from '../../exchange/binanceClient.js';
import type { PropFirmRiskGuard } from '../../quant/propFirmRiskGuard.js';
import type { AutoPilotManager } from '../../services/autoPilotManager.js';
import type { AccountInfo, BrokerMode, OpenOrderInfo } from '@tradeos/shared';
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

  afterEach(() => {
    BrokerFactory.reset();
  });

  async function invokeRoute(
    method: string,
    url: string,
    body?: unknown,
    headers: Record<string, string> = {},
    socket: { remoteAddress?: string } = { remoteAddress: '127.0.0.1' }
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
      body: {},
      socket
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

      app.handler(req, res, { pathname: parsedUrl.pathname, search: parsedUrl.search, query: parsedUrl.searchParams.toString() });

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

  it('4. GET /api/klines returns candles array and forwards endTime/startTime', async () => {
    const res = await invokeRoute('GET', '/api/klines?symbol=SOLUSDT&interval=1m&limit=10&endTime=1700000000000');
    expect(res.status).toBe(200);
    expect(res.body.symbol).toBe('SOLUSDT');
    expect(Array.isArray(res.body.klines)).toBe(true);
    expect(ctx.getKlines).toHaveBeenCalledWith('SOLUSDT', '1m', 10, undefined, 1700000000000);
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

  it('17. Unified symbol switching reads ctx.getActiveSymbol() and avoids redundant stream/cvd calls', async () => {
    let sharedSymbol = 'SOLUSDT';
    const subscribeSymbol = vi.fn();
    const cvdReset = vi.fn();
    const setActiveSymbol = vi.fn((sym: string) => {
      sharedSymbol = sym;
    });

    const syncedApp = polka();
    registerRoutes(syncedApp, {
      ...ctx,
      streamsManager: { subscribeSymbol } as unknown as AppContext['streamsManager'],
      cvdEngine: { reset: cvdReset, getSnapshot: () => null } as unknown as AppContext['cvdEngine'],
      getActiveSymbol: () => sharedSymbol,
      setActiveSymbol,
    });

    const callSynced = async (method: string, url: string, body?: unknown) => {
      const parsedUrl = new URL(`http://127.0.0.1:${PORT}${url}`);
      const emitter = new EventEmitter();
      const req = Object.assign(emitter, {
        method,
        url,
        path: parsedUrl.pathname,
        headers: {
          host: `127.0.0.1:${PORT}`,
          authorization: `Bearer ${SESSION_TOKEN}`,
        },
        params: {},
        query: Object.fromEntries(parsedUrl.searchParams),
        body: {},
        socket: { remoteAddress: '127.0.0.1' },
      }) as unknown as Request;

      return new Promise<{ status: number; body: any }>((resolve) => {
        let statusCode = 200;
        let responseBody = '';
        const res = {
          statusCode: 200,
          setHeader: vi.fn(),
          getHeader: vi.fn(),
          end(data?: string) {
            if (data) responseBody = data;
            resolve({ status: statusCode, body: responseBody ? JSON.parse(responseBody) : null });
          },
        } as unknown as Response;
        Object.defineProperty(res, 'statusCode', {
          get: () => statusCode,
          set: (val: number) => { statusCode = val; },
        });
        syncedApp.handler(req, res, { pathname: parsedUrl.pathname, query: {} });
        process.nextTick(() => {
          if (body !== undefined) emitter.emit('data', Buffer.from(JSON.stringify(body)));
          emitter.emit('end');
        });
      });
    };

    const switchRes = await callSynced('POST', '/api/symbol', { symbol: 'btcusdt' });
    expect(switchRes.status).toBe(200);
    expect(switchRes.body.symbol).toBe('BTCUSDT');
    expect(setActiveSymbol).toHaveBeenCalledWith('BTCUSDT');
    expect(subscribeSymbol).not.toHaveBeenCalled();
    expect(cvdReset).not.toHaveBeenCalled();

    // Simulate external WS SUBSCRIBE_SYMBOL updating sharedSymbol directly
    sharedSymbol = 'ETHUSDT';
    const stateRes = await callSynced('GET', '/api/state');
    expect(stateRes.status).toBe(200);
    expect(stateRes.body.symbol).toBe('ETHUSDT');
  });

  it('18. POST /api/broker/mode enforces CLOSING_IN_PROGRESS + in-flight AutoPilot guards and propagates setBroker', async () => {
    const tradesRepo = new TradesRepo(db);
    let apState = 'LIMIT_CHASING';
    const apSetBroker = vi.fn();
    const tmSetBrokerSpy = vi.spyOn(tradeManager, 'setBroker');
    const customClient = new BinanceClient({ apiKey: 'test-k', apiSecret: 'test-s' });

    const guardedApp = polka();
    const guardedCtx: AppContext = {
      ...ctx,
      binanceClient: customClient,
      autoPilotManager: {
        getState: () => apState,
        setBroker: apSetBroker,
      } as unknown as AutoPilotManager,
    };
    registerRoutes(guardedApp, guardedCtx);

    const callGuarded = async (mode: BrokerMode) => {
      const emitter = new EventEmitter();
      const req = Object.assign(emitter, {
        method: 'POST',
        url: '/api/broker/mode',
        path: '/api/broker/mode',
        headers: {
          host: `127.0.0.1:${PORT}`,
          authorization: `Bearer ${SESSION_TOKEN}`,
        },
        params: {},
        query: {},
        body: {},
        socket: { remoteAddress: '127.0.0.1' },
      }) as unknown as Request;

      return new Promise<{ status: number; body: any }>((resolve) => {
        let statusCode = 200;
        let responseBody = '';
        const res = {
          statusCode: 200,
          setHeader: vi.fn(),
          getHeader: vi.fn(),
          end(data?: string) {
            if (data) responseBody = data;
            resolve({ status: statusCode, body: responseBody ? JSON.parse(responseBody) : null });
          },
        } as unknown as Response;
        Object.defineProperty(res, 'statusCode', {
          get: () => statusCode,
          set: (val: number) => { statusCode = val; },
        });
        guardedApp.handler(req, res, { pathname: '/api/broker/mode', query: {} });
        process.nextTick(() => {
          emitter.emit('data', Buffer.from(JSON.stringify({ mode })));
          emitter.emit('end');
        });
      });
    };

    // Guarded while AutoPilot is LIMIT_CHASING
    const blockedAp = await callGuarded('LOCAL_PAPER');
    expect(blockedAp.status).toBe(409);
    expect(blockedAp.body.code).toBe('AUTOPILOT_IN_FLIGHT');

    // Guarded while trade is CLOSING_IN_PROGRESS
    apState = 'IDLE';
    tradesRepo.insert({
      id: 'closing-in-prog-1',
      symbol: 'SOLUSDT',
      broker_mode: 'BINANCE_DEMO',
      side: 'BUY',
      status: 'CLOSING_IN_PROGRESS',
      entry_price: 150,
      exit_price: null,
      quantity: 1,
      remaining_qty: 1,
      leverage: 5,
      margin_usd: 30,
      stop_loss: 145,
      tp1: null,
      tp2: null,
      be_price: null,
      is_breakeven: 0,
      peak_price: 150,
      peak_mfe: 0,
      trailing_stop_active: 0,
      client_order_id: null,
      client_sl_id: null,
      client_tp1_id: null,
      client_tp2_id: null,
      entry_order_id: null,
      sl_algo_id: null,
      tp1_algo_id: null,
      tp2_algo_id: null,
      realized_pnl: 0,
      fees_usd: 0,
      exit_reason: null,
      opened_at: Date.now(),
      closed_at: null,
    });
    const blockedClosing = await callGuarded('LOCAL_PAPER');
    expect(blockedClosing.status).toBe(409);

    // Clear trade to CLOSED and verify switch + propagation + LOCAL_PAPER reuse
    tradesRepo.update('closing-in-prog-1', { status: 'CLOSED', closed_at: Date.now() });

    const toPaper1 = await callGuarded('LOCAL_PAPER');
    expect(toPaper1.status).toBe(200);
    const paperAdapter1 = guardedCtx.broker;
    expect(paperAdapter1.mode).toBe('LOCAL_PAPER');
    expect(tmSetBrokerSpy).toHaveBeenCalledWith(paperAdapter1);
    expect(apSetBroker).toHaveBeenCalledWith(paperAdapter1);

    const toDemo = await callGuarded('BINANCE_DEMO');
    expect(toDemo.status).toBe(200);
    expect(guardedCtx.broker.mode).toBe('BINANCE_DEMO');
    expect(apSetBroker).toHaveBeenCalledWith(guardedCtx.broker);
  });

  it('19. GET /api/journal computes chronological ASC aggregate drawdown ratio and maxDrawdownUsd across full history', async () => {
    const tradesRepo = new TradesRepo(db);
    const baseTime = 1700000000000;
    const closedRows = [
      { id: 't1', pnl: 200, fees: 0, closedAt: baseTime + 1000 },
      { id: 't2', pnl: -300, fees: 0, closedAt: baseTime + 2000 },
      { id: 't3', pnl: -200, fees: 0, closedAt: baseTime + 3000 },
      { id: 't4', pnl: 100, fees: 0, closedAt: baseTime + 4000 },
    ];
    for (const row of closedRows) {
      tradesRepo.insert({
        id: row.id,
        symbol: 'SOLUSDT',
        broker_mode: 'BINANCE_DEMO',
        side: 'BUY',
        status: 'CLOSED',
        entry_price: 150,
        exit_price: 151,
        quantity: 1,
        remaining_qty: 0,
        leverage: 5,
        margin_usd: 30,
        stop_loss: 145,
        tp1: null,
        tp2: null,
        be_price: null,
        is_breakeven: 0,
        peak_price: 151,
        peak_mfe: 0,
        trailing_stop_active: 0,
        client_order_id: null,
        client_sl_id: null,
        client_tp1_id: null,
        client_tp2_id: null,
        entry_order_id: null,
        sl_algo_id: null,
        tp1_algo_id: null,
        tp2_algo_id: null,
        realized_pnl: row.pnl,
        fees_usd: row.fees,
        exit_reason: 'TAKE_PROFIT',
        opened_at: row.closedAt - 500,
        closed_at: row.closedAt,
      });
    }

    // Wire propFirmRiskGuard so BINANCE_DEMO uses $50,000 PropFirm initialEquity
    const propFirmApp = polka();
    registerRoutes(propFirmApp, {
      ...ctx,
      propFirmRiskGuard: {} as PropFirmRiskGuard,
    });

    const parsedUrl = new URL(`http://127.0.0.1:${PORT}/api/journal?limit=2&offset=0`);
    const emitter = new EventEmitter();
    const req = Object.assign(emitter, {
      method: 'GET',
      url: '/api/journal?limit=2&offset=0',
      path: '/api/journal',
      headers: {
        host: `127.0.0.1:${PORT}`,
        authorization: `Bearer ${SESSION_TOKEN}`,
      },
      params: {},
      query: { limit: '2', offset: '0' },
      body: {},
      socket: { remoteAddress: '127.0.0.1' },
    }) as unknown as Request;

    const resData = await new Promise<{ status: number; body: any }>((resolve) => {
      let statusCode = 200;
      let responseBody = '';
      const res = {
        statusCode: 200,
        setHeader: vi.fn(),
        getHeader: vi.fn(),
        end(data?: string) {
          if (data) responseBody = data;
          resolve({ status: statusCode, body: responseBody ? JSON.parse(responseBody) : null });
        },
      } as unknown as Response;
      Object.defineProperty(res, 'statusCode', {
        get: () => statusCode,
        set: (val: number) => { statusCode = val; },
      });
      propFirmApp.handler(req, res, { pathname: '/api/journal', query: 'limit=2&offset=0' });
    });

    expect(resData.status).toBe(200);
    // Paginated slice returns latest 2 trades (t4, t3)
    expect(resData.body.trades.length).toBe(2);
    expect(resData.body.totalTrades).toBe(4);
    // Aggregate metrics computed across ALL 4 chronological ASC trades:
    // 2 wins / 4 total = 50% winRate; Peak 50200 -> trough 49700 => $500 / 50200 ≈ 0.01 (0.0100)
    expect(resData.body.winRate).toBe(50);
    expect(resData.body.maxDrawdownUsd).toBe(500);
    expect(resData.body.maxDrawdown).toBeCloseTo(500 / 50200, 4);
  });

  it('20. GET /api/confluence?symbol=BTCUSDT reads from getConfluenceSnapshot even when activeSymbol is SOLUSDT', async () => {
    const getConfluenceSnapshot = vi.fn((symbol: string) => ({
      symbol,
      score: symbol === 'BTCUSDT' ? 82 : 41,
      bias: 'BULLISH',
      timestamp: Date.now(),
    })) as unknown as NonNullable<AppContext['getConfluenceSnapshot']>;

    const fallbackGetSnapshot = vi.fn(() => ({
      symbol: 'SOLUSDT',
      score: 10,
    }));

    const multiApp = polka();
    registerRoutes(multiApp, {
      ...ctx,
      activeSymbol: 'SOLUSDT',
      confluenceEngine: {
        getSnapshot: fallbackGetSnapshot,
      } as unknown as AppContext['confluenceEngine'],
      getConfluenceSnapshot,
    });

    const parsedUrl = new URL(`http://127.0.0.1:${PORT}/api/confluence?symbol=BTCUSDT`);
    const emitter = new EventEmitter();
    const req = Object.assign(emitter, {
      method: 'GET',
      url: '/api/confluence?symbol=BTCUSDT',
      path: '/api/confluence',
      headers: {
        host: `127.0.0.1:${PORT}`,
        authorization: `Bearer ${SESSION_TOKEN}`,
      },
      params: {},
      query: { symbol: 'BTCUSDT' },
      body: {},
      socket: { remoteAddress: '127.0.0.1' },
    }) as unknown as Request;

    const resData = await new Promise<{ status: number; body: any }>((resolve) => {
      let statusCode = 200;
      let responseBody = '';
      const res = {
        statusCode: 200,
        setHeader: vi.fn(),
        getHeader: vi.fn(),
        end(data?: string) {
          if (data) responseBody = data;
          resolve({ status: statusCode, body: responseBody ? JSON.parse(responseBody) : null });
        },
      } as unknown as Response;
      Object.defineProperty(res, 'statusCode', {
        get: () => statusCode,
        set: (val: number) => { statusCode = val; },
      });
      multiApp.handler(req, res, { pathname: '/api/confluence', query: 'symbol=BTCUSDT' });
    });

    expect(resData.status).toBe(200);
    expect(getConfluenceSnapshot).toHaveBeenCalledWith('BTCUSDT');
    expect(fallbackGetSnapshot).not.toHaveBeenCalled();
    expect(resData.body.symbol).toBe('BTCUSDT');
    expect(resData.body.score).toBe(82);
  });

  it('21. POST /api/symbol allows switching between watchlistSymbols when a trade is open, while still blocking non-watchlist switches', async () => {
    const tradesRepo = new TradesRepo(db);
    tradesRepo.insert({
      id: 'open-sol-1',
      symbol: 'SOLUSDT',
      broker_mode: 'BINANCE_DEMO',
      side: 'BUY',
      status: 'OPEN',
      entry_price: 150,
      exit_price: null,
      quantity: 1,
      remaining_qty: 1,
      leverage: 5,
      margin_usd: 30,
      stop_loss: 145,
      tp1: null,
      tp2: null,
      be_price: null,
      is_breakeven: 0,
      peak_price: 150,
      peak_mfe: 0,
      trailing_stop_active: 0,
      client_order_id: null,
      client_sl_id: null,
      client_tp1_id: null,
      client_tp2_id: null,
      entry_order_id: null,
      sl_algo_id: null,
      tp1_algo_id: null,
      tp2_algo_id: null,
      realized_pnl: 0,
      fees_usd: 0,
      exit_reason: null,
      opened_at: Date.now(),
      closed_at: null,
    });

    const setActiveSymbol = vi.fn();
    const watchlistApp = polka();
    registerRoutes(watchlistApp, {
      ...ctx,
      activeSymbol: 'SOLUSDT',
      watchlistSymbols: ['SOLUSDT', 'BTCUSDT', 'ETHUSDT', 'XRPUSDT'],
      setActiveSymbol,
    });

    const callSwitch = (symbol: string) =>
      new Promise<{ status: number; body: any }>((resolve) => {
        const emitter = new EventEmitter();
        const req = Object.assign(emitter, {
          method: 'POST',
          url: '/api/symbol',
          path: '/api/symbol',
          headers: {
            host: `127.0.0.1:${PORT}`,
            authorization: `Bearer ${SESSION_TOKEN}`,
          },
          params: {},
          query: {},
          body: {},
          socket: { remoteAddress: '127.0.0.1' },
        }) as unknown as Request;

        let statusCode = 200;
        let responseBody = '';
        const res = {
          statusCode: 200,
          setHeader: vi.fn(),
          getHeader: vi.fn(),
          end(data?: string) {
            if (data) responseBody = data;
            resolve({ status: statusCode, body: responseBody ? JSON.parse(responseBody) : null });
          },
        } as unknown as Response;
        Object.defineProperty(res, 'statusCode', {
          get: () => statusCode,
          set: (val: number) => { statusCode = val; },
        });
        watchlistApp.handler(req, res, { pathname: '/api/symbol', query: {} });
        process.nextTick(() => {
          emitter.emit('data', Buffer.from(JSON.stringify({ symbol })));
          emitter.emit('end');
        });
      });

    // Switching to another watchlist symbol succeeds even with an open trade
    const btcRes = await callSwitch('btcusdt');
    expect(btcRes.status).toBe(200);
    expect(btcRes.body.success).toBe(true);
    expect(btcRes.body.symbol).toBe('BTCUSDT');
    expect(setActiveSymbol).toHaveBeenCalledWith('BTCUSDT');

    // Switching to a non-watchlist symbol is still blocked with 409 OPEN_POSITION_EXISTS
    const dogeRes = await callSwitch('DOGEUSDT');
    expect(dogeRes.status).toBe(409);
    expect(dogeRes.body.code).toBe('OPEN_POSITION_EXISTS');
  });

  it('22. GET /api/state uses getCvdSnapshot and POST /api/webhook routes to getConfluenceEngine per symbol', async () => {
    const getCvdSnapshot = vi.fn((symbol: string) => ({
      symbol,
      delta: 1234,
      cumulativeDelta: 5678,
      buyVolume: 2000,
      sellVolume: 766,
      openInterestUsd: null,
      timestamp: Date.now(),
    })) as unknown as NonNullable<AppContext['getCvdSnapshot']>;

    const ethIngest = vi.fn(() => ({ accepted: true }));
    const fallbackIngest = vi.fn(() => ({ accepted: true }));
    const getConfluenceEngine = vi.fn((symbol: string) =>
      symbol.toUpperCase() === 'ETHUSDT'
        ? ({ ingestWebhookAlert: ethIngest } as unknown as NonNullable<AppContext['confluenceEngine']>)
        : undefined
    );

    const prevSecret = process.env.WEBHOOK_SECRET;
    process.env.WEBHOOK_SECRET = 'super-secret-webhook-passphrase-1234';

    try {
      const routedApp = polka();
      registerRoutes(routedApp, {
        ...ctx,
        activeSymbol: 'SOLUSDT',
        getCvdSnapshot,
        confluenceEngine: {
          ingestWebhookAlert: fallbackIngest,
        } as unknown as AppContext['confluenceEngine'],
        getConfluenceEngine,
      });

      const callRouted = (method: string, url: string, body?: unknown) =>
        new Promise<{ status: number; body: any }>((resolve) => {
          const parsedUrl = new URL(`http://127.0.0.1:${PORT}${url}`);
          const emitter = new EventEmitter();
          const req = Object.assign(emitter, {
            method,
            url,
            path: parsedUrl.pathname,
            headers: {
              host: `127.0.0.1:${PORT}`,
              authorization: `Bearer ${SESSION_TOKEN}`,
            },
            params: {},
            query: Object.fromEntries(parsedUrl.searchParams),
            body: {},
            socket: { remoteAddress: '127.0.0.1' },
          }) as unknown as Request;

          let statusCode = 200;
          let responseBody = '';
          const res = {
            statusCode: 200,
            setHeader: vi.fn(),
            getHeader: vi.fn(),
            end(data?: string) {
              if (data) responseBody = data;
              resolve({ status: statusCode, body: responseBody ? JSON.parse(responseBody) : null });
            },
          } as unknown as Response;
          Object.defineProperty(res, 'statusCode', {
            get: () => statusCode,
            set: (val: number) => { statusCode = val; },
          });
          routedApp.handler(req, res, { pathname: parsedUrl.pathname, query: {} });
          process.nextTick(() => {
            if (body !== undefined) emitter.emit('data', Buffer.from(JSON.stringify(body)));
            emitter.emit('end');
          });
        });

      const stateRes = await callRouted('GET', '/api/state');
      expect(stateRes.status).toBe(200);
      expect(getCvdSnapshot).toHaveBeenCalledWith('SOLUSDT');
      expect(stateRes.body.cvd.delta).toBe(1234);

      const hookRes = await callRouted('POST', '/api/webhook', {
        secret: 'super-secret-webhook-passphrase-1234',
        symbol: 'ETHUSDT',
        side: 'BUY',
      });
      expect(hookRes.status).toBe(200);
      expect(getConfluenceEngine).toHaveBeenCalledWith('ETHUSDT');
      expect(ethIngest).toHaveBeenCalledTimes(1);
      expect(fallbackIngest).not.toHaveBeenCalled();
    } finally {
      if (prevSecret === undefined) {
        delete process.env.WEBHOOK_SECRET;
      } else {
        process.env.WEBHOOK_SECRET = prevSecret;
      }
    }
  });

  it('POST /api/admin/propfirm/purge-test-cycles keeps only the latest cycle renumbered to 1', async () => {
    const insertCycle = db.prepare(`
      INSERT INTO propfirm_challenge_cycles (
        id, cycle_number, status, starting_balance_usd, current_equity_usd, high_water_mark_usd,
        contractual_trailing_floor_usd, internal_trailing_floor_usd, is_floor_locked, profit_target_usd,
        net_pnl_usd, net_pnl_pct, max_drawdown_usd, started_at
      ) VALUES (?, ?, 'ACTIVE', 50000, ?, 50000, 47500, 47600, 0, 52500, ?, ?, 0, ?)
    `);
    const now = Date.now();
    insertCycle.run('c-old-1', 1, 49746.8, -253.2, -0.5, now - 86400000);
    insertCycle.run('c-latest-2', 2, 49975.0, -25.0, -0.05, now);

    const res = await invokeRoute('POST', '/api/admin/propfirm/purge-test-cycles', {});
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);

    const rows = db.prepare('SELECT id, cycle_number FROM propfirm_challenge_cycles ORDER BY cycle_number ASC').all() as Array<{ id: string; cycle_number: number }>;
    expect(rows).toEqual([{ id: 'c-latest-2', cycle_number: 1 }]);
  });
});
