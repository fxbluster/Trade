import type { DatabaseSync } from 'node:sqlite';
import type {
  AutoPilotConfig,
  ConfluenceSnapshot,
  TradeRecord,
  WsServerMessage,
  TradeSide,
} from '@tradeos/shared';
import { calculateLiquidationPrice } from '@tradeos/shared';
import { TradesRepo, SettingsRepo } from '../db/sqlite.js';
import { TradeManager } from './tradeManager.js';
import type { BrokerAdapter } from '../exchange/broker.js';
import type { ConfluenceEngine } from '../quant/confluenceEngine.js';

export type AutoPilotState =
  | 'IDLE'
  | 'EVALUATING'
  | 'PLACING_ORDER'
  | 'POSITION_OPEN'
  | 'CLOSING'
  | 'COOLDOWN_ACTIVE';

export interface AutoPilotManagerOptions {
  db: DatabaseSync;
  tradeManager: TradeManager;
  broker: BrokerAdapter;
  confluenceEngine: ConfluenceEngine;
  getMarkPrice: (symbol: string) => number;
  getAtr?: (symbol: string) => number;
  broadcastWs?: (msg: WsServerMessage) => void;
  config?: Partial<AutoPilotConfig>;
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

  private tradesRepo: TradesRepo;
  private settingsRepo: SettingsRepo;

  private state: AutoPilotState = 'IDLE';
  private config: AutoPilotConfig = {
    enabled: false,
    consensusThreshold: 4,
    marginAllocationPct: 10, // Clamped strictly to <= 10%
    leverage: 10, // Strict 10x
    oppositeExitEnabled: true,
    circuitBreakerConsecutiveLosses: 2,
    circuitBreakerCooldownMs: 60 * 60 * 1000, // 60 minutes
  };

  private openTradeId: string | null = null;
  private activeSymbol: string = 'SOLUSDT';
  private lastExitTime: number = 0;
  private consecutiveLosses: number = 0;
  private cooldownUntil: number = 0;
  private oppositeConsensusTickCount: number = 0;

  constructor(options: AutoPilotManagerOptions) {
    this.db = options.db;
    this.tradeManager = options.tradeManager;
    this.broker = options.broker;
    this.confluenceEngine = options.confluenceEngine;
    this.getMarkPriceFn = options.getMarkPrice;
    this.getAtrFn = options.getAtr;
    this.broadcastWsFn = options.broadcastWs;

    this.tradesRepo = new TradesRepo(this.db);
    this.settingsRepo = new SettingsRepo(this.db);

    if (options.config) {
      this.updateConfig(options.config);
    }

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
      this.config.consensusThreshold = Math.max(1, Math.min(7, partial.consensusThreshold));
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

    this.broadcastStatus();
  }

  public setEnabled(enabled: boolean): void {
    this.config.enabled = enabled;
    if (!enabled && this.state === 'COOLDOWN_ACTIVE') {
      // Keep cooldown state intact
    } else if (!enabled && this.state !== 'POSITION_OPEN') {
      this.state = 'IDLE';
    }
    this.broadcastStatus();
  }

  public setActiveSymbol(symbol: string): void {
    this.activeSymbol = symbol.toUpperCase().trim();
  }

  public isCooldownActive(): boolean {
    this.evaluateCooldownExpiry();
    return this.cooldownUntil > Date.now();
  }

