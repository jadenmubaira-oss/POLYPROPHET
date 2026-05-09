#!/usr/bin/env node
'use strict';

/**
 * Expanded multi-timeframe strategy investigation.
 *
 * This is intentionally an audit/search artifact, not an auto-promoter. It
 * searches every locally available intracycle dataset with the same pessimistic
 * friction model and then rejects candidates that only work in one stale slice.
 */

const fs = require('fs');
const path = require('path');
const { calcPolymarketTakerFeeUsdPerShare } = require('../lib/polymarket-fees');

const ROOT = path.resolve(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'epoch3', 'reinvestigation_v2');
const STRATEGY_DIR = path.join(ROOT, 'strategies');
const START_BANKROLL = Number(process.env.BANKROLL || '14.690226');
const MAX_RULES = Math.max(1, Number(process.env.MAX_RULES || '16'));
const ADVERSE_FILL_CENTS = Number(process.env.ADVERSE_FILL_CENTS || '0.025');
const SLIPPAGE_PCT = Number(process.env.SLIPPAGE_PCT || '0.0125');
const MIN_TRIGGERS = Number(process.env.MIN_TRIGGERS || '20');
const MIN_RECENT_TRIGGERS = Number(process.env.MIN_RECENT_TRIGGERS || '8');
const MIN_LCB = Number(process.env.MIN_LCB || '0.62');
const MIN_WR = Number(process.env.MIN_WR || '0.74');
const MIN_AVG_PNL = Number(process.env.MIN_AVG_PNL || '0.035');
const MIN_WALK_FORWARD_WR = Number(process.env.MIN_WALK_FORWARD_WR || '0.68');
const MAX_SIM_DRAWDOWN = Number(process.env.MAX_SIM_DRAWDOWN || '0.55');
const MIN_END_MULTIPLE = Number(process.env.MIN_END_MULTIPLE || '1.25');
const DUST_MIN_PRICE = Number(process.env.DUST_MIN_PRICE || '0.03');
const MAX_ENTRY_PRICE = Number(process.env.MAX_ENTRY_PRICE || '0.88');

const DATASETS = [
    { id: 'fresh_5m_2d', file: 'debug/recent_5m_cycle_cache_2d.json', timeframe: '5m', freshness: 'fresh' },
    { id: 'fresh_1h_7d', file: 'debug/recent_1h_cycle_cache_7d.json', timeframe: '1h', freshness: 'fresh' },
    { id: 'fresh_4h_14d', file: 'debug/recent_4h_cycle_cache_14d.json', timeframe: '4h', freshness: 'fresh' },
    { id: 'fresh_15m_7d', file: 'debug/definitive_15m_cycle_cache_7d.json', timeframe: '15m', freshness: 'fresh' },
    { id: 'local_15m_21d', file: 'data/intracycle-price-data.json', timeframe: '15m', freshness: 'historical' },
    { id: 'local_5m_14d', file: 'data/intracycle-price-data-5m.json', timeframe: '5m', freshness: 'stale' },
    { id: 'exhaustive_5m_14d', file: 'exhaustive_analysis/5m/5m_decision_dataset.json', timeframe: '5m', freshness: 'stale' },
    { id: 'local_4h_14d', file: 'data/intracycle-price-data-4h.json', timeframe: '4h', freshness: 'stale' },
    { id: 'expanded_mixed_epoch3', file: 'data/epoch3-expanded-intracycle-data.json', timeframe: null, freshness: 'historical' },
];

function ensureDir(dir) {
    fs.mkdirSync(dir, { recursive: true });
}

function round(value, digits = 6) {
    return Number.isFinite(value) ? Math.round(value * (10 ** digits)) / (10 ** digits) : null;
}

function readJson(relPath) {
    return JSON.parse(fs.readFileSync(path.join(ROOT, relPath), 'utf8'));
}

function extractArray(payload) {
    if (Array.isArray(payload)) return payload;
    if (Array.isArray(payload?.cycles)) return payload.cycles;
    if (Array.isArray(payload?.markets)) return payload.markets;
    if (Array.isArray(payload?.data)) return payload.data;
    return [];
}

