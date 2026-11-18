/**
 * TradeOS v2 — Shared Type Contracts & DTOs
 * Single source of truth for backend (apps/server) and frontend (apps/web).
 */

export type BrokerMode = 'BINANCE_DEMO' | 'LOCAL_PAPER';

export type TradeSide = 'BUY' | 'SELL';

export type OrderType = 'MARKET' | 'LIMIT';

export type TradeStatus = 'OPEN' | 'PARTIALLY_CLOSED' | 'CLOSING' | 'CLOSED';

export type ExchangeHealth = 'HEALTHY' | 'DEGRADED' | 'BANNED' | 'OFFLINE';

export type PositionEventType = 'OPENED' | 'UPDATED' | 'BREAKEVEN' | 'CLOSED' | 'OCO_FILL';

export type AlertLevel = 'INFO' | 'WARN' | 'CRITICAL';

export type MentorMode = 'DISCIPLINE' | 'CAUTION' | 'AGGRESSIVE' | 'LOCKOUT';

// ----------------------------------------------------------------------------
// REST API Request / Response DTOs
// ----------------------------------------------------------------------------

export interface OpenOrderRequest {
  symbol: string;
  side: TradeSide;
  orderType: OrderType;
  marginUsd: number;
  leverage: number;
  limitPrice?: number;
  stopLoss?: number;
  tp1?: number;
  tp2?: number;
}

export type OrderPreviewRequest = OpenOrderRequest;

export interface OrderPreviewResponse {
  quantity: number;
  notionalUsd: number;
  estimatedLiquidation: number;
  deadSlSafe: boolean;
  rrRatio: number;
  maxLossUsd: number;
  breakevenPrice: number;
}

export interface CloseOrderRequest {
  symbol?: string;
  reason?: string;
}

export interface BreakevenRequest {
  symbol?: string;
}

export interface CooldownBypassRequest {
  reason: string;
}

export interface MentorChatRequest {
  message: string;
}

export interface MentorChatResponse {
  reply: string;
  mode: MentorMode;
  timestamp: number;
}

export interface SetSymbolRequest {
  symbol: string;
}

export interface SetBrokerModeRequest {
  mode: BrokerMode;
}

export interface HealthResponse {
  ok: boolean;
  uptimeSec: number;
  exchangeHealth: ExchangeHealth;
  wsConnected: boolean;
  brokerMode: BrokerMode;
}

export interface AuthSessionResponse {
  token: string;
}

// ----------------------------------------------------------------------------
// Database Models (matches SQLite schema.sql)
// ----------------------------------------------------------------------------

export interface TradeRecord {
  id: string;                                 // UUID v4
  symbol: string;
  broker_mode: BrokerMode;
  side: TradeSide;
  status: TradeStatus;
  entry_price: number;
  exit_price: number | null;
  quantity: number;
  remaining_qty: number;                      // Remaining quantity after partial TP1 fill
  leverage: number;
  margin_usd: number;
  stop_loss: number | null;
  tp1: number | null;
  tp2: number | null;
  be_price: number | null;
  is_breakeven: number;                       // 0 or 1
  client_order_id: string | null;             // tos_${id}_ent
  client_sl_id: string | null;                // tos_${id}_sl
  client_tp1_id: string | null;               // tos_${id}_tp1
  client_tp2_id: string | null;               // tos_${id}_tp2
  entry_order_id: string | null;
  sl_algo_id: string | null;
  tp1_algo_id: string | null;
  tp2_algo_id: string | null;
  realized_pnl: number;
  fees_usd: number;
  exit_reason: string | null;
  opened_at: number;                          // UTC Unix ms
  closed_at: number | null;                   // UTC Unix ms
}

export interface FillRecord {
  binance_trade_id: string;
  trade_id: string;
  order_id: string;
  symbol: string;
  side: string;
  price: number;
  qty: number;
  realized_pnl: number;
  commission: number;
  commission_asset: string | null;
  filled_at: number;                          // UTC Unix ms
}

