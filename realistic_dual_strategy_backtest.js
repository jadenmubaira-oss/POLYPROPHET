/**
 * REALISTIC DUAL STRATEGY BACKTEST
 * 
 * Uses cycle_report.json statistics to simulate realistic performance
 * Accounts for fees, proper compounding, and realistic entry prices
 */

const fs = require('fs');

const cycleReport = JSON.parse(fs.readFileSync('debug/cycle_report.json', 'utf8'));
const FEES = 0.02; // 2% fees

function calculateReturn(entryPrice, exitPrice, fees = FEES) {
    if (exitPrice >= 1.0) {
        // Win: return = (1 - entry) / entry, minus fees
        const grossReturn = (1.0 - entryPrice) / entryPrice;
        return grossReturn * (1 - fees); // Apply fees
    } else {
        // Loss: return = -entry / entry = -1, plus fees
        return -1.0 - fees;
    }
}

function getCycleStats(tier, entryPrice) {
    const bucket = entryPrice >= 0.95 ? '95-100c' : 
                   entryPrice < 0.20 ? '<20c' :
                   entryPrice < 0.50 ? '20-50c' :
                   entryPrice < 0.80 ? '50-80c' : '80-95c';
    
    const tierData = cycleReport.breakdown?.byTierAndMarketYesOddsBucket?.[tier]?.[bucket];
    if (tierData && tierData.n > 0) {
        return {
            accuracy: tierData.accuracy / 100,
            count: tierData.n
        };
    }
    
    // Fallback to tier average
    const tierAvg = cycleReport.breakdown?.byTier?.[tier];
    if (tierAvg && tierAvg.n > 0) {
        return {
            accuracy: tierAvg.accuracy / 100,
            count: tierAvg.n
        };
    }
    
    return { accuracy: 0.5, count: 0 };
}

function simulateStrategy(strategyName, filterFn, positionSizeFn) {
    let balance = 5.00;
    let trades = 0;
    let wins = 0;
    let losses = 0;
    const tradeHistory = [];
    
    // Get all CONVICTION and ADVISORY cycles from cycle_report.json
    const convictionHigh = cycleReport.breakdown?.byTierAndMarketYesOddsBucket?.CONVICTION?.['95-100c'] || { n: 0, accuracy: 0 };
    const convictionLow = cycleReport.breakdown?.byTierAndMarketYesOddsBucket?.CONVICTION?.['<20c'] || { n: 0, accuracy: 0 };
    const convictionMid = cycleReport.breakdown?.byTierAndMarketYesOddsBucket?.CONVICTION?.['20-50c'] || { n: 0, accuracy: 0 };
    const advisoryHigh = cycleReport.breakdown?.byTierAndMarketYesOddsBucket?.ADVISORY?.['95-100c'] || { n: 0, accuracy: 0 };
    const advisoryLow = cycleReport.breakdown?.byTierAndMarketYesOddsBucket?.ADVISORY?.['<20c'] || { n: 0, accuracy: 0 };
    const advisoryMid = cycleReport.breakdown?.byTierAndMarketYesOddsBucket?.ADVISORY?.['20-50c'] || { n: 0, accuracy: 0 };
    
    // Create cycle list based on strategy
    const cycles = [];
    
    // CONVICTION cycles
    if (filterFn('CONVICTION', 0.98)) { // High price example
        for (let i = 0; i < convictionHigh.n; i++) {
            cycles.push({ tier: 'CONVICTION', entryPrice: 0.98, accuracy: convictionHigh.accuracy / 100 });
        }
    }
    if (filterFn('CONVICTION', 0.15)) { // Low price example
        for (let i = 0; i < convictionLow.n; i++) {
            cycles.push({ tier: 'CONVICTION', entryPrice: 0.15, accuracy: convictionLow.accuracy / 100 });
        }
    }
    if (filterFn('CONVICTION', 0.35)) { // Mid price example
        for (let i = 0; i < convictionMid.n; i++) {
            cycles.push({ tier: 'CONVICTION', entryPrice: 0.35, accuracy: convictionMid.accuracy / 100 });
        }
    }
    
    // ADVISORY cycles
    if (filterFn('ADVISORY', 0.98)) {
        for (let i = 0; i < advisoryHigh.n; i++) {
            cycles.push({ tier: 'ADVISORY', entryPrice: 0.98, accuracy: advisoryHigh.accuracy / 100 });
        }
    }
    if (filterFn('ADVISORY', 0.15)) {
        for (let i = 0; i < advisoryLow.n; i++) {
            cycles.push({ tier: 'ADVISORY', entryPrice: 0.15, accuracy: advisoryLow.accuracy / 100 });
        }
    }
    if (filterFn('ADVISORY', 0.35)) {
        for (let i = 0; i < advisoryMid.n; i++) {
            cycles.push({ tier: 'ADVISORY', entryPrice: 0.35, accuracy: advisoryMid.accuracy / 100 });
        }
    }
    
    // Simulate trades
    cycles.forEach(cycle => {
        const positionSize = typeof positionSizeFn === 'function' 
            ? positionSizeFn(cycle.tier, cycle.entryPrice)
            : positionSizeFn;
        
        const tradeSize = balance * positionSize;
        if (tradeSize < 1.10) return;
        
        // Determine outcome based on accuracy
        const won = Math.random() < cycle.accuracy;
        const exitPrice = won ? 1.0 : 0.0;
        
        const returnRate = calculateReturn(cycle.entryPrice, exitPrice);
        const profit = tradeSize * returnRate;
        balance = balance - tradeSize + (tradeSize * (1 + returnRate));
        
        // Cap balance to prevent overflow
        if (balance > 1e10) balance = 1e10;
        
        trades++;
        if (won) wins++;
        else losses++;
        
        tradeHistory.push({
            balance,
            profit,
            entryPrice: cycle.entryPrice,
            exitPrice,
            returnRate,
            tradeSize,
            tier: cycle.tier,
            won
        });
    });
    
    return {
        name: strategyName,
        finalBalance: balance,
        totalReturn: ((balance / 5.00) - 1) * 100,
        trades,
        wins,
        losses,
        winRate: trades > 0 ? (wins / trades) * 100 : 0,
        tradeHistory: tradeHistory.slice(0, 100) // First 100 for inspection
    };
}

