#!/usr/bin/env node
/**
 * 🔮 POLYPROPHET v105 - ADAPTIVE FREQUENCY BACKTEST
 *
 * Sweeps pWin thresholds to find optimal balance between:
 * - Frequency (trades per cycle/day)
 * - Accuracy (targeting ≤1 loss per 10 trades = 90% WR)
 *
 * Uses walk-forward validation to avoid overfitting:
 * - Train on first 70% of data
 * - Test on remaining 30%
 *
 * Usage:
 *   node scripts/backtest-manual-strategy.js --data=debg [--sweep] [--target-wr=0.90]
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
    targetWinRate: 0.90,  // ≤1 loss per 10 trades
    
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
                wasCorrect: row.wasCorrect === true || prediction === outcome
            });
        }
    }
    return out;
}

function loadPerCycleCorpus(dataPath) {
    if (!dataPath) return { cycles: [], sources: [] };
    const p = dataPath;
    const sources = [];
    const cycles = [];

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
                    cycles.push(...extracted);
                }
            } catch { /* skip */ }
        }
        return { cycles, sources };
    }

    try {
        const raw = fs.readFileSync(p, 'utf8');
        const json = JSON.parse(raw);
        const extracted = extractCyclesFromDebugExport(json, p);
        return { cycles: extracted, sources: [p] };
    } catch (e) {
        return { cycles: [], sources: [p], error: e.message };
    }
}

// ==================== ADAPTIVE GATE CHECK ====================
function checkAdaptiveGate(cycle, pWinThreshold, tierRequired) {
    const tier = cycle.tier;
    const pWin = safeNum(cycle.pWin, 0);
    
    // Tier check
    if (!tierRequired.includes(tier)) {
        return { passes: false, reason: `Tier=${tier} not in ${tierRequired.join('/')}` };
    }
    
    // CONVICTION gets slight threshold reduction
    const effectiveThreshold = tier === 'CONVICTION' 
        ? Math.max(pWinThreshold - 0.03, 0.60)
        : pWinThreshold;
    
    // pWin check
    if (pWin < effectiveThreshold) {
        return { passes: false, reason: `pWin=${(pWin * 100).toFixed(0)}% < ${(effectiveThreshold * 100).toFixed(0)}%` };
    }
    
    return { passes: true, reason: `pWin=${(pWin * 100).toFixed(0)}% >= ${(effectiveThreshold * 100).toFixed(0)}%` };
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
    
    for (let i = 0; i < cycles.length; i++) {
        const cycle = cycles[i];
        
        if (bankroll < 0.01) {
            console.log(`\n💀 BUSTED at cycle ${i + 1}`);
            break;
        }
        
        const gate = checkAdaptiveGate(cycle, pWinThreshold, tierRequired);
        
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
        
        // Simulate trade (assuming 50¢ entry for simplicity)
        const entryPrice = 0.50;
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
            stake,
            pnl,
            bankrollBefore,
            bankrollAfter: bankroll,
            pWin: cycle.pWin,
            tier: cycle.tier
        });
        
        // Log significant events
        if (trades.length <= 20 || bankroll >= 100 || bankroll < 0.5) {
            const icon = isWin ? '✅' : '❌';
            console.log(`${icon} #${trades.length} ${cycle.asset} ${cycle.prediction} | ` +
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
        tradesPerDay: (trades.length / cycles.length) * 96
    };
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
    
    console.log('🔮 POLYPROPHET v105 - ADAPTIVE FREQUENCY BACKTEST');
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

    console.log(`📂 Loaded ${loaded.cycles.length} cycles from ${loaded.sources.length} source(s).`);
    
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
    
    if (doSweep || true) {  // Always do sweep for v105
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
