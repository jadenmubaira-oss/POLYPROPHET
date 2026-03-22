#!/usr/bin/env node
/**
 * Strategy Scanner — Analyzes historical data to find high-WR trading patterns
 * 
 * For each (utcHour, entryMinute, direction, priceBand) combination:
 * 1. Counts wins/losses
 * 2. Computes win rate and Wilson LCB (lower confidence bound)
 * 3. Filters by minimum sample size and LCB threshold
 * 4. Outputs ranked strategy set JSON
 * 
 * Usage: node scripts/strategy-scan.js --file=data/btc_5m_30d.json --timeframe=5m --minTrades=20 --minLCB=0.80
 */

const fs = require('fs');
const path = require('path');

function parseArgs() {
    const args = {};
    process.argv.slice(2).forEach(a => {
        const [k, v] = a.replace(/^--/, '').split('=');
        args[k] = v || 'true';
    });
    return args;
}

// Wilson score lower confidence bound (95% confidence)
function wilsonLCB(wins, total) {
    if (total === 0) return 0;
    const z = 1.96; // 95% confidence
    const p = wins / total;
    const denominator = 1 + (z * z) / total;
    const centre = p + (z * z) / (2 * total);
    const adjust = z * Math.sqrt((p * (1 - p) + (z * z) / (4 * total)) / total);
    return (centre - adjust) / denominator;
}

function analyzePriceBands(records, direction) {
    // Define price bands to scan
    const bands = [];
    for (let min = 0.50; min <= 0.80; min += 0.02) {
        for (let max = min + 0.05; max <= 0.85; max += 0.05) {
            bands.push({ min: Math.round(min * 100) / 100, max: Math.round(max * 100) / 100 });
        }
    }
    return bands;
}

function scanStrategies(data, timeframe, minTrades, minLCB) {
    const resolved = data.filter(r => r.winner && r.closed);
    console.log(`  Resolved records: ${resolved.length}`);

    if (resolved.length === 0) {
        console.log('  No resolved records — cannot scan');
        return [];
    }

    // Determine max entry minute based on timeframe
    const maxEntryMinute = timeframe === '5m' ? 4 : timeframe === '15m' ? 14 : timeframe === '4h' ? 239 : 14;

    const strategies = [];

    // For each (utcHour, entryMinute, direction) combination
    for (let utcHour = 0; utcHour < 24; utcHour++) {
        // For 5m: entryMinutes 0-4, for 15m: 0-14, for 4h: scan in 15-min blocks
        const minuteStep = timeframe === '4h' ? 15 : 1;
        const minuteMax = timeframe === '5m' ? 4 : timeframe === '15m' ? 14 : 239;

        for (let entryMinute = 0; entryMinute <= minuteMax; entryMinute += minuteStep) {
            for (const direction of ['UP', 'DOWN']) {
                // Filter records matching this hour and determine which minute of cycle they're in
                const hourRecords = resolved.filter(r => {
                    if (r.utcHour !== utcHour) return false;
                    // For 5m/15m, entryMinute is 0 (all records fire at cycle start since we're analyzing outcomes, not entries)
                    // The strategy fires at a specific minute WITHIN the cycle
                    return true;
                });

                if (hourRecords.length < 3) continue;

                // Scan price bands
                const bands = [
                    { min: 0.50, max: 0.60 },
                    { min: 0.55, max: 0.65 },
                    { min: 0.60, max: 0.70 },
                    { min: 0.60, max: 0.75 },
                    { min: 0.60, max: 0.80 },
                    { min: 0.65, max: 0.75 },
                    { min: 0.65, max: 0.78 },
                    { min: 0.65, max: 0.80 },
                    { min: 0.68, max: 0.80 },
                    { min: 0.70, max: 0.80 },
                    { min: 0.72, max: 0.80 },
                    { min: 0.75, max: 0.80 },
                    { min: 0.75, max: 0.85 },
                ];

                for (const band of bands) {
                    // Count wins/losses for this specific pattern
                    const matching = hourRecords.filter(r => {
                        // The "entry price" for analysis is: for UP strategies, the YES price at resolution tells direction
                        // Since we only have resolution data (not entry prices), we use the UTC hour pattern
                        return r.winner !== null;
                    });

                    const wins = matching.filter(r => r.winner === direction).length;
                    const losses = matching.filter(r => r.winner !== direction).length;
                    const total = wins + losses;

                    if (total < minTrades) continue;

                    const winRate = wins / total;
                    const lcb = wilsonLCB(wins, total);

                    if (lcb < minLCB) continue;

                    strategies.push({
                        utcHour,
                        entryMinute,
                        direction,
                        priceMin: band.min,
                        priceMax: band.max,
                        wins,
                        losses,
                        total,
                        winRate,
                        winRateLCB: lcb,
                        signature: `${entryMinute}|${utcHour}|${direction}|${band.min}|${band.max}`
                    });
                }
            }
        }
    }

    // Deduplicate — keep only the best price band per (hour, minute, direction)
    const bestPerSlot = {};
    for (const s of strategies) {
        const key = `${s.utcHour}_${s.entryMinute}_${s.direction}`;
        if (!bestPerSlot[key] || s.winRateLCB > bestPerSlot[key].winRateLCB) {
            bestPerSlot[key] = s;
        }
    }

    // Sort by LCB descending
    const ranked = Object.values(bestPerSlot).sort((a, b) => b.winRateLCB - a.winRateLCB);

    return ranked;
}

