import React, { useState } from 'react';
import { useMarketStore } from '../store/useMarketStore';
import { useUiStore } from '../store/useUiStore';
import { apiClient } from '../lib/apiClient';
import { soundEffects } from '../lib/audio';
import {
  Bot,
  Power,
  ShieldCheck,
  ShieldAlert,
  Sliders,
  RefreshCw,
  AlertOctagon,
  ArrowRightLeft,
  Lock,
} from 'lucide-react';

export const AutoPilotControls: React.FC = () => {
  const autoPilot = useMarketStore((s) => s.autoPilot);
  const setAutoPilotStatus = useMarketStore((s) => s.setAutoPilotStatus);
  const isAudioMuted = useUiStore((s) => s.isAudioMuted);

  const [isToggling, setIsToggling] = useState(false);
  const [isSavingConfig, setIsSavingConfig] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const { state: apState, config } = autoPilot;
  const isEnabled = config.enabled;

  const handleToggle = async () => {
    setIsToggling(true);
    setErrorMsg(null);
    try {
      const res = await apiClient.toggleAutoPilot(!isEnabled);
      setAutoPilotStatus({
        ...autoPilot,
        state: res.state,
        config: { ...config, enabled: res.enabled },
      });
      if (res.enabled) {
        soundEffects.playBuy(isAudioMuted);
      } else {
        soundEffects.playAlert(isAudioMuted);
      }
    } catch (err: any) {
      setErrorMsg(err.message || 'Failed to toggle Auto-Pilot');
    } finally {
      setIsToggling(false);
    }
  };

  const handleUpdateConfig = async (partial: Partial<typeof config>) => {
    setIsSavingConfig(true);
    setErrorMsg(null);
    try {
      const updated = { ...config, ...partial };
      const res = await apiClient.updateAutoPilotConfig(updated);
      setAutoPilotStatus({
        ...autoPilot,
        config: res.config,
      });
    } catch (err: any) {
      setErrorMsg(err.message || 'Failed to update Auto-Pilot configuration');
    } finally {
      setIsSavingConfig(false);
    }
  };

  const stateBadgeColor = () => {
    switch (apState) {
      case 'LIMIT_CHASING':
        return 'bg-[#f0b90b]/20 text-[#f0b90b] border-[#f0b90b]/50 animate-pulse font-bold';
      case 'POSITION_OPEN':
        return 'bg-[#0ecb81]/20 text-[#0ecb81] border-[#0ecb81]/50 animate-pulse';
      case 'PLACING_ORDER':
      case 'CLOSING':
        return 'bg-[#2962ff]/20 text-[#2962ff] border-[#2962ff]/50 animate-pulse';
      case 'COOLDOWN_ACTIVE':
        return 'bg-[#f6465d]/20 text-[#f6465d] border-[#f6465d]/50 animate-pulse font-bold';
      case 'BLOCKED_SESSION_TRADE_CAP':
        return 'bg-[#f0b90b]/20 text-[#f0b90b] border-[#f0b90b]/50 animate-pulse font-bold';
      case 'EVALUATING':
        return 'bg-[#f0b90b]/20 text-[#f0b90b] border-[#f0b90b]/40';
      case 'IDLE':
      default:
        return isEnabled
          ? 'bg-[#0ecb81]/15 text-[#0ecb81] border-[#0ecb81]/30'
          : 'bg-[#151d2c] text-[#7d8590] border-[#151d2c]';
    }
  };

  return (
    <div className="flex flex-col bg-[#080c14] border border-[#151d2c] rounded-lg p-3 space-y-3 font-mono text-xs select-none">
      {/* 1. Header: Master Arming Toggle & Active State Badge */}
      <div className="flex items-center justify-between pb-2 border-b border-[#151d2c]">
        <div className="flex items-center space-x-2">
          <Bot className="w-4 h-4 text-[#0ecb81]" />
          <span className="font-bold text-[#e6edf3] uppercase tracking-wide">
            Autonomous Auto-Pilot
          </span>
        </div>

        {/* State Badge */}
        <span className={`px-2 py-0.5 rounded text-[10px] font-bold border uppercase ${stateBadgeColor()}`}>
          {!isEnabled
            ? 'STANDBY (MANUAL)'
            : apState === 'LIMIT_CHASING'
            ? `MAKER CHASING (${autoPilot.chasingOrder?.amendCount || 0}/10 AMENDS)`
            : apState === 'BLOCKED_SESSION_TRADE_CAP'
            ? `SESSION CAP REACHED (${autoPilot.filledToday || 0}/${config.maxDailyTrades || 5})`
            : apState === 'COOLDOWN_ACTIVE' && autoPilot.blockReason === 'BLOCKED_DAILY_MAX_LOSS'
            ? 'DRAWDOWN LIMIT HIT (-2.0%)'
            : apState}
        </span>
      </div>

      {errorMsg && (
        <div className="p-1.5 rounded bg-[#f6465d]/10 border border-[#f6465d]/30 text-[#f6465d] text-[11px]">
          {errorMsg}
        </div>
      )}

      {/* Maker Limit Chasing Telemetry Card */}
      {(apState === 'LIMIT_CHASING' || autoPilot.chasingOrder) && (
        <div
          data-testid="maker-chasing-card"
          className="p-2.5 rounded bg-[#f0b90b]/10 border border-[#f0b90b]/40 text-[#f0b90b] space-y-1.5 animate-pulse"
        >
          <div className="flex items-center justify-between font-bold text-[11px]">
            <div className="flex items-center space-x-1.5">
              <RefreshCw className="w-3.5 h-3.5 text-[#f0b90b] animate-spin" />
              <span>Maker Limit Chasing (Post-Only GTX)</span>
            </div>
            <span className="px-1.5 py-0.5 rounded text-[9px] bg-[#f0b90b]/20 border border-[#f0b90b]/50">
              {autoPilot.chasingOrder?.status || 'CHASING'}
            </span>
          </div>

          <div className="grid grid-cols-3 gap-1 text-[10px] text-[#e6edf3]">
            <div>
              <span className="text-[#7d8590] block text-[9px]">Target Price</span>
              <span className="font-bold tabular-nums">
                {autoPilot.chasingOrder?.currentLimitPrice ? `$${autoPilot.chasingOrder.currentLimitPrice.toFixed(2)}` : 'BBO Penny-Jump'}
              </span>
            </div>
            <div>
              <span className="text-[#7d8590] block text-[9px]">Amendments</span>
              <span className="font-bold tabular-nums">
                {autoPilot.chasingOrder?.amendCount ?? 0} / 10
              </span>
            </div>
            <div>
              <span className="text-[#7d8590] block text-[9px]">Fee Savings</span>
              <span className="font-bold tabular-nums text-[#0ecb81]">
                {autoPilot.chasingOrder?.feeSavedUsd !== undefined
                  ? `+$${autoPilot.chasingOrder.feeSavedUsd.toFixed(3)}`
                  : 'Maker Rebate (+0.03%)'}
              </span>
            </div>
          </div>
        </div>
      )}

      {/* Dynamic Sizing Breakdown Badge */}
      {autoPilot.sizingBreakdown && (
        <div
          data-testid="dynamic-sizing-badge"
          className="p-2.5 rounded bg-[#020305] border border-[#151d2c] space-y-1.5"
        >
          <div className="flex items-center justify-between text-[11px]">
            <div className="flex items-center space-x-1.5">
              <Sliders className="w-3.5 h-3.5 text-[#0ecb81]" />
              <span className="font-bold text-[#e6edf3]">Adaptive Margin Allocation:</span>
            </div>
            <span className="px-2 py-0.5 rounded text-[10px] font-bold bg-[#0ecb81]/15 text-[#0ecb81] border border-[#0ecb81]/30 tabular-nums">
              {(autoPilot.sizingBreakdown.finalMarginPct * 100).toFixed(1)}% (${autoPilot.sizingBreakdown.marginUsd.toFixed(2)})
            </span>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-1 text-[10px] text-[#7d8590]">
            <span>Archetype: <span className="font-semibold text-[#e6edf3]">{autoPilot.sizingBreakdown.archetype}</span></span>
            <span className={`px-1 py-0.2 rounded text-[9px] font-semibold border ${
              autoPilot.sizingBreakdown.solvencyAirbagOk
                ? 'bg-[#0ecb81]/10 text-[#0ecb81] border-[#0ecb81]/30'
                : 'bg-[#f6465d]/10 text-[#f6465d] border-[#f6465d]/30'
            }`}>
              Airbag: {autoPilot.sizingBreakdown.solvencyAirbagOk ? 'SECURE' : 'VIOLATION'}
            </span>
          </div>

          <div className="grid grid-cols-3 gap-1 pt-1 border-t border-[#151d2c]/60 text-[9px] text-[#7d8590]">
            <div>Kelly: <span className="text-[#e6edf3] font-semibold">{(autoPilot.sizingBreakdown.kellyDampener ?? 1).toFixed(2)}x</span></div>
            <div>Vol Parity: <span className="text-[#e6edf3] font-semibold">{(autoPilot.sizingBreakdown.volatilityParity ?? 1).toFixed(2)}x</span></div>
            <div>Circuit: <span className="text-[#e6edf3] font-semibold">{(autoPilot.sizingBreakdown.circuitMultiplier ?? 1).toFixed(2)}x</span></div>
          </div>
        </div>
      )}

      {/* Warning Banners for Session Cap or Drawdown Limit */}
      {apState === 'BLOCKED_SESSION_TRADE_CAP' && (
        <div className="p-2 rounded bg-[#f0b90b]/15 border border-[#f0b90b]/40 text-[#f0b90b] text-[11px] font-bold flex items-center space-x-2">
          <AlertOctagon className="w-4 h-4 flex-shrink-0 text-[#f0b90b]" />
          <span>
            Session Trade Cap Reached ({autoPilot.filledToday || 0}/{config.maxDailyTrades || 5} trades today) — AutoPilot halted.
          </span>
        </div>
      )}

      {apState === 'COOLDOWN_ACTIVE' && (
        <div className="p-2 rounded bg-[#f6465d]/15 border border-[#f6465d]/40 text-[#f6465d] text-[11px] font-bold flex items-center space-x-2 animate-pulse">
          <ShieldAlert className="w-4 h-4 flex-shrink-0 text-[#f6465d]" />
          <span>
            {autoPilot.message || 'Daily 2% Drawdown Ceiling Hit — Circuit Breaker Locked until 00:00 UTC.'}
          </span>
        </div>
      )}

      {/* 2. Master Toggle Switch Button */}
      <button
        onClick={handleToggle}
        disabled={isToggling}
        className={`w-full flex items-center justify-center space-x-2 py-2.5 rounded font-bold uppercase transition-all shadow-md ${
          isEnabled
            ? apState === 'BLOCKED_SESSION_TRADE_CAP'
              ? 'bg-[#f0b90b] text-[#020305] hover:bg-[#d9a506] shadow-[#f0b90b]/20'
              : apState === 'COOLDOWN_ACTIVE'
              ? 'bg-[#f6465d] text-white hover:bg-[#d9384e] shadow-[#f6465d]/20'
              : 'bg-[#0ecb81] text-[#020305] hover:bg-[#0bb573] shadow-[#0ecb81]/20'
            : 'bg-[#151d2c] text-[#7d8590] hover:text-[#e6edf3] hover:bg-[#1a2436]'
        }`}
      >
        <Power className={`w-4 h-4 ${isToggling ? 'animate-spin' : ''}`} />
        <span>
          {isEnabled
            ? apState === 'BLOCKED_SESSION_TRADE_CAP'
              ? `SESSION CAP REACHED (${autoPilot.filledToday || 0}/${config.maxDailyTrades || 5} TRADES) - HALTED`
              : apState === 'COOLDOWN_ACTIVE'
              ? 'COOLDOWN ACTIVE - HALTED'
              : 'AUTO-PILOT ARMED & ENGAGED'
            : 'ENGAGE AUTONOMOUS AUTO-PILOT'}
        </span>
      </button>

      {/* 3. Safety Guardrails & Rules Card */}
      <div className="bg-[#020305] p-2.5 rounded border border-[#151d2c] space-y-2">
        <div className="flex items-center justify-between text-[11px]">
          <span className="text-[#7d8590] flex items-center space-x-1">
            <Sliders className="w-3 h-3 text-[#2962ff]" />
            <span>Consensus Threshold:</span>
          </span>
          <div className="flex items-center space-x-1">
            {[3, 4, 5, 6].map((th) => (
              <button
                key={th}
                onClick={() => handleUpdateConfig({ consensusThreshold: th })}
                disabled={isSavingConfig}
                className={`px-2 py-0.5 rounded text-[10px] border transition-colors ${
                  config.consensusThreshold === th
                    ? 'bg-[#2962ff]/20 text-[#2962ff] border-[#2962ff] font-bold'
                    : 'bg-[#080c14] text-[#7d8590] border-[#151d2c] hover:text-[#e6edf3]'
                }`}
              >
                {th}/7
              </button>
            ))}
          </div>
        </div>

        {/* Daily Trade Cap Selector (DEF-12) */}
        <div className="flex items-center justify-between text-[11px]">
          <span className="text-[#7d8590] flex items-center space-x-1">
            <ShieldCheck className="w-3 h-3 text-[#f0b90b]" />
            <span>Daily Trade Cap:</span>
          </span>
          <div className="flex items-center space-x-1">
            {[2, 3, 5, 10].map((cap) => (
              <button
                key={cap}
                onClick={() => handleUpdateConfig({ maxDailyTrades: cap })}
                disabled={isSavingConfig}
                className={`px-2 py-0.5 rounded text-[10px] border transition-colors ${
                  (config.maxDailyTrades ?? 5) === cap
                    ? 'bg-[#f0b90b]/20 text-[#f0b90b] border-[#f0b90b] font-bold'
                    : 'bg-[#080c14] text-[#7d8590] border-[#151d2c] hover:text-[#e6edf3]'
                }`}
              >
                {cap} Trades
              </button>
            ))}
          </div>
        </div>

        {/* AutoPilot Margin Allocation (strictly capped at 10% in auto-pilot) */}
        <div className="flex items-center justify-between text-[11px]">
          <span className="text-[#7d8590] flex items-center space-x-1">
            <Lock className="w-3 h-3 text-[#f0b90b]" />
            <span>Margin Cap (Auto-Pilot):</span>
          </span>
          <div className="flex items-center space-x-1">
            {[2.5, 5.0, 10.0].map((pct) => (
              <button
                key={pct}
                onClick={() => handleUpdateConfig({ marginAllocationPct: pct })}
                disabled={isSavingConfig}
                className={`px-2 py-0.5 rounded text-[10px] border transition-colors ${
                  config.marginAllocationPct === pct
                    ? 'bg-[#0ecb81]/20 text-[#0ecb81] border-[#0ecb81] font-bold'
                    : 'bg-[#080c14] text-[#7d8590] border-[#151d2c] hover:text-[#e6edf3]'
                }`}
              >
                {pct.toFixed(1)}%
              </button>
            ))}
          </div>
        </div>

        {/* Opposite-Confluence Reversal Exit Toggle */}
        <div className="flex items-center justify-between pt-1 border-t border-[#151d2c]/60 text-[11px]">
          <span className="text-[#7d8590] flex items-center space-x-1">
            <ArrowRightLeft className="w-3 h-3 text-[#f6465d]" />
            <span>2-Tick Opposite Exit:</span>
          </span>
          <button
            onClick={() => handleUpdateConfig({ oppositeExitEnabled: !config.oppositeExitEnabled })}
            className={`px-2 py-0.5 rounded text-[10px] font-bold border transition-colors ${
              config.oppositeExitEnabled
                ? 'bg-[#0ecb81]/20 text-[#0ecb81] border-[#0ecb81]/40'
                : 'bg-[#151d2c] text-[#7d8590] border-[#151d2c]'
            }`}
          >
            {config.oppositeExitEnabled ? 'ENABLED' : 'DISABLED'}
          </button>
        </div>

        {/* Rules Footer Badges */}
        <div className="grid grid-cols-2 gap-1 pt-1 text-[9px] text-[#7d8590]">
          <div className="bg-[#080c14] p-1 rounded border border-[#151d2c]">
            <span className="block text-[#e6edf3]">Breakeven Rule:</span>
            <span>max(1.5x ATR, 0.25%)</span>
          </div>
          <div className="bg-[#080c14] p-1 rounded border border-[#151d2c]">
            <span className="block text-[#e6edf3]">Circuit Breaker:</span>
            <span>2 Losses → 60m Lock</span>
          </div>
        </div>
      </div>
    </div>
  );
};
