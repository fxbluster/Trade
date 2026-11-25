import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import http from 'node:http';
import WebSocket from 'ws';
import polka, { type Request, type Response } from 'polka';
import type { DatabaseSync } from 'node:sqlite';
import type { AccountInfo, OpenOrderInfo, PropFirmStatusResponse } from '@tradeos/shared';
import { initializeDatabase, PropFirmRepo } from '../../db/sqlite.js';
import { PropFirmRiskGuard } from '../../quant/propFirmRiskGuard.js';
import { TradeManager } from '../../services/tradeManager.js';
import { registerRoutes, type AppContext } from '../routes.js';
import { WsHub } from '../wsHub.js';
import { SESSION_TOKEN, PORT } from '../../config.js';
import type { BrokerAdapter } from '../../exchange/broker.js';

function createMockBroker(walletBalance: number = 4606.01): BrokerAdapter {
  return {
    mode: 'BINANCE_DEMO',
    getAccount: vi.fn().mockResolvedValue({
      walletBalance,
      equity: walletBalance,
      availableBalance: walletBalance,
      unrealizedPnl: 0.0,
      currency: 'USDT',
    } as AccountInfo),
    getPosition: vi.fn().mockResolvedValue(null),
    openOrder: vi.fn().mockResolvedValue({
      orderId: 'mock-order-1',
      clientOrderId: 'tos_1_ent',
      status: 'FILLED',
      executedQty: 10,
      avgPrice: 150,
    }),
    createAlgoOrder: vi.fn().mockResolvedValue({
      algoId: 'mock-algo-1',
      symbol: 'SOLUSDT',
      status: 'NEW',
    }),
    closePosition: vi.fn().mockResolvedValue({
      orderId: 'mock-close-1',
      status: 'FILLED',
    }),
    cancelOrder: vi.fn().mockResolvedValue(true),
    cancelAllOrders: vi.fn().mockResolvedValue(true),
    moveToBreakeven: vi.fn().mockResolvedValue({
      newSlId: 'mock-be-sl-1',
    }),
    getOpenOrders: vi.fn().mockResolvedValue([] as OpenOrderInfo[]),
  };
}

function createRouteInvoker(app: ReturnType<typeof polka>) {
  return async function invokeRoute(
    method: string,
    url: string,
    body?: unknown,
    headers: Record<string, string> = {}
  ): Promise<{ status: number; headers: Record<string, string>; body: any }> {
    const parsedUrl = new URL(`http://127.0.0.1:${PORT}${url}`);
    const reqHeaders: Record<string, string> = {
      host: `127.0.0.1:${PORT}`,
      authorization: `Bearer ${SESSION_TOKEN}`,
      ...headers,
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
        },
      } as unknown as Response;

      Object.defineProperty(res, 'statusCode', {
        get: () => statusCode,
        set: (val: number) => {
          statusCode = val;
        },
      });

      app.handler(req, res, {
        pathname: parsedUrl.pathname,
        query: Object.fromEntries(parsedUrl.searchParams),
      });

      process.nextTick(() => {
        if (body !== undefined) {
          emitter.emit('data', Buffer.from(JSON.stringify(body)));
        }
        emitter.emit('end');
      });
    });
  };
}

