/**
 * FINAL INVESTIGATION — Addendum W Analysis Script
 * Independent Monte Carlo + Replay Analysis
 * Created: 2026-03-09
 * 
 * This script:
 * 1. Loads all replay ledgers and computes ACTUAL WRs
 * 2. Runs Monte Carlo with REPLAY WRs (honest)
 * 3. Runs Monte Carlo with STRATEGY FILE WRs (optimistic)
 * 4. Runs Monte Carlo with LIVE WRs where available (best evidence)
 * 5. Compares everything in a single unified output
 */

const fs = require('fs');
const path = require('path');

const RUNS = 200000;
const DAYS = 14;
const MIN_ORDER_SHARES = 5;
const MAX_ABS_STAKE = 100;
const DAY_SEC = 86400;

// ──────────────────────────────────────────
// Fee model (matches server.js + fresh_micro_audit.js)
// ──────────────────────────────────────────
function takerFee(shares, price) {
    const base = price * (1 - price);
    return shares * 0.25 * Math.pow(base, 2);
}

function tradePnl(stake, entryPrice, won) {
    const ep = Math.min(0.99, entryPrice * 1.01); // 1% slippage
    const shares = stake / ep;
    const fee = takerFee(shares, ep);
    return won ? (shares - stake - fee) : (-stake - fee);
}

// ──────────────────────────────────────────
// Load strategy set and compute stats
// ──────────────────────────────────────────
function loadStrategySet(filename) {
    const fullPath = path.join(__dirname, filename);
    if (!fs.existsSync(fullPath)) return null;
    const d = JSON.parse(fs.readFileSync(fullPath, 'utf8'));
    const strategies = (d.strategies || []).map(s => {
        const bandMin = Number(s.priceMin ?? s.priceBand?.min);
        const bandMax = Number(s.priceMax ?? s.priceBand?.max);
        return {
            name: s.name || `H${s.utcHour}:m${s.entryMinute} ${s.direction}`,
            direction: s.direction,
            utcHour: s.utcHour,
            entryMinute: s.entryMinute,
            avgEntry: (bandMin + bandMax) / 2,
            historicalWins: s.historicalWins,
            historicalTrades: s.historicalTrades,
            winRate: s.winRate,
            oosTrades: s.oosTrades,
            oosWins: s.oosWins,
            liveTrades: s.liveTrades || 0,
            liveWins: s.liveWins || 0,
            signature: s.signature
        };
    });
    return { strategies, meta: d };
}

// ──────────────────────────────────────────
// Load replay ledger and compute stats
// ──────────────────────────────────────────
function loadReplayLedger(relPath) {
    const fullPath = path.join(__dirname, relPath);
    if (!fs.existsSync(fullPath)) return null;
    const data = JSON.parse(fs.readFileSync(fullPath, 'utf8'));
    const trades = (data.trades || []).sort((a, b) =>
        (a.cycleStartEpochSec || a.cycleStartEpoch || 0) - (b.cycleStartEpochSec || b.cycleStartEpoch || 0)
    );
    const wins = trades.filter(t => t.won === true || t.isWin === true || t.outcome === 'WIN').length;
    const firstTs = trades.length > 0 ? (trades[0].cycleStartEpochSec || trades[0].cycleStartEpoch) : null;
    const lastTs = trades.length > 0 ? (trades[trades.length - 1].cycleStartEpochSec || trades[trades.length - 1].cycleStartEpoch) : null;
    const spanDays = (firstTs && lastTs) ? (lastTs - firstTs) / DAY_SEC : 0;
    return {
        trades,
        total: trades.length,
        wins,
        wr: trades.length > 0 ? wins / trades.length : 0,
        spanDays: spanDays.toFixed(1),
        firstDate: firstTs ? new Date(firstTs * 1000).toISOString().split('T')[0] : 'N/A',
        lastDate: lastTs ? new Date(lastTs * 1000).toISOString().split('T')[0] : 'N/A',
        tradesPerDay: spanDays > 0 ? (trades.length / spanDays) : 0
    };
}

