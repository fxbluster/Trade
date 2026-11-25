import React from 'react';
import { BarChart2, Brain, Trophy } from 'lucide-react';
import { useMarketStore } from '../store/useMarketStore';
import { useUiStore, type WorkspaceViewType } from '../store/useUiStore';
import { formatUsd } from '../lib/formatters';

function getQuantBadgeTone(action: string | undefined): string {
  switch (action) {
    case 'STRONG_BUY':
    case 'BUY':
      return 'bg-[#0ecb81]/15 text-[#0ecb81] border-[#0ecb81]/40';
    case 'STRONG_SELL':
    case 'SELL':
      return 'bg-[#f6465d]/15 text-[#f6465d] border-[#f6465d]/40';
    case 'WAIT':
    case 'GÖZLƏ':
    default:
      return 'bg-[#f0b90b]/15 text-[#f0b90b] border-[#f0b90b]/40';
  }
}

function getTabButtonClass(isActive: boolean): string {
  return isActive
    ? 'flex items-center gap-1.5 px-2.5 py-1 rounded border border-[#2962ff]/50 bg-[#151d2c] text-[#e6edf3] font-bold whitespace-nowrap transition-colors'
    : 'flex items-center gap-1.5 px-2.5 py-1 rounded border border-transparent bg-transparent text-[#7d8590] hover:text-[#e6edf3] hover:bg-[#151d2c]/60 whitespace-nowrap transition-colors';
}

