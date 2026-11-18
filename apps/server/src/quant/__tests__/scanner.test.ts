import { describe, it, expect, beforeEach, vi } from 'vitest';
import { scanMarket, clearScannerCache, getScannerCacheTimestamp } from '../scanner.js';

describe('scanMarket', () => {
  const mockTickers = [
    { symbol: 'ETHUSDT', lastPrice: '3100.50', priceChangePercent: '1.25', quoteVolume: '500000000' },
    { symbol: 'BTCUSDT', lastPrice: '91500.00', priceChangePercent: '3.40', quoteVolume: '1500000000' },
    { symbol: 'SOLUSDT', lastPrice: '145.20', priceChangePercent: '-0.85', quoteVolume: '800000000' },
    { symbol: 'BTCUSDT_241227', lastPrice: '92000.00', priceChangePercent: '2.00', quoteVolume: '900000000' }, // quarterly - should be excluded
    { symbol: 'BTCBUSD', lastPrice: '91500.00', priceChangePercent: '3.40', quoteVolume: '200000000' } // non-USDT - should be excluded
  ];

  const mockPremiums = [
    { symbol: 'BTCUSDT', lastFundingRate: '0.000100' },
    { symbol: 'ETHUSDT', lastFundingRate: '0.000150' },
    { symbol: 'SOLUSDT', lastFundingRate: '-0.000050' }
  ];

  beforeEach(() => {
    clearScannerCache();
    vi.restoreAllMocks();
  });

  it('fetches, filters USDT contracts, merges funding rates, and sorts by quoteVolume descending', async () => {
    globalThis.fetch = vi.fn().mockImplementation((url: string) => {
      if (url.includes('/fapi/v1/ticker/24hr')) {
        return Promise.resolve(new Response(JSON.stringify(mockTickers), { status: 200 }));
      }
      if (url.includes('/fapi/v1/premiumIndex')) {
        return Promise.resolve(new Response(JSON.stringify(mockPremiums), { status: 200 }));
      }
      return Promise.reject(new Error('Unknown URL'));
    });

    const items = await scanMarket({ limit: 10 });

    expect(items.length).toBe(3); // BTCUSDT, SOLUSDT, ETHUSDT (quarterly and BUSD excluded)

    // Sorted by volume: BTC (1.5B) -> SOL (800M) -> ETH (500M)
    expect(items[0].symbol).toBe('BTCUSDT');
    expect(items[0].quoteVolume24h).toBe(1500000000);
    expect(items[0].fundingRate).toBe(0.0001);

    expect(items[1].symbol).toBe('SOLUSDT');
    expect(items[1].quoteVolume24h).toBe(800000000);
    expect(items[1].fundingRate).toBe(-0.00005);

    expect(items[2].symbol).toBe('ETHUSDT');
    expect(items[2].quoteVolume24h).toBe(500000000);
    expect(items[2].fundingRate).toBe(0.00015);
  });

  it('respects limit parameter', async () => {
    globalThis.fetch = vi.fn().mockImplementation((url: string) => {
      if (url.includes('/fapi/v1/ticker/24hr')) {
        return Promise.resolve(new Response(JSON.stringify(mockTickers), { status: 200 }));
      }
      return Promise.resolve(new Response(JSON.stringify(mockPremiums), { status: 200 }));
    });

    const items = await scanMarket({ limit: 2 });
    expect(items.length).toBe(2);
    expect(items[0].symbol).toBe('BTCUSDT');
    expect(items[1].symbol).toBe('SOLUSDT');
  });

  it('caches results for 30 seconds and does not re-fetch', async () => {
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url.includes('/fapi/v1/ticker/24hr')) {
        return Promise.resolve(new Response(JSON.stringify(mockTickers), { status: 200 }));
      }
      return Promise.resolve(new Response(JSON.stringify(mockPremiums), { status: 200 }));
    });
    globalThis.fetch = fetchMock;

    const first = await scanMarket();
    expect(fetchMock).toHaveBeenCalledTimes(2); // 1 for tickers, 1 for premiums

    // Second call within 30s TTL
    const second = await scanMarket();
    expect(fetchMock).toHaveBeenCalledTimes(2); // Still 2, served from cache!
    expect(second).toEqual(first);
    expect(getScannerCacheTimestamp()).toBeGreaterThan(0);
  });

  it('forceRefresh bypasses the in-memory cache', async () => {
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url.includes('/fapi/v1/ticker/24hr')) {
        return Promise.resolve(new Response(JSON.stringify(mockTickers), { status: 200 }));
      }
      return Promise.resolve(new Response(JSON.stringify(mockPremiums), { status: 200 }));
    });
    globalThis.fetch = fetchMock;

    await scanMarket();
    expect(fetchMock).toHaveBeenCalledTimes(2);

    await scanMarket({ forceRefresh: true });
    expect(fetchMock).toHaveBeenCalledTimes(4); // Re-fetched
  });

  it('falls back to stale cache or empty array when fetch fails', async () => {
    // Prime cache first
    globalThis.fetch = vi.fn().mockImplementation((url: string) => {
      if (url.includes('/fapi/v1/ticker/24hr')) {
        return Promise.resolve(new Response(JSON.stringify(mockTickers), { status: 200 }));
      }
      return Promise.resolve(new Response(JSON.stringify(mockPremiums), { status: 200 }));
    });
    await scanMarket();

    // Now make fetch fail
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('Network offline'));

    const staleResult = await scanMarket({ forceRefresh: true });
    expect(staleResult.length).toBe(3); // Returned stale cache
  });
});
