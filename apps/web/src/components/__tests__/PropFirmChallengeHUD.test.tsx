/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { flushSync } from 'react-dom';
import type { PropFirmStatusResponse, PropFirmChallengeCycle } from '@tradeos/shared';
import { useMarketStore } from '../../store/useMarketStore';
import { PropFirmChallengeHUD } from '../PropFirmChallengeHUD';

function makeCycle(overrides: Partial<PropFirmChallengeCycle> = {}): PropFirmChallengeCycle {
  return {
    id: 'cycle-1',
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
    startedAt: Date.UTC(2026, 10, 25, 8, 0, 0),
    closedAt: null,
    ...overrides,
  };
}

function makeStatus(overrides: Partial<PropFirmStatusResponse> = {}): PropFirmStatusResponse {
  const cycle = overrides.cycle ?? makeCycle();
  return {
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
    liveWalletBalanceUsd: 50_000,
    needsTopUp: false,
    topUpMessage: null,
    consecutivePassedCycles: 2,
    requiredPassedCycles: 5,
    canTrade: true,
    haltReason: null,
    cycles: [cycle],
    updatedAt: Date.UTC(2026, 10, 25, 10, 0, 0),
    ...overrides,
  };
}

describe('PropFirmChallengeHUD', () => {
  let container: HTMLDivElement;
  let root: Root | null = null;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    useMarketStore.setState({ propFirmStatus: null });
  });

  afterEach(() => {
    if (root) {
      flushSync(() => {
        root?.unmount();
      });
      root = null;
    }
    container.remove();
  });

  function renderHud() {
    root = createRoot(container);
    flushSync(() => {
      root!.render(React.createElement(PropFirmChallengeHUD));
    });
  }

  it('renders YES_PROFIT verdict box in green with signed USD and percent', () => {
    useMarketStore.setState({
      propFirmStatus: makeStatus({
        verdict: 'YES_PROFIT',
        cycle: makeCycle({ netPnlUsd: 840.5, netPnlPct: 1.681 }),
      }),
    });

    renderHud();

    const hud = container.querySelector('[data-testid="propfirm-challenge-hud"]');
    expect(hud).not.toBeNull();

    const verdictBox = container.querySelector('[data-testid="propfirm-verdict-box"]');
    expect(verdictBox).not.toBeNull();
    expect(verdictBox?.textContent).toContain('Doğurdan Qazanırammı?');
    expect(verdictBox?.textContent).toContain('BƏLİ, QAZANCDASAN');
    expect(verdictBox?.textContent).toContain('+$840.50');
    expect(verdictBox?.textContent).toContain('+1.68%');
    expect(verdictBox?.innerHTML).toContain('#0ecb81');
    expect(container.textContent).not.toContain('$-');
  });

  it('renders NO_LOSS verdict box in red with -$120.00 and zero malformed $- currency strings', () => {
    useMarketStore.setState({
      propFirmStatus: makeStatus({
        verdict: 'NO_LOSS',
        cycle: makeCycle({
          currentEquityUsd: 49_880,
          netPnlUsd: -120,
          netPnlPct: -0.24,
          maxDrawdownUsd: 120,
        }),
        dailyPnlUsd: -120,
        dailyLossUsedUsd: 120,
        dailyBufferRemainingUsd: 1_130,
        dailyBufferRemainingPct: 90.4,
        trailingLossUsedUsd: 120,
        trailingBufferRemainingUsd: 2_380,
        trailingBufferRemainingPct: 95.2,
        targetProgressPct: 0,
        targetRemainingUsd: 2_620,
      }),
    });

    renderHud();

    const verdictBox = container.querySelector('[data-testid="propfirm-verdict-box"]');
    expect(verdictBox).not.toBeNull();
    expect(verdictBox?.textContent).toContain('XEYR, ZƏRƏRDƏSƏN');
    expect(verdictBox?.textContent).toContain('-$120.00');
    expect(verdictBox?.textContent).toContain('-0.24%');
    expect(verdictBox?.innerHTML).toContain('#f6465d');
    expect(container.textContent).not.toContain('$-');
  });

  it('renders WAITING verdict box in neutral gray when flat or waiting', () => {
    useMarketStore.setState({
      propFirmStatus: makeStatus({
        verdict: 'WAITING',
        cycle: makeCycle({
          currentEquityUsd: 50_000,
          netPnlUsd: 0,
          netPnlPct: 0,
        }),
        targetProgressPct: 0,
        targetRemainingUsd: 2_500,
      }),
    });

    renderHud();

    const verdictBox = container.querySelector('[data-testid="propfirm-verdict-box"]');
    expect(verdictBox).not.toBeNull();
    expect(verdictBox?.textContent).toContain('GÖZLƏMƏDƏ');
    expect(verdictBox?.textContent).toContain('$0.00');
    expect(container.textContent).not.toContain('$-');
  });

  it('renders $2,500 target progress, $1,250 daily buffer, $2,500 trailing buffer, FLOOR LOCKED badge, and 5-cycle certificate', () => {
    useMarketStore.setState({
      propFirmStatus: makeStatus({
        verdict: 'YES_PROFIT',
        cycle: makeCycle({
          currentEquityUsd: 51_450,
          highWaterMarkUsd: 53_100,
          contractualTrailingFloorUsd: 50_000,
          internalTrailingFloorUsd: 50_500,
          isFloorLocked: true,
          netPnlUsd: 1_450,
          netPnlPct: 2.9,
        }),
        targetProgressPct: 58.0,
        targetRemainingUsd: 1_050,
        dailyBufferRemainingUsd: 1_130,
        dailyBufferRemainingPct: 90.4,
        trailingBufferRemainingUsd: 2_180,
        trailingBufferRemainingPct: 87.2,
        consecutivePassedCycles: 3,
        requiredPassedCycles: 5,
      }),
    });

    renderHud();

    const text = container.textContent ?? '';
    expect(text).toContain('Hədəf: +$2,500.00');
    expect(text).toContain('+$1,450.00');
    expect(text).toContain('58.0% Tamamlandı');
    expect(text).toContain('Qalan: $1,050.00');

    expect(text).toContain('Gündəlik Zərər Həddi: $1,250.00');
    expect(text).toContain('Qalan Haqq: $1,130.00');

    expect(text).toContain('Maksimum Geriləmə Həddi: $2,500.00');
    expect(text).toContain('Qalan Haqq: $2,180.00');

    expect(text).toContain('FLOOR LOCKED: $50,000');
    expect(text).toContain('Sertifikat: 3 / 5 Uğurlu Dövrə');
    expect(text).not.toContain('$-');
  });

  it('renders explicit Testnet Top-Up reminder banner when needsTopUp is true and hides when false', () => {
    useMarketStore.setState({
      propFirmStatus: makeStatus({
        liveWalletBalanceUsd: 4_606.01,
        needsTopUp: true,
        topUpMessage: 'Binance Demo Faucet vasitəsilə balansı $50,000.00 USDT edin',
      }),
    });

    renderHud();

    const banner = container.querySelector('[data-testid="propfirm-topup-banner"]');
    expect(banner).not.toBeNull();
    expect(banner?.textContent).toContain('$4,606.01');
    expect(banner?.textContent).toContain('$50,000.00');
    expect(banner?.textContent).toContain('Binance Demo Faucet');

    // Now switch needsTopUp to false and verify banner disappears
    flushSync(() => {
      useMarketStore.setState({
        propFirmStatus: makeStatus({
          liveWalletBalanceUsd: 50_000,
          needsTopUp: false,
          topUpMessage: null,
        }),
      });
    });

    expect(container.querySelector('[data-testid="propfirm-topup-banner"]')).toBeNull();
  });

  it('expands cycle history table on click and displays formatted historical statuses', () => {
    const cycles: PropFirmChallengeCycle[] = [
      makeCycle({
        id: 'c4',
        cycleNumber: 4,
        status: 'ACTIVE',
        netPnlUsd: 420.25,
        maxDrawdownUsd: 95,
        startedAt: Date.UTC(2026, 10, 25, 9, 0, 0),
        closedAt: null,
      }),
      makeCycle({
        id: 'c3',
        cycleNumber: 3,
        status: 'PASSED',
        netPnlUsd: 2_540.0,
        maxDrawdownUsd: 310.5,
        startedAt: Date.UTC(2026, 10, 22, 9, 0, 0),
        closedAt: Date.UTC(2026, 10, 24, 15, 0, 0),
      }),
      makeCycle({
        id: 'c2',
        cycleNumber: 2,
        status: 'HALTED_DAILY_BUFFER',
        netPnlUsd: -1_255.0,
        maxDrawdownUsd: 1_255.0,
        startedAt: Date.UTC(2026, 10, 20, 9, 0, 0),
        closedAt: Date.UTC(2026, 10, 20, 18, 0, 0),
      }),
      makeCycle({
        id: 'c1',
        cycleNumber: 1,
        status: 'FAILED_TRAILING',
        netPnlUsd: -3_020.0,
        maxDrawdownUsd: 3_020.0,
        startedAt: Date.UTC(2026, 10, 18, 9, 0, 0),
        closedAt: Date.UTC(2026, 10, 19, 12, 0, 0),
      }),
    ];

    useMarketStore.setState({
      propFirmStatus: makeStatus({
        cycle: cycles[0],
        cycles,
      }),
    });

    renderHud();

    // Collapsed by default
    expect(container.querySelector('[data-testid="propfirm-history-table"]')).toBeNull();

    const toggleBtn = container.querySelector(
      '[data-testid="propfirm-history-toggle"]'
    ) as HTMLButtonElement | null;
    expect(toggleBtn).not.toBeNull();
    expect(toggleBtn?.textContent).toContain('Açılan Tarixçə Cədvəli');

    flushSync(() => {
      toggleBtn!.click();
    });

    const table = container.querySelector('[data-testid="propfirm-history-table"]');
    expect(table).not.toBeNull();

    const tableText = table?.textContent ?? '';
    expect(tableText).toContain('Dövrə #');
    expect(tableText).toContain('Qazanc/Ziyan');
    expect(tableText).toContain('Max Drawdown');
    expect(tableText).toContain('Tarix');
    expect(tableText).toContain('✓ UĞURLU');
    expect(tableText).toContain('LİMİT HALT');
    expect(tableText).toContain('LİMİT AŞILDI');
    expect(tableText).toContain('AKTİV');
    expect(tableText).toContain('-$1,255.00');
    expect(tableText).toContain('-$3,020.00');
    expect(tableText).toContain('+$2,540.00');
    expect(tableText).not.toContain('$-');
  });
});
