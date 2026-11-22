import React, { useState, useEffect, useCallback } from 'react';
import { useUiStore } from '../store/useUiStore';
import { useMarketStore } from '../store/useMarketStore';
import { apiClient } from '../lib/apiClient';
import type {
  TrajectoryHorizon,
  PillarScorecardItem,
  PillarAttributionResponse,
  ConfluencePillarId,
} from '@tradeos/shared';
import {
  X,
  RefreshCw,
  Layers,
  TrendingUp,
  TrendingDown,
  Minus,
  Info,
  Sliders,
  CheckCircle2,
  AlertCircle,
  HelpCircle,
} from 'lucide-react';

const HORIZONS: TrajectoryHorizon[] = ['1m', '5m', '15m', '60m'];

const BASELINE_PILLARS: Array<{ id: ConfluencePillarId; title: string; currentWeightPct: number }> = [
  { id: 'MACRO_REGIME', title: 'Macro Regime (ADX / Trend)', currentWeightPct: 25.0 },
  { id: 'NATIVE_SMC', title: 'Native SMC (FVG / OB / Sweeps)', currentWeightPct: 25.0 },
  { id: 'CVD_ABSORPTION', title: 'CVD Absorption (Delta Divergence)', currentWeightPct: 20.0 },
  { id: 'ORDER_FLOW_L2', title: 'Order Flow L2 (Bid/Ask Skew)', currentWeightPct: 15.0 },
  { id: 'LIQ_CLUSTERS', title: 'Liquidity Clusters (Pools)', currentWeightPct: 7.5 },
  { id: 'MOMENTUM_RVOL', title: 'Momentum & rVol (RSI / Volume)', currentWeightPct: 5.0 },
  { id: 'SENTIMENT_MACRO', title: 'Macro Sentiment (Funding & Sentiment)', currentWeightPct: 2.5 },
];

