/**
 * EXHAUSTIVE MARKET ANALYSIS - THE ATOMIC INVESTIGATION
 * 
 * This script performs a complete, atomic-level analysis of ALL Polymarket
 * 15-minute crypto up/down markets from the earliest available epoch to present.
 * 
 * Goals:
 * 1. Find earliest available market per asset (BTC/ETH/SOL/XRP)
 * 2. Fetch ALL resolved markets from Gamma API
 * 3. Fetch intracycle price data from CLOB for every market
 * 4. Build a decision dataset with features at every minute
 * 5. Run exhaustive strategy search (certainty-first, frequency-second)
 * 6. Validate with walk-forward testing
 * 7. Output final "golden sweet spot" strategy
 * 
 * @version 1.0.0
 * @date 2026-01-17
 */

const fs = require('fs');
const path = require('path');

// ============== CONFIGURATION ==============
const ASSETS = ['BTC', 'ETH', 'SOL', 'XRP'];
const CYCLE_DURATION_SEC = 900; // 15 minutes
const GAMMA_API = 'https://gamma-api.polymarket.com/markets';
const CLOB_API = 'https://clob.polymarket.com/prices-history';
const RATE_LIMIT_MS = 100; // 100ms between requests
const MAX_RETRIES = 3;
const OUTPUT_DIR = path.join(__dirname, 'exhaustive_analysis');

// Ensure output directory exists
if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
}

// ============== UTILITIES ==============
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function epochToSlug(asset, epochSec) {
    return `${asset.toLowerCase()}-updown-15m-${epochSec}`;
}

function slugToEpoch(slug) {
    const match = slug.match(/-(\d+)$/);
    return match ? parseInt(match[1]) : null;
}

function alignToEpoch(timestampSec) {
    return timestampSec - (timestampSec % CYCLE_DURATION_SEC);
}

async function fetchWithRetry(url, options = {}, retries = MAX_RETRIES) {
    for (let i = 0; i < retries; i++) {
        try {
            const response = await fetch(url, {
                ...options,
                headers: {
                    'User-Agent': 'polyprophet-exhaustive-analysis/1.0',
                    ...options.headers
                },
                signal: AbortSignal.timeout(15000)
            });
            
            if (response.ok) {
                return await response.json();
            }
            
            if (response.status === 429) {
                // Rate limited - wait longer
                console.log(`Rate limited, waiting ${(i + 1) * 1000}ms...`);
                await sleep((i + 1) * 1000);
                continue;
            }
            
            if (response.status === 404) {
                return null; // Market doesn't exist
            }
            
            console.error(`HTTP ${response.status} for ${url}`);
        } catch (e) {
            if (i === retries - 1) {
                console.error(`Failed after ${retries} retries: ${url}`, e.message);
            }
            await sleep((i + 1) * 500);
        }
    }
    return null;
}

