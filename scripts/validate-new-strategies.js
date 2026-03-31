/**
 * WALK-FORWARD VALIDATION of new strategy candidates
 * 
 * Split the 776 cycles into:
 *   - Train: first 70% (~543 cycles)
 *   - Test: last 30% (~233 cycles) 
 * 
 * Find best strategies on TRAIN, validate on TEST.
 * Only keep strategies where TEST WR > break-even + 3%
 */

const fs = require('fs');
const path = require('path');

const DATA_PATH = path.join(__dirname, '..', 'data', 'intracycle-price-data.json');
const data = JSON.parse(fs.readFileSync(DATA_PATH, 'utf8'));
const allCycles = data.cycles;

// Sort by epoch for chronological split
allCycles.sort((a, b) => a.epoch - b.epoch);

const splitIdx = Math.floor(allCycles.length * 0.70);
const trainCycles = allCycles.slice(0, splitIdx);
const testCycles = allCycles.slice(splitIdx);

console.log(`Total cycles: ${allCycles.length}`);
console.log(`Train: ${trainCycles.length} (${new Date(trainCycles[0].epoch*1000).toISOString()} to ${new Date(trainCycles[trainCycles.length-1].epoch*1000).toISOString()})`);
console.log(`Test: ${testCycles.length} (${new Date(testCycles[0].epoch*1000).toISOString()} to ${new Date(testCycles[testCycles.length-1].epoch*1000).toISOString()})`);

const TAKER_FEE = 0.0315;
const MIN_TRAIN_MATCHES = 15;
const MIN_TEST_MATCHES = 8;
const MIN_EDGE = 0.03;

function breakEvenWR(avgEntry) {
    if (avgEntry <= 0 || avgEntry >= 1) return 1;
    const netWinROI = ((1 - avgEntry) / avgEntry) * (1 - TAKER_FEE);
    return 1 / (1 + netWinROI);
}

function evalOnSet(cycles, minute, direction, pMin, pMax) {
    let matches = 0, wins = 0, entrySum = 0;
    for (const c of cycles) {
        const pm = direction === 'UP' ? c.minutePricesYes : c.minutePricesNo;
        const pd = pm[minute];
        if (!pd) continue;
        const price = pd.last;
        if (price < pMin || price > pMax) continue;
        matches++;
        entrySum += price;
        if (c.resolution === direction) wins++;
    }
    if (matches === 0) return null;
    return { matches, wins, wr: wins/matches, avgEntry: entrySum/matches };
}

const MINUTES = [0,1,2,3,4,5,6,7,8,9,10,11,12,13,14];
const DIRECTIONS = ['UP', 'DOWN'];
const P_MINS = [0.05,0.10,0.15,0.20,0.25,0.30,0.35,0.40,0.45,0.50,0.55,0.60,0.65,0.70,0.75,0.80];
const P_MAXS = [0.30,0.35,0.40,0.45,0.50,0.55,0.60,0.65,0.70,0.75,0.80,0.85,0.90,0.95];

console.log('\nScanning strategies on TRAIN set...');

const validated = [];
let scanned = 0;

for (const m of MINUTES) {
    for (const dir of DIRECTIONS) {
        for (const pMin of P_MINS) {
            for (const pMax of P_MAXS) {
                if (pMax <= pMin || pMax - pMin < 0.05) continue;
                scanned++;
                
                const train = evalOnSet(trainCycles, m, dir, pMin, pMax);
                if (!train || train.matches < MIN_TRAIN_MATCHES) continue;
                
                const trainBE = breakEvenWR(train.avgEntry);
                if (train.wr - trainBE < MIN_EDGE) continue;
                
                // Passes train filter -- now check test
                const test = evalOnSet(testCycles, m, dir, pMin, pMax);
                if (!test || test.matches < MIN_TEST_MATCHES) continue;
                
                const testBE = breakEvenWR(test.avgEntry);
                const testEdge = test.wr - testBE;
                
                if (testEdge < MIN_EDGE) continue;
                
                // Both train AND test pass!
                const netWinROI = ((1 - test.avgEntry) / test.avgEntry) * (1 - TAKER_FEE);
                const ev = test.wr * netWinROI - (1 - test.wr);
                
                validated.push({
                    minute: m, direction: dir, pMin, pMax,
                    trainMatches: train.matches, trainWR: train.wr, trainAvgEntry: train.avgEntry,
                    testMatches: test.matches, testWR: test.wr, testAvgEntry: test.avgEntry,
                    testBE: testBE, testEdge: testEdge,
                    ev, 
                    testLCB: test.wr - 1.96 * Math.sqrt(test.wr * (1 - test.wr) / test.matches),
                    profitScore: ev * (test.matches / testCycles.length * 96 * 4) // projected daily trades
                });
            }
        }
    }
}

console.log(`Scanned: ${scanned}, Walk-forward validated: ${validated.length}`);

