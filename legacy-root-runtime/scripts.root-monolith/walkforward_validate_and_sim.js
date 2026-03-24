/**
 * WALK-FORWARD VALIDATION + REPLAY SIMULATION + PROFIT PROJECTION
 * 
 * Usage:
 *   node scripts/walkforward_validate_and_sim.js --timeframe=5m
 *   node scripts/walkforward_validate_and_sim.js --timeframe=4h
 *   node scripts/walkforward_validate_and_sim.js --timeframe=5m --startBal=20 --maxStrategies=8
 * 
 * This script:
 * 1. Loads the decision dataset from exhaustive_analysis/<tf>/
 * 2. Splits chronologically 70/30 for walk-forward validation
 * 3. Searches for optimal strategies on train set
 * 4. Validates on test set
 * 5. Selects the best strategies optimized for max profit / quickest time / low bust risk
 * 6. Runs full bankroll replay simulation with micro-bankroll conditions
 * 7. Runs Monte Carlo profit projections
 * 8. Outputs strategy set JSON + summary artifacts to debug/
 */

const fs = require('fs');
const path = require('path');

// ============== ARGS ==============
function readArg(prefix) {
    const a = process.argv.find(x => x.startsWith(prefix));
    return a ? a.slice(prefix.length) : null;
}

const TF_KEY = readArg('--timeframe=') || '5m';
const START_BAL = parseFloat(readArg('--startBal=') || '20');
const MAX_STRATEGIES = parseInt(readArg('--maxStrategies=') || '12', 10);
const TRAIN_RATIO = parseFloat(readArg('--trainRatio=') || '0.70');
const MIN_TRADES_TRAIN = parseInt(readArg('--minTradesTrain=') || '8', 10);
const MIN_TRADES_TEST = parseInt(readArg('--minTradesTest=') || '3', 10);
const MIN_COMBINED_TRADES = parseInt(readArg('--minCombinedTrades=') || '15', 10);
const TAKER_FEE_RATE = 0.02;

const TF_CONFIGS = {
    '5m': { cycleSec: 300, entryMinutes: [0, 1, 2, 3], utcHours: Array.from({length:24},(_,i)=>i), label: '5-Minute' },
    '4h': { cycleSec: 14400, entryMinutes: [0,15,30,45,60,90,120,150,180,210,230], utcHours: [1,5,9,13,17,21], label: '4-Hour' },
    '15m': { cycleSec: 900, entryMinutes: Array.from({length:15},(_,i)=>i), utcHours: Array.from({length:24},(_,i)=>i), label: '15-Minute' }
};

const TF = TF_CONFIGS[TF_KEY];
if (!TF) { console.error('Unknown timeframe:', TF_KEY); process.exit(1); }

const DATASET_PATH = path.join(__dirname, '..', 'exhaustive_analysis', TF_KEY, `${TF_KEY}_decision_dataset.json`);
const MANIFEST_PATH = path.join(__dirname, '..', 'exhaustive_analysis', TF_KEY, `${TF_KEY}_manifest.json`);
const OUTPUT_DIR = path.join(__dirname, '..', 'debug');

if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });

// ============== HELPERS ==============
function wilsonLCB(wins, total, z = 1.96) {
    if (total <= 0) return 0;
    const p = wins / total;
    const d = 1 + (z * z) / total;
    const c = p + (z * z) / (2 * total);
    const m = z * Math.sqrt((p * (1 - p) + (z * z) / (4 * total)) / total);
    return Math.max(0, (c - m) / d);
}

function calcROI(entryPrice, won) {
    const grossROI = won ? (1 / entryPrice) - 1 : -1;
    const fee = won ? grossROI * TAKER_FEE_RATE : 0;
    return grossROI - fee;
}

