#!/usr/bin/env node
// Exact-runtime profit sim for the final 15m finalists using held-out historical
// + recent trade calendars only. Includes actual chronological path and a 30-day
// block-bootstrap distribution from the same day buckets.

const fs = require('fs');
const path = require('path');
const CONFIG = require('../lib/config');
const RiskManager = require('../lib/risk-manager');

const ROOT = path.join(__dirname, '..');
const START_BALANCE = Number(process.env.START_BALANCE || 20);
const MIN_RUNTIME_BANKROLL = Number(process.env.MIN_RUNTIME_BANKROLL || 5);
const TRIALS = Number(process.env.TRIALS || 5000);
const BOOTSTRAP_DAYS = Number(process.env.SIM_DAYS || 30);
const BLOCK_DAYS = Number(process.env.BLOCK_DAYS || 7);
const WINDOW_DAYS = 7;
const STEP_DAYS = 3;
const TAKER_FEE = 0.0315;
const DEFAULT_MIN_ORDER_SHARES = 5;
const MAX_ALLOWED_SPREAD_DEVIATION = 0.08;
const TIMEFRAME = '15m';
const CYCLE_SECONDS = 900;
const OUTPUT_PATH = path.join(ROOT, 'debug', 'profit_sim_exhaustive_nc13_guarded.json');

function readJson(p) { return JSON.parse(fs.readFileSync(path.isAbsolute(p) ? p : path.join(ROOT, p), 'utf8')); }
function writeJson(p, v) { fs.writeFileSync(p, JSON.stringify(v, null, 2)); }
function round(v, d = 4) { if (!Number.isFinite(Number(v))) return 0; const f = Math.pow(10, d); return Math.round(Number(v) * f) / f; }
function percentile(sorted, p) { if (!sorted.length) return 0; const i = (sorted.length - 1) * p; const lo = Math.floor(i); const hi = Math.ceil(i); if (lo === hi) return sorted[lo]; return sorted[lo] * (1 - (i - lo)) + sorted[hi] * (i - lo); }
function dayKeyFromEpoch(e) { return new Date(Number(e) * 1000).toISOString().slice(0, 10); }
function nextDay(d) { const dt = new Date(`${d}T00:00:00.000Z`); dt.setUTCDate(dt.getUTCDate() + 1); return dt.toISOString().slice(0, 10); }
function enumerateDayRange(s, e) { if (!s || !e) return []; const days = []; let c = s; while (c <= e) { days.push(c); c = nextDay(c); } return days; }
function candidateKey(c) { return [String(c.asset || 'ALL').toUpperCase(), Number(c.utcHour), Number(c.entryMinute), String(c.direction || '').toUpperCase(), Number(c.priceMin).toFixed(2), Number(c.priceMax).toFixed(2)].join('|'); }
function parseCandidateKey(k) { const [asset, utcHour, entryMinute, direction, priceMin, priceMax] = String(k).split('|'); return { asset, utcHour: Number(utcHour), entryMinute: Number(entryMinute), direction, priceMin: Number(priceMin), priceMax: Number(priceMax) }; }
function normalizeReportCandidate(raw) {
    const base = parseCandidateKey(raw.key);
    return {
        ...base,
        key: raw.key,
        name: raw.name,
        sources: raw.sources || [],
        pWinEstimate: Math.max(0.5, Number(raw?.metrics?.train?.lcb || 0.5)),
        evWinEstimate: Math.max(0.5, Number(raw?.pWinEstimate ?? raw?.metrics?.train?.wr ?? raw?.winRate ?? raw?.metrics?.train?.lcb ?? 0.5)),
        metrics: raw.metrics || {}
    };
}
function candidateFromArtifact(universe, strategy) {
    const key = candidateKey({
        asset: String(strategy.asset || 'ALL').toUpperCase(),
        utcHour: Number(strategy.utcHour),
        entryMinute: Number(strategy.entryMinute),
        direction: String(strategy.direction || '').toUpperCase(),
        priceMin: Number(strategy.priceMin),
        priceMax: Number(strategy.priceMax)
    });
    return universe.find(c => c.key === key);
}
function sampleInt(n) { return Math.floor(Math.random() * n); }
function estimateNetEdgeRoi(entryPrice, pWinEstimate) {
    const entry = Number(entryPrice);
    const pWin = Number(pWinEstimate);
    if (!(entry > 0) || entry >= 1 || !(pWin > 0) || pWin >= 1) return null;
    const effectiveEntry = Math.min(0.99, entry * (1 + Number(CONFIG?.RISK?.slippagePct || 0)));
    if (!(effectiveEntry > 0) || effectiveEntry >= 1) return null;
    const winProfitPerDollar = ((1 - effectiveEntry) * (1 - Number(CONFIG?.RISK?.takerFeePct || TAKER_FEE))) / effectiveEntry;
    return (pWin * winProfitPerDollar) - (1 - pWin);
}

