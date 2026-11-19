import http from 'node:http';
import crypto from 'node:crypto';
import WebSocket, { WebSocketServer } from 'ws';
import type {
  WsServerMessage,
  WsClientMessage,
  CockpitState,
  KlineCandle,
  PositionEventType,
  AlertLevel,
  TradeRecord,
  ConfluenceSnapshot,
  AutoPilotConfig,
} from '@tradeos/shared';
import { SESSION_TOKEN } from '../config.js';

export interface ClientConnection {
  ws: WebSocket;
  isAuthenticated: boolean;
  authTimer: NodeJS.Timeout | null;
  subscribedSymbol: string;
  connectedAt: number;
}

export interface WsHubOptions {
  server?: http.Server;
  path?: string;
  sessionToken?: string;
  getSnapshot?: (symbol?: string) => Promise<CockpitState> | CockpitState;
  onSubscribeSymbol?: (symbol: string) => void;
}

/**
 * WsHub manages the WebSocket communication channel (/ws) for TradeOS v2.
 * It enforces subprotocol cryptographic authentication ('tradeos-auth', sessionToken),
 * a strict 3-second handshake authentication window, 4Hz throttled TICK broadcasts,
 * real-time snapshots, analysis, position events, and critical alerts.
 */
export class WsHub {
  private wss: WebSocketServer;
  private clients = new Set<ClientConnection>();
  private sessionToken: string;
  private getSnapshotFn?: (symbol?: string) => Promise<CockpitState> | CockpitState;
  private onSubscribeSymbolFn?: (symbol: string) => void;

  // 4Hz (250ms) rate throttling for TICK broadcasts
  private lastTickBroadcastTime = 0;
  private pendingTick: {
    symbol: string;
    markPrice: number;
    candle: KlineCandle;
    cvd: number;
    unrealizedPnl: number;
  } | null = null;
  private tickThrottleTimer: NodeJS.Timeout | null = null;

  // 2Hz (500ms) rate throttling for CONFLUENCE_UPDATE broadcasts
  private lastConfluenceBroadcastTime = 0;
  private pendingConfluence: ConfluenceSnapshot | null = null;
  private confluenceThrottleTimer: NodeJS.Timeout | null = null;

  constructor(options: WsHubOptions = {}) {
    this.sessionToken = options.sessionToken || SESSION_TOKEN;
    this.getSnapshotFn = options.getSnapshot;
    this.onSubscribeSymbolFn = options.onSubscribeSymbol;

    const wssOptions: any = {
      path: options.path || '/ws',
      handleProtocols: (protocols: Set<string>) => {
        if (protocols.has('tradeos-auth')) {
          return 'tradeos-auth';
        }
        return false;
      },
    };

    if (options.server) {
      wssOptions.server = options.server;
    } else {
      wssOptions.noServer = true;
    }

    this.wss = new WebSocketServer(wssOptions);
    this.setupListeners();
  }

  public getWebSocketServer(): WebSocketServer {
    return this.wss;
  }

  public getConnectedClientsCount(): number {
    return this.clients.size;
  }

  public getAuthenticatedClientsCount(): number {
    let count = 0;
    for (const c of this.clients) {
      if (c.isAuthenticated && c.ws.readyState === WebSocket.OPEN) {
        count++;
      }
    }
    return count;
  }

  private verifyToken(token: string): boolean {
    if (!token || typeof token !== 'string') return false;
    const tokenBuf = Buffer.from(token);
    const sessionBuf = Buffer.from(this.sessionToken);
    return (
      tokenBuf.length === sessionBuf.length &&
      crypto.timingSafeEqual(tokenBuf, sessionBuf)
    );
  }

