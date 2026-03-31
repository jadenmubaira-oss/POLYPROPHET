/**
 * COMPARE STRATEGY SETS - Profit Simulation
 * 
 * Runs the same Monte Carlo for:
 * A) OLD: existing 6-strategy set (m11/m12/m14 strategies)
 * B) NEW: optimal v8 set (m0/m5/m10 strategies from fresh data)
 * C) COMBINED: both old + new strategies together
 * 
 * NOTE ON DATA LIMITATIONS:
 * - prices-history API only returns data at m0, m5, m10 (5-minute intervals)
 * - This means m11/m12/m14 strategies cannot be validated from this source
 * - The old OOS data (992 cycles, Mar 28-31) validated m11/m12/m14
 * - The new data (776 cycles, Mar 29-31) validates m0/m5/m10
 * - COMBINED uses both validation datasets
 */

const RiskManager = require('../lib/risk-manager');
const fs = require('fs');
const path = require('path');

const TAKER_FEE = 0.0315;
const MIN_SHARES = 5;
const MIN_BAL = 2.0;
const MAX_SHARES_PER_FILL = 200;

// Load both strategy sets
const oldSet = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'debug', 'strategy_set_15m_oos_validated_v1.json'), 'utf8'));
const newSet = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'debug', 'strategy_set_15m_optimal_v8.json'), 'utf8'));

function buildStrategies(strategies, label) {
    return strategies.map(s => ({
        name: s.name,
        wr: s.oosWinRate || s.oosWR || s.winRate,
        pMin: s.priceMin,
        pMax: s.priceMax,
        lcb: s.winRateLCB || s.winRate * 0.9,
        matchFrac: (s.oosMatches || s.historicalTrades) / 3968, // normalize to per-asset-cycle
        minute: s.entryMinute,
        direction: s.direction,
        label
    }));
}

const OLD_STRATEGIES = buildStrategies(oldSet.strategies, 'OLD');
const NEW_STRATEGIES = buildStrategies(newSet.strategies, 'NEW');
const COMBINED_STRATEGIES = [...OLD_STRATEGIES, ...NEW_STRATEGIES];

// Since m0/m5/m10 strategies fire at different minutes than m11/m12/m14,
// the combined set can fire MORE frequently (no overlap in minutes)

function samplePrice(pMin, pMax) {
    return pMin + ((Math.random() + Math.random()) / 2) * (pMax - pMin);
}

function simulate(strategies, startBal, days, maxDayBoot, maxDayGrowth) {
    const rm = new RiskManager(startBal);
    let bal = startBal;
    rm.setBankroll(bal);
    let tr = 0, w = 0;
    
    for (let d = 0; d < days; d++) {
        if (bal < MIN_BAL) break;
        rm.dayStartBalance = bal;
        rm.todayPnL = 0;
        rm.consecutiveLosses = 0;
        let cd = 0, dt = 0;
        const maxDay = bal < 10 ? maxDayBoot : maxDayGrowth;
        
        for (let c = 0; c < 96; c++) {
            if (bal < MIN_BAL || dt >= maxDay) break;
            if (cd > 0) { cd--; continue; }
            if (rm.todayPnL < -(rm.dayStartBalance * 0.20)) break;
            
            const mpc = bal < 10 ? 1 : 2;
            let ct = 0;
            
            for (let ai = 0; ai < 4 && ct < mpc && dt < maxDay; ai++) {
                if (bal < MIN_BAL) break;
                let best = null, bestL = -1;
                for (const s of strategies) {
                    if (Math.random() < s.matchFrac) {
                        if (s.lcb > bestL) { best = s; bestL = s.lcb; }
                    }
                }
                if (!best) continue;
                
                const ep = samplePrice(best.pMin, best.pMax);
                const sz = rm.calculateSize({ entryPrice: ep, pWinEstimate: best.lcb, minOrderShares: MIN_SHARES, timeframe: '15m', epoch: `${d}_${c}` });
                if (sz.blocked || sz.size <= 0) continue;
                
                let sh = Math.min(Math.floor(sz.size / ep + 1e-9), MAX_SHARES_PER_FILL);
                if (sh < MIN_SHARES) continue;
                const cost = sh * ep;
                if (cost > bal) continue;
                
                const won = Math.random() < best.wr;
                let pnl;
                if (won) {
                    const profit = sh * 1.0 - cost;
                    pnl = profit - (profit > 0 ? profit * TAKER_FEE : 0);
                } else { pnl = -cost; }
                
                bal += pnl; rm.bankroll = bal; rm.todayPnL += pnl;
                tr++; dt++; ct++;
                if (won) { w++; rm.consecutiveLosses = 0; if (bal > rm.peakBalance) rm.peakBalance = bal; }
                else { rm.consecutiveLosses++; if (rm.consecutiveLosses >= 4) { cd = 1; rm.consecutiveLosses = 0; } }
            }
        }
    }
    return { bal: Math.max(0, bal), tr, w, bust: bal < MIN_BAL, tpd: tr/days };
}

