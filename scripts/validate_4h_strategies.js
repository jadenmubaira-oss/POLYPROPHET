/**
 * 4-HOUR WALK-FORWARD VALIDATION + STRATEGY OPTIMIZER
 * 
 * Splits the 4h dataset chronologically into train (70%) / test (30%),
 * evaluates all strategies on both sets, and selects only those that
 * hold up out-of-sample. Optimizes for highest Wilson LCB.
 */

const fs = require('fs');
const path = require('path');

const TAKER_FEE_RATE = 0.02;
const Z = 1.96; // 95% confidence

function wilsonLCB(wins, total) {
    if (total <= 0) return 0;
    const p = wins / total;
    const d = 1 + (Z * Z) / total;
    const c = p + (Z * Z) / (2 * total);
    const m = Z * Math.sqrt((p * (1 - p) + (Z * Z) / (4 * total)) / total);
    return Math.max(0, (c - m) / d);
}

// Load the 4h dataset
const datasetPath = path.join(__dirname, '..', 'exhaustive_analysis', '4h', '4h_decision_dataset.json');
const dataset = JSON.parse(fs.readFileSync(datasetPath, 'utf8'));
console.log(`Loaded ${dataset.length} rows from 4h dataset`);

// Get unique markets (slugs) sorted chronologically
const bySlug = new Map();
for (const row of dataset) {
    if (!row || !row.slug) continue;
    const epoch = Number(row.cycleStartEpochSec);
    const existing = bySlug.get(row.slug);
    if (!existing) bySlug.set(row.slug, { slug: row.slug, epoch });
    else if (epoch < existing.epoch) existing.epoch = epoch;
}

const markets = Array.from(bySlug.values()).sort((a, b) => a.epoch - b.epoch);
const trainCut = Math.floor(markets.length * 0.70);
const trainSlugs = new Set(markets.slice(0, trainCut).map(m => m.slug));
const testSlugs = new Set(markets.slice(trainCut).map(m => m.slug));

const trainSet = dataset.filter(r => trainSlugs.has(r.slug));
const testSet = dataset.filter(r => testSlugs.has(r.slug));

console.log(`Train: ${trainSlugs.size} markets, ${trainSet.length} rows`);
console.log(`Test:  ${testSlugs.size} markets, ${testSet.length} rows`);

function minMax(arr) {
    let mn = Infinity, mx = -Infinity;
    for (const v of arr) { if (v < mn) mn = v; if (v > mx) mx = v; }
    return [mn, mx];
}
const trainEpochs = trainSet.filter(r => r.cycleStartEpochSec).map(r => r.cycleStartEpochSec);
const testEpochs = testSet.filter(r => r.cycleStartEpochSec).map(r => r.cycleStartEpochSec);
const [trainMin, trainMax] = minMax(trainEpochs);
const [testMin, testMax] = minMax(testEpochs);
console.log(`Train period: ${new Date(trainMin * 1000).toISOString()} - ${new Date(trainMax * 1000).toISOString()}`);
console.log(`Test period:  ${new Date(testMin * 1000).toISOString()} - ${new Date(testMax * 1000).toISOString()}`);

// Strategy parameters
const utcHours = [1, 5, 9, 13, 17, 21];
const entryMinuteBuckets = [0, 15, 30, 45, 60, 90, 120, 150, 180, 210, 230];
const priceBands = [
    { min: 0.55, max: 0.70 }, { min: 0.60, max: 0.75 }, { min: 0.60, max: 0.80 },
    { min: 0.65, max: 0.75 }, { min: 0.65, max: 0.80 }, { min: 0.70, max: 0.80 },
    { min: 0.72, max: 0.80 }, { min: 0.75, max: 0.80 },
];
const directions = ['UP', 'DOWN', 'BEST'];

function evaluateStrategy(data, entryMin, hour, band, dir) {
    let wins = 0, trades = 0, totalROI = 0;
    const perAsset = {};
    
    for (const row of data) {
        if (row.entryMinute !== entryMin || row.utcHour !== hour) continue;
        if (!row.hasIntracycle && row.entryMinute >= 0) continue; // skip non-intracycle for minute-specific
        
        let tradedUp, entryPrice;
        if (dir === 'UP') { tradedUp = true; entryPrice = row.upPrice; }
        else if (dir === 'DOWN') { tradedUp = false; entryPrice = row.downPrice; }
        else { tradedUp = row.upPrice < row.downPrice; entryPrice = tradedUp ? row.upPrice : row.downPrice; }
        
        if (!Number.isFinite(entryPrice) || entryPrice < band.min || entryPrice > band.max) continue;
        
        trades++;
        const won = tradedUp === row.winnerIsUp;
        if (won) wins++;
        const grossROI = won ? (1 / entryPrice) - 1 : -1;
        const fee = won ? grossROI * TAKER_FEE_RATE : 0;
        totalROI += grossROI - fee;
        
        const a = row.asset;
        if (!perAsset[a]) perAsset[a] = { trades: 0, wins: 0 };
        perAsset[a].trades++;
        if (won) perAsset[a].wins++;
    }
    
    if (trades === 0) return null;
    return {
        trades, wins, losses: trades - wins,
        winRate: wins / trades,
        lcb: wilsonLCB(wins, trades),
        avgROI: totalROI / trades,
        totalROI,
        perAsset
    };
}

