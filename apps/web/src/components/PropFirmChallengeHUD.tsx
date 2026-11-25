import React, { useState } from 'react';
import type { PropFirmChallengeCycle, PropFirmCycleStatus, PropFirmQuestionVerdict } from '@tradeos/shared';
import {
  AlertTriangle,
  Award,
  ChevronDown,
  ChevronUp,
  Lock,
  ShieldCheck,
  Target,
  Trophy,
} from 'lucide-react';
import { useMarketStore } from '../store/useMarketStore';
import { formatUsd } from '../lib/formatters';

function clampPct(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, value));
}

function formatSignedPercent(value: number): string {
  if (!Number.isFinite(value) || Math.abs(value) < 0.005) {
    return '0.00%';
  }
  const abs = Math.abs(value).toFixed(2);
  return value > 0 ? `+${abs}%` : `-${abs}%`;
}

function formatUtcDate(timestampMs: number | null | undefined): string {
  if (!timestampMs || !Number.isFinite(timestampMs)) return '—';
  return new Date(timestampMs).toISOString().slice(0, 10);
}

function getCycleStatusMeta(status: PropFirmCycleStatus): { label: string; className: string } {
  switch (status) {
    case 'PASSED':
      return {
        label: '✓ UĞURLU',
        className: 'bg-[#0ecb81]/15 text-[#0ecb81] border-[#0ecb81]/40',
      };
    case 'HALTED_DAILY_BUFFER':
    case 'HALTED_TRAILING_BUFFER':
      return {
        label: 'LİMİT HALT',
        className: 'bg-[#f0b90b]/15 text-[#f0b90b] border-[#f0b90b]/40',
      };
    case 'FAILED_DAILY':
    case 'FAILED_TRAILING':
      return {
        label: 'LİMİT AŞILDI',
        className: 'bg-[#f6465d]/15 text-[#f6465d] border-[#f6465d]/40',
      };
    case 'ACTIVE':
    default:
      return {
        label: 'AKTİV',
        className: 'bg-[#2962ff]/15 text-[#2962ff] border-[#2962ff]/40',
      };
  }
}

function getVerdictMeta(verdict: PropFirmQuestionVerdict): {
  label: string;
  boxClass: string;
  valueClass: string;
} {
  switch (verdict) {
    case 'YES_PROFIT':
      return {
        label: 'BƏLİ, QAZANCDASAN',
        boxClass: 'bg-[#0ecb81]/15 border-[#0ecb81]/40 text-[#0ecb81]',
        valueClass: 'text-[#0ecb81]',
      };
    case 'NO_LOSS':
      return {
        label: 'XEYR, ZƏRƏRDƏSƏN',
        boxClass: 'bg-[#f6465d]/15 border-[#f6465d]/40 text-[#f6465d]',
        valueClass: 'text-[#f6465d]',
      };
    case 'WAITING':
    default:
      return {
        label: 'GÖZLƏMƏDƏ',
        boxClass: 'bg-[#151d2c] border-[#263248] text-[#7d8590]',
        valueClass: 'text-[#7d8590]',
      };
  }
}

