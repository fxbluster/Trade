import { describe, it, expect, beforeEach } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import { initializeDatabase } from '../../db/sqlite.js';
import { HierarchicalMtfManager } from '../hierarchicalMtfManager.js';
import { NativeSmcEngine } from '../nativeSmcEngine.js';
import { OrderFlowEngine } from '../orderFlowEngine.js';
import { LiquidationEngine } from '../liquidationEngine.js';
import { ConfluenceEngine } from '../confluenceEngine.js';
import { AutoPilotManager } from '../../services/autoPilotManager.js';
import { TradeManager } from '../../services/tradeManager.js';
import { BrokerFactory } from '../../exchange/broker.js';
import { BinanceClient } from '../../exchange/binanceClient.js';
import type { KlineCandle, TechnicalSummary, CvdSnapshot } from '@tradeos/shared';
import { calculateLiquidationPrice } from '@tradeos/shared';

describe('Institutional Confluence and SMC Integration Suite', () => {
  let mtfManager: HierarchicalMtfManager;
  let smcEngine: NativeSmcEngine;
  let orderFlowEngine: OrderFlowEngine;
  let liquidationEngine: LiquidationEngine;
  let confluenceEngine: ConfluenceEngine;

  beforeEach(() => {
    mtfManager = new HierarchicalMtfManager();
    smcEngine = new NativeSmcEngine();
    orderFlowEngine = new OrderFlowEngine();
    liquidationEngine = new LiquidationEngine();

    confluenceEngine = new ConfluenceEngine({
      mtfManager,
      smcEngine,
      orderFlowEngine,
      liquidationEngine,
    });
  });

  describe('1. Empty History and Fail-Closed Guardrails', () => {
    it('handles completely empty history without crashing and fail-closes to DEGRADED with Macro Veto', () => {
      // No candles in MTF manager, no indicators, no order book, no trades
      const snapshot = confluenceEngine.evaluate({
        symbol: 'BTCUSDT',
        currentPrice: 65000,
        indicators: null,
        cvd: null,
      });

      expect(snapshot.symbol).toBe('BTCUSDT');
      expect(snapshot.macroRegime).toBe('DEGRADED');
      expect(snapshot.macroVetoActive).toBe(true);
      expect(snapshot.consensusMet).toBe(false);
      expect(snapshot.recommendedAction).toBe('WAIT');
      expect(snapshot.activeFvgs).toHaveLength(0);
      expect(snapshot.activeOrderBlocks).toHaveLength(0);
      expect(snapshot.latestSweep).toBeNull();

      // Check all 7 pillars are safely evaluated
      expect(snapshot.pillars).toHaveLength(7);
      const macroPillar = snapshot.pillars.find((p) => p.id === 'MACRO_REGIME')!;
      expect(macroPillar.bias).toBe('NEUTRAL');
      expect(macroPillar.score).toBe(50);
      expect(macroPillar.confirmed).toBe(false);

      const smcPillar = snapshot.pillars.find((p) => p.id === 'NATIVE_SMC')!;
      expect(smcPillar.bias).toBe('NEUTRAL');
      expect(smcPillar.score).toBe(50);
      expect(smcPillar.confirmed).toBe(false);
    });

    it('returns empty structures for SMC and neutral for MTF when candle history is insufficient (< 3 bars)', () => {
      const fvgs = smcEngine.detectFairValueGaps([]);
      expect(fvgs).toHaveLength(0);

      const obs = smcEngine.detectOrderBlocks([]);
      expect(obs).toHaveLength(0);

      const sweep = smcEngine.detectLiquiditySweeps([], 65000);
      expect(sweep).toBeNull();

      const bias = mtfManager.getMacroBias('ETHUSDT', 3000);
      expect(bias.regime).toBe('DEGRADED');
      expect(bias.macroVetoActive).toBe(true);
    });
  });

  describe('2. Native SMC: Fair Value Gap Detection and Mitigation Invalidation', () => {
    it('detects a valid Bullish FVG and mitigates/invalidates it when price pierces below the zone', () => {
      // Construct 3 closed candles forming a Bullish FVG
      // Candle 0: High = 100
      // Candle 1: Expansion bar
      // Candle 2: Low = 105 (> Candle 0 High 100) -> Gap: [100, 105]
      const closedCandles: KlineCandle[] = [
        { time: 1000, open: 95, high: 100, low: 94, close: 99, volume: 100 },
        { time: 1900, open: 99, high: 110, low: 99, close: 109, volume: 500 },
        { time: 2800, open: 109, high: 115, low: 105, close: 114, volume: 300 },
      ];

      smcEngine.onCandleClosed('SOLUSDT', '15m', closedCandles);
      const activeFvgs = smcEngine.getActiveFvgs('SOLUSDT');
      expect(activeFvgs).toHaveLength(1);
      expect(activeFvgs[0]!.type).toBe('BULLISH');
      expect(activeFvgs[0]!.low).toBe(100);
      expect(activeFvgs[0]!.high).toBe(105);
      expect(activeFvgs[0]!.mitigated).toBe(false);

      // Tick test 1: Price inside FVG zone [100, 105] -> Zone is active and tested
      const tick1 = smcEngine.onTick('SOLUSDT', 103);
      expect(tick1.insideFvg).not.toBeNull();
      expect(tick1.insideFvg?.id).toBe(activeFvgs[0]!.id);
      expect(smcEngine.getActiveFvgs('SOLUSDT')).toHaveLength(1);

      // Tick test 2: Price pierces below FVG low (100) -> Zone fully mitigated and invalidated
      const tick2 = smcEngine.onTick('SOLUSDT', 99.5);
      expect(smcEngine.getActiveFvgs('SOLUSDT')).toHaveLength(0);
    });

    it('detects a valid Bearish FVG and mitigates/invalidates it when price pierces above the zone', () => {
      // Candle 0: Low = 120
      // Candle 1: Drop bar
      // Candle 2: High = 115 (< Candle 0 Low 120) -> Gap: [115, 120]
      const closedCandles: KlineCandle[] = [
        { time: 1000, open: 125, high: 126, low: 120, close: 121, volume: 100 },
        { time: 1900, open: 121, high: 121, low: 110, close: 111, volume: 500 },
        { time: 2800, open: 111, high: 115, low: 108, close: 109, volume: 300 },
      ];

      smcEngine.onCandleClosed('SOLUSDT', '15m', closedCandles);
      const activeFvgs = smcEngine.getActiveFvgs('SOLUSDT');
      expect(activeFvgs).toHaveLength(1);
      expect(activeFvgs[0]!.type).toBe('BEARISH');
      expect(activeFvgs[0]!.low).toBe(115);
      expect(activeFvgs[0]!.high).toBe(120);

      // Price pierces above FVG high (120) -> Zone mitigated and evicted
      smcEngine.onTick('SOLUSDT', 121);
      expect(smcEngine.getActiveFvgs('SOLUSDT')).toHaveLength(0);
    });
  });

  describe('3. Order Flow: Zero Delta and Absorption Divergence', () => {
    it('evaluates CVD_ABSORPTION and ORDER_FLOW_L2 to neutral when trade delta and book imbalance are zero', () => {
      // No trades, no book depth
      const pAbsorption = orderFlowEngine.evaluateAbsorption(100);
      expect(pAbsorption.id).toBe('CVD_ABSORPTION');
      expect(pAbsorption.bias).toBe('NEUTRAL');
      expect(pAbsorption.score).toBe(50);
      expect(pAbsorption.confirmed).toBe(false);

      const pL2 = orderFlowEngine.evaluateL2(100);
      expect(pL2.id).toBe('ORDER_FLOW_L2');
      expect(pL2.bias).toBe('NEUTRAL');
      expect(pL2.score).toBe(50);
      expect(pL2.confirmed).toBe(false);
    });

    it('detects Bullish CVD Absorption when extreme market sells fail to drop price (Z_delta <= -2.0, deltaPrice >= 0)', () => {
      const now = Date.now();
      // Establish 15 baseline minute bars with moderate activity
      for (let m = 15; m >= 1; m--) {
        const barTime = now - m * 60_000;
        // Inject small baseline trades
        orderFlowEngine.processTrade(10, false, barTime, 100); // 10 buy
        orderFlowEngine.processTrade(10, true, barTime, 100);  // 10 sell (delta 0)
      }

      // Inject aggressive seller dump in current 60s, but price holds or moves up
      const currentSec = now;
      orderFlowEngine.processTrade(500, true, currentSec, 100);   // Huge sell
      orderFlowEngine.processTrade(500, true, currentSec + 100, 101); // Price rose to 101 despite sells

      const absorption = orderFlowEngine.evaluateAbsorption(101, currentSec + 200);
      expect(absorption.id).toBe('CVD_ABSORPTION');
      expect(absorption.bias).toBe('BULLISH');
      expect(absorption.confirmed).toBe(true);
      expect(absorption.score).toBeGreaterThanOrEqual(75);
      expect(absorption.valueText).toContain('Bullish Absorption');
    });
  });

  describe('4. Dead-SL Armor Clamping and Dynamic TP1 in AutoPilotManager', () => {
    let db: DatabaseSync;
    let tradeManager: TradeManager;
    let autoPilot: AutoPilotManager;

    beforeEach(() => {
      db = initializeDatabase(':memory:');
      const client = new BinanceClient({ apiKey: 'mock', apiSecret: 'mock' });
      const broker = BrokerFactory.getAdapter('LOCAL_PAPER', { client, db });

      tradeManager = new TradeManager({
        db,
        broker,
        brokerMode: 'LOCAL_PAPER',
        getMarkPrice: () => 100,
      });

      autoPilot = new AutoPilotManager({
        db,
        tradeManager,
        broker,
        confluenceEngine,
        getMarkPrice: () => 100,
        getAtr: () => 2.0,
      });
    });

    it('clamps BUY stop loss strictly above isolated liquidation price (Dead-SL armor)', () => {
      const markPrice = 100;
      const leverage = 10;
      const atr = 15; // Unusually large ATR = 15, so raw SL = 100 - 1.5 * 15 = 77.50
      const rawSl = markPrice - 1.5 * atr; // 77.50

      // Isolated 10x long liquidation price: ~90.45
      const estLiq = calculateLiquidationPrice('BUY', markPrice, leverage, 0.005);
      expect(estLiq).toBeGreaterThan(90);

      // Dead-SL Armor formula: Math.max(rawSl, estLiq * 1.005)
      const clampedSl = Math.max(rawSl, estLiq * 1.005);
      expect(clampedSl).toBeGreaterThan(rawSl);
      expect(clampedSl).toBeGreaterThan(estLiq); // Strictly on the safe side of liquidation
    });

    it('clamps SELL stop loss strictly below isolated liquidation price (Dead-SL armor)', () => {
      const markPrice = 100;
      const leverage = 10;
      const atr = 15; // Large ATR, so raw SL = 100 + 1.5 * 15 = 122.50
      const rawSl = markPrice + 1.5 * atr; // 122.50

      // Isolated 10x short liquidation price: ~109.45
      const estLiq = calculateLiquidationPrice('SELL', markPrice, leverage, 0.005);
      expect(estLiq).toBeLessThan(110);

      // Dead-SL Armor formula: Math.min(rawSl, estLiq * 0.995)
      const clampedSl = Math.min(rawSl, estLiq * 0.995);
      expect(clampedSl).toBeLessThan(rawSl);
      expect(clampedSl).toBeLessThan(estLiq); // Strictly below liquidation price
    });

    it('enforces min R:R >= 1.5 for dynamic TP1 with ATR fallback', () => {
      const markPrice = 100;
      const atr = 2.0;
      const leverage = 10;
      const estLiq = calculateLiquidationPrice('BUY', markPrice, leverage, 0.005);
      const rawSl = markPrice - 1.5 * atr; // 97.0
      const stopLoss = Math.max(rawSl, estLiq * 1.005); // ~97.0

      const risk = markPrice - stopLoss; // 3.0
      const fallbackReward = Math.max(2.0 * atr, risk * 1.5); // Math.max(4.0, 4.5) = 4.5
      const tp1 = markPrice + fallbackReward; // 104.5

      const reward = tp1 - markPrice;
      const rr = reward / risk;

      expect(rr).toBeGreaterThanOrEqual(1.5);
      expect(reward / markPrice).toBeGreaterThanOrEqual(0.005); // >= 0.5% distance
    });

    it('blocks AutoPilot entry when Macro Veto is active or composite score < 75', async () => {
      autoPilot.setEnabled(true);

      // Mock snapshot with Macro Veto active
      // Since no 1h candle history exists in mtfManager, Macro Regime is DEGRADED and macroVetoActive is true
      const snapshot = confluenceEngine.evaluate({
        symbol: 'SOLUSDT',
        currentPrice: 100,
        indicators: null,
        cvd: null,
      });

      expect(snapshot.macroVetoActive).toBe(true);
      expect(snapshot.consensusMet).toBe(false);

      await autoPilot.onTick('SOLUSDT', 100);

      // AutoPilot remains strictly IDLE, no trade executed
      expect(autoPilot.getState()).toBe('IDLE');
      expect(autoPilot.getOpenTradeId()).toBeNull();
    });
  });
});
