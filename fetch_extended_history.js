// 🔍 MAXIMUM HISTORICAL DATA FETCH - ATTEMPT 90 DAYS
// User asked: Can we go beyond 30 days? Up to a year?
// Let's try to fetch as much as Polymarket has available

const https = require('https');

const ASSETS = ['BTC', 'ETH', 'SOL'];
const DAYS_TO_FETCH = 90;  // 90 days = 3 months
const CYCLES_PER_DAY = 96;  // 15 min cycles = 96/day
const TOTAL_CYCLES = DAYS_TO_FETCH * CYCLES_PER_DAY;

console.log('🔍 EXTENDED HISTORICAL DATA FETCH');
console.log('==================================\n');
console.log(`Target: ${DAYS_TO_FETCH} days of data`);
console.log(`Cycles to fetch: ${TOTAL_CYCLES.toLocaleString()} × ${ASSETS.length} assets = ${(TOTAL_CYCLES * ASSETS.length).toLocaleString()} requests`);
console.log('');

// Calculate time range
const now = new Date();
const endEpoch = Math.floor(now.getTime() / 1000);
const startEpoch = endEpoch - (DAYS_TO_FETCH * 24 * 60 * 60);

console.log(`Start: ${new Date(startEpoch * 1000).toISOString()}`);
console.log(`End: ${new Date(endEpoch * 1000).toISOString()}`);
console.log('\n⚠️ This will take a while. Fetching in batches...\n');

const outcomes = [];
let fetched = 0;
let notFound = 0;
let errors = 0;

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function fetchMarket(slug) {
    return new Promise((resolve) => {
        const url = `https://gamma-api.polymarket.com/markets?slug=${slug}&closed=true`;

        https.get(url, { timeout: 10000 }, (res) => {
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
        }).on('error', () => resolve(null));
    });
}

function get15MinEpoch(timestamp) {
    return Math.floor(timestamp / 900) * 900;
}

async function main() {
    const startTime = Date.now();

    // Generate all epochs
    const epochs = [];
    for (let epoch = get15MinEpoch(endEpoch); epoch >= get15MinEpoch(startEpoch); epoch -= 900) {
        epochs.push(epoch);
    }

    console.log(`Total epochs to check: ${epochs.length}\n`);

    // Sample check: Test if very old data exists
    console.log('Testing data availability...');
    const testEpoch = startEpoch - (30 * 24 * 60 * 60);  // 30 days before start
    const testSlug = `btc-updown-15m-${testEpoch}`;
    const testResult = await fetchMarket(testSlug);

    if (!testResult) {
        console.log(`⚠️ Data from ${new Date(testEpoch * 1000).toISOString()} not found`);
        console.log('   This suggests 15-min markets may not have been available that far back\n');
    } else {
        console.log(`✅ Found data from ${new Date(testEpoch * 1000).toISOString()}\n`);
    }

    // Fetch in batches with rate limiting
    for (let i = 0; i < epochs.length; i++) {
        const epoch = epochs[i];

        for (const asset of ASSETS) {
            const slug = `${asset.toLowerCase()}-updown-15m-${epoch}`;
            const market = await fetchMarket(slug);

            if (market) {
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
            }

            await sleep(80);  // Rate limiting
        }

        if ((i + 1) % 100 === 0) {
            const elapsed = ((Date.now() - startTime) / 60000).toFixed(1);
            const pct = ((i + 1) / epochs.length * 100).toFixed(1);
            console.log(`Progress: ${i + 1}/${epochs.length} cycles (${pct}%), fetched=${fetched}, notFound=${notFound}, elapsed=${elapsed}min`);
        }
    }

    // Save results
    const fs = require('fs');
    fs.writeFileSync('polymarket_extended_history.json', JSON.stringify(outcomes, null, 2));

    const elapsed = ((Date.now() - startTime) / 60000).toFixed(1);
    console.log('\n=== FETCH COMPLETE ===');
    console.log(`Total fetched: ${fetched} cycles`);
    console.log(`Not found: ${notFound}`);
    console.log(`Time: ${elapsed} minutes`);

    // Analyze date range
    if (outcomes.length > 0) {
        const sorted = outcomes.sort((a, b) => a.epoch - b.epoch);
        console.log(`\nDate range: ${sorted[0].date} to ${sorted[sorted.length - 1].date}`);

        const daysCovered = (sorted[sorted.length - 1].epoch - sorted[0].epoch) / 86400;
        console.log(`Days covered: ${daysCovered.toFixed(1)}`);
    }

    console.log(`\nSaved to polymarket_extended_history.json`);
}

main().catch(console.error);
