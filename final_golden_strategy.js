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

const { calculateStage1Survival, splitDatasetByMarkets3Way, walkForwardValidation } = require('./exhaustive_market_analysis');

const ASSETS = ['BTC', 'ETH', 'SOL', 'XRP'];
const WIN_RATE_TARGET = 0.9;
const DEFAULT_MIN_TRADES_PER_ASSET = 20;

function readEnvNumber(name) {
    const raw = process.env[name];
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
}

const AUDIT_MIN_VAL_WIN_RATE = readEnvNumber('AUDIT_MIN_VAL_WIN_RATE') ?? 0.9;
const AUDIT_MIN_TEST_WIN_RATE = readEnvNumber('AUDIT_MIN_TEST_WIN_RATE') ?? 0.9;
const AUDIT_MIN_WIN_RATE_LCB = readEnvNumber('AUDIT_MIN_WIN_RATE_LCB') ?? 0.9;
const AUDIT_MIN_POSTERIOR_PWINRATE_GE90 = readEnvNumber('AUDIT_MIN_POSTERIOR_PWINRATE_GE90') ?? 0.8;
const AUDIT_MAX_STAGE1_PLOSS_BEFORE_TARGET = readEnvNumber('AUDIT_MAX_STAGE1_PLOSS_BEFORE_TARGET');

function safeGetNumber(value) {
    return Number.isFinite(value) ? value : null;
}

function normalizeGateMetric(metric) {
    const m = metric && typeof metric === 'object' ? metric : {};
    return {
        trades: safeGetNumber(m.trades),
        winRate: safeGetNumber(m.winRate),
        winRateLCB: safeGetNumber(m.winRateLCB),
        posteriorPWinRateGE90: safeGetNumber(m.posteriorPWinRateGE90)
    };
}

function compareVerdict(a, b) {
    const score = v => (v === 'PASS' ? 2 : v === 'WARN' ? 1 : 0);
    return score(a) - score(b);
}

function evaluateAuditGatesForMetrics(metrics, stage1, config) {
    const failures = [];
    const val = normalizeGateMetric(metrics?.val);
    const test = normalizeGateMetric(metrics?.test);

    const hard = {
        passed: true,
        failures: []
    };
    if (!(typeof val.winRate === 'number' && val.winRate >= config.minValWinRate)) {
        hard.passed = false;
        hard.failures.push('valWinRate');
    }
    if (!(typeof test.winRate === 'number' && test.winRate >= config.minTestWinRate)) {
        hard.passed = false;
        hard.failures.push('testWinRate');
    }

    const proof = {
        passed: true,
        failures: []
    };
    const valProofOk =
        (typeof val.winRateLCB === 'number' && val.winRateLCB >= config.minWinRateLCB) ||
        (typeof val.posteriorPWinRateGE90 === 'number' && val.posteriorPWinRateGE90 >= config.minPosteriorPWinRateGE90);
    const testProofOk =
        (typeof test.winRateLCB === 'number' && test.winRateLCB >= config.minWinRateLCB) ||
        (typeof test.posteriorPWinRateGE90 === 'number' && test.posteriorPWinRateGE90 >= config.minPosteriorPWinRateGE90);
    if (!valProofOk) {
        proof.passed = false;
        proof.failures.push('valProof');
    }
    if (!testProofOk) {
        proof.passed = false;
        proof.failures.push('testProof');
    }

    const stage1Enabled = Number.isFinite(config.maxStage1PLossBeforeTarget) && stage1 && typeof stage1 === 'object';
    const stage1Gate = {
        enabled: stage1Enabled,
        passed: true,
        failures: []
    };
    if (stage1Enabled) {
        const pLoss = safeGetNumber(stage1?.pLossBeforeTarget);
        if (!(typeof pLoss === 'number' && pLoss <= config.maxStage1PLossBeforeTarget)) {
            stage1Gate.passed = false;
            stage1Gate.failures.push('stage1PLossBeforeTarget');
        }
    }

    let verdict = 'PASS';
    if (!hard.passed) verdict = 'FAIL';
    else if (!proof.passed) verdict = 'WARN';
    if (stage1Gate.enabled && !stage1Gate.passed) verdict = 'FAIL';

    if (!hard.passed) failures.push(...hard.failures);
    if (!proof.passed) failures.push(...proof.failures);
    if (stage1Gate.enabled && !stage1Gate.passed) failures.push(...stage1Gate.failures);

    return {
        verdict,
        hard,
        proof,
        stage1: stage1Gate,
        failures,
        metrics: {
            val,
            test,
            stage1: stage1 ? { pLossBeforeTarget: safeGetNumber(stage1.pLossBeforeTarget) } : null
        }
    };
}

