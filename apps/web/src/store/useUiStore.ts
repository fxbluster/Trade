import { create } from 'zustand';
import type { TradeSide, OrderType, OrderPreviewResponse } from '@tradeos/shared';

export interface OrderDraft {
  side: TradeSide;
  orderType: OrderType;
  marginUsd: number;
  leverage: number;
  limitPrice?: number;
  stopLoss?: number;
  tp1?: number;
  tp2?: number;
  preview: OrderPreviewResponse | null;
}

export type BottomTabType = 'POSITION' | 'ORDERS' | 'JOURNAL' | 'TELEMETRY';

export interface UiStoreState {
  orderDraft: OrderDraft;
  isCooldownModalOpen: boolean;
  isScannerModalOpen: boolean;
  isTimeMachineModalOpen: boolean;
  isPillarScorecardModalOpen: boolean;
  isAudioMuted: boolean;
  activeBottomTab: BottomTabType;

  // Actions
  setOrderDraft: (draft: Partial<OrderDraft>) => void;
  resetOrderDraft: () => void;
  setPreview: (preview: OrderPreviewResponse | null) => void;
  setIsCooldownModalOpen: (open: boolean) => void;
  setIsScannerModalOpen: (open: boolean) => void;
  setIsTimeMachineModalOpen: (open: boolean) => void;
  setIsPillarScorecardModalOpen: (open: boolean) => void;
  toggleAudioMute: () => void;
  setActiveBottomTab: (tab: BottomTabType) => void;
}

const defaultOrderDraft: OrderDraft = {
  side: 'BUY',
  orderType: 'MARKET',
  marginUsd: 10,
  leverage: 10,
  limitPrice: undefined,
  stopLoss: undefined,
  tp1: undefined,
  tp2: undefined,
  preview: null,
};

export const useUiStore = create<UiStoreState>((set) => ({
  orderDraft: defaultOrderDraft,
  isCooldownModalOpen: false,
  isScannerModalOpen: false,
  isTimeMachineModalOpen: false,
  isPillarScorecardModalOpen: false,
  isAudioMuted: false,
  activeBottomTab: 'POSITION',

  setOrderDraft: (partial) => {
    set((state) => ({
      orderDraft: {
        ...state.orderDraft,
        ...partial,
      },
    }));
  },

  resetOrderDraft: () => {
    set({ orderDraft: defaultOrderDraft });
  },

  setPreview: (preview) => {
    set((state) => ({
      orderDraft: {
        ...state.orderDraft,
        preview,
      },
    }));
  },

  setIsCooldownModalOpen: (open) => set({ isCooldownModalOpen: open }),
  setIsScannerModalOpen: (open) => set({ isScannerModalOpen: open }),
  setIsTimeMachineModalOpen: (open) => set({ isTimeMachineModalOpen: open }),
  setIsPillarScorecardModalOpen: (open) => set({ isPillarScorecardModalOpen: open }),
  toggleAudioMute: () => set((state) => ({ isAudioMuted: !state.isAudioMuted })),
  setActiveBottomTab: (tab) => set({ activeBottomTab: tab }),
}));
