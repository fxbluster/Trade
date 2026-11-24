import type { ConfluencePillarId, PillarEvaluation } from '@tradeos/shared';

export interface DepthLevel {
  price: number;
  qty: number;
}

interface SecondBucket {
  buyVol: number;
  sellVol: number;
  secondTimestamp: number;
  firstPrice?: number;
  lastPrice?: number;
}

export interface MinuteDeltaBar {
  minuteTimestamp: number;
  buyVol: number;
  sellVol: number;
  delta: number;
  openPrice: number;
  closePrice: number;
  priceVolume: Map<number, number>;
}

export interface VolumeProfileResult {
  poc: number;
  vah: number;
  val: number;
  totalVolume: number;
}

/**
 * OrderFlowEngine — Level-2 Depth, Tick Imbalance, Signed CVD Absorption Divergence,
 * and Micro Volume Profile Engine.
 *
 * Evaluates:
 * - ORDER_FLOW_L2: Order book depth pressure and aggressive taker flow (>= 3.0x threshold).
 * - CVD_ABSORPTION: Signed Z-score absorption divergence over rolling 15-minute window:
 *     Bullish: Z_delta <= -2.0 & deltaPrice >= 0 (Passive buyers absorb aggressive market sells)
 *     Bearish: Z_delta >= +2.0 & deltaPrice <= 0 (Passive sellers absorb aggressive market buys)
 * - Volume Profile: Point of Control (POC), Value Area High (VAH 70%), Value Area Low (VAL).
 */
export class OrderFlowEngine {
  private bids: DepthLevel[] = [];
  private asks: DepthLevel[] = [];
  private buckets: SecondBucket[] = [];
  private minuteBars: MinuteDeltaBar[] = [];
  private lastUpdate: number = 0;
  private currentPrice: number = 0;

  constructor() {
    this.initBuckets();
  }

  private initBuckets(): void {
    this.buckets = Array.from({ length: 60 }, () => ({
      buyVol: 0,
      sellVol: 0,
      secondTimestamp: 0,
    }));
  }

  /**
   * Updates Level-2 order book depth levels.
   */
  public updateDepth(
    bids: ([number, number] | DepthLevel)[],
    asks: ([number, number] | DepthLevel)[]
  ): void {
    this.bids = bids.map((b) => (Array.isArray(b) ? { price: b[0], qty: b[1] } : b));
    this.asks = asks.map((a) => (Array.isArray(a) ? { price: a[0], qty: a[1] } : a));
    this.lastUpdate = Date.now();
  }

  public getBids(): DepthLevel[] {
    return [...this.bids];
  }

  public getAsks(): DepthLevel[] {
    return [...this.asks];
  }

  public getDepth(): { bids: DepthLevel[]; asks: DepthLevel[] } {
    return {
      bids: [...this.bids],
      asks: [...this.asks],
    };
  }

  /**
   * Records a raw aggTrade for rolling 60-second trade flow imbalance,
   * 15-minute sliding CVD absorption sample, and Volume Profile.
   */
  public processTrade(
    qty: number,
    isBuyerMaker: boolean,
    time: number = Date.now(),
    price?: number
  ): void {
    if (qty <= 0) return;

    if (price && price > 0) {
      this.currentPrice = price;
    }

    const currentSecond = Math.floor(time / 1000);
    const secIdx = ((currentSecond % 60) + 60) % 60;

    // 1. Update 60-second circular ring buffer
    if (this.buckets[secIdx].secondTimestamp !== currentSecond) {
      this.buckets[secIdx] = {
        buyVol: 0,
        sellVol: 0,
        secondTimestamp: currentSecond,
        firstPrice: price,
        lastPrice: price,
      };
    } else {
      if (this.buckets[secIdx].firstPrice === undefined && price) {
        this.buckets[secIdx].firstPrice = price;
      }
      if (price) {
        this.buckets[secIdx].lastPrice = price;
      }
    }

    if (isBuyerMaker) {
      this.buckets[secIdx].sellVol += qty;
    } else {
      this.buckets[secIdx].buyVol += qty;
    }

    // 2. Update 15-minute sliding sample of 1-minute delta bars
    const currentMinute = Math.floor(time / 60000);
    let bar = this.minuteBars.find((b) => b.minuteTimestamp === currentMinute);

    if (!bar) {
      // Prune bars older than 15 minutes
      this.minuteBars = this.minuteBars.filter(
        (b) => currentMinute - b.minuteTimestamp < 15
      );

      bar = {
        minuteTimestamp: currentMinute,
        buyVol: 0,
        sellVol: 0,
        delta: 0,
        openPrice: price ?? this.currentPrice,
        closePrice: price ?? this.currentPrice,
        priceVolume: new Map(),
      };
      this.minuteBars.push(bar);
    }

    if (isBuyerMaker) {
      bar.sellVol += qty;
    } else {
      bar.buyVol += qty;
    }
    bar.delta = bar.buyVol - bar.sellVol;
    if (price && price > 0) {
      bar.closePrice = price;
      // Bin price with precision
      const binKey = Number(price.toPrecision(7));
      bar.priceVolume.set(binKey, (bar.priceVolume.get(binKey) || 0) + qty);
    }

    this.lastUpdate = time;
  }

