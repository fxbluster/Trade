import React, { useState, useEffect } from 'react';
import { useMarketStore } from '../store/useMarketStore';
import { useUiStore } from '../store/useUiStore';
import { apiClient } from '../lib/apiClient';
import { formatUsd } from '../lib/formatters';
import {
  Activity,
  Radio,
  Volume2,
  VolumeX,
  Compass,
  Cpu,
  Clock,
  ShieldAlert,
  ShieldCheck,
  ChevronDown,
  FileText,
  Timer,
  Layers,
  DollarSign,
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
  const activePosition = useMarketStore((s) => s.activePosition);
  const autoPilot = useMarketStore((s) => s.autoPilot);
  const setSymbol = useMarketStore((s) => s.setSymbol);
  const setBrokerMode = useMarketStore((s) => s.setBrokerMode);

  const isAudioMuted = useUiStore((s) => s.isAudioMuted);
  const toggleAudioMute = useUiStore((s) => s.toggleAudioMute);
  const setIsScannerModalOpen = useUiStore((s) => s.setIsScannerModalOpen);
  const setIsTimeMachineModalOpen = useUiStore((s) => s.setIsTimeMachineModalOpen);
  const setIsPillarScorecardModalOpen = useUiStore((s) => s.setIsPillarScorecardModalOpen);
  const setIsCooldownModalOpen = useUiStore((s) => s.setIsCooldownModalOpen);
  const setIsPnlModalOpen = useUiStore((s) => s.setIsPnlModalOpen);

  const [isSymbolDropdownOpen, setIsSymbolDropdownOpen] = useState(false);
  const [isSwitchingBroker, setIsSwitchingBroker] = useState(false);
  const [auditExportStatus, setAuditExportStatus] = useState<'idle' | 'exporting' | 'success' | 'error'>('idle');
  const [todayNetPnl, setTodayNetPnl] = useState<number | null>(null);

  useEffect(() => {
    let active = true;
    const syncPnl = () => {
      apiClient
        .getPnlSummary(symbol)
        .then((res) => {
          if (active && typeof res?.today?.netPnl === 'number') {
            setTodayNetPnl(res.today.netPnl);
          }
        })
        .catch(() => {});
    };
    syncPnl();
    const id = window.setInterval(syncPnl, 15_000);
    return () => {
      active = false;
      window.clearInterval(id);
    };
  }, [symbol, account.walletBalance]);

  // Price direction color
  const priceColor =
    markPrice > prevMarkPrice
      ? 'text-[#0ecb81]'
      : markPrice < prevMarkPrice
      ? 'text-[#f6465d]'
      : 'text-[#e6edf3]';

  const isCooldownActive = risk?.cooldown_until ? risk.cooldown_until > Date.now() : false;

  // Background engine continuous uptime tracker
  const [bootTimeMs, setBootTimeMs] = useState<number | null>(null);
  const [nowMs, setNowMs] = useState<number>(Date.now());

  useEffect(() => {
    let isMounted = true;

    const syncHealth = async () => {
      try {
        const data = await apiClient.getHealth();
        if (!isMounted) return;
        if (data.bootTimeMs) {
          setBootTimeMs(data.bootTimeMs);
        } else if (typeof data.uptimeSec === 'number') {
          setBootTimeMs(Date.now() - data.uptimeSec * 1000);
        }
      } catch {
        // network error / server offline
      }
    };

    syncHealth();
    const syncInterval = setInterval(syncHealth, 10000);
    const tickInterval = setInterval(() => {
      setNowMs(Date.now());
    }, 1000);

    return () => {
      isMounted = false;
      clearInterval(syncInterval);
      clearInterval(tickInterval);
    };
  }, []);

  const totalUptimeSec = bootTimeMs ? Math.max(0, Math.floor((nowMs - bootTimeMs) / 1000)) : 0;
  const hours = Math.floor(totalUptimeSec / 3600);
  const minutes = Math.floor((totalUptimeSec % 3600) / 60);
  const seconds = totalUptimeSec % 60;
  const formattedUptime = `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  const startTimeStr = bootTimeMs ? new Date(bootTimeMs).toLocaleTimeString() : 'N/A';

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
            <div className="absolute left-0 mt-1 w-36 bg-[#080c14] border border-[#151d2c] rounded shadow-2xl ring-1 ring-white/10 z-50 py-1">
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
        <div className="flex items-center space-x-2 pl-2 border-r border-[#151d2c] pr-3 mr-2">
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
            ${(account.equity || account.walletBalance || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
          </span>
        </div>

        <div>
          <span className="text-[10px] text-[#7d8590] uppercase block">Available (USDT)</span>
          <span className="font-semibold text-[#0ecb81]">
            ${(account.availableBalance || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
          </span>
        </div>

        {/* Interactive PnL Scorecard Pill */}
        <button
          onClick={() => setIsPnlModalOpen(true)}
          data-testid="pnl-summary-btn"
          className="flex flex-col text-left px-2.5 py-1 rounded border border-[#151d2c] hover:border-[#0ecb81]/50 bg-[#020305] transition-all cursor-pointer group shadow-sm hover:shadow-[0_0_12px_rgba(14,203,129,0.15)]"
          title="Qazanc və Ziyan Hesabatını Aç (Sadə Dildə)"
        >
          <span className="text-[10px] text-[#7d8590] uppercase flex items-center space-x-1 group-hover:text-[#0ecb81]">
            <DollarSign className="w-2.5 h-2.5 text-[#0ecb81]" />
            <span>Qazanc / PnL İcmalı</span>
          </span>
          <span
            className={`font-semibold tabular-nums text-xs ${
              (account.unrealizedPnl && account.unrealizedPnl !== 0
                ? account.unrealizedPnl > 0
                : (todayNetPnl ?? risk.session_net_pnl) >= 0)
                ? 'text-[#0ecb81]'
                : 'text-[#f6465d]'
            }`}
          >
            {account.unrealizedPnl && account.unrealizedPnl !== 0
              ? `${formatUsd(account.unrealizedPnl, true)} (Canlı)`
              : todayNetPnl !== null
                ? `${formatUsd(todayNetPnl, true)} (Bugün)`
                : `${formatUsd(risk.session_net_pnl, true)} (Session)`}
          </span>
        </button>
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

        {/* Pillar Matrix Trigger */}
        <button
          onClick={() => setIsPillarScorecardModalOpen(true)}
          data-testid="pillar-matrix-btn"
          className="flex items-center space-x-1 px-2 py-1 rounded bg-[#020305] border border-[#151d2c] text-[#7d8590] hover:text-[#e6edf3] hover:border-[#7d8590] transition-colors"
          title="Pillar Attribution & Weight Calibration Matrix"
        >
          <Layers className="w-3.5 h-3.5 text-[#00f2fe]" />
          <span className="hidden sm:inline">Pillar Matrix</span>
        </button>

        {/* Background Engine Uptime / Session Live Timer */}
        {wsStatus === 'CONNECTED' ? (
          <div
            className="flex items-center space-x-1.5 px-2.5 py-1 rounded border border-[#0ecb81]/30 bg-[#0ecb81]/10 text-[#0ecb81] font-mono text-xs shadow-sm cursor-help"
            title={`TradeOS 24/7 Arxa Fon İzləmə Müddəti: ${formattedUptime}. Server başlama vaxtı: ${startTimeStr}`}
          >
            <span className="relative flex h-2 w-2">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-[#0ecb81] opacity-75"></span>
              <span className="relative inline-flex rounded-full h-2 w-2 bg-[#0ecb81]"></span>
            </span>
            <Timer className="w-3.5 h-3.5 text-[#0ecb81]" />
            <span className="font-semibold tracking-wider">{formattedUptime}</span>
          </div>
        ) : (
          <div
            className="flex items-center space-x-1.5 px-2.5 py-1 rounded border border-[#f6465d]/30 bg-[#f6465d]/10 text-[#f6465d] font-mono text-xs shadow-sm cursor-help"
            title="Arxa fon serveri ilə əlaqə kəsilib. Engine dayanıb."
          >
            <span className="w-2 h-2 rounded-full bg-[#f6465d]" />
            <Timer className="w-3.5 h-3.5 text-[#f6465d]" />
            <span className="font-semibold tracking-wider">OFFLINE</span>
          </div>
        )}

        {/* Session Trade Cap Alert Badge */}
        {autoPilot?.config?.enabled && autoPilot?.state === 'BLOCKED_SESSION_TRADE_CAP' && (
          <div
            className="flex items-center space-x-1 px-2 py-1 rounded border border-[#f0b90b]/40 bg-[#f0b90b]/15 text-[#f0b90b] font-bold text-xs animate-pulse cursor-help"
            title={`Session Trade Cap Reached (${autoPilot.filledToday || 0}/${autoPilot.config.maxDailyTrades || 5} trades) - AutoPilot Halted until next UTC day`}
          >
            <ShieldAlert className="w-3.5 h-3.5 text-[#f0b90b]" />
            <span>Session Cap ({autoPilot.filledToday || 0}/{autoPilot.config.maxDailyTrades || 5})</span>
          </div>
        )}

        {/* Cooldown Status Badge / Modal Trigger */}
        <button
          onClick={() => setIsCooldownModalOpen(true)}
          className={`flex items-center space-x-1.5 px-2 py-1 rounded border transition-colors ${
            isCooldownActive || (autoPilot?.state === 'COOLDOWN_ACTIVE' && autoPilot?.blockReason === 'BLOCKED_DAILY_MAX_LOSS')
              ? 'bg-[#f6465d]/20 border-[#f6465d]/40 text-[#f6465d] animate-pulse font-bold'
              : 'bg-[#0ecb81]/10 border-[#0ecb81]/30 text-[#0ecb81] hover:bg-[#0ecb81]/20'
          }`}
          title={
            autoPilot?.state === 'COOLDOWN_ACTIVE' && autoPilot?.blockReason === 'BLOCKED_DAILY_MAX_LOSS'
              ? 'Daily 2% Drawdown Ceiling Reached - AutoPilot Locked in Cooldown until 00:00 UTC'
              : 'Risk Diagnostics & Cooldown Status'
          }
        >
          {isCooldownActive || (autoPilot?.state === 'COOLDOWN_ACTIVE' && autoPilot?.blockReason === 'BLOCKED_DAILY_MAX_LOSS') ? (
            <Clock className="w-3.5 h-3.5 text-[#f6465d]" />
          ) : (
            <ShieldCheck className="w-3.5 h-3.5 text-[#0ecb81]" />
          )}
          <span>
            {autoPilot?.state === 'COOLDOWN_ACTIVE' && autoPilot?.blockReason === 'BLOCKED_DAILY_MAX_LOSS'
              ? 'Drawdown Limit Hit (-2.0%)'
              : isCooldownActive
              ? 'Cooldown Active'
              : 'Cooldown: Inactive'}
          </span>
        </button>

        {/* Broker Mode Switch & Testnet Badge */}
        <button
          onClick={handleBrokerToggle}
          disabled={isSwitchingBroker}
          className={`px-2.5 py-1 rounded font-bold transition-colors flex items-center space-x-1.5 ${
            brokerMode === 'BINANCE_DEMO'
              ? 'bg-[#f0b90b]/15 text-[#f0b90b] border border-[#f0b90b]/40 hover:bg-[#f0b90b]/25 shadow-sm'
              : 'bg-[#2962ff]/15 text-[#2962ff] border border-[#2962ff]/40 hover:bg-[#2962ff]/25'
          }`}
          title="Binance Futures Developer Testnet (testnet.binancefuture.com) — Təcrid olunmuş demo mühitdir, telefondakı real hesaba təsir etmir."
        >
          <span className={`w-2 h-2 rounded-full ${brokerMode === 'BINANCE_DEMO' ? 'bg-[#f0b90b] animate-pulse' : 'bg-[#2962ff]'}`} />
          <span>{isSwitchingBroker ? 'Switching...' : brokerMode === 'BINANCE_DEMO' ? 'BINANCE DEMO (TESTNET)' : 'LOCAL PAPER'}</span>
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
