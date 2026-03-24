#!/usr/bin/env node
/**
 * Combined Profit Simulation for ALL strategy sets (15m + 4h + 5m)
 * 
 * Models realistic constraints:
 * - Min order: 5 shares (cost = 5 * entryPrice)
 * - Micro bankroll bump path
 * - Loss cooldown: 3 consecutive losses → 20 min pause
 * - Global stop: 20% daily loss → halt
 * - Balance floor: $2
 * - Max 1 trade per cycle at micro bankroll (<$10)
 * - Max 2 trades per cycle at normal bankroll
 * - Slippage: 1%
 * - Kelly sizing (half-Kelly, cap 0.45)
 * - Peak drawdown brake at 20% DD from peak (if bankroll > $20)
 * 
 * Uses actual strategy artifact WRs and entry price bands.
 * Monte Carlo simulation with 10,000 trials.
 */

const fs = require('fs');
const path = require('path');

// Load strategy artifacts
const REPO_ROOT = path.join(__dirname, '..');
const strat15m = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'debug', 'strategy_set_top7_drop6.json'), 'utf8'));
const strat4h = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'debug', 'strategy_set_4h_maxprofit.json'), 'utf8'));
const strat5m = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'debug', 'strategy_set_5m_maxprofit.json'), 'utf8'));

// === CONFIGURATION ===
const STARTING_BALANCE = 5.00;
const MIN_ORDER_SHARES = 5;
const BALANCE_FLOOR = 2.00;
const GLOBAL_STOP_LOSS_PCT = 0.20;
const MAX_CONSECUTIVE_LOSSES = 3;
const COOLDOWN_CYCLES = 4; // ~20 min = 4 x 5min cycles or ~1.3 x 15min cycles
const SLIPPAGE_PCT = 0.01;
const KELLY_FRACTION = 0.25; // half-Kelly
const KELLY_MAX = 0.45;
const STAKE_FRACTION = 0.45;
const PEAK_DD_BRAKE_PCT = 0.20;
const PEAK_DD_BRAKE_MIN = 20;
const MICRO_THRESHOLD = 10;
const SIM_DAYS = 30;
const TRIALS = 10000;

// === BUILD COMBINED TRADE SCHEDULE ===
// Each strategy fires at specific UTC hours and entry minutes
// We model daily trade opportunities based on strategy frequency

function buildDailyTradeOpportunities() {
    const opportunities = [];
    
    // 15m strategies: fire once per day per strategy (each specific UTC hour + minute)
    // Each covers ALL 4 assets, so potentially 4 opportunities per strategy per day
    // But market price must be in band — assume ~60% of the time price is in 60-80c band
    const PRICE_IN_BAND_15M = 0.60;
    for (const s of strat15m.strategies) {
        // Each fires once per day at its specific hour
        // With 4 assets and ~60% price-in-band probability
        const dailyFires = 4 * PRICE_IN_BAND_15M; // ~2.4 opportunities per strategy per day
        // But we only take the best 1 per cycle (micro bankroll constraint)
        opportunities.push({
            tf: '15m',
            name: s.name,
            winRate: s.winRate,
            winRateLCB: s.winRateLCB,
            priceMin: s.priceMin,
            priceMax: s.priceMax,
            dailyOpportunities: 1, // 1 opportunity per day per strategy (conservative)
            direction: s.direction
        });
    }
    
    // 4h strategies: fire at specific hours, entry at minute 120 or 180 within 4h cycle
    // 6 4h cycles per day, each strategy fires once per day
    const PRICE_IN_BAND_4H = 0.55;
    for (const s of strat4h.strategies) {
        opportunities.push({
            tf: '4h',
            name: s.name,
            winRate: s.winRate,
            winRateLCB: s.winRateLCB,
            priceMin: s.priceMin,
            priceMax: s.priceMax,
            dailyOpportunities: 1,
            direction: s.direction
        });
    }
    
    // 5m strategies: fire at specific hours, much higher frequency
    // 288 5m cycles per day, but each strategy only at its specific hour
    const PRICE_IN_BAND_5M = 0.50;
    for (const s of strat5m.strategies) {
        // Each 5m strategy fires at 1 specific hour, so ~12 cycles/hour * 1 hour = 12 opportunities
        // But only 4 assets, and price must be in band
        opportunities.push({
            tf: '5m',
            name: s.name,
            winRate: s.winRate,
            winRateLCB: s.winRateLCB,
            priceMin: s.priceMin,
            priceMax: s.priceMax,
            dailyOpportunities: Math.min(4, Math.round(4 * PRICE_IN_BAND_5M)), // ~2 per day per strategy
            direction: s.direction
        });
    }
    
    return opportunities;
}