// ============== PHASE 1: FIND EARLIEST EPOCHS ==============
async function findEarliestEpoch(asset) {
    console.log(`\n🔍 Finding earliest epoch for ${asset}...`);
    
    const nowSec = Math.floor(Date.now() / 1000);
    const nowAligned = alignToEpoch(nowSec);
    
    // Binary search parameters
    // Find earliest available market without assuming a fixed historical start date
    let left = 0;
    let right = nowAligned - CYCLE_DURATION_SEC; // Most recent completed cycle
    let earliest = null;
    
    // First, find a rough bracket by jumping back in large steps
    let step = 30 * 24 * 60 * 60; // 30 days
    let probeEpoch = right;
    
    console.log(`  Starting probe from ${new Date(right * 1000).toISOString()}`);
    
    // Quick check: does the most recent cycle exist?
    const recentSlug = epochToSlug(asset, right);
    const recentData = await fetchWithRetry(`${GAMMA_API}?slug=${encodeURIComponent(recentSlug)}`);
    await sleep(RATE_LIMIT_MS);
    
    if (!recentData || (Array.isArray(recentData) && recentData.length === 0)) {
        console.log(`  ⚠️ No recent markets found for ${asset}. Trying older epochs...`);
        // Try going back further
        probeEpoch = right - step;
    }
    
    // Jump back until we find no market
    let foundBoundary = false;
    while (probeEpoch > left && !foundBoundary) {
        const slug = epochToSlug(asset, probeEpoch);
        const data = await fetchWithRetry(`${GAMMA_API}?slug=${encodeURIComponent(slug)}`);
        await sleep(RATE_LIMIT_MS);
        
        if (data && (Array.isArray(data) ? data.length > 0 : data.id)) {
            // Market exists, keep going back
            earliest = probeEpoch;
            probeEpoch -= step;
            process.stdout.write('.');
        } else {
            // No market - we found the boundary region
            foundBoundary = true;
            left = probeEpoch;
            right = probeEpoch + step;
        }
    }
    
    console.log('');
    
    if (!foundBoundary && earliest) {
        // Went all the way back, earliest is the oldest we found
        console.log(`  📅 Reached search limit. Earliest found: ${new Date(earliest * 1000).toISOString()}`);
        return earliest;
    }
    
    if (!earliest) {
        console.log(`  ❌ No markets found for ${asset}`);
        return null;
    }
    
    // Binary search within the bracket
    console.log(`  🔎 Binary searching between ${new Date(left * 1000).toISOString()} and ${new Date(right * 1000).toISOString()}`);
    
    while (right - left > CYCLE_DURATION_SEC) {
        const mid = alignToEpoch(left + Math.floor((right - left) / 2));
        const slug = epochToSlug(asset, mid);
        const data = await fetchWithRetry(`${GAMMA_API}?slug=${encodeURIComponent(slug)}`);
        await sleep(RATE_LIMIT_MS);
        
        if (data && (Array.isArray(data) ? data.length > 0 : data.id)) {
            // Market exists, search earlier
            earliest = mid;
            right = mid;
        } else {
            // No market, search later
            left = mid + CYCLE_DURATION_SEC;
        }
        process.stdout.write('.');
    }
    
    console.log('');
    console.log(`  ✅ Earliest epoch for ${asset}: ${earliest} (${new Date(earliest * 1000).toISOString()})`);
    
    return earliest;
}

// ============== PHASE 2: BUILD MARKET MANIFEST ==============
async function buildMarketManifest(asset, startEpoch, endEpoch) {
    console.log(`\n📋 Building manifest for ${asset}...`);
    console.log(`  From: ${new Date(startEpoch * 1000).toISOString()}`);
    console.log(`  To:   ${new Date(endEpoch * 1000).toISOString()}`);
    
    const manifest = [];
    const totalCycles = Math.floor((endEpoch - startEpoch) / CYCLE_DURATION_SEC);
    let processed = 0;
    let resolved = 0;
    let unresolved = 0;
    let errors = 0;
    
    console.log(`  Total cycles to process: ${totalCycles}`);
    
    for (let epoch = startEpoch; epoch < endEpoch; epoch += CYCLE_DURATION_SEC) {
        const slug = epochToSlug(asset, epoch);
        
        try {
            const data = await fetchWithRetry(`${GAMMA_API}?slug=${encodeURIComponent(slug)}`);
            await sleep(RATE_LIMIT_MS);
            
            if (!data) {
                errors++;
                processed++;
                continue;
            }
            
            const market = Array.isArray(data) ? data[0] : data;
            if (!market || !market.id) {
                unresolved++;
                processed++;
                continue;
            }
            
            // Parse outcome prices
            let outcomePrices = [];
            let outcomes = [];
            let clobTokenIds = [];
            
            try {
                outcomePrices = JSON.parse(market.outcomePrices || '[]');
                outcomes = JSON.parse(market.outcomes || '[]');
                clobTokenIds = JSON.parse(market.clobTokenIds || '[]');
            } catch (e) {
                // Handle if already parsed
                outcomePrices = market.outcomePrices || [];
                outcomes = market.outcomes || [];
                clobTokenIds = market.clobTokenIds || [];
            }
            
            // Check if resolved (prices are 1/0 or 0/1)
            const p0 = Number(outcomePrices[0] || 0);
            const p1 = Number(outcomePrices[1] || 0);
            const isResolved = (p0 >= 0.99 && p1 <= 0.01) || (p0 <= 0.01 && p1 >= 0.99);
            
            if (!isResolved) {
                unresolved++;
                processed++;
                continue;
            }
            
            // Determine winner
            const idx0Win = p0 >= 0.99;
            const o0 = String(outcomes[0] || '').toLowerCase();
            const o1 = String(outcomes[1] || '').toLowerCase();
            
            let resolvedOutcome;
            if (o0 === 'up' && o1 === 'down') {
                resolvedOutcome = idx0Win ? 'UP' : 'DOWN';
            } else if (o0 === 'down' && o1 === 'up') {
                resolvedOutcome = idx0Win ? 'DOWN' : 'UP';
            } else if (o0 === 'yes' && o1 === 'no') {
                resolvedOutcome = idx0Win ? 'UP' : 'DOWN';
            } else if (o0 === 'no' && o1 === 'yes') {
                resolvedOutcome = idx0Win ? 'DOWN' : 'UP';
            } else {
                resolvedOutcome = idx0Win ? 'UP' : 'DOWN';
            }
            
            manifest.push({
                slug,
                asset,
                cycleStartEpochSec: epoch,
                cycleEndEpochSec: epoch + CYCLE_DURATION_SEC,
                resolvedOutcome,
                outcomes,
                clobTokenIds,
                volume: Number(market.volume || 0),
                closed: market.closed,
                createdAt: market.createdAt,
                fetchedAt: Date.now()
            });
            
            resolved++;
            
        } catch (e) {
            errors++;
        }
        
        processed++;
        
        // Progress update every 100 cycles
        if (processed % 100 === 0) {
            const pct = ((processed / totalCycles) * 100).toFixed(1);
            console.log(`  Progress: ${processed}/${totalCycles} (${pct}%) | Resolved: ${resolved} | Errors: ${errors}`);
        }
    }
    
    console.log(`  ✅ Manifest complete: ${resolved} resolved, ${unresolved} unresolved, ${errors} errors`);
    
    return manifest;
}

