#!/usr/bin/env node
// V5 FINAL OPTIMIZATION: full runtime-parity including Kelly cap, peak-drawdown brake,
// and micro-bankroll min-order clamp. Evaluate configs on Apr 8-16 OOS data.
const fs = require('fs');

const DATA = JSON.parse(fs.readFileSync('data/intracycle-price-data.json', 'utf8'));
const cycles = Array.isArray(DATA) ? DATA : (DATA.cycles || []);
const OOS_START = Math.floor(new Date('2026-04-08T00:00:00Z').getTime() / 1000);
const oos = cycles.filter(c => (c.epoch || 0) >= OOS_START && (c.resolution === 'UP' || c.resolution === 'DOWN'));

const FEE = 0.0315;
const MIN_SHARES = 5;
const ASSET_RANK = { BTC: 0, ETH: 1, SOL: 2, XRP: 3 };
const KELLY_FRACTION = 0.35;
const KELLY_MAX_FRACTION = 0.45;
const KELLY_MIN_P_WIN = 0.55;
const SLIPPAGE_PCT = 0.01;
const PEAK_DD_BRAKE_MIN = 20;
const PEAK_DD_BRAKE_PCT = 0.20;
const PEAK_DD_BRAKE_SF = 0.12;

const v5 = JSON.parse(fs.readFileSync('strategies/strategy_set_15m_optimal_10usd_v5.json', 'utf8'));

function normalize(s) {
    return {
        ...s,
        priceMin: Number(s.priceMin || s.priceBandLow || 0),
        priceMax: Number(s.priceMax || s.priceBandHigh || 1),
        utcHour: Number(s.utcHour),
        entryMinute: Number(s.entryMinute),
        direction: String(s.direction || '').toUpperCase(),
        pWin: Number(s.pWinEstimate || s.winRateLCB || s.winRate || 0.5)
    };
}

