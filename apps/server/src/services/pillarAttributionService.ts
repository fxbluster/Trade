import type { DatabaseSync } from 'node:sqlite';
import type {
  ConfluenceSnapshot,
  ConfluencePillarId,
  KlineCandle,
  TrajectoryHorizon,
  ImpulseTriggerType,
  TrajectoryOutcome,
  PillarAttributionStatus,
  PillarTelemetryRecord,
  PillarHorizonEvaluation,
  PillarScorecardItem,
  PillarAttributionResponse,
  PillarSnapshotJson,
} from '@tradeos/shared';
import {
  PillarTelemetryRepo,
  PILLAR_CONFIGS,
} from '../db/sqlite.js';
import type { BinanceClient } from '../exchange/binanceClient.js';

export interface PillarAttributionOptions {
  flushIntervalMs?: number;
  maxQueueSize?: number;
  coalesceWindowMs?: number;
}

export interface EventTrajectoryState {
  eventId: number;
  symbol: string;
  entryPrice: number;
  atr14: number;
  atrPct: number;
  timestamp: number;
  side: 'BUY' | 'SELL' | 'NEUTRAL';
  maxHigh: number;
  minLow: number;
  runningMfePct: number;
  runningMaePct: number;
  isStoppedOut: boolean;
  settledHorizons: Set<TrajectoryHorizon>;
}

export const HORIZONS: Array<{ key: TrajectoryHorizon; durationMs: number }> = [
  { key: '1m', durationMs: 60_000 },
  { key: '5m', durationMs: 300_000 },
  { key: '15m', durationMs: 900_000 },
  { key: '60m', durationMs: 3_600_000 },
];

export class PillarAttributionService {
  private repo: PillarTelemetryRepo;
  private queue: Array<Omit<PillarTelemetryRecord, 'id'> & { id?: number }> = [];
  private readonly maxQueueSize: number;
  private readonly flushIntervalMs: number;
  private readonly coalesceWindowMs: number;
  private flushTimer: ReturnType<typeof setInterval> | null = null;

  // State tracking per pillar and symbol
  private lastPillarVotes: Map<string, string> = new Map();
  private lastVolatilityCandleTime: Map<string, number> = new Map();
  private activeCoalescingEvents: Map<string, { event: PillarTelemetryRecord; openedAt: number }> = new Map();
  private activeTrajectories: Map<number, EventTrajectoryState> = new Map();

  constructor(
    repoOrDb: PillarTelemetryRepo | DatabaseSync,
    options: PillarAttributionOptions = {}
  ) {
    if (repoOrDb instanceof PillarTelemetryRepo) {
      this.repo = repoOrDb;
    } else {
      this.repo = new PillarTelemetryRepo(repoOrDb);
    }

    this.flushIntervalMs = options.flushIntervalMs ?? 1000;
    this.maxQueueSize = options.maxQueueSize ?? 5000;
    this.coalesceWindowMs = options.coalesceWindowMs ?? 10_000;

    if (this.flushIntervalMs > 0) {
      this.flushTimer = setInterval(() => {
        this.flush();
      }, this.flushIntervalMs);

      if (this.flushTimer && typeof this.flushTimer.unref === 'function') {
        this.flushTimer.unref();
      }
    }
  }

  public getRepo(): PillarTelemetryRepo {
    return this.repo;
  }

  public getQueueLength(): number {
    return this.queue.length;
  }

  public destroy(): void {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    this.flush();
  }

  /**
   * Immediately flushes all queued telemetry records to SQLite in a single transaction.
   */
  public flush(): number[] {
    if (this.queue.length === 0) return [];
    const batch = this.queue.splice(0, this.queue.length);
    return this.repo.insertBatch(batch);
  }

