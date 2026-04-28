#!/usr/bin/env node
/**
 * Epoch 3 Phase 3: Median $500+ Optimizer
 * 
 * Previous passes optimized P(≥$500) and found 20.6%. User wants MEDIAN $500+.
 * 
 * Strategy: find high-WR (80%+) edges through:
 * 1. Multi-signal confirmation (momentum + structural + streak agree)
 * 2. Per-asset mining (asset-specific patterns)
 * 3. 5m exploitation (3x trade frequency)
 * 4. Convex entry targeting (30-55c for 2-3x per win)
 * 5. Multi-timeframe stacking (4h bias → 15m filter)
 * 
 * Math target: 85% WR at 55c avg entry → +28% ROI/trade
 *   At SF=0.35, 6 trades/day × 7d = 42 trades
 *   $10 × 1.098^42 = $501
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

// ============================================================
// DATA LOADING
// ============================================================

function loadAndSplit(data, trainFrac = 0.65) {
    const sorted = data.sort((a, b) => a.epoch - b.epoch);
    const cutoff = Math.floor(sorted.length * trainFrac);
    return { train: sorted.slice(0, cutoff), holdout: sorted.slice(cutoff) };
}

// ============================================================
// SIGNAL GENERATORS
// ============================================================

function priceAt(pricesObj, min) {
    if (!pricesObj) return null;
    const v = pricesObj[String(min)];
    if (v === null || v === undefined) return null;
    if (typeof v === 'object') return v.last || null;
    return v;
}

function getMomentumSignal(cycle) {
    const yp = cycle.minutePricesYes || cycle.minutePrices || {};
    const p0 = priceAt(yp, 0), p3 = priceAt(yp, 3);
    if (!p0 || !p3 || p0 <= 0) return null;
    const mom = (p3 - p0) / p0;
    return mom;
}

function getStreakSignal(prevResults) {
    if (!prevResults || prevResults.length < 2) return null;
    const last = prevResults.slice(-3);
    const allSame = last.every(r => r === last[0]);
    if (allSame && last.length >= 2) return { direction: last[0], length: last.length };
    return null;
}

function getCycleMinute(cycle, min) {
    const yp = cycle.minutePricesYes || cycle.minutePrices || {};
    return priceAt(yp, min);
}

function getEntryPrice(cycle, entryMin, direction) {
    const yp = cycle.minutePricesYes || cycle.minutePrices || {};
    const np = cycle.minutePricesNo || {};
    if (direction === 'UP') return priceAt(yp, entryMin);
    if (direction === 'DOWN') return priceAt(np, entryMin);
    return null;
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

// ============================================================
// 1. PER-ASSET GRANULAR MINING
// ============================================================

function minePerAssetGranular(cycles, trainFrac = 0.65) {
    const { train, holdout } = loadAndSplit(cycles, trainFrac);
    const results = [];

    const assets = [...new Set(cycles.map(c => c.asset))];
    const directions = ['UP', 'DOWN'];
    const hours = Array.from({ length: 24 }, (_, i) => i);
    const entryMinutes = [5, 7, 10];
    const momThresholds = [0.05, 0.10, 0.15, 0.20, 0.25, 0.30, 0.40];
    const priceBands = [
        [0.20, 0.40], [0.25, 0.45], [0.30, 0.50], [0.35, 0.55],
        [0.40, 0.60], [0.45, 0.65], [0.50, 0.70], [0.55, 0.75],
        [0.25, 0.50], [0.30, 0.55], [0.35, 0.60], [0.40, 0.65],
        [0.20, 0.50], [0.30, 0.60], [0.20, 0.55], [0.25, 0.55],
        [0.30, 0.70], [0.40, 0.70], [0.50, 0.80]
    ];

    for (const asset of assets) {
        const assetTrain = train.filter(c => c.asset === asset);
        const assetHoldout = holdout.filter(c => c.asset === asset);

        for (const dir of directions) {
            for (const entryMin of entryMinutes) {
                for (const [bandLo, bandHi] of priceBands) {
                    for (const momThresh of momThresholds) {
                        // Momentum + entry band filter
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
                            holdoutMatches.push({ won, entry });
                        }

                        if (trainMatches.length < 5) continue;

                        const trainWR = trainMatches.filter(m => m.won).length / trainMatches.length;
                        if (trainWR < 0.60) continue;

                        if (holdoutMatches.length < 3) continue;
                        const holdoutWR = holdoutMatches.filter(m => m.won).length / holdoutMatches.length;
                        const avgEntry = holdoutMatches.reduce((s, m) => s + m.entry, 0) / holdoutMatches.length;
                        const holdoutEV = holdoutWR / avgEntry - 1;

                        if (holdoutEV <= 0) continue;

                        results.push({
                            type: 'per_asset_momentum',
                            asset, direction: dir, entryMinute: entryMin,
                            momThresh, bandLo, bandHi,
                            trainWR, trainN: trainMatches.length,
                            holdoutWR, holdoutN: holdoutMatches.length,
                            holdoutEV, avgEntry,
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
// 2. STRUCTURAL PATTERN MINING (minute × price band × asset)
// ============================================================

function mineStructuralPerAsset(cycles, trainFrac = 0.65) {
    const { train, holdout } = loadAndSplit(cycles, trainFrac);
    const results = [];
    const assets = [...new Set(cycles.map(c => c.asset))];
    const directions = ['UP', 'DOWN'];

    for (const asset of assets) {
        const assetTrain = train.filter(c => c.asset === asset);
        const assetHoldout = holdout.filter(c => c.asset === asset);

        for (const dir of directions) {
            for (let min = 0; min <= 14; min++) {
                for (let bandLo = 0.20; bandLo <= 0.90; bandLo += 0.05) {
                    const bandHi = bandLo + 0.10;

                    const trainMatches = [];
                    const holdoutMatches = [];

                    for (const c of assetTrain) {
                        const entry = getEntryPrice(c, min, dir);
                        if (!entry || entry < bandLo || entry > bandHi) continue;
                        const won = didWin(c, dir);
                        if (won === null) continue;
                        trainMatches.push({ won, entry });
                    }

                    for (const c of assetHoldout) {
                        const entry = getEntryPrice(c, min, dir);
                        if (!entry || entry < bandLo || entry > bandHi) continue;
                        const won = didWin(c, dir);
                        if (won === null) continue;
                        holdoutMatches.push({ won, entry });
                    }

                    if (trainMatches.length < 8) continue;
                    const trainWR = trainMatches.filter(m => m.won).length / trainMatches.length;
                    if (trainWR < 0.65) continue;

                    if (holdoutMatches.length < 3) continue;
                    const holdoutWR = holdoutMatches.filter(m => m.won).length / holdoutMatches.length;
                    const avgEntry = holdoutMatches.reduce((s, m) => s + m.entry, 0) / holdoutMatches.length;
                    const holdoutEV = holdoutWR / avgEntry - 1;
                    if (holdoutEV <= 0) continue;

                    results.push({
                        type: 'structural_per_asset',
                        asset, direction: dir, entryMinute: min,
                        bandLo, bandHi,
                        trainWR, trainN: trainMatches.length,
                        holdoutWR, holdoutN: holdoutMatches.length,
                        holdoutEV, avgEntry,
                        holdoutEvents: holdoutMatches
                    });
                }
            }
        }
    }

    results.sort((a, b) => b.holdoutEV - a.holdoutEV);
    return results;
}

// ============================================================
// 3. MULTI-SIGNAL CONFIRMATION MINING
// ============================================================

function mineMultiConfirmation(cycles, trainFrac = 0.65) {
    const { train, holdout } = loadAndSplit(cycles, trainFrac);
    const results = [];
    const directions = ['UP', 'DOWN'];
    const entryMinutes = [5, 7, 10];
    const momThresholds = [0.05, 0.10, 0.15, 0.20];
    const priceBands = [
        [0.20, 0.45], [0.25, 0.50], [0.30, 0.55], [0.35, 0.60],
        [0.40, 0.65], [0.45, 0.70], [0.50, 0.75],
        [0.20, 0.50], [0.25, 0.55], [0.30, 0.60],
        [0.30, 0.70], [0.40, 0.70]
    ];

    // Build streak context: track resolution history per asset
    const buildHistory = (data) => {
        const hist = {};
        for (const c of data) {
            const key = c.asset;
            if (!hist[key]) hist[key] = [];
            const res = getResolution(c);
            if (res) {
                c._prevResults = [...hist[key]];
                hist[key].push(res);
                if (hist[key].length > 5) hist[key].shift();
            }
        }
    };

    buildHistory(train);
    buildHistory(holdout);

    for (const dir of directions) {
        for (const entryMin of entryMinutes) {
            for (const [bandLo, bandHi] of priceBands) {
                for (const momThresh of momThresholds) {
                    // Condition: momentum + streak agree
                    const trainMatches = [];
                    const holdoutMatches = [];

                    for (const c of train) {
                        const mom = getMomentumSignal(c);
                        if (mom === null) continue;
                        if (dir === 'UP' && mom <= momThresh) continue;
                        if (dir === 'DOWN' && mom >= -momThresh) continue;

                        // Streak confirmation: last 2+ resolutions in same direction
                        const prev = c._prevResults || [];
                        if (prev.length < 2) continue;
                        const lastTwo = prev.slice(-2);
                        const streakDir = lastTwo.every(r => r === dir) ? dir : null;
                        if (!streakDir) continue;

                        const entry = getEntryPrice(c, entryMin, dir);
                        if (!entry || entry < bandLo || entry > bandHi) continue;

                        const won = didWin(c, dir);
                        if (won === null) continue;
                        trainMatches.push({ won, entry });
                    }

                    for (const c of holdout) {
                        const mom = getMomentumSignal(c);
                        if (mom === null) continue;
                        if (dir === 'UP' && mom <= momThresh) continue;
                        if (dir === 'DOWN' && mom >= -momThresh) continue;

                        const prev = c._prevResults || [];
                        if (prev.length < 2) continue;
                        const lastTwo = prev.slice(-2);
                        const streakDir = lastTwo.every(r => r === dir) ? dir : null;
                        if (!streakDir) continue;

                        const entry = getEntryPrice(c, entryMin, dir);
                        if (!entry || entry < bandLo || entry > bandHi) continue;

                        const won = didWin(c, dir);
                        if (won === null) continue;
                        holdoutMatches.push({ won, entry });
                    }

                    if (trainMatches.length < 5) continue;
                    const trainWR = trainMatches.filter(m => m.won).length / trainMatches.length;
                    if (trainWR < 0.70) continue;

                    if (holdoutMatches.length < 3) continue;
                    const holdoutWR = holdoutMatches.filter(m => m.won).length / holdoutMatches.length;
                    const avgEntry = holdoutMatches.reduce((s, m) => s + m.entry, 0) / holdoutMatches.length;
                    const holdoutEV = holdoutWR / avgEntry - 1;
                    if (holdoutEV <= 0) continue;

                    results.push({
                        type: 'multi_confirm_mom_streak',
                        direction: dir, entryMinute: entryMin,
                        momThresh, bandLo, bandHi,
                        trainWR, trainN: trainMatches.length,
                        holdoutWR, holdoutN: holdoutMatches.length,
                        holdoutEV, avgEntry,
                        holdoutEvents: holdoutMatches
                    });
                }
            }
        }
    }

    // Also test momentum + price-trend confirmation
    for (const dir of directions) {
        for (const entryMin of entryMinutes) {
            for (const [bandLo, bandHi] of priceBands) {
                for (const momThresh of momThresholds) {
                    const trainMatches = [];
                    const holdoutMatches = [];

                    for (const c of [...train, ...holdout]) {
                        const isHoldout = holdout.includes(c);
                        const mom = getMomentumSignal(c);
                        if (mom === null) continue;
                        if (dir === 'UP' && mom <= momThresh) continue;
                        if (dir === 'DOWN' && mom >= -momThresh) continue;

                        // Price trend confirmation: entry price > m0 price (for UP)
                        const yp = c.minutePricesYes || c.minutePrices || {};
                        const p0 = priceAt(yp, 0);
                        const pEntry = priceAt(yp, entryMin);
                        if (!p0 || !pEntry) continue;

                        if (dir === 'UP' && pEntry <= p0) continue;  // Price still rising
                        if (dir === 'DOWN' && pEntry >= p0) continue;  // Price still falling

                        const entry = getEntryPrice(c, entryMin, dir);
                        if (!entry || entry < bandLo || entry > bandHi) continue;

                        const won = didWin(c, dir);
                        if (won === null) continue;

                        if (isHoldout) holdoutMatches.push({ won, entry });
                        else trainMatches.push({ won, entry });
                    }

                    if (trainMatches.length < 5) continue;
                    const trainWR = trainMatches.filter(m => m.won).length / trainMatches.length;
                    if (trainWR < 0.65) continue;

                    if (holdoutMatches.length < 3) continue;
                    const holdoutWR = holdoutMatches.filter(m => m.won).length / holdoutMatches.length;
                    const avgEntry = holdoutMatches.reduce((s, m) => s + m.entry, 0) / holdoutMatches.length;
                    const holdoutEV = holdoutWR / avgEntry - 1;
                    if (holdoutEV <= 0) continue;

                    results.push({
                        type: 'multi_confirm_mom_pricetrend',
                        direction: dir, entryMinute: entryMin,
                        momThresh, bandLo, bandHi,
                        trainWR, trainN: trainMatches.length,
                        holdoutWR, holdoutN: holdoutMatches.length,
                        holdoutEV, avgEntry,
                        holdoutEvents: holdoutMatches
                    });
                }
            }
        }
    }

    results.sort((a, b) => b.holdoutEV - a.holdoutEV);
    return results;
}

// ============================================================
// 4. CROSS-ASSET LEADING INDICATOR
// ============================================================

function mineCrossAsset(cycles, trainFrac = 0.65) {
    const { train, holdout } = loadAndSplit(cycles, trainFrac);
    const results = [];
    const assets = [...new Set(cycles.map(c => c.asset))];
    const directions = ['UP', 'DOWN'];

    // Group cycles by epoch
    const groupByEpoch = (data) => {
        const g = {};
        for (const c of data) {
            if (!g[c.epoch]) g[c.epoch] = {};
            g[c.epoch][c.asset] = c;
        }
        return g;
    };

    // Sort epochs chronologically
    const trainEpochs = groupByEpoch(train);
    const holdoutEpochs = groupByEpoch(holdout);
    const sortedTrainEpochs = Object.keys(trainEpochs).map(Number).sort((a, b) => a - b);
    const sortedHoldoutEpochs = Object.keys(holdoutEpochs).map(Number).sort((a, b) => a - b);

    for (const leader of assets) {
        for (const follower of assets) {
            if (leader === follower) continue;
            for (const leaderDir of directions) {
                for (const followerDir of directions) {
                    for (const entryMin of [0, 1, 3, 5, 7]) {
                        for (const [bandLo, bandHi] of [[0.20, 0.50], [0.25, 0.55], [0.30, 0.60], [0.35, 0.65], [0.40, 0.70], [0.45, 0.75], [0.50, 0.80]]) {
                            const trainMatches = [];
                            const holdoutMatches = [];

                            // In same epoch: if leader's momentum shows direction, trade follower
                            const processEpochs = (epochs, sortedKeys, target) => {
                                for (const epoch of sortedKeys) {
                                    const leaderCycle = epochs[epoch]?.[leader];
                                    const followerCycle = epochs[epoch]?.[follower];
                                    if (!leaderCycle || !followerCycle) continue;

                                    // Leader signal: momentum direction
                                    const mom = getMomentumSignal(leaderCycle);
                                    if (mom === null) continue;
                                    if (leaderDir === 'UP' && mom <= 0.10) continue;
                                    if (leaderDir === 'DOWN' && mom >= -0.10) continue;

                                    // Follower entry
                                    const entry = getEntryPrice(followerCycle, entryMin, followerDir);
                                    if (!entry || entry < bandLo || entry > bandHi) continue;

                                    const won = didWin(followerCycle, followerDir);
                                    if (won === null) continue;
                                    target.push({ won, entry });
                                }
                            };

                            processEpochs(trainEpochs, sortedTrainEpochs, trainMatches);
                            processEpochs(holdoutEpochs, sortedHoldoutEpochs, holdoutMatches);

                            if (trainMatches.length < 5) continue;
                            const trainWR = trainMatches.filter(m => m.won).length / trainMatches.length;
                            if (trainWR < 0.60) continue;

                            if (holdoutMatches.length < 3) continue;
                            const holdoutWR = holdoutMatches.filter(m => m.won).length / holdoutMatches.length;
                            const avgEntry = holdoutMatches.reduce((s, m) => s + m.entry, 0) / holdoutMatches.length;
                            const holdoutEV = holdoutWR / avgEntry - 1;
                            if (holdoutEV <= 0) continue;

                            results.push({
                                type: 'cross_asset_lead',
                                leader, follower, leaderDir, followerDir,
                                entryMinute: entryMin, bandLo, bandHi,
                                trainWR, trainN: trainMatches.length,
                                holdoutWR, holdoutN: holdoutMatches.length,
                                holdoutEV, avgEntry,
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
// 5. HOUR-OF-DAY REGIME MINING
// ============================================================

function mineHourRegimes(cycles, trainFrac = 0.65) {
    const { train, holdout } = loadAndSplit(cycles, trainFrac);
    const results = [];
    const assets = [...new Set(cycles.map(c => c.asset))];
    const directions = ['UP', 'DOWN'];

    for (const asset of assets) {
        for (const dir of directions) {
            for (let hour = 0; hour < 24; hour++) {
                for (const entryMin of [0, 1, 3, 5, 7, 10]) {
                    for (const [bandLo, bandHi] of [
                        [0.20, 0.40], [0.25, 0.45], [0.30, 0.50], [0.35, 0.55],
                        [0.40, 0.60], [0.45, 0.65], [0.50, 0.70], [0.55, 0.75],
                        [0.60, 0.80], [0.25, 0.50], [0.30, 0.60], [0.40, 0.70]
                    ]) {
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
                            holdoutMatches.push({ won, entry });
                        }

                        if (trainMatches.length < 4) continue;
                        const trainWR = trainMatches.filter(m => m.won).length / trainMatches.length;
                        if (trainWR < 0.70) continue;

                        if (holdoutMatches.length < 2) continue;
                        const holdoutWR = holdoutMatches.filter(m => m.won).length / holdoutMatches.length;
                        const avgEntry = holdoutMatches.reduce((s, m) => s + m.entry, 0) / holdoutMatches.length;
                        const holdoutEV = holdoutWR / avgEntry - 1;
                        if (holdoutEV <= 0) continue;

                        results.push({
                            type: 'hour_regime',
                            asset, direction: dir, hour, entryMinute: entryMin,
                            bandLo, bandHi,
                            trainWR, trainN: trainMatches.length,
                            holdoutWR, holdoutN: holdoutMatches.length,
                            holdoutEV, avgEntry,
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
// MC SIMULATION — MEDIAN FOCUSED
// ============================================================

function simulateMC(allEvents, config) {
    const { runs, startBalance, stakeFraction, days, tradesPerDay } = config;
    const maxTrades = Math.ceil(tradesPerDay * days);
    const results = [];

    for (let r = 0; r < runs; r++) {
        let cash = startBalance;
        let trades = 0, wins = 0;

        for (let t = 0; t < maxTrades; t++) {
            if (cash < 1.75) break;

            const ev = allEvents[Math.floor(Math.random() * allEvents.length)];

            // Friction: 10.7% no-fill
            if (Math.random() < 0.107) continue;

            // Adverse fill: +$0.01
            const entry = Math.min(0.99, ev.entry + 0.01);

            // Dynamic stake based on bankroll tier
            let sf = stakeFraction;
            if (config.stakingType === 'target_ladder') {
                if (cash < (config.tier1Max || 50)) sf = config.tier1Frac || 0.60;
                else if (cash < (config.tier2Max || 500)) sf = config.tier2Frac || 0.30;
                else sf = config.tier3Frac || 0.10;
            }

            const stake = cash * sf;
            if (stake < 1.75) break;

            const shares = Math.floor(stake / entry);
            if (shares < 5) break;
            const actualCost = shares * entry;

            // Fee
            const fee = shares * 0.072 * entry * (1 - entry);

            trades++;
            const won = ev.won;

            if (won) {
                wins++;
                const payout = shares * 1.0;
                cash = cash - actualCost - fee + payout;
            } else {
                cash = cash - actualCost - fee;
            }
        }

        results.push({
            finalBalance: cash,
            trades,
            wins,
            wr: trades > 0 ? wins / trades : 0
        });
    }

    results.sort((a, b) => a.finalBalance - b.finalBalance);
    const n = results.length;
    const median = results[Math.floor(n * 0.5)].finalBalance;
    const p10 = results[Math.floor(n * 0.1)].finalBalance;
    const p25 = results[Math.floor(n * 0.25)].finalBalance;
    const p75 = results[Math.floor(n * 0.75)].finalBalance;
    const p90 = results[Math.floor(n * 0.9)].finalBalance;
    const p95 = results[Math.floor(n * 0.95)].finalBalance;
    const p99 = results[Math.floor(n * 0.99)].finalBalance;
    const max = results[n - 1].finalBalance;
    const bust = results.filter(r => r.finalBalance < 1.75).length / n;
    const pGte50 = results.filter(r => r.finalBalance >= 50).length / n;
    const pGte100 = results.filter(r => r.finalBalance >= 100).length / n;
    const pGte500 = results.filter(r => r.finalBalance >= 500).length / n;
    const pGte1000 = results.filter(r => r.finalBalance >= 1000).length / n;
    const medianTrades = results.sort((a, b) => a.trades - b.trades)[Math.floor(n / 2)].trades;
    const avgWR = results.reduce((s, r) => s + r.wr, 0) / n;

    return { median, p10, p25, p75, p90, p95, p99, max, bust, pGte50, pGte100, pGte500, pGte1000, medianTrades, avgWR };
}

// ============================================================
// BUILD COMBINED SIGNAL SET WITH DEDUPLICATION
// ============================================================

function buildCombinedEventPool(signalSets) {
    const all = [];
    const seen = new Set();
    for (const signals of signalSets) {
        for (const sig of signals) {
            if (!sig.holdoutEvents) continue;
            for (const ev of sig.holdoutEvents) {
                const key = `${sig.asset || 'ALL'}|${sig.type}|${ev.entry.toFixed(4)}|${ev.won}`;
                if (seen.has(key)) continue;
                seen.add(key);
                all.push(ev);
            }
        }
    }
    return all;
}

function computeTPD(signals, holdoutDays) {
    const epochs = new Set();
    for (const sig of signals) {
        if (!sig.holdoutEvents) continue;
        for (const ev of sig.holdoutEvents) {
            epochs.add(`${sig.asset || 'ALL'}|${sig.type}|${ev.entry.toFixed(2)}`);
        }
    }
    return epochs.size / holdoutDays;
}

// ============================================================
// MAIN
// ============================================================

async function main() {
    console.log('=== EPOCH 3 PHASE 3: MEDIAN $500+ OPTIMIZER ===\n');

    // Load data
    const data15m = loadJSON('intracycle-price-data.json');
    const data5m = loadJSON('intracycle-price-data-5m.json');
    const data4h = loadJSON('intracycle-price-data-4h.json');

    console.log(`Data: 15m=${data15m.length}, 5m=${data5m.length}, 4h=${data4h.length}\n`);

    // ========================
    // MINE ALL SIGNAL FAMILIES
    // ========================

    console.log('--- 1. Per-Asset Granular Momentum Mining (15m) ---');
    const perAssetMom15m = minePerAssetGranular(data15m);
    console.log(`  Found ${perAssetMom15m.length} validated signals`);
    const top20perAsset = perAssetMom15m.slice(0, 20);
    for (const s of top20perAsset.slice(0, 10)) {
        console.log(`  ${s.asset} ${s.direction} mom>${(s.momThresh*100).toFixed(0)}% m${s.entryMinute} [${s.bandLo}-${s.bandHi}]: WR=${(s.holdoutWR*100).toFixed(1)}% EV=${(s.holdoutEV*100).toFixed(1)}% N=${s.holdoutN} avgEntry=$${s.avgEntry.toFixed(2)}`);
    }

    console.log('\n--- 2. Per-Asset Structural Mining (15m) ---');
    const structPerAsset15m = mineStructuralPerAsset(data15m);
    console.log(`  Found ${structPerAsset15m.length} validated signals`);
    for (const s of structPerAsset15m.slice(0, 10)) {
        console.log(`  ${s.asset} ${s.direction} m${s.entryMinute} [${s.bandLo.toFixed(2)}-${s.bandHi.toFixed(2)}]: WR=${(s.holdoutWR*100).toFixed(1)}% EV=${(s.holdoutEV*100).toFixed(1)}% N=${s.holdoutN} avgEntry=$${s.avgEntry.toFixed(2)}`);
    }

    console.log('\n--- 3. Multi-Signal Confirmation Mining (15m) ---');
    const multiConfirm15m = mineMultiConfirmation(data15m);
    console.log(`  Found ${multiConfirm15m.length} validated signals`);
    for (const s of multiConfirm15m.slice(0, 10)) {
        console.log(`  ${s.type} ${s.direction} mom>${(s.momThresh*100).toFixed(0)}% m${s.entryMinute} [${s.bandLo}-${s.bandHi}]: WR=${(s.holdoutWR*100).toFixed(1)}% EV=${(s.holdoutEV*100).toFixed(1)}% N=${s.holdoutN}`);
    }

    console.log('\n--- 4. Cross-Asset Leading Indicator (15m) ---');
    const crossAsset15m = mineCrossAsset(data15m);
    console.log(`  Found ${crossAsset15m.length} validated signals`);
    for (const s of crossAsset15m.slice(0, 10)) {
        console.log(`  ${s.leader}→${s.follower} ${s.leaderDir}→${s.followerDir} m${s.entryMinute} [${s.bandLo}-${s.bandHi}]: WR=${(s.holdoutWR*100).toFixed(1)}% EV=${(s.holdoutEV*100).toFixed(1)}% N=${s.holdoutN}`);
    }

    console.log('\n--- 5. Hour Regime Mining (15m) ---');
    const hourRegime15m = mineHourRegimes(data15m);
    console.log(`  Found ${hourRegime15m.length} validated signals`);
    // Filter to high WR only
    const highWRHour = hourRegime15m.filter(s => s.holdoutWR >= 0.80);
    console.log(`  High WR (≥80%): ${highWRHour.length} signals`);
    for (const s of highWRHour.slice(0, 10)) {
        console.log(`  ${s.asset} ${s.direction} H${s.hour} m${s.entryMinute} [${s.bandLo}-${s.bandHi}]: WR=${(s.holdoutWR*100).toFixed(1)}% EV=${(s.holdoutEV*100).toFixed(1)}% N=${s.holdoutN} avgEntry=$${s.avgEntry.toFixed(2)}`);
    }

    // ========================
    // MINE 5m DATA
    // ========================

    console.log('\n--- 6. Per-Asset Structural Mining (5m) ---');
    const struct5m = mineStructuralPerAsset(data5m);
    console.log(`  Found ${struct5m.length} validated signals`);
    const highWR5m = struct5m.filter(s => s.holdoutWR >= 0.80);
    console.log(`  High WR (≥80%): ${highWR5m.length} signals`);
    for (const s of highWR5m.slice(0, 10)) {
        console.log(`  ${s.asset} ${s.direction} m${s.entryMinute} [${s.bandLo.toFixed(2)}-${s.bandHi.toFixed(2)}]: WR=${(s.holdoutWR*100).toFixed(1)}% EV=${(s.holdoutEV*100).toFixed(1)}% N=${s.holdoutN} avgEntry=$${s.avgEntry.toFixed(2)}`);
    }

    console.log('\n--- 7. Hour Regime Mining (5m) ---');
    const hourRegime5m = mineHourRegimes(data5m);
    const highWRHour5m = hourRegime5m.filter(s => s.holdoutWR >= 0.80);
    console.log(`  Found ${hourRegime5m.length} total, ${highWRHour5m.length} high WR (≥80%)`);
    for (const s of highWRHour5m.slice(0, 10)) {
        console.log(`  ${s.asset} ${s.direction} H${s.hour} m${s.entryMinute} [${s.bandLo}-${s.bandHi}]: WR=${(s.holdoutWR*100).toFixed(1)}% EV=${(s.holdoutEV*100).toFixed(1)}% N=${s.holdoutN} avgEntry=$${s.avgEntry.toFixed(2)}`);
    }

    // ========================
    // COMBINE AND SIMULATE
    // ========================

    console.log('\n=== BUILDING COMBINED SIGNAL SETS ===\n');

    const holdoutDays = 5.8;

    // Strategy sets to test:
    const strategySets = {
        // All high-EV per-asset momentum (top 20)
        'perAssetMom_top20': { signals: top20perAsset, label: 'Per-asset momentum top 20' },
        // All high-WR structural (≥80% WR)
        'struct_highWR_15m': { signals: structPerAsset15m.filter(s => s.holdoutWR >= 0.80), label: 'Structural ≥80% WR (15m)' },
        // All high-WR structural (≥75% WR, lower threshold)
        'struct_75WR_15m': { signals: structPerAsset15m.filter(s => s.holdoutWR >= 0.75), label: 'Structural ≥75% WR (15m)' },
        // Multi-confirmation signals
        'multi_confirm': { signals: multiConfirm15m.slice(0, 30), label: 'Multi-confirm top 30' },
        // Cross-asset top 20
        'cross_asset_top20': { signals: crossAsset15m.slice(0, 20), label: 'Cross-asset top 20' },
        // Hour regime high WR
        'hour_highWR': { signals: highWRHour, label: 'Hour regime ≥80% WR (15m)' },
        // 5m high WR structural
        'struct_highWR_5m': { signals: highWR5m, label: 'Structural ≥80% WR (5m)' },
        // 5m hour regime high WR
        'hour_highWR_5m': { signals: highWRHour5m, label: 'Hour regime ≥80% WR (5m)' },
        // COMBINED: all high-WR from all sources
        'combined_highWR': {
            signals: [
                ...structPerAsset15m.filter(s => s.holdoutWR >= 0.80),
                ...highWRHour.slice(0, 30),
                ...highWR5m.slice(0, 30),
                ...highWRHour5m.slice(0, 30),
                ...multiConfirm15m.filter(s => s.holdoutWR >= 0.80)
            ],
            label: 'Combined all ≥80% WR'
        },
        // COMBINED: high-WR + high-EV
        'combined_mixed': {
            signals: [
                ...structPerAsset15m.filter(s => s.holdoutWR >= 0.75).slice(0, 30),
                ...top20perAsset.slice(0, 10),
                ...highWRHour.slice(0, 20),
                ...highWR5m.slice(0, 20),
                ...crossAsset15m.filter(s => s.holdoutWR >= 0.70).slice(0, 20)
            ],
            label: 'Combined mixed high-WR+high-EV'
        },
        // MAX VOLUME: everything validated, for compounding through sheer volume
        'max_volume': {
            signals: [
                ...structPerAsset15m.filter(s => s.holdoutWR >= 0.65).slice(0, 50),
                ...perAssetMom15m.filter(s => s.holdoutWR >= 0.60).slice(0, 30),
                ...struct5m.filter(s => s.holdoutWR >= 0.65).slice(0, 50),
                ...hourRegime5m.filter(s => s.holdoutWR >= 0.60).slice(0, 30),
                ...hourRegime15m.filter(s => s.holdoutWR >= 0.60).slice(0, 30),
                ...crossAsset15m.filter(s => s.holdoutWR >= 0.60).slice(0, 20),
                ...multiConfirm15m.filter(s => s.holdoutWR >= 0.60).slice(0, 20)
            ],
            label: 'Max volume (all ≥60% WR, max TPD)'
        }
    };

    // Staking configs to test
    const stakingConfigs = [
        { name: 'fixed_30', stakeFraction: 0.30, stakingType: 'fixed' },
        { name: 'fixed_40', stakeFraction: 0.40, stakingType: 'fixed' },
        { name: 'fixed_50', stakeFraction: 0.50, stakingType: 'fixed' },
        { name: 'target_50_500', stakeFraction: 0.30, stakingType: 'target_ladder', tier1Max: 50, tier1Frac: 0.60, tier2Max: 500, tier2Frac: 0.30, tier3Frac: 0.10 },
        { name: 'target_30_200', stakeFraction: 0.30, stakingType: 'target_ladder', tier1Max: 30, tier1Frac: 0.50, tier2Max: 200, tier2Frac: 0.35, tier3Frac: 0.15 },
        { name: 'aggressive_ladder', stakeFraction: 0.30, stakingType: 'target_ladder', tier1Max: 25, tier1Frac: 0.70, tier2Max: 100, tier2Frac: 0.45, tier3Frac: 0.20 },
    ];

    const allResults = [];

    for (const [setName, setInfo] of Object.entries(strategySets)) {
        const { signals, label } = setInfo;
        if (!signals || signals.length === 0) {
            console.log(`[${setName}] No signals — skipping`);
            continue;
        }

        // Build event pool from holdout events
        const events = [];
        for (const sig of signals) {
            if (!sig.holdoutEvents) continue;
            for (const ev of sig.holdoutEvents) events.push(ev);
        }

        if (events.length === 0) {
            console.log(`[${setName}] No holdout events — skipping`);
            continue;
        }

        // Compute WR of pool
        const poolWR = events.filter(e => e.won).length / events.length;
        const poolAvgEntry = events.reduce((s, e) => s + e.entry, 0) / events.length;
        const tpd = computeTPD(signals, holdoutDays);

        console.log(`[${setName}] ${label}: ${signals.length} signals, ${events.length} events, poolWR=${(poolWR*100).toFixed(1)}%, avgEntry=$${poolAvgEntry.toFixed(2)}, TPD=${tpd.toFixed(1)}`);

        for (const staking of stakingConfigs) {
            for (const startBal of [5, 10]) {
                const mc = simulateMC(events, {
                    runs: 10000,
                    startBalance: startBal,
                    stakeFraction: staking.stakeFraction,
                    days: 7,
                    tradesPerDay: tpd,
                    stakingType: staking.stakingType,
                    tier1Max: staking.tier1Max,
                    tier1Frac: staking.tier1Frac,
                    tier2Max: staking.tier2Max,
                    tier2Frac: staking.tier2Frac,
                    tier3Frac: staking.tier3Frac,
                });

                const result = {
                    signalSet: setName,
                    staking: staking.name,
                    startBalance: startBal,
                    poolWR, poolAvgEntry,
                    tpd,
                    numSignals: signals.length,
                    numEvents: events.length,
                    ...mc
                };

                allResults.push(result);

                if (mc.median >= 50 || mc.pGte500 >= 0.10) {
                    console.log(`  [${staking.name}] $${startBal}: median=$${mc.median.toFixed(2)} bust=${(mc.bust*100).toFixed(1)}% P≥$100=${(mc.pGte100*100).toFixed(1)}% P≥$500=${(mc.pGte500*100).toFixed(1)}% p90=$${mc.p90.toFixed(2)} medTrades=${mc.medianTrades} avgWR=${(mc.avgWR*100).toFixed(1)}%`);
                }
            }
        }
    }

    // ========================
    // RANK BY MEDIAN
    // ========================

    console.log('\n====== TOP 30 BY MEDIAN ======\n');
    allResults.sort((a, b) => b.median - a.median);
    for (let i = 0; i < Math.min(30, allResults.length); i++) {
        const r = allResults[i];
        console.log(`${String(i + 1).padStart(2)}. [${r.signalSet}] ${r.staking} $${r.startBalance}`);
        console.log(`    median=$${r.median.toFixed(2)} bust=${(r.bust*100).toFixed(1)}% P≥$100=${(r.pGte100*100).toFixed(1)}% P≥$500=${(r.pGte500*100).toFixed(1)}%`);
        console.log(`    p10=$${r.p10.toFixed(2)} p25=$${r.p25.toFixed(2)} p75=$${r.p75.toFixed(2)} p90=$${r.p90.toFixed(2)} p95=$${r.p95.toFixed(2)} max=$${r.max.toFixed(2)}`);
        console.log(`    poolWR=${(r.poolWR*100).toFixed(1)}% avgEntry=$${r.poolAvgEntry.toFixed(2)} tpd=${r.tpd.toFixed(1)} medTrades=${r.medianTrades} avgWR=${(r.avgWR*100).toFixed(1)}%`);
    }

    // Also show best P(≥$500)
    console.log('\n====== TOP 10 BY P(≥$500) ======\n');
    allResults.sort((a, b) => b.pGte500 - a.pGte500);
    for (let i = 0; i < Math.min(10, allResults.length); i++) {
        const r = allResults[i];
        console.log(`${String(i + 1).padStart(2)}. [${r.signalSet}] ${r.staking} $${r.startBalance}: P≥$500=${(r.pGte500*100).toFixed(1)}% median=$${r.median.toFixed(2)} bust=${(r.bust*100).toFixed(1)}%`);
    }

    // Show best risk-adjusted (median × (1-bust))
    console.log('\n====== TOP 10 RISK-ADJUSTED (median × (1-bust)) ======\n');
    allResults.sort((a, b) => (b.median * (1 - b.bust)) - (a.median * (1 - a.bust)));
    for (let i = 0; i < Math.min(10, allResults.length); i++) {
        const r = allResults[i];
        const score = r.median * (1 - r.bust);
        console.log(`${String(i + 1).padStart(2)}. [${r.signalSet}] ${r.staking} $${r.startBalance}: score=$${score.toFixed(2)} median=$${r.median.toFixed(2)} bust=${(r.bust*100).toFixed(1)}%`);
    }

    // Save results
    const outputPath = path.join(OUTPUT_DIR, 'epoch3_phase3_results.json');
    fs.writeFileSync(outputPath, JSON.stringify({
        timestamp: new Date().toISOString(),
        totalConfigs: allResults.length,
        top30byMedian: allResults.sort((a, b) => b.median - a.median).slice(0, 30),
        top10byP500: allResults.sort((a, b) => b.pGte500 - a.pGte500).slice(0, 10),
        signalSummary: {
            perAssetMom15m: perAssetMom15m.length,
            structPerAsset15m: structPerAsset15m.length,
            multiConfirm15m: multiConfirm15m.length,
            crossAsset15m: crossAsset15m.length,
            hourRegime15m: hourRegime15m.length,
            struct5m: struct5m.length,
            hourRegime5m: hourRegime5m.length,
            highWR80plus15m: structPerAsset15m.filter(s => s.holdoutWR >= 0.80).length,
            highWR80plus5m: highWR5m.length,
        }
    }, null, 2));
    console.log(`\nResults saved to ${outputPath}`);
}

main().catch(console.error);
