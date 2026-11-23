import React, { useEffect, useState } from 'react';
import { useUiStore } from '../store/useUiStore';
import { useMarketStore } from '../store/useMarketStore';
import { apiClient } from '../lib/apiClient';
import { formatUsd } from '../lib/formatters';
import type { PnlSummaryResponse } from '@tradeos/shared';
import {
  X,
  TrendingUp,
  TrendingDown,
  ShieldCheck,
  Calendar,
  Clock,
  RefreshCw,
  Wallet,
  DollarSign,
  Award,
  AlertCircle,
  HelpCircle,
} from 'lucide-react';

export const PnLSummaryModal: React.FC = () => {
  const isPnlModalOpen = useUiStore((s) => s.isPnlModalOpen);
  const setIsPnlModalOpen = useUiStore((s) => s.setIsPnlModalOpen);
  const symbol = useMarketStore((s) => s.symbol);

  const [data, setData] = useState<PnlSummaryResponse | null>(null);
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  const fetchSummary = async () => {
    setIsLoading(true);
    setError(null);
    try {
      const res = await apiClient.getPnlSummary(symbol);
      setData(res);
    } catch (err: any) {
      setError(err.message || 'Qazanc məlumatları alına bilmədi');
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    if (isPnlModalOpen) {
      fetchSummary();
      const interval = setInterval(fetchSummary, 5000);
      return () => clearInterval(interval);
    }
  }, [isPnlModalOpen, symbol]);

  if (!isPnlModalOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-4 animate-in fade-in duration-150 font-mono select-none">
      <div className="relative w-full max-w-4xl bg-[#080c14] border border-[#151d2c] rounded-xl shadow-2xl overflow-hidden flex flex-col max-h-[90vh]">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-[#151d2c] bg-[#020305]/80">
          <div className="flex items-center space-x-3">
            <div className="w-8 h-8 rounded-lg bg-[#0ecb81]/15 border border-[#0ecb81]/30 flex items-center justify-center text-[#0ecb81]">
              <DollarSign className="w-5 h-5" />
            </div>
            <div>
              <h2 className="text-base font-bold text-[#e6edf3] flex items-center space-x-2">
                <span>Qazanc & Ziyan İcmalı</span>
                <span className="text-xs px-2 py-0.5 rounded bg-[#151d2c] text-[#7d8590] font-normal">
                  Sadə Dildə
                </span>
              </h2>
              <p className="text-xs text-[#7d8590]">
                Hazırkı, gün içi, 3 günlük və həftəlik xalis performans balansı
              </p>
            </div>
          </div>

          <div className="flex items-center space-x-2">
            <button
              onClick={fetchSummary}
              disabled={isLoading}
              className="p-1.5 rounded hover:bg-[#151d2c] text-[#7d8590] hover:text-[#0ecb81] transition-colors disabled:opacity-50"
              title="Yenilə"
            >
              <RefreshCw className={`w-4 h-4 ${isLoading ? 'animate-spin text-[#0ecb81]' : ''}`} />
            </button>
            <button
              onClick={() => setIsPnlModalOpen(false)}
              className="p-1.5 rounded hover:bg-[#151d2c] text-[#7d8590] hover:text-[#e6edf3] transition-colors"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* Content Body */}
        <div className="flex-1 overflow-y-auto p-5 space-y-5">
          {error && (
            <div className="p-3 bg-red-500/10 border border-red-500/30 rounded-lg text-xs text-red-400 flex items-center space-x-2">
              <AlertCircle className="w-4 h-4 shrink-0" />
              <span>{error}</span>
            </div>
          )}

          {data && (
            <>
              {/* Account Quick Metrics Banner */}
              <div className="grid grid-cols-3 gap-3 p-3 bg-[#020305] border border-[#151d2c] rounded-lg text-xs">
                <div>
                  <span className="text-[#7d8590] text-[11px] block">Ümumi Kapital (Equity)</span>
                  <span className="text-sm font-bold text-[#e6edf3]">
                    ${data.account.equity.toLocaleString('en-US', { minimumFractionDigits: 2 })}
                  </span>
                </div>
                <div>
                  <span className="text-[#7d8590] text-[11px] block">Nağd Cüzdan (Wallet)</span>
                  <span className="text-sm font-bold text-[#7d8590]">
                    ${data.account.walletBalance.toLocaleString('en-US', { minimumFractionDigits: 2 })}
                  </span>
                </div>
                <div>
                  <span className="text-[#7d8590] text-[11px] block">İstifadəyə Açıq (Available)</span>
                  <span className="text-sm font-bold text-[#0ecb81]">
                    ${data.account.availableBalance.toLocaleString('en-US', { minimumFractionDigits: 2 })}
                  </span>
                </div>
              </div>

              {/* 4 Cards: Live, Today, 3 Days, Weekly */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {/* 1. HAZIRDA (Canlı Mövqe) */}
                <div
                  className={`p-4 rounded-xl border flex flex-col justify-between transition-all ${
                    data.live.hasPosition
                      ? (data.live.unrealizedPnl || 0) >= 0
                        ? 'bg-gradient-to-br from-[#080c14] to-[#0ecb81]/10 border-[#0ecb81]/40'
                        : 'bg-gradient-to-br from-[#080c14] to-[#f6465d]/10 border-[#f6465d]/40'
                      : 'bg-[#080c14] border-[#151d2c]'
                  }`}
                >
                  <div className="flex items-center justify-between mb-3">
                    <div className="flex items-center space-x-2">
                      <span className="w-2.5 h-2.5 rounded-full bg-[#0ecb81] animate-ping" />
                      <span className="font-bold text-xs uppercase tracking-wider text-[#e6edf3]">
                        Hazırda (Canlı Mövqe)
                      </span>
                    </div>
                    {data.live.hasPosition && (
                      <span className="px-2 py-0.5 rounded text-[11px] font-bold bg-[#2962ff]/20 text-[#2962ff] border border-[#2962ff]/30">
                        {data.live.symbol} {data.live.side} {data.live.leverage}x
                      </span>
                    )}
                  </div>

                  {data.live.hasPosition ? (
                    <div>
                      <div className="flex items-baseline space-x-2 my-2">
                        <span
                          className={`text-2xl font-black ${
                            (data.live.unrealizedPnl || 0) >= 0 ? 'text-[#0ecb81]' : 'text-[#f6465d]'
                          }`}
                        >
                          {formatUsd(data.live.unrealizedPnl, true)}
                        </span>
                        <span
                          className={`text-sm font-bold ${
                            (data.live.roePercent || 0) >= 0 ? 'text-[#0ecb81]' : 'text-[#f6465d]'
                          }`}
                        >
                          ({(data.live.roePercent || 0) >= 0 ? '+' : ''}
                          {data.live.roePercent}%)
                        </span>
                      </div>

                      <div className="grid grid-cols-2 gap-2 mt-3 pt-3 border-t border-[#151d2c] text-[11px]">
                        <div>
                          <span className="text-[#7d8590] block">Giriş Qiyməti:</span>
                          <span className="font-semibold text-[#e6edf3]">${data.live.entryPrice?.toFixed(4)}</span>
                        </div>
                        <div>
                          <span className="text-[#7d8590] block">Cari Qiymət:</span>
                          <span className="font-semibold text-[#e6edf3]">${data.live.markPrice?.toFixed(4)}</span>
                        </div>
                        <div>
                          <span className="text-[#7d8590] block">Stop Loss:</span>
                          <span className="font-semibold text-amber-400">
                            ${data.live.stopLoss?.toFixed(4) || 'Yoxdur'}
                          </span>
                        </div>
                        <div>
                          <span className="text-[#7d8590] block">Ayrılmış Marja:</span>
                          <span className="font-semibold text-[#e6edf3]">${data.live.marginUsd?.toFixed(2)}</span>
                        </div>
                      </div>

                      {data.live.isRiskFree && (
                        <div className="mt-3 px-2.5 py-1.5 rounded bg-emerald-500/10 border border-emerald-500/30 text-emerald-400 text-[11px] flex items-center space-x-1.5">
                          <ShieldCheck className="w-4 h-4 shrink-0" />
                          <span>Mövqe 100% risksizdir (Breakeven təmin olunub).</span>
                        </div>
                      )}
                    </div>
                  ) : (
                    <div className="py-6 text-center text-[#7d8590]">
                      <ShieldCheck className="w-8 h-8 mx-auto mb-2 opacity-40 text-[#0ecb81]" />
                      <p className="text-xs">Hazırda açıq əməliyyat yoxdur.</p>
                      <p className="text-[11px] text-[#484f58] mt-1">Bütün kapital təhlükəsizlikdədir.</p>
                    </div>
                  )}
                </div>

                {/* 2. BUGÜN (Son 24 Saat) */}
                <div className="p-4 rounded-xl bg-[#080c14] border border-[#151d2c] flex flex-col justify-between">
                  <div className="flex items-center justify-between mb-3">
                    <div className="flex items-center space-x-2">
                      <Calendar className="w-4 h-4 text-[#3b82f6]" />
                      <span className="font-bold text-xs uppercase tracking-wider text-[#e6edf3]">
                        Bugün (Son 24 Saat)
                      </span>
                    </div>
                    <span className="text-[11px] text-[#7d8590]">
                      {data.today.tradeCount} əməliyyat
                    </span>
                  </div>

                  <div>
                    <div className="flex items-baseline space-x-2 my-2">
                      <span
                        className={`text-2xl font-black ${
                          data.today.netPnl >= 0 ? 'text-[#0ecb81]' : 'text-[#f6465d]'
                        }`}
                      >
                        {formatUsd(data.today.netPnl, true)}
                      </span>
                      <span className="text-xs text-[#7d8590]">xalis</span>
                    </div>

                    <div className="grid grid-cols-2 gap-2 mt-3 pt-3 border-t border-[#151d2c] text-[11px]">
                      <div>
                        <span className="text-[#7d8590] block">Bağlanmış Real Qazanc:</span>
                        <span className="font-semibold text-[#e6edf3]">{formatUsd(data.today.realizedPnl, true)}</span>
                      </div>
                      <div>
                        <span className="text-[#7d8590] block">Cari Canlı Qazanc:</span>
                        <span
                          className={`font-semibold ${
                            data.today.unrealizedPnl >= 0 ? 'text-[#0ecb81]' : 'text-[#f6465d]'
                          }`}
                        >
                          {formatUsd(data.today.unrealizedPnl, true)}
                        </span>
                      </div>
                      <div>
                        <span className="text-[#7d8590] block">Binance Komissiyası:</span>
                        <span className="font-semibold text-rose-400">{formatUsd(data.today.commission, false)}</span>
                      </div>
                      <div>
                        <span className="text-[#7d8590] block">Uğurlu Əməliyyat:</span>
                        <span className="font-semibold text-[#0ecb81]">{data.today.winRate}%</span>
                      </div>
                    </div>
                  </div>
                </div>

                {/* 3. SON 3 GÜN (Son 72 Saat) */}
                <div className="p-4 rounded-xl bg-[#080c14] border border-[#151d2c] flex flex-col justify-between">
                  <div className="flex items-center justify-between mb-3">
                    <div className="flex items-center space-x-2">
                      <Clock className="w-4 h-4 text-[#8b5cf6]" />
                      <span className="font-bold text-xs uppercase tracking-wider text-[#e6edf3]">
                        Son 3 Gün
                      </span>
                    </div>
                    <span className="text-[11px] text-[#7d8590]">
                      {data.threeDays.tradeCount} əməliyyat
                    </span>
                  </div>

                  <div>
                    <div className="flex items-baseline space-x-2 my-2">
                      <span
                        className={`text-2xl font-black ${
                          data.threeDays.netPnl >= 0 ? 'text-[#0ecb81]' : 'text-[#f6465d]'
                        }`}
                      >
                        {formatUsd(data.threeDays.netPnl, true)}
                      </span>
                      <span className="text-xs text-[#7d8590]">xalis balans</span>
                    </div>

                    <div className="grid grid-cols-2 gap-2 mt-3 pt-3 border-t border-[#151d2c] text-[11px]">
                      <div>
                        <span className="text-[#7d8590] block">Bağlanmış Real Qazanc:</span>
                        <span className="font-semibold text-[#0ecb81]">{formatUsd(data.threeDays.realizedPnl, true)}</span>
                      </div>
                      <div>
                        <span className="text-[#7d8590] block">Ödənilən Komissiyalar:</span>
                        <span className="font-semibold text-rose-400">{formatUsd(data.threeDays.commission, false)}</span>
                      </div>
                      <div>
                        <span className="text-[#7d8590] block">Qazanclı Ticarət:</span>
                        <span className="font-semibold text-[#0ecb81]">{data.threeDays.winRate}%</span>
                      </div>
                      <div>
                        <span className="text-[#7d8590] block">İtki Sayı:</span>
                        {(() => {
                          const beCount = Math.max(0, data.threeDays.tradeCount - data.threeDays.winCount - data.threeDays.lossCount);
                          return (
                            <span className="font-semibold text-[#7d8590]">{data.threeDays.lossCount} ({beCount} Breakeven)</span>
                          );
                        })()}
                      </div>
                    </div>
                  </div>
                </div>

                {/* 4. HƏFTƏLİK (Son 7 Gün) */}
                <div className="p-4 rounded-xl bg-[#080c14] border border-[#151d2c] flex flex-col justify-between">
                  <div className="flex items-center justify-between mb-3">
                    <div className="flex items-center space-x-2">
                      <Award className="w-4 h-4 text-amber-400" />
                      <span className="font-bold text-xs uppercase tracking-wider text-[#e6edf3]">
                        Həftəlik (Son 7 Gün)
                      </span>
                    </div>
                    <span className="text-[11px] text-[#7d8590]">
                      {data.weekly.tradeCount} əməliyyat
                    </span>
                  </div>

                  <div>
                    <div className="flex items-baseline space-x-2 my-2">
                      <span
                        className={`text-2xl font-black ${
                          data.weekly.netPnl >= 0 ? 'text-[#0ecb81]' : 'text-[#f6465d]'
                        }`}
                      >
                        {formatUsd(data.weekly.netPnl, true)}
                      </span>
                      <span className="text-xs text-[#7d8590]">ümumi dinamika</span>
                    </div>

                    <div className="grid grid-cols-2 gap-2 mt-3 pt-3 border-t border-[#151d2c] text-[11px]">
                      <div>
                        <span className="text-[#7d8590] block">Ticarət Nəticəsi:</span>
                        <span
                          className={`font-semibold ${
                            data.weekly.realizedPnl >= 0 ? 'text-[#0ecb81]' : 'text-[#f6465d]'
                          }`}
                        >
                          {formatUsd(data.weekly.realizedPnl, true)}
                        </span>
                      </div>
                      <div>
                        <span className="text-[#7d8590] block">Cəmi Komissiya:</span>
                        <span className="font-semibold text-rose-400">{formatUsd(data.weekly.commission, false)}</span>
                      </div>
                      <div>
                        <span className="text-[#7d8590] block">Son 3 Günün Trendi:</span>
                        <span className={`font-semibold ${data.threeDays.netPnl >= 0 ? 'text-[#0ecb81]' : 'text-[#f6465d]'}`}>
                          {data.threeDays.netPnl >= 0 ? 'Müsbət (' : 'Mənfi ('}{formatUsd(data.threeDays.netPnl, true)})
                        </span>
                      </div>
                      <div>
                        <span className="text-[#7d8590] block">Ümumi Cüzdan:</span>
                        <span className="font-semibold text-[#e6edf3]">{formatUsd(data.account.walletBalance, false)}</span>
                      </div>
                    </div>
                  </div>
                </div>
              </div>

              {/* Human-Friendly Sokrat Briefing Card */}
              <div className="p-4 bg-gradient-to-r from-[#020305] to-[#080c14] border border-[#151d2c] rounded-xl flex items-start space-x-3">
                <div className="w-8 h-8 rounded-full bg-[#3b82f6]/20 border border-[#3b82f6]/30 flex items-center justify-center shrink-0 mt-0.5 text-[#3b82f6]">
                  <HelpCircle className="w-4 h-4" />
                </div>
                <div className="space-y-1">
                  <h4 className="text-xs font-bold text-[#e6edf3] uppercase tracking-wide">
                    Sokrat Mentorun Sadə Dildə İzahı
                  </h4>
                  <p className="text-xs text-[#cad1d9] leading-relaxed">
                    {data.humanExplanation}
                  </p>
                </div>
              </div>
            </>
          )}
        </div>

        {/* Footer */}
        <div className="px-5 py-3 border-t border-[#151d2c] bg-[#020305] flex items-center justify-between text-xs">
          <span className="text-[#7d8590] text-[11px]">
            Hər 5 saniyədən bir avtomatik yenilənir
          </span>
          <button
            onClick={() => setIsPnlModalOpen(false)}
            className="px-4 py-1.5 rounded bg-[#151d2c] hover:bg-[#1f2937] text-[#e6edf3] transition-colors"
          >
            Bağla
          </button>
        </div>
      </div>
    </div>
  );
};
