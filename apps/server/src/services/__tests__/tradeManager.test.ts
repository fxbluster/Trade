import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import { initializeDatabase, TradesRepo, FillsRepo, RiskStateRepo, PropFirmRepo } from '../../db/sqlite.js';
import { PropFirmRiskGuard } from '../../quant/propFirmRiskGuard.js';
import { TradeManager, TradeManagerError } from '../tradeManager.js';
import type {
  BrokerAdapter,
  PositionInfo,
  OrderExecutionResult,
  AlgoOrderParams,
  AlgoOrderResult,
} from '../../exchange/broker.js';
import type {
  AccountInfo,
  OpenOrderInfo,
  BrokerMode,
  WsServerMessage,
  OpenOrderRequest,
} from '@tradeos/shared';

class MockBrokerAdapter implements BrokerAdapter {
  readonly mode: BrokerMode = 'BINANCE_DEMO';
  public account: AccountInfo = {
    walletBalance: 1000,
    equity: 1000,
    availableBalance: 1000,
    unrealizedPnl: 0,
    currency: 'USDT',
  };
  public position: PositionInfo | null = null;
  public openOrders: OpenOrderInfo[] = [];

  public openOrderCalls: any[] = [];
  public createAlgoOrderCalls: any[] = [];
  public closePositionCalls: any[] = [];
  public cancelOrderCalls: any[] = [];
  public cancelAllOrdersCalls: any[] = [];

  public failOpenOrder = false;
  public failAlgoOrderFirst = false;
  public failAlgoOrderAlways = false;
  public failBreakevenAlways = false;
  public failRestoreSlAlways = false;

  public algoCallCount = 0;

  reset() {
    this.account = {
      walletBalance: 1000,
      equity: 1000,
      availableBalance: 1000,
      unrealizedPnl: 0,
      currency: 'USDT',
    };
    this.position = null;
    this.openOrders = [];
    this.openOrderCalls = [];
    this.createAlgoOrderCalls = [];
    this.closePositionCalls = [];
    this.cancelOrderCalls = [];
    this.cancelAllOrdersCalls = [];
    this.failOpenOrder = false;
    this.failAlgoOrderFirst = false;
    this.failAlgoOrderAlways = false;
    this.failBreakevenAlways = false;
    this.failRestoreSlAlways = false;
    this.algoCallCount = 0;
  }

  async getAccount(): Promise<AccountInfo> {
    return this.account;
  }

  async getPosition(symbol: string): Promise<PositionInfo | null> {
    return this.position;
  }

  async openOrder(req: any): Promise<OrderExecutionResult> {
    this.openOrderCalls.push(req);
    if (this.failOpenOrder) {
      throw new Error('Exchange entry order rejected');
    }
    const executedQty = req.quantity || (req.marginUsd * req.leverage) / 100;
    const avgPrice = req.limitPrice || 100;
    this.position = {
      symbol: req.symbol,
      positionAmt: req.side === 'BUY' ? executedQty : -executedQty,
      entryPrice: avgPrice,
      markPrice: avgPrice,
      unRealizedProfit: 0,
      liquidationPrice: 80,
      leverage: req.leverage,
    };
    return {
      orderId: 'ent_order_123',
      clientOrderId: req.clientOrderId || 'tos_trade1_ent',
      status: 'FILLED',
      executedQty,
      avgPrice,
    };
  }

  async createAlgoOrder(params: AlgoOrderParams): Promise<AlgoOrderResult> {
    this.createAlgoOrderCalls.push(params);
    this.algoCallCount++;

    if (this.failAlgoOrderAlways) {
      throw new Error('Exchange algo order rejected permanently');
    }
    if (this.failAlgoOrderFirst && this.algoCallCount === 1) {
      throw new Error('Exchange algo order rejected on first attempt');
    }
    if (this.failBreakevenAlways && params.type === 'STOP_MARKET') {
      throw new Error('Exchange breakeven SL rejected');
    }

    return {
      algoId: `algo_${this.algoCallCount}`,
      clientAlgoId: params.clientAlgoId,
      symbol: params.symbol,
      status: 'NEW',
    };
  }

  async closePosition(
    symbol: string,
    qty?: number
  ): Promise<{ orderId: string; status: string; avgPrice?: number }> {
    this.closePositionCalls.push({ symbol, qty });
    this.position = null;
    return {
      orderId: 'close_order_999',
      status: 'FILLED',
      avgPrice: 100,
    };
  }

