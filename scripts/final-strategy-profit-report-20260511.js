#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const START_BANKROLL = Number(process.env.START_BANKROLL || '12.892746');
const RUNS = Number(process.env.MC_RUNS || '20000');
const FEE_RATE = 0.072;
const SLIPPAGE_PCT = 0.01;
const MIN_ORDER_SHARES = 5;

function readJson(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(__dirname, '..', relativePath), 'utf8'));
}

function mulberry32(seed) {
  let t = seed >>> 0;
  return function rand() {
    t += 0x6D2B79F5;
    let x = t;
    x = Math.imul(x ^ (x >>> 15), x | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

function quantile(sorted, p) {
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(sorted.length * p)))];
}

function usd(value) {
  return Math.round(value * 100) / 100;
}

function calcFeePerShare(price) {
  return FEE_RATE * price * (1 - price);
}

function getStakeFraction(bankroll) {
  if (bankroll < 15) return 0.40;
  if (bankroll < 50) return 0.35;
  if (bankroll < 200) return 0.30;
  return 0.25;
}

function getMpc(bankroll) {
  if (bankroll < 15) return 1;
  if (bankroll < 50) return 2;
  if (bankroll < 200) return 3;
  return 5;
}

function executeTrade({ entryPrice, won, stakeUsd, adverseFillCents = 0 }) {
  const effectiveEntry = Math.min(0.99, entryPrice * (1 + SLIPPAGE_PCT) + adverseFillCents);
  if (effectiveEntry <= 0 || effectiveEntry >= 1) return { blocked: true, pnl: 0, shares: 0, cost: 0 };

  const feePerShare = calcFeePerShare(effectiveEntry);
  const costPerShare = effectiveEntry + feePerShare;
  let shares = Math.floor(stakeUsd / costPerShare);

  if (shares < MIN_ORDER_SHARES) {
    const minCost = MIN_ORDER_SHARES * costPerShare;
    if (stakeUsd >= minCost * 0.8) shares = MIN_ORDER_SHARES;
    else return { blocked: true, pnl: 0, shares: 0, cost: 0 };
  }

  const cost = shares * costPerShare;
  return {
    blocked: false,
    pnl: won ? shares - cost : -cost,
    shares,
    cost,
  };
}

function groupEventsByEpoch(events) {
  const byEpoch = new Map();
  for (const event of events) {
    if (!byEpoch.has(event.epoch)) byEpoch.set(event.epoch, []);
    byEpoch.get(event.epoch).push(event);
  }
  return byEpoch;
}

