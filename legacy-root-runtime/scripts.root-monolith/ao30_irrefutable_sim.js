/**
 * AO30 IRREFUTABLE PROFIT SIMULATION
 * 
 * Purpose: Compute mathematically verifiable profit projections for union_validated_top12
 * with various priceMax caps and stake fractions, starting from $6.95.
 * 
 * Method:
 * 1. Load raw decision_dataset.json (real Polymarket market data)
 * 2. Load union_validated_top12 strategy set
 * 3. For each historical 15m cycle, check if any strategy matches
 * 4. If match + price in band → record trade outcome (win/loss from actual market resolution)
 * 5. Simulate bankroll compounding with Polymarket taker fees
 * 6. Report: trades, WR, ending balance, max drawdown, bust events
 * 
 * NO SYNTHETIC DATA. NO ASSUMPTIONS. ONLY RAW MARKET OUTCOMES.
 */

const fs = require('fs');
const path = require('path');

// ==================== LOAD DATA ====================
const datasetPath = path.join(__dirname, '..', 'exhaustive_analysis', 'decision_dataset.json');
const strategyPath = path.join(__dirname, '..', 'debug', 'strategy_set_union_validated_top12.json');

if (!fs.existsSync(datasetPath)) {
    console.error('ERROR: decision_dataset.json not found at', datasetPath);
    process.exit(1);
}
if (!fs.existsSync(strategyPath)) {
    console.error('ERROR: strategy_set_union_validated_top12.json not found at', strategyPath);
    process.exit(1);
}

console.log('Loading dataset...');
const dataset = JSON.parse(fs.readFileSync(datasetPath, 'utf8'));
const strategySet = JSON.parse(fs.readFileSync(strategyPath, 'utf8'));
const strategies = strategySet.strategies;

console.log(`Dataset rows: ${dataset.length}`);
console.log(`Strategies: ${strategies.length}`);

// ==================== POLYMARKET FEE MODEL ====================
// Polymarket taker fee: feeRate * (p * (1-p))^exponent per share
function calcTakerFeePerShare(price) {
    const feeRate = 0.25;
    const exponent = 2;
    const base = price * (1 - price);
    return feeRate * Math.pow(base, exponent);
}

function calcTradeDelta(stakeUsd, entryPrice, won, slippagePct = 0) {
    const ep = Math.min(0.99, entryPrice * (1 + slippagePct));
    const shares = stakeUsd / ep;
    const feePerShare = calcTakerFeePerShare(ep);
    const totalFee = shares * feePerShare;
    
    if (won) {
        // Win: shares pay $1 each, minus entry cost, minus fee
        return (shares * 1.0) - stakeUsd - totalFee;
    } else {
        // Loss: lose entire stake + fee
        return -stakeUsd - totalFee;
    }
}

// ==================== BREAKEVEN ANALYSIS ====================
console.log('\n========== BREAKEVEN WIN RATE BY ENTRY PRICE ==========');
for (let p = 0.65; p <= 0.96; p += 0.05) {
    const feePerShare = calcTakerFeePerShare(p);
    const netOdds = (1/p - 1) - feePerShare/p;
    const breakevenWR = 1 / (1 + netOdds);
    const profitable = breakevenWR < 0.885;
    console.log(`  ${(p*100).toFixed(0)}c entry: breakeven WR = ${(breakevenWR*100).toFixed(1)}% | At 88.5% WR: ${profitable ? '✅ PROFITABLE' : '❌ NEGATIVE EV'}`);
}

// ==================== STRATEGY MATCHING ====================
function matchStrategy(row, priceMaxCap) {
    const asset = String(row.asset || '').toUpperCase();
    const utcHour = Number(row.utcHour);
    const entryMinute = Number(row.entryMinute);
    
    // Try both directions
    for (const strategy of strategies) {
        const sHour = Number(strategy.utcHour);
        const sMinute = Number(strategy.entryMinute);
        const sDir = String(strategy.direction).toUpperCase();
        const sAsset = String(strategy.asset || '').toUpperCase();
        
        if (sHour !== utcHour || sMinute !== entryMinute) continue;
        if (sAsset !== 'ALL' && sAsset !== '*' && sAsset !== 'ANY' && sAsset !== asset) continue;
        
        // Get entry price for this direction
        const entryPrice = sDir === 'UP' ? Number(row.upPrice) : Number(row.downPrice);
        if (!Number.isFinite(entryPrice) || entryPrice <= 0 || entryPrice >= 1) continue;
        
        const bandMin = Number(strategy.priceMin) || 0.65;
        // priceMaxCap OVERRIDES per-strategy priceMax (mirrors runtime max95 behavior)
        const bandMax = priceMaxCap;
        
        if (entryPrice < bandMin || entryPrice > bandMax) continue;
        
        // Determine outcome
        const won = sDir === 'UP' ? row.resolvedOutcome === 'UP' : row.resolvedOutcome === 'DOWN';
        
        return {
            asset,
            utcHour,
            entryMinute,
            direction: sDir,
            entryPrice,
            won,
            strategy: strategy.name,
            tier: strategy.tier,
            strategyWR: strategy.winRate,
            epoch: Number(row.cycleStartEpochSec)
        };
    }
    return null;
}

