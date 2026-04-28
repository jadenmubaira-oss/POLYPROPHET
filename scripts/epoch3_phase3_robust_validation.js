#!/usr/bin/env node
/**
 * Epoch 3 Phase 3B: Robust Validation & Deployment Strategy Builder
 * 
 * Takes the best signal families from Phase 3A and:
 * 1. Filters for minimum N≥8 holdout events per signal (anti-cherry-pick)
 * 2. Tests pooled WR robustness at different N thresholds
 * 3. Builds optimal combined signal sets targeting median $500+
 * 4. Generates deployment-ready strategy JSON
 */

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const OUTPUT_DIR = path.join(__dirname, '..', 'epoch3', 'unrestricted');

function loadJSON(filename) {
    const fp = path.join(DATA_DIR, filename);
    if (!fs.existsSync(fp)) return [];
    const raw = JSON.parse(fs.readFileSync(fp, 'utf8'));
    return raw.cycles || raw.data || raw;
}

function priceAt(pricesObj, min) {
    if (!pricesObj) return null;
    const v = pricesObj[String(min)];
    if (v === null || v === undefined) return null;
    if (typeof v === 'object') return v.last || null;
    return v;
}

function getEntryPrice(cycle, entryMin, direction) {
    const yp = cycle.minutePricesYes || cycle.minutePrices || {};
    const np = cycle.minutePricesNo || {};
    if (direction === 'UP') return priceAt(yp, entryMin);
    if (direction === 'DOWN') return priceAt(np, entryMin);
    return null;
}

function getMomentumSignal(cycle) {
    const yp = cycle.minutePricesYes || cycle.minutePrices || {};
    const p0 = priceAt(yp, 0), p3 = priceAt(yp, 3);
    if (!p0 || !p3 || p0 <= 0) return null;
    return (p3 - p0) / p0;
}

function getResolution(cycle) {
    const r = String(cycle.resolution || '').toUpperCase();
    if (r === 'YES' || r === 'UP' || r === 'TRUE' || r === '1') return 'UP';
    if (r === 'NO' || r === 'DOWN' || r === 'FALSE' || r === '0') return 'DOWN';
    return null;
}

function didWin(cycle, direction) {
    const res = getResolution(cycle);
    if (!res) return null;
    return (direction === 'UP' && res === 'UP') || (direction === 'DOWN' && res === 'DOWN');
}

function loadAndSplit(data, trainFrac = 0.65) {
    const sorted = [...data].sort((a, b) => a.epoch - b.epoch);
    const cutoff = Math.floor(sorted.length * trainFrac);
    return { train: sorted.slice(0, cutoff), holdout: sorted.slice(cutoff) };
}

// ============================================================
// ROBUST MINING: per-asset momentum with minimum N filter
// ============================================================

