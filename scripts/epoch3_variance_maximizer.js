#!/usr/bin/env node
'use strict';
/**
 * EPOCH 3 — VARIANCE-MAXIMIZING ALPHA HARNESS
 * 
 * Instead of optimizing for median, this harness optimizes for P(≥$500).
 * Uses aggressive overbetting (50-95% stake) to maximize right-tail variance.
 * Runs 10,000+ MC paths per configuration to capture tail events.
 * 
 * The mathematical insight: with 69% WR at 0.64 entry and 90% stake,
 * 15 consecutive wins yields $10 * 1.504^15 = $2,200. P(15 wins) = 0.34%.
 * With enough paths and the right stake fraction, P(≥$500) can be meaningful.
 */

const fs = require('fs');
const path = require('path');

const OUT_DIR = path.join(__dirname, '..', 'epoch3', 'unrestricted');
function ensureDir(d) { fs.mkdirSync(d, { recursive: true }); }

// ==================== DATA LOADING ====================
function loadData(filePath) {
  const raw = JSON.parse(fs.readFileSync(path.join(__dirname, '..', filePath), 'utf8'));
  return raw.cycles || [];
}

// ==================== EDGE ANALYSIS ====================
function analyzeEdges(cycles, trainFraction = 0.65) {
  // Split chronologically
  cycles.sort((a, b) => a.epoch - b.epoch);
  const splitIdx = Math.floor(cycles.length * trainFraction);
  const train = cycles.slice(0, splitIdx);
  const holdout = cycles.slice(splitIdx);
  
  console.log(`  Train: ${train.length} cycles, Holdout: ${holdout.length} cycles`);
  
  // Mine edges at multiple granularity levels
  const edges = [];
  
  // Level 1: direction × minute × 0.10-band (broadest, most samples)
  const l1Stats = mineLevel(train, ['dir', 'min', 'band10']);
  const l1Holdout = mineLevel(holdout, ['dir', 'min', 'band10']);
  
  // Level 2: direction × minute × 0.05-band
  const l2Stats = mineLevel(train, ['dir', 'min', 'band05']);
  const l2Holdout = mineLevel(holdout, ['dir', 'min', 'band05']);
  
  // Level 3: asset × direction × minute × 0.10-band
  const l3Stats = mineLevel(train, ['asset', 'dir', 'min', 'band10']);
  const l3Holdout = mineLevel(holdout, ['asset', 'dir', 'min', 'band10']);
  
  // Level 4: direction × hour_bucket × minute × 0.10-band
  const l4Stats = mineLevel(train, ['dir', 'hbucket', 'min', 'band10']);
  const l4Holdout = mineLevel(holdout, ['dir', 'hbucket', 'min', 'band10']);
  
  // Collect all edges with holdout validation
  collectEdges(edges, l1Stats, l1Holdout, 'L1', 30, 15);
  collectEdges(edges, l2Stats, l2Holdout, 'L2', 20, 10);
  collectEdges(edges, l3Stats, l3Holdout, 'L3', 12, 5);
  collectEdges(edges, l4Stats, l4Holdout, 'L4', 15, 5);
  
  return { edges, train, holdout };
}

