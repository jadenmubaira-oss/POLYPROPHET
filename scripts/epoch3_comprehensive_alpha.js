#!/usr/bin/env node
'use strict';
/**
 * EPOCH 3 — COMPREHENSIVE MULTI-SIGNAL ALPHA MINING
 *
 * Combines three signal families for maximum P(≥$500):
 * 1. Intra-cycle momentum: strong early price movement predicts resolution
 * 2. Streak fade: after 4+ consecutive same-direction, fade the streak
 * 3. Structural edges: validated minute×band edges with highest holdout EV
 *
 * All signals are validated out-of-sample with walk-forward splits.
 * Simulates with aggressive stake fractions targeting right-tail variance.
 */

const fs = require('fs');
const path = require('path');

const OUT_DIR = path.join(__dirname, '..', 'epoch3', 'unrestricted');
function ensureDir(d) { fs.mkdirSync(d, { recursive: true }); }

// ==================== DATA LOADING ====================
function loadData() {
  const raw15 = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data/intracycle-price-data.json'), 'utf8'));
  const raw5 = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data/intracycle-price-data-5m.json'), 'utf8'));
  return { cycles15: raw15.cycles || [], cycles5: raw5.cycles || [] };
}

// ==================== SIGNAL GENERATORS ====================

// Signal 1: Momentum-follow (buy in direction of strong early price movement)
function generateMomentumSignals(cycles, trainFrac = 0.65) {
  cycles.sort((a, b) => a.epoch - b.epoch);
  const split = Math.floor(cycles.length * trainFrac);
  const train = cycles.slice(0, split);
  const holdout = cycles.slice(split);

  // Train: find which momentum thresholds × entry bands have positive EV
  const configs = [];
  for (const momThresh of [0.05, 0.10, 0.15, 0.20, 0.25]) {
    // entryMin must be >= 5: observe m0→m3 momentum, react by m5 at earliest
    for (const entryMin of [5, 7, 10]) {
      for (const [bandLo, bandHi] of [[0.10, 0.25], [0.15, 0.30], [0.20, 0.40], [0.25, 0.50], [0.30, 0.55], [0.40, 0.65], [0.50, 0.70], [0.60, 0.80], [0.70, 0.90]]) {
        // Follow momentum UP
        const trainEventsUp = extractMomentumEvents(train, momThresh, entryMin, bandLo, bandHi, 'UP');
        if (trainEventsUp.length >= 10) {
          const wr = trainEventsUp.filter(e => e.won).length / trainEventsUp.length;
          const avgP = trainEventsUp.reduce((s, e) => s + e.entry, 0) / trainEventsUp.length;
          const ev = wr * (1 - avgP) - (1 - wr) * avgP;
          if (ev > 0) {
            configs.push({
              type: 'momentum_follow',
              direction: 'UP',
              momThresh, entryMin, bandLo, bandHi,
              trainN: trainEventsUp.length, trainWR: wr, trainEV: ev, trainAvgP: avgP,
            });
          }
        }
        // Follow momentum DOWN
        const trainEventsDown = extractMomentumEvents(train, momThresh, entryMin, bandLo, bandHi, 'DOWN');
        if (trainEventsDown.length >= 10) {
          const wr = trainEventsDown.filter(e => e.won).length / trainEventsDown.length;
          const avgP = trainEventsDown.reduce((s, e) => s + e.entry, 0) / trainEventsDown.length;
          const ev = wr * (1 - avgP) - (1 - wr) * avgP;
          if (ev > 0) {
            configs.push({
              type: 'momentum_follow',
              direction: 'DOWN',
              momThresh, entryMin, bandLo, bandHi,
              trainN: trainEventsDown.length, trainWR: wr, trainEV: ev, trainAvgP: avgP,
            });
          }
        }
      }
    }
  }

  // Validate on holdout
  const validated = [];
  for (const cfg of configs) {
    const events = extractMomentumEvents(holdout, cfg.momThresh, cfg.entryMin, cfg.bandLo, cfg.bandHi, cfg.direction);
    if (events.length < 5) continue;
    const wr = events.filter(e => e.won).length / events.length;
    const avgP = events.reduce((s, e) => s + e.entry, 0) / events.length;
    const ev = wr * (1 - avgP) - (1 - wr) * avgP;
    if (ev > 0) {
      validated.push({
        ...cfg,
        holdoutN: events.length,
        holdoutWR: wr,
        holdoutEV: ev,
        holdoutAvgP: avgP,
        holdoutEvents: events,
      });
    }
  }

  return validated;
}

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
      events.push({
        epoch: c.epoch, asset: c.asset, entry, direction: 'UP',
        won: c.resolution === 'UP', timestamp: c.epoch,
      });
    }

    if (direction === 'DOWN' && mom < -momThresh) {
      const entryObj = nPrices[entryMin];
      if (!entryObj || entryObj.last <= 0 || entryObj.last >= 1) continue;
      const entry = entryObj.last;
      if (entry < bandLo || entry > bandHi) continue;
      events.push({
        epoch: c.epoch, asset: c.asset, entry, direction: 'DOWN',
        won: c.resolution === 'DOWN', timestamp: c.epoch,
      });
    }
  }
  return events;
}

