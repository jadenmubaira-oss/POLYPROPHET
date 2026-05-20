#!/usr/bin/env node
/**
 * COMPREHENSIVE STRATEGY ANALYSIS - 20 May 2026
 * 
 * Uses fresh 7-day data (May 13-20) + cross-validation vs May 2-9 window
 * Tests current 7-signal strategy + discovers new optimal portfolio
 * Runs full Monte Carlo simulation with proper Kelly sizing
 */

const fs = require('fs');
const path = require('path');

// ===== LOAD FRESH DATA =====
const RAW_DATA_PATH = path.join(__dirname, '../debug/7day_backtest_raw.json');
const ACTIVE_STRATEGY_PATH = path.join(__dirname, '../strategies/strategy_set_15m_crossval_7signal_v2.json');
const MIN_ORDER_SHARES = 5;
const ACTIVE_AVG_PRICES = {
    H19_M30_UP: 0.491,
    H7_M15_UP: 0.472,
    H12_M30_UP: 0.510,
    H12_M15_UP: 0.510,
    H3_M15_UP: 0.493,
    H13_M15_DOWN: 0.480,
    H13_M30_DOWN: 0.480,
};

function loadFreshData() {
    if (!fs.existsSync(RAW_DATA_PATH)) {
        console.error('ERROR: Fresh data not found. Run scripts/fresh_7day_backtest.js first.');
        process.exit(1);
    }
    return JSON.parse(fs.readFileSync(RAW_DATA_PATH, 'utf8'));
}

function loadActiveStrategy() {
    if (!fs.existsSync(ACTIVE_STRATEGY_PATH)) {
        console.error(`ERROR: Active strategy not found: ${ACTIVE_STRATEGY_PATH}`);
        process.exit(1);
    }
    return JSON.parse(fs.readFileSync(ACTIVE_STRATEGY_PATH, 'utf8'));
}

function strategyKey(strategy) {
    return `H${strategy.utcHour}_M${strategy.utcMinute}_${strategy.direction}`;
}

// ===== SIGNAL ANALYSIS =====
// Data format: { epoch, iso, utcHour, utcMinute, asset, outcome: 'UP'|'DOWN', slug, volume }
function analyzeSignals(records, label) {
    const signals = {};
    
    for (const rec of records) {
        if (!rec.outcome || (rec.outcome !== 'UP' && rec.outcome !== 'DOWN')) continue;
        
        const hour = rec.utcHour;
        const minute = rec.utcMinute;
        const roundedMin = Math.floor(minute / 15) * 15;
        
        // Test both UP and DOWN
        for (const dir of ['UP', 'DOWN']) {
            const won = dir === 'UP' ? rec.outcome === 'UP' : rec.outcome === 'DOWN';
            const key = `H${hour}_M${roundedMin}_${dir}`;
            if (!signals[key]) signals[key] = { w: 0, t: 0, hour, minute: roundedMin, dir };
            signals[key].t++;
            if (won) signals[key].w++;
        }
    }
    
    return signals;
}

// ===== KELLY CALCULATION =====
function kellyFraction(pWin, odds = 1.0) {
    // For binary: kelly = (p * (1+odds) - 1) / odds
    // For Polymarket at price p: odds = (1-p)/p, payout = 1/p - 1
    // Kelly fraction of bankroll = pWin - (1-pWin)/((1/price)-1)
    // Simplified for 50c entry: kelly = 2*pWin - 1
    return Math.max(0, Math.min(1, 2 * pWin - 1));
}

// ===== MONTE CARLO SIMULATION =====
function createRng(seed) {
    let state = seed >>> 0;
    return () => {
        state = (1664525 * state + 1013904223) >>> 0;
        return state / 0x100000000;
    };
}

