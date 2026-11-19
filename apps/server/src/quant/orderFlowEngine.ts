import type { PillarEvaluation } from '@tradeos/shared';

export interface DepthLevel {
  price: number;
  qty: number;
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
  private rollingBuyVol: number = 0;
  private rollingSellVol: number = 0;
  private lastUpdate: number = 0;

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
   * Records a raw aggTrade for rolling trade flow imbalance.
   */
  public processTrade(qty: number, isBuyerMaker: boolean): void {
    if (qty <= 0) return;
    // Buyer is maker (isBuyerMaker === true) -> Seller is aggressive taker
    if (isBuyerMaker) {
      this.rollingSellVol += qty;
    } else {
      this.rollingBuyVol += qty;
    }
    this.lastUpdate = Date.now();
  }

  /**
   * Evaluates the current order flow state against the >= 3.0x threshold.
   */
  public evaluate(currentPrice?: number): PillarEvaluation {
    const now = Date.now();
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

    // Blend in rolling trade volume if present
    const refPrice = currentPrice || (this.bids[0]?.price || 100);
    const tradeBuyNotional = this.rollingBuyVol * refPrice;
    const tradeSellNotional = this.rollingSellVol * refPrice;

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

    if (buyRatio >= 3.0) {
      const imbalancePct = Math.round((buyRatio - 1) * 100);
      const score = Math.min(100, Math.round(75 + Math.min(25, (buyRatio - 1) * 10)));
      return {
        id: 'ORDER_FLOW',
        title: 'Order Flow Footprint',
        score,
        bias: 'BULLISH',
        valueText: `+${imbalancePct}% Buy Imbalance`,
        subText: `Top L2 Bids: ${formatNotional(bidNotional)} / Asks: ${formatNotional(askNotional)}`,
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
        subText: `Top L2 Asks: ${formatNotional(askNotional)} / Bids: ${formatNotional(bidNotional)}`,
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
      subText: `Bids: ${formatNotional(bidNotional)} / Asks: ${formatNotional(askNotional)}`,
      confirmed: false,
      updatedAt: this.lastUpdate || now,
    };
  }

  public reset(): void {
    this.bids = [];
    this.asks = [];
    this.rollingBuyVol = 0;
    this.rollingSellVol = 0;
    this.lastUpdate = 0;
  }
}
