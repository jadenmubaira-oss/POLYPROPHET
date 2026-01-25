/**
 * 🏆 COMPREHENSIVE STRATEGY COMPARISON
 * 
 * This script compares the GOLDEN HOUR strategy to ALL possible strategies
 * to verify it is the PEAK (optimal) strategy.
 */

const fs = require('fs');
const https = require('https');

// Golden Hours we're currently using
const CURRENT_GOLDEN_HOURS = {
    2: 'DOWN',
    3: 'UP',
    4: 'UP',
    8: 'UP',
    14: 'DOWN'
};

async function fetchKlines(symbol, startTime, endTime) {
    return new Promise((resolve, reject) => {
        const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=1m&startTime=${startTime}&endTime=${endTime}&limit=1000`;
        https.get(url, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => resolve(JSON.parse(data)));
        }).on('error', reject);
    });
}

async function main() {
    console.log('🏆 COMPREHENSIVE STRATEGY COMPARISON');
    console.log('='.repeat(60));
    console.log('');

    // Fetch 30 days of data
    const now = Date.now();
    const thirtyDaysAgo = now - (30 * 24 * 60 * 60 * 1000);

    console.log('Fetching BTC and ETH 1-minute data for 30 days...');

    const allData = { BTC: [], ETH: [] };

    for (const [symbol, key] of [['BTCUSDT', 'BTC'], ['ETHUSDT', 'ETH']]) {
        let currentStart = thirtyDaysAgo;
        while (currentStart < now) {
            const endTime = Math.min(currentStart + 1000 * 60 * 1000, now);
            const klines = await fetchKlines(symbol, currentStart, endTime);
            allData[key] = allData[key].concat(klines);
            currentStart = endTime;
            await new Promise(r => setTimeout(r, 50));
        }
        console.log(`  ${key}: ${allData[key].length} klines`);
    }

    // Organize into 15-minute cycles
    const cycles = {};

    for (const [asset, klines] of Object.entries(allData)) {
        for (const kline of klines) {
            const [openTime, open, , , close] = kline;
            const dt = new Date(openTime);
            const utcHour = dt.getUTCHours();
            const utcMin = dt.getUTCMinutes();
            const cycleStart = openTime - (utcMin % 15) * 60000;

            if (!cycles[cycleStart]) {
                cycles[cycleStart] = {
                    utcHour,
                    BTC: { first: null, last: null },
                    ETH: { first: null, last: null }
                };
            }

            const data = { timestamp: openTime, open: parseFloat(open), close: parseFloat(close) };
            if (!cycles[cycleStart][asset].first || openTime < cycles[cycleStart][asset].first.timestamp) {
                cycles[cycleStart][asset].first = data;
            }
            if (!cycles[cycleStart][asset].last || openTime > cycles[cycleStart][asset].last.timestamp) {
                cycles[cycleStart][asset].last = data;
            }
        }
    }

    // Analyze ALL strategies for ALL 24 hours
    console.log('\n📊 ANALYZING ALL POSSIBLE STRATEGIES...\n');

    const hourStats = {};

    for (let hour = 0; hour < 24; hour++) {
        hourStats[hour] = {
            UP: { total: 0, btcMatchWins: 0 },
            DOWN: { total: 0, btcMatchWins: 0 },
            totalCycles: 0
        };
    }

    // Analyze each cycle
    Object.entries(cycles).forEach(([cycleStart, cycle]) => {
        if (!cycle.BTC.first || !cycle.BTC.last || !cycle.ETH.first || !cycle.ETH.last) return;

        const btcDir = cycle.BTC.last.close > cycle.BTC.first.open ? 'UP' : 'DOWN';
        const ethDir = cycle.ETH.last.close > cycle.ETH.first.open ? 'UP' : 'DOWN';
        const hour = cycle.utcHour;

        hourStats[hour].totalCycles++;

        // If we bet that this hour is an UP hour
        if (btcDir === 'UP') {
            hourStats[hour].UP.total++;
            if (ethDir === 'UP') hourStats[hour].UP.btcMatchWins++;
        }

        // If we bet that this hour is a DOWN hour
        if (btcDir === 'DOWN') {
            hourStats[hour].DOWN.total++;
            if (ethDir === 'DOWN') hourStats[hour].DOWN.btcMatchWins++;
        }
    });

    // Calculate win rates for each hour-direction combination
    console.log('HOUR | BEST DIR | WIN RATE | TRADES | IS GOLDEN?');
    console.log('-'.repeat(55));

    const allStrategies = [];

    for (let hour = 0; hour < 24; hour++) {
        const upWR = hourStats[hour].UP.total > 0 ? hourStats[hour].UP.btcMatchWins / hourStats[hour].UP.total : 0;
        const downWR = hourStats[hour].DOWN.total > 0 ? hourStats[hour].DOWN.btcMatchWins / hourStats[hour].DOWN.total : 0;

        const bestDir = upWR > downWR ? 'UP' : 'DOWN';
        const bestWR = Math.max(upWR, downWR);
        const bestTrades = bestDir === 'UP' ? hourStats[hour].UP.total : hourStats[hour].DOWN.total;

        const isGolden = CURRENT_GOLDEN_HOURS[hour] !== undefined;
        const goldenMatch = isGolden && CURRENT_GOLDEN_HOURS[hour] === bestDir;

        allStrategies.push({
            hour,
            bestDir,
            bestWR,
            bestTrades,
            isGolden,
            goldenMatch
        });

        const marker = isGolden ? (goldenMatch ? '✅ GOLDEN' : '⚠️ GOLDEN') : '';
        console.log(`  ${hour.toString().padStart(2, '0')} |   ${bestDir.padEnd(4)} |  ${(bestWR * 100).toFixed(1)}%  |   ${bestTrades.toString().padStart(3)}  | ${marker}`);
    }

    // Sort by win rate to find top performing hours
    allStrategies.sort((a, b) => b.bestWR - a.bestWR);

    console.log('\n🏆 TOP 10 BEST HOURS BY WIN RATE:');
    console.log('-'.repeat(40));

    allStrategies.slice(0, 10).forEach((s, i) => {
        const isGolden = CURRENT_GOLDEN_HOURS[s.hour] !== undefined;
        console.log(`${i + 1}. Hour ${s.hour.toString().padStart(2, '0')} ${s.bestDir}: ${(s.bestWR * 100).toFixed(1)}% (${s.bestTrades} trades) ${isGolden ? '✅ IN GOLDEN' : ''}`);
    });

    // Check if current golden hours are in top performers
    console.log('\n📊 GOLDEN HOURS VALIDATION:');
    console.log('-'.repeat(40));

    const goldenHours = Object.entries(CURRENT_GOLDEN_HOURS);
    let allGoldenInTop = true;

    goldenHours.forEach(([hour, direction]) => {
        const hourNum = parseInt(hour);
        const rank = allStrategies.findIndex(s => s.hour === hourNum) + 1;
        const stats = allStrategies.find(s => s.hour === hourNum);

        if (stats) {
            const match = stats.bestDir === direction ? '✅' : '❌';
            console.log(`Hour ${hour}: ${direction} - Rank #${rank} (${(stats.bestWR * 100).toFixed(1)}% WR) ${match}`);
            if (rank > 10) allGoldenInTop = false;
        }
    });

    console.log('\n' + '='.repeat(60));
    if (allGoldenInTop) {
        console.log('✅ ALL GOLDEN HOURS ARE IN THE TOP 10 PERFORMERS!');
    } else {
        console.log('⚠️ Some golden hours are NOT in top 10 - consider revision.');
    }

    // Calculate combined golden hour performance
    const goldenCombined = { total: 0, wins: 0 };
    allStrategies.forEach(s => {
        if (CURRENT_GOLDEN_HOURS[s.hour] !== undefined && CURRENT_GOLDEN_HOURS[s.hour] === s.bestDir) {
            goldenCombined.total += s.bestTrades;
            goldenCombined.wins += Math.round(s.bestWR * s.bestTrades);
        }
    });

    console.log(`\n🏆 COMBINED GOLDEN HOURS: ${goldenCombined.wins}/${goldenCombined.total} = ${(goldenCombined.wins / goldenCombined.total * 100).toFixed(2)}% WR`);

    // Save results
    fs.writeFileSync('strategy_comparison.json', JSON.stringify({
        allStrategies,
        goldenHours: CURRENT_GOLDEN_HOURS,
        combined: goldenCombined,
        generatedAt: new Date().toISOString()
    }, null, 2));

    console.log('\n✅ Results saved to strategy_comparison.json');
}

main().catch(console.error);