function minePerAssetMomentum(cycles, minHoldoutN = 8) {
    const { train, holdout } = loadAndSplit(cycles);
    const results = [];
    const assets = [...new Set(cycles.map(c => c.asset))];

    for (const asset of assets) {
        const assetTrain = train.filter(c => c.asset === asset);
        const assetHoldout = holdout.filter(c => c.asset === asset);

        for (const dir of ['UP', 'DOWN']) {
            for (const entryMin of [5, 7, 10]) {
                for (let bandLo = 0.15; bandLo <= 0.80; bandLo += 0.05) {
                    for (const bandWidth of [0.15, 0.20, 0.25, 0.30]) {
                        const bandHi = bandLo + bandWidth;
                        if (bandHi > 1.0) continue;

                        for (const momThresh of [0.03, 0.05, 0.08, 0.10, 0.12, 0.15, 0.20, 0.25, 0.30, 0.40]) {
                            const trainMatches = [];
                            const holdoutMatches = [];

                            for (const c of assetTrain) {
                                const mom = getMomentumSignal(c);
                                if (mom === null) continue;
                                if (dir === 'UP' && mom <= momThresh) continue;
                                if (dir === 'DOWN' && mom >= -momThresh) continue;
                                const entry = getEntryPrice(c, entryMin, dir);
                                if (!entry || entry < bandLo || entry > bandHi) continue;
                                const won = didWin(c, dir);
                                if (won === null) continue;
                                trainMatches.push({ won, entry });
                            }

                            for (const c of assetHoldout) {
                                const mom = getMomentumSignal(c);
                                if (mom === null) continue;
                                if (dir === 'UP' && mom <= momThresh) continue;
                                if (dir === 'DOWN' && mom >= -momThresh) continue;
                                const entry = getEntryPrice(c, entryMin, dir);
                                if (!entry || entry < bandLo || entry > bandHi) continue;
                                const won = didWin(c, dir);
                                if (won === null) continue;
                                holdoutMatches.push({ won, entry, epoch: c.epoch, asset: c.asset });
                            }

                            if (trainMatches.length < 5) continue;
                            const trainWR = trainMatches.filter(m => m.won).length / trainMatches.length;
                            if (trainWR < 0.55) continue;

                            if (holdoutMatches.length < minHoldoutN) continue;
                            const holdoutWR = holdoutMatches.filter(m => m.won).length / holdoutMatches.length;
                            const avgEntry = holdoutMatches.reduce((s, m) => s + m.entry, 0) / holdoutMatches.length;
                            const holdoutEV = holdoutWR / avgEntry - 1;
                            if (holdoutEV <= 0) continue;

                            // Wilson LCB at 90% confidence
                            const n = holdoutMatches.length;
                            const z = 1.645;
                            const phat = holdoutWR;
                            const lcb = (phat + z*z/(2*n) - z*Math.sqrt((phat*(1-phat) + z*z/(4*n))/n)) / (1 + z*z/n);

                            results.push({
                                type: 'per_asset_momentum', asset, direction: dir,
                                entryMinute: entryMin, momThresh, bandLo, bandHi: Math.round(bandHi * 100) / 100,
                                trainWR, trainN: trainMatches.length,
                                holdoutWR, holdoutN: n, holdoutEV, avgEntry, lcb,
                                holdoutEvents: holdoutMatches
                            });
                        }
                    }
                }
            }
        }
    }

    results.sort((a, b) => b.holdoutEV - a.holdoutEV);
    return results;
}

// ============================================================
// ROBUST MINING: hour-specific structural with minimum N filter
// ============================================================

function mineHourStructural(cycles, minHoldoutN = 8) {
    const { train, holdout } = loadAndSplit(cycles);
    const results = [];
    const assets = [...new Set(cycles.map(c => c.asset))];

    for (const asset of assets) {
        for (const dir of ['UP', 'DOWN']) {
            for (let hour = 0; hour < 24; hour++) {
                for (const entryMin of [0, 1, 3, 5, 7, 10]) {
                    for (let bandLo = 0.20; bandLo <= 0.80; bandLo += 0.05) {
                        for (const bandWidth of [0.15, 0.20, 0.25, 0.30]) {
                            const bandHi = bandLo + bandWidth;
                            if (bandHi > 1.0) continue;

                            const trainMatches = [];
                            const holdoutMatches = [];

                            for (const c of train.filter(c => c.asset === asset)) {
                                const h = new Date(c.epoch * 1000).getUTCHours();
                                if (h !== hour) continue;
                                const entry = getEntryPrice(c, entryMin, dir);
                                if (!entry || entry < bandLo || entry > bandHi) continue;
                                const won = didWin(c, dir);
                                if (won === null) continue;
                                trainMatches.push({ won, entry });
                            }

                            for (const c of holdout.filter(c => c.asset === asset)) {
                                const h = new Date(c.epoch * 1000).getUTCHours();
                                if (h !== hour) continue;
                                const entry = getEntryPrice(c, entryMin, dir);
                                if (!entry || entry < bandLo || entry > bandHi) continue;
                                const won = didWin(c, dir);
                                if (won === null) continue;
                                holdoutMatches.push({ won, entry, epoch: c.epoch, asset: c.asset });
                            }

                            if (trainMatches.length < 4) continue;
                            const trainWR = trainMatches.filter(m => m.won).length / trainMatches.length;
                            if (trainWR < 0.65) continue;

                            if (holdoutMatches.length < minHoldoutN) continue;
                            const holdoutWR = holdoutMatches.filter(m => m.won).length / holdoutMatches.length;
                            const avgEntry = holdoutMatches.reduce((s, m) => s + m.entry, 0) / holdoutMatches.length;
                            const holdoutEV = holdoutWR / avgEntry - 1;
                            if (holdoutEV <= 0) continue;

                            const n = holdoutMatches.length;
                            const z = 1.645;
                            const phat = holdoutWR;
                            const lcb = (phat + z*z/(2*n) - z*Math.sqrt((phat*(1-phat) + z*z/(4*n))/n)) / (1 + z*z/n);

                            results.push({
                                type: 'hour_structural', asset, direction: dir,
                                hour, entryMinute: entryMin, bandLo, bandHi: Math.round(bandHi * 100) / 100,
                                trainWR, trainN: trainMatches.length,
                                holdoutWR, holdoutN: n, holdoutEV, avgEntry, lcb,
                                holdoutEvents: holdoutMatches
                            });
                        }
                    }
                }
            }
        }
    }

    results.sort((a, b) => b.holdoutEV - a.holdoutEV);
    return results;
}

