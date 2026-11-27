import React, { useState, useEffect, useCallback } from 'react';
import { apiClient } from '../lib/apiClient';
import type {
  FactorTelemetryEvent,
  FactorStateDetail,
  QuantConvictionArchetype,
} from '@tradeos/shared';
import { useMarketStore } from '../store/useMarketStore';
import { useUiStore } from '../store/useUiStore';
import {
  Activity,
  RefreshCw,
  ChevronDown,
  ChevronRight,
  TrendingDown,
  TrendingUp,
  AlertTriangle,
  Radio,
  Clock,
  Maximize2,
  Minimize2,
  ArrowRightCircle,
  ArrowDownCircle,
  ShieldAlert,
  Cpu,
  Sliders,
  Zap,
  FileText,
} from 'lucide-react';

const ARCHETYPE_LABELS: Record<QuantConvictionArchetype, string> = {
  SUB_THRESHOLD: 'Sub-Threshold',
  EXPLORATORY_PROBE: 'Exploratory Probe',
  STANDARD_INSTITUTIONAL: 'Standard Institutional',
  HIGH_CONVICTION_CORE: 'High-Conviction Core',
  A_PLUS_INSTITUTIONAL: 'A+ Institutional',
};

/**
 * Formats a QuantConvictionArchetype enum code into a human-readable cockpit label.
 */
export function formatConvictionArchetype(archetype?: QuantConvictionArchetype | string): string {
  if (!archetype) return 'Sub-Threshold';
  if (archetype in ARCHETYPE_LABELS) {
    return ARCHETYPE_LABELS[archetype as QuantConvictionArchetype];
  }
  return String(archetype);
}

/**
 * Maps a factor bias ('BULLISH' | 'BEARISH' | 'NEUTRAL') to its semantic cockpit badge classes.
 */
export function getFactorBiasBadgeClass(bias?: string): string {
  const upper = bias?.toUpperCase();
  if (upper === 'BULLISH' || upper === 'BUY') {
    return 'border bg-[#0ecb81]/10 text-[#0ecb81] border-[#0ecb81]/30';
  }
  if (upper === 'BEARISH' || upper === 'SELL') {
    return 'border bg-[#f6465d]/10 text-[#f6465d] border-[#f6465d]/30';
  }
  return 'border bg-[#151d2c] text-[#7d8590] border-[#151d2c]';
}

function getConvictionScoreClass(score: number): string {
  if (score >= 85) {
    return 'bg-[#0ecb81]/15 text-[#0ecb81] border-[#0ecb81]/40';
  }
  if (score >= 70) {
    return 'bg-[#2962ff]/15 text-[#2962ff] border-[#2962ff]/40';
  }
  return 'bg-[#f0b90b]/15 text-[#f0b90b] border-[#f0b90b]/40';
}

function getEventRowKey(ev: FactorTelemetryEvent, idx: number): string {
  if (ev.eventId) return ev.eventId;
  if (ev.id !== undefined) return String(ev.id);
  return `${ev.timestamp}-${ev.symbol}-${ev.triggerType}-${idx}`;
}

function fmtNum(val: number | null | undefined, decimals = 2): string {
  return typeof val === 'number' && Number.isFinite(val) ? val.toFixed(decimals) : (0).toFixed(decimals);
}

export interface AgentTelemetryPanelProps {
  isDockedRight?: boolean;
}

