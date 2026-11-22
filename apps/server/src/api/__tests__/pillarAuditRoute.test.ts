import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import polka from 'polka';
import http from 'node:http';
import { initializeDatabase } from '../../db/sqlite.js';
import { registerRoutes } from '../routes.js';
import { SESSION_TOKEN, PORT } from '../../config.js';
import type { PillarAttributionResponse, PillarScorecardItem } from '@tradeos/shared';

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

describe('GET /api/audit/pillars REST Route', () => {
  let server: http.Server;
  let port: number;
  let mockPillarService: {
    generateScorecard: ReturnType<typeof vi.fn>;
  };

  const sampleScorecards: PillarScorecardItem[] = [
    {
      pillarId: 'MACRO_REGIME',
      title: 'Macro Regime (1h/4h EMA & ADX)',
      currentWeightPct: 25,
      recommendedWeightPct: 25,
      weightDeltaPct: 0,
      totalActiveVotes: 12,
      truePositives: 8,
      falsePositives: 4,
      falseNegatives: 2,
      hitRatePct: 66.7,
      avgMfePct: 1.45,
      avgMaePct: 0.62,
    },
    {
      pillarId: 'NATIVE_SMC',
      title: 'Native SMC (15m Order Blocks & FVG)',
      currentWeightPct: 25,
      recommendedWeightPct: 25,
      weightDeltaPct: 0,
      totalActiveVotes: 10,
      truePositives: 6,
      falsePositives: 4,
      falseNegatives: 1,
      hitRatePct: 60,
      avgMfePct: 1.2,
      avgMaePct: 0.8,
    },
    {
      pillarId: 'CVD_ABSORPTION',
      title: 'CVD Absorption & Divergence',
      currentWeightPct: 20,
      recommendedWeightPct: 20,
      weightDeltaPct: 0,
      totalActiveVotes: 15,
      truePositives: 11,
      falsePositives: 4,
      falseNegatives: 0,
      hitRatePct: 73.3,
      avgMfePct: 1.8,
      avgMaePct: 0.5,
    },
    {
      pillarId: 'ORDER_FLOW_L2',
      title: 'Order Flow L2 Depth Imbalance',
      currentWeightPct: 15,
      recommendedWeightPct: 15,
      weightDeltaPct: 0,
      totalActiveVotes: 20,
      truePositives: 13,
      falsePositives: 7,
      falseNegatives: 3,
      hitRatePct: 65,
      avgMfePct: 1.1,
      avgMaePct: 0.7,
    },
    {
      pillarId: 'LIQ_CLUSTERS',
      title: 'Liquidity Clusters & Heatmap',
      currentWeightPct: 7.5,
      recommendedWeightPct: 7.5,
      weightDeltaPct: 0,
      totalActiveVotes: 5,
      truePositives: 3,
      falsePositives: 2,
      falseNegatives: 1,
      hitRatePct: 60,
      avgMfePct: 0.9,
      avgMaePct: 0.6,
    },
    {
      pillarId: 'MOMENTUM_RVOL',
      title: 'Momentum & rVol',
      currentWeightPct: 5,
      recommendedWeightPct: 5,
      weightDeltaPct: 0,
      totalActiveVotes: 25,
      truePositives: 18,
      falsePositives: 7,
      falseNegatives: 2,
      hitRatePct: 72,
      avgMfePct: 1.5,
      avgMaePct: 0.7,
    },
    {
      pillarId: 'SENTIMENT_MACRO',
      title: 'Macro Sentiment (CryptoPanic)',
      currentWeightPct: 2.5,
      recommendedWeightPct: 2.5,
      weightDeltaPct: 0,
      totalActiveVotes: 8,
      truePositives: 5,
      falsePositives: 3,
      falseNegatives: 0,
      hitRatePct: 62.5,
      avgMfePct: 1.3,
      avgMaePct: 0.9,
    },
  ];

  const sampleResponse: PillarAttributionResponse = {
    symbol: 'SOLUSDT',
    horizon: '15m',
    sampleSize: 30,
    generatedAt: 1700000000000,
    scorecards: sampleScorecards,
  };

  beforeAll(async () => {
    const db = initializeDatabase(':memory:');
    mockPillarService = {
      generateScorecard: vi.fn().mockImplementation((symbol: string, horizon: string) => ({
        ...sampleResponse,
        symbol,
        horizon,
      })),
    };

    const app = polka();
    registerRoutes(app, {
      db,
      broker: { mode: 'BINANCE_DEMO' } as any,
      tradeManager: { getMarkPrice: () => 100 } as any,
      pillarAttributionService: mockPillarService as any,
      activeSymbol: 'SOLUSDT',
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
    const resNoAuth = await makeRequest(port, '/api/audit/pillars');
    expect(resNoAuth.status).toBe(401);
    const bodyNoAuth = JSON.parse(resNoAuth.body);
    expect(bodyNoAuth.error).toContain('Unauthorized');

    // Invalid Bearer token
    const resBadAuth = await makeRequest(port, '/api/audit/pillars', {
      authorization: 'Bearer bad-token-xyz',
    });
    expect(resBadAuth.status).toBe(401);
    const bodyBadAuth = JSON.parse(resBadAuth.body);
    expect(bodyBadAuth.error).toContain('Unauthorized');
  });

  it('2. 200 OK with default query parameters (symbol=SOLUSDT, horizon=15m)', async () => {
    const res = await makeRequest(port, '/api/audit/pillars', {
      authorization: `Bearer ${SESSION_TOKEN}`,
    });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('application/json');

    const data: PillarAttributionResponse = JSON.parse(res.body);
    expect(data.symbol).toBe('SOLUSDT');
    expect(data.horizon).toBe('15m');
    expect(data.scorecards).toHaveLength(7);
    expect(mockPillarService.generateScorecard).toHaveBeenCalledWith('SOLUSDT', '15m');
  });

  it('3. 200 OK with custom symbol and horizon query parameters', async () => {
    mockPillarService.generateScorecard.mockClear();
    const res = await makeRequest(port, '/api/audit/pillars?symbol=BTCUSDT&horizon=5m', {
      authorization: `Bearer ${SESSION_TOKEN}`,
    });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('application/json');

    const data: PillarAttributionResponse = JSON.parse(res.body);
    expect(data.symbol).toBe('BTCUSDT');
    expect(data.horizon).toBe('5m');
    expect(mockPillarService.generateScorecard).toHaveBeenCalledWith('BTCUSDT', '5m');
  });

  it('4. 400 Bad Request on invalid horizon query parameter', async () => {
    const res = await makeRequest(port, '/api/audit/pillars?horizon=invalid_hz', {
      authorization: `Bearer ${SESSION_TOKEN}`,
    });
    expect(res.status).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.error).toContain("Invalid horizon 'invalid_hz'");
    expect(body.error).toContain('1m, 5m, 15m, 60m');
  });

  it('5. 503 Service Unavailable when pillarAttributionService is not initialized', async () => {
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

    const res = await makeRequest(p, '/api/audit/pillars', {
      authorization: `Bearer ${SESSION_TOKEN}`,
    });
    expect(res.status).toBe(503);
    const body = JSON.parse(res.body);
    expect(body.error).toContain('PillarAttributionService not initialized');

    srv.close();
  });
});