function mc(strategies, startBal, days, trials, maxDB, maxDG) {
    const bs = [];
    let bust = 0, tpd = 0, wrs = 0, wrn = 0;
    for (let i = 0; i < trials; i++) {
        const r = simulate(strategies, startBal, days, maxDB, maxDG);
        bs.push(r.bal);
        if (r.bust) bust++;
        tpd += r.tpd;
        if (!r.bust && r.tr > 0) { wrs += r.w/r.tr; wrn++; }
    }
    bs.sort((a,b) => a-b);
    const p = f => bs[Math.min(Math.floor(trials*f), trials-1)];
    return {
        bust: (bust/trials*100).toFixed(1),
        p10: p(0.10), p25: p(0.25), med: p(0.50), p75: p(0.75), p90: p(0.90),
        mean: bs.reduce((a,b)=>a+b,0)/trials,
        tpd: (tpd/trials).toFixed(1),
        wr: wrn > 0 ? (wrs/wrn*100).toFixed(1) : '--'
    };
}

const f = n => {
    if (n >= 1e6) return `$${(n/1e6).toFixed(1)}M`;
    if (n >= 1e3) return `$${(n/1e3).toFixed(1)}K`;
    return `$${n.toFixed(0)}`;
};
const pad = (s,n) => String(s).padStart(n);

const N = 3000;
const starts = [5, 10, 15, 20, 25, 50];

function printTable(label, strategies, maxDB, maxDG) {
    console.log(`\n=== ${label} (${strategies.length} strategies, daily cap ${maxDB}/${maxDG}) ===`);
    console.log('Start | Bust% |    P10   |    P25   |  Median  |    P75   |    P90   |   Mean   | Tr/d | WR');
    console.log('------|-------|----------|----------|----------|----------|----------|----------|------|---');
    for (const sb of starts) {
        const r = mc(strategies, sb, 30, N, maxDB, maxDG);
        console.log(
            `$${pad(sb,3)} | ${pad(r.bust,5)}% | ${pad(f(r.p10),8)} | ${pad(f(r.p25),8)} | ${pad(f(r.med),8)} | ${pad(f(r.p75),8)} | ${pad(f(r.p90),8)} | ${pad(f(r.mean),8)} | ${pad(r.tpd,4)} | ${r.wr}%`
        );
    }
}

console.log('======================================================');
console.log('STRATEGY SET COMPARISON (3000 trials, 30 days)');
console.log('5-share min | 3.15% fee | 200sh liquidity cap');
console.log(`OLD: ${OLD_STRATEGIES.length} strategies (m11/m12/m14)`);
console.log(`NEW: ${NEW_STRATEGIES.length} strategies (m0/m5/m10)`);
console.log(`COMBINED: ${COMBINED_STRATEGIES.length} strategies (all)`);
console.log('======================================================');

// Summarize strategies
console.log('\nOLD strategies:');
OLD_STRATEGIES.forEach(s => console.log(`  ${s.name}: WR=${(s.wr*100).toFixed(1)}% LCB=${(s.lcb*100).toFixed(1)}% matchFrac=${s.matchFrac.toFixed(4)}`));
console.log('\nNEW strategies:');
NEW_STRATEGIES.forEach(s => console.log(`  ${s.name}: WR=${(s.wr*100).toFixed(1)}% LCB=${(s.lcb*100).toFixed(1)}% matchFrac=${s.matchFrac.toFixed(4)}`));

printTable('A) OLD SET ONLY (m11/m12/m14)', OLD_STRATEGIES, 15, 25);
printTable('B) NEW SET ONLY (m0/m5/m10)', NEW_STRATEGIES, 15, 25);
printTable('C) COMBINED (all minutes)', COMBINED_STRATEGIES, 20, 35);

// Also test optimized config for combined: higher daily caps since we have more minutes
printTable('D) COMBINED + HIGHER CAPS', COMBINED_STRATEGIES, 25, 40);
