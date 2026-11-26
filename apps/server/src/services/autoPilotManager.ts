import crypto from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type {
  AutoPilotConfig,
  ConfluenceSnapshot,
  TradeRecord,
  WsServerMessage,
  TradeSide,
  TrailingStopState,
  BlockReason,
  SizingBreakdown,
  ChasingOrderState,
  AutoPilotState,
  FactorTelemetryEvent,
  FactorStateDetail,
  QuantConvictionArchetype,
  ChasingTelemetrySnapshot,
  SizingTelemetrySnapshot,
  MacroRegime,
} from '@tradeos/shared';
import { calculateLiquidationPrice } from '@tradeos/shared';
import { TradesRepo, SettingsRepo, ExecutionChaseLogsRepo } from '../db/sqlite.js';
import { TradeManager } from './tradeManager.js';
import {
  ExchangeDegradedError,
  type BrokerAdapter,
  type OrderExecutionResult,
} from '../exchange/broker.js';
import type { ConfluenceEngine } from '../quant/confluenceEngine.js';
import type { AdaptiveSizingEngine } from '../quant/adaptiveSizingEngine.js';
import type { PropFirmRiskGuard } from '../quant/propFirmRiskGuard.js';
import type { ChasingExecutionEngine, CheckFillResult } from './chasingExecutionEngine.js';
import type { TwapExecutionSlicer } from './twapExecutionSlicer.js';
import type { AlertNotifier } from './alertNotifier.js';

export type { AutoPilotState };

export interface SymbolQuantContextLike {
  symbol: string;
  confluenceEngine: ConfluenceEngine;
}

export interface AutoPilotOrderDispatchEvent {
  symbol: string;
  side: TradeSide;
  action: 'EXECUTED' | 'FAILED';
  price: number;
  marginUsd: number;
  leverage: number;
  atr: number;
  tradeId?: string;
  errorMessage?: string;
  compositeScore?: number;
  pillarsJson?: string;
  macroRegime?: MacroRegime;
  macroVetoActive?: boolean;
  vetoReasonsJson?: string;
  factorTelemetryJson?: string | null;
  executionChaseJson?: string | null;
  sizingBreakdownJson?: string | null;
  noiseBandState?: number | boolean;
}

export interface AutoPilotManagerOptions {
  db: DatabaseSync;
  tradeManager: TradeManager;
  broker: BrokerAdapter;
  confluenceEngine: ConfluenceEngine;
  getMarkPrice: (symbol: string) => number;
  getAtr?: (symbol: string) => number;
  broadcastWs?: (msg: WsServerMessage) => void;
  config?: Partial<AutoPilotConfig>;
  adaptiveSizingEngine?: AdaptiveSizingEngine;
  propFirmRiskGuard?: PropFirmRiskGuard;
  chasingExecutionEngine?: ChasingExecutionEngine;
  twapExecutionSlicer?: TwapExecutionSlicer;
  executionChaseLogsRepo?: ExecutionChaseLogsRepo;
  alertNotifier?: AlertNotifier;
  onOrderDispatched?: (event: AutoPilotOrderDispatchEvent) => void;
  onTelemetryEvent?: (event: FactorTelemetryEvent) => void;
  onStateTransition?: (newState: AutoPilotState | string) => void;
  getSymbolQuantContext?: (symbol: string) => SymbolQuantContextLike | undefined;
  forEachQuantContext?: (cb: (ctx: SymbolQuantContextLike) => void) => void;
  watchlistSymbols?: string[];
}

/**
 * AutoPilotManager — Autonomous Algorithmic State Machine
 *
 * Enforces:
 * - Synchronous PLACING_ORDER mutex to prevent 4Hz tick race conditions.
 * - Multi-pillar consensus confirmation (>= 4 of 7 confirming pillars, compositeScore >= 65).
 * - Marketable IOC limit execution with 0.10% slippage ceiling.
 * - Strict 10% maximum margin allocation and 10x leverage.
 * - Dynamic Breakeven migration at Math.max(1.5 * ATR, 0.25% profit).
 * - Opposite-confluence emergency early exit (persisting for >= 2 consecutive ticks).
 * - 180s mandatory re-entry symbol lockout.
 * - 60-minute consecutive loss circuit-breaker persisted in SQLite settings.
 */
export class AutoPilotManager {
  private db: DatabaseSync;
  private tradeManager: TradeManager;
  private broker: BrokerAdapter;
  private confluenceEngine: ConfluenceEngine;
  private getMarkPriceFn: (symbol: string) => number;
  private getAtrFn?: (symbol: string) => number;
  private broadcastWsFn?: (msg: WsServerMessage) => void;
  private onOrderDispatched?: (event: AutoPilotOrderDispatchEvent) => void;
  private onTelemetryEvent?: (event: FactorTelemetryEvent) => void;
  private onStateTransition?: (newState: AutoPilotState | string) => void;
  private getSymbolQuantContextFn?: (symbol: string) => SymbolQuantContextLike | undefined;
  private forEachQuantContextFn?: (cb: (ctx: SymbolQuantContextLike) => void) => void;
  private watchlistSymbols?: string[];

  private tradesRepo: TradesRepo;
  private settingsRepo: SettingsRepo;
  public readonly executionChaseLogsRepo: ExecutionChaseLogsRepo;
  public readonly adaptiveSizingEngine?: AdaptiveSizingEngine;
  public readonly propFirmRiskGuard?: PropFirmRiskGuard;
  public readonly chasingExecutionEngine?: ChasingExecutionEngine;
  public readonly twapExecutionSlicer?: TwapExecutionSlicer;
  private alertNotifier?: AlertNotifier;
  private latestSizingBreakdown: SizingBreakdown | null = null;
  private latestChasingState: ChasingOrderState | null = null;
  private activeEntryContext: {
    symbol: string;
    side: TradeSide;
    markPrice: number;
    notionalUsd: number;
    snapshot: ConfluenceSnapshot | null;
    sizing: SizingTelemetrySnapshot;
  } | null = null;
  private lastEmittedChaseKey: string | null = null;

  private state: AutoPilotState = 'IDLE';
  private blockReason: BlockReason | null = null;
  private statusMessage: string | null = null;
  private filledToday: number = 0;
  private cachedBalance: number = 0;

  private config: AutoPilotConfig = {
    enabled: false,
    consensusThreshold: 4,
    marginAllocationPct: 10, // Clamped strictly to <= 10%
    leverage: 10, // Strict 10x
    oppositeExitEnabled: true,
    circuitBreakerConsecutiveLosses: 2,
    circuitBreakerCooldownMs: 60 * 60 * 1000, // 60 minutes
    maxDailyTrades: 5, // Default 5
    dailyDrawdownLimitPct: 2.0, // Default 2.0%
  };

  private openTradeId: string | null = null;
  private activeSymbol: string = 'SOLUSDT';
  private lastExitTime: number = 0;
  private consecutiveLosses: number = 0;
  private cooldownUntil: number = 0;
  private oppositeConsensusTickCount: number = 0;
  private peakPriceByTrade: Map<string, number> = new Map();
  private recordedClosedTradeIds: Set<string> = new Set();
  private isManagingPosition: boolean = false;
  private cycleStartedAtMs: number = 0;

  constructor(options: AutoPilotManagerOptions) {
    this.db = options.db;
    this.tradeManager = options.tradeManager;
    this.broker = options.broker;
    this.confluenceEngine = options.confluenceEngine;
    this.getMarkPriceFn = options.getMarkPrice;
    this.getAtrFn = options.getAtr;
    this.broadcastWsFn = options.broadcastWs;
    this.onOrderDispatched = options.onOrderDispatched;
    this.onTelemetryEvent = options.onTelemetryEvent;
    this.onStateTransition = options.onStateTransition;
    this.getSymbolQuantContextFn = options.getSymbolQuantContext;
    this.forEachQuantContextFn = options.forEachQuantContext;
    this.watchlistSymbols = options.watchlistSymbols ? [...options.watchlistSymbols] : undefined;
    this.adaptiveSizingEngine = options.adaptiveSizingEngine;
    this.propFirmRiskGuard = options.propFirmRiskGuard;
    this.chasingExecutionEngine = options.chasingExecutionEngine;
    this.twapExecutionSlicer = options.twapExecutionSlicer;
    this.alertNotifier = options.alertNotifier;
    this.executionChaseLogsRepo =
      options.executionChaseLogsRepo || new ExecutionChaseLogsRepo(this.db);

    this.tradesRepo = new TradesRepo(this.db);
    this.settingsRepo = new SettingsRepo(this.db);

    if (this.chasingExecutionEngine) {
      this.chasingExecutionEngine.setOnStateUpdate((chaseState) => {
        this.latestChasingState = chaseState;
        this.broadcastStatus();

        if (chaseState.status !== 'FILLED') {
          const isRedundantPostAmend =
            chaseState.status === 'CHASING' &&
            chaseState.amendCount > 0 &&
            this.lastEmittedChaseKey === `${chaseState.orderId ?? ''}:${chaseState.amendCount}`;
          if (isRedundantPostAmend) {
            return;
          }
          if (chaseState.status === 'AMENDING') {
            this.lastEmittedChaseKey = `${chaseState.orderId ?? ''}:${chaseState.amendCount}`;
          }

          const ctx = this.activeEntryContext;
          const notionalUsd = ctx?.notionalUsd ?? 0;
          const chasingTelemetry = this.buildChasingTelemetry(chaseState, notionalUsd);
          const snap =
            ctx?.snapshot ??
            this.getConfluenceForSymbol(chaseState.symbol).getSnapshot(chaseState.symbol);
          const ev = this.buildTelemetryEvent(
            'ORDER_AMENDED',
            chaseState.symbol,
            chaseState.anchorPrice || ctx?.markPrice || this.getMarkPriceFn(chaseState.symbol),
            chaseState.side,
            snap,
            {
              chasingTelemetry,
              sizingTelemetry: ctx?.sizing,
            }
          );
          this.emitTelemetry(ev);
        }
      });
    }

    // Restore persisted Auto-Pilot config (including enabled state & margin cap) from SQLite
    const persistedConfig = this.settingsRepo.get<AutoPilotConfig>('autopilot_config');
    if (persistedConfig) {
      this.config = { ...this.config, ...persistedConfig };
      this.confluenceEngine.setConsensusThreshold(this.config.consensusThreshold);
      this.forEachQuantContextFn?.((ctx) =>
        ctx.confluenceEngine.setConsensusThreshold(this.config.consensusThreshold)
      );
    }

    if (options.config) {
      this.updateConfig(options.config);
    }

    // Pre-warm cached balance from broker
    this.broker.getAccount().then((acc) => {
      if (acc && acc.walletBalance > 0) this.cachedBalance = acc.walletBalance;
    }).catch(() => {});

    // Restore persisted 60-minute cooldown from SQLite settings if active
    const persistedCooldown = this.settingsRepo.get<{ until: number }>('autopilot_cooldown_until');
    if (persistedCooldown && persistedCooldown.until > Date.now()) {
      this.cooldownUntil = persistedCooldown.until;
      this.state = 'COOLDOWN_ACTIVE';
    }
  }