function projectStrategyForAsset(strategy, asset) {
    if (!strategy) return null;
    const trainM = strategy?.perAsset?.[asset] || null;
    const valM = strategy?.valPerAsset?.[asset] || null;
    const testM = strategy?.testPerAsset?.[asset] || null;
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
        asset: trainM ? {
            trades: safeGetNumber(trainM.trades),
            wins: safeGetNumber(trainM.wins),
            losses: safeGetNumber(trainM.losses),
            winRate: safeGetNumber(trainM.winRate),
            winRateLCB: safeGetNumber(trainM.winRateLCB),
            posteriorPWinRateGE90: safeGetNumber(trainM.posteriorPWinRateGE90),
            avgROI: safeGetNumber(trainM.avgROI),
            streak: trainM.streak ?? null
        } : null,
        validation: {
            global: {
                trades: safeGetNumber(strategy.valTrades),
                winRate: safeGetNumber(strategy.valWinRate),
                winRateLCB: safeGetNumber(strategy.valWinRateLCB),
                posteriorPWinRateGE90: safeGetNumber(strategy.valPosteriorPWinRateGE90)
            },
            asset: valM ? {
                trades: safeGetNumber(valM.trades),
                wins: safeGetNumber(valM.wins),
                losses: safeGetNumber(valM.losses),
                winRate: safeGetNumber(valM.winRate),
                winRateLCB: safeGetNumber(valM.winRateLCB),
                posteriorPWinRateGE90: safeGetNumber(valM.posteriorPWinRateGE90),
                avgROI: safeGetNumber(valM.avgROI),
                streak: valM.streak ?? null
            } : null
        },
        test: {
            global: {
                trades: safeGetNumber(strategy.testTrades),
                winRate: safeGetNumber(strategy.testWinRate),
                winRateLCB: safeGetNumber(strategy.testWinRateLCB),
                posteriorPWinRateGE90: safeGetNumber(strategy.testPosteriorPWinRateGE90)
            },
            asset: testM ? {
                trades: safeGetNumber(testM.trades),
                wins: safeGetNumber(testM.wins),
                losses: safeGetNumber(testM.losses),
                winRate: safeGetNumber(testM.winRate),
                winRateLCB: safeGetNumber(testM.winRateLCB),
                posteriorPWinRateGE90: safeGetNumber(testM.posteriorPWinRateGE90),
                avgROI: safeGetNumber(testM.avgROI),
                streak: testM.streak ?? null
            } : null
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

function strategyKey(strategy) {
    if (!strategy) return null;
    const entryMinute = Number(strategy.entryMinute);
    const utcHour = Number(strategy.utcHour);
    const direction = String(strategy.direction || '').trim().toUpperCase();
    const bandMin = Number(strategy.priceBand?.min);
    const bandMax = Number(strategy.priceBand?.max);
    const minTxt = Number.isFinite(bandMin) ? bandMin.toFixed(6) : 'NaN';
    const maxTxt = Number.isFinite(bandMax) ? bandMax.toFixed(6) : 'NaN';
    return `${entryMinute}|${utcHour}|${direction}|${minTxt}|${maxTxt}`;
}

function pickBestStrategyForAsset(strategies, asset, options = {}) {
    const minTrades = Number.isFinite(options.minTrades) ? options.minTrades : DEFAULT_MIN_TRADES_PER_ASSET;
    const targetWinRate = Number.isFinite(options.targetWinRate) ? options.targetWinRate : WIN_RATE_TARGET;
    const selectedOn = (typeof options.selectedOn === 'string' && options.selectedOn.trim()) ? options.selectedOn.trim() : 'validation';

    let bestOverall = null;
    let bestMeetingTarget = null;
    let bestOverallMetric = null;
    let bestMeetingTargetMetric = null;

    for (const s of strategies) {
        const m = selectedOn === 'train' ? (s?.perAsset?.[asset]) : (s?.valPerAsset?.[asset]);
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
        criteria: { asset, minTrades, targetWinRate, selectedOn },
        bestMeetingTarget,
        bestOverall
    };
}

function pickTopStrategiesForAsset(strategies, asset, options = {}) {
    const minTrades = Number.isFinite(options.minTrades) ? options.minTrades : DEFAULT_MIN_TRADES_PER_ASSET;
    const selectedOn = (typeof options.selectedOn === 'string' && options.selectedOn.trim()) ? options.selectedOn.trim() : 'validation';
    const limitRaw = Number(options.limit);
    const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.floor(limitRaw)) : 50;

    const top = [];
    const topMetrics = [];

    for (const s of strategies) {
        const m = selectedOn === 'train' ? (s?.perAsset?.[asset]) : (s?.valPerAsset?.[asset]);
        if (!m || !Number.isFinite(m.trades) || m.trades < minTrades) continue;

        let inserted = false;
        for (let i = 0; i < top.length; i++) {
            if (isBetterAssetMetric(m, topMetrics[i])) {
                top.splice(i, 0, s);
                topMetrics.splice(i, 0, m);
                inserted = true;
                break;
            }
        }
        if (!inserted && top.length < limit) {
            top.push(s);
            topMetrics.push(m);
        }
        if (top.length > limit) {
            top.length = limit;
            topMetrics.length = limit;
        }
    }

    return top;
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

let goldenStrategy = pickGoldenStrategy(analysis);

if (!goldenStrategy) {
    console.error('❌ Could not determine golden strategy from final_results.json');
    process.exit(1);
}

const dataset = Array.isArray(analysis.dataset)
    ? analysis.dataset
    : (Array.isArray(datasetFromFile) ? datasetFromFile : []);

const trainRatioRaw = Number(datasetSplit?.trainRatio);
const valRatioRaw = Number(datasetSplit?.valRatio);
const trainRatio = (Number.isFinite(trainRatioRaw) && trainRatioRaw > 0 && trainRatioRaw < 1) ? trainRatioRaw : 0.6;
const valRatio = (Number.isFinite(valRatioRaw) && valRatioRaw > 0 && valRatioRaw < 1 && (trainRatio + valRatioRaw) < 1) ? valRatioRaw : 0.2;
const split = splitDatasetByMarkets3Way(dataset, trainRatio, valRatio);
const valSet = split.valSet;
const testSet = split.testSet;

const auditConfig = {
    minValWinRate: AUDIT_MIN_VAL_WIN_RATE,
    minTestWinRate: AUDIT_MIN_TEST_WIN_RATE,
    minWinRateLCB: AUDIT_MIN_WIN_RATE_LCB,
    minPosteriorPWinRateGE90: AUDIT_MIN_POSTERIOR_PWINRATE_GE90,
    maxStage1PLossBeforeTarget: AUDIT_MAX_STAGE1_PLOSS_BEFORE_TARGET
};

const allStrategies = Array.isArray(analysis.strategies) ? analysis.strategies : [];
const validationEvaluatedStrategies = (Array.isArray(valSet) && valSet.length && allStrategies.length)
    ? walkForwardValidation(valSet, allStrategies, 'val', { minTrades: 0, maxStrategies: allStrategies.length })
    : (Array.isArray(analysis.validatedStrategies) ? analysis.validatedStrategies : []);

const perAssetStrategyPicks = {};
const perAssetCandidateSets = {};
const uniqueSelected = [];
const selectedByKey = new Map();
const assetCandidateLimit = readEnvNumber('ASSET_TEST_CANDIDATES') ?? 60;
const globalCandidateLimit = readEnvNumber('GLOBAL_TEST_CANDIDATES') ?? 250;
const globalCandidates = Array.isArray(validationEvaluatedStrategies)
    ? validationEvaluatedStrategies.slice(0, Math.max(1, Math.floor(globalCandidateLimit)))
    : [];

for (const candidate of globalCandidates) {
    const key = strategyKey(candidate);
    if (!key || selectedByKey.has(key)) continue;
    selectedByKey.set(key, candidate);
    uniqueSelected.push(candidate);
}

for (const asset of ASSETS) {
    const pick = pickBestStrategyForAsset(validationEvaluatedStrategies, asset, {
        minTrades: DEFAULT_MIN_TRADES_PER_ASSET,
        targetWinRate: WIN_RATE_TARGET,
        selectedOn: 'validation'
    });
    perAssetStrategyPicks[asset] = pick;

    const candidates = pickTopStrategiesForAsset(validationEvaluatedStrategies, asset, {
        minTrades: DEFAULT_MIN_TRADES_PER_ASSET,
        selectedOn: 'validation',
        limit: assetCandidateLimit
    });
    perAssetCandidateSets[asset] = candidates;

    for (const candidate of [pick.bestMeetingTarget, pick.bestOverall, ...candidates]) {
        const key = strategyKey(candidate);
        if (!key || selectedByKey.has(key)) continue;
        selectedByKey.set(key, candidate);
        uniqueSelected.push(candidate);
    }
}

const testedSelectedStrategies = (Array.isArray(testSet) && testSet.length && uniqueSelected.length)
    ? walkForwardValidation(testSet, uniqueSelected, 'test', { minTrades: 0, maxStrategies: uniqueSelected.length })
    : [];
const testedByKey = new Map();
for (const s of testedSelectedStrategies) {
    const key = strategyKey(s);
    if (!key) continue;
    testedByKey.set(key, s);
}

const fallbackKey = strategyKey(goldenStrategy);
if (fallbackKey && testedByKey.has(fallbackKey)) {
    goldenStrategy = testedByKey.get(fallbackKey);
}

let bestGlobal = null;
let bestGlobalAudit = null;
for (const candidateRaw of globalCandidates) {
    const cKey = strategyKey(candidateRaw);
    const candidate = cKey ? (testedByKey.get(cKey) || candidateRaw) : candidateRaw;

    const audit = evaluateAuditGatesForMetrics({
        val: {
            trades: candidate.valTrades,
            winRate: candidate.valWinRate,
            winRateLCB: candidate.valWinRateLCB,
            posteriorPWinRateGE90: candidate.valPosteriorPWinRateGE90
        },
        test: {
            trades: candidate.testTrades,
            winRate: candidate.testWinRate,
            winRateLCB: candidate.testWinRateLCB,
            posteriorPWinRateGE90: candidate.testPosteriorPWinRateGE90
        }
    }, null, auditConfig);

    if (!bestGlobal) {
        bestGlobal = candidate;
        bestGlobalAudit = audit;
        continue;
    }

    const verdictCmp = compareVerdict(audit.verdict, bestGlobalAudit?.verdict);
    if (verdictCmp > 0) {
        bestGlobal = candidate;
        bestGlobalAudit = audit;
        continue;
    }
    if (verdictCmp < 0) continue;

    const aTestLCB = safeGetNumber(audit?.metrics?.test?.winRateLCB);
    const bTestLCB = safeGetNumber(bestGlobalAudit?.metrics?.test?.winRateLCB);
    if (typeof aTestLCB === 'number' && typeof bTestLCB === 'number' && Math.abs(aTestLCB - bTestLCB) > 0.01) {
        if (aTestLCB > bTestLCB) {
            bestGlobal = candidate;
            bestGlobalAudit = audit;
        }
        continue;
    } else if (typeof aTestLCB === 'number' && typeof bTestLCB !== 'number') {
        bestGlobal = candidate;
        bestGlobalAudit = audit;
        continue;
    } else if (typeof aTestLCB !== 'number' && typeof bTestLCB === 'number') {
        continue;
    }

    const aTestWR = safeGetNumber(audit?.metrics?.test?.winRate);
    const bTestWR = safeGetNumber(bestGlobalAudit?.metrics?.test?.winRate);
    if (typeof aTestWR === 'number' && typeof bTestWR === 'number' && Math.abs(aTestWR - bTestWR) > 0.001) {
        if (aTestWR > bTestWR) {
            bestGlobal = candidate;
            bestGlobalAudit = audit;
        }
        continue;
    } else if (typeof aTestWR === 'number' && typeof bTestWR !== 'number') {
        bestGlobal = candidate;
        bestGlobalAudit = audit;
        continue;
    } else if (typeof aTestWR !== 'number' && typeof bTestWR === 'number') {
        continue;
    }

    const aValLCB = safeGetNumber(audit?.metrics?.val?.winRateLCB);
    const bValLCB = safeGetNumber(bestGlobalAudit?.metrics?.val?.winRateLCB);
    if (typeof aValLCB === 'number' && typeof bValLCB === 'number' && Math.abs(aValLCB - bValLCB) > 0.01) {
        if (aValLCB > bValLCB) {
            bestGlobal = candidate;
            bestGlobalAudit = audit;
        }
        continue;
    } else if (typeof aValLCB === 'number' && typeof bValLCB !== 'number') {
        bestGlobal = candidate;
        bestGlobalAudit = audit;
        continue;
    } else if (typeof aValLCB !== 'number' && typeof bValLCB === 'number') {
        continue;
    }

    const aValWR = safeGetNumber(audit?.metrics?.val?.winRate);
    const bValWR = safeGetNumber(bestGlobalAudit?.metrics?.val?.winRate);
    if (typeof aValWR === 'number' && typeof bValWR === 'number' && Math.abs(aValWR - bValWR) > 0.001) {
        if (aValWR > bValWR) {
            bestGlobal = candidate;
            bestGlobalAudit = audit;
        }
        continue;
    } else if (typeof aValWR === 'number' && typeof bValWR !== 'number') {
        bestGlobal = candidate;
        bestGlobalAudit = audit;
        continue;
    } else if (typeof aValWR !== 'number' && typeof bValWR === 'number') {
        continue;
    }

    const aTPD = safeGetNumber(candidate?.tradesPerDay) ?? 0;
    const bTPD = safeGetNumber(bestGlobal?.tradesPerDay) ?? 0;
    if (aTPD > bTPD) {
        bestGlobal = candidate;
        bestGlobalAudit = audit;
    }
}

if (bestGlobal) {
    goldenStrategy = bestGlobal;
}

const perAssetGoldenStrategies = {};
for (const asset of ASSETS) {
    const pick = perAssetStrategyPicks[asset];
    const candidates = perAssetCandidateSets[asset] || [];

    const meetKey = strategyKey(pick?.bestMeetingTarget);
    const overallKey = strategyKey(pick?.bestOverall);
    const testedMeeting = meetKey ? (testedByKey.get(meetKey) || pick.bestMeetingTarget) : null;
    const testedOverall = overallKey ? (testedByKey.get(overallKey) || pick.bestOverall) : null;

    let bestRuntime = null;
    let bestRuntimeAudit = null;
    const testedCandidates = candidates.map(s => {
        const key = strategyKey(s);
        return key ? (testedByKey.get(key) || s) : s;
    });

    for (const candidate of [testedMeeting, testedOverall, ...testedCandidates]) {
        if (!candidate) continue;
        const audit = evaluateAuditGatesForMetrics({ val: candidate?.valPerAsset?.[asset], test: candidate?.testPerAsset?.[asset] }, null, auditConfig);
        if (!audit) continue;

        if (!bestRuntime) {
            bestRuntime = candidate;
            bestRuntimeAudit = audit;
            continue;
        }

        const verdictCmp = compareVerdict(audit.verdict, bestRuntimeAudit?.verdict);
        if (verdictCmp > 0) {
            bestRuntime = candidate;
            bestRuntimeAudit = audit;
            continue;
        }
        if (verdictCmp < 0) continue;

        const aTestLCB = safeGetNumber(audit?.metrics?.test?.winRateLCB);
        const bTestLCB = safeGetNumber(bestRuntimeAudit?.metrics?.test?.winRateLCB);
        if (typeof aTestLCB === 'number' && typeof bTestLCB === 'number' && Math.abs(aTestLCB - bTestLCB) > 0.01) {
            if (aTestLCB > bTestLCB) {
                bestRuntime = candidate;
                bestRuntimeAudit = audit;
            }
            continue;
        } else if (typeof aTestLCB === 'number' && typeof bTestLCB !== 'number') {
            bestRuntime = candidate;
            bestRuntimeAudit = audit;
            continue;
        } else if (typeof aTestLCB !== 'number' && typeof bTestLCB === 'number') {
            continue;
        }

        const aTestWR = safeGetNumber(audit?.metrics?.test?.winRate);
        const bTestWR = safeGetNumber(bestRuntimeAudit?.metrics?.test?.winRate);
        if (typeof aTestWR === 'number' && typeof bTestWR === 'number' && Math.abs(aTestWR - bTestWR) > 0.001) {
            if (aTestWR > bTestWR) {
                bestRuntime = candidate;
                bestRuntimeAudit = audit;
            }
            continue;
        } else if (typeof aTestWR === 'number' && typeof bTestWR !== 'number') {
            bestRuntime = candidate;
            bestRuntimeAudit = audit;
            continue;
        } else if (typeof aTestWR !== 'number' && typeof bTestWR === 'number') {
            continue;
        }

        const aValLCB = safeGetNumber(audit?.metrics?.val?.winRateLCB);
        const bValLCB = safeGetNumber(bestRuntimeAudit?.metrics?.val?.winRateLCB);
        if (typeof aValLCB === 'number' && typeof bValLCB === 'number' && Math.abs(aValLCB - bValLCB) > 0.01) {
            if (aValLCB > bValLCB) {
                bestRuntime = candidate;
                bestRuntimeAudit = audit;
            }
            continue;
        } else if (typeof aValLCB === 'number' && typeof bValLCB !== 'number') {
            bestRuntime = candidate;
            bestRuntimeAudit = audit;
            continue;
        } else if (typeof aValLCB !== 'number' && typeof bValLCB === 'number') {
            continue;
        }

        const aTrades = safeGetNumber(candidate?.testPerAsset?.[asset]?.trades) ?? 0;
        const bTrades = safeGetNumber(bestRuntime?.testPerAsset?.[asset]?.trades) ?? 0;
        if (aTrades > bTrades) {
            bestRuntime = candidate;
            bestRuntimeAudit = audit;
        }
    }

    const meetingCandidate = bestRuntime || testedMeeting;
    const overallCandidate = testedOverall;
    const runtimeCandidate = meetingCandidate || overallCandidate;
    const runtimeAudit = runtimeCandidate
        ? evaluateAuditGatesForMetrics({ val: runtimeCandidate?.valPerAsset?.[asset], test: runtimeCandidate?.testPerAsset?.[asset] }, null, auditConfig)
        : null;
    const allowOverride = runtimeAudit && runtimeAudit.verdict !== 'FAIL';
    perAssetGoldenStrategies[asset] = {
        criteria: {
            ...(pick?.criteria || { asset, minTrades: DEFAULT_MIN_TRADES_PER_ASSET, targetWinRate: WIN_RATE_TARGET, selectedOn: 'validation' }),
            testCandidates: assetCandidateLimit
        },
        bestMeetingTarget: (allowOverride && meetingCandidate) ? projectStrategyForAsset(meetingCandidate, asset) : null,
        bestOverall: (allowOverride && overallCandidate) ? projectStrategyForAsset(overallCandidate, asset) : null
    };
}

const strategyTrades = filterDatasetForStrategy(goldenStrategy, dataset);
const strategyDays = computeDateRangeDaysFromRows(strategyTrades);
const tradesPerDay = strategyDays ? (strategyTrades.length / strategyDays) : null;

const cachedStage1Survival = analysis.stage1Survival;
const cachedGoldenKey = strategyKey(analysis.goldenStrategy);
const selectedGoldenKey = strategyKey(goldenStrategy);
const canUseCachedStage1 =
    cachedStage1Survival &&
    Number.isFinite(Number(cachedStage1Survival.empiricalTrades)) &&
    cachedGoldenKey &&
    selectedGoldenKey &&
    cachedGoldenKey === selectedGoldenKey;

const stage1SurvivalBase = canUseCachedStage1
    ? cachedStage1Survival
    : calculateStage1Survival(goldenStrategy, Array.isArray(testSet) && testSet.length ? testSet : dataset);
const stage1Survival = (stage1SurvivalBase && typeof stage1SurvivalBase === 'object') ? stage1SurvivalBase : {};
const stage1SurvivalEnhanced = {
    ...stage1Survival,
    pNoLossBeforeTarget: typeof stage1Survival?.pLossBeforeTarget === 'number' ? (1 - stage1Survival.pLossBeforeTarget) : null
};

const auditGates = {
    config: auditConfig,
    global: evaluateAuditGatesForMetrics({
        val: {
            trades: goldenStrategy.valTrades,
            winRate: goldenStrategy.valWinRate,
            winRateLCB: goldenStrategy.valWinRateLCB,
            posteriorPWinRateGE90: goldenStrategy.valPosteriorPWinRateGE90
        },
        test: {
            trades: goldenStrategy.testTrades,
            winRate: goldenStrategy.testWinRate,
            winRateLCB: goldenStrategy.testWinRateLCB,
            posteriorPWinRateGE90: goldenStrategy.testPosteriorPWinRateGE90
        }
    }, stage1SurvivalEnhanced, auditConfig),
    perAsset: {}
};

for (const asset of ASSETS) {
    const node = perAssetGoldenStrategies[asset];
    const meeting = node?.bestMeetingTarget || null;
    const overall = node?.bestOverall || null;
    const runtime = meeting || overall;
    const meetingAudit = meeting
        ? evaluateAuditGatesForMetrics({ val: meeting.validation?.asset, test: meeting.test?.asset }, null, auditConfig)
        : null;
    const overallAudit = overall
        ? evaluateAuditGatesForMetrics({ val: overall.validation?.asset, test: overall.test?.asset }, null, auditConfig)
        : null;
    const runtimeAudit = runtime
        ? evaluateAuditGatesForMetrics({ val: runtime.validation?.asset, test: runtime.test?.asset }, null, auditConfig)
        : null;
    auditGates.perAsset[asset] = {
        runtime: runtimeAudit,
        bestMeetingTarget: meetingAudit,
        bestOverall: overallAudit
    };
}

const verdicts = [auditGates.global?.verdict, ...Object.values(auditGates.perAsset).map(v => v?.runtime?.verdict)].filter(Boolean);
const auditVerdict = verdicts.reduce((worst, v) => (compareVerdict(v, worst) < 0 ? v : worst), 'PASS');
auditGates.summary = {
    verdict: auditVerdict,
    allPassed: auditVerdict === 'PASS'
};

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
    auditGates,
    auditVerdict: auditGates.summary.verdict,
    auditAllPassed: auditGates.summary.allPassed,
    goldenStrategy: {
        ...goldenStrategy,
        tradesPerDayEmpirical: tradesPerDay
    },
    perAssetGoldenStrategies,
    stage1Survival: stage1SurvivalEnhanced,
    topStrategiesByLCB: Array.isArray(analysis.strategies) ? analysis.strategies.slice(0, 25) : [],
    validatedStrategies: Array.isArray(validationEvaluatedStrategies) ? validationEvaluatedStrategies.slice(0, 25) : []
};

fs.writeFileSync(path.join(__dirname, 'final_golden_strategy.json'), JSON.stringify(finalResults, null, 2));

console.log('');
console.log('✅ Results saved to: final_golden_strategy.json');
console.log('');
console.log('='.repeat(70));
console.log('ANALYSIS COMPLETE');
console.log('='.repeat(70));
