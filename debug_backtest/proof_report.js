#!/usr/bin/env node
/**
 * POLYPROPHET Proof Report Generator
 * Deterministic backtest from debug archive
 * Outputs: win-rate, trade frequency, drawdown, worst-case streaks
 */

const fs = require('fs');
const path = require('path');

const DEBUG_DIR = path.join(__dirname, '..', 'debug');

// Parse all debug files and extract cycle history
function collectCycles() {
    const files = fs.readdirSync(DEBUG_DIR)
        .filter(f => f.startsWith('polyprophet_debug_') && f.endsWith('.json'))
        .sort();
    
    const allCycles = [];
    const seenCycleKeys = new Set();
    
    for (const file of files) {
        try {
            const content = fs.readFileSync(path.join(DEBUG_DIR, file), 'utf8');
            const data = JSON.parse(content);
            
            const configVersion = data.code?.configVersion || 0;
            const assets = data.assets || {};
            
            for (const [asset, assetData] of Object.entries(assets)) {
                const cycleHistory = assetData.cycleHistory || [];
                for (const cycle of cycleHistory) {
                    if (!cycle.cycleEndTime) continue;
                    
                    // Dedup by asset + cycleEndTime
                    const key = `${asset}_${cycle.cycleEndTime}`;
                    if (seenCycleKeys.has(key)) continue;
                    seenCycleKeys.add(key);
                    
                    allCycles.push({
                        asset,
                        cycleEndTime: new Date(cycle.cycleEndTime),
                        prediction: cycle.prediction,
                        actualOutcome: cycle.actualOutcome,
                        wasCorrect: cycle.wasCorrect,
                        tier: cycle.tier || 'NONE',
                        confidence: cycle.confidence || 0,
                        yesPrice: cycle.marketOdds?.yesPrice || 0.5,
                        noPrice: cycle.marketOdds?.noPrice || 0.5,
                        configVersion
                    });
                }
            }
        } catch (e) {
            // Skip malformed files
        }
    }
    
    // Sort by time
    allCycles.sort((a, b) => a.cycleEndTime - b.cycleEndTime);
    return allCycles;
}

// Simulate trading and calculate metrics
function runBacktest(cycles, options = {}) {
    const {
        startingBalance = 10,
        tierFilter = 'CONVICTION', // CONVICTION, ADVISORY, ALL
        maxPositionPct = 0.20,
        minConfigVersion = 0
    } = options;
    
    let balance = startingBalance;
    let peakBalance = startingBalance;
    let maxDrawdown = 0;
    let wins = 0;
    let losses = 0;
    let winStreak = 0;
    let lossStreak = 0;
    let maxWinStreak = 0;
    let maxLossStreak = 0;
    
    const dailyStats = {};
    const assetStats = { BTC: { wins: 0, losses: 0 }, ETH: { wins: 0, losses: 0 }, SOL: { wins: 0, losses: 0 }, XRP: { wins: 0, losses: 0 } };
    
    let tradesExecuted = 0;
    
    for (const cycle of cycles) {
        // Filter by config version
        if (cycle.configVersion < minConfigVersion) continue;
        
        // Filter by tier
        if (tierFilter !== 'ALL' && cycle.tier !== tierFilter) continue;
        
        // Skip neutral predictions
        if (cycle.prediction === 'NEUTRAL' || !cycle.prediction) continue;
        
        // Calculate entry price
        const entryPrice = cycle.prediction === 'UP' ? cycle.yesPrice : cycle.noPrice;
        
        // Skip unreasonable prices (avoid extreme edge cases)
        if (entryPrice < 0.05 || entryPrice > 0.98) continue;
        
        // Position sizing (Kelly-ish)
        const positionSize = Math.min(balance * maxPositionPct, balance * 0.6);
        if (positionSize <= 0) continue;
        
        // Calculate outcome
        const won = cycle.wasCorrect === true;
        
        if (won) {
            // Win: receive 1.00 per share, profit = (1 - entryPrice) per share
            const shares = positionSize / entryPrice;
            const payout = shares * 1.0;
            const profit = payout - positionSize;
            balance += profit * 0.98; // 2% fee on profits
            wins++;
            winStreak++;
            lossStreak = 0;
            maxWinStreak = Math.max(maxWinStreak, winStreak);
            assetStats[cycle.asset].wins++;
        } else {
            // Loss: lose stake
            balance -= positionSize;
            losses++;
            lossStreak++;
            winStreak = 0;
            maxLossStreak = Math.max(maxLossStreak, lossStreak);
            assetStats[cycle.asset].losses++;
        }
        
        tradesExecuted++;
        
        // Track peak and drawdown
        peakBalance = Math.max(peakBalance, balance);
        const drawdown = (peakBalance - balance) / peakBalance;
        maxDrawdown = Math.max(maxDrawdown, drawdown);
        
        // Daily tracking
        const day = cycle.cycleEndTime.toISOString().split('T')[0];
        if (!dailyStats[day]) dailyStats[day] = { trades: 0, wins: 0, losses: 0 };
        dailyStats[day].trades++;
        if (won) dailyStats[day].wins++;
        else dailyStats[day].losses++;
        
        // Bust check
        if (balance <= 0.01) {
            break;
        }
    }
    
    const totalTrades = wins + losses;
    const winRate = totalTrades > 0 ? (wins / totalTrades * 100) : 0;
    
    return {
        summary: {
            startingBalance,
            finalBalance: balance,
            totalReturn: ((balance - startingBalance) / startingBalance * 100).toFixed(2) + '%',
            tradesExecuted,
            wins,
            losses,
            winRate: winRate.toFixed(2) + '%',
            maxDrawdown: (maxDrawdown * 100).toFixed(2) + '%',
            maxWinStreak,
            maxLossStreak,
            peakBalance,
            bust: balance <= 0.01
        },
        assetStats,
        dailyStats,
        tierFilter,
        minConfigVersion
    };
}