export const AgentTelemetryPanel: React.FC<AgentTelemetryPanelProps> = ({ isDockedRight = false }) => {
  const telemetryEvents = useMarketStore((s) => s.telemetryEvents);
  const setTelemetryEvents = useMarketStore((s) => s.setTelemetryEvents);
  const wsStatus = useMarketStore((s) => s.wsStatus);

  const isBottomExpanded = useUiStore((s) => s.isBottomExpanded);
  const toggleBottomExpanded = useUiStore((s) => s.toggleBottomExpanded);
  const setRightRailTab = useUiStore((s) => s.setRightRailTab);
  const setActiveBottomTab = useUiStore((s) => s.setActiveBottomTab);

  const [isLoading, setIsLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [expandedRowKey, setExpandedRowKey] = useState<string | null>(null);
  const [sideFilter, setSideFilter] = useState<'ALL' | 'BUY' | 'SELL'>('ALL');
  const [auditSummary, setAuditSummary] = useState<any>(null);
  const [auditExportStatus, setAuditExportStatus] = useState<'idle' | 'exporting' | 'success' | 'error'>('idle');

  const fetchTelemetry = useCallback(async () => {
    setIsLoading(true);
    setErrorMsg(null);
    try {
      const resp = await apiClient.getDailyAudit('current');
      setTelemetryEvents(resp?.factor_telemetry_events ?? []);
      if (resp?.summary) {
        setAuditSummary(resp.summary);
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setErrorMsg(msg || 'Failed to fetch telemetry events');
    } finally {
      setIsLoading(false);
    }
  }, [setTelemetryEvents]);

  const handleExportAudit = async () => {
    if (auditExportStatus === 'exporting') return;
    setAuditExportStatus('exporting');
    try {
      await apiClient.downloadDailyAudit('markdown');
      setAuditExportStatus('success');
      setTimeout(() => setAuditExportStatus('idle'), 3000);
    } catch {
      setAuditExportStatus('error');
      setTimeout(() => setAuditExportStatus('idle'), 4000);
    }
  };

  // Bootstrap once on mount; real-time updates stream via FACTOR_TELEMETRY WebSocket frames
  useEffect(() => {
    fetchTelemetry();
  }, [fetchTelemetry]);

  const filteredEvents = telemetryEvents.filter((ev) => {
    if (sideFilter === 'ALL') return true;
    return ev.consensusSide === sideFilter;
  });

  const toggleRow = (key: string) => {
    setExpandedRowKey((prev) => (prev === key ? null : key));
  };

  const isWsLive = wsStatus !== 'DISCONNECTED';

  return (
    <div className="flex flex-col h-full bg-[#080c14] border border-[#151d2c] rounded-lg p-3 font-mono text-xs select-none">
      {/* 1. Header Bar */}
      <div className="flex flex-wrap items-center justify-between pb-2 mb-2 border-b border-[#151d2c] gap-2">
        <div className="flex items-center space-x-2">
          <Activity className="w-4 h-4 text-[#00bcd4]" />
          <span className="font-bold text-[#e6edf3]">Agent Loqları & Canlı Düşüncə Telemetriyası</span>
          <span className="px-2 py-0.5 rounded text-[10px] bg-[#00bcd4]/10 text-[#00bcd4] border border-[#00bcd4]/30 font-bold">
            {filteredEvents.length} Hadisə
          </span>
        </div>

        <div className="flex items-center space-x-2">
          {/* Side Filter */}
          <div className="flex items-center bg-[#020305] border border-[#151d2c] rounded p-0.5 text-[10px]">
            <button
              onClick={() => setSideFilter('ALL')}
              className={`px-2 py-0.5 rounded transition-colors ${
                sideFilter === 'ALL' ? 'bg-[#151d2c] text-[#e6edf3] font-bold' : 'text-[#7d8590]'
              }`}
            >
              Hamısı
            </button>
            <button
              onClick={() => setSideFilter('SELL')}
              className={`px-2 py-0.5 rounded transition-colors ${
                sideFilter === 'SELL' ? 'bg-[#f6465d]/20 text-[#f6465d] font-bold' : 'text-[#7d8590]'
              }`}
            >
              SELL
            </button>
            <button
              onClick={() => setSideFilter('BUY')}
              className={`px-2 py-0.5 rounded transition-colors ${
                sideFilter === 'BUY' ? 'bg-[#0ecb81]/20 text-[#0ecb81] font-bold' : 'text-[#7d8590]'
              }`}
            >
              BUY
            </button>
          </div>

          {/* Live WebSocket Stream Indicator */}
          <span
            data-testid="ws-live-indicator"
            className={`flex items-center space-x-1 px-2 py-1 rounded text-[10px] border ${
              isWsLive
                ? 'bg-[#0ecb81]/10 text-[#0ecb81] border-[#0ecb81]/30'
                : 'bg-[#f6465d]/10 text-[#f6465d] border-[#f6465d]/30'
            }`}
            title={`WebSocket status: ${wsStatus}`}
          >
            <Radio className={`w-3 h-3 ${isWsLive ? 'animate-pulse text-[#0ecb81]' : 'text-[#f6465d]'}`} />
            <span>{isWsLive ? 'WS Canlı' : 'WS Kəsildi'}</span>
          </span>

          {/* Manual Refresh Button */}
          <button
            data-testid="telemetry-refresh-btn"
            onClick={fetchTelemetry}
            disabled={isLoading}
            className="flex items-center space-x-1 px-2.5 py-1 rounded bg-[#151d2c] text-[#7d8590] hover:text-[#e6edf3] transition-colors"
          >
            <RefreshCw className={`w-3 h-3 ${isLoading ? 'animate-spin' : ''}`} />
            <span>Yenilə</span>
          </button>

          {/* Merged Daily Audit Export */}
          <button
            data-testid="audit-export-btn"
            onClick={handleExportAudit}
            disabled={auditExportStatus === 'exporting'}
            className="flex items-center space-x-1 px-2.5 py-1 rounded bg-[#020305] border border-[#151d2c] text-[#7d8590] hover:text-[#00f2fe] hover:border-[#00f2fe]/40 transition-colors disabled:opacity-50"
            title="Gündəlik Decision Audit hesabatını (.md) yüklə"
          >
            <FileText className="w-3 h-3 text-[#00f2fe]" />
            <span>
              {auditExportStatus === 'exporting'
                ? 'Yüklənir...'
                : auditExportStatus === 'success'
                ? 'Yükləndi!'
                : auditExportStatus === 'error'
                ? 'Xəta'
                : 'Audit Yüklə'}
            </span>
          </button>

          {/* Docking & Expand Controls */}
          {isDockedRight ? (
            <button
              onClick={() => {
                setRightRailTab('ORDER_TICKET');
                setActiveBottomTab('TELEMETRY');
              }}
              className="flex items-center space-x-1 px-2.5 py-1 rounded bg-[#2962ff]/20 text-[#2962ff] border border-[#2962ff]/30 hover:bg-[#2962ff]/30 transition-colors"
              title="Aşağı panelə keçir"
            >
              <ArrowDownCircle className="w-3.5 h-3.5" />
              <span>Aşağı Keçir</span>
            </button>
          ) : (
            <div className="flex items-center space-x-1 pl-1 border-l border-[#151d2c]">
              <button
                onClick={toggleBottomExpanded}
                className={`flex items-center space-x-1 px-2 py-1 rounded transition-colors border ${
                  isBottomExpanded
                    ? 'bg-[#f0b90b]/20 text-[#f0b90b] border-[#f0b90b]/40'
                    : 'bg-[#151d2c] text-[#7d8590] border-[#151d2c] hover:text-[#e6edf3]'
                }`}
                title={isBottomExpanded ? 'Normal ölçüyə qaytar' : 'Qrafiki kiçildib pəncərəni böyüt'}
              >
                {isBottomExpanded ? <Minimize2 className="w-3.5 h-3.5" /> : <Maximize2 className="w-3.5 h-3.5" />}
                <span>{isBottomExpanded ? 'Kiçilt' : 'Böyüt'}</span>
              </button>

              <button
                onClick={() => {
                  setRightRailTab('TELEMETRY');
                  setActiveBottomTab('POSITION');
                }}
                className="flex items-center space-x-1 px-2 py-1 rounded bg-[#00bcd4]/10 text-[#00bcd4] border border-[#00bcd4]/30 hover:bg-[#00bcd4]/20 transition-colors"
                title="Sağ sütuna keçir (bütöv hündürlükdə bax)"
              >
                <ArrowRightCircle className="w-3.5 h-3.5" />
                <span>Sağa Keçir</span>
              </button>
            </div>
          )}
        </div>
      </div>

      {auditSummary && (
        <div className="mb-2 px-2 py-1 rounded bg-[#020305] border border-[#151d2c] text-[10px] text-[#7d8590] flex flex-wrap items-center gap-x-3 gap-y-1">
          <span>
            Bloklanan Siqnal: <strong className="text-[#e6edf3]">{auditSummary.blocked_setups ?? 0}</strong>
          </span>
          <span>
            Xilas Edilən: <strong className="text-[#0ecb81]">+${(auditSummary.capital_saved_usd ?? 0).toFixed(2)}</strong>
          </span>
          <span>
            Qaçan Qazanc: <strong className="text-[#f0b90b]">${(auditSummary.missed_profit_usd ?? 0).toFixed(2)}</strong>
          </span>
          <span>
            Maker Qənaəti: <strong className="text-[#00f2fe]">+${(auditSummary.maker_fee_savings_usd ?? 0).toFixed(2)}</strong>
          </span>
        </div>
      )}

      {errorMsg && (
        <div className="mb-2 p-1.5 rounded bg-[#f6465d]/10 border border-[#f6465d]/30 text-[#f6465d] text-[11px] flex items-center space-x-1.5">
          <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0" />
          <span>{errorMsg}</span>
        </div>
      )}

      {/* 2. Orthogonal Quant Telemetry Event Stream */}
      <div className="flex-1 overflow-y-auto space-y-1.5 custom-scrollbar pr-1">
        {filteredEvents.length === 0 ? (
          <div className="h-full flex flex-col items-center justify-center text-[#7d8590] py-8">
            <Radio className="w-8 h-8 mb-2 opacity-40 text-[#00bcd4]" />
            <p>Hələ ki heç bir ortoqonal faktor telemetriyası qeydə alınmayıb.</p>
            <p className="text-[10px] mt-1 text-[#7d8590]/70">WebSocket axını arxa fonda gözləyir...</p>
          </div>
        ) : (
          filteredEvents.map((ev, idx) => {
            const rowKey = getEventRowKey(ev, idx);
            const isExpanded = expandedRowKey === rowKey;
            const timeStr = new Date(ev.timestamp).toLocaleTimeString();
            const isSell = ev.consensusSide === 'SELL';
            const isBuy = ev.consensusSide === 'BUY';
            const archetypeLabel = formatConvictionArchetype(ev.convictionArchetype);

            const independentFactors: FactorStateDetail[] = (ev.activeFactors || []).filter(
              (f) => !f.isCollinear
            );
            const flaggedCollinear = (ev.activeFactors || [])
              .filter((f) => f.isCollinear)
              .map((f) => f.name);
            const collinearList = Array.from(
              new Set([...(ev.collinearFactors || []), ...flaggedCollinear])
            );

            const sideBadge = (
              <span
                className={`px-1.5 py-0.5 rounded text-[10px] font-bold flex items-center space-x-1 ${
                  isSell
                    ? 'bg-[#f6465d]/20 text-[#f6465d] border border-[#f6465d]/40'
                    : isBuy
                    ? 'bg-[#0ecb81]/20 text-[#0ecb81] border border-[#0ecb81]/40'
                    : 'bg-[#151d2c] text-[#7d8590]'
                }`}
              >
                {isSell && <TrendingDown className="w-3 h-3" />}
                {isBuy && <TrendingUp className="w-3 h-3" />}
                <span>{ev.consensusSide}</span>
              </span>
            );

            const convictionBadge = (
              <span
                className={`px-1.5 py-0.5 rounded border text-[10px] font-semibold ${getConvictionScoreClass(
                  ev.compositeScore
                )}`}
              >
                Orthogonal Quant Conviction · Score: {ev.compositeScore}% ({archetypeLabel})
              </span>
            );

            const noiseBadge = (
              <span
                className={`px-1.5 py-0.5 rounded border text-[10px] font-bold ${
                  ev.noiseBandActive
                    ? 'bg-[#2962ff]/15 text-[#2962ff] border-[#2962ff]/40'
                    : 'bg-[#0ecb81]/10 text-[#0ecb81] border-[#0ecb81]/30'
                }`}
              >
                Noise Band: {ev.noiseBandActive ? 'ACTIVE' : 'CLEAR'}
              </span>
            );

            const macroVetoBadge = ev.macroVetoActive ? (
              <span
                className="px-1.5 py-0.5 rounded border bg-[#f6465d]/15 text-[#f6465d] border-[#f6465d]/40 text-[10px] font-bold flex items-center space-x-1"
                title={ev.macroVetoReason || 'Macro Veto Active'}
              >
                <ShieldAlert className="w-3 h-3" />
                <span>MACRO VETO</span>
              </span>
            ) : null;

            const chevronIcon = isExpanded ? (
              <ChevronDown className="w-3.5 h-3.5 text-[#7d8590]" />
            ) : (
              <ChevronRight className="w-3.5 h-3.5 text-[#7d8590]" />
            );

            return (
              <div
                key={rowKey}
                data-testid={`telemetry-row-${idx}`}
                aria-expanded={isExpanded}
                className="bg-[#020305] border border-[#151d2c] hover:border-[#1f293d] rounded p-2 transition-all cursor-pointer"
                onClick={() => toggleRow(rowKey)}
              >
                {/* Main Header Row */}
                {isDockedRight ? (
                  <div className="flex flex-col gap-1.5 text-[11px]">
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex items-center space-x-2 min-w-0">
                        <span className="text-[#7d8590] text-[10px] flex items-center space-x-1">
                          <Clock className="w-3 h-3 inline text-[#7d8590]" />
                          <span>{timeStr}</span>
                        </span>
                        <span className="font-bold text-[#e6edf3]">{ev.symbol}</span>
                        {sideBadge}
                      </div>
                      <div className="flex items-center space-x-1.5 flex-shrink-0">
                        <span className="text-[#e6edf3] font-mono text-[10px]">
                          ${fmtNum(ev.markPrice, 2)}
                        </span>
                        {chevronIcon}
                      </div>
                    </div>

                    <div className="flex flex-wrap items-center gap-1.5 text-[10px]">
                      {convictionBadge}
                      {noiseBadge}
                      {macroVetoBadge}
                      <span className="px-1.5 py-0.5 rounded bg-[#151d2c] text-[#7d8590] text-[9px]">
                        {ev.triggerType}
                      </span>
                    </div>
                  </div>
                ) : (
                  <div className="flex flex-wrap items-center justify-between text-[11px] gap-2">
                    <div className="flex flex-wrap items-center gap-2 min-w-0">
                      <span className="text-[#7d8590] text-[10px] flex items-center space-x-1">
                        <Clock className="w-3 h-3 inline text-[#7d8590]" />
                        <span>{timeStr}</span>
                      </span>
                      <span className="font-bold text-[#e6edf3]">{ev.symbol}</span>
                      {sideBadge}
                      <span className="text-[#7d8590] text-[10px]">
                        (Qiymət: <span className="text-[#e6edf3] font-mono">${fmtNum(ev.markPrice, 2)}</span>)
                      </span>
                      {convictionBadge}
                    </div>

                    <div className="flex flex-wrap items-center gap-1.5 text-[10px] flex-shrink-0">
                      {noiseBadge}
                      {macroVetoBadge}
                      <span className="px-1.5 py-0.5 rounded bg-[#151d2c] text-[#7d8590] font-semibold">
                        {ev.triggerType}
                      </span>
                      {chevronIcon}
                    </div>
                  </div>
                )}

                {/* Independent Orthogonal Factor Badges + Grouped Collinear Tag */}
                <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-[10px]">
                  {independentFactors.map((factor) => (
                    <span
                      key={factor.factorId}
                      data-testid={`factor-badge-${factor.factorId}`}
                      className={`px-1.5 py-0.5 rounded flex items-center space-x-1 ${getFactorBiasBadgeClass(
                        factor.bias
                      )}`}
                      title={factor.summaryText}
                    >
                      <span className="font-semibold">{factor.name}</span>
                      <span>
                        ({fmtNum((factor.effectiveWeight ?? 0) * 100, 1)}% wt, {factor.bias})
                      </span>
                    </span>
                  ))}

                  {collinearList.length > 0 && (
                    <span
                      data-testid="collinear-factors-tag"
                      className="px-1.5 py-0.5 rounded bg-[#151d2c]/60 border border-[#151d2c] text-[#7d8590] text-[10px]"
                    >
                      [COLLINEAR]: {collinearList.join(', ')}
                    </span>
                  )}
                </div>

                {/* 3. Expandable Accordion: Execution Chasing, Sizing & Per-Factor Alphas */}
                {isExpanded && (
                  <div
                    data-testid="telemetry-accordion"
                    onClick={(e) => e.stopPropagation()}
                    className="mt-2.5 pt-2 border-t border-[#151d2c] space-y-2 text-[10px] bg-[#080c14]/60 p-2 rounded cursor-default"
                  >
                    {ev.macroVetoActive && ev.macroVetoReason && (
                      <div className="p-1.5 rounded bg-[#f6465d]/10 border border-[#f6465d]/30 text-[#f6465d] flex items-center space-x-1.5">
                        <ShieldAlert className="w-3.5 h-3.5 flex-shrink-0" />
                        <span>Macro Veto: {ev.macroVetoReason}</span>
                      </div>
                    )}

                    <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                      {/* Maker Chasing Execution Telemetry */}
                      <div className="bg-[#020305] p-2 rounded border border-[#151d2c] space-y-1">
                        <div className="flex items-center justify-between font-bold text-[#e6edf3]">
                          <span className="flex items-center space-x-1">
                            <Zap className="w-3 h-3 text-[#f0b90b]" />
                            <span>Maker Chasing</span>
                          </span>
                          {ev.chasingTelemetry && (
                            <span className="px-1.5 py-0.2 rounded bg-[#f0b90b]/15 text-[#f0b90b] border border-[#f0b90b]/30 text-[9px]">
                              {ev.chasingTelemetry.status}
                            </span>
                          )}
                        </div>
                        {ev.chasingTelemetry ? (
                          <div className="grid grid-cols-2 gap-x-2 gap-y-0.5 text-[#7d8590] tabular-nums">
                            <div>
                              Anchor:{' '}
                              <span className="text-[#e6edf3]">
                                ${fmtNum(ev.chasingTelemetry.anchorMarkPrice, 2)}
                              </span>
                            </div>
                            <div>
                              Limit:{' '}
                              <span className="text-[#e6edf3]">
                                ${fmtNum(ev.chasingTelemetry.currentLimitPrice, 2)}
                              </span>
                            </div>
                            <div>
                              Amendments:{' '}
                              <span className="text-[#e6edf3]">
                                {ev.chasingTelemetry.amendmentCount}
                              </span>
                            </div>
                            <div>
                              Duration:{' '}
                              <span className="text-[#e6edf3]">
                                {ev.chasingTelemetry.durationMs}ms
                              </span>
                            </div>
                            <div>
                              Penny Jumps:{' '}
                              <span className="text-[#e6edf3]">
                                {ev.chasingTelemetry.spreadPennyJumps}
                              </span>
                            </div>
                            <div>
                              Fee Saved:{' '}
                              <span className="text-[#0ecb81] font-semibold">
                                ${fmtNum(ev.chasingTelemetry.feeSavedVsTakerUsd, 2)}
                              </span>
                            </div>
                          </div>
                        ) : (
                          <div className="text-[#7d8590]">No chasing execution telemetry attached.</div>
                        )}
                      </div>

                      {/* Dynamic Sizing Telemetry */}
                      <div className="bg-[#020305] p-2 rounded border border-[#151d2c] space-y-1">
                        <div className="flex items-center justify-between font-bold text-[#e6edf3]">
                          <span className="flex items-center space-x-1">
                            <Sliders className="w-3 h-3 text-[#0ecb81]" />
                            <span>Dynamic Sizing</span>
                          </span>
                          {ev.sizingTelemetry && (
                            <span
                              className={`px-1.5 py-0.2 rounded border text-[9px] ${
                                ev.sizingTelemetry.solvencyAirbagOk
                                  ? 'bg-[#0ecb81]/10 text-[#0ecb81] border-[#0ecb81]/30'
                                  : 'bg-[#f6465d]/10 text-[#f6465d] border-[#f6465d]/30'
                              }`}
                            >
                              Airbag: {ev.sizingTelemetry.solvencyAirbagOk ? 'SECURE' : 'VIOLATION'}
                            </span>
                          )}
                        </div>
                        {ev.sizingTelemetry ? (
                          <div className="grid grid-cols-2 gap-x-2 gap-y-0.5 text-[#7d8590] tabular-nums">
                            <div>
                              Margin:{' '}
                              <span className="text-[#e6edf3]">
                                ${fmtNum(ev.sizingTelemetry.allocatedMarginUsd, 2)} (
                                {fmtNum(ev.sizingTelemetry.allocatedMarginPct, 1)}%)
                              </span>
                            </div>
                            <div>
                              Kelly:{' '}
                              <span className="text-[#e6edf3]">
                                {fmtNum(ev.sizingTelemetry.quarterKellyMultiplier, 2)}x
                              </span>
                            </div>
                            <div>
                              Vol Parity:{' '}
                              <span className="text-[#e6edf3]">
                                {fmtNum(ev.sizingTelemetry.volatilityParityMultiplier, 2)}x
                              </span>
                            </div>
                            <div>
                              Circuit:{' '}
                              <span className="text-[#e6edf3]">
                                {fmtNum(ev.sizingTelemetry.circuitBreakerMultiplier, 2)}x
                              </span>
                            </div>
                          </div>
                        ) : (
                          <div className="text-[#7d8590]">No sizing telemetry attached.</div>
                        )}
                      </div>
                    </div>

                    {/* Per-Factor Raw & Orthogonal Alpha Diagnostics */}
                    <div className="space-y-1">
                      <div className="flex items-center space-x-1 font-bold text-[#e6edf3]">
                        <Cpu className="w-3 h-3 text-[#2962ff]" />
                        <span>Orthogonal Factor Alpha Vectors</span>
                      </div>
                      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-1.5">
                        {(ev.activeFactors || []).map((f) => (
                          <div
                            key={f.factorId}
                            className="bg-[#020305] p-1.5 rounded border border-[#151d2c] space-y-0.5"
                          >
                            <div className="flex items-center justify-between">
                              <span className="font-bold text-[#e6edf3]">{f.name}</span>
                              <span
                                className={`px-1 rounded text-[9px] ${getFactorBiasBadgeClass(
                                  f.bias
                                )}`}
                              >
                                {f.bias}
                              </span>
                            </div>
                            <div className="text-[#7d8590] tabular-nums">
                              Raw: <span className="text-[#e6edf3]">{fmtNum(f.rawAlpha, 3)}</span> ·
                              Ortho:{' '}
                              <span className="text-[#e6edf3]">{fmtNum(f.orthogonalAlpha, 3)}</span>{' '}
                              · Wt:{' '}
                              <span className="text-[#00bcd4]">
                                {fmtNum((f.effectiveWeight ?? 0) * 100, 1)}%
                              </span>
                            </div>
                            {f.summaryText && (
                              <div className="text-[#e6edf3]/80 text-[9px]">{f.summaryText}</div>
                            )}
                          </div>
                        ))}
                      </div>
                    </div>
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
};
