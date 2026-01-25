/**
 * 🏆 CHAINLINK-STYLE SECOND-BY-SECOND ANALYSIS
 * 
 * This script fetches 1-minute kline data from Binance (similar to Chainlink oracle data)
 * and analyzes BTC/ETH price movements during golden hours to verify the strategy.
 * 
 * Polymarket uses Chainlink oracles which update ~every minute, so 1-minute data
 * closely mirrors the actual Polymarket resolution behavior.
 */

const fs = require('fs');
const https = require('https');

// Configuration
const SYMBOLS = ['BTCUSDT', 'ETHUSDT'];
const INTERVAL = '1m'; // 1 minute (closest to Chainlink resolution)
const DAYS_TO_FETCH = 30;

// Golden Hours configuration (UTC)
const GOLDEN_HOURS = {
    2: { condition: 'DOWN', wr: 92.9 },
    3: { condition: 'UP', wr: 93.1 },
    4: { condition: 'UP', wr: 91.5 },
    8: { condition: 'UP', wr: 91.7 },
    14: { condition: 'DOWN', wr: 96.1 }
};

// Fetch klines from Binance API
function fetchKlines(symbol, startTime, endTime) {
    return new Promise((resolve, reject) => {
        const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${INTERVAL}&startTime=${startTime}&endTime=${endTime}&limit=1000`;

        https.get(url, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    const parsed = JSON.parse(data);
                    resolve(parsed);
                } catch (e) {
                    reject(e);
                }
            });
        }).on('error', reject);
    });
}

// Main analysis function
async function analyzeGoldenHours() {
    console.log('🏆 CHAINLINK-STYLE SECOND-BY-SECOND ANALYSIS');
    console.log('='.repeat(60));
    console.log(`Fetching ${DAYS_TO_FETCH} days of 1-minute data for BTC and ETH...`);
    console.log('This closely mirrors Chainlink oracle resolution (~1 min updates)');
    console.log('');

    const now = Date.now();
    const thirtyDaysAgo = now - (DAYS_TO_FETCH * 24 * 60 * 60 * 1000);

    const allData = {};

    for (const symbol of SYMBOLS) {
        console.log(`Fetching ${symbol}...`);
        allData[symbol] = [];

        let currentStart = thirtyDaysAgo;
        const msPerRequest = 1000 * 60 * 1000; // 1000 minutes per request

        while (currentStart < now) {
            const endTime = Math.min(currentStart + msPerRequest, now);
            try {
                const klines = await fetchKlines(symbol, currentStart, endTime);
                allData[symbol] = allData[symbol].concat(klines);
                console.log(`  Fetched ${klines.length} klines, total: ${allData[symbol].length}`);
                currentStart = endTime;
                // Small delay to avoid rate limiting
                await new Promise(r => setTimeout(r, 100));
            } catch (e) {
                console.error(`  Error fetching ${symbol}:`, e.message);
                break;
            }
        }
        console.log(`Total ${symbol} klines: ${allData[symbol].length}`);
    }

    // Organize data by 15-minute cycles
    console.log('\n📊 ORGANIZING INTO 15-MINUTE CYCLES...');

    const cycles = {};

    SYMBOLS.forEach(symbol => {
        allData[symbol].forEach(kline => {
            const [openTime, open, high, low, close] = kline;
            const dt = new Date(openTime);
            const utcHour = dt.getUTCHours();
            const utcMin = dt.getUTCMinutes();

            // Calculate cycle start (aligned to 15-min boundaries)
            const cycleStart = openTime - (utcMin % 15) * 60000;
            const cycleKey = cycleStart;

            if (!cycles[cycleKey]) {
                cycles[cycleKey] = {
                    startTime: cycleStart,
                    utcHour,
                    isGoldenHour: GOLDEN_HOURS.hasOwnProperty(utcHour),
                    goldenConfig: GOLDEN_HOURS[utcHour] || null,
                    BTC: [],
                    ETH: []
                };
            }

            const assetKey = symbol === 'BTCUSDT' ? 'BTC' : 'ETH';
            cycles[cycleKey][assetKey].push({
                timestamp: openTime,
                minute: utcMin % 15,
                open: parseFloat(open),
                close: parseFloat(close),
                high: parseFloat(high),
                low: parseFloat(low)
            });
        });
    });

    // Analyze golden hour cycles
    console.log('\n🏆 ANALYZING GOLDEN HOUR CYCLES...\n');

    const results = {
        total: 0,
        wins: 0,
        losses: 0,
        byHour: {},
        trades: []
    };

    Object.keys(GOLDEN_HOURS).forEach(h => {
        results.byHour[h] = { total: 0, wins: 0, condition: GOLDEN_HOURS[h].condition };
    });

    Object.entries(cycles).forEach(([cycleKey, cycle]) => {
        if (!cycle.isGoldenHour) return;
        if (!cycle.goldenConfig) return;
        if (cycle.BTC.length < 12 || cycle.ETH.length < 12) return; // Need at least 12 minutes of data

        // Sort by minute
        cycle.BTC.sort((a, b) => a.timestamp - b.timestamp);
        cycle.ETH.sort((a, b) => a.timestamp - b.timestamp);

        // Calculate cycle outcome (compare first and last price)
        const btcFirst = cycle.BTC[0].open;
        const btcLast = cycle.BTC[cycle.BTC.length - 1].close;
        const btcDirection = btcLast > btcFirst ? 'UP' : 'DOWN';

        const ethFirst = cycle.ETH[0].open;
        const ethLast = cycle.ETH[cycle.ETH.length - 1].close;
        const ethDirection = ethLast > ethFirst ? 'UP' : 'DOWN';

        const expectedBTC = cycle.goldenConfig.condition;

        // Only trade when BTC matches expected direction
        if (btcDirection !== expectedBTC) return;

        // Trade ETH in same direction - is it a win?
        const isWin = ethDirection === btcDirection;

        results.total++;
        if (isWin) results.wins++;
        else results.losses++;

        results.byHour[cycle.utcHour].total++;
        if (isWin) results.byHour[cycle.utcHour].wins++;

        results.trades.push({
            time: new Date(cycle.startTime).toISOString(),
            hour: cycle.utcHour,
            expectedBTC: expectedBTC,
            actualBTC: btcDirection,
            ethDirection,
            isWin,
            btcPriceChange: ((btcLast - btcFirst) / btcFirst * 100).toFixed(4),
            ethPriceChange: ((ethLast - ethFirst) / ethFirst * 100).toFixed(4)
        });
    });

    // Output results
    console.log('='.repeat(60));
    console.log('📊 RESULTS: 1-MINUTE RESOLUTION ANALYSIS');
    console.log('='.repeat(60));
    console.log('');
    console.log('Total qualifying trades:', results.total);
    console.log('Wins:', results.wins);
    console.log('Losses:', results.losses);
    console.log('Win Rate:', (results.wins / results.total * 100).toFixed(2) + '%');
    console.log('');
    console.log('PER-HOUR BREAKDOWN:');
    console.log('-'.repeat(40));

    Object.entries(results.byHour).forEach(([hour, data]) => {
        if (data.total === 0) return;
        const wr = (data.wins / data.total * 100).toFixed(1);
        console.log(`Hour ${hour.padStart(2, ' ')} UTC (${data.condition}): ${data.wins}/${data.total} = ${wr}%`);
    });

    // Save detailed trades
    const outputFile = 'binance_minute_analysis.json';
    fs.writeFileSync(outputFile, JSON.stringify({
        summary: {
            total: results.total,
            wins: results.wins,
            losses: results.losses,
            winRate: (results.wins / results.total * 100).toFixed(2) + '%',
            dataSource: 'Binance 1-minute klines',
            daysAnalyzed: DAYS_TO_FETCH,
            generatedAt: new Date().toISOString()
        },
        byHour: results.byHour,
        trades: results.trades
    }, null, 2));

    console.log('');
    console.log(`\n✅ Detailed results saved to ${outputFile}`);
}

// Run the analysis
analyzeGoldenHours().catch(console.error);
