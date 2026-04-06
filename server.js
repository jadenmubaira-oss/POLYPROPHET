const express = require('express');
const path = require('path');
const fs = require('fs');
const Redis = require('ioredis');
const CONFIG = require('./lib/config');
const DEPLOY_VERSION =
    process.env.RENDER_GIT_COMMIT ||
    process.env.SOURCE_VERSION ||
    process.env.GIT_COMMIT ||
    'local-dev';
const { discoverAllMarkets, computeEpoch, getEntryMinute, fetchMarketBySlug } = require('./lib/market-discovery');
const { loadStrategySet, evaluateMatch, sortCandidates, getAllLoadedSets } = require('./lib/strategy-matcher');
const RiskManager = require('./lib/risk-manager');
const TradeExecutor = require('./lib/trade-executor');
const telegram = require('./lib/telegram');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
const RUNTIME_STATE_PATH = path.join(__dirname, 'data', 'runtime-state.json');
const parseEnvBool = (value, defaultValue = false) => {
    if (value === undefined || value === null || String(value).trim() === '') return defaultValue;
    return ['1', 'true', 'yes', 'on'].includes(String(value).trim().toLowerCase());
};
const REDIS_RUNTIME_ENABLED = parseEnvBool(
    process.env.REDIS_ENABLED ?? process.env.USE_REDIS ?? (process.env.REDIS_URL ? 'true' : 'false'),
    !!process.env.REDIS_URL
);
const RUNTIME_STATE_REDIS_KEY = String(process.env.RUNTIME_STATE_REDIS_KEY || 'polyprophet:lite:runtime-state').trim() || 'polyprophet:lite:runtime-state';
const START_PAUSED_ENV = String(process.env.START_PAUSED || '').trim().toLowerCase();
const REDIS_IO_TIMEOUT_MS = 5000;

// ==================== CORE STATE ====================
const riskManager = new RiskManager(CONFIG.RISK.startingBalance);
const tradeExecutor = new TradeExecutor(riskManager);
let currentMarkets = {};
let lastOrchestrationTime = 0;
let orchestratorHeartbeat = { lastRun: null, marketsChecked: 0, candidatesFound: 0, tradesAttempted: 0 };
let diagnosticLog = [];
let restoredDiagnosticLogCount = 0;
const startupTime = Date.now();
const REPO_ROOT = fs.existsSync(path.join(__dirname, 'debug')) ? __dirname : path.join(__dirname, '..');
let redis = null;
let redisAvailable = false;
let runtimeStateLastSavedAt = 0;
let runtimeStateLastLoadSource = 'FRESH_START';

if (REDIS_RUNTIME_ENABLED && process.env.REDIS_URL) {
    try {
        redis = new Redis(process.env.REDIS_URL, {
            maxRetriesPerRequest: 3,
            retryStrategy: (times) => {
                if (times > 3) return null;
                return Math.min(times * 50, 2000);
            }
        });

        redis.on('connect', () => {
            redisAvailable = true;
            console.log('✅ Redis Connected - runtime-state persistence enabled');
        });

        redis.on('error', (err) => {
            redisAvailable = false;
            console.error(`⚠️ Redis Error: ${err.message} - runtime-state falling back to file`);
        });
    } catch (e) {
        console.error(`⚠️ Redis Init Failed: ${e.message} - runtime-state falling back to file`);
        redis = null;
        redisAvailable = false;
    }
} else if (REDIS_RUNTIME_ENABLED) {
    console.warn('⚠️ REDIS enabled but REDIS_URL missing - runtime-state using file only');
} else {
    console.log('ℹ️ REDIS disabled - runtime-state using file only');
}

function getConfiguredTimeframes() {
    return CONFIG.TIMEFRAMES.filter(tf => tf && tf.enabled !== false);
}

function getRuntimeBankrollForTimeframes() {
    const liveTradingBalance = Number(tradeExecutor?.getCachedBalanceBreakdown?.()?.tradingBalanceUsdc || tradeExecutor?.cachedLiveBalance || 0);
    if (CONFIG.TRADE_MODE === 'LIVE' && Number.isFinite(liveTradingBalance) && liveTradingBalance > 0) {
        return liveTradingBalance;
    }

    if (CONFIG.TRADE_MODE === 'LIVE') {
        return Math.max(0, liveTradingBalance || 0);
    }

    const riskBankroll = Number(riskManager?.bankroll);
    if (Number.isFinite(riskBankroll) && riskBankroll > 0) {
        return riskBankroll;
    }

    return Number(CONFIG.RISK.startingBalance || 0) || 0;
}

function getEnabledTimeframes() {
    const bankroll = getRuntimeBankrollForTimeframes();
    return getConfiguredTimeframes().filter(tf => bankroll >= Number(tf.minBankroll || 0));
}

function buildRuntimeStateSnapshot() {
    return {
        savedAt: new Date().toISOString(),
        risk: riskManager.exportState(),
        executor: tradeExecutor.exportState(),
        orchestratorHeartbeat,
        diagnosticLog: diagnosticLog.slice(-200)
    };
}

function applyRuntimeState(parsed, sourceLabel) {
    if (!parsed || typeof parsed !== 'object') return false;
    riskManager.importState(parsed.risk || {});
    tradeExecutor.importState(parsed.executor || {});
    if (parsed.orchestratorHeartbeat && typeof parsed.orchestratorHeartbeat === 'object') {
        orchestratorHeartbeat = { ...orchestratorHeartbeat, ...parsed.orchestratorHeartbeat };
    }
    if (Array.isArray(parsed.diagnosticLog)) {
        restoredDiagnosticLogCount = parsed.diagnosticLog.length;
        diagnosticLog = [];
    }
    runtimeStateLastLoadSource = sourceLabel || 'UNKNOWN';
    console.log(`♻️ Restored runtime state from ${runtimeStateLastLoadSource}`);
    return true;
}

function applyStartPausedOverride() {
    if (START_PAUSED_ENV === '0' || START_PAUSED_ENV === 'false') {
        riskManager.tradingPaused = false;
        console.log('🚀 START_PAUSED=false: forced unpause on startup');
        return;
    }
    if (START_PAUSED_ENV === '1' || START_PAUSED_ENV === 'true') {
        riskManager.tradingPaused = true;
        console.log('⏸️ START_PAUSED=true: forced pause on startup');
    }
}

function getRuntimeStateStatus() {
    return {
        mode: redisAvailable ? 'redis+file' : 'file',
        redisEnabled: REDIS_RUNTIME_ENABLED,
        redisConfigured: !!process.env.REDIS_URL,
        redisConnected: redisAvailable,
        redisKey: REDIS_RUNTIME_ENABLED ? RUNTIME_STATE_REDIS_KEY : null,
        filePath: RUNTIME_STATE_PATH,
        lastLoadSource: runtimeStateLastLoadSource,
        lastSavedAt: runtimeStateLastSavedAt || null,
        lastSavedAtIso: runtimeStateLastSavedAt ? new Date(runtimeStateLastSavedAt).toISOString() : null,
        startPausedEnv: START_PAUSED_ENV || null
    };
}

