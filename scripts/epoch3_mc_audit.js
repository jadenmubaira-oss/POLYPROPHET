#!/usr/bin/env node
/**
 * EPOCH 3 V2 — HONEST MC AUDIT
 * 
 * Fixes the critical MC flaw: enforces MPC per cycle (epoch).
 * At MPC=1 (bankroll < $15), only 1 trade per cycle even if
 * multiple strategies fire on different assets/directions.
 * 
 * Also performs comprehensive data auditing.
 */

const fs = require('fs');
const path = require('path');

// Constants from lib/polymarket-fees.js
const FEE_RATE = 0.072;
const SLIPPAGE_PCT = 0.01;
const MIN_ORDER_SHARES = 5;

function calcFeePerShare(price) {
  return FEE_RATE * price * (1 - price);
}

// ─── Load data ───
const portfolioData = JSON.parse(fs.readFileSync(
  path.join(__dirname, '../epoch3/reinvestigation_v2/portfolio_events.json'), 'utf8'));
const events = portfolioData.events;

function loadCycles(relativePath) {
  const raw = JSON.parse(fs.readFileSync(path.join(__dirname, '..', relativePath), 'utf8'));
  return raw.cycles || [];
}

function splitEpoch(cycles, trainFraction = 0.6) {
  const sorted = cycles.slice().sort((a, b) => a.epoch - b.epoch);
  const splitIdx = Math.floor(sorted.length * trainFraction);
  return sorted[splitIdx]?.epoch || 0;
}

function buildCycleIndex(cycles) {
  const index = {};
  cycles.forEach(c => {
    index[`${c.epoch}_${c.asset}`] = c;
  });
  return index;
}

const rawDatasets = {
  '15m': loadCycles('data/intracycle-price-data.json'),
  '5m': loadCycles('data/intracycle-price-data-5m.json'),
};
const splitEpochs = Object.fromEntries(Object.entries(rawDatasets).map(([tf, cycles]) => [tf, splitEpoch(cycles)]));
const cycleIndexes = Object.fromEntries(Object.entries(rawDatasets).map(([tf, cycles]) => [tf, buildCycleIndex(cycles)]));
function hasNoLeakage(ev) {
  const tf = ev.timeframe || '15m';
  return ev.epoch >= (splitEpochs[tf] || 0);
}

console.log('╔══════════════════════════════════════════════════╗');
console.log('║  EPOCH 3 V2 — HONEST MC AUDIT & VERIFICATION   ║');
console.log('╚══════════════════════════════════════════════════╝\n');

// ─── AUDIT 1: Event deduplication ───
console.log('═══ AUDIT 1: EVENT DEDUPLICATION ═══');
const byEpoch = {};
events.forEach(e => {
  if (!byEpoch[e.epoch]) byEpoch[e.epoch] = [];
  byEpoch[e.epoch].push(e);
});
const uniqueEpochs = Object.keys(byEpoch).length;
const epochsWithMultiple = Object.values(byEpoch).filter(arr => arr.length > 1).length;
console.log(`Total events: ${events.length}`);
console.log(`Unique epochs (cycles): ${uniqueEpochs}`);
console.log(`Epochs with >1 event: ${epochsWithMultiple}`);
console.log(`Events per epoch distribution:`);
const distrib = {};
Object.values(byEpoch).forEach(arr => {
  distrib[arr.length] = (distrib[arr.length] || 0) + 1;
});
Object.entries(distrib).sort((a,b) => a[0]-b[0]).forEach(([k,v]) => {
  console.log(`  ${k} events/epoch: ${v} epochs`);
});

// ─── AUDIT 2: Chronological holdout verification ───
console.log('\n═══ AUDIT 2: CHRONOLOGICAL HOLDOUT ═══');
const sortedEpochs = Object.keys(byEpoch).map(Number).sort((a,b) => a-b);
const minDate = new Date(sortedEpochs[0] * 1000).toISOString();
const maxDate = new Date(sortedEpochs[sortedEpochs.length-1] * 1000).toISOString();
const rangeDays = (sortedEpochs[sortedEpochs.length-1] - sortedEpochs[0]) / 86400;
console.log(`Holdout range: ${minDate} to ${maxDate}`);
console.log(`Range: ${rangeDays.toFixed(1)} days`);
console.log(`Cycles/day: ${(uniqueEpochs / rangeDays).toFixed(1)}`);

