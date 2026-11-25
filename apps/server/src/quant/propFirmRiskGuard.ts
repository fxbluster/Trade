import crypto from 'node:crypto';
import {
  UPCOMERS_1STEP_50K_DEFAULT,
  type UpcomersChallengeConfig,
  type PropFirmChallengeCycle,
  type PropFirmCycleStatus,
  type PropFirmDailySnapshot,
  type PropFirmQuestionVerdict,
  type PropFirmStatusResponse,
  type PropFirmCertificateResponse,
  type BlockReason,
} from '@tradeos/shared';
import {
  PropFirmConflictError,
  type PropFirmConflictCode,
  type PropFirmRepo,
} from '../db/sqlite.js';

export { PropFirmConflictError, type PropFirmConflictCode };

const ZERO_DISTANCE_EPSILON = 1e-8;
const TOP_UP_THRESHOLD_USD = 49_000;
const REQUIRED_PASSED_CYCLES = 5;
const TOP_UP_MESSAGE =
  'Binance Testnet balansı $50,000.00 həddindən aşağıdır. Simulyasiya $50,000.00 kapitala sabitlənib; real ölçülü test üçün Binance Demo Faucet vasitəsilə USDT balansını $50,000.00-ə tamamlayın.';

function round2(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Number(value.toFixed(2));
}

function toUtcDateString(timestampMs: number): string {
  const safeTs = Number.isFinite(timestampMs) ? timestampMs : Date.now();
  return new Date(safeTs).toISOString().slice(0, 10);
}

function isTerminalStatus(status: PropFirmCycleStatus): boolean {
  return status === 'PASSED' || status === 'FAILED_DAILY' || status === 'FAILED_TRAILING';
}

/**
 * Calculates the maximum position quantity that caps single-trade risk at Stop-Loss
 * to `maxRiskUsd` (default $250.00 = 0.50% of $50,000 Upcomers account).
 * Fail-closed: returns 0 if inputs are non-finite, maxRiskUsd <= 0, or |entry - sl| <= 1e-8.
 */
export function calculateUpcomersMaxQty(
  entryPrice: number,
  stopLossPrice: number,
  maxRiskUsd: number = UPCOMERS_1STEP_50K_DEFAULT.maxRiskPerTradeUsd
): number {
  if (
    !Number.isFinite(entryPrice) ||
    !Number.isFinite(stopLossPrice) ||
    !Number.isFinite(maxRiskUsd) ||
    maxRiskUsd <= 0
  ) {
    return 0;
  }

  const stopDistance = Math.abs(entryPrice - stopLossPrice);
  if (!Number.isFinite(stopDistance) || stopDistance <= ZERO_DISTANCE_EPSILON) {
    return 0;
  }

  const qty = Number((maxRiskUsd / stopDistance).toFixed(4));
  return Number.isFinite(qty) && qty > 0 ? qty : 0;
}

/**
 * Computes Upcomers Dynamic Risk Shield contractual ($3,000) and internal pre-violation ($2,500)
 * trailing floors from High-Water Mark.
 * Permanently locks contractual floor at $50,000.00 (internal halt floor $50,500.00)
 * once HWM >= $53,000.00 (+6.0%).
 */
export function calculateUpcomersTrailingFloors(
  highWaterMarkUsd: number,
  config: UpcomersChallengeConfig = UPCOMERS_1STEP_50K_DEFAULT
): {
  contractualFloorUsd: number;
  internalHaltFloorUsd: number;
  isFloorLocked: boolean;
} {
  const safeHwm = Number.isFinite(highWaterMarkUsd) ? highWaterMarkUsd : config.accountSizeUsd;
  const safetyCushionUsd = Math.max(
    0,
    config.contractualTrailingLossUsd - config.internalTrailingHaltUsd
  );

  if (safeHwm >= config.trailingLockHwmUsd) {
    return {
      contractualFloorUsd: round2(config.lockedTrailingFloorUsd),
      internalHaltFloorUsd: round2(config.lockedTrailingFloorUsd + safetyCushionUsd),
      isFloorLocked: true,
    };
  }

  return {
    contractualFloorUsd: round2(safeHwm - config.contractualTrailingLossUsd),
    internalHaltFloorUsd: round2(safeHwm - config.internalTrailingHaltUsd),
    isFloorLocked: false,
  };
}

