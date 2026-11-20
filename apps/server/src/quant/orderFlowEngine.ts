import type { PillarEvaluation } from '@tradeos/shared';

export interface DepthLevel {
  price: number;
  qty: number;
}

interface SecondBucket {
  buyVol: number;
  sellVol: number;
  secondTimestamp: number;
}

/**
 * OrderFlowEngine — Level-2 Depth and Tick Imbalance Analyzer.
 *
 * Pillar 3: ORDER_FLOW (Weight: 20%)
 * Evaluates order book pressure and aggressive taker flow.
 * Confirmation condition: Imbalance >= 3.0x on active side.
 */
export class OrderFlowEngine {
  private bids: DepthLevel[] = [];
  private asks: DepthLevel[] = [];
  private buckets: SecondBucket[] = [];
  private lastUpdate: number = 0;

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
    this.bids = bids.map(b => (Array.isArray(b) ? { price: b[0], qty: b[1] } : b));
    this.asks = asks.map(a => (Array.isArray(a) ? { price: a[0], qty: a[1] } : a));
    this.lastUpdate = Date.now();
  }

  /**
   * Records a raw aggTrade for rolling 60-second trade flow imbalance.
   * Uses an O(1) circular ring buffer.
   */
  public processTrade(qty: number, isBuyerMaker: boolean, time: number = Date.now()): void {
    if (qty <= 0) return;
    const currentSecond = Math.floor(time / 1000);
    const idx = ((currentSecond % 60) + 60) % 60;

    if (this.buckets[idx].secondTimestamp !== currentSecond) {
      this.buckets[idx] = {
        buyVol: 0,
        sellVol: 0,
        secondTimestamp: currentSecond,
      };
    }

    // Buyer is maker (isBuyerMaker === true) -> Seller is aggressive taker
    if (isBuyerMaker) {
      this.buckets[idx].sellVol += qty;
    } else {
      this.buckets[idx].buyVol += qty;
    }
    this.lastUpdate = time;
  }

  /**
   * Evaluates the current order flow state against the >= 3.0x threshold.
   */
  public evaluate(currentPrice?: number, evalTime: number = Date.now()): PillarEvaluation {
    const now = evalTime;
    const currentSecond = Math.floor(now / 1000);
    const topN = 20;

    let bidNotional = 0;
    for (let i = 0; i < Math.min(this.bids.length, topN); i++) {
      const b = this.bids[i];
      bidNotional += b.price * b.qty;
    }

    let askNotional = 0;
    for (let i = 0; i < Math.min(this.asks.length, topN); i++) {
      const a = this.asks[i];
      askNotional += a.price * a.qty;
    }

    // Aggregate 60-second rolling taker volume from ring buffer (O(1))
    let rollingBuyVol = 0;
    let rollingSellVol = 0;
    for (let i = 0; i < 60; i++) {
      const b = this.buckets[i];
      if (currentSecond >= b.secondTimestamp && currentSecond - b.secondTimestamp < 60) {
        rollingBuyVol += b.buyVol;
        rollingSellVol += b.sellVol;
      }
    }

    // Blend in rolling trade volume if present
    const refPrice = currentPrice || (this.bids[0]?.price || 100);
    const tradeBuyNotional = rollingBuyVol * refPrice;
    const tradeSellNotional = rollingSellVol * refPrice;

    const totalBidPressure = bidNotional + tradeBuyNotional;
    const totalAskPressure = askNotional + tradeSellNotional;

    // Default neutral state if no depth available
    if (totalBidPressure <= 0 && totalAskPressure <= 0) {
      return {
        id: 'ORDER_FLOW',
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
    const takerRatio = rollingSellVol > 0
      ? (rollingBuyVol >= rollingSellVol ? rollingBuyVol / Math.max(1, rollingSellVol) : rollingSellVol / Math.max(1, rollingBuyVol))
      : (rollingBuyVol > 0 ? rollingBuyVol : 1.0);
    const takerDominant = rollingBuyVol >= rollingSellVol ? 'Buy' : 'Sell';
    const flowTelemetry = hasFlow ? `Flow: ${takerRatio.toFixed(1)}x ${takerDominant} (60s) | ` : '';

    if (buyRatio >= 3.0) {
      const imbalancePct = Math.round((buyRatio - 1) * 100);
      const score = Math.min(100, Math.round(75 + Math.min(25, (buyRatio - 1) * 10)));
      return {
        id: 'ORDER_FLOW',
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
        id: 'ORDER_FLOW',
        title: 'Order Flow Footprint',
        score,
        bias: 'BEARISH',
        valueText: `-${imbalancePct}% Sell Imbalance`,
        subText: `${flowTelemetry}Top L2 Asks: ${formatNotional(askNotional)} / Bids: ${formatNotional(bidNotional)}`,
        confirmed: true,
        updatedAt: this.lastUpdate || now,
      };
    }

    // Balanced / neutral depth
    const dominantSide = totalBidPressure >= totalAskPressure ? 'Buy' : 'Sell';
    const activeRatio = Math.max(buyRatio, sellRatio);
    return {
      id: 'ORDER_FLOW',
      title: 'Order Flow Footprint',
      score: 50,
      bias: 'NEUTRAL',
      valueText: `Balanced (${activeRatio.toFixed(1)}x ${dominantSide})`,
      subText: `${flowTelemetry}Bids: ${formatNotional(bidNotional)} / Asks: ${formatNotional(askNotional)}`,
      confirmed: false,
      updatedAt: this.lastUpdate || now,
    };
  }

  public reset(): void {
    this.bids = [];
    this.asks = [];
    this.initBuckets();
    this.lastUpdate = 0;
  }
}
