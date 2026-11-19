/**
 * TradeOS v2 — Institutional Risk Engine & Guardrails
 * Enforces LiquidationGuard, 10% margin cap, dynamic drawdown, 15m cooldown,
 * and institutional statistical metrics (Kelly Criterion, MDD, Profit Factor).
 */

import { calculateLiquidationPrice } from '@tradeos/shared';
import type {
  OpenOrderRequest,
  AccountInfo,
  RiskStateRecord,
  TradeRecord,
} from '@tradeos/shared';

export interface RiskValidationResult {
  allowed: boolean;
  code?: string;
  reason?: string;
}

/**
 * Pre-Trade Risk Gatekeeper
 * Evaluates solvency, 15-minute anti-revenge cooldown, 10% margin cap,
 * session drawdown limits, and pre-trade Dead Stop-Loss Armor.
 */
export function validateOrderRisk(
  req: OpenOrderRequest,
  account: AccountInfo,
  riskState: RiskStateRecord,
  markPrice: number,
  now: number = Date.now()
): RiskValidationResult {
  // Gate 1: 15-minute Anti-Gambling / Anti-Revenge Cooldown Lock
  if (riskState.cooldown_until && now < riskState.cooldown_until) {
    const remainingSec = Math.ceil((riskState.cooldown_until - now) / 1000);
    return {
      allowed: false,
      code: 'ERR_COOLDOWN_ACTIVE',
      reason: `Anti-qumar 15 dəqiqəlik Cooldown kilidi aktivdir (${remainingSec}s qalıb). Səbəb: ${
        riskState.cooldown_reason || 'Revenge-trading qoruyucusu'
      }`,
    };
  }

  // Gate 2: Solvency Check
  if (!account || account.walletBalance <= 0) {
    return {
      allowed: false,
      code: 'ERR_INSUFFICIENT_FUNDS',
      reason: 'Cüzdan balansı kifayət deyil və ya hesab əlçatan deyil',
    };
  }

  // Gate 3: Mode-Aware Margin Cap
  // Auto-Pilot mode is strictly clamped to max 10.0% margin allocation
  // Discretionary Manual mode permits presets up to 50.0% of wallet balance
  const isAutoPilot = (req as any).isAutoPilot === true;
  const isExplicitManualExpanded =
    !isAutoPilot &&
    ((req.marginAllocationPct !== undefined && req.marginAllocationPct > 10) ||
      (req as any).isManual === true ||
      (req as any).executionMode === 'MANUAL');

  const maxMarginPct = isAutoPilot ? 0.10 : isExplicitManualExpanded ? 0.50 : 0.10;
  const maxMarginAllowed = Number((account.walletBalance * maxMarginPct).toFixed(2));
  if (req.marginUsd > maxMarginAllowed + 0.01) {
    return {
      allowed: false,
      code: 'ERR_MARGIN_CAP_EXCEEDED',
      reason: `Tələb olunan marja ($${req.marginUsd.toFixed(2)}) icazə verilən ${
        Math.round(maxMarginPct * 100)
      }% limitindən ($${maxMarginAllowed.toFixed(2)}) çoxdur`,
    };
  }

  // Gate 4: Dynamic Session Drawdown Limit: max($5, 3% of balance)
  const maxSessionDrawdown = Math.max(5.0, Number((account.walletBalance * 0.03).toFixed(2)));
  if (riskState.session_net_pnl <= -maxSessionDrawdown) {
    return {
      allowed: false,
      code: 'ERR_SESSION_DRAWDOWN_LIMIT',
      reason: `Sessiya zərəri (-$${Math.abs(riskState.session_net_pnl).toFixed(
        2
      )}) icazə verilən dinamik zərər limitindən (-$${maxSessionDrawdown.toFixed(2)}) çoxdur`,
    };
  }

  // Gate 5: Pre-Trade Dead Stop-Loss Armor (LiquidationGuard)
  const effectiveEntry =
    req.orderType === 'LIMIT' && req.limitPrice && req.limitPrice > 0
      ? req.limitPrice
      : markPrice;

  if (effectiveEntry > 0 && req.leverage > 0) {
    const estLiq = calculateLiquidationPrice(req.side, effectiveEntry, req.leverage);

    if (req.stopLoss && req.stopLoss > 0) {
      if (req.side === 'BUY' && req.stopLoss <= estLiq) {
        return {
          allowed: false,
          code: 'ERR_DEAD_STOP_LOSS',
          reason: `Pre-Trade Dead SL Armor: Long Stop-Loss ($${req.stopLoss}) likvidasiya qiymətini ($${estLiq.toFixed(
            2
          )}) aşıb!`,
        };
      }
      if (req.side === 'SELL' && req.stopLoss >= estLiq) {
        return {
          allowed: false,
          code: 'ERR_DEAD_STOP_LOSS',
          reason: `Pre-Trade Dead SL Armor: Short Stop-Loss ($${req.stopLoss}) likvidasiya qiymətini ($${estLiq.toFixed(
            2
          )}) aşıb!`,
        };
      }
    }
  }

  return { allowed: true };
}

