import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import polka from 'polka';
import http from 'node:http';
import WebSocket from 'ws';
import {
  initializeDatabase,
  DecisionLogsRepo,
  FactorTelemetryRecordsRepo,
  ExecutionChaseLogsRepo,
} from '../../db/sqlite.js';
import { DecisionAuditService, estimateTokenCount } from '../../services/decisionAuditService.js';
import { registerRoutes } from '../routes.js';
import { WsHub } from '../wsHub.js';
import { SESSION_TOKEN, PORT } from '../../config.js';
import type {
  DailyAuditResponse,
  DailyAuditSummary,
  FactorTelemetryEvent,
} from '@tradeos/shared';

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

  it('5. forwards clamped limit and offset query parameters to generateSessionSummary on format=json', async () => {
    mockAuditService.generateSessionSummary.mockClear();
    const res = await makeRequest(port, '/api/audit/daily?format=json&limit=2&offset=1', {
      authorization: `Bearer ${SESSION_TOKEN}`,
    });
    expect(res.status).toBe(200);
    expect(mockAuditService.generateSessionSummary).toHaveBeenCalledTimes(1);
    const [sinceArg, optsArg] = mockAuditService.generateSessionSummary.mock.calls[0]!;
    expect(typeof sinceArg).toBe('number');
    expect(optsArg).toEqual({ limit: 2, offset: 1 });

    // Clamps out-of-range pagination bounds
    mockAuditService.generateSessionSummary.mockClear();
    const resClamped = await makeRequest(port, '/api/audit/daily?session=all&format=json&limit=999&offset=-5', {
      authorization: `Bearer ${SESSION_TOKEN}`,
    });
    expect(resClamped.status).toBe(200);
    expect(mockAuditService.generateSessionSummary).toHaveBeenCalledWith(undefined, {
      limit: 200,
      offset: 0,
    });
  });

  it('6. returns < 4000-token Markdown report when backed by real DecisionAuditService', async () => {
    const realDb = initializeDatabase(':memory:');
    const logsRepo = new DecisionLogsRepo(realDb);
    const factorRecordsRepo = new FactorTelemetryRecordsRepo(realDb);
    const chaseRepo = new ExecutionChaseLogsRepo(realDb);
    const realAuditService = new DecisionAuditService(logsRepo, undefined, {
      factorTelemetryRecordsRepo: factorRecordsRepo,
      executionChaseLogsRepo: chaseRepo,
      flushIntervalMs: 0,
    });

    for (let i = 0; i < 60; i++) {
      realAuditService.recordExecution({
        symbol: 'SOLUSDT',
        side: i % 2 === 0 ? 'BUY' : 'SELL',
        action: i % 5 === 0 ? 'FAILED' : 'EXECUTED',
        price: 145 + i * 0.1,
        marginUsd: 250,
        leverage: 10,
        atr: 1.5,
        errorMessage: i % 5 === 0 ? 'X'.repeat(400) : undefined,
        compositeScore: 82,
        executionChaseJson: JSON.stringify({
          status: i % 5 === 0 ? 'ABORTED' : 'FILLED',
          anchorMarkPrice: 145,
          currentLimitPrice: 145.02,
          spreadPennyJumps: 2,
          amendmentCount: 3,
          durationMs: 420,
          realizedFeeUsd: 0.5,
          feeSavedVsTakerUsd: 0.75,
        }),
      });
    }

    const appReal = polka();
    registerRoutes(appReal, {
      db: realDb,
      broker: { mode: 'BINANCE_DEMO' } as any,
      tradeManager: { getMarkPrice: () => 145 } as any,
      decisionAuditService: realAuditService,
    } as any);

    const srv = http.createServer(appReal.handler);
    await new Promise<void>((resolve) => srv.listen(0, '127.0.0.1', resolve));
    const p = (srv.address() as any).port;

    try {
      const res = await makeRequest(p, '/api/audit/daily?session=all&format=markdown', {
        authorization: `Bearer ${SESSION_TOKEN}`,
      });
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toContain('text/markdown');
      expect(res.body.length).toBeLessThanOrEqual(14_000);
      expect(estimateTokenCount(res.body)).toBeLessThan(4000);
      expect(res.body).not.toMatch(/\bP[1-7]:/);
    } finally {
      realAuditService.dispose();
      await new Promise<void>((resolve) => srv.close(() => resolve()));
      realDb.close();
    }
  });

  it('7. WsHub.broadcastFactorTelemetry enforces <= 4096 byte JSON payload cap on oversized events', async () => {
    const wsServer = http.createServer((_req, res) => {
      res.statusCode = 200;
      res.end('OK');
    });
    const wsHub = new WsHub({
      server: wsServer,
      path: '/ws',
      sessionToken: SESSION_TOKEN,
    });

    await new Promise<void>((resolve) => wsServer.listen(0, '127.0.0.1', resolve));
    const wsPort = (wsServer.address() as any).port;
    const ws = new WebSocket(`ws://127.0.0.1:${wsPort}/ws`, ['tradeos-auth', SESSION_TOKEN]);

    try {
      await new Promise<void>((resolve, reject) => {
        ws.on('open', resolve);
        ws.on('error', reject);
      });

      const receivedPayloads: string[] = [];
      ws.on('message', (raw) => {
        receivedPayloads.push(raw.toString());
      });

      const oversizedEvent: FactorTelemetryEvent = {
        timestamp: Date.now(),
        symbol: 'SOLUSDT',
        triggerType: 'SIGNAL_CONFIRMED',
        markPrice: 145.5,
        compositeScore: 88,
        convictionArchetype: 'HIGH_CONVICTION_CORE',
        consensusSide: 'BUY',
        noiseBandActive: false,
        macroVetoActive: true,
        macroVetoReason: 'VETO_REASON_' + 'R'.repeat(1500),
        activeFactors: Array.from({ length: 12 }, (_, idx) => ({
          factorId: `FACTOR_${idx}`,
          name: `Factor ${idx}`,
          bias: 'BULLISH' as const,
          rawAlpha: 0.8,
          orthogonalAlpha: 0.75,
          effectiveWeight: 0.1,
          isCollinear: false,
          confidence: 0.9,
          summaryText: `Verbose explanation ${idx}: ` + 'A'.repeat(1200),
        })),
        collinearFactors: Array.from({ length: 80 }, (_, idx) => `Collinear_Factor_Long_Name_${idx}`),
      };

      wsHub.broadcastFactorTelemetry(oversizedEvent);
      await new Promise((r) => setTimeout(r, 50));

      const factorMsgs = receivedPayloads.filter((p) => {
        try {
          return JSON.parse(p).type === 'FACTOR_TELEMETRY';
        } catch {
          return false;
        }
      });
      expect(factorMsgs.length).toBe(1);
      const rawMsg = factorMsgs[0]!;
      expect(Buffer.byteLength(rawMsg, 'utf8')).toBeLessThanOrEqual(4096);
      const parsed = JSON.parse(rawMsg);
      expect(parsed.data.symbol).toBe('SOLUSDT');
      expect(parsed.data.triggerType).toBe('SIGNAL_CONFIRMED');
    } finally {
      ws.terminate();
      await wsHub.close();
      await new Promise<void>((resolve) => wsServer.close(() => resolve()));
    }
  });
});
