import type { DatabaseSync } from 'node:sqlite';
import type {
  BrokerMode,
  AccountInfo,
  OpenOrderRequest,
  OpenOrderInfo,
  TradeSide,
  FillRecord,
} from '@tradeos/shared';
import { BinanceClient, ExchangeDegradedError, ExchangeBannedError } from './binanceClient.js';
import { BinanceDemoAdapter } from './binanceDemoAdapter.js';
import { LocalPaperAdapter } from './localPaperAdapter.js';

export { ExchangeDegradedError, ExchangeBannedError };

export interface PositionInfo {
  symbol: string;
  positionAmt: number;
  entryPrice: number;
  markPrice: number;
  unRealizedProfit: number;
  liquidationPrice: number;
  leverage: number;
  marginType?: string;
}

export interface OrderExecutionResult {
  orderId: string;
  clientOrderId: string;
  status: string;
  executedQty: number;
  avgPrice: number;
}

export interface AlgoOrderParams {
  symbol: string;
  side: TradeSide;
  type: 'STOP_MARKET' | 'TAKE_PROFIT_MARKET';
  triggerPrice: number;
  quantity?: number;
  clientAlgoId?: string;
  reduceOnly?: boolean;
}

export interface AlgoOrderResult {
  algoId: string;
  clientAlgoId?: string;
  symbol: string;
  status?: string;
}

/**
 * Common Broker Adapter Interface for Binance Demo and Local Paper trading engines.
 */
export interface BrokerAdapter {
  readonly mode: BrokerMode;

  getAccount(): Promise<AccountInfo>;
  getPosition(symbol: string): Promise<PositionInfo | null>;
  getAllPositions?(): Promise<PositionInfo[]>;
  openOrder(req: OpenOrderRequest & { clientOrderId?: string; quantity?: number }): Promise<OrderExecutionResult>;
  createAlgoOrder(params: AlgoOrderParams): Promise<AlgoOrderResult>;
  placeAlgoOrder?(params: AlgoOrderParams): Promise<AlgoOrderResult>;
  closePosition(symbol: string, qty?: number): Promise<{ orderId: string; status: string }>;
  cancelOrder(symbol: string, orderId: string, isAlgo?: boolean): Promise<boolean>;
  cancelAllOrders(symbol: string): Promise<boolean>;
  moveToBreakeven(symbol: string, bePrice: number, currentSlId?: string): Promise<{ newSlId: string }>;
  getOpenOrders(symbol?: string): Promise<OpenOrderInfo[]>;
  getOrder?(symbol: string, orderId: string): Promise<OrderExecutionResult | null>;
  getSymbolUserTrades?(symbol: string, startTimeMs: number): Promise<FillRecord[]>;
  setLeverage?(symbol: string, leverage: number): Promise<number>;
  modifyOrder?(symbol: string, orderId: string | number, price: number, quantity: number, side?: TradeSide): Promise<any>;
}

export interface BrokerFactoryOptions {
  client?: BinanceClient;
  db?: DatabaseSync;
  initialPaperBalance?: number;
  forceNew?: boolean;
}

/**
 * BrokerFactory instantiates and retrieves active BrokerAdapter instances
 * based on requested BrokerMode ('BINANCE_DEMO' | 'LOCAL_PAPER').
 */
export class BrokerFactory {
  private static demoAdapterInstance: BinanceDemoAdapter | null = null;
  private static paperAdapterInstance: LocalPaperAdapter | null = null;
  private static customAdapters: Map<BrokerMode, BrokerAdapter> = new Map();

  /**
   * Returns adapter for specified broker mode.
   */
  static getAdapter(mode: BrokerMode, options: BrokerFactoryOptions = {}): BrokerAdapter {
    if (this.customAdapters.has(mode)) {
      return this.customAdapters.get(mode)!;
    }

    if (mode === 'BINANCE_DEMO') {
      if (!this.demoAdapterInstance || options.client || options.forceNew) {
        const client = options.client || new BinanceClient();
        this.demoAdapterInstance = new BinanceDemoAdapter({ client });
      }
      return this.demoAdapterInstance;
    }

    if (mode === 'LOCAL_PAPER') {
      if (!this.paperAdapterInstance || options.forceNew) {
        if (!options.db) {
          throw new Error('DatabaseSync instance required to initialize LocalPaperAdapter');
        }
        this.paperAdapterInstance = new LocalPaperAdapter({
          db: options.db,
          initialBalance: options.initialPaperBalance,
        });
      }
      return this.paperAdapterInstance;
    }

    throw new Error(`Unsupported broker mode: ${mode}`);
  }

  /**
   * Registers custom or mocked adapter (e.g. for testing).
   */
  static registerAdapter(mode: BrokerMode, adapter: BrokerAdapter): void {
    this.customAdapters.set(mode, adapter);
  }

  /**
   * Resets all cached adapter instances.
   */
  static reset(): void {
    this.demoAdapterInstance = null;
    this.paperAdapterInstance = null;
    this.customAdapters.clear();
  }
}
