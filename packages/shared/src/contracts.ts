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

export type MacroRegime = 'MACRO_BULLISH' | 'MACRO_BEARISH' | 'MACRO_RANGING' | 'DEGRADED';

export interface FairValueGap {
  id: string;
  timeframe: string;
  type: 'BULLISH' | 'BEARISH';
  high: number;
  low: number;
  mitigated: boolean;
  formedAt: number;
}

export interface OrderBlock {
  id: string;
  timeframe: string;
  type: 'BULLISH' | 'BEARISH';
  high: number;
  low: number;
  invalidationPrice: number;
  volume: number;
}

export interface LiquiditySweep {
  id: string;
  direction: 'SWEEP_HIGH' | 'SWEEP_LOW';
  sweepPrice: number;
  reclaimPrice: number;
  time: number;
}

export type ConfluencePillarId =
  | 'MACRO_REGIME'
  | 'NATIVE_SMC'
  | 'CVD_ABSORPTION'
  | 'ORDER_FLOW_L2'
  | 'LIQ_CLUSTERS'
  | 'MOMENTUM_RVOL'
  | 'SENTIMENT_MACRO';

export type ConfluenceAction = 'STRONG_BUY' | 'BUY' | 'WAIT' | 'SELL' | 'STRONG_SELL' | 'GÖZLƏ';

export interface PillarEvaluation {
  id: ConfluencePillarId;
  title: string;
  score: number; // 0 to 100
  bias: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
  valueText: string;
  subText: string;
  confirmed: boolean; // meets pillar threshold
  updatedAt: number;
}

export interface ConfluenceSnapshot {
  symbol: string;
  pillars: PillarEvaluation[];
  bullishCount: number;
  bearishCount: number;
  neutralCount: number;
  consensusBias: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
  consensusMet: boolean; // confirmingCount >= threshold (default 4)
  threshold: number; // default 4
  compositeScore: number; // 0 - 100
  recommendedAction: 'STRONG_BUY' | 'BUY' | 'WAIT' | 'SELL' | 'STRONG_SELL' | 'GÖZLƏ';
  macroVetoActive: boolean;
  macroRegime: MacroRegime;
  activeFvgs: FairValueGap[];
  activeOrderBlocks: OrderBlock[];
  latestSweep: LiquiditySweep | null;
}

export interface AutoPilotConfig {
  enabled: boolean;
  consensusThreshold: number; // default 4
  marginAllocationPct: number; // 2.5, 5, 10 (strictly capped at 10% in auto-pilot)
  leverage: number; // strict 10
  oppositeExitEnabled: boolean; // true
  circuitBreakerConsecutiveLosses: number; // 2
  circuitBreakerCooldownMs: number; // 3,600,000 (1 hour)
}

export interface WebhookAlertPayload {
  secret: string;
  alert_id?: string;
  symbol: string;
  side: 'BUY' | 'SELL';
  entryPrice: number;
  stopLoss: number;
  tp1: number;
  tp2: number;
  time: number;
}

// ----------------------------------------------------------------------------
// REST API Request / Response DTOs
// ----------------------------------------------------------------------------

