import type { DatabaseSync } from 'node:sqlite';
import type {
  PnlSummaryResponse,
  PnlHorizonStats,
  LivePositionStats,
  BrokerMode,
  TradeSide,
} from '@tradeos/shared';
import type { BinanceClient } from '../exchange/binanceClient.js';
import type { TradesRepo } from '../db/sqlite.js';

export class PnlService {
  private incomeCache: { timestamp: number; data: any[] } | null = null;
  private readonly CACHE_TTL_MS = 10000; // 10s cache to preserve rate limits

  constructor(
    private db: DatabaseSync,
    private tradesRepo: TradesRepo,
    private client: BinanceClient,
    private getMarkPrice: (symbol: string) => number,
    private getActiveBroker: () => { mode: BrokerMode; getAccount: () => Promise<any> }
  ) {}

  /**
   * Fetches Binance income records for the last 7 days with in-memory caching.
   */
  private async getBinanceIncome(): Promise<any[]> {
    const now = Date.now();
    if (this.incomeCache && now - this.incomeCache.timestamp < this.CACHE_TTL_MS) {
      return this.incomeCache.data;
    }

    try {
      const sevenDaysAgo = now - 7 * 24 * 3600 * 1000;
      const data = await this.client.request<any[]>('/fapi/v1/income', {
        method: 'GET',
        signed: true,
        priority: 'P2',
        params: { startTime: sevenDaysAgo, limit: 1000 },
      });

      if (Array.isArray(data)) {
        this.incomeCache = { timestamp: now, data };
        return data;
      }
    } catch (err) {
      console.warn('PnlService: Binance /fapi/v1/income fetch error, falling back to local DB:', err);
    }

    return this.incomeCache?.data || [];
  }

  /**
   * Calculates trade count, win count, loss count and win rate from SQLite trades table.
   */
  private getDbTradeStats(startTime: number) {
    try {
      const stmt = this.db.prepare(`
        SELECT 
          COUNT(*) as total,
          SUM(CASE WHEN realized_pnl > 0 THEN 1 ELSE 0 END) as wins,
          SUM(CASE WHEN realized_pnl < 0 THEN 1 ELSE 0 END) as losses,
          SUM(realized_pnl) as total_pnl,
          SUM(fees_usd) as total_fees
        FROM trades
        WHERE (closed_at >= ? OR (closed_at IS NULL AND opened_at >= ?))
      `);
      const row = stmt.get(startTime, startTime) as any;
      const total = Number(row?.total || 0);
      const wins = Number(row?.wins || 0);
      const losses = Number(row?.losses || 0);
      const winRate = total > 0 ? Number(((wins / total) * 100).toFixed(1)) : 0;
      return {
        tradeCount: total,
        winCount: wins,
        lossCount: losses,
        winRate,
        dbPnl: Number((row?.total_pnl || 0).toFixed(2)),
        dbFees: Number((row?.total_fees || 0).toFixed(2)),
      };
    } catch {
      return { tradeCount: 0, winCount: 0, lossCount: 0, winRate: 0, dbPnl: 0, dbFees: 0 };
    }
  }