export interface CanOpenTradeResult {
  allowed: boolean;
  reason?: 'UPCOMERS_DAILY_HALT' | 'UPCOMERS_TRAILING_HALT' | 'CYCLE_TERMINAL';
  details?: string;
}

export interface ClampEntryQuantityParams {
  desiredQty: number;
  entryPrice: number;
  stopLossPrice: number;
}

export interface ClampEntryQuantityResult {
  qty: number;
  clampedByRisk: boolean;
  maxRiskQty: number;
  riskUsdAtStop: number;
}

export interface EvaluateLiveEquityParams {
  realizedCyclePnlUsd: number;
  unrealizedPnlUsd: number;
  liveWalletBalanceUsd: number;
  hasOpenPosition?: boolean;
  estimatedCloseFeeUsd?: number;
  nowMs?: number;
}

export interface EvaluateLiveEquityResult {
  status: PropFirmStatusResponse;
  emergencyExitReason:
    | 'UPCOMERS_DAILY_HALT'
    | 'UPCOMERS_TRAILING_HALT'
    | 'PROPFIRM_TARGET_REACHED'
    | null;
  cycleJustPassed: boolean;
}

export interface RecordTradeClosedParams {
  tradeId?: string;
  realizedNetPnlUsd: number;
  liveWalletBalanceUsd: number;
  nowMs?: number;
}

/**
 * Upcomers $50,000 "1-Step Thunderbolt" Prop Firm Challenge & Pre-Violation Risk Guard.
 *
 * Enforces:
 * - Starting baseline: $50,000.00 (profit target +$2,500.00 -> $52,500.00).
 * - Daily loss guard: internal auto-halt at -$1,250.00 (-2.5%), contractual fail at -$1,500.00 (-3.0%).
 * - Trailing drawdown guard: internal auto-halt at -$2,500.00 (-5.0%), contractual fail at -$3,000.00 (-6.0%).
 * - Monotonic HWM floor lock: locks contractual floor at $50,000.00 ($50,500.00 internal) once HWM >= $53,000.00.
 * - Per-trade max risk clamp: <= $250.00 (0.50%) at Stop-Loss, fail-closed on invalid/zero SL distance.
 * - Automatic 00:00 UTC daily baseline rollover lifting transient HALTED_DAILY_BUFFER without resurrecting terminal cycles.
 * - Sub-$50K Testnet wallet resilience: anchors challenge equity to $50,000 + cycle PnL and sets needsTopUp = true.
 */
export class PropFirmRiskGuard {
  private readonly repo: PropFirmRepo;
  private readonly config: UpcomersChallengeConfig;
  private readonly onStatusUpdate?: (status: PropFirmStatusResponse) => void;
  private readonly realizedCyclePnlByCycleId = new Map<string, number>();
  private readonly recordedTradeIds = new Set<string>();
  private lastLiveWalletBalanceUsd: number = 0;

  constructor(
    repo: PropFirmRepo,
    config?: Partial<UpcomersChallengeConfig>,
    onStatusUpdate?: (status: PropFirmStatusResponse) => void
  ) {
    this.repo = repo;
    this.config = {
      ...UPCOMERS_1STEP_50K_DEFAULT,
      ...config,
    };
    this.onStatusUpdate = onStatusUpdate;

    const existing = this.repo.getActiveCycle() ?? this.repo.getLatestCycle();
    if (!existing) {
      this.createFreshCycle(Date.now());
    } else {
      this.realizedCyclePnlByCycleId.set(existing.id, existing.realizedPnlUsd ?? 0);
    }
  }

  public getConfig(): UpcomersChallengeConfig {
    return { ...this.config };
  }

  public getCurrentRealizedCyclePnl(): number {
    const cycle = this.getOrInitCycle(Date.now());
    return this.getRealizedCyclePnl(cycle);
  }

