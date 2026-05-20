#!/usr/bin/env node
/**
 * Final Monte Carlo simulation on cross-validated 7-signal portfolio.
 * Uses actual observed WRs from TWO independent windows (May 2-9 + May 13-20).
 */

const START = 7.93;
const N_RUNS = 100000;
const N_TRADES_7D = 49; // 7 signals x 7 days
const N_TRADES_14D = 98;
const MIN_ORDER_SHARES = 5;

function createRng(seed) {
    let state = seed >>> 0;
    return () => {
        state = (1664525 * state + 1013904223) >>> 0;
        return state / 0x100000000;
    };
}

// CROSS-VALIDATED PORTFOLIO — 7 signals that survived both windows
const portfolio = [
    { key: 'H19_M30_UP', pWin: 0.798, price: 0.491, kelly75: 0.45 },
    { key: 'H7_M15_UP', pWin: 0.750, price: 0.472, kelly75: 0.37 },
    { key: 'H12_M30_UP', pWin: 0.720, price: 0.510, kelly75: 0.33 },
    { key: 'H12_M15_UP', pWin: 0.716, price: 0.510, kelly75: 0.32 },
    { key: 'H3_M15_UP', pWin: 0.713, price: 0.493, kelly75: 0.32 },
    { key: 'H13_M15_DOWN', pWin: 0.690, price: 0.480, kelly75: 0.29 },
    { key: 'H13_M30_DOWN', pWin: 0.689, price: 0.480, kelly75: 0.28 },
];

// Stress: -10% WR degradation  
const stressPortfolio = portfolio.map(s => ({...s, pWin: Math.max(0.50, s.pWin - 0.10)}));

// Worst case: -15% WR degradation
const worstPortfolio = portfolio.map(s => ({...s, pWin: Math.max(0.50, s.pWin - 0.15)}));

function runMC(port, start, nTrades, nRuns, slippage = 0, seed = 123456789) {
    const random = createRng(seed);
    const results = [];
    for (let r = 0; r < nRuns; r++) {
        let b = start;
        let bust = false;
        for (let t = 0; t < nTrades; t++) {
            const trade = port[t % port.length];
            // Bootstrap stake cap at 60%
            const stakeF = Math.min(trade.kelly75, 0.60);
            const effectivePrice = Math.min(0.85, trade.price + slippage);
            const minOrderCost = MIN_ORDER_SHARES * effectivePrice;
            let stake = b * stakeF;
            if (stake < minOrderCost) stake = minOrderCost;
            if (stake > b) { bust = true; break; }
            const win = random() < trade.pWin;
            if (win) {
                b += stake * (1/effectivePrice - 1);
            } else {
                b -= stake;
            }
        }
        results.push(bust ? 0 : b);
    }
    results.sort((a, b) => a - b);
    const bustRate = results.filter(r => r === 0).length / nRuns;
    return {
        median: results[Math.floor(nRuns * 0.5)],
        p10: results[Math.floor(nRuns * 0.1)],
        p25: results[Math.floor(nRuns * 0.25)],
        p75: results[Math.floor(nRuns * 0.75)],
        p90: results[Math.floor(nRuns * 0.9)],
        bustRate
    };
}

function fmt(mc) {
    return `median=$${mc.median.toFixed(2)}, p10=$${mc.p10.toFixed(2)}, p25=$${mc.p25.toFixed(2)}, p75=$${mc.p75.toFixed(2)}, p90=$${mc.p90.toFixed(2)}, bust=${(mc.bustRate*100).toFixed(2)}%`;
}

console.log(`Running 100k deterministic MC simulations with ${MIN_ORDER_SHARES}-share minimum order...\n`);

// Base scenario
const mc7 = runMC(portfolio, START, N_TRADES_7D, N_RUNS, 0.0, 1001);
const mc14 = runMC(portfolio, START, N_TRADES_14D, N_RUNS, 0.0, 1002);

