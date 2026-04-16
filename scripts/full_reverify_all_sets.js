#!/usr/bin/env node
// FULL RE-VERIFY: runtime-parity sim across multiple strategy sets on real OOS data.
// Simulates exact production gating: MAX_GLOBAL_TRADES_PER_CYCLE=1, min 5 shares, 3.15% fee,
// 1 signal per full 15m cycle (earliest-minute, highest-pWin deterministic selection),
// pre-resolution wins settle at $1.00 payout.
const fs = require('fs');
const path = require('path');

const DATA = JSON.parse(fs.readFileSync('data/intracycle-price-data.json', 'utf8'));
const cycles = Array.isArray(DATA) ? DATA : (DATA.cycles || []);
const OOS_START = Math.floor(new Date('2026-04-08T00:00:00Z').getTime() / 1000);
const oos = cycles.filter(c => (c.epoch || 0) >= OOS_START && (c.resolution === 'UP' || c.resolution === 'DOWN'));
console.log(`\nOOS cycles (Apr 8-16): ${oos.length}`);

const FEE = 0.0315;
const MIN_SHARES = 5;
const STAKE_FRAC = 0.15;
const ASSET_RANK = { BTC: 0, ETH: 1, SOL: 2, XRP: 3 };

function normalizeProb(v) {
    const p = Number(v);
    if (!Number.isFinite(p) || p < 0) return null;
    if (p > 0 && p <= 1) return p;
    if (p > 1 && p <= 100) return p / 100;
    return null;
}

function loadSet(file) {
    const raw = JSON.parse(fs.readFileSync(path.join('strategies', file), 'utf8'));
    const list = Array.isArray(raw.strategies) ? raw.strategies : [];
    return list.map(s => ({
        ...s,
        priceMin: Number(s.priceMin || s.priceBandLow || 0),
        priceMax: Number(s.priceMax || s.priceBandHigh || 1),
        utcHour: Number(s.utcHour),
        entryMinute: Number(s.entryMinute),
        direction: String(s.direction || '').toUpperCase(),
        pWin: normalizeProb(s.pWinEstimate) || normalizeProb(s.winRateLCB) || normalizeProb(s.winRate) || 0.5
    }));
}

// Build runtime-parity firing events from a strategy set against OOS cycles.
// For each 15m cycle, collect all (asset × strategy) matches, pick the earliest minute,
// then the highest pWin, then deterministic asset order. Only 1 event per cycle.
function buildFiringEvents(strategies) {
    const cycleBuckets = new Map(); // epoch -> signals[]
    for (const c of oos) {
        const h = new Date(c.epoch * 1000).getUTCHours();
        for (const s of strategies) {
            if (Number.isFinite(s.utcHour) && s.utcHour !== -1 && s.utcHour !== h) continue;
            const m = s.entryMinute;
            if (!Number.isFinite(m)) continue;
            const yesAt = c.minutePricesYes?.[m]?.last;
            const noAt = c.minutePricesNo?.[m]?.last;
            const entryPrice = s.direction === 'UP' ? yesAt : noAt;
            if (!Number.isFinite(entryPrice) || entryPrice <= 0 || entryPrice >= 1) continue;
            if (entryPrice < s.priceMin || entryPrice > s.priceMax) continue;
            if (!cycleBuckets.has(c.epoch)) cycleBuckets.set(c.epoch, []);
            cycleBuckets.get(c.epoch).push({
                epoch: c.epoch,
                minute: m,
                timestamp: c.epoch + m * 60,
                asset: c.asset,
                direction: s.direction,
                entryPrice,
                pWin: s.pWin,
                won: s.direction === c.resolution,
                strategy: s.name || s.id
            });
        }
    }
    const events = [];
    for (const [, sigs] of cycleBuckets) {
        const earliestMin = Math.min(...sigs.map(x => x.minute));
        const firstMinSigs = sigs.filter(x => x.minute === earliestMin);
        firstMinSigs.sort((a, b) => {
            if (b.pWin !== a.pWin) return b.pWin - a.pWin;
            return (ASSET_RANK[a.asset] ?? 99) - (ASSET_RANK[b.asset] ?? 99);
        });
        events.push(firstMinSigs[0]);
    }
    events.sort((a, b) => a.timestamp - b.timestamp);
    return events;
}