function mineLevel(cycles, keyParts) {
  const stats = {};
  for (const c of cycles) {
    const asset = c.asset;
    const res = c.resolution;
    if (!res) continue;
    const h = new Date(c.epoch * 1000).getUTCHours();
    const hbucket = h < 6 ? 'H00_05' : h < 12 ? 'H06_11' : h < 18 ? 'H12_17' : 'H18_23';
    
    const yPrices = c.minutePricesYes || {};
    const nPrices = c.minutePricesNo || {};
    
    for (let min = 0; min <= 14; min++) {
      for (const dir of ['UP', 'DOWN']) {
        const priceObj = dir === 'UP' ? yPrices[min] : nPrices[min];
        if (!priceObj || !(priceObj.last > 0) || priceObj.last >= 1) continue;
        const p = priceObj.last;
        const band10 = (Math.floor(p * 10) / 10).toFixed(1);
        const band05 = (Math.floor(p * 20) / 20).toFixed(2);
        
        const parts = { asset, dir, min: 'm' + min, band10, band05, hbucket };
        const key = keyParts.map(k => parts[k]).join('|');
        
        if (!stats[key]) stats[key] = { wins: 0, total: 0, sumPrice: 0, prices: [], keyParts: {} };
        stats[key].total++;
        stats[key].sumPrice += p;
        stats[key].prices.push(p);
        if (res === dir) stats[key].wins++;
        stats[key].keyParts = Object.fromEntries(keyParts.map(k => [k, parts[k]]));
      }
    }
  }
  return stats;
}

function wilsonLcb(w, n, z = 1.645) {
  if (n === 0) return 0;
  const p = w / n;
  const d = 1 + z * z / n;
  const c = p + z * z / (2 * n);
  const iv = z * Math.sqrt((p * (1 - p) + z * z / (4 * n)) / n);
  return Math.max(0, (c - iv) / d);
}

function collectEdges(edges, trainStats, holdoutStats, level, minTrainN, minHoldoutN) {
  for (const [key, ts] of Object.entries(trainStats)) {
    if (ts.total < minTrainN) continue;
    const trainWR = ts.wins / ts.total;
    const trainAvgP = ts.sumPrice / ts.total;
    const trainEV = trainWR * (1 - trainAvgP) - (1 - trainWR) * trainAvgP;
    if (trainEV <= 0) continue; // Must have positive training EV
    
    const hs = holdoutStats[key];
    if (!hs || hs.total < minHoldoutN) continue;
    const holdoutWR = hs.wins / hs.total;
    const holdoutAvgP = hs.sumPrice / hs.total;
    const holdoutEV = holdoutWR * (1 - holdoutAvgP) - (1 - holdoutWR) * holdoutAvgP;
    
    const holdoutLCB = wilsonLcb(hs.wins, hs.total);
    
    edges.push({
      key, level,
      trainN: ts.total, trainWR, trainAvgP, trainEV,
      holdoutN: hs.total, holdoutWR, holdoutAvgP, holdoutEV, holdoutLCB,
      holdoutPrices: hs.prices,
      keyParts: ts.keyParts,
    });
  }
}

// ==================== SIMULATION ====================
function simulatePath(events, startBalance, stakeFraction, maxTrades = Infinity) {
  let cash = startBalance;
  let peak = startBalance;
  let trades = 0, wins = 0;
  
  for (const ev of events) {
    if (trades >= maxTrades) break;
    if (cash < 0.50) break; // busted
    
    const stake = cash * stakeFraction;
    if (stake < 0.01) break;
    
    const shares = stake / ev.entry;
    trades++;
    
    if (ev.won) {
      const payout = shares * 1.0; // $1 per share on win
      const profit = payout - stake;
      cash += profit;
      wins++;
    } else {
      cash -= stake;
    }
    
    peak = Math.max(peak, cash);
  }
  
  return { final: cash, peak, trades, wins, winRate: trades > 0 ? wins / trades : 0, busted: cash < 1.0 };
}

function buildEventStream(edge, holdoutCycles, nEvents) {
  // Build a stream of trade events by randomly sampling from holdout cycles
  // that match this edge's criteria
  const events = [];
  const prices = edge.holdoutPrices;
  if (!prices || prices.length === 0) return events;
  
  for (let i = 0; i < nEvents; i++) {
    const idx = Math.floor(Math.random() * prices.length);
    const entry = prices[idx];
    // Determine win/loss based on holdout WR (random with same probability)
    const won = Math.random() < edge.holdoutWR;
    events.push({ entry, won, edge: edge.key });
  }
  
  return events;
}