  /**
   * Helper to append a 1-minute delta bar (useful for tests and pre-warming).
   */
  public addMinuteBar(bar: {
    minuteTimestamp?: number;
    buyVol?: number;
    sellVol?: number;
    delta?: number;
    openPrice?: number;
    closePrice?: number;
  }): void {
    const minuteTimestamp = bar.minuteTimestamp ?? Math.floor(Date.now() / 60000);
    const buyVol = bar.buyVol ?? (bar.delta && bar.delta > 0 ? bar.delta : 0);
    const sellVol = bar.sellVol ?? (bar.delta && bar.delta < 0 ? Math.abs(bar.delta) : 0);
    const delta = bar.delta ?? buyVol - sellVol;
    const openPrice = bar.openPrice ?? this.currentPrice;
    const closePrice = bar.closePrice ?? this.currentPrice;

    this.minuteBars = this.minuteBars.filter(
      (b) => minuteTimestamp - b.minuteTimestamp < 15
    );

    this.minuteBars.push({
      minuteTimestamp,
      buyVol,
      sellVol,
      delta,
      openPrice,
      closePrice,
      priceVolume: new Map(),
    });
  }

  /**
   * Evaluates the Level-2 Order Book Depth and 60-second Taker Flow (ORDER_FLOW_L2).
   */
  public evaluate(
    currentPrice?: number,
    evalTime: number = Date.now(),
    pillarId: ConfluencePillarId = 'ORDER_FLOW' as any
  ): PillarEvaluation {
    const now = evalTime;
    const currentSecond = Math.floor(now / 1000);
    const topN = 20;

    let bidNotional = 0;
    for (let i = 0; i < Math.min(this.bids.length, topN); i++) {
      const b = this.bids[i]!;
      bidNotional += b.price * b.qty;
    }

    let askNotional = 0;
    for (let i = 0; i < Math.min(this.asks.length, topN); i++) {
      const a = this.asks[i]!;
      askNotional += a.price * a.qty;
    }

    // Aggregate 60-second rolling taker volume from ring buffer
    let rollingBuyVol = 0;
    let rollingSellVol = 0;
    for (let i = 0; i < 60; i++) {
      const b = this.buckets[i]!;
      if (currentSecond >= b.secondTimestamp && currentSecond - b.secondTimestamp < 60) {
        rollingBuyVol += b.buyVol;
        rollingSellVol += b.sellVol;
      }
    }

    const refPrice = currentPrice || (this.bids[0]?.price || 100);
    const tradeBuyNotional = rollingBuyVol * refPrice;
    const tradeSellNotional = rollingSellVol * refPrice;

    const totalBidPressure = bidNotional + tradeBuyNotional;
    const totalAskPressure = askNotional + tradeSellNotional;

    if (totalBidPressure <= 0 && totalAskPressure <= 0) {
      return {
        id: pillarId,
        title: 'Order Flow Footprint',
        score: 50,
        bias: 'NEUTRAL',
        valueText: 'Balanced (0.0x)',
        subText: 'No L2 book depth available',
        confirmed: false,
        updatedAt: this.lastUpdate || now,
      };
    }

    const safeAsk = Math.max(1, totalAskPressure);
    const safeBid = Math.max(1, totalBidPressure);

    const buyRatio = totalBidPressure / safeAsk;
    const sellRatio = totalAskPressure / safeBid;

    const formatNotional = (amt: number): string => {
      if (amt >= 1e6) return `$${(amt / 1e6).toFixed(1)}M`;
      if (amt >= 1e3) return `$${(amt / 1e3).toFixed(1)}K`;
      return `$${amt.toFixed(0)}`;
    };

    const hasFlow = rollingBuyVol > 0 || rollingSellVol > 0;
    const takerRatio =
      rollingSellVol > 0
        ? rollingBuyVol >= rollingSellVol
          ? rollingBuyVol / Math.max(1, rollingSellVol)
          : rollingSellVol / Math.max(1, rollingBuyVol)
        : rollingBuyVol > 0
        ? rollingBuyVol
        : 1.0;
    const takerDominant = rollingBuyVol >= rollingSellVol ? 'Buy' : 'Sell';
    const flowTelemetry = hasFlow
      ? `Flow: ${takerRatio.toFixed(1)}x ${takerDominant} (60s) | `
      : '';

    if (buyRatio >= 3.0) {
      const imbalancePct = Math.round((buyRatio - 1) * 100);
      const score = Math.min(100, Math.round(75 + Math.min(25, (buyRatio - 1) * 10)));
      return {
        id: pillarId,
        title: 'Order Flow Footprint',
        score,
        bias: 'BULLISH',
        valueText: `+${imbalancePct}% Buy Imbalance`,
        subText: `${flowTelemetry}Top L2 Bids: ${formatNotional(bidNotional)} / Asks: ${formatNotional(askNotional)}`,
        confirmed: true,
        updatedAt: this.lastUpdate || now,
      };
    }

    if (sellRatio >= 3.0) {
      const imbalancePct = Math.round((sellRatio - 1) * 100);
      const score = Math.min(100, Math.round(75 + Math.min(25, (sellRatio - 1) * 10)));
      return {
        id: pillarId,
        title: 'Order Flow Footprint',
        score,
        bias: 'BEARISH',
        valueText: `-${imbalancePct}% Sell Imbalance`,
        subText: `${flowTelemetry}Top L2 Asks: ${formatNotional(askNotional)} / Bids: ${formatNotional(bidNotional)}`,
        confirmed: true,
        updatedAt: this.lastUpdate || now,
      };
    }

    const dominantSide = totalBidPressure >= totalAskPressure ? 'Buy' : 'Sell';
    const activeRatio = Math.max(buyRatio, sellRatio);
    return {
      id: pillarId,
      title: 'Order Flow Footprint',
      score: 50,
      bias: 'NEUTRAL',
      valueText: `Balanced (${activeRatio.toFixed(1)}x ${dominantSide})`,
      subText: `${flowTelemetry}Bids: ${formatNotional(bidNotional)} / Asks: ${formatNotional(askNotional)}`,
      confirmed: false,
      updatedAt: this.lastUpdate || now,
    };
  }