// ============== PHASE 1: LOAD AND SPLIT DATA ==============
function loadAndSplitData() {
    console.log(`Loading dataset from ${DATASET_PATH}...`);
    const raw = JSON.parse(fs.readFileSync(DATASET_PATH, 'utf8'));
    const dataset = raw.filter(r => r && r.hasIntracycle !== false && r.entryMinute >= 0);
    
    // Load manifest for market-level data
    let manifest = [];
    if (fs.existsSync(MANIFEST_PATH)) {
        const mRaw = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
        manifest = mRaw.manifest || mRaw;
    }
    
    // Sort by cycle epoch
    dataset.sort((a, b) => a.cycleStartEpochSec - b.cycleStartEpochSec);
    
    // Get unique markets (by slug) for splitting
    const marketMap = new Map();
    for (const row of dataset) {
        if (!marketMap.has(row.slug)) {
            marketMap.set(row.slug, { slug: row.slug, asset: row.asset, epoch: row.cycleStartEpochSec, outcome: row.resolvedOutcome });
        }
    }
    const markets = [...marketMap.values()].sort((a, b) => a.epoch - b.epoch);
    
    const splitIdx = Math.floor(markets.length * TRAIN_RATIO);
    const trainSlugs = new Set(markets.slice(0, splitIdx).map(m => m.slug));
    const testSlugs = new Set(markets.slice(splitIdx).map(m => m.slug));
    
    const trainData = dataset.filter(r => trainSlugs.has(r.slug));
    const testData = dataset.filter(r => testSlugs.has(r.slug));
    
    const trainMarkets = markets.slice(0, splitIdx);
    const testMarkets = markets.slice(splitIdx);
    
    // Asset coverage
    const assets = [...new Set(markets.map(m => m.asset))].sort();
    const perAsset = {};
    for (const a of assets) {
        perAsset[a] = {
            train: trainMarkets.filter(m => m.asset === a).length,
            test: testMarkets.filter(m => m.asset === a).length,
            total: markets.filter(m => m.asset === a).length
        };
    }
    
    const spanDays = markets.length > 1 ? (markets[markets.length-1].epoch - markets[0].epoch) / 86400 : 0;
    
    console.log(`  Total rows: ${dataset.length} | Markets: ${markets.length} | Span: ${spanDays.toFixed(1)} days`);
    console.log(`  Assets: ${assets.join(', ')}`);
    console.log(`  Train: ${trainMarkets.length} markets (${trainData.length} rows) | Test: ${testMarkets.length} markets (${testData.length} rows)`);
    for (const a of assets) {
        console.log(`    ${a}: train=${perAsset[a].train} test=${perAsset[a].test} total=${perAsset[a].total}`);
    }
    
    return { dataset, trainData, testData, trainMarkets, testMarkets, markets, assets, perAsset, spanDays };
}

// ============== PHASE 2: STRATEGY SEARCH ON TRAIN SET ==============
function searchStrategies(data, markets) {
    console.log(`\nSearching strategies on ${data.length} train rows...`);
    
    const priceBands = [
        { min: 0.45, max: 0.55 }, { min: 0.50, max: 0.65 },
        { min: 0.55, max: 0.70 }, { min: 0.60, max: 0.75 },
        { min: 0.60, max: 0.80 }, { min: 0.65, max: 0.80 },
        { min: 0.70, max: 0.80 }, { min: 0.72, max: 0.80 },
        { min: 0.50, max: 0.80 }, { min: 0.55, max: 0.80 },
        { min: 0.45, max: 0.70 }, { min: 0.50, max: 0.70 },
        { min: 0.40, max: 0.65 }, { min: 0.35, max: 0.65 },
    ];
    const directions = ['UP', 'DOWN'];
    
    // Index by entryMinute|utcHour
    const indexed = new Map();
    for (const row of data) {
        if (!row || row.entryMinute < 0) continue;
        const key = `${row.entryMinute}|${row.utcHour}`;
        if (!indexed.has(key)) indexed.set(key, []);
        indexed.get(key).push(row);
    }
    
    const totalDays = markets.length > 1 ? (Math.max(...markets.map(m => m.epoch)) - Math.min(...markets.map(m => m.epoch))) / 86400 : 1;
    
    const strategies = [];
    
    for (const entryMin of TF.entryMinutes) {
        for (const hour of TF.utcHours) {
            const base = indexed.get(`${entryMin}|${hour}`) || [];
            if (base.length < 3) continue;
            
            for (const band of priceBands) {
                for (const dir of directions) {
                    let wins = 0, totalROI = 0, trades = 0;
                    const entryPrices = [];
                    
                    for (const row of base) {
                        const entryPrice = dir === 'UP' ? row.upPrice : row.downPrice;
                        if (!Number.isFinite(entryPrice) || entryPrice < band.min || entryPrice > band.max) continue;
                        trades++;
                        const won = (dir === 'UP') === row.winnerIsUp;
                        if (won) wins++;
                        totalROI += calcROI(entryPrice, won);
                        entryPrices.push(entryPrice);
                    }
                    
                    if (trades < MIN_TRADES_TRAIN) continue;
                    const winRate = wins / trades;
                    const lcb = wilsonLCB(wins, trades);
                    const avgROI = totalROI / trades;
                    const avgEntry = entryPrices.reduce((a,b)=>a+b,0) / entryPrices.length;
                    
                    strategies.push({
                        entryMinute: entryMin, utcHour: hour,
                        direction: dir, priceMin: band.min, priceMax: band.max,
                        trainWins: wins, trainTrades: trades, trainWinRate: winRate, trainLCB: lcb,
                        trainAvgROI: avgROI, trainTotalROI: totalROI, trainAvgEntry: avgEntry,
                        tradesPerDay: trades / totalDays,
                        signature: `${entryMin}|${hour}|${dir}|${band.min}|${band.max}`
                    });
                }
            }
        }
    }
    
    strategies.sort((a, b) => b.trainLCB - a.trainLCB || b.tradesPerDay - a.tradesPerDay);
    console.log(`  Found ${strategies.length} train candidates`);
    return strategies;
}

