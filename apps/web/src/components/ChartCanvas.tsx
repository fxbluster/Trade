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
import { Eye, EyeOff } from 'lucide-react';

export interface ChartCanvasProps {
  className?: string;
}

/**
 * Formats a UTC epoch seconds timestamp into local Baku (UTC+4) time.
 */
export function formatLocalTime(timestampSec: number): string {
  const date = new Date(timestampSec * 1000);
  return date.toLocaleTimeString('az-AZ', {
    timeZone: 'Asia/Baku',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

/**
 * Updates a candlestick's high, low, and close dynamically using a mark price tick.
 */
export function updateCandleWithTick(
  candle: { time: number; open: number; high: number; low: number; close: number; volume?: number },
  markPrice: number
) {
  return {
    ...candle,
    high: Math.max(candle.high, markPrice),
    low: Math.min(candle.low, markPrice),
    close: markPrice,
  };
}

export const ChartCanvas: React.FC<ChartCanvasProps> = ({ className = '' }) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleSeriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const volumeSeriesRef = useRef<ISeriesApi<'Histogram'> | null>(null);
  const priceLinesRef = useRef<IPriceLine[]>([]);
  const lastFitSymbolRef = useRef<string | null>(null);
  const isInitializedRef = useRef<boolean>(false);

  const [isFreePan, setIsFreePan] = React.useState(false);

  const symbol = useMarketStore((s) => s.symbol);
  const klines = useMarketStore((s) => s.klines);
  const candleInterval = useMarketStore((s) => s.candleInterval);
  const setCandleInterval = useMarketStore((s) => s.setCandleInterval);
  const activePosition = useMarketStore((s) => s.activePosition);
  const activePosRef = useRef(activePosition);
  activePosRef.current = activePosition;
  const orderDraft = useUiStore((s) => s.orderDraft);
  const markPrice = useMarketStore((s) => s.markPrice);
  const hidePineOverlay = useMarketStore((s) => s.hidePineOverlay);
  const toggleHidePineOverlay = useMarketStore((s) => s.toggleHidePineOverlay);
  const pineSignals = useMarketStore((s) => s.pineSignals);
  const activeFvgs = useMarketStore((s) => s.activeFvgs);
  const activeOrderBlocks = useMarketStore((s) => s.activeOrderBlocks);
  const latestSweep = useMarketStore((s) => s.latestSweep);
  const showSmcOverlay = useMarketStore((s) => s.showSmcOverlay);
  const toggleShowSmcOverlay = useMarketStore((s) => s.toggleShowSmcOverlay);

  const unmitigatedFvgsCount = Array.isArray(activeFvgs)
    ? activeFvgs.filter((fvg) => !fvg.mitigated).length
    : 0;
  const activeObsCount = Array.isArray(activeOrderBlocks) ? activeOrderBlocks.length : 0;

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
      localization: {
        timeFormatter: (timestamp: number) => formatLocalTime(timestamp),
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
        autoScale: true,
        scaleMargins: {
          top: 0.1,
          bottom: 0.2,
        },
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
        barSpacing: 10,
        minBarSpacing: 1,
        fixLeftEdge: false,
        fixRightEdge: false,
        tickMarkFormatter: (time: number) => {
          const date = new Date(time * 1000);
          return date.toLocaleTimeString('az-AZ', {
            timeZone: 'Asia/Baku',
            hour: '2-digit',
            minute: '2-digit',
            hour12: false,
          });
        },
      },
    });

    const candleSeries = chart.addCandlestickSeries({
      upColor: '#0ecb81',
      downColor: '#f6465d',
      borderUpColor: '#0ecb81',
      borderDownColor: '#f6465d',
      wickUpColor: '#0ecb81',
      wickDownColor: '#f6465d',
      autoscaleInfoProvider: (original) => {
        const res = original();
        const pos = activePosRef.current;
        if (!res || !res.priceRange || !pos || pos.status === 'CLOSED') return res;
        let { minValue, maxValue } = res.priceRange;
        if (!Number.isFinite(minValue) || !Number.isFinite(maxValue)) return res;
        if (pos.stop_loss && Number.isFinite(pos.stop_loss) && pos.stop_loss > 0) {
          minValue = Math.min(minValue, pos.stop_loss);
          maxValue = Math.max(maxValue, pos.stop_loss);
        }
        if (pos.tp1 && Number.isFinite(pos.tp1) && pos.tp1 > 0) {
          minValue = Math.min(minValue, pos.tp1);
          maxValue = Math.max(maxValue, pos.tp1);
        }
        if (pos.tp2 && Number.isFinite(pos.tp2) && pos.tp2 > 0) {
          minValue = Math.min(minValue, pos.tp2);
          maxValue = Math.max(maxValue, pos.tp2);
        }
        return {
          ...res,
          priceRange: { minValue, maxValue },
        };
      },
    });

    const volumeSeries = chart.addHistogramSeries({
      priceFormat: {
        type: 'volume',
      },
      priceScaleId: 'volume',
    });

    chart.priceScale('volume').applyOptions({
      visible: false,
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
      if (!isInitializedRef.current || !candleSeriesRef.current || !volumeSeriesRef.current) return;
      if (tick.symbol !== useMarketStore.getState().symbol) return;

      const c = tick.candle;
      if (c && c.time) {
        const liveCandle = tick.markPrice > 0 ? updateCandleWithTick(c, tick.markPrice) : c;
        try {
          candleSeriesRef.current.update({
            time: liveCandle.time as UTCTimestamp,
            open: liveCandle.open,
            high: liveCandle.high,
            low: liveCandle.low,
            close: liveCandle.close,
          });

          volumeSeriesRef.current.update({
            time: liveCandle.time as UTCTimestamp,
            value: liveCandle.volume || 0,
            color: liveCandle.close >= liveCandle.open ? 'rgba(14, 203, 129, 0.35)' : 'rgba(246, 70, 93, 0.35)',
          });
        } catch (err) {
          console.warn('Lightweight charts update tick suppressed error:', err);
        }
      }
    };

    // Attach tick listener to wsClient
    const unsubscribeTick = wsClient.subscribeTick(handleTick);

    // Handle container resize & auto-fit
    let resizeObserver: ResizeObserver | null = null;
    if (typeof ResizeObserver !== 'undefined' && containerRef.current) {
      resizeObserver = new ResizeObserver((entries) => {
        if (!entries || entries.length === 0 || !entries[0] || !chartRef.current) return;
        const { width, height } = entries[0].contentRect;
        if (width > 0 && height > 0) {
          chartRef.current.applyOptions({ width: Math.floor(width), height: Math.floor(height) });
          chartRef.current.timeScale().fitContent();
        }
      });
      resizeObserver.observe(containerRef.current);
    }

    // Double-click to reset / fit content
    const handleDblClick = () => {
      if (!chartRef.current) return;
      chartRef.current.timeScale().fitContent();
      chartRef.current.priceScale('right').applyOptions({ autoScale: true });
    };
    const containerEl = containerRef.current;
    containerEl?.addEventListener('dblclick', handleDblClick);

    return () => {
      unsubscribeTick();
      resizeObserver?.disconnect();
      containerEl?.removeEventListener('dblclick', handleDblClick);
      chart.remove();
      chartRef.current = null;
      candleSeriesRef.current = null;
      volumeSeriesRef.current = null;
      priceLinesRef.current = [];
      isInitializedRef.current = false;
      lastFitSymbolRef.current = null;
    };
  }, []);

  // Purge series immediately on symbol switch to prevent cross-symbol candle pollution
  const prevSymbolRef = useRef<string>(symbol);
  useEffect(() => {
    if (prevSymbolRef.current !== symbol) {
      prevSymbolRef.current = symbol;
      isInitializedRef.current = false;
      if (candleSeriesRef.current) {
        candleSeriesRef.current.setData([]);
      }
      if (volumeSeriesRef.current) {
        volumeSeriesRef.current.setData([]);
      }
      chartRef.current?.timeScale().resetTimeScale();
    }
  }, [symbol]);

  // Update candles when klines store updates
  useEffect(() => {
    if (!candleSeriesRef.current || !volumeSeriesRef.current) return;

    if (!Array.isArray(klines) || klines.length === 0) {
      candleSeriesRef.current.setData([]);
      volumeSeriesRef.current.setData([]);
      return;
    }

    // Sanity check: Ensure candles belong to current symbol
    const currentPrice = useMarketStore.getState().markPrice;
    const validKlines = klines
      .filter((k) => {
        if (!k || typeof k.time !== 'number' || isNaN(k.time) || typeof k.close !== 'number') return false;
        if (currentPrice > 0) {
          const ratio = k.close / currentPrice;
          if (ratio > 4 || ratio < 0.25) return false;
        }
        return true;
      })
      .sort((a, b) => a.time - b.time);

    const uniqueMap = new Map<number, (typeof validKlines)[0]>();
    for (const k of validKlines) {
      uniqueMap.set(k.time, k);
    }
    const sortedKlines = Array.from(uniqueMap.values()).sort((a, b) => a.time - b.time);
    if (sortedKlines.length === 0) {
      candleSeriesRef.current.setData([]);
      volumeSeriesRef.current.setData([]);
      return;
    }

    const candleData: CandlestickData[] = sortedKlines.map((k) => ({
      time: k.time as UTCTimestamp,
      open: k.open,
      high: k.high,
      low: k.low,
      close: k.close,
    }));

    const volumeData: HistogramData[] = sortedKlines.map((k) => ({
      time: k.time as UTCTimestamp,
      value: k.volume,
      color: k.close >= k.open ? 'rgba(14, 203, 129, 0.35)' : 'rgba(246, 70, 93, 0.35)',
    }));

    try {
      candleSeriesRef.current.setData(candleData);
      volumeSeriesRef.current.setData(volumeData);
      chartRef.current?.timeScale().fitContent();
      chartRef.current?.priceScale('right').applyOptions({ autoScale: true });
      lastFitSymbolRef.current = symbol;
      isInitializedRef.current = true;
    } catch (err) {
      console.warn('Lightweight charts setData suppressed error:', err);
    }
  }, [klines, symbol]);

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
        color: '#3b82f6',
        lineWidth: 1,
        lineStyle: LineStyle.Dashed,
        axisLabelVisible: true,
        title: activePosition.side === 'BUY' ? 'Giriş (Alış)' : 'Giriş (Satış)',
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
          title: 'Stop Loss',
        });
        priceLinesRef.current.push(slLine);
      }

      // Take Profit 1 Line
      if (activePosition.tp1 && activePosition.tp1 > 0) {
        const tp1Line = candleSeries.createPriceLine({
          price: activePosition.tp1,
          color: '#0ecb81',
          lineWidth: 1,
          lineStyle: LineStyle.Dashed,
          axisLabelVisible: true,
          title: 'Qazanc 1 (TP1)',
        });
        priceLinesRef.current.push(tp1Line);
      }

      // Take Profit 2 Line
      if (activePosition.tp2 && activePosition.tp2 > 0) {
        const tp2Line = candleSeries.createPriceLine({
          price: activePosition.tp2,
          color: '#10b981',
          lineWidth: 1,
          lineStyle: LineStyle.Dotted,
          axisLabelVisible: true,
          title: 'Qazanc 2 (TP2)',
        });
        priceLinesRef.current.push(tp2Line);
      }

      // Breakeven Line (if active)
      if (activePosition.is_breakeven && activePosition.be_price) {
        const beLine = candleSeries.createPriceLine({
          price: activePosition.be_price,
          color: '#f0b90b',
          lineWidth: 1,
          lineStyle: LineStyle.Dotted,
          axisLabelVisible: true,
          title: 'Başabaş (0 Zərər)',
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
          lineWidth: 1,
          lineStyle: LineStyle.LargeDashed,
          axisLabelVisible: true,
          title: 'Ləğv (Liq)',
        });
        priceLinesRef.current.push(liqLine);
      }
    }

    // 2. Draw Order Ticket Preview Dashed Lines (only when no active position is open)
    if ((!activePosition || activePosition.status === 'CLOSED') && orderDraft.preview && orderDraft.marginUsd > 0) {
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

    // 3. Draw PineScript SMC Alert Line if not hidden and active
    if (!hidePineOverlay && pineSignals.length > 0) {
      const latestPine = pineSignals[0];
      if (latestPine && Date.now() - latestPine.time < 15 * 60 * 1000) {
        const pineLine = candleSeries.createPriceLine({
          price: latestPine.entryPrice,
          color: latestPine.side === 'BUY' ? '#0ecb81' : '#f6465d',
          lineWidth: 1,
          lineStyle: LineStyle.Dashed,
          axisLabelVisible: true,
          title: `PINE SMC [${latestPine.side}]`,
        });
        priceLinesRef.current.push(pineLine);
      }
    }

    // 4. Draw Native SMC Overlay (Active FVG Zones & Liquidity Sweeps)
    if (showSmcOverlay) {
      // 4.A Active FVG Zones: Twin Price Lines (FVG HIGH & FVG LOW)
      if (Array.isArray(activeFvgs)) {
        const unmitigatedFvgs = activeFvgs.filter((fvg) => !fvg.mitigated);
        for (const fvg of unmitigatedFvgs) {
          const high = fvg.high ?? (fvg as any).top;
          const low = fvg.low ?? (fvg as any).bottom;
          if (typeof high === 'number' && typeof low === 'number' && high > 0 && low > 0) {
            const upperLine = candleSeries.createPriceLine({
              price: high,
              color: 'rgba(14, 203, 129, 0.6)',
              lineWidth: 1,
              lineStyle: LineStyle.Dashed,
              axisLabelVisible: false,
              title: 'FVG HIGH',
            });
            priceLinesRef.current.push(upperLine);

            const lowerLine = candleSeries.createPriceLine({
              price: low,
              color: 'rgba(14, 203, 129, 0.3)',
              lineWidth: 1,
              lineStyle: LineStyle.Dashed,
              axisLabelVisible: false,
              title: 'FVG LOW',
            });
            priceLinesRef.current.push(lowerLine);
          }
        }
      }

      // 4.B Active Order Blocks: Twin Price Lines (OB HIGH & OB LOW)
      if (Array.isArray(activeOrderBlocks)) {
        for (const ob of activeOrderBlocks) {
          const high = ob.high;
          const low = ob.low;
          if (typeof high === 'number' && typeof low === 'number' && high > 0 && low > 0) {
            const isBull = ob.type === 'BULLISH';
            const color = isBull ? 'rgba(59, 130, 246, 0.7)' : 'rgba(239, 68, 68, 0.7)';
            const obHigh = candleSeries.createPriceLine({
              price: high,
              color,
              lineWidth: 1,
              lineStyle: LineStyle.Dotted,
              axisLabelVisible: false,
              title: `OB HIGH [${ob.type}]`,
            });
            priceLinesRef.current.push(obHigh);

            const obLow = candleSeries.createPriceLine({
              price: low,
              color,
              lineWidth: 1,
              lineStyle: LineStyle.Dotted,
              axisLabelVisible: false,
              title: `OB LOW [${ob.type}]`,
            });
            priceLinesRef.current.push(obLow);
          }
        }
      }

      // 4.C Liquidity Sweep Price Line
      if (latestSweep && latestSweep.sweepPrice && latestSweep.sweepPrice > 0) {
        const isHigh = latestSweep.direction === 'SWEEP_HIGH' || (latestSweep as any).bias === 'BEARISH';
        const sweepLine = candleSeries.createPriceLine({
          price: latestSweep.sweepPrice,
          color: isHigh ? '#f6465d' : '#0ecb81',
          lineWidth: 1,
          lineStyle: LineStyle.Dashed,
          axisLabelVisible: false,
          title: isHigh ? 'SWEEP HIGH' : 'SWEEP LOW',
        });
        priceLinesRef.current.push(sweepLine);
      }
    }

    // Set markers on candle series for Liquidity Sweeps
    if (typeof (candleSeries as any).setMarkers === 'function') {
      const markers: any[] = [];
      if (showSmcOverlay && latestSweep && latestSweep.time) {
        const timeSec = latestSweep.time > 1e11 ? Math.floor(latestSweep.time / 1000) : latestSweep.time;
        const isHigh = latestSweep.direction === 'SWEEP_HIGH' || (latestSweep as any).bias === 'BEARISH';
        markers.push({
          time: timeSec as UTCTimestamp,
          position: isHigh ? 'aboveBar' : 'belowBar',
          color: isHigh ? '#f6465d' : '#0ecb81',
          shape: isHigh ? 'arrowDown' : 'arrowUp',
          text: isHigh ? 'SWEEP HIGH' : 'SWEEP LOW',
        });
      }
      (candleSeries as any).setMarkers(markers);
    }
  }, [
    activePosition,
    orderDraft,
    markPrice,
    hidePineOverlay,
    pineSignals,
    showSmcOverlay,
    activeFvgs,
    activeOrderBlocks,
    latestSweep,
  ]);

  return (
    <div className={`relative flex flex-col w-full h-full bg-[#080c14] border border-[#151d2c] rounded-lg overflow-hidden ${className}`}>
      {/* Floating Status Badges for Active Overlays */}
      <div className="absolute top-12 left-4 z-10 flex flex-col space-y-1.5 pointer-events-none">
        {showSmcOverlay && unmitigatedFvgsCount === 0 && activeObsCount === 0 && (
          <div className="px-2.5 py-1 bg-[#080c14]/90 border border-[#151d2c] rounded text-[11px] font-mono text-[#7d8590] flex items-center space-x-1.5 backdrop-blur-sm">
            <span className="w-1.5 h-1.5 rounded-full bg-[#0ecb81]/60 animate-pulse"></span>
            <span>SMC Aktiv: 0 aktiv FVG/OB zonası (bazar tarazlıqdadır)</span>
          </div>
        )}
        {!hidePineOverlay && pineSignals.length === 0 && (
          <div className="px-2.5 py-1 bg-[#080c14]/90 border border-[#151d2c] rounded text-[11px] font-mono text-[#7d8590] flex items-center space-x-1.5 backdrop-blur-sm">
            <span className="w-1.5 h-1.5 rounded-full bg-[#3b82f6]/60"></span>
            <span>PineScript Aktiv: Vebhook gözlənilir (0 aktiv siqnal)</span>
          </div>
        )}
      </div>

      {/* Chart Top Header Toolbar */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-[#151d2c] bg-[#080c14] z-10 select-none">
        <div className="flex items-center space-x-2">
          <span className="font-mono font-bold text-sm text-[#e6edf3] tracking-wide">{symbol}</span>
          <span className="text-xs text-[#7d8590] uppercase font-mono">Perpetual Futures</span>
        </div>

        {/* Right Toolbar: SMC Overlay Toggle, Pine Overlay Toggle & Interval Selector */}
        <div className="flex items-center space-x-2">
          {/* Native SMC Overlay Toggle */}
          <button
            onClick={toggleShowSmcOverlay}
            data-testid="toggle-smc-overlay"
            className={`flex items-center space-x-1 px-2.5 py-1 text-xs font-mono rounded border transition-colors ${
              !showSmcOverlay
                ? 'bg-[#151d2c] text-[#7d8590] border-[#151d2c] hover:text-[#e6edf3]'
                : 'bg-[#0ecb81]/15 text-[#0ecb81] border-[#0ecb81]/40 font-bold'
            }`}
            title="Toggle Native SMC (FVG & Liquidity Sweeps) overlay"
          >
            {!showSmcOverlay ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
            <span className="hidden sm:inline">
              {!showSmcOverlay
                ? 'SMC Overlay Off'
                : `SMC Overlay On (${unmitigatedFvgsCount + activeObsCount})`}
            </span>
          </button>

          {/* Pine Overlay Toggle */}
          <button
            onClick={toggleHidePineOverlay}
            className={`flex items-center space-x-1 px-2.5 py-1 text-xs font-mono rounded border transition-colors ${
              hidePineOverlay
                ? 'bg-[#151d2c] text-[#7d8590] border-[#151d2c] hover:text-[#e6edf3]'
                : 'bg-[#2962ff]/15 text-[#2962ff] border-[#2962ff]/40 font-bold'
            }`}
            title="Toggle TradingView PineScript SMC overlay markers"
          >
            {hidePineOverlay ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
            <span className="hidden sm:inline">
              {hidePineOverlay ? 'Pine Overlay Off' : `Pine Overlay On (${pineSignals.length})`}
            </span>
          </button>

          {/* Free Vertical Pan Toggle */}
          <button
            onClick={() => {
              const next = !isFreePan;
              setIsFreePan(next);
              chartRef.current?.priceScale('right').applyOptions({ autoScale: !next });
            }}
            title="Sıçanla yuxarı-aşağı sərbəst sürüşdürmə (Auto-Scale söndür/yandır)"
            className={`px-2 py-1 text-xs font-mono rounded border transition-colors ${
              isFreePan
                ? 'bg-[#0ecb81]/20 text-[#0ecb81] border-[#0ecb81]/50 font-bold'
                : 'bg-[#151d2c] text-[#7d8590] hover:text-[#e6edf3] border-[#151d2c]'
            }`}
          >
            Free ↕
          </button>

          {/* Fit / Reset Scale Button */}
          <button
            onClick={() => {
              setIsFreePan(false);
              chartRef.current?.timeScale().fitContent();
              chartRef.current?.priceScale('right').applyOptions({ autoScale: true });
            }}
            title="Qrafiki ekrana tam sığdır (və ya qrafikə iki dəfə klikləyin)"
            className="px-2 py-1 text-xs font-mono rounded bg-[#151d2c] text-[#7d8590] hover:text-[#0ecb81] border border-[#151d2c] transition-colors"
          >
            Fit ⛶
          </button>

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
      </div>

      {/* Lightweight Charts Canvas Root */}
      <div ref={containerRef} className="flex-1 w-full min-h-0" />
    </div>
  );
};
