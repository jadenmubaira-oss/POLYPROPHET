/**
 * POLYPROPHET Offline Projection Script
 * 
 * This script computes empirical projections from backtest results
 * using block-bootstrap resampling to preserve regime clustering.
 * 
 * Usage: node analyze_projections.js
 * 
 * Reads: _backtest_*.json files
 * Writes: _final_projections.json
 */

const fs = require('fs');
const path = require('path');

// Load backtest results
function loadBacktests() {
    const dir = __dirname;
    const files = fs.readdirSync(dir).filter(f => f.startsWith('_backtest_') && f.endsWith('.json'));
    const results = [];
    
    for (const file of files) {
        try {
            let content = fs.readFileSync(path.join(dir, file), 'utf8');
            // Strip UTF-8 BOM if present
            if (content.charCodeAt(0) === 0xFEFF) {
                content = content.slice(1);
            }
            const data = JSON.parse(content);
            results.push({
                file,
                lookbackHours: data.summary.lookbackHours || data.filters?.lookbackHours,
                trades: data.summary.totalTrades,
                winRate: parseFloat(data.summary.winRate) / 100,
                avgPnlPerTrade: data.summary.avgPnlPerTrade,
                finalBalance: data.summary.finalBalance,
                maxDrawdown: parseFloat(data.summary.maxDrawdown) / 100,
                scan: data.scan || null,
                tradeData: data.trades || []
            });
        } catch (e) {
            console.error(`Error loading ${file}:`, e.message);
        }
    }
    
    return results;
}

// Extract per-trade returns from backtest data
function extractTradeReturns(trades) {
    const returns = [];
    for (const trade of trades) {
        if (trade.windowStartBalance && trade.windowEndBalance) {
            const ret = (trade.windowEndBalance - trade.windowStartBalance) / trade.windowStartBalance;
            returns.push({
                return: ret,
                isWin: trade.isWin,
                entryPrice: trade.effectiveEntry || trade.entryPrice,
                pnl: trade.pnl
            });
        }
    }
    return returns;
}

// Block bootstrap resampling
function blockBootstrap(returns, blockSize = 5, numBlocks = 20, simulations = 1000) {
    if (returns.length < blockSize) {
        console.warn('Insufficient data for block bootstrap, using simple bootstrap');
        blockSize = 1;
    }
    
    const results = [];
    
    for (let sim = 0; sim < simulations; sim++) {
        let balance = 5.0; // Starting balance
        let minBalance = balance;
        let maxBalance = balance;
        const balanceHistory = [balance];
        
        // Sample blocks
        for (let b = 0; b < numBlocks; b++) {
            const startIdx = Math.floor(Math.random() * (returns.length - blockSize + 1));
            for (let i = 0; i < blockSize && startIdx + i < returns.length; i++) {
                const r = returns[startIdx + i];
                balance *= (1 + r.return);
                balance = Math.max(0, balance); // Can't go negative
                minBalance = Math.min(minBalance, balance);
                maxBalance = Math.max(maxBalance, balance);
                balanceHistory.push(balance);
            }
        }
        
        results.push({
            final: balance,
            min: minBalance,
            max: maxBalance,
            maxDD: maxBalance > 0 ? (maxBalance - minBalance) / maxBalance : 1
        });
    }
    
    return results;
}

// Calculate percentiles
function percentile(arr, p) {
    const sorted = [...arr].sort((a, b) => a - b);
    const idx = Math.floor(sorted.length * p);
    return sorted[Math.min(idx, sorted.length - 1)];
}