export interface RiskStateRecord {
  broker_mode: BrokerMode;
  consecutive_losses: number;
  cooldown_until: number;                     // UTC Unix ms
  cooldown_reason: string | null;
  session_net_pnl: number;
  session_started_at: number;                 // UTC Unix ms
  updated_at: number;                         // UTC Unix ms
}

export interface AuditLogRecord {
  id: string;
  event_type: string;
  actor: string;
  reason: string;
  payload_json: string | null;
  created_at: number;                         // UTC Unix ms
}

// ----------------------------------------------------------------------------
// Market & Quant Contracts
// ----------------------------------------------------------------------------

export interface AccountInfo {
  walletBalance: number;
  equity: number;
  availableBalance: number;
  unrealizedPnl: number;
  marginRatio?: number;
  currency: string;
}

export interface OpenOrderInfo {
  orderId: string;
  symbol: string;
  side: TradeSide;
  price: number;
  origQty: number;
  executedQty: number;
  type: string;
  isAlgo: boolean;
  clientOrderId?: string;
}

export interface KlineCandle {
  time: number;                               // Unix seconds timestamp for Lightweight Charts
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface TechnicalSummary {
  ema9: number | null;
  ema21: number | null;
  ema50: number | null;
  ema200: number | null;
  rsi14: number | null;
  atr14: number | null;
  macd: {
    macd: number;
    signal: number;
    histogram: number;
  } | null;
  bollingerBands: {
    upper: number;
    middle: number;
    lower: number;
  } | null;
  adx14: {
    adx: number;
    pdi: number;
    mdi: number;
  } | null;
  support: number | null;
  resistance: number | null;
  volumeSma20: number | null;
}

export interface CvdSnapshot {
  symbol: string;
  cvd: number;
  buyVolume: number;
  sellVolume: number;
  delta: number;
  openInterestUsd: number | null;
  timestamp: number;
}

export interface MentorBrief {
  mode: MentorMode;
  headlineAz: string;
  adviceAz: string;
  reasonsAz: string[];
  riskScore: number;                          // 0 - 100
}

export interface ScannerItem {
  symbol: string;
  lastPrice: number;
  priceChangePercent24h: number;
  quoteVolume24h: number;
  fundingRate: number;
}

export interface JournalSummary {
  trades: TradeRecord[];
  totalTrades: number;
  winRate: number;
  profitFactor: number;
  maxDrawdown: number;
  kellyCriterion: number;
}

export interface CockpitState {
  symbol: string;
  markPrice: number;
  fundingRate: number | null;
  nextFundingTime: number | null;
  account: AccountInfo;
  activePosition: TradeRecord | null;
  openOrders: OpenOrderInfo[];
  indicators: TechnicalSummary | null;
  cvd: CvdSnapshot | null;
  risk: RiskStateRecord;
  sokrat: MentorBrief | null;
  exchangeHealth: ExchangeHealth;
  brokerMode: BrokerMode;
}

// ----------------------------------------------------------------------------
// WebSocket Messages (/ws)
// ----------------------------------------------------------------------------

export type WsClientMessage =
  | { type: 'PING' }
  | { type: 'SUBSCRIBE_SYMBOL'; symbol: string };

export type WsServerMessage =
  | {
      type: 'SNAPSHOT';
      data: CockpitState;
    }
  | {
      type: 'TICK';
      data: {
        symbol: string;
        markPrice: number;
        candle: KlineCandle;
        cvd: number;
        unrealizedPnl: number;
      };
    }
  | {
      type: 'ANALYSIS';
      data: {
        indicators: TechnicalSummary | null;
        sokrat: MentorBrief | null;
        risk: RiskStateRecord;
      };
    }
  | {
      type: 'POSITION_EVENT';
      event: PositionEventType;
      data: {
        trade: TradeRecord;
        reason?: string;
      };
    }
  | {
      type: 'ALERT';
      level: AlertLevel;
      message: string;
    };
