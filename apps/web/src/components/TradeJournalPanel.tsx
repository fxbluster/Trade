import React, { useState, useEffect } from 'react';
import { apiClient } from '../lib/apiClient';
import { formatUsd } from '../lib/formatters';
import type { JournalSummary, TradeRecord } from '@tradeos/shared';
import { BookOpen, RefreshCw, TrendingUp, TrendingDown, Award, PieChart, Shield, ChevronDown, ChevronUp, CandlestickChart } from 'lucide-react';
import { TradeReplayModal } from './TradeReplayModal';

interface StrategyMilestone {
  version: string;
  timestampMs: number;
  timeLabel: string;
  summary: string;
}

const STRATEGY_MILESTONES: StrategyMilestone[] = [
  {
    version: 'v2.9',
    timestampMs: Date.parse('2026-11-27T20:12:48Z'),
    timeLabel: '00:13',
    summary: 'DEF-01..06: 2-tick GTX offset + IOC fallback, 1-pozisiya kilidi, komissiya-şüurlu BE + ATR TP1, MGS işarə/IR/XRP scaling, 90s PnL cache',
  },
  {
    version: 'v2.8.1',
    timestampMs: Date.parse('2026-11-27T15:55:00Z'),
    timeLabel: '19:55',
    summary: 'LOCAL_PAPER Mainnet parity (0.02% GTX, -5022, OCO SL/TP) + aggTrade Last Price SL/TP & Watchdog sinxronizasiyası',
  },
  {
    version: 'v2.8',
    timestampMs: Date.parse('2026-11-27T14:40:00Z'),
    timeLabel: '18:40',
    summary: 'ARCH-16..18: 0.45% BE + 50% Partial TP, 5 dəq SL cooldown, dust filtr, pillar sinxronizasiyası',
  },
  {
    version: 'v2.7',
    timestampMs: Date.parse('2026-11-27T13:20:00Z'),
    timeLabel: '17:20',
    summary: 'ARCH-13..15: BTC/SOL tickSize/precision düzəlişi, NoiseBand chop qoruması, OrderFlow clamp, SMC çəki kalibrasiyası',
  },
  {
    version: 'v2.6',
    timestampMs: Date.parse('2026-11-27T11:25:00Z'),
    timeLabel: '15:25',
    summary: 'ARCH-10..12: 30% partial fill, 5 dəq dust kilidi, 30s əks siqnal təsdiqi',
  },
  {
    version: 'v2.5',
    timestampMs: Date.parse('2026-11-27T11:08:37Z'),
    timeLabel: '15:08',
    summary: 'İlk 120s əks çıxış bloku + Manual-only Cooldown',
  },
  {
    version: 'v2.4',
    timestampMs: Date.parse('2026-11-27T10:50:12Z'),
    timeLabel: '14:50',
    summary: 'ARCH-09: 3-Slot paralel mövqe (72%+ / 80%+ + risk kilidi)',
  },
  {
    version: 'v2.3',
    timestampMs: Date.parse('2026-11-27T10:15:00Z'),
    timeLabel: '14:15',
    summary: 'ARCH-05..08: Trailing 0.60% MFE / 35% giveback, post-fill SL/TP, sütun çəkiləri',
  },
  {
    version: 'v2.2',
    timestampMs: Date.parse('2026-11-26T23:12:58Z'),
    timeLabel: '03:13',
    summary: 'ARCH-01..04: 4 onluq SL/TP, min 0.30% SL, simmetrik SHORT, dust qoruması',
  },
  {
    version: 'v2.1',
    timestampMs: Date.parse('2026-11-26T21:28:00Z'),
    timeLabel: '01:28',
    summary: 'Fee-aware Trailing Stop (0.21% MFE) + 10x PropFirm sinxronizasiyası',
  },
];

