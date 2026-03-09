/**
 * DEFINITIVE AUDIT v2 — Uses win rates directly from strategy files
 * For highfreq/top3/top7: uses OOS win rates from the strategy JSON
 * For top8/down5: uses validation WRs from final_results.json
 */
const fs = require('fs');
const path = require('path');

const RUNS = 200000;
const DAYS = 14;
const MIN_ORDER_SHARES = 5;
const TRAIN_DAYS = 90;
const MAX_ABS = 100;

function takerFee(shares, price) {
    const base = price * (1 - price);
    const fee = shares * 0.25 * Math.pow(base, 2);
    return fee < 0.0001 ? 0 : fee;
}

function tradePnl(stake, entryPrice, won) {
    const ep = Math.min(0.99, entryPrice * 1.01);
    const shares = stake / ep;
    const fee = takerFee(shares, ep);
    return won ? (shares - stake - fee) : (-stake - fee);
}

function loadSetWithOwnWR(filename) {
    const d = JSON.parse(fs.readFileSync(path.join(__dirname, filename), 'utf8'));
    return (d.strategies || []).map(s => {
        const bandMin = Number(s.priceMin ?? s.priceBand?.min);
        const bandMax = Number(s.priceMax ?? s.priceBand?.max);
        const avgEntry = (bandMin + bandMax) / 2;
        const wr = s.winRate || (s.oosWins && s.oosTrades ? s.oosWins / s.oosTrades : null);
        const trades = s.oosTrades || s.historicalTrades || 0;
        return {
            name: `H${s.utcHour}:m${s.entryMinute} ${s.direction}`,
            avgEntry,
            minCost: MIN_ORDER_SHARES * avgEntry,
            wr,
            trades,
            firesPerDay: trades / TRAIN_DAYS
        };
    }).filter(s => s.wr !== null && s.wr > 0);
}

function loadSetWithValWR(filename) {
    const d = JSON.parse(fs.readFileSync(path.join(__dirname, filename), 'utf8'));
    const results = JSON.parse(fs.readFileSync(path.join(__dirname, 'exhaustive_analysis', 'final_results.json'), 'utf8'));
    return (d.strategies || []).map(s => {
        const bandMin = Number(s.priceMin ?? s.priceBand?.min);
        const bandMax = Number(s.priceMax ?? s.priceBand?.max);
        const dir = String(s.direction).toUpperCase();
        const row = results.validatedStrategies.find(x =>
            Number(x.utcHour) === Number(s.utcHour) &&
            Number(x.entryMinute) === Number(s.entryMinute) &&
            String(x.direction).toUpperCase() === dir &&
            Number(x.priceBand?.min) === bandMin &&
            Number(x.priceBand?.max) === bandMax
        );
        if (!row) return null;
        const avgEntry = (bandMin + bandMax) / 2;
        return {
            name: `H${s.utcHour}:m${s.entryMinute} ${dir}`,
            avgEntry,
            minCost: MIN_ORDER_SHARES * avgEntry,
            wr: row.valWinRate,
            trades: row.trades,
            firesPerDay: row.trades / TRAIN_DAYS
        };
    }).filter(Boolean);
}

function sim(strats, startBal, stakeFrac, wrAdj = 0) {
    const cheapest = Math.min(...strats.map(s => s.minCost));
    let busts = 0;
    const ends = [];
    for (let r = 0; r < RUNS; r++) {
        let bal = startBal, dead = false;
        for (let day = 0; day < DAYS && !dead; day++) {
            for (const s of strats) {
                if (dead) break;
                let fires = Math.floor(s.firesPerDay);
                if (Math.random() < s.firesPerDay - fires) fires++;
                for (let f = 0; f < fires && !dead; f++) {
                    if (bal < s.minCost) { if (bal < cheapest) { dead = true; } continue; }
                    let stake = Math.max(bal * stakeFrac, s.minCost);
                    stake = Math.min(stake, bal, MAX_ABS);
                    const won = Math.random() < Math.max(0, Math.min(1, s.wr + wrAdj));
                    bal += tradePnl(stake, s.avgEntry, won);
                    if (bal < cheapest) dead = true;
                }
            }
        }
        if (dead) busts++;
        ends.push(Math.max(0, bal));
    }
    ends.sort((a, b) => a - b);
    const q = p => ends[Math.floor(ends.length * p)];
    return {
        bust: (busts / RUNS * 100).toFixed(2),
        med: q(0.5).toFixed(0),
        p25: q(0.25).toFixed(0),
        p75: q(0.75).toFixed(0),
        p100: (ends.filter(e => e >= 100).length / RUNS * 100).toFixed(1),
        p500: (ends.filter(e => e >= 500).length / RUNS * 100).toFixed(1),
        p1k: (ends.filter(e => e >= 1000).length / RUNS * 100).toFixed(1),
    };
}