  /**
   * Convenience alias for ORDER_FLOW_L2 pillar evaluation.
   */
  public evaluateL2(currentPrice?: number, evalTime: number = Date.now()): PillarEvaluation {
    return this.evaluate(currentPrice, evalTime, 'ORDER_FLOW_L2' as any);
  }

  /**
   * Evaluates Pillar 3: CVD_ABSORPTION (Weight: 20%)
   * Uses signed Z-score divergence over rolling 15-minute sample:
   * - Bullish Absorption: Z_delta <= -2.0 AND deltaPrice >= 0
   * - Bearish Absorption: Z_delta >= +2.0 AND deltaPrice <= 0
   */
  public evaluateAbsorption(
    currentPrice?: number,
    evalTime: number = Date.now()
  ): PillarEvaluation {
    const now = evalTime;
    const currentSecond = Math.floor(now / 1000);

    // 1. Calculate 60-second rolling taker delta
    let rollingBuyVol = 0;
    let rollingSellVol = 0;
    let earliestPrice: number | undefined = undefined;
    let latestPrice: number | undefined = undefined;

    for (let i = 0; i < 60; i++) {
      const b = this.buckets[i]!;
      if (currentSecond >= b.secondTimestamp && currentSecond - b.secondTimestamp < 60) {
        rollingBuyVol += b.buyVol;
        rollingSellVol += b.sellVol;
        if (b.firstPrice !== undefined && earliestPrice === undefined) {
          earliestPrice = b.firstPrice;
        }
        if (b.lastPrice !== undefined) {
          latestPrice = b.lastPrice;
        }
      }
    }

    const delta60s = rollingBuyVol - rollingSellVol;
    const markPrice = currentPrice ?? latestPrice ?? this.currentPrice;
    const startPrice = earliestPrice ?? markPrice;
    const deltaPrice60s = markPrice - startPrice;

    // 2. Compute 15-minute sliding sample mean and standard deviation
    const deltas = this.minuteBars.map((b) => b.delta);

    if (deltas.length < 2) {
      return {
        id: 'CVD_ABSORPTION' as any,
        title: 'CVD Volume Delta Absorption',
        score: 50,
        bias: 'NEUTRAL',
        valueText: 'Balanced (Awaiting sample)',
        subText: '15-minute delta sample building',
        confirmed: false,
        updatedAt: this.lastUpdate || now,
      };
    }

    const mean = deltas.reduce((a, b) => a + b, 0) / deltas.length;
    const variance =
      deltas.reduce((acc, d) => acc + Math.pow(d - mean, 2), 0) / deltas.length;
    const stdDev = Math.sqrt(variance);

    const zDelta = stdDev > 0 ? (delta60s - mean) / stdDev : 0;

    // Bullish Absorption: Z_delta <= -2.0 & deltaPrice >= 0
    if (zDelta <= -2.0 && deltaPrice60s >= 0) {
      const score = Math.min(100, Math.round(75 + Math.min(25, (Math.abs(zDelta) - 2.0) * 10)));
      return {
        id: 'CVD_ABSORPTION' as any,
        title: 'CVD Volume Delta Absorption',
        score,
        bias: 'BULLISH',
        valueText: `Bullish Absorption (Z: ${zDelta.toFixed(2)})`,
        subText: `Aggressive sells absorbed by passive limits (Price Delta: +${deltaPrice60s.toFixed(2)})`,
        confirmed: true,
        updatedAt: this.lastUpdate || now,
      };
    }

    // Bearish Absorption: Z_delta >= +2.0 & deltaPrice <= 0
    if (zDelta >= 2.0 && deltaPrice60s <= 0) {
      const score = Math.min(100, Math.round(75 + Math.min(25, (zDelta - 2.0) * 10)));
      return {
        id: 'CVD_ABSORPTION' as any,
        title: 'CVD Volume Delta Absorption',
        score,
        bias: 'BEARISH',
        valueText: `Bearish Absorption (Z: +${zDelta.toFixed(2)})`,
        subText: `Aggressive buys absorbed by passive limits (Price Delta: ${deltaPrice60s.toFixed(2)})`,
        confirmed: true,
        updatedAt: this.lastUpdate || now,
      };
    }

    return {
      id: 'CVD_ABSORPTION' as any,
      title: 'CVD Volume Delta Absorption',
      score: 50,
      bias: 'NEUTRAL',
      valueText: `Equilibrium (Z: ${zDelta.toFixed(2)})`,
      subText: `Delta flow within normal bounds (-2.0 < Z < +2.0)`,
      confirmed: false,
      updatedAt: this.lastUpdate || now,
    };
  }

