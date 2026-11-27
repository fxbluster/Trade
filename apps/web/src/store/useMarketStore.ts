import { create } from 'zustand';
import type {
  CockpitState,
  KlineCandle,
  TechnicalSummary,
  CvdSnapshot,
  MentorBrief,
  RiskStateRecord,
  TradeRecord,
  OpenOrderInfo,
  AccountInfo,
  BrokerMode,
  ExchangeHealth,
  ConfluenceSnapshot,
  AutoPilotConfig,
  WebhookAlertPayload,
  ScannerItem,
  FairValueGap,
  OrderBlock,
  LiquiditySweep,
  FactorTelemetryEvent,
  PropFirmStatusResponse,
  ExchangePositionSummary,
} from '@tradeos/shared';
import type { WsStatus, TickData, AnalysisData, PositionEventData, AutoPilotStatusData } from '../lib/wsClient';
import { apiClient } from '../lib/apiClient';

const MAX_TELEMETRY_EVENTS = 50;

function isValidFactorTelemetryEvent(event: unknown): event is FactorTelemetryEvent {
  if (!event || typeof event !== 'object') return false;
  const ev = event as Partial<FactorTelemetryEvent>;
  if (typeof ev.symbol !== 'string' || ev.symbol.trim().length === 0) return false;
  if (typeof ev.timestamp !== 'number' || !Number.isFinite(ev.timestamp)) return false;
  if (typeof ev.compositeScore !== 'number' || !Number.isFinite(ev.compositeScore)) return false;
  if (!Array.isArray(ev.activeFactors)) return false;
  return true;
}

function normalizeFactorTelemetryEvent(ev: FactorTelemetryEvent): FactorTelemetryEvent {
  return {
    ...ev,
    markPrice: typeof ev.markPrice === 'number' && Number.isFinite(ev.markPrice) ? ev.markPrice : 0,
    collinearFactors: Array.isArray(ev.collinearFactors) ? ev.collinearFactors : [],
    noiseBandActive: Boolean(ev.noiseBandActive),
    macroVetoActive: Boolean(ev.macroVetoActive),
  };
}

export interface MarketStoreState {
  symbol: string;
  markPrice: number;
  prevMarkPrice: number;
  priceChangePercent24h: number;
  fundingRate: number | null;
  nextFundingTime: number | null;
  account: AccountInfo;
  activePosition: TradeRecord | null;
  activePositions: TradeRecord[];
  exchangePositions: ExchangePositionSummary[];
  openOrders: OpenOrderInfo[];
  indicators: TechnicalSummary | null;
  cvd: CvdSnapshot | null;
  risk: RiskStateRecord;
  sokrat: MentorBrief | null;
  exchangeHealth: ExchangeHealth;
  brokerMode: BrokerMode;
  wsStatus: WsStatus;
  klines: KlineCandle[];
  klinesSymbol: string | null;
  klinesInterval: '5s' | '15s' | '1m' | '5m' | '15m' | '1h' | null;
  candleInterval: '5s' | '15s' | '1m' | '5m' | '15m' | '1h';
  isLoadingKlines: boolean;
  isLoadingOlderKlines: boolean;
  hasMoreOlderKlines: boolean;

  // Confluence & Auto-Pilot & Pine Overlay Slices
  confluence: ConfluenceSnapshot | null;
  autoPilot: AutoPilotStatusData;
  hidePineOverlay: boolean;
  pineSignals: WebhookAlertPayload[];
  cachedScannerItems: ScannerItem[];

  // Native SMC & Institutional Slices
  activeFvgs: FairValueGap[];
  activeOrderBlocks: OrderBlock[];
  latestSweep: LiquiditySweep | null;
  showSmcOverlay: boolean;

  // Next-Gen Orthogonal Quant Telemetry Stream (bounded 50-item sliding window)
  telemetryEvents: FactorTelemetryEvent[];

  // Upcomers $50K Prop Firm Challenge Status
  propFirmStatus: PropFirmStatusResponse | null;

