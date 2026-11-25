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
export type RightRailTabType = 'ORDER_TICKET' | 'TELEMETRY';
export type WorkspaceViewType = 'TRADING' | 'PROPFIRM' | 'QUANT';

const WORKSPACE_VIEW_STORAGE_KEY = 'tradeos_workspace_view';

function isValidWorkspaceView(value: unknown): value is WorkspaceViewType {
  return value === 'TRADING' || value === 'PROPFIRM' || value === 'QUANT';
}

function readInitialWorkspaceView(): WorkspaceViewType {
  try {
    const stored = sessionStorage.getItem(WORKSPACE_VIEW_STORAGE_KEY);
    if (isValidWorkspaceView(stored)) {
      return stored;
    }
  } catch {
    // Ignore sessionStorage read failures in restricted environments
  }
  return 'TRADING';
}

export interface UiStoreState {
  orderDraft: OrderDraft;
  isCooldownModalOpen: boolean;
  isScannerModalOpen: boolean;
  isTimeMachineModalOpen: boolean;
  isPillarScorecardModalOpen: boolean;
  isPnlModalOpen: boolean;
  isAudioMuted: boolean;
  activeBottomTab: BottomTabType;
  rightRailTab: RightRailTabType;
  isBottomExpanded: boolean;
  activeWorkspaceView: WorkspaceViewType;

  // Actions
  setOrderDraft: (draft: Partial<OrderDraft>) => void;
  resetOrderDraft: () => void;
  setPreview: (preview: OrderPreviewResponse | null) => void;
  setIsCooldownModalOpen: (open: boolean) => void;
  setIsScannerModalOpen: (open: boolean) => void;
  setIsTimeMachineModalOpen: (open: boolean) => void;
  setIsPillarScorecardModalOpen: (open: boolean) => void;
  setIsPnlModalOpen: (open: boolean) => void;
  toggleAudioMute: () => void;
  setActiveBottomTab: (tab: BottomTabType) => void;
  setRightRailTab: (tab: RightRailTabType) => void;
  toggleBottomExpanded: () => void;
  setIsBottomExpanded: (expanded: boolean) => void;
  setActiveWorkspaceView: (view: WorkspaceViewType) => void;
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
  isPnlModalOpen: false,
  isAudioMuted: false,
  activeBottomTab: 'POSITION',
  rightRailTab: 'ORDER_TICKET',
  isBottomExpanded: false,
  activeWorkspaceView: readInitialWorkspaceView(),

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
  setIsPnlModalOpen: (open) => set({ isPnlModalOpen: open }),
  toggleAudioMute: () => set((state) => ({ isAudioMuted: !state.isAudioMuted })),
  setActiveBottomTab: (tab) => set({ activeBottomTab: tab }),
  setRightRailTab: (tab) => set({ rightRailTab: tab }),
  toggleBottomExpanded: () => set((state) => ({ isBottomExpanded: !state.isBottomExpanded })),
  setIsBottomExpanded: (expanded) => set({ isBottomExpanded: expanded }),
  setActiveWorkspaceView: (view) => {
    const validView: WorkspaceViewType = isValidWorkspaceView(view) ? view : 'TRADING';
    set({ activeWorkspaceView: validView });
    try {
      sessionStorage.setItem(WORKSPACE_VIEW_STORAGE_KEY, validView);
    } catch {
      // Ignore sessionStorage write failures in restricted environments
    }
  },
}));
