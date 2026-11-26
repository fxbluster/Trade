/**
 * TradeOS v2 — Shared Type Contracts & DTOs
 * Single source of truth for backend (apps/server) and frontend (apps/web).
 */

import type { BlockReason, AutoPilotState } from './types.js';

export type BrokerMode = 'BINANCE_DEMO' | 'LOCAL_PAPER';

export type TradeSide = 'BUY' | 'SELL';

export type OrderType = 'MARKET' | 'LIMIT';

export type TradeStatus = 'OPEN' | 'PARTIALLY_CLOSED' | 'CLOSING' | 'CLOSING_IN_PROGRESS' | 'CLOSED';

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
  blockReason?: BlockReason | null;
  eventBlackoutActive?: boolean;
  noiseBandActive?: boolean;
  noiseBand?: NoiseBandTelemetry;
  sizingBreakdown?: SizingBreakdown;
  chasingOrder?: ChasingOrderState;
  factorOutputs?: FactorOutput[];
  factorDetails?: FactorDetail[];
  telemetryEvent?: FactorTelemetryEvent;
}

export interface AutoPilotConfig {
  enabled: boolean;
  consensusThreshold: number; // default 4
  marginAllocationPct: number; // 2.5, 5, 10 (strictly capped at 10% in auto-pilot)
  leverage: number; // strict 10
  oppositeExitEnabled: boolean; // true
  circuitBreakerConsecutiveLosses: number; // 2
  circuitBreakerCooldownMs: number; // 3,600,000 (1 hour)
  maxDailyTrades?: number; // default 5 (configurable: 2, 3, 5, 10)
  dailyDrawdownLimitPct?: number; // default 2.0 (2% daily equity drawdown ceiling)
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
  timeInForce?: 'GTC' | 'IOC' | 'FOK' | 'GTX';
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

import type { TradeRecord } from './types.js';
export type { TradeRecord };

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
  factor_telemetry_json?: string | null;
  execution_chase_json?: string | null;
  sizing_breakdown_json?: string | null;
  noise_band_state?: number;
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
  total_trades?: number;
  successful_trades?: number;
  failed_trades?: number;
  win_rate?: number;
  gross_pnl_usd?: number;
  maker_fee_savings_usd?: number;
  net_pnl_usd?: number;
}

export interface DailyAuditResponse {
  summary: DailyAuditSummary;
  records: DecisionLogRecord[];
  sub_threshold_impulses?: PillarTelemetryRecord[];
  generated_at: number;
  date?: string;
  factor_telemetry_events?: FactorTelemetryEvent[];
  factor_attribution_summary?: FactorAttributionSummaryItem[];
  execution_chase_summary?: {
    totalFeeSavedUsd: number;
    totalChases: number;
    successfulChases: number;
  };
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
  maxDrawdownUsd: number;
  kellyCriterion: number;
}

export interface ExchangePositionSummary {
  symbol: string;
  positionAmt: number;
  entryPrice: number;
  markPrice: number;
  unRealizedProfit: number;
  leverage: number;
  tracked: boolean;
}

