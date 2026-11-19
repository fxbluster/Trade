import React, { useState, useEffect, useRef } from 'react';
import { useMarketStore } from '../store/useMarketStore';
import { useUiStore } from '../store/useUiStore';
import { apiClient } from '../lib/apiClient';
import { soundEffects } from '../lib/audio';
import { computeOrderPreview } from '@tradeos/shared';
import { ShieldAlert, AlertTriangle, ArrowUpRight, ArrowDownRight, CheckCircle2 } from 'lucide-react';

export const OrderTicket: React.FC = () => {
  const symbol = useMarketStore((s) => s.symbol);
  const markPrice = useMarketStore((s) => s.markPrice);
  const account = useMarketStore((s) => s.account);
  const risk = useMarketStore((s) => s.risk);
  const activePosition = useMarketStore((s) => s.activePosition);
  const indicators = useMarketStore((s) => s.indicators);
  const isAudioMuted = useUiStore((s) => s.isAudioMuted);

  const orderDraft = useUiStore((s) => s.orderDraft);
  const setOrderDraft = useUiStore((s) => s.setOrderDraft);
  const setPreview = useUiStore((s) => s.setPreview);

  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [holdProgress, setHoldProgress] = useState(0); // 0 to 100%
  const holdTimerRef = useRef<any>(null);
  const holdIntervalRef = useRef<any>(null);

  // Discretionary manual trading permits presets up to 50.0% of account equity
  const equity = account.equity > 0 ? account.equity : account.walletBalance;
  const maxMarginCap = Math.max(5, Number((equity * 0.50).toFixed(2)));

  // Calculate ATR if available
  const atr = indicators?.atr14 ?? 0;

  // Real-time Preview Calculation
  useEffect(() => {
    if (!markPrice || markPrice <= 0 || orderDraft.marginUsd <= 0) {
      setPreview(null);
      return;
    }

    try {
      const preview = computeOrderPreview(
        {
          symbol,
          side: orderDraft.side,
          orderType: orderDraft.orderType,
          marginUsd: orderDraft.marginUsd,
          leverage: orderDraft.leverage,
          limitPrice: orderDraft.limitPrice,
          stopLoss: orderDraft.stopLoss,
          tp1: orderDraft.tp1,
          tp2: orderDraft.tp2,
        },
        markPrice,
        0.1, // tickSize default
        0.001 // stepSize default
      );
      setPreview(preview);
    } catch (err) {
      console.warn('Preview calculation error:', err);
    }
  }, [
    symbol,
    markPrice,
    orderDraft.side,
    orderDraft.orderType,
    orderDraft.marginUsd,
    orderDraft.leverage,
    orderDraft.limitPrice,
    orderDraft.stopLoss,
    orderDraft.tp1,
    orderDraft.tp2,
    setPreview,
  ]);

  // ATR Preset Helper
  const applyAtrPreset = (type: 'SL' | 'TP1' | 'TP2', multiplier: number) => {
    if (!markPrice || !atr) return;
    const isLong = orderDraft.side === 'BUY';
    const delta = multiplier * atr;

    if (type === 'SL') {
      const sl = isLong ? markPrice - delta : markPrice + delta;
      setOrderDraft({ stopLoss: Number(sl.toFixed(2)) });
    } else if (type === 'TP1') {
      const tp1 = isLong ? markPrice + delta : markPrice - delta;
      setOrderDraft({ tp1: Number(tp1.toFixed(2)) });
    } else if (type === 'TP2') {
      const tp2 = isLong ? markPrice + delta : markPrice - delta;
      setOrderDraft({ tp2: Number(tp2.toFixed(2)) });
    }
  };

  // 400ms Hold-to-Confirm Handler
  const startHold = () => {
    if (isBlocked) return;
    setErrorMessage(null);
    setHoldProgress(0);

    const startTime = Date.now();
    const duration = 400; // 400ms hold

    holdIntervalRef.current = setInterval(() => {
      const elapsed = Date.now() - startTime;
      const progress = Math.min(100, (elapsed / duration) * 100);
      setHoldProgress(progress);
    }, 20);

    holdTimerRef.current = setTimeout(() => {
      clearInterval(holdIntervalRef.current);
      setHoldProgress(100);
      executeOrder();
    }, duration);
  };

  const cancelHold = () => {
    if (holdTimerRef.current) {
      clearTimeout(holdTimerRef.current);
      holdTimerRef.current = null;
    }
    if (holdIntervalRef.current) {
      clearInterval(holdIntervalRef.current);
      holdIntervalRef.current = null;
    }
    setHoldProgress(0);
  };

  const executeOrder = async () => {
    setIsSubmitting(true);
    setErrorMessage(null);

    try {
      const marginAllocationPct = equity > 0
        ? Number(((orderDraft.marginUsd / equity) * 100).toFixed(1))
        : undefined;

      const res = await apiClient.openOrder({
        symbol,
        side: orderDraft.side,
        orderType: orderDraft.orderType,
        marginUsd: orderDraft.marginUsd,
        leverage: orderDraft.leverage,
        marginAllocationPct,
        limitPrice: orderDraft.orderType === 'LIMIT' ? orderDraft.limitPrice : undefined,
        stopLoss: orderDraft.stopLoss,
        tp1: orderDraft.tp1,
        tp2: orderDraft.tp2,
      });

      if (orderDraft.side === 'BUY') {
        soundEffects.playBuy(isAudioMuted);
      } else {
        soundEffects.playSell(isAudioMuted);
      }

      // Refresh state
      await useMarketStore.getState().refreshState();
    } catch (err: any) {
      setErrorMessage(err.message || 'Order execution failed');
      soundEffects.playAlert(isAudioMuted);
    } finally {
      setIsSubmitting(false);
      setHoldProgress(0);
    }
  };

  // Cooldown status check
  const isCooldownActive = risk?.cooldown_until ? risk.cooldown_until > Date.now() : false;
  const deadSlSafe = orderDraft.preview ? orderDraft.preview.deadSlSafe : true;
  const isBlocked = isCooldownActive || !deadSlSafe || isSubmitting;

  return (
    <div className="flex flex-col bg-[#080c14] border border-[#151d2c] rounded-lg p-3 space-y-3 select-none">
      {/* Header: Title & Cap */}
      <div className="flex items-center justify-between pb-2 border-b border-[#151d2c]">
        <div className="flex items-center space-x-1.5">
          <span className="font-mono text-xs font-semibold text-[#e6edf3] uppercase tracking-wider">
            Order Execution
          </span>
          <span className="px-1.5 py-0.5 rounded text-[10px] font-mono bg-[#151d2c] text-[#7d8590]">
            50% Cap: ${maxMarginCap.toFixed(0)}
          </span>
        </div>
        <span className="font-mono text-xs text-[#7d8590]">
          Mark: <strong className="text-[#e6edf3]">{markPrice.toFixed(2)}</strong>
        </span>
      </div>

      {/* LONG / SHORT Tabs */}
      <div className="grid grid-cols-2 gap-2">
        <button
          onClick={() => setOrderDraft({ side: 'BUY' })}
          className={`flex items-center justify-center space-x-1.5 py-2 rounded font-mono text-xs font-bold transition-colors ${
            orderDraft.side === 'BUY'
              ? 'bg-[#0ecb81] text-[#020305] shadow-lg shadow-[#0ecb81]/20'
              : 'bg-[#151d2c] text-[#7d8590] hover:text-[#e6edf3]'
          }`}
        >
          <ArrowUpRight className="w-3.5 h-3.5" />
          <span>LONG / BUY</span>
        </button>

        <button
          onClick={() => setOrderDraft({ side: 'SELL' })}
          className={`flex items-center justify-center space-x-1.5 py-2 rounded font-mono text-xs font-bold transition-colors ${
            orderDraft.side === 'SELL'
              ? 'bg-[#f6465d] text-white shadow-lg shadow-[#f6465d]/20'
              : 'bg-[#151d2c] text-[#7d8590] hover:text-[#e6edf3]'
          }`}
        >
          <ArrowDownRight className="w-3.5 h-3.5" />
          <span>SHORT / SELL</span>
        </button>
      </div>

      {/* MARKET / LIMIT Switch */}
      <div className="flex items-center justify-between bg-[#020305] p-1 rounded border border-[#151d2c]">
        <button
          onClick={() => setOrderDraft({ orderType: 'MARKET' })}
          className={`flex-1 py-1 text-xs font-mono rounded text-center transition-colors ${
            orderDraft.orderType === 'MARKET'
              ? 'bg-[#151d2c] text-[#e6edf3] font-semibold'
              : 'text-[#7d8590] hover:text-[#e6edf3]'
          }`}
        >
          MARKET
        </button>
        <button
          onClick={() => setOrderDraft({ orderType: 'LIMIT' })}
          className={`flex-1 py-1 text-xs font-mono rounded text-center transition-colors ${
            orderDraft.orderType === 'LIMIT'
              ? 'bg-[#151d2c] text-[#e6edf3] font-semibold'
              : 'text-[#7d8590] hover:text-[#e6edf3]'
          }`}
        >
          LIMIT
        </button>
      </div>

      {/* Limit Price Input (if LIMIT) */}
      {orderDraft.orderType === 'LIMIT' && (
        <div className="space-y-1">
          <label className="text-[11px] font-mono text-[#7d8590] uppercase">Limit Price (USDT)</label>
          <input
            type="number"
            value={orderDraft.limitPrice ?? markPrice}
            onChange={(e) => setOrderDraft({ limitPrice: parseFloat(e.target.value) || 0 })}
            className="w-full bg-[#020305] border border-[#151d2c] rounded px-2.5 py-1.5 font-mono text-xs text-[#e6edf3] focus:border-[#2962ff] focus:outline-none"
          />
        </div>
      )}

      {/* Margin Input & 10% Cap Chips */}
      <div className="space-y-1.5">
        <div className="flex items-center justify-between">
          <label className="text-[11px] font-mono text-[#7d8590] uppercase">Margin Allocation ($)</label>
          <span className="text-[11px] font-mono text-[#7d8590]">
            Cap: ${maxMarginCap.toFixed(2)}
          </span>
        </div>
        <div className="flex items-center space-x-2">
          <input
            type="number"
            min="1"
            max={maxMarginCap}
            step="1"
            value={orderDraft.marginUsd}
            onChange={(e) => {
              const val = parseFloat(e.target.value) || 0;
              setOrderDraft({ marginUsd: Math.min(val, maxMarginCap) });
            }}
            className="flex-1 bg-[#020305] border border-[#151d2c] rounded px-2.5 py-1.5 font-mono text-xs text-[#e6edf3] focus:border-[#2962ff] focus:outline-none"
          />
        </div>

        {/* Expanded 2.5%, 5.0%, 10.0%, 25.0%, 50.0% Margin Quick-Select Chips */}
        <div className="grid grid-cols-5 gap-1 pt-1">
          {[2.5, 5.0, 10.0, 25.0, 50.0].map((pct) => {
            const amount = Number((equity * (pct / 100)).toFixed(2));
            const isSelected = Math.abs(orderDraft.marginUsd - amount) < 0.1;
            return (
              <button
                key={pct}
                onClick={() => setOrderDraft({ marginUsd: amount })}
                className={`py-1 text-[10px] font-mono rounded border transition-colors ${
                  isSelected
                    ? pct >= 25
                      ? 'border-[#f6465d] bg-[#f6465d]/20 text-[#f6465d] font-bold'
                      : 'border-[#2962ff] bg-[#2962ff]/20 text-[#e6edf3] font-bold'
                    : 'border-[#151d2c] bg-[#020305] text-[#7d8590] hover:border-[#7d8590]'
                }`}
                title={`Allocate ${pct}% ($${amount.toFixed(0)}) of equity`}
              >
                {pct.toFixed(pct < 10 ? 1 : 0)}%
              </button>
            );
          })}
        </div>
      </div>

      {/* Leverage Slider */}
      <div className="space-y-1">
        <div className="flex items-center justify-between">
          <label className="text-[11px] font-mono text-[#7d8590] uppercase">Leverage</label>
          <span className="px-1.5 py-0.5 rounded text-[11px] font-mono font-bold bg-[#151d2c] text-[#f0b90b]">
            {orderDraft.leverage}x
          </span>
        </div>
        <input
          type="range"
          min="1"
          max="50"
          value={orderDraft.leverage}
          onChange={(e) => setOrderDraft({ leverage: parseInt(e.target.value, 10) })}
          className="w-full accent-[#f0b90b] cursor-pointer bg-[#151d2c] h-1.5 rounded-lg"
        />
      </div>

      {/* Stop Loss & ATR Presets */}
      <div className="space-y-1.5">
        <div className="flex items-center justify-between">
          <label className="text-[11px] font-mono text-[#7d8590] uppercase">Stop Loss (USDT)</label>
          {atr > 0 && (
            <span className="text-[10px] font-mono text-[#7d8590]">ATR(14): {atr.toFixed(1)}</span>
          )}
        </div>
        <input
          type="number"
          placeholder="Stop Loss Price"
          value={orderDraft.stopLoss ?? ''}
          onChange={(e) =>
            setOrderDraft({ stopLoss: e.target.value ? parseFloat(e.target.value) : undefined })
          }
          className="w-full bg-[#020305] border border-[#151d2c] rounded px-2.5 py-1.5 font-mono text-xs text-[#e6edf3] focus:border-[#f6465d] focus:outline-none"
        />
        {atr > 0 && (
          <div className="flex items-center space-x-1">
            {[1.5, 2.0, 3.0].map((m) => (
              <button
                key={m}
                onClick={() => applyAtrPreset('SL', m)}
                className="flex-1 py-0.5 text-[10px] font-mono rounded bg-[#020305] border border-[#151d2c] text-[#7d8590] hover:text-[#f6465d] hover:border-[#f6465d]"
              >
                -{m}x ATR
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Take Profit 1 & 2 Presets */}
      <div className="grid grid-cols-2 gap-2">
        <div className="space-y-1">
          <label className="text-[10px] font-mono text-[#7d8590] uppercase">TP1 (50%)</label>
          <input
            type="number"
            placeholder="TP1 Price"
            value={orderDraft.tp1 ?? ''}
            onChange={(e) =>
              setOrderDraft({ tp1: e.target.value ? parseFloat(e.target.value) : undefined })
            }
            className="w-full bg-[#020305] border border-[#151d2c] rounded px-2 py-1 font-mono text-xs text-[#e6edf3] focus:border-[#0ecb81] focus:outline-none"
          />
          {atr > 0 && (
            <button
              onClick={() => applyAtrPreset('TP1', 2.0)}
              className="w-full py-0.5 text-[10px] font-mono rounded bg-[#020305] border border-[#151d2c] text-[#7d8590] hover:text-[#0ecb81]"
            >
              +2x ATR
            </button>
          )}
        </div>

        <div className="space-y-1">
          <label className="text-[10px] font-mono text-[#7d8590] uppercase">TP2 (Runner)</label>
          <input
            type="number"
            placeholder="TP2 Price"
            value={orderDraft.tp2 ?? ''}
            onChange={(e) =>
              setOrderDraft({ tp2: e.target.value ? parseFloat(e.target.value) : undefined })
            }
            className="w-full bg-[#020305] border border-[#151d2c] rounded px-2 py-1 font-mono text-xs text-[#e6edf3] focus:border-[#0ecb81] focus:outline-none"
          />
          {atr > 0 && (
            <button
              onClick={() => applyAtrPreset('TP2', 3.5)}
              className="w-full py-0.5 text-[10px] font-mono rounded bg-[#020305] border border-[#151d2c] text-[#7d8590] hover:text-[#0ecb81]"
            >
              +3.5x ATR
            </button>
          )}
        </div>
      </div>

      {/* Pre-Trade Metrics Box */}
      {orderDraft.preview && (
        <div className="bg-[#020305] border border-[#151d2c] rounded p-2.5 space-y-1.5 text-xs font-mono">
          <div className="flex justify-between text-[#7d8590]">
            <span>Est. Quantity / Notional:</span>
            <span className="text-[#e6edf3]">
              {orderDraft.preview.quantity} ({orderDraft.preview.notionalUsd}$)
            </span>
          </div>

          <div className="flex justify-between text-[#7d8590]">
            <span>Est. Liquidation:</span>
            <span className="text-[#f6465d] font-bold">
              {orderDraft.preview.estimatedLiquidation.toFixed(2)}
            </span>
          </div>

          <div className="flex justify-between text-[#7d8590]">
            <span>Risk : Reward:</span>
            <span className={orderDraft.preview.rrRatio >= 1.5 ? 'text-[#0ecb81] font-bold' : 'text-[#f0b90b]'}>
              1 : {orderDraft.preview.rrRatio.toFixed(2)}
            </span>
          </div>

          <div className="flex justify-between text-[#7d8590]">
            <span>Max Loss USD:</span>
            <span className="text-[#f6465d]">-${orderDraft.preview.maxLossUsd.toFixed(2)}</span>
          </div>

          <div className="flex justify-between text-[#7d8590]">
            <span>Breakeven (0.15% fee):</span>
            <span className="text-[#f0b90b]">{orderDraft.preview.breakevenPrice.toFixed(2)}</span>
          </div>

          {/* Dead-SL Armor Alert */}
          {!deadSlSafe && (
            <div className="flex items-center space-x-1.5 p-1.5 mt-1 rounded bg-[#f6465d]/10 border border-[#f6465d]/30 text-[#f6465d] text-[11px]">
              <ShieldAlert className="w-4 h-4 flex-shrink-0" />
              <span>DEAD-SL BLOCKED: SL is past liquidation level!</span>
            </div>
          )}
        </div>
      )}

      {/* Error Message if Any */}
      {errorMessage && (
        <div className="flex items-center space-x-1.5 p-2 rounded bg-[#f6465d]/10 border border-[#f6465d]/30 text-[#f6465d] text-xs">
          <AlertTriangle className="w-4 h-4 flex-shrink-0" />
          <span>{errorMessage}</span>
        </div>
      )}

      {/* Cooldown Warning if Active */}
      {isCooldownActive && (
        <div className="flex items-center space-x-1.5 p-2 rounded bg-amber-500/10 border border-amber-500/30 text-amber-400 text-xs font-mono">
          <ShieldAlert className="w-4 h-4 flex-shrink-0" />
          <span>COOLDOWN ACTIVE: Trading locked until cooldown expires.</span>
        </div>
      )}

      {/* 400ms Hold-to-Confirm Submit Button */}
      <div className="relative pt-1">
        <button
          disabled={isBlocked}
          onMouseDown={startHold}
          onMouseUp={cancelHold}
          onMouseLeave={cancelHold}
          onTouchStart={startHold}
          onTouchEnd={cancelHold}
          className={`relative w-full py-3 rounded font-mono text-xs font-bold uppercase overflow-hidden transition-all ${
            isBlocked
              ? 'bg-[#151d2c] text-[#7d8590] cursor-not-allowed'
              : orderDraft.side === 'BUY'
              ? 'bg-[#0ecb81] text-[#020305] shadow-lg shadow-[#0ecb81]/25 hover:bg-[#0bb573]'
              : 'bg-[#f6465d] text-white shadow-lg shadow-[#f6465d]/25 hover:bg-[#e0394f]'
          }`}
        >
          {/* Animated Hold Progress Fill */}
          <div
            className="absolute left-0 top-0 bottom-0 bg-white/20 transition-all duration-75 pointer-events-none"
            style={{ width: `${holdProgress}%` }}
          />

          <span className="relative z-10 flex items-center justify-center space-x-2">
            {isSubmitting ? (
              <span>Executing Order...</span>
            ) : isCooldownActive ? (
              <span>Cooldown Locked</span>
            ) : !deadSlSafe ? (
              <span>Dead-SL Blocked</span>
            ) : holdProgress > 0 ? (
              <span>Hold To Confirm ({Math.round(holdProgress)}%)</span>
            ) : (
              <span>Hold 400ms to {orderDraft.side === 'BUY' ? 'LONG' : 'SHORT'}</span>
            )}
          </span>
        </button>
      </div>
    </div>
  );
};