  public canOpenTrade(nowMs: number = Date.now()): CanOpenTradeResult {
    const cycle = this.getOrInitCycle(nowMs);
    this.ensureDailyRollover(cycle, nowMs);

    if (cycle.status === 'ACTIVE') {
      return { allowed: true };
    }

    if (cycle.status === 'HALTED_DAILY_BUFFER') {
      return {
        allowed: false,
        reason: 'UPCOMERS_DAILY_HALT',
        details: `Upcomers internal daily loss buffer (-$${this.config.internalDailyHaltUsd.toFixed(2)}) reached; entries halted until 00:00 UTC rollover.`,
      };
    }

    if (cycle.status === 'HALTED_TRAILING_BUFFER') {
      return {
        allowed: false,
        reason: 'UPCOMERS_TRAILING_HALT',
        details: `Upcomers internal trailing drawdown buffer (-$${this.config.internalTrailingHaltUsd.toFixed(2)}) reached; entries halted.`,
      };
    }

    return {
      allowed: false,
      reason: 'CYCLE_TERMINAL',
      details: `Upcomers challenge cycle #${cycle.cycleNumber} is terminal (${cycle.status}); start a new cycle to trade.`,
    };
  }

  public clampEntryQuantity(params: ClampEntryQuantityParams): ClampEntryQuantityResult {
    const maxRiskQty = calculateUpcomersMaxQty(
      params.entryPrice,
      params.stopLossPrice,
      this.config.maxRiskPerTradeUsd
    );

    if (!Number.isFinite(params.desiredQty) || params.desiredQty <= 0 || maxRiskQty <= 0) {
      return {
        qty: 0,
        clampedByRisk: maxRiskQty <= 0 && Number.isFinite(params.desiredQty) && params.desiredQty > 0,
        maxRiskQty,
        riskUsdAtStop: 0,
      };
    }

    const clampedByRisk = params.desiredQty > maxRiskQty;
    const qty = Number((clampedByRisk ? maxRiskQty : params.desiredQty).toFixed(4));
    const stopDistance = Math.abs(params.entryPrice - params.stopLossPrice);
    const riskUsdAtStop = round2(qty * stopDistance);

    return {
      qty,
      clampedByRisk,
      maxRiskQty,
      riskUsdAtStop,
    };
  }

