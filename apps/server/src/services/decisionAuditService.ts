import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type {
  ConfluenceSnapshot,
  KlineCandle,
  TradeSide,
  DecisionAction,
  ShadowSetupStatus,
  DecisionLogRecord,
  DailyAuditSummary,
  DailyAuditResponse,
  MacroRegime,
  PillarTelemetryRecord,
} from '@tradeos/shared';
import { DecisionLogsRepo, PillarTelemetryRepo } from '../db/sqlite.js';
import type { BinanceClient } from '../exchange/binanceClient.js';

export interface LatchState {
  isArmed: boolean;
  lastTriggeredAt: number;
}

export interface RecordExecutionParams {
  symbol: string;
  side: TradeSide;
  action: DecisionAction;
  price: number;
  marginUsd: number;
  leverage: number;
  atr: number;
  tradeId?: string;
  errorMessage?: string;
  compositeScore?: number;
  pillarsJson?: string;
  macroRegime?: MacroRegime;
  macroVetoActive?: boolean;
  vetoReasonsJson?: string;
}

export class DecisionAuditService {
  private repo: DecisionLogsRepo;
  private pillarRepo?: PillarTelemetryRepo;
  private latches: Map<string, LatchState> = new Map();
  private readonly COOLDOWN_MS = 180_000; // 3-minute hysteresis cooldown
  private readonly EXPIRY_HORIZON_MS = 3_600_000; // 60 minutes
  private readonly FRICTION_RATE = 0.0015; // 0.15% notional friction

  constructor(repoOrDb: DecisionLogsRepo | DatabaseSync, pillarRepo?: PillarTelemetryRepo) {
    if (repoOrDb instanceof DecisionLogsRepo) {
      this.repo = repoOrDb;
      this.pillarRepo = pillarRepo;
    } else {
      this.repo = new DecisionLogsRepo(repoOrDb);
      this.pillarRepo = pillarRepo ?? new PillarTelemetryRepo(repoOrDb);
    }
  }

  public setPillarRepo(pillarRepo: PillarTelemetryRepo): void {
    this.pillarRepo = pillarRepo;
  }

  public getPillarRepo(): PillarTelemetryRepo | undefined {
    return this.pillarRepo;
  }

  private getLatchKey(symbol: string, side: TradeSide): string {
    return `${symbol.toUpperCase().trim()}:${side}`;
  }

  private getLatch(symbol: string, side: TradeSide): LatchState {
    const key = this.getLatchKey(symbol, side);
    let latch = this.latches.get(key);
    if (!latch) {
      latch = { isArmed: false, lastTriggeredAt: 0 };
      this.latches.set(key, latch);
    }
    return latch;
  }

  public getLatchState(symbol: string, side: TradeSide): LatchState {
    const latch = this.getLatch(symbol, side);
    return { ...latch };
  }

  /**
   * Evaluates incoming confluence snapshot against rising-edge hysteresis latch.
   * If armed, score >= 60%, and 180s cooldown passed:
   * Checks for duplicate open shadow setups, then writes a BLOCKED record to SQLite with virtual SL/TP.
   */
  public evaluateSnapshot(snapshot: ConfluenceSnapshot, atr: number, markPrice: number): void {
    const symbol = snapshot.symbol.toUpperCase().trim();
    const score = snapshot.compositeScore;

    // Reset deadband arming: when score < 50%, arm both BUY and SELL latches
    if (score < 50) {
      this.getLatch(symbol, 'BUY').isArmed = true;
      this.getLatch(symbol, 'SELL').isArmed = true;
      return;
    }

    if (score < 60) {
      return;
    }

    // Determine directional side from consensus
    let side: TradeSide | null = null;
    if (
      snapshot.consensusBias === 'BULLISH' ||
      snapshot.recommendedAction === 'BUY' ||
      snapshot.recommendedAction === 'STRONG_BUY'
    ) {
      side = 'BUY';
    } else if (
      snapshot.consensusBias === 'BEARISH' ||
      snapshot.recommendedAction === 'SELL' ||
      snapshot.recommendedAction === 'STRONG_SELL'
    ) {
      side = 'SELL';
    }

    if (!side) {
      return;
    }

    const latch = this.getLatch(symbol, side);
    const now = Date.now();

    // Trigger condition: must be armed, score >= 60%, and cooldown satisfied
    if (!latch.isArmed) {
      return;
    }

    if (now - latch.lastTriggeredAt < this.COOLDOWN_MS) {
      return;
    }

    // Stateful rising-edge trigger: disarm immediately and record trigger timestamp
    latch.isArmed = false;
    latch.lastTriggeredAt = now;

    // Suppress duplicate if an open shadow setup already exists for this (symbol, side)
    if (this.repo.hasOpenShadowSetup(symbol, side)) {
      return;
    }

    // Compute virtual bracket levels: 1.5 ATR SL and TP
    const sl = side === 'BUY' ? markPrice - 1.5 * atr : markPrice + 1.5 * atr;
    const tp = side === 'BUY' ? markPrice + 1.5 * atr : markPrice - 1.5 * atr;
    const expires_at = now + this.EXPIRY_HORIZON_MS;

    const vetoReasons: string[] = [];
    if (snapshot.macroVetoActive) {
      vetoReasons.push('MACRO_VETO');
    }
    if (Array.isArray((snapshot as any).vetoReasons)) {
      for (const r of (snapshot as any).vetoReasons) {
        if (!vetoReasons.includes(r)) vetoReasons.push(r);
      }
    }

    const record: DecisionLogRecord = {
      id: `dec_${randomUUID()}`,
      timestamp: now,
      symbol,
      side,
      action: 'BLOCKED',
      composite_score: score,
      pillars_json: JSON.stringify(snapshot.pillars || []),
      macro_regime: snapshot.macroRegime || 'DEGRADED',
      macro_veto_active: snapshot.macroVetoActive ? 1 : 0,
      veto_reasons_json: vetoReasons.length > 0 ? JSON.stringify(vetoReasons) : null,
      execution_price: markPrice,
      margin_usd: 100, // Standard simulated margin
      leverage: 10,   // Standard simulated leverage
      atr,
      trade_id: null,
      shadow_status: 'OPEN',
      shadow_sl: Number(sl.toFixed(4)),
      shadow_tp: Number(tp.toFixed(4)),
      shadow_pnl_usd: null,
      expires_at,
      shadow_closed_at: null,
      error_message: null,
      created_at: now,
    };

    this.repo.insert(record);
  }