for (const [tf, cutoff] of Object.entries(splitEpochs)) {
  const tfEvents = events.filter(e => (e.timeframe || '15m') === tf);
  if (tfEvents.length === 0) continue;
  const clean = tfEvents.every(e => e.epoch >= cutoff);
  console.log(`${tf} train cutoff epoch: ${cutoff} (${new Date(cutoff * 1000).toISOString()})`);
  console.log(`${tf} holdout events after cutoff: ${clean ? 'YES ✓' : 'NO ✗ LEAKAGE DETECTED'} (${tfEvents.length} events)`);
}

// ─── AUDIT 3: Win rate verification ───
console.log('\n═══ AUDIT 3: WIN RATE SPOT-CHECK ═══');
// Spot-check: verify some events against raw data
let verified = 0, failed = 0;
const sample = events.slice(0, 50);
sample.forEach(ev => {
  const key = ev.epoch + '_' + ev.asset;
  const raw = cycleIndexes[ev.timeframe || '15m']?.[key];
  if (!raw) { failed++; return; }
  const expectedWon = raw.resolution === ev.dir;
  if (expectedWon === ev.won) verified++;
  else {
    console.log(`  MISMATCH: epoch=${ev.epoch} asset=${ev.asset} dir=${ev.dir} resolution=${raw.resolution} expected=${expectedWon} got=${ev.won}`);
    failed++;
  }
});
console.log(`Spot-checked: ${sample.length} events`);
console.log(`Verified correct: ${verified}`);
console.log(`Failed: ${failed}`);
console.log(`Accuracy: ${(verified/sample.length*100).toFixed(1)}%`);

// ─── AUDIT 4: Price verification ───
console.log('\n═══ AUDIT 4: PRICE VERIFICATION ═══');
let priceVerified = 0, priceFailed = 0;
sample.forEach(ev => {
  const key = ev.epoch + '_' + ev.asset;
  const raw = cycleIndexes[ev.timeframe || '15m']?.[key];
  if (!raw) return;
  // Check that the price in the event matches the raw data at the stated minute
  // Events come from strategies with entry minute 1-5
  // The price should be from minutePricesYes or minutePricesNo at the entry minute
  const prices = ev.dir === 'UP' ? raw.minutePricesYes : raw.minutePricesNo;
  if (!prices) return;
  
  // Check all possible entry minutes (1-5)
  let found = false;
  for (let m = 1; m <= 5; m++) {
    const mp = prices[String(m)];
    if (mp && Math.abs(mp.last - ev.price) < 0.001) {
      found = true;
      break;
    }
  }
  if (found) priceVerified++;
  else priceFailed++;
});
console.log(`Price spot-checked: ${priceVerified + priceFailed}`);
console.log(`Price matched raw data: ${priceVerified}`);
console.log(`Price mismatch: ${priceFailed}`);

// ─── HONEST MC SIMULATION (MPC-enforced) ───
console.log('\n═══ HONEST MC SIMULATION (MPC-enforced per cycle) ═══');

