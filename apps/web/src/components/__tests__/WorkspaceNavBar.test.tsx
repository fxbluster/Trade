/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { flushSync } from 'react-dom';
import type {
  ConfluenceSnapshot,
  PropFirmChallengeCycle,
  PropFirmStatusResponse,
  TradeRecord,
} from '@tradeos/shared';
import { useMarketStore } from '../../store/useMarketStore';
import { useUiStore, type WorkspaceViewType } from '../../store/useUiStore';
import { WorkspaceNavBar } from '../WorkspaceNavBar';

function makeTrade(overrides: Partial<TradeRecord> = {}): TradeRecord {
  return {
    id: 'trade-1',
    symbol: 'SOLUSDT',
    broker_mode: 'BINANCE_DEMO',
    side: 'BUY',
    status: 'OPEN',
    entry_price: 150,
    exit_price: null,
    quantity: 10,
    remaining_qty: 10,
    leverage: 10,
    margin_usd: 150,
    stop_loss: 145,
    tp1: 160,
    tp2: 170,
    be_price: null,
    is_breakeven: 0,
    client_order_id: null,
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
    opened_at: Date.UTC(2026, 10, 25, 8, 0, 0),
    closed_at: null,
    ...overrides,
  };
}

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

function makeStatus(overrides: Partial<PropFirmStatusResponse> = {}): PropFirmStatusResponse {
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

function makeConfluence(overrides: Partial<ConfluenceSnapshot> = {}): ConfluenceSnapshot {
  return {
    symbol: 'SOLUSDT',
    pillars: [],
    bullishCount: 2,
    bearishCount: 1,
    neutralCount: 4,
    consensusBias: 'NEUTRAL',
    consensusMet: false,
    threshold: 4,
    compositeScore: 46,
    recommendedAction: 'WAIT',
    macroVetoActive: false,
    macroRegime: 'MACRO_RANGING',
    activeFvgs: [],
    activeOrderBlocks: [],
    latestSweep: null,
    ...overrides,
  };
}

describe('useUiStore workspace view persistence', () => {
  beforeEach(() => {
    sessionStorage.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
    sessionStorage.clear();
  });

  it('defaults to TRADING when sessionStorage is empty and falls back to TRADING on invalid stored value', async () => {
    vi.resetModules();
    const { useUiStore: storeEmpty } = await import('../../store/useUiStore');
    expect(storeEmpty.getState().activeWorkspaceView).toBe('TRADING');

    sessionStorage.setItem('tradeos_workspace_view', 'INVALID_VIEW');
    vi.resetModules();
    const { useUiStore: storeInvalid } = await import('../../store/useUiStore');
    expect(storeInvalid.getState().activeWorkspaceView).toBe('TRADING');
  });

  it('restores valid PROPFIRM and QUANT values from sessionStorage and persists updates', async () => {
    sessionStorage.setItem('tradeos_workspace_view', 'PROPFIRM');
    vi.resetModules();
    const { useUiStore: storeProp } = await import('../../store/useUiStore');
    expect(storeProp.getState().activeWorkspaceView).toBe('PROPFIRM');

    storeProp.getState().setActiveWorkspaceView('QUANT');
    expect(storeProp.getState().activeWorkspaceView).toBe('QUANT');
    expect(sessionStorage.getItem('tradeos_workspace_view')).toBe('QUANT');

    vi.resetModules();
    const { useUiStore: storeQuant } = await import('../../store/useUiStore');
    expect(storeQuant.getState().activeWorkspaceView).toBe('QUANT');
  });

  it('handles sessionStorage getItem/setItem exceptions safely without throwing', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('SecurityError');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError');
    });

    vi.resetModules();
    const { useUiStore: storeSafe } = await import('../../store/useUiStore');
    expect(storeSafe.getState().activeWorkspaceView).toBe('TRADING');

    expect(() => storeSafe.getState().setActiveWorkspaceView('PROPFIRM')).not.toThrow();
    expect(storeSafe.getState().activeWorkspaceView).toBe('PROPFIRM');
  });
});

