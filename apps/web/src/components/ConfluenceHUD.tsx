import React from 'react';
import { useMarketStore } from '../store/useMarketStore';
import type { ConfluencePillarId } from '@tradeos/shared';
import {
  TrendingUp,
  Activity,
  BarChart3,
  Waves,
  Magnet,
  Newspaper,
  Layers,
  ShieldAlert,
  Zap,
  AlertTriangle,
  Cpu,
} from 'lucide-react';

export const PILLAR_METADATA: Record<
  ConfluencePillarId,
  { name: string; weight: string; icon: React.ComponentType<{ className?: string }> }
> = {
  MACRO_REGIME: { name: 'Macro Regime', weight: '15%', icon: TrendingUp },
  NATIVE_SMC: { name: 'Native SMC', weight: '20%', icon: Layers },
  CVD_ABSORPTION: { name: 'CVD Absorption', weight: '20%', icon: Waves },
  ORDER_FLOW_L2: { name: 'Order Flow L2', weight: '12.5%', icon: BarChart3 },
  LIQ_CLUSTERS: { name: 'Liq Clusters', weight: '7.5%', icon: Magnet },
  MOMENTUM_RVOL: { name: 'Momentum & rVol', weight: '10%', icon: Activity },
  SENTIMENT_MACRO: { name: 'Macro Sentiment', weight: '15%', icon: Newspaper },
};

/**
 * Shortens verbose pillar texts to prevent visual overflow in HUD cards.
 */
export function compactText(t?: string): string {
  if (!t) return '';
  return t
    .replace(/Equilibrium \(No Active Zones\)/gi, 'No Active Zones')
    .replace(/Delta flow within normal bounds/gi, 'Normal Bounds')
    .replace(/unmitigated FVGs/gi, 'FVGs')
    .replace(/Order Blocks?/gi, 'OB');
}

