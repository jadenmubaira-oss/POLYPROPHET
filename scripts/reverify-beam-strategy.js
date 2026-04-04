#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const CONFIG = require('../lib/config');
const RiskManager = require('../lib/risk-manager');

const ROOT = path.join(__dirname, '..');
const START_BALANCE = 20;
const MIN_RUNTIME_BANKROLL = 2;
const BUST_THRESHOLD = 2;
const CYCLE_SECONDS = 900;
const TAKER_FEE = 0.0315;
const MAX_ALLOWED_SPREAD_DEVIATION = 0.08;
const DEFAULT_MIN_ORDER_SHARES = Math.max(1, Number(CONFIG?.RISK?.minOrderShares || 1));
const OUTPUT_PATH = path.join(ROOT, 'debug', 'reverify_beam_2739_report.json');

Object.assign(CONFIG.RISK, {
    maxTotalExposure: 0,
    riskEnvelopeEnabled: false,
    maxAbsoluteStakeSmall: 100000,
    maxAbsoluteStakeMedium: 100000,
    maxAbsoluteStakeLarge: 100000,
    minNetEdgeRoi: 0,
    cooldownSeconds: 600,
    maxConsecutiveLosses: 4,
    minBalanceFloor: 2
});

function readJson(relPath) {
    return JSON.parse(fs.readFileSync(path.join(ROOT, relPath), 'utf8'));
}

function writeJson(filePath, value) {
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
    const lo = Math.floor(idx);
    const hi = Math.ceil(idx);
    if (lo === hi) return sortedValues[lo];
    const weight = idx - lo;
    return (sortedValues[lo] * (1 - weight)) + (sortedValues[hi] * weight);
}

function dayKeyFromEpoch(epochSec) {
    return new Date(Number(epochSec) * 1000).toISOString().slice(0, 10);
}

function addDays(dayKey, days) {
    const d = new Date(`${dayKey}T00:00:00.000Z`);
    d.setUTCDate(d.getUTCDate() + days);
    return d.toISOString().slice(0, 10);
}

