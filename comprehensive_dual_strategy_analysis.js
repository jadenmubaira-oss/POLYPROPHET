/**
 * COMPREHENSIVE DUAL STRATEGY ANALYSIS
 * 
 * Analyzes ALL debug logs to find the optimal strategy:
 * 1. Small frequent wins (high prices, 99%+ win rate)
 * 2. Big profitable wins (low prices, high returns)
 * 
 * Goal: Maximum profit in shortest time
 */

const fs = require('fs');
const path = require('path');

function analyzeAllTrades() {
    console.log('🔬 COMPREHENSIVE DUAL STRATEGY ANALYSIS\n');
    console.log('Analyzing ALL debug logs to find optimal strategy...\n');
    
    const files = fs.readdirSync('debug')
        .filter(f => f.endsWith('.json') && f.startsWith('polyprophet_debug_'))
        .sort();
    
    console.log(`Found ${files.length} debug logs\n`);
    
    const allTrades = [];
    const cycleData = [];
    
    // Extract all trades and cycles
    files.forEach(file => {
        try {
            const data = JSON.parse(fs.readFileSync(path.join('debug', file), 'utf8'));
            
            // Extract trades
            if (data.tradeExecutor && data.tradeExecutor.tradeHistory) {
                data.tradeExecutor.tradeHistory.forEach(trade => {
                    if (trade.status === 'CLOSED' && trade.entry && trade.exit !== undefined) {
                        allTrades.push({
                            ...trade,
                            logFile: file,
                            timestamp: trade.time || trade.closeTime
                        });
                    }
                });
            }
            
            // Extract cycle data
            if (data.assets) {
                Object.keys(data.assets).forEach(asset => {
                    const assetData = data.assets[asset];
                    if (assetData.cycleHistory) {
                        assetData.cycleHistory.forEach(cycle => {
                            cycleData.push({
                                ...cycle,
                                asset,
                                logFile: file,
                                timestamp: cycle.timestamp || Date.now()
                            });
                        });
                    }
                });
            }
        } catch (e) {
            console.error(`Error reading ${file}: ${e.message}`);
        }
    });
    
    console.log(`Extracted ${allTrades.length} closed trades`);
    console.log(`Extracted ${cycleData.length} cycles\n`);
    
    // Analyze trades by entry price and tier
    const tradesByPrice = {
        '<10¢': [],
        '10-20¢': [],
        '20-50¢': [],
        '50-80¢': [],
        '80-95¢': [],
        '95-100¢': []
    };
    
    const tradesByTier = {
        'PERFECT': [],
        'NEAR_PERFECT': [],
        'CONVICTION': [],
        'ADVISORY': [],
        'ORACLE_LOCKED': [],
        'NONE': [],
        'UNKNOWN': []
    };
    
    allTrades.forEach(trade => {
        const entryCents = trade.entry * 100;
        let bucket = '95-100¢';
        if (entryCents < 10) bucket = '<10¢';
        else if (entryCents < 20) bucket = '10-20¢';
        else if (entryCents < 50) bucket = '20-50¢';
        else if (entryCents < 80) bucket = '50-80¢';
        else if (entryCents < 95) bucket = '80-95¢';
        
        tradesByPrice[bucket].push(trade);
        
        const tier = trade.tier || 'UNKNOWN';
        if (tier === 'CONVICTION' || tier === 'ADVISORY' || tier === 'PERFECT' || tier === 'NEAR_PERFECT') {
            tradesByTier[tier] = tradesByTier[tier] || [];
            tradesByTier[tier].push(trade);
        } else {
            tradesByTier['UNKNOWN'].push(trade);
        }
    });
    
    // Calculate statistics
    console.log('═══════════════════════════════════════════════════════════');
    console.log('📊 TRADE ANALYSIS BY ENTRY PRICE');
    console.log('═══════════════════════════════════════════════════════════\n');
    
    Object.entries(tradesByPrice).forEach(([bucket, trades]) => {
        if (trades.length === 0) return;
        
        const wins = trades.filter(t => (t.pnl || 0) > 0).length;
        const losses = trades.filter(t => (t.pnl || 0) <= 0).length;
        const winRate = (wins / trades.length) * 100;
        
        const avgReturn = trades.map(t => {
            if (!t.entry || t.entry === 0) return 0;
            const exitPrice = t.exit || (t.pnl > 0 ? 1.0 : 0.0);
            return (exitPrice - t.entry) / t.entry;
        }).reduce((a, b) => a + b, 0) / trades.length;
        
        const avgPnL = trades.reduce((sum, t) => sum + (t.pnl || 0), 0) / trades.length;
        
        console.log(`${bucket}:`);
        console.log(`  Trades: ${trades.length}`);
        console.log(`  Win Rate: ${winRate.toFixed(1)}% (${wins}W/${losses}L)`);
        console.log(`  Avg Return: ${(avgReturn * 100).toFixed(2)}%`);
        console.log(`  Avg P/L: £${avgPnL.toFixed(2)}`);
        console.log();
    });
    
    // Analyze by tier
    console.log('═══════════════════════════════════════════════════════════');
    console.log('📊 TRADE ANALYSIS BY TIER');
    console.log('═══════════════════════════════════════════════════════════\n');
    
    Object.entries(tradesByTier).forEach(([tier, trades]) => {
        if (trades.length === 0) return;
        
        const wins = trades.filter(t => (t.pnl || 0) > 0).length;
        const losses = trades.filter(t => (t.pnl || 0) <= 0).length;
        const winRate = (wins / trades.length) * 100;
        
        const avgEntry = trades.reduce((sum, t) => sum + (t.entry || 0), 0) / trades.length;
        const avgReturn = trades.map(t => {
            if (!t.entry || t.entry === 0) return 0;
            const exitPrice = t.exit || (t.pnl > 0 ? 1.0 : 0.0);
            return (exitPrice - t.entry) / t.entry;
        }).reduce((a, b) => a + b, 0) / trades.length;
        
        const avgPnL = trades.reduce((sum, t) => sum + (t.pnl || 0), 0) / trades.length;
        
        console.log(`${tier}:`);
        console.log(`  Trades: ${trades.length}`);
        console.log(`  Win Rate: ${winRate.toFixed(1)}% (${wins}W/${losses}L)`);
        console.log(`  Avg Entry: ${(avgEntry * 100).toFixed(1)}¢`);
        console.log(`  Avg Return: ${(avgReturn * 100).toFixed(2)}%`);
        console.log(`  Avg P/L: £${avgPnL.toFixed(2)}`);
        console.log();
    });
    
    // Analyze time-of-day patterns
    console.log('═══════════════════════════════════════════════════════════');
    console.log('📊 TIME-OF-DAY ANALYSIS');
    console.log('═══════════════════════════════════════════════════════════\n');
    
    const tradesByHour = {};
    allTrades.forEach(trade => {
        if (!trade.timestamp) return;
        const hour = new Date(trade.timestamp).getUTCHours();
        if (!tradesByHour[hour]) tradesByHour[hour] = [];
        tradesByHour[hour].push(trade);
    });
    
    Object.entries(tradesByHour)
        .sort((a, b) => parseInt(a[0]) - parseInt(b[0]))
        .forEach(([hour, trades]) => {
            const wins = trades.filter(t => (t.pnl || 0) > 0).length;
            const winRate = (wins / trades.length) * 100;
            const avgEntry = trades.reduce((sum, t) => sum + (t.entry || 0), 0) / trades.length;
            
            console.log(`Hour ${hour}:00 UTC - ${trades.length} trades, ${winRate.toFixed(1)}% win rate, avg entry ${(avgEntry * 100).toFixed(1)}¢`);
        });
    console.log();
    
    // DUAL STRATEGY SIMULATION
    console.log('═══════════════════════════════════════════════════════════');
    console.log('💰 DUAL STRATEGY SIMULATION');
    console.log('═══════════════════════════════════════════════════════════\n');
    
    const strategies = [
        {
            name: 'STRATEGY 1: Only Low Prices (<50¢)',
            filter: (t) => t.entry < 0.50 && (t.tier === 'CONVICTION' || t.tier === 'ADVISORY' || t.tier === 'PERFECT' || t.tier === 'NEAR_PERFECT'),
            positionSize: 0.60
        },
        {
            name: 'STRATEGY 2: Only High Prices (≥95¢)',
            filter: (t) => t.entry >= 0.95 && (t.tier === 'CONVICTION' || t.tier === 'ADVISORY'),
            positionSize: 0.70
        },
        {
            name: 'STRATEGY 3: DUAL - Low + High (OPTIMAL)',
            filter: (t) => {
                const isHighTier = t.tier === 'CONVICTION' || t.tier === 'ADVISORY' || t.tier === 'PERFECT' || t.tier === 'NEAR_PERFECT';
                return isHighTier && (t.entry < 0.50 || t.entry >= 0.95);
            },
            positionSize: (t) => t.entry >= 0.95 ? 0.70 : 0.60
        },
        {
            name: 'STRATEGY 4: DUAL - All CONVICTION/ADVISORY',
            filter: (t) => t.tier === 'CONVICTION' || t.tier === 'ADVISORY',
            positionSize: (t) => t.entry >= 0.95 ? 0.70 : (t.entry < 0.50 ? 0.60 : 0.50)
        }
    ];
    
    strategies.forEach(strategy => {
        const filteredTrades = allTrades.filter(strategy.filter);
        const sortedTrades = filteredTrades.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
        
        let balance = 5.00;
        let wins = 0;
        let losses = 0;
        const tradeResults = [];
        
        sortedTrades.forEach(trade => {
            const positionSize = typeof strategy.positionSize === 'function' 
                ? strategy.positionSize(trade) 
                : strategy.positionSize;
            
            const tradeSize = balance * positionSize;
            if (tradeSize < 1.10) return; // Skip if too small
            
            const entryPrice = trade.entry;
            const exitPrice = trade.exit || (trade.pnl > 0 ? 1.0 : 0.0);
            const returnRate = (exitPrice - entryPrice) / entryPrice;
            const profit = tradeSize * returnRate;
            
            balance = balance - tradeSize + (tradeSize * (1 + returnRate));
            
            if (profit > 0) wins++;
            else losses++;
            
            tradeResults.push({
                balance,
                profit,
                entryPrice,
                exitPrice,
                returnRate,
                tradeSize
            });
        });
        
        const totalReturn = ((balance / 5.00) - 1) * 100;
        const winRate = filteredTrades.length > 0 ? (wins / filteredTrades.length) * 100 : 0;
        
        // Project 24h
        const hoursOfData = files.length * 0.25; // Rough estimate
        const tradesPerDay = filteredTrades.length / (hoursOfData / 24);
        const projected24h = 5.00 * Math.pow(balance / 5.00, 24 / hoursOfData);
        
        console.log(`${strategy.name}:`);
        console.log(`  Trades: ${filteredTrades.length}`);
        console.log(`  Final Balance: £${balance.toFixed(2)}`);
        console.log(`  Total Return: ${totalReturn.toFixed(2)}%`);
        console.log(`  Win Rate: ${winRate.toFixed(1)}%`);
        console.log(`  Trades/Day: ${tradesPerDay.toFixed(1)}`);
        console.log(`  Projected 24h: £${projected24h.toFixed(2)}`);
        console.log(`  Projected 24h Profit: £${(projected24h - 5.00).toFixed(2)}`);
        console.log();
    });
    
    // Save results
    const results = {
        totalTrades: allTrades.length,
        totalCycles: cycleData.length,
        tradesByPrice,
        tradesByTier,
        strategies: strategies.map(s => ({
            name: s.name,
            trades: allTrades.filter(s.filter).length
        }))
    };
    
    fs.writeFileSync('dual_strategy_analysis_results.json', JSON.stringify(results, null, 2));
    console.log('✅ Results saved to dual_strategy_analysis_results.json');
}

analyzeAllTrades();