  private setupListeners(): void {
    this.wss.on('connection', (ws: WebSocket, req: http.IncomingMessage) => {
      // Check subprotocol header for authentication credentials
      const protocolsHeader = req.headers['sec-websocket-protocol'] || '';
      const protocolTokens = protocolsHeader.split(',').map((p) => p.trim());

      let isAuthed = false;
      if (
        protocolTokens.includes('tradeos-auth') &&
        protocolTokens.some((token) => this.verifyToken(token))
      ) {
        isAuthed = true;
      }

      const client: ClientConnection = {
        ws,
        isAuthenticated: isAuthed,
        authTimer: null,
        subscribedSymbol: 'SOLUSDT',
        connectedAt: Date.now(),
      };

      this.clients.add(client);

      // If not authenticated via subprotocol header, enforce a strict 3-second window
      if (!isAuthed) {
        client.authTimer = setTimeout(() => {
          if (!client.isAuthenticated && ws.readyState === WebSocket.OPEN) {
            ws.terminate();
            this.clients.delete(client);
          }
        }, 3000);
      } else {
        // Send initial snapshot on successful subprotocol auth
        this.sendInitialSnapshot(client);
      }

      ws.on('message', (raw: WebSocket.RawData) => {
        this.handleMessage(client, raw);
      });

      ws.on('close', () => {
        if (client.authTimer) {
          clearTimeout(client.authTimer);
        }
        this.clients.delete(client);
      });

      ws.on('error', () => {
        if (client.authTimer) {
          clearTimeout(client.authTimer);
        }
        this.clients.delete(client);
      });
    });
  }

  private async sendInitialSnapshot(client: ClientConnection): Promise<void> {
    if (this.getSnapshotFn && client.ws.readyState === WebSocket.OPEN) {
      try {
        const snap = await Promise.resolve(this.getSnapshotFn(client.subscribedSymbol));
        if (snap && client.ws.readyState === WebSocket.OPEN) {
          client.ws.send(JSON.stringify({ type: 'SNAPSHOT', data: snap }));
        }
      } catch {
        // Tolerated on initialization race
      }
    }
  }

  private handleMessage(client: ClientConnection, raw: WebSocket.RawData): void {
    let msg: any;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return; // Ignore malformed non-JSON
    }

    // Handle handshake auth message if not yet authenticated
    if (!client.isAuthenticated) {
      if (msg.type === 'AUTH' && msg.token && this.verifyToken(msg.token)) {
        client.isAuthenticated = true;
        if (client.authTimer) {
          clearTimeout(client.authTimer);
          client.authTimer = null;
        }
        this.sendInitialSnapshot(client);
      } else {
        // Reject and terminate immediately on bad auth attempt
        if (client.authTimer) {
          clearTimeout(client.authTimer);
        }
        client.ws.terminate();
        this.clients.delete(client);
      }
      return;
    }

    // Handle authenticated client commands
    if (msg.type === 'PING') {
      if (client.ws.readyState === WebSocket.OPEN) {
        client.ws.send(JSON.stringify({ type: 'PONG', timestamp: Date.now() }));
      }
      return;
    }

