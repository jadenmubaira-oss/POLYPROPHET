/**
 * COMPREHENSIVE BACKTEST ON ALL DEBUG LOGS
 * 
 * Tests the improved trading logic on historical data
 */

const fs = require('fs');
const path = require('path');

// Import the improved modules
const StateMachine = require('./src/state');
const EVEngine = require('./src/ev');
const RiskEngine = require('./src/risk');
const SupremeBrain = require('./src/supreme_brain');

const CONFIG = {
    EV: { fees: 0.02 },
    RISK: { k_frac: 0.5, minTradeSize: 1.10 },
    STATE: { observeWindowMinutes: 30, strikeGates: { N: 3, M: 4, T: 180, S: 0.08 } },
    ORACLE: { minConfidence: 0.50, minEdge: 0.01, maxOdds: 0.70, minElapsedSeconds: 10, oracleLockImmediate: true }
};

function loadAllDebugLogs() {
    const debugDir = path.join(__dirname, 'debug');
    const files = fs.readdirSync(debugDir)
        .filter(f => f.endsWith('.json'))
        .sort()
        .slice(-20); // Last 20 logs for comprehensive test
    
    const logs = [];
    files.forEach(file => {
        try {
            const data = JSON.parse(fs.readFileSync(path.join(debugDir, file), 'utf8'));
            logs.push(data);
        } catch (e) {
            console.error(`Failed to load ${file}: ${e.message}`);
        }
    });
    
    return logs;
}

function simulateCycle(logData, asset, cycleData, startingBalance) {
    const evEngine = new EVEngine(CONFIG.EV);
    const riskEngine = new RiskEngine(CONFIG.RISK);
    const stateMachine = new StateMachine(CONFIG.STATE);
    
    // Extract cycle data
    const prediction = cycleData.prediction;
    const confidence = cycleData.confidence || 0;
    const tier = cycleData.tier || 'NONE';
    const oracleLocked = cycleData.oracleWasLocked || false;
    const wasCorrect = cycleData.wasCorrect;
    const marketOdds = cycleData.marketOdds || { yesPrice: 0.5, noPrice: 0.5 };
    
    // Skip if no prediction
    if (prediction === 'WAIT' || prediction === 'NEUTRAL' || !prediction) {
        return { balance: startingBalance, traded: false, reason: 'NO_PREDICTION' };
    }
    
    // Calculate EV
    const marketPrice = prediction === 'UP' ? marketOdds.yesPrice : marketOdds.noPrice;
    
    // Estimate velocity (simplified - use confidence as proxy)
    const velocityScore = Math.min(1.0, confidence * 1.2);
    const winRate = 0.70; // Historical win rate from logs
    
    // CRITICAL: Use improved p_hat estimation
    let p_hat = (confidence * 0.65) + (velocityScore * 0.25) + (winRate * 0.10);
    if (confidence >= 0.94) p_hat = Math.min(0.98, p_hat * 1.15);
    if (confidence >= 0.85) p_hat = Math.min(0.95, p_hat * 1.10);
    p_hat = Math.max(0.01, Math.min(0.99, p_hat));
    
    const evMetrics = evEngine.calculate(p_hat, marketPrice);
    
    // Check if should trade (IMPROVED LOGIC)
    const shouldTrade = 
        (oracleLocked && evMetrics.ev > 0) ||
        (tier === 'CONVICTION' && evMetrics.ev > 0) ||
        (tier === 'ADVISORY' && evMetrics.ev > 0.02 && confidence >= 0.60) ||
        (evMetrics.ev > 0.02 && confidence >= CONFIG.ORACLE.minConfidence);
    
    if (!shouldTrade || evMetrics.ev <= 0 || marketPrice > CONFIG.ORACLE.maxOdds) {
        return { balance: startingBalance, traded: false, reason: 'EV_GATE', ev: evMetrics.ev, confidence };
    }
    
    // Update state machine
    const currentState = stateMachine.update(asset, {
        velocity: confidence,
        spread: Math.abs(marketOdds.yesPrice - marketOdds.noPrice),
        timeToEnd: 600, // Assume mid-cycle
        edge: evMetrics.edge,
        p_win: p_hat,
        p_market: marketPrice,
        ev: evMetrics.ev
    });
    
    // Calculate size
    const sizePct = riskEngine.calculateSize(
        startingBalance,
        evMetrics.ev,
        currentState,
        p_hat,
        marketPrice,
        confidence,
        oracleLocked
    );
    
    if (sizePct <= 0) {
        return { balance: startingBalance, traded: false, reason: 'SIZE_TOO_SMALL', sizePct };
    }
    
    const tradeSize = startingBalance * sizePct;
    
    if (tradeSize < CONFIG.RISK.minTradeSize) {
        return { balance: startingBalance, traded: false, reason: 'BELOW_MIN_SIZE', tradeSize };
    }
    
    // Execute trade
    const entryPrice = marketPrice;
    const exitPrice = wasCorrect ? 1.0 : 0.0;
    const pnl = (exitPrice - entryPrice) * (tradeSize / entryPrice);
    const newBalance = startingBalance + pnl;
    
    return {
        balance: newBalance,
        traded: true,
        prediction,
        confidence,
        tier,
        oracleLocked,
        wasCorrect,
        entryPrice,
        exitPrice,
        tradeSize,
        pnl,
        pnlPercent: (pnl / tradeSize) * 100,
        ev: evMetrics.ev,
        p_hat,
        state: currentState
    };
}

