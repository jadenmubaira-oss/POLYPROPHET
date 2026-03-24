/**
 * MULTI-TIMEFRAME DATA COLLECTOR + STRATEGY SEARCH
 * 
 * Collects resolved market data from Polymarket Gamma API for any timeframe
 * (4h, 5m, 15m, etc.) and runs exhaustive strategy search.
 * 
 * Usage:
 *   node scripts/multiframe_data_collector.js --timeframe=4h
 *   node scripts/multiframe_data_collector.js --timeframe=5m
 *   node scripts/multiframe_data_collector.js --timeframe=4h --assets=BTC,ETH
 * 
 * @version 1.0.0
 */

const fs = require('fs');
const path = require('path');

// ============== CONFIGURATION ==============
const GAMMA_API = 'https://gamma-api.polymarket.com/markets';
const CLOB_API = 'https://clob.polymarket.com/prices-history';
const RATE_LIMIT_MS = 80;
const MAX_RETRIES = 3;
const DEFAULT_ASSETS = ['BTC', 'ETH', 'SOL', 'XRP'];
const TAKER_FEE_RATE = 0.02;
const WIN_RATE_TARGET = 0.90;

// Timeframe configs
const TIMEFRAME_CONFIGS = {
    '4h': {
        slug_infix: 'updown-4h',
        cycleSec: 14400,
        epochOffset: 3600,    // 4h markets start at epoch % 14400 == 3600
        cyclesPerDay: 6,
        entryMinuteBuckets: [0, 15, 30, 45, 60, 90, 120, 150, 180, 210, 230],
        maxEntryMinute: 239,
        clobFidelity: 60,     // 1-minute bars
        label: '4-Hour'
    },
    '5m': {
        slug_infix: 'updown-5m',
        cycleSec: 300,
        epochOffset: 0,       // 5m markets align to 300-second boundaries
        cyclesPerDay: 288,
        entryMinuteBuckets: [0, 1, 2, 3, 4],
        maxEntryMinute: 4,
        clobFidelity: 1,      // tick-level
        label: '5-Minute'
    },
    '15m': {
        slug_infix: 'updown-15m',
        cycleSec: 900,
        epochOffset: 0,
        cyclesPerDay: 96,
        entryMinuteBuckets: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14],
        maxEntryMinute: 14,
        clobFidelity: 1,
        label: '15-Minute'
    }
};

function readArg(prefix) {
    const a = process.argv.find(x => x.startsWith(prefix));
    return a ? a.slice(prefix.length) : null;
}

const TF_KEY = readArg('--timeframe=') || '4h';
const TF = TIMEFRAME_CONFIGS[TF_KEY];
if (!TF) { console.error('Unknown timeframe:', TF_KEY); process.exit(1); }

const ASSETS_RAW = readArg('--assets=');
const ASSETS = ASSETS_RAW ? ASSETS_RAW.split(',').map(s => s.trim().toUpperCase()).filter(a => DEFAULT_ASSETS.includes(a)) : DEFAULT_ASSETS;
const SKIP_CLOB = readArg('--skipClob=') === 'true';
const OUTPUT_DIR = path.join(__dirname, '..', 'exhaustive_analysis', TF_KEY);
if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function epochToSlug(asset, epoch) {
    return `${asset.toLowerCase()}-${TF.slug_infix}-${epoch}`;
}

function alignEpoch(sec) {
    if (TF.epochOffset > 0) {
        // For 4h markets: epochs land at n*14400 + 3600
        const adjusted = sec - TF.epochOffset;
        const aligned = adjusted - (((adjusted % TF.cycleSec) + TF.cycleSec) % TF.cycleSec);
        return aligned + TF.epochOffset;
    }
    return sec - (sec % TF.cycleSec);
}

function wilsonLCB(wins, total, z = 1.96) {
    if (total <= 0) return 0;
    const p = wins / total;
    const d = 1 + (z * z) / total;
    const c = p + (z * z) / (2 * total);
    const m = z * Math.sqrt((p * (1 - p) + (z * z) / (4 * total)) / total);
    return Math.max(0, (c - m) / d);
}

