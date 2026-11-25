import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import type { Request, Response } from 'polka';
import {
  validateHost,
  validateOrigin,
  requireSessionToken,
  jsonBodyParser,
  MAX_BODY_BYTES
} from '../auth.js';
import { SESSION_TOKEN, PORT } from '../../config.js';

interface MockResponse {
  statusCode: number;
  _ended: boolean;
  _body: string;
  _headers: Record<string, string>;
  setHeader: (key: string, val: string) => void;
  getHeader: (key: string) => string | undefined;
  end: (data?: string) => void;
}

function createMockReqRes(options: {
  method?: string;
  url?: string;
  headers?: Record<string, string>;
  socket?: { remoteAddress?: string };
} = {}): { req: Request; res: MockResponse & Response; next: ReturnType<typeof vi.fn> } {
  const req = new EventEmitter() as unknown as Request;
  req.method = options.method || 'GET';
  req.url = options.url || '/api/orders';
  req.headers = options.headers || {};
  req.params = {};
  req.query = {};
  (req as unknown as { socket?: { remoteAddress?: string } }).socket =
    options.socket ?? { remoteAddress: '127.0.0.1' };

  const headersMap: Record<string, string> = {};

  const res: MockResponse = {
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
    }
  };

  const next = vi.fn();

  return { req, res: res as unknown as MockResponse & Response, next };
}

