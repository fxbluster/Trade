/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useMarketStore } from '../../store/useMarketStore';
import type { ConfluenceSnapshot } from '@tradeos/shared';

describe('ConfluenceHUD & Auto-Pilot State Slices', () => {
  beforeEach(() => {
    useMarketStore.setState({
      symbol: 'BTCUSDT',
      confluence: null,
      hidePineOverlay: false,
      pineSignals: [],
    });
  });

  it('updates confluence snapshot in store correctly', () => {
    const sampleSnapshot: ConfluenceSnapshot = {
      symbol: 'BTCUSDT',
      pillars: [
        {
          id: 'MTF_TREND',
          title: 'MTF Trend',
          score: 85,
          bias: 'BULLISH',
          valueText: 'EMA 9>21>50 Stack',
          subText: 'ADX 28.5',
          confirmed: true,
          updatedAt: Date.now(),
        },
        {
          id: 'ORDER_FLOW',
          title: 'Order Flow',
          score: 80,
          bias: 'BULLISH',
          valueText: 'Imbalance 3.4x',
          subText: 'Aggressive Bids',
          confirmed: true,
          updatedAt: Date.now(),
        },
        {
          id: 'MOMENTUM',
          title: 'Momentum',
          score: 75,
          bias: 'BULLISH',
          valueText: 'RSI 62.1',
          subText: 'MACD Hist +14.2',
          confirmed: true,
          updatedAt: Date.now(),
        },
        {
          id: 'CVD',
          title: 'CVD Absorption',
          score: 70,
          bias: 'BULLISH',
          valueText: 'Delta Divergence',
          subText: 'Perp Absorption',
          confirmed: true,
          updatedAt: Date.now(),
        },
        {
          id: 'LIQ_MAGNET',
          title: 'Liq Magnet',
          score: 50,
          bias: 'NEUTRAL',
          valueText: 'Distance > 1.2 ATR',
          subText: 'No cluster',
          confirmed: false,
          updatedAt: Date.now(),
        },
        {
          id: 'NLP_NEWS',
          title: 'NLP News',
          score: 65,
          bias: 'BULLISH',
          valueText: 'VADER +0.41',
          subText: 'Bullish Sentiment',
          confirmed: true,
          updatedAt: Date.now(),
        },
        {
          id: 'PINE_SMC',
          title: 'PineScript SMC',
          score: 50,
          bias: 'NEUTRAL',
          valueText: 'Waiting TV alert',
          subText: 'No recent alert',
          confirmed: false,
          updatedAt: Date.now(),
        },
      ],
      bullishCount: 5,
      bearishCount: 0,
      neutralCount: 2,
      consensusBias: 'BULLISH',
      consensusMet: true,
      threshold: 4,
      compositeScore: 78,
      recommendedAction: 'BUY',
    };

    useMarketStore.getState().setConfluence(sampleSnapshot);

    const stored = useMarketStore.getState().confluence;
    expect(stored).not.toBeNull();
    expect(stored?.consensusMet).toBe(true);
    expect(stored?.bullishCount).toBe(5);
    expect(stored?.recommendedAction).toBe('BUY');
    expect(stored?.compositeScore).toBe(78);
  });

  it('toggles hidePineOverlay state correctly without clearing signals', () => {
    expect(useMarketStore.getState().hidePineOverlay).toBe(false);

    useMarketStore.getState().toggleHidePineOverlay();
    expect(useMarketStore.getState().hidePineOverlay).toBe(true);

    useMarketStore.getState().addPineSignal({
      secret: 'test-secret',
      symbol: 'BTCUSDT',
      side: 'BUY',
      entryPrice: 91000,
      stopLoss: 89500,
      tp1: 93000,
      tp2: 95000,
      time: Date.now(),
    });

    expect(useMarketStore.getState().pineSignals.length).toBe(1);
    expect(useMarketStore.getState().pineSignals[0].side).toBe('BUY');

    useMarketStore.getState().toggleHidePineOverlay();
    expect(useMarketStore.getState().hidePineOverlay).toBe(false);
    expect(useMarketStore.getState().pineSignals.length).toBe(1);
  });

  it('updates autoPilot status and config correctly', () => {
    useMarketStore.getState().setAutoPilotStatus({
      state: 'POSITION_OPEN',
      config: {
        enabled: true,
        consensusThreshold: 5,
        marginAllocationPct: 10,
        leverage: 10,
        oppositeExitEnabled: true,
        circuitBreakerConsecutiveLosses: 2,
        circuitBreakerCooldownMs: 3600000,
      },
      openTradeId: 'trade-auto-99',
    });

    const ap = useMarketStore.getState().autoPilot;
    expect(ap.state).toBe('POSITION_OPEN');
    expect(ap.config.enabled).toBe(true);
    expect(ap.config.consensusThreshold).toBe(5);
    expect(ap.openTradeId).toBe('trade-auto-99');
  });
});