// ============== PHASE 3: FETCH INTRACYCLE DATA ==============
async function fetchIntracycleData(market) {
    if (!market.clobTokenIds || market.clobTokenIds.length < 2) {
        return null;
    }
    
    const intracycle = {
        slug: market.slug,
        asset: market.asset,
        cycleStartEpochSec: market.cycleStartEpochSec,
        resolvedOutcome: market.resolvedOutcome,
        tokens: {}
    };
    
    for (let i = 0; i < market.clobTokenIds.length; i++) {
        const tokenId = market.clobTokenIds[i];
        const outcome = market.outcomes[i] || (i === 0 ? 'UP' : 'DOWN');
        
        try {
            const url = `${CLOB_API}?market=${tokenId}&startTs=${market.cycleStartEpochSec}&endTs=${market.cycleStartEpochSec + CYCLE_DURATION_SEC}&fidelity=1`;
            const data = await fetchWithRetry(url);
            await sleep(RATE_LIMIT_MS);
            
            if (data && data.history && Array.isArray(data.history)) {
                // Raw ticks
                const ticks = data.history.map(h => ({
                    t: h.t,
                    p: Number(h.p)
                })).filter(t => t.p >= 0 && t.p <= 1);
                
                // Resample to minute bars
                const minuteBars = [];
                for (let m = 0; m < 15; m++) {
                    const minStart = market.cycleStartEpochSec + (m * 60);
                    const minEnd = minStart + 60;
                    
                    const minTicks = ticks.filter(t => t.t >= minStart && t.t < minEnd);
                    
                    if (minTicks.length > 0) {
                        minuteBars.push({
                            minute: m,
                            open: minTicks[0].p,
                            high: Math.max(...minTicks.map(t => t.p)),
                            low: Math.min(...minTicks.map(t => t.p)),
                            close: minTicks[minTicks.length - 1].p,
                            ticks: minTicks.length,
                            imputed: false
                        });
                    } else {
                        // Carry forward from previous bar
                        const prevBar = minuteBars[minuteBars.length - 1];
                        const carryPrice = prevBar ? prevBar.close : 0.5;
                        minuteBars.push({
                            minute: m,
                            open: carryPrice,
                            high: carryPrice,
                            low: carryPrice,
                            close: carryPrice,
                            ticks: 0,
                            imputed: true
                        });
                    }
                }
                
                intracycle.tokens[outcome.toLowerCase()] = {
                    tokenId,
                    ticks,
                    minuteBars
                };
            }
        } catch (e) {
            // Skip this token
        }
    }
    
    return intracycle;
}

