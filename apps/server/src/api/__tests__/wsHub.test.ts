import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import http from 'node:http';
import WebSocket from 'ws';
import { WsHub } from '../wsHub.js';
import type { CockpitState, KlineCandle, TradeRecord } from '@tradeos/shared';

const TEST_TOKEN = 'test_secret_token_12345678901234567890123456789012';

function getMockSnapshot(symbol: string = 'SOLUSDT'): CockpitState {
  return {
    symbol,
    markPrice: 100,
    fundingRate: 0.0001,
    nextFundingTime: Date.now() + 3600000,
    account: {
      walletBalance: 1000,
      equity: 1000,
      availableBalance: 1000,
      unrealizedPnl: 0,
      currency: 'USDT',
    },
    activePosition: null,
    openOrders: [],
    indicators: null,
    cvd: null,
    risk: {
      broker_mode: 'BINANCE_DEMO',
      consecutive_losses: 0,
      cooldown_until: 0,
      cooldown_reason: null,
      session_net_pnl: 0,
      session_started_at: Date.now(),
      updated_at: Date.now(),
    },
    sokrat: null,
    exchangeHealth: 'HEALTHY',
    brokerMode: 'BINANCE_DEMO',
  };
}

describe('WsHub — WebSocket Server & Handshake Security', () => {
  let server: http.Server;
  let wsHub: WsHub;
  let port: number;
  let activeClients: WebSocket[] = [];

  beforeEach(async () => {
    activeClients = [];
    server = http.createServer((req, res) => {
      res.statusCode = 200;
      res.end('OK');
    });

    wsHub = new WsHub({
      server,
      path: '/ws',
      sessionToken: TEST_TOKEN,
      getSnapshot: (sym) => getMockSnapshot(sym),
    });

    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address() as any;
        port = addr.port;
        resolve();
      });
    });
  });

  afterEach(async () => {
    for (const ws of activeClients) {
      try {
        ws.terminate();
      } catch {}
    }
    await wsHub.close();
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  });

  it('authenticates client successfully via Sec-WebSocket-Protocol and delivers initial SNAPSHOT', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, ['tradeos-auth', TEST_TOKEN]);
    activeClients.push(ws);

    const receivedMessages: any[] = [];
    await new Promise<void>((resolve, reject) => {
      ws.on('open', () => {});
      ws.on('message', (data) => {
        const parsed = JSON.parse(data.toString());
        receivedMessages.push(parsed);
        if (parsed.type === 'SNAPSHOT') {
          resolve();
        }
      });
      ws.on('error', reject);
    });

    expect(receivedMessages.length).toBeGreaterThanOrEqual(1);
    expect(receivedMessages[0].type).toBe('SNAPSHOT');
    expect(receivedMessages[0].data.symbol).toBe('SOLUSDT');
    expect(wsHub.getAuthenticatedClientsCount()).toBe(1);
  });

  it('allows in-band authentication within the 3-second handshake window', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    activeClients.push(ws);

    await new Promise<void>((resolve) => {
      ws.on('open', resolve);
    });

    expect(wsHub.getAuthenticatedClientsCount()).toBe(0);

    const snapshotPromise = new Promise<any>((resolve) => {
      ws.on('message', (data) => {
        const parsed = JSON.parse(data.toString());
        if (parsed.type === 'SNAPSHOT') resolve(parsed);
      });
    });

    // Send AUTH message within 3s
    ws.send(JSON.stringify({ type: 'AUTH', token: TEST_TOKEN }));

    const snapshot = await snapshotPromise;
    expect(snapshot.type).toBe('SNAPSHOT');
    expect(wsHub.getAuthenticatedClientsCount()).toBe(1);
  });

  it('immediately terminates connection if an invalid auth token is sent', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    activeClients.push(ws);

    await new Promise<void>((resolve) => {
      ws.on('open', resolve);
    });

    const closePromise = new Promise<void>((resolve) => {
      ws.on('close', () => resolve());
    });

    // Send bad token
    ws.send(JSON.stringify({ type: 'AUTH', token: 'wrong_token' }));

    await closePromise;
    expect(ws.readyState).toBe(WebSocket.CLOSED);
  });

  it('responds to PING with PONG and handles SUBSCRIBE_SYMBOL command', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, ['tradeos-auth', TEST_TOKEN]);
    activeClients.push(ws);

    let pongReceived: any = null;
    let btcSnapReceived: any = null;

    await new Promise<void>((resolve, reject) => {
      ws.on('open', () => {
        // Send PING and SUBSCRIBE_SYMBOL after connection opens
        ws.send(JSON.stringify({ type: 'PING' }));
        ws.send(JSON.stringify({ type: 'SUBSCRIBE_SYMBOL', symbol: 'BTCUSDT' }));
      });

      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'PONG') {
          pongReceived = msg;
        }
        if (msg.type === 'SNAPSHOT' && msg.data?.symbol === 'BTCUSDT') {
          btcSnapReceived = msg;
        }
        if (pongReceived && btcSnapReceived) {
          resolve();
        }
      });

      ws.on('error', reject);
    });

    expect(pongReceived).not.toBeNull();
    expect(pongReceived.type).toBe('PONG');
    expect(pongReceived.timestamp).toBeGreaterThan(0);

    expect(btcSnapReceived).not.toBeNull();
    expect(btcSnapReceived.data.symbol).toBe('BTCUSDT');
  });

  it('rate-throttles TICK broadcasts to <= 4Hz (min 250ms interval)', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, ['tradeos-auth', TEST_TOKEN]);
    activeClients.push(ws);

    await new Promise<void>((resolve) => {
      ws.on('open', resolve);
    });

    const receivedTicks: any[] = [];
    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.type === 'TICK') {
        receivedTicks.push(msg);
      }
    });

    const candle: KlineCandle = {
      time: Math.floor(Date.now() / 1000),
      open: 100,
      high: 101,
      low: 99,
      close: 100.5,
      volume: 500,
    };

    // Emit 5 rapid ticks within 30ms
    for (let i = 1; i <= 5; i++) {
      wsHub.broadcastTick({
        symbol: 'SOLUSDT',
        markPrice: 100 + i,
        candle,
        cvd: i * 10,
        unrealizedPnl: i * 5,
      });
    }

    // Immediately after emission, at most 1 tick should be broadcast
    expect(receivedTicks.length).toBeLessThanOrEqual(1);

    // Wait 300ms for the coalesced throttled tick to flush
    await new Promise((r) => setTimeout(r, 320));

    // The throttled flush should deliver the latest coalesced state (markPrice = 105)
    expect(receivedTicks.length).toBe(2);
    expect(receivedTicks[receivedTicks.length - 1].data.markPrice).toBe(105);
  });

  it('broadcasts position events and alerts immediately without throttling', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, ['tradeos-auth', TEST_TOKEN]);
    activeClients.push(ws);

    await new Promise<void>((resolve) => {
      ws.on('open', resolve);
    });

    const receivedAlerts: any[] = [];
    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.type === 'ALERT') {
        receivedAlerts.push(msg);
      }
    });

    wsHub.broadcastAlert('CRITICAL', 'Emergency test alert');

    await new Promise((r) => setTimeout(r, 50));
    expect(receivedAlerts.length).toBe(1);
    expect(receivedAlerts[0].level).toBe('CRITICAL');
    expect(receivedAlerts[0].message).toBe('Emergency test alert');
  });
});
