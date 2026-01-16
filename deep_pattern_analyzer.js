// 🧠 DEEP PATTERN ANALYZER
// Analyzes historical Polymarket outcomes for exploitable patterns
//
// Patterns to check:
// 1. Streak analysis (after 3 UPs, is DOWN more likely?)
// 2. Cross-asset correlation (does BTC predict ETH/SOL?)
// 3. Volume correlation (high volume = more predictable?)
// 4. Time-of-day patterns (certain hours more predictable?)
// 5. Mean reversion (extreme odds tend to revert?)

const fs = require('fs');

// Load the historical outcomes we fetched
let outcomes = [];
try {
    outcomes = JSON.parse(fs.readFileSync('polymarket_outcomes.json', 'utf8'));
} catch {
    console.error('Run fetch_polymarket_history.js first to generate polymarket_outcomes.json');
    process.exit(1);
}

console.log('🧠 DEEP PATTERN ANALYZER');
console.log(`Loaded ${outcomes.length} historical cycle outcomes`);
console.log('-------------------------------------------\n');

// Group by asset
const byAsset = {};
outcomes.forEach(o => {
    if (!byAsset[o.asset]) byAsset[o.asset] = [];
    byAsset[o.asset].push(o);
});

// Sort each asset by epoch (oldest first)
Object.keys(byAsset).forEach(asset => {
    byAsset[asset].sort((a, b) => a.epoch - b.epoch);
});

console.log('=== 1. STREAK ANALYSIS ===\n');
console.log('Does the previous outcome predict the next?');
console.log('If markets are random, should be ~50% regardless of previous.\n');

Object.keys(byAsset).forEach(asset => {
    const data = byAsset[asset].filter(o => o.outcome !== 'UNRESOLVED');

    let afterUp = { up: 0, down: 0 };
    let afterDown = { up: 0, down: 0 };
    let after2Up = { up: 0, down: 0 };
    let after2Down = { up: 0, down: 0 };
    let after3Up = { up: 0, down: 0 };
    let after3Down = { up: 0, down: 0 };

    for (let i = 1; i < data.length; i++) {
        const prev = data[i - 1].outcome;
        const curr = data[i].outcome;

        if (prev === 'UP') {
            if (curr === 'UP') afterUp.up++; else afterUp.down++;
        } else {
            if (curr === 'UP') afterDown.up++; else afterDown.down++;
        }

        // After 2 same outcomes
        if (i >= 2) {
            const prev2 = data[i - 2].outcome;
            if (prev === 'UP' && prev2 === 'UP') {
                if (curr === 'UP') after2Up.up++; else after2Up.down++;
            }
            if (prev === 'DOWN' && prev2 === 'DOWN') {
                if (curr === 'UP') after2Down.up++; else after2Down.down++;
            }
        }

        // After 3 same outcomes
        if (i >= 3) {
            const prev2 = data[i - 2].outcome;
            const prev3 = data[i - 3].outcome;
            if (prev === 'UP' && prev2 === 'UP' && prev3 === 'UP') {
                if (curr === 'UP') after3Up.up++; else after3Up.down++;
            }
            if (prev === 'DOWN' && prev2 === 'DOWN' && prev3 === 'DOWN') {
                if (curr === 'UP') after3Down.up++; else after3Down.down++;
            }
        }
    }

    const afterUpTotal = afterUp.up + afterUp.down;
    const afterDownTotal = afterDown.up + afterDown.down;
    const after2UpTotal = after2Up.up + after2Up.down;
    const after2DownTotal = after2Down.up + after2Down.down;
    const after3UpTotal = after3Up.up + after3Up.down;
    const after3DownTotal = after3Down.up + after3Down.down;

    console.log(`${asset}:`);
    console.log(`  After 1 UP  → UP: ${afterUpTotal > 0 ? (afterUp.up / afterUpTotal * 100).toFixed(1) : 'N/A'}% (n=${afterUpTotal})`);
    console.log(`  After 1 DOWN → UP: ${afterDownTotal > 0 ? (afterDown.up / afterDownTotal * 100).toFixed(1) : 'N/A'}% (n=${afterDownTotal})`);
    console.log(`  After 2 UPs  → UP: ${after2UpTotal > 0 ? (after2Up.up / after2UpTotal * 100).toFixed(1) : 'N/A'}% (n=${after2UpTotal})`);
    console.log(`  After 2 DOWNs → UP: ${after2DownTotal > 0 ? (after2Down.up / after2DownTotal * 100).toFixed(1) : 'N/A'}% (n=${after2DownTotal})`);
    console.log(`  After 3 UPs  → UP: ${after3UpTotal > 0 ? (after3Up.up / after3UpTotal * 100).toFixed(1) : 'N/A'}% (n=${after3UpTotal})`);
    console.log(`  After 3 DOWNs → UP: ${after3DownTotal > 0 ? (after3Down.up / after3DownTotal * 100).toFixed(1) : 'N/A'}% (n=${after3DownTotal})`);
    console.log();
});