export const PropFirmChallengeHUD: React.FC = () => {
  const status = useMarketStore((s) => s.propFirmStatus);
  const [isHistoryOpen, setIsHistoryOpen] = useState(false);

  const cycle = status?.cycle ?? null;
  const verdict: PropFirmQuestionVerdict = status?.verdict ?? 'WAITING';
  const verdictMeta = getVerdictMeta(verdict);

  const netPnlUsd = cycle?.netPnlUsd ?? 0;
  const netPnlPct = cycle?.netPnlPct ?? 0;
  const targetProgressPct = clampPct(status?.targetProgressPct ?? 0);
  const targetRemainingUsd = Math.max(0, status?.targetRemainingUsd ?? 2_500);

  const dailyBufferRemainingUsd = Math.max(0, status?.dailyBufferRemainingUsd ?? 1_250);
  const dailyBufferPct = clampPct(status?.dailyBufferRemainingPct ?? 100);
  const isDailyHalt =
    dailyBufferRemainingUsd <= 0 ||
    cycle?.status === 'HALTED_DAILY_BUFFER' ||
    cycle?.status === 'FAILED_DAILY';

  const trailingBufferRemainingUsd = Math.max(0, status?.trailingBufferRemainingUsd ?? 2_500);
  const trailingBufferPct = clampPct(status?.trailingBufferRemainingPct ?? 100);
  const isTrailingHalt =
    trailingBufferRemainingUsd <= 0 ||
    cycle?.status === 'HALTED_TRAILING_BUFFER' ||
    cycle?.status === 'FAILED_TRAILING';

  const trailingStatusLabel = isTrailingHalt
    ? 'HALT'
    : trailingBufferPct >= 70
      ? 'Çox Təhlükəsiz'
      : trailingBufferPct >= 35
        ? 'Təhlükəsiz'
        : 'Diqqət';

  const isFloorLocked = Boolean(cycle?.isFloorLocked);
  const consecutivePassed = status?.consecutivePassedCycles ?? 0;
  const requiredPassed = status?.requiredPassedCycles ?? 5;
  const isCertified = consecutivePassed >= requiredPassed;

  const historyRows: PropFirmChallengeCycle[] =
    status?.cycles && status.cycles.length > 0 ? status.cycles : cycle ? [cycle] : [];

  return (
    <div
      data-testid="propfirm-challenge-hud"
      className="flex flex-col bg-[#080c14] border border-[#151d2c] rounded-lg px-2.5 py-2 space-y-1.5 font-mono text-xs select-none"
    >
      {/* Testnet Top-Up Reminder Banner */}
      {status?.needsTopUp && (
        <div
          data-testid="propfirm-topup-banner"
          className="flex flex-wrap items-center justify-between gap-2 px-2.5 py-1 bg-[#f0b90b]/15 border border-[#f0b90b]/50 rounded text-[#f0b90b] text-[11px] font-bold"
        >
          <div className="flex items-center space-x-1.5">
            <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0 text-[#f0b90b]" />
            <span className="tabular-nums">
              TESTNET TOP-UP TƏLƏB OLUNUR: Faktiki balans {formatUsd(status.liveWalletBalanceUsd)} / $50,000.00 —{' '}
              {status.topUpMessage
                ? status.topUpMessage
                : 'Binance Demo Faucet vasitəsilə USDT balansını $50,000.00-ə tamamlayın.'}
              {status.topUpMessage && !/faucet/i.test(status.topUpMessage) ? ' (Binance Demo Faucet)' : ''}
            </span>
          </div>
        </div>
      )}

      {/* Header Bar */}
      <div className="flex flex-wrap items-center justify-between gap-2 pb-1.5 border-b border-[#151d2c]">
        <div className="flex items-center space-x-2">
          <Trophy className="w-3.5 h-3.5 text-[#f0b90b] flex-shrink-0" />
          <span className="font-bold text-[#e6edf3] tracking-wide">
            Upcomers $50K Challenge (Sadə Dildə)
          </span>
          {cycle && (
            <span className="px-1.5 py-0.5 rounded text-[10px] bg-[#151d2c] text-[#7d8590] border border-[#151d2c] tabular-nums">
              Dövrə #{cycle.cycleNumber}
            </span>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          {isFloorLocked && (
            <span
              data-testid="propfirm-floor-locked-badge"
              className="inline-flex items-center space-x-1 px-2 py-0.5 rounded text-[10px] font-bold bg-[#0ecb81]/15 text-[#0ecb81] border border-[#0ecb81]/40 tabular-nums"
            >
              <Lock className="w-3 h-3" />
              <span>FLOOR LOCKED: $50,000</span>
            </span>
          )}

          <span
            data-testid="propfirm-certificate-badge"
            className={`inline-flex items-center space-x-1 px-2 py-0.5 rounded text-[10px] font-bold border tabular-nums ${
              isCertified
                ? 'bg-[#0ecb81]/20 text-[#0ecb81] border-[#0ecb81]/50'
                : 'bg-[#151d2c] text-[#e6edf3] border-[#263248]'
            }`}
          >
            <Award className="w-3 h-3 text-[#f0b90b]" />
            <span>
              Sertifikat: {consecutivePassed} / {requiredPassed} Uğurlu Dövrə
            </span>
          </span>

          <button
            type="button"
            data-testid="propfirm-history-toggle"
            onClick={() => setIsHistoryOpen((prev) => !prev)}
            className="inline-flex items-center space-x-1 px-2 py-0.5 rounded text-[10px] font-bold bg-[#020305] hover:bg-[#151d2c] text-[#e6edf3] border border-[#151d2c] transition-colors"
          >
            <span>Açılan Tarixçə Cədvəli</span>
            {isHistoryOpen ? (
              <ChevronUp className="w-3 h-3 text-[#7d8590]" />
            ) : (
              <ChevronDown className="w-3 h-3 text-[#7d8590]" />
            )}
          </button>
        </div>
      </div>

      {/* Main Compact 3-Column Metrics Grid */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-2 items-stretch">
        {/* 1. "Doğurdan Qazanırammı?" Verdict Box */}
        <div
          data-testid="propfirm-verdict-box"
          className={`lg:col-span-4 flex items-center justify-between gap-2 px-2.5 py-1.5 rounded border ${verdictMeta.boxClass}`}
        >
          <div className="flex flex-col min-w-0">
            <span className="text-[10px] text-[#7d8590] uppercase tracking-wide">
              Doğurdan Qazanırammı?
            </span>
            <span className="font-bold text-xs tracking-wide truncate">
              {verdictMeta.label}
            </span>
          </div>
          <div className="flex flex-col items-end tabular-nums flex-shrink-0">
            <span className={`font-bold text-sm leading-tight ${verdictMeta.valueClass}`}>
              {formatUsd(netPnlUsd, true)}
            </span>
            <span className={`text-[10px] font-semibold ${verdictMeta.valueClass}`}>
              ({formatSignedPercent(netPnlPct)})
            </span>
          </div>
        </div>

        {/* 2. Upcomers $2,500 Target Progress Bar */}
        <div
          data-testid="propfirm-target-progress"
          className="lg:col-span-4 flex flex-col justify-center px-2.5 py-1.5 rounded bg-[#020305] border border-[#151d2c] space-y-1"
        >
          <div className="flex items-center space-x-1 text-[10px] text-[#e6edf3] tabular-nums leading-tight">
            <Target className="w-3 h-3 text-[#0ecb81] flex-shrink-0" />
            <span className="truncate">
              Hədəf: +$2,500.00 | Cari: {formatUsd(netPnlUsd, true)} ({targetProgressPct.toFixed(1)}% Tamamlandı) | Qalan: {formatUsd(targetRemainingUsd)}
            </span>
          </div>
          <div className="w-full h-1.5 bg-[#080c14] border border-[#151d2c] rounded-full overflow-hidden">
            <div
              style={{ width: `${targetProgressPct}%` }}
              className={`h-full transition-all duration-300 ${
                targetProgressPct >= 100
                  ? 'bg-[#0ecb81]'
                  : targetProgressPct >= 50
                    ? 'bg-[#0ecb81]/85'
                    : 'bg-[#2962ff]'
              }`}
            />
          </div>
        </div>

        {/* 3. Daily & Trailing Safety Buffers */}
        <div className="lg:col-span-4 flex flex-col justify-center px-2.5 py-1.5 rounded bg-[#020305] border border-[#151d2c] space-y-1 tabular-nums">
          {/* Daily Buffer */}
          <div data-testid="propfirm-daily-buffer" className="space-y-0.5">
            <div className="flex items-center justify-between text-[10px] gap-1">
              <span className="text-[#e6edf3] truncate">
                Gündəlik Zərər Həddi: $1,250.00 | Qalan Haqq: {formatUsd(dailyBufferRemainingUsd)}
              </span>
              <span
                className={`font-bold flex-shrink-0 ${
                  isDailyHalt
                    ? 'text-[#f6465d]'
                    : dailyBufferPct >= 50
                      ? 'text-[#0ecb81]'
                      : 'text-[#f0b90b]'
                }`}
              >
                {isDailyHalt ? 'HALT' : `${dailyBufferPct.toFixed(1)}% Safe`}
              </span>
            </div>
            <div className="w-full h-1 bg-[#080c14] rounded-full overflow-hidden">
              <div
                style={{ width: `${dailyBufferPct}%` }}
                className={`h-full transition-all duration-300 ${
                  isDailyHalt
                    ? 'bg-[#f6465d]'
                    : dailyBufferPct >= 50
                      ? 'bg-[#0ecb81]'
                      : 'bg-[#f0b90b]'
                }`}
              />
            </div>
          </div>

          {/* Trailing Buffer */}
          <div data-testid="propfirm-trailing-buffer" className="space-y-0.5">
            <div className="flex items-center justify-between text-[10px] gap-1">
              <span className="text-[#e6edf3] truncate inline-flex items-center space-x-1">
                <ShieldCheck className="w-3 h-3 text-[#0ecb81] flex-shrink-0" />
                <span>
                  Maksimum Geriləmə Həddi: $2,500.00 | Qalan Haqq: {formatUsd(trailingBufferRemainingUsd)}
                </span>
              </span>
              <span
                className={`font-bold flex-shrink-0 ${
                  isTrailingHalt
                    ? 'text-[#f6465d]'
                    : trailingBufferPct >= 50
                      ? 'text-[#0ecb81]'
                      : 'text-[#f0b90b]'
                }`}
              >
                {trailingStatusLabel}
              </span>
            </div>
            <div className="w-full h-1 bg-[#080c14] rounded-full overflow-hidden">
              <div
                style={{ width: `${trailingBufferPct}%` }}
                className={`h-full transition-all duration-300 ${
                  isTrailingHalt
                    ? 'bg-[#f6465d]'
                    : trailingBufferPct >= 50
                      ? 'bg-[#0ecb81]'
                      : 'bg-[#f0b90b]'
                }`}
              />
            </div>
          </div>
        </div>
      </div>

      {/* Expandable Cycle History Table */}
      {isHistoryOpen && (
        <div
          data-testid="propfirm-history-table"
          className="bg-[#020305] border border-[#151d2c] rounded overflow-hidden"
        >
          <div className="max-h-36 overflow-y-auto">
            <table className="w-full text-left border-collapse text-[11px] tabular-nums">
              <thead>
                <tr className="border-b border-[#151d2c] text-[#7d8590] text-[10px] uppercase bg-[#080c14]">
                  <th className="py-1 px-2">Dövrə #</th>
                  <th className="py-1 px-2">Qazanc/Ziyan</th>
                  <th className="py-1 px-2">Max Drawdown</th>
                  <th className="py-1 px-2">Tarix</th>
                  <th className="py-1 px-2 text-right">Status</th>
                </tr>
              </thead>
              <tbody>
                {historyRows.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="py-2 px-2 text-center text-[#7d8590]">
                      Hələ dövrə tarixçəsi yoxdur.
                    </td>
                  </tr>
                ) : (
                  historyRows.map((row) => {
                    const statusMeta = getCycleStatusMeta(row.status);
                    const pnlColor =
                      row.netPnlUsd > 0.005
                        ? 'text-[#0ecb81]'
                        : row.netPnlUsd < -0.005
                          ? 'text-[#f6465d]'
                          : 'text-[#7d8590]';

                    return (
                      <tr
                        key={row.id}
                        className="border-b border-[#151d2c]/50 last:border-b-0 hover:bg-[#080c14]/70"
                      >
                        <td className="py-1 px-2 font-bold text-[#e6edf3]">#{row.cycleNumber}</td>
                        <td className={`py-1 px-2 font-bold ${pnlColor}`}>
                          {formatUsd(row.netPnlUsd, true)}
                        </td>
                        <td className="py-1 px-2 text-[#e6edf3]">
                          {formatUsd(row.maxDrawdownUsd)}
                        </td>
                        <td className="py-1 px-2 text-[#7d8590]">
                          {formatUtcDate(row.closedAt ?? row.startedAt)}
                        </td>
                        <td className="py-1 px-2 text-right">
                          <span
                            className={`inline-block px-1.5 py-0.5 rounded text-[10px] font-bold border ${statusMeta.className}`}
                          >
                            {statusMeta.label}
                          </span>
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
};
