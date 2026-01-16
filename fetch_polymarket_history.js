// Quick script to fetch historical Polymarket cycle outcomes
// This will help analyze real outcomes for backtest validation

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

    // Go back 24 hours (96 cycles) - 12 hours for faster test
    const cycleCount = 48;

    const results = [];

    for (let i = 2; i < cycleCount; i++) {
        const epoch = currentEpoch - (i * 900);

        for (const asset of ASSETS) {
            const slug = `${asset}-updown-15m-${epoch}`;
            const market = await fetchMarket(slug);

            if (market) {
                const prices = JSON.parse(market.outcomePrices || '[]');
                const resolved = market.closed && prices.length >= 2;
                const outcome = resolved ? (Number(prices[0]) > 0.5 ? 'UP' : 'DOWN') : 'UNRESOLVED';

                const time = new Date(epoch * 1000).toISOString();
                console.log(`${time} | ${asset.toUpperCase()} | ${outcome} | vol=$${(market.volumeNum || 0).toFixed(0)}`);

                results.push({
                    epoch,
                    time,
                    asset: asset.toUpperCase(),
                    slug,
                    outcome,
                    volume: market.volumeNum || 0,
                    outcomePrices: prices
                });
            }

            // Rate limit
            await new Promise(r => setTimeout(r, 100));
        }
    }

    console.log(`\n=== SUMMARY ===`);
    console.log(`Total cycles fetched: ${results.length}`);

    // Count UP vs DOWN for each asset
    for (const asset of ['BTC', 'ETH', 'SOL']) {
        const assetResults = results.filter(r => r.asset === asset && r.outcome !== 'UNRESOLVED');
        const upCount = assetResults.filter(r => r.outcome === 'UP').length;
        const downCount = assetResults.filter(r => r.outcome === 'DOWN').length;
        console.log(`${asset}: UP=${upCount}, DOWN=${downCount}, Total=${assetResults.length}`);
    }

    // Save to JSON for further analysis
    fs.writeFileSync('polymarket_outcomes.json', JSON.stringify(results, null, 2));
    console.log('\nSaved detailed results to polymarket_outcomes.json');
}

main().catch(console.error);