const sets = {
    'highfreq_unique12': { strats: loadSetWithOwnWR('debug/strategy_set_highfreq_unique12.json'), wrSource: 'OOS from strategy file' },
    'top3_robust': { strats: loadSetWithOwnWR('debug/strategy_set_top3_robust.json'), wrSource: 'OOS from strategy file' },
    'top7_drop6': { strats: loadSetWithOwnWR('debug/strategy_set_top7_drop6.json'), wrSource: 'OOS from strategy file' },
    'top8_unique_golden': { strats: loadSetWithValWR('debug/strategy_set_top8_unique_golden.json'), wrSource: 'Validation from final_results.json' },
    'down5_golden': { strats: loadSetWithValWR('debug/strategy_set_down5_golden.json'), wrSource: 'Validation from final_results.json' },
};

console.log('╔════════════════════════════════════════════════════════════╗');
console.log('║  DEFINITIVE AUDIT v2 — CORRECT WIN RATES PER SET         ║');
console.log('║  200k runs, 14 days, 5-share min, 1% slippage, PM fees   ║');
console.log('╚════════════════════════════════════════════════════════════╝\n');

for (const [name, { strats, wrSource }] of Object.entries(sets)) {
    const totalFires = strats.reduce((s, x) => s + x.firesPerDay, 0);
    const compWR = strats.reduce((s, x) => s + x.wr * x.trades, 0) / strats.reduce((s, x) => s + x.trades, 0);
    console.log(`=== ${name} (${strats.length} strats, ${totalFires.toFixed(1)} fires/day, WR src: ${wrSource}) ===`);
    console.log(`  Composite WR: ${(compWR * 100).toFixed(1)}%`);
    strats.forEach(s => console.log(`  ${s.name.padEnd(18)} WR=${(s.wr * 100).toFixed(1)}% (${s.trades}t) Entry=$${s.avgEntry.toFixed(2)} MinOrd=$${s.minCost.toFixed(2)} F/D=${s.firesPerDay.toFixed(2)}`));
    console.log('');
}

console.log('=== SIMULATION RESULTS ===\n');
const fmt = (r) => `Bust:${r.bust.padStart(6)}% Med:$${r.med.padStart(7)} P25:$${r.p25.padStart(6)} P75:$${r.p75.padStart(7)} P$100:${r.p100.padStart(5)}% P$500:${r.p500.padStart(5)}% P$1k:${r.p1k.padStart(5)}%`;

for (const [name, { strats }] of Object.entries(sets)) {
    console.log(`--- ${name} ---`);
    for (const sb of [8, 10]) {
        for (const sf of [0.30, 0.45, 0.60]) {
            console.log(`  $${sb} ${(sf * 100)}%: ${fmt(sim(strats, sb, sf))}`);
        }
    }
    // Pessimistic
    const p8 = sim(strats, 8, 0.30, -0.05);
    const p10 = sim(strats, 10, 0.30, -0.05);
    console.log(`  PESSIMISTIC(-5pp) $8/30%: ${fmt(p8)}`);
    console.log(`  PESSIMISTIC(-5pp) $10/30%: ${fmt(p10)}`);
    console.log('');
}

// FINAL RECOMMENDATION
console.log('╔════════════════════════════════════════════════════════════╗');
console.log('║  FINAL RECOMMENDATION MATRIX                              ║');
console.log('╚════════════════════════════════════════════════════════════╝\n');

const candidates = ['highfreq_unique12', 'top7_drop6', 'down5_golden'];
for (const name of candidates) {
    const strats = sets[name].strats;
    console.log(`--- ${name} @ $8 ---`);
    for (const sf of [0.30, 0.45, 0.60]) {
        const r = sim(strats, 8, sf);
        const rp = sim(strats, 8, sf, -0.05);
        console.log(`  ${(sf*100)}% base: ${fmt(r)}`);
        console.log(`  ${(sf*100)}% pess: ${fmt(rp)}`);
    }
    console.log('');
}
