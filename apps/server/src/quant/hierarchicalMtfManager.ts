import type { KlineCandle, PillarEvaluation, MacroRegime } from '@tradeos/shared';
import { calculateEMA, calculateSuperTrend, calculateADX } from './indicators.js';

export type { MacroRegime };

export type MtfTimeframe = '1m' | '15m' | '1h';

export interface MacroBiasResult {
  regime: MacroRegime;
  adx: number;
  ema200: number | null;
  supertrend: number | null;
  supertrendDirection: ('BULLISH' | 'BEARISH') | null;
  macroVetoActive: boolean;
  lastUpdate: number;
}

interface SymbolTimeframeBuffers {
  '1m': KlineCandle[];
  '15m': KlineCandle[];
  '1h': KlineCandle[];
  last1hUpdate: number;
}

/**
 * HierarchicalMtfManager
 *
 * Manages 200-candle circular ring buffers for 1m, 15m, and 1h intervals.
 * Computes 1h EMA200, SuperTrend (10, 3.0), and ADX (14) to return MacroRegime.
 * Enforces 120s timeout fail-closed to 'DEGRADED'.
 * Exposes getMacroBias(symbol) and evaluatePillar(symbol).
 */
export class HierarchicalMtfManager {
  private readonly buffers: Map<string, SymbolTimeframeBuffers> = new Map();
  private readonly MAX_BUFFER_SIZE = 200;
  private readonly TIMEOUT_MS = 120_000; // 120 seconds

  private getOrCreateBuffer(symbol: string): SymbolTimeframeBuffers {
    const sym = symbol.toUpperCase();
    let buf = this.buffers.get(sym);
    if (!buf) {
      buf = {
        '1m': [],
        '15m': [],
        '1h': [],
        last1hUpdate: 0,
      };
      this.buffers.set(sym, buf);
    }
    return buf;
  }

  /**
   * Pre-warms historical candles (e.g. from REST getKlines).
   */
  public setInitialCandles(
    symbol: string,
    timeframe: MtfTimeframe,
    candles: KlineCandle[],
    updateTime: number = Date.now()
  ): void {
    const buf = this.getOrCreateBuffer(symbol);
    buf[timeframe] = candles.slice(-this.MAX_BUFFER_SIZE);
    if (timeframe === '1h') {
      buf.last1hUpdate = updateTime;
    }
  }

  /**
   * Updates an in-memory ring buffer with live kline updates.
   */
  public updateCandle(
    symbol: string,
    timeframe: MtfTimeframe,
    candle: KlineCandle,
    _isClosed: boolean = false,
    updateTime: number = Date.now()
  ): void {
    const buf = this.getOrCreateBuffer(symbol);
    const arr = buf[timeframe];

    if (timeframe === '1h') {
      buf.last1hUpdate = updateTime;
    }

    if (arr.length === 0) {
      arr.push({ ...candle });
      return;
    }

    const last = arr[arr.length - 1]!;
    if (candle.time === last.time) {
      arr[arr.length - 1] = { ...candle };
    } else if (candle.time > last.time) {
      if (arr.length >= this.MAX_BUFFER_SIZE) {
        arr.shift();
      }
      arr.push({ ...candle });
    } else {
      const idx = arr.findIndex((c) => c.time === candle.time);
      if (idx >= 0) {
        arr[idx] = { ...candle };
      }
    }
  }

  /**
   * Returns snapshot copy of candles for a timeframe.
   */
  public getCandles(symbol: string, timeframe: MtfTimeframe): KlineCandle[] {
    const buf = this.buffers.get(symbol.toUpperCase());
    if (!buf) return [];
    return [...buf[timeframe]];
  }

