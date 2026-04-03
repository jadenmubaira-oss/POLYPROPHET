#!/usr/bin/env node
// Search the full active validated 15m universe for the strongest guarded
// short-horizon portfolio under the current lite runtime mechanics.

const fs = require('fs');
const path = require('path');
const CONFIG = require('../lib/config');
const RiskManager = require('../lib/risk-manager');

const ROOT = path.join(__dirname, '..');
const TIMEFRAME = '15m';
const CYCLE_SECONDS = 900;
const START_BALANCE = Math.max(2, Number(process.env.START_BALANCE || 20));
const MIN_RUNTIME_BANKROLL = Math.max(0, Number(process.env.MIN_RUNTIME_BANKROLL || process.env.TIMEFRAME_15M_MIN_BANKROLL || 5));
const BUST_THRESHOLD = Math.max(2, MIN_RUNTIME_BANKROLL);
const MAX_STRATEGIES = Math.max(1, Number(process.env.MAX_STRATEGIES || 14));
const BEAM_WIDTH = Math.max(1, Number(process.env.BEAM_WIDTH || 220));
const BOOTSTRAP_TRIALS = Math.max(100, Number(process.env.BOOTSTRAP_TRIALS || 1200));
const BOOTSTRAP_BLOCK_DAYS = Math.max(1, Number(process.env.BOOTSTRAP_BLOCK_DAYS || 3));
const FINALISTS = Math.max(1, Number(process.env.FINALISTS || 6));
const MIN_RECENT_ACTIVE_DAYS = Math.max(1, Number(process.env.MIN_RECENT_ACTIVE_DAYS || 7));
const MIN_HIST_ACTIVE_DAYS = Math.max(1, Number(process.env.MIN_HIST_ACTIVE_DAYS || 10));
const UNIVERSE_MODE = String(process.env.UNIVERSE_MODE || 'all').toLowerCase();
const INCLUDE_REFERENCE_SEARCH = String(process.env.INCLUDE_REFERENCE_SEARCH || '0') === '1';
const SEARCH_MODE = String(process.env.SEARCH_MODE || 'beam').toLowerCase();
const EXHAUSTIVE_MAX_UNIVERSE = Math.max(1, Number(process.env.EXHAUSTIVE_MAX_UNIVERSE || 20));
const RECENT_ACTIVITY_HOURS = Math.max(0, Number(process.env.RECENT_ACTIVITY_HOURS || 0));
const MIN_RECENT_ACTIVITY_MATCHES = Math.max(0, Number(process.env.MIN_RECENT_ACTIVITY_MATCHES || 0));
const CANDIDATE_NAMES_PATH = String(process.env.CANDIDATE_NAMES_PATH || '').trim();
const CANDIDATE_NAMES_INLINE = String(process.env.CANDIDATE_NAMES || '').trim();
const RUN_LABEL = String(process.env.RUN_LABEL || 'default').trim();
const OUT_PATH = process.env.OUTPUT_PATH
    ? path.resolve(process.env.OUTPUT_PATH)
    : path.join(ROOT, 'debug', 'search_15m_short_horizon_guarded.json');
const STRATEGY_OUT_PATH = process.env.STRATEGY_OUTPUT_PATH
    ? path.resolve(process.env.STRATEGY_OUTPUT_PATH)
    : path.join(ROOT, 'debug', 'strategy_set_15m_short_horizon_guarded_best.json');

const TAKER_FEE = 0.0315;
const DEFAULT_MIN_ORDER_SHARES = 5;
const MAX_ALLOWED_SPREAD_DEVIATION = 0.08;