  public evaluateLiveEquity(params: EvaluateLiveEquityParams): EvaluateLiveEquityResult {
    const nowMs = params.nowMs ?? Date.now();
    const safeRealized = Number.isFinite(params.realizedCyclePnlUsd) ? params.realizedCyclePnlUsd : 0;
    const safeUnrealized = Number.isFinite(params.unrealizedPnlUsd) ? params.unrealizedPnlUsd : 0;
    const safeWallet = Number.isFinite(params.liveWalletBalanceUsd)
      ? params.liveWalletBalanceUsd
      : this.lastLiveWalletBalanceUsd;

    if (Number.isFinite(params.liveWalletBalanceUsd) && params.liveWalletBalanceUsd >= 0) {
      this.lastLiveWalletBalanceUsd = params.liveWalletBalanceUsd;
    }

    const cycle = this.getOrInitCycle(nowMs);
    this.realizedCyclePnlByCycleId.set(cycle.id, safeRealized);

    // Terminal cycles are immutable — never resurrect or re-pass them
    if (isTerminalStatus(cycle.status)) {
      const snapshot = this.getOrBuildReadOnlySnapshot(cycle, nowMs);
      const status = this.buildStatusResponse(cycle, snapshot, safeWallet, nowMs);
      return {
        status,
        emergencyExitReason: null,
        cycleJustPassed: false,
      };
    }

    // 1. Perform automatic 00:00 UTC rollover BEFORE evaluating current tick's PnL
    const snapshot = this.ensureDailyRollover(cycle, nowMs);

    // 2. Compute challenge equity (always anchored to $50k + realized + unrealized cycle PnL)
    const currentEquityUsd = this.computeChallengeEquityUsd(
      cycle,
      safeRealized,
      safeUnrealized
    );
    const positionOpen = params.hasOpenPosition ?? Math.abs(safeUnrealized) > 0;
    const safeCloseFee =
      positionOpen &&
      typeof params.estimatedCloseFeeUsd === 'number' &&
      Number.isFinite(params.estimatedCloseFeeUsd)
        ? Math.max(0, params.estimatedCloseFeeUsd)
        : 0;

    // 3. Monotonic High-Water Mark & Trailing Floors ($53k -> $50k permanent lock)
    const highWaterMarkUsd = round2(Math.max(cycle.highWaterMarkUsd, currentEquityUsd));
    const computedFloors = calculateUpcomersTrailingFloors(highWaterMarkUsd, this.config);
    const safetyCushionUsd = Math.max(
      0,
      this.config.contractualTrailingLossUsd - this.config.internalTrailingHaltUsd
    );
    const isFloorLocked = cycle.isFloorLocked || computedFloors.isFloorLocked;
    const contractualTrailingFloorUsd = isFloorLocked
      ? round2(this.config.lockedTrailingFloorUsd)
      : computedFloors.contractualFloorUsd;
    const internalTrailingFloorUsd = isFloorLocked
      ? round2(this.config.lockedTrailingFloorUsd + safetyCushionUsd)
      : computedFloors.internalHaltFloorUsd;

    // 4. Net PnL, Drawdown, Daily PnL
    const netPnlUsd = round2(currentEquityUsd - cycle.startingBalanceUsd);
    const netPnlPct =
      cycle.startingBalanceUsd > 0 ? round2((netPnlUsd / cycle.startingBalanceUsd) * 100) : 0;
    const currentDrawdownUsd = round2(Math.max(0, highWaterMarkUsd - currentEquityUsd));
    const maxDrawdownUsd = round2(Math.max(cycle.maxDrawdownUsd, currentDrawdownUsd));
    const dailyPnlUsd = round2(currentEquityUsd - snapshot.dayStartEquityUsd);
    const dailyMinEquityUsd = round2(Math.min(snapshot.dailyMinEquityUsd, currentEquityUsd));

    // 5. Evaluate Trailing, Daily, and Profit Target transitions
    let nextStatus: PropFirmCycleStatus = cycle.status;
    let emergencyExitReason: EvaluateLiveEquityResult['emergencyExitReason'] = null;
    let cycleJustPassed = false;
    let closedAt: number | null = cycle.closedAt;
    let dailyHalted = snapshot.dailyHalted;

    if (currentEquityUsd <= contractualTrailingFloorUsd) {
      nextStatus = 'FAILED_TRAILING';
      emergencyExitReason = 'UPCOMERS_TRAILING_HALT';
      closedAt = closedAt ?? nowMs;
    } else if (currentEquityUsd <= internalTrailingFloorUsd) {
      nextStatus = 'HALTED_TRAILING_BUFFER';
      emergencyExitReason = 'UPCOMERS_TRAILING_HALT';
    } else if (dailyPnlUsd <= -this.config.contractualDailyLossUsd) {
      nextStatus = 'FAILED_DAILY';
      emergencyExitReason = 'UPCOMERS_DAILY_HALT';
      dailyHalted = true;
      closedAt = closedAt ?? nowMs;
    } else if (dailyPnlUsd <= -this.config.internalDailyHaltUsd) {
      nextStatus = 'HALTED_DAILY_BUFFER';
      emergencyExitReason = 'UPCOMERS_DAILY_HALT';
      dailyHalted = true;
    } else if (
      nextStatus === 'ACTIVE' &&
      currentEquityUsd - safeCloseFee >= cycle.startingBalanceUsd + cycle.profitTargetUsd
    ) {
      if (positionOpen) {
        emergencyExitReason = 'PROPFIRM_TARGET_REACHED';
      } else {
        nextStatus = 'PASSED';
        cycleJustPassed = true;
        closedAt = closedAt ?? nowMs;
      }
    }

    // 6. Persist updated cycle and daily snapshot to SQLite
    cycle.status = nextStatus;
    cycle.currentEquityUsd = currentEquityUsd;
    cycle.highWaterMarkUsd = highWaterMarkUsd;
    cycle.contractualTrailingFloorUsd = contractualTrailingFloorUsd;
    cycle.internalTrailingFloorUsd = internalTrailingFloorUsd;
    cycle.isFloorLocked = isFloorLocked;
    cycle.netPnlUsd = netPnlUsd;
    cycle.netPnlPct = netPnlPct;
    cycle.maxDrawdownUsd = maxDrawdownUsd;
    cycle.closedAt = closedAt;

    this.repo.updateCycle(cycle.id, {
      status: cycle.status,
      currentEquityUsd: cycle.currentEquityUsd,
      highWaterMarkUsd: cycle.highWaterMarkUsd,
      contractualTrailingFloorUsd: cycle.contractualTrailingFloorUsd,
      internalTrailingFloorUsd: cycle.internalTrailingFloorUsd,
      isFloorLocked: cycle.isFloorLocked,
      netPnlUsd: cycle.netPnlUsd,
      netPnlPct: cycle.netPnlPct,
      maxDrawdownUsd: cycle.maxDrawdownUsd,
      closedAt: cycle.closedAt,
    });

    const updatedSnapshot: PropFirmDailySnapshot = {
      utcDate: snapshot.utcDate,
      cycleId: cycle.id,
      dayStartEquityUsd: snapshot.dayStartEquityUsd,
      currentEquityUsd,
      dailyPnlUsd,
      dailyMinEquityUsd,
      dailyHalted,
      updatedAt: nowMs,
    };
    this.repo.upsertDailySnapshot(updatedSnapshot);

    const status = this.buildStatusResponse(cycle, updatedSnapshot, safeWallet, nowMs);
    this.emitStatusUpdate(status);

    return {
      status,
      emergencyExitReason,
      cycleJustPassed,
    };
  }