export const PillarScorecardModal: React.FC = () => {
  const isPillarScorecardModalOpen = useUiStore((s) => s.isPillarScorecardModalOpen);
  const setIsPillarScorecardModalOpen = useUiStore((s) => s.setIsPillarScorecardModalOpen);
  const currentSymbol = useMarketStore((s) => s.symbol);

  const [selectedHorizon, setSelectedHorizon] = useState<TrajectoryHorizon>('15m');
  const [data, setData] = useState<PillarAttributionResponse | null>(null);
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const fetchScorecard = useCallback(async () => {
    setIsLoading(true);
    setErrorMessage(null);
    try {
      const response = await apiClient.getPillarScorecard(currentSymbol, selectedHorizon);
      setData(response);
    } catch (err: any) {
      console.warn('Failed to load pillar scorecard:', err);
      setErrorMessage(err.message || 'Unable to fetch pillar matrix scorecard.');
    } finally {
      setIsLoading(false);
    }
  }, [currentSymbol, selectedHorizon]);

  useEffect(() => {
    if (isPillarScorecardModalOpen) {
      fetchScorecard();
    }
  }, [isPillarScorecardModalOpen, fetchScorecard]);

  if (!isPillarScorecardModalOpen) return null;

  // Build rows from API response or fall back to architectural baseline
  const rows: PillarScorecardItem[] =
    data && Array.isArray(data.scorecards) && data.scorecards.length > 0
      ? data.scorecards
      : BASELINE_PILLARS.map((p) => ({
          pillarId: p.id,
          title: p.title,
          currentWeightPct: p.currentWeightPct,
          recommendedWeightPct: p.currentWeightPct,
          weightDeltaPct: 0,
          totalActiveVotes: 0,
          truePositives: 0,
          falsePositives: 0,
          falseNegatives: 0,
          hitRatePct: 50.0,
          avgMfePct: 0,
          avgMaePct: 0,
        }));

  const sampleSize = data?.sampleSize ?? 0;
  const generatedAtStr = data?.generatedAt ? new Date(data.generatedAt).toLocaleTimeString() : 'Realtime';

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-4 font-mono select-none"
      data-testid="pillar-scorecard-modal"
    >
      <div className="relative w-full max-w-5xl bg-[#080c14] border border-[#151d2c] rounded-xl shadow-2xl p-6 text-xs flex flex-col max-h-[90vh] space-y-4">
        {/* Header */}
        <div className="flex items-start justify-between pb-3 border-b border-[#151d2c]">
          <div className="flex items-center space-x-3">
            <div className="w-8 h-8 rounded bg-[#00f2fe]/10 border border-[#00f2fe]/30 flex items-center justify-center text-[#00f2fe]">
              <Layers className="w-4 h-4" />
            </div>
            <div>
              <div className="flex items-center space-x-2">
                <h2 className="text-sm font-bold uppercase tracking-wider text-[#e6edf3]">
                  Bulldog Engine: Pillar Matrix Scorecard
                </h2>
                <span className="px-2 py-0.5 rounded text-[10px] bg-[#2962ff]/20 text-[#2962ff] font-bold border border-[#2962ff]/40">
                  {currentSymbol}
                </span>
              </div>
              <p className="text-[11px] text-[#7d8590] mt-0.5">
                Granular Quantitative Attribution, Sub-Threshold Impulse Tracking & Empirical Matrix Calibration
              </p>
            </div>
          </div>

          <div className="flex items-center space-x-2">
            {/* Horizon Selector */}
            <div className="flex items-center space-x-1 bg-[#020305] p-1 rounded border border-[#151d2c]">
              {HORIZONS.map((h) => (
                <button
                  key={h}
                  onClick={() => setSelectedHorizon(h)}
                  data-testid={`horizon-tab-${h}`}
                  className={`px-2.5 py-1 rounded text-[11px] font-semibold transition-colors ${
                    selectedHorizon === h
                      ? 'bg-[#2962ff] text-white shadow-sm'
                      : 'text-[#7d8590] hover:text-[#e6edf3]'
                  }`}
                >
                  {h}
                </button>
              ))}
            </div>

            {/* Refresh Button */}
            <button
              onClick={fetchScorecard}
              disabled={isLoading}
              data-testid="refresh-scorecard-btn"
              className="p-1.5 rounded bg-[#020305] border border-[#151d2c] text-[#7d8590] hover:text-[#e6edf3] hover:border-[#7d8590] transition-colors disabled:opacity-50"
              title="Refresh Scorecard Data"
            >
              <RefreshCw className={`w-4 h-4 ${isLoading ? 'animate-spin text-[#00f2fe]' : ''}`} />
            </button>

            {/* Close Button */}
            <button
              onClick={() => setIsPillarScorecardModalOpen(false)}
              data-testid="close-pillar-scorecard-modal"
              className="p-1.5 rounded bg-[#020305] border border-[#151d2c] text-[#7d8590] hover:text-[#e6edf3] hover:border-[#7d8590] transition-colors"
              title="Close Modal"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Quick Diagnostic Ribbon */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-[11px]">
          <div className="bg-[#020305] p-2.5 rounded border border-[#151d2c]">
            <span className="text-[10px] text-[#7d8590] uppercase block">Sample Size (Impulses)</span>
            <span className="text-[#e6edf3] font-bold text-sm">{sampleSize} recorded</span>
          </div>

          <div className="bg-[#020305] p-2.5 rounded border border-[#151d2c]">
            <span className="text-[10px] text-[#7d8590] uppercase block">Forward Evaluation Horizon</span>
            <span className="text-[#00f2fe] font-bold text-sm">{selectedHorizon} Path Settled</span>
          </div>

          <div className="bg-[#020305] p-2.5 rounded border border-[#151d2c]">
            <span className="text-[10px] text-[#7d8590] uppercase block">Regularization Shrinkage</span>
            <span className="text-[#0ecb81] font-bold text-sm">Bayesian (N ≥ 30)</span>
          </div>

          <div className="bg-[#020305] p-2.5 rounded border border-[#151d2c]">
            <span className="text-[10px] text-[#7d8590] uppercase block">Weight Clamps & Max Shift</span>
            <span className="text-amber-400 font-bold text-sm">[2.5%, 35%] | ±5.0%</span>
          </div>
        </div>

        {/* Error Notification */}
        {errorMessage && (
          <div className="flex items-center space-x-2 bg-[#f6465d]/10 border border-[#f6465d]/30 text-[#f6465d] p-2.5 rounded text-[11px]">
            <AlertCircle className="w-4 h-4 flex-shrink-0" />
            <span>{errorMessage}</span>
          </div>
        )}

        {/* Scorecard Table */}
        <div className="flex-1 overflow-y-auto border border-[#151d2c] rounded-lg bg-[#020305]">
          <table className="w-full text-left border-collapse">
            <thead className="bg-[#0b121e] text-[#7d8590] text-[10px] uppercase tracking-wider sticky top-0 border-b border-[#151d2c] z-10">
              <tr>
                <th className="py-2.5 px-3">Pillar Indicator</th>
                <th className="py-2.5 px-3 text-right">Signals</th>
                <th className="py-2.5 px-3 text-center">TP / FP / FN</th>
                <th className="py-2.5 px-3 text-right">Hit Rate %</th>
                <th className="py-2.5 px-3 text-right">Avg MFE %</th>
                <th className="py-2.5 px-3 text-right">Avg MAE %</th>
                <th className="py-2.5 px-3 text-right">Current Wt</th>
                <th className="py-2.5 px-3 text-right">Suggested Wt</th>
                <th className="py-2.5 px-3 text-right">Delta Shift</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[#151d2c] text-[11px]">
              {rows.map((row) => {
                const delta = row.weightDeltaPct;
                const isPositiveDelta = delta > 0.05;
                const isNegativeDelta = delta < -0.05;

                const hitRateColor =
                  row.hitRatePct >= 60
                    ? 'text-[#0ecb81]'
                    : row.hitRatePct >= 50
                    ? 'text-[#00f2fe]'
                    : 'text-[#f6465d]';

                return (
                  <tr
                    key={row.pillarId}
                    data-testid={`pillar-row-${row.pillarId}`}
                    className="hover:bg-[#080c14] transition-colors"
                  >
                    <td className="py-2.5 px-3">
                      <div className="font-semibold text-[#e6edf3]">{row.title}</div>
                      <div className="text-[10px] text-[#7d8590] font-mono">{row.pillarId}</div>
                    </td>

                    <td className="py-2.5 px-3 text-right font-mono tabular-nums text-[#e6edf3]">
                      {row.totalActiveVotes}
                    </td>

                    <td className="py-2.5 px-3 text-center font-mono tabular-nums">
                      <span className="text-[#0ecb81] font-semibold">{row.truePositives}</span>
                      <span className="text-[#7d8590] mx-1">/</span>
                      <span className="text-[#f6465d] font-semibold">{row.falsePositives}</span>
                      <span className="text-[#7d8590] mx-1">/</span>
                      <span className="text-amber-400 font-semibold">{row.falseNegatives}</span>
                    </td>

                    <td className={`py-2.5 px-3 text-right font-mono tabular-nums font-bold ${hitRateColor}`}>
                      {row.hitRatePct.toFixed(1)}%
                    </td>

                    <td className="py-2.5 px-3 text-right font-mono tabular-nums text-[#0ecb81]">
                      +{row.avgMfePct.toFixed(2)}%
                    </td>

                    <td className="py-2.5 px-3 text-right font-mono tabular-nums text-[#f6465d]">
                      -{row.avgMaePct.toFixed(2)}%
                    </td>

                    <td className="py-2.5 px-3 text-right font-mono tabular-nums text-[#7d8590]">
                      {row.currentWeightPct.toFixed(1)}%
                    </td>

                    <td className="py-2.5 px-3 text-right font-mono tabular-nums font-bold text-[#e6edf3]">
                      {row.recommendedWeightPct.toFixed(1)}%
                    </td>

                    <td className="py-2.5 px-3 text-right font-mono tabular-nums">
                      <span
                        className={`inline-flex items-center space-x-1 px-1.5 py-0.5 rounded font-semibold text-[10px] ${
                          isPositiveDelta
                            ? 'bg-[#0ecb81]/15 text-[#0ecb81] border border-[#0ecb81]/30'
                            : isNegativeDelta
                            ? 'bg-[#f6465d]/15 text-[#f6465d] border border-[#f6465d]/30'
                            : 'bg-[#151d2c] text-[#7d8590]'
                        }`}
                      >
                        {isPositiveDelta ? (
                          <TrendingUp className="w-3 h-3" />
                        ) : isNegativeDelta ? (
                          <TrendingDown className="w-3 h-3" />
                        ) : (
                          <Minus className="w-3 h-3" />
                        )}
                        <span>
                          {delta > 0 ? '+' : ''}
                          {delta.toFixed(1)}%
                        </span>
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {/* Historical Breakdown & Methodology Footer */}
        <div className="bg-[#020305] p-3 rounded-lg border border-[#151d2c] flex flex-col sm:flex-row items-start sm:items-center justify-between text-[11px] text-[#7d8590] gap-2">
          <div className="flex items-center space-x-2">
            <Info className="w-4 h-4 text-[#00f2fe] flex-shrink-0" />
            <span>
              <strong>Empirical Calibration:</strong> Weights regularize toward architectural baseline via Bayesian
              shrinkage factor λ = min(0.50, N / 100). Minimum sample N = 30 required for empirical divergence. Stopout
              threshold at 1.5× ATR% adverse excursion.
            </span>
          </div>
          <div className="flex-shrink-0 text-[10px] text-[#7d8590] font-mono">
            Updated: {generatedAtStr}
          </div>
        </div>
      </div>
    </div>
  );
};

export default PillarScorecardModal;