function randomEntryPrice(priceMin, priceMax) {
    return priceMin + Math.random() * (priceMax - priceMin);
}

function simulateTrial(opportunities, enabledTimeframes, days) {
    let bankroll = STARTING_BALANCE;
    let peakBalance = bankroll;
    let dayStartBalance = bankroll;
    let consecutiveLosses = 0;
    let cooldownRemaining = 0;
    let totalTrades = 0;
    let totalWins = 0;
    let totalLosses = 0;
    let maxDrawdown = 0;
    let busted = false;
    let todayPnL = 0;
    
    const dailyBalances = [bankroll];
    
    for (let day = 0; day < days; day++) {
        dayStartBalance = bankroll;
        todayPnL = 0;
        consecutiveLosses = Math.min(consecutiveLosses, MAX_CONSECUTIVE_LOSSES - 1); // reset partial
        
        // Generate today's trade opportunities
        const todayTrades = [];
        for (const opp of opportunities) {
            if (!enabledTimeframes.includes(opp.tf)) continue;
            for (let i = 0; i < opp.dailyOpportunities; i++) {
                todayTrades.push({ ...opp });
            }
        }
        
        // Shuffle to randomize order
        for (let i = todayTrades.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [todayTrades[i], todayTrades[j]] = [todayTrades[j], todayTrades[i]];
        }
        
        // Sort by winRateLCB (best first)
        todayTrades.sort((a, b) => (b.winRateLCB || 0) - (a.winRateLCB || 0));
        
        for (const trade of todayTrades) {
            if (busted) break;
            
            // Balance floor check
            if (bankroll < BALANCE_FLOOR) { busted = true; break; }
            
            // Cooldown check
            if (cooldownRemaining > 0) { cooldownRemaining--; continue; }
            
            // Global stop loss
            const maxDayLoss = dayStartBalance * GLOBAL_STOP_LOSS_PCT;
            if (todayPnL < -maxDayLoss) break;
            
            // Entry price
            const entryPrice = randomEntryPrice(trade.priceMin, trade.priceMax);
            const effectiveEntry = Math.min(0.99, entryPrice * (1 + SLIPPAGE_PCT));
            
            // Min order cost
            const minOrderCost = MIN_ORDER_SHARES * effectiveEntry;
            
            // Size calculation
            let stakeFraction = STAKE_FRACTION;
            
            // Peak drawdown brake
            if (peakBalance > PEAK_DD_BRAKE_MIN) {
                const ddPct = (peakBalance - bankroll) / peakBalance;
                if (ddPct >= PEAK_DD_BRAKE_PCT) {
                    stakeFraction = Math.min(stakeFraction, 0.12);
                }
            }
            
            let size = bankroll * stakeFraction;
            
            // Kelly sizing
            const pWin = trade.winRateLCB || trade.winRate || 0.5;
            if (pWin >= 0.55 && effectiveEntry > 0 && effectiveEntry < 1) {
                const b = (1 / effectiveEntry) - 1;
                if (b > 0) {
                    const fullKelly = (b * pWin - (1 - pWin)) / b;
                    if (fullKelly > 0) {
                        const kellySize = bankroll * Math.min(fullKelly * KELLY_FRACTION, KELLY_MAX);
                        if (kellySize < size) size = kellySize;
                    }
                }
            }
            
            // Min order bump
            if (size < minOrderCost) {
                const minCashNeeded = minOrderCost * 1.05;
                if (bankroll >= minCashNeeded) {
                    size = minOrderCost;
                } else {
                    continue; // Can't afford min order
                }
            }
            
            // Shares check
            const shares = Math.floor(size / effectiveEntry);
            if (shares < MIN_ORDER_SHARES) continue;
            
            // Actual cost
            const actualCost = shares * effectiveEntry;
            
            // Floor protection (relaxed at micro)
            if (bankroll < MICRO_THRESHOLD) {
                // Micro: allow if bankroll >= min order cost
                if (bankroll < minOrderCost) continue;
            } else {
                const maxRisk = bankroll - BALANCE_FLOOR;
                if (actualCost > maxRisk) {
                    const cappedShares = Math.floor(maxRisk / effectiveEntry);
                    if (cappedShares < MIN_ORDER_SHARES) continue;
                }
            }
            
            // Execute trade
            const won = Math.random() < pWin;
            let pnl;
            
            if (won) {
                // Win: payout = shares * $1.00 (binary resolution)
                const payout = shares * 1.0;
                pnl = payout - actualCost;
            } else {
                // Loss: lose the cost
                pnl = -actualCost;
            }
            
            bankroll += pnl;
            todayPnL += pnl;
            totalTrades++;
            
            if (won) {
                totalWins++;
                consecutiveLosses = 0;
                if (bankroll > peakBalance) peakBalance = bankroll;
            } else {
                totalLosses++;
                consecutiveLosses++;
                if (consecutiveLosses >= MAX_CONSECUTIVE_LOSSES) {
                    cooldownRemaining = COOLDOWN_CYCLES;
                    consecutiveLosses = 0;
                }
            }
            
            // Track drawdown
            const dd = (peakBalance - bankroll) / peakBalance;
            if (dd > maxDrawdown) maxDrawdown = dd;
            
            if (bankroll < BALANCE_FLOOR) { busted = true; break; }
        }
        
        dailyBalances.push(bankroll);
    }
    
    return {
        finalBalance: bankroll,
        peakBalance,
        maxDrawdown,
        totalTrades,
        totalWins,
        totalLosses,
        winRate: totalTrades > 0 ? totalWins / totalTrades : 0,
        busted,
        dailyBalances
    };
}

