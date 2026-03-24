#!/usr/bin/env node
/**
 * AO27 Independent Verification + Extended Testing
 * 
 * 1. Spot-check AO26 claims from replay artifacts
 * 2. Test last-7d, last-14d, last-30d windows specifically
 * 3. Test momentum gate ON vs OFF for union_top12@95c
 * 4. Check EV at high price entries (fees vs ROI)
 * 5. Test ALL available strategy sets we haven't tried
 */

const fs = require('fs');
const path = require('path');

const datasetPath = path.join(__dirname, '..', 'exhaustive_analysis', 'decision_dataset.json');
const allRows = JSON.parse(fs.readFileSync(datasetPath, 'utf8'));
console.log(`Dataset: ${allRows.length} rows`);

const epochs = allRows.map(r => r.cycleStartEpochSec).sort((a, b) => a - b);
const lastEpoch = epochs[epochs.length - 1];

// ═══════════════════════════════════════════
// SECTION 1: Spot-check AO26 replay claims
// ═══════════════════════════════════════════
console.log('\n' + '═'.repeat(80));
console.log('SECTION 1: SPOT-CHECK AO26 REPLAY ARTIFACT CLAIMS');
console.log('═'.repeat(80));

const replayDir = path.join(__dirname, '..', 'debug', 'v140_runtime_parity_replays');
const candidates = [
  'top7_base', 'union_validated_top12', 'union_top12_max85', 'union_top12_max90',
  'union_top12_max95', 'union_top12_max97', 'top7_max95'
];

for (const c of candidates) {
  const fp = path.join(replayDir, c, 'hybrid_replay_executed_ledger.json');
  if (!fs.existsSync(fp)) { console.log(`${c}: NOT FOUND`); continue; }
  const j = JSON.parse(fs.readFileSync(fp, 'utf8'));
  const s = j.stats;
  const b = s.bankroll;
  console.log(
    `${c.padEnd(28)} | sig=${String(s.trades).padEnd(5)} sigWR=${(s.winRate*100).toFixed(1).padEnd(5)}% | ` +
    `exec=${String(b.executed).padEnd(5)} blk=${String(b.blocked).padEnd(4)} bkWR=${(b.winRate*100).toFixed(1).padEnd(5)}% | ` +
    `end=$${b.endingBalance.toFixed(2).padEnd(10)} maxDD=${(b.maxDrawdownPct*100).toFixed(1)}%`
  );
}

// ═══════════════════════════════════════════
// SECTION 2: Verify WR-by-band claim
// ═══════════════════════════════════════════
console.log('\n' + '═'.repeat(80));
console.log('SECTION 2: VERIFY WIN RATE BY PRICE BAND (FULL DATASET)');
console.log('═'.repeat(80));

const bandRanges = [
  [0.50, 0.60], [0.60, 0.70], [0.70, 0.80], [0.80, 0.85],
  [0.85, 0.90], [0.90, 0.95], [0.95, 0.99]
];

for (const [lo, hi] of bandRanges) {
  let dTrades = 0, dWins = 0, uTrades = 0, uWins = 0;
  for (const r of allRows) {
    if (r.downPrice >= lo && r.downPrice < hi) {
      dTrades++;
      if (!r.winnerIsUp) dWins++;
    }
    if (r.upPrice >= lo && r.upPrice < hi) {
      uTrades++;
      if (r.winnerIsUp) uWins++;
    }
  }
  const dWR = dTrades > 0 ? (dWins / dTrades * 100).toFixed(1) : 'N/A';
  const uWR = uTrades > 0 ? (uWins / uTrades * 100).toFixed(1) : 'N/A';
  console.log(`${(lo*100).toFixed(0)}-${(hi*100).toFixed(0)}c: DOWN ${dWR}% (n=${dTrades})  UP ${uWR}% (n=${uTrades})`);
}

// ═══════════════════════════════════════════
// SECTION 3: EV check at high price entries
// ═══════════════════════════════════════════
console.log('\n' + '═'.repeat(80));
console.log('SECTION 3: EV CHECK AT HIGH PRICE ENTRIES (including fees)');
console.log('═'.repeat(80));