// ============================================================
// ROBUST MINING: per-asset structural (no hour filter) with min N
// ============================================================

function mineStructural(cycles, minHoldoutN = 8) {
    const { train, holdout } = loadAndSplit(cycles);
    const results = [];
    const assets = [...new Set(cycles.map(c => c.asset))];

    for (const asset of assets) {
        for (const dir of ['UP', 'DOWN']) {
            for (let min = 0; min <= 14; min++) {
                for (let bandLo = 0.20; bandLo <= 0.85; bandLo += 0.05) {
                    for (const bandWidth of [0.10, 0.15, 0.20]) {
                        const bandHi = bandLo + bandWidth;
                        if (bandHi > 1.0) continue;

                        const trainMatches = [];
                        const holdoutMatches = [];

                        for (const c of train.filter(c => c.asset === asset)) {
                            const entry = getEntryPrice(c, min, dir);
                            if (!entry || entry < bandLo || entry > bandHi) continue;
                            const won = didWin(c, dir);
                            if (won === null) continue;
                            trainMatches.push({ won, entry });
                        }

                        for (const c of holdout.filter(c => c.asset === asset)) {
                            const entry = getEntryPrice(c, min, dir);
                            if (!entry || entry < bandLo || entry > bandHi) continue;
                            const won = didWin(c, dir);
                            if (won === null) continue;
                            holdoutMatches.push({ won, entry, epoch: c.epoch, asset: c.asset });
                        }

                        if (trainMatches.length < 8) continue;
                        const trainWR = trainMatches.filter(m => m.won).length / trainMatches.length;
                        if (trainWR < 0.60) continue;

                        if (holdoutMatches.length < minHoldoutN) continue;
                        const holdoutWR = holdoutMatches.filter(m => m.won).length / holdoutMatches.length;
                        const avgEntry = holdoutMatches.reduce((s, m) => s + m.entry, 0) / holdoutMatches.length;
                        const holdoutEV = holdoutWR / avgEntry - 1;
                        if (holdoutEV <= 0) continue;

                        const n = holdoutMatches.length;
                        const z = 1.645;
                        const phat = holdoutWR;
                        const lcb = (phat + z*z/(2*n) - z*Math.sqrt((phat*(1-phat) + z*z/(4*n))/n)) / (1 + z*z/n);

                        results.push({
                            type: 'structural', asset, direction: dir,
                            entryMinute: min, bandLo, bandHi: Math.round(bandHi * 100) / 100,
                            trainWR, trainN: trainMatches.length,
                            holdoutWR, holdoutN: n, holdoutEV, avgEntry, lcb,
                            holdoutEvents: holdoutMatches
                        });
                    }
                }
            }
        }
    }

    results.sort((a, b) => b.holdoutEV - a.holdoutEV);
    return results;
}

// ============================================================
// MC SIMULATION
// ============================================================

