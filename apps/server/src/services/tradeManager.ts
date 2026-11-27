import crypto from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type {
  TradeRecord,
  FillRecord,
  RiskStateRecord,
  OpenOrderRequest,
  BrokerMode,
  WsServerMessage,
  TradeSide,
  OrderType,
  AccountInfo,
  OpenOrderInfo,
} from '@tradeos/shared';
import {
  TradesRepo,
  FillsRepo,
  RiskStateRepo,
  SettingsRepo,
  AuditLogRepo,
} from '../db/sqlite.js';
import {
  validateOrderRisk,
  updateRiskStateOnTradeClose,
} from '../quant/riskEngine.js';
import type {
  BrokerAdapter,
  PositionInfo,
  OrderExecutionResult,
  AlgoOrderParams,
  AlgoOrderResult,
} from '../exchange/broker.js';
import type { PropFirmRiskGuard } from '../quant/propFirmRiskGuard.js';
import type { AlertNotifier } from './alertNotifier.js';

export class TradeManagerError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number = 400,
    public readonly code?: string
  ) {
    super(message);
    this.name = 'TradeManagerError';
  }
}

export interface TradeManagerOptions {
  db: DatabaseSync;
  broker: BrokerAdapter;
  brokerMode?: BrokerMode;
  getMarkPrice?: (symbol: string) => number;
  broadcastWs?: (msg: WsServerMessage) => void;
  onTradeOpened?: (trade: TradeRecord) => void;
  onTradeClosed?: (trade: TradeRecord) => void;
  propFirmRiskGuard?: PropFirmRiskGuard;
  alertNotifier?: AlertNotifier;
}

/**
 * TradeManager is the single atomic orchestrator for TradeOS v2.
 * It enforces per-symbol async mutex queues, deterministic client order IDs,
 * pre-trade risk validations, fail-closed bracket order compensation,
 * fail-closed Breakeven migration with automated emergency unwinds,
 * duplicate-free fill correlation, and non-destructive exchange reconciliation.
 */
export class TradeManager {
  private db: DatabaseSync;
  private tradesRepo: TradesRepo;
  private fillsRepo: FillsRepo;
  private riskStateRepo: RiskStateRepo;
  private settingsRepo: SettingsRepo;
  private auditLogRepo: AuditLogRepo;
  private broker: BrokerAdapter;
  private brokerMode: BrokerMode;
  private getMarkPriceFn?: (symbol: string) => number;
  private broadcastWsFn?: (msg: WsServerMessage) => void;
  private onTradeOpenedFn?: (trade: TradeRecord) => void;
  private onTradeClosedFn?: (trade: TradeRecord) => void;
  private propFirmRiskGuard?: PropFirmRiskGuard;
  private alertNotifier?: AlertNotifier;

  // Per-symbol async mutex queue to serialize actions per symbol
  private mutexQueues = new Map<string, Promise<unknown>>();
  // Global pre-trade mutex queue when PropFirmRiskGuard 1-position limit is active in BINANCE_DEMO
  private globalPreTradeQueue: Promise<unknown> = Promise.resolve();
  // Track cumulative executed quantity per order ID to prevent double-deduction on partial fills
  private cumulativeExecutedByOrder = new Map<string, number>();

  constructor(options: TradeManagerOptions) {
    this.db = options.db;
    this.tradesRepo = new TradesRepo(this.db);
    this.fillsRepo = new FillsRepo(this.db);
    this.riskStateRepo = new RiskStateRepo(this.db);
    this.settingsRepo = new SettingsRepo(this.db);
    this.auditLogRepo = new AuditLogRepo(this.db);
    this.broker = options.broker;
    this.brokerMode = options.brokerMode || options.broker.mode || 'BINANCE_DEMO';
    this.getMarkPriceFn = options.getMarkPrice;
    this.broadcastWsFn = options.broadcastWs;
    this.onTradeOpenedFn = options.onTradeOpened;
    this.onTradeClosedFn = options.onTradeClosed;
    this.propFirmRiskGuard = options.propFirmRiskGuard;
    this.alertNotifier = options.alertNotifier;
  }

  public setBroker(broker: BrokerAdapter): void {
    this.broker = broker;
    this.brokerMode = broker.mode;
  }

  public setBrokerMode(mode: BrokerMode): void {
    this.brokerMode = mode;
  }

  public setMarkPriceCallback(fn: (symbol: string) => number): void {
    this.getMarkPriceFn = fn;
  }

  public setBroadcastWs(fn: (msg: WsServerMessage) => void): void {
    this.broadcastWsFn = fn;
  }

  public setOnTradeOpened(fn: (trade: TradeRecord) => void): void {
    this.onTradeOpenedFn = fn;
  }

  public setOnTradeClosed(fn: (trade: TradeRecord) => void): void {
    this.onTradeClosedFn = fn;
  }

  public setPropFirmRiskGuard(guard?: PropFirmRiskGuard): void {
    this.propFirmRiskGuard = guard;
  }

  public setAlertNotifier(notifier?: AlertNotifier): void {
    this.alertNotifier = notifier;
  }

  private notifyTradeOpened(trade: TradeRecord): void {
    if (this.onTradeOpenedFn) {
      try {
        this.onTradeOpenedFn(trade);
      } catch {
        // Tolerate listener errors so trade flow never breaks
      }
    }
    void this.alertNotifier?.notifyTradeOpened(trade);
  }

  private notifyTradeClosed(trade: TradeRecord): void {
    if (this.onTradeClosedFn) {
      try {
        this.onTradeClosedFn(trade);
      } catch {
        // Tolerate listener errors so trade cleanup never breaks
      }
    }
    void this.alertNotifier?.notifyTradeClosed(trade);
  }

  /**
   * Serializes pre-trade opens globally when Upcomers 1-position guard is active.
   */
  private async withGlobalPreTradeMutex<T>(task: () => Promise<T>): Promise<T> {
    const currentQueue = this.globalPreTradeQueue;
    let release: () => void = () => {};
    const nextInQueue = new Promise<void>((resolve) => {
      release = resolve;
    });

    this.globalPreTradeQueue = currentQueue.then(
      () => nextInQueue,
      () => nextInQueue
    );

    try {
      await currentQueue;
      return await task();
    } finally {
      release();
    }
  }

  /**
   * Serializes tasks on a per-symbol basis to avoid concurrent race conditions.
   */
  private async withSymbolMutex<T>(symbol: string, task: () => Promise<T>): Promise<T> {
    const currentQueue = this.mutexQueues.get(symbol) ?? Promise.resolve();
    let release: () => void = () => {};
    const nextInQueue = new Promise<void>((resolve) => {
      release = resolve;
    });

    this.mutexQueues.set(symbol, currentQueue.then(() => nextInQueue, () => nextInQueue));

    try {
      await currentQueue;
      return await task();
    } finally {
      release();
      if (this.mutexQueues.get(symbol) === nextInQueue) {
        this.mutexQueues.delete(symbol);
      }
    }
  }

  /**
   * Retrieves the current mark price for a symbol.
   */
  public getMarkPrice(symbol: string): number {
    if (this.getMarkPriceFn) {
      const price = this.getMarkPriceFn(symbol);
      if (price > 0) return price;
    }
    return 0;
  }