async function fetchWithRetry(url, retries = MAX_RETRIES) {
    for (let i = 0; i < retries; i++) {
        try {
            const response = await fetch(url, {
                headers: { 'User-Agent': 'polyprophet-multiframe/1.0' },
                signal: AbortSignal.timeout(15000)
            });
            if (response.ok) return await response.json();
            if (response.status === 429) { await sleep((i + 1) * 2000); continue; }
            if (response.status === 404) return null;
        } catch (e) {
            if (i === retries - 1) console.error(`Failed: ${url}`, e.message);
            await sleep((i + 1) * 500);
        }
    }
    return null;
}

// ============== PHASE 1: FIND DATA RANGE ==============
async function findEarliestEpoch(asset) {
    process.stdout.write(`Finding earliest ${TF_KEY} epoch for ${asset}...`);
    const nowSec = Math.floor(Date.now() / 1000);
    // Start from a known recent epoch and walk back
    let recentEpoch = alignEpoch(nowSec) - TF.cycleSec;
    
    // Jump back in week steps
    let step = 7 * 86400;
    let earliest = null;
    let probeEpoch = recentEpoch;
    
    // First verify recent exists
    const recentSlug = epochToSlug(asset, recentEpoch);
    const recentData = await fetchWithRetry(`${GAMMA_API}?slug=${encodeURIComponent(recentSlug)}`);
    await sleep(RATE_LIMIT_MS);
    if (!recentData || (Array.isArray(recentData) && recentData.length === 0)) {
        // Try a few cycles back
        for (let i = 2; i <= 10; i++) {
            const tryEp = recentEpoch - (TF.cycleSec * i);
            const trySlug = epochToSlug(asset, tryEp);
            const tryData = await fetchWithRetry(`${GAMMA_API}?slug=${encodeURIComponent(trySlug)}`);
            await sleep(RATE_LIMIT_MS);
            if (tryData && (Array.isArray(tryData) ? tryData.length > 0 : tryData.id)) {
                recentEpoch = tryEp;
                break;
            }
        }
    }
    
    earliest = recentEpoch;
    probeEpoch = recentEpoch;
    
    // Walk back in large steps until no market found
    while (probeEpoch > nowSec - 180 * 86400) {
        probeEpoch -= step;
        // Align to valid epoch
        probeEpoch = alignEpoch(probeEpoch);
        const slug = epochToSlug(asset, probeEpoch);
        const data = await fetchWithRetry(`${GAMMA_API}?slug=${encodeURIComponent(slug)}`);
        await sleep(RATE_LIMIT_MS);
        if (data && (Array.isArray(data) ? data.length > 0 : data.id)) {
            earliest = probeEpoch;
            process.stdout.write('.');
        } else {
            // Binary search between probeEpoch and probeEpoch+step
            let lo = probeEpoch;
            let hi = probeEpoch + step;
            while (hi - lo > TF.cycleSec * 2) {
                const mid = alignEpoch(lo + Math.floor((hi - lo) / 2));
                const midSlug = epochToSlug(asset, mid);
                const midData = await fetchWithRetry(`${GAMMA_API}?slug=${encodeURIComponent(midSlug)}`);
                await sleep(RATE_LIMIT_MS);
                if (midData && (Array.isArray(midData) ? midData.length > 0 : midData.id)) {
                    earliest = mid;
                    hi = mid;
                } else {
                    lo = mid + TF.cycleSec;
                }
            }
            break;
        }
    }
    
    console.log(` earliest=${earliest} (${new Date(earliest * 1000).toISOString()})`);
    return earliest;
}