  public recordTradeClosed(params: RecordTradeClosedParams): PropFirmStatusResponse {
    const nowMs = params.nowMs ?? Date.now();
    if (params.tradeId) {
      if (this.recordedTradeIds.has(params.tradeId)) {
        return this.getStatus(params.liveWalletBalanceUsd, nowMs);
      }
      this.recordedTradeIds.add(params.tradeId);
    }

    const safePnl = Number.isFinite(params.realizedNetPnlUsd) ? params.realizedNetPnlUsd : 0;
    const cycle = this.getOrInitCycle(nowMs);

    const prevRealized = this.getRealizedCyclePnl(cycle);
    const nextRealized = round2(prevRealized + safePnl);
    this.realizedCyclePnlByCycleId.set(cycle.id, nextRealized);

    const tradesCount = cycle.tradesCount + 1;
    const winCount = safePnl > 0 ? cycle.winCount + 1 : cycle.winCount;
    const lossCount = safePnl < 0 ? cycle.lossCount + 1 : cycle.lossCount;

    cycle.realizedPnlUsd = nextRealized;
    cycle.tradesCount = tradesCount;
    cycle.winCount = winCount;
    cycle.lossCount = lossCount;

    this.repo.updateCycle(cycle.id, {
      realizedPnlUsd: nextRealized,
      tradesCount,
      winCount,
      lossCount,
    });

    const evalResult = this.evaluateLiveEquity({
      realizedCyclePnlUsd: nextRealized,
      unrealizedPnlUsd: 0,
      liveWalletBalanceUsd: params.liveWalletBalanceUsd,
      hasOpenPosition: false,
      nowMs,
    });

    return evalResult.status;
  }

  public startNewCycle(
    liveWalletBalanceUsd?: number,
    nowMs: number = Date.now()
  ): PropFirmStatusResponse {
    const nextCycle = this.buildFreshCycleRecord(nowMs);
    const cycle = this.repo.rolloverCycle(nextCycle);

    if (liveWalletBalanceUsd !== undefined && Number.isFinite(liveWalletBalanceUsd)) {
      this.lastLiveWalletBalanceUsd = liveWalletBalanceUsd;
    }
    this.realizedCyclePnlByCycleId.set(cycle.id, 0);

    const snapshot = this.ensureDailyRollover(cycle, nowMs);
    const wallet =
      liveWalletBalanceUsd !== undefined && Number.isFinite(liveWalletBalanceUsd)
        ? liveWalletBalanceUsd
        : this.lastLiveWalletBalanceUsd;

    const status = this.buildStatusResponse(cycle, snapshot, wallet, nowMs);
    this.emitStatusUpdate(status);
    return status;
  }