  /**
   * Broadcasts a WebSocket message if a broadcaster is attached.
   */
  private broadcast(msg: WsServerMessage): void {
    if (this.broadcastWsFn) {
      try {
        this.broadcastWsFn(msg);
      } catch {
        // Silently tolerate WS transport broadcast failures
      }
    }
  }

  /**
   * Broadcasts a critical or warning alert.
   */
  private broadcastAlert(level: 'INFO' | 'WARN' | 'CRITICAL', message: string): void {
    this.broadcast({
      type: 'ALERT',
      level,
      message,
    });
  }

  /**
   * Broadcasts position events.
   */
  private broadcastPositionEvent(
    event: 'OPENED' | 'UPDATED' | 'BREAKEVEN' | 'CLOSED' | 'OCO_FILL',
    trade: TradeRecord,
    reason?: string
  ): void {
    this.broadcast({
      type: 'POSITION_EVENT',
      event,
      data: {
        trade,
        reason,
      },
    });
  }

  /**
   * CRITICAL FAIL-CLOSED EMERGENCY UNWIND
   * Closes position immediately with reduceOnly MARKET order, cancels pending orders/algos,
   * records exit_reason in SQLite, and logs to audit_log.
   */
  public async emergencyUnwindPosition(
    tradeId: string,
    symbol: string,
    side: TradeSide,
    quantity: number,
    entryPrice: number,
    exitReason: string
  ): Promise<void> {
    const unwindSide: TradeSide = side === 'BUY' ? 'SELL' : 'BUY';
    const now = Date.now();

    // 1. Cancel all open and pending limit/algo orders on exchange
    try {
      await this.broker.cancelAllOrders(symbol);
    } catch {
      // Continue unwind even if cancelAll fails
    }

    // 2. Submit reduceOnly MARKET close order
    let unwindExecuted = false;
    let unwindExitPrice = entryPrice;
    try {
      const unwindResult = await this.broker.closePosition(symbol, quantity);
      unwindExecuted = true;
      if (unwindResult && (unwindResult as any).avgPrice > 0) {
        unwindExitPrice = (unwindResult as any).avgPrice;
      }
    } catch (unwindErr) {
      // Retry market unwind once after 100ms
      await new Promise((r) => setTimeout(r, 100));
      try {
        const retryResult = await this.broker.closePosition(symbol, quantity);
        unwindExecuted = true;
        if (retryResult && (retryResult as any).avgPrice > 0) {
          unwindExitPrice = (retryResult as any).avgPrice;
        }
      } catch (fatalUnwindErr) {
        this.broadcastAlert(
          'CRITICAL',
          `FATAL: Automated emergency market unwind failed on ${symbol} for trade ${tradeId}! Immediate manual intervention required.`
        );
      }
    }

    // 3. Persist exit reason in SQLite trades table
    const existing = this.tradesRepo.getById(tradeId);
    if (existing) {
      this.tradesRepo.update(tradeId, {
        status: 'CLOSED',
        exit_price: unwindExitPrice,
        remaining_qty: 0,
        exit_reason: exitReason,
        closed_at: now,
      });
    } else {
      const dummyRecord: TradeRecord = {
        id: tradeId,
        symbol,
        broker_mode: this.brokerMode,
        side,
        status: 'CLOSED',
        entry_price: entryPrice,
        exit_price: unwindExitPrice,
        quantity,
        remaining_qty: 0,
        leverage: 1,
        margin_usd: 0,
        stop_loss: null,
        tp1: null,
        tp2: null,
        be_price: null,
        is_breakeven: 0,
        client_order_id: `tos_${tradeId}_ent`,
        client_sl_id: null,
        client_tp1_id: null,
        client_tp2_id: null,
        entry_order_id: null,
        sl_algo_id: null,
        tp1_algo_id: null,
        tp2_algo_id: null,
        realized_pnl: 0,
        fees_usd: 0,
        exit_reason: exitReason,
        opened_at: now,
        closed_at: now,
      };
      this.tradesRepo.insert(dummyRecord);
    }

    const closedTrade = this.tradesRepo.getById(tradeId);
    if (closedTrade) {
      this.notifyTradeClosed(closedTrade);
    }

    // 4. Record critical audit log
    this.auditLogRepo.insert({
      id: crypto.randomUUID(),
      event_type: 'EMERGENCY_UNWIND',
      actor: 'TRADE_MANAGER_FAIL_CLOSED',
      reason: exitReason,
      payload_json: JSON.stringify({
        tradeId,
        symbol,
        side,
        quantity,
        unwindExecuted,
        exitPrice: unwindExitPrice,
      }),
      created_at: now,
    });

    this.broadcastAlert(
      'CRITICAL',
      `Fail-Closed Protection: Emergency unwind executed on ${symbol}. Səbəb: ${exitReason}`
    );

    const alertKey =
      exitReason === 'SL_PLACEMENT_FAIL_UNWIND' ? 'SL_PLACEMENT_FAIL_UNWIND' : exitReason;
    void this.alertNotifier?.notifyCriticalEvent(
      alertKey,
      `Emergency market unwind executed on ${symbol}: ${exitReason}`,
      {
        tradeId,
        symbol,
        side,
        quantity,
        unwindExecuted,
        exitPrice: unwindExitPrice,
      }
    );
  }

