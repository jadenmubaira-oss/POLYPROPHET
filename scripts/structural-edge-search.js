#!/usr/bin/env node
'use strict';

/**
 * Structural-edge search for Polymarket crypto up/down markets.
 *
 * Prior searches repeatedly mined static UTC minute/price bands. This script
 * tests a different hypothesis: CEX price movement can lead Polymarket odds.
 * It joins fresh Polymarket intracycle probability caches with Binance 1m
 * candles, then validates simple latency/mispricing rules with chronological
 * train/holdout/recent splits and production-like replay.
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const { calcPolymarketTakerFeeUsdPerShare } = require('../lib/polymarket-fees');

const ROOT = path.resolve(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'epoch3', 'reinvestigation_v2');
const DEBUG_DIR = path.join(ROOT, 'debug');
const START_BANKROLL = Number(process.env.BANKROLL || '14.690226');
const SCAN_TIMEFRAMES = new Set(String(process.env.SCAN_TIMEFRAMES || '5m,15m')
    .split(',')
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean));
const MAX_RULES = Math.max(1, Number.parseInt(process.env.MAX_RULES || '12', 10));
const ADVERSE_FILL_CENTS = Number(process.env.ADVERSE_FILL_CENTS || '0.025');
const SLIPPAGE_PCT = Number(process.env.SLIPPAGE_PCT || '0.0125');
const MIN_ENTRY = Number(process.env.MIN_ENTRY_PRICE || '0.05');
const MAX_ENTRY = Number(process.env.MAX_ENTRY_PRICE || '0.94');
const MIN_TRIGGERS = Number(process.env.MIN_TRIGGERS || '25');
const MIN_HOLDOUT_TRIGGERS = Number(process.env.MIN_HOLDOUT_TRIGGERS || '8');
const MIN_WIN_RATE = Number(process.env.MIN_WIN_RATE || '0.72');
const MIN_LCB = Number(process.env.MIN_WILSON_LCB || '0.58');
const MIN_AVG_PNL = Number(process.env.MIN_AVG_PNL_PER_SHARE || '0.025');
const MAX_DRAWDOWN = Number(process.env.MAX_DRAWDOWN || '0.55');
const MIN_END_MULTIPLE = Number(process.env.MIN_END_MULTIPLE || '1.5');

const TIMEFRAME_SECONDS = { '5m': 300, '15m': 900, '4h': 14400 };
const CACHE_SOURCES = [
    { id: 'fresh_5m_2d', timeframe: '5m', file: 'debug/recent_5m_cycle_cache_2d.json' },
    { id: 'fresh_15m_7d', timeframe: '15m', file: 'debug/definitive_15m_cycle_cache_7d.json' },
    { id: 'fresh_4h_14d', timeframe: '4h', file: 'debug/recent_4h_cycle_cache_14d.json' },
];

const BINANCE_SYMBOLS = {
    BTC: 'BTCUSDT',
    ETH: 'ETHUSDT',
    SOL: 'SOLUSDT',
    XRP: 'XRPUSDT',
    BNB: 'BNBUSDT',
    DOGE: 'DOGEUSDT',
};

const MOVE_BPS_GRID = [1, 2, 3, 5, 8, 12, 20, 35, 50, 75, 100];
const MAX_PRICE_GRID = [0.45, 0.55, 0.65, 0.75, 0.85, 0.92];
const MIN_EDGE_GRID = [0, 0.04, 0.08, 0.12, 0.18];
const ENTRY_WINDOWS = {
    '5m': [[1, 1], [1, 2], [2, 3], [3, 4], [1, 4]],
    '15m': [[1, 2], [1, 4], [3, 6], [6, 10], [10, 14], [1, 14]],
    '4h': [[5, 30], [30, 90], [90, 180], [180, 235], [5, 235]],
};

function ensureDir(dir) {
    fs.mkdirSync(dir, { recursive: true });
}

function round(value, digits = 6) {
    return Number.isFinite(value) ? Math.round(value * (10 ** digits)) / (10 ** digits) : null;
}

function readJson(relPath) {
    return JSON.parse(fs.readFileSync(path.join(ROOT, relPath), 'utf8'));
}

function fetchJson(url, timeoutMs = 20000) {
    return new Promise((resolve, reject) => {
        const req = https.get(url, { timeout: timeoutMs }, (res) => {
            let body = '';
            res.setEncoding('utf8');
            res.on('data', (chunk) => { body += chunk; });
            res.on('end', () => {
                if (res.statusCode < 200 || res.statusCode >= 300) {
                    reject(new Error(`HTTP_${res.statusCode} ${url}`));
                    return;
                }
                try {
                    resolve(JSON.parse(body));
                } catch (error) {
                    reject(error);
                }
            });
        });
        req.on('timeout', () => req.destroy(new Error(`TIMEOUT ${url}`)));
        req.on('error', reject);
    });
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function loadCycles() {
    const rows = [];
    const datasets = [];
    for (const source of CACHE_SOURCES) {
        if (!SCAN_TIMEFRAMES.has(source.timeframe)) continue;
        const abs = path.join(ROOT, source.file);
        const exists = fs.existsSync(abs);
        const payload = exists ? readJson(source.file) : null;
        const cycles = Array.isArray(payload?.cycles) ? payload.cycles : [];
        let accepted = 0;
        for (const cycle of cycles) {
            const asset = String(cycle?.asset || '').toUpperCase();
            const epoch = Number(cycle?.epoch);
            const prices = Array.isArray(cycle?.prices) ? cycle.prices : [];
            const outcome = String(cycle?.resolution || cycle?.outcome || '').toUpperCase();
            if (!asset || !BINANCE_SYMBOLS[asset] || !Number.isFinite(epoch) || !['UP', 'DOWN'].includes(outcome)) continue;
            if (!prices.length) continue;
            rows.push({
                datasetId: source.id,
                timeframe: source.timeframe,
                asset,
                epoch,
                slug: cycle.slug || null,
                outcome,
                prices,
            });
            accepted += 1;
        }
        datasets.push({ id: source.id, file: source.file, exists, cycles: cycles.length, accepted });
    }
    return { cycles: rows.sort((a, b) => a.epoch - b.epoch || a.asset.localeCompare(b.asset)), datasets };
}

async function fetchBinanceKlines(symbol, startMs, endMs) {
    ensureDir(DEBUG_DIR);
    const cacheFile = path.join(DEBUG_DIR, `binance_1m_${symbol}_${Math.floor(startMs / 1000)}_${Math.floor(endMs / 1000)}.json`);
    if (fs.existsSync(cacheFile) && String(process.env.FORCE_BINANCE_FETCH || 'false').toLowerCase() !== 'true') {
        return JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
    }
    const all = [];
    let current = startMs;
    while (current < endMs) {
        const next = Math.min(current + (1000 * 60 * 1000), endMs);
        const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=1m&startTime=${current}&endTime=${next}&limit=1000`;
        const chunk = await fetchJson(url);
        if (!Array.isArray(chunk) || !chunk.length) break;
        all.push(...chunk);
        const lastOpen = Number(chunk[chunk.length - 1][0]);
        if (!Number.isFinite(lastOpen) || lastOpen <= current) break;
        current = lastOpen + 60000;
        await sleep(60);
    }
    fs.writeFileSync(cacheFile, JSON.stringify(all));
    return all;
}

function buildKlineIndex(klines) {
    const index = new Map();
    for (const row of klines || []) {
        const t = Math.floor(Number(row[0]) / 1000);
        const open = Number(row[1]);
        const high = Number(row[2]);
        const low = Number(row[3]);
        const close = Number(row[4]);
        if (!Number.isFinite(t) || !Number.isFinite(open) || !Number.isFinite(close)) continue;
        index.set(t, { t, open, high, low, close });
    }
    return index;
}

async function loadBinanceIndexes(cycles) {
    const byAsset = new Map();
    const assets = [...new Set(cycles.map((cycle) => cycle.asset))].sort();
    const minEpoch = Math.min(...cycles.map((cycle) => cycle.epoch));
    const maxEpoch = Math.max(...cycles.map((cycle) => cycle.epoch + (TIMEFRAME_SECONDS[cycle.timeframe] || 0)));
    for (const asset of assets) {
        const symbol = BINANCE_SYMBOLS[asset];
        try {
            const klines = await fetchBinanceKlines(symbol, (minEpoch - 120) * 1000, (maxEpoch + 120) * 1000);
            byAsset.set(asset, buildKlineIndex(klines));
        } catch (error) {
            byAsset.set(asset, new Map());
            console.warn(`WARN Binance fetch failed for ${asset}/${symbol}: ${error.message}`);
        }
    }
    return byAsset;
}

function klineAt(index, epochSecond) {
    const exact = Math.floor(epochSecond / 60) * 60;
    for (let offset = 0; offset <= 120; offset += 60) {
        const row = index.get(exact - offset) || index.get(exact + offset);
        if (row) return row;
    }
    return null;
}

function effectiveEntry(price) {
    const p = Number(price);
    if (!Number.isFinite(p) || p < MIN_ENTRY || p > MAX_ENTRY) return null;
    return Math.min(0.97, Math.max(p + ADVERSE_FILL_CENTS, p * (1 + SLIPPAGE_PCT)));
}

function pnlPerShare(won, rawPrice) {
    const entry = effectiveEntry(rawPrice);
    if (entry === null) return null;
    const fee = calcPolymarketTakerFeeUsdPerShare(entry);
    return won ? 1 - entry - fee : -entry - fee;
}

function wilsonLowerBound(wins, total, z = 1.96) {
    if (!total) return 0;
    const p = wins / total;
    const denom = 1 + (z * z / total);
    const centre = p + (z * z / (2 * total));
    const margin = z * Math.sqrt(((p * (1 - p)) + (z * z / (4 * total))) / total);
    return (centre - margin) / denom;
}

function makeObservations(cycles, binanceByAsset) {
    const observations = [];
    let missingKlines = 0;
    for (const cycle of cycles) {
        const index = binanceByAsset.get(cycle.asset);
        if (!index || !index.size) continue;
        const openRow = klineAt(index, cycle.epoch);
        if (!openRow || !Number.isFinite(openRow.open) || openRow.open <= 0) {
            missingKlines += 1;
            continue;
        }
        const tfSeconds = TIMEFRAME_SECONDS[cycle.timeframe] || 900;
        for (const point of cycle.prices) {
            const minute = Number(point?.minute);
            if (!Number.isInteger(minute) || minute <= 0 || minute >= Math.floor(tfSeconds / 60)) continue;
            const currentRow = klineAt(index, cycle.epoch + (minute * 60));
            if (!currentRow || !Number.isFinite(currentRow.close)) continue;
            const moveBps = ((currentRow.close - openRow.open) / openRow.open) * 10000;
            const direction = moveBps >= 0 ? 'UP' : 'DOWN';
            const absMoveBps = Math.abs(moveBps);
            const rawPrice = Number(point[direction]);
            const oppositePrice = Number(point[direction === 'UP' ? 'DOWN' : 'UP']);
            const entry = effectiveEntry(rawPrice);
            if (entry === null || !Number.isFinite(oppositePrice)) continue;
            const won = cycle.outcome === direction;
            const pnl = pnlPerShare(won, rawPrice);
            if (pnl === null) continue;
            const naiveEdge = Math.min(1, Math.max(0, oppositePrice + (absMoveBps / 1000))) - entry;
            observations.push({
                key: `${cycle.timeframe}:${cycle.asset}:${cycle.epoch}`,
                datasetId: cycle.datasetId,
                timeframe: cycle.timeframe,
                asset: cycle.asset,
                epoch: cycle.epoch,
                minute,
                utcHour: new Date(cycle.epoch * 1000).getUTCHours(),
                direction,
                resolution: cycle.outcome,
                rawPrice,
                oppositePrice,
                entry,
                moveBps,
                absMoveBps,
                naiveEdge,
                won,
                pnl,
            });
        }
    }
    return { observations: observations.sort((a, b) => a.epoch - b.epoch || a.minute - b.minute || a.asset.localeCompare(b.asset)), missingKlines };
}

function firstTriggerForCycle(observations, predicate) {
    const byCycle = new Map();
    for (const observation of observations) {
        if (!predicate(observation)) continue;
        const prev = byCycle.get(observation.key);
        if (!prev || observation.minute < prev.minute) byCycle.set(observation.key, observation);
    }
    return [...byCycle.values()].sort((a, b) => a.epoch - b.epoch || a.minute - b.minute || a.asset.localeCompare(b.asset));
}

function summarize(trades) {
    const total = trades.length;
    const wins = trades.filter((trade) => trade.won).length;
    const losses = total - wins;
    const avgPnlPerShare = total ? trades.reduce((sum, trade) => sum + trade.pnl, 0) / total : 0;
    const avgEntry = total ? trades.reduce((sum, trade) => sum + trade.entry, 0) / total : 0;
    const avgMoveBps = total ? trades.reduce((sum, trade) => sum + trade.absMoveBps, 0) / total : 0;
    return {
        trades: total,
        wins,
        losses,
        winRate: total ? wins / total : 0,
        wilsonLCB95: wilsonLowerBound(wins, total),
        avgPnlPerShare,
        avgEntry,
        avgMoveBps,
    };
}

function splitTrades(trades) {
    const sorted = [...trades].sort((a, b) => a.epoch - b.epoch || a.minute - b.minute || a.asset.localeCompare(b.asset));
    const trainCut = Math.floor(sorted.length * 0.6);
    const holdoutCut = Math.floor(sorted.length * 0.8);
    return {
        train: sorted.slice(0, trainCut),
        holdout: sorted.slice(trainCut, holdoutCut),
        recent: sorted.slice(holdoutCut),
    };
}

function evaluateCandidates(observations) {
    const candidates = [];
    const assets = ['ALL', ...new Set(observations.map((observation) => observation.asset))];
    for (const timeframe of SCAN_TIMEFRAMES) {
        const windows = ENTRY_WINDOWS[timeframe] || [];
        for (const asset of assets) {
            for (const [minuteMin, minuteMax] of windows) {
                for (const minMoveBps of MOVE_BPS_GRID) {
                    for (const maxPrice of MAX_PRICE_GRID) {
                        for (const minNaiveEdge of MIN_EDGE_GRID) {
                            const trades = firstTriggerForCycle(observations, (observation) => (
                                observation.timeframe === timeframe
                                && (asset === 'ALL' || observation.asset === asset)
                                && observation.minute >= minuteMin
                                && observation.minute <= minuteMax
                                && observation.absMoveBps >= minMoveBps
                                && observation.rawPrice <= maxPrice
                                && observation.naiveEdge >= minNaiveEdge
                            ));
                            if (trades.length < MIN_TRIGGERS) continue;
                            const split = splitTrades(trades);
                            if (split.holdout.length < MIN_HOLDOUT_TRIGGERS || split.recent.length < MIN_HOLDOUT_TRIGGERS) continue;
                            const all = summarize(trades);
                            const train = summarize(split.train);
                            const holdout = summarize(split.holdout);
                            const recent = summarize(split.recent);
                            const pass = all.winRate >= MIN_WIN_RATE
                                && all.wilsonLCB95 >= MIN_LCB
                                && all.avgPnlPerShare >= MIN_AVG_PNL
                                && train.avgPnlPerShare > 0
                                && holdout.avgPnlPerShare > 0
                                && recent.avgPnlPerShare > 0
                                && holdout.winRate >= 0.62
                                && recent.winRate >= 0.62;
                            if (!pass) continue;
                            candidates.push({
                                id: `SE_${timeframe}_${asset}_${minuteMin}_${minuteMax}_${minMoveBps}_${maxPrice}_${minNaiveEdge}`,
                                kind: 'CEX_MOMENTUM_POLYMARKET_LAG',
                                timeframe,
                                asset,
                                minuteMin,
                                minuteMax,
                                minMoveBps,
                                maxPrice,
                                minNaiveEdge,
                                all,
                                train,
                                holdout,
                                recent,
                                trades,
                                score: (holdout.avgPnlPerShare * 3) + (recent.avgPnlPerShare * 4) + all.avgPnlPerShare + (all.wilsonLCB95 * 0.25),
                            });
                        }
                    }
                }
            }
        }
    }
    return candidates.sort((a, b) => b.score - a.score || b.all.trades - a.all.trades);
}

function overlapsTooMuch(candidate, selected) {
    const candidateKeys = new Set(candidate.trades.map((trade) => `${trade.key}:${trade.minute}`));
    for (const existing of selected) {
        const existingKeys = new Set(existing.trades.map((trade) => `${trade.key}:${trade.minute}`));
        let overlap = 0;
        for (const key of candidateKeys) if (existingKeys.has(key)) overlap += 1;
        const denom = Math.min(candidateKeys.size, existingKeys.size) || 1;
        if (overlap / denom > 0.35) return true;
    }
    return false;
}

function selectCandidates(candidates) {
    const selected = [];
    for (const candidate of candidates) {
        if (selected.length >= MAX_RULES) break;
        if (overlapsTooMuch(candidate, selected)) continue;
        selected.push(candidate);
    }
    return selected;
}

function simulate(selected, filters = {}) {
    const events = [];
    for (const candidate of selected) {
        for (const trade of candidate.trades) {
            if (filters.excludeDay && new Date(trade.epoch * 1000).toISOString().slice(0, 10) === filters.excludeDay) continue;
            if (filters.excludeAsset && trade.asset === filters.excludeAsset) continue;
            if (filters.includeTimeframe && trade.timeframe !== filters.includeTimeframe) continue;
            events.push({ ...trade, ruleId: candidate.id });
        }
    }
    events.sort((a, b) => a.epoch - b.epoch || a.minute - b.minute || a.asset.localeCompare(b.asset));
    let bankroll = START_BANKROLL;
    let peak = START_BANKROLL;
    let minBankroll = START_BANKROLL;
    let maxDrawdown = 0;
    let wins = 0;
    let losses = 0;
    const dayStats = new Map();
    const takenByCycle = new Map();
    const takenMarkets = new Set();
    const tradeLog = [];
    for (const event of events) {
        if (takenMarkets.has(event.key)) continue;
        const cycleKey = `${event.timeframe}:${event.epoch}`;
        const taken = takenByCycle.get(cycleKey) || 0;
        if (taken >= 2) continue;
        const stakeUsd = Math.max(1, Math.min(bankroll * 0.25, 7.5));
        const shares = stakeUsd / event.entry;
        const pnlUsd = shares * event.pnl;
        bankroll += pnlUsd;
        peak = Math.max(peak, bankroll);
        minBankroll = Math.min(minBankroll, bankroll);
        maxDrawdown = Math.max(maxDrawdown, peak > 0 ? (peak - bankroll) / peak : 0);
        if (event.won) wins += 1; else losses += 1;
        takenMarkets.add(event.key);
        takenByCycle.set(cycleKey, taken + 1);
        const day = new Date(event.epoch * 1000).toISOString().slice(0, 10);
        const stat = dayStats.get(day) || { day, trades: 0, wins: 0, losses: 0, pnl: 0, endBankroll: null };
        stat.trades += 1;
        if (event.won) stat.wins += 1; else stat.losses += 1;
        stat.pnl += pnlUsd;
        stat.endBankroll = bankroll;
        dayStats.set(day, stat);
        tradeLog.push({
            ts: new Date((event.epoch + event.minute * 60) * 1000).toISOString(),
            ruleId: event.ruleId,
            timeframe: event.timeframe,
            asset: event.asset,
            minute: event.minute,
            direction: event.direction,
            entry: round(event.entry, 4),
            absMoveBps: round(event.absMoveBps, 2),
            won: event.won,
            pnlUsd: round(pnlUsd, 6),
            bankroll: round(bankroll, 6),
        });
        if (bankroll <= 0.5) break;
    }
    return {
        startBankroll: START_BANKROLL,
        endBankroll: round(bankroll, 6),
        profit: round(bankroll - START_BANKROLL, 6),
        endMultiple: round(bankroll / START_BANKROLL, 4),
        minBankroll: round(minBankroll, 6),
        maxDrawdown: round(maxDrawdown, 6),
        trades: tradeLog.length,
        wins,
        losses,
        winRate: tradeLog.length ? round(wins / tradeLog.length, 6) : 0,
        dayStats: [...dayStats.values()].map((stat) => ({
            ...stat,
            pnl: round(stat.pnl, 6),
            endBankroll: round(stat.endBankroll, 6),
        })),
        tradeLog: tradeLog.slice(0, 300),
    };
}

function stressTests(selected) {
    const allTrades = selected.flatMap((candidate) => candidate.trades || []);
    const days = [...new Set(allTrades.map((trade) => new Date(trade.epoch * 1000).toISOString().slice(0, 10)))].sort();
    const assets = [...new Set(allTrades.map((trade) => trade.asset))].sort();
    const timeframes = [...new Set(allTrades.map((trade) => trade.timeframe))].sort();
    return {
        leaveOneDayOut: days.map((day) => ({ excludeDay: day, simulation: simulate(selected, { excludeDay: day }) })),
        leaveOneAssetOut: assets.map((asset) => ({ excludeAsset: asset, simulation: simulate(selected, { excludeAsset: asset }) })),
        byTimeframe: timeframes.map((timeframe) => ({ includeTimeframe: timeframe, simulation: simulate(selected, { includeTimeframe: timeframe }) })),
    };
}

function stripTrades(candidate) {
    const copy = { ...candidate };
    copy.trades = undefined;
    for (const key of ['all', 'train', 'holdout', 'recent']) {
        copy[key] = Object.fromEntries(Object.entries(copy[key]).map(([metric, value]) => [metric, typeof value === 'number' ? round(value, 6) : value]));
    }
    copy.score = round(copy.score, 6);
    return copy;
}

function toStrategy(candidate, index) {
    return {
        id: candidate.id,
        name: `Structural CEX lag ${index + 1}`,
        kind: 'CEX_MOMENTUM_POLYMARKET_LAG',
        asset: candidate.asset,
        direction: 'SIGNAL',
        directionFromSignal: true,
        utcHour: -1,
        entryMinuteMin: candidate.minuteMin,
        entryMinuteMax: candidate.minuteMax,
        priceMin: MIN_ENTRY,
        priceMax: candidate.maxPrice,
        minMoveBps: candidate.minMoveBps,
        minNaiveEdge: candidate.minNaiveEdge,
        maxSignalAgeSec: 120,
        pWinEstimate: round(candidate.all.wilsonLCB95, 6),
        evWinEstimate: round(candidate.all.winRate, 6),
        winRate: round(candidate.all.winRate, 6),
        winRateLCB: round(candidate.all.wilsonLCB95, 6),
        avgPnlPerShare: round(candidate.all.avgPnlPerShare, 6),
        source: 'structural_edge_search',
        notes: 'Trades in the live Binance cycle-move direction only when Polymarket odds still satisfy the audited cheapness/edge gate.',
        audit: {
            all: stripTrades(candidate).all,
            train: stripTrades(candidate).train,
            holdout: stripTrades(candidate).holdout,
            recent: stripTrades(candidate).recent,
        },
    };
}

function writeStrategyArtifacts(selected, stamp, reportFile) {
    const byTimeframe = new Map();
    for (const candidate of selected) {
        if (!byTimeframe.has(candidate.timeframe)) byTimeframe.set(candidate.timeframe, []);
        byTimeframe.get(candidate.timeframe).push(candidate);
    }
    const artifacts = [];
    for (const [timeframe, candidates] of byTimeframe.entries()) {
        const rel = path.join('strategies', `strategy_set_${timeframe}_structural_edge_${stamp}.json`);
        const abs = path.join(ROOT, rel);
        const payload = {
            name: `${timeframe} structural CEX-lag edge candidate`,
            generatedAt: new Date().toISOString(),
            sourceReport: path.relative(ROOT, reportFile),
            status: 'RESEARCH_CANDIDATE_OPERATOR_APPROVAL_REQUIRED',
            conditions: {
                requiresStructuralSignal: true,
                signalSource: 'Binance 1m klines via lib/structural-signal.js',
                productionNotes: 'Requires runtime structural-edge matcher support and timeframe enablement before use.',
            },
            strategies: candidates.map(toStrategy),
        };
        fs.writeFileSync(abs, JSON.stringify(payload, null, 2));
        artifacts.push(path.relative(ROOT, abs));
    }
    return artifacts;
}

async function main() {
    ensureDir(OUT_DIR);
    const loaded = loadCycles();
    if (!loaded.cycles.length) throw new Error('No cycle cache rows loaded');
    const binanceByAsset = await loadBinanceIndexes(loaded.cycles);
    const made = makeObservations(loaded.cycles, binanceByAsset);
    const candidates = evaluateCandidates(made.observations);
    const selected = selectCandidates(candidates);
    const selectedSimulation = simulate(selected);
    const stress = stressTests(selected);
    const issues = [];
    if (!selected.length) issues.push('NO_STRUCTURAL_EDGE_CANDIDATES_PASSED_GATES');
    if (selectedSimulation.trades < 30) issues.push('SELECTED_SET_SAMPLE_UNDER_30_TRADES');
    if (selectedSimulation.maxDrawdown > MAX_DRAWDOWN) issues.push('SELECTED_DRAWDOWN_TOO_HIGH');
    if (selectedSimulation.endMultiple < MIN_END_MULTIPLE) issues.push('SELECTED_UPSIDE_TOO_LOW_FOR_OPERATOR_GOAL');
    if ((selectedSimulation.dayStats || []).some((day) => day.pnl < 0)) issues.push('SELECTED_HAS_NEGATIVE_DAY');
    if ((stress.leaveOneDayOut || []).some((item) => item.simulation.endMultiple < MIN_END_MULTIPLE)) issues.push('LEAVE_ONE_DAY_OUT_UPSIDE_TOO_WEAK');
    if ((stress.leaveOneAssetOut || []).some((item) => item.simulation.endBankroll < START_BANKROLL)) issues.push('LEAVE_ONE_ASSET_OUT_LOSES_MONEY');
    const verdict = {
        status: issues.length ? 'NO_GO_PROMOTION' : 'PROMOTION_CANDIDATE_REQUIRES_OPERATOR_APPROVAL',
        issues,
        note: 'This tests CEX-led Polymarket lag using Binance 1m candles; it is still a research artifact and must not auto-unpause production.',
    };
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
    const report = {
        generatedAt: new Date().toISOString(),
        config: {
            startBankroll: START_BANKROLL,
            scanTimeframes: [...SCAN_TIMEFRAMES],
            adverseFillCents: ADVERSE_FILL_CENTS,
            slippagePct: SLIPPAGE_PCT,
            minTriggers: MIN_TRIGGERS,
            minHoldoutTriggers: MIN_HOLDOUT_TRIGGERS,
            minWinRate: MIN_WIN_RATE,
            minWilsonLCB: MIN_LCB,
            minAvgPnlPerShare: MIN_AVG_PNL,
        },
        datasets: loaded.datasets,
        cyclesLoaded: loaded.cycles.length,
        observations: made.observations.length,
        missingKlines: made.missingKlines,
        candidateCount: candidates.length,
        selectedCount: selected.length,
        verdict,
        selectedSimulation,
        stress,
        selected: selected.map(stripTrades),
        topCandidates: candidates.slice(0, 30).map(stripTrades),
    };
    const outFile = path.join(OUT_DIR, `structural_edge_search_${stamp}.json`);
    const strategyArtifacts = writeStrategyArtifacts(selected, stamp, outFile);
    report.strategyArtifacts = strategyArtifacts;
    fs.writeFileSync(outFile, JSON.stringify(report, null, 2));
    console.log(JSON.stringify({
        report: path.relative(ROOT, outFile),
        strategyArtifacts,
        verdict,
        cyclesLoaded: report.cyclesLoaded,
        observations: report.observations,
        candidateCount: report.candidateCount,
        selectedCount: report.selectedCount,
        selectedSimulation,
        stress,
        selected: report.selected,
    }, null, 2));
}

main().catch((error) => {
    console.error(error.stack || error.message);
    process.exit(1);
});