  /**
   * Evaluates incoming 4Hz market tick in O(1) time without synchronous SQLite I/O.
   * Debounces state changes per pillar and coalesces directional confirmations within 10 seconds.
   */
  public evaluateTick(
    symbol: string,
    markPrice: number,
    atr: number,
    confluenceSnapshot: ConfluenceSnapshot,
    currentCandle?: KlineCandle
  ): void {
    const sym = symbol.toUpperCase().trim();
    const now = Date.now();

    // Map the 7 pillars from snapshot
    const votes: Record<string, 'BUY' | 'SELL' | 'WAIT'> = {
      p1: 'WAIT',
      p2: 'WAIT',
      p3: 'WAIT',
      p4: 'WAIT',
      p5: 'WAIT',
      p6: 'WAIT',
      p7: 'WAIT',
    };

    const snapshots: Record<string, PillarSnapshotJson> = {
      p1: { state: 'WAIT', bias: 'NEUTRAL', score: 50, confirmed: false, rawText: '' },
      p2: { state: 'WAIT', bias: 'NEUTRAL', score: 50, confirmed: false, rawText: '' },
      p3: { state: 'WAIT', bias: 'NEUTRAL', score: 50, confirmed: false, rawText: '' },
      p4: { state: 'WAIT', bias: 'NEUTRAL', score: 50, confirmed: false, rawText: '' },
      p5: { state: 'WAIT', bias: 'NEUTRAL', score: 50, confirmed: false, rawText: '' },
      p6: { state: 'WAIT', bias: 'NEUTRAL', score: 50, confirmed: false, rawText: '' },
      p7: { state: 'WAIT', bias: 'NEUTRAL', score: 50, confirmed: false, rawText: '' },
    };

    const transitionedPillars: Array<{ pKey: string; id: ConfluencePillarId; vote: 'BUY' | 'SELL' }> = [];
    let buyCount = 0;
    let sellCount = 0;

    for (const cfg of PILLAR_CONFIGS) {
      const p = confluenceSnapshot.pillars?.find((item) => item.id === cfg.id);
      let vote: 'BUY' | 'SELL' | 'WAIT' = 'WAIT';
      if (p) {
        if (p.bias === 'BULLISH') vote = 'BUY';
        else if (p.bias === 'BEARISH') vote = 'SELL';
        snapshots[cfg.pKey] = {
          state: p.valueText || p.subText || p.bias,
          bias: p.bias,
          score: p.score,
          confirmed: p.confirmed,
          rawText: p.subText || p.valueText || '',
        };
      }
      votes[cfg.pKey] = vote;

      if (vote === 'BUY') buyCount++;
      if (vote === 'SELL') sellCount++;

      // Check per-pillar state transition
      const key = `${sym}:${cfg.id}`;
      const lastVote = this.lastPillarVotes.get(key) ?? 'WAIT';
      if (vote !== 'WAIT' && vote !== lastVote) {
        transitionedPillars.push({ pKey: cfg.pKey, id: cfg.id, vote });
      }
      this.lastPillarVotes.set(key, vote);
    }

    const activeVotesCount = buyCount + sellCount;

    // Guard ATR for low-price assets so percentage/bps scaling never collapses to 0
    const effectiveAtr =
      Number.isFinite(atr) && atr > 0
        ? atr
        : markPrice > 0
          ? markPrice * 0.0015
          : 0;

    // Check candle volatility expansion using percentage / bps normalization
    let volatilityTrigger = false;
    if (currentCandle && effectiveAtr > 0 && markPrice > 0) {
      const rangePct = (currentCandle.high - currentCandle.low) / markPrice;
      const atrPct = effectiveAtr / markPrice;
      if (rangePct >= 1.5 * atrPct) {
        const lastCandleTime = this.lastVolatilityCandleTime.get(sym);
        if (lastCandleTime !== currentCandle.time) {
          volatilityTrigger = true;
          this.lastVolatilityCandleTime.set(sym, currentCandle.time);
        }
      }
    }

    // If no pillar transition to an active directional vote and no volatility trigger, return
    if (!volatilityTrigger && transitionedPillars.length === 0) {
      return;
    }

    // Check 10-second coalescing window for an active impulse on this symbol
    const coalescing = this.activeCoalescingEvents.get(sym);
    if (coalescing && now - coalescing.openedAt < this.coalesceWindowMs) {
      // Check if any newly transitioning pillar votes in the same direction
      const matchingTransitions = transitionedPillars.filter(
        (t) => t.vote === coalescing.event.consensus_side
      );

      if (matchingTransitions.length > 0) {
        // Coalesce / join the active event
        for (const t of matchingTransitions) {
          (coalescing.event as any)[`${t.pKey}_vote`] = t.vote;
          (coalescing.event as any)[`${t.pKey}_${this.getPillarColumnSuffix(t.pKey)}`] = JSON.stringify(
            snapshots[t.pKey]
          );
        }

        // Recalculate active pillars count
        let newActiveCount = 0;
        for (const cfg of PILLAR_CONFIGS) {
          const v = (coalescing.event as any)[`${cfg.pKey}_vote`];
          if (v === 'BUY' || v === 'SELL') newActiveCount++;
        }
        coalescing.event.active_pillars_count = newActiveCount;
        coalescing.event.composite_score = confluenceSnapshot.compositeScore;

        // If the event was already inserted into SQLite, update the record
        if (coalescing.event.id) {
          this.repo.updateEventDetails(coalescing.event);
        }
        return;
      }
    }

    // Determine consensus_side and trigger_type for a new impulse
    let consensusSide: 'BUY' | 'SELL' | 'NEUTRAL' = 'NEUTRAL';
    let triggerType: ImpulseTriggerType = 'PILLAR_DIVERGENCE';

    if (volatilityTrigger && activeVotesCount === 0) {
      triggerType = 'VOLATILITY_EXPANSION';
      consensusSide = currentCandle && currentCandle.close >= currentCandle.open ? 'BUY' : 'SELL';
    } else if (confluenceSnapshot.compositeScore >= 50) {
      triggerType = 'CONSENSUS_ATTEMPT';
      if (
        confluenceSnapshot.consensusBias === 'BULLISH' ||
        confluenceSnapshot.recommendedAction === 'BUY' ||
        confluenceSnapshot.recommendedAction === 'STRONG_BUY'
      ) {
        consensusSide = 'BUY';
      } else if (
        confluenceSnapshot.consensusBias === 'BEARISH' ||
        confluenceSnapshot.recommendedAction === 'SELL' ||
        confluenceSnapshot.recommendedAction === 'STRONG_SELL'
      ) {
        consensusSide = 'SELL';
      } else {
        consensusSide = buyCount >= sellCount ? 'BUY' : 'SELL';
      }
    } else {
      triggerType = 'PILLAR_DIVERGENCE';
      if (buyCount > sellCount) {
        consensusSide = 'BUY';
      } else if (sellCount > buyCount) {
        consensusSide = 'SELL';
      } else {
        // Tie-breaker: highest-weighted active pillar
        let maxWeight = -1;
        let tieSide: 'BUY' | 'SELL' | null = null;
        for (const cfg of PILLAR_CONFIGS) {
          const vote = votes[cfg.pKey];
          if ((vote === 'BUY' || vote === 'SELL') && cfg.baselineWeight > maxWeight) {
            maxWeight = cfg.baselineWeight;
            tieSide = vote;
          }
        }
        consensusSide = tieSide ?? 'NEUTRAL';
      }
    }

    const event: PillarTelemetryRecord = {
      timestamp: now,
      symbol: sym,
      trigger_type: triggerType,
      mark_price: markPrice,
      atr_14: effectiveAtr,
      composite_score: confluenceSnapshot.compositeScore,
      consensus_side: consensusSide,
      active_pillars_count: activeVotesCount,
      p1_vote: votes.p1,
      p2_vote: votes.p2,
      p3_vote: votes.p3,
      p4_vote: votes.p4,
      p5_vote: votes.p5,
      p6_vote: votes.p6,
      p7_vote: votes.p7,
      p1_macro_regime: JSON.stringify(snapshots.p1),
      p2_native_smc: JSON.stringify(snapshots.p2),
      p3_cvd_absorption: JSON.stringify(snapshots.p3),
      p4_order_flow_l2: JSON.stringify(snapshots.p4),
      p5_liq_clusters: JSON.stringify(snapshots.p5),
      p6_momentum_rvol: JSON.stringify(snapshots.p6),
      p7_sentiment_macro: JSON.stringify(snapshots.p7),
      status: 'EVALUATING',
    };

    // Set active coalescing event
    this.activeCoalescingEvents.set(sym, { event, openedAt: now });

    // Enqueue in ring-buffer queue
    if (this.queue.length >= this.maxQueueSize) {
      this.queue.shift(); // Drop oldest record on capacity overflow
    }
    this.queue.push(event);
  }