  public getState(): AutoPilotState {
    this.evaluateCooldownExpiry();
    return this.state;
  }

  public getConfig(): AutoPilotConfig {
    return { ...this.config };
  }

  public getOpenTradeId(): string | null {
    return this.openTradeId;
  }

  public getStatusPayload() {
    const cooldownRemainingSec =
      this.cooldownUntil > Date.now()
        ? Math.ceil((this.cooldownUntil - Date.now()) / 1000)
        : 0;
    return {
      state: this.getState(),
      config: this.getConfig(),
      openTradeId: this.openTradeId,
      filledToday: this.filledToday,
      maxDailyTrades: this.config.maxDailyTrades,
      cooldownRemainingSec,
      blockReason: this.blockReason,
      message: this.statusMessage ?? undefined,
      ...(this.watchlistSymbols ? { watchlistSymbols: this.watchlistSymbols } : {}),
    };
  }

  private getConfluenceForSymbol(symbol: string): ConfluenceEngine {
    return this.getSymbolQuantContextFn?.(symbol)?.confluenceEngine ?? this.confluenceEngine;
  }

  private getGlobalFilledTradeCountToday(brokerMode: string, startOfDayMs: number): number {
    const stmt = this.db.prepare(`
      SELECT COUNT(*) as count FROM trades
      WHERE broker_mode = ? AND opened_at >= ?
    `);
    const row = stmt.get(brokerMode, startOfDayMs) as { count: number } | undefined;
    return row?.count ?? 0;
  }

  public updateConfig(partial: Partial<AutoPilotConfig>): void {
    if (partial.enabled !== undefined) this.config.enabled = partial.enabled;
    if (partial.consensusThreshold !== undefined) {
      this.config.consensusThreshold =
        partial.consensusThreshold >= 20
          ? Math.max(50, Math.min(95, partial.consensusThreshold))
          : Math.max(1, Math.min(7, partial.consensusThreshold));
      this.confluenceEngine.setConsensusThreshold(this.config.consensusThreshold);
      this.forEachQuantContextFn?.((ctx) =>
        ctx.confluenceEngine.setConsensusThreshold(this.config.consensusThreshold)
      );
    }
    if (partial.marginAllocationPct !== undefined) {
      // Auto-Pilot is strictly clamped to max 10.0% margin
      this.config.marginAllocationPct = Math.min(10.0, Math.max(1.0, partial.marginAllocationPct));
    }
    if (partial.leverage !== undefined) {
      this.config.leverage = Math.max(1, Math.min(10, partial.leverage));
    }
    if (partial.oppositeExitEnabled !== undefined) {
      this.config.oppositeExitEnabled = partial.oppositeExitEnabled;
    }
    if (partial.circuitBreakerConsecutiveLosses !== undefined) {
      this.config.circuitBreakerConsecutiveLosses = partial.circuitBreakerConsecutiveLosses;
    }
    if (partial.circuitBreakerCooldownMs !== undefined) {
      this.config.circuitBreakerCooldownMs = partial.circuitBreakerCooldownMs;
    }
    if (partial.maxDailyTrades !== undefined) {
      this.config.maxDailyTrades = Math.max(1, Math.min(50, partial.maxDailyTrades));
    }
    if (partial.dailyDrawdownLimitPct !== undefined) {
      this.config.dailyDrawdownLimitPct = Math.max(0.5, Math.min(10.0, partial.dailyDrawdownLimitPct));
    }

    try {
      this.settingsRepo.set('autopilot_config', this.config);
    } catch {}

    this.broadcastStatus();
  }

  public setEnabled(enabled: boolean): void {
    const prevState = this.state;
    this.config.enabled = enabled;
    if (!enabled && this.state === 'COOLDOWN_ACTIVE') {
      // Keep cooldown state intact
    } else if (!enabled && this.state !== 'POSITION_OPEN') {
      this.state = 'IDLE';
    }

    try {
      this.settingsRepo.set('autopilot_config', this.config);
    } catch {}

    this.broadcastStatus();
    if (prevState !== this.state) {
      this.emitStateTransition(this.state);
    }
  }

  public setActiveSymbol(symbol: string): void {
    this.activeSymbol = symbol.toUpperCase().trim();
  }

  public setAlertNotifier(notifier: AlertNotifier): void {
    this.alertNotifier = notifier;
  }

  public setBroker(broker: BrokerAdapter): void {
    this.broker = broker;
    this.chasingExecutionEngine?.setBroker?.(broker);
    this.cachedBalance = 0;
    this.broker
      .getAccount()
      .then((acc) => {
        if (acc && acc.walletBalance > 0) {
          this.cachedBalance = acc.walletBalance;
        }
      })
      .catch(() => {});
  }

  public isCooldownActive(): boolean {
    this.evaluateCooldownExpiry();
    return this.cooldownUntil > Date.now();
  }

  public resetCooldown(): void {
    this.cooldownUntil = 0;
    this.consecutiveLosses = 0;
    this.settingsRepo.delete('autopilot_cooldown_until');
    const prevState = this.state;
    if (this.state === 'COOLDOWN_ACTIVE') {
      this.state = 'IDLE';
      this.blockReason = null;
      this.statusMessage = null;
    }
    this.broadcastStatus();
    if (prevState !== this.state) {
      this.emitStateTransition(this.state);
    }
  }

  public clearPropFirmBlock(): void {
    const prevState = this.state;
    this.blockReason = null;
    this.statusMessage = null;
    this.cooldownUntil = 0;
    try {
      this.settingsRepo.set('autopilot_cooldown_until', { until: 0 });
    } catch {}
    this.consecutiveLosses = 0;
    this.lastExitTime = 0;
    this.cycleStartedAtMs = Date.now();
    if (this.state === 'COOLDOWN_ACTIVE' || this.state === 'BLOCKED_SESSION_TRADE_CAP') {
      this.state = 'IDLE';
    }
    this.broadcastStatus();
    if (prevState !== this.state) {
      this.emitStateTransition(this.state);
    }
  }

  public getCooldownRemainingSec(): number {
    const diff = this.cooldownUntil - Date.now();
    return diff > 0 ? Math.ceil(diff / 1000) : 0;
  }

  public getTrailingStopState(symbol: string): TrailingStopState | null {
    const sym = symbol.toUpperCase().trim();
    const active = this.tradesRepo.getActivePosition(this.broker.mode, sym);
    if (!active) return null;
    const atr = this.getAtrFn ? this.getAtrFn(sym) : active.entry_price * 0.005;
    const peakPrice = active.peak_price ?? active.entry_price;
    const peakMfe = active.peak_mfe ?? 0;
    const activeFlag = active.trailing_stop_active === 1;
    const floor =
      active.side === 'BUY'
        ? peakPrice - 0.5 * peakMfe
        : peakPrice + 0.5 * peakMfe;

    return {
      enabled: true,
      active: activeFlag,
      peakPrice,
      peakMfe,
      activationMfeThreshold: 2.0 * atr,
      givebackFloorPrice: Number(floor.toFixed(2)),
    };
  }

  private evaluateCooldownExpiry(): void {
    if (this.cooldownUntil > 0 && Date.now() >= this.cooldownUntil) {
      this.cooldownUntil = 0;
      this.consecutiveLosses = 0;
      this.settingsRepo.set('autopilot_cooldown_until', { until: 0 });
      if (this.state === 'COOLDOWN_ACTIVE') {
        this.state = 'IDLE';
        this.broadcastStatus();
        this.emitStateTransition('IDLE');
      }
    }
  }

  private emitStateTransition(newState: AutoPilotState): void {
    try {
      this.onStateTransition?.(newState);
    } catch {
      // Tolerated listener failure
    }
  }

