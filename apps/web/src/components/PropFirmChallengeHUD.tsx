import React, { useState } from 'react';
import type { PropFirmChallengeCycle, PropFirmCycleStatus, PropFirmQuestionVerdict } from '@tradeos/shared';
import {
  AlertTriangle,
  Award,
  ChevronDown,
  ChevronUp,
  Download,
  Lock,
  RotateCcw,
  ShieldCheck,
  Target,
  Trophy,
  X,
} from 'lucide-react';
import { useMarketStore } from '../store/useMarketStore';
import { apiClient } from '../lib/apiClient';
import { formatUsd } from '../lib/formatters';

const ACTIVE_AUTOPILOT_STATES = new Set([
  'PLACING_ORDER',
  'LIMIT_CHASING',
  'POSITION_OPEN',
  'CLOSING',
]);

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

export interface PropFirmChallengeHUDProps {
  defaultHistoryOpen?: boolean;
}

interface InlineErrorBannerProps {
  testId: string;
  message: string;
  onDismiss: () => void;
}

const InlineErrorBanner: React.FC<InlineErrorBannerProps> = ({ testId, message, onDismiss }) => (
  <div
    data-testid={testId}
    role="alert"
    className="flex items-center justify-between gap-2 px-2 py-0.5 bg-[#f6465d]/15 border border-[#f6465d]/50 rounded text-[#f6465d] text-[10px] font-bold leading-tight"
  >
    <span>{message}</span>
    <button
      type="button"
      aria-label="Xətanı bağla"
      onClick={onDismiss}
      className="p-0.5 text-[#f6465d] hover:text-[#e6edf3] transition-colors flex-shrink-0"
    >
      <X className="w-3 h-3" />
    </button>
  </div>
);