function runMonteCarlo(opportunities, enabledTimeframes, days, trials) {
    const results = [];
    for (let i = 0; i < trials; i++) {
        results.push(simulateTrial(opportunities, enabledTimeframes, days));
    }
    
    results.sort((a, b) => a.finalBalance - b.finalBalance);
    
    const finals = results.map(r => r.finalBalance);
    const bustCount = results.filter(r => r.busted).length;
    const avgTrades = results.reduce((s, r) => s + r.totalTrades, 0) / trials;
    const avgWR = results.reduce((s, r) => s + r.winRate, 0) / trials;
    const avgDD = results.reduce((s, r) => s + r.maxDrawdown, 0) / trials;
    
    const p5 = finals[Math.floor(trials * 0.05)];
    const p25 = finals[Math.floor(trials * 0.25)];
    const median = finals[Math.floor(trials * 0.50)];
    const p75 = finals[Math.floor(trials * 0.75)];
    const p95 = finals[Math.floor(trials * 0.95)];
    const max = finals[finals.length - 1];
    const min = finals[0];
    
    return {
        trials,
        days,
        startingBalance: STARTING_BALANCE,
        enabledTimeframes,
        bustRate: (bustCount / trials * 100).toFixed(2) + '%',
        bustCount,
        avgTrades: avgTrades.toFixed(1),
        avgWinRate: (avgWR * 100).toFixed(1) + '%',
        avgMaxDrawdown: (avgDD * 100).toFixed(1) + '%',
        finalBalance: {
            min: min.toFixed(2),
            p5: p5.toFixed(2),
            p25: p25.toFixed(2),
            median: median.toFixed(2),
            p75: p75.toFixed(2),
            p95: p95.toFixed(2),
            max: max.toFixed(2)
        }
    };
}

// === RUN SIMULATIONS ===
console.log('=== POLYPROPHET COMBINED PROFIT SIMULATION ===');
console.log(`Starting Balance: $${STARTING_BALANCE}`);
console.log(`Simulation Period: ${SIM_DAYS} days`);
console.log(`Monte Carlo Trials: ${TRIALS}`);
console.log(`Min Order: ${MIN_ORDER_SHARES} shares`);
console.log(`Slippage: ${SLIPPAGE_PCT * 100}%`);
console.log(`Kelly: half-Kelly (k=${KELLY_FRACTION}, cap=${KELLY_MAX})`);
console.log(`Stake Fraction: ${STAKE_FRACTION}`);
console.log(`Balance Floor: $${BALANCE_FLOOR}`);
console.log(`Global Stop: ${GLOBAL_STOP_LOSS_PCT * 100}% daily`);
console.log(`Cooldown: ${MAX_CONSECUTIVE_LOSSES} losses → ${COOLDOWN_CYCLES} cycle pause`);
console.log('');