function matchHistoricalRow(cand, row) {
    const epoch = Number(row.cycleStartEpochSec); if (!Number.isFinite(epoch)) return null;
    if (cand.asset !== 'ALL' && String(row.asset || '').toUpperCase() !== cand.asset) return null;
    if (cand.utcHour !== -1 && Number(row.utcHour) !== cand.utcHour) return null;
    if (Number(row.entryMinute) !== cand.entryMinute) return null;
    const up = Number(row.upPrice), dn = Number(row.downPrice);
    if (!Number.isFinite(up) || !Number.isFinite(dn) || up <= 0 || up >= 1 || dn <= 0 || dn >= 1) return null;
    if (Math.abs((up + dn) - 1) > MAX_ALLOWED_SPREAD_DEVIATION) return null;
    const entry = cand.direction === 'UP' ? up : dn;
    if (entry < cand.priceMin || entry > cand.priceMax) return null;
    return { asset: String(row.asset || '').toUpperCase(), epoch, entryPrice: entry, won: String(row.resolvedOutcome || '').toUpperCase() === cand.direction };
}
function recentCycleMatch(cand, cycle) {
    const epoch = Number(cycle.epoch); if (!Number.isFinite(epoch)) return null;
    const utcHour = new Date(epoch * 1000).getUTCHours();
    if (cand.utcHour !== -1 && cand.utcHour !== utcHour) return null;
    if (cand.asset !== 'ALL' && String(cycle.asset || '').toUpperCase() !== cand.asset) return null;
    const priceMap = cand.direction === 'UP' ? cycle.minutePricesYes : cycle.minutePricesNo;
    const pd = priceMap?.[cand.entryMinute]; if (!pd) return null;
    const entry = Number(pd.last); if (!Number.isFinite(entry)) return null;
    if (entry < cand.priceMin || entry > cand.priceMax) return null;
    const opp = cand.direction === 'UP' ? cycle.minutePricesNo : cycle.minutePricesYes;
    const oppP = Number(opp?.[cand.entryMinute]?.last);
    if (Number.isFinite(oppP) && Math.abs((entry + oppP) - 1) > MAX_ALLOWED_SPREAD_DEVIATION) return null;
    const minRaw = cand.direction === 'UP' ? (cycle.yesMinOrderSize ?? cycle.orderMinSize) : (cycle.noMinOrderSize ?? cycle.orderMinSize);
    const minShares = Number.isFinite(Number(minRaw)) && Number(minRaw) > 0 ? Math.max(DEFAULT_MIN_ORDER_SHARES, Math.ceil(Number(minRaw))) : DEFAULT_MIN_ORDER_SHARES;
    return { epoch, entryPrice: entry, minOrderShares: minShares, won: String(cycle.resolution || '').toUpperCase() === cand.direction };
}
function buildHistoricalTrades(rows, cand) {
    const trades = [];
    for (const row of rows) {
        const h = matchHistoricalRow(cand, row);
        if (!h) continue;
        const ts = h.epoch + cand.entryMinute * 60;
        const dk = dayKeyFromEpoch(ts);
        const ds = Math.floor(Date.parse(`${dk}T00:00:00.000Z`) / 1000);
        trades.push({ candidateKey: cand.key, timeframe: TIMEFRAME, asset: h.asset, dayKey: dk, cycleEpoch: h.epoch, cycleKey: `${TIMEFRAME}_${h.epoch}`, entryTs: ts, exitTs: h.epoch + CYCLE_SECONDS, entryOffsetSec: ts - ds, exitOffsetSec: (h.epoch + CYCLE_SECONDS) - ds, entryPrice: h.entryPrice, pWinEstimate: cand.pWinEstimate, evWinEstimate: cand.evWinEstimate || cand.pWinEstimate, won: h.won, minOrderShares: DEFAULT_MIN_ORDER_SHARES });
    }
    return trades;
}
function buildRecentTrades(cycles, cand) {
    const trades = [];
    for (const cycle of cycles) {
        const h = recentCycleMatch(cand, cycle);
        if (!h) continue;
        const ts = h.epoch + cand.entryMinute * 60;
        const dk = dayKeyFromEpoch(ts);
        const ds = Math.floor(Date.parse(`${dk}T00:00:00.000Z`) / 1000);
        trades.push({ candidateKey: cand.key, timeframe: TIMEFRAME, asset: String(cycle.asset || '').toUpperCase(), dayKey: dk, cycleEpoch: h.epoch, cycleKey: `${TIMEFRAME}_${h.epoch}`, entryTs: ts, exitTs: h.epoch + CYCLE_SECONDS, entryOffsetSec: ts - ds, exitOffsetSec: (h.epoch + CYCLE_SECONDS) - ds, entryPrice: h.entryPrice, pWinEstimate: cand.pWinEstimate, evWinEstimate: cand.evWinEstimate || cand.pWinEstimate, won: h.won, minOrderShares: h.minOrderShares });
    }
    return trades;
}
function groupTradesByDay(trades) {
    const map = new Map();
    for (const t of trades) { if (!map.has(t.dayKey)) map.set(t.dayKey, []); map.get(t.dayKey).push(t); }
    return [...map.entries()].map(([dk, dt]) => ({ dayKey: dk, trades: dt.sort((a, b) => a.entryOffsetSec !== b.entryOffsetSec ? a.entryOffsetSec - b.entryOffsetSec : b.pWinEstimate !== a.pWinEstimate ? b.pWinEstimate - a.pWinEstimate : a.entryPrice - b.entryPrice) })).sort((a, b) => a.dayKey.localeCompare(b.dayKey));
}
function getMaxPerCycle(bankroll) { return bankroll < 10 ? 1 : 2; }
function runSimulationSequence(dayBuckets, startBal, seqKeys) {
    const rm = new RiskManager(startBal);
    const st = { bankroll: startBal, peakBalance: startBal, dayStartBalance: startBal, todayPnL: 0, cooldownUntilSec: -Infinity, consecutiveLosses: 0, totalTrades: 0, totalWins: 0, openPositions: [] };
    const bucketMap = new Map(dayBuckets.map(b => [b.dayKey, b]));
    const dailyPath = [];
    function settlePosition(position) {
        if (position.won) {
            const grossProfit = position.shares - position.cost;
            const fee = Math.max(0, grossProfit) * TAKER_FEE;
            const netPayout = position.shares - fee;
            const pnl = netPayout - position.cost;
            st.bankroll += netPayout;
            st.todayPnL += pnl;
            st.totalWins++;
            st.consecutiveLosses = 0;
            if (st.bankroll > st.peakBalance) st.peakBalance = st.bankroll;
        } else {
            st.todayPnL -= position.cost;
            st.consecutiveLosses++;
            if (st.consecutiveLosses >= 4) { st.cooldownUntilSec = position.exitTs + 600; st.consecutiveLosses = 0; }
        }
        st.totalTrades++;
    }
    function settleUpTo(untilTs) {
        st.openPositions.sort((a, b) => a.exitTs - b.exitTs);
        while (st.openPositions.length && st.openPositions[0].exitTs <= untilTs) settlePosition(st.openPositions.shift());
    }
    for (let index = 0; index < seqKeys.length; index++) {
        if (st.bankroll < 2) break;
        const dayKey = seqKeys[index];
        const bucket = bucketMap.get(dayKey);
        const dayStartTs = index * 86400;
        const dayEndTs = dayStartTs + 86400;
        settleUpTo(dayStartTs);
        st.dayStartBalance = st.bankroll;
        st.todayPnL = 0;
        let dayStopped = false;
        const cycleCounts = {};
        const trades = (bucket?.trades || []).map(trade => ({ ...trade, entryTs: dayStartTs + trade.entryOffsetSec, exitTs: dayStartTs + trade.exitOffsetSec }));
        for (const trade of trades) {
            settleUpTo(trade.entryTs);
            if (st.bankroll < 2) break;
            if (st.bankroll < MIN_RUNTIME_BANKROLL) continue;
            if (dayStopped) continue;
            if (trade.entryTs < st.cooldownUntilSec) continue;
            if (st.todayPnL < -(st.dayStartBalance * 0.20)) { dayStopped = true; continue; }
            const maxPerCycle = getMaxPerCycle(st.bankroll);
            const cycleCount = cycleCounts[trade.cycleKey] || 0;
            if (cycleCount >= maxPerCycle) continue;
            const netEdgeRoi = estimateNetEdgeRoi(trade.entryPrice, trade.evWinEstimate ?? trade.pWinEstimate);
            if (!Number.isFinite(netEdgeRoi) || netEdgeRoi < Number(CONFIG?.RISK?.minNetEdgeRoi || 0)) continue;
            rm.bankroll = st.bankroll;
            rm.peakBalance = st.peakBalance;
            const openExposureUsd = st.openPositions.reduce((sum, position) => sum + Number(position.cost || 0), 0);
            const sizing = rm.calculateSize(
                { entryPrice: trade.entryPrice, pWinEstimate: trade.pWinEstimate, minOrderShares: trade.minOrderShares || DEFAULT_MIN_ORDER_SHARES, timeframe: trade.timeframe, epoch: trade.cycleEpoch },
                { availableCash: st.bankroll, openExposureUsd, bankrollEstimate: st.bankroll + openExposureUsd }
            );
            if (sizing.blocked || sizing.size <= 0) continue;
            const shares = Math.floor(sizing.size / trade.entryPrice + 1e-9);
            if (shares < (trade.minOrderShares || DEFAULT_MIN_ORDER_SHARES)) continue;
            const cost = shares * trade.entryPrice;
            if (cost > st.bankroll) continue;
            st.bankroll -= cost;
            cycleCounts[trade.cycleKey] = cycleCount + 1;
            st.openPositions.push({ exitTs: trade.exitTs, cost, shares, won: trade.won });
        }
        settleUpTo(dayEndTs);
        dailyPath.push({ day: dayKey, balance: round(st.bankroll, 2) });
    }
    settleUpTo(Number.MAX_SAFE_INTEGER);
    let peak = startBal;
    let maxDrawdown = 0;
    for (const point of dailyPath) {
        if (point.balance > peak) peak = point.balance;
        if (peak > 0) {
            const dd = (peak - point.balance) / peak;
            if (dd > maxDrawdown) maxDrawdown = dd;
        }
    }
    return {
        finalBalance: round(st.bankroll, 2),
        busted: st.bankroll < 2,
        totalTrades: st.totalTrades,
        totalWins: st.totalWins,
        winRate: st.totalTrades > 0 ? round(st.totalWins / st.totalTrades) : 0,
        maxDrawdown: round(maxDrawdown),
        path: dailyPath
    };
}
function slidingWindowSummary(dayBuckets, fullSeq, startBal, windowDays, stepDays) {
    if (!fullSeq.length) return null;
    const actualWindowDays = Math.min(windowDays, fullSeq.length);
    const windows = [];
    for (let i = 0; i + actualWindowDays <= fullSeq.length; i += stepDays) {
        const seq = fullSeq.slice(i, i + actualWindowDays);
        const result = runSimulationSequence(dayBuckets, startBal, seq);
        windows.push({ start: seq[0], end: seq[seq.length - 1], finalBalance: result.finalBalance, busted: result.busted });
    }
    const finals = windows.map(w => w.finalBalance).sort((a, b) => a - b);
    const bustCount = windows.filter(w => w.busted).length;
    return { windowCount: windows.length, bustRate: round(bustCount / Math.max(1, windows.length)), p25: round(percentile(finals, 0.25)), min: round(finals[0]), median: round(percentile(finals, 0.5)), max: round(finals[finals.length - 1]) };
}
function buildCombinedDayBuckets(strategies, tradeIndex) {
    const allTrades = [];
    for (const s of strategies) {
        const pre = tradeIndex.get(s.key);
        if (!pre) continue;
        allTrades.push(...pre.historicalTrades, ...pre.recentTrades);
    }
    return groupTradesByDay(allTrades);
}
function evaluateSet(label, strategies, tradeIndex, fullSeq) {
    const dayBuckets = buildCombinedDayBuckets(strategies, tradeIndex);
    const actual = runSimulationSequence(dayBuckets, START_BALANCE, fullSeq);
    const windows = slidingWindowSummary(dayBuckets, fullSeq, START_BALANCE, WINDOW_DAYS, STEP_DAYS);
    return {
        label,
        strategyCount: strategies.length,
        actual,
        windows,
        robustFloor: round(Math.min(actual.finalBalance, windows ? windows.p25 : actual.finalBalance))
    };
}
function bootstrapSequence(fullSeq, blockDays, targetDays) {
    const out = [];
    while (out.length < targetDays) {
        const start = sampleInt(fullSeq.length);
        for (let i = 0; i < blockDays && out.length < targetDays; i++) {
            out.push(fullSeq[(start + i) % fullSeq.length]);
        }
    }
    return out;
}
function bootstrapSummary(dayBuckets, fullSeq) {
    const finals = [];
    let busts = 0;
    let totalTrades = 0;
    let totalWinRate = 0;
    let totalDD = 0;
    for (let t = 0; t < TRIALS; t++) {
        const seq = bootstrapSequence(fullSeq, BLOCK_DAYS, BOOTSTRAP_DAYS);
        const result = runSimulationSequence(dayBuckets, START_BALANCE, seq);
        finals.push(result.finalBalance);
        if (result.busted) busts++;
        totalTrades += result.totalTrades;
        totalWinRate += result.winRate;
        totalDD += result.maxDrawdown;
    }
    finals.sort((a, b) => a - b);
    return {
        trials: TRIALS,
        simDays: BOOTSTRAP_DAYS,
        blockDays: BLOCK_DAYS,
        bustRate: round(busts / TRIALS),
        avgTrades: round(totalTrades / TRIALS, 1),
        avgWinRate: round(totalWinRate / TRIALS),
        avgMaxDrawdown: round(totalDD / TRIALS),
        finalBalance: {
            min: round(finals[0], 2),
            p10: round(percentile(finals, 0.10), 2),
            p25: round(percentile(finals, 0.25), 2),
            median: round(percentile(finals, 0.50), 2),
            p75: round(percentile(finals, 0.75), 2),
            p90: round(percentile(finals, 0.90), 2),
            max: round(finals[finals.length - 1], 2)
        }
    };
}
function milestones(path, marks) {
    return marks.map(dayIndex => {
        const idx = Math.min(Math.max(0, dayIndex - 1), path.length - 1);
        return path[idx] ? { day: dayIndex, date: path[idx].day, balance: path[idx].balance } : null;
    }).filter(Boolean);
}

