#!/usr/bin/env node
// Bankroll sensitivity for the WINNER config (SF=0.25 + CD 3 losses / 60min).
// Helps the operator see whether $10, $12, $15, $20 deposit materially changes risk/return.
const fs = require('fs');

const DATA = JSON.parse(fs.readFileSync('data/intracycle-price-data.json', 'utf8'));
const cycles = Array.isArray(DATA) ? DATA : (DATA.cycles || []);
const OOS_START = Math.floor(new Date('2026-04-08T00:00:00Z').getTime() / 1000);
const oos = cycles.filter(c => (c.epoch || 0) >= OOS_START && (c.resolution === 'UP' || c.resolution === 'DOWN'));

const FEE = 0.0315;
const MIN_SHARES = 5;
const ASSET_RANK = { BTC: 0, ETH: 1, SOL: 2, XRP: 3 };
const KELLY_FRACTION = 0.35, KELLY_MAX_FRACTION = 0.45, KELLY_MIN_P_WIN = 0.55;
const SLIPPAGE_PCT = 0.01;
const PEAK_DD_BRAKE_MIN = 20, PEAK_DD_BRAKE_PCT = 0.20, PEAK_DD_BRAKE_SF = 0.12;

const v5 = JSON.parse(fs.readFileSync('strategies/strategy_set_15m_optimal_10usd_v5.json', 'utf8'));

function normalize(s) {
    return {
        ...s,
        priceMin: Number(s.priceMin || s.priceBandLow || 0),
        priceMax: Number(s.priceMax || s.priceBandHigh || 1),
        utcHour: Number(s.utcHour), entryMinute: Number(s.entryMinute),
        direction: String(s.direction || '').toUpperCase(),
        pWin: Number(s.pWinEstimate || s.winRateLCB || s.winRate || 0.5)
    };
}

function buildEvents(strats) {
    const buckets = new Map();
    for (const c of oos) {
        const h = new Date(c.epoch * 1000).getUTCHours();
        for (const s of strats) {
            if (Number.isFinite(s.utcHour) && s.utcHour !== -1 && s.utcHour !== h) continue;
            const m = s.entryMinute;
            if (!Number.isFinite(m)) continue;
            const yesAt = c.minutePricesYes?.[m]?.last;
            const noAt = c.minutePricesNo?.[m]?.last;
            const entryPrice = s.direction === 'UP' ? yesAt : noAt;
            if (!Number.isFinite(entryPrice) || entryPrice <= 0 || entryPrice >= 1) continue;
            if (entryPrice < s.priceMin || entryPrice > s.priceMax) continue;
            if (!buckets.has(c.epoch)) buckets.set(c.epoch, []);
            buckets.get(c.epoch).push({
                epoch: c.epoch, minute: m, timestamp: c.epoch + m * 60,
                asset: c.asset, direction: s.direction, entryPrice, pWin: s.pWin,
                won: s.direction === c.resolution, strategy: s.name || s.id
            });
        }
    }
    const events = [];
    for (const [, sigs] of buckets) {
        const earliestMin = Math.min(...sigs.map(x => x.minute));
        const firstSigs = sigs.filter(x => x.minute === earliestMin);
        firstSigs.sort((a, b) => {
            if (b.pWin !== a.pWin) return b.pWin - a.pWin;
            return (ASSET_RANK[a.asset] ?? 99) - (ASSET_RANK[b.asset] ?? 99);
        });
        events.push(firstSigs[0]);
    }
    return events.sort((a, b) => a.timestamp - b.timestamp);
}

