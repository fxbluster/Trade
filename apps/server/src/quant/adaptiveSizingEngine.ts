import type { SizingBreakdown, SizingArchetype } from '@tradeos/shared';

export interface SizingCalculationParams {
  confluenceScore: number; // 0 to 100
  walletBalance: number;
  availableBalance: number;
  leverage?: number; // default 10
  winRate?: number; // e.g. 0.60
  rewardRiskRatio?: number; // e.g. 1.5
  rollingWins?: number;
  rollingLosses?: number;
  fKelly?: number; // direct override in [0.50, 1.00]
  atr14?: number;
  medianAtr100?: number;
  wVol?: number; // direct override in [0.60, 1.25]
  consecutiveLosses?: number;
  circuitMultiplier?: number; // direct override
}

/**
 * Convex Dynamic Margin Formula:
 * M(S) = 0.05 + 0.25 * ((max(0, S - 70) / 30) ** 1.35)
 */
export function calculateRawMargin(score: number): number {
  if (score < 70) return 0;
  const ratio = Math.max(0, Math.min(1, (score - 70) / 30));
  const raw = 0.05 + 0.25 * Math.pow(ratio, 1.35);
  return Number(raw.toFixed(4));
}

/**
 * Determines sizing archetype from score.
 */
export function getSizingArchetype(score: number): SizingArchetype {
  if (score < 70) return 'Sub-Threshold';
  if (score < 75) return 'Exploratory Probe';
  if (score < 85) return 'Standard Institutional';
  if (score < 95) return 'High-Conviction Core';
  return 'A+ Institutional Setup';
}

/**
 * Calculates Quarter-Kelly dampener F_Kelly bounded in [0.50, 1.00].
 * Uses Beta(12, 8) prior smoothing on win rate.
 */
export function calculateQuarterKelly(params: {
  winRate?: number;
  rewardRiskRatio?: number;
  rollingWins?: number;
  rollingLosses?: number;
}): number {
  let w = 0.60; // prior mean: 12 / (12 + 8) = 0.60
  if (params.rollingWins !== undefined && params.rollingLosses !== undefined) {
    w = (params.rollingWins + 12) / (params.rollingWins + params.rollingLosses + 20);
  } else if (params.winRate !== undefined) {
    w = (params.winRate * 20 + 12) / 40;
  }

  const r = (params.rewardRiskRatio && params.rewardRiskRatio > 0) ? params.rewardRiskRatio : 1.5;
  const fullKelly = w - (1 - w) / r;
  // Map Kelly edge into dampener range [0.50, 1.00]
  const dampener = 0.50 + Math.max(0, fullKelly);
  const clamped = Math.min(1.00, Math.max(0.50, dampener));
  return Number(clamped.toFixed(4));
}

/**
 * Calculates Volatility Parity W_Vol = Median(ATR_100) / ATR_14, clamped to [0.60, 1.25].
 */
export function calculateVolatilityParity(medianAtr100?: number, atr14?: number): number {
  if (!medianAtr100 || !atr14 || atr14 <= 0 || medianAtr100 <= 0) {
    return 1.00;
  }
  const ratio = medianAtr100 / atr14;
  const clamped = Math.min(1.25, Math.max(0.60, ratio));
  return Number(clamped.toFixed(4));
}

/**
 * Calculates Drawdown Circuit Multiplier D_Circuit:
 * - 0 or 1 consecutive loss -> 1.00
 * - 2 consecutive losses -> 0.75
 * - 3 consecutive losses -> 0.50
 * - 4+ consecutive losses -> 0.0 (Lock)
 */
export function calculateDrawdownCircuit(consecutiveLosses: number = 0): number {
  if (consecutiveLosses >= 4) return 0.0;
  if (consecutiveLosses === 3) return 0.50;
  if (consecutiveLosses === 2) return 0.75;
  return 1.00;
}

