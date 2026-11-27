import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import polka, { type Request, type Response } from 'polka';
import type { DatabaseSync } from 'node:sqlite';
import { initializeDatabase } from '../../db/sqlite.js';
import { TradeManager } from '../../services/tradeManager.js';
import { AutoPilotManager } from '../../services/autoPilotManager.js';
import { ConfluenceEngine } from '../../quant/confluenceEngine.js';
import { registerRoutes, type AppContext } from '../routes.js';
import { requireSessionToken } from '../../security/auth.js';
import { SESSION_TOKEN, PORT } from '../../config.js';
import type { BrokerAdapter } from '../../exchange/broker.js';
import type { AccountInfo, OpenOrderInfo } from '@tradeos/shared';

const TEST_WEBHOOK_SECRET = 'test-webhook-secret-16chars';

function createMockBroker(): BrokerAdapter {
  return {
    mode: 'BINANCE_DEMO',
    getAccount: vi.fn().mockResolvedValue({
      walletBalance: 1000.0,
      equity: 1000.0,
      availableBalance: 1000.0,
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

describe('TradeOS v2 — Webhook Ingestion & Auto-Pilot API Routes', () => {
  let db: DatabaseSync;
  let mockBroker: BrokerAdapter;
  let tradeManager: TradeManager;
  let confluenceEngine: ConfluenceEngine;
  let autoPilotManager: AutoPilotManager;
  let ctx: AppContext;
  let app: ReturnType<typeof polka>;
  const origWebhookSecret = process.env.WEBHOOK_SECRET;

  beforeEach(() => {
    process.env.WEBHOOK_SECRET = TEST_WEBHOOK_SECRET;
    db = initializeDatabase(':memory:');
    mockBroker = createMockBroker();
    tradeManager = new TradeManager({
      db,
      broker: mockBroker,
      getMarkPrice: () => 150.0,
    });
    confluenceEngine = new ConfluenceEngine();
    autoPilotManager = new AutoPilotManager({
      db,
      tradeManager,
      broker: mockBroker,
      confluenceEngine,
      getMarkPrice: () => 150.0,
      config: {
        enabled: false,
        consensusThreshold: 4,
        marginAllocationPct: 10.0,
        leverage: 10,
        oppositeExitEnabled: true,
        circuitBreakerConsecutiveLosses: 2,
        circuitBreakerCooldownMs: 3600_000,
      },
    });

    ctx = {
      tradeManager,
      broker: mockBroker,
      db,
      confluenceEngine,
      autoPilotManager,
      activeSymbol: 'SOLUSDT',
      getMarkPrice: () => 150.0,
    };

    app = polka();
    registerRoutes(app, ctx);
  });

  afterEach(() => {
    if (origWebhookSecret === undefined) delete process.env.WEBHOOK_SECRET;
    else process.env.WEBHOOK_SECRET = origWebhookSecret;
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
      socket: { remoteAddress: '127.0.0.1' },
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
  }

  // --------------------------------------------------------------------------
  // 1. Bearer Token Auth Exemption for POST /api/webhook
  // --------------------------------------------------------------------------
  describe('Security & Auth Bypass for Webhook', () => {
    it('exempts POST /api/webhook from Bearer session token authentication', () => {
      const req = new EventEmitter() as unknown as Request;
      req.method = 'POST';
      req.url = '/api/webhook';
      req.headers = {}; // No Authorization header

      let nextCalled = false;
      const res = {
        statusCode: 200,
        setHeader: vi.fn(),
        end: vi.fn(),
      } as unknown as Response;

      requireSessionToken(req, res, () => {
        nextCalled = true;
      });

      expect(nextCalled).toBe(true);
      expect(res.statusCode).toBe(200);
    });
  });

  // --------------------------------------------------------------------------
  // 2. POST /api/webhook (TradingView PineScript v6 Ingestion)
  // --------------------------------------------------------------------------
  describe('POST /api/webhook — PineScript Webhook Alert Ingestion', () => {
    it('rejects request with 401 when secret passphrase is missing', async () => {
      const res = await invokeRoute('POST', '/api/webhook', {
        symbol: 'SOLUSDT',
        side: 'BUY',
        time: Date.now(),
      });

      expect(res.status).toBe(401);
      expect(res.body.error).toContain('Missing webhook secret passphrase');
    });

    it('rejects request with 401 when secret passphrase is invalid', async () => {
      const res = await invokeRoute('POST', '/api/webhook', {
        secret: 'invalid-wrong-passphrase',
        symbol: 'SOLUSDT',
        side: 'BUY',
        time: Date.now(),
      });

      expect(res.status).toBe(401);
      expect(res.body.error).toContain('Invalid webhook secret passphrase');
    });

    it('rejects request with 400 when timestamp drift exceeds 30 seconds', async () => {
      const staleTimestamp = Date.now() - 35_000; // 35 seconds in the past
      const res = await invokeRoute('POST', '/api/webhook', {
        secret: TEST_WEBHOOK_SECRET,
        symbol: 'SOLUSDT',
        side: 'BUY',
        time: staleTimestamp,
      });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('Webhook timestamp drift exceeds 30 seconds');
    });

    it('rejects request with 400 when symbol or side is missing', async () => {
      const res = await invokeRoute('POST', '/api/webhook', {
        secret: TEST_WEBHOOK_SECRET,
        time: Date.now(),
      });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('Missing symbol or side');
    });

    it('accepts valid webhook alert and returns 200 INGESTED', async () => {
      const now = Date.now();
      const res = await invokeRoute('POST', '/api/webhook', {
        secret: TEST_WEBHOOK_SECRET,
        symbol: 'SOLUSDT',
        side: 'BUY',
        time: now,
        price: 150.5,
        alert_id: 'pine_alert_unique_001',
      });

      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.status).toBe('INGESTED');
      expect(res.body.symbol).toBe('SOLUSDT');
      expect(res.body.side).toBe('BUY');
    });

    it('enforces 60-second LRU deduplication on alert_id returning 400', async () => {
      const now = Date.now();
      const alertId = 'pine_dedup_test_' + Date.now();

      // First ingestion: 200 OK
      const res1 = await invokeRoute('POST', '/api/webhook', {
        secret: TEST_WEBHOOK_SECRET,
        symbol: 'SOLUSDT',
        side: 'BUY',
        time: now,
        alert_id: alertId,
      });
      expect(res1.status).toBe(200);

      // Second ingestion with same alert_id within 60s: 400 Bad Request
      const res2 = await invokeRoute('POST', '/api/webhook', {
        secret: TEST_WEBHOOK_SECRET,
        symbol: 'SOLUSDT',
        side: 'BUY',
        time: now + 100,
        alert_id: alertId,
      });
      expect(res2.status).toBe(400);
      expect(res2.body.error).toBe('DUPLICATE_ALERT_ID');
    });
  });

  // --------------------------------------------------------------------------
  // 3. GET /api/confluence (6+1 Confluence Snapshot)
  // --------------------------------------------------------------------------
  describe('GET /api/confluence — Live Confluence Snapshot', () => {
    it('returns active ConfluenceSnapshot when ConfluenceEngine is present', async () => {
      // Simulate evaluate to populate snapshot
      confluenceEngine.evaluate({
        symbol: 'SOLUSDT',
        currentPrice: 150.0,
        indicators: null,
        cvd: null,
      });

      const res = await invokeRoute('GET', '/api/confluence?symbol=SOLUSDT');
      expect(res.status).toBe(200);
      expect(res.body.symbol).toBe('SOLUSDT');
      expect(Array.isArray(res.body.pillars)).toBe(true);
      expect(res.body.pillars.length).toBe(7);
      expect(res.body.threshold).toBe(4);
    });

    it('returns 404 when ConfluenceEngine is not initialized', async () => {
      const bareApp = polka();
      registerRoutes(bareApp, { ...ctx, confluenceEngine: undefined });

      const parsedUrl = new URL(`http://127.0.0.1:${PORT}/api/confluence`);
      const req = Object.assign(new EventEmitter(), {
        method: 'GET',
        url: '/api/confluence',
        path: '/api/confluence',
        headers: { host: `127.0.0.1:${PORT}`, authorization: `Bearer ${SESSION_TOKEN}` },
        params: {},
        query: {},
        body: {},
      }) as unknown as Request;

      let statusCode = 200;
      let bodyData = '';
      await new Promise<void>((resolve) => {
        const res = {
          statusCode: 200,
          setHeader: vi.fn(),
          end: (data?: string) => {
            if (data) bodyData = data;
            resolve();
          },
        } as unknown as Response;
        Object.defineProperty(res, 'statusCode', {
          get: () => statusCode,
          set: (v: number) => {
            statusCode = v;
          },
        });
        bareApp.handler(req, res, { pathname: '/api/confluence', query: {} });
      });

      expect(statusCode).toBe(404);
      expect(JSON.parse(bodyData).error).toContain('ConfluenceEngine not initialized');
    });
  });

  // --------------------------------------------------------------------------
  // 4. POST /api/autopilot/config (Configuration Management)
  // --------------------------------------------------------------------------
  describe('POST /api/autopilot/config — Auto-Pilot Configuration', () => {
    it('rejects margin allocation greater than 20.0% with 400', async () => {
      const res = await invokeRoute('POST', '/api/autopilot/config', {
        marginAllocationPct: 25.0, // Exceeds 20% hard cap!
      });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('margin allocation cannot exceed 20.0%');
    });

    it('updates config successfully within valid bounds', async () => {
      const res = await invokeRoute('POST', '/api/autopilot/config', {
        marginAllocationPct: 8.5,
        consensusThreshold: 5,
        leverage: 8,
      });

      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.config.marginAllocationPct).toBe(8.5);
      expect(res.body.config.consensusThreshold).toBe(5);
      expect(res.body.config.leverage).toBe(8);
      expect(confluenceEngine.getConsensusThreshold()).toBe(5);
    });

    it('returns 404 when AutoPilotManager is not initialized', async () => {
      const bareApp = polka();
      registerRoutes(bareApp, { ...ctx, autoPilotManager: undefined });

      const emitter = new EventEmitter();
      const req = Object.assign(emitter, {
        method: 'POST',
        url: '/api/autopilot/config',
        path: '/api/autopilot/config',
        headers: { host: `127.0.0.1:${PORT}`, authorization: `Bearer ${SESSION_TOKEN}` },
        params: {},
        query: {},
        body: {},
      }) as unknown as Request;

      let statusCode = 200;
      let bodyData = '';
      await new Promise<void>((resolve) => {
        const res = {
          statusCode: 200,
          setHeader: vi.fn(),
          end: (data?: string) => {
            if (data) bodyData = data;
            resolve();
          },
        } as unknown as Response;
        Object.defineProperty(res, 'statusCode', {
          get: () => statusCode,
          set: (v: number) => {
            statusCode = v;
          },
        });
        bareApp.handler(req, res, { pathname: '/api/autopilot/config', query: {} });
        process.nextTick(() => {
          emitter.emit('data', Buffer.from(JSON.stringify({ marginAllocationPct: 5 })));
          emitter.emit('end');
        });
      });

      expect(statusCode).toBe(404);
      expect(JSON.parse(bodyData).error).toContain('AutoPilotManager not initialized');
    });
  });

  // --------------------------------------------------------------------------
  // 5. POST /api/autopilot/toggle (State Machine Latch Control)
  // --------------------------------------------------------------------------
  describe('POST /api/autopilot/toggle — Auto-Pilot Enable/Disable', () => {
    it('toggles enabled state when called without explicit enabled param', async () => {
      expect(autoPilotManager.getConfig().enabled).toBe(false);

      // Toggle from false to true
      const res1 = await invokeRoute('POST', '/api/autopilot/toggle', {});
      expect(res1.status).toBe(200);
      expect(res1.body.ok).toBe(true);
      expect(res1.body.enabled).toBe(true);
      expect(autoPilotManager.getConfig().enabled).toBe(true);

      // Toggle from true to false
      const res2 = await invokeRoute('POST', '/api/autopilot/toggle', {});
      expect(res2.status).toBe(200);
      expect(res2.body.ok).toBe(true);
      expect(res2.body.enabled).toBe(false);
      expect(autoPilotManager.getConfig().enabled).toBe(false);
    });

    it('sets explicit enabled state when passed in request body', async () => {
      const res1 = await invokeRoute('POST', '/api/autopilot/toggle', { enabled: true });
      expect(res1.status).toBe(200);
      expect(res1.body.enabled).toBe(true);
      expect(autoPilotManager.getConfig().enabled).toBe(true);

      const res2 = await invokeRoute('POST', '/api/autopilot/toggle', { enabled: false });
      expect(res2.status).toBe(200);
      expect(res2.body.enabled).toBe(false);
      expect(autoPilotManager.getConfig().enabled).toBe(false);
    });

    it('returns 404 when AutoPilotManager is not initialized', async () => {
      const bareApp = polka();
      registerRoutes(bareApp, { ...ctx, autoPilotManager: undefined });

      const emitter = new EventEmitter();
      const req = Object.assign(emitter, {
        method: 'POST',
        url: '/api/autopilot/toggle',
        path: '/api/autopilot/toggle',
        headers: { host: `127.0.0.1:${PORT}`, authorization: `Bearer ${SESSION_TOKEN}` },
        params: {},
        query: {},
        body: {},
      }) as unknown as Request;

      let statusCode = 200;
      let bodyData = '';
      await new Promise<void>((resolve) => {
        const res = {
          statusCode: 200,
          setHeader: vi.fn(),
          end: (data?: string) => {
            if (data) bodyData = data;
            resolve();
          },
        } as unknown as Response;
        Object.defineProperty(res, 'statusCode', {
          get: () => statusCode,
          set: (v: number) => {
            statusCode = v;
          },
        });
        bareApp.handler(req, res, { pathname: '/api/autopilot/toggle', query: {} });
        process.nextTick(() => {
          emitter.emit('data', Buffer.from(JSON.stringify({ enabled: true })));
          emitter.emit('end');
        });
      });

      expect(statusCode).toBe(404);
      expect(JSON.parse(bodyData).error).toContain('AutoPilotManager not initialized');
    });

    it('successfully resets cooldown via POST /api/autopilot/reset-cooldown', async () => {
      // Put manager in cooldown first
      const settingsRepo = (autoPilotManager as any).settingsRepo;
      settingsRepo.set('autopilot_cooldown_until', { until: Date.now() + 3600000 });
      (autoPilotManager as any).cooldownUntil = Date.now() + 3600000;
      (autoPilotManager as any).state = 'COOLDOWN_ACTIVE';

      const res = await invokeRoute('POST', '/api/autopilot/reset-cooldown');
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.state).toBe('IDLE');
      expect(autoPilotManager.getState()).toBe('IDLE');
      expect(autoPilotManager.isCooldownActive()).toBe(false);
      expect(settingsRepo.get('autopilot_cooldown_until')).toBeNull();
    });
  });
});
