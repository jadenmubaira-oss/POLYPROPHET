/**
 * REALISTIC PERFORMANCE ANALYSIS
 * Analyzes ALL debug logs to get ACTUAL win rate and performance
 */

const fs = require('fs');
const path = require('path');

function analyzeAllLogs() {
    console.log('🔬 ANALYZING ALL DEBUG LOGS FOR REAL PERFORMANCE\n');
    
    // Try multiple possible paths
    const possiblePaths = [
        'POLYPROPHET-2d998c92e045c0110cc2864b53e62c70e0ccefbd/debug',
        'debug',
        './debug',
        '../debug'
    ];
    
    let debugDir = null;
    for (const p of possiblePaths) {
        if (fs.existsSync(p)) {
            debugDir = p;
            break;
        }
    }
    
    if (!debugDir) {
        console.error('❌ Could not find debug directory');
        return null;
    }
    const files = fs.readdirSync(debugDir)
        .filter(f => f.endsWith('.json'))
        .sort();
    
    console.log(`Found ${files.length} debug logs\n`);
    
    let totalTrades = 0;
    let winningTrades = 0;
    let losingTrades = 0;
    let totalPnL = 0;
    const trades = [];
    const assets = ['BTC', 'ETH', 'SOL', 'XRP'];
    
    files.forEach((file, idx) => {
        try {
            const logData = JSON.parse(fs.readFileSync(path.join(debugDir, file), 'utf8'));
            const tradeHistory = logData.tradeExecutor?.tradeHistory || [];
            
            tradeHistory.forEach(trade => {
                if (trade.status === 'CLOSED' && trade.pnl !== undefined) {
                    totalTrades++;
                    totalPnL += trade.pnl;
                    
                    if (trade.pnl > 0) {
                        winningTrades++;
                    } else if (trade.pnl < 0) {
                        losingTrades++;
                    }
                    
                    trades.push({
                        asset: trade.asset,
                        pnl: trade.pnl,
                        pnlPercent: trade.pnlPercent,
                        entry: trade.entry,
                        exit: trade.exit,
                        reason: trade.reason,
                        timestamp: trade.closeTime || trade.time
                    });
                }
            });
        } catch (e) {
            console.error(`Error processing ${file}: ${e.message}`);
        }
    });
    
    const winRate = totalTrades > 0 ? (winningTrades / totalTrades) * 100 : 0;
    const avgWin = winningTrades > 0 ? 
        trades.filter(t => t.pnl > 0).reduce((sum, t) => sum + t.pnl, 0) / winningTrades : 0;
    const avgLoss = losingTrades > 0 ?
        trades.filter(t => t.pnl < 0).reduce((sum, t) => sum + Math.abs(t.pnl), 0) / losingTrades : 0;
    
    console.log('═══════════════════════════════════════════════════════');
    console.log('📊 REAL PERFORMANCE ANALYSIS');
    console.log('═══════════════════════════════════════════════════════\n');
    
    console.log(`Total Trades: ${totalTrades}`);
    console.log(`Winning Trades: ${winningTrades}`);
    console.log(`Losing Trades: ${losingTrades}`);
    console.log(`Win Rate: ${winRate.toFixed(2)}%`);
    console.log(`\nTotal P/L: $${totalPnL.toFixed(2)}`);
    console.log(`Average Win: $${avgWin.toFixed(2)}`);
    console.log(`Average Loss: $${avgLoss.toFixed(2)}`);
    console.log(`Win/Loss Ratio: ${(avgWin / avgLoss || 0).toFixed(2)}`);
    
    // Analyze by asset
    console.log(`\n═══════════════════════════════════════════════════════`);
    console.log('📊 PERFORMANCE BY ASSET');
    console.log('═══════════════════════════════════════════════════════\n');
    
    assets.forEach(asset => {
        const assetTrades = trades.filter(t => t.asset === asset);
        const assetWins = assetTrades.filter(t => t.pnl > 0).length;
        const assetLosses = assetTrades.filter(t => t.pnl < 0).length;
        const assetPnL = assetTrades.reduce((sum, t) => sum + t.pnl, 0);
        const assetWinRate = assetTrades.length > 0 ? (assetWins / assetTrades.length) * 100 : 0;
        
        console.log(`${asset}:`);
        console.log(`  Trades: ${assetTrades.length}`);
        console.log(`  Wins: ${assetWins}, Losses: ${assetLosses}`);
        console.log(`  Win Rate: ${assetWinRate.toFixed(2)}%`);
        console.log(`  Total P/L: $${assetPnL.toFixed(2)}`);
        console.log('');
    });
    
    // Show some example losing trades
    const losses = trades.filter(t => t.pnl < 0).slice(0, 5);
    if (losses.length > 0) {
        console.log('═══════════════════════════════════════════════════════');
        console.log('❌ EXAMPLE LOSSES (First 5)');
        console.log('═══════════════════════════════════════════════════════\n');
        losses.forEach(t => {
            console.log(`${t.asset}: Entry ${(t.entry * 100).toFixed(1)}¢ → Exit ${(t.exit * 100).toFixed(1)}¢`);
            console.log(`  P/L: $${t.pnl.toFixed(2)} (${t.pnlPercent.toFixed(1)}%)`);
            console.log(`  Reason: ${t.reason}`);
            console.log('');
        });
    }
    
    return {
        totalTrades,
        winningTrades,
        losingTrades,
        winRate,
        totalPnL,
        avgWin,
        avgLoss,
        trades
    };
}

if (require.main === module) {
    analyzeAllLogs();
}

module.exports = { analyzeAllLogs };

