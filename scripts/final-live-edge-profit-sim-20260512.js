#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const CONFIG = require('../lib/config');
const { calcPolymarketTakerFeeUsd } = require('../lib/polymarket-fees');

const ROOT = path.resolve(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'debug', 'opus_rereview_20260512');
const OUT_PATH = path.join(OUT_DIR, 'final_live_edge_profit_sim_20260512.json');
const START_BANKROLL = Number(process.env.START_BANKROLL || '12.892746');
const RUNS = Number(process.env.MONTE_CARLO_RUNS || '5000');
const MIN_SHARES = Number(CONFIG.RISK.minOrderShares || 5);
const ENTRY_PRICE = Number(process.env.SIM_ENTRY_PRICE || '0.97');
const P_WIN = Number(process.env.SIM_P_WIN || '0.9869158878504672');
const FILL_PROB = Number(process.env.SIM_FILL_PROB || '0.72');
const TRIGGER_RATE_PER_HOUR = Number(process.env.SIM_TRIGGER_RATE_PER_HOUR || '12.738095238095237');
const RECON_CAP_TRADES_PER_HOUR = Number(process.env.SIM_RECON_CAP_TRADES_PER_HOUR || '6');
const PROFIT_EXIT_RECON_CAP_TRADES_PER_HOUR = Number(process.env.SIM_PROFIT_EXIT_RECON_CAP_TRADES_PER_HOUR || '8');
const DEPTH_CAP_SHARES = Number(process.env.SIM_DEPTH_CAP_SHARES || '40');
const DEPTH_SAFETY_MULT = Number(CONFIG.RISK.orderbookDepthGuardSafetyMult || 1.05);
const SEED = Number(process.env.SIM_SEED || '20260512');

function mulberry32(seed) {
  let t = seed >>> 0;
  return function rand() {
    t += 0x6D2B79F5;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

function percentile(values, q) {
  const sorted = values.slice().sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(q * sorted.length)))];
}

function calcRoiPerDollar(pWin, price) {
  const feeFrac = calcPolymarketTakerFeeUsd(1 / price, price) / 1;
  return pWin / price - 1 - feeFrac;
}

function chooseStake(bankroll, kellyFraction, stakeFractionCap = kellyFraction) {
  const b = (1 / ENTRY_PRICE) - 1;
  const fullKelly = Math.max(0, (b * P_WIN - (1 - P_WIN)) / b);
  const rawStake = bankroll * Math.min(fullKelly * kellyFraction, kellyFraction, stakeFractionCap);
  const minStake = MIN_SHARES * ENTRY_PRICE;
  const maxDepthShares = Math.floor(DEPTH_CAP_SHARES / DEPTH_SAFETY_MULT);
  const maxDepthStake = maxDepthShares * ENTRY_PRICE;
  const stake = Math.min(Math.max(rawStake, minStake), bankroll, maxDepthStake);
  const shares = Math.floor(stake / ENTRY_PRICE + 1e-9);
  if (shares < MIN_SHARES) return { stake: 0, shares: 0, blocked: true };
  const adjustedStake = shares * ENTRY_PRICE;
  const fee = calcPolymarketTakerFeeUsd(shares, ENTRY_PRICE);
  if (adjustedStake + fee > bankroll + 1e-9) return { stake: 0, shares: 0, blocked: true };
  return { stake: adjustedStake, shares, blocked: false, fee };
}

function simulate({ label, hours, kellyFraction, stakeFractionCap, haircut = 1, reconCapTradesPerHour = RECON_CAP_TRADES_PER_HOUR }) {
  const rand = mulberry32(
    SEED + Math.floor(hours * 1000) + Math.floor(kellyFraction * 10000) + Math.floor(haircut * 100) + Math.floor(reconCapTradesPerHour * 10),
  );
  const end = [];
  const trades = [];
  const busts = [];
  const effectiveTradesPerHour = Math.min(TRIGGER_RATE_PER_HOUR * FILL_PROB * haircut, reconCapTradesPerHour);
  const attempts = Math.max(0, Math.floor(hours * effectiveTradesPerHour));
  for (let run = 0; run < RUNS; run += 1) {
    let bankroll = START_BANKROLL;
    let tradeCount = 0;
    for (let i = 0; i < attempts; i += 1) {
      const order = chooseStake(bankroll, kellyFraction, stakeFractionCap);
      if (order.blocked) break;
      bankroll -= order.stake + order.fee;
      if (rand() < P_WIN) {
        bankroll += order.shares;
      }
      tradeCount += 1;
      if (bankroll < MIN_SHARES * ENTRY_PRICE) break;
    }
    end.push(bankroll);
    trades.push(tradeCount);
    busts.push(bankroll < MIN_SHARES * ENTRY_PRICE ? 1 : 0);
  }
  return {
    hours,
    label,
    kellyFraction,
    stakeFractionCap,
    haircut,
    reconCapTradesPerHour,
    effectiveTradesPerHour,
    attempts,
    p10: percentile(end, 0.10),
    p25: percentile(end, 0.25),
    median: percentile(end, 0.50),
    p75: percentile(end, 0.75),
    p90: percentile(end, 0.90),
    p99: percentile(end, 0.99),
    max: Math.max(...end),
    medianTrades: percentile(trades, 0.50),
    bustRate: busts.reduce((a, b) => a + b, 0) / busts.length,
  };
}

