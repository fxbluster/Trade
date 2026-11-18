import type { ScannerItem } from '@tradeos/shared';

const BINANCE_FAPI_BASE = 'https://fapi.binance.com';
const CACHE_TTL_MS = 30_000; // 30s in-memory TTL cache
const DEFAULT_TIMEOUT_MS = 5_000;

interface Binance24hrTicker {
  symbol: string;
  lastPrice: string;
  priceChangePercent: string;
  quoteVolume: string;
  [key: string]: unknown;
}

interface BinancePremiumIndex {
  symbol: string;
  lastFundingRate?: string;
  fundingRate?: string;
  markPrice?: string;
  [key: string]: unknown;
}

export interface ScanMarketOptions {
  limit?: number;
  forceRefresh?: boolean;
  baseUrl?: string;
  timeoutMs?: number;
}

let cachedScannerItems: ScannerItem[] = [];
let lastFetchTimestamp: number = 0;

/**
 * Scans top USDT-M Binance Futures pairs.
 * Fetches /fapi/v1/ticker/24hr and /fapi/v1/premiumIndex in parallel.
 * Results are sorted by 24h quoteVolume descending and cached for 30s.
 */
export async function scanMarket(options: ScanMarketOptions = {}): Promise<ScannerItem[]> {
  const {
    limit,
    forceRefresh = false,
    baseUrl = BINANCE_FAPI_BASE,
    timeoutMs = DEFAULT_TIMEOUT_MS
  } = options;

  const now = Date.now();
  if (!forceRefresh && cachedScannerItems.length > 0 && now - lastFetchTimestamp < CACHE_TTL_MS) {
    return typeof limit === 'number' && limit > 0
      ? cachedScannerItems.slice(0, limit)
      : cachedScannerItems;
  }

  try {
    const [tickerRes, premiumRes] = await Promise.all([
      fetch(`${baseUrl}/fapi/v1/ticker/24hr`, {
        headers: { 'Accept': 'application/json' },
        signal: AbortSignal.timeout(timeoutMs)
      }),
      fetch(`${baseUrl}/fapi/v1/premiumIndex`, {
        headers: { 'Accept': 'application/json' },
        signal: AbortSignal.timeout(timeoutMs)
      })
    ]);

    if (!tickerRes.ok || !premiumRes.ok) {
      if (cachedScannerItems.length > 0) {
        return typeof limit === 'number' && limit > 0
          ? cachedScannerItems.slice(0, limit)
          : cachedScannerItems;
      }
      return [];
    }

    const tickers = (await tickerRes.json()) as Binance24hrTicker[];
    const premiums = (await premiumRes.json()) as BinancePremiumIndex[];

    if (!Array.isArray(tickers)) {
      return cachedScannerItems;
    }

    // Build funding rate lookup map
    const fundingMap = new Map<string, number>();
    if (Array.isArray(premiums)) {
      for (const p of premiums) {
        if (p && p.symbol) {
          const rawRate = p.lastFundingRate !== undefined ? p.lastFundingRate : p.fundingRate;
          const rate = typeof rawRate === 'number' ? rawRate : parseFloat(String(rawRate || 0));
          fundingMap.set(p.symbol, isNaN(rate) ? 0 : rate);
        }
      }
    }

    // Filter USDT-M perpetual contracts only (exclude quarterly delivery symbols containing '_')
    const usdtTickers = tickers.filter(
      t => t && typeof t.symbol === 'string' && t.symbol.endsWith('USDT') && !t.symbol.includes('_')
    );

    const items: ScannerItem[] = usdtTickers.map(t => {
      const lastPrice = parseFloat(t.lastPrice) || 0;
      const priceChangePercent24h = parseFloat(t.priceChangePercent) || 0;
      const quoteVolume24h = parseFloat(t.quoteVolume) || 0;
      const fundingRate = fundingMap.get(t.symbol) ?? 0;

      return {
        symbol: t.symbol,
        lastPrice: Number(lastPrice.toFixed(4)),
        priceChangePercent24h: Number(priceChangePercent24h.toFixed(2)),
        quoteVolume24h: Number(quoteVolume24h.toFixed(2)),
        fundingRate: Number(fundingRate.toFixed(6))
      };
    });

    // Sort descending by 24h quoteVolume
    items.sort((a, b) => b.quoteVolume24h - a.quoteVolume24h);

    cachedScannerItems = items;
    lastFetchTimestamp = now;

    return typeof limit === 'number' && limit > 0
      ? items.slice(0, limit)
      : items;
  } catch (error) {
    // If request fails (offline, rate limit, timeout) and cache exists, return stale cache
    if (cachedScannerItems.length > 0) {
      return typeof limit === 'number' && limit > 0
        ? cachedScannerItems.slice(0, limit)
        : cachedScannerItems;
    }
    return [];
  }
}

/**
 * Clears the in-memory scanner cache (useful for testing).
 */
export function clearScannerCache(): void {
  cachedScannerItems = [];
  lastFetchTimestamp = 0;
}

/**
 * Returns the timestamp of the last cache refresh.
 */
export function getScannerCacheTimestamp(): number {
  return lastFetchTimestamp;
}