// ============== PHASE 2: COLLECT RESOLVED MARKETS ==============
async function collectResolvedMarkets(asset, startEpoch, endEpoch) {
    console.log(`Collecting ${TF_KEY} markets for ${asset}: ${new Date(startEpoch * 1000).toISOString()} to ${new Date(endEpoch * 1000).toISOString()}`);
    
    const markets = [];
    let processed = 0;
    let resolved = 0;
    let errors = 0;
    const totalCycles = Math.floor((endEpoch - startEpoch) / TF.cycleSec);
    
    for (let epoch = startEpoch; epoch < endEpoch; epoch += TF.cycleSec) {
        const slug = epochToSlug(asset, epoch);
        try {
            const data = await fetchWithRetry(`${GAMMA_API}?slug=${encodeURIComponent(slug)}`);
            await sleep(RATE_LIMIT_MS);
            
            const market = Array.isArray(data) ? data?.[0] : data;
            if (!market?.id) { processed++; continue; }
            
            let outcomePrices, outcomes, clobTokenIds;
            try {
                outcomePrices = typeof market.outcomePrices === 'string' ? JSON.parse(market.outcomePrices) : (market.outcomePrices || []);
                outcomes = typeof market.outcomes === 'string' ? JSON.parse(market.outcomes) : (market.outcomes || []);
                clobTokenIds = typeof market.clobTokenIds === 'string' ? JSON.parse(market.clobTokenIds) : (market.clobTokenIds || []);
            } catch { processed++; continue; }
            
            const p0 = Number(outcomePrices[0] || 0);
            const p1 = Number(outcomePrices[1] || 0);
            const isResolved = (p0 >= 0.99 && p1 <= 0.01) || (p0 <= 0.01 && p1 >= 0.99);
            if (!isResolved) { processed++; continue; }
            
            const idx0Win = p0 >= 0.99;
            const o0 = String(outcomes[0] || '').toLowerCase();
            const o1 = String(outcomes[1] || '').toLowerCase();
            
            let resolvedOutcome;
            if ((o0 === 'up' && o1 === 'down') || (o0 === 'yes' && o1 === 'no'))
                resolvedOutcome = idx0Win ? 'UP' : 'DOWN';
            else if ((o0 === 'down' && o1 === 'up') || (o0 === 'no' && o1 === 'yes'))
                resolvedOutcome = idx0Win ? 'DOWN' : 'UP';
            else
                resolvedOutcome = idx0Win ? 'UP' : 'DOWN';
            
            markets.push({
                slug, asset,
                cycleStartEpochSec: epoch,
                cycleEndEpochSec: epoch + TF.cycleSec,
                resolvedOutcome,
                outcomes, clobTokenIds,
                volume: Number(market.volume || 0),
                closed: market.closed
            });
            resolved++;
        } catch { errors++; }
        
        processed++;
        if (processed % 50 === 0) {
            const pct = ((processed / totalCycles) * 100).toFixed(1);
            process.stdout.write(`\r  ${processed}/${totalCycles} (${pct}%) resolved=${resolved} errors=${errors}`);
        }
    }
    
    console.log(`\n  Done: ${resolved} resolved out of ${processed} checked`);
    return markets;
}

// ============== PHASE 3: FETCH INTRACYCLE CLOB DATA ==============
async function fetchIntracycleData(market) {
    if (!market.clobTokenIds || market.clobTokenIds.length < 2) return null;
    
    const intracycle = {
        slug: market.slug, asset: market.asset,
        cycleStartEpochSec: market.cycleStartEpochSec,
        resolvedOutcome: market.resolvedOutcome,
        tokens: {}
    };
    
    for (let i = 0; i < Math.min(2, market.clobTokenIds.length); i++) {
        const tokenId = market.clobTokenIds[i];
        const outcome = String(market.outcomes[i] || (i === 0 ? 'UP' : 'DOWN')).toLowerCase();
        try {
            const url = `${CLOB_API}?market=${tokenId}&startTs=${market.cycleStartEpochSec}&endTs=${market.cycleStartEpochSec + TF.cycleSec}&fidelity=${TF.clobFidelity}`;
            const data = await fetchWithRetry(url);
            await sleep(RATE_LIMIT_MS);
            if (data?.history && Array.isArray(data.history)) {
                const ticks = data.history.map(h => ({ t: h.t, p: Number(h.p) })).filter(t => t.p >= 0 && t.p <= 1);
                
                // Resample to minute bars
                const totalMinutes = Math.ceil(TF.cycleSec / 60);
                const minuteBars = [];
                for (let m = 0; m < totalMinutes; m++) {
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
                        const prev = minuteBars[minuteBars.length - 1];
                        const carry = prev ? prev.close : 0.5;
                        minuteBars.push({ minute: m, open: carry, high: carry, low: carry, close: carry, ticks: 0, imputed: true });
                    }
                }
                intracycle.tokens[outcome] = { tokenId, ticks, minuteBars };
            }
        } catch {}
    }
    return intracycle;
}