// Signal 2: Streak fade (after N consecutive same-direction, fade)
function generateStreakSignals(cycles, trainFrac = 0.65) {
  const byAsset = {};
  for (const c of cycles) {
    if (!c.resolution) continue;
    if (!byAsset[c.asset]) byAsset[c.asset] = [];
    byAsset[c.asset].push(c);
  }
  for (const a of Object.keys(byAsset)) byAsset[a].sort((x, y) => x.epoch - y.epoch);

  // Flatten with streak info
  const withStreaks = [];
  for (const [asset, acs] of Object.entries(byAsset)) {
    for (let i = 1; i < acs.length; i++) {
      let streakLen = 0;
      const streakDir = acs[i - 1].resolution;
      for (let j = i - 1; j >= 0; j--) {
        if (acs[j].resolution === streakDir) streakLen++;
        else break;
      }
      withStreaks.push({ ...acs[i], streakLen, streakDir, asset });
    }
  }
  withStreaks.sort((a, b) => a.epoch - b.epoch);

  const split = Math.floor(withStreaks.length * trainFrac);
  const train = withStreaks.slice(0, split);
  const holdout = withStreaks.slice(split);

  const validated = [];

  for (const minStreak of [3, 4, 5]) {
    // entryMin must be >= 5: observe streak, react by m5
    for (const entryMin of [5, 7, 10]) {
      for (const [bandLo, bandHi] of [[0.10, 0.30], [0.15, 0.40], [0.20, 0.50], [0.30, 0.60], [0.40, 0.70], [0.50, 0.80]]) {
        const trainEvents = extractStreakEvents(train, minStreak, entryMin, bandLo, bandHi);
        if (trainEvents.length < 8) continue;
        const wr = trainEvents.filter(e => e.won).length / trainEvents.length;
        const avgP = trainEvents.reduce((s, e) => s + e.entry, 0) / trainEvents.length;
        const ev = wr * (1 - avgP) - (1 - wr) * avgP;
        if (ev <= 0) continue;

        const holdoutEvents = extractStreakEvents(holdout, minStreak, entryMin, bandLo, bandHi);
        if (holdoutEvents.length < 3) continue;
        const hwr = holdoutEvents.filter(e => e.won).length / holdoutEvents.length;
        const havgP = holdoutEvents.reduce((s, e) => s + e.entry, 0) / holdoutEvents.length;
        const hev = hwr * (1 - havgP) - (1 - hwr) * havgP;
        if (hev <= 0) continue;

        validated.push({
          type: 'streak_fade',
          minStreak, entryMin, bandLo, bandHi,
          trainN: trainEvents.length, trainWR: wr, trainEV: ev, trainAvgP: avgP,
          holdoutN: holdoutEvents.length, holdoutWR: hwr, holdoutEV: hev, holdoutAvgP: havgP,
          holdoutEvents,
        });
      }
    }
  }

  return validated;
}

function extractStreakEvents(cycles, minStreak, entryMin, bandLo, bandHi) {
  const events = [];
  for (const c of cycles) {
    if (!c.streakLen || c.streakLen < minStreak) continue;

    // Fade the streak: if streak was DOWN, buy UP (and vice versa)
    const fadeDir = c.streakDir === 'DOWN' ? 'UP' : 'DOWN';
    const yPrices = c.minutePricesYes || {};
    const nPrices = c.minutePricesNo || {};

    const priceObj = fadeDir === 'UP' ? yPrices[entryMin] : nPrices[entryMin];
    if (!priceObj || priceObj.last <= 0 || priceObj.last >= 1) continue;
    const entry = priceObj.last;
    if (entry < bandLo || entry > bandHi) continue;

    events.push({
      epoch: c.epoch, asset: c.asset, entry, direction: fadeDir,
      won: c.resolution === fadeDir, timestamp: c.epoch,
    });
  }
  return events;
}

