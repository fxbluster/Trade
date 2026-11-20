/**
 * TradeOS v2 — Shared Mathematical & Liquidation Calculation Engine
 * Pure mathematical functions for precision-safe sizing, asymmetric liquidation,
 * Breakeven calculation, and pre-trade order previews.
 */

import type {
  ConfluencePillarId,
  OpenOrderRequest,
  OrderPreviewResponse,
  PillarEvaluation,
  TradeSide,
} from './contracts.js';

/**
 * Returns the decimal precision (number of decimal places) for a given step/tick size.
 * Handles scientific notation (e.g. 1e-5) safely.
 */
export function getPrecision(step: number): number {
  if (!Number.isFinite(step) || step <= 0) return 0;
  const str = step.toString();
  if (str.includes('e-')) {
    const parts = str.split('e-');
    return parseInt(parts[1] || '0', 10);
  }
  const parts = str.split('.');
  return parts[1] ? parts[1].length : 0;
}

/**
 * Format order quantity to the given step size with floating-point safe truncation/rounding.
 * Uses flooring with epsilon to ensure allocated margin budget is never exceeded on exchange.
 *
 * @param qty Raw quantity
 * @param stepSize Exchange LOT_SIZE step size (e.g. 0.001, 0.01, 1)
 * @param mode Optional 'floor' (default) or 'round'
 */
export function formatByStepSize(
  qty: number,
  stepSize: number,
  mode: 'floor' | 'round' = 'floor'
): number {
  if (!Number.isFinite(qty) || qty <= 0) return 0;
  if (!Number.isFinite(stepSize) || stepSize <= 0) return qty;

  const precision = getPrecision(stepSize);
  const steps = mode === 'round'
    ? Math.round(qty / stepSize)
    : Math.floor(qty / stepSize + 1e-9);

  const formatted = steps * stepSize;
  return Number(formatted.toFixed(precision));
}

/**
 * Format price according to exchange tickSize rules.
 * Uses floating-point safe nearest-tick rounding.
 *
 * @param price Raw price
 * @param tickSize Exchange PRICE_FILTER tick size (e.g. 0.1, 0.01, 0.0001)
 */
export function formatByTickSize(price: number, tickSize: number): number {
  if (!Number.isFinite(price) || price <= 0) return 0;
  if (!Number.isFinite(tickSize) || tickSize <= 0) return price;

  const precision = getPrecision(tickSize);
  const steps = Math.round(price / tickSize);
  const formatted = steps * tickSize;
  return Number(formatted.toFixed(precision));
}

/**
 * Calculate isolated liquidation price for Long or Short positions.
 *
 * Long formula:  P_entry * (1 - 1/L) / (1 - MMR)
 * Short formula: P_entry * (1 + 1/L) / (1 + MMR)
 *
 * @param side Trade direction ('BUY' for Long, 'SELL' for Short)
 * @param entryPrice Position entry price
 * @param leverage Leverage multiplier (clamped to >= 1)
 * @param mmr Maintenance margin rate (default 0.005 for 0.5% MMR)
 */
export function calculateLiquidationPrice(
  side: TradeSide | 'BUY' | 'SELL' | 'LONG' | 'SHORT',
  entryPrice: number,
  leverage: number,
  mmr: number = 0.005
): number {
  if (!Number.isFinite(entryPrice) || entryPrice <= 0) return 0;
  const lev = Math.max(1, leverage);
  const m = Number.isFinite(mmr) && mmr >= 0 ? mmr : 0.005;

  const isShort = side === 'SELL' || (side as string) === 'SHORT';

  if (isShort) {
    return (entryPrice * (1 + 1 / lev)) / (1 + m);
  } else {
    if (m >= 1) return 0;
    const liq = (entryPrice * (1 - 1 / lev)) / (1 - m);
    return Math.max(0, liq);
  }
}