export interface CockpitState {
  symbol: string;
  markPrice: number;
  fundingRate: number | null;
  nextFundingTime: number | null;
  account: AccountInfo;
  activePosition: TradeRecord | null;
  activePositions?: TradeRecord[];
  exchangePositions?: ExchangePositionSummary[];
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
        state: AutoPilotState | string;
        config: AutoPilotConfig;
        openTradeId: string | null;
        message?: string;
        blockReason?: BlockReason | null;
        filledToday?: number;
        maxDailyTrades?: number;
        cooldownRemainingSec?: number;
        chasingOrder?: ChasingOrderState;
        sizingBreakdown?: SizingBreakdown;
      };
    }
  | {
      type: 'FACTOR_TELEMETRY';
      data: FactorTelemetryEvent;
    }
  | {
      type: 'PROPFIRM_STATUS';
      data: PropFirmStatusResponse;
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

// ----------------------------------------------------------------------------
// Next-Gen Modular Quantitative Architecture Contracts
// ----------------------------------------------------------------------------

export interface DepthLevel {
  price: number;
  qty: number;
}

export interface FactorOutput {
  factorId: string;
  bias: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
  rawAlpha: number; // Continuous in [-1.0, +1.0]
  confidence: number; // [0.0, 1.0]
  uncertainty: number; // Variance of factor estimate
  halfLifeMs: number; // Factor decay horizon
  metadata: Record<string, unknown>;
}

export interface FactorDetail {
  factorId: string;
  name: string;
  rawAlpha: number;
  orthogonalAlpha: number;
  posteriorWeight: number;
  bias: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
  confidence: number;
  isCollinear: boolean;
  informationRatio: number;
}

export interface FactorEvaluationContext {
  symbol: string;
  currentPrice: number;
  depth?: { bids: DepthLevel[]; asks: DepthLevel[] };
  cvd?: CvdSnapshot;
  candles: KlineCandle[];
  indicators?: TechnicalSummary;
  timestamp: number;
}

export type AlphaFactorCategory =
  | 'MICROSTRUCTURE'
  | 'STRUCTURE'
  | 'MOMENTUM'
  | 'ARBITRAGE'
  | 'VOLATILITY';

export interface AlphaFactorMetadata {
  id: string;
  name: string;
  category: AlphaFactorCategory;
  defaultWeight: number;
  currentWeight: number;
  hitRate: number;
  sharpeRatio: number;
  isDecayed: boolean;
}

export type ChasingStatus =
  | 'IDLE'
  | 'PENDING'
  | 'CHASING'
  | 'AMENDING'
  | 'FILLED'
  | 'CANCELLED'
  | 'TIMEOUT'
  | 'FAILED';

export interface ChasingOrderState {
  active: boolean;
  orderId: string | null;
  symbol: string;
  side: TradeSide;
  anchorPrice: number;
  currentLimitPrice: number;
  amendCount: number;
  startTime: number;
  timeoutMs: number;
  status: ChasingStatus;
  feeSavedUsd: number;
}

export type SizingArchetype =
  | 'Sub-Threshold'
  | 'Exploratory Probe'
  | 'Standard Institutional'
  | 'High-Conviction Core'
  | 'A+ Institutional Setup'
  | string;

export interface SizingBreakdown {
  confluenceScore: number;
  archetype: SizingArchetype;
  rawMarginPct: number;
  kellyDampener: number;
  volatilityParity: number;
  circuitMultiplier: number;
  finalMarginPct: number;
  marginUsd: number;
  notionalUsd: number;
  solvencyAirbagOk: boolean;
}

export interface NoiseBandTelemetry {
  active: boolean;
  currentTrueRange15m: number;
  meanTrueRange20d: number;
  noiseThreshold: number;
  isNoise: boolean;
  currentPrice: number;
  vwap: number;
  vwapDistancePct: number;
}

export type QuantConvictionArchetype =
  | 'SUB_THRESHOLD'
  | 'EXPLORATORY_PROBE'
  | 'STANDARD_INSTITUTIONAL'
  | 'HIGH_CONVICTION_CORE'
  | 'A_PLUS_INSTITUTIONAL';

export interface FactorStateDetail {
  factorId: string;
  name: string;
  bias: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
  rawAlpha: number;
  orthogonalAlpha: number;
  effectiveWeight: number;
  isCollinear: boolean;
  confidence: number;
  summaryText: string;
}

export interface ChasingTelemetrySnapshot {
  orderId?: string;
  status: 'PENDING' | 'AMENDING' | 'FILLED' | 'CANCELED' | 'ABORTED';
  anchorMarkPrice: number;
  currentLimitPrice: number;
  spreadPennyJumps: number;
  amendmentCount: number;
  durationMs: number;
  realizedFeeUsd: number;
  feeSavedVsTakerUsd: number;
}

export interface SizingTelemetrySnapshot {
  allocatedMarginUsd: number;
  allocatedMarginPct: number;
  baseConvictionMargin: number;
  quarterKellyMultiplier: number;
  volatilityParityMultiplier: number;
  circuitBreakerMultiplier: number;
  solvencyAirbagOk: boolean;
}

export type FactorTelemetryTriggerType =
  | 'SUB_THRESHOLD_IMPULSE'
  | 'SIGNAL_CONFIRMED'
  | 'ORDER_AMENDED'
  | 'POSITION_ENTERED'
  | 'POSITION_EXITED';

export interface FactorTelemetryEvent {
  id?: number;
  eventId?: string;
  timestamp: number;
  symbol: string;
  triggerType: FactorTelemetryTriggerType;
  markPrice: number;
  compositeScore: number;
  convictionArchetype: QuantConvictionArchetype;
  consensusSide: 'BUY' | 'SELL' | 'NEUTRAL';
  noiseBandActive: boolean;
  macroVetoActive: boolean;
  macroVetoReason?: string;
  activeFactors: FactorStateDetail[];
  collinearFactors: string[];
  chasingTelemetry?: ChasingTelemetrySnapshot;
  sizingTelemetry?: SizingTelemetrySnapshot;
}

export interface FactorAttributionSummaryItem {
  factorId: string;
  name: string;
  empiricalHitRate: number;
  informationRatio: number;
  informationCoefficient: number;
  effectiveWeight: number;
  sampleSize: number;
}

export type FactorTelemetryRecordStatus = 'EVALUATING' | 'SETTLED' | 'INCOMPLETE_FEED';

export interface FactorTelemetryDbRecord {
  id?: number;
  decision_log_id: string | null;
  event_id: string;
  trigger_type: FactorTelemetryTriggerType | string;
  timestamp: number;
  symbol: string;
  consensus_side: 'BUY' | 'SELL' | 'NEUTRAL';
  entry_price: number;
  composite_score: number;
  factor_id: string;
  raw_alpha: number;
  orthogonal_alpha: number;
  effective_weight: number;
  is_collinear: number;
  confidence: number;
  summary_text: string | null;
  telemetry_payload_json: string | null;
  status: FactorTelemetryRecordStatus;
  settle_timestamp: number | null;
  post_1m_mfe: number | null;
  post_1m_mae: number | null;
  post_5m_mfe: number | null;
  post_5m_mae: number | null;
  post_15m_mfe: number | null;
  post_15m_mae: number | null;
  post_1h_mfe: number | null;
  post_1h_mae: number | null;
}

// ----------------------------------------------------------------------------
// Upcomers $50,000 1-Step Thunderbolt Prop Firm Challenge Contracts
// ----------------------------------------------------------------------------

export interface UpcomersChallengeConfig {
  accountSizeUsd: number;
  profitTargetUsd: number;
  contractualDailyLossUsd: number;
  internalDailyHaltUsd: number;
  contractualTrailingLossUsd: number;
  internalTrailingHaltUsd: number;
  trailingLockHwmUsd: number;
  lockedTrailingFloorUsd: number;
  maxRiskPerTradeUsd: number;
  maxConcurrentPositions: number;
}

export const UPCOMERS_1STEP_50K_DEFAULT: UpcomersChallengeConfig = {
  accountSizeUsd: 50_000,
  profitTargetUsd: 2_500,
  contractualDailyLossUsd: 1_500,
  internalDailyHaltUsd: 1_250,
  contractualTrailingLossUsd: 3_000,
  internalTrailingHaltUsd: 2_500,
  trailingLockHwmUsd: 53_000,
  lockedTrailingFloorUsd: 50_000,
  maxRiskPerTradeUsd: 250,
  maxConcurrentPositions: 1,
} as const;

export type PropFirmCycleStatus =
  | 'ACTIVE'
  | 'PASSED'
  | 'FAILED_DAILY'
  | 'FAILED_TRAILING'
  | 'HALTED_DAILY_BUFFER'
  | 'HALTED_TRAILING_BUFFER';

export type PropFirmQuestionVerdict = 'YES_PROFIT' | 'NO_LOSS' | 'WAITING';

export interface PropFirmChallengeCycle {
  id: string;
  cycleNumber: number;
  status: PropFirmCycleStatus;
  startingBalanceUsd: number;
  currentEquityUsd: number;
  highWaterMarkUsd: number;
  contractualTrailingFloorUsd: number;
  internalTrailingFloorUsd: number;
  isFloorLocked: boolean;
  profitTargetUsd: number;
  netPnlUsd: number;
  realizedPnlUsd?: number;
  netPnlPct: number;
  maxDrawdownUsd: number;
  tradesCount: number;
  winCount: number;
  lossCount: number;
  startedAt: number;
  closedAt: number | null;
}

export interface PropFirmDailySnapshot {
  utcDate: string;
  cycleId: string;
  dayStartEquityUsd: number;
  currentEquityUsd: number;
  dailyPnlUsd: number;
  dailyMinEquityUsd: number;
  dailyHalted: boolean;
  updatedAt: number;
}

export interface PropFirmStatusResponse {
  cycle: PropFirmChallengeCycle;
  verdict: PropFirmQuestionVerdict;
  dailyBaselineEquityUsd: number;
  dailyPnlUsd: number;
  dailyLossUsedUsd: number;
  dailyBufferRemainingUsd: number;
  dailyBufferRemainingPct: number;
  trailingLossUsedUsd: number;
  trailingBufferRemainingUsd: number;
  trailingBufferRemainingPct: number;
  targetProgressPct: number;
  targetRemainingUsd: number;
  liveWalletBalanceUsd: number;
  needsTopUp: boolean;
  topUpMessage: string | null;
  consecutivePassedCycles: number;
  requiredPassedCycles: number;
  canTrade: boolean;
  haltReason: BlockReason | string | null;
  cycles: PropFirmChallengeCycle[];
  updatedAt: number;
}

export interface PropFirmCertificateResponse {
  certified: boolean;
  consecutivePassedCycles: number;
  requiredPassedCycles: number;
  remainingCycles: number;
  totalCompletedCycles: number;
  cycles: PropFirmChallengeCycle[];
  generatedAt: number;
}

export type {
  ExitReason,
  BlockReason,
  AutoPilotState,
  TrailingStopState,
  NoiseBandSnapshot,
  EconomicEvent,
  ExtendedTradeStatus,
} from './types.js';


