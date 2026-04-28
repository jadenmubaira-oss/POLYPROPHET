#!/usr/bin/env node
'use strict';
/**
 * EPOCH 3 — ADAPTIVE STAKING SIMULATION
 *
 * Tests advanced staking approaches on the best validated signal sets:
 * 1. Anti-martingale: increase stake after wins, decrease after losses
 * 2. Target-based: go aggressive until reaching target, then conserve
 * 3. All-in ladder: go all-in for first N trades to maximize early compound
 * 4. Geometric ratchet: increase stake as bankroll grows
 * 5. Convex low-entry targeting: filter for entries <0.35 for 3x+ payoff
 *
 * Uses the same validated signals from epoch3_comprehensive_alpha.js
 */

const fs = require('fs');
const path = require('path');

const OUT_DIR = path.join(__dirname, '..', 'epoch3', 'unrestricted');

// Load the comprehensive results
const comprehensive = JSON.parse(
  fs.readFileSync(path.join(OUT_DIR, 'epoch3_comprehensive_results.json'), 'utf8')
);

// Load raw data for signal regeneration
function loadData() {
  const raw15 = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data/intracycle-price-data.json'), 'utf8'));
  return raw15.cycles || [];
}

// Regenerate momentum signals (copy key functions from comprehensive)
function extractMomentumEvents(cycles, momThresh, entryMin, bandLo, bandHi, direction) {
  const events = [];
  for (const c of cycles) {
    if (!c.resolution) continue;
    const yPrices = c.minutePricesYes || {};
    const nPrices = c.minutePricesNo || {};
    const p0 = yPrices[0]?.last;
    const p3 = yPrices[3]?.last;
    if (!p0 || !p3 || p0 <= 0) continue;
    const mom = (p3 - p0) / p0;
    if (direction === 'UP' && mom > momThresh) {
      const entryObj = yPrices[entryMin];
      if (!entryObj || entryObj.last <= 0 || entryObj.last >= 1) continue;
      const entry = entryObj.last;
      if (entry < bandLo || entry > bandHi) continue;
      events.push({ epoch: c.epoch, asset: c.asset, entry, direction: 'UP', won: c.resolution === 'UP', timestamp: c.epoch });
    }
    if (direction === 'DOWN' && mom < -momThresh) {
      const entryObj = nPrices[entryMin];
      if (!entryObj || entryObj.last <= 0 || entryObj.last >= 1) continue;
      const entry = entryObj.last;
      if (entry < bandLo || entry > bandHi) continue;
      events.push({ epoch: c.epoch, asset: c.asset, entry, direction: 'DOWN', won: c.resolution === 'DOWN', timestamp: c.epoch });
    }
  }
  return events;
}

function generateTopMomentumSignals(cycles, topN) {
  cycles.sort((a, b) => a.epoch - b.epoch);
  const split = Math.floor(cycles.length * 0.65);
  const train = cycles.slice(0, split);
  const holdout = cycles.slice(split);

  const configs = [];
  for (const momThresh of [0.05, 0.10, 0.15, 0.20, 0.25]) {
    for (const entryMin of [5, 7, 10]) {
      for (const [bandLo, bandHi] of [[0.10, 0.25], [0.15, 0.30], [0.20, 0.40], [0.25, 0.50], [0.30, 0.55], [0.40, 0.65], [0.50, 0.70], [0.60, 0.80], [0.70, 0.90]]) {
        for (const dir of ['UP', 'DOWN']) {
          const trainEvents = extractMomentumEvents(train, momThresh, entryMin, bandLo, bandHi, dir);
          if (trainEvents.length < 10) continue;
          const wr = trainEvents.filter(e => e.won).length / trainEvents.length;
          const avgP = trainEvents.reduce((s, e) => s + e.entry, 0) / trainEvents.length;
          const ev = wr * (1 - avgP) - (1 - wr) * avgP;
          if (ev <= 0) continue;

          const holdoutEvents = extractMomentumEvents(holdout, momThresh, entryMin, bandLo, bandHi, dir);
          if (holdoutEvents.length < 5) continue;
          const hwr = holdoutEvents.filter(e => e.won).length / holdoutEvents.length;
          const havgP = holdoutEvents.reduce((s, e) => s + e.entry, 0) / holdoutEvents.length;
          const hev = hwr * (1 - havgP) - (1 - hwr) * havgP;
          if (hev <= 0) continue;

          configs.push({
            type: 'momentum_follow', direction: dir,
            momThresh, entryMin, bandLo, bandHi,
            holdoutN: holdoutEvents.length, holdoutWR: hwr, holdoutEV: hev, holdoutAvgP: havgP,
            holdoutEvents,
          });
        }
      }
    }
  }

  configs.sort((a, b) => b.holdoutEV - a.holdoutEV);
  return configs.slice(0, topN);
}