  private emitTelemetry(event: FactorTelemetryEvent): void {
    try {
      this.onTelemetryEvent?.(event);
    } catch {
      // Tolerated listener failure
    }
  }

  private mapConvictionArchetype(score: number): QuantConvictionArchetype {
    if (score >= 95) return 'A_PLUS_INSTITUTIONAL';
    if (score >= 85) return 'HIGH_CONVICTION_CORE';
    if (score >= 75) return 'STANDARD_INSTITUTIONAL';
    if (score >= 70) return 'EXPLORATORY_PROBE';
    return 'SUB_THRESHOLD';
  }

  private mapChasingStatus(status: ChasingOrderState['status']): ChasingTelemetrySnapshot['status'] {
    switch (status) {
      case 'FILLED':
        return 'FILLED';
      case 'CANCELLED':
        return 'CANCELED';
      case 'TIMEOUT':
      case 'FAILED':
        return 'ABORTED';
      case 'CHASING':
      case 'AMENDING':
        return 'AMENDING';
      default:
        return 'PENDING';
    }
  }

  private buildChasingTelemetry(
    chaseState: ChasingOrderState,
    notionalUsd: number,
    overrides: Partial<ChasingTelemetrySnapshot> = {}
  ): ChasingTelemetrySnapshot {
    const tickSize = this.chasingExecutionEngine?.getTickSize?.() ?? 0.01;
    const spreadPennyJumps =
      tickSize > 0
        ? Math.max(0, Math.round(Math.abs(chaseState.currentLimitPrice - chaseState.anchorPrice) / tickSize))
        : 0;
    const defaultFee = Number((notionalUsd * 0.0002).toFixed(4));
    const defaultSaved = Number((notionalUsd * 0.0003).toFixed(4));

    return {
      orderId: chaseState.orderId ?? undefined,
      status: this.mapChasingStatus(chaseState.status),
      anchorMarkPrice: chaseState.anchorPrice,
      currentLimitPrice: chaseState.currentLimitPrice,
      spreadPennyJumps,
      amendmentCount: chaseState.amendCount,
      durationMs: Math.max(0, Date.now() - chaseState.startTime),
      realizedFeeUsd: defaultFee,
      feeSavedVsTakerUsd: chaseState.feeSavedUsd > 0 ? chaseState.feeSavedUsd : defaultSaved,
      ...overrides,
    };
  }

  private buildSizingTelemetry(
    sizing: SizingBreakdown | null,
    marginUsd: number,
    marginAllocationPct: number
  ): SizingTelemetrySnapshot {
    if (sizing) {
      return {
        allocatedMarginUsd: sizing.marginUsd,
        allocatedMarginPct: Number((sizing.finalMarginPct * 100).toFixed(2)),
        baseConvictionMargin: sizing.rawMarginPct,
        quarterKellyMultiplier: sizing.kellyDampener,
        volatilityParityMultiplier: sizing.volatilityParity,
        circuitBreakerMultiplier: sizing.circuitMultiplier,
        solvencyAirbagOk: sizing.solvencyAirbagOk,
      };
    }
    return {
      allocatedMarginUsd: marginUsd,
      allocatedMarginPct: Number(marginAllocationPct.toFixed(2)),
      baseConvictionMargin: Number((marginAllocationPct / 100).toFixed(4)),
      quarterKellyMultiplier: 1,
      volatilityParityMultiplier: 1,
      circuitBreakerMultiplier: 1,
      solvencyAirbagOk: true,
    };
  }

  private buildTelemetryEvent(
    triggerType: FactorTelemetryEvent['triggerType'],
    symbol: string,
    markPrice: number,
    side: TradeSide | 'NEUTRAL',
    snapshot: ConfluenceSnapshot | null | undefined,
    extra: {
      chasingTelemetry?: ChasingTelemetrySnapshot;
      sizingTelemetry?: SizingTelemetrySnapshot;
    } = {}
  ): FactorTelemetryEvent {
    const base = snapshot?.telemetryEvent;
    const compositeScore = base?.compositeScore ?? snapshot?.compositeScore ?? 75;
    const activeFactors: FactorStateDetail[] = base?.activeFactors
      ? base.activeFactors.map((f) => ({ ...f }))
      : (snapshot?.factorDetails ?? [])
          .filter((d) => !d.isCollinear)
          .map((d) => ({
            factorId: d.factorId,
            name: d.name,
            bias: d.bias,
            rawAlpha: d.rawAlpha,
            orthogonalAlpha: d.orthogonalAlpha,
            effectiveWeight: d.posteriorWeight,
            isCollinear: false,
            confidence: d.confidence,
            summaryText: `${d.bias} α=${d.orthogonalAlpha.toFixed(2)}`,
          }));
    const collinearFactors: string[] = base?.collinearFactors
      ? [...base.collinearFactors]
      : (snapshot?.factorDetails ?? []).filter((d) => d.isCollinear).map((d) => d.name);

    return {
      timestamp: Date.now(),
      symbol: symbol.toUpperCase(),
      triggerType,
      markPrice,
      compositeScore,
      convictionArchetype: base?.convictionArchetype ?? this.mapConvictionArchetype(compositeScore),
      consensusSide: side,
      noiseBandActive: Boolean(base?.noiseBandActive ?? snapshot?.noiseBandActive ?? snapshot?.noiseBand?.active),
      macroVetoActive: Boolean(base?.macroVetoActive ?? snapshot?.macroVetoActive),
      ...(base?.macroVetoReason ? { macroVetoReason: base.macroVetoReason } : {}),
      activeFactors,
      collinearFactors,
      ...(extra.chasingTelemetry ? { chasingTelemetry: extra.chasingTelemetry } : {}),
      ...(extra.sizingTelemetry ? { sizingTelemetry: extra.sizingTelemetry } : {}),
    };
  }

  private broadcastStatus(): void {
    if (!this.broadcastWsFn) return;
    try {
      this.broadcastWsFn({
        type: 'AUTOPILOT_STATUS' as any,
        data: {
          state: this.state,
          config: this.getConfig(),
          openTradeId: this.openTradeId,
          cooldownRemainingSec: this.getCooldownRemainingSec(),
          blockReason: this.blockReason,
          message: this.statusMessage ?? undefined,
          filledToday: this.filledToday,
          maxDailyTrades: this.config.maxDailyTrades ?? 5,
          chasingOrder: this.latestChasingState ?? undefined,
          sizingBreakdown: this.latestSizingBreakdown ?? undefined,
        },
      } as any);
    } catch {
      // Tolerated
    }
  }

