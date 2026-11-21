/**
 * TradeOS v2 — Pure Algorithmic Technical Analysis Indicators
 * Zero external dependencies. Streaming loops with tickSize precision rounding.
 */

import { formatByTickSize } from '@tradeos/shared';
import type { KlineCandle, TechnicalSummary } from '@tradeos/shared';

/**
 * Exponential Moving Average (EMA)
 */
export function calculateEMA(prices: number[], period: number, tickSize?: number): number | null {
  if (!prices || prices.length < period || period <= 0) return null;
  const k = 2 / (period + 1);
  let sum = 0;
  for (let i = 0; i < period; i++) {
    sum += prices[i]!;
  }
  let ema = sum / period;
  for (let i = period; i < prices.length; i++) {
    ema = (prices[i]! - ema) * k + ema;
  }
  return tickSize && tickSize > 0 ? formatByTickSize(ema, tickSize) : Number(ema.toFixed(4));
}

/**
 * Relative Strength Index (RSI 14 with Wilder's Smoothing)
 */
export function calculateRSI(prices: number[], period: number = 14): number | null {
  if (!prices || prices.length < period + 1 || period <= 0) return null;
  let gains = 0;
  let losses = 0;

  for (let i = 1; i <= period; i++) {
    const diff = prices[i]! - prices[i - 1]!;
    if (diff >= 0) gains += diff;
    else losses += Math.abs(diff);
  }

  let avgGain = gains / period;
  let avgLoss = losses / period;

  for (let i = period + 1; i < prices.length; i++) {
    const diff = prices[i]! - prices[i - 1]!;
    if (diff >= 0) {
      avgGain = (avgGain * (period - 1) + diff) / period;
      avgLoss = (avgLoss * (period - 1)) / period;
    } else {
      avgGain = (avgGain * (period - 1)) / period;
      avgLoss = (avgLoss * (period - 1) + Math.abs(diff)) / period;
    }
  }

  if (avgLoss === 0 && avgGain === 0) return 50.0;
  if (avgLoss === 0) return 100.0;
  if (avgGain === 0) return 0.0;

  const rs = avgGain / avgLoss;
  const rsi = 100 - (100 / (1 + rs));
  return Number(rsi.toFixed(2));
}

/**
 * Average True Range (ATR 14 with Wilder's Smoothing)
 */
export function calculateATR(candles: KlineCandle[], period: number = 14, tickSize?: number): number | null {
  if (!candles || candles.length < period + 1 || period <= 0) return null;
  const trs: number[] = [];

  for (let i = 1; i < candles.length; i++) {
    const current = candles[i]!;
    const prev = candles[i - 1]!;
    const hl = current.high - current.low;
    const hc = Math.abs(current.high - prev.close);
    const lc = Math.abs(current.low - prev.close);
    trs.push(Math.max(hl, hc, lc));
  }

  if (trs.length < period) return null;
  let sum = 0;
  for (let i = 0; i < period; i++) sum += trs[i]!;
  let atr = sum / period;

  for (let i = period; i < trs.length; i++) {
    atr = (atr * (period - 1) + trs[i]!) / period;
  }

  return tickSize && tickSize > 0 ? formatByTickSize(atr, tickSize) : Number(atr.toFixed(4));
}

/**
 * Moving Average Convergence Divergence (MACD 12, 26, 9)
 */
export function calculateMACD(
  prices: number[],
  fast: number = 12,
  slow: number = 26,
  signal: number = 9
): { macd: number; signal: number; histogram: number } | null {
  if (!prices || prices.length < slow + signal || fast <= 0 || slow <= 0 || signal <= 0) {
    return null;
  }

  const kFast = 2 / (fast + 1);
  const kSlow = 2 / (slow + 1);
  const kSignal = 2 / (signal + 1);

  let emaFast = prices.slice(0, fast).reduce((a, b) => a + b, 0) / fast;
  const emaFastSeries = new Array<number>(prices.length);
  emaFastSeries[fast - 1] = emaFast;
  for (let i = fast; i < prices.length; i++) {
    emaFast = (prices[i]! - emaFast) * kFast + emaFast;
    emaFastSeries[i] = emaFast;
  }

  let emaSlow = prices.slice(0, slow).reduce((a, b) => a + b, 0) / slow;
  const macdSeries: number[] = [];
  for (let i = slow; i < prices.length; i++) {
    emaSlow = (prices[i]! - emaSlow) * kSlow + emaSlow;
    macdSeries.push(emaFastSeries[i]! - emaSlow);
  }

  if (macdSeries.length < signal) {
    return null;
  }

  let emaSig = macdSeries.slice(0, signal).reduce((a, b) => a + b, 0) / signal;
  for (let i = signal; i < macdSeries.length; i++) {
    emaSig = (macdSeries[i]! - emaSig) * kSignal + emaSig;
  }

  const latestMacd = macdSeries[macdSeries.length - 1]!;
  const histogram = latestMacd - emaSig;

  return {
    macd: Number(latestMacd.toFixed(4)),
    signal: Number(emaSig.toFixed(4)),
    histogram: Number(histogram.toFixed(4)),
  };
}

