/**
 * BACKTEST: MAXIMUM PROFIT OPTIMIZATION
 * 
 * Tests the optimized system with increased position sizes, win streak exploitation, and price optimization
 */

const fs = require('fs');
const path = require('path');

const CONFIG = {
    EV: { fees: 0.02 },
    RISK: { k_frac: 0.5, minTradeSize: 1.10 },
    STARTING_BALANCE: 5.00
};

function simulateOptimizedTrades(logData, asset, cycleData, startingBalance, winStreak) {
    // Check if this is a PERFECT or NEAR PERFECT pattern
    const modelAgreement = cycleData.modelAgreementHistory || [];
    const allAgree = modelAgreement.length >= 3 && 
        modelAgreement.every(v => v === modelAgreement[0] && v !== null);
    const certainty = cycleData.certaintyAtEnd || 0;
    const oracleLocked = cycleData.oracleWasLocked || false;
    const tier = cycleData.tier || 'NONE';
    const prediction = cycleData.prediction;
    const wasCorrect = cycleData.wasCorrect;
    const marketOdds = cycleData.marketOdds || { yesPrice: 0.5, noPrice: 0.5 };
    
    // PERFECT pattern: All models agree + Certainty ≥75 + Oracle Lock + CONVICTION
    const isPerfect = allAgree && certainty >= 75 && oracleLocked && tier === 'CONVICTION';
    
    // NEAR PERFECT pattern: All models agree + Certainty ≥70 + CONVICTION
    const isNearPerfect = allAgree && certainty >= 70 && tier === 'CONVICTION' && !isPerfect;
    
    // Only trade on PERFECT or NEAR PERFECT
    if (!isPerfect && !isNearPerfect) {
        return { balance: startingBalance, traded: false, reason: 'NOT_PERFECT_PATTERN', winStreak: 0 };
    }
    
    if (prediction === 'WAIT' || prediction === 'NEUTRAL' || !prediction) {
        return { balance: startingBalance, traded: false, reason: 'NO_PREDICTION', winStreak: 0 };
    }
    
    const marketPrice = prediction === 'UP' ? marketOdds.yesPrice : marketOdds.noPrice;
    
    // OPTIMIZED Position sizing with win streak and price optimization
    let sizePct;
    if (isPerfect) {
        sizePct = 0.65; // Base 65% (increased from 45%)
        
        // Win streak exploitation
        if (winStreak >= 2) {
            sizePct = Math.min(0.85, sizePct + (winStreak * 0.03)); // Up to 85% on streaks
        }
        
        // Price optimization
        if (marketPrice < 0.20 && marketPrice > 0.01) {
            const priceMultiplier = (0.20 - marketPrice) / 0.20;
            sizePct = Math.min(0.80, sizePct + (priceMultiplier * 0.15)); // Up to 15% bonus
        }
    } else { // NEAR PERFECT
        sizePct = 0.55; // Base 55% (increased from 35%)
        
        // Win streak exploitation
        if (winStreak >= 2) {
            sizePct = Math.min(0.75, sizePct + (winStreak * 0.03)); // Up to 75% on streaks
        }
        
        // Price optimization
        if (marketPrice < 0.20 && marketPrice > 0.01) {
            const priceMultiplier = (0.20 - marketPrice) / 0.20;
            sizePct = Math.min(0.70, sizePct + (priceMultiplier * 0.15));
        }
    }
    
    const tradeSize = startingBalance * sizePct;
    
    if (tradeSize < CONFIG.RISK.minTradeSize) {
        return { balance: startingBalance, traded: false, reason: 'BELOW_MIN_SIZE', tradeSize, winStreak: 0 };
    }
    
    // Execute trade (100% win rate expected)
    const entryPrice = marketPrice;
    const exitPrice = wasCorrect ? 1.0 : 0.0;
    const pnl = (exitPrice - entryPrice) * (tradeSize / entryPrice);
    const newBalance = startingBalance + pnl;
    
    // Update win streak
    const newWinStreak = wasCorrect ? winStreak + 1 : 0;
    
    return {
        balance: newBalance,
        traded: true,
        pattern: isPerfect ? 'PERFECT' : 'NEAR_PERFECT',
        prediction,
        wasCorrect,
        entryPrice,
        exitPrice,
        tradeSize,
        sizePct,
        pnl,
        pnlPercent: (pnl / tradeSize) * 100,
        certainty,
        oracleLocked,
        winStreak: newWinStreak
    };
}