// ============== PHASE 3: VALIDATE ON TEST SET ==============
function validateStrategies(candidates, testData) {
    console.log(`\nValidating ${candidates.length} candidates on test set...`);
    
    const indexed = new Map();
    for (const row of testData) {
        if (!row || row.entryMinute < 0) continue;
        const key = `${row.entryMinute}|${row.utcHour}`;
        if (!indexed.has(key)) indexed.set(key, []);
        indexed.get(key).push(row);
    }
    
    const validated = [];
    
    for (const strat of candidates) {
        const base = indexed.get(`${strat.entryMinute}|${strat.utcHour}`) || [];
        let wins = 0, trades = 0, totalROI = 0;
        
        for (const row of base) {
            const entryPrice = strat.direction === 'UP' ? row.upPrice : row.downPrice;
            if (!Number.isFinite(entryPrice) || entryPrice < strat.priceMin || entryPrice > strat.priceMax) continue;
            trades++;
            const won = (strat.direction === 'UP') === row.winnerIsUp;
            if (won) wins++;
            totalROI += calcROI(entryPrice, won);
        }
        
        if (trades < MIN_TRADES_TEST) continue;
        
        const allWins = strat.trainWins + wins;
        const allTrades = strat.trainTrades + trades;
        const allWR = allWins / allTrades;
        const allLCB = wilsonLCB(allWins, allTrades);
        const allROI = (strat.trainTotalROI + totalROI) / allTrades;
        
        if (allTrades < MIN_COMBINED_TRADES) continue;
        
        validated.push({
            ...strat,
            testWins: wins, testTrades: trades,
            testWinRate: trades > 0 ? wins / trades : 0,
            testLCB: wilsonLCB(wins, trades),
            testAvgROI: trades > 0 ? totalROI / trades : 0,
            allWins, allTrades, allWinRate: allWR, allLCB,
            allAvgROI: allROI, allTotalROI: strat.trainTotalROI + totalROI,
            // Composite score: prioritize high LCB * high trades/day * high ROI for max profit / quickest time
            profitScore: allLCB * (strat.tradesPerDay + 0.1) * Math.max(0.01, allROI)
        });
    }
    
    validated.sort((a, b) => b.profitScore - a.profitScore || b.allLCB - a.allLCB);
    console.log(`  Validated: ${validated.length} strategies`);
    return validated;
}

// ============== PHASE 4: SELECT OPTIMAL STRATEGY SET ==============
function selectOptimalSet(validated) {
    console.log(`\nSelecting optimal set (max ${MAX_STRATEGIES})...`);
    
    // Adaptive thresholds based on timeframe
    const wrFloor = TF_KEY === '4h' ? 0.82 : 0.78;
    const testWrFloor = TF_KEY === '4h' ? 0.70 : 0.65;
    const lcbFloor = TF_KEY === '4h' ? 0.62 : 0.55;
    
    const eligible = validated.filter(s =>
        s.trainWinRate >= wrFloor &&
        s.testWinRate >= testWrFloor &&
        s.allLCB >= lcbFloor &&
        s.allTrades >= MIN_COMBINED_TRADES
    );
    
    console.log(`  Eligible after filters: ${eligible.length}`);
    
    // Deduplicate: keep best per signature (already sorted by profitScore)
    const seen = new Set();
    const deduped = [];
    for (const s of eligible) {
        if (!seen.has(s.signature)) {
            seen.add(s.signature);
            deduped.push(s);
        }
    }
    
    // Remove overlapping strategies: prefer higher profitScore
    // Two strategies overlap if same utcHour + direction (different entry minutes within same cycle are redundant)
    const bySlot = new Map();
    for (const s of deduped) {
        const slotKey = `${s.utcHour}|${s.direction}`;
        if (!bySlot.has(slotKey)) bySlot.set(slotKey, []);
        bySlot.get(slotKey).push(s);
    }
    
    const selected = [];
    for (const [, group] of bySlot) {
        // Take the one with highest profitScore
        group.sort((a, b) => b.profitScore - a.profitScore);
        selected.push(group[0]);
    }
    
    // Sort by profitScore and take top N
    selected.sort((a, b) => b.profitScore - a.profitScore);
    const final = selected.slice(0, MAX_STRATEGIES);
    
    // Assign tiers
    for (let i = 0; i < final.length; i++) {
        if (final[i].allLCB >= 0.75 && final[i].allWinRate >= 0.90) final[i].tier = 'PLATINUM';
        else if (final[i].allLCB >= 0.65 && final[i].allWinRate >= 0.85) final[i].tier = 'GOLD';
        else final[i].tier = 'SILVER';
    }
    
    console.log(`  Selected: ${final.length} strategies`);
    for (const s of final) {
        console.log(`    ${s.tier} H${String(s.utcHour).padStart(2,'0')} m${String(s.entryMinute).padStart(2,'0')} ${s.direction} ${(s.priceMin*100).toFixed(0)}-${(s.priceMax*100).toFixed(0)}c | ${s.allTrades}t ${(s.allWinRate*100).toFixed(1)}% LCB=${(s.allLCB*100).toFixed(1)}% ROI=${(s.allAvgROI*100).toFixed(1)}% ${s.tradesPerDay.toFixed(2)}/day`);
    }
    
    return final;
}

