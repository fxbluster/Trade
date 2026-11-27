import type { TradeSide, ChasingOrderState, ChasingStatus } from '@tradeos/shared';
import type { BrokerAdapter } from '../exchange/broker.js';
import {
  BinanceApiError,
  DEFAULT_SYMBOL_RULES,
  snapPriceToTick,
  snapQuantityToStep,
} from '../exchange/binanceClient.js';

export interface ChasingEngineOptions {
  /** Minimum ms between order amendments (default 250) */
  debouncMs?: number;
  /** Max amendments per order before abort (default 10) */
  maxAmendments?: number;
  /** Hard timeout ms for the full chasing session (default 15000) */
  timeoutMs?: number;
  /** Max price deviation % from anchor price before abort (default 0.002 = 0.20%) */
  maxDeviationPct?: number;
  /** Token bucket: max amendments per second (default 5) */
  maxAmendPerSec?: number;
  /** Tick size for penny-jumping (default 0.01) */
  tickSize?: number;
  /** Passive offset in ticks behind BBO on GTX Post-Only orders to avoid crossing spread (default 2) */
  passiveOffsetTicks?: number;
}

export interface DepthSnapshot {
  bestBid: number;
  bestAsk: number;
}

export interface ChasingResult {
  orderId: string;
  status: 'FILLED' | 'CANCELLED' | 'TIMEOUT' | 'ABORTED';
  fillPrice?: number;
  fillQty?: number;
  amendCount: number;
  feeSavedUsd?: number;
}

export type CheckFillResult =
  | { status: 'FILLED'; fillPrice: number; fillQty: number }
  | { status: 'TERMINAL'; reason: string }
  | null;

/**
 * Token bucket rate limiter: allows at most `capacity` tokens per second.
 */
class TokenBucket {
  private tokens: number;
  private lastRefill: number;

  constructor(
    private readonly capacity: number,
    private readonly refillRatePerSec: number
  ) {
    this.tokens = capacity;
    this.lastRefill = Date.now();
  }

  consume(): boolean {
    const now = Date.now();
    const elapsed = (now - this.lastRefill) / 1000;
    this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.refillRatePerSec);
    this.lastRefill = now;

    if (this.tokens >= 1) {
      this.tokens -= 1;
      return true;
    }
    return false;
  }
}

/**
 * Maker Post-Only (GTX) Limit Order Chasing Engine.
 *
 * Penny-jumps inside the BBO spread, amends in-flight via broker.modifyOrder,
 * and enforces debounce, token-bucket rate limiting, 0.20% runaway guard,
 * 15s timeout, and 10-amendment cap.
 */
export class ChasingExecutionEngine {
  private readonly debouncMs: number;
  private readonly maxAmendments: number;
  private readonly timeoutMs: number;
  private readonly maxDeviationPct: number;
  private readonly tickSize: number;
  private readonly hasExplicitTickSize: boolean;
  private readonly passiveOffsetTicks: number;
  private readonly bucket: TokenBucket;

  private state: ChasingOrderState | null = null;
  private onStateUpdate?: (state: ChasingOrderState) => void;

  constructor(
    private broker: BrokerAdapter,
    options: ChasingEngineOptions = {}
  ) {
    this.debouncMs = options.debouncMs ?? 250;
    this.maxAmendments = options.maxAmendments ?? 10;
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.maxDeviationPct = options.maxDeviationPct ?? 0.002;
    this.hasExplicitTickSize = options.tickSize !== undefined;
    this.tickSize = options.tickSize ?? 0.01;
    this.passiveOffsetTicks = Math.max(0, Math.round(options.passiveOffsetTicks ?? 2));
    const ratePerSec = options.maxAmendPerSec ?? 5;
    this.bucket = new TokenBucket(ratePerSec, ratePerSec);
  }

  /** Hot-swap active broker adapter when switching between BINANCE_DEMO and LOCAL_PAPER */
  setBroker(broker: BrokerAdapter): void {
    this.broker = broker;
  }

  /** Register optional state update callback */
  setOnStateUpdate(cb: (state: ChasingOrderState) => void): void {
    this.onStateUpdate = cb;
  }