// With +1.5c slippage
const mc7Slip = runMC(portfolio, START, N_TRADES_7D, N_RUNS, 0.015, 1003);

// Stress: -10% WR  
const mc7Stress = runMC(stressPortfolio, START, N_TRADES_7D, N_RUNS, 0.015, 1004);

// Worst: -15% WR + slippage
const mc7Worst = runMC(worstPortfolio, START, N_TRADES_7D, N_RUNS, 0.02, 1005);

// With extra deposit (+5 GBP = ~$6.30)
const mc7Extra = runMC(portfolio, START + 6.30, N_TRADES_7D, N_RUNS, 0.015, 1006);
const mc14Extra = runMC(portfolio, START + 6.30, N_TRADES_14D, N_RUNS, 0.015, 1007);

console.log('=== CROSS-VALIDATED 7-SIGNAL PORTFOLIO ===');
console.log('Signals: H19:30 UP, H7:15 UP, H12:30 UP, H12:15 UP, H3:15 UP, H13:15 DOWN, H13:30 DOWN');
console.log('Average combined WR: 72.5% (TWO independent 7-day windows)');
console.log('');
console.log('BASE CASE (no slippage):');
console.log('  7-day  (49 trades): ' + fmt(mc7));
console.log('  14-day (98 trades): ' + fmt(mc14));
console.log('');
console.log('REALISTIC (+1.5c slippage):');
console.log('  7-day  (49 trades): ' + fmt(mc7Slip));
console.log('');
console.log('STRESS (-10% WR + 1.5c slippage):');
console.log('  7-day  (49 trades): ' + fmt(mc7Stress));
console.log('');
console.log('WORST CASE (-15% WR + 2c slippage):');
console.log('  7-day  (49 trades): ' + fmt(mc7Worst));
console.log('');
console.log('WITH EXTRA DEPOSIT (+5 GBP = $6.30, start = $14.23):');
console.log('  7-day  (+1.5c slip): ' + fmt(mc7Extra));
console.log('  14-day (+1.5c slip): ' + fmt(mc14Extra));

console.log('\n=== ALL-IN SINGLE BEST SIGNAL (H19:30 UP, 79.8% WR) ===');
const allInPort = [{ key: 'H19_M30_UP', pWin: 0.798, price: 0.491, kelly75: 1.0 }];
const mcAllIn17 = runMC(allInPort, START, 17, N_RUNS, 0.015, 1008);
const mcAllIn10 = runMC(allInPort, START, 10, N_RUNS, 0.015, 1009);
console.log('  All-in 17 trades: ' + fmt(mcAllIn17));
console.log('  All-in 10 trades: ' + fmt(mcAllIn10));
console.log('  NOTE: All-in = 100% bust if any loss in streak. Not recommended.');

console.log('\n=== COMPARISON VS PREVIOUS (current deployed 7-signal) ===');
const oldPortfolio = [
    { key: 'H19_M30_UP', pWin: 0.762, price: 0.491, kelly75: 0.39 },
    { key: 'H13_M30_DOWN', pWin: 0.690, price: 0.490, kelly75: 0.29 },
    { key: 'H7_M15_UP', pWin: 0.833, price: 0.472, kelly75: 0.50 },
    { key: 'H3_M15_UP', pWin: 0.738, price: 0.493, kelly75: 0.36 },
    { key: 'H6_M15_DOWN', pWin: 0.643, price: 0.458, kelly75: 0.21 },
    { key: 'H12_M0_UP', pWin: 0.714, price: 0.477, kelly75: 0.32 },
    { key: 'H13_M15_DOWN', pWin: 0.714, price: 0.502, kelly75: 0.32 },
];
const mcOld7 = runMC(oldPortfolio, START, N_TRADES_7D, N_RUNS, 0.015, 1010);
console.log('  Old 7-signal (in-sample WRs, +1.5c slip): ' + fmt(mcOld7));
console.log('  New 7-signal (cross-val WRs, +1.5c slip): ' + fmt(mc7Slip));
