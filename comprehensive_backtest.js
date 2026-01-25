// 🏆 COMPREHENSIVE STRATEGY BACKTEST
// Analyzes MAXIMUM historical data to verify ETH + BTC DOWN strategy
// and test for potential failure modes in manual trading
//
// Per DEITY protocol:
// - Stress test with worst variance
// - Check for holes/downfalls
// - Verify meets 90% WR requirement
// - Ensure works for manual trading

const fs = require('fs');

// Load maximum historical data
let outcomes = [];
try {
    outcomes = JSON.parse(fs.readFileSync('polymarket_max_history.json', 'utf8'));
    console.log(`✅ Loaded ${outcomes.length} outcomes from polymarket_max_history.json`);
} catch {
    try {
        outcomes = JSON.parse(fs.readFileSync('polymarket_outcomes.json', 'utf8'));
        console.log(`⚠️ Using fallback: ${outcomes.length} outcomes from polymarket_outcomes.json`);
    } catch {
        console.error('❌ No data files found. Run fetch_max_history.js first.');
        process.exit(1);
    }
}

console.log('\n🏆 COMPREHENSIVE STRATEGY BACKTEST');
console.log('=====================================\n');

// Filter resolved
const resolved = outcomes.filter(o => o.outcome !== 'UNRESOLVED');
console.log(`Resolved cycles: ${resolved.length}`);

// Date range
const dates = resolved.map(r => new Date(r.epoch * 1000));
const minDate = new Date(Math.min(...resolved.map(r => r.epoch * 1000)));
const maxDate = new Date(Math.max(...resolved.map(r => r.epoch * 1000)));
const daysCovered = (maxDate - minDate) / (1000 * 60 * 60 * 24);
console.log(`Date range: ${minDate.toISOString().split('T')[0]} to ${maxDate.toISOString().split('T')[0]}`);
console.log(`Days covered: ${daysCovered.toFixed(1)}`);

// Group by epoch for cross-asset analysis
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

console.log('\n=== 1. OVERALL MARKET STATISTICS ===\n');

// Overall UP/DOWN distribution
for (const asset of ['BTC', 'ETH', 'SOL']) {
    const assetData = resolved.filter(r => r.asset === asset);
    const up = assetData.filter(r => r.outcome === 'UP').length;
    const down = assetData.filter(r => r.outcome === 'DOWN').length;
    const upPct = assetData.length > 0 ? (up / assetData.length * 100).toFixed(1) : 'N/A';
    console.log(`${asset}: UP=${up} (${upPct}%), DOWN=${down}, Total=${assetData.length}`);
}

console.log('\n=== 2. CROSS-ASSET CORRELATION (FULL DATA) ===\n');

// Compute cross-asset correlation with large sample
function computeCrossAsset() {
    const results = {
        btcUpEthUp: 0, btcUpEthDown: 0,
        btcDownEthUp: 0, btcDownEthDown: 0,
        btcUpSolUp: 0, btcUpSolDown: 0,
        btcDownSolUp: 0, btcDownSolDown: 0
    };

    Object.values(byEpoch).forEach(cycle => {
        const btc = cycle.BTC?.outcome;
        const eth = cycle.ETH?.outcome;
        const sol = cycle.SOL?.outcome;

        if (btc && eth) {
            if (btc === 'UP' && eth === 'UP') results.btcUpEthUp++;
            if (btc === 'UP' && eth === 'DOWN') results.btcUpEthDown++;
            if (btc === 'DOWN' && eth === 'UP') results.btcDownEthUp++;
            if (btc === 'DOWN' && eth === 'DOWN') results.btcDownEthDown++;
        }
        if (btc && sol) {
            if (btc === 'UP' && sol === 'UP') results.btcUpSolUp++;
            if (btc === 'UP' && sol === 'DOWN') results.btcUpSolDown++;
            if (btc === 'DOWN' && sol === 'UP') results.btcDownSolUp++;
            if (btc === 'DOWN' && sol === 'DOWN') results.btcDownSolDown++;
        }
    });

    return results;
}

const crossAsset = computeCrossAsset();
const btcUpEthTotal = crossAsset.btcUpEthUp + crossAsset.btcUpEthDown;
const btcDownEthTotal = crossAsset.btcDownEthUp + crossAsset.btcDownEthDown;
const btcUpSolTotal = crossAsset.btcUpSolUp + crossAsset.btcUpSolDown;
const btcDownSolTotal = crossAsset.btcDownSolUp + crossAsset.btcDownSolDown;