// Main
function main() {
    console.log('='.repeat(60));
    console.log('POLYPROPHET PROOF REPORT');
    console.log('='.repeat(60));
    console.log(`Debug directory: ${DEBUG_DIR}`);
    
    const cycles = collectCycles();
    console.log(`Total cycles collected: ${cycles.length}`);
    
    if (cycles.length === 0) {
        console.log('ERROR: No cycles found in debug archive');
        return;
    }
    
    // Date range
    const earliest = cycles[0].cycleEndTime;
    const latest = cycles[cycles.length - 1].cycleEndTime;
    console.log(`Date range: ${earliest.toISOString()} to ${latest.toISOString()}`);
    
    // Run backtests with different filters
    console.log('\n' + '='.repeat(60));
    console.log('BACKTEST RESULTS');
    console.log('='.repeat(60));
    
    const scenarios = [
        { tierFilter: 'CONVICTION', minConfigVersion: 0, label: 'ALL CONVICTION trades (any config)' },
        { tierFilter: 'CONVICTION', minConfigVersion: 43, label: 'CONVICTION trades (v43+)' },
        { tierFilter: 'CONVICTION', minConfigVersion: 45, label: 'CONVICTION trades (v45 only)' },
        { tierFilter: 'ADVISORY', minConfigVersion: 0, label: 'ALL ADVISORY trades' },
        { tierFilter: 'ALL', minConfigVersion: 0, label: 'ALL tiers (including PROBE)' }
    ];
    
    const results = {};
    
    for (const scenario of scenarios) {
        const result = runBacktest(cycles, {
            startingBalance: 10,
            tierFilter: scenario.tierFilter,
            minConfigVersion: scenario.minConfigVersion,
            maxPositionPct: 0.20
        });
        
        console.log(`\n📊 ${scenario.label}`);
        console.log(`   Trades: ${result.summary.tradesExecuted}`);
        console.log(`   Win Rate: ${result.summary.winRate}`);
        console.log(`   Final Balance: $${result.summary.finalBalance.toFixed(2)} (${result.summary.totalReturn})`);
        console.log(`   Max Drawdown: ${result.summary.maxDrawdown}`);
        console.log(`   Max Win Streak: ${result.summary.maxWinStreak}`);
        console.log(`   Max Loss Streak: ${result.summary.maxLossStreak}`);
        if (result.summary.bust) console.log(`   ⚠️ BUST (balance went to zero)`);
        
        results[scenario.label] = result;
    }
    
    // Asset breakdown
    console.log('\n' + '='.repeat(60));
    console.log('ASSET BREAKDOWN (CONVICTION only)');
    console.log('='.repeat(60));
    
    const convictionResult = results['ALL CONVICTION trades (any config)'];
    for (const [asset, stats] of Object.entries(convictionResult.assetStats)) {
        const total = stats.wins + stats.losses;
        const wr = total > 0 ? (stats.wins / total * 100).toFixed(1) : 'N/A';
        console.log(`   ${asset}: ${stats.wins}W / ${stats.losses}L (${wr}% WR)`);
    }
    
    // Write JSON report
    const reportPath = path.join(__dirname, 'proof_report.json');
    fs.writeFileSync(reportPath, JSON.stringify(results, null, 2));
    console.log(`\n📄 JSON report written to: ${reportPath}`);
    
    // Write markdown report
    const mdPath = path.join(__dirname, 'proof_report.md');
    let md = `# PolyProphet Proof Report\n\n`;
    md += `**Generated**: ${new Date().toISOString()}\n`;
    md += `**Cycles Analyzed**: ${cycles.length}\n`;
    md += `**Date Range**: ${earliest.toISOString().split('T')[0]} to ${latest.toISOString().split('T')[0]}\n\n`;
    
    md += `## Summary\n\n`;
    md += `| Scenario | Trades | Win Rate | Final ($10 start) | Max Drawdown | Max Loss Streak |\n`;
    md += `|----------|--------|----------|-------------------|--------------|------------------|\n`;
    
    for (const [label, result] of Object.entries(results)) {
        md += `| ${label} | ${result.summary.tradesExecuted} | ${result.summary.winRate} | $${result.summary.finalBalance.toFixed(2)} | ${result.summary.maxDrawdown} | ${result.summary.maxLossStreak} |\n`;
    }
    
    md += `\n## Asset Breakdown (CONVICTION)\n\n`;
    md += `| Asset | Wins | Losses | Win Rate |\n`;
    md += `|-------|------|--------|----------|\n`;
    for (const [asset, stats] of Object.entries(convictionResult.assetStats)) {
        const total = stats.wins + stats.losses;
        const wr = total > 0 ? (stats.wins / total * 100).toFixed(1) + '%' : 'N/A';
        md += `| ${asset} | ${stats.wins} | ${stats.losses} | ${wr} |\n`;
    }
    
    md += `\n## Key Findings\n\n`;
    const bestResult = results['CONVICTION trades (v43+)'];
    if (bestResult && bestResult.summary.tradesExecuted > 0) {
        md += `- **Win Rate**: ${bestResult.summary.winRate} on v43+ CONVICTION trades\n`;
        md += `- **Max Drawdown**: ${bestResult.summary.maxDrawdown}\n`;
        md += `- **Max Loss Streak**: ${bestResult.summary.maxLossStreak} trades\n`;
        md += `- **Bust Risk**: ${bestResult.summary.bust ? '⚠️ YES' : '✅ NO'}\n`;
    }
    
    fs.writeFileSync(mdPath, md);
    console.log(`📝 Markdown report written to: ${mdPath}`);
}

main();