export const WorkspaceNavBar: React.FC = () => {
  const activeWorkspaceView = useUiStore((s) => s.activeWorkspaceView);
  const setActiveWorkspaceView = useUiStore((s) => s.setActiveWorkspaceView);

  const activePosition = useMarketStore((s) => s.activePosition);
  const propFirmStatus = useMarketStore((s) => s.propFirmStatus);
  const confluence = useMarketStore((s) => s.confluence);

  const hasOpenPosition = Boolean(activePosition && activePosition.status !== 'CLOSED');

  const cycleNumber = propFirmStatus?.cycle?.cycleNumber;
  const cycleStatus = propFirmStatus?.cycle?.status;
  const needsTopUp = propFirmStatus?.needsTopUp === true;
  const showPropFirmAlertDot = Boolean(
    needsTopUp ||
      (typeof cycleStatus === 'string' &&
        (cycleStatus.startsWith('HALTED_') || cycleStatus.startsWith('FAILED_')))
  );

  const netPnlUsd = propFirmStatus?.cycle?.netPnlUsd ?? 0;
  const formattedNetPnl = formatUsd(netPnlUsd, true);
  const propFirmPnlColor =
    netPnlUsd > 0
      ? 'text-[#0ecb81]'
      : netPnlUsd < 0
      ? 'text-[#f6465d]'
      : 'text-[#e6edf3]';

  const quantScore = confluence && Number.isFinite(confluence.compositeScore)
    ? Math.round(confluence.compositeScore)
    : 0;
  const quantAction = confluence?.recommendedAction ?? 'GÖZLƏ';
  const quantBadgeTone = getQuantBadgeTone(quantAction);

  const handleSelectView = (view: WorkspaceViewType) => {
    setActiveWorkspaceView(view);
  };

  return (
    <nav
      data-testid="workspace-nav-bar"
      aria-label="Workspace Navigation"
      className="h-9 min-h-[36px] flex-shrink-0 px-3 py-1 bg-[#080c14] border-b border-[#151d2c] font-mono text-xs flex items-center justify-between gap-2 overflow-hidden select-none"
    >
      {/* Left: 3 Instant-Switch Workspace Tabs */}
      <div className="flex items-center gap-1.5 min-w-0">
        <button
          type="button"
          data-testid="workspace-tab-TRADING"
          aria-pressed={activeWorkspaceView === 'TRADING'}
          onClick={() => handleSelectView('TRADING')}
          className={getTabButtonClass(activeWorkspaceView === 'TRADING')}
        >
          <BarChart2 className="w-3.5 h-3.5 text-[#0ecb81] flex-shrink-0" />
          <span>Ticarət</span>
          {hasOpenPosition && (
            <span
              data-testid="workspace-trading-open-badge"
              className="px-1.5 py-0.5 rounded-full bg-[#0ecb81]/15 text-[#0ecb81] border border-[#0ecb81]/40 text-[10px] font-bold leading-none whitespace-nowrap"
            >
              1 Açıq
            </span>
          )}
        </button>

        <button
          type="button"
          data-testid="workspace-tab-PROPFIRM"
          aria-pressed={activeWorkspaceView === 'PROPFIRM'}
          onClick={() => handleSelectView('PROPFIRM')}
          className={getTabButtonClass(activeWorkspaceView === 'PROPFIRM')}
        >
          <Trophy className="w-3.5 h-3.5 text-[#f0b90b] flex-shrink-0" />
          <span>Fon Hesabı ($50K)</span>
          {typeof cycleNumber === 'number' && (
            <span className="px-1 py-0.5 rounded bg-[#020305] border border-[#151d2c] text-[#7d8590] text-[10px] font-semibold leading-none tabular-nums">
              #{cycleNumber}
            </span>
          )}
          {showPropFirmAlertDot && (
            <span
              data-testid="workspace-propfirm-alert-dot"
              className="w-2 h-2 rounded-full bg-[#f0b90b] flex-shrink-0"
              title="Diqqət: Top-Up tələb olunur və ya dövrə limiti aktivdir"
            />
          )}
        </button>

        <button
          type="button"
          data-testid="workspace-tab-QUANT"
          aria-pressed={activeWorkspaceView === 'QUANT'}
          onClick={() => handleSelectView('QUANT')}
          className={getTabButtonClass(activeWorkspaceView === 'QUANT')}
        >
          <Brain className="w-3.5 h-3.5 text-[#8b5cf6] flex-shrink-0" />
          <span>Kvant &amp; Loqlar</span>
          {confluence && (
            <span
              className={`px-1.5 py-0.5 rounded border text-[10px] font-bold leading-none tabular-nums whitespace-nowrap ${quantBadgeTone}`}
            >
              {quantScore}% {quantAction}
            </span>
          )}
        </button>
      </div>

      {/* Right: Clickable 1-Line Live Telemetry Status Pills */}
      <div className="flex items-center gap-1.5 flex-shrink-0">
        <button
          type="button"
          data-testid="workspace-pill-propfirm"
          onClick={() => handleSelectView('PROPFIRM')}
          className="flex items-center gap-1.5 px-2 py-0.5 rounded bg-[#020305] border border-[#151d2c] hover:border-[#f0b90b]/50 text-[#7d8590] hover:text-[#e6edf3] whitespace-nowrap tabular-nums transition-colors"
          title="Fon Hesabı ($50K) görünüşünə keç"
        >
          <span>Upcomers:</span>
          <span className={`font-semibold ${propFirmPnlColor}`}>{formattedNetPnl}</span>
          <span className="text-[#7d8590]">/ +$2,500</span>
        </button>

        <button
          type="button"
          data-testid="workspace-pill-quant"
          onClick={() => handleSelectView('QUANT')}
          className="flex items-center gap-1.5 px-2 py-0.5 rounded bg-[#020305] border border-[#151d2c] hover:border-[#8b5cf6]/50 text-[#7d8590] hover:text-[#e6edf3] whitespace-nowrap tabular-nums transition-colors"
          title="Kvant & Loqlar görünüşünə keç"
        >
          <span>Skor:</span>
          <span className="font-semibold text-[#e6edf3]">
            {quantScore}% {quantAction}
          </span>
        </button>

        {needsTopUp && (
          <a
            data-testid="workspace-pill-topup"
            href="https://testnet.binancefuture.com"
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center px-2 py-0.5 rounded bg-[#f0b90b]/15 border border-[#f0b90b]/40 text-[#f0b90b] hover:bg-[#f0b90b]/25 font-bold whitespace-nowrap tabular-nums transition-colors"
            title="Binance Futures Testnet Faucet aç"
          >
            Top-Up $50K ↗
          </a>
        )}
      </div>
    </nav>
  );
};
