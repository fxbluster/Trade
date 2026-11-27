/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { attachSmartChartInteraction } from '../chartInteractions';

function createMockChart(initialAutoScale = true) {
  let autoScale = initialAutoScale;
  const applyOptions = vi.fn((opts: { autoScale?: boolean }) => {
    if (typeof opts.autoScale === 'boolean') {
      autoScale = opts.autoScale;
    }
  });
  const fitContent = vi.fn();

  const chart = {
    priceScale: vi.fn(() => ({
      applyOptions,
      options: () => ({ autoScale }),
      width: () => 60,
    })),
    timeScale: vi.fn(() => ({
      fitContent,
    })),
  } as any;

  return {
    chart,
    applyOptions,
    fitContent,
    getAutoScale: () => autoScale,
  };
}

function createContainer(width = 800, height = 400) {
  const el = document.createElement('div');
  el.getBoundingClientRect = () =>
    ({
      left: 0,
      top: 0,
      right: width,
      bottom: height,
      width,
      height,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    }) as DOMRect;
  return el;
}

describe('attachSmartChartInteraction', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('unlocks autoScale on plot pointerdown and keeps it off after a vertical drag', () => {
    const { chart, getAutoScale } = createMockChart(true);
    const el = createContainer(800, 400);
    const handle = attachSmartChartInteraction(chart, el);

    el.dispatchEvent(new MouseEvent('pointerdown', { clientX: 300, clientY: 200, button: 0, bubbles: true }));
    expect(getAutoScale()).toBe(false);

    window.dispatchEvent(new MouseEvent('pointermove', { clientX: 305, clientY: 260, bubbles: true }));
    window.dispatchEvent(new MouseEvent('pointerup', { clientX: 305, clientY: 260, bubbles: true }));

    expect(getAutoScale()).toBe(false);
    handle.cleanup();
  });

  it('restores autoScale after a horizontal-only pan inside the plot area', () => {
    const { chart, getAutoScale } = createMockChart(true);
    const el = createContainer(800, 400);
    const handle = attachSmartChartInteraction(chart, el);

    el.dispatchEvent(new MouseEvent('pointerdown', { clientX: 400, clientY: 200, button: 0, bubbles: true }));
    expect(getAutoScale()).toBe(false);

    window.dispatchEvent(new MouseEvent('pointermove', { clientX: 250, clientY: 204, bubbles: true }));
    window.dispatchEvent(new MouseEvent('pointerup', { clientX: 250, clientY: 204, bubbles: true }));

    expect(getAutoScale()).toBe(true);
    handle.cleanup();
  });

  it('re-enables autoScale on wheel zoom after a vertical pan', () => {
    const { chart, getAutoScale } = createMockChart(true);
    const el = createContainer(800, 400);
    const handle = attachSmartChartInteraction(chart, el);

    // Vertical drag turns autoScale off
    el.dispatchEvent(new MouseEvent('pointerdown', { clientX: 300, clientY: 200, button: 0, bubbles: true }));
    window.dispatchEvent(new MouseEvent('pointermove', { clientX: 300, clientY: 250, bubbles: true }));
    window.dispatchEvent(new MouseEvent('pointerup', { clientX: 300, clientY: 250, bubbles: true }));
    expect(getAutoScale()).toBe(false);

    // Wheel zoom restores autoScale so visible candles narrow/expand price range
    el.dispatchEvent(new WheelEvent('wheel', { deltaY: -120, bubbles: true }));
    expect(getAutoScale()).toBe(true);
    handle.cleanup();
  });

  it('preserves manual right-axis scale on wheel until fit or double-click resets it', () => {
    const { chart, fitContent, getAutoScale } = createMockChart(true);
    const el = createContainer(800, 400);
    const handle = attachSmartChartInteraction(chart, el);

    // Drag right price axis (x = 770 >= 800 - 60)
    el.dispatchEvent(new MouseEvent('pointerdown', { clientX: 770, clientY: 200, button: 0, bubbles: true }));
    chart.priceScale('right').applyOptions({ autoScale: false });
    window.dispatchEvent(new MouseEvent('pointerup', { clientX: 770, clientY: 250, bubbles: true }));

    el.dispatchEvent(new WheelEvent('wheel', { deltaY: -120, bubbles: true }));
    expect(getAutoScale()).toBe(false);

    // Double-click plot fits content and re-enables autoScale
    el.dispatchEvent(new MouseEvent('dblclick', { clientX: 300, clientY: 200, bubbles: true }));
    expect(fitContent).toHaveBeenCalledTimes(1);
    expect(getAutoScale()).toBe(true);

    // fit() helper also resets
    chart.priceScale('right').applyOptions({ autoScale: false });
    handle.fit();
    expect(fitContent).toHaveBeenCalledTimes(2);
    expect(getAutoScale()).toBe(true);
    handle.cleanup();
  });
});
