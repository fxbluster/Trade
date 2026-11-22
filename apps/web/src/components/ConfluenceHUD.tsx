import React from 'react';
import { useMarketStore } from '../store/useMarketStore';
import type { PillarEvaluation, ConfluencePillarId } from '@tradeos/shared';
import {
  TrendingUp,
  Activity,
  BarChart3,
  Waves,
  Magnet,
  Newspaper,
  Layers,
  CheckCircle2,
  XCircle,
  Clock,
  ShieldAlert,
  Zap,
  AlertTriangle,
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

export const ConfluenceHUD: React.FC = () => {
  const confluence = useMarketStore((s) => s.confluence);
  const indicators = useMarketStore((s) => s.indicators);
  const cvd = useMarketStore((s) => s.cvd);

  // Fallback / initial simulated pillars if backend snapshot not yet delivered
  const defaultPillars: PillarEvaluation[] = [
    {
      id: 'MACRO_REGIME',
      title: 'Macro Regime (1h EMA200)',
      score: 50,
      bias: 'NEUTRAL',
      valueText: 'Macro 1h Stack',
      subText: 'EMA200 / SuperTrend',
      confirmed: false,
      updatedAt: Date.now(),
    },
    {
      id: 'NATIVE_SMC',
      title: 'Native SMC (FVG/OB)',
      score: 50,
      bias: 'NEUTRAL',
      valueText: 'Scanning Structure',
      subText: 'FVG & Order Blocks',
      confirmed: false,
      updatedAt: Date.now(),
    },
    {
      id: 'CVD_ABSORPTION',
      title: 'CVD Absorption Divergence',
      score: cvd && cvd.cvd > 0 ? 70 : 50,
      bias: cvd && cvd.cvd > 0 ? 'BULLISH' : 'NEUTRAL',
      valueText: cvd ? `Delta: ${cvd.cvd.toFixed(1)}` : 'Delta 0.0',
      subText: 'Z-Score Divergence',
      confirmed: cvd ? cvd.cvd > 0 : false,
      updatedAt: Date.now(),
    },
    {
      id: 'ORDER_FLOW_L2',
      title: 'Order Flow L2 Footprint',
      score: 50,
      bias: 'NEUTRAL',
      valueText: 'Depth Imbalance 1.0x',
      subText: 'L2 Micro-Book & POC',
      confirmed: false,
      updatedAt: Date.now(),
    },
    {
      id: 'LIQ_CLUSTERS',
      title: 'Liquidation Clusters',
      score: 50,
      bias: 'NEUTRAL',
      valueText: 'Proximity > 1.5 ATR',
      subText: 'OI Leverage Clusters',
      confirmed: false,
      updatedAt: Date.now(),
    },
    {
      id: 'MOMENTUM_RVOL',
      title: 'Momentum & rVol',
      score: indicators?.rsi14 ? Math.round(indicators.rsi14) : 50,
      bias: indicators?.rsi14 && indicators.rsi14 > 55 ? 'BULLISH' : indicators?.rsi14 && indicators.rsi14 < 45 ? 'BEARISH' : 'NEUTRAL',
      valueText: indicators?.rsi14 ? `RSI ${indicators.rsi14.toFixed(1)}` : 'RSI 50.0',
      subText: 'Relative Volume & ADX',
      confirmed: indicators?.rsi14 ? indicators.rsi14 > 55 || indicators.rsi14 < 45 : false,
      updatedAt: Date.now(),
    },
    {
      id: 'SENTIMENT_MACRO',
      title: 'Sentiment Macro',
      score: 50,
      bias: 'NEUTRAL',
      valueText: 'Neutral (0.0)',
      subText: 'CryptoPanic / News Feed',
      confirmed: false,
      updatedAt: Date.now(),
    },
  ];

  const pillars = confluence?.pillars && confluence.pillars.length === 7 ? confluence.pillars : defaultPillars;
  const compositeScore = confluence?.compositeScore ?? 62;
  const consensusMet = confluence?.consensusMet ?? false;
  const consensusBias = confluence?.consensusBias ?? 'NEUTRAL';
  const recommendedAction = confluence?.recommendedAction ?? 'GÖZLƏ';
  const bullishCount = confluence?.bullishCount ?? pillars.filter((p) => p.bias === 'BULLISH' && p.confirmed).length;
  const bearishCount = confluence?.bearishCount ?? pillars.filter((p) => p.bias === 'BEARISH' && p.confirmed).length;

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
        {/* Left: Title & Active Counts */}
        <div className="flex items-center space-x-2">
          <div className="flex items-center space-x-1.5">
            <Zap className="w-4 h-4 text-[#f0b90b]" />
            <span className="font-bold text-[#e6edf3] uppercase tracking-wide">
              Institutional Confluence Matrix
            </span>
          </div>

          {/* Consensus Count Badge */}
          <div className="flex items-center space-x-1 pl-2">
            <span
              className={`px-2 py-0.5 rounded text-[11px] font-bold border ${
                consensusMet
                  ? consensusBias === 'BULLISH'
                    ? 'bg-[#0ecb81]/20 text-[#0ecb81] border-[#0ecb81]/50 shadow-sm shadow-[#0ecb81]/20 animate-pulse-subtle'
                    : 'bg-[#f6465d]/20 text-[#f6465d] border-[#f6465d]/50 shadow-sm shadow-[#f6465d]/20 animate-pulse-subtle'
                  : 'bg-[#151d2c] text-[#7d8590] border-[#151d2c]'
              }`}
            >
              {consensusMet
                ? `${consensusBias === 'BULLISH' ? bullishCount : bearishCount}/7 ${consensusBias} CONSENSUS`
                : `${Math.max(bullishCount, bearishCount)}/7 Pillars (Min 4 Req)`}
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

      {/* 2. Responsive 7-Pillars Cards Grid */}
      <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-1.5">
        {pillars.map((pillar) => {
          const meta = PILLAR_METADATA[pillar.id] || {
            name: pillar.title,
            weight: '10%',
            icon: Activity,
          };
          const Icon = meta.icon;

          const isBull = pillar.bias === 'BULLISH';
          const isBear = pillar.bias === 'BEARISH';
          const isConfirmed = pillar.confirmed;

          const cardBorder = isConfirmed
            ? isBull
              ? 'border-[#0ecb81]/50 bg-[#0ecb81]/5'
              : isBear
              ? 'border-[#f6465d]/50 bg-[#f6465d]/5'
              : 'border-[#151d2c] bg-[#020305]'
            : 'border-[#151d2c] bg-[#020305]';

          const statusBadge = isConfirmed ? (
            isBull ? (
              <span className="flex items-center text-[#0ecb81] text-[10px] font-bold">
                <CheckCircle2 className="w-3 h-3 mr-0.5" />
                BUY
              </span>
            ) : isBear ? (
              <span className="flex items-center text-[#f6465d] text-[10px] font-bold">
                <XCircle className="w-3 h-3 mr-0.5" />
                SELL
              </span>
            ) : (
              <span className="text-[#7d8590] text-[10px]">NEUT</span>
            )
          ) : (
            <span className="text-[#484f58] text-[10px]">WAIT</span>
          );

          return (
            <div
              key={pillar.id}
              className={`flex flex-col justify-between p-2 rounded border transition-colors ${cardBorder}`}
            >
              {/* Pillar Title & Weight */}
              <div className="flex items-center justify-between pb-1 border-b border-[#151d2c]/40">
                <div className="flex items-center space-x-1 truncate">
                  <Icon className="w-3 h-3 text-[#7d8590] flex-shrink-0" />
                  <span className="text-[10px] text-[#e6edf3] font-semibold truncate" title={meta.name}>
                    {meta.name}
                  </span>
                </div>
                <span className="text-[9px] text-[#7d8590] ml-1">{meta.weight}</span>
              </div>

              {/* Metric Value */}
              <div className="py-1">
                <div className="font-bold text-[11px] text-[#e6edf3] truncate" title={pillar.valueText}>
                  {pillar.valueText}
                </div>
                <div className="text-[9px] text-[#7d8590] truncate" title={pillar.subText}>
                  {pillar.subText}
                </div>
              </div>

              {/* Footer: Score & Status */}
              <div className="flex items-center justify-between pt-1 border-t border-[#151d2c]/40 text-[10px]">
                <span className="text-[#7d8590] tabular-nums font-semibold">
                  {pillar.score}/100
                </span>
                {statusBadge}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};
