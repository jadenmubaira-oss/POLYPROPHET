#!/usr/bin/env node
/**
 * Historical Data Collector for Polymarket Crypto Up/Down Markets
 * 
 * Collects resolved market outcomes for strategy analysis across:
 * - Timeframes: 5m, 15m, 4h
 * - Assets: BTC, ETH, SOL, XRP, DOGE, BNB, HYPE
 * 
 * For each resolved market, records:
 * - Asset, timeframe, epoch, UTC hour, cycle minute
 * - Opening YES/NO prices (from CLOB book at cycle start)
 * - Resolution outcome (UP or DOWN)
 * - Volume, liquidity
 * 
 * Usage: node scripts/collect-historical.js [--days=30] [--timeframe=15m] [--asset=btc]
 */

const https = require('https');
const fs = require('fs');
const path = require('path');

const GAMMA_API = 'https://gamma-api.polymarket.com';

const ASSETS = ['btc', 'eth', 'sol', 'xrp', 'doge', 'bnb', 'hype'];
const TIMEFRAMES = [
    { key: '5m', seconds: 300 },
    { key: '15m', seconds: 900 },
    { key: '4h', seconds: 14400 }
];

function parseArgs() {
    const args = {};
    process.argv.slice(2).forEach(a => {
        const [k, v] = a.replace(/^--/, '').split('=');
        args[k] = v || 'true';
    });
    return args;
}

function fetchJSON(url) {
    return new Promise((resolve, reject) => {
        const req = https.get(url, { timeout: 15000 }, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    resolve(JSON.parse(data));
                } catch (e) {
                    reject(new Error(`JSON parse error for ${url}: ${e.message}`));
                }
            });
        });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    });
}

function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
}

async function collectForTimeframe(asset, tf, startEpoch, endEpoch) {
    const results = [];
    // Align start epoch to session boundary
    let epoch = Math.floor(startEpoch / tf.seconds) * tf.seconds;
    let consecutive_errors = 0;
    let checked = 0;
    let found = 0;

    while (epoch <= endEpoch) {
        const slug = `${asset}-updown-${tf.key}-${epoch}`;
        checked++;

        try {
            const markets = await fetchJSON(`${GAMMA_API}/markets?slug=${slug}`);
            
            if (Array.isArray(markets) && markets.length > 0) {
                const m = markets[0];
                consecutive_errors = 0;
                found++;

                // Parse outcomes and prices
                let outcomes = [];
                let prices = [];
                try { outcomes = JSON.parse(m.outcomes || '[]'); } catch {}
                try { prices = JSON.parse(m.outcomePrices || '[]'); } catch {}

                const upIdx = outcomes.findIndex(o => /^(yes|up)$/i.test(String(o).trim()));
                const downIdx = outcomes.findIndex(o => /^(no|down)$/i.test(String(o).trim()));

                // outcomePrices contains FINAL resolution prices for closed markets
                // For resolved: ["1","0"] means UP won, ["0","1"] means DOWN won
                const upPrice = upIdx >= 0 && prices[upIdx] ? parseFloat(prices[upIdx]) : null;
                const downPrice = downIdx >= 0 && prices[downIdx] ? parseFloat(prices[downIdx]) : null;

                // For active markets, these are live prices. For closed, they're resolution.
                const yesPrice = upPrice;
                const noPrice = downPrice;

                // Determine winner from resolution prices
                let winner = null;
                if (m.closed === true) {
                    if (upPrice !== null && upPrice >= 0.95) winner = 'UP';
                    else if (downPrice !== null && downPrice >= 0.95) winner = 'DOWN';
                    else if (upPrice !== null && upPrice <= 0.05) winner = 'DOWN';
                    else if (downPrice !== null && downPrice <= 0.05) winner = 'UP';
                }
                // Also check lastTradePrice as backup
                if (!winner && m.closed === true && m.lastTradePrice) {
                    const ltp = parseFloat(m.lastTradePrice);
                    if (ltp >= 0.95) winner = 'UP';
                    else if (ltp <= 0.05) winner = 'DOWN';
                }

                const cycleDate = new Date(epoch * 1000);
                const utcHour = cycleDate.getUTCHours();
                const utcMinute = cycleDate.getUTCMinutes();

                results.push({
                    asset: asset.toUpperCase(),
                    timeframe: tf.key,
                    epoch,
                    slug,
                    utcHour,
                    utcMinute,
                    date: cycleDate.toISOString().split('T')[0],
                    dayOfWeek: cycleDate.getUTCDay(),
                    yesPrice,
                    noPrice,
                    volume: m.volume ? parseFloat(m.volume) : null,
                    liquidity: m.liquidity ? parseFloat(m.liquidity) : null,
                    closed: !!m.closed,
                    active: !!m.active,
                    winner,
                    resolution: m.resolution || null
                });

                // Incremental save every 500 records
                if (results.length % 500 === 0) {
                    const partialPath = path.join(__dirname, '..', 'data', `${asset}_${tf.key}_partial.json`);
                    fs.writeFileSync(partialPath, JSON.stringify(results, null, 2));
                }
            } else {
                consecutive_errors++;
            }

            // Rate limiting — be respectful to Gamma API
            await sleep(100);

        } catch (e) {
            consecutive_errors++;
            if (consecutive_errors > 20) {
                console.log(`  Too many consecutive errors for ${asset} ${tf.key} at epoch ${epoch}, skipping ahead`);
                consecutive_errors = 0;
            }
            await sleep(200);
        }

        epoch += tf.seconds;

        // Progress logging
        if (checked % 100 === 0) {
            const pct = ((epoch - startEpoch) / (endEpoch - startEpoch) * 100).toFixed(1);
            console.log(`  ${asset.toUpperCase()} ${tf.key}: ${pct}% done (${found} markets found / ${checked} checked)`);
        }
    }

    return results;
}

