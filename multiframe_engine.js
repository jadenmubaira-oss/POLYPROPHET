/**
 * POLYPROPHET Multi-Timeframe Engine
 * 
 * Handles 4-hour and 5-minute Polymarket cycle monitoring and signalling.
 * - 4h: Full strategy evaluation + signal generation (5 walk-forward validated strategies)
 * - 5m: Monitor-only (display prices, no signals until sufficient data ~May 2026)
 */

const fs = require('fs');
const path = require('path');
const axios = require('axios');

// ==================== CONSTANTS ====================
const ASSETS = ['BTC', 'ETH', 'SOL', 'XRP'];

const TIMEFRAME_CONFIG = {
    '4h': {
        cycleSec: 14400,
        slugInfix: 'updown-4h',
        epochMod: 14400,
        epochOffset: 3600, // epochs are at 1h offset: 3600, 18000, 32400, ...
        pollIntervalMs: 30000, // poll every 30s
        utcStartHours: [1, 5, 9, 13, 17, 21],
        signalEnabled: true,
    },
    '5m': {
        cycleSec: 300,
        slugInfix: 'updown-5m',
        epochMod: 300,
        epochOffset: 0,
        pollIntervalMs: 15000, // poll every 15s
        utcStartHours: null, // all hours
        signalEnabled: false, // monitor only
    }
};

// ==================== STATE ====================
const state = {
    '4h': {
        markets: {}, // asset -> { slug, yesPrice, noPrice, conditionId, outcomes, clobTokenIds, volume, fetchedAt }
        signals: {}, // asset -> { direction, entryPrice, strategy, tier, reason, firedAt, cycleEpoch }
        history: [],  // last 50 signals
        strategySet: null,
        lastPollAt: 0,
        errors: [],
    },
    '5m': {
        markets: {}, // asset -> { slug, yesPrice, noPrice, ... }
        history: [],  // last 50 outcome records for display
        lastPollAt: 0,
        errors: [],
    }
};

// ==================== STRATEGY SET LOADER ====================
function loadStrategySet4h() {
    const filePath = path.join(__dirname, 'debug', 'strategy_set_4h_curated.json');
    try {
        if (!fs.existsSync(filePath)) {
            state['4h'].strategySet = null;
            return { loaded: false, error: 'FILE_NOT_FOUND' };
        }
        const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        state['4h'].strategySet = raw;
        return { loaded: true, strategies: raw.strategies?.length || 0 };
    } catch (e) {
        state['4h'].strategySet = null;
        return { loaded: false, error: e.message };
    }
}

// Load on module init
loadStrategySet4h();

// ==================== EPOCH HELPERS ====================
function getCurrent4hEpoch() {
    const nowSec = Math.floor(Date.now() / 1000);
    // 4h epochs: nowSec aligned to 14400s boundary, offset by 3600
    // Epochs are at: 3600, 18000, 32400, 46800, ...
    const adjusted = nowSec - 3600;
    const cycleStart = Math.floor(adjusted / 14400) * 14400 + 3600;
    return cycleStart;
}

function getCurrent5mEpoch() {
    const nowSec = Math.floor(Date.now() / 1000);
    return nowSec - (nowSec % 300);
}

function getElapsedMinutes(epochSec, cycleSec) {
    const nowSec = Math.floor(Date.now() / 1000);
    const elapsed = nowSec - epochSec;
    return Math.floor(elapsed / 60);
}

function getTimeRemaining(epochSec, cycleSec) {
    const nowSec = Math.floor(Date.now() / 1000);
    const endSec = epochSec + cycleSec;
    const remaining = endSec - nowSec;
    if (remaining <= 0) return '0:00';
    const mins = Math.floor(remaining / 60);
    const secs = remaining % 60;
    if (mins >= 60) {
        const hrs = Math.floor(mins / 60);
        const rmins = mins % 60;
        return `${hrs}h ${String(rmins).padStart(2, '0')}m`;
    }
    return `${mins}:${String(secs).padStart(2, '0')}`;
}