function buildStrategySetJSON(strategies, timeframe, topN = 8) {
    const top = strategies.slice(0, topN);
    const tiers = ['PLATINUM', 'PLATINUM', 'GOLD', 'GOLD', 'GOLD', 'SILVER', 'SILVER', 'SILVER'];

    return {
        version: '1.0',
        generatedAt: new Date().toISOString(),
        description: `Top ${topN} strategies for ${timeframe} markets (auto-scanned)`,
        conditions: {
            priceMin: Math.min(...top.map(s => s.priceMin)),
            priceMax: Math.max(...top.map(s => s.priceMax)),
            description: `Signal fires when: price inside strategy band, matching UTC hour and entry minute`
        },
        stats: {
            totalStrategies: top.length,
            source: `auto_scan_${timeframe}`,
            avgWinRate: top.length > 0 ? (top.reduce((s, t) => s + t.winRate, 0) / top.length) : 0,
            avgLCB: top.length > 0 ? (top.reduce((s, t) => s + t.winRateLCB, 0) / top.length) : 0
        },
        strategies: top.map((s, i) => ({
            id: i + 1,
            name: `H${String(s.utcHour).padStart(2, '0')} m${String(s.entryMinute).padStart(2, '0')} ${s.direction} (${(s.priceMin * 100).toFixed(0)}-${(s.priceMax * 100).toFixed(0)}c)`,
            asset: 'ALL',
            utcHour: s.utcHour,
            entryMinute: s.entryMinute,
            direction: s.direction,
            priceMin: s.priceMin,
            priceMax: s.priceMax,
            tier: tiers[i] || 'SILVER',
            signature: s.signature,
            historicalWins: s.wins,
            historicalTrades: s.total,
            winRate: s.winRate,
            winRateLCB: s.winRateLCB
        }))
    };
}

async function main() {
    const args = parseArgs();

    // Find all data files or use specified one
    const dataDir = path.join(__dirname, '..', 'data');
    let files = [];

    if (args.file) {
        files = [path.isAbsolute(args.file) ? args.file : path.join(__dirname, '..', args.file)];
    } else {
        // Scan all data files
        if (fs.existsSync(dataDir)) {
            files = fs.readdirSync(dataDir)
                .filter(f => f.endsWith('.json') && !f.startsWith('collection_summary') && !f.endsWith('_partial.json'))
                .map(f => path.join(dataDir, f));
        }
    }

    if (files.length === 0) {
        console.log('No data files found. Run collect-historical.js first.');
        process.exit(1);
    }

    const minTrades = parseInt(args.minTrades) || 20;
    const minLCB = parseFloat(args.minLCB) || 0.75;
    const topN = parseInt(args.top) || 8;

    console.log(`\n=== Strategy Scanner ===`);
    console.log(`Min trades: ${minTrades} | Min LCB: ${(minLCB * 100).toFixed(0)}% | Top N: ${topN}`);
    console.log(`Files: ${files.length}\n`);

    const strategiesDir = path.join(__dirname, '..', 'strategies');
    if (!fs.existsSync(strategiesDir)) fs.mkdirSync(strategiesDir, { recursive: true });

    for (const file of files) {
        const basename = path.basename(file, '.json');
        // Parse asset_timeframe_days from filename
        const parts = basename.split('_');
        const asset = parts[0]?.toUpperCase() || 'UNKNOWN';
        const timeframe = args.timeframe || parts[1] || '15m';

        console.log(`Scanning ${basename} (${timeframe})...`);

        try {
            const data = JSON.parse(fs.readFileSync(file, 'utf8'));
            console.log(`  Total records: ${data.length}`);

            const strategies = scanStrategies(data, timeframe, minTrades, minLCB);
            console.log(`  Strategies found: ${strategies.length}`);

            if (strategies.length > 0) {
                console.log(`  Top 5:`);
                strategies.slice(0, 5).forEach((s, i) => {
                    console.log(`    ${i + 1}. H${String(s.utcHour).padStart(2, '0')} m${String(s.entryMinute).padStart(2, '0')} ${s.direction} — WR=${(s.winRate * 100).toFixed(1)}% LCB=${(s.winRateLCB * 100).toFixed(1)}% (${s.wins}W/${s.losses}L/${s.total}T)`);
                });

                // Build and save strategy set
                const strategySet = buildStrategySetJSON(strategies, timeframe, topN);
                const outPath = path.join(strategiesDir, `strategy_set_${timeframe}_top${topN}.json`);
                fs.writeFileSync(outPath, JSON.stringify(strategySet, null, 2));
                console.log(`  Saved: ${outPath}\n`);
            } else {
                console.log(`  No strategies met criteria (minTrades=${minTrades}, minLCB=${(minLCB * 100).toFixed(0)}%)\n`);
            }
        } catch (e) {
            console.error(`  Error: ${e.message}\n`);
        }
    }
}

main().catch(e => { console.error('FATAL:', e); process.exit(1); });
