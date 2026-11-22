import React, { useState, useEffect, useCallback } from 'react';
import { apiClient } from '../lib/apiClient';
import type { PillarTelemetryRecord, DailyAuditResponse } from '@tradeos/shared';
import { useUiStore } from '../store/useUiStore';
import {
  Activity,
  RefreshCw,
  Search,
  Filter,
  ChevronDown,
  ChevronRight,
  TrendingDown,
  TrendingUp,
  AlertTriangle,
  Radio,
  Clock,
  Layers,
  Maximize2,
  Minimize2,
  ArrowRightCircle,
  ArrowDownCircle,
} from 'lucide-react';

interface PillarJsonDetail {
  state?: string;
  bias?: string;
  score?: number;
  confirmed?: boolean;
  rawText?: string;
}

function parsePillarDetail(jsonStr?: string): PillarJsonDetail | null {
  if (!jsonStr) return null;
  try {
    return JSON.parse(jsonStr) as PillarJsonDetail;
  } catch {
    return { rawText: jsonStr };
  }
}

export interface AgentTelemetryPanelProps {
  isDockedRight?: boolean;
}

export const AgentTelemetryPanel: React.FC<AgentTelemetryPanelProps> = ({ isDockedRight = false }) => {
  const isBottomExpanded = useUiStore((s) => s.isBottomExpanded);
  const toggleBottomExpanded = useUiStore((s) => s.toggleBottomExpanded);
  const setRightRailTab = useUiStore((s) => s.setRightRailTab);
  const setActiveBottomTab = useUiStore((s) => s.setActiveBottomTab);

  const [data, setData] = useState<DailyAuditResponse | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [expandedRow, setExpandedRow] = useState<number | null>(null);
  const [sideFilter, setSideFilter] = useState<'ALL' | 'BUY' | 'SELL'>('ALL');
  const [autoRefresh, setAutoRefresh] = useState(true);

  const fetchTelemetry = useCallback(async () => {
    setIsLoading(true);
    setErrorMsg(null);
    try {
      const resp = await apiClient.getDailyAudit('current');
      setData(resp);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setErrorMsg(msg || 'Failed to fetch telemetry events');
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchTelemetry();
  }, [fetchTelemetry]);

  // Auto-refresh timer every 5 seconds
  useEffect(() => {
    if (!autoRefresh) return;
    const interval = setInterval(() => {
      fetchTelemetry();
    }, 5000);
    return () => clearInterval(interval);
  }, [autoRefresh, fetchTelemetry]);

  const impulses: PillarTelemetryRecord[] = (data?.sub_threshold_impulses || [])
    .slice()
    .reverse();

  const filteredImpulses = impulses.filter((imp) => {
    if (sideFilter === 'ALL') return true;
    return imp.consensus_side === sideFilter;
  });

  const toggleRow = (id?: number) => {
    if (!id) return;
    setExpandedRow((prev) => (prev === id ? null : id));
  };

  return (
    <div className="flex flex-col h-full bg-[#080c14] border border-[#151d2c] rounded-lg p-3 font-mono text-xs select-none">
      {/* 1. Header Bar */}
      <div className="flex flex-wrap items-center justify-between pb-2 mb-2 border-b border-[#151d2c] gap-2">
        <div className="flex items-center space-x-2">
          <Activity className="w-4 h-4 text-[#00bcd4]" />
          <span className="font-bold text-[#e6edf3]">Agent Loqları & Canlı Düşüncə Telemetriyası</span>
          <span className="px-2 py-0.5 rounded text-[10px] bg-[#00bcd4]/10 text-[#00bcd4] border border-[#00bcd4]/30 font-bold">
            {impulses.length} Hadisə
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

          {/* Auto Refresh Toggle */}
          <button
            onClick={() => setAutoRefresh(!autoRefresh)}
            className={`flex items-center space-x-1 px-2 py-1 rounded text-[10px] border transition-colors ${
              autoRefresh
                ? 'bg-[#0ecb81]/10 text-[#0ecb81] border-[#0ecb81]/30'
                : 'bg-[#151d2c] text-[#7d8590] border-[#151d2c]'
            }`}
            title="Avtomatik yenilənmə (hər 5 san)"
          >
            <Radio className={`w-3 h-3 ${autoRefresh ? 'animate-pulse text-[#0ecb81]' : ''}`} />
            <span>{autoRefresh ? 'Canlı (5s)' : 'Pauzada'}</span>
          </button>

          {/* Manual Refresh Button */}
          <button
            onClick={fetchTelemetry}
            disabled={isLoading}
            className="flex items-center space-x-1 px-2.5 py-1 rounded bg-[#151d2c] text-[#7d8590] hover:text-[#e6edf3] transition-colors"
          >
            <RefreshCw className={`w-3 h-3 ${isLoading ? 'animate-spin' : ''}`} />
            <span>Yenilə</span>
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

      {errorMsg && (
        <div className="mb-2 p-1.5 rounded bg-[#f6465d]/10 border border-[#f6465d]/30 text-[#f6465d] text-[11px] flex items-center space-x-1.5">
          <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0" />
          <span>{errorMsg}</span>
        </div>
      )}

      {/* 2. Telemetry Event Stream */}
      <div className="flex-1 overflow-y-auto space-y-1.5 custom-scrollbar pr-1">
        {filteredImpulses.length === 0 ? (
          <div className="h-full flex flex-col items-center justify-center text-[#7d8590] py-8">
            <Radio className="w-8 h-8 mb-2 opacity-40 text-[#00bcd4]" />
            <p>Hələ ki heç bir bazar impulsu qeydə alınmayıb.</p>
            <p className="text-[10px] mt-1 text-[#7d8590]/70">Bazar təhlili arxa fonda davam edir...</p>
          </div>
        ) : (
          filteredImpulses.map((imp) => {
            const isExpanded = expandedRow === imp.id;
            const timeStr = new Date(imp.timestamp).toLocaleTimeString();
            const isSell = imp.consensus_side === 'SELL';
            const isBuy = imp.consensus_side === 'BUY';

            const p1 = parsePillarDetail(imp.p1_macro_regime);
            const p6 = parsePillarDetail(imp.p6_momentum_rvol);
            const p7 = parsePillarDetail(imp.p7_sentiment_macro);

            return (
              <div
                key={imp.id ?? `${imp.timestamp}-${imp.mark_price}`}
                className="bg-[#020305] border border-[#151d2c] hover:border-[#1f293d] rounded p-2 transition-all cursor-pointer"
                onClick={() => toggleRow(imp.id)}
              >
                {/* Main Row Summary */}
                <div className="flex items-center justify-between text-[11px] gap-2">
                  <div className="flex items-center space-x-2 min-w-0">
                    <span className="text-[#7d8590] text-[10px] flex items-center space-x-1">
                      <Clock className="w-3 h-3 inline text-[#7d8590]" />
                      <span>{timeStr}</span>
                    </span>

                    <span className="font-bold text-[#e6edf3]">{imp.symbol}</span>

                    {/* Consensus Side Badge */}
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
                      <span>{imp.consensus_side}</span>
                    </span>

                    {/* Composite Score */}
                    <span className="text-[#f0b90b] font-semibold">{imp.composite_score}%</span>

                    <span className="text-[#7d8590] text-[10px]">
                      (Qiymət: <span className="text-[#e6edf3]">${imp.mark_price.toFixed(2)}</span>)
                    </span>
                  </div>

                  <div className="flex items-center space-x-2 text-[10px] flex-shrink-0">
                    {/* Active Pillar Badges */}
                    <span className="px-1.5 py-0.5 rounded bg-[#151d2c] text-[#7d8590]">
                      {imp.active_pillars_count}/7 Aktiv
                    </span>

                    <span
                      className={`px-1.5 py-0.5 rounded font-bold ${
                        imp.status === 'SETTLED'
                          ? 'bg-[#2962ff]/20 text-[#2962ff]'
                          : 'bg-[#f0b90b]/20 text-[#f0b90b]'
                      }`}
                    >
                      {imp.status}
                    </span>

                    {isExpanded ? (
                      <ChevronDown className="w-3.5 h-3.5 text-[#7d8590]" />
                    ) : (
                      <ChevronRight className="w-3.5 h-3.5 text-[#7d8590]" />
                    )}
                  </div>
                </div>

                {/* Quick Teaser of Key Drivers (Sentiment / Momentum) */}
                <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-[10px]">
                  {p7?.state && (
                    <span className="px-1.5 py-0.5 rounded bg-[#f6465d]/10 border border-[#f6465d]/20 text-[#f6465d]">
                      P7 (Xəbər): {p7.state}
                    </span>
                  )}
                  {p6?.state && (
                    <span className="px-1.5 py-0.5 rounded bg-[#2962ff]/10 border border-[#2962ff]/20 text-[#2962ff]">
                      P6 (Momentum): {p6.state}
                    </span>
                  )}
                  {p1?.state && (
                    <span className="px-1.5 py-0.5 rounded bg-[#151d2c] text-[#7d8590]">
                      P1 (Makro): {p1.state}
                    </span>
                  )}
                </div>

                {/* 3. Expanded Full Diagnosis of All 7 Pillars */}
                {isExpanded && (
                  <div className="mt-2.5 pt-2 border-t border-[#151d2c] grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-1.5 text-[10px] bg-[#080c14]/60 p-2 rounded">
                    {/* P1 Macro */}
                    <div className="bg-[#020305] p-1.5 rounded border border-[#151d2c]">
                      <div className="font-bold text-[#7d8590] mb-0.5">P1: Macro Regime (25%)</div>
                      <div className="text-[#e6edf3]">{p1?.state || imp.p1_vote}</div>
                      {p1?.rawText && <div className="text-[#7d8590] text-[9px] mt-0.5">{p1.rawText}</div>}
                    </div>

                    {/* P2 SMC */}
                    <div className="bg-[#020305] p-1.5 rounded border border-[#151d2c]">
                      <div className="font-bold text-[#7d8590] mb-0.5">P2: Native SMC (25%)</div>
                      <div className="text-[#e6edf3]">{parsePillarDetail(imp.p2_native_smc)?.state || imp.p2_vote}</div>
                      {parsePillarDetail(imp.p2_native_smc)?.rawText && (
                        <div className="text-[#7d8590] text-[9px] mt-0.5">
                          {parsePillarDetail(imp.p2_native_smc)?.rawText}
                        </div>
                      )}
                    </div>

                    {/* P3 CVD */}
                    <div className="bg-[#020305] p-1.5 rounded border border-[#151d2c]">
                      <div className="font-bold text-[#7d8590] mb-0.5">P3: CVD Absorption (20%)</div>
                      <div className="text-[#e6edf3]">
                        {parsePillarDetail(imp.p3_cvd_absorption)?.state || imp.p3_vote}
                      </div>
                      {parsePillarDetail(imp.p3_cvd_absorption)?.rawText && (
                        <div className="text-[#7d8590] text-[9px] mt-0.5">
                          {parsePillarDetail(imp.p3_cvd_absorption)?.rawText}
                        </div>
                      )}
                    </div>

                    {/* P4 Order Flow */}
                    <div className="bg-[#020305] p-1.5 rounded border border-[#151d2c]">
                      <div className="font-bold text-[#7d8590] mb-0.5">P4: Order Flow L2 (15%)</div>
                      <div className="text-[#e6edf3]">
                        {parsePillarDetail(imp.p4_order_flow_l2)?.state || imp.p4_vote}
                      </div>
                      {parsePillarDetail(imp.p4_order_flow_l2)?.rawText && (
                        <div className="text-[#7d8590] text-[9px] mt-0.5">
                          {parsePillarDetail(imp.p4_order_flow_l2)?.rawText}
                        </div>
                      )}
                    </div>

                    {/* P5 Liq Clusters */}
                    <div className="bg-[#020305] p-1.5 rounded border border-[#151d2c]">
                      <div className="font-bold text-[#7d8590] mb-0.5">P5: Liq Clusters (7.5%)</div>
                      <div className="text-[#e6edf3]">
                        {parsePillarDetail(imp.p5_liq_clusters)?.state || imp.p5_vote}
                      </div>
                      {parsePillarDetail(imp.p5_liq_clusters)?.rawText && (
                        <div className="text-[#7d8590] text-[9px] mt-0.5">
                          {parsePillarDetail(imp.p5_liq_clusters)?.rawText}
                        </div>
                      )}
                    </div>

                    {/* P6 Momentum */}
                    <div className="bg-[#020305] p-1.5 rounded border border-[#151d2c]">
                      <div className="font-bold text-[#7d8590] mb-0.5">P6: Momentum & rVol (5%)</div>
                      <div className="text-[#2962ff] font-semibold">{p6?.state || imp.p6_vote}</div>
                      {p6?.rawText && <div className="text-[#7d8590] text-[9px] mt-0.5">{p6.rawText}</div>}
                    </div>

                    {/* P7 Sentiment */}
                    <div className="bg-[#020305] p-1.5 rounded border border-[#151d2c] col-span-1 sm:col-span-2 md:col-span-3">
                      <div className="font-bold text-[#7d8590] mb-0.5">P7: Macro Sentiment (2.5%)</div>
                      <div className="text-[#f6465d] font-semibold">{p7?.state || imp.p7_vote}</div>
                      {p7?.rawText && <div className="text-[#e6edf3]/80 text-[10px] mt-0.5">{p7.rawText}</div>}
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