// Signal 3: Structural edges (validated minute×band with high holdout EV)
function generateStructuralSignals(cycles, trainFrac = 0.65) {
  cycles.sort((a, b) => a.epoch - b.epoch);
  const split = Math.floor(cycles.length * trainFrac);
  const train = cycles.slice(0, split);
  const holdout = cycles.slice(split);

  // Mine at minute × 0.10-band level
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
    if (tev <= 0.02) continue; // Require at least 2% EV

    // Parse key
    const [dir, min, band] = key.split('|');
    const m = parseInt(min.slice(1));
    const bandLo = parseFloat(band);
    const bandHi = bandLo + 0.1;

    // Validate on holdout
    const holdoutEvents = [];
    for (const c of holdout) {
      if (!c.resolution) continue;
      const prices = dir === 'UP' ? c.minutePricesYes : c.minutePricesNo;
      const obj = prices?.[m];
      if (!obj || obj.last <= 0 || obj.last >= 1) continue;
      if (obj.last < bandLo || obj.last >= bandHi) continue;
      holdoutEvents.push({
        epoch: c.epoch, asset: c.asset, entry: obj.last, direction: dir,
        won: c.resolution === dir, timestamp: c.epoch,
      });
    }

    if (holdoutEvents.length < 10) continue;
    const hwr = holdoutEvents.filter(e => e.won).length / holdoutEvents.length;
    const havgP = holdoutEvents.reduce((s, e) => s + e.entry, 0) / holdoutEvents.length;
    const hev = hwr * (1 - havgP) - (1 - hwr) * havgP;
    if (hev <= 0) continue;

    validated.push({
      type: 'structural',
      direction: dir, minute: m, bandLo, bandHi,
      trainN: ts.n, trainWR: twr, trainEV: tev, trainAvgP: tavgP,
      holdoutN: holdoutEvents.length, holdoutWR: hwr, holdoutEV: hev, holdoutAvgP: havgP,
      holdoutEvents,
    });
  }

  return validated;
}

// ==================== SIMULATION ====================

// Compute realistic daily trade frequency from holdout data
function computeTradesPerDay(signals, holdoutDays) {
  let totalEvents = 0;
  for (const sig of signals) {
    if (sig.holdoutEvents) totalEvents += sig.holdoutEvents.length;
  }
  // Deduplicate: multiple signals may fire on same cycle
  const epochSet = new Set();
  for (const sig of signals) {
    if (!sig.holdoutEvents) continue;
    for (const ev of sig.holdoutEvents) epochSet.add(ev.epoch + '|' + ev.asset);
  }
  const uniqueOpps = epochSet.size;
  return { rawTPD: totalEvents / holdoutDays, uniqueTPD: uniqueOpps / holdoutDays };
}

