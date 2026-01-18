/**
 * FINAL GOLDEN STRATEGY ANALYSIS
 * 
 * Analyzes the Polymarket-only exhaustive dataset to find the optimal "golden sweet spot"
 * strategy with highest certainty first, then frequency.
 * 
 * Calculates:
 * 1. Wilson LCB confidence bounds for each hour/direction
 * 2. Stage-1 survival probability ($1→$20 all-in)
 * 3. Optimal strategy ranking
 * 4. Final manual trading playbook
 */

const fs = require('fs');
const path = require('path');

const { calculateStage1Survival } = require('./exhaustive_market_analysis');

// Load the Polymarket analysis dataset
const analysisPath = path.join(__dirname, 'exhaustive_analysis', 'final_results.json');
if (!fs.existsSync(analysisPath)) {
    console.error('❌ Missing Polymarket analysis dataset: exhaustive_analysis/final_results.json');
    console.error('');
    console.error('This file is generated locally (and is gitignored). Generate it first by running:');
    console.error('  npm run analysis');
    console.error('');
    console.error('Then re-run:');
    console.error('  node final_golden_strategy.js');
    process.exit(1);
}

const analysis = JSON.parse(fs.readFileSync(analysisPath, 'utf8'));

console.log('='.repeat(70));
console.log('🔱 FINAL GOLDEN STRATEGY ANALYSIS');
console.log('='.repeat(70));
console.log(`Data source: exhaustive_analysis/final_results.json`);
console.log(`Total markets analyzed: ${analysis.combinedManifest?.length ?? 0}`);
console.log(`Dataset rows: ${analysis.dataset?.length ?? 0}`);
console.log('');

// Wilson score lower confidence bound
function wilsonLCB(wins, total, z = 1.96) {
    if (total === 0) return 0;
    const pHat = wins / total;
    const denominator = 1 + (z * z) / total;
    const center = pHat + (z * z) / (2 * total);
    const margin = z * Math.sqrt((pHat * (1 - pHat) + (z * z) / (4 * total)) / total);
    return Math.max(0, (center - margin) / denominator);
}

// Wilson score upper confidence bound
function wilsonUCB(wins, total, z = 1.96) {
    if (total === 0) return 0;
    const pHat = wins / total;
    const denominator = 1 + (z * z) / total;
    const center = pHat + (z * z) / (2 * total);
    const margin = z * Math.sqrt((pHat * (1 - pHat) + (z * z) / (4 * total)) / total);
    return Math.min(1, (center + margin) / denominator);
}

function pickGoldenStrategy(results) {
    if (results.goldenStrategy) return results.goldenStrategy;
    if (Array.isArray(results.validatedStrategies) && results.validatedStrategies.length > 0) return results.validatedStrategies[0];
    if (Array.isArray(results.strategies) && results.strategies.length > 0) return results.strategies[0];
    return null;
}

function filterDatasetForStrategy(strategy, dataset) {
    if (!strategy || !Array.isArray(dataset)) return [];
    return dataset.filter(row => {
        if (row.entryMinute !== strategy.entryMinute) return false;
        if (row.utcHour !== strategy.utcHour) return false;
        const band = strategy.priceBand;
        if (!band || typeof band.min !== 'number' || typeof band.max !== 'number') return false;

        if (strategy.direction === 'UP') {
            return row.upPrice >= band.min && row.upPrice <= band.max;
        }
        if (strategy.direction === 'DOWN') {
            return row.downPrice >= band.min && row.downPrice <= band.max;
        }

        const bestPrice = Math.min(row.upPrice, row.downPrice);
        return bestPrice >= band.min && bestPrice <= band.max;
    });
}

function computeDateRangeDaysFromRows(rows) {
    if (!Array.isArray(rows) || rows.length === 0) return null;
    let minEpoch = Infinity;
    let maxEpoch = -Infinity;
    for (const r of rows) {
        if (!r || typeof r.cycleStartEpochSec !== 'number') continue;
        if (r.cycleStartEpochSec < minEpoch) minEpoch = r.cycleStartEpochSec;
        if (r.cycleStartEpochSec > maxEpoch) maxEpoch = r.cycleStartEpochSec;
    }
    if (!Number.isFinite(minEpoch) || !Number.isFinite(maxEpoch)) return null;
    const days = (maxEpoch - minEpoch) / 86400;
    return Math.max(1, days);
}

