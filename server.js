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
const strategyValidator = require('./lib/strategy-validator');
const telegramCommands = require('./lib/telegram-commands');
const flySecrets = require('./lib/fly-secrets');

async function persistDerivedPolymarketSecrets() {
    const clob = tradeExecutor?.clob;
    if (!clob || typeof clob.ensureCreds !== 'function') {
        return { success: false, skipped: true, reason: 'CLOB_UNAVAILABLE', state: flySecrets.publicState() };
    }
    await clob.ensureCreds().catch(() => null);
    const secrets = typeof clob.getLastDerivedClobSecrets === 'function'
        ? clob.getLastDerivedClobSecrets()
        : null;
    if (!secrets || !Object.keys(secrets).length) {
        return { success: false, skipped: true, reason: 'NO_DERIVED_CLOB_SECRETS', state: flySecrets.publicState() };
    }
    return await flySecrets.setSecrets(secrets);
}

// EPOCH 2: V2 SDK dual-path loader (shared across server.js endpoints)
function loadClobClientSdk() {
    try {
        const { ClobClient: V2ClobClient } = require('@polymarket/clob-client-v2');
        if (V2ClobClient) {
            const Original = V2ClobClient;
            const Wrapper = function(...args) {
                if (args.length >= 2 && typeof args[0] === 'string' && typeof args[1] === 'number') {
                    const [host, chain, signer, creds, signatureType, funder] = args;
                    return new Original({ host, chain, signer, creds, signatureType, funder, funderAddress: funder });
                }
                return new Original(...args);
            };
            Object.setPrototypeOf(Wrapper, Original);
            Wrapper.prototype = Original.prototype;
            return { ClobClient: Wrapper, version: 'v2', source: '@polymarket/clob-client-v2' };
        }
    } catch (e) {
        // fall through to V1
    }
    try {
        const V1 = require('@polymarket/clob-client').ClobClient;
        return { ClobClient: V1, version: 'v1', source: '@polymarket/clob-client' };
    } catch (e) {
        return { ClobClient: null, version: null, source: null };
    }
}

// V2-compatible header loader (createL1Headers moved to main export in V2)
function loadClobHeaders() {
    try {
        const v2 = require('@polymarket/clob-client-v2');
        if (v2.createL1Headers) return { createL1Headers: v2.createL1Headers, version: 'v2' };
    } catch (e) {
        // fall through
    }
    try {
        const v1 = require('@polymarket/clob-client/dist/headers');
        if (v1.createL1Headers) return { createL1Headers: v1.createL1Headers, version: 'v1' };
    } catch (e) {
        return { createL1Headers: null, version: null };
    }
}

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
const MICRO_BANKROLL_DEPLOY_PROFILE = !!CONFIG.MICRO_BANKROLL_DEPLOY_PROFILE;
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
let lastDailySummaryAt = 0;
let lastHeartbeatPingAt = 0;
let lastKnownPeakBalance = 0;
let lastKnownBankroll = 0;
let lastCooldownActive = false;
let lastHaltStates = { errorHalt: false, tradeFailureHalt: false };
let lastTradeFailureDetail = null;
let recentTradeFailureDetails = [];
let lastPaperSettlementReconLogAt = 0;
let lastPaperSettlementReconFingerprint = '';
let lastLifecycleSuppressionLogAt = 0;
let lastLifecycleSuppressionFingerprint = '';
let cachedBestWindows = null;
let cachedBestWindowsAt = 0;
const REPO_ROOT = fs.existsSync(path.join(__dirname, 'strategies')) ? __dirname : path.join(__dirname, '..');
let redis = null;
let redisAvailable = false;
let runtimeStateLastSavedAt = 0;
let runtimeStateLastLoadSource = 'FRESH_START';

function buildStrategyPathDebug() {
    const envStrat15 = process.env.STRATEGY_SET_15M_PATH || null;
    const env15mPath = envStrat15
        ? (path.isAbsolute(envStrat15) ? envStrat15 : path.join(REPO_ROOT, envStrat15))
        : null;

    const fallbackCandidates15m = [
        path.join(REPO_ROOT, 'strategies', 'strategy_set_15m_epoch3v2_portfolio.json'),
        path.join(REPO_ROOT, 'strategies', 'strategy_set_15m_optimal_10usd_v3.json'),
        path.join(REPO_ROOT, 'strategies', 'strategy_set_15m_elite_recency.json'),
        path.join(REPO_ROOT, 'strategies', 'strategy_set_15m_24h_dense.json'),
        path.join(REPO_ROOT, 'strategies', 'strategy_set_15m_24h_filtered.json'),
        path.join(REPO_ROOT, 'strategies', 'strategy_set_15m_maxgrowth_v5.json'),
        path.join(REPO_ROOT, 'strategies', 'strategy_set_15m_maxgrowth_v4.json'),
        path.join(REPO_ROOT, 'strategies', 'strategy_set_15m_micro_recovery.json'),
        path.join(REPO_ROOT, 'strategies', 'strategy_set_15m_apr21_edge32.json'),
        path.join(REPO_ROOT, 'debug', 'strategy_set_15m_nc_beam_best_12.json'),
        path.join(REPO_ROOT, 'debug', 'strategy_set_top8_current.json'),
        path.join(REPO_ROOT, 'debug', 'strategy_set_top3_robust.json'),
        path.join(REPO_ROOT, 'debug', 'strategy_set_union_validated_top12_max95.json'),
    ];
    const candidates15m = env15mPath ? [env15mPath] : fallbackCandidates15m;

    return {
        nodeDirname: __dirname,
        repoRoot: REPO_ROOT,
        strategiesDirExists: fs.existsSync(path.join(REPO_ROOT, 'strategies')),
        debugDirExists: fs.existsSync(path.join(REPO_ROOT, 'debug')),
        env: {
            STRATEGY_SET_15M_PATH: envStrat15,
            START_PAUSED: process.env.START_PAUSED,
            TIMEFRAME_15M_ENABLED: process.env.TIMEFRAME_15M_ENABLED,
            TIMEFRAME_15M_MIN_BANKROLL: process.env.TIMEFRAME_15M_MIN_BANKROLL,
            ALLOW_MICRO_MPC_OVERRIDE: process.env.ALLOW_MICRO_MPC_OVERRIDE,
            EPOCH3_ALLOW_MICRO_MPC_OVERRIDE: process.env.EPOCH3_ALLOW_MICRO_MPC_OVERRIDE,
            ALLOW_MICRO_TIMEFRAME_OVERRIDE: process.env.ALLOW_MICRO_TIMEFRAME_OVERRIDE,
            EPOCH3_ALLOW_MICRO_TIMEFRAME_OVERRIDE: process.env.EPOCH3_ALLOW_MICRO_TIMEFRAME_OVERRIDE,
            MICRO_BANKROLL_ALLOW_5M: process.env.MICRO_BANKROLL_ALLOW_5M,
            MICRO_BANKROLL_ALLOW_4H: process.env.MICRO_BANKROLL_ALLOW_4H,
            MICRO_BANKROLL_MPC_CAP: process.env.MICRO_BANKROLL_MPC_CAP
        },
        candidates: {
            '15m': candidates15m.map(fp => ({
                filePath: fp,
                exists: fs.existsSync(fp)
            }))
        },
        loaded: getAllLoadedSets()
    };
}

function buildTradeFailureDetail(type, candidate, result, extra = {}) {
    return {
        ts: new Date().toISOString(),
        type,
        mode: CONFIG.TRADE_MODE,
        isLive: CONFIG.IS_LIVE,
        asset: candidate?.asset || null,
        timeframe: candidate?.timeframe || null,
        direction: candidate?.direction || null,
        entryPrice: candidate?.entryPrice ?? null,
        strategy: candidate?.name || null,
        success: !!result?.success,
        blocked: !!result?.blocked,
        nonRetryable: !!result?.nonRetryable,
        error: result?.error || null,
        clobFailure: result?.clobFailure || null,
        clobFailureSummary: result?.clobFailureSummary || null,
        orderID: result?.orderID || result?.orderId || null,
        consecutiveTradeFailures,
        threshold: TRADE_FAILURE_HALT_THRESHOLD,
        ...extra
    };
}

function recordTradeFailureDetail(type, candidate, result, extra = {}) {
    const detail = buildTradeFailureDetail(type, candidate, result, extra);
    lastTradeFailureDetail = detail;
    recentTradeFailureDetails.push(detail);
    if (recentTradeFailureDetails.length > 25) {
        recentTradeFailureDetails = recentTradeFailureDetails.slice(-25);
    }
    return detail;
}

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

function getRuntimeTimeframes() {
    const enabled = getEnabledTimeframes();
    if (enabled.length > 0) return enabled;
    return getConfiguredTimeframes();
}

function getLifecycleQueueStatus(executorStatus = null) {
    const status = executorStatus || tradeExecutor.getStatus();
    const recoveryQueue = Array.isArray(status.recoveryQueue) ? status.recoveryQueue : [];
    const redemptionQueue = Array.isArray(status.redemptionQueue) ? status.redemptionQueue : [];
    const recoveryQueueSummary = status.recoveryQueueSummary || {
        total: recoveryQueue.length,
        actionable: recoveryQueue.length,
        benign: 0
    };
    const redemptionQueueSummary = status.redemptionQueueSummary || {
        total: redemptionQueue.length,
        actionable: redemptionQueue.length,
        manualRequired: redemptionQueue.filter(item => !!item?.requiresManual).length,
        authBlocked: redemptionQueue.filter(item => String(item?.lastError || '').includes('PROXY_REDEEM_AUTH')).length,
        zeroVerified: redemptionQueue.filter(item => !!item?.zeroVerified).length
    };
    const clobStatus = tradeExecutor.clob?.getStatus?.() || null;
    const actionableRecoveryQueue = Number(recoveryQueueSummary.actionable || 0) > 0;
    const actionableRedemptionQueue = Number(redemptionQueueSummary.actionable || 0) > 0;
    const autoRedeemAuthReady = !!clobStatus?.proxyRedeemAuthReady;
    const reasons = [];
    if (actionableRecoveryQueue) reasons.push('ACTIONABLE_RECOVERY_QUEUE');
    if (actionableRedemptionQueue) reasons.push('ACTIONABLE_REDEMPTION_QUEUE');
    if (actionableRedemptionQueue && !autoRedeemAuthReady) reasons.push('PROXY_REDEEM_AUTH_NOT_READY');
    return {
        entriesBlocked: CONFIG.TRADE_MODE === 'LIVE' && (actionableRecoveryQueue || actionableRedemptionQueue),
        reasons,
        recoveryQueueSummary,
        redemptionQueueSummary,
        actionableRecoveryQueue,
        actionableRedemptionQueue,
        autoRedeemAuthReady,
        relayerAuthMode: clobStatus?.relayerAuthMode || null,
        relayerAuthConfigured: !!clobStatus?.relayerAuthConfigured,
        proxyRedeemAuthReady: !!clobStatus?.proxyRedeemAuthReady,
        proxyRedeemAuthDerivable: !!(clobStatus?.proxyRedeemAuthDerivable || clobStatus?.builderAutoDerivable),
        builderAutoDerivable: !!clobStatus?.builderAutoDerivable,
        lastBuilderDerive: clobStatus?.lastBuilderDerive || null
    };
}

