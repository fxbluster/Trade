import React, { useState } from 'react';
import { useMarketStore } from '../store/useMarketStore';
import { apiClient } from '../lib/apiClient';
import {
  Compass,
  Send,
  ShieldAlert,
  TrendingUp,
  TrendingDown,
  Sparkles,
  Layers,
  Activity,
} from 'lucide-react';
import type { MentorMode } from '@tradeos/shared';

export const SokratMentorPanel: React.FC = () => {
  const indicators = useMarketStore((s) => s.indicators);
  const cvd = useMarketStore((s) => s.cvd);
  const sokrat = useMarketStore((s) => s.sokrat);
  const risk = useMarketStore((s) => s.risk);

  const [chatInput, setChatInput] = useState('');
  const [chatReply, setChatReply] = useState<string | null>(null);
  const [isSending, setIsSending] = useState(false);

  // Send message to Sokrat
  const handleSendChat = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    if (!chatInput.trim() || isSending) return;

    const userMsg = chatInput.trim();
    setChatInput('');
    setIsSending(true);

    try {
      const res = await apiClient.chatMentor(userMsg);
      setChatReply(res.reply);
    } catch (err: any) {
      setChatReply('Sokrat hazırda düşünür: ' + (err.message || 'Xəta baş verdi.'));
    } finally {
      setIsSending(false);
    }
  };

  // EMA alignment
  const ema9 = indicators?.ema9;
  const ema21 = indicators?.ema21;
  const ema50 = indicators?.ema50;
  const isEmaBullish = ema9 && ema21 ? ema9 > ema21 : false;

  const modeBadgeColor = (mode: MentorMode) => {
    switch (mode) {
      case 'DISCIPLINE':
        return 'bg-[#2962ff]/20 text-[#2962ff] border-[#2962ff]/40';
      case 'CAUTION':
        return 'bg-amber-500/20 text-amber-400 border-amber-500/40';
      case 'AGGRESSIVE':
        return 'bg-[#0ecb81]/20 text-[#0ecb81] border-[#0ecb81]/40';
      case 'LOCKOUT':
        return 'bg-[#f6465d]/20 text-[#f6465d] border-[#f6465d]/40';
      default:
        return 'bg-[#151d2c] text-[#7d8590] border-[#151d2c]';
    }
  };

  return (
    <div className="flex flex-col bg-[#080c14] border border-[#151d2c] rounded-lg p-3 space-y-3 font-mono text-xs select-none">
      {/* Header: Sokrat Title & Mode Badge */}
      <div className="flex items-center justify-between pb-2 border-b border-[#151d2c]">
        <div className="flex items-center space-x-1.5">
          <Sparkles className="w-4 h-4 text-[#8b5cf6]" />
          <span className="font-bold text-[#e6edf3] tracking-wide">Sokrat Quant Mentor</span>
        </div>
        {sokrat && (
          <span
            className={`px-2 py-0.5 rounded text-[10px] font-bold border uppercase ${modeBadgeColor(
              sokrat.mode
            )}`}
          >
            {sokrat.mode} ({sokrat.riskScore}/100)
          </span>
        )}
      </div>

      {/* Azerbaijani Guidance Card */}
      {sokrat ? (
        <div className="bg-[#020305] border border-[#151d2c] rounded p-2.5 space-y-1.5">
          <div className="font-bold text-[#e6edf3] text-xs leading-snug">
            {sokrat.headlineAz}
          </div>
          <div className="text-[#7d8590] text-[11px] leading-relaxed">
            {sokrat.adviceAz}
          </div>
          {sokrat.reasonsAz && sokrat.reasonsAz.length > 0 && (
            <ul className="list-disc list-inside text-[10px] text-[#7d8590] pt-1 space-y-0.5">
              {sokrat.reasonsAz.map((reason, idx) => (
                <li key={idx}>{reason}</li>
              ))}
            </ul>
          )}
        </div>
      ) : (
        <div className="p-3 text-center text-[#7d8590] text-[11px]">
          Bazara nəzarət edilir... Sokrat tövsiyəsi hazırlanır.
        </div>
      )}

      {/* Tactical Indicators Matrix */}
      <div className="space-y-1.5">
        <div className="text-[10px] text-[#7d8590] uppercase flex items-center space-x-1">
          <Layers className="w-3 h-3 text-[#2962ff]" />
          <span>Tactical Quant Engine</span>
        </div>

        <div className="grid grid-cols-2 gap-1.5 bg-[#020305] p-2 rounded border border-[#151d2c]">
          {/* EMA */}
          <div>
            <span className="text-[10px] text-[#7d8590] block">EMA 9 / 21</span>
            <span
              className={`font-bold flex items-center ${
                isEmaBullish ? 'text-[#0ecb81]' : 'text-[#f6465d]'
              }`}
            >
              {isEmaBullish ? <TrendingUp className="w-3 h-3 mr-0.5" /> : <TrendingDown className="w-3 h-3 mr-0.5" />}
              {isEmaBullish ? 'BULLISH' : 'BEARISH'}
            </span>
          </div>

          {/* RSI 14 */}
          <div>
            <span className="text-[10px] text-[#7d8590] block">RSI (14)</span>
            <span
              className={`font-bold ${
                indicators?.rsi14 && indicators.rsi14 >= 70
                  ? 'text-[#f6465d]'
                  : indicators?.rsi14 && indicators.rsi14 <= 30
                  ? 'text-[#0ecb81]'
                  : 'text-[#e6edf3]'
              }`}
            >
              {indicators?.rsi14 ? indicators.rsi14.toFixed(1) : '--'}
            </span>
          </div>

          {/* ATR 14 */}
          <div>
            <span className="text-[10px] text-[#7d8590] block">ATR (14) Volatility</span>
            <span className="text-[#e6edf3] font-bold">
              {indicators?.atr14 ? indicators.atr14.toFixed(2) : '--'}
            </span>
          </div>

          {/* CVD */}
          <div>
            <span className="text-[10px] text-[#7d8590] block">Delta CVD</span>
            <span
              className={`font-bold ${
                cvd && cvd.cvd >= 0 ? 'text-[#0ecb81]' : 'text-[#f6465d]'
              }`}
            >
              {cvd ? `${cvd.cvd >= 0 ? '+' : ''}${cvd.cvd.toFixed(1)}` : '--'}
            </span>
          </div>
        </div>
      </div>

      {/* Sokrat Dialogue / Interactive Counsel */}
      <div className="space-y-1.5 pt-1">
        {chatReply && (
          <div className="p-2 rounded bg-[#8b5cf6]/10 border border-[#8b5cf6]/30 text-[#e6edf3] text-[11px] leading-relaxed">
            <span className="text-[#8b5cf6] font-bold block mb-0.5">Sokrat Deyir:</span>
            {chatReply}
          </div>
        )}

        <form onSubmit={handleSendChat} className="flex items-center space-x-1.5">
          <input
            type="text"
            placeholder="Sokratdan məsləhət al (məs: Bu vəziyyətdə risk nədir?)..."
            value={chatInput}
            onChange={(e) => setChatInput(e.target.value)}
            disabled={isSending}
            className="flex-1 bg-[#020305] border border-[#151d2c] rounded px-2.5 py-1.5 text-[11px] text-[#e6edf3] placeholder-[#484f58] focus:border-[#8b5cf6] focus:outline-none"
          />
          <button
            type="submit"
            disabled={isSending || !chatInput.trim()}
            className="p-1.5 rounded bg-[#8b5cf6]/20 border border-[#8b5cf6]/40 text-[#8b5cf6] hover:bg-[#8b5cf6]/30 disabled:opacity-30 transition-colors"
          >
            <Send className="w-3.5 h-3.5" />
          </button>
        </form>
      </div>
    </div>
  );
};