// ============== PHASE 5: REPLAY SIMULATION ==============
function replaySimulation(strategySet, allData, allMarkets, startBal) {
    console.log(`\nRunning replay simulation (start=$${startBal})...`);
    
    // Group data by market slug
    const bySlug = new Map();
    for (const row of allData) {
        if (!bySlug.has(row.slug)) bySlug.set(row.slug, []);
        bySlug.get(row.slug).push(row);
    }
    
    // Sort markets chronologically
    const sortedMarkets = [...allMarkets].sort((a, b) => a.epoch - b.epoch);
    
    let balance = startBal;
    let peakBalance = startBal;
    let maxDrawdown = 0;
    let wins = 0, losses = 0, executed = 0, skipped = 0;
    let consecutiveLosses = 0;
    let maxConsecutiveLosses = 0;
    let globalStopBlocks = 0;
    const trades = [];
    const balanceHistory = [{ epoch: sortedMarkets[0]?.epoch || 0, balance: startBal }];
    
    const MIN_ORDER_SHARES = 5;
    const MAX_POS_FRAC = 0.32;
    const MAX_ABSOLUTE_STAKE = 100; // Polymarket liquidity cap
    const SLIPPAGE = 0.01;
    const GLOBAL_STOP_FLOOR = TF_KEY === '5m' ? 0.05 : 0.20; // 5m gets lenient stop since many trades
    
    for (const market of sortedMarkets) {
        const rows = bySlug.get(market.slug) || [];
        if (rows.length === 0) continue;
        
        // Check global stop
        if (balance < peakBalance * GLOBAL_STOP_FLOOR) {
            globalStopBlocks++;
            skipped++;
            continue;
        }
        
        // Try each strategy against this market
        let bestCandidate = null;
        let bestScore = -Infinity;
        
        for (const strat of strategySet) {
            // Find matching row
            const matchRow = rows.find(r =>
                r.utcHour === strat.utcHour &&
                r.entryMinute === strat.entryMinute
            );
            if (!matchRow) continue;
            
            const entryPrice = strat.direction === 'UP' ? matchRow.upPrice : matchRow.downPrice;
            if (!Number.isFinite(entryPrice) || entryPrice < strat.priceMin || entryPrice > strat.priceMax) continue;
            
            const won = (strat.direction === 'UP') === matchRow.winnerIsUp;
            const score = (strat.allLCB || 0) * 1000 + (strat.allAvgROI || 0);
            
            if (score > bestScore) {
                bestScore = score;
                bestCandidate = { strat, entryPrice, won, row: matchRow };
            }
        }
        
        if (!bestCandidate) {
            skipped++;
            continue;
        }
        
        const { strat, entryPrice, won } = bestCandidate;
        
        // Sizing: micro-bankroll aware
        const effectiveEntry = Math.min(0.99, entryPrice * (1 + SLIPPAGE));
        const minOrderCost = MIN_ORDER_SHARES * effectiveEntry;
        
        // Base stake: adaptive sizing based on balance stage
        const adaptiveFrac = balance < startBal * 0.5 ? 0.15 : (balance < startBal ? 0.20 : MAX_POS_FRAC);
        let stakeUsd = balance * adaptiveFrac;
        
        // Cap at absolute max (liquidity)
        stakeUsd = Math.min(stakeUsd, MAX_ABSOLUTE_STAKE);
        
        // Bump to min order if needed
        if (stakeUsd < minOrderCost && balance >= minOrderCost * 1.05) {
            stakeUsd = minOrderCost;
        }
        
        // Can't afford
        if (stakeUsd < minOrderCost || balance < minOrderCost * 1.05) {
            skipped++;
            continue;
        }
        
        // Cap at balance fraction
        stakeUsd = Math.min(stakeUsd, balance * 0.75);
        if (stakeUsd < minOrderCost) { skipped++; continue; }
        
        // Execute trade
        const shares = stakeUsd / effectiveEntry;
        const feePerShare = 0.25 * Math.pow(effectiveEntry * (1 - effectiveEntry), 2);
        const totalFee = shares * feePerShare;
        
        let deltaUsd;
        if (won) {
            deltaUsd = (shares * 1.0) - stakeUsd - totalFee; // Win: shares pay $1 each
            wins++;
            consecutiveLosses = 0;
        } else {
            deltaUsd = -stakeUsd - totalFee; // Lose: lose entire stake + fee
            losses++;
            consecutiveLosses++;
            maxConsecutiveLosses = Math.max(maxConsecutiveLosses, consecutiveLosses);
        }
        
        balance += deltaUsd;
        if (balance < 0) balance = 0;
        peakBalance = Math.max(peakBalance, balance);
        
        const dd = peakBalance > 0 ? (peakBalance - balance) / peakBalance : 0;
        maxDrawdown = Math.max(maxDrawdown, dd);
        
        executed++;
        trades.push({
            epoch: market.epoch,
            asset: market.asset,
            direction: strat.direction,
            entryPrice,
            effectiveEntry,
            stakeUsd,
            won,
            deltaUsd,
            balance,
            drawdown: dd,
            strategy: strat.signature
        });
        
        balanceHistory.push({ epoch: market.epoch, balance });
    }
    
    const totalTrades = wins + losses;
    const winRate = totalTrades > 0 ? wins / totalTrades : 0;
    const roi = startBal > 0 ? (balance - startBal) / startBal : 0;
    const spanDays = sortedMarkets.length > 1 ? (sortedMarkets[sortedMarkets.length-1].epoch - sortedMarkets[0].epoch) / 86400 : 1;
    const tradesPerDay = totalTrades / Math.max(1, spanDays);
    
    const result = {
        startBalance: startBal,
        endBalance: parseFloat(balance.toFixed(2)),
        roi: parseFloat((roi * 100).toFixed(2)),
        totalTrades,
        wins, losses, winRate: parseFloat((winRate * 100).toFixed(2)),
        maxDrawdown: parseFloat((maxDrawdown * 100).toFixed(2)),
        maxConsecutiveLosses,
        globalStopBlocks,
        executed, skipped,
        tradesPerDay: parseFloat(tradesPerDay.toFixed(2)),
        spanDays: parseFloat(spanDays.toFixed(1)),
        profitMultiple: parseFloat((balance / startBal).toFixed(2))
    };
    
    console.log(`  End balance: $${result.endBalance} (${result.roi}% ROI)`);
    console.log(`  Trades: ${totalTrades} (${result.wins}W/${result.losses}L, ${result.winRate}% WR)`);
    console.log(`  Max DD: ${result.maxDrawdown}% | Max loss streak: ${maxConsecutiveLosses}`);
    console.log(`  Trades/day: ${result.tradesPerDay} | Profit multiple: ${result.profitMultiple}x`);
    
    return { result, trades, balanceHistory };
}

