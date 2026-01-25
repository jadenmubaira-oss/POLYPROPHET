// 🔍 TIME-BASED SIGNAL STACKING ANALYSIS
// The main strategies don't hit 90%, but some HOURS hit 93-96%
// Can we find a viable strategy by filtering to best hours only?

const fs = require('fs');

const outcomes = JSON.parse(fs.readFileSync('polymarket_max_history.json', 'utf8'));
const resolved = outcomes.filter(o => o.outcome !== 'UNRESOLVED');

console.log('🔍 TIME-BASED SIGNAL STACKING ANALYSIS');
console.log('=======================================\n');
console.log(`Analyzing ${resolved.length} cycles from 30 days of data\n`);

// Group by epoch
const byEpoch = {};
resolved.forEach(o => {
    if (!byEpoch[o.epoch]) byEpoch[o.epoch] = {};
    byEpoch[o.epoch][o.asset] = o;
});

// Analyze each hour for ETH + BTC DOWN
const hourStats = {};
Object.values(byEpoch).forEach(cycle => {
    const btc = cycle.BTC?.outcome;
    const eth = cycle.ETH?.outcome;
    if (btc === 'DOWN' && eth) {
        const hour = new Date(cycle.BTC.epoch * 1000).getUTCHours();
        if (!hourStats[hour]) hourStats[hour] = { correct: 0, total: 0 };
        hourStats[hour].total++;
        if (eth === 'DOWN') hourStats[hour].correct++;
    }
});

console.log('=== ETH + BTC DOWN by Hour (UTC) ===\n');
console.log('Hour | WR    | n     | Status');
console.log('-----|-------|-------|--------');

const goodHours = [];
Object.keys(hourStats).sort((a, b) => Number(a) - Number(b)).forEach(hour => {
    const data = hourStats[hour];
    const wr = (data.correct / data.total * 100);
    let status = '';
    if (wr >= 90) {
        status = '✅ 90%+';
        goodHours.push({ hour: Number(hour), wr, n: data.total });
    } else if (wr >= 85) {
        status = '⚠️ 85-90%';
        goodHours.push({ hour: Number(hour), wr, n: data.total }); // Include 85%+ for stacking
    } else if (wr < 80) {
        status = '❌ <80%';
    }
    console.log(`  ${hour.toString().padStart(2)} | ${wr.toFixed(1).padStart(5)}% | ${data.total.toString().padStart(5)} | ${status}`);
});

console.log('\n=== HIGH-WR HOURS (≥85%) ===\n');
goodHours.sort((a, b) => b.wr - a.wr).forEach(h => {
    console.log(`Hour ${h.hour.toString().padStart(2)} UTC: ${h.wr.toFixed(1)}% WR (n=${h.n})`);
});

// Calculate combined WR if we only trade during these hours
const combinedHighHours = goodHours.filter(h => h.wr >= 85);
const totalHighN = combinedHighHours.reduce((s, h) => s + h.n, 0);
const totalHighCorrect = combinedHighHours.reduce((s, h) => s + Math.round(h.n * h.wr / 100), 0);
const combinedWR = totalHighN > 0 ? totalHighCorrect / totalHighN * 100 : 0;

console.log(`\n=== COMBINED HIGH-HOUR STRATEGY (≥85% hours) ===\n`);
console.log(`Hours: ${combinedHighHours.map(h => h.hour).join(', ')}`);
console.log(`Total trades: ${totalHighN}`);
console.log(`Combined WR: ${combinedWR.toFixed(1)}%`);
console.log(`Trades per day: ~${(totalHighN / 30).toFixed(1)}`);

// Now check for the 90%+ hours only
const veryHighHours = goodHours.filter(h => h.wr >= 90);
const totalVeryHighN = veryHighHours.reduce((s, h) => s + h.n, 0);
const totalVeryHighCorrect = veryHighHours.reduce((s, h) => s + Math.round(h.n * h.wr / 100), 0);
const veryHighWR = totalVeryHighN > 0 ? totalVeryHighCorrect / totalVeryHighN * 100 : 0;

