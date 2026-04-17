#!/usr/bin/env node
/**
 * SF=0.25 + COOLDOWN FINAL COMPARISON
 *
 * Tests EVERY strategy set in strategies/*.json under the EXACT live runtime posture:
 *  - OPERATOR_STAKE_FRACTION = 0.25
 *  - MAX_CONSECUTIVE_LOSSES = 3
 *  - COOLDOWN_SECONDS = 3600  (cooldown after 3 straight losses stops trading for 60m)
 *  - MAX_GLOBAL_TRADES_PER_CYCLE = 1
 *  - 5-share minimum order (DEFAULT_MIN_ORDER_SHARES)
 *  - 3.15% taker fee
 *  - Peak-drawdown brake: SF capped at 0.12 if peak>=$20 and DD>=20%
 *
 * Uses Apr 8-16 OOS data. Finds whether anything beats v5 on our actual posture.
 */

const fs = require('fs');
const path = require('path');

const DATA = JSON.parse(fs.readFileSync('data/intracycle-price-data.json', 'utf8'));
const cycles = Array.isArray(DATA) ? DATA : (DATA.cycles || []);
const OOS_START = Math.floor(new Date('2026-04-08T00:00:00Z').getTime() / 1000);
const oos = cycles.filter(c => (c.epoch || 0) >= OOS_START && (c.resolution === 'UP' || c.resolution === 'DOWN'));

const FEE = 0.0315;
const MIN_SHARES = 5;
const BASE_STAKE_FRAC = 0.25;          // live SF
const MCL = 3;                          // live max consecutive losses
const COOLDOWN_MS = 3600 * 1000;        // live cooldown (1h)
const BRAKE_PEAK_MIN = 20;              // live peakDrawdownBrakeMinBankroll
const BRAKE_DD_PCT = 0.20;              // live peakDrawdownBrakePct
const BRAKE_SF = 0.12;                  // live peak-DD capped SF
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