function buildRuntimeStateSnapshot() {
    return {
        savedAt: new Date().toISOString(),
        runtimeMode: {
            tradeMode: CONFIG.TRADE_MODE,
            isLive: CONFIG.IS_LIVE,
            source: CONFIG.RUNTIME_MODE_SOURCE || 'env',
            updatedAt: CONFIG.RUNTIME_MODE_UPDATED_AT || null
        },
        risk: riskManager.exportState(),
        executor: tradeExecutor.exportState(),
        orchestratorHeartbeat,
        diagnosticLog: diagnosticLog.slice(-200)
    };
}

function recomputeRuntimeLiveFlag() {
    CONFIG.IS_LIVE = CONFIG.TRADE_MODE === 'LIVE' && CONFIG.ENABLE_LIVE_TRADING && CONFIG.LIVE_AUTOTRADING_ENABLED && !CONFIG.TELEGRAM.signalsOnly;
    return CONFIG.IS_LIVE;
}

function getLiveModeBlockers() {
    const blockers = [];
    if (CONFIG.TRADE_MODE !== 'LIVE') blockers.push('TRADE_MODE is not LIVE');
    if (!CONFIG.ENABLE_LIVE_TRADING) blockers.push('ENABLE_LIVE_TRADING is false');
    if (!CONFIG.LIVE_AUTOTRADING_ENABLED) blockers.push('LIVE_AUTOTRADING_ENABLED is false');
    if (CONFIG.TELEGRAM.signalsOnly) blockers.push('TELEGRAM_SIGNALS_ONLY is true');
    if (!CONFIG.POLYMARKET_PRIVATE_KEY) blockers.push('POLYMARKET_PRIVATE_KEY missing');
    return blockers;
}

async function switchRuntimeTradeMode(nextMode, options = {}) {
    const normalizedMode = String(nextMode || '').trim().toUpperCase();
    if (!['PAPER', 'LIVE'].includes(normalizedMode)) {
        throw new Error(`Unsupported trade mode: ${nextMode}`);
    }

    const previousMode = CONFIG.TRADE_MODE;
    CONFIG.TRADE_MODE = normalizedMode;
    process.env.TRADE_MODE = normalizedMode;
    recomputeRuntimeLiveFlag();
    CONFIG.RUNTIME_MODE_SOURCE = options.source || 'runtime';
    CONFIG.RUNTIME_MODE_UPDATED_AT = new Date().toISOString();
    tradeExecutor.mode = normalizedMode;

    if (normalizedMode === 'LIVE') {
        await tradeExecutor.refreshLiveBalance().catch((e) => {
            diagnosticLog.push({
                ts: new Date().toISOString(),
                type: 'LIVE_MODE_BALANCE_REFRESH_ERROR',
                error: e.message
            });
        });
    }

    // Safety invariant: mode switches never auto-start trading. The operator must inspect status, then resume explicitly.
    riskManager.tradingPaused = true;
    diagnosticLog.push({
        ts: new Date().toISOString(),
        type: 'RUNTIME_TRADE_MODE_SWITCH',
        previousMode,
        nextMode: normalizedMode,
        isLive: CONFIG.IS_LIVE,
        source: options.source || 'runtime',
        liveModeBlockers: getLiveModeBlockers()
    });
    await saveRuntimeState();
    return {
        previousMode,
        mode: CONFIG.TRADE_MODE,
        isLive: CONFIG.IS_LIVE,
        paused: riskManager.tradingPaused,
        source: CONFIG.RUNTIME_MODE_SOURCE,
        updatedAt: CONFIG.RUNTIME_MODE_UPDATED_AT,
        liveModeBlockers: getLiveModeBlockers()
    };
}

function applyRuntimeState(parsed, sourceLabel) {
    if (!parsed || typeof parsed !== 'object') return false;
    if (parsed.runtimeMode && typeof parsed.runtimeMode === 'object') {
        const restoredMode = String(parsed.runtimeMode.tradeMode || '').trim().toUpperCase();
        if (['PAPER', 'LIVE'].includes(restoredMode)) {
            CONFIG.TRADE_MODE = restoredMode;
            process.env.TRADE_MODE = restoredMode;
            CONFIG.RUNTIME_MODE_SOURCE = parsed.runtimeMode.source || sourceLabel || 'runtime_state';
            CONFIG.RUNTIME_MODE_UPDATED_AT = parsed.runtimeMode.updatedAt || parsed.savedAt || null;
            recomputeRuntimeLiveFlag();
        }
    }
    riskManager.importState(parsed.risk || {});
    tradeExecutor.importState(parsed.executor || {});
    tradeExecutor.mode = CONFIG.TRADE_MODE;
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

    // PRIMARY 15m strategy: Epoch3 V2 portfolio unless STRATEGY_SET_15M_PATH explicitly overrides it.
    //   Rationale: current README handoff marks Epoch3 V2 as the closest high-upside paper/smoke strategy.
    //   Render should still set STRATEGY_SET_15M_PATH explicitly so /api/debug/strategy-paths proves intent.
    // FIXED: Always honor explicit STRATEGY_SET_15M_PATH env var, even under micro-bankroll profile.
    // Previous code silently ignored the env var when STARTING_BALANCE <= $10, forcing combined_sub50c_tight fallback.
    const envStrat15 = process.env.STRATEGY_SET_15M_PATH || null;
    const env15mPath = envStrat15
        ? (path.isAbsolute(envStrat15) ? envStrat15 : path.join(REPO_ROOT, envStrat15))
        : null;
    const primary15mPath = path.join(REPO_ROOT, 'strategies', 'strategy_set_15m_epoch3v2_portfolio.json');
    const secondary15mPath = path.join(REPO_ROOT, 'strategies', 'strategy_set_15m_optimal_10usd_v3.json');
    const tertiary15mPath = path.join(REPO_ROOT, 'strategies', 'strategy_set_15m_elite_recency.json');
    const quaternary15mPath = path.join(REPO_ROOT, 'strategies', 'strategy_set_15m_24h_dense.json');
    const quinary15mPath = path.join(REPO_ROOT, 'strategies', 'strategy_set_15m_24h_filtered.json');
    const senary15mPath = path.join(REPO_ROOT, 'strategies', 'strategy_set_15m_maxgrowth_v5.json');

    for (const tf of getConfiguredTimeframes()) {
        let loaded = false;

        if (tf.key === '15m') {
            const fallbackCandidates15m = [
                primary15mPath,
                secondary15mPath,
                tertiary15mPath,
                quaternary15mPath,
                quinary15mPath,
                senary15mPath,
                path.join(REPO_ROOT, 'strategies', 'strategy_set_15m_maxgrowth_v4.json'),
                path.join(REPO_ROOT, 'strategies', 'strategy_set_15m_micro_recovery.json'),
                path.join(REPO_ROOT, 'strategies', 'strategy_set_15m_apr21_edge32.json'),
                path.join(REPO_ROOT, 'debug', 'strategy_set_15m_nc_beam_best_12.json'),
                path.join(REPO_ROOT, 'debug', 'strategy_set_top8_current.json'),
                path.join(REPO_ROOT, 'debug', 'strategy_set_top3_robust.json'),
                path.join(REPO_ROOT, 'debug', 'strategy_set_union_validated_top12_max95.json'),
            ];
            const candidates15m = env15mPath ? [env15mPath] : fallbackCandidates15m;
            for (const fp of candidates15m) {
                const exists = fs.existsSync(fp);
                console.log(`  📂 15m candidate: ${path.basename(fp)} → ${exists ? 'EXISTS' : 'NOT_FOUND'}`);
                if (exists && !loaded) {
                    loadStrategySet('15m', fp);
                    loaded = true;
                    diagnosticLog.push({
                        ts: new Date().toISOString(),
                        type: 'STRATEGY_LOADED',
                        timeframe: '15m',
                        filePath: fp
                    });
                    console.log(`  ✅ 15m LOADED: ${path.basename(fp)}`);
                    break;
                }
            }
            if (!loaded) {
                if (env15mPath) {
                    console.error(`  ❌ 15m: STRATEGY_SET_15M_PATH requested ${path.basename(env15mPath)} but the file is missing. Refusing silent fallback.`);
                    diagnosticLog.push({
                        ts: new Date().toISOString(),
                        type: 'STRATEGY_FILE_MISSING',
                        timeframe: '15m',
                        filePath: env15mPath
                    });
                }
                console.warn('  ⚠️ 15m: NO strategy file found! Trading will not work for 15m.');
                diagnosticLog.push({
                    ts: new Date().toISOString(),
                    type: 'NO_STRATEGY_FILE_FOUND',
                    timeframe: '15m',
                    candidates: candidates15m.map(fp => ({ filePath: fp, exists: fs.existsSync(fp) }))
                });
            }
            continue;
        }

        // Other timeframes: use env var or built-in candidates
        const envKey = `STRATEGY_SET_${String(tf.key || '').toUpperCase().replace(/[^A-Z0-9]/g, '')}_PATH`;
        const envPath = process.env[envKey] || null;
        const candidates = [
            ...(envPath ? [path.isAbsolute(envPath) ? envPath : path.join(REPO_ROOT, envPath)] : []),
            ...(tf.key === '4h' ? [
                path.join(REPO_ROOT, 'debug', 'strategy_set_4h_maxprofit.json'),
                path.join(REPO_ROOT, 'debug', 'strategy_set_4h_curated.json')
            ] : []),
            ...(tf.key === '5m' ? [
                path.join(REPO_ROOT, 'debug', 'strategy_set_5m_walkforward_top4.json'),
                path.join(REPO_ROOT, 'debug', 'strategy_set_5m_exact_b20.json'),
                path.join(REPO_ROOT, 'debug', 'strategy_set_5m_maxprofit.json')
            ] : []),
            path.join(strategiesDir, `strategy_set_${tf.key}_top8.json`),
            path.join(strategiesDir, `strategy_set_${tf.key}_top5.json`),
            path.join(strategiesDir, `strategy_set_${tf.key}.json`),
        ];
        for (const fp of [...new Set(candidates)]) {
            if (fs.existsSync(fp) && !loaded) {
                loadStrategySet(tf.key, fp);
                loaded = true;
                diagnosticLog.push({
                    ts: new Date().toISOString(),
                    type: 'STRATEGY_LOADED',
                    timeframe: tf.key,
                    filePath: fp
                });
                break;
            }
        }
    }
}

loadAllStrategySets();

