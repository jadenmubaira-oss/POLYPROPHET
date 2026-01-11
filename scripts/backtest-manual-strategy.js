#!/usr/bin/env node
/**
 * 🔮 POLYPROPHET MANUAL STRATEGY BACKTEST
 * 
 * Simulates the $1→$1M manual trading journey using historical debug corpus data.
 * 
 * Strategy:
 * - Start with $1 bankroll
 * - ULTRA-only trades until bankroll reaches $20
 * - Strict CONVICTION trades after $20
 * - $100 max stake cap at higher bankrolls
 * 
 * Usage:
 *   node scripts/backtest-manual-strategy.js [--cycles=N] [--start=1]
 * 
 * Output:
 * - Trade-by-trade ledger
 * - Win rate, max drawdown, bust rate
 * - Final bankroll
 */

const fs = require('fs');
const path = require('path');

// ==================== CONFIGURATION ====================
const CONFIG = {
    startingBankroll: 1.00,
    ultraOnlyThreshold: 20.00,
    maxAbsoluteStake: 100.00,
    
    // ULTRA gates thresholds (must match server.js)
    ultraGates: {
        pWinMin: 0.88,
        evRoiMin: 0.25,
        consensusMin: 0.85,
        stabilityMin: 0.8,
        timeLeftMin: 180,
        extremeOddsLow: 0.35,
        extremeOddsHigh: 0.85
    },
    
    // CONVICTION gates (used after $20)
    convictionGates: {
        pWinMin: 0.80,
        evRoiMin: 0.10,
        edgeMin: 0.05
    }
};

// ==================== STAKE CALCULATOR ====================
function calculateStake(bankroll, entryPrice, pWin, isUltra) {
    let stakePercent = 0.85;
    
    if (bankroll <= 2) {
        stakePercent = 1.00; // ALL IN
    } else if (bankroll <= 5) {
        stakePercent = 0.95;
    } else if (bankroll <= 20) {
        stakePercent = 0.90;
    } else if (bankroll <= 100) {
        stakePercent = 0.85;
    } else {
        stakePercent = 0.80;
    }
    
    if (isUltra && stakePercent < 1.00) {
        stakePercent = Math.min(1.00, stakePercent + 0.05);
    }
    
    if (pWin >= 0.95 && stakePercent < 1.00) {
        stakePercent = Math.min(1.00, stakePercent + 0.05);
    }
    
    let stake = bankroll * stakePercent;
    if (stake > CONFIG.maxAbsoluteStake && bankroll > CONFIG.maxAbsoluteStake) {
        stake = CONFIG.maxAbsoluteStake;
    }
    
    return Math.max(1, stake);
}

// ==================== ULTRA CHECK ====================
function checkUltraGates(cycle) {
    const gates = {
        pWin: (cycle.pWin || 0) >= CONFIG.ultraGates.pWinMin,
        evRoi: (cycle.evRoi || 0) >= CONFIG.ultraGates.evRoiMin,
        genesis: cycle.genesisAgrees === true,
        oracleLocked: cycle.oracleLocked === true,
        consensus: (cycle.consensus || 0) >= CONFIG.ultraGates.consensusMin,
        stability: (cycle.stability || 0) >= CONFIG.ultraGates.stabilityMin,
        timeLeft: (cycle.timeLeftAtEntry || 900) >= CONFIG.ultraGates.timeLeftMin,
        extremeOdds: (cycle.entryPrice || 0.5) <= CONFIG.ultraGates.extremeOddsLow || 
                     (cycle.entryPrice || 0.5) >= CONFIG.ultraGates.extremeOddsHigh,
        noFlip: cycle.noFlipSinceLock !== false,
        tier: cycle.tier === 'CONVICTION'
    };
    
    const passed = Object.values(gates).filter(Boolean).length;
    return {
        isUltra: passed === 10,
        passedGates: passed,
        totalGates: 10,
        gates
    };
}

// ==================== CONVICTION CHECK ====================
function checkConvictionGates(cycle) {
    return (cycle.tier === 'CONVICTION' || cycle.tier === 'ADVISORY') &&
           (cycle.pWin || 0) >= CONFIG.convictionGates.pWinMin &&
           (cycle.evRoi || 0) >= CONFIG.convictionGates.evRoiMin &&
           (cycle.edge || 0) >= CONFIG.convictionGates.edgeMin;
}