function inferTimeframe(row, fallback) {
    const raw = String(row?.timeframe || row?.slug || '');
    const match = raw.match(/updown-(5m|15m|1h|4h)-/i) || raw.match(/^(5m|15m|1h|4h)$/i);
    return (match ? match[1] : fallback || 'unknown').toLowerCase();
}

function getLastPrice(value) {
    if (value === null || value === undefined) return null;
    if (typeof value === 'number') return Number.isFinite(value) ? value : null;
    if (typeof value === 'string') {
        const parsed = Number(value);
        return Number.isFinite(parsed) ? parsed : null;
    }
    if (typeof value === 'object') {
        for (const key of ['last', 'price', 'p', 'value']) {
            const parsed = Number(value[key]);
            if (Number.isFinite(parsed)) return parsed;
        }
    }
    return null;
}

function effectiveEntry(price) {
    const p = Number(price);
    if (!Number.isFinite(p) || p <= DUST_MIN_PRICE || p >= MAX_ENTRY_PRICE) return null;
    return Math.min(0.97, Math.max(p + ADVERSE_FILL_CENTS, p * (1 + SLIPPAGE_PCT)));
}

function pnlPerShare(won, price) {
    const entry = effectiveEntry(price);
    if (entry === null) return null;
    const fee = calcPolymarketTakerFeeUsdPerShare(entry);
    return won ? 1 - entry - fee : -entry - fee;
}

function pushObservation(rows, meta, direction, rawPrice) {
    const price = Number(rawPrice);
    if (!Number.isFinite(price)) return;
    const entry = effectiveEntry(price);
    if (entry === null) return;
    const won = String(meta.resolution).toUpperCase() === direction;
    const pnl = pnlPerShare(won, price);
    if (pnl === null) return;
    rows.push({
        datasetId: meta.datasetId,
        sourceFile: meta.sourceFile,
        freshness: meta.freshness,
        timeframe: meta.timeframe,
        asset: String(meta.asset || '').toUpperCase(),
        epoch: Number(meta.epoch),
        day: new Date(Number(meta.epoch) * 1000).toISOString().slice(0, 10),
        utcHour: Number(meta.utcHour),
        entryMinute: Number(meta.entryMinute),
        direction,
        price,
        effectiveEntry: entry,
        won,
        pnlPerShare: pnl,
    });
}

function observationsFromMarketRows(dataset, sourceRows) {
    const rows = [];
    for (const row of sourceRows) {
        const timeframe = inferTimeframe(row, dataset.timeframe);
        const epoch = Number(row.epoch ?? row.cycleStartEpochSec);
        const asset = String(row.asset || '').toUpperCase();
        const resolution = String(row.resolution || row.resolvedOutcome || row.outcome || '').toUpperCase();
        if (!asset || !Number.isFinite(epoch) || !['UP', 'DOWN'].includes(resolution)) continue;
        const utcHour = Number.isFinite(Number(row.utcHour)) ? Number(row.utcHour) : new Date(epoch * 1000).getUTCHours();

        if (Array.isArray(row.prices)) {
            for (const priceRow of row.prices) {
                const entryMinute = Number(priceRow.minute);
                if (!Number.isFinite(entryMinute)) continue;
                const meta = { datasetId: dataset.id, sourceFile: dataset.file, freshness: dataset.freshness, timeframe, asset, epoch, resolution, utcHour, entryMinute };
                pushObservation(rows, meta, 'UP', priceRow.UP ?? priceRow.up ?? priceRow.yes);
                pushObservation(rows, meta, 'DOWN', priceRow.DOWN ?? priceRow.down ?? priceRow.no);
            }
            continue;
        }

        if (row.minutePricesYes || row.minutePricesNo) {
            const yes = row.minutePricesYes || {};
            const no = row.minutePricesNo || {};
            const minutes = [...new Set([...Object.keys(yes), ...Object.keys(no)].map(Number).filter(Number.isFinite))];
            for (const entryMinute of minutes) {
                const meta = { datasetId: dataset.id, sourceFile: dataset.file, freshness: dataset.freshness, timeframe, asset, epoch, resolution, utcHour, entryMinute };
                pushObservation(rows, meta, 'UP', getLastPrice(yes[String(entryMinute)]));
                pushObservation(rows, meta, 'DOWN', getLastPrice(no[String(entryMinute)]));
            }
            continue;
        }

        if (Number.isFinite(Number(row.upPrice)) || Number.isFinite(Number(row.downPrice))) {
            const entryMinute = Number(row.entryMinute);
            if (!Number.isFinite(entryMinute)) continue;
            const meta = { datasetId: dataset.id, sourceFile: dataset.file, freshness: dataset.freshness, timeframe, asset, epoch, resolution, utcHour, entryMinute };
            pushObservation(rows, meta, 'UP', row.upPrice);
            pushObservation(rows, meta, 'DOWN', row.downPrice);
        }
    }
    return rows;
}