function simulateMC(allEvents, config) {
    const { runs, startBalance, stakeFraction, days, tradesPerDay,
            stakingType, tier1Max, tier1Frac, tier2Max, tier2Frac, tier3Frac } = config;
    const maxTrades = Math.ceil(tradesPerDay * days);
    const results = [];

    for (let r = 0; r < runs; r++) {
        let cash = startBalance;
        let trades = 0, wins = 0;

        for (let t = 0; t < maxTrades; t++) {
            if (cash < 1.75) break;

            const ev = allEvents[Math.floor(Math.random() * allEvents.length)];
            if (Math.random() < 0.107) continue;  // no-fill

            const entry = Math.min(0.99, ev.entry + 0.01);  // adverse

            let sf = stakeFraction;
            if (stakingType === 'target_ladder') {
                if (cash < (tier1Max || 50)) sf = tier1Frac || 0.60;
                else if (cash < (tier2Max || 500)) sf = tier2Frac || 0.30;
                else sf = tier3Frac || 0.10;
            }

            const stake = cash * sf;
            if (stake < 1.75) break;
            const shares = Math.floor(stake / entry);
            if (shares < 5) break;
            const actualCost = shares * entry;
            const fee = shares * 0.072 * entry * (1 - entry);

            trades++;
            if (ev.won) {
                wins++;
                cash = cash - actualCost - fee + shares;
            } else {
                cash = cash - actualCost - fee;
            }
        }

        results.push({ finalBalance: cash, trades, wins, wr: trades > 0 ? wins / trades : 0 });
    }

    results.sort((a, b) => a.finalBalance - b.finalBalance);
    const n = results.length;
    return {
        median: results[Math.floor(n * 0.5)].finalBalance,
        p10: results[Math.floor(n * 0.1)].finalBalance,
        p25: results[Math.floor(n * 0.25)].finalBalance,
        p75: results[Math.floor(n * 0.75)].finalBalance,
        p90: results[Math.floor(n * 0.9)].finalBalance,
        p95: results[Math.floor(n * 0.95)].finalBalance,
        max: results[n - 1].finalBalance,
        bust: results.filter(r => r.finalBalance < 1.75).length / n,
        pGte100: results.filter(r => r.finalBalance >= 100).length / n,
        pGte500: results.filter(r => r.finalBalance >= 500).length / n,
        medianTrades: results.sort((a, b) => a.trades - b.trades)[Math.floor(n / 2)].trades,
        avgWR: results.reduce((s, r) => s + r.wr, 0) / n
    };
}

function computeTPD(signals, holdoutDays) {
    const epochKeys = new Set();
    for (const sig of signals) {
        if (!sig.holdoutEvents) continue;
        for (const ev of sig.holdoutEvents) {
            epochKeys.add(`${ev.epoch || ''}|${ev.asset || sig.asset || ''}`);
        }
    }
    return epochKeys.size / holdoutDays;
}

// ============================================================
// GREEDY SIGNAL SET BUILDER
// ============================================================

function buildGreedySet(allSignals, maxSignals, minPoolWR = 0.65) {
    // Greedy: add signal that maximizes pool WR × EV, maintaining min pool WR
    const selected = [];
    const remaining = [...allSignals];
    let poolEvents = [];

    for (let i = 0; i < maxSignals && remaining.length > 0; i++) {
        let bestIdx = -1;
        let bestScore = -Infinity;

        for (let j = 0; j < remaining.length; j++) {
            const candidate = remaining[j];
            const candidateEvents = candidate.holdoutEvents || [];
            const testPool = [...poolEvents, ...candidateEvents];
            const testWR = testPool.filter(e => e.won).length / testPool.length;
            if (testWR < minPoolWR) continue;

            const testAvgEntry = testPool.reduce((s, e) => s + e.entry, 0) / testPool.length;
            const testEV = testWR / testAvgEntry - 1;
            const score = testEV * Math.sqrt(testPool.length);  // EV × sqrt(N) rewards both edge and volume

            if (score > bestScore) {
                bestScore = score;
                bestIdx = j;
            }
        }

        if (bestIdx === -1) break;

        selected.push(remaining[bestIdx]);
        poolEvents = [...poolEvents, ...(remaining[bestIdx].holdoutEvents || [])];
        remaining.splice(bestIdx, 1);
    }

    return selected;
}