  /** Current chasing state snapshot */
  getState(): ChasingOrderState | null {
    return this.state;
  }

  /** Configured tick size for penny-jump distance calculations */
  getTickSize(symbol?: string): number {
    return symbol ? this.resolveTickSize(symbol) : this.tickSize;
  }

  /**
   * Resolves the effective tickSize for a symbol:
   * respects explicit constructor tickSize, otherwise checks broker exchangeInfo rules
   * and falls back to DEFAULT_SYMBOL_RULES (e.g. BTCUSDT: 0.1, ETHUSDT/SOLUSDT: 0.01, XRPUSDT: 0.0001).
   */
  resolveTickSize(symbol: string): number {
    if (this.hasExplicitTickSize) {
      return this.tickSize;
    }
    const symUpper = symbol.toUpperCase();
    const brokerClient = (this.broker as any)?.client;
    if (brokerClient && typeof brokerClient.getSymbolRules === 'function') {
      const rules = brokerClient.getSymbolRules(symUpper);
      if (rules && Number.isFinite(rules.tickSize) && rules.tickSize > 0) {
        return rules.tickSize;
      }
    }
    return DEFAULT_SYMBOL_RULES[symUpper]?.tickSize ?? this.tickSize;
  }

  /**
   * Resolves the effective stepSize for a symbol from broker exchangeInfo rules or defaults.
   */
  resolveStepSize(symbol: string): number {
    const symUpper = symbol.toUpperCase();
    const brokerClient = (this.broker as any)?.client;
    if (brokerClient && typeof brokerClient.getSymbolRules === 'function') {
      const rules = brokerClient.getSymbolRules(symUpper);
      if (rules && Number.isFinite(rules.stepSize) && rules.stepSize > 0) {
        return rules.stepSize;
      }
    }
    return DEFAULT_SYMBOL_RULES[symUpper]?.stepSize ?? 0.001;
  }

  /**
   * Compute passive GTX Post-Only target price for a BUY order, snapped cleanly to tickSize.
   * Places a 1-2 tick passive offset behind bestBid so orders don't immediately cross the BBO.
   */
  computeTargetBuy(bestBid: number, bestAsk: number, tickSize: number = this.tickSize): number {
    const offset = this.passiveOffsetTicks * tickSize;
    const raw = Math.max(tickSize, Math.min(bestBid - offset, bestAsk - offset));
    return snapPriceToTick(raw, tickSize);
  }

  /**
   * Compute passive GTX Post-Only target price for a SELL order, snapped cleanly to tickSize.
   * Places a 1-2 tick passive offset behind bestAsk so orders don't immediately cross the BBO.
   */
  computeTargetSell(bestBid: number, bestAsk: number, tickSize: number = this.tickSize): number {
    const offset = this.passiveOffsetTicks * tickSize;
    const raw = Math.max(bestAsk + offset, bestBid + offset);
    return snapPriceToTick(raw, tickSize);
  }

  private computeTarget(
    side: TradeSide,
    bestBid: number,
    bestAsk: number,
    tickSize: number = this.tickSize
  ): number {
    return side === 'BUY'
      ? this.computeTargetBuy(bestBid, bestAsk, tickSize)
      : this.computeTargetSell(bestBid, bestAsk, tickSize);
  }

  private emitState(): void {
    if (this.state && this.onStateUpdate) {
      this.onStateUpdate({ ...this.state });
    }
  }

  private setState(partial: Partial<ChasingOrderState>): void {
    if (this.state) {
      Object.assign(this.state, partial);
      this.emitState();
    }
  }

