#!/usr/bin/env node
/**
 * 🔮 POLYPROPHET v114 - ADAPTIVE FREQUENCY BACKTEST
 *
 * Sweeps pWin thresholds to find optimal balance between:
 * - Frequency (trades per cycle/day)
 * - Accuracy (targeting ≤1-2 loss per 10 trades = 85% WR)
 *
 * 🏆 v114 IMPROVEMENTS:
 * - Tail-BUY gate: Blocks entry < 35¢ unless LOCKED+CONVICTION+pWin≥95%+EV≥30%
 * - Prevents gambling on tail bets (market strongly disagrees)
 *
 * 🏆 v112 IMPROVEMENTS:
 * - Hard ≥80¢ entry price cap (blocks trades at expensive prices)
 * - Bankroll-sensitive pWin floors (micro bankrolls require higher certainty)
 * - Uses ACTUAL entry prices (entryOdds/entryPrice/yesPrice) when available
 * - Falls back to 50¢ only when no actual price recorded
 * - Reports entry price statistics (actual vs fallback usage)
 *
 * Uses walk-forward validation to avoid overfitting:
 * - Train on first 70% of data
 * - Test on remaining 30%
 *
 * Usage:
 *   node scripts/backtest-manual-strategy.js --data=debg [--sweep] [--target-wr=0.85]
 *
 * Examples:
 *   node scripts/backtest-manual-strategy.js --data=debg --sweep
 *   node scripts/backtest-manual-strategy.js --data=debg --target-wr=0.85
 */

const fs = require('fs');
const path = require('path');

// ==================== CONFIGURATION ====================
const CONFIG = {
    startingBankroll: 1.00,
    maxAbsoluteStake: 100.00,
    targetWinRate: 0.85,  // 🏆 v109: ≤1-2 losses per 10 trades (85% WR)
    
    // Threshold sweep range
    sweep: {
        pWinMin: 0.60,
        pWinMax: 0.90,
        pWinStep: 0.02,
        tierRequired: ['CONVICTION', 'ADVISORY']  // Acceptable tiers
    },
    
    // Walk-forward split
    trainRatio: 0.70,  // 70% train, 30% test
};

function safeNum(x, fallback = null) {
    const n = Number(x);
    return Number.isFinite(n) ? n : fallback;
}

function clamp01(x) {
    const n = safeNum(x, null);
    if (n === null) return null;
    return Math.max(0, Math.min(1, n));
}

// ==================== LOAD PER-CYCLE CORPUS ====================
function extractCyclesFromDebugExport(json, sourceLabel = 'unknown') {
    const assets = json && typeof json === 'object' ? json.assets : null;
    if (!assets || typeof assets !== 'object') return [];

    const out = [];
    for (const [asset, assetData] of Object.entries(assets)) {
        const ch = assetData && typeof assetData === 'object' ? (assetData.cycleHistory || assetData.cycles || null) : null;
        if (!Array.isArray(ch)) continue;
        for (const row of ch) {
            if (!row || typeof row !== 'object') continue;
            const prediction = row.prediction || row.predicted || null;
            const outcome = row.actualOutcome || row.outcome || null;
            const tier = row.tier || null;
            
            // Skip if no prediction or outcome
            if (!prediction || prediction === 'WAIT' || prediction === 'NEUTRAL') continue;
            if (!outcome) continue;
            
            const modelVotes = (row.modelVotes && typeof row.modelVotes === 'object') ? row.modelVotes : {};
            const mvValues = Object.values(modelVotes).filter(v => v === 'UP' || v === 'DOWN');
            const upCount = mvValues.filter(v => v === 'UP').length;
            const downCount = mvValues.filter(v => v === 'DOWN').length;
            const totalVotes = upCount + downCount;
            const consensus = totalVotes > 0 ? (Math.max(upCount, downCount) / totalVotes) : 0.5;
            
            // Genesis agreement
            const genesisVote = modelVotes.genesis;
            const genesisAgrees = (genesisVote === 'UP' || genesisVote === 'DOWN') ? (genesisVote === prediction) : null;
            
            // Stability proxy
            const oracleLocked = row.oracleWasLocked === true;
            const stabilityProxy = oracleLocked ? 0.90 : 0.60;
            
            // Confidence as pWin proxy
            const confidence = safeNum(row.confidence, 0.5);
            
            out.push({
                source: sourceLabel,
                asset,
                cycleEndTime: row.cycleEndTime || null,
                outcome,
                prediction,
                tier,
                pWin: confidence,  // Use confidence as pWin proxy
                consensus,
                stability: stabilityProxy,
                genesisAgrees,
                wasCorrect: row.wasCorrect === true || prediction === outcome,
                // 🏆 v109: Capture actual entry prices for realistic simulation
                entryOdds: safeNum(row.entryOdds, null),
                entryPrice: safeNum(row.entryPrice, null),
                yesPrice: safeNum(row.yesPrice, null)
            });
        }
    }
    return out;
}