  /**
   * Records production trade execution or failure directly into SQLite
   * and immediately disarms the hysteresis latch for that (symbol, side).
   */
  public recordExecution(params: RecordExecutionParams): void {
    const now = Date.now();
    const symbol = params.symbol.toUpperCase().trim();

    // Immediately disarm latch for this (symbol, side)
    const latch = this.getLatch(symbol, params.side);
    latch.isArmed = false;
    latch.lastTriggeredAt = now;

    const record: DecisionLogRecord = {
      id: `dec_${randomUUID()}`,
      timestamp: now,
      symbol,
      side: params.side,
      action: params.action,
      composite_score: params.compositeScore ?? (params.action === 'EXECUTED' ? 75 : 0),
      pillars_json: params.pillarsJson ?? '[]',
      macro_regime: params.macroRegime ?? 'MACRO_BULLISH',
      macro_veto_active: params.macroVetoActive ? 1 : 0,
      veto_reasons_json: params.vetoReasonsJson ?? null,
      execution_price: params.price,
      margin_usd: params.marginUsd,
      leverage: params.leverage,
      atr: params.atr,
      trade_id: params.tradeId ?? null,
      shadow_status: null,
      shadow_sl: null,
      shadow_tp: null,
      shadow_pnl_usd: null,
      expires_at: null,
      shadow_closed_at: null,
      error_message: params.errorMessage ?? null,
      created_at: now,
    };

    this.repo.insert(record);
  }