// ==================== MARKET DATA FETCHER ====================
async function fetchMarketData(timeframe) {
    const config = TIMEFRAME_CONFIG[timeframe];
    if (!config) return;

    const epoch = timeframe === '4h' ? getCurrent4hEpoch() : getCurrent5mEpoch();
    const results = {};

    for (const asset of ASSETS) {
        const slug = `${asset.toLowerCase()}-${config.slugInfix}-${epoch}`;
        try {
            const url = `https://gamma-api.polymarket.com/markets?slug=${slug}`;
            const resp = await axios.get(url, { timeout: 10000 });
            const markets = resp.data;

            if (!Array.isArray(markets) || markets.length === 0) {
                results[asset] = { slug, status: 'NOT_FOUND', fetchedAt: Date.now() };
                continue;
            }

            const market = markets[0];
            const outcomes = market.outcomes ? JSON.parse(market.outcomes) : [];
            const prices = market.outcomePrices ? JSON.parse(market.outcomePrices) : [];
            const clobTokenIds = market.clobTokenIds ? JSON.parse(market.clobTokenIds) : [];

            // Determine which index is UP/DOWN
            let yesPrice = null, noPrice = null;
            const o0 = String(outcomes[0] || '').toLowerCase();
            const o1 = String(outcomes[1] || '').toLowerCase();

            if (o0 === 'up' || o0 === 'yes') {
                yesPrice = parseFloat(prices[0]) || null;
                noPrice = parseFloat(prices[1]) || null;
            } else {
                yesPrice = parseFloat(prices[1]) || null;
                noPrice = parseFloat(prices[0]) || null;
            }

            results[asset] = {
                slug,
                conditionId: market.conditionId || null,
                yesPrice,
                noPrice,
                outcomes,
                clobTokenIds,
                volume: Number(market.volume || 0),
                active: market.active !== false && !market.closed,
                resolved: market.resolved === true,
                resolvedOutcome: null,
                fetchedAt: Date.now(),
                cycleEpoch: epoch,
                status: 'OK'
            };

            // Check if resolved
            if (market.resolved) {
                const winnerIdx = market.outcomes ? outcomes.findIndex((_, i) => {
                    const prices2 = market.outcomePrices ? JSON.parse(market.outcomePrices) : [];
                    return parseFloat(prices2[i]) >= 0.95;
                }) : -1;
                if (winnerIdx >= 0) {
                    const winOutcome = String(outcomes[winnerIdx] || '').toUpperCase();
                    results[asset].resolvedOutcome = winOutcome === 'UP' || winOutcome === 'YES' ? 'UP' : 'DOWN';
                }
            }
        } catch (e) {
            results[asset] = { slug, status: 'ERROR', error: e.message, fetchedAt: Date.now() };
        }

        // Small delay between assets to avoid rate limiting
        await new Promise(r => setTimeout(r, 200));
    }

    state[timeframe].markets = results;
    state[timeframe].lastPollAt = Date.now();
    return results;
}

