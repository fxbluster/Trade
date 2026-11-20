import React, { useState, useEffect } from 'react';
import { useMarketStore } from '../store/useMarketStore';
import { useUiStore } from '../store/useUiStore';
import { apiClient } from '../lib/apiClient';
import { ShieldAlert, ShieldCheck, Clock, X, AlertTriangle } from 'lucide-react';

export const CooldownModal: React.FC = () => {
  const isCooldownModalOpen = useUiStore((s) => s.isCooldownModalOpen);
  const setIsCooldownModalOpen = useUiStore((s) => s.setIsCooldownModalOpen);
  const risk = useMarketStore((s) => s.risk);
  const refreshState = useMarketStore((s) => s.refreshState);

  const [remainingSec, setRemainingSec] = useState(0);
  const [bypassReason, setBypassReason] = useState('');
  const [isBypassing, setIsBypassing] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  useEffect(() => {
    if (!risk?.cooldown_until) {
      setRemainingSec(0);
      return;
    }

    const interval = setInterval(() => {
      const diff = Math.max(0, Math.floor((risk.cooldown_until - Date.now()) / 1000));
      setRemainingSec(diff);
    }, 1000);

    const initialDiff = Math.max(0, Math.floor((risk.cooldown_until - Date.now()) / 1000));
    setRemainingSec(initialDiff);

    return () => clearInterval(interval);
  }, [risk?.cooldown_until]);

  if (!isCooldownModalOpen) return null;

  const minutes = Math.floor(remainingSec / 60);
  const seconds = remainingSec % 60;
  const isExpired = remainingSec <= 0;

  const handleBypass = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!bypassReason.trim() || isBypassing) return;

    setIsBypassing(true);
    setErrorMsg(null);
    try {
      await apiClient.bypassCooldown(bypassReason.trim());
      await refreshState();
      setIsCooldownModalOpen(false);
    } catch (err: any) {
      setErrorMsg(err.message || 'Failed to bypass cooldown');
    } finally {
      setIsBypassing(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-4 font-mono select-none">
      <div className="relative w-full max-w-md bg-[#080c14] border border-[#151d2c] rounded-xl shadow-2xl p-6 text-xs space-y-4">
        {/* Close Button */}
        <button
          onClick={() => setIsCooldownModalOpen(false)}
          className="absolute right-4 top-4 text-[#7d8590] hover:text-[#e6edf3] transition-colors"
        >
          <X className="w-4 h-4" />
        </button>

        {/* Modal Title */}
        <div className={`flex items-center space-x-2 ${isExpired ? 'text-[#0ecb81]' : 'text-[#f6465d]'}`}>
          {isExpired ? (
            <ShieldCheck className="w-5 h-5 flex-shrink-0" />
          ) : (
            <ShieldAlert className="w-5 h-5 flex-shrink-0" />
          )}
          <h2 className="text-sm font-bold uppercase tracking-wider text-[#e6edf3]">
            {isExpired ? 'Risk Diagnostics & Guardrails' : 'Anti-Gambling Cooldown Lockout'}
          </h2>
        </div>

        {isExpired ? (
          /* Operational Diagnostics Card when Cooldown is Inactive */
          <div className="space-y-3">
            <div className="bg-[#020305] p-3 rounded border border-[#0ecb81]/30 space-y-2">
              <div className="flex items-center space-x-2 text-[#0ecb81]">
                <span className="w-2 h-2 rounded-full bg-[#0ecb81] animate-pulse" />
                <span className="font-bold text-xs uppercase tracking-wide">All Systems Operational</span>
              </div>
              <p className="text-[11px] text-[#7d8590]">
                TradeOS LiquidationGuard is actively protecting capital. No active trading cooldown or behavioral lockout is engaged.
              </p>
            </div>

            <div className="grid grid-cols-2 gap-2 text-[11px]">
              <div className="bg-[#020305] p-2.5 rounded border border-[#151d2c]">
                <span className="text-[10px] text-[#7d8590] uppercase block">Max Margin Cap</span>
                <span className="text-[#e6edf3] font-bold">10.0% of Balance</span>
              </div>
              <div className="bg-[#020305] p-2.5 rounded border border-[#151d2c]">
                <span className="text-[10px] text-[#7d8590] uppercase block">Session Drawdown Limit</span>
                <span className="text-[#e6edf3] font-bold">max($5.00, 3.0%)</span>
              </div>
              <div className="bg-[#020305] p-2.5 rounded border border-[#151d2c]">
                <span className="text-[10px] text-[#7d8590] uppercase block">Consecutive Losses</span>
                <span className="text-[#0ecb81] font-bold">{risk?.consecutive_losses ?? 0} / 2</span>
              </div>
              <div className="bg-[#020305] p-2.5 rounded border border-[#151d2c]">
                <span className="text-[10px] text-[#7d8590] uppercase block">Session Net PnL</span>
                <span className={risk?.session_net_pnl >= 0 ? 'text-[#0ecb81] font-bold' : 'text-[#f6465d] font-bold'}>
                  {risk?.session_net_pnl >= 0 ? '+' : ''}${risk?.session_net_pnl ? risk.session_net_pnl.toFixed(2) : '0.00'}
                </span>
              </div>
            </div>

            <button
              type="button"
              onClick={() => setIsCooldownModalOpen(false)}
              className="w-full py-2.5 rounded bg-[#151d2c] hover:bg-[#1f293d] text-[#e6edf3] font-semibold transition-colors mt-2"
            >
              Close Diagnostics
            </button>
          </div>
        ) : (
          /* Active Lockout Timer & Bypass Form */
          <>
            {/* Reason */}
            <div className="bg-[#020305] p-3 rounded border border-[#151d2c] space-y-1">
              <span className="text-[10px] text-[#7d8590] uppercase block">Trigger Reason</span>
              <span className="text-[#e6edf3] font-semibold">
                {risk?.cooldown_reason || 'Consecutive loss streak or risk threshold triggered.'}
              </span>
              <p className="text-[11px] text-[#7d8590] pt-1">
                TradeOS LiquidationGuard enforces a mandatory 15-minute cooling off period to protect psychological capital and prevent tilt trading.
              </p>
            </div>

            {/* Timer Display */}
            <div className="flex flex-col items-center justify-center py-4 bg-[#020305] rounded border border-[#151d2c]">
              <Clock className="w-8 h-8 text-amber-400 mb-2 animate-pulse" />
              <div className="text-3xl font-bold text-[#e6edf3] tabular-nums">
                {`${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`}
              </div>
              <span className="text-[10px] text-[#7d8590] uppercase mt-1">Remaining Lockout Duration</span>
            </div>

            {/* Audit-Logged Bypass Form */}
            <form onSubmit={handleBypass} className="space-y-2 pt-2 border-t border-[#151d2c]">
              <div className="flex items-center space-x-1 text-amber-400 text-[11px]">
                <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0" />
                <span>Emergency Manual Override (Logged to SQLite WAL Audit)</span>
              </div>

              <textarea
                rows={2}
                placeholder="Type verified justification for bypass (e.g. verified new market regime)..."
                value={bypassReason}
                onChange={(e) => setBypassReason(e.target.value)}
                className="w-full bg-[#020305] border border-[#151d2c] rounded p-2 text-xs text-[#e6edf3] placeholder-[#484f58] focus:border-amber-400 focus:outline-none"
              />

              {errorMsg && (
                <div className="p-1.5 rounded bg-[#f6465d]/10 border border-[#f6465d]/30 text-[#f6465d] text-[11px]">
                  {errorMsg}
                </div>
              )}

              <div className="flex items-center space-x-2 pt-1">
                <button
                  type="button"
                  onClick={() => setIsCooldownModalOpen(false)}
                  className="flex-1 py-2 rounded bg-[#151d2c] text-[#7d8590] hover:text-[#e6edf3] font-semibold transition-colors"
                >
                  Wait Out Cooldown
                </button>

                <button
                  type="submit"
                  disabled={isBypassing || !bypassReason.trim()}
                  className="flex-1 py-2 rounded bg-amber-500/20 text-amber-400 border border-amber-500/40 hover:bg-amber-500/30 disabled:opacity-40 font-bold transition-colors"
                >
                  {isBypassing ? 'Bypassing...' : 'Audit Bypass'}
                </button>
              </div>
            </form>
          </>
        )}
      </div>
    </div>
  );
};
