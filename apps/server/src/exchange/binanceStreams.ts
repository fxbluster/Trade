import WebSocket from 'ws';
import type { KlineCandle } from '@tradeos/shared';
import { BinanceClient } from './binanceClient.js';

export interface MarkPriceEvent {
  symbol: string;
  markPrice: number;
  fundingRate: number | null;
  nextFundingTime: number | null;
  time: number;
}

export interface KlineEvent {
  symbol: string;
  interval: string;
  candle: KlineCandle;
  isFinal: boolean;
}

export interface AggTradeEvent {
  symbol: string;
  price: number;
  qty: number;
  isBuyerMaker: boolean;
  time: number;
}

export interface BinanceStreamsOptions {
  client: BinanceClient;
  publicWsBaseUrl?: string; // default: 'wss://fstream.binance.com/ws'
  userDataWsBaseUrl?: string; // default: 'wss://stream.binancefuture.com/ws'
  keepAliveIntervalMs?: number; // default: 20m (1,200,000ms)
  safetySyncIntervalMs?: number; // default: 45s (45,000ms)
}

export type MarkPriceListener = (event: MarkPriceEvent) => void;
export type KlineListener = (event: KlineEvent) => void;
export type AggTradeListener = (event: AggTradeEvent) => void;
export interface DepthEvent {
  symbol: string;
  bids: [number, number][];
  asks: [number, number][];
  time: number;
}
export type DepthListener = (event: DepthEvent) => void;

export type UserDataListener = (event: any) => void;
export type ReconcileListener = (reason: string) => void;

/**
 * BinanceStreamsManager multiplexes Mainnet public market streams (mark price, klines, aggTrade CVD)
 * and manages the lifecycle of the Testnet User Data WebSocket stream with automatic keepalive,
 * emergency termination on -1125, reconnection, and a 45-second safety poll for active trades.
 */
export class BinanceStreamsManager {
  private client: BinanceClient;
  private publicWsBaseUrl: string;
  private userDataWsBaseUrl: string;
  private keepAliveIntervalMs: number;
  private safetySyncIntervalMs: number;

  private publicWs: WebSocket | null = null;
  private userDataWs: WebSocket | null = null;

  private activeSymbols: Set<string> = new Set();
  private listenKey: string | null = null;
  private keepAliveTimer: NodeJS.Timeout | null = null;
  private safetySyncTimer: NodeJS.Timeout | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;

  private isRunning: boolean = false;
  private activeTradesCount: number = 0;
  private subRequestId: number = 1;

  private markPriceListeners: Set<MarkPriceListener> = new Set();
  private klineListeners: Set<KlineListener> = new Set();
  private aggTradeListeners: Set<AggTradeListener> = new Set();
  private depthListeners: Set<DepthListener> = new Set();
  private userDataListeners: Set<UserDataListener> = new Set();
  private reconcileListeners: Set<ReconcileListener> = new Set();

  constructor(options: BinanceStreamsOptions) {
    this.client = options.client;
    this.publicWsBaseUrl =
      options.publicWsBaseUrl ||
      process.env.BINANCE_PUBLIC_WS_URL ||
      'wss://stream.binancefuture.com/ws';
    this.userDataWsBaseUrl =
      options.userDataWsBaseUrl ||
      process.env.BINANCE_USER_DATA_WS_URL ||
      'wss://stream.binancefuture.com/ws';
    this.keepAliveIntervalMs = options.keepAliveIntervalMs || 20 * 60 * 1000; // 20 minutes
    this.safetySyncIntervalMs = options.safetySyncIntervalMs || 45 * 1000; // 45 seconds
  }

  /**
   * Sets the count of currently active trades to drive the 45-second safety reconciliation poll.
   */
  setActiveTradesCount(count: number): void {
    this.activeTradesCount = Math.max(0, count);
  }

  /**
   * Register listener for mark price updates.
   */
  onMarkPrice(cb: MarkPriceListener): () => void {
    this.markPriceListeners.add(cb);
    return () => this.markPriceListeners.delete(cb);
  }

  /**
   * Register listener for kline updates.
   */
  onKline(cb: KlineListener): () => void {
    this.klineListeners.add(cb);
    return () => this.klineListeners.delete(cb);
  }

  /**
   * Register listener for aggTrade updates (CVD calculation).
   */
  /**
   * Register listener for L2 order book depth updates (OrderFlow calculation).
   */
  onDepth(cb: DepthListener): () => void {
    this.depthListeners.add(cb);
    return () => this.depthListeners.delete(cb);
  }