// ==================== LOAD DEBUG CORPUS ====================
function loadDebugCorpus(dataPath) {
    // Try multiple locations
    const possiblePaths = [
        dataPath,
        path.join(__dirname, '..', 'docs', 'forensics', 'DEBUG_CORPUS_REPORT_v96.json'),
        path.join(__dirname, '..', 'FORENSIC_LEDGER_LOCAL.json'),
        path.join(__dirname, '..', 'debug_corpus.json')
    ];
    
    for (const p of possiblePaths) {
        if (fs.existsSync(p)) {
            try {
                const raw = fs.readFileSync(p, 'utf8');
                const data = JSON.parse(raw);
                console.log(`📂 Loaded corpus from: ${p}`);
                return data;
            } catch (e) {
                console.log(`⚠️ Failed to parse ${p}: ${e.message}`);
            }
        }
    }
    
    return null;
}

// ==================== SIMULATE CYCLE ====================
function simulateCycle(cycle, bankroll) {
    // Extract cycle data
    const prediction = cycle.prediction || cycle.predicted;
    const outcome = cycle.outcome || cycle.actual;
    const tier = cycle.tier;
    const entryPrice = cycle.entryPrice || cycle.implied || 0.5;
    const pWin = cycle.pWin || cycle.calibratedPWin || 0.5;
    const evRoi = cycle.evRoi || ((1 / entryPrice) - 1) * (pWin - entryPrice);
    
    // Reconstruct additional fields if missing
    const cycleData = {
        ...cycle,
        pWin,
        evRoi,
        entryPrice,
        tier,
        prediction,
        outcome,
        consensus: cycle.consensus || 0.7,
        stability: cycle.stability || cycle.voteTrendScore || 0.5,
        timeLeftAtEntry: cycle.timeLeftAtEntry || 600,
        genesisAgrees: cycle.genesisAgrees !== false,
        oracleLocked: cycle.oracleLocked || cycle.oracleLocked === true,
        noFlipSinceLock: cycle.noFlipSinceLock !== false,
        edge: pWin - entryPrice
    };
    
    // Check if we should trade
    const ultraStatus = checkUltraGates(cycleData);
    const isUltra = ultraStatus.isUltra;
    const isConviction = checkConvictionGates(cycleData);
    
    // Apply trading policy
    const ultraOnlyMode = bankroll < CONFIG.ultraOnlyThreshold;
    
    let shouldTrade = false;
    let tradeReason = '';
    
    if (ultraOnlyMode) {
        if (isUltra) {
            shouldTrade = true;
            tradeReason = `ULTRA (${ultraStatus.passedGates}/10 gates)`;
        } else {
            tradeReason = `SKIP: Ultra-only mode, only ${ultraStatus.passedGates}/10 gates`;
        }
    } else {
        if (isUltra) {
            shouldTrade = true;
            tradeReason = `ULTRA (${ultraStatus.passedGates}/10 gates)`;
        } else if (isConviction) {
            shouldTrade = true;
            tradeReason = `CONVICTION`;
        } else {
            tradeReason = `SKIP: Not ULTRA or CONVICTION`;
        }
    }
    
    if (!prediction || prediction === 'WAIT' || prediction === 'NEUTRAL') {
        shouldTrade = false;
        tradeReason = 'SKIP: No prediction';
    }
    
    if (!shouldTrade) {
        return {
            traded: false,
            reason: tradeReason,
            bankrollBefore: bankroll,
            bankrollAfter: bankroll,
            pnl: 0,
            isWin: null
        };
    }
    
    // Execute trade
    const stake = calculateStake(bankroll, entryPrice, pWin, isUltra);
    const shares = stake / entryPrice;
    const isWin = prediction === outcome;
    
    let pnl;
    if (isWin) {
        pnl = shares - stake; // Win pays $1/share, cost was stake
    } else {
        pnl = -stake; // Loss loses entire stake
    }
    
    const bankrollAfter = Math.max(0, bankroll + pnl);
    
    return {
        traded: true,
        reason: tradeReason,
        isUltra,
        prediction,
        outcome,
        isWin,
        entryPrice,
        stake,
        shares,
        pnl,
        bankrollBefore: bankroll,
        bankrollAfter
    };
}