function enumerateDays(startDay, endDay) {
    if (!startDay || !endDay || startDay > endDay) return [];
    const out = [];
    let cur = startDay;
    while (cur <= endDay) {
        out.push(cur);
        cur = addDays(cur, 1);
    }
    return out;
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

function computeDrawdown(balancePath, initialBalance = START_BALANCE) {
    let peak = initialBalance;
    let maxDD = 0;
    for (const point of balancePath) {
        const balance = Number(point.balance);
        if (balance > peak) peak = balance;
        if (peak > 0) {
            const dd = (peak - balance) / peak;
            if (dd > maxDD) maxDD = dd;
        }
    }
    return round(maxDD);
}

function summarizeTrades(executedTrades, startBalance, windowSeconds, extra = {}) {
    const wins = executedTrades.filter((t) => t.won).length;
    const losses = executedTrades.filter((t) => !t.won).length;
    const pnl = executedTrades.reduce((sum, trade) => sum + Number(trade.pnl || 0), 0);
    const balances = [{ balance: startBalance }];
    let balance = startBalance;
    for (const trade of executedTrades) {
        balance += Number(trade.pnl || 0);
        balances.push({ balance });
    }
    return {
        startBalance: round(startBalance, 2),
        endBalance: round(startBalance + pnl, 2),
        pnl: round(pnl, 2),
        trades: executedTrades.length,
        wins,
        losses,
        winRate: executedTrades.length > 0 ? round(wins / executedTrades.length, 4) : 0,
        tradesPerDay: windowSeconds > 0 ? round(executedTrades.length / (windowSeconds / 86400), 2) : 0,
        maxDrawdown: computeDrawdown(balances, startBalance),
        ...extra
    };
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

function normalizeStrategies(rawStrategies) {
    return rawStrategies.map((strategy, index) => {
        const strategyPWin = Number(strategy.pWinEstimate || strategy.winRateLCB || strategy.winRate || 0.5);
        const evWinEstimate = Number(strategy.evWinEstimate || strategy.pWinEstimate || strategy.winRate || 0.5);
        return {
            id: index + 1,
            name: String(strategy.name || `beam_${index + 1}`),
            asset: String(strategy.asset || 'ALL').toUpperCase(),
            utcHour: Number.isFinite(Number(strategy.utcHour)) ? Number(strategy.utcHour) : -1,
            entryMinute: Number(strategy.entryMinute),
            direction: String(strategy.direction || '').toUpperCase(),
            priceMin: Number(strategy.priceMin),
            priceMax: Number(strategy.priceMax),
            strategyPWin: Number.isFinite(strategyPWin) ? strategyPWin : 0.5,
            evWinEstimate: Number.isFinite(evWinEstimate) ? evWinEstimate : 0.5,
            sizePWinEstimate: 0.5
        };
    });
}

function matchHistoricalRow(strategy, row) {
    const epoch = Number(row.cycleStartEpochSec);
    if (!Number.isFinite(epoch)) return null;
    if (strategy.asset !== 'ALL' && String(row.asset || '').toUpperCase() !== strategy.asset) return null;
    if (strategy.utcHour !== -1 && Number(row.utcHour) !== strategy.utcHour) return null;
    if (Number(row.entryMinute) !== strategy.entryMinute) return null;
    const upPrice = Number(row.upPrice);
    const downPrice = Number(row.downPrice);
    if (!(upPrice > 0) || upPrice >= 1 || !(downPrice > 0) || downPrice >= 1) return null;
    if (Math.abs((upPrice + downPrice) - 1) > MAX_ALLOWED_SPREAD_DEVIATION) return null;
    const entryPrice = strategy.direction === 'UP' ? upPrice : downPrice;
    if (entryPrice < strategy.priceMin || entryPrice > strategy.priceMax) return null;
    return {
        source: 'historical_test',
        epoch,
        entryPrice,
        minOrderShares: DEFAULT_MIN_ORDER_SHARES,
        won: String(row.resolvedOutcome || '').toUpperCase() === strategy.direction,
        asset: String(row.asset || '').toUpperCase()
    };
}

function matchRecentCycle(strategy, cycle) {
    const epoch = Number(cycle.epoch);
    if (!Number.isFinite(epoch)) return null;
    if (strategy.asset !== 'ALL' && String(cycle.asset || '').toUpperCase() !== strategy.asset) return null;
    if (strategy.utcHour !== -1 && new Date(epoch * 1000).getUTCHours() !== strategy.utcHour) return null;
    const priceMap = strategy.direction === 'UP' ? cycle.minutePricesYes : cycle.minutePricesNo;
    const priceData = priceMap?.[strategy.entryMinute];
    if (!priceData) return null;
    const entryPrice = Number(priceData.last);
    if (!Number.isFinite(entryPrice)) return null;
    if (entryPrice < strategy.priceMin || entryPrice > strategy.priceMax) return null;
    const oppositeMap = strategy.direction === 'UP' ? cycle.minutePricesNo : cycle.minutePricesYes;
    const oppositePrice = Number(oppositeMap?.[strategy.entryMinute]?.last);
    if (Number.isFinite(oppositePrice) && Math.abs((entryPrice + oppositePrice) - 1) > MAX_ALLOWED_SPREAD_DEVIATION) return null;
    const minOrderRaw = strategy.direction === 'UP'
        ? (cycle.yesMinOrderSize ?? cycle.orderMinSize)
        : (cycle.noMinOrderSize ?? cycle.orderMinSize);
    const minOrderShares = Number.isFinite(Number(minOrderRaw)) && Number(minOrderRaw) > 0
        ? Math.max(DEFAULT_MIN_ORDER_SHARES, Math.ceil(Number(minOrderRaw)))
        : DEFAULT_MIN_ORDER_SHARES;
    return {
        source: 'recent_holdout',
        epoch,
        entryPrice,
        minOrderShares,
        won: String(cycle.resolution || '').toUpperCase() === strategy.direction,
        asset: String(cycle.asset || '').toUpperCase()
    };
}

function buildOpportunityBook(strategies, historicalRows, recentCycles) {
    const opportunities = [];
    for (const strategy of strategies) {
        for (const row of historicalRows) {
            const match = matchHistoricalRow(strategy, row);
            if (!match) continue;
            opportunities.push({
                strategyName: strategy.name,
                asset: match.asset || strategy.asset,
                direction: strategy.direction,
                timeframe: '15m',
                source: match.source,
                cycleEpoch: match.epoch,
                entryTs: match.epoch + (strategy.entryMinute * 60),
                exitTs: match.epoch + CYCLE_SECONDS,
                entryPrice: match.entryPrice,
                minOrderShares: match.minOrderShares,
                strategyPWin: strategy.strategyPWin,
                sizePWinEstimate: strategy.sizePWinEstimate,
                evWinEstimate: strategy.evWinEstimate,
                won: match.won
            });
        }
        for (const cycle of recentCycles) {
            const match = matchRecentCycle(strategy, cycle);
            if (!match) continue;
            opportunities.push({
                strategyName: strategy.name,
                asset: match.asset || strategy.asset,
                direction: strategy.direction,
                timeframe: '15m',
                source: match.source,
                cycleEpoch: match.epoch,
                entryTs: match.epoch + (strategy.entryMinute * 60),
                exitTs: match.epoch + CYCLE_SECONDS,
                entryPrice: match.entryPrice,
                minOrderShares: match.minOrderShares,
                strategyPWin: strategy.strategyPWin,
                sizePWinEstimate: strategy.sizePWinEstimate,
                evWinEstimate: strategy.evWinEstimate,
                won: match.won
            });
        }
    }
    return opportunities.sort((a, b) =>
        a.entryTs - b.entryTs ||
        b.strategyPWin - a.strategyPWin ||
        b.evWinEstimate - a.evWinEstimate ||
        a.strategyName.localeCompare(b.strategyName)
    );
}

function runReplay(opportunities, { startBalance = START_BALANCE, startTs = -Infinity, endTs = Infinity } = {}) {
    const filtered = opportunities.filter((opportunity) => opportunity.entryTs >= startTs && opportunity.entryTs < endTs);
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
        openPositions: [],
        cycleCounts: {}
    };
    const executedTrades = [];
    const dailyBalances = [];
    let currentDay = filtered.length > 0 ? dayKeyFromEpoch(filtered[0].entryTs) : null;

    function settle(position) {
        const grossPayout = position.won ? position.shares : 0;
        if (position.won) {
            const fee = Math.max(0, grossPayout - position.cost) * TAKER_FEE;
            const netPayout = grossPayout - fee;
            const pnl = netPayout - position.cost;
            state.bankroll += netPayout;
            state.todayPnL += pnl;
            state.totalWins++;
            state.consecutiveLosses = 0;
            if (state.bankroll > state.peakBalance) state.peakBalance = state.bankroll;
            executedTrades.push({
                ...position.meta,
                shares: position.shares,
                size: round(position.cost, 2),
                payout: round(netPayout, 2),
                pnl: round(pnl, 2),
                won: true,
                balanceAfter: round(state.bankroll, 2)
            });
        } else {
            state.todayPnL -= position.cost;
            state.consecutiveLosses++;
            if (state.consecutiveLosses >= 4) {
                state.cooldownUntilSec = position.exitTs + Number(CONFIG.RISK.cooldownSeconds || 600);
                state.consecutiveLosses = 0;
            }
            executedTrades.push({
                ...position.meta,
                shares: position.shares,
                size: round(position.cost, 2),
                payout: 0,
                pnl: round(-position.cost, 2),
                won: false,
                balanceAfter: round(state.bankroll, 2)
            });
        }
        state.totalTrades++;
    }

    function settleUpTo(ts) {
        state.openPositions.sort((a, b) => a.exitTs - b.exitTs);
        while (state.openPositions.length > 0 && state.openPositions[0].exitTs <= ts) {
            settle(state.openPositions.shift());
        }
    }

    function closeDay(dayKey) {
        if (!dayKey) return;
        const dayEndTs = Math.floor(Date.parse(`${dayKey}T23:59:59.000Z`) / 1000) + 1;
        settleUpTo(dayEndTs);
        dailyBalances.push({ day: dayKey, balance: round(state.bankroll, 2) });
    }

    for (const opportunity of filtered) {
        settleUpTo(opportunity.entryTs);
        const entryDay = dayKeyFromEpoch(opportunity.entryTs);
        if (currentDay !== entryDay) {
            closeDay(currentDay);
            currentDay = entryDay;
            state.dayStartBalance = state.bankroll;
            state.todayPnL = 0;
        }

        if (state.bankroll < MIN_RUNTIME_BANKROLL && state.openPositions.length === 0) break;
        if (state.bankroll < MIN_RUNTIME_BANKROLL) continue;
        if (opportunity.entryTs < state.cooldownUntilSec) continue;
        if (state.todayPnL < -(state.dayStartBalance * Number(CONFIG.RISK.globalStopLoss || 0.20))) continue;

        const cycleKey = `15m_${opportunity.cycleEpoch}`;
        const cycleCount = state.cycleCounts[cycleKey] || 0;
        const maxPerCycle = state.bankroll < 10 ? 1 : 2;
        if (cycleCount >= maxPerCycle) continue;

        const netEdge = estimateNetEdgeRoi(opportunity.entryPrice, opportunity.evWinEstimate);
        if (!Number.isFinite(netEdge) || netEdge < Number(CONFIG.RISK.minNetEdgeRoi || 0)) continue;

        const openExposureUsd = state.openPositions.reduce((sum, position) => sum + Number(position.cost || 0), 0);
        rm.bankroll = state.bankroll;
        rm.peakBalance = state.peakBalance;
        rm.dayStartBalance = state.dayStartBalance;
        const sizing = rm.calculateSize({
            entryPrice: opportunity.entryPrice,
            pWinEstimate: opportunity.sizePWinEstimate,
            minOrderShares: opportunity.minOrderShares,
            timeframe: '15m',
            epoch: opportunity.cycleEpoch
        }, {
            availableCash: state.bankroll,
            openExposureUsd,
            bankrollEstimate: state.bankroll + openExposureUsd,
            dayStartBalanceEstimate: state.dayStartBalance
        });
        if (sizing.blocked || !(sizing.size > 0)) continue;

        const shares = Math.floor(sizing.size / opportunity.entryPrice + 1e-9);
        if (shares < opportunity.minOrderShares) continue;
        const cost = shares * opportunity.entryPrice;
        if (!(cost > 0) || cost > state.bankroll) continue;

        state.bankroll -= cost;
        state.cycleCounts[cycleKey] = cycleCount + 1;
        state.openPositions.push({
            exitTs: opportunity.exitTs,
            cost,
            shares,
            won: opportunity.won,
            meta: {
                source: opportunity.source,
                strategy: opportunity.strategyName,
                asset: opportunity.asset,
                direction: opportunity.direction,
                entryPrice: round(opportunity.entryPrice, 4),
                strategyPWin: round(opportunity.strategyPWin, 4),
                sizingPWin: round(opportunity.sizePWinEstimate, 4),
                evWinEstimate: round(opportunity.evWinEstimate, 4),
                openedAt: new Date(opportunity.entryTs * 1000).toISOString(),
                resolvedAt: new Date(opportunity.exitTs * 1000).toISOString()
            }
        });
    }

    settleUpTo(Infinity);
    if (currentDay) closeDay(currentDay);

    return {
        startBalance: round(startBalance, 2),
        endBalance: round(state.bankroll, 2),
        pnl: round(state.bankroll - startBalance, 2),
        trades: state.totalTrades,
        wins: state.totalWins,
        losses: state.totalTrades - state.totalWins,
        winRate: state.totalTrades > 0 ? round(state.totalWins / state.totalTrades, 4) : 0,
        busted: state.bankroll < BUST_THRESHOLD,
        maxDrawdown: computeDrawdown(dailyBalances, startBalance),
        dailyBalances,
        executedTrades
    };
}

function makeWindowReport(opportunities, label, endTs, durationSeconds) {
    const startTs = endTs - durationSeconds;
    const result = runReplay(opportunities, { startBalance: START_BALANCE, startTs, endTs });
    const coverageStart = new Date(startTs * 1000).toISOString();
    const coverageEnd = new Date(endTs * 1000).toISOString();
    const tradeList = result.executedTrades.map((trade) => ({
        openedAt: trade.openedAt,
        resolvedAt: trade.resolvedAt,
        asset: trade.asset,
        direction: trade.direction,
        strategy: trade.strategy,
        entryPrice: trade.entryPrice,
        size: trade.size,
        shares: trade.shares,
        result: trade.won ? 'WIN' : 'LOSS',
        pnl: trade.pnl
    }));
    return {
        label,
        coverageStart,
        coverageEnd,
        ...summarizeTrades(result.executedTrades, START_BALANCE, durationSeconds, {
            busted: result.busted
        }),
        tradeList
    };
}

function summarizeStrategies(trades) {
    const perStrategy = new Map();
    for (const trade of trades) {
        const key = trade.strategy;
        if (!perStrategy.has(key)) {
            perStrategy.set(key, {
                strategy: key,
                trades: 0,
                wins: 0,
                losses: 0,
                pnl: 0
            });
        }
        const row = perStrategy.get(key);
        row.trades++;
        if (trade.won) row.wins++;
        else row.losses++;
        row.pnl += Number(trade.pnl || 0);
    }
    return [...perStrategy.values()]
        .map((row) => ({
            strategy: row.strategy,
            trades: row.trades,
            wins: row.wins,
            losses: row.losses,
            winRate: row.trades > 0 ? round(row.wins / row.trades, 4) : 0,
            pnl: round(row.pnl, 2)
        }))
        .sort((a, b) => b.trades - a.trades || b.pnl - a.pnl);
}

function buildWeeklyBreakdown(opportunities, endTs) {
    const durationSeconds = 28 * 86400;
    const startTs = endTs - durationSeconds;
    const run28d = runReplay(opportunities, { startBalance: START_BALANCE, startTs, endTs });
    const buckets = [];
    let runningBalance = START_BALANCE;
    for (let i = 0; i < 4; i++) {
        const bucketStartTs = startTs + (i * 7 * 86400);
        const bucketEndTs = bucketStartTs + (7 * 86400);
        const trades = run28d.executedTrades.filter((trade) => {
            const resolvedTs = Date.parse(trade.resolvedAt) / 1000;
            return resolvedTs >= bucketStartTs && resolvedTs < bucketEndTs;
        });
        const bucketSummary = summarizeTrades(trades, runningBalance, 7 * 86400, {
            week: i + 1,
            coverageStart: new Date(bucketStartTs * 1000).toISOString(),
            coverageEnd: new Date(bucketEndTs * 1000).toISOString()
        });
        runningBalance = bucketSummary.endBalance;
        buckets.push(bucketSummary);
    }
    return {
        coverageStart: new Date(startTs * 1000).toISOString(),
        coverageEnd: new Date(endTs * 1000).toISOString(),
        weeks: buckets
    };
}

function regimeAssessment(fullReplay, window7d, window14d, window30d) {
    const fullTradesPerDay = fullReplay.trades / 52;
    const thresholds = {
        dailyCheck: 'Run `npm run reverify:strategy` every day after funding.',
        weeklyCheck: 'Run `npm run reverify:full` weekly, after every deploy, and after every 100 resolved trades.',
        replacementSearch: [
            '7d replay from $20 ends <= $20 or 14d replay from $20 ends <= $20',
            '7d win rate < 74% with at least 30 trades',
            '14d win rate < 76% with at least 60 trades',
            '30d win rate < 78% with at least 150 trades',
            '7d trade frequency < 60% of the 30d trades/day baseline',
            '30d max drawdown > 55%'
        ],
        bestStrategyCriteria: {
            hardEligibility: [
                'shortHorizonEligible=true',
                'noBust7=true',
                'noBust14=true',
                'allAboveStart=true',
                'supportOk=true'
            ],
            rankingOrder: [
                'highest medianFloor14',
                'highest medianFloor7',
                'highest p25Floor14',
                'highest p25Floor7',
                'highest recentActual.finalBalance',
                'lowest worstMaxDrawdown'
            ]
        }
    };

    const flags = [];
    if (window7d.endBalance <= START_BALANCE || window14d.endBalance <= START_BALANCE) flags.push('PROFITABILITY_TRIGGER');
    if (window7d.trades >= 30 && window7d.winRate < 0.74) flags.push('WINRATE_7D_TRIGGER');
    if (window14d.trades >= 60 && window14d.winRate < 0.76) flags.push('WINRATE_14D_TRIGGER');
    if (window30d.trades >= 150 && window30d.winRate < 0.78) flags.push('WINRATE_30D_TRIGGER');
    if (window30d.tradesPerDay > 0 && window7d.tradesPerDay < (window30d.tradesPerDay * 0.60)) flags.push('FREQUENCY_TRIGGER');
    if (window30d.maxDrawdown > 0.55) flags.push('DRAWDOWN_TRIGGER');

    const recentWinRateGap = round(window7d.winRate - fullReplay.winRate, 4);
    const recentFrequencyGap = round(window7d.tradesPerDay - fullTradesPerDay, 2);

    return {
        status: flags.length === 0 ? 'STABLE' : (flags.length === 1 ? 'WATCH' : 'RESEARCH_REQUIRED'),
        flags,
        notes: flags.length === 0
            ? ['No credible regime-break signal in the available local archive.', 'Recent 7d/14d/30d windows remain profitable from a fresh $20 start.']
            : ['At least one trigger fired. Run the guarded search to confirm whether a replacement set now ranks above beam_2739.'],
        baseline: {
            fullReplayTradesPerDay: round(fullTradesPerDay, 2),
            fullReplayWinRate: round(fullReplay.winRate, 4)
        },
        recentDiff: {
            winRateGap7dVsFull: recentWinRateGap,
            tradesPerDayGap7dVsFull: recentFrequencyGap
        },
        thresholds
    };
}

const strategyArtifact = readJson('strategies/strategy_set_15m_beam_2739_uncapped.json');
const historicalDataset = readJson('exhaustive_analysis/decision_dataset.json');
const recentDatasetRaw = readJson('data/intracycle-price-data.json');
const recentCyclesAll = Array.isArray(recentDatasetRaw?.cycles) ? recentDatasetRaw.cycles : [];
const { testRows, historicalEndEpoch } = splitDataset(Array.isArray(historicalDataset) ? historicalDataset : (historicalDataset.rows || []));
const recentCycles = recentCyclesAll.filter((cycle) => Number(cycle.epoch) > historicalEndEpoch).sort((a, b) => Number(a.epoch) - Number(b.epoch));
const strategies = normalizeStrategies(strategyArtifact.strategies || []);
const opportunities = buildOpportunityBook(strategies, testRows, recentCycles);

if (opportunities.length === 0) {
    throw new Error('No opportunities generated for beam_2739 re-verification');
}

const firstEntryTs = opportunities[0].entryTs;
const lastExitTs = opportunities.reduce((max, opportunity) => Math.max(max, opportunity.exitTs), 0);
const fullReplay = runReplay(opportunities, { startBalance: START_BALANCE });
const window24h = makeWindowReport(opportunities, 'last24h', lastExitTs, 24 * 3600);
const window48h = makeWindowReport(opportunities, 'last48h', lastExitTs, 48 * 3600);
const window7d = makeWindowReport(opportunities, 'last7d', lastExitTs, 7 * 86400);
const window14d = makeWindowReport(opportunities, 'last14d', lastExitTs, 14 * 86400);
const window30d = makeWindowReport(opportunities, 'last30d', lastExitTs, 30 * 86400);
const weeklyBreakdown = buildWeeklyBreakdown(opportunities, lastExitTs);

const recent7dStrategies = summarizeStrategies(window7d.tradeList.map((trade) => ({
    strategy: trade.strategy,
    won: trade.result === 'WIN',
    pnl: trade.pnl
})));
const recent30dStrategies = summarizeStrategies(window30d.tradeList.map((trade) => ({
    strategy: trade.strategy,
    won: trade.result === 'WIN',
    pnl: trade.pnl
})));
const watchlistStrategies = recent7dStrategies.filter((row) => row.trades >= 5 && (row.winRate < 0.7 || row.pnl < 0));

const coverageStartDay = dayKeyFromEpoch(firstEntryTs);
const coverageEndDay = dayKeyFromEpoch(lastExitTs);
const trailing30StartDay = dayKeyFromEpoch(lastExitTs - (30 * 86400));
const trailing30Days = enumerateDays(trailing30StartDay, coverageEndDay);
const coveredRecentDays = new Set(opportunities
    .filter((opportunity) => opportunity.entryTs >= (lastExitTs - (30 * 86400)))
    .map((opportunity) => dayKeyFromEpoch(opportunity.entryTs)));
const missingTrailing30Days = trailing30Days.filter((dayKey) => !coveredRecentDays.has(dayKey));

const report = {
    generatedAt: new Date().toISOString(),
    strategyPath: 'strategies/strategy_set_15m_beam_2739_uncapped.json',
    runtimeParity: {
        sizingPWinEstimate: 0.5,
        candidateOrdering: 'strategy.pWinEstimate desc',
        cooldownAfterLosses: 4,
        cooldownSeconds: 600,
        minRuntimeBankroll: MIN_RUNTIME_BANKROLL,
        minBalanceFloor: Number(CONFIG.RISK.minBalanceFloor || 2),
        riskEnvelopeEnabled: false,
        maxTotalExposure: 0,
        slippagePct: Number(CONFIG.RISK.slippagePct || 0.01),
        takerFeePct: Number(CONFIG.RISK.takerFeePct || TAKER_FEE)
    },
    dataCoverage: {
        firstEntryIso: new Date(firstEntryTs * 1000).toISOString(),
        lastResolvedIso: new Date(lastExitTs * 1000).toISOString(),
        firstDay: coverageStartDay,
        lastDay: coverageEndDay,
        fullCoverageDays: enumerateDays(coverageStartDay, coverageEndDay).length,
        trailing30CalendarDaysCovered: coveredRecentDays.size,
        trailing30CalendarDaysMissing: missingTrailing30Days
    },
    selectionCriteria: {
        strategyGoal: strategyArtifact.description || 'Maximize 14d guarded median under current lite runtime mechanics.',
        exactWinningConditions: {
            hardEligibility: [
                'noBust7=true',
                'noBust14=true',
                'allAboveStart=true',
                'supportOk=true'
            ],
            rankOrder: [
                'medianFloor14 desc',
                'medianFloor7 desc',
                'p25Floor14 desc',
                'p25Floor7 desc',
                'recentActual.finalBalance desc',
                'worstMaxDrawdown asc'
            ]
        }
    },
    overall: {
        trades: fullReplay.trades,
        wins: fullReplay.wins,
        losses: fullReplay.losses,
        winRate: fullReplay.winRate,
        endBalance: fullReplay.endBalance,
        pnl: fullReplay.pnl,
        maxDrawdown: fullReplay.maxDrawdown,
        tradesPerDay: round(fullReplay.trades / enumerateDays(coverageStartDay, coverageEndDay).length, 2)
    },
    windows: {
        last24h: window24h,
        last48h: window48h,
        last7d: window7d,
        last14d: window14d,
        last30d: window30d
    },
    weeklyBreakdown28d: weeklyBreakdown,
    recent7dStrategyBreakdown: recent7dStrategies,
    recent30dStrategyBreakdown: recent30dStrategies,
    watchlistStrategies7d: watchlistStrategies,
    regimeAssessment: regimeAssessment(fullReplay, window7d, window14d, window30d)
};

writeJson(OUTPUT_PATH, report);

console.log(`Beam strategy re-verification saved to ${path.relative(ROOT, OUTPUT_PATH)}`);
console.log(`Coverage: ${report.dataCoverage.firstDay} -> ${report.dataCoverage.lastDay}`);
console.log(`24h: trades=${window24h.trades}, wins=${window24h.wins}, losses=${window24h.losses}, pnl=$${window24h.pnl}, end=$${window24h.endBalance}`);
console.log(`48h: trades=${window48h.trades}, wins=${window48h.wins}, losses=${window48h.losses}, pnl=$${window48h.pnl}, end=$${window48h.endBalance}`);
console.log(`7d: trades=${window7d.trades}, WR=${(window7d.winRate * 100).toFixed(1)}%, pnl=$${window7d.pnl}, end=$${window7d.endBalance}`);
console.log(`30d: trades=${window30d.trades}, WR=${(window30d.winRate * 100).toFixed(1)}%, pnl=$${window30d.pnl}, end=$${window30d.endBalance}, maxDD=${(window30d.maxDrawdown * 100).toFixed(1)}%`);
if (watchlistStrategies.length > 0) {
    console.log(`Watchlist (7d): ${watchlistStrategies.map((row) => `${row.strategy} wr=${(row.winRate * 100).toFixed(1)}% pnl=$${row.pnl}`).join(' | ')}`);
}
console.log(`Regime: ${report.regimeAssessment.status} ${report.regimeAssessment.flags.length ? `(${report.regimeAssessment.flags.join(', ')})` : ''}`);