// ============== PHASE 4: BUILD DECISION DATASET ==============
function buildDecisionDataset(markets, intracycleMap) {
    const dataset = [];
    
    for (const market of markets) {
        const ic = intracycleMap?.[market.slug];
        if (!ic) {
            // No intracycle data - create a basic entry with just outcome info
            const cycleDate = new Date(market.cycleStartEpochSec * 1000);
            dataset.push({
                slug: market.slug, asset: market.asset,
                cycleStartEpochSec: market.cycleStartEpochSec,
                entryMinute: -1, // placeholder for outcome-only analysis
                utcHour: cycleDate.getUTCHours(),
                dayOfWeek: cycleDate.getUTCDay(),
                upPrice: 0.5, downPrice: 0.5,
                volume: market.volume,
                resolvedOutcome: market.resolvedOutcome,
                winnerIsUp: market.resolvedOutcome === 'UP',
                hasIntracycle: false
            });
            continue;
        }
        
        const upData = ic.tokens.up || ic.tokens.yes;
        const downData = ic.tokens.down || ic.tokens.no;
        if (!upData || !downData) continue;
        
        const totalMinutes = Math.ceil(TF.cycleSec / 60);
        for (let entryMin = 0; entryMin < totalMinutes; entryMin++) {
            const upBars = upData.minuteBars.slice(0, entryMin + 1);
            const downBars = downData.minuteBars.slice(0, entryMin + 1);
            if (upBars.length === 0 || downBars.length === 0) continue;
            
            const currentUpPrice = upBars[upBars.length - 1].close;
            const currentDownPrice = downBars[downBars.length - 1].close;
            const upTrend = upBars.length > 1 ? upBars[upBars.length - 1].close - upBars[0].open : 0;
            const downTrend = downBars.length > 1 ? downBars[downBars.length - 1].close - downBars[0].open : 0;
            
            const cycleDate = new Date(market.cycleStartEpochSec * 1000);
            dataset.push({
                slug: market.slug, asset: market.asset,
                cycleStartEpochSec: market.cycleStartEpochSec,
                entryMinute: entryMin,
                utcHour: cycleDate.getUTCHours(),
                dayOfWeek: cycleDate.getUTCDay(),
                upPrice: currentUpPrice,
                downPrice: currentDownPrice,
                upTrend, downTrend,
                volume: market.volume,
                resolvedOutcome: market.resolvedOutcome,
                winnerIsUp: market.resolvedOutcome === 'UP',
                hasIntracycle: true
            });
        }
    }
    return dataset;
}

