#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { calcPolymarketTakerFeeUsdPerShare } = require('../lib/polymarket-fees');

const ROOT = path.resolve(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'epoch3', 'reinvestigation_v2');
const START_BANKROLL = Number(process.env.BANKROLL || '14.690226');
const ADVERSE_CENTS = Number(process.env.ADVERSE_CENTS || '0.025');
const SLIPPAGE_PCT = Number(process.env.SLIPPAGE_PCT || '0.0125');
const MIN_TRIGGERS = Number(process.env.MIN_TRIGGERS || '24');
const MIN_HOLDOUT_TRIGGERS = Number(process.env.MIN_HOLDOUT_TRIGGERS || '8');
const MIN_AVG_PNL_PER_SHARE = Number(process.env.MIN_AVG_PNL_PER_SHARE || '0.025');
const MIN_HOLDOUT_AVG_PNL = Number(process.env.MIN_HOLDOUT_AVG_PNL || '0.015');
const MAX_DRAWDOWN = Number(process.env.MAX_DRAWDOWN || '0.45');
const MAX_RULES = Number(process.env.MAX_RULES || '12');
const SCAN_TIMEFRAMES = String(process.env.SCAN_TIMEFRAMES || '')
    .split(',')
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
const SCAN_ASSETS = String(process.env.SCAN_ASSETS || '')
    .split(',')
    .map((item) => item.trim().toUpperCase())
    .filter(Boolean);
const FOUR_H_STEP = Math.max(1, Number(process.env.FOUR_H_STEP || '5'));

const DATASETS = [
    { id: 'fresh_5m_2d', file: 'debug/recent_5m_cycle_cache_2d.json', timeframe: '5m', freshness: 'fresh' },
    { id: 'fresh_4h_14d', file: 'debug/recent_4h_cycle_cache_14d.json', timeframe: '4h', freshness: 'fresh' },
    { id: 'fresh_15m_7d', file: 'debug/definitive_15m_cycle_cache_7d.json', timeframe: '15m', freshness: 'fresh' },
    { id: 'historical_15m', file: 'data/intracycle-price-data.json', timeframe: '15m', freshness: 'historical' },
    { id: 'historical_5m', file: 'data/intracycle-price-data-5m.json', timeframe: '5m', freshness: 'stale' },
    { id: 'historical_4h', file: 'data/intracycle-price-data-4h.json', timeframe: '4h', freshness: 'stale' },
    { id: 'expanded_epoch3', file: 'data/epoch3-expanded-intracycle-data.json', timeframe: null, freshness: 'historical' },
].filter((dataset) => process.env.FRESH_ONLY === 'true' ? dataset.freshness === 'fresh' : true);

const EXIT_POLICIES = [
    { takeProfit: 0.05, stopLoss: 0.10 },
    { takeProfit: 0.08, stopLoss: 0.12 },
    { takeProfit: 0.10, stopLoss: 0.15 },
    { takeProfit: 0.12, stopLoss: 0.18 },
    { takeProfit: 0.15, stopLoss: 0.20 },
    { takeProfit: 0.20, stopLoss: 0.25 },
    { takeProfit: 0.25, stopLoss: 0.30 },
    { takeProfit: 0.10, stopLoss: null },
    { takeProfit: 0.15, stopLoss: null },
];

function ensureDir(dir) { fs.mkdirSync(dir, { recursive: true }); }
function round(value, digits = 6) { return Number.isFinite(value) ? Math.round(value * (10 ** digits)) / (10 ** digits) : null; }
function readJson(file) { return JSON.parse(fs.readFileSync(path.join(ROOT, file), 'utf8')); }
function extractArray(payload) { return Array.isArray(payload) ? payload : Array.isArray(payload?.cycles) ? payload.cycles : Array.isArray(payload?.data) ? payload.data : []; }
function safePrice(value) { const n = Number(value); return Number.isFinite(n) ? n : null; }

function inferTimeframe(row, fallback) {
    const raw = String(row?.timeframe || row?.slug || '');
    const match = raw.match(/updown-(5m|15m|1h|4h)-/i) || raw.match(/^(5m|15m|1h|4h)$/i);
    return (match ? match[1] : fallback || 'unknown').toLowerCase();
}

function buyCost(price) {
    const p = Math.min(0.97, Math.max(price + ADVERSE_CENTS, price * (1 + SLIPPAGE_PCT)));
    return p + calcPolymarketTakerFeeUsdPerShare(p);
}

