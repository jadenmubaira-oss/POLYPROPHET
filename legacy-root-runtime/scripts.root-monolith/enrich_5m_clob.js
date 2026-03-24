/**
 * ENRICH 5m MANIFEST WITH CLOB INTRACYCLE DATA
 * 
 * Takes the existing 5m_manifest.json (39K+ markets) and fetches CLOB 
 * intracycle price data for a targeted recent window to enable price-band 
 * strategy search without re-collecting everything.
 * 
 * Usage:
 *   node scripts/enrich_5m_clob.js
 *   node scripts/enrich_5m_clob.js --days=15
 */

const fs = require('fs');
const path = require('path');

const CLOB_API = 'https://clob.polymarket.com/prices-history';
const RATE_LIMIT_MS = 80;
const MAX_RETRIES = 3;
const CYCLE_SEC = 300;
const TAKER_FEE_RATE = 0.02;

const daysArg = process.argv.find(a => a.startsWith('--days='));
const TARGET_DAYS = daysArg ? parseInt(daysArg.split('=')[1], 10) : 15;

const INPUT_DIR = path.join(__dirname, '..', 'exhaustive_analysis', '5m');
const MANIFEST_PATH = path.join(INPUT_DIR, '5m_manifest.json');
const OUTPUT_DATASET_PATH = path.join(INPUT_DIR, '5m_decision_dataset.json');
const OUTPUT_REPORT_PATH = path.join(INPUT_DIR, '5m_strategy_report.json');

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

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
                headers: { 'User-Agent': 'polyprophet-5m-enrich/1.0' },
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
            const url = `${CLOB_API}?market=${tokenId}&startTs=${market.cycleStartEpochSec}&endTs=${market.cycleStartEpochSec + CYCLE_SEC}&fidelity=1`;
            const data = await fetchWithRetry(url);
            await sleep(RATE_LIMIT_MS);
            if (data?.history && Array.isArray(data.history)) {
                const ticks = data.history.map(h => ({ t: h.t, p: Number(h.p) })).filter(t => t.p >= 0 && t.p <= 1);
                
                const totalMinutes = Math.ceil(CYCLE_SEC / 60);
                const minuteBars = [];
                for (let m = 0; m < totalMinutes; m++) {
                    const minStart = market.cycleStartEpochSec + (m * 60);
                    const minEnd = minStart + 60;
                    const minTicks = ticks.filter(t => t.t >= minStart && t.t < minEnd);
                    if (minTicks.length > 0) {
                        minuteBars.push({
                            minute: m, open: minTicks[0].p,
                            high: Math.max(...minTicks.map(t => t.p)),
                            low: Math.min(...minTicks.map(t => t.p)),
                            close: minTicks[minTicks.length - 1].p,
                            ticks: minTicks.length, imputed: false
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

function buildDecisionDataset(markets, intracycleMap) {
    const dataset = [];
    for (const market of markets) {
        const ic = intracycleMap?.[market.slug];
        if (!ic) {
            const cycleDate = new Date(market.cycleStartEpochSec * 1000);
            dataset.push({
                slug: market.slug, asset: market.asset,
                cycleStartEpochSec: market.cycleStartEpochSec,
                entryMinute: -1,
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
        
        for (let entryMin = 0; entryMin < 5; entryMin++) {
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

function runStrategySearch(dataset, markets) {
    console.log(`\nRunning 5m strategy search on ${dataset.length} rows (${markets.length} markets)...`);
    
    const strategies = [];
    const totalDays = markets.length > 0
        ? Math.max(1, (Math.max(...markets.map(m => m.cycleStartEpochSec)) - Math.min(...markets.map(m => m.cycleStartEpochSec))) / 86400)
        : 1;
    
    const entryMinutes = [0, 1, 2, 3];
    const utcHours = Array.from({ length: 24 }, (_, i) => i);
    const priceBands = [
        { min: 0.45, max: 0.55 }, { min: 0.50, max: 0.65 },
        { min: 0.55, max: 0.70 }, { min: 0.60, max: 0.75 },
        { min: 0.60, max: 0.80 }, { min: 0.65, max: 0.80 },
        { min: 0.70, max: 0.80 }, { min: 0.50, max: 0.80 },
        { min: 0.55, max: 0.80 }, { min: 0.45, max: 0.70 },
        { min: 0.40, max: 0.65 }, { min: 0.35, max: 0.65 },
    ];
    const directions = ['UP', 'DOWN'];
    const ASSETS = ['BTC', 'ETH', 'SOL', 'XRP'];
    
    const indexed = new Map();
    for (const row of dataset) {
        if (!row || row.entryMinute < 0) continue;
        const key = `${row.entryMinute}|${row.utcHour}`;
        if (!indexed.has(key)) indexed.set(key, []);
        indexed.get(key).push(row);
    }
    
    for (const entryMin of entryMinutes) {
        for (const hour of utcHours) {
            const base = indexed.get(`${entryMin}|${hour}`) || [];
            if (base.length < 5) continue;
            
            for (const band of priceBands) {
                for (const dir of directions) {
                    let wins = 0, totalROI = 0, trades = 0;
                    
                    for (const row of base) {
                        const entryPrice = dir === 'UP' ? row.upPrice : row.downPrice;
                        if (!Number.isFinite(entryPrice) || entryPrice < band.min || entryPrice > band.max) continue;
                        trades++;
                        const won = (dir === 'UP') === row.winnerIsUp;
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
                        type: 'intracycle', entryMinute: entryMin, utcHour: hour,
                        priceBand: band, direction: dir,
                        trades, wins, losses: trades - wins,
                        winRate, winRateLCB: lcb, avgROI, totalROI,
                        tradesPerDay: trades / totalDays,
                        score: lcb * 1000 + (trades / totalDays)
                    });
                }
            }
        }
    }
    
    strategies.sort((a, b) => b.winRateLCB - a.winRateLCB || b.tradesPerDay - a.tradesPerDay);
    console.log(`  Found ${strategies.length} strategy candidates`);
    
    const highWR = strategies.filter(s => s.winRate >= 0.90 && s.trades >= 15);
    const highLCB = strategies.filter(s => s.winRateLCB >= 0.70 && s.trades >= 20);
    console.log(`  High WR (>=90%): ${highWR.length} | High LCB (>=70%): ${highLCB.length}`);
    
    return { strategies, highWR, highLCB };
}

async function main() {
    console.log(`\n${'='.repeat(60)}`);
    console.log(`5m CLOB ENRICHMENT (targeting last ${TARGET_DAYS} days)`);
    console.log(`${'='.repeat(60)}\n`);
    
    // Load manifest
    console.log(`Loading manifest from ${MANIFEST_PATH}...`);
    const raw = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
    const allMarkets = raw.manifest || raw;
    console.log(`  Total markets in manifest: ${allMarkets.length}`);
    
    // Filter to recent window
    const nowSec = Math.floor(Date.now() / 1000);
    const cutoff = nowSec - (TARGET_DAYS * 86400);
    const recentMarkets = allMarkets.filter(m => m.cycleStartEpochSec >= cutoff);
    console.log(`  Markets in last ${TARGET_DAYS} days: ${recentMarkets.length}`);
    
    // Per-asset counts
    const assets = ['BTC', 'ETH', 'SOL', 'XRP'];
    for (const a of assets) {
        const count = recentMarkets.filter(m => m.asset === a).length;
        console.log(`    ${a}: ${count}`);
    }
    
    // Fetch CLOB intracycle data
    console.log(`\nFetching CLOB intracycle data for ${recentMarkets.length} markets...`);
    const intracycleMap = {};
    let fetched = 0, withData = 0;
    
    for (const market of recentMarkets) {
        const ic = await fetchIntracycleData(market);
        if (ic && ic.tokens && Object.keys(ic.tokens).length >= 2) {
            intracycleMap[market.slug] = ic;
            withData++;
        }
        fetched++;
        if (fetched % 50 === 0) {
            process.stdout.write(`\r  ${fetched}/${recentMarkets.length} (${(fetched/recentMarkets.length*100).toFixed(1)}%) withCLOB=${withData}`);
        }
    }
    console.log(`\n  CLOB data: ${withData}/${recentMarkets.length} markets enriched`);
    
    // Build decision dataset
    const dataset = buildDecisionDataset(recentMarkets, intracycleMap);
    fs.writeFileSync(OUTPUT_DATASET_PATH, JSON.stringify(dataset, null, 2));
    console.log(`  Dataset saved: ${OUTPUT_DATASET_PATH} (${dataset.length} rows)`);
    
    // Strategy search
    const { strategies, highWR, highLCB } = runStrategySearch(dataset, recentMarkets);
    
    // Build report
    const spanDays = recentMarkets.length > 1
        ? (Math.max(...recentMarkets.map(m => m.cycleStartEpochSec)) - Math.min(...recentMarkets.map(m => m.cycleStartEpochSec))) / 86400
        : 0;
    
    let upCount = 0;
    for (const m of recentMarkets) { if (m.resolvedOutcome === 'UP') upCount++; }
    
    const perAssetCounts = {};
    for (const a of assets) {
        const sub = recentMarkets.filter(m => m.asset === a);
        let ups = sub.filter(m => m.resolvedOutcome === 'UP').length;
        perAssetCounts[a] = { total: sub.length, UP: ups, DOWN: sub.length - ups, upPct: sub.length ? (ups / sub.length * 100).toFixed(1) : null };
    }
    
    const report = {
        timeframe: '5m', label: '5-Minute', cycleSec: 300,
        assets, dataSpanDays: spanDays.toFixed(1),
        totalResolvedMarkets: recentMarkets.length,
        totalDatasetRows: dataset.length,
        intracycleMarketsWithCLOB: withData,
        totalStrategyCandidates: strategies.length,
        highWinRateStrategies: highWR.length,
        highLCBStrategies: highLCB.length,
        outcomeDistribution: { UP: upCount, DOWN: recentMarkets.length - upCount, total: recentMarkets.length, upPct: (upCount / recentMarkets.length * 100).toFixed(1) },
        perAssetCounts,
        top50Strategies: strategies.slice(0, 50),
        highWinRateStrategiesList: highWR.slice(0, 30),
        highLCBStrategiesList: highLCB.slice(0, 30),
        generatedAt: new Date().toISOString()
    };
    
    fs.writeFileSync(OUTPUT_REPORT_PATH, JSON.stringify(report, null, 2));
    console.log(`  Report saved: ${OUTPUT_REPORT_PATH}`);
    
    // Print top strategies
    if (strategies.length > 0) {
        console.log(`\nTop 10 strategies:`);
        for (const s of strategies.slice(0, 10)) {
            const band = s.priceBand ? `${(s.priceBand.min*100).toFixed(0)}-${(s.priceBand.max*100).toFixed(0)}c` : 'any';
            console.log(`  H${String(s.utcHour).padStart(2,'0')} m${String(s.entryMinute).padStart(2,'0')} ${s.direction.padEnd(5)} ${band.padEnd(8)} | ${s.trades}t ${s.wins}w ${(s.winRate*100).toFixed(1)}% LCB=${(s.winRateLCB*100).toFixed(1)}% ROI=${(s.avgROI*100).toFixed(1)}%`);
        }
    }
    
    console.log(`\nDone.`);
}

main().catch(e => { console.error('Fatal error:', e); process.exit(1); });