  /**
   * Computes Micro Volume Profile (Point of Control, Value Area High 70%, Value Area Low).
   */
  public getVolumeProfile(): VolumeProfileResult | null {
    const totalVolumeByPrice = new Map<number, number>();
    let totalVolume = 0;

    for (const bar of this.minuteBars) {
      for (const [p, v] of bar.priceVolume.entries()) {
        totalVolumeByPrice.set(p, (totalVolumeByPrice.get(p) || 0) + v);
        totalVolume += v;
      }
    }

    if (totalVolume <= 0 || totalVolumeByPrice.size === 0) {
      return null;
    }

    let poc = 0;
    let maxVol = -1;
    const sortedPrices: { price: number; volume: number }[] = [];

    for (const [p, v] of totalVolumeByPrice.entries()) {
      sortedPrices.push({ price: p, volume: v });
      if (v > maxVol) {
        maxVol = v;
        poc = p;
      }
    }

    sortedPrices.sort((a, b) => a.price - b.price);

    const targetVaVol = totalVolume * 0.7;
    let pocIndex = sortedPrices.findIndex((item) => item.price === poc);
    if (pocIndex === -1) pocIndex = 0;

    let currentVaVol = sortedPrices[pocIndex]!.volume;
    let lowIdx = pocIndex;
    let highIdx = pocIndex;

    while (
      currentVaVol < targetVaVol &&
      (lowIdx > 0 || highIdx < sortedPrices.length - 1)
    ) {
      const nextHighVol =
        highIdx < sortedPrices.length - 1 ? sortedPrices[highIdx + 1]!.volume : 0;
      const nextLowVol = lowIdx > 0 ? sortedPrices[lowIdx - 1]!.volume : 0;

      if (nextHighVol >= nextLowVol && highIdx < sortedPrices.length - 1) {
        highIdx++;
        currentVaVol += sortedPrices[highIdx]!.volume;
      } else if (lowIdx > 0) {
        lowIdx--;
        currentVaVol += sortedPrices[lowIdx]!.volume;
      } else if (highIdx < sortedPrices.length - 1) {
        highIdx++;
        currentVaVol += sortedPrices[highIdx]!.volume;
      } else {
        break;
      }
    }

    return {
      poc,
      vah: sortedPrices[highIdx]!.price,
      val: sortedPrices[lowIdx]!.price,
      totalVolume,
    };
  }

  public reset(): void {
    this.bids = [];
    this.asks = [];
    this.initBuckets();
    this.minuteBars = [];
    this.lastUpdate = 0;
    this.currentPrice = 0;
  }
}