function canUseRedisRuntime() {
    const status = String(redis?.status || '').toLowerCase();
    return !!redis && !['close', 'end'].includes(status);
}

async function saveRuntimeState() {
    const snapshot = buildRuntimeStateSnapshot();
    try {
        fs.mkdirSync(path.dirname(RUNTIME_STATE_PATH), { recursive: true });
        fs.writeFileSync(RUNTIME_STATE_PATH, JSON.stringify(snapshot, null, 2));
    } catch (e) {
        console.error(`⚠️ Failed to save runtime state: ${e.message}`);
    }

    runtimeStateLastSavedAt = Date.now();

    if (!canUseRedisRuntime()) return snapshot;
    try {
        await Promise.race([
            redis.set(RUNTIME_STATE_REDIS_KEY, JSON.stringify(snapshot)),
            new Promise((_, reject) => setTimeout(() => reject(new Error('REDIS_SAVE_TIMEOUT')), REDIS_IO_TIMEOUT_MS))
        ]);
        redisAvailable = true;
    } catch (e) {
        redisAvailable = false;
        console.error(`⚠️ Failed to save runtime state to Redis: ${e.message}`);
    }

    return snapshot;
}

async function loadRuntimeState() {
    if (canUseRedisRuntime()) {
        try {
            const raw = await Promise.race([
                redis.get(RUNTIME_STATE_REDIS_KEY),
                new Promise((_, reject) => setTimeout(() => reject(new Error('REDIS_LOAD_TIMEOUT')), REDIS_IO_TIMEOUT_MS))
            ]);
            if (raw) {
                redisAvailable = true;
                if (applyRuntimeState(JSON.parse(raw), `redis:${RUNTIME_STATE_REDIS_KEY}`)) {
                    applyStartPausedOverride();
                    return;
                }
            }
        } catch (e) {
            redisAvailable = false;
            console.error(`⚠️ Failed to load runtime state from Redis: ${e.message}`);
        }
    }

    try {
        if (!fs.existsSync(RUNTIME_STATE_PATH)) {
            applyStartPausedOverride();
            return;
        }
        const raw = fs.readFileSync(RUNTIME_STATE_PATH, 'utf8');
        if (!raw) {
            applyStartPausedOverride();
            return;
        }
        applyRuntimeState(JSON.parse(raw), RUNTIME_STATE_PATH);
    } catch (e) {
        console.error(`⚠️ Failed to load runtime state: ${e.message}`);
    }

    applyStartPausedOverride();
}

// ==================== LOAD STRATEGY SETS ====================
function loadAllStrategySets() {
    const strategiesDir = path.join(__dirname, 'strategies');

    // PRIMARY 15m strategy: 24h_dense — highest 48h median across all OOS windows
    //   48 strategies, 65-88c band, 24/24 hour coverage, SF=0.15, MPC=7, EB=0
    //   OOS 48h @ $15 MPC=7: median $1922, bust 3.9%, >$100 in 92%
    // FALLBACKS: ultra_tight, filtered, maxgrowth_v5, v4, v3, v1, v2, then beam_2739.
    const envStrat15 = process.env.STRATEGY_SET_15M_PATH;
    const env15mPath = envStrat15
        ? (path.isAbsolute(envStrat15) ? envStrat15 : path.join(REPO_ROOT, envStrat15))
        : null;
    const primary15mPath = path.join(REPO_ROOT, 'strategies', 'strategy_set_15m_24h_dense.json');
    const secondary15mPath = path.join(REPO_ROOT, 'strategies', 'strategy_set_15m_24h_ultra_tight.json');
    const tertiary15mPath = path.join(REPO_ROOT, 'strategies', 'strategy_set_15m_24h_filtered.json');
    const quaternary15mPath = path.join(REPO_ROOT, 'strategies', 'strategy_set_15m_maxgrowth_v5.json');
    const quinary15mPath = path.join(REPO_ROOT, 'strategies', 'strategy_set_15m_maxgrowth_v4.json');
    const senary15mPath = path.join(REPO_ROOT, 'strategies', 'strategy_set_15m_maxgrowth_v3.json');

    for (const tf of getConfiguredTimeframes()) {
        let loaded = false;

        if (tf.key === '15m') {
            // 15m: maxgrowth_v5 primary, then v4, v3, v1, v2, beam_2739, then legacy
            const candidates15m = [
                ...(env15mPath ? [env15mPath] : []),
                primary15mPath,
                secondary15mPath,
                tertiary15mPath,
                quaternary15mPath,
                quinary15mPath,
                senary15mPath,
                path.join(REPO_ROOT, 'debug', 'strategy_set_15m_nc_beam_best_12.json'),
                path.join(REPO_ROOT, 'debug', 'strategy_set_top8_current.json'),
                path.join(REPO_ROOT, 'debug', 'strategy_set_top3_robust.json'),
                path.join(REPO_ROOT, 'debug', 'strategy_set_union_validated_top12_max95.json'),
            ];
            for (const fp of candidates15m) {
                const exists = fs.existsSync(fp);
                console.log(`  📂 15m candidate: ${path.basename(fp)} → ${exists ? 'EXISTS' : 'NOT_FOUND'}`);
                if (exists && !loaded) {
                    loadStrategySet('15m', fp);
                    loaded = true;
                    console.log(`  ✅ 15m LOADED: ${path.basename(fp)}`);
                    break;
                }
            }
            if (!loaded) {
                console.warn('  ⚠️ 15m: NO strategy file found! Trading will not work for 15m.');
            }
            continue;
        }

        // Other timeframes: use env var or built-in candidates
        const envKey = `STRATEGY_SET_${String(tf.key || '').toUpperCase().replace(/[^A-Z0-9]/g, '')}_PATH`;
        const envPath = process.env[envKey];
        const candidates = [
            ...(envPath ? [path.isAbsolute(envPath) ? envPath : path.join(REPO_ROOT, envPath)] : []),
            ...(tf.key === '4h' ? [
                path.join(REPO_ROOT, 'debug', 'strategy_set_4h_maxprofit.json'),
                path.join(REPO_ROOT, 'debug', 'strategy_set_4h_curated.json')
            ] : []),
            ...(tf.key === '5m' ? [
                path.join(REPO_ROOT, 'debug', 'strategy_set_5m_maxprofit.json'),
                path.join(REPO_ROOT, 'debug', 'strategy_set_5m_walkforward_top4.json')
            ] : []),
            path.join(strategiesDir, `strategy_set_${tf.key}_top8.json`),
            path.join(strategiesDir, `strategy_set_${tf.key}_top5.json`),
            path.join(strategiesDir, `strategy_set_${tf.key}.json`),
        ];
        for (const fp of [...new Set(candidates)]) {
            if (fs.existsSync(fp) && !loaded) {
                loadStrategySet(tf.key, fp);
                loaded = true;
                break;
            }
        }
    }
}

