import { describe, it, expect } from 'vitest';
import {
  validateOrderRisk,
  updateRiskStateOnTradeClose,
  calculateKellyCriterion,
  calculateMaxDrawdown,
  calculateMaxDrawdownUsd,
  calculateProfitFactor,
} from '../riskEngine.js';
import { generateMentorBrief } from '../sokratMentor.js';
import type {
  AccountInfo,
  OpenOrderRequest,
  RiskStateRecord,
  TradeRecord,
} from '@tradeos/shared';

describe('TradeOS v2 — Risk Engine & Sokrat Mentor', () => {
  const baseAccount: AccountInfo = {
    walletBalance: 1000,
    equity: 1000,
    availableBalance: 1000,
    unrealizedPnl: 0,
    currency: 'USDT',
  };

  const baseRiskState: RiskStateRecord = {
    broker_mode: 'BINANCE_DEMO',
    consecutive_losses: 0,
    cooldown_until: 0,
    cooldown_reason: null,
    session_net_pnl: 0,
    session_started_at: 1700000000000,
    updated_at: 1700000000000,
  };

  const baseOrderReq: OpenOrderRequest = {
    symbol: 'SOLUSDT',
    side: 'BUY',
    orderType: 'MARKET',
    marginUsd: 50, // 5% of 1000 (well within 10% cap)
    leverage: 10,
    stopLoss: 95,
  };

  describe('validateOrderRisk', () => {
    it('blocks order when 15m cooldown is active', () => {
      const lockedState: RiskStateRecord = {
        ...baseRiskState,
        cooldown_until: Date.now() + 600000,
        cooldown_reason: '2_CONSECUTIVE_LOSSES',
      };
      const result = validateOrderRisk(baseOrderReq, baseAccount, lockedState, 100);
      expect(result.allowed).toBe(false);
      expect(result.code).toBe('ERR_COOLDOWN_ACTIVE');
      expect(result.reason).toContain('Anti-qumar 15 dəqiqəlik Cooldown');
    });

    it('blocks order when wallet balance is zero or insolvent', () => {
      const emptyAccount: AccountInfo = { ...baseAccount, walletBalance: 0 };
      const result = validateOrderRisk(baseOrderReq, emptyAccount, baseRiskState, 100);
      expect(result.allowed).toBe(false);
      expect(result.code).toBe('ERR_INSUFFICIENT_FUNDS');
    });

    it('enforces 10% hard margin cap of wallet balance', () => {
      // 10% of 1000 is 100. Requesting 150 should be rejected!
      const overMarginReq: OpenOrderRequest = {
        ...baseOrderReq,
        marginUsd: 150,
      };
      const result = validateOrderRisk(overMarginReq, baseAccount, baseRiskState, 100);
      expect(result.allowed).toBe(false);
      expect(result.code).toBe('ERR_MARGIN_CAP_EXCEEDED');

      // Requesting 100 should be allowed
      const exactMarginReq: OpenOrderRequest = {
        ...baseOrderReq,
        marginUsd: 100,
      };
      expect(validateOrderRisk(exactMarginReq, baseAccount, baseRiskState, 100).allowed).toBe(true);
    });

    it('enforces dynamic session drawdown limit: max($5, 3% of balance)', () => {
      // 3% of 1000 is $30
      const drawdownState: RiskStateRecord = {
        ...baseRiskState,
        session_net_pnl: -35.0, // Exceeded -$30!
      };
      const result = validateOrderRisk(baseOrderReq, baseAccount, drawdownState, 100);
      expect(result.allowed).toBe(false);
      expect(result.code).toBe('ERR_SESSION_DRAWDOWN_LIMIT');

      // On a small $100 balance, max($5, $3) is $5 minimum floor
      const smallAccount: AccountInfo = { ...baseAccount, walletBalance: 100 };
      const smallDdState: RiskStateRecord = { ...baseRiskState, session_net_pnl: -5.50 };
      const smallReq: OpenOrderRequest = { ...baseOrderReq, marginUsd: 5 };
      expect(validateOrderRisk(smallReq, smallAccount, smallDdState, 100).allowed).toBe(false);
    });

    it('rejects orders without a valid Stop-Loss (Fail-Closed Mandatory SL)', () => {
      const noSlReq: OpenOrderRequest = {
        ...baseOrderReq,
        stopLoss: undefined,
      };
      const res1 = validateOrderRisk(noSlReq, baseAccount, baseRiskState, 100);
      expect(res1.allowed).toBe(false);
      expect(res1.code).toBe('ERR_MISSING_STOP_LOSS');
      expect(res1.reason).toContain('Stop-Loss təyin edilməyib');

      const zeroSlReq: OpenOrderRequest = {
        ...baseOrderReq,
        stopLoss: 0,
      };
      const res2 = validateOrderRisk(zeroSlReq, baseAccount, baseRiskState, 100);
      expect(res2.allowed).toBe(false);
      expect(res2.code).toBe('ERR_MISSING_STOP_LOSS');
    });

    it('enforces Pre-Trade Dead Stop-Loss Armor for Long and Short', () => {
      // Entry 100, Lev 10 -> Long Liq is ~90.45
      const deadLongReq: OpenOrderRequest = {
        ...baseOrderReq,
        stopLoss: 89, // Below 90.45!
      };
      const longRes = validateOrderRisk(deadLongReq, baseAccount, baseRiskState, 100);
      expect(longRes.allowed).toBe(false);
      expect(longRes.code).toBe('ERR_DEAD_STOP_LOSS');

      // Entry 100, Lev 10 -> Short Liq is ~109.45
      const deadShortReq: OpenOrderRequest = {
        ...baseOrderReq,
        side: 'SELL',
        stopLoss: 110, // Above 109.45!
      };
      const shortRes = validateOrderRisk(deadShortReq, baseAccount, baseRiskState, 100);
      expect(shortRes.allowed).toBe(false);
      expect(shortRes.code).toBe('ERR_DEAD_STOP_LOSS');
    });

    it('allows valid order within all safety limits', () => {
      const result = validateOrderRisk(baseOrderReq, baseAccount, baseRiskState, 100);
      expect(result.allowed).toBe(true);
      expect(result.code).toBeUndefined();
    });
  });

  describe('updateRiskStateOnTradeClose', () => {
    function createMockTrade(pnl: number, fees: number = 0.5): TradeRecord {
      return {
        id: 'trade-uuid',
        symbol: 'SOLUSDT',
        broker_mode: 'BINANCE_DEMO',
        side: 'BUY',
        status: 'CLOSED',
        entry_price: 100,
        exit_price: 105,
        quantity: 1,
        remaining_qty: 0,
        leverage: 10,
        margin_usd: 10,
        stop_loss: 95,
        tp1: 110,
        tp2: 120,
        be_price: 100.15,
        is_breakeven: 0,
        client_order_id: 'tos_1_ent',
        client_sl_id: null,
        client_tp1_id: null,
        client_tp2_id: null,
        entry_order_id: '123',
        sl_algo_id: null,
        tp1_algo_id: null,
        tp2_algo_id: null,
        realized_pnl: pnl,
        fees_usd: fees,
        exit_reason: 'TAKE_PROFIT',
        opened_at: 1700000000000,
        closed_at: 1700000060000,
      };
    }

    it('increments consecutive losses on losing trade and resets on win', () => {
      const now = 1700000100000;
      // Loss 1
      const state1 = updateRiskStateOnTradeClose(createMockTrade(-10), baseRiskState, 1000, now);
      expect(state1.consecutive_losses).toBe(1);
      expect(state1.session_net_pnl).toBe(-10.5);
      expect(state1.cooldown_until).toBe(0);

      // Win resets consecutive losses
      const state2 = updateRiskStateOnTradeClose(createMockTrade(20), state1, 1000, now);
      expect(state2.consecutive_losses).toBe(0);
      expect(state2.session_net_pnl).toBe(9.0); // -10.5 + 19.5
    });

    it('triggers 15m cooldown when 2 consecutive losses occur', () => {
      const now = 1700000100000;
      const state1 = updateRiskStateOnTradeClose(createMockTrade(-5), baseRiskState, 1000, now);
      expect(state1.consecutive_losses).toBe(1);
      expect(state1.cooldown_until).toBe(0);

      const state2 = updateRiskStateOnTradeClose(createMockTrade(-5), state1, 1000, now);
      expect(state2.consecutive_losses).toBe(2);
      expect(state2.cooldown_until).toBe(now + 15 * 60 * 1000);
      expect(state2.cooldown_reason).toBe('2_CONSECUTIVE_LOSSES');
    });

    it('triggers 15m cooldown when max session drawdown is breached', () => {
      const now = 1700000100000;
      // Single massive loss of -$35 on $1000 account (3% is $30)
      const state = updateRiskStateOnTradeClose(createMockTrade(-35), baseRiskState, 1000, now);
      expect(state.cooldown_until).toBe(now + 15 * 60 * 1000);
      expect(state.cooldown_reason).toBe('MAX_DRAWDOWN_BREACH');
    });
  });

  describe('Institutional Statistics (Kelly, MDD, Profit Factor)', () => {
    function makeTrade(netPnl: number): TradeRecord {
      return {
        id: 't-1',
        symbol: 'SOLUSDT',
        broker_mode: 'BINANCE_DEMO',
        side: 'BUY',
        status: 'CLOSED',
        entry_price: 100,
        exit_price: 105,
        quantity: 1,
        remaining_qty: 0,
        leverage: 10,
        margin_usd: 10,
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
        realized_pnl: netPnl,
        fees_usd: 0,
        exit_reason: null,
        opened_at: 1700000000000,
        closed_at: 1700000060000,
      };
    }

    it('calculates Kelly Criterion correctly', () => {
      expect(calculateKellyCriterion([])).toBe(0);

      // 3 wins of $20, 1 loss of $10 -> winRate = 75%, avgWin = 20, avgLoss = 10, b = 2.0
      // K = 0.75 - (0.25 / 2.0) = 0.75 - 0.125 = 0.625. Half-Kelly = 0.3125, clamped to maxRiskCap 0.10
      const trades = [makeTrade(20), makeTrade(20), makeTrade(20), makeTrade(-10)];
      expect(calculateKellyCriterion(trades, 0.10)).toBe(0.10);

      // Clamped to 0 when negative edge (all losses)
      expect(calculateKellyCriterion([makeTrade(-10), makeTrade(-20)])).toBe(0);
    });

    it('calculates Maximum Drawdown (MDD) ratio and USD chronologically', () => {
      expect(calculateMaxDrawdown([])).toBe(0);
      expect(calculateMaxDrawdownUsd([])).toBe(0);

      // Equity starts at 100: +20 (120), -30 (90), +10 (100) -> Peak 120, Trough 90 -> MaxDD 30 (25% = 0.25)
      const trades = [makeTrade(20), makeTrade(-30), makeTrade(10)];
      expect(calculateMaxDrawdown(trades, 100)).toBe(0.25);
      expect(calculateMaxDrawdownUsd(trades)).toBe(30);
    });

    it('calculates Profit Factor (PF)', () => {
      expect(calculateProfitFactor([])).toBe(0);

      // Gross profit = 60, Gross loss = 20 -> PF = 3.0
      const trades = [makeTrade(30), makeTrade(30), makeTrade(-20)];
      expect(calculateProfitFactor(trades)).toBe(3.0);

      // All wins -> 99.99
      expect(calculateProfitFactor([makeTrade(10), makeTrade(20)])).toBe(99.99);

      // All losses -> 0
      expect(calculateProfitFactor([makeTrade(-10), makeTrade(-20)])).toBe(0);
    });
  });

  describe('sokratMentor', () => {
    it('returns LOCKOUT mode when cooldown is active', () => {
      const lockedState: RiskStateRecord = {
        ...baseRiskState,
        cooldown_until: Date.now() + 600000,
        cooldown_reason: '2_CONSECUTIVE_LOSSES',
      };
      const brief = generateMentorBrief({ markPrice: 100 }, lockedState);
      expect(brief.mode).toBe('LOCKOUT');
      expect(brief.riskScore).toBe(100);
      expect(brief.headlineAz).toContain('Soyuma Kilidi Aktivdir');
      expect(brief.adviceAz).toContain('Dayan, dostum və dərindən nəfəs al');
    });

    it('returns CAUTION mode on recent loss, negative PnL or extreme RSI', () => {
      const lossState: RiskStateRecord = {
        ...baseRiskState,
        consecutive_losses: 1,
      };
      const brief = generateMentorBrief({ markPrice: 100 }, lossState);
      expect(brief.mode).toBe('CAUTION');
      expect(brief.riskScore).toBe(65);
      expect(brief.headlineAz).toContain('Ehtiyatlı Ol');
    });

    it('returns AGGRESSIVE mode during strong trend and balanced RSI', () => {
      const marketState = {
        markPrice: 100,
        indicators: {
          adx14: { adx: 35, pdi: 28, mdi: 12 },
          rsi14: 55,
        } as any,
      };
      const brief = generateMentorBrief(marketState, baseRiskState);
      expect(brief.mode).toBe('AGGRESSIVE');
      expect(brief.headlineAz).toContain('Trend İstiqamətində Fürsət');
    });

    it('returns DISCIPLINE mode in calm balanced market', () => {
      const brief = generateMentorBrief({ markPrice: 100 }, baseRiskState);
      expect(brief.mode).toBe('DISCIPLINE');
      expect(brief.riskScore).toBe(25);
      expect(brief.headlineAz).toContain('İntizamlı Ticarət Rejimi');
    });
  });
});
