import type {
  KlineCandle,
  PillarEvaluation,
  FairValueGap,
  OrderBlock,
  LiquiditySweep,
} from '@tradeos/shared';
import { calculateATR } from './indicators.js';

export type { FairValueGap, OrderBlock, LiquiditySweep };

export interface SmcState {
  activeFvgs: FairValueGap[];
  activeOrderBlocks: OrderBlock[];
  latestSweep: LiquiditySweep | null;
  lastUpdate: number;
}

/**
 * NativeSmcEngine
 *
 * Server-side algorithmic Smart Money Concepts detector:
 * 1. Fair Value Gaps (FVG) with 3-candle imbalance and subsequent wick mitigation.
 * 2. Order Blocks (OB) with expansion candle >= 1.8x ATR(14) and 5-bar BOS.
 * 3. Liquidity Sweeps with 20-candle swing high/low sweep & reclaim.
 * 4. O(1) tick check on raw price updates for active zone testing and invalidation.
 */
export class NativeSmcEngine {
  private readonly symbolStates: Map<string, SmcState> = new Map();

  private getOrCreateState(symbol: string): SmcState {
    const sym = symbol.toUpperCase();
    let state = this.symbolStates.get(sym);
    if (!state) {
      state = {
        activeFvgs: [],
        activeOrderBlocks: [],
        latestSweep: null,
        lastUpdate: Date.now(),
      };
      this.symbolStates.set(sym, state);
    }
    return state;
  }

  /**
   * Pure algorithmic detector for Fair Value Gaps on closed candles.
   */
  public detectFairValueGaps(
    candles: KlineCandle[],
    timeframe: string = '15m'
  ): FairValueGap[] {
    if (!candles || candles.length < 3) return [];

    const fvgs: FairValueGap[] = [];
    const n = candles.length;

    for (let i = 2; i < n; i++) {
      const cPrev2 = candles[i - 2]!;
      const cPrev1 = candles[i - 1]!;
      const cCurr = candles[i]!;

      // Bullish FVG: Low of candle i > High of candle i-2
      if (cCurr.low > cPrev2.high) {
        const high = cCurr.low;
        const low = cPrev2.high;
        const id = `fvg_bull_${timeframe}_${cPrev1.time}`;

        // Check if mitigated by any subsequent candle up to end of closed history
        let mitigated = false;
        for (let k = i + 1; k < n; k++) {
          if (candles[k]!.low <= low) {
            mitigated = true;
            break;
          }
        }

        fvgs.push({
          id,
          timeframe,
          type: 'BULLISH',
          high,
          low,
          mitigated,
          formedAt: cPrev1.time * 1000,
        });
      }

      // Bearish FVG: High of candle i < Low of candle i-2
      if (cCurr.high < cPrev2.low) {
        const high = cPrev2.low;
        const low = cCurr.high;
        const id = `fvg_bear_${timeframe}_${cPrev1.time}`;

        let mitigated = false;
        for (let k = i + 1; k < n; k++) {
          if (candles[k]!.high >= high) {
            mitigated = true;
            break;
          }
        }

        fvgs.push({
          id,
          timeframe,
          type: 'BEARISH',
          high,
          low,
          mitigated,
          formedAt: cPrev1.time * 1000,
        });
      }
    }

    return fvgs;
  }

  /**
   * Pure algorithmic detector for Order Blocks on closed candles.
   * Defined as: Candle C_i where C_i+1 body >= 1.8x ATR(14) and closes beyond 5-candle swing (BOS).
   */
  public detectOrderBlocks(
    candles: KlineCandle[],
    timeframe: string = '15m',
    swingLookback: number = 5
  ): OrderBlock[] {
    if (!candles || candles.length < swingLookback + 2) return [];

    const obs: OrderBlock[] = [];
    const n = candles.length;

    for (let i = swingLookback; i < n - 1; i++) {
      const cCandidate = candles[i]!;
      const cExpansion = candles[i + 1]!;

      const bodySize = Math.abs(cExpansion.close - cExpansion.open);

      // Compute ATR(14) up to expansion candle
      const subSlice = candles.slice(Math.max(0, i - 20), i + 2);
      const atr = calculateATR(subSlice, 14) ??
        subSlice.reduce((acc, c) => acc + (c.high - c.low), 0) / Math.max(1, subSlice.length);

      if (atr <= 0 || bodySize < 1.8 * atr) {
        continue;
      }

      // Check highest high and lowest low of previous 5 candles (i - swingLookback to i - 1)
      const prev5 = candles.slice(i - swingLookback, i);
      let highest5 = -Infinity;
      let lowest5 = Infinity;
      for (const p of prev5) {
        if (p.high > highest5) highest5 = p.high;
        if (p.low < lowest5) lowest5 = p.low;
      }

      // Bullish BOS: C_i+1 closes above highest high of previous 5 candles
      if (cExpansion.close > highest5 && cExpansion.close > cCandidate.high) {
        const id = `ob_bull_${timeframe}_${cCandidate.time}`;
        const invalidationPrice = cCandidate.low;

        // Check if invalidated by subsequent candles
        let invalidated = false;
        for (let k = i + 2; k < n; k++) {
          if (candles[k]!.low < invalidationPrice) {
            invalidated = true;
            break;
          }
        }

        if (!invalidated) {
          obs.push({
            id,
            timeframe,
            type: 'BULLISH',
            high: cCandidate.high,
            low: cCandidate.low,
            invalidationPrice,
            volume: cCandidate.volume,
          });
        }
      }

      // Bearish BOS: C_i+1 closes below lowest low of previous 5 candles
      if (cExpansion.close < lowest5 && cExpansion.close < cCandidate.low) {
        const id = `ob_bear_${timeframe}_${cCandidate.time}`;
        const invalidationPrice = cCandidate.high;

        let invalidated = false;
        for (let k = i + 2; k < n; k++) {
          if (candles[k]!.high > invalidationPrice) {
            invalidated = true;
            break;
          }
        }

        if (!invalidated) {
          obs.push({
            id,
            timeframe,
            type: 'BEARISH',
            high: cCandidate.high,
            low: cCandidate.low,
            invalidationPrice,
            volume: cCandidate.volume,
          });
        }
      }
    }

    return obs;
  }