loadAllStrategySets();

function extractWinnerFromClosedMarket(market) {
    if (!market || !market.closed) return null;

    let outcomes = [];
    let prices = [];
    try { outcomes = JSON.parse(market.outcomes || '[]'); } catch {}
    try { prices = JSON.parse(market.outcomePrices || '[]'); } catch {}

    const upIdx = outcomes.findIndex(o => /^(yes|up)$/i.test(String(o).trim()));
    const downIdx = outcomes.findIndex(o => /^(no|down)$/i.test(String(o).trim()));
    const upPrice = upIdx >= 0 && prices[upIdx] ? parseFloat(prices[upIdx]) : null;
    const downPrice = downIdx >= 0 && prices[downIdx] ? parseFloat(prices[downIdx]) : null;

    if (upPrice !== null && upPrice >= 0.95) return 'UP';
    if (downPrice !== null && downPrice >= 0.95) return 'DOWN';
    if (upPrice !== null && upPrice <= 0.05) return 'DOWN';
    if (downPrice !== null && downPrice <= 0.05) return 'UP';
    return null;
}

async function reconcilePendingLivePositions() {
    const pending = tradeExecutor.getPendingSettlements();
    const results = [];

    for (const p of pending) {
        try {
            const market = await fetchMarketBySlug(p.slug);
            const winner = extractWinnerFromClosedMarket(market);
            if (!winner) continue;

            const pos = tradeExecutor.positions.find(pos => pos.id === p.id);
            if (!pos || pos.status !== 'PENDING_RESOLUTION') continue;

            const won = pos.direction === winner;
            const result = tradeExecutor.resolvePosition(p.id, won);
            if (result) {
                telegram.notifyTradeClose(result);
                results.push(result);
                diagnosticLog.push({
                    ts: new Date().toISOString(),
                    type: 'LIVE_SETTLEMENT',
                    asset: pos.asset,
                    timeframe: pos.timeframe,
                    direction: pos.direction,
                    won,
                    pnl: result.pnl,
                    slug: p.slug
                });
            }
        } catch (e) {
            diagnosticLog.push({
                ts: new Date().toISOString(),
                type: 'LIVE_SETTLEMENT_ERROR',
                slug: p.slug,
                error: e.message
            });
        }
    }

    return results;
}