// ============== PHASE 6: STRESS TEST ==============
function stressTest(strategySet, allData, allMarkets, startBal) {
    console.log(`\nRunning stress tests...`);
    const bumps = [0, 0.03, 0.05, 0.10];
    const results = [];
    
    for (const bump of bumps) {
        // Create bumped data
        const bumpedData = allData.map(r => ({
            ...r,
            upPrice: Math.min(0.99, r.upPrice + bump),
            downPrice: Math.min(0.99, r.downPrice + bump)
        }));
        
        const { result } = replaySimulation(strategySet, bumpedData, allMarkets, startBal);
        results.push({
            entryBump: `+${(bump * 100).toFixed(0)}c`,
            ...result
        });
        console.log(`  +${(bump*100).toFixed(0)}c: end=$${result.endBalance} maxDD=${result.maxDrawdown}% WR=${result.winRate}%`);
    }
    
    return results;
}

// ============== PHASE 7: MONTE CARLO PROFIT PROJECTION ==============
function monteCarloProjection(winRate, avgEntryPrice, tradesPerDay, startBal, days = 30, simulations = 10000) {
    console.log(`\nMonte Carlo projection (${simulations} sims, ${days} days, WR=${winRate}%, entry~${typeof avgEntryPrice === 'number' ? (avgEntryPrice*100).toFixed(0)+'c' : avgEntryPrice})...`);
    
    // Use realistic entry price for win/loss calculation
    const entryP = (typeof avgEntryPrice === 'number' && avgEntryPrice > 0 && avgEntryPrice < 1) ? avgEntryPrice : 0.65;
    const wr = winRate / 100;
    
    const results = [];
    const BUST_THRESHOLD = 3.0;
    const MAX_ABS_STAKE = 100;
    let bustCount = 0;
    
    for (let sim = 0; sim < simulations; sim++) {
        let bal = startBal;
        let peak = startBal;
        let maxDD = 0;
        const totalTrades = Math.round(tradesPerDay * days);
        
        for (let t = 0; t < totalTrades; t++) {
            if (bal < BUST_THRESHOLD) break;
            
            let stakeUsd = Math.min(bal * 0.32, MAX_ABS_STAKE);
            const minOrder = 5 * entryP;
            if (stakeUsd < minOrder) {
                if (bal >= minOrder * 1.05) stakeUsd = minOrder;
                else break;
            }
            stakeUsd = Math.min(stakeUsd, bal * 0.80);
            if (stakeUsd < minOrder) break;
            
            const won = Math.random() < wr;
            if (won) {
                // Win: gain = shares * $1 - stake - fee
                const shares = stakeUsd / entryP;
                const feePerShare = 0.25 * Math.pow(entryP * (1 - entryP), 2);
                bal += (shares * 1.0) - stakeUsd - (shares * feePerShare);
            } else {
                // Lose: lose stake + fee
                const shares = stakeUsd / entryP;
                const feePerShare = 0.25 * Math.pow(entryP * (1 - entryP), 2);
                bal -= stakeUsd + (shares * feePerShare);
            }
            
            if (bal < 0) bal = 0;
            peak = Math.max(peak, bal);
            const dd = peak > 0 ? (peak - bal) / peak : 0;
            maxDD = Math.max(maxDD, dd);
        }
        
        results.push({ endBal: bal, maxDD, bust: bal < BUST_THRESHOLD });
        if (bal < BUST_THRESHOLD) bustCount++;
    }
    
    results.sort((a, b) => a.endBal - b.endBal);
    
    const median = results[Math.floor(results.length * 0.5)].endBal;
    const p10 = results[Math.floor(results.length * 0.1)].endBal;
    const p25 = results[Math.floor(results.length * 0.25)].endBal;
    const p75 = results[Math.floor(results.length * 0.75)].endBal;
    const p90 = results[Math.floor(results.length * 0.9)].endBal;
    const mean = results.reduce((a, b) => a + b.endBal, 0) / results.length;
    const bustRate = (bustCount / simulations * 100);
    const avgMaxDD = results.reduce((a, b) => a + b.maxDD, 0) / results.length * 100;
    
    const projection = {
        days, simulations, startBal,
        median: parseFloat(median.toFixed(2)),
        mean: parseFloat(mean.toFixed(2)),
        p10: parseFloat(p10.toFixed(2)),
        p25: parseFloat(p25.toFixed(2)),
        p75: parseFloat(p75.toFixed(2)),
        p90: parseFloat(p90.toFixed(2)),
        bustRate: parseFloat(bustRate.toFixed(2)),
        avgMaxDD: parseFloat(avgMaxDD.toFixed(1)),
        medianMultiple: parseFloat((median / startBal).toFixed(2))
    };
    
    console.log(`  ${days}-day projection from $${startBal}:`);
    console.log(`    Median: $${projection.median} (${projection.medianMultiple}x)`);
    console.log(`    Mean: $${projection.mean}`);
    console.log(`    P10/P25/P75/P90: $${projection.p10}/$${projection.p25}/$${projection.p75}/$${projection.p90}`);
    console.log(`    Bust rate: ${projection.bustRate}%`);
    console.log(`    Avg max DD: ${projection.avgMaxDD}%`);
    
    return projection;
}