  /**
   * Pure algorithmic detector for Liquidity Sweeps on closed candles.
   * Flags when price wicks beyond a recent 20-candle swing high/low and closes back inside.
   */
  public detectLiquiditySweeps(
    candles: KlineCandle[],
    lookback: number = 20
  ): LiquiditySweep | null {
    if (!candles || candles.length < lookback + 1) return null;

    const n = candles.length;
    // Inspect recent 3 candles for fresh sweep events
    for (let i = n - 1; i >= Math.max(lookback, n - 3); i--) {
      const c = candles[i]!;
      const prevWindow = candles.slice(i - lookback, i);

      let swingHigh = -Infinity;
      let swingLow = Infinity;
      for (const p of prevWindow) {
        if (p.high > swingHigh) swingHigh = p.high;
        if (p.low < swingLow) swingLow = p.low;
      }

      // Bullish Sweep: wicks below swing low, reclaims above on close
      if (c.low < swingLow && c.close >= swingLow) {
        return {
          id: `sweep_low_${c.time}`,
          direction: 'SWEEP_LOW',
          sweepPrice: c.low,
          reclaimPrice: c.close,
          time: c.time * 1000,
        };
      }

      // Bearish Sweep: wicks above swing high, reclaims below on close
      if (c.high > swingHigh && c.close <= swingHigh) {
        return {
          id: `sweep_high_${c.time}`,
          direction: 'SWEEP_HIGH',
          sweepPrice: c.high,
          reclaimPrice: c.close,
          time: c.time * 1000,
        };
      }
    }

    return null;
  }

  /**
   * Called strictly upon confirmed closed candle (kline.isClosed === true).
   * Re-evaluates geometric FVG and Order Block patterns.
   */
  public onCandleClosed(
    symbol: string,
    timeframe: string,
    closedCandles: KlineCandle[]
  ): void {
    const state = this.getOrCreateState(symbol);
    const fvgs = this.detectFairValueGaps(closedCandles, timeframe);
    const obs = this.detectOrderBlocks(closedCandles, timeframe);
    const sweep = this.detectLiquiditySweeps(closedCandles, 20);

    // Keep active (unmitigated) FVGs (max 10 recent)
    state.activeFvgs = fvgs.filter((f) => !f.mitigated).slice(-10);
    // Keep active OBs (max 10 recent)
    state.activeOrderBlocks = obs.slice(-10);

    if (sweep) {
      state.latestSweep = sweep;
    }

    state.lastUpdate = Date.now();
  }