// ============== PHASE 4: BUILD DECISION DATASET ==============
function buildDecisionDataset(manifest, intracycleData) {
    console.log(`\n📊 Building decision dataset...`);
    
    const dataset = [];
    
    for (const market of manifest) {
        const ic = intracycleData[market.slug];
        if (!ic) continue;
        
        const upData = ic.tokens.up;
        const downData = ic.tokens.down;
        
        if (!upData || !downData) continue;
        
        // For each possible entry minute (0-14)
        for (let entryMin = 0; entryMin < 15; entryMin++) {
            // Features available at entry time (no lookahead)
            const upBars = upData.minuteBars.slice(0, entryMin + 1);
            const downBars = downData.minuteBars.slice(0, entryMin + 1);
            
            if (upBars.length === 0 || downBars.length === 0) continue;
            
            const currentUpPrice = upBars[upBars.length - 1].close;
            const currentDownPrice = downBars[downBars.length - 1].close;
            
            // Price trend features
            const upTrend = upBars.length > 1 ? upBars[upBars.length - 1].close - upBars[0].open : 0;
            const downTrend = downBars.length > 1 ? downBars[downBars.length - 1].close - downBars[0].open : 0;
            
            // Volatility features
            const upVol = upBars.length > 1 ? Math.max(...upBars.map(b => b.high)) - Math.min(...upBars.map(b => b.low)) : 0;
            const downVol = downBars.length > 1 ? Math.max(...downBars.map(b => b.high)) - Math.min(...downBars.map(b => b.low)) : 0;
            
            // Tick count (liquidity proxy)
            const upTicks = upBars.reduce((sum, b) => sum + b.ticks, 0);
            const downTicks = downBars.reduce((sum, b) => sum + b.ticks, 0);
            
            // Imputation ratio (data quality)
            const upImputed = upBars.filter(b => b.imputed).length / upBars.length;
            const downImputed = downBars.filter(b => b.imputed).length / downBars.length;
            
            // Time features
            const cycleDate = new Date(market.cycleStartEpochSec * 1000);
            const utcHour = cycleDate.getUTCHours();
            const dayOfWeek = cycleDate.getUTCDay();
            
            // Label
            const winnerIsUp = market.resolvedOutcome === 'UP';
            
            // Calculate ROI for both sides
            const upROI = winnerIsUp ? (1 / currentUpPrice) - 1 : -1;
            const downROI = !winnerIsUp ? (1 / currentDownPrice) - 1 : -1;
            
            dataset.push({
                slug: market.slug,
                asset: market.asset,
                cycleStartEpochSec: market.cycleStartEpochSec,
                entryMinute: entryMin,
                utcHour,
                dayOfWeek,
                // Entry prices
                upPrice: currentUpPrice,
                downPrice: currentDownPrice,
                // Trend features
                upTrend,
                downTrend,
                // Volatility features
                upVol,
                downVol,
                // Liquidity features
                upTicks,
                downTicks,
                // Quality features
                upImputed,
                downImputed,
                // Volume
                volume: market.volume,
                // Labels
                resolvedOutcome: market.resolvedOutcome,
                winnerIsUp,
                upROI,
                downROI
            });
        }
    }
    
    console.log(`  ✅ Dataset built: ${dataset.length} rows`);
    return dataset;
}

