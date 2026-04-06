#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const CONFIG = require('../lib/config');
const RiskManager = require('../lib/risk-manager');

const ROOT = path.join(__dirname, '..');
const START_BALANCE = Math.max(2, Number(process.env.START_BALANCE || 6.44));
const HORIZONS_HOURS = String(process.env.HORIZONS_HOURS || '24,48,72')
    .split(',')
    .map((v) => Number(v.trim()))
    .filter((v) => Number.isFinite(v) && v > 0);
const STEP_HOURS = Math.max(1, Number(process.env.STEP_HOURS || 6));
const BUST_THRESHOLD = 2;
const TAKER_FEE = 0.0315;
const MAX_SPREAD_DEV = 0.08;

const TIMEFRAME_CFG = {
    '15m': {
        cycleSeconds: 900,
        datasetPath: 'exhaustive_analysis/decision_dataset.json',
        recentPath: 'data/intracycle-price-data.json'
    },
    '5m': {
        cycleSeconds: 300,
        datasetPath: 'exhaustive_analysis/5m/5m_decision_dataset.json',
        recentPath: 'data/intracycle-price-data-5m.json'
    },
    '4h': {
        cycleSeconds: 14400,
        datasetPath: 'exhaustive_analysis/4h/4h_decision_dataset.json',
        recentPath: 'data/intracycle-price-data-4h.json'
    }
};

const PROFILES = [
    { label: '15m_beam11_zero_bust', entries: [{ timeframe: '15m', file: 'strategies/strategy_set_15m_beam11_zero_bust.json' }] },
    { label: '15m_nc_beam_best_12', entries: [{ timeframe: '15m', file: 'debug/strategy_set_15m_nc_beam_best_12.json' }] },
    { label: '15m_nc_exhaustive_13', entries: [{ timeframe: '15m', file: 'debug/strategy_set_15m_nc_exhaustive_13.json' }] },
    { label: '15m_exact_b10', entries: [{ timeframe: '15m', file: 'debug/strategy_set_15m_exact_b10.json' }] },
    { label: '15m_24h_ultra_tight', entries: [{ timeframe: '15m', file: 'strategies/strategy_set_15m_24h_ultra_tight.json' }] },
    { label: '15m_24h_dense', entries: [{ timeframe: '15m', file: 'strategies/strategy_set_15m_24h_dense.json' }] },
    { label: '5m_exact_b20', entries: [{ timeframe: '5m', file: 'debug/strategy_set_5m_exact_b20.json' }] },
    { label: '5m_maxprofit', entries: [{ timeframe: '5m', file: 'debug/strategy_set_5m_maxprofit.json' }] },
    { label: '5m_walkforward_top4', entries: [{ timeframe: '5m', file: 'debug/strategy_set_5m_walkforward_top4.json' }] },
    {
        label: '15m_beam11_plus_5m_exact_b20',
        entries: [
            { timeframe: '15m', file: 'strategies/strategy_set_15m_beam11_zero_bust.json' },
            { timeframe: '5m', file: 'debug/strategy_set_5m_exact_b20.json' }
        ]
    },
    {
        label: '15m_beam11_plus_5m_maxprofit',
        entries: [
            { timeframe: '15m', file: 'strategies/strategy_set_15m_beam11_zero_bust.json' },
            { timeframe: '5m', file: 'debug/strategy_set_5m_maxprofit.json' }
        ]
    },
    {
        label: '15m_beam11_plus_5m_walkforward_top4',
        entries: [
            { timeframe: '15m', file: 'strategies/strategy_set_15m_beam11_zero_bust.json' },
            { timeframe: '5m', file: 'debug/strategy_set_5m_walkforward_top4.json' }
        ]
    },
    {
        label: '15m_ultra_tight_plus_5m_exact_b20',
        entries: [
            { timeframe: '15m', file: 'strategies/strategy_set_15m_24h_ultra_tight.json' },
            { timeframe: '5m', file: 'debug/strategy_set_5m_exact_b20.json' }
        ]
    },
    {
        label: '15m_ultra_tight_plus_5m_maxprofit',
        entries: [
            { timeframe: '15m', file: 'strategies/strategy_set_15m_24h_ultra_tight.json' },
            { timeframe: '5m', file: 'debug/strategy_set_5m_maxprofit.json' }
        ]
    },
    {
        label: '15m_ultra_tight_plus_5m_walkforward_top4',
        entries: [
            { timeframe: '15m', file: 'strategies/strategy_set_15m_24h_ultra_tight.json' },
            { timeframe: '5m', file: 'debug/strategy_set_5m_walkforward_top4.json' }
        ]
    }
];