const profiles = [
  {
    label: 'conservative_previous',
    kellyFraction: 0.30,
    stakeFractionCap: 0.35,
    reconCapTradesPerHour: RECON_CAP_TRADES_PER_HOUR,
    note: 'Previous post-fix profile; kept for direct comparison.',
  },
  {
    label: 'bounded_max_profit_45_alt',
    kellyFraction: 0.45,
    stakeFractionCap: 0.45,
    reconCapTradesPerHour: PROFIT_EXIT_RECON_CAP_TRADES_PER_HOUR,
    note: 'Lower-variance alternative kept for comparison; 45% fractional Kelly with profit-only 0.99 pre-resolution exits.',
  },
  {
    label: 'max_profit_selected',
    kellyFraction: 0.60,
    stakeFractionCap: 0.60,
    reconCapTradesPerHour: PROFIT_EXIT_RECON_CAP_TRADES_PER_HOUR,
    note: 'OPERATOR-SELECTED max-profit profile (Opus v3): 60% fractional Kelly, 60% stake cap. Higher 7d/48h medians, bust ~8-9% in worst stress, still inside the operator-accepted band.',
  },
  {
    label: 'ultra_aggressive_rejected',
    kellyFraction: 0.75,
    stakeFractionCap: 0.75,
    reconCapTradesPerHour: PROFIT_EXIT_RECON_CAP_TRADES_PER_HOUR,
    note: 'Rejected: 75% Kelly only adds ~7% to 7d median while p10 collapses toward zero and bust > 12% under haircut stress.',
  },
];

const scenarios = [];
for (const hours of [24, 48, 168]) {
  for (const profile of profiles) {
    scenarios.push(simulate({ ...profile, hours, haircut: 1 }));
    scenarios.push(simulate({ ...profile, hours, haircut: 0.45 }));
  }
}

const report = {
  generatedAt: new Date().toISOString(),
  inputs: {
    START_BANKROLL,
    RUNS,
    MIN_SHARES,
    ENTRY_PRICE,
    P_WIN,
    FILL_PROB,
    TRIGGER_RATE_PER_HOUR,
    RECON_CAP_TRADES_PER_HOUR,
    PROFIT_EXIT_RECON_CAP_TRADES_PER_HOUR,
    DEPTH_CAP_SHARES,
    DEPTH_SAFETY_MULT,
    SEED,
    configuredKellyFraction: CONFIG.RISK.kellyFraction,
    configuredKellyMaxFraction: CONFIG.RISK.kellyMaxFraction,
    configuredStakeFraction: CONFIG.RISK.stakeFraction,
    configuredPreResolutionMinBid: CONFIG.RISK.preResolutionMinBid,
    minNetEdgeRoi: CONFIG.RISK.minNetEdgeRoi,
    highPriceEdgeFloorMinRoi: CONFIG.RISK.highPriceEdgeFloorMinRoi,
  },
  perDollarRoiAt97c: calcRoiPerDollar(P_WIN, ENTRY_PRICE),
  fiveShareGeometry: {
    minStake: MIN_SHARES * ENTRY_PRICE,
    fiveShareFee: calcPolymarketTakerFeeUsd(MIN_SHARES, ENTRY_PRICE),
    totalCashNeeded: MIN_SHARES * ENTRY_PRICE + calcPolymarketTakerFeeUsd(MIN_SHARES, ENTRY_PRICE),
    startingMinOrderSlots: Math.floor(START_BANKROLL / (MIN_SHARES * ENTRY_PRICE + calcPolymarketTakerFeeUsd(MIN_SHARES, ENTRY_PRICE))),
  },
  profiles,
  scenarios,
  selectedKelly: {
    fraction: 0.60,
    stakeFractionCap: 0.60,
    reason: 'Operator-accepted max-profit profile (Opus v3): 60% fractional Kelly + 60% stake cap. The 5,000-run sweep showed median 7d $577 vs $508 at 0.45 (+14%), 48h $63 vs $50 (+26%), 24h $33 vs $30 (+10%). Bust climbs only modestly from 7.5%->8.8%. Going to 0.75+ collapses p10 toward $0 and pushes bust >11-13% with minimal median gain — depth cap binds the upside.',
  },
  caveats: [
    'Binance spot is a proxy; Polymarket 5m markets are reported to settle with Chainlink Data Streams, so oracle-basis drift remains a live risk.',
    'Depth cap is modeled as 40 visible shares at or below the limit; live code now reduces size to visible depth and skips below 5 shares.',
    'Haircut scenarios reduce effective fills/trade frequency by 55% to approximate adverse selection, missed windows, and reconciliation drag.',
    'The selected profile assumes pre-resolution exits only when bid >= 0.99; if live books do not offer that exit, throughput regresses toward the conservative recon cap.',
  ],
};

fs.mkdirSync(OUT_DIR, { recursive: true });
fs.writeFileSync(OUT_PATH, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({
  verdict: 'FINAL_LIVE_EDGE_PROFIT_SIM_WRITTEN',
  outPath: path.relative(ROOT, OUT_PATH),
  perDollarRoiAt97c: report.perDollarRoiAt97c,
  fiveShareGeometry: report.fiveShareGeometry,
  selectedKelly: report.selectedKelly,
  headline: report.scenarios.filter(s => s.label === 'max_profit_selected' && [24, 48, 168].includes(s.hours)),
}, null, 2));