function loadDataset(dataset) {
    const fullPath = path.join(ROOT, dataset.file);
    if (!fs.existsSync(fullPath)) return { ...dataset, exists: false, rows: [], observations: [] };
    const sourceRows = extractArray(readJson(dataset.file));
    const observations = observationsFromMarketRows(dataset, sourceRows);
    const epochs = observations.map((row) => row.epoch).filter(Number.isFinite);
    const minEpoch = epochs.reduce((min, epoch) => Math.min(min, epoch), Infinity);
    const maxEpoch = epochs.reduce((max, epoch) => Math.max(max, epoch), -Infinity);
    return {
        ...dataset,
        exists: true,
        rows: sourceRows.length,
        observations,
        observationCount: observations.length,
        assets: [...new Set(observations.map((row) => row.asset))].sort(),
        timeframes: [...new Set(observations.map((row) => row.timeframe))].sort(),
        from: epochs.length ? new Date(minEpoch * 1000).toISOString() : null,
        to: epochs.length ? new Date(maxEpoch * 1000).toISOString() : null,
    };
}

function dedupeObservations(rows) {
    const byKey = new Map();
    const sourceRank = { fresh: 4, historical: 3, stale: 2 };
    for (const row of rows) {
        const key = [row.timeframe, row.asset, row.epoch, row.entryMinute, row.direction].join('|');
        const current = byKey.get(key);
        if (!current || (sourceRank[row.freshness] || 0) > (sourceRank[current.freshness] || 0)) {
            byKey.set(key, row);
        }
    }
    return [...byKey.values()].sort((a, b) => a.epoch - b.epoch || a.entryMinute - b.entryMinute || a.asset.localeCompare(b.asset) || a.direction.localeCompare(b.direction));
}

function wilsonLowerBound(wins, total, z = 1.96) {
    if (!total) return 0;
    const p = wins / total;
    const d = 1 + z * z / total;
    return Math.max(0, (p + z * z / (2 * total) - z * Math.sqrt(p * (1 - p) / total + z * z / (4 * total * total))) / d);
}

function summarise(rows) {
    const wins = rows.filter((row) => row.won).length;
    const pnl = rows.reduce((sum, row) => sum + row.pnlPerShare, 0);
    const avgEntry = rows.reduce((sum, row) => sum + row.effectiveEntry, 0) / Math.max(1, rows.length);
    return {
        triggers: rows.length,
        wins,
        losses: rows.length - wins,
        winRate: rows.length ? wins / rows.length : 0,
        wilsonLCB95: wilsonLowerBound(wins, rows.length),
        avgEntry,
        avgPnlPerShare: rows.length ? pnl / rows.length : 0,
    };
}

function priceBands() {
    const bands = [];
    for (let low = 0.25; low <= 0.85; low += 0.05) {
        bands.push([round(low, 2), round(low + 0.05, 2)]);
        if (low <= 0.80) bands.push([round(low, 2), round(low + 0.10, 2)]);
    }
    bands.push([0.55, 0.85], [0.60, 0.85], [0.65, 0.85], [0.70, 0.85]);
    return [...new Map(bands.map((band) => [`${band[0]}-${band[1]}`, band])).values()];
}