function honestMonteCarlo(events, startBankroll, horizonDays, runs = 5000, options = {}) {
  // Group events by epoch to enforce MPC
  const byEpoch = {};
  events.forEach(e => {
    if (!byEpoch[e.epoch]) byEpoch[e.epoch] = [];
    byEpoch[e.epoch].push(e);
  });
  
  const epochs = Object.keys(byEpoch).map(Number).sort((a,b) => a-b);
  const epochRange = epochs[epochs.length-1] - epochs[0];
  const daysOfData = Math.max(1, epochRange / 86400);
  const cyclesPerDay = epochs.length / daysOfData;
  const totalCycles = Math.round(cyclesPerDay * horizonDays);
  
  console.log(`  Unique cycles: ${epochs.length}`);
  console.log(`  Cycles/day: ${cyclesPerDay.toFixed(1)}`);
  console.log(`  Total simulated cycles (${horizonDays}d): ${totalCycles}`);
  
  function getStakeFraction(bankroll) {
    if (bankroll < 15) return 0.40;
    if (bankroll < 50) return 0.35;
    if (bankroll < 200) return 0.30;
    return 0.25;
  }
  
  function getMPC(bankroll) {
    if (bankroll < 15) return 1;
    if (bankroll < 50) return 2;
    if (bankroll < 200) return 3;
    return 5;
  }
  
  function executeTrade(entryPrice, won, stakeUsd, slipExtra) {
    const effectiveEntry = Math.min(0.99, entryPrice * (1 + SLIPPAGE_PCT) + slipExtra);
    if (effectiveEntry <= 0 || effectiveEntry >= 1) return { pnl: 0, blocked: true };
    const feePS = calcFeePerShare(effectiveEntry);
    const costPerShare = effectiveEntry + feePS;
    let shares = Math.floor(stakeUsd / costPerShare);
    
    if (shares < MIN_ORDER_SHARES) {
      // Micro-bankroll: bump to min order if affordable
      const minCost = MIN_ORDER_SHARES * costPerShare;
      if (stakeUsd >= minCost * 0.8) {
        shares = MIN_ORDER_SHARES;
      } else {
        return { pnl: 0, blocked: true };
      }
    }
    
    const totalCost = shares * costPerShare;
    if (won) return { pnl: shares * 1.0 - totalCost, blocked: false };
    else return { pnl: -totalCost, blocked: false };
  }
  
  const MAX_STAKE = 200;
  const results = [];
  
  for (let run = 0; run < runs; run++) {
    let bankroll = startBankroll;
    let busted = false;
    
    for (let c = 0; c < totalCycles; c++) {
      if (bankroll < 1.5) { busted = true; break; }
      
      // Pick a random cycle (epoch) from data
      const epochIdx = Math.floor(Math.random() * epochs.length);
      const cycleEvents = byEpoch[epochs[epochIdx]];
      
      const mpc = options.forceMpc || getMPC(bankroll);
      const sf = getStakeFraction(bankroll);
      
      // Execute up to MPC trades from this cycle
      // Shuffle events to avoid bias
      const shuffled = [...cycleEvents].sort(() => Math.random() - 0.5);
      const toTrade = Math.min(mpc, shuffled.length);
      
      for (let t = 0; t < toTrade; t++) {
        if (bankroll < 1.5) { busted = true; break; }
        
        let stake = bankroll * sf;
        stake = Math.min(stake, MAX_STAKE);
        
        const ev = shuffled[t];
        const effEntry = Math.min(0.99, ev.price * (1 + SLIPPAGE_PCT));
        const minCost = MIN_ORDER_SHARES * (effEntry + calcFeePerShare(effEntry));
        if (stake < minCost && bankroll >= minCost * 1.05) {
          stake = minCost;
        }
        stake = Math.min(stake, bankroll * 0.85);
        
        const result = executeTrade(ev.price, ev.won, stake, 0);
        if (result.blocked) continue;
        bankroll += result.pnl;
        if (bankroll < 0) bankroll = 0;
      }
    }
    
    results.push(busted ? 0 : bankroll);
  }
  
  results.sort((a, b) => a - b);
  return {
    median: results[Math.floor(runs * 0.5)],
    p10: results[Math.floor(runs * 0.1)],
    p25: results[Math.floor(runs * 0.25)],
    p75: results[Math.floor(runs * 0.75)],
    p90: results[Math.floor(runs * 0.9)],
    bustPct: (results.filter(r => r < 1.5).length / runs * 100),
    pGe100: (results.filter(r => r >= 100).length / runs * 100),
    pGe500: (results.filter(r => r >= 500).length / runs * 100),
    pGe1000: (results.filter(r => r >= 1000).length / runs * 100),
    totalCycles,
    cyclesPerDay: Math.round(cyclesPerDay * 10) / 10
  };
}

