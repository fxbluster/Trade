import { describe, it, expect, vi } from 'vitest';
import { BinanceClient } from '../binanceClient.js';

describe('BinanceClient.getKlines range support', () => {
  it('calls request with default interval and limit when range is not provided', async () => {
    const client = new BinanceClient({ apiKey: 'k', apiSecret: 's' });
    const spy = vi.spyOn(client as any, 'request').mockResolvedValue([]);

    await client.getKlines('SOLUSDT');

    expect(spy).toHaveBeenCalledWith('/fapi/v1/klines', {
      method: 'GET',
      isPublicData: true,
      priority: 'P2',
      params: {
        symbol: 'SOLUSDT',
        interval: '1m',
        limit: 400,
      },
    });
  });

  it('forwards startTime and endTime when provided', async () => {
    const client = new BinanceClient({ apiKey: 'k', apiSecret: 's' });
    const spy = vi.spyOn(client as any, 'request').mockResolvedValue([]);

    await client.getKlines('solusdt', '5m', 50, 1700000000000, 1700003600000);

    expect(spy).toHaveBeenCalledWith('/fapi/v1/klines', {
      method: 'GET',
      isPublicData: true,
      priority: 'P2',
      params: {
        symbol: 'SOLUSDT',
        interval: '5m',
        limit: 50,
        startTime: 1700000000000,
        endTime: 1700003600000,
      },
    });
  });

  it('forwards only startTime when endTime is omitted', async () => {
    const client = new BinanceClient({ apiKey: 'k', apiSecret: 's' });
    const spy = vi.spyOn(client as any, 'request').mockResolvedValue([]);

    await client.getKlines('BTCUSDT', '15m', 100, 1700000000000);

    expect(spy).toHaveBeenCalledWith('/fapi/v1/klines', {
      method: 'GET',
      isPublicData: true,
      priority: 'P2',
      params: {
        symbol: 'BTCUSDT',
        interval: '15m',
        limit: 100,
        startTime: 1700000000000,
      },
    });
  });

  it('forwards only endTime when startTime is undefined', async () => {
    const client = new BinanceClient({ apiKey: 'k', apiSecret: 's' });
    const spy = vi.spyOn(client as any, 'request').mockResolvedValue([]);

    await client.getKlines('ETHUSDT', '1h', 200, undefined, 1700005000000);

    expect(spy).toHaveBeenCalledWith('/fapi/v1/klines', {
      method: 'GET',
      isPublicData: true,
      priority: 'P2',
      params: {
        symbol: 'ETHUSDT',
        interval: '1h',
        limit: 200,
        endTime: 1700005000000,
      },
    });
  });
});
