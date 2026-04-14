#!/usr/bin/env node
/**
 * Monte Carlo bankroll simulator at $5 starting balance.
 * Matches LIVE runtime constraints:
 *   - 5-share minimum order
 *   - 15% stake fraction (overridden by min order when needed)
 *   - 3.15% taker fee on winning profit
 *   - MAX_GLOBAL_TRADES_PER_CYCLE = 1
 *   - Strategy selection by highest pWinEstimate
 * Outputs: bust rate, median final bankroll, P25/P75, first-trade loss rate, 
 *          expected value of starting with $5
 */
const fs = require('fs');
const path = require('path');

const STARTING_BALANCE = 5;
const STAKE_FRACTION = 0.15;
const FEE_RATE = 0.0315;
const MIN_ORDER_SHARES = 5;
const MAX_PER_CYCLE = 1;
const CYCLES_PER_DAY = 96; // 24h * 4 (15m cycles)
const SIM_DAYS = 14;
const TOTAL_CYCLES = CYCLES_PER_DAY * SIM_DAYS;
const NUM_SIMS = 10000;
const BUST_THRESHOLD = 0.50; // hard bust (near zero)
const MAX_BANKROLL_CAP = 100000; // cap bankroll growth to avoid unrealistic numbers

function loadStrategySet(filePath) {
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return (raw.strategies || []).map(s => {
        // Compute effective win rate and avg entry price
        let wr = s.pWinEstimate || s.winRate || 0;
        let avgPrice = null;
        
        if (s.recentStats) {
            if (s.recentStats.avgPrice) avgPrice = s.recentStats.avgPrice;
            else if (s.recentStats.last14d?.avgPrice) avgPrice = s.recentStats.last14d.avgPrice;
            else if (s.recentStats.last72h?.avgPrice) avgPrice = s.recentStats.last72h.avgPrice;
        }
        if (s.metrics?.recent?.avgEntry) avgPrice = s.metrics.recent.avgEntry;
        
        // Fallback: midpoint of price range
        if (!avgPrice && s.priceMin && s.priceMax) {
            avgPrice = (s.priceMin + s.priceMax) / 2;
        }
        
        // Use LCB as conservative WR if available
        let conservativeWR = wr;
        if (s.recentStats?.lcb && s.recentStats.lcb > 0) conservativeWR = s.recentStats.lcb;
        else if (s.winRateLCB && s.winRateLCB > 0) conservativeWR = s.winRateLCB;
        else if (s.metrics?.recent?.lcb) conservativeWR = s.metrics.recent.lcb;
        
        // Match frequency: how many cycles per day does this strategy fire?
        // With asset=ALL and 4 assets, each strategy fires 4 times per day (once per 15m cycle at its utcHour)
        // But only one asset will match price-band at any given time typically
        // Conservative: assume 1 match per day per strategy hour slot
        const matchesPerDay = 1;
        
        return {
            name: s.name,
            utcHour: s.utcHour,
            entryMinute: s.entryMinute,
            direction: s.direction,
            priceMin: s.priceMin,
            priceMax: s.priceMax,
            pWin: wr,
            conservativeWR,
            avgPrice: avgPrice || 0.75,
            cost5Shares: (avgPrice || 0.75) * MIN_ORDER_SHARES,
            matchesPerDay
        };
    });
}

function simulateBankroll(strategies, startBalance, numCycles, rng) {
    let bankroll = startBalance;
    let trades = 0;
    let wins = 0;
    let maxBankroll = startBalance;
    let maxDrawdown = 0;
    let firstTradeLost = null;
    let stuckCycles = 0; // cycles where we wanted to trade but couldn't
    
    // Sort strategies by pWin descending (runtime priority)
    const sorted = [...strategies].sort((a, b) => b.pWin - a.pWin);
    
    // Compute cheapest possible trade in this set
    const cheapestTrade = Math.min(...strategies.map(s => s.cost5Shares));
    
    // Simulate each cycle
    for (let cycle = 0; cycle < numCycles; cycle++) {
        const cycleHour = cycle % 24;
        
        // Find matching strategies for this hour
        const candidates = sorted.filter(s => s.utcHour === cycleHour);
        if (candidates.length === 0) continue;
        
        // Pick the best candidate (highest pWin) - runtime behavior
        const candidate = candidates[0];
        
        // Calculate trade cost
        const cost = candidate.cost5Shares;
        
        // Can we afford it?
        if (bankroll < cost) {
            stuckCycles++;
            continue;
        }
        
        // Risk manager: stakeFraction sizing
        let size = bankroll * STAKE_FRACTION;
        let shares;
        if (size < cost) {
            // Minimum order override
            if (bankroll >= cost) {
                size = cost;
                shares = MIN_ORDER_SHARES;
            } else {
                stuckCycles++;
                continue;
            }
        } else {
            // Use stake fraction, round to whole shares
            shares = Math.max(MIN_ORDER_SHARES, Math.floor(size / candidate.avgPrice));
            size = shares * candidate.avgPrice;
        }
        
        // Cap bankroll growth for realism
        if (bankroll > MAX_BANKROLL_CAP) {
            bankroll = MAX_BANKROLL_CAP;
        }
        
        // Execute trade
        const win = rng() < candidate.pWin;
        trades++;
        
        if (win) {
            wins++;
            const payout = shares * 1.0;
            const profit = payout - size;
            const fee = profit * FEE_RATE;
            bankroll += (profit - fee);
        } else {
            bankroll -= size;
        }
        
        if (firstTradeLost === null) {
            firstTradeLost = !win;
        }
        
        maxBankroll = Math.max(maxBankroll, bankroll);
        const dd = maxBankroll > 0 ? (maxBankroll - bankroll) / maxBankroll : 0;
        maxDrawdown = Math.max(maxDrawdown, dd);
        
        // Check hard bust
        if (bankroll < BUST_THRESHOLD) {
            return { bankroll: 0, busted: true, effectiveBust: true, trades, wins, maxDrawdown, firstTradeLost, stuckCycles };
        }
    }
    
    // Effective bust: alive but can't afford any trade
    const effectiveBust = bankroll < cheapestTrade;
    
    return { bankroll, busted: false, effectiveBust, trades, wins, maxDrawdown, firstTradeLost, stuckCycles };
}

