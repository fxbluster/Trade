/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { useUiStore } from '../../store/useUiStore';
import { useMarketStore } from '../../store/useMarketStore';
import { apiClient } from '../../lib/apiClient';
import { PillarScorecardModal } from '../PillarScorecardModal';
import type { PillarAttributionResponse } from '@tradeos/shared';

describe('PillarScorecardModal Component', () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);

    useMarketStore.setState({
      symbol: 'SOLUSDT',
    });

    useUiStore.setState({
      isPillarScorecardModalOpen: false,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    document.body.removeChild(container);
  });

  it('renders nothing when isPillarScorecardModalOpen is false', () => {
    useUiStore.setState({ isPillarScorecardModalOpen: false });

    const root = createRoot(container);
    flushSync(() => {
      root.render(<PillarScorecardModal />);
    });

    expect(container.querySelector('[data-testid="pillar-scorecard-modal"]')).toBeNull();
  });

  it('renders modal and displays all 7 pillars with API response', async () => {
    const mockData: PillarAttributionResponse = {
      symbol: 'SOLUSDT',
      horizon: '15m',
      sampleSize: 55,
      generatedAt: 1700000000000,
      scorecards: [
        {
          pillarId: 'MACRO_REGIME',
          title: 'Macro Regime (ADX / Trend)',
          currentWeightPct: 25.0,
          recommendedWeightPct: 22.0,
          weightDeltaPct: -3.0,
          totalActiveVotes: 40,
          truePositives: 20,
          falsePositives: 20,
          falseNegatives: 5,
          hitRatePct: 50.0,
          avgMfePct: 1.1,
          avgMaePct: 0.9,
        },
        {
          pillarId: 'NATIVE_SMC',
          title: 'Native SMC (FVG / OB / Sweeps)',
          currentWeightPct: 25.0,
          recommendedWeightPct: 24.0,
          weightDeltaPct: -1.0,
          totalActiveVotes: 30,
          truePositives: 18,
          falsePositives: 12,
          falseNegatives: 8,
          hitRatePct: 60.0,
          avgMfePct: 1.5,
          avgMaePct: 0.8,
        },
        {
          pillarId: 'CVD_ABSORPTION',
          title: 'CVD Absorption (Delta Divergence)',
          currentWeightPct: 20.0,
          recommendedWeightPct: 20.5,
          weightDeltaPct: 0.5,
          totalActiveVotes: 45,
          truePositives: 28,
          falsePositives: 17,
          falseNegatives: 6,
          hitRatePct: 62.2,
          avgMfePct: 1.6,
          avgMaePct: 0.7,
        },
        {
          pillarId: 'ORDER_FLOW_L2',
          title: 'Order Flow L2 (Bid/Ask Skew)',
          currentWeightPct: 15.0,
          recommendedWeightPct: 14.5,
          weightDeltaPct: -0.5,
          totalActiveVotes: 50,
          truePositives: 30,
          falsePositives: 20,
          falseNegatives: 7,
          hitRatePct: 60.0,
          avgMfePct: 1.3,
          avgMaePct: 0.7,
        },
        {
          pillarId: 'LIQ_CLUSTERS',
          title: 'Liquidity Clusters (Pools)',
          currentWeightPct: 7.5,
          recommendedWeightPct: 7.0,
          weightDeltaPct: -0.5,
          totalActiveVotes: 25,
          truePositives: 14,
          falsePositives: 11,
          falseNegatives: 4,
          hitRatePct: 56.0,
          avgMfePct: 1.2,
          avgMaePct: 0.8,
        },
        {
          pillarId: 'MOMENTUM_RVOL',
          title: 'Momentum & rVol (RSI / Volume)',
          currentWeightPct: 5.0,
          recommendedWeightPct: 9.5,
          weightDeltaPct: 4.5,
          totalActiveVotes: 48,
          truePositives: 36,
          falsePositives: 12,
          falseNegatives: 3,
          hitRatePct: 75.0,
          avgMfePct: 2.1,
          avgMaePct: 0.5,
        },
        {
          pillarId: 'SENTIMENT_MACRO',
          title: 'Macro Sentiment (Funding & Sentiment)',
          currentWeightPct: 2.5,
          recommendedWeightPct: 2.5,
          weightDeltaPct: 0.0,
          totalActiveVotes: 10,
          truePositives: 5,
          falsePositives: 5,
          falseNegatives: 2,
          hitRatePct: 50.0,
          avgMfePct: 0.9,
          avgMaePct: 0.9,
        },
      ],
    };

    const spy = vi.spyOn(apiClient, 'getPillarScorecard').mockResolvedValue(mockData);

    useUiStore.setState({ isPillarScorecardModalOpen: true });

    const root = createRoot(container);
    flushSync(() => {
      root.render(<PillarScorecardModal />);
    });

    // Wait for promise resolution and re-render
    await vi.waitFor(() => {
      expect(container.textContent).toContain('55 recorded');
    });

    const modal = container.querySelector('[data-testid="pillar-scorecard-modal"]');
    expect(modal).not.toBeNull();
    expect(container.textContent).toContain('Bulldog Engine: Pillar Matrix Scorecard');
    expect(container.textContent).toContain('SOLUSDT');
    expect(container.textContent).toContain('55 recorded');

    // Check all 7 rows
    expect(container.querySelector('[data-testid="pillar-row-MACRO_REGIME"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="pillar-row-NATIVE_SMC"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="pillar-row-CVD_ABSORPTION"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="pillar-row-ORDER_FLOW_L2"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="pillar-row-LIQ_CLUSTERS"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="pillar-row-MOMENTUM_RVOL"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="pillar-row-SENTIMENT_MACRO"]')).not.toBeNull();

    // Check hit rate for MOMENTUM_RVOL
    const momentumRow = container.querySelector('[data-testid="pillar-row-MOMENTUM_RVOL"]');
    expect(momentumRow?.textContent).toContain('75.0%');
    expect(momentumRow?.textContent).toContain('+4.5%');
  });

  it('closes modal when close button is clicked', () => {
    vi.spyOn(apiClient, 'getPillarScorecard').mockResolvedValue({
      symbol: 'SOLUSDT',
      horizon: '15m',
      sampleSize: 0,
      generatedAt: Date.now(),
      scorecards: [],
    });

    useUiStore.setState({ isPillarScorecardModalOpen: true });

    const root = createRoot(container);
    flushSync(() => {
      root.render(<PillarScorecardModal />);
    });

    const closeBtn = container.querySelector('[data-testid="close-pillar-scorecard-modal"]') as HTMLButtonElement;
    expect(closeBtn).not.toBeNull();

    flushSync(() => {
      closeBtn.click();
    });

    expect(useUiStore.getState().isPillarScorecardModalOpen).toBe(false);
  });
});