/**
 * Adaptive Position Sizing Engine.
 *
 * Implements:
 * - Convex dynamic margin formula: M(S) = 0.05 + 0.25 * ((max(0, S - 70) / 30) ** 1.35)
 * - Final margin % = clamp(M(S) * F_Kelly * W_Vol * D_Circuit, 0.05, 0.30)
 * - Hard Solvency Airbag: availableBalance >= walletBalance * 0.20
 * - Sizing tier archetypes
 */
export class AdaptiveSizingEngine {
  /**
   * Calculates comprehensive sizing breakdown.
   */
  calculateSizing(params: SizingCalculationParams): SizingBreakdown {
    const {
      confluenceScore,
      walletBalance,
      availableBalance,
      leverage = 10,
    } = params;

    const archetype = getSizingArchetype(confluenceScore);

    // Hard Solvency Airbag check: availableBalance >= walletBalance * 0.20
    const minReserve = walletBalance * 0.20;
    const solvencyAirbagOk = availableBalance >= minReserve;

    // Sub-threshold check (S < 70) or Solvency Airbag failure
    if (confluenceScore < 70 || !solvencyAirbagOk) {
      return {
        confluenceScore,
        archetype,
        rawMarginPct: calculateRawMargin(confluenceScore),
        kellyDampener: 1.0,
        volatilityParity: 1.0,
        circuitMultiplier: calculateDrawdownCircuit(params.consecutiveLosses),
        finalMarginPct: 0.0,
        marginUsd: 0.0,
        notionalUsd: 0.0,
        solvencyAirbagOk,
      };
    }

    const rawMarginPct = calculateRawMargin(confluenceScore);

    // Quarter-Kelly Dampener [0.50, 1.00]
    const kellyDampener = params.fKelly !== undefined
      ? Math.min(1.00, Math.max(0.50, params.fKelly))
      : calculateQuarterKelly({
          winRate: params.winRate,
          rewardRiskRatio: params.rewardRiskRatio,
          rollingWins: params.rollingWins,
          rollingLosses: params.rollingLosses,
        });

    // Volatility Parity [0.60, 1.25]
    const volatilityParity = params.wVol !== undefined
      ? Math.min(1.25, Math.max(0.60, params.wVol))
      : calculateVolatilityParity(params.medianAtr100, params.atr14);

    // Drawdown Circuit
    const circuitMultiplier = params.circuitMultiplier !== undefined
      ? params.circuitMultiplier
      : calculateDrawdownCircuit(params.consecutiveLosses);

    // If circuit is locked (0.0), allocation is 0
    if (circuitMultiplier <= 0) {
      return {
        confluenceScore,
        archetype,
        rawMarginPct,
        kellyDampener,
        volatilityParity,
        circuitMultiplier: 0.0,
        finalMarginPct: 0.0,
        marginUsd: 0.0,
        notionalUsd: 0.0,
        solvencyAirbagOk: true,
      };
    }

    // Dynamic margin computation & clamping in [0.05, 0.30]
    const unadjusted = rawMarginPct * kellyDampener * volatilityParity * circuitMultiplier;
    let finalMarginPct = Math.min(0.30, Math.max(0.05, unadjusted));

    // Calculate USD margin, ensuring solvency airbag buffer is preserved
    let marginUsd = walletBalance * finalMarginPct;
    const maxAllowedMargin = Math.max(0, availableBalance - minReserve);
    if (marginUsd > maxAllowedMargin) {
      marginUsd = maxAllowedMargin;
      finalMarginPct = walletBalance > 0 ? marginUsd / walletBalance : 0;
    }

    const notionalUsd = marginUsd * leverage;

    return {
      confluenceScore,
      archetype,
      rawMarginPct,
      kellyDampener,
      volatilityParity,
      circuitMultiplier,
      finalMarginPct: Number(finalMarginPct.toFixed(4)),
      marginUsd: Number(marginUsd.toFixed(2)),
      notionalUsd: Number(notionalUsd.toFixed(2)),
      solvencyAirbagOk: true,
    };
  }
}
