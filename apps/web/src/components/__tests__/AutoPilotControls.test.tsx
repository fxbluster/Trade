/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { useMarketStore } from '../../store/useMarketStore';
import { AutoPilotControls } from '../AutoPilotControls';
import type { AutoPilotStatusData } from '../../lib/wsClient';
import { apiClient } from '../../lib/apiClient';

vi.mock('../../lib/apiClient', () => ({
  apiClient: {
    toggleAutoPilot: vi.fn(),
    updateAutoPilotConfig: vi.fn().mockResolvedValue({ ok: true, config: {} }),
    resetAutoPilotCooldown: vi.fn().mockResolvedValue({ ok: true, state: 'IDLE' }),
    getKlines: vi.fn().mockResolvedValue([]),
    getState: vi.fn().mockResolvedValue({
      symbol: 'SOLUSDT',
      markPrice: 100,
      fundingRate: 0.0001,
      nextFundingTime: Date.now() + 3600000,
      account: { walletBalance: 1000, equity: 1000, availableBalance: 1000, unrealizedPnl: 0, currency: 'USDT' },
      activePosition: null,
      openOrders: [],
      indicators: null,
      cvd: null,
      risk: { broker_mode: 'BINANCE_DEMO', consecutive_losses: 0, cooldown_until: 0, cooldown_reason: null, session_net_pnl: 0, session_started_at: Date.now(), updated_at: Date.now() },
      sokrat: null,
      exchangeHealth: 'HEALTHY',
      brokerMode: 'BINANCE_DEMO',
    }),
  },
}));

vi.mock('../../lib/audio', () => ({
  soundEffects: {
    playBuy: vi.fn(),
    playAlert: vi.fn(),
  },
}));

