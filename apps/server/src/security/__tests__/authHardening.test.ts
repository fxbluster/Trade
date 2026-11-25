import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import polka, { type Request, type Response } from 'polka';
import type { DatabaseSync } from 'node:sqlite';
import type { AccountInfo, OpenOrderInfo } from '@tradeos/shared';
import { validateHost, validateOrigin } from '../auth.js';
import {
  SESSION_TOKEN,
  PORT,
  getWebhookSecret,
  getOperatorAccessPin,
  redactSecrets,
} from '../../config.js';
import { initializeDatabase } from '../../db/sqlite.js';
import { TradeManager } from '../../services/tradeManager.js';
import { registerRoutes } from '../../api/routes.js';
import type { BrokerAdapter } from '../../exchange/broker.js';

function createMockBroker(): BrokerAdapter {
  return {
    mode: 'BINANCE_DEMO',
    getAccount: vi.fn().mockResolvedValue({
      walletBalance: 5000.0,
      equity: 5000.0,
      availableBalance: 4500.0,
      unrealizedPnl: 0.0,
      currency: 'USDT',
    } as AccountInfo),
    getPosition: vi.fn().mockResolvedValue(null),
    openOrder: vi.fn(),
    createAlgoOrder: vi.fn(),
    closePosition: vi.fn(),
    cancelOrder: vi.fn().mockResolvedValue(true),
    cancelAllOrders: vi.fn().mockResolvedValue(true),
    moveToBreakeven: vi.fn(),
    getOpenOrders: vi.fn().mockResolvedValue([] as OpenOrderInfo[]),
  };
}

function createMiddlewareReqRes(options: {
  method?: string;
  url?: string;
  headers?: Record<string, string>;
  socket?: { remoteAddress?: string } | undefined;
} = {}) {
  const req = new EventEmitter() as unknown as Request;
  req.method = options.method || 'GET';
  req.url = options.url || '/api/health';
  req.headers = options.headers || {};
  req.params = {};
  req.query = {};
  if ('socket' in options) {
    (req as unknown as { socket?: { remoteAddress?: string } }).socket = options.socket;
  } else {
    (req as unknown as { socket?: { remoteAddress?: string } }).socket = { remoteAddress: '127.0.0.1' };
  }

  const headersMap: Record<string, string> = {};
  const res = {
    statusCode: 200,
    _ended: false,
    _body: '',
    _headers: headersMap,
    setHeader(key: string, val: string) {
      headersMap[key.toLowerCase()] = val;
    },
    getHeader(key: string) {
      return headersMap[key.toLowerCase()];
    },
    end(data?: string) {
      this._ended = true;
      if (data) this._body = data;
    },
  };
  const next = vi.fn();
  return { req, res: res as unknown as typeof res & Response, next };
}

