import type { PillarEvaluation } from '@tradeos/shared';

export interface SentimentAnalysisResult {
  compound: number; // -1.0 to +1.0
  positive: number;
  negative: number;
  neutral: number;
}

/**
 * Domain-specific Crypto VADER Sentiment Lexicon.
 * Word -> valence rating between -4.0 (extremely negative) and +4.0 (extremely positive).
 */
const VADER_CRYPTO_LEXICON: Record<string, number> = {
  // Positive catalysts & terms
  bull: 2.2,
  bullish: 2.5,
  surge: 2.8,
  surging: 2.8,
  rally: 2.6,
  breakout: 2.7,
  pump: 2.0,
  pumping: 2.0,
  adoption: 2.2,
  approval: 2.9,
  approve: 2.5,
  approved: 2.8,
  inflow: 2.1,
  inflows: 2.3,
  gain: 1.8,
  gains: 2.0,
  profit: 1.9,
  ath: 3.2,
  record: 2.0,
  soar: 2.9,
  soaring: 2.9,
  upgrade: 1.9,
  partnership: 2.1,
  positive: 1.9,
  optimistic: 2.0,
  strong: 1.7,
  green: 1.5,
  accumulate: 2.0,
  accumulation: 2.1,

  // Negative catalysts & terms
  bear: -2.2,
  bearish: -2.5,
  crash: -3.4,
  crashing: -3.4,
  dump: -2.8,
  dumping: -2.8,
  ban: -3.1,
  banned: -3.1,
  hack: -3.5,
  hacked: -3.6,
  exploit: -3.2,
  exploited: -3.3,
  sec: -1.5,
  lawsuit: -2.6,
  sue: -2.4,
  sued: -2.5,
  fraud: -3.7,
  fraudulent: -3.7,
  plunge: -2.9,
  plunging: -2.9,
  slump: -2.4,
  outflow: -2.1,
  outflows: -2.3,
  liquidate: -2.6,
  liquidation: -2.7,
  collapse: -3.5,
  collapsing: -3.5,
  loss: -2.0,
  losses: -2.2,
  scam: -3.6,
  panic: -3.0,
  fud: -2.2,
  subpoena: -2.5,
  investigation: -2.1,
  insolvent: -3.8,
  insolvency: -3.8,
  bankrupt: -3.7,
  bankruptcy: -3.7,
};

const INTENSIFIERS: Record<string, number> = {
  very: 1.5,
  extremely: 1.8,
  massive: 1.7,
  huge: 1.6,
  super: 1.5,
  strongly: 1.5,
};

const NEGATORS = new Set<string>(['not', 'no', 'never', 'without', "don't", 'cant', 'cannot']);

/**
 * Analyzes arbitrary text or headlines using zero-dependency VADER lexicon.
 */
export function analyzeText(text: string): SentimentAnalysisResult {
  if (!text || typeof text !== 'string') {
    return { compound: 0, positive: 0, negative: 0, neutral: 1 };
  }

  const cleanWords = text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);

  if (cleanWords.length === 0) {
    return { compound: 0, positive: 0, negative: 0, neutral: 1 };
  }

  let totalValence = 0;
  let posCount = 0;
  let negCount = 0;
  let neuCount = 0;

  for (let i = 0; i < cleanWords.length; i++) {
    const word = cleanWords[i];
    let valence = VADER_CRYPTO_LEXICON[word] || 0;

    if (valence !== 0) {
      // Check prior word for intensifier (e.g. "massive surge")
      if (i > 0) {
        const prev = cleanWords[i - 1];
        if (INTENSIFIERS[prev]) {
          valence *= INTENSIFIERS[prev];
        }
        // Check prior word for negation (e.g. "not dumping")
        if (NEGATORS.has(prev)) {
          valence *= -0.75;
        }
      }

      totalValence += valence;
      if (valence > 0) posCount++;
      else if (valence < 0) negCount++;
    } else {
      neuCount++;
    }
  }

  // Classic VADER compound score normalization formula: x / sqrt(x^2 + alpha)
  const alpha = 15;
  const compound = totalValence === 0
    ? 0
    : Number((totalValence / Math.sqrt(totalValence * totalValence + alpha)).toFixed(4));

  const totalTokens = Math.max(1, posCount + negCount + neuCount);
  return {
    compound: Math.max(-1, Math.min(1, compound)),
    positive: Number((posCount / totalTokens).toFixed(2)),
    negative: Number((negCount / totalTokens).toFixed(2)),
    neutral: Number((neuCount / totalTokens).toFixed(2)),
  };
}

/**
 * SentimentHarvester — Background worker for Pillar 6 (NLP_NEWS, Weight: 10%).
 * Operates with a 3-minute atomic cache ensuring 0ms blocking in the main execution loop.
 */