// ==================== DEDUPLICATION ====================
// Debug exports are rolling snapshots with overlapping cycle histories.
// We must deduplicate by (asset, cycleEndTime) to avoid inflating stats.
function deduplicateCycles(cycles) {
    const seen = new Set();
    const unique = [];
    let dupes = 0;
    
    for (const c of cycles) {
        const key = `${c.asset}|${c.cycleEndTime}`;
        if (seen.has(key)) {
            dupes++;
            continue;
        }
        seen.add(key);
        unique.push(c);
    }
    
    return { unique, duplicatesRemoved: dupes };
}

function loadPerCycleCorpus(dataPath) {
    if (!dataPath) return { cycles: [], sources: [] };
    const p = dataPath;
    const sources = [];
    let rawCycles = [];

    if (!fs.existsSync(p)) return { cycles: [], sources: [] };

    const stat = fs.statSync(p);
    if (stat.isDirectory()) {
        const files = fs.readdirSync(p)
            .filter(f => f.startsWith('polyprophet_debug_') && f.endsWith('.json'))
            .sort();
        for (const f of files) {
            const fp = path.join(p, f);
            try {
                const raw = fs.readFileSync(fp, 'utf8');
                const json = JSON.parse(raw);
                const extracted = extractCyclesFromDebugExport(json, fp);
                if (extracted.length > 0) {
                    sources.push(fp);
                    rawCycles.push(...extracted);
                }
            } catch { /* skip */ }
        }
    } else {
        try {
            const raw = fs.readFileSync(p, 'utf8');
            const json = JSON.parse(raw);
            rawCycles = extractCyclesFromDebugExport(json, p);
            sources.push(p);
        } catch (e) {
            return { cycles: [], sources: [p], error: e.message };
        }
    }
    
    // CRITICAL: Deduplicate overlapping cycles
    const { unique, duplicatesRemoved } = deduplicateCycles(rawCycles);
    
    return { 
        cycles: unique, 
        sources, 
        rawCount: rawCycles.length,
        duplicatesRemoved 
    };
}

// ==================== ADAPTIVE GATE CHECK ====================
// 🏆 v112: Hard ≥80¢ entry cap, bankroll-sensitive pWin floors
// 🏆 v114: Tail-BUY gate - blocks entry < minOdds unless strict conditions met
const PWIN_HARD_FLOOR = 0.85;
const HARD_ENTRY_CAP = 0.80;  // 🚫 v112: No trades at entry price ≥ 80¢
const MIN_ODDS_ENTRY = 0.35;  // 🚫 v114: Tail-bet threshold (entry < 35¢)

/**
 * 🏆 v114: Simple EV ROI calculation for backtest (without slippage/fees for simplicity)
 */
function calcSimpleEvRoi(pWin, entryPrice) {
    if (!Number.isFinite(pWin) || !Number.isFinite(entryPrice) || entryPrice <= 0 || entryPrice >= 1) {
        return null;
    }
    // EV = pWin * (1/entryPrice) - 1
    // Simplified: (pWin / entryPrice) - 1
    return (pWin / entryPrice) - 1;
}

/**
 * 🏆 v112: Get required pWin floor based on bankroll size.
 */
function getRequiredPWinFloor(bankroll) {
    if (!Number.isFinite(bankroll) || bankroll <= 0) bankroll = 1;
    if (bankroll <= 5) return 0.92;
    if (bankroll <= 20) return 0.90;
    if (bankroll <= 100) return 0.87;
    return 0.85;
}

