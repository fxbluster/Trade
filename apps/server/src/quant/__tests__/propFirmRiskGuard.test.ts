import { describe, it, expect, beforeEach } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import { initializeDatabase, PropFirmRepo, TradesRepo } from '../../db/sqlite.js';
import {
  calculateUpcomersMaxQty,
  calculateUpcomersTrailingFloors,
  formatPropFirmCertificateMarkdown,
  PropFirmConflictError,
  PropFirmRiskGuard,
} from '../propFirmRiskGuard.js';
import { TradeManager } from '../../services/tradeManager.js';
import { AutoPilotManager } from '../../services/autoPilotManager.js';
import { ConfluenceEngine } from '../confluenceEngine.js';
import type {
  BrokerAdapter,
  PositionInfo,
  OrderExecutionResult,
  AlgoOrderParams,
  AlgoOrderResult,
} from '../../exchange/broker.js';
import type {
  AccountInfo,
  OpenOrderInfo,
  BrokerMode,
  ConfluenceSnapshot,
  PropFirmStatusResponse,
  TradeRecord,
} from '@tradeos/shared';

class PropFirmMockBroker implements BrokerAdapter {
  readonly mode: BrokerMode = 'BINANCE_DEMO';
  public account: AccountInfo = {
    walletBalance: 50_000,
    equity: 50_000,
    availableBalance: 50_000,
    unrealizedPnl: 0,
    currency: 'USDT',
  };
  public position: PositionInfo | null = null;
  public openOrders: OpenOrderInfo[] = [];
  public openOrderCalls: any[] = [];
  public closePositionCalls: any[] = [];

  async getAccount(): Promise<AccountInfo> {
    return this.account;
  }

  async getPosition(_symbol: string): Promise<PositionInfo | null> {
    return this.position;
  }

  async openOrder(req: any): Promise<OrderExecutionResult> {
    this.openOrderCalls.push(req);
    const avgPrice = req.limitPrice || 100;
    const executedQty = req.quantity || (req.marginUsd * req.leverage) / avgPrice;
    this.position = {
      symbol: req.symbol,
      positionAmt: req.side === 'BUY' ? executedQty : -executedQty,
      entryPrice: avgPrice,
      markPrice: avgPrice,
      unRealizedProfit: 0,
      liquidationPrice: 80,
      leverage: req.leverage,
    };
    return {
      orderId: 'ent_' + Math.random().toString(36).slice(2, 8),
      clientOrderId: req.clientOrderId || 'tos_ent',
      status: 'FILLED',
      executedQty,
      avgPrice,
    };
  }

  async createAlgoOrder(params: AlgoOrderParams): Promise<AlgoOrderResult> {
    return {
      algoId: 'algo_' + Math.random().toString(36).slice(2, 8),
      clientAlgoId: params.clientAlgoId,
      symbol: params.symbol,
      status: 'NEW',
    };
  }

  async closePosition(
    symbol: string,
    qty?: number
  ): Promise<{ orderId: string; status: string; avgPrice?: number }> {
    this.closePositionCalls.push({ symbol, qty });
    const p = this.position;
    this.position = null;
    return {
      orderId: 'close_prop_1',
      status: 'FILLED',
      avgPrice: p?.markPrice || 100,
    };
  }

  async cancelOrder(_symbol: string, _orderId: string, _isAlgo?: boolean): Promise<boolean> {
    return true;
  }

  async cancelAllOrders(_symbol: string): Promise<boolean> {
    return true;
  }

  async moveToBreakeven(
    _symbol: string,
    _bePrice: number,
    _currentSlId?: string
  ): Promise<{ newSlId: string }> {
    return { newSlId: 'be_sl_1' };
  }

  async getOpenOrders(_symbol?: string): Promise<OpenOrderInfo[]> {
    return this.openOrders;
  }
}