// Phase 1: Find all strategies on train set
console.log('\n=== PHASE 1: TRAIN SET SEARCH ===');
const candidates = [];

for (const hour of utcHours) {
    for (const entryMin of entryMinuteBuckets) {
        for (const band of priceBands) {
            for (const dir of directions) {
                const result = evaluateStrategy(trainSet, entryMin, hour, band, dir);
                if (!result || result.trades < 10) continue;
                
                candidates.push({
                    utcHour: hour, entryMinute: entryMin,
                    priceBand: band, direction: dir,
                    train: result
                });
            }
        }
    }
}

// Sort by train LCB
candidates.sort((a, b) => b.train.lcb - a.train.lcb);
console.log(`Found ${candidates.length} candidates with ≥10 train trades`);
console.log(`Top 20 by train LCB:`);
for (const c of candidates.slice(0, 20)) {
    console.log(`  H${String(c.utcHour).padStart(2,'0')} m${String(c.entryMinute).padStart(3,'0')} ${c.direction.padEnd(5)} ${(c.priceBand.min*100).toFixed(0)}-${(c.priceBand.max*100).toFixed(0)}c | ${c.train.trades}t ${c.train.wins}w ${(c.train.winRate*100).toFixed(1)}% LCB=${(c.train.lcb*100).toFixed(1)}%`);
}

// Phase 2: Validate on test set
console.log('\n=== PHASE 2: TEST SET VALIDATION ===');
const validated = [];

for (const c of candidates.slice(0, 100)) { // top 100 by train LCB
    const testResult = evaluateStrategy(testSet, c.entryMinute, c.utcHour, c.priceBand, c.direction);
    if (!testResult || testResult.trades < 3) continue;
    
    validated.push({
        ...c,
        test: testResult,
        // Combined (all data) for final stats
        combined: evaluateStrategy(dataset, c.entryMinute, c.utcHour, c.priceBand, c.direction)
    });
}

// Sort by test LCB
validated.sort((a, b) => b.test.lcb - a.test.lcb);

console.log(`\nValidated ${validated.length} strategies with ≥3 test trades`);
console.log(`\nTop 20 by TEST LCB (out-of-sample):`);
for (const v of validated.slice(0, 20)) {
    const t = v.train;
    const te = v.test;
    console.log(`  H${String(v.utcHour).padStart(2,'0')} m${String(v.entryMinute).padStart(3,'0')} ${v.direction.padEnd(5)} ${(v.priceBand.min*100).toFixed(0)}-${(v.priceBand.max*100).toFixed(0)}c | TRAIN: ${t.trades}t ${(t.winRate*100).toFixed(1)}% LCB=${(t.lcb*100).toFixed(1)}% | TEST: ${te.trades}t ${te.wins}w/${te.losses}l ${(te.winRate*100).toFixed(1)}% LCB=${(te.lcb*100).toFixed(1)}%`);
}

// Phase 3: Select strategies with strict criteria
// Criteria: train WR ≥ 80%, test WR ≥ 75%, combined LCB ≥ 65%, combined trades ≥ 20
console.log('\n=== PHASE 3: STRICT SELECTION ===');
const strict = validated.filter(v => 
    v.train.winRate >= 0.80 &&
    v.test.winRate >= 0.75 &&
    v.combined.lcb >= 0.60 &&
    v.combined.trades >= 20
);

console.log(`Strict criteria (train≥80%, test≥75%, LCB≥60%, ≥20 trades): ${strict.length} strategies`);

// Deduplicate - pick the best entryMinute for each hour+direction+band combo
const deduped = new Map();
for (const s of strict) {
    // Key by hour + direction + band (since different entry minutes on same cycle are redundant)
    const key = `${s.utcHour}|${s.direction}|${s.priceBand.min}-${s.priceBand.max}`;
    const existing = deduped.get(key);
    if (!existing || s.combined.lcb > existing.combined.lcb) {
        deduped.set(key, s);
    }
}

const finalStrategies = Array.from(deduped.values())
    .sort((a, b) => b.combined.lcb - a.combined.lcb);

console.log(`After dedup (best entry per hour/dir/band): ${finalStrategies.length} strategies`);

