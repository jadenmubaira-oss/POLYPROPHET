/**
 * DEEP CYCLE ANALYSIS: Find patterns that predict LOW entry prices
 * 
 * Goal: Find when PERFECT/NEAR PERFECT patterns occur WITH low entry prices
 * Or: Find patterns that predict price will be low BEFORE it moves to 99¢
 */

const fs = require('fs');
const path = require('path');

const files = fs.readdirSync('debug').filter(f => f.endsWith('.json')).sort();

console.log('🔬 DEEP CYCLE ANALYSIS: Finding patterns for LOW entry prices...\n');

let allCycles = [];
let priceMovementPatterns = [];
let earlyEntryOpportunities = [];

files.forEach((file, fileIdx) => {
    try {
        const data = JSON.parse(fs.readFileSync(path.join('debug', file), 'utf8'));
        const fileDate = new Date(file.match(/\d{4}-\d{2}-\d{2}T\d{2}-\d{2}/)?.[0]?.replace(/-/g, '-') || Date.now());
        
        Object.entries(data.assets || {}).forEach(([asset, assetData]) => {
            const cycleHistory = assetData.cycleHistory || [];
            const priceHistory = assetData.priceHistory || [];
            
            cycleHistory.forEach((cycle, cycleIdx) => {
                const modelAgreement = cycle.modelAgreementHistory || [];
                const allAgree = modelAgreement.length >= 3 && 
                    modelAgreement.every(v => v === modelAgreement[0] && v !== null);
                const certainty = cycle.certaintyAtEnd || 0;
                const oracleLocked = cycle.oracleWasLocked || false;
                const tier = cycle.tier || 'NONE';
                const wasCorrect = cycle.wasCorrect || false;
                const prediction = cycle.prediction;
                
                const isPerfect = allAgree && certainty >= 75 && oracleLocked && tier === 'CONVICTION';
                const isNearPerfect = allAgree && certainty >= 70 && tier === 'CONVICTION' && !isPerfect;
                const isConviction = tier === 'CONVICTION';
                
                const marketOdds = cycle.marketOdds || { yesPrice: 0.5, noPrice: 0.5 };
                const entryPrice = prediction === 'UP' ? marketOdds.yesPrice : marketOdds.noPrice;
                
                // Price movement analysis
                const cycleStartPrice = cycle.cycleStartPrice || 0;
                const cycleEndPrice = cycle.cycleEndPrice || 0;
                const priceMove = cycleEndPrice - cycleStartPrice;
                const priceMovePct = cycleStartPrice > 0 ? (priceMove / cycleStartPrice) * 100 : 0;
                
                // Look at price history BEFORE this cycle to see if we could have entered earlier
                const priceHistoryBeforeCycle = priceHistory.slice(0, cycleIdx).slice(-10);
                const avgPriceBefore = priceHistoryBeforeCycle.length > 0 ? 
                    priceHistoryBeforeCycle.reduce((s, p) => s + (p.p || 0), 0) / priceHistoryBeforeCycle.length : cycleStartPrice;
                
                // Check if price was lower earlier in the cycle
                const certaintySeries = cycle.certaintySeries || [];
                const edgeHistory = cycle.edgeHistory || [];
                
                // Find when pattern first appeared (certainty reached threshold)
                let patternFirstAppeared = -1;
                for (let i = 0; i < certaintySeries.length; i++) {
                    if (certaintySeries[i] >= 70 && (isPerfect || isNearPerfect)) {
                        patternFirstAppeared = i;
                        break;
                    }
                }
                
                allCycles.push({
                    file,
                    asset,
                    cycleIdx,
                    timestamp: cycle.cycleEndTime,
                    prediction,
                    wasCorrect,
                    entryPrice,
                    cycleStartPrice,
                    cycleEndPrice,
                    priceMovePct,
                    isPerfect,
                    isNearPerfect,
                    isConviction,
                    certainty,
                    oracleLocked,
                    tier,
                    allAgree,
                    certaintySeries,
                    edgeHistory,
                    patternFirstAppeared,
                    avgPriceBefore,
                    modelVotes: cycle.modelVotes || {},
                    winStreak: cycle.winStreak || 0,
                    hour: new Date(cycle.cycleEndTime || fileDate).getHours()
                });
                
                // Look for patterns where price was LOW when pattern first appeared
                if ((isPerfect || isNearPerfect) && wasCorrect) {
                    // Check if we could have entered earlier at a lower price
                    if (entryPrice > 0.50 && cycleStartPrice < entryPrice * 0.8) {
                        // Price was lower at cycle start - could have entered earlier
                        earlyEntryOpportunities.push({
                            asset,
                            cycleStartPrice,
                            entryPrice,
                            improvement: (entryPrice - cycleStartPrice) / cycleStartPrice,
                            isPerfect,
                            isNearPerfect
                        });
                    }
                }
            });
        });
    } catch (e) {
        console.error(`Error processing ${file}: ${e.message}`);
    }
});

