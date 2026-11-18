import React, { useEffect } from 'react';
import { TopBar } from './components/TopBar';
import { ChartCanvas } from './components/ChartCanvas';
import { OrderTicket } from './components/OrderTicket';
import { ActivePositionPanel } from './components/ActivePositionPanel';
import { OpenOrdersPanel } from './components/OpenOrdersPanel';
import { TradeJournalPanel } from './components/TradeJournalPanel';
import { SokratMentorPanel } from './components/SokratMentorPanel';
import { CooldownModal } from './components/CooldownModal';
import { ScannerModal } from './components/ScannerModal';
import { TimeMachineModal } from './components/TimeMachineModal';
import { useMarketStore } from './store/useMarketStore';
import { useUiStore } from './store/useUiStore';
import { wsClient } from './lib/wsClient';
import { soundEffects } from './lib/audio';
import { ShieldCheck, ListOrdered, BookOpen } from 'lucide-react';

export const App: React.FC = () => {
  const activePosition = useMarketStore((s) => s.activePosition);
  const openOrders = useMarketStore((s) => s.openOrders);
  const activeBottomTab = useUiStore((s) => s.activeBottomTab);
  const setActiveBottomTab = useUiStore((s) => s.setActiveBottomTab);
  const isAudioMuted = useUiStore((s) => s.isAudioMuted);

  // Initialize REST and WebSocket Connections
  useEffect(() => {
    const marketStore = useMarketStore.getState();

    // 1. Initial State & Kline fetch
    marketStore.refreshState().catch((err) => console.warn('Initial state fetch error:', err));
    marketStore.refreshKlines().catch((err) => console.warn('Initial klines fetch error:', err));

    // 2. Configure WebSocket Handlers
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
        if (event.event === 'OPENED') {
          soundEffects.playBuy(isAudioMuted);
        } else if (event.event === 'CLOSED') {
          soundEffects.playAlert(isAudioMuted);
        } else if (event.event === 'BREAKEVEN') {
          soundEffects.playBreakeven(isAudioMuted);
        }
      },
      onAlert: (alert) => {
        if (alert.level === 'CRITICAL') {
          soundEffects.playAlert(isAudioMuted);
        }
      },
      onStatusChange: (status) => {
        useMarketStore.getState().setWsStatus(status);
      },
    });

    // 3. Connect WebSocket
    wsClient.connect();

    return () => {
      wsClient.disconnect();
    };
  }, [isAudioMuted]);

  return (
    <div className="flex flex-col h-screen w-screen bg-[#020305] text-[#e6edf3] font-sans overflow-hidden select-none">
      {/* 1. Global Navigation TopBar */}
      <TopBar />

      {/* 2. Main 70 / 30 Two-Column Layout */}
      <main className="flex-1 flex overflow-hidden p-2 gap-2">
        {/* Left / Center Zone (70%): Chart & Cockpit Bottom Tabs */}
        <section className="flex-[7] flex flex-col min-w-0 h-full gap-2">
          {/* Chart Canvas Area */}
          <div className="flex-[6] min-h-[350px] relative">
            <ChartCanvas className="h-full" />
          </div>

          {/* Bottom Cockpit Panel with Tab Switcher */}
          <div className="flex-[4] flex flex-col min-h-[220px] bg-[#080c14] border border-[#151d2c] rounded-lg overflow-hidden">
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
            </div>

            {/* Tab Body */}
            <div className="flex-1 overflow-y-auto p-2">
              {activeBottomTab === 'POSITION' && <ActivePositionPanel />}
              {activeBottomTab === 'ORDERS' && <OpenOrdersPanel />}
              {activeBottomTab === 'JOURNAL' && <TradeJournalPanel />}
            </div>
          </div>
        </section>

        {/* Right Rail (30%): Order Execution Ticket & Sokrat Mentor */}
        <aside className="flex-[3] flex flex-col min-w-[340px] max-w-[420px] h-full gap-2 overflow-y-auto">
          <OrderTicket />
          <SokratMentorPanel />
        </aside>
      </main>

      {/* 3. Modal Overlays */}
      <CooldownModal />
      <ScannerModal />
      <TimeMachineModal />
    </div>
  );
};

export default App;
