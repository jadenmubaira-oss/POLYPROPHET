#!/usr/bin/env node
// Bankroll sweep: find optimal starting balance for max median upside / low bust
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
        const yesAt = c.minutePricesYes?.[s.entryMinute]?.last;
        const noAt = c.minutePricesNo?.[s.entryMinute]?.last;
        const entryPrice = s.direction === 'UP' ? yesAt : noAt;
        if (!Number.isFinite(entryPrice) || entryPrice <= 0 || entryPrice >= 1) continue;
        if (entryPrice < s.priceMin || entryPrice > s.priceMax) continue;
        if (!c.resolution) continue;
        signals.push({
            epoch: c.epoch,
            asset: c.asset,
            direction: s.direction,
            entryPrice,
            won: s.direction === c.resolution,
            tier: s.tier || 'A'
        });
    }
}
signals.sort((a, b) => a.epoch - b.epoch);

const days = [...new Set(signals.map(s => new Date(s.epoch * 1000).toISOString().slice(0, 10)))];
const tradesPerDay = signals.length / days.length;
console.log('Signals:', signals.length, '| Days:', days.length, '| Avg/day:', tradesPerDay.toFixed(1));
console.log('Aggregate WR:', (signals.filter(s => s.won).length / signals.length * 100).toFixed(2) + '%');

// MC with both random and chronological-block bootstraps
function mcBootstrap(startBank, tradesPerRun, stakeFrac, minShares, runs = 5000, useChronoBlocks = true) {
    const finals = [];
    let busts = 0;
    for (let r = 0; r < runs; r++) {
        let bank = startBank;
        let busted = false;
        let picks;
        if (useChronoBlocks) {
            // Pick a random start and walk chronologically (captures loss clustering)
            const startIdx = Math.floor(Math.random() * Math.max(1, signals.length - tradesPerRun));
            picks = signals.slice(startIdx, startIdx + tradesPerRun);
            if (picks.length < tradesPerRun) {
                // wrap around
                picks = picks.concat(signals.slice(0, tradesPerRun - picks.length));
            }
        } else {
            picks = [];
            for (let i = 0; i < tradesPerRun; i++) picks.push(signals[Math.floor(Math.random() * signals.length)]);
        }
        for (const s of picks) {
            const idealStake = bank * stakeFrac;
            const minOrderUsd = minShares * s.entryPrice;
            const actualStake = Math.max(idealStake, minOrderUsd);
            if (actualStake > bank || bank < minShares * 0.5) {
                busted = true;
                break;
            }
            const shares = actualStake / s.entryPrice;
            const fee = actualStake * 0.0315;
            if (s.won) bank += (shares - actualStake) - fee;
            else bank -= actualStake + fee;
        }
        finals.push(bank);
        if (busted) busts++;
    }
    finals.sort((a, b) => a - b);
    const pct = p => finals[Math.floor(p * finals.length)] || 0;
    return {
        bust: (busts / runs * 100),
        p5: pct(0.05),
        p10: pct(0.10),
        p25: pct(0.25),
        median: pct(0.5),
        p75: pct(0.75),
        p90: pct(0.9),
        p95: pct(0.95)
    };
}

console.log('\n=== BANKROLL SWEEP (24h horizon, chronological block bootstrap — captures clustering) ===');
console.log('Start |  Bust  |  p10   |  p25   | MEDIAN |  p75   |  p90   |  p95');
console.log('------+--------+--------+--------+--------+--------+--------+--------');
for (const start of [5, 7, 10, 12, 15, 20, 25, 30]) {
    const r = mcBootstrap(start, Math.round(tradesPerDay), 0.15, 5, 10000, true);
    console.log(`$${String(start).padStart(3)} | ${r.bust.toFixed(1).padStart(5)}% | $${r.p10.toFixed(2).padStart(6)} | $${r.p25.toFixed(2).padStart(6)} | $${r.median.toFixed(2).padStart(6)} | $${r.p75.toFixed(2).padStart(6)} | $${r.p90.toFixed(2).padStart(6)} | $${r.p95.toFixed(2).padStart(6)}`);
}

