// 🎯 OPTIMAL SIZING CALCULATOR
// Finds the position sizing sweet spot for $1 → $1M
// that maximizes speed while surviving variance
//
// Key insight: 80% WR with 80% sizing = 82.5% bust rate!
// Need to find the sizing that balances speed vs survival

console.log('🎯 OPTIMAL SIZING CALCULATOR FOR $1 → $1M');
console.log('===========================================\n');

const SIMULATIONS = 10000;
const WIN_RATE = 0.804; // From cross-asset analysis
const AVG_ROI = 0.60; // 40¢ entry = 60% ROI
const TARGET = 1000000;
const START = 1;

function simulate(winRate, roi, sizing, startBalance, target) {
    let balance = startBalance;
    let trades = 0;
    let maxBalance = startBalance;
    let minBalance = startBalance;

    while (balance < target && balance > 0.1 && trades < 5000) {
        const stake = balance * sizing;
        const isWin = Math.random() < winRate;

        if (isWin) {
            balance += stake * roi;
        } else {
            balance -= stake;
        }

        maxBalance = Math.max(maxBalance, balance);
        minBalance = Math.min(minBalance, balance);
        trades++;
    }

    return {
        success: balance >= target,
        busted: balance < 1,
        finalBalance: balance,
        trades,
        maxDrawdown: maxBalance > 0 ? (maxBalance - minBalance) / maxBalance : 1
    };
}

function runSimulations(winRate, roi, sizing, n) {
    const results = [];
    for (let i = 0; i < n; i++) {
        results.push(simulate(winRate, roi, sizing, START, TARGET));
    }

    const successes = results.filter(r => r.success);
    const busts = results.filter(r => r.busted);

    return {
        successRate: successes.length / n,
        bustRate: busts.length / n,
        avgTrades: successes.length > 0 ? successes.reduce((s, r) => s + r.trades, 0) / successes.length : Infinity,
        avgDrawdown: results.reduce((s, r) => s + r.maxDrawdown, 0) / n
    };
}

console.log('Sweeping position sizing from 10% to 90%...\n');
console.log('Sizing | Success% | Bust% | Avg Trades | Speed Score');
console.log('-------|----------|-------|------------|------------');

const results = [];
for (let sizing = 0.10; sizing <= 0.90; sizing += 0.05) {
    const result = runSimulations(WIN_RATE, AVG_ROI, sizing, SIMULATIONS);
    const speedScore = result.successRate * 100 / Math.sqrt(result.avgTrades);
    results.push({ sizing, ...result, speedScore });

    console.log(`  ${(sizing * 100).toFixed(0).padStart(2)}%  |  ${(result.successRate * 100).toFixed(1).padStart(5)}%  | ${(result.bustRate * 100).toFixed(1).padStart(5)}% |   ${result.avgTrades.toFixed(0).padStart(6)}   | ${speedScore.toFixed(2)}`);
}

// Find optimal sizing
const viable = results.filter(r => r.successRate >= 0.50); // Min 50% survival
const optimal = viable.reduce((best, r) => r.speedScore > best.speedScore ? r : best, viable[0] || results[0]);

console.log('\n===========================================');
console.log('           🏆 OPTIMAL SIZING               ');
console.log('===========================================\n');

console.log(`Optimal Position Size: ${(optimal.sizing * 100).toFixed(0)}%`);
console.log(`Success Rate (→$1M): ${(optimal.successRate * 100).toFixed(1)}%`);
console.log(`Bust Rate: ${(optimal.bustRate * 100).toFixed(1)}%`);
console.log(`Average Trades to $1M: ${optimal.avgTrades.toFixed(0)}`);
console.log(`At 2 trades/hr: ${(optimal.avgTrades / 2).toFixed(0)} hours = ${(optimal.avgTrades / 48).toFixed(1)} days`);

console.log('\n===========================================');
console.log('    📊 USER GOAL: MAXIMUM PROFIT ASAP    ');
console.log('===========================================\n');

// Find the fastest sizing with reasonable survival
const fast = results.filter(r => r.successRate >= 0.25); // Accept 25% survival for speed
const fastest = fast.reduce((best, r) => r.avgTrades < best.avgTrades ? r : best, fast[fast.length - 1]);

console.log('AGGRESSIVE (Speed Priority):');
console.log(`  Sizing: ${(fastest.sizing * 100).toFixed(0)}%`);
console.log(`  Success Rate: ${(fastest.successRate * 100).toFixed(1)}%`);
console.log(`  Time to $1M: ${(fastest.avgTrades / 48).toFixed(1)} days`);
console.log(`  ⚠️ ${(fastest.bustRate * 100).toFixed(0)}% chance of bust`);

console.log('\nCONSERVATIVE (Survival Priority):');
const conservative = viable[0];
if (conservative) {
    console.log(`  Sizing: ${(conservative.sizing * 100).toFixed(0)}%`);
    console.log(`  Success Rate: ${(conservative.successRate * 100).toFixed(1)}%`);
    console.log(`  Time to $1M: ${(conservative.avgTrades / 48).toFixed(1)} days`);
    console.log(`  ⚠️ ${(conservative.bustRate * 100).toFixed(0)}% chance of bust`);
}

console.log('\nBALANCED (Sweet Spot):');
console.log(`  Sizing: ${(optimal.sizing * 100).toFixed(0)}%`);
console.log(`  Success Rate: ${(optimal.successRate * 100).toFixed(1)}%`);
console.log(`  Time to $1M: ${(optimal.avgTrades / 48).toFixed(1)} days`);
console.log(`  ⚠️ ${(optimal.bustRate * 100).toFixed(0)}% chance of bust`);

console.log('\n===========================================');
console.log('         🎯 FINAL RECOMMENDATION           ');
console.log('===========================================\n');

console.log(`With 80.4% win rate (Cross-Asset Following strategy):`);
console.log();
console.log(`📌 GOLDEN STRATEGY PARAMETERS:`);
console.log(`   • Win Rate: 80.4% (via BTC→ETH/SOL correlation)`);
console.log(`   • Entry Price: 40-45¢ (60% ROI)`);
console.log(`   • Position Size: ${(optimal.sizing * 100).toFixed(0)}% of bankroll`);
console.log(`   • Frequency: 2 trades per hour`);
console.log(`   • Expected Time to $1M: ${(optimal.avgTrades / 48).toFixed(1)} days`);
console.log(`   • Survival Rate: ${(optimal.successRate * 100).toFixed(1)}%`);
console.log();
console.log(`🔥 For MAXIMUM SPEED (user wants ASAP):`);
console.log(`   • Use ${(fastest.sizing * 100).toFixed(0)}% sizing`);
console.log(`   • Reach $1M in ~${(fastest.avgTrades / 48).toFixed(1)} days`);
console.log(`   • But ${(fastest.bustRate * 100).toFixed(0)}% bust risk - need ${Math.ceil(1 / fastest.successRate)} attempts on average`);
