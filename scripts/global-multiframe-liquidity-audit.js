#!/usr/bin/env node
// Evaluate current best-known strategy-set combinations across 15m/4h/5m
// using exact runtime-like chronology, timeframe bankroll gates, and an
// optional legacy-style liquidity cap for higher-balance realism.

const fs = require('fs');
const path = require('path');
const CONFIG = require('../lib/config');
const RiskManager = require('../lib/risk-manager');

const ROOT = path.join(__dirname, '..');
const START_BALANCE = Number(process.env.START_BALANCE || 20);
const BOOTSTRAP_TRIALS = Number(process.env.BOOTSTRAP_TRIALS || 1000);
const BOOTSTRAP_DAYS = Number(process.env.BOOTSTRAP_DAYS || 30);
const BOOTSTRAP_BLOCK_DAYS = Number(process.env.BOOTSTRAP_BLOCK_DAYS || 7);
const WINDOW_DAYS = 7;
const STEP_DAYS = 3;
const TAKER_FEE = 0.0315;
const DEFAULT_MIN_ORDER_SHARES = 5;
const MAX_ALLOWED_SPREAD_DEVIATION = 0.08;
const OUTPUT_PATH = path.join(ROOT, 'debug', 'global_multiframe_liquidity_audit_guarded.json');

const TF = {
    '15m': {
        key: '15m',
        cycleSeconds: 900,
        datasetPath: 'exhaustive_analysis/decision_dataset.json',
        recentPath: 'data/intracycle-price-data.json',
        minBankroll: 5
    },
    '4h': {
        key: '4h',
        cycleSeconds: 14400,
        datasetPath: 'exhaustive_analysis/4h/4h_decision_dataset.json',
        recentPath: 'data/intracycle-price-data-4h.json',
        minBankroll: 10
    },
    '5m': {
        key: '5m',
        cycleSeconds: 300,
        datasetPath: 'exhaustive_analysis/5m/5m_decision_dataset.json',
        recentPath: 'data/intracycle-price-data-5m.json',
        minBankroll: 50
    }
};

