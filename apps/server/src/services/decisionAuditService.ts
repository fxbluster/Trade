import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type {
  ChasingTelemetrySnapshot,
  ConfluenceSnapshot,
  DailyAuditResponse,
  DailyAuditSummary,
  DecisionAction,
  DecisionLogRecord,
  FactorAttributionSummaryItem,
  FactorTelemetryDbRecord,
  FactorTelemetryEvent,
  KlineCandle,
  MacroRegime,
  ShadowSetupStatus,
  TradeSide,
} from '@tradeos/shared';
import {
  DecisionLogsRepo,
  ExecutionChaseLogsRepo,
  FactorTelemetryRecordsRepo,
  PillarTelemetryRepo,
  type FactorHorizonExcursionPatch,
} from '../db/sqlite.js';
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
  factorTelemetryJson?: string | null;
  executionChaseJson?: string | null;
  sizingBreakdownJson?: string | null;
  noiseBandState?: number | boolean;
}

export interface DecisionAuditServiceOptions {
  factorTelemetryRecordsRepo?: FactorTelemetryRecordsRepo;
  executionChaseLogsRepo?: ExecutionChaseLogsRepo;
  flushIntervalMs?: number;
  maxRingBufferSize?: number;
  onTelemetryEvent?: (event: FactorTelemetryEvent) => void;
  horizonGraceMs?: number;
}

interface TelemetryQueueItem {
  event: FactorTelemetryEvent;
  decisionLogId: string | null;
  isTerminal: boolean;
}

interface HorizonExcursionState {
  maxHigh: number;
  minLow: number;
}

const TERMINAL_TRIGGERS = new Set<string>([
  'SIGNAL_CONFIRMED',
  'POSITION_ENTERED',
  'POSITION_EXITED',
]);

const TERMINAL_CHASING_STATUSES = new Set<string>([
  'FILLED',
  'CANCELED',
  'ABORTED',
]);

const FACTOR_DISPLAY_NAMES: Record<string, string> = {
  ORDER_FLOW_L2: 'Order Flow L2',
  NATIVE_SMC: 'Native SMC',
  CVD_ABSORPTION: 'CVD Absorption',
  MACRO_REGIME: 'Macro Regime',
  FUNDING_ARBITRAGE: 'Funding Arbitrage',
  CROSS_EXCHANGE_SWEEP: 'Cross-Exchange Sweep',
  LIQ_CLUSTERS: 'Liquidity Clusters',
  COMPOSITE: 'Composite Signal',
};

const STANDARD_FACTOR_IDS = Object.keys(FACTOR_DISPLAY_NAMES);

const HARD_MARKDOWN_CHAR_CAP = 14_000;
const CHARS_PER_TOKEN = 3.5;

/**
 * Computes tie-aware fractional average ranks (1-based) for Spearman rank correlation.
 */
function computeAverageRanks(values: number[]): number[] {
  const n = values.length;
  const indexed = values.map((v, idx) => ({ v, idx }));
  indexed.sort((a, b) => a.v - b.v);

  const ranks = new Array<number>(n);
  let i = 0;
  while (i < n) {
    let j = i;
    while (j + 1 < n && indexed[j + 1]!.v === indexed[i]!.v) {
      j++;
    }
    const avgRank = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) {
      ranks[indexed[k]!.idx] = avgRank;
    }
    i = j + 1;
  }
  return ranks;
}

/**
 * Computes tie-aware Spearman rank correlation coefficient (rho in [-1, 1]).
 * Returns 0 when n < 2 or either series has zero variance.
 */
export function computeSpearmanIC(predictions: number[], outcomes: number[]): number {
  const rawLen = Math.min(predictions.length, outcomes.length);
  const xs: number[] = [];
  const ys: number[] = [];
  for (let i = 0; i < rawLen; i++) {
    const x = predictions[i]!;
    const y = outcomes[i]!;
    if (Number.isFinite(x) && Number.isFinite(y)) {
      xs.push(x);
      ys.push(y);
    }
  }

  const n = xs.length;
  if (n < 2) return 0;

  const rankX = computeAverageRanks(xs);
  const rankY = computeAverageRanks(ys);

  let sumX = 0;
  let sumY = 0;
  for (let i = 0; i < n; i++) {
    sumX += rankX[i]!;
    sumY += rankY[i]!;
  }
  const meanX = sumX / n;
  const meanY = sumY / n;

  let num = 0;
  let denX = 0;
  let denY = 0;
  for (let i = 0; i < n; i++) {
    const dx = rankX[i]! - meanX;
    const dy = rankY[i]! - meanY;
    num += dx * dy;
    denX += dx * dx;
    denY += dy * dy;
  }

  const denom = Math.sqrt(denX * denY);
  if (!Number.isFinite(denom) || denom < 1e-12) {
    return 0;
  }

  const rho = num / denom;
  return Math.max(-1, Math.min(1, rho));
}

/**
 * Estimates LLM token count conservatively using ~3.5 characters per token.
 */
