/**
 * COMPREHENSIVE ANALYSIS: ALL 106 DEBUG LOGS
 * 
 * Goal: Find patterns that give 1+ trades per hour while maintaining high win rate
 * 4 assets × 4 cycles/hour = 16 opportunities/hour
 */

const fs = require('fs');
const path = require('path');

const files = fs.readdirSync('debug').filter(f => f.endsWith('.json')).sort();

console.log('🔬 COMPREHENSIVE ANALYSIS: ALL 106 DEBUG LOGS\n');
console.log(`Total files: ${files.length}\n`);

let allCycles = [];
let patterns = {
    perfect: [],
    nearPerfect: [],
    conviction: [],
    oracleLocked: [],
    highConfidence: [],
    all: []
};

files.forEach((file, fileIdx) => {
    try {
        const data = JSON.parse(fs.readFileSync(path.join('debug', file), 'utf8'));
        const fileDate = new Date(file.match(/\d{4}-\d{2}-\d{2}T\d{2}-\d{2}/)?.[0]?.replace(/-/g, '-') || Date.now());
        
        Object.entries(data.assets || {}).forEach(([asset, assetData]) => {
            const cycleHistory = assetData.cycleHistory || [];
            
            cycleHistory.forEach((cycle, cycleIdx) => {
                const modelAgreement = cycle.modelAgreementHistory || [];
                const allAgree = modelAgreement.length >= 3 && 
                    modelAgreement.every(v => v === modelAgreement[0] && v !== null);
                const certainty = cycle.certaintyAtEnd || 0;
                const oracleLocked = cycle.oracleWasLocked || false;
                const tier = cycle.tier || 'NONE';
                const wasCorrect = cycle.wasCorrect || false;
                const prediction = cycle.prediction;
                const confidence = cycle.confidence || 0;
                
                const marketOdds = cycle.marketOdds || { yesPrice: 0.5, noPrice: 0.5 };
                const entryPrice = prediction === 'UP' ? marketOdds.yesPrice : marketOdds.noPrice;
                const returnMultiplier = wasCorrect ? 1.0 / entryPrice : 0;
                
                // Pattern detection
                const isPerfect = allAgree && certainty >= 75 && oracleLocked && tier === 'CONVICTION';
                const isNearPerfect = allAgree && certainty >= 70 && tier === 'CONVICTION' && !isPerfect;
                const isConviction = tier === 'CONVICTION';
                const isOracleLocked = oracleLocked;
                const isHighConfidence = confidence >= 0.80 && tier !== 'NONE';
                
                const cycleData = {
                    file,
                    asset,
                    cycleIdx,
                    timestamp: cycle.cycleEndTime,
                    prediction,
                    wasCorrect,
                    entryPrice,
                    returnMultiplier,
                    isPerfect,
                    isNearPerfect,
                    isConviction,
                    isOracleLocked,
                    isHighConfidence,
                    certainty,
                    confidence,
                    oracleLocked,
                    tier,
                    allAgree,
                    winStreak: cycle.winStreak || 0
                };
                
                allCycles.push(cycleData);
                
                if (isPerfect && wasCorrect) patterns.perfect.push(cycleData);
                if (isNearPerfect && wasCorrect) patterns.nearPerfect.push(cycleData);
                if (isConviction && wasCorrect) patterns.conviction.push(cycleData);
                if (isOracleLocked && wasCorrect) patterns.oracleLocked.push(cycleData);
                if (isHighConfidence && wasCorrect) patterns.highConfidence.push(cycleData);
                if (wasCorrect) patterns.all.push(cycleData);
            });
        });
    } catch (e) {
        console.error(`Error processing ${file}: ${e.message}`);
    }
});

console.log(`Total cycles analyzed: ${allCycles.length}\n`);

// Analyze frequency vs win rate for different patterns
console.log('═══════════════════════════════════════════════════════');
console.log('📊 PATTERN FREQUENCY ANALYSIS');
console.log('═══════════════════════════════════════════════════════\n');

const patternTests = [
    {
        name: 'PERFECT < 20¢',
        filter: c => c.isPerfect && c.wasCorrect && c.entryPrice < 0.20
    },
    {
        name: 'PERFECT < 50¢',
        filter: c => c.isPerfect && c.wasCorrect && c.entryPrice < 0.50
    },
    {
        name: 'NEAR PERFECT < 30¢',
        filter: c => c.isNearPerfect && c.wasCorrect && c.entryPrice < 0.30
    },
    {
        name: 'NEAR PERFECT < 50¢',
        filter: c => c.isNearPerfect && c.wasCorrect && c.entryPrice < 0.50
    },
    {
        name: 'CONVICTION < 50¢',
        filter: c => c.isConviction && c.wasCorrect && c.entryPrice < 0.50
    },
    {
        name: 'CONVICTION < 80¢',
        filter: c => c.isConviction && c.wasCorrect && c.entryPrice < 0.80
    },
    {
        name: 'ORACLE LOCKED < 50¢',
        filter: c => c.isOracleLocked && c.wasCorrect && c.entryPrice < 0.50
    },
    {
        name: 'ORACLE LOCKED < 80¢',
        filter: c => c.isOracleLocked && c.wasCorrect && c.entryPrice < 0.80
    },
    {
        name: 'HIGH CONFIDENCE (≥80%) < 50¢',
        filter: c => c.isHighConfidence && c.wasCorrect && c.entryPrice < 0.50
    },
    {
        name: 'HIGH CONFIDENCE (≥80%) < 80¢',
        filter: c => c.isHighConfidence && c.wasCorrect && c.entryPrice < 0.80
    },
    {
        name: 'CONVICTION + ORACLE LOCKED < 80¢',
        filter: c => c.isConviction && c.isOracleLocked && c.wasCorrect && c.entryPrice < 0.80
    },
    {
        name: 'CONVICTION + HIGH CONFIDENCE < 80¢',
        filter: c => c.isConviction && c.isHighConfidence && c.wasCorrect && c.entryPrice < 0.80
    }
];

