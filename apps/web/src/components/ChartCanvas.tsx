import React, { useEffect, useRef } from 'react';
import {
  createChart,
  ColorType,
  LineStyle,
  CrosshairMode,
  type IChartApi,
  type ISeriesApi,
  type IPriceLine,
  type CandlestickData,
  type HistogramData,
  type UTCTimestamp,
} from 'lightweight-charts';
import { useMarketStore } from '../store/useMarketStore';
import { useUiStore } from '../store/useUiStore';
import { wsClient, type TickData } from '../lib/wsClient';
import { calculateLiquidationPrice } from '@tradeos/shared';

export interface ChartCanvasProps {
  className?: string;
}

export const ChartCanvas: React.FC<ChartCanvasProps> = ({ className = '' }) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleSeriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const volumeSeriesRef = useRef<ISeriesApi<'Histogram'> | null>(null);
  const priceLinesRef = useRef<IPriceLine[]>([]);

  const symbol = useMarketStore((s) => s.symbol);
  const klines = useMarketStore((s) => s.klines);
  const candleInterval = useMarketStore((s) => s.candleInterval);
  const setCandleInterval = useMarketStore((s) => s.setCandleInterval);
  const activePosition = useMarketStore((s) => s.activePosition);
  const orderDraft = useUiStore((s) => s.orderDraft);
  const markPrice = useMarketStore((s) => s.markPrice);

  // Initialize Lightweight Charts instance
  useEffect(() => {
    if (!containerRef.current) return;

    // Clear previous canvas if any
    containerRef.current.innerHTML = '';

    const chart = createChart(containerRef.current, {
      width: containerRef.current.clientWidth || 800,
      height: containerRef.current.clientHeight || 450,
      layout: {
        background: { type: ColorType.Solid, color: '#080c14' },
        textColor: '#7d8590',
        fontFamily: "'JetBrains Mono', monospace",
        fontSize: 11,
      },
      grid: {
        vertLines: { color: '#151d2c' },
        horzLines: { color: '#151d2c' },
      },
      crosshair: {
        mode: CrosshairMode.Normal,
        vertLine: {
          color: '#3b82f6',
          width: 1,
          style: LineStyle.Dashed,
          labelBackgroundColor: '#151d2c',
        },
        horzLine: {
          color: '#3b82f6',
          width: 1,
          style: LineStyle.Dashed,
          labelBackgroundColor: '#151d2c',
        },
      },
      rightPriceScale: {
        borderColor: '#151d2c',
        scaleMargins: {
          top: 0.1,
          bottom: 0.2,
        },
      },
      timeScale: {
        borderColor: '#151d2c',
        timeVisible: true,
        secondsVisible: false,
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
      priceFormat: {
        type: 'volume',
      },
      priceScaleId: 'volume',
    });

    chart.priceScale('volume').applyOptions({
      scaleMargins: {
        top: 0.8,
        bottom: 0,
      },
    });

    chartRef.current = chart;
    candleSeriesRef.current = candleSeries;
    volumeSeriesRef.current = volumeSeries;

    // Direct 60fps tick callback bypassing React component state
    const handleTick = (tick: TickData) => {
      if (!candleSeriesRef.current || !volumeSeriesRef.current) return;
      if (tick.symbol !== useMarketStore.getState().symbol) return;

      const c = tick.candle;
      if (c && c.time) {
        candleSeriesRef.current.update({
          time: c.time as UTCTimestamp,
          open: c.open,
          high: c.high,
          low: c.low,
          close: c.close,
        });

        volumeSeriesRef.current.update({
          time: c.time as UTCTimestamp,
          value: c.volume,
          color: c.close >= c.open ? 'rgba(14, 203, 129, 0.35)' : 'rgba(246, 70, 93, 0.35)',
        });
      }
    };

    // Attach tick listener to wsClient
    wsClient.setHandlers({ onTick: handleTick });

    // Handle container resize
    const resizeObserver = new ResizeObserver((entries) => {
      if (!entries || entries.length === 0 || !entries[0]) return;
      const { width, height } = entries[0].contentRect;
      if (width > 0 && height > 0) {
        chart.applyOptions({ width, height });
      }
    });

    resizeObserver.observe(containerRef.current);

    return () => {
      resizeObserver.disconnect();
      chart.remove();
      chartRef.current = null;
      candleSeriesRef.current = null;
      volumeSeriesRef.current = null;
    };
  }, []);

  // Update candles when klines store updates
  useEffect(() => {
    if (!candleSeriesRef.current || !volumeSeriesRef.current || klines.length === 0) return;

    const candleData: CandlestickData[] = klines.map((k) => ({
      time: k.time as UTCTimestamp,
      open: k.open,
      high: k.high,
      low: k.low,
      close: k.close,
    }));

    const volumeData: HistogramData[] = klines.map((k) => ({
      time: k.time as UTCTimestamp,
      value: k.volume,
      color: k.close >= k.open ? 'rgba(14, 203, 129, 0.35)' : 'rgba(246, 70, 93, 0.35)',
    }));

    candleSeriesRef.current.setData(candleData);
    volumeSeriesRef.current.setData(volumeData);
    chartRef.current?.timeScale().fitContent();
  }, [klines]);

  // Update active position and preview price lines
  useEffect(() => {
    const candleSeries = candleSeriesRef.current;
    if (!candleSeries) return;

    // Clear existing price lines
    priceLinesRef.current.forEach((line) => {
      try {
        candleSeries.removePriceLine(line);
      } catch {
        // Line might already be detached
      }
    });
    priceLinesRef.current = [];

    // 1. Draw Active Position Price Lines
    if (activePosition && activePosition.status !== 'CLOSED') {
      // Entry Line
      const entryLine = candleSeries.createPriceLine({
        price: activePosition.entry_price,
        color: '#2962ff',
        lineWidth: 2,
        lineStyle: LineStyle.Solid,
        axisLabelVisible: true,
        title: `POS ENTRY [${activePosition.side}]`,
      });
      priceLinesRef.current.push(entryLine);

      // Stop Loss Line
      if (activePosition.stop_loss && activePosition.stop_loss > 0) {
        const slLine = candleSeries.createPriceLine({
          price: activePosition.stop_loss,
          color: '#f6465d',
          lineWidth: 2,
          lineStyle: LineStyle.Solid,
          axisLabelVisible: true,
          title: 'ACTIVE SL',
        });
        priceLinesRef.current.push(slLine);
      }

      // Take Profit 1 Line
      if (activePosition.tp1 && activePosition.tp1 > 0) {
        const tp1Line = candleSeries.createPriceLine({
          price: activePosition.tp1,
          color: '#0ecb81',
          lineWidth: 2,
          lineStyle: LineStyle.Solid,
          axisLabelVisible: true,
          title: 'TP1 (50%)',
        });
        priceLinesRef.current.push(tp1Line);
      }

      // Take Profit 2 Line
      if (activePosition.tp2 && activePosition.tp2 > 0) {
        const tp2Line = candleSeries.createPriceLine({
          price: activePosition.tp2,
          color: '#10b981',
          lineWidth: 2,
          lineStyle: LineStyle.Solid,
          axisLabelVisible: true,
          title: 'TP2 (RUNNER)',
        });
        priceLinesRef.current.push(tp2Line);
      }

      // Breakeven Line (if active)
      if (activePosition.is_breakeven && activePosition.be_price) {
        const beLine = candleSeries.createPriceLine({
          price: activePosition.be_price,
          color: '#f0b90b',
          lineWidth: 1,
          lineStyle: LineStyle.Dashed,
          axisLabelVisible: true,
          title: 'BREAKEVEN',
        });
        priceLinesRef.current.push(beLine);
      }

      // Active Position Liquidation Price
      const liqPrice = calculateLiquidationPrice(
        activePosition.side,
        activePosition.entry_price,
        activePosition.leverage
      );
      if (liqPrice > 0) {
        const liqLine = candleSeries.createPriceLine({
          price: liqPrice,
          color: '#ef4444',
          lineWidth: 2,
          lineStyle: LineStyle.LargeDashed,
          axisLabelVisible: true,
          title: 'LIQUIDATION',
        });
        priceLinesRef.current.push(liqLine);
      }
    }

    // 2. Draw Order Ticket Preview Dashed Lines (if preview active and valid)
    if (orderDraft.preview && orderDraft.marginUsd > 0) {
      const p = orderDraft.preview;
      const effectiveEntry =
        orderDraft.orderType === 'LIMIT' && orderDraft.limitPrice && orderDraft.limitPrice > 0
          ? orderDraft.limitPrice
          : markPrice;

      if (effectiveEntry > 0) {
        const prevEntryLine = candleSeries.createPriceLine({
          price: effectiveEntry,
          color: orderDraft.side === 'BUY' ? '#0ecb81' : '#f6465d',
          lineWidth: 1,
          lineStyle: LineStyle.Dashed,
          axisLabelVisible: true,
          title: `PREVIEW ${orderDraft.side}`,
        });
        priceLinesRef.current.push(prevEntryLine);
      }

      if (orderDraft.stopLoss && orderDraft.stopLoss > 0) {
        const prevSlLine = candleSeries.createPriceLine({
          price: orderDraft.stopLoss,
          color: '#f6465d',
          lineWidth: 1,
          lineStyle: LineStyle.Dotted,
          axisLabelVisible: true,
          title: 'PREVIEW SL',
        });
        priceLinesRef.current.push(prevSlLine);
      }

      if (orderDraft.tp1 && orderDraft.tp1 > 0) {
        const prevTp1Line = candleSeries.createPriceLine({
          price: orderDraft.tp1,
          color: '#0ecb81',
          lineWidth: 1,
          lineStyle: LineStyle.Dotted,
          axisLabelVisible: true,
          title: 'PREVIEW TP1',
        });
        priceLinesRef.current.push(prevTp1Line);
      }

      if (orderDraft.tp2 && orderDraft.tp2 > 0) {
        const prevTp2Line = candleSeries.createPriceLine({
          price: orderDraft.tp2,
          color: '#10b981',
          lineWidth: 1,
          lineStyle: LineStyle.Dotted,
          axisLabelVisible: true,
          title: 'PREVIEW TP2',
        });
        priceLinesRef.current.push(prevTp2Line);
      }

      if (p.estimatedLiquidation && p.estimatedLiquidation > 0) {
        const prevLiqLine = candleSeries.createPriceLine({
          price: p.estimatedLiquidation,
          color: '#dc2626',
          lineWidth: 1,
          lineStyle: LineStyle.Dashed,
          axisLabelVisible: true,
          title: 'EST. LIQ',
        });
        priceLinesRef.current.push(prevLiqLine);
      }
    }
  }, [activePosition, orderDraft, markPrice]);

  return (
    <div className={`relative flex flex-col w-full h-full bg-[#080c14] border border-[#151d2c] rounded-lg overflow-hidden ${className}`}>
      {/* Chart Top Header Toolbar */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-[#151d2c] bg-[#080c14] z-10 select-none">
        <div className="flex items-center space-x-2">
          <span className="font-mono font-bold text-sm text-[#e6edf3] tracking-wide">{symbol}</span>
          <span className="text-xs text-[#7d8590] uppercase font-mono">Perpetual Futures</span>
        </div>

        {/* Interval Selector */}
        <div className="flex items-center space-x-1 bg-[#020305] p-0.5 rounded border border-[#151d2c]">
          {(['1m', '5m', '15m', '1h'] as const).map((int) => (
            <button
              key={int}
              onClick={() => setCandleInterval(int)}
              className={`px-2.5 py-1 text-xs font-mono rounded transition-colors ${
                candleInterval === int
                  ? 'bg-[#151d2c] text-[#0ecb81] font-bold shadow-sm'
                  : 'text-[#7d8590] hover:text-[#e6edf3]'
              }`}
            >
              {int}
            </button>
          ))}
        </div>
      </div>

      {/* Lightweight Charts Canvas Root */}
      <div ref={containerRef} className="flex-1 w-full h-full min-h-[350px]" />
    </div>
  );
};
