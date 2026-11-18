import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import {
  BinanceClient,
  ExchangeDegradedError,
  ExchangeBannedError,
  BinanceApiError,
} from '../binanceClient.js';
import { BinanceDemoAdapter } from '../binanceDemoAdapter.js';
import { LocalPaperAdapter } from '../localPaperAdapter.js';
import { BrokerFactory } from '../broker.js';
import { initializeDatabase, SettingsRepo } from '../../db/sqlite.js';

describe('BinanceClient & Broker Adapters Integration', () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    BrokerFactory.reset();
  });

  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  describe('1. BinanceClient HMAC Signing & Query Construction', () => {
    it('generates valid HMAC-SHA256 signature matching crypto digest', () => {
      const apiKey = 'test_api_key_123';
      const apiSecret = 'test_api_secret_456';
      const client = new BinanceClient({ apiKey, apiSecret });

      const qs = 'recvWindow=5000&symbol=SOLUSDT&timestamp=1700000000000';
      const expectedSig = crypto
        .createHmac('sha256', apiSecret)
        .update(qs)
        .digest('hex');

      const sig = client.createSignature(qs);
      expect(sig).toBe(expectedSig);
      expect(sig).toHaveLength(64); // SHA-256 hex length
    });

    it('builds deterministically sorted signed query string with timestamp & recvWindow', () => {
      const client = new BinanceClient({
        apiKey: 'key',
        apiSecret: 'secret',
        recvWindow: 5000,
      });

      const params = {
        symbol: 'BTCUSDT',
        side: 'BUY',
        timestamp: 1600000000000,
      };

      const signedQuery = client.buildSignedQuery(params);
      expect(signedQuery).toContain('recvWindow=5000');
      expect(signedQuery).toContain('side=BUY');
      expect(signedQuery).toContain('symbol=BTCUSDT');
      expect(signedQuery).toContain('timestamp=1600000000000');
      expect(signedQuery).toContain('&signature=');
    });
  });

  describe('2. Request Timeouts & Rate Limit Tracking', () => {
    it('enforces AbortSignal.timeout and throws ExchangeDegradedError on hang', async () => {
      const client = new BinanceClient({
        apiKey: 'key',
        apiSecret: 'secret',
        timeoutMs: 50, // 50ms fast timeout for testing
      });

      // Mock fetch that hangs longer than timeout
      global.fetch = vi.fn().mockImplementation((_url, options) => {
        return new Promise((_resolve, reject) => {
          if (options?.signal) {
            options.signal.addEventListener('abort', () => {
              const abortErr = new Error('The operation was aborted due to timeout');
              abortErr.name = 'TimeoutError';
              reject(abortErr);
            });
          }
        });
      });

      await expect(client.request('/fapi/v1/ping')).rejects.toThrow(ExchangeDegradedError);
      expect(client.getExchangeHealth()).toBe('DEGRADED');
    });

    it('tracks x-mbx rate limit headers from exchange responses', async () => {
      const client = new BinanceClient({ apiKey: 'key', apiSecret: 'secret' });

      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        headers: new Headers({
          'x-mbx-used-weight-1m': '340',
          'x-mbx-order-count-10s': '4',
          'x-mbx-order-count-1m': '18',
        }),
        json: async () => ({ ping: 'pong' }),
      });

      await client.request('/fapi/v1/ping');

      const limits = client.getRateLimits();
      expect(limits.usedWeight1m).toBe(340);
      expect(limits.orderCount10s).toBe(4);
      expect(limits.orderCount1m).toBe(18);
    });

    it('prioritizes P1 execution requests over P2 scanner requests when weight >= 1000', async () => {
      const client = new BinanceClient({ apiKey: 'key', apiSecret: 'secret' });
      client.usedWeight1m = 1050; // High rate limit load

      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        headers: new Headers({ 'x-mbx-used-weight-1m': '1050' }),
        json: async () => ({ ok: true }),
      });

      // P2 scanner request should be throttled
      await expect(
        client.request('/fapi/v1/ticker/24hr', { priority: 'P2', isPublicData: true })
      ).rejects.toThrow(ExchangeDegradedError);

      // P1 execution request must succeed
      const res = await client.request<{ ok: boolean }>('/fapi/v1/order', {
        priority: 'P1',
        method: 'POST',
      });
      expect(res.ok).toBe(true);
    });
  });

  describe('3. HTTP 418 IP Ban Circuit-Breaker', () => {
    it('parses Retry-After header, halts outbound REST, and sets status to BANNED', async () => {
      const client = new BinanceClient({ apiKey: 'key', apiSecret: 'secret' });

      const mockFetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 418,
        headers: new Headers({
          'retry-after': '60',
        }),
        text: async () => "IP banned until 1700000000000. It's a teapot.",
      });
      global.fetch = mockFetch;

      // First call triggers 418
      await expect(client.request('/fapi/v1/ping')).rejects.toThrow(ExchangeBannedError);

      expect(client.isBanned()).toBe(true);
      expect(client.getExchangeHealth()).toBe('BANNED');
      expect(client.getRemainingBanSeconds()).toBeGreaterThan(0);
      expect(mockFetch).toHaveBeenCalledTimes(1);

      // Subsequent calls MUST immediately halt without touching the network!
      await expect(client.request('/fapi/v1/ping')).rejects.toThrow(ExchangeBannedError);
      expect(mockFetch).toHaveBeenCalledTimes(1); // STILL 1 call! Never retried blindly!
    });
  });

  describe('4. Algo Order Routing (-4120 Handling)', () => {
    it('automatically re-routes STOP_ORDER_SWITCH_ALGO (-4120) to /fapi/v1/algoOrder', async () => {
      const client = new BinanceClient({ apiKey: 'key', apiSecret: 'secret' });

      const mockFetch = vi.fn().mockImplementation((url: string) => {
        if (url.includes('/fapi/v1/order')) {
          return Promise.resolve({
            ok: false,
            status: 400,
            headers: new Headers(),
            text: async () =>
              JSON.stringify({
                code: -4120,
                msg: 'Stop order should be placed by Algo Order API',
              }),
          });
        }
        if (url.includes('/fapi/v1/algoOrder')) {
          return Promise.resolve({
            ok: true,
            status: 200,
            headers: new Headers(),
            json: async () => ({
              algoId: 987654321,
              clientAlgoId: 'tos_t1_sl',
              code: '200',
              msg: 'success',
            }),
          });
        }
        return Promise.reject(new Error('Unknown url'));
      });
      global.fetch = mockFetch;

      const res = await client.createOrder({
        symbol: 'SOLUSDT',
        side: 'SELL',
        type: 'STOP_MARKET',
        quantity: 10,
        stopPrice: 180.5,
        newClientOrderId: 'tos_t1_sl',
      });

      expect(res.algoId).toBe('987654321');
      expect(res.clientAlgoId).toBe('tos_t1_sl');
      expect(mockFetch).toHaveBeenCalledTimes(2); // Initial /order followed by /algoOrder
    });
  });

  describe('5. BinanceDemoAdapter Fail-Closed Account & Formatting', () => {
    it('throws ExchangeDegradedError on API failure and NEVER returns fake $1000', async () => {
      const client = new BinanceClient({ apiKey: 'key', apiSecret: 'secret' });
      const adapter = new BinanceDemoAdapter({ client });

      global.fetch = vi.fn().mockRejectedValue(new Error('Network connection reset'));

      await expect(adapter.getAccount()).rejects.toThrow(ExchangeDegradedError);
    });

    it('formats and parses deterministic client order IDs', () => {
      const tradeId = 'b0b1a2-34c5-67d8';
      const entId = BinanceDemoAdapter.formatClientId(tradeId, 'ent');
      const slId = BinanceDemoAdapter.formatClientId(tradeId, 'sl');
      const tp1Id = BinanceDemoAdapter.formatClientId(tradeId, 'tp1');
      const tp2Id = BinanceDemoAdapter.formatClientId(tradeId, 'tp2');

      expect(entId).toBe(`tos_${tradeId}_ent`);
      expect(slId).toBe(`tos_${tradeId}_sl`);
      expect(tp1Id).toBe(`tos_${tradeId}_tp1`);
      expect(tp2Id).toBe(`tos_${tradeId}_tp2`);

      const parsed = BinanceDemoAdapter.parseClientId(slId);
      expect(parsed).toEqual({ tradeId, role: 'sl' });
    });

    it('enforces reduceOnly: true on SL/TP algo orders and MARKET close', async () => {
      const client = new BinanceClient({ apiKey: 'key', apiSecret: 'secret' });
      const adapter = new BinanceDemoAdapter({ client });

      const capturedUrls: string[] = [];
      const capturedBodies: string[] = [];

      global.fetch = vi.fn().mockImplementation((url: string, opts: any) => {
        capturedUrls.push(url);
        capturedBodies.push(opts?.body || '');

        if (url.includes('/fapi/v2/positionRisk')) {
          return Promise.resolve({
            ok: true,
            status: 200,
            headers: new Headers(),
            json: async () => [
              {
                symbol: 'SOLUSDT',
                positionAmt: '15.5', // Active LONG
                entryPrice: '200.0',
                markPrice: '205.0',
                unRealizedProfit: '77.5',
                liquidationPrice: '160.0',
                leverage: '5',
              },
            ],
          });
        }

        return Promise.resolve({
          ok: true,
          status: 200,
          headers: new Headers(),
          json: async () => ({
            orderId: 112233,
            status: 'FILLED',
            algoId: 445566,
          }),
        });
      });

      // 1. Algo order
      const algoRes = await adapter.createAlgoOrder({
        symbol: 'SOLUSDT',
        side: 'SELL',
        type: 'STOP_MARKET',
        triggerPrice: 195.0,
        reduceOnly: true,
      });
      expect(algoRes.algoId).toBe('445566');
      expect(capturedBodies[0]).toContain('reduceOnly=true');

      // 2. Position close
      const closeRes = await adapter.closePosition('SOLUSDT');
      expect(closeRes.status).toBe('FILLED');
      const closeBody = capturedBodies[capturedBodies.length - 1];
      expect(closeBody).toContain('reduceOnly=true');
      expect(closeBody).toContain('side=SELL'); // Opposite of LONG position
    });
  });

  describe('6. LocalPaperAdapter Persistence, Slippage & Ticks', () => {
    let db: DatabaseSync;

    beforeEach(() => {
      db = initializeDatabase(':memory:');
    });

    it('initializes and persists paper balance in SQLite settings table', async () => {
      const adapter = new LocalPaperAdapter({ db, initialBalance: 10000.0 });
      const acc = await adapter.getAccount();
      expect(acc.walletBalance).toBe(10000.0);
      expect(acc.equity).toBe(10000.0);

      // Verify directly in SQLite settings
      const settingsRepo = new SettingsRepo(db);
      const record = settingsRepo.get<{ balance: number; currency: string }>(
        'paper_wallet_balance'
      );
      expect(record?.balance).toBe(10000.0);
      expect(record?.currency).toBe('USDT');
    });

    it('applies 3bps slippage and 0.05% fee, deducting fee from SQLite balance', async () => {
      const adapter = new LocalPaperAdapter({ db, initialBalance: 10000.0 });

      // Open a LONG order on SOLUSDT at base price 100
      const order = await adapter.openOrder({
        symbol: 'SOLUSDT',
        side: 'BUY',
        orderType: 'MARKET',
        marginUsd: 1000,
        leverage: 1,
        currentPrice: 100.0,
      });

      // BUY with 3bps slippage: 100 * (1 + 0.0003) = 100.03
      expect(order.avgPrice).toBe(100.03);

      // Fee: notional (100.03 * qty) * 0.0005
      const acc = await adapter.getAccount();
      expect(acc.walletBalance).toBeLessThan(10000.0);

      const settingsRepo = new SettingsRepo(db);
      const record = settingsRepo.get<{ balance: number }>('paper_wallet_balance');
      expect(record?.balance).toBe(acc.walletBalance);
    });

    it('evaluates paper SL/TP trigger on mark price ticks', async () => {
      const adapter = new LocalPaperAdapter({ db, initialBalance: 10000.0 });

      // Open LONG
      await adapter.openOrder({
        symbol: 'SOLUSDT',
        side: 'BUY',
        orderType: 'MARKET',
        marginUsd: 1000,
        leverage: 1,
        currentPrice: 200.0,
      });

      // Add SL algo at 190.0
      await adapter.createAlgoOrder({
        symbol: 'SOLUSDT',
        side: 'SELL',
        type: 'STOP_MARKET',
        triggerPrice: 190.0,
        reduceOnly: true,
      });

      let pos = await adapter.getPosition('SOLUSDT');
      expect(pos).not.toBeNull();

      // Tick above SL — position stays open
      adapter.onMarkPriceTick('SOLUSDT', 195.0);
      pos = await adapter.getPosition('SOLUSDT');
      expect(pos).not.toBeNull();

      // Tick breaches SL (<= 190.0) — position automatically closed
      adapter.onMarkPriceTick('SOLUSDT', 189.5);
      pos = await adapter.getPosition('SOLUSDT');
      expect(pos).toBeNull();
    });
  });

  describe('7. BrokerFactory Integration', () => {
    it('returns BinanceDemoAdapter for BINANCE_DEMO and LocalPaperAdapter for LOCAL_PAPER', () => {
      const db = initializeDatabase(':memory:');
      const client = new BinanceClient({ apiKey: 'key', apiSecret: 'secret' });

      const demo = BrokerFactory.getAdapter('BINANCE_DEMO', { client });
      expect(demo.mode).toBe('BINANCE_DEMO');
      expect(demo instanceof BinanceDemoAdapter).toBe(true);

      const paper = BrokerFactory.getAdapter('LOCAL_PAPER', { db });
      expect(paper.mode).toBe('LOCAL_PAPER');
      expect(paper instanceof LocalPaperAdapter).toBe(true);
    });
  });

  describe('8. BinanceStreamsManager Multiplexing & Fail-Safe User WS', () => {
    it('dispatches public market messages to respective listeners', async () => {
      const { BinanceStreamsManager } = await import('../binanceStreams.js');
      const client = new BinanceClient({ apiKey: 'key', apiSecret: 'secret' });
      const streams = new BinanceStreamsManager({ client });

      let markPriceReceived: any = null;
      let klineReceived: any = null;
      let aggTradeReceived: any = null;

      streams.onMarkPrice((ev) => {
        markPriceReceived = ev;
      });
      streams.onKline((ev) => {
        klineReceived = ev;
      });
      streams.onAggTrade((ev) => {
        aggTradeReceived = ev;
      });

      // Simulate public messages
      (streams as any).handlePublicMessage({
        e: 'markPriceUpdate',
        s: 'SOLUSDT',
        p: '210.50',
        r: '0.0001',
        T: 1700000000000,
        E: 1699999999000,
      });

      (streams as any).handlePublicMessage({
        e: 'kline',
        s: 'SOLUSDT',
        k: {
          t: 1700000000000,
          T: 1700000059999,
          s: 'SOLUSDT',
          i: '1m',
          o: '209.0',
          c: '210.5',
          h: '211.0',
          l: '208.5',
          v: '1234.56',
          x: true,
        },
      });

      (streams as any).handlePublicMessage({
        e: 'aggTrade',
        s: 'SOLUSDT',
        p: '210.50',
        q: '5.2',
        m: false,
        T: 1700000005000,
      });

      expect(markPriceReceived).toEqual({
        symbol: 'SOLUSDT',
        markPrice: 210.5,
        fundingRate: 0.0001,
        nextFundingTime: 1700000000000,
        time: 1699999999000,
      });

      expect(klineReceived.symbol).toBe('SOLUSDT');
      expect(klineReceived.interval).toBe('1m');
      expect(klineReceived.candle.close).toBe(210.5);
      expect(klineReceived.isFinal).toBe(true);

      expect(aggTradeReceived).toEqual({
        symbol: 'SOLUSDT',
        price: 210.5,
        qty: 5.2,
        isBuyerMaker: false,
        time: 1700000005000,
      });

      await streams.stop();
    });

    it('terminates socket, requests fresh listenKey, and reconciles on keepalive failure', async () => {
      const { BinanceStreamsManager } = await import('../binanceStreams.js');
      const client = new BinanceClient({ apiKey: 'key', apiSecret: 'secret' });
      const streams = new BinanceStreamsManager({ client });

      let createdKeysCount = 0;
      vi.spyOn(client, 'createListenKey').mockImplementation(async () => {
        createdKeysCount++;
        return `listen_key_${createdKeysCount}`;
      });

      // Mock keepalive failure (-1125)
      vi.spyOn(client, 'keepAliveListenKey').mockRejectedValue(
        new Error('code: -1125, msg: This listenKey does not exist.')
      );

      let terminated = false;
      (streams as any).userDataWs = {
        terminate: () => {
          terminated = true;
        },
      };
      (streams as any).listenKey = 'listen_key_1';
      (streams as any).isRunning = true;

      let reconcileReason = '';
      streams.onReconcile((reason) => {
        reconcileReason = reason;
      });

      // Trigger reconnect from keepalive failure
      await (streams as any).reconnectUserDataStream('KEEPALIVE_FAILURE');

      expect(terminated).toBe(true);
      expect(createdKeysCount).toBe(1);
      expect((streams as any).listenKey).toBe('listen_key_1');
      expect(reconcileReason).toBe('KEEPALIVE_FAILURE');

      await streams.stop();
    });

    it('triggers 45s safety sync during active trades only', async () => {
      vi.useFakeTimers();
      const { BinanceStreamsManager } = await import('../binanceStreams.js');
      const client = new BinanceClient({ apiKey: 'key', apiSecret: 'secret' });
      const streams = new BinanceStreamsManager({
        client,
        safetySyncIntervalMs: 45000,
      });

      let reconcileCalls: string[] = [];
      streams.onReconcile((reason) => {
        reconcileCalls.push(reason);
      });

      (streams as any).isRunning = true;
      (streams as any).startSafetySyncTimer();

      // No active trades: timer ticks, no reconcile
      vi.advanceTimersByTime(45000);
      expect(reconcileCalls).toHaveLength(0);

      // Now active trades exist
      streams.setActiveTradesCount(2);
      vi.advanceTimersByTime(45000);
      expect(reconcileCalls).toEqual(['SAFETY_45S_POLL']);

      await streams.stop();
      vi.useRealTimers();
    });
  });
});
