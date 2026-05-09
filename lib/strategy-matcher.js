const fs = require('fs');
const path = require('path');
const { getEntryMinute } = require('./market-discovery');

const strategySets = {};

function normalizeProbability(value) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed < 0) return null;
    if (parsed > 0 && parsed <= 1) return parsed;
    if (parsed > 1 && parsed <= 100) return parsed / 100;
    return null;
}

function normalizeStrategy(strategy) {
    const normalized = { ...(strategy || {}) };
    const winRate = normalizeProbability(normalized.winRate);
    const winRateLCB = normalizeProbability(normalized.winRateLCB);
    const pWinEstimate = normalizeProbability(normalized.pWinEstimate) || winRateLCB || winRate || 0.5;
    const evWinEstimateRaw = normalizeProbability(normalized.evWinEstimate);
    const evWinEstimate = evWinEstimateRaw !== null && evWinEstimateRaw >= 0.5
        ? evWinEstimateRaw
        : pWinEstimate;

    normalized.winRate = winRate ?? normalized.winRate;
    normalized.winRateLCB = winRateLCB ?? normalized.winRateLCB;
    normalized.pWinEstimate = pWinEstimate;
    normalized.evWinEstimate = evWinEstimate;
    return normalized;
}

function strategySupportsAsset(strategy, asset) {
    const raw = String(strategy?.asset || '').trim();
    if (!raw || raw.toUpperCase() === 'ALL') return true;
    return raw.toUpperCase() === String(asset || '').trim().toUpperCase();
}

function isStructuralEdgeStrategy(strategy) {
    return String(strategy?.kind || strategy?.type || '').toUpperCase() === 'CEX_MOMENTUM_POLYMARKET_LAG'
        || strategy?.structuralEdge?.enabled === true;
}

function strategyEntryMinuteMatches(strategy, entryMinute) {
    if (Number.isFinite(Number(strategy.entryMinuteMin)) || Number.isFinite(Number(strategy.entryMinuteMax))) {
        const min = Number.isFinite(Number(strategy.entryMinuteMin)) ? Number(strategy.entryMinuteMin) : -Infinity;
        const max = Number.isFinite(Number(strategy.entryMinuteMax)) ? Number(strategy.entryMinuteMax) : Infinity;
        return entryMinute >= min && entryMinute <= max;
    }
    return Number(strategy.entryMinute) === entryMinute;
}

function structuralEdgeMatches(strategy, market, entryPrice, direction, context) {
    if (!isStructuralEdgeStrategy(strategy)) return { ok: true, reason: null };
    if (!context || context.ok === false) return { ok: false, reason: 'NO_STRUCTURAL_CONTEXT' };
    const maxAgeSec = Number.isFinite(Number(strategy.maxSignalAgeSec)) ? Number(strategy.maxSignalAgeSec) : 90;
    if (Number.isFinite(Number(context.dataAgeSec)) && Number(context.dataAgeSec) > maxAgeSec) {
        return { ok: false, reason: 'STRUCTURAL_CONTEXT_STALE' };
    }
    if (String(context.direction || '').toUpperCase() !== direction) return { ok: false, reason: 'SIGNAL_DIRECTION_MISMATCH' };
    const minMoveBps = Number.isFinite(Number(strategy.minMoveBps)) ? Number(strategy.minMoveBps) : 0;
    if (Number(context.absMoveBps || 0) < minMoveBps) return { ok: false, reason: 'MOVE_BPS_UNDER_MIN' };
    const oppositePrice = direction === 'UP' ? market.noPrice : market.yesPrice;
    const minNaiveEdge = Number.isFinite(Number(strategy.minNaiveEdge)) ? Number(strategy.minNaiveEdge) : 0;
    const naiveEdge = Math.min(1, Math.max(0, Number(oppositePrice || 0) + (Number(context.absMoveBps || 0) / 1000))) - entryPrice;
    if (naiveEdge < minNaiveEdge) return { ok: false, reason: 'NAIVE_EDGE_UNDER_MIN' };
    return { ok: true, reason: null, naiveEdge };
}

function loadStrategySet(timeframeKey, filePath) {
    try {
        const abs = path.isAbsolute(filePath) ? filePath : path.join(__dirname, '..', filePath);
        const raw = fs.readFileSync(abs, 'utf8');
        const parsed = JSON.parse(raw);
        const strategies = Array.isArray(parsed.strategies) ? parsed.strategies.map(normalizeStrategy) : [];
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

function hasStructuralStrategies(timeframeKey) {
    const set = strategySets[timeframeKey];
    return Boolean(set?.strategies?.some(isStructuralEdgeStrategy));
}

function evaluateMatch(market, nowSec, timeframe, structuralContext = null) {
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
        if (!strategyEntryMinuteMatches(strategy, entryMinute)) continue;

        const structural = isStructuralEdgeStrategy(strategy);
        const context = structuralContext?.[market.asset] || structuralContext || null;
        const direction = structural && strategy.directionFromSignal !== false
            ? String(context?.direction || strategy.direction || '').toUpperCase()
            : String(strategy.direction || '').toUpperCase();
        if (direction !== 'UP' && direction !== 'DOWN') continue;

        const entryPrice = direction === 'UP' ? market.yesPrice : market.noPrice;
        if (!entryPrice || entryPrice <= 0 || entryPrice >= 1) continue;

        const priceMin = Number(strategy.priceMin) || 0;
        const priceMax = Number(strategy.priceMax) || 1;
        if (entryPrice < priceMin || entryPrice > priceMax) continue;

        const structuralGate = structuralEdgeMatches(strategy, market, entryPrice, direction, context);
        if (!structuralGate.ok) continue;

        matches.push({
            strategy,
            asset: market.asset,
            timeframe: timeframe.key,
            direction,
            entryPrice,
            utcHour,
            entryMinute,
            pWinEstimate: strategy.pWinEstimate || strategy.winRateLCB || strategy.winRate || 0.5,
            evWinEstimate: strategy.evWinEstimate || strategy.pWinEstimate || strategy.winRate || strategy.winRateLCB || 0.5,
            tier: strategy.tier || 'UNKNOWN',
            signature: strategy.signature || `${strategy.id}`,
            name: strategy.name || `S${strategy.id}`,
            structuralContext: structural ? {
                moveBps: context?.moveBps ?? null,
                absMoveBps: context?.absMoveBps ?? null,
                dataAgeSec: context?.dataAgeSec ?? null,
                signalDirection: context?.direction ?? null,
                naiveEdge: structuralGate.naiveEdge ?? null
            } : null
        });
    }

    return matches;
}

function sortCandidates(candidates) {
    return candidates.sort((a, b) => {
        const pA = a.strategy.pWinEstimate || a.strategy.winRateLCB || 0;
        const pB = b.strategy.pWinEstimate || b.strategy.winRateLCB || 0;
        if (pB !== pA) return pB - pA;
        const wrA = a.strategy.evWinEstimate || a.strategy.winRate || 0;
        const wrB = b.strategy.evWinEstimate || b.strategy.winRate || 0;
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
    hasStructuralStrategies,
    evaluateMatch,
    sortCandidates,
    getAllLoadedSets
};
