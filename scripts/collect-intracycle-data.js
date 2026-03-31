/**
 * Collect intracycle price data from recently resolved 15m markets.
 * Fetches price snapshots for each minute within each cycle to find
 * what prices were available at m0-m14 for each asset.
 * 
 * Output: JSON file with per-cycle, per-asset, per-minute price data
 * and resolution outcome (Up/Down won).
 */

const https = require('https');
const fs = require('fs');
const path = require('path');

const GAMMA_API = 'https://gamma-api.polymarket.com';
const CLOB_API = 'https://clob.polymarket.com';
const ASSETS = ['BTC', 'ETH', 'SOL', 'XRP'];
const CYCLE_SECONDS = 900; // 15 minutes
const LOOKBACK_CYCLES = 200; // ~50 hours of data per asset

function fetchJSON(url, timeoutMs = 15000) {
    return new Promise((resolve, reject) => {
        const req = https.get(url, { timeout: timeoutMs }, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try { resolve(JSON.parse(data)); }
                catch (e) { reject(new Error(`JSON parse error: ${e.message}`)); }
            });
        });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function fetchMarket(slug) {
    try {
        const markets = await fetchJSON(`${GAMMA_API}/markets?slug=${slug}`);
        return Array.isArray(markets) && markets.length > 0 ? markets[0] : null;
    } catch { return null; }
}

async function fetchPriceHistory(tokenId) {
    try {
        const data = await fetchJSON(`${CLOB_API}/prices-history?market=${tokenId}&interval=max&fidelity=1`);
        return data?.history || [];
    } catch { return []; }
}

function safeParseJsonArray(val) {
    if (Array.isArray(val)) return val;
    try { return JSON.parse(val || '[]'); } catch { return []; }
}

async function collectData() {
    const nowSec = Math.floor(Date.now() / 1000);
    // Start from 2 cycles ago (ensure resolved) and go back LOOKBACK_CYCLES
    const latestEpoch = Math.floor((nowSec - 2 * CYCLE_SECONDS) / CYCLE_SECONDS) * CYCLE_SECONDS;
    const earliestEpoch = latestEpoch - (LOOKBACK_CYCLES - 1) * CYCLE_SECONDS;
    
    console.log(`Collecting ${LOOKBACK_CYCLES} cycles per asset (${ASSETS.length} assets)`);
    console.log(`Range: ${new Date(earliestEpoch * 1000).toISOString()} to ${new Date(latestEpoch * 1000).toISOString()}`);
    
    const allCycles = [];
    let processed = 0;
    let found = 0;
    let errors = 0;
    
    for (const asset of ASSETS) {
        console.log(`\n--- ${asset} ---`);
        
        // Collect epochs in batches to avoid rate limiting
        const epochs = [];
        for (let e = latestEpoch; e >= earliestEpoch; e -= CYCLE_SECONDS) {
            epochs.push(e);
        }
        
        for (let i = 0; i < epochs.length; i++) {
            const epoch = epochs[i];
            const slug = `${asset.toLowerCase()}-updown-15m-${epoch}`;
            
            if (i > 0 && i % 10 === 0) {
                process.stdout.write(`  ${asset} ${i}/${epochs.length} (found=${found})...\r`);
                await sleep(200); // rate limit
            }
            
            try {
                const market = await fetchMarket(slug);
                processed++;
                
                if (!market) continue;
                if (!market.closed) continue; // skip active/unresolved
                
                const outcomes = safeParseJsonArray(market.outcomes);
                const outcomePrices = safeParseJsonArray(market.outcomePrices);
                const tokenIds = safeParseJsonArray(market.clobTokenIds);
                
                if (tokenIds.length < 2 || outcomePrices.length < 2) continue;
                
                // Determine resolution: which outcome won
                const yesPrice = parseFloat(outcomePrices[0]);
                const noPrice = parseFloat(outcomePrices[1]);
                let resolution = 'UNKNOWN';
                if (yesPrice >= 0.99) resolution = 'UP';
                else if (noPrice >= 0.99) resolution = 'DOWN';
                else continue; // skip unresolved
                
                // Fetch price history for YES token
                const yesTokenId = tokenIds[0];
                const priceHistory = await fetchPriceHistory(yesTokenId);
                
                // Filter to this cycle's time window only
                const cycleStart = epoch;
                const cycleEnd = epoch + CYCLE_SECONDS;
                const cyclePrices = priceHistory
                    .filter(p => p.t >= cycleStart && p.t < cycleEnd)
                    .map(p => ({ t: p.t, elapsed: p.t - cycleStart, minute: Math.floor((p.t - cycleStart) / 60), price: parseFloat(p.p) }))
                    .filter(p => Number.isFinite(p.price));
                
                if (cyclePrices.length === 0) continue;
                
                // Build per-minute price map
                const minutePrices = {};
                for (let m = 0; m < 15; m++) {
                    const pricesAtMinute = cyclePrices.filter(p => p.minute === m);
                    if (pricesAtMinute.length > 0) {
                        const avgPrice = pricesAtMinute.reduce((s, p) => s + p.price, 0) / pricesAtMinute.length;
                        const lastPrice = pricesAtMinute[pricesAtMinute.length - 1].price;
                        minutePrices[m] = { avg: avgPrice, last: lastPrice, count: pricesAtMinute.length };
                    }
                }
                
                // Also compute DOWN price (1 - yesPrice) for each minute
                const minutePricesDown = {};
                for (const [m, p] of Object.entries(minutePrices)) {
                    minutePricesDown[m] = { avg: 1 - p.avg, last: 1 - p.last, count: p.count };
                }
                
                const cycleData = {
                    asset,
                    epoch,
                    slug,
                    resolution,
                    priceSnapshots: cyclePrices.length,
                    minutePricesYes: minutePrices,
                    minutePricesNo: minutePricesDown,
                    startPrice: cyclePrices[0]?.price || null,
                    endPrice: cyclePrices[cyclePrices.length - 1]?.price || null,
                    minPrice: Math.min(...cyclePrices.map(p => p.price)),
                    maxPrice: Math.max(...cyclePrices.map(p => p.price)),
                };
                
                allCycles.push(cycleData);
                found++;
                
                await sleep(100); // rate limit between price-history calls
            } catch (e) {
                errors++;
            }
        }
        
        console.log(`  ${asset}: processed=${epochs.length}, found=${allCycles.filter(c => c.asset === asset).length}, errors=${errors}`);
    }
    
    console.log(`\nTotal cycles collected: ${allCycles.length}`);
    console.log(`Processed: ${processed}, Found: ${found}, Errors: ${errors}`);
    
    // Save to file
    const output = {
        generatedAt: new Date().toISOString(),
        lookbackCycles: LOOKBACK_CYCLES,
        assets: ASSETS,
        totalCycles: allCycles.length,
        cyclesByAsset: {},
        cycles: allCycles
    };
    
    for (const asset of ASSETS) {
        const assetCycles = allCycles.filter(c => c.asset === asset);
        output.cyclesByAsset[asset] = {
            total: assetCycles.length,
            upWins: assetCycles.filter(c => c.resolution === 'UP').length,
            downWins: assetCycles.filter(c => c.resolution === 'DOWN').length
        };
    }
    
    const outPath = path.join(__dirname, '..', 'data', 'intracycle-price-data.json');
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, JSON.stringify(output, null, 2));
    console.log(`\nSaved to: ${outPath}`);
    
    return output;
}

collectData().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
