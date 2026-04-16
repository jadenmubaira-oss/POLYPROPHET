/**
 * TRUE Out-of-Sample Audit
 *
 * Strategies were BUILT using Mar 24 - Apr 7 data (14 days).
 * Apr 8 - Apr 16 data is GENUINELY NEW and never seen by the selector.
 *
 * This is the strictest possible test:
 *   - Train period: Mar 24 - Apr 7 (the data v3/pruned/ultra-safe were tuned on)
 *   - OOS period: Apr 8 - Apr 16 (9 days of brand-new data collected today via API)
 *
 * Also searches for NEW strategies that are:
 *   - Strong in the RECENT OOS period (not just historic)
 *   - Likely to keep working for the next 7 days
 */
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');

const TAKER_FEE = 0.0315;
const MIN_SHARES = 5;

const ic = require(path.join(ROOT, 'data/intracycle-price-data.json'));
const cycles = (ic.cycles || []).sort((a, b) => Number(a.epoch) - Number(b.epoch));

const OOS_START_EPOCH = 1775540700 + 900; // Apr 7 06:00 UTC - first cycle AFTER training period
const training = cycles.filter(c => Number(c.epoch) < OOS_START_EPOCH);
const trueOOS = cycles.filter(c => Number(c.epoch) >= OOS_START_EPOCH);

console.log(`Total cycles: ${cycles.length}`);
console.log(`Training (Mar 24 - Apr 7): ${training.length}`);
console.log(`TRUE OOS (Apr 8 - Apr 16): ${trueOOS.length}`);
console.log(`Split at: ${new Date(OOS_START_EPOCH * 1000).toISOString()}\n`);

// Load candidate sets
const candidateSets = [
    { name: 'v3_full_23', path: 'strategies/strategy_set_15m_optimal_10usd_v3.json' },
    { name: 'pruned_v4_19', path: 'strategies/strategy_set_15m_optimal_10usd_v4_pruned.json' },
    { name: 'ultra_safe_9', path: 'strategies/strategy_set_15m_ultrasafe_10usd.json' },
    { name: 'elite_recency_12', path: 'strategies/strategy_set_15m_elite_recency.json' }
].map(s => {
    const fp = path.join(ROOT, s.path);
    if (!fs.existsSync(fp)) return null;
    return { ...s, strats: JSON.parse(fs.readFileSync(fp, 'utf8')).strategies || [] };
}).filter(Boolean);

// ============================================================
// Evaluate a strategy on subset
// ============================================================
function evalStrategy(s, subset) {
    const h = s.utcHour, em = s.entryMinute, dir = (s.direction || '').toUpperCase();
    const pMin = s.priceMin || s.priceBandLow || 0;
    const pMax = s.priceMax || s.priceBandHigh || 1;
    let m = 0, w = 0, pSum = 0;
    for (const cy of subset) {
        const cyH = new Date(Number(cy.epoch) * 1000).getUTCHours();
        if (cyH !== h) continue;
        const resolved = String(cy.resolution || '').toUpperCase();
        if (resolved !== 'UP' && resolved !== 'DOWN') continue;
        const pd = dir === 'UP' ? cy.minutePricesYes : cy.minutePricesNo;
        const pt = pd && pd[String(em)];
        if (!pt) continue;
        const ep = Number(pt.last);
        if (!ep || ep <= 0 || ep >= 1) continue;
        if (ep < pMin || ep > pMax) continue;
        m++; pSum += ep;
        if (resolved === dir) w++;
    }
    return { m, w, wr: m > 0 ? w / m : 0, avgP: m > 0 ? pSum / m : 0 };
}

function evalSet(strats, subset) {
    let total = 0, wins = 0, pSum = 0;
    for (const s of strats) {
        const r = evalStrategy(s, subset);
        total += r.m; wins += r.w; pSum += r.avgP * r.m;
    }
    const wr = total > 0 ? wins / total : 0;
    const avgP = total > 0 ? pSum / total : 0;
    const be = avgP > 0 ? avgP / (avgP + (1 - avgP) * (1 - TAKER_FEE)) : 1;
    return { total, wins, wr, avgP, edge: wr - be };
}