  private getPillarColumnSuffix(pKey: string): string {
    switch (pKey) {
      case 'p1': return 'macro_regime';
      case 'p2': return 'native_smc';
      case 'p3': return 'cvd_absorption';
      case 'p4': return 'order_flow_l2';
      case 'p5': return 'liq_clusters';
      case 'p6': return 'momentum_rvol';
      case 'p7': return 'sentiment_macro';
      default: return 'state';
    }
  }

  /**
   * Evaluates closed 1m candle events against open trajectories.
   * Path-dependent excursion tracking with early adverse stopout termination.
   */
  public onClosedCandle(symbol: string, candle: KlineCandle): void {
    const sym = symbol.toUpperCase().trim();
    // Normalize candle timestamps (seconds to ms)
    const candleMs = candle.time > 10_000_000_000 ? candle.time : candle.time * 1000;
    const candleCloseMs = candleMs + 60_000;

    // Flush any pending queue items so all open events are in SQLite
    this.flush();

    const openEvents = this.repo.getOpenEvents(sym);
    if (openEvents.length === 0) return;

    for (const event of openEvents) {
      if (!event.id) continue;

      // Ignore candles that opened prior to event creation (zero look-behind bias)
      if (candleMs < event.timestamp) {
        continue;
      }

      // Check if event is expired (> 65 minutes)
      if (candleCloseMs > event.timestamp + 3_900_000) {
        this.repo.updateEventStatus(event.id, 'EXPIRED');
        this.activeTrajectories.delete(event.id);
        continue;
      }

      let traj = this.activeTrajectories.get(event.id);
      if (!traj) {
        const existingEvals = this.repo.getEvaluationsForEvent(event.id);
        const settledSet = new Set<TrajectoryHorizon>(existingEvals.map((e) => e.horizon));
        const rawAtrPct =
          event.mark_price > 0 && event.atr_14 > 0
            ? (event.atr_14 / event.mark_price) * 100
            : 0;
        const atrPct = rawAtrPct > 0 ? rawAtrPct : 0.15; // 15 bps fallback if historical atr_14 was 0
        traj = {
          eventId: event.id,
          symbol: sym,
          entryPrice: event.mark_price,
          atr14: event.atr_14 > 0 ? event.atr_14 : event.mark_price * 0.0015,
          atrPct,
          timestamp: event.timestamp,
          side: event.consensus_side,
          maxHigh: candle.high,
          minLow: candle.low,
          runningMfePct: 0,
          runningMaePct: 0,
          isStoppedOut: false,
          settledHorizons: settledSet,
        };
        this.activeTrajectories.set(event.id, traj);
      }

      // Update running high / low
      traj.maxHigh = Math.max(traj.maxHigh, candle.high);
      traj.minLow = Math.min(traj.minLow, candle.low);

      if (traj.side === 'BUY') {
        traj.runningMfePct = ((traj.maxHigh - traj.entryPrice) / traj.entryPrice) * 100;
        traj.runningMaePct = ((traj.entryPrice - traj.minLow) / traj.entryPrice) * 100;
      } else if (traj.side === 'SELL') {
        traj.runningMfePct = ((traj.entryPrice - traj.minLow) / traj.entryPrice) * 100;
        traj.runningMaePct = ((traj.maxHigh - traj.entryPrice) / traj.entryPrice) * 100;
      } else {
        traj.runningMfePct =
          (Math.max(traj.maxHigh - traj.entryPrice, traj.entryPrice - traj.minLow) /
            traj.entryPrice) *
          100;
        traj.runningMaePct = 0;
      }

      // Check early path-dependent stopout termination
      // If Running MAE >= 1.5 * ATR% before Running MFE >= 1.0 * ATR%
      if (!traj.isStoppedOut && traj.runningMaePct >= 1.5 * traj.atrPct && traj.runningMfePct < 1.0 * traj.atrPct) {
        traj.isStoppedOut = true;
      }

      // If stopped out, settle all remaining horizons as ADVERSE_STOPOUT immediately
      if (traj.isStoppedOut) {
        for (const hz of HORIZONS) {
          if (!traj.settledHorizons.has(hz.key)) {
            this.recordHorizonOutcome(event, traj, hz.key, 'ADVERSE_STOPOUT', candle, candleCloseMs);
            traj.settledHorizons.add(hz.key);
          }
        }
        this.activeTrajectories.delete(event.id);
        continue;
      }

      // Evaluate horizons chronological boundary
      for (const hz of HORIZONS) {
        if (traj.settledHorizons.has(hz.key)) {
          continue;
        }

        if (candleCloseMs >= event.timestamp + hz.durationMs) {
          let outcome: TrajectoryOutcome;
          if (traj.runningMfePct >= 1.0 * traj.atrPct) {
            if (traj.side === 'BUY') outcome = 'BULLISH_EXPANSION';
            else if (traj.side === 'SELL') outcome = 'BEARISH_EXPANSION';
            else outcome = candle.close >= traj.entryPrice ? 'BULLISH_EXPANSION' : 'BEARISH_EXPANSION';
          } else {
            outcome = 'CHOP';
          }

          this.recordHorizonOutcome(event, traj, hz.key, outcome, candle, candleCloseMs);
          traj.settledHorizons.add(hz.key);

          if (hz.key === '60m') {
            this.activeTrajectories.delete(event.id);
          }
        }
      }
    }
  }

