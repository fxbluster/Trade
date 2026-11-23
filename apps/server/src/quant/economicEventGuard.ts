/**
 * TradeOS v2 — Economic Event Blackout Guard
 *
 * Scrapes high-impact USD economic events (ForexFactory JSON) and enforces
 * a +/- 15-minute order freeze window around volatility catalysts (CPI, FOMC, NFP, etc.).
 * Implements a fail-open policy with graceful fallback to cached events on network errors.
 */

import type { DatabaseSync } from 'node:sqlite';
import type { EconomicEvent } from '@tradeos/shared';
import { EconomicEventsRepo } from '../db/sqlite.js';

export class EconomicEventGuard {
  private eventsRepo: EconomicEventsRepo | null = null;
  private cachedEvents: EconomicEvent[] = [];
  private cronTimer: NodeJS.Timeout | null = null;
  private blackoutWindowMs = 15 * 60 * 1000; // +/- 15 minutes = 900,000 ms

  constructor(db?: DatabaseSync, initialEvents?: EconomicEvent[]) {
    if (db) {
      this.eventsRepo = new EconomicEventsRepo(db);
      try {
        this.cachedEvents = this.eventsRepo.getAll();
      } catch (err) {
        console.warn('EconomicEventGuard: Failed to load cached events from DB:', err);
      }
    }
    if (initialEvents && initialEvents.length > 0) {
      for (const ev of initialEvents) {
        this.addEvent(ev);
      }
    }
  }

  /**
   * Fetches ForexFactory weekly economic calendar.
   * Filters for high-impact USD events (CPI, PCE, FOMC, Non-Farm Payrolls, PPI, Powell speeches).
   * Fail-Open Policy: Returns cached events on network or parse failure.
   */
  public async fetchCalendar(
    url = 'https://nfs.faireconomy.media/ff_calendar_thisweek.json'
  ): Promise<EconomicEvent[]> {
    try {
      const response = await fetch(url, {
        signal: AbortSignal.timeout(8000),
        headers: {
          'User-Agent': 'TradeOS/2.0 EconomicGuard',
          Accept: 'application/json',
        },
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status} ${response.statusText}`);
      }

      const rawItems = (await response.json()) as Array<{
        title?: string;
        country?: string;
        date?: string;
        impact?: string;
      }>;

      if (!Array.isArray(rawItems)) {
        throw new Error('ForexFactory feed returned non-array payload');
      }

      const highImpactKeywords = ['CPI', 'PCE', 'FOMC', 'PAYROLL', 'PPI', 'POWELL', 'RATE DECISION', 'FED'];

      const events: EconomicEvent[] = [];
      for (const item of rawItems) {
        const country = (item.country || '').toUpperCase();
        const impact = (item.impact || '').toUpperCase();
        const title = (item.title || '').trim();

        if (country !== 'USD') continue;

        const isHigh = impact === 'HIGH' || impact === 'CRITICAL';
        const hasKeyword = highImpactKeywords.some(kw => title.toUpperCase().includes(kw));

        if (isHigh || hasKeyword) {
          const timestamp = item.date ? new Date(item.date).getTime() : NaN;
          if (isNaN(timestamp)) continue;

          const id = `ff_${title.toLowerCase().replace(/[^a-z0-9]/g, '_')}_${timestamp}`;
          const event: EconomicEvent = {
            id,
            name: title,
            timestamp,
            impact: 'HIGH',
            currency: 'USD',
          };
          events.push(event);
          this.addEvent(event);
        }
      }

      return this.cachedEvents;
    } catch (error) {
      console.warn('Failed to update economic calendar, falling back to cached events:', error);
      return this.cachedEvents;
    }
  }

  /**
   * Adds or updates an economic event in memory and persistent storage.
   */
  public addEvent(event: EconomicEvent): void {
    const existingIdx = this.cachedEvents.findIndex(e => e.id === event.id);
    if (existingIdx >= 0) {
      this.cachedEvents[existingIdx] = event;
    } else {
      this.cachedEvents.push(event);
    }

    if (this.eventsRepo) {
      try {
        this.eventsRepo.upsert(event);
      } catch (err) {
        console.warn('EconomicEventGuard: Failed to persist event to DB:', err);
      }
    }
  }

  /**
   * Checks whether the given timestamp falls within any high-impact event's +/- 15m blackout window.
   */
  public isBlackoutActive(timestamp?: number): {
    active: boolean;
    eventName?: string;
    remainingSeconds?: number;
  } {
    const now = timestamp ?? Date.now();

    for (const event of this.cachedEvents) {
      const windowStart = event.timestamp - this.blackoutWindowMs;
      const windowEnd = event.timestamp + this.blackoutWindowMs;

      if (now >= windowStart && now <= windowEnd) {
        const remainingSeconds = Math.max(0, Math.ceil((windowEnd - now) / 1000));
        return {
          active: true,
          eventName: event.name,
          remainingSeconds,
        };
      }
    }

    return { active: false };
  }

  /**
   * Pre-event position handling at T_event - 15m:
   * - Positive unrealized PnL: Move SL to Breakeven
   * - Unrealized loss: Immediate market unwind (EVENT_BLACKOUT_UNWIND)
   */
  public evaluateOpenPositionAtBlackout(position: {
    entryPrice: number;
    markPrice: number;
    side: 'BUY' | 'SELL';
    feeBufferPct?: number;
  }): 'MOVE_TO_BREAKEVEN' | 'UNWIND' {
    const feeBufferPct = position.feeBufferPct ?? 0.0015;
    const feeBuffer = position.entryPrice * feeBufferPct;

    if (position.side === 'BUY') {
      return position.markPrice >= position.entryPrice + feeBuffer
        ? 'MOVE_TO_BREAKEVEN'
        : 'UNWIND';
    } else {
      return position.markPrice <= position.entryPrice - feeBuffer
        ? 'MOVE_TO_BREAKEVEN'
        : 'UNWIND';
    }
  }

  /**
   * Returns upcoming economic events within the specified time window (hours).
   */
  public getUpcomingEvents(withinHours = 24, fromTimestamp = Date.now()): EconomicEvent[] {
    const horizonMs = fromTimestamp + withinHours * 3600 * 1000;
    return this.cachedEvents.filter(
      e => e.timestamp >= fromTimestamp && e.timestamp <= horizonMs
    );
  }

  /**
   * Starts periodic hourly ingestion cron.
   */
  public startCron(intervalMs = 3600000): void {
    if (this.cronTimer) return;
    this.cronTimer = setInterval(() => {
      this.fetchCalendar().catch(err => {
        console.warn('EconomicEventGuard cron fetch error:', err);
      });
    }, intervalMs);
    this.cronTimer.unref();
  }

  /**
   * Stops periodic cron.
   */
  public stopCron(): void {
    if (this.cronTimer) {
      clearInterval(this.cronTimer);
      this.cronTimer = null;
    }
  }
}

export const economicEventGuard = new EconomicEventGuard();
