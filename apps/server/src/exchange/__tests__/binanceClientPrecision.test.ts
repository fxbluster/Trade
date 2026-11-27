import { describe, it, expect, vi } from 'vitest';
import {
  BinanceClient,
  getDecimalPrecision,
  snapPriceToTick,
  snapQuantityToStep,
} from '../binanceClient.js';

describe('BinanceClient precision & tickSize snapping [DEF-01 / ARCH-13]', () => {
  describe('getDecimalPrecision', () => {
    it('computes decimal places for standard and scientific notation steps', () => {
      expect(getDecimalPrecision(1)).toBe(0);
      expect(getDecimalPrecision(0.1)).toBe(1);
      expect(getDecimalPrecision(0.01)).toBe(2);
      expect(getDecimalPrecision(0.001)).toBe(3);
      expect(getDecimalPrecision(0.0001)).toBe(4);
      expect(getDecimalPrecision(1e-5)).toBe(5);
    });
  });

  describe('snapPriceToTick', () => {
    it('snaps BTCUSDT prices to 0.1 tickSize without floating-point artifacts', () => {
      expect(snapPriceToTick(61578.86835145, 0.1)).toBe(61578.9);
      expect(snapPriceToTick(61578.8 + 0.1, 0.1)).toBe(61578.9);
      expect(snapPriceToTick(61578.3 + 0.1, 0.1)).toBe(61578.4);
      expect(snapPriceToTick(61578.84, 0.1)).toBe(61578.8);
    });

    it('snaps ETHUSDT/SOLUSDT (0.01) and XRPUSDT (0.0001) prices cleanly', () => {
      expect(snapPriceToTick(142.34567, 0.01)).toBe(142.35);
      expect(snapPriceToTick(2500.1 + 0.01, 0.01)).toBe(2500.11);
      expect(snapPriceToTick(0.512349999, 0.0001)).toBe(0.5123);
    });
  });

  describe('snapQuantityToStep', () => {
    it('floors quantities to stepSize without floating-point under-flooring', () => {
      expect(snapQuantityToStep(0.29, 0.01)).toBe(0.29);
      expect(snapQuantityToStep(1.23456789, 0.01)).toBe(1.23);
      expect(snapQuantityToStep(0.0159, 0.001)).toBe(0.015);
      expect(snapQuantityToStep(12.39, 0.1)).toBe(12.3);
    });
  });

  describe('BinanceClient order methods snap price and quantity', () => {
    it('snaps BTCUSDT createOrder price, stopPrice, and quantity using default rules', async () => {
      const client = new BinanceClient({ apiKey: 'k', apiSecret: 's' });
      const spy = vi.spyOn(client as any, 'request').mockResolvedValue({ orderId: 1 });

      await client.createOrder({
        symbol: 'BTCUSDT',
        side: 'BUY',
        type: 'LIMIT',
        quantity: 0.0159,
        price: 61578.86835145,
        stopPrice: 61000.14,
        timeInForce: 'GTX',
      });

      expect(spy).toHaveBeenCalledWith(
        '/fapi/v1/order',
        expect.objectContaining({
          method: 'POST',
          params: expect.objectContaining({
            symbol: 'BTCUSDT',
            quantity: 0.015,
            price: 61578.9,
            stopPrice: 61000.1,
          }),
        })
      );
    });

    it('snaps SOLUSDT modifyOrder price and quantity', async () => {
      const client = new BinanceClient({ apiKey: 'k', apiSecret: 's' });
      const spy = vi.spyOn(client as any, 'request').mockResolvedValue({ orderId: 2 });

      await client.modifyOrder('SOLUSDT', '999', 145.6789, 1.234567, 'SELL');

      expect(spy).toHaveBeenCalledWith(
        '/fapi/v1/order',
        expect.objectContaining({
          method: 'PUT',
          params: expect.objectContaining({
            symbol: 'SOLUSDT',
            orderId: '999',
            side: 'SELL',
            price: 145.68,
            quantity: 1.23,
          }),
        })
      );
    });

    it('loads PRICE_FILTER.tickSize and LOT_SIZE.stepSize from getExchangeInfo and applies them', async () => {
      const client = new BinanceClient({ apiKey: 'k', apiSecret: 's' });
      const spy = vi.spyOn(client as any, 'request').mockImplementation(async (endpoint: unknown) => {
        if (endpoint === '/fapi/v1/exchangeInfo') {
          return {
            symbols: [
              {
                symbol: 'SOLUSDT',
                filters: [
                  { filterType: 'PRICE_FILTER', tickSize: '0.001' },
                  { filterType: 'LOT_SIZE', stepSize: '1' },
                ],
              },
            ],
          };
        }
        return { orderId: 3 };
      });

      await client.getExchangeInfo('SOLUSDT');
      await client.createOrder({
        symbol: 'SOLUSDT',
        side: 'BUY',
        type: 'LIMIT',
        quantity: 3.9876,
        price: 142.3456,
        timeInForce: 'GTX',
      });

      expect(spy).toHaveBeenLastCalledWith(
        '/fapi/v1/order',
        expect.objectContaining({
          params: expect.objectContaining({
            symbol: 'SOLUSDT',
            quantity: 3,
            price: 142.346,
          }),
        })
      );
    });

    it('snaps createAlgoOrder triggerPrice and quantity', async () => {
      const client = new BinanceClient({ apiKey: 'k', apiSecret: 's' });
      const spy = vi.spyOn(client as any, 'request').mockResolvedValue({ algoId: 'a1' });

      await client.createAlgoOrder({
        symbol: 'XRPUSDT',
        side: 'SELL',
        type: 'STOP_MARKET',
        triggerPrice: 0.512389,
        quantity: 15.98,
      });

      expect(spy).toHaveBeenCalledWith(
        '/fapi/v1/algoOrder',
        expect.objectContaining({
          method: 'POST',
          params: expect.objectContaining({
            symbol: 'XRPUSDT',
            triggerPrice: 0.5124,
            quantity: 15.9,
          }),
        })
      );
    });
  });
});