console.error('Loading datasets...');
const dataset = readJson('exhaustive_analysis/decision_dataset.json');
const rows = Array.isArray(dataset) ? dataset : (dataset.rows || []);
const allRecentCycles = readJson('data/intracycle-price-data.json').cycles || [];
const report = readJson(path.join(ROOT, 'debug', 'optimize_15m_max_median_runtime_ultrarelaxed_full.json'));
const universe = (report.topCandidates || []).map(normalizeReportCandidate);

const epochs = [...new Set(rows.map(r => Number(r.cycleStartEpochSec)).filter(Number.isFinite))].sort((a, b) => a - b);
const valEnd = Math.floor(epochs.length * 0.80);
const testEpochs = new Set(epochs.slice(valEnd));
const testRows = rows.filter(r => testEpochs.has(Number(r.cycleStartEpochSec)));
const historicalEndEpoch = epochs[epochs.length - 1];
const recentCycles = allRecentCycles.filter(c => Number(c.epoch) > historicalEndEpoch);

const tradeIndex = new Map();
for (const c of universe) tradeIndex.set(c.key, { historicalTrades: buildHistoricalTrades(testRows, c), recentTrades: buildRecentTrades(recentCycles, c) });

const fullSeq = enumerateDayRange('2026-02-08', '2026-03-31');
console.error(`Calendar sequence: ${fullSeq.length} days`);