export const ConfluenceHUD: React.FC = () => {
  const confluence = useMarketStore((s) => s.confluence);

  const compositeScore = confluence?.compositeScore ?? 62;
  const recommendedAction = confluence?.recommendedAction ?? 'GÖZLƏ';

  const actionColor = () => {
    switch (recommendedAction) {
      case 'STRONG_BUY':
      case 'BUY':
        return 'text-[#0ecb81] bg-[#0ecb81]/15 border-[#0ecb81]/40';
      case 'STRONG_SELL':
      case 'SELL':
        return 'text-[#f6465d] bg-[#f6465d]/15 border-[#f6465d]/40';
      case 'WAIT':
      case 'GÖZLƏ':
      default:
        return 'text-[#f0b90b] bg-[#f0b90b]/15 border-[#f0b90b]/40';
    }
  };

  return (
    <div className="flex flex-col bg-[#080c14] border border-[#151d2c] rounded-lg p-2.5 space-y-2.5 font-mono text-xs select-none">
      {/* 1. Header: Master Consensus Status & Composite Gauge */}
      <div className="flex flex-wrap items-center justify-between gap-2 pb-2 border-b border-[#151d2c]">
        {/* Left: Title & Quant Conviction Indicator */}
        <div className="flex items-center space-x-2">
          <div className="flex items-center space-x-1.5">
            <Zap className="w-4 h-4 text-[#f0b90b]" />
            <span className="font-bold text-[#e6edf3] uppercase tracking-wide">
              Institutional Confluence Matrix
            </span>
          </div>

          {/* Orthogonal Quant Conviction Indicator */}
          <div className="flex items-center space-x-1 pl-2">
            <span
              data-testid="quant-conviction-indicator"
              className={`px-2 py-0.5 rounded text-[11px] font-bold border ${
                compositeScore >= 70
                  ? 'bg-[#0ecb81]/20 text-[#0ecb81] border-[#0ecb81]/50 shadow-sm shadow-[#0ecb81]/20'
                  : compositeScore >= 60
                  ? 'bg-[#f0b90b]/20 text-[#f0b90b] border-[#f0b90b]/50'
                  : 'bg-[#151d2c] text-[#7d8590] border-[#151d2c]'
              }`}
            >
              Orthogonal Quant Conviction: Score: {compositeScore}%
            </span>
          </div>
        </div>

        {/* Right: Recommendation & Composite Score Progress */}
        <div className="flex items-center space-x-3">
          {/* Action Badge */}
          <div className={`px-2.5 py-0.5 rounded text-xs font-bold border uppercase tracking-wider ${actionColor()}`}>
            {recommendedAction === 'GÖZLƏ' ? 'GÖZLƏ (WAITING)' : recommendedAction}
          </div>

          {/* Composite Score Meter */}
          <div className="flex items-center space-x-2">
            <span className="text-[10px] text-[#7d8590] uppercase">Score:</span>
            <div className="w-24 h-2 bg-[#020305] border border-[#151d2c] rounded-full overflow-hidden flex">
              <div
                style={{ width: `${compositeScore}%` }}
                className={`h-full transition-all duration-300 ${
                  compositeScore >= 85
                    ? 'bg-[#0ecb81]'
                    : compositeScore >= 65
                    ? 'bg-[#2962ff]'
                    : 'bg-[#f0b90b]'
                }`}
              />
            </div>
            <span className="font-bold text-[#e6edf3] text-[11px] tabular-nums">
              {compositeScore}%
            </span>
          </div>
        </div>
      </div>

      {/* Macro Veto Warning Banner */}
      {confluence?.macroVetoActive && (
        <div
          data-testid="macro-veto-banner"
          className="flex items-center space-x-2 px-3 py-2 bg-[#f0b90b]/15 border border-[#f0b90b]/50 rounded text-[#f0b90b] text-xs font-bold tracking-wide animate-pulse"
        >
          <AlertTriangle className="w-4 h-4 flex-shrink-0 text-[#f0b90b]" />
          <span>MACRO VETO ENGAGED: Longs blocked below 1h EMA200</span>
        </div>
      )}

      {/* Economic Event Blackout Window Banner */}
      {confluence?.eventBlackoutActive && (
        <div
          data-testid="event-blackout-banner"
          className="flex items-center space-x-2 px-3 py-2 bg-[#f6465d]/15 border border-[#f6465d]/50 rounded text-[#f6465d] text-xs font-bold tracking-wide animate-pulse"
        >
          <ShieldAlert className="w-4 h-4 flex-shrink-0 text-[#f6465d]" />
          <span>ECONOMIC EVENT BLACKOUT: +/-15m Freeze Active (High-Impact Catalyst Window)</span>
        </div>
      )}

      {/* Volatility Noise Band Filter Banner */}
      {confluence?.noiseBandActive && (
        <div
          data-testid="noise-band-banner"
          className="flex flex-wrap items-center justify-between gap-1 px-3 py-2 bg-[#2962ff]/15 border border-[#2962ff]/50 rounded text-[#2962ff] text-xs font-bold tracking-wide"
        >
          <div className="flex items-center space-x-2">
            <Waves className="w-4 h-4 flex-shrink-0 text-[#2962ff]" />
            <span>NOISE BAND ACTIVE: Range within 20-day 15m True Range noise threshold</span>
          </div>
          {confluence.noiseBand && (
            <span className="text-[10px] text-[#7d8590] tabular-nums font-normal">
              TR: ${confluence.noiseBand.currentTrueRange15m.toFixed(2)} / Threshold: ${confluence.noiseBand.noiseThreshold.toFixed(2)} (VWAP Dist: ${(confluence.noiseBand.vwapDistancePct * 100).toFixed(2)}%)
            </span>
          )}
        </div>
      )}

      {/* Dynamic Orthogonal Alpha Factors (MGS Gram-Schmidt Synthesis) */}
      {confluence?.factorDetails && confluence.factorDetails.length > 0 && (
        <div className="flex flex-col bg-[#020305] border border-[#151d2c] rounded p-2 space-y-1.5" data-testid="alpha-factors-panel">
          <div className="flex items-center justify-between pb-1 border-b border-[#151d2c]/60">
            <div className="flex items-center space-x-1.5">
              <Cpu className="w-3.5 h-3.5 text-[#2962ff]" />
              <span className="font-semibold text-[11px] text-[#e6edf3]">
                Orthogonal Alpha Matrix (MGS Gram-Schmidt)
              </span>
            </div>
            {confluence.noiseBand && (
              <span className={`px-1.5 py-0.5 rounded text-[9px] font-bold border ${
                confluence.noiseBand.isNoise
                  ? 'bg-[#2962ff]/20 text-[#2962ff] border-[#2962ff]/40'
                  : 'bg-[#0ecb81]/20 text-[#0ecb81] border-[#0ecb81]/40'
              }`}>
                Noise Band: {confluence.noiseBand.isNoise ? 'ACTIVE (SUPPRESSED)' : 'CLEARED'}
              </span>
            )}
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-1.5">
            {confluence.factorDetails.map((factor) => {
              const isBull = factor.bias === 'BULLISH';
              const isBear = factor.bias === 'BEARISH';
              const rawPct = (factor.rawAlpha * 100).toFixed(0);
              const orthoPct = (factor.orthogonalAlpha * 100).toFixed(0);
              const weightPct = (factor.posteriorWeight * 100).toFixed(1);

              return (
                <div
                  key={factor.factorId}
                  className="flex flex-col justify-between p-1.5 rounded bg-[#080c14] border border-[#151d2c]/60 space-y-1"
                >
                  <div className="flex items-center justify-between text-[10px]">
                    <span className="font-semibold text-[#e6edf3] truncate" title={factor.name}>
                      {factor.name}
                    </span>
                    <span className={`px-1 py-0.2 rounded text-[8px] font-bold border ${
                      factor.isCollinear
                        ? 'bg-[#f0b90b]/15 text-[#f0b90b] border-[#f0b90b]/30'
                        : 'bg-[#2962ff]/15 text-[#2962ff] border-[#2962ff]/30'
                    }`}>
                      {factor.isCollinear ? 'COLLINEAR' : 'ORTHO'}
                    </span>
                  </div>

                  <div className="flex items-center justify-between text-[9px] text-[#7d8590]">
                    <span>Raw: <span className={Number(rawPct) > 0 ? 'text-[#0ecb81]' : Number(rawPct) < 0 ? 'text-[#f6465d]' : 'text-[#7d8590]'}>{Number(rawPct) > 0 ? `+${rawPct}%` : `${rawPct}%`}</span></span>
                    <span>Ortho: <span className={Number(orthoPct) > 0 ? 'text-[#0ecb81]' : Number(orthoPct) < 0 ? 'text-[#f6465d]' : 'text-[#7d8590]'}>{Number(orthoPct) > 0 ? `+${orthoPct}%` : `${orthoPct}%`}</span></span>
                  </div>

                  <div className="flex items-center justify-between pt-0.5 border-t border-[#151d2c]/40 text-[9px]">
                    <span className="text-[#7d8590]">Weight: <span className="font-bold text-[#e6edf3]">{weightPct}%</span></span>
                    <span className={`font-bold ${isBull ? 'text-[#0ecb81]' : isBear ? 'text-[#f6465d]' : 'text-[#7d8590]'}`}>
                      {factor.bias}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
};