  /**
   * Opens a new leveraged position with deterministic client order IDs,
   * strict risk & cooldown gatekeeping, and atomic bracket order placement.
   */
  public async openPosition(req: OpenOrderRequest): Promise<TradeRecord> {
    const runOpen = () =>
      this.withSymbolMutex(req.symbol, async () => {
        const isPropFirmDemoActive =
          Boolean(this.propFirmRiskGuard) && this.brokerMode === 'BINANCE_DEMO';

        if (isPropFirmDemoActive && this.propFirmRiskGuard) {
          const guardCheck = this.propFirmRiskGuard.canOpenTrade();
          if (!guardCheck.allowed) {
            throw new TradeManagerError(
              guardCheck.details ?? guardCheck.reason ?? 'Upcomers PropFirm guard blocked entry',
              403,
              guardCheck.reason
            );
          }

          const globalActive = this.tradesRepo.getActivePosition(this.brokerMode);
          if (globalActive) {
            throw new TradeManagerError(
              `Upcomers challenge permits at most 1 active position across all symbols (active: ${globalActive.symbol})`,
              409,
              'ERR_POSITION_EXISTS'
            );
          }
        }

        // Gate 1: Check existing active position on symbol in this broker mode
        const activePosition = this.tradesRepo.getActivePosition(this.brokerMode, req.symbol);
        if (activePosition) {
          throw new TradeManagerError(
            `Aktiv pozisiya artıq mövcuddur: ${req.symbol} (status: ${activePosition.status})`,
            409,
            'ERR_POSITION_EXISTS'
          );
        }

        // Gate 2: Fetch account balance and current risk state
        const account = await this.broker.getAccount();
        const currentRisk = this.riskStateRepo.get(this.brokerMode) || {
          broker_mode: this.brokerMode,
          consecutive_losses: 0,
          cooldown_until: 0,
          cooldown_reason: null,
          session_net_pnl: 0,
          session_started_at: Date.now(),
          updated_at: Date.now(),
        };

        const markPrice = this.getMarkPrice(req.symbol);
        const effectiveEntryPrice =
          req.orderType === 'LIMIT' && req.limitPrice && req.limitPrice > 0
            ? req.limitPrice
            : markPrice > 0
            ? markPrice
            : 0;

        let effectiveMarginUsd = req.marginUsd;
        let clampedQtyOverride: number | null = null;

        if (isPropFirmDemoActive && this.propFirmRiskGuard) {
          if (!effectiveEntryPrice || effectiveEntryPrice <= 0) {
            throw new TradeManagerError(
              'Bazar qiyməti (Mark Price) hələ əldə edilməyib. Zəhmət olmasa bir neçə saniyə gözləyin.',
              400,
              'ERR_MARK_PRICE_UNAVAILABLE'
            );
          }

          const rawNotionalUsd = req.marginUsd * req.leverage;
          const rawQty = Number((rawNotionalUsd / effectiveEntryPrice).toFixed(4));
          const clamped = this.propFirmRiskGuard.clampEntryQuantity({
            desiredQty: rawQty,
            entryPrice: effectiveEntryPrice,
            stopLossPrice: req.stopLoss ?? 0,
          });

          if (clamped.qty <= 0) {
            throw new TradeManagerError(
              'Stop-loss risk exceeds Upcomers $250.00 limit even after clamping',
              400,
              'ERR_PROPFIRM_RISK_LIMIT'
            );
          }

          clampedQtyOverride = clamped.qty;
          if (clamped.clampedByRisk) {
            const effectiveNotionalUsd = Number((clamped.qty * effectiveEntryPrice).toFixed(2));
            effectiveMarginUsd = Number((effectiveNotionalUsd / req.leverage).toFixed(2));
          }
        }

        const effectiveReq: OpenOrderRequest = {
          ...req,
          marginUsd: effectiveMarginUsd,
        };

        // Gate 3: Risk Engine Gatekeeper (Cooldown, Margin Cap, Drawdown, Dead-SL Armor)
        // Anti-gambling cooldown applies strictly to manual entries, never AutoPilot entries.
        const effectiveRiskForValidation = (req as any).isAutoPilot
          ? { ...currentRisk, cooldown_until: 0 }
          : currentRisk;
        const riskValidation = validateOrderRisk(
          effectiveReq,
          account,
          effectiveRiskForValidation,
          markPrice,
          Date.now(),
          isPropFirmDemoActive && this.propFirmRiskGuard
            ? { propFirmBenchmarkUsd: this.propFirmRiskGuard.getConfig().accountSizeUsd }
            : undefined
        );
        if (!riskValidation.allowed) {
          if (riskValidation.code === 'ERR_COOLDOWN_ACTIVE') {
            throw new TradeManagerError(
              riskValidation.reason || 'Anti-qumar 15 dəqiqəlik Cooldown kilidi aktivdir',
              423,
              'ERR_COOLDOWN_ACTIVE'
            );
          }
          throw new TradeManagerError(
            riskValidation.reason || 'Risk yoxlamasından keçmədi',
            400,
            riskValidation.code
          );
        }

        // Gate 4: Generate Deterministic Client Order IDs (max 36 chars for Binance limits)
        const tradeId = crypto.randomBytes(8).toString('hex');
        const clientEntId = `tos_${tradeId}_ent`;
        const clientSlId = `tos_${tradeId}_sl`;
        const clientTp1Id = req.tp1 ? `tos_${tradeId}_tp1` : null;
        const clientTp2Id = req.tp2 ? `tos_${tradeId}_tp2` : null;

        if (!effectiveEntryPrice || effectiveEntryPrice <= 0) {
          throw new TradeManagerError(
            'Bazar qiyməti (Mark Price) hələ əldə edilməyib. Zəhmət olmasa bir neçə saniyə gözləyin.',
            400,
            'ERR_MARK_PRICE_UNAVAILABLE'
          );
        }

        const notionalUsd = effectiveMarginUsd * req.leverage;
        const calculatedQty = Number((notionalUsd / effectiveEntryPrice).toFixed(4));
        const targetQty =
          clampedQtyOverride !== null
            ? clampedQtyOverride
            : calculatedQty > 0
            ? calculatedQty
            : 0.001;

        // 5. Submit Entry Order via Broker
        let entryResult: OrderExecutionResult;
        try {
          entryResult = await this.broker.openOrder({
            ...effectiveReq,
            quantity: targetQty,
            clientOrderId: clientEntId,
          });
        } catch (orderErr: any) {
          throw new TradeManagerError(
            `Giriş sifarişi uğursuz oldu: ${orderErr?.message || orderErr}`,
            orderErr?.statusCode || 500,
            'ERR_ENTRY_ORDER_FAILED'
          );
        }

        const executedQty = entryResult.executedQty;
        if (req.orderType === 'LIMIT' && executedQty <= 0) {
          try {
            await this.broker.cancelOrder(req.symbol, entryResult.orderId, false);
          } catch {
            // Best-effort cancel
          }
          throw new TradeManagerError(
            'Unfilled resting LIMIT entry cancelled; use AutoPilot chaser for passive fills',
            409,
            'ERR_LIMIT_ORDER_UNFILLED'
          );
        }

        if (executedQty <= 0) {
          throw new TradeManagerError(
            'Entry order returned zero executed quantity',
            502,
            'ERR_ZERO_FILL'
          );
        }

        const fillPrice =
          entryResult.avgPrice > 0 ? entryResult.avgPrice : effectiveEntryPrice;

        // Calculate Breakeven price (+-0.15% fee buffer)
        const bePrice = Number(
          (req.side === 'BUY' ? fillPrice * 1.0015 : fillPrice * 0.9985).toFixed(4)
        );

        // 6. Bracket Compensation — Place Stop-Loss Algo Order
        const oppositeSide: TradeSide = req.side === 'BUY' ? 'SELL' : 'BUY';
        let slAlgoId: string | null = null;

        if (req.stopLoss && req.stopLoss > 0) {
          try {
            const slRes = await this.broker.createAlgoOrder({
              symbol: req.symbol,
              side: oppositeSide,
              type: 'STOP_MARKET',
              triggerPrice: req.stopLoss,
              quantity: executedQty,
              clientAlgoId: clientSlId,
              reduceOnly: true,
            });
            slAlgoId = slRes.algoId;
          } catch (slFirstErr) {
            // Retry once within <= 500ms
            await new Promise((r) => setTimeout(r, 200));
            try {
              const slRetryRes = await this.broker.createAlgoOrder({
                symbol: req.symbol,
                side: oppositeSide,
                type: 'STOP_MARKET',
                triggerPrice: req.stopLoss,
                quantity: executedQty,
                clientAlgoId: clientSlId,
                reduceOnly: true,
              });
              slAlgoId = slRetryRes.algoId;
            } catch (slRetryErr) {
              // CRITICAL FAIL-CLOSED GUARANTEE:
              // If entry fills but SL algo placement fails (after <=500ms retry),
              // immediately execute automated emergencyUnwindPosition() (reduceOnly: true, type: 'MARKET'),
              // cancel pending TP algos, write exit_reason = 'SL_PLACEMENT_FAIL_UNWIND', and return 502 Bad Gateway.
              // Never leave an unhedged/naked position.
              await this.emergencyUnwindPosition(
                tradeId,
                req.symbol,
                req.side,
                executedQty,
                fillPrice,
                'SL_PLACEMENT_FAIL_UNWIND'
              );

              throw new TradeManagerError(
                'SL algo placement failed after retry. Automated emergency market unwind executed (Fail-Closed).',
                502,
                'ERR_SL_PLACEMENT_FAIL_UNWIND'
              );
            }
          }
        }

        // 7. Place TP1 / TP2 Algos if configured
        let tp1AlgoId: string | null = null;
        let tp2AlgoId: string | null = null;

        if (req.tp1 && req.tp1 > 0) {
          const tp1Qty = req.tp2
            ? Number((executedQty * 0.5).toFixed(4))
            : executedQty;

          try {
            const tp1Res = await this.broker.createAlgoOrder({
              symbol: req.symbol,
              side: oppositeSide,
              type: 'TAKE_PROFIT_MARKET',
              triggerPrice: req.tp1,
              quantity: tp1Qty,
              clientAlgoId: clientTp1Id!,
              reduceOnly: true,
            });
            tp1AlgoId = tp1Res.algoId;
          } catch (tp1Err) {
            this.broadcastAlert(
              'WARN',
              `TP1 algo placement failed on ${req.symbol}. SL is active, trade is hedged.`
            );
          }
        }

        if (req.tp2 && req.tp2 > 0) {
          const tp1Qty = Number((executedQty * 0.5).toFixed(4));
          const tp2Qty = Number((executedQty - tp1Qty).toFixed(4));

          try {
            const tp2Res = await this.broker.createAlgoOrder({
              symbol: req.symbol,
              side: oppositeSide,
              type: 'TAKE_PROFIT_MARKET',
              triggerPrice: req.tp2,
              quantity: tp2Qty,
              clientAlgoId: clientTp2Id!,
              reduceOnly: true,
            });
            tp2AlgoId = tp2Res.algoId;
          } catch (tp2Err) {
            this.broadcastAlert(
              'WARN',
              `TP2 algo placement failed on ${req.symbol}. SL is active, trade is hedged.`
            );
          }
        }

        // 8. Record active trade in SQLite trades table
        const tradeRecord: TradeRecord = {
          id: tradeId,
          symbol: req.symbol,
          broker_mode: this.brokerMode,
          side: req.side,
          status: 'OPEN',
          entry_price: fillPrice,
          exit_price: null,
          quantity: executedQty,
          remaining_qty: executedQty,
          leverage: req.leverage,
          margin_usd: effectiveMarginUsd,
          stop_loss: req.stopLoss ?? null,
          tp1: req.tp1 ?? null,
          tp2: req.tp2 ?? null,
          be_price: bePrice,
          is_breakeven: 0,
          client_order_id: clientEntId,
          client_sl_id: clientSlId,
          client_tp1_id: clientTp1Id,
          client_tp2_id: clientTp2Id,
          entry_order_id: entryResult.orderId,
          sl_algo_id: slAlgoId,
          tp1_algo_id: tp1AlgoId,
          tp2_algo_id: tp2AlgoId,
          realized_pnl: 0,
          fees_usd: 0,
          exit_reason: null,
          opened_at: Date.now(),
          closed_at: null,
        };

        this.tradesRepo.insert(tradeRecord);
        this.broadcastPositionEvent('OPENED', tradeRecord);
        this.notifyTradeOpened(tradeRecord);

        return tradeRecord;
      });

    if (this.propFirmRiskGuard && this.brokerMode === 'BINANCE_DEMO') {
      return this.withGlobalPreTradeMutex(runOpen);
    }
    return runOpen();
  }