  /**
   * Main evaluation loop called on every price tick (<= 4Hz).
   * Synchronously filters calls via state latch to prevent tick concurrency races.
   */
  public async onTick(symbol: string, markPrice: number): Promise<void> {
    const sym = symbol.toUpperCase().trim();
    this.evaluateCooldownExpiry();

    if (!this.config.enabled) return;
    if (this.isCooldownActive()) return;
    if (this.state === 'CLOSING') return;

    // Cross-symbol guard: ignore ticks for other symbols while a position is open or LIMIT_CHASING
    if (this.openTradeId) {
      const openTrade = this.tradesRepo.getById(this.openTradeId);
      if (openTrade && openTrade.symbol !== sym) {
        return;
      }
    } else if (this.state !== 'IDLE') {
      if (this.activeEntryContext && this.activeEntryContext.symbol !== sym) {
        return;
      }
    }

    // Position Management Branch: when position is open or while in LIMIT_CHASING
    if (this.openTradeId) {
      if (this.isManagingPosition) return;
      this.isManagingPosition = true;
      try {
        await this.manageOpenPosition(sym, markPrice);
      } finally {
        this.isManagingPosition = false;
      }
      if (this.state === 'POSITION_OPEN' || (this.state as AutoPilotState) === 'CLOSING') {
        return;
      }
    }

    // Check if an active position already exists in SQLite for this symbol
    const existing = this.tradesRepo.getActivePosition(this.broker.mode, sym);
    if (existing) {
      this.openTradeId = existing.id;
      if (this.state !== 'LIMIT_CHASING') {
        this.state = 'POSITION_OPEN';
      }
      if (this.isManagingPosition) return;
      this.isManagingPosition = true;
      try {
        await this.manageOpenPosition(sym, markPrice);
      } finally {
        this.isManagingPosition = false;
      }
      return;
    }

    // Synchronous state latch: only evaluate entries when strictly IDLE or recovering from cap block
    if (this.state !== 'IDLE' && this.state !== 'BLOCKED_SESSION_TRADE_CAP') {
      return;
    }

    // Global 1-position guard across all symbols
    const anyActive = this.tradesRepo.getActivePosition(this.broker.mode);
    if (anyActive) {
      return;
    }

    // Re-entry lockout check (180s mandatory cooldown after position exit)
    if (Date.now() - this.lastExitTime < 180_000) {
      return;
    }

    // 0. Upcomers Prop Firm Challenge Risk Guard Pre-Entry Gate (BINANCE_DEMO only)
    if (this.propFirmRiskGuard && this.broker.mode === 'BINANCE_DEMO') {
      const guardCheck = this.propFirmRiskGuard.canOpenTrade();
      if (!guardCheck.allowed) {
        const nextBlockReason: BlockReason =
          guardCheck.reason === 'UPCOMERS_DAILY_HALT' ||
          guardCheck.reason === 'UPCOMERS_TRAILING_HALT' ||
          guardCheck.reason === 'CYCLE_TERMINAL'
            ? guardCheck.reason
            : 'BLOCKED_DAILY_MAX_LOSS';
        const nextMsg =
          guardCheck.details ??
          `Upcomers Risk Guard blocked entry (${guardCheck.reason ?? 'HALTED'})`;
        if (this.blockReason !== nextBlockReason || this.statusMessage !== nextMsg) {
          this.blockReason = nextBlockReason;
          this.statusMessage = nextMsg;
          this.broadcastStatus();
        }
        return;
      } else if (
        this.blockReason === 'UPCOMERS_DAILY_HALT' ||
        this.blockReason === 'UPCOMERS_TRAILING_HALT' ||
        this.blockReason === 'CYCLE_TERMINAL'
      ) {
        this.clearPropFirmBlock();
      }
    }

    const nowUtc = new Date();
    const startOfUtcDay = Date.UTC(nowUtc.getUTCFullYear(), nowUtc.getUTCMonth(), nowUtc.getUTCDate());
    const tradeCountStartMs = this.propFirmRiskGuard
      ? Math.max(startOfUtcDay, this.cycleStartedAtMs)
      : startOfUtcDay;

    // 1. Session Trade Cap: Max N filled round-trip trades per calendar day (UTC) across all symbols [CUJ 4 / DEF-12]
    const maxTrades = this.config.maxDailyTrades ?? 5;
    this.filledToday = this.getGlobalFilledTradeCountToday(this.broker.mode, tradeCountStartMs);
    if (this.filledToday >= maxTrades) {
      if (this.state !== 'BLOCKED_SESSION_TRADE_CAP') {
        this.state = 'BLOCKED_SESSION_TRADE_CAP';
        this.blockReason = 'BLOCKED_SESSION_TRADE_CAP';
        this.statusMessage = `Session Cap Reached (${this.filledToday}/${maxTrades} trades) - Halted`;
        this.broadcastStatus();
      }
      return;
    } else if (this.state === 'BLOCKED_SESSION_TRADE_CAP') {
      this.state = 'IDLE';
      this.blockReason = null;
      this.statusMessage = null;
      this.broadcastStatus();
    }

    // 2. Proactive Daily Mark-to-Market Drawdown Ceiling (Synchronous Pre-Check) [CUJ 5 / DEF-13]
    // Skipped when PropFirmRiskGuard is active in BINANCE_DEMO (Upcomers -$1,250 / -$2,500 buffers govern drawdown).
    if (!(this.propFirmRiskGuard && this.broker.mode === 'BINANCE_DEMO')) {
      const dailyStats = this.tradesRepo.getDailyRealizedPnl(this.broker.mode, startOfUtcDay);
      const balance = this.cachedBalance > 0 ? this.cachedBalance : 1000;
      const drawdownLimitPct = (this.config.dailyDrawdownLimitPct ?? 2.0) / 100;
      const maxDrawdownUsd = balance * drawdownLimitPct;

      if (balance > 0 && maxDrawdownUsd > 0 && dailyStats.netPnl <= -maxDrawdownUsd) {
        const tomorrowUtc = Date.UTC(nowUtc.getUTCFullYear(), nowUtc.getUTCMonth(), nowUtc.getUTCDate() + 1);
        if (this.cooldownUntil < tomorrowUtc) {
          this.cooldownUntil = tomorrowUtc;
          this.settingsRepo.set('autopilot_cooldown_until', { until: this.cooldownUntil });
        }
        this.state = 'COOLDOWN_ACTIVE';
        this.blockReason = 'BLOCKED_DAILY_MAX_LOSS';
        this.statusMessage = `Daily Drawdown Limit (-${(drawdownLimitPct * 100).toFixed(1)}%) Reached ($${Math.abs(dailyStats.netPnl).toFixed(2)} loss >= $${maxDrawdownUsd.toFixed(2)} limit) - Cooldown Active`;
        this.broadcastStatus();
        return;
      }
    }

    // Evaluate Confluence Consensus
    const snapshot = this.getConfluenceForSymbol(sym).getSnapshot(sym);
    if (!snapshot || !snapshot.consensusMet || snapshot.blockReason) {
      return;
    }

    let side: TradeSide | null = null;
    if (snapshot.recommendedAction === 'BUY' || snapshot.recommendedAction === 'STRONG_BUY') {
      side = 'BUY';
    } else if (snapshot.recommendedAction === 'SELL' || snapshot.recommendedAction === 'STRONG_SELL') {
      side = 'SELL';
    }

    if (!side) return;

    // SYNCHRONOUS MUTEX LATCH: Immediately lock state to prevent 4Hz tick race conditions
    this.state = 'PLACING_ORDER';
    this.broadcastStatus();

    try {
      await this.executeAutoEntry(sym, side, markPrice);
    } catch (err) {
      this.state = 'IDLE';
      this.openTradeId = null;
      this.broadcastStatus();
    }
  }