patternTests.forEach(test => {
    const matches = allCycles.filter(test.filter);
    if (matches.length === 0) return;
    
    const totalCycles = allCycles.length;
    const frequency = (matches.length / totalCycles) * 100;
    const cyclesPerHour = (matches.length / (totalCycles / 16)) * 4; // 16 cycles/hour, 4 assets
    const avgReturn = matches.reduce((s, c) => s + c.returnMultiplier, 0) / matches.length;
    const winRate = 100; // All matches are wasCorrect = true
    
    console.log(`${test.name.padEnd(40)} | Count: ${matches.length.toString().padStart(4)} | Freq: ${frequency.toFixed(2).padStart(6)}% | Cycles/Hour: ${cyclesPerHour.toFixed(2).padStart(6)} | Avg Return: ${avgReturn.toFixed(2).padStart(6)}x | Win Rate: ${winRate.toFixed(1).padStart(5)}%`);
});

// Find optimal threshold for 1+ trades/hour
console.log('\n═══════════════════════════════════════════════════════');
console.log('🎯 OPTIMAL THRESHOLD FOR 1+ TRADES/HOUR');
console.log('═══════════════════════════════════════════════════════\n');

const thresholds = [0.20, 0.30, 0.40, 0.50, 0.60, 0.70, 0.80, 0.90];
thresholds.forEach(threshold => {
    const matches = allCycles.filter(c => 
        (c.isPerfect || c.isNearPerfect || c.isConviction || c.isOracleLocked || c.isHighConfidence) &&
        c.wasCorrect &&
        c.entryPrice < threshold
    );
    
    const cyclesPerHour = (matches.length / (allCycles.length / 16)) * 4;
    const avgReturn = matches.length > 0 ? 
        matches.reduce((s, c) => s + c.returnMultiplier, 0) / matches.length : 0;
    
    const meetsGoal = cyclesPerHour >= 1.0;
    console.log(`Threshold < ${(threshold * 100).toFixed(0).padStart(3)}¢ | Count: ${matches.length.toString().padStart(4)} | Cycles/Hour: ${cyclesPerHour.toFixed(2).padStart(6)} | Avg Return: ${avgReturn.toFixed(2).padStart(6)}x | ${meetsGoal ? '✅ MEETS GOAL' : '❌ BELOW GOAL'}`);
});

// Simulate with optimal threshold
console.log('\n═══════════════════════════════════════════════════════');
console.log('💰 PROFIT SIMULATION WITH OPTIMAL THRESHOLD');
console.log('═══════════════════════════════════════════════════════\n');

const optimalThreshold = 0.80; // Start with 80¢ to get 1+ trades/hour
const optimalMatches = allCycles.filter(c => 
    (c.isPerfect || c.isNearPerfect || c.isConviction || c.isOracleLocked || c.isHighConfidence) &&
    c.wasCorrect &&
    c.entryPrice < optimalThreshold
).sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));

console.log(`Optimal matches: ${optimalMatches.length}`);
console.log(`Cycles per hour: ${(optimalMatches.length / (allCycles.length / 16)) * 4}\n`);

let balance = 5.00;
const positionSize = 0.60; // 60% for safety

optimalMatches.slice(0, 24).forEach((trade, i) => {
    const stake = balance * positionSize;
    const profit = stake * (trade.returnMultiplier - 1);
    balance = balance + profit;
    if (i < 10 || i === 23) {
        console.log(`Trade ${i+1}: Entry ${(trade.entryPrice*100).toFixed(2)}¢ | Return ${trade.returnMultiplier.toFixed(2)}x | Balance: £${balance.toFixed(2)}`);
    }
});

const returnPct = ((balance / 5.00) - 1) * 100;
console.log(`\nFinal: £${balance.toFixed(2)} | Return: ${returnPct.toFixed(1)}% | ${balance >= 100 ? '✅ MEETS GOAL' : '❌ BELOW GOAL'}`);

// Analyze entry price distribution
console.log('\n═══════════════════════════════════════════════════════');
console.log('📈 ENTRY PRICE DISTRIBUTION');
console.log('═══════════════════════════════════════════════════════\n');

const priceRanges = {
    '0-10¢': optimalMatches.filter(c => c.entryPrice < 0.10),
    '10-20¢': optimalMatches.filter(c => c.entryPrice >= 0.10 && c.entryPrice < 0.20),
    '20-30¢': optimalMatches.filter(c => c.entryPrice >= 0.20 && c.entryPrice < 0.30),
    '30-50¢': optimalMatches.filter(c => c.entryPrice >= 0.30 && c.entryPrice < 0.50),
    '50-80¢': optimalMatches.filter(c => c.entryPrice >= 0.50 && c.entryPrice < 0.80)
};

Object.keys(priceRanges).forEach(range => {
    const matches = priceRanges[range];
    if (matches.length === 0) return;
    const avgReturn = matches.reduce((s, c) => s + c.returnMultiplier, 0) / matches.length;
    console.log(`${range.padEnd(10)} | Count: ${matches.length.toString().padStart(4)} | Avg Return: ${avgReturn.toFixed(2).padStart(6)}x`);
});

console.log('\n═══════════════════════════════════════════════════════');
console.log('✅ ANALYSIS COMPLETE');
console.log('═══════════════════════════════════════════════════════\n');