// Seeded PRNG for reproducibility
function mulberry32(a) {
    return function() {
        a |= 0; a = a + 0x6D2B79F5 | 0;
        let t = Math.imul(a ^ a >>> 15, 1 | a);
        t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
        return ((t ^ t >>> 14) >>> 0) / 4294967296;
    }
}

function percentile(arr, p) {
    const sorted = [...arr].sort((a, b) => a - b);
    const idx = Math.floor(sorted.length * p);
    return sorted[Math.min(idx, sorted.length - 1)];
}

function runSimulation(label, strategies) {
    const results = [];
    const rng = mulberry32(42);
    
    for (let i = 0; i < NUM_SIMS; i++) {
        results.push(simulateBankroll(strategies, STARTING_BALANCE, TOTAL_CYCLES, rng));
    }
    
    const hardBusted = results.filter(r => r.busted).length;
    const effectBusted = results.filter(r => r.effectiveBust).length;
    const alive = results.filter(r => !r.effectiveBust);
    const finals = results.map(r => r.bankroll);
    const firstTradeLosses = results.filter(r => r.firstTradeLost === true).length;
    const firstTrades = results.filter(r => r.firstTradeLost !== null).length;
    
    const hardBustRate = hardBusted / results.length;
    const effectiveBustRate = effectBusted / results.length;
    const medianFinal = percentile(finals, 0.5);
    const p25Final = percentile(finals, 0.25);
    const p75Final = percentile(finals, 0.75);
    const p90Final = percentile(finals, 0.9);
    const meanFinal = finals.reduce((a, b) => a + b, 0) / finals.length;
    const aliveMedian = alive.length > 0 ? percentile(alive.map(r => r.bankroll), 0.5) : 0;
    const avgTrades = results.reduce((a, r) => a + r.trades, 0) / results.length;
    const avgWR = results.reduce((a, r) => a + (r.trades > 0 ? r.wins / r.trades : 0), 0) / results.length;
    const cheapest = Math.min(...strategies.map(s => s.cost5Shares));
    
    console.log(`\n${'═'.repeat(65)}`);
    console.log(`  ${label}`);
    console.log(`  Strategies: ${strategies.length} | Avg Entry: ${(strategies.reduce((a,s) => a + s.avgPrice, 0) / strategies.length * 100).toFixed(1)}¢ | Cheapest Trade: $${cheapest.toFixed(2)}`);
    console.log(`  Avg pWin: ${(strategies.reduce((a,s) => a + s.pWin, 0) / strategies.length * 100).toFixed(1)}%`);
    console.log(`${'═'.repeat(65)}`);
    console.log(`  Hard Bust Rate:       ${(hardBustRate * 100).toFixed(1)}% (bankroll < $0.50)`);
    console.log(`  ▶ EFFECTIVE BUST:     ${(effectiveBustRate * 100).toFixed(1)}% (can't afford ANY trade)`);
    console.log(`  First-Trade Loss:     ${firstTrades > 0 ? ((firstTradeLosses / firstTrades * 100).toFixed(1) + '%') : 'N/A'}`);
    console.log(`  Mean Final Bankroll:  $${meanFinal.toFixed(2)}`);
    console.log(`  Median Final:         $${medianFinal.toFixed(2)}`);
    console.log(`  P25 / P75 / P90:     $${p25Final.toFixed(2)} / $${p75Final.toFixed(2)} / $${p90Final.toFixed(2)}`);
    console.log(`  Alive Median (surv):  $${aliveMedian.toFixed(2)}`);
    console.log(`  Avg Trades/Sim:       ${avgTrades.toFixed(1)}`);
    console.log(`  Avg Realized WR:      ${(avgWR * 100).toFixed(1)}%`);
    console.log(`  EV of $5 deposit:     $${(meanFinal - STARTING_BALANCE).toFixed(2)}`);
    console.log(`${'─'.repeat(65)}`);
    
    return { label, hardBustRate, effectiveBustRate, medianFinal, meanFinal, p25Final, p75Final, p90Final, aliveMedian, avgTrades };
}

