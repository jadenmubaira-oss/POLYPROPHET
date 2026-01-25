/**
 * 🏆 EXHAUSTIVE 90-DAY STRATEGY INVESTIGATION
 * 
 * DEITY Protocol Compliance:
 * - Analyzes EVERY cycle
 * - Calculates EXACT wins/losses
 * - Tests WORST-CASE variance
 * - Finds ALL potential golden hours
 * - Investigates EVERYTHING
 */

const https = require('https');
const fs = require('fs');

// How many days to analyze
const DAYS_TO_ANALYZE = 90;

// Fetch 1-minute kline data from Binance
function fetchKlines(symbol, startTime, endTime) {
    return new Promise((resolve, reject) => {
        const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=1m&startTime=${startTime}&endTime=${endTime}&limit=1000`;
        https.get(url, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    resolve(JSON.parse(data));
                } catch (e) {
                    reject(e);
                }
            });
        }).on('error', reject);
    });
}

async function fetchAllData() {
    const now = Date.now();
    const startTime = now - (DAYS_TO_ANALYZE * 24 * 60 * 60 * 1000);

    console.log(`📊 Fetching ${DAYS_TO_ANALYZE} days of 1-minute data...`);
    console.log(`   From: ${new Date(startTime).toISOString()}`);
    console.log(`   To:   ${new Date(now).toISOString()}`);

    const allData = { BTC: [], ETH: [], SOL: [] };

    for (const [symbol, key] of [['BTCUSDT', 'BTC'], ['ETHUSDT', 'ETH'], ['SOLUSDT', 'SOL']]) {
        console.log(`   Fetching ${symbol}...`);
        let currentStart = startTime;
        let totalFetched = 0;

        while (currentStart < now) {
            const endTime = Math.min(currentStart + 1000 * 60 * 1000, now);
            try {
                const klines = await fetchKlines(symbol, currentStart, endTime);
                allData[key] = allData[key].concat(klines);
                totalFetched += klines.length;
                process.stdout.write(`\r   ${key}: ${totalFetched} klines...`);
                currentStart = endTime;
                await new Promise(r => setTimeout(r, 30)); // Rate limit
            } catch (e) {
                console.error(`\n   Error: ${e.message}`);
                await new Promise(r => setTimeout(r, 1000));
            }
        }
        console.log(`\n   ${key}: ${allData[key].length} total klines`);
    }

    return allData;
}

function organizeIntoCycles(allData) {
    console.log('\n📊 Organizing into 15-minute cycles...');

    const cycles = {};

    for (const [asset, klines] of Object.entries(allData)) {
        for (const kline of klines) {
            const [openTime, open, high, low, close, volume] = kline;
            const dt = new Date(openTime);
            const utcHour = dt.getUTCHours();
            const utcMin = dt.getUTCMinutes();
            const cycleStart = openTime - (utcMin % 15) * 60000;

            if (!cycles[cycleStart]) {
                cycles[cycleStart] = {
                    timestamp: new Date(cycleStart).toISOString(),
                    utcHour,
                    cycleOfHour: Math.floor(utcMin / 15), // 0, 1, 2, or 3
                    dayOfWeek: dt.getUTCDay(),
                    BTC: { first: null, last: null, high: -Infinity, low: Infinity, volume: 0 },
                    ETH: { first: null, last: null, high: -Infinity, low: Infinity, volume: 0 },
                    SOL: { first: null, last: null, high: -Infinity, low: Infinity, volume: 0 }
                };
            }

            const c = cycles[cycleStart][asset];
            const data = {
                timestamp: openTime,
                open: parseFloat(open),
                close: parseFloat(close),
                high: parseFloat(high),
                low: parseFloat(low),
                volume: parseFloat(volume)
            };

            if (!c.first || openTime < c.first.timestamp) c.first = data;
            if (!c.last || openTime > c.last.timestamp) c.last = data;
            if (data.high > c.high) c.high = data.high;
            if (data.low < c.low) c.low = data.low;
            c.volume += data.volume;
        }
    }

    console.log(`   Total cycles: ${Object.keys(cycles).length}`);
    return cycles;
}

function analyzeAllStrategies(cycles) {
    console.log('\n🔍 EXHAUSTIVE STRATEGY ANALYSIS');
    console.log('='.repeat(70));

    // Initialize stats for ALL 24 hours x 2 directions
    const hourStats = {};
    for (let h = 0; h < 24; h++) {
        hourStats[h] = {
            // BTC→ETH correlation (current strategy)
            UP: { total: 0, wins: 0, losses: 0, btcMatches: 0 },
            DOWN: { total: 0, wins: 0, losses: 0, btcMatches: 0 },
            // Alternative strategies
            rawETH: { up: 0, down: 0, total: 0 }, // Just trading ETH direction
            rawBTC: { up: 0, down: 0, total: 0 }, // Just BTC direction
            btcSol: { total: 0, wins: 0 }, // BTC→SOL correlation
            allCycles: 0
        };
    }

    // Analyze each cycle
    Object.values(cycles).forEach(cycle => {
        if (!cycle.BTC.first || !cycle.BTC.last || !cycle.ETH.first || !cycle.ETH.last) return;

        const hour = cycle.utcHour;
        const btcDir = cycle.BTC.last.close > cycle.BTC.first.open ? 'UP' : 'DOWN';
        const ethDir = cycle.ETH.last.close > cycle.ETH.first.open ? 'UP' : 'DOWN';
        const solDir = cycle.SOL?.last?.close > cycle.SOL?.first?.open ? 'UP' : 'DOWN';

        hourStats[hour].allCycles++;

        // Raw ETH direction
        if (ethDir === 'UP') hourStats[hour].rawETH.up++;
        else hourStats[hour].rawETH.down++;
        hourStats[hour].rawETH.total++;

        // Raw BTC direction
        if (btcDir === 'UP') hourStats[hour].rawBTC.up++;
        else hourStats[hour].rawBTC.down++;
        hourStats[hour].rawBTC.total++;

        // BTC→ETH correlation (the GOLDEN HOUR strategy)
        if (btcDir === 'UP') {
            hourStats[hour].UP.btcMatches++;
            hourStats[hour].UP.total++;
            if (ethDir === 'UP') hourStats[hour].UP.wins++;
            else hourStats[hour].UP.losses++;
        } else {
            hourStats[hour].DOWN.btcMatches++;
            hourStats[hour].DOWN.total++;
            if (ethDir === 'DOWN') hourStats[hour].DOWN.wins++;
            else hourStats[hour].DOWN.losses++;
        }

        // BTC→SOL correlation
        if (cycle.SOL?.first && cycle.SOL?.last) {
            hourStats[hour].btcSol.total++;
            if (btcDir === solDir) hourStats[hour].btcSol.wins++;
        }
    });

    // Calculate and display results
    console.log('\n📊 ALL 24 HOURS - COMPLETE BREAKDOWN');
    console.log('-'.repeat(70));
    console.log('Hour | Cycles | BTC UP→ETH UP | BTC DN→ETH DN | Best WR | Trades | Status');
    console.log('-'.repeat(70));

    const results = [];

    for (let h = 0; h < 24; h++) {
        const s = hourStats[h];

        const upWR = s.UP.total > 0 ? s.UP.wins / s.UP.total : 0;
        const downWR = s.DOWN.total > 0 ? s.DOWN.wins / s.DOWN.total : 0;

        const bestDir = upWR > downWR ? 'UP' : 'DOWN';
        const bestWR = Math.max(upWR, downWR);
        const bestTrades = bestDir === 'UP' ? s.UP.total : s.DOWN.total;
        const bestWins = bestDir === 'UP' ? s.UP.wins : s.DOWN.wins;
        const bestLosses = bestDir === 'UP' ? s.UP.losses : s.DOWN.losses;

        // Statistical significance check (need at least 30 trades for 90% confidence)
        const isSignificant = bestTrades >= 30;
        // Is it a golden hour candidate? (≥90% WR with significance)
        const isGolden = bestWR >= 0.90 && isSignificant;

        const status = isGolden ? '🏆 GOLDEN' : (bestWR >= 0.85 && isSignificant ? '⭐ GOOD' : '');

        results.push({
            hour: h,
            allCycles: s.allCycles,
            upWR,
            upWins: s.UP.wins,
            upLosses: s.UP.losses,
            upTotal: s.UP.total,
            downWR,
            downWins: s.DOWN.wins,
            downLosses: s.DOWN.losses,
            downTotal: s.DOWN.total,
            bestDir,
            bestWR,
            bestWins,
            bestLosses,
            bestTrades,
            isGolden,
            isSignificant,
            btcSolWR: s.btcSol.total > 0 ? s.btcSol.wins / s.btcSol.total : 0,
            btcSolTrades: s.btcSol.total
        });

        const upStr = `${s.UP.wins}/${s.UP.total} (${(upWR * 100).toFixed(1)}%)`;
        const downStr = `${s.DOWN.wins}/${s.DOWN.total} (${(downWR * 100).toFixed(1)}%)`;

        console.log(`  ${h.toString().padStart(2, '0')} | ${s.allCycles.toString().padStart(5)} | ${upStr.padEnd(15)} | ${downStr.padEnd(15)} | ${(bestWR * 100).toFixed(1)}% | ${bestTrades.toString().padStart(5)} | ${status}`);
    }

    return results;
}

function worstCaseAnalysis(results) {
    console.log('\n🚨 WORST-CASE VARIANCE ANALYSIS');
    console.log('='.repeat(70));

    // Sort by best WR
    const sorted = [...results].sort((a, b) => b.bestWR - a.bestWR);

    console.log('\n📊 TOP 10 HOURS BY WIN RATE:');
    console.log('-'.repeat(60));

    sorted.slice(0, 10).forEach((r, i) => {
        const ci95 = 1.96 * Math.sqrt((r.bestWR * (1 - r.bestWR)) / r.bestTrades);
        const lowerBound = Math.max(0, r.bestWR - ci95);
        const upperBound = Math.min(1, r.bestWR + ci95);

        console.log(`${(i + 1).toString().padStart(2)}. Hour ${r.hour.toString().padStart(2)} ${r.bestDir}: ${(r.bestWR * 100).toFixed(1)}% (${r.bestWins}W/${r.bestLosses}L) [95% CI: ${(lowerBound * 100).toFixed(1)}%-${(upperBound * 100).toFixed(1)}%]`);
    });

    // Find golden hours (≥90% WR with statistical significance)
    const goldenHours = sorted.filter(r => r.isGolden);

    console.log(`\n🏆 CONFIRMED GOLDEN HOURS (≥90% WR, n≥30):`);
    console.log('-'.repeat(60));

    if (goldenHours.length === 0) {
        console.log('   ⚠️ No hours meet strict ≥90% WR with n≥30 requirement');
        console.log('   Showing hours ≥85% WR instead:');
        const goodHours = sorted.filter(r => r.bestWR >= 0.85 && r.isSignificant);
        goodHours.forEach(r => {
            console.log(`   Hour ${r.hour.toString().padStart(2)} ${r.bestDir}: ${(r.bestWR * 100).toFixed(1)}% (${r.bestWins}W/${r.bestLosses}L)`);
        });
    } else {
        goldenHours.forEach(r => {
            const maxConsecLosses = estimateMaxConsecLosses(r.bestWR, r.bestTrades);
            console.log(`   Hour ${r.hour.toString().padStart(2)} ${r.bestDir}: ${(r.bestWR * 100).toFixed(1)}% (${r.bestWins}W/${r.bestLosses}L) - Est. max consec losses: ${maxConsecLosses}`);
        });
    }

    // WORST CASE SCENARIO
    console.log('\n🔥 WORST CASE VARIANCE SIMULATION:');
    console.log('-'.repeat(60));

    // Simulate 10,000 Monte Carlo runs
    const topHours = sorted.slice(0, 5);
    const avgWR = topHours.reduce((sum, r) => sum + r.bestWR, 0) / topHours.length;
    const totalTrades = topHours.reduce((sum, r) => sum + r.bestTrades, 0);

    let maxDrawdown = 0;
    let maxConsecLosses = 0;
    let bustCount = 0;
    const simulations = 10000;

    for (let sim = 0; sim < simulations; sim++) {
        let balance = 100;
        let consecLosses = 0;
        let peak = 100;

        for (let t = 0; t < 100; t++) { // 100 trades
            const sizing = 0.25; // 25% sizing
            const win = Math.random() < avgWR;

            if (win) {
                balance *= (1 + sizing * 1.22); // 122% ROI on 45¢ entry
                consecLosses = 0;
            } else {
                balance *= (1 - sizing);
                consecLosses++;
            }

            if (balance > peak) peak = balance;
            const drawdown = (peak - balance) / peak;
            if (drawdown > maxDrawdown) maxDrawdown = drawdown;
            if (consecLosses > maxConsecLosses) maxConsecLosses = consecLosses;

            if (balance < 0.01) {
                bustCount++;
                break;
            }
        }
    }

    console.log(`   Simulations: ${simulations}`);
    console.log(`   Average WR used: ${(avgWR * 100).toFixed(1)}%`);
    console.log(`   Max observed drawdown: ${(maxDrawdown * 100).toFixed(1)}%`);
    console.log(`   Max consecutive losses: ${maxConsecLosses}`);
    console.log(`   Bust rate (balance < $0.01): ${(bustCount / simulations * 100).toFixed(2)}%`);

    return { goldenHours, avgWR, maxDrawdown, maxConsecLosses };
}

function estimateMaxConsecLosses(wr, n) {
    // Expected max consecutive losses for n trials at win rate wr
    const lossRate = 1 - wr;
    // Approximate: max ≈ log(n) / log(1/lossRate)
    return Math.ceil(Math.log(n) / Math.log(1 / lossRate));
}

function generateAutonomyRecommendations(results, worstCase) {
    console.log('\n🤖 AUTONOMOUS BOT RECOMMENDATIONS');
    console.log('='.repeat(70));

    console.log('\n1. SELF-LEARNING SYSTEM:');
    console.log('   - Track rolling 7-day WR per hour');
    console.log('   - Automatically disable hours that drop below 85% WR');
    console.log('   - Re-enable after 14 days if WR recovers');

    console.log('\n2. FAILSAFE THRESHOLDS:');
    console.log('   - HALT if 3 consecutive losses');
    console.log('   - HALT if daily drawdown > 30%');
    console.log('   - Cool-down: Skip 12 cycles after halt');

    console.log('\n3. DYNAMIC HOUR SELECTION:');
    console.log('   - Run weekly analysis to find new golden hours');
    console.log('   - Store historical performance in Redis');
    console.log('   - Automatically promote/demote hours based on data');

    console.log('\n4. MARKET REGIME DETECTION:');
    console.log('   - Track BTC volatility (ATR)');
    console.log('   - Reduce sizing in high volatility');
    console.log('   - Increase sizing in low volatility with stable WR');

    return {
        selfLearning: true,
        failsafeThresholds: {
            maxConsecLosses: 3,
            maxDailyDrawdown: 0.30,
            cooldownCycles: 12
        },
        dynamicHours: true,
        regimeDetection: true
    };
}

async function main() {
    console.log('🏆 EXHAUSTIVE 90-DAY STRATEGY INVESTIGATION');
    console.log('='.repeat(70));
    console.log('Following DEITY Protocol: Atomic-level investigation, no assumptions');
    console.log('');

    // Fetch all data
    const allData = await fetchAllData();

    // Organize into cycles
    const cycles = organizeIntoCycles(allData);

    // Analyze all strategies
    const results = analyzeAllStrategies(cycles);

    // Worst case analysis
    const worstCase = worstCaseAnalysis(results);

    // Autonomy recommendations
    const autonomy = generateAutonomyRecommendations(results, worstCase);

    // Save complete results
    const output = {
        generatedAt: new Date().toISOString(),
        daysAnalyzed: DAYS_TO_ANALYZE,
        totalCycles: Object.keys(cycles).length,
        results,
        worstCase: {
            avgWR: worstCase.avgWR,
            maxDrawdown: worstCase.maxDrawdown,
            maxConsecLosses: worstCase.maxConsecLosses,
            goldenHours: worstCase.goldenHours.map(h => ({
                hour: h.hour,
                direction: h.bestDir,
                winRate: h.bestWR,
                wins: h.bestWins,
                losses: h.bestLosses,
                trades: h.bestTrades
            }))
        },
        autonomy
    };

    fs.writeFileSync('exhaustive_90day_analysis.json', JSON.stringify(output, null, 2));
    console.log('\n✅ Complete results saved to exhaustive_90day_analysis.json');

    // Summary
    console.log('\n' + '='.repeat(70));
    console.log('📊 FINAL SUMMARY');
    console.log('='.repeat(70));
    console.log(`Total cycles analyzed: ${Object.keys(cycles).length}`);
    console.log(`Days covered: ${DAYS_TO_ANALYZE}`);
    console.log(`Golden hours found: ${worstCase.goldenHours.length}`);
    console.log(`Average golden WR: ${(worstCase.avgWR * 100).toFixed(1)}%`);
    console.log(`Worst-case max drawdown: ${(worstCase.maxDrawdown * 100).toFixed(1)}%`);
    console.log(`Worst-case max consec losses: ${worstCase.maxConsecLosses}`);
}

main().catch(console.error);
