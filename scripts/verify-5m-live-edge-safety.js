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
  assert(Number(strategy.priceMax) >= 0.97, `${strategy.id} priceMax must admit calibrated 0.97 asks`);
  assert(Number(strategy.priceMax) <= CONFIG.RISK.hardEntryPriceCap + 1e-9, `${strategy.id} priceMax exceeds hard entry cap`);
  assert(Number(strategy.evWinEstimate || strategy.pWinEstimate) >= 0.985, `${strategy.id} EV win estimate too low for high-price gate`);
}

assert(CONFIG.RISK.enforceNetEdgeGate === true, 'ENFORCE_NET_EDGE_GATE must default true');
assert(CONFIG.RISK.enforceHighPriceEdgeFloor === true, 'high-price edge floor must default true');
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
assert(positiveHighPriceRoi >= CONFIG.RISK.highPriceEdgeFloorMinRoi, `0.987/0.97 edge should pass: ${positiveHighPriceRoi}`);
assert(weakHighPriceRoi < CONFIG.RISK.highPriceEdgeFloorMinRoi, `0.95/0.97 weak edge should fail: ${weakHighPriceRoi}`);

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
  fiveShareFeeAt97c: fiveShareFee,
  enoughDepth,
  reducedDepth,
  thinDepth,
}, null, 2));