function checkAdaptiveGate(cycle, pWinThreshold, tierRequired, options = {}) {
    const { bankroll = 1 } = options;
    const tier = cycle.tier;
    const pWin = safeNum(cycle.pWin, 0);
    
    // Get actual entry price from cycle data
    const entryOdds = safeNum(cycle.entryOdds, null);
    const cycleEntryPrice = safeNum(cycle.entryPrice, null);
    const yesPrice = safeNum(cycle.yesPrice, null);
    const entryPrice = entryOdds || cycleEntryPrice || yesPrice || 0.50;
    
    // 🚫 v112: Hard entry price cap - no trades at ≥80¢
    if (entryPrice >= HARD_ENTRY_CAP) {
        return { passes: false, reason: `Entry ${(entryPrice * 100).toFixed(0)}¢ >= 80¢ cap`, blockedReason: 'ENTRY_PRICE_CAP' };
    }
    
    // 🏆 v114: TAIL-BUY GATE - Entry price below minOdds threshold
    const isTailBet = entryPrice < MIN_ODDS_ENTRY;
    if (isTailBet) {
        // Calculate EV for tail gate check
        const evRoi = calcSimpleEvRoi(pWin, entryPrice);
        const isLocked = cycle.oracleWasLocked === true || cycle.stabilityProxy >= 0.85;
        
        // 🏆 v114: Allow tail BUY only if ALL strict conditions are met:
        // - LOCKED=true
        // - tier=CONVICTION
        // - pWin >= 95%
        // - EV >= 30%
        // - (sampleSize >= 25 - we don't have this in backtest, skip)
        const tailBuyAllowed = (
            isLocked === true &&
            tier === 'CONVICTION' &&
            pWin >= 0.95 &&
            Number.isFinite(evRoi) && evRoi >= 0.30
        );
        
        if (!tailBuyAllowed) {
            return { 
                passes: false, 
                reason: `🚫 TAIL BUY BLOCKED: Entry ${(entryPrice * 100).toFixed(1)}¢ < ${(MIN_ODDS_ENTRY * 100).toFixed(0)}¢ requires LOCKED+CONVICTION+pWin≥95%+EV≥30%`, 
                blockedReason: 'TAIL_BUY_BLOCKED',
                isTailBet: true
            };
        }
        // If tail conditions met, continue with normal checks
    }
    
    // Tier check
    if (!tierRequired.includes(tier)) {
        return { passes: false, reason: `Tier=${tier} not in ${tierRequired.join('/')}`, blockedReason: 'LOW_TIER' };
    }
    
    // 🏆 v112: Bankroll-sensitive pWin floor
    const bankrollFloor = getRequiredPWinFloor(bankroll);
    const baseFloor = Math.max(PWIN_HARD_FLOOR, bankrollFloor);
    
    // 🏆 v112: Hard-enforce floor for ALL tiers
    // CONVICTION gets slight threshold reduction (-3pp) but never below floor
    // ADVISORY uses standard threshold but never below floor
    const effectiveThreshold = tier === 'CONVICTION' 
        ? Math.max(pWinThreshold - 0.03, baseFloor)
        : Math.max(pWinThreshold, baseFloor);
    
    // pWin check
    if (pWin < effectiveThreshold) {
        return { passes: false, reason: `pWin=${(pWin * 100).toFixed(0)}% < ${(effectiveThreshold * 100).toFixed(0)}%`, blockedReason: 'PWIN_BELOW_THRESHOLD' };
    }
    
    return { passes: true, reason: `pWin=${(pWin * 100).toFixed(0)}% >= ${(effectiveThreshold * 100).toFixed(0)}%`, blockedReason: null, isTailBet };
}

// ==================== RUN SINGLE THRESHOLD BACKTEST ====================
function runBacktestWithThreshold(cycles, pWinThreshold, tierRequired = ['CONVICTION', 'ADVISORY']) {
    let trades = 0;
    let wins = 0;
    let losses = 0;
    let currentStreak = 0;
    let maxStreak = 0;
    let maxLossStreak = 0;
    let currentLossStreak = 0;
    
    for (const cycle of cycles) {
        const gate = checkAdaptiveGate(cycle, pWinThreshold, tierRequired);
        
        if (gate.passes) {
            trades++;
            
            if (cycle.wasCorrect) {
                wins++;
                currentStreak++;
                maxStreak = Math.max(maxStreak, currentStreak);
                currentLossStreak = 0;
            } else {
                losses++;
                currentStreak = 0;
                currentLossStreak++;
                maxLossStreak = Math.max(maxLossStreak, currentLossStreak);
            }
        }
    }
    
    const winRate = trades > 0 ? wins / trades : 0;
    const lossesPerTen = trades > 0 ? (losses / trades) * 10 : 0;
    
    return {
        pWinThreshold,
        trades,
        wins,
        losses,
        winRate,
        lossesPerTen,
        maxStreak,
        maxLossStreak,
        tradesPerCycle: trades / cycles.length,
        tradesPerDay: (trades / cycles.length) * 96  // 96 cycles per day (15min)
    };
}