function readJson(relOrAbsPath) {
    const filePath = path.isAbsolute(relOrAbsPath) ? relOrAbsPath : path.join(ROOT, relOrAbsPath);
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function writeJson(relOrAbsPath, value) {
    const filePath = path.isAbsolute(relOrAbsPath) ? relOrAbsPath : path.join(ROOT, relOrAbsPath);
    fs.writeFileSync(filePath, JSON.stringify(value, null, 2));
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

function dayKeyFromEpoch(epochSec) {
    return new Date(Number(epochSec) * 1000).toISOString().slice(0, 10);
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

function normalizeStrategy(raw) {
    const candidate = raw.key ? parseCandidateKey(raw.key) : {
        asset: String(raw.asset || 'ALL').toUpperCase(),
        utcHour: Number.isFinite(Number(raw.utcHour)) ? Number(raw.utcHour) : -1,
        entryMinute: Number(raw.entryMinute),
        direction: String(raw.direction || '').toUpperCase(),
        priceMin: Number(raw.priceMin),
        priceMax: Number(raw.priceMax)
    };
    return {
        ...candidate,
        key: raw.key || candidateKey(candidate),
        name: raw.name || raw.label || 'strategy',
        pWinEstimate: Math.max(
            0.5,
            Number(
                raw?.metrics?.train?.lcb ??
                raw?.metrics?.test?.lcb ??
                raw?.winRateLCB ??
                raw?.winRate ??
                0.5
            )
        ),
        evWinEstimate: Math.max(
            0.5,
            Number(
                raw?.pWinEstimate ??
                raw?.metrics?.train?.wr ??
                raw?.metrics?.test?.wr ??
                raw?.winRate ??
                raw?.metrics?.train?.lcb ??
                0.5
            )
        )
    };
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

function splitDataset(rows) {
    const epochs = [...new Set(rows.map((row) => Number(row.cycleStartEpochSec)).filter(Number.isFinite))].sort((a, b) => a - b);
    const valEnd = Math.floor(epochs.length * 0.80);
    const testEpochs = new Set(epochs.slice(valEnd));
    return {
        epochs,
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

function buildHistoricalTrades(rows, candidate, tfKey) {
    const tf = TF[tfKey];
    const trades = [];
    for (const row of rows) {
        const hit = matchHistoricalRow(candidate, row);
        if (!hit) continue;
        const entryTs = hit.epoch + (candidate.entryMinute * 60);
        const dayKey = dayKeyFromEpoch(entryTs);
        const dayStartTs = Math.floor(Date.parse(`${dayKey}T00:00:00.000Z`) / 1000);
        trades.push({
            timeframe: tf.key,
            runtimeMinBankroll: tf.minBankroll,
            candidateKey: candidate.key,
            strategyName: candidate.name,
            asset: hit.asset,
            dayKey,
            cycleEpoch: hit.epoch,
            cycleKey: `${tf.key}_${hit.epoch}`,
            entryOffsetSec: entryTs - dayStartTs,
            exitOffsetSec: (hit.epoch + tf.cycleSeconds) - dayStartTs,
            entryPrice: hit.entryPrice,
            pWinEstimate: candidate.pWinEstimate,
            evWinEstimate: candidate.evWinEstimate || candidate.pWinEstimate,
            won: hit.won,
            minOrderShares: DEFAULT_MIN_ORDER_SHARES
        });
    }
    return trades;
}

function buildRecentTrades(cycles, candidate, tfKey) {
    const tf = TF[tfKey];
    const trades = [];
    for (const cycle of cycles) {
        const hit = recentCycleMatch(candidate, cycle);
        if (!hit) continue;
        const entryTs = hit.epoch + (candidate.entryMinute * 60);
        const dayKey = dayKeyFromEpoch(entryTs);
        const dayStartTs = Math.floor(Date.parse(`${dayKey}T00:00:00.000Z`) / 1000);
        trades.push({
            timeframe: tf.key,
            runtimeMinBankroll: tf.minBankroll,
            candidateKey: candidate.key,
            strategyName: candidate.name,
            asset: String(cycle.asset || '').toUpperCase(),
            dayKey,
            cycleEpoch: hit.epoch,
            cycleKey: `${tf.key}_${hit.epoch}`,
            entryOffsetSec: entryTs - dayStartTs,
            exitOffsetSec: (hit.epoch + tf.cycleSeconds) - dayStartTs,
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
    return [...map.entries()].map(([dayKey, dayTrades]) => ({
        dayKey,
        trades: dayTrades.sort((a, b) =>
            a.entryOffsetSec !== b.entryOffsetSec
                ? a.entryOffsetSec - b.entryOffsetSec
                : b.pWinEstimate !== a.pWinEstimate
                    ? b.pWinEstimate - a.pWinEstimate
                    : a.entryPrice - b.entryPrice
        )
    })).sort((a, b) => a.dayKey.localeCompare(b.dayKey));
}

function getLiquidityCap(bankroll) {
    const b = Number(bankroll);
    if (!Number.isFinite(b) || b <= 0) return 100;
    if (b < 1000) return 100;
    if (b < 10000) return 200;
    return 500;
}

function getMaxPerCycle(bankroll) {
    return bankroll < 10 ? 1 : 2;
}

function runSimulationSequence(dayBuckets, startBalance, sequenceKeys, options = {}) {
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
    const applyLiquidityCap = options.applyLiquidityCap === true;

    function settlePosition(position) {
        if (position.won) {
            const grossPayout = position.shares;
            const grossProfit = grossPayout - position.cost;
            const fee = Math.max(0, grossProfit) * TAKER_FEE;
            const netPayout = grossPayout - fee;
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
        if (state.bankroll < 2) break;
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
            if (state.bankroll < 2) break;
            if (state.bankroll < Number(trade.runtimeMinBankroll || 0)) continue;
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

            rm.bankroll = state.bankroll;
            rm.peakBalance = state.peakBalance;
            const openExposureUsd = state.openPositions.reduce((sum, position) => sum + Number(position.cost || 0), 0);
            const sizing = rm.calculateSize(
                {
                    entryPrice: trade.entryPrice,
                    pWinEstimate: trade.pWinEstimate,
                    minOrderShares: trade.minOrderShares || DEFAULT_MIN_ORDER_SHARES,
                    timeframe: trade.timeframe,
                    epoch: trade.cycleEpoch
                },
                { availableCash: state.bankroll, openExposureUsd, bankrollEstimate: state.bankroll + openExposureUsd }
            );
            if (sizing.blocked || sizing.size <= 0) continue;

            let size = sizing.size;
            if (applyLiquidityCap) {
                size = Math.min(size, getLiquidityCap(state.bankroll));
            }
            const shares = Math.floor(size / trade.entryPrice + 1e-9);
            if (shares < (trade.minOrderShares || DEFAULT_MIN_ORDER_SHARES)) continue;
            const cost = shares * trade.entryPrice;
            if (cost > state.bankroll) continue;
            state.bankroll -= cost;
            cycleCounts[trade.cycleKey] = cycleCount + 1;
            state.openPositions.push({ exitTs: trade.exitTs, cost, shares, won: trade.won });
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
        busted: state.bankroll < 2,
        totalTrades: state.totalTrades,
        winRate: state.totalTrades > 0 ? round(state.totalWins / state.totalTrades) : 0,
        maxDrawdown: round(maxDrawdown),
        path: dailyPath
    };
}

function slidingWindowSummary(dayBuckets, fullSequence, startBalance, options = {}) {
    if (!fullSequence.length) return null;
    const actualWindowDays = Math.min(WINDOW_DAYS, fullSequence.length);
    const windows = [];
    for (let i = 0; i + actualWindowDays <= fullSequence.length; i += STEP_DAYS) {
        const seq = fullSequence.slice(i, i + actualWindowDays);
        const result = runSimulationSequence(dayBuckets, startBalance, seq, options);
        windows.push({
            start: seq[0],
            end: seq[seq.length - 1],
            finalBalance: result.finalBalance,
            busted: result.busted
        });
    }
    const finals = windows.map((w) => w.finalBalance).sort((a, b) => a - b);
    const bustCount = windows.filter((w) => w.busted).length;
    return {
        windowCount: windows.length,
        bustRate: round(bustCount / Math.max(1, windows.length)),
        finalBalance: {
            min: round(finals[0]),
            p25: round(percentile(finals, 0.25)),
            median: round(percentile(finals, 0.5)),
            max: round(finals[finals.length - 1])
        }
    };
}

function bootstrapSequence(fullSequence, targetDays, blockDays) {
    const out = [];
    while (out.length < targetDays) {
        const start = Math.floor(Math.random() * fullSequence.length);
        for (let i = 0; i < blockDays && out.length < targetDays; i++) {
            out.push(fullSequence[(start + i) % fullSequence.length]);
        }
    }
    return out;
}

function bootstrapSummary(dayBuckets, fullSequence, options = {}) {
    if (!fullSequence.length) return null;
    const finals = [];
    let busts = 0;
    let totalTrades = 0;
    let totalWr = 0;
    for (let i = 0; i < BOOTSTRAP_TRIALS; i++) {
        const seq = bootstrapSequence(fullSequence, BOOTSTRAP_DAYS, BOOTSTRAP_BLOCK_DAYS);
        const result = runSimulationSequence(dayBuckets, START_BALANCE, seq, options);
        finals.push(result.finalBalance);
        if (result.busted) busts++;
        totalTrades += result.totalTrades;
        totalWr += result.winRate;
    }
    finals.sort((a, b) => a - b);
    return {
        trials: BOOTSTRAP_TRIALS,
        simDays: BOOTSTRAP_DAYS,
        blockDays: BOOTSTRAP_BLOCK_DAYS,
        bustRate: round(busts / BOOTSTRAP_TRIALS),
        avgTrades: round(totalTrades / BOOTSTRAP_TRIALS, 1),
        avgWinRate: round(totalWr / BOOTSTRAP_TRIALS),
        finalBalance: {
            p10: round(percentile(finals, 0.10), 2),
            p25: round(percentile(finals, 0.25), 2),
            median: round(percentile(finals, 0.50), 2),
            p75: round(percentile(finals, 0.75), 2),
            p90: round(percentile(finals, 0.90), 2),
            max: round(finals[finals.length - 1], 2)
        }
    };
}

function evaluateScenario(scenario, modules, options = {}) {
    const selected = scenario.moduleIds.map((id) => modules[id]).filter(Boolean);
    const histTrades = [];
    const recentTrades = [];
    for (const module of selected) {
        histTrades.push(...module.historicalTrades);
        recentTrades.push(...module.recentTrades);
    }
    const histBuckets = groupTradesByDay(histTrades);
    const recentBuckets = groupTradesByDay(recentTrades);
    const histStarts = selected.map((module) => module.histStartDay).filter(Boolean).sort();
    const histEnds = selected.map((module) => module.histEndDay).filter(Boolean).sort();
    const recentStarts = selected.map((module) => module.recentStartDay).filter(Boolean).sort();
    const recentEnds = selected.map((module) => module.recentEndDay).filter(Boolean).sort();
    const histSeq = (histStarts.length && histEnds.length) ? enumerateDayRange(histStarts[0], histEnds[histEnds.length - 1]) : [];
    const recentSeq = (recentStarts.length && recentEnds.length) ? enumerateDayRange(recentStarts[0], recentEnds[recentEnds.length - 1]) : [];
    const histActual = histSeq.length ? runSimulationSequence(histBuckets, START_BALANCE, histSeq, options) : null;
    const recentActual = recentSeq.length ? runSimulationSequence(recentBuckets, START_BALANCE, recentSeq, options) : null;
    const histWindows = histSeq.length ? slidingWindowSummary(histBuckets, histSeq, START_BALANCE, options) : null;
    const recentWindows = recentSeq.length ? slidingWindowSummary(recentBuckets, recentSeq, START_BALANCE, options) : null;
    const robustFloor = round(Math.min(
        histActual ? histActual.finalBalance : Infinity,
        recentActual ? recentActual.finalBalance : Infinity,
        histWindows ? histWindows.finalBalance.p25 : Infinity,
        recentWindows ? recentWindows.finalBalance.p25 : Infinity
    ));
    const noBust =
        (!!histActual && !histActual.busted) &&
        (!!recentActual && !recentActual.busted) &&
        (!!histWindows && histWindows.bustRate === 0) &&
        (!!recentWindows && recentWindows.bustRate === 0);
    const allAbove =
        (!!histActual && histActual.finalBalance >= START_BALANCE) &&
        (!!recentActual && recentActual.finalBalance >= START_BALANCE) &&
        (!!histWindows && histWindows.finalBalance.min >= START_BALANCE) &&
        (!!recentWindows && recentWindows.finalBalance.min >= START_BALANCE);
    return {
        scenario: scenario.name,
        moduleIds: scenario.moduleIds,
        moduleLabels: selected.map((module) => module.label),
        strategyCount: selected.reduce((sum, module) => sum + module.strategyCount, 0),
        histActiveDays: histBuckets.length,
        recentActiveDays: recentBuckets.length,
        histTrades: histActual ? histActual.totalTrades : 0,
        recentTrades: recentActual ? recentActual.totalTrades : 0,
        histFinal: histActual ? histActual.finalBalance : 0,
        recentFinal: recentActual ? recentActual.finalBalance : 0,
        histWindowP25: histWindows ? histWindows.finalBalance.p25 : 0,
        recentWindowP25: recentWindows ? recentWindows.finalBalance.p25 : 0,
        histWindowMin: histWindows ? histWindows.finalBalance.min : 0,
        recentWindowMin: recentWindows ? recentWindows.finalBalance.min : 0,
        nearCertainty: noBust && allAbove && histBuckets.length >= 10 && recentBuckets.length >= 7,
        noBust,
        allAbove,
        robustFloor,
        histMaxDD: histActual ? histActual.maxDrawdown : 0,
        recentMaxDD: recentActual ? recentActual.maxDrawdown : 0
    };
}

function buildModuleFromArtifact(moduleId, label, tfKey, artifactPath) {
    if (!fs.existsSync(path.join(ROOT, artifactPath))) return null;
    const raw = readJson(artifactPath);
    const strategies = (raw.strategies || []).map(normalizeStrategy);
    if (!strategies.length) return null;
    const tf = TF[tfKey];
    const dataset = readJson(tf.datasetPath);
    const rows = Array.isArray(dataset) ? dataset : (dataset.rows || []);
    const split = splitDataset(rows);
    const sortedTestRows = [...split.testRows].sort((a, b) => Number(a.cycleStartEpochSec) - Number(b.cycleStartEpochSec));
    const recentCycles = (readJson(tf.recentPath).cycles || [])
        .filter((cycle) => Number(cycle.epoch) > split.historicalEndEpoch)
        .sort((a, b) => Number(a.epoch) - Number(b.epoch));
    const historicalTrades = [];
    const recentTrades = [];
    for (const strategy of strategies) {
        historicalTrades.push(...buildHistoricalTrades(sortedTestRows, strategy, tfKey));
        recentTrades.push(...buildRecentTrades(recentCycles, strategy, tfKey));
    }
    return {
        id: moduleId,
        label,
        tfKey,
        strategyCount: strategies.length,
        strategies,
        historicalTrades,
        recentTrades,
        histStartDay: sortedTestRows.length ? dayKeyFromEpoch(Number(sortedTestRows[0].cycleStartEpochSec)) : null,
        histEndDay: sortedTestRows.length ? dayKeyFromEpoch(Number(sortedTestRows[sortedTestRows.length - 1].cycleStartEpochSec)) : null,
        recentStartDay: recentCycles.length ? dayKeyFromEpoch(Number(recentCycles[0].epoch)) : null,
        recentEndDay: recentCycles.length ? dayKeyFromEpoch(Number(recentCycles[recentCycles.length - 1].epoch)) : null
    };
}

function buildModuleFromNames(moduleId, label, tfKey, names, universePath) {
    const universe = (readJson(universePath).topCandidates || []).map(normalizeStrategy);
    const strategies = names.map((name) => universe.find((candidate) => candidate.name === name)).filter(Boolean);
    if (!strategies.length) return null;
    const tf = TF[tfKey];
    const dataset = readJson(tf.datasetPath);
    const rows = Array.isArray(dataset) ? dataset : (dataset.rows || []);
    const split = splitDataset(rows);
    const sortedTestRows = [...split.testRows].sort((a, b) => Number(a.cycleStartEpochSec) - Number(b.cycleStartEpochSec));
    const recentCycles = (readJson(tf.recentPath).cycles || [])
        .filter((cycle) => Number(cycle.epoch) > split.historicalEndEpoch)
        .sort((a, b) => Number(a.epoch) - Number(b.epoch));
    const historicalTrades = [];
    const recentTrades = [];
    for (const strategy of strategies) {
        historicalTrades.push(...buildHistoricalTrades(sortedTestRows, strategy, tfKey));
        recentTrades.push(...buildRecentTrades(recentCycles, strategy, tfKey));
    }
    return {
        id: moduleId,
        label,
        tfKey,
        strategyCount: strategies.length,
        strategies,
        historicalTrades,
        recentTrades,
        histStartDay: sortedTestRows.length ? dayKeyFromEpoch(Number(sortedTestRows[0].cycleStartEpochSec)) : null,
        histEndDay: sortedTestRows.length ? dayKeyFromEpoch(Number(sortedTestRows[sortedTestRows.length - 1].cycleStartEpochSec)) : null,
        recentStartDay: recentCycles.length ? dayKeyFromEpoch(Number(recentCycles[0].epoch)) : null,
        recentEndDay: recentCycles.length ? dayKeyFromEpoch(Number(recentCycles[recentCycles.length - 1].epoch)) : null
    };
}

console.error('Loading multiframe modules...');
const modules = {};
modules['15m_ex13'] = buildModuleFromArtifact('15m_ex13', '15m exhaustive_nc_13', '15m', 'debug/strategy_set_15m_nc_exhaustive_13.json');
modules['15m_beam'] = buildModuleFromArtifact('15m_beam', '15m beam_best_12', '15m', 'debug/strategy_set_15m_nc_beam_best_12.json');
const bestOverallNames = (readJson('debug/audit_cap12_exhaustive.json').best?.names || []);
modules['15m_best_overall'] = buildModuleFromNames('15m_best_overall', '15m best overall (nc=false)', '15m', bestOverallNames, 'debug/optimize_15m_max_median_runtime_ultrarelaxed_full.json');
modules['4h_maxprofit'] = buildModuleFromArtifact('4h_maxprofit', '4h maxprofit', '4h', 'debug/strategy_set_4h_maxprofit.json');
modules['4h_curated'] = buildModuleFromArtifact('4h_curated', '4h curated', '4h', 'debug/strategy_set_4h_curated.json');
modules['4h_base'] = buildModuleFromArtifact('4h_base', '4h base', '4h', 'debug/strategy_set_4h.json');
modules['5m_maxprofit'] = buildModuleFromArtifact('5m_maxprofit', '5m maxprofit', '5m', 'debug/strategy_set_5m_maxprofit.json');
modules['5m_top4'] = buildModuleFromArtifact('5m_top4', '5m walkforward top4', '5m', 'debug/strategy_set_5m_walkforward_top4.json');

for (const [id, module] of Object.entries(modules)) {
    if (!module) delete modules[id];
}

const options15m = ['none', '15m_ex13', '15m_beam', '15m_best_overall'].filter((id) => id === 'none' || modules[id]);
const options4h = ['none', '4h_maxprofit', '4h_curated', '4h_base'].filter((id) => id === 'none' || modules[id]);
const options5m = ['none', '5m_maxprofit', '5m_top4'].filter((id) => id === 'none' || modules[id]);

const scenarios = [];
for (const a of options15m) {
    for (const b of options4h) {
        for (const c of options5m) {
            const moduleIds = [a, b, c].filter((id) => id !== 'none');
            if (!moduleIds.length) continue;
            scenarios.push({
                name: moduleIds.join(' + '),
                moduleIds
            });
        }
    }
}

console.error(`Modules loaded: ${Object.keys(modules).join(', ')}`);
console.error(`Scenarios: ${scenarios.length}`);

const uncapped = [];
const capped = [];
for (const scenario of scenarios) {
    console.error(`Evaluating ${scenario.name}...`);
    uncapped.push(evaluateScenario(scenario, modules, { applyLiquidityCap: false }));
    capped.push(evaluateScenario(scenario, modules, { applyLiquidityCap: true }));
}
uncapped.sort((a, b) => b.robustFloor - a.robustFloor);
capped.sort((a, b) => b.robustFloor - a.robustFloor);

const cappedTopForBootstrap = capped.slice(0, 5);
const bootstrap = {};
for (const row of cappedTopForBootstrap) {
    const selected = row.moduleIds.map((id) => modules[id]).filter(Boolean);
    const allTrades = [];
    for (const module of selected) {
        allTrades.push(...module.historicalTrades, ...module.recentTrades);
    }
    const dayBuckets = groupTradesByDay(allTrades);
    const seq = dayBuckets.map((bucket) => bucket.dayKey).sort();
    console.error(`Bootstrap ${row.scenario}...`);
    bootstrap[row.scenario] = bootstrapSummary(dayBuckets, seq, { applyLiquidityCap: true });
}

const out = {
    generatedAt: new Date().toISOString(),
    startBalance: START_BALANCE,
    methodology: {
        historicalSplit: '60/20/20 per timeframe, using held-out test only',
        recentHoldout: 'intracycle recent cycles after each timeframe historical end',
        runtimeParity: [
            'RiskManager sizing',
            'daily stop loss',
            'cooldown after 4 losses',
            'share-based minimum order',
            'timeframe bankroll gates'
        ],
        liquidityCapMode: 'legacy-style absolute cap: $100 under $1k, $200 under $10k, $500 above'
    },
    guardReplay: {
        absoluteStakeCap: true,
        aggregateExposureBudget: true,
        dynamicRiskEnvelope: true,
        finalNetEdgeRecheck: true,
        requireRealOrderBook: false,
        note: 'Historical replay cannot exactly re-run the real-order-book-required guard because historical order-book ladders are not stored in repo datasets.'
    },
    modules: Object.fromEntries(Object.entries(modules).map(([id, module]) => [id, {
        label: module.label,
        tfKey: module.tfKey,
        strategyCount: module.strategyCount,
        historicalTrades: module.historicalTrades.length,
        recentTrades: module.recentTrades.length
    }])),
    uncappedTop: uncapped.slice(0, 15),
    cappedTop: capped.slice(0, 15),
    bootstrapTopCapped: bootstrap
};

writeJson(OUTPUT_PATH, out);
console.log(JSON.stringify(out, null, 2));