function runtimeStake(bank, peak, entryPrice, pWin, configSF) {
    let sf = configSF;
    if (peak > PEAK_DD_BRAKE_MIN) {
        const dd = (peak - bank) / peak;
        if (dd >= PEAK_DD_BRAKE_PCT) sf = Math.min(sf, PEAK_DD_BRAKE_SF);
    }
    let size = bank * sf;
    if (pWin >= KELLY_MIN_P_WIN && entryPrice > 0 && entryPrice < 1) {
        const effEntry = Math.min(0.99, entryPrice * (1 + SLIPPAGE_PCT));
        const b = (1 / effEntry) - 1;
        if (b > 0) {
            const fullKelly = (b * pWin - (1 - pWin)) / b;
            if (fullKelly > 0) {
                const kellySize = bank * Math.min(fullKelly * KELLY_FRACTION, KELLY_MAX_FRACTION);
                if (kellySize < size) size = kellySize;
            }
        }
    }
    const maxSize = bank * sf;
    if (size > maxSize) size = maxSize;
    const minOrderCost = MIN_SHARES * entryPrice;
    if (size < minOrderCost) {
        if (bank >= minOrderCost) size = minOrderCost;
        else return { size: 0, blocked: true };
    }
    if (size > bank) size = bank;
    return { size, blocked: false };
}

function mcSim(events, startBank, horizonHours, configSF, runs = 10000, maxConsecLoss = 3, cooldownSec = 3600) {
    const days = [...new Set(events.map(e => new Date(e.timestamp * 1000).toISOString().slice(0, 10)))].sort();
    const evtPerDay = events.length / Math.max(1, days.length);
    const tradesPerRun = Math.max(1, Math.round(evtPerDay * horizonHours / 24));
    const finals = []; const maxDDs = []; let busts = 0;
    for (let r = 0; r < runs; r++) {
        let bank = startBank, peak = startBank, maxDD = 0, busted = false;
        let consec = 0, cooldownUntil = 0;
        const startIdx = Math.floor(Math.random() * Math.max(1, events.length - tradesPerRun));
        for (let i = 0; i < tradesPerRun; i++) {
            const evt = events[(startIdx + i) % events.length];
            if (evt.timestamp < cooldownUntil) continue;
            const { size, blocked } = runtimeStake(bank, peak, evt.entryPrice, evt.pWin, configSF);
            if (blocked || bank < 2.5) { busted = true; break; }
            const shares = size / evt.entryPrice;
            const fee = size * FEE;
            if (evt.won) { bank += (shares - size) - fee; consec = 0; }
            else {
                bank -= size + fee;
                consec++;
                if (consec >= maxConsecLoss) { cooldownUntil = evt.timestamp + cooldownSec; consec = 0; }
            }
            if (bank > peak) peak = bank;
            const dd = (peak - bank) / peak;
            if (dd > maxDD) maxDD = dd;
        }
        finals.push(bank); maxDDs.push(maxDD);
        if (busted) busts++;
    }
    finals.sort((a, b) => a - b); maxDDs.sort((a, b) => a - b);
    const q = p => finals[Math.floor(p * finals.length)] || 0;
    const ddq = p => maxDDs[Math.floor(p * maxDDs.length)] || 0;
    return {
        bust: (busts / runs * 100),
        p5: q(0.05), p10: q(0.10), p25: q(0.25), median: q(0.5), p75: q(0.75), p90: q(0.90), p95: q(0.95),
        medianDD: ddq(0.5) * 100, p90DD: ddq(0.9) * 100
    };
}

const base = v5.strategies.map(normalize);
const events = buildEvents(base);

console.log(`\nEvents: ${events.length}, SF=0.25, Cooldown 3L/60m\n`);
console.log('Start | 24h Bust | 24h MED | 48h MED | 72h MED | 7d Bust | 7d p25  | 7d MED  | 7d p75  | 7d p95  | 7d medDD');
console.log('------+----------+---------+---------+---------+---------+---------+---------+---------+---------+---------');
for (const start of [10, 11, 12, 13, 15, 17, 20, 25]) {
    const r24 = mcSim(events, start, 24, 0.25);
    const r48 = mcSim(events, start, 48, 0.25);
    const r72 = mcSim(events, start, 72, 0.25);
    const r7d = mcSim(events, start, 168, 0.25);
    console.log(`$${String(start).padStart(3)}  | ${r24.bust.toFixed(1).padStart(7)}% | $${r24.median.toFixed(2).padStart(7)} | $${r48.median.toFixed(2).padStart(7)} | $${r72.median.toFixed(2).padStart(7)} | ${r7d.bust.toFixed(1).padStart(6)}% | $${r7d.p25.toFixed(2).padStart(6)} | $${r7d.median.toFixed(2).padStart(6)} | $${r7d.p75.toFixed(2).padStart(6)} | $${r7d.p95.toFixed(2).padStart(6)} | ${r7d.medianDD.toFixed(0)}%`);
}

