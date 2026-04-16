/**
 * Collect intracycle data using Gamma /events?series_id= endpoint.
 * This works directly (no proxy needed) and returns historical events with full market data.
 *
 * Series IDs:
 *   BTC 15m: 10192
 *   ETH 15m: 10191
 *   SOL 15m: 10423
 *   XRP 15m: 10422
 */
const https = require('https');
const fs = require('fs');
const path = require('path');

const GAMMA_API = 'https://gamma-api.polymarket.com';
const CLOB_API = 'https://clob.polymarket.com';
const SERIES = {
    BTC: 10192,
    ETH: 10191,
    SOL: 10423,
    XRP: 10422
};

const EXISTING_LATEST_EPOCH = 1775540700; // Apr 7 05:45 UTC
const nowSec = Math.floor(Date.now() / 1000);
const END_EPOCH = Math.floor((nowSec - 2 * 900) / 900) * 900;

console.log(`Gap to fill: ${new Date((EXISTING_LATEST_EPOCH + 900) * 1000).toISOString()} to ${new Date(END_EPOCH * 1000).toISOString()}`);

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function fetchJSON(url, timeoutMs = 20000) {
    return new Promise((resolve, reject) => {
        const req = https.get(url, { timeout: timeoutMs }, (res) => {
            let data = '';
            res.on('data', c => data += c);
            res.on('end', () => {
                try { resolve(JSON.parse(data)); }
                catch (e) { reject(new Error('parse: ' + e.message + ' at len ' + data.length)); }
            });
        });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    });
}

async function fetchWithRetry(url, retries = 3) {
    for (let i = 0; i < retries; i++) {
        try { return await fetchJSON(url); }
        catch (e) {
            if (i === retries - 1) throw e;
            await sleep(800 * (i + 1));
        }
    }
}

function safeParseJsonArray(val) {
    if (Array.isArray(val)) return val;
    try { return JSON.parse(val || '[]'); } catch { return []; }
}

function buildMinutePrices(history, cycleStart, totalMinutes) {
    const points = (history || [])
        .map(p => ({ t: Number(p?.t), p: Number(p?.p) }))
        .filter(p => Number.isFinite(p.t) && Number.isFinite(p.p) && p.t >= cycleStart);
    const minutePrices = {};
    for (let m = 0; m < totalMinutes; m++) {
        const minEnd = cycleStart + ((m + 1) * 60);
        const before = points.filter(p => p.t < minEnd);
        if (before.length === 0) continue;
        const inMin = points.filter(p => p.t >= cycleStart + (m * 60) && p.t < minEnd);
        const last = before[before.length - 1];
        minutePrices[m] = { last: last.p, count: inMin.length, ts: last.t };
    }
    return minutePrices;
}

async function collectSeries(asset, seriesId) {
    console.log(`\n--- ${asset} (series ${seriesId}) ---`);
    const events = [];
    let offset = 0;
    const limit = 100;

    // Paginate events
    while (true) {
        const url = `${GAMMA_API}/events?series_id=${seriesId}&limit=${limit}&offset=${offset}&closed=true&order=endDate&ascending=false`;
        try {
            const batch = await fetchWithRetry(url);
            if (!Array.isArray(batch) || batch.length === 0) break;
            events.push(...batch);
            console.log(`  ${asset} events: ${events.length} fetched (offset ${offset})`);
            if (batch.length < limit) break;
            offset += limit;
            // Stop if we've gone past our gap start (events come newest-first)
            const oldestInBatch = Math.min(...batch.map(e => {
                const slugMatch = (e.slug || '').match(/-(\d+)$/);
                return slugMatch ? Number(slugMatch[1]) : Infinity;
            }));
            if (oldestInBatch <= EXISTING_LATEST_EPOCH) {
                console.log(`  ${asset}: reached existing data boundary, stopping`);
                break;
            }
            await sleep(200);
        } catch (e) {
            console.log(`  ${asset} events fetch error at offset ${offset}: ${e.message}`);
            break;
        }
    }

    console.log(`  ${asset} total events: ${events.length}`);

    // Filter to gap range
    const gapEvents = events.filter(e => {
        const m = (e.slug || '').match(/-(\d+)$/);
        if (!m) return false;
        const epoch = Number(m[1]);
        return epoch > EXISTING_LATEST_EPOCH && epoch <= END_EPOCH;
    });
    console.log(`  ${asset} gap events: ${gapEvents.length}`);

    // Process each event
    const cycles = [];
    for (let i = 0; i < gapEvents.length; i++) {
        const ev = gapEvents[i];
        const slugMatch = ev.slug.match(/-(\d+)$/);
        const epoch = Number(slugMatch[1]);
        const markets = Array.isArray(ev.markets) ? ev.markets : [];
        if (markets.length === 0) continue;
        const market = markets[0];
        if (!market.closed) continue;

        const outcomePrices = safeParseJsonArray(market.outcomePrices);
        const tokenIds = safeParseJsonArray(market.clobTokenIds);
        const outcomes = safeParseJsonArray(market.outcomes);
        if (outcomePrices.length < 2 || tokenIds.length < 2) continue;

        let yesIdx = outcomes.findIndex(o => /^(yes|up)$/i.test(String(o).trim()));
        let noIdx = outcomes.findIndex(o => /^(no|down)$/i.test(String(o).trim()));
        if (yesIdx < 0 || noIdx < 0) { yesIdx = 0; noIdx = 1; }

        const yesPrice = parseFloat(outcomePrices[yesIdx]);
        const noPrice = parseFloat(outcomePrices[noIdx]);
        let resolution = 'UNKNOWN';
        if (yesPrice >= 0.99) resolution = 'UP';
        else if (noPrice >= 0.99) resolution = 'DOWN';
        else continue;

        const yesTokenId = tokenIds[yesIdx];
        const noTokenId = tokenIds[noIdx];
        const cycleEnd = epoch + 900;

        try {
            const [yesHist, noHist] = await Promise.all([
                fetchJSON(`${CLOB_API}/prices-history?market=${yesTokenId}&startTs=${epoch}&endTs=${cycleEnd}&fidelity=1`).catch(() => ({ history: [] })),
                fetchJSON(`${CLOB_API}/prices-history?market=${noTokenId}&startTs=${epoch}&endTs=${cycleEnd}&fidelity=1`).catch(() => ({ history: [] }))
            ]);
            const minutePricesYes = buildMinutePrices(yesHist?.history || [], epoch, 15);
            const minutePricesNo = buildMinutePrices(noHist?.history || [], epoch, 15);

            if (Object.keys(minutePricesYes).length === 0 && Object.keys(minutePricesNo).length === 0) continue;

            cycles.push({
                asset, epoch,
                slug: ev.slug,
                resolution,
                orderMinSize: market.orderMinSize || 5,
                orderPriceMinTickSize: market.orderPriceMinTickSize || 0.01,
                yesMinOrderSize: market.orderMinSize || 5,
                noMinOrderSize: market.orderMinSize || 5,
                priceSnapshotsYes: Object.keys(minutePricesYes).length,
                priceSnapshotsNo: Object.keys(minutePricesNo).length,
                minutePricesYes,
                minutePricesNo,
                minuteCoverage: {
                    yes: Object.keys(minutePricesYes).map(Number).sort((a, b) => a - b),
                    no: Object.keys(minutePricesNo).map(Number).sort((a, b) => a - b)
                }
            });

            if ((i + 1) % 50 === 0) {
                console.log(`  ${asset}: processed ${i + 1}/${gapEvents.length}, saved ${cycles.length}`);
            }
            await sleep(80);
        } catch (e) {
            // skip this cycle
        }
    }

    console.log(`  ${asset} DONE: ${cycles.length} cycles collected`);
    return cycles;
}