  /**
   * Chase an order. Accepts a factory for fetching the current order book depth
   * and a factory for checking if the order has been filled (returns fill price/qty or null).
   *
   * @param symbol - Trading symbol (e.g. 'BTCUSDT')
   * @param side - 'BUY' | 'SELL'
   * @param quantity - Order quantity
   * @param anchorPrice - Initial mark price anchor (runaway guard reference)
   * @param getDepth - Async function returning { bestBid, bestAsk }
   * @param checkFill - Async function checking if order filled; returns { fillPrice, fillQty } or null
   * @param placeOrder - Async function to place the initial GTX limit order; returns orderId
   */
  async chase(params: {
    symbol: string;
    side: TradeSide;
    quantity: number;
    anchorPrice: number;
    getDepth: () => Promise<DepthSnapshot>;
    checkFill: (orderId: string) => Promise<CheckFillResult>;
    placeOrder: (price: number) => Promise<string>;
  }): Promise<ChasingResult> {
    const { symbol, side, quantity, anchorPrice } = params;
    const startTime = Date.now();
    const tickSize = this.resolveTickSize(symbol);
    const stepSize = this.resolveStepSize(symbol);
    const snappedQty = snapQuantityToStep(quantity, stepSize);

    // Initial depth snapshot
    const initialDepth = await params.getDepth();
    let initialPrice = this.computeTarget(side, initialDepth.bestBid, initialDepth.bestAsk, tickSize);

    // Place initial GTX limit order (wrap in -5022 1-tick backoff retry)
    let orderId: string;
    try {
      orderId = await params.placeOrder(initialPrice);
    } catch (err: any) {
      if (err instanceof BinanceApiError && err.code === -5022) {
        const backoff = Math.max(2, this.passiveOffsetTicks) * tickSize;
        const backedOffPrice = snapPriceToTick(
          side === 'BUY' ? Math.max(tickSize, initialPrice - backoff) : initialPrice + backoff,
          tickSize
        );
        await sleep(250);
        const freshDepth = await params.getDepth();
        const requotedPrice = this.computeTarget(side, freshDepth.bestBid, freshDepth.bestAsk, tickSize);
        const retryPrice = snapPriceToTick(
          side === 'BUY'
            ? Math.min(backedOffPrice, requotedPrice)
            : Math.max(backedOffPrice, requotedPrice),
          tickSize
        );
        initialPrice = retryPrice;
        orderId = await params.placeOrder(retryPrice);
      } else {
        throw err;
      }
    }

    this.state = {
      active: true,
      orderId,
      symbol,
      side,
      anchorPrice,
      currentLimitPrice: initialPrice,
      amendCount: 0,
      startTime,
      timeoutMs: this.timeoutMs,
      status: 'CHASING',
      feeSavedUsd: 0,
    };
    this.emitState();

    let lastAmendTime = startTime;
    let currentPrice = initialPrice;

    // Polling loop: >= 300ms intervals to stay within exchange API weight limits
    while (true) {
      await sleep(300);

      const now = Date.now();

      // 1. Hard timeout guard (15s)
      if (now - startTime >= this.timeoutMs) {
        return this.cancelAndCheckPartialFill(
          orderId,
          symbol,
          'TIMEOUT',
          params.checkFill
        );
      }

      // 2. Check fill or terminal exchange abort
      const fill = await params.checkFill(orderId);
      if (fill) {
        if (fill.status === 'TERMINAL') {
          this.setState({
            active: false,
            status: 'CANCELLED',
          });
          return {
            orderId,
            status: 'CANCELLED',
            fillQty: 0,
            amendCount: this.state!.amendCount,
          };
        }

        if (fill.status === 'FILLED') {
          this.setState({
            active: false,
            status: 'FILLED',
            currentLimitPrice: fill.fillPrice,
          });
          return {
            orderId,
            status: 'FILLED',
            fillPrice: fill.fillPrice,
            fillQty: fill.fillQty,
            amendCount: this.state!.amendCount,
          };
        }
      }

      // 3. Debounce gate
      if (now - lastAmendTime < this.debouncMs) {
        continue;
      }

      // 4. Max amendment cap
      if (this.state!.amendCount >= this.maxAmendments) {
        return this.cancelAndCheckPartialFill(
          orderId,
          symbol,
          'CANCELLED',
          params.checkFill
        );
      }

      // 5. Token bucket rate limit
      if (!this.bucket.consume()) {
        continue;
      }

      // 6. Fetch new depth
      const depth = await params.getDepth();
      const newTargetPrice = this.computeTarget(side, depth.bestBid, depth.bestAsk, tickSize);

      // 7. Toxic runaway guard: max 0.20% deviation from anchor
      const deviation = Math.abs(newTargetPrice - anchorPrice) / anchorPrice;
      if (deviation > this.maxDeviationPct) {
        return this.cancelAndCheckPartialFill(
          orderId,
          symbol,
          'CANCELLED',
          params.checkFill
        );
      }

      // 8. Only amend if price actually changed
      if (Math.abs(newTargetPrice - currentPrice) < tickSize * 0.5) {
        continue;
      }

      // 9. Attempt amendment
      try {
        await broker_modifyOrder(this.broker, symbol, orderId, newTargetPrice, snappedQty, side);
        currentPrice = newTargetPrice;
        lastAmendTime = now;
        this.setState({
          amendCount: this.state!.amendCount + 1,
          currentLimitPrice: currentPrice,
          status: 'AMENDING',
        });
        // After amendment, re-emit as CHASING
        this.setState({ status: 'CHASING' });
      } catch (err: any) {
        // -5022: Post-Only would trigger as taker → back off 2+ ticks
        if (err instanceof BinanceApiError && err.code === -5022) {
          const backoff = Math.max(2, this.passiveOffsetTicks) * tickSize;
          const backedOffPrice = snapPriceToTick(
            side === 'BUY' ? Math.max(tickSize, currentPrice - backoff) : currentPrice + backoff,
            tickSize
          );

          // Re-fetch depth and wait 250ms before re-quoting
          await sleep(250);
          const freshDepth = await params.getDepth();
          const requeotedPrice = this.computeTarget(side, freshDepth.bestBid, freshDepth.bestAsk, tickSize);
          const retryPrice = snapPriceToTick(
            side === 'BUY'
              ? Math.min(backedOffPrice, requeotedPrice)
              : Math.max(backedOffPrice, requeotedPrice),
            tickSize
          );

          try {
            await broker_modifyOrder(this.broker, symbol, orderId, retryPrice, snappedQty, side);
            currentPrice = retryPrice;
            lastAmendTime = Date.now();
            this.setState({
              amendCount: this.state!.amendCount + 1,
              currentLimitPrice: currentPrice,
              status: 'CHASING',
            });
          } catch {
            // Ignore secondary failure
          }
        }
        // Other errors: ignore and continue
      }
    }
  }