/**
 * Bollinger Bands (20, 2)
 */
export function calculateBollingerBands(
  prices: number[],
  period: number = 20,
  mult: number = 2,
  tickSize?: number
): { upper: number; middle: number; lower: number } | null {
  if (!prices || prices.length < period || period <= 0) return null;
  const slice = prices.slice(-period);
  const mean = slice.reduce((a, b) => a + b, 0) / period;
  const variance = slice.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / period;
  const stdDev = Math.sqrt(variance);

  const upper = mean + mult * stdDev;
  const middle = mean;
  const lower = mean - mult * stdDev;

  const round = (val: number) =>
    tickSize && tickSize > 0 ? formatByTickSize(val, tickSize) : Number(val.toFixed(2));

  return {
    upper: round(upper),
    middle: round(middle),
    lower: round(lower),
  };
}

/**
 * Average Directional Index (ADX 14 with Wilder's Smoothing)
 */
export function calculateADX(
  candles: KlineCandle[],
  period: number = 14
): { adx: number; pdi: number; mdi: number } | null {
  if (!candles || candles.length < period * 2 || period <= 0) {
    return null;
  }

  const trArr: number[] = [];
  const plusDMArr: number[] = [];
  const minusDMArr: number[] = [];

  for (let i = 1; i < candles.length; i++) {
    const c = candles[i]!;
    const p = candles[i - 1]!;
    const tr = Math.max(
      c.high - c.low,
      Math.abs(c.high - p.close),
      Math.abs(c.low - p.close)
    );
    const upMove = c.high - p.high;
    const downMove = p.low - c.low;

    const plusDM = (upMove > downMove && upMove > 0) ? upMove : 0;
    const minusDM = (downMove > upMove && downMove > 0) ? downMove : 0;

    trArr.push(tr);
    plusDMArr.push(plusDM);
    minusDMArr.push(minusDM);
  }

  if (trArr.length < period) return null;

  let smoothTR = 0;
  let smoothPlusDM = 0;
  let smoothMinusDM = 0;

  for (let i = 0; i < period; i++) {
    smoothTR += trArr[i]!;
    smoothPlusDM += plusDMArr[i]!;
    smoothMinusDM += minusDMArr[i]!;
  }

  let plusDI = smoothTR === 0 ? 0 : (smoothPlusDM / smoothTR) * 100;
  let minusDI = smoothTR === 0 ? 0 : (smoothMinusDM / smoothTR) * 100;
  let diSum = plusDI + minusDI;
  let dx = diSum === 0 ? 0 : (Math.abs(plusDI - minusDI) / diSum) * 100;
  const dxArr: number[] = [dx];

  for (let i = period; i < trArr.length; i++) {
    smoothTR = smoothTR - (smoothTR / period) + trArr[i]!;
    smoothPlusDM = smoothPlusDM - (smoothPlusDM / period) + plusDMArr[i]!;
    smoothMinusDM = smoothMinusDM - (smoothMinusDM / period) + minusDMArr[i]!;

    plusDI = smoothTR === 0 ? 0 : (smoothPlusDM / smoothTR) * 100;
    minusDI = smoothTR === 0 ? 0 : (smoothMinusDM / smoothTR) * 100;
    diSum = plusDI + minusDI;
    dx = diSum === 0 ? 0 : (Math.abs(plusDI - minusDI) / diSum) * 100;
    dxArr.push(dx);
  }

  if (dxArr.length < period) return null;

  let adxSum = 0;
  for (let i = 0; i < period; i++) {
    adxSum += dxArr[i]!;
  }
  let adx = adxSum / period;

  for (let i = period; i < dxArr.length; i++) {
    adx = (adx * (period - 1) + dxArr[i]!) / period;
  }

  return {
    adx: Number(adx.toFixed(2)),
    pdi: Number(plusDI.toFixed(2)),
    mdi: Number(minusDI.toFixed(2)),
  };
}

/**
 * Local Support & Resistance Pivots
 */
export function findSupportResistance(
  candles: KlineCandle[],
  lookback: number = 30,
  tickSize?: number
): { support: number | null; resistance: number | null } {
  if (!candles || candles.length === 0 || lookback <= 0) {
    return { support: null, resistance: null };
  }
  const recent = candles.slice(-lookback);
  let highest = -Infinity;
  let lowest = Infinity;

  for (const c of recent) {
    if (c.high > highest) highest = c.high;
    if (c.low < lowest) lowest = c.low;
  }

  const round = (val: number) =>
    tickSize && tickSize > 0 ? formatByTickSize(val, tickSize) : Number(val.toFixed(2));

  return {
    support: lowest === Infinity ? null : round(lowest),
    resistance: highest === -Infinity ? null : round(highest),
  };
}

/**
 * Volume Simple Moving Average (Volume SMA 20)
 */