// ============== PHASE 8: BUILD STRATEGY SET JSON ==============
function buildStrategySetJSON(selected, data, startBal) {
    const strategies = selected.map((s, i) => ({
        id: i + 1,
        name: `H${String(s.utcHour).padStart(2,'0')} m${String(s.entryMinute).padStart(2,'0')} ${s.direction} (${(s.priceMin*100).toFixed(0)}-${(s.priceMax*100).toFixed(0)}c)`,
        asset: 'ALL',
        utcHour: s.utcHour,
        entryMinute: s.entryMinute,
        direction: s.direction,
        priceMin: s.priceMin,
        priceMax: s.priceMax,
        tier: s.tier,
        signature: s.signature,
        trainWins: s.trainWins, trainTrades: s.trainTrades, trainWinRate: parseFloat(s.trainWinRate.toFixed(6)), trainLCB: parseFloat(s.trainLCB.toFixed(6)),
        testWins: s.testWins, testTrades: s.testTrades, testWinRate: parseFloat(s.testWinRate.toFixed(6)), testLCB: parseFloat(s.testLCB.toFixed(6)),
        historicalWins: s.allWins, historicalTrades: s.allTrades,
        winRate: parseFloat(s.allWinRate.toFixed(6)),
        winRateLCB: parseFloat(s.allLCB.toFixed(6)),
        avgROI: parseFloat(s.allAvgROI.toFixed(6)),
        totalROI: parseFloat(s.allTotalROI.toFixed(6)),
        tradesPerDay: parseFloat(s.tradesPerDay.toFixed(4)),
        profitScore: parseFloat(s.profitScore.toFixed(6))
    }));
    
    const totalTrades = strategies.reduce((a, s) => a + s.historicalTrades, 0);
    const totalWins = strategies.reduce((a, s) => a + s.historicalWins, 0);
    
    return {
        version: '2.0',
        timeframe: TF_KEY,
        generatedAt: new Date().toISOString(),
        description: `Walk-forward validated ${TF.label} strategies. Optimized for max profit in quickest time with low bust risk. Train ${(TRAIN_RATIO*100).toFixed(0)}% / Test ${((1-TRAIN_RATIO)*100).toFixed(0)}% chronological split.`,
        conditions: {
            priceMin: Math.min(...strategies.map(s => s.priceMin)),
            priceMax: Math.max(...strategies.map(s => s.priceMax)),
            applyMomentumGate: false,
            applyVolumeGate: false,
            description: `${TF.label} strategies use intracycle CLOB price bands. No momentum/volume gates.`
        },
        stats: {
            totalStrategies: strategies.length,
            source: `${TF_KEY}_walkforward_maxprofit`,
            aggregateWR: parseFloat((totalWins / totalTrades).toFixed(6)),
            aggregateLCB: parseFloat(wilsonLCB(totalWins, totalTrades).toFixed(6)),
            aggregateTrades: totalTrades,
            totalTradesPerDay: parseFloat(strategies.reduce((a, s) => a + s.tradesPerDay, 0).toFixed(4))
        },
        strategies
    };
}