// Chronological replay from $10
function replay(events, start = 10) {
    let bank = start, peak = start, maxDD = 0, mcl = 0, cur = 0, trades = 0, wins = 0, losses = 0;
    for (const e of events) {
        const idealStake = bank * STAKE_FRAC;
        const minOrder = MIN_SHARES * e.entryPrice;
        const stake = Math.max(idealStake, minOrder);
        if (stake > bank) break;
        const shares = stake / e.entryPrice;
        const fee = stake * FEE;
        if (e.won) {
            bank += (shares - stake) - fee;
            cur = 0; wins++;
        } else {
            bank -= stake + fee;
            cur++; if (cur > mcl) mcl = cur; losses++;
        }
        trades++;
        if (bank > peak) peak = bank;
        const dd = (peak - bank) / peak;
        if (dd > maxDD) maxDD = dd;
    }
    return { trades, wins, losses, wr: trades ? wins / trades : 0, final: bank, peak, maxDD, mcl };
}

// Monte Carlo: bootstrap events per day density, random starting offset, with variance re-seeds.
function mcSim(events, startBank, horizonHours, runs = 5000) {
    const days = [...new Set(events.map(e => new Date(e.timestamp * 1000).toISOString().slice(0, 10)))].sort();
    const evtPerDay = events.length / Math.max(1, days.length);
    const tradesPerRun = Math.max(1, Math.round(evtPerDay * horizonHours / 24));
    const finals = [];
    const maxDDs = [];
    let busts = 0;
    for (let r = 0; r < runs; r++) {
        let bank = startBank, peak = startBank, maxDD = 0, busted = false;
        const startIdx = Math.floor(Math.random() * Math.max(1, events.length - tradesPerRun));
        for (let i = 0; i < tradesPerRun; i++) {
            const evt = events[(startIdx + i) % events.length];
            const idealStake = bank * STAKE_FRAC;
            const minOrder = MIN_SHARES * evt.entryPrice;
            const stake = Math.max(idealStake, minOrder);
            if (stake > bank || bank < 2.5) { busted = true; break; }
            const shares = stake / evt.entryPrice;
            const fee = stake * FEE;
            if (evt.won) bank += (shares - stake) - fee;
            else bank -= stake + fee;
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
    const q = p => finals[Math.floor(p * finals.length)] || 0;
    const ddq = p => maxDDs[Math.floor(p * maxDDs.length)] || 0;
    return {
        trades: tradesPerRun,
        evtPerDay: evtPerDay.toFixed(2),
        bust: (busts / runs * 100),
        p5: q(0.05), p10: q(0.10), p25: q(0.25), median: q(0.5), p75: q(0.75), p90: q(0.90), p95: q(0.95),
        medianDD: ddq(0.5) * 100, p90DD: ddq(0.9) * 100
    };
}

// Shuffle Monte Carlo (re-draws independent samples, hostile variance)
function shuffleMC(events, startBank, horizonHours, runs = 5000) {
    const days = [...new Set(events.map(e => new Date(e.timestamp * 1000).toISOString().slice(0, 10)))].sort();
    const evtPerDay = events.length / Math.max(1, days.length);
    const tradesPerRun = Math.max(1, Math.round(evtPerDay * horizonHours / 24));
    const finals = [];
    let busts = 0;
    for (let r = 0; r < runs; r++) {
        let bank = startBank;
        for (let i = 0; i < tradesPerRun; i++) {
            const evt = events[Math.floor(Math.random() * events.length)];
            const idealStake = bank * STAKE_FRAC;
            const minOrder = MIN_SHARES * evt.entryPrice;
            const stake = Math.max(idealStake, minOrder);
            if (stake > bank || bank < 2.5) { busts++; break; }
            const shares = stake / evt.entryPrice;
            const fee = stake * FEE;
            if (evt.won) bank += (shares - stake) - fee;
            else bank -= stake + fee;
        }
        finals.push(bank);
    }
    finals.sort((a, b) => a - b);
    const q = p => finals[Math.floor(p * finals.length)] || 0;
    return {
        bust: (busts / runs * 100),
        p5: q(0.05), p25: q(0.25), median: q(0.5), p75: q(0.75), p90: q(0.90), p95: q(0.95)
    };
}

// First-N-trade bust risk (shuffled events, catastrophic start variance)
function firstTradeBust(events, startBank, runs = 20000) {
    const buckets = { b1: 0, b2: 0, b3: 0, b5: 0, b10: 0 };
    for (let r = 0; r < runs; r++) {
        let bank = startBank;
        for (let i = 0; i < 10; i++) {
            const evt = events[Math.floor(Math.random() * events.length)];
            const idealStake = bank * STAKE_FRAC;
            const minOrder = MIN_SHARES * evt.entryPrice;
            const stake = Math.max(idealStake, minOrder);
            if (stake > bank || bank < 2.5) {
                if (i === 0) buckets.b1++;
                if (i < 2) buckets.b2++;
                if (i < 3) buckets.b3++;
                if (i < 5) buckets.b5++;
                buckets.b10++;
                break;
            }
            const shares = stake / evt.entryPrice;
            const fee = stake * FEE;
            if (evt.won) bank += (shares - stake) - fee;
            else bank -= stake + fee;
            if (bank < MIN_SHARES * 0.5) {
                if (i === 0) buckets.b1++;
                if (i < 2) buckets.b2++;
                if (i < 3) buckets.b3++;
                if (i < 5) buckets.b5++;
                buckets.b10++;
                break;
            }
        }
    }
    return {
        b1: (buckets.b1 / runs * 100).toFixed(2),
        b2: (buckets.b2 / runs * 100).toFixed(2),
        b3: (buckets.b3 / runs * 100).toFixed(2),
        b5: (buckets.b5 / runs * 100).toFixed(2),
        b10: (buckets.b10 / runs * 100).toFixed(2)
    };
}

const CANDIDATES = [
    'strategy_set_15m_optimal_10usd_v5.json',
    'strategy_set_15m_optimal_10usd_v4_pruned.json',
    'strategy_set_15m_optimal_10usd_v3.json',
    'strategy_set_15m_ultrasafe_10usd.json',
    'strategy_set_15m_24h_dense.json',
    'strategy_set_15m_24h_ultra_tight.json',
    'strategy_set_15m_beam11_zero_bust.json',
    'strategy_set_15m_elite_recency.json'
];

const summary = [];
for (const file of CANDIDATES) {
    const name = file.replace('strategy_set_15m_', '').replace('.json', '');
    try {
        const strats = loadSet(file);
        const events = buildFiringEvents(strats);
        if (events.length === 0) {
            console.log(`\n=== ${name} === NO EVENTS in OOS`);
            continue;
        }
        const days = [...new Set(events.map(e => new Date(e.timestamp * 1000).toISOString().slice(0, 10)))].sort();
        const rep = replay(events, 10);
        const mc24 = mcSim(events, 10, 24);
        const mc48 = mcSim(events, 10, 48);
        const mc72 = mcSim(events, 10, 72);
        const mc7d = mcSim(events, 10, 168);
        const sh24 = shuffleMC(events, 10, 24);
        const sh7d = shuffleMC(events, 10, 168);
        const ftb = firstTradeBust(events, 10);
        console.log(`\n=== ${name} (${strats.length} strats) ===`);
        console.log(`  Events: ${events.length} over ${days.length} days (${(events.length / days.length).toFixed(1)}/day)`);
        console.log(`  Chronological replay: trades=${rep.trades} WR=${(rep.wr * 100).toFixed(1)}% final=$${rep.final.toFixed(2)} peak=$${rep.peak.toFixed(2)} MCL=${rep.mcl} maxDD=${(rep.maxDD * 100).toFixed(1)}%`);
        console.log(`  24h (block):  bust=${mc24.bust.toFixed(1)}% p10=$${mc24.p10.toFixed(2)} p25=$${mc24.p25.toFixed(2)} MED=$${mc24.median.toFixed(2)} p75=$${mc24.p75.toFixed(2)} p90=$${mc24.p90.toFixed(2)} p95=$${mc24.p95.toFixed(2)} medDD=${mc24.medianDD.toFixed(0)}%`);
        console.log(`  48h (block):  bust=${mc48.bust.toFixed(1)}% p10=$${mc48.p10.toFixed(2)} p25=$${mc48.p25.toFixed(2)} MED=$${mc48.median.toFixed(2)} p75=$${mc48.p75.toFixed(2)} p90=$${mc48.p90.toFixed(2)} p95=$${mc48.p95.toFixed(2)}`);
        console.log(`  72h (block):  bust=${mc72.bust.toFixed(1)}% p25=$${mc72.p25.toFixed(2)} MED=$${mc72.median.toFixed(2)} p75=$${mc72.p75.toFixed(2)} p90=$${mc72.p90.toFixed(2)} p95=$${mc72.p95.toFixed(2)}`);
        console.log(`  7d  (block):  bust=${mc7d.bust.toFixed(1)}% p25=$${mc7d.p25.toFixed(2)} MED=$${mc7d.median.toFixed(2)} p75=$${mc7d.p75.toFixed(2)} p90=$${mc7d.p90.toFixed(2)} p95=$${mc7d.p95.toFixed(2)}`);
        console.log(`  24h (shuffled-hostile): bust=${sh24.bust.toFixed(1)}% p25=$${sh24.p25.toFixed(2)} MED=$${sh24.median.toFixed(2)}`);
        console.log(`  7d  (shuffled-hostile): bust=${sh7d.bust.toFixed(1)}% p25=$${sh7d.p25.toFixed(2)} MED=$${sh7d.median.toFixed(2)}`);
        console.log(`  First-trade bust ($10): 1t=${ftb.b1}% 2t=${ftb.b2}% 3t=${ftb.b3}% 5t=${ftb.b5}%`);
        summary.push({ name, strats: strats.length, eventsPerDay: +(events.length / days.length).toFixed(1), rep, mc24, mc48, mc7d, sh24, sh7d, ftb });
    } catch (e) {
        console.error(`${name} ERROR: ${e.message}`);
    }
}

console.log('\n\n================ FINAL SUMMARY (sorted by 7d block-median) ================');
summary.sort((a, b) => b.mc7d.median - a.mc7d.median);
console.log('Set                          | Evt/d | Rep WR | Rep$   | 24h MED | 24h Bust | 48h MED | 7d MED   | 7d Bust | 7d shuf-MED | 1t-bust');
console.log('-----------------------------+-------+--------+--------+---------+----------+---------+----------+---------+-------------+---------');
for (const s of summary) {
    console.log(
        `${s.name.padEnd(28)} | ${String(s.eventsPerDay).padStart(5)} | ${(s.rep.wr * 100).toFixed(1).padStart(5)}% | $${s.rep.final.toFixed(2).padStart(6)} | $${s.mc24.median.toFixed(2).padStart(7)} | ${s.mc24.bust.toFixed(1).padStart(7)}% | $${s.mc48.median.toFixed(2).padStart(7)} | $${s.mc7d.median.toFixed(2).padStart(8)} | ${s.mc7d.bust.toFixed(1).padStart(7)}% | $${s.sh7d.median.toFixed(2).padStart(10)} | ${s.ftb.b1.padStart(5)}%`
    );
}
