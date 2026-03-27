const fs = require('fs');
const path = require('path');
const { getEntryMinute } = require('./market-discovery');

const strategySets = {};

 function strategySupportsAsset(strategy, asset) {
    const raw = String(strategy?.asset || '').trim();
    if (!raw || raw.toUpperCase() === 'ALL') return true;
    return raw.toUpperCase() === String(asset || '').trim().toUpperCase();
}

function loadStrategySet(timeframeKey, filePath) {
    try {
        const abs = path.isAbsolute(filePath) ? filePath : path.join(__dirname, '..', filePath);
        const raw = fs.readFileSync(abs, 'utf8');
        const parsed = JSON.parse(raw);
        const strategies = parsed.strategies || [];
        strategySets[timeframeKey] = {
            strategies,
            conditions: parsed.conditions || {},
            stats: parsed.stats || {},
            filePath: abs,
            loadedAt: new Date().toISOString()
        };
        console.log(`📋 Loaded ${strategies.length} strategies for ${timeframeKey} from ${path.basename(abs)}`);
        return strategies.length;
    } catch (e) {
        console.error(`❌ Failed to load strategy set for ${timeframeKey}: ${e.message}`);
        strategySets[timeframeKey] = { strategies: [], loadError: e.message };
        return 0;
    }
}

function getStrategySet(timeframeKey) {
    return strategySets[timeframeKey] || null;
}

function evaluateMatch(market, nowSec, timeframe) {
    const set = strategySets[timeframe.key];
    if (!set || !set.strategies || set.strategies.length === 0) return [];

    // BUG 7 FIX: For 4h blocks, use the epoch START hour (not current hour)
    // so strategies with utcHour=8 fire throughout the entire 08:00-11:59 block
    const { computeEpoch } = require('./market-discovery');
    const epoch = computeEpoch(nowSec, timeframe.seconds);
    const utcHour = new Date(epoch * 1000).getUTCHours();
    const entryMinute = getEntryMinute(nowSec, timeframe.seconds);

    const matches = [];

    for (const strategy of set.strategies) {
        if (!strategySupportsAsset(strategy, market.asset)) continue;
        if (Number(strategy.utcHour) !== -1 && Number(strategy.utcHour) !== utcHour) continue;
        if (Number(strategy.entryMinute) !== entryMinute) continue;

        const direction = String(strategy.direction || '').toUpperCase();
        if (direction !== 'UP' && direction !== 'DOWN') continue;

        const entryPrice = direction === 'UP' ? market.yesPrice : market.noPrice;
        if (!entryPrice || entryPrice <= 0 || entryPrice >= 1) continue;

        const priceMin = Number(strategy.priceMin) || 0;
        const priceMax = Number(strategy.priceMax) || 1;
        if (entryPrice < priceMin || entryPrice > priceMax) continue;

        matches.push({
            strategy,
            asset: market.asset,
            timeframe: timeframe.key,
            direction,
            entryPrice,
            utcHour,
            entryMinute,
            pWinEstimate: strategy.winRateLCB || strategy.winRate || 0.5,
            tier: strategy.tier || 'UNKNOWN',
            signature: strategy.signature || `${strategy.id}`,
            name: strategy.name || `S${strategy.id}`
        });
    }

    return matches;
}

function sortCandidates(candidates) {
    return candidates.sort((a, b) => {
        const lcbA = a.strategy.winRateLCB || 0;
        const lcbB = b.strategy.winRateLCB || 0;
        if (lcbB !== lcbA) return lcbB - lcbA;
        const wrA = a.strategy.winRate || 0;
        const wrB = b.strategy.winRate || 0;
        return wrB - wrA;
    });
}

function getAllLoadedSets() {
    const result = {};
    for (const [key, set] of Object.entries(strategySets)) {
        result[key] = {
            loaded: !set.loadError,
            strategies: set.strategies ? set.strategies.length : 0,
            loadError: set.loadError || null,
            filePath: set.filePath || null,
            loadedAt: set.loadedAt || null
        };
    }
    return result;
}

module.exports = {
    loadStrategySet,
    getStrategySet,
    evaluateMatch,
    sortCandidates,
    getAllLoadedSets
};
