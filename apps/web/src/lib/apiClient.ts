import type {
  CockpitState,
  KlineCandle,
  ScannerItem,
  JournalSummary,
  OpenOrderRequest,
  OrderPreviewRequest,
  OrderPreviewResponse,
  BrokerMode,
  HealthResponse,
  MentorChatResponse,
  RiskStateRecord,
  ConfluenceSnapshot,
  AutoPilotConfig,
  TrajectoryHorizon,
  PillarAttributionResponse,
  DailyAuditResponse,
  PnlSummaryResponse,
  PropFirmStatusResponse,
  PropFirmCertificateResponse,
} from '@tradeos/shared';

const SESSION_TOKEN_STORAGE_KEY = 'tradeos_session_token';
const OPERATOR_PIN_STORAGE_KEY = 'tradeos_operator_pin';

export class PinRequiredError extends Error {
  public readonly status = 401;
  public readonly code = 'PIN_REQUIRED';

  constructor(message = 'Operator access PIN is required') {
    super(message);
    this.name = 'PinRequiredError';
  }
}

export function isPinRequiredError(err: unknown): err is PinRequiredError {
  return (
    err instanceof PinRequiredError ||
    (typeof err === 'object' &&
      err !== null &&
      ((err as { name?: string }).name === 'PinRequiredError' ||
        (err as { code?: string }).code === 'PIN_REQUIRED'))
  );
}

let sessionToken: string | null = null;
let sessionPromise: Promise<string> | null = null;
let operatorPin: string | null = null;
const pinRequiredListeners = new Set<() => void>();

export function onPinRequired(listener: () => void): () => void {
  pinRequiredListeners.add(listener);
  return () => {
    pinRequiredListeners.delete(listener);
  };
}

function notifyPinRequired(): void {
  pinRequiredListeners.forEach((listener) => {
    try {
      listener();
    } catch {
      // Ignore listener errors
    }
  });
}

export function getOperatorPin(): string | null {
  if (typeof sessionStorage !== 'undefined') {
    try {
      const stored = sessionStorage.getItem(OPERATOR_PIN_STORAGE_KEY);
      if (stored) {
        operatorPin = stored;
        return operatorPin;
      }
    } catch {
      // Ignore storage read errors
    }
  }
  return operatorPin;
}

export function setOperatorPin(pin: string): void {
  const trimmed = pin.trim();
  operatorPin = trimmed || null;
  if (typeof sessionStorage !== 'undefined') {
    try {
      if (operatorPin) {
        sessionStorage.setItem(OPERATOR_PIN_STORAGE_KEY, operatorPin);
      } else {
        sessionStorage.removeItem(OPERATOR_PIN_STORAGE_KEY);
      }
    } catch {
      // Ignore storage write errors
    }
  }
  invalidateSessionToken();
}

export function clearOperatorPin(): void {
  operatorPin = null;
  if (typeof sessionStorage !== 'undefined') {
    try {
      sessionStorage.removeItem(OPERATOR_PIN_STORAGE_KEY);
    } catch {
      // Ignore storage remove errors
    }
  }
  invalidateSessionToken();
}

export async function getSessionToken(): Promise<string> {
  if (typeof sessionStorage !== 'undefined') {
    const stored = sessionStorage.getItem(SESSION_TOKEN_STORAGE_KEY);
    if (stored) {
      sessionToken = stored;
      return sessionToken;
    }
  } else if (sessionToken) {
    return sessionToken;
  }

  if (!sessionPromise) {
    sessionPromise = (async () => {
      try {
        const pin = getOperatorPin();
        const res = pin
          ? await fetch('/api/auth/session', {
              headers: {
                'X-Operator-Pin': pin,
              },
            })
          : await fetch('/api/auth/session');

        if (res.status === 401) {
          clearOperatorPin();
          notifyPinRequired();
          throw new PinRequiredError('Operator access PIN required or invalid');
        }
        if (!res.ok) {
          const err: Error & { status?: number } = new Error(
            `Failed to acquire session token: ${res.status} ${res.statusText}`
          );
          err.status = res.status;
          throw err;
        }
        const data = await res.json();
        if (!data?.token) {
          throw new Error('Session response did not include a token');
        }
        sessionToken = data.token;
        if (typeof sessionStorage !== 'undefined') {
          sessionStorage.setItem(SESSION_TOKEN_STORAGE_KEY, sessionToken!);
        }
        return sessionToken!;
      } catch (err) {
        sessionPromise = null;
        sessionToken = null;
        throw err;
      }
    })();
  }
  return sessionPromise;
}