// ==================== MAIN BACKTEST ====================
function runBacktest(corpus, maxCycles = null) {
    // Extract cycles from corpus
    let cycles = [];
    
    if (Array.isArray(corpus)) {
        cycles = corpus;
    } else if (corpus.cycles) {
        cycles = corpus.cycles;
    } else if (corpus.byTier) {
        // Flatten tier-grouped data
        for (const tierData of Object.values(corpus.byTier)) {
            if (tierData.cycles) cycles.push(...tierData.cycles);
        }
    } else if (corpus.assets) {
        // Extract from per-asset structure
        for (const assetData of Object.values(corpus.assets)) {
            if (assetData.cycles) cycles.push(...assetData.cycles);
        }
    }
    
    if (cycles.length === 0) {
        console.log('❌ No cycles found in corpus');
        return null;
    }
    
    // Sort by timestamp if available
    cycles.sort((a, b) => {
        const tA = a.timestamp || a.cycleStart || 0;
        const tB = b.timestamp || b.cycleStart || 0;
        return tA - tB;
    });
    
    if (maxCycles && maxCycles < cycles.length) {
        cycles = cycles.slice(0, maxCycles);
    }
    
    console.log(`\n📊 BACKTEST: ${cycles.length} cycles\n`);
    console.log(`   Starting bankroll: $${CONFIG.startingBankroll.toFixed(2)}`);
    console.log(`   ULTRA-only until: $${CONFIG.ultraOnlyThreshold.toFixed(2)}`);
    console.log(`   Max stake cap: $${CONFIG.maxAbsoluteStake.toFixed(2)}\n`);
    console.log('━'.repeat(80));
    
    // Run simulation
    let bankroll = CONFIG.startingBankroll;
    let peakBankroll = bankroll;
    let maxDrawdown = 0;
    let trades = [];
    let wins = 0;
    let losses = 0;
    let skipped = 0;
    let ultraTrades = 0;
    let ultraWins = 0;
    let busted = false;
    
    for (let i = 0; i < cycles.length; i++) {
        const cycle = cycles[i];
        
        if (bankroll < 0.01) {
            busted = true;
            console.log(`\n💀 BUSTED at cycle ${i + 1}`);
            break;
        }
        
        const result = simulateCycle(cycle, bankroll);
        
        if (result.traded) {
            trades.push({
                cycle: i + 1,
                ...result
            });
            
            if (result.isWin) {
                wins++;
                if (result.isUltra) ultraWins++;
            } else {
                losses++;
            }
            
            if (result.isUltra) ultraTrades++;
            
            bankroll = result.bankrollAfter;
            peakBankroll = Math.max(peakBankroll, bankroll);
            const drawdown = (peakBankroll - bankroll) / peakBankroll;
            maxDrawdown = Math.max(maxDrawdown, drawdown);
            
            // Log significant trades
            const icon = result.isWin ? '✅' : '❌';
            const ultraTag = result.isUltra ? '🔮' : '  ';
            console.log(`${icon}${ultraTag} #${i + 1} ${result.prediction} @ ${(result.entryPrice * 100).toFixed(0)}¢ | ` +
                       `Stake: $${result.stake.toFixed(2)} | P/L: ${result.pnl >= 0 ? '+' : ''}$${result.pnl.toFixed(2)} | ` +
                       `Balance: $${bankroll.toFixed(2)} | ${result.reason}`);
        } else {
            skipped++;
        }
    }
    
    // Summary
    console.log('\n' + '═'.repeat(80));
    console.log('📊 BACKTEST RESULTS');
    console.log('═'.repeat(80));
    console.log(`\n📈 PERFORMANCE:`);
    console.log(`   Total cycles: ${cycles.length}`);
    console.log(`   Trades taken: ${trades.length}`);
    console.log(`   Skipped: ${skipped}`);
    console.log(`   Wins: ${wins} | Losses: ${losses}`);
    console.log(`   Win rate: ${trades.length > 0 ? ((wins / trades.length) * 100).toFixed(1) : 0}%`);
    console.log(`\n🔮 ULTRA-PROPHET:`);
    console.log(`   ULTRA trades: ${ultraTrades}`);
    console.log(`   ULTRA wins: ${ultraWins}`);
    console.log(`   ULTRA win rate: ${ultraTrades > 0 ? ((ultraWins / ultraTrades) * 100).toFixed(1) : 0}%`);
    console.log(`\n💰 BANKROLL:`);
    console.log(`   Starting: $${CONFIG.startingBankroll.toFixed(2)}`);
    console.log(`   Final: $${bankroll.toFixed(2)}`);
    console.log(`   Peak: $${peakBankroll.toFixed(2)}`);
    console.log(`   Max drawdown: ${(maxDrawdown * 100).toFixed(1)}%`);
    console.log(`   Total P/L: ${bankroll >= CONFIG.startingBankroll ? '+' : ''}$${(bankroll - CONFIG.startingBankroll).toFixed(2)}`);
    console.log(`   ROI: ${((bankroll / CONFIG.startingBankroll - 1) * 100).toFixed(1)}%`);
    console.log(`\n⚠️ STATUS: ${busted ? '💀 BUSTED' : (bankroll >= 1000000 ? '🎉 MILLIONAIRE!' : '📈 Active')}`);
    
    // Calculate trades to $1M estimate
    if (!busted && trades.length > 0 && wins > 0) {
        const avgRoi = trades.filter(t => t.isWin).reduce((sum, t) => sum + ((1 / t.entryPrice) - 1), 0) / wins;
        const winRate = wins / trades.length;
        const effectiveGrowth = (avgRoi * winRate) - (1 - winRate); // Simplified expected value per trade
        if (effectiveGrowth > 0) {
            const tradesToMillion = Math.ceil(Math.log(1000000 / bankroll) / Math.log(1 + effectiveGrowth * 0.85));
            console.log(`   Est. trades to $1M: ~${tradesToMillion}`);
        }
    }
    
    console.log('\n' + '═'.repeat(80) + '\n');
    
    return {
        summary: {
            cycles: cycles.length,
            trades: trades.length,
            wins,
            losses,
            winRate: trades.length > 0 ? wins / trades.length : 0,
            ultraTrades,
            ultraWins,
            ultraWinRate: ultraTrades > 0 ? ultraWins / ultraTrades : 0,
            startingBankroll: CONFIG.startingBankroll,
            finalBankroll: bankroll,
            peakBankroll,
            maxDrawdown,
            busted
        },
        trades
    };
}

