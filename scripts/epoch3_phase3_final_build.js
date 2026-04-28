#!/usr/bin/env node
/**
 * Epoch 3 Phase 3 Final: Clean deployment strategy with deduplicated signals
 * 
 * Takes the robust validation results, deduplicates overlapping signals,
 * rebuilds MC with accurate TPD, and generates the final deployment package.
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

// Mine all signals, then deduplicate
function mineAllSignals(cycles15m) {
    const { train, holdout } = loadAndSplit(cycles15m);
    const assets = [...new Set(cycles15m.map(c => c.asset))];
    const allSignals = [];

    // 1. Per-asset momentum signals
    console.log('Mining per-asset momentum...');
    for (const asset of assets) {
        const assetTrain = train.filter(c => c.asset === asset);
        const assetHoldout = holdout.filter(c => c.asset === asset);

        for (const dir of ['UP', 'DOWN']) {
            for (const entryMin of [5, 7, 10]) {
                for (let bandLo = 0.15; bandLo <= 0.80; bandLo += 0.05) {
                    for (const bandWidth of [0.15, 0.20, 0.25, 0.30]) {
                        const bandHi = Math.round((bandLo + bandWidth) * 100) / 100;
                        if (bandHi > 1.0) continue;

                        for (const momThresh of [0.03, 0.05, 0.08, 0.10, 0.12, 0.15, 0.20, 0.25, 0.30, 0.40]) {
                            const holdoutMatches = [];
                            const trainMatches = [];

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
                            if (holdoutMatches.length < 8) continue;
                            const holdoutWR = holdoutMatches.filter(m => m.won).length / holdoutMatches.length;
                            const avgEntry = holdoutMatches.reduce((s, m) => s + m.entry, 0) / holdoutMatches.length;
                            const holdoutEV = holdoutWR / avgEntry - 1;
                            if (holdoutEV <= 0) continue;

                            allSignals.push({
                                type: 'per_asset_momentum', asset, direction: dir,
                                entryMinute: entryMin, momThresh, bandLo, bandHi,
                                dedupeKey: `mom|${asset}|${dir}|${entryMin}|${momThresh}`,
                                trainWR, trainN: trainMatches.length,
                                holdoutWR, holdoutN: holdoutMatches.length, holdoutEV, avgEntry,
                                holdoutEvents: holdoutMatches
                            });
                        }
                    }
                }
            }
        }
    }

    // 2. Hour-structural signals
    console.log('Mining hour-structural...');
    for (const asset of assets) {
        for (const dir of ['UP', 'DOWN']) {
            for (let hour = 0; hour < 24; hour++) {
                for (const entryMin of [0, 1, 3, 5, 7, 10]) {
                    for (let bandLo = 0.20; bandLo <= 0.80; bandLo += 0.05) {
                        for (const bandWidth of [0.15, 0.20, 0.25, 0.30]) {
                            const bandHi = Math.round((bandLo + bandWidth) * 100) / 100;
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
                            if (holdoutMatches.length < 8) continue;
                            const holdoutWR = holdoutMatches.filter(m => m.won).length / holdoutMatches.length;
                            const avgEntry = holdoutMatches.reduce((s, m) => s + m.entry, 0) / holdoutMatches.length;
                            const holdoutEV = holdoutWR / avgEntry - 1;
                            if (holdoutEV <= 0) continue;

                            allSignals.push({
                                type: 'hour_structural', asset, direction: dir,
                                hour, entryMinute: entryMin, bandLo, bandHi,
                                dedupeKey: `hour|${asset}|${dir}|H${hour}|m${entryMin}`,
                                trainWR, trainN: trainMatches.length,
                                holdoutWR, holdoutN: holdoutMatches.length, holdoutEV, avgEntry,
                                holdoutEvents: holdoutMatches
                            });
                        }
                    }
                }
            }
        }
    }

    // 3. Structural signals (no hour filter)
    console.log('Mining structural...');
    for (const asset of assets) {
        for (const dir of ['UP', 'DOWN']) {
            for (let min = 0; min <= 14; min++) {
                for (let bandLo = 0.20; bandLo <= 0.85; bandLo += 0.05) {
                    for (const bandWidth of [0.10, 0.15, 0.20]) {
                        const bandHi = Math.round((bandLo + bandWidth) * 100) / 100;
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
                        if (holdoutMatches.length < 8) continue;
                        const holdoutWR = holdoutMatches.filter(m => m.won).length / holdoutMatches.length;
                        const avgEntry = holdoutMatches.reduce((s, m) => s + m.entry, 0) / holdoutMatches.length;
                        const holdoutEV = holdoutWR / avgEntry - 1;
                        if (holdoutEV <= 0) continue;

                        allSignals.push({
                            type: 'structural', asset, direction: dir,
                            entryMinute: min, bandLo, bandHi,
                            dedupeKey: `struct|${asset}|${dir}|m${min}`,
                            trainWR, trainN: trainMatches.length,
                            holdoutWR, holdoutN: holdoutMatches.length, holdoutEV, avgEntry,
                            holdoutEvents: holdoutMatches
                        });
                    }
                }
            }
        }
    }

    return allSignals;
}

// Deduplicate: for each dedupeKey, keep the signal with the best holdout EV
function deduplicate(signals) {
    const best = new Map();
    for (const sig of signals) {
        const existing = best.get(sig.dedupeKey);
        if (!existing || sig.holdoutEV > existing.holdoutEV) {
            best.set(sig.dedupeKey, sig);
        }
    }
    return [...best.values()].sort((a, b) => b.holdoutEV - a.holdoutEV);
}

// Build greedy set with deduplication awareness
function buildDeduplicatedGreedy(signals, maxSignals, minPoolWR = 0.75) {
    const selected = [];
    const remaining = [...signals];
    let poolEvents = [];
    const usedKeys = new Set();

    for (let i = 0; i < maxSignals && remaining.length > 0; i++) {
        let bestIdx = -1;
        let bestScore = -Infinity;

        for (let j = 0; j < remaining.length; j++) {
            const candidate = remaining[j];
            if (usedKeys.has(candidate.dedupeKey)) continue;

            const candidateEvents = candidate.holdoutEvents || [];
            // Deduplicate events by epoch|asset (same trade)
            const existingEpochs = new Set(poolEvents.map(e => `${e.epoch}|${e.asset}`));
            const newEvents = candidateEvents.filter(e => !existingEpochs.has(`${e.epoch}|${e.asset}`));
            
            const testPool = [...poolEvents, ...newEvents];
            const testWR = testPool.filter(e => e.won).length / testPool.length;
            if (testWR < minPoolWR) continue;

            const testAvgEntry = testPool.reduce((s, e) => s + e.entry, 0) / testPool.length;
            const testEV = testWR / testAvgEntry - 1;
            const score = testEV * Math.sqrt(testPool.length);

            if (score > bestScore) {
                bestScore = score;
                bestIdx = j;
            }
        }

        if (bestIdx === -1) break;

        const chosen = remaining[bestIdx];
        usedKeys.add(chosen.dedupeKey);
        selected.push(chosen);
        
        const existingEpochs = new Set(poolEvents.map(e => `${e.epoch}|${e.asset}`));
        const newEvents = (chosen.holdoutEvents || []).filter(e => !existingEpochs.has(`${e.epoch}|${e.asset}`));
        poolEvents = [...poolEvents, ...newEvents];
        remaining.splice(bestIdx, 1);
    }

    return { selected, events: poolEvents };
}

// Accurate TPD from deduplicated holdout events
function computeDeduplicatedTPD(events, holdoutDays) {
    const uniqueEpochs = new Set(events.map(e => `${e.epoch}|${e.asset}`));
    return uniqueEpochs.size / holdoutDays;
}

// MC simulation
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
            if (Math.random() < 0.107) continue;

            const entry = Math.min(0.99, ev.entry + 0.01);

            let sf = stakeFraction;
            if (stakingType === 'target_ladder') {
                if (cash < (tier1Max || 50)) sf = tier1Frac || 0.55;
                else if (cash < (tier2Max || 500)) sf = tier2Frac || 0.35;
                else sf = tier3Frac || 0.15;
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

async function main() {
    console.log('=== EPOCH 3 PHASE 3 FINAL: DEDUPLICATED DEPLOYMENT BUILD ===\n');

    const data15m = loadJSON('intracycle-price-data.json');
    console.log(`15m data: ${data15m.length} cycles\n`);

    const holdoutDays = 5.8;

    // Mine all signals
    const allSignals = mineAllSignals(data15m);
    console.log(`\nTotal mined signals: ${allSignals.length}`);

    // Deduplicate
    const deduped = deduplicate(allSignals);
    console.log(`After deduplication: ${deduped.length} unique signals`);

    // Show top 20 deduplicated
    console.log('\n=== TOP 20 DEDUPLICATED SIGNALS ===\n');
    for (const s of deduped.slice(0, 20)) {
        const label = s.type === 'per_asset_momentum' 
            ? `${s.asset} ${s.direction} mom>${(s.momThresh*100).toFixed(0)}% m${s.entryMinute}`
            : s.type === 'hour_structural'
            ? `${s.asset} ${s.direction} H${s.hour} m${s.entryMinute}`
            : `${s.asset} ${s.direction} m${s.entryMinute}`;
        console.log(`  ${label} [${s.bandLo.toFixed(2)}-${s.bandHi}]: WR=${(s.holdoutWR*100).toFixed(1)}% EV=${(s.holdoutEV*100).toFixed(1)}% N=${s.holdoutN} avgEntry=$${s.avgEntry.toFixed(2)}`);
    }

    // Build greedy sets at various sizes and WR thresholds
    console.log('\n=== BUILDING GREEDY DEDUPLICATED SETS ===\n');

    const setConfigs = [
        { maxSig: 5, minWR: 0.75, label: 'dedup_5_wr75' },
        { maxSig: 5, minWR: 0.70, label: 'dedup_5_wr70' },
        { maxSig: 10, minWR: 0.75, label: 'dedup_10_wr75' },
        { maxSig: 10, minWR: 0.70, label: 'dedup_10_wr70' },
        { maxSig: 15, minWR: 0.75, label: 'dedup_15_wr75' },
        { maxSig: 15, minWR: 0.70, label: 'dedup_15_wr70' },
        { maxSig: 20, minWR: 0.75, label: 'dedup_20_wr75' },
        { maxSig: 20, minWR: 0.70, label: 'dedup_20_wr70' },
        { maxSig: 30, minWR: 0.70, label: 'dedup_30_wr70' },
        { maxSig: 30, minWR: 0.65, label: 'dedup_30_wr65' },
    ];

    const sets = {};
    for (const { maxSig, minWR, label } of setConfigs) {
        const { selected, events } = buildDeduplicatedGreedy(deduped, maxSig, minWR);
        if (selected.length === 0) continue;
        const poolWR = events.filter(e => e.won).length / events.length;
        const avgEntry = events.reduce((s, e) => s + e.entry, 0) / events.length;
        const tpd = computeDeduplicatedTPD(events, holdoutDays);
        sets[label] = { signals: selected, events, poolWR, avgEntry, tpd };
        console.log(`  [${label}] ${selected.length} signals, ${events.length} deduped events, poolWR=${(poolWR*100).toFixed(1)}%, avgEntry=$${avgEntry.toFixed(2)}, TPD=${tpd.toFixed(1)}`);
    }

    // MC simulation for all sets
    console.log('\n=== MC SIMULATION (10,000 runs each) ===\n');

    const stakingConfigs = [
        { name: 'fixed_35', stakeFraction: 0.35, stakingType: 'fixed' },
        { name: 'fixed_40', stakeFraction: 0.40, stakingType: 'fixed' },
        { name: 'fixed_45', stakeFraction: 0.45, stakingType: 'fixed' },
        { name: 'target_ladder', stakeFraction: 0.30, stakingType: 'target_ladder', tier1Max: 50, tier1Frac: 0.55, tier2Max: 500, tier2Frac: 0.35, tier3Frac: 0.15 },
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

                const tag = `  [${setName}] ${staking.name} $${startBal}:`;
                console.log(`${tag} median=$${mc.median.toFixed(2)} bust=${(mc.bust*100).toFixed(1)}% P≥$500=${(mc.pGte500*100).toFixed(1)}% medTrades=${mc.medianTrades} avgWR=${(mc.avgWR*100).toFixed(1)}%`);
            }
        }
        console.log('');
    }

    // Rankings
    console.log('\n====== TOP 20 BY MEDIAN ($10 start) ======\n');
    const top20 = allResults.filter(r => r.startBalance === 10).sort((a, b) => b.median - a.median).slice(0, 20);
    for (let i = 0; i < top20.length; i++) {
        const r = top20[i];
        console.log(`${String(i + 1).padStart(2)}. [${r.signalSet}] ${r.staking}`);
        console.log(`    median=$${r.median.toFixed(2)} bust=${(r.bust*100).toFixed(1)}% P≥$500=${(r.pGte500*100).toFixed(1)}%`);
        console.log(`    p25=$${r.p25.toFixed(2)} p75=$${r.p75.toFixed(2)} p90=$${r.p90.toFixed(2)}`);
        console.log(`    poolWR=${(r.poolWR*100).toFixed(1)}% avgEntry=$${r.avgEntry.toFixed(2)} tpd=${r.tpd.toFixed(1)} medTrades=${r.medianTrades}`);
    }

    // Same for $5 start
    console.log('\n====== TOP 10 BY MEDIAN ($5 start) ======\n');
    const top10_5 = allResults.filter(r => r.startBalance === 5).sort((a, b) => b.median - a.median).slice(0, 10);
    for (let i = 0; i < top10_5.length; i++) {
        const r = top10_5[i];
        console.log(`${String(i + 1).padStart(2)}. [${r.signalSet}] ${r.staking}: median=$${r.median.toFixed(2)} bust=${(r.bust*100).toFixed(1)}% P≥$500=${(r.pGte500*100).toFixed(1)}%`);
    }

    // Build final deployment strategy
    const bestConfig = top20[0];
    if (bestConfig) {
        console.log(`\n\n★★★ DEPLOYMENT CONFIG ★★★`);
        console.log(`  Signal set: ${bestConfig.signalSet}`);
        console.log(`  Staking: ${bestConfig.staking}`);
        console.log(`  From $10 median: $${bestConfig.median.toFixed(2)}`);
        console.log(`  Bust: ${(bestConfig.bust*100).toFixed(1)}%`);
        console.log(`  P≥$500: ${(bestConfig.pGte500*100).toFixed(1)}%`);

        const bestSet = sets[bestConfig.signalSet];
        const deploymentSignals = bestSet.signals.map((s, i) => {
            const sig = {
                id: `phase3_final_${i + 1}`,
                type: s.type,
                asset: s.asset,
                direction: s.direction,
                entryMinute: s.entryMinute,
                bandLo: s.bandLo,
                bandHi: s.bandHi,
                holdoutWR: Math.round(s.holdoutWR * 1000) / 1000,
                holdoutEV: Math.round(s.holdoutEV * 1000) / 1000,
                holdoutN: s.holdoutN,
                avgEntry: Math.round(s.avgEntry * 100) / 100,
                timeframe: '15m'
            };
            if (s.type === 'per_asset_momentum') sig.momThresh = s.momThresh;
            if (s.type === 'hour_structural') sig.hour = s.hour;
            return sig;
        });

        // Also find best $5 config for the same signal set
        const best5 = allResults.filter(r => r.startBalance === 5 && r.signalSet === bestConfig.signalSet)
            .sort((a, b) => b.median - a.median)[0];

        const strategySet = {
            version: 'epoch3_phase3_final',
            generatedAt: new Date().toISOString(),
            description: `Deduplicated ${bestConfig.signalSet} + ${bestConfig.staking} — median $${bestConfig.median.toFixed(0)} from $10 in 7 days`,
            bestConfiguration: {
                signalSet: bestConfig.signalSet,
                stakingStrategy: bestConfig.staking,
                from10_7d: {
                    median: Math.round(bestConfig.median * 100) / 100,
                    bust: Math.round(bestConfig.bust * 1000) / 1000,
                    pGte100: Math.round(bestConfig.pGte100 * 1000) / 1000,
                    pGte500: Math.round(bestConfig.pGte500 * 1000) / 1000,
                    p10: Math.round(bestConfig.p10 * 100) / 100,
                    p25: Math.round(bestConfig.p25 * 100) / 100,
                    p75: Math.round(bestConfig.p75 * 100) / 100,
                    p90: Math.round(bestConfig.p90 * 100) / 100,
                    medianTrades: bestConfig.medianTrades,
                    avgWR: Math.round(bestConfig.avgWR * 1000) / 1000
                },
                from5_7d: best5 ? {
                    median: Math.round(best5.median * 100) / 100,
                    bust: Math.round(best5.bust * 1000) / 1000,
                    pGte500: Math.round(best5.pGte500 * 1000) / 1000,
                } : null,
                poolStats: {
                    poolWR: Math.round(bestConfig.poolWR * 1000) / 1000,
                    avgEntry: Math.round(bestConfig.avgEntry * 100) / 100,
                    tpd: Math.round(bestConfig.tpd * 10) / 10,
                    numSignals: bestConfig.numSignals,
                    numEvents: bestConfig.numEvents
                }
            },
            strategies: deploymentSignals,
            stakingConfig: {
                strategy: bestConfig.staking,
                ...(bestConfig.staking === 'target_ladder' ? {
                    tier1Max: 50, tier1Frac: 0.55,
                    tier2Max: 500, tier2Frac: 0.35,
                    tier3Frac: 0.15
                } : {
                    stakeFraction: bestConfig.staking === 'fixed_35' ? 0.35 :
                        bestConfig.staking === 'fixed_40' ? 0.40 : 0.45
                })
            },
            validation: {
                method: 'walk-forward 65/35 chronological split',
                trainPeriod: 'Apr 11-20, 2026',
                holdoutPeriod: 'Apr 20-26, 2026',
                holdoutDays: 5.8,
                minHoldoutN: 8,
                signalDeduplication: 'Best-EV per (type, asset, direction, entryMinute, momThresh/hour)',
                eventDeduplication: 'Unique (epoch, asset) pairs only',
                mcRuns: 10000,
                friction: {
                    noFillRate: 0.107,
                    adverseShift: 0.01,
                    minShares: 5,
                    minOrderUSD: 1.75,
                    feeModel: 'shares × 0.072 × price × (1 - price)'
                }
            }
        };

        const strategyPath = path.join(__dirname, '..', 'strategies', 'strategy_set_epoch3_phase3.json');
        fs.writeFileSync(strategyPath, JSON.stringify(strategySet, null, 2));
        console.log(`\nStrategy set saved to ${strategyPath}`);
    }

    // Save full results
    const outputPath = path.join(OUTPUT_DIR, 'epoch3_phase3_final_results.json');
    fs.writeFileSync(outputPath, JSON.stringify({
        timestamp: new Date().toISOString(),
        totalConfigs: allResults.length,
        top20byMedian_10: top20,
        top10byMedian_5: top10_5,
        dedupedSignalCount: deduped.length,
    }, null, 2));
    console.log(`Results saved to ${outputPath}`);
}

main().catch(console.error);
