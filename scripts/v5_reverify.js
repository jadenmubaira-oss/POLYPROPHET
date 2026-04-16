#!/usr/bin/env node
// FULL v5 RE-VERIFICATION: day-by-day OOS replay + runtime-parity bust sim
const fs = require('fs');

const v5 = JSON.parse(fs.readFileSync('strategies/strategy_set_15m_optimal_10usd_v5.json', 'utf8'));
const data = JSON.parse(fs.readFileSync('data/intracycle-price-data.json', 'utf8'));
const cycles = Array.isArray(data) ? data : (data.cycles || []);
const apr8 = Math.floor(new Date('2026-04-08T00:00:00Z').getTime() / 1000);
const oos = cycles.filter(c => (c.epoch || 0) >= apr8);

console.log('=== V5 FORENSIC RE-VERIFICATION ===');
console.log('OOS cycles (Apr 8-16):', oos.length);
console.log('Strategies:', v5.strategies.length);

// Match signals to strategies chronologically
const signals = [];
for (const c of oos) {
    const epoch = c.epoch;
    const h = new Date(epoch * 1000).getUTCHours();
    for (const s of v5.strategies) {
        if (s.utcHour !== h) continue;
        const mk = s.entryMinute;
        const yesAt = c.minutePricesYes?.[mk]?.last;
        const noAt = c.minutePricesNo?.[mk]?.last;
        const dir = s.direction;
        const entryPrice = dir === 'UP' ? yesAt : noAt;
        if (!Number.isFinite(entryPrice) || entryPrice <= 0 || entryPrice >= 1) continue;
        if (entryPrice < s.priceMin || entryPrice > s.priceMax) continue;
        const resolution = c.resolution;
        if (!resolution) continue;
        const won = dir === resolution;
        signals.push({
            epoch,
            day: new Date(epoch * 1000).toISOString().slice(0, 10),
            asset: c.asset,
            strategy: s.name,
            tier: s.tier,
            direction: dir,
            entryPrice,
            resolution,
            won
        });
    }
}

// Day-level WR analysis
signals.sort((a, b) => a.epoch - b.epoch);
console.log('\n=== DAILY OOS PERFORMANCE ===');
const byDay = {};
for (const s of signals) {
    if (!byDay[s.day]) byDay[s.day] = { total: 0, wins: 0, losses: [] };
    byDay[s.day].total++;
    if (s.won) byDay[s.day].wins++;
}
const days = Object.keys(byDay).sort();
let worstDayWR = 1, worstDay = '';
for (const d of days) {
    const { total, wins } = byDay[d];
    const wr = wins / total;
    if (wr < worstDayWR) { worstDayWR = wr; worstDay = d; }
    console.log(`  ${d} | ${String(total).padStart(3)} trades | ${String(wins).padStart(3)} wins | ${(wr * 100).toFixed(1)}% WR`);
}
console.log(`\nWorst day: ${worstDay} at ${(worstDayWR * 100).toFixed(1)}% WR`);
console.log(`Best day WR: ${(Math.max(...days.map(d => byDay[d].wins / byDay[d].total)) * 100).toFixed(1)}%`);
console.log(`Avg trades/day: ${(signals.length / days.length).toFixed(1)}`);

// Max consecutive losses
let maxConsecLoss = 0, curConsecLoss = 0, maxConsecLossStreak = [];
let curStreak = [];
for (const s of signals) {
    if (!s.won) {
        curConsecLoss++;
        curStreak.push(s);
        if (curConsecLoss > maxConsecLoss) {
            maxConsecLoss = curConsecLoss;
            maxConsecLossStreak = [...curStreak];
        }
    } else {
        curConsecLoss = 0;
        curStreak = [];
    }
}
console.log(`\n=== MAX CONSECUTIVE LOSS STREAK: ${maxConsecLoss} ===`);
if (maxConsecLossStreak.length) {
    for (const l of maxConsecLossStreak) {
        console.log(`  ${new Date(l.epoch * 1000).toISOString()} | ${l.asset} | ${l.strategy} | entry=${l.entryPrice.toFixed(3)}`);
    }
}

// First-trade bust simulation
console.log('\n=== FIRST-TRADE BUST RISK (exact runtime mechanics) ===');
function simulateBust(startBank, stakeFrac = 0.15, minShares = 5, feeRate = 0.0315) {
    const runs = 10000;
    const results = { bust1: 0, bust2: 0, bust3: 0, bust5: 0, bust10: 0 };
    for (let r = 0; r < runs; r++) {
        let bank = startBank;
        const shuffled = [...signals].sort(() => Math.random() - 0.5);
        for (let i = 0; i < Math.min(10, shuffled.length); i++) {
            const s = shuffled[i];
            const idealStake = bank * stakeFrac;
            const minOrderUsd = minShares * s.entryPrice;
            const actualStake = Math.max(idealStake, minOrderUsd);
            if (actualStake > bank) {
                if (i === 0) results.bust1++;
                if (i < 2) results.bust2++;
                if (i < 3) results.bust3++;
                if (i < 5) results.bust5++;
                if (i < 10) results.bust10++;
                break;
            }
            const shares = actualStake / s.entryPrice;
            const fee = actualStake * feeRate;
            if (s.won) {
                const payout = shares * 1;
                bank += (payout - actualStake) - fee;
            } else {
                bank -= actualStake + fee;
            }
            if (bank < minShares * 0.5) {
                if (i === 0) results.bust1++;
                if (i < 2) results.bust2++;
                if (i < 3) results.bust3++;
                if (i < 5) results.bust5++;
                if (i < 10) results.bust10++;
                break;
            }
        }
    }
    return {
        bust1: (results.bust1 / runs * 100).toFixed(2),
        bust2: (results.bust2 / runs * 100).toFixed(2),
        bust3: (results.bust3 / runs * 100).toFixed(2),
        bust5: (results.bust5 / runs * 100).toFixed(2),
        bust10: (results.bust10 / runs * 100).toFixed(2)
    };
}