function buildEvents(strats, priceMaxCap = 1.0) {
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
            const effMax = Math.min(s.priceMax, priceMaxCap);
            if (entryPrice < s.priceMin || entryPrice > effMax) continue;
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

// FULL runtime-parity sizer
function runtimeStake(bank, peak, entryPrice, pWin, configSF) {
    // Peak drawdown brake
    let sf = configSF;
    if (peak > PEAK_DD_BRAKE_MIN) {
        const dd = (peak - bank) / peak;
        if (dd >= PEAK_DD_BRAKE_PCT) {
            sf = Math.min(sf, PEAK_DD_BRAKE_SF);
        }
    }
    let size = bank * sf;

    // Kelly cap (only reduces size)
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

    // Cap at stake fraction (noop after Kelly since Kelly only reduces)
    const maxSize = bank * sf;
    if (size > maxSize) size = maxSize;

    // Min order enforcement
    const minOrderCost = MIN_SHARES * entryPrice;
    if (size < minOrderCost) {
        if (bank >= minOrderCost) size = minOrderCost;
        else return { size: 0, blocked: true };
    }

    // Available cash cap
    if (size > bank) size = bank;
    return { size, blocked: false };
}

function mcSim(events, startBank, horizonHours, configSF, runs = 10000, maxConsecLoss = 999, cooldownSec = 0) {
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

function replay(events, configSF, startBank = 10, maxConsecLoss = 999, cooldownSec = 0) {
    let bank = startBank, peak = startBank, maxDD = 0, mcl = 0, cur = 0, trades = 0, wins = 0, losses = 0;
    let consec = 0, cooldownUntil = 0;
    for (const e of events) {
        if (e.timestamp < cooldownUntil) continue;
        const { size, blocked } = runtimeStake(bank, peak, e.entryPrice, e.pWin, configSF);
        if (blocked) break;
        const shares = size / e.entryPrice;
        const fee = size * FEE;
        if (e.won) { bank += (shares - size) - fee; cur = 0; consec = 0; wins++; }
        else {
            bank -= size + fee;
            cur++; if (cur > mcl) mcl = cur; losses++;
            consec++;
            if (consec >= maxConsecLoss) { cooldownUntil = e.timestamp + cooldownSec; consec = 0; }
        }
        trades++;
        if (bank > peak) peak = bank;
        const dd = (peak - bank) / peak;
        if (dd > maxDD) maxDD = dd;
    }
    return { trades, wins, losses, wr: trades ? wins / trades : 0, final: bank, peak, maxDD, mcl };
}

function test(label, strats, { stakeFrac, maxConsecLoss = 999, cooldownSec = 0, priceMaxCap = 1.0 } = {}) {
    const events = buildEvents(strats, priceMaxCap);
    if (events.length === 0) { console.log(`${label}: NO EVENTS`); return null; }
    const days = [...new Set(events.map(e => new Date(e.timestamp * 1000).toISOString().slice(0, 10)))].sort();
    const rep = replay(events, stakeFrac, 10, maxConsecLoss, cooldownSec);
    const r24 = mcSim(events, 10, 24, stakeFrac, 10000, maxConsecLoss, cooldownSec);
    const r48 = mcSim(events, 10, 48, stakeFrac, 10000, maxConsecLoss, cooldownSec);
    const r72 = mcSim(events, 10, 72, stakeFrac, 10000, maxConsecLoss, cooldownSec);
    const r7d = mcSim(events, 10, 168, stakeFrac, 10000, maxConsecLoss, cooldownSec);
    console.log(`\n${label} | ${strats.length} strats | ${events.length} events/${days.length}d=${(events.length / days.length).toFixed(1)}/d | SF=${stakeFrac} MCL=${maxConsecLoss} CD=${cooldownSec}s priceMaxCap=${priceMaxCap}`);
    console.log(`  Replay: t=${rep.trades} WR=${(rep.wr * 100).toFixed(1)}% final=$${rep.final.toFixed(2)} peak=$${rep.peak.toFixed(2)} MCL=${rep.mcl} maxDD=${(rep.maxDD * 100).toFixed(1)}%`);
    console.log(`  24h: bust=${r24.bust.toFixed(1)}% p10=$${r24.p10.toFixed(2)} p25=$${r24.p25.toFixed(2)} MED=$${r24.median.toFixed(2)} p75=$${r24.p75.toFixed(2)} p90=$${r24.p90.toFixed(2)} medDD=${r24.medianDD.toFixed(0)}%`);
    console.log(`  48h: bust=${r48.bust.toFixed(1)}% p10=$${r48.p10.toFixed(2)} p25=$${r48.p25.toFixed(2)} MED=$${r48.median.toFixed(2)} p75=$${r48.p75.toFixed(2)} p90=$${r48.p90.toFixed(2)}`);
    console.log(`  72h: bust=${r72.bust.toFixed(1)}% p25=$${r72.p25.toFixed(2)} MED=$${r72.median.toFixed(2)} p75=$${r72.p75.toFixed(2)} p90=$${r72.p90.toFixed(2)}`);
    console.log(`  7d:  bust=${r7d.bust.toFixed(1)}% p25=$${r7d.p25.toFixed(2)} MED=$${r7d.median.toFixed(2)} p75=$${r7d.p75.toFixed(2)} p90=$${r7d.p90.toFixed(2)} p95=$${r7d.p95.toFixed(2)}`);
    return { label, strats: strats.length, events: events.length, rep, r24, r48, r72, r7d };
}

const baseAll = v5.strategies.map(normalize);

console.log('\nV5 strategies breakdown:');
console.log(`  Total: ${baseAll.length}`);
console.log(`  priceMax >=0.98: ${baseAll.filter(s => s.priceMax >= 0.98).length}`);
console.log(`  priceMax  =0.95: ${baseAll.filter(s => s.priceMax === 0.95).length}`);
console.log(`  priceMin <=0.60: ${baseAll.filter(s => s.priceMin <= 0.60).length}`);

const results = [];

// Current live config (baseline)
results.push(test('BASELINE_SF15', baseAll, { stakeFrac: 0.15 }));
// Recommended winner candidates
results.push(test('REC_SF20', baseAll, { stakeFrac: 0.20 }));
results.push(test('REC_SF20_CD3x30m', baseAll, { stakeFrac: 0.20, maxConsecLoss: 3, cooldownSec: 1800 }));
results.push(test('REC_SF20_CD3x60m', baseAll, { stakeFrac: 0.20, maxConsecLoss: 3, cooldownSec: 3600 }));
results.push(test('REC_SF25', baseAll, { stakeFrac: 0.25 }));
results.push(test('REC_SF25_CD3x60m', baseAll, { stakeFrac: 0.25, maxConsecLoss: 3, cooldownSec: 3600 }));
results.push(test('REC_SF30', baseAll, { stakeFrac: 0.30 }));
results.push(test('REC_SF30_CD3x60m', baseAll, { stakeFrac: 0.30, maxConsecLoss: 3, cooldownSec: 3600 }));

// 0.92 priceMax cap (prune 98c tail)
results.push(test('CAP092_SF20', baseAll, { stakeFrac: 0.20, priceMaxCap: 0.92 }));
results.push(test('CAP092_SF25_CD3x60m', baseAll, { stakeFrac: 0.25, maxConsecLoss: 3, cooldownSec: 3600, priceMaxCap: 0.92 }));
results.push(test('CAP090_SF25_CD3x60m', baseAll, { stakeFrac: 0.25, maxConsecLoss: 3, cooldownSec: 3600, priceMaxCap: 0.90 }));

console.log('\n\n================ FINAL PICK ANALYSIS (sorted by 7d-p25) ================');
const valid = results.filter(Boolean);
valid.sort((a, b) => b.r7d.p25 - a.r7d.p25);
console.log('Variant                    | 24h bust| 24h MED | 48h MED | 7d bust | 7d p25   | 7d MED   | 7d p75   | 7d p95');
console.log('---------------------------+---------+---------+---------+---------+----------+----------+----------+---------');
for (const r of valid) {
    console.log(`${r.label.padEnd(26)} | ${r.r24.bust.toFixed(1).padStart(6)}% | $${r.r24.median.toFixed(2).padStart(7)} | $${r.r48.median.toFixed(2).padStart(7)} | ${r.r7d.bust.toFixed(1).padStart(6)}% | $${r.r7d.p25.toFixed(2).padStart(7)} | $${r.r7d.median.toFixed(2).padStart(8)} | $${r.r7d.p75.toFixed(2).padStart(8)} | $${r.r7d.p95.toFixed(2).padStart(7)}`);
}