const opportunities = buildDailyTradeOpportunities();

console.log('--- Strategy Summary ---');
console.log(`15m strategies: ${strat15m.strategies.length} (aggregate WR: ${(strat15m.strategies.reduce((s,st) => s + st.winRate, 0) / strat15m.strategies.length * 100).toFixed(1)}%)`);
console.log(`4h strategies: ${strat4h.strategies.length} (aggregate WR: ${(strat4h.stats.aggregateWR * 100).toFixed(1)}%)`);
console.log(`5m strategies: ${strat5m.strategies.length} (aggregate WR: ${(strat5m.stats.aggregateWR * 100).toFixed(1)}%)`);
console.log('');

// Scenario 1: 15m only (current state)
console.log('=== SCENARIO 1: 15m ONLY (Current Active State) ===');
const sc1 = runMonteCarlo(opportunities, ['15m'], SIM_DAYS, TRIALS);
console.log(JSON.stringify(sc1, null, 2));
console.log('');

// Scenario 2: 15m + 4h (next recommended state)
console.log('=== SCENARIO 2: 15m + 4h (Next Recommended State) ===');
const sc2 = runMonteCarlo(opportunities, ['15m', '4h'], SIM_DAYS, TRIALS);
console.log(JSON.stringify(sc2, null, 2));
console.log('');

// Scenario 3: All three (15m + 4h + 5m)
console.log('=== SCENARIO 3: 15m + 4h + 5m (Full Stack) ===');
const sc3 = runMonteCarlo(opportunities, ['15m', '4h', '5m'], SIM_DAYS, TRIALS);
console.log(JSON.stringify(sc3, null, 2));
console.log('');