// ──────────────────────────────────────────
// Monte Carlo simulation (IID model)
// ──────────────────────────────────────────
function simMonteCarlo(strats, startBal, stakeFrac, wrAdjust = 0) {
    const cheapest = Math.min(...strats.map(s => MIN_ORDER_SHARES * s.avgEntry));
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
                    const minCost = MIN_ORDER_SHARES * s.avgEntry;
                    if (bal < minCost) { if (bal < cheapest) dead = true; continue; }
                    let stake = Math.max(bal * stakeFrac, minCost);
                    stake = Math.min(stake, bal, MAX_ABS_STAKE);
                    const wr = Math.max(0, Math.min(1, s.wr + wrAdjust));
                    const won = Math.random() < wr;
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
        bust: (busts / RUNS * 100).toFixed(2) + '%',
        med: '$' + q(0.5).toFixed(0),
        p25: '$' + q(0.25).toFixed(0),
        p75: '$' + q(0.75).toFixed(0),
        p100: (ends.filter(e => e >= 100).length / RUNS * 100).toFixed(1) + '%',
        p500: (ends.filter(e => e >= 500).length / RUNS * 100).toFixed(1) + '%',
        p1k: (ends.filter(e => e >= 1000).length / RUNS * 100).toFixed(1) + '%',
        bustRaw: busts / RUNS,
        medRaw: q(0.5)
    };
}

// ──────────────────────────────────────────
// Replay window simulation (from fresh_micro_audit.js logic)
// ──────────────────────────────────────────
function simReplayWindows(trades, startBal, stakeFrac) {
    const globalMinCost = Math.min(...trades.map(t => MIN_ORDER_SHARES * Number(t.entryPrice)));
    const results = [];
    for (let i = 0; i < trades.length; i++) {
        const startTs = trades[i].cycleStartEpochSec || trades[i].cycleStartEpoch;
        const endTs = startTs + DAYS * DAY_SEC;
        let balance = startBal;
        let busted = false;
        let executed = 0;
        for (let j = i; j < trades.length; j++) {
            const t = trades[j];
            const ts = t.cycleStartEpochSec || t.cycleStartEpoch;
            if (ts >= endTs) break;
            const entryPrice = Number(t.entryPrice);
            const minOrderCost = MIN_ORDER_SHARES * entryPrice;
            if (balance < globalMinCost) { busted = true; break; }
            if (balance < minOrderCost) continue;
            let stake = Math.max(balance * stakeFrac, minOrderCost);
            stake = Math.min(stake, balance, MAX_ABS_STAKE);
            const won = !!(t.won === true || t.isWin === true || t.outcome === 'WIN');
            balance += tradePnl(stake, entryPrice, won);
            executed++;
            if (balance < globalMinCost) { busted = true; break; }
        }
        results.push({ endBalance: balance, busted, executed, startBalance: startBal });
    }
    const ends = results.map(r => r.endBalance).sort((a, b) => a - b);
    const busts = results.filter(r => r.busted).length;
    const q = p => ends[Math.floor(ends.length * p)] || 0;
    return {
        windows: results.length,
        bust: (busts / results.length * 100).toFixed(2) + '%',
        med: '$' + q(0.5).toFixed(0),
        p25: '$' + q(0.25).toFixed(0),
        p75: '$' + q(0.75).toFixed(0),
        p100: (results.filter(r => r.endBalance >= 100).length / results.length * 100).toFixed(1) + '%',
        p500: (results.filter(r => r.endBalance >= 500).length / results.length * 100).toFixed(1) + '%',
        p1k: (results.filter(r => r.endBalance >= 1000).length / results.length * 100).toFixed(1) + '%',
        bustRaw: busts / results.length,
        medRaw: q(0.5)
    };
}

// ══════════════════════════════════════════════════════════════
// MAIN INVESTIGATION
// ══════════════════════════════════════════════════════════════