describe('PropFirmRiskGuard — Upcomers $50K 1-Step Thunderbolt Risk Engine', () => {
  let db: DatabaseSync;
  let repo: PropFirmRepo;

  beforeEach(() => {
    db = initializeDatabase(':memory:');
    repo = new PropFirmRepo(db);
  });

  // --------------------------------------------------------------------------
  // Review Focus #3: Zero / NaN Stop-Loss Distance in $250 Quantity Clamp
  // --------------------------------------------------------------------------
  describe('calculateUpcomersMaxQty & clampEntryQuantity ($250 max risk)', () => {
    it('computes exact $250 risk-capped quantity and fails closed to 0 on zero/non-finite SL distance', () => {
      expect(calculateUpcomersMaxQty(100, 99.5, 250)).toBe(500);
      expect(calculateUpcomersMaxQty(100, 102.5, 250)).toBe(100);
      expect(calculateUpcomersMaxQty(100, 99.5)).toBe(500); // default $250

      // Fail-closed cases (Review Focus #3)
      expect(calculateUpcomersMaxQty(100, 100, 250)).toBe(0);
      expect(calculateUpcomersMaxQty(100, 100 + 1e-9, 250)).toBe(0);
      expect(calculateUpcomersMaxQty(NaN, 99, 250)).toBe(0);
      expect(calculateUpcomersMaxQty(100, Infinity, 250)).toBe(0);
      expect(calculateUpcomersMaxQty(100, -Infinity, 250)).toBe(0);
      expect(calculateUpcomersMaxQty(100, 99, 0)).toBe(0);
      expect(calculateUpcomersMaxQty(100, 99, -50)).toBe(0);
    });

    it('clamps desiredQty to maxRiskQty and fails closed to 0 when stop distance is invalid', () => {
      const guard = new PropFirmRiskGuard(repo);

      const clamped = guard.clampEntryQuantity({
        desiredQty: 1200,
        entryPrice: 100,
        stopLossPrice: 99.5,
      });
      expect(clamped.clampedByRisk).toBe(true);
      expect(clamped.maxRiskQty).toBe(500);
      expect(clamped.qty).toBe(500);
      expect(clamped.riskUsdAtStop).toBe(250);

      const unclamped = guard.clampEntryQuantity({
        desiredQty: 120,
        entryPrice: 100,
        stopLossPrice: 99.5,
      });
      expect(unclamped.clampedByRisk).toBe(false);
      expect(unclamped.qty).toBe(120);
      expect(unclamped.riskUsdAtStop).toBe(60);

      const zeroSl = guard.clampEntryQuantity({
        desiredQty: 100,
        entryPrice: 100,
        stopLossPrice: 100,
      });
      expect(zeroSl.qty).toBe(0);
      expect(zeroSl.maxRiskQty).toBe(0);
      expect(zeroSl.riskUsdAtStop).toBe(0);
    });
  });

  // --------------------------------------------------------------------------
  // Review Focus #4: Trailing Floor Lock at $53,000 HWM & Restart Durability
  // --------------------------------------------------------------------------
  describe('calculateUpcomersTrailingFloors & monotonic $53k -> $50k floor lock', () => {
    it('tracks HWM - $3,000 (internal HWM - $2,500) below $53,000 and locks at $50,000 / $50,500 at >= $53,000', () => {
      expect(calculateUpcomersTrailingFloors(50_000)).toEqual({
        contractualFloorUsd: 47_000,
        internalHaltFloorUsd: 47_500,
        isFloorLocked: false,
      });

      expect(calculateUpcomersTrailingFloors(51_500)).toEqual({
        contractualFloorUsd: 48_500,
        internalHaltFloorUsd: 49_000,
        isFloorLocked: false,
      });

      expect(calculateUpcomersTrailingFloors(52_999)).toEqual({
        contractualFloorUsd: 49_999,
        internalHaltFloorUsd: 50_499,
        isFloorLocked: false,
      });

      expect(calculateUpcomersTrailingFloors(53_000)).toEqual({
        contractualFloorUsd: 50_000,
        internalHaltFloorUsd: 50_500,
        isFloorLocked: true,
      });

      expect(calculateUpcomersTrailingFloors(56_000)).toEqual({
        contractualFloorUsd: 50_000,
        internalHaltFloorUsd: 50_500,
        isFloorLocked: true,
      });
    });

    it('persists monotonic HWM and permanent $50,000 floor lock across SQLite restarts even on pullback', () => {
      // Use a higher profit target here so equity can reach $53,000 while remaining ACTIVE for pullback testing
      const guard1 = new PropFirmRiskGuard(repo, { profitTargetUsd: 5_000 });
      const day1 = Date.UTC(2026, 10, 25, 10, 0, 0);

      // Push equity to $53,200 -> locks floor at $50,000 (internal $50,500)
      const peakEval = guard1.evaluateLiveEquity({
        realizedCyclePnlUsd: 3_200,
        unrealizedPnlUsd: 0,
        liveWalletBalanceUsd: 53_200,
        nowMs: day1,
      });
      expect(peakEval.status.cycle.highWaterMarkUsd).toBe(53_200);
      expect(peakEval.status.cycle.isFloorLocked).toBe(true);
      expect(peakEval.status.cycle.contractualTrailingFloorUsd).toBe(50_000);
      expect(peakEval.status.cycle.internalTrailingFloorUsd).toBe(50_500);
      expect(peakEval.emergencyExitReason).toBeNull();

      // Simulate server restart: instantiate a brand-new guard over the same SQLite repo
      const guardAfterRestart = new PropFirmRiskGuard(repo, { profitTargetUsd: 5_000 });
      const day2 = Date.UTC(2026, 10, 26, 10, 0, 0);

      // Equity pulls back to $52,200 on Day 2 (down $1,000 from $53,200 HWM, daily loss -$1,000 > -$1,250)
      const pullbackEval = guardAfterRestart.evaluateLiveEquity({
        realizedCyclePnlUsd: 2_200,
        unrealizedPnlUsd: 0,
        liveWalletBalanceUsd: 52_200,
        nowMs: day2,
      });
      expect(pullbackEval.status.cycle.highWaterMarkUsd).toBe(53_200);
      expect(pullbackEval.status.cycle.isFloorLocked).toBe(true);
      expect(pullbackEval.status.cycle.contractualTrailingFloorUsd).toBe(50_000);
      expect(pullbackEval.status.cycle.internalTrailingFloorUsd).toBe(50_500);
      expect(pullbackEval.status.cycle.status).toBe('ACTIVE');

      // Day 3: further pullback to $50,500 hits locked internal trailing floor ($50,500)
      const day3 = Date.UTC(2026, 10, 27, 10, 0, 0);
      const day3Start = guardAfterRestart.evaluateLiveEquity({
        realizedCyclePnlUsd: 1_500,
        unrealizedPnlUsd: 0,
        liveWalletBalanceUsd: 51_500,
        nowMs: day3,
      });
      expect(day3Start.status.cycle.status).toBe('ACTIVE');

      const day3Breach = guardAfterRestart.evaluateLiveEquity({
        realizedCyclePnlUsd: 1_500,
        unrealizedPnlUsd: -1_000, // equity = 50_500 (daily pnl = -1000, above daily halt, but hits locked internal trailing floor 50_500!)
        liveWalletBalanceUsd: 51_500,
        nowMs: day3 + 60_000,
      });
      expect(day3Breach.emergencyExitReason).toBe('UPCOMERS_TRAILING_HALT');
      expect(day3Breach.status.cycle.status).toBe('HALTED_TRAILING_BUFFER');
      expect(guardAfterRestart.canOpenTrade(day3 + 120_000)).toMatchObject({
        allowed: false,
        reason: 'UPCOMERS_TRAILING_HALT',
      });
    });
  });

  // --------------------------------------------------------------------------
  // Review Focus #2: Intra-Tick Floating Drawdown Violation ($1,250 Daily / $2,500 Trailing)
  // --------------------------------------------------------------------------
  describe('Daily ($1,250) and Trailing ($2,500) intra-tick safety buffers', () => {
    it('triggers UPCOMERS_DAILY_HALT at -$1,250 floating unrealized loss before -$1,500 contractual breach', () => {
      const updates: PropFirmStatusResponse[] = [];
      const guard = new PropFirmRiskGuard(repo, {}, (st) => updates.push(st));
      const t0 = Date.UTC(2026, 10, 25, 12, 0, 0);

      // Safe floating loss (-$800)
      const safe = guard.evaluateLiveEquity({
        realizedCyclePnlUsd: 0,
        unrealizedPnlUsd: -800,
        liveWalletBalanceUsd: 50_000,
        nowMs: t0,
      });
      expect(safe.emergencyExitReason).toBeNull();
      expect(safe.status.cycle.status).toBe('ACTIVE');
      expect(safe.status.dailyBufferRemainingUsd).toBe(450);
      expect(safe.status.verdict).toBe('NO_LOSS');

      // Floating loss hits -$1,250 -> internal daily halt triggered!
      const halted = guard.evaluateLiveEquity({
        realizedCyclePnlUsd: 0,
        unrealizedPnlUsd: -1_250,
        liveWalletBalanceUsd: 50_000,
        nowMs: t0 + 5_000,
      });
      expect(halted.emergencyExitReason).toBe('UPCOMERS_DAILY_HALT');
      expect(halted.status.cycle.status).toBe('HALTED_DAILY_BUFFER');
      expect(halted.status.canTrade).toBe(false);
      expect(halted.status.haltReason).toBe('UPCOMERS_DAILY_HALT');
      expect(halted.status.dailyBufferRemainingUsd).toBe(0);
      expect(guard.canOpenTrade(t0 + 10_000)).toMatchObject({
        allowed: false,
        reason: 'UPCOMERS_DAILY_HALT',
      });
      expect(updates.length).toBeGreaterThanOrEqual(2);
    });

    it('triggers UPCOMERS_TRAILING_HALT at -$2,500 trailing drawdown across multiple days before -$3,000 breach', () => {
      const guard = new PropFirmRiskGuard(repo);
      const day1 = Date.UTC(2026, 10, 25, 12, 0, 0);
      const day2 = Date.UTC(2026, 10, 26, 12, 0, 0);
      const day3 = Date.UTC(2026, 10, 27, 12, 0, 0);

      // Day 1: -$1,000 realized (within -$1,250 daily)
      guard.recordTradeClosed({ realizedNetPnlUsd: -1_000, liveWalletBalanceUsd: 4_606.01, nowMs: day1 });
      // Day 2: -$1,000 realized (cumulative -$2,000, daily -$1,000)
      guard.recordTradeClosed({ realizedNetPnlUsd: -1_000, liveWalletBalanceUsd: 4_606.01, nowMs: day2 });
      expect(guard.canOpenTrade(day2 + 1000).allowed).toBe(true);

      // Day 3: -$500 floating loss -> cumulative -$2,500 (equity = $47,500 <= internal floor $47,500)
      const trailingHalt = guard.evaluateLiveEquity({
        realizedCyclePnlUsd: -2_000,
        unrealizedPnlUsd: -500,
        liveWalletBalanceUsd: 4_606.01,
        nowMs: day3,
      });
      expect(trailingHalt.emergencyExitReason).toBe('UPCOMERS_TRAILING_HALT');
      expect(trailingHalt.status.cycle.status).toBe('HALTED_TRAILING_BUFFER');
      expect(trailingHalt.status.trailingBufferRemainingUsd).toBe(0);
      expect(guard.canOpenTrade(day3 + 1000)).toMatchObject({
        allowed: false,
        reason: 'UPCOMERS_TRAILING_HALT',
      });
    });
  });

  // --------------------------------------------------------------------------
  // Review Focus #1: UTC Midnight Daily Baseline Rollover (00:00 UTC)
  // --------------------------------------------------------------------------
  describe('00:00 UTC daily baseline rollover', () => {
    it('creates a new daily snapshot and restores HALTED_DAILY_BUFFER -> ACTIVE on next UTC day', () => {
      const guard = new PropFirmRiskGuard(repo);
      const day1 = Date.UTC(2026, 10, 25, 23, 50, 0);
      const day2 = Date.UTC(2026, 10, 26, 0, 0, 5);

      const halted = guard.evaluateLiveEquity({
        realizedCyclePnlUsd: -1_250,
        unrealizedPnlUsd: 0,
        liveWalletBalanceUsd: 4_606.01,
        nowMs: day1,
      });
      expect(halted.status.cycle.status).toBe('HALTED_DAILY_BUFFER');
      expect(guard.canOpenTrade(day1 + 1000).allowed).toBe(false);

      // Roll past 00:00 UTC -> transient HALTED_DAILY_BUFFER unlocks!
      const canTradeDay2 = guard.canOpenTrade(day2);
      expect(canTradeDay2.allowed).toBe(true);

      const statusDay2 = guard.getStatus(4_606.01, day2);
      expect(statusDay2.cycle.status).toBe('ACTIVE');
      expect(statusDay2.dailyBaselineEquityUsd).toBe(48_750);
      expect(statusDay2.dailyPnlUsd).toBe(0);
      expect(statusDay2.dailyBufferRemainingUsd).toBe(1_250);

      const snapDay2 = repo.getDailySnapshot('2026-11-26', statusDay2.cycle.id);
      expect(snapDay2).not.toBeNull();
      expect(snapDay2!.dayStartEquityUsd).toBe(48_750);
    });

    it('NEVER unlocks permanent FAILED_DAILY or FAILED_TRAILING on UTC midnight rollover', () => {
      const guard = new PropFirmRiskGuard(repo);
      const day1 = Date.UTC(2026, 10, 25, 22, 0, 0);
      const day2 = Date.UTC(2026, 10, 26, 0, 5, 0);

      // Contractual daily breach (-$1,500) -> FAILED_DAILY
      const failed = guard.evaluateLiveEquity({
        realizedCyclePnlUsd: -1_550,
        unrealizedPnlUsd: 0,
        liveWalletBalanceUsd: 4_606.01,
        nowMs: day1,
      });
      expect(failed.status.cycle.status).toBe('FAILED_DAILY');
      expect(failed.emergencyExitReason).toBe('UPCOMERS_DAILY_HALT');

      // Crossing 00:00 UTC must NOT resurrect FAILED_DAILY
      const day2Check = guard.canOpenTrade(day2);
      expect(day2Check.allowed).toBe(false);
      expect(day2Check.reason).toBe('CYCLE_TERMINAL');
      expect(guard.getStatus(4_606.01, day2).cycle.status).toBe('FAILED_DAILY');
    });
  });

  // --------------------------------------------------------------------------
  // Review Focus #5 & G-5: Sub-$50K Testnet Balance ($4,606.01) & 5-Cycle Certificate
  // --------------------------------------------------------------------------
  describe('Sub-$50K Testnet balance resilience & 5-cycle consistency certificate', () => {
    it('anchors challenge to $50,000 when wallet is $4,606.01, flags needsTopUp, passes at +$2,500, and certifies after 5 PASSED cycles', () => {
      const guard = new PropFirmRiskGuard(repo);
      const baseTime = Date.UTC(2026, 10, 25, 8, 0, 0);

      // Boot on $4,606.01 Testnet wallet -> no false fail, needsTopUp = true
      const bootStatus = guard.getStatus(4_606.01, baseTime);
      expect(bootStatus.cycle.status).toBe('ACTIVE');
      expect(bootStatus.cycle.startingBalanceUsd).toBe(50_000);
      expect(bootStatus.cycle.currentEquityUsd).toBe(50_000);
      expect(bootStatus.verdict).toBe('WAITING');
      expect(bootStatus.needsTopUp).toBe(true);
      expect(bootStatus.topUpMessage).toContain('50,000');
      expect(bootStatus.canTrade).toBe(true);

      // Complete 5 consecutive winning cycles (+$2,500 each)
      for (let i = 1; i <= 5; i++) {
        if (i > 1) {
          guard.startNewCycle(4_606.01, baseTime + i * 3_600_000);
        }
        const mid = guard.recordTradeClosed({
          realizedNetPnlUsd: 1_200,
          liveWalletBalanceUsd: 4_606.01,
          nowMs: baseTime + i * 3_600_000 + 1000,
        });
        expect(mid.cycle.status).toBe('ACTIVE');
        expect(mid.verdict).toBe('YES_PROFIT');
        expect(mid.targetProgressPct).toBe(48);

        const passed = guard.recordTradeClosed({
          realizedNetPnlUsd: 1_300,
          liveWalletBalanceUsd: 4_606.01,
          nowMs: baseTime + i * 3_600_000 + 2000,
        });
        expect(passed.cycle.status).toBe('PASSED');
        expect(passed.cycle.tradesCount).toBe(2);
        expect(passed.cycle.winCount).toBe(2);
        expect(passed.consecutivePassedCycles).toBe(i);

        const cert = guard.getCertificateStatus(baseTime + i * 3_600_000 + 3000);
        expect(cert.consecutivePassedCycles).toBe(i);
        expect(cert.requiredPassedCycles).toBe(5);
        expect(cert.certified).toBe(i >= 5);
        expect(cert.remainingCycles).toBe(Math.max(0, 5 - i));
      }
    });
  });

  // --------------------------------------------------------------------------
  // AutoPilotManager Risk Guard Integration Tests
  // --------------------------------------------------------------------------
  describe('AutoPilotManager integration with PropFirmRiskGuard', () => {
    let mockBroker: PropFirmMockBroker;
    let tradeManager: TradeManager;
    let confluenceEngine: ConfluenceEngine;
    let guard: PropFirmRiskGuard;
    let autoPilot: AutoPilotManager;
    let markPrice: number;

    function setBuySnapshot() {
      const snap: ConfluenceSnapshot = {
        symbol: 'SOLUSDT',
        pillars: [],
        bullishCount: 5,
        bearishCount: 0,
        neutralCount: 2,
        consensusBias: 'BULLISH',
        consensusMet: true,
        threshold: 4,
        compositeScore: 82,
        recommendedAction: 'BUY',
        macroVetoActive: false,
        macroRegime: 'MACRO_BULLISH',
        activeFvgs: [],
        activeOrderBlocks: [],
        latestSweep: null,
      };
      confluenceEngine.getSnapshot = () => snap;
      confluenceEngine.getLatestSnapshot = () => snap;
      confluenceEngine.evaluate = () => snap;
      (confluenceEngine as any).latestSnapshot = snap;
    }

    beforeEach(() => {
      mockBroker = new PropFirmMockBroker();
      markPrice = 100;
      tradeManager = new TradeManager({
        db,
        broker: mockBroker,
        brokerMode: 'BINANCE_DEMO',
        getMarkPrice: () => markPrice,
      });
      confluenceEngine = new ConfluenceEngine();
      guard = new PropFirmRiskGuard(repo);
      autoPilot = new AutoPilotManager({
        db,
        tradeManager,
        broker: mockBroker,
        confluenceEngine,
        propFirmRiskGuard: guard,
        getMarkPrice: () => markPrice,
        getAtr: () => 2.0, // SL distance = 1.5 * 2.0 = $3.00 -> max qty = 250 / 3.10 ≈ 80.645
        config: {
          enabled: true,
          consensusThreshold: 4,
          marginAllocationPct: 10, // $5,000 margin * 10x = $50,000 notional -> unclamped qty = 500 -> risk ~$1,550!
          leverage: 10,
        },
      });
    });

    it('clamps entry quantity so stop-loss risk never exceeds $250.00', async () => {
      setBuySnapshot();
      await autoPilot.onTick('SOLUSDT', 100);

      expect(mockBroker.openOrderCalls).toHaveLength(1);
      const req = mockBroker.openOrderCalls[0];
      const entryPrice = req.limitPrice ?? markPrice;
      const stopLoss = req.stopLoss; // 100 - 3.00 = 97.00
      const executedQty = (req.marginUsd * req.leverage) / entryPrice;
      const riskAtStop = executedQty * Math.abs(entryPrice - stopLoss);

      // Unclamped margin would be $5,000 ($1,550 risk); clamped risk must be <= $250.05
      expect(req.marginUsd).toBeLessThan(1_000);
      expect(riskAtStop).toBeLessThanOrEqual(250.05);
      expect(autoPilot.getState()).toBe('POSITION_OPEN');
    });

    it('emergency-closes open position on intra-tick -$1,250 floating drawdown and blocks re-entry', async () => {
      // Insert an open position directly so we can drive a clean -$1,250 floating drawdown without hitting SL first
      const tradesRepo = new TradesRepo(db);
      const trade: TradeRecord = {
        id: 'prop_open_1',
        symbol: 'SOLUSDT',
        broker_mode: 'BINANCE_DEMO',
        side: 'BUY',
        status: 'OPEN',
        entry_price: 100,
        exit_price: null,
        quantity: 250,
        remaining_qty: 250,
        leverage: 10,
        margin_usd: 2500,
        stop_loss: 80,
        tp1: 110,
        tp2: 120,
        be_price: null,
        is_breakeven: 0,
        peak_price: 100,
        peak_mfe: 0,
        trailing_stop_active: 0,
        client_order_id: 'c_prop_1',
        client_sl_id: null,
        client_tp1_id: null,
        client_tp2_id: null,
        entry_order_id: null,
        sl_algo_id: null,
        tp1_algo_id: null,
        tp2_algo_id: null,
        realized_pnl: 0,
        fees_usd: 0,
        exit_reason: null,
        opened_at: Date.now(),
        closed_at: null,
      };
      tradesRepo.insert(trade);
      mockBroker.position = {
        symbol: 'SOLUSDT',
        positionAmt: 250,
        entryPrice: 100,
        markPrice: 95,
        unRealizedProfit: -1250,
        liquidationPrice: 80,
        leverage: 10,
      };

      // Tick at $95 -> floating loss = (95 - 100) * 250 = -$1,250 -> UPCOMERS_DAILY_HALT emergency close!
      markPrice = 95;
      await autoPilot.onTick('SOLUSDT', 95);

      expect(mockBroker.closePositionCalls).toHaveLength(1);
      const closed = tradesRepo.getById('prop_open_1')!;
      expect(closed.status).toBe('CLOSED');
      expect(closed.exit_reason).toBe('UPCOMERS_DAILY_HALT');
      expect(guard.getStatus().cycle.status).toBe('HALTED_DAILY_BUFFER');
      expect(guard.getStatus().cycle.tradesCount).toBe(1);

      // Bypass 180s lockout and attempt re-entry on subsequent tick -> must remain blocked!
      (autoPilot as any).lastExitTime = Date.now() - 200_000;
      setBuySnapshot();
      await autoPilot.onTick('SOLUSDT', 100);
      expect(mockBroker.openOrderCalls).toHaveLength(0);
    });

    it('does NOT double-count tradesCount when trade status is PARTIALLY_CLOSED', () => {
      const partialTrade: TradeRecord = {
        id: 'partial_trade_1',
        symbol: 'SOLUSDT',
        broker_mode: 'BINANCE_DEMO',
        side: 'BUY',
        status: 'PARTIALLY_CLOSED',
        entry_price: 100,
        exit_price: null,
        quantity: 10,
        remaining_qty: 5,
        leverage: 10,
        margin_usd: 100,
        stop_loss: 95,
        tp1: 105,
        tp2: 110,
        be_price: null,
        is_breakeven: 0,
        client_order_id: 'c_p1',
        client_sl_id: null,
        client_tp1_id: null,
        client_tp2_id: null,
        entry_order_id: null,
        sl_algo_id: null,
        tp1_algo_id: null,
        tp2_algo_id: null,
        realized_pnl: 25,
        fees_usd: 0,
        exit_reason: 'TAKE_PROFIT_1',
        opened_at: Date.now(),
        closed_at: null,
      };

      (autoPilot as any).handlePositionClosed(partialTrade);
      expect(guard.getStatus().cycle.tradesCount).toBe(0);

      // Once fully CLOSED, records exactly once (even if invoked twice with same ID)
      const closedTrade: TradeRecord = {
        ...partialTrade,
        status: 'CLOSED',
        remaining_qty: 0,
        realized_pnl: 60,
        closed_at: Date.now(),
      };
      (autoPilot as any).handlePositionClosed(closedTrade);
      (autoPilot as any).handlePositionClosed(closedTrade);
      expect(guard.getStatus().cycle.tradesCount).toBe(1);
      expect(guard.getStatus().cycle.winCount).toBe(1);
    });
  });

  // --------------------------------------------------------------------------
  // Task 2 TDD: Two-Phase Target Close, Fee Cushion, Crash-Safe Realized PnL,
  // Rollover Delegation, Azerbaijani Top-Up Copy & Markdown Certificate Export
  // --------------------------------------------------------------------------
  describe('Task 2: Two-phase target close, fee cushion, crash-safe ledger, rollover & Markdown export', () => {
    it('evaluateLiveEquity_defersPassedWhenOpenAndAppliesFeeCushion', () => {
      const guard = new PropFirmRiskGuard(repo);
      const t0 = Date.UTC(2026, 10, 25, 14, 0, 0);

      // +$2,505 floating with $12 estimated close fee -> $52,493 < $52,500 -> stays ACTIVE, no exit signal
      const belowCushion = guard.evaluateLiveEquity({
        realizedCyclePnlUsd: 0,
        unrealizedPnlUsd: 2_505,
        liveWalletBalanceUsd: 50_000,
        hasOpenPosition: true,
        estimatedCloseFeeUsd: 12,
        nowMs: t0,
      });
      expect(belowCushion.status.cycle.status).toBe('ACTIVE');
      expect(belowCushion.status.cycle.closedAt).toBeNull();
      expect(belowCushion.cycleJustPassed).toBe(false);
      expect(belowCushion.emergencyExitReason).toBeNull();

      // +$2,515 floating with $12 close fee -> $52,503 >= $52,500 -> emits PROPFIRM_TARGET_REACHED, stays ACTIVE
      const targetHit = guard.evaluateLiveEquity({
        realizedCyclePnlUsd: 0,
        unrealizedPnlUsd: 2_515,
        liveWalletBalanceUsd: 50_000,
        hasOpenPosition: true,
        estimatedCloseFeeUsd: 12,
        nowMs: t0 + 1_000,
      });
      expect(targetHit.status.cycle.status).toBe('ACTIVE');
      expect(targetHit.status.cycle.closedAt).toBeNull();
      expect(targetHit.cycleJustPassed).toBe(false);
      expect(targetHit.emergencyExitReason).toBe('PROPFIRM_TARGET_REACHED');

      // Watchdogs remain armed if price reverses before fill settles:
      // HWM climbed to $52,515 -> internal trailing floor is $50,015 -> pullback to +$15 triggers HALTED_TRAILING_BUFFER
      const reversed = guard.evaluateLiveEquity({
        realizedCyclePnlUsd: 0,
        unrealizedPnlUsd: 15,
        liveWalletBalanceUsd: 50_000,
        hasOpenPosition: true,
        estimatedCloseFeeUsd: 12,
        nowMs: t0 + 2_000,
      });
      expect(reversed.status.cycle.status).toBe('HALTED_TRAILING_BUFFER');
      expect(reversed.emergencyExitReason).toBe('UPCOMERS_TRAILING_HALT');
    });

    it('recordTradeClosed_idempotentAndStaysActiveIfPostFeeBelowTarget', () => {
      const guard = new PropFirmRiskGuard(repo);
      const t0 = Date.UTC(2026, 10, 25, 14, 10, 0);

      // Post-fee realized < $52,500 -> stays ACTIVE and persists realizedPnlUsd
      const partialStep = guard.recordTradeClosed({
        tradeId: 'trade_fee_short_1',
        realizedNetPnlUsd: 2_490,
        liveWalletBalanceUsd: 50_000,
        nowMs: t0,
      });
      expect(partialStep.cycle.status).toBe('ACTIVE');
      expect(partialStep.cycle.realizedPnlUsd).toBe(2_490);
      expect(partialStep.cycle.tradesCount).toBe(1);

      // Duplicate tradeId is an idempotent no-op
      const duplicate = guard.recordTradeClosed({
        tradeId: 'trade_fee_short_1',
        realizedNetPnlUsd: 2_490,
        liveWalletBalanceUsd: 50_000,
        nowMs: t0 + 500,
      });
      expect(duplicate.cycle.tradesCount).toBe(1);
      expect(duplicate.cycle.realizedPnlUsd).toBe(2_490);
      expect(duplicate.cycle.status).toBe('ACTIVE');

      // Second trade pushes realized >= $52,500 -> transitions to PASSED with hasOpenPosition: false
      const passed = guard.recordTradeClosed({
        tradeId: 'trade_finish_2',
        realizedNetPnlUsd: 15,
        liveWalletBalanceUsd: 50_000,
        nowMs: t0 + 1_000,
      });
      expect(passed.cycle.status).toBe('PASSED');
      expect(passed.cycle.realizedPnlUsd).toBe(2_505);
      expect(passed.cycle.tradesCount).toBe(2);
      expect(passed.cycle.closedAt).toBe(t0 + 1_000);
    });

    it('crashRestartRecovery_doesNotDoubleCountUnrealizedPnlAndAnchorsFundedWallet', () => {
      const guard1 = new PropFirmRiskGuard(repo);
      const t0 = Date.UTC(2026, 10, 25, 14, 20, 0);

      // Open trade has +$500 floating profit, 0 realized profit
      const beforeCrash = guard1.evaluateLiveEquity({
        realizedCyclePnlUsd: 0,
        unrealizedPnlUsd: 500,
        liveWalletBalanceUsd: 50_000,
        hasOpenPosition: true,
        nowMs: t0,
      });
      expect(beforeCrash.status.cycle.netPnlUsd).toBe(500);
      expect(beforeCrash.status.cycle.realizedPnlUsd).toBe(0);

      // Simulate server crash & restart with a fresh PropFirmRiskGuard instance
      const guard2 = new PropFirmRiskGuard(repo);
      expect(guard2.getCurrentRealizedCyclePnl()).toBe(0);

      const afterRestart = guard2.evaluateLiveEquity({
        realizedCyclePnlUsd: guard2.getCurrentRealizedCyclePnl(),
        unrealizedPnlUsd: 500,
        liveWalletBalanceUsd: 50_000,
        hasOpenPosition: true,
        nowMs: t0 + 5_000,
      });
      expect(afterRestart.status.cycle.netPnlUsd).toBe(500);

      // Funded wallet ($55,000) still anchors challenge equity to 50_000 + realized + unrealized
      const fundedEval = guard2.evaluateLiveEquity({
        realizedCyclePnlUsd: 400,
        unrealizedPnlUsd: 300,
        liveWalletBalanceUsd: 55_000,
        hasOpenPosition: true,
        nowMs: t0 + 10_000,
      });
      expect(fundedEval.status.cycle.currentEquityUsd).toBe(50_700);
      expect(fundedEval.status.cycle.netPnlUsd).toBe(700);
      expect(fundedEval.status.needsTopUp).toBe(false);
    });

    it('startNewCycle_delegatesToRolloverCycleAndPropagatesPropFirmConflictError', () => {
      const guard = new PropFirmRiskGuard(repo);
      const t0 = Date.UTC(2026, 10, 25, 14, 30, 0);

      // Cannot rollover while Cycle #1 is ACTIVE
      expect(() => guard.startNewCycle(50_000, t0)).toThrow(PropFirmConflictError);
      try {
        guard.startNewCycle(50_000, t0);
      } catch (err) {
        expect(err).toBeInstanceOf(PropFirmConflictError);
        expect((err as PropFirmConflictError).code).toBe('CYCLE_STILL_ACTIVE');
      }

      // Pass Cycle #1, then insert an OPEN trade -> must reject with OPEN_POSITION_EXISTS
      guard.recordTradeClosed({
        tradeId: 't_pass_1',
        realizedNetPnlUsd: 2_550,
        liveWalletBalanceUsd: 50_000,
        nowMs: t0 + 1_000,
      });
      const tradesRepo = new TradesRepo(db);
      tradesRepo.insert({
        id: 'open_conflict_1',
        symbol: 'BTCUSDT',
        broker_mode: 'BINANCE_DEMO',
        side: 'BUY',
        status: 'OPEN',
        entry_price: 90_000,
        exit_price: null,
        quantity: 0.01,
        remaining_qty: 0.01,
        leverage: 10,
        margin_usd: 90,
        stop_loss: 89_000,
        tp1: 91_000,
        tp2: 92_000,
        be_price: null,
        is_breakeven: 0,
        client_order_id: 'c_open_conflict',
        client_sl_id: null,
        client_tp1_id: null,
        client_tp2_id: null,
        entry_order_id: null,
        sl_algo_id: null,
        tp1_algo_id: null,
        tp2_algo_id: null,
        realized_pnl: 0,
        fees_usd: 0,
        exit_reason: null,
        opened_at: t0 + 2_000,
        closed_at: null,
      });

      try {
        guard.startNewCycle(50_000, t0 + 3_000);
        expect.fail('Expected PropFirmConflictError');
      } catch (err) {
        expect(err).toBeInstanceOf(PropFirmConflictError);
        expect((err as PropFirmConflictError).code).toBe('OPEN_POSITION_EXISTS');
      }

      // Close open trade -> rollover succeeds cleanly to Cycle #2
      tradesRepo.update('open_conflict_1', { status: 'CLOSED', closed_at: t0 + 4_000 });
      const cycle2Status = guard.startNewCycle(50_000, t0 + 5_000);
      expect(cycle2Status.cycle.cycleNumber).toBe(2);
      expect(cycle2Status.cycle.status).toBe('ACTIVE');
      expect(cycle2Status.cycle.realizedPnlUsd).toBe(0);
    });

    it('topUpMessage_isPureAzerbaijaniAndFormatCertificateMarkdownHandlesNegativeUsd', () => {
      const guard = new PropFirmRiskGuard(repo);
      const t0 = Date.UTC(2026, 10, 25, 14, 40, 0);

      const status = guard.getStatus(4_606.01, t0);
      expect(status.needsTopUp).toBe(true);
      expect(status.topUpMessage).toContain('Binance Demo Faucet');
      expect(status.topUpMessage).toContain('$50,000.00');
      expect(status.topUpMessage).not.toMatch(/top-up required|simulated PnL remains/i);

      // Record a failed cycle (-$1,250.00) and then a passed cycle (+$2,510.00)
      guard.evaluateLiveEquity({
        realizedCyclePnlUsd: -1_520,
        unrealizedPnlUsd: 0,
        liveWalletBalanceUsd: 4_606.01,
        nowMs: t0 + 1_000,
      });
      guard.startNewCycle(4_606.01, t0 + 2_000);
      guard.recordTradeClosed({
        tradeId: 't_win_md',
        realizedNetPnlUsd: 2_510,
        liveWalletBalanceUsd: 4_606.01,
        nowMs: t0 + 3_000,
      });

      const cert = guard.getCertificateStatus(t0 + 4_000);
      // Force a -$1,250.00 row check as well
      const md = formatPropFirmCertificateMarkdown({
        ...cert,
        cycles: [
          ...cert.cycles,
          {
            ...cert.cycles[0],
            id: 'synthetic_neg_cycle',
            cycleNumber: 99,
            status: 'FAILED_DAILY',
            currentEquityUsd: 48_750,
            netPnlUsd: -1_250,
            realizedPnlUsd: -1_250,
            netPnlPct: -2.5,
            maxDrawdownUsd: 1_250,
            closedAt: t0 + 5_000,
          },
        ],
      });

      expect(md).not.toContain('$-');
      expect(md).toContain('-$1,250.00');
      expect(md).toContain('-$1,520.00');
      expect(md).toContain('+$2,510.00');
      expect(md).toContain('1 / 5');
      expect(md).toContain('| # |');
      expect(md).toContain('DAVAM EDİR');
    });
  });
});
