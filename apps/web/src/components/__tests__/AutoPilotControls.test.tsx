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

vi.mock('../../lib/apiClient', () => ({
  apiClient: {
    toggleAutoPilot: vi.fn(),
    updateAutoPilotConfig: vi.fn(),
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
});