  async cancelOrder(symbol: string, orderId: string, isAlgo?: boolean): Promise<boolean> {
    this.cancelOrderCalls.push({ symbol, orderId, isAlgo });
    return true;
  }

  async cancelAllOrders(symbol: string): Promise<boolean> {
    this.cancelAllOrdersCalls.push(symbol);
    return true;
  }

  async moveToBreakeven(
    symbol: string,
    bePrice: number,
    currentSlId?: string
  ): Promise<{ newSlId: string }> {
    return { newSlId: 'new_be_sl_123' };
  }

  async getOpenOrders(symbol?: string): Promise<OpenOrderInfo[]> {
    return this.openOrders;
  }
}

describe('TradeManager — Atomic Orchestration & Fail-Closed Execution', () => {
  let db: DatabaseSync;
  let mockBroker: MockBrokerAdapter;
  let tradeManager: TradeManager;
  let broadcastedMessages: WsServerMessage[];
  let markPriceMap: Map<string, number>;

  beforeEach(() => {
    db = initializeDatabase(':memory:');
    mockBroker = new MockBrokerAdapter();
    broadcastedMessages = [];
    markPriceMap = new Map([['SOLUSDT', 100]]);

    tradeManager = new TradeManager({
      db,
      broker: mockBroker,
      brokerMode: 'BINANCE_DEMO',
      getMarkPrice: (sym) => markPriceMap.get(sym) || 100,
      broadcastWs: (msg) => broadcastedMessages.push(msg),
    });
  });

  // --------------------------------------------------------------------------
  // Test 1: Bracket compensation unwind when SL fails after entry fill
  // --------------------------------------------------------------------------
  it('executes automated emergencyUnwindPosition (reduceOnly: true, MARKET) and returns 502 when SL placement fails after retry', async () => {
    // Force SL algo placement to fail permanently (both 1st attempt and retry)
    mockBroker.failAlgoOrderAlways = true;

    const req: OpenOrderRequest = {
      symbol: 'SOLUSDT',
      side: 'BUY',
      orderType: 'MARKET',
      marginUsd: 50,
      leverage: 5,
      stopLoss: 95,
      tp1: 110,
    };

    let caughtError: TradeManagerError | null = null;
    try {
      await tradeManager.openPosition(req);
    } catch (err: any) {
      caughtError = err;
    }

    expect(caughtError).not.toBeNull();
    expect(caughtError?.statusCode).toBe(502);
    expect(caughtError?.code).toBe('ERR_SL_PLACEMENT_FAIL_UNWIND');

    // Verify automated emergency unwind was invoked
    expect(mockBroker.closePositionCalls.length).toBeGreaterThanOrEqual(1);
    expect(mockBroker.closePositionCalls[0].symbol).toBe('SOLUSDT');

    // Verify pending orders/algos cancelled
    expect(mockBroker.cancelAllOrdersCalls.length).toBeGreaterThanOrEqual(1);

    // Verify SQLite recorded exit_reason = 'SL_PLACEMENT_FAIL_UNWIND'
    const tradesRepo = new TradesRepo(db);
    const activePosition = tradesRepo.getActivePosition('BINANCE_DEMO', 'SOLUSDT');
    expect(activePosition).toBeNull(); // Position is not active

    const closedTrades = tradesRepo.listClosed('BINANCE_DEMO', 10, 0, 'SOLUSDT');
    expect(closedTrades.length).toBe(1);
    expect(closedTrades[0].exit_reason).toBe('SL_PLACEMENT_FAIL_UNWIND');
    expect(closedTrades[0].status).toBe('CLOSED');
    expect(closedTrades[0].remaining_qty).toBe(0);

    // Verify critical alert was broadcast
    const alerts = broadcastedMessages.filter((m) => m.type === 'ALERT' && m.level === 'CRITICAL');
    expect(alerts.length).toBeGreaterThan(0);
  });

  // --------------------------------------------------------------------------
  // Test 2: Fail-closed Breakeven unwind when both new SL and restoration fail
  // --------------------------------------------------------------------------
  it('executes automated market unwind and returns 502 when Breakeven SL placement and original restoration both fail', async () => {
    // 1. Open a valid position first with SL at 95
    const req: OpenOrderRequest = {
      symbol: 'SOLUSDT',
      side: 'BUY',
      orderType: 'MARKET',
      marginUsd: 50,
      leverage: 5,
      stopLoss: 95,
      tp1: 115,
    };
    const trade = await tradeManager.openPosition(req);
    expect(trade.status).toBe('OPEN');
    expect(trade.stop_loss).toBe(95);

    // 2. Set markPrice safely above breakeven buffer (100 * 1.0015 = 100.15) -> markPrice = 105
    markPriceMap.set('SOLUSDT', 105);

    // 3. Make all subsequent algo orders fail (both new BE SL and restoration)
    mockBroker.failAlgoOrderAlways = true;

    let caughtError: TradeManagerError | null = null;
    try {
      await tradeManager.moveToBreakeven('SOLUSDT');
    } catch (err: any) {
      caughtError = err;
    }

    expect(caughtError).not.toBeNull();
    expect(caughtError?.statusCode).toBe(502);
    expect(caughtError?.code).toBe('ERR_BREAKEVEN_FAIL_CLOSED_UNWIND');

    // Verify market unwind was executed
    expect(mockBroker.closePositionCalls.length).toBeGreaterThanOrEqual(1);

    // Verify SQLite recorded exit_reason = 'BREAKEVEN_FAIL_CLOSED_UNWIND'
    const tradesRepo = new TradesRepo(db);
    const updated = tradesRepo.getById(trade.id);
    expect(updated?.status).toBe('CLOSED');
    expect(updated?.exit_reason).toBe('BREAKEVEN_FAIL_CLOSED_UNWIND');
    expect(updated?.remaining_qty).toBe(0);

    // Verify critical alert broadcast
    const criticalAlerts = broadcastedMessages.filter(
      (m) => m.type === 'ALERT' && m.level === 'CRITICAL' && m.message.includes('Breakeven')
    );
    expect(criticalAlerts.length).toBeGreaterThanOrEqual(1);
  });

  // --------------------------------------------------------------------------
  // Test 3: Deterministic clientOrderId extraction and fill recording
  // --------------------------------------------------------------------------
  it('extracts tradeId from deterministic tos_${tradeId}_* prefix, records fills without duplicates, and transitions to PARTIALLY_CLOSED', async () => {
    const req: OpenOrderRequest = {
      symbol: 'SOLUSDT',
      side: 'BUY',
      orderType: 'MARKET',
      marginUsd: 50,
      leverage: 5,
      stopLoss: 95,
      tp1: 110,
    };
    const trade = await tradeManager.openPosition(req);
    const initialQty = trade.quantity;

    // Simulate TP1 fill arriving from WebSocket
    const rawWsEvent = {
      clientOrderId: `tos_${trade.id}_tp1`,
      tradeId: 'binance_fill_1001',
      orderId: 'tp1_order_555',
      symbol: 'SOLUSDT',
      side: 'SELL',
      lastFilledPrice: 110,
      lastFilledQty: Number((initialQty * 0.5).toFixed(4)),
      commission: 0.05,
      commissionAsset: 'USDT',
      tradeTime: Date.now(),
    };

    await tradeManager.handleOrderTradeUpdate(rawWsEvent);

    const fillsRepo = new FillsRepo(db);
    const tradesRepo = new TradesRepo(db);

    const fills = fillsRepo.getByTradeId(trade.id);
    expect(fills.length).toBe(1);
    expect(fills[0].binance_trade_id).toBe('binance_fill_1001');
    expect(fills[0].price).toBe(110);
    expect(fills[0].qty).toBe(Number((initialQty * 0.5).toFixed(4)));

    // Verify trade status transitioned to PARTIALLY_CLOSED and remaining_qty updated
    const updatedTrade = tradesRepo.getById(trade.id);
    expect(updatedTrade?.status).toBe('PARTIALLY_CLOSED');
    expect(updatedTrade?.remaining_qty).toBeCloseTo(initialQty * 0.5, 4);

    // Verify duplicate fill is ignored without throwing or corrupting
    await tradeManager.handleOrderTradeUpdate(rawWsEvent);
    const duplicateCheckFills = fillsRepo.getByTradeId(trade.id);
    expect(duplicateCheckFills.length).toBe(1); // Still exactly 1
  });

  // --------------------------------------------------------------------------
  // Test 4: Metadata preservation during sync
  // --------------------------------------------------------------------------
  it('reconciles with exchange while never wiping SQLite metadata (stop_loss, tp1, tp2, opened_at, entry_price)', async () => {
    const req: OpenOrderRequest = {
      symbol: 'SOLUSDT',
      side: 'BUY',
      orderType: 'MARKET',
      marginUsd: 50,
      leverage: 5,
      stopLoss: 95,
      tp1: 110,
      tp2: 120,
    };
    const originalTrade = await tradeManager.openPosition(req);
    expect(originalTrade.stop_loss).toBe(95);
    expect(originalTrade.tp1).toBe(110);
    expect(originalTrade.tp2).toBe(120);
    expect(originalTrade.opened_at).toBeGreaterThan(0);
    expect(originalTrade.entry_price).toBe(100);

    // Simulate exchange reporting position closed
    mockBroker.position = null;

    // Trigger reconciliation
    await tradeManager.reconcileWithExchange();

    const tradesRepo = new TradesRepo(db);
    const syncedTrade = tradesRepo.getById(originalTrade.id);

    expect(syncedTrade?.status).toBe('CLOSED');
    expect(syncedTrade?.remaining_qty).toBe(0);
    // Crucial: Historical metadata must NEVER be wiped or set to null
    expect(syncedTrade?.stop_loss).toBe(95);
    expect(syncedTrade?.tp1).toBe(110);
    expect(syncedTrade?.tp2).toBe(120);
    expect(syncedTrade?.opened_at).toBe(originalTrade.opened_at);
    expect(syncedTrade?.entry_price).toBe(100);
    expect(syncedTrade?.exit_reason).toBe('EXCHANGE_SYNC_CLOSED');
  });

  // --------------------------------------------------------------------------
  // Test 5: Cooldown 423 block after 2 consecutive losses
  // --------------------------------------------------------------------------
  it('blocks openPosition with HTTP 423 Locked when risk_state has an active cooldown after 2 consecutive losses', async () => {
    const riskStateRepo = new RiskStateRepo(db);
    const now = Date.now();

    // Seed risk_state with 2 consecutive losses and 15m active cooldown
    riskStateRepo.update({
      broker_mode: 'BINANCE_DEMO',
      consecutive_losses: 2,
      cooldown_until: now + 15 * 60 * 1000,
      cooldown_reason: '2_CONSECUTIVE_LOSSES',
      session_net_pnl: -12.5,
      session_started_at: now - 3600 * 1000,
      updated_at: now,
    });

    const req: OpenOrderRequest = {
      symbol: 'SOLUSDT',
      side: 'BUY',
      orderType: 'MARKET',
      marginUsd: 50,
      leverage: 5,
      stopLoss: 95,
    };

    let caughtError: TradeManagerError | null = null;
    try {
      await tradeManager.openPosition(req);
    } catch (err: any) {
      caughtError = err;
    }

    expect(caughtError).not.toBeNull();
    expect(caughtError?.statusCode).toBe(423);
    expect(caughtError?.code).toBe('ERR_COOLDOWN_ACTIVE');
    expect(caughtError?.message).toContain('Anti-qumar');

    // Verify zero orders reached the broker
    expect(mockBroker.openOrderCalls.length).toBe(0);
    expect(mockBroker.createAlgoOrderCalls.length).toBe(0);
  });

  // --------------------------------------------------------------------------
  // Test 6: Pre-flight buffer check in moveToBreakeven
  // --------------------------------------------------------------------------
  it('rejects moveToBreakeven with 400 when markPrice is not safe distance from breakeven buffer', async () => {
    const req: OpenOrderRequest = {
      symbol: 'SOLUSDT',
      side: 'BUY',
      orderType: 'MARKET',
      marginUsd: 50,
      leverage: 5,
      stopLoss: 95,
    };
    await tradeManager.openPosition(req);

    // For BUY at 100, Breakeven with 0.15% buffer is 100.15.
    // If markPrice is 100.05 (below BE buffer) or 99 (in loss), pre-flight must reject.
    markPriceMap.set('SOLUSDT', 100.05);

    let caughtError: TradeManagerError | null = null;
    try {
      await tradeManager.moveToBreakeven('SOLUSDT');
    } catch (err: any) {
      caughtError = err;
    }

    expect(caughtError).not.toBeNull();
    expect(caughtError?.statusCode).toBe(400);
    expect(caughtError?.code).toBe('ERR_BREAKEVEN_BUFFER_VIOLATION');

    // Original SL was never cancelled or touched
    expect(mockBroker.cancelOrderCalls.length).toBe(0);
  });

  // --------------------------------------------------------------------------
  // Test 7: Unified PropFirm Gate (403 halt, 409 global 1-pos, $250 clamp, 400 zero-SL)
  // --------------------------------------------------------------------------
  it('enforces PropFirm 403 halt, 409 global 1-pos mutex, $250 clamp with marginUsd recompute, and 400 zero-SL rejection', async () => {
    const propRepo = new PropFirmRepo(db);
    const guard = new PropFirmRiskGuard(propRepo);
    const openedTrades: string[] = [];
    const guardedTm = new TradeManager({
      db,
      broker: mockBroker,
      brokerMode: 'BINANCE_DEMO',
      propFirmRiskGuard: guard,
      getMarkPrice: (sym) => markPriceMap.get(sym) || 100,
      onTradeOpened: (t) => openedTrades.push(t.id),
    });

    mockBroker.account.walletBalance = 50_000;
    mockBroker.account.availableBalance = 50_000;
    markPriceMap.set('SOLUSDT', 100);
    markPriceMap.set('BTCUSDT', 100);

    // Zero/invalid SL distance -> 400 ERR_PROPFIRM_RISK_LIMIT
    await expect(
      guardedTm.openPosition({
        symbol: 'SOLUSDT',
        side: 'BUY',
        orderType: 'MARKET',
        marginUsd: 500,
        leverage: 10,
        stopLoss: 100, // 0 distance
      })
    ).rejects.toMatchObject({ statusCode: 400, code: 'ERR_PROPFIRM_RISK_LIMIT' });

    // Concurrent cross-symbol open (SOLUSDT + BTCUSDT) -> global mutex lets 1 succeed clamped ($250 risk) & blocks 2nd with 409
    const p1 = guardedTm.openPosition({
      symbol: 'SOLUSDT',
      side: 'BUY',
      orderType: 'MARKET',
      marginUsd: 2_500,
      leverage: 10,
      stopLoss: 95, // $5 distance -> clamped to 50 qty ($500 margin)
    });
    const p2 = guardedTm.openPosition({
      symbol: 'BTCUSDT',
      side: 'BUY',
      orderType: 'MARKET',
      marginUsd: 500,
      leverage: 10,
      stopLoss: 95,
    });
    const [r1, r2] = await Promise.allSettled([p1, p2]);
    expect(r1.status).toBe('fulfilled');
    if (r1.status === 'fulfilled') {
      expect(r1.value.quantity).toBe(50);
      expect(r1.value.margin_usd).toBe(500);
      expect(openedTrades).toEqual([r1.value.id]);
    }
    expect(r2.status).toBe('rejected');
    if (r2.status === 'rejected') {
      expect(r2.reason).toBeInstanceOf(TradeManagerError);
      expect(r2.reason.statusCode).toBe(409);
      expect(r2.reason.code).toBe('ERR_POSITION_EXISTS');
    }

    // Close active trade, breach daily halt -> 403 UPCOMERS_DAILY_HALT
    await guardedTm.closePosition('SOLUSDT', 'MANUAL_CLOSE');
    guard.evaluateLiveEquity({
      realizedCyclePnlUsd: -1_300,
      unrealizedPnlUsd: 0,
      liveWalletBalanceUsd: 50_000,
      hasOpenPosition: false,
    });
    await expect(
      guardedTm.openPosition({
        symbol: 'SOLUSDT',
        side: 'BUY',
        orderType: 'MARKET',
        marginUsd: 200,
        leverage: 10,
        stopLoss: 95,
      })
    ).rejects.toMatchObject({ statusCode: 403, code: 'UPCOMERS_DAILY_HALT' });
  });

  // --------------------------------------------------------------------------
  // Test 8: Unfilled resting LIMIT cancels & throws 409 ERR_LIMIT_ORDER_UNFILLED
  // --------------------------------------------------------------------------
  it('auto-cancels unfilled resting LIMIT order (executedQty=0) and rejects with 409 ERR_LIMIT_ORDER_UNFILLED', async () => {
    vi.spyOn(mockBroker, 'openOrder').mockResolvedValueOnce({
      orderId: 'resting_limit_1',
      clientOrderId: 'tos_limit_1_ent',
      status: 'NEW',
      executedQty: 0,
      avgPrice: 0,
    });

    await expect(
      tradeManager.openPosition({
        symbol: 'SOLUSDT',
        side: 'BUY',
        orderType: 'LIMIT',
        limitPrice: 95,
        marginUsd: 50,
        leverage: 5,
        stopLoss: 90,
      })
    ).rejects.toMatchObject({
      statusCode: 409,
      code: 'ERR_LIMIT_ORDER_UNFILLED',
    });

    expect(mockBroker.cancelOrderCalls).toEqual([
      { symbol: 'SOLUSDT', orderId: 'resting_limit_1', isAlgo: false },
    ]);
    const tradesRepo = new TradesRepo(db);
    expect(tradesRepo.getActivePosition('BINANCE_DEMO', 'SOLUSDT')).toBeNull();
  });

  // --------------------------------------------------------------------------
  // Test 9: Offline reconcileWithExchange iterates all open symbols & syncs userTrades BEFORE notifyTradeClosed
  // --------------------------------------------------------------------------
  it('reconciles all open SQLite symbols, fetches getSymbolUserTrades, and persists exit_price/PnL/fees before notifyTradeClosed', async () => {
    const tradesRepo = new TradesRepo(db);
    const closedEvents: Array<{ id: string; exit_price: number | null; realized_pnl: number; fees_usd: number }> = [];
    const tmWithSync = new TradeManager({
      db,
      broker: {
        ...mockBroker,
        mode: 'BINANCE_DEMO',
        getAccount: () => mockBroker.getAccount(),
        getPosition: async () => null,
        openOrder: (r) => mockBroker.openOrder(r),
        createAlgoOrder: (p) => mockBroker.createAlgoOrder(p),
        closePosition: (s, q) => mockBroker.closePosition(s, q),
        cancelOrder: (s, o, a) => mockBroker.cancelOrder(s, o, a),
        cancelAllOrders: (s) => mockBroker.cancelAllOrders(s),
        moveToBreakeven: (s, b, c) => mockBroker.moveToBreakeven(s, b, c),
        getOpenOrders: (s) => mockBroker.getOpenOrders(s),
        getSymbolUserTrades: async (symbol: string) => {
          if (symbol === 'ETHUSDT') {
            return [
              {
                binance_trade_id: 'ut_1',
                trade_id: 'offline_eth_1',
                order_id: 'sl_eth_1',
                symbol: 'ETHUSDT',
                side: 'SELL',
                price: 2950,
                qty: 2,
                realized_pnl: -100,
                commission: 2.95,
                commission_asset: 'USDT',
                filled_at: Date.now(),
              },
            ];
          }
          return [];
        },
      },
      brokerMode: 'BINANCE_DEMO',
      getMarkPrice: () => 100,
      onTradeClosed: (trade) => {
        closedEvents.push({
          id: trade.id,
          exit_price: trade.exit_price,
          realized_pnl: trade.realized_pnl,
          fees_usd: trade.fees_usd,
        });
      },
    });

    tradesRepo.insert({
      id: 'offline_eth_1',
      symbol: 'ETHUSDT',
      broker_mode: 'BINANCE_DEMO',
      side: 'BUY',
      status: 'OPEN',
      entry_price: 3000,
      exit_price: null,
      quantity: 2,
      remaining_qty: 2,
      leverage: 10,
      margin_usd: 600,
      stop_loss: 2950,
      tp1: null,
      tp2: null,
      be_price: null,
      is_breakeven: 0,
      client_order_id: 'tos_offline_eth_1_ent',
      client_sl_id: 'tos_offline_eth_1_sl',
      client_tp1_id: null,
      client_tp2_id: null,
      entry_order_id: 'ent_eth_1',
      sl_algo_id: 'sl_eth_1',
      tp1_algo_id: null,
      tp2_algo_id: null,
      realized_pnl: 0,
      fees_usd: 0,
      exit_reason: null,
      opened_at: Date.now() - 60_000,
      closed_at: null,
    });

    // Reconcile targeting SOLUSDT -> still iterates ETHUSDT from SQLite open trades!
    await tmWithSync.reconcileWithExchange('SOLUSDT');

    expect(closedEvents).toHaveLength(1);
    expect(closedEvents[0]).toEqual({
      id: 'offline_eth_1',
      exit_price: 2950,
      realized_pnl: -100,
      fees_usd: 2.95,
    });
    expect(tradesRepo.getActivePositionCached('BINANCE_DEMO', 'ETHUSDT')).toBeNull();
  });

  // --------------------------------------------------------------------------
  // Test 10: PropFirmRiskGuard parity in LOCAL_PAPER mode
  // --------------------------------------------------------------------------
  it('enforces PropFirmRiskGuard 1-position limit and daily halt in LOCAL_PAPER mode', async () => {
    const paperBroker = new MockBrokerAdapter();
    (paperBroker as unknown as { mode: BrokerMode }).mode = 'LOCAL_PAPER';
    paperBroker.account = {
      walletBalance: 5_000,
      equity: 5_000,
      availableBalance: 5_000,
      unrealizedPnl: 0,
      currency: 'USDT',
    };

    const propFirmRepo = new PropFirmRepo(db);
    const guard = new PropFirmRiskGuard(propFirmRepo);
    const paperTm = new TradeManager({
      db,
      broker: paperBroker,
      brokerMode: 'LOCAL_PAPER',
      getMarkPrice: () => 100,
      propFirmRiskGuard: guard,
    });

    const t1 = await paperTm.openPosition({
      symbol: 'SOLUSDT',
      side: 'BUY',
      orderType: 'MARKET',
      marginUsd: 200,
      leverage: 10,
      stopLoss: 95,
    });
    expect(t1.broker_mode).toBe('LOCAL_PAPER');

    await expect(
      paperTm.openPosition({
        symbol: 'BTCUSDT',
        side: 'BUY',
        orderType: 'MARKET',
        marginUsd: 200,
        leverage: 10,
        stopLoss: 95,
      })
    ).rejects.toMatchObject({ statusCode: 409, code: 'ERR_POSITION_EXISTS' });

    await paperTm.closePosition('SOLUSDT', 'MANUAL_CLOSE');
    guard.evaluateLiveEquity({
      realizedCyclePnlUsd: -130,
      unrealizedPnlUsd: 0,
      liveWalletBalanceUsd: 5_000,
      hasOpenPosition: false,
    });

    await expect(
      paperTm.openPosition({
        symbol: 'SOLUSDT',
        side: 'BUY',
        orderType: 'MARKET',
        marginUsd: 200,
        leverage: 10,
        stopLoss: 95,
      })
    ).rejects.toMatchObject({ statusCode: 403, code: 'UPCOMERS_DAILY_HALT' });
  });

  // --------------------------------------------------------------------------
  // Test 11: [DEF-02 / DEF-03] Global 1-position limit & fee+slippage BE buffer
  // --------------------------------------------------------------------------
  it('enforces global 1-position limit across DB and exchangePositions without PropFirm guard, and includes 0.25% BE buffer', async () => {
    markPriceMap.set('XRPUSDT', 0.5);
    markPriceMap.set('BTCUSDT', 60000);
    (mockBroker as any).getAllPositions = async () =>
      mockBroker.position ? [mockBroker.position] : [];

    const t1 = await tradeManager.openPosition({
      symbol: 'XRPUSDT',
      side: 'BUY',
      orderType: 'LIMIT',
      limitPrice: 0.5,
      marginUsd: 50,
      leverage: 5,
      stopLoss: 0.48,
    });
    expect(t1.be_price).toBeCloseTo(0.5 * 1.0025, 4);

    // Second symbol blocked by global 1-position guard
    await expect(
      tradeManager.openPosition({
        symbol: 'BTCUSDT',
        side: 'SELL',
        orderType: 'MARKET',
        marginUsd: 50,
        leverage: 5,
        stopLoss: 61000,
      })
    ).rejects.toMatchObject({ statusCode: 409, code: 'ERR_POSITION_EXISTS' });

    // Even if DB record is closed, open exchangePosition still blocks new entry
    const tradesRepo = new TradesRepo(db);
    tradesRepo.update(t1.id, { status: 'CLOSED', closed_at: Date.now() });

    await expect(
      tradeManager.openPosition({
        symbol: 'BTCUSDT',
        side: 'SELL',
        orderType: 'MARKET',
        marginUsd: 50,
        leverage: 5,
        stopLoss: 61000,
      })
    ).rejects.toMatchObject({ statusCode: 409, code: 'ERR_POSITION_EXISTS' });
  });
});