  private recordHorizonOutcome(
    event: PillarTelemetryRecord,
    traj: EventTrajectoryState,
    horizon: TrajectoryHorizon,
    outcome: TrajectoryOutcome,
    candle: KlineCandle,
    settleTimestamp: number
  ): void {
    const rawAbsDiff = Math.abs(candle.close - traj.entryPrice);
    const priceChangeAbs = Number(rawAbsDiff.toFixed(rawAbsDiff < 0.01 ? 6 : 4));
    const priceChangePct = Number(
      (((candle.close - traj.entryPrice) / traj.entryPrice) * 100).toFixed(4)
    );

    const evalRecord: Omit<PillarHorizonEvaluation, 'id'> = {
      event_id: event.id!,
      horizon,
      settle_timestamp: settleTimestamp,
      settle_price: candle.close,
      price_change_abs: priceChangeAbs,
      price_change_pct: priceChangePct,
      mfe_pct: Number(traj.runningMfePct.toFixed(4)),
      mae_pct: Number(traj.runningMaePct.toFixed(4)),
      directional_outcome: outcome,
      p1_status: this.getPillarStatus(event.p1_vote, outcome, event.consensus_side),
      p2_status: this.getPillarStatus(event.p2_vote, outcome, event.consensus_side),
      p3_status: this.getPillarStatus(event.p3_vote, outcome, event.consensus_side),
      p4_status: this.getPillarStatus(event.p4_vote, outcome, event.consensus_side),
      p5_status: this.getPillarStatus(event.p5_vote, outcome, event.consensus_side),
      p6_status: this.getPillarStatus(event.p6_vote, outcome, event.consensus_side),
      p7_status: this.getPillarStatus(event.p7_vote, outcome, event.consensus_side),
    };

    this.repo.recordHorizonEvaluation(evalRecord);
  }

