#!/usr/bin/env node
// PROPER runtime-parity: enforces MAX_GLOBAL_TRADES_PER_CYCLE=1
// Groups signals by 15m cycle, picks at most 1 per cycle
const fs = require('fs');

const v5 = JSON.parse(fs.readFileSync('strategies/strategy_set_15m_optimal_10usd_v5.json', 'utf8'));
const data = JSON.parse(fs.readFileSync('data/intracycle-price-data.json', 'utf8'));
const cycles = Array.isArray(data) ? data : (data.cycles || []);
const apr8 = Math.floor(new Date('2026-04-08T00:00:00Z').getTime() / 1000);
const oos = cycles.filter(c => (c.epoch || 0) >= apr8);

// Build signals PER cycle (epoch is 15m cycle start)
const cycleSignals = new Map();
for (const c of oos) {
    const h = new Date(c.epoch * 1000).getUTCHours();
    for (const s of v5.strategies) {
        if (s.utcHour !== h) continue;
        const entryPrice = s.direction === 'UP' ? c.minutePricesYes?.[s.entryMinute]?.last : c.minutePricesNo?.[s.entryMinute]?.last;
        if (!Number.isFinite(entryPrice) || entryPrice < s.priceMin || entryPrice > s.priceMax) continue;
        if (!c.resolution) continue;
        const key = `${c.epoch}_${s.entryMinute}`; // group by cycle+minute (these fire together)
        const sig = {
            epoch: c.epoch,
            minute: s.entryMinute,
            timestamp: c.epoch + s.entryMinute * 60,
            asset: c.asset,
            strategy: s.name,
            tier: s.tier || 'A',
            direction: s.direction,
            entryPrice,
            pWin: s.pWinEstimate || s.winRate || 0.9,
            won: s.direction === c.resolution
        };
        if (!cycleSignals.has(key)) cycleSignals.set(key, []);
        cycleSignals.get(key).push(sig);
    }
}

// Sort by timestamp, then within each key pick best (highest pWin) - runtime picks deterministic best match
const firingEvents = [];
for (const [key, sigs] of cycleSignals) {
    sigs.sort((a, b) => (b.pWin - a.pWin));
    // Runtime fires the FIRST match; with 4 assets, if multiple match at same minute, picks first (alphabetic asset)
    firingEvents.push({ key, timestamp: sigs[0].timestamp, signals: sigs });
}
firingEvents.sort((a, b) => a.timestamp - b.timestamp);

console.log('Total firing events (cycle+minute slots):', firingEvents.length);
console.log('Avg signals per firing:', (firingEvents.reduce((a, e) => a + e.signals.length, 0) / firingEvents.length).toFixed(2));
console.log('With MAX_GLOBAL_TRADES_PER_CYCLE=1, only 1 trade per event = total trades:', firingEvents.length);

// Days
const days = [...new Set(firingEvents.map(e => new Date(e.timestamp * 1000).toISOString().slice(0, 10)))].sort();
const tradesPerDay = firingEvents.length / days.length;
console.log('Days:', days.length, '| Trades per day:', tradesPerDay.toFixed(1));

// Simulate: for each event pick a random asset/signal (runtime does this too based on first-matched market)
function simulate(startBank, horizonHours, stakeFrac = 0.15, minShares = 5, maxConsecLoss = 999, cooldownSec = 0, runs = 10000) {
    const tradesPerRun = Math.round(tradesPerDay * horizonHours / 24);
    const finals = [];
    let busts = 0;
    const maxDDs = [];
    for (let r = 0; r < runs; r++) {
        let bank = startBank;
        let peak = startBank;
        let maxDD = 0;
        let consecLoss = 0;
        let cooldownUntilTs = 0;
        let busted = false;
        const startIdx = Math.floor(Math.random() * Math.max(1, firingEvents.length - tradesPerRun));
        for (let i = 0; i < tradesPerRun; i++) {
            const evt = firingEvents[(startIdx + i) % firingEvents.length];
            if (evt.timestamp < cooldownUntilTs) continue;
            // Pick ONE signal from the event (runtime uses first-matched market)
            const sig = evt.signals[Math.floor(Math.random() * evt.signals.length)];
            const idealStake = bank * stakeFrac;
            const minOrderUsd = minShares * sig.entryPrice;
            const actualStake = Math.max(idealStake, minOrderUsd);
            if (actualStake > bank || bank < minShares * 0.5) {
                busted = true;
                break;
            }
            const shares = actualStake / sig.entryPrice;
            const fee = actualStake * 0.0315;
            if (sig.won) {
                bank += (shares - actualStake) - fee;
                consecLoss = 0;
            } else {
                bank -= actualStake + fee;
                consecLoss++;
                if (consecLoss >= maxConsecLoss) cooldownUntilTs = evt.timestamp + cooldownSec;
            }
            if (bank > peak) peak = bank;
            const dd = (peak - bank) / peak;
            if (dd > maxDD) maxDD = dd;
        }
        finals.push(bank);
        maxDDs.push(maxDD);
        if (busted) busts++;
    }
    finals.sort((a, b) => a - b);
    maxDDs.sort((a, b) => a - b);
    const pct = p => finals[Math.floor(p * finals.length)] || 0;
    const ddPct = p => maxDDs[Math.floor(p * maxDDs.length)] || 0;
    return {
        bust: busts / runs * 100,
        p5: pct(0.05), p10: pct(0.10), p25: pct(0.25), median: pct(0.5), p75: pct(0.75), p90: pct(0.9), p95: pct(0.95),
        medianDD: ddPct(0.5) * 100,
        p90DD: ddPct(0.9) * 100
    };
}