  // Actions
  setSymbol: (symbol: string) => Promise<void>;
  setCandleInterval: (interval: '5s' | '15s' | '1m' | '5m' | '15m' | '1h') => Promise<void>;
  setKlines: (klines: KlineCandle[]) => void;
  applySnapshot: (snapshot: CockpitState) => void;
  applyTick: (tick: TickData) => void;
  applyAnalysis: (data: AnalysisData) => void;
  applyPositionEvent: (event: PositionEventData) => void;
  setWsStatus: (status: WsStatus) => void;
  setBrokerMode: (mode: BrokerMode) => Promise<void>;
  refreshKlines: () => Promise<void>;
  loadOlderKlines: () => Promise<number>;
  refreshState: () => Promise<void>;

  // Confluence & AutoPilot actions
  setConfluence: (confluence: ConfluenceSnapshot) => void;
  setAutoPilotStatus: (data: AutoPilotStatusData) => void;
  setHidePineOverlay: (hide: boolean) => void;
  toggleHidePineOverlay: () => void;
  addPineSignal: (signal: WebhookAlertPayload) => void;
  refreshConfluence: () => Promise<void>;
  setCachedScannerItems: (items: ScannerItem[]) => void;
  setShowSmcOverlay: (show: boolean) => void;
  toggleShowSmcOverlay: () => void;
  setTelemetryEvents: (events: FactorTelemetryEvent[]) => void;
  addTelemetryEvent: (event: FactorTelemetryEvent) => void;
  setPropFirmStatus: (status: PropFirmStatusResponse | null) => void;
  refreshPropFirmStatus: () => Promise<void>;
  startNewPropFirmCycle: () => Promise<PropFirmStatusResponse>;
}

const defaultAccount: AccountInfo = {
  walletBalance: 0,
  equity: 0,
  availableBalance: 0,
  unrealizedPnl: 0,
  currency: 'USDT',
};

const defaultRisk: RiskStateRecord = {
  broker_mode: 'BINANCE_DEMO',
  consecutive_losses: 0,
  cooldown_until: 0,
  cooldown_reason: null,
  session_net_pnl: 0,
  session_started_at: Date.now(),
  updated_at: Date.now(),
};

const defaultAutoPilotConfig: AutoPilotConfig = {
  enabled: false,
  consensusThreshold: 60,
  marginAllocationPct: 10,
  leverage: 10,
  oppositeExitEnabled: true,
  circuitBreakerConsecutiveLosses: 2,
  circuitBreakerCooldownMs: 3600000,
  maxDailyTrades: 10,
  dailyDrawdownLimitPct: 2.0,
};

