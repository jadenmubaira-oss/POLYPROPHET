const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');

const REPO_ROOT = path.join(__dirname, '..');
const envFileCandidate = String(process.env.ENV_FILE || '').trim();
const resolveEnvPath = (candidate) => path.isAbsolute(candidate) ? candidate : path.join(REPO_ROOT, candidate);
const envFilePath =
    (envFileCandidate && fs.existsSync(resolveEnvPath(envFileCandidate))) ? resolveEnvPath(envFileCandidate) :
        (fs.existsSync(path.join(REPO_ROOT, '.env')) ? path.join(REPO_ROOT, '.env') :
            (fs.existsSync(path.join(REPO_ROOT, 'POLYPROPHET.env')) ? path.join(REPO_ROOT, 'POLYPROPHET.env') : null));
dotenv.config(envFilePath ? { path: envFilePath } : undefined);

const parseBool = (value, defaultValue = false) => {
    if (value === undefined || value === null || String(value).trim() === '') return defaultValue;
    const normalized = String(value).trim().toLowerCase();
    if (['true', '1', 'yes', 'on'].includes(normalized)) return true;
    if (['false', '0', 'no', 'off'].includes(normalized)) return false;
    return defaultValue;
};
const parseList = (value, fallback = []) => {
    const parsed = String(value || '')
        .split(',')
        .map(item => item.trim().toUpperCase())
        .filter(Boolean);
    return parsed.length > 0 ? parsed : fallback;
};
const parseNumber = (value, fallback) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
};
const startingBalance = parseFloat(process.env.STARTING_BALANCE || process.env.PAPER_BALANCE || '5');
const microBankrollDeployProfile = startingBalance > 0 && startingBalance <= 10;
const allowMicroMpcOverride = parseBool(process.env.ALLOW_MICRO_MPC_OVERRIDE ?? process.env.EPOCH3_ALLOW_MICRO_MPC_OVERRIDE, false);
const allowMicroTfOverride = parseBool(process.env.ALLOW_MICRO_TIMEFRAME_OVERRIDE, false);
const microBankrollAllow5m = parseBool(process.env.MICRO_BANKROLL_ALLOW_5M, false);
const microBankrollAllow4h = parseBool(process.env.MICRO_BANKROLL_ALLOW_4H, false);
const microBankrollMpcCap = parseNumber(process.env.MICRO_BANKROLL_MPC_CAP, 1);
const defaultStakeFraction = startingBalance <= 10 ? 0.15 : 0.12;
const defaultAssets = ['BTC', 'ETH', 'SOL', 'XRP'];
const parsedMaxGlobalTradesPerCycle = parseInt(process.env.MAX_GLOBAL_TRADES_PER_CYCLE || '2', 10);
const requestedMaxGlobalTradesPerCycle = Number.isFinite(parsedMaxGlobalTradesPerCycle) ? parsedMaxGlobalTradesPerCycle : 2;
const forcedMaxGlobalTradesPerCycle = microBankrollDeployProfile
    ? (allowMicroMpcOverride ? Math.max(1, Math.min(requestedMaxGlobalTradesPerCycle, microBankrollMpcCap)) : 1)
    : Math.max(1, requestedMaxGlobalTradesPerCycle);