function runMaximumProfitBacktest() {
    console.log('🚀 Starting MAXIMUM PROFIT Backtest (Optimized System)...\n');
    
    const files = fs.readdirSync('debug')
        .filter(f => f.endsWith('.json'))
        .sort()
        .slice(-20);
    
    console.log(`Loaded ${files.length} debug logs\n`);
    
    let balance = CONFIG.STARTING_BALANCE;
    const trades = [];
    const assets = ['BTC', 'ETH', 'SOL', 'XRP'];
    const winStreaks = {}; // Per-asset win streaks
    
    let totalCycles = 0;
    let perfectCycles = 0;
    let nearPerfectCycles = 0;
    let tradedCycles = 0;
    let correctTrades = 0;
    let incorrectTrades = 0;
    
    files.forEach((file, logIdx) => {
        try {
            const logData = JSON.parse(fs.readFileSync(path.join('debug', file), 'utf8'));
            
            assets.forEach(asset => {
                if (!winStreaks[asset]) winStreaks[asset] = 0;
                
                const assetData = logData.assets?.[asset];
                if (!assetData) return;
                
                const cycleHistory = assetData.cycleHistory || [];
                cycleHistory.forEach(cycle => {
                    totalCycles++;
                    
                    const result = simulateOptimizedTrades(logData, asset, cycle, balance, winStreaks[asset]);
                    
                    if (result.traded) {
                        tradedCycles++;
                        balance = result.balance;
                        winStreaks[asset] = result.winStreak;
                        
                        if (result.pattern === 'PERFECT') perfectCycles++;
                        else if (result.pattern === 'NEAR_PERFECT') nearPerfectCycles++;
                        
                        if (result.wasCorrect) {
                            correctTrades++;
                        } else {
                            incorrectTrades++;
                            winStreaks[asset] = 0; // Reset on loss
                        }
                        
                        trades.push({
                            log: logIdx,
                            asset,
                            ...result
                        });
                    }
                });
            });
        } catch (e) {
            console.error(`Error processing ${file}: ${e.message}`);
        }
    });
    
    // Calculate statistics
    const winRate = correctTrades / (correctTrades + incorrectTrades) || 0;
    const totalReturn = ((balance / CONFIG.STARTING_BALANCE) - 1) * 100;
    const avgWin = trades.filter(t => t.pnl > 0).reduce((sum, t) => sum + t.pnl, 0) / correctTrades || 0;
    const avgLoss = trades.filter(t => t.pnl < 0).reduce((sum, t) => sum + Math.abs(t.pnl), 0) / incorrectTrades || 0;
    const avgSizePct = trades.reduce((sum, t) => sum + (t.sizePct || 0), 0) / trades.length || 0;
    
    // Find max drawdown
    let peak = CONFIG.STARTING_BALANCE;
    let maxDrawdown = 0;
    let currentBalance = CONFIG.STARTING_BALANCE;
    
    trades.forEach(trade => {
        currentBalance = trade.balance;
        if (currentBalance > peak) peak = currentBalance;
        const drawdown = (peak - currentBalance) / peak;
        if (drawdown > maxDrawdown) maxDrawdown = drawdown;
    });
    
    console.log('═══════════════════════════════════════════════════════');
    console.log('📊 MAXIMUM PROFIT BACKTEST RESULTS');
    console.log('═══════════════════════════════════════════════════════\n');
    
    console.log(`Starting Balance: £${CONFIG.STARTING_BALANCE.toFixed(2)}`);
    console.log(`Final Balance: £${balance.toFixed(2)}`);
    console.log(`Total Return: ${totalReturn.toFixed(2)}%`);
    console.log(`\nTotal Cycles Analyzed: ${totalCycles}`);
    console.log(`PERFECT Patterns: ${perfectCycles}`);
    console.log(`NEAR PERFECT Patterns: ${nearPerfectCycles}`);
    console.log(`Trades Executed: ${tradedCycles}`);
    console.log(`\nWin Rate: ${(winRate * 100).toFixed(2)}%`);
    console.log(`Correct Trades: ${correctTrades}`);
    console.log(`Incorrect Trades: ${incorrectTrades}`);
    console.log(`\nAverage Win: £${avgWin.toFixed(2)}`);
    console.log(`Average Loss: £${avgLoss.toFixed(2)}`);
    console.log(`Average Position Size: ${(avgSizePct * 100).toFixed(1)}%`);
    console.log(`Win/Loss Ratio: ${(avgWin / avgLoss || 0).toFixed(2)}`);
    console.log(`\nMax Drawdown: ${(maxDrawdown * 100).toFixed(2)}%`);
    
    // Compare to previous backtest
    const previousFinal = 297.06;
    const improvement = ((balance - previousFinal) / previousFinal) * 100;
    
    console.log(`\n═══════════════════════════════════════════════════════`);
    console.log('📈 OPTIMIZATION IMPROVEMENT');
    console.log('═══════════════════════════════════════════════════════\n');
    console.log(`Previous (45%/35% sizing): £${previousFinal.toFixed(2)}`);
    console.log(`Optimized (65-85%/55-75% sizing): £${balance.toFixed(2)}`);
    console.log(`Improvement: ${improvement.toFixed(1)}%`);
    
    // Project forward
    const days = 10.1;
    const tradesPerDay = tradedCycles / days;
    const dailyReturn = (balance / CONFIG.STARTING_BALANCE) ** (1 / days) - 1;
    
    console.log(`\n═══════════════════════════════════════════════════════`);
    console.log('📈 PROJECTED PERFORMANCE (OPTIMIZED)');
    console.log('═══════════════════════════════════════════════════════\n');
    
    console.log(`Trades Per Day: ${tradesPerDay.toFixed(1)}`);
    console.log(`Daily Return: ${(dailyReturn * 100).toFixed(2)}%`);
    
    // 7-day projection
    const balance7d = CONFIG.STARTING_BALANCE * ((1 + dailyReturn) ** 7);
    console.log(`\n7-Day Projection: £${balance7d.toFixed(2)} (${(((balance7d / CONFIG.STARTING_BALANCE) - 1) * 100).toFixed(2)}% return)`);
    
    // 30-day projection
    const balance30d = CONFIG.STARTING_BALANCE * ((1 + dailyReturn) ** 30);
    console.log(`30-Day Projection: £${balance30d.toFixed(2)} (${(((balance30d / CONFIG.STARTING_BALANCE) - 1) * 100).toFixed(2)}% return)`);
    
    console.log(`\n═══════════════════════════════════════════════════════`);
    console.log('✅ BACKTEST COMPLETE');
    console.log('═══════════════════════════════════════════════════════\n');
    
    return {
        startingBalance: CONFIG.STARTING_BALANCE,
        finalBalance: balance,
        totalReturn,
        improvement,
        tradesPerDay,
        dailyReturn,
        balance7d,
        balance30d
    };
}

if (require.main === module) {
    runMaximumProfitBacktest();
}

module.exports = { runMaximumProfitBacktest };

