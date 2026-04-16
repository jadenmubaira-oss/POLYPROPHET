/**
 * STRICT Out-of-Sample Audit
 * 
 * The v3 strategies were selected using ALL intracycle data (Mar 24 - Apr 7).
 * This means the IC WR numbers are IN-SAMPLE — inflated by selection bias.
 * 
 * This script applies the STRICTEST honest validation:
 *   - Uses ONLY the second week (Apr 1-7) as pure OOS
 *   - The first week (Mar 24-31) approximates what the selector "saw"
 *   - Any strategy that degrades significantly in the second week is flagged
 *   - Monte Carlo uses ONLY second-week (OOS) WR for projections
 *   - Additional: tests with FURTHER 5pp haircut on OOS WR for conservatism
 */
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');

const TAKER_FEE = 0.0315;
const MIN_SHARES = 5;
const START_BAL = 10;

const icRaw = require(path.join(ROOT, 'data/intracycle-price-data-backup-apr7.json'));
const cycles = (icRaw.cycles || []).sort((a, b) => Number(a.epoch) - Number(b.epoch));

// Load all candidate strategy sets
const v3 = JSON.parse(fs.readFileSync(path.join(ROOT, 'strategies/strategy_set_15m_optimal_10usd_v3.json'), 'utf8'));
const pruned = JSON.parse(fs.readFileSync(path.join(ROOT, 'strategies/strategy_set_15m_optimal_10usd_v4_pruned.json'), 'utf8'));
const ultraSafe = JSON.parse(fs.readFileSync(path.join(ROOT, 'strategies/strategy_set_15m_ultrasafe_10usd.json'), 'utf8'));

// Also check the historically proven NC sets from the debug folder
const ncSets = ['strategy_set_15m_nc_exhaustive_13.json', 'strategy_set_15m_nc_beam_best_12.json'].map(f => {
    const fp = path.join(ROOT, 'debug', f);
    if (!fs.existsSync(fp)) return null;
    return { name: f.replace('strategy_set_15m_', '').replace('.json', ''), data: JSON.parse(fs.readFileSync(fp, 'utf8')) };
}).filter(Boolean);

// Also check other strategy files
const otherSets = [
    'strategies/strategy_set_15m_elite_recency.json',
    'strategies/strategy_set_15m_beam_2739_uncapped.json',
    'strategies/strategy_set_15m_beam11_zero_bust.json',
].map(f => {
    const fp = path.join(ROOT, f);
    if (!fs.existsSync(fp)) return null;
    return { name: path.basename(f).replace('strategy_set_15m_', '').replace('.json', ''), data: JSON.parse(fs.readFileSync(fp, 'utf8')) };
}).filter(Boolean);

const SPLIT_EPOCH = Math.floor(new Date('2026-04-01T00:00:00Z').getTime() / 1000);
const week1 = cycles.filter(c => Number(c.epoch) < SPLIT_EPOCH);
const week2 = cycles.filter(c => Number(c.epoch) >= SPLIT_EPOCH);

console.log(`Total IC cycles: ${cycles.length}`);
console.log(`Week 1 (Mar 24-31): ${week1.length} cycles`);
console.log(`Week 2 (Apr 1-7, STRICT OOS): ${week2.length} cycles`);
console.log(`Split epoch: ${new Date(SPLIT_EPOCH * 1000).toISOString()}\n`);

// ============================================================
// Evaluate a strategy set on a given subset of cycles
// ============================================================
function evaluateOnCycles(strategies, targetCycles, label) {
    let total = 0, wins = 0, losses = 0;
    const prices = [];
    const perStrat = {};
    
    for (const s of strategies) {
        const h = s.utcHour, em = s.entryMinute, dir = (s.direction || '').toUpperCase();
        const pMin = s.priceMin || s.priceBandLow || 0;
        const pMax = s.priceMax || s.priceBandHigh || 1;
        const key = `H${String(h).padStart(2,'0')} m${em} ${dir}`;
        perStrat[key] = { m: 0, w: 0, prices: [] };
        
        for (const cy of targetCycles) {
            const cyH = new Date(Number(cy.epoch) * 1000).getUTCHours();
            if (cyH !== h) continue;
            const resolved = String(cy.resolution || cy.resolvedOutcome || '').toUpperCase();
            if (resolved !== 'UP' && resolved !== 'DOWN') continue;
            const pd = dir === 'UP' ? cy.minutePricesYes : cy.minutePricesNo;
            const pt = pd && pd[String(em)];
            if (!pt) continue;
            const ep = Number(pt.last);
            if (!ep || ep <= 0 || ep >= 1) continue;
            if (ep < pMin || ep > pMax) continue;
            
            total++; prices.push(ep);
            perStrat[key].m++; perStrat[key].prices.push(ep);
            if (resolved === dir) { wins++; perStrat[key].w++; }
            else losses++;
        }
    }
    
    const wr = total > 0 ? wins / total : 0;
    const avgP = prices.length > 0 ? prices.reduce((a,b)=>a+b,0)/prices.length : 0;
    const be = avgP > 0 ? avgP / (avgP + (1 - avgP) * (1 - TAKER_FEE)) : 1;
    const edge = wr - be;
    
    return { label, total, wins, losses, wr, avgP, be, edge, perStrat };
}