// Sort by profit score
validated.sort((a, b) => b.profitScore - a.profitScore);

console.log('\n=== TOP 30 WALK-FORWARD VALIDATED STRATEGIES ===');
console.log('Rk | Min | Dir  | Band       | TrN  | TrWR  | TsN | TsWR  | TsBE  | Edge  | EV    | Score  | TsLCB');
console.log('---|-----|------|------------|------|-------|-----|-------|-------|-------|-------|--------|------');

for (let i = 0; i < Math.min(30, validated.length); i++) {
    const r = validated[i];
    console.log(
        `${String(i+1).padStart(2)} | m${String(r.minute).padStart(2)} | ${r.direction.padStart(4)} | ${r.pMin.toFixed(2)}-${r.pMax.toFixed(2)} | ${String(r.trainMatches).padStart(4)} | ${(r.trainWR*100).toFixed(1)}% | ${String(r.testMatches).padStart(3)} | ${(r.testWR*100).toFixed(1)}% | ${(r.testBE*100).toFixed(1)}% | ${(r.testEdge*100).toFixed(1)}% | ${r.ev.toFixed(3)} | ${r.profitScore.toFixed(3).padStart(6)} | ${(r.testLCB*100).toFixed(1)}%`
    );
}

// High WR validated
const highWR = validated.filter(r => r.testWR >= 0.80 && r.testMatches >= 10).sort((a,b) => b.testWR - a.testWR);
console.log('\n=== HIGH WIN RATE VALIDATED (test WR >= 80%, test matches >= 10) ===');
console.log('Rk | Min | Dir  | Band       | TrN  | TrWR  | TsN | TsWR  | TsBE  | Edge  | EV    | TsLCB');
console.log('---|-----|------|------------|------|-------|-----|-------|-------|-------|-------|------');

for (let i = 0; i < Math.min(20, highWR.length); i++) {
    const r = highWR[i];
    console.log(
        `${String(i+1).padStart(2)} | m${String(r.minute).padStart(2)} | ${r.direction.padStart(4)} | ${r.pMin.toFixed(2)}-${r.pMax.toFixed(2)} | ${String(r.trainMatches).padStart(4)} | ${(r.trainWR*100).toFixed(1)}% | ${String(r.testMatches).padStart(3)} | ${(r.testWR*100).toFixed(1)}% | ${(r.testBE*100).toFixed(1)}% | ${(r.testEdge*100).toFixed(1)}% | ${r.ev.toFixed(3)} | ${(r.testLCB*100).toFixed(1)}%`
    );
}

// Now build the OPTIMAL combined set
console.log('\n=== BUILDING OPTIMAL STRATEGY SET ===');

// Selection criteria for the final set:
// 1. Must be walk-forward validated (train + test both pass)
// 2. Avoid heavy overlap (different minutes or directions)
// 3. Mix of high-WR (safety) and high-frequency (volume)
// 4. Include existing validated strategies that still pass

// Check if existing strategies still validate
console.log('\n--- Existing strategy validation on new data ---');
const existing = [
    { name: 'm14 UP [65-95c]', minute: 14, dir: 'UP', pMin: 0.65, pMax: 0.95 },
    { name: 'm11 UP [45-70c]', minute: 11, dir: 'UP', pMin: 0.45, pMax: 0.70 },
    { name: 'm12 UP [55-95c]', minute: 12, dir: 'UP', pMin: 0.55, pMax: 0.95 },
    { name: 'm12 DOWN [55-95c]', minute: 12, dir: 'DOWN', pMin: 0.55, pMax: 0.95 },
    { name: 'm11 DOWN [45-95c]', minute: 11, dir: 'DOWN', pMin: 0.45, pMax: 0.95 },
    { name: 'm11 UP [55-95c]', minute: 11, dir: 'UP', pMin: 0.55, pMax: 0.95 },
];

for (const s of existing) {
    const train = evalOnSet(trainCycles, s.minute, s.dir, s.pMin, s.pMax);
    const test = evalOnSet(testCycles, s.minute, s.dir, s.pMin, s.pMax);
    const tBE = test ? breakEvenWR(test.avgEntry) : null;
    console.log(`  ${s.name}: train=${train?.matches||0} WR=${train?((train.wr*100).toFixed(1)+'%'):'--'} | test=${test?.matches||0} WR=${test?((test.wr*100).toFixed(1)+'%'):'--'} BE=${tBE?((tBE*100).toFixed(1)+'%'):'--'} edge=${test&&tBE?((test.wr-tBE)*100).toFixed(1)+'%':'--'}`);
}

// Build recommended set: pick non-overlapping strategies with best scores
console.log('\n--- Recommended optimal set ---');
const picked = new Set();
const finalSet = [];

