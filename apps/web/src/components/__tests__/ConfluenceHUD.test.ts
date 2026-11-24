/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach } from 'vitest';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { useMarketStore } from '../../store/useMarketStore';
import { ConfluenceHUD, PILLAR_METADATA } from '../ConfluenceHUD';
import type { ConfluenceSnapshot, FairValueGap, LiquiditySweep } from '@tradeos/shared';

describe('ConfluenceHUD & Institutional SMC State Slices', () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);

    useMarketStore.setState({
      symbol: 'BTCUSDT',
      confluence: null,
      hidePineOverlay: false,
      pineSignals: [],
      activeFvgs: [],
      activeOrderBlocks: [],
      latestSweep: null,
      showSmcOverlay: true,
    });
  });

  it('contains exact institutional metadata weights for all 7 pillars', () => {
    expect(PILLAR_METADATA.MACRO_REGIME.weight).toBe('15%');
    expect(PILLAR_METADATA.NATIVE_SMC.weight).toBe('20%');
    expect(PILLAR_METADATA.CVD_ABSORPTION.weight).toBe('20%');
    expect(PILLAR_METADATA.ORDER_FLOW_L2.weight).toBe('12.5%');
    expect(PILLAR_METADATA.LIQ_CLUSTERS.weight).toBe('7.5%');
    expect(PILLAR_METADATA.MOMENTUM_RVOL.weight).toBe('10%');
    expect(PILLAR_METADATA.SENTIMENT_MACRO.weight).toBe('15%');
  });

  it('updates confluence snapshot and institutional SMC slices in store correctly', () => {
    const sampleFvg: FairValueGap = {
      id: 'fvg-1',
      timeframe: '15m',
      type: 'BULLISH',
      high: 91500,
      low: 91200,
      mitigated: false,
      formedAt: Date.now(),
    };

    const sampleSweep: LiquiditySweep = {
      id: 'sweep-1',
      direction: 'SWEEP_HIGH',
      sweepPrice: 92450,
      reclaimPrice: 92300,
      time: Math.floor(Date.now() / 1000),
    };

    const sampleSnapshot: ConfluenceSnapshot = {
      symbol: 'BTCUSDT',
      macroVetoActive: true,
      macroRegime: 'MACRO_BEARISH',
      pillars: [
        {
          id: 'MACRO_REGIME',
          title: 'Macro Regime (1h EMA200)',
          score: 25,
          bias: 'BEARISH',
          valueText: 'Price < 1h EMA200',
          subText: 'ADX Trend Strong',
          confirmed: true,
          updatedAt: Date.now(),
        },
        {
          id: 'NATIVE_SMC',
          title: 'Native SMC',
          score: 75,
          bias: 'BULLISH',
          valueText: 'Unmitigated FVG Active',
          subText: 'Bullish OB at 91,200',
          confirmed: true,
          updatedAt: Date.now(),
        },
        {
          id: 'CVD_ABSORPTION',
          title: 'CVD Absorption',
          score: 70,
          bias: 'BULLISH',
          valueText: 'Z-Score -2.4 Delta',
          subText: 'Perp Absorption',
          confirmed: true,
          updatedAt: Date.now(),
        },
        {
          id: 'ORDER_FLOW_L2',
          title: 'Order Flow L2',
          score: 80,
          bias: 'BULLISH',
          valueText: 'Imbalance 3.4x Bids',
          subText: 'POC at 91,350',
          confirmed: true,
          updatedAt: Date.now(),
        },
        {
          id: 'LIQ_CLUSTERS',
          title: 'Liq Clusters',
          score: 50,
          bias: 'NEUTRAL',
          valueText: 'Distance > 1.5 ATR',
          subText: 'No proximate cluster',
          confirmed: false,
          updatedAt: Date.now(),
        },
        {
          id: 'MOMENTUM_RVOL',
          title: 'Momentum & rVol',
          score: 65,
          bias: 'BULLISH',
          valueText: 'RSI 58.2 | rVol 2.1x',
          subText: 'SuperTrend Bullish',
          confirmed: true,
          updatedAt: Date.now(),
        },
        {
          id: 'SENTIMENT_MACRO',
          title: 'Macro Sentiment',
          score: 55,
          bias: 'NEUTRAL',
          valueText: 'VADER +0.12',
          subText: 'CryptoPanic Neutral',
          confirmed: false,
          updatedAt: Date.now(),
        },
      ],
      bullishCount: 4,
      bearishCount: 1,
      neutralCount: 2,
      consensusBias: 'BULLISH',
      consensusMet: false, // blocked by macro veto
      threshold: 4,
      compositeScore: 68,
      recommendedAction: 'WAIT',
      activeFvgs: [sampleFvg],
      activeOrderBlocks: [],
      latestSweep: sampleSweep,
    };

    useMarketStore.getState().setConfluence(sampleSnapshot);

    const stored = useMarketStore.getState().confluence;
    expect(stored).not.toBeNull();
    expect(stored?.macroVetoActive).toBe(true);
    expect(stored?.compositeScore).toBe(68);
    expect(useMarketStore.getState().activeFvgs).toHaveLength(1);
    expect(useMarketStore.getState().activeFvgs[0].id).toBe('fvg-1');
    expect(useMarketStore.getState().latestSweep?.sweepPrice).toBe(92450);
  });

  it('toggles showSmcOverlay state correctly', () => {
    expect(useMarketStore.getState().showSmcOverlay).toBe(true);

    useMarketStore.getState().toggleShowSmcOverlay();
    expect(useMarketStore.getState().showSmcOverlay).toBe(false);

    useMarketStore.getState().setShowSmcOverlay(true);
    expect(useMarketStore.getState().showSmcOverlay).toBe(true);
  });

  it('renders prominent amber warning banner when macroVetoActive is true', () => {
    useMarketStore.setState({
      confluence: {
        symbol: 'BTCUSDT',
        macroVetoActive: true,
        macroRegime: 'MACRO_BEARISH',
        pillars: [],
        bullishCount: 5,
        bearishCount: 0,
        neutralCount: 2,
        consensusBias: 'BULLISH',
        consensusMet: false,
        threshold: 4,
        compositeScore: 78,
        recommendedAction: 'WAIT',
        activeFvgs: [],
        activeOrderBlocks: [],
        latestSweep: null,
      },
    });

    const root = createRoot(container);
    flushSync(() => {
      root.render(React.createElement(ConfluenceHUD));
    });

    const banner = container.querySelector('[data-testid="macro-veto-banner"]');
    expect(banner).not.toBeNull();
    expect(banner?.textContent).toContain('MACRO VETO ENGAGED: Longs blocked below 1h EMA200');
    root.unmount();
  });

  it('does not render warning banner when macroVetoActive is false', () => {
    useMarketStore.setState({
      confluence: {
        symbol: 'BTCUSDT',
        macroVetoActive: false,
        macroRegime: 'MACRO_BULLISH',
        pillars: [],
        bullishCount: 5,
        bearishCount: 0,
        neutralCount: 2,
        consensusBias: 'BULLISH',
        consensusMet: true,
        threshold: 4,
        compositeScore: 82,
        recommendedAction: 'STRONG_BUY',
        activeFvgs: [],
        activeOrderBlocks: [],
        latestSweep: null,
      },
    });

    const root = createRoot(container);
    flushSync(() => {
      root.render(React.createElement(ConfluenceHUD));
    });

    const banner = container.querySelector('[data-testid="macro-veto-banner"]');
    expect(banner).toBeNull();
    root.unmount();
  });

  it('renders dynamic alpha factors panel when factorDetails are present', () => {
    useMarketStore.setState({
      confluence: {
        symbol: 'BTCUSDT',
        macroVetoActive: false,
        macroRegime: 'MACRO_BULLISH',
        pillars: [],
        bullishCount: 5,
        bearishCount: 0,
        neutralCount: 2,
        consensusBias: 'BULLISH',
        consensusMet: true,
        threshold: 4,
        compositeScore: 82,
        recommendedAction: 'STRONG_BUY',
        activeFvgs: [],
        activeOrderBlocks: [],
        latestSweep: null,
        factorDetails: [
          {
            factorId: 'ORDER_FLOW_L2',
            name: 'Order Flow L2',
            rawAlpha: 0.85,
            orthogonalAlpha: 0.62,
            posteriorWeight: 0.22,
            bias: 'BULLISH',
            confidence: 0.90,
            isCollinear: false,
            informationRatio: 1.4,
          },
          {
            factorId: 'NATIVE_SMC',
            name: 'Native SMC',
            rawAlpha: 0.70,
            orthogonalAlpha: 0.35,
            posteriorWeight: 0.18,
            bias: 'BULLISH',
            confidence: 0.80,
            isCollinear: true,
            informationRatio: 1.1,
          },
        ],
      },
    });

    const root = createRoot(container);
    flushSync(() => {
      root.render(React.createElement(ConfluenceHUD));
    });

    const panel = container.querySelector('[data-testid="alpha-factors-panel"]');
    expect(panel).not.toBeNull();
    expect(panel?.textContent).toContain('Orthogonal Alpha Matrix');
    expect(panel?.textContent).toContain('Order Flow L2');
    expect(panel?.textContent).toContain('Native SMC');
    expect(panel?.textContent).toContain('COLLINEAR');
    expect(panel?.textContent).toContain('ORTHO');
    root.unmount();
  });

  it('renders noise band telemetry details in banner when noiseBandActive is true', () => {
    useMarketStore.setState({
      confluence: {
        symbol: 'BTCUSDT',
        macroVetoActive: false,
        noiseBandActive: true,
        noiseBand: {
          active: true,
          currentTrueRange15m: 1.20,
          meanTrueRange20d: 1.50,
          noiseThreshold: 1.875,
          isNoise: true,
          currentPrice: 100,
          vwap: 99.8,
          vwapDistancePct: 0.002,
        },
        macroRegime: 'MACRO_BULLISH',
        pillars: [],
        bullishCount: 2,
        bearishCount: 1,
        neutralCount: 4,
        consensusBias: 'NEUTRAL',
        consensusMet: false,
        threshold: 4,
        compositeScore: 55,
        recommendedAction: 'WAIT',
        activeFvgs: [],
        activeOrderBlocks: [],
        latestSweep: null,
      },
    });

    const root = createRoot(container);
    flushSync(() => {
      root.render(React.createElement(ConfluenceHUD));
    });

    const banner = container.querySelector('[data-testid="noise-band-banner"]');
    expect(banner).not.toBeNull();
    expect(banner?.textContent).toContain('NOISE BAND ACTIVE');
    expect(banner?.textContent).toContain('TR: $1.20');
    expect(banner?.textContent).toContain('Threshold: $1.88');
    root.unmount();
  });

  it('renders Next-Gen Orthogonal Quant Conviction indicator with proper color-coding and no legacy 7-pillar cards grid', () => {
    // Test case 1: Score >= 70% (green/emerald)
    useMarketStore.setState({
      confluence: {
        symbol: 'BTCUSDT',
        macroVetoActive: false,
        macroRegime: 'MACRO_BULLISH',
        pillars: [],
        bullishCount: 5,
        bearishCount: 0,
        neutralCount: 2,
        consensusBias: 'BULLISH',
        consensusMet: true,
        threshold: 70,
        compositeScore: 78,
        recommendedAction: 'STRONG_BUY',
        activeFvgs: [],
        activeOrderBlocks: [],
        latestSweep: null,
      },
    });

    let root = createRoot(container);
    flushSync(() => {
      root.render(React.createElement(ConfluenceHUD));
    });

    const indicator = container.querySelector('[data-testid="quant-conviction-indicator"]');
    expect(indicator).not.toBeNull();
    expect(indicator?.textContent).toBe('Orthogonal Quant Conviction: Score: 78%');
    expect(indicator?.className).toContain('text-[#0ecb81]'); // green/emerald

    // Verify legacy 7-pillar text is gone
    expect(container.textContent).not.toContain('Pillars (Min 4 Req)');
    // Verify no 7-pillar cards grid exists
    expect(container.querySelectorAll('.lg\\:grid-cols-7')).toHaveLength(0);
    root.unmount();

    // Test case 2: Score >= 60% and < 70% (yellow/amber)
    useMarketStore.setState({
      confluence: {
        symbol: 'BTCUSDT',
        macroVetoActive: false,
        macroRegime: 'MACRO_BULLISH',
        pillars: [],
        bullishCount: 3,
        bearishCount: 1,
        neutralCount: 3,
        consensusBias: 'NEUTRAL',
        consensusMet: false,
        threshold: 70,
        compositeScore: 65,
        recommendedAction: 'WAIT',
        activeFvgs: [],
        activeOrderBlocks: [],
        latestSweep: null,
      },
    });

    root = createRoot(container);
    flushSync(() => {
      root.render(React.createElement(ConfluenceHUD));
    });

    const indicator65 = container.querySelector('[data-testid="quant-conviction-indicator"]');
    expect(indicator65?.textContent).toBe('Orthogonal Quant Conviction: Score: 65%');
    expect(indicator65?.className).toContain('text-[#f0b90b]'); // yellow/amber
    root.unmount();

    // Test case 3: Score < 60% (slate/gray)
    useMarketStore.setState({
      confluence: {
        symbol: 'BTCUSDT',
        macroVetoActive: false,
        macroRegime: 'MACRO_BULLISH',
        pillars: [],
        bullishCount: 1,
        bearishCount: 2,
        neutralCount: 4,
        consensusBias: 'NEUTRAL',
        consensusMet: false,
        threshold: 70,
        compositeScore: 45,
        recommendedAction: 'WAIT',
        activeFvgs: [],
        activeOrderBlocks: [],
        latestSweep: null,
      },
    });

    root = createRoot(container);
    flushSync(() => {
      root.render(React.createElement(ConfluenceHUD));
    });

    const indicator45 = container.querySelector('[data-testid="quant-conviction-indicator"]');
    expect(indicator45?.textContent).toBe('Orthogonal Quant Conviction: Score: 45%');
    expect(indicator45?.className).toContain('text-[#7d8590]'); // slate/gray
    root.unmount();
  });
});