export function setExplicitSessionToken(token: string) {
  sessionToken = token;
}

export function invalidateSessionToken(): void {
  sessionToken = null;
  sessionPromise = null;
  if (typeof sessionStorage !== 'undefined') {
    sessionStorage.removeItem(SESSION_TOKEN_STORAGE_KEY);
  }
}

async function fetchAuthenticatedResponse(
  path: string,
  options: RequestInit = {},
  isRetry = false
): Promise<Response> {
  const token = await getSessionToken();
  const headers = new Headers(options.headers || {});
  if (!headers.has('Authorization') && token) {
    headers.set('Authorization', `Bearer ${token}`);
  }
  if (options.body && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }

  const res = await fetch(path, {
    ...options,
    headers,
  });

  if (res.status === 401 && !isRetry) {
    invalidateSessionToken();
    return fetchAuthenticatedResponse(path, options, true);
  }

  if (!res.ok) {
    let errMsg = `Request failed: ${res.status} ${res.statusText}`;
    let errCode: string | undefined;
    try {
      const errJson = await res.json();
      if (errJson) {
        errMsg = errJson.message || errJson.error || errMsg;
        errCode = errJson.code ?? errJson.error;
      }
    } catch {
      // Use status text if body not json
    }
    const error: any = new Error(errMsg);
    error.status = res.status;
    if (errCode !== undefined) {
      error.code = errCode;
    }
    throw error;
  }

  return res;
}

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const res = await fetchAuthenticatedResponse(path, options);
  return res.json() as Promise<T>;
}

function getPropFirmCertificate(format?: 'json'): Promise<PropFirmCertificateResponse>;
function getPropFirmCertificate(format: 'markdown'): Promise<string>;
async function getPropFirmCertificate(
  format: 'json' | 'markdown' = 'json'
): Promise<PropFirmCertificateResponse | string> {
  if (format === 'markdown') {
    const res = await fetchAuthenticatedResponse('/api/propfirm/certificate?format=markdown');
    return res.text();
  }
  return request<PropFirmCertificateResponse>('/api/propfirm/certificate');
}

function extractFilenameFromDisposition(disposition: string | null, fallback: string): string {
  if (!disposition) return fallback;
  const match = disposition.match(/filename=["']?([^"';]+)["']?/i);
  if (match && match[1]) {
    return match[1].trim();
  }
  return fallback;
}

function triggerBlobDownload(blob: Blob, filename: string): void {
  const objectUrl = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = objectUrl;
  a.download = filename;
  try {
    document.body.appendChild(a);
    a.click();
  } finally {
    a.remove();
    URL.revokeObjectURL(objectUrl);
  }
}