  /**
   * Executes algorithmic bracket entry with IOC marketable limit pricing or Maker Limit Chasing.
   */
  private async executeAutoEntry(symbol: string, side: TradeSide, markPrice: number): Promise<void> {
    const leverage = this.config.leverage || 10;
    const atr = this.getAtrFn ? this.getAtrFn(symbol) : markPrice * 0.005;
    const limitPrice = Number(
      (side === 'BUY' ? markPrice * 1.0010 : markPrice * 0.9990).toFixed(2)
    );
    let marginUsd = 0;
    let marginAllocationPct = this.config.marginAllocationPct;

    try {
      // Global 1-position guard (without symbol filter) before chasing / opening
      const globalActive = this.tradesRepo.getActivePosition(this.broker.mode);
      if (globalActive) {
        this.state = 'IDLE';
        this.broadcastStatus();
        this.onOrderDispatched?.({
          symbol,
          side,
          action: 'FAILED',
          price: markPrice,
          marginUsd: 0,
          leverage,
          atr,
          errorMessage: `ERR_POSITION_EXISTS: Active position already open on ${globalActive.symbol}`,
        });
        return;
      }

      const account = await this.broker.getAccount();
      const balance = account.walletBalance;
      this.cachedBalance = balance;

      if (balance <= 0) {
        this.state = 'IDLE';
        this.onOrderDispatched?.({
          symbol,
          side,
          action: 'FAILED',
          price: limitPrice,
          marginUsd: 0,
          leverage,
          atr,
          errorMessage: 'Insufficient balance: walletBalance <= 0',
        });
        return;
      }

      // Daily Mark-to-Market Drawdown Ceiling: Hard halt if session net loss >= dailyDrawdownLimitPct of wallet equity [CUJ 5 / DEF-13]
      // Skipped when PropFirmRiskGuard is active in BINANCE_DEMO (Upcomers -$1,250 / -$2,500 buffers govern drawdown).
      if (!(this.propFirmRiskGuard && this.broker.mode === 'BINANCE_DEMO')) {
        const nowUtc = new Date();
        const startOfUtcDay = Date.UTC(nowUtc.getUTCFullYear(), nowUtc.getUTCMonth(), nowUtc.getUTCDate());
        const dailyStats = this.tradesRepo.getDailyRealizedPnl(this.broker.mode, startOfUtcDay);
        const drawdownLimitPct = (this.config.dailyDrawdownLimitPct ?? 2.0) / 100;
        const maxDrawdownUsd = balance * drawdownLimitPct;
        if (dailyStats.netPnl <= -maxDrawdownUsd && maxDrawdownUsd > 0) {
          const tomorrowUtc = Date.UTC(nowUtc.getUTCFullYear(), nowUtc.getUTCMonth(), nowUtc.getUTCDate() + 1);
          this.cooldownUntil = tomorrowUtc;
          this.settingsRepo.set('autopilot_cooldown_until', { until: this.cooldownUntil });
          this.state = 'COOLDOWN_ACTIVE';
          this.blockReason = 'BLOCKED_DAILY_MAX_LOSS';
          this.statusMessage = `Daily Drawdown Limit (-${(drawdownLimitPct * 100).toFixed(1)}%) Reached ($${Math.abs(dailyStats.netPnl).toFixed(2)} loss >= $${maxDrawdownUsd.toFixed(2)} limit) - Cooldown Active`;
          this.broadcastStatus();
          this.onOrderDispatched?.({
            symbol,
            side,
            action: 'FAILED',
            price: limitPrice,
            marginUsd: 0,
            leverage,
            atr,
            errorMessage: 'BLOCKED_DAILY_MAX_LOSS: Daily drawdown ceiling of 2% equity reached',
          });
          return;
        }
      }

      const isPropFirmDemoActive =
        Boolean(this.propFirmRiskGuard) && this.broker.mode === 'BINANCE_DEMO';
      const sizingBasisUsd =
        isPropFirmDemoActive && this.propFirmRiskGuard
          ? Math.max(balance, this.propFirmRiskGuard.getConfig().accountSizeUsd)
          : balance;

      const snapshot = this.getConfluenceForSymbol(symbol).getSnapshot(symbol);
      const score = snapshot?.compositeScore ?? 75;

      if (this.adaptiveSizingEngine) {
        const sizing = this.adaptiveSizingEngine.calculateSizing({
          confluenceScore: score,
          walletBalance: balance,
          availableBalance: account.availableBalance,
          sizingBasisBalance: isPropFirmDemoActive ? sizingBasisUsd : undefined,
          leverage,
          atr14: atr,
          consecutiveLosses: this.consecutiveLosses,
        });
        this.latestSizingBreakdown = sizing;

        if (!sizing.solvencyAirbagOk) {
          this.state = 'IDLE';
          this.blockReason = 'BLOCKED_AIRBAG_VIOLATION';
          this.statusMessage = 'Hard Solvency Airbag: Available balance < 20% of wallet equity';
          this.broadcastStatus();
          this.onOrderDispatched?.({
            symbol,
            side,
            action: 'FAILED',
            price: limitPrice,
            marginUsd: 0,
            leverage,
            atr,
            errorMessage: 'BLOCKED_AIRBAG_VIOLATION: Available balance below 20% wallet equity reserve',
          });
          return;
        }

        if (sizing.finalMarginPct <= 0 || sizing.marginUsd < 5.0) {
          this.state = 'IDLE';
          this.onOrderDispatched?.({
            symbol,
            side,
            action: 'FAILED',
            price: limitPrice,
            marginUsd: sizing.marginUsd,
            leverage,
            atr,
            errorMessage: `Calculated margin ${sizing.marginUsd} USD below minimum 5.0 USD threshold or sub-threshold score`,
          });
          return;
        }

        marginUsd = sizing.marginUsd;
        marginAllocationPct = Number((sizing.finalMarginPct * 100).toFixed(2));
      } else {
        // Strictly enforce 10% maximum margin allocation (anchored to $50K PropFirm benchmark in BINANCE_DEMO while respecting 20% real wallet reserve)
        const maxMarginPct = Math.min(10.0, this.config.marginAllocationPct);
        const targetMarginUsd = Number(((sizingBasisUsd * maxMarginPct) / 100).toFixed(2));
        const realWalletSpendable = isPropFirmDemoActive
          ? Math.max(0, Number((account.availableBalance - balance * 0.20).toFixed(2)))
          : account.availableBalance;
        marginUsd = Math.min(targetMarginUsd, realWalletSpendable);
        marginAllocationPct = maxMarginPct;

        if (marginUsd < 5.0) {
          this.state = 'IDLE';
          this.onOrderDispatched?.({
            symbol,
            side,
            action: 'FAILED',
            price: limitPrice,
            marginUsd,
            leverage,
            atr,
            errorMessage: `Calculated margin ${marginUsd} USD below minimum 5.0 USD threshold`,
          });
          return;
        }
      }

      let notionalUsd = marginUsd * leverage;
      let targetQty = Number((notionalUsd / markPrice).toFixed(4));
      const refPrice = markPrice;

      // Dead-SL Armor Clamping:
      const estLiq = calculateLiquidationPrice(side, refPrice, leverage, 0.005);
      const rawSl = side === 'BUY' ? markPrice - 1.5 * atr : markPrice + 1.5 * atr;
      const stopLoss = Number(
        (side === 'BUY' ? Math.max(rawSl, estLiq * 1.005) : Math.min(rawSl, estLiq * 0.995)).toFixed(2)
      );

      // Upcomers $250/trade max risk quantity clamp (fail-closed if <= 0) in BINANCE_DEMO
      if (this.propFirmRiskGuard && this.broker.mode === 'BINANCE_DEMO') {
        const clamped = this.propFirmRiskGuard.clampEntryQuantity({
          desiredQty: targetQty,
          entryPrice: refPrice,
          stopLossPrice: stopLoss,
        });
        if (clamped.qty <= 0) {
          this.state = 'IDLE';
          this.activeEntryContext = null;
          this.broadcastStatus();
          this.emitStateTransition('IDLE');
          this.onOrderDispatched?.({
            symbol,
            side,
            action: 'FAILED',
            price: refPrice,
            marginUsd: 0,
            leverage,
            atr,
            errorMessage:
              'UPCOMERS_RISK_CLAMP_ZERO_QTY: Invalid or zero stop-loss distance failed $250 max risk clamp',
            compositeScore: snapshot?.compositeScore,
            pillarsJson: snapshot?.pillars ? JSON.stringify(snapshot.pillars) : undefined,
            macroRegime: snapshot?.macroRegime,
            macroVetoActive: snapshot?.macroVetoActive,
          });
          return;
        }
        if (clamped.clampedByRisk) {
          targetQty = clamped.qty;
          notionalUsd = Number((targetQty * refPrice).toFixed(2));
          marginUsd = Number((notionalUsd / leverage).toFixed(2));
          if (sizingBasisUsd > 0) {
            marginAllocationPct = Number(((marginUsd / sizingBasisUsd) * 100).toFixed(2));
          }
        }
      }

      const sizingTelemetry = this.buildSizingTelemetry(
        this.adaptiveSizingEngine ? this.latestSizingBreakdown : null,
        marginUsd,
        marginAllocationPct
      );
      this.activeEntryContext = {
        symbol,
        side,
        markPrice,
        notionalUsd,
        snapshot: snapshot ?? null,
        sizing: sizingTelemetry,
      };
      this.lastEmittedChaseKey = null;

      const signalConfirmedEvent = this.buildTelemetryEvent(
        'SIGNAL_CONFIRMED',
        symbol,
        markPrice,
        side,
        snapshot,
        { sizingTelemetry }
      );
      this.emitTelemetry(signalConfirmedEvent);

      const serializedFactorTelemetry = JSON.stringify(signalConfirmedEvent.activeFactors);
      const serializedSizingBreakdown = JSON.stringify(sizingTelemetry);
      const noiseBandState = signalConfirmedEvent.noiseBandActive ? 1 : 0;

      // Dynamic TP1: pin to nearest liquidation cluster if R:R >= 1.5 and dist >= 0.5%, else fallback to ATR
      const risk = Math.abs(refPrice - stopLoss);
      const clusters = this.getConfluenceForSymbol(symbol).liquidationEngine.projectClusters(refPrice, 100_000_000);

      let clusterTp1: number | null = null;
      if (snapshot?.macroRegime) {
        if (side === 'BUY') {
          const shortClusters = clusters
            .filter((c) => c.side === 'SHORT_LIQ' && c.price > refPrice)
            .sort((a, b) => a.price - b.price);

          for (const sc of shortClusters) {
            const reward = sc.price - refPrice;
            const distPct = reward / refPrice;
            const rr = risk > 0 ? reward / risk : 0;
            if (distPct >= 0.005 && rr >= 1.5) {
              clusterTp1 = sc.price;
              break;
            }
          }
        } else {
          const longClusters = clusters
            .filter((c) => c.side === 'LONG_LIQ' && c.price < refPrice)
            .sort((a, b) => b.price - a.price);

          for (const lc of longClusters) {
            const reward = refPrice - lc.price;
            const distPct = reward / refPrice;
            const rr = risk > 0 ? reward / risk : 0;
            if (distPct >= 0.005 && rr >= 1.5) {
              clusterTp1 = lc.price;
              break;
            }
          }
        }
      }

      let tp1: number;
      if (clusterTp1 !== null) {
        tp1 = Number(clusterTp1.toFixed(2));
      } else {
        const fallbackReward = snapshot?.macroRegime
          ? Math.max(2.0 * atr, risk * 1.5)
          : markPrice * 0.025;
        tp1 = Number(
          (side === 'BUY' ? refPrice + fallbackReward : refPrice - fallbackReward).toFixed(2)
        );
      }

      // Dynamic TP2: +4.0x ATR or +5.0% baseline
      const tp2Reward = snapshot?.macroRegime
        ? Math.max(4.0 * atr, Math.abs(tp1 - markPrice) * 2)
        : markPrice * 0.050;
      const tp2 = Number(
        (side === 'BUY' ? markPrice + tp2Reward : markPrice - tp2Reward).toFixed(2)
      );

      if (this.chasingExecutionEngine) {
        this.state = 'LIMIT_CHASING';
        this.broadcastStatus();

        const tradeId = crypto.randomBytes(8).toString('hex');
        const startTime = Date.now();
        let executedQty = 0;
        let effectivePrice = markPrice;
        let amendCount = 0;
        let finalStatus = 'FILLED';
        let lastPlacedOrderId: string | null = null;
        let entryOrderId: string | null = null;

        const getDepth = async () => {
          const orderFlow = this.getConfluenceForSymbol(symbol).orderFlowEngine;
          const bids = orderFlow.getBids();
          const asks = orderFlow.getAsks();
          if (bids.length > 0 && asks.length > 0) {
            return { bestBid: bids[0].price, bestAsk: asks[0].price };
          }
          return { bestBid: markPrice - 0.01, bestAsk: markPrice + 0.01 };
        };

        const checkFill = async (orderId: string): Promise<CheckFillResult> => {
          if (typeof this.broker.getOrder !== 'function') {
            await this.broker.cancelOrder(symbol, orderId, false).catch(() => {});
            return { status: 'TERMINAL', reason: 'GET_ORDER_UNSUPPORTED' };
          }

          let order: OrderExecutionResult | null = null;
          for (let attempt = 0; attempt < 2; attempt++) {
            try {
              order = await this.broker.getOrder(symbol, orderId);
              break;
            } catch (err) {
              if (err instanceof ExchangeDegradedError && attempt === 0) {
                await new Promise((r) => setTimeout(r, 100));
                continue;
              }
              await this.broker.cancelOrder(symbol, orderId, false).catch(() => {});
              return {
                status: 'TERMINAL',
                reason: err instanceof ExchangeDegradedError ? 'EXCHANGE_DEGRADED' : 'GET_ORDER_ERROR',
              };
            }
          }

          if (!order) {
            return { status: 'TERMINAL', reason: 'NOT_FOUND' };
          }

          const orderStatus = String(order.status || '').toUpperCase();
          if (
            orderStatus === 'CANCELED' ||
            orderStatus === 'CANCELLED' ||
            orderStatus === 'EXPIRED' ||
            orderStatus === 'REJECTED'
          ) {
            return { status: 'TERMINAL', reason: orderStatus };
          }

          if (orderStatus === 'PARTIALLY_FILLED' && order.executedQty > 0) {
            await this.broker.cancelOrder(symbol, orderId, false).catch(() => {});
            return {
              status: 'FILLED',
              fillPrice: order.avgPrice > 0 ? order.avgPrice : effectivePrice,
              fillQty: order.executedQty,
            };
          }

          if (orderStatus === 'FILLED' && order.executedQty > 0) {
            return {
              status: 'FILLED',
              fillPrice: order.avgPrice > 0 ? order.avgPrice : effectivePrice,
              fillQty: order.executedQty,
            };
          }

          return null;
        };

        const placeOrder = async (price: number, qty?: number, sliceClientOrderId?: string) => {
          effectivePrice = price;
          const orderQty = qty ?? targetQty;
          const res = await this.broker.openOrder({
            symbol,
            side,
            orderType: 'LIMIT',
            timeInForce: 'GTX',
            limitPrice: price,
            marginUsd: (orderQty * price) / leverage,
            leverage,
            quantity: orderQty,
            clientOrderId: sliceClientOrderId ?? `tos_${tradeId}_ent`,
          });
          lastPlacedOrderId = res.orderId;
          return res.orderId;
        };

        if (notionalUsd >= 5000 && this.twapExecutionSlicer) {
          const twapResult = await this.twapExecutionSlicer.execute({
            symbol,
            side,
            totalQty: targetQty,
            anchorPrice: markPrice,
            tradeId,
            getDepth,
            checkFill,
            placeOrder,
          });
          executedQty = twapResult.filledQty;
          finalStatus = twapResult.status === 'COMPLETED' ? 'FILLED' : twapResult.status;
          amendCount = twapResult.slices.length;
          const filledSlice = twapResult.slices.find((s) => s.status === 'FILLED' && s.orderId);
          entryOrderId = filledSlice?.orderId ?? lastPlacedOrderId;
        } else {
          const chaseResult = await this.chasingExecutionEngine.chase({
            symbol,
            side,
            quantity: targetQty,
            anchorPrice: markPrice,
            getDepth,
            checkFill,
            placeOrder: (price) => placeOrder(price, targetQty),
          });
          finalStatus = chaseResult.status;
          amendCount = chaseResult.amendCount;
          executedQty = chaseResult.fillQty ?? 0;
          if (chaseResult.fillPrice) effectivePrice = chaseResult.fillPrice;
          entryOrderId = chaseResult.orderId || lastPlacedOrderId;
        }

        const feeSavedUsd = Number((notionalUsd * 0.0003).toFixed(4));
        const chaseDurationMs = Date.now() - startTime;

        this.executionChaseLogsRepo.insert({
          trade_id: tradeId,
          symbol,
          anchor_price: markPrice,
          amend_count: amendCount,
          duration_ms: chaseDurationMs,
          final_status: finalStatus,
          effective_price: effectivePrice,
          fee_saved_usd: finalStatus === 'FILLED' ? feeSavedUsd : 0,
          created_at: Date.now(),
        });

        const tickSize = this.chasingExecutionEngine.getTickSize?.() ?? 0.01;
        const spreadPennyJumps =
          tickSize > 0
            ? Math.max(0, Math.round(Math.abs(effectivePrice - markPrice) / tickSize))
            : 0;
        const realizedFeeUsd = Number((notionalUsd * 0.0002).toFixed(4));
        const finalChasingTelemetry: ChasingTelemetrySnapshot = {
          orderId: entryOrderId ?? this.latestChasingState?.orderId ?? tradeId,
          status:
            finalStatus === 'FILLED'
              ? 'FILLED'
              : finalStatus === 'CANCELLED'
                ? 'CANCELED'
                : 'ABORTED',
          anchorMarkPrice: markPrice,
          currentLimitPrice: effectivePrice,
          spreadPennyJumps,
          amendmentCount: amendCount,
          durationMs: chaseDurationMs,
          realizedFeeUsd: finalStatus === 'FILLED' ? realizedFeeUsd : 0,
          feeSavedVsTakerUsd: finalStatus === 'FILLED' ? feeSavedUsd : 0,
        };
        const serializedChaseTelemetry = JSON.stringify(finalChasingTelemetry);

        if (finalStatus !== 'FILLED' || executedQty <= 0) {
          this.state = 'IDLE';
          this.openTradeId = null;
          this.activeEntryContext = null;
          this.broadcastStatus();
          this.emitStateTransition('IDLE');
          this.onOrderDispatched?.({
            symbol,
            side,
            action: 'FAILED',
            price: effectivePrice,
            marginUsd,
            leverage,
            atr,
            errorMessage: `Maker Limit Chasing ended with status: ${finalStatus}`,
            compositeScore: snapshot?.compositeScore,
            pillarsJson: snapshot?.pillars ? JSON.stringify(snapshot.pillars) : undefined,
            macroRegime: snapshot?.macroRegime,
            macroVetoActive: snapshot?.macroVetoActive,
            factorTelemetryJson: serializedFactorTelemetry,
            executionChaseJson: serializedChaseTelemetry,
            sizingBreakdownJson: serializedSizingBreakdown,
            noiseBandState,
          });
          return;
        }

        const oppositeSide: TradeSide = side === 'BUY' ? 'SELL' : 'BUY';
        const bePrice = Number(
          (side === 'BUY' ? effectivePrice * 1.0015 : effectivePrice * 0.9985).toFixed(4)
        );

        const tradeRecord: TradeRecord = {
          id: tradeId,
          symbol,
          broker_mode: this.broker.mode,
          side,
          status: 'OPEN',
          entry_price: effectivePrice,
          exit_price: null,
          quantity: executedQty,
          remaining_qty: executedQty,
          leverage,
          margin_usd: marginUsd,
          stop_loss: stopLoss,
          tp1,
          tp2,
          be_price: bePrice,
          is_breakeven: 0,
          peak_price: effectivePrice,
          peak_mfe: 0,
          trailing_stop_active: 0,
          client_order_id: `tos_${tradeId}_ent`,
          client_sl_id: `tos_${tradeId}_sl`,
          client_tp1_id: `tos_${tradeId}_tp1`,
          client_tp2_id: `tos_${tradeId}_tp2`,
          entry_order_id: entryOrderId,
          sl_algo_id: null,
          tp1_algo_id: null,
          tp2_algo_id: null,
          realized_pnl: 0,
          fees_usd: Number((notionalUsd * 0.0002).toFixed(4)),
          exit_reason: null,
          opened_at: Date.now(),
          closed_at: null,
        };

        this.tradesRepo.insert(tradeRecord);
        this.openTradeId = tradeId;

        let slAlgoId: string | null = null;
        let tp1AlgoId: string | null = null;
        let tp2AlgoId: string | null = null;

        try {
          const slRes = await this.broker.createAlgoOrder({
            symbol,
            side: oppositeSide,
            type: 'STOP_MARKET',
            triggerPrice: stopLoss,
            quantity: executedQty,
            clientAlgoId: `tos_${tradeId}_sl`,
            reduceOnly: true,
          });
          slAlgoId = slRes.algoId;
          this.tradesRepo.update(tradeId, { sl_algo_id: slAlgoId });
        } catch (slErr) {
          console.warn('[AutoPilot] Critical: SL Algo creation failed, emergency unwinding position:', slErr);
          this.state = 'CLOSING';
          this.tradesRepo.update(tradeId, { status: 'CLOSING_IN_PROGRESS' });
          this.broadcastStatus();
          void this.alertNotifier?.notifyCriticalEvent(
            'SL_PLACEMENT_FAILED_EMERGENCY_UNWIND',
            `AutoPilot SL algo placement failed on ${symbol}; emergency market unwind triggered.`,
            {
              tradeId,
              symbol,
              side,
              executedQty,
              error: slErr instanceof Error ? slErr.message : String(slErr),
            }
          );
          try {
            await this.tradeManager.closePosition(symbol, 'SL_PLACEMENT_FAILED_EMERGENCY_UNWIND');
          } finally {
            const updated = this.tradesRepo.getById(tradeId);
            this.handlePositionClosed(updated);
          }
          return;
        }

        try {
          const tp1Res = await this.broker.createAlgoOrder({
            symbol,
            side: oppositeSide,
            type: 'TAKE_PROFIT_MARKET',
            triggerPrice: tp1,
            quantity: Number((executedQty * 0.5).toFixed(4)),
            clientAlgoId: `tos_${tradeId}_tp1`,
            reduceOnly: true,
          });
          tp1AlgoId = tp1Res.algoId;
          this.tradesRepo.update(tradeId, { tp1_algo_id: tp1AlgoId });
        } catch {}

        try {
          const tp2Res = await this.broker.createAlgoOrder({
            symbol,
            side: oppositeSide,
            type: 'TAKE_PROFIT_MARKET',
            triggerPrice: tp2,
            quantity: Number((executedQty * 0.5).toFixed(4)),
            clientAlgoId: `tos_${tradeId}_tp2`,
            reduceOnly: true,
          });
          tp2AlgoId = tp2Res.algoId;
          this.tradesRepo.update(tradeId, { tp2_algo_id: tp2AlgoId });
        } catch {}

        this.state = 'POSITION_OPEN';
        this.oppositeConsensusTickCount = 0;
        this.broadcastStatus();
        this.emitStateTransition('POSITION_OPEN');

        const persistedTrade = this.tradesRepo.getById(tradeId) ?? tradeRecord;
        void this.alertNotifier?.notifyTradeOpened(persistedTrade);

        const enteredEvent = this.buildTelemetryEvent(
          'POSITION_ENTERED',
          symbol,
          effectivePrice,
          side,
          snapshot,
          {
            chasingTelemetry: finalChasingTelemetry,
            sizingTelemetry,
          }
        );
        this.emitTelemetry(enteredEvent);

        this.onOrderDispatched?.({
          symbol,
          side,
          action: 'EXECUTED',
          price: effectivePrice,
          marginUsd,
          leverage,
          atr,
          tradeId,
          compositeScore: snapshot?.compositeScore,
          pillarsJson: snapshot?.pillars ? JSON.stringify(snapshot.pillars) : undefined,
          macroRegime: snapshot?.macroRegime,
          macroVetoActive: snapshot?.macroVetoActive,
          factorTelemetryJson: serializedFactorTelemetry,
          executionChaseJson: serializedChaseTelemetry,
          sizingBreakdownJson: serializedSizingBreakdown,
          noiseBandState,
        });
      } else {
        const trade = await this.tradeManager.openPosition({
          symbol,
          side,
          orderType: 'MARKET',
          marginUsd,
          leverage,
          stopLoss,
          tp1,
          tp2,
          marginAllocationPct,
          isAutoPilot: true,
        } as any);

        const fillEntryPrice = trade.entry_price || markPrice;
        this.tradesRepo.update(trade.id, {
          peak_price: fillEntryPrice,
          peak_mfe: 0,
          trailing_stop_active: 0,
        });

        this.openTradeId = trade.id;
        this.state = 'POSITION_OPEN';
        this.oppositeConsensusTickCount = 0;
        this.broadcastStatus();
        this.emitStateTransition('POSITION_OPEN');

        const enteredEvent = this.buildTelemetryEvent(
          'POSITION_ENTERED',
          symbol,
          fillEntryPrice,
          side,
          snapshot,
          { sizingTelemetry }
        );
        this.emitTelemetry(enteredEvent);

        this.onOrderDispatched?.({
          symbol,
          side,
          action: 'EXECUTED',
          price: fillEntryPrice,
          marginUsd,
          leverage,
          atr,
          tradeId: trade.id,
          compositeScore: snapshot?.compositeScore,
          pillarsJson: snapshot?.pillars ? JSON.stringify(snapshot.pillars) : undefined,
          macroRegime: snapshot?.macroRegime,
          macroVetoActive: snapshot?.macroVetoActive,
          factorTelemetryJson: serializedFactorTelemetry,
          executionChaseJson: null,
          sizingBreakdownJson: serializedSizingBreakdown,
          noiseBandState,
        });
      }
    } catch (err: any) {
      this.state = 'IDLE';
      this.openTradeId = null;
      this.activeEntryContext = null;
      this.broadcastStatus();
      this.emitStateTransition('IDLE');

      const errorMessage = err instanceof Error ? err.message : String(err);
      const snap = this.getConfluenceForSymbol(symbol).getSnapshot(symbol);
      this.onOrderDispatched?.({
        symbol,
        side,
        action: 'FAILED',
        price: markPrice,
        marginUsd,
        leverage,
        atr,
        errorMessage,
        compositeScore: snap?.compositeScore,
        pillarsJson: snap?.pillars ? JSON.stringify(snap.pillars) : undefined,
        macroRegime: snap?.macroRegime,
        macroVetoActive: snap?.macroVetoActive,
        factorTelemetryJson: snap?.telemetryEvent?.activeFactors
          ? JSON.stringify(snap.telemetryEvent.activeFactors)
          : null,
        sizingBreakdownJson: this.latestSizingBreakdown
          ? JSON.stringify(this.buildSizingTelemetry(this.latestSizingBreakdown, marginUsd, marginAllocationPct))
          : null,
        noiseBandState: snap?.noiseBandActive || snap?.noiseBand?.active ? 1 : 0,
      });
    }
  }