function honestMCAdverse(events, startBankroll, horizonDays, runs = 5000, options = {}) {
  // Same as above but with +2c adverse slippage
  const byEpoch = {};
  events.forEach(e => {
    if (!byEpoch[e.epoch]) byEpoch[e.epoch] = [];
    byEpoch[e.epoch].push(e);
  });
  
  const epochs = Object.keys(byEpoch).map(Number).sort((a,b) => a-b);
  const epochRange = epochs[epochs.length-1] - epochs[0];
  const daysOfData = Math.max(1, epochRange / 86400);
  const cyclesPerDay = epochs.length / daysOfData;
  const totalCycles = Math.round(cyclesPerDay * horizonDays);
  
  function getStakeFraction(bankroll) {
    if (bankroll < 15) return 0.40;
    if (bankroll < 50) return 0.35;
    if (bankroll < 200) return 0.30;
    return 0.25;
  }
  
  function getMPC(bankroll) {
    if (bankroll < 15) return 1;
    if (bankroll < 50) return 2;
    if (bankroll < 200) return 3;
    return 5;
  }
  
  function executeTrade(entryPrice, won, stakeUsd) {
    const effectiveEntry = Math.min(0.99, entryPrice * (1 + SLIPPAGE_PCT) + 0.02);
    if (effectiveEntry <= 0 || effectiveEntry >= 1) return { pnl: 0, blocked: true };
    const feePS = calcFeePerShare(effectiveEntry);
    const costPerShare = effectiveEntry + feePS;
    let shares = Math.floor(stakeUsd / costPerShare);
    
    if (shares < MIN_ORDER_SHARES) {
      const minCost = MIN_ORDER_SHARES * costPerShare;
      if (stakeUsd >= minCost * 0.8) {
        shares = MIN_ORDER_SHARES;
      } else {
        return { pnl: 0, blocked: true };
      }
    }
    
    const totalCost = shares * costPerShare;
    if (won) return { pnl: shares * 1.0 - totalCost, blocked: false };
    else return { pnl: -totalCost, blocked: false };
  }
  
  const MAX_STAKE = 200;
  const results = [];
  
  for (let run = 0; run < runs; run++) {
    let bankroll = startBankroll;
    let busted = false;
    
    for (let c = 0; c < totalCycles; c++) {
      if (bankroll < 1.5) { busted = true; break; }
      
      const epochIdx = Math.floor(Math.random() * epochs.length);
      const cycleEvents = byEpoch[epochs[epochIdx]];
      
      const mpc = options.forceMpc || getMPC(bankroll);
      const sf = getStakeFraction(bankroll);
      
      const shuffled = [...cycleEvents].sort(() => Math.random() - 0.5);
      const toTrade = Math.min(mpc, shuffled.length);
      
      for (let t = 0; t < toTrade; t++) {
        if (bankroll < 1.5) { busted = true; break; }
        
        let stake = bankroll * sf;
        stake = Math.min(stake, MAX_STAKE);
        
        const ev = shuffled[t];
        const effEntry = Math.min(0.99, ev.price * (1 + SLIPPAGE_PCT) + 0.02);
        const minCost = MIN_ORDER_SHARES * (effEntry + calcFeePerShare(effEntry));
        if (stake < minCost && bankroll >= minCost * 1.05) {
          stake = minCost;
        }
        stake = Math.min(stake, bankroll * 0.85);
        
        const result = executeTrade(ev.price, ev.won, stake);
        if (result.blocked) continue;
        bankroll += result.pnl;
        if (bankroll < 0) bankroll = 0;
      }
    }
    
    results.push(busted ? 0 : bankroll);
  }
  
  results.sort((a, b) => a - b);
  return {
    median: results[Math.floor(runs * 0.5)],
    p10: results[Math.floor(runs * 0.1)],
    p25: results[Math.floor(runs * 0.25)],
    p75: results[Math.floor(runs * 0.75)],
    p90: results[Math.floor(runs * 0.9)],
    bustPct: (results.filter(r => r < 1.5).length / runs * 100),
    pGe100: (results.filter(r => r >= 100).length / runs * 100),
    pGe500: (results.filter(r => r >= 500).length / runs * 100),
    pGe1000: (results.filter(r => r >= 1000).length / runs * 100),
  };
}

// Run for $5, $7, $10 starting bankrolls
const bankrolls = [5, 7, 10];

