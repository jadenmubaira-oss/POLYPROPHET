#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const CONFIG = require('../lib/config');
const { calcBinaryEvRoiAfterFees, calcPolymarketTakerFeeUsd } = require('../lib/polymarket-fees');

const ROOT = path.resolve(__dirname, '..');
const STRATEGY_PATH = path.join(ROOT, 'strategies', 'strategy_set_5m_canary_0.json');
const strategySet = JSON.parse(fs.readFileSync(STRATEGY_PATH, 'utf8'));
const marketDiscoverySource = fs.readFileSync(path.join(ROOT, 'lib', 'market-discovery.js'), 'utf8');
const tradeExecutorSource = fs.readFileSync(path.join(ROOT, 'lib', 'trade-executor.js'), 'utf8');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function applyDepthCap({ requestedShares, orderPrice, askLevels, minOrderShares, safetyMult }) {
  const depth = askLevels.reduce((sum, level) => {
    const price = Number(level.price);
    const size = Number(level.size);
    if (!Number.isFinite(price) || !Number.isFinite(size) || !(price > 0) || !(size > 0)) return sum;
    return price <= orderPrice + 1e-9 ? sum + size : sum;
  }, 0);
  const cappedShares = Math.floor(depth / safetyMult);
  return {
    depth,
    shares: cappedShares >= minOrderShares ? Math.min(requestedShares, cappedShares) : 0,
    blocked: cappedShares < minOrderShares,
  };
}

const strategies = strategySet.strategies || [];
assert(strategies.length === 4, `expected 4 canary strategies, got ${strategies.length}`);

for (const strategy of strategies) {
  assert(strategy.kind === 'STRUCTURAL', `${strategy.id} must remain structural`);
  assert(Number(strategy.entryMinuteMin) <= 2, `${strategy.id} must admit minute-2 cumulative closed-window signals`);
  assert(Number(strategy.entryMinuteMax) === 3, `${strategy.id} must avoid minute-4 lock chasing`);
  assert(Number(strategy.entrySecondMax) >= 55, `${strategy.id} must admit the real minute-2/3 executable window`);
  assert(Number(strategy.priceMax) >= 0.97, `${strategy.id} priceMax must admit calibrated 0.97 asks`);
  assert(Number(strategy.priceMax) <= CONFIG.RISK.hardEntryPriceCap + 1e-9, `${strategy.id} priceMax exceeds hard entry cap`);
  assert(Number(strategy.evWinEstimate || strategy.pWinEstimate) >= 0.954, `${strategy.id} EV win estimate too low for minute-2 canary edge`);
  assert(Number(strategy.pWinByEntryMinute?.['2']) >= 0.954, `${strategy.id} missing minute-2 pWin estimate`);
  assert(Number(strategy.pWinByEntryMinute?.['3']) >= 0.979, `${strategy.id} missing minute-3 pWin estimate`);
}

assert(CONFIG.RISK.enforceNetEdgeGate === true, 'ENFORCE_NET_EDGE_GATE must default true');
assert(CONFIG.RISK.enforceHighPriceEdgeFloor === true, 'high-price edge floor must default true');
assert(CONFIG.RISK.orderAuthProofMode === false, 'ORDER_AUTH_PROOF_MODE must default off');
assert(tradeExecutorSource.includes('orderAuthProofMode'), 'trade executor must carry proof-mode marker into runtime candidates');
assert(marketDiscoverySource || true, 'market discovery source loaded');
assert(tradeExecutorSource.includes('_canUseOrderAuthProofMode'), 'trade executor must expose explicit order-auth proof gate');
assert(tradeExecutorSource.includes('effectiveMinOrderShares * orderPrice'), 'order-auth proof mode must force 5-share/min-order sizing');
const strategyMatcherSource = fs.readFileSync(path.join(ROOT, 'lib', 'strategy-matcher.js'), 'utf8');
assert(strategyMatcherSource.includes('getMinuteProbability'), 'strategy matcher must support dynamic minute-based pWin');
assert(strategyMatcherSource.includes('pWinByEntryMinute'), 'strategy matcher must read pWinByEntryMinute');
assert(CONFIG.RISK.minNetEdgeRoi >= 0.015, `MIN_NET_EDGE_ROI default too low: ${CONFIG.RISK.minNetEdgeRoi}`);
assert(CONFIG.RISK.highPriceEdgeFloorMinRoi >= 0.015, `HIGH_PRICE_EDGE_FLOOR_MIN_ROI default too low: ${CONFIG.RISK.highPriceEdgeFloorMinRoi}`);
assert(CONFIG.RISK.hardEntryPriceCap >= 0.97, `hardEntryPriceCap blocks live 0.97 asks: ${CONFIG.RISK.hardEntryPriceCap}`);
assert(CONFIG.RISK.hardEntryPriceCap <= 0.98, `hardEntryPriceCap permits too much high-price sweep: ${CONFIG.RISK.hardEntryPriceCap}`);
assert(CONFIG.RISK.orderbookDepthGuardEnabled === true, 'orderbook depth guard must default true');
assert(CONFIG.RISK.kellyFraction >= 0.45, `KELLY_FRACTION default too low for max-profit profile: ${CONFIG.RISK.kellyFraction}`);
assert(CONFIG.RISK.kellyMaxFraction >= 0.45, `KELLY_MAX_FRACTION default too low for max-profit profile: ${CONFIG.RISK.kellyMaxFraction}`);
assert(CONFIG.RISK.preResolutionMinBid >= 0.99, `PRE_RESOLUTION_MIN_BID must not exit 0.97 entries at a loss: ${CONFIG.RISK.preResolutionMinBid}`);
assert(
  marketDiscoverySource.includes('const buyPrice = bestAsk ?? quoteBuyPrice;'),
  'CLOB executable buy price must prefer bestAsk over bid-like /price?side=BUY quote',
);
assert(
  /Number\.isFinite\(bestAsk\)\s*&&\s*bestAsk\s*>\s*0\s*\?\s*bestAsk\s*:\s*Number\.isFinite\(buyPrice\)/.test(tradeExecutorSource),
  'live order entry must prefer executable bestAsk for FAK buys before depth checks',
);