// ==================== 4H STRATEGY EVALUATION ====================
function evaluate4hStrategies(livePrices) {
    const ss = state['4h'].strategySet;
    if (!ss || !Array.isArray(ss.strategies) || ss.strategies.length === 0) {
        return [];
    }

    const epoch = getCurrent4hEpoch();
    const elapsedMin = getElapsedMinutes(epoch, 14400);
    const utcHour = new Date(epoch * 1000).getUTCHours();
    const signals = [];

    for (const asset of ASSETS) {
        const mkt = state['4h'].markets[asset];
        if (!mkt || mkt.status !== 'OK' || !mkt.active || mkt.resolved) continue;

        const yesPrice = mkt.yesPrice;
        const noPrice = mkt.noPrice;
        if (!Number.isFinite(yesPrice) || !Number.isFinite(noPrice)) continue;

        // Check each strategy
        for (const strat of ss.strategies) {
            if (Number(strat.utcHour) !== utcHour) continue;
            if (elapsedMin < Number(strat.entryMinute)) continue; // not time yet

            const dir = String(strat.direction).toUpperCase();
            const entryPrice = dir === 'UP' ? yesPrice : noPrice;
            const bandMin = Number(strat.priceMin);
            const bandMax = Number(strat.priceMax);

            if (!Number.isFinite(entryPrice) || entryPrice < bandMin || entryPrice > bandMax) continue;

            // Check if already signaled this cycle for this asset
            const existingSignal = state['4h'].signals[asset];
            if (existingSignal && existingSignal.cycleEpoch === epoch) continue;

            const tierIcon = strat.tier === 'PLATINUM' ? '💎' : strat.tier === 'GOLD' ? '🥇' : '🥈';
            const signal = {
                asset,
                direction: dir,
                entryPrice,
                strategy: strat.name,
                strategyId: strat.id,
                tier: strat.tier,
                winRate: strat.winRate,
                winRateLCB: strat.winRateLCB,
                reason: `${tierIcon} [4H] ${strat.tier}: ${strat.name} - ${asset} ${dir} @ ${(entryPrice * 100).toFixed(0)}c (${(strat.winRate * 100).toFixed(1)}% WR)`,
                firedAt: Date.now(),
                cycleEpoch: epoch,
                utcHour,
                elapsedMin,
                slug: mkt.slug
            };

            state['4h'].signals[asset] = signal;
            state['4h'].history.unshift(signal);
            if (state['4h'].history.length > 50) state['4h'].history.length = 50;

            signals.push(signal);
        }
    }

    return signals;
}

// ==================== 5M OUTCOME TRACKER ====================
function track5mOutcomes() {
    for (const asset of ASSETS) {
        const mkt = state['5m'].markets[asset];
        if (!mkt || mkt.status !== 'OK') continue;

        if (mkt.resolved && mkt.resolvedOutcome) {
            const existing = state['5m'].history.find(h => h.slug === mkt.slug);
            if (!existing) {
                state['5m'].history.unshift({
                    asset,
                    slug: mkt.slug,
                    outcome: mkt.resolvedOutcome,
                    yesPrice: mkt.yesPrice,
                    noPrice: mkt.noPrice,
                    timestamp: Date.now()
                });
                if (state['5m'].history.length > 100) state['5m'].history.length = 100;
            }
        }
    }
}

// ==================== PUBLIC API ====================
function getStatus() {
    const epoch4h = getCurrent4hEpoch();
    const epoch5m = getCurrent5mEpoch();

    const ss = state['4h'].strategySet;

    return {
        '4h': {
            currentEpoch: epoch4h,
            utcHour: new Date(epoch4h * 1000).getUTCHours(),
            elapsedMinutes: getElapsedMinutes(epoch4h, 14400),
            timeRemaining: getTimeRemaining(epoch4h, 14400),
            cycleProgress: Math.min(1, getElapsedMinutes(epoch4h, 14400) / 240),
            markets: Object.fromEntries(
                ASSETS.map(a => [a, state['4h'].markets[a] || { status: 'NOT_POLLED' }])
            ),
            activeSignals: Object.fromEntries(
                ASSETS.map(a => {
                    const sig = state['4h'].signals[a];
                    return [a, (sig && sig.cycleEpoch === epoch4h) ? sig : null];
                })
            ),
            strategySet: ss ? {
                loaded: true,
                strategies: ss.strategies?.length || 0,
                source: ss.stats?.source || 'unknown',
                aggregateWR: ss.stats?.aggregateWR || null,
                aggregateLCB: ss.stats?.aggregateLCB || null
            } : { loaded: false },
            recentSignals: state['4h'].history.slice(0, 20),
            lastPollAt: state['4h'].lastPollAt,
            signalEnabled: true
        },
        '5m': {
            currentEpoch: epoch5m,
            elapsedSeconds: Math.floor(Date.now() / 1000) - epoch5m,
            timeRemaining: getTimeRemaining(epoch5m, 300),
            cycleProgress: Math.min(1, (Math.floor(Date.now() / 1000) - epoch5m) / 300),
            markets: Object.fromEntries(
                ASSETS.map(a => [a, state['5m'].markets[a] || { status: 'NOT_POLLED' }])
            ),
            recentOutcomes: state['5m'].history.slice(0, 20),
            lastPollAt: state['5m'].lastPollAt,
            signalEnabled: false,
            monitorNote: 'Monitor only - insufficient data for trading (9.7 days). Revisit ~May 2026.'
        }
    };
}