// ==================== MAIN ORCHESTRATION LOOP ====================
async function orchestrate() {
    const nowSec = Math.floor(Date.now() / 1000);
    const enabledTimeframes = getEnabledTimeframes();

    if (CONFIG.TRADE_MODE === 'LIVE') {
        const balanceTimeout = (ms) => new Promise((_, reject) => setTimeout(() => reject(new Error('BALANCE_REFRESH_TIMEOUT')), ms));
        try {
            await Promise.race([
                tradeExecutor.refreshLiveBalance(),
                balanceTimeout(15000)
            ]);
        } catch (e) {
            if (e.message === 'BALANCE_REFRESH_TIMEOUT') {
                console.error('⚠️ Balance refresh timed out (15s) — continuing to discovery');
                diagnosticLog.push({ ts: new Date().toISOString(), type: 'BALANCE_REFRESH_TIMEOUT', message: 'refreshLiveBalance exceeded 15s hard timeout' });
            }
        }
        const pendingBuys = await Promise.race([
            tradeExecutor.processPendingBuys(10),
            balanceTimeout(15000).catch(() => ({ success: false, error: 'PENDING_BUYS_TIMEOUT', processed: 0, recovered: 0, failed: 0 }))
        ]).catch((e) => ({ success: false, error: e.message, processed: 0, recovered: 0, failed: 0 }));
        if ((pendingBuys.recovered || 0) > 0 || (pendingBuys.failed || 0) > 0) {
            diagnosticLog.push({
                ts: new Date().toISOString(),
                type: 'PENDING_BUY_MAINTENANCE',
                recovered: pendingBuys.recovered || 0,
                failed: pendingBuys.failed || 0,
                processed: pendingBuys.processed || 0
            });
        }
    }

    // Discover all markets across all timeframes and assets
    try {
        currentMarkets = await discoverAllMarkets(nowSec, enabledTimeframes);
    } catch (e) {
        console.error(`❌ Market discovery failed: ${e.message}`);
        return;
    }

    let marketsChecked = 0;
    let candidatesFound = 0;
    let tradesAttempted = 0;
    const allCandidates = [];

    // For each timeframe, evaluate strategy matches
    for (const tf of enabledTimeframes) {
        for (const asset of CONFIG.ASSETS) {
            const key = `${asset}_${tf.key}`;
            const market = currentMarkets[key];
            if (!market || market.status !== 'ACTIVE') continue;
            marketsChecked++;

            const matches = evaluateMatch(market, nowSec, tf);
            if (matches.length > 0) {
                for (const m of matches) {
                    m.epoch = market.epoch;
                    allCandidates.push({ candidate: m, market });
                }
                candidatesFound += matches.length;
            }
        }
    }

    // Sort all candidates by quality (across all timeframes)
    if (allCandidates.length > 0) {
        allCandidates.sort((a, b) => {
            const pA = a.candidate.strategy.pWinEstimate || a.candidate.strategy.winRateLCB || 0;
            const pB = b.candidate.strategy.pWinEstimate || b.candidate.strategy.winRateLCB || 0;
            return pB - pA;
        });

        // Log active windows
        const windowLog = allCandidates.map(c =>
            `${c.candidate.asset} ${c.candidate.timeframe} ${c.candidate.direction} ${c.candidate.name} @${(c.candidate.entryPrice*100).toFixed(0)}¢ pWin=${(c.candidate.pWinEstimate*100).toFixed(0)}%`
        ).join(' | ');
        console.log(`🎯 STRATEGY WINDOWS: ${windowLog}`);

        if (tradeFailureHalted) {
            console.warn(`🛑 TRADE FAILURE HALT active — skipping ${allCandidates.length} candidate(s) until POST /api/resume-errors`);
        } else {
            // Execute best candidates (risk manager limits how many per cycle)
            for (const { candidate, market } of allCandidates) {
                const result = await tradeExecutor.executeTrade(candidate, market);
                tradesAttempted++;

                if (result.success) {
                    consecutiveTradeFailures = 0;
                    lastTradeFailureAt = 0;
                    telegram.notifyTradeOpen(result);

                    diagnosticLog.push({
                        ts: new Date().toISOString(),
                        type: 'TRADE_OPENED',
                        asset: candidate.asset,
                        timeframe: candidate.timeframe,
                        direction: candidate.direction,
                        entryPrice: candidate.entryPrice,
                        size: result.size,
                        strategy: candidate.name
                    });
                } else if (result.blocked) {
                    diagnosticLog.push({
                        ts: new Date().toISOString(),
                        type: 'BLOCKED',
                        asset: candidate.asset,
                        timeframe: candidate.timeframe,
                        direction: candidate.direction,
                        entryPrice: candidate.entryPrice,
                        reason: result.error,
                        strategy: candidate.name
                    });
                } else if (!result.success) {
                    const reason = String(result.error || '');
                    const pendingBuyOpen = reason.includes('NO_FILL_AFTER_RETRIES');
                    if (pendingBuyOpen) {
                        consecutiveTradeFailures = 0;
                        lastTradeFailureAt = 0;
                    } else if (isCountableTradeFailure(result)) {
                        const nowMs = Date.now();
                        if (!lastTradeFailureAt || (nowMs - lastTradeFailureAt) > TRADE_FAILURE_WINDOW_MS) {
                            consecutiveTradeFailures = 0;
                        }
                        consecutiveTradeFailures++;
                        lastTradeFailureAt = nowMs;
                    } else {
                        consecutiveTradeFailures = 0;
                        lastTradeFailureAt = 0;
                    }

                    diagnosticLog.push({
                        ts: new Date().toISOString(),
                        type: pendingBuyOpen ? 'PENDING_BUY_OPEN' : 'TRADE_FAILED',
                        asset: candidate.asset,
                        timeframe: candidate.timeframe,
                        direction: candidate.direction,
                        entryPrice: candidate.entryPrice,
                        reason: result.error,
                        consecutiveTradeFailures,
                        strategy: candidate.name
                    });

                    if (!pendingBuyOpen && consecutiveTradeFailures >= TRADE_FAILURE_HALT_THRESHOLD) {
                        tradeFailureHalted = true;
                        console.error(`🛑 TRADE FAILURE HALT: ${consecutiveTradeFailures} consecutive live trade failures — automated entries paused. POST /api/resume-errors to recover.`);
                        diagnosticLog.push({
                            ts: new Date().toISOString(),
                            type: 'TRADE_FAILURE_HALT',
                            consecutiveTradeFailures,
                            threshold: TRADE_FAILURE_HALT_THRESHOLD,
                            lastError: result.error,
                            strategy: candidate.name
                        });
                        break;
                    }
                }
            }
        }
    }

    // Pre-resolution exit: sell winning positions before cycle ends (avoids redemption dependency)
    const preResExits = tradeExecutor.checkPreResolutionExits(currentMarkets);
    for (const exit of preResExits) {
        try {
            const result = await tradeExecutor.closePosition(exit.positionId, exit.exitPrice, 'PRE_RESOLUTION_EXIT');
            if (result?.success && result?.closed) {
                telegram.notifyTradeClose(result.closed);
                diagnosticLog.push({
                    ts: new Date().toISOString(),
                    type: 'PRE_RESOLUTION_EXIT',
                    asset: exit.asset,
                    timeframe: exit.timeframe,
                    direction: exit.direction,
                    exitPrice: exit.exitPrice,
                    remaining: exit.remaining,
                    pnl: result.closed?.pnl
                });
            }
        } catch (e) {
            console.error(`Pre-resolution exit failed for ${exit.positionId}: ${e.message}`);
        }
    }

    // 4h emergency exit: close positions with 20c+ adverse move
    const emergencyExits = tradeExecutor.check4hEmergencyExit(currentMarkets);
    for (const exit of emergencyExits) {
        await tradeExecutor.closePosition(exit.positionId, exit.exitPrice, 'EMERGENCY_EXIT_4H').catch(e => {
            console.error(`Emergency exit failed for ${exit.positionId}: ${e.message}`);
        });
    }

    // Check for expired positions to resolve
    tradeExecutor.checkAndResolveExpiredPositions(currentMarkets);

    // Resolve pending paper positions
    await resolvePendingPaperPositions();

    // Resolve pending live positions, retry pending sells, and redeem winners
    const liveSettlements = CONFIG.TRADE_MODE === 'LIVE'
        ? await reconcilePendingLivePositions()
        : [];
    const pendingSellResults = CONFIG.TRADE_MODE === 'LIVE'
        ? await tradeExecutor.processPendingSells(currentMarkets)
        : { success: true, processed: 0, closed: 0, failed: 0 };
    const redemptionResults = CONFIG.TRADE_MODE === 'LIVE'
        ? await tradeExecutor.checkAndRedeemPositions()
        : { success: true, redeemed: 0, failed: 0, skipped: 0, remaining: 0 };

    if (liveSettlements.length > 0 || pendingSellResults.closed > 0 || redemptionResults.redeemed > 0) {
        diagnosticLog.push({
            ts: new Date().toISOString(),
            type: 'LIFECYCLE_MAINTENANCE',
            liveSettlements: liveSettlements.length,
            pendingSellsClosed: pendingSellResults.closed || 0,
            pendingSellsFailed: pendingSellResults.failed || 0,
            redeemed: redemptionResults.redeemed || 0,
            redemptionFailed: redemptionResults.failed || 0
        });
    }

    // Update heartbeat
    orchestratorHeartbeat = {
        lastRun: new Date().toISOString(),
        marketsChecked,
        candidatesFound,
        tradesAttempted,
        activeMarkets: Object.values(currentMarkets).filter(m => m?.status === 'ACTIVE').length,
        totalMarkets: Object.keys(currentMarkets).length,
        pendingBuys: Object.keys(tradeExecutor.pendingBuys || {}).length,
        pendingSettlements: tradeExecutor.getPendingSettlements().length,
        pendingSells: Object.keys(tradeExecutor.pendingSells || {}).length,
        redemptionQueue: tradeExecutor.getRedemptionQueue().length
    };

    // Trim diagnostic log
    if (diagnosticLog.length > 500) diagnosticLog.splice(0, diagnosticLog.length - 500);
    saveRuntimeState();

    // Periodic heartbeat log (every 60s)
    if (nowSec - lastOrchestrationTime >= 60) {
        lastOrchestrationTime = nowSec;
        const utcHour = new Date().getUTCHours();
        const utcMin = new Date().getUTCMinutes();
        console.log(`📡 HEARTBEAT ${utcHour}:${String(utcMin).padStart(2,'0')} | Markets: ${marketsChecked}/${Object.keys(currentMarkets).length} active | Candidates: ${candidatesFound} | Trades: ${tradesAttempted} | Balance: $${riskManager.bankroll.toFixed(2)}`);
    }
}