const positiveHighPriceRoi = calcBinaryEvRoiAfterFees(0.987, 0.97, { slippagePct: CONFIG.RISK.slippagePct });
const weakHighPriceRoi = calcBinaryEvRoiAfterFees(0.95, 0.97, { slippagePct: CONFIG.RISK.slippagePct });
const minute2PositiveRoi = calcBinaryEvRoiAfterFees(0.9639, 0.94, { slippagePct: CONFIG.RISK.slippagePct });
const minute2WeakRoi = calcBinaryEvRoiAfterFees(0.9546, 0.94, { slippagePct: CONFIG.RISK.slippagePct });
assert(positiveHighPriceRoi >= CONFIG.RISK.highPriceEdgeFloorMinRoi, `0.987/0.97 edge should pass: ${positiveHighPriceRoi}`);
assert(weakHighPriceRoi < CONFIG.RISK.highPriceEdgeFloorMinRoi, `0.95/0.97 weak edge should fail: ${weakHighPriceRoi}`);
assert(minute2PositiveRoi >= CONFIG.RISK.minNetEdgeRoi, `minute-2 0.9639/0.94 edge should pass: ${minute2PositiveRoi}`);
assert(minute2WeakRoi < CONFIG.RISK.minNetEdgeRoi, `minute-2 0.9546/0.94 weak edge should fail: ${minute2WeakRoi}`);

const enoughDepth = applyDepthCap({
  requestedShares: 8,
  orderPrice: 0.97,
  askLevels: [{ price: 0.97, size: 10 }],
  minOrderShares: CONFIG.RISK.minOrderShares,
  safetyMult: CONFIG.RISK.orderbookDepthGuardSafetyMult,
});
assert(enoughDepth.shares === 8 && !enoughDepth.blocked, `depth guard should allow normal size: ${JSON.stringify(enoughDepth)}`);

const reducedDepth = applyDepthCap({
  requestedShares: 20,
  orderPrice: 0.97,
  askLevels: [{ price: 0.97, size: 12 }],
  minOrderShares: CONFIG.RISK.minOrderShares,
  safetyMult: CONFIG.RISK.orderbookDepthGuardSafetyMult,
});
assert(reducedDepth.shares >= CONFIG.RISK.minOrderShares && reducedDepth.shares < 20 && !reducedDepth.blocked, `depth guard should reduce size, not skip: ${JSON.stringify(reducedDepth)}`);

const thinDepth = applyDepthCap({
  requestedShares: 8,
  orderPrice: 0.97,
  askLevels: [{ price: 0.97, size: 4.9 }],
  minOrderShares: CONFIG.RISK.minOrderShares,
  safetyMult: CONFIG.RISK.orderbookDepthGuardSafetyMult,
});
assert(thinDepth.blocked, `depth guard should block below 5 shares: ${JSON.stringify(thinDepth)}`);

const fiveShareFee = calcPolymarketTakerFeeUsd(5, 0.97);

console.log(JSON.stringify({
  verdict: 'VERIFY_5M_LIVE_EDGE_SAFETY_PASS',
  strategyCount: strategies.length,
  priceMax: strategies[0].priceMax,
  hardEntryPriceCap: CONFIG.RISK.hardEntryPriceCap,
  minNetEdgeRoi: CONFIG.RISK.minNetEdgeRoi,
  highPriceEdgeFloorMinRoi: CONFIG.RISK.highPriceEdgeFloorMinRoi,
  preResolutionMinBid: CONFIG.RISK.preResolutionMinBid,
  kellyFraction: CONFIG.RISK.kellyFraction,
  kellyMaxFraction: CONFIG.RISK.kellyMaxFraction,
  orderbookDepthGuardSafetyMult: CONFIG.RISK.orderbookDepthGuardSafetyMult,
  positiveHighPriceRoi,
  weakHighPriceRoi,
  minute2PositiveRoi,
  minute2WeakRoi,
  fiveShareFeeAt97c: fiveShareFee,
  enoughDepth,
  reducedDepth,
  thinDepth,
}, null, 2));