// ============== MAIN ==============
async function main() {
    console.log(`\n${'='.repeat(70)}`);
    console.log(`WALK-FORWARD VALIDATION + PROFIT SIMULATION: ${TF.label} (${TF_KEY})`);
    console.log(`Start balance: $${START_BAL} | Max strategies: ${MAX_STRATEGIES}`);
    console.log(`${'='.repeat(70)}\n`);
    
    // Phase 1: Load data
    const { dataset, trainData, testData, trainMarkets, testMarkets, markets, assets, perAsset, spanDays } = loadAndSplitData();
    
    if (dataset.length === 0) {
        console.error('ERROR: No dataset rows found. Run multiframe_data_collector.js first.');
        process.exit(1);
    }
    
    // Phase 2: Search strategies on train set
    const candidates = searchStrategies(trainData, trainMarkets);
    
    if (candidates.length === 0) {
        console.error('ERROR: No strategy candidates found on train set.');
        process.exit(1);
    }
    
    // Phase 3: Validate on test set
    const validated = validateStrategies(candidates, testData);
    
    if (validated.length === 0) {
        console.error('ERROR: No strategies passed validation.');
        process.exit(1);
    }
    
    // Phase 4: Select optimal set
    const selected = selectOptimalSet(validated);
    
    if (selected.length === 0) {
        console.error('ERROR: No strategies selected.');
        process.exit(1);
    }
    
    // Phase 5: Build strategy set JSON
    const strategySetJSON = buildStrategySetJSON(selected, dataset, START_BAL);
    const stratSetPath = path.join(OUTPUT_DIR, `strategy_set_${TF_KEY}_maxprofit.json`);
    fs.writeFileSync(stratSetPath, JSON.stringify(strategySetJSON, null, 2));
    console.log(`\nStrategy set saved: ${stratSetPath}`);
    
    // Phase 6: Full replay simulation
    const { result: replayResult, trades: replayTrades, balanceHistory } = replaySimulation(selected, dataset, markets, START_BAL);
    
    // Phase 7: Stress test
    const stressResults = stressTest(selected, dataset, markets, START_BAL);
    
    // Phase 8: Monte Carlo projections
    // Compute average entry price from replay trades for MC
    const avgEntry = replayTrades.length > 0 ? replayTrades.reduce((a,t) => a + t.entryPrice, 0) / replayTrades.length : 0.65;
    
    const proj14d = monteCarloProjection(replayResult.winRate, avgEntry, replayResult.tradesPerDay, START_BAL, 14);
    const proj30d = monteCarloProjection(replayResult.winRate, avgEntry, replayResult.tradesPerDay, START_BAL, 30);
    const proj60d = monteCarloProjection(replayResult.winRate, avgEntry, replayResult.tradesPerDay, START_BAL, 60);
    
    // Also run with $7 start for current bankroll reality
    console.log(`\n--- Replay with $7 start (current bankroll reality) ---`);
    const { result: replay7 } = replaySimulation(selected, dataset, markets, 7);
    const proj30d_7 = monteCarloProjection(
        replay7.totalTrades > 0 ? replay7.winRate : replayResult.winRate,
        avgEntry,
        replay7.tradesPerDay > 0 ? replay7.tradesPerDay : replayResult.tradesPerDay,
        7, 30
    );
    
    // Save comprehensive summary
    const summary = {
        generatedAt: new Date().toISOString(),
        timeframe: TF_KEY,
        label: TF.label,
        dataset: {
            totalMarkets: markets.length,
            totalRows: dataset.length,
            spanDays: parseFloat(spanDays.toFixed(1)),
            assets,
            perAsset,
            trainMarkets: trainMarkets.length,
            testMarkets: testMarkets.length,
            trainRatio: TRAIN_RATIO
        },
        strategySet: {
            path: `debug/strategy_set_${TF_KEY}_maxprofit.json`,
            strategies: selected.length,
            aggregateWR: strategySetJSON.stats.aggregateWR,
            aggregateLCB: strategySetJSON.stats.aggregateLCB,
            totalTrades: strategySetJSON.stats.aggregateTrades,
            totalTradesPerDay: strategySetJSON.stats.totalTradesPerDay
        },
        replay: {
            '$20_start': replayResult,
            '$7_start': replay7
        },
        stressTest: stressResults,
        projection: {
            '$20_14d': proj14d,
            '$20_30d': proj30d,
            '$20_60d': proj60d,
            '$7_30d': proj30d_7
        },
        verdict: {
            executeReady: replayResult.winRate >= 75 && replayResult.endBalance > START_BAL && replayResult.maxDrawdown < 80,
            bestFeature: replayResult.endBalance > START_BAL * 2 ? 'STRONG_PROFIT' : replayResult.endBalance > START_BAL ? 'POSITIVE' : 'UNDERPERFORMING',
            bustRisk30d: proj30d.bustRate < 20 ? 'LOW' : proj30d.bustRate < 40 ? 'MEDIUM' : 'HIGH',
            summary: `${TF.label}: ${selected.length} strategies, ${replayResult.winRate}% WR, $${START_BAL}→$${replayResult.endBalance} (${replayResult.profitMultiple}x), ${replayResult.maxDrawdown}% maxDD, ${replayResult.tradesPerDay} trades/day`
        }
    };
    
    const summaryPath = path.join(OUTPUT_DIR, `${TF_KEY}_maxprofit_full_analysis.json`);
    fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2));
    console.log(`\nFull analysis saved: ${summaryPath}`);
    
    // Console final summary
    console.log(`\n${'='.repeat(70)}`);
    console.log(`FINAL RESULTS: ${TF.label}`);
    console.log(`${'='.repeat(70)}`);
    console.log(`Strategies: ${selected.length} | Assets: ${assets.join(', ')}`);
    console.log(`Data: ${markets.length} markets over ${spanDays.toFixed(1)} days`);
    console.log(`Aggregate WR: ${(strategySetJSON.stats.aggregateWR * 100).toFixed(1)}% | LCB: ${(strategySetJSON.stats.aggregateLCB * 100).toFixed(1)}%`);
    console.log(`\nReplay ($${START_BAL} start): $${replayResult.endBalance} (${replayResult.profitMultiple}x, ${replayResult.winRate}% WR, ${replayResult.maxDrawdown}% maxDD)`);
    console.log(`Replay ($7 start): $${replay7.endBalance} (${replay7.profitMultiple}x)`);
    console.log(`\n30-day projection ($${START_BAL}): median $${proj30d.median} (${proj30d.medianMultiple}x), bust ${proj30d.bustRate}%`);
    console.log(`30-day projection ($7): median $${proj30d_7.median}, bust ${proj30d_7.bustRate}%`);
    console.log(`\nVerdict: ${summary.verdict.summary}`);
    console.log(`Execute ready: ${summary.verdict.executeReady ? 'YES' : 'NO'}`);
    console.log(`Bust risk (30d): ${summary.verdict.bustRisk30d}`);
    console.log(`\nDone.`);
}

main().catch(e => { console.error('Fatal error:', e); process.exit(1); });
