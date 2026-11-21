import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import polka from 'polka';
import http from 'node:http';
import { initializeDatabase } from '../../db/sqlite.js';
import { registerRoutes } from '../routes.js';
import { SESSION_TOKEN, PORT } from '../../config.js';
import type { DailyAuditResponse, DailyAuditSummary } from '@tradeos/shared';

function makeRequest(
  port: number,
  path: string,
  headers: Record<string, string> = {}
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path,
        method: 'GET',
        headers: {
          host: `127.0.0.1:${PORT}`,
          ...headers,
        },
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => {
          data += chunk;
        });
        res.on('end', () => {
          resolve({
            status: res.statusCode || 500,
            headers: res.headers,
            body: data,
          });
        });
      }
    );
    req.on('error', reject);
    req.end();
  });
}

describe('GET /api/audit/daily REST Route', () => {
  let server: http.Server;
  let port: number;
  let mockAuditService: {
    generateSessionSummary: ReturnType<typeof vi.fn>;
    formatMarkdownReport: ReturnType<typeof vi.fn>;
  };

  const sampleSummary: DailyAuditSummary = {
    total_setups: 8,
    executed_trades: 2,
    blocked_setups: 6,
    capital_saved_usd: 48.75,
    missed_profit_usd: 15.2,
    expired_pnl_usd: -2.1,
    net_risk_value_usd: 33.55,
    veto_breakdown: { MACRO_VETO: 5, SPREAD_VETO: 1 },
  };

  const sampleResponse: DailyAuditResponse = {
    summary: sampleSummary,
    records: [],
    generated_at: 1700000000000,
  };

  const sampleMarkdown = '# TradeOS Daily Session Audit Report\n\nTotal Setups: 8';

  beforeAll(async () => {
    const db = initializeDatabase(':memory:');
    mockAuditService = {
      generateSessionSummary: vi.fn().mockImplementation((sinceMs?: number) => sampleResponse),
      formatMarkdownReport: vi.fn().mockImplementation((resp: DailyAuditResponse) => sampleMarkdown),
    };

    const app = polka();
    registerRoutes(app, {
      db,
      broker: { mode: 'BINANCE_DEMO' } as any,
      tradeManager: { getMarkPrice: () => 100 } as any,
      decisionAuditService: mockAuditService as any,
    } as any);

    server = http.createServer(app.handler);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address() as any;
    port = addr.port;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('1. 401 Unauthorized when missing or invalid session token', async () => {
    // Missing Authorization header
    const resNoAuth = await makeRequest(port, '/api/audit/daily');
    expect(resNoAuth.status).toBe(401);
    const bodyNoAuth = JSON.parse(resNoAuth.body);
    expect(bodyNoAuth.error).toContain('Unauthorized');

    // Invalid Bearer token
    const resBadAuth = await makeRequest(port, '/api/audit/daily', {
      authorization: 'Bearer invalid-token-xyz',
    });
    expect(resBadAuth.status).toBe(401);
    const bodyBadAuth = JSON.parse(resBadAuth.body);
    expect(bodyBadAuth.error).toContain('Unauthorized');
  });

  it('2. 200 OK with application/json format (default & explicit)', async () => {
    // Default format (omitted) and session=current
    const resCurrent = await makeRequest(port, '/api/audit/daily', {
      authorization: `Bearer ${SESSION_TOKEN}`,
    });
    expect(resCurrent.status).toBe(200);
    expect(resCurrent.headers['content-type']).toContain('application/json');
    const dataCurrent = JSON.parse(resCurrent.body);
    expect(dataCurrent.summary.total_setups).toBe(8);
    expect(dataCurrent.summary.net_risk_value_usd).toBe(33.55);

    // Verify generateSessionSummary was called with sinceMs (around 8 hours ago = 28,800,000 ms)
    expect(mockAuditService.generateSessionSummary).toHaveBeenCalled();
    const lastCallArg = mockAuditService.generateSessionSummary.mock.calls[0][0];
    expect(typeof lastCallArg).toBe('number');
    const now = Date.now();
    expect(lastCallArg).toBeGreaterThan(now - 30_000_000);
    expect(lastCallArg).toBeLessThan(now - 25_000_000);

    // Explicit format=json and session=all
    mockAuditService.generateSessionSummary.mockClear();
    const resAll = await makeRequest(port, '/api/audit/daily?session=all&format=json', {
      authorization: `Bearer ${SESSION_TOKEN}`,
    });
    expect(resAll.status).toBe(200);
    expect(resAll.headers['content-type']).toContain('application/json');
    expect(mockAuditService.generateSessionSummary).toHaveBeenCalledWith(undefined);
  });

  it('3. 200 OK with text/markdown format and attachment header', async () => {
    const res = await makeRequest(port, '/api/audit/daily?format=markdown', {
      authorization: `Bearer ${SESSION_TOKEN}`,
    });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/markdown');
    const contentDisp = res.headers['content-disposition'];
    expect(contentDisp).toBeDefined();
    expect(contentDisp).toContain('attachment');
    expect(contentDisp).toContain('tradeos-session-audit-');
    expect(contentDisp).toContain('.md');

    expect(res.body).toBe(sampleMarkdown);
    expect(mockAuditService.formatMarkdownReport).toHaveBeenCalled();
  });

  it('4. 503 Service Unavailable when decisionAuditService is not configured', async () => {
    const appWithoutService = polka();
    const db = initializeDatabase(':memory:');
    registerRoutes(appWithoutService, {
      db,
      broker: { mode: 'BINANCE_DEMO' } as any,
      tradeManager: { getMarkPrice: () => 100 } as any,
    } as any);

    const srv = http.createServer(appWithoutService.handler);
    await new Promise<void>((resolve) => srv.listen(0, '127.0.0.1', resolve));
    const p = (srv.address() as any).port;

    const res = await makeRequest(p, '/api/audit/daily', {
      authorization: `Bearer ${SESSION_TOKEN}`,
    });
    expect(res.status).toBe(503);
    const body = JSON.parse(res.body);
    expect(body.error).toContain('DecisionAuditService not initialized');

    srv.close();
  });
});
