#!/usr/bin/env node
/**
 * Cross-validate top signals against May 2-9 window.
 * Only fetches the specific hour/minute slots that showed >75% WR in May 13-20.
 * This is more efficient than fetching all 676 cycles again.
 */

'use strict';
const https = require('https');
const fs = require('fs');
const path = require('path');

const ASSETS = ['btc', 'eth', 'sol', 'xrp', 'bnb', 'doge'];
const CYCLE_SECONDS = 900;

// Top signals to cross-validate (from May 13-20 analysis)
const TOP_SIGNALS = [
    { key: 'H1_M15_DOWN', hour: 1, minute: 15, dir: 'DOWN' },
    { key: 'H12_M30_UP', hour: 12, minute: 30, dir: 'UP' },
    { key: 'H13_M0_DOWN', hour: 13, minute: 0, dir: 'DOWN' },
    { key: 'H7_M15_UP', hour: 7, minute: 15, dir: 'UP' },
    { key: 'H9_M0_DOWN', hour: 9, minute: 0, dir: 'DOWN' },
    { key: 'H11_M45_DOWN', hour: 11, minute: 45, dir: 'DOWN' },
    { key: 'H12_M15_UP', hour: 12, minute: 15, dir: 'UP' },
    { key: 'H16_M0_UP', hour: 16, minute: 0, dir: 'UP' },
    { key: 'H8_M30_UP', hour: 8, minute: 30, dir: 'UP' },
    { key: 'H19_M30_UP', hour: 19, minute: 30, dir: 'UP' },
    { key: 'H5_M15_DOWN', hour: 5, minute: 15, dir: 'DOWN' },
    { key: 'H4_M15_DOWN', hour: 4, minute: 15, dir: 'DOWN' },
    { key: 'H3_M15_UP', hour: 3, minute: 15, dir: 'UP' },
    { key: 'H2_M30_DOWN', hour: 2, minute: 30, dir: 'DOWN' },
    { key: 'H23_M45_DOWN', hour: 23, minute: 45, dir: 'DOWN' },
    { key: 'H13_M15_DOWN', hour: 13, minute: 15, dir: 'DOWN' },
    { key: 'H12_M0_UP', hour: 12, minute: 0, dir: 'UP' },
    { key: 'H13_M30_DOWN', hour: 13, minute: 30, dir: 'DOWN' },
    { key: 'H6_M15_DOWN', hour: 6, minute: 15, dir: 'DOWN' },
];

function httpGet(url) {
    return new Promise((resolve) => {
        const req = https.get(url, { timeout: 10000 }, (res) => {
            const chunks = [];
            res.on('data', c => chunks.push(c));
            res.on('end', () => {
                try { resolve(JSON.parse(chunks.join(''))); }
                catch { resolve(null); }
            });
        });
        req.on('error', () => resolve(null));
        req.on('timeout', () => { req.destroy(); resolve(null); });
    });
}

async function fetchMarketBySlug(slug) {
    const url = `https://gamma-api.polymarket.com/markets/slug/${encodeURIComponent(slug)}`;
    const data = await httpGet(url);
    if (!data) return null;
    if (Array.isArray(data)) return data.length > 0 ? data[0] : null;
    if (typeof data === 'object' && data.id) return data;
    return null;
}

function parseOutcome(market) {
    if (!market) return null;
    if (!market.closed) return null;
    try {
        const prices = JSON.parse(market.outcomePrices || '[]');
        if (prices.length < 2) return null;
        const upPrice = Number(prices[0]);
        const downPrice = Number(prices[1]);
        if (upPrice > 0.95) return 'UP';
        if (downPrice > 0.95) return 'DOWN';
        return null;
    } catch { return null; }
}

function cycleSlug(asset, epoch) {
    return `${asset}-updown-15m-${epoch}`;
}