const CONFIG = {
    MICRO_BANKROLL_DEPLOY_PROFILE: microBankrollDeployProfile,

    // Trading mode
    TRADE_MODE: (process.env.TRADE_MODE || 'PAPER').toUpperCase(),
    ENABLE_LIVE_TRADING: ['true', '1'].includes(String(process.env.ENABLE_LIVE_TRADING || '').trim().toLowerCase()),
    LIVE_AUTOTRADING_ENABLED: ['true', '1'].includes(String(process.env.LIVE_AUTOTRADING_ENABLED || '').trim().toLowerCase()),

    // Wallet
    POLYMARKET_PRIVATE_KEY: (process.env.POLYMARKET_PRIVATE_KEY || '').trim(),
    POLYMARKET_API_KEY: (process.env.POLYMARKET_API_KEY || '').trim(),
    POLYMARKET_SECRET: (process.env.POLYMARKET_SECRET || '').trim(),
    POLYMARKET_PASSPHRASE: (process.env.POLYMARKET_PASSPHRASE || '').trim(),
    POLYMARKET_SIGNATURE_TYPE: parseInt(process.env.POLYMARKET_SIGNATURE_TYPE || '0'),
    POLYMARKET_ADDRESS: (process.env.POLYMARKET_ADDRESS || '').trim(),
    POLYMARKET_AUTO_DERIVE_CREDS: String(process.env.POLYMARKET_AUTO_DERIVE_CREDS || 'true').toLowerCase() !== 'false',
    POLYMARKET_RELAYER_URL: (process.env.POLYMARKET_RELAYER_URL || 'https://relayer-v2.polymarket.com').trim(),
    POLYMARKET_RELAYER_API_KEY: (process.env.POLYMARKET_RELAYER_API_KEY || '').trim(),
    POLYMARKET_RELAYER_API_KEY_ADDRESS: (process.env.POLYMARKET_RELAYER_API_KEY_ADDRESS || '').trim(),
    POLYMARKET_BUILDER_API_KEY: (process.env.POLYMARKET_BUILDER_API_KEY || '').trim(),
    POLYMARKET_BUILDER_SECRET: (process.env.POLYMARKET_BUILDER_SECRET || '').trim(),
    POLYMARKET_BUILDER_PASSPHRASE: (process.env.POLYMARKET_BUILDER_PASSPHRASE || '').trim(),

    // Proxy (for Render/Cloudflare bypass)
    PROXY_URL: (process.env.PROXY_URL || '').trim(),
    CLOB_FORCE_PROXY: String(process.env.CLOB_FORCE_PROXY || '').trim() === '1',

    // Assets & timeframes
    ASSETS: parseList(process.env.ASSETS, defaultAssets),
    TIMEFRAMES: [
        { key: '5m', seconds: 300, label: '5-Minute', enabled: (microBankrollDeployProfile && !allowMicroTfOverride && !microBankrollAllow5m) ? false : parseBool(process.env.TIMEFRAME_5M_ENABLED ?? process.env.MULTIFRAME_5M_ENABLED, false), minBankroll: parseNumber(process.env.TIMEFRAME_5M_MIN_BANKROLL, (allowMicroTfOverride || microBankrollAllow5m) ? 3 : 50) },
        { key: '15m', seconds: 900, label: '15-Minute', enabled: parseBool(process.env.TIMEFRAME_15M_ENABLED, true), minBankroll: Math.max(microBankrollDeployProfile ? 3 : 0, parseNumber(process.env.TIMEFRAME_15M_MIN_BANKROLL, microBankrollDeployProfile ? 3 : 5)) },
        { key: '4h', seconds: 14400, label: '4-Hour', enabled: (microBankrollDeployProfile && !allowMicroTfOverride && !microBankrollAllow4h) ? false : parseBool(process.env.MULTIFRAME_4H_ENABLED ?? process.env.ENABLE_4H_TRADING, false), minBankroll: parseNumber(process.env.TIMEFRAME_4H_MIN_BANKROLL, (allowMicroTfOverride || microBankrollAllow4h) ? 3 : 10) }
    ],

    // APIs
    GAMMA_API: 'https://gamma-api.polymarket.com',
    CLOB_API: 'https://clob.polymarket.com',
    DATA_API: (process.env.DATA_API || 'https://data-api.polymarket.com').trim(),

    // Risk parameters
    RISK: {
        startingBalance,
        stakeFraction: parseFloat(process.env.OPERATOR_STAKE_FRACTION || process.env.MAX_POSITION_SIZE || String(defaultStakeFraction)),
        kellyMaxFraction: parseFloat(process.env.KELLY_MAX_FRACTION || '0.45'),
        kellyFraction: 0.35,
        kellyMinPWin: 0.55,
        globalStopLoss: 0.20,
        maxGlobalTradesPerCycle: forcedMaxGlobalTradesPerCycle,
        microBankrollThreshold: 999999,
        minOrderShares: parseInt(process.env.DEFAULT_MIN_ORDER_SHARES || '5'),
        maxConsecutiveLosses: parseNumber(process.env.MAX_CONSECUTIVE_LOSSES, 4),
        cooldownSeconds: parseNumber(process.env.COOLDOWN_SECONDS, 600),
        peakDrawdownBrakePct: parseNumber(process.env.PEAK_DRAWDOWN_BRAKE_PCT, 0.30),
        peakDrawdownBrakeMinBankroll: parseNumber(process.env.PEAK_DRAWDOWN_BRAKE_MIN_BANKROLL, 30),
        minBalanceFloor: parseNumber(process.env.MIN_BALANCE_FLOOR, 0),
        slippagePct: 0.01,
        entryPriceBufferCents: parseNumber(process.env.ENTRY_PRICE_BUFFER_CENTS, 0),
        takerFeePct: parseNumber(process.env.TAKER_FEE_PCT, 0.0315),
        minNetEdgeRoi: parseNumber(process.env.MIN_NET_EDGE_ROI, 0),
        enforceNetEdgeGate: parseBool(process.env.ENFORCE_NET_EDGE_GATE, true),
        enforceHighPriceEdgeFloor: parseBool(process.env.ENFORCE_HIGH_PRICE_EDGE_FLOOR, true),
        highPriceEdgeFloorPrice: parseNumber(process.env.HIGH_PRICE_EDGE_FLOOR_PRICE, 0.78),
        highPriceEdgeFloorMinRoi: parseNumber(process.env.HIGH_PRICE_EDGE_FLOOR_MIN_ROI, 0.015),
        requireRealOrderBook: parseBool(process.env.REQUIRE_REAL_ORDERBOOK, true),
        maxTotalExposure: parseNumber(process.env.MAX_TOTAL_EXPOSURE, 0),
        maxTotalExposureMinBankroll: parseNumber(process.env.MAX_TOTAL_EXPOSURE_MIN_BANKROLL, 50),
        riskEnvelopeEnabled: parseBool(process.env.RISK_ENVELOPE_ENABLED, false),
        riskEnvelopeMinBankroll: parseNumber(process.env.RISK_ENVELOPE_MIN_BANKROLL, 100),
        vaultTriggerBalance: parseNumber(process.env.VAULT_TRIGGER_BALANCE, 100),
        stage2Threshold: parseNumber(process.env.STAGE2_THRESHOLD, 1000),
        maxAbsoluteStakeSmall: parseNumber(process.env.MAX_ABSOLUTE_STAKE_SMALL ?? process.env.MAX_ABSOLUTE_STAKE ?? process.env.MAX_ABSOLUTE_POSITION_SIZE, 100),
        maxAbsoluteStakeMedium: parseNumber(process.env.MAX_ABSOLUTE_STAKE_MEDIUM ?? process.env.MAX_ABSOLUTE_STAKE, 200),
        maxAbsoluteStakeLarge: parseNumber(process.env.MAX_ABSOLUTE_STAKE_LARGE ?? process.env.MAX_ABSOLUTE_STAKE, 500),

        // Pre-resolution exit: sell winning positions on CLOB before cycle ends
        preResolutionExitEnabled: parseBool(process.env.PRE_RESOLUTION_EXIT_ENABLED, true),
        preResolutionMinBid: parseNumber(process.env.PRE_RESOLUTION_MIN_BID, 0.95),
        preResolutionExitSeconds: {
            '5m': parseNumber(process.env.PRE_RESOLUTION_EXIT_5M_SECONDS, 45),
            '15m': parseNumber(process.env.PRE_RESOLUTION_EXIT_15M_SECONDS, 120),
            '4h': parseNumber(process.env.PRE_RESOLUTION_EXIT_4H_SECONDS, 600),
        },
    },

    // Telegram
    TELEGRAM: {
        enabled: !!(process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID),
        botToken: (process.env.TELEGRAM_BOT_TOKEN || '').trim(),
        chatId: (process.env.TELEGRAM_CHAT_ID || '').trim(),
        signalsOnly: parseBool(process.env.TELEGRAM_SIGNALS_ONLY, false),
        // Verbosity: SILENT | CRITICAL_ONLY | QUIET | NORMAL | VERBOSE
        verbosity: String(process.env.TELEGRAM_VERBOSITY || 'NORMAL').toUpperCase(),
        // Quiet hours (UTC). Both = same = disabled. Range wraps midnight if start > end.
        quietStartHourUtc: parseNumber(process.env.TELEGRAM_QUIET_START_UTC, 0),
        quietEndHourUtc: parseNumber(process.env.TELEGRAM_QUIET_END_UTC, 0),
        maxPerMinute: parseNumber(process.env.TELEGRAM_MAX_PER_MINUTE, 20),
        dedupWindowMs: parseNumber(process.env.TELEGRAM_DEDUP_WINDOW_MS, 60000),
        // Inbound command polling
        commandsEnabled: parseBool(process.env.TELEGRAM_COMMANDS_ENABLED, true),
        commandsPollIntervalMs: parseNumber(process.env.TELEGRAM_COMMANDS_POLL_MS, 15000),
        // Daily summary cron hour (UTC). Default 00:05 UTC.
        dailySummaryUtcHour: parseNumber(process.env.TELEGRAM_DAILY_SUMMARY_UTC_HOUR, 0),
        dailySummaryUtcMinute: parseNumber(process.env.TELEGRAM_DAILY_SUMMARY_UTC_MINUTE, 5),
        // Send a short heartbeat every N minutes to prove liveness. 0 = disabled.
        heartbeatIntervalMinutes: parseNumber(process.env.TELEGRAM_HEARTBEAT_MIN, 0),
    },

    // In-process strategy health validator
    STRATEGY_VALIDATOR: {
        enabled: parseBool(process.env.STRATEGY_VALIDATOR_ENABLED, true),
        // How many live trades since the last validator run trigger a fresh check
        tradeBatchInterval: parseNumber(process.env.VALIDATOR_TRADE_BATCH, 20),
        // Hard-kill triggers
        rolling20WrFloor: parseNumber(process.env.VALIDATOR_ROLLING20_WR_FLOOR, 0.65),
        rolling50WrFloor: parseNumber(process.env.VALIDATOR_ROLLING50_WR_FLOOR, 0.76),
        rolling100WrFloor: parseNumber(process.env.VALIDATOR_ROLLING100_WR_FLOOR, 0.79),
        drawdownAlertPct: parseNumber(process.env.VALIDATOR_DD_ALERT_PCT, 0.40),
        drawdownCriticalPct: parseNumber(process.env.VALIDATOR_DD_CRITICAL_PCT, 0.60),
        dailyMinTradesForWrCheck: parseNumber(process.env.VALIDATOR_DAILY_MIN_TRADES, 10),
        dailyWrFloor: parseNumber(process.env.VALIDATOR_DAILY_WR_FLOOR, 0.70),
        // Scheduled refresh — age of the loaded strategy file (days)
        strategyMaxAgeDaysWarn: parseNumber(process.env.VALIDATOR_STRATEGY_MAX_AGE_WARN_DAYS, 21),
        strategyMaxAgeDaysCritical: parseNumber(process.env.VALIDATOR_STRATEGY_MAX_AGE_CRIT_DAYS, 30),
        // Health check cadence (milliseconds). Default hourly.
        periodicCheckIntervalMs: parseNumber(process.env.VALIDATOR_PERIODIC_MS, 60 * 60 * 1000),
    },

    // Server
    PORT: parseInt(process.env.PORT || '3000'),
};