function readJson(filePath) {
    return JSON.parse(fs.readFileSync(path.isAbsolute(filePath) ? filePath : path.join(ROOT, filePath), 'utf8'));
}

function round(value, digits = 2) {
    return Number(Number(value).toFixed(digits));
}

function percentile(sortedValues, p) {
    if (!sortedValues.length) return 0;
    const idx = (sortedValues.length - 1) * p;
    const lo = Math.floor(idx);
    const hi = Math.ceil(idx);
    if (lo === hi) return sortedValues[lo];
    return sortedValues[lo] * (1 - (idx - lo)) + sortedValues[hi] * (idx - lo);
}

function normalizeStrategies(rawStrategies) {
    return rawStrategies.map((s, idx) => ({
        id: idx + 1,
        name: String(s.name || `s_${idx + 1}`),
        asset: String(s.asset || 'ALL').toUpperCase(),
        utcHour: Number.isFinite(Number(s.utcHour)) ? Number(s.utcHour) : -1,
        entryMinute: Number(s.entryMinute),
        direction: String(s.direction || '').toUpperCase(),
        priceMin: Number(s.priceMin),
        priceMax: Number(s.priceMax),
        pWinEstimate: Number(s.pWinEstimate || s.winRateLCB || s.winRate || 0.5)
    })).filter((s) => Number.isFinite(s.entryMinute) && ['UP', 'DOWN'].includes(s.direction));
}

function loadTimeframeRows(timeframe) {
    const cfg = TIMEFRAME_CFG[timeframe];
    const historicalRaw = readJson(cfg.datasetPath);
    const historicalRows = Array.isArray(historicalRaw) ? historicalRaw : (historicalRaw.rows || []);
    const historicalEpochs = [...new Set(historicalRows.map((r) => Number(r.cycleStartEpochSec)).filter(Number.isFinite))].sort((a, b) => a - b);
    const testStart = Math.floor(historicalEpochs.length * 0.8);
    const historicalTestEpochs = new Set(historicalEpochs.slice(testStart));
    const historicalTestRows = historicalRows.filter((r) => historicalTestEpochs.has(Number(r.cycleStartEpochSec)));
    const historicalMaxEpoch = historicalEpochs[historicalEpochs.length - 1];
    const recentRaw = readJson(cfg.recentPath);
    const recentCycles = (recentRaw.cycles || recentRaw || [])
        .filter((c) => Number(c.epoch) > historicalMaxEpoch)
        .sort((a, b) => Number(a.epoch) - Number(b.epoch));
    return { cfg, historicalTestRows, recentCycles };
}

const timeframeCache = {};
function getTimeframeRows(timeframe) {
    if (!timeframeCache[timeframe]) timeframeCache[timeframe] = loadTimeframeRows(timeframe);
    return timeframeCache[timeframe];
}

function matchHistorical(strategy, row) {
    if (strategy.asset !== 'ALL' && String(row.asset || '').toUpperCase() !== strategy.asset) return null;
    if (strategy.utcHour !== -1 && Number(row.utcHour) !== strategy.utcHour) return null;
    if (Number(row.entryMinute) !== strategy.entryMinute) return null;
    const upPrice = Number(row.upPrice);
    const downPrice = Number(row.downPrice);
    if (!(upPrice > 0) || upPrice >= 1 || !(downPrice > 0) || downPrice >= 1) return null;
    if (Math.abs(upPrice + downPrice - 1) > MAX_SPREAD_DEV) return null;
    const entryPrice = strategy.direction === 'UP' ? upPrice : downPrice;
    if (entryPrice < strategy.priceMin || entryPrice > strategy.priceMax) return null;
    return {
        epoch: Number(row.cycleStartEpochSec),
        entryPrice,
        won: String(row.resolvedOutcome || '').toUpperCase() === strategy.direction,
        minOrderShares: Math.max(1, Number(CONFIG?.RISK?.minOrderShares || 1))
    };
}

