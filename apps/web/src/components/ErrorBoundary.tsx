import React, { Component, type ErrorInfo, type ReactNode } from 'react';
import { AlertTriangle, RefreshCw } from 'lucide-react';

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  public state: State = {
    hasError: false,
    error: null,
  };

  public static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  public componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error('[TradeOS v2] Uncaught UI Error caught by boundary:', error, errorInfo);
  }

  public render() {
    if (this.state.hasError) {
      return (
        <div className="flex flex-col items-center justify-center h-screen w-screen bg-[#020305] text-[#e6edf3] p-6 font-mono select-none">
          <div className="max-w-md w-full bg-[#080c14] border border-[#f6465d]/40 rounded-xl p-6 shadow-2xl flex flex-col items-center text-center">
            <div className="w-12 h-12 rounded-full bg-[#f6465d]/10 border border-[#f6465d]/30 flex items-center justify-center text-[#f6465d] mb-4">
              <AlertTriangle className="w-6 h-6" />
            </div>
            <h1 className="text-lg font-bold text-[#e6edf3] mb-2">TradeOS Cockpit Recovery</h1>
            <p className="text-xs text-[#7d8590] mb-4 leading-relaxed">
              A temporary rendering anomaly occurred. Your open orders and active positions remain fully protected by the backend.
            </p>
            {this.state.error && (
              <div className="w-full bg-[#020305] border border-[#151d2c] rounded p-3 text-[11px] text-[#f6465d] text-left mb-5 overflow-x-auto max-h-32">
                {this.state.error.message}
              </div>
            )}
            <button
              onClick={() => window.location.reload()}
              className="flex items-center space-x-2 px-5 py-2.5 rounded bg-[#2962ff] hover:bg-[#2962ff]/90 text-white font-bold text-xs transition-colors shadow-lg cursor-pointer"
            >
              <RefreshCw className="w-3.5 h-3.5 animate-spin-reverse" />
              <span>Reload Cockpit</span>
            </button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
