const fs = require('fs');
const path = require('path');

const { splitDatasetByMarkets3Way, walkForwardValidation } = require('../exhaustive_market_analysis');

function readJson(absPath) {
    return JSON.parse(fs.readFileSync(absPath, 'utf8'));
}

function safeGetNumber(value) {
    return Number.isFinite(value) ? value : null;
}

const auditConfig = {
    minValWinRate: 0.90,
    minTestWinRate: 0.90,
    minWinRateLCB: 0.90,
    minPosteriorPWinRateGE90: 0.80
};

function proofOk(winRateLCB, posteriorPWinRateGE90) {
    return (
        (typeof winRateLCB === 'number' && winRateLCB >= auditConfig.minWinRateLCB) ||
        (typeof posteriorPWinRateGE90 === 'number' && posteriorPWinRateGE90 >= auditConfig.minPosteriorPWinRateGE90)
    );
}

function passesValStrict(strategy) {
    const wr = safeGetNumber(strategy?.valWinRate);
    if (typeof wr !== 'number' || wr < auditConfig.minValWinRate) return false;
    const lcb = safeGetNumber(strategy?.valWinRateLCB);
    const post = safeGetNumber(strategy?.valPosteriorPWinRateGE90);
    return proofOk(lcb, post);
}

function passesTestStrict(strategy) {
    const wr = safeGetNumber(strategy?.testWinRate);
    if (typeof wr !== 'number' || wr < auditConfig.minTestWinRate) return false;
    const lcb = safeGetNumber(strategy?.testWinRateLCB);
    const post = safeGetNumber(strategy?.testPosteriorPWinRateGE90);
    return proofOk(lcb, post);
}

function summarize(strategy) {
    return {
        entryMinute: strategy?.entryMinute ?? null,
        utcHour: strategy?.utcHour ?? null,
        direction: strategy?.direction ?? null,
        priceBand: strategy?.priceBand ?? null,
        train: {
            trades: safeGetNumber(strategy?.trades),
            winRate: safeGetNumber(strategy?.winRate),
            winRateLCB: safeGetNumber(strategy?.winRateLCB),
            posteriorPWinRateGE90: safeGetNumber(strategy?.posteriorPWinRateGE90),
            tradesPerDay: safeGetNumber(strategy?.tradesPerDay)
        },
        val: {
            trades: safeGetNumber(strategy?.valTrades),
            winRate: safeGetNumber(strategy?.valWinRate),
            winRateLCB: safeGetNumber(strategy?.valWinRateLCB),
            posteriorPWinRateGE90: safeGetNumber(strategy?.valPosteriorPWinRateGE90)
        },
        test: {
            trades: safeGetNumber(strategy?.testTrades),
            winRate: safeGetNumber(strategy?.testWinRate),
            winRateLCB: safeGetNumber(strategy?.testWinRateLCB),
            posteriorPWinRateGE90: safeGetNumber(strategy?.testPosteriorPWinRateGE90)
        }
    };
}

async function main() {
    const root = path.join(__dirname, '..');
    const finalResultsPath = path.join(root, 'exhaustive_analysis', 'final_results.json');
    const strategiesRankedPath = path.join(root, 'exhaustive_analysis', 'strategies_ranked.json');
    const datasetPath = path.join(root, 'exhaustive_analysis', 'decision_dataset.json');

    console.log('GO SWEEP (GLOBAL + STRICT)');
    console.log(JSON.stringify({ auditConfig }, null, 2));

    console.time('load_strategies');
    let strategies = null;
    let strategiesSource = null;
    if (fs.existsSync(finalResultsPath)) {
        const finalResults = readJson(finalResultsPath);
        if (Array.isArray(finalResults?.strategies) && finalResults.strategies.length > 0) {
            strategies = finalResults.strategies;
            strategiesSource = 'final_results.json:strategies';
        }
    }
    if (!Array.isArray(strategies) || strategies.length === 0) {
        strategies = readJson(strategiesRankedPath);
        strategiesSource = 'strategies_ranked.json';
    }
    strategies = strategies.map(s => ({
        entryMinute: s?.entryMinute,
        utcHour: s?.utcHour,
        priceBand: s?.priceBand,
        direction: s?.direction,
        trades: s?.trades,
        wins: s?.wins,
        losses: s?.losses,
        winRate: s?.winRate,
        winRateLCB: s?.winRateLCB,
        posteriorPWinRateGE90: s?.posteriorPWinRateGE90,
        tradesPerDay: s?.tradesPerDay
    }));
    console.timeEnd('load_strategies');

    console.log(`strategiesSource: ${strategiesSource}`);
    console.log(`strategies: ${Array.isArray(strategies) ? strategies.length : 0}`);

    console.time('load_dataset');
    let dataset = readJson(datasetPath);
    console.timeEnd('load_dataset');

    console.log(`dataset rows: ${Array.isArray(dataset) ? dataset.length : 0}`);

    const trainRatio = 0.6;
    const valRatio = 0.2;

    console.time('split_dataset');
    const { valSet, testSet } = splitDatasetByMarkets3Way(dataset, trainRatio, valRatio);
    console.timeEnd('split_dataset');

    console.log(`val rows: ${valSet.length}`);
    console.log(`test rows: ${testSet.length}`);

    dataset = null;

    console.time('eval_val_all');
    const valEvaluated = walkForwardValidation(valSet, strategies, 'val', { minTrades: 0, maxStrategies: strategies.length });
    console.timeEnd('eval_val_all');

    const valStrict = valEvaluated.filter(passesValStrict);
    console.log(`val strict pass: ${valStrict.length}`);

    if (valStrict.length === 0) {
        console.log('NO_GO: no strategies pass strict validation gates');
        return;
    }

    console.time('eval_test_val_survivors');
    const tested = walkForwardValidation(testSet, valStrict, 'test', { minTrades: 0, maxStrategies: valStrict.length });
    console.timeEnd('eval_test_val_survivors');

    const globalStrictPass = tested.filter(s => passesValStrict(s) && passesTestStrict(s));
    console.log(`global strict PASS: ${globalStrictPass.length}`);

    if (globalStrictPass.length === 0) {
        const testedSummaries = tested.map(s => {
            const testWR = safeGetNumber(s?.testWinRate);
            const testLCB = safeGetNumber(s?.testWinRateLCB);
            const testPost = safeGetNumber(s?.testPosteriorPWinRateGE90);
            const testHardOk = (typeof testWR === 'number' && testWR >= auditConfig.minTestWinRate);
            const testProofOk = proofOk(testLCB, testPost);
            return {
                ...summarize(s),
                flags: {
                    valStrict: passesValStrict(s),
                    testHardOk,
                    testProofOk,
                    testStrict: (testHardOk && testProofOk)
                }
            };
        });
        console.log('TESTED_VAL_STRICT_SURVIVORS');
        console.log(JSON.stringify(testedSummaries, null, 2));
        console.log('NO_GO: no strategies pass strict validation+test gates');
        return;
    }

    const top = globalStrictPass[0];
    console.log('TOP_GLOBAL_STRICT_PASS');
    console.log(JSON.stringify(summarize(top), null, 2));

    const top5 = globalStrictPass.slice(0, 5).map(s => summarize(s));
    console.log('TOP5_GLOBAL_STRICT_PASS');
    console.log(JSON.stringify(top5, null, 2));
}

main().catch(err => {
    console.error(err);
    process.exit(1);
});