console.log('\n\n=== FIRST-N-TRADE BUST RISK AT EACH BANKROLL (SF=0.25 + Kelly + min-order) ===');
// Shuffled first-N bust: worst-case variance, which trades fire first is random.
function firstNBust(events, startBank, runs = 30000) {
    let b1 = 0, b2 = 0, b3 = 0, b5 = 0, b10 = 0;
    for (let r = 0; r < runs; r++) {
        let bank = startBank, peak = startBank;
        for (let i = 0; i < 10; i++) {
            const evt = events[Math.floor(Math.random() * events.length)];
            const { size, blocked } = runtimeStake(bank, peak, evt.entryPrice, evt.pWin, 0.25);
            if (blocked) {
                if (i === 0) b1++;
                if (i < 2) b2++;
                if (i < 3) b3++;
                if (i < 5) b5++;
                b10++;
                break;
            }
            const shares = size / evt.entryPrice;
            const fee = size * FEE;
            if (evt.won) bank += (shares - size) - fee;
            else bank -= size + fee;
            if (bank > peak) peak = bank;
            if (bank < MIN_SHARES * 0.5) {
                if (i === 0) b1++;
                if (i < 2) b2++;
                if (i < 3) b3++;
                if (i < 5) b5++;
                b10++;
                break;
            }
        }
    }
    return {
        b1: (b1 / runs * 100).toFixed(2),
        b2: (b2 / runs * 100).toFixed(2),
        b3: (b3 / runs * 100).toFixed(2),
        b5: (b5 / runs * 100).toFixed(2),
        b10: (b10 / runs * 100).toFixed(2)
    };
}
console.log('Start | 1 trade | 2 trades | 3 trades | 5 trades | 10 trades');
for (const start of [10, 11, 12, 13, 15, 17, 20]) {
    const f = firstNBust(events, start);
    console.log(`$${String(start).padStart(3)}  | ${f.b1.padStart(5)}%  | ${f.b2.padStart(5)}%   | ${f.b3.padStart(5)}%   | ${f.b5.padStart(5)}%   | ${f.b10.padStart(5)}%`);
}

console.log('\n\n=== ULTRA-WORST: 10 CONSECUTIVE LOSSES FROM EACH BANKROLL ===');
function tenStraightLosses(startBank) {
    let bank = startBank, peak = startBank;
    const trail = [];
    for (let i = 0; i < 10; i++) {
        // Use average entry price
        const entryPrice = 0.82;
        const pWin = 0.90;
        const { size, blocked } = runtimeStake(bank, peak, entryPrice, pWin, 0.25);
        if (blocked) { trail.push(`  T${i + 1}: BLOCKED at $${bank.toFixed(2)} (below min-order)`); break; }
        const fee = size * FEE;
        bank -= size + fee;
        trail.push(`  T${i + 1}: bank=$${bank.toFixed(2)} (stake=$${size.toFixed(2)}, fee=$${fee.toFixed(2)})`);
        if (bank < 2.5) { trail.push(`  BUST at T${i + 1}`); break; }
    }
    return trail;
}
for (const start of [10, 12, 15, 20]) {
    console.log(`\nStart $${start}, 10 losses in a row (no cooldown):`);
    tenStraightLosses(start).forEach(t => console.log(t));
}