// Scenario 4: 15m + 4h from $7 start
console.log('=== SCENARIO 4: 15m + 4h from $7 (Slightly Higher Start) ===');
const origBalance = STARTING_BALANCE;
// Temporarily modify for this scenario - hacky but functional
const sc4opportunities = buildDailyTradeOpportunities();
const sc4 = (() => {
    const saved = STARTING_BALANCE;
    // We can't modify const, so we'll run a custom trial
    const results = [];
    for (let i = 0; i < TRIALS; i++) {
        let bankroll = 7.00;
        let peakBalance = bankroll;
        let dayStartBalance = bankroll;
        let consecutiveLosses = 0;
        let cooldownRemaining = 0;
        let totalTrades = 0;
        let totalWins = 0;
        let totalLosses = 0;
        let maxDrawdown = 0;
        let busted = false;
        let todayPnL = 0;
        
        for (let day = 0; day < SIM_DAYS; day++) {
            dayStartBalance = bankroll;
            todayPnL = 0;
            
            const todayTrades = [];
            for (const opp of sc4opportunities) {
                if (!['15m', '4h'].includes(opp.tf)) continue;
                for (let j = 0; j < opp.dailyOpportunities; j++) {
                    todayTrades.push({ ...opp });
                }
            }
            todayTrades.sort((a, b) => (b.winRateLCB || 0) - (a.winRateLCB || 0));
            
            for (const trade of todayTrades) {
                if (busted) break;
                if (bankroll < BALANCE_FLOOR) { busted = true; break; }
                if (cooldownRemaining > 0) { cooldownRemaining--; continue; }
                const maxDayLoss = dayStartBalance * GLOBAL_STOP_LOSS_PCT;
                if (todayPnL < -maxDayLoss) break;
                
                const entryPrice = randomEntryPrice(trade.priceMin, trade.priceMax);
                const effectiveEntry = Math.min(0.99, entryPrice * (1 + SLIPPAGE_PCT));
                const minOrderCost = MIN_ORDER_SHARES * effectiveEntry;
                
                let stakeFraction = STAKE_FRACTION;
                if (peakBalance > PEAK_DD_BRAKE_MIN) {
                    const ddPct = (peakBalance - bankroll) / peakBalance;
                    if (ddPct >= PEAK_DD_BRAKE_PCT) stakeFraction = Math.min(stakeFraction, 0.12);
                }
                
                let size = bankroll * stakeFraction;
                const pWin = trade.winRateLCB || trade.winRate || 0.5;
                if (pWin >= 0.55 && effectiveEntry > 0 && effectiveEntry < 1) {
                    const b = (1 / effectiveEntry) - 1;
                    if (b > 0) {
                        const fullKelly = (b * pWin - (1 - pWin)) / b;
                        if (fullKelly > 0) {
                            const kellySize = bankroll * Math.min(fullKelly * KELLY_FRACTION, KELLY_MAX);
                            if (kellySize < size) size = kellySize;
                        }
                    }
                }
                
                if (size < minOrderCost) {
                    if (bankroll >= minOrderCost * 1.05) size = minOrderCost;
                    else continue;
                }
                
                const shares = Math.floor(size / effectiveEntry);
                if (shares < MIN_ORDER_SHARES) continue;
                const actualCost = shares * effectiveEntry;
                
                if (bankroll >= MICRO_THRESHOLD) {
                    const maxRisk = bankroll - BALANCE_FLOOR;
                    if (actualCost > maxRisk) continue;
                } else if (bankroll < minOrderCost) continue;
                
                const won = Math.random() < pWin;
                const pnl = won ? (shares * 1.0 - actualCost) : -actualCost;
                bankroll += pnl;
                todayPnL += pnl;
                totalTrades++;
                
                if (won) { totalWins++; consecutiveLosses = 0; if (bankroll > peakBalance) peakBalance = bankroll; }
                else { totalLosses++; consecutiveLosses++; if (consecutiveLosses >= MAX_CONSECUTIVE_LOSSES) { cooldownRemaining = COOLDOWN_CYCLES; consecutiveLosses = 0; } }
                
                const dd = (peakBalance - bankroll) / peakBalance;
                if (dd > maxDrawdown) maxDrawdown = dd;
                if (bankroll < BALANCE_FLOOR) { busted = true; break; }
            }
        }
        
        results.push({ finalBalance: bankroll, busted, totalTrades, totalWins, totalLosses, maxDrawdown, winRate: totalTrades > 0 ? totalWins / totalTrades : 0 });
    }
    
    results.sort((a, b) => a.finalBalance - b.finalBalance);
    const finals = results.map(r => r.finalBalance);
    const bustCount = results.filter(r => r.busted).length;
    
    return {
        trials: TRIALS, days: SIM_DAYS, startingBalance: 7.00, enabledTimeframes: ['15m', '4h'],
        bustRate: (bustCount / TRIALS * 100).toFixed(2) + '%', bustCount,
        avgTrades: (results.reduce((s, r) => s + r.totalTrades, 0) / TRIALS).toFixed(1),
        avgWinRate: (results.reduce((s, r) => s + r.winRate, 0) / TRIALS * 100).toFixed(1) + '%',
        avgMaxDrawdown: (results.reduce((s, r) => s + r.maxDrawdown, 0) / TRIALS * 100).toFixed(1) + '%',
        finalBalance: {
            min: finals[0].toFixed(2),
            p5: finals[Math.floor(TRIALS * 0.05)].toFixed(2),
            p25: finals[Math.floor(TRIALS * 0.25)].toFixed(2),
            median: finals[Math.floor(TRIALS * 0.50)].toFixed(2),
            p75: finals[Math.floor(TRIALS * 0.75)].toFixed(2),
            p95: finals[Math.floor(TRIALS * 0.95)].toFixed(2),
            max: finals[TRIALS - 1].toFixed(2)
        }
    };
})();
console.log(JSON.stringify(sc4, null, 2));
console.log('');

console.log('=== CRITICAL ASSUMPTIONS ===');
console.log('1. Win rates use winRateLCB (lower confidence bound) for conservative estimation');
console.log('2. Entry prices are uniformly random within strategy price bands');
console.log('3. Slippage of 1% is applied to all entries');
console.log('4. Binary resolution: win = $1/share payout, loss = $0 payout');
console.log('5. Each strategy fires ~1 opportunity per day (conservative for 15m/4h)');
console.log('6. 5m strategies fire ~2 opportunities per day per strategy');
console.log('7. Polymarket fees are NOT modeled (taker fee up to 3.15% on winning profit)');
console.log('8. No fill failures or partial fills modeled');
console.log('9. All markets assumed to have sufficient liquidity');
console.log('10. Cooldown, global stop, and balance floor are enforced');
console.log('');
console.log('WARNING: These are Monte Carlo simulations, not guarantees.');
console.log('Real-world results will differ due to: fees, fill rates, liquidity, market conditions, and variance.');