// ==================== CLI ENTRY ====================
function main() {
    const args = process.argv.slice(2);
    let maxCycles = null;
    let startBankroll = CONFIG.startingBankroll;
    let dataPath = null;
    
    for (const arg of args) {
        if (arg.startsWith('--cycles=')) {
            maxCycles = parseInt(arg.split('=')[1], 10);
        } else if (arg.startsWith('--start=')) {
            startBankroll = parseFloat(arg.split('=')[1]);
            CONFIG.startingBankroll = startBankroll;
        } else if (arg.startsWith('--data=')) {
            dataPath = arg.split('=')[1];
        }
    }
    
    console.log('🔮 POLYPROPHET MANUAL STRATEGY BACKTEST');
    console.log('━'.repeat(40));
    
    const corpus = loadDebugCorpus(dataPath);
    
    if (!corpus) {
        console.log('\n❌ No debug corpus found.');
        console.log('   Place debug data in one of:');
        console.log('   - docs/forensics/DEBUG_CORPUS_REPORT_v96.json');
        console.log('   - FORENSIC_LEDGER_LOCAL.json');
        console.log('   - debug_corpus.json');
        console.log('   Or specify with --data=/path/to/corpus.json');
        process.exit(1);
    }
    
    const results = runBacktest(corpus, maxCycles);
    
    // Save results
    const outputPath = path.join(__dirname, '..', 'backtest_results.json');
    fs.writeFileSync(outputPath, JSON.stringify(results, null, 2));
    console.log(`📁 Results saved to: ${outputPath}`);
}

main();