// ============== PHASE 5: STRATEGY SEARCH ==============
function runStrategySearch(dataset, markets) {
    console.log(`\nRunning ${TF_KEY} strategy search on ${dataset.length} rows (${markets.length} markets)...`);
    
    const strategies = [];
    const totalDays = markets.length > 0
        ? Math.max(1, (Math.max(...markets.map(m => m.cycleStartEpochSec)) - Math.min(...markets.map(m => m.cycleStartEpochSec))) / 86400)
        : 1;
    
    // Determine search dimensions based on timeframe
    let entryMinutes, utcHours;
    
    if (TF_KEY === '4h') {
        // For 4h: entry minutes at broader intervals, only valid start hours
        entryMinutes = [0, 15, 30, 45, 60, 90, 120, 150, 180, 210, 230];
        utcHours = [1, 5, 9, 13, 17, 21]; // Fixed 4h start hours
    } else if (TF_KEY === '5m') {
        entryMinutes = [0, 1, 2, 3];
        utcHours = Array.from({ length: 24 }, (_, i) => i);
    } else {
        entryMinutes = Array.from({ length: 15 }, (_, i) => i);
        utcHours = Array.from({ length: 24 }, (_, i) => i);
    }
    
    const priceBands = [
        { min: 0.30, max: 0.50 }, { min: 0.40, max: 0.60 },
        { min: 0.45, max: 0.55 }, { min: 0.50, max: 0.65 },
        { min: 0.55, max: 0.70 }, { min: 0.60, max: 0.75 },
        { min: 0.60, max: 0.80 }, { min: 0.65, max: 0.80 },
        { min: 0.70, max: 0.80 }, { min: 0.72, max: 0.80 },
        { min: 0.75, max: 0.80 }, { min: 0.35, max: 0.65 },
        { min: 0.35, max: 0.75 }, { min: 0.40, max: 0.70 },
    ];
    const directions = ['UP', 'DOWN', 'BEST'];
    
    // Index dataset
    const indexed = new Map();
    for (const row of dataset) {
        if (!row || row.entryMinute < 0) continue;
        const key = `${row.entryMinute}|${row.utcHour}`;
        const arr = indexed.get(key);
        if (arr) arr.push(row); else indexed.set(key, [row]);
    }
    
    // Also do outcome-only analysis (no entry minute dependency)
    // Group by just utcHour for outcome-only strategies
    const outcomeOnly = new Map();
    for (const m of markets) {
        const utcHour = new Date(m.cycleStartEpochSec * 1000).getUTCHours();
        const key = String(utcHour);
        const arr = outcomeOnly.get(key);
        if (arr) arr.push(m); else outcomeOnly.set(key, [m]);
    }
    
    // Outcome-only strategies (direction by hour, no price band needed)
    for (const hour of utcHours) {
        const hourMarkets = outcomeOnly.get(String(hour)) || [];
        if (hourMarkets.length < 10) continue;
        
        for (const dir of ['UP', 'DOWN']) {
            let wins = 0;
            for (const m of hourMarkets) {
                if (m.resolvedOutcome === dir) wins++;
            }
            const trades = hourMarkets.length;
            const winRate = wins / trades;
            const lcb = wilsonLCB(wins, trades);
            const avgROI = winRate > 0 ? ((1 / 0.5) - 1) * winRate * (1 - TAKER_FEE_RATE) - (1 - winRate) : -1;
            
            strategies.push({
                type: 'outcome_only',
                entryMinute: null,
                utcHour: hour,
                priceBand: null,
                direction: dir,
                trades, wins, losses: trades - wins,
                winRate, winRateLCB: lcb,
                avgROI,
                tradesPerDay: trades / totalDays,
                perAsset: computePerAsset(hourMarkets, dir, null),
                score: lcb * 1000 + (trades / totalDays)
            });
        }
    }
    
    // Price-band strategies (need intracycle data)
    for (const entryMin of entryMinutes) {
        for (const hour of utcHours) {
            const base = indexed.get(`${entryMin}|${hour}`) || [];
            if (base.length < 5) continue;
            
            for (const band of priceBands) {
                for (const dir of directions) {
                    let wins = 0, totalROI = 0, trades = 0;
                    
                    for (const row of base) {
                        let tradedUp, entryPrice;
                        if (dir === 'UP') { tradedUp = true; entryPrice = row.upPrice; }
                        else if (dir === 'DOWN') { tradedUp = false; entryPrice = row.downPrice; }
                        else { tradedUp = row.upPrice < row.downPrice; entryPrice = tradedUp ? row.upPrice : row.downPrice; }
                        
                        if (!Number.isFinite(entryPrice) || entryPrice < band.min || entryPrice > band.max) continue;
                        trades++;
                        const won = tradedUp === row.winnerIsUp;
                        if (won) wins++;
                        const grossROI = won ? (1 / entryPrice) - 1 : -1;
                        const fee = won ? grossROI * TAKER_FEE_RATE : 0;
                        totalROI += grossROI - fee;
                    }
                    
                    if (trades < 10) continue;
                    const winRate = wins / trades;
                    const lcb = wilsonLCB(wins, trades);
                    const avgROI = totalROI / trades;
                    
                    strategies.push({
                        type: 'intracycle',
                        entryMinute: entryMin,
                        utcHour: hour,
                        priceBand: band,
                        direction: dir,
                        trades, wins, losses: trades - wins,
                        winRate, winRateLCB: lcb,
                        avgROI,
                        totalROI,
                        tradesPerDay: trades / totalDays,
                        score: lcb * 1000 + (trades / totalDays)
                    });
                }
            }
        }
    }
    
    strategies.sort((a, b) => b.winRateLCB - a.winRateLCB || b.tradesPerDay - a.tradesPerDay);
    console.log(`  Found ${strategies.length} strategy candidates`);
    return strategies;
}