const winnerArtifact = readJson(path.join(ROOT, 'debug', 'strategy_set_15m_nc_exhaustive_13.json'));
const beamArtifact = readJson(path.join(ROOT, 'debug', 'strategy_set_15m_nc_beam_best_12.json'));
const bestOverallNames = readJson(path.join(ROOT, 'debug', 'audit_cap12_exhaustive.json')).best.names || [];

const winnerStrategies = winnerArtifact.strategies.map(s => candidateFromArtifact(universe, s)).filter(Boolean);
const beamStrategies = beamArtifact.strategies.map(s => candidateFromArtifact(universe, s)).filter(Boolean);
const bestOverallStrategies = bestOverallNames.map(name => universe.find(c => c.name === name)).filter(Boolean);

const sets = [
    { label: 'exhaustive_nc_13', strategies: winnerStrategies },
    { label: 'beam_best_12', strategies: beamStrategies },
    { label: 'best_overall_15_nc_false', strategies: bestOverallStrategies }
];

const output = {
    generatedAt: new Date().toISOString(),
    startBalance: START_BALANCE,
    minRuntimeBankroll: MIN_RUNTIME_BANKROLL,
    trials: TRIALS,
    simDays: BOOTSTRAP_DAYS,
    blockDays: BLOCK_DAYS,
    guardReplay: {
        absoluteStakeCap: true,
        aggregateExposureBudget: true,
        dynamicRiskEnvelope: true,
        finalNetEdgeRecheck: true,
        requireRealOrderBook: false,
        note: 'Historical replay cannot exactly re-run the real-order-book-required guard because historical order-book ladders are not stored in repo datasets.'
    },
    results: {}
};

for (const set of sets) {
    console.error(`Evaluating ${set.label}...`);
    const evaluated = evaluateSet(set.label, set.strategies, tradeIndex, fullSeq);
    const boot = bootstrapSummary(buildCombinedDayBuckets(set.strategies, tradeIndex), fullSeq);
    output.results[set.label] = {
        strategyCount: set.strategies.length,
        actual: {
            finalBalance: evaluated.actual.finalBalance,
            busted: evaluated.actual.busted,
            totalTrades: evaluated.actual.totalTrades,
            winRate: evaluated.actual.winRate,
            maxDrawdown: evaluated.actual.maxDrawdown,
            robustFloor: evaluated.robustFloor,
            windows: evaluated.windows,
            milestones: milestones(evaluated.actual.path, [7, 14, 21, 30, 45, 52])
        },
        bootstrap30d: boot
    };
}

writeJson(OUTPUT_PATH, output);
console.log(JSON.stringify(output, null, 2));