  public getStatus(
    liveWalletBalanceUsd?: number,
    nowMs: number = Date.now()
  ): PropFirmStatusResponse {
    if (liveWalletBalanceUsd !== undefined && Number.isFinite(liveWalletBalanceUsd)) {
      this.lastLiveWalletBalanceUsd = liveWalletBalanceUsd;
    }

    const cycle = this.getOrInitCycle(nowMs);
    const snapshot = isTerminalStatus(cycle.status)
      ? this.getOrBuildReadOnlySnapshot(cycle, nowMs)
      : this.ensureDailyRollover(cycle, nowMs);
    const wallet =
      liveWalletBalanceUsd !== undefined && Number.isFinite(liveWalletBalanceUsd)
        ? liveWalletBalanceUsd
        : this.lastLiveWalletBalanceUsd;

    return this.buildStatusResponse(cycle, snapshot, wallet, nowMs);
  }

  public getCertificateStatus(nowMs: number = Date.now()): PropFirmCertificateResponse {
    const cycles = this.repo.listCycles(50);
    const consecutivePassedCycles = this.repo.countConsecutivePassedCycles();
    const totalCompletedCycles = cycles.filter((c) => isTerminalStatus(c.status)).length;
    const remainingCycles = Math.max(0, REQUIRED_PASSED_CYCLES - consecutivePassedCycles);

    return {
      certified: consecutivePassedCycles >= REQUIRED_PASSED_CYCLES,
      consecutivePassedCycles,
      requiredPassedCycles: REQUIRED_PASSED_CYCLES,
      remainingCycles,
      totalCompletedCycles,
      cycles,
      generatedAt: nowMs,
    };
  }

  private getOrInitCycle(nowMs: number): PropFirmChallengeCycle {
    const existing = this.repo.getActiveCycle() ?? this.repo.getLatestCycle();
    if (existing) {
      if (!this.realizedCyclePnlByCycleId.has(existing.id)) {
        this.realizedCyclePnlByCycleId.set(existing.id, existing.realizedPnlUsd ?? 0);
      }
      return existing;
    }
    return this.createFreshCycle(nowMs);
  }

  private buildFreshCycleRecord(nowMs: number): PropFirmChallengeCycle {
    const cycleNumber = this.repo.getNextCycleNumber();
    const startingBalanceUsd = round2(this.config.accountSizeUsd);
    const floors = calculateUpcomersTrailingFloors(startingBalanceUsd, this.config);

    return {
      id: crypto.randomUUID(),
      cycleNumber,
      status: 'ACTIVE',
      startingBalanceUsd,
      currentEquityUsd: startingBalanceUsd,
      highWaterMarkUsd: startingBalanceUsd,
      contractualTrailingFloorUsd: floors.contractualFloorUsd,
      internalTrailingFloorUsd: floors.internalHaltFloorUsd,
      isFloorLocked: floors.isFloorLocked,
      profitTargetUsd: round2(this.config.profitTargetUsd),
      netPnlUsd: 0,
      realizedPnlUsd: 0,
      netPnlPct: 0,
      maxDrawdownUsd: 0,
      tradesCount: 0,
      winCount: 0,
      lossCount: 0,
      startedAt: nowMs,
      closedAt: null,
    };
  }

  private createFreshCycle(nowMs: number): PropFirmChallengeCycle {
    const cycle = this.buildFreshCycleRecord(nowMs);
    this.repo.createCycle(cycle);
    this.realizedCyclePnlByCycleId.set(cycle.id, 0);
    return cycle;
  }

  private getRealizedCyclePnl(cycle: PropFirmChallengeCycle): number {
    const cached = this.realizedCyclePnlByCycleId.get(cycle.id);
    if (cached !== undefined && Number.isFinite(cached)) {
      return cached;
    }
    const fallback = cycle.realizedPnlUsd ?? 0;
    this.realizedCyclePnlByCycleId.set(cycle.id, fallback);
    return fallback;
  }

  private ensureDailyRollover(
    cycle: PropFirmChallengeCycle,
    nowMs: number
  ): PropFirmDailySnapshot {
    const utcDate = toUtcDateString(nowMs);
    const existing = this.repo.getDailySnapshot(utcDate, cycle.id);
    if (existing) {
      return existing;
    }

    const baselineEquityUsd = round2(cycle.currentEquityUsd);
    const snapshot: PropFirmDailySnapshot = {
      utcDate,
      cycleId: cycle.id,
      dayStartEquityUsd: baselineEquityUsd,
      currentEquityUsd: baselineEquityUsd,
      dailyPnlUsd: 0,
      dailyMinEquityUsd: baselineEquityUsd,
      dailyHalted: false,
      updatedAt: nowMs,
    };
    this.repo.upsertDailySnapshot(snapshot);

    // Lift transient daily buffer halt on new UTC day (NEVER unlock terminal cycles or trailing halt)
    if (cycle.status === 'HALTED_DAILY_BUFFER') {
      cycle.status = 'ACTIVE';
      this.repo.updateCycle(cycle.id, { status: 'ACTIVE' });
    }

    return snapshot;
  }