// ============== PHASE 5: EXHAUSTIVE STRATEGY SEARCH ==============
function runStrategySearch(dataset) {
    console.log(`\n🔍 Running exhaustive strategy search...`);
    
    const strategies = [];

    let datasetDays = null;
    if (Array.isArray(dataset) && dataset.length > 0) {
        let minEpoch = Infinity;
        let maxEpoch = -Infinity;
        for (const row of dataset) {
            if (!row || typeof row.cycleStartEpochSec !== 'number') continue;
            if (row.cycleStartEpochSec < minEpoch) minEpoch = row.cycleStartEpochSec;
            if (row.cycleStartEpochSec > maxEpoch) maxEpoch = row.cycleStartEpochSec;
        }
        if (Number.isFinite(minEpoch) && Number.isFinite(maxEpoch)) {
            datasetDays = Math.max(1, (maxEpoch - minEpoch) / 86400);
        }
    }
    
    // Strategy parameters to search
    const entryMinutes = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14];
    const utcHours = Array.from({ length: 24 }, (_, i) => i);
    const priceBands = [
        { min: 0.20, max: 0.40 },
        { min: 0.30, max: 0.50 },
        { min: 0.40, max: 0.60 },
        { min: 0.45, max: 0.55 },
        { min: 0.50, max: 0.65 },
        { min: 0.35, max: 0.65 }
    ];
    const directions = ['UP', 'DOWN', 'BEST']; // BEST = pick the one with better odds
    
    // Fee model (Polymarket taker fee)
    const TAKER_FEE_RATE = 0.02; // 2% fee on winnings
    
    // Evaluate each combination
    for (const entryMin of entryMinutes) {
        for (const hour of utcHours) {
            for (const band of priceBands) {
                for (const dir of directions) {
                    // Filter dataset
                    const filtered = dataset.filter(row => {
                        if (row.entryMinute !== entryMin) return false;
                        if (row.utcHour !== hour) return false;
                        
                        if (dir === 'UP') {
                            return row.upPrice >= band.min && row.upPrice <= band.max;
                        } else if (dir === 'DOWN') {
                            return row.downPrice >= band.min && row.downPrice <= band.max;
                        } else {
                            // BEST - take the side with better price
                            const bestPrice = Math.min(row.upPrice, row.downPrice);
                            return bestPrice >= band.min && bestPrice <= band.max;
                        }
                    });
                    
                    if (filtered.length < 20) continue; // Need sufficient samples
                    
                    // Calculate win rate and EV
                    let wins = 0;
                    let totalROI = 0;
                    
                    for (const row of filtered) {
                        let tradedUp;
                        if (dir === 'UP') {
                            tradedUp = true;
                        } else if (dir === 'DOWN') {
                            tradedUp = false;
                        } else {
                            tradedUp = row.upPrice < row.downPrice;
                        }
                        
                        const won = tradedUp === row.winnerIsUp;
                        if (won) wins++;
                        
                        const entryPrice = tradedUp ? row.upPrice : row.downPrice;
                        const grossROI = won ? (1 / entryPrice) - 1 : -1;
                        const fee = won ? grossROI * TAKER_FEE_RATE : 0;
                        const netROI = grossROI - fee;
                        totalROI += netROI;
                    }
                    
                    const winRate = wins / filtered.length;
                    const avgROI = totalROI / filtered.length;
                    const tradesPerDay = datasetDays ? (filtered.length / datasetDays) : 0; // Trades/day across dataset span
                    
                    // Wilson score lower confidence bound for win rate
                    const n = filtered.length;
                    const z = 1.96; // 95% confidence
                    const pHat = winRate;
                    const denominator = 1 + (z * z) / n;
                    const center = pHat + (z * z) / (2 * n);
                    const margin = z * Math.sqrt((pHat * (1 - pHat) + (z * z) / (4 * n)) / n);
                    const lcb = (center - margin) / denominator;
                    
                    strategies.push({
                        entryMinute: entryMin,
                        utcHour: hour,
                        priceBand: band,
                        direction: dir,
                        trades: filtered.length,
                        wins,
                        losses: filtered.length - wins,
                        winRate,
                        winRateLCB: lcb,
                        avgROI,
                        tradesPerDay,
                        // Score: prioritize certainty (LCB), then frequency
                        score: lcb * 1000 + tradesPerDay
                    });
                }
            }
        }
    }
    
    // Sort by certainty (LCB) first, then frequency
    strategies.sort((a, b) => {
        // First by LCB (higher is better)
        if (Math.abs(a.winRateLCB - b.winRateLCB) > 0.01) {
            return b.winRateLCB - a.winRateLCB;
        }
        // Then by trades per day (higher is better)
        return b.tradesPerDay - a.tradesPerDay;
    });
    
    console.log(`  ✅ Evaluated ${strategies.length} strategies`);
    
    return strategies;
}