  /**
   * Evaluates open shadow setups on closed 1m candle events.
   * KlineCandle.time is in Unix SECONDS. Setup timestamp and expires_at are in Unix MILLISECONDS.
   * Strictly ignores candles where candle.time * 1000 < setup.timestamp (zero look-behind bias).
   */
  public onCandleClose(symbol: string, candle: KlineCandle): void {
    const sym = symbol.toUpperCase().trim();
    const candleMs = candle.time * 1000;
    const openSetups = this.repo.getOpenShadowSetups(sym);

    for (const setup of openSetups) {
      // Ignore prior candles before setup creation
      if (candleMs < setup.timestamp) {
        continue;
      }

      const entryPrice = setup.execution_price;
      const marginUsd = setup.margin_usd;
      const leverage = setup.leverage;
      const positionSize = (marginUsd * leverage) / entryPrice;
      const notionalValue = marginUsd * leverage;
      const frictionUsd = notionalValue * this.FRICTION_RATE;

      const side = setup.side;
      const sl = setup.shadow_sl!;
      const tp = setup.shadow_tp!;

      let slHit = false;
      let tpHit = false;

      if (side === 'BUY') {
        slHit = candle.low <= sl;
        tpHit = candle.high >= tp;
      } else {
        slHit = candle.high >= sl;
        tpHit = candle.low <= tp;
      }

      // 1. Dual-wick volatility conflict resolution ($0.00 Net PnL)
      if (slHit && tpHit) {
        this.repo.updateShadowOutcome(
          setup.id,
          'RESOLVED_AMBIGUOUS_VOLATILITY',
          0.0,
          candleMs
        );
        continue;
      }

      // 2. Stop Loss Trigger -> SAVED_CAPITAL
      if (slHit) {
        const exitPrice = sl;
        const grossPnl =
          side === 'BUY'
            ? (exitPrice - entryPrice) * positionSize
            : (entryPrice - exitPrice) * positionSize;
        const netPnl = Number((grossPnl - frictionUsd).toFixed(2));
        this.repo.updateShadowOutcome(setup.id, 'SAVED_CAPITAL', netPnl, candleMs);
        continue;
      }

      // 3. Take Profit Trigger -> MISSED_PROFIT or SAVED_CAPITAL (scratch trade)
      if (tpHit) {
        const exitPrice = tp;
        const grossPnl =
          side === 'BUY'
            ? (exitPrice - entryPrice) * positionSize
            : (entryPrice - exitPrice) * positionSize;
        const netPnl = Number((grossPnl - frictionUsd).toFixed(2));
        const outcome: ShadowSetupStatus = netPnl > 0 ? 'MISSED_PROFIT' : 'SAVED_CAPITAL';
        this.repo.updateShadowOutcome(setup.id, outcome, netPnl, candleMs);
        continue;
      }

      // 4. Expiration Horizon (60m mark-to-market close)
      if (setup.expires_at !== null && candleMs >= setup.expires_at) {
        const exitPrice = candle.close;
        const grossPnl =
          side === 'BUY'
            ? (exitPrice - entryPrice) * positionSize
            : (entryPrice - exitPrice) * positionSize;
        const netPnl = Number((grossPnl - frictionUsd).toFixed(2));
        this.repo.updateShadowOutcome(setup.id, 'EXPIRED', netPnl, candleMs);
        continue;
      }
    }
  }

  /**
   * Reconciles offline kline gaps for open setups on server startup.
   */
  public async recoverDowntimeGaps(client: BinanceClient): Promise<void> {
    const openSetups = this.repo.getOpenShadowSetups();
    for (const setup of openSetups) {
      try {
        const startTime = setup.timestamp;
        const endTime = Math.min(Date.now(), setup.expires_at ?? Date.now());
        const klines = await client.getKlines(setup.symbol, '1m', 60, startTime, endTime);
        if (!Array.isArray(klines)) continue;

        for (const k of klines) {
          let candle: KlineCandle;
          if (Array.isArray(k)) {
            candle = {
              time: Math.floor(Number(k[0]) / 1000),
              open: Number(k[1]),
              high: Number(k[2]),
              low: Number(k[3]),
              close: Number(k[4]),
              volume: Number(k[5]),
            };
          } else {
            candle = k;
          }

          this.onCandleClose(setup.symbol, candle);

          // Check if setup is already resolved
          const stillOpen = this.repo
            .getOpenShadowSetups(setup.symbol)
            .some((s) => s.id === setup.id);
          if (!stillOpen) {
            break;
          }
        }
      } catch {
        // Tolerated on recovery failures
      }
    }
  }

  /**
   * Generates dynamic session summary and aggregated metrics.
   */
  public generateSessionSummary(sinceMs?: number): DailyAuditResponse {
    const records = this.repo.listSessionDecisions(sinceMs ?? 0);

    let executed_trades = 0;
    let blocked_setups = 0;
    let capital_saved_usd = 0;
    let missed_profit_usd = 0;
    let expired_pnl_usd = 0;
    const veto_breakdown: Record<string, number> = {};

    for (const record of records) {
      if (record.action === 'EXECUTED') {
        executed_trades += 1;
      } else if (record.action === 'BLOCKED') {
        blocked_setups += 1;
      }

      if (record.shadow_status === 'SAVED_CAPITAL' && typeof record.shadow_pnl_usd === 'number') {
        capital_saved_usd += Math.abs(record.shadow_pnl_usd);
      } else if (record.shadow_status === 'MISSED_PROFIT' && typeof record.shadow_pnl_usd === 'number') {
        missed_profit_usd += record.shadow_pnl_usd;
      } else if (record.shadow_status === 'EXPIRED' && typeof record.shadow_pnl_usd === 'number') {
        expired_pnl_usd += record.shadow_pnl_usd;
      }

      if (record.veto_reasons_json) {
        try {
          const reasons = JSON.parse(record.veto_reasons_json);
          if (Array.isArray(reasons)) {
            for (const r of reasons) {
              const key = String(r);
              veto_breakdown[key] = (veto_breakdown[key] || 0) + 1;
            }
          }
        } catch {
          // Ignored
        }
      } else if (record.macro_veto_active) {
        veto_breakdown['MACRO_VETO'] = (veto_breakdown['MACRO_VETO'] || 0) + 1;
      }
    }

    capital_saved_usd = Number(capital_saved_usd.toFixed(2));
    missed_profit_usd = Number(missed_profit_usd.toFixed(2));
    expired_pnl_usd = Number(expired_pnl_usd.toFixed(2));
    const net_risk_value_usd = Number((capital_saved_usd - missed_profit_usd).toFixed(2));

    const subThresholdEvents = this.pillarRepo
      ? this.pillarRepo.listEventsSince(sinceMs ?? 0).filter((e) => e.composite_score < 60)
      : [];

    const summary: DailyAuditSummary = {
      total_setups: records.length,
      executed_trades,
      blocked_setups,
      sub_threshold_impulses: subThresholdEvents.length,
      capital_saved_usd,
      missed_profit_usd,
      expired_pnl_usd,
      net_risk_value_usd,
      veto_breakdown,
    };

    return {
      summary,
      records,
      sub_threshold_impulses: subThresholdEvents,
      generated_at: Date.now(),
    };
  }