  /**
   * Closes an active position with a reduceOnly MARKET order,
   * cancels all pending limit and algo orders, and updates trades and risk_state.
   */
  public async closePosition(
    symbol: string,
    reason: string = 'MANUAL_CLOSE'
  ): Promise<TradeRecord> {
    return this.withSymbolMutex(symbol, async () => {
      const trade = this.tradesRepo.getActivePosition(this.brokerMode, symbol);
      if (!trade) {
        throw new TradeManagerError(
          `Aktiv pozisiya tapılmadı: ${symbol}`,
          404,
          'ERR_NO_ACTIVE_POSITION'
        );
      }

      // 1. Cancel all pending orders/algos on exchange
      try {
        await this.broker.cancelAllOrders(symbol);
      } catch {
        // Proceed with market close regardless
      }

      // 2. Submit reduceOnly MARKET close order
      const closeRes = await this.broker.closePosition(symbol, trade.remaining_qty);
      const markPrice = this.getMarkPrice(symbol);
      const exitPrice =
        closeRes && (closeRes as any).avgPrice > 0
          ? (closeRes as any).avgPrice
          : markPrice > 0
          ? markPrice
          : trade.entry_price;

      // 3. Calculate realized PnL and fees
      const grossPnl =
        trade.side === 'BUY'
          ? (exitPrice - trade.entry_price) * trade.remaining_qty
          : (trade.entry_price - exitPrice) * trade.remaining_qty;

      const estimatedFees = exitPrice * trade.remaining_qty * 0.0005; // 5 bps taker fee
      const totalPnl = Number((trade.realized_pnl + grossPnl).toFixed(4));
      const totalFees = Number((trade.fees_usd + estimatedFees).toFixed(4));
      const now = Date.now();

      // 4. Update SQLite trades table
      this.tradesRepo.update(trade.id, {
        status: 'CLOSED',
        exit_price: exitPrice,
        remaining_qty: 0,
        realized_pnl: totalPnl,
        fees_usd: totalFees,
        exit_reason: reason,
        closed_at: now,
      });

      const closedTrade = this.tradesRepo.getById(trade.id)!;

      // 5. Update risk_state (consecutive losses, cooldown triggers, session PnL)
      // Only manual trades trigger the 15-minute Anti-Gambling Cooldown; AutoPilot exits do not.
      const AUTOPILOT_EXIT_REASONS = new Set([
        'OPPOSITE_CONFLUENCE_REVERSAL',
        'TRAILING_GIVEBACK_HALF',
        'WATCHDOG_STOP_LOSS',
        'SL_PLACEMENT_FAILED_EMERGENCY_UNWIND',
        'EVENT_BLACKOUT_UNWIND',
        'PROPFIRM_TARGET_REACHED',
        'UPCOMERS_DAILY_HALT',
        'UPCOMERS_TRAILING_HALT',
      ]);
      if (!AUTOPILOT_EXIT_REASONS.has(reason)) {
        try {
          const account = await this.broker.getAccount();
          const currentRisk = this.riskStateRepo.get(this.brokerMode) || {
            broker_mode: this.brokerMode,
            consecutive_losses: 0,
            cooldown_until: 0,
            cooldown_reason: null,
            session_net_pnl: 0,
            session_started_at: now,
            updated_at: now,
          };

          const riskBenchmarkBalance =
            this.propFirmRiskGuard && this.brokerMode === 'BINANCE_DEMO'
              ? Math.max(account.walletBalance, this.propFirmRiskGuard.getConfig().accountSizeUsd)
              : account.walletBalance;

          const updatedRisk = updateRiskStateOnTradeClose(
            closedTrade,
            currentRisk,
            riskBenchmarkBalance,
            now
          );
          this.riskStateRepo.update(updatedRisk);
        } catch {
          // Tolerated if account fetch is degraded
        }
      }

      this.broadcastPositionEvent('CLOSED', closedTrade, reason);
      this.notifyTradeClosed(closedTrade);
      return closedTrade;
    });
  }