  private getOrBuildReadOnlySnapshot(
    cycle: PropFirmChallengeCycle,
    nowMs: number
  ): PropFirmDailySnapshot {
    const utcDate = toUtcDateString(nowMs);
    const existing = this.repo.getDailySnapshot(utcDate, cycle.id);
    if (existing) {
      return existing;
    }
    return {
      utcDate,
      cycleId: cycle.id,
      dayStartEquityUsd: cycle.currentEquityUsd,
      currentEquityUsd: cycle.currentEquityUsd,
      dailyPnlUsd: 0,
      dailyMinEquityUsd: cycle.currentEquityUsd,
      dailyHalted: cycle.status === 'FAILED_DAILY' || cycle.status === 'HALTED_DAILY_BUFFER',
      updatedAt: nowMs,
    };
  }

  private computeChallengeEquityUsd(
    cycle: PropFirmChallengeCycle,
    realizedCyclePnlUsd: number,
    unrealizedPnlUsd: number
  ): number {
    return round2(cycle.startingBalanceUsd + realizedCyclePnlUsd + unrealizedPnlUsd);
  }

  private buildStatusResponse(
    cycle: PropFirmChallengeCycle,
    snapshot: PropFirmDailySnapshot,
    liveWalletBalanceUsd: number,
    nowMs: number
  ): PropFirmStatusResponse {
    const safeWallet = Number.isFinite(liveWalletBalanceUsd) ? round2(liveWalletBalanceUsd) : 0;
    const needsTopUp = safeWallet < TOP_UP_THRESHOLD_USD;

    const verdict: PropFirmQuestionVerdict =
      cycle.netPnlUsd > 0.005
        ? 'YES_PROFIT'
        : cycle.netPnlUsd < -0.005
          ? 'NO_LOSS'
          : 'WAITING';

    const dailyBaselineEquityUsd = round2(snapshot.dayStartEquityUsd);
    const dailyPnlUsd = round2(cycle.currentEquityUsd - dailyBaselineEquityUsd);
    const dailyLossUsedUsd = round2(Math.max(0, -dailyPnlUsd));
    const dailyBufferRemainingUsd = round2(
      Math.max(0, this.config.internalDailyHaltUsd - dailyLossUsedUsd)
    );
    const dailyBufferRemainingPct =
      this.config.internalDailyHaltUsd > 0
        ? round2((dailyBufferRemainingUsd / this.config.internalDailyHaltUsd) * 100)
        : 0;

    const trailingLossUsedUsd = round2(Math.max(0, cycle.highWaterMarkUsd - cycle.currentEquityUsd));
    const trailingBufferRemainingUsd = round2(
      Math.max(0, cycle.currentEquityUsd - cycle.internalTrailingFloorUsd)
    );
    const trailingBufferRemainingPct =
      this.config.internalTrailingHaltUsd > 0
        ? round2(
            Math.min(100, (trailingBufferRemainingUsd / this.config.internalTrailingHaltUsd) * 100)
          )
        : 0;

    const targetProgressPct =
      cycle.profitTargetUsd > 0
        ? round2(Math.max(0, Math.min(100, (cycle.netPnlUsd / cycle.profitTargetUsd) * 100)))
        : 0;
    const targetRemainingUsd = round2(Math.max(0, cycle.profitTargetUsd - cycle.netPnlUsd));

    const canTrade = cycle.status === 'ACTIVE';
    let haltReason: BlockReason | string | null = null;
    if (cycle.status === 'HALTED_DAILY_BUFFER' || cycle.status === 'FAILED_DAILY') {
      haltReason = 'UPCOMERS_DAILY_HALT';
    } else if (cycle.status === 'HALTED_TRAILING_BUFFER' || cycle.status === 'FAILED_TRAILING') {
      haltReason = 'UPCOMERS_TRAILING_HALT';
    } else if (cycle.status === 'PASSED') {
      haltReason = 'CYCLE_TERMINAL';
    }

    return {
      cycle: { ...cycle },
      verdict,
      dailyBaselineEquityUsd,
      dailyPnlUsd,
      dailyLossUsedUsd,
      dailyBufferRemainingUsd,
      dailyBufferRemainingPct,
      trailingLossUsedUsd,
      trailingBufferRemainingUsd,
      trailingBufferRemainingPct,
      targetProgressPct,
      targetRemainingUsd,
      liveWalletBalanceUsd: safeWallet,
      needsTopUp,
      topUpMessage: needsTopUp ? TOP_UP_MESSAGE : null,
      consecutivePassedCycles: this.repo.countConsecutivePassedCycles(),
      requiredPassedCycles: REQUIRED_PASSED_CYCLES,
      canTrade,
      haltReason,
      cycles: this.repo.listCycles(50),
      updatedAt: nowMs,
    };
  }