describe('WorkspaceNavBar', () => {
  let container: HTMLDivElement;
  let root: Root | null = null;

  beforeEach(() => {
    sessionStorage.clear();
    container = document.createElement('div');
    document.body.appendChild(container);
    useUiStore.setState({ activeWorkspaceView: 'TRADING' });
    useMarketStore.setState({
      activePosition: null,
      propFirmStatus: null,
      confluence: null,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (root) {
      flushSync(() => {
        root?.unmount();
      });
      root = null;
    }
    container.remove();
    sessionStorage.clear();
  });

  function renderNavBar() {
    root = createRoot(container);
    flushSync(() => {
      root!.render(React.createElement(WorkspaceNavBar));
    });
  }

  it('renders all 3 workspace tabs, applies active styling, and switches views on click', () => {
    renderNavBar();

    const nav = container.querySelector('[data-testid="workspace-nav-bar"]');
    expect(nav).not.toBeNull();

    const tradingTab = container.querySelector('[data-testid="workspace-tab-TRADING"]') as HTMLButtonElement | null;
    const propFirmTab = container.querySelector('[data-testid="workspace-tab-PROPFIRM"]') as HTMLButtonElement | null;
    const quantTab = container.querySelector('[data-testid="workspace-tab-QUANT"]') as HTMLButtonElement | null;

    expect(tradingTab).not.toBeNull();
    expect(propFirmTab).not.toBeNull();
    expect(quantTab).not.toBeNull();

    expect(tradingTab?.textContent).toContain('Ticarət');
    expect(propFirmTab?.textContent).toContain('Fon Hesabı ($50K)');
    expect(quantTab?.textContent).toContain('Kvant & Loqlar');

    // Initial active state: TRADING
    expect(tradingTab?.getAttribute('aria-pressed')).toBe('true');
    expect(tradingTab?.className).toContain('bg-[#151d2c]');
    expect(propFirmTab?.getAttribute('aria-pressed')).toBe('false');
    expect(quantTab?.getAttribute('aria-pressed')).toBe('false');

    // Click PROPFIRM tab
    flushSync(() => {
      propFirmTab!.click();
    });
    expect(useUiStore.getState().activeWorkspaceView).toBe('PROPFIRM');
    expect(sessionStorage.getItem('tradeos_workspace_view')).toBe('PROPFIRM');
    expect(propFirmTab?.getAttribute('aria-pressed')).toBe('true');
    expect(propFirmTab?.className).toContain('bg-[#151d2c]');
    expect(tradingTab?.getAttribute('aria-pressed')).toBe('false');

    // Click QUANT tab
    flushSync(() => {
      quantTab!.click();
    });
    expect(useUiStore.getState().activeWorkspaceView).toBe('QUANT');
    expect(quantTab?.getAttribute('aria-pressed')).toBe('true');
    expect(propFirmTab?.getAttribute('aria-pressed')).toBe('false');

    // Click TRADING tab back
    flushSync(() => {
      tradingTab!.click();
    });
    expect(useUiStore.getState().activeWorkspaceView).toBe('TRADING');
    expect(tradingTab?.getAttribute('aria-pressed')).toBe('true');
  });

  it('shows "1 Açıq" badge only when activePosition exists and status !== CLOSED', () => {
    renderNavBar();
    expect(container.querySelector('[data-testid="workspace-tab-TRADING"]')?.textContent).not.toContain('1 Açıq');

    flushSync(() => {
      useMarketStore.setState({ activePosition: makeTrade({ status: 'OPEN' }) });
    });
    expect(container.querySelector('[data-testid="workspace-tab-TRADING"]')?.textContent).toContain('1 Açıq');

    flushSync(() => {
      useMarketStore.setState({ activePosition: makeTrade({ status: 'CLOSED' }) });
    });
    expect(container.querySelector('[data-testid="workspace-tab-TRADING"]')?.textContent).not.toContain('1 Açıq');

    flushSync(() => {
      useMarketStore.setState({ activePosition: null });
    });
    expect(container.querySelector('[data-testid="workspace-tab-TRADING"]')?.textContent).not.toContain('1 Açıq');
  });

  it('displays PropFirm cycle # badge, alert dot on needsTopUp/HALTED_/FAILED_, and Quant live score badge', () => {
    useMarketStore.setState({
      propFirmStatus: makeStatus({
        cycle: makeCycle({ cycleNumber: 3, status: 'ACTIVE' }),
        needsTopUp: false,
      }),
      confluence: makeConfluence({ compositeScore: 46.4, recommendedAction: 'WAIT' }),
    });

    renderNavBar();

    const propFirmTab = container.querySelector('[data-testid="workspace-tab-PROPFIRM"]');
    expect(propFirmTab?.textContent).toContain('#3');
    expect(container.querySelector('[data-testid="workspace-propfirm-alert-dot"]')).toBeNull();

    const quantTab = container.querySelector('[data-testid="workspace-tab-QUANT"]');
    expect(quantTab?.textContent).toContain('46% WAIT');

    // Amber dot appears on HALTED_DAILY_BUFFER
    flushSync(() => {
      useMarketStore.setState({
        propFirmStatus: makeStatus({
          cycle: makeCycle({ cycleNumber: 3, status: 'HALTED_DAILY_BUFFER' }),
          needsTopUp: false,
        }),
      });
    });
    expect(container.querySelector('[data-testid="workspace-propfirm-alert-dot"]')).not.toBeNull();

    // Amber dot appears on FAILED_TRAILING
    flushSync(() => {
      useMarketStore.setState({
        propFirmStatus: makeStatus({
          cycle: makeCycle({ cycleNumber: 3, status: 'FAILED_TRAILING' }),
          needsTopUp: false,
        }),
      });
    });
    expect(container.querySelector('[data-testid="workspace-propfirm-alert-dot"]')).not.toBeNull();

    // Amber dot appears on needsTopUp when cycle is ACTIVE
    flushSync(() => {
      useMarketStore.setState({
        propFirmStatus: makeStatus({
          cycle: makeCycle({ cycleNumber: 3, status: 'ACTIVE' }),
          needsTopUp: true,
        }),
      });
    });
    expect(container.querySelector('[data-testid="workspace-propfirm-alert-dot"]')).not.toBeNull();
  });

  it('renders clickable Upcomers and Quant right-side pills that switch views and never produce malformed $- strings', () => {
    useMarketStore.setState({
      propFirmStatus: makeStatus({
        cycle: makeCycle({ netPnlUsd: -120.5 }),
      }),
      confluence: makeConfluence({ compositeScore: 78.6, recommendedAction: 'STRONG_BUY' }),
    });

    renderNavBar();

    const propFirmPill = container.querySelector('[data-testid="workspace-pill-propfirm"]') as HTMLButtonElement | null;
    const quantPill = container.querySelector('[data-testid="workspace-pill-quant"]') as HTMLButtonElement | null;

    expect(propFirmPill).not.toBeNull();
    expect(quantPill).not.toBeNull();

    expect(propFirmPill?.textContent).toContain('Upcomers:');
    expect(propFirmPill?.textContent).toContain('-$120.50');
    expect(propFirmPill?.textContent).toContain('/ +$2,500');
    expect(container.textContent).not.toContain('$-');

    expect(quantPill?.textContent).toContain('Skor:');
    expect(quantPill?.textContent).toContain('79% STRONG_BUY');

    // Positive netPnl formats with +$
    flushSync(() => {
      useMarketStore.setState({
        propFirmStatus: makeStatus({
          cycle: makeCycle({ netPnlUsd: 840.25 }),
        }),
      });
    });
    expect(propFirmPill?.textContent).toContain('+$840.25');
    expect(container.textContent).not.toContain('$-');

    // Clicking pills jumps to PROPFIRM and QUANT
    const checkSwitch = (pill: HTMLButtonElement, expected: WorkspaceViewType) => {
      flushSync(() => {
        pill.click();
      });
      expect(useUiStore.getState().activeWorkspaceView).toBe(expected);
    };

    checkSwitch(propFirmPill!, 'PROPFIRM');
    checkSwitch(quantPill!, 'QUANT');
  });

  it('renders Top-Up $50K link only when needsTopUp === true with exact href, target, and rel attributes', () => {
    useMarketStore.setState({
      propFirmStatus: makeStatus({ needsTopUp: false }),
    });

    renderNavBar();
    expect(container.querySelector('[data-testid="workspace-pill-topup"]')).toBeNull();

    flushSync(() => {
      useMarketStore.setState({
        propFirmStatus: makeStatus({ needsTopUp: true }),
      });
    });

    const topUpLink = container.querySelector('[data-testid="workspace-pill-topup"]') as HTMLAnchorElement | null;
    expect(topUpLink).not.toBeNull();
    expect(topUpLink?.tagName).toBe('A');
    expect(topUpLink?.textContent).toBe('Top-Up $50K ↗');
    expect(topUpLink?.getAttribute('href')).toBe('https://testnet.binancefuture.com');
    expect(topUpLink?.getAttribute('target')).toBe('_blank');
    expect(topUpLink?.getAttribute('rel')).toBe('noopener noreferrer');
  });
});
