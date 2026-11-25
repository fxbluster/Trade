/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { flushSync } from 'react-dom';
import type {
  CockpitState,
  ConfluenceSnapshot,
  DailyAuditResponse,
  JournalSummary,
  PropFirmChallengeCycle,
  PropFirmStatusResponse,
} from '@tradeos/shared';

const { mockSeries, mockChart, mockCreateChart } = vi.hoisted(() => {
  const mockSeries = {
    setData: vi.fn(),
    update: vi.fn(),
    createPriceLine: vi.fn((opts: Record<string, unknown>) => ({ ...opts, id: Math.random() })),
    removePriceLine: vi.fn(),
    setMarkers: vi.fn(),
  };

  const mockChart = {
    applyOptions: vi.fn(),
    addCandlestickSeries: vi.fn(() => mockSeries),
    addHistogramSeries: vi.fn(() => mockSeries),
    priceScale: vi.fn(() => ({
      applyOptions: vi.fn(),
    })),
    timeScale: vi.fn(() => ({
      fitContent: vi.fn(),
      resetTimeScale: vi.fn(),
    })),
    remove: vi.fn(),
  };

  const mockCreateChart = vi.fn(() => mockChart);
  return { mockSeries, mockChart, mockCreateChart };
});

vi.mock('lightweight-charts', () => ({
  createChart: mockCreateChart,
  ColorType: { Solid: 'solid' },
  LineStyle: { Solid: 0, Dotted: 1, Dashed: 2, LargeDashed: 3 },
  CrosshairMode: { Normal: 0, Magnet: 1 },
}));

vi.mock('../../lib/wsClient', () => ({
  wsClient: {
    setHandlers: vi.fn(),
    connect: vi.fn(),
    disconnect: vi.fn(),
    subscribeTick: vi.fn(() => vi.fn()),
    subscribeSymbol: vi.fn(),
  },
}));

import { App } from '../../App';
import { apiClient } from '../../lib/apiClient';
import { useMarketStore } from '../../store/useMarketStore';
import { useUiStore } from '../../store/useUiStore';

function makeCycle(overrides: Partial<PropFirmChallengeCycle> = {}): PropFirmChallengeCycle {
  return {
    id: 'cycle-1',
    cycleNumber: 1,
    status: 'ACTIVE',
    startingBalanceUsd: 50_000,
    currentEquityUsd: 50_420,
    highWaterMarkUsd: 50_500,
    contractualTrailingFloorUsd: 47_500,
    internalTrailingFloorUsd: 48_000,
    isFloorLocked: false,
    profitTargetUsd: 2_500,
    netPnlUsd: 420,
    netPnlPct: 0.84,
    maxDrawdownUsd: 80,
    tradesCount: 2,
    winCount: 2,
    lossCount: 0,
    startedAt: Date.UTC(2026, 10, 25, 8, 0, 0),
    closedAt: null,
    ...overrides,
  };
}

function makePropFirmStatus(): PropFirmStatusResponse {
  const cycle = makeCycle();
  return {
    cycle,
    verdict: 'YES_PROFIT',
    dailyBaselineEquityUsd: 50_000,
    dailyPnlUsd: 420,
    dailyLossUsedUsd: 0,
    dailyBufferRemainingUsd: 1_250,
    dailyBufferRemainingPct: 100,
    trailingLossUsedUsd: 80,
    trailingBufferRemainingUsd: 2_420,
    trailingBufferRemainingPct: 96.8,
    targetProgressPct: 16.8,
    targetRemainingUsd: 2_080,
    liveWalletBalanceUsd: 50_000,
    needsTopUp: false,
    topUpMessage: null,
    consecutivePassedCycles: 1,
    requiredPassedCycles: 5,
    canTrade: true,
    haltReason: null,
    cycles: [cycle],
    updatedAt: Date.UTC(2026, 10, 25, 10, 0, 0),
  };
}

function makeConfluence(): ConfluenceSnapshot {
  return {
    symbol: 'SOLUSDT',
    timestamp: Date.UTC(2026, 10, 25, 10, 0, 0),
    markPrice: 145.5,
    compositeScore: 72,
    recommendedAction: 'BUY',
    macroVetoActive: false,
    macroVetoReason: null,
    eventBlackoutActive: false,
    noiseBandActive: false,
    pillars: [],
    activeFvgs: [],
    activeOrderBlocks: [],
    latestSweep: null,
  } as unknown as ConfluenceSnapshot;
}