console.log('=== 2. CROSS-ASSET CORRELATION ===\n');
console.log('When BTC goes UP in a cycle, what % of time does ETH/SOL also go UP?');
console.log('High correlation = potential leading indicator edge.\n');

// Group outcomes by epoch
const byEpoch = {};
outcomes.forEach(o => {
    if (!byEpoch[o.epoch]) byEpoch[o.epoch] = {};
    byEpoch[o.epoch][o.asset] = o.outcome;
});

let btcUpEthUp = 0, btcUpEthDown = 0;
let btcDownEthUp = 0, btcDownEthDown = 0;
let btcUpSolUp = 0, btcUpSolDown = 0;
let btcDownSolUp = 0, btcDownSolDown = 0;
let ethUpSolUp = 0, ethUpSolDown = 0;
let ethDownSolUp = 0, ethDownSolDown = 0;

Object.values(byEpoch).forEach(cycle => {
    const btc = cycle.BTC;
    const eth = cycle.ETH;
    const sol = cycle.SOL;

    if (btc && eth && btc !== 'UNRESOLVED' && eth !== 'UNRESOLVED') {
        if (btc === 'UP' && eth === 'UP') btcUpEthUp++;
        if (btc === 'UP' && eth === 'DOWN') btcUpEthDown++;
        if (btc === 'DOWN' && eth === 'UP') btcDownEthUp++;
        if (btc === 'DOWN' && eth === 'DOWN') btcDownEthDown++;
    }

    if (btc && sol && btc !== 'UNRESOLVED' && sol !== 'UNRESOLVED') {
        if (btc === 'UP' && sol === 'UP') btcUpSolUp++;
        if (btc === 'UP' && sol === 'DOWN') btcUpSolDown++;
        if (btc === 'DOWN' && sol === 'UP') btcDownSolUp++;
        if (btc === 'DOWN' && sol === 'DOWN') btcDownSolDown++;
    }

    if (eth && sol && eth !== 'UNRESOLVED' && sol !== 'UNRESOLVED') {
        if (eth === 'UP' && sol === 'UP') ethUpSolUp++;
        if (eth === 'UP' && sol === 'DOWN') ethUpSolDown++;
        if (eth === 'DOWN' && sol === 'UP') ethDownSolUp++;
        if (eth === 'DOWN' && sol === 'DOWN') ethDownSolDown++;
    }
});

const btcUpTotal = btcUpEthUp + btcUpEthDown;
const btcDownTotal = btcDownEthUp + btcDownEthDown;
const btcUpSolTotal = btcUpSolUp + btcUpSolDown;
const btcDownSolTotal = btcDownSolUp + btcDownSolDown;
const ethUpSolTotal = ethUpSolUp + ethUpSolDown;
const ethDownSolTotal = ethDownSolUp + ethDownSolDown;

console.log('BTC vs ETH:');
console.log(`  When BTC=UP  → ETH=UP: ${btcUpTotal > 0 ? (btcUpEthUp / btcUpTotal * 100).toFixed(1) : 'N/A'}% (n=${btcUpTotal})`);
console.log(`  When BTC=DOWN → ETH=UP: ${btcDownTotal > 0 ? (btcDownEthUp / btcDownTotal * 100).toFixed(1) : 'N/A'}% (n=${btcDownTotal})\n`);