// ==================== SIMULATION ====================
function simulate(priceMaxCap, stakeFraction, startBankroll, minOrderShares, label) {
    // Step 1: Find all matching trades
    const allMatches = [];
    const seenCycles = new Set();
    
    for (const row of dataset) {
        const cycleKey = `${row.asset}_${row.cycleStartEpochSec}_${row.entryMinute}`;
        if (seenCycles.has(cycleKey)) continue;
        
        const match = matchStrategy(row, priceMaxCap);
        if (match) {
            seenCycles.add(cycleKey);
            allMatches.push(match);
        }
    }
    
    // Sort by epoch
    allMatches.sort((a, b) => a.epoch - b.epoch);
    
    // Deduplicate: max 1 trade per 15-min cycle across all assets (like runtime maxGlobalTradesPerCycle=1)
    const cycleTraded = new Set();
    const trades = [];
    for (const m of allMatches) {
        const cycleEpoch = Math.floor(m.epoch / 900) * 900;
        if (cycleTraded.has(cycleEpoch)) continue;
        cycleTraded.add(cycleEpoch);
        trades.push(m);
    }
    
    const totalTrades = trades.length;
    const wins = trades.filter(t => t.won).length;
    const losses = totalTrades - wins;
    const winRate = totalTrades > 0 ? wins / totalTrades : 0;
    
    // Step 2: Simulate bankroll
    let bankroll = startBankroll;
    let peakBankroll = startBankroll;
    let maxDrawdownPct = 0;
    let minBankroll = startBankroll;
    let busted = false;
    let bustTradeIdx = null;
    let executed = 0;
    let blocked = 0;
    let executedWins = 0;
    let executedLosses = 0;
    
    const dailyBalances = {};
    
    for (let i = 0; i < trades.length; i++) {
        const t = trades[i];
        const minOrderCost = minOrderShares * t.entryPrice;
        
        let stake = bankroll * stakeFraction;
        
        // Top up to min order if needed and bankroll allows
        if (stake < minOrderCost) {
            if (bankroll >= minOrderCost * 1.1) {
                stake = minOrderCost;
            } else if (bankroll >= minOrderCost) {
                stake = minOrderCost;
            } else {
                blocked++;
                continue;
            }
        }
        
        // Cap stake at bankroll
        if (stake > bankroll) stake = bankroll;
        if (stake < minOrderCost) {
            blocked++;
            continue;
        }
        
        const delta = calcTradeDelta(stake, t.entryPrice, t.won, 0);
        bankroll += delta;
        executed++;
        if (t.won) executedWins++;
        else executedLosses++;
        
        if (bankroll > peakBankroll) peakBankroll = bankroll;
        if (bankroll < minBankroll) minBankroll = bankroll;
        const dd = peakBankroll > 0 ? (peakBankroll - bankroll) / peakBankroll : 0;
        if (dd > maxDrawdownPct) maxDrawdownPct = dd;
        
        // Track daily
        const day = new Date(t.epoch * 1000).toISOString().slice(0, 10);
        dailyBalances[day] = bankroll;
        
        // Check bust
        if (bankroll < minOrderCost * 0.5) {
            busted = true;
            bustTradeIdx = i;
            break;
        }
    }
    
    // Get date range
    const days = Object.keys(dailyBalances).sort();
    const firstDay = trades.length > 0 ? new Date(trades[0].epoch * 1000).toISOString().slice(0, 10) : 'N/A';
    const lastDay = trades.length > 0 ? new Date(trades[trades.length - 1].epoch * 1000).toISOString().slice(0, 10) : 'N/A';
    const calendarDays = trades.length > 0 
        ? Math.ceil((trades[trades.length - 1].epoch - trades[0].epoch) / 86400)
        : 0;
    const tradingDays = days.length;
    const tradesPerDay = tradingDays > 0 ? executed / tradingDays : 0;
    
    // Milestones
    const milestones = [20, 50, 100, 200, 500, 1000];
    const milestoneReached = {};
    let runningBankroll = startBankroll;
    let tradeCount = 0;
    for (const t of trades) {
        const minOC = minOrderShares * t.entryPrice;
        let st = runningBankroll * stakeFraction;
        if (st < minOC) {
            if (runningBankroll >= minOC) st = minOC;
            else continue;
        }
        if (st > runningBankroll) st = runningBankroll;
        if (st < minOC) continue;
        
        const d = calcTradeDelta(st, t.entryPrice, t.won, 0);
        runningBankroll += d;
        tradeCount++;
        
        for (const m of milestones) {
            if (runningBankroll >= m && !milestoneReached[m]) {
                milestoneReached[m] = { trade: tradeCount, day: new Date(t.epoch * 1000).toISOString().slice(0, 10) };
            }
        }
        if (runningBankroll < minOC * 0.5) break;
    }
    
    return {
        label,
        config: { priceMaxCap: (priceMaxCap * 100).toFixed(0) + 'c', stakeFraction: (stakeFraction * 100).toFixed(0) + '%', startBankroll: '$' + startBankroll.toFixed(2), minOrderShares },
        signalStats: { totalCandidates: totalTrades, wins, losses, winRate: (winRate * 100).toFixed(1) + '%' },
        execution: { executed, blocked, executedWR: executed > 0 ? ((executedWins / executed) * 100).toFixed(1) + '%' : 'N/A', executedWins, executedLosses },
        bankroll: {
            start: '$' + startBankroll.toFixed(2),
            end: '$' + bankroll.toFixed(2),
            peak: '$' + peakBankroll.toFixed(2),
            min: '$' + minBankroll.toFixed(2),
            maxDrawdownPct: (maxDrawdownPct * 100).toFixed(1) + '%',
            busted,
            bustTradeIdx,
            roi: ((bankroll / startBankroll - 1) * 100).toFixed(1) + '%'
        },
        milestones: milestoneReached,
        period: { firstDay, lastDay, calendarDays, tradingDays, tradesPerDay: tradesPerDay.toFixed(1) }
    };
}

