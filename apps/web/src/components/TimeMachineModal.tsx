import React, { useState, useEffect } from 'react';
import { useUiStore } from '../store/useUiStore';
import { useMarketStore } from '../store/useMarketStore';
import { Cpu, X, Play, ShieldAlert, Award, Clock } from 'lucide-react';

export const TimeMachineModal: React.FC = () => {
  const isTimeMachineModalOpen = useUiStore((s) => s.isTimeMachineModalOpen);
  const setIsTimeMachineModalOpen = useUiStore((s) => s.setIsTimeMachineModalOpen);

  const klines = useMarketStore((s) => s.klines);
  const markPrice = useMarketStore((s) => s.markPrice);
  const indicators = useMarketStore((s) => s.indicators);
  const orderDraft = useUiStore((s) => s.orderDraft);

  const [isRunning, setIsRunning] = useState(false);
  const [winProb, setWinProb] = useState<number | null>(null);
  const [lossProb, setLossProb] = useState<number | null>(null);
  const [timeoutProb, setTimeoutProb] = useState<number | null>(null);
  const [expectedSteps, setExpectedSteps] = useState<number | null>(null);

  const isLong = orderDraft.side === 'BUY';
  const entry = orderDraft.limitPrice && orderDraft.orderType === 'LIMIT'
    ? orderDraft.limitPrice
    : markPrice;

  const effectiveAtr = indicators?.atr14 && indicators.atr14 > 0
    ? indicators.atr14
    : (entry > 0 ? entry * 0.015 : 1.0);

  const activeSl = orderDraft.stopLoss && orderDraft.stopLoss > 0
    ? orderDraft.stopLoss
    : (entry > 0 ? Number((isLong ? entry - 1.5 * effectiveAtr : entry + 1.5 * effectiveAtr).toFixed(2)) : 0);

  const activeTp = (orderDraft.tp1 && orderDraft.tp1 > 0)
    ? orderDraft.tp1
    : (orderDraft.tp2 && orderDraft.tp2 > 0)
    ? orderDraft.tp2
    : (entry > 0 ? Number((isLong ? entry + 2.0 * effectiveAtr : entry - 2.0 * effectiveAtr).toFixed(2)) : 0);

  const runSimulation = () => {
    if (!entry || entry <= 0 || !activeSl || !activeTp) return;
    setIsRunning(true);

    setTimeout(() => {
      try {
        const sl = activeSl;
        const tp = activeTp;

        // Calculate empirical log return standard deviation from klines
        let stdev = 0.003; // fallback 0.3% per candle
        if (klines.length > 20) {
          const returns: number[] = [];
          for (let i = 1; i < klines.length; i++) {
            const prev = klines[i - 1].close;
            const curr = klines[i].close;
            if (prev > 0 && curr > 0) {
              returns.push(Math.log(curr / prev));
            }
          }
          if (returns.length > 0) {
            const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
            const variance =
              returns.reduce((sum, r) => sum + Math.pow(r - mean, 2), 0) / returns.length;
            stdev = Math.max(0.0005, Math.sqrt(variance));
          }
        }

        // 10,000 Monte Carlo Paths, max 288 steps (24 hours at 5m)
        const NUM_PATHS = 10000;
        const MAX_STEPS = 288;
        let hitsTp = 0;
        let hitsSl = 0;
        let timeouts = 0;
        let totalStepsToExit = 0;

        for (let p = 0; p < NUM_PATHS; p++) {
          let price = entry;
          let exited = false;

          for (let step = 1; step <= MAX_STEPS; step++) {
            // Box-Muller Gaussian random variable
            const u1 = Math.max(1e-10, Math.random());
            const u2 = Math.random();
            const z = Math.sqrt(-2.0 * Math.log(u1)) * Math.cos(2.0 * Math.PI * u2);

            price = price * Math.exp(z * stdev);

            if (isLong) {
              if (price >= tp) {
                hitsTp++;
                totalStepsToExit += step;
                exited = true;
                break;
              } else if (price <= sl) {
                hitsSl++;
                totalStepsToExit += step;
                exited = true;
                break;
              }
            } else {
              if (price <= tp) {
                hitsTp++;
                totalStepsToExit += step;
                exited = true;
                break;
              } else if (price >= sl) {
                hitsSl++;
                totalStepsToExit += step;
                exited = true;
                break;
              }
            }
          }

          if (!exited) {
            timeouts++;
            totalStepsToExit += MAX_STEPS;
          }
        }

        setWinProb(Number((hitsTp / NUM_PATHS).toFixed(3)));
        setLossProb(Number((hitsSl / NUM_PATHS).toFixed(3)));
        setTimeoutProb(Number((timeouts / NUM_PATHS).toFixed(3)));
        setExpectedSteps(Math.round(totalStepsToExit / NUM_PATHS));
      } finally {
        setIsRunning(false);
      }
    }, 50);
  };

  useEffect(() => {
    if (isTimeMachineModalOpen) {
      runSimulation();
    }
  }, [isTimeMachineModalOpen]);

  if (!isTimeMachineModalOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-4 font-mono select-none">
      <div className="relative w-full max-w-lg bg-[#080c14] border border-[#151d2c] rounded-xl shadow-2xl p-6 text-xs space-y-4">
        {/* Header */}
        <div className="flex items-center justify-between pb-3 border-b border-[#151d2c]">
          <div className="flex items-center space-x-2">
            <Cpu className="w-5 h-5 text-[#8b5cf6]" />
            <h2 className="text-sm font-bold uppercase tracking-wider text-[#e6edf3]">
              10k Monte Carlo Time Machine
            </h2>
          </div>
          <button
            onClick={() => setIsTimeMachineModalOpen(false)}
            className="text-[#7d8590] hover:text-[#e6edf3] transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Order Setup Summary */}
        <div className="bg-[#020305] p-3 rounded border border-[#151d2c] space-y-1">
          <span className="text-[10px] text-[#7d8590] uppercase block">Trade Simulation Parameters</span>
          <div className="grid grid-cols-3 gap-2 pt-1 font-semibold text-[#e6edf3]">
            <div>
              <span className="text-[10px] text-[#7d8590] block">Direction</span>
              <span className={orderDraft.side === 'BUY' ? 'text-[#0ecb81]' : 'text-[#f6465d]'}>
                {orderDraft.side === 'BUY' ? 'LONG' : 'SHORT'}
              </span>
            </div>
            <div>
              <span className="text-[10px] text-[#7d8590] block">Target SL</span>
              <span className="text-[#f6465d]">
                {orderDraft.stopLoss ? `$${orderDraft.stopLoss}` : `$${activeSl} (1.5x ATR)`}
              </span>
            </div>
            <div>
              <span className="text-[10px] text-[#7d8590] block">Target TP</span>
              <span className="text-[#0ecb81]">
                {orderDraft.tp1 ? `$${orderDraft.tp1}` : orderDraft.tp2 ? `$${orderDraft.tp2}` : `$${activeTp} (2.0x ATR)`}
              </span>
            </div>
          </div>
        </div>

        {/* Simulation Results Breakdown */}
        {winProb !== null && lossProb !== null && (
          <div className="space-y-3">
            {/* Visual Probability Distribution Bar */}
            <div className="space-y-1">
              <span className="text-[10px] text-[#7d8590] uppercase block">
                First-Hitting-Time (FHT) Probability
              </span>
              <div className="h-6 w-full rounded overflow-hidden flex bg-[#151d2c] font-bold text-[10px]">
                <div
                  style={{ width: `${winProb * 100}%` }}
                  className="bg-[#0ecb81] text-[#020305] flex items-center justify-center transition-all duration-300"
                >
                  {(winProb * 100).toFixed(1)}% TP
                </div>
                <div
                  style={{ width: `${lossProb * 100}%` }}
                  className="bg-[#f6465d] text-white flex items-center justify-center transition-all duration-300"
                >
                  {(lossProb * 100).toFixed(1)}% SL
                </div>
                {timeoutProb !== null && timeoutProb > 0.01 ? (
                  <div
                    style={{ width: `${timeoutProb * 100}%` }}
                    className="bg-[#7d8590] text-[#020305] flex items-center justify-center transition-all duration-300"
                  >
                    {(timeoutProb * 100).toFixed(0)}%
                  </div>
                ) : null}
              </div>
            </div>

            {/* Metrics Grid */}
            <div className="grid grid-cols-3 gap-2">
              <div className="bg-[#020305] p-2.5 rounded border border-[#151d2c]">
                <span className="text-[10px] text-[#7d8590] uppercase block">Win Probability</span>
                <span className="text-base font-bold text-[#0ecb81]">
                  {(winProb * 100).toFixed(1)}%
                </span>
              </div>

              <div className="bg-[#020305] p-2.5 rounded border border-[#151d2c]">
                <span className="text-[10px] text-[#7d8590] uppercase block">Loss Probability</span>
                <span className="text-base font-bold text-[#f6465d]">
                  {(lossProb * 100).toFixed(1)}%
                </span>
              </div>

              <div className="bg-[#020305] p-2.5 rounded border border-[#151d2c]">
                <span className="text-[10px] text-[#7d8590] uppercase block">Avg Hold Time</span>
                <span className="text-base font-bold text-[#e6edf3]">
                  {expectedSteps ? `${Math.round((expectedSteps * 5) / 60)}h ${((expectedSteps * 5) % 60)}m` : '--'}
                </span>
              </div>
            </div>
          </div>
        )}

        {/* Action Button */}
        <div className="pt-2">
          <button
            onClick={runSimulation}
            disabled={isRunning}
            className="w-full flex items-center justify-center space-x-2 py-2.5 rounded font-bold bg-[#8b5cf6]/20 text-[#8b5cf6] border border-[#8b5cf6]/40 hover:bg-[#8b5cf6]/30 transition-colors"
          >
            <Play className={`w-3.5 h-3.5 ${isRunning ? 'animate-spin' : ''}`} />
            <span>{isRunning ? 'Simulating 10,000 Paths...' : 'Rerun 10k Monte Carlo Simulation'}</span>
          </button>
        </div>
      </div>
    </div>
  );
};