async function resolvePendingPaperPositions() {
    const pending = [...tradeExecutor.pendingRedemptions];
    tradeExecutor.pendingRedemptions = [];

    for (const p of pending) {
        try {
            const market = await fetchMarketBySlug(p.slug);
            if (!market || !market.closed) {
                tradeExecutor.pendingRedemptions.push(p);
                continue;
            }

            let outcomes = [];
            let prices = [];
            try { outcomes = JSON.parse(market.outcomes || '[]'); } catch {}
            try { prices = JSON.parse(market.outcomePrices || '[]'); } catch {}

            const upIdx = outcomes.findIndex(o => /^(yes|up)$/i.test(String(o).trim()));
            const downIdx = outcomes.findIndex(o => /^(no|down)$/i.test(String(o).trim()));
            const upPrice = upIdx >= 0 && prices[upIdx] ? parseFloat(prices[upIdx]) : null;
            const downPrice = downIdx >= 0 && prices[downIdx] ? parseFloat(prices[downIdx]) : null;

            let winner = null;
            if (upPrice !== null && upPrice >= 0.95) winner = 'UP';
            else if (downPrice !== null && downPrice >= 0.95) winner = 'DOWN';
            else if (upPrice !== null && upPrice <= 0.05) winner = 'DOWN';
            else if (downPrice !== null && downPrice <= 0.05) winner = 'UP';

            if (winner) {
                const pos = tradeExecutor.positions.find(pos => pos.id === p.positionId);
                if (pos && pos.status === 'PENDING_RESOLUTION') {
                    const won = pos.direction === winner;
                    const result = tradeExecutor.resolvePosition(p.positionId, won);
                    if (result) {
                        telegram.notifyTradeClose(result);
                    }
                }
            } else {
                tradeExecutor.pendingRedemptions.push(p);
            }
        } catch {
            tradeExecutor.pendingRedemptions.push(p);
        }
    }
}

// ==================== API ENDPOINTS ====================
app.get('/api/health', (req, res) => {
    const uptime = (Date.now() - startupTime) / 1000;
    const executorStatus = tradeExecutor.getStatus();
    const activeTimeframes = getEnabledTimeframes();
    const runtimeBankrollForTimeframes = getRuntimeBankrollForTimeframes();
    const currentTierProfile = typeof riskManager._getTierProfile === 'function'
        ? riskManager._getTierProfile(runtimeBankrollForTimeframes)
        : null;
    res.json({
        status: 'ok',
        version: 'polyprophet-lite-1.0.0',
        deployVersion: DEPLOY_VERSION,
        startedAt: new Date(startupTime).toISOString(),
        uptime,
        mode: CONFIG.TRADE_MODE,
        isLive: CONFIG.IS_LIVE,
        balance: riskManager.bankroll,
        balanceBreakdown: executorStatus.balanceBreakdown,
        baselineBankroll: executorStatus.baselineBankroll,
        baselineBankrollInitialized: executorStatus.baselineBankrollInitialized,
        assets: CONFIG.ASSETS,
        timeframes: activeTimeframes.map(t => t.key),
        runtimeBankrollForTimeframes,
        configuredTimeframes: CONFIG.TIMEFRAMES.map(t => ({
            key: t.key,
            enabled: t.enabled !== false,
            active: activeTimeframes.some(activeTf => activeTf.key === t.key),
            minBankroll: Number(t.minBankroll || 0)
        })),
        orchestrator: orchestratorHeartbeat,
        pendingBuys: executorStatus.pendingBuys.length,
        pendingSettlements: executorStatus.pendingSettlements.length,
        pendingSells: executorStatus.pendingSells.length,
        redemptionQueue: executorStatus.redemptionQueue.length,
        runtimeState: getRuntimeStateStatus(),
        errorHalt: { halted: errorHalted, consecutiveErrors: consecutiveTickErrors, threshold: ERROR_HALT_THRESHOLD },
        tradeFailureHalt: { halted: tradeFailureHalted, consecutiveFailures: consecutiveTradeFailures, threshold: TRADE_FAILURE_HALT_THRESHOLD, windowMinutes: TRADE_FAILURE_WINDOW_MS / 60000 },
        riskControls: {
            requireRealOrderBook: !!CONFIG.RISK.requireRealOrderBook,
            enforceNetEdgeGate: !!CONFIG.RISK.enforceNetEdgeGate,
            minNetEdgeRoi: Number(CONFIG.RISK.minNetEdgeRoi || 0),
            minBalanceFloor: Number(CONFIG.RISK.minBalanceFloor || 0),
            minOrderShares: Number(CONFIG.RISK.minOrderShares || 0),
            entryPriceBufferCents: Number(CONFIG.RISK.entryPriceBufferCents || 0),
            maxTotalExposure: Number(CONFIG.RISK.maxTotalExposure || 0),
            maxTotalExposureMinBankroll: Number(CONFIG.RISK.maxTotalExposureMinBankroll || 0),
            riskEnvelopeEnabled: !!CONFIG.RISK.riskEnvelopeEnabled,
            riskEnvelopeMinBankroll: Number(CONFIG.RISK.riskEnvelopeMinBankroll || 0),
            currentTierProfile,
            vaultTriggerBalance: Number(CONFIG.RISK.vaultTriggerBalance || 0),
            stage2Threshold: Number(CONFIG.RISK.stage2Threshold || 0),
            tieredAbsoluteStakeCaps: {
                small: Number(CONFIG.RISK.maxAbsoluteStakeSmall || 0),
                medium: Number(CONFIG.RISK.maxAbsoluteStakeMedium || 0),
                large: Number(CONFIG.RISK.maxAbsoluteStakeLarge || 0)
            }
        },
        strategySets: getAllLoadedSets()
    });
});

app.get('/api/status', (req, res) => {
    res.json({
        risk: riskManager.getStatus(),
        executor: tradeExecutor.getStatus(),
        timeframes: getEnabledTimeframes().map(t => t.key),
        markets: Object.fromEntries(
            Object.entries(currentMarkets).map(([k, v]) => [k, {
                status: v?.status,
                yesPrice: v?.yesPrice,
                noPrice: v?.noPrice,
                slug: v?.slug
            }])
        ),
        orchestrator: orchestratorHeartbeat,
        strategies: getAllLoadedSets(),
        runtimeState: getRuntimeStateStatus(),
        errorHalt: { halted: errorHalted, consecutiveErrors: consecutiveTickErrors, threshold: ERROR_HALT_THRESHOLD },
        tradeFailureHalt: { halted: tradeFailureHalted, consecutiveFailures: consecutiveTradeFailures, threshold: TRADE_FAILURE_HALT_THRESHOLD, windowMinutes: TRADE_FAILURE_WINDOW_MS / 60000 }
    });
});

app.get('/api/trades', (req, res) => {
    const limit = parseInt(req.query.limit) || 50;
    res.json({
        trades: tradeExecutor.getRecentTrades(limit),
        openPositions: tradeExecutor.getOpenPositions(),
        risk: riskManager.getStatus()
    });
});

app.get('/api/diagnostics', (req, res) => {
    res.json({
        log: diagnosticLog.slice(-100),
        startedAt: new Date(startupTime).toISOString(),
        restoredHistoricalEntries: restoredDiagnosticLogCount,
        orchestrator: orchestratorHeartbeat,
        uptime: (Date.now() - startupTime) / 1000
    });
});

