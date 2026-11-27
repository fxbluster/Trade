import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PnlService } from '../pnlService.js';
import { ExchangeBannedError, ExchangeDegradedError } from '../../exchange/binanceClient.js';

function createMocks(options?: {
  requestImpl?: (...args: any[]) => Promise<any>;
  usedWeight1m?: number;
  isBanned?: boolean;
  remainingBanSec?: number;
}) {
  const dbRow = {
    total: 2,
    wins: 1,
    losses: 1,
    total_pnl: 12.5,
    total_fees: 1.5,
  };

  const mockDb = {
    prepare: vi.fn((sql: string) => {
      if (sql.includes('session_started_at')) {
        return { get: vi.fn(() => undefined) };
      }
      return { get: vi.fn(() => dbRow) };
    }),
  } as any;

  const mockTradesRepo = {
    getActivePosition: vi.fn(() => undefined),
  } as any;

  const requestMock = vi.fn(
    options?.requestImpl ??
      (async () => [
        { incomeType: 'REALIZED_PNL', income: '25.50', time: Date.now() },
        { incomeType: 'COMMISSION', income: '-1.25', time: Date.now() },
        { incomeType: 'FUNDING_FEE', income: '0.25', time: Date.now() },
      ])
  );

  let usedWeight = options?.usedWeight1m ?? 50;
  let banned = options?.isBanned ?? false;
  let remainingBan = options?.remainingBanSec ?? 0;

  const mockClient = {
    request: requestMock,
    isBanned: vi.fn(() => banned),
    getRemainingBanSeconds: vi.fn(() => remainingBan),
    getRateLimits: vi.fn(() => ({
      usedWeight1m: usedWeight,
      orderCount10s: 0,
      orderCount1m: 0,
    })),
    setUsedWeight: (w: number) => {
      usedWeight = w;
    },
    setBanned: (b: boolean, sec = 60) => {
      banned = b;
      remainingBan = sec;
    },
  } as any;

  const mockGetMarkPrice = vi.fn(() => 150);
  const mockGetActiveBroker = vi.fn(() => ({
    mode: 'BINANCE_DEMO' as const,
    getAccount: vi.fn(async () => ({
      equity: '5024.50',
      walletBalance: '5024.50',
      availableBalance: '5024.50',
      currency: 'USDT',
    })),
  }));

  const service = new PnlService(
    mockDb,
    mockTradesRepo,
    mockClient,
    mockGetMarkPrice,
    mockGetActiveBroker
  );

  return { service, mockClient, requestMock };
}