// First: grab top m5 DOWN strategies (new discovery)
for (const r of validated) {
    if (r.minute !== 5) continue;
    if (r.direction !== 'DOWN') continue;
    const key = `m${r.minute}_${r.direction}_${r.pMin}_${r.pMax}`;
    
    // Check not too overlapping with already-picked
    let dominated = false;
    for (const p of finalSet) {
        if (p.minute === r.minute && p.direction === r.direction) {
            // Same minute+direction -- skip if band mostly overlaps
            const overlap = Math.min(p.pMax, r.pMax) - Math.max(p.pMin, r.pMin);
            const unionSize = Math.max(p.pMax, r.pMax) - Math.min(p.pMin, r.pMin);
            if (overlap / unionSize > 0.6) { dominated = true; break; }
        }
    }
    if (dominated) continue;
    
    finalSet.push(r);
    picked.add(key);
    if (finalSet.filter(s => s.minute === 5).length >= 3) break; // max 3 m5 variants
}

// Then: grab best from other minutes
for (const r of validated) {
    if (r.minute === 5) continue; // already handled
    const key = `m${r.minute}_${r.direction}_${r.pMin}_${r.pMax}`;
    if (picked.has(key)) continue;
    
    let dominated = false;
    for (const p of finalSet) {
        if (p.minute === r.minute && p.direction === r.direction) {
            const overlap = Math.min(p.pMax, r.pMax) - Math.max(p.pMin, r.pMin);
            const unionSize = Math.max(p.pMax, r.pMax) - Math.min(p.pMin, r.pMin);
            if (overlap / unionSize > 0.6) { dominated = true; break; }
        }
    }
    if (dominated) continue;
    
    finalSet.push(r);
    picked.add(key);
    if (finalSet.length >= 10) break; // cap at 10 strategies total
}

console.log(`\nFinal set: ${finalSet.length} strategies`);
for (let i = 0; i < finalSet.length; i++) {
    const r = finalSet[i];
    console.log(`  ${i+1}. m${r.minute} ${r.direction} [${r.pMin.toFixed(2)}-${r.pMax.toFixed(2)}] | train: ${r.trainMatches}@${(r.trainWR*100).toFixed(1)}% | test: ${r.testMatches}@${(r.testWR*100).toFixed(1)}% | edge=${(r.testEdge*100).toFixed(1)}% | EV=${r.ev.toFixed(3)}`);
}

// Write strategy file
const strategyFile = {
    version: '8.0-walkforward-optimal',
    generatedAt: new Date().toISOString(),
    description: `Walk-forward validated optimal strategy set. ${finalSet.length} strategies from ${allCycles.length} cycles (${data.assets.join(',')}). Train 70% / Test 30% chronological split. Only strategies with >3% margin above break-even on BOTH train and test are included.`,
    conditions: {
        priceMin: Math.min(...finalSet.map(s => s.pMin)),
        priceMax: Math.max(...finalSet.map(s => s.pMax)),
        applyMomentumGate: false,
        applyVolumeGate: false,
    },
    stats: {
        totalStrategies: finalSet.length,
        source: `walkforward_${new Date().toISOString().split('T')[0]}`,
        dataSource: `${allCycles.length} resolved cycles (${data.assets.join(',')}) from ${new Date(trainCycles[0].epoch*1000).toISOString().split('T')[0]} to ${new Date(testCycles[testCycles.length-1].epoch*1000).toISOString().split('T')[0]}`,
    },
    strategies: finalSet.map((r, i) => ({
        id: i + 1,
        name: `m${r.minute} ${r.direction} [${(r.pMin*100).toFixed(0)}-${(r.pMax*100).toFixed(0)}c]`,
        asset: 'ALL',
        utcHour: -1,
        entryMinute: r.minute,
        direction: r.direction,
        priceMin: r.pMin,
        priceMax: r.pMax,
        tier: r.testWR >= 0.85 ? 'PLATINUM' : r.testWR >= 0.75 ? 'GOLD' : 'SILVER',
        signature: `${r.minute}|*|${r.direction}|${r.pMin}|${r.pMax}`,
        historicalWins: r.trainMatches > 0 ? Math.round(r.trainWR * r.trainMatches) : 0,
        historicalTrades: r.trainMatches,
        winRate: r.trainWR,
        winRateLCB: r.trainWR - 1.96 * Math.sqrt(r.trainWR * (1 - r.trainWR) / r.trainMatches),
        oosWinRate: r.testWR,
        oosMatches: r.testMatches,
        oosMarginAboveBreakEven: r.testEdge,
        breakEvenWR: r.testBE,
        dataNote: `Train: ${r.trainMatches} matches, ${(r.trainWR*100).toFixed(1)}% WR. Test: ${r.testMatches} matches, ${(r.testWR*100).toFixed(1)}% WR. Edge: ${(r.testEdge*100).toFixed(1)}% above break-even.`
    }))
};

const outPath = path.join(__dirname, '..', 'debug', 'strategy_set_15m_optimal_v8.json');
fs.writeFileSync(outPath, JSON.stringify(strategyFile, null, 2));
console.log(`\nSaved to: ${outPath}`);