// Also add structural signals
function generateTopStructuralSignals(cycles, topN) {
  cycles.sort((a, b) => a.epoch - b.epoch);
  const split = Math.floor(cycles.length * 0.65);
  const train = cycles.slice(0, split);
  const holdout = cycles.slice(split);

  const trainStats = {};
  for (const c of train) {
    if (!c.resolution) continue;
    const yP = c.minutePricesYes || {};
    const nP = c.minutePricesNo || {};
    for (let m = 0; m <= 14; m++) {
      for (const dir of ['UP', 'DOWN']) {
        const obj = dir === 'UP' ? yP[m] : nP[m];
        if (!obj || obj.last <= 0 || obj.last >= 1) continue;
        const p = obj.last;
        const band = (Math.floor(p * 10) / 10).toFixed(1);
        const key = dir + '|m' + m + '|' + band;
        if (!trainStats[key]) trainStats[key] = { w: 0, n: 0, sumP: 0 };
        trainStats[key].n++;
        trainStats[key].sumP += p;
        if (c.resolution === dir) trainStats[key].w++;
      }
    }
  }

  const validated = [];
  for (const [key, ts] of Object.entries(trainStats)) {
    if (ts.n < 20) continue;
    const twr = ts.w / ts.n;
    const tavgP = ts.sumP / ts.n;
    const tev = twr * (1 - tavgP) - (1 - twr) * tavgP;
    if (tev <= 0.02) continue;

    const [dir, min, band] = key.split('|');
    const m = parseInt(min.slice(1));
    const bandLo = parseFloat(band);
    const bandHi = bandLo + 0.1;

    const holdoutEvents = [];
    for (const c of holdout) {
      if (!c.resolution) continue;
      const prices = dir === 'UP' ? c.minutePricesYes : c.minutePricesNo;
      const obj = prices?.[m];
      if (!obj || obj.last <= 0 || obj.last >= 1) continue;
      if (obj.last < bandLo || obj.last >= bandHi) continue;
      holdoutEvents.push({ epoch: c.epoch, asset: c.asset, entry: obj.last, direction: dir, won: c.resolution === dir, timestamp: c.epoch });
    }

    if (holdoutEvents.length < 10) continue;
    const hwr = holdoutEvents.filter(e => e.won).length / holdoutEvents.length;
    const havgP = holdoutEvents.reduce((s, e) => s + e.entry, 0) / holdoutEvents.length;
    const hev = hwr * (1 - havgP) - (1 - hwr) * havgP;
    if (hev <= 0) continue;

    validated.push({
      type: 'structural', direction: dir, minute: m, bandLo, bandHi,
      holdoutN: holdoutEvents.length, holdoutWR: hwr, holdoutEV: hev, holdoutAvgP: havgP,
      holdoutEvents,
    });
  }

  validated.sort((a, b) => b.holdoutEV - a.holdoutEV);
  return validated.slice(0, topN);
}