function monteCarlo(signals, startBalance, numTrades, numRuns = 50000, slippage = 0.015, seed = 20260520) {
    const random = createRng(seed);
    const results = [];
    
    // Build trade schedule (signals fire at their times, cycling through days)
    const tradeSchedule = signals.map(s => ({
        pWin: s.pWin,
        price: s.avgPrice || s.price || 0.50,
        stakeFraction: Math.min(s.stakeF, 0.60), // bootstrap cap
        name: s.key
    }));
    
    if (tradeSchedule.length === 0 || numTrades === 0) return { median: 0, p10: 0, p25: 0, p75: 0, p90: 0, bustRate: 1.0, nonBustMedian: 0 };
    
    for (let run = 0; run < numRuns; run++) {
        let balance = startBalance;
        let bust = false;
        
        for (let t = 0; t < numTrades; t++) {
            const trade = tradeSchedule[t % tradeSchedule.length];
            const effectivePrice = Math.min(0.85, trade.price + slippage);
            const minOrderCost = MIN_ORDER_SHARES * effectivePrice;
            let actualStake = balance * trade.stakeFraction;
            if (actualStake < minOrderCost) actualStake = minOrderCost;
            
            if (actualStake > balance) { bust = true; break; }
            
            const win = random() < trade.pWin;
            if (win) {
                // Win: get stake back + profit at price p: profit = stake * (1/price - 1)
                balance += actualStake * (1 / effectivePrice - 1);
            } else {
                balance -= actualStake;
            }
        }
        
        results.push(bust ? 0 : balance);
    }
    
    results.sort((a, b) => a - b);
    const bustRate = results.filter(r => r === 0).length / numRuns;
    const nonBust = results.filter(r => r > 0);
    
    return {
        median: results[Math.floor(numRuns * 0.5)],
        p10: results[Math.floor(numRuns * 0.1)],
        p25: results[Math.floor(numRuns * 0.25)],
        p75: results[Math.floor(numRuns * 0.75)],
        p90: results[Math.floor(numRuns * 0.9)],
        bustRate,
        nonBustMedian: nonBust.length > 0 ? nonBust[Math.floor(nonBust.length * 0.5)] : 0
    };
}

// ===== CROSS-VALIDATION: Fetch May 2-9 data =====
async function fetchMay2to9Data() {
    const cacheFile = path.join(__dirname, '../debug/may2_9_backtest_raw.json');
    if (fs.existsSync(cacheFile)) {
        console.log('Using cached May 2-9 data...');
        return JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
    }
    
    console.log('Fetching May 2-9 cross-validation data from Polymarket API...');
    const assets = ['BTC', 'ETH', 'SOL', 'XRP'];
    const allRecords = [];
    
    // Use the same approach as fresh_7day_backtest.js but for May 2-9
    const start = new Date('2026-05-02T00:00:00Z');
    const end = new Date('2026-05-09T23:59:59Z');
    
    // Build cycle list
    const TIMEFRAME_SECONDS = 15 * 60;
    const cycles = [];
    let t = Math.floor(start.getTime() / 1000 / TIMEFRAME_SECONDS) * TIMEFRAME_SECONDS;
    const endTs = Math.floor(end.getTime() / 1000);
    while (t <= endTs) {
        cycles.push(t);
        t += TIMEFRAME_SECONDS;
    }
    
    const ASSET_SLUGS = {
        BTC: 'will-btc-price-increase-in-the-next-15-minutes',
        ETH: 'will-eth-price-increase-in-the-next-15-minutes',
        SOL: 'will-sol-price-increase-in-the-next-15-minutes',
        XRP: 'will-xrp-price-increase-in-the-next-15-minutes',
    };
    
    // Sample from the API
    let fetched = 0;
    for (let i = 0; i < cycles.length; i += 4) { // sample every 4th cycle = ~25% of data
        const cycleTs = cycles[i];
        const cycleDate = new Date(cycleTs * 1000).toISOString();
        
        for (const asset of assets) {
            const slug = ASSET_SLUGS[asset];
            if (!slug) continue;
            
            const cycleStart = new Date(cycleTs * 1000);
            const h = cycleStart.getUTCHours();
            const m = cycleStart.getUTCMinutes();
            
            // Build approximate market slug
            const dateStr = cycleStart.toISOString().split('T')[0].replace(/-/g, '');
            const baseSlug = `${slug}-${dateStr}-${String(h).padStart(2,'0')}${String(m).padStart(2,'0')}`;
            
            try {
                const url = `https://gamma-api.polymarket.com/markets?slug=${encodeURIComponent(baseSlug)}&limit=1`;
                const resp = await fetch(url, { signal: AbortSignal.timeout(5000) });
                if (!resp.ok) continue;
                const data = await resp.json();
                const markets = Array.isArray(data) ? data : (data.markets || data.results || []);
                
                for (const mkt of markets) {
                    if (!mkt.resolved) continue;
                    const outTokens = mkt.outcomePrices || mkt.tokens || [];
                    let upPrice = null, outcome = null;
                    
                    if (Array.isArray(outTokens)) {
                        if (outTokens[0]?.price !== undefined) {
                            upPrice = parseFloat(outTokens[0].price);
                            outcome = upPrice > 0.5 ? 'UP' : 'DOWN';
                        }
                    }
                    
                    if (outcome) {
                        allRecords.push({
                            asset,
                            cycleStart: cycleStart.toISOString(),
                            outcome,
                            upPrice,
                            slug: mkt.slug
                        });
                    }
                }
                fetched++;
            } catch (e) {
                // skip
            }
        }
        
        if (i % 100 === 0) process.stdout.write(`  May2-9 fetched: ${i}/${cycles.length}\r`);
    }
    console.log(`\nMay 2-9 data: ${allRecords.length} records`);
    fs.writeFileSync(cacheFile, JSON.stringify(allRecords));
    return allRecords;
}

