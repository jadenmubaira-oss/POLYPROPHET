// 🔍 MAXIMUM HISTORICAL DATA FETCH - 90 DAYS (Markets started Oct 21, 2025)
// Polymarket 15-min crypto markets launched October 21, 2025

const https = require('https');
const fs = require('fs');

const ASSETS = ['BTC', 'ETH', 'SOL'];
const MARKET_START = new Date('2025-10-21T00:00:00Z');
const NOW = new Date();

console.log('🔍 FETCHING MAXIMUM HISTORICAL DATA');
console.log('===================================\n');
console.log('Market launch: Oct 21, 2025');
console.log('Current date: ' + NOW.toISOString().split('T')[0]);

const daysSinceLaunch = Math.floor((NOW - MARKET_START) / (1000 * 60 * 60 * 24));
console.log('Days of data available: ' + daysSinceLaunch);
console.log('\nThis will take a while. Fetching...\n');

const outcomes = [];
let fetched = 0;
let notFound = 0;

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function fetchMarket(slug) {
    return new Promise((resolve) => {
        const url = 'https://gamma-api.polymarket.com/markets?slug=' + slug + '&closed=true';

        https.get(url, { timeout: 15000 }, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    const markets = JSON.parse(data);
                    resolve(markets.length > 0 ? markets[0] : null);
                } catch (e) {
                    resolve(null);
                }
            });
        }).on('error', () => resolve(null))
            .on('timeout', () => resolve(null));
    });
}

function get15MinEpoch(d) {
    return Math.floor(d.getTime() / 1000 / 900) * 900;
}

async function main() {
    const startTime = Date.now();
    const startEpoch = get15MinEpoch(MARKET_START);
    const endEpoch = get15MinEpoch(NOW);

    // Generate all epochs
    const epochs = [];
    for (let epoch = endEpoch; epoch >= startEpoch; epoch -= 900) {
        epochs.push(epoch);
    }

    console.log('Total epochs to check: ' + epochs.length);
    console.log('Estimated time: ' + Math.ceil(epochs.length * ASSETS.length * 0.1 / 60) + ' minutes\n');

    let lastFoundEpoch = null;
    let firstNotFoundAfterFound = null;

    for (let i = 0; i < epochs.length; i++) {
        const epoch = epochs[i];

        for (const asset of ASSETS) {
            const slug = asset.toLowerCase() + '-updown-15m-' + epoch;
            const market = await fetchMarket(slug);

            if (market) {
                lastFoundEpoch = epoch;
                let outcome = 'UNRESOLVED';
                if (market.outcome === 'Yes' || market.outcome === 'yes') outcome = 'UP';
                else if (market.outcome === 'No' || market.outcome === 'no') outcome = 'DOWN';

                outcomes.push({
                    asset,
                    epoch,
                    date: new Date(epoch * 1000).toISOString(),
                    outcome,
                    slug
                });
                fetched++;
            } else {
                notFound++;
                // If we've found data before and now not finding, we've hit the end
                if (lastFoundEpoch && !firstNotFoundAfterFound && epoch < lastFoundEpoch - 86400) {
                    firstNotFoundAfterFound = epoch;
                }
            }

            await sleep(60);  // Rate limiting
        }

        // Progress update every 100 epochs
        if ((i + 1) % 100 === 0) {
            const elapsed = ((Date.now() - startTime) / 60000).toFixed(1);
            const pct = ((i + 1) / epochs.length * 100).toFixed(1);
            console.log('Progress: ' + (i + 1) + '/' + epochs.length + ' (' + pct + '%), fetched=' + fetched + ', elapsed=' + elapsed + 'min');

            // Save intermediate results
            fs.writeFileSync('polymarket_90day_history.json', JSON.stringify(outcomes, null, 2));
        }

        // Stop early if we haven't found any data for a while (no point going back further)
        if (notFound > 500 && fetched === 0) {
            console.log('\nNo data found in first 500 attempts. Markets may not have data this old.');
            break;
        }
    }

    // Final save
    fs.writeFileSync('polymarket_90day_history.json', JSON.stringify(outcomes, null, 2));

    const elapsed = ((Date.now() - startTime) / 60000).toFixed(1);
    console.log('\n=== FETCH COMPLETE ===');
    console.log('Total fetched: ' + fetched + ' cycles');
    console.log('Not found: ' + notFound);
    console.log('Time: ' + elapsed + ' minutes');

    if (outcomes.length > 0) {
        const sorted = outcomes.sort((a, b) => a.epoch - b.epoch);
        const firstDate = new Date(sorted[0].epoch * 1000).toISOString().split('T')[0];
        const lastDate = new Date(sorted[sorted.length - 1].epoch * 1000).toISOString().split('T')[0];
        const daysCovered = (sorted[sorted.length - 1].epoch - sorted[0].epoch) / 86400;

        console.log('\nDate range: ' + firstDate + ' to ' + lastDate);
        console.log('Days covered: ' + daysCovered.toFixed(1));
        console.log('Cycles per asset: ~' + Math.round(fetched / ASSETS.length));
    }

    console.log('\nSaved to polymarket_90day_history.json');
}

main().catch(console.error);