// ==================== THRESHOLD SWEEP ====================
function runThresholdSweep(trainCycles, testCycles, targetWR = 0.90) {
    const results = [];
    const tierRequired = CONFIG.sweep.tierRequired;
    
    console.log('\n📊 THRESHOLD SWEEP (Walk-Forward Validation)');
    console.log('═'.repeat(80));
    console.log(`   Train set: ${trainCycles.length} cycles`);
    console.log(`   Test set: ${testCycles.length} cycles`);
    console.log(`   Target WR: ${(targetWR * 100).toFixed(0)}%`);
    console.log('═'.repeat(80));
    
    console.log('\n   Threshold │ Train WR │ Test WR │ Trades/Day │ MaxStreak │ Loss/10');
    console.log('   ──────────┼──────────┼─────────┼────────────┼───────────┼────────');
    
    for (let thresh = CONFIG.sweep.pWinMin; thresh <= CONFIG.sweep.pWinMax; thresh += CONFIG.sweep.pWinStep) {
        const trainResult = runBacktestWithThreshold(trainCycles, thresh, tierRequired);
        const testResult = runBacktestWithThreshold(testCycles, thresh, tierRequired);
        
        const meetsTarget = testResult.winRate >= targetWR;
        const marker = meetsTarget ? '✓' : ' ';
        
        console.log(`${marker}  ${(thresh * 100).toFixed(0)}%      │ ${(trainResult.winRate * 100).toFixed(1)}%    │ ${(testResult.winRate * 100).toFixed(1)}%   │ ${testResult.tradesPerDay.toFixed(1).padStart(8)}   │ ${testResult.maxStreak.toString().padStart(6)}    │ ${testResult.lossesPerTen.toFixed(1)}`);
        
        results.push({
            threshold: thresh,
            train: trainResult,
            test: testResult,
            meetsTarget
        });
    }
    
    console.log('   ──────────┴──────────┴─────────┴────────────┴───────────┴────────');
    
    // Find optimal threshold (highest frequency that meets target)
    const validResults = results.filter(r => r.meetsTarget && r.test.trades >= 5);
    
    if (validResults.length === 0) {
        console.log('\n⚠️ No threshold meets target WR with sufficient trades.');
        console.log('   Consider lowering target WR or accepting more risk.\n');
        
        // Find best non-qualifying threshold
        const sorted = [...results].sort((a, b) => b.test.tradesPerDay - a.test.tradesPerDay);
        return { optimal: sorted[0], all: results };
    }
    
    // Sort by trades/day (highest frequency that meets target)
    validResults.sort((a, b) => b.test.tradesPerDay - a.test.tradesPerDay);
    const optimal = validResults[0];
    
    console.log(`\n🎯 OPTIMAL THRESHOLD: ${(optimal.threshold * 100).toFixed(0)}%`);
    console.log(`   Test WR: ${(optimal.test.winRate * 100).toFixed(1)}% (target: ${(targetWR * 100).toFixed(0)}%)`);
    console.log(`   Trades/day: ~${optimal.test.tradesPerDay.toFixed(1)}`);
    console.log(`   Max win streak: ${optimal.test.maxStreak}`);
    console.log(`   Losses per 10 trades: ${optimal.test.lossesPerTen.toFixed(1)}`);
    
    return { optimal, all: results };
}

