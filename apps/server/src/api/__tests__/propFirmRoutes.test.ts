import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import http from 'node:http';
import WebSocket from 'ws';
import polka, { type Request, type Response } from 'polka';
import type { DatabaseSync } from 'node:sqlite';
import type { AccountInfo, OpenOrderInfo, PropFirmStatusResponse, TradeRecord } from '@tradeos/shared';
import { initializeDatabase, PropFirmRepo, TradesRepo } from '../../db/sqlite.js';
import { PropFirmRiskGuard } from '../../quant/propFirmRiskGuard.js';
import { TradeManager } from '../../services/tradeManager.js';
import type { AutoPilotManager } from '../../services/autoPilotManager.js';
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
        search: parsedUrl.search,
        query: parsedUrl.searchParams.toString(),
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

function makeOpenTrade(id: string, symbol: string = 'SOLUSDT'): TradeRecord {
  return {
    id,
    symbol,
    broker_mode: 'BINANCE_DEMO',
    side: 'BUY',
    status: 'OPEN',
    entry_price: 150,
    exit_price: null,
    quantity: 10,
    remaining_qty: 10,
    leverage: 5,
    margin_usd: 300,
    stop_loss: null,
    tp1: null,
    tp2: null,
    be_price: null,
    is_breakeven: 0,
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
      realizedNetPnlUsd: 42.05,
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

    const newCycleRes = await invokeWithoutGuard('POST', '/api/propfirm/new-cycle');
    expect(newCycleRes.status).toBe(503);
  });

  it('newCycle_requiresAuthAndRejectsOpenOrActiveAndAllowsTerminalOrTrailingHalt', async () => {
    // 1. Unauthenticated POST /api/propfirm/new-cycle -> 401
    const unauthRes = await invokeRoute('POST', '/api/propfirm/new-cycle', {}, {
      authorization: '',
    });
    expect(unauthRes.status).toBe(401);

    // 2. While Cycle #1 is ACTIVE -> 409 CYCLE_STILL_ACTIVE with Azerbaijani error
    const activeRes = await invokeRoute('POST', '/api/propfirm/new-cycle', {});
    expect(activeRes.status).toBe(409);
    expect(activeRes.body.code).toBe('CYCLE_STILL_ACTIVE');
    expect(typeof activeRes.body.error).toBe('string');
    expect(activeRes.body.error).toMatch(/dövrə/i);

    // 3. While Cycle #1 is HALTED_DAILY_BUFFER -> 409 CYCLE_STILL_ACTIVE
    propFirmRiskGuard.recordTradeClosed({
      realizedNetPnlUsd: -125,
      liveWalletBalanceUsd: walletBalance,
    });
    expect(propFirmRepo.getLatestCycle()?.status).toBe('HALTED_DAILY_BUFFER');

    const haltedDailyRes = await invokeRoute('POST', '/api/propfirm/new-cycle', {});
    expect(haltedDailyRes.status).toBe(409);
    expect(haltedDailyRes.body.code).toBe('CYCLE_STILL_ACTIVE');

    // 4. Transition Cycle #1 to HALTED_TRAILING_BUFFER, but with an open trade in SQLite -> 409 OPEN_POSITION_EXISTS
    const cycle1 = propFirmRepo.getLatestCycle()!;
    propFirmRepo.updateCycle(cycle1.id, { status: 'HALTED_TRAILING_BUFFER' });

    const tradesRepo = new TradesRepo(db);
    tradesRepo.insert(makeOpenTrade('open-trade-1', 'SOLUSDT'));

    const openDbTradeRes = await invokeRoute('POST', '/api/propfirm/new-cycle', {});
    expect(openDbTradeRes.status).toBe(409);
    expect(openDbTradeRes.body.code).toBe('OPEN_POSITION_EXISTS');

    // Close the SQLite trade so DB is flat
    tradesRepo.update('open-trade-1', { status: 'CLOSED', closed_at: Date.now() });

    // 5. Mock autoPilotManager in-flight states -> 409 OPEN_POSITION_EXISTS
    let mockApState: string = 'PLACING_ORDER';
    const clearPropFirmBlock = vi.fn(() => {
      mockApState = 'IDLE';
    });
    const mockAutoPilotManager = {
      getState: vi.fn(() => mockApState),
      clearPropFirmBlock,
    } as unknown as AutoPilotManager & { clearPropFirmBlock: ReturnType<typeof vi.fn> };

    const apApp = polka();
    registerRoutes(apApp, {
      tradeManager,
      broker: mockBroker,
      db,
      activeSymbol: 'SOLUSDT',
      propFirmRiskGuard,
      getPropFirmWalletBalance: () => walletBalance,
      autoPilotManager: mockAutoPilotManager,
    });
    const invokeApRoute = createRouteInvoker(apApp);

    for (const busyState of ['PLACING_ORDER', 'LIMIT_CHASING', 'POSITION_OPEN', 'CLOSING']) {
      mockApState = busyState;
      const busyRes = await invokeApRoute('POST', '/api/propfirm/new-cycle', {});
      expect(busyRes.status).toBe(409);
      expect(busyRes.body.code).toBe('OPEN_POSITION_EXISTS');
    }

    // 6. Flat & HALTED_TRAILING_BUFFER -> 200, finalizes Cycle #1 as FAILED_TRAILING, clears block, starts Cycle #2 ACTIVE
    mockApState = 'IDLE';
    const rolloverFromTrailingRes = await invokeApRoute('POST', '/api/propfirm/new-cycle', {});
    expect(rolloverFromTrailingRes.status).toBe(200);
    expect(rolloverFromTrailingRes.body.ok).toBe(true);
    expect(rolloverFromTrailingRes.body.status.cycle.cycleNumber).toBe(2);
    expect(rolloverFromTrailingRes.body.status.cycle.status).toBe('ACTIVE');
    expect(rolloverFromTrailingRes.body.autoPilotState).toBe('IDLE');
    expect(clearPropFirmBlock).toHaveBeenCalledTimes(1);

    const cyclesAfterTrailing = propFirmRepo.listCycles(10);
    const finalizedCycle1 = cyclesAfterTrailing.find((c) => c.cycleNumber === 1);
    expect(finalizedCycle1?.status).toBe('FAILED_TRAILING');
    expect(finalizedCycle1?.closedAt).not.toBeNull();

    // 7. Pass Cycle #2, then fire concurrent Promise.all two POST /api/propfirm/new-cycle calls -> one 200, one 409, only 1 Cycle #3
    propFirmRiskGuard.recordTradeClosed({
      realizedNetPnlUsd: 2500,
      liveWalletBalanceUsd: 52500,
    });
    expect(propFirmRepo.getLatestCycle()?.status).toBe('PASSED');

    const [c1, c2] = await Promise.all([
      invokeApRoute('POST', '/api/propfirm/new-cycle', {}),
      invokeApRoute('POST', '/api/propfirm/new-cycle', {}),
    ]);
    const statuses = [c1.status, c2.status].sort((a, b) => a - b);
    expect(statuses).toEqual([200, 409]);

    const cyclesAfterConcurrent = propFirmRepo.listCycles(10);
    const cycle3Rows = cyclesAfterConcurrent.filter((c) => c.cycleNumber === 3);
    expect(cycle3Rows.length).toBe(1);
    expect(cycle3Rows[0]?.status).toBe('ACTIVE');
  });

  it('certificate_supportsMarkdownAndRejectsInvalidFormat', async () => {
    // Cycle #1 failed (-$1,520.00)
    propFirmRiskGuard.recordTradeClosed({
      realizedNetPnlUsd: -1520,
      liveWalletBalanceUsd: walletBalance,
    });
    const c1 = propFirmRepo.getLatestCycle()!;
    propFirmRepo.updateCycle(c1.id, {
      status: 'FAILED_DAILY',
      netPnlUsd: -1520,
      realizedPnlUsd: -1520,
      closedAt: Date.now(),
    });

    // Cycle #2 passed (+$2,510.00)
    propFirmRiskGuard.startNewCycle(50_000);
    propFirmRiskGuard.recordTradeClosed({
      realizedNetPnlUsd: 2510,
      liveWalletBalanceUsd: 52_510,
    });

    const mdRes = await invokeRoute('GET', '/api/propfirm/certificate?format=markdown');
    expect(mdRes.status).toBe(200);
    expect(mdRes.headers['content-type']).toBe('text/markdown; charset=utf-8');
    expect(mdRes.headers['content-disposition']).toMatch(
      /^attachment; filename="upcomers-50k-certificate-\d{4}-\d{2}-\d{2}\.md"$/
    );
    expect(typeof mdRes.body).toBe('string');
    expect(mdRes.body).toContain('-$1,520.00');
    expect(mdRes.body).toContain('+$2,510.00');
    expect(mdRes.body).not.toContain('$-');

    const badRes = await invokeRoute('GET', '/api/propfirm/certificate?format=xml');
    expect(badRes.status).toBe(400);
    expect(typeof badRes.body.error).toBe('string');
  });

  it('symbol_rejectsSwitchWhenPositionOpen', async () => {
    const tradesRepo = new TradesRepo(db);
    tradesRepo.insert(makeOpenTrade('open-trade-sym-1', 'SOLUSDT'));

    const res = await invokeRoute('POST', '/api/symbol', { symbol: 'BTCUSDT' });
    expect(res.status).toBe(409);
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
