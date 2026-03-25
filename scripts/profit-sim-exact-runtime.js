/**
 * EXACT-RUNTIME Profit Simulation
 * 
 * This simulation replicates the EXACT mechanics of:
 *   - lib/risk-manager.js (canTrade, calculateSize, recordTrade, cooldown, global stop)
 *   - lib/trade-executor.js (executeTrade, min-order bump, paper resolution)
 *   - lib/config.js (RISK params, MICRO_SPRINT thresholds)
 *   - lib/strategy-matcher.js (evaluateMatch: utcHour + entryMinute + price band + direction)
 *
 * It uses the REAL decision datasets (not synthetic data) and runs Monte Carlo
 * by sampling random day-sequences from the empirical trade calendar.
 *
 * Key differences from the old profit-sim-empirical-binary-portfolio.js:
 *   1. Uses ADAPTIVE SIZING (not always min-order)
 *   2. Models Kelly sizing with kellyFraction=0.25, kellyMaxFraction=0.45
 *   3. Models peak drawdown brake (20% DD from peak when bankroll > $20)
 *   4. Models min-order bump path exactly as runtime does
 *   5. Models Polymarket fees (3.15% on winning profit)
 *   6. Models 1% slippage on entry
 *   7. Models 1 trade per cycle at micro bankroll (<$10), 2 per cycle above
 *   8. Models cooldown (1200s = 20min after 3 consecutive losses)
 *   9. Models global stop loss (20% of day-start balance)
 *  10. Models balance floor ($2.00)
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

// ==================== EXACT RUNTIME CONFIG ====================
const RUNTIME = {
    startingBalance: Number(process.env.STARTING_BALANCE || 5),
    simDays: Number(process.env.SIM_DAYS || 30),
    trials: Number(process.env.TRIALS || 3000),
    // Risk params from lib/config.js
    stakeFraction: 0.30,        // defaultStakeFraction when startingBalance <= 10
    kellyMaxFraction: 0.45,
    kellyFraction: 0.25,        // half-Kelly
    kellyMinPWin: 0.55,
    globalStopLoss: 0.20,
    maxGlobalTradesPerCycle: 2,
    microBankrollThreshold: 10,
    minOrderShares: 5,
    maxConsecutiveLosses: 3,
    cooldownSeconds: 1200,
    peakDrawdownBrakePct: 0.20,
    peakDrawdownBrakeMinBankroll: 20,
    minBalanceFloor: 2.0,
    slippagePct: 0.01,
    // Polymarket fees
    winProfitFeePct: 0.0315,    // 3.15% on winning profit (not on total payout)
};

// ==================== HELPERS ====================
function readJson(rel) {
    return JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
}

function round(v, d = 4) {
    const f = Math.pow(10, d);
    return Math.round(v * f) / f;
}

function wilsonLCB(wins, total, z = 1.96) {
    if (total <= 0) return 0;
    const p = wins / total;
    const denom = 1 + z * z / total;
    const center = p + z * z / (2 * total);
    const margin = z * Math.sqrt((p * (1 - p) + z * z / (4 * total)) / total);
    return Math.max(0, (center - margin) / denom);
}

function percentile(sorted, p) {
    if (!sorted.length) return 0;
    const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor((sorted.length - 1) * p)));
    return sorted[idx];
}

function mulberry32(seed) {
    let a = (seed >>> 0) || 1;
    return function () {
        a |= 0;
        a = (a + 0x6D2B79F5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

// ==================== EXACT RUNTIME SIZING (from risk-manager.js) ====================
function calculateSize(bankroll, peakBalance, entryPrice, pWinEstimate) {
    let stakeFraction = RUNTIME.stakeFraction;

    // Peak drawdown brake
    if (peakBalance > RUNTIME.peakDrawdownBrakeMinBankroll) {
        const ddPct = (peakBalance - bankroll) / peakBalance;
        if (ddPct >= RUNTIME.peakDrawdownBrakePct) {
            stakeFraction = Math.min(stakeFraction, 0.12);
        }
    }

    let size = bankroll * stakeFraction;

    // Kelly sizing
    if (pWinEstimate >= RUNTIME.kellyMinPWin && entryPrice > 0 && entryPrice < 1) {
        const effectiveEntry = Math.min(0.99, entryPrice * (1 + RUNTIME.slippagePct));
        const b = (1 / effectiveEntry) - 1;
        if (b > 0) {
            const fullKelly = (b * pWinEstimate - (1 - pWinEstimate)) / b;
            if (fullKelly > 0) {
                const kellySize = bankroll * Math.min(fullKelly * RUNTIME.kellyFraction, RUNTIME.kellyMaxFraction);
                if (kellySize < size) {
                    size = kellySize;
                }
            }
        }
    }

    // Cap at stake fraction
    const maxSize = bankroll * stakeFraction;
    if (size > maxSize) size = maxSize;

    // Minimum order enforcement (EXACT runtime logic)
    const minOrderCost = RUNTIME.minOrderShares * entryPrice;
    if (size < minOrderCost) {
        const minCashNeeded = minOrderCost * 1.05;
        if (bankroll >= minCashNeeded) {
            size = minOrderCost;
        } else {
            return { size: 0, blocked: true, reason: 'BELOW_MIN_ORDER' };
        }
    }

    // Floor check: never risk so much that loss drops below min balance floor
    const maxRisk = bankroll - RUNTIME.minBalanceFloor;
    if (size > maxRisk && bankroll >= RUNTIME.microBankrollThreshold) {
        size = Math.max(minOrderCost, maxRisk);
    }
    // For micro-bankroll (<$10), allow going below floor (user accepts bust risk)

    return { size: Math.max(0, size), blocked: false };
}

// ==================== TRADE BUILDING ====================
function buildStrategyTrades(dataset, strategies, cycleSec, groupName) {
    const bySlot = new Map();
    for (const s of strategies) {
        const key = `${s.utcHour}|${s.entryMinute}`;
        if (!bySlot.has(key)) bySlot.set(key, []);
        bySlot.get(key).push(s);
    }
    const trades = [];
    for (const row of dataset) {
        const slot = bySlot.get(`${row.utcHour}|${row.entryMinute}`);
        if (!slot) continue;
        for (const s of slot) {
            const entryPrice = s.direction === 'UP' ? Number(row.upPrice) : Number(row.downPrice);
            if (!Number.isFinite(entryPrice) || entryPrice <= 0 || entryPrice >= 1) continue;
            if (entryPrice < s.priceMin || entryPrice > s.priceMax) continue;
            const cycleStart = Number(row.cycleStartEpochSec);
            if (!Number.isFinite(cycleStart)) continue;
            const entryTs = cycleStart + (s.entryMinute * 60);
            const exitTs = cycleStart + cycleSec;
            const won = row.resolvedOutcome === s.direction;
            trades.push({
                group: groupName,
                asset: row.asset || 'ALL',
                dayKey: new Date(entryTs * 1000).toISOString().slice(0, 10),
                entryTs,
                exitTs,
                entryOffsetSec: entryTs - Math.floor(entryTs / 86400) * 86400,
                exitOffsetSec: exitTs - Math.floor(entryTs / 86400) * 86400,
                entryPrice,
                pWinEstimate: s.winRateLCB || s.winRate || 0.5,
                won,
                cycleKey: `${groupName}_${cycleStart}`
            });
        }
    }
    return trades;
}

function groupByDay(trades) {
    const byDay = new Map();
    for (const t of trades) {
        if (!byDay.has(t.dayKey)) byDay.set(t.dayKey, []);
        byDay.get(t.dayKey).push(t);
    }
    return [...byDay.entries()].map(([dayKey, dayTrades]) => ({
        dayKey,
        trades: dayTrades.sort((a, b) => a.entryTs - b.entryTs)
    }));
}

// ==================== EXACT RUNTIME SIMULATION ====================
function simulateTrial(dayBuckets, scenario, seed) {
    const rand = mulberry32(seed);
    const groupBuckets = {};
    for (const g of scenario.groups) {
        groupBuckets[g] = dayBuckets[g] || [];
    }

    let bankroll = RUNTIME.startingBalance;
    let peakBalance = bankroll;
    let dayStartBalance = bankroll;
    let consecutiveLosses = 0;
    let cooldownUntil = -Infinity;
    let totalTrades = 0;
    let totalWins = 0;
    let totalLosses = 0;
    let maxDrawdown = 0;
    let busted = false;
    const openPositions = [];
    const cycleTradeCount = {};

    function updateDD() {
        if (bankroll > peakBalance) peakBalance = bankroll;
        const dd = peakBalance > 0 ? (peakBalance - bankroll) / peakBalance : 0;
        if (dd > maxDrawdown) maxDrawdown = dd;
    }

    function settleUpTo(ts) {
        openPositions.sort((a, b) => a.exitTs - b.exitTs);
        while (openPositions.length > 0 && openPositions[0].exitTs <= ts) {
            const pos = openPositions.shift();
            // Payout calculation (EXACT runtime logic)
            if (pos.won) {
                const grossPayout = pos.shares; // $1 per share on win
                const grossProfit = grossPayout - pos.cost;
                const fee = Math.max(0, grossProfit) * RUNTIME.winProfitFeePct;
                const netPayout = grossPayout - fee;
                bankroll += netPayout;
                totalWins++;
                consecutiveLosses = 0;
            } else {
                // Loss: payout = 0, cost already deducted
                totalLosses++;
                consecutiveLosses++;
                if (consecutiveLosses >= RUNTIME.maxConsecutiveLosses) {
                    cooldownUntil = pos.exitTs + RUNTIME.cooldownSeconds;
                    consecutiveLosses = 0;
                }
            }
            totalTrades++;
            updateDD();
        }
    }

    for (let day = 0; day < RUNTIME.simDays; day++) {
        const dayStartTs = day * 86400;
        const dayEndTs = dayStartTs + 86400;

        // Settle any positions from previous day
        settleUpTo(dayStartTs);
        dayStartBalance = bankroll;
        let dayStopped = false;

        // Collect all trades for this day from each group
        const dayTrades = [];
        for (const g of scenario.groups) {
            const buckets = groupBuckets[g];
            if (!buckets.length) continue;
            const bucket = buckets[Math.floor(rand() * buckets.length)];
            if (!bucket) continue;
            for (const t of bucket.trades) {
                dayTrades.push({
                    ...t,
                    entryTs: dayStartTs + t.entryOffsetSec,
                    exitTs: dayStartTs + t.exitOffsetSec
                });
            }
        }
        dayTrades.sort((a, b) => a.entryTs - b.entryTs);

        // Reset cycle counts for this day
        const dayCycleCounts = {};

        for (const trade of dayTrades) {
            settleUpTo(trade.entryTs);

            // === EXACT canTrade() gates ===
            if (bankroll < RUNTIME.minBalanceFloor) { busted = true; break; }
            if (dayStopped) continue;
            if (trade.entryTs < cooldownUntil) continue;

            // Global stop loss
            const maxDayLoss = dayStartBalance * RUNTIME.globalStopLoss;
            const dayPnl = bankroll - dayStartBalance;
            if (dayPnl < -maxDayLoss) { dayStopped = true; continue; }

            // Max trades per cycle (bankroll-adaptive)
            const maxPerCycle = bankroll < RUNTIME.microBankrollThreshold ? 1 : RUNTIME.maxGlobalTradesPerCycle;
            const ck = trade.cycleKey;
            const cycleCount = dayCycleCounts[ck] || 0;
            if (cycleCount >= maxPerCycle) continue;

            // === EXACT calculateSize() ===
            const sizing = calculateSize(bankroll, peakBalance, trade.entryPrice, trade.pWinEstimate);
            if (sizing.blocked || sizing.size <= 0) continue;

            // Compute shares (EXACT runtime: Math.floor(size / entryPrice) using RAW price)
            const shares = Math.floor(sizing.size / trade.entryPrice);
            if (shares < RUNTIME.minOrderShares) continue;

            // Actual fill cost includes slippage (what you really pay)
            const effectiveEntry = Math.min(0.999, trade.entryPrice * (1 + RUNTIME.slippagePct));
            const cost = shares * effectiveEntry;
            if (cost > bankroll) continue;

            // === Execute trade ===
            bankroll -= cost;
            dayCycleCounts[ck] = cycleCount + 1;
            openPositions.push({
                exitTs: trade.exitTs,
                cost,
                shares,
                won: trade.won,
                group: trade.group
            });
            updateDD();
        }

        if (busted) break;
        settleUpTo(dayEndTs);
        updateDD();
    }

    // Settle remaining
    settleUpTo(Number.MAX_SAFE_INTEGER);
    updateDD();

    return {
        finalBalance: round(bankroll, 2),
        busted: bankroll < RUNTIME.minBalanceFloor,
        totalTrades,
        totalWins,
        totalLosses,
        winRate: totalTrades > 0 ? round(totalWins / totalTrades, 4) : 0,
        maxDrawdown: round(maxDrawdown, 4)
    };
}

function summarizeTrials(results) {
    const finals = results.map(r => r.finalBalance).sort((a, b) => a - b);
    const bustCount = results.filter(r => r.busted).length;
    const avgTrades = results.reduce((s, r) => s + r.totalTrades, 0) / results.length;
    const avgWR = results.reduce((s, r) => s + r.winRate, 0) / results.length;
    const avgDD = results.reduce((s, r) => s + r.maxDrawdown, 0) / results.length;
    return {
        trials: results.length,
        bustRate: round(bustCount / results.length, 4),
        bustCount,
        avgTrades: round(avgTrades, 1),
        avgWinRate: round(avgWR, 4),
        avgMaxDrawdown: round(avgDD, 4),
        finalBalance: {
            min: round(finals[0], 2),
            p5: round(percentile(finals, 0.05), 2),
            p10: round(percentile(finals, 0.10), 2),
            p25: round(percentile(finals, 0.25), 2),
            median: round(percentile(finals, 0.50), 2),
            p75: round(percentile(finals, 0.75), 2),
            p90: round(percentile(finals, 0.90), 2),
            p95: round(percentile(finals, 0.95), 2),
            max: round(finals[finals.length - 1], 2)
        }
    };
}

// ==================== MAIN ====================
function main() {
    console.error('Loading datasets...');
    const strat15 = readJson('debug/strategy_set_top7_drop6.json');
    const strat4h = readJson('debug/strategy_set_4h_maxprofit.json');
    const strat5m = readJson('debug/strategy_set_5m_maxprofit.json');
    const ds15 = readJson('exhaustive_analysis/decision_dataset.json');
    const ds4h = readJson('exhaustive_analysis/4h/4h_decision_dataset.json');
    const ds5m = readJson('exhaustive_analysis/5m/5m_decision_dataset.json');

    console.error('Building trade lists...');
    const trades15 = buildStrategyTrades(ds15, strat15.strategies, 900, 'strat15');
    const trades4h = buildStrategyTrades(ds4h, strat4h.strategies, 14400, 'strat4h');
    const trades5m = buildStrategyTrades(ds5m, strat5m.strategies, 300, 'strat5m');

    console.error(`Trades: 15m=${trades15.length}, 4h=${trades4h.length}, 5m=${trades5m.length}`);

    // Summarize raw trade quality
    const summarize = (trades, label) => {
        const wins = trades.filter(t => t.won).length;
        const days = new Set(trades.map(t => t.dayKey)).size;
        return {
            label,
            trades: trades.length,
            wins,
            winRate: round(wins / trades.length, 4),
            winRateLCB: round(wilsonLCB(wins, trades.length), 4),
            days,
            tradesPerDay: round(trades.length / Math.max(1, days), 2),
            avgEntry: round(trades.reduce((s, t) => s + t.entryPrice, 0) / trades.length, 4)
        };
    };

    const tradeSummaries = {
        strat15: summarize(trades15, '15m top7_drop6'),
        strat4h: summarize(trades4h, '4h maxprofit'),
        strat5m: summarize(trades5m, '5m maxprofit')
    };

    // Group by day for Monte Carlo sampling
    const dayBuckets = {
        strat15: groupByDay(trades15),
        strat4h: groupByDay(trades4h),
        strat5m: groupByDay(trades5m)
    };

    console.error(`Day buckets: 15m=${dayBuckets.strat15.length}, 4h=${dayBuckets.strat4h.length}, 5m=${dayBuckets.strat5m.length}`);

    // Define scenarios
    const scenarios = [
        { name: '15m only', groups: ['strat15'] },
        { name: '4h only', groups: ['strat4h'] },
        { name: '5m only', groups: ['strat5m'] },
        { name: '15m + 4h', groups: ['strat15', 'strat4h'] },
        { name: '15m + 5m', groups: ['strat15', 'strat5m'] },
        { name: '15m + 4h + 5m', groups: ['strat15', 'strat4h', 'strat5m'] },
        { name: '4h + 5m', groups: ['strat4h', 'strat5m'] },
    ];

    // Run simulations at multiple starting balances
    const startingBalances = [5, 7, 10, 20];
    const allResults = {};

    for (const sb of startingBalances) {
        RUNTIME.startingBalance = sb;
        // Adjust stake fraction based on starting balance (EXACT config.js logic)
        RUNTIME.stakeFraction = sb <= 10 ? 0.30 : 0.20;

        console.error(`\nRunning ${RUNTIME.trials} trials at $${sb} start...`);
        const sbResults = [];

        for (const scenario of scenarios) {
            console.error(`  Scenario: ${scenario.name}...`);
            const trials = [];
            for (let t = 0; t < RUNTIME.trials; t++) {
                trials.push(simulateTrial(dayBuckets, scenario, (sb * 10007) + (scenarios.indexOf(scenario) * 1000003) + t));
            }
            sbResults.push({
                scenario: scenario.name,
                groups: scenario.groups,
                ...summarizeTrials(trials)
            });
        }

        // Sort by median descending
        sbResults.sort((a, b) => b.finalBalance.median - a.finalBalance.median);
        allResults[`$${sb}`] = sbResults;
    }

    const output = {
        generatedAt: new Date().toISOString(),
        simulationEngine: 'exact-runtime-v1',
        runtimeConfig: {
            stakeFraction: '0.30 (<=10) / 0.20 (>10)',
            kellyFraction: RUNTIME.kellyFraction,
            kellyMaxFraction: RUNTIME.kellyMaxFraction,
            minOrderShares: RUNTIME.minOrderShares,
            slippagePct: RUNTIME.slippagePct,
            winProfitFeePct: RUNTIME.winProfitFeePct,
            globalStopLoss: RUNTIME.globalStopLoss,
            maxConsecutiveLosses: RUNTIME.maxConsecutiveLosses,
            cooldownSeconds: RUNTIME.cooldownSeconds,
            peakDrawdownBrakePct: RUNTIME.peakDrawdownBrakePct,
            microBankrollThreshold: RUNTIME.microBankrollThreshold,
            minBalanceFloor: RUNTIME.minBalanceFloor,
            simDays: RUNTIME.simDays,
            trialsPerScenario: RUNTIME.trials
        },
        tradeSummaries,
        results: allResults
    };

    console.log(JSON.stringify(output, null, 2));
}

main();
