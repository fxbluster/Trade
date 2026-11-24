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
} from '@tradeos/shared';
import { calculateLiquidationPrice } from '@tradeos/shared';
import { TradesRepo, SettingsRepo, ExecutionChaseLogsRepo } from '../db/sqlite.js';
import { TradeManager } from './tradeManager.js';
import type { BrokerAdapter } from '../exchange/broker.js';
import type { ConfluenceEngine } from '../quant/confluenceEngine.js';
import type { AdaptiveSizingEngine } from '../quant/adaptiveSizingEngine.js';
import type { ChasingExecutionEngine } from './chasingExecutionEngine.js';
import type { TwapExecutionSlicer } from './twapExecutionSlicer.js';

export type { AutoPilotState };

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
  chasingExecutionEngine?: ChasingExecutionEngine;
  twapExecutionSlicer?: TwapExecutionSlicer;
  executionChaseLogsRepo?: ExecutionChaseLogsRepo;
  onOrderDispatched?: (event: {
    symbol: string;
    side: TradeSide;
    action: 'EXECUTED' | 'FAILED';
    price: number;
    marginUsd: number;
    leverage: number;
    atr: number;
    tradeId?: string;
    errorMessage?: string;
  }) => void;
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
  private onOrderDispatched?: (event: {
    symbol: string;
    side: TradeSide;
    action: 'EXECUTED' | 'FAILED';
    price: number;
    marginUsd: number;
    leverage: number;
    atr: number;
    tradeId?: string;
    errorMessage?: string;
  }) => void;

  private tradesRepo: TradesRepo;
  private settingsRepo: SettingsRepo;
  public readonly executionChaseLogsRepo: ExecutionChaseLogsRepo;
  public readonly adaptiveSizingEngine?: AdaptiveSizingEngine;
  public readonly chasingExecutionEngine?: ChasingExecutionEngine;
  public readonly twapExecutionSlicer?: TwapExecutionSlicer;
  private latestSizingBreakdown: SizingBreakdown | null = null;
  private latestChasingState: ChasingOrderState | null = null;

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

  constructor(options: AutoPilotManagerOptions) {
    this.db = options.db;
    this.tradeManager = options.tradeManager;
    this.broker = options.broker;
    this.confluenceEngine = options.confluenceEngine;
    this.getMarkPriceFn = options.getMarkPrice;
    this.getAtrFn = options.getAtr;
    this.broadcastWsFn = options.broadcastWs;
    this.onOrderDispatched = options.onOrderDispatched;
    this.adaptiveSizingEngine = options.adaptiveSizingEngine;
    this.chasingExecutionEngine = options.chasingExecutionEngine;
    this.twapExecutionSlicer = options.twapExecutionSlicer;
    this.executionChaseLogsRepo =
      options.executionChaseLogsRepo || new ExecutionChaseLogsRepo(this.db);

    this.tradesRepo = new TradesRepo(this.db);
    this.settingsRepo = new SettingsRepo(this.db);

    if (this.chasingExecutionEngine) {
      this.chasingExecutionEngine.setOnStateUpdate((state) => {
        this.latestChasingState = state;
        this.broadcastStatus();
      });
    }

    // Restore persisted Auto-Pilot config (including enabled state & margin cap) from SQLite
    const persistedConfig = this.settingsRepo.get<AutoPilotConfig>('autopilot_config');
    if (persistedConfig) {
      this.config = { ...this.config, ...persistedConfig };
      this.confluenceEngine.setConsensusThreshold(this.config.consensusThreshold);
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

  public updateConfig(partial: Partial<AutoPilotConfig>): void {
    if (partial.enabled !== undefined) this.config.enabled = partial.enabled;
    if (partial.consensusThreshold !== undefined) {
      this.config.consensusThreshold =
        partial.consensusThreshold >= 20
          ? Math.max(50, Math.min(95, partial.consensusThreshold))
          : Math.max(1, Math.min(7, partial.consensusThreshold));
      this.confluenceEngine.setConsensusThreshold(this.config.consensusThreshold);
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
  }

  public setActiveSymbol(symbol: string): void {
    this.activeSymbol = symbol.toUpperCase().trim();
  }

  public isCooldownActive(): boolean {
    this.evaluateCooldownExpiry();
    return this.cooldownUntil > Date.now();
  }

  public resetCooldown(): void {
    this.cooldownUntil = 0;
    this.consecutiveLosses = 0;
    this.settingsRepo.delete('autopilot_cooldown_until');
    if (this.state === 'COOLDOWN_ACTIVE') {
      this.state = 'IDLE';
      this.blockReason = null;
      this.statusMessage = null;
    }
    this.broadcastStatus();
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
      }
    }
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

    // Position Management Branch: when position is open or while in LIMIT_CHASING
    if (this.openTradeId) {
      await this.manageOpenPosition(sym, markPrice);
      if (this.state === 'POSITION_OPEN') {
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
      await this.manageOpenPosition(sym, markPrice);
      return;
    }

    // Synchronous state latch: only evaluate entries when strictly IDLE or recovering from cap block
    if (this.state !== 'IDLE' && this.state !== 'BLOCKED_SESSION_TRADE_CAP') {
      return;
    }

    // Re-entry lockout check (180s mandatory cooldown after position exit)
    if (Date.now() - this.lastExitTime < 180_000) {
      return;
    }

    const nowUtc = new Date();
    const startOfUtcDay = Date.UTC(nowUtc.getUTCFullYear(), nowUtc.getUTCMonth(), nowUtc.getUTCDate());

    // 1. Session Trade Cap: Max N filled round-trip trades per calendar day (UTC) [CUJ 4 / DEF-12]
    const maxTrades = this.config.maxDailyTrades ?? 5;
    this.filledToday = this.tradesRepo.getFilledTradeCountToday(this.broker.mode, sym, startOfUtcDay);
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

    // Evaluate Confluence Consensus
    const snapshot = this.confluenceEngine.getSnapshot(sym);
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

      const snapshot = this.confluenceEngine.getSnapshot(symbol);
      const score = snapshot?.compositeScore ?? 75;

      if (this.adaptiveSizingEngine) {
        const sizing = this.adaptiveSizingEngine.calculateSizing({
          confluenceScore: score,
          walletBalance: balance,
          availableBalance: account.availableBalance,
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
        // Strictly enforce 10% maximum margin allocation
        const maxMarginPct = Math.min(10.0, this.config.marginAllocationPct);
        const targetMarginUsd = Number(((balance * maxMarginPct) / 100).toFixed(2));
        marginUsd = Math.min(targetMarginUsd, account.availableBalance);
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

      const notionalUsd = marginUsd * leverage;
      const targetQty = Number((notionalUsd / markPrice).toFixed(4));
      const refPrice = this.chasingExecutionEngine ? markPrice : limitPrice;

      // Dead-SL Armor Clamping:
      const estLiq = calculateLiquidationPrice(side, refPrice, leverage, 0.005);
      const rawSl = side === 'BUY' ? markPrice - 1.5 * atr : markPrice + 1.5 * atr;
      const stopLoss = Number(
        (side === 'BUY' ? Math.max(rawSl, estLiq * 1.005) : Math.min(rawSl, estLiq * 0.995)).toFixed(2)
      );

      // Dynamic TP1: pin to nearest liquidation cluster if R:R >= 1.5 and dist >= 0.5%, else fallback to ATR
      const risk = Math.abs(refPrice - stopLoss);
      const clusters = this.confluenceEngine.liquidationEngine.projectClusters(refPrice, 100_000_000);

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

        const tradeId = crypto.randomUUID();
        const startTime = Date.now();
        let executedQty = 0;
        let effectivePrice = markPrice;
        let amendCount = 0;
        let finalStatus = 'FILLED';

        const getDepth = async () => {
          const bids = this.confluenceEngine.orderFlowEngine.getBids();
          const asks = this.confluenceEngine.orderFlowEngine.getAsks();
          if (bids.length > 0 && asks.length > 0) {
            return { bestBid: bids[0].price, bestAsk: asks[0].price };
          }
          return { bestBid: markPrice - 0.01, bestAsk: markPrice + 0.01 };
        };

        const checkFill = async (orderId: string) => {
          const openOrders = await this.broker.getOpenOrders(symbol);
          const found = openOrders.find((o) => o.orderId === orderId);
          if (!found) {
            return { fillPrice: effectivePrice, fillQty: targetQty };
          }
          if (found.executedQty && found.executedQty >= found.origQty) {
            return { fillPrice: found.price, fillQty: found.executedQty };
          }
          return null;
        };

        const placeOrder = async (price: number, qty?: number) => {
          effectivePrice = price;
          const orderQty = qty ?? targetQty;
          const res = await this.broker.openOrder({
            symbol,
            side,
            orderType: 'LIMIT',
            limitPrice: price,
            marginUsd: (orderQty * price) / leverage,
            leverage,
            quantity: orderQty,
          });
          return res.orderId;
        };

        if (notionalUsd >= 5000 && this.twapExecutionSlicer) {
          const twapResult = await this.twapExecutionSlicer.execute({
            symbol,
            side,
            totalQty: targetQty,
            anchorPrice: markPrice,
            getDepth,
            checkFill,
            placeOrder,
          });
          executedQty = twapResult.filledQty;
          finalStatus = twapResult.status === 'COMPLETED' ? 'FILLED' : twapResult.status;
          amendCount = twapResult.slices.length;
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
          executedQty = chaseResult.fillQty ?? (chaseResult.status === 'FILLED' ? targetQty : 0);
          if (chaseResult.fillPrice) effectivePrice = chaseResult.fillPrice;
        }

        const feeSavedUsd = Number((notionalUsd * 0.0003).toFixed(4));

        this.executionChaseLogsRepo.insert({
          trade_id: tradeId,
          symbol,
          anchor_price: markPrice,
          amend_count: amendCount,
          duration_ms: Date.now() - startTime,
          final_status: finalStatus,
          effective_price: effectivePrice,
          fee_saved_usd: finalStatus === 'FILLED' ? feeSavedUsd : 0,
          created_at: Date.now(),
        });

        if (finalStatus !== 'FILLED' && executedQty <= 0) {
          this.state = 'IDLE';
          this.openTradeId = null;
          this.broadcastStatus();
          this.onOrderDispatched?.({
            symbol,
            side,
            action: 'FAILED',
            price: effectivePrice,
            marginUsd,
            leverage,
            atr,
            errorMessage: `Maker Limit Chasing ended with status: ${finalStatus}`,
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
          entry_order_id: tradeId,
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

        this.onOrderDispatched?.({
          symbol,
          side,
          action: 'EXECUTED',
          price: effectivePrice,
          marginUsd,
          leverage,
          atr,
          tradeId,
        });
      } else {
        const limitPrice = Number(
          (side === 'BUY' ? markPrice * 1.0010 : markPrice * 0.9990).toFixed(2)
        );

        const trade = await this.tradeManager.openPosition({
          symbol,
          side,
          orderType: 'LIMIT',
          limitPrice,
          marginUsd,
          leverage,
          stopLoss,
          tp1,
          tp2,
          marginAllocationPct,
        });

        this.tradesRepo.update(trade.id, {
          peak_price: limitPrice,
          peak_mfe: 0,
          trailing_stop_active: 0,
        });

        this.openTradeId = trade.id;
        this.state = 'POSITION_OPEN';
        this.oppositeConsensusTickCount = 0;
        this.broadcastStatus();

        this.onOrderDispatched?.({
          symbol,
          side,
          action: 'EXECUTED',
          price: limitPrice,
          marginUsd,
          leverage,
          atr,
          tradeId: trade.id,
        });
      }
    } catch (err: any) {
      this.state = 'IDLE';
      this.openTradeId = null;
      this.broadcastStatus();

      const errorMessage = err instanceof Error ? err.message : String(err);
      this.onOrderDispatched?.({
        symbol,
        side,
        action: 'FAILED',
        price: markPrice,
        marginUsd,
        leverage,
        atr,
        errorMessage,
      });
    }
  }

  /**
   * Monitors open position: evaluates dynamic breakeven and 2-tick opposite exit.
   */
  private async manageOpenPosition(symbol: string, markPrice: number): Promise<void> {
    if (!this.openTradeId) return;

    const trade = this.tradesRepo.getById(this.openTradeId);

    // Case 1: Position is closed
    if (!trade || trade.status === 'CLOSED') {
      this.handlePositionClosed(trade);
      return;
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
    const blackout = this.confluenceEngine.economicEventGuard.isBlackoutActive();
    if (blackout.active) {
      const decision = this.confluenceEngine.economicEventGuard.evaluateOpenPositionAtBlackout({
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
      const snapshot = this.confluenceEngine.getSnapshot(symbol);
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
  }
}