  private emitStatusUpdate(status: PropFirmStatusResponse): void {
    if (!this.onStatusUpdate) return;
    try {
      this.onStatusUpdate(status);
    } catch {
      // Tolerated listener failure
    }
  }
}

function formatUsdMd(value: number): string {
  const safe = Number.isFinite(value) ? round2(value) : 0;
  const normalized = Math.abs(safe) < 0.005 ? 0 : safe;
  const absFormatted = Math.abs(normalized).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return normalized < 0 ? `-$${absFormatted}` : `$${absFormatted}`;
}

function formatSignedUsdMd(value: number): string {
  const safe = Number.isFinite(value) ? round2(value) : 0;
  if (Math.abs(safe) < 0.005) return '$0.00';
  const absFormatted = Math.abs(safe).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return safe < 0 ? `-$${absFormatted}` : `+$${absFormatted}`;
}

/**
 * Formats an Upcomers $50K 5-cycle consistency certificate report into Markdown.
 */
export function formatPropFirmCertificateMarkdown(cert: PropFirmCertificateResponse): string {
  const generatedIso = new Date(
    Number.isFinite(cert.generatedAt) ? cert.generatedAt : Date.now()
  ).toISOString();
  const badge = cert.certified ? 'TƏSDİQLƏNDİ' : 'DAVAM EDİR';

  const lines: string[] = [
    '# Upcomers $50K "1-Step Thunderbolt" Ardıcıllıq Sertifikatı',
    '',
    `- **Sertifikat Statusu:** ${badge}`,
    `- **Ardıcıl Keçilmiş Dövrələr:** ${cert.consecutivePassedCycles} / ${cert.requiredPassedCycles}`,
    `- **Qalan Dövrə Sayı:** ${cert.remainingCycles}`,
    `- **Ümumi Tamamlanmış Dövrə:** ${cert.totalCompletedCycles}`,
    `- **Yaradılma Tarixi (UTC):** ${generatedIso}`,
    '',
    '## Dövrələr Tarixçəsi',
    '',
  ];

  if (cert.cycles.length === 0) {
    lines.push('_Hələ heç bir dövrə qeydə alınmayıb._');
    return lines.join('\n');
  }

  lines.push(
    '| # | Status | Başlanğıc | Yekun Kapital | Xalis PnL | Maks. Geriləmə | Əməliyyat (Q/M) | Başlama (UTC) | Bağlanma (UTC) |',
    '| ---: | :--- | ---: | ---: | ---: | ---: | :---: | :--- | :--- |'
  );

  for (const cycle of cert.cycles) {
    const startedIso = new Date(cycle.startedAt).toISOString();
    const closedIso = cycle.closedAt ? new Date(cycle.closedAt).toISOString() : '-';
    lines.push(
      `| #${cycle.cycleNumber} | ${cycle.status} | ${formatUsdMd(cycle.startingBalanceUsd)} | ${formatUsdMd(cycle.currentEquityUsd)} | ${formatSignedUsdMd(cycle.netPnlUsd)} | ${formatUsdMd(cycle.maxDrawdownUsd)} | ${cycle.tradesCount} (${cycle.winCount}/${cycle.lossCount}) | ${startedIso} | ${closedIso} |`
    );
  }

  return lines.join('\n');
}