console.log('╔══════════════════════════════════════════════════════════════════╗');
console.log('║  ADDENDUM W — FINAL INDEPENDENT INVESTIGATION                   ║');
console.log('║  200k IID Monte Carlo + Replay Window Analysis                  ║');
console.log('║  Date: 2026-03-09                                               ║');
console.log('╚══════════════════════════════════════════════════════════════════╝\n');

// ──────────────────────────────────────────
// SECTION 1: Strategy Set Fact Check
// ──────────────────────────────────────────
console.log('═══ SECTION 1: STRATEGY SET DATA QUALITY ═══\n');

const sets = {
    'highfreq_unique12': loadStrategySet('debug/strategy_set_highfreq_unique12.json'),
    'top7_drop6': loadStrategySet('debug/strategy_set_top7_drop6.json'),
    'top3_robust': loadStrategySet('debug/strategy_set_top3_robust.json'),
};

for (const [name, set] of Object.entries(sets)) {
    if (!set) { console.log(`${name}: FILE NOT FOUND`); continue; }
    const strats = set.strategies;
    const totalOOS = strats.reduce((s, x) => s + (x.oosTrades || 0), 0);
    const totalOOSWins = strats.reduce((s, x) => s + (x.oosWins || 0), 0);
    const totalHist = strats.reduce((s, x) => s + (x.historicalTrades || 0), 0);
    const totalLive = strats.reduce((s, x) => s + x.liveTrades, 0);
    const totalLiveWins = strats.reduce((s, x) => s + x.liveWins, 0);
    const oosEqualsHist = strats.every(s => s.oosTrades === s.historicalTrades && s.oosWins === s.historicalWins);
    const hasLive = totalLive > 0;
    
    console.log(`--- ${name} (${strats.length} strategies) ---`);
    console.log(`  Historical trades: ${totalHist}, WR: ${totalHist > 0 ? (strats.reduce((s,x) => s + (x.historicalWins||0), 0) / totalHist * 100).toFixed(1) : 'N/A'}%`);
    console.log(`  OOS trades: ${totalOOS}, WR: ${totalOOS > 0 ? (totalOOSWins / totalOOS * 100).toFixed(1) : 'N/A'}%`);
    console.log(`  Live trades: ${totalLive}, WR: ${totalLive > 0 ? (totalLiveWins / totalLive * 100).toFixed(1) : 'N/A'}%`);
    console.log(`  ⚠️ OOS == Historical? ${oosEqualsHist ? 'YES — NO REAL TRAIN/TEST SPLIT VISIBLE' : 'No (proper split)'}`);
    console.log(`  ⚠️ Has live data? ${hasLive ? 'YES' : 'NO — NEVER TESTED LIVE'}`);
    console.log(`  Generated: ${set.meta?.generatedAt || 'unknown'}`);
    console.log('');
}

// ──────────────────────────────────────────
// SECTION 2: Replay Ledger Analysis
// ──────────────────────────────────────────
console.log('═══ SECTION 2: REPLAY LEDGER TRUTH ═══\n');

const replays = {
    'highfreq_unique12': loadReplayLedger('debug/highfreq_unique12/hybrid_replay_executed_ledger.json'),
    'top7_drop6': loadReplayLedger('debug/final_set_scan/top7_drop6/hybrid_replay_executed_ledger.json'),
    'top3_robust': loadReplayLedger('debug/final_set_scan/top3_robust/hybrid_replay_executed_ledger.json'),
};

for (const [name, replay] of Object.entries(replays)) {
    if (!replay) { console.log(`${name}: REPLAY LEDGER NOT FOUND`); continue; }
    const set = sets[name];
    const fileWR = set ? (set.strategies.reduce((s,x) => s + (x.oosWins||0), 0) / set.strategies.reduce((s,x) => s + (x.oosTrades||0), 0)) : null;
    
    console.log(`--- ${name} ---`);
    console.log(`  Trades: ${replay.total}, Wins: ${replay.wins}, Replay WR: ${(replay.wr * 100).toFixed(1)}%`);
    console.log(`  Strategy file WR: ${fileWR ? (fileWR * 100).toFixed(1) : 'N/A'}%`);
    console.log(`  WR gap: ${fileWR ? ((fileWR - replay.wr) * 100).toFixed(1) : 'N/A'} percentage points`);
    console.log(`  Date range: ${replay.firstDate} to ${replay.lastDate} (${replay.spanDays} days)`);
    console.log(`  Trades/day: ${replay.tradesPerDay.toFixed(2)}`);
    console.log('');
}

