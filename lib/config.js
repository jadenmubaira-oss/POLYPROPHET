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
 const defaultStakeFraction = startingBalance <= 10 ? 0.15 : 0.12;
 const defaultAssets = ['BTC', 'ETH', 'SOL', 'XRP'];

 const CONFIG = {
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

    // Proxy (for Render/Cloudflare bypass)
    PROXY_URL: (process.env.PROXY_URL || '').trim(),
    CLOB_FORCE_PROXY: String(process.env.CLOB_FORCE_PROXY || '').trim() === '1',

    // Assets & timeframes
    ASSETS: parseList(process.env.ASSETS, defaultAssets),
    TIMEFRAMES: [
        { key: '5m', seconds: 300, label: '5-Minute', enabled: parseBool(process.env.TIMEFRAME_5M_ENABLED ?? process.env.MULTIFRAME_5M_ENABLED, false), minBankroll: parseNumber(process.env.TIMEFRAME_5M_MIN_BANKROLL, 50) },
        { key: '15m', seconds: 900, label: '15-Minute', enabled: parseBool(process.env.TIMEFRAME_15M_ENABLED, true), minBankroll: parseNumber(process.env.TIMEFRAME_15M_MIN_BANKROLL, 5) },
        { key: '4h', seconds: 14400, label: '4-Hour', enabled: parseBool(process.env.MULTIFRAME_4H_ENABLED ?? process.env.ENABLE_4H_TRADING, false), minBankroll: parseNumber(process.env.TIMEFRAME_4H_MIN_BANKROLL, 10) }
    ],

    // APIs
    GAMMA_API: 'https://gamma-api.polymarket.com',
    CLOB_API: 'https://clob.polymarket.com',

    // Risk parameters
    RISK: {
        startingBalance,
        stakeFraction: parseFloat(process.env.OPERATOR_STAKE_FRACTION || process.env.MAX_POSITION_SIZE || String(defaultStakeFraction)),
        kellyMaxFraction: parseFloat(process.env.KELLY_MAX_FRACTION || '0.45'),
        kellyFraction: 0.35,
        kellyMinPWin: 0.55,
        globalStopLoss: 0.20,
        maxGlobalTradesPerCycle: 3,
        microBankrollThreshold: 10,
        minOrderShares: parseInt(process.env.DEFAULT_MIN_ORDER_SHARES || '1'),
        maxConsecutiveLosses: 4,
        cooldownSeconds: 600,
        peakDrawdownBrakePct: 0.20,
        peakDrawdownBrakeMinBankroll: 20,
        minBalanceFloor: 2.0,
        slippagePct: 0.01,
        entryPriceBufferCents: parseNumber(process.env.ENTRY_PRICE_BUFFER_CENTS, 1),
        takerFeePct: parseNumber(process.env.TAKER_FEE_PCT, 0.0315),
        minNetEdgeRoi: parseNumber(process.env.MIN_NET_EDGE_ROI, 0),
        requireRealOrderBook: parseBool(process.env.REQUIRE_REAL_ORDERBOOK, true),
        maxTotalExposure: parseNumber(process.env.MAX_TOTAL_EXPOSURE, 0.50),
        maxTotalExposureMinBankroll: parseNumber(process.env.MAX_TOTAL_EXPOSURE_MIN_BANKROLL, 50),
        riskEnvelopeEnabled: parseBool(process.env.RISK_ENVELOPE_ENABLED, true),
        riskEnvelopeMinBankroll: parseNumber(process.env.RISK_ENVELOPE_MIN_BANKROLL, 100),
        vaultTriggerBalance: parseNumber(process.env.VAULT_TRIGGER_BALANCE, 100),
        stage2Threshold: parseNumber(process.env.STAGE2_THRESHOLD, 1000),
        maxAbsoluteStakeSmall: parseNumber(process.env.MAX_ABSOLUTE_STAKE_SMALL ?? process.env.MAX_ABSOLUTE_STAKE ?? process.env.MAX_ABSOLUTE_POSITION_SIZE, 100),
        maxAbsoluteStakeMedium: parseNumber(process.env.MAX_ABSOLUTE_STAKE_MEDIUM ?? process.env.MAX_ABSOLUTE_STAKE, 200),
        maxAbsoluteStakeLarge: parseNumber(process.env.MAX_ABSOLUTE_STAKE_LARGE ?? process.env.MAX_ABSOLUTE_STAKE, 500),
    },

    // Telegram
    TELEGRAM: {
        enabled: !!(process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID),
        botToken: (process.env.TELEGRAM_BOT_TOKEN || '').trim(),
        chatId: (process.env.TELEGRAM_CHAT_ID || '').trim(),
        signalsOnly: ['true', '1', 'yes'].includes(String(process.env.TELEGRAM_SIGNALS_ONLY || '').trim().toLowerCase()),
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

module.exports = CONFIG;