/**
 * Computes pre-trade order preview metrics including quantity quantization,
 * notional value, liquidation price, Dead-SL safety check, R:R ratio,
 * max loss USD, and Breakeven price (+- 0.15% fee buffer).
 *
 * @param req Open order request specifications
 * @param markPrice Current market mark price
 * @param tickSize Symbol price tick size
 * @param stepSize Symbol quantity step size
 * @param mmr Optional maintenance margin rate (default 0.005)
 */
export function computeOrderPreview(
  req: OpenOrderRequest,
  markPrice: number,
  tickSize: number,
  stepSize: number,
  mmr: number = 0.005
): OrderPreviewResponse {
  // Determine effective entry price based on order type
  const rawEntry = (req.orderType === 'LIMIT' && req.limitPrice && req.limitPrice > 0)
    ? req.limitPrice
    : markPrice;

  const entryPrice = formatByTickSize(rawEntry, tickSize);

  if (entryPrice <= 0 || req.marginUsd <= 0 || req.leverage <= 0) {
    return {
      quantity: 0,
      notionalUsd: 0,
      estimatedLiquidation: 0,
      deadSlSafe: true,
      rrRatio: 0,
      maxLossUsd: 0,
      breakevenPrice: 0,
    };
  }

  // Calculate notional and quantity
  const targetNotional = req.marginUsd * req.leverage;
  const rawQty = targetNotional / entryPrice;
  const quantity = formatByStepSize(rawQty, stepSize);
  const notionalUsd = Number((quantity * entryPrice).toFixed(2));

  // Liquidation price calculation formatted to tickSize
  const rawLiq = calculateLiquidationPrice(req.side, entryPrice, req.leverage, mmr);
  const estimatedLiquidation = formatByTickSize(rawLiq, tickSize);

  // Dead Stop-Loss Armor:
  // Stop Loss is strictly mandatory: if omitted, null, or <= 0, deadSlSafe is FALSE.
  // For Long: SL must be strictly above estimated liquidation price.
  // For Short: SL must be strictly below estimated liquidation price.
  const hasStopLoss = typeof req.stopLoss === 'number' && req.stopLoss > 0;
  let deadSlSafe = false;
  if (hasStopLoss) {
    if (req.side === 'BUY') {
      deadSlSafe = req.stopLoss! > estimatedLiquidation;
    } else {
      deadSlSafe = req.stopLoss! < estimatedLiquidation;
    }
  }

  // Breakeven price calculation (+- 0.15% fee & slippage buffer)
  // Long needs higher price to cover fees: entry * (1 + 0.0015)
  // Short needs lower price to cover fees: entry * (1 - 0.0015)
  const beBuffer = 0.0015;
  const rawBe = req.side === 'BUY'
    ? entryPrice * (1 + beBuffer)
    : entryPrice * (1 - beBuffer);
  const breakevenPrice = formatByTickSize(rawBe, tickSize);

  // Max Loss calculation in USD
  let maxLossUsd = req.marginUsd;
  if (req.stopLoss && req.stopLoss > 0 && quantity > 0) {
    const slDiff = req.side === 'BUY'
      ? entryPrice - req.stopLoss
      : req.stopLoss - entryPrice;
    maxLossUsd = Number((Math.max(0, slDiff) * quantity).toFixed(2));
  } else {
    maxLossUsd = Number(req.marginUsd.toFixed(2));
  }

  // Risk:Reward ratio calculation (Reward / Risk)
  let rrRatio = 0;
  const targetTp = req.tp1 ?? req.tp2;
  if (targetTp && targetTp > 0 && req.stopLoss && req.stopLoss > 0) {
    const tpDist = req.side === 'BUY'
      ? targetTp - entryPrice
      : entryPrice - targetTp;
    const slDist = req.side === 'BUY'
      ? entryPrice - req.stopLoss
      : req.stopLoss - entryPrice;

    if (tpDist > 0 && slDist > 0) {
      rrRatio = Number((tpDist / slDist).toFixed(2));
    }
  }

  return {
    quantity,
    notionalUsd,
    estimatedLiquidation,
    deadSlSafe,
    rrRatio,
    maxLossUsd,
    breakevenPrice,
  };
}