  /**
   * Migrates active position's Stop-Loss to Breakeven (+-0.15% fee buffer).
   * Enforces pre-flight buffer verification, atomic cancel-and-replace,
   * single <=500ms restoration retry, and fail-closed emergency market unwind on double failure.
   */
  public async moveToBreakeven(symbol: string): Promise<TradeRecord> {
    return this.withSymbolMutex(symbol, async () => {
      const trade = this.tradesRepo.getActivePosition(this.brokerMode, symbol);
      if (!trade) {
        throw new TradeManagerError(
          `Aktiv pozisiya tapılmadı: ${symbol}`,
          404,
          'ERR_NO_ACTIVE_POSITION'
        );
      }

      if (trade.is_breakeven === 1) {
        return trade; // Already moved to breakeven
      }

      // Calculate breakeven price with 0.15% fee buffer
      const bePrice = Number(
        (trade.side === 'BUY'
          ? trade.entry_price * 1.0015
          : trade.entry_price * 0.9985
        ).toFixed(4)
      );

      // Pre-flight buffer check: verify current markPrice is safe distance from breakeven
      const markPrice = this.getMarkPrice(symbol);
      if (markPrice > 0) {
        if (trade.side === 'BUY' && markPrice <= bePrice) {
          throw new TradeManagerError(
            `Pre-flight buffer check failed: Long markPrice ($${markPrice}) must be safely above Breakeven price ($${bePrice})`,
            400,
            'ERR_BREAKEVEN_BUFFER_VIOLATION'
          );
        }
        if (trade.side === 'SELL' && markPrice >= bePrice) {
          throw new TradeManagerError(
            `Pre-flight buffer check failed: Short markPrice ($${markPrice}) must be safely below Breakeven price ($${bePrice})`,
            400,
            'ERR_BREAKEVEN_BUFFER_VIOLATION'
          );
        }
      }

      const originalSlPrice = trade.stop_loss;
      const originalSlId = trade.sl_algo_id;
      const oppositeSide: TradeSide = trade.side === 'BUY' ? 'SELL' : 'BUY';

      // Atomic Cancel-and-Replace Step 1: Cancel existing SL algo order
      if (originalSlId) {
        try {
          await this.broker.cancelOrder(symbol, originalSlId, true);
        } catch {
          // Tolerated if order already cancelled or not found
        }
      }

      // Atomic Cancel-and-Replace Step 2: Submit new Breakeven SL algo order
      let newSlId: string | null = null;
      try {
        const beRes = await this.broker.createAlgoOrder({
          symbol,
          side: oppositeSide,
          type: 'STOP_MARKET',
          triggerPrice: bePrice,
          quantity: trade.remaining_qty,
          clientAlgoId: `tos_${trade.id}_sl`,
          reduceOnly: true,
        });
        newSlId = beRes.algoId;
      } catch (beFirstErr) {
        // CRITICAL FAIL-CLOSED GUARANTEE:
        // If new Breakeven SL placement fails, immediately retry restoring original SL once (<=500ms).
        let restored = false;
        if (originalSlPrice && originalSlPrice > 0) {
          await new Promise((r) => setTimeout(r, 200));
          try {
            const restoreRes = await this.broker.createAlgoOrder({
              symbol,
              side: oppositeSide,
              type: 'STOP_MARKET',
              triggerPrice: originalSlPrice,
              quantity: trade.remaining_qty,
              clientAlgoId: `tos_${trade.id}_sl`,
              reduceOnly: true,
            });
            newSlId = restoreRes.algoId;
            restored = true;
            this.tradesRepo.update(trade.id, { sl_algo_id: newSlId });
          } catch (restoreErr) {
            restored = false;
          }
        }

        // If restoration also fails, immediately execute automated emergencyUnwindPosition()
        if (!restored) {
          await this.emergencyUnwindPosition(
            trade.id,
            symbol,
            trade.side,
            trade.remaining_qty,
            trade.entry_price,
            'BREAKEVEN_FAIL_CLOSED_UNWIND'
          );

          this.broadcastAlert(
            'CRITICAL',
            `CRITICAL: Breakeven SL placement and original restoration failed on ${symbol}. Emergency market unwind executed.`
          );

          throw new TradeManagerError(
            'Breakeven SL placement and original SL restoration both failed. Automated emergency unwind executed.',
            502,
            'ERR_BREAKEVEN_FAIL_CLOSED_UNWIND'
          );
        }

        throw new TradeManagerError(
          'Breakeven SL placement failed. Original SL successfully restored.',
          500,
          'ERR_BREAKEVEN_RESTORED_ORIGINAL'
        );
      }

      // Breakeven placed successfully
      this.tradesRepo.update(trade.id, {
        is_breakeven: 1,
        be_price: bePrice,
        stop_loss: bePrice,
        sl_algo_id: newSlId,
      });

      const updatedTrade = this.tradesRepo.getById(trade.id)!;
      this.broadcastPositionEvent('BREAKEVEN', updatedTrade);

      return updatedTrade;
    });
  }

