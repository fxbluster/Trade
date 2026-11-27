import type { IChartApi } from 'lightweight-charts';

export interface SmartChartInteractionHandle {
  /** Fits all candles to the viewport and restores automatic price scaling. */
  fit: () => void;
  /** Resets manual price axis lock and re-enables automatic price scaling. */
  resetAutoScale: () => void;
  /** Removes all registered DOM event listeners. */
  cleanup: () => void;
}

const FALLBACK_RIGHT_AXIS_WIDTH = 60;
const BOTTOM_TIME_AXIS_HEIGHT = 28;
const VERTICAL_PAN_THRESHOLD_PX = 8;
const HORIZONTAL_DOMINANT_DY_MAX_PX = 14;

/**
 * Enables both automatic price-range fitting on wheel zoom/horizontal pan and
 * always-on free vertical panning when dragging vertically inside the plot area.
 */
export function attachSmartChartInteraction(
  chart: IChartApi,
  containerEl: HTMLElement,
  onViewportAdjust?: () => void
): SmartChartInteractionHandle {
  let manualPriceAxisScale = false;
  let isAutoScaleEnabled = true;
  let isDraggingPlot = false;
  let dragStartX = 0;
  let dragStartY = 0;
  let maxAbsDx = 0;
  let maxAbsDy = 0;
  let wasAutoScaleBeforeDrag = true;

  const getRightPriceScale = () =>
    chart.priceScale('right') as {
      applyOptions: (opts: { autoScale: boolean }) => void;
      options?: () => { autoScale?: boolean };
      width?: () => number;
    };

  const getRightAxisWidth = (): number => {
    const ps = getRightPriceScale();
    const w = typeof ps.width === 'function' ? ps.width() : 0;
    return Number.isFinite(w) && w > 0 ? w : FALLBACK_RIGHT_AXIS_WIDTH;
  };

  const setAutoScale = (enabled: boolean) => {
    isAutoScaleEnabled = enabled;
    getRightPriceScale().applyOptions({ autoScale: enabled });
  };

  const readCurrentAutoScale = (): boolean => {
    const ps = getRightPriceScale();
    if (typeof ps.options === 'function') {
      const opts = ps.options();
      if (opts && typeof opts.autoScale === 'boolean') {
        return opts.autoScale;
      }
    }
    return isAutoScaleEnabled;
  };

  const isPointInRightAxis = (clientX: number, rect: DOMRect): boolean => {
    if (rect.width <= 0) return false;
    return clientX - rect.left >= rect.width - getRightAxisWidth();
  };

  const isPointInTimeAxis = (clientY: number, rect: DOMRect): boolean => {
    if (rect.height <= 0) return false;
    return clientY - rect.top >= rect.height - BOTTOM_TIME_AXIS_HEIGHT;
  };

  const onPointerDown = (e: PointerEvent) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    const rect = containerEl.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;

    if (isPointInRightAxis(e.clientX, rect)) {
      manualPriceAxisScale = true;
      return;
    }

    if (isPointInTimeAxis(e.clientY, rect)) {
      return;
    }

    isDraggingPlot = true;
    dragStartX = e.clientX;
    dragStartY = e.clientY;
    maxAbsDx = 0;
    maxAbsDy = 0;
    wasAutoScaleBeforeDrag = readCurrentAutoScale();

    // Temporarily unlock autoScale before Lightweight Charts captures drag start
    // so vertical drag inside the plot works immediately without any toggle button.
    if (wasAutoScaleBeforeDrag) {
      setAutoScale(false);
    }
  };

  const onPointerMove = (e: PointerEvent) => {
    if (!isDraggingPlot) return;
    const dx = Math.abs(e.clientX - dragStartX);
    const dy = Math.abs(e.clientY - dragStartY);
    if (dx > maxAbsDx) maxAbsDx = dx;
    if (dy > maxAbsDy) maxAbsDy = dy;
  };

  const onPointerUp = () => {
    if (!isDraggingPlot) return;
    isDraggingPlot = false;

    const didHorizontalOrTapOnly =
      maxAbsDy <= VERTICAL_PAN_THRESHOLD_PX ||
      (maxAbsDy <= HORIZONTAL_DOMINANT_DY_MAX_PX && maxAbsDx >= maxAbsDy * 2);

    if (didHorizontalOrTapOnly && wasAutoScaleBeforeDrag && !manualPriceAxisScale) {
      setAutoScale(true);
      requestAnimationFrame(() => onViewportAdjust?.());
    }
  };

  const onWheel = () => {
    if (!manualPriceAxisScale) {
      setAutoScale(true);
      requestAnimationFrame(() => onViewportAdjust?.());
    }
  };

  const onDblClick = (e: MouseEvent) => {
    const rect = containerEl.getBoundingClientRect();
    manualPriceAxisScale = false;
    if (isPointInRightAxis(e.clientX, rect)) {
      setAutoScale(true);
      requestAnimationFrame(() => onViewportAdjust?.());
      return;
    }
    chart.timeScale().fitContent();
    setAutoScale(true);
    requestAnimationFrame(() => onViewportAdjust?.());
  };

  containerEl.addEventListener('pointerdown', onPointerDown, { capture: true });
  containerEl.addEventListener('wheel', onWheel, { capture: true, passive: true });
  containerEl.addEventListener('dblclick', onDblClick);
  window.addEventListener('pointermove', onPointerMove, { passive: true });
  window.addEventListener('pointerup', onPointerUp);
  window.addEventListener('pointercancel', onPointerUp);

  return {
    fit: () => {
      manualPriceAxisScale = false;
      chart.timeScale().fitContent();
      setAutoScale(true);
      requestAnimationFrame(() => onViewportAdjust?.());
    },
    resetAutoScale: () => {
      manualPriceAxisScale = false;
      setAutoScale(true);
    },
    cleanup: () => {
      containerEl.removeEventListener('pointerdown', onPointerDown, { capture: true });
      containerEl.removeEventListener('wheel', onWheel, { capture: true });
      containerEl.removeEventListener('dblclick', onDblClick);
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
      window.removeEventListener('pointercancel', onPointerUp);
    },
  };
}
