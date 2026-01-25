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

const ASSETS = ['BTC', 'ETH', 'SOL', 'XRP'];
const WIN_RATE_TARGET = 0.9;
const DEFAULT_MIN_TRADES_PER_ASSET = 20;

function safeGetNumber(value) {
    return Number.isFinite(value) ? value : null;
}

function projectStrategyForAsset(strategy, asset) {
    if (!strategy || !strategy.perAsset || !strategy.perAsset[asset]) return null;
    const m = strategy.perAsset[asset];
    return {
        entryMinute: strategy.entryMinute,
        utcHour: strategy.utcHour,
        direction: strategy.direction,
        priceBand: strategy.priceBand,
        global: {
            trades: safeGetNumber(strategy.trades),
            winRate: safeGetNumber(strategy.winRate),
            winRateLCB: safeGetNumber(strategy.winRateLCB),
            posteriorPWinRateGE90: safeGetNumber(strategy.posteriorPWinRateGE90),
            tradesPerDay: safeGetNumber(strategy.tradesPerDay)
        },
        asset: {
            trades: safeGetNumber(m.trades),
            wins: safeGetNumber(m.wins),
            losses: safeGetNumber(m.losses),
            winRate: safeGetNumber(m.winRate),
            winRateLCB: safeGetNumber(m.winRateLCB),
            posteriorPWinRateGE90: safeGetNumber(m.posteriorPWinRateGE90),
            avgROI: safeGetNumber(m.avgROI),
            streak: m.streak ?? null
        }
    };
}

function isBetterAssetMetric(a, b) {
    if (!a) return false;
    if (!b) return true;

    const aLCB = safeGetNumber(a.winRateLCB);
    const bLCB = safeGetNumber(b.winRateLCB);
    if (typeof aLCB === 'number' && typeof bLCB === 'number') {
        if (Math.abs(aLCB - bLCB) > 0.01) return aLCB > bLCB;
    } else if (typeof aLCB === 'number') {
        return true;
    } else if (typeof bLCB === 'number') {
        return false;
    }

    const aTrades = safeGetNumber(a.trades) ?? 0;
    const bTrades = safeGetNumber(b.trades) ?? 0;
    if (aTrades !== bTrades) return aTrades > bTrades;

    const aWR = safeGetNumber(a.winRate);
    const bWR = safeGetNumber(b.winRate);
    if (typeof aWR === 'number' && typeof bWR === 'number') {
        if (Math.abs(aWR - bWR) > 0.001) return aWR > bWR;
    } else if (typeof aWR === 'number') {
        return true;
    } else if (typeof bWR === 'number') {
        return false;
    }

    const aPost = safeGetNumber(a.posteriorPWinRateGE90);
    const bPost = safeGetNumber(b.posteriorPWinRateGE90);
    if (typeof aPost === 'number' && typeof bPost === 'number') {
        if (Math.abs(aPost - bPost) > 1e-6) return aPost > bPost;
    } else if (typeof aPost === 'number') {
        return true;
    } else if (typeof bPost === 'number') {
        return false;
    }

    return false;
}

function pickBestStrategyForAsset(strategies, asset, options = {}) {
    const minTrades = Number.isFinite(options.minTrades) ? options.minTrades : DEFAULT_MIN_TRADES_PER_ASSET;
    const targetWinRate = Number.isFinite(options.targetWinRate) ? options.targetWinRate : WIN_RATE_TARGET;

    let bestOverall = null;
    let bestMeetingTarget = null;
    let bestOverallMetric = null;
    let bestMeetingTargetMetric = null;

    for (const s of strategies) {
        const m = s?.perAsset?.[asset];
        if (!m || !Number.isFinite(m.trades) || m.trades < minTrades) continue;

        if (isBetterAssetMetric(m, bestOverallMetric)) {
            bestOverall = s;
            bestOverallMetric = m;
        }

        if (Number.isFinite(m.winRate) && m.winRate >= targetWinRate) {
            if (isBetterAssetMetric(m, bestMeetingTargetMetric)) {
                bestMeetingTarget = s;
                bestMeetingTargetMetric = m;
            }
        }
    }

    return {
        criteria: { asset, minTrades, targetWinRate },
        bestMeetingTarget: bestMeetingTarget ? projectStrategyForAsset(bestMeetingTarget, asset) : null,
        bestOverall: bestOverall ? projectStrategyForAsset(bestOverall, asset) : null
    };
}

