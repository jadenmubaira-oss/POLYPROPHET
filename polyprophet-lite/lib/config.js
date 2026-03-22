require('dotenv').config();

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
    ASSETS: ['BTC', 'ETH', 'SOL', 'XRP', 'DOGE', 'BNB', 'HYPE'],
    TIMEFRAMES: [
        { key: '5m', seconds: 300, label: '5-Minute' },
        { key: '15m', seconds: 900, label: '15-Minute' },
        { key: '4h', seconds: 14400, label: '4-Hour' }
    ],

    // APIs
    GAMMA_API: 'https://gamma-api.polymarket.com',
    CLOB_API: 'https://clob.polymarket.com',

    // Risk parameters
    RISK: {
        startingBalance: parseFloat(process.env.STARTING_BALANCE || '5'),
        stakeFraction: parseFloat(process.env.OPERATOR_STAKE_FRACTION || '0.45'),
        kellyMaxFraction: 0.45,
        kellyFraction: 0.25, // half-Kelly
        kellyMinPWin: 0.55,
        globalStopLoss: 0.20,
        maxGlobalTradesPerCycle: 2,
        microBankrollThreshold: 10, // below this, force 1 trade/cycle
        minOrderShares: 5,
        maxConsecutiveLosses: 3,
        cooldownSeconds: 1200,
        peakDrawdownBrakePct: 0.20,
        peakDrawdownBrakeMinBankroll: 20,
        minBalanceFloor: 2.0,
        slippagePct: 0.01,
    },

    // Telegram
    TELEGRAM: {
        enabled: !!(process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID),
        botToken: (process.env.TELEGRAM_BOT_TOKEN || '').trim(),
        chatId: (process.env.TELEGRAM_CHAT_ID || '').trim(),
        signalsOnly: String(process.env.TELEGRAM_SIGNALS_ONLY || '').trim().toLowerCase() !== 'false',
    },

    // Server
    PORT: parseInt(process.env.PORT || '3000'),
};

// Determine effective trade mode
if (CONFIG.TRADE_MODE === 'LIVE' && !CONFIG.ENABLE_LIVE_TRADING) {
    console.log('⚠️ TRADE_MODE=LIVE but ENABLE_LIVE_TRADING not set → forcing PAPER');
    CONFIG.TRADE_MODE = 'PAPER';
}

CONFIG.IS_LIVE = CONFIG.TRADE_MODE === 'LIVE' && CONFIG.ENABLE_LIVE_TRADING && CONFIG.LIVE_AUTOTRADING_ENABLED;

module.exports = CONFIG;
