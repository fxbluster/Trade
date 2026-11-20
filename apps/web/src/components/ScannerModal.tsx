import React, { useState, useEffect } from 'react';
import { useUiStore } from '../store/useUiStore';
import { useMarketStore } from '../store/useMarketStore';
import { apiClient } from '../lib/apiClient';
import type { ScannerItem } from '@tradeos/shared';
import { Compass, X, Search, RefreshCw, ArrowUpDown } from 'lucide-react';

export const ScannerModal: React.FC = () => {
  const isScannerModalOpen = useUiStore((s) => s.isScannerModalOpen);
  const setIsScannerModalOpen = useUiStore((s) => s.setIsScannerModalOpen);
  const setSymbol = useMarketStore((s) => s.setSymbol);
  const cachedScannerItems = useMarketStore((s) => s.cachedScannerItems);
  const setCachedScannerItems = useMarketStore((s) => s.setCachedScannerItems);

  const [items, setItems] = useState<ScannerItem[]>(cachedScannerItems || []);
  const [filterText, setFilterText] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [isOffline, setIsOffline] = useState(false);
  const [sortField, setSortField] = useState<'quoteVolume24h' | 'priceChangePercent24h'>('quoteVolume24h');
  const [sortAsc, setSortAsc] = useState(false);

  const loadScannerData = async () => {
    setIsLoading(true);
    try {
      // 2500ms timeout for tunnel resilience
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 2500);

      const data = await apiClient.getScanner();
      clearTimeout(timeoutId);
      if (Array.isArray(data) && data.length > 0) {
        setItems(data);
        setCachedScannerItems(data);
        setIsOffline(false);
      }
    } catch (err) {
      console.warn('Scanner network timeout or error, falling back to cache:', err);
      if (cachedScannerItems && cachedScannerItems.length > 0) {
        setItems(cachedScannerItems);
        setIsOffline(true);
      }
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    if (isScannerModalOpen) {
      if (cachedScannerItems && cachedScannerItems.length > 0 && items.length === 0) {
        setItems(cachedScannerItems);
      }
      loadScannerData();
    }
  }, [isScannerModalOpen]);

  if (!isScannerModalOpen) return null;

  const filteredItems = items
    .filter((item) => item.symbol.toLowerCase().includes(filterText.toLowerCase()))
    .sort((a, b) => {
      const diff = a[sortField] - b[sortField];
      return sortAsc ? diff : -diff;
    });

  const handleSelectSymbol = (sym: string) => {
    setSymbol(sym);
    setIsScannerModalOpen(false);
  };

  const toggleSort = (field: 'quoteVolume24h' | 'priceChangePercent24h') => {
    if (sortField === field) {
      setSortAsc(!sortAsc);
    } else {
      setSortField(field);
      setSortAsc(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-4 font-mono select-none">
      <div className="relative w-full max-w-2xl bg-[#080c14] border border-[#151d2c] rounded-xl shadow-2xl p-5 text-xs flex flex-col max-h-[85vh]">
        {/* Header */}
        <div className="flex items-center justify-between pb-3 border-b border-[#151d2c]">
          <div className="flex items-center space-x-2">
            <Compass className="w-5 h-5 text-[#2962ff]" />
            <h2 className="text-sm font-bold uppercase tracking-wider text-[#e6edf3]">
              USDT-M Perpetual Market Scanner
            </h2>
            {isOffline && (
              <span className="px-1.5 py-0.5 rounded text-[10px] bg-amber-500/15 text-amber-400 border border-amber-500/30">
                Cached (Offline)
              </span>
            )}
          </div>
          <button
            onClick={() => setIsScannerModalOpen(false)}
            className="text-[#7d8590] hover:text-[#e6edf3] transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Search and Action Bar */}
        <div className="flex items-center space-x-2 py-3">
          <div className="relative flex-1">
            <Search className="w-3.5 h-3.5 absolute left-2.5 top-2.5 text-[#7d8590]" />
            <input
              type="text"
              placeholder="Search symbol (e.g. BTC, SOL, ETH)..."
              value={filterText}
              onChange={(e) => setFilterText(e.target.value)}
              className="w-full bg-[#020305] border border-[#151d2c] rounded pl-8 pr-3 py-1.5 text-xs text-[#e6edf3] focus:border-[#2962ff] focus:outline-none"
            />
          </div>

          <button
            onClick={loadScannerData}
            disabled={isLoading}
            className="flex items-center space-x-1 px-3 py-1.5 rounded bg-[#151d2c] text-[#7d8590] hover:text-[#e6edf3] transition-colors"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${isLoading ? 'animate-spin' : ''}`} />
            <span>Refresh</span>
          </button>
        </div>

        {/* Table */}
        <div className="overflow-y-auto flex-1 border border-[#151d2c] rounded">
          <table className="w-full text-left">
            <thead className="sticky top-0 bg-[#020305] border-b border-[#151d2c] text-[10px] uppercase text-[#7d8590]">
              <tr>
                <th className="py-2 px-3">Symbol</th>
                <th className="py-2 px-3">Price</th>
                <th
                  className="py-2 px-3 cursor-pointer hover:text-[#e6edf3]"
                  onClick={() => toggleSort('priceChangePercent24h')}
                >
                  <div className="flex items-center space-x-1">
                    <span>24h Change</span>
                    <ArrowUpDown className="w-3 h-3" />
                  </div>
                </th>
                <th
                  className="py-2 px-3 cursor-pointer hover:text-[#e6edf3]"
                  onClick={() => toggleSort('quoteVolume24h')}
                >
                  <div className="flex items-center space-x-1">
                    <span>24h Volume</span>
                    <ArrowUpDown className="w-3 h-3" />
                  </div>
                </th>
                <th className="py-2 px-3">Funding</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[#151d2c]/60">
              {isLoading && filteredItems.length === 0 ? (
                [...Array(6)].map((_, i) => (
                  <tr key={i} className="animate-pulse">
                    <td className="py-3 px-3"><div className="h-3.5 bg-[#151d2c] rounded w-20" /></td>
                    <td className="py-3 px-3"><div className="h-3.5 bg-[#151d2c] rounded w-16" /></td>
                    <td className="py-3 px-3"><div className="h-3.5 bg-[#151d2c] rounded w-14" /></td>
                    <td className="py-3 px-3"><div className="h-3.5 bg-[#151d2c] rounded w-18" /></td>
                    <td className="py-3 px-3"><div className="h-3.5 bg-[#151d2c] rounded w-12" /></td>
                  </tr>
                ))
              ) : (
                filteredItems.map((item) => {
                  const isPositive = item.priceChangePercent24h >= 0;
                  const volumeMillion = (item.quoteVolume24h / 1_000_000).toFixed(1);

                  return (
                    <tr
                      key={item.symbol}
                      onClick={() => handleSelectSymbol(item.symbol)}
                      className="hover:bg-[#151d2c]/40 cursor-pointer transition-colors"
                    >
                      <td className="py-2.5 px-3 font-bold text-[#e6edf3]">{item.symbol}</td>
                      <td className="py-2.5 px-3 font-semibold text-[#e6edf3]">{item.lastPrice.toFixed(2)}</td>
                      <td
                        className={`py-2.5 px-3 font-bold ${
                          isPositive ? 'text-[#0ecb81]' : 'text-[#f6465d]'
                        }`}
                      >
                        {isPositive ? '+' : ''}
                        {item.priceChangePercent24h.toFixed(2)}%
                      </td>
                      <td className="py-2.5 px-3 text-[#7d8590]">${volumeMillion}M</td>
                      <td className="py-2.5 px-3 text-[#f0b90b]">
                        {(item.fundingRate * 100).toFixed(4)}%
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
};