  onAggTrade(cb: AggTradeListener): () => void {
    this.aggTradeListeners.add(cb);
    return () => this.aggTradeListeners.delete(cb);
  }

  /**
   * Register listener for Testnet User Data events.
   */
  onUserData(cb: UserDataListener): () => void {
    this.userDataListeners.add(cb);
    return () => this.userDataListeners.delete(cb);
  }

  /**
   * Register listener for exchange reconciliation signals.
   */
  onReconcile(cb: ReconcileListener): () => void {
    this.reconcileListeners.add(cb);
    return () => this.reconcileListeners.delete(cb);
  }

  private emitReconcile(reason: string): void {
    for (const listener of this.reconcileListeners) {
      try {
        listener(reason);
      } catch (err) {
        console.error('[STREAMS] Reconcile listener error:', err);
      }
    }
  }

  /**
   * Starts both public market streams and User Data WebSocket stream.
   */
  async start(initialSymbols: string[] = ['SOLUSDT']): Promise<void> {
    if (this.isRunning) return;
    this.isRunning = true;

    for (const sym of initialSymbols) {
      this.activeSymbols.add(sym.toUpperCase());
    }

    this.connectPublicWs();
    await this.startUserDataStream();
    this.startSafetySyncTimer();
  }

  /**
   * Subscribes to live market streams for a new symbol.
   */
  subscribeSymbol(symbol: string): void {
    const symUpper = symbol.toUpperCase();
    if (this.activeSymbols.has(symUpper)) return;
    this.activeSymbols.add(symUpper);

    if (this.publicWs && this.publicWs.readyState === WebSocket.OPEN) {
      const symLower = symUpper.toLowerCase();
      const streams = [
        `${symLower}@markPrice@1s`,
        `${symLower}@kline_1m`,
        `${symLower}@kline_5m`,
        `${symLower}@kline_15m`,
        `${symLower}@kline_1h`,
        `${symLower}@aggTrade`,
        `${symLower}@depth20@100ms`,
      ];
      this.publicWs.send(
        JSON.stringify({
          method: 'SUBSCRIBE',
          params: streams,
          id: this.subRequestId++,
        })
      );
    }
  }

  /**
   * Unsubscribes from live market streams for a symbol.
   */
  unsubscribeSymbol(symbol: string): void {
    const symUpper = symbol.toUpperCase();
    if (!this.activeSymbols.has(symUpper)) return;
    this.activeSymbols.delete(symUpper);

    if (this.publicWs && this.publicWs.readyState === WebSocket.OPEN) {
      const symLower = symUpper.toLowerCase();
      const streams = [
        `${symLower}@markPrice@1s`,
        `${symLower}@kline_1m`,
        `${symLower}@kline_5m`,
        `${symLower}@kline_15m`,
        `${symLower}@kline_1h`,
        `${symLower}@aggTrade`,
        `${symLower}@depth20@100ms`,
      ];
      this.publicWs.send(
        JSON.stringify({
          method: 'UNSUBSCRIBE',
          params: streams,
          id: this.subRequestId++,
        })
      );
    }
  }

  // --------------------------------------------------------------------------
  // Public WebSocket (Mainnet)
  // --------------------------------------------------------------------------

  private connectPublicWs(): void {
    if (!this.isRunning) return;

    try {
      this.publicWs = new WebSocket(this.publicWsBaseUrl);

      this.publicWs.on('open', () => {
        if (this.activeSymbols.size > 0) {
          const streams: string[] = [];
          for (const sym of this.activeSymbols) {
            const symLower = sym.toLowerCase();
            streams.push(
              `${symLower}@markPrice@1s`,
              `${symLower}@kline_1m`,
              `${symLower}@kline_5m`,
              `${symLower}@kline_15m`,
              `${symLower}@kline_1h`,
              `${symLower}@aggTrade`,
              `${symLower}@depth20@100ms`
            );
          }
          this.publicWs?.send(
            JSON.stringify({
              method: 'SUBSCRIBE',
              params: streams,
              id: this.subRequestId++,
            })
          );
        }
      });

      this.publicWs.on('message', (data: WebSocket.RawData) => {
        try {
          const payload = JSON.parse(data.toString());
          this.handlePublicMessage(payload);
        } catch (err) {
          console.error('[PUBLIC WS] Failed to parse message:', err);
        }
      });

      this.publicWs.on('error', (err: Error) => {
        console.error('[PUBLIC WS] Connection error:', err.message);
      });

      this.publicWs.on('close', () => {
        this.publicWs = null;
        if (this.isRunning) {
          setTimeout(() => this.connectPublicWs(), 3000);
        }
      });
    } catch (err) {
      console.error('[PUBLIC WS] Initialization failed:', err);
      if (this.isRunning) {
        setTimeout(() => this.connectPublicWs(), 5000);
      }
    }
  }