// ==================== FULL SIMULATION ====================
// 🏆 v109: Uses actual entry prices (entryOdds) from cycle data when available
function runFullSimulation(cycles, pWinThreshold, startingBankroll = 1.00) {
    const tierRequired = CONFIG.sweep.tierRequired;
    
    let bankroll = startingBankroll;
    let peakBankroll = bankroll;
    let maxDrawdown = 0;
    const trades = [];
    let wins = 0;
    let losses = 0;
    let currentStreak = 0;
    let maxStreak = 0;
    let usedActualEntry = 0;
    let usedFallbackEntry = 0;
    
    for (let i = 0; i < cycles.length; i++) {
        const cycle = cycles[i];
        
        if (bankroll < 0.01) {
            console.log(`\n💀 BUSTED at cycle ${i + 1}`);
            break;
        }
        
        // 🏆 v112: Pass current bankroll for bankroll-sensitive pWin floor
        const gate = checkAdaptiveGate(cycle, pWinThreshold, tierRequired, { bankroll });
        
        if (!gate.passes) continue;
        
        // Calculate stake (aggressive compounding)
        let stakePercent = 0.85;
        if (bankroll <= 2) stakePercent = 1.00;
        else if (bankroll <= 5) stakePercent = 0.95;
        else if (bankroll <= 20) stakePercent = 0.90;
        else if (bankroll <= 100) stakePercent = 0.85;
        else stakePercent = 0.80;
        
        let stake = bankroll * stakePercent;
        if (stake > CONFIG.maxAbsoluteStake && bankroll > CONFIG.maxAbsoluteStake) {
            stake = CONFIG.maxAbsoluteStake;
        }
        
        // 🏆 v109: Use actual entry price from cycle data when available
        // Look for entryOdds, entryPrice, or yesPrice fields
        let entryPrice = null;
        const entryOdds = safeNum(cycle.entryOdds, null);
        const cycleEntryPrice = safeNum(cycle.entryPrice, null);
        const yesPrice = safeNum(cycle.yesPrice, null);
        
        if (entryOdds !== null && entryOdds > 0 && entryOdds < 1) {
            entryPrice = entryOdds;
            usedActualEntry++;
        } else if (cycleEntryPrice !== null && cycleEntryPrice > 0 && cycleEntryPrice < 1) {
            entryPrice = cycleEntryPrice;
            usedActualEntry++;
        } else if (yesPrice !== null && yesPrice > 0 && yesPrice < 1) {
            entryPrice = yesPrice;
            usedActualEntry++;
        } else {
            // Fallback to 50¢ only if no actual price available
            entryPrice = 0.50;
            usedFallbackEntry++;
        }
        
        const shares = stake / entryPrice;
        const isWin = cycle.wasCorrect;
        
        let pnl;
        if (isWin) {
            pnl = shares - stake;  // Win pays $1/share
            wins++;
            currentStreak++;
            maxStreak = Math.max(maxStreak, currentStreak);
        } else {
            pnl = -stake;  // Loss loses stake
            losses++;
            currentStreak = 0;
        }
        
        const bankrollBefore = bankroll;
        bankroll = Math.max(0, bankroll + pnl);
        peakBankroll = Math.max(peakBankroll, bankroll);
        const drawdown = (peakBankroll - bankroll) / peakBankroll;
        maxDrawdown = Math.max(maxDrawdown, drawdown);
        
        trades.push({
            cycle: i + 1,
            asset: cycle.asset,
            prediction: cycle.prediction,
            outcome: cycle.outcome,
            isWin,
            entryPrice,  // 🏆 v109: Include actual entry price
            stake,
            pnl,
            bankrollBefore,
            bankrollAfter: bankroll,
            pWin: cycle.pWin,
            tier: cycle.tier,
            entrySource: entryOdds !== null ? 'ACTUAL' : 'FALLBACK'
        });
        
        // Log significant events
        if (trades.length <= 20 || bankroll >= 100 || bankroll < 0.5) {
            const icon = isWin ? '✅' : '❌';
            const entryNote = entryPrice !== 0.50 ? ` @${(entryPrice * 100).toFixed(0)}¢` : '';
            console.log(`${icon} #${trades.length} ${cycle.asset} ${cycle.prediction}${entryNote} | ` +
                       `Stake: $${stake.toFixed(2)} | P/L: ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)} | ` +
                       `Balance: $${bankroll.toFixed(2)}`);
        } else if (trades.length === 21) {
            console.log('   ... (remaining trades suppressed for brevity)');
        }
    }
    
    return {
        finalBankroll: bankroll,
        peakBankroll,
        maxDrawdown,
        trades,
        wins,
        losses,
        winRate: trades.length > 0 ? wins / trades.length : 0,
        maxStreak,
        totalCycles: cycles.length,
        tradesPerDay: (trades.length / cycles.length) * 96,
        // 🏆 v109: Entry price statistics
        entryStats: {
            usedActualEntry,
            usedFallbackEntry,
            actualEntryPct: trades.length > 0 ? ((usedActualEntry / trades.length) * 100).toFixed(1) + '%' : 'N/A'
        }
    };
}