// Chronological replay
console.log('\n=== CHRONOLOGICAL OOS REPLAY ($10 start, 1 trade per cycle enforced) ===');
let bank = 10, trades = 0, wins = 0, losses = 0, peak = 10, maxDD = 0, maxConsecLoss = 0, curConsecLoss = 0;
for (const evt of firingEvents) {
    const sig = evt.signals[0]; // deterministic: pick first
    const idealStake = bank * 0.15;
    const minOrderUsd = 5 * sig.entryPrice;
    const actualStake = Math.max(idealStake, minOrderUsd);
    if (actualStake > bank) {
        console.log(`  BUST at trade ${trades + 1}: bank $${bank.toFixed(2)} cannot afford $${actualStake.toFixed(2)}`);
        break;
    }
    const shares = actualStake / sig.entryPrice;
    const fee = actualStake * 0.0315;
    if (sig.won) {
        bank += (shares - actualStake) - fee;
        wins++;
        curConsecLoss = 0;
    } else {
        bank -= actualStake + fee;
        losses++;
        curConsecLoss++;
        if (curConsecLoss > maxConsecLoss) maxConsecLoss = curConsecLoss;
    }
    trades++;
    if (bank > peak) peak = bank;
    const dd = (peak - bank) / peak;
    if (dd > maxDD) maxDD = dd;
}
console.log(`  Trades=${trades} Wins=${wins} Losses=${losses} WR=${(wins/trades*100).toFixed(1)}%`);
console.log(`  Final=$${bank.toFixed(2)} Peak=$${peak.toFixed(2)} MaxDD=${(maxDD*100).toFixed(1)}% MaxConsecLoss=${maxConsecLoss}`);

// Sweep
console.log('\n=== PROPER RUNTIME BANKROLL SWEEP (24h, MAX_GLOBAL_TRADES_PER_CYCLE=1) ===');
console.log('Start | Bust  | p10    | p25    | MEDIAN  | p75     | p90     | p95    | medDD% | p90DD%');
console.log('------+-------+--------+--------+---------+---------+---------+--------+--------+-------');
for (const start of [5, 7, 10, 12, 15, 20, 25]) {
    const r = simulate(start, 24);
    console.log(`$${String(start).padStart(3)}  | ${r.bust.toFixed(1).padStart(4)}% | $${r.p10.toFixed(2).padStart(6)} | $${r.p25.toFixed(2).padStart(6)} | $${r.median.toFixed(2).padStart(7)} | $${r.p75.toFixed(2).padStart(7)} | $${r.p90.toFixed(2).padStart(7)} | $${r.p95.toFixed(2).padStart(6)} | ${r.medianDD.toFixed(0).padStart(5)}% | ${r.p90DD.toFixed(0).padStart(5)}%`);
}

console.log('\n=== PROPER RUNTIME BANKROLL SWEEP (7d) ===');
console.log('Start | Bust  | p10    | p25    | MEDIAN   | p75       | p90       | p95');
console.log('------+-------+--------+--------+----------+-----------+-----------+-----------');
for (const start of [5, 7, 10, 12, 15, 20, 25]) {
    const r = simulate(start, 24 * 7);
    console.log(`$${String(start).padStart(3)}  | ${r.bust.toFixed(1).padStart(4)}% | $${r.p10.toFixed(2).padStart(6)} | $${r.p25.toFixed(2).padStart(6)} | $${r.median.toFixed(2).padStart(8)} | $${r.p75.toFixed(2).padStart(9)} | $${r.p90.toFixed(2).padStart(9)} | $${r.p95.toFixed(2).padStart(9)}`);
}

console.log('\n=== $10 WITH SUGGESTED COOLDOWN (3 losses, 1h pause) ===');
for (const h of [24, 48, 72, 168]) {
    const r = simulate(10, h, 0.15, 5, 3, 60 * 60);
    console.log(`  ${String(h).padStart(3)}h: bust=${r.bust.toFixed(1)}% p25=$${r.p25.toFixed(2)} MEDIAN=$${r.median.toFixed(2)} p75=$${r.p75.toFixed(2)} p95=$${r.p95.toFixed(2)}`);
}

console.log('\n=== $10 NO COOLDOWN ===');
for (const h of [24, 48, 72, 168]) {
    const r = simulate(10, h);
    console.log(`  ${String(h).padStart(3)}h: bust=${r.bust.toFixed(1)}% p25=$${r.p25.toFixed(2)} MEDIAN=$${r.median.toFixed(2)} p75=$${r.p75.toFixed(2)} p95=$${r.p95.toFixed(2)}`);
}

// Max consec loss in proper 1-per-cycle data
let mcl = 0, cur = 0, streakDetails = [];
let curStreak = [];
for (const evt of firingEvents) {
    const sig = evt.signals[0];
    if (sig.won) { cur = 0; curStreak = []; }
    else {
        cur++;
        curStreak.push({ ts: new Date(sig.timestamp * 1000).toISOString(), asset: sig.asset, strategy: sig.strategy, price: sig.entryPrice });
        if (cur > mcl) { mcl = cur; streakDetails = [...curStreak]; }
    }
}
console.log(`\n=== WORST CONSECUTIVE LOSS STREAK (1-per-cycle): ${mcl} ===`);
for (const s of streakDetails) console.log(`  ${s.ts} | ${s.asset} ${s.strategy} entry=${s.price.toFixed(3)}`);