export interface OpenOrderRequest {
  symbol: string;
  side: TradeSide;
  orderType: OrderType;
  marginUsd: number;
  leverage: number;
  marginAllocationPct?: number; // e.g. 2.5, 5, 10, 25, 50
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
  bootTimeMs?: number;
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
// Decision Log & Shadow Tracking Contracts
// ----------------------------------------------------------------------------

export type ShadowSetupStatus =
  | 'OPEN'
  | 'SAVED_CAPITAL'
  | 'MISSED_PROFIT'
  | 'EXPIRED'
  | 'RESOLVED_AMBIGUOUS_VOLATILITY';

export type DecisionAction = 'EXECUTED' | 'BLOCKED' | 'FAILED';

export interface DecisionLogRecord {
  id: string;
  timestamp: number;
  symbol: string;
  side: TradeSide;
  action: DecisionAction;
  composite_score: number;
  pillars_json: string;
  macro_regime: MacroRegime;
  macro_veto_active: number;
  veto_reasons_json: string | null;
  execution_price: number;
  margin_usd: number;
  leverage: number;
  atr: number;
  trade_id: string | null;
  shadow_status: ShadowSetupStatus | null;
  shadow_sl: number | null;
  shadow_tp: number | null;
  shadow_pnl_usd: number | null;
  expires_at: number | null;
  shadow_closed_at: number | null;
  error_message: string | null;
  created_at: number;
}

export interface DailyAuditSummary {
  total_setups: number;
  executed_trades: number;
  blocked_setups: number;
  sub_threshold_impulses?: number;
  capital_saved_usd: number;
  missed_profit_usd: number;
  expired_pnl_usd: number;
  net_risk_value_usd: number;
  veto_breakdown: Record<string, number>;
}

export interface DailyAuditResponse {
  summary: DailyAuditSummary;
  records: DecisionLogRecord[];
  sub_threshold_impulses?: PillarTelemetryRecord[];
  generated_at: number;
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
    }
  | {
      type: 'CONFLUENCE_UPDATE';
      data: ConfluenceSnapshot;
    }
  | {
      type: 'AUTOPILOT_STATUS';
      data: {
        state: string;
        config: AutoPilotConfig;
        openTradeId: string | null;
      };
    };

// ----------------------------------------------------------------------------
// Bulldog Engine: Granular Pillar Attribution & Trajectory Contracts
// ----------------------------------------------------------------------------

export type TrajectoryHorizon = '1m' | '5m' | '15m' | '60m';

export type ImpulseTriggerType =
  | 'PILLAR_DIVERGENCE'
  | 'VOLATILITY_EXPANSION'
  | 'CONSENSUS_ATTEMPT';

export type TelemetryStatus = 'EVALUATING' | 'SETTLED' | 'EXPIRED';

export type TrajectoryOutcome =
  | 'BULLISH_EXPANSION'
  | 'BEARISH_EXPANSION'
  | 'ADVERSE_STOPOUT'
  | 'CHOP';

export type PillarAttributionStatus =
  | 'TRUE_POSITIVE'
  | 'FALSE_POSITIVE'
  | 'FALSE_NEGATIVE'
  | 'TRUE_NEGATIVE'
  | 'NEUTRAL';

export interface PillarSnapshotJson {
  state: string;
  bias: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
  score: number;
  confirmed: boolean;
  rawText: string;
}

export interface PillarTelemetryRecord {
  id?: number;
  timestamp: number;
  symbol: string;
  trigger_type: ImpulseTriggerType;
  mark_price: number;
  atr_14: number;
  composite_score: number;
  consensus_side: 'BUY' | 'SELL' | 'NEUTRAL';
  active_pillars_count: number;
  p1_vote: string;
  p2_vote: string;
  p3_vote: string;
  p4_vote: string;
  p5_vote: string;
  p6_vote: string;
  p7_vote: string;
  p1_macro_regime: string;
  p2_native_smc: string;
  p3_cvd_absorption: string;
  p4_order_flow_l2: string;
  p5_liq_clusters: string;
  p6_momentum_rvol: string;
  p7_sentiment_macro: string;
  status: TelemetryStatus;
}

export interface PillarHorizonEvaluation {
  id?: number;
  event_id: number;
  horizon: TrajectoryHorizon;
  settle_timestamp: number;
  settle_price: number;
  price_change_abs: number;
  price_change_pct: number;
  mfe_pct: number;
  mae_pct: number;
  directional_outcome: TrajectoryOutcome;
  p1_status: PillarAttributionStatus;
  p2_status: PillarAttributionStatus;
  p3_status: PillarAttributionStatus;
  p4_status: PillarAttributionStatus;
  p5_status: PillarAttributionStatus;
  p6_status: PillarAttributionStatus;
  p7_status: PillarAttributionStatus;
}

export interface PillarScorecardItem {
  pillarId: ConfluencePillarId;
  title: string;
  currentWeightPct: number;
  recommendedWeightPct: number;
  weightDeltaPct: number;
  totalActiveVotes: number;
  truePositives: number;
  falsePositives: number;
  falseNegatives: number;
  hitRatePct: number;
  avgMfePct: number;
  avgMaePct: number;
}

export interface PillarAttributionResponse {
  symbol: string;
  horizon: TrajectoryHorizon;
  sampleSize: number;
  generatedAt: number;
  scorecards: PillarScorecardItem[];
}

export interface PillarDailyScorecardRecord {
  date: string;
  symbol: string;
  horizon: TrajectoryHorizon;
  scorecards_json: string;
  sample_size: number;
  created_at: number;
}

export interface PnlHorizonStats {
  realizedPnl: number;
  unrealizedPnl: number;
  netPnl: number;
  commission: number;
  funding: number;
  tradeCount: number;
  winCount: number;
  lossCount: number;
  winRate: number;
}

export interface LivePositionStats {
  hasPosition: boolean;
  symbol?: string;
  side?: TradeSide;
  entryPrice?: number;
  markPrice?: number;
  unrealizedPnl?: number;
  roePercent?: number;
  marginUsd?: number;
  leverage?: number;
  isRiskFree?: boolean;
  stopLoss?: number;
  bePrice?: number;
}

export interface PnlSummaryResponse {
  live: LivePositionStats;
  today: PnlHorizonStats;
  threeDays: PnlHorizonStats;
  weekly: PnlHorizonStats;
  account: {
    equity: number;
    walletBalance: number;
    availableBalance: number;
    currency: string;
  };
  humanExplanation: string;
  timestamp: number;
}