console.log(`Total cycles analyzed: ${allCycles.length}\n`);

// Find patterns that predict LOW entry prices
console.log('═══════════════════════════════════════════════════════');
console.log('🔍 PATTERNS THAT PREDICT LOW ENTRY PRICES');
console.log('═══════════════════════════════════════════════════════\n');

// Pattern 1: PERFECT/NEAR PERFECT with entry < 50¢ (not just <20¢)
const moderatePricePerfect = allCycles.filter(c => 
    (c.isPerfect || c.isNearPerfect) && 
    c.wasCorrect && 
    c.entryPrice < 0.50 && 
    c.entryPrice >= 0.20
);

console.log(`Pattern 1: PERFECT/NEAR PERFECT with entry 20-50¢`);
console.log(`  Count: ${moderatePricePerfect.length}`);
if (moderatePricePerfect.length > 0) {
    const avgReturn = moderatePricePerfect.reduce((s, c) => s + (1.0 / c.entryPrice), 0) / moderatePricePerfect.length;
    console.log(`  Avg Return: ${avgReturn.toFixed(2)}x`);
    console.log(`  Win Rate: 100% (all were correct)`);
}

// Pattern 2: CONVICTION tier with entry < 50¢
const convictionLowPrice = allCycles.filter(c => 
    c.isConviction && 
    c.wasCorrect && 
    c.entryPrice < 0.50
);

console.log(`\nPattern 2: CONVICTION tier with entry < 50¢`);
console.log(`  Count: ${convictionLowPrice.length}`);
if (convictionLowPrice.length > 0) {
    const wins = convictionLowPrice.filter(c => c.wasCorrect).length;
    const winRate = (wins / convictionLowPrice.length) * 100;
    const avgReturn = convictionLowPrice.filter(c => c.wasCorrect).reduce((s, c) => s + (1.0 / c.entryPrice), 0) / wins;
    console.log(`  Win Rate: ${winRate.toFixed(1)}%`);
    console.log(`  Avg Return: ${avgReturn.toFixed(2)}x`);
}

// Pattern 3: Early entry opportunities (price was lower earlier)
console.log(`\nPattern 3: Early entry opportunities`);
console.log(`  Count: ${earlyEntryOpportunities.length}`);
if (earlyEntryOpportunities.length > 0) {
    const avgImprovement = earlyEntryOpportunities.reduce((s, e) => s + e.improvement, 0) / earlyEntryOpportunities.length;
    console.log(`  Avg Price Improvement: ${(avgImprovement * 100).toFixed(1)}%`);
}

// Pattern 4: Time-of-day patterns for low prices
console.log(`\nPattern 4: Time-of-day patterns for low prices`);
const hourlyLowPrice = {};
allCycles.filter(c => c.entryPrice < 0.50 && (c.isPerfect || c.isNearPerfect || c.isConviction) && c.wasCorrect).forEach(c => {
    if (!hourlyLowPrice[c.hour]) hourlyLowPrice[c.hour] = [];
    hourlyLowPrice[c.hour].push(c);
});

Object.keys(hourlyLowPrice).sort((a, b) => parseInt(a) - parseInt(b)).forEach(hour => {
    const cycles = hourlyLowPrice[hour];
    const avgEntry = cycles.reduce((s, c) => s + c.entryPrice, 0) / cycles.length;
    const avgReturn = cycles.reduce((s, c) => s + (1.0 / c.entryPrice), 0) / cycles.length;
    console.log(`  ${hour.toString().padStart(2, '0')}:00 - ${cycles.length} cycles, Avg Entry: ${(avgEntry*100).toFixed(2)}¢, Avg Return: ${avgReturn.toFixed(2)}x`);
});

// Pattern 5: Asset-specific patterns
console.log(`\nPattern 5: Asset-specific patterns for low prices`);
const assetLowPrice = {};
allCycles.filter(c => c.entryPrice < 0.50 && (c.isPerfect || c.isNearPerfect || c.isConviction) && c.wasCorrect).forEach(c => {
    if (!assetLowPrice[c.asset]) assetLowPrice[c.asset] = [];
    assetLowPrice[c.asset].push(c);
});