/**
 * Updates risk state record after a closed trade fill.
 * Enforces 15m cooldown upon 2 consecutive losses or dynamic session drawdown breach.
 */
export function updateRiskStateOnTradeClose(
  trade: TradeRecord,
  currentRisk: RiskStateRecord,
  walletBalance: number,
  now: number = Date.now()
): RiskStateRecord {
  const netPnl = trade.realized_pnl - trade.fees_usd;
  const updatedSessionPnl = Number((currentRisk.session_net_pnl + netPnl).toFixed(4));

  let consecutiveLosses = currentRisk.consecutive_losses;
  if (netPnl < 0) {
    consecutiveLosses += 1;
  } else if (netPnl > 0) {
    consecutiveLosses = 0;
  }

  let cooldownUntil = currentRisk.cooldown_until;
  let cooldownReason = currentRisk.cooldown_reason;

  const maxSessionDrawdown = Math.max(5.0, Number((walletBalance * 0.03).toFixed(2)));

  // Trigger 15 min cooldown if 2 consecutive losses or max drawdown hit
  if (consecutiveLosses >= 2) {
    cooldownUntil = now + 15 * 60 * 1000;
    cooldownReason = '2_CONSECUTIVE_LOSSES';
  } else if (updatedSessionPnl <= -maxSessionDrawdown) {
    cooldownUntil = now + 15 * 60 * 1000;
    cooldownReason = 'MAX_DRAWDOWN_BREACH';
  }

  return {
    ...currentRisk,
    consecutive_losses: consecutiveLosses,
    cooldown_until: cooldownUntil,
    cooldown_reason: cooldownReason,
    session_net_pnl: updatedSessionPnl,
    updated_at: now,
  };
}

/**
 * Institutional Kelly Criterion Calculator
 * b = avgWin / avgLoss
 * K = (winRate - (1 - winRate) / b)
 * Returns Half-Kelly clamped between 0 and maxRiskCap (default 10%).
 */
export function calculateKellyCriterion(trades: TradeRecord[], maxRiskCap: number = 0.10): number {
  if (!trades || trades.length === 0) return 0;

  const wins: number[] = [];
  const losses: number[] = [];

  for (const t of trades) {
    const net = t.realized_pnl - t.fees_usd;
    if (net > 0) wins.push(net);
    else if (net < 0) losses.push(Math.abs(net));
  }

  if (wins.length === 0) return 0;
  const total = wins.length + losses.length;
  const winRate = wins.length / total;

  const avgWin = wins.reduce((a, b) => a + b, 0) / wins.length;
  const avgLoss = losses.length > 0 ? losses.reduce((a, b) => a + b, 0) / losses.length : 0;

  const b = avgLoss > 0 ? avgWin / avgLoss : 3.0;
  const k = b > 0 ? winRate - (1 - winRate) / b : 0;
  const halfKelly = Math.max(0, k) / 2;

  return Number(Math.min(halfKelly, maxRiskCap).toFixed(4));
}

/**
 * Maximum Drawdown (MDD) in Dollars
 */
export function calculateMaxDrawdown(trades: TradeRecord[], initialBalance: number = 100): number {
  if (!trades || trades.length === 0) return 0;

  let equity = initialBalance;
  let peak = equity;
  let maxDD = 0;

  for (const t of trades) {
    const net = t.realized_pnl - t.fees_usd;
    equity += net;
    if (equity > peak) {
      peak = equity;
    }
    const dd = peak - equity;
    if (dd > maxDD) {
      maxDD = dd;
    }
  }

  return Number(maxDD.toFixed(2));
}

/**
 * Profit Factor (PF) = Gross Profit / Gross Loss
 */
export function calculateProfitFactor(trades: TradeRecord[]): number {
  if (!trades || trades.length === 0) return 0;

  let grossProfit = 0;
  let grossLoss = 0;

  for (const t of trades) {
    const net = t.realized_pnl - t.fees_usd;
    if (net > 0) grossProfit += net;
    else if (net < 0) grossLoss += Math.abs(net);
  }

  if (grossLoss === 0) {
    return grossProfit > 0 ? 99.99 : 0;
  }

  return Number((grossProfit / grossLoss).toFixed(2));
}
