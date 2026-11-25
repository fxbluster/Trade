import { describe, it, expect, vi } from 'vitest';
import type { PropFirmStatusResponse, TradeRecord } from '@tradeos/shared';
import { AlertNotifier, sanitizeAlertText } from '../alertNotifier.js';

function makeTrade(overrides: Partial<TradeRecord> = {}): TradeRecord {
  return {
    id: 'trade_alert_1',
    symbol: 'SOLUSDT',
    broker_mode: 'BINANCE_DEMO',
    side: 'BUY',
    status: 'OPEN',
    entry_price: 150,
    exit_price: null,
    quantity: 10,
    remaining_qty: 10,
    leverage: 10,
    margin_usd: 150,
    stop_loss: 145,
    tp1: 160,
    tp2: 170,
    be_price: 150.225,
    is_breakeven: 0,
    client_order_id: 'tos_trade_alert_1_ent',
    client_sl_id: 'tos_trade_alert_1_sl',
    client_tp1_id: null,
    client_tp2_id: null,
    entry_order_id: 'ord_1',
    sl_algo_id: 'sl_1',
    tp1_algo_id: null,
    tp2_algo_id: null,
    realized_pnl: 0,
    fees_usd: 0.5,
    exit_reason: null,
    opened_at: 1_700_000_000_000,
    closed_at: null,
    ...overrides,
  };
}

function makePropFirmStatus(
  cycleStatus: PropFirmStatusResponse['cycle']['status'],
  cycleId: string = 'cycle_1'
): PropFirmStatusResponse {
  return {
    cycle: {
      id: cycleId,
      cycleNumber: 1,
      status: cycleStatus,
      startingBalanceUsd: 50_000,
      currentEquityUsd: 48_750,
      highWaterMarkUsd: 50_000,
      contractualTrailingFloorUsd: 47_000,
      internalTrailingFloorUsd: 47_500,
      isFloorLocked: false,
      profitTargetUsd: 2_500,
      netPnlUsd: -1_250,
      realizedPnlUsd: -1_250,
      netPnlPct: -2.5,
      maxDrawdownUsd: 1_250,
      tradesCount: 2,
      winCount: 0,
      lossCount: 2,
      startedAt: 1_700_000_000_000,
      closedAt: null,
    },
    verdict: 'NO_LOSS',
    dailyBaselineEquityUsd: 50_000,
    dailyPnlUsd: -1_250,
    dailyLossUsedUsd: 1_250,
    dailyBufferRemainingUsd: 0,
    dailyBufferRemainingPct: 0,
    trailingLossUsedUsd: 1_250,
    trailingBufferRemainingUsd: 1_250,
    trailingBufferRemainingPct: 50,
    targetProgressPct: 0,
    targetRemainingUsd: 2_500,
    liveWalletBalanceUsd: 50_000,
    needsTopUp: false,
    topUpMessage: null,
    consecutivePassedCycles: 0,
    requiredPassedCycles: 5,
    canTrade: cycleStatus === 'ACTIVE',
    haltReason: cycleStatus === 'HALTED_DAILY_BUFFER' ? 'UPCOMERS_DAILY_HALT' : null,
    cycles: [],
    updatedAt: 1_700_000_000_000,
  };
}

