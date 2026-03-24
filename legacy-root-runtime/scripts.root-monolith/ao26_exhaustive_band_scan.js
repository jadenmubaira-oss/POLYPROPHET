#!/usr/bin/env node
/**
 * AO26 Exhaustive Band Scan
 * 
 * Tests every strategy set × multiple upper-band caps against recent data windows.
 * Finds the absolute best configuration that ACTUALLY TRADES in recent market conditions.
 * 
 * Outputs: trade counts, win rates, bankroll simulations for each combo.
 */

const fs = require('fs');
const path = require('path');

// ── Load decision dataset ──
const datasetPath = path.join(__dirname, '..', 'exhaustive_analysis', 'decision_dataset.json');
const allRows = JSON.parse(fs.readFileSync(datasetPath, 'utf8'));
console.log(`Loaded ${allRows.length} dataset rows`);

// ── Date windows ──
const epochs = allRows.map(r => r.cycleStartEpochSec).sort((a, b) => a - b);
const lastEpoch = epochs[epochs.length - 1];
const WINDOWS = {
  '7d': lastEpoch - 7 * 86400,
  '14d': lastEpoch - 14 * 86400,
  '30d': lastEpoch - 30 * 86400,
  'full': 0
};

// ── Strategy sets to test ──
const STRATEGY_SETS = {};
const stratDir = path.join(__dirname, '..', 'debug');
const setFiles = [
  'strategy_set_top3_robust.json',
  'strategy_set_top5_robust.json',
  'strategy_set_top7_drop6.json',
  'strategy_set_union_validated_top12.json'
];
for (const f of setFiles) {
  const fp = path.join(stratDir, f);
  if (fs.existsSync(fp)) {
    const j = JSON.parse(fs.readFileSync(fp, 'utf8'));
    const name = f.replace('strategy_set_', '').replace('.json', '');
    STRATEGY_SETS[name] = j.strategies || [];
  }
}
console.log(`Loaded strategy sets: ${Object.keys(STRATEGY_SETS).join(', ')}`);

// ── Band caps to test ──
const UPPER_CAPS = [0.80, 0.85, 0.90, 0.92, 0.95, 0.97, 0.99];
// Also test lowering the floor
const LOWER_FLOORS = [null]; // null = use strategy's own floor

// ── Core matching function (mirrors checkHybridStrategyReplay) ──
function matchesStrategy(row, strategy, upperCap) {
  const asset = String(row.asset || '').toUpperCase();
  const sAsset = String(strategy.asset || '').toUpperCase();
  if (sAsset !== 'ALL' && sAsset !== '*' && sAsset !== asset) return false;
  
  const utcHour = Number(row.utcHour);
  const entryMinute = Number(row.entryMinute);
  if (Number(strategy.utcHour) !== utcHour) return false;
  if (Number(strategy.entryMinute) !== entryMinute) return false;
  
  // Direction match
  const dir = String(strategy.direction || '').toUpperCase();
  // Entry price depends on direction
  let entryPrice;
  if (dir === 'UP') {
    entryPrice = Number(row.upPrice);
  } else if (dir === 'DOWN') {
    entryPrice = Number(row.downPrice);
  } else {
    return false;
  }
  
  if (!Number.isFinite(entryPrice)) return false;
  
  // Price band check with overridden upper cap
  const bandMin = Number(strategy.priceMin) || 0;
  const bandMax = upperCap; // OVERRIDE the strategy's own max
  
  if (entryPrice < bandMin || entryPrice > bandMax) return false;
  
  return { entryPrice, dir, asset, strategy };
}

// ── Check if a row wins ──
function isWin(row, direction) {
  if (direction === 'UP') return row.winnerIsUp === true;
  if (direction === 'DOWN') return row.winnerIsUp === false;
  return false;
}

// ── Bankroll simulation ──
function simulateBankroll(trades, startBalance, stakeFraction, minOrderShares) {
  let balance = startBalance;
  let peak = startBalance;
  let maxDD = 0;
  let executed = 0;
  let blocked = 0;
  let wins = 0;
  let losses = 0;
  const FEE_RATE = 0.02;
  
  for (const t of trades) {
    const minCost = minOrderShares * t.entryPrice;
    const intendedStake = balance * stakeFraction;
    let stake = Math.max(intendedStake, minCost);
    
    if (stake > balance) {
      blocked++;
      continue;
    }
    
    executed++;
    if (t.win) {
      const grossPayout = stake / t.entryPrice; // shares * $1
      const fee = grossPayout * FEE_RATE * t.entryPrice * (1 - t.entryPrice);
      const profit = grossPayout - stake - fee;
      balance += profit;
      wins++;
    } else {
      const fee = stake * FEE_RATE * t.entryPrice * (1 - t.entryPrice);
      balance -= stake + fee;
      losses++;
    }
    
    if (balance > peak) peak = balance;
    const dd = peak > 0 ? (peak - balance) / peak : 0;
    if (dd > maxDD) maxDD = dd;
    
    if (balance < 0.5) {
      balance = 0;
      break;
    }
  }
  
  return { executed, blocked, wins, losses, endBalance: balance, maxDD, wr: executed > 0 ? wins / executed : 0 };
}