  /**
   * Exposes getMacroBias(symbol) with 120s timeout check.
   */
  public getMacroBias(
    symbol: string,
    currentPrice?: number,
    evalTime: number = Date.now()
  ): MacroBiasResult {
    const buf = this.buffers.get(symbol.toUpperCase());
    const now = evalTime;

    // Fail-close to 'DEGRADED' if no buffer, empty 1h candles, or timeout > 120s
    if (
      !buf ||
      buf['1h'].length === 0 ||
      buf.last1hUpdate === 0 ||
      now - buf.last1hUpdate > this.TIMEOUT_MS
    ) {
      return {
        regime: 'DEGRADED',
        adx: 0,
        ema200: null,
        supertrend: null,
        supertrendDirection: null,
        macroVetoActive: true,
        lastUpdate: buf?.last1hUpdate || 0,
      };
    }

    const candles1h = buf['1h'];
    const closes = candles1h.map((c) => c.close);
    const highs = candles1h.map((c) => c.high);
    const lows = candles1h.map((c) => c.low);

    const ema200 = calculateEMA(closes, 200);
    const supertrendResult = calculateSuperTrend(highs, lows, closes, 10, 3.0);
    const adxResult = calculateADX(candles1h, 14);

    const adx = adxResult?.adx ?? 0;
    const latestSt =
      supertrendResult.supertrend.length > 0
        ? supertrendResult.supertrend[supertrendResult.supertrend.length - 1]!
        : null;
    const latestDir =
      supertrendResult.direction.length > 0
        ? supertrendResult.direction[supertrendResult.direction.length - 1]!
        : null;

    const mark =
      currentPrice && currentPrice > 0
        ? currentPrice
        : closes[closes.length - 1]!;

    let regime: MacroRegime = 'MACRO_RANGING';

    if (ema200 !== null) {
      if (mark > ema200 && (adx >= 25.0 || (latestDir === 'BULLISH' && adx >= 20.0))) {
        regime = 'MACRO_BULLISH';
      } else if (mark < ema200 && (adx >= 25.0 || (latestDir === 'BEARISH' && adx >= 20.0))) {
        regime = 'MACRO_BEARISH';
      } else {
        regime = 'MACRO_RANGING';
      }
    } else {
      if (latestDir === 'BULLISH' && adx >= 20.0) {
        regime = 'MACRO_BULLISH';
      } else if (latestDir === 'BEARISH' && adx >= 20.0) {
        regime = 'MACRO_BEARISH';
      } else {
        regime = 'MACRO_RANGING';
      }
    }

    // Macro Veto latch:
    // Longs blocked when regime is BEARISH, or price is below 1h EMA200
    const macroVetoActive =
      regime === 'MACRO_BEARISH' ||
      (ema200 !== null && mark < ema200);

    return {
      regime,
      adx,
      ema200,
      supertrend: latestSt,
      supertrendDirection: latestDir,
      macroVetoActive,
      lastUpdate: buf.last1hUpdate,
    };
  }

  /**
   * Evaluates Pillar 1: MACRO_REGIME (Weight: 25%)
   */
  public evaluatePillar(
    symbol: string,
    currentPrice?: number,
    evalTime: number = Date.now()
  ): PillarEvaluation {
    const bias = this.getMacroBias(symbol, currentPrice, evalTime);
    const now = evalTime;

    if (bias.regime === 'DEGRADED') {
      return {
        id: 'MACRO_REGIME' as any,
        title: '1h Macro Regime',
        score: 50,
        bias: 'NEUTRAL',
        valueText: 'DEGRADED (Timeout >120s)',
        subText: 'Higher-timeframe 1h stream desynchronized. Longs vetoed.',
        confirmed: false,
        updatedAt: bias.lastUpdate || now,
      };
    }

    if (bias.regime === 'MACRO_BULLISH') {
      const score = Math.min(100, Math.round(75 + Math.min(25, (bias.adx - 20) * 2.5)));
      return {
        id: 'MACRO_REGIME' as any,
        title: '1h Macro Regime',
        score,
        bias: 'BULLISH',
        valueText: `Macro Bullish (ADX ${bias.adx.toFixed(1)})`,
        subText: `Price > 1h EMA200 ($${bias.ema200?.toFixed(2) ?? 'N/A'})${bias.supertrendDirection === 'BULLISH' ? ' & SuperTrend Bullish' : ''}`,
        confirmed: true,
        updatedAt: bias.lastUpdate || now,
      };
    }

    if (bias.regime === 'MACRO_BEARISH') {
      const score = Math.min(100, Math.round(75 + Math.min(25, (bias.adx - 20) * 2.5)));
      return {
        id: 'MACRO_REGIME' as any,
        title: '1h Macro Regime',
        score,
        bias: 'BEARISH',
        valueText: `Macro Bearish (ADX ${bias.adx.toFixed(1)})`,
        subText: `Price < 1h EMA200 ($${bias.ema200?.toFixed(2) ?? 'N/A'})${bias.supertrendDirection === 'BEARISH' ? ' & SuperTrend Bearish' : ' (Longs Vetoed)'}`,
        confirmed: true,
        updatedAt: bias.lastUpdate || now,
      };
    }

    return {
      id: 'MACRO_REGIME' as any,
      title: '1h Macro Regime',
      score: 50,
      bias: 'NEUTRAL',
      valueText: `Macro Ranging (ADX ${bias.adx.toFixed(1)})`,
      subText: bias.macroVetoActive
        ? 'Price below 1h EMA200 (Longs Vetoed)'
        : 'No clear directional trend breakout',
      confirmed: false,
      updatedAt: bias.lastUpdate || now,
    };
  }

  public reset(symbol?: string): void {
    if (symbol) {
      this.buffers.delete(symbol.toUpperCase());
    } else {
      this.buffers.clear();
    }
  }
}
