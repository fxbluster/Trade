import { describe, it, expect, vi } from 'vitest';
import { AutoPilotManager } from '../autoPilotManager.js';
import { initializeDatabase } from '../../db/sqlite.js';

describe('AutoPilotManager onOrderDispatched hook', () => {
  it('calls onOrderDispatched with EXECUTED event when order executes successfully', async () => {
    const db = initializeDatabase(':memory:');
    const onOrderDispatched = vi.fn();
    const manager = new AutoPilotManager({
      db,
      tradeManager: {
        openPosition: vi.fn().mockResolvedValue({ id: 't_123', entry_price: 100 }),
      } as any,
      broker: {
        mode: 'BINANCE_DEMO',
        getAccount: vi.fn().mockResolvedValue({ walletBalance: 1000, availableBalance: 1000 }),
      } as any,
      confluenceEngine: {
        getSnapshot: vi.fn().mockReturnValue(null),
        liquidationEngine: { projectClusters: vi.fn().mockReturnValue([]) },
      } as any,
      getMarkPrice: () => 100,
      getAtr: () => 1.5,
      onOrderDispatched,
    });

    await (manager as any).executeAutoEntry('SOLUSDT', 'BUY', 100);

    expect(onOrderDispatched).toHaveBeenCalledTimes(1);
    expect(onOrderDispatched).toHaveBeenCalledWith(
      expect.objectContaining({
        symbol: 'SOLUSDT',
        side: 'BUY',
        action: 'EXECUTED',
        tradeId: 't_123',
        price: 100,
        marginUsd: 100, // min(1000 * 10%, 1000)
        leverage: 10,
        atr: 1.5,
      })
    );
  });

  it('calls onOrderDispatched with FAILED when wallet balance <= 0', async () => {
    const db = initializeDatabase(':memory:');
    const onOrderDispatched = vi.fn();
    const manager = new AutoPilotManager({
      db,
      tradeManager: {
        openPosition: vi.fn(),
      } as any,
      broker: {
        mode: 'BINANCE_DEMO',
        getAccount: vi.fn().mockResolvedValue({ walletBalance: 0, availableBalance: 0 }),
      } as any,
      confluenceEngine: {
        getSnapshot: vi.fn().mockReturnValue(null),
        liquidationEngine: { projectClusters: vi.fn().mockReturnValue([]) },
      } as any,
      getMarkPrice: () => 100,
      onOrderDispatched,
    });

    await (manager as any).executeAutoEntry('SOLUSDT', 'BUY', 100);

    expect(onOrderDispatched).toHaveBeenCalledTimes(1);
    expect(onOrderDispatched).toHaveBeenCalledWith(
      expect.objectContaining({
        symbol: 'SOLUSDT',
        side: 'BUY',
        action: 'FAILED',
        price: 100.1,
        marginUsd: 0,
        leverage: 10,
        errorMessage: expect.stringContaining('balance'),
      })
    );
  });

  it('does not emit FAILED spam when marginUsd < 5.0', async () => {
    const db = initializeDatabase(':memory:');
    const onOrderDispatched = vi.fn();
    const manager = new AutoPilotManager({
      db,
      tradeManager: {
        openPosition: vi.fn(),
      } as any,
      broker: {
        mode: 'BINANCE_DEMO',
        getAccount: vi.fn().mockResolvedValue({ walletBalance: 30, availableBalance: 30 }),
      } as any,
      confluenceEngine: {
        getSnapshot: vi.fn().mockReturnValue(null),
        liquidationEngine: { projectClusters: vi.fn().mockReturnValue([]) },
      } as any,
      getMarkPrice: () => 100,
      config: {
        marginAllocationPct: 10, // 10% of 30 = 3.0 USD < 5.0 USD threshold
      },
      onOrderDispatched,
    });

    await (manager as any).executeAutoEntry('SOLUSDT', 'SELL', 100);

    expect(onOrderDispatched).not.toHaveBeenCalled();
    expect(manager.getState()).toBe('IDLE');
  });

  it('calls onOrderDispatched with FAILED and resets state when openPosition throws', async () => {
    const db = initializeDatabase(':memory:');
    const onOrderDispatched = vi.fn();
    const manager = new AutoPilotManager({
      db,
      tradeManager: {
        openPosition: vi.fn().mockRejectedValue(new Error('Broker order rejected: Insufficient margin')),
      } as any,
      broker: {
        mode: 'BINANCE_DEMO',
        getAccount: vi.fn().mockResolvedValue({ walletBalance: 1000, availableBalance: 1000 }),
      } as any,
      confluenceEngine: {
        getSnapshot: vi.fn().mockReturnValue(null),
        liquidationEngine: { projectClusters: vi.fn().mockReturnValue([]) },
      } as any,
      getMarkPrice: () => 100,
      onOrderDispatched,
    });

    await (manager as any).executeAutoEntry('SOLUSDT', 'BUY', 100);

    expect(onOrderDispatched).toHaveBeenCalledTimes(1);
    expect(onOrderDispatched).toHaveBeenCalledWith(
      expect.objectContaining({
        symbol: 'SOLUSDT',
        side: 'BUY',
        action: 'FAILED',
        errorMessage: 'Broker order rejected: Insufficient margin',
      })
    );
    expect(manager.getState()).toBe('IDLE');
  });

  it('handles execution gracefully when onOrderDispatched callback is omitted', async () => {
    const db = initializeDatabase(':memory:');
    const manager = new AutoPilotManager({
      db,
      tradeManager: {
        openPosition: vi.fn().mockResolvedValue({ id: 't_456', entry_price: 100 }),
      } as any,
      broker: {
        mode: 'BINANCE_DEMO',
        getAccount: vi.fn().mockResolvedValue({ walletBalance: 1000, availableBalance: 1000 }),
      } as any,
      confluenceEngine: {
        getSnapshot: vi.fn().mockReturnValue(null),
        liquidationEngine: { projectClusters: vi.fn().mockReturnValue([]) },
      } as any,
      getMarkPrice: () => 100,
    });

    await expect((manager as any).executeAutoEntry('SOLUSDT', 'BUY', 100)).resolves.not.toThrow();
    expect(manager.getOpenTradeId()).toBe('t_456');
    expect(manager.getState()).toBe('POSITION_OPEN');
  });
});