    if (msg.type === 'SUBSCRIBE_SYMBOL' && typeof msg.symbol === 'string') {
      const sym = msg.symbol.toUpperCase().trim();
      client.subscribedSymbol = sym;
      if (this.onSubscribeSymbolFn) {
        this.onSubscribeSymbolFn(sym);
      }
      this.sendInitialSnapshot(client);
      return;
    }
  }

  /**
   * Broadcasts a server message to all currently authenticated active clients.
   */
  public broadcast(msg: WsServerMessage): void {
    const payload = JSON.stringify(msg);
    for (const client of this.clients) {
      if (client.isAuthenticated && client.ws.readyState === WebSocket.OPEN) {
        client.ws.send(payload);
      }
    }
  }

  /**
   * Broadcasts market TICK at a strictly throttled rate of <= 4Hz (min 250ms interval).
   * Coalesces high-frequency ticks to prevent frontend frame-dropping.
   */
  public broadcastTick(tick: {
    symbol: string;
    markPrice: number;
    candle: KlineCandle;
    cvd: number;
    unrealizedPnl: number;
  }): void {
    const now = Date.now();
    this.pendingTick = tick;

    if (now - this.lastTickBroadcastTime >= 250) {
      this.flushTick();
    } else if (!this.tickThrottleTimer) {
      const delay = Math.max(10, 250 - (now - this.lastTickBroadcastTime));
      this.tickThrottleTimer = setTimeout(() => {
        this.tickThrottleTimer = null;
        this.flushTick();
      }, delay);
    }
  }

  private flushTick(): void {
    if (!this.pendingTick) return;
    this.lastTickBroadcastTime = Date.now();
    const msg: WsServerMessage = {
      type: 'TICK',
      data: this.pendingTick,
    };
    this.pendingTick = null;
    this.broadcast(msg);
  }

  /**
   * Broadcasts 6+1 Confluence snapshot at a throttled rate of <= 2Hz (min 500ms interval).
   */
  public broadcastConfluence(snapshot: ConfluenceSnapshot): void {
    const now = Date.now();
    this.pendingConfluence = snapshot;

    if (now - this.lastConfluenceBroadcastTime >= 500) {
      this.flushConfluence();
    } else if (!this.confluenceThrottleTimer) {
      const delay = Math.max(10, 500 - (now - this.lastConfluenceBroadcastTime));
      this.confluenceThrottleTimer = setTimeout(() => {
        this.confluenceThrottleTimer = null;
        this.flushConfluence();
      }, delay);
    }
  }

  private flushConfluence(): void {
    if (!this.pendingConfluence) return;
    this.lastConfluenceBroadcastTime = Date.now();
    const msg: any = {
      type: 'CONFLUENCE_UPDATE',
      data: this.pendingConfluence,
    };
    this.pendingConfluence = null;
    this.broadcast(msg);
  }

  /**
   * Broadcasts Auto-Pilot state machine status.
   */
  public broadcastAutoPilotStatus(data: {
    state: string;
    config: AutoPilotConfig;
    openTradeId: string | null;
    cooldownRemainingSec?: number;
  }): void {
    const msg: any = {
      type: 'AUTOPILOT_STATUS',
      data,
    };
    this.broadcast(msg);
  }

  /**
   * Broadcasts a full CockpitState snapshot.
   */
  public broadcastSnapshot(snapshot: CockpitState, targetWs?: WebSocket): void {
    const msg: WsServerMessage = {
      type: 'SNAPSHOT',
      data: snapshot,
    };
    if (targetWs) {
      if (targetWs.readyState === WebSocket.OPEN) {
        targetWs.send(JSON.stringify(msg));
      }
    } else {
      this.broadcast(msg);
    }
  }

  /**
   * Broadcasts real-time position lifecycle events (OPENED, UPDATED, BREAKEVEN, CLOSED, OCO_FILL).
   */
  public broadcastPositionEvent(
    event: PositionEventType,
    trade: TradeRecord,
    reason?: string
  ): void {
    const msg: WsServerMessage = {
      type: 'POSITION_EVENT',
      event,
      data: {
        trade,
        reason,
      },
    };
    this.broadcast(msg);
  }

  /**
   * Broadcasts system, risk or mentor alerts.
   */
  public broadcastAlert(level: AlertLevel, message: string): void {
    const msg: WsServerMessage = {
      type: 'ALERT',
      level,
      message,
    };
    this.broadcast(msg);
  }

  /**
   * Broadcasts technical analysis, mentor brief, and risk state updates.
   */
  public broadcastAnalysis(indicators: any, sokrat: any, risk: any): void {
    const msg: WsServerMessage = {
      type: 'ANALYSIS',
      data: {
        indicators,
        sokrat,
        risk,
      },
    };
    this.broadcast(msg);
  }

  /**
   * Closes the WebSocket server and terminates all active connections.
   */
  public async close(): Promise<void> {
    if (this.tickThrottleTimer) {
      clearTimeout(this.tickThrottleTimer);
      this.tickThrottleTimer = null;
    }
    if (this.confluenceThrottleTimer) {
      clearTimeout(this.confluenceThrottleTimer);
      this.confluenceThrottleTimer = null;
    }
    for (const client of this.clients) {
      if (client.authTimer) {
        clearTimeout(client.authTimer);
      }
      client.ws.terminate();
    }
    this.clients.clear();

    await new Promise<void>((resolve) => {
      this.wss.close(() => resolve());
    });
  }
}