function matchRecent(strategy, cycle) {
    const epoch = Number(cycle.epoch);
    if (strategy.asset !== 'ALL' && String(cycle.asset || '').toUpperCase() !== strategy.asset) return null;
    if (strategy.utcHour !== -1 && new Date(epoch * 1000).getUTCHours() !== strategy.utcHour) return null;
    const sideMap = strategy.direction === 'UP' ? cycle.minutePricesYes : cycle.minutePricesNo;
    const priceData = sideMap?.[strategy.entryMinute];
    if (!priceData) return null;
    const entryPrice = Number(priceData.last);
    if (!Number.isFinite(entryPrice) || entryPrice < strategy.priceMin || entryPrice > strategy.priceMax) return null;
    const oppMap = strategy.direction === 'UP' ? cycle.minutePricesNo : cycle.minutePricesYes;
    const oppPrice = Number(oppMap?.[strategy.entryMinute]?.last);
    if (Number.isFinite(oppPrice) && Math.abs(entryPrice + oppPrice - 1) > MAX_SPREAD_DEV) return null;
    const minRaw = strategy.direction === 'UP'
        ? (cycle.yesMinOrderSize ?? cycle.orderMinSize)
        : (cycle.noMinOrderSize ?? cycle.orderMinSize);
    const minOrderShares = Number.isFinite(Number(minRaw)) && Number(minRaw) > 0
        ? Math.max(Number(CONFIG?.RISK?.minOrderShares || 1), Math.ceil(Number(minRaw)))
        : Math.max(1, Number(CONFIG?.RISK?.minOrderShares || 1));
    return {
        epoch,
        entryPrice,
        won: String(cycle.resolution || '').toUpperCase() === strategy.direction,
        minOrderShares
    };
}

function buildOpportunitiesForEntry(entry) {
    const absPath = path.join(ROOT, entry.file);
    if (!fs.existsSync(absPath)) return [];
    const { cfg, historicalTestRows, recentCycles } = getTimeframeRows(entry.timeframe);
    const artifact = readJson(entry.file);
    const strategies = normalizeStrategies(artifact.strategies || []);
    const opps = [];
    for (const strategy of strategies) {
        for (const row of historicalTestRows) {
            const match = matchHistorical(strategy, row);
            if (!match) continue;
            opps.push({
                timeframe: entry.timeframe,
                sourceFile: entry.file,
                name: strategy.name,
                epoch: match.epoch,
                entryTs: match.epoch + strategy.entryMinute * 60,
                exitTs: match.epoch + cfg.cycleSeconds,
                entryPrice: match.entryPrice,
                pWinEstimate: strategy.pWinEstimate,
                minOrderShares: match.minOrderShares,
                won: match.won
            });
        }
        for (const cycle of recentCycles) {
            const match = matchRecent(strategy, cycle);
            if (!match) continue;
            opps.push({
                timeframe: entry.timeframe,
                sourceFile: entry.file,
                name: strategy.name,
                epoch: match.epoch,
                entryTs: match.epoch + strategy.entryMinute * 60,
                exitTs: match.epoch + cfg.cycleSeconds,
                entryPrice: match.entryPrice,
                pWinEstimate: strategy.pWinEstimate,
                minOrderShares: match.minOrderShares,
                won: match.won
            });
        }
    }
    return opps;
}