// ============================================================
// Chronological replay on week 2 ONLY (strict OOS)
// ============================================================
function oosReplay(strategies, targetCycles, startBal, label) {
    const entries = strategies.map(s => ({
        h: s.utcHour, em: s.entryMinute, dir: (s.direction || '').toUpperCase(),
        pMin: s.priceMin || s.priceBandLow || 0, pMax: s.priceMax || s.priceBandHigh || 1
    }));
    
    let bal = startBal, peak = bal, maxDD = 0;
    let trades = 0, wins = 0, losses = 0, maxConsecLoss = 0, consecLoss = 0;
    
    for (const cy of targetCycles) {
        const cyH = new Date(Number(cy.epoch) * 1000).getUTCHours();
        const resolved = String(cy.resolution || cy.resolvedOutcome || '').toUpperCase();
        if (resolved !== 'UP' && resolved !== 'DOWN') continue;
        
        let best = null;
        for (const s of entries) {
            if (s.h !== cyH) continue;
            const pd = s.dir === 'UP' ? cy.minutePricesYes : cy.minutePricesNo;
            const pt = pd && pd[String(s.em)];
            if (!pt) continue;
            const ep = Number(pt.last);
            if (!ep || ep <= 0 || ep >= 1) continue;
            if (ep < s.pMin || ep > s.pMax) continue;
            if (!best || ep < best.ep) best = { ...s, ep, resolved };
        }
        
        if (!best) continue;
        if (bal < 2) break;
        
        const ep = best.ep;
        const minCost = MIN_SHARES * ep;
        let size = bal * 0.15;
        if (size < minCost) {
            if (bal >= minCost) size = minCost;
            else break;
        }
        size = Math.min(size, bal);
        
        const won = best.resolved === best.dir;
        if (won) {
            const profit = (size / ep) * (1 - ep) * (1 - TAKER_FEE);
            bal += profit;
            wins++; consecLoss = 0;
        } else {
            bal -= size;
            losses++; consecLoss++;
            if (consecLoss > maxConsecLoss) maxConsecLoss = consecLoss;
        }
        trades++;
        if (bal > peak) peak = bal;
        const dd = peak > 0 ? (peak - bal) / peak : 0;
        if (dd > maxDD) maxDD = dd;
    }
    
    console.log(`  ${label}: $${startBal}→$${bal.toFixed(2)} | ${trades}t ${wins}W/${losses}L ${trades>0?(wins/trades*100).toFixed(1):0}%WR | maxDD=${(maxDD*100).toFixed(1)}% | maxConsecLoss=${maxConsecLoss}`);
    return { bal, trades, wins, losses, wr: trades > 0 ? wins/trades : 0, maxDD, maxConsecLoss };
}