function runBacktest() {
    console.log('🔬 Starting Comprehensive Backtest...\n');
    
    const logs = loadAllDebugLogs();
    console.log(`Loaded ${logs.length} debug logs\n`);
    
    let balance = 5.00; // Starting balance
    const trades = [];
    const assets = ['BTC', 'ETH', 'SOL', 'XRP'];
    
    let totalCycles = 0;
    let tradedCycles = 0;
    let correctTrades = 0;
    let incorrectTrades = 0;
    let missedOpportunities = 0;
    
    logs.forEach((logData, logIdx) => {
        assets.forEach(asset => {
            const assetData = logData.assets?.[asset];
            if (!assetData) return;
            
            const cycleHistory = assetData.cycleHistory || [];
            cycleHistory.forEach(cycle => {
                totalCycles++;
                
                const result = simulateCycle(logData, asset, cycle, balance);
                
                if (result.traded) {
                    tradedCycles++;
                    balance = result.balance;
                    
                    if (result.wasCorrect) {
                        correctTrades++;
                    } else {
                        incorrectTrades++;
                    }
                    
                    trades.push({
                        log: logIdx,
                        asset,
                        ...result
                    });
                } else if (result.wasCorrect && (cycle.tier === 'CONVICTION' || cycle.oracleWasLocked)) {
                    missedOpportunities++;
                }
            });
        });
    });
    
    // Calculate statistics
    const winRate = correctTrades / (correctTrades + incorrectTrades) || 0;
    const totalReturn = ((balance / 5.00) - 1) * 100;
    const avgWin = trades.filter(t => t.pnl > 0).reduce((sum, t) => sum + t.pnl, 0) / correctTrades || 0;
    const avgLoss = trades.filter(t => t.pnl < 0).reduce((sum, t) => sum + Math.abs(t.pnl), 0) / incorrectTrades || 0;
    
    // Find max drawdown
    let peak = 5.00;
    let maxDrawdown = 0;
    let currentBalance = 5.00;
    
    trades.forEach(trade => {
        currentBalance = trade.balance;
        if (currentBalance > peak) peak = currentBalance;
        const drawdown = (peak - currentBalance) / peak;
        if (drawdown > maxDrawdown) maxDrawdown = drawdown;
    });
    
    console.log('═══════════════════════════════════════════════════════');
    console.log('📊 BACKTEST RESULTS (IMPROVED SYSTEM)');
    console.log('═══════════════════════════════════════════════════════\n');
    
    console.log(`Starting Balance: £${5.00.toFixed(2)}`);
    console.log(`Final Balance: £${balance.toFixed(2)}`);
    console.log(`Total Return: ${totalReturn.toFixed(2)}%`);
    console.log(`\nTotal Cycles Analyzed: ${totalCycles}`);
    console.log(`Trades Executed: ${tradedCycles}`);
    console.log(`Missed Opportunities: ${missedOpportunities}`);
    console.log(`\nWin Rate: ${(winRate * 100).toFixed(2)}%`);
    console.log(`Correct Trades: ${correctTrades}`);
    console.log(`Incorrect Trades: ${incorrectTrades}`);
    console.log(`\nAverage Win: £${avgWin.toFixed(2)}`);
    console.log(`Average Loss: £${avgLoss.toFixed(2)}`);
    console.log(`Win/Loss Ratio: ${(avgWin / avgLoss || 0).toFixed(2)}`);
    console.log(`\nMax Drawdown: ${(maxDrawdown * 100).toFixed(2)}%`);
    
    // Trade distribution by tier
    const byTier = {};
    trades.forEach(t => {
        const tier = t.tier || 'NONE';
        if (!byTier[tier]) byTier[tier] = { total: 0, wins: 0, pnl: 0 };
        byTier[tier].total++;
        if (t.wasCorrect) byTier[tier].wins++;
        byTier[tier].pnl += t.pnl;
    });
    
    console.log(`\n═══════════════════════════════════════════════════════`);
    console.log('📈 TRADES BY TIER');
    console.log('═══════════════════════════════════════════════════════\n');
    Object.entries(byTier).forEach(([tier, stats]) => {
        const wr = (stats.wins / stats.total * 100).toFixed(1);
        console.log(`${tier.padEnd(12)}: ${stats.total} trades | ${wr}% win rate | £${stats.pnl.toFixed(2)} P/L`);
    });
    
    // Oracle lock performance
    const oracleTrades = trades.filter(t => t.oracleLocked);
    if (oracleTrades.length > 0) {
        const oracleWins = oracleTrades.filter(t => t.wasCorrect).length;
        const oracleWR = (oracleWins / oracleTrades.length * 100).toFixed(1);
        console.log(`\n🔒 ORACLE LOCKS: ${oracleTrades.length} trades | ${oracleWR}% win rate`);
    }
    
    console.log(`\n═══════════════════════════════════════════════════════`);
    console.log('✅ BACKTEST COMPLETE');
    console.log('═══════════════════════════════════════════════════════\n');
    
    return {
        startingBalance: 5.00,
        finalBalance: balance,
        totalReturn,
        totalCycles,
        tradedCycles,
        correctTrades,
        incorrectTrades,
        winRate,
        avgWin,
        avgLoss,
        maxDrawdown,
        missedOpportunities
    };
}

if (require.main === module) {
    runBacktest();
}

module.exports = { runBacktest };

