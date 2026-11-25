/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { PropFirmChallengeCycle, PropFirmStatusResponse } from '@tradeos/shared';
import { OrderTicket } from '../OrderTicket';
import { useMarketStore } from '../../store/useMarketStore';
import { useUiStore } from '../../store/useUiStore';
import { apiClient } from '../../lib/apiClient';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('../../lib/audio', () => ({
  soundEffects: {
    playBuy: vi.fn(),
    playSell: vi.fn(),
    playAlert: vi.fn(),
    playBreakeven: vi.fn(),
  },
}));

function makeCycle(overrides: Partial<PropFirmChallengeCycle> = {}): PropFirmChallengeCycle {
  return {
    id: 'cycle-1',
    cycleNumber: 1,
    status: 'ACTIVE',
    startingBalanceUsd: 50_000,
    currentEquityUsd: 50_000,
    highWaterMarkUsd: 50_000,
    contractualTrailingFloorUsd: 47_000,
    internalTrailingFloorUsd: 47_500,
    isFloorLocked: false,
    profitTargetUsd: 2_500,
    netPnlUsd: 0,
    netPnlPct: 0,
    maxDrawdownUsd: 0,
    tradesCount: 0,
    winCount: 0,
    lossCount: 0,
    startedAt: Date.UTC(2026, 10, 25, 8, 0, 0),
    closedAt: null,
    ...overrides,
  };
}

function makePropFirmStatus(overrides: Partial<PropFirmStatusResponse> = {}): PropFirmStatusResponse {
  const cycle = overrides.cycle ?? makeCycle();
  return {
    cycle,
    verdict: 'WAITING',
    dailyBaselineEquityUsd: 50_000,
    dailyPnlUsd: 0,
    dailyLossUsedUsd: 0,
    dailyBufferRemainingUsd: 1_250,
    dailyBufferRemainingPct: 100,
    trailingLossUsedUsd: 0,
    trailingBufferRemainingUsd: 2_500,
    trailingBufferRemainingPct: 100,
    targetProgressPct: 0,
    targetRemainingUsd: 2_500,
    liveWalletBalanceUsd: 50_000,
    needsTopUp: false,
    topUpMessage: null,
    consecutivePassedCycles: 0,
    requiredPassedCycles: 5,
    canTrade: true,
    haltReason: null,
    cycles: [cycle],
    updatedAt: Date.UTC(2026, 10, 25, 10, 0, 0),
    ...overrides,
  };
}

describe('OrderTicket PropFirm Guards & Unmount Hygiene', () => {
  let container: HTMLDivElement;
  let root: Root | null = null;

  beforeEach(() => {
    vi.useFakeTimers();
    container = document.createElement('div');
    document.body.appendChild(container);

    useMarketStore.setState({
      symbol: 'SOLUSDT',
      markPrice: 100,
      brokerMode: 'BINANCE_DEMO',
      account: {
        walletBalance: 50_000,
        equity: 50_000,
        availableBalance: 50_000,
        unrealizedPnl: 0,
        currency: 'USDT',
      },
      risk: {
        broker_mode: 'BINANCE_DEMO',
        consecutive_losses: 0,
        cooldown_until: 0,
        cooldown_reason: null,
        session_net_pnl: 0,
        session_started_at: Date.now(),
        updated_at: Date.now(),
      },
      indicators: null,
      activePosition: null,
      propFirmStatus: makePropFirmStatus(),
    });

    useUiStore.setState({
      orderDraft: {
        side: 'BUY',
        orderType: 'MARKET',
        marginUsd: 100,
        leverage: 10,
        limitPrice: undefined,
        stopLoss: 95,
        tp1: 110,
        tp2: 120,
        preview: null,
      },
    });
  });

  afterEach(async () => {
    if (root) {
      await act(async () => {
        root!.unmount();
      });
      root = null;
    }
    container.remove();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('clears hold timers on unmount so openOrder is never fired after unmount', async () => {
    const openOrderSpy = vi.spyOn(apiClient, 'openOrder').mockResolvedValue({
      ok: true,
      tradeId: 't-1',
      clientOrderId: 'c-1',
    });

    root = createRoot(container);
    await act(async () => {
      root!.render(React.createElement(OrderTicket));
    });

    const buttons = Array.from(container.querySelectorAll('button'));
    const submitBtn = buttons.find((b) => b.textContent?.includes('Hold 400ms to LONG'));
    expect(submitBtn).toBeDefined();
    expect(submitBtn?.disabled).toBe(false);

    // Begin holding (400ms hold required)
    await act(async () => {
      submitBtn!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    });

    // Advance partway, then unmount before 400ms
    await act(async () => {
      vi.advanceTimersByTime(150);
    });

    await act(async () => {
      root!.unmount();
      root = null;
    });

    // Advance well past 400ms — cleanup must have cancelled both timer and interval
    await act(async () => {
      vi.advanceTimersByTime(600);
    });

    expect(openOrderSpy).not.toHaveBeenCalled();
  });

  it('blocks manual execution and shows explicit halt banner when propFirmStatus.canTrade is false', async () => {
    const openOrderSpy = vi.spyOn(apiClient, 'openOrder');

    useMarketStore.setState({
      propFirmStatus: makePropFirmStatus({
        canTrade: false,
        haltReason: 'UPCOMERS_DAILY_HALT',
        cycle: makeCycle({ status: 'HALTED_DAILY_BUFFER' }),
      }),
    });

    root = createRoot(container);
    await act(async () => {
      root!.render(React.createElement(OrderTicket));
    });

    const haltBanner = container.querySelector('[data-testid="propfirm-halt-banner"]');
    expect(haltBanner).not.toBeNull();
    expect(haltBanner?.textContent).toContain('UPCOMERS_DAILY_HALT');

    const buttons = Array.from(container.querySelectorAll('button'));
    const submitBtn = buttons.find((b) => b.textContent?.includes('Prop-Firm Halted'));
    expect(submitBtn).toBeDefined();
    expect(submitBtn?.disabled).toBe(true);

    await act(async () => {
      submitBtn!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      vi.advanceTimersByTime(500);
    });

    expect(openOrderSpy).not.toHaveBeenCalled();
  });

  it('displays $250.00 Upcomers max-risk auto-clamp warning when maxLossUsd > 250 in BINANCE_DEMO mode', async () => {
    // marginUsd=1000 * 10x leverage = $10,000 notional -> 100 qty at $100 mark; SL=90 => $1,000 maxLossUsd > $250
    useUiStore.setState({
      orderDraft: {
        side: 'BUY',
        orderType: 'MARKET',
        marginUsd: 1000,
        leverage: 10,
        limitPrice: undefined,
        stopLoss: 90,
        tp1: 120,
        tp2: undefined,
        preview: null,
      },
    });

    root = createRoot(container);
    await act(async () => {
      root!.render(React.createElement(OrderTicket));
    });

    const clampWarning = container.querySelector('[data-testid="upcomers-risk-clamp-warning"]');
    expect(clampWarning).not.toBeNull();
    expect(clampWarning?.textContent).toContain('$250.00');

    // Switch to LOCAL_PAPER -> warning should disappear
    await act(async () => {
      useMarketStore.setState({ brokerMode: 'LOCAL_PAPER' });
    });
    expect(container.querySelector('[data-testid="upcomers-risk-clamp-warning"]')).toBeNull();
  });
});