export function calculateVolumeSMA(candles: KlineCandle[], period: number = 20): number | null {
  if (!candles || candles.length < period || period <= 0) return null;
  const slice = candles.slice(-period);
  const sum = slice.reduce((acc, c) => acc + (c.volume || 0), 0);
  return Number((sum / period).toFixed(2));
}

/**
 * SuperTrend Indicator (period, multiplier)
 * Uses Wilder's smoothed ATR and trailing upper/lower bands.
 */
export function calculateSuperTrend(
  highs: number[],
  lows: number[],
  closes: number[],
  period: number = 10,
  multiplier: number = 3.0
): { supertrend: number[]; direction: ('BULLISH' | 'BEARISH')[] } {
  if (
    !highs ||
    !lows ||
    !closes ||
    highs.length === 0 ||
    highs.length !== lows.length ||
    highs.length !== closes.length ||
    period <= 0
  ) {
    return { supertrend: [], direction: [] };
  }

  const n = closes.length;
  const trArr: number[] = new Array(n);
  for (let i = 0; i < n; i++) {
    const hl = highs[i]! - lows[i]!;
    if (i === 0) {
      trArr[0] = hl;
    } else {
      const hc = Math.abs(highs[i]! - closes[i - 1]!);
      const lc = Math.abs(lows[i]! - closes[i - 1]!);
      trArr[i] = Math.max(hl, hc, lc);
    }
  }

  // Calculate ATR series with Wilder's Smoothing
  const atrArr: number[] = new Array(n);
  let trSum = 0;
  for (let i = 0; i < n; i++) {
    if (i < period) {
      trSum += trArr[i]!;
      atrArr[i] = trSum / (i + 1);
    } else {
      atrArr[i] = (atrArr[i - 1]! * (period - 1) + trArr[i]!) / period;
    }
  }

  const supertrend: number[] = new Array(n);
  const direction: ('BULLISH' | 'BEARISH')[] = new Array(n);

  let prevUpper = 0;
  let prevLower = 0;

  for (let i = 0; i < n; i++) {
    const hl2 = (highs[i]! + lows[i]!) / 2;
    const basicUpper = hl2 + multiplier * atrArr[i]!;
    const basicLower = hl2 - multiplier * atrArr[i]!;

    let finalUpper = basicUpper;
    let finalLower = basicLower;

    if (i > 0) {
      finalUpper =
        basicUpper < prevUpper || closes[i - 1]! > prevUpper
          ? basicUpper
          : prevUpper;

      finalLower =
        basicLower > prevLower || closes[i - 1]! < prevLower
          ? basicLower
          : prevLower;
    }

    let dir: 'BULLISH' | 'BEARISH';
    let st: number;

    if (i === 0) {
      dir = closes[0]! >= basicLower ? 'BULLISH' : 'BEARISH';
      st = dir === 'BULLISH' ? finalLower : finalUpper;
    } else {
      const prevDir = direction[i - 1]!;
      if (prevDir === 'BULLISH') {
        if (closes[i]! < finalLower) {
          dir = 'BEARISH';
          st = finalUpper;
        } else {
          dir = 'BULLISH';
          st = finalLower;
        }
      } else {
        if (closes[i]! > finalUpper) {
          dir = 'BULLISH';
          st = finalLower;
        } else {
          dir = 'BEARISH';
          st = finalUpper;
        }
      }
    }

    supertrend[i] = st;
    direction[i] = dir;
    prevUpper = finalUpper;
    prevLower = finalLower;
  }

  return { supertrend, direction };
}

/**
 * Master Technical Indicators Suite
 * Evaluates all indicators from the candle history with tickSize precision formatting.
 * Missing or insufficient data safely returns null per indicator (Zero Mock Policy).
 */
export function calculateIndicators(candles: KlineCandle[], tickSize: number = 0.01): TechnicalSummary {
  if (!candles || !Array.isArray(candles) || candles.length === 0) {
    return {
      ema9: null,
      ema21: null,
      ema50: null,
      ema200: null,
      rsi14: null,
      atr14: null,
      macd: null,
      bollingerBands: null,
      adx14: null,
      support: null,
      resistance: null,
      volumeSma20: null,
    };
  }

  const closes = candles.map((c) => c.close);

  const ema9 = calculateEMA(closes, 9, tickSize);
  const ema21 = calculateEMA(closes, 21, tickSize);
  const ema50 = calculateEMA(closes, 50, tickSize);
  const ema200 = calculateEMA(closes, 200, tickSize);
  const rsi14 = calculateRSI(closes, 14);
  const atr14 = calculateATR(candles, 14, tickSize);
  const macd = calculateMACD(closes, 12, 26, 9);
  const bollingerBands = calculateBollingerBands(closes, 20, 2, tickSize);
  const adx14 = calculateADX(candles, 14);
  const { support, resistance } = findSupportResistance(candles, 30, tickSize);
  const volumeSma20 = calculateVolumeSMA(candles, 20);

  return {
    ema9,
    ema21,
    ema50,
    ema200,
    rsi14,
    atr14,
    macd,
    bollingerBands,
    adx14,
    support,
    resistance,
    volumeSma20,
  };
}