function tryReadJson(relPath) {
    try {
        const p = path.join(__dirname, relPath);
        if (!fs.existsSync(p)) return null;
        return JSON.parse(fs.readFileSync(p, 'utf8'));
    } catch {
        return null;
    }
}

const analysisPath = path.join(__dirname, 'exhaustive_analysis', 'final_results.json');
const analysisSourceLabel = fs.existsSync(analysisPath)
    ? 'exhaustive_analysis/final_results.json'
    : 'exhaustive_analysis/strategies_*.json';

const analysis = fs.existsSync(analysisPath)
    ? JSON.parse(fs.readFileSync(analysisPath, 'utf8'))
    : {
        startedAt: null,
        completedAt: null,
        runtimeMinutes: null,
        counts: {},
        files: {
            strategiesRanked: 'strategies_ranked.json',
            strategiesValidated: 'strategies_validated.json',
            decisionDataset: 'decision_dataset.json',
            manifestCombined: 'manifest_combined.json'
        },
        strategies: Array.isArray(tryReadJson(path.join('exhaustive_analysis', 'strategies_ranked.json')))
            ? tryReadJson(path.join('exhaustive_analysis', 'strategies_ranked.json'))
            : [],
        validatedStrategies: Array.isArray(tryReadJson(path.join('exhaustive_analysis', 'strategies_validated.json')))
            ? tryReadJson(path.join('exhaustive_analysis', 'strategies_validated.json'))
            : []
    };

console.log('='.repeat(70));
console.log('🔱 FINAL GOLDEN STRATEGY ANALYSIS');
console.log('='.repeat(70));
console.log(`Data source: ${analysisSourceLabel}`);
const embeddedManifestCount = Array.isArray(analysis.combinedManifest) ? analysis.combinedManifest.length : null;
const embeddedDatasetCount = Array.isArray(analysis.dataset) ? analysis.dataset.length : null;
const manifestFromFile = embeddedManifestCount === null ? tryReadJson(path.join('exhaustive_analysis', 'manifest_combined.json')) : null;
const datasetFromFile = embeddedDatasetCount === null ? tryReadJson(path.join('exhaustive_analysis', 'decision_dataset.json')) : null;
const totalMarkets = embeddedManifestCount ?? (Array.isArray(manifestFromFile) ? manifestFromFile.length : (analysis.counts?.totalMarkets ?? 0));
const datasetRows = embeddedDatasetCount ?? (Array.isArray(datasetFromFile) ? datasetFromFile.length : (analysis.counts?.datasetRows ?? 0));
const datasetSplit = analysis.datasetSplit ?? analysis.counts?.datasetSplit ?? null;
console.log(`Total markets analyzed: ${totalMarkets}`);
console.log(`Dataset rows: ${datasetRows}`);
if (datasetSplit && typeof datasetSplit === 'object') {
    const trainRatio = Number(datasetSplit.trainRatio);
    const valRatio = Number(datasetSplit.valRatio);
    const testRatio = Number(datasetSplit.testRatio);
    const trainRows = Number(datasetSplit?.rows?.train);
    const valRows = Number(datasetSplit?.rows?.val);
    const testRows = Number(datasetSplit?.rows?.test);
    if (Number.isFinite(trainRows) && Number.isFinite(valRows) && Number.isFinite(testRows)) {
        console.log(`Split rows: train=${trainRows} val=${valRows} test=${testRows}`);
    }
    if (Number.isFinite(trainRatio) && Number.isFinite(valRatio) && Number.isFinite(testRatio)) {
        console.log(`Split ratios: train=${trainRatio.toFixed(2)} val=${valRatio.toFixed(2)} test=${testRatio.toFixed(2)}`);
    }
}
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

const dataset = Array.isArray(analysis.dataset)
    ? analysis.dataset
    : (Array.isArray(datasetFromFile) ? datasetFromFile : []);
const strategyTrades = filterDatasetForStrategy(goldenStrategy, dataset);
const strategyDays = computeDateRangeDaysFromRows(strategyTrades);
const tradesPerDay = strategyDays ? (strategyTrades.length / strategyDays) : null;