  private handlePublicMessage(msg: any): void {
    if (!msg || typeof msg !== 'object') return;
    const eventType = msg.e;

    // Mark Price Update
    if (eventType === 'markPriceUpdate') {
      const ev: MarkPriceEvent = {
        symbol: msg.s,
        markPrice: parseFloat(msg.p),
        fundingRate: msg.r ? parseFloat(msg.r) : null,
        nextFundingTime: msg.T ? Number(msg.T) : null,
        time: msg.E,
      };
      for (const listener of this.markPriceListeners) {
        try {
          listener(ev);
        } catch (e) {
          console.error('[STREAMS] MarkPrice listener error:', e);
        }
      }
      return;
    }

    // Kline Candlestick Update
    if (eventType === 'kline' && msg.k) {
      const k = msg.k;
      const candle: KlineCandle = {
        time: Math.floor(k.t / 1000),
        open: parseFloat(k.o),
        high: parseFloat(k.h),
        low: parseFloat(k.l),
        close: parseFloat(k.c),
        volume: parseFloat(k.v),
      };
      const ev: KlineEvent = {
        symbol: msg.s,
        interval: k.i,
        candle,
        isFinal: Boolean(k.x),
      };
      for (const listener of this.klineListeners) {
        try {
          listener(ev);
        } catch (e) {
          console.error('[STREAMS] Kline listener error:', e);
        }
      }
      return;
    }

    // L2 Depth Update (Order Book Imbalance)
    if (eventType === 'depthUpdate' || (Array.isArray(msg.b) && Array.isArray(msg.a))) {
      const ev: DepthEvent = {
        symbol: msg.s || (msg.stream ? msg.stream.split('@')[0].toUpperCase() : ''),
        bids: (msg.b || []).map((x: any) => [parseFloat(x[0]), parseFloat(x[1])]),
        asks: (msg.a || []).map((x: any) => [parseFloat(x[0]), parseFloat(x[1])]),
        time: msg.E || Date.now(),
      };
      for (const listener of this.depthListeners) {
        try {
          listener(ev);
        } catch (e) {
          console.error('[STREAMS] Depth listener error:', e);
        }
      }
      return;
    }

    // Aggregate Trade Update (CVD)
    if (eventType === 'aggTrade') {
      const ev: AggTradeEvent = {
        symbol: msg.s,
        price: parseFloat(msg.p),
        qty: parseFloat(msg.q),
        isBuyerMaker: Boolean(msg.m),
        time: msg.T,
      };
      for (const listener of this.aggTradeListeners) {
        try {
          listener(ev);
        } catch (e) {
          console.error('[STREAMS] AggTrade listener error:', e);
        }
      }
      return;
    }
  }

  // --------------------------------------------------------------------------
  // User Data WebSocket (Testnet) & ListenKey Lifecycle
  // --------------------------------------------------------------------------

  /**
   * Initializes User Data Stream with listenKey creation and 20m keepalive.
   */
  async startUserDataStream(): Promise<void> {
    if (!this.client.apiKey) {
      return;
    }

    try {
      this.listenKey = await this.client.createListenKey();
      this.connectUserDataWs();
      this.startKeepAliveTimer();
    } catch (err: any) {
      console.error('[USER WS] Failed to acquire listenKey:', err.message);
      // Retry in 10 seconds if still running
      if (this.isRunning) {
        setTimeout(() => this.startUserDataStream(), 10000);
      }
    }
  }

