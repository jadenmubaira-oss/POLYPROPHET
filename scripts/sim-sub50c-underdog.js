#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const strategyPath = path.join(ROOT, 'strategies', 'strategy_set_15m_sub50c_underdog.json');
const dataPath = path.join(ROOT, 'data', 'intracycle-price-data.json');

const strategySet = JSON.parse(fs.readFileSync(strategyPath, 'utf8'));
const strategies = strategySet.strategies;
const rawData = JSON.parse(fs.readFileSync(dataPath, 'utf8'));
const cycles = rawData.cycles || [];

const START_BALANCE = Number(process.env.START_BALANCE || 2.886);
const STAKE_FRACTION = Number(process.env.STAKE_FRACTION || 0.40);
const MPC = Number(process.env.MPC || 1);
const MIN_ORDER_SHARES = 5;
const ROLLING_HOURS = [24, 48, 72];
const NUM_SIMS = 500;

// Sort cycles chronologically
cycles.sort((a, b) => a.epoch - b.epoch);

// Build per-cycle trade opportunities
function findOpportunities(cycle) {
    const hour = new Date(cycle.epoch * 1000).getUTCHours();
    const opps = [];

    for (const strat of strategies) {
        if (strat.asset !== 'ALL' && strat.asset !== cycle.asset) continue;
        if (strat.utcHour !== hour) continue;

        const dir = strat.direction;
        const prices = dir === 'UP' ? (cycle.minutePricesYes || {}) : (cycle.minutePricesNo || {});
        const minEntry = prices[String(strat.entryMinute)];
        if (!minEntry || !minEntry.last) continue;

        const entryPrice = minEntry.last;
        if (entryPrice < (strat.priceMin || 0) || entryPrice > (strat.priceMax || 1)) continue;

        const won = dir === 'UP' ? cycle.resolution === 'UP' : cycle.resolution === 'DOWN';
        const pnlPerDollar = won ? (1 - entryPrice) / entryPrice : -1;
        opps.push({ strat: strat.name, entryPrice, won, pnlPerDollar, asset: cycle.asset });
    }
    return opps;
}

// Run one simulation pass over the data
function simulate(startIdx, numCycles) {
    let balance = START_BALANCE;
    let trades = 0, wins = 0, losses = 0;
    let peak = balance;
    let busted = false;

    for (let i = startIdx; i < Math.min(startIdx + numCycles, cycles.length); i++) {
        const cycle = cycles[i];
        const opps = findOpportunities(cycle);
        if (opps.length === 0) continue;

        // MPC=1: take the best opportunity (highest expected payout)
        const sorted = opps.sort((a, b) => b.pnlPerDollar * (b.strat.pWinEstimate || 0.3) - a.pnlPerDollar * (a.strat.pWinEstimate || 0.3));
        const taken = sorted.slice(0, MPC);

        for (const opp of taken) {
            const minCost = MIN_ORDER_SHARES * opp.entryPrice;
            let size = balance * STAKE_FRACTION;
            if (size < minCost) {
                if (balance >= minCost) size = minCost;
                else continue; // can't afford
            }
            size = Math.min(size, balance);

            trades++;
            if (opp.won) {
                const payout = size * (1 - opp.entryPrice) / opp.entryPrice;
                balance += payout;
                wins++;
            } else {
                balance -= size;
                losses++;
            }
            peak = Math.max(peak, balance);

            if (balance < 0.10) { busted = true; break; }
        }
        if (busted) break;
    }

    return { balance, trades, wins, losses, peak, busted, wr: trades > 0 ? wins / trades : 0 };
}

// Rolling window analysis
const CYCLE_SECONDS = 900; // 15m
const cyclesPerHour = 3600 / CYCLE_SECONDS;

for (const hours of ROLLING_HOURS) {
    const windowSize = Math.ceil(hours * cyclesPerHour);
    const results = [];

    // Slide window across data
    const step = Math.max(1, Math.floor(windowSize / 4));
    for (let start = 0; start + windowSize <= cycles.length; start += step) {
        const r = simulate(start, windowSize);
        results.push(r);
    }

    if (results.length === 0) {
        console.log(`${hours}h: No windows`);
        continue;
    }

    const balances = results.map(r => r.balance).sort((a, b) => a - b);
    const tradeCounts = results.map(r => r.trades);
    const bustRate = results.filter(r => r.busted).length / results.length;
    const median = balances[Math.floor(balances.length / 2)];
    const p10 = balances[Math.floor(balances.length * 0.10)];
    const p90 = balances[Math.floor(balances.length * 0.90)];
    const avgTrades = tradeCounts.reduce((a, b) => a + b, 0) / tradeCounts.length;
    const avgWR = results.map(r => r.wr).reduce((a, b) => a + b, 0) / results.length;

    console.log(`${hours}h: windows=${results.length} median=$${median.toFixed(2)} p10=$${p10.toFixed(2)} p90=$${p90.toFixed(2)} bust=${(100 * bustRate).toFixed(1)}% avgTrades=${avgTrades.toFixed(1)} avgWR=${(100 * avgWR).toFixed(1)}%`);
}

// Full-period simulation
console.log('');
const full = simulate(0, cycles.length);
console.log(`Full period: balance=$${full.balance.toFixed(2)} trades=${full.trades} WR=${(100 * full.wr).toFixed(1)}% peak=$${full.peak.toFixed(2)} busted=${full.busted}`);

// Compare with ultra-tight (would see 0 trades at $2.886)
console.log('');
console.log('Ultra-tight 70-78c at $2.886: CANNOT TRADE (min order $3.50+ > $2.886 available)');