  public getCooldownRemainingSec(): number {
    const diff = this.cooldownUntil - Date.now();
    return diff > 0 ? Math.ceil(diff / 1000) : 0;
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

    // Position Management Branch: when position is open
    if (this.state === 'POSITION_OPEN' && this.openTradeId) {
      await this.manageOpenPosition(sym, markPrice);
      return;
    }

    // Synchronous state latch: only evaluate entries when strictly IDLE
    if (this.state !== 'IDLE') {
      return;
    }

    // Re-entry lockout check (180s mandatory cooldown after position exit)
    if (Date.now() - this.lastExitTime < 180_000) {
      return;
    }

    // Check if an active position already exists in SQLite for this symbol
    const existing = this.tradesRepo.getActivePosition(this.broker.mode, sym);
    if (existing) {
      this.openTradeId = existing.id;
      this.state = 'POSITION_OPEN';
      return;
    }

    // Evaluate Confluence Consensus
    const snapshot = this.confluenceEngine.getSnapshot(sym);
    if (!snapshot || !snapshot.consensusMet || snapshot.macroVetoActive) {
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
   * Executes algorithmic bracket entry with IOC marketable limit pricing (0.10% slippage ceiling).
   */
  private async executeAutoEntry(symbol: string, side: TradeSide, markPrice: number): Promise<void> {
    const account = await this.broker.getAccount();
    const balance = account.walletBalance;

    if (balance <= 0) {
      this.state = 'IDLE';
      return;
    }

    // Strictly enforce 10% maximum margin allocation
    const marginAllocationPct = Math.min(10.0, this.config.marginAllocationPct);
    const targetMarginUsd = Number(((balance * marginAllocationPct) / 100).toFixed(2));
    const marginUsd = Math.min(targetMarginUsd, account.availableBalance);

    if (marginUsd < 5.0) {
      this.state = 'IDLE';
      return;
    }

    // Marketable IOC limit price: 0.10% slippage ceiling
    const limitPrice = Number(
      (side === 'BUY' ? markPrice * 1.0010 : markPrice * 0.9990).toFixed(2)
    );

    // Calculate ATR (fallback to 0.5% of mark price)
    const atr = this.getAtrFn ? this.getAtrFn(symbol) : markPrice * 0.005;

    // Dead-SL Armor Clamping:
    // Raw SL at 1.5x ATR, strictly clamped to safe side of isolated liquidation:
    // stopLoss = side === 'BUY' ? Math.max(rawSl, estLiq * 1.005) : Math.min(rawSl, estLiq * 0.995)
    const leverage = this.config.leverage || 10;
    const estLiq = calculateLiquidationPrice(side, limitPrice, leverage, 0.005);
    const rawSl = side === 'BUY' ? markPrice - 1.5 * atr : markPrice + 1.5 * atr;
    const stopLoss = Number(
      (side === 'BUY' ? Math.max(rawSl, estLiq * 1.005) : Math.min(rawSl, estLiq * 0.995)).toFixed(2)
    );

    // Dynamic TP1: pin to nearest liquidation cluster if R:R >= 1.5 and dist >= 0.5%, else fallback to ATR
    const risk = Math.abs(limitPrice - stopLoss);
    const snapshot = this.confluenceEngine.getSnapshot(symbol);
    const clusters = this.confluenceEngine.liquidationEngine.projectClusters(limitPrice, 100_000_000);

    let clusterTp1: number | null = null;
    if (snapshot?.macroRegime) {
      if (side === 'BUY') {
        const shortClusters = clusters
          .filter((c) => c.side === 'SHORT_LIQ' && c.price > limitPrice)
          .sort((a, b) => a.price - b.price);

        for (const sc of shortClusters) {
          const reward = sc.price - limitPrice;
          const distPct = reward / limitPrice;
          const rr = risk > 0 ? reward / risk : 0;
          if (distPct >= 0.005 && rr >= 1.5) {
            clusterTp1 = sc.price;
            break;
          }
        }
      } else {
        const longClusters = clusters
          .filter((c) => c.side === 'LONG_LIQ' && c.price < limitPrice)
          .sort((a, b) => b.price - a.price);

        for (const lc of longClusters) {
          const reward = limitPrice - lc.price;
          const distPct = reward / limitPrice;
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
        (side === 'BUY' ? markPrice + fallbackReward : markPrice - fallbackReward).toFixed(2)
      );
    }

    // Dynamic TP2: +4.0x ATR or +5.0% baseline
    const tp2Reward = snapshot?.macroRegime
      ? Math.max(4.0 * atr, Math.abs(tp1 - markPrice) * 2)
      : markPrice * 0.050;
    const tp2 = Number(
      (side === 'BUY' ? markPrice + tp2Reward : markPrice - tp2Reward).toFixed(2)
    );

    const trade = await this.tradeManager.openPosition({
      symbol,
      side,
      orderType: 'LIMIT',
      limitPrice,
      marginUsd,
      leverage: 10,
      stopLoss,
      tp1,
      tp2,
      marginAllocationPct,
    });

    this.openTradeId = trade.id;
    this.state = 'POSITION_OPEN';
    this.oppositeConsensusTickCount = 0;
    this.broadcastStatus();
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

    // Case 2: Auto-Breakeven migration at Math.max(1.5 * ATR, 0.25% profit)
    if (trade.is_breakeven === 0) {
      const atr = this.getAtrFn ? this.getAtrFn(symbol) : trade.entry_price * 0.005;
      const profitPerUnit =
        trade.side === 'BUY' ? markPrice - trade.entry_price : trade.entry_price - markPrice;

      const triggerThreshold = Math.max(1.5 * atr, trade.entry_price * 0.0025);

      if (profitPerUnit >= triggerThreshold) {
        try {
          await this.tradeManager.moveToBreakeven(symbol);
        } catch {
          // Tolerated if buffer not yet reached or broker rejected
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
    this.openTradeId = null;
    this.oppositeConsensusTickCount = 0;
    this.broadcastStatus();
  }
}