function buildMixedEventStream(edges, tradesPerDay, days) {
  const totalTrades = Math.floor(tradesPerDay * days);
  const events = [];
  
  // Weight edges by their holdout N (more data = more likely to trade)
  const totalN = edges.reduce((s, e) => s + e.holdoutN, 0);
  
  for (let i = 0; i < totalTrades; i++) {
    // Pick an edge proportionally to its holdout event count
    let r = Math.random() * totalN;
    let selected = edges[0];
    for (const e of edges) {
      r -= e.holdoutN;
      if (r <= 0) { selected = e; break; }
    }
    
    // Generate event from this edge
    const prices = selected.holdoutPrices;
    const entry = prices[Math.floor(Math.random() * prices.length)];
    
    // Apply friction: 10% no-fill, 1 cent adverse shift
    if (Math.random() < 0.107) continue; // no-fill
    const adjEntry = Math.min(0.99, entry + 0.01); // adverse fill
    
    const won = Math.random() < selected.holdoutWR;
    events.push({ entry: adjEntry, won, edge: selected.key });
  }
  
  return events;
}

function runMC(edges, config) {
  const { runs, startBalance, stakeFraction, tradesPerDay, days, maxTradesPerPath } = config;
  const finals = [];
  
  for (let i = 0; i < runs; i++) {
    const events = buildMixedEventStream(edges, tradesPerDay, days);
    const result = simulatePath(events, startBalance, stakeFraction, maxTradesPerPath);
    finals.push(result);
  }
  
  finals.sort((a, b) => a.final - b.final);
  
  const n = finals.length;
  const median = finals[Math.floor(n * 0.5)].final;
  const p10 = finals[Math.floor(n * 0.1)].final;
  const p25 = finals[Math.floor(n * 0.25)].final;
  const p75 = finals[Math.floor(n * 0.75)].final;
  const p90 = finals[Math.floor(n * 0.9)].final;
  const p95 = finals[Math.floor(n * 0.95)].final;
  const p99 = finals[Math.floor(n * 0.99)].final;
  const max = finals[n - 1].final;
  const mean = finals.reduce((s, r) => s + r.final, 0) / n;
  const bustCount = finals.filter(r => r.final < 1.0).length;
  const gte20 = finals.filter(r => r.final >= 20).length;
  const gte50 = finals.filter(r => r.final >= 50).length;
  const gte100 = finals.filter(r => r.final >= 100).length;
  const gte200 = finals.filter(r => r.final >= 200).length;
  const gte500 = finals.filter(r => r.final >= 500).length;
  const gte1000 = finals.filter(r => r.final >= 1000).length;
  const medianTrades = finals.sort((a, b) => a.trades - b.trades)[Math.floor(n * 0.5)].trades;
  const medianWR = finals.sort((a, b) => a.winRate - b.winRate)[Math.floor(n * 0.5)].winRate;
  
  return {
    median, mean, p10, p25, p75, p90, p95, p99, max,
    bust: bustCount / n,
    pGte20: gte20 / n,
    pGte50: gte50 / n,
    pGte100: gte100 / n,
    pGte200: gte200 / n,
    pGte500: gte500 / n,
    pGte1000: gte1000 / n,
    medianTrades, medianWR,
    runs: n,
  };
}