const goldenStrategy = pickGoldenStrategy(analysis);

if (!goldenStrategy) {
    console.error('❌ Could not determine golden strategy from final_results.json');
    process.exit(1);
}

const dataset = Array.isArray(analysis.dataset) ? analysis.dataset : [];
const strategyTrades = filterDatasetForStrategy(goldenStrategy, dataset);
const strategyDays = computeDateRangeDaysFromRows(strategyTrades);
const tradesPerDay = strategyDays ? (strategyTrades.length / strategyDays) : null;

const stage1Survival = analysis.stage1Survival || calculateStage1Survival(goldenStrategy, dataset);
const stage1SurvivalEnhanced = {
    ...stage1Survival,
    pNoLossBeforeTarget: typeof stage1Survival?.pLossBeforeTarget === 'number' ? (1 - stage1Survival.pLossBeforeTarget) : null
};

console.log('');
console.log('='.repeat(70));
console.log('🌟 GOLDEN STRATEGY (Polymarket-only)');
console.log('='.repeat(70));
console.log(`Entry Minute: ${goldenStrategy.entryMinute}`);
console.log(`UTC Hour: ${goldenStrategy.utcHour}`);
console.log(`Direction: ${goldenStrategy.direction}`);
console.log(`Price Band: ${goldenStrategy.priceBand?.min} - ${goldenStrategy.priceBand?.max}`);
console.log(`Trades: ${goldenStrategy.trades}`);
console.log(`Win Rate: ${(goldenStrategy.winRate * 100).toFixed(1)}%`);
console.log(`Win Rate LCB: ${(goldenStrategy.winRateLCB * 100).toFixed(1)}%`);
if (typeof tradesPerDay === 'number') {
    console.log(`Trades/Day (empirical): ${tradesPerDay.toFixed(2)}`);
}

console.log('');
console.log('💰 STAGE-1 SURVIVAL ($1 → $20 all-in, empirical ROI + 2% fee on winnings)');
console.log(`  P(reach $20): ${(stage1SurvivalEnhanced.pReachTarget * 100).toFixed(1)}%`);
console.log(`  P(≥1 loss before $20): ${(stage1SurvivalEnhanced.pLossBeforeTarget * 100).toFixed(1)}%`);
if (typeof stage1SurvivalEnhanced.maxConsecLosses === 'number') {
    console.log(`  Max consecutive losses observed: ${stage1SurvivalEnhanced.maxConsecLosses}`);
}

const finalResults = {
    generatedAt: new Date().toISOString(),
    dataSource: 'exhaustive_analysis/final_results.json',
    analysisMeta: {
        startedAt: analysis.startedAt ?? null,
        completedAt: analysis.completedAt ?? null,
        runtimeMinutes: analysis.runtimeMinutes ?? null,
        totalMarkets: Array.isArray(analysis.combinedManifest) ? analysis.combinedManifest.length : null,
        datasetRows: Array.isArray(analysis.dataset) ? analysis.dataset.length : null
    },
    feeModel: {
        takerFeeRate: 0.02,
        appliedTo: 'winning_profit'
    },
    goldenStrategy: {
        ...goldenStrategy,
        tradesPerDayEmpirical: tradesPerDay
    },
    stage1Survival: stage1SurvivalEnhanced,
    topStrategiesByLCB: Array.isArray(analysis.strategies) ? analysis.strategies.slice(0, 25) : [],
    validatedStrategies: Array.isArray(analysis.validatedStrategies) ? analysis.validatedStrategies.slice(0, 25) : []
};

fs.writeFileSync(path.join(__dirname, 'final_golden_strategy.json'), JSON.stringify(finalResults, null, 2));

console.log('');
console.log('✅ Results saved to: final_golden_strategy.json');
console.log('');
console.log('='.repeat(70));
console.log('ANALYSIS COMPLETE');
console.log('='.repeat(70));
