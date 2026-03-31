/**
 * EXHAUSTIVE STRATEGY SEARCH
 * 
 * Scans ALL (minute, direction, priceMin, priceMax) combinations
 * across the collected intracycle data to find the highest-edge strategies.
 * 
 * For each candidate strategy, computes:
 * - Match count (how many cycles it would have fired)
 * - Win rate (resolution matches direction)
 * - Break-even WR (accounting for 3.15% taker fee at avg entry price)
 * - Edge = WR - breakEvenWR
 * - Expected value per trade
 * - Frequency (matches per day per asset)
 * 
 * Filters: min 20 matches, positive edge, WR > breakEven + 3%
 */

const fs = require('fs');
const path = require('path');

const DATA_PATH = path.join(__dirname, '..', 'data', 'intracycle-price-data.json');
const data = JSON.parse(fs.readFileSync(DATA_PATH, 'utf8'));
const cycles = data.cycles;

console.log(`Loaded ${cycles.length} cycles from ${data.generatedAt}`);
console.log(`Assets: ${Object.entries(data.cyclesByAsset).map(([a,d]) => `${a}:${d.total}(${d.upWins}U/${d.downWins}D)`).join(' ')}`);

const TAKER_FEE = 0.0315;
const MIN_MATCHES = 15;
const MIN_EDGE = 0.03; // 3% above break-even

// Strategy parameter space
const MINUTES = [0,1,2,3,4,5,6,7,8,9,10,11,12,13,14];
const DIRECTIONS = ['UP', 'DOWN'];
const PRICE_MINS = [0.05, 0.10, 0.15, 0.20, 0.25, 0.30, 0.35, 0.40, 0.45, 0.50, 0.55, 0.60, 0.65, 0.70, 0.75, 0.80];
const PRICE_MAXS = [0.30, 0.35, 0.40, 0.45, 0.50, 0.55, 0.60, 0.65, 0.70, 0.75, 0.80, 0.85, 0.90, 0.95];

function breakEvenWR(avgEntry) {
    if (avgEntry <= 0 || avgEntry >= 1) return 1;
    const winROI = (1 - avgEntry) / avgEntry;
    const netWinROI = winROI * (1 - TAKER_FEE);
    return 1 / (1 + netWinROI);
}

function evaluateStrategy(minute, direction, pMin, pMax) {
    let matches = 0;
    let wins = 0;
    let entrySum = 0;
    
    for (const cycle of cycles) {
        // Get price at this minute for the correct side
        const priceMap = direction === 'UP' ? cycle.minutePricesYes : cycle.minutePricesNo;
        const priceData = priceMap[minute];
        if (!priceData) continue;
        
        const price = priceData.last; // use last price at that minute (most realistic)
        if (price < pMin || price > pMax) continue;
        
        matches++;
        entrySum += price;
        
        if (cycle.resolution === direction) wins++;
    }
    
    if (matches < MIN_MATCHES) return null;
    
    const wr = wins / matches;
    const avgEntry = entrySum / matches;
    const be = breakEvenWR(avgEntry);
    const edge = wr - be;
    
    if (edge < MIN_EDGE) return null;
    
    // Expected value per trade (in $ per $1 risked)
    const netWinROI = ((1 - avgEntry) / avgEntry) * (1 - TAKER_FEE);
    const ev = wr * netWinROI - (1 - wr); // per $1 risked
    
    // Approximate trades per day: matches / (totalDays * 4 assets)
    // ~2 days of data, 4 assets
    const totalDays = cycles.length / 4 / 96; // approximate
    const tradesPerDay = matches / totalDays / 4; // per asset per day -> total with 4 assets
    
    return {
        minute, direction, pMin, pMax,
        matches, wins, wr: wr,
        avgEntry: avgEntry,
        breakEven: be,
        edge: edge,
        ev: ev,
        tradesPerDay: tradesPerDay * 4, // across all 4 assets
        profitScore: ev * tradesPerDay * 4, // daily EV * frequency
        lcb: wr - 1.96 * Math.sqrt(wr * (1 - wr) / matches) // 95% CI lower bound
    };
}

console.log('\nScanning all strategy combinations...');

const results = [];
let scanned = 0;