export const PropFirmChallengeHUD: React.FC<PropFirmChallengeHUDProps> = ({
  defaultHistoryOpen = false,
}) => {
  const status = useMarketStore((s) => s.propFirmStatus);
  const activePosition = useMarketStore((s) => s.activePosition);
  const autoPilotState = useMarketStore((s) => s.autoPilot.state);
  const startNewPropFirmCycle = useMarketStore((s) => s.startNewPropFirmCycle);
  const [isHistoryOpen, setIsHistoryOpen] = useState<boolean>(defaultHistoryOpen);
  const [isStartingCycle, setIsStartingCycle] = useState(false);
  const [cycleError, setCycleError] = useState<string | null>(null);
  const [isDownloadingCert, setIsDownloadingCert] = useState(false);
  const [certError, setCertError] = useState<string | null>(null);

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

  const canShowNewCycleBtn = Boolean(
    cycle &&
      (cycle.status === 'PASSED' ||
        cycle.status === 'FAILED_DAILY' ||
        cycle.status === 'FAILED_TRAILING' ||
        cycle.status === 'HALTED_TRAILING_BUFFER')
  );

  const isNewCycleDisabled =
    (activePosition !== null && activePosition.status !== 'CLOSED') ||
    isStartingCycle ||
    ACTIVE_AUTOPILOT_STATES.has(autoPilotState);

  const handleStartNewCycle = async () => {
    if (isNewCycleDisabled) return;
    setIsStartingCycle(true);
    setCycleError(null);
    try {
      await startNewPropFirmCycle();
    } catch (err) {
      const msg =
        err instanceof Error && err.message
          ? err.message
          : 'Yeni dövrə başladılarkən xəta baş verdi.';
      setCycleError(msg);
    } finally {
      setIsStartingCycle(false);
    }
  };

  const handleDownloadCertificate = async () => {
    if (isDownloadingCert) return;
    setIsDownloadingCert(true);
    setCertError(null);
    try {
      await apiClient.downloadPropFirmCertificateMarkdown();
    } catch (err) {
      const msg =
        err instanceof Error && err.message
          ? err.message
          : 'Sertifikat yüklənərkən xəta baş verdi.';
      setCertError(msg);
    } finally {
      setIsDownloadingCert(false);
    }
  };

  return (
    <div
      data-testid="propfirm-challenge-hud"
      className="flex flex-col bg-[#080c14] border border-[#151d2c] rounded-lg px-2.5 py-1 space-y-1 font-mono text-xs select-none"
    >
      {/* Testnet Top-Up Reminder Banner */}
      {status?.needsTopUp && (
        <div
          data-testid="propfirm-topup-banner"
          className="flex items-center justify-between gap-2 px-2 py-0.5 bg-[#f0b90b]/15 border border-[#f0b90b]/50 rounded text-[#f0b90b] text-[10px] font-bold leading-tight"
        >
          <div className="flex items-center space-x-1.5 min-w-0">
            <AlertTriangle className="w-3 h-3 flex-shrink-0 text-[#f0b90b]" />
            <span className="tabular-nums">
              10x Simulyasiya Aktivdir — Cüzdan {formatUsd(status.liveWalletBalanceUsd)} × 10 → $50,000.00 Upcomers:
            </span>
          </div>
          <a
            data-testid="propfirm-faucet-link"
            href="https://testnet.binancefuture.com"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 px-1.5 py-0 rounded bg-[#f0b90b]/20 hover:bg-[#f0b90b]/30 border border-[#f0b90b]/60 text-[#f0b90b] text-[10px] font-bold whitespace-nowrap flex-shrink-0 transition-colors"
          >
            <span>Binance Demo Faucet ↗</span>
          </a>
        </div>
      )}

      {/* Header Bar */}
      <div className="flex flex-wrap items-center justify-between gap-1.5 pb-0.5 border-b border-[#151d2c]">
        <div className="flex items-center space-x-1.5">
          <Trophy className="w-3.5 h-3.5 text-[#f0b90b] flex-shrink-0" />
          <span className="font-bold text-[11px] text-[#e6edf3] tracking-wide whitespace-nowrap">
            Upcomers $50K Challenge (Sadə Dildə)
          </span>
          {cycle && (
            <span className="px-1.5 py-0 rounded text-[10px] bg-[#151d2c] text-[#7d8590] border border-[#151d2c] tabular-nums whitespace-nowrap">
              Dövrə #{cycle.cycleNumber}
            </span>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-1">
          {isFloorLocked && (
            <span
              data-testid="propfirm-floor-locked-badge"
              className="inline-flex items-center space-x-1 px-1.5 py-0 rounded text-[10px] font-bold bg-[#0ecb81]/15 text-[#0ecb81] border border-[#0ecb81]/40 tabular-nums whitespace-nowrap"
            >
              <Lock className="w-2.5 h-2.5" />
              <span>FLOOR LOCKED: $50,000</span>
            </span>
          )}

          <span
            data-testid="propfirm-certificate-badge"
            className={`inline-flex items-center space-x-1 px-1.5 py-0 rounded text-[10px] font-bold border tabular-nums whitespace-nowrap ${
              isCertified
                ? 'bg-[#0ecb81]/20 text-[#0ecb81] border-[#0ecb81]/50'
                : 'bg-[#151d2c] text-[#e6edf3] border-[#263248]'
            }`}
          >
            <Award className="w-2.5 h-2.5 text-[#f0b90b]" />
            <span>
              Sertifikat: {consecutivePassed} / {requiredPassed} Uğurlu Dövrə
            </span>
          </span>

          {canShowNewCycleBtn && (
            <button
              type="button"
              data-testid="propfirm-new-cycle-btn"
              disabled={isNewCycleDisabled}
              onClick={handleStartNewCycle}
              className="inline-flex items-center space-x-1 px-1.5 py-0 rounded text-[10px] font-bold bg-[#2962ff]/20 hover:bg-[#2962ff]/30 disabled:opacity-45 disabled:cursor-not-allowed text-[#e6edf3] border border-[#2962ff]/60 transition-colors whitespace-nowrap"
            >
              <RotateCcw className="w-2.5 h-2.5 text-[#2962ff]" />
              <span>{isStartingCycle ? 'Başladılır...' : 'Yeni Dövrə Başlat'}</span>
            </button>
          )}

          <button
            type="button"
            data-testid="propfirm-download-cert-btn"
            disabled={isDownloadingCert}
            onClick={handleDownloadCertificate}
            className="inline-flex items-center space-x-1 px-1.5 py-0 rounded text-[10px] font-bold bg-[#020305] hover:bg-[#151d2c] disabled:opacity-45 disabled:cursor-not-allowed text-[#e6edf3] border border-[#151d2c] transition-colors whitespace-nowrap"
          >
            <Download className="w-2.5 h-2.5 text-[#0ecb81]" />
            <span>{isDownloadingCert ? 'Yüklənir...' : 'Sertifikatı Yüklə (.md)'}</span>
          </button>

          <button
            type="button"
            data-testid="propfirm-history-toggle"
            onClick={() => setIsHistoryOpen((prev) => !prev)}
            className="inline-flex items-center space-x-1 px-1.5 py-0 rounded text-[10px] font-bold bg-[#020305] hover:bg-[#151d2c] text-[#e6edf3] border border-[#151d2c] transition-colors whitespace-nowrap"
          >
            <span>Açılan Tarixçə Cədvəli</span>
            {isHistoryOpen ? (
              <ChevronUp className="w-2.5 h-2.5 text-[#7d8590]" />
            ) : (
              <ChevronDown className="w-2.5 h-2.5 text-[#7d8590]" />
            )}
          </button>
        </div>
      </div>

      {/* Dismissible Cycle Rollover & Certificate Error Alerts */}
      {cycleError && (
        <InlineErrorBanner
          testId="propfirm-new-cycle-error"
          message={cycleError}
          onDismiss={() => setCycleError(null)}
        />
      )}
      {certError && (
        <InlineErrorBanner
          testId="propfirm-download-cert-error"
          message={certError}
          onDismiss={() => setCertError(null)}
        />
      )}

      {/* Main Compact 3-Column Metrics Grid */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-1.5 items-stretch">
        {/* 1. "Doğurdan Qazanırammı?" Verdict Box */}
        <div
          data-testid="propfirm-verdict-box"
          className={`lg:col-span-3 flex items-center justify-between gap-1.5 px-2 py-1 rounded border ${verdictMeta.boxClass}`}
        >
          <div className="flex flex-col min-w-0 leading-tight">
            <span className="text-[9px] text-[#7d8590] uppercase tracking-wide whitespace-nowrap">
              Doğurdan Qazanırammı?
            </span>
            <span className="font-bold text-[10px] tracking-wide whitespace-nowrap">
              {verdictMeta.label}
            </span>
          </div>
          <div className="flex flex-col items-end tabular-nums flex-shrink-0 leading-tight">
            <span className={`font-bold text-xs leading-tight ${verdictMeta.valueClass}`}>
              {formatUsd(netPnlUsd, true)}
            </span>
            <span className={`text-[9px] font-semibold ${verdictMeta.valueClass}`}>
              ({formatSignedPercent(netPnlPct)})
            </span>
          </div>
        </div>

        {/* 2. Upcomers $2,500 Target Progress Bar */}
        <div
          data-testid="propfirm-target-progress"
          className="lg:col-span-4 flex flex-col justify-center px-2 py-1 rounded bg-[#020305] border border-[#151d2c] space-y-0.5"
        >
          <div className="flex items-center justify-between gap-2 text-[10px] text-[#e6edf3] whitespace-nowrap tabular-nums leading-tight">
            <span className="inline-flex items-center gap-1">
              <Target className="w-3 h-3 text-[#0ecb81] flex-shrink-0" />
              <span>Hədəf: +$2,500.00</span>
            </span>
            <span className="font-semibold text-[#e6edf3]">
              Qalan: {formatUsd(targetRemainingUsd)}
            </span>
          </div>
          <div className="flex items-center justify-between gap-2 text-[10px] text-[#7d8590] whitespace-nowrap tabular-nums leading-tight">
            <span>
              Cari: <span className="font-bold text-[#e6edf3]">{formatUsd(netPnlUsd, true)}</span>
            </span>
            <span>{targetProgressPct.toFixed(1)}% Tamamlandı</span>
          </div>
          <div className="w-full h-1 bg-[#080c14] border border-[#151d2c] rounded-full overflow-hidden">
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
        <div className="lg:col-span-5 flex flex-col justify-center px-2 py-1 rounded bg-[#020305] border border-[#151d2c] space-y-1 tabular-nums">
          {/* Daily Buffer */}
          <div data-testid="propfirm-daily-buffer" className="space-y-0.5">
            <div className="flex items-center justify-between gap-2 text-[10px] whitespace-nowrap tabular-nums leading-tight">
              <span className="text-[#e6edf3]">Gündəlik Zərər Həddi: $1,250.00</span>
              <span
                className={`font-bold flex-shrink-0 ${
                  isDailyHalt
                    ? 'text-[#f6465d]'
                    : dailyBufferPct >= 50
                      ? 'text-[#0ecb81]'
                      : 'text-[#f0b90b]'
                }`}
              >
                {isDailyHalt ? 'HALT' : `${dailyBufferPct.toFixed(1)}% Təhlükəsiz`}
              </span>
            </div>
            <div className="flex items-center justify-between gap-2 text-[10px] whitespace-nowrap tabular-nums leading-tight">
              <span className="text-[#e6edf3] flex-shrink-0">
                Qalan Haqq: {formatUsd(dailyBufferRemainingUsd)}
              </span>
              <div className="flex-1 h-1 bg-[#080c14] rounded-full overflow-hidden">
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
          </div>

          {/* Trailing Buffer */}
          <div data-testid="propfirm-trailing-buffer" className="space-y-0.5">
            <div className="flex items-center justify-between gap-2 text-[10px] whitespace-nowrap tabular-nums leading-tight">
              <span className="inline-flex items-center gap-1 text-[#e6edf3]">
                <ShieldCheck className="w-3 h-3 text-[#0ecb81] flex-shrink-0" />
                <span>Maksimum Geriləmə Həddi: $2,500.00</span>
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
            <div className="flex items-center justify-between gap-2 text-[10px] whitespace-nowrap tabular-nums leading-tight">
              <span className="text-[#e6edf3] flex-shrink-0">
                Qalan Haqq: {formatUsd(trailingBufferRemainingUsd)}
              </span>
              <div className="flex-1 h-1 bg-[#080c14] rounded-full overflow-hidden">
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
