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
} from '@tradeos/shared';
import { wsClient, type WsStatus, type TickData, type AnalysisData, type PositionEventData } from '../lib/wsClient';
import { apiClient } from '../lib/apiClient';

export interface MarketStoreState {
  symbol: string;
  markPrice: number;
  prevMarkPrice: number;
  priceChangePercent24h: number;
  fundingRate: number | null;
  nextFundingTime: number | null;
  account: AccountInfo;
  activePosition: TradeRecord | null;
  openOrders: OpenOrderInfo[];
  indicators: TechnicalSummary | null;
  cvd: CvdSnapshot | null;
  risk: RiskStateRecord;
  sokrat: MentorBrief | null;
  exchangeHealth: ExchangeHealth;
  brokerMode: BrokerMode;
  wsStatus: WsStatus;
  klines: KlineCandle[];
  candleInterval: '1m' | '5m' | '15m' | '1h';
  isLoadingKlines: boolean;

  // Actions
  setSymbol: (symbol: string) => Promise<void>;
  setCandleInterval: (interval: '1m' | '5m' | '15m' | '1h') => Promise<void>;
  setKlines: (klines: KlineCandle[]) => void;
  applySnapshot: (snapshot: CockpitState) => void;
  applyTick: (tick: TickData) => void;
  applyAnalysis: (data: AnalysisData) => void;
  applyPositionEvent: (event: PositionEventData) => void;
  setWsStatus: (status: WsStatus) => void;
  setBrokerMode: (mode: BrokerMode) => Promise<void>;
  refreshKlines: () => Promise<void>;
  refreshState: () => Promise<void>;
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

export const useMarketStore = create<MarketStoreState>((set, get) => ({
  symbol: 'SOLUSDT',
  markPrice: 0,
  prevMarkPrice: 0,
  priceChangePercent24h: 0,
  fundingRate: null,
  nextFundingTime: null,
  account: defaultAccount,
  activePosition: null,
  openOrders: [],
  indicators: null,
  cvd: null,
  risk: defaultRisk,
  sokrat: null,
  exchangeHealth: 'HEALTHY',
  brokerMode: 'BINANCE_DEMO',
  wsStatus: 'CONNECTING',
  klines: [],
  candleInterval: '5m',
  isLoadingKlines: false,

  setSymbol: async (symbol: string) => {
    const sym = symbol.toUpperCase();
    if (get().symbol === sym) return;
    set({ symbol: sym, klines: [], isLoadingKlines: true });
    wsClient.subscribeSymbol(sym);
    try {
      await apiClient.setSymbol(sym);
      await get().refreshKlines();
      await get().refreshState();
    } catch (err) {
      console.error('Failed to change symbol:', err);
    } finally {
      set({ isLoadingKlines: false });
    }
  },

  setCandleInterval: async (interval: '1m' | '5m' | '15m' | '1h') => {
    set({ candleInterval: interval, isLoadingKlines: true });
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
    set((state) => ({
      symbol: snapshot.symbol,
      markPrice: snapshot.markPrice,
      prevMarkPrice: state.markPrice || snapshot.markPrice,
      fundingRate: snapshot.fundingRate,
      nextFundingTime: snapshot.nextFundingTime,
      account: snapshot.account,
      activePosition: snapshot.activePosition,
      openOrders: snapshot.openOrders,
      indicators: snapshot.indicators,
      cvd: snapshot.cvd,
      risk: snapshot.risk,
      sokrat: snapshot.sokrat,
      exchangeHealth: snapshot.exchangeHealth,
      brokerMode: snapshot.brokerMode,
    }));
  },

  applyTick: (tick: TickData) => {
    set((state) => {
      if (tick.symbol !== state.symbol) return state;

      // Update active position's unrealized PnL if open
      let updatedPosition = state.activePosition;
      if (updatedPosition) {
        // Position unrealized PnL estimation
        const isLong = updatedPosition.side === 'BUY';
        const diff = isLong
          ? tick.markPrice - updatedPosition.entry_price
          : updatedPosition.entry_price - tick.markPrice;
        const uPnl = Number((diff * updatedPosition.remaining_qty).toFixed(2));
        updatedPosition = {
          ...updatedPosition,
          realized_pnl: updatedPosition.realized_pnl, // preserves realized
        };
      }

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

  applyAnalysis: (data: AnalysisData) => {
    set({
      indicators: data.indicators,
      sokrat: data.sokrat,
      risk: data.risk,
    });
  },

  applyPositionEvent: (event: PositionEventData) => {
    if (event.event === 'CLOSED') {
      set({ activePosition: null });
    } else {
      set({ activePosition: event.data.trade });
    }
  },

  setWsStatus: (status: WsStatus) => {
    set({ wsStatus: status });
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
    try {
      const candles = await apiClient.getKlines(symbol, candleInterval, 400);
      set({ klines: candles });
    } catch (err) {
      console.error('Failed to fetch klines:', err);
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
}));