export function estimateTokenCount(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/**
 * Deterministically clamps Markdown output to stay within maxTokens (default 4,000)
 * and the hard 14,000-character ceiling.
 */
export function clampMarkdownToTokenBudget(
  markdown: string,
  maxTokens: number = 4000
): string {
  const safeMaxTokens = Math.max(1, Math.floor(maxTokens));
  const hardCharCap = Math.min(
    HARD_MARKDOWN_CHAR_CAP,
    Math.floor(safeMaxTokens * CHARS_PER_TOKEN)
  );

  if (markdown.length <= hardCharCap && estimateTokenCount(markdown) <= safeMaxTokens) {
    return markdown;
  }

  const notice = '\n\n*[Report truncated to fit token budget]*';
  const targetChars =
    safeMaxTokens > 20 ? Math.min(hardCharCap, Math.floor((safeMaxTokens - 1) * CHARS_PER_TOKEN)) : hardCharCap;

  if (targetChars <= notice.length) {
    return markdown.slice(0, targetChars);
  }

  const bodyBudget = targetChars - notice.length;
  let sliced = markdown.slice(0, bodyBudget);
  const lastNewline = sliced.lastIndexOf('\n');
  if (lastNewline > bodyBudget * 0.6) {
    sliced = sliced.slice(0, lastNewline);
  }

  let result = `${sliced.trimEnd()}${notice}`;
  while (
    result.length > HARD_MARKDOWN_CHAR_CAP ||
    estimateTokenCount(result) > safeMaxTokens
  ) {
    const excess = Math.max(1, Math.ceil((result.length - targetChars) / 2) + 8);
    const nextLen = Math.max(0, sliced.length - excess);
    sliced = sliced.slice(0, nextLen);
    result = nextLen > 0 ? `${sliced.trimEnd()}${notice}` : notice.slice(0, targetChars);
    if (nextLen === 0) break;
  }

  return result;
}

function sanitizeCell(value: string | null | undefined, maxLen: number = 64): string {
  if (!value) return '-';
  const cleaned = value.replace(/[\r\n|]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (cleaned.length <= maxLen) return cleaned;
  return `${cleaned.slice(0, Math.max(1, maxLen - 3))}...`;
}

function parseJsonSafe<T>(raw: string | null | undefined): T | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function normalizeCandle(k: unknown): KlineCandle {
  if (Array.isArray(k)) {
    return {
      time: Math.floor(Number(k[0]) / 1000),
      open: Number(k[1]),
      high: Number(k[2]),
      low: Number(k[3]),
      close: Number(k[4]),
      volume: Number(k[5]),
    };
  }
  return k as KlineCandle;
}

export class DecisionAuditService {
  private repo: DecisionLogsRepo;
  private pillarRepo?: PillarTelemetryRepo;
  private factorTelemetryRecordsRepo?: FactorTelemetryRecordsRepo;
  private executionChaseLogsRepo?: ExecutionChaseLogsRepo;
  private db?: DatabaseSync;

  private latches: Map<string, LatchState> = new Map();
  private impulseLatches: Map<string, number> = new Map();
  private telemetryBuffer: TelemetryQueueItem[] = [];
  private horizonStates: Map<number, HorizonExcursionState> = new Map();

  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private flushIntervalMs: number;
  private maxRingBufferSize: number;
  private horizonGraceMs: number;
  private onTelemetryEvent?: (event: FactorTelemetryEvent) => void;
  private microtaskScheduled: boolean = false;
  private disposed: boolean = false;

  private readonly COOLDOWN_MS = 180_000; // 3-minute hysteresis cooldown
  private readonly EXPIRY_HORIZON_MS = 3_600_000; // 60 minutes
  private readonly FRICTION_RATE = 0.0015; // 0.15% notional friction

  constructor(
    repoOrDb: DecisionLogsRepo | DatabaseSync,
    pillarRepo?: PillarTelemetryRepo,
    options: DecisionAuditServiceOptions = {}
  ) {
    if (repoOrDb instanceof DecisionLogsRepo) {
      this.repo = repoOrDb;
      this.pillarRepo = pillarRepo;
      this.factorTelemetryRecordsRepo = options.factorTelemetryRecordsRepo;
      this.executionChaseLogsRepo = options.executionChaseLogsRepo;
    } else {
      this.db = repoOrDb;
      this.repo = new DecisionLogsRepo(repoOrDb);
      this.pillarRepo = pillarRepo ?? new PillarTelemetryRepo(repoOrDb);
      this.factorTelemetryRecordsRepo =
        options.factorTelemetryRecordsRepo ?? new FactorTelemetryRecordsRepo(repoOrDb);
      this.executionChaseLogsRepo =
        options.executionChaseLogsRepo ?? new ExecutionChaseLogsRepo(repoOrDb);
    }

    this.flushIntervalMs = options.flushIntervalMs ?? 500;
    this.maxRingBufferSize = Math.max(1, options.maxRingBufferSize ?? 500);
    this.horizonGraceMs = options.horizonGraceMs ?? 600_000;
    this.onTelemetryEvent = options.onTelemetryEvent;

    this.ensureFlushTimer();
  }

  private ensureFlushTimer(): void {
    if (this.disposed || this.flushTimer || !this.factorTelemetryRecordsRepo) {
      return;
    }
    if (this.flushIntervalMs > 0) {
      this.flushTimer = setInterval(() => {
        try {
          this.flushTelemetryBuffer();
        } catch {
          // Non-fatal background flush guard
        }
      }, this.flushIntervalMs);
      if (typeof this.flushTimer.unref === 'function') {
        this.flushTimer.unref();
      }
    }
  }

  private getDb(): DatabaseSync | undefined {
    if (this.db) return this.db;
    const candidate =
      (this.factorTelemetryRecordsRepo as unknown as { db?: DatabaseSync } | undefined)?.db ??
      (this.repo as unknown as { db?: DatabaseSync } | undefined)?.db;
    if (candidate && typeof candidate.prepare === 'function') {
      return candidate;
    }
    return undefined;
  }

  public setPillarRepo(pillarRepo: PillarTelemetryRepo): void {
    this.pillarRepo = pillarRepo;
  }

  public getPillarRepo(): PillarTelemetryRepo | undefined {
    return this.pillarRepo;
  }

  public setFactorTelemetryRecordsRepo(repo: FactorTelemetryRecordsRepo): void {
    this.factorTelemetryRecordsRepo = repo;
    this.ensureFlushTimer();
  }

  public getFactorTelemetryRecordsRepo(): FactorTelemetryRecordsRepo | undefined {
    return this.factorTelemetryRecordsRepo;
  }

  public setExecutionChaseLogsRepo(repo: ExecutionChaseLogsRepo): void {
    this.executionChaseLogsRepo = repo;
  }

  public getExecutionChaseLogsRepo(): ExecutionChaseLogsRepo | undefined {
    return this.executionChaseLogsRepo;
  }

  public setOnTelemetryEvent(cb?: (event: FactorTelemetryEvent) => void): void {
    this.onTelemetryEvent = cb;
  }

  public getTelemetryBufferLength(): number {
    return this.telemetryBuffer.length;
  }

  private getLatchKey(symbol: string, side: string): string {
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

  private emitTelemetryEvent(event: FactorTelemetryEvent): void {
    if (!this.onTelemetryEvent) return;
    try {
      this.onTelemetryEvent(event);
    } catch {
      // Never allow WS broadcast/listener failures to break telemetry ingestion
    }
  }

  private enqueueTelemetry(item: TelemetryQueueItem): boolean {
    if (this.telemetryBuffer.length >= this.maxRingBufferSize) {
      let evictIdx = this.telemetryBuffer.findIndex(
        (q) => !q.isTerminal && q.event.triggerType === 'ORDER_AMENDED'
      );
      if (evictIdx === -1) {
        evictIdx = this.telemetryBuffer.findIndex((q) => !q.isTerminal);
      }
      if (evictIdx !== -1) {
        this.telemetryBuffer.splice(evictIdx, 1);
      } else if (!item.isTerminal) {
        return false;
      }
    }

    this.telemetryBuffer.push(item);
    return true;
  }

  /**
   * Ingests a Next-Gen FactorTelemetryEvent:
   * - Applies 180s rising-edge hysteresis per (symbol, consensusSide) on SUB_THRESHOLD_IMPULSE (< 70).
   * - Enqueues ORDER_AMENDED into the 500-capacity async ring buffer without sync SQLite writes.
   * - Triggers microtask flush for terminal events (SIGNAL_CONFIRMED, POSITION_ENTERED, POSITION_EXITED,
   *   or chasingTelemetry.status in ['FILLED', 'CANCELED', 'ABORTED']).
   */
  public recordFactorTelemetry(
    event: FactorTelemetryEvent,
    decisionLogId?: string | null
  ): boolean {
    const symbol = event.symbol.toUpperCase().trim();
    const timestamp = Number.isFinite(event.timestamp) ? event.timestamp : Date.now();
    const eventId = event.eventId && event.eventId.length > 0 ? event.eventId : randomUUID();

    const normalizedEvent: FactorTelemetryEvent = {
      ...event,
      eventId,
      symbol,
      timestamp,
    };

    const chasingStatus = normalizedEvent.chasingTelemetry?.status;
    const isTerminal =
      TERMINAL_TRIGGERS.has(normalizedEvent.triggerType) ||
      (chasingStatus !== undefined && TERMINAL_CHASING_STATUSES.has(chasingStatus));

    if (normalizedEvent.triggerType === 'SUB_THRESHOLD_IMPULSE' && !isTerminal) {
      if (normalizedEvent.compositeScore < 70) {
        const key = this.getLatchKey(symbol, normalizedEvent.consensusSide);
        const lastTs = this.impulseLatches.get(key);
        if (lastTs !== undefined && timestamp - lastTs < this.COOLDOWN_MS) {
          return false;
        }
        this.impulseLatches.set(key, timestamp);
      }

      this.emitTelemetryEvent(normalizedEvent);
      if (this.factorTelemetryRecordsRepo) {
        this.factorTelemetryRecordsRepo.insertEventBatch(
          normalizedEvent,
          decisionLogId ?? null
        );
      }
      return true;
    }

    const accepted = this.enqueueTelemetry({
      event: normalizedEvent,
      decisionLogId: decisionLogId ?? null,
      isTerminal,
    });
    if (!accepted) {
      return false;
    }

    this.emitTelemetryEvent(normalizedEvent);

    if (isTerminal && !this.disposed && !this.microtaskScheduled) {
      this.microtaskScheduled = true;
      queueMicrotask(() => {
        this.microtaskScheduled = false;
        if (!this.disposed) {
          try {
            this.flushTelemetryBuffer();
          } catch {
            // Safe background flush guard
          }
        }
      });
    }

    return true;
  }

  /**
   * Flushes all queued telemetry events in the ring buffer to SQLite.
   */
  public flushTelemetryBuffer(): number {
    if (!this.factorTelemetryRecordsRepo || this.telemetryBuffer.length === 0) {
      return 0;
    }

    const batch = this.telemetryBuffer.splice(0, this.telemetryBuffer.length);
    let flushed = 0;
    for (const item of batch) {
      try {
        this.factorTelemetryRecordsRepo.insertEventBatch(item.event, item.decisionLogId);
        flushed += 1;
      } catch {
        // Isolate row-level errors (e.g., closed DB or invalid FK) so other items persist
      }
    }
    return flushed;
  }

  /**
   * Prunes expired SUB_THRESHOLD_IMPULSE records older than retentionDays (default 7).
   */
  public pruneExpiredImpulses(retentionDays: number = 7): number {
    if (!this.factorTelemetryRecordsRepo) return 0;
    return this.factorTelemetryRecordsRepo.pruneOldSubThresholdImpulses(retentionDays);
  }

  /**
   * Stops the background flush timer and synchronously flushes remaining buffered telemetry.
   */
  public dispose(): void {
    this.disposed = true;
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    try {
      this.flushTelemetryBuffer();
    } catch {
      // Safe shutdown guard if DB was already closed
    }
    this.horizonStates.clear();
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
    if (snapshot.blockReason && !vetoReasons.includes(snapshot.blockReason)) {
      vetoReasons.push(snapshot.blockReason);
    }
    if (Array.isArray((snapshot as unknown as { vetoReasons?: unknown[] }).vetoReasons)) {
      for (const r of (snapshot as unknown as { vetoReasons: unknown[] }).vetoReasons) {
        const key = String(r);
        if (!vetoReasons.includes(key)) vetoReasons.push(key);
      }
    }

    const factorPayload = snapshot.telemetryEvent?.activeFactors?.length
      ? snapshot.telemetryEvent.activeFactors
      : snapshot.factorDetails ?? snapshot.factorOutputs ?? null;

    const chasePayload =
      snapshot.telemetryEvent?.chasingTelemetry ?? snapshot.chasingOrder ?? null;

    const sizingPayload =
      snapshot.telemetryEvent?.sizingTelemetry ?? snapshot.sizingBreakdown ?? null;

    const noiseBandActive = Boolean(
      snapshot.noiseBandActive ||
        snapshot.noiseBand?.active ||
        snapshot.telemetryEvent?.noiseBandActive
    );

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
      factor_telemetry_json: factorPayload ? JSON.stringify(factorPayload) : null,
      execution_chase_json: chasePayload ? JSON.stringify(chasePayload) : null,
      sizing_breakdown_json: sizingPayload ? JSON.stringify(sizingPayload) : null,
      noise_band_state: noiseBandActive ? 1 : 0,
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

    const noiseBandState =
      typeof params.noiseBandState === 'boolean'
        ? params.noiseBandState
          ? 1
          : 0
        : params.noiseBandState ?? 0;

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
      factor_telemetry_json: params.factorTelemetryJson ?? null,
      execution_chase_json: params.executionChaseJson ?? null,
      sizing_breakdown_json: params.sizingBreakdownJson ?? null,
      noise_band_state: noiseBandState,
    };

    this.repo.insert(record);
  }

  private getOrInitHorizonState(record: FactorTelemetryDbRecord): HorizonExcursionState {
    const id = record.id!;
    let state = this.horizonStates.get(id);
    if (state) return state;

    const entry = record.entry_price;
    let maxHigh = entry;
    let minLow = entry;

    const knownMfe = Math.max(
      0,
      record.post_1m_mfe ?? 0,
      record.post_5m_mfe ?? 0,
      record.post_15m_mfe ?? 0
    );
    const knownMae = Math.min(
      0,
      record.post_1m_mae ?? 0,
      record.post_5m_mae ?? 0,
      record.post_15m_mae ?? 0
    );

    if (record.consensus_side === 'SELL') {
      minLow = entry * (1 - knownMfe);
      maxHigh = entry * (1 - knownMae);
    } else {
      maxHigh = entry * (1 + knownMfe);
      minLow = entry * (1 + knownMae);
    }

    state = { maxHigh, minLow };
    this.horizonStates.set(id, state);
    return state;
  }

  private settleFactorTelemetryOnCandle(
    sym: string,
    candleMs: number,
    candle: KlineCandle
  ): void {
    if (!this.factorTelemetryRecordsRepo) return;

    const pending = this.factorTelemetryRecordsRepo.getPendingEvaluations(sym);
    for (const record of pending) {
      if (!record.id || record.entry_price <= 0) continue;

      // Zero look-behind guard
      if (candleMs < record.timestamp) {
        continue;
      }

      const hasMissingIntermediate =
        record.post_1m_mfe === null ||
        record.post_5m_mfe === null ||
        record.post_15m_mfe === null;

      if (
        hasMissingIntermediate &&
        candleMs > record.timestamp + this.EXPIRY_HORIZON_MS + this.horizonGraceMs
      ) {
        this.factorTelemetryRecordsRepo.updateHorizonExcursions(record.id, {
          status: 'INCOMPLETE_FEED',
          settle_timestamp: candleMs,
        });
        this.horizonStates.delete(record.id);
        continue;
      }

      const state = this.getOrInitHorizonState(record);
      state.maxHigh = Math.max(state.maxHigh, candle.high);
      state.minLow = Math.min(state.minLow, candle.low);

      const entry = record.entry_price;
      let mfe: number;
      let mae: number;
      if (record.consensus_side === 'SELL') {
        mfe = Math.max(0, (entry - state.minLow) / entry);
        mae = Math.min(0, (entry - state.maxHigh) / entry);
      } else {
        mfe = Math.max(0, (state.maxHigh - entry) / entry);
        mae = Math.min(0, (state.minLow - entry) / entry);
      }
      mfe = Number(mfe.toFixed(6));
      mae = Number(mae.toFixed(6));

      const baseMs = Math.floor(record.timestamp / 1000) * 1000;
      const elapsedMs = candleMs - baseMs;
      const patch: FactorHorizonExcursionPatch = {};

      if (elapsedMs >= 60_000 && record.post_1m_mfe === null) {
        patch.post_1m_mfe = mfe;
        patch.post_1m_mae = mae;
      }
      if (elapsedMs >= 300_000 && record.post_5m_mfe === null) {
        patch.post_5m_mfe = mfe;
        patch.post_5m_mae = mae;
      }
      if (elapsedMs >= 900_000 && record.post_15m_mfe === null) {
        patch.post_15m_mfe = mfe;
        patch.post_15m_mae = mae;
      }
      if (elapsedMs >= this.EXPIRY_HORIZON_MS) {
        patch.post_1h_mfe = mfe;
        patch.post_1h_mae = mae;
        patch.status = 'SETTLED';
        patch.settle_timestamp = candleMs;
        this.horizonStates.delete(record.id);
      }

      if (Object.keys(patch).length > 0) {
        this.factorTelemetryRecordsRepo.updateHorizonExcursions(record.id, patch);
      }
    }
  }

  /**
   * Evaluates open shadow setups and pending factor telemetry records on closed 1m candle events.
   * KlineCandle.time is in Unix SECONDS. Setup/record timestamps are in Unix MILLISECONDS.
   * Strictly ignores candles where candle.time * 1000 < record.timestamp (zero look-behind bias).
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

    this.settleFactorTelemetryOnCandle(sym, candleMs, candle);
  }

  /**
   * Reconciles offline kline gaps for open shadow setups and pending factor telemetry records on boot.
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
          this.onCandleClose(setup.symbol, normalizeCandle(k));
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

    if (!this.factorTelemetryRecordsRepo) return;

    const pendingFactors = this.factorTelemetryRecordsRepo.getPendingEvaluations();
    if (pendingFactors.length === 0) return;

    const groups = new Map<
      string,
      { symbol: string; timestamp: number; ids: Set<number> }
    >();
    for (const rec of pendingFactors) {
      if (!rec.id) continue;
      const sym = rec.symbol.toUpperCase().trim();
      const key = `${sym}:${rec.timestamp}`;
      let group = groups.get(key);
      if (!group) {
        group = { symbol: sym, timestamp: rec.timestamp, ids: new Set() };
        groups.set(key, group);
      }
      group.ids.add(rec.id);
    }

    for (const group of groups.values()) {
      try {
        const startTime = group.timestamp;
        const endTime = Math.min(
          Date.now(),
          group.timestamp + this.EXPIRY_HORIZON_MS + this.horizonGraceMs
        );
        const klines = await client.getKlines(group.symbol, '1m', 70, startTime, endTime);
        if (Array.isArray(klines)) {
          for (const k of klines) {
            this.onCandleClose(group.symbol, normalizeCandle(k));
            const stillEvaluating = this.factorTelemetryRecordsRepo
              .getPendingEvaluations(group.symbol)
              .some((r) => r.id !== undefined && group.ids.has(r.id));
            if (!stillEvaluating) {
              break;
            }
          }
        }
      } catch {
        // Graceful fallback handled below for expired horizons
      }

      if (Date.now() > group.timestamp + this.EXPIRY_HORIZON_MS + this.horizonGraceMs) {
        const now = Date.now();
        const remaining = this.factorTelemetryRecordsRepo.getPendingEvaluations(group.symbol);
        for (const rec of remaining) {
          if (rec.id !== undefined && group.ids.has(rec.id)) {
            this.factorTelemetryRecordsRepo.updateHorizonExcursions(rec.id, {
              status: 'INCOMPLETE_FEED',
              settle_timestamp: now,
            });
            this.horizonStates.delete(rec.id);
          }
        }
      }
    }
  }

  private computeFactorAttributionSummary(
    recentEvents: FactorTelemetryEvent[]
  ): FactorAttributionSummaryItem[] {
    if (!this.factorTelemetryRecordsRepo) return [];

    const factorNameMap = new Map<string, string>(Object.entries(FACTOR_DISPLAY_NAMES));
    for (const ev of recentEvents) {
      for (const f of ev.activeFactors ?? []) {
        if (f.factorId && f.name) {
          factorNameMap.set(f.factorId, f.name);
        }
      }
    }

    const db = this.getDb();
    let factorIds: string[];
    if (db) {
      try {
        const rows = db
          .prepare(
            "SELECT DISTINCT factor_id FROM factor_telemetry_records WHERE status = 'SETTLED' ORDER BY factor_id ASC"
          )
          .all() as Array<{ factor_id: string }>;
        factorIds = rows.map((r) => r.factor_id);
      } catch {
        factorIds = [...STANDARD_FACTOR_IDS];
      }
    } else {
      const seen = new Set<string>(STANDARD_FACTOR_IDS);
      for (const id of factorNameMap.keys()) seen.add(id);
      factorIds = Array.from(seen);
    }

    const items: FactorAttributionSummaryItem[] = [];

    for (const factorId of factorIds) {
      const settled = this.factorTelemetryRecordsRepo.getSettledByFactor(factorId, 60);
      if (settled.length === 0) continue;

      const predictions: number[] = [];
      const outcomes: number[] = [];
      const returns: number[] = [];
      let hits = 0;

      for (const row of settled) {
        const sideSign = row.consensus_side === 'SELL' ? -1 : 1;
        const pred = sideSign * row.orthogonal_alpha;
        const mfe =
          row.post_1h_mfe ??
          row.post_15m_mfe ??
          row.post_5m_mfe ??
          row.post_1m_mfe ??
          0;
        const mae =
          row.post_1h_mae ??
          row.post_15m_mae ??
          row.post_5m_mae ??
          row.post_1m_mae ??
          0;
        const netExcursion = mfe - Math.abs(mae);

        predictions.push(pred);
        outcomes.push(netExcursion);

        const factorReturn =
          row.is_collinear === 1 && pred === 0
            ? 0
            : pred < 0
              ? -netExcursion
              : netExcursion;
        returns.push(factorReturn);
        if (factorReturn > 0) hits++;

        if (!factorNameMap.has(factorId) && row.telemetry_payload_json) {
          const parsed = parseJsonSafe<FactorTelemetryEvent>(row.telemetry_payload_json);
          const match = parsed?.activeFactors?.find((f) => f.factorId === factorId);
          if (match?.name) {
            factorNameMap.set(factorId, match.name);
          }
        }
      }

      const n = returns.length;
      const ic = computeSpearmanIC(predictions, outcomes);
      const mean = returns.reduce((s, v) => s + v, 0) / n;
      const variance =
        n > 1
          ? returns.reduce((s, v) => s + (v - mean) * (v - mean), 0) / (n - 1)
          : 0;
      const std = Math.sqrt(variance);
      const ir = mean / (std + 1e-7);

      items.push({
        factorId,
        name: factorNameMap.get(factorId) ?? factorId,
        empiricalHitRate: Number((hits / n).toFixed(4)),
        informationRatio: Number(ir.toFixed(4)),
        informationCoefficient: Number(ic.toFixed(4)),
        effectiveWeight: Number((settled[0]!.effective_weight ?? 0).toFixed(4)),
        sampleSize: n,
      });
    }

    return items;
  }

  /**
   * Generates dynamic session summary, factor attribution (Spearman IC/IR),
   * execution chase fee savings, and paginated telemetry events.
   */
  public generateSessionSummary(
    sinceMs?: number,
    opts?: { limit?: number; offset?: number }
  ): DailyAuditResponse {
    const since = sinceMs ?? 0;
    const records = this.repo.listSessionDecisions(since);

    let executed_trades = 0;
    let blocked_setups = 0;
    let failed_trades = 0;
    let capital_saved_usd = 0;
    let missed_profit_usd = 0;
    let expired_pnl_usd = 0;
    const veto_breakdown: Record<string, number> = {};

    let chaseFallbackFeeSaved = 0;
    let chaseFallbackTotal = 0;
    let chaseFallbackSuccess = 0;

    for (const record of records) {
      if (record.action === 'EXECUTED') {
        executed_trades += 1;
      } else if (record.action === 'BLOCKED') {
        blocked_setups += 1;
      } else if (record.action === 'FAILED') {
        failed_trades += 1;
      }

      if (record.shadow_status === 'SAVED_CAPITAL' && typeof record.shadow_pnl_usd === 'number') {
        capital_saved_usd += Math.abs(record.shadow_pnl_usd);
      } else if (
        record.shadow_status === 'MISSED_PROFIT' &&
        typeof record.shadow_pnl_usd === 'number'
      ) {
        missed_profit_usd += record.shadow_pnl_usd;
      } else if (
        record.shadow_status === 'EXPIRED' &&
        typeof record.shadow_pnl_usd === 'number'
      ) {
        expired_pnl_usd += record.shadow_pnl_usd;
      }

      if (record.veto_reasons_json) {
        const reasons = parseJsonSafe<unknown[]>(record.veto_reasons_json);
        if (Array.isArray(reasons)) {
          for (const r of reasons) {
            const key = String(r);
            veto_breakdown[key] = (veto_breakdown[key] || 0) + 1;
          }
        }
      } else if (record.macro_veto_active) {
        veto_breakdown['MACRO_VETO'] = (veto_breakdown['MACRO_VETO'] || 0) + 1;
      }

      if (record.execution_chase_json) {
        const chase = parseJsonSafe<ChasingTelemetrySnapshot>(record.execution_chase_json);
        if (chase) {
          chaseFallbackTotal += 1;
          if (chase.status === 'FILLED') chaseFallbackSuccess += 1;
          chaseFallbackFeeSaved += Number(chase.feeSavedVsTakerUsd ?? 0);
        }
      }
    }

    capital_saved_usd = Number(capital_saved_usd.toFixed(2));
    missed_profit_usd = Number(missed_profit_usd.toFixed(2));
    expired_pnl_usd = Number(expired_pnl_usd.toFixed(2));
    const net_risk_value_usd = Number((capital_saved_usd - missed_profit_usd).toFixed(2));

    const limit = opts?.limit ?? 50;
    const offset = opts?.offset ?? 0;
    const factor_telemetry_events = this.factorTelemetryRecordsRepo
      ? this.factorTelemetryRecordsRepo.listRecentEvents(since, limit, offset)
      : [];

    const db = this.getDb();
    let subThresholdCount = 0;
    if (this.factorTelemetryRecordsRepo && db) {
      try {
        const row = db
          .prepare(
            "SELECT COUNT(DISTINCT event_id) AS cnt FROM factor_telemetry_records WHERE trigger_type = 'SUB_THRESHOLD_IMPULSE' AND timestamp >= ?"
          )
          .get(since) as { cnt: number } | undefined;
        subThresholdCount = Number(row?.cnt ?? 0);
      } catch {
        subThresholdCount = factor_telemetry_events.filter(
          (e) => e.triggerType === 'SUB_THRESHOLD_IMPULSE'
        ).length;
      }
    } else if (this.pillarRepo) {
      subThresholdCount = this.pillarRepo
        .listEventsSince(since)
        .filter((e) => e.composite_score < 60).length;
    }

    const execution_chase_summary = this.executionChaseLogsRepo
      ? this.executionChaseLogsRepo.getFeeSavings(undefined, sinceMs)
      : {
          totalFeeSavedUsd: Number(chaseFallbackFeeSaved.toFixed(4)),
          totalChases: chaseFallbackTotal,
          successfulChases: chaseFallbackSuccess,
        };

    let successful_trades = 0;
    let closedTradeCount = 0;
    let gross_pnl_usd = 0;
    let total_fees_usd = 0;

    if (db) {
      try {
        const tradeRows = db
          .prepare(
            'SELECT realized_pnl, fees_usd, status FROM trades WHERE opened_at >= ? OR closed_at >= ?'
          )
          .all(since, since) as Array<{
          realized_pnl: number;
          fees_usd: number;
          status: string;
        }>;
        for (const t of tradeRows) {
          if (t.status === 'CLOSED') {
            closedTradeCount += 1;
            if (Number(t.realized_pnl ?? 0) > 0) successful_trades += 1;
            gross_pnl_usd += Number(t.realized_pnl ?? 0);
          }
          total_fees_usd += Number(t.fees_usd ?? 0);
        }
      } catch {
        // Ignore if trades table unavailable
      }
    }

    const win_rate =
      closedTradeCount > 0
        ? Number((successful_trades / closedTradeCount).toFixed(4))
        : 0;
    gross_pnl_usd = Number(gross_pnl_usd.toFixed(2));
    const net_pnl_usd = Number((gross_pnl_usd - total_fees_usd).toFixed(2));
    const maker_fee_savings_usd = Number(
      execution_chase_summary.totalFeeSavedUsd.toFixed(2)
    );

    const factor_attribution_summary =
      this.computeFactorAttributionSummary(factor_telemetry_events);

    const now = Date.now();
    const summary: DailyAuditSummary = {
      total_setups: records.length,
      executed_trades,
      blocked_setups,
      sub_threshold_impulses: subThresholdCount,
      capital_saved_usd,
      missed_profit_usd,
      expired_pnl_usd,
      net_risk_value_usd,
      veto_breakdown,
      total_trades: executed_trades,
      successful_trades,
      failed_trades,
      win_rate,
      gross_pnl_usd,
      maker_fee_savings_usd,
      net_pnl_usd,
    };

    return {
      date: new Date(now).toISOString().slice(0, 10),
      summary,
      records,
      factor_telemetry_events,
      factor_attribution_summary,
      execution_chase_summary,
      generated_at: now,
    };
  }

  /**
   * Formats DailyAuditResponse into a Next-Gen AI-consumable analytical Markdown report,
   * deterministically clamped under 4,000 tokens (<= 14,000 chars) with zero legacy P1-P7 strings.
   */
  public formatMarkdownReport(response: DailyAuditResponse): string {
    const {
      summary,
      records,
      factor_attribution_summary,
      execution_chase_summary,
      generated_at,
    } = response;
    const dateStr = new Date(generated_at).toISOString();
    const winRatePct =
      summary.win_rate !== undefined
        ? summary.win_rate <= 1
          ? summary.win_rate * 100
          : summary.win_rate
        : 0;

    let md = `# TradeOS Daily Decision Audit & Shadow Report\n\n`;
    md += `**Generated:** ${dateStr}  \n`;
    md += `**Total Setups Evaluated:** ${summary.total_setups}  \n`;
    md += `**Executed Trades:** ${summary.executed_trades} (Failed: ${summary.failed_trades ?? 0})  \n`;
    md += `**Blocked Setups:** ${summary.blocked_setups}  \n`;
    md += `**Win Rate:** ${winRatePct.toFixed(1)}% | **Gross PnL:** $${(summary.gross_pnl_usd ?? 0).toFixed(2)} | **Net PnL:** $${(summary.net_pnl_usd ?? 0).toFixed(2)} | **Maker Fee Savings:** $${(summary.maker_fee_savings_usd ?? 0).toFixed(2)}  \n\n`;

    md += `## Risk & Counterfactual Valuation Summary\n\n`;
    md += `| Metric | Value (USD) |\n`;
    md += `| :--- | :--- |\n`;
    md += `| Capital Saved | $${summary.capital_saved_usd.toFixed(2)} |\n`;
    md += `| Missed Profit | $${summary.missed_profit_usd.toFixed(2)} |\n`;
    md += `| Expired PnL | $${summary.expired_pnl_usd.toFixed(2)} |\n`;
    md += `| **Net Risk Value** | **$${summary.net_risk_value_usd.toFixed(2)}** |\n\n`;

    md += `## Veto Reasons Breakdown\n\n`;
    const vetoEntries = Object.entries(summary.veto_breakdown)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 15);
    if (vetoEntries.length === 0) {
      md += `*No vetoed setups recorded in this session.*\n\n`;
    } else {
      md += `| Veto Reason | Count |\n`;
      md += `| :--- | :--- |\n`;
      for (const [key, count] of vetoEntries) {
        md += `| ${sanitizeCell(key, 48)} | ${count} |\n`;
      }
      md += `\n`;
    }

    md += `## Orthogonal Factor Attribution Matrix\n\n`;
    const attrItems = (factor_attribution_summary ?? []).slice(0, 15);
    if (attrItems.length === 0) {
      md += `*No settled factor attribution observations in this session.*\n\n`;
    } else {
      md += `| Factor | Samples | IC | IR | Hit Rate | Weight |\n`;
      md += `| :--- | :--- | :--- | :--- | :--- | :--- |\n`;
      for (const item of attrItems) {
        const hitPct = `${(item.empiricalHitRate * 100).toFixed(1)}%`;
        const wtPct = `${(item.effectiveWeight * 100).toFixed(1)}%`;
        md += `| ${sanitizeCell(item.factorId, 32)} | ${item.sampleSize} | ${item.informationCoefficient.toFixed(3)} | ${item.informationRatio.toFixed(3)} | ${hitPct} | ${wtPct} |\n`;
      }
      md += `\n`;
    }

    md += `## Trade Execution Attribution\n\n`;
    const chaseSummary = execution_chase_summary ?? {
      totalFeeSavedUsd: summary.maker_fee_savings_usd ?? 0,
      totalChases: 0,
      successfulChases: 0,
    };
    const fillRatePct =
      chaseSummary.totalChases > 0
        ? ((chaseSummary.successfulChases / chaseSummary.totalChases) * 100).toFixed(1)
        : '0.0';

    let totalAmends = 0;
    let chaseParsedCount = 0;
    for (const r of records) {
      const chase = parseJsonSafe<ChasingTelemetrySnapshot>(r.execution_chase_json);
      if (chase) {
        totalAmends += Number(chase.amendmentCount ?? 0);
        chaseParsedCount += 1;
      }
    }
    const avgAmends =
      chaseParsedCount > 0 ? (totalAmends / chaseParsedCount).toFixed(1) : '0.0';

    md += `| Metric | Value |\n`;
    md += `| :--- | :--- |\n`;
    md += `| Total Maker Chases | ${chaseSummary.totalChases} |\n`;
    md += `| Successful Maker Fills | ${chaseSummary.successfulChases} (${fillRatePct}%) |\n`;
    md += `| Avg Amendments / Order | ${avgAmends} |\n`;
    md += `| Maker Fee Savings | $${chaseSummary.totalFeeSavedUsd.toFixed(2)} |\n\n`;

    // Enrich trade PnLs if trades table is accessible
    const tradePnlMap = new Map<string, number>();
    const db = this.getDb();
    if (db) {
      try {
        const tradeRows = db
          .prepare('SELECT id, realized_pnl, fees_usd FROM trades')
          .all() as Array<{ id: string; realized_pnl: number; fees_usd: number }>;
        for (const t of tradeRows) {
          tradePnlMap.set(t.id, Number(t.realized_pnl ?? 0) - Number(t.fees_usd ?? 0));
        }
      } catch {
        // Ignore
      }
    }

    interface TradeDeepDive {
      id: string;
      symbol: string;
      side: TradeSide;
      action: DecisionAction;
      score: number;
      pnlUsd: number;
      slippageBps: number;
      detail: string;
    }

    const deepDives: TradeDeepDive[] = records.map((r) => {
      const chase = parseJsonSafe<ChasingTelemetrySnapshot>(r.execution_chase_json);
      let slippageBps = 0;
      if (chase && chase.anchorMarkPrice > 0) {
        const diff =
          r.side === 'BUY'
            ? chase.currentLimitPrice - chase.anchorMarkPrice
            : chase.anchorMarkPrice - chase.currentLimitPrice;
        slippageBps = Number(((diff / chase.anchorMarkPrice) * 10_000).toFixed(2));
      }

      const linkedPnl = r.trade_id ? tradePnlMap.get(r.trade_id) : undefined;
      const pnlUsd =
        linkedPnl ??
        (typeof r.shadow_pnl_usd === 'number'
          ? r.shadow_pnl_usd
          : chase?.feeSavedVsTakerUsd ?? 0);

      const detail = r.error_message
        ? sanitizeCell(r.error_message, 60)
        : chase
          ? `Chase ${chase.status}, ${chase.amendmentCount} amends, saved $${chase.feeSavedVsTakerUsd.toFixed(2)}`
          : sanitizeCell(r.shadow_status ?? r.action, 40);

      return {
        id: sanitizeCell(r.id, 24),
        symbol: r.symbol,
        side: r.side,
        action: r.action,
        score: r.composite_score,
        pnlUsd,
        slippageBps,
        detail,
      };
    });

    const topProfitable = deepDives
      .filter((d) => d.action === 'EXECUTED' || d.pnlUsd > 0)
      .sort((a, b) => b.pnlUsd - a.pnlUsd)
      .slice(0, 5);

    md += `## Top 5 Most Profitable Trades\n\n`;
    if (topProfitable.length === 0) {
      md += `*No profitable trades or counterfactual setups recorded.*\n\n`;
    } else {
      md += `| ID | Symbol | Side | Score | Est/Realized PnL | Notes |\n`;
      md += `| :--- | :--- | :--- | :--- | :--- | :--- |\n`;
      for (const t of topProfitable) {
        md += `| ${t.id} | ${t.symbol} | ${t.side} | ${t.score}% | $${t.pnlUsd.toFixed(2)} | ${t.detail} |\n`;
      }
      md += `\n`;
    }

    const worstSlippage = deepDives
      .filter((d) => d.action === 'EXECUTED' || d.action === 'FAILED' || d.pnlUsd < 0)
      .sort((a, b) => {
        const aScore = (a.action === 'FAILED' ? 10_000 : 0) + a.slippageBps - a.pnlUsd;
        const bScore = (b.action === 'FAILED' ? 10_000 : 0) + b.slippageBps - b.pnlUsd;
        return bScore - aScore;
      })
      .slice(0, 5);

    md += `## Top 5 Worst-Slippage & Failed Trades\n\n`;
    if (worstSlippage.length === 0) {
      md += `*No slippage anomalies or failed executions recorded.*\n`;
    } else {
      md += `| ID | Symbol | Action | Slippage (bps) | PnL | Notes |\n`;
      md += `| :--- | :--- | :--- | :--- | :--- | :--- |\n`;
      for (const t of worstSlippage) {
        md += `| ${t.id} | ${t.symbol} | ${t.action} | ${t.slippageBps.toFixed(1)} | $${t.pnlUsd.toFixed(2)} | ${t.detail} |\n`;
      }
    }

    return clampMarkdownToTokenBudget(md, 3990);
  }
}
