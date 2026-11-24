/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { flushSync } from 'react-dom';
import type { DailyAuditResponse, FactorTelemetryEvent } from '@tradeos/shared';
import { AgentTelemetryPanel } from '../AgentTelemetryPanel';
import { useMarketStore } from '../../store/useMarketStore';
import { useUiStore } from '../../store/useUiStore';
import { apiClient } from '../../lib/apiClient';
import { wsClient } from '../../lib/wsClient';

function makeEvent(overrides: Partial<FactorTelemetryEvent> = {}): FactorTelemetryEvent {
  return {
    id: 1,
    eventId: 'evt-1',
    timestamp: 1700000000000,
    symbol: 'SOLUSDT',
    triggerType: 'POSITION_ENTERED',
    markPrice: 145.5,
    compositeScore: 84,
    convictionArchetype: 'HIGH_CONVICTION_CORE',
    consensusSide: 'BUY',
    noiseBandActive: false,
    macroVetoActive: false,
    activeFactors: [
      {
        factorId: 'ORDER_FLOW_L2',
        name: 'Order Flow L2',
        bias: 'BULLISH',
        rawAlpha: 0.78,
        orthogonalAlpha: 0.72,
        effectiveWeight: 0.546,
        isCollinear: false,
        confidence: 0.91,
        summaryText: 'Depth Imbalance 1.8x Bid',
      },
      {
        factorId: 'CVD_ABSORPTION',
        name: 'CVD Absorption',
        bias: 'BEARISH',
        rawAlpha: -0.45,
        orthogonalAlpha: -0.41,
        effectiveWeight: 0.307,
        isCollinear: false,
        confidence: 0.8,
        summaryText: 'Aggressive ask absorption',
      },
      {
        factorId: 'LIQ_CLUSTERS',
        name: 'Liquidation Clusters',
        bias: 'NEUTRAL',
        rawAlpha: 0.05,
        orthogonalAlpha: 0.02,
        effectiveWeight: 0.147,
        isCollinear: false,
        confidence: 0.55,
        summaryText: 'Cluster distance > 1.5 ATR',
      },
    ],
    collinearFactors: ['Native SMC', 'Macro Regime'],
    chasingTelemetry: {
      orderId: 'chase-1',
      status: 'FILLED',
      anchorMarkPrice: 145.5,
      currentLimitPrice: 145.48,
      spreadPennyJumps: 2,
      amendmentCount: 2,
      durationMs: 840,
      realizedFeeUsd: 0.95,
      feeSavedVsTakerUsd: 1.42,
    },
    sizingTelemetry: {
      allocatedMarginUsd: 1200,
      allocatedMarginPct: 25.0,
      baseConvictionMargin: 0.21,
      quarterKellyMultiplier: 0.85,
      volatilityParityMultiplier: 1.1,
      circuitBreakerMultiplier: 1.0,
      solvencyAirbagOk: true,
    },
    ...overrides,
  };
}

