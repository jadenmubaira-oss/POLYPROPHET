#!/usr/bin/env node
// Simulate cooldown impact at $10 bankroll
const fs = require('fs');

const v5 = JSON.parse(fs.readFileSync('strategies/strategy_set_15m_optimal_10usd_v5.json', 'utf8'));
const data = JSON.parse(fs.readFileSync('data/intracycle-price-data.json', 'utf8'));
const cycles = Array.isArray(data) ? data : (data.cycles || []);
const apr8 = Math.floor(new Date('2026-04-08T00:00:00Z').getTime() / 1000);
const oos = cycles.filter(c => (c.epoch || 0) >= apr8);

const signals = [];
for (const c of oos) {
    const h = new Date(c.epoch * 1000).getUTCHours();
    for (const s of v5.strategies) {
        if (s.utcHour !== h) continue;
        const entryPrice = s.direction === 'UP' ? c.minutePricesYes?.[s.entryMinute]?.last : c.minutePricesNo?.[s.entryMinute]?.last;
        if (!Number.isFinite(entryPrice) || entryPrice < s.priceMin || entryPrice > s.priceMax) continue;
        if (!c.resolution) continue;
        signals.push({
            epoch: c.epoch,
            entryMinute: s.entryMinute,
            entryTimestamp: c.epoch + s.entryMinute * 60,
            entryPrice,
            won: s.direction === c.resolution
        });
    }
}
signals.sort((a, b) => a.entryTimestamp - b.entryTimestamp);
const tradesPerDay = signals.length / 9;

function simulateWithCooldown(startBank, tradesPerRun, stakeFrac, minShares, maxConsecLoss, cooldownSec, runs = 10000) {
    const finals = [];
    let busts = 0;
    for (let r = 0; r < runs; r++) {
        let bank = startBank;
        let consecLoss = 0;
        let cooldownUntilTs = 0;
        let traded = 0;
        let busted = false;
        const startIdx = Math.floor(Math.random() * Math.max(1, signals.length - tradesPerRun));
        for (let i = 0; i < tradesPerRun; i++) {
            const idx = (startIdx + i) % signals.length;
            const s = signals[idx];
            if (s.entryTimestamp < cooldownUntilTs) continue;
            const idealStake = bank * stakeFrac;
            const minOrderUsd = minShares * s.entryPrice;
            const actualStake = Math.max(idealStake, minOrderUsd);
            if (actualStake > bank || bank < minShares * 0.5) {
                busted = true;
                break;
            }
            const shares = actualStake / s.entryPrice;
            const fee = actualStake * 0.0315;
            if (s.won) {
                bank += (shares - actualStake) - fee;
                consecLoss = 0;
            } else {
                bank -= actualStake + fee;
                consecLoss++;
                if (consecLoss >= maxConsecLoss) {
                    cooldownUntilTs = s.entryTimestamp + cooldownSec;
                }
            }
            traded++;
        }
        finals.push(bank);
        if (busted) busts++;
    }
    finals.sort((a, b) => a - b);
    const pct = p => finals[Math.floor(p * finals.length)] || 0;
    return {
        bust: (busts / runs * 100),
        p5: pct(0.05), p10: pct(0.10), p25: pct(0.25), median: pct(0.5), p75: pct(0.75), p90: pct(0.9), p95: pct(0.95)
    };
}

console.log('=== COOLDOWN IMPACT SIMULATION at $10 ===');
console.log('Chronological block bootstrap, exact runtime mechanics\n');
const configs = [
    { name: 'NO COOLDOWN (current default)', maxCL: 999, cd: 0 },
    { name: 'Cooldown after 2 losses, 30 min pause', maxCL: 2, cd: 30 * 60 },
    { name: 'Cooldown after 2 losses, 1 hour pause', maxCL: 2, cd: 60 * 60 },
    { name: 'Cooldown after 2 losses, 4 hour pause', maxCL: 2, cd: 4 * 60 * 60 },
    { name: 'Cooldown after 3 losses, 1 hour pause', maxCL: 3, cd: 60 * 60 },
    { name: 'Cooldown after 3 losses, 4 hour pause', maxCL: 3, cd: 4 * 60 * 60 },
];

for (const horizon of [24, 48, 72, 168]) {
    const nTrades = Math.round(tradesPerDay * horizon / 24);
    console.log(`\n--- ${horizon}h HORIZON (${nTrades} trades) ---`);
    console.log('Config                                     | Bust | p10   | p25   | MEDIAN  | p75     | p90');
    console.log('-------------------------------------------+------+-------+-------+---------+---------+---------');
    for (const cfg of configs) {
        const r = simulateWithCooldown(10, nTrades, 0.15, 5, cfg.maxCL, cfg.cd);
        console.log(`${cfg.name.padEnd(42)} | ${r.bust.toFixed(1).padStart(4)}% | $${r.p10.toFixed(2).padStart(5)} | $${r.p25.toFixed(2).padStart(5)} | $${r.median.toFixed(2).padStart(7)} | $${r.p75.toFixed(2).padStart(7)} | $${r.p90.toFixed(2).padStart(7)}`);
    }
}

console.log('\n=== RECOMMENDED CONFIG VERIFICATION ===');
console.log('Chosen: 2 consecutive losses → 1 hour cooldown');
for (const start of [7, 10, 12, 15]) {
    console.log(`\n--- Starting $${start} ---`);
    for (const horizon of [24, 48, 72, 168]) {
        const nTrades = Math.round(tradesPerDay * horizon / 24);
        const r = simulateWithCooldown(start, nTrades, 0.15, 5, 2, 60 * 60);
        console.log(`  ${horizon.toString().padStart(3)}h: bust=${r.bust.toFixed(1).padStart(4)}% p25=$${r.p25.toFixed(2).padStart(7)} MEDIAN=$${r.median.toFixed(2).padStart(8)} p75=$${r.p75.toFixed(2).padStart(9)} p95=$${r.p95.toFixed(2).padStart(9)}`);
    }
}
