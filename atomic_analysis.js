/**
 * ATOMIC INVESTIGATION: Full forensic analysis of ALL cycles
 * 
 * Goal: Find EVERY possible edge to achieve £100 in 24 hours from £5
 * Requirement: 20x return (1900%) - WORST CASE
 */

const fs = require('fs');
const path = require('path');

const files = fs.readdirSync('debug').filter(f => f.endsWith('.json')).sort();

console.log('🔬 ATOMIC INVESTIGATION: Analyzing ALL cycles...\n');
console.log(`Total debug files: ${files.length}\n`);

let allOpportunities = [];
let cyclesByPattern = {
    perfect: [],
    nearPerfect: [],
    conviction: [],
    all: []
};

let timeOfDayAnalysis = {};
let priceRangeAnalysis = {};
let assetAnalysis = {};

files.forEach((file, fileIdx) => {
    try {
        const data = JSON.parse(fs.readFileSync(path.join('debug', file), 'utf8'));
        const fileDate = new Date(file.match(/\d{4}-\d{2}-\d{2}T\d{2}-\d{2}/)?.[0]?.replace(/-/g, '-') || Date.now());
        
        Object.entries(data.assets || {}).forEach(([asset, assetData]) => {
            if (!assetAnalysis[asset]) {
                assetAnalysis[asset] = { total: 0, perfect: 0, nearPerfect: 0, conviction: 0, wins: 0 };
            }
            
            const cycleHistory = assetData.cycleHistory || [];
            
            cycleHistory.forEach((cycle, cycleIdx) => {
                assetAnalysis[asset].total++;
                
                const modelAgreement = cycle.modelAgreementHistory || [];
                const allAgree = modelAgreement.length >= 3 && 
                    modelAgreement.every(v => v === modelAgreement[0] && v !== null);
                const certainty = cycle.certaintyAtEnd || 0;
                const oracleLocked = cycle.oracleWasLocked || false;
                const tier = cycle.tier || 'NONE';
                const wasCorrect = cycle.wasCorrect || false;
                const prediction = cycle.prediction;
                
                // Pattern detection
                const isPerfect = allAgree && certainty >= 75 && oracleLocked && tier === 'CONVICTION';
                const isNearPerfect = allAgree && certainty >= 70 && tier === 'CONVICTION' && !isPerfect;
                const isConviction = tier === 'CONVICTION';
                
                // Market odds
                const marketOdds = cycle.marketOdds || { yesPrice: 0.5, noPrice: 0.5 };
                const entryPrice = prediction === 'UP' ? marketOdds.yesPrice : marketOdds.noPrice;
                
                // Profit calculation
                const exitPrice = wasCorrect ? 1.0 : 0.0;
                const profitPerDollar = wasCorrect ? (exitPrice - entryPrice) / entryPrice : -1;
                const returnMultiplier = wasCorrect ? (1.0 / entryPrice) : 0;
                
                // Time analysis
                const cycleTime = new Date(cycle.cycleEndTime || fileDate);
                const hour = cycleTime.getHours();
                if (!timeOfDayAnalysis[hour]) {
                    timeOfDayAnalysis[hour] = { total: 0, perfect: 0, nearPerfect: 0, wins: 0, avgReturn: 0, returns: [] };
                }
                timeOfDayAnalysis[hour].total++;
                if (wasCorrect) {
                    timeOfDayAnalysis[hour].wins++;
                    timeOfDayAnalysis[hour].returns.push(returnMultiplier);
                }
                
                // Price range analysis
                const priceRange = entryPrice < 0.05 ? '0-5¢' : 
                                 entryPrice < 0.10 ? '5-10¢' :
                                 entryPrice < 0.20 ? '10-20¢' :
                                 entryPrice < 0.50 ? '20-50¢' :
                                 entryPrice < 0.80 ? '50-80¢' : '80-100¢';
                if (!priceRangeAnalysis[priceRange]) {
                    priceRangeAnalysis[priceRange] = { total: 0, wins: 0, perfect: 0, nearPerfect: 0, avgReturn: 0, returns: [] };
                }
                priceRangeAnalysis[priceRange].total++;
                if (wasCorrect) {
                    priceRangeAnalysis[priceRange].wins++;
                    priceRangeAnalysis[priceRange].returns.push(returnMultiplier);
                }
                
                // Store opportunity
                const opportunity = {
                    file: file,
                    asset,
                    cycleIdx,
                    timestamp: cycle.cycleEndTime,
                    hour,
                    prediction,
                    wasCorrect,
                    entryPrice,
                    returnMultiplier,
                    profitPerDollar,
                    isPerfect,
                    isNearPerfect,
                    isConviction,
                    certainty,
                    oracleLocked,
                    tier,
                    allAgree
                };
                
                allOpportunities.push(opportunity);
                
                if (isPerfect) {
                    cyclesByPattern.perfect.push(opportunity);
                    assetAnalysis[asset].perfect++;
                    timeOfDayAnalysis[hour].perfect++;
                    priceRangeAnalysis[priceRange].perfect++;
                }
                if (isNearPerfect) {
                    cyclesByPattern.nearPerfect.push(opportunity);
                    assetAnalysis[asset].nearPerfect++;
                    timeOfDayAnalysis[hour].nearPerfect++;
                    priceRangeAnalysis[priceRange].nearPerfect++;
                }
                if (isConviction) {
                    cyclesByPattern.conviction.push(opportunity);
                    assetAnalysis[asset].conviction++;
                }
                cyclesByPattern.all.push(opportunity);
                
                if (wasCorrect) assetAnalysis[asset].wins++;
            });
        });
    } catch (e) {
        console.error(`Error processing ${file}: ${e.message}`);
    }
});