const stage1Survival = analysis.stage1Survival || calculateStage1Survival(goldenStrategy, dataset);
const stage1SurvivalEnhanced = {
    ...stage1Survival,
    pNoLossBeforeTarget: typeof stage1Survival?.pLossBeforeTarget === 'number' ? (1 - stage1Survival.pLossBeforeTarget) : null
};

const perAssetGoldenStrategies = {};
const allStrategies = Array.isArray(analysis.strategies) ? analysis.strategies : [];
for (const asset of ASSETS) {
    perAssetGoldenStrategies[asset] = pickBestStrategyForAsset(allStrategies, asset, {
        minTrades: DEFAULT_MIN_TRADES_PER_ASSET,
        targetWinRate: WIN_RATE_TARGET
    });
}

console.log('');
console.log('='.repeat(70));
console.log('🌟 GOLDEN STRATEGY (Polymarket-only)');
console.log('='.repeat(70));
console.log(`Entry Minute: ${goldenStrategy.entryMinute}`);
console.log(`UTC Hour: ${goldenStrategy.utcHour}`);
console.log(`Direction: ${goldenStrategy.direction}`);
console.log(`Price Band: ${goldenStrategy.priceBand?.min} - ${goldenStrategy.priceBand?.max}`);
console.log(`Train Trades: ${goldenStrategy.trades}`);
console.log(`Train Win Rate: ${(goldenStrategy.winRate * 100).toFixed(1)}%`);
console.log(`Train Win Rate LCB: ${(goldenStrategy.winRateLCB * 100).toFixed(1)}%`);
if (Number.isFinite(goldenStrategy.valWinRate) && Number.isFinite(goldenStrategy.valTrades)) {
    console.log('');
    console.log('OOS (validation split):');
    console.log(`Val Trades: ${goldenStrategy.valTrades}`);
    console.log(`Val Win Rate: ${(goldenStrategy.valWinRate * 100).toFixed(1)}%`);
    if (Number.isFinite(goldenStrategy.valWinRateLCB)) {
        console.log(`Val Win Rate LCB: ${(goldenStrategy.valWinRateLCB * 100).toFixed(1)}%`);
    }
    if (Number.isFinite(goldenStrategy.valPosteriorPWinRateGE90)) {
        console.log(`Val P(WR≥90%): ${(goldenStrategy.valPosteriorPWinRateGE90 * 100).toFixed(1)}%`);
    }
    if (Number.isFinite(goldenStrategy.degradationTrainToVal)) {
        console.log(`Train→Val degradation: ${(goldenStrategy.degradationTrainToVal * 100).toFixed(1)}pp`);
    }
}
if (Number.isFinite(goldenStrategy.testWinRate) && Number.isFinite(goldenStrategy.testTrades)) {
    console.log('');
    console.log('OOS (test split):');
    console.log(`Test Trades: ${goldenStrategy.testTrades}`);
    console.log(`Test Win Rate: ${(goldenStrategy.testWinRate * 100).toFixed(1)}%`);
    if (Number.isFinite(goldenStrategy.testWinRateLCB)) {
        console.log(`Test Win Rate LCB: ${(goldenStrategy.testWinRateLCB * 100).toFixed(1)}%`);
    }
    if (Number.isFinite(goldenStrategy.testPosteriorPWinRateGE90)) {
        console.log(`Test P(WR≥90%): ${(goldenStrategy.testPosteriorPWinRateGE90 * 100).toFixed(1)}%`);
    }
    if (Number.isFinite(goldenStrategy.degradation)) {
        console.log(`Train→Test degradation: ${(goldenStrategy.degradation * 100).toFixed(1)}pp`);
    }
    if (Number.isFinite(goldenStrategy.degradationValToTest)) {
        console.log(`Val→Test degradation: ${(goldenStrategy.degradationValToTest * 100).toFixed(1)}pp`);
    }
}
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
    dataSource: analysisSourceLabel,
    analysisMeta: {
        startedAt: analysis.startedAt ?? null,
        completedAt: analysis.completedAt ?? null,
        runtimeMinutes: analysis.runtimeMinutes ?? null,
        totalMarkets,
        datasetRows,
        datasetSplit: datasetSplit ?? null
    },
    feeModel: {
        takerFeeRate: 0.02,
        appliedTo: 'winning_profit'
    },
    goldenStrategy: {
        ...goldenStrategy,
        tradesPerDayEmpirical: tradesPerDay
    },
    perAssetGoldenStrategies,
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