app.get('/api/debug/strategy-paths', (req, res) => {
    res.json(buildStrategyPathDebug());
});

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
            const pos = tradeExecutor.positions.find(pos => pos.id === p.id);
            if (!pos || pos.status !== 'PENDING_RESOLUTION') continue;
            const linkedPendingBuy = tradeExecutor.findPendingBuyByPositionId?.(p.id)?.pendingBuy || null;
            const tokenId = pos.tokenId || linkedPendingBuy?.tokenId || null;
            const conditionId = pos.conditionId || linkedPendingBuy?.conditionId || null;
            const holderAddress = pos.funderAddress
                || linkedPendingBuy?.funderAddress
                || tradeExecutor.clob?.getStatus?.()?.tradeReady?.selected?.funderAddress
                || null;
            const staleAgeMs = Date.now() - Number(pos.pendingSince || Date.now());
            const pendingAutoRecoveryThresholdMs = pos.timeframe === '4h' ? (2 * 60 * 60 * 1000) : (10 * 60 * 1000);
            const recoveryEligiblePending = !!p.stalePending || staleAgeMs > pendingAutoRecoveryThresholdMs;
            const recoveryReasonPrefix = p.stalePending ? 'STALE_PENDING' : (recoveryEligiblePending ? 'STUCK_PENDING' : 'PENDING');
            const forceManualRecovery = staleAgeMs > (24 * 60 * 60 * 1000);

            if (p.stalePending && forceManualRecovery) {
                const recovery = tradeExecutor.markPositionForRecovery(p.id, {
                    reason: 'STALE_PENDING_MAX_AGE_EXCEEDED',
                    holderAddress,
                    tokenBalance: null,
                    zeroVerified: false,
                    redeemQueued: false,
                    lastError: tokenId ? 'STALE_PENDING_AUTO_RECOVERY_EXPIRED' : 'STALE_PENDING_METADATA_MISSING',
                    notes: 'Auto-promoted to manual recovery after remaining stale pending for more than 24h'
                });

                if (recovery) {
                    diagnosticLog.push({
                        ts: new Date().toISOString(),
                        type: 'STALE_PENDING_MAX_AGE_MANUAL_RECOVERY',
                        asset: pos.asset,
                        timeframe: pos.timeframe,
                        direction: pos.direction,
                        slug: p.slug,
                        tokenId,
                        conditionId,
                        holderAddress,
                        staleAgeMs
                    });
                }
                continue;
            }

            const market = await fetchMarketBySlug(p.slug);
            const winner = extractWinnerFromClosedMarket(market);
            if (!winner) {
                if (recoveryEligiblePending && !tokenId && (forceManualRecovery || !p.stalePending)) {
                    const recovery = tradeExecutor.markPositionForRecovery(p.id, {
                        reason: `${recoveryReasonPrefix}_MISSING_MARKET_METADATA`,
                        holderAddress,
                        tokenBalance: null,
                        zeroVerified: false,
                        redeemQueued: false,
                        lastError: market ? 'TOKEN_METADATA_UNAVAILABLE' : 'MARKET_NOT_FOUND',
                        notes: market
                            ? `Auto-promoted to manual recovery after pending settlement exceeded the ${Math.round(pendingAutoRecoveryThresholdMs / 60000)}m auto-recovery window without token metadata`
                            : `Auto-promoted to manual recovery after pending settlement exceeded the ${Math.round(pendingAutoRecoveryThresholdMs / 60000)}m auto-recovery window because Gamma market slug no longer resolves and no token metadata remains`
                    });

                    if (recovery) {
                        diagnosticLog.push({
                            ts: new Date().toISOString(),
                            type: `${recoveryReasonPrefix}_MISSING_METADATA_MANUAL_RECOVERY`,
                            asset: pos.asset,
                            timeframe: pos.timeframe,
                            direction: pos.direction,
                            slug: p.slug,
                            tokenId: null,
                            conditionId,
                            holderAddress,
                            error: market ? 'TOKEN_METADATA_UNAVAILABLE' : 'MARKET_NOT_FOUND'
                        });
                    }
                    continue;
                }
                if (!recoveryEligiblePending || !tokenId) continue;

                const balanceCheck = await Promise.race([
                    tradeExecutor.clob.getTokenBalanceAcrossHolders(
                        tokenId,
                        holderAddress
                    ),
                    new Promise((resolve) => setTimeout(() => resolve({
                        success: false,
                        error: 'TOKEN_BALANCE_TIMEOUT',
                        balance: 0,
                        zeroVerified: false
                    }), 10000))
                ]).catch((e) => ({ success: false, error: e.message, balance: 0, zeroVerified: false }));

                const verifiable = !!balanceCheck?.success || !!balanceCheck?.zeroVerified;
                if (!verifiable) {
                    const recovery = tradeExecutor.markPositionForRecovery(p.id, {
                        reason: `${recoveryReasonPrefix}_UNVERIFIABLE_BALANCE`,
                        holderAddress,
                        tokenBalance: null,
                        zeroVerified: false,
                        redeemQueued: false,
                        lastError: balanceCheck?.error || 'TOKEN_BALANCE_UNVERIFIABLE',
                        notes: `Auto-promoted to manual recovery after pending settlement exceeded the ${Math.round(pendingAutoRecoveryThresholdMs / 60000)}m auto-recovery window without a verifiable token-balance proof`
                    });

                    if (recovery) {
                        diagnosticLog.push({
                            ts: new Date().toISOString(),
                            type: `${recoveryReasonPrefix}_FORCED_MANUAL_RECOVERY`,
                            asset: pos.asset,
                            timeframe: pos.timeframe,
                            direction: pos.direction,
                            slug: p.slug,
                            tokenId,
                            conditionId,
                            holderAddress,
                            error: balanceCheck?.error || 'TOKEN_BALANCE_UNVERIFIABLE'
                        });
                    }
                    continue;
                }

                let redeemQueued = false;
                const tokenBalance = Number(balanceCheck?.balance || 0);
                const resolvedHolderAddress = balanceCheck?.address || holderAddress;
                if (tokenBalance > 0 && conditionId) {
                    tradeExecutor.addToRedemptionQueue({
                        ...pos,
                        tokenId,
                        conditionId,
                        shares: tokenBalance,
                        holderAddress: resolvedHolderAddress,
                        funderAddress: resolvedHolderAddress
                    });
                    redeemQueued = true;
                }

                const recovery = tradeExecutor.markPositionForRecovery(p.id, {
                    reason: `${recoveryReasonPrefix}_UNRESOLVED_SLUG`,
                    holderAddress: resolvedHolderAddress,
                    tokenBalance,
                    zeroVerified: !!balanceCheck?.zeroVerified,
                    redeemQueued,
                    lastError: balanceCheck?.success ? null : (balanceCheck?.error || null),
                    notes: redeemQueued
                        ? 'Queued redemption after stale slug reconciliation failed'
                        : (balanceCheck?.zeroVerified ? 'Zero token balance verified after stale slug reconciliation failed' : 'Manual recovery required after stale slug reconciliation failed')
                });

                if (recovery) {
                    diagnosticLog.push({
                        ts: new Date().toISOString(),
                        type: `${recoveryReasonPrefix}_MANUAL_RECOVERY`,
                        asset: pos.asset,
                        timeframe: pos.timeframe,
                        direction: pos.direction,
                        slug: p.slug,
                        tokenId,
                        conditionId,
                        holderAddress: resolvedHolderAddress,
                        tokenBalance,
                        zeroVerified: !!balanceCheck?.zeroVerified,
                        redeemQueued,
                        error: balanceCheck?.success ? null : (balanceCheck?.error || null)
                    });
                }
                continue;
            }

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
        const liveSettlements = await Promise.race([
            reconcilePendingLivePositions(),
            balanceTimeout(15000).catch(() => [])
        ]).catch(() => []);
        if ((liveSettlements || []).length > 0) {
            diagnosticLog.push({
                ts: new Date().toISOString(),
                type: 'LIVE_SETTLEMENT_MAINTENANCE',
                settled: liveSettlements.length
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

        const lifecycleQueueStatus = getLifecycleQueueStatus();
        if (tradeFailureHalted) {
            console.warn(`🛑 TRADE FAILURE HALT active — skipping ${allCandidates.length} candidate(s) until POST /api/resume-errors`);
        } else if (lifecycleQueueStatus.entriesBlocked) {
            const fingerprint = lifecycleQueueStatus.reasons.join('|');
            if (fingerprint !== lastLifecycleSuppressionFingerprint || (Date.now() - lastLifecycleSuppressionLogAt) > 60000) {
                lastLifecycleSuppressionFingerprint = fingerprint;
                lastLifecycleSuppressionLogAt = Date.now();
                diagnosticLog.push({
                    ts: new Date().toISOString(),
                    type: 'LIFECYCLE_QUEUE_SUPPRESSION',
                    candidatesSuppressed: allCandidates.length,
                    reasons: lifecycleQueueStatus.reasons,
                    recoveryQueueSummary: lifecycleQueueStatus.recoveryQueueSummary,
                    redemptionQueueSummary: lifecycleQueueStatus.redemptionQueueSummary,
                    autoRedeemAuthReady: lifecycleQueueStatus.autoRedeemAuthReady,
                    relayerAuthMode: lifecycleQueueStatus.relayerAuthMode
                });
            }
            console.warn(`🛑 Lifecycle queue suppression active — skipping ${allCandidates.length} candidate(s): ${lifecycleQueueStatus.reasons.join(', ')}`);
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
                    const blockedDetail = buildTradeFailureDetail('BLOCKED', candidate, result, {
                        reason: result.error,
                        consecutiveTradeFailures
                    });
                    const blockedReason = String(result.error || '');
                    const shouldPreserveBlockedFailure = !!result.nonRetryable || isCountableTradeFailure(result) ||
                        blockedReason.includes('CLOB_ORDER_ENDPOINT_GEOBLOCKED') ||
                        blockedReason.includes('NON_RETRYABLE_CLOB_GEOBLOCK');
                    if (shouldPreserveBlockedFailure) {
                        lastTradeFailureDetail = blockedDetail;
                        recentTradeFailureDetails.push(blockedDetail);
                        if (recentTradeFailureDetails.length > 25) {
                            recentTradeFailureDetails = recentTradeFailureDetails.slice(-25);
                        }
                    }
                    diagnosticLog.push(blockedDetail);
                    if (result.nonRetryable || String(result.error || '').includes('CLOB_ORDER_ENDPOINT_GEOBLOCKED') || String(result.error || '').includes('NON_RETRYABLE_CLOB_GEOBLOCK')) {
                        tradeFailureHalted = true;
                        consecutiveTradeFailures = TRADE_FAILURE_HALT_THRESHOLD;
                        lastTradeFailureAt = Date.now();
                        const haltDetail = recordTradeFailureDetail('TRADE_FAILURE_HALT', candidate, result, {
                            lastError: result.error,
                            reason: result.error,
                            consecutiveTradeFailures,
                            nonRetryable: true
                        });
                        diagnosticLog.push(haltDetail);
                        break;
                    }
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

                    const failureDetail = recordTradeFailureDetail(pendingBuyOpen ? 'PENDING_BUY_OPEN' : 'TRADE_FAILED', candidate, result, {
                        reason: result.error,
                        consecutiveTradeFailures
                    });
                    diagnosticLog.push(failureDetail);

                    if (!pendingBuyOpen && consecutiveTradeFailures >= TRADE_FAILURE_HALT_THRESHOLD) {
                        tradeFailureHalted = true;
                        console.error(`🛑 TRADE FAILURE HALT: ${consecutiveTradeFailures} consecutive live trade failures — automated entries paused. POST /api/resume-errors to recover.`);
                        const haltDetail = recordTradeFailureDetail('TRADE_FAILURE_HALT', candidate, result, {
                            lastError: result.error,
                            reason: result.error,
                            consecutiveTradeFailures
                        });
                        diagnosticLog.push(haltDetail);
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
    const paperSettlements = await resolvePendingPaperPositions();

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

    if (paperSettlements.resolved > 0 || liveSettlements.length > 0 || pendingSellResults.closed > 0 || redemptionResults.redeemed > 0) {
        diagnosticLog.push({
            ts: new Date().toISOString(),
            type: 'LIFECYCLE_MAINTENANCE',
            paperSettlementsResolved: paperSettlements.resolved || 0,
            paperSettlementsRemaining: paperSettlements.remaining || 0,
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

    // Runtime notifications (deposit, peak, cooldown, halt transitions)
    try { emitRuntimeTelegramEvents(); } catch (e) { console.log(`⚠️ runtime-tg error: ${e.message}`); }

    // Strategy validator + daily summary + heartbeat crons
    try { maybeRunStrategyValidator(); } catch (e) { console.log(`⚠️ validator error: ${e.message}`); }
    try { maybeSendDailySummary(); } catch (e) { console.log(`⚠️ daily-summary error: ${e.message}`); }
    try { maybeSendHeartbeatPing(); } catch (e) { console.log(`⚠️ heartbeat error: ${e.message}`); }

    // Periodic heartbeat log (every 60s)
    if (nowSec - lastOrchestrationTime >= 60) {
        lastOrchestrationTime = nowSec;
        const utcHour = new Date().getUTCHours();
        const utcMin = new Date().getUTCMinutes();
        console.log(`📡 HEARTBEAT ${utcHour}:${String(utcMin).padStart(2,'0')} | Markets: ${marketsChecked}/${Object.keys(currentMarkets).length} active | Candidates: ${candidatesFound} | Trades: ${tradesAttempted} | Balance: $${riskManager.bankroll.toFixed(2)}`);
    }
}

async function resolvePendingPaperPositions() {
    if (CONFIG.TRADE_MODE === 'PAPER') {
        const queuedIds = new Set((tradeExecutor.pendingRedemptions || []).map((p) => p?.positionId).filter(Boolean));
        const pendingPositions = tradeExecutor.getPendingSettlements()
            .filter((pos) => !pos.isLive && pos.status === 'PENDING_RESOLUTION');
        for (const pos of pendingPositions) {
            if (queuedIds.has(pos.id)) continue;
            tradeExecutor.pendingRedemptions.push({
                positionId: pos.id,
                slug: pos.slug,
                asset: pos.asset,
                timeframe: pos.timeframe,
                direction: pos.direction,
                queuedAt: new Date().toISOString(),
                source: 'PAPER_PENDING_RECONCILIATION'
            });
            queuedIds.add(pos.id);
        }
    }

    const pending = [...tradeExecutor.pendingRedemptions];
    tradeExecutor.pendingRedemptions = [];
    let resolved = 0;
    let requeued = 0;

    for (const p of pending) {
        try {
            if (!p?.slug || !p?.positionId) {
                requeued++;
                continue;
            }
            const market = await fetchMarketBySlug(p.slug);
            if (!market || !market.closed) {
                tradeExecutor.pendingRedemptions.push(p);
                requeued++;
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
                        resolved++;
                    }
                }
            } else {
                tradeExecutor.pendingRedemptions.push(p);
                requeued++;
            }
        } catch {
            tradeExecutor.pendingRedemptions.push(p);
            requeued++;
        }
    }

    const reconFingerprint = `${pending.length}|${resolved}|${requeued}|${tradeExecutor.pendingRedemptions.length}`;
    const shouldLogPaperRecon = resolved > 0 || (
        requeued > 0 && (
            reconFingerprint !== lastPaperSettlementReconFingerprint ||
            (Date.now() - lastPaperSettlementReconLogAt) > 10 * 60 * 1000
        )
    );
    if (shouldLogPaperRecon) {
        lastPaperSettlementReconLogAt = Date.now();
        lastPaperSettlementReconFingerprint = reconFingerprint;
        diagnosticLog.push({
            ts: new Date().toISOString(),
            type: 'PAPER_SETTLEMENT_RECONCILIATION',
            processed: pending.length,
            resolved,
            requeued,
            remaining: tradeExecutor.pendingRedemptions.length
        });
    }

    return { processed: pending.length, resolved, requeued, remaining: tradeExecutor.pendingRedemptions.length };
}

// ==================== TELEGRAM + VALIDATOR HELPERS ====================
function getActiveStrategyFilePaths() {
    const sets = (typeof getAllLoadedSets === 'function') ? (getAllLoadedSets() || {}) : {};
    const out = [];
    for (const key of Object.keys(sets)) {
        const s = sets[key];
        if (!s) continue;
        const candidate = s.filePath || s.path || s.file || s.absolutePath;
        if (candidate) out.push(candidate);
    }
    return out;
}

function getHaltsSnapshot() {
    return { errorHalt: !!errorHalted, tradeFailureHalt: !!tradeFailureHalted };
}

function clearAllHalts() {
    errorHalted = false;
    consecutiveTickErrors = 0;
    tradeFailureHalted = false;
    consecutiveTradeFailures = 0;
    lastTradeFailureAt = 0;
    diagnosticLog.push({ ts: new Date().toISOString(), type: 'HALT_CLEARED_RUNTIME' });
}

function getUpcomingWindowsForTelegram(hoursAhead = 6) {
    // Cache for 5 minutes to avoid recomputation
    if (cachedBestWindows && (Date.now() - cachedBestWindowsAt) < 5 * 60 * 1000) {
        return cachedBestWindows;
    }
    const sets = (typeof getAllLoadedSets === 'function') ? (getAllLoadedSets() || {}) : {};
    const tf15 = sets['15m'] || sets.fifteen || null;
    if (!tf15 || !Array.isArray(tf15.strategies)) return [];
    const now = new Date();
    const out = [];
    for (let i = 0; i < hoursAhead; i++) {
        const slot = new Date(now.getTime() + i * 3600 * 1000);
        const hour = slot.getUTCHours();
        const strats = tf15.strategies.filter((s) => s.utcHour === hour);
        for (const s of strats) {
            const entry = new Date(slot);
            entry.setUTCMinutes(Number(s.entryMinute || 0), 0, 0);
            if (entry.getTime() < now.getTime()) continue;
            const oosWr = Number(s.stats?.oos?.wr ?? s.pWinEstimate ?? s.winRate ?? 0);
            out.push({
                timeIso: entry.toISOString().slice(11, 16) + 'Z',
                tier: s.tier || '?',
                oosWr,
                trades: Number(s.stats?.oos?.trades ?? s.stats?.full?.trades ?? 0),
                asset: s.asset === 'all' ? 'any' : s.asset,
                direction: s.direction
            });
        }
    }
    out.sort((a, b) => b.oosWr - a.oosWr);
    cachedBestWindows = out.slice(0, 24);
    cachedBestWindowsAt = Date.now();
    return cachedBestWindows;
}

function emitRuntimeTelegramEvents() {
    // Deposit / withdrawal detection (significant balance change with no open positions)
    const execStatus = tradeExecutor.getStatus();
    const liveBal = Number(execStatus.liveBalance ?? execStatus.paperBalance ?? riskManager.bankroll ?? 0);
    if (!lastKnownBankroll) lastKnownBankroll = liveBal;
    const delta = liveBal - lastKnownBankroll;
    if (Math.abs(delta) >= 0.5 && execStatus.openPositions === 0) {
        telegram.notifyDepositDetected({
            delta,
            previousBalance: lastKnownBankroll,
            newBalance: liveBal
        });
        lastKnownBankroll = liveBal;
    } else {
        lastKnownBankroll = liveBal;
    }

    // New peak balance (only when it truly grows, not after deposit rebase)
    const peak = Number(riskManager.peakBalance || 0);
    if (peak > 0 && lastKnownPeakBalance > 0 && peak > lastKnownPeakBalance + 0.01) {
        telegram.notifyPeakBalance({ peak, previousPeak: lastKnownPeakBalance });
    }
    lastKnownPeakBalance = peak;

    // Cooldown transition
    const inCooldown = !!(riskManager.cooldownUntil && Date.now() < riskManager.cooldownUntil);
    if (inCooldown && !lastCooldownActive) {
        telegram.notifyCooldownHit({
            consecutiveLosses: Number(riskManager.consecutiveLosses || 0),
            cooldownSeconds: Math.max(0, (riskManager.cooldownUntil - Date.now()) / 1000),
            bankroll: Number(riskManager.bankroll || 0)
        });
    }
    lastCooldownActive = inCooldown;

    // Halt transitions
    if (errorHalted && !lastHaltStates.errorHalt) {
        telegram.notifyHaltTriggered({
            kind: 'ERROR_HALT',
            reason: `${consecutiveTickErrors} consecutive tick errors`,
            count: consecutiveTickErrors,
            threshold: ERROR_HALT_THRESHOLD
        });
    } else if (!errorHalted && lastHaltStates.errorHalt) {
        telegram.notifyHaltResumed({ source: 'error_halt_cleared' });
    }
    if (tradeFailureHalted && !lastHaltStates.tradeFailureHalt) {
        telegram.notifyHaltTriggered({
            kind: 'TRADE_FAILURE_HALT',
            reason: `${consecutiveTradeFailures} consecutive trade failures`,
            count: consecutiveTradeFailures,
            threshold: TRADE_FAILURE_HALT_THRESHOLD
        });
    } else if (!tradeFailureHalted && lastHaltStates.tradeFailureHalt) {
        telegram.notifyHaltResumed({ source: 'trade_failure_halt_cleared' });
    }
    lastHaltStates = { errorHalt: errorHalted, tradeFailureHalt: tradeFailureHalted };
}

function maybeRunStrategyValidator() {
    if (!CONFIG.STRATEGY_VALIDATOR?.enabled) return;
    strategyValidator.maybeRunCheck({
        risk: riskManager.getStatus(),
        executor: tradeExecutor.getStatus(),
        activeStrategyFiles: getActiveStrategyFilePaths(),
        deployInfo: { deployVersion: DEPLOY_VERSION, mode: CONFIG.TRADE_MODE, isLive: CONFIG.IS_LIVE }
    });
}

function maybeSendDailySummary() {
    const cfg = CONFIG.TELEGRAM || {};
    if (!cfg.enabled) return;
    const now = new Date();
    const hour = now.getUTCHours();
    const minute = now.getUTCMinutes();
    const targetHour = Number(cfg.dailySummaryUtcHour ?? 0);
    const targetMinute = Number(cfg.dailySummaryUtcMinute ?? 5);
    const hitWindow = hour === targetHour && minute >= targetMinute && minute < targetMinute + 3;
    if (!hitWindow) return;
    if (lastDailySummaryAt && (Date.now() - lastDailySummaryAt) < 22 * 3600 * 1000) return;
    lastDailySummaryAt = Date.now();
    telegram.notifyDailySummary(riskManager.getStatus());
}

function maybeSendHeartbeatPing() {
    const cfg = CONFIG.TELEGRAM || {};
    const minutes = Number(cfg.heartbeatIntervalMinutes || 0);
    if (!minutes || minutes <= 0) return;
    if (lastHeartbeatPingAt && (Date.now() - lastHeartbeatPingAt) < minutes * 60 * 1000) return;
    lastHeartbeatPingAt = Date.now();
    const risk = riskManager.getStatus();
    telegram.sendMessage(
        `💓 <b>HEARTBEAT</b>\nBal: $${Number(risk.bankroll || 0).toFixed(2)} | Trades: ${risk.totalTrades} | WR: ${risk.winRate}%`,
        telegram.PRIORITY.LOW,
        { allowDuplicate: true }
    );
}

// ==================== API ENDPOINTS ====================
app.get('/api/health', (req, res) => {
    const uptime = (Date.now() - startupTime) / 1000;
    const executorStatus = tradeExecutor.getStatus();
    const riskStatus = riskManager.getStatus();
    const activeTimeframes = getEnabledTimeframes();
    const runtimeBankrollForTimeframes = getRuntimeBankrollForTimeframes();
    const telegramState = telegram.getQueueState();
    const currentTierProfile = typeof riskManager._getTierProfile === 'function'
        ? riskManager._getTierProfile(runtimeBankrollForTimeframes)
        : null;
    const hasPendingSettlements = executorStatus.pendingSettlements.length > 0;
    const recoveryQueueSummary = executorStatus.recoveryQueueSummary || { total: executorStatus.recoveryQueue.length, actionable: executorStatus.recoveryQueue.length, benign: 0 };
    const lifecycleQueueStatus = getLifecycleQueueStatus(executorStatus);
    const hasRecoveryQueue = Number(recoveryQueueSummary.actionable || 0) > 0;
    const hasRedemptionQueue = lifecycleQueueStatus.actionableRedemptionQueue;
    const hasPendingBuys = executorStatus.pendingBuys.length > 0;
    const hasPendingSells = executorStatus.pendingSells.length > 0;
    const isManuallyPaused = !!riskStatus.tradingPaused;
    const isDegraded = isManuallyPaused || errorHalted || tradeFailureHalted || hasPendingSettlements || hasRecoveryQueue || hasRedemptionQueue || hasPendingBuys || hasPendingSells;
    res.json({
        status: isDegraded ? 'degraded' : 'ok',
        version: 'polyprophet-lite-1.0.0',
        deployVersion: DEPLOY_VERSION,
        startedAt: new Date(startupTime).toISOString(),
        uptime,
        mode: CONFIG.TRADE_MODE,
        isLive: CONFIG.IS_LIVE,
        runtimeMode: {
            mode: CONFIG.TRADE_MODE,
            isLive: CONFIG.IS_LIVE,
            source: CONFIG.RUNTIME_MODE_SOURCE || 'env',
            updatedAt: CONFIG.RUNTIME_MODE_UPDATED_AT || null,
            liveModeBlockers: getLiveModeBlockers()
        },
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
        recoveryQueue: executorStatus.recoveryQueue.length,
        recoveryQueueSummary,
        redemptionQueue: executorStatus.redemptionQueue.length,
        redemptionQueueSummary: lifecycleQueueStatus.redemptionQueueSummary,
        redemptionReadiness: lifecycleQueueStatus,
        telegram: telegramState,
        runtimeState: getRuntimeStateStatus(),
        errorHalt: { halted: errorHalted, consecutiveErrors: consecutiveTickErrors, threshold: ERROR_HALT_THRESHOLD },
        tradeFailureHalt: {
            halted: tradeFailureHalted,
            consecutiveFailures: consecutiveTradeFailures,
            threshold: TRADE_FAILURE_HALT_THRESHOLD,
            windowMinutes: TRADE_FAILURE_WINDOW_MS / 60000,
            lastFailure: lastTradeFailureDetail,
            recentFailures: recentTradeFailureDetails.slice(-10)
        },
        tradingSuppression: {
            manualPause: isManuallyPaused,
            inCooldown: !!riskStatus.inCooldown,
            pendingBuys: hasPendingBuys,
            pendingSells: hasPendingSells,
            pendingSettlements: hasPendingSettlements,
            recoveryQueue: hasRecoveryQueue,
            redemptionQueue: hasRedemptionQueue,
            actionableRecoveryQueue: Number(recoveryQueueSummary.actionable || 0) > 0,
            actionableRedemptionQueue: hasRedemptionQueue,
            benignRecoveryQueue: Number(recoveryQueueSummary.benign || 0) > 0,
            proxyRedeemAuthReady: lifecycleQueueStatus.proxyRedeemAuthReady
        },
        riskControls: {
            microBankrollDeployProfile: !!CONFIG.MICRO_BANKROLL_DEPLOY_PROFILE,
            microBankrollAllowMpcOverride: !!CONFIG.MICRO_BANKROLL_ALLOW_MPC_OVERRIDE,
            microBankrollAllow5m: !!CONFIG.MICRO_BANKROLL_ALLOW_5M,
            microBankrollAllow4h: !!CONFIG.MICRO_BANKROLL_ALLOW_4H,
            requireRealOrderBook: !!CONFIG.RISK.requireRealOrderBook,
            enforceNetEdgeGate: !!CONFIG.RISK.enforceNetEdgeGate,
            enforceHighPriceEdgeFloor: !!CONFIG.RISK.enforceHighPriceEdgeFloor,
            highPriceEdgeFloorPrice: Number(CONFIG.RISK.highPriceEdgeFloorPrice || 0),
            minNetEdgeRoi: Number(CONFIG.RISK.minNetEdgeRoi || 0),
            minBalanceFloor: Number(CONFIG.RISK.minBalanceFloor || 0),
            minOrderShares: Number(CONFIG.RISK.minOrderShares || 0),
            entryPriceBufferCents: Number(CONFIG.RISK.entryPriceBufferCents || 0),
            maxGlobalTradesPerCycle: Number(CONFIG.RISK.maxGlobalTradesPerCycle || 0),
            microBankrollMpcCap: Number(CONFIG.RISK.microBankrollMpcCap || 0),
            maxTotalExposure: Number(CONFIG.RISK.maxTotalExposure || 0),
            maxTotalExposureMinBankroll: Number(CONFIG.RISK.maxTotalExposureMinBankroll || 0),
            riskEnvelopeEnabled: !!CONFIG.RISK.riskEnvelopeEnabled,
            riskEnvelopeMinBankroll: Number(CONFIG.RISK.riskEnvelopeMinBankroll || 0),
            currentTierProfile,
            drawdownBrake: riskStatus.drawdownBrake || null,
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
    const riskStatus = riskManager.getStatus();
    const executorStatus = tradeExecutor.getStatus();
    const telegramState = telegram.getQueueState();
    const hasPendingSettlements = executorStatus.pendingSettlements.length > 0;
    const recoveryQueueSummary = executorStatus.recoveryQueueSummary || { total: executorStatus.recoveryQueue.length, actionable: executorStatus.recoveryQueue.length, benign: 0 };
    const lifecycleQueueStatus = getLifecycleQueueStatus(executorStatus);
    const hasRecoveryQueue = Number(recoveryQueueSummary.actionable || 0) > 0;
    const hasRedemptionQueue = lifecycleQueueStatus.actionableRedemptionQueue;
    const hasPendingBuys = executorStatus.pendingBuys.length > 0;
    const hasPendingSells = executorStatus.pendingSells.length > 0;
    const isManuallyPaused = !!riskStatus.tradingPaused;
    const isDegraded = isManuallyPaused || errorHalted || tradeFailureHalted || hasPendingSettlements || hasRecoveryQueue || hasRedemptionQueue || hasPendingBuys || hasPendingSells;
    res.json({
        status: isDegraded ? 'degraded' : 'ok',
        mode: CONFIG.TRADE_MODE,
        isLive: CONFIG.IS_LIVE,
        runtimeMode: {
            mode: CONFIG.TRADE_MODE,
            isLive: CONFIG.IS_LIVE,
            source: CONFIG.RUNTIME_MODE_SOURCE || 'env',
            updatedAt: CONFIG.RUNTIME_MODE_UPDATED_AT || null,
            liveModeBlockers: getLiveModeBlockers()
        },
        risk: riskStatus,
        executor: executorStatus,
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
        telegram: telegramState,
        strategies: getAllLoadedSets(),
        runtimeState: getRuntimeStateStatus(),
        tradingSuppression: {
            manualPause: isManuallyPaused,
            inCooldown: !!riskStatus.inCooldown,
            pendingBuys: hasPendingBuys,
            pendingSells: hasPendingSells,
            pendingSettlements: hasPendingSettlements,
            recoveryQueue: hasRecoveryQueue,
            redemptionQueue: hasRedemptionQueue,
            actionableRecoveryQueue: Number(recoveryQueueSummary.actionable || 0) > 0,
            actionableRedemptionQueue: hasRedemptionQueue,
            benignRecoveryQueue: Number(recoveryQueueSummary.benign || 0) > 0,
            proxyRedeemAuthReady: lifecycleQueueStatus.proxyRedeemAuthReady
        },
        degradedSummary: {
            recoveryQueue: executorStatus.recoveryQueue.length,
            recoveryQueueSummary,
            redemptionQueue: executorStatus.redemptionQueue.length,
            redemptionQueueSummary: lifecycleQueueStatus.redemptionQueueSummary,
            redemptionReadiness: lifecycleQueueStatus,
            manualPause: isManuallyPaused,
            inCooldown: !!riskStatus.inCooldown,
            pendingBuys: hasPendingBuys,
            pendingSells: hasPendingSells,
            pendingSettlements: hasPendingSettlements
        },
        errorHalt: { halted: errorHalted, consecutiveErrors: consecutiveTickErrors, threshold: ERROR_HALT_THRESHOLD },
        tradeFailureHalt: {
            halted: tradeFailureHalted,
            consecutiveFailures: consecutiveTradeFailures,
            threshold: TRADE_FAILURE_HALT_THRESHOLD,
            windowMinutes: TRADE_FAILURE_WINDOW_MS / 60000,
            lastFailure: lastTradeFailureDetail,
            recentFailures: recentTradeFailureDetails.slice(-10)
        }
    });
});

app.get('/api/reconcile-pending', (req, res) => {
    const executorStatus = tradeExecutor.getStatus();
    const lifecycleQueueStatus = getLifecycleQueueStatus(executorStatus);
    res.json({
        pendingBuys: executorStatus.pendingBuys,
        pendingSettlements: executorStatus.pendingSettlements,
        pendingSells: executorStatus.pendingSells,
        recoveryQueue: executorStatus.recoveryQueue,
        recoveryQueueSummary: executorStatus.recoveryQueueSummary,
        redemptionQueue: executorStatus.redemptionQueue,
        redemptionQueueSummary: lifecycleQueueStatus.redemptionQueueSummary,
        redemptionReadiness: lifecycleQueueStatus,
        baselineBankroll: executorStatus.baselineBankroll,
        balanceBreakdown: executorStatus.balanceBreakdown
    });
});

app.post('/api/redeem-auth/derive', async (req, res) => {
    try {
        if (!requireAdminControlSecret(req, res)) return;
        if (CONFIG.TRADE_MODE !== 'LIVE') {
            return res.json({
                success: true,
                skipped: true,
                reason: 'NOT_LIVE_MODE',
                walletStatus: tradeExecutor.clob?.getStatus?.() || null
            });
        }
        if (!tradeExecutor.clob?.ensureProxyRedeemAuth) {
            return res.status(500).json({
                success: false,
                error: 'REDEEM_AUTH_DERIVATION_UNAVAILABLE'
            });
        }
        const auth = await tradeExecutor.clob.ensureProxyRedeemAuth();
        const flyPersistence = await persistDerivedPolymarketSecrets();
        const executorStatus = tradeExecutor.getStatus();
        const lifecycleQueueStatus = getLifecycleQueueStatus(executorStatus);
        res.json({
            success: !!auth?.ok,
            auth,
            flyPersistence,
            redemptionReadiness: lifecycleQueueStatus,
            walletStatus: tradeExecutor.clob?.getStatus?.() || null
        });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

app.post('/api/auto-redeem', async (req, res) => {
    try {
        if (!requireAdminControlSecret(req, res)) return;
        if (CONFIG.TRADE_MODE !== 'LIVE') {
            return res.json({ success: true, skipped: true, reason: 'NOT_LIVE_MODE' });
        }
        const before = tradeExecutor.getStatus();
        const auth = tradeExecutor.clob?.ensureProxyRedeemAuth
            ? await tradeExecutor.clob.ensureProxyRedeemAuth()
            : { ok: false, error: 'REDEEM_AUTH_DERIVATION_UNAVAILABLE' };
        const flyPersistence = await persistDerivedPolymarketSecrets();
        const redemptions = await tradeExecutor.checkAndRedeemPositions();
        const balance = await tradeExecutor.refreshLiveBalance(true).catch((e) => ({
            success: false,
            error: e.message
        }));
        const after = tradeExecutor.getStatus();
        const lifecycleQueueStatus = getLifecycleQueueStatus(after);
        saveRuntimeState();
        res.json({
            success: !!redemptions?.success && Number(lifecycleQueueStatus.redemptionQueueSummary?.actionable || 0) === 0,
            auth,
            before: {
                recoveryQueueSummary: before.recoveryQueueSummary,
                redemptionQueueSummary: before.redemptionQueueSummary,
                provisionalOutcomeSummary: before.provisionalOutcomeSummary,
                balanceBreakdown: before.balanceBreakdown
            },
            redemptions,
            flyPersistence,
            balance,
            after: {
                recoveryQueueSummary: after.recoveryQueueSummary,
                redemptionQueueSummary: after.redemptionQueueSummary,
                provisionalOutcomeSummary: after.provisionalOutcomeSummary,
                balanceBreakdown: after.balanceBreakdown
            },
            redemptionReadiness: lifecycleQueueStatus
        });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

app.post('/api/reconcile-pending', async (req, res) => {
    try {
        if (!requireAdminControlSecret(req, res)) return;
        const paperSettlements = await resolvePendingPaperPositions();
        const pendingBuys = CONFIG.TRADE_MODE === 'LIVE'
            ? await tradeExecutor.processPendingBuys(50)
            : { success: true, processed: 0, recovered: 0, failed: 0 };
        const liveSettlements = CONFIG.TRADE_MODE === 'LIVE'
            ? await reconcilePendingLivePositions()
            : [];
        const pendingSells = CONFIG.TRADE_MODE === 'LIVE'
            ? await tradeExecutor.processPendingSells(currentMarkets, 10)
            : { success: true, processed: 0, closed: 0, failed: 0 };
        const redeemAuth = CONFIG.TRADE_MODE === 'LIVE' && tradeExecutor.clob?.ensureProxyRedeemAuth
            ? await tradeExecutor.clob.ensureProxyRedeemAuth()
            : null;
        const redemptions = CONFIG.TRADE_MODE === 'LIVE'
            ? await tradeExecutor.checkAndRedeemPositions()
            : { success: true, redeemed: 0, failed: 0, skipped: 0, remaining: 0 };
        const balance = CONFIG.TRADE_MODE === 'LIVE'
            ? await tradeExecutor.refreshLiveBalance(true)
            : null;
        const executorStatus = tradeExecutor.getStatus();
        const lifecycleQueueStatus = getLifecycleQueueStatus(executorStatus);
        saveRuntimeState();

        res.json({
            success: true,
            paperSettlements,
            pendingBuys,
            liveSettlements,
            pendingSells,
            redeemAuth,
            redemptions,
            balance,
            redemptionReadiness: lifecycleQueueStatus,
            executor: executorStatus
        });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

app.post('/api/force-recovery', (req, res) => {
    try {
        if (!requireAdminControlSecret(req, res)) return;
        const positionId = String(req.body?.positionId || '').trim();
        const reason = String(req.body?.reason || 'ADMIN_FORCE_MANUAL_RECOVERY').trim() || 'ADMIN_FORCE_MANUAL_RECOVERY';
        if (!positionId) {
            return res.status(400).json({ success: false, error: 'POSITION_ID_REQUIRED' });
        }

        const position = tradeExecutor.positions.find(pos => pos?.id === positionId) || null;
        if (!position) {
            return res.status(404).json({ success: false, error: 'POSITION_NOT_FOUND', positionId });
        }

        const recovery = tradeExecutor.markPositionForRecovery(positionId, {
            reason,
            holderAddress: position.funderAddress || tradeExecutor.clob?.getStatus?.()?.tradeReady?.selected?.funderAddress || null,
            tokenBalance: null,
            zeroVerified: false,
            redeemQueued: false,
            lastError: 'ADMIN_FORCE_MANUAL_RECOVERY',
            notes: 'Forced manual recovery via admin endpoint'
        });

        if (!recovery) {
            return res.status(400).json({ success: false, error: 'FORCE_RECOVERY_FAILED', positionId });
        }

        diagnosticLog.push({
            ts: new Date().toISOString(),
            type: 'ADMIN_FORCE_MANUAL_RECOVERY',
            positionId,
            reason
        });
        saveRuntimeState();

        return res.json({
            success: true,
            positionId,
            recovery,
            executor: tradeExecutor.getStatus()
        });
    } catch (e) {
        return res.status(500).json({ success: false, error: e.message });
    }
});

app.post('/api/rotation-reset', async (req, res) => {
    try {
        if (!requireAdminControlSecret(req, res)) return;
        if (req.body?.confirmRotationReset !== true) {
            return res.status(400).json({
                success: false,
                error: 'CONFIRM_ROTATION_RESET_REQUIRED'
            });
        }
        riskManager.tradingPaused = true;
        const reset = tradeExecutor.resetForAccountRotation({
            preserveClosedPositions: req.body?.preserveClosedPositions !== false
        });
        const balance = await tradeExecutor.refreshLiveBalance(true).catch((e) => ({
            success: false,
            error: e.message
        }));
        const balanceUsd = Number(balance?.tradingBalanceUsdc);
        if (Number.isFinite(balanceUsd)) {
            tradeExecutor.resetMonitoringBaseline(balanceUsd, {
                source: 'rotation_reset_live_balance',
                markInternalEvent: false
            });
            riskManager.bankroll = balanceUsd;
        }
        const executorStatus = tradeExecutor.getStatus();
        const lifecycleQueueStatus = getLifecycleQueueStatus(executorStatus);
        diagnosticLog.push({
            ts: new Date().toISOString(),
            type: 'ADMIN_ROTATION_RESET',
            before: reset.before,
            after: reset.after,
            preserveClosedPositions: reset.preserveClosedPositions,
            balanceSource: balance?.source || null,
            tradingBalanceUsdc: Number.isFinite(balanceUsd) ? balanceUsd : null
        });
        await saveRuntimeState();
        return res.json({
            success: true,
            reset,
            balance,
            redemptionReadiness: lifecycleQueueStatus,
            executor: {
                recoveryQueueSummary: executorStatus.recoveryQueueSummary,
                redemptionQueueSummary: executorStatus.redemptionQueueSummary,
                balanceBreakdown: executorStatus.balanceBreakdown
            }
        });
    } catch (e) {
        return res.status(500).json({ success: false, error: e.message });
    }
});

app.get('/api/diagnostics', (req, res) => {
    const executorStatus = tradeExecutor.getStatus();
    const lifecycleQueueStatus = getLifecycleQueueStatus(executorStatus);
    const balanceBreakdown = executorStatus.balanceBreakdown || {};
    const divergenceUsdc = Number(balanceBreakdown.divergenceUsdc || 0);
    res.json({
        success: true,
        restoredDiagnosticLogCount,
        orchestrator: orchestratorHeartbeat,
        summary: {
            recoveryQueue: executorStatus.recoveryQueue.length,
            redemptionQueue: executorStatus.redemptionQueue.length,
            recoveryQueueSummary: executorStatus.recoveryQueueSummary,
            redemptionQueueSummary: lifecycleQueueStatus.redemptionQueueSummary,
            redemptionReadiness: lifecycleQueueStatus,
            pendingBuys: executorStatus.pendingBuys.length,
            pendingSells: executorStatus.pendingSells.length,
            pendingSettlements: executorStatus.pendingSettlements.length,
            liveBalanceSource: executorStatus.liveBalanceSource,
            balanceDivergenceUsdc: Number.isFinite(divergenceUsdc) ? divergenceUsdc : null
        },
        tradeFailureHalt: {
            halted: tradeFailureHalted,
            consecutiveFailures: consecutiveTradeFailures,
            threshold: TRADE_FAILURE_HALT_THRESHOLD,
            windowMinutes: TRADE_FAILURE_WINDOW_MS / 60000,
            lastFailure: lastTradeFailureDetail,
            recentFailures: recentTradeFailureDetails.slice(-25)
        },
        log: diagnosticLog.slice(-200)
    });
});

app.get('/api/forward-log', (req, res) => {
    const requestedLimit = Number.parseInt(String(req.query?.limit || '200'), 10);
    const limit = Number.isFinite(requestedLimit) ? Math.max(1, Math.min(500, requestedLimit)) : 200;
    const log = Array.isArray(tradeExecutor.forwardTradeLog) ? tradeExecutor.forwardTradeLog.slice(-limit) : [];
    res.json({
        success: true,
        enabled: String(process.env.FORWARD_TRADE_LOG_ENABLED || '').trim().toLowerCase() === 'true' || String(process.env.FORWARD_TRADE_LOG_ENABLED || '').trim() === '1',
        limit,
        log
    });
});

function getAdminControlSecret() {
    return String(process.env.MANUAL_SMOKE_TEST_KEY || process.env.AUTH_PASSWORD || '').trim();
}

function requireAdminControlSecret(req, res) {
    const secret = getAdminControlSecret();
    if (!secret) {
        res.status(503).json({ success: false, error: 'ADMIN_CONTROL_DISABLED' });
        return false;
    }
    const suppliedSecret = String(req.get('x-manual-smoke-key') || req.body?.manualSmokeKey || '').trim();
    if (!suppliedSecret || suppliedSecret !== secret) {
        res.status(401).json({ success: false, error: 'UNAUTHORIZED' });
        return false;
    }
    return true;
}

app.post('/api/pause', async (req, res) => {
    try {
        if (!requireAdminControlSecret(req, res)) return;
        riskManager.tradingPaused = true;
        diagnosticLog.push({ ts: new Date().toISOString(), type: 'ADMIN_PAUSE' });
        await saveRuntimeState();
        return res.json({ success: true, paused: true });
    } catch (e) {
        return res.status(500).json({ success: false, error: e.message });
    }
});

app.post('/api/resume', async (req, res) => {
    try {
        if (!requireAdminControlSecret(req, res)) return;
        riskManager.tradingPaused = false;
        diagnosticLog.push({ ts: new Date().toISOString(), type: 'ADMIN_RESUME' });
        await saveRuntimeState();
        return res.json({ success: true, paused: false });
    } catch (e) {
        return res.status(500).json({ success: false, error: e.message });
    }
});

app.get('/api/trades', (req, res) => {
    const requestedLimit = Number.parseInt(String(req.query?.limit || '50'), 10);
    const limit = Number.isFinite(requestedLimit) ? Math.max(1, Math.min(200, requestedLimit)) : 50;
    const riskStatus = riskManager.getStatus();
    const executorStatus = tradeExecutor.getStatus();
    const executorTrades = tradeExecutor.getRecentTrades(limit);
    const baselineExecutorTrades = tradeExecutor.getClosedTradesSince(executorStatus.monitoringBaselineAt).slice(-limit);
    const riskTrades = Array.isArray(riskStatus.recentTrades) ? riskStatus.recentTrades.slice(-limit) : [];
    const riskTotalTrades = Number(riskStatus.totalTrades || 0);
    const executorTotalTrades = Number(executorStatus.totalTrades || 0);
    const baselineExecutorTotalTrades = Number.isFinite(Number(executorStatus.monitoringTotalTrades))
        ? Number(executorStatus.monitoringTotalTrades)
        : executorTotalTrades;
    res.json({
        success: true,
        limit,
        counts: {
            riskRecentTrades: riskTrades.length,
            executorRecentTrades: executorTrades.length,
            executorRecentTradesSinceBaseline: baselineExecutorTrades.length,
            riskTotalTrades,
            executorTotalTrades,
            executorTotalTradesSinceBaseline: baselineExecutorTotalTrades,
            discrepancy: baselineExecutorTotalTrades - riskTotalTrades,
            allTimeDiscrepancy: executorTotalTrades - riskTotalTrades
        },
        monitoringBaselineAt: executorStatus.monitoringBaselineAt || riskStatus.monitoringBaselineAt || null,
        recentTrades: riskTrades,
        executorClosedTrades: executorTrades,
        executorClosedTradesSinceBaseline: baselineExecutorTrades,
        openPositions: executorStatus.positions
    });
});

app.get('/api/wallet/balance', async (req, res) => {
    try {
        const balanceRefresh = {
            attempted: false,
            forced: false,
            ok: null,
            error: null
        };
        let balanceBreakdown = null;
        if (tradeExecutor.clob?.wallet && typeof tradeExecutor.refreshLiveBalance === 'function') {
            balanceRefresh.attempted = true;
            balanceRefresh.forced = true;
            try {
                balanceBreakdown = await tradeExecutor.refreshLiveBalance(true);
                balanceRefresh.ok = true;
            } catch (e) {
                balanceRefresh.ok = false;
                balanceRefresh.error = e.message;
            }
        }
        if (!balanceBreakdown) {
            balanceBreakdown = tradeExecutor.getCachedBalanceBreakdown();
        }
        const clobStatus = tradeExecutor.clob?.getStatus?.() || null;
        const executorStatus = tradeExecutor.getStatus();
        const lifecycleQueueStatus = getLifecycleQueueStatus(executorStatus);
        res.json({
            mode: CONFIG.TRADE_MODE,
            balanceBreakdown,
            baselineBankroll: tradeExecutor.baselineBankroll,
            baselineBankrollInitialized: tradeExecutor.baselineBankrollInitialized,
            walletLoaded: !!tradeExecutor.clob?.wallet,
            walletStatus: clobStatus,
            redemptionReadiness: lifecycleQueueStatus,
            recoveryQueueSummary: executorStatus.recoveryQueueSummary,
            redemptionQueueSummary: lifecycleQueueStatus.redemptionQueueSummary,
            runtimeBankrollForTimeframes: getRuntimeBankrollForTimeframes(),
            activeTimeframes: getEnabledTimeframes().map(t => t.key),
            diagnostics: {
                balanceRefresh,
                liveBalanceSource: tradeExecutor.liveBalanceSource,
                lastBalanceFetch: tradeExecutor.lastBalanceFetch || null,
                selectedFunderAddress: clobStatus?.tradeReady?.selected?.funderAddress || null,
                tradeReadyBalance: clobStatus?.tradeReady?.balance ?? null,
                tradeReadyBalanceRaw: clobStatus?.tradeReady?.selected?.balanceRaw || null
            }
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
        const collateralProbe = await tradeExecutor.clob?.getClobCollateralBalance?.(true).catch(e => ({ success: false, error: e.message })) || { success: false, error: 'no clob' };
        res.json({
            clobStatus: status,
            credsDerived: deriveResult,
            tradeReady: {
                ok: tradeReady?.ok,
                reason: tradeReady?.reason,
                summary: tradeReady?.summary,
                closedOnly: tradeReady?.closedOnly,
                closedOnlyErr: tradeReady?.closedOnlyErr,
                balance: tradeReady?.balance ?? null,
                sigType: tradeReady?.sigType ?? null,
                selected: tradeReady?.selected || null,
                candidates: Array.isArray(tradeReady?.candidates) ? tradeReady.candidates : []
            },
            collateralProbe,
            hasCreds: !!(CONFIG.POLYMARKET_API_KEY && CONFIG.POLYMARKET_SECRET && CONFIG.POLYMARKET_PASSPHRASE),
            proxyConfigured: !!CONFIG.PROXY_URL,
            clobForceProxy: !!CONFIG.CLOB_FORCE_PROXY,
            clobRouting: status?.clobRouting || null
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/network-diagnostics', async (req, res) => {
    try {
        const axios = require('axios');
        let HttpsProxyAgent = null;
        try { ({ HttpsProxyAgent } = require('https-proxy-agent')); } catch {}
        const timeout = 12000;
        const proxyAgent = CONFIG.PROXY_URL && HttpsProxyAgent
            ? new HttpsProxyAgent(CONFIG.PROXY_URL)
            : null;
        const redact = (value) => String(typeof value === 'string' ? value : JSON.stringify(value || null))
            .replace(/0x[a-fA-F0-9]{64,}/g, (m) => `${m.slice(0, 10)}…${m.slice(-6)}`)
            .replace(/Bearer\s+[A-Za-z0-9._~+\-/=]+/gi, 'Bearer [REDACTED]')
            .replace(/"?(apiKey|secret|passphrase|privateKey|proxyPassword|password)"?\s*[:=]\s*"?[^",\s}]+"?/gi, '$1=[REDACTED]')
            .slice(0, 1000);
        const request = async (label, url, agent) => {
            try {
                const resp = await axios.get(url, {
                    timeout,
                    proxy: false,
                    httpsAgent: agent || undefined,
                    validateStatus: () => true
                });
                return {
                    label,
                    ok: resp.status >= 200 && resp.status < 300,
                    status: resp.status,
                    data: resp.data,
                    headers: {
                        'content-type': resp.headers?.['content-type'] || null,
                        'cf-ray': resp.headers?.['cf-ray'] || null,
                        server: resp.headers?.server || null,
                        'x-request-id': resp.headers?.['x-request-id'] || null
                    }
                };
            } catch (e) {
                return {
                    label,
                    ok: false,
                    error: e.message,
                    status: e.response?.status || null,
                    data: e.response?.data == null ? null : redact(e.response.data)
                };
            }
        };

        const directGeoblock = await request('direct_geoblock', 'https://polymarket.com/api/geoblock', null);
        const proxyGeoblock = proxyAgent
            ? await request('proxy_geoblock', 'https://polymarket.com/api/geoblock', proxyAgent)
            : { label: 'proxy_geoblock', ok: false, error: 'PROXY_NOT_CONFIGURED' };
        const proxyClobTime = proxyAgent
            ? await request('proxy_clob_time', 'https://clob.polymarket.com/time', proxyAgent)
            : { label: 'proxy_clob_time', ok: false, error: 'PROXY_NOT_CONFIGURED' };
        const clobOrderEndpointPreflight = tradeExecutor.clob?.checkClobOrderEndpointPreflight
            ? await tradeExecutor.clob.checkClobOrderEndpointPreflight({ force: true, ttlMs: 60000 }).catch(e => ({ ok: false, blocked: false, reason: e.message }))
            : { ok: false, blocked: false, reason: 'CLOB_PREFLIGHT_UNAVAILABLE' };

        res.json({
            success: true,
            checkedAt: new Date().toISOString(),
            proxyConfigured: !!CONFIG.PROXY_URL,
            clobForceProxy: !!CONFIG.CLOB_FORCE_PROXY,
            note: 'Diagnostics only; order-endpoint preflight posts an intentionally invalid non-trading payload to prove whether CLOB /order reaches validation/auth rather than geoblock. It must not create, cancel, or fill orders.',
            directGeoblock,
            proxyGeoblock,
            proxyClobTime,
            clobOrderEndpointPreflight
        });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

function makeHttpError(status, message, extra = {}) {
    const error = new Error(message);
    error.httpStatus = status;
    Object.assign(error, extra);
    return error;
}

async function getLiveProofBalanceSnapshot(force = false) {
    const snapshot = {
        success: false,
        source: null,
        balanceBreakdown: null,
        error: null
    };

    try {
        if (tradeExecutor.clob?.wallet && typeof tradeExecutor.refreshLiveBalance === 'function') {
            snapshot.source = 'refreshLiveBalance';
            snapshot.balanceBreakdown = await tradeExecutor.refreshLiveBalance(!!force);
        }
        if (!snapshot.balanceBreakdown && typeof tradeExecutor.getCachedBalanceBreakdown === 'function') {
            snapshot.source = snapshot.source ? `${snapshot.source}+cachedFallback` : 'getCachedBalanceBreakdown';
            snapshot.balanceBreakdown = tradeExecutor.getCachedBalanceBreakdown();
        }
        snapshot.success = !!snapshot.balanceBreakdown;
        if (!snapshot.success) snapshot.error = 'BALANCE_BREAKDOWN_UNAVAILABLE';
    } catch (e) {
        snapshot.error = e.message;
        try {
            if (typeof tradeExecutor.getCachedBalanceBreakdown === 'function') {
                snapshot.source = snapshot.source ? `${snapshot.source}+cachedAfterError` : 'getCachedBalanceBreakdownAfterError';
                snapshot.balanceBreakdown = tradeExecutor.getCachedBalanceBreakdown();
                snapshot.success = !!snapshot.balanceBreakdown;
            }
        } catch (fallbackError) {
            snapshot.error = `${snapshot.error}; fallback=${fallbackError.message}`;
        }
    }

    return snapshot;
}

async function runLiveOrderProof(body = {}) {
        const liveModeBlockers = getLiveModeBlockers();
        if (!CONFIG.IS_LIVE || liveModeBlockers.length > 0) {
            throw makeHttpError(409, 'LIVE_MODE_REQUIRED', {
                runtimeMode: {
                    mode: CONFIG.TRADE_MODE,
                    isLive: CONFIG.IS_LIVE,
                    liveModeBlockers
                }
            });
        }
        if (tradeFailureHalted) {
            throw makeHttpError(409, 'TRADE_FAILURE_HALT_ACTIVE');
        }

        const executorStatus = tradeExecutor.getStatus();
        const openExposure = Number(executorStatus.openPositions || 0);
        const pendingExposure = Number(executorStatus.pendingBuys?.length || 0) +
            Number(executorStatus.pendingSells?.length || 0) +
            Number(executorStatus.pendingSettlements?.length || 0);
        if (openExposure > 0 || pendingExposure > 0) {
            throw makeHttpError(409, 'EXPOSURE_NOT_CLEAN', {
                openPositions: openExposure,
                pendingExposure
            });
        }

        const asset = String(body.asset || 'BTC').trim().toUpperCase();
        const timeframe = String(body.timeframe || '15m').trim();
        const direction = String(body.direction || 'UP').trim().toUpperCase();
        const nowSec = Math.floor(Date.now() / 1000);
        const markets = await discoverAllMarkets(nowSec, getRuntimeTimeframes());
        const market = markets[`${asset}_${timeframe}`];
        if (!market || market.status !== 'ACTIVE') {
            throw makeHttpError(404, 'ACTIVE_MARKET_NOT_FOUND', { asset, timeframe, market });
        }

        const tokenId = direction === 'DOWN' ? market.noTokenId : market.yesTokenId;
        const bestAsk = direction === 'DOWN' ? market.noBestAsk : market.yesBestAsk;
        const bestBid = direction === 'DOWN' ? market.noBestBid : market.yesBestBid;
        const minOrderSize = Number(direction === 'DOWN' ? market.noMinOrderSize : market.yesMinOrderSize);
        const shares = Math.max(5, Number.isFinite(minOrderSize) && minOrderSize > 0 ? minOrderSize : 5);
        const fillProof = body.fillProof === true || String(body.fillProof || '').toLowerCase() === 'true';
        const requestedPrice = Number(body.price);
        const proofPrice = fillProof
            ? Math.min(0.98, Number.isFinite(requestedPrice) ? requestedPrice : Number(bestAsk || 0.01))
            : Math.max(0.01, Math.min(0.05, Number.isFinite(requestedPrice) ? requestedPrice : 0.01));
        const maxNotionalUsd = proofPrice * shares;

        if (!tokenId || !Number.isFinite(proofPrice) || proofPrice <= 0 || proofPrice >= 1) {
            throw makeHttpError(400, 'INVALID_PROOF_ORDER_INPUT', { tokenId, proofPrice });
        }
        if (fillProof && !body.confirmFillProof) {
            throw makeHttpError(400, 'FILL_PROOF_REQUIRES_confirmFillProof_TRUE', {
                note: 'Default proof is a low-price accepted-order/cancel test. Set fillProof=true and confirmFillProof=true only for deliberate live fill exposure.'
            });
        }

        const beforeBalance = await getLiveProofBalanceSnapshot(true);
        const result = await tradeExecutor.clob.placeOrder(tokenId, proofPrice, shares, 'BUY');
        const afterBalance = await getLiveProofBalanceSnapshot(true);
        diagnosticLog.push({
            ts: new Date().toISOString(),
            type: 'LIVE_ORDER_PROOF',
            asset,
            timeframe,
            direction,
            slug: market.slug,
            tokenId,
            proofPrice,
            shares,
            fillProof,
            acceptedOrder: !!result?.acceptedOrder,
            orderID: result?.orderID || null,
            success: !!result?.success,
            error: result?.error || null,
            clobFailureSummary: result?.clobFailureSummary || null,
            beforeBalanceSource: beforeBalance?.source || null,
            afterBalanceSource: afterBalance?.source || null
        });

        return {
            success: !!(result?.acceptedOrder || result?.success),
            proofType: fillProof ? 'LIVE_FILL_PROOF' : 'ACCEPTED_ORDER_CANCEL_PROOF',
            requestedExposure: {
                shares,
                price: proofPrice,
                maxNotionalUsd,
                fillProof,
                defaultNoFillCancelProof: !fillProof
            },
            market: {
                asset,
                timeframe,
                direction,
                slug: market.slug,
                tokenId,
                bestBid,
                bestAsk,
                minOrderSize,
                marketUrl: market.marketUrl
            },
            order: result,
            beforeBalance,
            afterBalance,
            note: result?.acceptedOrder
                ? (fillProof
                    ? 'Authenticated CLOB order was accepted. fillProof=true can intentionally use funds and create live exposure.'
                    : 'Authenticated CLOB order was accepted and returned an orderID. Default proof posts a deliberately low-price GTC order, then cancels any unfilled remainder; a fill is not intended but is still theoretically possible in a live book.')
                : 'Authenticated CLOB order was not accepted; inspect order.clobFailureSummary/order.clobFailure.'
        };
}

async function runLiveProofSelfTest() {
    const checks = {
        runLiveOrderProof: typeof runLiveOrderProof === 'function',
        getRuntimeTimeframes: typeof getRuntimeTimeframes === 'function',
        getLiveProofBalanceSnapshot: typeof getLiveProofBalanceSnapshot === 'function',
        executorCachedBalance: typeof tradeExecutor.getCachedBalanceBreakdown === 'function',
        executorRefreshBalance: typeof tradeExecutor.refreshLiveBalance === 'function',
        clobPlaceOrder: typeof tradeExecutor.clob?.placeOrder === 'function',
        clobInvalidBalanceCallAbsent: typeof tradeExecutor.clob?.getBalanceBreakdown !== 'function'
    };
    const balanceSnapshot = await getLiveProofBalanceSnapshot(false);
    const failures = Object.entries(checks)
        .filter(([, ok]) => !ok)
        .map(([name]) => name);
    if (!balanceSnapshot || balanceSnapshot.success !== true) {
        failures.push(`balanceSnapshot:${balanceSnapshot?.error || 'unknown'}`);
    }
    return {
        success: failures.length === 0,
        checkedAt: new Date().toISOString(),
        checks,
        balanceSnapshot,
        failures,
        note: 'Non-trading self-test only: verifies live proof helper wiring and balance snapshot path without placing or cancelling any order.'
    };
}

app.post('/api/live-order-proof', async (req, res) => {
    try {
        if (!requireAdminControlSecret(req, res)) return;
        const result = await runLiveOrderProof(req.body || {});
        return res.json(result);
    } catch (e) {
        return res.status(e.httpStatus || 500).json({
            success: false,
            error: e.message,
            openPositions: e.openPositions,
            pendingExposure: e.pendingExposure,
            runtimeMode: e.runtimeMode,
            asset: e.asset,
            timeframe: e.timeframe,
            market: e.market,
            tokenId: e.tokenId,
            proofPrice: e.proofPrice,
            note: e.note
        });
    }
});

app.get('/api/derive-debug', async (req, res) => {
    try {
        const { ClobClient: ClobClientClass, version: sdkVersion } = loadClobClientSdk();
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
            const { createL1Headers } = loadClobHeaders();
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

        results.sdkVersion = sdkVersion || 'unknown';
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

// Strategy validator — run on demand
app.get('/api/validator/last', (req, res) => {
    const report = strategyValidator.getLastReport();
    res.json({ success: true, report });
});

app.post('/api/validator/run', (req, res) => {
    try {
        const report = strategyValidator.runCheck({
            risk: riskManager.getStatus(),
            executor: tradeExecutor.getStatus(),
            activeStrategyFiles: getActiveStrategyFilePaths(),
            deployInfo: { deployVersion: DEPLOY_VERSION, mode: CONFIG.TRADE_MODE, isLive: CONFIG.IS_LIVE },
            trigger: 'MANUAL'
        });
        res.json({ success: true, report });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

async function resetValidatorBaseline(options = {}) {
    const clearTradeLog = options.clearTradeLog !== false;
    const preservePause = options.preservePause !== false;
    const breakdown = CONFIG.TRADE_MODE === 'LIVE'
        ? await tradeExecutor.refreshLiveBalance(true)
        : (tradeExecutor.getCachedBalanceBreakdown?.() || null);
    const baselineBalance = Number(
        breakdown?.equityEstimateUsdc ??
        tradeExecutor.getRiskBankrollEstimate?.() ??
        breakdown?.tradingBalanceUsdc ??
        tradeExecutor.cachedLiveBalance ??
        riskManager.bankroll ??
        CONFIG.RISK.startingBalance ??
        0
    );

    riskManager.resetMonitoringBaseline(baselineBalance, { clearTradeLog, preservePause });
    tradeExecutor.resetMonitoringBaseline(baselineBalance, { source: options.source || 'manual_validator_reset' });
    strategyValidator.resetState({ tradeCount: 0, clearReport: true });

    diagnosticLog.push({
        ts: new Date().toISOString(),
        type: 'VALIDATOR_BASELINE_RESET',
        baselineBalance,
        clearTradeLog,
        preservePause,
        deployVersion: DEPLOY_VERSION,
        source: options.source || 'manual_validator_reset'
    });

    await saveRuntimeState();

    const report = strategyValidator.runCheck({
        risk: riskManager.getStatus(),
        executor: tradeExecutor.getStatus(),
        activeStrategyFiles: getActiveStrategyFilePaths(),
        deployInfo: { deployVersion: DEPLOY_VERSION, mode: CONFIG.TRADE_MODE, isLive: CONFIG.IS_LIVE },
        trigger: options.trigger || 'BASELINE_RESET'
    });

    return {
        baselineBalance,
        clearTradeLog,
        preservePause,
        balanceBreakdown: tradeExecutor.getCachedBalanceBreakdown?.() || breakdown || null,
        report
    };
}

app.post('/api/validator/reset', async (req, res) => {
    try {
        const confirmReset = req.body?.confirmReset === true;
        if (!confirmReset) {
            return res.status(400).json({ success: false, error: 'confirmReset=true required' });
        }

        const result = await resetValidatorBaseline({
            clearTradeLog: req.body?.clearTradeLog !== false,
            preservePause: req.body?.preservePause !== false,
            trigger: 'BASELINE_RESET',
            source: 'manual_validator_reset'
        });

        return res.json({ success: true, ...result });
    } catch (e) {
        return res.status(500).json({ success: false, error: e.message });
    }
});

// Telegram — send a test message (for setup verification)
app.post('/api/telegram/test', (req, res) => {
    const sent = telegram.sendMessage(
        `🧪 <b>TEST PING</b>\nDeploy: <code>${String(DEPLOY_VERSION).slice(0, 12)}</code>\n` +
        `Mode: ${CONFIG.TRADE_MODE} | Live: ${CONFIG.IS_LIVE}`,
        telegram.PRIORITY.HIGH,
        { allowDuplicate: true }
    );
    res.json({ success: true, sent, state: telegram.getQueueState() });
});

app.get('/api/telegram/state', (req, res) => {
    res.json({ success: true, state: telegram.getQueueState() });
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

        // Start Telegram command long-poll loop (ignored if disabled/unconfigured)
        try {
            telegramCommands.startCommandLoop({
                riskManager,
                tradeExecutor,
                clobClient: tradeExecutor?.clob,
                getHalts: getHaltsSnapshot,
                clearHalts: clearAllHalts,
                saveRuntimeState,
                resetValidatorBaseline,
                switchRuntimeTradeMode,
                getLiveModeBlockers,
                runLiveOrderProof,
                runValidator: () => strategyValidator.runCheck({
                    risk: riskManager.getStatus(),
                    executor: tradeExecutor.getStatus(),
                    activeStrategyFiles: getActiveStrategyFilePaths(),
                    deployInfo: { deployVersion: DEPLOY_VERSION, mode: CONFIG.TRADE_MODE, isLive: CONFIG.IS_LIVE },
                    trigger: 'TG_COMMAND'
                }),
                getUpcomingWindows: getUpcomingWindowsForTelegram
            });
        } catch (e) {
            console.log(`⚠️ telegram commands failed to start: ${e.message}`);
        }

        // Boot notification (one-shot)
        try {
            const activeSets = (typeof getAllLoadedSets === 'function') ? (getAllLoadedSets() || {}) : {};
            const tf15 = activeSets['15m'] || null;
            telegram.notifyBootStartup({
                mode: CONFIG.TRADE_MODE,
                isLive: CONFIG.IS_LIVE,
                balance: Number(riskManager.bankroll || 0),
                strategyFile: tf15?.filePath ? path.basename(tf15.filePath) : 'unknown',
                strategyCount: Number(tf15?.strategies || 0),
                deployVersion: DEPLOY_VERSION,
                host: process.env.RENDER_EXTERNAL_HOSTNAME || 'local'
            });
        } catch (e) {
            console.log(`⚠️ boot telegram notify failed: ${e.message}`);
        }

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
    try { telegramCommands.stopCommandLoop(); } catch {}
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

if (process.env.LIVEPROOF_SELFTEST === '1') {
    runLiveProofSelfTest()
        .then(result => {
            console.log(JSON.stringify(result, null, 2));
            process.exit(result.success ? 0 : 1);
        })
        .catch(err => {
            console.error(JSON.stringify({ success: false, error: err.message }, null, 2));
            process.exit(1);
        });
} else {
    startServer().catch((err) => {
        console.error(`🔴 Startup failed: ${err.message}`);
        process.exit(1);
    });
}

process.on('SIGTERM', () => { void shutdown('SIGTERM'); });
process.on('SIGINT', () => { void shutdown('SIGINT'); });