function makeCockpitState(): CockpitState {
  return {
    symbol: 'SOLUSDT',
    markPrice: 145.5,
    fundingRate: 0.0001,
    nextFundingTime: Date.now() + 3600_000,
    account: {
      walletBalance: 50_000,
      equity: 50_420,
      unrealizedPnl: 0,
      availableBalance: 50_000,
      currency: 'USDT',
    },
    activePosition: null,
    openOrders: [],
    indicators: null,
    cvd: null,
    risk: {
      broker_mode: 'BINANCE_DEMO',
      consecutive_losses: 0,
      cooldown_until: 0,
      cooldown_reason: null,
      session_net_pnl: 420,
      session_started_at: Date.UTC(2026, 10, 25, 8, 0, 0),
      updated_at: Date.UTC(2026, 10, 25, 10, 0, 0),
    },
    sokrat: null,
    exchangeHealth: 'HEALTHY',
    brokerMode: 'BINANCE_DEMO',
  };
}

async function flushUi(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 10));
  flushSync(() => {});
}

describe('App 3-View Multi-Workspace Layout', () => {
  let container: HTMLDivElement;
  let root: Root | null = null;

  beforeEach(() => {
    vi.clearAllMocks();
    sessionStorage.clear();

    container = document.createElement('div');
    document.body.appendChild(container);

    // Mock apiClient endpoints invoked on mount by App & sub-panels
    vi.spyOn(apiClient, 'getState').mockResolvedValue(makeCockpitState());
    vi.spyOn(apiClient, 'getKlines').mockResolvedValue([
      { time: 1795101000, open: 144, high: 146, low: 143.5, close: 145.5, volume: 1200 },
      { time: 1795101300, open: 145.5, high: 147, low: 145, close: 146.2, volume: 950 },
    ]);
    vi.spyOn(apiClient, 'getConfluence').mockResolvedValue(makeConfluence());
    vi.spyOn(apiClient, 'getPropFirmStatus').mockResolvedValue(makePropFirmStatus());
    vi.spyOn(apiClient, 'getScanner').mockResolvedValue([]);
    vi.spyOn(apiClient, 'getHealth').mockResolvedValue({
      status: 'ok',
      bootTimeMs: Date.now() - 60_000,
      uptimeSec: 60,
    } as any);
    vi.spyOn(apiClient, 'getJournal').mockResolvedValue({
      winRate: 60,
      profitFactor: 1.8,
      maxDrawdown: 0.02,
      kellyCriterion: 0.15,
      totalTrades: 5,
      trades: [],
    } as unknown as JournalSummary);
    vi.spyOn(apiClient, 'getDailyAudit').mockResolvedValue({
      summary: {
        total_setups: 0,
        executed_trades: 0,
        blocked_setups: 0,
        capital_saved_usd: 0,
        missed_profit_usd: 0,
        expired_pnl_usd: 0,
        net_risk_value_usd: 0,
        veto_breakdown: {},
      },
      records: [],
      factor_telemetry_events: [],
    } as unknown as DailyAuditResponse);

    useMarketStore.setState({
      symbol: 'SOLUSDT',
      markPrice: 145.5,
      klines: [
        { time: 1795101000, open: 144, high: 146, low: 143.5, close: 145.5, volume: 1200 },
        { time: 1795101300, open: 145.5, high: 147, low: 145, close: 146.2, volume: 950 },
      ],
      activePosition: null,
      openOrders: [],
      confluence: makeConfluence(),
      propFirmStatus: makePropFirmStatus(),
      telemetryEvents: [],
    });

    useUiStore.setState({
      activeWorkspaceView: 'TRADING',
      activeBottomTab: 'POSITION',
      rightRailTab: 'ORDER_TICKET',
      isBottomExpanded: false,
    });
  });

  afterEach(() => {
    if (root) {
      flushSync(() => {
        root!.unmount();
      });
      root = null;
    }
    container.remove();
    vi.restoreAllMocks();
  });

  it('renders TRADING view by default with ChartCanvas + cockpit-bottom-panel, without PropFirm or Confluence HUDs', async () => {
    root = createRoot(container);
    flushSync(() => {
      root!.render(React.createElement(App));
    });
    await flushUi();

    expect(container.querySelector('[data-testid="workspace-nav-bar"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="workspace-view-TRADING"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="cockpit-bottom-panel"]')).not.toBeNull();
    expect(mockCreateChart).toHaveBeenCalledTimes(1);
    expect(mockSeries.setData).toHaveBeenCalled();

    // PROPFIRM and QUANT HUDs must NOT be mounted in TRADING view
    expect(container.querySelector('[data-testid="workspace-view-PROPFIRM"]')).toBeNull();
    expect(container.querySelector('[data-testid="propfirm-challenge-hud"]')).toBeNull();
    expect(container.querySelector('[data-testid="workspace-view-QUANT"]')).toBeNull();
    expect(container.textContent).not.toContain('Institutional Confluence Matrix');

    // Right rail AutoPilotControls must be mounted
    expect(container.textContent).toContain('Autonomous Auto-Pilot');
  });

  it('switches to PROPFIRM view with history table open by default and TradeJournalPanel, while keeping right rail mounted', async () => {
    root = createRoot(container);
    flushSync(() => {
      root!.render(React.createElement(App));
    });
    await flushUi();

    const propFirmTab = container.querySelector('[data-testid="workspace-tab-PROPFIRM"]') as HTMLButtonElement;
    expect(propFirmTab).not.toBeNull();

    flushSync(() => {
      propFirmTab.click();
    });
    await flushUi();

    expect(useUiStore.getState().activeWorkspaceView).toBe('PROPFIRM');
    expect(container.querySelector('[data-testid="workspace-view-PROPFIRM"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="propfirm-challenge-hud"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="propfirm-history-table"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="propfirm-download-cert-btn"]')).not.toBeNull();
    expect(container.textContent).toContain('Verified Trade Journal & Quant Analytics');

    // TRADING view unmounted cleanly
    expect(container.querySelector('[data-testid="workspace-view-TRADING"]')).toBeNull();
    expect(mockChart.remove).toHaveBeenCalledTimes(1);

    // Right rail AutoPilotControls stays pinned
    expect(container.textContent).toContain('Autonomous Auto-Pilot');
  });

  it('switches to QUANT view rendering ConfluenceHUD + AgentTelemetryPanel, while keeping right rail mounted', async () => {
    root = createRoot(container);
    flushSync(() => {
      root!.render(React.createElement(App));
    });
    await flushUi();

    const quantTab = container.querySelector('[data-testid="workspace-tab-QUANT"]') as HTMLButtonElement;
    expect(quantTab).not.toBeNull();

    flushSync(() => {
      quantTab.click();
    });
    await flushUi();

    expect(useUiStore.getState().activeWorkspaceView).toBe('QUANT');
    expect(container.querySelector('[data-testid="workspace-view-QUANT"]')).not.toBeNull();
    expect(container.textContent).toContain('Institutional Confluence Matrix');
    expect(container.querySelector('[data-testid="quant-conviction-indicator"]')).not.toBeNull();
    expect(container.textContent).toContain('Agent Loqları');
    expect(container.querySelector('[data-testid="workspace-view-TRADING"]')).toBeNull();
    expect(container.querySelector('[data-testid="workspace-view-PROPFIRM"]')).toBeNull();

    // Right rail AutoPilotControls stays pinned
    expect(container.textContent).toContain('Autonomous Auto-Pilot');
  });

  it('cleanly remounts ChartCanvas with candles and cockpit-bottom-panel when switching back to TRADING', async () => {
    root = createRoot(container);
    flushSync(() => {
      root!.render(React.createElement(App));
    });
    await flushUi();

    expect(mockCreateChart).toHaveBeenCalledTimes(1);

    // Switch away to PROPFIRM, then QUANT, then back to TRADING
    const propFirmTab = container.querySelector('[data-testid="workspace-tab-PROPFIRM"]') as HTMLButtonElement;
    flushSync(() => {
      propFirmTab.click();
    });
    await flushUi();
    expect(mockChart.remove).toHaveBeenCalledTimes(1);

    const quantTab = container.querySelector('[data-testid="workspace-tab-QUANT"]') as HTMLButtonElement;
    flushSync(() => {
      quantTab.click();
    });
    await flushUi();

    mockSeries.setData.mockClear();

    const tradingTab = container.querySelector('[data-testid="workspace-tab-TRADING"]') as HTMLButtonElement;
    flushSync(() => {
      tradingTab.click();
    });
    await flushUi();

    expect(useUiStore.getState().activeWorkspaceView).toBe('TRADING');
    expect(container.querySelector('[data-testid="workspace-view-TRADING"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="cockpit-bottom-panel"]')).not.toBeNull();
    expect(mockCreateChart).toHaveBeenCalledTimes(2);
    expect(mockSeries.setData).toHaveBeenCalled();
  });
});