  /**
   * Monitors open position: evaluates dynamic breakeven and 2-tick opposite exit.
   */
  private async manageOpenPosition(symbol: string, markPrice: number): Promise<void> {
    if (this.state === 'CLOSING') return;
    if (!this.openTradeId) return;

    const trade = this.tradesRepo.getById(this.openTradeId);

    // Case 1: Position is closed
    if (!trade || trade.status === 'CLOSED') {
      this.handlePositionClosed(trade);
      return;
    }

    // Case 1b: Upcomers Intra-Tick Floating Drawdown & Target Watchdog ($1,250 Daily / $2,500 Trailing / +$2,500 Target) in BINANCE_DEMO
    if (this.propFirmRiskGuard && this.broker.mode === 'BINANCE_DEMO') {
      const qty = trade.remaining_qty > 0 ? trade.remaining_qty : trade.quantity;
      const rawUnrealizedPnl =
        trade.side === 'BUY'
          ? (markPrice - trade.entry_price) * qty
          : (trade.entry_price - markPrice) * qty;
      const unrealizedPnlUsd = Number(
        (rawUnrealizedPnl + (trade.realized_pnl ?? 0) - (trade.fees_usd ?? 0)).toFixed(2)
      );
      const estimatedCloseFeeUsd = Number((markPrice * qty * 0.0005).toFixed(2));
      const evalResult = this.propFirmRiskGuard.evaluateLiveEquity({
        realizedCyclePnlUsd: this.propFirmRiskGuard.getCurrentRealizedCyclePnl(),
        unrealizedPnlUsd,
        liveWalletBalanceUsd: this.cachedBalance,
        hasOpenPosition: true,
        estimatedCloseFeeUsd,
      });

      if (evalResult.emergencyExitReason) {
        const exitReason = evalResult.emergencyExitReason;
        console.warn(
          `[AutoPilot PropFirm Guard] ${exitReason} triggered on ${symbol} (floating=${unrealizedPnlUsd.toFixed(2)}). Closing position.`
        );
        const prevStatus = trade.status;
        this.state = 'CLOSING';
        this.blockReason = exitReason === 'PROPFIRM_TARGET_REACHED' ? null : exitReason;
        this.statusMessage =
          exitReason === 'PROPFIRM_TARGET_REACHED'
            ? 'Upcomers $50K hədəfinə çatıldı — mənfəəti sabitləmək üçün mövqe bağlanır'
            : `Upcomers Risk Guard Halt (${exitReason}) — emergency closing position`;
        this.tradesRepo.update(trade.id, { status: 'CLOSING_IN_PROGRESS' });
        this.broadcastStatus();
        try {
          await this.tradeManager.closePosition(symbol, exitReason);
        } catch {
          const current = this.tradesRepo.getById(trade.id);
          if (current && current.status !== 'CLOSED') {
            this.tradesRepo.update(trade.id, { status: prevStatus });
            this.state = 'POSITION_OPEN';
            this.blockReason = null;
            this.statusMessage = null;
            this.broadcastStatus();
            return;
          }
        }
        const updated = this.tradesRepo.getById(this.openTradeId);
        if (!updated || updated.status === 'CLOSED') {
          this.handlePositionClosed(updated);
        }
        return;
      }
    }

    if (trade.stop_loss && trade.stop_loss > 0) {
      if (trade.side === 'BUY' && markPrice <= trade.stop_loss) {
        console.warn(`[AutoPilot Watchdog] Long markPrice ${markPrice} <= SL ${trade.stop_loss}. Emergency closing.`);
        this.state = 'CLOSING';
        this.tradesRepo.update(trade.id, { status: 'CLOSING_IN_PROGRESS' });
        this.broadcastStatus();
        try {
          await this.tradeManager.closePosition(symbol, 'WATCHDOG_STOP_LOSS');
        } finally {
          const updated = this.tradesRepo.getById(this.openTradeId);
          this.handlePositionClosed(updated);
        }
        return;
      }
      if (trade.side === 'SELL' && markPrice >= trade.stop_loss) {
        console.warn(`[AutoPilot Watchdog] Short markPrice ${markPrice} >= SL ${trade.stop_loss}. Emergency closing.`);
        this.state = 'CLOSING';
        this.tradesRepo.update(trade.id, { status: 'CLOSING_IN_PROGRESS' });
        this.broadcastStatus();
        try {
          await this.tradeManager.closePosition(symbol, 'WATCHDOG_STOP_LOSS');
        } finally {
          const updated = this.tradesRepo.getById(this.openTradeId);
          this.handlePositionClosed(updated);
        }
        return;
      }
    }

    // Case 2: Auto-Breakeven migration at Math.max(1.5 * ATR, 0.25% profit)
    const atr = this.getAtrFn ? this.getAtrFn(symbol) : trade.entry_price * 0.005;
    const profitPerUnit =
      trade.side === 'BUY' ? markPrice - trade.entry_price : trade.entry_price - markPrice;

    // Case 2a: High-Impact Economic Event Blackout Window Unwind (CUJ 3)
    const eventGuard = this.getConfluenceForSymbol(symbol).economicEventGuard;
    const blackout = eventGuard.isBlackoutActive();
    if (blackout.active) {
      const decision = eventGuard.evaluateOpenPositionAtBlackout({
        entryPrice: trade.entry_price,
        markPrice,
        side: trade.side,
        feeBufferPct: 0.0015,
      });

      if (decision === 'MOVE_TO_BREAKEVEN' && trade.is_breakeven === 0) {
        try {
          await this.tradeManager.moveToBreakeven(symbol);
        } catch {}
      } else if (decision === 'UNWIND') {
        this.state = 'CLOSING';
        this.tradesRepo.update(trade.id, { status: 'CLOSING_IN_PROGRESS' });
        this.broadcastStatus();
        try {
          await this.tradeManager.closePosition(symbol, 'EVENT_BLACKOUT_UNWIND');
        } finally {
          const updated = this.tradesRepo.getById(this.openTradeId);
          this.handlePositionClosed(updated);
        }
        return;
      }
    }

    if (trade.is_breakeven === 0) {
      const triggerThreshold = Math.max(1.5 * atr, trade.entry_price * 0.0025);

      if (profitPerUnit >= triggerThreshold) {
        try {
          await this.tradeManager.moveToBreakeven(symbol);
        } catch {
          // Tolerated if buffer not yet reached or broker rejected
        }
      }
    }

    // Case 2b: Dynamic "Giveback-Half" Trailing Stop for Runners & Post-TP1 Positions [CUJ 1]
    let updatedPeak = false;
    let peakPrice = trade.peak_price ?? trade.entry_price;
    let peakMfe = trade.peak_mfe ?? 0;
    let trailingActive = trade.trailing_stop_active === 1;

    if (trade.side === 'BUY') {
      const currentMfe = markPrice - trade.entry_price;
      if (trade.peak_price === null || trade.peak_price === undefined || markPrice > peakPrice) {
        peakPrice = markPrice;
        peakMfe = Math.max(0, currentMfe);
        updatedPeak = true;
      }
    } else {
      const currentMfe = trade.entry_price - markPrice;
      if (trade.peak_price === null || trade.peak_price === undefined || markPrice < peakPrice) {
        peakPrice = markPrice;
        peakMfe = Math.max(0, currentMfe);
        updatedPeak = true;
      }
    }

    // Mathematical activation criteria: MFE >= 2.0x ATR
    if (!trailingActive && peakMfe >= 2.0 * atr) {
      trailingActive = true;
      updatedPeak = true;
    }

    if (updatedPeak) {
      this.tradesRepo.update(trade.id, {
        peak_price: peakPrice,
        peak_mfe: peakMfe,
        trailing_stop_active: trailingActive ? 1 : 0,
      });
      trade.peak_price = peakPrice;
      trade.peak_mfe = peakMfe;
      trade.trailing_stop_active = trailingActive ? 1 : 0;
    }

    // Giveback-Half Trigger: Pullback >= 50% MFE once activated (or post-TP1 runner)
    if (trailingActive && peakMfe >= 2.0 * atr) {
      const givebackThreshold = 0.50 * peakMfe;
      const isGivebackTriggered =
        trade.side === 'BUY'
          ? markPrice <= peakPrice - givebackThreshold
          : markPrice >= peakPrice + givebackThreshold;

      if (isGivebackTriggered) {
        this.state = 'CLOSING';
        this.tradesRepo.update(trade.id, { status: 'CLOSING_IN_PROGRESS' });
        this.broadcastStatus();
        try {
          await this.tradeManager.closePosition(symbol, 'TRAILING_GIVEBACK_HALF');
        } finally {
          const updated = this.tradesRepo.getById(this.openTradeId);
          this.handlePositionClosed(updated);
        }
        return;
      }
    }

    // Case 2b: Dynamic Trailing Stop for Runners & Extended In-Profit Positions [DEF-03]
    // Activated once TP1 has executed (status === 'PARTIALLY_CLOSED') OR profit reaches >= 2.0x ATR
    if (trade.side === 'BUY') {
      const currentPeak = this.peakPriceByTrade.get(trade.id) ?? trade.entry_price;
      if (markPrice > currentPeak) {
        this.peakPriceByTrade.set(trade.id, markPrice);
      }
    } else {
      const currentTrough = this.peakPriceByTrade.get(trade.id) ?? trade.entry_price;
      if (markPrice < currentTrough) {
        this.peakPriceByTrade.set(trade.id, markPrice);
      }
    }

    const trackedExtreme = this.peakPriceByTrade.get(trade.id) ?? markPrice;

    if (!trailingActive && (trade.status === 'PARTIALLY_CLOSED' || profitPerUnit >= 2.0 * atr)) {
      const trailDist = 1.0 * atr;
      if (trade.side === 'BUY') {
        const candidateSl = Number((trackedExtreme - trailDist).toFixed(2));
        const currentSl = trade.stop_loss ?? 0;
        // Trail upward if candidateSl improves current SL by at least 0.1 * atr and is safely below mark price
        if (candidateSl > currentSl + 0.1 * atr && candidateSl < markPrice - 0.2 * atr) {
          try {
            await this.tradeManager.updateStopLoss(symbol, candidateSl, 'DYNAMIC_TRAILING_STOP');
          } catch {
            // Tolerated
          }
        }
      } else {
        const candidateSl = Number((trackedExtreme + trailDist).toFixed(2));
        const currentSl = trade.stop_loss ?? Infinity;
        // Trail downward if candidateSl improves current SL by at least 0.1 * atr and is safely above mark price
        if (candidateSl < currentSl - 0.1 * atr && candidateSl > markPrice + 0.2 * atr) {
          try {
            await this.tradeManager.updateStopLoss(symbol, candidateSl, 'DYNAMIC_TRAILING_STOP');
          } catch {
            // Tolerated
          }
        }
      }
    }

    // Case 3: Opposite-Confluence Exit (persisting for >= 2 consecutive ticks)
    if (this.config.oppositeExitEnabled) {
      const snapshot = this.getConfluenceForSymbol(symbol).getSnapshot(symbol);
      const isOpposite =
        snapshot &&
        snapshot.consensusMet &&
        ((trade.side === 'BUY' && snapshot.consensusBias === 'BEARISH') ||
          (trade.side === 'SELL' && snapshot.consensusBias === 'BULLISH'));

      if (isOpposite) {
        this.oppositeConsensusTickCount++;
        if (this.oppositeConsensusTickCount >= 2) {
          // Trigger emergency early close
          this.state = 'CLOSING';
          this.broadcastStatus();
          try {
            await this.tradeManager.closePosition(symbol, 'OPPOSITE_CONFLUENCE_REVERSAL');
          } finally {
            const updated = this.tradesRepo.getById(this.openTradeId);
            this.handlePositionClosed(updated);
          }
          return;
        }
      } else {
        this.oppositeConsensusTickCount = 0;
      }
    }
  }