/**
 * Exact institutional weighting table for the 7 confluence pillars:
 * - MTF_TREND: 20%
 * - MOMENTUM: 15%
 * - ORDER_FLOW: 20%
 * - CVD: 15%
 * - LIQ_MAGNET: 10%
 * - NLP_NEWS: 10%
 * - PINE_SMC: 10%
 */
export const CONFLUENCE_WEIGHTS: Record<ConfluencePillarId, number> = {
  MTF_TREND: 0.20,
  MOMENTUM: 0.15,
  ORDER_FLOW: 0.20,
  CVD: 0.15,
  LIQ_MAGNET: 0.10,
  NLP_NEWS: 0.10,
  PINE_SMC: 0.10,
};

/**
 * Calculates 7-pillar composite confluence score, directional consensus bias,
 * and actionable recommendation according to the institutional weighting matrix.
 *
 * Threshold matrix:
 * - compositeScore >= 85: STRONG_BUY / STRONG_SELL
 * - compositeScore >= 65: BUY / SELL
 * - compositeScore < 65: GÖZLƏ
 */
export function calculateCompositeConfluenceScore(pillars: PillarEvaluation[]): {
  compositeScore: number;
  bias: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
  recommendedAction: 'STRONG_BUY' | 'BUY' | 'GÖZLƏ' | 'SELL' | 'STRONG_SELL';
} {
  if (!pillars || pillars.length === 0) {
    return {
      compositeScore: 0,
      bias: 'NEUTRAL',
      recommendedAction: 'GÖZLƏ',
    };
  }

  let bullishWeighted = 0;
  let bearishWeighted = 0;

  for (const pillar of pillars) {
    const weight = CONFLUENCE_WEIGHTS[pillar.id] ?? 0;
    const score = Number.isFinite(pillar.score) ? Math.max(0, Math.min(100, pillar.score)) : 0;

    if (pillar.bias === 'BULLISH') {
      bullishWeighted += weight * score;
    } else if (pillar.bias === 'BEARISH') {
      bearishWeighted += weight * score;
    }
  }

  const roundedBullish = Number(bullishWeighted.toFixed(2));
  const roundedBearish = Number(bearishWeighted.toFixed(2));

  let bias: 'BULLISH' | 'BEARISH' | 'NEUTRAL' = 'NEUTRAL';
  let compositeScore = 0;

  if (roundedBullish > roundedBearish) {
    bias = 'BULLISH';
    compositeScore = Math.round(roundedBullish);
  } else if (roundedBearish > roundedBullish) {
    bias = 'BEARISH';
    compositeScore = Math.round(roundedBearish);
  } else {
    bias = 'NEUTRAL';
    compositeScore = Math.round(roundedBullish);
  }

  let recommendedAction: 'STRONG_BUY' | 'BUY' | 'GÖZLƏ' | 'SELL' | 'STRONG_SELL' = 'GÖZLƏ';

  if (bias === 'BULLISH') {
    if (compositeScore >= 85) {
      recommendedAction = 'STRONG_BUY';
    } else if (compositeScore >= 65) {
      recommendedAction = 'BUY';
    } else {
      recommendedAction = 'GÖZLƏ';
    }
  } else if (bias === 'BEARISH') {
    if (compositeScore >= 85) {
      recommendedAction = 'STRONG_SELL';
    } else if (compositeScore >= 65) {
      recommendedAction = 'SELL';
    } else {
      recommendedAction = 'GÖZLƏ';
    }
  } else {
    recommendedAction = 'GÖZLƏ';
  }

  return {
    compositeScore,
    bias,
    recommendedAction,
  };
}