describe('PnlService', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-15T12:00:00Z'));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('caches /fapi/v1/income for 90s across UI polling intervals', async () => {
    const { service, requestMock } = createMocks();

    const first = await service.getPnlSummary('SOLUSDT');
    expect(first.today.realizedPnl).toBe(25.5);
    expect(first.today.netPnl).toBe(24.5);
    expect(requestMock).toHaveBeenCalledTimes(1);

    // Simulate 15s, 45s, and 89s UI polls — should hit cache
    vi.advanceTimersByTime(15_000);
    await service.getPnlSummary('SOLUSDT');
    vi.advanceTimersByTime(30_000);
    await service.getPnlSummary('SOLUSDT');
    vi.advanceTimersByTime(44_000);
    await service.getPnlSummary('SOLUSDT');
    expect(requestMock).toHaveBeenCalledTimes(1);

    // Advance past 90s TTL — should refresh
    vi.advanceTimersByTime(2_000);
    await service.getPnlSummary('SOLUSDT');
    expect(requestMock).toHaveBeenCalledTimes(2);
  });

  it('deduplicates concurrent in-flight /fapi/v1/income requests', async () => {
    let resolveRequest!: (val: any[]) => void;
    const pendingPromise = new Promise<any[]>((resolve) => {
      resolveRequest = resolve;
    });

    const { service, requestMock } = createMocks({
      requestImpl: () => pendingPromise,
    });

    const p1 = service.getPnlSummary('SOLUSDT');
    const p2 = service.getPnlSummary('BTCUSDT');
    const p3 = service.getPnlSummary('ETHUSDT');

    // Allow microtasks up to client.request to run
    await Promise.resolve();
    expect(requestMock).toHaveBeenCalledTimes(1);

    resolveRequest([
      { incomeType: 'REALIZED_PNL', income: '40.00', time: Date.now() },
      { incomeType: 'COMMISSION', income: '-2.00', time: Date.now() },
    ]);

    const [r1, r2, r3] = await Promise.all([p1, p2, p3]);
    expect(r1.today.realizedPnl).toBe(40);
    expect(r2.today.realizedPnl).toBe(40);
    expect(r3.today.realizedPnl).toBe(40);
    expect(requestMock).toHaveBeenCalledTimes(1);
  });

  it('backs off for 60s on ExchangeDegradedError and falls back to DB or stale cache', async () => {
    let shouldFail = true;
    const { service, requestMock } = createMocks({
      requestImpl: async () => {
        if (shouldFail) {
          throw new ExchangeDegradedError(
            'Rate limit weight threshold reached (1003/1200). Scanner (P2) throttled to preserve execution bandwidth.'
          );
        }
        return [{ incomeType: 'REALIZED_PNL', income: '18.00', time: Date.now() }];
      },
    });

    // First call hits ExchangeDegradedError -> falls back to SQLite DB (12.5 - 1.5 = 11.0)
    const fallbackRes = await service.getPnlSummary('SOLUSDT');
    expect(fallbackRes.today.realizedPnl).toBe(12.5);
    expect(fallbackRes.today.netPnl).toBe(11);
    expect(requestMock).toHaveBeenCalledTimes(1);

    // Subsequent polls within 60s backoff do not hit Binance API
    vi.advanceTimersByTime(10_000);
    await service.getPnlSummary('SOLUSDT');
    vi.advanceTimersByTime(40_000);
    await service.getPnlSummary('SOLUSDT');
    expect(requestMock).toHaveBeenCalledTimes(1);

    // After 60s backoff expires, next poll retries and succeeds
    shouldFail = false;
    vi.advanceTimersByTime(11_000);
    const recovered = await service.getPnlSummary('SOLUSDT');
    expect(requestMock).toHaveBeenCalledTimes(2);
    expect(recovered.today.realizedPnl).toBe(18);
  });

  it('skips Binance call and enters backoff when usedWeight1m >= 1000', async () => {
    const { service, mockClient, requestMock } = createMocks({
      usedWeight1m: 1003,
    });

    const res = await service.getPnlSummary('SOLUSDT');
    expect(requestMock).not.toHaveBeenCalled();
    expect(res.today.realizedPnl).toBe(12.5);

    // Even if weight drops during the 60s backoff, it waits out the backoff window
    mockClient.setUsedWeight(100);
    vi.advanceTimersByTime(30_000);
    await service.getPnlSummary('SOLUSDT');
    expect(requestMock).not.toHaveBeenCalled();

    // Once backoff expires, it calls Binance
    vi.advanceTimersByTime(31_000);
    const afterBackoff = await service.getPnlSummary('SOLUSDT');
    expect(requestMock).toHaveBeenCalledTimes(1);
    expect(afterBackoff.today.realizedPnl).toBe(25.5);
  });

  it('respects ExchangeBannedError retryAfterSec duration', async () => {
    let shouldBan = true;
    const { service, requestMock } = createMocks({
      requestImpl: async () => {
        if (shouldBan) {
          throw new ExchangeBannedError(90);
        }
        return [{ incomeType: 'REALIZED_PNL', income: '50.00', time: Date.now() }];
      },
    });

    await service.getPnlSummary('SOLUSDT');
    expect(requestMock).toHaveBeenCalledTimes(1);

    // At +65s (past default 60s, before 90s retryAfterSec), still backed off
    shouldBan = false;
    vi.advanceTimersByTime(65_000);
    await service.getPnlSummary('SOLUSDT');
    expect(requestMock).toHaveBeenCalledTimes(1);

    // At +91s, backoff has expired and request succeeds
    vi.advanceTimersByTime(26_000);
    const res = await service.getPnlSummary('SOLUSDT');
    expect(requestMock).toHaveBeenCalledTimes(2);
    expect(res.today.realizedPnl).toBe(50);
  });
});
