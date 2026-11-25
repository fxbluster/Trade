import { describe, it, expect } from 'vitest';
import {
  UPCOMERS_1STEP_50K_DEFAULT,
  type UpcomersChallengeConfig,
  type PropFirmCycleStatus,
  type PropFirmQuestionVerdict,
  type PropFirmChallengeCycle,
  type PropFirmDailySnapshot,
  type PropFirmStatusResponse,
  type PropFirmCertificateResponse,
  type BlockReason,
  type ExitReason,
  type WsServerMessage,
} from '../index.js';

describe('Upcomers 50K Prop Firm Shared Contracts', () => {
  it('exports exact Upcomers 1-Step Thunderbolt defaults and zero-halt tolerances', () => {
    const cfg: UpcomersChallengeConfig = UPCOMERS_1STEP_50K_DEFAULT;
    expect(cfg).toEqual({
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
    });
  });

  it('supports UPCOMERS_DAILY_HALT and UPCOMERS_TRAILING_HALT reasons, daily snapshot, and WS message', () => {
    const b1: BlockReason = 'UPCOMERS_DAILY_HALT';
    const b2: BlockReason = 'UPCOMERS_TRAILING_HALT';
    const e1: ExitReason = 'UPCOMERS_DAILY_HALT';
    const e2: ExitReason = 'UPCOMERS_TRAILING_HALT';
    expect([b1, b2, e1, e2]).toHaveLength(4);

    const statuses: PropFirmCycleStatus[] = [
      'ACTIVE',
      'PASSED',
      'FAILED_DAILY',
      'FAILED_TRAILING',
      'HALTED_DAILY_BUFFER',
      'HALTED_TRAILING_BUFFER',
    ];
    expect(statuses).toHaveLength(6);

    const verdicts: PropFirmQuestionVerdict[] = ['YES_PROFIT', 'NO_LOSS', 'WAITING'];
    expect(verdicts).toHaveLength(3);

    const cycle: PropFirmChallengeCycle = {
      id: 'cycle_1',
      cycleNumber: 1,
      status: 'ACTIVE',
      startingBalanceUsd: 50_000,
      currentEquityUsd: 50_840.5,
      highWaterMarkUsd: 50_900,
      contractualTrailingFloorUsd: 47_900,
      internalTrailingFloorUsd: 48_400,
      isFloorLocked: false,
      profitTargetUsd: 2_500,
      netPnlUsd: 840.5,
      netPnlPct: 1.681,
      maxDrawdownUsd: 120,
      tradesCount: 3,
      winCount: 2,
      lossCount: 1,
      startedAt: 1000,
      closedAt: null,
    };

    const dailySnapshot: PropFirmDailySnapshot = {
      utcDate: '2026-11-25',
      cycleId: 'cycle_1',
      dayStartEquityUsd: 50_000,
      currentEquityUsd: 50_840.5,
      dailyPnlUsd: 840.5,
      dailyMinEquityUsd: 49_880,
      dailyHalted: false,
      updatedAt: 1000,
    };
    expect(dailySnapshot.utcDate).toBe('2026-11-25');

    const status: PropFirmStatusResponse = {
      cycle,
      verdict: 'YES_PROFIT',
      dailyBaselineEquityUsd: 50_000,
      dailyPnlUsd: 840.5,
      dailyLossUsedUsd: 0,
      dailyBufferRemainingUsd: 1_250,
      dailyBufferRemainingPct: 100,
      trailingLossUsedUsd: 59.5,
      trailingBufferRemainingUsd: 2_440.5,
      trailingBufferRemainingPct: 97.62,
      targetProgressPct: 33.62,
      targetRemainingUsd: 1_659.5,
      liveWalletBalanceUsd: 4_606.01,
      needsTopUp: true,
      topUpMessage: 'Binance Testnet top-up required to match $50,000.00 challenge capital',
      consecutivePassedCycles: 0,
      requiredPassedCycles: 5,
      canTrade: true,
      haltReason: null,
      cycles: [],
      updatedAt: 1000,
    };

    const msg: WsServerMessage = { type: 'PROPFIRM_STATUS', data: status };
    const cert: PropFirmCertificateResponse = {
      certified: false,
      consecutivePassedCycles: 0,
      requiredPassedCycles: 5,
      remainingCycles: 5,
      totalCompletedCycles: 0,
      cycles: [],
      generatedAt: 1000,
    };
    expect(msg.type).toBe('PROPFIRM_STATUS');
    expect(cert.requiredPassedCycles).toBe(5);
  });
});
