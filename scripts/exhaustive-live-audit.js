#!/usr/bin/env node
/**
 * Exhaustive Live Market Audit
 * 
 * Fetches real CLOB price history for recent 15m cycles across all 4 assets.
 * For each cycle, records the DOWN token price at every strategy entry minute.
 * Then checks which strategies would have matched (price in band at exact minute).
 * 
 * Output: JSON report with per-cycle, per-strategy match/miss analysis
 */

const https = require('https');
const fs = require('fs');
const path = require('path');

const GAMMA_API = 'https://gamma-api.polymarket.com';
const CLOB_API = 'https://clob.polymarket.com';
const ASSETS = ['BTC', 'ETH', 'SOL', 'XRP'];
const CYCLE_SECONDS = 900; // 15 minutes
const RATE_LIMIT_MS = 120;

// Load strategy set
const strategyPath = process.env.STRATEGY_PATH
    ? path.resolve(process.env.STRATEGY_PATH)
    : path.join(__dirname, '..', 'debug', 'strategy_set_15m_nc_exhaustive_13.json');
const strategySet = JSON.parse(fs.readFileSync(strategyPath, 'utf8'));
const strategies = strategySet.strategies;

// Strategy windows: unique (utcHour, entryMinute, direction) combinations
const uniqueWindows = [];
const seen = new Set();
for (const s of strategies) {
    const key = `${s.utcHour}|${s.entryMinute}|${s.direction}`;
    if (!seen.has(key)) {
        seen.add(key);
        uniqueWindows.push({ utcHour: s.utcHour, entryMinute: s.entryMinute, direction: s.direction, priceMin: s.priceMin, priceMax: s.priceMax });
    }
}
console.log(`Strategy windows: ${uniqueWindows.length}`);
uniqueWindows.forEach(w => console.log(`  H${String(w.utcHour).padStart(2,'0')} m${w.entryMinute} ${w.direction} (${w.priceMin}-${w.priceMax})`));