describe('Auth & Tunnel Hardening', () => {
  const origPublicDomain = process.env.PUBLIC_DOMAIN;
  const origOperatorPin = process.env.OPERATOR_ACCESS_PIN;
  const origWebhookSecret = process.env.WEBHOOK_SECRET;

  let db: DatabaseSync;
  let app: ReturnType<typeof polka>;

  beforeEach(() => {
    delete process.env.PUBLIC_DOMAIN;
    delete process.env.OPERATOR_ACCESS_PIN;
    delete process.env.WEBHOOK_SECRET;

    db = initializeDatabase(':memory:');
    const broker = createMockBroker();
    const tradeManager = new TradeManager({
      db,
      broker,
      getMarkPrice: () => 150.0,
    });
    app = polka();
    registerRoutes(app, {
      tradeManager,
      broker,
      db,
      activeSymbol: 'SOLUSDT',
      getMarkPrice: () => 150.0,
    });
  });

  afterEach(() => {
    if (origPublicDomain === undefined) delete process.env.PUBLIC_DOMAIN;
    else process.env.PUBLIC_DOMAIN = origPublicDomain;

    if (origOperatorPin === undefined) delete process.env.OPERATOR_ACCESS_PIN;
    else process.env.OPERATOR_ACCESS_PIN = origOperatorPin;

    if (origWebhookSecret === undefined) delete process.env.WEBHOOK_SECRET;
    else process.env.WEBHOOK_SECRET = origWebhookSecret;
  });

  async function invoke(
    method: string,
    url: string,
    options: {
      body?: unknown;
      headers?: Record<string, string>;
      socket?: { remoteAddress?: string } | undefined;
    } = {}
  ): Promise<{ status: number; body: any }> {
    const parsedUrl = new URL(`http://127.0.0.1:${PORT}${url}`);
    const emitter = new EventEmitter();
    const req = Object.assign(emitter, {
      method,
      url,
      path: parsedUrl.pathname,
      headers: {
        host: `127.0.0.1:${PORT}`,
        ...(options.headers || {}),
      },
      params: {},
      query: Object.fromEntries(parsedUrl.searchParams),
      body: {},
      socket: 'socket' in options ? options.socket : { remoteAddress: '127.0.0.1' },
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
          let parsed: any = null;
          try {
            parsed = responseBody ? JSON.parse(responseBody) : null;
          } catch {
            parsed = responseBody;
          }
          resolve({ status: statusCode, body: parsed });
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
        if (options.body !== undefined) {
          emitter.emit('data', Buffer.from(JSON.stringify(options.body)));
        }
        emitter.emit('end');
      });
    });
  }

  describe('Host & Origin Wildcard / Spoofing Removal', () => {
    it('rejects wildcard *.trycloudflare.com Host when PUBLIC_DOMAIN is unset or different', () => {
      for (const host of ['random-tunnel.trycloudflare.com', 'random-tunnel.trycloudflare.com:443']) {
        const { req, res, next } = createMiddlewareReqRes({ headers: { host } });
        validateHost(req, res, next);
        expect(next).not.toHaveBeenCalled();
        expect(res.statusCode).toBe(403);
      }

      process.env.PUBLIC_DOMAIN = 'my-approved.trycloudflare.com';
      const { req, res, next } = createMiddlewareReqRes({
        headers: { host: 'other-attacker.trycloudflare.com' },
      });
      validateHost(req, res, next);
      expect(next).not.toHaveBeenCalled();
      expect(res.statusCode).toBe(403);
    });

    it('rejects host.startsWith suffix spoofing against PUBLIC_DOMAIN', () => {
      process.env.PUBLIC_DOMAIN = 'trade.example.com';

      for (const spoofed of ['trade.example.com.evil.tld', 'trade.example.com.attacker.io:443']) {
        const { req, res, next } = createMiddlewareReqRes({ headers: { host: spoofed } });
        validateHost(req, res, next);
        expect(next).not.toHaveBeenCalled();
        expect(res.statusCode).toBe(403);
      }

      for (const valid of ['trade.example.com', 'trade.example.com:443', 'TRADE.EXAMPLE.COM.']) {
        const { req, res, next } = createMiddlewareReqRes({ headers: { host: valid } });
        validateHost(req, res, next);
        expect(next).toHaveBeenCalled();
        expect(res.statusCode).toBe(200);
      }
    });

    it('rejects wildcard *.trycloudflare.com Origin and exposes X-Operator-Pin header for exact PUBLIC_DOMAIN', () => {
      const denied = createMiddlewareReqRes({
        headers: { origin: 'https://random-tunnel.trycloudflare.com' },
      });
      validateOrigin(denied.req, denied.res, denied.next);
      expect(denied.next).not.toHaveBeenCalled();
      expect(denied.res.statusCode).toBe(403);

      process.env.PUBLIC_DOMAIN = 'https://trade.example.com';
      const allowed = createMiddlewareReqRes({
        headers: { origin: 'https://trade.example.com' },
      });
      validateOrigin(allowed.req, allowed.res, allowed.next);
      expect(allowed.next).toHaveBeenCalled();
      expect(allowed.res.statusCode).toBe(200);
      expect(allowed.res._headers['access-control-allow-headers']).toContain('X-Operator-Pin');
    });
  });

  describe('Config Dynamic Getters & Secret Redaction', () => {
    it('does not expose a hardcoded default WEBHOOK_SECRET and reads env dynamically', () => {
      expect(getWebhookSecret()).toBe('');
      process.env.WEBHOOK_SECRET = 'super-secure-webhook-secret-1234';
      expect(getWebhookSecret()).toBe('super-secure-webhook-secret-1234');

      expect(getOperatorAccessPin()).toBe('');
      process.env.OPERATOR_ACCESS_PIN = 'operator-pin-0123456789';
      expect(getOperatorAccessPin()).toBe('operator-pin-0123456789');
    });

    it('redacts pin fields alongside key/secret/token in redactSecrets()', () => {
      const sanitized = redactSecrets({
        pin: '1234567890123456',
        operatorPin: 'secret-pin-value',
        nested: { 'x-operator-pin': 'abc', label: 'visible' },
      }) as Record<string, any>;

      expect(sanitized.pin).toBe('***REDACTED***');
      expect(sanitized.operatorPin).toBe('***REDACTED***');
      expect(sanitized.nested['x-operator-pin']).toBe('***REDACTED***');
      expect(sanitized.nested.label).toBe('visible');
    });
  });

  describe('GET /api/auth/session 403/200/401 Truth Table', () => {
    it('returns 403 when req.socket.remoteAddress is missing', async () => {
      const res = await invoke('GET', '/api/auth/session', { socket: undefined });
      expect(res.status).toBe(403);
    });

    it('returns 403 when PUBLIC_DOMAIN is set without OPERATOR_ACCESS_PIN >= 16 chars', async () => {
      process.env.PUBLIC_DOMAIN = 'trade.example.com';
      process.env.OPERATOR_ACCESS_PIN = 'short-pin';

      const res = await invoke('GET', '/api/auth/session', {
        socket: { remoteAddress: '127.0.0.1' },
      });
      expect(res.status).toBe(403);
    });

    it('returns 200 for unproxied loopback addresses (127.0.0.1, ::1, ::ffff:127.0.0.1)', async () => {
      for (const remoteAddress of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) {
        const res = await invoke('GET', '/api/auth/session', {
          socket: { remoteAddress },
        });
        expect(res.status).toBe(200);
        expect(res.body.token).toBe(SESSION_TOKEN);
      }
    });

    it('treats loopback with forwarding proxy headers as proxied (401 without valid X-Operator-Pin)', async () => {
      process.env.OPERATOR_ACCESS_PIN = 'valid-operator-pin-16plus';

      for (const proxyHeader of [
        'x-forwarded-for',
        'cf-connecting-ip',
        'forwarded',
        'x-real-ip',
        'true-client-ip',
      ]) {
        const missingPin = await invoke('GET', '/api/auth/session', {
          socket: { remoteAddress: '127.0.0.1' },
          headers: { [proxyHeader]: '203.0.113.42' },
        });
        expect(missingPin.status).toBe(401);

        const wrongPin = await invoke('GET', '/api/auth/session', {
          socket: { remoteAddress: '127.0.0.1' },
          headers: {
            [proxyHeader]: '203.0.113.42',
            'x-operator-pin': 'wrong-pin-0000000000',
          },
        });
        expect(wrongPin.status).toBe(401);

        const validPin = await invoke('GET', '/api/auth/session', {
          socket: { remoteAddress: '127.0.0.1' },
          headers: {
            [proxyHeader]: '203.0.113.42',
            'x-operator-pin': 'valid-operator-pin-16plus',
          },
        });
        expect(validPin.status).toBe(200);
        expect(validPin.body.token).toBe(SESSION_TOKEN);
      }
    });

    it('requires valid X-Operator-Pin on non-loopback sockets (401 -> 200)', async () => {
      process.env.PUBLIC_DOMAIN = 'trade.example.com';
      process.env.OPERATOR_ACCESS_PIN = 'valid-operator-pin-16plus';

      const unauth = await invoke('GET', '/api/auth/session', {
        socket: { remoteAddress: '10.0.0.25' },
        headers: { host: 'trade.example.com' },
      });
      expect(unauth.status).toBe(401);

      const auth = await invoke('GET', '/api/auth/session', {
        socket: { remoteAddress: '10.0.0.25' },
        headers: {
          host: 'trade.example.com',
          'x-operator-pin': 'valid-operator-pin-16plus',
        },
      });
      expect(auth.status).toBe(200);
      expect(auth.body.token).toBe(SESSION_TOKEN);
    });
  });

  describe('POST /api/webhook Fail-Closed 503', () => {
    it('returns 503 when WEBHOOK_SECRET is unset or shorter than 16 chars', async () => {
      const unsetRes = await invoke('POST', '/api/webhook', {
        body: {
          secret: 'tradeos-webhook-secret-passphrase',
          symbol: 'SOLUSDT',
          side: 'BUY',
        },
      });
      expect(unsetRes.status).toBe(503);

      process.env.WEBHOOK_SECRET = 'too-short';
      const shortRes = await invoke('POST', '/api/webhook', {
        body: {
          secret: 'too-short',
          symbol: 'SOLUSDT',
          side: 'BUY',
        },
      });
      expect(shortRes.status).toBe(503);
    });

    it('rejects bad secret with 401 and accepts valid >= 16-char secret with 200', async () => {
      process.env.WEBHOOK_SECRET = 'prod-webhook-secret-16chars';

      const badRes = await invoke('POST', '/api/webhook', {
        body: {
          secret: 'wrong-webhook-secret-16chr',
          symbol: 'SOLUSDT',
          side: 'BUY',
          time: Date.now(),
        },
      });
      expect(badRes.status).toBe(401);

      const goodRes = await invoke('POST', '/api/webhook', {
        body: {
          secret: 'prod-webhook-secret-16chars',
          symbol: 'SOLUSDT',
          side: 'BUY',
          time: Date.now(),
        },
      });
      expect(goodRes.status).toBe(200);
      expect(goodRes.body.status).toBe('INGESTED');
    });
  });
});