// ── Main scan ──
const results = [];

for (const [windowName, cutoffEpoch] of Object.entries(WINDOWS)) {
  const windowRows = allRows.filter(r => r.cycleStartEpochSec >= cutoffEpoch);
  
  for (const [setName, strategies] of Object.entries(STRATEGY_SETS)) {
    for (const upperCap of UPPER_CAPS) {
      // Find all matching trades
      const trades = [];
      const cyclesSeen = new Set();
      
      for (const row of windowRows) {
        for (const strat of strategies) {
          const match = matchesStrategy(row, strat, upperCap);
          if (match) {
            const cycleKey = `${row.cycleStartEpochSec}_${row.entryMinute}_${row.utcHour}`;
            // Only one trade per cycle (collision handling)
            if (!cyclesSeen.has(cycleKey)) {
              cyclesSeen.add(cycleKey);
              trades.push({
                epoch: row.cycleStartEpochSec,
                asset: match.asset,
                direction: match.dir,
                entryPrice: match.entryPrice,
                win: isWin(row, match.dir),
                stratName: strat.name
              });
            }
            break; // first strategy match wins
          }
        }
      }
      
      // Sort by time
      trades.sort((a, b) => a.epoch - b.epoch);
      
      // Stats
      const totalTrades = trades.length;
      const totalWins = trades.filter(t => t.win).length;
      const wr = totalTrades > 0 ? totalWins / totalTrades : 0;
      
      // Bankroll sim
      const sim = simulateBankroll(trades, 5, 0.45, 5);
      
      // Days in window
      const windowDays = windowName === 'full' ? 153 : parseInt(windowName);
      const tradesPerDay = totalTrades / windowDays;
      
      results.push({
        window: windowName,
        set: setName,
        cap: upperCap,
        trades: totalTrades,
        wins: totalWins,
        wr: wr,
        tradesPerDay: tradesPerDay,
        sim_executed: sim.executed,
        sim_blocked: sim.blocked,
        sim_wr: sim.wr,
        sim_end: sim.endBalance,
        sim_maxDD: sim.maxDD,
        sim_wins: sim.wins,
        sim_losses: sim.losses
      });
    }
  }
}

// ── Sort and display ──
console.log('\n' + '='.repeat(120));
console.log('EXHAUSTIVE BAND SCAN RESULTS');
console.log('='.repeat(120));

for (const windowName of Object.keys(WINDOWS)) {
  const windowResults = results.filter(r => r.window === windowName);
  windowResults.sort((a, b) => b.sim_end - a.sim_end);
  
  console.log(`\n${'─'.repeat(120)}`);
  console.log(`WINDOW: ${windowName}`);
  console.log(`${'─'.repeat(120)}`);
  console.log(
    'Set'.padEnd(28) +
    'Cap'.padEnd(6) +
    'Trades'.padEnd(8) +
    'T/Day'.padEnd(7) +
    'WR%'.padEnd(7) +
    'Exec'.padEnd(7) +
    'Block'.padEnd(7) +
    'SimWR%'.padEnd(8) +
    'EndBal'.padEnd(12) +
    'MaxDD%'.padEnd(8)
  );
  
  for (const r of windowResults.slice(0, 15)) {
    console.log(
      r.set.padEnd(28) +
      (r.cap * 100 + 'c').padEnd(6) +
      String(r.trades).padEnd(8) +
      r.tradesPerDay.toFixed(1).padEnd(7) +
      (r.wr * 100).toFixed(1).padEnd(7) +
      String(r.sim_executed).padEnd(7) +
      String(r.sim_blocked).padEnd(7) +
      (r.sim_wr * 100).toFixed(1).padEnd(8) +
      ('$' + r.sim_end.toFixed(2)).padEnd(12) +
      (r.sim_maxDD * 100).toFixed(1).padEnd(8)
    );
  }
}

// ── Save full results as JSON ──
const outPath = path.join(__dirname, '..', 'debug', 'ao26_band_scan_results.json');
fs.writeFileSync(outPath, JSON.stringify(results, null, 2));
console.log(`\nFull results saved to ${outPath}`);

