#!/usr/bin/env node
/**
 * Elite Recency Strategy Builder + Full Profit Sim + Detailed Win/Loss Audit
 * 
 * Selects ONLY strategies with:
 * - Recent 7d WR >= 88% (elite tier)
 * - Trend RISING or STABLE (not declining)
 * - At least 8 trades in last 7 days (sufficient sample)
 * - Overall OOS WR >= 80%
 * 
 * Then compares against cherry-picked set with EXACT per-trade audit
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const ic = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'intracycle-price-data.json'), 'utf8'));
const cycles = ic.cycles || [];

// Load ALL strategy sets
const stratFiles = [
    'strategy_set_15m_24h_time_concentrated.json',
    'strategy_set_15m_maxgrowth_v5_tight.json',
    'strategy_set_15m_24h_filtered.json',
    'strategy_set_15m_beam_2739_uncapped.json',
    'strategy_set_15m_24h_ultra_tight.json',
    'strategy_set_15m_beam11_zero_bust.json',
    'strategy_set_15m_24h_dense.json',
    'strategy_set_15m_cherry_picked_high_wr.json',
];

const allStrategies = [];
const seen = new Set();

for (const f of stratFiles) {
    const fp = path.join(ROOT, 'strategies', f);
    if (!fs.existsSync(fp)) continue;
    const data = JSON.parse(fs.readFileSync(fp, 'utf8'));
    for (const s of (data.strategies || [])) {
        const key = `H${String(s.utcHour).padStart(2,'0')}_m${s.entryMinute}_${s.direction}_${s.priceMin}-${s.priceMax}`;
        if (!seen.has(key)) {
            seen.add(key);
            allStrategies.push({ ...s, _key: key, _source: f });
        }
    }
}

console.log(`Scanning ${allStrategies.length} unique strategies across ${cycles.length} cycles\n`);

function cycleDate(c) {
    return new Date(Number(c.epoch) * 1000).toISOString().slice(0, 10);
}

const sortedCycles = [...cycles].sort((a, b) => Number(a.epoch) - Number(b.epoch));
const allDates = [...new Set(sortedCycles.map(cycleDate))].sort();
console.log(`Data range: ${allDates[0]} to ${allDates[allDates.length - 1]} (${allDates.length} days)\n`);

function evaluateStrategy(strat) {
    const dailyStats = {};
    let totalWin = 0, totalLoss = 0;

    for (const cycle of sortedCycles) {
        const sAsset = (strat.asset || '*').toUpperCase();
        if (sAsset !== '*' && sAsset !== 'ALL' && cycle.asset.toUpperCase() !== sAsset) continue;

        const epoch = Number(cycle.epoch);
        const utcHour = new Date(epoch * 1000).getUTCHours();
        if (strat.utcHour !== -1 && strat.utcHour !== utcHour) continue;

        const dir = strat.direction;
        const priceData = dir === 'UP' ? cycle.minutePricesYes : cycle.minutePricesNo;
        if (!priceData) continue;

        const minData = priceData[String(strat.entryMinute)];
        if (!minData) continue;

        const entryPrice = Number(minData.last);
        if (!Number.isFinite(entryPrice)) continue;
        if (entryPrice < (strat.priceMin || 0) || entryPrice > (strat.priceMax || 1)) continue;

        const resolution = cycle.resolution;
        if (resolution === undefined || resolution === null) continue;

        const resUp = resolution === 1 || resolution === 'UP' || resolution === 'up';
        const won = (dir === 'UP' && resUp) || (dir === 'DOWN' && !resUp);
        const date = cycleDate(cycle);

        if (!dailyStats[date]) dailyStats[date] = { wins: 0, losses: 0, trades: 0, entries: [] };
        dailyStats[date].trades++;
        if (won) { dailyStats[date].wins++; totalWin++; }
        else { dailyStats[date].losses++; totalLoss++; }
        dailyStats[date].entries.push({ epoch, asset: cycle.asset, price: entryPrice, won, utcHour, dir });
    }

    return { dailyStats, totalWin, totalLoss, totalTrades: totalWin + totalLoss };
}

// Evaluate all
const results = [];
for (const strat of allStrategies) {
    const eval_ = evaluateStrategy(strat);
    if (eval_.totalTrades < 8) continue;

    const last3Days = allDates.slice(-3);
    const last5Days = allDates.slice(-5);
    const last7Days = allDates.slice(-7);
    const first7Days = allDates.slice(0, 7);

    const windowStats = (days) => {
        let w = 0, l = 0;
        for (const d of days) {
            if (eval_.dailyStats[d]) { w += eval_.dailyStats[d].wins; l += eval_.dailyStats[d].losses; }
        }
        return { wins: w, losses: l, trades: w + l, wr: (w + l) > 0 ? w / (w + l) : null };
    };

    const recent3 = windowStats(last3Days);
    const recent5 = windowStats(last5Days);
    const recent7 = windowStats(last7Days);
    const early7 = windowStats(first7Days);
    const overall = { wins: eval_.totalWin, losses: eval_.totalLoss, trades: eval_.totalTrades, wr: eval_.totalWin / eval_.totalTrades };

    let trend = 'UNKNOWN', trendScore = 0;
    if (early7.trades >= 3 && recent7.trades >= 3) {
        const delta = (recent7.wr || 0) - (early7.wr || 0);
        trendScore = delta;
        if (delta > 0.05) trend = 'RISING';
        else if (delta > -0.05) trend = 'STABLE';
        else trend = 'DECLINING';
    }

    results.push({
        key: strat._key, source: strat._source, strat,
        overall, recent3, recent5, recent7, early7,
        trend, trendScore, dailyStats: eval_.dailyStats,
    });
}

// ============ ELITE SELECTION ============
// Tier 1: recent7d WR >= 90%, RISING/STABLE, >=8 trades in 7d
const tier1 = results.filter(r =>
    (r.trend === 'RISING' || r.trend === 'STABLE') &&
    r.recent7.trades >= 8 &&
    (r.recent7.wr || 0) >= 0.88 &&
    r.overall.wr >= 0.80
).sort((a, b) => (b.recent7.wr || 0) - (a.recent7.wr || 0));

console.log(`=== TIER 1: ELITE RECENT (7d WR>=88%, RISING/STABLE, n>=8) — ${tier1.length} strategies ===\n`);
for (const r of tier1) {
    const tag = r.trend === 'RISING' ? '📈' : '➡️';
    console.log(`${tag} ${r.key} | ${r.trend} (${(r.trendScore * 100).toFixed(1)}pp) | Overall: ${r.overall.trades}t ${(r.overall.wr * 100).toFixed(1)}% | 7d: ${r.recent7.trades}t ${(r.recent7.wr * 100).toFixed(1)}% | 3d: ${r.recent3.trades}t ${r.recent3.trades > 0 ? (r.recent3.wr * 100).toFixed(1) + '%' : 'N/A'}`);
}

// ============ PER-DAY AUDIT: ELITE SET ============
console.log(`\n=== PER-DAY WIN/LOSS AUDIT (ELITE SET) ===\n`);
for (const date of allDates) {
    let dw = 0, dl = 0;
    for (const r of tier1) {
        if (r.dailyStats[date]) { dw += r.dailyStats[date].wins; dl += r.dailyStats[date].losses; }
    }
    const dt = dw + dl;
    if (dt === 0) { console.log(`${date}: 0 trades`); continue; }
    const wr = (dw / dt * 100).toFixed(1);
    console.log(`${date}: ${String(dt).padStart(3)}t ${String(dw).padStart(3)}W ${String(dl).padStart(2)}L WR=${wr}%`);
}

// ============ LAST 7 DAYS EXACT TRADE-BY-TRADE AUDIT ============
console.log(`\n=== EXACT TRADE-BY-TRADE: LAST 48 HOURS (ELITE SET) ===\n`);
const last2Days = allDates.slice(-2);
for (const r of tier1) {
    for (const d of last2Days) {
        if (!r.dailyStats[d]) continue;
        for (const e of r.dailyStats[d].entries) {
            const ts = new Date(e.epoch * 1000).toISOString().slice(0, 16);
            console.log(`${ts} ${r.key} ${e.asset} @${e.price.toFixed(3)} ${e.won ? '✅' : '❌'}`);
        }
    }
}

// ============ BANKROLL SIM ============
const FEE = 0.0315;
const MIN_SHARES = 5;
const SF = 0.15;

function simBankroll(selectedStrats, startDate) {
    let bankroll = 5.0;
    let trades = 0, wins = 0, maxDD = 0, peak = bankroll;
    const tradeLog = [];

    const allTrades = [];
    for (const r of selectedStrats) {
        for (const [date, ds] of Object.entries(r.dailyStats)) {
            if (date < startDate) continue;
            for (const e of ds.entries) {
                allTrades.push({ ...e, stratKey: r.key });
            }
        }
    }
    allTrades.sort((a, b) => a.epoch - b.epoch);

    const byCycle = {};
    for (const t of allTrades) {
        const cycleEpoch = Math.floor(t.epoch / 900) * 900;
        if (!byCycle[cycleEpoch]) byCycle[cycleEpoch] = [];
        byCycle[cycleEpoch].push(t);
    }

    for (const [cycleEpoch, cycleTrades] of Object.entries(byCycle).sort((a, b) => a[0] - b[0])) {
        if (bankroll < 2.0) break;
        const trade = cycleTrades[0]; // MPC=1
        const stake = Math.max(bankroll * SF, MIN_SHARES * trade.price);
        if (stake > bankroll) continue;
        const shares = Math.floor((stake / trade.price) + 0.0001);
        if (shares < MIN_SHARES) continue;
        const cost = shares * trade.price;
        if (cost > bankroll) continue;

        if (trade.won) {
            const grossProfit = shares * (1 - trade.price);
            const fee = grossProfit * FEE;
            bankroll += grossProfit - fee;
            wins++;
        } else {
            bankroll -= cost;
        }
        trades++;
        peak = Math.max(peak, bankroll);
        const dd = peak > 0 ? (peak - bankroll) / peak : 0;
        maxDD = Math.max(maxDD, dd);
        tradeLog.push({
            date: new Date(Number(cycleEpoch) * 1000).toISOString().slice(0, 16),
            asset: trade.asset, won: trade.won, price: trade.price, bankroll: bankroll.toFixed(2), strat: trade.stratKey
        });
    }
    return { bankroll, trades, wins, wr: trades > 0 ? wins / trades : 0, maxDD, tradeLog };
}

console.log(`\n=== MULTI-START BANKROLL SIM: ELITE SET ($5 start, MPC=1) ===\n`);
let busts = 0;
const survivors = [];
for (const sd of allDates) {
    const result = simBankroll(tier1, sd);
    const isBust = result.bankroll < 2.0;
    if (isBust) busts++;
    else survivors.push(result.bankroll);
    console.log(`Start ${sd}: $5->$${result.bankroll.toFixed(2)} | ${result.trades}t ${result.wins}w WR=${(result.wr * 100).toFixed(0)}% | DD=${(result.maxDD * 100).toFixed(0)}% | ${isBust ? 'BUST' : 'OK'}`);
}
survivors.sort((a, b) => a - b);
console.log(`\nBust rate: ${busts}/${allDates.length} (${(busts / allDates.length * 100).toFixed(0)}%)`);
if (survivors.length > 0) {
    console.log(`Survivors: median=$${survivors[Math.floor(survivors.length / 2)].toFixed(2)} p25=$${survivors[Math.floor(survivors.length * 0.25)].toFixed(2)}`);
}

// ============ DETAILED PROFIT TRAJECTORY (START FROM BEST RECENT DAY) ============
console.log(`\n=== FULL TRADE LOG: START ${allDates[allDates.length - 7]} (7 days ago) ===\n`);
const fullRun = simBankroll(tier1, allDates[allDates.length - 7]);
for (const t of fullRun.tradeLog.slice(0, 60)) {
    console.log(`${t.date} ${t.strat.padEnd(30)} ${t.asset.padEnd(4)} @${t.price.toFixed(3)} ${t.won ? '✅' : '❌'} → $${t.bankroll}`);
}
if (fullRun.tradeLog.length > 60) console.log(`... (${fullRun.tradeLog.length - 60} more trades)`);
console.log(`\n7-day run: ${fullRun.trades}t ${fullRun.wins}w ${fullRun.trades - fullRun.wins}l WR=${(fullRun.wr * 100).toFixed(1)}% Final=$${fullRun.bankroll.toFixed(2)} MaxDD=${(fullRun.maxDD * 100).toFixed(0)}%`);

// ============ CHERRY-PICKED COMPARISON ============
console.log(`\n=== COMPARISON: CHERRY-PICKED LAST 7 DAYS ===\n`);
const cherryPath = path.join(ROOT, 'strategies', 'strategy_set_15m_cherry_picked_high_wr.json');
if (fs.existsSync(cherryPath)) {
    const cherry = JSON.parse(fs.readFileSync(cherryPath, 'utf8'));
    const cherryResults = [];
    for (const s of cherry.strategies) {
        const eval_ = evaluateStrategy(s);
        if (eval_.totalTrades >= 1) {
            const last7 = allDates.slice(-7);
            const windowStats = (days) => {
                let w = 0, l = 0;
                for (const d of days) { if (eval_.dailyStats[d]) { w += eval_.dailyStats[d].wins; l += eval_.dailyStats[d].losses; } }
                return { wins: w, losses: l, trades: w + l, wr: (w + l) > 0 ? w / (w + l) : null };
            };
            cherryResults.push({ strat: s, dailyStats: eval_.dailyStats, recent7: windowStats(last7), overall: { trades: eval_.totalTrades, wr: eval_.totalWin / eval_.totalTrades } });
        }
    }

    // Per-day cherry WR
    for (const date of allDates.slice(-7)) {
        let cw = 0, cl = 0;
        for (const r of cherryResults) {
            if (r.dailyStats[date]) { cw += r.dailyStats[date].wins; cl += r.dailyStats[date].losses; }
        }
        const ct = cw + cl;
        if (ct === 0) { console.log(`${date}: 0 trades`); continue; }
        console.log(`${date}: ${String(ct).padStart(3)}t ${String(cw).padStart(3)}W ${String(cl).padStart(2)}L WR=${(cw / ct * 100).toFixed(1)}%`);
    }

    // Cherry bankroll sim from 7 days ago
    const cherrySimResults = [];
    for (const s of cherry.strategies) {
        const ev = evaluateStrategy(s);
        const key = `H${String(s.utcHour).padStart(2,'0')}_m${s.entryMinute}_${s.direction}_${s.priceMin}-${s.priceMax}`;
        cherrySimResults.push({ key, strat: s, dailyStats: ev.dailyStats });
    }
    const cherrySim = simBankroll(cherrySimResults, allDates[allDates.length - 7]);
    console.log(`\nCherry-picked 7-day: ${cherrySim.trades}t ${cherrySim.wins}w WR=${(cherrySim.wr * 100).toFixed(1)}% Final=$${cherrySim.bankroll.toFixed(2)} DD=${(cherrySim.maxDD * 100).toFixed(0)}%`);
}

// ============ SAVE ELITE SET ============
const outputSet = {
    name: 'elite_recency_optimized',
    description: `Elite recency-optimized: ${tier1.length} strategies with recent 7d WR>=88%, RISING/STABLE trend. Best for next-few-days deployment.`,
    generatedAt: new Date().toISOString(),
    oosValidation: {
        period: `${allDates[0]} to ${allDates[allDates.length - 1]}`,
        recentPeriod: `${allDates.slice(-7)[0]} to ${allDates[allDates.length - 1]}`,
        totalStrategies: tier1.length,
    },
    strategies: tier1.map(r => {
        const s = { ...r.strat };
        delete s._key;
        delete s._source;
        s.oosWR = (r.overall.wr * 100).toFixed(1) + '%';
        s.recent7dWR = (r.recent7.wr * 100).toFixed(1) + '%';
        s.recent3dWR = r.recent3.trades > 0 ? (r.recent3.wr * 100).toFixed(1) + '%' : 'N/A';
        s.trend = r.trend;
        s.trendDelta = (r.trendScore * 100).toFixed(1) + 'pp';
        s.oosMatches = r.overall.trades;
        return s;
    }),
};

const outPath = path.join(ROOT, 'strategies', 'strategy_set_15m_elite_recency.json');
fs.writeFileSync(outPath, JSON.stringify(outputSet, null, 2));
console.log(`\nSaved elite recency set to ${path.basename(outPath)} (${outputSet.strategies.length} strategies)`);

// ============ FINAL VERDICT ============
console.log(`\n${'='.repeat(70)}`);
console.log(`FINAL VERDICT`);
console.log(`${'='.repeat(70)}\n`);

// Aggregate recent stats for elite set
let r7w = 0, r7l = 0, r3w = 0, r3l = 0;
for (const r of tier1) {
    r7w += r.recent7.wins; r7l += r.recent7.losses;
    r3w += r.recent3.wins; r3l += r.recent3.losses;
}
console.log(`Elite set: ${tier1.length} strategies`);
console.log(`  Last 7 days: ${r7w + r7l} trades, ${r7w}W ${r7l}L, WR=${(r7w / (r7w + r7l) * 100).toFixed(1)}%`);
console.log(`  Last 3 days: ${r3w + r3l} trades, ${r3w}W ${r3l}L, WR=${(r3w / (r3w + r3l) * 100).toFixed(1)}%`);
console.log(`  Bust rate at $5: ${busts}/${allDates.length} (${(busts / allDates.length * 100).toFixed(0)}%)`);
console.log(`  UTC hours covered: ${[...new Set(tier1.map(r => r.strat.utcHour))].sort((a,b)=>a-b).join(', ')}`);