function dayFolds(rows) {
    const days = [...new Set(rows.map((row) => row.day))].sort();
    const folds = days.map((day) => ({ day, ...summarise(rows.filter((row) => row.day === day)) }));
    return {
        days: folds,
        minWinRate: folds.length ? Math.min(...folds.map((fold) => fold.winRate)) : 0,
        minAvgPnlPerShare: folds.length ? Math.min(...folds.map((fold) => fold.avgPnlPerShare)) : 0,
        negativeDays: folds.filter((fold) => fold.avgPnlPerShare <= 0).length,
        daysWithTriggers: folds.filter((fold) => fold.triggers > 0).length,
    };
}

function chronologicalSplit(rows) {
    const sortedDays = [...new Set(rows.map((row) => row.day))].sort();
    const splitDay = sortedDays[Math.max(1, Math.floor(sortedDays.length * 0.65))] || sortedDays[0];
    return {
        train: rows.filter((row) => row.day < splitDay),
        holdout: rows.filter((row) => row.day >= splitDay),
        splitDay,
    };
}

function candidateKey(row, allAsset = false) {
    return [row.timeframe, allAsset ? 'ALL' : row.asset, row.utcHour, row.entryMinute, row.direction].join('|');
}

function makeCandidate(baseKey, priceMin, priceMax, rows) {
    const [timeframe, asset, utcHour, entryMinute, direction] = baseKey.split('|');
    const all = summarise(rows);
    const latestEpoch = Math.max(...rows.map((row) => row.epoch));
    const windowSeconds = timeframe === '4h' ? 7 * 86400 : 3 * 86400;
    const recent = summarise(rows.filter((row) => row.epoch >= latestEpoch - windowSeconds));
    const split = chronologicalSplit(rows);
    const train = summarise(split.train);
    const holdout = summarise(split.holdout);
    const folds = dayFolds(rows);
    const score = (holdout.avgPnlPerShare * Math.sqrt(Math.max(1, holdout.triggers)) * 3)
        + (recent.avgPnlPerShare * Math.sqrt(Math.max(1, recent.triggers)) * 2)
        + (all.avgPnlPerShare * Math.sqrt(Math.max(1, all.triggers)))
        + (holdout.wilsonLCB95 - 0.5)
        + (all.wilsonLCB95 - 0.5)
        - (folds.negativeDays * 0.25);
    return {
        key: `${baseKey}|${priceMin}|${priceMax}`,
        timeframe,
        asset,
        utcHour: Number(utcHour),
        entryMinute: Number(entryMinute),
        direction,
        priceMin,
        priceMax,
        all,
        recent,
        train,
        holdout,
        splitDay: split.splitDay,
        folds,
        score,
    };
}

function scanCandidates(observations) {
    const keyed = new Map();
    for (const row of observations) {
        for (const key of [candidateKey(row, false), candidateKey(row, true)]) {
            if (!keyed.has(key)) keyed.set(key, []);
            keyed.get(key).push(row);
        }
    }
    const candidates = [];
    const bands = priceBands();
    for (const [key, rows] of keyed.entries()) {
        for (const [priceMin, priceMax] of bands) {
            const bandRows = rows.filter((row) => row.price >= priceMin && row.price <= priceMax);
            if (bandRows.length < MIN_TRIGGERS) continue;
            const candidate = makeCandidate(key, priceMin, priceMax, bandRows);
            if (candidate.recent.triggers < MIN_RECENT_TRIGGERS) continue;
            if (candidate.all.winRate < MIN_WR || candidate.all.wilsonLCB95 < MIN_LCB) continue;
            if (candidate.all.avgPnlPerShare < MIN_AVG_PNL) continue;
            if (candidate.train.triggers < Math.max(8, MIN_TRIGGERS * 0.25) || candidate.holdout.triggers < Math.max(8, MIN_TRIGGERS * 0.25)) continue;
            if (candidate.train.avgPnlPerShare <= 0 || candidate.holdout.avgPnlPerShare <= 0 || candidate.recent.avgPnlPerShare <= 0) continue;
            if (candidate.train.winRate < MIN_WALK_FORWARD_WR || candidate.holdout.winRate < MIN_WALK_FORWARD_WR) continue;
            candidates.push(candidate);
        }
    }
    return candidates.sort((a, b) => b.score - a.score);
}