function sellProceeds(price) {
    const p = Math.max(0, Math.min(0.99, Math.min(price - ADVERSE_CENTS, price * (1 - SLIPPAGE_PCT))));
    return Math.max(0, p - calcPolymarketTakerFeeUsdPerShare(p));
}

function priceRows(row) {
    if (Array.isArray(row.prices)) return row.prices.map((p) => ({ minute: Number(p.minute), UP: safePrice(p.UP ?? p.up ?? p.yes), DOWN: safePrice(p.DOWN ?? p.down ?? p.no) })).filter((p) => Number.isFinite(p.minute));
    if (row.minutePricesYes || row.minutePricesNo) {
        const yes = row.minutePricesYes || {};
        const no = row.minutePricesNo || {};
        return [...new Set([...Object.keys(yes), ...Object.keys(no)].map(Number).filter(Number.isFinite))].map((minute) => ({
            minute,
            UP: safePrice(typeof yes[String(minute)] === 'object' ? (yes[String(minute)].last ?? yes[String(minute)].price) : yes[String(minute)]),
            DOWN: safePrice(typeof no[String(minute)] === 'object' ? (no[String(minute)].last ?? no[String(minute)].price) : no[String(minute)]),
        }));
    }
    return [];
}

function cyclesFromDataset(dataset) {
    const fullPath = path.join(ROOT, dataset.file);
    if (!fs.existsSync(fullPath)) return [];
    return extractArray(readJson(dataset.file)).map((row) => {
        const epoch = Number(row.epoch ?? row.cycleStartEpochSec);
        const asset = String(row.asset || '').toUpperCase();
        const resolution = String(row.resolution || row.outcome || row.resolvedOutcome || '').toUpperCase();
        const prices = priceRows(row);
        if (!Number.isFinite(epoch) || !asset || !['UP', 'DOWN'].includes(resolution) || prices.length < 2) return null;
        return {
            datasetId: dataset.id,
            sourceFile: dataset.file,
            freshness: dataset.freshness,
            timeframe: inferTimeframe(row, dataset.timeframe),
            asset,
            epoch,
            day: new Date(epoch * 1000).toISOString().slice(0, 10),
            utcHour: Number.isFinite(Number(row.utcHour)) ? Number(row.utcHour) : new Date(epoch * 1000).getUTCHours(),
            resolution,
            prices,
        };
    }).filter(Boolean);
}

function dedupeCycles(cycles) {
    const rank = { fresh: 4, historical: 3, stale: 2 };
    const byKey = new Map();
    for (const cycle of cycles) {
        const key = [cycle.timeframe, cycle.asset, cycle.epoch].join('|');
        const current = byKey.get(key);
        if (!current || (rank[cycle.freshness] || 0) > (rank[current.freshness] || 0)) byKey.set(key, cycle);
    }
    return [...byKey.values()].sort((a, b) => a.epoch - b.epoch || a.asset.localeCompare(b.asset));
}

function simulateExit(cycle, direction, entryMinute, policy) {
    const ordered = cycle.prices.filter((row) => row.minute >= entryMinute).sort((a, b) => a.minute - b.minute);
    const first = ordered[0];
    if (!first) return null;
    const rawEntry = safePrice(first[direction]);
    if (!Number.isFinite(rawEntry) || rawEntry <= 0.03 || rawEntry >= 0.88) return null;
    const cost = buyCost(rawEntry);
    let exitReason = 'resolution';
    let pnlPerShare = cycle.resolution === direction ? 1 - cost : -cost;
    for (const tick of ordered.slice(1)) {
        const price = safePrice(tick[direction]);
        if (!Number.isFinite(price)) continue;
        const proceeds = sellProceeds(price);
        const pnl = proceeds - cost;
        if (policy.stopLoss !== null && pnl <= -policy.stopLoss) {
            exitReason = 'stopLoss';
            pnlPerShare = pnl;
            break;
        }
        if (pnl >= policy.takeProfit) {
            exitReason = 'takeProfit';
            pnlPerShare = pnl;
            break;
        }
    }
    return { rawEntry, cost, pnlPerShare, won: pnlPerShare > 0, exitReason };
}

function priceBands() {
    const bands = [];
    for (let low = 0.25; low <= 0.85; low += 0.05) {
        bands.push([round(low, 2), round(low + 0.05, 2)]);
        if (low <= 0.8) bands.push([round(low, 2), round(low + 0.1, 2)]);
    }
    bands.push([0.55, 0.85], [0.6, 0.85], [0.7, 0.85]);
    return [...new Map(bands.map((band) => [`${band[0]}-${band[1]}`, band])).values()];
}

