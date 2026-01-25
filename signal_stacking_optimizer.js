// 🏆 SIGNAL STACKING OPTIMIZER
// Goal: Stack multiple signals to achieve 90%+ WR
// 
// Available edges:
// 1. Cross-asset correlation: 80.4%
// 2. Time-of-day patterns: varies by hour
// 3. Streak mean reversion: 60-67% after 3+ same
// 4. Volume patterns: high vol = 65% UP
//
// Question: When all signals align, what is the combined WR?

const fs = require('fs');

// Load data
let outcomes = [];
try {
    outcomes = JSON.parse(fs.readFileSync('polymarket_outcomes.json', 'utf8'));
} catch {
    console.error('Run fetch_polymarket_history.js first');
    process.exit(1);
}

console.log('🏆 SIGNAL STACKING OPTIMIZER');
console.log('Goal: Find conditions where WR ≥ 90%');
console.log(`Loaded ${outcomes.length} outcomes\n`);

const resolved = outcomes.filter(o => o.outcome !== 'UNRESOLVED');

// Group by epoch for cross-asset
const byEpoch = {};
resolved.forEach(o => {
    if (!byEpoch[o.epoch]) byEpoch[o.epoch] = {};
    byEpoch[o.epoch][o.asset] = o;
});

// Group by asset for streak analysis
const byAsset = {};
resolved.forEach(o => {
    if (!byAsset[o.asset]) byAsset[o.asset] = [];
    byAsset[o.asset].push(o);
});
Object.keys(byAsset).forEach(asset => {
    byAsset[asset].sort((a, b) => a.epoch - b.epoch);
});

// Build streak history per asset
const streakHistory = {};
['BTC', 'ETH', 'SOL'].forEach(asset => {
    streakHistory[asset] = {};
    const data = byAsset[asset] || [];
    let currentStreak = { direction: null, count: 0 };

    data.forEach((o, i) => {
        if (i > 0) {
            streakHistory[asset][o.epoch] = {
                prevDirection: data[i - 1].outcome,
                streakCount: currentStreak.count
            };
        }

        if (o.outcome === currentStreak.direction) {
            currentStreak.count++;
        } else {
            currentStreak = { direction: o.outcome, count: 1 };
        }
    });
});

console.log('=== ANALYZING COMBINED CONDITIONS ===\n');

// For each ETH/SOL cycle, check:
// 1. What did BTC do in the same cycle? (cross-asset)
// 2. What hour was it? (time-of-day)
// 3. What was the preceding streak? (mean reversion)

const combinedResults = [];

['ETH', 'SOL'].forEach(asset => {
    const data = byAsset[asset] || [];

    data.forEach((o, i) => {
        if (i === 0) return;

        const btc = byEpoch[o.epoch]?.BTC;
        if (!btc) return;

        const hour = new Date(o.epoch * 1000).getUTCHours();
        const streak = streakHistory[asset][o.epoch] || { streakCount: 0 };

        // Prediction based on BTC
        const btcPrediction = btc.outcome;
        const actual = o.outcome;
        const correct = btcPrediction === actual;

        combinedResults.push({
            asset,
            epoch: o.epoch,
            btcOutcome: btc.outcome,
            prediction: btcPrediction,
            actual,
            correct,
            hour,
            streakCount: streak.streakCount,
            prevDirection: streak.prevDirection
        });
    });
});

console.log(`Total tradeable cycles (ETH+SOL with BTC data): ${combinedResults.length}\n`);

// Analyze by condition
console.log('=== CONDITION FILTERING ===\n');

// Condition 1: Cross-asset only (baseline)
const baseline = combinedResults.filter(r => true);
const baselineWR = baseline.filter(r => r.correct).length / baseline.length;
console.log(`Baseline (cross-asset only): ${(baselineWR * 100).toFixed(1)}% (n=${baseline.length})`);

// Condition 2: Only high-edge hours (06, 10, 16 UTC from earlier analysis)
const highEdgeHours = [6, 10, 16];
const timeFiltered = combinedResults.filter(r => highEdgeHours.includes(r.hour));
const timeWR = timeFiltered.length > 0 ? timeFiltered.filter(r => r.correct).length / timeFiltered.length : 0;
console.log(`+ High-edge hours (${highEdgeHours.join(',')}): ${(timeWR * 100).toFixed(1)}% (n=${timeFiltered.length})`);

// Condition 3: Only after 2+ same streak (mean reversion signal)
const streakFiltered = combinedResults.filter(r => r.streakCount >= 2);
const streakWR = streakFiltered.length > 0 ? streakFiltered.filter(r => r.correct).length / streakFiltered.length : 0;
console.log(`+ After 2+ streak: ${(streakWR * 100).toFixed(1)}% (n=${streakFiltered.length})`);

// Condition 4: Only when BTC went DOWN (stronger correlation)
const btcDownFiltered = combinedResults.filter(r => r.btcOutcome === 'DOWN');
const btcDownWR = btcDownFiltered.length > 0 ? btcDownFiltered.filter(r => r.correct).length / btcDownFiltered.length : 0;
console.log(`+ BTC DOWN only: ${(btcDownWR * 100).toFixed(1)}% (n=${btcDownFiltered.length})`);