export class SentimentHarvester {
  private cachedEvaluation: PillarEvaluation;
  private timer: NodeJS.Timeout | null = null;
  private readonly cryptoPanicApiKey: string;
  private isPolling: boolean = false;

  constructor(cryptoPanicApiKey: string = '') {
    this.cryptoPanicApiKey = cryptoPanicApiKey;
    this.cachedEvaluation = {
      id: 'SENTIMENT_MACRO',
      title: 'Sentiment & Funding Rate',
      score: 50,
      bias: 'NEUTRAL',
      valueText: 'Neutral (0.00)',
      subText: 'No recent breaking headlines',
      confirmed: false,
      updatedAt: Date.now(),
    };
  }

  /**
   * Evaluates the current cached sentiment. Zero latency (0ms synchronous read).
   */
  public evaluate(): PillarEvaluation {
    return { ...this.cachedEvaluation };
  }

  /**
   * Sets mock headlines directly (ideal for unit tests & offline mode).
   */
  public setHeadlines(headlines: string[]): void {
    if (!headlines || headlines.length === 0) {
      this.cachedEvaluation = {
        id: 'SENTIMENT_MACRO',
        title: 'Sentiment & Funding Rate',
        score: 50,
        bias: 'NEUTRAL',
        valueText: 'Neutral (0.00)',
        subText: 'No headlines loaded',
        confirmed: false,
        updatedAt: Date.now(),
      };
      return;
    }

    const aggregatedText = headlines.join('. ');
    const result = analyzeText(aggregatedText);

    let bias: 'BULLISH' | 'BEARISH' | 'NEUTRAL' = 'NEUTRAL';
    let confirmed = false;
    let score = 50;

    if (result.compound > 0.25) {
      bias = 'BULLISH';
      confirmed = true;
      score = Math.min(100, Math.round(50 + result.compound * 50));
    } else if (result.compound < -0.25) {
      bias = 'BEARISH';
      confirmed = true;
      score = Math.min(100, Math.round(50 + Math.abs(result.compound) * 50));
    }

    const polarity = result.compound > 0 ? '+' : '';
    const sampleHeadline = headlines[0].length > 40 ? `${headlines[0].slice(0, 37)}...` : headlines[0];

    this.cachedEvaluation = {
      id: 'SENTIMENT_MACRO',
      title: 'Sentiment & Funding Rate',
      score,
      bias,
      valueText: `${bias === 'BULLISH' ? 'Bullish' : bias === 'BEARISH' ? 'Bearish' : 'Neutral'} (${polarity}${result.compound.toFixed(2)})`,
      subText: `${headlines.length} headlines: "${sampleHeadline}"`,
      confirmed,
      updatedAt: Date.now(),
    };
  }

  /**
   * Background polling routine. Runs asynchronously with 3000ms timeout.
   */
  public async poll(): Promise<void> {
    if (this.isPolling) return;
    this.isPolling = true;

    try {
      const headlines: string[] = [];

      // Try CryptoPanic public API if key available or fallback to CoinDesk RSS
      if (this.cryptoPanicApiKey && !this.cryptoPanicApiKey.includes('PLACEHOLDER')) {
        try {
          const res = await fetch(
            `https://cryptopanic.com/api/v1/posts/?auth_token=${this.cryptoPanicApiKey}&public=true`,
            { signal: AbortSignal.timeout(3000) }
          );
          if (res.ok) {
            const data = (await res.json()) as { results?: { title?: string }[] };
            if (Array.isArray(data.results)) {
              for (const post of data.results.slice(0, 10)) {
                if (post?.title) headlines.push(post.title);
              }
            }
          }
        } catch (_) {}
      }

      // CoinDesk free RSS fallback if CryptoPanic empty
      if (headlines.length === 0) {
        try {
          const res = await fetch('https://www.coindesk.com/arc/outboundfeeds/rss/', {
            signal: AbortSignal.timeout(3000),
          });
          if (res.ok) {
            const xml = await res.text();
            const titles = xml.match(/<title><!\[CDATA\[(.*?)\]\]><\/title>|<title>(.*?)<\/title>/g) || [];
            for (const t of titles.slice(1, 8)) {
              const clean = t.replace(/<\/?title>|<!\[CDATA\[|\]\]>/g, '').trim();
              if (clean && !clean.includes('CoinDesk')) headlines.push(clean);
            }
          }
        } catch (_) {}
      }

      if (headlines.length > 0) {
        this.setHeadlines(headlines);
      }
    } catch {
      // Soft-fail: keep last known cache or neutral
    } finally {
      this.isPolling = false;
    }
  }

  /**
   * Starts periodic polling (every 3 minutes).
   */
  public start(intervalMs: number = 180000): void {
    if (this.timer) return;
    // Initial fetch
    void this.poll();
    this.timer = setInterval(() => {
      void this.poll();
    }, intervalMs);
  }

  /**
   * Stops periodic polling.
   */
  public stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}