function summarise(rows) {
    const wins = rows.filter((row) => row.won).length;
    const pnl = rows.reduce((sum, row) => sum + row.pnlPerShare, 0);
    return {
        triggers: rows.length,
        wins,
        losses: rows.length - wins,
        winRate: rows.length ? wins / rows.length : 0,
        avgPnlPerShare: rows.length ? pnl / rows.length : 0,
        takeProfitExits: rows.filter((row) => row.exitReason === 'takeProfit').length,
        stopLossExits: rows.filter((row) => row.exitReason === 'stopLoss').length,
        resolutionExits: rows.filter((row) => row.exitReason === 'resolution').length,
    };
}

function chronologicalSplit(rows) {
    const days = [...new Set(rows.map((row) => row.day))].sort();
    const splitDay = days[Math.max(1, Math.floor(days.length * 0.65))] || days[0];
    return { train: rows.filter((row) => row.day < splitDay), holdout: rows.filter((row) => row.day >= splitDay), splitDay };
}

function scanCandidates(cycles) {
    const candidates = [];
    const bands = priceBands();
    const maxMinute = { '5m': 4, '15m': 13, '4h': 238 };
    const timeframes = [...new Set(cycles.map((cycle) => cycle.timeframe))]
        .filter((timeframe) => !SCAN_TIMEFRAMES.length || SCAN_TIMEFRAMES.includes(timeframe));
    for (const timeframe of timeframes) {
        const step = timeframe === '4h' ? FOUR_H_STEP : 1;
        const assetUniverse = [...new Set(cycles.map((cycle) => cycle.asset))]
            .filter((asset) => !SCAN_ASSETS.length || SCAN_ASSETS.includes(asset));
        for (const asset of ['ALL', ...assetUniverse]) {
            const sourceCycles = cycles.filter((cycle) => cycle.timeframe === timeframe && (asset === 'ALL' || cycle.asset === asset));
            if (!sourceCycles.length) continue;
            for (let utcHour = 0; utcHour < 24; utcHour += 1) {
                const hourCycles = sourceCycles.filter((cycle) => cycle.utcHour === utcHour);
                if (!hourCycles.length) continue;
                for (let entryMinute = 0; entryMinute <= (maxMinute[timeframe] ?? 13); entryMinute += step) {
                    for (const direction of ['UP', 'DOWN']) {
                        for (const [priceMin, priceMax] of bands) {
                            for (const policy of EXIT_POLICIES) {
                                const rows = [];
                                for (const cycle of hourCycles) {
                                    const result = simulateExit(cycle, direction, entryMinute, policy);
                                    if (!result || result.rawEntry < priceMin || result.rawEntry > priceMax) continue;
                                    rows.push({ ...result, timeframe, asset: cycle.asset, epoch: cycle.epoch, day: cycle.day, utcHour, entryMinute, direction, source: cycle.datasetId, freshness: cycle.freshness });
                                }
                                if (rows.length < MIN_TRIGGERS) continue;
                                const split = chronologicalSplit(rows);
                                const train = summarise(split.train);
                                const holdout = summarise(split.holdout);
                                const all = summarise(rows);
                                if (holdout.triggers < MIN_HOLDOUT_TRIGGERS) continue;
                                if (all.avgPnlPerShare < MIN_AVG_PNL_PER_SHARE || holdout.avgPnlPerShare < MIN_HOLDOUT_AVG_PNL || train.avgPnlPerShare <= 0) continue;
                                const freshRows = rows.filter((row) => row.freshness === 'fresh');
                                const fresh = summarise(freshRows);
                                if (fresh.triggers >= 8 && fresh.avgPnlPerShare <= 0) continue;
                                const score = holdout.avgPnlPerShare * Math.sqrt(holdout.triggers) * 3
                                    + all.avgPnlPerShare * Math.sqrt(all.triggers)
                                    + (fresh.triggers ? fresh.avgPnlPerShare * Math.sqrt(fresh.triggers) * 2 : 0)
                                    - (all.stopLossExits * 0.02);
                                candidates.push({ timeframe, asset, utcHour, entryMinute, direction, priceMin, priceMax, policy, all, train, holdout, fresh, splitDay: split.splitDay, score, rows });
                            }
                        }
                    }
                }
            }
        }
    }
    return candidates.sort((a, b) => b.score - a.score);
}