// Main analysis
function runAnalysis() {
    console.log('POLYPROPHET Offline Projection Analysis');
    console.log('='.repeat(50));
    
    const backtests = loadBacktests();
    console.log(`\nLoaded ${backtests.length} backtest files\n`);
    
    // Summary table
    console.log('BACKTEST SUMMARY:');
    console.log('-'.repeat(80));
    for (const bt of backtests) {
        console.log(`${bt.file.padEnd(25)} | Trades: ${bt.trades.toString().padStart(3)} | WR: ${(bt.winRate * 100).toFixed(1)}% | Final: £${bt.finalBalance.toFixed(2).padStart(8)} | DD: ${(bt.maxDrawdown * 100).toFixed(1)}%`);
    }
    
    // Find the most comprehensive backtest for projections
    const bestBacktest = backtests.reduce((best, bt) => 
        bt.trades > best.trades ? bt : best, backtests[0]);
    
    console.log(`\nUsing ${bestBacktest.file} for projections (${bestBacktest.trades} trades)\n`);
    
    // Extract returns
    const returns = extractTradeReturns(bestBacktest.tradeData);
    console.log(`Extracted ${returns.length} trade returns\n`);
    
    if (returns.length < 10) {
        console.error('Insufficient trade data for projections');
        return;
    }
    
    // Calculate empirical statistics
    const winRate = returns.filter(r => r.isWin).length / returns.length;
    const avgReturn = returns.reduce((s, r) => s + r.return, 0) / returns.length;
    const avgWinReturn = returns.filter(r => r.isWin).reduce((s, r, _, a) => s + r.return / a.length, 0);
    const avgLossReturn = returns.filter(r => !r.isWin).reduce((s, r, _, a) => s + r.return / a.length, 0);
    
    console.log('EMPIRICAL TRADE STATISTICS:');
    console.log('-'.repeat(50));
    console.log(`Win Rate: ${(winRate * 100).toFixed(1)}%`);
    console.log(`Avg Return per Trade: ${(avgReturn * 100).toFixed(2)}%`);
    console.log(`Avg Win Return: ${(avgWinReturn * 100).toFixed(2)}%`);
    console.log(`Avg Loss Return: ${(avgLossReturn * 100).toFixed(2)}%`);
    
    // Run projections for different time horizons
    const horizons = [
        { name: '24h', blocks: 8, blockSize: 3 },   // ~24 trades
        { name: '48h', blocks: 16, blockSize: 3 },  // ~48 trades
        { name: '72h', blocks: 24, blockSize: 3 },  // ~72 trades
        { name: '7d', blocks: 35, blockSize: 3 }    // ~105 trades
    ];
    
    const projections = {};
    
    console.log('\nPROJECTIONS (1000 simulations, block bootstrap):');
    console.log('-'.repeat(80));
    
    for (const h of horizons) {
        const sims = blockBootstrap(returns, h.blockSize, h.blocks, 1000);
        const finals = sims.map(s => s.final);
        const mins = sims.map(s => s.min);
        const dds = sims.map(s => s.maxDD);
        
        const p10 = percentile(finals, 0.10);
        const p50 = percentile(finals, 0.50);
        const p90 = percentile(finals, 0.90);
        const reach100 = finals.filter(f => f >= 100).length / finals.length;
        const belowStart = finals.filter(f => f < 5).length / finals.length;
        const min3 = mins.filter(m => m < 3).length / mins.length;
        const min2 = mins.filter(m => m < 2).length / mins.length;
        const ddP50 = percentile(dds, 0.50);
        const ddP90 = percentile(dds, 0.90);
        const ddP99 = percentile(dds, 0.99);
        
        projections[h.name] = {
            trades: h.blocks * h.blockSize,
            p10: p10.toFixed(2),
            p50: p50.toFixed(2),
            p90: p90.toFixed(2),
            reach100Pct: (reach100 * 100).toFixed(1),
            belowStartPct: (belowStart * 100).toFixed(1),
            dropBelow3Pct: (min3 * 100).toFixed(1),
            dropBelow2Pct: (min2 * 100).toFixed(1),
            ddP50: (ddP50 * 100).toFixed(1),
            ddP90: (ddP90 * 100).toFixed(1),
            ddP99: (ddP99 * 100).toFixed(1)
        };
        
        console.log(`${h.name.padEnd(4)} | P10: £${p10.toFixed(2).padStart(7)} | P50: £${p50.toFixed(2).padStart(7)} | P90: £${p90.toFixed(2).padStart(8)} | £100+: ${(reach100 * 100).toFixed(0)}% | <£3: ${(min3 * 100).toFixed(0)}%`);
    }
    
    // Save results
    const output = {
        generatedAt: new Date().toISOString(),
        method: 'Block bootstrap resampling from empirical trade returns',
        source: bestBacktest.file,
        empiricalStats: {
            winRate: (winRate * 100).toFixed(1) + '%',
            avgReturnPerTrade: (avgReturn * 100).toFixed(2) + '%',
            totalTrades: returns.length
        },
        projections,
        interpretation: {
            '24h': `${projections['24h'].reach100Pct}% chance of reaching £100, ${projections['24h'].dropBelow3Pct}% chance of dropping below £3`,
            '48h': `${projections['48h'].reach100Pct}% chance of reaching £100, ${projections['48h'].dropBelow3Pct}% chance of dropping below £3`,
            '72h': `${projections['72h'].reach100Pct}% chance of reaching £100, ${projections['72h'].dropBelow3Pct}% chance of dropping below £3`
        },
        disclaimer: 'Projections based on block-bootstrap resampling of historical trade returns. Past performance does not guarantee future results.'
    };
    
    fs.writeFileSync(
        path.join(__dirname, '_final_projections.json'),
        JSON.stringify(output, null, 2)
    );
    
    console.log('\nResults saved to _final_projections.json');
}

runAnalysis();
