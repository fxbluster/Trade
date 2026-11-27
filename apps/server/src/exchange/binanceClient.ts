import crypto from 'node:crypto';
import type { ExchangeHealth, TradeSide, OrderType } from '@tradeos/shared';

export class ExchangeDegradedError extends Error {
  constructor(message: string, public readonly originalError?: unknown) {
    super(message);
    this.name = 'ExchangeDegradedError';
  }
}

export class ExchangeBannedError extends ExchangeDegradedError {
  constructor(public readonly retryAfterSec: number, message?: string) {
    super(message || `Exchange IP banned. Retry after ${retryAfterSec}s`);
    this.name = 'ExchangeBannedError';
  }
}

export class BinanceApiError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
    public readonly code?: number,
    public readonly isAlgoSwitch: boolean = false
  ) {
    super(message);
    this.name = 'BinanceApiError';
  }
}

export interface BinanceClientOptions {
  apiKey?: string;
  apiSecret?: string;
  testnetBaseUrl?: string;
  prodBaseUrl?: string;
  recvWindow?: number;
  timeoutMs?: number;
  onIpBan?: (retryAfterSec: number, statusCode: number) => void;
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  params?: Record<string, unknown>;
  signed?: boolean;
  priority?: 'P1' | 'P2';
  baseUrl?: string;
  timeoutMs?: number;
  forceTestnet?: boolean;
  isPublicData?: boolean;
}

export interface CreateOrderParams {
  symbol: string;
  side: TradeSide;
  type: OrderType | 'STOP_MARKET' | 'TAKE_PROFIT_MARKET' | 'STOP' | 'TAKE_PROFIT' | 'TRAILING_STOP_MARKET';
  quantity: number;
  price?: number;
  stopPrice?: number;
  reduceOnly?: boolean;
  newClientOrderId?: string;
  timeInForce?: 'GTC' | 'IOC' | 'FOK' | 'GTX';
}

export interface CreateAlgoOrderParams {
  symbol: string;
  side: TradeSide;
  type: 'STOP_MARKET' | 'TAKE_PROFIT_MARKET';
  triggerPrice: number;
  quantity?: number;
  reduceOnly?: boolean;
  clientAlgoId?: string;
  algoType?: string;
}

export interface RateLimitState {
  usedWeight1m: number;
  orderCount10s: number;
  orderCount1m: number;
}

export interface SymbolFilterRules {
  tickSize: number;
  stepSize: number;
}

export const DEFAULT_SYMBOL_RULES: Record<string, SymbolFilterRules> = {
  BTCUSDT: { tickSize: 0.1, stepSize: 0.001 },
  ETHUSDT: { tickSize: 0.01, stepSize: 0.001 },
  SOLUSDT: { tickSize: 0.01, stepSize: 0.01 },
  XRPUSDT: { tickSize: 0.0001, stepSize: 0.1 },
  BNBUSDT: { tickSize: 0.01, stepSize: 0.01 },
  DOGEUSDT: { tickSize: 0.00001, stepSize: 1 },
  ADAUSDT: { tickSize: 0.0001, stepSize: 1 },
};

/**
 * Computes the number of decimal places represented by a step/tick size (handles scientific notation like 1e-5).
 */
export function getDecimalPrecision(step: number): number {
  if (!Number.isFinite(step) || step <= 0) return 0;
  const str = step.toString();
  if (str.includes('e-')) {
    const exp = parseInt(str.split('e-')[1], 10);
    return Number.isFinite(exp) ? exp : 0;
  }
  const dotIdx = str.indexOf('.');
  return dotIdx === -1 ? 0 : str.length - dotIdx - 1;
}

/**
 * Snaps a price to the nearest valid multiple of `tickSize` without floating-point artifacts.
 */
export function snapPriceToTick(price: number, tickSize: number): number {
  if (!Number.isFinite(price) || !Number.isFinite(tickSize) || tickSize <= 0) {
    return price;
  }
  const precision = getDecimalPrecision(tickSize);
  const ticks = Math.round(price / tickSize);
  return Number((ticks * tickSize).toFixed(precision));
}

/**
 * Floors a quantity to a valid multiple of `stepSize` without floating-point artifacts.
 */