function runBacktest() {
    console.log('🔬 REALISTIC DUAL STRATEGY BACKTEST\n');
    console.log('Using cycle_report.json statistics with proper compounding and fees\n');
    
    // STRATEGY 1: Only HIGH prices (95-100¢)
    const strategy1 = simulateStrategy(
        'HIGH FREQ: CONVICTION/ADVISORY at 95-100¢',
        (tier, entryPrice) => entryPrice >= 0.95,
        0.70
    );
    
    // STRATEGY 2: Only LOW prices (<50¢)
    const strategy2 = simulateStrategy(
        'HIGH RETURN: CONVICTION/ADVISORY at <50¢',
        (tier, entryPrice) => entryPrice < 0.50,
        0.60
    );
    
    // STRATEGY 3: DUAL - High + Low (OPTIMAL)
    const strategy3 = simulateStrategy(
        'DUAL OPTIMAL: High (95-100¢) + Low (<50¢)',
        (tier, entryPrice) => entryPrice >= 0.95 || entryPrice < 0.50,
        (tier, entryPrice) => entryPrice >= 0.95 ? 0.70 : 0.60
    );
    
    // STRATEGY 4: ALL CONVICTION/ADVISORY
    const strategy4 = simulateStrategy(
        'MAX FREQ: All CONVICTION/ADVISORY',
        (tier, entryPrice) => true,
        (tier, entryPrice) => entryPrice >= 0.95 ? 0.70 : (entryPrice < 0.50 ? 0.60 : 0.50)
    );
    
    const strategies = [strategy1, strategy2, strategy3, strategy4];
    
    console.log('═══════════════════════════════════════════════════════════');
    console.log('💰 STRATEGY COMPARISON');
    console.log('═══════════════════════════════════════════════════════════\n');
    
    strategies.forEach(s => {
        // Estimate hours of data (assuming 15-min cycles, 4 per hour)
        // From cycle_report.json: 1973 unique cycles
        const totalCycles = 1973;
        const hoursOfData = totalCycles / 4; // 15-min cycles
        const tradesPerDay = s.trades / (hoursOfData / 24);
        const projected24h = 5.00 * Math.pow(s.finalBalance / 5.00, 24 / hoursOfData);
        const projected24hProfit = projected24h - 5.00;
        
        console.log(`${s.name}:`);
        console.log(`  Trades: ${s.trades}`);
        console.log(`  Win Rate: ${s.winRate.toFixed(1)}% (${s.wins}W/${s.losses}L)`);
        console.log(`  Final Balance: £${s.finalBalance.toFixed(2)}`);
        console.log(`  Total Return: ${s.totalReturn.toFixed(2)}%`);
        console.log(`  Trades/Day: ${tradesPerDay.toFixed(1)}`);
        console.log(`  Projected 24h Balance: £${projected24h.toFixed(2)}`);
        console.log(`  Projected 24h Profit: £${projected24hProfit.toFixed(2)}`);
        
        if (projected24hProfit >= 100) {
            console.log(`  ✅ GOAL ACHIEVED: ≥£100 in 24h`);
        } else if (projected24hProfit >= 50) {
            console.log(`  ⚠️  PARTIAL: £50-100 in 24h`);
        } else {
            console.log(`  ❌ BELOW GOAL: <£50 in 24h`);
        }
        console.log();
    });
    
    // Find best strategy
    const bestStrategy = strategies.reduce((best, current) => {
        const totalCycles = 1973;
        const hoursOfData = totalCycles / 4;
        const current24h = 5.00 * Math.pow(current.finalBalance / 5.00, 24 / hoursOfData);
        const best24h = 5.00 * Math.pow(best.finalBalance / 5.00, 24 / hoursOfData);
        return current24h > best24h ? current : best;
    });
    
    console.log('═══════════════════════════════════════════════════════════');
    console.log('🏆 WINNING STRATEGY');
    console.log('═══════════════════════════════════════════════════════════\n');
    console.log(`${bestStrategy.name}`);
    const totalCycles = 1973;
    const hoursOfData = totalCycles / 4;
    const projected24h = 5.00 * Math.pow(bestStrategy.finalBalance / 5.00, 24 / hoursOfData);
    console.log(`Projected 24h Profit: £${(projected24h - 5.00).toFixed(2)}`);
    console.log();
    
    // Save results
    const results = {
        strategies: strategies.map(s => {
            const totalCycles = 1973;
            const hoursOfData = totalCycles / 4;
            return {
                name: s.name,
                finalBalance: s.finalBalance,
                totalReturn: s.totalReturn,
                trades: s.trades,
                wins: s.wins,
                losses: s.losses,
                winRate: s.winRate,
                projected24h: 5.00 * Math.pow(s.finalBalance / 5.00, 24 / hoursOfData),
                projected24hProfit: (5.00 * Math.pow(s.finalBalance / 5.00, 24 / hoursOfData)) - 5.00
            };
        }),
        bestStrategy: bestStrategy.name
    };
    
    fs.writeFileSync('realistic_dual_strategy_results.json', JSON.stringify(results, null, 2));
    console.log('✅ Results saved to realistic_dual_strategy_results.json');
}

runBacktest();

