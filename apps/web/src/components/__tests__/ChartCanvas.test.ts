/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { calculateLiquidationPrice, computeOrderPreview } from '@tradeos/shared';
import { useMarketStore } from '../../store/useMarketStore';
import { useUiStore } from '../../store/useUiStore';
import { formatLocalTime, updateCandleWithTick, ChartCanvas } from '../ChartCanvas';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import type { FairValueGap, LiquiditySweep } from '@tradeos/shared';

// Mock lightweight-charts createChart
const { mockSeries, mockChart } = vi.hoisted(() => {
  const mockSeries = {
    setData: vi.fn(),
    update: vi.fn(),
    createPriceLine: vi.fn((opts: any) => ({ ...opts, id: Math.random() })),
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

  return { mockSeries, mockChart };
});

vi.mock('lightweight-charts', () => ({
  createChart: vi.fn(() => mockChart),
  ColorType: { Solid: 'solid' },
  LineStyle: { Solid: 0, Dotted: 1, Dashed: 2, LargeDashed: 3 },
  CrosshairMode: { Normal: 0, Magnet: 1 },
}));

describe('ChartCanvas & Price Line Logic', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSeries.createPriceLine.mockClear();
    mockSeries.setMarkers.mockClear();
    useMarketStore.setState({
      symbol: 'BTCUSDT',
      markPrice: 90000,
      activePosition: null,
      klines: [],
      activeFvgs: [],
      latestSweep: null,
      showSmcOverlay: true,
    });
    useUiStore.getState().resetOrderDraft();
  });

  it('calculates isolated liquidation price accurately for Long and Short', () => {
    const entry = 90000;
    const lev = 10;
    const mmr = 0.005;

    const longLiq = calculateLiquidationPrice('BUY', entry, lev, mmr);
    // Formula: entry * (1 - 1/lev) / (1 - mmr) = 90000 * 0.9 / 0.995 = 81407.035...
    expect(longLiq).toBeCloseTo(81407.035, 1);
    expect(longLiq).toBeLessThan(entry);

    const shortLiq = calculateLiquidationPrice('SELL', entry, lev, mmr);
    // Formula: entry * (1 + 1/lev) / (1 + mmr) = 90000 * 1.1 / 1.005 = 98507.46...
    expect(shortLiq).toBeCloseTo(98507.46, 1);
    expect(shortLiq).toBeGreaterThan(entry);
  });

  it('computes preview lines with Dead-SL armor check', () => {
    const markPrice = 90000;
    const preview = computeOrderPreview(
      {
        symbol: 'BTCUSDT',
        side: 'BUY',
        orderType: 'MARKET',
        marginUsd: 100,
        leverage: 10,
        stopLoss: 85000,
        tp1: 95000,
        tp2: 100000,
      },
      markPrice,
      0.1,
      0.001
    );

    expect(preview.quantity).toBeGreaterThan(0);
    expect(preview.deadSlSafe).toBe(true);
    expect(preview.estimatedLiquidation).toBeLessThan(85000);
    expect(preview.rrRatio).toBeGreaterThan(0);
    expect(preview.breakevenPrice).toBeGreaterThan(markPrice);
  });

  it('detects Dead-SL safety violations when SL is beyond liquidation price', () => {
    const markPrice = 90000;
    // Long liquidation for 10x is ~81407. If user places SL at 80000, it is dead on arrival!
    const preview = computeOrderPreview(
      {
        symbol: 'BTCUSDT',
        side: 'BUY',
        orderType: 'MARKET',
        marginUsd: 100,
        leverage: 10,
        stopLoss: 80000, // Beyond 81407 liq!
      },
      markPrice,
      0.1,
      0.001
    );

    expect(preview.deadSlSafe).toBe(false);
  });

  it('updates store state and active position correctly on position event', () => {
    useMarketStore.getState().applyPositionEvent({
      event: 'OPENED',
      data: {
        trade: {
          id: 'trade-123',
          symbol: 'BTCUSDT',
          broker_mode: 'BINANCE_DEMO',
          side: 'BUY',
          status: 'OPEN',
          entry_price: 90000,
          exit_price: null,
          quantity: 0.01,
          remaining_qty: 0.01,
          leverage: 10,
          margin_usd: 90,
          stop_loss: 88000,
          tp1: 92000,
          tp2: 95000,
          be_price: null,
          is_breakeven: 0,
          client_order_id: 'tos_trade-123_ent',
          client_sl_id: 'tos_trade-123_sl',
          client_tp1_id: 'tos_trade-123_tp1',
          client_tp2_id: null,
          entry_order_id: 'e-1',
          sl_algo_id: 'sl-1',
          tp1_algo_id: 'tp1-1',
          tp2_algo_id: null,
          realized_pnl: 0,
          fees_usd: 0.05,
          exit_reason: null,
          opened_at: Date.now(),
          closed_at: null,
        },
      },
    });

    const pos = useMarketStore.getState().activePosition;
    expect(pos).not.toBeNull();
    expect(pos?.entry_price).toBe(90000);
    expect(pos?.stop_loss).toBe(88000);

    // Now simulate position close event
    useMarketStore.getState().applyPositionEvent({
      event: 'CLOSED',
      data: {
        trade: { ...pos!, status: 'CLOSED' },
      },
    });

    expect(useMarketStore.getState().activePosition).toBeNull();
  });

  it('formats UTC epoch seconds into local Baku (UTC+4) time string', () => {
    // 1795101000 is 2026-11-19 15:10:00 UTC -> 19:10:00 Baku (UTC+4)
    const formatted = formatLocalTime(1795101000);
    expect(formatted).toMatch(/19:10/);
  });

  it('updates live candle with incoming mark price dynamically (high, low, close)', () => {
    const candle = {
      time: 1795101000,
      open: 100,
      high: 105,
      low: 95,
      close: 100,
      volume: 10,
    };

    // Upward breach
    const updatedHigh = updateCandleWithTick(candle, 110);
    expect(updatedHigh.high).toBe(110);
    expect(updatedHigh.close).toBe(110);
    expect(updatedHigh.low).toBe(95);

    // Downward breach
    const updatedLow = updateCandleWithTick(updatedHigh, 90);
    expect(updatedLow.low).toBe(90);
    expect(updatedLow.close).toBe(90);
    expect(updatedLow.high).toBe(110);
  });

  it('preserves klines array reference during streaming ticks (60fps decoupling)', () => {
    const initialKlines = [
      { time: 1795101000, open: 71.0, high: 71.5, low: 70.8, close: 71.2, volume: 50 },
    ];
    useMarketStore.setState({
      symbol: 'SOLUSDT',
      markPrice: 71.2,
      klines: initialKlines,
    });

    // An incoming streaming tick arrives at 4Hz
    useMarketStore.getState().applyTick({
      symbol: 'SOLUSDT',
      markPrice: 71.4,
      unrealizedPnl: 1.5,
      cvd: 100,
      candle: { time: 1795101000, open: 71.0, high: 71.6, low: 70.8, close: 71.4, volume: 55 },
    });

    const state = useMarketStore.getState();
    expect(state.markPrice).toBe(71.4);
    // Crucial: klines reference identity must be preserved to prevent 4Hz canvas re-render thrashing!
    expect(state.klines).toBe(initialKlines);
  });

  it('renders twin price lines for active FVG zones and sweep markers when showSmcOverlay is enabled', () => {
    const activeFvg: FairValueGap = {
      id: 'fvg-1',
      timeframe: '15m',
      type: 'BULLISH',
      high: 92000,
      low: 91500,
      mitigated: false,
      formedAt: 1795101000,
    };

    const mitigatedFvg: FairValueGap = {
      id: 'fvg-2',
      timeframe: '15m',
      type: 'BULLISH',
      high: 90000,
      low: 89500,
      mitigated: true,
      formedAt: 1795100000,
    };

    const sweep: LiquiditySweep = {
      id: 'sw-1',
      direction: 'SWEEP_HIGH',
      sweepPrice: 93500,
      reclaimPrice: 93200,
      time: 1795101000,
    };

    useMarketStore.setState({
      symbol: 'BTCUSDT',
      activeFvgs: [activeFvg, mitigatedFvg],
      latestSweep: sweep,
      showSmcOverlay: true,
    });

    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    flushSync(() => {
      root.render(React.createElement(ChartCanvas));
    });

    // Check createPriceLine calls on mock series
    expect(mockSeries).not.toBeNull();
    const calls = mockSeries.createPriceLine.mock.calls.map((c: any) => c[0]);

    // FVG HIGH line
    const highFvgLine = calls.find((c: any) => c.title === 'FVG HIGH');
    expect(highFvgLine).toBeDefined();
    expect(highFvgLine.price).toBe(92000);
    expect(highFvgLine.color).toBe('rgba(14, 203, 129, 0.6)');
    expect(highFvgLine.axisLabelVisible).toBe(false);

    // FVG LOW line
    const lowFvgLine = calls.find((c: any) => c.title === 'FVG LOW');
    expect(lowFvgLine).toBeDefined();
    expect(lowFvgLine.price).toBe(91500);
    expect(lowFvgLine.color).toBe('rgba(14, 203, 129, 0.3)');
    expect(lowFvgLine.axisLabelVisible).toBe(false);

    // Mitigated FVG lines should NOT be created
    const mitigatedHigh = calls.find((c: any) => c.price === 90000);
    expect(mitigatedHigh).toBeUndefined();

    // Liquidity Sweep price line
    const sweepLine = calls.find((c: any) => c.title === 'SWEEP HIGH');
    expect(sweepLine).toBeDefined();
    expect(sweepLine.price).toBe(93500);

    // Liquidity Sweep marker on candle series
    expect(mockSeries.setMarkers).toHaveBeenCalled();
    const markerCall = mockSeries.setMarkers.mock.calls[mockSeries.setMarkers.mock.calls.length - 1][0];
    expect(markerCall).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          text: 'SWEEP HIGH',
          shape: 'arrowDown',
        }),
      ])
    );
  });

  it('hides FVG twin price lines and sweep markers when showSmcOverlay is false', () => {
    const activeFvg: FairValueGap = {
      id: 'fvg-1',
      timeframe: '15m',
      type: 'BULLISH',
      high: 92000,
      low: 91500,
      mitigated: false,
      formedAt: 1795101000,
    };

    const sweep: LiquiditySweep = {
      id: 'sw-1',
      direction: 'SWEEP_HIGH',
      sweepPrice: 93500,
      reclaimPrice: 93200,
      time: 1795101000,
    };

    useMarketStore.setState({
      symbol: 'BTCUSDT',
      activeFvgs: [activeFvg],
      latestSweep: sweep,
      showSmcOverlay: false,
    });

    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    flushSync(() => {
      root.render(React.createElement(ChartCanvas));
    });

    const calls = mockSeries.createPriceLine.mock.calls.map((c: any) => c[0]);
    expect(calls.find((c: any) => c.title === 'FVG HIGH')).toBeUndefined();
    expect(calls.find((c: any) => c.title === 'FVG LOW')).toBeUndefined();
    expect(calls.find((c: any) => c.title === 'SWEEP HIGH')).toBeUndefined();

    const markerCall = mockSeries.setMarkers.mock.calls[mockSeries.setMarkers.mock.calls.length - 1][0];
    expect(markerCall).toEqual([]);
    root.unmount();
    container.remove();
  });
});