export function snapQuantityToStep(quantity: number, stepSize: number): number {
  if (!Number.isFinite(quantity) || quantity <= 0 || !Number.isFinite(stepSize) || stepSize <= 0) {
    return quantity;
  }
  const precision = getDecimalPrecision(stepSize);
  const steps = Math.floor(quantity / stepSize + 1e-9);
  const snapped = Number((steps * stepSize).toFixed(precision));
  return snapped > 0 ? snapped : Number(stepSize.toFixed(precision));
}

/**
 * Binance Futures REST Client with HMAC-SHA256 signing, strict timeouts,
 * rate-limit prioritization (P1 execution vs P2 scanner), and HTTP 418 ban circuit-breaker.
 */
export class BinanceClient {
  public apiKey: string;
  public apiSecret: string;
  public testnetBaseUrl: string;
  public prodBaseUrl: string;
  public recvWindow: number;
  public timeoutMs: number;

  public usedWeight1m: number = 0;
  public orderCount10s: number = 0;
  public orderCount1m: number = 0;

  private bannedUntil: number = 0;
  private exchangeHealth: ExchangeHealth = 'HEALTHY';
  private exchangeInfoCache: { timestamp: number; data: unknown } | null = null;
  private symbolRulesCache: Map<string, SymbolFilterRules> = new Map();
  public onIpBan?: (retryAfterSec: number, statusCode: number) => void;

  constructor(options: BinanceClientOptions = {}) {
    this.apiKey = options.apiKey || process.env.BINANCE_DEMO_API_KEY || '';
    this.apiSecret = options.apiSecret || process.env.BINANCE_DEMO_API_SECRET || '';
    this.testnetBaseUrl = (options.testnetBaseUrl || process.env.BINANCE_TESTNET_BASE_URL || 'https://testnet.binancefuture.com').replace(/\/+$/, '');
    this.prodBaseUrl = (options.prodBaseUrl || 'https://fapi.binance.com').replace(/\/+$/, '');
    this.recvWindow = options.recvWindow || 5000;
    this.timeoutMs = options.timeoutMs || 5000;
    this.onIpBan = options.onIpBan;
  }

  /**
   * Evaluates if exchange IP ban is currently active.
   */
  isBanned(): boolean {
    if (this.bannedUntil > Date.now()) {
      return true;
    }
    if (this.bannedUntil > 0 && this.exchangeHealth === 'BANNED') {
      this.bannedUntil = 0;
      this.exchangeHealth = 'HEALTHY';
    }
    return false;
  }

  /**
   * Returns remaining seconds of active IP ban.
   */
  getRemainingBanSeconds(): number {
    if (!this.isBanned()) return 0;
    return Math.max(1, Math.ceil((this.bannedUntil - Date.now()) / 1000));
  }

  /**
   * Returns current health state of the exchange integration.
   */
  getExchangeHealth(): ExchangeHealth {
    if (this.isBanned()) {
      return 'BANNED';
    }
    return this.exchangeHealth;
  }

  /**
   * Manually sets exchange health status.
   */
  setExchangeHealth(health: ExchangeHealth): void {
    this.exchangeHealth = health;
  }

  /**
   * Returns active rate limit utilization counters.
   */
  getRateLimits(): RateLimitState {
    return {
      usedWeight1m: this.usedWeight1m,
      orderCount10s: this.orderCount10s,
      orderCount1m: this.orderCount1m,
    };
  }

  /**
   * Generates HMAC-SHA256 hex digest for signed endpoints.
   */
  createSignature(queryString: string): string {
    if (!this.apiSecret) return '';
    return crypto.createHmac('sha256', this.apiSecret).update(queryString).digest('hex');
  }