app.get('/api/debug/strategy-paths', (req, res) => {
    const strategiesDir = path.join(__dirname, 'strategies');
    const envStrat15 = process.env.STRATEGY_SET_15M_PATH;
    const candidates15m = [
        ...(envStrat15 ? [path.isAbsolute(envStrat15) ? envStrat15 : path.join(REPO_ROOT, envStrat15)] : []),
        path.join(REPO_ROOT, 'strategies', 'strategy_set_15m_24h_dense.json'),
        path.join(REPO_ROOT, 'strategies', 'strategy_set_15m_24h_ultra_tight.json'),
        path.join(REPO_ROOT, 'strategies', 'strategy_set_15m_24h_filtered.json'),
        path.join(REPO_ROOT, 'strategies', 'strategy_set_15m_maxgrowth_v5.json'),
        path.join(REPO_ROOT, 'strategies', 'strategy_set_15m_maxgrowth_v4.json'),
        path.join(REPO_ROOT, 'strategies', 'strategy_set_15m_beam_2739_uncapped.json'),
        path.join(REPO_ROOT, 'debug', 'strategy_set_definitive_full_guards_best.json'),
        path.join(REPO_ROOT, 'debug', 'strategy_set_15m_nc_exhaustive_13.json'),
        path.join(REPO_ROOT, 'debug', 'strategy_set_15m_nc_beam_best_12.json'),
        path.join(REPO_ROOT, 'debug', 'strategy_set_top8_current.json'),
        path.join(REPO_ROOT, 'debug', 'strategy_set_top3_robust.json'),
        path.join(REPO_ROOT, 'debug', 'strategy_set_union_validated_top12_max95.json'),
    ];
    const debugDirExists = fs.existsSync(path.join(__dirname, 'debug'));
    let debugFiles = [];
    try { debugFiles = fs.readdirSync(path.join(__dirname, 'debug')).filter(f => f.includes('strategy') || f.includes('15m')); } catch (e) { debugFiles = [`ERROR: ${e.message}`]; }
    res.json({
        __dirname,
        REPO_ROOT,
        debugDirExists,
        debugStrategyFiles: debugFiles,
        candidates: [...new Set(candidates15m)].map(fp => ({ path: fp, basename: path.basename(fp), exists: fs.existsSync(fp) })),
        currentlyLoaded: getAllLoadedSets()
    });
});

app.get('/api/reconcile-pending', (req, res) => {
    const executorStatus = tradeExecutor.getStatus();
    res.json({
        pendingBuys: executorStatus.pendingBuys,
        pendingSettlements: executorStatus.pendingSettlements,
        pendingSells: executorStatus.pendingSells,
        redemptionQueue: executorStatus.redemptionQueue,
        baselineBankroll: executorStatus.baselineBankroll,
        balanceBreakdown: executorStatus.balanceBreakdown
    });
});