function fetchJSON(url) {
    return new Promise((resolve, reject) => {
        const req = https.get(url, { timeout: 15000 }, (res) => {
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

function computeEpoch(nowSec) {
    return Math.floor(nowSec / CYCLE_SECONDS) * CYCLE_SECONDS;
}

async function analyzeCycle(asset, epoch) {
    const slug = `${asset.toLowerCase()}-updown-15m-${epoch}`;
    const cycleStart = epoch;
    const cycleEnd = epoch + CYCLE_SECONDS;
    const utcHour = new Date(epoch * 1000).getUTCHours();

    // Fetch market from Gamma
    let market;
    try {
        const markets = await fetchJSON(`${GAMMA_API}/markets?slug=${slug}`);
        market = Array.isArray(markets) && markets.length > 0 ? markets[0] : null;
    } catch { return null; }
    if (!market) return null;

    // Get token IDs
    let tokenIds;
    try { tokenIds = JSON.parse(market.clobTokenIds || '[]'); } catch { return null; }
    if (tokenIds.length < 2) return null;

    // Determine YES/NO token mapping
    let outcomes;
    try { outcomes = JSON.parse(market.outcomes || '[]'); } catch { outcomes = ['Up', 'Down']; }
    let yesTokenId = tokenIds[0], noTokenId = tokenIds[1];
    const yesIdx = outcomes.findIndex(o => /^(yes|up)$/i.test(String(o).trim()));
    const noIdx = outcomes.findIndex(o => /^(no|down)$/i.test(String(o).trim()));
    if (yesIdx >= 0 && noIdx >= 0) {
        yesTokenId = tokenIds[yesIdx];
        noTokenId = tokenIds[noIdx];
    }

    // Fetch CLOB price history for both tokens (fidelity=60 = 1 min)
    await sleep(RATE_LIMIT_MS);
    let yesHistory, noHistory;
    try {
        [yesHistory, noHistory] = await Promise.all([
            fetchJSON(`${CLOB_API}/prices-history?market=${yesTokenId}&startTs=${cycleStart}&endTs=${cycleEnd}&fidelity=60`),
            fetchJSON(`${CLOB_API}/prices-history?market=${noTokenId}&startTs=${cycleStart}&endTs=${cycleEnd}&fidelity=60`)
        ]);
    } catch (e) {
        return { slug, asset, epoch, utcHour, error: e.message };
    }

    const yesPoints = yesHistory?.history || [];
    const noPoints = noHistory?.history || [];

    if (yesPoints.length === 0 && noPoints.length === 0) {
        return { slug, asset, epoch, utcHour, error: 'NO_DATA', resolved: !!market.closed };
    }

    // Build minute-by-minute price map
    const minutePrices = {};
    for (let m = 0; m < 15; m++) {
        const minStart = cycleStart + m * 60;
        const minEnd = minStart + 60;

        // Find closest price point within this minute
        const yesInMin = yesPoints.filter(p => p.t >= minStart && p.t < minEnd);
        const noInMin = noPoints.filter(p => p.t >= minStart && p.t < minEnd);

        minutePrices[m] = {
            yesPrice: yesInMin.length > 0 ? yesInMin[0].p : null,
            noPrice: noInMin.length > 0 ? noInMin[0].p : null,
            yesCount: yesInMin.length,
            noCount: noInMin.length
        };
    }

    // Check strategy matches
    const matches = [];
    const misses = [];
    for (const strat of strategies) {
        if (strat.asset !== asset && strat.asset !== 'ALL') continue;
        if (strat.utcHour !== utcHour) continue;

        const m = strat.entryMinute;
        const priceData = minutePrices[m];
        if (!priceData) continue;

        const entryPrice = strat.direction === 'UP' ? priceData.yesPrice : priceData.noPrice;
        const inBand = entryPrice !== null && entryPrice >= strat.priceMin && entryPrice <= strat.priceMax;

        const record = {
            strategyId: strat.id,
            name: strat.name,
            direction: strat.direction,
            entryMinute: m,
            entryPrice,
            priceMin: strat.priceMin,
            priceMax: strat.priceMax,
            inBand
        };

        if (inBand) matches.push(record);
        else misses.push(record);
    }

    // Determine resolution
    const resolved = !!market.closed;
    let outcome = null;
    if (resolved) {
        try {
            const prices = JSON.parse(market.outcomePrices || '[]');
            if (prices.length >= 2) {
                outcome = parseFloat(prices[0]) > 0.5 ? 'UP' : 'DOWN';
            }
        } catch {}
    }

    return {
        slug, asset, epoch, utcHour, resolved, outcome,
        minutePrices,
        matches,
        misses,
        totalDataPoints: yesPoints.length + noPoints.length
    };
}

async function main() {
    const nowSec = Math.floor(Date.now() / 1000);
    const currentEpoch = computeEpoch(nowSec);

    // Analyze last 48 hours of cycles (192 cycles per asset)
    const hoursBack = 48;
    const cyclesBack = (hoursBack * 3600) / CYCLE_SECONDS;
    const startEpoch = currentEpoch - (cyclesBack * CYCLE_SECONDS);

    console.log(`\nAnalyzing ${cyclesBack} cycles per asset over last ${hoursBack}h`);
    console.log(`Time range: ${new Date(startEpoch*1000).toISOString()} to ${new Date(currentEpoch*1000).toISOString()}`);
    console.log(`Assets: ${ASSETS.join(', ')}`);

    // Only analyze cycles at strategy hours to be efficient
    const strategyHours = new Set(strategies.map(s => s.utcHour));
    console.log(`Strategy hours: ${[...strategyHours].sort((a,b)=>a-b).join(', ')}`);

    const results = [];
    let totalMatches = 0;
    let totalMisses = 0;
    let totalCycles = 0;
    let totalResolved = 0;

    for (const asset of ASSETS) {
        console.log(`\n--- ${asset} ---`);
        for (let epoch = startEpoch; epoch < currentEpoch; epoch += CYCLE_SECONDS) {
            const utcHour = new Date(epoch * 1000).getUTCHours();
            if (!strategyHours.has(utcHour)) continue;

            const result = await analyzeCycle(asset, epoch);
            if (!result || result.error) {
                if (result?.error && result.error !== 'NO_DATA') {
                    console.log(`  ${asset} epoch=${epoch} H${utcHour} ERROR: ${result.error}`);
                }
                continue;
            }

            totalCycles++;
            if (result.resolved) totalResolved++;
            totalMatches += result.matches.length;
            totalMisses += result.misses.length;

            if (result.matches.length > 0) {
                for (const m of result.matches) {
                    console.log(`  ✅ ${asset} H${String(utcHour).padStart(2,'0')}:${String(m.entryMinute).padStart(2,'0')} ${m.direction} @${(m.entryPrice*100).toFixed(1)}c [${(m.priceMin*100).toFixed(0)}-${(m.priceMax*100).toFixed(0)}c] → ${result.outcome || '?'}`);
                }
            }

            results.push(result);
            await sleep(RATE_LIMIT_MS);
        }
    }

    // Summary
    console.log(`\n========== SUMMARY ==========`);
    console.log(`Cycles analyzed: ${totalCycles}`);
    console.log(`Resolved: ${totalResolved}`);
    console.log(`Strategy matches (in-band): ${totalMatches}`);
    console.log(`Strategy misses (out-of-band): ${totalMisses}`);
    console.log(`Match rate: ${totalCycles > 0 ? ((totalMatches / (totalMatches + totalMisses)) * 100).toFixed(1) : 'N/A'}%`);
    console.log(`Matches per day (projected): ${totalCycles > 0 ? (totalMatches / (hoursBack/24)).toFixed(1) : 'N/A'}`);

    // Per-strategy analysis
    const stratStats = {};
    for (const r of results) {
        for (const m of [...r.matches, ...r.misses]) {
            if (!stratStats[m.strategyId]) {
                stratStats[m.strategyId] = { name: m.name, direction: m.direction, total: 0, inBand: 0, prices: [], wins: 0, losses: 0 };
            }
            stratStats[m.strategyId].total++;
            if (m.inBand) {
                stratStats[m.strategyId].inBand++;
                stratStats[m.strategyId].prices.push(m.entryPrice);
                if (r.resolved && r.outcome) {
                    if (r.outcome === m.direction) stratStats[m.strategyId].wins++;
                    else stratStats[m.strategyId].losses++;
                }
            }
        }
    }

    console.log(`\n--- Per-Strategy In-Band Rate (last ${hoursBack}h) ---`);
    for (const [id, stats] of Object.entries(stratStats).sort((a,b) => b[1].inBand - a[1].inBand)) {
        const avgPrice = stats.prices.length > 0 ? (stats.prices.reduce((a,b) => a+b, 0) / stats.prices.length) : 0;
        const wr = (stats.wins + stats.losses) > 0 ? (stats.wins / (stats.wins + stats.losses) * 100).toFixed(1) : 'N/A';
        console.log(`  S${id} ${stats.name}: ${stats.inBand}/${stats.total} in-band (${(stats.inBand/Math.max(1,stats.total)*100).toFixed(0)}%) avgEntry=${(avgPrice*100).toFixed(1)}c WR=${wr}% (${stats.wins}W/${stats.losses}L)`);
    }

    // Also check: what price DO the DOWN/UP tokens actually trade at during strategy minutes?
    console.log(`\n--- Actual Price Distribution at Strategy Minutes ---`);
    for (const w of uniqueWindows) {
        const relevantResults = results.filter(r => r.utcHour === w.utcHour);
        const prices = [];
        for (const r of relevantResults) {
            const mp = r.minutePrices[w.entryMinute];
            if (!mp) continue;
            const p = w.direction === 'UP' ? mp.yesPrice : mp.noPrice;
            if (p !== null) prices.push(p);
        }
        if (prices.length === 0) continue;
        prices.sort((a,b) => a - b);
        const median = prices[Math.floor(prices.length/2)];
        const p10 = prices[Math.floor(prices.length * 0.1)];
        const p90 = prices[Math.floor(prices.length * 0.9)];
        const inBandCount = prices.filter(p => p >= w.priceMin && p <= w.priceMax).length;
        console.log(`  H${String(w.utcHour).padStart(2,'0')} m${w.entryMinute} ${w.direction}: n=${prices.length} p10=${(p10*100).toFixed(0)}c median=${(median*100).toFixed(0)}c p90=${(p90*100).toFixed(0)}c band=[${(w.priceMin*100).toFixed(0)}-${(w.priceMax*100).toFixed(0)}c] inBand=${inBandCount}/${prices.length} (${(inBandCount/prices.length*100).toFixed(0)}%)`);
    }

    // Also do a WIDER band analysis: what if we used 40-80c or 30-70c bands?
    console.log(`\n--- Alternative Band Analysis (if we widened bands) ---`);
    const altBands = [[0.30, 0.70], [0.35, 0.75], [0.40, 0.80], [0.45, 0.85], [0.50, 0.90]];
    for (const w of uniqueWindows) {
        const relevantResults = results.filter(r => r.utcHour === w.utcHour);
        const prices = [];
        for (const r of relevantResults) {
            const mp = r.minutePrices[w.entryMinute];
            if (!mp) continue;
            const p = w.direction === 'UP' ? mp.yesPrice : mp.noPrice;
            if (p !== null) prices.push({ price: p, outcome: r.outcome, direction: w.direction });
        }
        if (prices.length === 0) continue;
        console.log(`  H${String(w.utcHour).padStart(2,'0')} m${w.entryMinute} ${w.direction}:`);
        for (const [bMin, bMax] of altBands) {
            const inBand = prices.filter(p => p.price >= bMin && p.price <= bMax);
            const wins = inBand.filter(p => p.outcome === p.direction).length;
            const losses = inBand.filter(p => p.outcome && p.outcome !== p.direction).length;
            const wr = (wins + losses) > 0 ? (wins / (wins + losses) * 100).toFixed(1) : 'N/A';
            console.log(`    [${(bMin*100).toFixed(0)}-${(bMax*100).toFixed(0)}c] ${inBand.length}/${prices.length} trades WR=${wr}% (${wins}W/${losses}L)`);
        }
    }

    // Save full results
    const outPath = process.env.OUTPUT_PATH
        ? path.resolve(process.env.OUTPUT_PATH)
        : path.join(__dirname, '..', 'debug', 'exhaustive_live_audit_results_exhaustive_nc13.json');
    fs.writeFileSync(outPath, JSON.stringify({
        generatedAt: new Date().toISOString(),
        strategyPath,
        hoursBack,
        totalCycles,
        totalResolved,
        totalMatches,
        totalMisses,
        perStrategy: stratStats,
        uniqueWindows
    }, null, 2));
    console.log(`\nFull results saved to ${outPath}`);
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