console.log('\n── STRICT (1% slippage, exact fees, MPC-enforced, $200 liquidity cap) ──');
const strictResults = {};
for (const b of bankrolls) {
  const r = honestMonteCarlo(events, b, 7, 5000);
  strictResults[b] = r;
  console.log(`\n$${b} start (7 days):`);
  console.log(`  Median: $${r.median.toFixed(2)}`);
  console.log(`  P10/P25/P75/P90: $${r.p10.toFixed(2)} / $${r.p25.toFixed(2)} / $${r.p75.toFixed(2)} / $${r.p90.toFixed(2)}`);
  console.log(`  Bust: ${r.bustPct.toFixed(1)}%`);
  console.log(`  P≥$100: ${r.pGe100.toFixed(1)}%`);
  console.log(`  P≥$500: ${r.pGe500.toFixed(1)}%`);
  console.log(`  P≥$1000: ${r.pGe1000.toFixed(1)}%`);
}

console.log('\n── ADVERSE (+2c worse fill, MPC-enforced) ──');
const adverseResults = {};
for (const b of bankrolls) {
  const r = honestMCAdverse(events, b, 7, 5000);
  adverseResults[b] = r;
  console.log(`\n$${b} start (7 days, adverse):`);
  console.log(`  Median: $${r.median.toFixed(2)}`);
  console.log(`  P10/P25/P75/P90: $${r.p10.toFixed(2)} / $${r.p25.toFixed(2)} / $${r.p75.toFixed(2)} / $${r.p90.toFixed(2)}`);
  console.log(`  Bust: ${r.bustPct.toFixed(1)}%`);
  console.log(`  P≥$100: ${r.pGe100.toFixed(1)}%`);
  console.log(`  P≥$500: ${r.pGe500.toFixed(1)}%`);
  console.log(`  P≥$1000: ${r.pGe1000.toFixed(1)}%`);
}

console.log('\n── STRICT ONE-TRADE-PER-CYCLE STRESS (force MPC=1 at all bankrolls) ──');
const oneTradeResults = {};
for (const b of bankrolls) {
  const r = honestMonteCarlo(events, b, 7, 5000, { forceMpc: 1 });
  oneTradeResults[b] = r;
  console.log(`\n$${b} start (7 days, forced MPC=1):`);
  console.log(`  Median: $${r.median.toFixed(2)}`);
  console.log(`  P10/P25/P75/P90: $${r.p10.toFixed(2)} / $${r.p25.toFixed(2)} / $${r.p75.toFixed(2)} / $${r.p90.toFixed(2)}`);
  console.log(`  Bust: ${r.bustPct.toFixed(1)}%`);
  console.log(`  P≥$100: ${r.pGe100.toFixed(1)}%`);
  console.log(`  P≥$500: ${r.pGe500.toFixed(1)}%`);
  console.log(`  P≥$1000: ${r.pGe1000.toFixed(1)}%`);
}

console.log('\n── ADVERSE ONE-TRADE-PER-CYCLE STRESS (+2c, force MPC=1) ──');
const oneTradeAdverseResults = {};
for (const b of bankrolls) {
  const r = honestMCAdverse(events, b, 7, 5000, { forceMpc: 1 });
  oneTradeAdverseResults[b] = r;
  console.log(`\n$${b} start (7 days, adverse forced MPC=1):`);
  console.log(`  Median: $${r.median.toFixed(2)}`);
  console.log(`  P10/P25/P75/P90: $${r.p10.toFixed(2)} / $${r.p25.toFixed(2)} / $${r.p75.toFixed(2)} / $${r.p90.toFixed(2)}`);
  console.log(`  Bust: ${r.bustPct.toFixed(1)}%`);
  console.log(`  P≥$100: ${r.pGe100.toFixed(1)}%`);
  console.log(`  P≥$500: ${r.pGe500.toFixed(1)}%`);
  console.log(`  P≥$1000: ${r.pGe1000.toFixed(1)}%`);
}

// ─── AUDIT 5: Per-trade EV math verification ───
console.log('\n═══ AUDIT 5: PER-TRADE EV MATH ═══');
const avgPrice = events.reduce((s,e) => s + e.price, 0) / events.length;
const wr = events.filter(e => e.won).length / events.length;
const fee = calcFeePerShare(avgPrice);
const costPS = avgPrice * (1 + SLIPPAGE_PCT) + fee;
const winPnlPS = 1.0 - costPS;
const lossPnlPS = -costPS;
const evPS = wr * winPnlPS + (1-wr) * lossPnlPS;
const evPct = evPS / costPS * 100;
console.log(`Avg entry: ${avgPrice.toFixed(3)}`);
console.log(`Fee/share: ${fee.toFixed(4)}`);
console.log(`Cost/share (incl slip+fee): ${costPS.toFixed(4)}`);
console.log(`Win PnL/share: +${winPnlPS.toFixed(4)}`);
console.log(`Loss PnL/share: ${lossPnlPS.toFixed(4)}`);
console.log(`WR: ${(wr*100).toFixed(1)}%`);
console.log(`EV/share: ${evPS.toFixed(4)}`);
console.log(`EV as % of cost: ${evPct.toFixed(1)}%`);