// ── Specific analysis: what entry prices appear in the LAST 7 days? ──
console.log('\n' + '='.repeat(80));
console.log('PRICE DISTRIBUTION IN LAST 7 DAYS OF DATASET');
console.log('='.repeat(80));

const last7Rows = allRows.filter(r => r.cycleStartEpochSec >= WINDOWS['7d']);
const priceRanges = {};
for (const band of ['<50c', '50-60c', '60-70c', '70-80c', '80-85c', '85-90c', '90-95c', '95-99c', '>99c']) {
  priceRanges[band] = { up: 0, down: 0 };
}
for (const r of last7Rows) {
  const up = r.upPrice;
  const dn = r.downPrice;
  const classifyUp = up < 0.50 ? '<50c' : up < 0.60 ? '50-60c' : up < 0.70 ? '60-70c' : up < 0.80 ? '70-80c' : up < 0.85 ? '80-85c' : up < 0.90 ? '85-90c' : up < 0.95 ? '90-95c' : up < 0.99 ? '95-99c' : '>99c';
  const classifyDn = dn < 0.50 ? '<50c' : dn < 0.60 ? '50-60c' : dn < 0.70 ? '60-70c' : dn < 0.80 ? '70-80c' : dn < 0.85 ? '80-85c' : dn < 0.90 ? '85-90c' : dn < 0.95 ? '90-95c' : dn < 0.99 ? '95-99c' : '>99c';
  priceRanges[classifyUp].up++;
  priceRanges[classifyDn].down++;
}
console.log('Band'.padEnd(12) + 'UP(yes)'.padEnd(10) + 'DOWN(no)'.padEnd(10) + 'UP%'.padEnd(8) + 'DOWN%'.padEnd(8));
for (const [band, counts] of Object.entries(priceRanges)) {
  const total = last7Rows.length;
  console.log(
    band.padEnd(12) +
    String(counts.up).padEnd(10) +
    String(counts.down).padEnd(10) +
    ((counts.up / total * 100).toFixed(1) + '%').padEnd(8) +
    ((counts.down / total * 100).toFixed(1) + '%').padEnd(8)
  );
}

// ── Win rate by price band in last 7 days ──
console.log('\n' + '='.repeat(80));
console.log('WIN RATE BY ENTRY PRICE BAND (LAST 7 DAYS)');
console.log('='.repeat(80));

const wrByBand = {};
for (const r of last7Rows) {
  for (const dir of ['UP', 'DOWN']) {
    const px = dir === 'UP' ? r.upPrice : r.downPrice;
    const win = dir === 'UP' ? r.winnerIsUp : !r.winnerIsUp;
    const band = px < 0.50 ? '<50c' : px < 0.60 ? '50-60c' : px < 0.70 ? '60-70c' : px < 0.80 ? '70-80c' : px < 0.85 ? '80-85c' : px < 0.90 ? '85-90c' : px < 0.95 ? '90-95c' : px < 0.99 ? '95-99c' : '>99c';
    const key = `${dir}_${band}`;
    if (!wrByBand[key]) wrByBand[key] = { wins: 0, total: 0 };
    wrByBand[key].total++;
    if (win) wrByBand[key].wins++;
  }
}
console.log('Dir+Band'.padEnd(18) + 'Trades'.padEnd(10) + 'Wins'.padEnd(10) + 'WR%'.padEnd(8));
for (const [key, data] of Object.entries(wrByBand).sort()) {
  if (data.total > 100) {
    console.log(
      key.padEnd(18) +
      String(data.total).padEnd(10) +
      String(data.wins).padEnd(10) +
      ((data.wins / data.total * 100).toFixed(1) + '%').padEnd(8)
    );
  }
}

// ── Check specifically: which strategy set + cap combos give trades in last 7 days with WR >= 70%? ──
console.log('\n' + '='.repeat(80));
console.log('VIABLE CONFIGS (Last 7d, WR >= 65%, trades >= 5)');
console.log('='.repeat(80));

const viable7d = results.filter(r => r.window === '7d' && r.wr >= 0.65 && r.trades >= 5);
viable7d.sort((a, b) => b.sim_end - a.sim_end);
for (const r of viable7d) {
  console.log(
    `${r.set} @ ${r.cap*100}c: ${r.trades} trades, ${(r.wr*100).toFixed(1)}% WR, ${r.tradesPerDay.toFixed(1)}/day, sim $${r.sim_end.toFixed(2)} (DD ${(r.sim_maxDD*100).toFixed(1)}%)`
  );
}

console.log('\nDone.');