app.post('/api/reconcile-pending', async (req, res) => {
    try {
        const pendingBuys = CONFIG.TRADE_MODE === 'LIVE'
            ? await tradeExecutor.processPendingBuys(50)
            : { success: true, processed: 0, recovered: 0, failed: 0 };
        const liveSettlements = CONFIG.TRADE_MODE === 'LIVE'
            ? await reconcilePendingLivePositions()
            : [];
        const pendingSells = CONFIG.TRADE_MODE === 'LIVE'
            ? await tradeExecutor.processPendingSells(currentMarkets, 10)
            : { success: true, processed: 0, closed: 0, failed: 0 };
        const redemptions = CONFIG.TRADE_MODE === 'LIVE'
            ? await tradeExecutor.checkAndRedeemPositions()
            : { success: true, redeemed: 0, failed: 0, skipped: 0, remaining: 0 };
        const balance = CONFIG.TRADE_MODE === 'LIVE'
            ? await tradeExecutor.refreshLiveBalance(true)
            : null;
        saveRuntimeState();

        res.json({
            success: true,
            pendingBuys,
            liveSettlements,
            pendingSells,
            redemptions,
            balance,
            executor: tradeExecutor.getStatus()
        });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

app.get('/api/wallet/balance', async (req, res) => {
    try {
        const balanceBreakdown = CONFIG.TRADE_MODE === 'LIVE'
            ? await tradeExecutor.refreshLiveBalance(true)
            : tradeExecutor.getCachedBalanceBreakdown();
        res.json({
            mode: CONFIG.TRADE_MODE,
            balanceBreakdown,
            baselineBankroll: tradeExecutor.baselineBankroll,
            baselineBankrollInitialized: tradeExecutor.baselineBankrollInitialized,
            walletLoaded: !!tradeExecutor.clob?.wallet,
            walletStatus: tradeExecutor.clob?.getStatus?.() || null,
            runtimeBankrollForTimeframes: getRuntimeBankrollForTimeframes(),
            activeTimeframes: getEnabledTimeframes().map(t => t.key)
        });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

app.get('/api/markets', (req, res) => {
    res.json(currentMarkets);
});

app.get('/api/clob-status', async (req, res) => {
    try {
        const status = tradeExecutor.clob?.getStatus?.() || {};
        const deriveResult = await tradeExecutor.clob?.ensureCreds?.().catch(e => ({ ok: false, reason: e.message })) || { ok: false, reason: 'no clob' };
        const liveTradeReady = await Promise.race([
            tradeExecutor.clob?.getTradeReadyClient?.({ force: true, ttlMs: 5000 }),
            new Promise(r => setTimeout(() => r({ ok: false, reason: 'TIMEOUT_5s' }), 5000))
        ]).catch(e => ({ ok: false, reason: e.message }));
        const tradeReady = liveTradeReady?.ok
            ? liveTradeReady
            : (status?.tradeReady?.ok ? status.tradeReady : liveTradeReady);
        res.json({
            clobStatus: status,
            credsDerived: deriveResult,
            tradeReady: { ok: tradeReady?.ok, reason: tradeReady?.reason, summary: tradeReady?.summary, closedOnly: tradeReady?.closedOnly, closedOnlyErr: tradeReady?.closedOnlyErr },
            hasCreds: !!(CONFIG.POLYMARKET_API_KEY && CONFIG.POLYMARKET_SECRET && CONFIG.POLYMARKET_PASSPHRASE),
            proxyConfigured: !!CONFIG.PROXY_URL,
            clobForceProxy: !!CONFIG.CLOB_FORCE_PROXY
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/derive-debug', async (req, res) => {
    try {
        const ClobClientClass = require('@polymarket/clob-client').ClobClient;
        if (!ClobClientClass || !tradeExecutor.clob?.wallet) {
            return res.json({ error: 'No ClobClient or wallet' });
        }
        const host = 'https://clob.polymarket.com';
        const wallet = tradeExecutor.clob.wallet;
        const results = {};

        // Try sigType=0 create
        try {
            const tmp0 = new ClobClientClass(host, 137, wallet, undefined, 0, wallet.address);
            const raw0 = await Promise.race([
                tmp0.createApiKey(),
                new Promise((_, r) => setTimeout(() => r(new Error('TIMEOUT')), 15000))
            ]);
            results.createSig0 = { raw: raw0, type: typeof raw0 };
        } catch (e) { results.createSig0 = { error: e.message }; }

        // Try sigType=0 derive
        try {
            const tmp0d = new ClobClientClass(host, 137, wallet, undefined, 0, wallet.address);
            const raw0d = await Promise.race([
                tmp0d.deriveApiKey(),
                new Promise((_, r) => setTimeout(() => r(new Error('TIMEOUT')), 15000))
            ]);
            results.deriveSig0 = { raw: raw0d, type: typeof raw0d };
        } catch (e) { results.deriveSig0 = { error: e.message }; }

        // Try sigType=1 create (EOA as funder)
        try {
            const funder = wallet.address;
            const tmp1 = new ClobClientClass(host, 137, wallet, undefined, 1, funder);
            const raw1 = await Promise.race([
                tmp1.createApiKey(),
                new Promise((_, r) => setTimeout(() => r(new Error('TIMEOUT')), 15000))
            ]);
            results.createSig1_eoa = { raw: raw1, type: typeof raw1 };
        } catch (e) { results.createSig1_eoa = { error: e.message }; }

        // Try sigType=1 derive (EOA as funder)
        try {
            const funder = wallet.address;
            const tmp1d = new ClobClientClass(host, 137, wallet, undefined, 1, funder);
            const raw1d = await Promise.race([
                tmp1d.deriveApiKey(),
                new Promise((_, r) => setTimeout(() => r(new Error('TIMEOUT')), 15000))
            ]);
            results.deriveSig1_eoa = { raw: raw1d, type: typeof raw1d };
        } catch (e) { results.deriveSig1_eoa = { error: e.message }; }

        // Try sigType=1 create (PROXY as funder)
        const proxyFunder = CONFIG.POLYMARKET_ADDRESS || null;
        if (proxyFunder && proxyFunder !== wallet.address) {
            try {
                const tmp1p = new ClobClientClass(host, 137, wallet, undefined, 1, proxyFunder);
                const raw1p = await Promise.race([
                    tmp1p.createApiKey(),
                    new Promise((_, r) => setTimeout(() => r(new Error('TIMEOUT')), 15000))
                ]);
                results.createSig1_proxy = { raw: raw1p, funder: proxyFunder };
            } catch (e) { results.createSig1_proxy = { error: e.message, funder: proxyFunder }; }

            // Try sigType=1 derive (PROXY as funder)
            try {
                const tmp1pd = new ClobClientClass(host, 137, wallet, undefined, 1, proxyFunder);
                const raw1pd = await Promise.race([
                    tmp1pd.deriveApiKey(),
                    new Promise((_, r) => setTimeout(() => r(new Error('TIMEOUT')), 15000))
                ]);
                results.deriveSig1_proxy = { raw: raw1pd, funder: proxyFunder };
            } catch (e) { results.deriveSig1_proxy = { error: e.message, funder: proxyFunder }; }
        }

        // Raw proxy health check: can the proxy reach CLOB and return valid data?
        try {
            const axios = require('axios');
            const proxyResp = await Promise.race([
                axios.get('https://clob.polymarket.com/time', { timeout: 10000 }),
                new Promise((_, r) => setTimeout(() => r(new Error('TIMEOUT')), 10000))
            ]);
            results.proxyHealthCheck = { status: proxyResp.status, data: proxyResp.data, headers: Object.fromEntries(Object.entries(proxyResp.headers).slice(0, 5)) };
        } catch (e) {
            results.proxyHealthCheck = { error: e.message };
        }

        // Raw derive attempt via axios directly (bypass @polymarket/clob-client)
        try {
            const axios = require('axios');
            const ethers = require('ethers');
            const { createL1Headers } = require('@polymarket/clob-client/dist/headers');
            const signer = wallet;
            const headers = await createL1Headers(signer, 137);
            const rawResp = await Promise.race([
                axios.post('https://clob.polymarket.com/auth/api-key', {}, { headers, timeout: 15000 }),
                new Promise((_, r) => setTimeout(() => r(new Error('TIMEOUT')), 15000))
            ]);
            results.rawCreateApiKey = { status: rawResp.status, data: rawResp.data };
        } catch (e) {
            results.rawCreateApiKey = { error: e.message, response: e.response ? { status: e.response.status, data: e.response.data } : null };
        }

        results.walletAddress = wallet.address;
        results.proxyConfigured = !!CONFIG.PROXY_URL;
        results.clobForceProxy = !!CONFIG.CLOB_FORCE_PROXY;
        res.json(results);
    } catch (e) {
        res.status(500).json({ error: e.message, stack: e.stack?.split('\n').slice(0, 5) });
    }
});

app.post('/api/manual-smoke-test', async (req, res) => {
    try {
        const secret = String(process.env.MANUAL_SMOKE_TEST_KEY || process.env.AUTH_PASSWORD || '').trim();
        const suppliedSecret = String(req.get('x-manual-smoke-key') || req.body?.manualSmokeKey || '').trim();
        if (!secret) {
            return res.status(503).json({ success: false, error: 'MANUAL_SMOKE_TEST_DISABLED' });
        }
        if (!suppliedSecret || suppliedSecret !== secret) {
            return res.status(401).json({ success: false, error: 'UNAUTHORIZED' });
        }
        if (CONFIG.TRADE_MODE !== 'LIVE' || !CONFIG.IS_LIVE) {
            return res.status(400).json({ success: false, error: 'LIVE_MODE_REQUIRED' });
        }
        if (req.body?.confirmLive !== true) {
            return res.status(400).json({ success: false, error: 'CONFIRM_LIVE_REQUIRED' });
        }

        const marketKey = String(req.body?.marketKey || '').trim();
        const direction = String(req.body?.direction || '').trim().toUpperCase();
        const expectedSlug = String(req.body?.expectedSlug || '').trim();
        const maxEntryPrice = Number(req.body?.maxEntryPrice);
        const pWinEstimateRaw = Number(req.body?.pWinEstimate);

        if (!marketKey) {
            return res.status(400).json({ success: false, error: 'MARKET_KEY_REQUIRED' });
        }
        if (direction !== 'UP' && direction !== 'DOWN') {
            return res.status(400).json({ success: false, error: 'DIRECTION_REQUIRED' });
        }

        const market = currentMarkets[marketKey];
        if (!market || market.status !== 'ACTIVE') {
            return res.status(400).json({ success: false, error: 'ACTIVE_MARKET_REQUIRED', marketKey });
        }

        const parts = marketKey.split('_');
        const asset = parts[0];
        const timeframe = parts[1];
        if (!asset || !timeframe) {
            return res.status(400).json({ success: false, error: 'INVALID_MARKET_KEY', marketKey });
        }
        if (expectedSlug && expectedSlug !== String(market.slug || '')) {
            return res.status(400).json({ success: false, error: 'SLUG_MISMATCH', marketKey, expectedSlug, actualSlug: market.slug || null });
        }

        const entryPrice = direction === 'UP' ? Number(market.yesPrice) : Number(market.noPrice);
        if (!(entryPrice > 0 && entryPrice < 1)) {
            return res.status(400).json({ success: false, error: 'INVALID_ENTRY_PRICE', marketKey, entryPrice });
        }
        if (Number.isFinite(maxEntryPrice) && entryPrice > maxEntryPrice) {
            return res.status(400).json({ success: false, error: 'ENTRY_PRICE_ABOVE_MAX', marketKey, entryPrice, maxEntryPrice });
        }

        const candidate = {
            asset,
            timeframe,
            direction,
            entryPrice,
            pWinEstimate: Number.isFinite(pWinEstimateRaw) ? pWinEstimateRaw : 0.5,
            name: 'MANUAL_SMOKE_TEST',
            signature: `manual-smoke|${marketKey}|${direction}`
        };

        const result = await tradeExecutor.executeTrade(candidate, market);
        diagnosticLog.push({
            ts: new Date().toISOString(),
            type: 'MANUAL_SMOKE_TEST',
            marketKey,
            slug: market.slug || null,
            direction,
            entryPrice,
            success: !!result?.success,
            blocked: !!result?.blocked,
            orderID: result?.orderID || null,
            error: result?.error || null
        });

        return res.status(result?.success ? 200 : 400).json({
            success: !!result?.success,
            marketKey,
            slug: market.slug || null,
            direction,
            entryPrice,
            result
        });
    } catch (e) {
        return res.status(500).json({ success: false, error: e.message });
    }
});

app.post('/api/resume-errors', (req, res) => {
    const prev = {
        errorHalt: { halted: errorHalted, consecutiveErrors: consecutiveTickErrors, threshold: ERROR_HALT_THRESHOLD },
        tradeFailureHalt: { halted: tradeFailureHalted, consecutiveFailures: consecutiveTradeFailures, threshold: TRADE_FAILURE_HALT_THRESHOLD, windowMinutes: TRADE_FAILURE_WINDOW_MS / 60000 }
    };
    errorHalted = false;
    consecutiveTickErrors = 0;
    tradeFailureHalted = false;
    consecutiveTradeFailures = 0;
    lastTradeFailureAt = 0;
    diagnosticLog.push({ ts: new Date().toISOString(), type: 'ERROR_HALT_RESUMED', prev });
    res.json({ success: true, message: 'Error and trade-failure halts cleared', prev });
});

// ==================== DASHBOARD ====================
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ==================== START ====================
const TICK_INTERVAL_MS = 2000;
const ERROR_HALT_THRESHOLD = 15;
const TRADE_FAILURE_HALT_THRESHOLD = 8;
const TRADE_FAILURE_WINDOW_MS = 30 * 60 * 1000;
let tickTimer = null;
let shuttingDown = false;
let server = null;
let consecutiveTickErrors = 0;
let errorHalted = false;
let consecutiveTradeFailures = 0;
let tradeFailureHalted = false;
let lastTradeFailureAt = 0;

function isCountableTradeFailure(result) {
    if (!result || result.success || result.blocked) return false;
    const reason = String(result.error || '');
    if (!reason) return false;
    if (reason.includes('NO_FILL_AFTER_RETRIES')) return false;
    return reason.startsWith('CLOB_ORDER_FAILED:') || reason.startsWith('LIVE_TRADE_ERROR:');
}

async function tick() {
    if (shuttingDown) return;
    if (errorHalted) {
        if (!shuttingDown) tickTimer = setTimeout(tick, TICK_INTERVAL_MS * 5);
        return;
    }
    try {
        await orchestrate();
        consecutiveTickErrors = 0;
    } catch (e) {
        consecutiveTickErrors++;
        console.error(`❌ Orchestration error (${consecutiveTickErrors}/${ERROR_HALT_THRESHOLD}): ${e.message}`);
        if (consecutiveTickErrors >= ERROR_HALT_THRESHOLD) {
            errorHalted = true;
            console.error(`🛑 ERROR HALT: ${consecutiveTickErrors} consecutive tick errors — trading paused. POST /api/resume-errors to recover.`);
            diagnosticLog.push({ ts: new Date().toISOString(), type: 'ERROR_HALT', consecutiveErrors: consecutiveTickErrors, lastError: e.message });
        }
    } finally {
        if (!shuttingDown) {
            tickTimer = setTimeout(tick, errorHalted ? TICK_INTERVAL_MS * 5 : TICK_INTERVAL_MS);
        }
    }
}

async function startServer() {
    await loadRuntimeState();
    console.log(`\n🚀 POLYPROPHET LITE — Multi-Timeframe Trading Bot`);
    console.log(`   Mode: ${CONFIG.TRADE_MODE} | Live: ${CONFIG.IS_LIVE ? 'YES' : 'NO'}`);
    console.log(`   Assets: ${CONFIG.ASSETS.join(', ')}`);
    console.log(`   Timeframes: ${getEnabledTimeframes().map(t => t.key).join(', ')}`);
    console.log(`   Starting Balance: $${CONFIG.RISK.startingBalance}`);
    console.log(`   Strategy Sets: ${JSON.stringify(getAllLoadedSets())}`);
    console.log(`   Runtime State: ${JSON.stringify(getRuntimeStateStatus())}\n`);

    server = app.listen(CONFIG.PORT, () => {
        console.log(`\n🌐 Dashboard: http://localhost:${CONFIG.PORT}`);
        console.log(`📡 Health: http://localhost:${CONFIG.PORT}/api/health`);
        console.log(`📊 Status: http://localhost:${CONFIG.PORT}/api/status\n`);

        tick();
    });

    server.on('error', (err) => {
        if (err.code === 'EADDRINUSE') {
            console.error(`🔴 Port ${CONFIG.PORT} in use — exiting`);
            process.exit(1);
        }
    });
}

async function shutdown(signal) {
    if (shuttingDown) return;
    console.log(`Received ${signal}, shutting down...`);
    shuttingDown = true;
    if (tickTimer) clearTimeout(tickTimer);
    await saveRuntimeState();
    if (redis) {
        await redis.quit().catch(() => null);
    }
    if (!server) {
        process.exit(0);
        return;
    }
    const forcedExit = setTimeout(() => process.exit(0), 5000);
    forcedExit.unref?.();
    server.close(() => process.exit(0));
}

startServer().catch((err) => {
    console.error(`🔴 Startup failed: ${err.message}`);
    process.exit(1);
});

process.on('SIGTERM', () => { void shutdown('SIGTERM'); });
process.on('SIGINT', () => { void shutdown('SIGINT'); });
