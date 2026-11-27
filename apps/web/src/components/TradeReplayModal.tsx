import React, { useEffect, useRef, useState } from 'react';
import {
  createChart,
  ColorType,
  LineStyle,
  CrosshairMode,
  type IChartApi,
  type ISeriesApi,
  type UTCTimestamp,
} from 'lightweight-charts';
import type { KlineCandle, TradeRecord } from '@tradeos/shared';
import { apiClient } from '../lib/apiClient';
import { attachSmartChartInteraction, type SmartChartInteractionHandle } from '../lib/chartInteractions';
import { formatUsd } from '../lib/formatters';
import { X, CandlestickChart } from 'lucide-react';

export interface TradeReplayModalProps {
  trade: TradeRecord;
  onClose: () => void;
}

type ReplayInterval = '1m' | '5m' | '15m';

const INTERVAL_SEC: Record<ReplayInterval, number> = {
  '1m': 60,
  '5m': 300,
  '15m': 900,
};

function formatBakuTime(tsSec: number): string {
  return new Date(tsSec * 1000).toLocaleTimeString('az-AZ', {
    timeZone: 'Asia/Baku',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

function formatDuration(openedAt?: number | null, closedAt?: number | null): string {
  if (!openedAt || !closedAt || closedAt <= openedAt) return '--';
  const totalSec = Math.floor((closedAt - openedAt) / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}s ${m}d`;
  if (m > 0) return `${m}d ${s}san`;
  return `${s}san`;
}

export const TradeReplayModal: React.FC<TradeReplayModalProps> = ({ trade, onClose }) => {
  const defaultInterval: ReplayInterval =
    trade.opened_at && trade.closed_at && trade.closed_at - trade.opened_at > 6 * 3600 * 1000
      ? '5m'
      : '1m';

  const [interval, setInterval] = useState<ReplayInterval>(defaultInterval);
  const [candles, setCandles] = useState<KlineCandle[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const containerRef = useRef<HTMLDivElement>(null);
  const slZoneRef = useRef<HTMLDivElement>(null);
  const tp1ZoneRef = useRef<HTMLDivElement>(null);
  const tp2ZoneRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const chartInteractionRef = useRef<SmartChartInteractionHandle | null>(null);
  const candleSeriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null);

  // Close on Escape
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  // Fetch historical candles around the trade's open..close window
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      setIsLoading(true);
      setErrorMsg(null);
      try {
        const stepSec = INTERVAL_SEC[interval];
        const stepMs = stepSec * 1000;
        const openedAt = trade.opened_at || (trade.closed_at ? trade.closed_at - 30 * stepMs : Date.now() - 60 * stepMs);
        const closedAt = trade.closed_at || Date.now();
        const startMs = Math.max(1, openedAt - 45 * stepMs);
        const endMs = closedAt + 720 * stepMs;
        const firstBatch = await apiClient.getKlines(trade.symbol, interval, 1000, endMs, startMs);
        const combined = Array.isArray(firstBatch) ? [...firstBatch] : [];

        // If trade duration + post-exit window exceeded 1000 bars, fetch one follow-up page after the last bar
        if (combined.length >= 999) {
          const lastSec = Math.max(...combined.map((k) => k?.time ?? 0));
          const nextStartMs = (lastSec + stepSec) * 1000;
          if (Number.isFinite(nextStartMs) && nextStartMs < Math.min(endMs, Date.now()) - stepMs) {
            const secondBatch = await apiClient.getKlines(trade.symbol, interval, 1000, endMs, nextStartMs);
            if (Array.isArray(secondBatch) && secondBatch.length > 0) {
              combined.push(...secondBatch);
            }
          }
        }

        if (!cancelled) {
          const sorted = combined
            .filter((k) => k && Number.isFinite(k.time) && Number.isFinite(k.close) && k.close > 0)
            .sort((a, b) => a.time - b.time);
          setCandles(sorted);
        }
      } catch (err: any) {
        if (!cancelled) {
          setErrorMsg(err?.message || 'Tarixi şamlar yüklənmədi');
        }
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [trade.id, trade.symbol, trade.opened_at, trade.closed_at, interval]);

  // Render Lightweight Charts replay canvas
  useEffect(() => {
    if (!containerRef.current || candles.length === 0) return;

    containerRef.current.innerHTML = '';
    const chart = createChart(containerRef.current, {
      width: containerRef.current.clientWidth || 760,
      height: containerRef.current.clientHeight || 420,
      layout: {
        background: { type: ColorType.Solid, color: '#080c14' },
        textColor: '#7d8590',
        fontFamily: "'JetBrains Mono', monospace",
        fontSize: 11,
      },
      localization: {
        timeFormatter: (ts: number) => formatBakuTime(ts),
      },
      grid: {
        vertLines: { color: '#151d2c' },
        horzLines: { color: '#151d2c' },
      },
      crosshair: {
        mode: CrosshairMode.Normal,
        vertLine: { color: '#3b82f6', width: 1, style: LineStyle.Dashed, labelBackgroundColor: '#151d2c' },
        horzLine: { color: '#3b82f6', width: 1, style: LineStyle.Dashed, labelBackgroundColor: '#151d2c' },
      },
      rightPriceScale: {
        borderColor: '#151d2c',
        autoScale: true,
        scaleMargins: { top: 0.1, bottom: 0.18 },
      },
      handleScroll: {
        mouseWheel: true,
        pressedMouseMove: true,
        horzTouchDrag: true,
        vertTouchDrag: true,
      },
      handleScale: {
        axisPressedMouseMove: {
          time: true,
          price: true,
        },
        axisDoubleClickReset: {
          time: true,
          price: true,
        },
        mouseWheel: true,
        pinch: true,
      },
      timeScale: {
        borderColor: '#151d2c',
        timeVisible: true,
        secondsVisible: false,
        rightOffset: 8,
        minBarSpacing: 0.5,
        tickMarkFormatter: (ts: number) => formatBakuTime(ts),
      },
    });

    const candleSeries = chart.addCandlestickSeries({
      upColor: '#0ecb81',
      downColor: '#f6465d',
      borderUpColor: '#0ecb81',
      borderDownColor: '#f6465d',
      wickUpColor: '#0ecb81',
      wickDownColor: '#f6465d',
    });

    const volumeSeries = chart.addHistogramSeries({
      priceFormat: { type: 'volume' },
      priceScaleId: 'volume',
    });
    chart.priceScale('volume').applyOptions({
      visible: false,
      scaleMargins: { top: 0.82, bottom: 0 },
    });

    const uniqueMap = new Map<number, KlineCandle>();
    for (const c of candles) uniqueMap.set(c.time, c);
    const uniqueCandles = Array.from(uniqueMap.values()).sort((a, b) => a.time - b.time);

    candleSeries.setData(
      uniqueCandles.map((k) => ({
        time: k.time as UTCTimestamp,
        open: k.open,
        high: k.high,
        low: k.low,
        close: k.close,
      }))
    );
    volumeSeries.setData(
      uniqueCandles.map((k) => ({
        time: k.time as UTCTimestamp,
        value: k.volume,
        color: k.close >= k.open ? 'rgba(14, 203, 129, 0.3)' : 'rgba(246, 70, 93, 0.3)',
      }))
    );

    const priceDec = trade.entry_price < 10 ? 4 : 2;
    const isLong = trade.side === 'BUY';

    // Price lines: Entry, Exit, SL, TP1, TP2
    candleSeries.createPriceLine({
      price: trade.entry_price,
      color: '#3b82f6',
      lineWidth: 2,
      lineStyle: LineStyle.Dashed,
      axisLabelVisible: true,
      title: `Giriş (${isLong ? 'LONG' : 'SHORT'})`,
    });
    if (trade.exit_price && trade.exit_price > 0) {
      candleSeries.createPriceLine({
        price: trade.exit_price,
        color: (trade.realized_pnl - (trade.fees_usd || 0)) >= 0 ? '#0ecb81' : '#f0b90b',
        lineWidth: 2,
        lineStyle: LineStyle.Solid,
        axisLabelVisible: true,
        title: 'Çıxış',
      });
    }
    if (trade.stop_loss && trade.stop_loss > 0) {
      candleSeries.createPriceLine({
        price: trade.stop_loss,
        color: '#f6465d',
        lineWidth: 1,
        lineStyle: LineStyle.Solid,
        axisLabelVisible: true,
        title: 'Stop Loss',
      });
    }
    if (trade.tp1 && trade.tp1 > 0) {
      candleSeries.createPriceLine({
        price: trade.tp1,
        color: '#0ecb81',
        lineWidth: 1,
        lineStyle: LineStyle.Dashed,
        axisLabelVisible: true,
        title: 'TP1',
      });
    }
    if (trade.tp2 && trade.tp2 > 0) {
      candleSeries.createPriceLine({
        price: trade.tp2,
        color: '#10b981',
        lineWidth: 1,
        lineStyle: LineStyle.Dotted,
        axisLabelVisible: true,
        title: 'TP2',
      });
    }

    // Entry & Exit bar markers
    const stepSec = INTERVAL_SEC[interval];
    const snapTime = (ms?: number | null): number | null => {
      if (!ms || uniqueCandles.length === 0) return null;
      const target = Math.floor(ms / 1000 / stepSec) * stepSec;
      let best = uniqueCandles[0].time;
      let bestDiff = Math.abs(best - target);
      for (const c of uniqueCandles) {
        const diff = Math.abs(c.time - target);
        if (diff < bestDiff) {
          best = c.time;
          bestDiff = diff;
        }
      }
      return best;
    };

    const markers: any[] = [];
    const entryBarTime = snapTime(trade.opened_at);
    if (entryBarTime !== null) {
      markers.push({
        time: entryBarTime as UTCTimestamp,
        position: isLong ? 'belowBar' : 'aboveBar',
        color: '#3b82f6',
        shape: isLong ? 'arrowUp' : 'arrowDown',
        text: `GİRİŞ $${trade.entry_price.toFixed(priceDec)}`,
      });
    }
    const exitBarTime = snapTime(trade.closed_at);
    if (exitBarTime !== null && trade.exit_price) {
      const net = (trade.realized_pnl || 0) - (trade.fees_usd || 0);
      markers.push({
        time: exitBarTime as UTCTimestamp,
        position: isLong ? 'aboveBar' : 'belowBar',
        color: net >= 0 ? '#0ecb81' : '#f6465d',
        shape: isLong ? 'arrowDown' : 'arrowUp',
        text: `ÇIXIŞ $${trade.exit_price.toFixed(priceDec)}`,
      });
    }
    markers.sort((a, b) => Number(a.time) - Number(b.time));
    if (typeof (candleSeries as any).setMarkers === 'function') {
      (candleSeries as any).setMarkers(markers);
    }

    chart.timeScale().fitContent();
    chartRef.current = chart;
    candleSeriesRef.current = candleSeries;

    const updateZones = () => {
      const series = candleSeriesRef.current as any;
      const priceToY = typeof series?.priceToCoordinate === 'function'
        ? series.priceToCoordinate.bind(series)
        : null;
      const setBand = (el: HTMLDivElement | null, p1?: number | null, p2?: number | null) => {
        if (!el) return;
        if (!priceToY || !p1 || !p2 || p1 <= 0 || p2 <= 0) {
          el.style.display = 'none';
          return;
        }
        const y1 = priceToY(p1);
        const y2 = priceToY(p2);
        if (typeof y1 !== 'number' || typeof y2 !== 'number' || !Number.isFinite(y1) || !Number.isFinite(y2)) {
          el.style.display = 'none';
          return;
        }
        const top = Math.max(0, Math.min(y1, y2));
        const bottom = Math.max(0, Math.max(y1, y2));
        const height = bottom - top;
        if (height <= 0) {
          el.style.display = 'none';
          return;
        }
        el.style.display = 'block';
        el.style.top = `${top}px`;
        el.style.height = `${height}px`;
      };
      setBand(slZoneRef.current, trade.entry_price, trade.stop_loss);
      setBand(tp1ZoneRef.current, trade.entry_price, trade.tp1);
      setBand(tp2ZoneRef.current, trade.tp1 && trade.tp1 > 0 ? trade.tp1 : trade.entry_price, trade.tp2);
    };

    requestAnimationFrame(() => {
      updateZones();
    });
    chart.timeScale().subscribeVisibleLogicalRangeChange?.(updateZones);

    const containerEl = containerRef.current;
    const interaction = containerEl
      ? attachSmartChartInteraction(chart, containerEl, updateZones)
      : null;
    chartInteractionRef.current = interaction;

    let resizeObserver: ResizeObserver | null = null;
    if (typeof ResizeObserver !== 'undefined' && containerRef.current) {
      resizeObserver = new ResizeObserver((entries) => {
        const rect = entries[0]?.contentRect;
        if (rect && rect.width > 0 && rect.height > 0 && chartRef.current) {
          chartRef.current.applyOptions({
            width: Math.floor(rect.width),
            height: Math.floor(rect.height),
          });
          requestAnimationFrame(updateZones);
        }
      });
      resizeObserver.observe(containerRef.current);
    }

    return () => {
      chart.timeScale().unsubscribeVisibleLogicalRangeChange?.(updateZones);
      interaction?.cleanup();
      chartInteractionRef.current = null;
      resizeObserver?.disconnect();
      chart.remove();
      chartRef.current = null;
      candleSeriesRef.current = null;
    };
  }, [candles, trade, interval]);

  const netPnl = (trade.realized_pnl || 0) - (trade.fees_usd || 0);
  const priceDec = trade.entry_price < 10 ? 4 : 2;

  return (
    <div
      data-testid="trade-replay-modal"
      onClick={onClose}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 backdrop-blur-sm p-4 font-mono"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-5xl bg-[#080c14] border border-[#1f293d] rounded-xl shadow-2xl overflow-hidden flex flex-col"
      >
        {/* Header */}
        <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 border-b border-[#151d2c] bg-[#0d1421]">
          <div className="flex items-center space-x-2.5 flex-wrap">
            <CandlestickChart className="w-4 h-4 text-[#2962ff]" />
            <span className="font-bold text-sm text-[#e6edf3]">{trade.symbol}</span>
            <span
              className={`px-1.5 py-0.5 rounded text-[10px] font-bold ${
                trade.side === 'BUY' ? 'bg-[#0ecb81]/20 text-[#0ecb81]' : 'bg-[#f6465d]/20 text-[#f6465d]'
              }`}
            >
              {trade.side === 'BUY' ? 'LONG' : 'SHORT'} {trade.leverage}x
            </span>
            <span className="text-xs text-[#7d8590]">
              Giriş: <span className="text-[#e6edf3]">${trade.entry_price.toFixed(priceDec)}</span>
              {' → '}
              Çıxış: <span className="text-[#e6edf3]">{trade.exit_price ? `$${trade.exit_price.toFixed(priceDec)}` : '--'}</span>
            </span>
            <span className={`text-xs font-bold ${netPnl >= 0 ? 'text-[#0ecb81]' : 'text-[#f6465d]'}`}>
              Xalis: {formatUsd(netPnl, true)}
            </span>
            <span className="text-[11px] text-[#7d8590]">
              ({formatDuration(trade.opened_at, trade.closed_at)} · {trade.exit_reason || 'NORMAL'})
            </span>
          </div>

          <div className="flex items-center space-x-2">
            <button
              onClick={() => {
                if (chartInteractionRef.current) {
                  chartInteractionRef.current.fit();
                } else if (chartRef.current) {
                  chartRef.current.timeScale().fitContent();
                  chartRef.current.priceScale('right').applyOptions({ autoScale: true });
                }
              }}
              title="Qrafiki ekrana sığdır"
              className="px-2 py-0.5 text-[11px] rounded bg-[#151d2c] text-[#7d8590] hover:text-[#0ecb81] border border-[#151d2c] transition-colors"
            >
              Fit ⛶
            </button>
            <div className="flex items-center space-x-1 bg-[#020305] p-0.5 rounded border border-[#151d2c]">
              {(['1m', '5m', '15m'] as const).map((int) => (
                <button
                  key={int}
                  onClick={() => setInterval(int)}
                  className={`px-2 py-0.5 text-[11px] rounded transition-colors ${
                    interval === int
                      ? 'bg-[#151d2c] text-[#0ecb81] font-bold'
                      : 'text-[#7d8590] hover:text-[#e6edf3]'
                  }`}
                >
                  {int}
                </button>
              ))}
            </div>
            <button
              onClick={onClose}
              data-testid="trade-replay-close-btn"
              className="p-1 rounded bg-[#151d2c] text-[#7d8590] hover:text-[#e6edf3] transition-colors"
              title="Bağla (Esc)"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Stats Strip */}
        <div className="grid grid-cols-3 sm:grid-cols-6 gap-2 px-4 py-2 border-b border-[#151d2c] bg-[#020305] text-[11px]">
          <div>
            <span className="text-[#7d8590]">Marja: </span>
            <span className="text-[#e6edf3] font-semibold">${trade.margin_usd.toFixed(2)}</span>
          </div>
          <div>
            <span className="text-[#7d8590]">Brüt: </span>
            <span className={trade.realized_pnl >= 0 ? 'text-[#0ecb81] font-semibold' : 'text-[#f6465d] font-semibold'}>
              {formatUsd(trade.realized_pnl, true)}
            </span>
          </div>
          <div>
            <span className="text-[#7d8590]">Komissiya: </span>
            <span className="text-[#f0b90b] font-semibold">-${(trade.fees_usd || 0).toFixed(2)}</span>
          </div>
          <div>
            <span className="text-[#7d8590]">SL: </span>
            <span className="text-[#f6465d]">{trade.stop_loss ? `$${trade.stop_loss.toFixed(priceDec)}` : '--'}</span>
          </div>
          <div>
            <span className="text-[#7d8590]">TP1: </span>
            <span className="text-[#0ecb81]">{trade.tp1 ? `$${trade.tp1.toFixed(priceDec)}` : '--'}</span>
          </div>
          <div>
            <span className="text-[#7d8590]">TP2: </span>
            <span className="text-[#10b981]">{trade.tp2 ? `$${trade.tp2.toFixed(priceDec)}` : '--'}</span>
          </div>
        </div>

        {/* Chart Area */}
        <div className="relative w-full h-[420px] bg-[#080c14]">
          {isLoading && (
            <div className="absolute inset-0 z-20 flex items-center justify-center bg-[#080c14]/80 text-xs text-[#7d8590]">
              Tarixi qrafik yüklənir...
            </div>
          )}
          {errorMsg && !isLoading && (
            <div className="absolute inset-0 z-20 flex items-center justify-center bg-[#080c14]/90 text-xs text-[#f6465d]">
              {errorMsg}
            </div>
          )}
          <div ref={containerRef} className="w-full h-full" />
          <div className="pointer-events-none absolute top-0 left-0 right-[64px] bottom-[26px] overflow-hidden z-10">
            <div
              ref={slZoneRef}
              style={{ display: 'none', backgroundColor: 'rgba(246, 70, 93, 0.14)' }}
              className="absolute left-0 right-0"
            />
            <div
              ref={tp1ZoneRef}
              style={{ display: 'none', backgroundColor: 'rgba(14, 203, 129, 0.14)' }}
              className="absolute left-0 right-0"
            />
            <div
              ref={tp2ZoneRef}
              style={{ display: 'none', backgroundColor: 'rgba(14, 203, 129, 0.07)' }}
              className="absolute left-0 right-0"
            />
          </div>
        </div>
      </div>
    </div>
  );
};