describe('AutoPilotControls Next-Gen Presentation Tier', () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);

    useMarketStore.setState({
      autoPilot: {
        state: 'IDLE',
        config: {
          enabled: false,
          consensusThreshold: 4,
          marginAllocationPct: 5,
          leverage: 10,
          oppositeExitEnabled: true,
          circuitBreakerConsecutiveLosses: 2,
          circuitBreakerCooldownMs: 3600000,
          maxDailyTrades: 5,
          dailyDrawdownLimitPct: 2.0,
        },
        openTradeId: null,
      },
    });
  });

  it('renders Maker Limit Chasing card when state is LIMIT_CHASING', () => {
    const statusData: AutoPilotStatusData = {
      state: 'LIMIT_CHASING',
      config: {
        enabled: true,
        consensusThreshold: 4,
        marginAllocationPct: 5,
        leverage: 10,
        oppositeExitEnabled: true,
        circuitBreakerConsecutiveLosses: 2,
        circuitBreakerCooldownMs: 3600000,
      },
      openTradeId: null,
      chasingOrder: {
        active: true,
        orderId: 'chase-123',
        symbol: 'SOLUSDT',
        side: 'BUY',
        anchorPrice: 100.0,
        currentLimitPrice: 100.02,
        amendCount: 3,
        startTime: Date.now() - 2000,
        timeoutMs: 15000,
        status: 'CHASING',
        feeSavedUsd: 0.045,
      },
    };

    useMarketStore.setState({ autoPilot: statusData });

    const root = createRoot(container);
    flushSync(() => {
      root.render(React.createElement(AutoPilotControls));
    });

    const card = container.querySelector('[data-testid="maker-chasing-card"]');
    expect(card).not.toBeNull();
    expect(card?.textContent).toContain('Maker Limit Chasing');
    expect(card?.textContent).toContain('CHASING');
    expect(card?.textContent).toContain('$100.02');
    expect(card?.textContent).toContain('3 / 10');
    expect(card?.textContent).toContain('+$0.045');
    root.unmount();
  });

  it('renders dynamic convex sizing badge when sizingBreakdown is present', () => {
    const statusData: AutoPilotStatusData = {
      state: 'POSITION_OPEN',
      config: {
        enabled: true,
        consensusThreshold: 4,
        marginAllocationPct: 10,
        leverage: 10,
        oppositeExitEnabled: true,
        circuitBreakerConsecutiveLosses: 2,
        circuitBreakerCooldownMs: 3600000,
      },
      openTradeId: 'trade-456',
      sizingBreakdown: {
        confluenceScore: 88,
        archetype: 'High-Conviction Core',
        rawMarginPct: 0.18,
        kellyDampener: 0.95,
        volatilityParity: 1.10,
        circuitMultiplier: 1.0,
        finalMarginPct: 0.188,
        marginUsd: 188.0,
        notionalUsd: 1880.0,
        solvencyAirbagOk: true,
      },
    };

    useMarketStore.setState({ autoPilot: statusData });

    const root = createRoot(container);
    flushSync(() => {
      root.render(React.createElement(AutoPilotControls));
    });

    const badge = container.querySelector('[data-testid="dynamic-sizing-badge"]');
    expect(badge).not.toBeNull();
    expect(badge?.textContent).toContain('Adaptive Margin Allocation');
    expect(badge?.textContent).toContain('18.8%');
    expect(badge?.textContent).toContain('$188.00');
    expect(badge?.textContent).toContain('High-Conviction Core');
    expect(badge?.textContent).toContain('Airbag: SECURE');
    expect(badge?.textContent).toContain('Kelly: 0.95x');
    expect(badge?.textContent).toContain('Vol Parity: 1.10x');
    root.unmount();
  });

  it('renders modernized Quant Conviction Threshold buttons instead of legacy min-pillar buttons', () => {
    const root = createRoot(container);
    flushSync(() => {
      root.render(React.createElement(AutoPilotControls));
    });

    // Check legacy 3/7, 4/7 buttons are gone
    expect(container.textContent).not.toContain('3/7');
    expect(container.textContent).not.toContain('4/7');
    expect(container.textContent).not.toContain('5/7');
    expect(container.textContent).not.toContain('6/7');

    // Check modernized Quant Conviction Threshold buttons
    expect(container.textContent).toContain('Quant Conviction Threshold:');
    const btn60 = container.querySelector('[data-testid="conviction-threshold-60"]') as HTMLButtonElement;
    const btn65 = container.querySelector('[data-testid="conviction-threshold-65"]') as HTMLButtonElement;
    const btn70 = container.querySelector('[data-testid="conviction-threshold-70"]') as HTMLButtonElement;
    const btn75 = container.querySelector('[data-testid="conviction-threshold-75"]') as HTMLButtonElement;

    expect(btn60).not.toBeNull();
    expect(btn65).not.toBeNull();
    expect(btn70).not.toBeNull();
    expect(btn75).not.toBeNull();

    expect(btn60.textContent).toBe('60%');
    expect(btn65.textContent).toBe('65%');
    expect(btn70.textContent).toBe('70%');
    expect(btn75.textContent).toBe('75%');

    // Click 65% button and verify updateAutoPilotConfig is called
    flushSync(() => {
      btn65.click();
    });
    expect(apiClient.updateAutoPilotConfig).toHaveBeenCalledWith(
      expect.objectContaining({ consensusThreshold: 65 })
    );

    root.unmount();
  });

  it('renders prominent Reset Cooldown button when in COOLDOWN_ACTIVE and handles reset click', async () => {
    const statusData: AutoPilotStatusData = {
      state: 'COOLDOWN_ACTIVE',
      config: {
        enabled: true,
        consensusThreshold: 70,
        marginAllocationPct: 5,
        leverage: 10,
        oppositeExitEnabled: true,
        circuitBreakerConsecutiveLosses: 2,
        circuitBreakerCooldownMs: 3600000,
        maxDailyTrades: 5,
        dailyDrawdownLimitPct: 2.0,
      },
      openTradeId: null,
      cooldownRemainingSec: 1800,
      blockReason: 'BLOCKED_DAILY_MAX_LOSS',
      message: 'Daily Drawdown Limit (-2.0%) Reached - Cooldown Active',
    };

    useMarketStore.setState({ autoPilot: statusData });

    const root = createRoot(container);
    flushSync(() => {
      root.render(React.createElement(AutoPilotControls));
    });

    const resetBtn = container.querySelector('[data-testid="reset-cooldown-btn"]') as HTMLButtonElement;
    expect(resetBtn).not.toBeNull();
    expect(resetBtn.textContent).toContain('Reset Cooldown');

    // Also check banner reset button
    const bannerResetBtn = container.querySelector('[data-testid="banner-reset-cooldown-btn"]') as HTMLButtonElement;
    expect(bannerResetBtn).not.toBeNull();

    // Click Reset Cooldown
    await flushSync(async () => {
      resetBtn.click();
    });

    expect(apiClient.resetAutoPilotCooldown).toHaveBeenCalled();
    expect(apiClient.getState).toHaveBeenCalled();
    root.unmount();
  });
});
