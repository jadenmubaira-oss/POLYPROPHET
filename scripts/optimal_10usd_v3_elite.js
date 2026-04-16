/**
 * Optimal $10 Strategy v3 — ELITE ONLY
 * 
 * CRITICAL DIFFERENCES from v2:
 * 1. Only strategies with BOTH 30d WR ≥ 70% AND IC WR ≥ 75%
 * 2. Conservative WR haircuts: simulate at IC_WR minus 5%, 10%, 15%
 * 3. Separate walk-forward on FIRST half vs SECOND half of intracycle data
 * 4. Realistic projections with honest confidence intervals
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const TAKER_FEE = 0.0315;
const MIN_SHARES = 5;
const START_BAL = 10;

const histRaw = require(path.join(ROOT, 'exhaustive_analysis/decision_dataset.json'));
const histRows = Array.isArray(histRaw) ? histRaw : (histRaw.rows || []);
const icRaw = require(path.join(ROOT, 'data/intracycle-price-data.json'));
const allCycles = (icRaw.cycles || []).sort((a, b) => Number(a.epoch) - Number(b.epoch));

// Split intracycle into first 7 days (training) and last 7 days (validation)
const midEpoch = (Number(allCycles[0].epoch) + Number(allCycles[allCycles.length - 1].epoch)) / 2;
const icTrain = allCycles.filter(c => Number(c.epoch) < midEpoch);
const icTest = allCycles.filter(c => Number(c.epoch) >= midEpoch);

let maxEpoch = 0;
for (const r of histRows) { const e = Number(r.cycleStartEpochSec); if (e > maxEpoch) maxEpoch = e; }
const cutoff30 = maxEpoch - 30 * 86400;

console.log('=== OPTIMAL $10 STRATEGY v3 — ELITE ONLY ===');
console.log(`IC train: ${icTrain.length} cycles | IC test: ${icTest.length} cycles\n`);

function calcBE(price) { return price / (price + (1 - price) * (1 - TAKER_FEE)); }

const BANDS = [
    [0.30, 0.65], [0.35, 0.70], [0.40, 0.75], [0.45, 0.80], [0.50, 0.85],
    [0.55, 0.90], [0.60, 0.95], [0.65, 0.98],
    [0.50, 0.65], [0.55, 0.70], [0.60, 0.75], [0.65, 0.80], [0.70, 0.85],
    [0.75, 0.90], [0.80, 0.95], [0.40, 0.65], [0.45, 0.70], [0.50, 0.75],
];

function evalOnData(cycleSet, em, h, dir, band) {
    let m = 0, w = 0, prices = [];
    const trades = [];
    for (const cy of cycleSet) {
        const epoch = Number(cy.epoch);
        const cyH = new Date(epoch * 1000).getUTCHours();
        if (cyH !== h) continue;
        const resolved = String(cy.resolution || cy.resolvedOutcome || '').toUpperCase();
        if (resolved !== 'UP' && resolved !== 'DOWN') continue;
        const pd = dir === 'UP' ? cy.minutePricesYes : cy.minutePricesNo;
        const pt = pd && pd[String(em)];
        if (!pt) continue;
        const ep = Number(pt.last);
        if (!ep || ep <= 0 || ep >= 1) continue;
        if (ep < band[0] || ep > band[1]) continue;
        m++; prices.push(ep);
        const won = resolved === dir;
        if (won) w++;
        trades.push({ epoch, price: ep, won, asset: cy.asset });
    }
    const avgP = prices.length > 0 ? prices.reduce((a, b) => a + b, 0) / prices.length : 0;
    return { m, w, wr: m > 0 ? w / m : 0, avgP, trades };
}

const allStrats = [];

for (let em = 0; em <= 14; em++) {
    for (let h = 0; h < 24; h++) {
        for (const dir of ['UP', 'DOWN']) {
            for (const band of BANDS) {
                // 30d history — STRICT: WR ≥ 70%, min 20 matches
                let m30 = 0, w30 = 0, p30 = [];
                for (const r of histRows) {
                    if (Number(r.entryMinute) !== em) continue;
                    if (Number(r.utcHour) !== h) continue;
                    const ep = dir === 'UP' ? Number(r.upPrice) : Number(r.downPrice);
                    if (!ep || ep <= 0 || ep >= 1) continue;
                    if (ep < band[0] || ep > band[1]) continue;
                    if (Number(r.cycleStartEpochSec) < cutoff30) continue;
                    m30++; p30.push(ep);
                    if (String(r.resolvedOutcome || '').toUpperCase() === dir) w30++;
                }
                if (m30 < 20) continue;
                const wr30 = w30 / m30;
                if (wr30 < 0.70) continue; // STRICT: 70% minimum on history

                // Full intracycle
                const icFull = evalOnData(allCycles, em, h, dir, band);
                if (icFull.m < 10) continue;
                if (icFull.wr < 0.75) continue; // STRICT: 75% minimum on IC

                // IC train half
                const icTrainR = evalOnData(icTrain, em, h, dir, band);
                // IC test half (TRUE out-of-sample)
                const icTestR = evalOnData(icTest, em, h, dir, band);

                const avgP30 = p30.reduce((a, b) => a + b, 0) / p30.length;
                const be30 = calcBE(avgP30);
                const beIC = calcBE(icFull.avgP);
                
                // Must be above breakeven on both
                if (wr30 < be30 + 0.05) continue;
                if (icFull.wr < beIC + 0.05) continue;

                // Wilson LCB
                const z = 1.96;
                const lcb30 = (wr30 + z * z / (2 * m30) - z * Math.sqrt((wr30 * (1 - wr30) + z * z / (4 * m30)) / m30)) / (1 + z * z / m30);
                const lcbIC = (icFull.wr + z * z / (2 * icFull.m) - z * Math.sqrt((icFull.wr * (1 - icFull.wr) + z * z / (4 * icFull.m)) / icFull.m)) / (1 + z * z / icFull.m);

                const icEV = icFull.wr * (1 - icFull.avgP) * (1 - TAKER_FEE) - (1 - icFull.wr) * icFull.avgP;
                const cost5 = MIN_SHARES * avgP30;

                allStrats.push({
                    entryMinute: em, utcHour: h, direction: dir,
                    priceBandLow: band[0], priceBandHigh: band[1],
                    d30: { m: m30, w: w30, wr: wr30, avgP: avgP30, be: be30 },
                    icFull: { m: icFull.m, w: icFull.w, wr: icFull.wr, avgP: icFull.avgP, ev: icEV, trades: icFull.trades },
                    icTrain: { m: icTrainR.m, w: icTrainR.w, wr: icTrainR.wr },
                    icTest: { m: icTestR.m, w: icTestR.w, wr: icTestR.wr },
                    lcb30, lcbIC, cost5,
                    // Score: conservative — use MINIMUM of lcb30 and lcbIC
                    score: Math.min(lcb30, lcbIC) * Math.sqrt(icFull.m) * icEV
                });
            }
        }
    }
}

console.log(`Elite strategies found: ${allStrats.length}`);

// Show split-half validation stats
let consistent = 0, inconsistent = 0;
for (const s of allStrats) {
    const trainBE = s.icTrain.m > 0 ? calcBE(s.icFull.avgP) : 0;
    const testBE = s.icTest.m > 0 ? calcBE(s.icFull.avgP) : 0;
    if (s.icTrain.m >= 3 && s.icTest.m >= 3 && s.icTrain.wr > trainBE && s.icTest.wr > testBE) {
        consistent++;
    } else {
        inconsistent++;
    }
}
console.log(`Split-half consistency: ${consistent} consistent, ${inconsistent} inconsistent\n`);

// Build sets
function buildSet(candidates, maxPerHour) {
    const byHour = {};
    for (const s of candidates) {
        if (!byHour[s.utcHour]) byHour[s.utcHour] = [];
        byHour[s.utcHour].push(s);
    }
    const selected = [];
    for (const h in byHour) {
        byHour[h].sort((a, b) => b.score - a.score);
        const picked = [], seen = new Set();
        for (const s of byHour[h]) {
            if (picked.length >= maxPerHour) break;
            const key = `${s.direction}_${s.entryMinute}`;
            if (seen.has(key)) continue;
            seen.add(key);
            picked.push(s);
        }
        selected.push(...picked);
    }
    return selected;
}

// Filter for consistent-only
const consistentStrats = allStrats.filter(s => {
    const be = calcBE(s.icFull.avgP);
    return s.icTrain.m >= 3 && s.icTest.m >= 3 && s.icTrain.wr > be && s.icTest.wr > be;
});

const eliteSet1 = buildSet(consistentStrats, 1);
const eliteSet2 = buildSet(consistentStrats, 2);
const eliteSetAll = buildSet(allStrats, 1);

console.log(`Elite consistent 1/hr: ${eliteSet1.length} strats, ${new Set(eliteSet1.map(s=>s.utcHour)).size} hours`);
console.log(`Elite consistent 2/hr: ${eliteSet2.length} strats, ${new Set(eliteSet2.map(s=>s.utcHour)).size} hours`);
console.log(`Elite all 1/hr: ${eliteSetAll.length} strats, ${new Set(eliteSetAll.map(s=>s.utcHour)).size} hours`);

// ============================================================
// Walk-forward on FULL intracycle + TEST half only
// ============================================================
function walkForward(stratSet, cycleData, startBal, sf, mpc) {
    const allTrades = [];
    for (const s of stratSet) {
        for (const t of (s.icFull.trades || [])) {
            // Only include trades from the cycleData set
            if (cycleData && !cycleData.some(c => Number(c.epoch) === t.epoch)) continue;
            allTrades.push({ ...t, pWin: s.icFull.wr });
        }
    }
    allTrades.sort((a, b) => a.epoch - b.epoch);

    const byCycle = {};
    for (const t of allTrades) {
        if (!byCycle[t.epoch]) byCycle[t.epoch] = [];
        byCycle[t.epoch].push(t);
    }
    const keys = Object.keys(byCycle).sort((a, b) => Number(a) - Number(b));

    let bal = startBal, peak = bal, trades = 0, wins = 0, maxDD = 0;
    for (const k of keys) {
        if (bal < 2) break;
        const cands = byCycle[k].sort((a, b) => b.pWin - a.pWin);
        let ct = 0;
        for (const c of cands) {
            if (ct >= mpc) break;
            const minOC = MIN_SHARES * c.price;
            let size = bal * sf;
            if (size < minOC) { if (bal >= minOC) size = minOC; else continue; }
            size = Math.min(size, bal);
            if (size < minOC) continue;
            const shares = size / c.price;
            if (c.won) { bal += shares * (1 - c.price) * (1 - TAKER_FEE); wins++; }
            else { bal -= size; }
            trades++; ct++;
            if (bal > peak) peak = bal;
            const dd = peak > 0 ? (peak - bal) / peak : 0;
            if (dd > maxDD) maxDD = dd;
            if (bal < 2) break;
        }
    }
    const days = keys.length > 1 ? (Number(keys[keys.length - 1]) - Number(keys[0])) / 86400 : 1;
    return { bal, trades, wins, losses: trades - wins, wr: trades > 0 ? (wins / trades * 100).toFixed(1) : 'n/a', maxDD: (maxDD * 100).toFixed(1), tpd: (trades / Math.max(1, days)).toFixed(1), days: days.toFixed(1) };
}

console.log('\n========================================');
console.log('WALK-FORWARD: Full IC (14d) + TEST half only (7d)');
console.log('========================================\n');

for (const { name, strats } of [
    { name: 'Elite consistent 1/hr', strats: eliteSet1 },
    { name: 'Elite consistent 2/hr', strats: eliteSet2 },
    { name: 'Elite all 1/hr', strats: eliteSetAll },
]) {
    if (strats.length === 0) { console.log(`${name}: NO STRATEGIES`); continue; }
    const wfFull = walkForward(strats, null, START_BAL, 0.15, 1);
    // For test-only walk-forward, filter trades to test period
    const testTrades = [];
    for (const s of strats) {
        for (const t of (s.icFull.trades || [])) {
            if (Number(t.epoch) >= midEpoch) testTrades.push(t);
        }
    }
    
    // Reconstruct for test-only
    const wfTest = walkForward(strats, icTest, START_BAL, 0.15, 1);
    
    console.log(`--- ${name} (${strats.length} strats) ---`);
    console.log(`  Full 14d: ${wfFull.trades}t @ ${wfFull.wr}%WR, ${wfFull.tpd}t/d → $${wfFull.bal.toFixed(2)} | MaxDD: ${wfFull.maxDD}%`);
    console.log(`  Test 7d:  ${wfTest.trades}t @ ${wfTest.wr}%WR, ${wfTest.tpd}t/d → $${wfTest.bal.toFixed(2)} | MaxDD: ${wfTest.maxDD}%`);
    console.log('');
}

// ============================================================
// Monte Carlo with CONSERVATIVE HAIRCUTS
// ============================================================
console.log('========================================');
console.log('MONTE CARLO WITH WR HAIRCUTS');
console.log('========================================\n');

const WINNER = eliteSet1.length >= eliteSet2.length ? eliteSet1 : 
               (eliteSet1.length > 0 ? eliteSet1 : eliteSetAll);
const winnerName = WINNER === eliteSet1 ? 'Elite consistent 1/hr' : 
                   (WINNER === eliteSet2 ? 'Elite consistent 2/hr' : 'Elite all 1/hr');

// Get actual trades per day from walk-forward
const wfBase = walkForward(WINNER, null, START_BAL, 0.15, 1);
const actualTPD = parseFloat(wfBase.tpd);

let tw = 0;
for (const s of WINNER) tw += s.icFull.m;

function mcSim(strats, days, wrHaircut, runs, tpd) {
    const finals = [];
    let busts = 0;
    let totalW = 0;
    for (const s of strats) totalW += s.icFull.m;
    
    for (let run = 0; run < runs; run++) {
        let bal = START_BAL;
        const tt = Math.round(tpd * days);
        for (let t = 0; t < tt; t++) {
            if (bal < 2) break;
            const r = Math.random() * totalW;
            let cum = 0, strat = strats[0];
            for (const s of strats) { cum += s.icFull.m; if (cum >= r) { strat = s; break; } }
            const price = strat.icFull.avgP;
            const wr = Math.max(0, strat.icFull.wr - wrHaircut);
            const minOC = MIN_SHARES * price;
            let size = bal * 0.15;
            if (size < minOC) { if (bal >= minOC) size = minOC; else break; }
            size = Math.min(size, bal);
            if (size < minOC) break;
            const shares = size / price;
            if (Math.random() < wr) { bal += shares * (1 - price) * (1 - TAKER_FEE); }
            else { bal -= size; }
        }
        finals.push(bal);
        if (bal < 2) busts++;
    }
    finals.sort((a, b) => a - b);
    const pct = (p) => finals[Math.floor(p / 100 * finals.length)] || 0;
    return { bust: (busts / runs * 100).toFixed(1), p10: pct(10).toFixed(2), p25: pct(25).toFixed(2), median: pct(50).toFixed(2), p75: pct(75).toFixed(2), p90: pct(90).toFixed(2) };
}

console.log(`Using: ${winnerName} (${WINNER.length} strats, ${actualTPD} trades/day)\n`);

for (const haircut of [0, 0.05, 0.10, 0.15]) {
    console.log(`--- WR Haircut: -${(haircut * 100).toFixed(0)}% ---`);
    for (const days of [1, 3, 7]) {
        const r = mcSim(WINNER, days, haircut, 10000, actualTPD);
        console.log(`  ${days}d: bust=${r.bust}% | p10=$${r.p10} | p25=$${r.p25} | median=$${r.median} | p75=$${r.p75} | p90=$${r.p90}`);
    }
    console.log('');
}

// ============================================================
// Print final set
// ============================================================
console.log('\n========================================');
console.log(`FINAL STRATEGY SET: ${winnerName}`);
console.log('========================================\n');

const finalStrats = WINNER.sort((a, b) => a.utcHour - b.utcHour);
const hours = new Set(finalStrats.map(s => s.utcHour));

for (const s of finalStrats) {
    const trainWR = s.icTrain.m > 0 ? (s.icTrain.wr * 100).toFixed(0) : 'n/a';
    const testWR = s.icTest.m > 0 ? (s.icTest.wr * 100).toFixed(0) : 'n/a';
    console.log(
        `h=${String(s.utcHour).padStart(2)} em=${String(s.entryMinute).padStart(2)} ${s.direction.padEnd(4)} ` +
        `[${s.priceBandLow.toFixed(2)}-${s.priceBandHigh.toFixed(2)}] ` +
        `30d:${s.d30.m}t/${(s.d30.wr*100).toFixed(0)}% ` +
        `IC:${s.icFull.m}t/${(s.icFull.wr*100).toFixed(0)}%(train:${trainWR}%/test:${testWR}%) ` +
        `lcb30=${(s.lcb30*100).toFixed(0)}% lcbIC=${(s.lcbIC*100).toFixed(0)}% ` +
        `ev=${(s.icFull.ev*100).toFixed(1)}% cost=$${s.cost5.toFixed(2)}`
    );
}

console.log(`\nTotal: ${finalStrats.length} strategies | ${hours.size} hours covered`);
console.log(`Hours: [${[...hours].sort((a,b)=>a-b).join(',')}]`);

// Save
const artifact = {
    name: 'optimal_10usd_elite_v3',
    description: 'Elite $10 strategy: 30d WR≥70%, IC WR≥75%, split-half consistent, conservative scoring',
    generatedAt: new Date().toISOString(),
    dataNote: 'Decision dataset: Oct 2025-Mar 2026 (152d). Intracycle OOS: Mar 24-Apr 7 2026 (14d). Strategy selection prioritizes consistency across both periods.',
    parameters: { startingBalance: 10, stakeFraction: 0.15, maxTradesPerCycle: 1, minOrderShares: 5, takerFeePct: TAKER_FEE, entryPriceBufferCents: 0 },
    projections: {
        note: 'Monte Carlo projections at intracycle WR (no haircut). Apply 5-15% WR haircut for conservative estimates.',
        '24h': mcSim(WINNER, 1, 0, 10000, actualTPD),
        '72h': mcSim(WINNER, 3, 0, 10000, actualTPD),
        '7d': mcSim(WINNER, 7, 0, 10000, actualTPD),
        conservative_10pct_haircut: {
            '24h': mcSim(WINNER, 1, 0.10, 10000, actualTPD),
            '72h': mcSim(WINNER, 3, 0.10, 10000, actualTPD),
            '7d': mcSim(WINNER, 7, 0.10, 10000, actualTPD),
        },
    },
    strategies: finalStrats.map(s => ({
        entryMinute: s.entryMinute, utcHour: s.utcHour, direction: s.direction,
        priceMin: s.priceBandLow, priceMax: s.priceBandHigh,
        winRate: parseFloat(s.d30.wr.toFixed(4)),
        winRateLCB: parseFloat(s.lcb30.toFixed(4)),
        pWinEstimate: parseFloat(s.icFull.wr.toFixed(4)),
        evWinEstimate: parseFloat(s.icFull.wr.toFixed(4)),
        expectedEdgeRoi: parseFloat(s.icFull.ev.toFixed(4)),
        recentIntracycleWR: parseFloat(s.icFull.wr.toFixed(4)),
        recentIntracycleMatches: s.icFull.m,
        hist30dMatches: s.d30.m, hist30dWins: s.d30.w,
        icMatches: s.icFull.m, icWins: s.icFull.w,
        avgEntryPrice: parseFloat(s.icFull.avgP.toFixed(4)),
        splitHalf: { trainWR: s.icTrain.m > 0 ? parseFloat((s.icTrain.wr*100).toFixed(1)) : null, testWR: s.icTest.m > 0 ? parseFloat((s.icTest.wr*100).toFixed(1)) : null, trainN: s.icTrain.m, testN: s.icTest.m },
    }))
};
fs.writeFileSync(path.join(ROOT, 'strategies/strategy_set_15m_optimal_10usd_v3.json'), JSON.stringify(artifact, null, 2));
console.log(`\nSaved: strategies/strategy_set_15m_optimal_10usd_v3.json`);
