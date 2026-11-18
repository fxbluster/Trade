import type { CvdSnapshot } from '@tradeos/shared';

export interface AggTradeInput {
  p?: number | string;
  q?: number | string;
  m?: boolean;
  s?: string;
  T?: number;
  E?: number;
  isBuyerMaker?: boolean;
  side?: string;
  [key: string]: unknown;
}

/**
 * CvdEngine — Real Cumulative Volume Delta (CVD) and Open Interest Engine.
 *
 * Implements a high-performance 500-sample Float64Array ring-buffer for delta volume tracking.
 * Binance aggTrade rules:
 * - trade.m === true: Buyer was maker => aggressive taker was SELLER (Market Sell => delta = -qty)
 * - trade.m === false: Buyer was taker => aggressive taker was BUYER (Market Buy => delta = +qty)
 *
 * Zero fabricated numbers: initial openInterestUsd = null.
 */
export class CvdEngine {
  private symbol: string;
  private readonly capacity: number;
  private readonly ringBuffer: Float64Array;
  private head: number = 0;
  private count: number = 0;
  private rollingDelta: number = 0;
  private cumulativeDelta: number = 0;
  private totalBuyVolume: number = 0;
  private totalSellVolume: number = 0;
  private openInterestUsd: number | null = null;
  private lastTimestamp: number = 0;

  constructor(symbol: string = 'SOLUSDT', capacity: number = 500) {
    this.symbol = symbol.toUpperCase();
    this.capacity = Math.max(1, capacity);
    this.ringBuffer = new Float64Array(this.capacity);
  }

  /**
   * Processes a single raw or mapped aggTrade event.
   */
  public processTrade(trade: AggTradeInput): void {
    if (!trade || typeof trade !== 'object') return;

    const rawQty = trade.q !== undefined ? trade.q : 0;
    const qty = typeof rawQty === 'number' ? rawQty : parseFloat(String(rawQty));
    if (isNaN(qty) || qty <= 0) return;

    // Buyer is maker: m === true -> Seller is aggressive taker -> SELL trade
    const isBuyerMaker = trade.m !== undefined
      ? Boolean(trade.m)
      : (trade.isBuyerMaker !== undefined ? Boolean(trade.isBuyerMaker) : trade.side === 'SELL');

    const isBuy = !isBuyerMaker;
    const delta = isBuy ? qty : -qty;

    if (isBuy) {
      this.totalBuyVolume += qty;
    } else {
      this.totalSellVolume += qty;
    }

    this.cumulativeDelta += delta;

    // Slide the 500-sample ring buffer
    if (this.count < this.capacity) {
      this.ringBuffer[this.head] = delta;
      this.head = (this.head + 1) % this.capacity;
      this.count++;
      this.rollingDelta += delta;
    } else {
      const oldDelta = this.ringBuffer[this.head];
      this.ringBuffer[this.head] = delta;
      this.head = (this.head + 1) % this.capacity;
      this.rollingDelta = this.rollingDelta - oldDelta + delta;
    }

    const tradeTime = Number(trade.T || trade.E) || Date.now();
    this.lastTimestamp = tradeTime;
  }

  /**
   * Sets the current Open Interest in USD.
   * Zero fabricated numbers: remains null until explicitly updated from Binance REST.
   */
  public setOpenInterest(oiUsd: number | null): void {
    if (oiUsd === null || oiUsd === undefined) {
      this.openInterestUsd = null;
    } else {
      const parsed = typeof oiUsd === 'number' ? oiUsd : parseFloat(String(oiUsd));
      this.openInterestUsd = !isNaN(parsed) && parsed >= 0 ? parsed : null;
    }
  }

  /**
   * Returns a snapshot of the current CVD state.
   */
  public getSnapshot(): CvdSnapshot {
    return {
      symbol: this.symbol,
      cvd: Number(this.cumulativeDelta.toFixed(4)),
      buyVolume: Number(this.totalBuyVolume.toFixed(4)),
      sellVolume: Number(this.totalSellVolume.toFixed(4)),
      delta: Number(this.rollingDelta.toFixed(4)),
      openInterestUsd: this.openInterestUsd !== null ? Number(this.openInterestUsd.toFixed(2)) : null,
      timestamp: this.lastTimestamp || Date.now()
    };
  }

  /**
   * Resets the engine state.
   * If a new symbol is provided and different from the current symbol,
   * openInterestUsd is reset to null. If symbol is identical or omitted,
   * openInterestUsd is preserved to avoid wiping valid OI on trade reconnects.
   */
  public reset(newSymbol?: string, clearOi: boolean = false): void {
    if (newSymbol) {
      const norm = newSymbol.trim().toUpperCase();
      if (norm && norm !== this.symbol) {
        this.symbol = norm;
        this.openInterestUsd = null;
      }
    }

    if (clearOi) {
      this.openInterestUsd = null;
    }

    this.ringBuffer.fill(0);
    this.head = 0;
    this.count = 0;
    this.rollingDelta = 0;
    this.cumulativeDelta = 0;
    this.totalBuyVolume = 0;
    this.totalSellVolume = 0;
    this.lastTimestamp = 0;
  }

  public getSymbol(): string {
    return this.symbol;
  }

  public getCapacity(): number {
    return this.capacity;
  }

  public getCount(): number {
    return this.count;
  }

  public getRingBuffer(): Float64Array {
    return this.ringBuffer.slice();
  }

  public getOpenInterest(): number | null {
    return this.openInterestUsd;
  }
}