for (const minute of MINUTES) {
    for (const direction of DIRECTIONS) {
        for (const pMin of PRICE_MINS) {
            for (const pMax of PRICE_MAXS) {
                if (pMax <= pMin) continue;
                if (pMax - pMin < 0.05) continue; // need at least 5c band
                
                scanned++;
                const result = evaluateStrategy(minute, direction, pMin, pMax);
                if (result) results.push(result);
            }
        }
    }
}

console.log(`Scanned ${scanned} combinations, found ${results.length} viable strategies`);

// Sort by profit score (EV * frequency)
results.sort((a, b) => b.profitScore - a.profitScore);

// Print top 30 by profit score
console.log('\n=== TOP 30 BY PROFIT SCORE (EV * daily frequency) ===');
console.log('Rank | Min | Dir  | Band       | Match | WR    | AvgEntry | BE    | Edge  | EV/trade | Tr/day | Score  | LCB');
console.log('-----|-----|------|------------|-------|-------|----------|-------|-------|----------|--------|--------|------');

for (let i = 0; i < Math.min(30, results.length); i++) {
    const r = results[i];
    const pad = (s, n) => String(s).padStart(n);
    console.log(
        `${pad(i + 1, 4)} | m${pad(r.minute, 2)} | ${pad(r.direction, 4)} | ${r.pMin.toFixed(2)}-${r.pMax.toFixed(2)} | ${pad(r.matches, 5)} | ${(r.wr * 100).toFixed(1)}% | ${r.avgEntry.toFixed(3)}    | ${(r.breakEven * 100).toFixed(1)}% | ${(r.edge * 100).toFixed(1)}% | ${r.ev.toFixed(4)}   | ${r.tradesPerDay.toFixed(1).padStart(6)} | ${r.profitScore.toFixed(4).padStart(6)} | ${(r.lcb * 100).toFixed(1)}%`
    );
}

// Also sort by highest win rate (for resolution-sniping candidates)
const highWR = results.filter(r => r.wr >= 0.85 && r.matches >= 20).sort((a, b) => b.wr - a.wr);
console.log('\n=== HIGHEST WIN RATE STRATEGIES (WR >= 85%, matches >= 20) ===');
console.log('Rank | Min | Dir  | Band       | Match | WR    | AvgEntry | BE    | Edge  | EV/trade | Tr/day | LCB');
console.log('-----|-----|------|------------|-------|-------|----------|-------|-------|----------|--------|------');

for (let i = 0; i < Math.min(20, highWR.length); i++) {
    const r = highWR[i];
    console.log(
        `${String(i + 1).padStart(4)} | m${String(r.minute).padStart(2)} | ${r.direction.padStart(4)} | ${r.pMin.toFixed(2)}-${r.pMax.toFixed(2)} | ${String(r.matches).padStart(5)} | ${(r.wr * 100).toFixed(1)}% | ${r.avgEntry.toFixed(3)}    | ${(r.breakEven * 100).toFixed(1)}% | ${(r.edge * 100).toFixed(1)}% | ${r.ev.toFixed(4)}   | ${r.tradesPerDay.toFixed(1).padStart(6)} | ${(r.lcb * 100).toFixed(1)}%`
    );
}

// Find best LOW-ENTRY strategies (pMax <= 0.60) for high ROI
const lowEntry = results.filter(r => r.pMax <= 0.65 && r.matches >= 15).sort((a, b) => b.ev - a.ev);
console.log('\n=== BEST LOW-ENTRY STRATEGIES (maxPrice <= 65c, high ROI per trade) ===');
console.log('Rank | Min | Dir  | Band       | Match | WR    | AvgEntry | BE    | Edge  | EV/trade | Tr/day | LCB');
console.log('-----|-----|------|------------|-------|-------|----------|-------|-------|----------|--------|------');

for (let i = 0; i < Math.min(15, lowEntry.length); i++) {
    const r = lowEntry[i];
    console.log(
        `${String(i + 1).padStart(4)} | m${String(r.minute).padStart(2)} | ${r.direction.padStart(4)} | ${r.pMin.toFixed(2)}-${r.pMax.toFixed(2)} | ${String(r.matches).padStart(5)} | ${(r.wr * 100).toFixed(1)}% | ${r.avgEntry.toFixed(3)}    | ${(r.breakEven * 100).toFixed(1)}% | ${(r.edge * 100).toFixed(1)}% | ${r.ev.toFixed(4)}   | ${r.tradesPerDay.toFixed(1).padStart(6)} | ${(r.lcb * 100).toFixed(1)}%`
    );
}