  /**
   * Formats DailyAuditResponse into a human-readable Markdown report for download and operator review.
   */
  public formatMarkdownReport(response: DailyAuditResponse): string {
    const { summary, records, sub_threshold_impulses, generated_at } = response;
    const dateStr = new Date(generated_at).toISOString();

    let md = `# TradeOS Daily Decision Audit & Shadow Report\n\n`;
    md += `**Generated:** ${dateStr}  \n`;
    md += `**Total Setups Evaluated:** ${summary.total_setups}  \n`;
    md += `**Executed Trades:** ${summary.executed_trades}  \n`;
    md += `**Blocked Setups (>=60%):** ${summary.blocked_setups}  \n`;
    md += `**Sub-Threshold Impulses (<60%):** ${summary.sub_threshold_impulses ?? 0}  \n\n`;

    md += `## Risk & Counterfactual Valuation Summary\n\n`;
    md += `| Metric | Value (USD) |\n`;
    md += `| :--- | :--- |\n`;
    md += `| Capital Saved | $${summary.capital_saved_usd.toFixed(2)} |\n`;
    md += `| Missed Profit | $${summary.missed_profit_usd.toFixed(2)} |\n`;
    md += `| Expired PnL | $${summary.expired_pnl_usd.toFixed(2)} |\n`;
    md += `| **Net Risk Value** | **$${summary.net_risk_value_usd.toFixed(2)}** |\n\n`;

    md += `## Veto Reasons Breakdown\n\n`;
    const vetoKeys = Object.keys(summary.veto_breakdown);
    if (vetoKeys.length === 0) {
      md += `*No vetoed setups recorded in this session.*\n\n`;
    } else {
      md += `| Veto Reason | Count |\n`;
      md += `| :--- | :--- |\n`;
      for (const key of vetoKeys) {
        md += `| ${key} | ${summary.veto_breakdown[key]} |\n`;
      }
      md += `\n`;
    }

    md += `## Sub-Threshold Market Impulses (<60% Consensus)\n\n`;
    const impulses = sub_threshold_impulses ?? [];
    if (impulses.length === 0) {
      md += `*No sub-threshold market impulses recorded in this session.*\n\n`;
    } else {
      md += `| ID | Time | Symbol | Trigger | Side | Score | Active Pillars | Entry Price | Status |\n`;
      md += `| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |\n`;
      for (const imp of impulses) {
        const timeStr = new Date(imp.timestamp).toISOString().slice(11, 19);
        const scoreStr = `${imp.composite_score}%`;
        const priceStr = imp.mark_price.toFixed(2);
        md += `| ${imp.id ?? '-'} | ${timeStr} | ${imp.symbol} | ${imp.trigger_type} | ${imp.consensus_side} | ${scoreStr} | ${imp.active_pillars_count}/7 | ${priceStr} | ${imp.status} |\n`;
      }
      md += `\n`;
    }

    md += `## Decision Log Records\n\n`;
    if (records.length === 0) {
      md += `*No decision records available for this session.*\n`;
    } else {
      md += `| ID | Time | Symbol | Side | Action | Score | Macro | Price | Status | Shadow PnL |\n`;
      md += `| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |\n`;
      for (const r of records) {
        const timeStr = new Date(r.timestamp).toISOString().slice(11, 19);
        const scoreStr = `${r.composite_score}%`;
        const priceStr = r.execution_price.toFixed(2);
        const statusStr = r.shadow_status ?? (r.action === 'EXECUTED' ? 'EXECUTED' : 'N/A');
        const pnlStr =
          typeof r.shadow_pnl_usd === 'number' ? `$${r.shadow_pnl_usd.toFixed(2)}` : '-';
        md += `| ${r.id} | ${timeStr} | ${r.symbol} | ${r.side} | ${r.action} | ${scoreStr} | ${r.macro_regime} | ${priceStr} | ${statusStr} | ${pnlStr} |\n`;
      }
    }

    return md;
  }
}
