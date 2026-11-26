import { describe, it, expect, vi, beforeEach } from 'vitest';
import { initializeDatabase, TradesRepo, FillsRepo } from '../src/db/sqlite.js';
import { AutoPilotManager } from '../src/services/autoPilotManager.js';
import { TradeManager } from '../src/services/tradeManager.js';
import type { TradeRecord } from '@tradeos/shared';

describe('Emergency Stop-Loss & Risk Watchdog Hardening', () => {
  describe('AutoPilotManager Hardening', () => {
    it('immediately triggers emergency unwind with SL_PLACEMENT_FAILED_EMERGENCY_UNWIND when SL algo placement fails', async () => {
      const db = initializeDatabase(':memory:');
      const closePositionMock = vi.fn().mockResolvedValue({} as any);

      const chasingEngineMock = {
        chase: vi.fn().mockResolvedValue({
          orderId: 'chase-ord-1',
          status: 'FILLED',
          fillPrice: 100.0,
          fillQty: 10.0,
          amendCount: 1,
          feeSavedUsd: 0.05,
        }),
        setOnStateUpdate: vi.fn(),
        getState: vi.fn().mockReturnValue(null),
      };

      const manager = new AutoPilotManager({
        db,
        tradeManager: {
          closePosition: closePositionMock,
        } as any,
        broker: {
          mode: 'LOCAL_PAPER',
          getAccount: vi.fn().mockResolvedValue({ walletBalance: 1000, availableBalance: 1000 }),
          createAlgoOrder: vi.fn().mockRejectedValue(new Error('Exchange Algo Engine Timeout')),
        } as any,
        confluenceEngine: {
          getSnapshot: vi.fn().mockReturnValue({ compositeScore: 80 }),
          orderFlowEngine: { getBids: () => [], getAsks: () => [] },
          liquidationEngine: { projectClusters: () => [] },
        } as any,
        chasingExecutionEngine: chasingEngineMock as any,
        getMarkPrice: () => 100.0,
      });

      await (manager as any).executeAutoEntry('SOLUSDT', 'BUY', 100.0);

      expect(closePositionMock).toHaveBeenCalledTimes(1);
      expect(closePositionMock).toHaveBeenCalledWith('SOLUSDT', 'SL_PLACEMENT_FAILED_EMERGENCY_UNWIND');
      expect(manager.getState()).toBe('IDLE');
    });

    it('triggers emergency closing with WATCHDOG_STOP_LOSS when BUY position markPrice <= stop_loss', async () => {
      const db = initializeDatabase(':memory:');
      const tradesRepo = new TradesRepo(db);
      const closePositionMock = vi.fn().mockImplementation(async (sym, reason) => {
        tradesRepo.update('trade-buy-1', { status: 'CLOSED', exit_reason: reason });
      });

      const trade: TradeRecord = {
        id: 'trade-buy-1',
        symbol: 'SOLUSDT',
        broker_mode: 'LOCAL_PAPER',
        side: 'BUY',
        status: 'OPEN',
        entry_price: 100.0,
        exit_price: null,
        quantity: 1.0,
        remaining_qty: 1.0,
        leverage: 10,
        margin_usd: 10.0,
        stop_loss: 98.0,
        tp1: 103.0,
        tp2: 106.0,
        be_price: 100.15,
        is_breakeven: 0,
        peak_price: 100.0,
        peak_mfe: 0,
        trailing_stop_active: 0,
        client_order_id: 'tos_trade-buy-1_ent',
        client_sl_id: 'tos_trade-buy-1_sl',
        client_tp1_id: 'tos_trade-buy-1_tp1',
        client_tp2_id: 'tos_trade-buy-1_tp2',
        entry_order_id: 'trade-buy-1',
        sl_algo_id: 'sl-1',
        tp1_algo_id: 'tp1-1',
        tp2_algo_id: 'tp2-1',
        realized_pnl: 0,
        fees_usd: 0.2,
        exit_reason: null,
        opened_at: Date.now(),
        closed_at: null,
      };
      tradesRepo.insert(trade);

      const manager = new AutoPilotManager({
        db,
        tradeManager: {
          closePosition: closePositionMock,
        } as any,
        broker: {
          mode: 'LOCAL_PAPER',
          getAccount: vi.fn().mockResolvedValue({ walletBalance: 1000, availableBalance: 1000 }),
        } as any,
        confluenceEngine: {
          getSnapshot: vi.fn().mockReturnValue({ compositeScore: 50 }),
          economicEventGuard: { isBlackoutActive: () => ({ active: false }) },
        } as any,
        getMarkPrice: () => 97.5,
      });

      (manager as any).openTradeId = 'trade-buy-1';

      // Price is 97.5 <= SL 98.0
      await (manager as any).manageOpenPosition('SOLUSDT', 97.5);

      expect(closePositionMock).toHaveBeenCalledTimes(1);
      expect(closePositionMock).toHaveBeenCalledWith('SOLUSDT', 'WATCHDOG_STOP_LOSS');
      expect(manager.getState()).toBe('IDLE');
    });

    it('triggers emergency closing with WATCHDOG_STOP_LOSS when SELL position markPrice >= stop_loss', async () => {
      const db = initializeDatabase(':memory:');
      const tradesRepo = new TradesRepo(db);
      const closePositionMock = vi.fn().mockImplementation(async (sym, reason) => {
        tradesRepo.update('trade-sell-1', { status: 'CLOSED', exit_reason: reason });
      });

      const trade: TradeRecord = {
        id: 'trade-sell-1',
        symbol: 'SOLUSDT',
        broker_mode: 'LOCAL_PAPER',
        side: 'SELL',
        status: 'OPEN',
        entry_price: 100.0,
        exit_price: null,
        quantity: 1.0,
        remaining_qty: 1.0,
        leverage: 10,
        margin_usd: 10.0,
        stop_loss: 102.0,
        tp1: 97.0,
        tp2: 94.0,
        be_price: 99.85,
        is_breakeven: 0,
        peak_price: 100.0,
        peak_mfe: 0,
        trailing_stop_active: 0,
        client_order_id: 'tos_trade-sell-1_ent',
        client_sl_id: 'tos_trade-sell-1_sl',
        client_tp1_id: 'tos_trade-sell-1_tp1',
        client_tp2_id: 'tos_trade-sell-1_tp2',
        entry_order_id: 'trade-sell-1',
        sl_algo_id: 'sl-2',
        tp1_algo_id: 'tp1-2',
        tp2_algo_id: 'tp2-2',
        realized_pnl: 0,
        fees_usd: 0.2,
        exit_reason: null,
        opened_at: Date.now(),
        closed_at: null,
      };
      tradesRepo.insert(trade);

      const manager = new AutoPilotManager({
        db,
        tradeManager: {
          closePosition: closePositionMock,
        } as any,
        broker: {
          mode: 'LOCAL_PAPER',
          getAccount: vi.fn().mockResolvedValue({ walletBalance: 1000, availableBalance: 1000 }),
        } as any,
        confluenceEngine: {
          getSnapshot: vi.fn().mockReturnValue({ compositeScore: 50 }),
          economicEventGuard: { isBlackoutActive: () => ({ active: false }) },
        } as any,
        getMarkPrice: () => 102.5,
      });

      (manager as any).openTradeId = 'trade-sell-1';

      // Price is 102.5 >= SL 102.0
      await (manager as any).manageOpenPosition('SOLUSDT', 102.5);

      expect(closePositionMock).toHaveBeenCalledTimes(1);
      expect(closePositionMock).toHaveBeenCalledWith('SOLUSDT', 'WATCHDOG_STOP_LOSS');
      expect(manager.getState()).toBe('IDLE');
    });
  });

  describe('TradeManager handleOrderTradeUpdate Hardening', () => {
    it('updates realized_pnl and fees_usd on SL fill', async () => {
      const db = initializeDatabase(':memory:');
      const tradesRepo = new TradesRepo(db);

      const trade: TradeRecord = {
        id: 'trade-sl-fill',
        symbol: 'SOLUSDT',
        broker_mode: 'LOCAL_PAPER',
        side: 'BUY',
        status: 'OPEN',
        entry_price: 100.0,
        exit_price: null,
        quantity: 2.0,
        remaining_qty: 2.0,
        leverage: 10,
        margin_usd: 20.0,
        stop_loss: 98.0,
        tp1: 104.0,
        tp2: 108.0,
        be_price: 100.15,
        is_breakeven: 0,
        peak_price: 100.0,
        peak_mfe: 0,
        trailing_stop_active: 0,
        client_order_id: 'tos_trade-sl-fill_ent',
        client_sl_id: 'tos_trade-sl-fill_sl',
        client_tp1_id: 'tos_trade-sl-fill_tp1',
        client_tp2_id: 'tos_trade-sl-fill_tp2',
        entry_order_id: 'trade-sl-fill',
        sl_algo_id: 'sl-algo-1',
        tp1_algo_id: 'tp1-algo-1',
        tp2_algo_id: 'tp2-algo-1',
        realized_pnl: 0,
        fees_usd: 0.1,
        exit_reason: null,
        opened_at: Date.now(),
        closed_at: null,
      };
      tradesRepo.insert(trade);

      const tradeManager = new TradeManager({
        db,
        broker: {
          mode: 'LOCAL_PAPER',
          cancelOrder: vi.fn().mockResolvedValue({ success: true }),
        } as any,
        brokerMode: 'LOCAL_PAPER',
        getMarkPrice: () => 98.0,
      });

      // Simulate SL fill event: price = 98.0, qty = 2.0, commission = 0.05
      await tradeManager.handleOrderTradeUpdate({
        clientOrderId: 'tos_trade-sl-fill_sl',
        orderId: 'sl-algo-1',
        tradeId: 'fill-sl-1',
        lastFilledPrice: 98.0,
        lastFilledQty: 2.0,
        commission: 0.05,
        tradeTime: Date.now(),
      });

      const updated = tradesRepo.getById('trade-sl-fill')!;
      expect(updated.status).toBe('CLOSED');
      expect(updated.exit_reason).toBe('STOP_LOSS');
      // realizedPnl = (98 - 100) * 2 = -4.0, totalPnl = 0 + (-4.0) = -4.0
      expect(updated.realized_pnl).toBe(-4.0);
      // totalFees = 0.1 + 0.05 = 0.15
      expect(updated.fees_usd).toBe(0.15);
    });

    it('updates realized_pnl and fees_usd with BREAKEVEN_STOP on BE fill', async () => {
      const db = initializeDatabase(':memory:');
      const tradesRepo = new TradesRepo(db);

      const trade: TradeRecord = {
        id: 'trade-be-fill',
        symbol: 'SOLUSDT',
        broker_mode: 'LOCAL_PAPER',
        side: 'BUY',
        status: 'OPEN',
        entry_price: 100.0,
        exit_price: null,
        quantity: 2.0,
        remaining_qty: 2.0,
        leverage: 10,
        margin_usd: 20.0,
        stop_loss: 100.15,
        tp1: 104.0,
        tp2: 108.0,
        be_price: 100.15,
        is_breakeven: 1,
        peak_price: 102.0,
        peak_mfe: 2.0,
        trailing_stop_active: 0,
        client_order_id: 'tos_trade-be-fill_ent',
        client_sl_id: 'tos_trade-be-fill_be',
        client_tp1_id: 'tos_trade-be-fill_tp1',
        client_tp2_id: 'tos_trade-be-fill_tp2',
        entry_order_id: 'trade-be-fill',
        sl_algo_id: 'be-algo-1',
        tp1_algo_id: 'tp1-algo-1',
        tp2_algo_id: 'tp2-algo-1',
        realized_pnl: 0,
        fees_usd: 0.1,
        exit_reason: null,
        opened_at: Date.now(),
        closed_at: null,
      };
      tradesRepo.insert(trade);

      const tradeManager = new TradeManager({
        db,
        broker: {
          mode: 'LOCAL_PAPER',
          cancelOrder: vi.fn().mockResolvedValue({ success: true }),
        } as any,
        brokerMode: 'LOCAL_PAPER',
        getMarkPrice: () => 100.15,
      });

      // Simulate BE fill event: price = 100.15, qty = 2.0, commission = 0.05
      await tradeManager.handleOrderTradeUpdate({
        clientOrderId: 'tos_trade-be-fill_be',
        orderId: 'be-algo-1',
        tradeId: 'fill-be-1',
        lastFilledPrice: 100.15,
        lastFilledQty: 2.0,
        commission: 0.05,
        tradeTime: Date.now(),
      });

      const updated = tradesRepo.getById('trade-be-fill')!;
      expect(updated.status).toBe('CLOSED');
      expect(updated.exit_reason).toBe('BREAKEVEN_STOP');
      // realizedPnl = (100.15 - 100) * 2 = 0.30
      expect(updated.realized_pnl).toBe(0.3);
      // totalFees = 0.1 + 0.05 = 0.15
      expect(updated.fees_usd).toBe(0.15);
    });

    it('updates realized_pnl and fees_usd on TP1 partial fill and TP2 full close', async () => {
      const db = initializeDatabase(':memory:');
      const tradesRepo = new TradesRepo(db);

      const trade: TradeRecord = {
        id: 'trade-tp-fill',
        symbol: 'SOLUSDT',
        broker_mode: 'LOCAL_PAPER',
        side: 'BUY',
        status: 'OPEN',
        entry_price: 100.0,
        exit_price: null,
        quantity: 2.0,
        remaining_qty: 2.0,
        leverage: 10,
        margin_usd: 20.0,
        stop_loss: 98.0,
        tp1: 104.0,
        tp2: 108.0,
        be_price: 100.15,
        is_breakeven: 0,
        peak_price: 100.0,
        peak_mfe: 0,
        trailing_stop_active: 0,
        client_order_id: 'tos_trade-tp-fill_ent',
        client_sl_id: 'tos_trade-tp-fill_sl',
        client_tp1_id: 'tos_trade-tp-fill_tp1',
        client_tp2_id: 'tos_trade-tp-fill_tp2',
        entry_order_id: 'trade-tp-fill',
        sl_algo_id: 'sl-algo-1',
        tp1_algo_id: 'tp1-algo-1',
        tp2_algo_id: 'tp2-algo-1',
        realized_pnl: 0,
        fees_usd: 0.1,
        exit_reason: null,
        opened_at: Date.now(),
        closed_at: null,
      };
      tradesRepo.insert(trade);

      const tradeManager = new TradeManager({
        db,
        broker: {
          mode: 'LOCAL_PAPER',
          cancelOrder: vi.fn().mockResolvedValue({ success: true }),
          createAlgoOrder: vi.fn().mockResolvedValue({ algoId: 'sl-algo-2' }),
        } as any,
        brokerMode: 'LOCAL_PAPER',
        getMarkPrice: () => 104.0,
      });

      // 1. TP1 fills 1.0 @ 104.0 (PnL = (104 - 100) * 1 = 4.0, comm = 0.04)
      await tradeManager.handleOrderTradeUpdate({
        clientOrderId: 'tos_trade-tp-fill_tp1',
        orderId: 'tp1-algo-1',
        tradeId: 'fill-tp1-1',
        lastFilledPrice: 104.0,
        lastFilledQty: 1.0,
        commission: 0.04,
        tradeTime: Date.now(),
      });

      let current = tradesRepo.getById('trade-tp-fill')!;
      expect(current.status).toBe('PARTIALLY_CLOSED');
      expect(current.remaining_qty).toBe(1.0);
      expect(current.realized_pnl).toBe(4.0);
      expect(current.fees_usd).toBe(0.14);

      // 2. TP2 fills remaining 1.0 @ 108.0 (PnL = (108 - 100) * 1 = 8.0, comm = 0.04)
      await tradeManager.handleOrderTradeUpdate({
        clientOrderId: 'tos_trade-tp-fill_tp2',
        orderId: 'tp2-algo-1',
        tradeId: 'fill-tp2-1',
        lastFilledPrice: 108.0,
        lastFilledQty: 1.0,
        commission: 0.04,
        tradeTime: Date.now(),
      });

      current = tradesRepo.getById('trade-tp-fill')!;
      expect(current.status).toBe('CLOSED');
      expect(current.exit_reason).toBe('TAKE_PROFIT_2');
      expect(current.remaining_qty).toBe(0);
      // total PnL = 4.0 + 8.0 = 12.0
      expect(current.realized_pnl).toBe(12.0);
      // total Fees = 0.14 + 0.04 = 0.18
      expect(current.fees_usd).toBe(0.18);
    });
  });
});