// Calculate averages
Object.keys(timeOfDayAnalysis).forEach(h => {
    const d = timeOfDayAnalysis[h];
    d.avgReturn = d.returns.length > 0 ? d.returns.reduce((a, b) => a + b, 0) / d.returns.length : 0;
});

Object.keys(priceRangeAnalysis).forEach(r => {
    const d = priceRangeAnalysis[r];
    d.avgReturn = d.returns.length > 0 ? d.returns.reduce((a, b) => a + b, 0) / d.returns.length : 0;
});

// Filter for profitable opportunities (correct predictions)
const profitableOpportunities = allOpportunities.filter(o => o.wasCorrect && (o.isPerfect || o.isNearPerfect));
profitableOpportunities.sort((a, b) => b.returnMultiplier - a.returnMultiplier);

console.log('═══════════════════════════════════════════════════════');
console.log('📊 PATTERN ANALYSIS');
console.log('═══════════════════════════════════════════════════════\n');

console.log(`Total cycles analyzed: ${allOpportunities.length}`);
console.log(`PERFECT patterns: ${cyclesByPattern.perfect.length}`);
console.log(`NEAR PERFECT patterns: ${cyclesByPattern.nearPerfect.length}`);
console.log(`CONVICTION patterns: ${cyclesByPattern.conviction.length}`);
console.log(`Profitable PERFECT/NEAR PERFECT: ${profitableOpportunities.length}\n`);

console.log('═══════════════════════════════════════════════════════');
console.log('💰 PROFIT OPPORTUNITIES (Top 50)');
console.log('═══════════════════════════════════════════════════════\n');

profitableOpportunities.slice(0, 50).forEach((o, i) => {
    console.log(`${(i+1).toString().padStart(2, ' ')}. ${o.asset.padEnd(4)} | Entry: ${(o.entryPrice * 100).toFixed(2).padStart(5)}¢ | Return: ${o.returnMultiplier.toFixed(2).padStart(6)}x | ${o.isPerfect ? 'PERFECT' : 'NEAR PERFECT'}`);
});

console.log('\n═══════════════════════════════════════════════════════');
console.log('📈 PRICE RANGE ANALYSIS');
console.log('═══════════════════════════════════════════════════════\n');

Object.keys(priceRangeAnalysis).sort().forEach(range => {
    const d = priceRangeAnalysis[range];
    const winRate = d.total > 0 ? (d.wins / d.total * 100).toFixed(1) : 0;
    console.log(`${range.padEnd(10)} | Total: ${d.total.toString().padStart(4)} | Wins: ${d.wins.toString().padStart(4)} | Win Rate: ${winRate.padStart(5)}% | PERFECT: ${d.perfect.toString().padStart(3)} | NEAR PERFECT: ${d.nearPerfect.toString().padStart(3)} | Avg Return: ${d.avgReturn.toFixed(2)}x`);
});