// ==================== ADAPTIVE STAKING STRATEGIES ====================

function runAdaptiveMC(events, config) {
  const { runs, startBalance, strategy, days, tradesPerDay } = config;
  const maxTrades = Math.ceil(tradesPerDay * days);

  const results = [];
  for (let r = 0; r < runs; r++) {
    let cash = startBalance;
    let peak = startBalance;
    let trades = 0, wins = 0, consecutiveWins = 0, consecutiveLosses = 0;

    for (let t = 0; t < maxTrades; t++) {
      if (cash < 1.75) break;

      const ev = events[Math.floor(Math.random() * events.length)];
      if (Math.random() < 0.107) continue; // no-fill

      const entry = Math.min(0.99, ev.entry + 0.01);

      // Compute stake fraction based on strategy
      let stakeFrac;
      switch (strategy.type) {
        case 'anti_martingale':
          // Start at base, increase after each consecutive win, reset after loss
          stakeFrac = Math.min(0.95, strategy.base + consecutiveWins * strategy.increment);
          break;

        case 'target_ladder':
          // Aggressive until target, then conservative
          if (cash < strategy.target1) stakeFrac = strategy.aggressive;
          else if (cash < strategy.target2) stakeFrac = strategy.moderate;
          else stakeFrac = strategy.conservative;
          break;

        case 'all_in_first_n':
          // Go all-in for first N trades, then switch to base
          stakeFrac = trades < strategy.n ? 0.95 : strategy.base;
          break;

        case 'geometric_ratchet':
          // Increase stake proportionally to bankroll growth
          const growth = cash / startBalance;
          stakeFrac = Math.min(0.95, strategy.base * Math.pow(growth, strategy.exponent));
          break;

        case 'kelly_dynamic':
          // Approximate Kelly based on entry price and estimated WR
          const estimatedWR = ev.won ? 0.65 : 0.55; // crude: slightly higher after win
          const b = (1 / entry) - 1;
          const kellyF = (estimatedWR * b - (1 - estimatedWR)) / b;
          stakeFrac = Math.max(0.05, Math.min(0.95, kellyF * strategy.multiplier));
          break;

        case 'fixed':
        default:
          stakeFrac = strategy.fraction;
          break;
      }

      const stake = cash * stakeFrac;
      if (stake < 1.75) break;

      const shares = Math.floor(stake / entry);
      if (shares < 5) break;
      const actualCost = shares * entry;

      trades++;
      const won = ev.won;

      if (won) {
        cash = cash - actualCost + shares * 1.0;
        wins++;
        consecutiveWins++;
        consecutiveLosses = 0;
      } else {
        cash -= actualCost;
        consecutiveLosses++;
        consecutiveWins = 0;
      }

      peak = Math.max(peak, cash);
    }

    results.push({ final: cash, peak, trades, wins, wr: trades > 0 ? wins / trades : 0 });
  }

  results.sort((a, b) => a.final - b.final);
  const n = results.length;

  return {
    median: results[Math.floor(n * 0.5)].final,
    p10: results[Math.floor(n * 0.1)].final,
    p25: results[Math.floor(n * 0.25)].final,
    p75: results[Math.floor(n * 0.75)].final,
    p90: results[Math.floor(n * 0.9)].final,
    p95: results[Math.floor(n * 0.95)].final,
    p99: results[Math.floor(n * 0.99)].final,
    max: results[n - 1].final,
    bust: results.filter(r => r.final < 1.75).length / n,
    pGte50: results.filter(r => r.final >= 50).length / n,
    pGte100: results.filter(r => r.final >= 100).length / n,
    pGte200: results.filter(r => r.final >= 200).length / n,
    pGte500: results.filter(r => r.final >= 500).length / n,
    pGte1000: results.filter(r => r.final >= 1000).length / n,
    medianTrades: results.sort((a, b) => a.trades - b.trades)[Math.floor(n * 0.5)].trades,
    medianWR: results.sort((a, b) => a.wr - b.wr)[Math.floor(n * 0.5)].wr,
    runs: n,
  };
}

