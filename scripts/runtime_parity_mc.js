/**
 * Runtime-parity Monte Carlo simulation for v5 strategy set.
 *
 * EXACT runtime mechanics replicated:
 *   - OPERATOR_STAKE_FRACTION = 0.15
 *   - MIN_SHARES (order_min_size) = 5
 *   - TAKER_FEE = 0.0315 (3.15%)
 *   - MAX_GLOBAL_TRADES_PER_CYCLE = 1 (one trade per 15m cycle)
 *   - Bankroll floor = 0
 *   - Cooldown after loss: none (current config)
 *   - TIMEFRAME_15M_MIN_BANKROLL = 2
 *
 * Uses CHRONOLOGICAL REPLAY on the 23-day dataset so that trade sequence
 * matches real market order. Monte Carlo runs replay many times with
 * bootstrap sampling to estimate P&L distribution.
 */
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');

const TAKER_FEE = 0.0315;
const MIN_SHARES = 5;
const STAKE_FRACTION = 0.15;
const MAX_TRADES_PER_CYCLE = 1;
const MIN_BANKROLL = 2;

const ic = require(path.join(ROOT, 'data/intracycle-price-data.json'));
const cycles = (ic.cycles || []).sort((a, b) => Number(a.epoch) - Number(b.epoch));
const OOS_START_EPOCH = 1775540700 + 900;
const trueOOS = cycles.filter(c => Number(c.epoch) >= OOS_START_EPOCH);

const strategySet = JSON.parse(fs.readFileSync(path.join(ROOT, 'strategies/strategy_set_15m_optimal_10usd_v5.json'), 'utf8'));
const strategies = strategySet.strategies.map(s => ({
    h: s.utcHour,
    em: s.entryMinute,
    dir: s.direction.toUpperCase(),
    pMin: s.priceMin,
    pMax: s.priceMax
}));

console.log(`V5 set: ${strategies.length} strategies`);
console.log(`OOS cycles: ${trueOOS.length}`);

// Group cycles by 15m epoch (same cycle across assets)
const byEpoch = new Map();
for (const cy of trueOOS) {
    const e = Number(cy.epoch);
    if (!byEpoch.has(e)) byEpoch.set(e, []);
    byEpoch.get(e).push(cy);
}
const orderedEpochs = Array.from(byEpoch.keys()).sort((a, b) => a - b);
console.log(`Unique 15m epochs in OOS: ${orderedEpochs.length}`);

// For each cycle, find all matching signals (potential trades)
// Runtime uses MAX_GLOBAL_TRADES_PER_CYCLE=1, so pick the BEST matching signal
function findCycleSignals(cycleEpoch) {
    const assets = byEpoch.get(cycleEpoch) || [];
    const cyH = new Date(cycleEpoch * 1000).getUTCHours();
    const signals = [];

    for (const s of strategies) {
        if (s.h !== cyH) continue;
        for (const cy of assets) {
            const resolved = String(cy.resolution || '').toUpperCase();
            if (resolved !== 'UP' && resolved !== 'DOWN') continue;
            const pd = s.dir === 'UP' ? cy.minutePricesYes : cy.minutePricesNo;
            const pt = pd && pd[String(s.em)];
            if (!pt) continue;
            const ep = Number(pt.last);
            if (!ep || ep <= 0 || ep >= 1) continue;
            if (ep < s.pMin || ep > s.pMax) continue;
            signals.push({ asset: cy.asset, ep, won: resolved === s.dir, strat: s });
        }
    }
    return signals;
}

// Pre-compute all signals per cycle
console.log('\nPre-computing cycle signals...');
const cycleSignals = [];
for (const e of orderedEpochs) {
    const sigs = findCycleSignals(e);
    if (sigs.length > 0) {
        // Runtime picks LOWEST entry price = highest expected profit per unit stake
        sigs.sort((a, b) => a.ep - b.ep);
        cycleSignals.push({ epoch: e, signal: sigs[0], allSignals: sigs });
    }
}
console.log(`Cycles with signals: ${cycleSignals.length} / ${orderedEpochs.length}`);

// Runtime-parity chronological replay
function chronoReplay(startBal, signals, cap = Infinity) {
    let bal = startBal, peak = bal, maxDD = 0;
    let trades = 0, wins = 0, losses = 0;
    let consecLoss = 0, maxConsecLoss = 0;
    const history = [];

    for (const cs of signals) {
        if (bal < MIN_BANKROLL) break;
        const sig = cs.signal;
        const ep = sig.ep;
        const minCost = MIN_SHARES * ep;
        let stake = bal * STAKE_FRACTION;
        if (stake < minCost) {
            if (bal >= minCost) stake = minCost;
            else break;
        }
        stake = Math.min(stake, bal);
        const shares = stake / ep;

        if (sig.won) {
            // gross = shares * 1.00 (market resolves YES/NO to 1.0 for winner)
            // net = shares * (1 - fee_on_gross)
            const gross = shares * 1.00;
            const feePaid = gross * TAKER_FEE;
            const net = gross - feePaid;
            bal = bal - stake + net;
            wins++; consecLoss = 0;
        } else {
            bal -= stake;
            losses++; consecLoss++;
            if (consecLoss > maxConsecLoss) maxConsecLoss = consecLoss;
        }
        trades++;
        if (bal > peak) peak = bal;
        const dd = peak > 0 ? (peak - bal) / peak : 0;
        if (dd > maxDD) maxDD = dd;
        history.push({ epoch: cs.epoch, asset: sig.asset, ep, won: sig.won, balAfter: bal });
        if (bal >= cap) break;
    }

    return { finalBal: bal, trades, wins, losses, wr: trades > 0 ? wins / trades : 0, maxDD, maxConsecLoss, history };
}

