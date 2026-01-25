// 🏆 GOLDEN STRATEGY BACKTEST - Extended 30-day data verification
const fs = require('fs');
const data = JSON.parse(fs.readFileSync('polymarket_max_history.json'));

// GOLDEN HOURS CONFIG (UTC)
const GOLDEN_HOURS = {
    2: 'DOWN',   // 92.9% WR
    3: 'UP',     // 93.1% WR
    4: 'UP',     // 91.5% WR
    8: 'UP',     // 91.7% WR
    14: 'DOWN'   // 96.1% WR
};

console.log('=== GOLDEN STRATEGY BACKTEST on 30-day data ===');
console.log('Data points:', data.length);

// Group cycles by epoch
const cycles = {};
data.forEach(r => {
    const key = r.epoch;
    if (!key) return;
    if (!cycles.hasOwnProperty(key)) {
        cycles[key] = {};
    }
    cycles[key][r.asset] = r;
});

console.log('Unique cycles:', Object.keys(cycles).length);

let stats = { total: 0, wins: 0, hourly: {} };
Object.keys(GOLDEN_HOURS).forEach(h => {
    stats.hourly[h] = { total: 0, wins: 0, condition: GOLDEN_HOURS[h] };
});

// Track worst losing streaks
let currentStreak = 0;
let maxLossStreak = 0;

Object.entries(cycles).forEach(([epoch, assets]) => {
    const date = new Date(Number(epoch) * 1000);
    const hour = date.getUTCHours();

    if (!GOLDEN_HOURS[hour]) return;

    const btc = assets.BTC;
    const eth = assets.ETH;
    if (!btc || !eth) return;

    const expectedBTC = GOLDEN_HOURS[hour];
    const btcOutcome = btc.outcome;
    if (btcOutcome !== expectedBTC) return;

    const isWin = eth.outcome === btcOutcome;
    stats.total++;

    if (isWin) {
        stats.wins++;
        currentStreak = 0; // Reset loss streak
    } else {
        currentStreak++;
        if (currentStreak > maxLossStreak) maxLossStreak = currentStreak;
    }

    stats.hourly[hour].total++;
    if (isWin) stats.hourly[hour].wins++;
});

console.log('\n=== OVERALL RESULTS ===');
console.log('Total trades:', stats.total);
console.log('Wins:', stats.wins);
console.log('Losses:', stats.total - stats.wins);
console.log('Win Rate:', (stats.wins / stats.total * 100).toFixed(2) + '%');
console.log('Max consecutive losses:', maxLossStreak);

console.log('\n=== BY HOUR ===');
Object.entries(stats.hourly).forEach(([hour, h]) => {
    const wr = h.total > 0 ? (h.wins / h.total * 100).toFixed(1) : 0;
    console.log(`Hour ${hour.padStart(2, '0')} UTC (${h.condition}): ${h.wins}/${h.total} = ${wr}% WR`);
});

// Calculate trades per day
const epochs = Object.keys(cycles).map(Number).sort((a, b) => a - b);
const daysCovered = (epochs[epochs.length - 1] - epochs[0]) / 86400;
console.log('\n=== STATISTICS ===');
console.log('Days covered:', daysCovered.toFixed(1));
console.log('Trades per day:', (stats.total / daysCovered).toFixed(1));

// Monte Carlo simulation at 25% sizing
console.log('\n=== $1 to $1M PROJECTION (25% sizing) ===');
const winRate = stats.wins / stats.total;
const tradesPerDay = stats.total / daysCovered;

let balance = 1.0;
let trades = 0;
const sizingFraction = 0.25;

while (balance < 1000000 && trades < 10000) {
    const expectedReturn = (winRate * (1 / 0.45 - 1)) + ((1 - winRate) * -1); // Avg entry at 45¢
    balance = balance * (1 + sizingFraction * expectedReturn);
    trades++;
}

console.log('Starting balance: $1.00');
console.log('Trades to $1M:', trades);
console.log('Days to $1M:', (trades / tradesPerDay).toFixed(1));
console.log('Win rate used:', (winRate * 100).toFixed(1) + '%');