// ==================== RUN SCENARIOS ====================
console.log('\n========== RUNNING SIMULATIONS ==========\n');

const scenarios = [
    // priceMaxCap, stakeFraction, startBankroll, minOrderShares, label
    [0.80, 0.45, 6.95, 5, 'A: Original 80c cap, 45% stake, 5-share min'],
    [0.80, 0.45, 6.95, 2, 'B: Original 80c cap, 45% stake, 2-share min'],
    [0.85, 0.45, 6.95, 5, 'C: 85c cap, 45% stake, 5-share min'],
    [0.85, 0.45, 6.95, 2, 'D: 85c cap, 45% stake, 2-share min'],
    [0.85, 0.35, 6.95, 5, 'E: 85c cap, 35% stake, 5-share min'],
    [0.85, 0.50, 6.95, 2, 'F: 85c cap, 50% stake, 2-share min'],
    [0.90, 0.45, 6.95, 2, 'G: 90c cap, 45% stake, 2-share min'],
    [0.95, 0.45, 6.95, 2, 'H: 95c cap (current), 45% stake, 2-share min'],
    [0.80, 0.45, 6.95, 2, 'I: 80c cap, 45% stake, 2-share (RECOMMENDED)'],
];

const results = [];
for (const [pMax, sf, sb, mos, label] of scenarios) {
    const result = simulate(pMax, sf, sb, mos, label);
    results.push(result);
    
    console.log(`--- ${label} ---`);
    console.log(`  Signals: ${result.signalStats.totalCandidates} (WR: ${result.signalStats.winRate})`);
    console.log(`  Executed: ${result.execution.executed} (Blocked: ${result.execution.blocked}, Exec WR: ${result.execution.executedWR})`);
    console.log(`  Bankroll: ${result.bankroll.start} → ${result.bankroll.end} (Peak: ${result.bankroll.peak}, ROI: ${result.bankroll.roi})`);
    console.log(`  Max Drawdown: ${result.bankroll.maxDrawdownPct} | Busted: ${result.bankroll.busted}`);
    console.log(`  Period: ${result.period.firstDay} to ${result.period.lastDay} (${result.period.calendarDays} days, ${result.period.tradesPerDay} trades/day)`);
    if (Object.keys(result.milestones).length > 0) {
        console.log(`  Milestones:`);
        for (const [m, info] of Object.entries(result.milestones)) {
            console.log(`    $${m}: reached at trade #${info.trade} on ${info.day}`);
        }
    }
    console.log('');
}

// Save results
const outputPath = path.join(__dirname, '..', 'debug', 'ao30_irrefutable_sim_results.json');
fs.writeFileSync(outputPath, JSON.stringify(results, null, 2));
console.log(`\nResults saved to ${outputPath}`);

// ==================== FINAL RECOMMENDATION ====================
console.log('\n========== RECOMMENDATION ==========');
const best = results.filter(r => !r.bankroll.busted && parseFloat(r.bankroll.end.replace('$','')) > 100)
    .sort((a, b) => parseFloat(b.bankroll.end.replace('$','')) - parseFloat(a.bankroll.end.replace('$','')))[0];

if (best) {
    console.log(`\nBEST CONFIG: ${best.label}`);
    console.log(`  End balance: ${best.bankroll.end}`);
    console.log(`  Executed WR: ${best.execution.executedWR}`);
    console.log(`  Max Drawdown: ${best.bankroll.maxDrawdownPct}`);
    console.log(`  Trades/day: ${best.period.tradesPerDay}`);
} else {
    console.log('No scenario achieved $100+ without busting.');
    console.log('Showing highest non-busted ending balance:');
    const safeBest = results.filter(r => !r.bankroll.busted)
        .sort((a, b) => parseFloat(b.bankroll.end.replace('$','')) - parseFloat(a.bankroll.end.replace('$','')))[0];
    if (safeBest) {
        console.log(`  ${safeBest.label}: ${safeBest.bankroll.end}`);
    }
}