  /**
   * Aggregates multi-period PnL performance metrics.
   */
  async getPnlSummary(symbol: string = 'SOLUSDT'): Promise<PnlSummaryResponse> {
    const sym = symbol.toUpperCase();
    const broker = this.getActiveBroker();
    const now = Date.now();

    // 1. Fetch live account overview
    let account = {
      equity: 0,
      walletBalance: 0,
      availableBalance: 0,
      currency: 'USDT',
    };
    try {
      const acc = await broker.getAccount();
      account = {
        equity: Number(parseFloat(acc.equity || acc.totalMarginBalance || '0').toFixed(2)),
        walletBalance: Number(parseFloat(acc.walletBalance || acc.totalWalletBalance || '0').toFixed(2)),
        availableBalance: Number(parseFloat(acc.availableBalance || acc.availableBalance || '0').toFixed(2)),
        currency: acc.currency || 'USDT',
      };
    } catch {}

    // 2. Fetch active position details
    const activePos = this.tradesRepo.getActivePosition(broker.mode, sym);
    let live: LivePositionStats = {
      hasPosition: false,
    };

    let liveUnrealizedPnl = 0;
    if (activePos && activePos.status !== 'CLOSED' && activePos.remaining_qty > 0) {
      const markPrice = this.getMarkPrice(sym) || activePos.entry_price;
      const isLong = activePos.side === 'BUY';
      const priceDiff = isLong ? markPrice - activePos.entry_price : activePos.entry_price - markPrice;
      liveUnrealizedPnl = Number((priceDiff * activePos.remaining_qty).toFixed(2));
      const roePercent = activePos.entry_price > 0
        ? Number(((priceDiff / activePos.entry_price) * activePos.leverage * 100).toFixed(2))
        : 0;

      const isRiskFree = Boolean(
        activePos.is_breakeven === 1 &&
        activePos.stop_loss &&
        (isLong ? activePos.stop_loss >= activePos.entry_price : activePos.stop_loss <= activePos.entry_price)
      );

      live = {
        hasPosition: true,
        symbol: activePos.symbol,
        side: activePos.side as TradeSide,
        entryPrice: activePos.entry_price,
        markPrice,
        unrealizedPnl: liveUnrealizedPnl,
        roePercent,
        marginUsd: activePos.margin_usd,
        leverage: activePos.leverage,
        isRiskFree,
        stopLoss: activePos.stop_loss ?? undefined,
        bePrice: activePos.be_price ?? undefined,
      };
    }

    // 3. Time horizons
    const oneDayAgo = now - 24 * 3600 * 1000;
    const threeDaysAgo = now - 3 * 24 * 3600 * 1000;
    const sevenDaysAgo = now - 7 * 24 * 3600 * 1000;

    // 4. Fetch income from exchange (with DB fallback)
    const incomeRecords = await this.getBinanceIncome();

    const buildHorizonStats = (startTime: number, includeUnrealized: boolean): PnlHorizonStats => {
      const dbStats = this.getDbTradeStats(startTime);

      if (incomeRecords.length > 0) {
        const filtered = incomeRecords.filter((i) => i.time >= startTime);
        const realizedPnl = Number(
          filtered
            .filter((i) => i.incomeType === 'REALIZED_PNL')
            .reduce((sum, i) => sum + parseFloat(i.income), 0)
            .toFixed(2)
        );
        const commission = Number(
          filtered
            .filter((i) => i.incomeType === 'COMMISSION')
            .reduce((sum, i) => sum + parseFloat(i.income), 0)
            .toFixed(2)
        );
        const funding = Number(
          filtered
            .filter((i) => i.incomeType === 'FUNDING_FEE')
            .reduce((sum, i) => sum + parseFloat(i.income), 0)
            .toFixed(2)
        );

        const uPnl = includeUnrealized ? liveUnrealizedPnl : 0;
        const netPnl = Number((realizedPnl + commission + funding + uPnl).toFixed(2));

        return {
          realizedPnl,
          unrealizedPnl: uPnl,
          netPnl,
          commission,
          funding,
          tradeCount: Math.max(dbStats.tradeCount, realizedPnl !== 0 ? 1 : 0),
          winCount: dbStats.winCount + (liveUnrealizedPnl > 0 ? 1 : 0),
          lossCount: dbStats.lossCount,
          winRate: dbStats.winRate || (liveUnrealizedPnl > 0 ? 100 : 0),
        };
      }

      // Pure SQLite fallback if income API unavailable
      const uPnl = includeUnrealized ? liveUnrealizedPnl : 0;
      const netPnl = Number((dbStats.dbPnl - dbStats.dbFees + uPnl).toFixed(2));
      return {
        realizedPnl: dbStats.dbPnl,
        unrealizedPnl: uPnl,
        netPnl,
        commission: -dbStats.dbFees,
        funding: 0,
        tradeCount: dbStats.tradeCount,
        winCount: dbStats.winCount,
        lossCount: dbStats.lossCount,
        winRate: dbStats.winRate,
      };
    };

    const today = buildHorizonStats(oneDayAgo, true);
    const threeDays = buildHorizonStats(threeDaysAgo, true);
    const weekly = buildHorizonStats(sevenDaysAgo, true);

    // 5. Generate human-friendly Azerbaijani explanation
    let humanExplanation = '';
    if (live.hasPosition) {
      const pnlPrefix = live.unrealizedPnl! >= 0 ? '+' : '';
      humanExplanation += `Hazırda ${live.symbol} ${live.side} mövqeyindəyik. Cari xalis gəlir: ${pnlPrefix}$${live.unrealizedPnl!.toFixed(2)} (${pnlPrefix}${live.roePercent}%). `;
      if (live.isRiskFree) {
        humanExplanation += `Stop Loss girişdən yuxarıya ($${live.stopLoss}) kilidləndiyi üçün BU ƏMƏLİYYATDA ZİYAN RİSKİ QƏTİYYƏN YOXDUR (Breakeven aktiv). Bazar qəfil çöksə belə minimum qazancınız təmin edilib. `;
      } else {
        humanExplanation += `Stop Loss $${live.stopLoss} səviyyəsində qorunur. `;
      }
    } else {
      humanExplanation += `Hazırda açıq mövqe yoxdur. Bütün kapitalınız ($${account.equity.toFixed(2)}) nağd cüzdanda tam təhlükəsizdir. `;
    }

    const todayPrefix = today.netPnl >= 0 ? '+' : '';
    const threeDayPrefix = threeDays.netPnl >= 0 ? '+' : '';
    humanExplanation += `Bugünkü xalis nəticə: ${todayPrefix}$${today.netPnl.toFixed(2)}. Son 3 günün xalis nəticəsi: ${threeDayPrefix}$${threeDays.netPnl.toFixed(2)}.`;

    return {
      live,
      today,
      threeDays,
      weekly,
      account,
      humanExplanation,
      timestamp: now,
    };
  }
}