// Further cut: only keep if combined LCB ≥ 70%
const topCut = finalStrategies.filter(s => s.combined.lcb >= 0.70);
console.log(`With combined LCB ≥ 70%: ${topCut.length} strategies`);

const finalSet = topCut.length >= 3 ? topCut : finalStrategies.slice(0, 8);

console.log(`\n=== FINAL 4H STRATEGY SET (${finalSet.length} strategies) ===`);
for (const s of finalSet) {
    const c = s.combined;
    const t = s.train;
    const te = s.test;
    console.log(`  H${String(s.utcHour).padStart(2,'0')} m${String(s.entryMinute).padStart(3,'0')} ${s.direction.padEnd(5)} ${(s.priceBand.min*100).toFixed(0)}-${(s.priceBand.max*100).toFixed(0)}c`);
    console.log(`    TRAIN: ${t.trades}t ${t.wins}w ${(t.winRate*100).toFixed(1)}% LCB=${(t.lcb*100).toFixed(1)}%`);
    console.log(`    TEST:  ${te.trades}t ${te.wins}w ${(te.winRate*100).toFixed(1)}% LCB=${(te.lcb*100).toFixed(1)}%`);
    console.log(`    ALL:   ${c.trades}t ${c.wins}w ${(c.winRate*100).toFixed(1)}% LCB=${(c.lcb*100).toFixed(1)}% avgROI=${(c.avgROI*100).toFixed(1)}%`);
    console.log(`    Assets: ${Object.entries(c.perAsset).map(([a,v]) => `${a}:${v.wins}/${v.trades}`).join(' ')}`);
}

// Build strategy set JSON
const strategySetJson = {
    version: "1.0",
    timeframe: "4h",
    generatedAt: new Date().toISOString(),
    description: `Walk-forward validated 4h strategies. Train 70%/Test 30% chronological split.`,
    trainPeriod: {
        start: new Date(trainMin * 1000).toISOString(),
        end: new Date(trainMax * 1000).toISOString(),
        markets: trainSlugs.size
    },
    testPeriod: {
        start: new Date(testMin * 1000).toISOString(),
        end: new Date(testMax * 1000).toISOString(),
        markets: testSlugs.size
    },
    conditions: {
        priceMin: Math.min(...finalSet.map(s => s.priceBand.min)),
        priceMax: Math.max(...finalSet.map(s => s.priceBand.max)),
        applyMomentumGate: false,
        applyVolumeGate: false,
        description: "4h strategies use intracycle price bands only. No momentum/volume gates needed (4h markets have different dynamics)."
    },
    stats: {
        totalStrategies: finalSet.length,
        source: "4h_walkforward_validated",
        trainMarkets: trainSlugs.size,
        testMarkets: testSlugs.size
    },
    strategies: finalSet.map((s, idx) => ({
        id: idx + 1,
        name: `H${String(s.utcHour).padStart(2,'0')} m${String(s.entryMinute).padStart(3,'0')} ${s.direction} (${(s.priceBand.min*100).toFixed(0)}-${(s.priceBand.max*100).toFixed(0)}c)`,
        asset: "ALL",
        utcHour: s.utcHour,
        entryMinute: s.entryMinute,
        direction: s.direction,
        priceMin: s.priceBand.min,
        priceMax: s.priceBand.max,
        tier: s.combined.lcb >= 0.75 ? "PLATINUM" : (s.combined.lcb >= 0.70 ? "GOLD" : "SILVER"),
        signature: `${s.entryMinute}|${s.utcHour}|${s.direction}|${s.priceBand.min}|${s.priceBand.max}`,
        trainWins: s.train.wins,
        trainTrades: s.train.trades,
        trainWinRate: s.train.winRate,
        trainLCB: s.train.lcb,
        testWins: s.test.wins,
        testTrades: s.test.trades,
        testWinRate: s.test.winRate,
        testLCB: s.test.lcb,
        winRate: s.combined.winRate,
        winRateLCB: s.combined.lcb,
        avgROI: s.combined.avgROI,
        totalROI: s.combined.totalROI,
        historicalWins: s.combined.wins,
        historicalTrades: s.combined.trades
    }))
};

const outPath = path.join(__dirname, '..', 'debug', 'strategy_set_4h.json');
fs.writeFileSync(outPath, JSON.stringify(strategySetJson, null, 2));
console.log(`\nStrategy set saved: ${outPath}`);

// Summary stats
const allTrades = finalSet.reduce((sum, s) => sum + s.combined.trades, 0);
const allWins = finalSet.reduce((sum, s) => sum + s.combined.wins, 0);
const allROI = finalSet.reduce((sum, s) => sum + s.combined.totalROI, 0);
console.log(`\nAGGREGATE: ${allTrades} trades, ${allWins} wins, ${(allWins/allTrades*100).toFixed(1)}% WR, $${allROI.toFixed(2)} total ROI`);