function shuffleCopy(items, rand) {
  const copy = items.slice();
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

function simulateEpoch3(events, horizonDays, options = {}) {
  const byEpoch = groupEventsByEpoch(events);
  const epochs = [...byEpoch.keys()].sort((a, b) => a - b);
  const rangeDays = Math.max(1, (epochs[epochs.length - 1] - epochs[0]) / 86400);
  const cyclesPerDay = epochs.length / rangeDays;
  const totalCycles = Math.round(cyclesPerDay * horizonDays);
  const results = [];
  const tradeCounts = [];

  for (let run = 0; run < RUNS; run++) {
    const rand = mulberry32((options.seed || 0xA17A) + run * 2654435761);
    let bankroll = START_BANKROLL;
    let trades = 0;

    for (let cycle = 0; cycle < totalCycles; cycle++) {
      if (bankroll < 1.5) break;
      const epoch = epochs[Math.floor(rand() * epochs.length)];
      const eventsThisCycle = shuffleCopy(byEpoch.get(epoch), rand);
      const mpc = options.forceMpc || getMpc(bankroll);
      const toTrade = Math.min(mpc, eventsThisCycle.length);

      for (let i = 0; i < toTrade; i++) {
        if (bankroll < 1.5) break;
        if (options.missedFillPct && rand() < options.missedFillPct) continue;

        const event = eventsThisCycle[i];
        const effectiveEntry = Math.min(0.99, event.price * (1 + SLIPPAGE_PCT) + (options.adverseFillCents || 0));
        const minCost = MIN_ORDER_SHARES * (effectiveEntry + calcFeePerShare(effectiveEntry));
        let stake = Math.min(bankroll * getStakeFraction(bankroll), options.maxStake || 200);
        if (stake < minCost && bankroll >= minCost * 1.05) stake = minCost;
        stake = Math.min(stake, bankroll * 0.85);

        const result = executeTrade({
          entryPrice: event.price,
          won: event.won,
          stakeUsd: stake,
          adverseFillCents: options.adverseFillCents || 0,
        });

        if (result.blocked) continue;
        bankroll = Math.max(0, bankroll + result.pnl);
        trades += 1;
      }
    }

    results.push(bankroll < 1.5 ? 0 : bankroll);
    tradeCounts.push(trades);
  }

  results.sort((a, b) => a - b);
  tradeCounts.sort((a, b) => a - b);
  return {
    median: usd(quantile(results, 0.50)),
    p10: usd(quantile(results, 0.10)),
    p25: usd(quantile(results, 0.25)),
    p75: usd(quantile(results, 0.75)),
    p90: usd(quantile(results, 0.90)),
    bustPct: usd(results.filter((value) => value < 1.5).length / RUNS * 100),
    pGe100: usd(results.filter((value) => value >= 100).length / RUNS * 100),
    pGe500: usd(results.filter((value) => value >= 500).length / RUNS * 100),
    pGe1000: usd(results.filter((value) => value >= 1000).length / RUNS * 100),
    medianTrades: quantile(tradeCounts, 0.50),
    cyclesPerDay: usd(cyclesPerDay),
    totalCycles,
  };
}

function costForFiveShares(price) {
  return MIN_ORDER_SHARES * (price + calcFeePerShare(price));
}

function geometry() {
  const priceLevels = [0.30, 0.35, 0.45, 0.68, 0.75, 0.95, 0.99];
  return priceLevels.map((price) => {
    const minCost = costForFiveShares(price);
    return {
      price,
      minCost: usd(minCost),
      bankrollPct: usd(minCost / START_BANKROLL * 100),
      winPnl: usd(MIN_ORDER_SHARES - minCost),
      lossPnl: usd(-minCost),
    };
  });
}

function summarizeStructural(structural) {
  const selected = structural.selected || [];
  const sim = structural.selectedSimulation || {};
  return {
    source: 'epoch3/reinvestigation_v2/structural_edge_search_20260511T150418Z.json',
    verdict: structural.verdict,
    simulationStartBankroll: sim.startBankroll,
    simulationEndBankroll: sim.endBankroll,
    simulationProfit: sim.profit,
    simulationTrades: sim.trades,
    simulationWins: sim.wins,
    simulationLosses: sim.losses,
    simulationWinRate: sim.winRate,
    maxDrawdown: sim.maxDrawdown,
    dayStats: sim.dayStats,
    topSelectedRules: selected.slice(0, 8).map((rule) => ({
      id: rule.id,
      kind: rule.kind,
      timeframe: rule.timeframe,
      asset: rule.asset,
      minuteMin: rule.minuteMin,
      minuteMax: rule.minuteMax,
      minMoveBps: rule.minMoveBps,
      maxPrice: rule.maxPrice,
      minNaiveEdge: rule.minNaiveEdge,
      all: rule.all,
      holdout: rule.holdout,
      recent: rule.recent,
      score: rule.score,
    })),
  };
}

const portfolioData = readJson('epoch3/reinvestigation_v2/portfolio_events.json');
const structural = readJson('epoch3/reinvestigation_v2/structural_edge_search_20260511T150418Z.json');
const events = portfolioData.events;

const report = {
  generatedAt: new Date().toISOString(),
  startBankroll: START_BANKROLL,
  runs: RUNS,
  fiveShareGeometry: geometry(),
  epoch3PortfolioEvidence: {
    events: events.length,
    uniqueCycles: groupEventsByEpoch(events).size,
    winRate: usd(events.filter((event) => event.won).length / events.length * 100),
    avgEntry: usd(events.reduce((sum, event) => sum + event.price, 0) / events.length),
    horizons: Object.fromEntries([1, 2, 7].map((days) => [String(days), {
      strict: simulateEpoch3(events, days, { seed: 0xE30 + days }),
      adversePlus2c: simulateEpoch3(events, days, { seed: 0xE31 + days, adverseFillCents: 0.02 }),
      oneTradePerCycle: simulateEpoch3(events, days, { seed: 0xE32 + days, forceMpc: 1 }),
      adversePlus2cOneTradePerCycle: simulateEpoch3(events, days, { seed: 0xE33 + days, adverseFillCents: 0.02, forceMpc: 1 }),
      adversePlus2cOneTradePerCycle20PctMissedFills: simulateEpoch3(events, days, { seed: 0xE34 + days, adverseFillCents: 0.02, forceMpc: 1, missedFillPct: 0.20 }),
    }])),
  },
  structuralLagCandidate: summarizeStructural(structural),
  finalRanking: [
    {
      rank: 1,
      strategy: 'Structural CEX-momentum Polymarket-lag set (selected 12-rule artifact)',
      reason: 'Highest simulated upside and best match to the requested moonshot profile, but not live-settlement proven; should be treated as supervised forward-proof, not guaranteed GO.',
    },
    {
      rank: 2,
      strategy: 'Epoch3 V2 portfolio event set with MPC-enforced sizing',
      reason: 'Most reproducible local audit chain; 7d strict/adverse medians can cross $500/$1000 from $12.89, but one-trade adverse/missed-fill stress can fall below target.',
    },
    {
      rank: 3,
      strategy: '5m canary structural set currently deployed/runtime-enabled',
      reason: 'Runtime-compatible after V2 hardening, but local settlement rows and the claimed 23W-1L proof are missing, so it is not promoted above the two evidence-rich artifacts.',
    },
  ],
};

const outPath = path.join(__dirname, '..', 'debug', 'final_strategy_profit_report_20260511.json');
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, JSON.stringify(report, null, 2));

console.log(JSON.stringify({
  generatedAt: report.generatedAt,
  startBankroll: report.startBankroll,
  output: path.relative(path.join(__dirname, '..'), outPath),
  epoch3Summary: report.epoch3PortfolioEvidence,
  structuralLagSummary: {
    verdict: report.structuralLagCandidate.verdict,
    simulationStartBankroll: report.structuralLagCandidate.simulationStartBankroll,
    simulationEndBankroll: report.structuralLagCandidate.simulationEndBankroll,
    simulationProfit: report.structuralLagCandidate.simulationProfit,
    simulationTrades: report.structuralLagCandidate.simulationTrades,
    simulationWinRate: report.structuralLagCandidate.simulationWinRate,
    topRules: report.structuralLagCandidate.topSelectedRules.slice(0, 3),
  },
  finalRanking: report.finalRanking,
}, null, 2));