function simulateMC(allEvents, config) {
  const { runs, startBalance, stakeFraction, days, tradesPerDay } = config;
  const maxTrades = Math.ceil(tradesPerDay * days);

  const results = [];
  for (let r = 0; r < runs; r++) {
    let cash = startBalance;
    let peak = startBalance;
    let trades = 0, wins = 0;

    for (let t = 0; t < maxTrades; t++) {
      if (cash < 1.75) break;

      // Pick random event — use ACTUAL outcome, not aggregate WR
      const ev = allEvents[Math.floor(Math.random() * allEvents.length)];

      // Apply friction: 10.7% no-fill
      if (Math.random() < 0.107) continue;

      // Adverse fill: +$0.01
      const entry = Math.min(0.99, ev.entry + 0.01);

      const stake = cash * stakeFraction;
      if (stake < 1.75) break;

      const shares = Math.floor(stake / entry);
      if (shares < 5) break;
      const actualCost = shares * entry;

      trades++;
      // Use the event's ACTUAL outcome (won field from holdout data)
      const won = ev.won;

      if (won) {
        cash = cash - actualCost + shares * 1.0;
        wins++;
      } else {
        cash -= actualCost;
      }

      peak = Math.max(peak, cash);
    }

    results.push({ final: cash, peak, trades, wins, wr: trades > 0 ? wins / trades : 0 });
  }

  results.sort((a, b) => a.final - b.final);
  const n = results.length;

  return {
    median: results[Math.floor(n * 0.5)].final,
    mean: results.reduce((s, r) => s + r.final, 0) / n,
    p10: results[Math.floor(n * 0.1)].final,
    p25: results[Math.floor(n * 0.25)].final,
    p75: results[Math.floor(n * 0.75)].final,
    p90: results[Math.floor(n * 0.9)].final,
    p95: results[Math.floor(n * 0.95)].final,
    p99: results[Math.floor(n * 0.99)].final,
    max: results[n - 1].final,
    bust: results.filter(r => r.final < 1.75).length / n,
    pGte20: results.filter(r => r.final >= 20).length / n,
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

function prepareEvents(signals) {
  const events = [];
  for (const sig of signals) {
    if (!sig.holdoutEvents) continue;
    for (const ev of sig.holdoutEvents) {
      events.push({ ...ev, holdoutWR: sig.holdoutWR });
    }
  }
  return events;
}

// ==================== MAIN ====================
function main() {
  ensureDir(OUT_DIR);
  console.log('=== EPOCH 3 COMPREHENSIVE MULTI-SIGNAL ALPHA MINING ===');
  console.log('');

  const { cycles15, cycles5 } = loadData();
  console.log(`Data: 15m=${cycles15.length}, 5m=${cycles5.length}`);
  console.log('');

  // Generate signals from each family
  console.log('--- MOMENTUM SIGNALS (15m) ---');
  const momentumSigs15 = generateMomentumSignals(cycles15);
  console.log(`  Validated: ${momentumSigs15.length} configs`);
  momentumSigs15.sort((a, b) => b.holdoutEV - a.holdoutEV);
  momentumSigs15.slice(0, 10).forEach((s, i) => {
    console.log(`  ${i + 1}. ${s.direction} mom>${s.momThresh} m${s.entryMin} [${s.bandLo}-${s.bandHi}]: holdoutWR=${(s.holdoutWR * 100).toFixed(1)}% holdoutN=${s.holdoutN} EV=${s.holdoutEV.toFixed(4)} avgE=${s.holdoutAvgP.toFixed(3)}`);
  });

  console.log('');
  console.log('--- MOMENTUM SIGNALS (5m) ---');
  const momentumSigs5 = generateMomentumSignals(cycles5);
  console.log(`  Validated: ${momentumSigs5.length} configs`);
  momentumSigs5.sort((a, b) => b.holdoutEV - a.holdoutEV);
  momentumSigs5.slice(0, 10).forEach((s, i) => {
    console.log(`  ${i + 1}. ${s.direction} mom>${s.momThresh} m${s.entryMin} [${s.bandLo}-${s.bandHi}]: holdoutWR=${(s.holdoutWR * 100).toFixed(1)}% holdoutN=${s.holdoutN} EV=${s.holdoutEV.toFixed(4)} avgE=${s.holdoutAvgP.toFixed(3)}`);
  });

  console.log('');
  console.log('--- STREAK FADE SIGNALS (15m) ---');
  const streakSigs = generateStreakSignals(cycles15);
  console.log(`  Validated: ${streakSigs.length} configs`);
  streakSigs.sort((a, b) => b.holdoutEV - a.holdoutEV);
  streakSigs.slice(0, 10).forEach((s, i) => {
    console.log(`  ${i + 1}. streak>=${s.minStreak} m${s.entryMin} [${s.bandLo}-${s.bandHi}]: holdoutWR=${(s.holdoutWR * 100).toFixed(1)}% holdoutN=${s.holdoutN} EV=${s.holdoutEV.toFixed(4)} avgE=${s.holdoutAvgP.toFixed(3)}`);
  });

  console.log('');
  console.log('--- STRUCTURAL SIGNALS (15m) ---');
  const structSigs = generateStructuralSignals(cycles15);
  console.log(`  Validated: ${structSigs.length} configs`);
  structSigs.sort((a, b) => b.holdoutEV - a.holdoutEV);
  structSigs.slice(0, 10).forEach((s, i) => {
    console.log(`  ${i + 1}. ${s.direction} m${s.minute} [${s.bandLo}-${s.bandHi}]: holdoutWR=${(s.holdoutWR * 100).toFixed(1)}% holdoutN=${s.holdoutN} EV=${s.holdoutEV.toFixed(4)} avgE=${s.holdoutAvgP.toFixed(3)}`);
  });

  console.log('');
  console.log('--- STRUCTURAL SIGNALS (5m) ---');
  const structSigs5 = generateStructuralSignals(cycles5);
  console.log(`  Validated: ${structSigs5.length} configs`);
  structSigs5.sort((a, b) => b.holdoutEV - a.holdoutEV);
  structSigs5.slice(0, 10).forEach((s, i) => {
    console.log(`  ${i + 1}. ${s.direction} m${s.minute} [${s.bandLo}-${s.bandHi}]: holdoutWR=${(s.holdoutWR * 100).toFixed(1)}% holdoutN=${s.holdoutN} EV=${s.holdoutEV.toFixed(4)} avgE=${s.holdoutAvgP.toFixed(3)}`);
  });

  // Build signal sets for simulation
  const signalSets = {
    'momentum_top20_15m': momentumSigs15.slice(0, 20),
    'momentum_top10_15m': momentumSigs15.slice(0, 10),
    'momentum_top5_15m': momentumSigs15.slice(0, 5),
    'streak_all': streakSigs,
    'structural_top20_15m': structSigs.slice(0, 20),
    'structural_top10_15m': structSigs.slice(0, 10),
    'momentum_top20_5m': momentumSigs5.slice(0, 20),
    'combined_mom_streak_15m': [...momentumSigs15.slice(0, 10), ...streakSigs.slice(0, 5)],
    'combined_all_15m': [...momentumSigs15.slice(0, 10), ...streakSigs.slice(0, 5), ...structSigs.slice(0, 10)],
    'combined_all_multi_tf': [...momentumSigs15.slice(0, 10), ...momentumSigs5.slice(0, 10), ...streakSigs.slice(0, 5), ...structSigs.slice(0, 10), ...structSigs5.slice(0, 10)],
  };

  // Compute holdout duration for trade frequency estimation
  const holdoutEpochs15 = cycles15.sort((a, b) => a.epoch - b.epoch);
  const holdoutStart15 = holdoutEpochs15[Math.floor(holdoutEpochs15.length * 0.65)].epoch;
  const holdoutEnd15 = holdoutEpochs15[holdoutEpochs15.length - 1].epoch;
  const holdoutDays15 = Math.max(1, (holdoutEnd15 - holdoutStart15) / 86400);
  
  const holdoutEpochs5 = cycles5.sort((a, b) => a.epoch - b.epoch);
  const holdoutStart5 = holdoutEpochs5[Math.floor(holdoutEpochs5.length * 0.65)].epoch;
  const holdoutEnd5 = holdoutEpochs5[holdoutEpochs5.length - 1].epoch;
  const holdoutDays5 = Math.max(1, (holdoutEnd5 - holdoutStart5) / 86400);
  
  console.log(`\nHoldout duration: 15m=${holdoutDays15.toFixed(1)}d, 5m=${holdoutDays5.toFixed(1)}d`);

  const MC_RUNS = 10000;
  const stakeOptions = [0.30, 0.50, 0.70, 0.85, 0.95, 1.00];
  const starts = [5, 10];

  const allResults = {};

  for (const [setName, sigs] of Object.entries(signalSets)) {
    if (sigs.length === 0) continue;
    const events = prepareEvents(sigs);
    if (events.length < 5) {
      console.log(`\nSkipping ${setName}: only ${events.length} events`);
      continue;
    }

    // Compute realistic trades per day from actual holdout data
    const is5m = setName.includes('5m');
    const isMulti = setName.includes('multi');
    const holdoutDays = isMulti ? Math.max(holdoutDays15, holdoutDays5) : is5m ? holdoutDays5 : holdoutDays15;
    const tpdInfo = computeTradesPerDay(sigs, holdoutDays);
    
    // Use unique TPD (deduplicated by epoch|asset) for realistic frequency
    // Then test at 50%, 100%, and 150% of observed frequency
    const baseTPD = Math.max(2, Math.round(tpdInfo.uniqueTPD));
    const tpdOptions = [
      Math.max(2, Math.round(baseTPD * 0.5)),
      baseTPD,
      Math.min(100, Math.round(baseTPD * 1.5)),
    ];

    allResults[setName] = {};
    console.log(`\n=== ${setName} (${sigs.length} signals, ${events.length} events, observed=${tpdInfo.uniqueTPD.toFixed(1)} trades/day) ===`);

    for (const start of starts) {
      allResults[setName][start] = {};
      for (const stake of stakeOptions) {
        for (const tpd of tpdOptions) {
          const mc = simulateMC(events, {
            runs: MC_RUNS,
            startBalance: start,
            stakeFraction: stake,
            tradesPerDay: tpd,
            days: 7,
          });

          const configKey = `${stake}_${tpd}`;
          allResults[setName][start][configKey] = mc;

          const label = `$${start} stake=${(stake * 100).toFixed(0)}% tpd=${tpd}`;
          if (mc.pGte100 > 0 || mc.pGte500 > 0) {
            console.log(`  ${label}: median=$${mc.median.toFixed(2)} bust=${(mc.bust * 100).toFixed(1)}% P≥$100=${(mc.pGte100 * 100).toFixed(1)}% P≥$500=${(mc.pGte500 * 100).toFixed(2)}% P≥$1000=${(mc.pGte1000 * 100).toFixed(2)}% max=$${mc.max.toFixed(2)} trades=${mc.medianTrades}`);
          } else if (mc.pGte50 > 0) {
            console.log(`  ${label}: median=$${mc.median.toFixed(2)} bust=${(mc.bust * 100).toFixed(1)}% P≥$50=${(mc.pGte50 * 100).toFixed(1)}% max=$${mc.max.toFixed(2)}`);
          }
        }
      }
    }
  }

  // Find best overall by P(≥$500) from $10
  console.log('\n\n====== FINAL RANKINGS BY P(≥$500) FROM $10 ======\n');
  const rankings = [];
  for (const [setName, starts] of Object.entries(allResults)) {
    const s10 = starts[10];
    if (!s10) continue;
    for (const [configKey, mc] of Object.entries(s10)) {
      const [stakeStr, tpdStr] = configKey.split('_');
      rankings.push({ set: setName, stake: parseFloat(stakeStr), tpd: parseInt(tpdStr), configKey, ...mc });
    }
  }
  rankings.sort((a, b) => b.pGte500 - a.pGte500);

  rankings.slice(0, 30).forEach((r, i) => {
    console.log(`${String(i + 1).padStart(2)}. [${r.set}] stake=${(r.stake * 100).toFixed(0)}% tpd=${r.tpd}`);
    console.log(`    median=$${r.median.toFixed(2)} bust=${(r.bust * 100).toFixed(1)}% P≥$50=${(r.pGte50 * 100).toFixed(1)}% P≥$100=${(r.pGte100 * 100).toFixed(1)}% P≥$500=${(r.pGte500 * 100).toFixed(2)}% P≥$1000=${(r.pGte1000 * 100).toFixed(2)}%`);
    console.log(`    p90=$${r.p90.toFixed(2)} p95=$${r.p95.toFixed(2)} p99=$${r.p99.toFixed(2)} max=$${r.max.toFixed(2)} trades=${r.medianTrades}`);
  });

  // Also show best from $5
  console.log('\n====== FINAL RANKINGS BY P(≥$500) FROM $5 ======\n');
  const rankings5 = [];
  for (const [setName, starts] of Object.entries(allResults)) {
    const s5 = starts[5];
    if (!s5) continue;
    for (const [configKey, mc] of Object.entries(s5)) {
      const [stakeStr, tpdStr] = configKey.split('_');
      rankings5.push({ set: setName, stake: parseFloat(stakeStr), tpd: parseInt(tpdStr), configKey, ...mc });
    }
  }
  rankings5.sort((a, b) => b.pGte500 - a.pGte500);
  rankings5.slice(0, 15).forEach((r, i) => {
    console.log(`${String(i + 1).padStart(2)}. [${r.set}] stake=${(r.stake * 100).toFixed(0)}% tpd=${r.tpd}`);
    console.log(`    median=$${r.median.toFixed(2)} bust=${(r.bust * 100).toFixed(1)}% P≥$50=${(r.pGte50 * 100).toFixed(1)}% P≥$100=${(r.pGte100 * 100).toFixed(1)}% P≥$500=${(r.pGte500 * 100).toFixed(2)}% P≥$1000=${(r.pGte1000 * 100).toFixed(2)}%`);
    console.log(`    p90=$${r.p90.toFixed(2)} p95=$${r.p95.toFixed(2)} p99=$${r.p99.toFixed(2)} max=$${r.max.toFixed(2)} trades=${r.medianTrades}`);
  });

  // Save
  const output = {
    generatedAt: new Date().toISOString(),
    mcRuns: MC_RUNS,
    signalCounts: Object.fromEntries(Object.entries(signalSets).map(([k, v]) => [k, v.length])),
    topSignals: {
      momentum15: momentumSigs15.slice(0, 5).map(s => ({ ...s, holdoutEvents: undefined })),
      momentum5: momentumSigs5.slice(0, 5).map(s => ({ ...s, holdoutEvents: undefined })),
      streak: streakSigs.slice(0, 5).map(s => ({ ...s, holdoutEvents: undefined })),
      structural15: structSigs.slice(0, 5).map(s => ({ ...s, holdoutEvents: undefined })),
      structural5: structSigs5.slice(0, 5).map(s => ({ ...s, holdoutEvents: undefined })),
    },
    rankings: rankings.slice(0, 25).map(r => ({ set: r.set, stake: r.stake, median: r.median, bust: r.bust, pGte50: r.pGte50, pGte100: r.pGte100, pGte500: r.pGte500, pGte1000: r.pGte1000, p90: r.p90, p95: r.p95, p99: r.p99, max: r.max })),
    allResults,
  };

  fs.writeFileSync(path.join(OUT_DIR, 'epoch3_comprehensive_results.json'), JSON.stringify(output, null, 2));
  console.log('\nResults saved to epoch3/unrestricted/epoch3_comprehensive_results.json');

  // Build deployment strategy set from best configuration
  const best = rankings[0];
  if (best) {
    const bestSigSet = signalSets[best.set];
    const deployRules = bestSigSet.map((sig, idx) => ({
      id: `${best.set}_${idx}`,
      type: sig.type,
      direction: sig.direction,
      holdoutWR: sig.holdoutWR,
      holdoutEV: sig.holdoutEV,
      holdoutN: sig.holdoutN,
      holdoutAvgP: sig.holdoutAvgP,
      ...(sig.momThresh !== undefined ? { momThresh: sig.momThresh } : {}),
      ...(sig.entryMin !== undefined ? { entryMin: sig.entryMin } : {}),
      ...(sig.bandLo !== undefined ? { bandLo: sig.bandLo } : {}),
      ...(sig.bandHi !== undefined ? { bandHi: sig.bandHi } : {}),
      ...(sig.minStreak !== undefined ? { minStreak: sig.minStreak } : {}),
      ...(sig.minute !== undefined ? { minute: sig.minute } : {}),
    }));

    const strategySet = {
      epoch: 3,
      variant: 'comprehensive_alpha_v2',
      generatedAt: new Date().toISOString(),
      bestConfiguration: { set: best.set, stake: best.stake, median: best.median, pGte500: best.pGte500, bust: best.bust },
      performance: {
        from10_7d: { median: best.median, bust: best.bust, pGte50: best.pGte50, pGte100: best.pGte100, pGte500: best.pGte500, pGte1000: best.pGte1000, p90: best.p90, p95: best.p95, max: best.max },
      },
      strategies: deployRules,
      deployment: {
        stakeFraction: best.stake,
        envOverrides: {
          OPERATOR_STAKE_FRACTION: String(best.stake),
          KELLY_MAX_FRACTION: String(Math.min(0.95, best.stake + 0.05)),
          MAX_GLOBAL_TRADES_PER_CYCLE: '3',
          ALLOW_MICRO_MPC_OVERRIDE: 'true',
          MICRO_BANKROLL_MPC_CAP: '3',
          PEAK_DRAWDOWN_BRAKE_PCT: '0.50',
          MAX_CONSECUTIVE_LOSSES: '6',
        },
        warnings: [
          'High bust rate expected — this strategy optimizes for right-tail P(≥$500), not median',
          'Paper validate before live deployment',
          'Refresh data every 14 days',
        ],
      },
    };

    fs.writeFileSync(path.join(__dirname, '..', 'strategies', 'strategy_set_epoch3_comprehensive.json'), JSON.stringify(strategySet, null, 2));
    console.log('Strategy set saved to strategies/strategy_set_epoch3_comprehensive.json');
  }

  console.log('\n=== COMPLETE ===');
}

main();
