/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { JournalSummary, TradeRecord } from '@tradeos/shared';
import { TradeJournalPanel } from '../TradeJournalPanel';
import { apiClient } from '../../lib/apiClient';

const mockReplaySeries = {
  setData: vi.fn(),
  createPriceLine: vi.fn(() => ({})),
  setMarkers: vi.fn(),
};
const mockReplayChart = {
  applyOptions: vi.fn(),
  addCandlestickSeries: vi.fn(() => mockReplaySeries),
  addHistogramSeries: vi.fn(() => mockReplaySeries),
  priceScale: vi.fn(() => ({ applyOptions: vi.fn() })),
  timeScale: vi.fn(() => ({
    fitContent: vi.fn(),
    subscribeVisibleLogicalRangeChange: vi.fn(),
    unsubscribeVisibleLogicalRangeChange: vi.fn(),
  })),
  remove: vi.fn(),
};

vi.mock('lightweight-charts', () => ({
  createChart: vi.fn(() => mockReplayChart),
  ColorType: { Solid: 'solid' },
  LineStyle: { Solid: 0, Dotted: 1, Dashed: 2, LargeDashed: 3 },
  CrosshairMode: { Normal: 0 },
}));

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function makeTrade(overrides: Partial<TradeRecord> = {}): TradeRecord {
  return {
    id: 'trade-1',
    symbol: 'SOLUSDT',
    broker_mode: 'BINANCE_DEMO',
    side: 'BUY',
    status: 'CLOSED',
    entry_price: 150,
    exit_price: 145,
    quantity: 19.56,
    remaining_qty: 0,
    leverage: 10,
    margin_usd: 293.4,
    stop_loss: 144,
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
    realized_pnl: -97.82,
    fees_usd: 1.4,
    exit_reason: 'STOP_LOSS',
    opened_at: Date.UTC(2026, 10, 25, 8, 0, 0),
    closed_at: Date.UTC(2026, 10, 25, 9, 0, 0),
    ...overrides,
  };
}