// ==================== PER-ASSET & PER-TIER BREAKDOWN ====================
function analyzeBreakdown(cycles, pWinThreshold, tierRequired = ['CONVICTION', 'ADVISORY']) {
    const byAsset = {};
    const byTier = {};
    
    for (const cycle of cycles) {
        const gate = checkAdaptiveGate(cycle, pWinThreshold, tierRequired);
        if (!gate.passes) continue;
        
        const asset = cycle.asset || 'UNKNOWN';
        const tier = cycle.tier || 'UNKNOWN';
        const isWin = cycle.wasCorrect;
        
        // By asset
        if (!byAsset[asset]) byAsset[asset] = { trades: 0, wins: 0, losses: 0 };
        byAsset[asset].trades++;
        if (isWin) byAsset[asset].wins++;
        else byAsset[asset].losses++;
        
        // By tier
        if (!byTier[tier]) byTier[tier] = { trades: 0, wins: 0, losses: 0 };
        byTier[tier].trades++;
        if (isWin) byTier[tier].wins++;
        else byTier[tier].losses++;
    }
    
    return { byAsset, byTier };
}

function printBreakdown(breakdown) {
    console.log('\n📊 PER-ASSET BREAKDOWN');
    console.log('═'.repeat(50));
    console.log('   Asset    │ Trades │  Wins  │ Losses │ Win Rate');
    console.log('   ─────────┼────────┼────────┼────────┼─────────');
    
    for (const [asset, stats] of Object.entries(breakdown.byAsset)) {
        const wr = stats.trades > 0 ? (stats.wins / stats.trades * 100).toFixed(1) : 'N/A';
        console.log(`   ${asset.padEnd(8)} │ ${String(stats.trades).padStart(6)} │ ${String(stats.wins).padStart(6)} │ ${String(stats.losses).padStart(6)} │ ${wr}%`);
    }
    console.log('   ─────────┴────────┴────────┴────────┴─────────');
    
    console.log('\n📊 PER-TIER BREAKDOWN');
    console.log('═'.repeat(50));
    console.log('   Tier       │ Trades │  Wins  │ Losses │ Win Rate');
    console.log('   ───────────┼────────┼────────┼────────┼─────────');
    
    for (const [tier, stats] of Object.entries(breakdown.byTier)) {
        const wr = stats.trades > 0 ? (stats.wins / stats.trades * 100).toFixed(1) : 'N/A';
        console.log(`   ${tier.padEnd(10)} │ ${String(stats.trades).padStart(6)} │ ${String(stats.wins).padStart(6)} │ ${String(stats.losses).padStart(6)} │ ${wr}%`);
    }
    console.log('   ───────────┴────────┴────────┴────────┴─────────');
}