for (const start of [5, 7, 10, 15, 20]) {
    const r = simulateBust(start);
    console.log(`  $${start}: bust1=${r.bust1}% bust2=${r.bust2}% bust3=${r.bust3}% bust5=${r.bust5}% bust10=${r.bust10}%`);
}

// Chronological replay: $10 starting balance
console.log('\n=== CHRONOLOGICAL OOS REPLAY ($10 start, exact runtime params) ===');
let bank = 10;
let trades = 0, wins = 0, losses = 0;
let maxBank = 10, minBank = 10;
let maxDD = 0;
let peak = 10;
for (const s of signals) {
    const idealStake = bank * 0.15;
    const minOrderUsd = 5 * s.entryPrice;
    const actualStake = Math.max(idealStake, minOrderUsd);
    if (actualStake > bank) {
        console.log(`  BUST at trade ${trades + 1}: bank $${bank.toFixed(2)} cannot afford min stake $${actualStake.toFixed(2)}`);
        break;
    }
    const shares = actualStake / s.entryPrice;
    const fee = actualStake * 0.0315;
    if (s.won) {
        bank += (shares - actualStake) - fee;
        wins++;
    } else {
        bank -= actualStake + fee;
        losses++;
    }
    trades++;
    if (bank > peak) peak = bank;
    const dd = (peak - bank) / peak;
    if (dd > maxDD) maxDD = dd;
    if (bank > maxBank) maxBank = bank;
    if (bank < minBank) minBank = bank;
}
console.log(`  Trades: ${trades} | Wins: ${wins} | Losses: ${losses} | WR: ${(wins / trades * 100).toFixed(1)}%`);
console.log(`  Final bank: $${bank.toFixed(2)}`);
console.log(`  Max bank: $${maxBank.toFixed(2)} | Min bank: $${minBank.toFixed(2)}`);
console.log(`  Max drawdown: ${(maxDD * 100).toFixed(1)}%`);

console.log('\n=== MC PROJECTIONS ($10 start, 24h / 48h / 72h / 7d) ===');
function mcProject(startBank, tradesPerRun, runs = 5000) {
    const finals = [];
    let busts = 0;
    for (let r = 0; r < runs; r++) {
        let bank = startBank;
        let busted = false;
        for (let i = 0; i < tradesPerRun; i++) {
            const s = signals[Math.floor(Math.random() * signals.length)];
            const idealStake = bank * 0.15;
            const minOrderUsd = 5 * s.entryPrice;
            const actualStake = Math.max(idealStake, minOrderUsd);
            if (actualStake > bank || bank < 2.5) {
                busted = true;
                break;
            }
            const shares = actualStake / s.entryPrice;
            const fee = actualStake * 0.0315;
            if (s.won) bank += (shares - actualStake) - fee;
            else bank -= actualStake + fee;
        }
        finals.push(busted ? bank : bank);
        if (busted) busts++;
    }
    finals.sort((a, b) => a - b);
    const pct = p => finals[Math.floor(p * finals.length)];
    return {
        bust: (busts / runs * 100).toFixed(1),
        p5: pct(0.05).toFixed(2),
        p25: pct(0.25).toFixed(2),
        median: pct(0.5).toFixed(2),
        p75: pct(0.75).toFixed(2),
        p90: pct(0.9).toFixed(2),
        p95: pct(0.95).toFixed(2)
    };
}
const tradesPerDay = signals.length / days.length;
const horizons = [
    { label: '24h', trades: Math.round(tradesPerDay) },
    { label: '48h', trades: Math.round(tradesPerDay * 2) },
    { label: '72h', trades: Math.round(tradesPerDay * 3) },
    { label: '7d', trades: Math.round(tradesPerDay * 7) }
];
for (const h of horizons) {
    const r = mcProject(10, h.trades);
    console.log(`  ${h.label} (${h.trades} trades): bust=${r.bust}% p5=$${r.p5} p25=$${r.p25} MEDIAN=$${r.median} p75=$${r.p75} p90=$${r.p90} p95=$${r.p95}`);
}

// Write results
fs.writeFileSync('data/v5_reverify_signals.json', JSON.stringify({
    totalSignals: signals.length,
    totalWins: signals.filter(s => s.won).length,
    days: days.length,
    aggregateWR: signals.filter(s => s.won).length / signals.length,
    dailyStats: byDay,
    maxConsecLoss,
    worstDayWR,
    worstDay
}, null, 2));
console.log('\nSaved detailed signals to data/v5_reverify_signals.json');