function computePerAsset(markets, direction, priceBand) {
    const perAsset = {};
    for (const a of ASSETS) {
        const subset = markets.filter(m => m.asset === a);
        let wins = 0;
        for (const m of subset) {
            if (m.resolvedOutcome === direction) wins++;
        }
        perAsset[a] = {
            trades: subset.length,
            wins,
            losses: subset.length - wins,
            winRate: subset.length > 0 ? wins / subset.length : null,
            winRateLCB: subset.length > 0 ? wilsonLCB(wins, subset.length) : null
        };
    }
    return perAsset;
}

// ============== MAIN ==============
async function main() {
    console.log(`\n${'='.repeat(60)}`);
    console.log(`MULTI-TIMEFRAME ANALYSIS: ${TF.label} (${TF_KEY})`);
    console.log(`Assets: ${ASSETS.join(', ')}`);
    console.log(`Cycle duration: ${TF.cycleSec}s (${TF.cycleSec / 60} min)`);
    console.log(`${'='.repeat(60)}\n`);
    
    const nowSec = Math.floor(Date.now() / 1000);
    const endEpoch = alignEpoch(nowSec) - TF.cycleSec;
    
    // Phase 1: Find earliest epochs per asset
    const earliestByAsset = {};
    for (const asset of ASSETS) {
        earliestByAsset[asset] = await findEarliestEpoch(asset);
    }
    
    const globalEarliest = Math.min(...Object.values(earliestByAsset).filter(Number.isFinite));
    console.log(`\nGlobal earliest: ${new Date(globalEarliest * 1000).toISOString()}`);
    console.log(`Data span: ${((endEpoch - globalEarliest) / 86400).toFixed(1)} days\n`);
    
    // Phase 2: Collect resolved markets
    let allMarkets = [];
    for (const asset of ASSETS) {
        const start = earliestByAsset[asset];
        if (!Number.isFinite(start)) { console.log(`Skipping ${asset} - no data`); continue; }
        const markets = await collectResolvedMarkets(asset, start, endEpoch);
        allMarkets = allMarkets.concat(markets);
    }
    
    console.log(`\nTotal resolved markets: ${allMarkets.length}`);
    
    // Save manifest
    const manifestPath = path.join(OUTPUT_DIR, `${TF_KEY}_manifest.json`);
    fs.writeFileSync(manifestPath, JSON.stringify({ timeframe: TF_KEY, markets: allMarkets.length, assets: ASSETS, manifest: allMarkets }, null, 2));
    console.log(`Manifest saved: ${manifestPath}`);
    
    // Phase 3: Fetch intracycle data (optional, can be slow for 4h)
    let intracycleMap = {};
    if (!SKIP_CLOB && allMarkets.length <= 10000) {
        console.log(`\nFetching intracycle CLOB data for ${allMarkets.length} markets...`);
        let fetched = 0;
        for (const market of allMarkets) {
            const ic = await fetchIntracycleData(market);
            if (ic) intracycleMap[market.slug] = ic;
            fetched++;
            if (fetched % 20 === 0) process.stdout.write(`\r  ${fetched}/${allMarkets.length}`);
        }
        console.log(`\n  Intracycle data: ${Object.keys(intracycleMap).length} markets with CLOB data`);
    } else if (SKIP_CLOB) {
        console.log('\nSkipping CLOB intracycle data (--skipClob=true)');
    } else {
        console.log(`\nSkipping CLOB (${allMarkets.length} markets too many for inline fetch)`);
    }
    
    // Phase 4: Build dataset
    const dataset = buildDecisionDataset(allMarkets, intracycleMap);
    const datasetPath = path.join(OUTPUT_DIR, `${TF_KEY}_decision_dataset.json`);
    fs.writeFileSync(datasetPath, JSON.stringify(dataset, null, 2));
    console.log(`Dataset saved: ${datasetPath} (${dataset.length} rows)`);
    
    // Phase 5: Strategy search
    const strategies = runStrategySearch(dataset, allMarkets);
    
    // Filter and report top strategies
    const top50 = strategies.slice(0, 50);
    const highWR = strategies.filter(s => s.winRate >= WIN_RATE_TARGET && s.trades >= 15);
    const highLCB = strategies.filter(s => s.winRateLCB >= 0.70 && s.trades >= 20);
    
    const report = {
        timeframe: TF_KEY,
        label: TF.label,
        cycleSec: TF.cycleSec,
        assets: ASSETS,
        dataSpanDays: ((endEpoch - globalEarliest) / 86400).toFixed(1),
        totalResolvedMarkets: allMarkets.length,
        totalDatasetRows: dataset.length,
        intracycleMarketsWithCLOB: Object.keys(intracycleMap).length,
        totalStrategyCandidates: strategies.length,
        highWinRateStrategies: highWR.length,
        highLCBStrategies: highLCB.length,
        // Outcome distribution
        outcomeDistribution: (() => {
            let upCount = 0, downCount = 0;
            for (const m of allMarkets) { if (m.resolvedOutcome === 'UP') upCount++; else downCount++; }
            return { UP: upCount, DOWN: downCount, total: allMarkets.length, upPct: (upCount / allMarkets.length * 100).toFixed(1) };
        })(),
        // Per-asset stats
        perAssetCounts: (() => {
            const counts = {};
            for (const a of ASSETS) {
                const sub = allMarkets.filter(m => m.asset === a);
                let ups = sub.filter(m => m.resolvedOutcome === 'UP').length;
                counts[a] = { total: sub.length, UP: ups, DOWN: sub.length - ups, upPct: sub.length ? (ups / sub.length * 100).toFixed(1) : null };
            }
            return counts;
        })(),
        // Per UTC hour stats
        perHourOutcomes: (() => {
            const byHour = {};
            for (const m of allMarkets) {
                const h = new Date(m.cycleStartEpochSec * 1000).getUTCHours();
                if (!byHour[h]) byHour[h] = { total: 0, UP: 0, DOWN: 0 };
                byHour[h].total++;
                byHour[h][m.resolvedOutcome]++;
            }
            for (const h in byHour) {
                byHour[h].upPct = (byHour[h].UP / byHour[h].total * 100).toFixed(1);
                byHour[h].downPct = (byHour[h].DOWN / byHour[h].total * 100).toFixed(1);
            }
            return byHour;
        })(),
        top50Strategies: top50,
        highWinRateStrategiesList: highWR.slice(0, 30),
        highLCBStrategiesList: highLCB.slice(0, 30),
        generatedAt: new Date().toISOString()
    };
    
    const reportPath = path.join(OUTPUT_DIR, `${TF_KEY}_strategy_report.json`);
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
    console.log(`\nReport saved: ${reportPath}`);
    
    // Console summary
    console.log(`\n${'='.repeat(60)}`);
    console.log(`${TF.label} STRATEGY SEARCH RESULTS`);
    console.log(`${'='.repeat(60)}`);
    console.log(`Markets: ${allMarkets.length} | Data span: ${report.dataSpanDays} days`);
    console.log(`UP/DOWN split: ${report.outcomeDistribution.UP}/${report.outcomeDistribution.DOWN} (${report.outcomeDistribution.upPct}% UP)`);
    console.log(`Strategy candidates: ${strategies.length}`);
    console.log(`High WR (≥${(WIN_RATE_TARGET*100).toFixed(0)}%): ${highWR.length} | High LCB (≥70%): ${highLCB.length}`);
    
    if (top50.length > 0) {
        console.log(`\nTop 10 strategies by Wilson LCB:`);
        for (const s of top50.slice(0, 10)) {
            const em = s.entryMinute !== null ? `m${String(s.entryMinute).padStart(2,'0')}` : 'any';
            const band = s.priceBand ? `${(s.priceBand.min*100).toFixed(0)}-${(s.priceBand.max*100).toFixed(0)}c` : 'any';
            console.log(`  H${String(s.utcHour).padStart(2,'0')} ${em} ${s.direction.padEnd(5)} ${band.padEnd(8)} | ${s.trades}t ${s.wins}w ${(s.winRate*100).toFixed(1)}% LCB=${(s.winRateLCB*100).toFixed(1)}% ROI=${s.avgROI !== undefined ? (s.avgROI*100).toFixed(1)+'%' : 'n/a'} ${(s.tradesPerDay).toFixed(2)}/day`);
        }
    }
    
    console.log(`\nDone.`);
}

main().catch(e => { console.error('Fatal error:', e); process.exit(1); });
