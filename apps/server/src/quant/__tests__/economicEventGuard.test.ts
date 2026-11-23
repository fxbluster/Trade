import { describe, it, expect, beforeEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { EconomicEventGuard } from '../economicEventGuard.js';
import { initializeDatabase } from '../../db/sqlite.js';
import type { EconomicEvent } from '@tradeos/shared';

describe('EconomicEventGuard — Macro Event Calendar & Blackout Window', () => {
  let db: DatabaseSync;

  beforeEach(() => {
    db = initializeDatabase(':memory:');
  });

  it('triggers blackout when timestamp falls within +/- 15m (900 seconds) of high-impact event', () => {
    const eventTime = 1795132800 * 1000; // e.g. 12:00:00 UTC
    const mockEvent: EconomicEvent = {
      id: 'cpi_usd_release',
      name: 'US CPI m/m',
      timestamp: eventTime,
      impact: 'HIGH',
      currency: 'USD',
    };

    const guard = new EconomicEventGuard(db, [mockEvent]);

    // 16 minutes before: outside window
    const outsideBefore = guard.isBlackoutActive(eventTime - 16 * 60 * 1000);
    expect(outsideBefore.active).toBe(false);

    // 14 minutes before: inside window
    const insideBefore = guard.isBlackoutActive(eventTime - 14 * 60 * 1000);
    expect(insideBefore.active).toBe(true);
    expect(insideBefore.eventName).toBe('US CPI m/m');
    expect(insideBefore.remainingSeconds).toBeGreaterThan(0);

    // Exact event moment: inside window
    const exactMoment = guard.isBlackoutActive(eventTime);
    expect(exactMoment.active).toBe(true);

    // 14 minutes after: inside window
    const insideAfter = guard.isBlackoutActive(eventTime + 14 * 60 * 1000);
    expect(insideAfter.active).toBe(true);

    // 16 minutes after: outside window
    const outsideAfter = guard.isBlackoutActive(eventTime + 16 * 60 * 1000);
    expect(outsideAfter.active).toBe(false);
  });

  it('evaluates pre-event open position geometry at T_event - 15m', () => {
    const guard = new EconomicEventGuard(db);

    // Long position in profit (> entry + 0.15% fee buffer) -> MOVE_TO_BREAKEVEN
    const longInProfit = guard.evaluateOpenPositionAtBlackout({
      entryPrice: 100.0,
      markPrice: 100.5,
      side: 'BUY',
      feeBufferPct: 0.0015,
    });
    expect(longInProfit).toBe('MOVE_TO_BREAKEVEN');

    // Long position underwater (< entry + 0.15%) -> UNWIND
    const longUnderwater = guard.evaluateOpenPositionAtBlackout({
      entryPrice: 100.0,
      markPrice: 99.8,
      side: 'BUY',
      feeBufferPct: 0.0015,
    });
    expect(longUnderwater).toBe('UNWIND');

    // Short position in profit (< entry - 0.15%) -> MOVE_TO_BREAKEVEN
    const shortInProfit = guard.evaluateOpenPositionAtBlackout({
      entryPrice: 100.0,
      markPrice: 99.2,
      side: 'SELL',
      feeBufferPct: 0.0015,
    });
    expect(shortInProfit).toBe('MOVE_TO_BREAKEVEN');

    // Short position underwater (> entry - 0.15%) -> UNWIND
    const shortUnderwater = guard.evaluateOpenPositionAtBlackout({
      entryPrice: 100.0,
      markPrice: 100.3,
      side: 'SELL',
      feeBufferPct: 0.0015,
    });
    expect(shortUnderwater).toBe('UNWIND');
  });

  it('implements fail-open policy and retains existing cache when external fetch fails', async () => {
    const guard = new EconomicEventGuard(db);
    guard.addEvent({
      id: 'cached_fomc',
      name: 'FOMC Rate Decision',
      timestamp: Date.now() + 3600 * 1000,
      impact: 'HIGH',
      currency: 'USD',
    });

    // Attempting fetch against non-existent URL fails open and returns cached events
    const events = await guard.fetchCalendar('http://127.0.0.1:54321/non-existent-calendar.json');
    expect(events.length).toBe(1);
    expect(events[0]!.name).toBe('FOMC Rate Decision');
  });

  it('persists and retrieves events from SQLite economic_events table', () => {
    const guard = new EconomicEventGuard(db);
    const eventTime = Date.now() + 10_000_000;
    guard.addEvent({
      id: 'persisted_nfp',
      name: 'Non-Farm Employment Change',
      timestamp: eventTime,
      impact: 'HIGH',
      currency: 'USD',
    });

    // Instantiate a new guard with the same database
    const freshGuard = new EconomicEventGuard(db);
    const upcoming = freshGuard.getUpcomingEvents(24);
    expect(upcoming.some(e => e.id === 'persisted_nfp')).toBe(true);
  });

  it('starts and stops hourly cron without leaking interval timers', () => {
    const guard = new EconomicEventGuard(db);
    guard.startCron(60_000);
    expect((guard as any).cronTimer).not.toBeNull();
    // calling startCron again does not duplicate timers
    guard.startCron(60_000);
    expect((guard as any).cronTimer).not.toBeNull();

    guard.stopCron();
    expect((guard as any).cronTimer).toBeNull();
  });
});