// ===== MAIN ANALYSIS =====
async function main() {
    console.log('\n====================================================');
    console.log('  COMPREHENSIVE STRATEGY ANALYSIS — 20 May 2026');
    console.log('====================================================\n');
    
    const START_BALANCE = 7.93;
    const TRADES_7DAY = 49; // 7 signals × 7 days
    const TRADES_14DAY = 98;
    
    // Load fresh 7-day data (May 13-20)
    console.log('Loading fresh May 13-20 data...');
    const freshData = loadFreshData();
    console.log(`Loaded ${freshData.length} records\n`);
    const activeStrategyFile = loadActiveStrategy();
    const activeStrategies = Array.isArray(activeStrategyFile.strategies) ? activeStrategyFile.strategies : [];
    const activeKeySet = new Set(activeStrategies.map(strategyKey));
    
    // Analyze all signal win rates
    const freshSignals = analyzeSignals(freshData, 'May13-20');
    
    // Sort by win rate
    const sortedSignals = Object.entries(freshSignals)
        .filter(([k, v]) => v.t >= 28) // need at least 28 samples (covers all assets × half the days)
        .map(([k, v]) => ({ key: k, ...v, wr: v.w / v.t }))
        .sort((a, b) => b.wr - a.wr);
    
    console.log('=== TOP 30 SIGNALS BY WIN RATE (May 13-20, n>=28) ===');
    console.log('Key                  | WR%   | W/T  | Kelly | StakeCap');
    console.log('---------------------|-------|------|-------|--------');
    for (const s of sortedSignals.slice(0, 30)) {
        const kelly = kellyFraction(s.wr) * 0.75; // 75% of full Kelly
        const stakeStr = (kelly * 100).toFixed(0) + '%';
        console.log(`${s.key.padEnd(21)}| ${(s.wr*100).toFixed(1).padStart(5)}% | ${s.w}/${s.t} | ${(kelly*100).toFixed(0).padStart(4)}% | ${stakeStr}`);
    }
    
    // ===== TEST ACTIVE DEPLOYED 7-SIGNAL STRATEGY =====
    console.log('\n=== ACTIVE DEPLOYED 7-SIGNAL STRATEGY (May 13-20 WRs + cross-val pWin) ===');
    const currentSignalKeys = activeStrategies.map(strategy => {
        const key = strategyKey(strategy);
        return {
            key,
            name: `H${strategy.utcHour}:${String(strategy.utcMinute).padStart(2, '0')} ${strategy.direction}`,
            avgPrice: ACTIVE_AVG_PRICES[key] || ((Number(strategy.priceMin) + Number(strategy.priceMax)) / 2) || 0.50,
            pWinEstimate: Number(strategy.pWinEstimate),
        };
    });
    
    const currentPortfolio = [];
    let currentTotalW = 0, currentTotalT = 0;
    for (const sig of currentSignalKeys) {
        const data = freshSignals[sig.key];
        if (!data) {
            console.log(`${sig.name}: NO DATA`);
            continue;
        }
        const freshWr = data.w / data.t;
        const pWin = Number.isFinite(sig.pWinEstimate) ? sig.pWinEstimate : freshWr;
        const kelly = kellyFraction(pWin) * 0.75;
        const stakeF = Math.min(kelly, 0.60); // bootstrap cap
        currentTotalW += data.w;
        currentTotalT += data.t;
        console.log(`  ${sig.name}: fresh ${(freshWr*100).toFixed(1)}% WR (${data.w}/${data.t}), cross-val pWin=${(pWin*100).toFixed(1)}% — Kelly=${(kelly*100).toFixed(0)}%, Stake=${(stakeF*100).toFixed(0)}%`);
        currentPortfolio.push({ key: sig.key, pWin, freshWr, avgPrice: sig.avgPrice, stakeF });
    }
    const currentCombinedWR = currentTotalW / currentTotalT;
    console.log(`  COMBINED: ${(currentCombinedWR*100).toFixed(1)}% WR (${currentTotalW}/${currentTotalT})`);
    
    // ===== BUILD IN-SAMPLE CHALLENGER PORTFOLIO =====
    console.log('\n=== IN-SAMPLE CHALLENGER PORTFOLIO (NOT DEPLOYABLE WITHOUT CROSS-VALIDATION) ===');
    
    // Select top signals that don't overlap in 15-min windows
    const usedWindows = new Set();
    const newPortfolio = [];
    
    for (const sig of sortedSignals) {
        if (sig.wr < 0.60) break; // only strong signals
        
        // Check non-overlap: each UTC hour×15min slot must be unique
        const windowKey = `H${sig.hour}_M${sig.minute}`;
        if (usedWindows.has(windowKey)) continue;
        
        usedWindows.add(windowKey);
        const kelly = kellyFraction(sig.wr) * 0.75;
        const stakeF = Math.min(kelly, 0.60);
        
        // Estimate avg price: DOWN signals tend to be ~0.45-0.50, UP ~0.48-0.55
        const avgPrice = sig.dir === 'UP' ? 0.51 : 0.48;
        
        newPortfolio.push({
            key: sig.key,
            hour: sig.hour,
            minute: sig.minute,
            dir: sig.dir,
            pWin: sig.wr,
            avgPrice,
            stakeF,
            w: sig.w,
            t: sig.t
        });
        
        if (newPortfolio.length >= 12) break; // max 12 signals
    }
    
    console.log('In-sample challenger signals:');
    for (const s of newPortfolio) {
        const status = activeKeySet.has(s.key) ? 'ACTIVE_CROSSVAL' : 'IN_SAMPLE_ONLY_DROP_UNTIL_CROSSVAL';
        console.log(`  ${s.key}: ${(s.pWin*100).toFixed(1)}% WR (${s.w}/${s.t}), stake=${(s.stakeF*100).toFixed(0)}%, ${status}`);
    }
    
    // ===== MONTE CARLO: CURRENT 7-SIGNAL =====
    console.log('\n=== MONTE CARLO: CURRENT 7-SIGNAL PORTFOLIO ===');
    console.log('Running 50,000 simulations...');
    const mc7 = monteCarlo(currentPortfolio, START_BALANCE, TRADES_7DAY, 50000);
    console.log(`7-day (49 trades): median=$${mc7.median.toFixed(2)}, p10=$${mc7.p10.toFixed(2)}, p25=$${mc7.p25.toFixed(2)}, p75=$${mc7.p75.toFixed(2)}, p90=$${mc7.p90.toFixed(2)}, bust=${(mc7.bustRate*100).toFixed(1)}%`);
    const mc7_14 = monteCarlo(currentPortfolio, START_BALANCE, TRADES_14DAY, 50000);
    console.log(`14-day (98 trades): median=$${mc7_14.median.toFixed(2)}, p10=$${mc7_14.p10.toFixed(2)}, p90=$${mc7_14.p90.toFixed(2)}, bust=${(mc7_14.bustRate*100).toFixed(1)}%`);
    
    // With extra deposit (+£5 = ~$6.30)
    const extraBalancce = START_BALANCE + 6.30;
    const mc7_extra = monteCarlo(currentPortfolio, extraBalancce, TRADES_7DAY, 50000);
    console.log(`7-day +£5 deposit ($${extraBalancce.toFixed(2)}): median=$${mc7_extra.median.toFixed(2)}, p10=$${mc7_extra.p10.toFixed(2)}, p90=$${mc7_extra.p90.toFixed(2)}, bust=${(mc7_extra.bustRate*100).toFixed(1)}%`);
    
    // ===== MONTE CARLO: IN-SAMPLE CHALLENGER PORTFOLIO =====
    if (newPortfolio.length > 0) {
        console.log(`\n=== MONTE CARLO: IN-SAMPLE CHALLENGER (${newPortfolio.length} signals, DIAGNOSTIC ONLY) ===`);
        console.log('Running 50,000 simulations with real 5-share minimum; this is NOT a deploy recommendation unless each new signal passes May2-9 cross-validation.');
        const numTradesNew7 = newPortfolio.length * 7;
        const mcNew = monteCarlo(newPortfolio, START_BALANCE, numTradesNew7, 50000);
        console.log(`7-day (${numTradesNew7} trades): median=$${mcNew.median.toFixed(2)}, p10=$${mcNew.p10.toFixed(2)}, p25=$${mcNew.p25.toFixed(2)}, p75=$${mcNew.p75.toFixed(2)}, p90=$${mcNew.p90.toFixed(2)}, bust=${(mcNew.bustRate*100).toFixed(1)}%`);
        const mcNew14 = monteCarlo(newPortfolio, START_BALANCE, numTradesNew7 * 2, 50000);
        console.log(`14-day (${numTradesNew7*2} trades): median=$${mcNew14.median.toFixed(2)}, p10=$${mcNew14.p10.toFixed(2)}, p90=$${mcNew14.p90.toFixed(2)}, bust=${(mcNew14.bustRate*100).toFixed(1)}%`);
        
        const mcNew_extra = monteCarlo(newPortfolio, extraBalancce, numTradesNew7, 50000);
        console.log(`7-day +£5 deposit ($${extraBalancce.toFixed(2)}): median=$${mcNew_extra.median.toFixed(2)}, p10=$${mcNew_extra.p10.toFixed(2)}, p90=$${mcNew_extra.p90.toFixed(2)}, bust=${(mcNew_extra.bustRate*100).toFixed(1)}%`);
    }
    
    // ===== ADVERSARIAL STRESS TEST =====
    console.log('\n=== ADVERSARIAL STRESS TEST (current 7-signal, -10% WR degradation) ===');
    const stressPortfolio = currentPortfolio.map(s => ({ ...s, pWin: Math.max(0.50, s.pWin - 0.10) }));
    const mcStress = monteCarlo(stressPortfolio, START_BALANCE, TRADES_7DAY, 50000);
    console.log(`7-day stress: median=$${mcStress.median.toFixed(2)}, p10=$${mcStress.p10.toFixed(2)}, p90=$${mcStress.p90.toFixed(2)}, bust=${(mcStress.bustRate*100).toFixed(1)}%`);
    
    // ===== IDENTIFY BEST SINGLE SIGNAL FOR ALL-IN APPROACH =====
    console.log('\n=== BEST SINGLE-SIGNAL ALL-IN ANALYSIS (IN-SAMPLE ONLY UNLESS ACTIVE_CROSSVAL) ===');
    const topSignals = sortedSignals.slice(0, 5);
    for (const sig of topSignals) {
        // All-in MC
        const allInPortfolio = [{ key: sig.key, pWin: sig.wr, avgPrice: 0.50, stakeF: 1.0 }];
        const mc = monteCarlo(allInPortfolio, START_BALANCE, 17, 50000); // 17 wins needed for $10→$1M at 50c
        const status = activeKeySet.has(sig.key) ? 'ACTIVE_CROSSVAL' : 'IN_SAMPLE_ONLY_DROP_UNTIL_CROSSVAL';
        console.log(`  ${sig.key} (${(sig.wr*100).toFixed(1)}%, ${status}): all-in 17 trades → median=$${mc.median.toFixed(0)}, bust=${(mc.bustRate*100).toFixed(1)}%`);
    }
    
    // ===== WEATHER MARKETS ASSESSMENT =====
    console.log('\n=== WEATHER/TEMPERATURE MARKETS ASSESSMENT ===');
    console.log('Fetching current weather market prices from Polymarket...');
    try {
        const weatherResp = await fetch('https://gamma-api.polymarket.com/markets?tag=weather&limit=20&active=true', 
            { signal: AbortSignal.timeout(8000) });
        if (weatherResp.ok) {
            const weatherData = await weatherResp.json();
            const markets = Array.isArray(weatherData) ? weatherData : (weatherData.markets || weatherData.results || []);
            const relevantMarkets = markets.filter(m => m.active && !m.closed && !m.resolved);
            
            if (relevantMarkets.length > 0) {
                console.log(`Found ${relevantMarkets.length} active weather markets:`);
                for (const m of relevantMarkets.slice(0, 10)) {
                    let pricesArr = m.outcomePrices || [];
                    if (typeof pricesArr === 'string') { try { pricesArr = JSON.parse(pricesArr); } catch(e) { pricesArr = []; } }
                    if (!Array.isArray(pricesArr)) pricesArr = [];
                    const parsed = pricesArr.map(p => parseFloat(p)).filter(p => p > 0.01 && p < 0.99);
                    const bestPrice = parsed.length > 0 ? Math.min(...parsed) : null;
                    const roi = bestPrice ? ((1/bestPrice - 1) * 100).toFixed(0) : 'N/A';
                    console.log(`  ${(m.question||m.slug||'').slice(0,60)}: prices=[${parsed.map(p=>p.toFixed(2)).join(',')}], minROI=${roi}%`);
                }
            } else {
                console.log('No active weather markets found via tag search.');
            }
        }
    } catch (e) {
        console.log(`Weather market fetch failed: ${e.message}`);
    }
    
    // Also search for weather by keyword
    try {
        const weatherResp2 = await fetch('https://gamma-api.polymarket.com/markets?search=temperature&limit=10&active=true',
            { signal: AbortSignal.timeout(8000) });
        if (weatherResp2.ok) {
            const weatherData2 = await weatherResp2.json();
            const markets2 = Array.isArray(weatherData2) ? weatherData2 : (weatherData2.markets || weatherData2.results || []);
            const relevant2 = markets2.filter(m => m.active && !m.resolved);
            if (relevant2.length > 0) {
                console.log(`\nTemperature keyword markets (${relevant2.length}):`);
                for (const m of relevant2.slice(0, 5)) {
                    const prices = m.outcomePrices || [];
                    const outcomesArr = Array.isArray(prices) ? prices : [];
                    const minPrice = outcomesArr.length ? Math.min(...outcomesArr.map(p => parseFloat(p)).filter(p => p > 0.01 && p < 0.99)) : null;
                    console.log(`  ${m.question?.slice(0,70) || m.slug}: min_price=${minPrice?.toFixed(3) || 'N/A'}`);
                }
            }
        }
    } catch(e) {
        console.log(`Temperature search failed: ${e.message}`);
    }
    
    // ===== VERDICT =====
    console.log('\n====================================================');
    console.log('  FINAL VERDICT & RECOMMENDATIONS');
    console.log('====================================================\n');
    
    const avgCurrentWR = currentPortfolio.reduce((sum, s) => sum + s.pWin, 0) / currentPortfolio.length;
    console.log(`Current 7-signal portfolio avg WR: ${(avgCurrentWR*100).toFixed(1)}%`);
    console.log(`7-day MC median: $${mc7.median.toFixed(2)} (p10=$${mc7.p10.toFixed(2)}, p90=$${mc7.p90.toFixed(2)})`);
    console.log(`14-day MC median: $${mc7_14.median.toFixed(2)}`);
    console.log(`Bust rate (7-day): ${(mc7.bustRate*100).toFixed(2)}%`);
    console.log('');
    
    const newPortfolioAvgWR = newPortfolio.length > 0 ? newPortfolio.reduce((sum, s) => sum + s.pWin, 0) / newPortfolio.length : 0;
    if (newPortfolio.length > 0) {
        const mcNewFinal = monteCarlo(newPortfolio, START_BALANCE, newPortfolio.length * 7, 50000);
        console.log(`IN-SAMPLE challenger (${newPortfolio.length} signals) avg WR: ${(newPortfolioAvgWR*100).toFixed(1)}%`);
        console.log(`Diagnostic 7-day MC median: $${mcNewFinal.median.toFixed(2)} (p10=$${mcNewFinal.p10.toFixed(2)}, p90=$${mcNewFinal.p90.toFixed(2)})`);
        console.log('Deploy verdict: DO NOT DEPLOY challenger unless non-active signals pass the same two-window cross-validation gate.');
    }
    
    // Save results
    const report = {
        generatedAt: new Date().toISOString(),
        startBalance: START_BALANCE,
        currentStrategy: {
            signals: currentPortfolio.map(s => ({ ...s })),
            avgWR: avgCurrentWR,
            mc7day: mc7,
            mc14day: mc7_14,
            mcStress7day: mcStress,
            mc7dayExtraDeposit: mc7_extra
        },
        newPortfolio: {
            signals: newPortfolio,
            avgWR: newPortfolioAvgWR
        },
        allSignalsSorted: sortedSignals.slice(0, 50)
    };
    
    const reportPath = path.join(__dirname, '../debug/comprehensive_strategy_analysis.json');
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
    console.log(`\nFull report saved: ${reportPath}`);
}

main().catch(e => { console.error('Error:', e); process.exit(1); });