// Build list of epochs in May 2-9 that match the target signals
function buildEpochList() {
    const start = new Date('2026-05-02T00:00:00Z').getTime() / 1000;
    const end = new Date('2026-05-10T00:00:00Z').getTime() / 1000;
    
    const epochs = [];
    let t = Math.floor(start / CYCLE_SECONDS) * CYCLE_SECONDS;
    while (t < end) {
        const dt = new Date(t * 1000);
        const h = dt.getUTCHours();
        const m = dt.getUTCMinutes();
        
        // Only include cycles that match our target signal times
        const matches = TOP_SIGNALS.some(sig => sig.hour === h && sig.minute === m);
        if (matches) {
            epochs.push(t);
        }
        t += CYCLE_SECONDS;
    }
    return epochs;
}

async function main() {
    const cacheFile = path.join(__dirname, '../debug/may2_9_crossval_raw.json');
    
    let records = [];
    
    if (fs.existsSync(cacheFile)) {
        console.log('Loading cached May 2-9 cross-validation data...');
        records = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
        console.log(`Loaded ${records.length} records from cache\n`);
    } else {
        console.log('\n=== MAY 2-9 CROSS-VALIDATION FETCH ===');
        
        const epochs = buildEpochList();
        console.log(`Target epochs: ${epochs.length} (${TOP_SIGNALS.length} signals × ~8 days)`);
        console.log(`Total fetches: ${epochs.length} × ${ASSETS.length} = ${epochs.length * ASSETS.length}`);
        
        let fetched = 0;
        let resolved = 0;
        
        for (const epoch of epochs) {
            const promises = ASSETS.map(asset => fetchMarketBySlug(cycleSlug(asset, epoch)));
            const results = await Promise.all(promises);
            
            const dt = new Date(epoch * 1000);
            for (let ai = 0; ai < ASSETS.length; ai++) {
                fetched++;
                const outcome = parseOutcome(results[ai]);
                if (outcome) {
                    records.push({
                        epoch,
                        iso: dt.toISOString(),
                        utcHour: dt.getUTCHours(),
                        utcMinute: dt.getUTCMinutes(),
                        asset: ASSETS[ai].toUpperCase(),
                        outcome
                    });
                    resolved++;
                }
            }
            
            if (fetched % 60 === 0) {
                process.stdout.write(`  Fetched: ${fetched}/${epochs.length * ASSETS.length}, resolved: ${resolved}\r`);
            }
        }
        
        console.log(`\nFetch complete: ${fetched} queries, ${resolved} resolved`);
        fs.writeFileSync(cacheFile, JSON.stringify(records));
    }
    
    // Analyze win rates
    const signalStats = {};
    for (const sig of TOP_SIGNALS) {
        signalStats[sig.key] = { w: 0, t: 0, dir: sig.dir };
    }
    
    for (const rec of records) {
        const h = rec.utcHour;
        const m = rec.utcMinute;
        for (const sig of TOP_SIGNALS) {
            if (sig.hour === h && sig.minute === m) {
                const won = sig.dir === rec.outcome;
                signalStats[sig.key].t++;
                if (won) signalStats[sig.key].w++;
            }
        }
    }
    
    // May 13-20 reference WRs
    const may1320 = {
        'H1_M15_DOWN': 0.929, 'H12_M30_UP': 0.857, 'H13_M0_DOWN': 0.857,
        'H7_M15_UP': 0.833, 'H9_M0_DOWN': 0.810, 'H11_M45_DOWN': 0.786,
        'H12_M15_UP': 0.786, 'H16_M0_UP': 0.771, 'H8_M30_UP': 0.762,
        'H19_M30_UP': 0.762, 'H5_M15_DOWN': 0.738, 'H4_M15_DOWN': 0.738,
        'H3_M15_UP': 0.738, 'H2_M30_DOWN': 0.738, 'H23_M45_DOWN': 0.738,
        'H13_M15_DOWN': 0.714, 'H12_M0_UP': 0.714, 'H13_M30_DOWN': 0.690,
        'H6_M15_DOWN': 0.643
    };
    
    console.log('\n=== CROSS-VALIDATION RESULTS ===');
    console.log(`${'Signal'.padEnd(20)} | May13-20 | May2-9   | Robust? | Keep?`);
    console.log(`${''.padEnd(20, '-')} | -------- | -------- | ------- | -----`);
    
    const robustSignals = [];
    const droppedSignals = [];
    
    for (const sig of TOP_SIGNALS) {
        const stats = signalStats[sig.key];
        const wr1320 = may1320[sig.key] || 0;
        const wr29 = stats.t > 0 ? stats.w / stats.t : null;
        
        const robust = wr29 !== null && wr29 >= 0.58 && wr1320 >= 0.65;
        const keep = robust;
        
        const wr29Str = wr29 !== null ? `${(wr29*100).toFixed(1)}% (${stats.w}/${stats.t})` : 'N/A';
        
        console.log(`${sig.key.padEnd(20)} | ${(wr1320*100).toFixed(1)}%     | ${wr29Str.padEnd(8)} | ${robust ? 'YES' : 'NO '}     | ${keep ? 'KEEP' : 'DROP'}`);
        
        if (keep) {
            robustSignals.push({
                key: sig.key,
                hour: sig.hour,
                minute: sig.minute,
                dir: sig.dir,
                wr_may1320: wr1320,
                wr_may29: wr29,
                combined_wr: (wr1320 + (wr29 || wr1320)) / 2,
                n_may29: stats.t
            });
        } else {
            droppedSignals.push({ key: sig.key, reason: wr29 !== null ? `May2-9 WR ${(wr29*100).toFixed(1)}% < 58%` : 'No May2-9 data' });
        }
    }
    
    robustSignals.sort((a, b) => b.combined_wr - a.combined_wr);
    
    console.log('\n=== ROBUST CROSS-VALIDATED SIGNALS ===');
    for (const s of robustSignals) {
        console.log(`  ${s.key}: combined WR=${((s.combined_wr)*100).toFixed(1)}% (May13-20: ${(s.wr_may1320*100).toFixed(1)}%, May2-9: ${s.wr_may29 !== null ? (s.wr_may29*100).toFixed(1)+'%' : 'N/A'})`);
    }
    
    console.log('\n=== DROPPED SIGNALS (failed cross-validation) ===');
    for (const s of droppedSignals) {
        console.log(`  ${s.key}: ${s.reason}`);
    }
    
    // Build final optimal portfolio (non-overlapping 15m windows, sorted by combined WR)
    const usedWindows = new Set();
    const finalPortfolio = [];
    
    for (const sig of robustSignals) {
        const windowKey = `H${sig.hour}_M${sig.minute}`;
        if (usedWindows.has(windowKey)) continue;
        usedWindows.add(windowKey);
        finalPortfolio.push(sig);
        if (finalPortfolio.length >= 10) break;
    }
    
    console.log(`\n=== FINAL PORTFOLIO (${finalPortfolio.length} signals, cross-validated) ===`);
    for (const s of finalPortfolio) {
        const kelly = Math.max(0, Math.min(1, 2 * s.combined_wr - 1)) * 0.75;
        const stakeF = Math.min(kelly, 0.60);
        console.log(`  ${s.key}: ${(s.combined_wr*100).toFixed(1)}% combined WR, stake=${(stakeF*100).toFixed(0)}%`);
    }
    
    // Save results
    const output = {
        generatedAt: new Date().toISOString(),
        window1: 'May 13-20 2026',
        window2: 'May 2-9 2026',
        robustSignals,
        droppedSignals,
        finalPortfolio
    };
    const outPath = path.join(__dirname, '../debug/cross_validation_results.json');
    fs.writeFileSync(outPath, JSON.stringify(output, null, 2));
    console.log(`\nResults saved: ${outPath}`);
}

main().catch(e => { console.error('Error:', e); process.exit(1); });