function rowsForRule(cycles, rule) {
    const rows = [];
    const timeframe = String(rule.timeframe).toLowerCase();
    const asset = String(rule.asset || 'ALL').toUpperCase();
    const utcHour = Number(rule.utcHour);
    const entryMinute = Number(rule.entryMinute);
    const direction = String(rule.direction).toUpperCase();
    const priceMin = Number(rule.priceMin);
    const priceMax = Number(rule.priceMax);
    for (const cycle of cycles) {
        if (cycle.timeframe !== timeframe) continue;
        if (asset !== 'ALL' && cycle.asset !== asset) continue;
        if (cycle.utcHour !== utcHour) continue;
        const result = simulateExit(cycle, direction, entryMinute, rule.policy || { takeProfit: 0.05, stopLoss: 0.1 });
        if (!result || result.rawEntry < priceMin || result.rawEntry > priceMax) continue;
        rows.push({ ...result, timeframe, asset: cycle.asset, epoch: cycle.epoch, day: cycle.day, utcHour, entryMinute, direction, source: cycle.datasetId, freshness: cycle.freshness });
    }
    return rows;
}

function candidateFromRule(cycles, rule, fallbackScore = 0) {
    const rows = rowsForRule(cycles, rule);
    const split = chronologicalSplit(rows);
    const train = summarise(split.train);
    const holdout = summarise(split.holdout);
    const all = summarise(rows);
    const fresh = summarise(rows.filter((row) => row.freshness === 'fresh'));
    return { ...rule, score: Number(rule.score || fallbackScore), all, train, holdout, fresh, splitDay: split.splitDay, rows };
}

function matches(candidate, row) {
    return candidate.timeframe === row.timeframe
        && (candidate.asset === 'ALL' || candidate.asset === row.asset)
        && candidate.utcHour === row.utcHour
        && candidate.entryMinute === row.entryMinute
        && candidate.direction === row.direction
        && row.rawEntry >= candidate.priceMin
        && row.rawEntry <= candidate.priceMax;
}

function productionTier(bankroll) {
    if (bankroll < 15) return { stakeFraction: 0.40, maxPerCycle: 1 };
    if (bankroll < 50) return { stakeFraction: 0.35, maxPerCycle: 2 };
    return { stakeFraction: 0.30, maxPerCycle: 2 };
}

function simulateSet(candidates) {
    const events = [];
    for (const candidate of candidates) for (const row of candidate.rows) if (matches(candidate, row)) events.push({ ...row, score: candidate.score });
    const byCycle = new Map();
    for (const event of events) {
        const key = `${event.timeframe}|${event.epoch}`;
        if (!byCycle.has(key)) byCycle.set(key, []);
        byCycle.get(key).push(event);
    }
    let bankroll = START_BANKROLL;
    let peak = START_BANKROLL;
    let minBankroll = START_BANKROLL;
    let trades = 0;
    let wins = 0;
    let losses = 0;
    const dayStats = new Map();
    for (const [, rows] of [...byCycle.entries()].sort((a, b) => Number(a[0].split('|')[1]) - Number(b[0].split('|')[1]))) {
        const tier = productionTier(bankroll);
        for (const row of rows.sort((a, b) => b.score - a.score).slice(0, tier.maxPerCycle)) {
            const stake = Math.min(bankroll * tier.stakeFraction, 100);
            if (stake < 1 || stake > bankroll) continue;
            const shares = stake / row.cost;
            const pnl = shares * row.pnlPerShare;
            bankroll += pnl;
            peak = Math.max(peak, bankroll);
            minBankroll = Math.min(minBankroll, bankroll);
            trades += 1;
            wins += pnl > 0 ? 1 : 0;
            losses += pnl > 0 ? 0 : 1;
            const stat = dayStats.get(row.day) || { day: row.day, trades: 0, wins: 0, losses: 0, pnl: 0, endBankroll: bankroll };
            stat.trades += 1;
            stat.wins += pnl > 0 ? 1 : 0;
            stat.losses += pnl > 0 ? 0 : 1;
            stat.pnl += pnl;
            stat.endBankroll = bankroll;
            dayStats.set(row.day, stat);
        }
    }
    return {
        startBankroll: START_BANKROLL,
        endBankroll: round(bankroll, 6),
        profit: round(bankroll - START_BANKROLL, 6),
        minBankroll: round(minBankroll, 6),
        maxDrawdownPct: peak > 0 ? round((peak - minBankroll) / peak, 6) : 1,
        trades,
        wins,
        losses,
        winRate: trades ? round(wins / trades, 6) : 0,
        dayStats: [...dayStats.values()].sort((a, b) => a.day.localeCompare(b.day)).map((day) => ({ ...day, pnl: round(day.pnl, 4), endBankroll: round(day.endBankroll, 4), winRate: day.trades ? round(day.wins / day.trades, 4) : 0 })),
    };
}