  /**
   * O(1) tick check: Executes on raw price ticks (4Hz) within <= 5ms budget.
   * Evaluates zone proximity, marks newly mitigated FVGs, and invalidates breached OBs.
   */
  public onTick(
    symbol: string,
    currentPrice: number
  ): {
    insideFvg: FairValueGap | null;
    insideOb: OrderBlock | null;
  } {
    const state = this.getOrCreateState(symbol);
    let insideFvg: FairValueGap | null = null;
    let insideOb: OrderBlock | null = null;

    // 1. Check & mitigate active FVGs
    for (let i = 0; i < state.activeFvgs.length; i++) {
      const fvg = state.activeFvgs[i]!;
      if (fvg.mitigated) continue;

      if (currentPrice >= fvg.low && currentPrice <= fvg.high) {
        insideFvg = fvg;
      }

      // Full wick overlap mitigation check
      if (fvg.type === 'BULLISH' && currentPrice <= fvg.low) {
        fvg.mitigated = true;
      } else if (fvg.type === 'BEARISH' && currentPrice >= fvg.high) {
        fvg.mitigated = true;
      }
    }

    // Prune mitigated FVGs
    state.activeFvgs = state.activeFvgs.filter((f) => !f.mitigated);

    // 2. Check & invalidate Order Blocks
    const remainingObs: OrderBlock[] = [];
    for (let i = 0; i < state.activeOrderBlocks.length; i++) {
      const ob = state.activeOrderBlocks[i]!;

      // Check boundary proximity
      if (currentPrice >= ob.low && currentPrice <= ob.high) {
        insideOb = ob;
      }

      // Invalidation check
      const isBreached =
        (ob.type === 'BULLISH' && currentPrice < ob.invalidationPrice) ||
        (ob.type === 'BEARISH' && currentPrice > ob.invalidationPrice);

      if (!isBreached) {
        remainingObs.push(ob);
      }
    }
    state.activeOrderBlocks = remainingObs;

    return { insideFvg, insideOb };
  }

  public getActiveFvgs(symbol: string): FairValueGap[] {
    const state = this.symbolStates.get(symbol.toUpperCase());
    return state ? [...state.activeFvgs] : [];
  }

  public getActiveOrderBlocks(symbol: string): OrderBlock[] {
    const state = this.symbolStates.get(symbol.toUpperCase());
    return state ? [...state.activeOrderBlocks] : [];
  }

  public getLatestSweep(symbol: string): LiquiditySweep | null {
    const state = this.symbolStates.get(symbol.toUpperCase());
    return state?.latestSweep || null;
  }

  public getState(symbol: string): SmcState {
    return this.getOrCreateState(symbol);
  }

  /**
   * Evaluates Pillar 2: NATIVE_SMC (Weight: 25%)
   */
  public evaluatePillar(
    symbol: string,
    currentPrice: number,
    evalTime: number = Date.now()
  ): PillarEvaluation {
    const state = this.getOrCreateState(symbol);
    const now = evalTime;

    // Check recent sweep within 15 minutes (900,000 ms)
    if (state.latestSweep && now - state.latestSweep.time < 900_000) {
      const sweep = state.latestSweep;
      const isBull = sweep.direction === 'SWEEP_LOW';
      return {
        id: 'NATIVE_SMC' as any,
        title: 'Native SMC Market Structure',
        score: 85,
        bias: isBull ? 'BULLISH' : 'BEARISH',
        valueText: isBull ? 'Bullish Liquidity Sweep' : 'Bearish Liquidity Sweep',
        subText: `Swept $${sweep.sweepPrice.toFixed(2)} -> Reclaimed $${sweep.reclaimPrice.toFixed(2)}`,
        confirmed: true,
        updatedAt: sweep.time,
      };
    }

    // Check O(1) zone proximity
    const { insideFvg, insideOb } = this.onTick(symbol, currentPrice);

    if (insideFvg) {
      const isBull = insideFvg.type === 'BULLISH';
      return {
        id: 'NATIVE_SMC' as any,
        title: 'Native SMC Market Structure',
        score: 80,
        bias: isBull ? 'BULLISH' : 'BEARISH',
        valueText: `Active ${insideFvg.type} FVG Zone`,
        subText: `Imbalance: $${insideFvg.low.toFixed(2)} - $${insideFvg.high.toFixed(2)} (${insideFvg.timeframe})`,
        confirmed: true,
        updatedAt: insideFvg.formedAt || now,
      };
    }

    if (insideOb) {
      const isBull = insideOb.type === 'BULLISH';
      return {
        id: 'NATIVE_SMC' as any,
        title: 'Native SMC Market Structure',
        score: 80,
        bias: isBull ? 'BULLISH' : 'BEARISH',
        valueText: `Inside ${insideOb.type} Order Block`,
        subText: `Zone: $${insideOb.low.toFixed(2)} - $${insideOb.high.toFixed(2)} (Invalidation: $${insideOb.invalidationPrice.toFixed(2)})`,
        confirmed: true,
        updatedAt: state.lastUpdate || now,
      };
    }

    // Default neutral state
    const fvgCount = state.activeFvgs.length;
    const obCount = state.activeOrderBlocks.length;
    return {
      id: 'NATIVE_SMC' as any,
      title: 'Native SMC Market Structure',
      score: 50,
      bias: 'NEUTRAL',
      valueText: 'Equilibrium (No Active Zone)',
      subText: `${fvgCount} unmitigated FVGs / ${obCount} Order Blocks tracked`,
      confirmed: false,
      updatedAt: state.lastUpdate || now,
    };
  }

  public reset(symbol?: string): void {
    if (symbol) {
      this.symbolStates.delete(symbol.toUpperCase());
    } else {
      this.symbolStates.clear();
    }
  }
}