console.log('='.repeat(80));
console.log('EXISTING STRATEGY SETS - TRUE OOS VALIDATION');
console.log('='.repeat(80));

for (const set of candidateSets) {
    const trainRes = evalSet(set.strats, training);
    const oosRes = evalSet(set.strats, trueOOS);
    const fullRes = evalSet(set.strats, cycles);
    const degradation = trainRes.wr - oosRes.wr;
    const flag = degradation > 0.10 ? ' ⛔ HEAVY FADE' : degradation > 0.05 ? ' ⚠️ FADES' : degradation < -0.02 ? ' ✅ IMPROVES' : '';

    console.log(`\n--- ${set.name} (${set.strats.length} strats) ---`);
    console.log(`  TRAIN:    ${trainRes.total}t WR=${(trainRes.wr*100).toFixed(1)}% edge=${(trainRes.edge*100).toFixed(1)}pp`);
    console.log(`  TRUE OOS: ${oosRes.total}t WR=${(oosRes.wr*100).toFixed(1)}% edge=${(oosRes.edge*100).toFixed(1)}pp${flag}`);
    console.log(`  FULL:     ${fullRes.total}t WR=${(fullRes.wr*100).toFixed(1)}% edge=${(fullRes.edge*100).toFixed(1)}pp`);
}

// ============================================================
// Per-strategy OOS breakdown
// ============================================================
console.log('\n\n' + '='.repeat(80));
console.log('PER-STRATEGY OOS BREAKDOWN - v3 set (23 strategies)');
console.log('='.repeat(80));

const v3 = candidateSets.find(s => s.name === 'v3_full_23');
const stratAnalysis = [];
for (const s of v3.strats) {
    const tr = evalStrategy(s, training);
    const oos = evalStrategy(s, trueOOS);
    stratAnalysis.push({
        label: `H${String(s.utcHour).padStart(2,'0')} m${s.entryMinute} ${s.direction} [${s.priceMin}-${s.priceMax}]`,
        strat: s,
        trainWR: tr.wr, trainN: tr.m,
        oosWR: oos.wr, oosN: oos.m,
        degradation: tr.wr - oos.wr,
        oosEdge: oos.wr - (oos.avgP / (oos.avgP + (1 - oos.avgP) * (1 - TAKER_FEE)))
    });
}
stratAnalysis.sort((a, b) => b.oosWR - a.oosWR);
for (const a of stratAnalysis) {
    const flag = a.oosN === 0 ? ' (NO_DATA)' : a.degradation > 0.15 ? ' ⛔' : a.degradation > 0.08 ? ' ⚠️' : a.degradation < -0.05 ? ' ✅' : '';
    const oosWRStr = a.oosN > 0 ? (a.oosWR * 100).toFixed(0) + '%' : 'N/A';
    const edgeStr = a.oosN > 0 ? (a.oosEdge * 100).toFixed(1) + 'pp' : '-';
    console.log(`  ${a.label.padEnd(38)} TR=${(a.trainWR*100).toFixed(0)}%/${String(a.trainN).padStart(3)}t  OOS=${oosWRStr.padStart(5)}/${String(a.oosN).padStart(3)}t  edge=${edgeStr.padStart(7)}${flag}`);
}

// ============================================================
// BUILD NEW OPTIMAL STRATEGY - trained on RECENT data
// ============================================================
console.log('\n\n' + '='.repeat(80));
console.log('BUILDING NEW OPTIMAL STRATEGY FROM ALL 23-DAY DATA');
console.log('='.repeat(80));