  private connectUserDataWs(): void {
    if (!this.isRunning || !this.listenKey) return;

    try {
      const url = `${this.userDataWsBaseUrl}/${this.listenKey}`;
      this.userDataWs = new WebSocket(url);

      this.userDataWs.on('open', () => {
        // User data stream connected
      });

      this.userDataWs.on('message', (data: WebSocket.RawData) => {
        try {
          const payload = JSON.parse(data.toString());
          this.handleUserDataMessage(payload);
        } catch (err) {
          console.error('[USER WS] Failed to parse message:', err);
        }
      });

      this.userDataWs.on('error', (err: Error) => {
        console.error('[USER WS] Connection error:', err.message);
      });

      this.userDataWs.on('close', () => {
        this.userDataWs = null;
        if (this.isRunning) {
          // Reconnect user data stream
          setTimeout(() => this.reconnectUserDataStream('WS_CLOSED'), 3000);
        }
      });
    } catch (err) {
      console.error('[USER WS] Initialization failed:', err);
    }
  }

  private handleUserDataMessage(payload: any): void {
    if (!payload || typeof payload !== 'object') return;

    // ListenKey expired notification from exchange
    if (payload.e === 'listenKeyExpired') {
      this.reconnectUserDataStream('EXPIRED_LISTEN_KEY_EVENT');
      return;
    }

    // Forward order/trade/account updates
    for (const listener of this.userDataListeners) {
      try {
        listener(payload);
      } catch (err) {
        console.error('[USER WS] UserData listener error:', err);
      }
    }
  }

  /**
   * Keepalive timer: every 20 minutes sends PUT /fapi/v1/listenKey.
   * On failure (-1125 or network), immediately calls ws.terminate(),
   * requests fresh key, reconnects, and triggers reconciliation.
   */
  private startKeepAliveTimer(): void {
    if (this.keepAliveTimer) {
      clearInterval(this.keepAliveTimer);
    }

    this.keepAliveTimer = setInterval(async () => {
      if (!this.listenKey || !this.isRunning) return;

      try {
        await this.client.keepAliveListenKey(this.listenKey);
      } catch (err: any) {
        console.error('[USER WS] Keepalive failed (-1125 or network):', err.message);
        // CRITICAL FAIL-SAFE: Terminate immediately and recover with fresh key
        await this.reconnectUserDataStream('KEEPALIVE_FAILURE');
      }
    }, this.keepAliveIntervalMs);
  }

  /**
   * Recovers from broken, stale or expired listenKey state.
   */
  async reconnectUserDataStream(reason: string): Promise<void> {
    // 1. Immediately terminate active socket to prevent zombie TCP hang
    if (this.userDataWs) {
      try {
        this.userDataWs.terminate();
      } catch (_) {}
      this.userDataWs = null;
    }

    this.listenKey = null;

    if (!this.isRunning) return;

    try {
      // 2. Request a fresh listenKey
      this.listenKey = await this.client.createListenKey();
      // 3. Connect new WebSocket
      this.connectUserDataWs();
      // 4. Trigger reconciliation
      this.emitReconcile(reason);
    } catch (err: any) {
      console.error('[USER WS] Reconnection failed:', err.message);
      if (this.isRunning) {
        setTimeout(() => this.reconnectUserDataStream('RETRY_AFTER_ERROR'), 5000);
      }
    }
  }

  /**
   * 45-second background safety poll during active trades to guarantee no missed fills.
   */
  private startSafetySyncTimer(): void {
    if (this.safetySyncTimer) {
      clearInterval(this.safetySyncTimer);
    }

    this.safetySyncTimer = setInterval(() => {
      if (!this.isRunning) return;
      if (this.activeTradesCount > 0) {
        this.emitReconcile('SAFETY_45S_POLL');
      }
    }, this.safetySyncIntervalMs);
  }

  /**
   * Gracefully terminates all WebSockets and cleans up timers and listenKey.
   */
  async stop(): Promise<void> {
    this.isRunning = false;

    if (this.keepAliveTimer) {
      clearInterval(this.keepAliveTimer);
      this.keepAliveTimer = null;
    }
    if (this.safetySyncTimer) {
      clearInterval(this.safetySyncTimer);
      this.safetySyncTimer = null;
    }
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    if (this.publicWs) {
      try {
        this.publicWs.terminate();
      } catch (_) {}
      this.publicWs = null;
    }

    if (this.userDataWs) {
      try {
        this.userDataWs.terminate();
      } catch (_) {}
      this.userDataWs = null;
    }

    if (this.listenKey) {
      const key = this.listenKey;
      this.listenKey = null;
      try {
        await this.client.closeListenKey(key);
      } catch (_) {}
    }

    this.markPriceListeners.clear();
    this.klineListeners.clear();
    this.aggTradeListeners.clear();
    this.userDataListeners.clear();
    this.reconcileListeners.clear();
  }
}
