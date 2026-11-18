import React, { useState } from 'react';
import { useMarketStore } from '../store/useMarketStore';
import { useUiStore } from '../store/useUiStore';
import {
  Activity,
  Radio,
  Volume2,
  VolumeX,
  Compass,
  Cpu,
  Clock,
  ShieldAlert,
  ChevronDown,
} from 'lucide-react';
import type { BrokerMode } from '@tradeos/shared';

const POPULAR_SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'DOGEUSDT', 'XRPUSDT'];

export const TopBar: React.FC = () => {
  const symbol = useMarketStore((s) => s.symbol);
  const markPrice = useMarketStore((s) => s.markPrice);
  const prevMarkPrice = useMarketStore((s) => s.prevMarkPrice);
  const account = useMarketStore((s) => s.account);
  const risk = useMarketStore((s) => s.risk);
  const wsStatus = useMarketStore((s) => s.wsStatus);
  const exchangeHealth = useMarketStore((s) => s.exchangeHealth);
  const brokerMode = useMarketStore((s) => s.brokerMode);
  const setSymbol = useMarketStore((s) => s.setSymbol);
  const setBrokerMode = useMarketStore((s) => s.setBrokerMode);

  const isAudioMuted = useUiStore((s) => s.isAudioMuted);
  const toggleAudioMute = useUiStore((s) => s.toggleAudioMute);
  const setIsScannerModalOpen = useUiStore((s) => s.setIsScannerModalOpen);
  const setIsTimeMachineModalOpen = useUiStore((s) => s.setIsTimeMachineModalOpen);
  const setIsCooldownModalOpen = useUiStore((s) => s.setIsCooldownModalOpen);

  const [isSymbolDropdownOpen, setIsSymbolDropdownOpen] = useState(false);
  const [isSwitchingBroker, setIsSwitchingBroker] = useState(false);

  // Price direction color
  const priceColor =
    markPrice > prevMarkPrice
      ? 'text-[#0ecb81]'
      : markPrice < prevMarkPrice
      ? 'text-[#f6465d]'
      : 'text-[#e6edf3]';

  const isCooldownActive = risk?.cooldown_until ? risk.cooldown_until > Date.now() : false;

  const handleBrokerToggle = async () => {
    const nextMode: BrokerMode = brokerMode === 'BINANCE_DEMO' ? 'LOCAL_PAPER' : 'BINANCE_DEMO';
    setIsSwitchingBroker(true);
    try {
      await setBrokerMode(nextMode);
    } catch (err: any) {
      alert(err.message || 'Cannot switch broker mode while positions are open');
    } finally {
      setIsSwitchingBroker(false);
    }
  };

  return (
    <header className="flex items-center justify-between px-4 py-2 bg-[#080c14] border-b border-[#151d2c] font-mono select-none text-xs">
      {/* Left: Brand & Symbol Selector */}
      <div className="flex items-center space-x-3">
        {/* Brand */}
        <div className="flex items-center space-x-2 mr-2">
          <div className="w-6 h-6 rounded bg-gradient-to-br from-[#2962ff] to-[#0ecb81] flex items-center justify-center font-bold text-white text-xs shadow-md">
            T2
          </div>
          <span className="font-bold text-sm text-[#e6edf3] tracking-wide">
            Trade<span className="text-[#0ecb81]">OS</span> <span className="text-[10px] text-[#7d8590] font-normal">v2</span>
          </span>
        </div>

        {/* Symbol Dropdown */}
        <div className="relative">
          <button
            onClick={() => setIsSymbolDropdownOpen(!isSymbolDropdownOpen)}
            className="flex items-center space-x-1.5 px-2.5 py-1.5 rounded bg-[#020305] border border-[#151d2c] text-[#e6edf3] font-bold hover:border-[#7d8590] transition-colors"
          >
            <span>{symbol}</span>
            <ChevronDown className="w-3.5 h-3.5 text-[#7d8590]" />
          </button>

          {isSymbolDropdownOpen && (
            <div className="absolute left-0 mt-1 w-36 bg-[#080c14] border border-[#151d2c] rounded shadow-xl z-50 py-1">
              {POPULAR_SYMBOLS.map((s) => (
                <button
                  key={s}
                  onClick={() => {
                    setSymbol(s);
                    setIsSymbolDropdownOpen(false);
                  }}
                  className={`w-full text-left px-3 py-1.5 hover:bg-[#151d2c] transition-colors ${
                    s === symbol ? 'text-[#0ecb81] font-bold' : 'text-[#e6edf3]'
                  }`}
                >
                  {s}
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Mark Price Realtime */}
        <div className="flex items-center space-x-2 pl-2">
          <span className={`text-base font-bold tabular-nums transition-colors duration-150 ${priceColor}`}>
            {markPrice.toFixed(2)}
          </span>
        </div>
      </div>

      {/* Center: Account Metrics */}
      <div className="hidden lg:flex items-center space-x-6">
        <div>
          <span className="text-[10px] text-[#7d8590] uppercase block">Equity</span>
          <span className="font-semibold text-[#e6edf3]">
            ${account.equity > 0 ? account.equity.toFixed(2) : account.walletBalance.toFixed(2)}
          </span>
        </div>

        <div>
          <span className="text-[10px] text-[#7d8590] uppercase block">Available</span>
          <span className="font-semibold text-[#e6edf3]">${account.availableBalance.toFixed(2)}</span>
        </div>

        <div>
          <span className="text-[10px] text-[#7d8590] uppercase block">Session PnL</span>
          <span
            className={`font-semibold ${
              risk.session_net_pnl >= 0 ? 'text-[#0ecb81]' : 'text-[#f6465d]'
            }`}
          >
            {risk.session_net_pnl >= 0 ? '+' : ''}${risk.session_net_pnl.toFixed(2)}
          </span>
        </div>
      </div>

      {/* Right: Tools & System Health Status */}
      <div className="flex items-center space-x-2">
        {/* Scanner Trigger */}
        <button
          onClick={() => setIsScannerModalOpen(true)}
          className="flex items-center space-x-1 px-2 py-1 rounded bg-[#020305] border border-[#151d2c] text-[#7d8590] hover:text-[#e6edf3] hover:border-[#7d8590] transition-colors"
          title="Market Scanner"
        >
          <Compass className="w-3.5 h-3.5 text-[#2962ff]" />
          <span className="hidden sm:inline">Scanner</span>
        </button>

        {/* Time Machine Trigger */}
        <button
          onClick={() => setIsTimeMachineModalOpen(true)}
          className="flex items-center space-x-1 px-2 py-1 rounded bg-[#020305] border border-[#151d2c] text-[#7d8590] hover:text-[#e6edf3] hover:border-[#7d8590] transition-colors"
          title="Monte Carlo Simulator"
        >
          <Cpu className="w-3.5 h-3.5 text-[#8b5cf6]" />
          <span className="hidden sm:inline">10k Sim</span>
        </button>

        {/* Cooldown Status Badge / Modal Trigger */}
        <button
          onClick={() => setIsCooldownModalOpen(true)}
          className={`flex items-center space-x-1 px-2 py-1 rounded border transition-colors ${
            isCooldownActive
              ? 'bg-[#f6465d]/20 border-[#f6465d]/40 text-[#f6465d] animate-pulse font-bold'
              : 'bg-[#020305] border-[#151d2c] text-[#7d8590] hover:text-[#e6edf3]'
          }`}
          title="Cooldown Guard"
        >
          <Clock className="w-3.5 h-3.5" />
          <span>{isCooldownActive ? 'Cooldown Active' : 'Cooldown'}</span>
        </button>

        {/* Broker Mode Switch */}
        <button
          onClick={handleBrokerToggle}
          disabled={isSwitchingBroker}
          className={`px-2.5 py-1 rounded font-bold transition-colors ${
            brokerMode === 'BINANCE_DEMO'
              ? 'bg-[#f0b90b]/15 text-[#f0b90b] border border-[#f0b90b]/40 hover:bg-[#f0b90b]/25'
              : 'bg-[#2962ff]/15 text-[#2962ff] border border-[#2962ff]/40 hover:bg-[#2962ff]/25'
          }`}
          title="Switch Broker Mode"
        >
          {isSwitchingBroker ? 'Switching...' : brokerMode === 'BINANCE_DEMO' ? 'BINANCE DEMO' : 'LOCAL PAPER'}
        </button>

        {/* WebSocket Connection Badge */}
        <div
          className={`flex items-center space-x-1 px-2 py-1 rounded text-[10px] ${
            wsStatus === 'CONNECTED'
              ? 'text-[#0ecb81] bg-[#0ecb81]/10'
              : wsStatus === 'CONNECTING'
              ? 'text-amber-400 bg-amber-400/10'
              : 'text-[#f6465d] bg-[#f6465d]/10'
          }`}
          title={`WebSocket Status: ${wsStatus}`}
        >
          <Radio className="w-3 h-3" />
          <span className="hidden md:inline">{wsStatus}</span>
        </div>

        {/* Audio Mute Button */}
        <button
          onClick={toggleAudioMute}
          className="p-1.5 rounded bg-[#020305] border border-[#151d2c] text-[#7d8590] hover:text-[#e6edf3] transition-colors"
          title={isAudioMuted ? 'Unmute Audio' : 'Mute Audio'}
        >
          {isAudioMuted ? <VolumeX className="w-3.5 h-3.5" /> : <Volume2 className="w-3.5 h-3.5 text-[#0ecb81]" />}
        </button>
      </div>
    </header>
  );
};
