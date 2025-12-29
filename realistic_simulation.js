/**
 * REALISTIC SIMULATION: Based on actual entry price distribution
 * 
 * Goal: £100 in 24 hours from £5 (20x return)
 */

const fs = require('fs');
const path = require('path');

const files = fs.readdirSync('debug').filter(f => f.endsWith('.json')).sort();

let allTrades = [];

files.forEach(file => {
    try {
        const data = JSON.parse(fs.readFileSync(path.join('debug', file), 'utf8'));
        Object.values(data.assets || {}).forEach(asset => {
            (asset.cycleHistory || []).forEach(cycle => {
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
                
                if (!isPerfect && !isNearPerfect) return;
                if (!wasCorrect) return;
                
                const marketOdds = cycle.marketOdds || { yesPrice: 0.5, noPrice: 0.5 };
                const entryPrice = prediction === 'UP' ? marketOdds.yesPrice : marketOdds.noPrice;
                const returnMultiplier = 1.0 / entryPrice;
                
                allTrades.push({
                    timestamp: cycle.cycleEndTime,
                    entryPrice,
                    returnMultiplier,
                    isPerfect
                });
            });
        });
    } catch(e) {}
});

// Sort by timestamp
allTrades.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));

console.log('═══════════════════════════════════════════════════════');
console.log('🎯 REALISTIC SIMULATION');
console.log('═══════════════════════════════════════════════════════\n');

// Strategy 1: Trade ALL PERFECT/NEAR PERFECT (first 24 chronologically)
console.log('Strategy 1: First 24 PERFECT/NEAR PERFECT trades (chronological)');
let balance = 5.00;
const positionSize = 0.50;
allTrades.slice(0, 24).forEach((trade, i) => {
    const stake = balance * positionSize;
    const profit = stake * (trade.returnMultiplier - 1);
    balance = balance + profit;
    console.log(`  Trade ${i+1}: Entry ${(trade.entryPrice*100).toFixed(2)}¢ | Return ${trade.returnMultiplier.toFixed(2)}x | Balance: £${balance.toFixed(2)}`);
});
const return1 = ((balance / 5.00) - 1) * 100;
console.log(`  Final: £${balance.toFixed(2)} | Return: ${return1.toFixed(1)}% | ${balance >= 100 ? '✅ MEETS GOAL' : '❌ BELOW GOAL'}\n`);

// Strategy 2: Only trade when entry price < 20¢
console.log('Strategy 2: PERFECT/NEAR PERFECT with entry < 20¢ (first 24)');
balance = 5.00;
const lowPriceTrades = allTrades.filter(t => t.entryPrice < 0.20).slice(0, 24);
if (lowPriceTrades.length === 0) {
    console.log('  ❌ NO TRADES AVAILABLE - Not enough low-price opportunities\n');
} else {
    lowPriceTrades.forEach((trade, i) => {
        const stake = balance * positionSize;
        const profit = stake * (trade.returnMultiplier - 1);
        balance = balance + profit;
        console.log(`  Trade ${i+1}: Entry ${(trade.entryPrice*100).toFixed(2)}¢ | Return ${trade.returnMultiplier.toFixed(2)}x | Balance: £${balance.toFixed(2)}`);
    });
    const return2 = ((balance / 5.00) - 1) * 100;
    console.log(`  Final: £${balance.toFixed(2)} | Return: ${return2.toFixed(1)}% | Trades: ${lowPriceTrades.length} | ${balance >= 100 ? '✅ MEETS GOAL' : '❌ BELOW GOAL'}\n`);
}

// Strategy 3: Realistic - Random sample of 24 trades (simulating what we'd actually get)
console.log('Strategy 3: Random sample of 24 trades (realistic scenario)');
balance = 5.00;
const randomTrades = [];
for (let i = 0; i < 24; i++) {
    const randomIdx = Math.floor(Math.random() * allTrades.length);
    randomTrades.push(allTrades[randomIdx]);
}
randomTrades.forEach((trade, i) => {
    const stake = balance * positionSize;
    const profit = stake * (trade.returnMultiplier - 1);
    balance = balance + profit;
});
const return3 = ((balance / 5.00) - 1) * 100;
const avgEntry = randomTrades.reduce((s, t) => s + t.entryPrice, 0) / randomTrades.length;
console.log(`  Final: £${balance.toFixed(2)} | Return: ${return3.toFixed(1)}% | Avg Entry: ${(avgEntry*100).toFixed(2)}¢ | ${balance >= 100 ? '✅ MEETS GOAL' : '❌ BELOW GOAL'}\n`);

// Strategy 4: Worst case - All trades at 99¢ (most common)
console.log('Strategy 4: Worst case - All trades at 99¢ (most common scenario)');
balance = 5.00;
for (let i = 0; i < 24; i++) {
    const stake = balance * positionSize;
    const profit = stake * (1.0 / 0.99 - 1); // 99¢ entry
    balance = balance + profit;
}
const return4 = ((balance / 5.00) - 1) * 100;
console.log(`  Final: £${balance.toFixed(2)} | Return: ${return4.toFixed(1)}% | ${balance >= 100 ? '✅ MEETS GOAL' : '❌ BELOW GOAL'}\n`);

// Analysis
console.log('═══════════════════════════════════════════════════════');
console.log('📊 KEY FINDINGS');
console.log('═══════════════════════════════════════════════════════\n');

const entryPriceDistribution = {};
allTrades.forEach(t => {
    const range = t.entryPrice < 0.05 ? '0-5¢' : 
                 t.entryPrice < 0.10 ? '5-10¢' :
                 t.entryPrice < 0.20 ? '10-20¢' :
                 t.entryPrice < 0.50 ? '20-50¢' :
                 t.entryPrice < 0.80 ? '50-80¢' : '80-100¢';
    entryPriceDistribution[range] = (entryPriceDistribution[range] || 0) + 1;
});

console.log('Entry price distribution:');
Object.keys(entryPriceDistribution).sort().forEach(range => {
    const count = entryPriceDistribution[range];
    const pct = (count / allTrades.length * 100).toFixed(1);
    console.log(`  ${range.padEnd(10)}: ${count.toString().padStart(4)} (${pct.padStart(5)}%)`);
});

console.log(`\nTotal PERFECT/NEAR PERFECT opportunities: ${allTrades.length}`);
console.log(`Opportunities with entry < 20¢: ${allTrades.filter(t => t.entryPrice < 0.20).length}`);
console.log(`Opportunities with entry < 10¢: ${allTrades.filter(t => t.entryPrice < 0.10).length}`);
console.log(`Opportunities with entry < 5¢: ${allTrades.filter(t => t.entryPrice < 0.05).length}`);