function makeAuditResponse(events: FactorTelemetryEvent[]): DailyAuditResponse {
  return {
    summary: {
      total_setups: events.length,
      executed_trades: 1,
      blocked_setups: 0,
      capital_saved_usd: 0,
      missed_profit_usd: 0,
      expired_pnl_usd: 0,
      net_risk_value_usd: 0,
      veto_breakdown: {},
    },
    records: [],
    generated_at: 1700000000000,
    factor_telemetry_events: events,
  };
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe('AgentTelemetryPanel & Orthogonal Telemetry Pipeline', () => {
  let container: HTMLDivElement;
  let root: Root | null = null;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    useMarketStore.setState({
      wsStatus: 'CONNECTED',
      telemetryEvents: [],
    });
    useUiStore.setState({
      isBottomExpanded: false,
      activeBottomTab: 'TELEMETRY',
      rightRailTab: 'ORDER_TICKET',
    });
  });

  afterEach(() => {
    if (root) {
      flushSync(() => {
        root?.unmount();
      });
      root = null;
    }
    wsClient.disconnect();
    vi.useRealTimers();
    vi.restoreAllMocks();
    container.remove();
  });

  it('bootstraps once on mount with zero 5s polling over 30s and supports manual refresh', async () => {
    vi.useFakeTimers();
    const ev = makeEvent();
    const auditSpy = vi
      .spyOn(apiClient, 'getDailyAudit')
      .mockResolvedValue(makeAuditResponse([ev]));

    root = createRoot(container);
    flushSync(() => {
      root!.render(<AgentTelemetryPanel />);
    });

    await flushMicrotasks();

    expect(auditSpy).toHaveBeenCalledTimes(1);
    expect(auditSpy).toHaveBeenCalledWith('current');

    // Advance 30 seconds — zero polling intervals should trigger
    await vi.advanceTimersByTimeAsync(30_000);
    expect(auditSpy).toHaveBeenCalledTimes(1);

    expect(container.textContent).toContain('WS Canlı');
    expect(container.textContent).not.toContain('Canlı (5s)');

    const refreshBtn = container.querySelector(
      '[data-testid="telemetry-refresh-btn"]'
    ) as HTMLButtonElement | null;
    expect(refreshBtn).not.toBeNull();

    flushSync(() => {
      refreshBtn!.click();
    });
    await flushMicrotasks();

    expect(auditSpy).toHaveBeenCalledTimes(2);
  });

  it('renders Orthogonal Quant Conviction, factor badges, [COLLINEAR], noise band, macro veto, and zero legacy tags', async () => {
    const buyEvent = makeEvent({
      id: 101,
      eventId: 'evt-buy',
      noiseBandActive: false,
      macroVetoActive: true,
      macroVetoReason: 'Price below 1h EMA200',
    });
    const sellEvent = makeEvent({
      id: 102,
      eventId: 'evt-sell',
      timestamp: 1700000001000,
      symbol: 'BTCUSDT',
      consensusSide: 'SELL',
      compositeScore: 95,
      convictionArchetype: 'A_PLUS_INSTITUTIONAL',
      noiseBandActive: true,
      macroVetoActive: false,
      collinearFactors: [],
    });

    vi.spyOn(apiClient, 'getDailyAudit').mockResolvedValue(
      makeAuditResponse([buyEvent, sellEvent])
    );

    root = createRoot(container);
    flushSync(() => {
      root!.render(<AgentTelemetryPanel />);
    });
    await flushMicrotasks();

    const text = container.textContent ?? '';
    expect(text).toContain('SOLUSDT');
    expect(text).toContain('BTCUSDT');
    expect(text).toContain('Orthogonal Quant Conviction');
    expect(text).toContain('Score: 84% (High-Conviction Core)');
    expect(text).toContain('Score: 95% (A+ Institutional)');
    expect(text).toContain('Noise Band: CLEAR');
    expect(text).toContain('Noise Band: ACTIVE');
    expect(text).toContain('MACRO VETO');

    // Independent orthogonal factor badges + bias colors
    const orderFlowBadge = container.querySelector(
      '[data-testid="factor-badge-ORDER_FLOW_L2"]'
    );
    expect(orderFlowBadge).not.toBeNull();
    expect(orderFlowBadge?.textContent).toContain('Order Flow L2');
    expect(orderFlowBadge?.textContent).toContain('54.6% wt');
    expect(orderFlowBadge?.textContent).toContain('BULLISH');
    expect(orderFlowBadge?.className).toContain('#0ecb81');

    const cvdBadge = container.querySelector('[data-testid="factor-badge-CVD_ABSORPTION"]');
    expect(cvdBadge).not.toBeNull();
    expect(cvdBadge?.textContent).toContain('CVD Absorption');
    expect(cvdBadge?.textContent).toContain('30.7% wt');
    expect(cvdBadge?.textContent).toContain('BEARISH');
    expect(cvdBadge?.className).toContain('#f6465d');

    const liqBadge = container.querySelector('[data-testid="factor-badge-LIQ_CLUSTERS"]');
    expect(liqBadge).not.toBeNull();
    expect(liqBadge?.textContent).toContain('Liquidation Clusters');
    expect(liqBadge?.textContent).toContain('14.7% wt');
    expect(liqBadge?.textContent).toContain('NEUTRAL');
    expect(liqBadge?.className).toContain('#7d8590');

    // Collinear tag
    expect(text).toContain('[COLLINEAR]: Native SMC, Macro Regime');

    // Legacy artifacts purged completely
    expect(text).not.toMatch(/\bP[1-7]\b/);
    expect(text).not.toMatch(/\d+\/7\s*Aktiv/i);
    expect(text).not.toContain('Makro');
    expect(text).not.toContain('Xəbər');
  });

  it('toggles accordion revealing chasingTelemetry, sizingTelemetry, and per-factor alpha details', async () => {
    const ev = makeEvent({
      macroVetoActive: true,
      macroVetoReason: 'Macro EMA200 headwind',
    });
    vi.spyOn(apiClient, 'getDailyAudit').mockResolvedValue(makeAuditResponse([ev]));

    root = createRoot(container);
    flushSync(() => {
      root!.render(<AgentTelemetryPanel />);
    });
    await flushMicrotasks();

    expect(container.querySelector('[data-testid="telemetry-accordion"]')).toBeNull();

    const row = container.querySelector('[data-testid="telemetry-row-0"]') as HTMLElement | null;
    expect(row).not.toBeNull();

    flushSync(() => {
      row!.click();
    });

    const accordion = container.querySelector('[data-testid="telemetry-accordion"]');
    expect(accordion).not.toBeNull();
    const accText = accordion!.textContent ?? '';

    // Chasing telemetry
    expect(accText).toContain('$145.50');
    expect(accText).toContain('$145.48');
    expect(accText).toContain('2');
    expect(accText).toContain('840ms');
    expect(accText).toContain('$1.42');

    // Sizing telemetry
    expect(accText).toContain('$1200.00');
    expect(accText).toContain('25.0%');
    expect(accText).toContain('0.85x');
    expect(accText).toContain('1.10x');
    expect(accText).toContain('1.00x');
    expect(accText).toContain('SECURE');

    // Per-factor alpha & summary
    expect(accText).toContain('Depth Imbalance 1.8x Bid');
    expect(accText).toContain('0.780');
    expect(accText).toContain('0.720');
    expect(accText).toContain('Macro EMA200 headwind');
  });

  it('supports sideFilter and dock/expand layout buttons', async () => {
    const buyEvent = makeEvent({ id: 1, eventId: 'b1', symbol: 'SOLUSDT', consensusSide: 'BUY' });
    const sellEvent = makeEvent({ id: 2, eventId: 's1', symbol: 'ETHUSDT', consensusSide: 'SELL' });
    vi.spyOn(apiClient, 'getDailyAudit').mockResolvedValue(
      makeAuditResponse([buyEvent, sellEvent])
    );

    root = createRoot(container);
    flushSync(() => {
      root!.render(<AgentTelemetryPanel />);
    });
    await flushMicrotasks();

    const sellFilterBtn = Array.from(container.querySelectorAll('button')).find(
      (b) => b.textContent?.trim() === 'SELL'
    )!;
    flushSync(() => {
      sellFilterBtn.click();
    });
    expect(container.textContent).toContain('ETHUSDT');
    expect(container.textContent).not.toContain('SOLUSDT');

    const buyFilterBtn = Array.from(container.querySelectorAll('button')).find(
      (b) => b.textContent?.trim() === 'BUY'
    )!;
    flushSync(() => {
      buyFilterBtn.click();
    });
    expect(container.textContent).toContain('SOLUSDT');
    expect(container.textContent).not.toContain('ETHUSDT');

    const expandBtn = Array.from(container.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('Böyüt')
    )!;
    flushSync(() => {
      expandBtn.click();
    });
    expect(useUiStore.getState().isBottomExpanded).toBe(true);
    expect(container.textContent).toContain('Kiçilt');

    const dockRightBtn = Array.from(container.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('Sağa Keçir')
    )!;
    flushSync(() => {
      dockRightBtn.click();
    });
    expect(useUiStore.getState().rightRailTab).toBe('TELEMETRY');
    expect(useUiStore.getState().activeBottomTab).toBe('POSITION');

    flushSync(() => {
      root!.render(<AgentTelemetryPanel isDockedRight={true} />);
    });
    const dockBottomBtn = Array.from(container.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('Aşağı Keçir')
    )!;
    flushSync(() => {
      dockBottomBtn.click();
    });
    expect(useUiStore.getState().rightRailTab).toBe('ORDER_TICKET');
    expect(useUiStore.getState().activeBottomTab).toBe('TELEMETRY');
  });

  it('caps telemetryEvents at 50 items under 60 WS bursts and ignores malformed payloads safely', () => {
    const store = useMarketStore.getState();

    for (let i = 0; i < 60; i++) {
      store.addTelemetryEvent(
        makeEvent({
          id: i + 1,
          eventId: `burst-${i}`,
          timestamp: 1700000000000 + i * 1000,
          symbol: i % 2 === 0 ? 'SOLUSDT' : 'BTCUSDT',
        })
      );
    }

    expect(useMarketStore.getState().telemetryEvents).toHaveLength(50);
    expect(useMarketStore.getState().telemetryEvents[0].eventId).toBe('burst-59');
    expect(useMarketStore.getState().telemetryEvents[49].eventId).toBe('burst-10');

    // Malformed / null payloads must not throw or corrupt store
    expect(() => store.addTelemetryEvent(null as unknown as FactorTelemetryEvent)).not.toThrow();
    expect(() =>
      store.addTelemetryEvent(undefined as unknown as FactorTelemetryEvent)
    ).not.toThrow();
    expect(() =>
      store.addTelemetryEvent({ invalid: true } as unknown as FactorTelemetryEvent)
    ).not.toThrow();
    expect(() =>
      store.addTelemetryEvent({
        symbol: 'SOLUSDT',
        timestamp: 1700000999000,
        compositeScore: 80,
      } as unknown as FactorTelemetryEvent)
    ).not.toThrow();
    expect(() =>
      store.addTelemetryEvent({
        symbol: '',
        timestamp: 1700000999000,
        compositeScore: 80,
        activeFactors: [],
      } as unknown as FactorTelemetryEvent)
    ).not.toThrow();

    expect(useMarketStore.getState().telemetryEvents).toHaveLength(50);
    expect(useMarketStore.getState().telemetryEvents[0].eventId).toBe('burst-59');

    // setTelemetryEvents also sanitizes and caps at 50
    expect(() =>
      store.setTelemetryEvents(null as unknown as FactorTelemetryEvent[])
    ).not.toThrow();
    expect(useMarketStore.getState().telemetryEvents).toEqual([]);

    const mixed = [
      null as unknown as FactorTelemetryEvent,
      ...Array.from({ length: 55 }, (_, i) =>
        makeEvent({ eventId: `set-${i}`, timestamp: 1700000000000 + i * 100 })
      ),
    ];
    store.setTelemetryEvents(mixed);
    expect(useMarketStore.getState().telemetryEvents).toHaveLength(50);
    expect(useMarketStore.getState().telemetryEvents[0].eventId).toBe('set-54');
  });

  it('dispatches FACTOR_TELEMETRY WebSocket frames through wsClient handler', async () => {
    let createdSocket: { onmessage: ((ev: MessageEvent) => void) | null; readyState: number; close: () => void } | null = null;

    class MockWebSocket {
      static OPEN = 1;
      static CONNECTING = 0;
      static CLOSING = 2;
      static CLOSED = 3;
      readyState = 1;
      onopen: (() => void) | null = null;
      onmessage: ((ev: MessageEvent) => void) | null = null;
      onerror: ((ev: Event) => void) | null = null;
      onclose: (() => void) | null = null;
      constructor(_url: string, _protocols?: string | string[]) {
        createdSocket = this;
      }
      send() {}
      close() {
        this.readyState = 3;
      }
    }

    vi.stubGlobal('WebSocket', MockWebSocket);
    sessionStorage.setItem('tradeos_session_token', 'test-ws-token');

    const received: FactorTelemetryEvent[] = [];
    wsClient.setHandlers({
      onFactorTelemetry: (ev) => received.push(ev),
    });

    await wsClient.connect();
    const socket = createdSocket as MockWebSocket | null;
    expect(socket).not.toBeNull();

    const payload = makeEvent({ eventId: 'ws-live-1', symbol: 'SOLUSDT' });
    socket!.onmessage?.(
      new MessageEvent('message', {
        data: JSON.stringify({ type: 'FACTOR_TELEMETRY', data: payload }),
      })
    );

    expect(received).toHaveLength(1);
    expect(received[0].eventId).toBe('ws-live-1');
    vi.unstubAllGlobals();
  });
});