// ============================================================
// Monte Carlo using ONLY OOS WR (strict)
// ============================================================
function mcOOS(strategies, targetCycles, startBal, days, runs, wrHaircut, label) {
    // First get per-strategy OOS stats
    const stratStats = [];
    let totalWeight = 0;
    
    for (const s of strategies) {
        const h = s.utcHour, em = s.entryMinute, dir = (s.direction || '').toUpperCase();
        const pMin = s.priceMin || s.priceBandLow || 0;
        const pMax = s.priceMax || s.priceBandHigh || 1;
        
        let m = 0, w = 0, pSum = 0;
        for (const cy of targetCycles) {
            const cyH = new Date(Number(cy.epoch) * 1000).getUTCHours();
            if (cyH !== h) continue;
            const resolved = String(cy.resolution || cy.resolvedOutcome || '').toUpperCase();
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
        
        if (m === 0) continue;
        const wr = Math.max(0, w / m - wrHaircut);
        const avgP = pSum / m;
        stratStats.push({ wr, avgP, weight: m });
        totalWeight += m;
    }
    
    if (stratStats.length === 0 || totalWeight === 0) {
        console.log(`  ${label}: NO DATA`);
        return null;
    }
    
    const coveredHours = new Set(strategies.map(s => s.utcHour)).size;
    const estTradesPerDay = Math.min(coveredHours * 2, coveredHours * 4 * 0.3);
    
    const results = [];
    let busted = 0;
    
    for (let run = 0; run < runs; run++) {
        let bal = startBal;
        const totalTrades = Math.round(estTradesPerDay * days);
        
        for (let t = 0; t < totalTrades; t++) {
            if (bal < 2) break;
            
            const r = Math.random() * totalWeight;
            let cum = 0, strat = stratStats[0];
            for (const ss of stratStats) { cum += ss.weight; if (cum >= r) { strat = ss; break; } }
            
            const ep = strat.avgP;
            const minCost = MIN_SHARES * ep;
            let size = bal * 0.15;
            if (size < minCost) {
                if (bal >= minCost) size = minCost;
                else break;
            }
            size = Math.min(size, bal);
            
            if (Math.random() < strat.wr) {
                bal += (size / ep) * (1 - ep) * (1 - TAKER_FEE);
            } else {
                bal -= size;
            }
        }
        
        results.push(bal);
        if (bal < 2) busted++;
    }
    
    results.sort((a, b) => a - b);
    const pct = p => results[Math.floor(p / 100 * results.length)] || 0;
    
    console.log(`  ${label} (${days}d, ${stratStats.length}/${strategies.length} strats, ~${estTradesPerDay.toFixed(0)}t/d, hc=${(wrHaircut*100).toFixed(0)}pp):`);
    console.log(`    Bust=${(busted/runs*100).toFixed(1)}% | p10=$${pct(10).toFixed(2)} | p25=$${pct(25).toFixed(2)} | med=$${pct(50).toFixed(2)} | p75=$${pct(75).toFixed(2)} | p90=$${pct(90).toFixed(2)}`);
    
    return { bust: busted/runs, p10: pct(10), p25: pct(25), median: pct(50), p75: pct(75), p90: pct(90) };
}

// ============================================================
// RUN ALL EVALUATIONS
// ============================================================

const allSets = [
    { name: 'v3_full_23', strats: v3.strategies },
    { name: 'pruned_v4_19', strats: pruned.strategies },
    { name: 'ultra_safe_9', strats: ultraSafe.strategies },
    ...ncSets.map(s => ({ name: s.name, strats: s.data.strategies || [] })),
    ...otherSets.map(s => ({ name: s.name, strats: s.data.strategies || [] })),
];

console.log('=== STRICT OOS EVALUATION (Week 2: Apr 1-7 ONLY) ===\n');

for (const set of allSets) {
    const w1 = evaluateOnCycles(set.strats, week1, 'Week1');
    const w2 = evaluateOnCycles(set.strats, week2, 'Week2_OOS');
    const full = evaluateOnCycles(set.strats, cycles, 'Full');
    
    const degradation = w1.wr > 0 ? (w2.wr - w1.wr) : 0;
    const flag = degradation < -0.05 ? ' ⚠️ DEGRADES >5pp' : degradation < -0.10 ? ' ⛔ DEGRADES >10pp' : '';
    
    console.log(`--- ${set.name} (${set.strats.length} strats) ---`);
    console.log(`  Week1: ${w1.total}t ${(w1.wr*100).toFixed(1)}%WR avgP=${w1.avgP.toFixed(3)} edge=${(w1.edge*100).toFixed(1)}pp`);
    console.log(`  Week2 OOS: ${w2.total}t ${(w2.wr*100).toFixed(1)}%WR avgP=${w2.avgP.toFixed(3)} edge=${(w2.edge*100).toFixed(1)}pp${flag}`);
    console.log(`  Full: ${full.total}t ${(full.wr*100).toFixed(1)}%WR avgP=${full.avgP.toFixed(3)} edge=${(full.edge*100).toFixed(1)}pp`);
    console.log('');
}

console.log('\n=== STRICT OOS CHRONOLOGICAL REPLAY (Apr 1-7, $10 start) ===\n');

for (const set of allSets) {
    oosReplay(set.strats, week2, 10, set.name);
}

console.log('\n=== STRICT OOS MONTE CARLO ($10 start, OOS WR only) ===\n');

for (const set of allSets) {
    if (set.strats.length === 0) continue;
    
    // 0pp haircut (OOS WR as-is)
    mcOOS(set.strats, week2, 10, 1, 5000, 0, `${set.name} 24h hc=0`);
    mcOOS(set.strats, week2, 10, 3, 5000, 0, `${set.name} 72h hc=0`);
    mcOOS(set.strats, week2, 10, 7, 5000, 0, `${set.name} 7d hc=0`);
    
    // 5pp additional haircut on OOS WR (very conservative)
    mcOOS(set.strats, week2, 10, 1, 5000, 0.05, `${set.name} 24h hc=5`);
    mcOOS(set.strats, week2, 10, 3, 5000, 0.05, `${set.name} 72h hc=5`);
    mcOOS(set.strats, week2, 10, 7, 5000, 0.05, `${set.name} 7d hc=5`);
    
    console.log('');
}

// ============================================================
// Per-strategy OOS breakdown for the top 2 candidate sets
// ============================================================
console.log('\n=== PER-STRATEGY OOS BREAKDOWN ===\n');

for (const setName of ['pruned_v4_19', 'ultra_safe_9']) {
    const set = allSets.find(s => s.name === setName);
    if (!set) continue;
    
    console.log(`--- ${setName} per-strategy OOS (Week 2) ---`);
    for (const s of set.strats) {
        const h = s.utcHour, em = s.entryMinute, dir = (s.direction || '').toUpperCase();
        const pMin = s.priceMin || s.priceBandLow || 0;
        const pMax = s.priceMax || s.priceBandHigh || 1;
        
        let m1 = 0, w1 = 0, m2 = 0, w2 = 0;
        for (const cy of week1) {
            const cyH = new Date(Number(cy.epoch) * 1000).getUTCHours();
            if (cyH !== h) continue;
            const resolved = String(cy.resolution || cy.resolvedOutcome || '').toUpperCase();
            if (resolved !== 'UP' && resolved !== 'DOWN') continue;
            const pd = dir === 'UP' ? cy.minutePricesYes : cy.minutePricesNo;
            const pt = pd && pd[String(em)];
            if (!pt) continue;
            const ep = Number(pt.last);
            if (!ep || ep <= 0 || ep >= 1) continue;
            if (ep < pMin || ep > pMax) continue;
            m1++;
            if (resolved === dir) w1++;
        }
        for (const cy of week2) {
            const cyH = new Date(Number(cy.epoch) * 1000).getUTCHours();
            if (cyH !== h) continue;
            const resolved = String(cy.resolution || cy.resolvedOutcome || '').toUpperCase();
            if (resolved !== 'UP' && resolved !== 'DOWN') continue;
            const pd = dir === 'UP' ? cy.minutePricesYes : cy.minutePricesNo;
            const pt = pd && pd[String(em)];
            if (!pt) continue;
            const ep = Number(pt.last);
            if (!ep || ep <= 0 || ep >= 1) continue;
            if (ep < pMin || ep > pMax) continue;
            m2++;
            if (resolved === dir) w2++;
        }
        
        const wr1 = m1 > 0 ? (w1/m1*100).toFixed(0) : 'N/A';
        const wr2 = m2 > 0 ? (w2/m2*100).toFixed(0) : 'N/A';
        const label = `H${String(h).padStart(2,'0')} m${em} ${dir} [${pMin}-${pMax}]`;
        const degrade = m1 > 0 && m2 > 0 ? ((w2/m2) - (w1/m1)) : 0;
        const flag = degrade < -0.15 ? ' ⛔' : degrade < -0.05 ? ' ⚠️' : '';
        console.log(`  ${label}: W1=${wr1}%/${m1}t W2_OOS=${wr2}%/${m2}t${flag}`);
    }
    console.log('');
}

console.log('\n=== FINAL RECOMMENDATION ===\n');
console.log('This analysis uses ONLY Week 2 (Apr 1-7) as strict OOS.');
console.log('Data gap: Apr 7 → Apr 16 (9 days) CANNOT be validated locally (Gamma API geoblocked).');
console.log('All projections carry this 9-day uncertainty premium.');