for (const [lo, hi] of bandRanges) {
  const mid = (lo + hi) / 2;
  // Binary payoff: win = (1/entry - 1) * stake, loss = -stake
  // Polymarket fee: ~2% * entry * (1-entry) per share
  const feePerShare = 0.02 * mid * (1 - mid);
  const winROI = (1 / mid - 1) - feePerShare / mid; // net ROI on win
  const lossROI = -1 - feePerShare / mid; // net ROI on loss (lose stake + fee)
  
  // Use DOWN WR from dataset
  let dTrades = 0, dWins = 0;
  for (const r of allRows) {
    if (r.downPrice >= lo && r.downPrice < hi) {
      dTrades++;
      if (!r.winnerIsUp) dWins++;
    }
  }
  const wr = dTrades > 0 ? dWins / dTrades : 0;
  const ev = wr * winROI + (1 - wr) * lossROI;
  
  console.log(
    `${(lo*100).toFixed(0)}-${(hi*100).toFixed(0)}c: entry=${mid.toFixed(2)} fee=${(feePerShare*100).toFixed(2)}c ` +
    `winROI=${(winROI*100).toFixed(1)}% lossROI=${(lossROI*100).toFixed(1)}% ` +
    `WR=${(wr*100).toFixed(1)}% EV=${(ev*100).toFixed(2)}% ${ev > 0 ? '✅ POSITIVE' : '❌ NEGATIVE'}`
  );
}

// ═══════════════════════════════════════════
// SECTION 4: Time-windowed analysis
// ═══════════════════════════════════════════
console.log('\n' + '═'.repeat(80));
console.log('SECTION 4: UNION_TOP12@95c — TIME-WINDOWED TRADE COUNTS AND WR');
console.log('═'.repeat(80));

// Load union_top12 strategies
const unionPath = path.join(__dirname, '..', 'debug', 'strategy_set_union_validated_top12.json');
const unionSet = JSON.parse(fs.readFileSync(unionPath, 'utf8'));
const strategies = unionSet.strategies;

function matchStrategy(row, strats, maxPrice, momentumGate, momentumMin) {
  for (const s of strats) {
    const sAsset = String(s.asset || '').toUpperCase();
    const rAsset = String(row.asset || '').toUpperCase();
    if (sAsset !== 'ALL' && sAsset !== '*' && sAsset !== rAsset) continue;
    if (Number(s.utcHour) !== Number(row.utcHour)) continue;
    if (Number(s.entryMinute) !== Number(row.entryMinute)) continue;
    
    const dir = String(s.direction || '').toUpperCase();
    const entryPrice = dir === 'UP' ? Number(row.upPrice) : Number(row.downPrice);
    if (!Number.isFinite(entryPrice)) continue;
    
    const bandMin = Number(s.priceMin) || 0;
    if (entryPrice < bandMin || entryPrice > maxPrice) continue;
    
    // Momentum gate
    if (momentumGate) {
      const trend = dir === 'UP' ? Number(row.upTrend) : Number(row.downTrend);
      if (!Number.isFinite(trend) || trend <= momentumMin) continue;
    }
    
    const win = dir === 'UP' ? row.winnerIsUp : !row.winnerIsUp;
    return { entryPrice, dir, win, stratName: s.name };
  }
  return null;
}

const windows = { '7d': 7, '14d': 14, '30d': 30, '60d': 60, 'full': 153 };
const caps = [0.80, 0.85, 0.90, 0.95, 0.97];

console.log('Window'.padEnd(8) + caps.map(c => `${c*100}c`.padEnd(22)).join(''));

for (const [wName, wDays] of Object.entries(windows)) {
  const cutoff = wName === 'full' ? 0 : lastEpoch - wDays * 86400;
  const wRows = allRows.filter(r => r.cycleStartEpochSec >= cutoff);
  
  let line = wName.padEnd(8);
  for (const cap of caps) {
    let trades = 0, wins = 0;
    const seen = new Set();
    for (const r of wRows) {
      const m = matchStrategy(r, strategies, cap, true, 0.03);
      if (m) {
        const key = `${r.cycleStartEpochSec}_${r.entryMinute}_${r.utcHour}`;
        if (!seen.has(key)) {
          seen.add(key);
          trades++;
          if (m.win) wins++;
        }
      }
    }
    const wr = trades > 0 ? (wins / trades * 100).toFixed(1) : '0.0';
    const tpd = (trades / wDays).toFixed(1);
    line += `${trades}t ${wr}% ${tpd}/d`.padEnd(22);
  }
  console.log(line);
}