console.log('\n═══════════════════════════════════════════════════════');
console.log('🕐 TIME OF DAY ANALYSIS');
console.log('═══════════════════════════════════════════════════════\n');

Object.keys(timeOfDayAnalysis).sort((a, b) => parseInt(a) - parseInt(b)).forEach(hour => {
    const d = timeOfDayAnalysis[hour];
    const winRate = d.total > 0 ? (d.wins / d.total * 100).toFixed(1) : 0;
    console.log(`${hour.toString().padStart(2, '0')}:00 | Total: ${d.total.toString().padStart(4)} | Wins: ${d.wins.toString().padStart(4)} | Win Rate: ${winRate.padStart(5)}% | PERFECT: ${d.perfect.toString().padStart(3)} | NEAR PERFECT: ${d.nearPerfect.toString().padStart(3)} | Avg Return: ${d.avgReturn.toFixed(2)}x`);
});

console.log('\n═══════════════════════════════════════════════════════');
console.log('📊 ASSET ANALYSIS');
console.log('═══════════════════════════════════════════════════════\n');

Object.keys(assetAnalysis).sort().forEach(asset => {
    const d = assetAnalysis[asset];
    const winRate = d.total > 0 ? (d.wins / d.total * 100).toFixed(1) : 0;
    console.log(`${asset.padEnd(4)} | Total: ${d.total.toString().padStart(4)} | Wins: ${d.wins.toString().padStart(4)} | Win Rate: ${winRate.padStart(5)}% | PERFECT: ${d.perfect.toString().padStart(3)} | NEAR PERFECT: ${d.nearPerfect.toString().padStart(3)} | CONVICTION: ${d.conviction.toString().padStart(3)}`);
});

console.log('\n═══════════════════════════════════════════════════════');
console.log('🎯 PROFIT SIMULATION');
console.log('═══════════════════════════════════════════════════════\n');

// Simulate trading with different strategies
const strategies = [
    { name: 'PERFECT Only', filter: o => o.isPerfect && o.wasCorrect },
    { name: 'PERFECT + NEAR PERFECT', filter: o => (o.isPerfect || o.isNearPerfect) && o.wasCorrect },
    { name: 'Best Entry Prices (<20¢)', filter: o => (o.isPerfect || o.isNearPerfect) && o.wasCorrect && o.entryPrice < 0.20 },
    { name: 'Best Entry Prices (<10¢)', filter: o => (o.isPerfect || o.isNearPerfect) && o.wasCorrect && o.entryPrice < 0.10 },
    { name: 'Best Entry Prices (<5¢)', filter: o => (o.isPerfect || o.isNearPerfect) && o.wasCorrect && o.entryPrice < 0.05 }
];

strategies.forEach(strategy => {
    const trades = profitableOpportunities.filter(strategy.filter);
    if (trades.length === 0) {
        console.log(`${strategy.name.padEnd(30)} | Trades: ${'0'.padStart(3)} | Final: £${'5.00'.padStart(8)} | Return: ${'0.0'.padStart(7)}% | NOT ENOUGH TRADES`);
        return;
    }
    
    // Sort by timestamp to simulate chronological trading
    trades.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
    
    let balance = 5.00;
    const positionSize = 0.50; // 50% per trade
    let tradeCount = 0;
    const maxTrades = 24; // 24 hours, assume 1 trade per hour max
    
    trades.forEach(trade => {
        if (tradeCount >= maxTrades) return;
        const stake = balance * positionSize;
        const profit = stake * trade.profitPerDollar;
        balance = balance + profit;
        tradeCount++;
    });
    
    const returnPct = ((balance / 5.00) - 1) * 100;
    const meetsGoal = balance >= 100.00;
    const status = meetsGoal ? '✅ MEETS GOAL' : '❌ BELOW GOAL';
    console.log(`${strategy.name.padEnd(30)} | Trades: ${tradeCount.toString().padStart(3)} | Final: £${balance.toFixed(2).padStart(8)} | Return: ${returnPct.toFixed(1).padStart(7)}% | ${status}`);
});

console.log('\n═══════════════════════════════════════════════════════');
console.log('✅ ANALYSIS COMPLETE');
console.log('═══════════════════════════════════════════════════════\n');