function matchesRule(rule, row) {
    return rule.timeframe === row.timeframe
        && (rule.asset === 'ALL' || rule.asset === row.asset)
        && rule.utcHour === row.utcHour
        && rule.entryMinute === row.entryMinute
        && rule.direction === row.direction
        && row.price >= rule.priceMin
        && row.price <= rule.priceMax;
}

function productionTier(bankroll) {
    if (bankroll < 15) return { stakeFraction: 0.40, maxPerCycle: 1, maxAbsoluteStake: 100 };
    if (bankroll < 50) return { stakeFraction: 0.35, maxPerCycle: 2, maxAbsoluteStake: 100 };
    if (bankroll < 200) return { stakeFraction: 0.30, maxPerCycle: 2, maxAbsoluteStake: 100 };
    if (bankroll < 1000) return { stakeFraction: 0.25, maxPerCycle: 2, maxAbsoluteStake: 100 };
    if (bankroll < 10000) return { stakeFraction: 0.25, maxPerCycle: 2, maxAbsoluteStake: 200 };
    return { stakeFraction: 0.25, maxPerCycle: 2, maxAbsoluteStake: 500 };
}

function simulateSet(rules, observations, startBankroll = START_BANKROLL) {
    const byEpoch = new Map();
    for (const row of observations) {
        const matching = rules.filter((rule) => matchesRule(rule, row));
        for (const rule of matching) {
            const key = `${row.timeframe}|${row.epoch}`;
            if (!byEpoch.has(key)) byEpoch.set(key, []);
            byEpoch.get(key).push({ ...row, ruleKey: rule.key, ruleScore: rule.score });
        }
    }

    let bankroll = startBankroll;
    let peak = startBankroll;
    let minBankroll = startBankroll;
    let trades = 0;
    let wins = 0;
    let losses = 0;
    const dayStats = new Map();
    const tradeLog = [];

    for (const [, rows] of [...byEpoch.entries()].sort((a, b) => {
        const aEpoch = Number(a[0].split('|')[1]);
        const bEpoch = Number(b[0].split('|')[1]);
        return aEpoch - bEpoch;
    })) {
        if (bankroll < 1) break;
        const tier = productionTier(bankroll);
        const selected = rows.sort((a, b) => b.ruleScore - a.ruleScore).slice(0, tier.maxPerCycle);
        for (const row of selected) {
            const cost = Math.max(5 * row.effectiveEntry, Math.min(bankroll * tier.stakeFraction, tier.maxAbsoluteStake));
            if (cost > bankroll || cost < 1) continue;
            const shares = cost / row.effectiveEntry;
            const pnl = shares * row.pnlPerShare;
            bankroll += pnl;
            peak = Math.max(peak, bankroll);
            minBankroll = Math.min(minBankroll, bankroll);
            trades += 1;
            wins += row.won ? 1 : 0;
            losses += row.won ? 0 : 1;
            const day = row.day;
            const stat = dayStats.get(day) || { day, trades: 0, wins: 0, losses: 0, pnl: 0, endBankroll: bankroll };
            stat.trades += 1;
            stat.wins += row.won ? 1 : 0;
            stat.losses += row.won ? 0 : 1;
            stat.pnl += pnl;
            stat.endBankroll = bankroll;
            dayStats.set(day, stat);
            if (tradeLog.length < 50) tradeLog.push({ timeframe: row.timeframe, asset: row.asset, epoch: row.epoch, day, direction: row.direction, price: round(row.price, 3), won: row.won, pnl: round(pnl, 4), bankroll: round(bankroll, 4) });
            if (bankroll < 1) break;
        }
    }

    return {
        startBankroll,
        endBankroll: round(bankroll, 6),
        profit: round(bankroll - startBankroll, 6),
        minBankroll: round(minBankroll, 6),
        maxDrawdownPct: peak > 0 ? round((peak - minBankroll) / peak, 6) : 1,
        trades,
        wins,
        losses,
        winRate: trades ? round(wins / trades, 6) : 0,
        dayStats: [...dayStats.values()].sort((a, b) => a.day.localeCompare(b.day)).map((day) => ({ ...day, pnl: round(day.pnl, 4), endBankroll: round(day.endBankroll, 4), winRate: day.trades ? round(day.wins / day.trades, 4) : 0 })),
        tradeLog,
    };
}