console.log('BTC vs SOL:');
console.log(`  When BTC=UP  → SOL=UP: ${btcUpSolTotal > 0 ? (btcUpSolUp / btcUpSolTotal * 100).toFixed(1) : 'N/A'}% (n=${btcUpSolTotal})`);
console.log(`  When BTC=DOWN → SOL=UP: ${btcDownSolTotal > 0 ? (btcDownSolUp / btcDownSolTotal * 100).toFixed(1) : 'N/A'}% (n=${btcDownSolTotal})\n`);

console.log('ETH vs SOL:');
console.log(`  When ETH=UP  → SOL=UP: ${ethUpSolTotal > 0 ? (ethUpSolUp / ethUpSolTotal * 100).toFixed(1) : 'N/A'}% (n=${ethUpSolTotal})`);
console.log(`  When ETH=DOWN → SOL=UP: ${ethDownSolTotal > 0 ? (ethDownSolUp / ethDownSolTotal * 100).toFixed(1) : 'N/A'}% (n=${ethDownSolTotal})\n`);

console.log('=== 3. VOLUME ANALYSIS ===\n');
console.log('Do high-volume cycles have different UP/DOWN distributions?');
console.log('Higher volume = more informed traders = potential signal?\n');

Object.keys(byAsset).forEach(asset => {
    const data = byAsset[asset].filter(o => o.outcome !== 'UNRESOLVED' && o.volume > 0);
    if (data.length === 0) return;

    // Sort by volume
    const sorted = [...data].sort((a, b) => a.volume - b.volume);
    const medianVol = sorted[Math.floor(sorted.length / 2)].volume;

    const highVol = data.filter(o => o.volume >= medianVol);
    const lowVol = data.filter(o => o.volume < medianVol);

    const highVolUp = highVol.filter(o => o.outcome === 'UP').length;
    const lowVolUp = lowVol.filter(o => o.outcome === 'UP').length;

    console.log(`${asset} (median vol: $${(medianVol / 1000).toFixed(0)}K):`);
    console.log(`  High volume cycles → UP: ${highVol.length > 0 ? (highVolUp / highVol.length * 100).toFixed(1) : 'N/A'}% (n=${highVol.length})`);
    console.log(`  Low volume cycles  → UP: ${lowVol.length > 0 ? (lowVolUp / lowVol.length * 100).toFixed(1) : 'N/A'}% (n=${lowVol.length})`);
    console.log();
});

console.log('=== 4. TIME-OF-DAY ANALYSIS ===\n');
console.log('Are certain hours more predictable?');
console.log('Note: Needs more data for statistical significance.\n');

const byHour = {};
outcomes.filter(o => o.outcome !== 'UNRESOLVED').forEach(o => {
    const hour = new Date(o.epoch * 1000).getUTCHours();
    if (!byHour[hour]) byHour[hour] = { up: 0, down: 0 };
    if (o.outcome === 'UP') byHour[hour].up++;
    else byHour[hour].down++;
});

Object.keys(byHour).sort((a, b) => Number(a) - Number(b)).forEach(hour => {
    const total = byHour[hour].up + byHour[hour].down;
    const upRate = (byHour[hour].up / total * 100).toFixed(1);
    console.log(`Hour ${hour.padStart(2, '0')} UTC: UP=${upRate}% (n=${total})`);
});

console.log('\n=== SUMMARY ===\n');
console.log('Key findings for exploitable edges:');
console.log('1. Streak patterns: Check for mean reversion after consecutive same outcomes');
console.log('2. Cross-correlation: High correlation suggests BTC may lead others');
console.log('3. Volume: May indicate informed trading');
console.log('4. Time: Specific hours may have patterns (needs more data)');
console.log('\n⚠️ IMPORTANT: Statistical significance requires hundreds-thousands of samples.');
console.log('Current data is suggestive but not conclusive.\n');