describe('TradeJournalPanel', () => {
  let container: HTMLDivElement;
  let root: Root | null = null;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
  });

  afterEach(async () => {
    if (root) {
      await act(async () => {
        root!.unmount();
      });
      root = null;
    }
    container.remove();
    vi.restoreAllMocks();
  });

  it('renders fractional maxDrawdown as percentage (0.2%) alongside -$97.82 without 9782.0% inflation', async () => {
    const summary: JournalSummary = {
      trades: [makeTrade()],
      totalTrades: 1,
      winRate: 0,
      profitFactor: 0,
      maxDrawdown: 0.002,
      maxDrawdownUsd: 97.82,
      kellyCriterion: 0,
    };
    const getJournalSpy = vi.spyOn(apiClient, 'getJournal').mockResolvedValue(summary);

    root = createRoot(container);
    await act(async () => {
      root!.render(React.createElement(TradeJournalPanel));
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(getJournalSpy).toHaveBeenCalledWith(50, 0);
    const mddCard = container.querySelector('[data-testid="journal-max-drawdown"]');
    expect(mddCard).not.toBeNull();
    expect(mddCard?.textContent).toContain('0.2%');
    expect(mddCard?.textContent).toContain('-$97.82');
    expect(container.textContent).not.toContain('9782.0%');
  });

  it('renders 0.0% and -$0.00 cleanly when drawdown is zero or maxDrawdownUsd is omitted', async () => {
    const summary = {
      trades: [],
      totalTrades: 0,
      winRate: 0,
      profitFactor: 0,
      maxDrawdown: 0,
      kellyCriterion: 0,
    } as unknown as JournalSummary;
    vi.spyOn(apiClient, 'getJournal').mockResolvedValue(summary);

    root = createRoot(container);
    await act(async () => {
      root!.render(React.createElement(TradeJournalPanel));
    });
    await act(async () => {
      await Promise.resolve();
    });

    const mddCard = container.querySelector('[data-testid="journal-max-drawdown"]');
    expect(mddCard?.textContent).toContain('0.0%');
    expect(mddCard?.textContent).toContain('-$0.00');
  });

  it('collapses consecutive strategy milestones into 1 expandable row and shows details on click', async () => {
    const summary: JournalSummary = {
      trades: [
        makeTrade({ id: 't-new', opened_at: Date.parse('2026-11-27T15:00:00Z'), closed_at: Date.parse('2026-11-27T15:05:00Z') }),
        makeTrade({ id: 't-old', opened_at: Date.parse('2026-11-26T20:00:00Z'), closed_at: Date.parse('2026-11-26T20:05:00Z') }),
      ],
      totalTrades: 2,
      winRate: 0,
      profitFactor: 0,
      maxDrawdown: 0,
      maxDrawdownUsd: 0,
      kellyCriterion: 0,
    };
    vi.spyOn(apiClient, 'getJournal').mockResolvedValue(summary);

    root = createRoot(container);
    await act(async () => {
      root!.render(React.createElement(TradeJournalPanel));
    });
    await act(async () => {
      await Promise.resolve();
    });

    const milestoneRows = container.querySelectorAll('[data-testid="strategy-milestone-row"]');
    expect(milestoneRows.length).toBe(1);
    expect(milestoneRows[0].textContent).toContain('v2.1–v2.8');
    expect(milestoneRows[0].textContent).toContain('8 sistem dəyişikliyi');
    expect(milestoneRows[0].textContent).not.toContain('Fee-aware Trailing Stop');

    await act(async () => {
      (milestoneRows[0] as HTMLElement).click();
    });

    expect(milestoneRows[0].textContent).toContain('Fee-aware Trailing Stop');
    expect(milestoneRows[0].textContent).toContain('ARCH-10..12');
    expect(milestoneRows[0].textContent).toContain('ARCH-13..15');
    expect(milestoneRows[0].textContent).toContain('ARCH-16..18');
  });

  it('opens TradeReplayModal with historical candles when clicking trade-replay-btn', async () => {
    const trade = makeTrade({
      id: 'replay-1',
      symbol: 'ETHUSDT',
      side: 'SELL',
      entry_price: 1660.66,
      exit_price: 1670.89,
      opened_at: 1795792500000,
      closed_at: 1795793200000,
    });
    vi.spyOn(apiClient, 'getJournal').mockResolvedValue({
      trades: [trade],
      totalTrades: 1,
      winRate: 0,
      profitFactor: 0,
      maxDrawdown: 0,
      maxDrawdownUsd: 0,
      kellyCriterion: 0,
    });
    const getKlinesSpy = vi.spyOn(apiClient, 'getKlines').mockResolvedValue([
      { time: 1795792440, open: 1660, high: 1665, low: 1658, close: 1661, volume: 100 },
      { time: 1795792500, open: 1661, high: 1672, low: 1660, close: 1671, volume: 150 },
    ]);

    root = createRoot(container);
    await act(async () => {
      root!.render(React.createElement(TradeJournalPanel));
    });
    await act(async () => {
      await Promise.resolve();
    });

    const btn = container.querySelector('[data-testid="trade-replay-btn"]') as HTMLElement;
    expect(btn).not.toBeNull();
    await act(async () => {
      btn.click();
    });
    await act(async () => {
      await Promise.resolve();
    });

    const modal = container.querySelector('[data-testid="trade-replay-modal"]');
    expect(modal).not.toBeNull();
    expect(modal?.textContent).toContain('ETHUSDT');
    expect(getKlinesSpy).toHaveBeenCalled();

    const closeBtn = container.querySelector('[data-testid="trade-replay-close-btn"]') as HTMLElement;
    await act(async () => {
      closeBtn.click();
    });
    expect(container.querySelector('[data-testid="trade-replay-modal"]')).toBeNull();
  });
});