function getStrategySchedule() {
    const ss = state['4h'].strategySet;
    if (!ss || !Array.isArray(ss.strategies)) return [];

    return ss.strategies.map(s => ({
        id: s.id,
        name: s.name,
        utcHour: s.utcHour,
        entryMinute: s.entryMinute,
        direction: s.direction,
        priceBand: `${(s.priceMin * 100).toFixed(0)}-${(s.priceMax * 100).toFixed(0)}c`,
        tier: s.tier,
        winRate: s.winRate,
        winRateLCB: s.winRateLCB,
        trainWR: s.trainWinRate,
        testWR: s.testWinRate,
        totalTrades: s.historicalTrades,
        totalROI: s.totalROI
    }));
}

// ==================== POLLING LOOPS ====================
let _poll4hRunning = false;
let _poll5mRunning = false;
let _poll4hInterval = null;
let _poll5mInterval = null;

async function poll4h(livePrices) {
    if (_poll4hRunning) return;
    _poll4hRunning = true;
    try {
        await fetchMarketData('4h');
        const newSignals = evaluate4hStrategies(livePrices || {});
        return newSignals;
    } catch (e) {
        state['4h'].errors.push({ error: e.message, at: Date.now() });
        if (state['4h'].errors.length > 20) state['4h'].errors.shift();
        return [];
    } finally {
        _poll4hRunning = false;
    }
}

async function poll5m() {
    if (_poll5mRunning) return;
    _poll5mRunning = true;
    try {
        await fetchMarketData('5m');
        track5mOutcomes();
    } catch (e) {
        state['5m'].errors.push({ error: e.message, at: Date.now() });
        if (state['5m'].errors.length > 20) state['5m'].errors.shift();
    } finally {
        _poll5mRunning = false;
    }
}

function startPolling(livePrices, onSignal) {
    // 4h: poll every 30s, evaluate strategies
    _poll4hInterval = setInterval(async () => {
        const signals = await poll4h(livePrices);
        if (signals && signals.length > 0 && typeof onSignal === 'function') {
            for (const sig of signals) {
                onSignal(sig);
            }
        }
    }, TIMEFRAME_CONFIG['4h'].pollIntervalMs);

    // 5m: poll every 15s, monitor only
    _poll5mInterval = setInterval(() => {
        poll5m();
    }, TIMEFRAME_CONFIG['5m'].pollIntervalMs);

    // Initial poll
    poll4h(livePrices).then(signals => {
        if (signals && signals.length > 0 && typeof onSignal === 'function') {
            for (const sig of signals) onSignal(sig);
        }
    });
    poll5m();

    console.log('🔮 Multi-timeframe engine started: 4h (30s poll) + 5m (15s poll, monitor only)');
}

function stopPolling() {
    if (_poll4hInterval) { clearInterval(_poll4hInterval); _poll4hInterval = null; }
    if (_poll5mInterval) { clearInterval(_poll5mInterval); _poll5mInterval = null; }
}

module.exports = {
    getStatus,
    getStrategySchedule,
    poll4h,
    poll5m,
    startPolling,
    stopPolling,
    loadStrategySet4h,
    getCurrent4hEpoch,
    getCurrent5mEpoch,
    evaluate4hStrategies,
    state,
    ASSETS,
    TIMEFRAME_CONFIG
};