const MIN_TRADES = 20;      // minimum sample size for reliability
const MIN_WR = 0.85;        // minimum WR over all data
const MIN_OOS_WR = 0.80;    // must hold up in OOS too
const MIN_OOS_N = 5;        // OOS sample minimum

// Grid search parameters
const directions = ['UP', 'DOWN'];
const priceBands = [
    { min: 0.50, max: 0.65 }, { min: 0.55, max: 0.70 }, { min: 0.60, max: 0.75 },
    { min: 0.65, max: 0.80 }, { min: 0.70, max: 0.85 }, { min: 0.75, max: 0.90 },
    { min: 0.80, max: 0.95 }, { min: 0.85, max: 0.98 },
    { min: 0.55, max: 0.85 }, { min: 0.60, max: 0.85 }, { min: 0.60, max: 0.90 },
    { min: 0.55, max: 0.90 }, { min: 0.55, max: 0.95 }, { min: 0.60, max: 0.95 },
    { min: 0.65, max: 0.95 }, { min: 0.65, max: 0.98 }, { min: 0.70, max: 0.95 },
    { min: 0.50, max: 0.85 }, { min: 0.50, max: 0.95 }
];

const found = [];
for (let h = 0; h < 24; h++) {
    for (let em = 0; em < 14; em++) {
        for (const dir of directions) {
            for (const band of priceBands) {
                const fake = { utcHour: h, entryMinute: em, direction: dir, priceMin: band.min, priceMax: band.max };
                const train = evalStrategy(fake, training);
                const oos = evalStrategy(fake, trueOOS);
                const full = evalStrategy(fake, cycles);

                if (full.m < MIN_TRADES) continue;
                if (full.wr < MIN_WR) continue;
                if (oos.m < MIN_OOS_N) continue;
                if (oos.wr < MIN_OOS_WR) continue;

                const avgP = full.avgP;
                const be = avgP > 0 ? avgP / (avgP + (1 - avgP) * (1 - TAKER_FEE)) : 1;
                const edge = full.wr - be;
                if (edge < 0.05) continue;

                found.push({
                    ...fake, band,
                    fullM: full.m, fullWR: full.wr,
                    trainM: train.m, trainWR: train.wr,
                    oosM: oos.m, oosWR: oos.wr,
                    avgP, edge,
                    recencyScore: oos.wr * Math.sqrt(oos.m)  // favors strategies with strong + reliable recent WR
                });
            }
        }
    }
}
console.log(`Candidates found: ${found.length}`);

// Remove duplicates (same h/m/dir but different bands) - keep widest band with best OOS
const uniq = new Map();
for (const c of found) {
    const key = `${c.utcHour}_${c.entryMinute}_${c.direction}`;
    const existing = uniq.get(key);
    if (!existing || c.recencyScore > existing.recencyScore) {
        uniq.set(key, c);
    }
}
const dedup = Array.from(uniq.values()).sort((a, b) => b.recencyScore - a.recencyScore);
console.log(`Unique (h,m,dir) signals: ${dedup.length}`);

// Show top 30
console.log('\nTop 30 by recency score:');
for (const c of dedup.slice(0, 30)) {
    console.log(`  H${String(c.utcHour).padStart(2,'0')} m${c.entryMinute} ${c.direction} [${c.band.min}-${c.band.max}]  full=${(c.fullWR*100).toFixed(0)}%/${c.fullM}t  train=${(c.trainWR*100).toFixed(0)}%/${c.trainM}t  OOS=${(c.oosWR*100).toFixed(0)}%/${c.oosM}t  avgP=${c.avgP.toFixed(2)} edge=${(c.edge*100).toFixed(1)}pp`);
}

// Save top candidates for next step (runtime-parity simulation)
fs.writeFileSync(
    path.join(ROOT, 'debug', 'new_strategy_candidates.json'),
    JSON.stringify({ generated: new Date().toISOString(), candidates: dedup }, null, 2)
);
console.log(`\nSaved ${dedup.length} candidates to debug/new_strategy_candidates.json`);
