import React, { useEffect, useState } from 'react';
import { TopBar } from './components/TopBar';
import { WorkspaceNavBar } from './components/WorkspaceNavBar';
import { PropFirmChallengeHUD } from './components/PropFirmChallengeHUD';
import { ConfluenceHUD } from './components/ConfluenceHUD';
import { AutoPilotControls } from './components/AutoPilotControls';
import { ChartCanvas } from './components/ChartCanvas';
import { OrderTicket } from './components/OrderTicket';
import { ActivePositionPanel } from './components/ActivePositionPanel';
import { OpenOrdersPanel } from './components/OpenOrdersPanel';
import { TradeJournalPanel } from './components/TradeJournalPanel';
import { AgentTelemetryPanel } from './components/AgentTelemetryPanel';
import { SokratMentorPanel } from './components/SokratMentorPanel';
import { CooldownModal } from './components/CooldownModal';
import { ScannerModal } from './components/ScannerModal';
import { TimeMachineModal } from './components/TimeMachineModal';
import { PillarScorecardModal } from './components/PillarScorecardModal';
import { PnLSummaryModal } from './components/PnLSummaryModal';
import { useMarketStore } from './store/useMarketStore';
import { useUiStore } from './store/useUiStore';
import { wsClient } from './lib/wsClient';
import {
  apiClient,
  getSessionToken,
  isPinRequiredError,
  onPinRequired,
  setOperatorPin,
} from './lib/apiClient';
import { soundEffects } from './lib/audio';
import { ShieldCheck, ListOrdered, BookOpen, Activity, Lock } from 'lucide-react';

