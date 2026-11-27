import { describe, it, expect, beforeEach, vi } from 'vitest';
import { initializeDatabase } from '../db/sqlite.js';
import { LocalPaperAdapter } from './localPaperAdapter.js';
import { BinanceApiError } from './binanceClient.js';

describe('LocalPaperAdapter', () => {
  let db: ReturnType<typeof initializeDatabase>;
  let adapter: LocalPaperAdapter;

  beforeEach(() => {
    db = initializeDatabase(':memory:');
    adapter = new LocalPaperAdapter({ db });
  });

  it('initializes with default balance of 5000.0 USDT (10x $50K PropFirm scale)', async () => {
    const account = await adapter.getAccount();
    expect(account.walletBalance).toBe(5000);
    expect(account.availableBalance).toBe(5000);
    expect(account.currency).toBe('USDT');
  });

  it('rejects crossing GTX (Post Only) limit orders with BinanceApiError -5022', async () => {
    adapter.onMarkPriceTick('SOLUSDT', 150);

    let buyErr: unknown;
    try {
      await adapter.openOrder({
        symbol: 'SOLUSDT',
        side: 'BUY',
        orderType: 'LIMIT',
        timeInForce: 'GTX',
        limitPrice: 150,
        marginUsd: 100,
        leverage: 10,
        quantity: 5,
      });
    } catch (err) {
      buyErr = err;
    }
    expect(buyErr).toBeInstanceOf(BinanceApiError);
    expect((buyErr as BinanceApiError).code).toBe(-5022);
    expect((buyErr as BinanceApiError).statusCode).toBe(400);

    let sellErr: unknown;
    try {
      await adapter.openOrder({
        symbol: 'SOLUSDT',
        side: 'SELL',
        orderType: 'LIMIT',
        timeInForce: 'GTX',
        limitPrice: 149.5,
        marginUsd: 100,
        leverage: 10,
        quantity: 5,
      });
    } catch (err) {
      sellErr = err;
    }
    expect(sellErr).toBeInstanceOf(BinanceApiError);
    expect((sellErr as BinanceApiError).code).toBe(-5022);
    expect((sellErr as BinanceApiError).statusCode).toBe(400);
  });

  it('rests non-crossing GTX order and fills with 0.02% MAKER_FEE_RATE on mark price cross', async () => {
    expect(adapter.MAKER_FEE_RATE).toBe(0.0002);
    expect(adapter.FEE_RATE).toBe(0.0005);

    adapter.onMarkPriceTick('SOLUSDT', 150);

    const res = await adapter.openOrder({
      symbol: 'SOLUSDT',
      side: 'BUY',
      orderType: 'LIMIT',
      timeInForce: 'GTX',
      limitPrice: 148,
      marginUsd: 100,
      leverage: 10,
      quantity: 10,
    });
    expect(res.status).toBe('NEW');
    expect(res.executedQty).toBe(0);

    // Tick crosses limit price -> fills at 148 with 0.02% maker fee = 148 * 10 * 0.0002 = 0.296
    adapter.onMarkPriceTick('SOLUSDT', 147.9);

    const filledOrder = await adapter.getOrder('SOLUSDT', res.orderId);
    expect(filledOrder?.status).toBe('FILLED');
    expect(filledOrder?.avgPrice).toBe(148);
    expect(filledOrder?.executedQty).toBe(10);

    const account = await adapter.getAccount();
    expect(account.walletBalance).toBeCloseTo(5000 - 0.296, 4);

    const pos = await adapter.getPosition('SOLUSDT');
    expect(pos).not.toBeNull();
    expect(pos?.entryPrice).toBe(148);
    expect(pos?.positionAmt).toBe(10);
  });

  it('closePosition() returns { orderId, status: FILLED, executedQty, avgPrice }', async () => {
    adapter.onMarkPriceTick('BTCUSDT', 50000);
    await adapter.openOrder({
      symbol: 'BTCUSDT',
      side: 'BUY',
      orderType: 'MARKET',
      marginUsd: 1000,
      leverage: 10,
      quantity: 0.1,
    });

    adapter.onMarkPriceTick('BTCUSDT', 51000);
    const closeRes = await adapter.closePosition('BTCUSDT', 0.1);

    expect(closeRes.status).toBe('FILLED');
    expect(closeRes.orderId).toMatch(/^paper_close_/);
    expect(closeRes.executedQty).toBe(0.1);
    expect(closeRes.avgPrice).toBeCloseTo(51000 * (1 - adapter.SLIPPAGE_BPS), 2);
  });

  it('invokes setOnAlgoTrigger callback when STOP_MARKET or TAKE_PROFIT_MARKET triggers in onMarkPriceTick', async () => {
    const onAlgoTrigger = vi.fn();
    adapter.setOnAlgoTrigger(onAlgoTrigger);

    adapter.onMarkPriceTick('ETHUSDT', 3000);
    await adapter.openOrder({
      symbol: 'ETHUSDT',
      side: 'BUY',
      orderType: 'MARKET',
      marginUsd: 500,
      leverage: 10,
      quantity: 1,
    });

    const slAlgo = await adapter.createAlgoOrder({
      symbol: 'ETHUSDT',
      side: 'SELL',
      type: 'STOP_MARKET',
      triggerPrice: 2900,
      quantity: 1,
      clientAlgoId: 'tos_test123_sl',
      reduceOnly: true,
    });

    // Trigger SL
    adapter.onMarkPriceTick('ETHUSDT', 2895);

    await vi.waitFor(() => {
      expect(onAlgoTrigger).toHaveBeenCalledTimes(1);
    });

    const event = onAlgoTrigger.mock.calls[0]![0];
    expect(event).toMatchObject({
      symbol: 'ETHUSDT',
      algoId: slAlgo.algoId,
      clientAlgoId: 'tos_test123_sl',
      side: 'SELL',
      orderType: 'STOP_MARKET',
      triggerPrice: 2900,
      executedQty: 1,
    });
    expect(event.fillPrice).toBeCloseTo(2895 * (1 - adapter.SLIPPAGE_BPS), 2);

    const posAfter = await adapter.getPosition('ETHUSDT');
    expect(posAfter).toBeNull();
  });
});