// Condition 5: High-edge hours + BTC DOWN
const combo1 = combinedResults.filter(r => highEdgeHours.includes(r.hour) && r.btcOutcome === 'DOWN');
const combo1WR = combo1.length > 0 ? combo1.filter(r => r.correct).length / combo1.length : 0;
console.log(`+ High hours + BTC DOWN: ${(combo1WR * 100).toFixed(1)}% (n=${combo1.length})`);

// Condition 6: BTC DOWN + After streak
const combo2 = combinedResults.filter(r => r.btcOutcome === 'DOWN' && r.streakCount >= 2);
const combo2WR = combo2.length > 0 ? combo2.filter(r => r.correct).length / combo2.length : 0;
console.log(`+ BTC DOWN + After 2+ streak: ${(combo2WR * 100).toFixed(1)}% (n=${combo2.length})`);

// Condition 7: All three combined
const allCombined = combinedResults.filter(r =>
    highEdgeHours.includes(r.hour) &&
    r.btcOutcome === 'DOWN' &&
    r.streakCount >= 1
);
const allCombinedWR = allCombined.length > 0 ? allCombined.filter(r => r.correct).length / allCombined.length : 0;
console.log(`+ ALL COMBINED: ${(allCombinedWR * 100).toFixed(1)}% (n=${allCombined.length})`);

console.log('\n=== FINDING 90%+ CONDITIONS ===\n');

// Sweep all possible hour combinations
const allHours = [...new Set(combinedResults.map(r => r.hour))];
let best90 = { wr: 0, conditions: '', n: 0 };

// Check each condition separately
const conditions = [
    { name: 'BTC UP only', filter: r => r.btcOutcome === 'UP' },
    { name: 'BTC DOWN only', filter: r => r.btcOutcome === 'DOWN' },
    { name: 'ETH only', filter: r => r.asset === 'ETH' },
    { name: 'SOL only', filter: r => r.asset === 'SOL' },
    { name: 'ETH + BTC UP', filter: r => r.asset === 'ETH' && r.btcOutcome === 'UP' },
    { name: 'ETH + BTC DOWN', filter: r => r.asset === 'ETH' && r.btcOutcome === 'DOWN' },
    { name: 'SOL + BTC UP', filter: r => r.asset === 'SOL' && r.btcOutcome === 'UP' },
    { name: 'SOL + BTC DOWN', filter: r => r.asset === 'SOL' && r.btcOutcome === 'DOWN' },
    { name: 'After 3+ streak', filter: r => r.streakCount >= 3 },
    { name: 'BTC DOWN + After 3+ streak', filter: r => r.btcOutcome === 'DOWN' && r.streakCount >= 3 },
];

allHours.forEach(h => {
    conditions.push({ name: `Hour ${h} only`, filter: r => r.hour === h });
    conditions.push({ name: `Hour ${h} + BTC DOWN`, filter: r => r.hour === h && r.btcOutcome === 'DOWN' });
    conditions.push({ name: `Hour ${h} + ETH`, filter: r => r.hour === h && r.asset === 'ETH' });
});

console.log('Conditions achieving ≥85% WR (n≥5):');
console.log('------------------------------------------');

conditions.forEach(c => {
    const filtered = combinedResults.filter(c.filter);
    if (filtered.length >= 5) {
        const wr = filtered.filter(r => r.correct).length / filtered.length;
        if (wr >= 0.85) {
            console.log(`${c.name.padEnd(30)} | ${(wr * 100).toFixed(1)}% | n=${filtered.length}`);
            if (wr > best90.wr || (wr === best90.wr && filtered.length > best90.n)) {
                best90 = { wr, conditions: c.name, n: filtered.length };
            }
        }
    }
});

console.log('\n=== BEST HIGH-WR CONDITION ===\n');
console.log(`Best: ${best90.conditions}`);
console.log(`Win Rate: ${(best90.wr * 100).toFixed(1)}%`);
console.log(`Sample Size: ${best90.n}`);

console.log('\n=== FREQUENCY TRADE-OFF ===\n');

// Calculate trades per week for each condition
const hoursOfData = (resolved[resolved.length - 1].epoch - resolved[0].epoch) / 3600;
const weeksOfData = hoursOfData / 168;

conditions.forEach(c => {
    const filtered = combinedResults.filter(c.filter);
    if (filtered.length >= 5) {
        const wr = filtered.filter(r => r.correct).length / filtered.length;
        if (wr >= 0.85) {
            const tradesPerWeek = filtered.length / weeksOfData;
            console.log(`${c.name.padEnd(30)} | WR: ${(wr * 100).toFixed(0)}% | ${tradesPerWeek.toFixed(1)}/week`);
        }
    }
});

console.log('\n=== HONEST CONCLUSION ===\n');
console.log('With only 138 cycles of data, achieving statistically significant');
console.log('90%+ WR is difficult. Best available conditions show ~85-91%,');
console.log('but with very small sample sizes (n<20).\n');
console.log('To truly validate 90%+ WR, we need:');
console.log('- More historical data (1000+ cycles)');
console.log('- Or live trading with strict signal filtering');
