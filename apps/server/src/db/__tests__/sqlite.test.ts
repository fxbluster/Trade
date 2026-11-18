import { describe, it, expect, beforeEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import {
  initializeDatabase,
  runTransaction,
  TradesRepo,
  FillsRepo,
  RiskStateRepo,
  SettingsRepo,
  AuditLogRepo
} from '../sqlite.js';
import type { TradeRecord, FillRecord, RiskStateRecord } from '@tradeos/shared';

describe('SQLite WAL Database Engine & Repositories', () => {
  let db: DatabaseSync;
  let tradesRepo: TradesRepo;
  let fillsRepo: FillsRepo;
  let riskRepo: RiskStateRepo;
  let settingsRepo: SettingsRepo;
  let auditRepo: AuditLogRepo;

  beforeEach(() => {
    db = initializeDatabase(':memory:');
    tradesRepo = new TradesRepo(db);
    fillsRepo = new FillsRepo(db);
    riskRepo = new RiskStateRepo(db);
    settingsRepo = new SettingsRepo(db);
    auditRepo = new AuditLogRepo(db);
  });

  describe('Database Initialization & Seeds', () => {
    it('seeds initial risk state for BINANCE_DEMO and LOCAL_PAPER', () => {
      const demoRisk = riskRepo.get('BINANCE_DEMO');
      const paperRisk = riskRepo.get('LOCAL_PAPER');

      expect(demoRisk).not.toBeNull();
      expect(demoRisk?.broker_mode).toBe('BINANCE_DEMO');
      expect(demoRisk?.consecutive_losses).toBe(0);
      expect(demoRisk?.session_net_pnl).toBe(0);

      expect(paperRisk).not.toBeNull();
      expect(paperRisk?.broker_mode).toBe('LOCAL_PAPER');
      expect(paperRisk?.consecutive_losses).toBe(0);
      expect(paperRisk?.session_net_pnl).toBe(0);
    });

    it('seeds initial paper wallet balance ($10,000 USDT)', () => {
      const paperWallet = settingsRepo.get<{ balance: number; currency: string }>('paper_wallet_balance');
      expect(paperWallet).not.toBeNull();
      expect(paperWallet?.balance).toBe(10000.0);
      expect(paperWallet?.currency).toBe('USDT');
    });
  });

  describe('Trades & Fills with Foreign Key Cascading', () => {
    it('inserts, updates partial fill status, remaining_qty and closes trade', () => {
      const tradeId = 'trade-uuid-1';
      const initialTrade: TradeRecord = {
        id: tradeId,
        symbol: 'SOLUSDT',
        broker_mode: 'BINANCE_DEMO',
        side: 'BUY',
        status: 'OPEN',
        entry_price: 150.0,
        exit_price: null,
        quantity: 10.0,
        remaining_qty: 10.0,
        leverage: 5,
        margin_usd: 300.0,
        stop_loss: 145.0,
        tp1: 160.0,
        tp2: 170.0,
        be_price: null,
        is_breakeven: 0,
        client_order_id: `tos_${tradeId}_ent`,
        client_sl_id: `tos_${tradeId}_sl`,
        client_tp1_id: `tos_${tradeId}_tp1`,
        client_tp2_id: `tos_${tradeId}_tp2`,
        entry_order_id: '123456',
        sl_algo_id: 'algo-sl-1',
        tp1_algo_id: 'algo-tp1-1',
        tp2_algo_id: 'algo-tp2-1',
        realized_pnl: 0,
        fees_usd: 0.75,
        exit_reason: null,
        opened_at: Date.now(),
        closed_at: null
      };

      tradesRepo.insert(initialTrade);

      // Verify active position retrieval
      let active = tradesRepo.getActivePosition('BINANCE_DEMO', 'SOLUSDT');
      expect(active).not.toBeNull();
      expect(active?.id).toBe(tradeId);
      expect(active?.status).toBe('OPEN');

      // Partial fill at TP1: status -> PARTIALLY_CLOSED, remaining_qty -> 5.0
      tradesRepo.update(tradeId, {
        status: 'PARTIALLY_CLOSED',
        remaining_qty: 5.0,
        realized_pnl: 50.0
      });

      let updated = tradesRepo.getById(tradeId);
      expect(updated?.status).toBe('PARTIALLY_CLOSED');
      expect(updated?.remaining_qty).toBe(5.0);
      expect(updated?.realized_pnl).toBe(50.0);

      // Final close at TP2
      tradesRepo.update(tradeId, {
        status: 'CLOSED',
        remaining_qty: 0,
        exit_price: 170.0,
        realized_pnl: 150.0,
        exit_reason: 'TP2_HIT',
        closed_at: Date.now()
      });

      const closed = tradesRepo.getById(tradeId);
      expect(closed?.status).toBe('CLOSED');
      expect(closed?.remaining_qty).toBe(0);
      expect(closed?.exit_reason).toBe('TP2_HIT');

      // Should no longer be active
      active = tradesRepo.getActivePosition('BINANCE_DEMO', 'SOLUSDT');
      expect(active).toBeNull();

      // Should appear in closed list
      const closedList = tradesRepo.listClosed('BINANCE_DEMO');
      expect(closedList.length).toBe(1);
      expect(closedList[0]?.id).toBe(tradeId);
      expect(tradesRepo.countClosed('BINANCE_DEMO')).toBe(1);
    });

    it('cascades deletion of trade to all linked fills', () => {
      const tradeId = 'trade-uuid-2';
      const trade: TradeRecord = {
        id: tradeId,
        symbol: 'BTCUSDT',
        broker_mode: 'BINANCE_DEMO',
        side: 'SELL',
        status: 'OPEN',
        entry_price: 90000.0,
        exit_price: null,
        quantity: 0.1,
        remaining_qty: 0.1,
        leverage: 10,
        margin_usd: 900.0,
        stop_loss: 92000.0,
        tp1: 88000.0,
        tp2: 85000.0,
        be_price: null,
        is_breakeven: 0,
        client_order_id: `tos_${tradeId}_ent`,
        client_sl_id: null,
        client_tp1_id: null,
        client_tp2_id: null,
        entry_order_id: 'ord-101',
        sl_algo_id: null,
        tp1_algo_id: null,
        tp2_algo_id: null,
        realized_pnl: 0,
        fees_usd: 1.2,
        exit_reason: null,
        opened_at: Date.now(),
        closed_at: null
      };

      tradesRepo.insert(trade);

      const fill1: FillRecord = {
        binance_trade_id: 'fill-001',
        trade_id: tradeId,
        order_id: 'ord-101',
        symbol: 'BTCUSDT',
        side: 'SELL',
        price: 90000.0,
        qty: 0.05,
        realized_pnl: 0,
        commission: 0.6,
        commission_asset: 'USDT',
        filled_at: Date.now()
      };

      const fill2: FillRecord = {
        binance_trade_id: 'fill-002',
        trade_id: tradeId,
        order_id: 'ord-101',
        symbol: 'BTCUSDT',
        side: 'SELL',
        price: 90000.0,
        qty: 0.05,
        realized_pnl: 0,
        commission: 0.6,
        commission_asset: 'USDT',
        filled_at: Date.now() + 100
      };

      fillsRepo.insert(fill1);
      fillsRepo.insert(fill2);

      expect(fillsRepo.getByTradeId(tradeId).length).toBe(2);
      expect(fillsRepo.exists('fill-001')).toBe(true);

      // Deleting the trade must cascade-delete both fills
      db.prepare('DELETE FROM trades WHERE id = ?').run(tradeId);

      expect(tradesRepo.getById(tradeId)).toBeNull();
      expect(fillsRepo.getByTradeId(tradeId).length).toBe(0);
      expect(fillsRepo.exists('fill-001')).toBe(false);
    });

    it('rejects duplicate binance_trade_id in fills', () => {
      const tradeId = 'trade-uuid-3';
      tradesRepo.insert({
        id: tradeId,
        symbol: 'ETHUSDT',
        broker_mode: 'LOCAL_PAPER',
        side: 'BUY',
        status: 'OPEN',
        entry_price: 3000.0,
        exit_price: null,
        quantity: 1.0,
        remaining_qty: 1.0,
        leverage: 5,
        margin_usd: 600.0,
        stop_loss: null,
        tp1: null,
        tp2: null,
        be_price: null,
        is_breakeven: 0,
        client_order_id: null,
        client_sl_id: null,
        client_tp1_id: null,
        client_tp2_id: null,
        entry_order_id: null,
        sl_algo_id: null,
        tp1_algo_id: null,
        tp2_algo_id: null,
        realized_pnl: 0,
        fees_usd: 0,
        exit_reason: null,
        opened_at: Date.now(),
        closed_at: null
      });

      const fill: FillRecord = {
        binance_trade_id: 'dup-fill-1',
        trade_id: tradeId,
        order_id: 'ord-201',
        symbol: 'ETHUSDT',
        side: 'BUY',
        price: 3000.0,
        qty: 1.0,
        realized_pnl: 0,
        commission: 0.3,
        commission_asset: 'USDT',
        filled_at: Date.now()
      };

      fillsRepo.insert(fill);

      expect(() => {
        fillsRepo.insert(fill);
      }).toThrow();
    });
  });

  describe('Transactions & Rollback', () => {
    it('rolls back all atomic mutations inside runTransaction on throw', () => {
      const tradeId = 'rollback-trade-1';

      expect(() => {
        runTransaction(db, () => {
          tradesRepo.insert({
            id: tradeId,
            symbol: 'SOLUSDT',
            broker_mode: 'BINANCE_DEMO',
            side: 'BUY',
            status: 'OPEN',
            entry_price: 150.0,
            exit_price: null,
            quantity: 1.0,
            remaining_qty: 1.0,
            leverage: 5,
            margin_usd: 30.0,
            stop_loss: null,
            tp1: null,
            tp2: null,
            be_price: null,
            is_breakeven: 0,
            client_order_id: null,
            client_sl_id: null,
            client_tp1_id: null,
            client_tp2_id: null,
            entry_order_id: null,
            sl_algo_id: null,
            tp1_algo_id: null,
            tp2_algo_id: null,
            realized_pnl: 0,
            fees_usd: 0,
            exit_reason: null,
            opened_at: Date.now(),
            closed_at: null
          });

          // Simulate unexpected error during execution
          throw new Error('Simulated bracket placement failure');
        });
      }).toThrow('Simulated bracket placement failure');

      // The trade record should NOT exist after rollback
      expect(tradesRepo.getById(tradeId)).toBeNull();
    });

    it('commits state when runTransaction completes successfully', () => {
      const tradeId = 'commit-trade-1';

      const result = runTransaction(db, () => {
        tradesRepo.insert({
          id: tradeId,
          symbol: 'SOLUSDT',
          broker_mode: 'BINANCE_DEMO',
          side: 'BUY',
          status: 'OPEN',
          entry_price: 150.0,
          exit_price: null,
          quantity: 1.0,
          remaining_qty: 1.0,
          leverage: 5,
          margin_usd: 30.0,
          stop_loss: null,
          tp1: null,
          tp2: null,
          be_price: null,
          is_breakeven: 0,
          client_order_id: null,
          client_sl_id: null,
          client_tp1_id: null,
          client_tp2_id: null,
          entry_order_id: null,
          sl_algo_id: null,
          tp1_algo_id: null,
          tp2_algo_id: null,
          realized_pnl: 0,
          fees_usd: 0,
          exit_reason: null,
          opened_at: Date.now(),
          closed_at: null
        });
        return 'SUCCESS';
      });

      expect(result).toBe('SUCCESS');
      expect(tradesRepo.getById(tradeId)).not.toBeNull();
    });
  });

  describe('Risk State Partitioning by BrokerMode', () => {
    it('isolates BINANCE_DEMO and LOCAL_PAPER risk states completely', () => {
      const now = Date.now();
      const demoUpdate: RiskStateRecord = {
        broker_mode: 'BINANCE_DEMO',
        consecutive_losses: 2,
        cooldown_until: now + 900000, // 15 mins cooldown
        cooldown_reason: '2_CONSECUTIVE_LOSSES',
        session_net_pnl: -45.5,
        session_started_at: now - 3600000,
        updated_at: now
      };

      riskRepo.update(demoUpdate);

      // Verify BINANCE_DEMO is locked
      const demoState = riskRepo.get('BINANCE_DEMO');
      expect(demoState?.consecutive_losses).toBe(2);
      expect(demoState?.cooldown_reason).toBe('2_CONSECUTIVE_LOSSES');
      expect(demoState?.session_net_pnl).toBe(-45.5);

      // Verify LOCAL_PAPER was unaffected
      const paperState = riskRepo.get('LOCAL_PAPER');
      expect(paperState?.consecutive_losses).toBe(0);
      expect(paperState?.cooldown_until).toBe(0);
      expect(paperState?.cooldown_reason).toBeNull();
      expect(paperState?.session_net_pnl).toBe(0.0);

      // Reset demo session
      riskRepo.resetSession('BINANCE_DEMO');
      const resetDemo = riskRepo.get('BINANCE_DEMO');
      expect(resetDemo?.consecutive_losses).toBe(0);
      expect(resetDemo?.cooldown_until).toBe(0);
      expect(resetDemo?.cooldown_reason).toBeNull();
      expect(resetDemo?.session_net_pnl).toBe(0.0);
    });
  });

  describe('Settings & Audit Log', () => {
    it('stores and retrieves settings objects seamlessly', () => {
      settingsRepo.set('paper_wallet_balance', { balance: 12500.75, currency: 'USDT' });
      const retrieved = settingsRepo.get<{ balance: number; currency: string }>('paper_wallet_balance');
      expect(retrieved?.balance).toBe(12500.75);
      expect(retrieved?.currency).toBe('USDT');

      // Non-existent key returns null
      expect(settingsRepo.get('non_existent')).toBeNull();
    });

    it('inserts and retrieves recent audit log entries', () => {
      const now = Date.now();
      auditRepo.insert({
        id: 'audit-1',
        event_type: 'COOLDOWN_BYPASS',
        actor: 'USER',
        reason: 'Market condition changed, user override requested',
        payload_json: JSON.stringify({ previousCooldown: now + 600000 }),
        created_at: now
      });

      const list = auditRepo.listRecent(10);
      expect(list.length).toBe(1);
      expect(list[0]?.event_type).toBe('COOLDOWN_BYPASS');
      expect(list[0]?.reason).toContain('user override');
    });
  });
});