// ─── AUDIT 6: Growth rate sanity check ───
console.log('\n═══ AUDIT 6: GROWTH RATE SANITY CHECK ═══');
// With SF=0.40 at $10, buying 5 shares at 68c+fees:
const stake10 = 10 * 0.40;
const shares10 = Math.floor(stake10 / costPS);
const sharesUsed = Math.max(shares10, MIN_ORDER_SHARES);
const winGain = sharesUsed * winPnlPS;
const lossAmount = sharesUsed * costPS;
console.log(`At $10 bankroll, SF=0.40, stake=$${stake10.toFixed(2)}:`);
console.log(`  Shares: ${sharesUsed} (min order: ${MIN_ORDER_SHARES})`);
console.log(`  Win: +$${winGain.toFixed(2)} (bankroll → $${(10 + winGain).toFixed(2)})`);
console.log(`  Loss: -$${lossAmount.toFixed(2)} (bankroll → $${(10 - lossAmount).toFixed(2)})`);
console.log(`  Expected bankroll after 1 trade: $${(10 + wr*winGain + (1-wr)*(-lossAmount)).toFixed(2)}`);

// Manual compounding check
let b = 10;
for (let i = 0; i < 10; i++) {
  const sf = b < 15 ? 0.40 : b < 50 ? 0.35 : b < 200 ? 0.30 : 0.25;
  let s = b * sf;
  const cps = avgPrice * (1.01) + fee;
  let sh = Math.floor(s / cps);
  if (sh < MIN_ORDER_SHARES && b >= MIN_ORDER_SHARES * cps * 1.05) sh = MIN_ORDER_SHARES;
  if (sh < MIN_ORDER_SHARES) { console.log(`  Trade ${i+1}: BLOCKED (can't afford min order)`); continue; }
  s = Math.min(s, b * 0.85);
  sh = Math.min(sh, Math.floor(s / cps));
  if (sh < MIN_ORDER_SHARES) sh = MIN_ORDER_SHARES;
  const wpnl = sh * (1.0 - cps);
  const lpnl = -(sh * cps);
  const expected = b + wr * wpnl + (1-wr) * lpnl;
  console.log(`  Trade ${i+1}: $${b.toFixed(2)} → $${expected.toFixed(2)} (${sh} shares, SF=${sf})`);
  b = expected;
}

// Save audit results
const auditResults = {
  generatedAt: new Date().toISOString(),
  eventAudit: {
    totalEvents: events.length,
    uniqueEpochs,
    duplicateEpochs: events.length - uniqueEpochs,
    epochDistribution: distrib,
    holdoutRange: { min: minDate, max: maxDate, days: rangeDays },
    noLeakage: events.every(hasNoLeakage),
    splitEpochs,
    winRate: wr,
    avgEntry: avgPrice,
  },
  mcResults: {
    strict: strictResults,
    adverse: adverseResults,
    oneTradePerCycle: oneTradeResults,
    oneTradePerCycleAdverse: oneTradeAdverseResults,
  },
  evMath: {
    avgEntry: avgPrice,
    feePerShare: fee,
    costPerShare: costPS,
    winPnlPerShare: winPnlPS,
    lossPnlPerShare: lossPnlPS,
    evPerShare: evPS,
    evPctOfCost: evPct,
  },
};

const outDir = path.join(__dirname, '../epoch3/reinvestigation_v2');
fs.writeFileSync(path.join(outDir, 'epoch3_honest_mc_audit.json'), JSON.stringify(auditResults, null, 2));
console.log('\nAudit results saved to epoch3/reinvestigation_v2/epoch3_honest_mc_audit.json');
console.log('Completed:', new Date().toISOString());