// Determine effective trade mode
if (CONFIG.TRADE_MODE === 'LIVE' && !CONFIG.ENABLE_LIVE_TRADING) {
    console.log('⚠️ TRADE_MODE=LIVE but ENABLE_LIVE_TRADING not set → forcing PAPER');
    CONFIG.TRADE_MODE = 'PAPER';
}

if (CONFIG.TRADE_MODE === 'LIVE' && CONFIG.TELEGRAM.signalsOnly) {
    console.log('⚠️ TRADE_MODE=LIVE but TELEGRAM_SIGNALS_ONLY=true → forcing advisory mode');
}

CONFIG.IS_LIVE = CONFIG.TRADE_MODE === 'LIVE' && CONFIG.ENABLE_LIVE_TRADING && CONFIG.LIVE_AUTOTRADING_ENABLED && !CONFIG.TELEGRAM.signalsOnly;

if (forcedMaxGlobalTradesPerCycle !== requestedMaxGlobalTradesPerCycle) {
    console.warn(`⚠️ MAX_GLOBAL_TRADES_PER_CYCLE=${requestedMaxGlobalTradesPerCycle} overridden to ${forcedMaxGlobalTradesPerCycle} (floor=1).`);
}

if (microBankrollDeployProfile) {
    if (allowMicroMpcOverride || allowMicroTfOverride) {
        console.warn(`⚠️ Micro-bankroll deploy profile active with EPOCH3 overrides: MPC=${forcedMaxGlobalTradesPerCycle}, 5m=${microBankrollAllow5m ? 'enabled' : 'disabled'}, 4h=${microBankrollAllow4h ? 'enabled' : 'disabled'}.`);
    } else {
        console.warn('⚠️ Micro-bankroll deploy profile active: forcing 15m-only posture, disabling 5m and 4h, and capping MPC at 1.');
    }
}

if (CONFIG.RISK.entryPriceBufferCents > 0) {
    console.warn(`⚠️ ENTRY_PRICE_BUFFER_CENTS=${CONFIG.RISK.entryPriceBufferCents} — this widens limit prices above discovery price. Verify this is intentional.`);
}

module.exports = CONFIG;