// ──────────────────────────────────────────
// SECTION 3: Monte Carlo Simulations
// ──────────────────────────────────────────
console.log('═══ SECTION 3: IID MONTE CARLO (200k runs, 14 days) ═══\n');
console.log('Note: IID MC assumes trades are independent with WR from strategy file.\n');

const TRAIN_DAYS = 90;
const startBalances = [8, 10];
const stakeFracs = [0.30, 0.45, 0.60];

for (const [name, set] of Object.entries(sets)) {
    if (!set) continue;
    const strats = set.strategies.map(s => ({
        ...s,
        firesPerDay: (s.oosTrades || s.historicalTrades || 0) / TRAIN_DAYS,
        wr: s.winRate || (s.oosWins && s.oosTrades ? s.oosWins / s.oosTrades : 0)
    })).filter(s => s.wr > 0);
    
    const totalFires = strats.reduce((s, x) => s + x.firesPerDay, 0);
    const compWR = strats.reduce((s, x) => s + x.wr * (x.oosTrades || x.historicalTrades || 0), 0) /
                   strats.reduce((s, x) => s + (x.oosTrades || x.historicalTrades || 0), 0);
    
    console.log(`--- ${name} (WR=${(compWR*100).toFixed(1)}%, ${totalFires.toFixed(1)} fires/day) ---`);
    
    for (const sb of startBalances) {
        for (const sf of stakeFracs) {
            const r = simMonteCarlo(strats, sb, sf);
            console.log(`  $${sb}/${(sf*100)}%: Bust=${r.bust} Med=${r.med} P25=${r.p25} P75=${r.p75} P$100=${r.p100} P$1k=${r.p1k}`);
        }
    }
    // Pessimistic (-5pp WR)
    for (const sb of startBalances) {
        const r = simMonteCarlo(strats, sb, 0.45, -0.05);
        console.log(`  PESSIMISTIC $${sb}/45%: Bust=${r.bust} Med=${r.med} P$100=${r.p100} P$1k=${r.p1k}`);
    }
    console.log('');
}

// ──────────────────────────────────────────
// SECTION 4: Monte Carlo with LIVE WR (top7_drop6 only)
// ──────────────────────────────────────────
console.log('═══ SECTION 4: MONTE CARLO WITH LIVE WR (top7_drop6 only) ═══\n');
console.log('Using live WR of 90.5% (57/63 trades) — the ONLY live-validated WR.\n');

{
    const set = sets['top7_drop6'];
    if (set) {
        const totalLiveTrades = set.strategies.reduce((s, x) => s + x.liveTrades, 0);
        const totalLiveWins = set.strategies.reduce((s, x) => s + x.liveWins, 0);
        const liveWR = totalLiveWins / totalLiveTrades;
        
        const strats = set.strategies.map(s => ({
            ...s,
            firesPerDay: (s.oosTrades || s.historicalTrades || 0) / TRAIN_DAYS,
            wr: liveWR // Use uniform live WR
        }));
        
        for (const sb of startBalances) {
            for (const sf of stakeFracs) {
                const r = simMonteCarlo(strats, sb, sf);
                console.log(`  $${sb}/${(sf*100)}%: Bust=${r.bust} Med=${r.med} P25=${r.p25} P75=${r.p75} P$100=${r.p100} P$1k=${r.p1k}`);
            }
        }
        // Per-strategy live WR version
        console.log('\n  Using per-strategy live WR (where available, fallback to OOS):');
        const stratsPerLive = set.strategies.map(s => ({
            ...s,
            firesPerDay: (s.oosTrades || s.historicalTrades || 0) / TRAIN_DAYS,
            wr: s.liveTrades >= 5 ? (s.liveWins / s.liveTrades) : (s.oosWins / s.oosTrades)
        }));
        for (const sb of startBalances) {
            for (const sf of stakeFracs) {
                const r = simMonteCarlo(stratsPerLive, sb, sf);
                console.log(`  $${sb}/${(sf*100)}%: Bust=${r.bust} Med=${r.med} P25=${r.p25} P75=${r.p75} P$100=${r.p100} P$1k=${r.p1k}`);
            }
        }
    }
}
console.log('');

