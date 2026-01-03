/**
 * POLYPROPHET Offline Projection Script v70
 * 
 * This script computes empirical projections from backtest results
 * using block-bootstrap resampling to preserve regime clustering.
 * 
 * 🏆 v70: Enhanced to compute returns from pnl/stake when windowStart/End unavailable
 * 🏆 v70: Outputs floor probabilities P(min<3), P(min<2), P(final<5), time-to-100
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
                stakeFrac: data.filters?.stakeFrac || 0.30,
                scan: data.scan || null,
                tradeData: data.trades || []
            });
        } catch (e) {
            console.error(`Error loading ${file}:`, e.message);
        }
    }
    
    return results;
}

// 🏆 v70: Enhanced to compute returns from pnl/stake when windowStart/End unavailable
function extractTradeReturns(trades, defaultStakeFrac = 0.30) {
    const returns = [];
    
    for (const trade of trades) {
        let ret = null;
        
        // Method 1: Use windowStartBalance/windowEndBalance if available
        if (trade.windowStartBalance && trade.windowEndBalance && trade.windowStartBalance > 0) {
            ret = (trade.windowEndBalance - trade.windowStartBalance) / trade.windowStartBalance;
        }
        // Method 2: Compute from pnl/stake (pnl is profit/loss, stake is amount wagered)
        else if (typeof trade.pnl === 'number' && typeof trade.stake === 'number' && trade.stake > 0) {
            // Return as fraction of portfolio = (pnl / stake) * stakeFrac
            // Since pnl is already the profit/loss on the stake, and stake was stakeFrac of balance,
            // portfolio return = pnl / (stake / stakeFrac) = pnl * stakeFrac / stake
            // But more simply: pnl/stake gives the multiplier on the stake portion
            // If stake is 30% of balance, portfolio return = 0.30 * (pnl/stake)
            const stakeReturn = trade.pnl / trade.stake;
            ret = defaultStakeFrac * stakeReturn;
        }
        // Method 3: Binary outcome from isWin and entry price
        else if (typeof trade.isWin === 'boolean' && trade.entryPrice > 0) {
            const effectiveEntry = trade.effectiveEntry || trade.entryPrice;
            if (trade.isWin) {
                // Win payout: (1 - entry) / entry per $1 stake
                const winMultiple = (1 - effectiveEntry) / effectiveEntry;
                ret = defaultStakeFrac * winMultiple * 0.98; // 2% fee
            } else {
                // Loss: lose entire stake portion
                ret = -defaultStakeFrac;
            }
        }
        
        if (ret !== null) {
            returns.push({
                return: ret,
                isWin: trade.isWin,
                entryPrice: trade.effectiveEntry || trade.entryPrice,
                pnl: trade.pnl,
                stake: trade.stake,
                method: trade.windowStartBalance ? 'balance' : (trade.pnl !== undefined ? 'pnl' : 'binary')
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
        let reachedFirst100AtTrade = null;
        let tradeCount = 0;
        
        // Sample blocks
        for (let b = 0; b < numBlocks; b++) {
            const startIdx = Math.floor(Math.random() * (returns.length - blockSize + 1));
            for (let i = 0; i < blockSize && startIdx + i < returns.length; i++) {
                const r = returns[startIdx + i];
                balance *= (1 + r.return);
                balance = Math.max(0, balance); // Can't go negative
                minBalance = Math.min(minBalance, balance);
                maxBalance = Math.max(maxBalance, balance);
                tradeCount++;
                
                // Track when £100 is first reached
                if (balance >= 100 && reachedFirst100AtTrade === null) {
                    reachedFirst100AtTrade = tradeCount;
                }
            }
        }
        
        results.push({
            final: balance,
            min: minBalance,
            max: maxBalance,
            maxDD: maxBalance > 0 ? (maxBalance - minBalance) / maxBalance : 1,
            reachedFirst100AtTrade
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
    console.log('POLYPROPHET Offline Projection Analysis v70');
    console.log('='.repeat(60));
    
    const backtests = loadBacktests();
    console.log(`\nLoaded ${backtests.length} backtest files\n`);
    
    if (backtests.length === 0) {
        console.error('No backtest files found! Run backtests first.');
        return;
    }
    
    // Summary table
    console.log('BACKTEST SUMMARY:');
    console.log('-'.repeat(90));
    for (const bt of backtests) {
        console.log(`${bt.file.padEnd(25)} | Trades: ${bt.trades.toString().padStart(3)} | WR: ${(bt.winRate * 100).toFixed(1)}% | Final: £${bt.finalBalance.toFixed(2).padStart(8)} | DD: ${(bt.maxDrawdown * 100).toFixed(1)}%`);
    }
    
    // Find the most comprehensive backtest for projections
    const bestBacktest = backtests.reduce((best, bt) => 
        bt.trades > best.trades ? bt : best, backtests[0]);
    
    console.log(`\nUsing ${bestBacktest.file} for projections (${bestBacktest.trades} trades, stake=${bestBacktest.stakeFrac})\n`);
    
    // Extract returns
    const returns = extractTradeReturns(bestBacktest.tradeData, bestBacktest.stakeFrac);
    console.log(`Extracted ${returns.length} trade returns`);
    
    // Report extraction methods
    const methodCounts = returns.reduce((acc, r) => {
        acc[r.method] = (acc[r.method] || 0) + 1;
        return acc;
    }, {});
    console.log(`Extraction methods: ${JSON.stringify(methodCounts)}\n`);
    
    if (returns.length < 10) {
        console.error('Insufficient trade data for projections (need at least 10 trades)');
        return;
    }
    
    // Calculate empirical statistics
    const winRate = returns.filter(r => r.isWin).length / returns.length;
    const avgReturn = returns.reduce((s, r) => s + r.return, 0) / returns.length;
    const winReturns = returns.filter(r => r.isWin);
    const lossReturns = returns.filter(r => !r.isWin);
    const avgWinReturn = winReturns.length > 0 ? winReturns.reduce((s, r) => s + r.return, 0) / winReturns.length : 0;
    const avgLossReturn = lossReturns.length > 0 ? lossReturns.reduce((s, r) => s + r.return, 0) / lossReturns.length : 0;
    
    console.log('EMPIRICAL TRADE STATISTICS:');
    console.log('-'.repeat(50));
    console.log(`Win Rate: ${(winRate * 100).toFixed(1)}%`);
    console.log(`Avg Return per Trade: ${(avgReturn * 100).toFixed(2)}%`);
    console.log(`Avg Win Return: ${(avgWinReturn * 100).toFixed(2)}%`);
    console.log(`Avg Loss Return: ${(avgLossReturn * 100).toFixed(2)}%`);
    
    // Run projections for different time horizons
    // Approximately 25 trades per day based on backtests
    const horizons = [
        { name: '24h', blocks: 8, blockSize: 3 },   // ~24 trades
        { name: '48h', blocks: 16, blockSize: 3 },  // ~48 trades
        { name: '72h', blocks: 24, blockSize: 3 },  // ~72 trades
        { name: '7d', blocks: 35, blockSize: 3 }    // ~105 trades
    ];
    
    const projections = {};
    
    console.log('\n🏆 v70 PROJECTIONS (1000 simulations, block bootstrap):');
    console.log('-'.repeat(100));
    console.log('Horizon | P10 (Worst) | P50 (Median) | P90 (Best) | £100+ | Final<£5 | Min<£3 | Min<£2 | DD p50');
    console.log('-'.repeat(100));
    
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
        
        // Time to £100 statistics
        const reach100Sims = sims.filter(s => s.reachedFirst100AtTrade !== null);
        const medianTradesToReach100 = reach100Sims.length > 0 
            ? percentile(reach100Sims.map(s => s.reachedFirst100AtTrade), 0.50) 
            : null;
        
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
            ddP99: (ddP99 * 100).toFixed(1),
            medianTradesToReach100
        };
        
        console.log(`${h.name.padEnd(7)} | £${p10.toFixed(2).padStart(9)} | £${p50.toFixed(2).padStart(10)} | £${p90.toFixed(2).padStart(9)} | ${(reach100 * 100).toFixed(0).padStart(4)}% | ${(belowStart * 100).toFixed(0).padStart(7)}% | ${(min3 * 100).toFixed(0).padStart(5)}% | ${(min2 * 100).toFixed(0).padStart(5)}% | ${(ddP50 * 100).toFixed(0).padStart(3)}%`);
    }
    
    console.log('-'.repeat(100));
    
    // Floor analysis summary
    console.log('\n🏆 v70 FLOOR RISK ANALYSIS:');
    console.log('-'.repeat(60));
    console.log(`P(ever drop below £3): ${projections['72h'].dropBelow3Pct}% (72h window)`);
    console.log(`P(ever drop below £2): ${projections['72h'].dropBelow2Pct}% (72h window)`);
    console.log(`P(finish below £5):    ${projections['72h'].belowStartPct}% (72h window)`);
    console.log(`P(reach £100 in 72h):  ${projections['72h'].reach100Pct}%`);
    
    // Save results
    const output = {
        generatedAt: new Date().toISOString(),
        version: 'v70',
        method: 'Block bootstrap resampling from empirical trade returns',
        source: bestBacktest.file,
        empiricalStats: {
            winRate: (winRate * 100).toFixed(1) + '%',
            avgReturnPerTrade: (avgReturn * 100).toFixed(2) + '%',
            avgWinReturn: (avgWinReturn * 100).toFixed(2) + '%',
            avgLossReturn: (avgLossReturn * 100).toFixed(2) + '%',
            totalTrades: returns.length,
            extractionMethods: methodCounts
        },
        projections,
        floorRiskAnalysis: {
            '72h': {
                probDropBelow3: projections['72h'].dropBelow3Pct + '%',
                probDropBelow2: projections['72h'].dropBelow2Pct + '%',
                probFinishBelowStart: projections['72h'].belowStartPct + '%',
                probReach100: projections['72h'].reach100Pct + '%'
            },
            '7d': {
                probDropBelow3: projections['7d'].dropBelow3Pct + '%',
                probDropBelow2: projections['7d'].dropBelow2Pct + '%',
                probFinishBelowStart: projections['7d'].belowStartPct + '%',
                probReach100: projections['7d'].reach100Pct + '%'
            }
        },
        interpretation: {
            '24h': `${projections['24h'].reach100Pct}% chance of reaching £100, ${projections['24h'].dropBelow3Pct}% chance of dropping below £3`,
            '48h': `${projections['48h'].reach100Pct}% chance of reaching £100, ${projections['48h'].dropBelow3Pct}% chance of dropping below £3`,
            '72h': `${projections['72h'].reach100Pct}% chance of reaching £100, ${projections['72h'].dropBelow3Pct}% chance of dropping below £3`,
            '7d': `${projections['7d'].reach100Pct}% chance of reaching £100, ${projections['7d'].dropBelow3Pct}% chance of dropping below £3`
        },
        disclaimer: 'Projections based on block-bootstrap resampling of historical trade returns. Past performance does not guarantee future results. The balance floor guard in v70 may alter these outcomes by halting trades when balance drops below £2.'
    };
    
    fs.writeFileSync(
        path.join(__dirname, '_final_projections.json'),
        JSON.stringify(output, null, 2)
    );
    
    console.log('\n✅ Results saved to _final_projections.json');
}

runAnalysis();