console.log('BTC → ETH Correlation:');
console.log(`  BTC UP   → ETH UP:   ${btcUpEthTotal > 0 ? (crossAsset.btcUpEthUp / btcUpEthTotal * 100).toFixed(1) : 'N/A'}% (n=${btcUpEthTotal})`);
console.log(`  BTC DOWN → ETH DOWN: ${btcDownEthTotal > 0 ? (crossAsset.btcDownEthDown / btcDownEthTotal * 100).toFixed(1) : 'N/A'}% (n=${btcDownEthTotal})`);

console.log('\nBTC → SOL Correlation:');
console.log(`  BTC UP   → SOL UP:   ${btcUpSolTotal > 0 ? (crossAsset.btcUpSolUp / btcUpSolTotal * 100).toFixed(1) : 'N/A'}% (n=${btcUpSolTotal})`);
console.log(`  BTC DOWN → SOL DOWN: ${btcDownSolTotal > 0 ? (crossAsset.btcDownSolDown / btcDownSolTotal * 100).toFixed(1) : 'N/A'}% (n=${btcDownSolTotal})`);

// The key strategies
console.log('\n=== 3. KEY STRATEGY WIN RATES ===\n');

// Strategy 1: ETH + BTC DOWN (our proposed golden strategy)
const ethBtcDownWR = btcDownEthTotal > 0 ? crossAsset.btcDownEthDown / btcDownEthTotal : 0;
console.log(`🎯 ETH + BTC DOWN: ${(ethBtcDownWR * 100).toFixed(1)}% WR (n=${btcDownEthTotal})`);

// Strategy 2: SOL + BTC DOWN
const solBtcDownWR = btcDownSolTotal > 0 ? crossAsset.btcDownSolDown / btcDownSolTotal : 0;
console.log(`🎯 SOL + BTC DOWN: ${(solBtcDownWR * 100).toFixed(1)}% WR (n=${btcDownSolTotal})`);

// Strategy 3: ETH + BTC UP
const ethBtcUpWR = btcUpEthTotal > 0 ? crossAsset.btcUpEthUp / btcUpEthTotal : 0;
console.log(`🎯 ETH + BTC UP: ${(ethBtcUpWR * 100).toFixed(1)}% WR (n=${btcUpEthTotal})`);

// Strategy 4: SOL + BTC UP
const solBtcUpWR = btcUpSolTotal > 0 ? crossAsset.btcUpSolUp / btcUpSolTotal : 0;
console.log(`🎯 SOL + BTC UP: ${(solBtcUpWR * 100).toFixed(1)}% WR (n=${btcUpSolTotal})`);

// Combined both directions
const allCrossAssetWR = (crossAsset.btcUpEthUp + crossAsset.btcDownEthDown + crossAsset.btcUpSolUp + crossAsset.btcDownSolDown) /
    (btcUpEthTotal + btcDownEthTotal + btcUpSolTotal + btcDownSolTotal);
console.log(`\n🎯 ALL CROSS-ASSET (follow BTC): ${(allCrossAssetWR * 100).toFixed(1)}% WR`);

console.log('\n=== 4. MEETS 90% REQUIREMENT? ===\n');

const strategies = [
    { name: 'ETH + BTC DOWN', wr: ethBtcDownWR, n: btcDownEthTotal },
    { name: 'SOL + BTC DOWN', wr: solBtcDownWR, n: btcDownSolTotal },
    { name: 'ETH + BTC UP', wr: ethBtcUpWR, n: btcUpEthTotal },
    { name: 'SOL + BTC UP', wr: solBtcUpWR, n: btcUpSolTotal },
];

strategies.forEach(s => {
    const status = s.wr >= 0.90 ? '✅' : s.wr >= 0.85 ? '⚠️' : '❌';
    console.log(`${status} ${s.name}: ${(s.wr * 100).toFixed(1)}% (n=${s.n}) ${s.wr >= 0.90 ? '- MEETS 90%' : ''}`);
});

console.log('\n=== 5. WORST-CASE VARIANCE ANALYSIS ===\n');

// Look for the worst consecutive losses in the data
function findWorstStreak(asset, btcDirection) {
    const trades = [];
    Object.values(byEpoch).forEach(cycle => {
        const btc = cycle.BTC?.outcome;
        const target = cycle[asset]?.outcome;
        if (btc === btcDirection && target) {
            const correct = btc === target;
            trades.push(correct);
        }
    });

    // Find max consecutive losses
    let maxLosses = 0;
    let currentLosses = 0;
    trades.forEach(won => {
        if (!won) {
            currentLosses++;
            maxLosses = Math.max(maxLosses, currentLosses);
        } else {
            currentLosses = 0;
        }
    });

    return { maxConsecLosses: maxLosses, totalTrades: trades.length };
}