function selectCandidates(candidates) {
    const selected = [];
    const seen = new Set();
    let best = START_BANKROLL;
    for (const candidate of candidates) {
        const key = [candidate.timeframe, candidate.asset, candidate.utcHour, candidate.entryMinute, candidate.direction].join('|');
        if (seen.has(key)) continue;
        const trial = [...selected, candidate];
        const sim = simulateSet(trial);
        if (sim.trades < Math.max(MIN_TRIGGERS, trial.length * 3)) continue;
        if (sim.maxDrawdownPct > MAX_DRAWDOWN) continue;
        if (sim.endBankroll < best * 1.03) continue;
        selected.push(candidate);
        seen.add(key);
        best = sim.endBankroll;
        if (selected.length >= MAX_RULES) break;
    }
    return selected;
}

function verdict(selected, sim) {
    const issues = [];
    if (!selected.length) issues.push('NO_INTRACYCLE_EXIT_CANDIDATE_SURVIVED');
    if (sim.trades < 30) issues.push('SELECTED_SAMPLE_UNDER_30_TRADES');
    if (sim.maxDrawdownPct > MAX_DRAWDOWN) issues.push('SELECTED_DRAWDOWN_TOO_HIGH');
    if (sim.endBankroll < START_BANKROLL * 1.5) issues.push('SELECTED_UPSIDE_TOO_LOW_FOR_OPERATOR_GOAL');
    if (selected.some((candidate) => candidate.fresh.triggers < 8)) issues.push('SOME_SELECTED_RULES_LACK_FRESH_CONFIRMATION');
    return { status: issues.length ? 'NO_GO_PROMOTION' : 'PROMOTION_CANDIDATE_REQUIRES_OPERATOR_APPROVAL', issues };
}

async function main() {
    ensureDir(OUT_DIR);
    const rawCycles = DATASETS.flatMap(cyclesFromDataset);
    const cycles = dedupeCycles(rawCycles);
    const validateReport = process.env.VALIDATE_REPORT ? JSON.parse(fs.readFileSync(path.resolve(ROOT, process.env.VALIDATE_REPORT), 'utf8')) : null;
    const candidates = validateReport ? [] : scanCandidates(cycles);
    const selected = validateReport
        ? (validateReport.selected || []).map((rule, index) => candidateFromRule(cycles, rule, Number(rule.score || 0) || (100 - index)))
        : selectCandidates(candidates);
    const selectedSimulation = simulateSet(selected);
    const generatedAt = new Date().toISOString();
    const timestamp = generatedAt.replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
    const report = {
        generatedAt,
        parameters: { START_BANKROLL, ADVERSE_CENTS, SLIPPAGE_PCT, MIN_TRIGGERS, MIN_HOLDOUT_TRIGGERS, MIN_AVG_PNL_PER_SHARE, MIN_HOLDOUT_AVG_PNL, MAX_DRAWDOWN, MAX_RULES },
        datasets: DATASETS.map((dataset) => ({ ...dataset, exists: fs.existsSync(path.join(ROOT, dataset.file)) })),
        rawCycles: rawCycles.length,
        cycles: cycles.length,
        mode: validateReport ? 'validate-report' : 'search',
        validateReport: process.env.VALIDATE_REPORT || null,
        candidateCount: candidates.length,
        topCandidates: candidates.slice(0, 50).map((candidate) => ({ ...candidate, rows: undefined })),
        selected: selected.map((candidate) => ({ ...candidate, rows: undefined })),
        selectedSimulation,
    };
    report.verdict = verdict(selected, selectedSimulation);
    const reportPath = path.join(OUT_DIR, `intracycle_exit_strategy_search_${timestamp}.json`);
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
    console.log(JSON.stringify({
        reportPath: path.relative(ROOT, reportPath),
        verdict: report.verdict,
        rawCycles: report.rawCycles,
        cycles: report.cycles,
        candidateCount: report.candidateCount,
        selectedCount: selected.length,
        selectedSimulation,
        topSelected: report.selected.slice(0, 12),
    }, null, 2));
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});