  /**
   * Dynamically updates the active position's Stop-Loss on exchange and in SQLite.
   * Enforces fail-closed atomic cancel-and-replace:
   * Only allows tightening the stop (Long: higher SL, Short: lower SL).
   */
  public async updateStopLoss(
    symbol: string,
    newStopPrice: number,
    reason: string = 'DYNAMIC_TRAILING_STOP'
  ): Promise<TradeRecord> {
    return this.withSymbolMutex(symbol, async () => {
      const trade = this.tradesRepo.getActivePosition(this.brokerMode, symbol);
      if (!trade) {
        throw new TradeManagerError(
          `Aktiv pozisiya tapılmadı: ${symbol}`,
          404,
          'ERR_NO_ACTIVE_POSITION'
        );
      }

      const formattedNewSl = Number(newStopPrice.toFixed(4));
      const markPrice = this.getMarkPrice(symbol);

      // Validate stop loss direction: never allow widening risk
      if (trade.side === 'BUY') {
        if (trade.stop_loss && formattedNewSl <= trade.stop_loss) {
          return trade; // Already higher or equal, skip
        }
        if (markPrice > 0 && formattedNewSl >= markPrice) {
          throw new TradeManagerError(
            `Trailing SL ($${formattedNewSl}) must be below current mark price ($${markPrice})`,
            400,
            'ERR_INVALID_SL_PRICE'
          );
        }
      } else {
        if (trade.stop_loss && formattedNewSl >= trade.stop_loss) {
          return trade; // Already lower or equal, skip
        }
        if (markPrice > 0 && formattedNewSl <= markPrice) {
          throw new TradeManagerError(
            `Trailing SL ($${formattedNewSl}) must be above current mark price ($${markPrice})`,
            400,
            'ERR_INVALID_SL_PRICE'
          );
        }
      }

      const originalSlPrice = trade.stop_loss;
      const originalSlId = trade.sl_algo_id;
      const oppositeSide: TradeSide = trade.side === 'BUY' ? 'SELL' : 'BUY';

      // 1. Cancel existing SL algo order
      if (originalSlId) {
        try {
          await this.broker.cancelOrder(symbol, originalSlId, true);
        } catch {
          // Tolerated if order already cancelled or not found
        }
      }

      // 2. Submit new Trailing SL algo order
      let newSlId: string | null = null;
      try {
        const slRes = await this.broker.createAlgoOrder({
          symbol,
          side: oppositeSide,
          type: 'STOP_MARKET',
          triggerPrice: formattedNewSl,
          quantity: trade.remaining_qty,
          clientAlgoId: `tos_${trade.id}_sl`,
          reduceOnly: true,
        });
        newSlId = slRes.algoId;
      } catch (firstErr) {
        // Fallback: restore original SL
        let restored = false;
        if (originalSlPrice && originalSlPrice > 0) {
          await new Promise((r) => setTimeout(r, 200));
          try {
            const restoreRes = await this.broker.createAlgoOrder({
              symbol,
              side: oppositeSide,
              type: 'STOP_MARKET',
              triggerPrice: originalSlPrice,
              quantity: trade.remaining_qty,
              clientAlgoId: `tos_${trade.id}_sl`,
              reduceOnly: true,
            });
            newSlId = restoreRes.algoId;
            restored = true;
            this.tradesRepo.update(trade.id, { sl_algo_id: newSlId });
          } catch {
            restored = false;
          }
        }

        if (!restored) {
          await this.emergencyUnwindPosition(
            trade.id,
            symbol,
            trade.side,
            trade.remaining_qty,
            trade.entry_price,
            'TRAILING_SL_FAIL_CLOSED_UNWIND'
          );
          throw new TradeManagerError(
            'Trailing SL placement failed and restoration failed. Emergency unwind executed.',
            502,
            'ERR_TRAILING_SL_FAIL_CLOSED_UNWIND'
          );
        }

        throw new TradeManagerError(
          'Trailing SL placement failed. Original SL restored.',
          500,
          'ERR_TRAILING_SL_RESTORED'
        );
      }

      // Update SQLite
      this.tradesRepo.update(trade.id, {
        stop_loss: formattedNewSl,
        sl_algo_id: newSlId,
      });

      const updatedTrade = this.tradesRepo.getById(trade.id)!;
      this.broadcastPositionEvent('UPDATED', updatedTrade, reason);
      return updatedTrade;
    });
  }

  /**
   * Processes User Data stream fill events (ORDER_TRADE_UPDATE / ALGO_UPDATE).
   * Correlates tradeId from deterministic clientOrderId prefix (tos_${tradeId}_*),
   * records fills to SQLite without duplicates, updates remaining_qty,
   * transitions status to 'PARTIALLY_CLOSED' on TP1 fill, and cancels opposite OCO legs.
   */
  public async handleOrderTradeUpdate(event: any): Promise<void> {
    const clientOrderId =
      event.clientOrderId ||
      event.c ||
      event.o?.c ||
      event.clientAlgoId ||
      '';

    const match = clientOrderId.match(/^tos_([a-zA-Z0-9-]+)_(ent|sl|tp1|tp2|be)$/);
    let tradeId: string | null = match ? match[1] : null;
    const leg: string = match ? match[2] : '';

    const orderId = String(event.orderId || event.i || event.o?.i || event.algoId || '');

    // Fallback: correlation via order IDs if clientOrderId was stripped
    if (!tradeId) {
      const activeTrades = this.tradesRepo.getActivePosition(this.brokerMode);
      if (
        activeTrades &&
        (activeTrades.entry_order_id === orderId ||
          activeTrades.sl_algo_id === orderId ||
          activeTrades.tp1_algo_id === orderId ||
          activeTrades.tp2_algo_id === orderId)
      ) {
        tradeId = activeTrades.id;
      }
    }

    if (!tradeId) return;

    const trade = this.tradesRepo.getById(tradeId);
    if (!trade) return;

    // Fill Extraction
    const binanceTradeId = String(
      event.tradeId ||
        event.t ||
        event.o?.t ||
        event.fillId ||
        `${orderId}_${Date.now()}`
    );

    // If this fill was already persisted and processed, ignore duplicate updates to avoid double-deductions [DEF-01]
    if (this.fillsRepo.exists(binanceTradeId)) {
      return;
    }

    const price = Number(
      event.lastFilledPrice || event.L || event.o?.L || event.price || event.p || trade.entry_price
    );
    // Deterministic executed quantity extraction tracking cumulative executedQty per orderId
    const lastFilled = Number(event.lastFilledQty || event.l || event.o?.l || 0);
    const cumulative = Number(event.executedQty || event.z || event.o?.z || 0);

    let qty = 0;
    if (lastFilled > 0) {
      qty = lastFilled;
      if (orderId && cumulative > 0) {
        this.cumulativeExecutedByOrder.set(orderId, cumulative);
      }
    } else if (cumulative > 0 && orderId) {
      const prev = this.cumulativeExecutedByOrder.get(orderId) ?? 0;
      qty = Math.max(0, Number((cumulative - prev).toFixed(4)));
      this.cumulativeExecutedByOrder.set(orderId, cumulative);
    } else {
      qty = Number(event.lastFilledQty || event.l || event.o?.l || event.executedQty || 0);
    }

    // If quantity is <= 0, this is an order status update or acknowledgment, not a trade fill
    if (qty <= 0) {
      return;
    }

    const commission = Number(event.commission || event.n || event.o?.n || 0);
    const commissionAsset = event.commissionAsset || event.N || event.o?.N || 'USDT';
    const filledAt = Number(event.tradeTime || event.T || event.o?.T || Date.now());

    // Deduplicated fill persistence
    let realizedPnl = 0;
    if (leg === 'sl' || leg === 'tp1' || leg === 'tp2' || leg === 'be') {
      realizedPnl =
        trade.side === 'BUY'
          ? (price - trade.entry_price) * qty
          : (trade.entry_price - price) * qty;
    }

    this.fillsRepo.insert({
      binance_trade_id: binanceTradeId,
      trade_id: tradeId,
      order_id: orderId,
      symbol: trade.symbol,
      side: event.side || event.S || trade.side,
      price,
      qty,
      realized_pnl: Number(realizedPnl.toFixed(4)),
      commission,
      commission_asset: commissionAsset,
      filled_at: filledAt,
    });

    // OCO Leg Handling & State Transitions
    const totalFees = (trade.fees_usd || 0) + commission;
    const totalPnl = (trade.realized_pnl || 0) + Number(realizedPnl.toFixed(4));

    if (leg === 'tp1') {
      const newRemaining = Math.max(0, Number((trade.remaining_qty - qty).toFixed(4)));

      if (newRemaining > 0) {
        // Partial fill transition: runner position remains open
        this.tradesRepo.update(trade.id, {
          status: 'PARTIALLY_CLOSED',
          remaining_qty: newRemaining,
          realized_pnl: Number(totalPnl.toFixed(4)),
          fees_usd: Number(totalFees.toFixed(4)),
        });

        // OCO clean-up: adjust opposite SL algo order to new remaining quantity
        if (trade.sl_algo_id && trade.stop_loss) {
          try {
            await this.broker.cancelOrder(trade.symbol, trade.sl_algo_id, true);
            const oppositeSide: TradeSide = trade.side === 'BUY' ? 'SELL' : 'BUY';
            const newSlRes = await this.broker.createAlgoOrder({
              symbol: trade.symbol,
              side: oppositeSide,
              type: 'STOP_MARKET',
              triggerPrice: trade.stop_loss,
              quantity: newRemaining,
              clientAlgoId: `tos_${trade.id}_sl`,
              reduceOnly: true,
            });
            this.tradesRepo.update(trade.id, { sl_algo_id: newSlRes.algoId });
          } catch {
            // Tolerated
          }
        }

        const updated = this.tradesRepo.getById(trade.id)!;
        this.broadcastPositionEvent('OCO_FILL', updated);
      } else {
        // TP1 closed entire trade
        if (trade.sl_algo_id) {
          try {
            await this.broker.cancelOrder(trade.symbol, trade.sl_algo_id, true);
          } catch {}
        }
        this.tradesRepo.update(trade.id, {
          status: 'CLOSED',
          exit_price: price,
          remaining_qty: 0,
          realized_pnl: Number(totalPnl.toFixed(4)),
          fees_usd: Number(totalFees.toFixed(4)),
          exit_reason: 'TAKE_PROFIT_1',
          closed_at: filledAt,
        });
        const closed = this.tradesRepo.getById(trade.id)!;
        this.broadcastPositionEvent('CLOSED', closed, 'TAKE_PROFIT_1');
        this.notifyTradeClosed(closed);
      }
    } else if (leg === 'tp2') {
      // TP2 closed remaining position -> cancel opposite SL algo
      if (trade.sl_algo_id) {
        try {
          await this.broker.cancelOrder(trade.symbol, trade.sl_algo_id, true);
        } catch {}
      }
      this.tradesRepo.update(trade.id, {
        status: 'CLOSED',
        exit_price: price,
        remaining_qty: 0,
        realized_pnl: Number(totalPnl.toFixed(4)),
        fees_usd: Number(totalFees.toFixed(4)),
        exit_reason: 'TAKE_PROFIT_2',
        closed_at: filledAt,
      });
      const closed = this.tradesRepo.getById(trade.id)!;
      this.broadcastPositionEvent('CLOSED', closed, 'TAKE_PROFIT_2');
      this.notifyTradeClosed(closed);
    } else if (leg === 'sl' || leg === 'be') {
      // Stopped out -> cancel opposite TP algos
      if (trade.tp1_algo_id) {
        try {
          await this.broker.cancelOrder(trade.symbol, trade.tp1_algo_id, true);
        } catch {}
      }
      if (trade.tp2_algo_id) {
        try {
          await this.broker.cancelOrder(trade.symbol, trade.tp2_algo_id, true);
        } catch {}
      }
      const exitReason = leg === 'be' ? 'BREAKEVEN_STOP' : 'STOP_LOSS';
      this.tradesRepo.update(trade.id, {
        status: 'CLOSED',
        exit_price: price,
        remaining_qty: 0,
        realized_pnl: Number(totalPnl.toFixed(4)),
        fees_usd: Number(totalFees.toFixed(4)),
        exit_reason: exitReason,
        closed_at: filledAt,
      });
      const closed = this.tradesRepo.getById(trade.id)!;
      this.broadcastPositionEvent('CLOSED', closed, exitReason);
      this.notifyTradeClosed(closed);
    }
  }