// ==================== MAIN ====================
function main() {
  const cycles = loadData();
  console.log('=== EPOCH 3 ADAPTIVE STAKING SIMULATION ===');
  console.log(`Data: ${cycles.length} cycles (15m)`);
  console.log('');

  // Generate signal sets
  const momTop5 = generateTopMomentumSignals(cycles, 5);
  const momTop10 = generateTopMomentumSignals(cycles, 10);
  const momTop20 = generateTopMomentumSignals(cycles, 20);
  const structTop10 = generateTopStructuralSignals(cycles, 10);

  // Collect events from each set
  function collectEvents(sigs) {
    const events = [];
    for (const sig of sigs) {
      if (sig.holdoutEvents) events.push(...sig.holdoutEvents);
    }
    return events;
  }

  const signalSets = {
    'mom5': { events: collectEvents(momTop5), sigs: momTop5 },
    'mom10': { events: collectEvents(momTop10), sigs: momTop10 },
    'mom20': { events: collectEvents(momTop20), sigs: momTop20 },
    'struct10': { events: collectEvents(structTop10), sigs: structTop10 },
    'combined': { events: [...collectEvents(momTop10), ...collectEvents(structTop10)], sigs: [...momTop10, ...structTop10] },
  };

  // Adaptive strategies to test
  const strategies = [
    { name: 'fixed_30', type: 'fixed', fraction: 0.30 },
    { name: 'fixed_50', type: 'fixed', fraction: 0.50 },
    { name: 'fixed_70', type: 'fixed', fraction: 0.70 },
    { name: 'anti_mart_20_10', type: 'anti_martingale', base: 0.20, increment: 0.10 },
    { name: 'anti_mart_30_15', type: 'anti_martingale', base: 0.30, increment: 0.15 },
    { name: 'anti_mart_20_20', type: 'anti_martingale', base: 0.20, increment: 0.20 },
    { name: 'anti_mart_40_20', type: 'anti_martingale', base: 0.40, increment: 0.20 },
    { name: 'target_50_250', type: 'target_ladder', target1: 50, target2: 250, aggressive: 0.70, moderate: 0.40, conservative: 0.20 },
    { name: 'target_100_500', type: 'target_ladder', target1: 100, target2: 500, aggressive: 0.80, moderate: 0.40, conservative: 0.15 },
    { name: 'target_50_500', type: 'target_ladder', target1: 50, target2: 500, aggressive: 0.60, moderate: 0.30, conservative: 0.10 },
    { name: 'allin_first_3', type: 'all_in_first_n', n: 3, base: 0.30 },
    { name: 'allin_first_5', type: 'all_in_first_n', n: 5, base: 0.30 },
    { name: 'allin_first_8', type: 'all_in_first_n', n: 8, base: 0.25 },
    { name: 'ratchet_20_0.5', type: 'geometric_ratchet', base: 0.20, exponent: 0.5 },
    { name: 'ratchet_30_0.3', type: 'geometric_ratchet', base: 0.30, exponent: 0.3 },
    { name: 'ratchet_25_0.7', type: 'geometric_ratchet', base: 0.25, exponent: 0.7 },
    { name: 'kelly_1.5x', type: 'kelly_dynamic', multiplier: 1.5 },
    { name: 'kelly_2x', type: 'kelly_dynamic', multiplier: 2.0 },
    { name: 'kelly_3x', type: 'kelly_dynamic', multiplier: 3.0 },
  ];

  const MC_RUNS = 10000;
  const allResults = [];

  // Compute holdout duration
  const sorted = cycles.filter(c => c.resolution).sort((a, b) => a.epoch - b.epoch);
  const holdoutStart = sorted[Math.floor(sorted.length * 0.65)].epoch;
  const holdoutEnd = sorted[sorted.length - 1].epoch;
  const holdoutDays = Math.max(1, (holdoutEnd - holdoutStart) / 86400);

  for (const [setName, { events, sigs }] of Object.entries(signalSets)) {
    if (events.length < 5) continue;

    // Compute realistic trades per day
    const epochSet = new Set();
    for (const ev of events) epochSet.add(ev.epoch + '|' + ev.asset);
    const uniqueTPD = Math.max(2, Math.round(epochSet.size / holdoutDays));

    console.log(`\n=== ${setName} (${events.length} events, ${uniqueTPD} tpd) ===`);

    for (const strat of strategies) {
      for (const start of [5, 10]) {
        const mc = runAdaptiveMC(events, {
          runs: MC_RUNS,
          startBalance: start,
          strategy: strat,
          days: 7,
          tradesPerDay: uniqueTPD,
        });

        allResults.push({ set: setName, strategy: strat.name, startBalance: start, tpd: uniqueTPD, ...mc });

        if (mc.pGte500 >= 0.001 || mc.pGte100 >= 0.01) {
          console.log(`  ${strat.name} $${start}: median=$${mc.median.toFixed(2)} bust=${(mc.bust * 100).toFixed(1)}% P≥$100=${(mc.pGte100 * 100).toFixed(1)}% P≥$500=${(mc.pGte500 * 100).toFixed(2)}% P≥$1000=${(mc.pGte1000 * 100).toFixed(2)}% max=$${mc.max.toFixed(2)} trades=${mc.medianTrades}`);
        }
      }
    }
  }

  // Rankings
  console.log('\n\n====== TOP 30 BY P(≥$500) ======\n');
  allResults.sort((a, b) => b.pGte500 - a.pGte500);
  allResults.slice(0, 30).forEach((r, i) => {
    console.log(`${String(i + 1).padStart(2)}. [${r.set}] ${r.strategy} $${r.startBalance}`);
    console.log(`    median=$${r.median.toFixed(2)} bust=${(r.bust * 100).toFixed(1)}% P≥$100=${(r.pGte100 * 100).toFixed(1)}% P≥$500=${(r.pGte500 * 100).toFixed(2)}% P≥$1000=${(r.pGte1000 * 100).toFixed(2)}%`);
    console.log(`    p90=$${r.p90.toFixed(2)} p95=$${r.p95.toFixed(2)} p99=$${r.p99.toFixed(2)} max=$${r.max.toFixed(2)} trades=${r.medianTrades}`);
  });

  // Also show realistic best: lowest bust + highest P(≥$500)
  console.log('\n====== BEST RISK-ADJUSTED (P≥$500 × (1-bust)) ======\n');
  const riskAdj = allResults.map(r => ({
    ...r,
    score: r.pGte500 * (1 - r.bust),
  }));
  riskAdj.sort((a, b) => b.score - a.score);
  riskAdj.slice(0, 15).forEach((r, i) => {
    console.log(`${String(i + 1).padStart(2)}. [${r.set}] ${r.strategy} $${r.startBalance} score=${(r.score * 100).toFixed(2)}%`);
    console.log(`    median=$${r.median.toFixed(2)} bust=${(r.bust * 100).toFixed(1)}% P≥$500=${(r.pGte500 * 100).toFixed(2)}% P≥$1000=${(r.pGte1000 * 100).toFixed(2)}%`);
  });

  // Save
  const output = {
    generatedAt: new Date().toISOString(),
    mcRuns: MC_RUNS,
    rankings: allResults.slice(0, 30),
    riskAdjusted: riskAdj.slice(0, 15),
  };
  fs.writeFileSync(path.join(OUT_DIR, 'epoch3_adaptive_results.json'), JSON.stringify(output, null, 2));
  console.log('\nSaved to epoch3/unrestricted/epoch3_adaptive_results.json');
}

main();
