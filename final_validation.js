// 🏆 FINAL VALIDATION: ETH + BTC DOWN (91.3% WR)
// Re-run Monte Carlo with the CORRECT win rate

console.log('🏆 FINAL VALIDATION: Refined Golden Strategy');
console.log('===========================================\n');

const WIN_RATE = 0.913; // ETH when BTC goes DOWN
const AVG_ROI = 0.60;
const SIMULATIONS = 10000;

function simulateToTarget(wr, roi, sizing, start, target) {
    let balance = start;
    let trades = 0;
    while (balance < target && balance > 0.5 && trades < 3000) {
        const stake = balance * sizing;
        if (Math.random() < wr) {
            balance += stake * roi;
        } else {
            balance -= stake;
        }
        trades++;
    }
    return { success: balance >= target, busted: balance < 0.5, trades };
}

console.log('=== REVISED SIZING SWEEP WITH 91.3% WR ===\n');
console.log('Sizing | Success% | Bust% | Avg Trades | Days to $1M');
console.log('-------|----------|-------|------------|------------');

const results = [];
for (let sizing = 0.20; sizing <= 0.80; sizing += 0.10) {
    let successes = 0;
    let busts = 0;
    let totalTrades = 0;

    for (let i = 0; i < SIMULATIONS; i++) {
        const result = simulateToTarget(WIN_RATE, AVG_ROI, sizing, 1, 1000000);
        if (result.success) {
            successes++;
            totalTrades += result.trades;
        }
        if (result.busted) busts++;
    }

    const successRate = successes / SIMULATIONS;
    const bustRate = busts / SIMULATIONS;
    const avgTrades = successes > 0 ? totalTrades / successes : Infinity;
    // ETH + BTC DOWN happens ~0.5 times per hour (every other cycle when BTC goes DOWN)
    const tradesPerHour = 0.5;
    const days = avgTrades / (tradesPerHour * 24);

    results.push({ sizing, successRate, bustRate, avgTrades, days });
    console.log(`  ${(sizing * 100).toFixed(0).padStart(2)}%  |  ${(successRate * 100).toFixed(1).padStart(5)}%  | ${(bustRate * 100).toFixed(1).padStart(5)}% |   ${avgTrades.toFixed(0).padStart(6)}   | ${days.toFixed(1)}`);
}

// Find optimal (highest success rate then fastest)
const optimal = results.reduce((best, r) => {
    if (r.successRate > best.successRate) return r;
    if (r.successRate === best.successRate && r.avgTrades < best.avgTrades) return r;
    return best;
}, results[0]);

console.log('\n=== OPTIMAL STRATEGY ===\n');
console.log(`Win Rate: 91.3% (ETH when BTC goes DOWN)`);
console.log(`Position Size: ${(optimal.sizing * 100).toFixed(0)}%`);
console.log(`Success Rate: ${(optimal.successRate * 100).toFixed(1)}%`);
console.log(`Bust Rate: ${(optimal.bustRate * 100).toFixed(2)}%`);
console.log(`Trades to $1M: ${optimal.avgTrades.toFixed(0)}`);
console.log(`Time to $1M: ${optimal.days.toFixed(1)} days`);

console.log('\n=== FREQUENCY ANALYSIS ===\n');
console.log('ETH + BTC DOWN occurs when:');
console.log('- BTC price drops during a 15-min cycle');
console.log('- This happens roughly 50% of cycles');
console.log('- But we NEED BTC to go DOWN first (we follow)');
console.log('');
console.log('Estimated frequency: ~2 opportunities per hour');
console.log('But we can only take ETH (not SOL) = ~1 trade per hour');

console.log('\n=== FINAL GOLDEN STRATEGY ===\n');
console.log('📌 CONDITION: Only trade ETH when BTC goes DOWN');
console.log('📌 WIN RATE: 91.3% (verified from 23 samples)');
console.log(`📌 SIZING: ${(optimal.sizing * 100).toFixed(0)}%`);
console.log(`📌 SUCCESS RATE: ${(optimal.successRate * 100).toFixed(1)}%`);
console.log(`📌 TIME TO $1M: ~${optimal.days.toFixed(0)} days`);
console.log('');
console.log('HOW TO EXECUTE:');
console.log('1. Watch BTC in first 5 minutes of each 15-min cycle');
console.log('2. If BTC is trending DOWN → Buy ETH DOWN (at 40-45¢)');
console.log('3. Stake chosen % of bankroll');
console.log('4. Repeat ~1x per hour when BTC drops');

console.log('\n===========================================');
console.log('⚠️ SAMPLE SIZE WARNING:');
console.log('91.3% WR based on n=23 samples.');
console.log('Statistical uncertainty: ±10-15%');
console.log('True WR could be 76-100% range.');
console.log('More data needed for high confidence.');
console.log('===========================================');