  private getPillarStatus(
    vote: string,
    outcome: TrajectoryOutcome,
    consensusSide: string
  ): PillarAttributionStatus {
    if (outcome === 'ADVERSE_STOPOUT') {
      if (vote === consensusSide) return 'FALSE_POSITIVE';
      if (vote === 'WAIT') return 'TRUE_NEGATIVE';
      return 'TRUE_POSITIVE';
    }

    if (outcome === 'BULLISH_EXPANSION') {
      if (vote === 'BUY') return 'TRUE_POSITIVE';
      if (vote === 'WAIT') return 'FALSE_NEGATIVE';
      if (vote === 'SELL') return 'FALSE_POSITIVE';
      return 'NEUTRAL';
    }

    if (outcome === 'BEARISH_EXPANSION') {
      if (vote === 'SELL') return 'TRUE_POSITIVE';
      if (vote === 'WAIT') return 'FALSE_NEGATIVE';
      if (vote === 'BUY') return 'FALSE_POSITIVE';
      return 'NEUTRAL';
    }

    // CHOP / Equilibrium
    if (vote === 'WAIT') return 'TRUE_NEGATIVE';
    if (vote === 'BUY' || vote === 'SELL') return 'FALSE_POSITIVE';
    return 'NEUTRAL';
  }

  /**
   * Retroactively reconciles closed klines for open events after downtime or restart.
   */
  public async recoverDowntimeGaps(client: BinanceClient): Promise<void> {
    const openEvents = this.repo.getOpenEvents();
    for (const event of openEvents) {
      if (!event.id) continue;
      try {
        const startTime = event.timestamp;
        const endTime = Math.min(Date.now(), event.timestamp + 3_900_000);
        const klines = await client.getKlines(event.symbol, '1m', 1000, startTime, endTime);
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

          this.onClosedCandle(event.symbol, candle);

          const updated = this.repo.getById(event.id);
          if (!updated || updated.status !== 'EVALUATING') {
            break;
          }
        }
      } catch {
        // Recovery errors tolerated
      }
    }
  }

  /**
   * Generates aggregated scorecard and Bayesian shrinkage recommendations for a symbol and horizon.
   */
  public generateScorecard(
    symbol: string = 'SOLUSDT',
    horizon: TrajectoryHorizon = '15m'
  ): PillarAttributionResponse {
    return this.repo.getAttributionResponse(symbol, horizon);
  }

  /**
   * Retrieves individual PillarScorecardItem array.
   */
  public getScorecardItems(
    symbol: string = 'SOLUSDT',
    horizon: TrajectoryHorizon = '15m'
  ): PillarScorecardItem[] {
    return this.repo.getAggregatedScorecard(symbol, horizon);
  }
}