function readJson(relOrAbsPath) {
    const filePath = path.isAbsolute(relOrAbsPath) ? relOrAbsPath : path.join(ROOT, relOrAbsPath);
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function writeJson(relOrAbsPath, value) {
    const filePath = path.isAbsolute(relOrAbsPath) ? relOrAbsPath : path.join(ROOT, relOrAbsPath);
    fs.writeFileSync(filePath, JSON.stringify(value, null, 2));
}

function readCandidateNameFilter() {
    const names = new Set();
    if (CANDIDATE_NAMES_PATH) {
        const filterPath = path.isAbsolute(CANDIDATE_NAMES_PATH) ? CANDIDATE_NAMES_PATH : path.join(ROOT, CANDIDATE_NAMES_PATH);
        const raw = fs.readFileSync(filterPath, 'utf8');
        try {
            const parsed = JSON.parse(raw);
            if (Array.isArray(parsed)) {
                for (const entry of parsed) {
                    const name = String(entry || '').trim();
                    if (name) names.add(name);
                }
            }
        } catch {
            for (const line of raw.split(/\r?\n/)) {
                const name = String(line || '').trim();
                if (name) names.add(name);
            }
        }
    }
    if (CANDIDATE_NAMES_INLINE) {
        for (const entry of CANDIDATE_NAMES_INLINE.split('||')) {
            const name = String(entry || '').trim();
            if (name) names.add(name);
        }
    }
    return names;
}

function round(value, digits = 4) {
    if (!Number.isFinite(Number(value))) return 0;
    const factor = Math.pow(10, digits);
    return Math.round(Number(value) * factor) / factor;
}

function percentile(sortedValues, p) {
    if (!sortedValues.length) return 0;
    const idx = (sortedValues.length - 1) * p;
    const low = Math.floor(idx);
    const high = Math.ceil(idx);
    if (low === high) return sortedValues[low];
    const weight = idx - low;
    return (sortedValues[low] * (1 - weight)) + (sortedValues[high] * weight);
}

function nextDay(dayKey) {
    const d = new Date(`${dayKey}T00:00:00.000Z`);
    d.setUTCDate(d.getUTCDate() + 1);
    return d.toISOString().slice(0, 10);
}

function enumerateDayRange(startDay, endDay) {
    if (!startDay || !endDay) return [];
    const days = [];
    let cur = startDay;
    while (cur <= endDay) {
        days.push(cur);
        cur = nextDay(cur);
    }
    return days;
}

function dayKeyFromEpoch(epochSec) {
    return new Date(Number(epochSec) * 1000).toISOString().slice(0, 10);
}

function sampleInt(n) {
    return Math.floor(Math.random() * n);
}

function candidateKey(candidate) {
    return [
        String(candidate.asset || 'ALL').toUpperCase(),
        Number(candidate.utcHour),
        Number(candidate.entryMinute),
        String(candidate.direction || '').toUpperCase(),
        Number(candidate.priceMin).toFixed(2),
        Number(candidate.priceMax).toFixed(2)
    ].join('|');
}

function parseCandidateKey(key) {
    const [asset, utcHour, entryMinute, direction, priceMin, priceMax] = String(key || '').split('|');
    return {
        asset: String(asset || 'ALL').toUpperCase(),
        utcHour: Number(utcHour),
        entryMinute: Number(entryMinute),
        direction: String(direction || '').toUpperCase(),
        priceMin: Number(priceMin),
        priceMax: Number(priceMax)
    };
}

function normalizeReportCandidate(raw) {
    const base = parseCandidateKey(raw.key);
    return {
        ...base,
        key: raw.key,
        name: raw.name,
        sources: raw.sources || [],
        pWinEstimate: Math.max(0.5, Number(raw?.metrics?.train?.lcb || raw?.metrics?.test?.lcb || 0.5)),
        evWinEstimate: Math.max(0.5, Number(raw?.metrics?.train?.wr || raw?.metrics?.test?.wr || raw?.metrics?.train?.lcb || 0.5)),
        metrics: raw.metrics || {}
    };
}

function normalizeRawStrategy(raw) {
    const normalized = {
        asset: String(raw.asset || 'ALL').toUpperCase(),
        utcHour: Number.isFinite(Number(raw.utcHour)) ? Number(raw.utcHour) : -1,
        entryMinute: Number(raw.entryMinute),
        direction: String(raw.direction || '').toUpperCase(),
        priceMin: Number(raw.priceMin),
        priceMax: Number(raw.priceMax),
        name: raw.name || 'strategy',
        sources: raw.sources || raw.source || [],
        pWinEstimate: Math.max(
            0.5,
            Number(
                raw?.pWinEstimate ??
                raw?.winRateLCB ??
                raw?.metrics?.train?.lcb ??
                raw?.metrics?.test?.lcb ??
                raw?.winRate ??
                0.5
            )
        ),
        evWinEstimate: Math.max(
            0.5,
            Number(
                raw?.metrics?.train?.wr ??
                raw?.winRate ??
                raw?.pWinEstimate ??
                raw?.metrics?.test?.wr ??
                raw?.metrics?.train?.lcb ??
                0.5
            )
        ),
        metrics: raw.metrics || {}
    };
    normalized.key = candidateKey(normalized);
    return normalized;
}

function splitDataset(rows) {
    const epochs = [...new Set(rows.map((row) => Number(row.cycleStartEpochSec)).filter(Number.isFinite))].sort((a, b) => a - b);
    const valEnd = Math.floor(epochs.length * 0.80);
    const testEpochs = new Set(epochs.slice(valEnd));
    return {
        testRows: rows.filter((row) => testEpochs.has(Number(row.cycleStartEpochSec))),
        historicalEndEpoch: epochs[epochs.length - 1]
    };
}

function matchHistoricalRow(candidate, row) {
    const epoch = Number(row.cycleStartEpochSec);
    if (!Number.isFinite(epoch)) return null;
    if (candidate.asset !== 'ALL' && String(row.asset || '').toUpperCase() !== candidate.asset) return null;
    if (candidate.utcHour !== -1 && Number(row.utcHour) !== candidate.utcHour) return null;
    if (Number(row.entryMinute) !== candidate.entryMinute) return null;

    const upPrice = Number(row.upPrice);
    const downPrice = Number(row.downPrice);
    if (!Number.isFinite(upPrice) || !Number.isFinite(downPrice)) return null;
    if (upPrice <= 0 || upPrice >= 1 || downPrice <= 0 || downPrice >= 1) return null;
    if (Math.abs((upPrice + downPrice) - 1) > MAX_ALLOWED_SPREAD_DEVIATION) return null;

    const entryPrice = candidate.direction === 'UP' ? upPrice : downPrice;
    if (entryPrice < candidate.priceMin || entryPrice > candidate.priceMax) return null;

    return {
        asset: String(row.asset || '').toUpperCase(),
        epoch,
        entryPrice,
        won: String(row.resolvedOutcome || '').toUpperCase() === candidate.direction
    };
}

function recentCycleMatch(candidate, cycle) {
    const epoch = Number(cycle.epoch);
    if (!Number.isFinite(epoch)) return null;
    const utcHour = new Date(epoch * 1000).getUTCHours();
    if (candidate.utcHour !== -1 && candidate.utcHour !== utcHour) return null;
    if (candidate.asset !== 'ALL' && String(cycle.asset || '').toUpperCase() !== candidate.asset) return null;

    const priceMap = candidate.direction === 'UP' ? cycle.minutePricesYes : cycle.minutePricesNo;
    const priceData = priceMap?.[candidate.entryMinute];
    if (!priceData) return null;
    const entryPrice = Number(priceData.last);
    if (!Number.isFinite(entryPrice)) return null;
    if (entryPrice < candidate.priceMin || entryPrice > candidate.priceMax) return null;

    const oppositeMap = candidate.direction === 'UP' ? cycle.minutePricesNo : cycle.minutePricesYes;
    const oppositePrice = Number(oppositeMap?.[candidate.entryMinute]?.last);
    if (Number.isFinite(oppositePrice) && Math.abs((entryPrice + oppositePrice) - 1) > MAX_ALLOWED_SPREAD_DEVIATION) return null;

    const minOrderRaw = candidate.direction === 'UP'
        ? (cycle.yesMinOrderSize ?? cycle.orderMinSize)
        : (cycle.noMinOrderSize ?? cycle.orderMinSize);
    const minOrderShares = Number.isFinite(Number(minOrderRaw)) && Number(minOrderRaw) > 0
        ? Math.max(DEFAULT_MIN_ORDER_SHARES, Math.ceil(Number(minOrderRaw)))
        : DEFAULT_MIN_ORDER_SHARES;

    return {
        epoch,
        entryPrice,
        minOrderShares,
        won: String(cycle.resolution || '').toUpperCase() === candidate.direction
    };
}

function buildHistoricalTrades(rows, candidate) {
    const trades = [];
    for (const row of rows) {
        const hit = matchHistoricalRow(candidate, row);
        if (!hit) continue;
        const entryTs = hit.epoch + (candidate.entryMinute * 60);
        const dayKey = dayKeyFromEpoch(entryTs);
        const dayStartTs = Math.floor(Date.parse(`${dayKey}T00:00:00.000Z`) / 1000);
        trades.push({
            candidateKey: candidate.key,
            timeframe: TIMEFRAME,
            asset: hit.asset,
            dayKey,
            cycleEpoch: hit.epoch,
            cycleKey: `${TIMEFRAME}_${hit.epoch}`,
            entryOffsetSec: entryTs - dayStartTs,
            exitOffsetSec: (hit.epoch + CYCLE_SECONDS) - dayStartTs,
            entryPrice: hit.entryPrice,
            pWinEstimate: candidate.pWinEstimate,
            evWinEstimate: candidate.evWinEstimate || candidate.pWinEstimate,
            won: hit.won,
            minOrderShares: DEFAULT_MIN_ORDER_SHARES
        });
    }
    return trades;
}

function buildRecentTrades(cycles, candidate) {
    const trades = [];
    for (const cycle of cycles) {
        const hit = recentCycleMatch(candidate, cycle);
        if (!hit) continue;
        const entryTs = hit.epoch + (candidate.entryMinute * 60);
        const dayKey = dayKeyFromEpoch(entryTs);
        const dayStartTs = Math.floor(Date.parse(`${dayKey}T00:00:00.000Z`) / 1000);
        trades.push({
            candidateKey: candidate.key,
            timeframe: TIMEFRAME,
            asset: String(cycle.asset || '').toUpperCase(),
            dayKey,
            cycleEpoch: hit.epoch,
            cycleKey: `${TIMEFRAME}_${hit.epoch}`,
            entryOffsetSec: entryTs - dayStartTs,
            exitOffsetSec: (hit.epoch + CYCLE_SECONDS) - dayStartTs,
            entryPrice: hit.entryPrice,
            pWinEstimate: candidate.pWinEstimate,
            evWinEstimate: candidate.evWinEstimate || candidate.pWinEstimate,
            won: hit.won,
            minOrderShares: hit.minOrderShares
        });
    }
    return trades;
}

function groupTradesByDay(trades) {
    const map = new Map();
    for (const trade of trades) {
        if (!map.has(trade.dayKey)) map.set(trade.dayKey, []);
        map.get(trade.dayKey).push(trade);
    }
    return [...map.entries()]
        .map(([dayKey, dayTrades]) => ({
            dayKey,
            trades: dayTrades.sort((a, b) =>
                a.entryOffsetSec !== b.entryOffsetSec
                    ? a.entryOffsetSec - b.entryOffsetSec
                    : b.pWinEstimate !== a.pWinEstimate
                        ? b.pWinEstimate - a.pWinEstimate
                        : a.entryPrice - b.entryPrice
            )
        }))
        .sort((a, b) => a.dayKey.localeCompare(b.dayKey));
}

function estimateNetEdgeRoi(entryPrice, pWinEstimate) {
    const entry = Number(entryPrice);
    const pWin = Number(pWinEstimate);
    if (!(entry > 0) || entry >= 1 || !(pWin > 0) || pWin >= 1) return null;
    const effectiveEntry = Math.min(0.99, entry * (1 + Number(CONFIG?.RISK?.slippagePct || 0)));
    if (!(effectiveEntry > 0) || effectiveEntry >= 1) return null;
    const winProfitPerDollar = ((1 - effectiveEntry) * (1 - Number(CONFIG?.RISK?.takerFeePct || TAKER_FEE))) / effectiveEntry;
    return (pWin * winProfitPerDollar) - (1 - pWin);
}

function getMaxPerCycle(bankroll) {
    return bankroll < 10 ? 1 : 2;
}

function runSimulationSequence(dayBuckets, startBalance, sequenceKeys) {
    const rm = new RiskManager(startBalance);
    const state = {
        bankroll: startBalance,
        peakBalance: startBalance,
        dayStartBalance: startBalance,
        todayPnL: 0,
        cooldownUntilSec: -Infinity,
        consecutiveLosses: 0,
        totalTrades: 0,
        totalWins: 0,
        openPositions: []
    };
    const bucketMap = new Map(dayBuckets.map((bucket) => [bucket.dayKey, bucket]));
    const dailyPath = [];

    function settlePosition(position) {
        if (position.won) {
            const grossProfit = position.shares - position.cost;
            const fee = Math.max(0, grossProfit) * TAKER_FEE;
            const netPayout = position.shares - fee;
            const pnl = netPayout - position.cost;
            state.bankroll += netPayout;
            state.todayPnL += pnl;
            state.totalWins++;
            state.consecutiveLosses = 0;
            if (state.bankroll > state.peakBalance) state.peakBalance = state.bankroll;
        } else {
            state.todayPnL -= position.cost;
            state.consecutiveLosses++;
            if (state.consecutiveLosses >= 4) {
                state.cooldownUntilSec = position.exitTs + 600;
                state.consecutiveLosses = 0;
            }
        }
        state.totalTrades++;
    }

    function settleUpTo(untilTs) {
        state.openPositions.sort((a, b) => a.exitTs - b.exitTs);
        while (state.openPositions.length > 0 && state.openPositions[0].exitTs <= untilTs) {
            settlePosition(state.openPositions.shift());
        }
    }

    for (let index = 0; index < sequenceKeys.length; index++) {
        const dayKey = sequenceKeys[index];
        const bucket = bucketMap.get(dayKey);
        const dayStartTs = index * 86400;
        const dayEndTs = dayStartTs + 86400;

        settleUpTo(dayStartTs);
        state.dayStartBalance = state.bankroll;
        state.todayPnL = 0;
        let dayStopped = false;
        const cycleCounts = {};

        const trades = (bucket?.trades || []).map((trade) => ({
            ...trade,
            entryTs: dayStartTs + trade.entryOffsetSec,
            exitTs: dayStartTs + trade.exitOffsetSec
        }));

        for (const trade of trades) {
            settleUpTo(trade.entryTs);
            if (state.bankroll < 2 && state.openPositions.length === 0) break;
            if (state.bankroll < MIN_RUNTIME_BANKROLL) continue;
            if (dayStopped) continue;
            if (trade.entryTs < state.cooldownUntilSec) continue;
            if (state.todayPnL < -(state.dayStartBalance * 0.20)) {
                dayStopped = true;
                continue;
            }

            const maxPerCycle = getMaxPerCycle(state.bankroll);
            const cycleCount = cycleCounts[trade.cycleKey] || 0;
            if (cycleCount >= maxPerCycle) continue;

            const netEdgeRoi = estimateNetEdgeRoi(trade.entryPrice, trade.evWinEstimate ?? trade.pWinEstimate);
            if (!Number.isFinite(netEdgeRoi) || netEdgeRoi < Number(CONFIG?.RISK?.minNetEdgeRoi || 0)) continue;

            const openExposureUsd = state.openPositions.reduce((sum, position) => sum + Number(position.cost || 0), 0);
            rm.bankroll = state.bankroll;
            rm.peakBalance = state.peakBalance;
            rm.dayStartBalance = state.dayStartBalance;
            const sizing = rm.calculateSize(
                {
                    entryPrice: trade.entryPrice,
                    pWinEstimate: trade.pWinEstimate,
                    minOrderShares: trade.minOrderShares || DEFAULT_MIN_ORDER_SHARES,
                    timeframe: trade.timeframe,
                    epoch: trade.cycleEpoch
                },
                {
                    availableCash: state.bankroll,
                    openExposureUsd,
                    bankrollEstimate: state.bankroll + openExposureUsd,
                    dayStartBalanceEstimate: state.dayStartBalance
                }
            );
            if (sizing.blocked || sizing.size <= 0) continue;

            const shares = Math.floor(sizing.size / trade.entryPrice + 1e-9);
            if (shares < (trade.minOrderShares || DEFAULT_MIN_ORDER_SHARES)) continue;
            const cost = shares * trade.entryPrice;
            if (cost > state.bankroll) continue;

            state.bankroll -= cost;
            cycleCounts[trade.cycleKey] = cycleCount + 1;
            state.openPositions.push({
                exitTs: trade.exitTs,
                cost,
                shares,
                won: trade.won
            });
        }

        settleUpTo(dayEndTs);
        dailyPath.push({ day: dayKey, balance: round(state.bankroll, 2) });
    }

    settleUpTo(Number.MAX_SAFE_INTEGER);

    let peak = startBalance;
    let maxDrawdown = 0;
    for (const point of dailyPath) {
        if (point.balance > peak) peak = point.balance;
        if (peak > 0) {
            const dd = (peak - point.balance) / peak;
            if (dd > maxDrawdown) maxDrawdown = dd;
        }
    }

    return {
        finalBalance: round(state.bankroll, 2),
        busted: state.bankroll < BUST_THRESHOLD,
        totalTrades: state.totalTrades,
        winRate: state.totalTrades > 0 ? round(state.totalWins / state.totalTrades) : 0,
        maxDrawdown: round(maxDrawdown),
        path: dailyPath
    };
}

function slidingWindowSummary(dayBuckets, fullSequence, startBalance, windowDays, stepDays) {
    if (!fullSequence.length) return null;
    const actualWindowDays = Math.min(windowDays, fullSequence.length);
    const windows = [];
    for (let i = 0; i + actualWindowDays <= fullSequence.length; i += stepDays) {
        const seq = fullSequence.slice(i, i + actualWindowDays);
        const result = runSimulationSequence(dayBuckets, startBalance, seq);
        windows.push({
            start: seq[0],
            end: seq[seq.length - 1],
            finalBalance: result.finalBalance,
            busted: result.busted,
            totalTrades: result.totalTrades,
            winRate: result.winRate,
            maxDrawdown: result.maxDrawdown
        });
    }
    const finals = windows.map((w) => w.finalBalance).sort((a, b) => a - b);
    const dds = windows.map((w) => w.maxDrawdown).sort((a, b) => a - b);
    const bustCount = windows.filter((w) => w.busted).length;
    return {
        windowDays: actualWindowDays,
        stepDays,
        windowCount: windows.length,
        bustRate: round(bustCount / Math.max(1, windows.length)),
        finalBalance: {
            min: round(finals[0]),
            p25: round(percentile(finals, 0.25)),
            median: round(percentile(finals, 0.50)),
            p75: round(percentile(finals, 0.75)),
            max: round(finals[finals.length - 1])
        },
        maxDrawdown: {
            min: round(dds[0]),
            p25: round(percentile(dds, 0.25)),
            median: round(percentile(dds, 0.50)),
            p75: round(percentile(dds, 0.75)),
            max: round(dds[dds.length - 1])
        }
    };
}

function bootstrapSequence(fullSequence, targetDays, blockDays) {
    const out = [];
    while (out.length < targetDays) {
        const start = sampleInt(fullSequence.length);
        for (let i = 0; i < blockDays && out.length < targetDays; i++) {
            out.push(fullSequence[(start + i) % fullSequence.length]);
        }
    }
    return out;
}

function bootstrapSummary(dayBuckets, fullSequence, targetDays, blockDays, trials) {
    const finals = [];
    let busts = 0;
    let totalTrades = 0;
    let totalWinRate = 0;
    let totalDD = 0;
    for (let i = 0; i < trials; i++) {
        const seq = bootstrapSequence(fullSequence, targetDays, blockDays);
        const result = runSimulationSequence(dayBuckets, START_BALANCE, seq);
        finals.push(result.finalBalance);
        if (result.busted) busts++;
        totalTrades += result.totalTrades;
        totalWinRate += result.winRate;
        totalDD += result.maxDrawdown;
    }
    finals.sort((a, b) => a - b);
    return {
        trials,
        simDays: targetDays,
        blockDays,
        bustRate: round(busts / trials),
        avgTrades: round(totalTrades / trials, 1),
        avgWinRate: round(totalWinRate / trials),
        avgMaxDrawdown: round(totalDD / trials),
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

const dataset = readJson('exhaustive_analysis/decision_dataset.json');
const rows = Array.isArray(dataset) ? dataset : (dataset.rows || []);
const allRecentCycles = readJson('data/intracycle-price-data.json').cycles || [];
const optimizeReport = readJson('debug/optimize_15m_max_median_runtime_ultrarelaxed_full.json');
const split = splitDataset(rows);
const recentCycles = allRecentCycles
    .filter((cycle) => Number(cycle.epoch) > split.historicalEndEpoch)
    .sort((a, b) => Number(a.epoch) - Number(b.epoch));
const universe = (optimizeReport.topCandidates || []).map(normalizeReportCandidate);
const histEpochs = [...new Set(split.testRows.map((row) => Number(row.cycleStartEpochSec)).filter(Number.isFinite))].sort((a, b) => a - b);
const histSequence = enumerateDayRange(dayKeyFromEpoch(histEpochs[0]), dayKeyFromEpoch(histEpochs[histEpochs.length - 1]));
const recentSequence = recentCycles.length
    ? enumerateDayRange(dayKeyFromEpoch(recentCycles[0].epoch), dayKeyFromEpoch(recentCycles[recentCycles.length - 1].epoch))
    : [];
const fullSequence = recentSequence.length ? enumerateDayRange(histSequence[0], recentSequence[recentSequence.length - 1]) : histSequence;

const tradeIndex = new Map();
function getTradePrecompute(candidate) {
    if (!candidate?.key) return { historicalTrades: [], recentTrades: [] };
    if (!tradeIndex.has(candidate.key)) {
        tradeIndex.set(candidate.key, {
            historicalTrades: buildHistoricalTrades(split.testRows, candidate),
            recentTrades: buildRecentTrades(recentCycles, candidate)
        });
    }
    return tradeIndex.get(candidate.key);
}
for (const candidate of universe) getTradePrecompute(candidate);

function computeRecentActivity(candidate, recentHours) {
    const hours = Math.max(0, Number(recentHours) || 0);
    const maxRecentEpoch = Number(recentCycles[recentCycles.length - 1]?.epoch || 0);
    if (!(hours > 0) || !Number.isFinite(maxRecentEpoch) || maxRecentEpoch <= 0) {
        return { hours, matches: 0, wins: 0, losses: 0, matchedDays: 0, winRate: null };
    }
    const cutoffEpoch = maxRecentEpoch - (hours * 3600);
    const matchedDays = new Set();
    let matches = 0;
    let wins = 0;
    for (const cycle of recentCycles) {
        const epoch = Number(cycle.epoch);
        if (!Number.isFinite(epoch) || epoch <= cutoffEpoch) continue;
        const hit = recentCycleMatch(candidate, cycle);
        if (!hit) continue;
        matches++;
        if (hit.won) wins++;
        matchedDays.add(dayKeyFromEpoch(epoch));
    }
    return {
        hours,
        matches,
        wins,
        losses: Math.max(0, matches - wins),
        matchedDays: matchedDays.size,
        winRate: matches > 0 ? round(wins / matches) : null
    };
}

const recentActivityByKey = new Map();
for (const candidate of universe) {
    recentActivityByKey.set(candidate.key, computeRecentActivity(candidate, RECENT_ACTIVITY_HOURS));
}

function buildStrategyList(strategyLikeList) {
    return (strategyLikeList || []).map(normalizeRawStrategy);
}

function mergeUniqueStrategies(strategyLists) {
    const map = new Map();
    for (const strategy of strategyLists.flat().filter(Boolean)) {
        if (!strategy?.key) continue;
        if (!map.has(strategy.key)) map.set(strategy.key, strategy);
    }
    return [...map.values()];
}

function popcount(n) {
    let count = 0;
    let value = Number(n) || 0;
    while (value) {
        count += value & 1;
        value >>>= 1;
    }
    return count;
}

function evaluateCombination(label, strategies) {
    const keySet = new Set(strategies.map((strategy) => strategy.key));
    const signature = [...keySet].sort().join('||');
    const histTrades = [];
    const recentTrades = [];
    for (const strategy of strategies) {
        const pre = getTradePrecompute(strategy);
        histTrades.push(...pre.historicalTrades);
        recentTrades.push(...pre.recentTrades);
    }

    const histBuckets = groupTradesByDay(histTrades);
    const recentBuckets = groupTradesByDay(recentTrades);
    const histActual = runSimulationSequence(histBuckets, START_BALANCE, histSequence);
    const recentActual = runSimulationSequence(recentBuckets, START_BALANCE, recentSequence);
    const hist7 = slidingWindowSummary(histBuckets, histSequence, START_BALANCE, 7, 1);
    const recent7 = slidingWindowSummary(recentBuckets, recentSequence, START_BALANCE, 7, 1);
    const hist14 = slidingWindowSummary(histBuckets, histSequence, START_BALANCE, 14, 1);
    const recent14 = slidingWindowSummary(recentBuckets, recentSequence, START_BALANCE, 14, 1);
    const recentActiveDays = recentBuckets.length;
    const histActiveDays = histBuckets.length;

    const medianFloor7 = round(Math.min(hist7?.finalBalance?.median ?? 0, recent7?.finalBalance?.median ?? 0));
    const medianFloor14 = round(Math.min(hist14?.finalBalance?.median ?? 0, recent14?.finalBalance?.median ?? 0));
    const p25Floor7 = round(Math.min(hist7?.finalBalance?.p25 ?? 0, recent7?.finalBalance?.p25 ?? 0));
    const p25Floor14 = round(Math.min(hist14?.finalBalance?.p25 ?? 0, recent14?.finalBalance?.p25 ?? 0));
    const worstWindowFinal = round(Math.min(hist14?.finalBalance?.min ?? histActual.finalBalance, recent14?.finalBalance?.min ?? recentActual.finalBalance));
    const worstMaxDrawdown = round(Math.max(hist14?.maxDrawdown?.max ?? 0, recent14?.maxDrawdown?.max ?? 0, histActual.maxDrawdown, recentActual.maxDrawdown));
    const noBust7 = !!hist7 && !!recent7 && hist7.bustRate === 0 && recent7.bustRate === 0;
    const noBust14 = !!hist14 && !!recent14 && hist14.bustRate === 0 && recent14.bustRate === 0;
    const allAboveStart = p25Floor7 >= START_BALANCE && p25Floor14 >= START_BALANCE && histActual.finalBalance >= START_BALANCE && recentActual.finalBalance >= START_BALANCE;
    const supportOk = recentActiveDays >= MIN_RECENT_ACTIVE_DAYS && histActiveDays >= MIN_HIST_ACTIVE_DAYS;
    const shortHorizonEligible = noBust7 && noBust14 && allAboveStart && supportOk;

    return {
        label,
        signature,
        strategyCount: strategies.length,
        names: strategies.map((strategy) => strategy.name),
        keys: [...keySet].sort(),
        strategies,
        support: {
            historicalTrades: histTrades.length,
            recentTrades: recentTrades.length,
            historicalActiveDays: histActiveDays,
            recentActiveDays
        },
        historicalActual: histActual,
        recentActual,
        windows7: {
            historical: hist7,
            recent: recent7
        },
        windows14: {
            historical: hist14,
            recent: recent14
        },
        score: {
            shortHorizonEligible,
            noBust7,
            noBust14,
            allAboveStart,
            supportOk,
            medianFloor7,
            medianFloor14,
            p25Floor7,
            p25Floor14,
            worstWindowFinal,
            worstMaxDrawdown
        }
    };
}

function compareRows(a, b) {
    if (Number(b.score.shortHorizonEligible) !== Number(a.score.shortHorizonEligible)) {
        return Number(b.score.shortHorizonEligible) - Number(a.score.shortHorizonEligible);
    }
    if (b.score.medianFloor14 !== a.score.medianFloor14) return b.score.medianFloor14 - a.score.medianFloor14;
    if (b.score.medianFloor7 !== a.score.medianFloor7) return b.score.medianFloor7 - a.score.medianFloor7;
    if (b.score.p25Floor14 !== a.score.p25Floor14) return b.score.p25Floor14 - a.score.p25Floor14;
    if (b.score.p25Floor7 !== a.score.p25Floor7) return b.score.p25Floor7 - a.score.p25Floor7;
    if (b.recentActual.finalBalance !== a.recentActual.finalBalance) return b.recentActual.finalBalance - a.recentActual.finalBalance;
    if (a.score.worstMaxDrawdown !== b.score.worstMaxDrawdown) return a.score.worstMaxDrawdown - b.score.worstMaxDrawdown;
    return a.strategyCount - b.strategyCount;
}

function dedupeRows(rowsToDedupe) {
    const map = new Map();
    for (const row of rowsToDedupe) {
        const existing = map.get(row.signature);
        if (!existing || compareRows(row, existing) < 0) {
            map.set(row.signature, row);
        }
    }
    return [...map.values()];
}

function trimBeam(rowsToTrim, width) {
    return dedupeRows(rowsToTrim).sort(compareRows).slice(0, width);
}

function searchExhaustive(searchUniverse) {
    if (searchUniverse.length > 30) {
        throw new Error(`SEARCH_MODE=exhaustive unsupported for universe size ${searchUniverse.length}; use <= 30`);
    }
    const totalMasks = Math.pow(2, searchUniverse.length);
    const rows = [];
    for (let mask = 1; mask < totalMasks; mask++) {
        const selectedCount = popcount(mask);
        if (!selectedCount || selectedCount > Math.min(MAX_STRATEGIES, searchUniverse.length)) continue;
        const selected = [];
        for (let i = 0; i < searchUniverse.length; i++) {
            if (mask & (1 << i)) selected.push(searchUniverse[i]);
        }
        rows.push(evaluateCombination(`mask_${mask}`, selected));
    }
    return {
        evaluatedCount: rows.length,
        rows: dedupeRows(rows).sort(compareRows)
    };
}

function searchBeam(searchUniverse) {
    const universeByKey = new Map(searchUniverse.map((candidate) => [candidate.key, candidate]));
    const evaluated = new Map();
    let labelCounter = 0;

    let frontier = searchUniverse.map((candidate) => {
        const row = evaluateCombination(`beam_${++labelCounter}`, [candidate]);
        evaluated.set(row.signature, row);
        return row;
    });
    frontier = trimBeam(frontier, BEAM_WIDTH);

    for (let size = 2; size <= Math.min(MAX_STRATEGIES, searchUniverse.length); size++) {
        const expanded = [];
        for (const base of frontier) {
            const keySet = new Set(base.keys);
            const baseStrategies = base.keys.map((key) => universeByKey.get(key)).filter(Boolean);
            for (const candidate of searchUniverse) {
                if (keySet.has(candidate.key)) continue;
                const nextStrategies = [...baseStrategies, candidate];
                const signature = [...new Set(nextStrategies.map((strategy) => strategy.key))].sort().join('||');
                if (evaluated.has(signature)) continue;
                const row = evaluateCombination(`beam_${++labelCounter}`, nextStrategies);
                evaluated.set(signature, row);
                expanded.push(row);
            }
        }
        if (!expanded.length) break;
        frontier = trimBeam(expanded, BEAM_WIDTH);
    }

    return {
        evaluatedCount: evaluated.size,
        rows: dedupeRows([...evaluated.values()]).sort(compareRows)
    };
}

const referenceSets = [
    { label: 'exhaustive_nc_13', strategies: buildStrategyList(readJson('debug/strategy_set_15m_nc_exhaustive_13.json').strategies || []) },
    { label: 'beam_best_12', strategies: buildStrategyList(readJson('debug/strategy_set_15m_nc_beam_best_12.json').strategies || []) },
    { label: 'top8_current', strategies: buildStrategyList(readJson('debug/strategy_set_top8_current.json').strategies || []) }
];

const bestOverallNames = readJson('debug/audit_cap12_exhaustive.json').best?.names || [];
const bestOverallStrategies = bestOverallNames
    .map((name) => universe.find((candidate) => candidate.name === name))
    .filter(Boolean);
referenceSets.push({ label: 'best_overall_15_nc_false', strategies: bestOverallStrategies });
const genericCoreNames = [
    'm11 DOWN wide-momentum [45-95c]',
    'm12 DOWN late-momentum [55-95c]',
    'm5 DOWN high-conf [70-95c]'
];
const genericCoreStrategies = genericCoreNames
    .map((name) => universe.find((candidate) => candidate.name === name))
    .filter(Boolean);
referenceSets.push({ label: 'generic_core_short_horizon', strategies: genericCoreStrategies });
for (const strategy of genericCoreStrategies) {
    referenceSets.push({ label: `generic_single_${strategy.name}`, strategies: [strategy] });
}

let searchUniverse = universe;
if (UNIVERSE_MODE === 'elite') {
    const beamReport = readJson('debug/search_15m_near_certainty_beam41_w300_min0.json');
    const beamBest12Keys = new Set(referenceSets.find((entry) => entry.label === 'beam_best_12')?.strategies?.map((strategy) => strategy.key) || []);
    const eliteKeys = new Set(beamBest12Keys);
    for (const solution of (beamReport?.exhaustive?.topRobust || []).slice(0, 10)) {
        for (const name of solution.names || []) {
            const match = universe.find((candidate) => candidate.name === name);
            if (match) eliteKeys.add(match.key);
        }
    }
    searchUniverse = universe.filter((candidate) => eliteKeys.has(candidate.key));
}

if (INCLUDE_REFERENCE_SEARCH) {
    searchUniverse = mergeUniqueStrategies([
        searchUniverse,
        ...referenceSets.map((entry) => entry.strategies || [])
    ]);
}

if (RECENT_ACTIVITY_HOURS > 0 && MIN_RECENT_ACTIVITY_MATCHES > 0) {
    searchUniverse = searchUniverse.filter((candidate) => {
        const activity = recentActivityByKey.get(candidate.key);
        return Number(activity?.matches || 0) >= MIN_RECENT_ACTIVITY_MATCHES;
    });
}

const candidateNameFilter = readCandidateNameFilter();
if (candidateNameFilter.size > 0) {
    searchUniverse = searchUniverse.filter((candidate) => candidateNameFilter.has(candidate.name));
}

const effectiveSearchMode = SEARCH_MODE === 'auto'
    ? (searchUniverse.length <= EXHAUSTIVE_MAX_UNIVERSE ? 'exhaustive' : 'beam')
    : SEARCH_MODE;

console.error(`Searching ${searchUniverse.length} ${UNIVERSE_MODE === 'elite' ? 'elite ' : ''}15m candidates with guarded short-horizon scoring (${effectiveSearchMode})...`);
const searchResults = effectiveSearchMode === 'exhaustive'
    ? searchExhaustive(searchUniverse)
    : searchBeam(searchUniverse);
const rankedRows = searchResults.rows;
const topRows = rankedRows.slice(0, FINALISTS);

function summarizeRow(row) {
    return {
        label: row.label,
        strategyCount: row.strategyCount,
        names: row.names,
        support: row.support,
        score: row.score,
        historicalActual: {
            finalBalance: row.historicalActual.finalBalance,
            busted: row.historicalActual.busted,
            totalTrades: row.historicalActual.totalTrades,
            maxDrawdown: row.historicalActual.maxDrawdown
        },
        recentActual: {
            finalBalance: row.recentActual.finalBalance,
            busted: row.recentActual.busted,
            totalTrades: row.recentActual.totalTrades,
            maxDrawdown: row.recentActual.maxDrawdown
        },
        windows7: row.windows7,
        windows14: row.windows14
    };
}

const referenceEvaluations = referenceSets
    .filter((entry) => Array.isArray(entry.strategies) && entry.strategies.length > 0)
    .map((entry) => evaluateCombination(entry.label, entry.strategies))
    .sort(compareRows)
    .map(summarizeRow);

const finalists = [];
for (const row of topRows) {
    const histTrades = [];
    const recentTrades = [];
    for (const strategy of row.strategies) {
        const pre = getTradePrecompute(strategy);
        histTrades.push(...pre.historicalTrades);
        recentTrades.push(...pre.recentTrades);
    }
    const dayBuckets = groupTradesByDay([...histTrades, ...recentTrades]);
    finalists.push({
        label: row.label,
        names: row.names,
        strategyCount: row.strategyCount,
        support: row.support,
        score: row.score,
        bootstrap7d: bootstrapSummary(dayBuckets, fullSequence, 7, BOOTSTRAP_BLOCK_DAYS, BOOTSTRAP_TRIALS),
        bootstrap14d: bootstrapSummary(dayBuckets, fullSequence, 14, BOOTSTRAP_BLOCK_DAYS, BOOTSTRAP_TRIALS),
        bootstrap30d: bootstrapSummary(dayBuckets, fullSequence, 30, BOOTSTRAP_BLOCK_DAYS, Math.max(400, Math.floor(BOOTSTRAP_TRIALS / 2)))
    });
}

const winner = rankedRows[0];
const winnerArtifact = {
    version: '1.0-short-horizon-guarded',
    generatedAt: new Date().toISOString(),
    timeframe: TIMEFRAME,
    startBalance: START_BALANCE,
    description: `Guarded short-horizon winner for ${TIMEFRAME}: maximize 14-day median with 7d/14d zero-bust and p25-above-start constraints under current lite runtime mechanics.`,
    methodology: {
        searchUniverse: `${universe.length} active validated candidates from debug/optimize_15m_max_median_runtime_ultrarelaxed_full.json`,
        searchMode: SEARCH_MODE,
        effectiveSearchMode,
        beamWidth: BEAM_WIDTH,
        maxStrategies: MAX_STRATEGIES,
        bustThreshold: BUST_THRESHOLD,
        windowMetrics: ['7d', '14d'],
        runtimeParity: [
            'RiskManager sizing',
            '15m bankroll gate',
            'aggregate exposure budget',
            'dynamic risk envelope',
            'tiered absolute stake caps',
            'daily stop loss',
            'cooldown after 4 losses',
            'share-based minimum order',
            'final net-edge recheck'
        ],
        historicalLimit: 'Exact historical real-order-book-required gating is not replayable because historical order-book ladders are not stored in repo data.'
    },
    score: winner.score,
    stats: {
        historicalActual: winner.historicalActual,
        recentActual: winner.recentActual,
        windows7: winner.windows7,
        windows14: winner.windows14
    },
    strategies: winner.strategies.map((strategy) => ({
        name: strategy.name,
        asset: strategy.asset,
        utcHour: strategy.utcHour,
        entryMinute: strategy.entryMinute,
        direction: strategy.direction,
        priceMin: strategy.priceMin,
        priceMax: strategy.priceMax,
        pWinEstimate: strategy.pWinEstimate,
        evWinEstimate: strategy.evWinEstimate,
        sources: strategy.sources || [],
        metrics: strategy.metrics || {}
    }))
};

const report = {
    generatedAt: new Date().toISOString(),
    runLabel: RUN_LABEL || null,
    timeframe: TIMEFRAME,
    objective: 'Maximum guarded 14-day median profit with low bust risk under current lite runtime mechanics',
    config: {
        startBalance: START_BALANCE,
        minRuntimeBankroll: MIN_RUNTIME_BANKROLL,
        bustThreshold: BUST_THRESHOLD,
        maxStrategies: MAX_STRATEGIES,
        beamWidth: BEAM_WIDTH,
        searchMode: SEARCH_MODE,
        effectiveSearchMode,
        exhaustiveMaxUniverse: EXHAUSTIVE_MAX_UNIVERSE,
        bootstrapTrials: BOOTSTRAP_TRIALS,
        bootstrapBlockDays: BOOTSTRAP_BLOCK_DAYS,
        finalists: FINALISTS,
        recentActivityHours: RECENT_ACTIVITY_HOURS,
        minRecentActivityMatches: MIN_RECENT_ACTIVITY_MATCHES
    },
    guardConfig: {
        takerFeePct: Number(CONFIG?.RISK?.takerFeePct || 0),
        slippagePct: Number(CONFIG?.RISK?.slippagePct || 0),
        minNetEdgeRoi: Number(CONFIG?.RISK?.minNetEdgeRoi || 0),
        requireRealOrderBook: !!CONFIG?.RISK?.requireRealOrderBook,
        maxTotalExposure: Number(CONFIG?.RISK?.maxTotalExposure || 0),
        maxTotalExposureMinBankroll: Number(CONFIG?.RISK?.maxTotalExposureMinBankroll || 0),
        riskEnvelopeEnabled: !!CONFIG?.RISK?.riskEnvelopeEnabled,
        riskEnvelopeMinBankroll: Number(CONFIG?.RISK?.riskEnvelopeMinBankroll || 0),
        vaultTriggerBalance: Number(CONFIG?.RISK?.vaultTriggerBalance || 0),
        stage2Threshold: Number(CONFIG?.RISK?.stage2Threshold || 0),
        maxAbsoluteStakeSmall: Number(CONFIG?.RISK?.maxAbsoluteStakeSmall || 0),
        maxAbsoluteStakeMedium: Number(CONFIG?.RISK?.maxAbsoluteStakeMedium || 0),
        maxAbsoluteStakeLarge: Number(CONFIG?.RISK?.maxAbsoluteStakeLarge || 0)
    },
    dataset: {
        historicalRows: rows.length,
        historicalTestRows: split.testRows.length,
        recentCycles: recentCycles.length,
        historicalSequenceDays: histSequence.length,
        recentSequenceDays: recentSequence.length,
        combinedSequenceDays: fullSequence.length
    },
    universe: {
        activeValidated: universe.length,
        searched: searchUniverse.length,
        mode: UNIVERSE_MODE,
        includeReferenceSearch: INCLUDE_REFERENCE_SEARCH,
        recentActivityHours: RECENT_ACTIVITY_HOURS,
        minRecentActivityMatches: MIN_RECENT_ACTIVITY_MATCHES,
        candidateNameFilterCount: candidateNameFilter.size,
        topCandidateNames: searchUniverse.slice(0, 20).map((candidate) => candidate.name)
    },
    search: {
        evaluatedCount: searchResults.evaluatedCount,
        topRanked: rankedRows.slice(0, 20).map(summarizeRow)
    },
    recentActivityTop: RECENT_ACTIVITY_HOURS > 0
        ? [...searchUniverse]
            .map((candidate) => ({
                name: candidate.name,
                key: candidate.key,
                recentActivity: recentActivityByKey.get(candidate.key) || null,
                recentMetrics: candidate.metrics?.recent || null,
                testMetrics: candidate.metrics?.test || null
            }))
            .sort((a, b) => Number(b.recentActivity?.matches || 0) - Number(a.recentActivity?.matches || 0))
            .slice(0, 20)
        : [],
    referenceSets: referenceEvaluations,
    finalists,
    winnerArtifactPath: path.relative(ROOT, STRATEGY_OUT_PATH)
};

writeJson(OUT_PATH, report);
writeJson(STRATEGY_OUT_PATH, winnerArtifact);
console.log(JSON.stringify(report, null, 2));