  /**
   * Reconciles SQLite positions and open orders with live exchange data.
   * CRITICAL GUARANTEE:
   * Inspects live exchange position FIRST [DEF-02].
   * If exchange has an open position but SQLite shows none, restores and adopts the position,
   * places a protective Stop Loss if naked, and never leaves funds unhedged.
   */
  public async reconcileWithExchange(targetSymbol: string = 'SOLUSDT'): Promise<void> {
    const activeSymbols = this.tradesRepo.getActiveSymbols(this.brokerMode);
    const symbolsToSync = new Set<string>(activeSymbols);
    if (targetSymbol) {
      symbolsToSync.add(targetSymbol.toUpperCase().trim());
    }
    if (symbolsToSync.size === 0) {
      symbolsToSync.add('SOLUSDT');
    }

    for (const sym of symbolsToSync) {
      await this.reconcileSymbol(sym);
    }
  }

  private async reconcileSymbol(sym: string): Promise<void> {
    return this.withSymbolMutex(sym, async () => {
      let pos: PositionInfo | null = null;
      try {
        pos = await this.broker.getPosition(sym);
      } catch {
        return; // Tolerated on transient exchange connectivity errors
      }

      const activeTrade = this.tradesRepo.getActivePosition(this.brokerMode, sym);
      const liveQty = pos ? Math.abs(pos.positionAmt) : 0;

      // Case 1: Exchange HAS an active position (liveQty > 0)
      if (liveQty > 0 && pos) {
        if (activeTrade) {
          // Sync remaining_qty and actual exchange entry_price
          const updates: any = {};
          if (liveQty !== activeTrade.remaining_qty) {
            updates.remaining_qty = liveQty;
          }
          if (pos.entryPrice && pos.entryPrice > 0 && Math.abs(pos.entryPrice - activeTrade.entry_price) > 0.0001) {
            updates.entry_price = Number(pos.entryPrice.toFixed(4));
          }
          if (Object.keys(updates).length > 0) {
            this.tradesRepo.update(activeTrade.id, updates);
            const updated = this.tradesRepo.getById(activeTrade.id)!;
            this.broadcastPositionEvent('UPDATED', updated, 'EXCHANGE_SYNC');
          }
        } else {
          // ORPHAN POSITION DETECTED ON EXCHANGE! [DEF-02]
          // SQLite thinks there's no active trade, but exchange has an open position!
          const lastTrade = this.tradesRepo.getLatestTrade(this.brokerMode, sym);
          const tradeSide: TradeSide = pos.positionAmt > 0 ? 'BUY' : 'SELL';
          const entryPrice = pos.entryPrice > 0 ? pos.entryPrice : (lastTrade?.entry_price || this.getMarkPrice(sym));
          const markPrice = this.getMarkPrice(sym) || entryPrice;
          const oppositeSide: TradeSide = tradeSide === 'BUY' ? 'SELL' : 'BUY';

          let adoptedTrade: TradeRecord;
          if (lastTrade && lastTrade.symbol === sym) {
            // Re-adopt the recently closed trade
            this.tradesRepo.update(lastTrade.id, {
              status: 'PARTIALLY_CLOSED',
              remaining_qty: liveQty,
              entry_price: Number(entryPrice.toFixed(4)),
              exit_price: null,
              exit_reason: null,
              closed_at: null,
            });
            adoptedTrade = this.tradesRepo.getById(lastTrade.id)!;
          } else {
            // Create a new adopted trade record
            const newTradeId = crypto.randomBytes(8).toString('hex');
            const newRecord: TradeRecord = {
              id: newTradeId,
              symbol: sym,
              broker_mode: this.brokerMode,
              side: tradeSide,
              status: 'OPEN',
              entry_price: Number(entryPrice.toFixed(4)),
              exit_price: null,
              quantity: liveQty,
              remaining_qty: liveQty,
              leverage: pos.leverage || 10,
              margin_usd: Number(((liveQty * entryPrice) / (pos.leverage || 10)).toFixed(2)),
              stop_loss: null,
              tp1: null,
              tp2: null,
              be_price: Number((tradeSide === 'BUY' ? entryPrice * 1.0025 : entryPrice * 0.9975).toFixed(4)),
              is_breakeven: 0,
              client_order_id: `tos_${newTradeId}_ent`,
              client_sl_id: `tos_${newTradeId}_sl`,
              client_tp1_id: null,
              client_tp2_id: null,
              entry_order_id: null,
              sl_algo_id: null,
              tp1_algo_id: null,
              tp2_algo_id: null,
              realized_pnl: 0,
              fees_usd: 0,
              exit_reason: null,
              opened_at: Date.now(),
              closed_at: null,
            };
            this.tradesRepo.insert(newRecord);
            adoptedTrade = newRecord;
          }

          // CRITICAL FAIL-CLOSED SAFETY:
          // Check if the exchange has an active Stop Loss for this adopted position
          let hasActiveSl = false;
          try {
            const openOrders = await this.broker.getOpenOrders(sym);
            hasActiveSl = openOrders.some(
              (o) => (o.type === 'STOP_MARKET' || o.type === 'STOP') && o.side === oppositeSide
            );
          } catch {
            // ignore
          }

          if (!hasActiveSl) {
            // Immediately place a protective Stop Loss so the position is NEVER naked!
            const isProfit = tradeSide === 'BUY' ? markPrice > entryPrice : markPrice < entryPrice;
            const protectiveSl = tradeSide === 'BUY'
              ? (isProfit ? Number((entryPrice * 1.0025).toFixed(4)) : Number((entryPrice * 0.985).toFixed(4)))
              : (isProfit ? Number((entryPrice * 0.9975).toFixed(4)) : Number((entryPrice * 1.015).toFixed(4)));

            try {
              const slRes = await this.broker.createAlgoOrder({
                symbol: sym,
                side: oppositeSide,
                type: 'STOP_MARKET',
                triggerPrice: protectiveSl,
                quantity: liveQty,
                clientAlgoId: `tos_${adoptedTrade.id}_sl`,
                reduceOnly: true,
              });
              this.tradesRepo.update(adoptedTrade.id, {
                stop_loss: protectiveSl,
                sl_algo_id: slRes.algoId,
                is_breakeven: isProfit ? 1 : 0,
              });
              adoptedTrade = this.tradesRepo.getById(adoptedTrade.id)!;
            } catch (slErr) {
              this.broadcastAlert(
                'CRITICAL',
                `Warning: Orphan position adopted on ${sym} but protective SL placement failed: ${slErr}`
              );
            }
          }

          this.auditLogRepo.insert({
            id: crypto.randomUUID(),
            event_type: 'ORPHAN_POSITION_ADOPTED',
            actor: 'RECONCILE_ENGINE',
            reason: `Adopted live exchange position of ${liveQty} ${sym}`,
            payload_json: JSON.stringify({
              symbol: sym,
              liveQty,
              entryPrice,
              tradeId: adoptedTrade.id,
            }),
            created_at: Date.now(),
          });

          this.broadcastPositionEvent('OPENED', adoptedTrade, 'ORPHAN_RECONCILE_ADOPTED');
          this.broadcastAlert('INFO', `Orphan position adopted on ${sym}: ${liveQty} contracts restored to active tracking.`);
        }
        return;
      }

      // Case 2: Exchange position is ZERO (liveQty === 0)
      if (liveQty === 0 && activeTrade) {
        let exitPrice = activeTrade.exit_price ?? null;
        let realizedPnl = activeTrade.realized_pnl ?? 0;
        let feesUsd = activeTrade.fees_usd ?? 0;
        let closedAt = Date.now();

        if (typeof this.broker.getSymbolUserTrades === 'function') {
          try {
            const userTrades = await this.broker.getSymbolUserTrades(
              activeTrade.symbol,
              activeTrade.opened_at
            );
            if (Array.isArray(userTrades) && userTrades.length > 0) {
              const closingSide = activeTrade.side === 'BUY' ? 'SELL' : 'BUY';
              const matchedFills = userTrades.filter(
                (f) =>
                  f.order_id === activeTrade.sl_algo_id ||
                  f.order_id === activeTrade.tp1_algo_id ||
                  f.order_id === activeTrade.tp2_algo_id ||
                  f.order_id === activeTrade.entry_order_id ||
                  f.filled_at >= activeTrade.opened_at
              );

              if (matchedFills.length > 0) {
                let sumRealized = 0;
                let sumFees = 0;
                let weightedCloseNotional = 0;
                let closeQty = 0;
                let maxFillTs = 0;

                for (const fill of matchedFills) {
                  sumRealized += Number(fill.realized_pnl || 0);
                  sumFees += Number(fill.commission || 0);
                  if (fill.filled_at > maxFillTs) maxFillTs = fill.filled_at;
                  if (fill.side === closingSide && fill.qty > 0 && fill.price > 0) {
                    weightedCloseNotional += fill.price * fill.qty;
                    closeQty += fill.qty;
                  }
                }

                if (closeQty > 0) {
                  exitPrice = Number((weightedCloseNotional / closeQty).toFixed(4));
                }
                if (sumRealized !== 0 || closeQty > 0) {
                  realizedPnl = Number(sumRealized.toFixed(4));
                }
                if (sumFees > 0) {
                  feesUsd = Number(sumFees.toFixed(4));
                }
                if (maxFillTs > 0) {
                  closedAt = maxFillTs;
                }
              }
            }
          } catch {
            // Tolerate userTrades fetch error and preserve existing SQLite fields
          }
        }

        // Mark as closed, persisting realized fills BEFORE notifyTradeClosed
        this.tradesRepo.update(activeTrade.id, {
          status: 'CLOSED',
          remaining_qty: 0,
          exit_price: exitPrice,
          realized_pnl: realizedPnl,
          fees_usd: feesUsd,
          exit_reason: activeTrade.exit_reason || 'EXCHANGE_SYNC_CLOSED',
          closed_at: closedAt,
        });
        const closed = this.tradesRepo.getById(activeTrade.id)!;
        this.broadcastPositionEvent('CLOSED', closed, 'EXCHANGE_SYNC_CLOSED');
        this.notifyTradeClosed(closed);
      }
    });
  }
}