export const apiClient = {
  async getHealth(): Promise<HealthResponse> {
    const res = await fetch('/api/health');
    if (!res.ok) {
      throw new Error(`Health check failed: ${res.status}`);
    }
    return res.json();
  },

  async getState(): Promise<CockpitState> {
    return request<CockpitState>('/api/state');
  },

  async getKlines(
    symbol: string,
    interval: '1m' | '5m' | '15m' | '1h' = '5m',
    limit: number = 400
  ): Promise<KlineCandle[]> {
    const data = await request<any>(
      `/api/klines?symbol=${encodeURIComponent(symbol)}&interval=${interval}&limit=${limit}`
    );
    if (Array.isArray(data)) return data;
    if (data && Array.isArray(data.klines)) return data.klines;
    return [];
  },

  async getScanner(): Promise<ScannerItem[]> {
    return request<ScannerItem[]>('/api/scanner');
  },

  async setSymbol(symbol: string): Promise<{ ok: boolean; symbol: string }> {
    return request<{ ok: boolean; symbol: string }>('/api/symbol', {
      method: 'POST',
      body: JSON.stringify({ symbol: symbol.toUpperCase() }),
    });
  },

  async setBrokerMode(mode: BrokerMode): Promise<{ ok: boolean; mode: BrokerMode }> {
    return request<{ ok: boolean; mode: BrokerMode }>('/api/broker/mode', {
      method: 'POST',
      body: JSON.stringify({ mode }),
    });
  },

  async previewOrder(order: OrderPreviewRequest): Promise<OrderPreviewResponse> {
    return request<OrderPreviewResponse>('/api/orders/preview', {
      method: 'POST',
      body: JSON.stringify(order),
    });
  },

  async openOrder(order: OpenOrderRequest): Promise<{ ok: boolean; tradeId: string; clientOrderId: string }> {
    return request<{ ok: boolean; tradeId: string; clientOrderId: string }>('/api/orders/open', {
      method: 'POST',
      body: JSON.stringify(order),
    });
  },

  async closeOrder(symbol?: string, reason?: string): Promise<{ ok: boolean; symbol: string; closed: boolean }> {
    return request<{ ok: boolean; symbol: string; closed: boolean }>('/api/orders/close', {
      method: 'POST',
      body: JSON.stringify({ symbol, reason }),
    });
  },

  async moveToBreakeven(symbol?: string): Promise<{ ok: boolean; symbol: string; bePrice: number }> {
    return request<{ ok: boolean; symbol: string; bePrice: number }>('/api/orders/breakeven', {
      method: 'POST',
      body: JSON.stringify({ symbol }),
    });
  },

  async cancelOrder(orderId: string, symbol: string, isAlgo: boolean): Promise<{ ok: boolean }> {
    return request<{ ok: boolean }>(
      `/api/orders/${encodeURIComponent(orderId)}?symbol=${encodeURIComponent(symbol)}&isAlgo=${isAlgo}`,
      { method: 'DELETE' }
    );
  },

  async sync(): Promise<{ ok: boolean }> {
    return request<{ ok: boolean }>('/api/sync', { method: 'POST' });
  },

  async getJournal(limit: number = 50, offset: number = 0, symbol?: string): Promise<JournalSummary> {
    let url = `/api/journal?limit=${limit}&offset=${offset}`;
    if (symbol) {
      url += `&symbol=${encodeURIComponent(symbol)}`;
    }
    return request<JournalSummary>(url);
  },

  async bypassCooldown(reason: string): Promise<{ ok: boolean; risk: RiskStateRecord }> {
    return request<{ ok: boolean; risk: RiskStateRecord }>('/api/cooldown/bypass', {
      method: 'POST',
      body: JSON.stringify({ reason }),
    });
  },

  async chatMentor(message: string): Promise<MentorChatResponse> {
    return request<MentorChatResponse>('/api/mentor/chat', {
      method: 'POST',
      body: JSON.stringify({ message }),
    });
  },

  async getConfluence(symbol?: string): Promise<ConfluenceSnapshot> {
    const url = symbol ? `/api/confluence?symbol=${encodeURIComponent(symbol)}` : '/api/confluence';
    return request<ConfluenceSnapshot>(url);
  },

  async updateAutoPilotConfig(config: Partial<AutoPilotConfig>): Promise<{ ok: boolean; config: AutoPilotConfig }> {
    return request<{ ok: boolean; config: AutoPilotConfig }>('/api/autopilot/config', {
      method: 'POST',
      body: JSON.stringify(config),
    });
  },

  async toggleAutoPilot(enabled?: boolean): Promise<{ ok: boolean; enabled: boolean; state: string }> {
    return request<{ ok: boolean; enabled: boolean; state: string }>('/api/autopilot/toggle', {
      method: 'POST',
      body: JSON.stringify({ enabled }),
    });
  },

  async resetAutoPilotCooldown(): Promise<{ ok: boolean; state?: string }> {
    return request<{ ok: boolean; state?: string }>('/api/autopilot/reset-cooldown', {
      method: 'POST',
    });
  },

  async getPillarScorecard(
    symbol: string = 'SOLUSDT',
    horizon: TrajectoryHorizon = '15m'
  ): Promise<PillarAttributionResponse> {
    return getPillarScorecard(symbol, horizon);
  },

  async downloadDailyAudit(
    format: 'json' | 'markdown' = 'markdown',
    session: 'current' | 'all' = 'current'
  ): Promise<void> {
    return downloadDailyAudit(format, session);
  },

  async getDailyAudit(session: 'current' | 'all' = 'current'): Promise<DailyAuditResponse> {
    return getDailyAudit(session);
  },

  async getPnlSummary(symbol?: string): Promise<PnlSummaryResponse> {
    const sym = symbol ? `?symbol=${encodeURIComponent(symbol)}` : '';
    return request<PnlSummaryResponse>(`/api/pnl/summary${sym}`);
  },

  async getPropFirmStatus(): Promise<PropFirmStatusResponse> {
    return request<PropFirmStatusResponse>('/api/propfirm/status');
  },

  async startNewPropFirmCycle(): Promise<{ ok: boolean; status: PropFirmStatusResponse; autoPilotState?: string }> {
    return request<{ ok: boolean; status: PropFirmStatusResponse; autoPilotState?: string }>('/api/propfirm/new-cycle', {
      method: 'POST',
      body: JSON.stringify({}),
    });
  },

  getPropFirmCertificate,

  async downloadPropFirmCertificateMarkdown(): Promise<void> {
    const res = await fetchAuthenticatedResponse('/api/propfirm/certificate?format=markdown');
    const fallback = `upcomers-50k-certificate-${new Date().toISOString().slice(0, 10)}.md`;
    const filename = extractFilenameFromDisposition(
      res.headers.get('content-disposition'),
      fallback
    );
    const blob = await res.blob();
    triggerBlobDownload(blob, filename);
  },
};

