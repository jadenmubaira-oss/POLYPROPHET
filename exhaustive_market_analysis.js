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
const WIN_RATE_TARGET = 0.90;
const STREAK_KS = [10, 15, 20];
const STREAK_HORIZON_TRADES = 100;

// Ensure output directory exists
if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
}

// ============== UTILITIES ==============
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function tryReadJsonFile(filePath) {
    try {
        if (!fs.existsSync(filePath)) return null;
        return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch {
        return null;
    }
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

function wilsonLCBFromCounts(wins, total, z = 1.96) {
    if (!Number.isFinite(wins) || !Number.isFinite(total) || total <= 0) return 0;
    const pHat = wins / total;
    const denominator = 1 + (z * z) / total;
    const center = pHat + (z * z) / (2 * total);
    const margin = z * Math.sqrt((pHat * (1 - pHat) + (z * z) / (4 * total)) / total);
    return Math.max(0, (center - margin) / denominator);
}

function normCdf(z) {
    if (!Number.isFinite(z)) return null;
    const sign = z < 0 ? -1 : 1;
    const x = Math.abs(z) / Math.sqrt(2);
    const t = 1 / (1 + 0.3275911 * x);
    const a1 = 0.254829592;
    const a2 = -0.284496736;
    const a3 = 1.421413741;
    const a4 = -1.453152027;
    const a5 = 1.061405429;
    const erf = 1 - (((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t) * Math.exp(-x * x);
    const erfSigned = sign * erf;
    return 0.5 * (1 + erfSigned);
}

function posteriorProbWinRateAtLeast(wins, total, threshold, priorA = 1, priorB = 1) {
    if (!Number.isFinite(wins) || !Number.isFinite(total) || total <= 0) return 0;
    const losses = total - wins;
    const a = wins + priorA;
    const b = losses + priorB;
    const mean = a / (a + b);
    const variance = (a * b) / (((a + b) * (a + b)) * (a + b + 1));
    const sd = Math.sqrt(Math.max(0, variance));
    if (!Number.isFinite(sd) || sd === 0) return mean >= threshold ? 1 : 0;
    const z = (threshold - mean) / sd;
    const cdf = normCdf(z);
    if (cdf === null) return null;
    return Math.max(0, Math.min(1, 1 - cdf));
}

function expectedTrialsToKConsecutiveWins(p, k) {
    if (!Number.isFinite(p) || !Number.isFinite(k) || k <= 0) return null;
    if (p <= 0) return Infinity;
    if (p >= 1) return k;
    const pk = Math.pow(p, k);
    return (1 - pk) / ((1 - p) * pk);
}

function probAtLeastOneRunOfKWins(p, k, n) {
    if (!Number.isFinite(p) || !Number.isFinite(k) || !Number.isFinite(n)) return null;
    if (k <= 0) return 1;
    if (n <= 0) return 0;
    if (p <= 0) return 0;
    if (p >= 1) return n >= k ? 1 : 0;

    const kk = Math.max(1, Math.floor(k));
    const nn = Math.max(0, Math.floor(n));
    const states = new Float64Array(kk);
    const next = new Float64Array(kk);
    states[0] = 1;

    for (let i = 0; i < nn; i++) {
        next.fill(0);
        let sum = 0;
        for (let r = 0; r < kk; r++) sum += states[r];
        next[0] = sum * (1 - p);
        for (let r = 0; r < kk - 1; r++) {
            next[r + 1] = states[r] * p;
        }
        states.set(next);
    }

    let probNoRun = 0;
    for (let r = 0; r < kk; r++) probNoRun += states[r];
    return Math.max(0, Math.min(1, 1 - probNoRun));
}

function computeStreakStats(p, ks = STREAK_KS, horizonTrades = STREAK_HORIZON_TRADES) {
    if (!Number.isFinite(p)) return null;
    const pClamped = Math.max(0, Math.min(1, p));
    const pConsecutive = {};
    const pAtLeastOneInHorizon = {};
    const expectedTradesToFirst = {};
    for (const k of ks) {
        const kk = Number(k);
        if (!Number.isFinite(kk) || kk <= 0) continue;
        pConsecutive[String(kk)] = Math.pow(pClamped, kk);
        pAtLeastOneInHorizon[String(kk)] = probAtLeastOneRunOfKWins(pClamped, kk, horizonTrades);
        expectedTradesToFirst[String(kk)] = expectedTrialsToKConsecutiveWins(pClamped, kk);
    }
    return {
        p: pClamped,
        horizonTrades,
        pConsecutive,
        pAtLeastOneInHorizon,
        expectedTradesToFirst
    };
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

    const byEntryHour = new Map();
    for (const row of dataset) {
        if (!row) continue;
        const em = row.entryMinute;
        const hr = row.utcHour;
        if (!Number.isInteger(em) || !Number.isInteger(hr)) continue;
        const key = `${em}|${hr}`;
        const arr = byEntryHour.get(key);
        if (arr) arr.push(row);
        else byEntryHour.set(key, [row]);
    }
    
    // Strategy parameters to search
    const entryMinutes = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14];
    const utcHours = Array.from({ length: 24 }, (_, i) => i);
    // 🏆 EXPANDED SEARCH SPACE: Price bands up to 0.80 with finer granularity
    // Goal: Find strategies with >=90% win rate
    const priceBands = [
        // Original bands
        { min: 0.20, max: 0.40 },
        { min: 0.30, max: 0.50 },
        { min: 0.40, max: 0.60 },
        { min: 0.45, max: 0.55 },
        { min: 0.50, max: 0.65 },
        { min: 0.35, max: 0.65 },
        // Extended bands up to 0.80
        { min: 0.55, max: 0.70 },
        { min: 0.60, max: 0.75 },
        { min: 0.65, max: 0.80 },
        { min: 0.70, max: 0.80 },
        // Finer granularity bands (tighter spreads for precision)
        { min: 0.50, max: 0.60 },
        { min: 0.55, max: 0.65 },
        { min: 0.60, max: 0.70 },
        { min: 0.65, max: 0.75 },
        { min: 0.70, max: 0.78 },
        // Very tight bands for high-certainty discovery
        { min: 0.48, max: 0.52 },
        { min: 0.52, max: 0.58 },
        { min: 0.58, max: 0.64 },
        { min: 0.64, max: 0.72 },
        { min: 0.72, max: 0.80 },
        // Ultra-wide for frequency optimization
        { min: 0.35, max: 0.75 },
        { min: 0.40, max: 0.70 }
    ];
    const directions = ['UP', 'DOWN', 'BEST']; // BEST = pick the one with better odds
    
    // Fee model (Polymarket taker fee)
    const TAKER_FEE_RATE = 0.02; // 2% fee on winnings
    const z = 1.96; // 95% confidence
    
    // Evaluate each combination
    for (const entryMin of entryMinutes) {
        for (const hour of utcHours) {
            const base = byEntryHour.get(`${entryMin}|${hour}`) || [];
            if (base.length === 0) continue;
            for (const band of priceBands) {
                for (const dir of directions) {
                    let wins = 0;
                    let totalROI = 0;
                    let trades = 0;
                    const perAssetAgg = {};
                    for (const asset of ASSETS) {
                        perAssetAgg[asset] = { trades: 0, wins: 0, totalROI: 0 };
                    }
                    
                    for (const row of base) {
                        if (!row) continue;
                        const winnerIsUp = row.winnerIsUp;
                        const upPrice = Number(row.upPrice);
                        const downPrice = Number(row.downPrice);

                        let tradedUp;
                        let entryPrice;
                        if (dir === 'UP') {
                            tradedUp = true;
                            entryPrice = upPrice;
                        } else if (dir === 'DOWN') {
                            tradedUp = false;
                            entryPrice = downPrice;
                        } else {
                            tradedUp = upPrice < downPrice;
                            entryPrice = tradedUp ? upPrice : downPrice;
                        }

                        if (!Number.isFinite(entryPrice)) continue;
                        if (entryPrice < band.min || entryPrice > band.max) continue;

                        trades++;

                        const won = tradedUp === winnerIsUp;
                        if (won) wins++;

                        const grossROI = won ? (1 / entryPrice) - 1 : -1;
                        const fee = won ? grossROI * TAKER_FEE_RATE : 0;
                        const netROI = grossROI - fee;
                        totalROI += netROI;

                        const assetKey = row.asset;
                        if (perAssetAgg[assetKey]) {
                            perAssetAgg[assetKey].trades++;
                            if (won) perAssetAgg[assetKey].wins++;
                            perAssetAgg[assetKey].totalROI += netROI;
                        }
                    }

                    if (trades < 20) continue; // Need sufficient samples
                    
                    const winRate = wins / trades;
                    const avgROI = totalROI / trades;
                    const tradesPerDay = datasetDays ? (trades / datasetDays) : 0; // Trades/day across dataset span
                    
                    // Wilson score lower confidence bound for win rate
                    const n = trades;
                    const pHat = winRate;
                    const denominator = 1 + (z * z) / n;
                    const center = pHat + (z * z) / (2 * n);
                    const margin = z * Math.sqrt((pHat * (1 - pHat) + (z * z) / (4 * n)) / n);
                    const lcb = (center - margin) / denominator;

                    const posteriorPWinRateGE90 = posteriorProbWinRateAtLeast(wins, n, WIN_RATE_TARGET, 1, 1);
                    const streak = computeStreakStats(lcb);

                    const perAsset = {};
                    const assetsTraded = [];
                    let minAssetWinRate = null;
                    let minAssetWinRateLCB = null;
                    let minAssetPosteriorPWinRateGE90 = null;
                    for (const asset of ASSETS) {
                        const agg = perAssetAgg[asset];
                        const t = agg.trades;
                        if (!t) {
                            perAsset[asset] = {
                                trades: 0,
                                wins: 0,
                                losses: 0,
                                winRate: null,
                                winRateLCB: null,
                                posteriorPWinRateGE90: null,
                                avgROI: null,
                                streak: null
                            };
                            continue;
                        }

                        const w = agg.wins;
                        const l = t - w;
                        const wr = w / t;
                        const lcbA = wilsonLCBFromCounts(w, t, z);
                        const postP = posteriorProbWinRateAtLeast(w, t, WIN_RATE_TARGET, 1, 1);

                        perAsset[asset] = {
                            trades: t,
                            wins: w,
                            losses: l,
                            winRate: wr,
                            winRateLCB: lcbA,
                            posteriorPWinRateGE90: postP,
                            avgROI: agg.totalROI / t,
                            streak: computeStreakStats(lcbA)
                        };

                        assetsTraded.push(asset);
                        minAssetWinRate = (minAssetWinRate === null) ? wr : Math.min(minAssetWinRate, wr);
                        minAssetWinRateLCB = (minAssetWinRateLCB === null) ? lcbA : Math.min(minAssetWinRateLCB, lcbA);
                        if (typeof postP === 'number') {
                            minAssetPosteriorPWinRateGE90 = (minAssetPosteriorPWinRateGE90 === null) ? postP : Math.min(minAssetPosteriorPWinRateGE90, postP);
                        }
                    }
                    
                    strategies.push({
                        entryMinute: entryMin,
                        utcHour: hour,
                        priceBand: band,
                        direction: dir,
                        trades,
                        wins,
                        losses: trades - wins,
                        winRate,
                        winRateLCB: lcb,
                        posteriorPWinRateGE90,
                        streak,
                        perAsset,
                        assetsTraded,
                        minAssetWinRate,
                        minAssetWinRateLCB,
                        minAssetPosteriorPWinRateGE90,
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

function splitDatasetByMarkets(dataset, trainRatio = 0.7) {
    if (!Array.isArray(dataset) || dataset.length === 0) {
        return { trainSet: [], testSet: [] };
    }

    const bySlug = new Map();
    for (const row of dataset) {
        if (!row || !row.slug) continue;
        const slug = row.slug;
        const epoch = Number(row.cycleStartEpochSec);
        const existing = bySlug.get(slug);
        if (!existing) {
            bySlug.set(slug, { slug, epoch: Number.isFinite(epoch) ? epoch : Infinity });
        } else if (Number.isFinite(epoch) && epoch < existing.epoch) {
            existing.epoch = epoch;
        }
    }

    const markets = Array.from(bySlug.values()).sort((a, b) => {
        if (a.epoch !== b.epoch) return a.epoch - b.epoch;
        return String(a.slug).localeCompare(String(b.slug));
    });

    const splitIdx = Math.floor(markets.length * trainRatio);
    const trainSlugs = new Set(markets.slice(0, splitIdx).map(m => m.slug));
    const testSlugs = new Set(markets.slice(splitIdx).map(m => m.slug));

    const trainSet = [];
    const testSet = [];

    for (const row of dataset) {
        if (!row || !row.slug) continue;
        if (trainSlugs.has(row.slug)) trainSet.push(row);
        else if (testSlugs.has(row.slug)) testSet.push(row);
    }

    return { trainSet, testSet };
}

function splitDatasetByMarkets3Way(dataset, trainRatio = 0.6, valRatio = 0.2) {
    if (!Array.isArray(dataset) || dataset.length === 0) {
        return { trainSet: [], valSet: [], testSet: [] };
    }

    const bySlug = new Map();
    for (const row of dataset) {
        if (!row || !row.slug) continue;
        const slug = row.slug;
        const epoch = Number(row.cycleStartEpochSec);
        const existing = bySlug.get(slug);
        if (!existing) {
            bySlug.set(slug, { slug, epoch: Number.isFinite(epoch) ? epoch : Infinity });
        } else if (Number.isFinite(epoch) && epoch < existing.epoch) {
            existing.epoch = epoch;
        }
    }

    const markets = Array.from(bySlug.values()).sort((a, b) => {
        if (a.epoch !== b.epoch) return a.epoch - b.epoch;
        return String(a.slug).localeCompare(String(b.slug));
    });

    const trainEnd = Math.max(0, Math.floor(markets.length * trainRatio));
    const valEnd = Math.max(trainEnd, Math.floor(markets.length * (trainRatio + valRatio)));

    const trainSlugs = new Set(markets.slice(0, trainEnd).map(m => m.slug));
    const valSlugs = new Set(markets.slice(trainEnd, valEnd).map(m => m.slug));
    const testSlugs = new Set(markets.slice(valEnd).map(m => m.slug));

    const trainSet = [];
    const valSet = [];
    const testSet = [];

    for (const row of dataset) {
        if (!row || !row.slug) continue;
        if (trainSlugs.has(row.slug)) trainSet.push(row);
        else if (valSlugs.has(row.slug)) valSet.push(row);
        else if (testSlugs.has(row.slug)) testSet.push(row);
    }

    return { trainSet, valSet, testSet };
}

// ============== PHASE 6: WALK-FORWARD VALIDATION ==============
function walkForwardValidation(holdoutSet, topStrategies, prefix = 'test', options = {}) {
    const rawPrefix = String(prefix || 'test').trim().toLowerCase();
    const metricPrefix = (rawPrefix === 'val' || rawPrefix === 'validation') ? 'val' : 'test';
    const metricLabel = metricPrefix === 'val' ? 'validation' : 'test';
    const metricCap = metricPrefix.charAt(0).toUpperCase() + metricPrefix.slice(1);
    const minTradesRaw = Number(options?.minTrades);
    const maxStrategiesRaw = Number(options?.maxStrategies);
    const minTrades = Number.isFinite(minTradesRaw) ? minTradesRaw : 5;
    const maxStrategies = Number.isFinite(maxStrategiesRaw) ? maxStrategiesRaw : 20;

    console.log(`\n🧪 Evaluating strategies on ${metricLabel} set...`);
    
    const data = Array.isArray(holdoutSet) ? holdoutSet : [];
    const validated = [];
    
    const strategiesToValidate = Array.isArray(topStrategies) ? topStrategies : [];
    for (const strategy of strategiesToValidate.slice(0, maxStrategies)) {
        const filtered = data.filter(row => {
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
        
        if (filtered.length < minTrades) continue;
        
        let wins = 0;
        const z = 1.96;
        const perAssetAgg = {};
        for (const asset of ASSETS) {
            perAssetAgg[asset] = { trades: 0, wins: 0 };
        }
        for (const row of filtered) {
            let tradedUp;
            if (strategy.direction === 'UP') {
                tradedUp = true;
            } else if (strategy.direction === 'DOWN') {
                tradedUp = false;
            } else {
                tradedUp = row.upPrice < row.downPrice;
            }

            const won = tradedUp === row.winnerIsUp;
            if (won) wins++;

            const assetKey = row.asset;
            if (perAssetAgg[assetKey]) {
                perAssetAgg[assetKey].trades++;
                if (won) perAssetAgg[assetKey].wins++;
            }
        }
        
        const holdoutWinRate = wins / filtered.length;
        const holdoutWinRateLCB = wilsonLCBFromCounts(wins, filtered.length, z);
        const holdoutPosteriorPWinRateGE90 = posteriorProbWinRateAtLeast(wins, filtered.length, WIN_RATE_TARGET, 1, 1);
        const holdoutStreak = computeStreakStats(holdoutWinRateLCB);

        const holdoutPerAsset = {};
        const holdoutAssetsTraded = [];
        let minAssetHoldoutWinRate = null;
        let minAssetHoldoutWinRateLCB = null;
        let minAssetHoldoutPosteriorPWinRateGE90 = null;
        for (const asset of ASSETS) {
            const agg = perAssetAgg[asset];
            const t = agg.trades;
            if (!t) {
                holdoutPerAsset[asset] = {
                    trades: 0,
                    wins: 0,
                    losses: 0,
                    winRate: null,
                    winRateLCB: null,
                    posteriorPWinRateGE90: null,
                    streak: null
                };
                continue;
            }

            const w = agg.wins;
            const l = t - w;
            const wr = w / t;
            const lcbA = wilsonLCBFromCounts(w, t, z);
            const postP = posteriorProbWinRateAtLeast(w, t, WIN_RATE_TARGET, 1, 1);
            holdoutPerAsset[asset] = {
                trades: t,
                wins: w,
                losses: l,
                winRate: wr,
                winRateLCB: lcbA,
                posteriorPWinRateGE90: postP,
                streak: computeStreakStats(lcbA)
            };

            holdoutAssetsTraded.push(asset);
            minAssetHoldoutWinRate = (minAssetHoldoutWinRate === null) ? wr : Math.min(minAssetHoldoutWinRate, wr);
            minAssetHoldoutWinRateLCB = (minAssetHoldoutWinRateLCB === null) ? lcbA : Math.min(minAssetHoldoutWinRateLCB, lcbA);
            if (typeof postP === 'number') {
                minAssetHoldoutPosteriorPWinRateGE90 = (minAssetHoldoutPosteriorPWinRateGE90 === null) ? postP : Math.min(minAssetHoldoutPosteriorPWinRateGE90, postP);
            }
        }

        const evaluated = {
            ...strategy,
            [`${metricPrefix}Trades`]: filtered.length,
            [`${metricPrefix}Wins`]: wins,
            [`${metricPrefix}WinRate`]: holdoutWinRate,
            [`${metricPrefix}WinRateLCB`]: holdoutWinRateLCB,
            [`${metricPrefix}PosteriorPWinRateGE90`]: holdoutPosteriorPWinRateGE90,
            [`${metricPrefix}Streak`]: holdoutStreak,
            [`${metricPrefix}PerAsset`]: holdoutPerAsset,
            [`${metricPrefix}AssetsTraded`]: holdoutAssetsTraded,
            [`minAsset${metricCap}WinRate`]: minAssetHoldoutWinRate,
            [`minAsset${metricCap}WinRateLCB`]: minAssetHoldoutWinRateLCB,
            [`minAsset${metricCap}PosteriorPWinRateGE90`]: minAssetHoldoutPosteriorPWinRateGE90
        };

        if (metricPrefix === 'val') {
            evaluated.degradationTrainToVal = strategy.winRate - holdoutWinRate;
        } else {
            evaluated.degradation = strategy.winRate - holdoutWinRate;
            if (Number.isFinite(strategy.valWinRate)) {
                evaluated.degradationValToTest = strategy.valWinRate - holdoutWinRate;
            }
        }
        
        validated.push(evaluated);
    }

    const lcbKey = `${metricPrefix}WinRateLCB`;
    const wrKey = `${metricPrefix}WinRate`;
    const tradesKey = `${metricPrefix}Trades`;
    validated.sort((a, b) => {
        const aLCB = Number(a?.[lcbKey]);
        const bLCB = Number(b?.[lcbKey]);
        if (Number.isFinite(aLCB) && Number.isFinite(bLCB) && aLCB !== bLCB) return bLCB - aLCB;
        const aWR = Number(a?.[wrKey]);
        const bWR = Number(b?.[wrKey]);
        if (Number.isFinite(aWR) && Number.isFinite(bWR) && aWR !== bWR) return bWR - aWR;
        const aT = Number(a?.[tradesKey]);
        const bT = Number(b?.[tradesKey]);
        if (Number.isFinite(aT) && Number.isFinite(bT) && aT !== bT) return bT - aT;
        return (Number(b?.tradesPerDay) || 0) - (Number(a?.tradesPerDay) || 0);
    });
    
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

    const cacheFlag = String(process.env.USE_CACHED_DATA || '').toLowerCase();
    const useCachedData = (cacheFlag === '1' || cacheFlag === 'true' || cacheFlag === 'yes');
    let loadedFromCache = false;

    if (useCachedData) {
        const cachedFinal = tryReadJsonFile(path.join(OUTPUT_DIR, 'final_results.json'));
        const cachedAssets = (cachedFinal && cachedFinal.assets) ? cachedFinal.assets : tryReadJsonFile(path.join(OUTPUT_DIR, 'phase1_epochs.json'));
        const cachedManifest = tryReadJsonFile(path.join(OUTPUT_DIR, 'manifest_combined.json'));
        const cachedDataset = tryReadJsonFile(path.join(OUTPUT_DIR, 'decision_dataset.json'));

        if (cachedAssets && typeof cachedAssets === 'object') {
            results.assets = cachedAssets;
        }

        if (Array.isArray(cachedManifest) && Array.isArray(cachedDataset) && cachedDataset.length > 0) {
            results.combinedManifest = cachedManifest;
            results.dataset = cachedDataset;
            for (const m of results.combinedManifest) {
                if (m && m.slug) {
                    results.intracycleData[m.slug] = null;
                }
            }
            loadedFromCache = true;

            console.log('\n' + '='.repeat(60));
            console.log('CACHE: USING EXISTING MANIFEST + DATASET');
            console.log('='.repeat(60));
            console.log(`Cached markets: ${results.combinedManifest.length}`);
            console.log(`Cached dataset rows: ${results.dataset.length}`);
        } else {
            console.log('\n' + '='.repeat(60));
            console.log('CACHE: NOT AVAILABLE - RUNNING FULL FETCH');
            console.log('='.repeat(60));
        }
    }

    if (!loadedFromCache) {
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

        console.log(`\n Total resolved markets: ${results.combinedManifest.length}`);

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

        console.log(`  Intracycle data fetched for ${Object.keys(results.intracycleData).length} markets`);

        // PHASE 4: Build decision dataset
        console.log('\n' + '='.repeat(60));
        console.log('PHASE 4: BUILDING DECISION DATASET');
        console.log('='.repeat(60));

        results.dataset = buildDecisionDataset(results.combinedManifest, results.intracycleData);

        fs.writeFileSync(
            path.join(OUTPUT_DIR, 'decision_dataset.json'),
            JSON.stringify(results.dataset, null, 2)
        );
    }

    const trainRatioRaw = Number(process.env.SPLIT_TRAIN_RATIO);
    const valRatioRaw = Number(process.env.SPLIT_VAL_RATIO);
    const trainRatio = (Number.isFinite(trainRatioRaw) && trainRatioRaw > 0 && trainRatioRaw < 1) ? trainRatioRaw : 0.6;
    const valRatio = (Number.isFinite(valRatioRaw) && valRatioRaw > 0 && valRatioRaw < 1 && (trainRatio + valRatioRaw) < 1) ? valRatioRaw : 0.2;

    const split = splitDatasetByMarkets3Way(results.dataset, trainRatio, valRatio);
    const trainSet = split.trainSet;
    const valSet = split.valSet;
    const testSet = split.testSet;

    results.datasetSplit = {
        trainRatio,
        valRatio,
        testRatio: Math.max(0, 1 - trainRatio - valRatio),
        rows: {
            train: trainSet.length,
            val: valSet.length,
            test: testSet.length
        }
    };

    // PHASE 5: Strategy search
    console.log('\n' + '='.repeat(60));
    console.log('PHASE 5: EXHAUSTIVE STRATEGY SEARCH');
    console.log('='.repeat(60));
    
    results.strategies = runStrategySearch(trainSet);
    
    fs.writeFileSync(
        path.join(OUTPUT_DIR, 'strategies_ranked.json'),
        JSON.stringify(results.strategies.slice(0, 100), null, 2)
    );
    
    // PHASE 6: Walk-forward validation
    console.log('\n' + '='.repeat(60));
    console.log('PHASE 6: WALK-FORWARD VALIDATION');
    console.log('='.repeat(60));
    
    results.validatedStrategies = walkForwardValidation(valSet, results.strategies, 'val');
    
    fs.writeFileSync(
        path.join(OUTPUT_DIR, 'strategies_validated.json'),
        JSON.stringify(results.validatedStrategies, null, 2)
    );
    
    // PHASE 7: Calculate stage-1 survival for top strategy
    console.log('\n' + '='.repeat(60));
    console.log('PHASE 7: STAGE-1 SURVIVAL PROBABILITY');
    console.log('='.repeat(60));
    
    if (results.strategies.length > 0) {
        const candidate = results.validatedStrategies.length > 0
            ? results.validatedStrategies[0]
            : results.strategies[0];

        let golden = candidate;
        const tested = walkForwardValidation(testSet, [candidate], 'test', { minTrades: 0, maxStrategies: 1 });
        if (tested.length > 0) {
            golden = tested[0];
        }

        results.goldenStrategy = golden;
        results.stage1Survival = calculateStage1Survival(results.goldenStrategy, testSet);
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
        if (Number.isFinite(Number(results.goldenStrategy.valWinRate))) {
            console.log(`  Val Win Rate: ${(results.goldenStrategy.valWinRate * 100).toFixed(1)}%`);
        }
        if (Number.isFinite(Number(results.goldenStrategy.testWinRate))) {
            console.log(`  Test Win Rate: ${(results.goldenStrategy.testWinRate * 100).toFixed(1)}%`);
        }
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
    
    const finalResults = {
        startedAt: results.startedAt,
        completedAt: results.completedAt,
        runtimeMinutes: results.runtimeMinutes,
        assets: results.assets,
        datasetSplit: results.datasetSplit,
        counts: {
            totalMarkets: results.combinedManifest.length,
            intracycleMarkets: Object.keys(results.intracycleData).length,
            datasetRows: results.dataset.length,
            datasetSplit: results.datasetSplit,
            strategiesEvaluated: results.strategies.length,
            validatedStrategies: results.validatedStrategies.length
        },
        files: {
            phase1Epochs: 'phase1_epochs.json',
            manifestCombined: 'manifest_combined.json',
            intracycleData: 'intracycle_data.json',
            decisionDataset: 'decision_dataset.json',
            strategiesRanked: 'strategies_ranked.json',
            strategiesValidated: 'strategies_validated.json'
        },
        strategies: results.strategies,
        validatedStrategies: results.validatedStrategies,
        goldenStrategy: results.goldenStrategy,
        stage1Survival: results.stage1Survival
    };
    
    fs.writeFileSync(
        path.join(OUTPUT_DIR, 'final_results.json'),
        JSON.stringify(finalResults, null, 2)
    );
    
    console.log(`\n📁 Results saved to: ${OUTPUT_DIR}`);
    
    return results;
}

// Run if executed directly
if (require.main === module) {
    main().catch(console.error);
}

module.exports = { main, findEarliestEpoch, buildMarketManifest, fetchIntracycleData, calculateStage1Survival };