console.log('\n=== PURE CHRONOLOGICAL REPLAY (OOS, $10 start) ===');
const replay = chronoReplay(10, cycleSignals);
console.log(`$10 → $${replay.finalBal.toFixed(2)}`);
console.log(`Trades: ${replay.trades}, Wins: ${replay.wins}, Losses: ${replay.losses}, WR: ${(replay.wr*100).toFixed(1)}%`);
console.log(`Max drawdown: ${(replay.maxDD*100).toFixed(1)}%, Max consec loss: ${replay.maxConsecLoss}`);

// Show first 30 trades to check early behavior
console.log('\nFirst 30 trades of chronological OOS replay:');
for (const t of replay.history.slice(0, 30)) {
    const d = new Date(t.epoch * 1000).toISOString().replace('T', ' ').slice(0, 16);
    console.log(`  ${d} UTC  ${t.asset}  ep=${t.ep.toFixed(3)}  ${t.won ? '✅' : '❌'}  bal=$${t.balAfter.toFixed(2)}`);
}

// Look at losses specifically to see worst scenarios
const losses = replay.history.filter(h => !h.won);
console.log(`\nAll ${losses.length} losses in OOS replay:`);
for (const l of losses.slice(0, 20)) {
    const d = new Date(l.epoch * 1000).toISOString().replace('T', ' ').slice(0, 16);
    console.log(`  ${d} UTC  ${l.asset}  ep=${l.ep.toFixed(3)}  balAfter=$${l.balAfter.toFixed(2)}`);
}

// ============================================================
// Monte Carlo with BOOTSTRAP: randomly sample from OOS signals
// ============================================================
console.log('\n\n=== MONTE CARLO BOOTSTRAP (OOS distribution) ===');
function mcBootstrap(days, runs, startBal, wrHaircut = 0) {
    // Build pool of (signal outcome, ep, price) from OOS replay
    const pool = cycleSignals.map(cs => ({ ep: cs.signal.ep, won: cs.signal.won }));
    // Apply haircut by flipping some wins to losses
    if (wrHaircut > 0) {
        const wins = pool.filter(p => p.won);
        const toFlip = Math.floor(wins.length * wrHaircut / (cycleSignals.length > 0 ? (wins.length/cycleSignals.length) : 1));
        // Simpler: add haircut applied per sample at runtime
    }

    const results = [];
    let busted = 0;
    const tradesPerDay = cycleSignals.length / 9; // 9 days OOS
    const totalTrades = Math.round(tradesPerDay * days);

    for (let run = 0; run < runs; run++) {
        let bal = startBal;
        for (let t = 0; t < totalTrades; t++) {
            if (bal < MIN_BANKROLL) break;
            const s = pool[Math.floor(Math.random() * pool.length)];
            const ep = s.ep;
            const minCost = MIN_SHARES * ep;
            let stake = bal * STAKE_FRACTION;
            if (stake < minCost) {
                if (bal >= minCost) stake = minCost;
                else break;
            }
            stake = Math.min(stake, bal);

            // Apply haircut: if won, there's (wrHaircut / effective_WR) chance to flip it to loss
            let won = s.won;
            if (won && wrHaircut > 0) {
                const effectiveWR = pool.filter(p => p.won).length / pool.length;
                const flipProb = Math.min(1, wrHaircut / Math.max(0.01, effectiveWR));
                if (Math.random() < flipProb) won = false;
            }

            if (won) {
                const shares = stake / ep;
                const net = shares * 1.00 * (1 - TAKER_FEE);
                bal = bal - stake + net;
            } else {
                bal -= stake;
            }
        }
        results.push(bal);
        if (bal < MIN_BANKROLL) busted++;
    }

    results.sort((a, b) => a - b);
    const pct = p => results[Math.floor(p / 100 * results.length)] || 0;
    return {
        bust: busted / runs,
        p5: pct(5),
        p10: pct(10),
        p25: pct(25),
        median: pct(50),
        p75: pct(75),
        p90: pct(90),
        p95: pct(95),
        mean: results.reduce((a, b) => a + b, 0) / results.length
    };
}

const horizons = [
    { days: 1, label: '24h' },
    { days: 2, label: '48h' },
    { days: 3, label: '72h' },
    { days: 5, label: '5d' },
    { days: 7, label: '7d' }
];
const haircuts = [0, 0.03, 0.05, 0.08];

console.log(`\nBootstrap from ${cycleSignals.length} OOS signals, ${(cycleSignals.length/9).toFixed(1)} trades/day avg\n`);