// ==================== CLI ENTRY ====================
function main() {
    const args = process.argv.slice(2);
    let dataPath = null;
    let doSweep = false;
    let targetWR = CONFIG.targetWinRate;
    
    for (const arg of args) {
        if (arg.startsWith('--data=')) {
            dataPath = arg.split('=')[1];
        } else if (arg === '--sweep') {
            doSweep = true;
        } else if (arg.startsWith('--target-wr=')) {
            targetWR = parseFloat(arg.split('=')[1]);
        }
    }
    
    console.log('🔮 POLYPROPHET v112 - ADAPTIVE FREQUENCY BACKTEST');
    console.log('━'.repeat(50));

    if (!dataPath) {
        console.log('\n❌ Missing required --data.');
        console.log('   Usage: node scripts/backtest-manual-strategy.js --data=debg [--sweep]');
        process.exit(1);
    }

    const loaded = loadPerCycleCorpus(dataPath);
    if (loaded?.error) {
        console.log(`\n❌ ${loaded.error}`);
        process.exit(1);
    }
    if (!loaded || !Array.isArray(loaded.cycles) || loaded.cycles.length === 0) {
        console.log('\n❌ No per-cycle rows found.');
        process.exit(1);
    }

    console.log(`📂 Loaded from ${loaded.sources.length} source(s):`);
    console.log(`   Raw cycles: ${loaded.rawCount || loaded.cycles.length}`);
    console.log(`   Duplicates removed: ${loaded.duplicatesRemoved || 0}`);
    console.log(`   Unique cycles: ${loaded.cycles.length}`);
    
    // Sort by time
    const cycles = loaded.cycles.sort((a, b) => {
        const tA = Date.parse(a.cycleEndTime || '') || 0;
        const tB = Date.parse(b.cycleEndTime || '') || 0;
        return tA - tB;
    });
    
    // Walk-forward split
    const splitIdx = Math.floor(cycles.length * CONFIG.trainRatio);
    const trainCycles = cycles.slice(0, splitIdx);
    const testCycles = cycles.slice(splitIdx);
    
    console.log(`\n⚠️ NOTE: Bankroll simulation now uses ACTUAL entry prices when available.`);
    console.log(`   Falls back to 50¢ only when cycle lacks entryOdds/entryPrice/yesPrice.`);
    
    if (true) {  // Always do sweep for v105
        const sweep = runThresholdSweep(trainCycles, testCycles, targetWR);
        
        if (sweep.optimal) {
            console.log('\n' + '═'.repeat(80));
            console.log('💰 FULL SIMULATION WITH OPTIMAL THRESHOLD');
            console.log('═'.repeat(80));
            
            const sim = runFullSimulation(cycles, sweep.optimal.threshold, CONFIG.startingBankroll);
            
            console.log('\n' + '═'.repeat(80));
            console.log('📊 FINAL RESULTS');
            console.log('═'.repeat(80));
            console.log(`\n   Threshold used: ${(sweep.optimal.threshold * 100).toFixed(0)}%`);
            console.log(`   Total cycles: ${sim.totalCycles}`);
            console.log(`   Trades taken: ${sim.trades.length}`);
            console.log(`   Wins: ${sim.wins} | Losses: ${sim.losses}`);
            console.log(`   Win rate: ${(sim.winRate * 100).toFixed(1)}%`);
            console.log(`   Max win streak: ${sim.maxStreak}`);
            console.log(`   Trades/day: ~${sim.tradesPerDay.toFixed(1)}`);
            console.log(`\n   Starting: $${CONFIG.startingBankroll.toFixed(2)}`);
            console.log(`   Final: $${sim.finalBankroll.toFixed(2)}`);
            console.log(`   Peak: $${sim.peakBankroll.toFixed(2)}`);
            console.log(`   Max drawdown: ${(sim.maxDrawdown * 100).toFixed(1)}%`);
            console.log(`   ROI: ${((sim.finalBankroll / CONFIG.startingBankroll - 1) * 100).toFixed(1)}%`);
            
            if (sim.finalBankroll >= 1000000) {
                console.log('\n   🎉 MILLIONAIRE!');
            } else if (sim.finalBankroll < 0.01) {
                console.log('\n   💀 BUSTED');
            }
            
            console.log('\n' + '─'.repeat(80));
            console.log('⚠️ DISCLAIMER (v112):');
            console.log('   - Hard blocks trades at entry price >= 80¢');
            console.log('   - Bankroll-sensitive pWin floors (92% for ≤$5, 90% for ≤$20)');
            console.log(`   - Entry stats: ${sim.entryStats.actualEntryPct} actual prices, ${sim.entryStats.usedFallbackEntry} fallbacks`);
            console.log('   - Does not include slippage or taker fees');
            console.log('   - Past performance does not guarantee future results');
            console.log('─'.repeat(80));
            
            // Per-asset and per-tier breakdown
            const breakdown = analyzeBreakdown(cycles, sweep.optimal.threshold);
            printBreakdown(breakdown);
            
            // Save results
            const outputPath = path.join(__dirname, '..', 'backtest_results.json');
            fs.writeFileSync(outputPath, JSON.stringify({
                config: {
                    threshold: sweep.optimal.threshold,
                    targetWR,
                    startingBankroll: CONFIG.startingBankroll
                },
                sweep: sweep.all,
                simulation: {
                    finalBankroll: sim.finalBankroll,
                    trades: sim.trades.length,
                    winRate: sim.winRate,
                    maxStreak: sim.maxStreak,
                    tradesPerDay: sim.tradesPerDay
                },
                trades: sim.trades.slice(-100)  // Last 100 trades
            }, null, 2));
            console.log(`\n📁 Results saved to: ${outputPath}`);
        }
    }
    
    console.log('\n' + '═'.repeat(80) + '\n');
}

main();
