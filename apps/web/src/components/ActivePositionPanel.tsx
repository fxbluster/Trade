import React, { useState, useEffect } from 'react';
import { useMarketStore } from '../store/useMarketStore';
import { useUiStore } from '../store/useUiStore';
import { apiClient } from '../lib/apiClient';
import { soundEffects } from '../lib/audio';
import { formatUsd } from '../lib/formatters';
import { calculateLiquidationPrice } from '@tradeos/shared';
import { ShieldCheck, XCircle, ArrowUpRight, ArrowDownRight, AlertCircle, DollarSign } from 'lucide-react';

export const ActivePositionPanel: React.FC = () => {
  const symbol = useMarketStore((s) => s.symbol);
  const activePosition = useMarketStore((s) => s.activePosition);
  const activePositions = useMarketStore((s) => s.activePositions);
  const exchangePositions = useMarketStore((s) => s.exchangePositions);
  const markPrice = useMarketStore((s) => s.markPrice);
  const isAudioMuted = useUiStore((s) => s.isAudioMuted);
  const setIsPnlModalOpen = useUiStore((s) => s.setIsPnlModalOpen);

  const [isBreakevenLoading, setIsBreakevenLoading] = useState(false);
  const [isCloseLoading, setIsCloseLoading] = useState(false);
  const [closingOrphanSymbol, setClosingOrphanSymbol] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const otherTrackedPositions = activePositions.filter(
    (p) => p.symbol.toUpperCase() !== symbol.toUpperCase() && p.status !== 'CLOSED'
  );
  const untrackedExchangePositions = exchangePositions.filter((ep) => !ep.tracked);
  const hasOtherPositions = otherTrackedPositions.length > 0 || untrackedExchangePositions.length > 0;

  useEffect(() => {
    if (!hasOtherPositions) return;
    const id = setInterval(() => {
      void useMarketStore.getState().refreshState();
    }, 2000);
    return () => clearInterval(id);
  }, [hasOtherPositions]);

  const handleCloseUntracked = async (sym: string) => {
    if (!window.confirm(`Close untracked ${sym} position on exchange at Market?`)) return;
    setClosingOrphanSymbol(sym);
    setActionError(null);
    try {
      await apiClient.closeOrder(sym, 'MANUAL_ORPHAN_CLOSE');
      soundEffects.playAlert(isAudioMuted);
      await useMarketStore.getState().refreshState();
    } catch (err: any) {
      setActionError(err.message || `Failed to close untracked ${sym}`);
    } finally {
      setClosingOrphanSymbol(null);
    }
  };

  const fmtPrice = (p: number) => p.toFixed(p < 10 ? 4 : 2);

  const renderOtherPositionsStrip = () => {
    if (otherTrackedPositions.length === 0 && untrackedExchangePositions.length === 0) {
      return null;
    }
    return (
      <div className="flex flex-col space-y-1.5">
        {otherTrackedPositions.map((pos) => {
          const exPos = exchangePositions.find(
            (ep) => ep.symbol.toUpperCase() === pos.symbol.toUpperCase()
          );
          const livePnl = exPos?.unRealizedProfit;
          const curMark = exPos && exPos.markPrice > 0 ? exPos.markPrice : 0;
          const isFavorable =
            curMark > 0 &&
            (pos.side === 'BUY' ? curMark >= pos.entry_price : curMark <= pos.entry_price);
          return (
            <div
              key={pos.id}
              className="flex items-center justify-between px-2.5 py-1.5 rounded bg-[#0d1421] border border-[#0ecb81]/30"
            >
              <div className="flex items-center space-x-2 flex-wrap">
                <span className="font-bold text-[#e6edf3]">{pos.symbol}</span>
                <span
                  className={`px-1.5 py-0.5 rounded text-[10px] font-bold ${
                    pos.side === 'BUY' ? 'bg-[#0ecb81]/20 text-[#0ecb81]' : 'bg-[#f6465d]/20 text-[#f6465d]'
                  }`}
                >
                  {pos.side === 'BUY' ? 'LONG' : 'SHORT'} {pos.leverage}x
                </span>
                {typeof livePnl === 'number' && (
                  <span
                    className={`font-bold px-1.5 py-0.5 rounded text-[11px] ${
                      livePnl >= 0
                        ? 'bg-[#0ecb81]/15 text-[#0ecb81]'
                        : 'bg-[#f6465d]/15 text-[#f6465d]'
                    }`}
                  >
                    {livePnl >= 0 ? '+' : ''}${livePnl.toFixed(2)}
                  </span>
                )}
                <span className="text-[#8b949e]">
                  Marja: <span className="text-[#e6edf3]">${pos.margin_usd.toFixed(2)}</span>
                </span>
                <span className="text-[#8b949e]">
                  Giriş: <span className="text-[#e6edf3]">${fmtPrice(pos.entry_price)}</span>
                </span>
                {curMark > 0 && (
                  <span className="text-[#8b949e]">
                    Cari:{' '}
                    <span className={isFavorable ? 'text-[#0ecb81]' : 'text-[#f6465d]'}>
                      ${fmtPrice(curMark)}
                    </span>
                  </span>
                )}
                <span className="text-[#7d8590]">
                  Qty: {pos.remaining_qty}
                </span>
              </div>
              <button
                onClick={() => useMarketStore.getState().setSymbol(pos.symbol)}
                className="px-2.5 py-1 rounded bg-[#0ecb81]/20 hover:bg-[#0ecb81]/30 text-[#0ecb81] font-bold transition-colors"
              >
                {pos.symbol}-ə keç
              </button>
            </div>
          );
        })}

        {untrackedExchangePositions.map((ep) => {
          const isLong = ep.positionAmt > 0;
          const estMargin = (Math.abs(ep.positionAmt) * ep.entryPrice) / Math.max(1, ep.leverage);
          const isFavorable = isLong ? ep.markPrice >= ep.entryPrice : ep.markPrice <= ep.entryPrice;
          return (
            <div
              key={ep.symbol}
              className="flex items-center justify-between px-2.5 py-1.5 rounded bg-amber-500/10 border border-amber-500/40"
            >
              <div className="flex items-center space-x-2 flex-wrap">
                <span className="font-bold text-[#e6edf3]">{ep.symbol}</span>
                <span className="px-1.5 py-0.5 rounded text-[10px] font-bold bg-amber-500/20 text-amber-300">
                  BİRJADA AÇIQ (PANEL XARİCİ)
                </span>
                <span
                  className={`px-1.5 py-0.5 rounded text-[10px] font-bold ${
                    isLong ? 'bg-[#0ecb81]/20 text-[#0ecb81]' : 'bg-[#f6465d]/20 text-[#f6465d]'
                  }`}
                >
                  {isLong ? 'LONG' : 'SHORT'} {ep.leverage}x
                </span>
                <span className={ep.unRealizedProfit >= 0 ? 'text-[#0ecb81]' : 'text-[#f6465d]'}>
                  {ep.unRealizedProfit >= 0 ? '+' : ''}${ep.unRealizedProfit.toFixed(2)}
                </span>
                <span className="text-[#8b949e]">
                  Marja: <span className="text-[#e6edf3]">${estMargin.toFixed(2)}</span>
                </span>
                <span className="text-[#8b949e]">
                  Giriş: <span className="text-[#e6edf3]">${fmtPrice(ep.entryPrice)}</span>
                </span>
                <span className="text-[#8b949e]">
                  Cari:{' '}
                  <span className={isFavorable ? 'text-[#0ecb81]' : 'text-[#f6465d]'}>
                    ${fmtPrice(ep.markPrice)}
                  </span>
                </span>
              </div>
              <button
                disabled={closingOrphanSymbol === ep.symbol}
                onClick={() => handleCloseUntracked(ep.symbol)}
                className="px-2.5 py-1 rounded bg-[#f6465d]/20 hover:bg-[#f6465d]/30 text-[#f6465d] font-bold transition-colors disabled:opacity-50"
              >
                {closingOrphanSymbol === ep.symbol ? 'Bağlanır...' : 'Market Bağla'}
              </button>
            </div>
          );
        })}
      </div>
    );
  };

  if (!activePosition || activePosition.status === 'CLOSED' || activePosition.symbol.toUpperCase() !== symbol.toUpperCase()) {
    if (otherTrackedPositions.length > 0 || untrackedExchangePositions.length > 0) {
      return (
        <div className="flex flex-col space-y-2.5 p-3 bg-[#080c14] rounded-lg border border-[#151d2c] font-mono text-xs select-none overflow-y-auto custom-scrollbar">
          {renderOtherPositionsStrip()}

          {actionError && (
            <div className="flex items-center space-x-1.5 text-[#f6465d] text-[11px]">
              <AlertCircle className="w-3.5 h-3.5" />
              <span>{actionError}</span>
            </div>
          )}
        </div>
      );
    }

    return (
      <div className="flex flex-col items-center justify-center h-48 text-[#7d8590] select-none p-4">
        <ShieldCheck className="w-8 h-8 mb-2 opacity-30 text-[#0ecb81]" />
        <span className="font-mono text-xs">No Active Leveraged Position</span>
        <span className="text-[11px] text-[#484f58] mt-1">Capital is safely hedged in cash wallet</span>
        <button
          onClick={() => setIsPnlModalOpen(true)}
          className="mt-3 px-3 py-1.5 rounded bg-[#151d2c] hover:bg-[#1f2937] text-[#0ecb81] text-xs font-mono transition-colors flex items-center space-x-1.5 border border-[#151d2c] hover:border-[#0ecb81]/40"
        >
          <DollarSign className="w-3.5 h-3.5" />
          <span>Qazanc & Performans İcmalına Bax</span>
        </button>
      </div>
    );
  }

  const isLong = activePosition.side === 'BUY';
  const entryPrice = activePosition.entry_price;
  const priceDecimals = entryPrice < 10 ? 4 : 2;
  const currentPrice = markPrice > 0 ? markPrice : entryPrice;
  const leverage = activePosition.leverage;

  // ROE% Calculation
  const priceDiff = isLong ? currentPrice - entryPrice : entryPrice - currentPrice;
  const roePercent = entryPrice > 0 ? (priceDiff / entryPrice) * leverage * 100 : 0;
  const unrealizedPnlUsd = Number((priceDiff * activePosition.remaining_qty).toFixed(2));

  // Liquidation Price & Safety Buffer
  const liqPrice = calculateLiquidationPrice(activePosition.side, entryPrice, leverage);
  const liqDistPercent = currentPrice > 0 && liqPrice > 0
    ? isLong
      ? ((currentPrice - liqPrice) / currentPrice) * 100
      : ((liqPrice - currentPrice) / currentPrice) * 100
    : 0;

  const isLiqCritical = liqDistPercent < 5;

  // Handle 1-Click Breakeven
  const handleBreakeven = async () => {
    setIsBreakevenLoading(true);
    setActionError(null);
    try {
      await apiClient.moveToBreakeven(activePosition.symbol);
      soundEffects.playBreakeven(isAudioMuted);
      await useMarketStore.getState().refreshState();
    } catch (err: any) {
      setActionError(err.message || 'Failed to move SL to Breakeven');
      soundEffects.playAlert(isAudioMuted);
    } finally {
      setIsBreakevenLoading(false);
    }
  };

  // Handle Market Close
  const handleMarketClose = async () => {
    if (!window.confirm(`Close active ${activePosition.side} position on ${activePosition.symbol} at Market?`)) {
      return;
    }
    setIsCloseLoading(true);
    setActionError(null);
    try {
      await apiClient.closeOrder(activePosition.symbol, 'MANUAL_COCKPIT_CLOSE');
      soundEffects.playAlert(isAudioMuted);
      await useMarketStore.getState().refreshState();
    } catch (err: any) {
      setActionError(err.message || 'Failed to close position');
    } finally {
      setIsCloseLoading(false);
    }
  };

  return (
    <div className="flex flex-col space-y-2.5 p-3 bg-[#080c14] rounded-lg border border-[#151d2c] font-mono text-xs select-none overflow-y-auto custom-scrollbar">
      {renderOtherPositionsStrip()}

      {/* Top Banner: Symbol, Side, ROE */}
      <div className="flex items-center justify-between pb-2 border-b border-[#151d2c]">
        <div className="flex items-center space-x-2">
          <span className="font-bold text-sm text-[#e6edf3]">{activePosition.symbol}</span>
          <span
            className={`flex items-center px-2 py-0.5 rounded text-[11px] font-bold ${
              isLong ? 'bg-[#0ecb81]/20 text-[#0ecb81]' : 'bg-[#f6465d]/20 text-[#f6465d]'
            }`}
          >
            {isLong ? <ArrowUpRight className="w-3 h-3 mr-0.5" /> : <ArrowDownRight className="w-3 h-3 mr-0.5" />}
            {isLong ? 'LONG' : 'SHORT'} {leverage}x
          </span>
          {activePosition.is_breakeven === 1 && (
            <span className="px-1.5 py-0.5 rounded text-[10px] bg-amber-500/20 text-amber-400 border border-amber-500/30">
              BREAKEVEN ACTIVE
            </span>
          )}
        </div>

        {/* ROE & Unrealized PnL */}
        <div className="text-right">
          <span
            className={`text-base font-bold tracking-tight ${
              roePercent >= 0 ? 'text-[#0ecb81]' : 'text-[#f6465d]'
            }`}
          >
            {roePercent >= 0 ? '+' : ''}
            {roePercent.toFixed(2)}%
          </span>
          <span className="text-[11px] text-[#7d8590] ml-2">
            ({formatUsd(unrealizedPnlUsd, true)})
          </span>
        </div>
      </div>

      {/* Position Metrics Grid */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 bg-[#020305] p-2.5 rounded border border-[#151d2c]">
        <div>
          <span className="text-[10px] text-[#7d8590] uppercase block">Entry Price</span>
          <span className="text-[#e6edf3] font-semibold">{entryPrice.toFixed(priceDecimals)}</span>
        </div>

        <div>
          <span className="text-[10px] text-[#7d8590] uppercase block">Mark Price</span>
          <span className="text-[#e6edf3] font-semibold">{currentPrice.toFixed(priceDecimals)}</span>
        </div>

        <div>
          <span className="text-[10px] text-[#7d8590] uppercase block">Remaining Qty</span>
          <span className="text-[#e6edf3] font-semibold">{activePosition.remaining_qty}</span>
        </div>

        <div>
          <span className="text-[10px] text-[#7d8590] uppercase block">Margin Allocated</span>
          <span className="text-[#e6edf3] font-semibold">${activePosition.margin_usd.toFixed(2)}</span>
        </div>

        <div>
          <span className="text-[10px] text-[#7d8590] uppercase block">Active Stop Loss</span>
          <span className="text-[#f6465d] font-semibold">
            {activePosition.stop_loss ? activePosition.stop_loss.toFixed(priceDecimals) : 'NONE'}
          </span>
        </div>

        <div>
          <span className="text-[10px] text-[#7d8590] uppercase block">Take Profit 1</span>
          <span className="text-[#0ecb81] font-semibold">
            {activePosition.tp1 ? activePosition.tp1.toFixed(priceDecimals) : 'NONE'}
          </span>
        </div>

        <div>
          <span className="text-[10px] text-[#7d8590] uppercase block">Take Profit 2</span>
          <span className="text-[#10b981] font-semibold">
            {activePosition.tp2 ? activePosition.tp2.toFixed(priceDecimals) : 'NONE'}
          </span>
        </div>

        <div>
          <span className="text-[10px] text-[#7d8590] uppercase block">Liquidation Price</span>
          <span
            className={`font-semibold ${
              isLiqCritical ? 'text-[#f6465d] animate-pulse font-bold' : 'text-[#7d8590]'
            }`}
          >
            {liqPrice.toFixed(priceDecimals)} ({liqDistPercent.toFixed(1)}% dist)
          </span>
        </div>
      </div>

      {/* Quick PnL Horizon Multi-Period Bar */}
      <div
        onClick={() => setIsPnlModalOpen(true)}
        className="flex items-center justify-between p-2 bg-[#020305] rounded border border-[#151d2c] hover:border-[#0ecb81]/40 transition-colors cursor-pointer group"
        title="Bütün dövrlər üzrə tam qazanc/ziyan hesabatını aç (Sadə Dildə)"
      >
        <span className="text-[11px] text-[#7d8590] flex items-center space-x-1 group-hover:text-[#e6edf3]">
          <DollarSign className="w-3.5 h-3.5 text-[#0ecb81]" />
          <span>Performans & Qazanc İcmalı:</span>
        </span>
        <div className="flex items-center space-x-2 text-[11px]">
          <span className="px-1.5 py-0.5 rounded bg-[#0ecb81]/15 text-[#0ecb81] font-bold">
            Canlı: {unrealizedPnlUsd >= 0 ? '+' : ''}${unrealizedPnlUsd.toFixed(2)}
          </span>
          <span className="text-[#3b82f6] group-hover:underline text-[10px] font-semibold">
            Ətraflı Bax ➔
          </span>
        </div>
      </div>

      {/* Error Notice */}
      {actionError && (
        <div className="flex items-center space-x-1.5 p-2 rounded bg-[#f6465d]/10 border border-[#f6465d]/30 text-[#f6465d] text-xs">
          <AlertCircle className="w-4 h-4 flex-shrink-0" />
          <span>{actionError}</span>
        </div>
      )}

      {/* Execution Actions: 1-Click Breakeven & Market Close */}
      <div className="flex items-center space-x-2 pt-1">
        <button
          onClick={handleBreakeven}
          disabled={isBreakevenLoading || activePosition.is_breakeven === 1}
          className={`flex-1 flex items-center justify-center space-x-1.5 py-2 rounded font-bold transition-colors ${
            activePosition.is_breakeven === 1
              ? 'bg-[#151d2c] text-[#7d8590] cursor-not-allowed border border-[#151d2c]'
              : 'bg-amber-500/20 text-amber-400 border border-amber-500/40 hover:bg-amber-500/30'
          }`}
        >
          <ShieldCheck className="w-3.5 h-3.5" />
          <span>
            {isBreakevenLoading
              ? 'Moving to BE...'
              : activePosition.is_breakeven === 1
              ? 'At Breakeven'
              : '1-Click Breakeven'}
          </span>
        </button>

        <button
          onClick={handleMarketClose}
          disabled={isCloseLoading}
          className="flex-1 flex items-center justify-center space-x-1.5 py-2 rounded font-bold bg-[#f6465d]/20 text-[#f6465d] border border-[#f6465d]/40 hover:bg-[#f6465d]/30 transition-colors"
        >
          <XCircle className="w-3.5 h-3.5" />
          <span>{isCloseLoading ? 'Closing...' : 'Market Close'}</span>
        </button>
      </div>
    </div>
  );
};
