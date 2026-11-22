/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { apiClient, getPillarScorecard } from '../apiClient';
import type { PillarAttributionResponse } from '@tradeos/shared';

describe('apiClient.getPillarScorecard', () => {
  beforeEach(() => {
    sessionStorage.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('constructs correct default URL and Authorization header', async () => {
    sessionStorage.setItem('tradeos_session_token', 'test-token-bulldog');

    const mockResponse: PillarAttributionResponse = {
      symbol: 'SOLUSDT',
      horizon: '15m',
      sampleSize: 42,
      generatedAt: 1700000000000,
      scorecards: [
        {
          pillarId: 'MOMENTUM_RVOL',
          title: 'Momentum & rVol',
          currentWeightPct: 5.0,
          recommendedWeightPct: 8.5,
          weightDeltaPct: 3.5,
          totalActiveVotes: 35,
          truePositives: 26,
          falsePositives: 9,
          falseNegatives: 4,
          hitRatePct: 74.3,
          avgMfePct: 1.85,
          avgMaePct: 0.45,
        },
      ],
    };

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      status: 200,
      statusText: 'OK',
      headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => mockResponse,
    } as unknown as Response);

    const result = await apiClient.getPillarScorecard('SOLUSDT', '15m');

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe('/api/audit/pillars?symbol=SOLUSDT&horizon=15m');
    expect(init?.headers).toEqual(
      new Headers({
        Authorization: 'Bearer test-token-bulldog',
      })
    );

    expect(result).toEqual(mockResponse);
    expect(result.scorecards[0].pillarId).toBe('MOMENTUM_RVOL');
    expect(result.scorecards[0].hitRatePct).toBe(74.3);
  });

  it('handles custom symbol and horizon with standalone getPillarScorecard', async () => {
    sessionStorage.setItem('tradeos_session_token', 'test-token-eth');

    const mockResponse: PillarAttributionResponse = {
      symbol: 'ETHUSDT',
      horizon: '60m',
      sampleSize: 18,
      generatedAt: 1700000000000,
      scorecards: [],
    };

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      status: 200,
      statusText: 'OK',
      headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => mockResponse,
    } as unknown as Response);

    const result = await getPillarScorecard('ETHUSDT', '60m');

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url] = fetchSpy.mock.calls[0];
    expect(url).toBe('/api/audit/pillars?symbol=ETHUSDT&horizon=60m');
    expect(result.symbol).toBe('ETHUSDT');
    expect(result.horizon).toBe('60m');
  });

  it('throws on API error', async () => {
    sessionStorage.setItem('tradeos_session_token', 'test-token');

    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: false,
      status: 500,
      statusText: 'Internal Server Error',
      json: async () => ({ error: 'Database query failed' }),
    } as unknown as Response);

    await expect(apiClient.getPillarScorecard('SOLUSDT', '15m')).rejects.toThrow('Database query failed');
  });
});