async function main() {
    const args = parseArgs();
    const days = parseInt(args.days) || 30;
    const filterAsset = args.asset ? args.asset.toLowerCase() : null;
    const filterTf = args.timeframe || null;

    const nowSec = Math.floor(Date.now() / 1000);
    const endEpoch = nowSec;
    const startEpoch = nowSec - (days * 86400);

    const assets = filterAsset ? [filterAsset] : ASSETS;
    const timeframes = filterTf ? TIMEFRAMES.filter(t => t.key === filterTf) : TIMEFRAMES;

    console.log(`\n=== Polymarket Historical Data Collector ===`);
    console.log(`Period: ${days} days (${new Date(startEpoch * 1000).toISOString().split('T')[0]} to ${new Date(endEpoch * 1000).toISOString().split('T')[0]})`);
    console.log(`Assets: ${assets.map(a => a.toUpperCase()).join(', ')}`);
    console.log(`Timeframes: ${timeframes.map(t => t.key).join(', ')}`);
    console.log('');

    const allResults = {};
    const dataDir = path.join(__dirname, '..', 'data');
    if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

    for (const tf of timeframes) {
        for (const asset of assets) {
            console.log(`Collecting ${asset.toUpperCase()} ${tf.key} (${days} days)...`);
            const results = await collectForTimeframe(asset, tf, startEpoch, endEpoch);
            
            const key = `${asset}_${tf.key}`;
            allResults[key] = results;

            // Save per-asset-timeframe file
            const filePath = path.join(dataDir, `${key}_${days}d.json`);
            fs.writeFileSync(filePath, JSON.stringify(results, null, 2));
            
            const resolved = results.filter(r => r.winner);
            const ups = resolved.filter(r => r.winner === 'UP').length;
            const downs = resolved.filter(r => r.winner === 'DOWN').length;
            
            console.log(`  ${asset.toUpperCase()} ${tf.key}: ${results.length} markets found, ${resolved.length} resolved (${ups} UP / ${downs} DOWN)`);
            console.log(`  Saved to ${filePath}\n`);
        }
    }

    // Write combined summary
    const summary = {};
    for (const [key, results] of Object.entries(allResults)) {
        const resolved = results.filter(r => r.winner);
        summary[key] = {
            total: results.length,
            resolved: resolved.length,
            up: resolved.filter(r => r.winner === 'UP').length,
            down: resolved.filter(r => r.winner === 'DOWN').length,
            upPct: resolved.length > 0 ? (resolved.filter(r => r.winner === 'UP').length / resolved.length * 100).toFixed(1) : 'N/A'
        };
    }

    const summaryPath = path.join(dataDir, `collection_summary_${days}d.json`);
    fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2));
    console.log(`\n=== Summary saved to ${summaryPath} ===`);
    console.log(JSON.stringify(summary, null, 2));
}

main().catch(e => { console.error('FATAL:', e); process.exit(1); });