  private async cancelAndCheckPartialFill(
    orderId: string,
    symbol: string,
    fallbackStatus: 'TIMEOUT' | 'CANCELLED',
    checkFill: (orderId: string) => Promise<CheckFillResult>
  ): Promise<ChasingResult> {
    await this.cancelOrder(orderId, symbol);
    try {
      const postCancelFill = await checkFill(orderId);
      if (postCancelFill && postCancelFill.status === 'FILLED' && postCancelFill.fillQty > 0) {
        this.setState({
          active: false,
          status: 'FILLED',
          currentLimitPrice: postCancelFill.fillPrice,
        });
        return {
          orderId,
          status: 'FILLED',
          fillPrice: postCancelFill.fillPrice,
          fillQty: postCancelFill.fillQty,
          amendCount: this.state!.amendCount,
        };
      }
    } catch {
      // Fall back to terminal status if post-cancel check fails
    }

    this.setState({ active: false, status: fallbackStatus });
    return {
      orderId,
      status: fallbackStatus,
      amendCount: this.state!.amendCount,
    };
  }

  private async cancelOrder(orderId: string, symbol: string): Promise<void> {
    try {
      await this.broker.cancelOrder(symbol, orderId, false);
    } catch {
      // best-effort cancel
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function broker_modifyOrder(
  broker: BrokerAdapter,
  symbol: string,
  orderId: string,
  price: number,
  quantity: number,
  side: TradeSide
): Promise<any> {
  if (typeof broker.modifyOrder === 'function') {
    return broker.modifyOrder(symbol, orderId, price, quantity, side);
  }
  return Promise.reject(new Error('broker.modifyOrder not implemented'));
}