function selectRules(candidates, observations) {
    const selected = [];
    const seen = new Set();
    let best = START_BANKROLL;
    for (const candidate of candidates) {
        const uniqueKey = [candidate.timeframe, candidate.asset, candidate.utcHour, candidate.entryMinute, candidate.direction].join('|');
        if (seen.has(uniqueKey)) continue;
        const trial = [...selected, candidate];
        const sim = simulateSet(trial, observations);
        const improves = sim.endBankroll > best * 1.03;
        const survives = sim.endBankroll >= START_BANKROLL * MIN_END_MULTIPLE
            && sim.maxDrawdownPct <= MAX_SIM_DRAWDOWN
            && sim.trades >= Math.max(MIN_TRIGGERS, trial.length * 3);
        if (!improves || !survives) continue;
        selected.push(candidate);
        seen.add(uniqueKey);
        best = sim.endBankroll;
        if (selected.length >= MAX_RULES) break;
    }
    return selected;
}

function strategyFromRules(rules, timestamp) {
    return {
        version: `expanded_multitimeframe_${timestamp}`,
        generatedAt: new Date().toISOString(),
        source: 'expanded-polymarket-strategy-search',
        notes: [
            'Audit artifact only unless promoted manually.',
            'Uses pessimistic taker fee, adverse fill and slippage assumptions.',
            'Strategies from stale 5m/4h caches require fresh data before production use.',
        ],
        strategies: rules.map((rule, index) => ({
            id: 9500 + index + 1,
            name: `EXP-${rule.timeframe}-${rule.asset}-${rule.direction}-${rule.utcHour}-${rule.entryMinute}`,
            timeframe: rule.timeframe,
            asset: rule.asset,
            utcHour: rule.utcHour,
            entryMinute: rule.entryMinute,
            direction: rule.direction,
            priceMin: rule.priceMin,
            priceMax: rule.priceMax,
            pWinEstimate: round(Math.min(rule.all.winRate, rule.holdout.winRate, rule.recent.winRate), 4),
            winRate: round(rule.all.winRate, 4),
            winRateLCB: round(rule.all.wilsonLCB95, 4),
            avgPnlPerShare: round(rule.all.avgPnlPerShare, 4),
            train: rule.train,
            holdout: rule.holdout,
            recent: rule.recent,
            source: 'expanded-multitimeframe-search',
        })),
    };
}

function verdictFor(report) {
    const issues = [];
    const hasFreshNon15m = report.selected.some((rule) => rule.timeframe !== '15m' && rule.sources?.some((source) => source.freshness === 'fresh'));
    const staleOnlyExpanded = report.selected.some((rule) => rule.timeframe !== '15m') && !hasFreshNon15m;
    if (staleOnlyExpanded) issues.push('NON_15M_CANDIDATES_ARE_STALE_ONLY_NO_FRESH_5M_4H_CONFIRMATION');
    if (!report.selected.length) issues.push('NO_RULE_SET_SURVIVED_EXPANDED_GATES');
    if (report.selectedSimulation.maxDrawdownPct > MAX_SIM_DRAWDOWN) issues.push('SELECTED_SET_DRAWDOWN_TOO_HIGH');
    if (report.selectedSimulation.endBankroll < START_BANKROLL * MIN_END_MULTIPLE) issues.push('SELECTED_SET_DOES_NOT_CLEAR_MIN_END_MULTIPLE');
    if (report.selectedSimulation.trades < 30) issues.push('SELECTED_SET_SAMPLE_UNDER_30_TRADES');
    const status = issues.length ? 'NO_GO_PROMOTION' : 'PROMOTION_CANDIDATE_NEEDS_OPERATOR_APPROVAL';
    return { status, issues };
}