// ============================================================
// MAIN
// ============================================================

async function main() {
    console.log('=== EPOCH 3 PHASE 3B: ROBUST VALIDATION ===\n');

    const data15m = loadJSON('intracycle-price-data.json');
    const data5m = loadJSON('intracycle-price-data-5m.json');
    console.log(`Data: 15m=${data15m.length}, 5m=${data5m.length}\n`);

    const holdoutDays = 5.8;

    // ========================
    // MINE WITH STRICT N FILTERS
    // ========================

    console.log('--- Mining per-asset momentum (15m, N≥8) ---');
    const mom15m_n8 = minePerAssetMomentum(data15m, 8);
    console.log(`  Found ${mom15m_n8.length} robust signals`);

    console.log('--- Mining per-asset momentum (15m, N≥15) ---');
    const mom15m_n15 = minePerAssetMomentum(data15m, 15);
    console.log(`  Found ${mom15m_n15.length} robust signals`);

    console.log('--- Mining per-asset momentum (15m, N≥25) ---');
    const mom15m_n25 = minePerAssetMomentum(data15m, 25);
    console.log(`  Found ${mom15m_n25.length} robust signals`);

    console.log('\n--- Mining hour-structural (15m, N≥8) ---');
    const hourStruct15m_n8 = mineHourStructural(data15m, 8);
    console.log(`  Found ${hourStruct15m_n8.length} signals`);

    console.log('--- Mining hour-structural (15m, N≥15) ---');
    const hourStruct15m_n15 = mineHourStructural(data15m, 15);
    console.log(`  Found ${hourStruct15m_n15.length} signals`);

    console.log('\n--- Mining structural (15m, N≥15) ---');
    const struct15m_n15 = mineStructural(data15m, 15);
    console.log(`  Found ${struct15m_n15.length} signals`);

    console.log('\n--- Mining structural (5m, N≥15) ---');
    const struct5m_n15 = mineStructural(data5m, 15);
    console.log(`  Found ${struct5m_n15.length} signals`);

    console.log('--- Mining structural (5m, N≥25) ---');
    const struct5m_n25 = mineStructural(data5m, 25);
    console.log(`  Found ${struct5m_n25.length} signals`);

    console.log('\n--- Mining hour-structural (5m, N≥8) ---');
    const hourStruct5m_n8 = mineHourStructural(data5m, 8);
    console.log(`  Found ${hourStruct5m_n8.length} signals`);

    // ========================
    // DISPLAY TOP SIGNALS AT EACH N THRESHOLD
    // ========================

    console.log('\n=== TOP SIGNALS BY HOLDOUT EV (N≥8) ===\n');
    for (const s of mom15m_n8.slice(0, 15)) {
        console.log(`  ${s.asset} ${s.direction} mom>${(s.momThresh*100).toFixed(0)}% m${s.entryMinute} [${s.bandLo.toFixed(2)}-${s.bandHi}]: WR=${(s.holdoutWR*100).toFixed(1)}% EV=${(s.holdoutEV*100).toFixed(1)}% N=${s.holdoutN} LCB=${(s.lcb*100).toFixed(1)}%`);
    }

    console.log('\n=== TOP SIGNALS BY HOLDOUT EV (N≥15) ===\n');
    for (const s of mom15m_n15.slice(0, 15)) {
        console.log(`  ${s.asset} ${s.direction} mom>${(s.momThresh*100).toFixed(0)}% m${s.entryMinute} [${s.bandLo.toFixed(2)}-${s.bandHi}]: WR=${(s.holdoutWR*100).toFixed(1)}% EV=${(s.holdoutEV*100).toFixed(1)}% N=${s.holdoutN} LCB=${(s.lcb*100).toFixed(1)}%`);
    }

    console.log('\n=== TOP SIGNALS BY HOLDOUT EV (N≥25) ===\n');
    for (const s of mom15m_n25.slice(0, 15)) {
        console.log(`  ${s.asset} ${s.direction} mom>${(s.momThresh*100).toFixed(0)}% m${s.entryMinute} [${s.bandLo.toFixed(2)}-${s.bandHi}]: WR=${(s.holdoutWR*100).toFixed(1)}% EV=${(s.holdoutEV*100).toFixed(1)}% N=${s.holdoutN} LCB=${(s.lcb*100).toFixed(1)}%`);
    }

    // ========================
    // BUILD GREEDY SIGNAL SETS
    // ========================

    console.log('\n=== BUILDING GREEDY SIGNAL SETS ===\n');

    // Combine all robust signals from different families
    const allRobust = [
        ...mom15m_n8,
        ...hourStruct15m_n8.filter(s => s.holdoutWR >= 0.70),
        ...struct15m_n15.filter(s => s.holdoutWR >= 0.70),
    ];
    console.log(`Total robust candidate signals: ${allRobust.length}`);

    // Build greedy sets of various sizes
    const sets = {};
    for (const maxSig of [5, 10, 15, 20, 30, 50]) {
        for (const minWR of [0.65, 0.70, 0.75, 0.80]) {
            const key = `greedy_${maxSig}_wr${(minWR*100).toFixed(0)}`;
            const selected = buildGreedySet(allRobust, maxSig, minWR);
            if (selected.length === 0) continue;

            const events = [];
            for (const sig of selected) {
                for (const ev of (sig.holdoutEvents || [])) events.push(ev);
            }
            const poolWR = events.filter(e => e.won).length / events.length;
            const avgEntry = events.reduce((s, e) => s + e.entry, 0) / events.length;
            const tpd = computeTPD(selected, holdoutDays);

            sets[key] = { signals: selected, events, poolWR, avgEntry, tpd };
            console.log(`  [${key}] ${selected.length} signals, ${events.length} events, poolWR=${(poolWR*100).toFixed(1)}%, avgEntry=$${avgEntry.toFixed(2)}, TPD=${tpd.toFixed(1)}`);
        }
    }

    // Also add raw momentum sets
    for (const [label, sigs] of [
        ['mom_n8_top10', mom15m_n8.slice(0, 10)],
        ['mom_n8_top20', mom15m_n8.slice(0, 20)],
        ['mom_n8_top30', mom15m_n8.slice(0, 30)],
        ['mom_n15_top10', mom15m_n15.slice(0, 10)],
        ['mom_n15_top20', mom15m_n15.slice(0, 20)],
        ['mom_n25_top10', mom15m_n25.slice(0, 10)],
        ['mom_n25_top20', mom15m_n25.slice(0, 20)],
        ['hour_n8_top20', hourStruct15m_n8.filter(s => s.holdoutWR >= 0.75).slice(0, 20)],
        ['hour_n15_top20', hourStruct15m_n15.filter(s => s.holdoutWR >= 0.70).slice(0, 20)],
        ['struct15m_n15_top20', struct15m_n15.filter(s => s.holdoutWR >= 0.70).slice(0, 20)],
        ['struct5m_n15_top20', struct5m_n15.filter(s => s.holdoutWR >= 0.70).slice(0, 20)],
        ['struct5m_n25_top20', struct5m_n25.filter(s => s.holdoutWR >= 0.70).slice(0, 20)],
        ['hour5m_n8_wr80', hourStruct5m_n8.filter(s => s.holdoutWR >= 0.80)],
    ]) {
        if (sigs.length === 0) continue;
        const events = [];
        for (const sig of sigs) {
            for (const ev of (sig.holdoutEvents || [])) events.push(ev);
        }
        if (events.length === 0) continue;
        const poolWR = events.filter(e => e.won).length / events.length;
        const avgEntry = events.reduce((s, e) => s + e.entry, 0) / events.length;
        const tpd = computeTPD(sigs, holdoutDays);
        sets[label] = { signals: sigs, events, poolWR, avgEntry, tpd };
        console.log(`  [${label}] ${sigs.length} signals, ${events.length} events, poolWR=${(poolWR*100).toFixed(1)}%, avgEntry=$${avgEntry.toFixed(2)}, TPD=${tpd.toFixed(1)}`);
    }

    // ========================
    // MC SIMULATION
    // ========================

    console.log('\n=== MC SIMULATION (10,000 runs each) ===\n');

    const stakingConfigs = [
        { name: 'fixed_35', stakeFraction: 0.35, stakingType: 'fixed' },
        { name: 'fixed_40', stakeFraction: 0.40, stakingType: 'fixed' },
        { name: 'fixed_45', stakeFraction: 0.45, stakingType: 'fixed' },
        { name: 'target_30_200', stakeFraction: 0.30, stakingType: 'target_ladder', tier1Max: 30, tier1Frac: 0.50, tier2Max: 200, tier2Frac: 0.35, tier3Frac: 0.15 },
        { name: 'target_50_500', stakeFraction: 0.30, stakingType: 'target_ladder', tier1Max: 50, tier1Frac: 0.55, tier2Max: 500, tier2Frac: 0.35, tier3Frac: 0.15 },
    ];

    const allResults = [];

    for (const [setName, setInfo] of Object.entries(sets)) {
        const { events, poolWR, avgEntry, tpd } = setInfo;
        if (events.length < 10) continue;

        for (const staking of stakingConfigs) {
            for (const startBal of [5, 10]) {
                const mc = simulateMC(events, {
                    runs: 10000,
                    startBalance: startBal,
                    stakeFraction: staking.stakeFraction,
                    days: 7,
                    tradesPerDay: tpd,
                    ...staking
                });

                allResults.push({
                    signalSet: setName, staking: staking.name, startBalance: startBal,
                    poolWR, avgEntry, tpd,
                    numSignals: setInfo.signals.length, numEvents: events.length,
                    ...mc
                });
            }
        }
    }

    // ========================
    // RANKINGS
    // ========================

    console.log('\n====== TOP 30 BY MEDIAN ======\n');
    allResults.sort((a, b) => b.median - a.median);
    for (let i = 0; i < Math.min(30, allResults.length); i++) {
        const r = allResults[i];
        console.log(`${String(i + 1).padStart(2)}. [${r.signalSet}] ${r.staking} $${r.startBalance}`);
        console.log(`    median=$${r.median.toFixed(2)} bust=${(r.bust*100).toFixed(1)}% P≥$100=${(r.pGte100*100).toFixed(1)}% P≥$500=${(r.pGte500*100).toFixed(1)}%`);
        console.log(`    p10=$${r.p10.toFixed(2)} p25=$${r.p25.toFixed(2)} p75=$${r.p75.toFixed(2)} p90=$${r.p90.toFixed(2)}`);
        console.log(`    poolWR=${(r.poolWR*100).toFixed(1)}% avgEntry=$${r.avgEntry.toFixed(2)} tpd=${r.tpd.toFixed(1)} medTrades=${r.medianTrades} avgWR=${(r.avgWR*100).toFixed(1)}%`);
    }

    // Best median per set (for summary)
    console.log('\n====== BEST MEDIAN PER SIGNAL SET ($10 start) ======\n');
    const bySet = {};
    for (const r of allResults) {
        if (r.startBalance !== 10) continue;
        if (!bySet[r.signalSet] || r.median > bySet[r.signalSet].median) {
            bySet[r.signalSet] = r;
        }
    }
    const setResults = Object.values(bySet).sort((a, b) => b.median - a.median);
    for (const r of setResults) {
        console.log(`  [${r.signalSet}] ${r.staking}: median=$${r.median.toFixed(2)} bust=${(r.bust*100).toFixed(1)}% P≥$500=${(r.pGte500*100).toFixed(1)}% poolWR=${(r.poolWR*100).toFixed(1)}% tpd=${r.tpd.toFixed(1)}`);
    }

    // ========================
    // SAVE RESULTS
    // ========================

    // Find best config
    const bestResult = allResults.filter(r => r.startBalance === 10 && r.median >= 500).sort((a, b) => b.median - a.median)[0];

    if (bestResult) {
        console.log(`\n\n★★★ BEST MEDIAN $500+ CONFIG ★★★`);
        console.log(`  Signal set: ${bestResult.signalSet}`);
        console.log(`  Staking: ${bestResult.staking}`);
        console.log(`  Median: $${bestResult.median.toFixed(2)}`);
        console.log(`  Bust: ${(bestResult.bust*100).toFixed(1)}%`);
        console.log(`  P≥$500: ${(bestResult.pGte500*100).toFixed(1)}%`);
        console.log(`  Pool WR: ${(bestResult.poolWR*100).toFixed(1)}%`);
        console.log(`  Avg Entry: $${bestResult.avgEntry.toFixed(2)}`);
        console.log(`  TPD: ${bestResult.tpd.toFixed(1)}`);

        // Build deployment strategy
        const bestSet = sets[bestResult.signalSet];
        const deploymentSignals = bestSet.signals.map((s, i) => ({
            id: `phase3_${i + 1}`,
            type: s.type,
            asset: s.asset,
            direction: s.direction,
            entryMinute: s.entryMinute,
            momThresh: s.momThresh,
            hour: s.hour,
            bandLo: s.bandLo,
            bandHi: s.bandHi,
            holdoutWR: s.holdoutWR,
            holdoutEV: s.holdoutEV,
            holdoutN: s.holdoutN,
            lcb: s.lcb,
            avgEntry: s.avgEntry,
            timeframe: data15m.length > 0 ? '15m' : '5m'
        }));

        const strategySet = {
            version: 'epoch3_phase3_robust',
            generatedAt: new Date().toISOString(),
            description: `Robust median $500+ strategy: ${bestResult.signalSet} + ${bestResult.staking}`,
            bestConfiguration: {
                signalSet: bestResult.signalSet,
                stakingStrategy: bestResult.staking,
                from10_7d: {
                    median: bestResult.median,
                    bust: bestResult.bust,
                    pGte100: bestResult.pGte100,
                    pGte500: bestResult.pGte500,
                    p10: bestResult.p10,
                    p25: bestResult.p25,
                    p75: bestResult.p75,
                    p90: bestResult.p90,
                    medianTrades: bestResult.medianTrades,
                    avgWR: bestResult.avgWR
                },
                poolStats: {
                    poolWR: bestResult.poolWR,
                    avgEntry: bestResult.avgEntry,
                    tpd: bestResult.tpd,
                    numSignals: bestResult.numSignals,
                    numEvents: bestResult.numEvents
                }
            },
            strategies: deploymentSignals,
            validation: {
                method: 'walk-forward 65/35 chronological split',
                trainPeriod: 'Apr 11-20, 2026',
                holdoutPeriod: 'Apr 20-26, 2026',
                holdoutDays: 5.8,
                minHoldoutN: 8,
                mcRuns: 10000,
                friction: '10.7% no-fill, $0.01 adverse, 5-share min, $1.75 min order, exact fee model'
            }
        };

        const strategyPath = path.join(__dirname, '..', 'strategies', 'strategy_set_epoch3_phase3.json');
        fs.writeFileSync(strategyPath, JSON.stringify(strategySet, null, 2));
        console.log(`\nStrategy set saved to ${strategyPath}`);
    }

    const outputPath = path.join(OUTPUT_DIR, 'epoch3_phase3_robust_results.json');
    fs.writeFileSync(outputPath, JSON.stringify({
        timestamp: new Date().toISOString(),
        totalConfigs: allResults.length,
        top30byMedian: allResults.sort((a, b) => b.median - a.median).slice(0, 30),
        bestPerSet: setResults,
        signalCounts: {
            mom15m_n8: mom15m_n8.length,
            mom15m_n15: mom15m_n15.length,
            mom15m_n25: mom15m_n25.length,
            hourStruct15m_n8: hourStruct15m_n8.length,
            hourStruct15m_n15: hourStruct15m_n15.length,
            struct15m_n15: struct15m_n15.length,
            struct5m_n15: struct5m_n15.length,
            struct5m_n25: struct5m_n25.length,
            hourStruct5m_n8: hourStruct5m_n8.length,
        }
    }, null, 2));
    console.log(`Results saved to ${outputPath}`);
}

main().catch(console.error);
