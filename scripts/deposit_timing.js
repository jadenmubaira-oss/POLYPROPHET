#!/usr/bin/env node
// DEPOSIT TIMING: find the next Tier-S and Tier-A signal windows from v5, computed from NOW UTC.
const fs = require('fs');

const v5 = JSON.parse(fs.readFileSync('strategies/strategy_set_15m_optimal_10usd_v5.json', 'utf8'));
const now = new Date();
const nowUtcMin = now.getUTCHours() * 60 + now.getUTCMinutes();

console.log(`Current UTC time: ${now.toISOString().slice(0, 19)}`);
console.log(`Now in UTC minutes-of-day: ${nowUtcMin}\n`);

const rows = v5.strategies.map(s => {
    const wr = Math.round(Number(s.winRate || s.pWinEstimate || 0) * 1000) / 10;
    const lcb = Math.round(Number(s.winRateLCB || 0) * 1000) / 10;
    const oos = Math.round(Number(s.stats?.oos?.wr || 0) * 1000) / 10;
    const n = Number(s.stats?.oos?.trades || 0);
    const hr = Number(s.utcHour);
    const min = Number(s.entryMinute);
    const minsFromNow = (hr * 60 + min) - nowUtcMin;
    const minsAway = minsFromNow > 0 ? minsFromNow : minsFromNow + 24 * 60;
    return {
        name: s.name, tier: s.tier || 'A', hr, min, minsAway,
        dir: String(s.direction || '').toUpperCase(),
        priceMin: s.priceMin, priceMax: s.priceMax,
        wr, lcb, oos, n,
        label: `H${String(hr).padStart(2, '0')} m${min} ${s.direction} [${Math.round(s.priceMin * 100)}-${Math.round(s.priceMax * 100)}c]`
    };
});

rows.sort((a, b) => a.minsAway - b.minsAway);

console.log('--- NEXT 12 HOURS OF SIGNALS ---');
console.log('UTC  | Tier | Signal                           | WR (OOS)  | Away');
console.log('-----+------+----------------------------------+-----------+------');
for (const r of rows.filter(x => x.minsAway <= 720)) {
    const tStr = `${String(r.hr).padStart(2, '0')}:${String(r.min).padStart(2, '0')}`;
    const marker = r.tier === 'S' ? ' ⭐' : '';
    console.log(`${tStr}| ${r.tier.padStart(3)}  | ${r.label.padEnd(32)} | ${String(r.wr).padStart(4)}% (${r.oos}% / ${String(r.n).padStart(2)}t) | ${String(r.minsAway).padStart(3)}m${marker}`);
}

// Find next Tier-S
const nextS = rows.find(r => r.tier === 'S' && r.minsAway > 20);
const next2S = rows.filter(r => r.tier === 'S' && r.minsAway > 20).slice(0, 3);

console.log('\n--- NEXT 3 TIER-S WINDOWS ---');
for (const r of next2S) {
    const tStr = `${String(r.hr).padStart(2, '0')}:${String(r.min).padStart(2, '0')}`;
    console.log(`  ${tStr} UTC ${r.label} - ${r.minsAway}min away - OOS ${r.oos}% on ${r.n}t`);
}

// Find next double-header (Tier-S or Tier-A within 1 hour of each other)
console.log('\n--- BEST DEPOSIT WINDOW RECOMMENDATION ---');
if (nextS) {
    const depositByMin = nextS.minsAway - 25;
    const depositTime = new Date(now.getTime() + depositByMin * 60000);
    console.log(`Next Tier-S: ${String(nextS.hr).padStart(2, '0')}:${String(nextS.min).padStart(2, '0')} UTC (${nextS.minsAway}min from now)`);
    console.log(`  Signal: ${nextS.label}`);
    console.log(`  OOS WR: ${nextS.oos}% on ${nextS.n} trades`);
    console.log(`  DEPOSIT BY: ${depositTime.toISOString().slice(11, 19)} UTC`);
    console.log(`  This gives the runtime ~25 minutes to:`);
    console.log(`    1. Detect on-chain USDC via refreshLiveBalance`);
    console.log(`    2. Rebase baseline bankroll`);
    console.log(`    3. Enable 15m timeframe (requires bankroll >= $2)`);
    console.log(`    4. Match the Tier-S signal at ${String(nextS.hr).padStart(2, '0')}:${String(nextS.min).padStart(2, '0')} UTC`);
}

// Find nearest hour with 2+ signals (safest entry: multiple opportunities)
const nextHourSignals = rows.filter(r => r.minsAway <= 180).slice(0, 10);
console.log(`\n--- ALL SIGNALS IN NEXT 3 HOURS (${nextHourSignals.length} opportunities) ---`);
for (const r of nextHourSignals) {
    console.log(`  ${String(r.hr).padStart(2, '0')}:${String(r.min).padStart(2, '0')} UTC | tier ${r.tier} | ${r.label} | ${r.oos}% OOS / ${r.lcb}% LCB / ${r.n}t | ${r.minsAway}min`);
}