function buildFiringEvents(strategies) {
    const cycleBuckets = new Map();
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
                won: s.direction === c.resolution
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

// Exact production gating: SF=0.25, cooldown 3L/1h, peak-DD brake, min-order clamp
function simOne(events, start, horizonHours, rng) {
    const days = [...new Set(events.map(e => new Date(e.timestamp * 1000).toISOString().slice(0, 10)))].sort();
    const evtPerDay = events.length / Math.max(1, days.length);
    const tradesPerRun = Math.max(1, Math.round(evtPerDay * horizonHours / 24));
    let bank = start, peak = start, cur = 0, cooldownUntil = 0, virtualTime = 0;
    const startIdx = Math.floor(rng() * Math.max(1, events.length - tradesPerRun));
    for (let i = 0; i < tradesPerRun; i++) {
        virtualTime += 15 * 60 * 1000; // 15m per cycle
        if (virtualTime < cooldownUntil) continue; // skip cycle during cooldown
        const evt = events[(startIdx + i) % events.length];
        let sf = BASE_STAKE_FRAC;
        if (peak > BRAKE_PEAK_MIN) {
            const dd = (peak - bank) / peak;
            if (dd >= BRAKE_DD_PCT) sf = Math.min(sf, BRAKE_SF);
        }
        const idealStake = bank * sf;
        const minOrder = MIN_SHARES * evt.entryPrice;
        const stake = Math.max(idealStake, minOrder);
        if (stake > bank || bank < 2.5) return { final: bank, busted: true };
        const shares = stake / evt.entryPrice;
        const fee = stake * FEE;
        if (evt.won) {
            bank += (shares - stake) - fee;
            cur = 0;
            if (bank > peak) peak = bank;
        } else {
            bank -= stake + fee;
            cur++;
            if (cur >= MCL) {
                cooldownUntil = virtualTime + COOLDOWN_MS;
                cur = 0;
            }
        }
    }
    return { final: bank, busted: false };
}

function mcSim(events, start, horizonHours, runs = 10000) {
    const finals = [];
    let busts = 0;
    let seed = 42;
    const rng = () => { seed = (seed * 9301 + 49297) % 233280; return seed / 233280; };
    for (let r = 0; r < runs; r++) {
        const res = simOne(events, start, horizonHours, rng);
        finals.push(res.final);
        if (res.busted) busts++;
    }
    finals.sort((a, b) => a - b);
    const q = p => finals[Math.floor(p * finals.length)] || 0;
    return {
        bust: (busts / runs * 100),
        p10: q(0.10), p25: q(0.25), median: q(0.5), p75: q(0.75), p90: q(0.90), p95: q(0.95)
    };
}

function firstNBust(events, start, runs = 20000) {
    const buckets = { b1: 0, b2: 0, b3: 0, b5: 0, b10: 0 };
    let seed = 123;
    const rng = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
    for (let r = 0; r < runs; r++) {
        let bank = start, peak = start, cur = 0, cooldownUntil = 0, virtualTime = 0;
        for (let i = 0; i < 10; i++) {
            virtualTime += 15 * 60 * 1000;
            if (virtualTime < cooldownUntil) continue;
            const evt = events[Math.floor(rng() * events.length)];
            let sf = BASE_STAKE_FRAC;
            if (peak > BRAKE_PEAK_MIN) {
                const dd = (peak - bank) / peak;
                if (dd >= BRAKE_DD_PCT) sf = Math.min(sf, BRAKE_SF);
            }
            const idealStake = bank * sf;
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
            if (evt.won) { bank += (shares - stake) - fee; cur = 0; if (bank > peak) peak = bank; }
            else { bank -= stake + fee; cur++; if (cur >= MCL) { cooldownUntil = virtualTime + COOLDOWN_MS; cur = 0; } }
            if (bank < MIN_SHARES * 0.5) {
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

const STRATEGY_DIR = 'strategies';
const allFiles = fs.readdirSync(STRATEGY_DIR)
    .filter(f => f.endsWith('.json') && f.startsWith('strategy_set_15m_'));

console.log(`\nOOS cycles (Apr 8-16): ${oos.length}`);
console.log(`Testing ${allFiles.length} strategy sets under live posture: SF=${BASE_STAKE_FRAC}, MCL=${MCL}, CS=${COOLDOWN_MS / 1000}s\n`);

const results = [];
for (const file of allFiles) {
    const name = file.replace('strategy_set_15m_', '').replace('.json', '');
    try {
        const strats = loadSet(file);
        if (strats.length === 0) continue;
        const events = buildFiringEvents(strats);
        if (events.length < 20) {
            console.log(`  [SKIP] ${name}: only ${events.length} events`);
            continue;
        }
        const days = [...new Set(events.map(e => new Date(e.timestamp * 1000).toISOString().slice(0, 10)))].sort();
        const evtPerDay = events.length / days.length;
        // $10 + $15 horizon tests
        const mc10_24h = mcSim(events, 10, 24);
        const mc10_7d = mcSim(events, 10, 168);
        const mc15_24h = mcSim(events, 15, 24);
        const mc15_7d = mcSim(events, 15, 168);
        const ftb10 = firstNBust(events, 10);
        const ftb15 = firstNBust(events, 15);
        results.push({
            name,
            strats: strats.length,
            events: events.length,
            evtPerDay: evtPerDay.toFixed(1),
            m10_24h_bust: mc10_24h.bust,
            m10_24h_med: mc10_24h.median,
            m10_7d_bust: mc10_7d.bust,
            m10_7d_p25: mc10_7d.p25,
            m10_7d_med: mc10_7d.median,
            m10_7d_p75: mc10_7d.p75,
            m10_7d_p95: mc10_7d.p95,
            m15_24h_bust: mc15_24h.bust,
            m15_24h_med: mc15_24h.median,
            m15_7d_bust: mc15_7d.bust,
            m15_7d_p25: mc15_7d.p25,
            m15_7d_med: mc15_7d.median,
            m15_7d_p75: mc15_7d.p75,
            m15_7d_p95: mc15_7d.p95,
            ftb10_5t: ftb10.b5,
            ftb15_5t: ftb15.b5
        });
    } catch (e) {
        console.error(`  [ERR] ${name}: ${e.message}`);
    }
}

results.sort((a, b) => b.m10_7d_med - a.m10_7d_med);
console.log('\n=== RANKED BY 7d MEDIAN @ $10 ===');
console.log('Set                              | evt/d | $10 24h_b | $10 24h_med | $10 7d_b | $10 7d_p25 | $10 7d_med | $10 7d_p75 | 5t_b10 | 5t_b15');
console.log('---------------------------------+-------+-----------+-------------+----------+------------+------------+------------+--------+--------');
for (const r of results) {
    const p = s => String(s).padStart(s.toString().length + (10 - s.toString().length > 0 ? 10 - s.toString().length : 0));
    console.log(
        `${r.name.padEnd(32)} | ${String(r.evtPerDay).padStart(5)} | ${r.m10_24h_bust.toFixed(1).padStart(7)}% | $${r.m10_24h_med.toFixed(2).padStart(9)} | ${r.m10_7d_bust.toFixed(1).padStart(6)}% | $${r.m10_7d_p25.toFixed(2).padStart(8)} | $${r.m10_7d_med.toFixed(2).padStart(8)} | $${r.m10_7d_p75.toFixed(2).padStart(8)} | ${r.ftb10_5t.padStart(5)}% | ${r.ftb15_5t.padStart(5)}%`
    );
}

// Also rank by 7d p25 (robust profit) to find best "max median with low bust"
results.sort((a, b) => b.m10_7d_p25 - a.m10_7d_p25);
console.log('\n=== RANKED BY 7d p25 @ $10 (robust profit floor) ===');
console.log('Set                              | 7d_p25  | 7d_med  | 7d_p75  | 7d_bust | 24h_bust | 5t_b10');
console.log('---------------------------------+---------+---------+---------+---------+----------+--------');
for (const r of results.slice(0, 10)) {
    console.log(
        `${r.name.padEnd(32)} | $${r.m10_7d_p25.toFixed(2).padStart(6)} | $${r.m10_7d_med.toFixed(2).padStart(6)} | $${r.m10_7d_p75.toFixed(2).padStart(6)} | ${r.m10_7d_bust.toFixed(1).padStart(6)}% | ${r.m10_24h_bust.toFixed(1).padStart(7)}% | ${r.ftb10_5t.padStart(5)}%`
    );
}

// $15 comparison for top 5 by $10 7d median
results.sort((a, b) => b.m10_7d_med - a.m10_7d_med);
console.log('\n=== TOP-5 @ $15 BANKROLL ===');
console.log('Set                              | 24h_b | 24h_med | 7d_p25  | 7d_med  | 7d_p75  | 7d_p95  | 7d_bust | 5t_bust');
console.log('---------------------------------+-------+---------+---------+---------+---------+---------+---------+--------');
for (const r of results.slice(0, 5)) {
    console.log(
        `${r.name.padEnd(32)} | ${r.m15_24h_bust.toFixed(1).padStart(4)}% | $${r.m15_24h_med.toFixed(2).padStart(6)} | $${r.m15_7d_p25.toFixed(2).padStart(6)} | $${r.m15_7d_med.toFixed(2).padStart(6)} | $${r.m15_7d_p75.toFixed(2).padStart(6)} | $${r.m15_7d_p95.toFixed(2).padStart(6)} | ${r.m15_7d_bust.toFixed(1).padStart(6)}% | ${r.ftb15_5t.padStart(5)}%`
    );
}