export const App: React.FC = () => {
  const activePosition = useMarketStore((s) => s.activePosition);
  const openOrders = useMarketStore((s) => s.openOrders);
  const activeBottomTab = useUiStore((s) => s.activeBottomTab);
  const setActiveBottomTab = useUiStore((s) => s.setActiveBottomTab);
  const isBottomExpanded = useUiStore((s) => s.isBottomExpanded);
  const rightRailTab = useUiStore((s) => s.rightRailTab);
  const setRightRailTab = useUiStore((s) => s.setRightRailTab);
  const activeWorkspaceView = useUiStore((s) => s.activeWorkspaceView);

  const [isPinGateOpen, setIsPinGateOpen] = useState(false);
  const [pinInput, setPinInput] = useState('');
  const [pinError, setPinError] = useState<string | null>(null);
  const [isVerifyingPin, setIsVerifyingPin] = useState(false);

  const bootstrapCockpit = () => {
    const marketStore = useMarketStore.getState();

    marketStore
      .refreshState()
      .then(() => marketStore.refreshKlines())
      .catch((err) => {
        if (isPinRequiredError(err) || (err as { status?: number })?.status === 401) {
          setIsPinGateOpen(true);
          return;
        }
        console.warn('Initial state/klines fetch error:', err);
      });
    marketStore.refreshConfluence().catch((err) => {
      if (isPinRequiredError(err) || (err as { status?: number })?.status === 401) {
        setIsPinGateOpen(true);
      }
    });
    marketStore.refreshPropFirmStatus().catch((err) => {
      if (isPinRequiredError(err) || (err as { status?: number })?.status === 401) {
        setIsPinGateOpen(true);
      }
    });

    wsClient.connect();

    apiClient.getScanner()
      .then((items: any) => {
        if (Array.isArray(items) && items.length > 0) {
          useMarketStore.getState().setCachedScannerItems(items);
        }
      })
      .catch((err: any) => {
        if (isPinRequiredError(err) || err?.status === 401) {
          setIsPinGateOpen(true);
          return;
        }
        console.warn('Background scanner pre-cache warning:', err);
      });
  };

  // Initialize REST and WebSocket Connections
  useEffect(() => {
    const unsubscribePinRequired = onPinRequired(() => {
      setIsPinGateOpen(true);
    });

    // 1. Configure WebSocket Handlers
    wsClient.setHandlers({
      onSnapshot: (snap) => {
        useMarketStore.getState().applySnapshot(snap);
      },
      onTick: (tick) => {
        useMarketStore.getState().applyTick(tick);
      },
      onAnalysis: (analysis) => {
        useMarketStore.getState().applyAnalysis(analysis);
      },
      onPositionEvent: (event) => {
        useMarketStore.getState().applyPositionEvent(event);
        const muted = useUiStore.getState().isAudioMuted;
        if (event.event === 'OPENED') {
          soundEffects.playBuy(muted);
        } else if (event.event === 'CLOSED') {
          soundEffects.playAlert(muted);
        } else if (event.event === 'BREAKEVEN') {
          soundEffects.playBreakeven(muted);
        }
      },
      onAlert: (alert) => {
        if (alert.level === 'CRITICAL') {
          soundEffects.playAlert(useUiStore.getState().isAudioMuted);
        }
      },
      onConfluence: (confluence) => {
        useMarketStore.getState().setConfluence(confluence);
      },
      onAutoPilotStatus: (status) => {
        useMarketStore.getState().setAutoPilotStatus(status);
      },
      onFactorTelemetry: (ev) => {
        useMarketStore.getState().addTelemetryEvent(ev);
      },
      onPropFirmStatus: (status) => {
        useMarketStore.getState().setPropFirmStatus(status);
      },
      onStatusChange: (status) => {
        useMarketStore.getState().setWsStatus(status);
      },
    });

    // 2. Initial State, Kline, Confluence & WebSocket bootstrap
    bootstrapCockpit();

    return () => {
      unsubscribePinRequired();
      wsClient.disconnect();
    };
  }, []);

  const handlePinSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = pinInput.trim();
    if (!trimmed) {
      setPinError('Please enter your operator access PIN.');
      return;
    }

    setIsVerifyingPin(true);
    setPinError(null);
    setOperatorPin(trimmed);

    try {
      await getSessionToken();
      setIsPinGateOpen(false);
      setPinInput('');
      setPinError(null);
      bootstrapCockpit();
    } catch (err: any) {
      if (isPinRequiredError(err) || err?.status === 401) {
        setPinError('Invalid operator PIN. Please check OPERATOR_ACCESS_PIN and try again.');
      } else {
        setPinError(err?.message || 'Unable to verify operator PIN.');
      }
    } finally {
      setIsVerifyingPin(false);
    }
  };

  return (
    <div className="flex flex-col h-screen w-screen bg-[#020305] text-[#e6edf3] font-sans overflow-hidden select-none">
      {/* 1. Global Navigation TopBar */}
      <TopBar />

      {/* 1b. Slim 3-View Workspace Navigation Bar */}
      <WorkspaceNavBar />

      {/* 2. Main 70 / 30 Two-Column Cockpit Layout */}
      <main className="flex-1 flex min-h-0 overflow-hidden p-2 gap-2">
        {/* Left / Center Zone (70%): Active Workspace View */}
        <section
          data-testid="workspace-main-canvas"
          className="flex-[7] flex flex-col min-w-0 h-full gap-2 overflow-hidden"
        >
          {activeWorkspaceView === 'TRADING' && (
            <div
              data-testid="workspace-view-TRADING"
              className="flex-1 flex flex-col min-h-0 gap-2 overflow-hidden"
            >
              {/* Chart Canvas Area */}
              <div
                className={`${
                  isBottomExpanded ? 'flex-[3] min-h-[220px]' : 'flex-[6] min-h-[280px]'
                } relative overflow-hidden transition-all duration-200`}
              >
                <ChartCanvas className="h-full" />
              </div>

              {/* Bottom Cockpit Panel with Tab Switcher */}
              <div
                data-testid="cockpit-bottom-panel"
                className={`${
                  isBottomExpanded ? 'flex-[7] min-h-[300px] max-h-[55vh]' : 'flex-[4] min-h-[240px]'
                } flex flex-col bg-[#080c14] border border-[#151d2c] rounded-lg overflow-hidden transition-all duration-200`}
              >
                {/* Tab Header */}
                <div className="flex items-center space-x-1 px-3 py-1.5 border-b border-[#151d2c] bg-[#020305] font-mono text-xs">
                  <button
                    onClick={() => setActiveBottomTab('POSITION')}
                    className={`flex items-center space-x-1.5 px-3 py-1 rounded transition-colors ${
                      activeBottomTab === 'POSITION'
                        ? 'bg-[#151d2c] text-[#0ecb81] font-bold'
                        : 'text-[#7d8590] hover:text-[#e6edf3]'
                    }`}
                  >
                    <ShieldCheck className="w-3.5 h-3.5" />
                    <span>Active Position</span>
                    {activePosition && activePosition.status !== 'CLOSED' && (
                      <span className="w-2 h-2 rounded-full bg-[#0ecb81] animate-pulse" />
                    )}
                  </button>

                  <button
                    onClick={() => setActiveBottomTab('ORDERS')}
                    className={`flex items-center space-x-1.5 px-3 py-1 rounded transition-colors ${
                      activeBottomTab === 'ORDERS'
                        ? 'bg-[#151d2c] text-[#2962ff] font-bold'
                        : 'text-[#7d8590] hover:text-[#e6edf3]'
                    }`}
                  >
                    <ListOrdered className="w-3.5 h-3.5" />
                    <span>Open Orders</span>
                    {openOrders.length > 0 && (
                      <span className="px-1.5 py-0.2 rounded text-[10px] bg-[#2962ff]/20 text-[#2962ff] font-bold">
                        {openOrders.length}
                      </span>
                    )}
                  </button>

                  <button
                    onClick={() => setActiveBottomTab('JOURNAL')}
                    className={`flex items-center space-x-1.5 px-3 py-1 rounded transition-colors ${
                      activeBottomTab === 'JOURNAL'
                        ? 'bg-[#151d2c] text-[#e6edf3] font-bold'
                        : 'text-[#7d8590] hover:text-[#e6edf3]'
                    }`}
                  >
                    <BookOpen className="w-3.5 h-3.5" />
                    <span>Trade Journal</span>
                  </button>

                  <button
                    onClick={() => setActiveBottomTab('TELEMETRY')}
                    className={`flex items-center space-x-1.5 px-3 py-1 rounded transition-colors ${
                      activeBottomTab === 'TELEMETRY'
                        ? 'bg-[#151d2c] text-[#00bcd4] font-bold'
                        : 'text-[#7d8590] hover:text-[#e6edf3]'
                    }`}
                  >
                    <Activity className="w-3.5 h-3.5" />
                    <span>Agent Loqları</span>
                  </button>
                </div>

                {/* Tab Body */}
                <div className="flex-1 overflow-y-auto p-2">
                  {activeBottomTab === 'POSITION' && <ActivePositionPanel />}
                  {activeBottomTab === 'ORDERS' && <OpenOrdersPanel />}
                  {activeBottomTab === 'JOURNAL' && <TradeJournalPanel />}
                  {activeBottomTab === 'TELEMETRY' && <AgentTelemetryPanel />}
                </div>
              </div>
            </div>
          )}

          {activeWorkspaceView === 'PROPFIRM' && (
            <div
              data-testid="workspace-view-PROPFIRM"
              className="flex-1 overflow-y-auto space-y-2 pr-1 custom-scrollbar"
            >
              <PropFirmChallengeHUD defaultHistoryOpen={true} />
              <div className="bg-[#080c14] border border-[#151d2c] rounded-lg p-2">
                <TradeJournalPanel />
              </div>
            </div>
          )}

          {activeWorkspaceView === 'QUANT' && (
            <div
              data-testid="workspace-view-QUANT"
              className="flex-1 overflow-y-auto space-y-2 pr-1 custom-scrollbar"
            >
              <ConfluenceHUD />
              <div className="min-h-[380px] bg-[#080c14] border border-[#151d2c] rounded-lg p-2">
                <AgentTelemetryPanel />
              </div>
            </div>
          )}
        </section>

        {/* Right Rail: Pinned Flight Deck Header, Switcher between Order Form and Telemetry */}
        <aside
          className={`${
            rightRailTab === 'TELEMETRY'
              ? 'flex-[4] min-w-[380px] max-w-[500px]'
              : 'flex-[3] min-w-[340px] max-w-[420px]'
          } flex flex-col h-full gap-2 overflow-hidden transition-all duration-200`}
        >
          {/* Pinned Executive Flight Deck (Static, Never Scrolls) */}
          <div className="flex-shrink-0">
            <AutoPilotControls />
          </div>

          {/* Right Rail View Switcher Tab Header */}
          <div className="flex items-center space-x-1 p-1 bg-[#020305] border border-[#151d2c] rounded font-mono text-[11px] flex-shrink-0">
            <button
              onClick={() => setRightRailTab('ORDER_TICKET')}
              className={`flex-1 py-1 px-2 rounded text-center transition-colors ${
                rightRailTab === 'ORDER_TICKET'
                  ? 'bg-[#151d2c] text-[#e6edf3] font-bold'
                  : 'text-[#7d8590] hover:text-[#e6edf3]'
              }`}
            >
              ⚡ Əmr & Mentor
            </button>
            <button
              onClick={() => setRightRailTab('TELEMETRY')}
              className={`flex-1 py-1 px-2 rounded text-center transition-colors flex items-center justify-center space-x-1 ${
                rightRailTab === 'TELEMETRY'
                  ? 'bg-[#00bcd4]/20 text-[#00bcd4] font-bold border border-[#00bcd4]/40'
                  : 'text-[#7d8590] hover:text-[#e6edf3]'
              }`}
            >
              <Activity className="w-3.5 h-3.5 mr-1" />
              <span>Agent Loqları</span>
            </button>
          </div>

          {/* Content View */}
          {rightRailTab === 'TELEMETRY' ? (
            <div className="flex-1 overflow-hidden">
              <AgentTelemetryPanel isDockedRight={true} />
            </div>
          ) : (
            <div className="flex-1 overflow-y-auto space-y-2 pr-1 custom-scrollbar">
              <OrderTicket />
              <SokratMentorPanel />
            </div>
          )}
        </aside>
      </main>

      {/* 3. Modal Overlays */}
      <CooldownModal />
      <ScannerModal />
      <TimeMachineModal />
      <PillarScorecardModal />
      <PnLSummaryModal />

      {isPinGateOpen && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="pin-gate-title"
          data-testid="pin-gate-modal"
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-4"
        >
          <form
            onSubmit={handlePinSubmit}
            className="w-full max-w-sm bg-[#080c14] border border-[#151d2c] rounded-lg p-5 space-y-4 font-mono shadow-2xl"
          >
            <div className="flex items-center space-x-2 text-[#e6edf3]">
              <Lock className="w-4 h-4 text-[#2962ff]" />
              <h2 id="pin-gate-title" className="text-sm font-bold uppercase tracking-wider">
                Operator Authentication Required
              </h2>
            </div>

            <p className="text-xs text-[#7d8590]">
              Enter the server&apos;s <span className="text-[#e6edf3]">OPERATOR_ACCESS_PIN</span> to unlock this remote session.
            </p>

            <div className="space-y-1.5">
              <label
                htmlFor="operator-pin-input"
                className="block text-[11px] text-[#7d8590] uppercase"
              >
                Operator Access PIN
              </label>
              <input
                id="operator-pin-input"
                type="password"
                autoFocus
                autoComplete="current-password"
                value={pinInput}
                onChange={(e) => setPinInput(e.target.value)}
                placeholder="Enter operator PIN"
                className="w-full bg-[#020305] border border-[#151d2c] rounded px-3 py-2 text-xs text-[#e6edf3] focus:border-[#2962ff] focus:outline-none"
              />
            </div>

            {pinError && (
              <div
                role="alert"
                className="p-2 rounded bg-[#f6465d]/10 border border-[#f6465d]/30 text-[#f6465d] text-xs"
              >
                {pinError}
              </div>
            )}

            <button
              type="submit"
              disabled={isVerifyingPin}
              className="w-full py-2 rounded bg-[#2962ff] hover:bg-[#1e53e5] disabled:opacity-50 text-white text-xs font-bold uppercase tracking-wider transition-colors"
            >
              {isVerifyingPin ? 'Verifying...' : 'Unlock Session'}
            </button>
          </form>
        </div>
      )}
    </div>
  );
};

export default App;