async function main() {
    console.log('\n=== Starting parallel series collection ===\n');
    const startTime = Date.now();

    // Run in parallel
    const results = await Promise.all(
        Object.entries(SERIES).map(([a, id]) => collectSeries(a, id))
    );
    const allCycles = results.flat().sort((a, b) => Number(a.epoch) - Number(b.epoch));

    console.log(`\nTotal new cycles: ${allCycles.length}`);
    console.log(`Time: ${((Date.now() - startTime) / 1000).toFixed(0)}s`);

    // Save gap data
    const gapPath = path.join(__dirname, '..', 'data', 'intracycle-price-data-gap.json');
    fs.writeFileSync(gapPath, JSON.stringify({
        generatedAt: new Date().toISOString(),
        startEpoch: EXISTING_LATEST_EPOCH + 900,
        endEpoch: END_EPOCH,
        totalCycles: allCycles.length,
        cycles: allCycles
    }, null, 2));
    console.log(`Saved gap data: ${gapPath}`);

    // Merge with existing
    const existing = require(path.join(__dirname, '..', 'data', 'intracycle-price-data-backup-apr7.json'));
    const existingKeys = new Set(existing.cycles.map(c => `${c.asset}_${c.epoch}`));
    const newOnly = allCycles.filter(c => !existingKeys.has(`${c.asset}_${c.epoch}`));

    const merged = {
        generatedAt: new Date().toISOString(),
        totalCycles: existing.cycles.length + newOnly.length,
        cycles: [...existing.cycles, ...newOnly].sort((a, b) => Number(a.epoch) - Number(b.epoch)),
        assets: ['BTC', 'ETH', 'SOL', 'XRP'],
        timeframe: '15m',
        cycleSeconds: 900,
        lookbackCycles: 'merged_gap_apr16'
    };
    const mergedPath = path.join(__dirname, '..', 'data', 'intracycle-price-data.json');
    fs.writeFileSync(mergedPath, JSON.stringify(merged, null, 2));
    console.log(`Merged: ${mergedPath} (${merged.totalCycles} total cycles, ${newOnly.length} new)`);

    // Summary
    const byAsset = {};
    for (const c of merged.cycles) {
        if (!byAsset[c.asset]) byAsset[c.asset] = { total: 0, up: 0, down: 0, epochs: [] };
        byAsset[c.asset].total++;
        byAsset[c.asset].epochs.push(Number(c.epoch));
        if (c.resolution === 'UP') byAsset[c.asset].up++;
        else byAsset[c.asset].down++;
    }
    console.log('\nFINAL per-asset summary:');
    for (const [a, s] of Object.entries(byAsset)) {
        console.log(`  ${a}: ${s.total} cycles (${s.up} UP / ${s.down} DOWN), ${new Date(Math.min(...s.epochs) * 1000).toISOString()} to ${new Date(Math.max(...s.epochs) * 1000).toISOString()}`);
    }
}

main().catch(e => { console.error('FATAL:', e); process.exit(1); });