// ============== PHASE 6: WALK-FORWARD VALIDATION ==============
function walkForwardValidation(dataset, topStrategies) {
    console.log(`\n🧪 Running walk-forward validation...`);
    
    // Sort dataset by time
    const sorted = [...dataset].sort((a, b) => a.cycleStartEpochSec - b.cycleStartEpochSec);
    
    // 70/30 train/test split
    const splitIdx = Math.floor(sorted.length * 0.7);
    const trainSet = sorted.slice(0, splitIdx);
    const testSet = sorted.slice(splitIdx);
    
    console.log(`  Train set: ${trainSet.length} rows`);
    console.log(`  Test set: ${testSet.length} rows`);
    
    const validated = [];
    
    for (const strategy of topStrategies.slice(0, 20)) { // Top 20 strategies
        // Evaluate on test set
        const testFiltered = testSet.filter(row => {
            if (row.entryMinute !== strategy.entryMinute) return false;
            if (row.utcHour !== strategy.utcHour) return false;
            
            const band = strategy.priceBand;
            if (strategy.direction === 'UP') {
                return row.upPrice >= band.min && row.upPrice <= band.max;
            } else if (strategy.direction === 'DOWN') {
                return row.downPrice >= band.min && row.downPrice <= band.max;
            } else {
                const bestPrice = Math.min(row.upPrice, row.downPrice);
                return bestPrice >= band.min && bestPrice <= band.max;
            }
        });
        
        if (testFiltered.length < 5) continue;
        
        let wins = 0;
        for (const row of testFiltered) {
            let tradedUp;
            if (strategy.direction === 'UP') {
                tradedUp = true;
            } else if (strategy.direction === 'DOWN') {
                tradedUp = false;
            } else {
                tradedUp = row.upPrice < row.downPrice;
            }
            if (tradedUp === row.winnerIsUp) wins++;
        }
        
        const testWinRate = wins / testFiltered.length;
        
        validated.push({
            ...strategy,
            testTrades: testFiltered.length,
            testWins: wins,
            testWinRate,
            // Degradation from train to test
            degradation: strategy.winRate - testWinRate
        });
    }
    
    // Sort by test win rate
    validated.sort((a, b) => b.testWinRate - a.testWinRate);
    
    console.log(`  ✅ Validated ${validated.length} strategies`);
    
    return validated;
}

// ============== PHASE 7: CALCULATE STAGE-1 SURVIVAL ==============
function calculateStage1Survival(strategy, dataset) {
    console.log(`\n💰 Calculating stage-1 survival probability...`);
    
    // Filter dataset for this strategy
    const filtered = dataset.filter(row => {
        if (row.entryMinute !== strategy.entryMinute) return false;
        if (row.utcHour !== strategy.utcHour) return false;
        
        const band = strategy.priceBand;
        if (strategy.direction === 'UP') {
            return row.upPrice >= band.min && row.upPrice <= band.max;
        } else if (strategy.direction === 'DOWN') {
            return row.downPrice >= band.min && row.downPrice <= band.max;
        } else {
            const bestPrice = Math.min(row.upPrice, row.downPrice);
            return bestPrice >= band.min && bestPrice <= band.max;
        }
    });
    
    // Sort by time for sequential simulation
    const sorted = filtered.sort((a, b) => a.cycleStartEpochSec - b.cycleStartEpochSec);
    
    // Monte Carlo simulation
    const SIMULATIONS = 10000;
    const TARGET_BALANCE = 20;
    const START_BALANCE = 1;
    
    let reachTarget = 0;
    let lossBeforeTarget = 0;
    let maxConsecLosses = 0;
    
    // Collect ROIs for simulation
    const rois = [];
    for (const row of sorted) {
        let tradedUp;
        if (strategy.direction === 'UP') {
            tradedUp = true;
        } else if (strategy.direction === 'DOWN') {
            tradedUp = false;
        } else {
            tradedUp = row.upPrice < row.downPrice;
        }
        
        const won = tradedUp === row.winnerIsUp;
        const entryPrice = tradedUp ? row.upPrice : row.downPrice;
        const grossROI = won ? (1 / entryPrice) - 1 : -1;
        const fee = won ? grossROI * 0.02 : 0;
        const netROI = grossROI - fee;
        
        rois.push({ won, netROI });
    }
    
    for (let sim = 0; sim < SIMULATIONS; sim++) {
        let balance = START_BALANCE;
        let consecLosses = 0;
        let hadLoss = false;
        
        // Shuffle ROIs for this simulation (bootstrap)
        const shuffled = [...rois].sort(() => Math.random() - 0.5);
        
        for (const trade of shuffled) {
            if (balance >= TARGET_BALANCE) break;
            
            // All-in strategy
            const stake = balance;
            const pnl = stake * trade.netROI;
            balance += pnl;
            
            if (!trade.won) {
                hadLoss = true;
                consecLosses++;
                maxConsecLosses = Math.max(maxConsecLosses, consecLosses);
                
                if (balance < 0.01) {
                    // Bust
                    break;
                }
            } else {
                consecLosses = 0;
            }
        }
        
        if (balance >= TARGET_BALANCE) {
            reachTarget++;
        }

        if (hadLoss) {
            lossBeforeTarget++;
        }
    }
    
    const pReachTarget = reachTarget / SIMULATIONS;
    const pLossBeforeTarget = lossBeforeTarget / SIMULATIONS;
    
    console.log(`  🎯 P(reach $20 from $1 all-in): ${(pReachTarget * 100).toFixed(1)}%`);
    console.log(`  ⚠️ P(≥1 loss before $20): ${(pLossBeforeTarget * 100).toFixed(1)}%`);
    console.log(`  📉 Max consecutive losses observed: ${maxConsecLosses}`);
    
    return {
        pReachTarget,
        pLossBeforeTarget,
        maxConsecLosses,
        simulations: SIMULATIONS
    };
}