// ═══════════════════════════════════════════
// SECTION 5: Momentum gate ON vs OFF
// ═══════════════════════════════════════════
console.log('\n' + '═'.repeat(80));
console.log('SECTION 5: MOMENTUM GATE ON vs OFF (union_top12@95c, full dataset)');
console.log('═'.repeat(80));

for (const gateOn of [true, false]) {
  let trades = 0, wins = 0;
  const seen = new Set();
  for (const r of allRows) {
    const m = matchStrategy(r, strategies, 0.95, gateOn, 0.03);
    if (m) {
      const key = `${r.cycleStartEpochSec}_${r.entryMinute}_${r.utcHour}`;
      if (!seen.has(key)) {
        seen.add(key);
        trades++;
        if (m.win) wins++;
      }
    }
  }
  const wr = trades > 0 ? (wins / trades * 100).toFixed(1) : '0';
  console.log(`Momentum gate ${gateOn ? 'ON ' : 'OFF'}: ${trades} trades, ${wr}% WR, ${(trades/153).toFixed(1)}/day`);
}

// ═══════════════════════════════════════════
// SECTION 6: Test OTHER strategy sets at 95c
// ═══════════════════════════════════════════
console.log('\n' + '═'.repeat(80));
console.log('SECTION 6: ALL AVAILABLE STRATEGY SETS @ 95c (full dataset)');
console.log('═'.repeat(80));

const stratDir = path.join(__dirname, '..', 'debug');
const allSetFiles = fs.readdirSync(stratDir).filter(f => f.startsWith('strategy_set_') && f.endsWith('.json'));

for (const f of allSetFiles) {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(stratDir, f), 'utf8'));
    const strats = j.strategies || [];
    if (strats.length === 0) continue;
    
    const hasMomentum = j.conditions?.applyMomentumGate === true;
    let trades = 0, wins = 0;
    const seen = new Set();
    
    for (const r of allRows) {
      const m = matchStrategy(r, strats, 0.95, hasMomentum, 0.03);
      if (m) {
        const key = `${r.cycleStartEpochSec}_${r.entryMinute}_${r.utcHour}`;
        if (!seen.has(key)) {
          seen.add(key);
          trades++;
          if (m.win) wins++;
        }
      }
    }
    
    if (trades > 0) {
      const wr = (wins / trades * 100).toFixed(1);
      const name = f.replace('strategy_set_', '').replace('.json', '');
      const tpd = (trades / 153).toFixed(1);
      console.log(`${name.padEnd(35)} ${String(strats.length).padEnd(3)}strats ${String(trades).padEnd(6)}trades ${wr.padEnd(5)}% WR ${tpd}/day ${hasMomentum ? 'MOM:ON' : 'MOM:OFF'}`);
    }
  } catch (e) { /* skip bad files */ }
}

// ═══════════════════════════════════════════
// SECTION 7: Bankroll sim for top candidates
// ═══════════════════════════════════════════
console.log('\n' + '═'.repeat(80));
console.log('SECTION 7: BANKROLL SIMULATION — TOP CANDIDATES @ 95c (last 30d + full)');
console.log('═'.repeat(80));

function simBankroll(rows, strats, maxPrice, startBal, stakeFrac, minShares, momentumGate) {
  let balance = startBal;
  let peak = startBal;
  let maxDD = 0;
  let executed = 0, blocked = 0, wins = 0, losses = 0;
  
  const trades = [];
  const seen = new Set();
  for (const r of rows) {
    const m = matchStrategy(r, strats, maxPrice, momentumGate, 0.03);
    if (m) {
      const key = `${r.cycleStartEpochSec}_${r.entryMinute}_${r.utcHour}`;
      if (!seen.has(key)) {
        seen.add(key);
        trades.push(m);
      }
    }
  }
  
  for (const t of trades) {
    const minCost = minShares * t.entryPrice;
    let stake = Math.max(balance * stakeFrac, minCost);
    if (stake > balance) { blocked++; continue; }
    
    executed++;
    const feeRate = 0.02 * t.entryPrice * (1 - t.entryPrice);
    if (t.win) {
      const payout = stake / t.entryPrice;
      const fee = payout * feeRate;
      balance += payout - stake - fee;
      wins++;
    } else {
      const fee = (stake / t.entryPrice) * feeRate;
      balance -= stake + fee;
      losses++;
    }
    
    if (balance > peak) peak = balance;
    const dd = peak > 0 ? (peak - balance) / peak : 0;
    if (dd > maxDD) maxDD = dd;
    if (balance < 0.5) { balance = 0; break; }
  }
  
  return { executed, blocked, wins, losses, end: balance, maxDD, wr: executed > 0 ? wins/executed : 0 };
}