describe('Security & Auth Guard Middleware', () => {
  describe('Host Guard (DNS Rebinding Protection)', () => {
    it('permits valid 127.0.0.1 and localhost hosts', () => {
      const hosts = [`127.0.0.1:${PORT}`, `localhost:${PORT}`];
      for (const host of hosts) {
        const { req, res, next } = createMockReqRes({ headers: { host } });
        validateHost(req, res, next);
        expect(next).toHaveBeenCalled();
        expect(res.statusCode).toBe(200);
      }
    });

    it('rejects external/arbitrary hostnames with 403 Forbidden', () => {
      const maliciousHosts = ['evil.com', 'attacker.domain.com:3400', '192.168.1.100:3400'];
      for (const host of maliciousHosts) {
        const { req, res, next } = createMockReqRes({ headers: { host } });
        validateHost(req, res, next);
        expect(next).not.toHaveBeenCalled();
        expect(res.statusCode).toBe(403);
        expect(JSON.parse(res._body).error).toContain('rejected by DNS rebinding guard');
      }
    });

    it('rejects missing host header with 403', () => {
      const { req, res, next } = createMockReqRes({ headers: {} });
      validateHost(req, res, next);
      expect(next).not.toHaveBeenCalled();
      expect(res.statusCode).toBe(403);
    });
  });

  describe('Origin Allowlist & CORS', () => {
    it('permits allowed origins and sets CORS response headers', () => {
      const allowed = [`http://127.0.0.1:${PORT}`, `http://localhost:${PORT}`, 'http://localhost:5173'];
      for (const origin of allowed) {
        const { req, res, next } = createMockReqRes({ headers: { origin } });
        validateOrigin(req, res, next);
        expect(next).toHaveBeenCalled();
        expect(res.statusCode).toBe(200);
        expect(res._headers['access-control-allow-origin']).toBe(origin);
        expect(res._headers['access-control-allow-headers']).toContain('X-Operator-Pin');
      }
    });

    it('rejects untrusted origin with 403 Forbidden', () => {
      const { req, res, next } = createMockReqRes({ headers: { origin: 'http://malicious-site.com' } });
      validateOrigin(req, res, next);
      expect(next).not.toHaveBeenCalled();
      expect(res.statusCode).toBe(403);
      expect(JSON.parse(res._body).error).toContain('Origin');
    });

    it('permits requests with no origin header (same-origin / server-to-server)', () => {
      const { req, res, next } = createMockReqRes({ headers: {} });
      validateOrigin(req, res, next);
      expect(next).toHaveBeenCalled();
      expect(res.statusCode).toBe(200);
    });

    it('responds 204 No Content for OPTIONS preflight with allowed origin', () => {
      const { req, res, next } = createMockReqRes({
        method: 'OPTIONS',
        headers: { origin: `http://127.0.0.1:${PORT}` }
      });
      validateOrigin(req, res, next);
      expect(next).not.toHaveBeenCalled();
      expect(res.statusCode).toBe(204);
      expect(res._ended).toBe(true);
    });
  });

  describe('Session Token Authentication', () => {
    it('authenticates request with valid Bearer session token', () => {
      const { req, res, next } = createMockReqRes({
        url: '/api/orders/open',
        headers: { authorization: `Bearer ${SESSION_TOKEN}` }
      });
      requireSessionToken(req, res, next);
      expect(next).toHaveBeenCalled();
      expect(req.token).toBe(SESSION_TOKEN);
      expect(res.statusCode).toBe(200);
    });

    it('rejects missing Authorization header with 401', () => {
      const { req, res, next } = createMockReqRes({ url: '/api/orders/open' });
      requireSessionToken(req, res, next);
      expect(next).not.toHaveBeenCalled();
      expect(res.statusCode).toBe(401);
      expect(JSON.parse(res._body).error).toContain('Missing or malformed');
    });

    it('rejects invalid token with 401', () => {
      const { req, res, next } = createMockReqRes({
        url: '/api/orders/open',
        headers: { authorization: 'Bearer invalid_wrong_token_12345' }
      });
      requireSessionToken(req, res, next);
      expect(next).not.toHaveBeenCalled();
      expect(res.statusCode).toBe(401);
      expect(JSON.parse(res._body).error).toContain('Invalid session token');
    });

    it('exempts GET /api/health and GET /api/auth/session from authentication', () => {
      const exemptEndpoints = ['/api/health', '/api/auth/session'];
      for (const url of exemptEndpoints) {
        const { req, res, next } = createMockReqRes({ method: 'GET', url });
        requireSessionToken(req, res, next);
        expect(next).toHaveBeenCalled();
        expect(res.statusCode).toBe(200);
      }
    });

    it('exempts non-API static web asset routes from authentication', () => {
      const staticUrls = ['/', '/index.html', '/assets/index.js', '/favicon.ico'];
      for (const url of staticUrls) {
        const { req, res, next } = createMockReqRes({ method: 'GET', url });
        requireSessionToken(req, res, next);
        expect(next).toHaveBeenCalled();
        expect(res.statusCode).toBe(200);
      }
    });
  });

  describe('256KB Streaming JSON Body Parser', () => {
    it('parses valid JSON payload into req.body', async () => {
      const payload = { symbol: 'SOLUSDT', marginUsd: 100, leverage: 5 };
      const { req, res, next } = createMockReqRes({ method: 'POST', url: '/api/orders/open' });

      jsonBodyParser(req, res, next);

      req.emit('data', Buffer.from(JSON.stringify(payload)));
      req.emit('end');

      expect(next).toHaveBeenCalled();
      expect(req.body).toEqual(payload);
    });

    it('rejects malformed JSON syntax with 400 Bad Request', () => {
      const { req, res, next } = createMockReqRes({ method: 'POST', url: '/api/orders/open' });

      jsonBodyParser(req, res, next);

      req.emit('data', Buffer.from('{ symbol: "broken JSON'));
      req.emit('end');

      expect(next).not.toHaveBeenCalled();
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res._body).error).toContain('Malformed JSON');
    });

    it('rejects payloads exceeding 256KB via Content-Length header with 413', () => {
      const { req, res, next } = createMockReqRes({
        method: 'POST',
        headers: { 'content-length': String(MAX_BODY_BYTES + 100) }
      });

      jsonBodyParser(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(res.statusCode).toBe(413);
      expect(JSON.parse(res._body).error).toContain('256KB limit');
    });

    it('rejects streamed data exceeding 256KB chunks with 413', () => {
      const { req, res, next } = createMockReqRes({ method: 'POST' });

      jsonBodyParser(req, res, next);

      // Emit oversized chunk
      const oversizedChunk = Buffer.alloc(MAX_BODY_BYTES + 1024, 'a');
      req.emit('data', oversizedChunk);

      expect(next).not.toHaveBeenCalled();
      expect(res.statusCode).toBe(413);
      expect(JSON.parse(res._body).error).toContain('256KB limit');
    });

    it('passes empty object for GET/HEAD without waiting for stream', () => {
      const { req, res, next } = createMockReqRes({ method: 'GET' });
      jsonBodyParser(req, res, next);
      expect(next).toHaveBeenCalled();
      expect(req.body).toEqual({});
    });
  });
});