Object.keys(assetLowPrice).sort().forEach(asset => {
    const cycles = assetLowPrice[asset];
    const avgEntry = cycles.reduce((s, c) => s + c.entryPrice, 0) / cycles.length;
    const avgReturn = cycles.reduce((s, c) => s + (1.0 / c.entryPrice), 0) / cycles.length;
    console.log(`  ${asset} - ${cycles.length} cycles, Avg Entry: ${(avgEntry*100).toFixed(2)}¢, Avg Return: ${avgReturn.toFixed(2)}x`);
});

// Pattern 6: Win streak patterns
console.log(`\nPattern 6: Win streak patterns for low prices`);
const streakLowPrice = {};
allCycles.filter(c => c.entryPrice < 0.50 && (c.isPerfect || c.isNearPerfect || c.isConviction) && c.wasCorrect).forEach(c => {
    const streak = c.winStreak || 0;
    const range = streak < 2 ? '0-1' : streak < 5 ? '2-4' : streak < 10 ? '5-9' : '10+';
    if (!streakLowPrice[range]) streakLowPrice[range] = [];
    streakLowPrice[range].push(c);
});

Object.keys(streakLowPrice).sort().forEach(range => {
    const cycles = streakLowPrice[range];
    const avgEntry = cycles.reduce((s, c) => s + c.entryPrice, 0) / cycles.length;
    const avgReturn = cycles.reduce((s, c) => s + (1.0 / c.entryPrice), 0) / cycles.length;
    console.log(`  Streak ${range} - ${cycles.length} cycles, Avg Entry: ${(avgEntry*100).toFixed(2)}¢, Avg Return: ${avgReturn.toFixed(2)}x`);
});

// Simulate with expanded patterns
console.log('\n═══════════════════════════════════════════════════════');
console.log('💰 PROFIT SIMULATION WITH EXPANDED PATTERNS');
console.log('═══════════════════════════════════════════════════════\n');

const strategies = [
    {
        name: 'PERFECT/NEAR PERFECT < 20¢ (Current)',
        filter: c => (c.isPerfect || c.isNearPerfect) && c.wasCorrect && c.entryPrice < 0.20
    },
    {
        name: 'PERFECT/NEAR PERFECT < 50¢ (Expanded)',
        filter: c => (c.isPerfect || c.isNearPerfect) && c.wasCorrect && c.entryPrice < 0.50
    },
    {
        name: 'CONVICTION < 50¢ (Fallback)',
        filter: c => c.isConviction && c.wasCorrect && c.entryPrice < 0.50
    },
    {
        name: 'CONVICTION < 30¢ (Conservative Fallback)',
        filter: c => c.isConviction && c.wasCorrect && c.entryPrice < 0.30
    },
    {
        name: 'All Patterns < 50¢ (Maximum Opportunities)',
        filter: c => (c.isPerfect || c.isNearPerfect || c.isConviction) && c.wasCorrect && c.entryPrice < 0.50
    }
];

strategies.forEach(strategy => {
    const trades = allCycles.filter(strategy.filter).sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
    if (trades.length === 0) {
        console.log(`${strategy.name.padEnd(40)} | Trades: 0 | Final: £5.00 | ❌ NO TRADES`);
        return;
    }
    
    let balance = 5.00;
    const positionSize = 0.70; // 70% for PERFECT, adjust for others
    
    trades.slice(0, 24).forEach((trade, i) => {
        const size = (trade.isPerfect || trade.isNearPerfect) ? 0.70 : 0.50; // Lower for CONVICTION
        const stake = balance * size;
        const returnMultiplier = 1.0 / trade.entryPrice;
        const profit = stake * (returnMultiplier - 1);
        balance = balance + profit;
    });
    
    const returnPct = ((balance / 5.00) - 1) * 100;
    const meetsGoal = balance >= 100.00;
    const status = meetsGoal ? '✅ MEETS GOAL' : '❌ BELOW GOAL';
    console.log(`${strategy.name.padEnd(40)} | Trades: ${Math.min(trades.length, 24).toString().padStart(2)} | Final: £${balance.toFixed(2).padStart(8)} | Return: ${returnPct.toFixed(1).padStart(7)}% | ${status}`);
});

console.log('\n═══════════════════════════════════════════════════════');
console.log('✅ ANALYSIS COMPLETE');
console.log('═══════════════════════════════════════════════════════\n');