// ============== MAIN EXECUTION ==============
async function main() {
    console.log('='.repeat(60));
    console.log('🔱 EXHAUSTIVE MARKET ANALYSIS - ATOMIC INVESTIGATION');
    console.log('='.repeat(60));
    console.log(`Started: ${new Date().toISOString()}`);
    
    const startTime = Date.now();
    const results = {
        startedAt: new Date().toISOString(),
        assets: {},
        combinedManifest: [],
        intracycleData: {},
        dataset: [],
        strategies: [],
        validatedStrategies: [],
        goldenStrategy: null,
        stage1Survival: null
    };
    
    // PHASE 1: Find earliest epochs
    console.log('\n' + '='.repeat(60));
    console.log('PHASE 1: FINDING EARLIEST EPOCHS');
    console.log('='.repeat(60));
    
    for (const asset of ASSETS) {
        const earliest = await findEarliestEpoch(asset);
        results.assets[asset] = {
            earliestEpoch: earliest,
            earliestDate: earliest ? new Date(earliest * 1000).toISOString() : null
        };
    }
    
    // Save progress
    fs.writeFileSync(
        path.join(OUTPUT_DIR, 'phase1_epochs.json'),
        JSON.stringify(results.assets, null, 2)
    );
    
    // PHASE 2: Build manifest for each asset
    console.log('\n' + '='.repeat(60));
    console.log('PHASE 2: BUILDING MARKET MANIFEST');
    console.log('='.repeat(60));
    
    const nowSec = Math.floor(Date.now() / 1000);
    const nowAligned = alignToEpoch(nowSec) - CYCLE_DURATION_SEC; // Exclude current incomplete cycle
    
    for (const asset of ASSETS) {
        const earliest = results.assets[asset].earliestEpoch;
        if (!earliest) continue;
        
        const manifest = await buildMarketManifest(asset, earliest, nowAligned);
        results.assets[asset].manifestCount = manifest.length;
        results.combinedManifest.push(...manifest);
        
        // Save per-asset manifest
        fs.writeFileSync(
            path.join(OUTPUT_DIR, `manifest_${asset}.json`),
            JSON.stringify(manifest, null, 2)
        );
    }
    
    console.log(`\n📊 Total resolved markets: ${results.combinedManifest.length}`);
    
    // Save combined manifest
    fs.writeFileSync(
        path.join(OUTPUT_DIR, 'manifest_combined.json'),
        JSON.stringify(results.combinedManifest, null, 2)
    );
    
    // PHASE 3: Fetch intracycle data (sample for now due to API limits)
    console.log('\n' + '='.repeat(60));
    console.log('PHASE 3: FETCHING INTRACYCLE DATA');
    console.log('='.repeat(60));
    
    // For efficiency, process in batches and save incrementally
    const BATCH_SIZE = 100;
    let processed = 0;
    
    for (let i = 0; i < results.combinedManifest.length; i += BATCH_SIZE) {
        const batch = results.combinedManifest.slice(i, i + BATCH_SIZE);
        
        for (const market of batch) {
            const ic = await fetchIntracycleData(market);
            if (ic) {
                results.intracycleData[market.slug] = ic;
            }
            processed++;
            
            if (processed % 50 === 0) {
                console.log(`  Processed ${processed}/${results.combinedManifest.length} markets`);
            }
        }
        
        // Save progress after each batch
        fs.writeFileSync(
            path.join(OUTPUT_DIR, 'intracycle_data.json'),
            JSON.stringify(results.intracycleData, null, 2)
        );
    }
    
    console.log(`  ✅ Intracycle data fetched for ${Object.keys(results.intracycleData).length} markets`);
    
    // PHASE 4: Build decision dataset
    console.log('\n' + '='.repeat(60));
    console.log('PHASE 4: BUILDING DECISION DATASET');
    console.log('='.repeat(60));
    
    results.dataset = buildDecisionDataset(results.combinedManifest, results.intracycleData);
    
    fs.writeFileSync(
        path.join(OUTPUT_DIR, 'decision_dataset.json'),
        JSON.stringify(results.dataset, null, 2)
    );
    
    // PHASE 5: Strategy search
    console.log('\n' + '='.repeat(60));
    console.log('PHASE 5: EXHAUSTIVE STRATEGY SEARCH');
    console.log('='.repeat(60));
    
    results.strategies = runStrategySearch(results.dataset);
    
    fs.writeFileSync(
        path.join(OUTPUT_DIR, 'strategies_ranked.json'),
        JSON.stringify(results.strategies.slice(0, 100), null, 2)
    );
    
    // PHASE 6: Walk-forward validation
    console.log('\n' + '='.repeat(60));
    console.log('PHASE 6: WALK-FORWARD VALIDATION');
    console.log('='.repeat(60));
    
    results.validatedStrategies = walkForwardValidation(results.dataset, results.strategies);
    
    fs.writeFileSync(
        path.join(OUTPUT_DIR, 'strategies_validated.json'),
        JSON.stringify(results.validatedStrategies, null, 2)
    );
    
    // PHASE 7: Calculate stage-1 survival for top strategy
    console.log('\n' + '='.repeat(60));
    console.log('PHASE 7: STAGE-1 SURVIVAL PROBABILITY');
    console.log('='.repeat(60));
    
    if (results.validatedStrategies.length > 0) {
        results.goldenStrategy = results.validatedStrategies[0];
        results.stage1Survival = calculateStage1Survival(results.goldenStrategy, results.dataset);
    }
    
    // Final summary
    const runtime = ((Date.now() - startTime) / 1000 / 60).toFixed(1);
    
    console.log('\n' + '='.repeat(60));
    console.log('🏆 ANALYSIS COMPLETE');
    console.log('='.repeat(60));
    console.log(`Runtime: ${runtime} minutes`);
    console.log(`Total markets analyzed: ${results.combinedManifest.length}`);
    console.log(`Dataset rows: ${results.dataset.length}`);
    console.log(`Strategies evaluated: ${results.strategies.length}`);
    
    if (results.goldenStrategy) {
        console.log('\n🌟 GOLDEN STRATEGY:');
        console.log(`  Entry Minute: ${results.goldenStrategy.entryMinute}`);
        console.log(`  UTC Hour: ${results.goldenStrategy.utcHour}`);
        console.log(`  Direction: ${results.goldenStrategy.direction}`);
        console.log(`  Price Band: ${results.goldenStrategy.priceBand.min} - ${results.goldenStrategy.priceBand.max}`);
        console.log(`  Win Rate: ${(results.goldenStrategy.winRate * 100).toFixed(1)}%`);
        console.log(`  Win Rate LCB: ${(results.goldenStrategy.winRateLCB * 100).toFixed(1)}%`);
        console.log(`  Test Win Rate: ${(results.goldenStrategy.testWinRate * 100).toFixed(1)}%`);
        console.log(`  Trades/Day: ${results.goldenStrategy.tradesPerDay.toFixed(2)}`);
        
        if (results.stage1Survival) {
            console.log(`\n💰 STAGE-1 SURVIVAL ($1 → $20 all-in):`);
            console.log(`  P(reach $20): ${(results.stage1Survival.pReachTarget * 100).toFixed(1)}%`);
            console.log(`  P(≥1 loss): ${(results.stage1Survival.pLossBeforeTarget * 100).toFixed(1)}%`);
        }
    }
    
    // Save final results
    results.completedAt = new Date().toISOString();
    results.runtimeMinutes = runtime;
    
    fs.writeFileSync(
        path.join(OUTPUT_DIR, 'final_results.json'),
        JSON.stringify(results, null, 2)
    );
    
    console.log(`\n📁 Results saved to: ${OUTPUT_DIR}`);
    
    return results;
}

// Run if executed directly
if (require.main === module) {
    main().catch(console.error);
}

module.exports = { main, findEarliestEpoch, buildMarketManifest, fetchIntracycleData, calculateStage1Survival };
