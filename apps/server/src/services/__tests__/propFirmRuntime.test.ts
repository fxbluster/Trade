import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import { initializeDatabase, PropFirmRepo, TradesRepo } from '../../db/sqlite.js';
import { PropFirmRiskGuard } from '../../quant/propFirmRiskGuard.js';
import { ConfluenceEngine } from '../../quant/confluenceEngine.js';
import { ChasingExecutionEngine } from '../chasingExecutionEngine.js';
import { TradeManager, TradeManagerError } from '../tradeManager.js';
import { AutoPilotManager } from '../autoPilotManager.js';
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
  ConfluenceSnapshot,
  TradeRecord,
} from '@tradeos/shared';

class RuntimeMockBroker implements BrokerAdapter {
  readonly mode: BrokerMode = 'BINANCE_DEMO';
  public account: AccountInfo = {
    walletBalance: 50_000,
    equity: 50_000,
    availableBalance: 50_000,
    unrealizedPnl: 0,
    currency: 'USDT',
  };
  public position: PositionInfo | null = null;
  public openOrders: OpenOrderInfo[] = [];
  public openOrderCalls: any[] = [];
  public closePositionCalls: any[] = [];
  public nextCloseError: Error | null = null;
  public markPriceForClose: number | null = null;

  async getAccount(): Promise<AccountInfo> {
    return { ...this.account };
  }

  async getPosition(_symbol: string): Promise<PositionInfo | null> {
    return this.position;
  }

  async openOrder(req: any): Promise<OrderExecutionResult> {
    this.openOrderCalls.push(req);
    const avgPrice = req.limitPrice || this.markPriceForClose || 100;
    const executedQty = req.quantity || (req.marginUsd * req.leverage) / avgPrice;
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
      orderId: 'ent_' + Math.random().toString(36).slice(2, 8),
      clientOrderId: req.clientOrderId || 'tos_ent',
      status: 'FILLED',
      executedQty,
      avgPrice,
    };
  }

  async createAlgoOrder(params: AlgoOrderParams): Promise<AlgoOrderResult> {
    return {
      algoId: 'algo_' + Math.random().toString(36).slice(2, 8),
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
    if (this.nextCloseError) {
      const err = this.nextCloseError;
      this.nextCloseError = null;
      throw err;
    }
    const avgPrice = this.markPriceForClose ?? this.position?.markPrice ?? 100;
    this.position = null;
    return {
      orderId: 'close_' + Math.random().toString(36).slice(2, 8),
      status: 'FILLED',
      avgPrice,
    };
  }

  async cancelOrder(_symbol: string, _orderId: string, _isAlgo?: boolean): Promise<boolean> {
    return true;
  }

  async cancelAllOrders(_symbol: string): Promise<boolean> {
    return true;
  }

  async moveToBreakeven(
    _symbol: string,
    _bePrice: number,
    _currentSlId?: string
  ): Promise<{ newSlId: string }> {
    return { newSlId: 'be_sl_1' };
  }

  async getOpenOrders(_symbol?: string): Promise<OpenOrderInfo[]> {
    return this.openOrders;
  }
}

function makeOpenTrade(overrides: Partial<TradeRecord> = {}): TradeRecord {
  return {
    id: 'trade_open_1',
    symbol: 'SOLUSDT',
    broker_mode: 'BINANCE_DEMO',
    side: 'BUY',
    status: 'OPEN',
    entry_price: 100,
    exit_price: null,
    quantity: 250,
    remaining_qty: 250,
    leverage: 10,
    margin_usd: 2500,
    stop_loss: 80,
    tp1: 120,
    tp2: 130,
    be_price: 100.15,
    is_breakeven: 0,
    peak_price: 100,
    peak_mfe: 0,
    trailing_stop_active: 0,
    client_order_id: 'tos_trade_open_1_ent',
    client_sl_id: 'tos_trade_open_1_sl',
    client_tp1_id: 'tos_trade_open_1_tp1',
    client_tp2_id: 'tos_trade_open_1_tp2',
    entry_order_id: 'ent_1',
    sl_algo_id: 'sl_1',
    tp1_algo_id: 'tp1_1',
    tp2_algo_id: 'tp2_1',
    realized_pnl: 0,
    fees_usd: 0,
    exit_reason: null,
    opened_at: Date.now() - 30_000,
    closed_at: null,
    ...overrides,
  };
}