// Also run with conservative (LCB) win rates
function runConservativeSimulation(label, strategies) {
    // Swap pWin for conservativeWR
    const conservative = strategies.map(s => ({ ...s, pWin: s.conservativeWR }));
    return runSimulation(label + ' [LCB-conservative]', conservative);
}

// ─── Main ───────────────────────────────────────────────────────
const strategiesDir = path.join(__dirname, '..', 'strategies');

const sets = [
    { file: 'strategy_set_15m_elite_recency.json', label: 'Elite Recency (12 strats, deployed)' },
    { file: 'strategy_set_15m_beam_2739_uncapped.json', label: 'Beam 2739 Uncapped (7 strats)' },
    { file: 'strategy_set_15m_beam11_zero_bust.json', label: 'Beam11 Zero-Bust (11 strats)' },
    { file: 'strategy_set_15m_recency_optimized.json', label: 'Recency Optimized (21 strats)' },
    { file: 'strategy_set_15m_recent_lowprice_top10.json', label: 'Recent Low-Price Top10 (10 strats)' },
    { file: 'strategy_set_15m_recent_lowprice_micro3.json', label: 'Recent Low-Price Micro3 (3 strats)' },
    { file: 'strategy_set_15m_top8.json', label: 'Original Top8 (8 strats)' },
    { file: 'strategy_set_15m_cherry_picked_high_wr.json', label: 'Cherry-Picked High WR' },
];

console.log(`\n🎯 POLYPROPHET Monte Carlo Bankroll Simulation`);
console.log(`   Starting Balance: $${STARTING_BALANCE}`);
console.log(`   Stake Fraction: ${STAKE_FRACTION * 100}% | Fee: ${FEE_RATE * 100}% | Min Shares: ${MIN_ORDER_SHARES}`);
console.log(`   Sim Duration: ${SIM_DAYS}d (${TOTAL_CYCLES} cycles) | Runs: ${NUM_SIMS}`);

const allResults = [];

for (const { file, label } of sets) {
    const filePath = path.join(strategiesDir, file);
    if (!fs.existsSync(filePath)) {
        console.log(`\n⚠️  Skipping ${file} — not found`);
        continue;
    }
    const strategies = loadStrategySet(filePath);
    if (strategies.length === 0) {
        console.log(`\n⚠️  Skipping ${file} — no strategies`);
        continue;
    }
    const result = runSimulation(label, strategies);
    allResults.push(result);
}

// Run conservative (LCB) version of the deployed set
const elitePath = path.join(strategiesDir, 'strategy_set_15m_elite_recency.json');
if (fs.existsSync(elitePath)) {
    const eliteStrats = loadStrategySet(elitePath);
    runConservativeSimulation('Elite Recency', eliteStrats);
}

// ─── Summary Ranking ────────────────────────────────────────────
console.log(`\n\n${'═'.repeat(70)}`);
console.log('  RANKING BY EFFECTIVE BUST RATE (lower = better)');
console.log(`${'═'.repeat(70)}`);
allResults.sort((a, b) => a.effectiveBustRate - b.effectiveBustRate);
for (let i = 0; i < allResults.length; i++) {
    const r = allResults[i];
    console.log(`  ${i + 1}. ${r.label}`);
    console.log(`     EffBust: ${(r.effectiveBustRate * 100).toFixed(1)}% | HardBust: ${(r.hardBustRate * 100).toFixed(1)}% | AliveMedian: $${r.aliveMedian.toFixed(2)} | Mean: $${r.meanFinal.toFixed(2)}`);
}

console.log(`\n${'═'.repeat(70)}`);
console.log('  RANKING BY ALIVE MEDIAN (higher = better, for survivors)');
console.log(`${'═'.repeat(70)}`);
allResults.sort((a, b) => b.aliveMedian - a.aliveMedian);
for (let i = 0; i < allResults.length; i++) {
    const r = allResults[i];
    console.log(`  ${i + 1}. ${r.label}`);
    console.log(`     AliveMedian: $${r.aliveMedian.toFixed(2)} | EffBust: ${(r.effectiveBustRate * 100).toFixed(1)}% | P90: $${r.p90Final.toFixed(2)}`);
}

console.log(`\n${'═'.repeat(70)}`);
console.log('  COMPOSITE SCORE: (1 - EffBustRate) × AliveMedian');
console.log(`${'═'.repeat(70)}`);
const scored = allResults.map(r => ({
    ...r,
    composite: (1 - r.effectiveBustRate) * r.aliveMedian
})).sort((a, b) => b.composite - a.composite);
for (let i = 0; i < scored.length; i++) {
    const r = scored[i];
    console.log(`  ${i + 1}. ${r.label}`);
    console.log(`     Composite: ${r.composite.toFixed(2)} | EffBust: ${(r.effectiveBustRate * 100).toFixed(1)}% | AliveMedian: $${r.aliveMedian.toFixed(2)}`);
}