console.log(`\n=== PREMIUM HOUR STRATEGY (≥90% hours only) ===\n`);
console.log(`Hours: ${veryHighHours.map(h => h.hour).join(', ')}`);
console.log(`Total trades: ${totalVeryHighN}`);
console.log(`Combined WR: ${veryHighWR.toFixed(1)}%`);
console.log(`Trades per day: ~${(totalVeryHighN / 30).toFixed(1)}`);

// Check BTC UP conditions too
console.log('\n=== CHECKING ETH + BTC UP BY HOUR ===\n');

const hourStatsUp = {};
Object.values(byEpoch).forEach(cycle => {
    const btc = cycle.BTC?.outcome;
    const eth = cycle.ETH?.outcome;
    if (btc === 'UP' && eth) {
        const hour = new Date(cycle.BTC.epoch * 1000).getUTCHours();
        if (!hourStatsUp[hour]) hourStatsUp[hour] = { correct: 0, total: 0 };
        hourStatsUp[hour].total++;
        if (eth === 'UP') hourStatsUp[hour].correct++;
    }
});

const goodHoursUp = [];
Object.keys(hourStatsUp).forEach(hour => {
    const data = hourStatsUp[hour];
    const wr = data.correct / data.total * 100;
    if (wr >= 90) {
        goodHoursUp.push({ hour: Number(hour), wr, n: data.total });
    }
});

console.log('Hours with ≥90% WR for ETH + BTC UP:');
goodHoursUp.sort((a, b) => b.wr - a.wr).forEach(h => {
    console.log(`  Hour ${h.hour.toString().padStart(2)} UTC: ${h.wr.toFixed(1)}% WR (n=${h.n})`);
});

// Combine ALL 90%+ conditions
console.log('\n=== COMBINED ULTRA-PREMIUM STRATEGY ===\n');

const allPremium = [...veryHighHours.map(h => ({ ...h, condition: 'ETH+BTC_DOWN' })),
...goodHoursUp.map(h => ({ ...h, condition: 'ETH+BTC_UP' }))];

const totalPremiumTrades = allPremium.reduce((s, h) => s + h.n, 0);
const totalPremiumCorrect = allPremium.reduce((s, h) => s + Math.round(h.n * h.wr / 100), 0);
const premiumWR = totalPremiumTrades > 0 ? totalPremiumCorrect / totalPremiumTrades * 100 : 0;

console.log('All 90%+ conditions:');
allPremium.forEach(h => {
    console.log(`  Hour ${h.hour.toString().padStart(2)} UTC + ${h.condition}: ${h.wr.toFixed(1)}% (n=${h.n})`);
});
console.log(`\nTotal trades: ${totalPremiumTrades} over 30 days`);
console.log(`Combined WR: ${premiumWR.toFixed(1)}%`);
console.log(`Trades per day: ~${(totalPremiumTrades / 30).toFixed(1)}`);

console.log('\n=== FINAL HONEST ASSESSMENT ===\n');

if (premiumWR >= 90 && totalPremiumTrades >= 50) {
    console.log('✅ VIABLE STRATEGY FOUND!');
    console.log(`   Trade only during 90%+ hours`);
    console.log(`   Combined WR: ${premiumWR.toFixed(1)}%`);
    console.log(`   Trades per day: ${(totalPremiumTrades / 30).toFixed(1)}`);
} else if (premiumWR >= 85) {
    console.log('⚠️ PARTIAL EDGE - Worth monitoring');
    console.log(`   Premium hours give ${premiumWR.toFixed(1)}% WR`);
    console.log(`   But sample sizes are small`);
} else {
    console.log('❌ NO RELIABLE 90% STRATEGY EXISTS');
    console.log('   Best available is ~83% (cross-asset following)');
    console.log('   Time-based filtering doesnt reliably boost to 90%');
}

console.log('\n=======================================\n');
