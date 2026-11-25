/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { flushSync } from 'react-dom';
import type { PropFirmStatusResponse, PropFirmChallengeCycle, TradeRecord } from '@tradeos/shared';
import { useMarketStore } from '../../store/useMarketStore';
import { invalidateSessionToken } from '../../lib/apiClient';
import { PropFirmChallengeHUD } from '../PropFirmChallengeHUD';

async function flushAsyncUi(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 10));
  flushSync(() => {});
}

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

  let originalStartNewCycle: unknown;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    const state = useMarketStore.getState();
    originalStartNewCycle = (state as any).startNewPropFirmCycle;
    useMarketStore.setState({
      propFirmStatus: null,
      activePosition: null,
      autoPilot: {
        ...state.autoPilot,
        state: 'IDLE',
      },
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (originalStartNewCycle !== undefined) {
      useMarketStore.setState({ startNewPropFirmCycle: originalStartNewCycle as any });
    }
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
    expect(text).toContain('90.4% Təhlükəsiz');

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

  it('renders clickable Binance Demo Faucet link inside pure Azerbaijani top-up banner', () => {
    useMarketStore.setState({
      propFirmStatus: makeStatus({
        liveWalletBalanceUsd: 4_606.01,
        needsTopUp: true,
        topUpMessage:
          'Binance Testnet balansı $50,000.00 həddindən aşağıdır. Simulyasiya $50,000.00 kapitala sabitlənib; real ölçülü test üçün Binance Demo Faucet vasitəsilə USDT balansını $50,000.00-ə tamamlayın.',
      }),
    });

    renderHud();

    const banner = container.querySelector('[data-testid="propfirm-topup-banner"]');
    expect(banner).not.toBeNull();
    expect(banner?.textContent).not.toContain('TESTNET TOP-UP');

    const faucetLink = container.querySelector('[data-testid="propfirm-faucet-link"]') as HTMLAnchorElement | null;
    expect(faucetLink).not.toBeNull();
    expect(faucetLink?.tagName).toBe('A');
    expect(faucetLink?.getAttribute('href')).toBe('https://testnet.binancefuture.com');
    expect(faucetLink?.getAttribute('target')).toBe('_blank');
    expect(faucetLink?.getAttribute('rel')).toBe('noopener noreferrer');
  });

  it('removes truncate CSS class from target, daily buffer, and trailing buffer dollar cards while preserving substrings', () => {
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
        dailyBufferRemainingUsd: 1_250,
        dailyBufferRemainingPct: 100,
        trailingBufferRemainingUsd: 2_500,
        trailingBufferRemainingPct: 100,
      }),
    });

    renderHud();

    const targetCard = container.querySelector('[data-testid="propfirm-target-progress"]');
    const dailyCard = container.querySelector('[data-testid="propfirm-daily-buffer"]');
    const trailingCard = container.querySelector('[data-testid="propfirm-trailing-buffer"]');

    expect(targetCard).not.toBeNull();
    expect(dailyCard).not.toBeNull();
    expect(trailingCard).not.toBeNull();

    for (const card of [targetCard!, dailyCard!, trailingCard!]) {
      const truncated = card.querySelectorAll('.truncate');
      expect(truncated.length).toBe(0);
    }

    const text = container.textContent ?? '';
    expect(text).toContain('Hədəf: +$2,500.00');
    expect(text).toContain('Qalan: $2,500.00');
    expect(text).toContain('Gündəlik Zərər Həddi: $1,250.00');
    expect(text).toContain('Maksimum Geriləmə Həddi: $2,500.00');
    expect(text).toContain('Qalan Haqq:');
    expect(text).not.toContain('$-');
  });

  it('controls propfirm-new-cycle-btn visibility, disabled states, click rollover, and inline error alert', async () => {
    // Hidden on ACTIVE and HALTED_DAILY_BUFFER
    for (const status of ['ACTIVE', 'HALTED_DAILY_BUFFER'] as const) {
      useMarketStore.setState({
        propFirmStatus: makeStatus({ cycle: makeCycle({ status }) }),
      });
      renderHud();
      expect(container.querySelector('[data-testid="propfirm-new-cycle-btn"]')).toBeNull();
      flushSync(() => {
        root?.unmount();
      });
      root = null;
    }

    // Visible on PASSED, FAILED_DAILY, FAILED_TRAILING, HALTED_TRAILING_BUFFER
    for (const status of ['PASSED', 'FAILED_DAILY', 'FAILED_TRAILING', 'HALTED_TRAILING_BUFFER'] as const) {
      useMarketStore.setState({
        propFirmStatus: makeStatus({ cycle: makeCycle({ status }) }),
      });
      renderHud();
      const btn = container.querySelector('[data-testid="propfirm-new-cycle-btn"]') as HTMLButtonElement | null;
      expect(btn).not.toBeNull();
      expect(btn?.textContent).toContain('Yeni Dövrə Başlat');
      expect(btn?.disabled).toBe(false);
      flushSync(() => {
        root?.unmount();
      });
      root = null;
    }

    // Disabled when activePosition is non-CLOSED
    useMarketStore.setState({
      propFirmStatus: makeStatus({ cycle: makeCycle({ status: 'PASSED' }) }),
      activePosition: makeTrade({ status: 'OPEN' }),
    });
    renderHud();
    let btn = container.querySelector('[data-testid="propfirm-new-cycle-btn"]') as HTMLButtonElement | null;
    expect(btn?.disabled).toBe(true);

    // Enabled if activePosition is CLOSED and autoPilot is IDLE
    flushSync(() => {
      useMarketStore.setState({ activePosition: makeTrade({ status: 'CLOSED' }) });
    });
    btn = container.querySelector('[data-testid="propfirm-new-cycle-btn"]') as HTMLButtonElement | null;
    expect(btn?.disabled).toBe(false);

    // Disabled when autoPilot.state is in active execution states
    for (const apState of ['PLACING_ORDER', 'LIMIT_CHASING', 'POSITION_OPEN', 'CLOSING'] as const) {
      flushSync(() => {
        useMarketStore.setState((s) => ({
          activePosition: null,
          autoPilot: { ...s.autoPilot, state: apState },
        }));
      });
      btn = container.querySelector('[data-testid="propfirm-new-cycle-btn"]') as HTMLButtonElement | null;
      expect(btn?.disabled).toBe(true);
    }

    // Rejection displays propfirm-new-cycle-error and can be dismissed
    const rejectSpy = vi
      .fn()
      .mockRejectedValue(new Error('Açıq mövqe və ya icra edilən əmr olduğu halda yeni dövrə başladılmır.'));
    flushSync(() => {
      useMarketStore.setState((s) => ({
        activePosition: null,
        autoPilot: { ...s.autoPilot, state: 'IDLE' },
        startNewPropFirmCycle: rejectSpy,
      }));
    });
    btn = container.querySelector('[data-testid="propfirm-new-cycle-btn"]') as HTMLButtonElement | null;
    expect(btn?.disabled).toBe(false);

    btn!.click();
    await flushAsyncUi();

    expect(rejectSpy).toHaveBeenCalledTimes(1);
    const errAlert = container.querySelector('[data-testid="propfirm-new-cycle-error"]');
    expect(errAlert).not.toBeNull();
    expect(errAlert?.textContent).toContain('Açıq mövqe');

    // Dismissing the inline error alert hides it
    const dismissBtn = errAlert?.querySelector('button') as HTMLButtonElement | null;
    expect(dismissBtn).not.toBeNull();
    flushSync(() => {
      dismissBtn!.click();
    });
    expect(container.querySelector('[data-testid="propfirm-new-cycle-error"]')).toBeNull();

    // Success rollover updates propFirmStatus to Cycle #2 and clears error
    const cycle2Status = makeStatus({
      cycle: makeCycle({ id: 'cycle-2', cycleNumber: 2, status: 'ACTIVE', netPnlUsd: 0, netPnlPct: 0 }),
      verdict: 'WAITING',
    });
    const successSpy = vi.fn().mockImplementation(async () => {
      useMarketStore.setState({ propFirmStatus: cycle2Status });
      return cycle2Status;
    });
    flushSync(() => {
      useMarketStore.setState({ startNewPropFirmCycle: successSpy });
    });

    btn = container.querySelector('[data-testid="propfirm-new-cycle-btn"]') as HTMLButtonElement | null;
    btn!.click();
    await flushAsyncUi();

    expect(successSpy).toHaveBeenCalledTimes(1);
    expect(container.querySelector('[data-testid="propfirm-new-cycle-error"]')).toBeNull();
    expect(container.textContent).toContain('Dövrə #2');
  });

  it('store startNewPropFirmCycle updates propFirmStatus on 200 and propagates error.code/message on 409', async () => {
    sessionStorage.setItem('tradeos_session_token', 'test-token');
    try {
      const cycle2Status = makeStatus({
        cycle: makeCycle({ id: 'cycle-2', cycleNumber: 2, status: 'ACTIVE', netPnlUsd: 0, netPnlPct: 0 }),
        verdict: 'WAITING',
      });

      const fetchMock = vi
        .spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({ ok: true, status: cycle2Status, autoPilotState: 'IDLE' }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          )
        )
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              error: 'Açıq mövqe və ya icra edilən əmr olduğu halda yeni dövrə başladılmır.',
              code: 'OPEN_POSITION_EXISTS',
            }),
            { status: 409, headers: { 'Content-Type': 'application/json' } }
          )
        );

      const resStatus = await useMarketStore.getState().startNewPropFirmCycle();
      expect(resStatus.cycle.cycleNumber).toBe(2);
      expect(useMarketStore.getState().propFirmStatus?.cycle.id).toBe('cycle-2');
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/propfirm/new-cycle',
        expect.objectContaining({ method: 'POST' })
      );

      let caughtErr: any = null;
      try {
        await useMarketStore.getState().startNewPropFirmCycle();
      } catch (err) {
        caughtErr = err;
      }
      expect(caughtErr).not.toBeNull();
      expect(caughtErr.status).toBe(409);
      expect(caughtErr.code).toBe('OPEN_POSITION_EXISTS');
      expect(caughtErr.message).toContain('Açıq mövqe');
    } finally {
      invalidateSessionToken();
    }
  });
});