// Look for death-bounce patterns: large intracycle price drops that recover
console.log('\n=== DEATH BOUNCE ANALYSIS ===');
let bounceCount = 0;
let bounceWins = 0;
let noBounceCount = 0;

for (const cycle of cycles) {
    const prices = cycle.minutePricesYes;
    const priceList = [];
    for (let m = 0; m <= 14; m++) {
        if (prices[m]) priceList.push({ m, p: prices[m].last });
    }
    if (priceList.length < 5) continue;
    
    // Find max drop within cycle
    let peak = priceList[0].p;
    let maxDrop = 0;
    let dropMinute = -1;
    
    for (let i = 1; i < priceList.length; i++) {
        if (priceList[i].p > peak) peak = priceList[i].p;
        const drop = peak - priceList[i].p;
        if (drop > maxDrop) {
            maxDrop = drop;
            dropMinute = priceList[i].m;
        }
    }
    
    if (maxDrop >= 0.15 && dropMinute >= 3 && dropMinute <= 12) {
        bounceCount++;
        // If price dropped significantly but UP still won, that's a death bounce opportunity
        if (cycle.resolution === 'UP') bounceWins++;
    }
}

console.log(`Cycles with 15+c intracycle drop (m3-m12): ${bounceCount}`);
console.log(`Of those, UP still won: ${bounceWins} (${bounceCount > 0 ? (bounceWins/bounceCount*100).toFixed(1) : 0}%)`);
console.log(`Death-bounce BUY-UP WR: ${bounceCount > 0 ? (bounceWins/bounceCount*100).toFixed(1) : 'N/A'}%`);

// Cross-asset correlation
console.log('\n=== CROSS-ASSET CORRELATION ===');
const epochMap = {};
for (const cycle of cycles) {
    if (!epochMap[cycle.epoch]) epochMap[cycle.epoch] = {};
    epochMap[cycle.epoch][cycle.asset] = cycle.resolution;
}

let allUpCount = 0, allDownCount = 0, mixedCount = 0, totalEpochs = 0;
for (const [epoch, assets] of Object.entries(epochMap)) {
    const resolutions = Object.values(assets);
    if (resolutions.length < 3) continue;
    totalEpochs++;
    if (resolutions.every(r => r === 'UP')) allUpCount++;
    else if (resolutions.every(r => r === 'DOWN')) allDownCount++;
    else mixedCount++;
}

console.log(`Epochs with 3+ assets: ${totalEpochs}`);
console.log(`All UP: ${allUpCount} (${(allUpCount/totalEpochs*100).toFixed(1)}%)`);
console.log(`All DOWN: ${allDownCount} (${(allDownCount/totalEpochs*100).toFixed(1)}%)`);
console.log(`Mixed: ${mixedCount} (${(mixedCount/totalEpochs*100).toFixed(1)}%)`);

// Summary statistics
console.log('\n=== SUMMARY ===');
console.log(`Total viable strategies found: ${results.length}`);
console.log(`Best profit score: m${results[0]?.minute} ${results[0]?.direction} ${results[0]?.pMin.toFixed(2)}-${results[0]?.pMax.toFixed(2)} (score=${results[0]?.profitScore.toFixed(4)})`);
console.log(`Highest WR: m${highWR[0]?.minute} ${highWR[0]?.direction} ${highWR[0]?.pMin.toFixed(2)}-${highWR[0]?.pMax.toFixed(2)} (WR=${(highWR[0]?.wr*100).toFixed(1)}%)`);
if (lowEntry.length > 0) {
    console.log(`Best low-entry EV: m${lowEntry[0]?.minute} ${lowEntry[0]?.direction} ${lowEntry[0]?.pMin.toFixed(2)}-${lowEntry[0]?.pMax.toFixed(2)} (EV=${lowEntry[0]?.ev.toFixed(4)}/trade)`);
}
