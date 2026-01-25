// 🔥 MAXIMUM HISTORICAL BACKTEST
// Fetches AS MUCH data as possible from Polymarket
// Target: Weeks to months of data
//
// Strategy: Fetch in batches going back further each time
// until we hit the limit of available data

const https = require('https');
const fs = require('fs');

const ASSETS = ['btc', 'eth', 'sol'];

async function fetchMarket(slug) {
    return new Promise((resolve) => {
        const url = `https://gamma-api.polymarket.com/markets?slug=${encodeURIComponent(slug)}`;
        https.get(url, { timeout: 5000 }, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    const parsed = JSON.parse(data);
                    resolve(parsed[0] || null);
                } catch {
                    resolve(null);
                }
            });
        }).on('error', () => resolve(null)).on('timeout', () => resolve(null));
    });
}

async function main() {
    const now = Math.floor(Date.now() / 1000);
    const currentEpoch = now - (now % 900);

    // Try to go back as far as possible - 30 DAYS (2880 cycles)
    // This will take ~15-20 minutes but gives us real data
    const DAYS_BACK = 30;
    const cycleCount = DAYS_BACK * 24 * 4;

    console.log(`🔥 MAXIMUM HISTORICAL BACKTEST FETCH`);
    console.log(`Target: ${DAYS_BACK} days of data`);
    console.log(`Cycles to fetch: ${cycleCount} × 3 assets = ${cycleCount * 3} requests`);
    console.log(`Start: ${new Date((currentEpoch - cycleCount * 900) * 1000).toISOString()}`);
    console.log(`End: ${new Date(currentEpoch * 1000).toISOString()}`);
    console.log(`\n⚠️ This will take ~15-20 minutes. Please wait...\n`);

    const results = [];
    let fetched = 0;
    let errors = 0;
    let notFound = 0;
    let consecutiveNotFound = 0;
    const startTime = Date.now();

    // Fetch from newest to oldest
    for (let i = 2; i < cycleCount; i++) {
        const epoch = currentEpoch - (i * 900);

        for (const asset of ASSETS) {
            const slug = `${asset}-updown-15m-${epoch}`;
            const market = await fetchMarket(slug);

            if (market) {
                consecutiveNotFound = 0;
                const prices = JSON.parse(market.outcomePrices || '[]');
                const resolved = market.closed && prices.length >= 2;
                const outcome = resolved ? (Number(prices[0]) > 0.5 ? 'UP' : 'DOWN') : 'UNRESOLVED';

                results.push({
                    epoch,
                    time: new Date(epoch * 1000).toISOString(),
                    asset: asset.toUpperCase(),
                    slug,
                    outcome,
                    volume: market.volumeNum || 0,
                    outcomePrices: prices
                });
                fetched++;
            } else {
                notFound++;
                consecutiveNotFound++;
            }

            // If we get 20 consecutive not-founds, we've hit the limit
            if (consecutiveNotFound >= 20) {
                console.log(`\n⚠️ Hit data limit at cycle ${i} (${new Date(epoch * 1000).toISOString()})`);
                break;
            }

            // Rate limit
            await new Promise(r => setTimeout(r, 80));
        }

        if (consecutiveNotFound >= 20) break;

        // Progress every 100 cycles
        if (i % 100 === 0) {
            const elapsed = (Date.now() - startTime) / 1000 / 60;
            const pct = (i / cycleCount * 100).toFixed(1);
            console.log(`Progress: ${i}/${cycleCount} cycles (${pct}%), fetched=${fetched}, elapsed=${elapsed.toFixed(1)}min`);
        }
    }

    const elapsed = (Date.now() - startTime) / 1000 / 60;
    console.log(`\n=== FETCH COMPLETE ===`);
    console.log(`Total fetched: ${fetched} cycles`);
    console.log(`Not found: ${notFound}`);
    console.log(`Time: ${elapsed.toFixed(1)} minutes`);

    // Save results
    fs.writeFileSync('polymarket_max_history.json', JSON.stringify(results, null, 2));
    console.log('\nSaved to polymarket_max_history.json');

    // Quick summary
    const resolved = results.filter(r => r.outcome !== 'UNRESOLVED');
    console.log(`\n=== SUMMARY ===`);
    console.log(`Resolved cycles: ${resolved.length}`);

    const firstDate = results.length > 0 ? results[results.length - 1].time : 'N/A';
    const lastDate = results.length > 0 ? results[0].time : 'N/A';
    console.log(`Date range: ${firstDate} to ${lastDate}`);

    for (const asset of ['BTC', 'ETH', 'SOL']) {
        const assetResults = resolved.filter(r => r.asset === asset);
        const up = assetResults.filter(r => r.outcome === 'UP').length;
        const down = assetResults.filter(r => r.outcome === 'DOWN').length;
        console.log(`${asset}: UP=${up}, DOWN=${down}, Total=${assetResults.length}`);
    }
}

main().catch(console.error);