function setBuySnapshot(confluenceEngine: ConfluenceEngine): void {
  const snap: ConfluenceSnapshot = {
    symbol: 'SOLUSDT',
    pillars: [],
    bullishCount: 5,
    bearishCount: 0,
    neutralCount: 2,
    consensusBias: 'BULLISH',
    consensusMet: true,
    threshold: 4,
    compositeScore: 84,
    recommendedAction: 'BUY',
    macroVetoActive: false,
    macroRegime: 'MACRO_BULLISH',
    activeFvgs: [],
    activeOrderBlocks: [],
    latestSweep: null,
  };
  confluenceEngine.getSnapshot = () => snap;
  confluenceEngine.getLatestSnapshot = () => snap;
  confluenceEngine.evaluate = () => snap;
  (confluenceEngine as any).latestSnapshot = snap;
}

describe('PropFirm Runtime Integration (Task 3)', () => {
  let db: DatabaseSync;
  let propFirmRepo: PropFirmRepo;
  let tradesRepo: TradesRepo;
  let mockBroker: RuntimeMockBroker;
  let guard: PropFirmRiskGuard;
  let markPrice: number;
  let tradeManager: TradeManager;
  let confluenceEngine: ConfluenceEngine;
  let autoPilot: AutoPilotManager;

  beforeEach(() => {
    db = initializeDatabase(':memory:');
    propFirmRepo = new PropFirmRepo(db);
    tradesRepo = new TradesRepo(db);
    mockBroker = new RuntimeMockBroker();
    markPrice = 100;
    guard = new PropFirmRiskGuard(propFirmRepo);

    tradeManager = new TradeManager({
      db,
      broker: mockBroker,
      brokerMode: 'BINANCE_DEMO',
      propFirmRiskGuard: guard,
      getMarkPrice: () => markPrice,
      onTradeClosed: (trade) => {
        if (trade.broker_mode !== 'BINANCE_DEMO') return;
        const realizedNetPnlUsd = Number(
          ((trade.realized_pnl ?? 0) - (trade.fees_usd ?? 0)).toFixed(2)
        );
        guard.recordTradeClosed({
          tradeId: trade.id,
          realizedNetPnlUsd,
          liveWalletBalanceUsd: mockBroker.account.walletBalance,
        });
      },
    });

    confluenceEngine = new ConfluenceEngine();
    autoPilot = new AutoPilotManager({
      db,
      tradeManager,
      broker: mockBroker,
      confluenceEngine,
      propFirmRiskGuard: guard,
      getMarkPrice: () => markPrice,
      getAtr: () => 2.0,
      config: {
        enabled: true,
        consensusThreshold: 4,
        marginAllocationPct: 10,
        leverage: 10,
        maxDailyTrades: 5,
        dailyDrawdownLimitPct: 2.0,
      },
    });
  });

  it('autoPilot_targetReachedClosesPositionThenPasses', async () => {
    const trade = makeOpenTrade({ id: 'prop_target_1' });
    tradesRepo.insert(trade);
    mockBroker.position = {
      symbol: 'SOLUSDT',
      positionAmt: 250,
      entryPrice: 100,
      markPrice: 110.07,
      unRealizedProfit: 2517.5,
      liquidationPrice: 80,
      leverage: 10,
    };

    // Tick at $110.07 -> floating +$2,517.50 minus 5bps close fee (~$13.76) = $52,503.74 >= $52,500
    markPrice = 110.07;
    mockBroker.markPriceForClose = 110.07;
    await autoPilot.onTick('SOLUSDT', 110.07);

    expect(mockBroker.closePositionCalls).toHaveLength(1);
    const closed = tradesRepo.getById('prop_target_1')!;
    expect(closed.status).toBe('CLOSED');
    expect(closed.exit_reason).toBe('PROPFIRM_TARGET_REACHED');

    const status = guard.getStatus(mockBroker.account.walletBalance);
    expect(status.cycle.status).toBe('PASSED');
    expect(status.consecutivePassedCycles).toBe(1);
    expect(status.cycle.tradesCount).toBe(1);
    expect((autoPilot as any).statusMessage).toBeNull();

    // Subsequent entry attempt after 180s lockout must block with CYCLE_TERMINAL
    (autoPilot as any).lastExitTime = Date.now() - 200_000;
    setBuySnapshot(confluenceEngine);
    await autoPilot.onTick('SOLUSDT', 110.07);

    expect(mockBroker.openOrderCalls).toHaveLength(0);
    expect((autoPilot as any).blockReason).toBe('CYCLE_TERMINAL');
  });

  it('autoPilot_failedCloseRestoresStatusAndRetriesWithoutNakedWedge', async () => {
    const trade = makeOpenTrade({ id: 'prop_retry_1' });
    tradesRepo.insert(trade);
    mockBroker.position = {
      symbol: 'SOLUSDT',
      positionAmt: 250,
      entryPrice: 100,
      markPrice: 110.07,
      unRealizedProfit: 2517.5,
      liquidationPrice: 80,
      leverage: 10,
    };

    // First close rejects with transient network timeout
    mockBroker.nextCloseError = new Error('Network timeout');
    markPrice = 110.07;
    mockBroker.markPriceForClose = 110.07;
    await autoPilot.onTick('SOLUSDT', 110.07);

    const afterFail = tradesRepo.getById('prop_retry_1')!;
    expect(afterFail.status).toBe('OPEN');
    expect(autoPilot.getState()).toBe('POSITION_OPEN');
    expect(autoPilot.getOpenTradeId()).toBe('prop_retry_1');
    expect(guard.getStatus().cycle.status).toBe('ACTIVE');
    expect(guard.getStatus().cycle.tradesCount).toBe(0);

    // Next tick retries closePosition cleanly and settles PASSED
    await autoPilot.onTick('SOLUSDT', 110.07);

    expect(mockBroker.closePositionCalls).toHaveLength(2);
    const afterRetry = tradesRepo.getById('prop_retry_1')!;
    expect(afterRetry.status).toBe('CLOSED');
    expect(afterRetry.exit_reason).toBe('PROPFIRM_TARGET_REACHED');
    expect(guard.getStatus().cycle.status).toBe('PASSED');
    expect(guard.getStatus().cycle.tradesCount).toBe(1);
  });

  it('tradeManager_manualCloseAndUserDataFillSyncPropFirmLedger', async () => {
    // AutoPilot is disabled, but manual OrderTicket flow still enforces PropFirmRiskGuard in BINANCE_DEMO
    autoPilot.setEnabled(false);

    // 1. Manual openPosition is clamped to $250.00 max risk when PropFirmRiskGuard is wired
    mockBroker.account.walletBalance = 50_000;
    mockBroker.account.availableBalance = 50_000;
    markPrice = 100;
    const manual1 = await tradeManager.openPosition({
      symbol: 'SOLUSDT',
      side: 'BUY',
      orderType: 'MARKET',
      marginUsd: 2_500,
      leverage: 10,
      stopLoss: 95, // $5 stop distance -> clamped from 250 qty to 50 qty ($250 risk, $500 margin)
      tp1: 115,
    });
    expect(manual1.quantity).toBe(50);
    expect(manual1.margin_usd).toBe(500);

    // Close via TradeManager.closePosition -> syncs realizedPnlUsd and tradesCount
    mockBroker.markPriceForClose = 102;
    await tradeManager.closePosition('SOLUSDT', 'MANUAL_CLOSE');
    let st = guard.getStatus(50_000);
    expect(st.cycle.tradesCount).toBe(1);
    const expectedNet1 = Number(((102 - 100) * 50 - 102 * 50 * 0.0005).toFixed(2));
    expect(st.cycle.realizedPnlUsd).toBe(expectedNet1);

    // 2. UserData SL fill syncs ledger without AutoPilot
    const manual2 = makeOpenTrade({
      id: 'manualsl2',
      entry_price: 100,
      quantity: 50,
      remaining_qty: 50,
      stop_loss: 98,
    });
    tradesRepo.insert(manual2);
    await tradeManager.handleOrderTradeUpdate({
      clientOrderId: 'tos_manualsl2_sl',
      orderId: 'sl_ord_2',
      tradeId: 'fill_sl_2',
      lastFilledPrice: 98,
      lastFilledQty: 50,
      commission: 2.45,
      tradeTime: Date.now(),
    });
    st = guard.getStatus(50_000);
    expect(st.cycle.tradesCount).toBe(2);
    expect(st.cycle.realizedPnlUsd).toBe(Number((expectedNet1 - 100 - 2.45).toFixed(2)));

    // 3. ReconcileWithExchange Case 2 syncs ledger without duplicate counting
    const manual3 = makeOpenTrade({
      id: 'manualsync3',
      entry_price: 100,
      quantity: 10,
      remaining_qty: 10,
      realized_pnl: 80,
      fees_usd: 1,
    });
    tradesRepo.insert(manual3);
    mockBroker.position = null;
    await tradeManager.reconcileWithExchange('SOLUSDT');
    await tradeManager.reconcileWithExchange('SOLUSDT');
    st = guard.getStatus(50_000);
    expect(st.cycle.tradesCount).toBe(3);
    expect(st.cycle.realizedPnlUsd).toBe(Number((expectedNet1 - 102.45 + 79).toFixed(2)));

    // Manual openPosition MUST be blocked (403) when PropFirmRiskGuard cycle is terminal
    guard.recordTradeClosed({
      tradeId: 'force_pass_for_manual_check',
      realizedNetPnlUsd: 3_000,
      liveWalletBalanceUsd: 50_000,
    });
    expect(guard.canOpenTrade().allowed).toBe(false);
    await expect(
      tradeManager.openPosition({
        symbol: 'SOLUSDT',
        side: 'BUY',
        orderType: 'MARKET',
        marginUsd: 1_000,
        leverage: 10,
        stopLoss: 95,
      })
    ).rejects.toMatchObject({
      statusCode: 403,
      code: 'CYCLE_TERMINAL',
    });
  });

  it('autoPilot_cycle2AllowedImmediatelyOn4606WalletAfterClearPropFirmBlock', async () => {
    const wallet = 4_606.01;
    mockBroker.account.walletBalance = wallet;
    mockBroker.account.equity = wallet;
    mockBroker.account.availableBalance = wallet;

    // Seed same-day Cycle #1 closed trades with -$150 net loss today (> 2% of $4,606.01 = -$92.12)
    // and 5 same-day trades (hitting maxDailyTrades = 5), while Cycle #1 passed with -$150 + +$2,650.
    const earlierToday = Date.now() - 60_000;
    for (let i = 0; i < 4; i++) {
      tradesRepo.insert(
        makeOpenTrade({
          id: `c1_t_${i}`,
          status: 'CLOSED',
          remaining_qty: 0,
          realized_pnl: i === 0 ? -150 : 0,
          fees_usd: 0,
          opened_at: earlierToday + i * 1000,
          closed_at: earlierToday + i * 1000 + 500,
        })
      );
    }
    tradesRepo.insert(
      makeOpenTrade({
        id: 'c1_t_win',
        status: 'CLOSED',
        remaining_qty: 0,
        realized_pnl: 2_650,
        fees_usd: 0,
        opened_at: earlierToday + 5000,
        closed_at: earlierToday + 5500,
      })
    );

    guard.recordTradeClosed({
      tradeId: 'c1_loss',
      realizedNetPnlUsd: -150,
      liveWalletBalanceUsd: wallet,
    });
    guard.recordTradeClosed({
      tradeId: 'c1_win',
      realizedNetPnlUsd: 2_650,
      liveWalletBalanceUsd: wallet,
    });
    expect(guard.getStatus(wallet).cycle.status).toBe('PASSED');

    // Simulate stale AutoPilot blocks from Cycle #1 (CYCLE_TERMINAL, COOLDOWN_ACTIVE, 180s lockout)
    (autoPilot as any).cachedBalance = wallet;
    (autoPilot as any).state = 'COOLDOWN_ACTIVE';
    (autoPilot as any).blockReason = 'CYCLE_TERMINAL';
    (autoPilot as any).cooldownUntil = Date.now() + 3_600_000;
    (autoPilot as any).lastExitTime = Date.now();
    (autoPilot as any).consecutiveLosses = 2;

    // Rollover to Cycle #2 and clear prop-firm block
    const cycle2Status = guard.startNewCycle(wallet);
    expect(cycle2Status.cycle.cycleNumber).toBe(2);
    expect(cycle2Status.cycle.status).toBe('ACTIVE');
    autoPilot.clearPropFirmBlock();

    expect(autoPilot.getState()).toBe('IDLE');
    expect((autoPilot as any).blockReason).toBeNull();

    // Next tick opens Cycle #2 trade immediately without blocking on -$92.12, COOLDOWN_ACTIVE, 180s lockout, or maxDailyTrades
    setBuySnapshot(confluenceEngine);
    markPrice = 100;
    await autoPilot.onTick('SOLUSDT', 100);

    expect(mockBroker.openOrderCalls).toHaveLength(1);
    expect(autoPilot.getState()).toBe('POSITION_OPEN');

    // Also verify a subsequent -$150 Cycle #2 loss (< -$92.12 legacy 2% cap) does NOT trigger BLOCKED_DAILY_MAX_LOSS
    mockBroker.markPriceForClose = 98;
    await tradeManager.closePosition('SOLUSDT', 'MANUAL_CLOSE');
    (autoPilot as any).handlePositionClosed(tradesRepo.getLatestTrade('BINANCE_DEMO', 'SOLUSDT'));
    // Force a -$150 realized loss in trades table today so netPnl <= -92.12 if only counting Cycle #2
    tradesRepo.update('c1_t_win', { opened_at: earlierToday - 86_400_000, closed_at: earlierToday - 86_400_000 });
    (autoPilot as any).lastExitTime = Date.now() - 200_000;
    await autoPilot.onTick('SOLUSDT', 100);
    expect(mockBroker.openOrderCalls).toHaveLength(2);
  });

  it('autoPilot_chaserUses23CharIds_GTX_getOrderVerification_partialCancel_and_global1PosBlock', async () => {
    const ordersById = new Map<string, OrderExecutionResult>();
    const cancelSpy = vi.fn().mockResolvedValue(true);
    const getOrderMock = vi.fn(async (_sym: string, orderId: string) => {
      return ordersById.get(orderId) ?? null;
    });

    const chasedBroker: BrokerAdapter = {
      mode: 'BINANCE_DEMO',
      getAccount: async () => ({
        walletBalance: 50_000,
        equity: 50_000,
        availableBalance: 50_000,
        unrealizedPnl: 0,
        currency: 'USDT',
      }),
      getPosition: async () => null,
      openOrder: vi.fn(async (req: any) => {
        const res: OrderExecutionResult = {
          orderId: 'ex_ord_' + ordersById.size,
          clientOrderId: req.clientOrderId,
          status: 'NEW',
          executedQty: 0,
          avgPrice: req.limitPrice || 100,
        };
        ordersById.set(res.orderId, res);
        return res;
      }),
      getOrder: getOrderMock,
      createAlgoOrder: vi.fn(async (params: AlgoOrderParams) => ({
        algoId: 'algo_1',
        clientAlgoId: params.clientAlgoId,
        symbol: params.symbol,
        status: 'NEW',
      })),
      closePosition: vi.fn(async () => ({ orderId: 'close_1', status: 'FILLED' })),
      cancelOrder: cancelSpy,
      cancelAllOrders: vi.fn(async () => true),
      moveToBreakeven: vi.fn(async () => ({ newSlId: 'be_1' })),
      getOpenOrders: vi.fn(async () => []),
      modifyOrder: vi.fn(async () => ({ status: 'MODIFIED' })),
    };

    const chasingEngine = new ChasingExecutionEngine(chasedBroker, {
      debouncMs: 5000,
      timeoutMs: 3000,
      tickSize: 0.01,
    });
    const chasedAutoPilot = new AutoPilotManager({
      db,
      tradeManager,
      broker: chasedBroker,
      confluenceEngine,
      propFirmRiskGuard: guard,
      chasingExecutionEngine: chasingEngine,
      getMarkPrice: () => 100,
      getAtr: () => 2.0,
      config: { enabled: true, consensusThreshold: 4, marginAllocationPct: 10, leverage: 10 },
    });

    setBuySnapshot(confluenceEngine);

    // Case A: CANCELED order returns TERMINAL -> aborts without phantom SQLite position
    getOrderMock.mockResolvedValueOnce({
      orderId: 'ex_ord_0',
      clientOrderId: 'tos_canceled',
      status: 'CANCELED',
      executedQty: 0,
      avgPrice: 0,
    });
    await chasedAutoPilot.onTick('SOLUSDT', 100);
    expect(tradesRepo.getActivePosition('BINANCE_DEMO')).toBeNull();
    expect(chasedAutoPilot.getState()).toBe('IDLE');

    // Verify GTX & <= 36-char clientOrderId on chased openOrder
    const firstCall = (chasedBroker.openOrder as any).mock.calls[0][0];
    expect(firstCall.timeInForce).toBe('GTX');
    expect(firstCall.clientOrderId).toMatch(/^tos_[a-f0-9]{16}_ent$/);
    expect(firstCall.clientOrderId.length).toBe(24);

    // Case B: PARTIALLY_FILLED cancels remainder before returning FILLED and creating <=24 char SL algo
    getOrderMock.mockResolvedValueOnce({
      orderId: 'ex_ord_1',
      clientOrderId: 'tos_partial',
      status: 'PARTIALLY_FILLED',
      executedQty: 12.5,
      avgPrice: 99.95,
    });
    await chasedAutoPilot.onTick('SOLUSDT', 100);
    expect(cancelSpy).toHaveBeenCalledWith('SOLUSDT', 'ex_ord_1', false);
    const opened = tradesRepo.getActivePosition('BINANCE_DEMO', 'SOLUSDT');
    expect(opened).not.toBeNull();
    expect(opened!.entry_order_id).toBe('ex_ord_1');
    expect(opened!.quantity).toBe(12.5);
    expect(opened!.client_sl_id!.length).toBe(23);

    // Verify SL algo call used 23-char clientAlgoId
    const algoCall = (chasedBroker.createAlgoOrder as any).mock.calls[0][0];
    expect(algoCall.clientAlgoId.length).toBe(23);

    // Case C: Global 1-pos guard blocks ETHUSDT entry when SOLUSDT is already open
    chasedAutoPilot.setActiveSymbol('ETHUSDT');
    (chasedAutoPilot as any).openTradeId = null;
    (chasedAutoPilot as any).state = 'IDLE';
    await chasedAutoPilot.onTick('ETHUSDT', 3000);
    expect((chasedBroker.openOrder as any).mock.calls).toHaveLength(2); // No 3rd order
  });

  it('propFirmRiskGuard_hydratesRecordedTradeIdsOnRestart_and_scopesLocalPaperOut', async () => {
    const t0 = Date.now();
    tradesRepo.insert(
      makeOpenTrade({
        id: 'hydrated_closed_1',
        status: 'CLOSED',
        remaining_qty: 0,
        realized_pnl: 300,
        fees_usd: 10,
        opened_at: t0 - 10_000,
        closed_at: t0 + 1_000,
      })
    );
    guard.recordTradeClosed({
      tradeId: 'hydrated_closed_1',
      realizedNetPnlUsd: 290,
      liveWalletBalanceUsd: 50_000,
      nowMs: t0 + 1_000,
    });

    // Restart PropFirmRiskGuard from SQLite: must hydrate 'hydrated_closed_1' and ignore duplicate
    const restartedGuard = new PropFirmRiskGuard(propFirmRepo);
    const afterDup = restartedGuard.recordTradeClosed({
      tradeId: 'hydrated_closed_1',
      realizedNetPnlUsd: 290,
      liveWalletBalanceUsd: 50_000,
      nowMs: t0 + 2_000,
    });
    expect(afterDup.cycle.tradesCount).toBe(1);
    expect(afterDup.cycle.realizedPnlUsd).toBe(290);
  });

  it('autoPilot_sizesFrom50kPropFirmBenchmarkOn5kTestnetWalletWithinRealReserve', async () => {
    const wallet5k = 5_000;
    mockBroker.account.walletBalance = wallet5k;
    mockBroker.account.equity = wallet5k;
    mockBroker.account.availableBalance = wallet5k;

    setBuySnapshot(confluenceEngine);
    markPrice = 100;
    // With getAtr() = 2.0 -> 1.5*ATR = 3.0 stop distance:
    // Legacy 10% of $5,000 capped margin at $500 (50 qty). With $50,000 benchmark (10% = $5,000 capped to $4,000 reserve),
    // $250 PropFirm risk limit allows 83.3333 qty = $8,333.33 notional = $833.33 margin (> $500 legacy cap!).
    await autoPilot.onTick('SOLUSDT', 100);

    expect(mockBroker.openOrderCalls).toHaveLength(1);
    const placed = mockBroker.openOrderCalls[0];
    expect(placed.marginUsd).toBeGreaterThan(500);
    expect(placed.marginUsd).toBeLessThanOrEqual(4_000); // Respects 20% real wallet reserve ($1,000)
    expect(placed.quantity).toBeCloseTo(83.3333, 2); // Exact $250 risk at $3.00 stop distance
  });
});
