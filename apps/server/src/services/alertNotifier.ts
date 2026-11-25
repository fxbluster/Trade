import type {
  PropFirmCycleStatus,
  PropFirmStatusResponse,
  TradeRecord,
} from '@tradeos/shared';
import { redactSecrets } from '../config.js';

export type CriticalAlertEventKey =
  | 'UPCOMERS_DAILY_HALT'
  | 'UPCOMERS_TRAILING_HALT'
  | 'PROPFIRM_TARGET_REACHED'
  | 'SL_PLACEMENT_FAIL_UNWIND'
  | 'SL_PLACEMENT_FAILED_EMERGENCY_UNWIND'
  | 'BINANCE_IP_BAN_418'
  | (string & {});

export interface AlertNotifierOptions {
  botToken?: string;
  chatId?: string;
  cooldownMs?: number;
  timeoutMs?: number;
  fetchFn?: typeof fetch;
  nowFn?: () => number;
}

/**
 * Scrubs raw inline credentials/tokens from alert strings in addition to object key redaction.
 */
export function sanitizeAlertText(input: string, botToken?: string): string {
  let out = input;
  if (botToken && botToken.length > 0) {
    out = out.split(botToken).join('***REDACTED***');
  }
  out = out.replace(/bot\d+:[A-Za-z0-9_-]{8,}/g, 'bot***REDACTED***');
  out = out.replace(
    /\b(api[_-]?key|api[_-]?secret|secret|token|password|pin|authorization)\b(\s*[:=]\s*)([^\s,;'"`]+)/gi,
    '$1$2***REDACTED***'
  );
  return out;
}

/**
 * Fire-and-forget Telegram HTTP AlertNotifier with 3s AbortSignal timeout,
 * redactSecrets() sanitization, PropFirm transition filtering, and 60s per-key dedup.
 */
export class AlertNotifier {
  private readonly explicitBotToken?: string;
  private readonly explicitChatId?: string;
  private readonly cooldownMs: number;
  private readonly timeoutMs: number;
  private readonly fetchFn: typeof fetch;
  private readonly nowFn: () => number;

  private readonly lastSentAt = new Map<string, number>();
  private readonly lastPropFirmStatusByCycle = new Map<string, PropFirmCycleStatus>();

  constructor(options: AlertNotifierOptions = {}) {
    this.explicitBotToken = options.botToken;
    this.explicitChatId = options.chatId;
    this.cooldownMs = options.cooldownMs ?? 60_000;
    this.timeoutMs = options.timeoutMs ?? 3_000;
    this.fetchFn = options.fetchFn ?? globalThis.fetch;
    this.nowFn = options.nowFn ?? Date.now;
  }

  private getBotToken(): string {
    return (this.explicitBotToken ?? process.env.TELEGRAM_BOT_TOKEN ?? '').trim();
  }

  private getChatId(): string {
    return (this.explicitChatId ?? process.env.TELEGRAM_CHAT_ID ?? '').trim();
  }

  public isConfigured(): boolean {
    return this.getBotToken().length > 0 && this.getChatId().length > 0;
  }

  private shouldAllowKey(dedupKey: string, now: number): boolean {
    const prev = this.lastSentAt.get(dedupKey);
    if (prev !== undefined && now - prev < this.cooldownMs) {
      return false;
    }
    this.lastSentAt.set(dedupKey, now);
    return true;
  }

  private formatDetails(details: unknown): string {
    if (details === undefined || details === null) return '';
    if (typeof details === 'string') return details;
    try {
      return JSON.stringify(redactSecrets(details));
    } catch {
      return String(details);
    }
  }

  private async sendTelegram(dedupKey: string, rawText: string): Promise<boolean> {
    const botToken = this.getBotToken();
    const chatId = this.getChatId();
    if (!botToken || !chatId || typeof this.fetchFn !== 'function') {
      return false;
    }

    const now = this.nowFn();
    if (!this.shouldAllowKey(dedupKey, now)) {
      return false;
    }

    const cleanText = sanitizeAlertText(rawText, botToken).slice(0, 3900);
    const url = `https://api.telegram.org/bot${encodeURIComponent(botToken)}/sendMessage`;

    try {
      const response = await this.fetchFn(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          text: cleanText,
          disable_web_page_preview: true,
        }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  public async notifyTradeOpened(
    trade: TradeRecord,
    extra?: Record<string, unknown>
  ): Promise<boolean> {
    const slText = trade.stop_loss !== null && trade.stop_loss !== undefined ? `$${trade.stop_loss}` : 'N/A';
    const tp1Text = trade.tp1 !== null && trade.tp1 !== undefined ? `$${trade.tp1}` : 'N/A';
    const tp2Text = trade.tp2 !== null && trade.tp2 !== undefined ? `$${trade.tp2}` : 'N/A';
    const extraText = extra ? `\nMeta: ${this.formatDetails(extra)}` : '';

    const message = [
      `[TradeOS OPEN] ${trade.symbol} ${trade.side} (${trade.broker_mode})`,
      `Entry: $${trade.entry_price} | Qty: ${trade.quantity} | Lev: ${trade.leverage}x`,
      `Margin: $${trade.margin_usd.toFixed(2)} | SL: ${slText} | TP1: ${tp1Text} | TP2: ${tp2Text}`,
      `Trade ID: ${trade.id}${extraText}`,
    ].join('\n');

    return this.sendTelegram(`trade_open:${trade.id}`, message);
  }

  public async notifyTradeClosed(
    trade: TradeRecord,
    extra?: Record<string, unknown>
  ): Promise<boolean> {
    const netPnl = (trade.realized_pnl ?? 0) - (trade.fees_usd ?? 0);
    const sign = netPnl >= 0 ? '+' : '-';
    const exitPriceText =
      trade.exit_price !== null && trade.exit_price !== undefined ? `$${trade.exit_price}` : 'N/A';
    const extraText = extra ? `\nMeta: ${this.formatDetails(extra)}` : '';

    const message = [
      `[TradeOS CLOSE] ${trade.symbol} ${trade.side} (${trade.broker_mode})`,
      `Reason: ${trade.exit_reason ?? 'CLOSED'} | Entry: $${trade.entry_price} -> Exit: ${exitPriceText}`,
      `Realized: $${(trade.realized_pnl ?? 0).toFixed(2)} | Fees: $${(trade.fees_usd ?? 0).toFixed(2)} | Net: ${sign}$${Math.abs(netPnl).toFixed(2)}`,
      `Trade ID: ${trade.id}${extraText}`,
    ].join('\n');

    return this.sendTelegram(`trade_close:${trade.id}`, message);
  }

  public async notifyCriticalEvent(
    eventKey: CriticalAlertEventKey,
    summary: string,
    details?: Record<string, unknown> | string
  ): Promise<boolean> {
    const detailText = details !== undefined ? `\nDetails: ${this.formatDetails(details)}` : '';
    const message = `[TradeOS CRITICAL: ${eventKey}]\n${summary}${detailText}`;
    return this.sendTelegram(`critical:${eventKey}`, message);
  }

  /**
   * Emits transition-only PropFirm alerts so 2Hz equity ticks never cause Telegram floods.
   */
  public async notifyPropFirmStatus(status: PropFirmStatusResponse): Promise<boolean> {
    const cycleId = status.cycle.id;
    const prev = this.lastPropFirmStatusByCycle.get(cycleId);
    const next = status.cycle.status;
    this.lastPropFirmStatusByCycle.set(cycleId, next);

    if (prev === undefined && next === 'ACTIVE') {
      return false;
    }
    if (prev === next) {
      return false;
    }

    if (next === 'HALTED_DAILY_BUFFER' || next === 'FAILED_DAILY') {
      return this.notifyCriticalEvent(
        'UPCOMERS_DAILY_HALT',
        `Upcomers Cycle #${status.cycle.cycleNumber} transitioned to ${next}`,
        {
          cycleId,
          dailyPnlUsd: status.dailyPnlUsd,
          currentEquityUsd: status.cycle.currentEquityUsd,
        }
      );
    }

    if (next === 'HALTED_TRAILING_BUFFER' || next === 'FAILED_TRAILING') {
      return this.notifyCriticalEvent(
        'UPCOMERS_TRAILING_HALT',
        `Upcomers Cycle #${status.cycle.cycleNumber} transitioned to ${next}`,
        {
          cycleId,
          currentEquityUsd: status.cycle.currentEquityUsd,
          internalTrailingFloorUsd: status.cycle.internalTrailingFloorUsd,
          contractualTrailingFloorUsd: status.cycle.contractualTrailingFloorUsd,
        }
      );
    }

    if (next === 'PASSED') {
      return this.notifyCriticalEvent(
        'PROPFIRM_TARGET_REACHED',
        `Upcomers Cycle #${status.cycle.cycleNumber} PASSED profit target!`,
        {
          cycleId,
          currentEquityUsd: status.cycle.currentEquityUsd,
          netPnlUsd: status.cycle.netPnlUsd,
        }
      );
    }

    return false;
  }
}
