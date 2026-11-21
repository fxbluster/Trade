import type {
  WsClientMessage,
  WsServerMessage,
  CockpitState,
  KlineCandle,
  TechnicalSummary,
  MentorBrief,
  RiskStateRecord,
  PositionEventType,
  TradeRecord,
  AlertLevel,
  ConfluenceSnapshot,
  AutoPilotConfig,
} from '@tradeos/shared';
import { getSessionToken } from './apiClient';

export type WsStatus = 'CONNECTED' | 'DISCONNECTED' | 'CONNECTING';

export type TickData = {
  symbol: string;
  markPrice: number;
  candle: KlineCandle;
  cvd: number;
  unrealizedPnl: number;
};

export type AnalysisData = {
  indicators: TechnicalSummary | null;
  sokrat: MentorBrief | null;
  risk: RiskStateRecord;
};

export type PositionEventData = {
  event: PositionEventType;
  data: {
    trade: TradeRecord;
    reason?: string;
  };
};

export type AlertData = {
  level: AlertLevel;
  message: string;
};

export type AutoPilotStatusData = {
  state: string;
  config: AutoPilotConfig;
  openTradeId: string | null;
};

type MessageHandlers = {
  onSnapshot?: (data: CockpitState) => void;
  onTick?: (data: TickData) => void;
  onAnalysis?: (data: AnalysisData) => void;
  onPositionEvent?: (data: PositionEventData) => void;
  onAlert?: (data: AlertData) => void;
  onConfluence?: (data: ConfluenceSnapshot) => void;
  onAutoPilotStatus?: (data: AutoPilotStatusData) => void;
  onStatusChange?: (status: WsStatus) => void;
};

class WsClient {
  private ws: WebSocket | null = null;
  private status: WsStatus = 'DISCONNECTED';
  private handlers: MessageHandlers = {};
  private tickListeners: Set<(tick: TickData) => void> = new Set();
  private pingInterval: any = null;
  private reconnectTimeout: any = null;
  private isExplicitlyClosed = false;
  private reconnectDelay = 1000;
  private maxReconnectDelay = 8000;
  private currentSubscribedSymbol: string | null = null;

  constructor() {
    if (typeof window !== 'undefined') {
      // Reconnect immediately when user switches back to tab or window gains focus
      window.addEventListener('focus', () => {
        if (!this.ws || this.ws.readyState === WebSocket.CLOSED || this.ws.readyState === WebSocket.CLOSING) {
          this.connect();
        }
      });

      // Reconnect immediately when PC reconnects to internet
      window.addEventListener('online', () => {
        this.connect();
      });

      // Handle background tab sleep/wake
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') {
          if (!this.ws || this.ws.readyState === WebSocket.CLOSED || this.ws.readyState === WebSocket.CLOSING) {
            this.connect();
          }
        }
      });
    }
  }

  public setHandlers(handlers: MessageHandlers) {
    this.handlers = { ...this.handlers, ...handlers };
  }

  public subscribeTick(listener: (tick: TickData) => void): () => void {
    this.tickListeners.add(listener);
    return () => {
      this.tickListeners.delete(listener);
    };
  }

  public getStatus(): WsStatus {
    return this.status;
  }

  private setStatus(status: WsStatus) {
    this.status = status;
    this.handlers.onStatusChange?.(status);
  }

  public async connect(): Promise<void> {
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      return;
    }

    this.isExplicitlyClosed = false;
    this.setStatus('CONNECTING');

    try {
      const token = await getSessionToken();
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const host = window.location.host;
      const wsUrl = `${protocol}//${host}/ws`;

      // Use Sec-WebSocket-Protocol: ['tradeos-auth', sessionToken]
      this.ws = new WebSocket(wsUrl, ['tradeos-auth', token]);

      this.ws.onopen = () => {
        this.setStatus('CONNECTED');
        this.reconnectDelay = 1000;
        this.startHeartbeat();

        // Resubscribe symbol if already selected
        if (this.currentSubscribedSymbol) {
          this.subscribeSymbol(this.currentSubscribedSymbol);
        }
      };

      this.ws.onmessage = (event: MessageEvent) => {
        try {
          const msg = JSON.parse(event.data) as WsServerMessage;
          switch (msg.type) {
            case 'SNAPSHOT':
              this.handlers.onSnapshot?.(msg.data);
              break;
            case 'TICK':
              this.handlers.onTick?.(msg.data);
              this.tickListeners.forEach((listener) => {
                try {
                  listener(msg.data);
                } catch (err) {
                  console.error('[WS] Tick listener error:', err);
                }
              });
              break;
            case 'ANALYSIS':
              this.handlers.onAnalysis?.(msg.data);
              break;
            case 'POSITION_EVENT':
              this.handlers.onPositionEvent?.({ event: msg.event, data: msg.data });
              break;
            case 'ALERT':
              this.handlers.onAlert?.({ level: msg.level, message: msg.message });
              break;
            case 'CONFLUENCE_UPDATE':
              this.handlers.onConfluence?.(msg.data);
              break;
            case 'AUTOPILOT_STATUS':
              this.handlers.onAutoPilotStatus?.(msg.data);
              break;
          }
        } catch (err) {
          console.error('[WS] Failed to parse message:', err);
        }
      };

      this.ws.onerror = (err) => {
        console.warn('[WS] Error event:', err);
      };

      this.ws.onclose = () => {
        this.cleanup();
        this.setStatus('DISCONNECTED');
        if (!this.isExplicitlyClosed) {
          this.scheduleReconnect();
        }
      };
    } catch (err) {
      console.error('[WS] Connect initiation error:', err);
      this.setStatus('DISCONNECTED');
      if (!this.isExplicitlyClosed) {
        this.scheduleReconnect();
      }
    }
  }

  private startHeartbeat() {
    this.stopHeartbeat();
    this.pingInterval = setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.send({ type: 'PING' });
      }
    }, 20000);
  }

  private stopHeartbeat() {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
  }

  private cleanup() {
    this.stopHeartbeat();
    if (this.ws) {
      this.ws.onopen = null;
      this.ws.onmessage = null;
      this.ws.onerror = null;
      this.ws.onclose = null;
      this.ws = null;
    }
  }

  private scheduleReconnect() {
    if (this.reconnectTimeout) return;
    this.reconnectTimeout = setTimeout(() => {
      this.reconnectTimeout = null;
      this.reconnectDelay = Math.min(this.reconnectDelay * 1.5, this.maxReconnectDelay);
      this.connect();
    }, this.reconnectDelay);
  }

  public subscribeSymbol(symbol: string) {
    this.currentSubscribedSymbol = symbol.toUpperCase();
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.send({ type: 'SUBSCRIBE_SYMBOL', symbol: this.currentSubscribedSymbol });
    }
  }

  public send(msg: WsClientMessage) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  public disconnect() {
    this.isExplicitlyClosed = true;
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }
    if (this.ws) {
      this.ws.close();
      this.cleanup();
    }
    this.setStatus('DISCONNECTED');
  }
}

export const wsClient = new WsClient();
