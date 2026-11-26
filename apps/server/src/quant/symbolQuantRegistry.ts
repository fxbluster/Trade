import type { DatabaseSync } from 'node:sqlite';
import type { ConfluenceSnapshot } from '@tradeos/shared';
import { CvdEngine } from './cvd.js';
import { NoiseBandEngine } from './noiseBandEngine.js';
import { AlphaRegistry } from './alphaRegistry.js';
import {
  OrderFlowFactor,
  NativeSmcFactor,
  CvdAbsorptionFactor,
  MacroRegimeFactor,
  FundingArbitrageFactor,
  CrossExchangeSweepFactor,
  LiqClustersFactor,
} from './factors/index.js';
import { ConfluenceEngine } from './confluenceEngine.js';
import { HierarchicalMtfManager } from './hierarchicalMtfManager.js';
import { NativeSmcEngine } from './nativeSmcEngine.js';
import { SentimentHarvester } from './sentimentHarvester.js';
import { EconomicEventGuard } from './economicEventGuard.js';

export const DEFAULT_AUTOPILOT_SYMBOLS: readonly string[] = [
  'SOLUSDT',
  'BTCUSDT',
  'ETHUSDT',
  'XRPUSDT',
];

/**
 * Parses a comma-separated watchlist string (e.g. `AUTOPILOT_SYMBOLS`) into
 * normalized, deduplicated uppercase symbol strings, falling back to
 * `DEFAULT_AUTOPILOT_SYMBOLS` when empty or undefined.
 */
export function parseWatchlistSymbols(envVal?: string): string[] {
  if (!envVal || !envVal.trim()) {
    return [...DEFAULT_AUTOPILOT_SYMBOLS];
  }

  const seen = new Set<string>();
  const parsed: string[] = [];

  for (const raw of envVal.split(',')) {
    const sym = raw.trim().toUpperCase();
    if (sym && !seen.has(sym)) {
      seen.add(sym);
      parsed.push(sym);
    }
  }

  return parsed.length > 0 ? parsed : [...DEFAULT_AUTOPILOT_SYMBOLS];
}

export interface SymbolQuantContext {
  symbol: string;
  cvdEngine: CvdEngine;
  noiseBandEngine: NoiseBandEngine;
  alphaRegistry: AlphaRegistry;
  confluenceEngine: ConfluenceEngine;
}

export interface SymbolQuantRegistryOptions {
  mtfManager?: HierarchicalMtfManager;
  smcEngine?: NativeSmcEngine;
  sentimentHarvester?: SentimentHarvester;
  economicEventGuard?: EconomicEventGuard;
}

/**
 * Manages isolated per-symbol stateful quantitative engines (`CvdEngine`,
 * `NoiseBandEngine`, `AlphaRegistry`, `ConfluenceEngine`) while sharing
 * symbol-keyed or stateless subsystems across the watchlist.
 */
export class SymbolQuantRegistry {
  private readonly contexts = new Map<string, SymbolQuantContext>();
  private readonly mtfManager: HierarchicalMtfManager;
  private readonly smcEngine: NativeSmcEngine;
  private readonly sentimentHarvester: SentimentHarvester;
  private readonly economicEventGuard: EconomicEventGuard;
  private consensusThreshold?: number;
  private calibratedWeights?: Record<string, number>;

  constructor(options: SymbolQuantRegistryOptions = {}) {
    this.mtfManager = options.mtfManager ?? new HierarchicalMtfManager();
    this.smcEngine = options.smcEngine ?? new NativeSmcEngine();
    this.sentimentHarvester = options.sentimentHarvester ?? new SentimentHarvester();
    this.economicEventGuard = options.economicEventGuard ?? new EconomicEventGuard();
  }

  public getOrCreate(symbol: string): SymbolQuantContext {
    const sym = symbol.trim().toUpperCase();
    const existing = this.contexts.get(sym);
    if (existing) {
      return existing;
    }

    const cvdEngine = new CvdEngine(sym);
    const noiseBandEngine = new NoiseBandEngine();

    const alphaRegistry = new AlphaRegistry();
    alphaRegistry.registerFactor(new OrderFlowFactor());
    alphaRegistry.registerFactor(new NativeSmcFactor());
    alphaRegistry.registerFactor(new CvdAbsorptionFactor());
    alphaRegistry.registerFactor(new MacroRegimeFactor());
    alphaRegistry.registerFactor(new FundingArbitrageFactor());
    alphaRegistry.registerFactor(new CrossExchangeSweepFactor());
    alphaRegistry.registerFactor(new LiqClustersFactor());

    if (this.calibratedWeights) {
      alphaRegistry.applyCalibratedWeights(this.calibratedWeights);
    }

    const confluenceEngine = new ConfluenceEngine({
      mtfManager: this.mtfManager,
      smcEngine: this.smcEngine,
      sentimentHarvester: this.sentimentHarvester,
      economicEventGuard: this.economicEventGuard,
      noiseBandEngine,
      alphaRegistry,
    });

    if (this.consensusThreshold !== undefined) {
      confluenceEngine.setConsensusThreshold(this.consensusThreshold);
    }

    const ctx: SymbolQuantContext = {
      symbol: sym,
      cvdEngine,
      noiseBandEngine,
      alphaRegistry,
      confluenceEngine,
    };

    this.contexts.set(sym, ctx);
    return ctx;
  }

  public get(symbol: string): SymbolQuantContext | undefined {
    return this.contexts.get(symbol.trim().toUpperCase());
  }

  public getAll(): SymbolQuantContext[] {
    return Array.from(this.contexts.values());
  }

  public getLatestSnapshot(symbol: string): ConfluenceSnapshot | null {
    const sym = symbol.trim().toUpperCase();
    return this.contexts.get(sym)?.confluenceEngine.getLatestSnapshot(sym) ?? null;
  }

  public setConsensusThreshold(threshold: number): void {
    this.consensusThreshold = threshold;
    for (const ctx of this.contexts.values()) {
      ctx.confluenceEngine.setConsensusThreshold(threshold);
    }
  }

  public applyCalibratedWeights(weights: Record<string, number>): void {
    this.calibratedWeights = { ...weights };
    for (const ctx of this.contexts.values()) {
      ctx.alphaRegistry.applyCalibratedWeights(weights);
    }
  }

  public async initializeAll(db: DatabaseSync): Promise<void> {
    for (const ctx of this.contexts.values()) {
      await ctx.alphaRegistry.initialize(db);
    }
  }
}
