/**
 * TradeOS v2 — Quantitative Engine & Risk Control Types
 * Shared domain contracts for volatility noise bands, economic calendar blackouts,
 * giveback trailing stops, and execution risk gates.
 */

import type { BrokerMode, TradeSide, TradeStatus } from './contracts.js';

export type ExitReason =
  | 'STOP_LOSS'
  | 'TAKE_PROFIT_1'
  | 'TAKE_PROFIT_2'
  | 'BREAKEVEN'
  | 'TRAILING_GIVEBACK_HALF'
  | 'OPPOSITE_CONFLUENCE_REVERSAL'
  | 'MANUAL_CLOSE'
  | 'EVENT_BLACKOUT_UNWIND';

export type BlockReason =
  | 'BLOCKED_NOISE_BAND'
  | 'BLOCKED_EVENT_BLACKOUT'
  | 'BLOCKED_SESSION_TRADE_CAP'
  | 'BLOCKED_DAILY_MAX_LOSS'
  | 'BLOCKED_MACRO_VETO'
  | 'BLOCKED_CHASING_TIMEOUT'
  | 'BLOCKED_AIRBAG_VIOLATION';

export type AutoPilotState =
  | 'IDLE'
  | 'EVALUATING'
  | 'PLACING_ORDER'
  | 'LIMIT_CHASING'
  | 'POSITION_OPEN'
  | 'CLOSING'
  | 'COOLDOWN_ACTIVE'
  | 'BLOCKED_SESSION_TRADE_CAP';

export interface TrailingStopState {
  enabled: boolean;
  active: boolean;
  peakPrice: number;
  peakMfe: number;
  activationMfeThreshold: number; // 2.0 * ATR
  givebackFloorPrice: number;
}

export interface NoiseBandSnapshot {
  hourOfDay: number;
  noiseThreshold: number;
  currentRange: number;
  isNoise: boolean;
  timestamp: number;
}

export interface EconomicEvent {
  id: string;
  name: string;
  timestamp: number;
  impact: 'HIGH' | 'CRITICAL';
  currency: string;
}

export type ExtendedTradeStatus =
  | 'OPEN'
  | 'PARTIALLY_CLOSED'
  | 'CLOSING_IN_PROGRESS'
  | 'CLOSING'
  | 'CLOSED';

export interface TradeRecord {
  id: string; // UUID v4
  symbol: string;
  broker_mode: BrokerMode;
  side: TradeSide;
  status: TradeStatus;
  entry_price: number;
  exit_price: number | null;
  quantity: number;
  remaining_qty: number;
  leverage: number;
  margin_usd: number;
  stop_loss: number | null;
  tp1: number | null;
  tp2: number | null;
  be_price: number | null;
  is_breakeven: number;
  peak_price?: number | null;
  peak_mfe?: number | null;
  trailing_stop_active?: number;
  client_order_id: string | null;
  client_sl_id: string | null;
  client_tp1_id: string | null;
  client_tp2_id: string | null;
  entry_order_id: string | null;
  sl_algo_id: string | null;
  tp1_algo_id: string | null;
  tp2_algo_id: string | null;
  realized_pnl: number;
  fees_usd: number;
  exit_reason: ExitReason | string | null;
  opened_at: number;
  closed_at: number | null;
}