  /**
   * Post-exit handling: evaluates consecutive losses, circuit breaker, and 180s re-entry lockout.
   */
  private handlePositionClosed(trade: TradeRecord | null): void {
    if (
      this.propFirmRiskGuard &&
      trade &&
      trade.broker_mode === 'BINANCE_DEMO' &&
      trade.status === 'CLOSED' &&
      !this.recordedClosedTradeIds.has(trade.id)
    ) {
      this.recordedClosedTradeIds.add(trade.id);
      const realizedNetPnlUsd = Number(
        ((trade.realized_pnl ?? 0) - (trade.fees_usd ?? 0)).toFixed(2)
      );
      this.propFirmRiskGuard.recordTradeClosed({
        tradeId: trade.id,
        realizedNetPnlUsd,
        liveWalletBalanceUsd: this.cachedBalance,
      });
    }

    if (trade && trade.status === 'CLOSED') {
      void this.alertNotifier?.notifyTradeClosed(trade);
    }

    this.statusMessage = null;
    const isLoss = trade ? trade.realized_pnl < 0 : false;

    if (isLoss) {
      this.consecutiveLosses++;
      if (this.consecutiveLosses >= this.config.circuitBreakerConsecutiveLosses) {
        // Trigger 60-minute circuit-breaker cooldown
        this.cooldownUntil = Date.now() + this.config.circuitBreakerCooldownMs;
        this.settingsRepo.set('autopilot_cooldown_until', { until: this.cooldownUntil });
        this.state = 'COOLDOWN_ACTIVE';
      } else {
        this.state = 'IDLE';
      }
    } else {
      this.consecutiveLosses = 0;
      this.state = 'IDLE';
    }

    const sym = trade?.symbol ?? this.activeEntryContext?.symbol ?? this.activeSymbol;
    const exitPrice = trade?.exit_price ?? this.getMarkPriceFn(sym);
    const side = trade?.side ?? this.activeEntryContext?.side ?? 'NEUTRAL';
    const snap = this.activeEntryContext?.snapshot ?? this.getConfluenceForSymbol(sym).getSnapshot(sym);
    const exitedEvent = this.buildTelemetryEvent(
      'POSITION_EXITED',
      sym,
      exitPrice,
      side,
      snap,
      {
        sizingTelemetry: this.activeEntryContext?.sizing,
      }
    );
    this.emitTelemetry(exitedEvent);

    this.activeEntryContext = null;
    this.lastEmittedChaseKey = null;
    this.lastExitTime = Date.now();
    if (this.openTradeId) {
      this.peakPriceByTrade.delete(this.openTradeId);
    }
    if (trade?.id) {
      this.peakPriceByTrade.delete(trade.id);
    }
    this.openTradeId = null;
    this.oppositeConsensusTickCount = 0;
    this.broadcastStatus();
    this.emitStateTransition(this.state);
  }
}