export const TradeJournalPanel: React.FC = () => {
  const [journal, setJournal] = useState<JournalSummary | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [expandedMilestoneGroups, setExpandedMilestoneGroups] = useState<Record<string, boolean>>({});
  const [replayTrade, setReplayTrade] = useState<TradeRecord | null>(null);

  const fetchJournal = async () => {
    setIsLoading(true);
    setErrorMsg(null);
    try {
      const data = await apiClient.getJournal(50, 0);
      setJournal(data);
    } catch (err: any) {
      setErrorMsg(err.message || 'Failed to load trade journal');
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    fetchJournal();
  }, []);

  const trades = journal?.trades || [];
  const totalFees = trades.reduce((acc, t) => acc + (t.fees_usd || 0), 0);
  const totalNetPnl = trades.reduce((acc, t) => acc + ((t.realized_pnl || 0) - (t.fees_usd || 0)), 0);

  return (
    <div className="flex flex-col h-full bg-[#080c14] border border-[#151d2c] rounded-lg p-3 font-mono text-xs select-none">
      {/* Top Bar with Refresh */}
      <div className="flex items-center justify-between pb-2 mb-3 border-b border-[#151d2c]">
        <div className="flex items-center space-x-2">
          <BookOpen className="w-4 h-4 text-[#2962ff]" />
          <span className="font-bold text-[#e6edf3]">Verified Trade Journal & Quant Analytics</span>
        </div>
        <button
          onClick={fetchJournal}
          disabled={isLoading}
          className="flex items-center space-x-1 px-2.5 py-1 rounded bg-[#151d2c] text-[#7d8590] hover:text-[#e6edf3] transition-colors"
        >
          <RefreshCw className={`w-3 h-3 ${isLoading ? 'animate-spin' : ''}`} />
          <span>Refresh</span>
        </button>
      </div>

      {errorMsg && (
        <div className="mb-2 p-1.5 rounded bg-[#f6465d]/10 border border-[#f6465d]/30 text-[#f6465d] text-[11px]">
          {errorMsg}
        </div>
      )}

      {/* Top 7 Stat Cards (including Total Commissions & Net PnL) */}
      <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-2 mb-3">
        <div className="bg-[#020305] p-2 rounded border border-[#151d2c]">
          <div className="text-[10px] text-[#7d8590] uppercase flex items-center justify-between">
            <span>Win Rate</span>
            <Award className="w-3 h-3 text-[#f0b90b]" />
          </div>
          <div className="text-base font-bold text-[#e6edf3] mt-0.5">
            {journal ? `${journal.winRate.toFixed(1)}%` : '--'}
          </div>
        </div>

        <div className="bg-[#020305] p-2 rounded border border-[#151d2c]">
          <div className="text-[10px] text-[#7d8590] uppercase flex items-center justify-between">
            <span>Profit Factor</span>
            <TrendingUp className="w-3 h-3 text-[#0ecb81]" />
          </div>
          <div className="text-base font-bold text-[#e6edf3] mt-0.5">
            {journal ? journal.profitFactor.toFixed(2) : '--'}
          </div>
        </div>

        <div className="bg-[#020305] p-2 rounded border border-[#151d2c]">
          <div className="text-[10px] text-[#7d8590] uppercase flex items-center justify-between">
            <span>Max Drawdown</span>
            <TrendingDown className="w-3 h-3 text-[#f6465d]" />
          </div>
          <div className="text-base font-bold text-[#f6465d] mt-0.5" data-testid="journal-max-drawdown">
            {journal ? (
              <>
                <span>{`${(journal.maxDrawdown * 100).toFixed(1)}%`}</span>
                <span className="text-xs font-normal text-[#7d8590] ml-1.5">
                  {`(-$${(journal.maxDrawdownUsd ?? 0).toFixed(2)})`}
                </span>
              </>
            ) : (
              '--'
            )}
          </div>
        </div>

        <div className="bg-[#020305] p-2 rounded border border-[#151d2c]">
          <div className="text-[10px] text-[#7d8590] uppercase flex items-center justify-between">
            <span>Kelly Criterion</span>
            <PieChart className="w-3 h-3 text-[#2962ff]" />
          </div>
          <div className="text-base font-bold text-[#e6edf3] mt-0.5">
            {journal ? `${(journal.kellyCriterion * 100).toFixed(1)}%` : '--'}
          </div>
        </div>

        <div className="bg-[#020305] p-2 rounded border border-[#151d2c]">
          <div className="text-[10px] text-[#7d8590] uppercase flex items-center justify-between">
            <span>Total Trades</span>
            <Shield className="w-3 h-3 text-[#7d8590]" />
          </div>
          <div className="text-base font-bold text-[#e6edf3] mt-0.5">
            {journal ? journal.totalTrades : '--'}
          </div>
        </div>

        <div className="bg-[#020305] p-2 rounded border border-[#f0b90b]/30">
          <div className="text-[10px] text-[#7d8590] uppercase flex items-center justify-between">
            <span>Ümumi Komissiya</span>
          </div>
          <div className="text-base font-bold text-[#f0b90b] mt-0.5" data-testid="journal-total-fees">
            {journal ? `-$${totalFees.toFixed(2)}` : '--'}
          </div>
        </div>

        <div className="bg-[#020305] p-2 rounded border border-[#151d2c]">
          <div className="text-[10px] text-[#7d8590] uppercase flex items-center justify-between">
            <span>Xalis PnL (Net)</span>
          </div>
          <div
            className={`text-base font-bold mt-0.5 ${totalNetPnl >= 0 ? 'text-[#0ecb81]' : 'text-[#f6465d]'}`}
            data-testid="journal-net-pnl"
          >
            {journal ? formatUsd(totalNetPnl, true) : '--'}
          </div>
        </div>
      </div>

      <div className="mb-2 text-[11px] text-[#7d8590]">
        Xalis PnL = Brüt PnL − Komissiya (komissiya həm qazancda, həm zərərdə hesabdan çıxılır).
      </div>

      {/* Trades Table */}
      {trades.length === 0 ? (
        <div className="flex flex-col items-center justify-center h-40 text-[#7d8590]">
          <span className="text-xs">No closed trades recorded in SQLite WAL database yet</span>
          <span className="text-[10px] text-[#484f58] mt-1">Completed orders will be logged and audited here</span>
        </div>
      ) : (
        <div className="overflow-x-auto overflow-y-auto max-h-[340px] custom-scrollbar flex-1">
          <table className="w-full text-left">
            <thead>
              <tr className="text-[10px] uppercase text-[#7d8590] border-b border-[#151d2c]/60">
                <th className="py-1.5 px-2">Time</th>
                <th className="py-1.5 px-2">Symbol</th>
                <th className="py-1.5 px-2">Side</th>
                <th className="py-1.5 px-2 text-right tabular-nums font-mono">Entry</th>
                <th className="py-1.5 px-2 text-right tabular-nums font-mono">Exit</th>
                <th className="py-1.5 px-2 text-right tabular-nums font-mono">Qty</th>
                <th className="py-1.5 px-2 text-right tabular-nums font-mono">Brüt PnL</th>
                <th className="py-1.5 px-2 text-right tabular-nums font-mono">Komissiya</th>
                <th className="py-1.5 px-2 text-right tabular-nums font-mono">Xalis (Net)</th>
                <th className="py-1.5 px-2">Reason</th>
                <th className="py-1.5 px-2 text-right">Qrafik</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[#151d2c]/40">
              {(() => {
                let milestoneIdx = 0;
                const rows: React.ReactNode[] = [];
                for (const t of trades) {
                  const tradeTs = t.opened_at || t.closed_at || 0;
                  const group: StrategyMilestone[] = [];
                  while (
                    milestoneIdx < STRATEGY_MILESTONES.length &&
                    STRATEGY_MILESTONES[milestoneIdx].timestampMs >= tradeTs
                  ) {
                    group.push(STRATEGY_MILESTONES[milestoneIdx]);
                    milestoneIdx++;
                  }

                  if (group.length > 0) {
                    const groupKey = group.map((g) => g.version).join('-');
                    const isExpanded = Boolean(expandedMilestoneGroups[groupKey]);
                    const versionLabel =
                      group.length === 1
                        ? group[0].version
                        : `${group[group.length - 1].version}–${group[0].version}`;
                    const summaryLabel =
                      group.length === 1
                        ? `${group[0].timeLabel} · ${group[0].summary}`
                        : `${group.length} sistem dəyişikliyi — ətraflı bax`;

                    rows.push(
                      <tr
                        key={`milestone-${groupKey}`}
                        data-testid="strategy-milestone-row"
                        onClick={() =>
                          setExpandedMilestoneGroups((prev) => ({
                            ...prev,
                            [groupKey]: !prev[groupKey],
                          }))
                        }
                        className="bg-[#2962ff]/10 border-y border-[#2962ff]/30 cursor-pointer hover:bg-[#2962ff]/15 transition-colors"
                      >
                        <td colSpan={11} className="py-1.5 px-2 text-[10px]">
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <div className="flex items-center space-x-2">
                              <span className="px-1.5 py-0.5 rounded bg-[#2962ff]/25 text-[#60a5fa] font-bold border border-[#2962ff]/40">
                                {versionLabel}
                              </span>
                              <span className="text-[#e6edf3] font-semibold">{summaryLabel}</span>
                            </div>
                            <div className="flex items-center space-x-2 text-[#60a5fa] font-semibold">
                              <span>▲ Yuxarıdakılar sonradır</span>
                              {isExpanded ? (
                                <ChevronUp className="w-3.5 h-3.5" />
                              ) : (
                                <ChevronDown className="w-3.5 h-3.5" />
                              )}
                            </div>
                          </div>
                          {isExpanded && (
                            <div className="mt-2 pt-2 border-t border-[#2962ff]/20 space-y-1">
                              {group.map((m) => (
                                <div key={m.version} className="flex items-center space-x-2 text-[10px]">
                                  <span className="px-1.5 py-0.5 rounded bg-[#2962ff]/20 text-[#60a5fa] font-bold">
                                    {m.version}
                                  </span>
                                  <span className="text-[#7d8590]">{m.timeLabel}</span>
                                  <span className="text-[#e6edf3]">{m.summary}</span>
                                </div>
                              ))}
                            </div>
                          )}
                        </td>
                      </tr>
                    );
                  }

                  const isLong = t.side === 'BUY';
                  const isWin = t.realized_pnl >= 0;
                  const fee = t.fees_usd || 0;
                  const netPnl = (t.realized_pnl || 0) - fee;
                  const isNetWin = netPnl >= 0;
                  const priceDecimals = t.entry_price < 10 ? 4 : 2;
                  const dateStr = t.closed_at
                    ? new Date(t.closed_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
                    : '--';

                  rows.push(
                    <tr key={t.id} className="hover:bg-[#151d2c]/30 transition-colors">
                      <td className="py-2 px-2 text-[#7d8590]">{dateStr}</td>
                      <td className="py-2 px-2 font-semibold text-[#e6edf3]">{t.symbol}</td>
                      <td className="py-2 px-2">
                        <span className={`font-bold ${isLong ? 'text-[#0ecb81]' : 'text-[#f6465d]'}`}>
                          {t.side}
                        </span>
                      </td>
                      <td className="py-2 px-2 text-[#e6edf3] text-right tabular-nums font-mono">{t.entry_price.toFixed(priceDecimals)}</td>
                      <td className="py-2 px-2 text-[#e6edf3] text-right tabular-nums font-mono">{t.exit_price ? t.exit_price.toFixed(priceDecimals) : '--'}</td>
                      <td className="py-2 px-2 text-[#7d8590] text-right tabular-nums font-mono">{Number(t.quantity.toFixed(4))}</td>
                      <td className={`py-2 px-2 font-bold text-right tabular-nums font-mono ${isWin ? 'text-[#0ecb81]' : 'text-[#f6465d]'}`}>
                        {formatUsd(t.realized_pnl, true)}
                      </td>
                      <td className="py-2 px-2 text-[#f0b90b] text-right tabular-nums font-mono">{`-$${fee.toFixed(2)}`}</td>
                      <td className={`py-2 px-2 font-bold text-right tabular-nums font-mono ${isNetWin ? 'text-[#0ecb81]' : 'text-[#f6465d]'}`}>
                        {formatUsd(netPnl, true)}
                      </td>
                      <td className="py-2 px-2">
                        <span className="px-1.5 py-0.5 rounded text-[10px] bg-[#151d2c] text-[#7d8590]">
                          {t.exit_reason || 'NORMAL'}
                        </span>
                      </td>
                      <td className="py-2 px-2 text-right">
                        <button
                          type="button"
                          data-testid="trade-replay-btn"
                          onClick={() => setReplayTrade(t)}
                          title="Əməliyyatın tarixi qrafikinə bax"
                          className="inline-flex items-center space-x-1 px-2 py-0.5 rounded bg-[#2962ff]/15 hover:bg-[#2962ff]/30 text-[#60a5fa] border border-[#2962ff]/30 text-[10px] font-semibold transition-colors"
                        >
                          <CandlestickChart className="w-3 h-3" />
                          <span>Bax</span>
                        </button>
                      </td>
                    </tr>
                  );
                }
                return rows;
              })()}
            </tbody>
          </table>
        </div>
      )}

      {replayTrade && (
        <TradeReplayModal trade={replayTrade} onClose={() => setReplayTrade(null)} />
      )}
    </div>
  );
};