const ethDownWorst = findWorstStreak('ETH', 'DOWN');
const solDownWorst = findWorstStreak('SOL', 'DOWN');

console.log(`ETH + BTC DOWN: Max consecutive losses = ${ethDownWorst.maxConsecLosses} (in ${ethDownWorst.totalTrades} trades)`);
console.log(`SOL + BTC DOWN: Max consecutive losses = ${solDownWorst.maxConsecLosses} (in ${solDownWorst.totalTrades} trades)`);

// Calculate survival probability with these streaks
console.log('\nWorst-case survival analysis:');
for (const sizing of [0.20, 0.30, 0.40, 0.50]) {
    const surviveAfterMax = Math.pow(1 - sizing, ethDownWorst.maxConsecLosses);
    console.log(`  ${(sizing * 100).toFixed(0)}% sizing: After ${ethDownWorst.maxConsecLosses} losses → ${(surviveAfterMax * 100).toFixed(1)}% of bankroll remains`);
}

console.log('\n=== 6. TIME-BASED BREAKDOWN ===\n');

// Check if WR varies by time of day
const byHourBtcDown = {};
Object.values(byEpoch).forEach(cycle => {
    const btc = cycle.BTC?.outcome;
    const eth = cycle.ETH?.outcome;
    if (btc === 'DOWN' && eth) {
        const hour = new Date(cycle.BTC.epoch * 1000).getUTCHours();
        if (!byHourBtcDown[hour]) byHourBtcDown[hour] = { correct: 0, total: 0 };
        byHourBtcDown[hour].total++;
        if (eth === 'DOWN') byHourBtcDown[hour].correct++;
    }
});

console.log('ETH + BTC DOWN win rate by hour (UTC):');
Object.keys(byHourBtcDown).sort((a, b) => Number(a) - Number(b)).forEach(hour => {
    const data = byHourBtcDown[hour];
    const wr = data.correct / data.total * 100;
    const highlight = wr >= 90 ? '★' : wr < 80 ? '⚠️' : '';
    console.log(`  Hour ${hour.padStart(2)}: ${wr.toFixed(0)}% (n=${data.total}) ${highlight}`);
});

console.log('\n=== 7. MANUAL TRADING FEASIBILITY ===\n');

console.log('For manual trading, you need to:');
console.log('1. DETECT BTC DOWN in first ~5 minutes of cycle');
console.log('2. PLACE trade on ETH before cycle ends');
console.log('3. WAIT for resolution\n');

console.log('Potential issues for manual trading:');
console.log('- BTC direction may not be clear until late in cycle');
console.log('- Website latency may eat into available time');
console.log('- False signals: BTC may reverse mid-cycle\n');

// How often does BTC change direction during a cycle?
// (We can't detect this from final outcomes, but we note the risk)
console.log('⚠️ RISK: We only have final outcomes, not intra-cycle data');
console.log('   BTC could show DOWN early then flip to UP before resolution');
console.log('   This is a potential failure mode for manual trading\n');

console.log('=== 8. FINAL VERDICT ===\n');

// Find the best strategy
const best = strategies.reduce((a, b) => a.wr > b.wr ? a : b);

if (best.wr >= 0.90) {
    console.log(`✅ GOLDEN STRATEGY FOUND: ${best.name}`);
    console.log(`   Win Rate: ${(best.wr * 100).toFixed(1)}%`);
    console.log(`   Sample Size: ${best.n}`);
    console.log(`   Meets 90% requirement: YES`);
} else if (best.wr >= 0.85) {
    console.log(`⚠️ BEST AVAILABLE: ${best.name}`);
    console.log(`   Win Rate: ${(best.wr * 100).toFixed(1)}%`);
    console.log(`   Sample Size: ${best.n}`);
    console.log(`   Meets 90% requirement: NO (close)`);
} else {
    console.log(`❌ NO STRATEGY MEETS 90% REQUIREMENT`);
    console.log(`   Best: ${best.name} at ${(best.wr * 100).toFixed(1)}%`);
}

console.log('\n⚠️ DATA SOURCE: Polymarket Gamma API (native data)');
console.log(`⚠️ DATE RANGE: ${daysCovered.toFixed(0)} days of data`);
console.log('=====================================\n');