for (const bal of [5, 10, 20]) {
    console.log(`\n--- Starting bankroll $${bal} ---`);
    for (const hc of haircuts) {
        console.log(`\n  WR haircut: ${(hc*100).toFixed(0)}pp (effective OOS WR: ${(0.915 - hc).toFixed(2)})`);
        for (const h of horizons) {
            const r = mcBootstrap(h.days, 5000, bal, hc);
            console.log(`    ${h.label.padStart(4)} Bust=${(r.bust*100).toFixed(1).padStart(4)}% p5=$${r.p5.toFixed(2).padStart(7)} p25=$${r.p25.toFixed(2).padStart(7)} med=$${r.median.toFixed(2).padStart(8)} p75=$${r.p75.toFixed(2).padStart(8)} p90=$${r.p90.toFixed(2).padStart(8)}`);
        }
    }
}

// ============================================================
// First-trade analysis: what happens on trades 1, 2, 3?
// ============================================================
console.log('\n\n=== FIRST-TRADE BUST RISK ANALYSIS ===');
function firstTradeBustRisk(startBal) {
    const pool = cycleSignals.map(cs => ({ ep: cs.signal.ep, won: cs.signal.won }));
    const runs = 20000;
    let bustAfter1 = 0, bustAfter2 = 0, bustAfter3 = 0, bustAfter5 = 0;

    for (let r = 0; r < runs; r++) {
        let bal = startBal;
        for (let t = 0; t < 5; t++) {
            if (bal < MIN_BANKROLL) break;
            const s = pool[Math.floor(Math.random() * pool.length)];
            const minCost = MIN_SHARES * s.ep;
            let stake = bal * STAKE_FRACTION;
            if (stake < minCost) {
                if (bal >= minCost) stake = minCost;
                else break;
            }
            stake = Math.min(stake, bal);
            if (s.won) {
                bal = bal - stake + (stake / s.ep) * 1.00 * (1 - TAKER_FEE);
            } else {
                bal -= stake;
            }
            if (bal < MIN_BANKROLL) {
                if (t === 0) bustAfter1++;
                else if (t === 1) bustAfter2++;
                else if (t === 2) bustAfter3++;
                else bustAfter5++;
                break;
            }
        }
    }
    const cum1 = bustAfter1;
    const cum2 = cum1 + bustAfter2;
    const cum3 = cum2 + bustAfter3;
    const cum5 = cum3 + bustAfter5;
    return {
        after1: cum1 / runs,
        after2: cum2 / runs,
        after3: cum3 / runs,
        after5: cum5 / runs
    };
}

for (const bal of [5, 7, 10, 15, 20]) {
    const r = firstTradeBustRisk(bal);
    console.log(`  $${String(bal).padStart(2)} start: bust after 1t=${(r.after1*100).toFixed(2)}% | 2t=${(r.after2*100).toFixed(2)}% | 3t=${(r.after3*100).toFixed(2)}% | 5t=${(r.after5*100).toFixed(2)}%`);
}

// ============================================================
// Scheduled next-signal times: when would the bot trade next?
// ============================================================
console.log('\n\n=== NEXT SIGNAL WINDOWS (next 24h) ===');
const nowSec = Math.floor(Date.now() / 1000);
const nowH = new Date(nowSec * 1000).getUTCHours();
const nowM = new Date(nowSec * 1000).getUTCMinutes();
console.log(`Current UTC: H${nowH} m${nowM}`);

const upcoming = [];
for (let addH = 0; addH < 24; addH++) {
    const hour = (nowH + addH) % 24;
    const day = addH > 0 || nowH > hour ? 'tomorrow' : 'today';
    for (const s of strategies) {
        if (s.h !== hour) continue;
        const triggerTime = new Date((nowSec + addH * 3600) * 1000);
        triggerTime.setUTCHours(hour, s.em, 0, 0);
        if (triggerTime.getTime() / 1000 < nowSec) triggerTime.setUTCDate(triggerTime.getUTCDate() + 1);
        upcoming.push({ h: s.h, em: s.em, dir: s.dir, band: `${s.pMin}-${s.pMax}`, when: triggerTime });
    }
}
upcoming.sort((a, b) => a.when - b.when);
console.log('\nNext 15 signal windows:');
for (const u of upcoming.slice(0, 15)) {
    const mins = Math.round((u.when - new Date()) / 60000);
    console.log(`  ${u.when.toISOString().slice(0, 16)} UTC (in ${mins}m)  H${u.h} m${u.em} ${u.dir} [${u.band}]`);
}

// Save summary
const summary = {
    generated: new Date().toISOString(),
    strategySet: 'v5_true_oos',
    oosReplay: {
        start: 10,
        final: replay.finalBal,
        trades: replay.trades,
        wr: replay.wr,
        maxDD: replay.maxDD,
        maxConsecLoss: replay.maxConsecLoss
    },
    nextSignals: upcoming.slice(0, 20)
};
fs.writeFileSync(path.join(ROOT, 'debug', 'v5_runtime_mc_summary.json'), JSON.stringify(summary, null, 2));
console.log('\nSummary saved to debug/v5_runtime_mc_summary.json');