export async function getDailyAudit(session: 'current' | 'all' = 'current'): Promise<DailyAuditResponse> {
  await getSessionToken();
  const url = `/api/audit/daily?format=json&session=${encodeURIComponent(session)}`;
  return request<DailyAuditResponse>(url);
}

export async function getPillarScorecard(
  symbol: string = 'SOLUSDT',
  horizon: TrajectoryHorizon = '15m'
): Promise<PillarAttributionResponse> {
  await getSessionToken();
  const url = `/api/audit/pillars?symbol=${encodeURIComponent(symbol)}&horizon=${encodeURIComponent(horizon)}`;
  return request<PillarAttributionResponse>(url);
}

export async function downloadDailyAudit(
  format: 'json' | 'markdown' = 'markdown',
  session: 'current' | 'all' = 'current'
): Promise<void> {
  const token =
    (typeof sessionStorage !== 'undefined' ? sessionStorage.getItem('tradeos_session_token') : null) ||
    'local-dev-token';

  const res = await fetch(`/api/audit/daily?format=${encodeURIComponent(format)}&session=${encodeURIComponent(session)}`, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });

  if (!res.ok) {
    throw new Error(`Audit export failed: ${res.statusText}`);
  }

  const blob = await res.blob();
  let filename = `tradeos-daily-audit-${Date.now()}.${format === 'markdown' ? 'md' : 'json'}`;
  const disposition = res.headers.get('content-disposition');
  if (disposition) {
    const match = disposition.match(/filename=["']?([^"';]+)["']?/i);
    if (match && match[1]) {
      filename = match[1].trim();
    }
  }

  const objectUrl = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = objectUrl;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(objectUrl);
}

export async function resetAutoPilotCooldown(): Promise<{ ok: boolean; state?: string }> {
  return apiClient.resetAutoPilotCooldown();
}