// ──────────────────────────────────────────
// SECTION 5: Replay Window Analysis
// ──────────────────────────────────────────
console.log('═══ SECTION 5: REPLAY WINDOW ANALYSIS (14-day windows) ═══\n');
console.log('Each starting trade index creates a 14-day forward window.\n');

for (const [name, replay] of Object.entries(replays)) {
    if (!replay || replay.total === 0) continue;
    console.log(`--- ${name} (${replay.total} trades, WR=${(replay.wr*100).toFixed(1)}%) ---`);
    for (const sb of startBalances) {
        for (const sf of stakeFracs) {
            const r = simReplayWindows(replay.trades, sb, sf);
            console.log(`  $${sb}/${(sf*100)}%: Bust=${r.bust} Med=${r.med} P25=${r.p25} P75=${r.p75} P$100=${r.p100} P$1k=${r.p1k} (${r.windows} windows)`);
        }
    }
    console.log('');
}

// ──────────────────────────────────────────
// SECTION 6: Monte Carlo with REPLAY WR
// ──────────────────────────────────────────
console.log('═══ SECTION 6: MONTE CARLO WITH REPLAY WR ═══\n');
console.log('Using actual replay WRs instead of strategy file WRs.\n');

for (const [name, replay] of Object.entries(replays)) {
    if (!replay || replay.total === 0) continue;
    const set = sets[name];
    if (!set) continue;
    
    const strats = set.strategies.map(s => ({
        ...s,
        firesPerDay: replay.tradesPerDay / set.strategies.length, // distribute evenly
        wr: replay.wr // Use replay WR
    }));
    
    console.log(`--- ${name} (replay WR=${(replay.wr*100).toFixed(1)}%, ${replay.tradesPerDay.toFixed(1)} trades/day) ---`);
    for (const sb of startBalances) {
        for (const sf of stakeFracs) {
            const r = simMonteCarlo(strats, sb, sf);
            console.log(`  $${sb}/${(sf*100)}%: Bust=${r.bust} Med=${r.med} P25=${r.p25} P75=${r.p75} P$100=${r.p100} P$1k=${r.p1k}`);
        }
    }
    console.log('');
}

// ──────────────────────────────────────────
// SECTION 7: UNIFIED COMPARISON TABLE
// ──────────────────────────────────────────
console.log('═══ SECTION 7: UNIFIED COMPARISON — $8 start, 45% stake ═══\n');