console.log('\n=== BANKROLL SWEEP (7d horizon, chronological block bootstrap) ===');
console.log('Start |  Bust  |  p10   |  p25   | MEDIAN |  p75   |  p90   |  p95');
console.log('------+--------+--------+--------+--------+--------+--------+--------');
for (const start of [5, 7, 10, 12, 15, 20, 25, 30]) {
    const r = mcBootstrap(start, Math.round(tradesPerDay * 7), 0.15, 5, 10000, true);
    console.log(`$${String(start).padStart(3)} | ${r.bust.toFixed(1).padStart(5)}% | $${r.p10.toFixed(2).padStart(6)} | $${r.p25.toFixed(2).padStart(6)} | $${r.median.toFixed(2).padStart(6)} | $${r.p75.toFixed(2).padStart(6)} | $${r.p90.toFixed(2).padStart(6)} | $${r.p95.toFixed(2).padStart(6)}`);
}

// Stake-fraction sweep at $10 to find optimal size
console.log('\n=== STAKE FRACTION SWEEP at $10 (24h) ===');
console.log('Stake |  Bust  |  p10   |  p25   | MEDIAN |  p75   |  p90');
console.log('------+--------+--------+--------+--------+--------+--------');
for (const stakeF of [0.05, 0.08, 0.10, 0.12, 0.15, 0.18, 0.20, 0.25, 0.30]) {
    const r = mcBootstrap(10, Math.round(tradesPerDay), stakeF, 5, 10000, true);
    console.log(`${(stakeF*100).toFixed(0).padStart(3)}% | ${r.bust.toFixed(1).padStart(5)}% | $${r.p10.toFixed(2).padStart(6)} | $${r.p25.toFixed(2).padStart(6)} | $${r.median.toFixed(2).padStart(6)} | $${r.p75.toFixed(2).padStart(6)} | $${r.p90.toFixed(2).padStart(6)}`);
}

// Safety-first run: $10 with smaller stake & tier-S only
console.log('\n=== TIER-S ONLY vs ALL TIERS at $10 (24h) ===');
const tierSSignals = signals.filter(s => s.tier === 'S');
const nonSSignals = signals;
console.log('Tier-S trades available:', tierSSignals.length, '| All tiers:', nonSSignals.length);
console.log('Tier-S WR:', (tierSSignals.filter(s => s.won).length / tierSSignals.length * 100).toFixed(1) + '%');
// Can't easily swap in-sim. Skip.

// Summary at the recommended configs
console.log('\n=== RECOMMENDED CONFIG PROJECTIONS ===');
for (const cfg of [
    { start: 10, stake: 0.15, horizon: 24, label: '$10 @ 15% stake, 24h' },
    { start: 10, stake: 0.10, horizon: 24, label: '$10 @ 10% stake, 24h' },
    { start: 10, stake: 0.15, horizon: 48, label: '$10 @ 15% stake, 48h' },
    { start: 10, stake: 0.15, horizon: 72, label: '$10 @ 15% stake, 72h' },
    { start: 10, stake: 0.15, horizon: 168, label: '$10 @ 15% stake, 7d' },
    { start: 15, stake: 0.15, horizon: 24, label: '$15 @ 15% stake, 24h' },
    { start: 15, stake: 0.15, horizon: 168, label: '$15 @ 15% stake, 7d' },
    { start: 20, stake: 0.15, horizon: 168, label: '$20 @ 15% stake, 7d' }
]) {
    const nTrades = Math.round(tradesPerDay * cfg.horizon / 24);
    const r = mcBootstrap(cfg.start, nTrades, cfg.stake, 5, 10000, true);
    console.log(`  ${cfg.label.padEnd(30)}: bust=${r.bust.toFixed(1).padStart(4)}% | p25=$${r.p25.toFixed(2).padStart(7)} | MEDIAN=$${r.median.toFixed(2).padStart(8)} | p75=$${r.p75.toFixed(2).padStart(9)} | p95=$${r.p95.toFixed(2).padStart(9)}`);
}