const topSets = [
  { name: 'union_top12', file: 'strategy_set_union_validated_top12.json', mom: true },
  { name: 'top7_drop6', file: 'strategy_set_top7_drop6.json', mom: false },
  { name: 'top3_robust', file: 'strategy_set_top3_robust.json', mom: false },
  { name: 'top5_robust', file: 'strategy_set_top5_robust.json', mom: false },
];

const last30 = allRows.filter(r => r.cycleStartEpochSec >= lastEpoch - 30 * 86400);
const last14 = allRows.filter(r => r.cycleStartEpochSec >= lastEpoch - 14 * 86400);

console.log('\n--- FULL DATASET (153 days) ---');
console.log('Set'.padEnd(20) + 'Cap'.padEnd(6) + 'Exec'.padEnd(7) + 'WR%'.padEnd(7) + 'End$'.padEnd(12) + 'MaxDD%'.padEnd(8));
for (const s of topSets) {
  const strats = JSON.parse(fs.readFileSync(path.join(stratDir, s.file), 'utf8')).strategies;
  for (const cap of [0.90, 0.95]) {
    const r = simBankroll(allRows, strats, cap, 5, 0.45, 5, s.mom);
    console.log(
      `${s.name}`.padEnd(20) + `${cap*100}c`.padEnd(6) +
      `${r.executed}`.padEnd(7) + `${(r.wr*100).toFixed(1)}`.padEnd(7) +
      `$${r.end.toFixed(2)}`.padEnd(12) + `${(r.maxDD*100).toFixed(1)}%`
    );
  }
}

console.log('\n--- LAST 30 DAYS ---');
console.log('Set'.padEnd(20) + 'Cap'.padEnd(6) + 'Exec'.padEnd(7) + 'WR%'.padEnd(7) + 'End$'.padEnd(12) + 'MaxDD%'.padEnd(8));
for (const s of topSets) {
  const strats = JSON.parse(fs.readFileSync(path.join(stratDir, s.file), 'utf8')).strategies;
  for (const cap of [0.90, 0.95]) {
    const r = simBankroll(last30, strats, cap, 5, 0.45, 5, s.mom);
    console.log(
      `${s.name}`.padEnd(20) + `${cap*100}c`.padEnd(6) +
      `${r.executed}`.padEnd(7) + `${(r.wr*100).toFixed(1)}`.padEnd(7) +
      `$${r.end.toFixed(2)}`.padEnd(12) + `${(r.maxDD*100).toFixed(1)}%`
    );
  }
}

console.log('\n--- LAST 14 DAYS ---');
console.log('Set'.padEnd(20) + 'Cap'.padEnd(6) + 'Exec'.padEnd(7) + 'WR%'.padEnd(7) + 'End$'.padEnd(12) + 'MaxDD%'.padEnd(8));
for (const s of topSets) {
  const strats = JSON.parse(fs.readFileSync(path.join(stratDir, s.file), 'utf8')).strategies;
  for (const cap of [0.90, 0.95]) {
    const r = simBankroll(last14, strats, cap, 5, 0.45, 5, s.mom);
    console.log(
      `${s.name}`.padEnd(20) + `${cap*100}c`.padEnd(6) +
      `${r.executed}`.padEnd(7) + `${(r.wr*100).toFixed(1)}`.padEnd(7) +
      `$${r.end.toFixed(2)}`.padEnd(12) + `${(r.maxDD*100).toFixed(1)}%`
    );
  }
}

console.log('\nDone.');