describe('Prop Firm REST Routes (/api/propfirm/*)', () => {
  let db: DatabaseSync;
  let mockBroker: BrokerAdapter;
  let tradeManager: TradeManager;
  let propFirmRepo: PropFirmRepo;
  let propFirmRiskGuard: PropFirmRiskGuard;
  let walletBalance: number;
  let app: ReturnType<typeof polka>;
  let invokeRoute: ReturnType<typeof createRouteInvoker>;

  beforeEach(() => {
    db = initializeDatabase(':memory:');
    walletBalance = 4606.01;
    mockBroker = createMockBroker(walletBalance);
    tradeManager = new TradeManager({
      db,
      broker: mockBroker,
      getMarkPrice: () => 150.0,
    });
    propFirmRepo = new PropFirmRepo(db);
    propFirmRiskGuard = new PropFirmRiskGuard(propFirmRepo);

    const ctx: AppContext = {
      tradeManager,
      broker: mockBroker,
      db,
      activeSymbol: 'SOLUSDT',
      propFirmRiskGuard,
      getPropFirmWalletBalance: () => walletBalance,
    };

    app = polka();
    registerRoutes(app, ctx);
    invokeRoute = createRouteInvoker(app);
  });

  afterEach(() => {
    try {
      db.close();
    } catch {}
  });

  it('rejects unauthenticated GET /api/propfirm/status with 401', async () => {
    const res = await invokeRoute('GET', '/api/propfirm/status', undefined, {
      authorization: '',
    });
    expect(res.status).toBe(401);
  });

  it('returns 200 with verdict, buffers, needsTopUp, and cycles on authenticated GET /api/propfirm/status', async () => {
    propFirmRiskGuard.recordTradeClosed({
      realizedNetPnlUsd: 420.5,
      liveWalletBalanceUsd: walletBalance,
    });

    const res = await invokeRoute('GET', '/api/propfirm/status');
    expect(res.status).toBe(200);
    expect(res.body.verdict).toBe('YES_PROFIT');
    expect(res.body.dailyBufferRemainingUsd).toBe(1250);
    expect(res.body.trailingBufferRemainingUsd).toBe(2500);
    expect(res.body.needsTopUp).toBe(true);
    expect(res.body.liveWalletBalanceUsd).toBe(4606.01);
    expect(Array.isArray(res.body.cycles)).toBe(true);
    expect(res.body.cycles.length).toBeGreaterThanOrEqual(1);
  });

  it('falls back to broker.getAccount() when getPropFirmWalletBalance returns 0 and never 500s on broker failure', async () => {
    walletBalance = 0;
    const res = await invokeRoute('GET', '/api/propfirm/status');
    expect(res.status).toBe(200);
    expect(mockBroker.getAccount).toHaveBeenCalled();
    expect(res.body.liveWalletBalanceUsd).toBe(4606.01);
    expect(res.body.needsTopUp).toBe(true);

    // Broker throws -> still returns 200 safely without 500
    (mockBroker.getAccount as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('Exchange timeout')
    );
    const resOnErr = await invokeRoute('GET', '/api/propfirm/status');
    expect(resOnErr.status).toBe(200);
    expect(resOnErr.body.needsTopUp).toBe(true);
  });

  it('returns 200 on GET /api/propfirm/certificate with certified: false when < 5 and certified: true when >= 5', async () => {
    const initialRes = await invokeRoute('GET', '/api/propfirm/certificate');
    expect(initialRes.status).toBe(200);
    expect(initialRes.body.certified).toBe(false);
    expect(initialRes.body.consecutivePassedCycles).toBe(0);
    expect(initialRes.body.requiredPassedCycles).toBe(5);
    expect(initialRes.body.remainingCycles).toBe(5);

    // Pass 5 consecutive cycles
    for (let i = 0; i < 5; i++) {
      if (i > 0) {
        propFirmRiskGuard.startNewCycle(50_000);
      }
      propFirmRiskGuard.recordTradeClosed({
        realizedNetPnlUsd: 2_500,
        liveWalletBalanceUsd: 52_500,
      });
    }

    const certRes = await invokeRoute('GET', '/api/propfirm/certificate');
    expect(certRes.status).toBe(200);
    expect(certRes.body.certified).toBe(true);
    expect(certRes.body.consecutivePassedCycles).toBe(5);
    expect(certRes.body.remainingCycles).toBe(0);
    expect(Array.isArray(certRes.body.cycles)).toBe(true);
    expect(certRes.body.cycles.length).toBe(5);
  });

  it('returns 503 when propFirmRiskGuard is not provided in AppContext', async () => {
    const appWithoutGuard = polka();
    registerRoutes(appWithoutGuard, {
      tradeManager,
      broker: mockBroker,
      db,
      activeSymbol: 'SOLUSDT',
    });
    const invokeWithoutGuard = createRouteInvoker(appWithoutGuard);

    const statusRes = await invokeWithoutGuard('GET', '/api/propfirm/status');
    expect(statusRes.status).toBe(503);

    const certRes = await invokeWithoutGuard('GET', '/api/propfirm/certificate');
    expect(certRes.status).toBe(503);
  });
});

describe('WsHub.broadcastPropFirmStatus throttling', () => {
  const TEST_TOKEN = 'test_propfirm_token_123456789012345678901234567890';
  let server: http.Server;
  let wsHub: WsHub;
  let port: number;
  let activeClients: WebSocket[] = [];
  let db: DatabaseSync;
  let guard: PropFirmRiskGuard;

  beforeEach(async () => {
    activeClients = [];
    db = initializeDatabase(':memory:');
    guard = new PropFirmRiskGuard(new PropFirmRepo(db));
    server = http.createServer((_req, res) => {
      res.statusCode = 200;
      res.end('OK');
    });
    wsHub = new WsHub({
      server,
      path: '/ws',
      sessionToken: TEST_TOKEN,
    });
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address() as { port: number };
        port = addr.port;
        resolve();
      });
    });
  });

  afterEach(async () => {
    for (const ws of activeClients) {
      try {
        ws.terminate();
      } catch {}
    }
    await wsHub.close();
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
    try {
      db.close();
    } catch {}
  });

  it('throttles PROPFIRM_STATUS broadcasts to <= 2Hz (500ms) and only delivers to authenticated clients', async () => {
    const authedWs = new WebSocket(`ws://127.0.0.1:${port}/ws`, ['tradeos-auth', TEST_TOKEN]);
    const unauthedWs = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    activeClients.push(authedWs, unauthedWs);

    await Promise.all([
      new Promise<void>((resolve) => authedWs.on('open', resolve)),
      new Promise<void>((resolve) => unauthedWs.on('open', resolve)),
    ]);

    const authedMsgs: Array<{ type: string; data: PropFirmStatusResponse }> = [];
    const unauthedMsgs: unknown[] = [];

    authedWs.on('message', (raw) => {
      const parsed = JSON.parse(raw.toString());
      if (parsed.type === 'PROPFIRM_STATUS') {
        authedMsgs.push(parsed);
      }
    });
    unauthedWs.on('message', (raw) => {
      unauthedMsgs.push(JSON.parse(raw.toString()));
    });

    const baseStatus = guard.getStatus(4606.01);
    for (let i = 1; i <= 5; i++) {
      wsHub.broadcastPropFirmStatus({
        ...baseStatus,
        dailyPnlUsd: i * 100,
      });
    }

    // Immediate burst should emit at most 1 message
    expect(authedMsgs.length).toBeLessThanOrEqual(1);
    expect(unauthedMsgs.length).toBe(0);

    // Wait > 500ms for coalesced trailing flush
    await new Promise((r) => setTimeout(r, 560));

    expect(authedMsgs.length).toBe(2);
    expect(authedMsgs[authedMsgs.length - 1]?.data.dailyPnlUsd).toBe(500);
    expect(unauthedMsgs.length).toBe(0);
  });
});