const comparisonRows = [];
for (const [name, set] of Object.entries(sets)) {
    if (!set) continue;
    const replay = replays[name];
    
    // IID with strategy file WR
    const stratsFile = set.strategies.map(s => ({
        ...s,
        firesPerDay: (s.oosTrades || s.historicalTrades || 0) / TRAIN_DAYS,
        wr: s.winRate || (s.oosWins && s.oosTrades ? s.oosWins / s.oosTrades : 0)
    })).filter(s => s.wr > 0);
    const iidFile = simMonteCarlo(stratsFile, 8, 0.45);
    
    // Replay window
    let replayResult = null;
    if (replay && replay.total > 0) {
        replayResult = simReplayWindows(replay.trades, 8, 0.45);
    }
    
    // IID with replay WR
    let iidReplay = null;
    if (replay && replay.total > 0) {
        const stratsReplay = set.strategies.map(s => ({
            ...s,
            firesPerDay: replay.tradesPerDay / set.strategies.length,
            wr: replay.wr
        }));
        iidReplay = simMonteCarlo(stratsReplay, 8, 0.45);
    }
    
    console.log(`${name}:`);
    console.log(`  IID (file WR):    Bust=${iidFile.bust} Med=${iidFile.med} P$1k=${iidFile.p1k}`);
    if (iidReplay) console.log(`  IID (replay WR):  Bust=${iidReplay.bust} Med=${iidReplay.med} P$1k=${iidReplay.p1k}`);
    if (replayResult) console.log(`  Replay windows:   Bust=${replayResult.bust} Med=${replayResult.med} P$1k=${replayResult.p1k}`);
    
    // Live WR (top7_drop6 only)
    const totalLive = set.strategies.reduce((s, x) => s + x.liveTrades, 0);
    if (totalLive >= 20) {
        const totalLiveWins = set.strategies.reduce((s, x) => s + x.liveWins, 0);
        const liveWR = totalLiveWins / totalLive;
        const stratsLive = set.strategies.map(s => ({
            ...s,
            firesPerDay: (s.oosTrades || s.historicalTrades || 0) / TRAIN_DAYS,
            wr: liveWR
        }));
        const iidLive = simMonteCarlo(stratsLive, 8, 0.45);
        console.log(`  IID (live WR):    Bust=${iidLive.bust} Med=${iidLive.med} P$1k=${iidLive.p1k} ← BEST EVIDENCE`);
    }
    console.log('');
}

// ──────────────────────────────────────────
// SECTION 8: FINAL RECOMMENDATION
// ──────────────────────────────────────────
console.log('═══ SECTION 8: FINAL RECOMMENDATION ═══\n');
console.log('Data quality ranking:');
console.log('  1. LIVE trade WR (only top7_drop6 has this: 57/63 = 90.5%)');
console.log('  2. Replay WR (historical simulation including oracle+strategy gating)');
console.log('  3. Strategy file OOS WR (may be optimistic, especially if OOS==Historical)');
console.log('');
console.log('top7_drop6 is the ONLY set with live trade validation.');
console.log('highfreq_unique12 has NO live data and its OOS==Historical (suspicious).');
console.log('');
console.log('For $8 starting balance with aggressive profile:');
console.log('  Best evidence-backed set: top7_drop6');
console.log('  Stake fraction: 45% (aggressive but survivable)');
console.log('  Expected frequency: ~3.4 trades/day (lower than highfreq but VERIFIED)');
console.log('');

// Final sim for recommended config
{
    const set = sets['top7_drop6'];
    if (set) {
        const totalLiveTrades = set.strategies.reduce((s, x) => s + x.liveTrades, 0);
        const totalLiveWins = set.strategies.reduce((s, x) => s + x.liveWins, 0);
        const liveWR = totalLiveWins / totalLiveTrades;
        
        const strats = set.strategies.map(s => ({
            ...s,
            firesPerDay: (s.oosTrades || 0) / TRAIN_DAYS,
            wr: liveWR
        }));
        
        console.log(`RECOMMENDED: top7_drop6 @ $8, 45% stake, live WR ${(liveWR*100).toFixed(1)}%`);
        const r = simMonteCarlo(strats, 8, 0.45);
        console.log(`  Result: Bust=${r.bust} Med=${r.med} P25=${r.p25} P75=${r.p75}`);
        console.log(`  P($100)=${r.p100} P($500)=${r.p500} P($1000)=${r.p1k}`);
        
        console.log('');
        console.log(`RECOMMENDED: top7_drop6 @ $10, 45% stake, live WR ${(liveWR*100).toFixed(1)}%`);
        const r10 = simMonteCarlo(strats, 10, 0.45);
        console.log(`  Result: Bust=${r10.bust} Med=${r10.med} P25=${r10.p25} P75=${r10.p75}`);
        console.log(`  P($100)=${r10.p100} P($500)=${r10.p500} P($1000)=${r10.p1k}`);
    }
}

console.log('\n═══ END OF INVESTIGATION ═══');