// ==================== MAIN ====================
function main() {
  ensureDir(OUT_DIR);
  console.log('=== EPOCH 3 VARIANCE-MAXIMIZING ALPHA MINING ===');
  console.log('');
  
  // Load all data
  console.log('Loading data...');
  const data15 = loadData('data/intracycle-price-data.json');
  const data5 = loadData('data/intracycle-price-data-5m.json');
  const data4 = loadData('data/intracycle-price-data-4h.json');
  console.log(`  15m: ${data15.length}, 5m: ${data5.length}, 4h: ${data4.length}`);
  console.log('');
  
  // Analyze edges with walk-forward split
  console.log('Mining edges (15m)...');
  const analysis15 = analyzeEdges(data15, 0.65);
  console.log(`  Found ${analysis15.edges.length} validated edges`);
  
  console.log('Mining edges (5m)...');
  const analysis5 = analyzeEdges(data5, 0.65);
  console.log(`  Found ${analysis5.edges.length} validated edges`);
  
  console.log('Mining edges (4h)...');
  const analysis4 = analyzeEdges(data4, 0.50);
  console.log(`  Found ${analysis4.edges.length} validated edges`);
  console.log('');
  
  // Combine all edges
  const allEdges = [...analysis15.edges, ...analysis5.edges, ...analysis4.edges];
  console.log(`Total validated edges: ${allEdges.length}`);
  
  // Show top edges
  allEdges.sort((a, b) => b.holdoutEV - a.holdoutEV);
  console.log('');
  console.log('=== TOP 30 VALIDATED EDGES (by holdout EV/share) ===');
  allEdges.slice(0, 30).forEach((e, i) => {
    console.log(`  ${i + 1}. [${e.level}] ${e.key}: holdoutWR=${(e.holdoutWR * 100).toFixed(1)}% holdoutN=${e.holdoutN} avgEntry=${e.holdoutAvgP.toFixed(3)} EV=${e.holdoutEV.toFixed(4)} trainWR=${(e.trainWR * 100).toFixed(1)}% trainN=${e.trainN}`);
  });
  
  // Filter to edges with positive holdout EV
  const positiveEdges = allEdges.filter(e => e.holdoutEV > 0);
  console.log(`\nEdges with positive holdout EV: ${positiveEdges.length}`);
  
  // Also filter to edges with holdout WR > breakeven
  const strongEdges = positiveEdges.filter(e => e.holdoutWR > 0.55);
  console.log(`Edges with holdout WR > 55%: ${strongEdges.length}`);
  
  // Run simulations with various configurations
  const MC_RUNS = 10000;
  const configs = [];
  
  // Vary stake fraction from conservative to extreme
  for (const stakeFrac of [0.30, 0.45, 0.60, 0.75, 0.85, 0.95]) {
    // Vary trade density
    for (const tradesPerDay of [8, 15, 25, 40]) {
      configs.push({
        label: `stake=${(stakeFrac * 100).toFixed(0)}% tpd=${tradesPerDay}`,
        stakeFraction: stakeFrac,
        tradesPerDay,
        days: 7,
      });
    }
  }
  
  // Run for multiple starting balances
  const results = {};
  const edgeSets = [
    { name: 'all_positive', edges: positiveEdges },
    { name: 'strong_only', edges: strongEdges },
    { name: 'top20', edges: positiveEdges.slice(0, 20) },
    { name: 'top10', edges: positiveEdges.slice(0, 10) },
  ];
  
  for (const edgeSet of edgeSets) {
    if (edgeSet.edges.length === 0) {
      console.log(`\nSkipping ${edgeSet.name}: no edges`);
      continue;
    }
    results[edgeSet.name] = {};
    console.log(`\n=== ${edgeSet.name.toUpperCase()} (${edgeSet.edges.length} edges) ===`);
    
    for (const start of [5, 10]) {
      results[edgeSet.name][start] = {};
      
      for (const cfg of configs) {
        const mc = runMC(edgeSet.edges, {
          runs: MC_RUNS,
          startBalance: start,
          stakeFraction: cfg.stakeFraction,
          tradesPerDay: cfg.tradesPerDay,
          days: cfg.days,
          maxTradesPerPath: 500,
        });
        
        results[edgeSet.name][start][cfg.label] = mc;
        
        if (mc.pGte500 > 0 || mc.pGte100 > 0 || mc.pGte50 > 0) {
          console.log(`  $${start} ${cfg.label}: median=$${mc.median.toFixed(2)} bust=${(mc.bust * 100).toFixed(1)}% P≥$50=${(mc.pGte50 * 100).toFixed(1)}% P≥$100=${(mc.pGte100 * 100).toFixed(1)}% P≥$500=${(mc.pGte500 * 100).toFixed(2)}% max=$${mc.max.toFixed(2)}`);
        }
      }
    }
  }
  
  // Find the best configuration by P(≥$500) from $10
  console.log('\n=== BEST CONFIGURATIONS BY P(≥$500) FROM $10 ===');
  const allCfgs = [];
  for (const [esName, starts] of Object.entries(results)) {
    const s10 = starts['10'];
    if (!s10) continue;
    for (const [cfgLabel, mc] of Object.entries(s10)) {
      allCfgs.push({ edgeSet: esName, config: cfgLabel, ...mc });
    }
  }
  allCfgs.sort((a, b) => b.pGte500 - a.pGte500);
  
  console.log('');
  allCfgs.slice(0, 20).forEach((c, i) => {
    console.log(`  ${i + 1}. [${c.edgeSet}] ${c.config}`);
    console.log(`     median=$${c.median.toFixed(2)} bust=${(c.bust * 100).toFixed(1)}% P≥$50=${(c.pGte50 * 100).toFixed(1)}% P≥$100=${(c.pGte100 * 100).toFixed(1)}% P≥$500=${(c.pGte500 * 100).toFixed(2)}% P≥$1000=${(c.pGte1000 * 100).toFixed(2)}%`);
    console.log(`     p90=$${c.p90.toFixed(2)} p95=$${c.p95.toFixed(2)} p99=$${c.p99.toFixed(2)} max=$${c.max.toFixed(2)} meanTrades=${c.medianTrades}`);
  });
  
  // Also show best by P(≥$100)
  console.log('\n=== BEST CONFIGURATIONS BY P(≥$100) FROM $10 ===');
  allCfgs.sort((a, b) => b.pGte100 - a.pGte100);
  allCfgs.slice(0, 10).forEach((c, i) => {
    console.log(`  ${i + 1}. [${c.edgeSet}] ${c.config}: P≥$100=${(c.pGte100 * 100).toFixed(1)}% P≥$500=${(c.pGte500 * 100).toFixed(2)}% median=$${c.median.toFixed(2)} bust=${(c.bust * 100).toFixed(1)}%`);
  });
  
  // Save results
  fs.writeFileSync(path.join(OUT_DIR, 'epoch3_variance_max_results.json'), JSON.stringify({
    generatedAt: new Date().toISOString(),
    mcRuns: MC_RUNS,
    edgeSets: Object.fromEntries(edgeSets.map(es => [es.name, { count: es.edges.length, topEdges: es.edges.slice(0, 5).map(e => ({ key: e.key, holdoutWR: e.holdoutWR, holdoutN: e.holdoutN, holdoutEV: e.holdoutEV })) }])),
    results,
  }, null, 2));
  
  // Generate the best strategy set for deployment
  const best = allCfgs[0]; // best by P(≥$500)
  if (best) {
    console.log('\n=== BEST OVERALL CONFIGURATION ===');
    console.log(`Edge set: ${best.edgeSet}`);
    console.log(`Config: ${best.config}`);
    console.log(`From $10/7d: median=$${best.median.toFixed(2)}, bust=${(best.bust * 100).toFixed(1)}%`);
    console.log(`P(≥$50)=${(best.pGte50 * 100).toFixed(1)}%, P(≥$100)=${(best.pGte100 * 100).toFixed(1)}%, P(≥$500)=${(best.pGte500 * 100).toFixed(2)}%, P(≥$1000)=${(best.pGte1000 * 100).toFixed(2)}%`);
    console.log(`p90=$${best.p90.toFixed(2)}, p95=$${best.p95.toFixed(2)}, p99=$${best.p99.toFixed(2)}, max=$${best.max.toFixed(2)}`);
  }
  
  console.log('\n=== COMPLETE ===');
}

main();