  /**
   * Constructs deterministically sorted query string with timestamp, recvWindow, and signature.
   */
  buildSignedQuery(params: Record<string, unknown> = {}): string {
    const queryObj: Record<string, unknown> = { ...params };
    if (!queryObj.timestamp) {
      queryObj.timestamp = Date.now();
    }
    if (!queryObj.recvWindow) {
      queryObj.recvWindow = this.recvWindow;
    }

    const keys = Object.keys(queryObj).sort();
    const queryParts: string[] = [];
    for (const key of keys) {
      const val = queryObj[key];
      if (val !== undefined && val !== null) {
        queryParts.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(val))}`);
      }
    }
    const queryString = queryParts.join('&');
    const signature = this.createSignature(queryString);
    return `${queryString}&signature=${signature}`;
  }

  /**
   * Core REST executor enforcing AbortSignal.timeout(5000), 418 ban halt, and priority routing.
   */
  async request<T>(endpoint: string, options: RequestOptions = {}): Promise<T> {
    const method = options.method || 'GET';
    const priority = options.priority || 'P1';
    const timeoutMs = options.timeoutMs ?? this.timeoutMs;

    // Gate 1: HTTP 418 IP ban circuit-breaker
    if (this.isBanned()) {
      const remainingSec = this.getRemainingBanSeconds();
      throw new ExchangeBannedError(
        remainingSec,
        `Outbound REST halted: IP is BANNED (HTTP 418). Resumes in ${remainingSec}s.`
      );
    }

    // Gate 2: Rate limit priority protection — prioritize P1 (execution) over P2 (scanner)
    if (priority === 'P2' && this.usedWeight1m >= 1000) {
      throw new ExchangeDegradedError(
        `Rate limit weight threshold reached (${this.usedWeight1m}/1200). Scanner (P2) throttled to preserve execution bandwidth.`
      );
    }

    // Route public vs private endpoints
    const isPublicMarketData =
      endpoint.startsWith('/fapi/v1/klines') ||
      endpoint.startsWith('/fapi/v1/ticker') ||
      endpoint.startsWith('/fapi/v1/premiumIndex') ||
      endpoint.startsWith('/fapi/v1/openInterest');
    const baseUrl =
      options.baseUrl ||
      (options.isPublicData || (isPublicMarketData && !options.forceTestnet)
        ? this.prodBaseUrl
        : this.testnetBaseUrl);

    let url = `${baseUrl}${endpoint}`;
    let body: string | undefined = undefined;
    const headers: Record<string, string> = {
      Accept: 'application/json',
    };

    if (this.apiKey) {
      headers['X-MBX-APIKEY'] = this.apiKey;
    }

    if (options.signed) {
      const signedQuery = this.buildSignedQuery(options.params || {});
      if (method === 'GET' || method === 'DELETE') {
        url += (url.includes('?') ? '&' : '?') + signedQuery;
      } else {
        headers['Content-Type'] = 'application/x-www-form-urlencoded';
        body = signedQuery;
      }
    } else if (options.params && Object.keys(options.params).length > 0) {
      const queryParts: string[] = [];
      for (const [k, v] of Object.entries(options.params)) {
        if (v !== undefined && v !== null) {
          queryParts.push(`${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
        }
      }
      const qs = queryParts.join('&');
      if (method === 'GET' || method === 'DELETE') {
        url += (url.includes('?') ? '&' : '?') + qs;
      } else {
        headers['Content-Type'] = 'application/x-www-form-urlencoded';
        body = qs;
      }
    }

    try {
      const res = await fetch(url, {
        method,
        headers,
        body,
        signal: AbortSignal.timeout(timeoutMs),
      });

      // Update rate limit tracking headers
      const weightHeader = res.headers.get('x-mbx-used-weight-1m');
      if (weightHeader) {
        this.usedWeight1m = parseInt(weightHeader, 10) || 0;
      }
      const order10sHeader = res.headers.get('x-mbx-order-count-10s');
      if (order10sHeader) {
        this.orderCount10s = parseInt(order10sHeader, 10) || 0;
      }
      const order1mHeader = res.headers.get('x-mbx-order-count-1m');
      if (order1mHeader) {
        this.orderCount1m = parseInt(order1mHeader, 10) || 0;
      }

      // HTTP 418 or 429 Ban Circuit Breaker
      if (res.status === 418 || res.status === 429) {
        const retryAfterHeader = res.headers.get('retry-after');
        let retryAfterSec = 60;
        if (retryAfterHeader) {
          const parsed = parseInt(retryAfterHeader, 10);
          if (!isNaN(parsed) && parsed > 0) {
            retryAfterSec = parsed;
          }
        }
        this.bannedUntil = Date.now() + retryAfterSec * 1000;
        this.exchangeHealth = 'BANNED';
        try {
          this.onIpBan?.(retryAfterSec, res.status);
        } catch {
          // Never allow callback errors to mask ExchangeBannedError
        }
        throw new ExchangeBannedError(
          retryAfterSec,
          `Binance IP ban triggered (${res.status}). Retry-After: ${retryAfterSec}s.`
        );
      }

      if (!res.ok) {
        const errText = await res.text();
        let errJson: any = null;
        try {
          errJson = JSON.parse(errText);
        } catch {
          // Non-JSON response body
        }

        const code = errJson?.code;
        const msg = errJson?.msg || errText;

        // Code -4120: Stop order should be placed by Algo Order API
        if (code === -4120 || (typeof msg === 'string' && msg.includes('STOP_ORDER_SWITCH_ALGO'))) {
          throw new BinanceApiError(msg, res.status, -4120, true);
        }

        throw new BinanceApiError(msg, res.status, code, false);
      }

      if (this.exchangeHealth === 'DEGRADED') {
        this.exchangeHealth = 'HEALTHY';
      }

      return (await res.json()) as T;
    } catch (err: any) {
      if (
        err instanceof ExchangeBannedError ||
        err instanceof BinanceApiError ||
        err instanceof ExchangeDegradedError
      ) {
        throw err;
      }

      // Timeout or network error
      if (err.name === 'TimeoutError' || err.name === 'AbortError') {
        this.exchangeHealth = 'DEGRADED';
        throw new ExchangeDegradedError(
          `Binance REST request timed out after ${timeoutMs}ms: ${endpoint}`,
          err
        );
      }

      this.exchangeHealth = 'DEGRADED';
      throw new ExchangeDegradedError(
        `Binance REST network error on ${endpoint}: ${err.message}`,
        err
      );
    }
  }

  /**
   * Parses and caches PRICE_FILTER.tickSize and LOT_SIZE.stepSize from exchangeInfo payload.
   */
  private cacheExchangeInfoRules(data: any): void {
    const symbols = data?.symbols;
    if (!Array.isArray(symbols)) return;
    for (const symInfo of symbols) {
      const symName = typeof symInfo?.symbol === 'string' ? symInfo.symbol.toUpperCase() : '';
      if (!symName) continue;
      const filters = Array.isArray(symInfo.filters) ? symInfo.filters : [];
      const priceFilter = filters.find((f: any) => f.filterType === 'PRICE_FILTER');
      const lotFilter = filters.find((f: any) => f.filterType === 'LOT_SIZE');
      const fallback = DEFAULT_SYMBOL_RULES[symName];

      const parsedTick = priceFilter?.tickSize ? parseFloat(priceFilter.tickSize) : NaN;
      const parsedStep = lotFilter?.stepSize ? parseFloat(lotFilter.stepSize) : NaN;
      const tickSize =
        Number.isFinite(parsedTick) && parsedTick > 0
          ? parsedTick
          : typeof symInfo.pricePrecision === 'number'
            ? Math.pow(10, -symInfo.pricePrecision)
            : (fallback?.tickSize ?? 0.01);
      const stepSize =
        Number.isFinite(parsedStep) && parsedStep > 0
          ? parsedStep
          : typeof symInfo.quantityPrecision === 'number'
            ? Math.pow(10, -symInfo.quantityPrecision)
            : (fallback?.stepSize ?? 0.001);

      this.symbolRulesCache.set(symName, { tickSize, stepSize });
    }
  }

  /**
   * Returns cached exchangeInfo filter rules (tickSize, stepSize) for a symbol,
   * falling back to known Binance Futures defaults.
   */
  getSymbolRules(symbol: string): SymbolFilterRules {
    const symUpper = symbol.toUpperCase();
    const cached = this.symbolRulesCache.get(symUpper);
    if (cached) return cached;
    if (this.exchangeInfoCache?.data) {
      this.cacheExchangeInfoRules(this.exchangeInfoCache.data);
      const fromExchangeInfo = this.symbolRulesCache.get(symUpper);
      if (fromExchangeInfo) return fromExchangeInfo;
    }
    return DEFAULT_SYMBOL_RULES[symUpper] ?? { tickSize: 0.01, stepSize: 0.001 };
  }

  /**
   * Cached symbol and exchange rules query.
   */
  async getExchangeInfo(symbol?: string): Promise<any> {
    const now = Date.now();
    if (this.exchangeInfoCache && now - this.exchangeInfoCache.timestamp < 3600000) {
      const data: any = this.exchangeInfoCache.data;
      if (this.symbolRulesCache.size === 0) {
        this.cacheExchangeInfoRules(data);
      }
      if (symbol) {
        const symUpper = symbol.toUpperCase();
        return {
          ...data,
          symbols: data.symbols?.filter((s: any) => s.symbol === symUpper) || [],
        };
      }
      return data;
    }

    const data = await this.request<any>('/fapi/v1/exchangeInfo', {
      method: 'GET',
      isPublicData: true,
      priority: 'P2',
    });
    this.exchangeInfoCache = { timestamp: now, data };
    this.cacheExchangeInfoRules(data);

    if (symbol) {
      const symUpper = symbol.toUpperCase();
      return {
        ...data,
        symbols: data.symbols?.filter((s: any) => s.symbol === symUpper) || [],
      };
    }
    return data;
  }

  /**
   * Fetch historical klines from Mainnet public streams.
   */
  async getKlines(
    symbol: string,
    interval: string = '1m',
    limit: number = 400,
    startTime?: number,
    endTime?: number
  ): Promise<any[]> {
    const params: Record<string, unknown> = {
      symbol: symbol.toUpperCase(),
      interval,
      limit,
    };
    if (startTime !== undefined) {
      params.startTime = startTime;
    }
    if (endTime !== undefined) {
      params.endTime = endTime;
    }
    return this.request<any[]>('/fapi/v1/klines', {
      method: 'GET',
      isPublicData: true,
      priority: 'P2',
      params,
    });
  }

  /**
   * Fetch live premium index / mark price.
   */
  async getMarkPrice(symbol?: string): Promise<any> {
    const params: Record<string, unknown> = {};
    if (symbol) params.symbol = symbol.toUpperCase();
    return this.request<any>('/fapi/v1/premiumIndex', {
      method: 'GET',
      isPublicData: true,
      priority: 'P2',
      params,
    });
  }

  /**
   * Fetch live open interest for symbol (/fapi/v1/openInterest).
   */
  async getOpenInterest(symbol: string): Promise<{ symbol: string; openInterest: string; time: number }> {
    return this.request<{ symbol: string; openInterest: string; time: number }>('/fapi/v1/openInterest', {
      method: 'GET',
      isPublicData: true,
      priority: 'P2',
      params: {
        symbol: symbol.toUpperCase(),
      },
    });
  }

  /**
   * Fetch user account overview (balance, equity, margin).
   */
  async getAccount(): Promise<any> {
    return this.request<any>('/fapi/v2/account', {
      method: 'GET',
      signed: true,
      priority: 'P1',
    });
  }

  /**
   * Fetch position risk for symbol(s).
   */
  async getPositionRisk(symbol?: string): Promise<any[]> {
    const params: Record<string, unknown> = {};
    if (symbol) params.symbol = symbol.toUpperCase();
    return this.request<any[]>('/fapi/v2/positionRisk', {
      method: 'GET',
      signed: true,
      priority: 'P1',
      params,
    });
  }

  /**
   * Fetch open orders for symbol(s).
   */
  async getOpenOrders(symbol?: string): Promise<any[]> {
    const params: Record<string, unknown> = {};
    if (symbol) params.symbol = symbol.toUpperCase();
    return this.request<any[]>('/fapi/v1/openOrders', {
      method: 'GET',
      signed: true,
      priority: 'P1',
      params,
    });
  }

  /**
   * Fetch open algo/conditional orders (SL, TP, conditional market) for symbol(s).
   */
  async getOpenAlgoOrders(symbol?: string): Promise<any[]> {
    const params: Record<string, unknown> = {};
    if (symbol) params.symbol = symbol.toUpperCase();
    return this.request<any[]>('/fapi/v1/openAlgoOrders', {
      method: 'GET',
      signed: true,
      priority: 'P1',
      params,
    }).catch(() => []);
  }

  /**
   * Set leverage for a contract symbol.
   */
  async setLeverage(symbol: string, leverage: number): Promise<any> {
    return this.request<any>('/fapi/v1/leverage', {
      method: 'POST',
      signed: true,
      priority: 'P1',
      params: {
        symbol: symbol.toUpperCase(),
        leverage,
      },
    });
  }

  /**
   * Places an order with automatic -4120 routing to /fapi/v1/algoOrder.
   */
  async createOrder(params: CreateOrderParams): Promise<any> {
    const sym = params.symbol.toUpperCase();
    const rules = this.getSymbolRules(sym);
    const snappedQty = snapQuantityToStep(params.quantity, rules.stepSize);
    const snappedPrice =
      params.price !== undefined ? snapPriceToTick(params.price, rules.tickSize) : undefined;
    const snappedStopPrice =
      params.stopPrice !== undefined ? snapPriceToTick(params.stopPrice, rules.tickSize) : undefined;

    try {
      return await this.request('/fapi/v1/order', {
        method: 'POST',
        signed: true,
        priority: 'P1',
        params: {
          symbol: sym,
          side: params.side,
          type: params.type,
          quantity: snappedQty,
          ...(snappedPrice !== undefined ? { price: snappedPrice } : {}),
          ...(snappedStopPrice !== undefined ? { stopPrice: snappedStopPrice } : {}),
          ...(params.reduceOnly !== undefined ? { reduceOnly: String(params.reduceOnly) } : {}),
          ...(params.newClientOrderId ? { newClientOrderId: params.newClientOrderId } : {}),
          ...(params.timeInForce ? { timeInForce: params.timeInForce } : {}),
        },
      });
    } catch (err: any) {
      if (
        err?.code === -4120 ||
        err?.isAlgoSwitch ||
        (typeof err?.message === 'string' && err.message.includes('STOP_ORDER_SWITCH_ALGO'))
      ) {
        const isStop =
          params.type === 'STOP_MARKET' ||
          params.type === 'STOP' ||
          params.type === 'TAKE_PROFIT_MARKET' ||
          params.type === 'TAKE_PROFIT' ||
          params.type === 'TRAILING_STOP_MARKET';
        if (isStop) {
          const algoType: 'STOP_MARKET' | 'TAKE_PROFIT_MARKET' =
            params.type === 'STOP' || params.type === 'STOP_MARKET'
              ? 'STOP_MARKET'
              : 'TAKE_PROFIT_MARKET';
          return await this.createAlgoOrder({
            symbol: sym,
            side: params.side,
            type: algoType,
            triggerPrice: snappedStopPrice ?? snappedPrice ?? 0,
            quantity: snappedQty,
            reduceOnly: params.reduceOnly ?? true,
            clientAlgoId: params.newClientOrderId,
          });
        }
      }
      throw err;
    }
  }

  /**
   * Places server-side conditional algo order (/fapi/v1/algoOrder).
   */
  async createAlgoOrder(params: CreateAlgoOrderParams): Promise<any> {
    const sym = params.symbol.toUpperCase();
    const rules = this.getSymbolRules(sym);
    const snappedTriggerPrice = snapPriceToTick(params.triggerPrice, rules.tickSize);
    const algoParams: Record<string, unknown> = {
      algoType: params.algoType || 'CONDITIONAL',
      symbol: sym,
      side: params.side,
      type: params.type,
      triggerPrice: snappedTriggerPrice,
      reduceOnly: params.reduceOnly !== undefined ? String(params.reduceOnly) : 'true',
    };
    if (params.quantity !== undefined && params.quantity > 0) {
      algoParams.quantity = snapQuantityToStep(params.quantity, rules.stepSize);
    }
    if (params.clientAlgoId) {
      algoParams.clientAlgoId = params.clientAlgoId;
    }

    const data = await this.request<any>('/fapi/v1/algoOrder', {
      method: 'POST',
      signed: true,
      priority: 'P1',
      params: algoParams,
    });

    const algoId = String(data?.algoId ?? data?.orderId ?? '');
    return {
      ...data,
      algoId,
      orderId: algoId,
      clientAlgoId: params.clientAlgoId || data?.clientAlgoId,
      symbol: params.symbol.toUpperCase(),
    };
  }

  /**
   * Cancels an open regular order.
   */
  async cancelOrder(params: {
    symbol: string;
    orderId?: string | number;
    origClientOrderId?: string;
  }): Promise<any> {
    const p: Record<string, unknown> = { symbol: params.symbol.toUpperCase() };
    if (params.orderId) p.orderId = params.orderId;
    if (params.origClientOrderId) p.origClientOrderId = params.origClientOrderId;
    return this.request('/fapi/v1/order', {
      method: 'DELETE',
      signed: true,
      priority: 'P1',
      params: p,
    });
  }

  /**
   * Cancels a conditional algo order.
   */
  async cancelAlgoOrder(params: {
    symbol: string;
    algoId?: string | number;
    clientAlgoId?: string;
  }): Promise<any> {
    const p: Record<string, unknown> = { symbol: params.symbol.toUpperCase() };
    if (params.algoId) p.algoId = params.algoId;
    if (params.clientAlgoId) p.clientAlgoId = params.clientAlgoId;
    return this.request('/fapi/v1/algoOrder', {
      method: 'DELETE',
      signed: true,
      priority: 'P1',
      params: p,
    });
  }

  /**
   * Cancels all open regular orders on a symbol.
   */
  async cancelAllOpenOrders(symbol: string): Promise<any> {
    return this.request('/fapi/v1/allOpenOrders', {
      method: 'DELETE',
      signed: true,
      priority: 'P1',
      params: { symbol: symbol.toUpperCase() },
    });
  }

  /**
   * Acquires a User Data Stream listenKey (POST /fapi/v1/listenKey).
   */
  async createListenKey(): Promise<string> {
    const data = await this.request<{ listenKey: string }>('/fapi/v1/listenKey', {
      method: 'POST',
      priority: 'P1',
    });
    return data.listenKey;
  }

  /**
   * Extends listenKey validity by 60 minutes (PUT /fapi/v1/listenKey).
   */
  async keepAliveListenKey(listenKey: string): Promise<void> {
    await this.request('/fapi/v1/listenKey', {
      method: 'PUT',
      priority: 'P1',
      params: { listenKey },
    });
  }

  /**
   * Closes active listenKey (DELETE /fapi/v1/listenKey).
   */
  async closeListenKey(listenKey: string): Promise<void> {
    await this.request('/fapi/v1/listenKey', {
      method: 'DELETE',
      priority: 'P1',
      params: { listenKey },
    });
  }

  /**
   * Fetch a single order status by orderId (GET /fapi/v1/order).
   */
  async getOrder(symbol: string, orderId: string | number): Promise<any> {
    return this.request<any>('/fapi/v1/order', {
      method: 'GET',
      signed: true,
      priority: 'P1',
      params: {
        symbol: symbol.toUpperCase(),
        orderId: String(orderId),
      },
    });
  }

  /**
   * Fetch account trade history for a symbol (GET /fapi/v1/userTrades).
   */
  async getUserTrades(symbol: string, startTimeMs: number): Promise<any[]> {
    const params: Record<string, unknown> = {
      symbol: symbol.toUpperCase(),
    };
    if (Number.isFinite(startTimeMs) && startTimeMs > 0) {
      params.startTime = Math.floor(startTimeMs);
    }
    return this.request<any[]>('/fapi/v1/userTrades', {
      method: 'GET',
      signed: true,
      priority: 'P1',
      params,
    });
  }

  /**
   * Amends an in-flight limit order (PUT /fapi/v1/order) with HMAC signature.
   * Returns -5022 Post-Only rejection error when order would trigger as taker.
   */
  async modifyOrder(
    symbol: string,
    orderId: string | number,
    price: number,
    quantity: number,
    side: TradeSide
  ): Promise<any> {
    const sym = symbol.toUpperCase();
    const rules = this.getSymbolRules(sym);
    const snappedPrice = snapPriceToTick(price, rules.tickSize);
    const snappedQty = snapQuantityToStep(quantity, rules.stepSize);
    try {
      return await this.request<any>('/fapi/v1/order', {
        method: 'PUT',
        signed: true,
        priority: 'P1',
        params: {
          symbol: sym,
          orderId: String(orderId),
          side,
          price: snappedPrice,
          quantity: snappedQty,
        },
      });
    } catch (err: any) {
      // Surface -5022 (Post-Only would trigger as taker) explicitly
      if (err?.code === -5022 || (typeof err?.message === 'string' && err.message.includes('-5022'))) {
        const e = new BinanceApiError(
          err.message || 'Post Only order would immediately trigger as taker order.',
          err.statusCode ?? 400,
          -5022,
          false
        );
        throw e;
      }
      throw err;
    }
  }
}