function replay(opportunities, startBalance, startTs, endTs) {
    const savedRisk = {
        stakeFraction: CONFIG.RISK.stakeFraction,
        maxGlobalTradesPerCycle: CONFIG.RISK.maxGlobalTradesPerCycle,
        maxTotalExposure: CONFIG.RISK.maxTotalExposure,
        riskEnvelopeEnabled: CONFIG.RISK.riskEnvelopeEnabled,
        maxAbsoluteStakeSmall: CONFIG.RISK.maxAbsoluteStakeSmall,
        maxAbsoluteStakeMedium: CONFIG.RISK.maxAbsoluteStakeMedium,
        maxAbsoluteStakeLarge: CONFIG.RISK.maxAbsoluteStakeLarge,
        minNetEdgeRoi: CONFIG.RISK.minNetEdgeRoi,
        globalStopLoss: CONFIG.RISK.globalStopLoss,
        cooldownSeconds: CONFIG.RISK.cooldownSeconds,
        maxConsecutiveLosses: CONFIG.RISK.maxConsecutiveLosses,
        minBalanceFloor: CONFIG.RISK.minBalanceFloor,
        entryPriceBufferCents: CONFIG.RISK.entryPriceBufferCents,
        enforceNetEdgeGate: CONFIG.RISK.enforceNetEdgeGate
    };

    Object.assign(CONFIG.RISK, {
        maxTotalExposure: 0,
        riskEnvelopeEnabled: false,
        maxAbsoluteStakeSmall: 100000,
        maxAbsoluteStakeMedium: 100000,
        maxAbsoluteStakeLarge: 100000,
        minNetEdgeRoi: 0,
        globalStopLoss: 1,
        cooldownSeconds: 0,
        maxConsecutiveLosses: 999,
        minBalanceFloor: 0,
        entryPriceBufferCents: 0,
        enforceNetEdgeGate: false
    });

    const filtered = opportunities.filter((o) => o.entryTs >= startTs && o.entryTs < endTs);
    const rm = new RiskManager(startBalance);
    let bankroll = startBalance;
    let peakBalance = startBalance;
    let dayStartBalance = startBalance;
    let trades = 0;
    let wins = 0;
    const openPositions = [];
    const cycleCounts = {};

    function settle(position) {
        if (position.won) {
            const fee = Math.max(0, position.shares - position.cost) * TAKER_FEE;
            bankroll += position.shares - fee;
            wins++;
            if (bankroll > peakBalance) peakBalance = bankroll;
        }
        trades++;
    }

    function settleUpTo(ts) {
        openPositions.sort((a, b) => a.exitTs - b.exitTs);
        while (openPositions.length && openPositions[0].exitTs <= ts) settle(openPositions.shift());
    }

    for (const opp of filtered) {
        settleUpTo(opp.entryTs);
        if (bankroll < BUST_THRESHOLD && openPositions.length === 0) break;
        if (bankroll < BUST_THRESHOLD) continue;

        const cycleKey = `${opp.timeframe}_${opp.epoch}`;
        const cycleCount = cycleCounts[cycleKey] || 0;
        const tier = rm._getTierProfile(bankroll);
        if (cycleCount >= tier.maxPerCycle) continue;

        const openExposureUsd = openPositions.reduce((sum, pos) => sum + pos.cost, 0);
        rm.bankroll = bankroll;
        rm.peakBalance = peakBalance;
        rm.dayStartBalance = dayStartBalance;
        const sizing = rm.calculateSize(
            {
                entryPrice: opp.entryPrice,
                pWinEstimate: opp.pWinEstimate,
                minOrderShares: opp.minOrderShares,
                timeframe: opp.timeframe,
                epoch: opp.epoch
            },
            {
                availableCash: bankroll,
                openExposureUsd,
                bankrollEstimate: bankroll + openExposureUsd,
                dayStartBalanceEstimate: dayStartBalance
            }
        );
        if (sizing.blocked || !(sizing.size > 0)) continue;

        const shares = Math.floor(sizing.size / opp.entryPrice + 1e-9);
        if (shares < opp.minOrderShares) continue;
        const cost = shares * opp.entryPrice;
        if (!(cost > 0) || cost > bankroll) continue;

        bankroll -= cost;
        cycleCounts[cycleKey] = cycleCount + 1;
        openPositions.push({ exitTs: opp.exitTs, cost, shares, won: opp.won });
    }

    settleUpTo(Infinity);
    Object.assign(CONFIG.RISK, savedRisk);

    return {
        end: round(bankroll),
        busted: bankroll < BUST_THRESHOLD,
        trades,
        wins
    };
}

