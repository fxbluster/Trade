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
} from '@tradeos/shared';

let sessionToken: string | null = null;
let sessionPromise: Promise<string> | null = null;

export async function getSessionToken(): Promise<string> {
  if (typeof sessionStorage !== 'undefined') {
    const stored = sessionStorage.getItem('tradeos_session_token');
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
        const res = await fetch('/api/auth/session');
        if (!res.ok) {
          throw new Error(`Failed to acquire session token: ${res.status} ${res.statusText}`);
        }
        const data = await res.json();
        sessionToken = data.token;
        if (typeof sessionStorage !== 'undefined') {
          sessionStorage.setItem('tradeos_session_token', sessionToken!);
        }
        return sessionToken!;
      } catch (err) {
        sessionPromise = null;
        sessionToken = 'local-dev-token';
        return sessionToken;
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
    sessionStorage.removeItem('tradeos_session_token');
  }
}

async function request<T>(path: string, options: RequestInit = {}, isRetry = false): Promise<T> {
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
    return request<T>(path, options, true);
  }

  if (!res.ok) {
    let errMsg = `Request failed: ${res.status} ${res.statusText}`;
    try {
      const errJson = await res.json();
      if (errJson && errJson.error) {
        errMsg = errJson.error;
      }
    } catch {
      // Use status text if body not json
    }
    const error: any = new Error(errMsg);
    error.status = res.status;
    throw error;
  }

  return res.json() as Promise<T>;
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