async function main() {
    ensureDir(OUT_DIR);
    ensureDir(STRATEGY_DIR);
    const loaded = DATASETS.map(loadDataset);
    const rawObservations = loaded.flatMap((dataset) => dataset.observations || []);
    const observations = dedupeObservations(rawObservations);
    const candidates = scanCandidates(observations);
    const selected = selectRules(candidates, observations);
    const selectedSimulation = simulateSet(selected, observations);
    const timestamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
    const strategy = strategyFromRules(selected, timestamp);
    const strategyArtifact = path.join('strategies', `strategy_set_expanded_multitimeframe_${timestamp}.json`);

    if (selected.length) fs.writeFileSync(path.join(ROOT, strategyArtifact), JSON.stringify(strategy, null, 2));

    const report = {
        generatedAt: new Date().toISOString(),
        parameters: {
            START_BANKROLL,
            MAX_RULES,
            ADVERSE_FILL_CENTS,
            SLIPPAGE_PCT,
            MIN_TRIGGERS,
            MIN_RECENT_TRIGGERS,
            MIN_LCB,
            MIN_WR,
            MIN_AVG_PNL,
            MIN_WALK_FORWARD_WR,
            MAX_SIM_DRAWDOWN,
            MIN_END_MULTIPLE,
        },
        datasets: loaded.map((dataset) => ({
            id: dataset.id,
            file: dataset.file,
            exists: dataset.exists,
            freshness: dataset.freshness,
            rows: dataset.rows,
            observations: dataset.observationCount,
            assets: dataset.assets,
            timeframes: dataset.timeframes,
            from: dataset.from,
            to: dataset.to,
        })),
        rawObservations: rawObservations.length,
        totalObservations: observations.length,
        duplicateObservationsRemoved: rawObservations.length - observations.length,
        candidateCount: candidates.length,
        topCandidates: candidates.slice(0, 40),
        selected: selected.map((rule) => ({
            ...rule,
            sources: [...new Map(observations.filter((row) => matchesRule(rule, row)).map((row) => [row.datasetId, { datasetId: row.datasetId, sourceFile: row.sourceFile, freshness: row.freshness }])).values()],
        })),
        selectedSimulation,
        strategyArtifact: selected.length ? strategyArtifact : null,
    };
    report.verdict = verdictFor(report);

    const reportPath = path.join(OUT_DIR, `expanded_multitimeframe_strategy_search_${timestamp}.json`);
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));

    console.log(JSON.stringify({
        reportPath: path.relative(ROOT, reportPath),
        strategyArtifact: report.strategyArtifact,
        verdict: report.verdict,
        datasetSummary: report.datasets,
        candidateCount: report.candidateCount,
        selectedCount: report.selected.length,
        selectedSimulation: report.selectedSimulation,
        topSelected: report.selected.slice(0, 10).map((rule) => ({
            timeframe: rule.timeframe,
            asset: rule.asset,
            utcHour: rule.utcHour,
            entryMinute: rule.entryMinute,
            direction: rule.direction,
            priceMin: rule.priceMin,
            priceMax: rule.priceMax,
            winRate: round(rule.all.winRate, 4),
            lcb: round(rule.all.wilsonLCB95, 4),
            avgPnl: round(rule.all.avgPnlPerShare, 4),
            holdoutWinRate: round(rule.holdout.winRate, 4),
            recentWinRate: round(rule.recent.winRate, 4),
            sources: rule.sources,
        })),
    }, null, 2));
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});