export const useMarketStore = create<MarketStoreState>((set, get) => ({
  symbol: 'SOLUSDT',
  markPrice: 0,
  prevMarkPrice: 0,
  priceChangePercent24h: 0,
  fundingRate: null,
  nextFundingTime: null,
  account: defaultAccount,
  activePosition: null,
  activePositions: [],
  exchangePositions: [],
  openOrders: [],
  indicators: null,
  cvd: null,
  risk: defaultRisk,
  sokrat: null,
  exchangeHealth: 'HEALTHY',
  brokerMode: 'BINANCE_DEMO',
  wsStatus: 'CONNECTING',
  klines: [],
  klinesSymbol: null,
  klinesInterval: null,
  candleInterval: '1m',
  isLoadingKlines: false,
  isLoadingOlderKlines: false,
  hasMoreOlderKlines: true,

  // New Confluence & Auto-Pilot state
  confluence: null,
  autoPilot: {
    state: 'IDLE',
    config: defaultAutoPilotConfig,
    openTradeId: null,
    message: undefined,
    blockReason: null,
    filledToday: 0,
    maxDailyTrades: 10,
    cooldownRemainingSec: 0,
  },
  hidePineOverlay: false,
  pineSignals: [],
  cachedScannerItems: [],

  // Native SMC & Institutional Slices
  activeFvgs: [],
  activeOrderBlocks: [],
  latestSweep: null,
  showSmcOverlay: true,

  // Next-Gen Orthogonal Quant Telemetry Stream
  telemetryEvents: [],

  // Upcomers $50K Prop Firm Challenge Status
  propFirmStatus: null,

  setSymbol: async (symbol: string) => {
    const sym = symbol.toUpperCase();
    if (get().symbol === sym) return;
    set({
      symbol: sym,
      markPrice: 0,
      prevMarkPrice: 0,
      activePosition: null,
      klines: [],
      klinesSymbol: null,
      klinesInterval: null,
      hasMoreOlderKlines: true,
      isLoadingOlderKlines: false,
      activeFvgs: [],
      activeOrderBlocks: [],
      latestSweep: null,
      isLoadingKlines: true,
    });
    try {
      await apiClient.setSymbol(sym);
      await Promise.allSettled([
        get().refreshKlines(),
        get().refreshState(),
        get().refreshConfluence(),
      ]);
    } catch (err) {
      console.error('Failed to change symbol:', err);
    } finally {
      set({ isLoadingKlines: false });
    }
  },

  setCandleInterval: async (interval: '5s' | '15s' | '1m' | '5m' | '15m' | '1h') => {
    set({
      candleInterval: interval,
      klines: [],
      klinesSymbol: null,
      klinesInterval: null,
      hasMoreOlderKlines: true,
      isLoadingOlderKlines: false,
      isLoadingKlines: true,
    });
    try {
      await get().refreshKlines();
    } finally {
      set({ isLoadingKlines: false });
    }
  },

  setKlines: (klines: KlineCandle[]) => {
    set({ klines });
  },

  applySnapshot: (snapshot: CockpitState) => {
    const prevSymbol = get().symbol;
    set((state) => {
      // Optimistic retention: If snapshot has empty/zero account (e.g. during momentary reconnect handshake),
      // preserve previous valid non-zero account.
      const hasValidPrevAccount = state.account && (state.account.walletBalance > 0 || state.account.equity > 0);
      const isSnapshotAccountEmpty = !snapshot.account || (snapshot.account.walletBalance === 0 && snapshot.account.equity === 0);
      const resolvedAccount = (isSnapshotAccountEmpty && hasValidPrevAccount) ? state.account : (snapshot.account || state.account);

      // Preserve activePosition optimistically ONLY if it matches the active symbol
      const targetSym = (snapshot.symbol || state.symbol).toUpperCase();
      const rawPos = snapshot.activePosition !== undefined ? snapshot.activePosition : state.activePosition;
      const resolvedPosition =
        rawPos && rawPos.symbol && rawPos.symbol.toUpperCase() === targetSym ? rawPos : null;

      return {
        symbol: snapshot.symbol,
        markPrice: snapshot.markPrice || state.markPrice,
        prevMarkPrice: state.markPrice || snapshot.markPrice,
        fundingRate: snapshot.fundingRate,
        nextFundingTime: snapshot.nextFundingTime,
        account: resolvedAccount,
        activePosition: resolvedPosition,
        activePositions: snapshot.activePositions ?? state.activePositions,
        exchangePositions: snapshot.exchangePositions ?? state.exchangePositions,
        openOrders: snapshot.openOrders ?? state.openOrders,
        indicators: snapshot.indicators ?? state.indicators,
        cvd: snapshot.cvd ?? state.cvd,
        risk: snapshot.risk ?? state.risk,
        sokrat: snapshot.sokrat ?? state.sokrat,
        exchangeHealth: snapshot.exchangeHealth ?? state.exchangeHealth,
        brokerMode: snapshot.brokerMode ?? state.brokerMode,
      };
    });

    // If server snapshot reports a different symbol or klines are empty, sync klines and confluence immediately
    if ((snapshot.symbol && snapshot.symbol !== prevSymbol) || get().klines.length === 0) {
      get().refreshKlines();
      get().refreshConfluence();
    }
  },

  applyTick: (tick: TickData) => {
    set((state) => {
      if (tick.symbol !== state.symbol) return state;

      // Update active position's unrealized PnL if open
      let updatedPosition = state.activePosition;
      if (updatedPosition) {
        const isLong = updatedPosition.side === 'BUY';
        const diff = isLong
          ? tick.markPrice - updatedPosition.entry_price
          : updatedPosition.entry_price - tick.markPrice;
        updatedPosition = {
          ...updatedPosition,
          realized_pnl: updatedPosition.realized_pnl,
        };
      }

      // Tier 2 Decoupled Telemetry:
      // klines array reference is strictly preserved during live ticks.
      // Direct 60fps canvas updates occur in ChartCanvas via wsClient.subscribeTick.
      return {
        markPrice: tick.markPrice,
        prevMarkPrice: state.markPrice,
        activePosition: updatedPosition,
        account: {
          ...state.account,
          unrealizedPnl: tick.unrealizedPnl,
          equity: state.account.walletBalance + tick.unrealizedPnl,
        },
      };
    });
  },

  setCachedScannerItems: (items: ScannerItem[]) => {
    set({ cachedScannerItems: items });
  },

  applyAnalysis: (data: AnalysisData) => {
    set({
      indicators: data.indicators,
      sokrat: data.sokrat,
      risk: data.risk,
    });
  },

  applyPositionEvent: (event: PositionEventData) => {
    const evTrade = event.data.trade;
    const currentSym = get().symbol.toUpperCase();
    const evSym = evTrade?.symbol?.toUpperCase();
    set((state) => {
      const nextPositions =
        event.event === 'CLOSED'
          ? state.activePositions.filter((p) => p.id !== evTrade.id && p.symbol.toUpperCase() !== evSym)
          : [evTrade, ...state.activePositions.filter((p) => p.id !== evTrade.id && p.symbol.toUpperCase() !== evSym)];

      const nextActivePosition =
        evSym === currentSym
          ? event.event === 'CLOSED'
            ? null
            : evTrade
          : state.activePosition && state.activePosition.symbol.toUpperCase() === currentSym
          ? state.activePosition
          : null;

      return {
        activePosition: nextActivePosition,
        activePositions: nextPositions,
      };
    });
  },

  setWsStatus: (status: WsStatus) => {
    set({ wsStatus: status });
    if (status === 'CONNECTED') {
      get().refreshKlines();
      get().refreshConfluence();
    }
  },

  setBrokerMode: async (mode: BrokerMode) => {
    try {
      await apiClient.setBrokerMode(mode);
      set({ brokerMode: mode });
      await get().refreshState();
    } catch (err) {
      console.error('Failed to change broker mode:', err);
      throw err;
    }
  },

  refreshKlines: async () => {
    const { symbol, candleInterval } = get();
    const fetchOnce = async () => apiClient.getKlines(symbol, candleInterval, 1000);
    try {
      let candles = await fetchOnce();
      if (
        (!Array.isArray(candles) || candles.length === 0) &&
        get().symbol === symbol &&
        get().candleInterval === candleInterval
      ) {
        await new Promise((r) => setTimeout(r, 600));
        if (get().symbol === symbol && get().candleInterval === candleInterval) {
          candles = await fetchOnce();
        }
      }
      if (
        get().symbol === symbol &&
        get().candleInterval === candleInterval &&
        Array.isArray(candles) &&
        candles.length > 0
      ) {
        set({
          klines: candles,
          klinesSymbol: symbol,
          klinesInterval: candleInterval,
          hasMoreOlderKlines: candles.length >= 2,
        });
      }
    } catch (err) {
      if (get().symbol === symbol && get().candleInterval === candleInterval) {
        await new Promise((r) => setTimeout(r, 600));
        if (get().symbol === symbol && get().candleInterval === candleInterval) {
          try {
            const retryCandles = await fetchOnce();
            if (Array.isArray(retryCandles) && retryCandles.length > 0) {
              set({
                klines: retryCandles,
                klinesSymbol: symbol,
                klinesInterval: candleInterval,
                hasMoreOlderKlines: retryCandles.length >= 2,
              });
              return;
            }
          } catch (retryErr) {
            console.error('Failed to fetch klines on retry:', retryErr);
          }
        }
      }
      console.error('Failed to fetch klines:', err);
    }
  },

  loadOlderKlines: async () => {
    const { symbol, candleInterval, klines, isLoadingOlderKlines, hasMoreOlderKlines } = get();
    if (isLoadingOlderKlines || !hasMoreOlderKlines || !Array.isArray(klines) || klines.length === 0) {
      return 0;
    }
    const earliestSec = klines[0].time;
    if (!Number.isFinite(earliestSec) || earliestSec <= 0) return 0;

    set({ isLoadingOlderKlines: true });
    try {
      const fetched = await apiClient.getKlines(symbol, candleInterval, 500, (earliestSec - 1) * 1000);
      if (get().symbol !== symbol || get().candleInterval !== candleInterval) {
        return 0;
      }
      const older = Array.isArray(fetched)
        ? fetched.filter((c) => c && typeof c.time === 'number' && Number.isFinite(c.time) && c.time < earliestSec)
        : [];
      if (older.length === 0) {
        set({ hasMoreOlderKlines: false });
        return 0;
      }
      const mergedMap = new Map<number, KlineCandle>();
      for (const c of older) mergedMap.set(c.time, c);
      for (const c of get().klines) mergedMap.set(c.time, c);
      const merged = Array.from(mergedMap.values()).sort((a, b) => a.time - b.time);
      set({
        klines: merged,
        klinesSymbol: symbol,
        klinesInterval: candleInterval,
      });
      return older.length;
    } catch (err) {
      console.error('Failed to load older klines:', err);
      return 0;
    } finally {
      set({ isLoadingOlderKlines: false });
    }
  },

  refreshState: async () => {
    try {
      const state = await apiClient.getState();
      get().applySnapshot(state);
    } catch (err) {
      console.error('Failed to refresh state:', err);
    }
  },

  // Confluence & AutoPilot actions
  setConfluence: (confluence: ConfluenceSnapshot) => {
    if (
      confluence.symbol &&
      confluence.symbol.toUpperCase() !== get().symbol.toUpperCase()
    ) {
      return;
    }
    set({
      confluence,
      activeFvgs: confluence.activeFvgs ?? [],
      activeOrderBlocks: confluence.activeOrderBlocks ?? [],
      latestSweep: confluence.latestSweep ?? null,
    });
  },

  setAutoPilotStatus: (data: AutoPilotStatusData) => {
    set({ autoPilot: data });
  },

  setHidePineOverlay: (hide: boolean) => {
    set({ hidePineOverlay: hide });
  },

  toggleHidePineOverlay: () => {
    set((state) => ({ hidePineOverlay: !state.hidePineOverlay }));
  },

  setShowSmcOverlay: (show: boolean) => {
    set({ showSmcOverlay: show });
  },

  toggleShowSmcOverlay: () => {
    set((state) => ({ showSmcOverlay: !state.showSmcOverlay }));
  },

  addPineSignal: (signal: WebhookAlertPayload) => {
    set((state) => ({
      pineSignals: [signal, ...state.pineSignals.slice(0, 19)],
    }));
  },

  refreshConfluence: async () => {
    const targetSym = get().symbol;
    try {
      const data = await apiClient.getConfluence(targetSym);
      if (get().symbol === targetSym && data) {
        get().setConfluence(data);
      }
    } catch {
      // Confluence engine may not be online yet in test/dev
    }
  },

  setTelemetryEvents: (events: FactorTelemetryEvent[]) => {
    if (!Array.isArray(events)) {
      set({ telemetryEvents: [] });
      return;
    }
    const sanitized = events
      .filter(isValidFactorTelemetryEvent)
      .map(normalizeFactorTelemetryEvent)
      .sort((a, b) => b.timestamp - a.timestamp)
      .slice(0, MAX_TELEMETRY_EVENTS);
    set({ telemetryEvents: sanitized });
  },

  addTelemetryEvent: (event: FactorTelemetryEvent) => {
    if (!isValidFactorTelemetryEvent(event)) {
      return;
    }
    const normalized = normalizeFactorTelemetryEvent(event);
    set((state) => ({
      telemetryEvents: [normalized, ...state.telemetryEvents].slice(0, MAX_TELEMETRY_EVENTS),
    }));
  },

  setPropFirmStatus: (status: PropFirmStatusResponse | null) => {
    set({ propFirmStatus: status });
  },

  refreshPropFirmStatus: async () => {
    try {
      if (typeof apiClient.getPropFirmStatus !== 'function') return;
      const status = await apiClient.getPropFirmStatus();
      set({ propFirmStatus: status });
    } catch {
      // Prop Firm endpoint may not be online yet in test/offline dev
    }
  },

  startNewPropFirmCycle: async () => {
    const res = await apiClient.startNewPropFirmCycle();
    set({ propFirmStatus: res.status });
    return res.status;
  },
}));