function summarize(results, startBalance) {
    const finals = results.map((r) => r.end).sort((a, b) => a - b);
    const busts = results.filter((r) => r.busted).length;
    const profitable = results.filter((r) => r.end > startBalance).length;
    const avgTrades = results.reduce((sum, r) => sum + r.trades, 0) / Math.max(1, results.length);
    const avgWinRate = results.reduce((sum, r) => sum + (r.trades ? r.wins / r.trades : 0), 0) / Math.max(1, results.length);
    return {
        windows: results.length,
        bustPct: round((busts / Math.max(1, results.length)) * 100, 1),
        profitablePct: round((profitable / Math.max(1, results.length)) * 100, 1),
        median: round(percentile(finals, 0.5)),
        p25: round(percentile(finals, 0.25)),
        p75: round(percentile(finals, 0.75)),
        p90: round(percentile(finals, 0.9)),
        min: round(finals[0] || startBalance),
        max: round(finals[finals.length - 1] || startBalance),
        avgTrades: round(avgTrades, 1),
        avgWinRatePct: round(avgWinRate * 100, 1)
    };
}

function main() {
    const results = [];
    const stepSeconds = STEP_HOURS * 3600;

    for (const profile of PROFILES) {
        const opportunities = profile.entries
            .flatMap((entry) => buildOpportunitiesForEntry(entry))
            .sort((a, b) => a.entryTs - b.entryTs || b.pWinEstimate - a.pWinEstimate);
        if (!opportunities.length) continue;

        const firstTs = opportunities[0].entryTs;
        const lastTs = opportunities.reduce((max, opp) => Math.max(max, opp.exitTs), 0);
        const summary = {
            profile: profile.label,
            entries: profile.entries,
            opportunityCount: opportunities.length,
            horizonStats: {}
        };

        for (const horizonHours of HORIZONS_HOURS) {
            const horizonSeconds = horizonHours * 3600;
            const windowResults = [];
            for (let start = firstTs; start + horizonSeconds <= lastTs; start += stepSeconds) {
                windowResults.push(replay(opportunities, START_BALANCE, start, start + horizonSeconds));
            }
            summary.horizonStats[`${horizonHours}h`] = summarize(windowResults, START_BALANCE);
        }

        results.push(summary);
    }

    results.sort((a, b) => {
        const a24 = a.horizonStats['24h'] || {};
        const b24 = b.horizonStats['24h'] || {};
        return (a24.bustPct || 999) - (b24.bustPct || 999)
            || (b24.median || 0) - (a24.median || 0)
            || (b24.p25 || 0) - (a24.p25 || 0);
    });

    const report = {
        generatedAt: new Date().toISOString(),
        startBalance: START_BALANCE,
        horizonsHours: HORIZONS_HOURS,
        stepHours: STEP_HOURS,
        results
    };

    const outPath = path.join(ROOT, 'debug', 'compare_horizon_median.json');
    fs.writeFileSync(outPath, JSON.stringify(report, null, 2));

    console.log(`Saved ${path.relative(ROOT, outPath)}`);
    for (const row of results) {
        const s24 = row.horizonStats['24h'] || {};
        const s48 = row.horizonStats['48h'] || {};
        const s72 = row.horizonStats['72h'] || {};
        console.log(
            `${row.profile.padEnd(32)} | 24h bust=${String(s24.bustPct).padStart(5)}% median=$${String(s24.median).padStart(7)} p25=$${String(s24.p25).padStart(7)}`
            + ` | 48h bust=${String(s48.bustPct).padStart(5)}% median=$${String(s48.median).padStart(7)}`
            + ` | 72h bust=${String(s72.bustPct).padStart(5)}% median=$${String(s72.median).padStart(7)}`
        );
    }
}

main();