describe('AlertNotifier — Telegram Formatting, Redaction & 60s Dedup', () => {
  it('formats trade open/close & critical unwind/418 alerts and redacts secrets', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true } as Response);
    const notifier = new AlertNotifier({
      botToken: '123456:SECRET_BOT_TOKEN_XYZ',
      chatId: '-100999888',
      fetchFn: fetchMock,
      nowFn: () => 1_700_000_000_000,
    });

    expect(notifier.isConfigured()).toBe(true);

    const openOk = await notifier.notifyTradeOpened(makeTrade());
    expect(openOk).toBe(true);

    const closeOk = await notifier.notifyTradeClosed(
      makeTrade({
        status: 'CLOSED',
        exit_price: 162,
        realized_pnl: 120,
        fees_usd: 1.5,
        exit_reason: 'TAKE_PROFIT_1',
        closed_at: 1_700_000_060_000,
      })
    );
    expect(closeOk).toBe(true);

    await notifier.notifyCriticalEvent(
      'SL_PLACEMENT_FAIL_UNWIND',
      'SL placement failed with apiKey=my_secret_key and token=tok123 and bot12345:SECRET_BOT_TOKEN_XYZ',
      {
        secret: 'top-secret-value',
        operatorPin: 'super-secret-pin-1234',
        symbol: 'SOLUSDT',
      }
    );

    await notifier.notifyCriticalEvent('BINANCE_IP_BAN_418', 'HTTP 418 IP ban', {
      retryAfterSec: 120,
    });

    expect(fetchMock).toHaveBeenCalledTimes(4);

    const [url, init] = fetchMock.mock.calls[2];
    expect(String(url)).toContain('/sendMessage');
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    const payload = JSON.parse(String(init?.body));
    expect(payload.chat_id).toBe('-100999888');
    expect(payload.text).not.toContain('SECRET_BOT_TOKEN_XYZ');
    expect(payload.text).not.toContain('my_secret_key');
    expect(payload.text).not.toContain('tok123');
    expect(payload.text).not.toContain('top-secret-value');
    expect(payload.text).toContain('***REDACTED***');

    expect(
      sanitizeAlertText('pin=1234567890123456 token=abc', 'bot_secret')
    ).toBe('pin=***REDACTED*** token=***REDACTED***');
  });

  it('deduplicates repeated critical keys within 60s and fires PropFirm transitions only on change', async () => {
    let now = 1_700_000_000_000;
    const fetchMock = vi.fn().mockResolvedValue({ ok: true } as Response);
    const notifier = new AlertNotifier({
      botToken: 'bot_tok',
      chatId: 'chat_1',
      cooldownMs: 60_000,
      fetchFn: fetchMock,
      nowFn: () => now,
    });

    // Repeated 418 within 60s is dropped
    expect(await notifier.notifyCriticalEvent('BINANCE_IP_BAN_418', 'Ban 1')).toBe(true);
    now += 15_000;
    expect(await notifier.notifyCriticalEvent('BINANCE_IP_BAN_418', 'Ban 2')).toBe(false);
    now += 50_000; // 65s total -> cooldown expired
    expect(await notifier.notifyCriticalEvent('BINANCE_IP_BAN_418', 'Ban 3')).toBe(true);

    // PropFirm status: ACTIVE -> ACTIVE (silent), ACTIVE -> HALTED_DAILY_BUFFER (1 alert), repeated HALTED_DAILY_BUFFER (silent)
    await notifier.notifyPropFirmStatus(makePropFirmStatus('ACTIVE'));
    await notifier.notifyPropFirmStatus(makePropFirmStatus('ACTIVE'));
    expect(fetchMock).toHaveBeenCalledTimes(2);

    await notifier.notifyPropFirmStatus(makePropFirmStatus('HALTED_DAILY_BUFFER'));
    await notifier.notifyPropFirmStatus(makePropFirmStatus('HALTED_DAILY_BUFFER'));
    await notifier.notifyPropFirmStatus(makePropFirmStatus('HALTED_DAILY_BUFFER'));
    expect(fetchMock).toHaveBeenCalledTimes(3);

    // Transition to PASSED emits once
    await notifier.notifyPropFirmStatus(makePropFirmStatus('PASSED', 'cycle_2'));
    await notifier.notifyPropFirmStatus(makePropFirmStatus('PASSED', 'cycle_2'));
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('no-ops cleanly when unconfigured and never throws on network timeout', async () => {
    const unconfigured = new AlertNotifier({ botToken: '', chatId: '' });
    expect(unconfigured.isConfigured()).toBe(false);
    await expect(unconfigured.notifyTradeOpened(makeTrade())).resolves.toBe(false);

    const failingFetch = vi.fn().mockRejectedValue(new DOMException('Timeout', 'TimeoutError'));
    const resilient = new AlertNotifier({
      botToken: 'tok',
      chatId: 'chat',
      fetchFn: failingFetch,
    });
    await expect(
      resilient.notifyCriticalEvent('SL_PLACEMENT_FAILED_EMERGENCY_UNWIND', 'Timed out')
    ).resolves.toBe(false);
  });
});
