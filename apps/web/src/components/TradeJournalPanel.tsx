import React, { useState, useEffect } from 'react';
import { apiClient } from '../lib/apiClient';
import type { JournalSummary, TradeRecord } from '@tradeos/shared';
import { BookOpen, RefreshCw, TrendingUp, TrendingDown, Award, PieChart, Shield } from 'lucide-react';

export const TradeJournalPanel: React.FC = () => {
  const [journal, setJournal] = useState<JournalSummary | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

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

      {/* Top 5 Stat Cards */}
      <div className="grid grid-cols-2 sm:grid-cols-5 gap-2 mb-3">
        <div className="bg-[#020305] p-2 rounded border border-[#151d2c]">
          <div className="text-[10px] text-[#7d8590] uppercase flex items-center justify-between">
            <span>Win Rate</span>
            <Award className="w-3 h-3 text-[#f0b90b]" />
          </div>
          <div className="text-base font-bold text-[#e6edf3] mt-0.5">
            {journal ? `${(journal.winRate * 100).toFixed(1)}%` : '--'}
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
          <div className="text-base font-bold text-[#f6465d] mt-0.5">
            {journal ? `${(journal.maxDrawdown * 100).toFixed(1)}%` : '--'}
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
      </div>

      {/* Trades Table */}
      {trades.length === 0 ? (
        <div className="flex flex-col items-center justify-center h-40 text-[#7d8590]">
          <span className="text-xs">No closed trades recorded in SQLite WAL database yet</span>
          <span className="text-[10px] text-[#484f58] mt-1">Completed orders will be logged and audited here</span>
        </div>
      ) : (
        <div className="overflow-x-auto flex-1 max-h-64">
          <table className="w-full text-left">
            <thead>
              <tr className="text-[10px] uppercase text-[#7d8590] border-b border-[#151d2c]/60">
                <th className="py-1.5 px-2">Time</th>
                <th className="py-1.5 px-2">Symbol</th>
                <th className="py-1.5 px-2">Side</th>
                <th className="py-1.5 px-2">Entry</th>
                <th className="py-1.5 px-2">Exit</th>
                <th className="py-1.5 px-2">Qty</th>
                <th className="py-1.5 px-2">PnL ($)</th>
                <th className="py-1.5 px-2">Fees</th>
                <th className="py-1.5 px-2">Reason</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[#151d2c]/40">
              {trades.map((t) => {
                const isLong = t.side === 'BUY';
                const isWin = t.realized_pnl >= 0;
                const dateStr = t.closed_at
                  ? new Date(t.closed_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
                  : '--';

                return (
                  <tr key={t.id} className="hover:bg-[#151d2c]/30 transition-colors">
                    <td className="py-2 px-2 text-[#7d8590]">{dateStr}</td>
                    <td className="py-2 px-2 font-semibold text-[#e6edf3]">{t.symbol}</td>
                    <td className="py-2 px-2">
                      <span className={`font-bold ${isLong ? 'text-[#0ecb81]' : 'text-[#f6465d]'}`}>
                        {t.side}
                      </span>
                    </td>
                    <td className="py-2 px-2 text-[#e6edf3]">{t.entry_price.toFixed(2)}</td>
                    <td className="py-2 px-2 text-[#e6edf3]">{t.exit_price ? t.exit_price.toFixed(2) : '--'}</td>
                    <td className="py-2 px-2 text-[#7d8590]">{t.quantity}</td>
                    <td className={`py-2 px-2 font-bold ${isWin ? 'text-[#0ecb81]' : 'text-[#f6465d]'}`}>
                      {isWin ? '+' : ''}${t.realized_pnl.toFixed(2)}
                    </td>
                    <td className="py-2 px-2 text-[#7d8590]">${t.fees_usd.toFixed(2)}</td>
                    <td className="py-2 px-2">
                      <span className="px-1.5 py-0.5 rounded text-[10px] bg-[#151d2c] text-[#7d8590]">
                        {t.exit_reason || 'NORMAL'}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
};
