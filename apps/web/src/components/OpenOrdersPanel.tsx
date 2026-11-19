import React, { useState } from 'react';
import { useMarketStore } from '../store/useMarketStore';
import { apiClient } from '../lib/apiClient';
import { Trash2, Ban, RefreshCw } from 'lucide-react';

export const OpenOrdersPanel: React.FC = () => {
  const openOrders = useMarketStore((s) => s.openOrders);
  const symbol = useMarketStore((s) => s.symbol);
  const refreshState = useMarketStore((s) => s.refreshState);

  const [cancellingId, setCancellingId] = useState<string | null>(null);
  const [isCancellingAll, setIsCancellingAll] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const handleCancelOrder = async (orderId: string, orderSymbol: string, isAlgo: boolean) => {
    setCancellingId(orderId);
    setErrorMsg(null);
    try {
      await apiClient.cancelOrder(orderId, orderSymbol, isAlgo);
      await refreshState();
    } catch (err: any) {
      setErrorMsg(err.message || 'Failed to cancel order');
    } finally {
      setCancellingId(null);
    }
  };

  const handleCancelAll = async () => {
    if (!window.confirm('Cancel all pending orders and algos?')) return;
    setIsCancellingAll(true);
    setErrorMsg(null);
    try {
      for (const order of openOrders) {
        await apiClient.cancelOrder(order.orderId, order.symbol, order.isAlgo);
      }
      await refreshState();
    } catch (err: any) {
      setErrorMsg(err.message || 'Failed to cancel all orders');
    } finally {
      setIsCancellingAll(false);
    }
  };

  return (
    <div className="flex flex-col h-full bg-[#080c14] border border-[#151d2c] rounded-lg p-3 font-mono text-xs select-none">
      {/* Top Header */}
      <div className="flex items-center justify-between pb-2 mb-2 border-b border-[#151d2c]">
        <div className="flex items-center space-x-2">
          <span className="font-bold text-[#e6edf3]">Open Orders & Algo Brackets</span>
          <span className="px-1.5 py-0.5 rounded text-[10px] bg-[#151d2c] text-[#7d8590]">
            {openOrders.length} Active
          </span>
        </div>

        {openOrders.length > 0 && (
          <button
            onClick={handleCancelAll}
            disabled={isCancellingAll}
            className="flex items-center space-x-1 px-2.5 py-1 rounded bg-[#f6465d]/10 text-[#f6465d] border border-[#f6465d]/20 hover:bg-[#f6465d]/20 transition-colors"
          >
            <Ban className="w-3 h-3" />
            <span>{isCancellingAll ? 'Cancelling...' : 'Cancel All'}</span>
          </button>
        )}
      </div>

      {errorMsg && (
        <div className="mb-2 p-1.5 rounded bg-[#f6465d]/10 border border-[#f6465d]/30 text-[#f6465d] text-[11px]">
          {errorMsg}
        </div>
      )}

      {/* Orders Table */}
      {openOrders.length === 0 ? (
        <div className="flex flex-col items-center justify-center h-40 text-[#7d8590]">
          <span className="text-xs">No pending orders or algos</span>
          <span className="text-[10px] text-[#484f58] mt-1">Bracket orders will appear here during active trades</span>
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-left">
            <thead>
              <tr className="text-[10px] uppercase text-[#7d8590] border-b border-[#151d2c]/60">
                <th className="py-1.5 px-2">Order ID</th>
                <th className="py-1.5 px-2">Symbol</th>
                <th className="py-1.5 px-2">Type</th>
                <th className="py-1.5 px-2">Side</th>
                <th className="py-1.5 px-2">Price</th>
                <th className="py-1.5 px-2">Qty</th>
                <th className="py-1.5 px-2">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[#151d2c]/40">
              {openOrders.map((order) => {
                const isLong = order.side === 'BUY';
                return (
                  <tr key={order.orderId} className="hover:bg-[#151d2c]/30 transition-colors">
                    <td className="py-2 px-2 text-[#7d8590] truncate max-w-[120px]" title={order.orderId}>
                      {order.clientOrderId || order.orderId}
                    </td>
                    <td className="py-2 px-2 font-semibold text-[#e6edf3]">{order.symbol}</td>
                    <td className="py-2 px-2">
                      <span className="px-1 py-0.5 rounded text-[10px] bg-[#151d2c] text-[#7d8590]">
                        {order.isAlgo ? `ALGO_${order.type}` : order.type}
                      </span>
                    </td>
                    <td className="py-2 px-2">
                      <span
                        className={`font-bold ${
                          isLong ? 'text-[#0ecb81]' : 'text-[#f6465d]'
                        }`}
                      >
                        {order.side}
                      </span>
                    </td>
                    <td className="py-2 px-2 font-semibold text-[#e6edf3]">{(order.price ?? 0).toFixed(2)}</td>
                    <td className="py-2 px-2 text-[#7d8590]">
                      {order.executedQty} / {order.origQty}
                    </td>
                    <td className="py-2 px-2">
                      <button
                        onClick={() => handleCancelOrder(order.orderId, order.symbol, order.isAlgo)}
                        disabled={cancellingId === order.orderId}
                        className="p-1 rounded text-[#7d8590] hover:text-[#f6465d] hover:bg-[#151d2c] transition-colors"
                        title="Cancel Order"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
};
