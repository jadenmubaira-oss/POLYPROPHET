// ==================== SUPREME DEITY: CLOUD BRAIN ====================
// 24/7 Node.js Server - Ultra-Fast Edition - COMPLETE WITH ALL 8 MODELS

const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');
const cors = require('cors');
const Redis = require('ioredis');
const auth = require('basic-auth');
require('dotenv').config();
const { ethers } = require('ethers');
const axios = require('axios');
const { HttpsProxyAgent } = require('https-proxy-agent');
const https = require('https');

// ==================== PROXY CONFIGURATION ====================
// GLOBAL PROXY: All HTTPS requests go through proxy (required for clob-client)
// Alchemy requests are handled separately with direct connection
const PROXY_URL = process.env.PROXY_URL;
let proxyAgent = null;
const originalAgent = https.globalAgent; // Save original for Alchemy

if (PROXY_URL) {
    try {
        proxyAgent = new HttpsProxyAgent(PROXY_URL);

        // CRITICAL: Override global HTTPS agent for ALL requests
        // This is the ONLY way to force clob-client to use proxy
        https.globalAgent = proxyAgent;

        // Also set axios defaults
        axios.defaults.httpsAgent = proxyAgent;
        axios.defaults.proxy = false;

        const maskedUrl = PROXY_URL.replace(/\/\/.*:.*@/, '//***:***@');
        console.log(`✅ GLOBAL PROXY ACTIVE: ALL HTTPS via ${maskedUrl}`);
        console.log(`   Alchemy calls will use explicit direct agent`);
    } catch (e) {
        console.log(`⚠️ Proxy configuration failed: ${e.message}`);
    }
} else {
    console.log('ℹ️ No PROXY_URL set - CLOB requests will use direct connection');
    console.log('   To bypass Cloudflare on Render, set PROXY_URL in environment');
}

// Export for use in Alchemy calls
const directAgent = originalAgent;

// Helper: Create a JsonRpcProvider that bypasses the global proxy
// Required because Alchemy/RPC calls timeout through the proxy
function createDirectProvider(rpcUrl) {
    // Temporarily restore original agent for this provider
    const savedAgent = https.globalAgent;
    https.globalAgent = originalAgent;
    const provider = new ethers.providers.JsonRpcProvider(rpcUrl);
    https.globalAgent = savedAgent; // Restore proxy agent
    return provider;
}

// Polymarket CLOB Client for Live Trading
let ClobClient = null;
try {
    ClobClient = require('@polymarket/clob-client').ClobClient;
} catch (e) {
    console.log('⚠️ @polymarket/clob-client not installed - LIVE trading will not work');
    console.log('   Run: npm install @polymarket/clob-client');
}

// POLYMARKET CONFIG
const POLY_EXCHANGE = "0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E"; // Mainnet Exchange
const POLY_CHAIN_ID = 137; // Polygon

// USDC on Polygon (Bridged USDC.e - REQUIRED for Polymarket)
const USDC_ADDRESS = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";
const USDC_DECIMALS = 6;
const USDC_ABI = [
    "function balanceOf(address owner) view returns (uint256)",
    "function transfer(address to, uint256 amount) returns (bool)",
    "function decimals() view returns (uint8)",
    "function symbol() view returns (string)"
];

// CTF (Conditional Token Framework) - For redeeming resolved positions
const CTF_ADDRESS = "0x4D97DCd97eC945f40cF65F87097ACe5EA0476045";
const CTF_ABI = [
    "function balanceOf(address owner, uint256 id) view returns (uint256)",
    "function redeemPositions(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] indexSets) external"
];

// Initialize App
const app = express();
app.use(cors());
app.use(express.json()); // CRITICAL: Parse JSON bodies BEFORE any routes

// ==================== PASSWORD PROTECTION ====================
app.use((req, res, next) => {
    // Skip auth for API endpoints (allow UptimeRobot to ping without login)
    if (req.path.startsWith('/api/')) {
        return next();
    }

    const credentials = auth(req);
    const username = process.env.AUTH_USERNAME || 'admin';
    const password = process.env.AUTH_PASSWORD || 'changeme';

    if (!credentials || credentials.name !== username || credentials.pass !== password) {
        res.statusCode = 401;
        res.setHeader('WWW-Authenticate', 'Basic realm="Supreme Deity"');
        res.end('Access denied');
    } else {
        next();
    }
});

app.use(express.static('public'));
const server = http.createServer(app);

// ==================== REDIS SETUP (FALLBACK-SAFE) ====================
let redis = null;
let redisAvailable = false;

if (process.env.REDIS_URL) {
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
            log('✅ Redis Connected - Persistence Enabled');
        });

        redis.on('error', (err) => {
            redisAvailable = false;
            log(`⚠️ Redis Error: ${err.message} - Using memory fallback`);
        });
    } catch (e) {
        log(`⚠️ Redis Init Failed: ${e.message} - Using memory fallback`);
    }
} else {
    log('⚠️ REDIS_URL not set - Using ephemeral storage');
}

// ==================== IMMUTABLE DATA LAYER (Node.js Port) ====================
const ASSETS = ['BTC', 'ETH', 'SOL', 'XRP'];
const GAMMA_API = 'https://gamma-api.polymarket.com';
const CLOB_API = 'https://clob.polymarket.com';
const WS_ENDPOINT = 'wss://ws-live-data.polymarket.com';
const INTERVAL_SECONDS = 900;

// State
let livePrices = {};
let checkpointPrices = {};
let previousCheckpointPrices = {}; // For outcome evaluation
let lastEvaluatedCheckpoint = {}; // Track last evaluated checkpoint to prevent double-counting
let priceHistory = {};
let marketOddsHistory = {};
let currentMarkets = {};
let lastUpdateTimestamp = Date.now();
let fearGreedIndex = 50;
let fundingRates = {};

// Initialize State
ASSETS.forEach(asset => {
    priceHistory[asset] = [];
    checkpointPrices[asset] = null;
    previousCheckpointPrices[asset] = null;
    lastEvaluatedCheckpoint[asset] = 0; // Initialize to 0
    livePrices[asset] = null;
    currentMarkets[asset] = null;
    marketOddsHistory[asset] = [];
});

// ==================== SUPREME MULTI-MODE TRADING CONFIG ====================
const CONFIG = {
    // API Keys - .trim() removes any hidden newlines/spaces from env vars
    POLYMARKET_API_KEY: (process.env.POLYMARKET_API_KEY || '019aed53-b71a-7065-9115-c35883302725').trim(),
    POLYMARKET_SECRET: (process.env.POLYMARKET_SECRET || 'V83h0eNxG3q01pO8Fo8FGVwGt2axzhVM-emscfT-VYU=').trim(),
    POLYMARKET_PASSPHRASE: (process.env.POLYMARKET_PASSPHRASE || '69ab26964415369000386c9df6f9a69b6909a56f216959467da4eb843d8acae7').trim(),
    POLYMARKET_ADDRESS: (process.env.POLYMARKET_ADDRESS || '0xcd03c2a5d1008205205f66a6541e9ea6ecdd1c59').trim(),
    POLYMARKET_PRIVATE_KEY: (process.env.POLYMARKET_PRIVATE_KEY || '0x0a9e6f3f2e3011b91c40706193a9088dc440c40350b1ce30af2bcad362e10ec0').trim(),

    // Core Trading Settings
    TRADE_MODE: process.env.TRADE_MODE || 'PAPER',
    PAPER_BALANCE: parseFloat(process.env.PAPER_BALANCE || '1000'),
    LIVE_BALANCE: parseFloat(process.env.LIVE_BALANCE || '1000'),  // Configurable live balance
    MAX_POSITION_SIZE: parseFloat(process.env.MAX_POSITION_SIZE || '0.10'),
    MAX_POSITIONS_PER_ASSET: 2,  // Max simultaneous positions per asset

    // ==================== MULTI-MODE SYSTEM ====================
    MULTI_MODE_ENABLED: true,    // Master switch for multi-mode operation

    // MODE 1: ORACLE 🔮 - Final outcome prediction with near-certainty
    // FIX: Lowered thresholds to enable actual trading (was too strict!)
    ORACLE: {
        enabled: true,
        aggression: 50,          // 🔮 NEW: 0-100 scale (0=conservative, 100=aggressive)
        minConsensus: 0.70,      // 70%+ of models agree (was 85%)
        minConfidence: 0.75,     // 75%+ confidence required (was 92%!)
        minEdge: 8,              // 8%+ edge over market (was 15%)
        requireTrending: false,  // Allow all regimes (was true - blocked most!)
        requireMomentum: false,  // Don't require perfect timing (was true)
        maxOdds: 0.85,           // Buy at ≤85% (was 70%)
        minStability: 3          // 3 ticks stable (was 5)
    },

    // MODE 2: ARBITRAGE 📊 - Buy mispriced odds, sell when corrected
    ARBITRAGE: {
        enabled: true,
        minMispricing: 0.15,     // 15%+ difference between fair value and odds
        targetProfit: 0.50,      // Exit at 50% profit
        maxHoldTime: 600,        // Exit after 10 mins max
        stopLoss: 0.30           // Exit at 30% loss
    },

    // MODE 3: SCALP 🎯 - Buy ultra-cheap, exit at 2-3x
    SCALP: {
        enabled: true,
        maxEntryPrice: 0.20,     // Only buy under 20¢
        targetMultiple: 2.0,     // Exit at 2x
        requireLean: true,       // Must lean (>55%) our direction
        exitBeforeEnd: 120       // Exit 2 mins before checkpoint
    },

    // MODE 4: UNCERTAINTY 🌊 - Trade volatility/reversion
    UNCERTAINTY: {
        enabled: true,
        extremeThreshold: 0.80,  // Entry when odds >80% or <20%
        volatilityMin: 0.02,     // Minimum ATR ratio
        targetReversion: 0.60,   // Exit when odds hit 60%/40%
        stopLoss: 0.25           // Exit at 25% loss
    },

    // MODE 5: MOMENTUM 🚀 - Ride strong mid-cycle trends
    MOMENTUM: {
        enabled: true,
        minElapsed: 300,         // Only after 5 mins
        breakoutThreshold: 0.03, // 3% price breakout
        minConsensus: 0.75,      // 75%+ model agreement
        exitOnReversal: true,    // Exit on first reversal sign
        exitBeforeEnd: 180       // Exit 3 mins before checkpoint
    },

    // Risk Management
    RISK: {
        maxTotalExposure: 0.30,  // Max 30% of bankroll at risk
        globalStopLoss: 0.20,   // -20% day = stop trading
        globalStopLossOverride: false, // 🔓 Set to true to bypass global stop loss
        cooldownAfterLoss: 300   // 5 min cooldown after loss
    }
};

// ==================== ENHANCED TRADE EXECUTOR (Multi-Position) ====================
class TradeExecutor {
    constructor() {
        this.mode = CONFIG.TRADE_MODE;
        this.paperBalance = CONFIG.PAPER_BALANCE;
        this.startingBalance = CONFIG.PAPER_BALANCE;
        this.positions = {};           // { 'BTC_1': { mode, side, size, entry, time, target, stopLoss } }
        this.wallet = null;
        this.tradeHistory = [];
        this.lastLossTime = 0;         // For cooldown tracking
        this.todayPnL = 0;             // Daily P/L tracking
        this.lastDayReset = Date.now(); // Track when we last reset daily P/L
        this.cachedLiveBalance = 0;    // Cached USDC balance for LIVE mode
        this.lastGoodBalance = 0;      // Last known successful balance (prevents $0 flash)
        this.lastBalanceFetch = 0;     // Timestamp of last balance fetch

        if (CONFIG.POLYMARKET_PRIVATE_KEY) {
            try {
                // CRITICAL FIX: Use direct provider (bypasses proxy for RPC calls)
                // NOTE: Using ethers v5 syntax (required by @polymarket/clob-client)
                const provider = createDirectProvider('https://polygon-mainnet.g.alchemy.com/v2/demo');
                // DEBUG: Log private key prefix to verify correct key is loaded
                const keyPreview = CONFIG.POLYMARKET_PRIVATE_KEY.substring(0, 10);
                log(`🔑 Loading wallet from key: ${keyPreview}...`);
                this.wallet = new ethers.Wallet(CONFIG.POLYMARKET_PRIVATE_KEY, provider);
                // NOTE: ethers v5 natively has _signTypedData - no wrapper needed
                log(`✅ Wallet Loaded: ${this.wallet.address}`);
            } catch (e) {
                log(`⚠️ Wallet Load Failed: ${e.message}`);
                log(`🔑 Key starts with: ${CONFIG.POLYMARKET_PRIVATE_KEY?.substring(0, 10) || 'UNDEFINED'}`);
            }
        } else {
            log(`⚠️ No POLYMARKET_PRIVATE_KEY found in environment!`);
        }
        log(`💰 Trade Executor Initialized in ${this.mode} mode. Balance: $${this.paperBalance}`);

        // DEBUG: Log credential sources to verify env vars are loaded
        const apiKeySource = process.env.POLYMARKET_API_KEY ? 'ENV' : 'FALLBACK';
        const secretSource = process.env.POLYMARKET_SECRET ? 'ENV' : 'FALLBACK';
        const passphraseSource = process.env.POLYMARKET_PASSPHRASE ? 'ENV' : 'FALLBACK';
        const privateKeySource = process.env.POLYMARKET_PRIVATE_KEY ? 'ENV' : 'FALLBACK';
        log(`🔐 API Credentials Source:`);
        log(`   API Key: ${CONFIG.POLYMARKET_API_KEY?.substring(0, 12)}... [${apiKeySource}]`);
        log(`   Secret: ${CONFIG.POLYMARKET_SECRET?.substring(0, 12)}... [${secretSource}]`);
        log(`   Passphrase: ${CONFIG.POLYMARKET_PASSPHRASE?.substring(0, 12)}... [${passphraseSource}]`);
        log(`   Private Key: ${CONFIG.POLYMARKET_PRIVATE_KEY?.substring(0, 12)}... [${privateKeySource}]`);
    }

    reloadWallet() {
        this.mode = CONFIG.TRADE_MODE;
        if (CONFIG.POLYMARKET_PRIVATE_KEY) {
            try {
                // CRITICAL FIX: Use direct provider (bypasses proxy for RPC calls)
                // NOTE: Using ethers v5 syntax (required by @polymarket/clob-client)
                const provider = createDirectProvider('https://polygon-mainnet.g.alchemy.com/v2/demo');
                const keyPreview = CONFIG.POLYMARKET_PRIVATE_KEY.substring(0, 10);
                log(`🔑 Reloading wallet from key: ${keyPreview}...`);
                this.wallet = new ethers.Wallet(CONFIG.POLYMARKET_PRIVATE_KEY, provider);
                // NOTE: ethers v5 natively has _signTypedData - no wrapper needed
                log(`✅ Wallet Reloaded: ${this.wallet.address}`);
                return true;
            } catch (e) {
                log(`⚠️ Wallet Reload Failed: ${e.message}`);
                return false;
            }
        }
        return false;
    }

    // Count active positions for an asset
    getPositionCount(asset) {
        return Object.keys(this.positions).filter(k => k.startsWith(asset)).length;
    }

    // Calculate total exposure
    getTotalExposure() {
        return Object.values(this.positions).reduce((sum, p) => sum + p.size, 0);
    }

    // Check if in cooldown after loss
    isInCooldown() {
        if (this.lastLossTime === 0) return false;
        return (Date.now() - this.lastLossTime) < (CONFIG.RISK.cooldownAfterLoss * 1000);
    }

    // 🔄 CRITICAL: Reset daily P/L at the start of each new day
    // This prevents global stop loss from permanently halting trading
    resetDailyPnL() {
        const now = new Date();
        const lastReset = new Date(this.lastDayReset);

        // Check if it's a new day (different date)
        if (now.toDateString() !== lastReset.toDateString()) {
            const previousPnL = this.todayPnL;
            this.todayPnL = 0;
            this.lastDayReset = Date.now();
            log(`🔄 NEW DAY: Daily P/L reset (was $${previousPnL.toFixed(2)})`);
            return true;
        }
        return false;
    }

    // Refresh cached LIVE balance (call every 30s or before trades)
    async refreshLiveBalance() {
        if (this.mode !== 'LIVE' || !this.wallet) return;

        // Only refresh if cache is older than 30 seconds AND we have cached balance
        // If we have NO cached balance, always try to fetch
        const cacheValid = Date.now() - this.lastBalanceFetch < 30000 && this.cachedLiveBalance > 0;
        if (cacheValid) return;

        // Keep track of last KNOWN GOOD balance (never $0 unless truly empty)
        const lastGoodBalance = this.cachedLiveBalance || this.lastGoodBalance || 0;

        try {
            const result = await this.getUSDCBalance();
            if (result.success && result.balance !== undefined) {
                this.cachedLiveBalance = result.balance;
                this.lastGoodBalance = result.balance; // Store as known good
                this.lastBalanceFetch = Date.now();
                log(`💰 Live balance updated: $${this.cachedLiveBalance.toFixed(2)}`);
            } else {
                // Fetch returned but wasn't successful - keep last known good
                log(`⚠️ Balance fetch returned failure, using last known: $${lastGoodBalance.toFixed(2)}`);
                if (lastGoodBalance > 0) {
                    this.cachedLiveBalance = lastGoodBalance;
                }
            }
        } catch (e) {
            log(`⚠️ Balance refresh failed: ${e.message}`);
            // CRITICAL: Use last known good balance instead of leaving at 0
            if (lastGoodBalance > 0) {
                this.cachedLiveBalance = lastGoodBalance;
                log(`   Using last known balance: $${lastGoodBalance.toFixed(2)}`);
            }
        }
    }

    // ENTRY: Execute a trade for any mode
    async executeTrade(asset, direction, mode, confidence, entryPrice, market, options = {}) {
        log(`🔍 executeTrade called: ${asset} ${direction} ${mode} @ ${(entryPrice * 100).toFixed(1)}¢`, asset);

        if (!market) {
            log(`❌ TRADE BLOCKED: No market data for ${asset}`, asset);
            return { success: false, error: 'No market data available' };
        }

        if (!market.tokenIds) {
            log(`❌ TRADE BLOCKED: No token IDs for ${asset} market`, asset);
            return { success: false, error: 'No token IDs - market not tradeable yet' };
        }

        // ENTRY PRICE GUARD: REMOVED - Bot learns from all trades, even at extreme prices
        // The bot's learning loop will naturally penalize bad patterns
        // User requested: allow 2¢-99¢ trades if confident

        // COOLDOWN: REMOVED - Bot learns from each trade/decision
        // User requested: no cooldown as long as bot is learning

        // Check max positions per asset
        if (this.getPositionCount(asset) >= CONFIG.MAX_POSITIONS_PER_ASSET) {
            log(`⚠️ Max positions (${CONFIG.MAX_POSITIONS_PER_ASSET}) reached for ${asset}`, asset);
            return { success: false, error: `Max positions (${CONFIG.MAX_POSITIONS_PER_ASSET}) for ${asset}` };
        }

        // Refresh LIVE balance if needed
        if (this.mode === 'LIVE') {
            await this.refreshLiveBalance();
        }

        // Check total exposure
        const totalExposure = this.getTotalExposure();
        // Use REAL wallet balance for LIVE mode, paper balance for PAPER
        const bankroll = this.mode === 'LIVE' ? (this.cachedLiveBalance || CONFIG.LIVE_BALANCE || 1000) : this.paperBalance;
        if (totalExposure / bankroll > CONFIG.RISK.maxTotalExposure) {
            log(`⚠️ Max total exposure (${CONFIG.RISK.maxTotalExposure * 100}%) reached`, asset);
            return { success: false, error: `Max exposure (${(CONFIG.RISK.maxTotalExposure * 100).toFixed(0)}%) reached` };
        }

        // 🔄 DAILY P/L RESET: Check if new day and reset if needed
        this.resetDailyPnL();

        // 🛑 GLOBAL STOP LOSS: Halt trading if day loss exceeds threshold
        // Can be bypassed with CONFIG.RISK.globalStopLossOverride = true
        const maxDayLoss = bankroll * CONFIG.RISK.globalStopLoss;
        if (!CONFIG.RISK.globalStopLossOverride && this.todayPnL < -maxDayLoss) {
            log(`🛑 GLOBAL STOP LOSS: Daily loss $${Math.abs(this.todayPnL).toFixed(2)} exceeds ${CONFIG.RISK.globalStopLoss * 100}% of bankroll`, asset);
            log(`   To override: Set RISK.globalStopLossOverride = true in Settings`, asset);
            return { success: false, error: `Global stop loss triggered - trading halted for the day. Override available in Settings.` };
        }

        // Calculate position size (mode-specific)
        // CRITICAL FIX: Manual trades use user-specified size
        let size;
        if (options.manualSize && options.manualSize > 0) {
            size = options.manualSize;
            log(`📝 Using manual size: $${size.toFixed(2)}`, asset);
        } else {
            // SMART SIZING: Scale percentage based on bankroll
            // For small bankrolls: use minimum viable size
            // For large bankrolls: use percentage-based sizing
            const MIN_ORDER = 1.10; // Polymarket minimum + fee buffer
            const MAX_FRACTION = 0.30; // Never risk more than 30% on one trade

            // Calculate base percentage
            let basePct;
            switch (mode) {
                case 'ORACLE':
                    basePct = Math.min(0.15, confidence * 0.15); // Up to 15% at max confidence
                    break;
                case 'SCALP':
                    basePct = 0.08; // 8% for scalps - quick in/out
                    break;
                case 'ARBITRAGE':
                case 'UNCERTAINTY':
                    basePct = 0.08;
                    break;
                case 'MOMENTUM':
                    basePct = 0.10; // 10% for momentum - confident trades
                    break;
                default:
                    basePct = 0.08;
            }

            // Calculate size based on actual bankroll
            size = bankroll * basePct;

            // SMART MINIMUM: Ensure we meet $1.10 minimum
            // If percentage-based size is too small, use minimum (if affordable)
            if (size < MIN_ORDER) {
                if (bankroll >= MIN_ORDER * 1.5) {
                    // Have enough for minimum + buffer, use minimum
                    size = MIN_ORDER;
                    log(`📊 Size bumped to minimum $${MIN_ORDER} (bankroll: $${bankroll.toFixed(2)})`, asset);
                } else {
                    // Too small to trade safely
                    log(`❌ TRADE BLOCKED: Bankroll $${bankroll.toFixed(2)} too small for safe trading`, asset);
                    return { success: false, error: `Need at least $${(MIN_ORDER * 1.5).toFixed(2)} to trade` };
                }
            }

            // CAP: Never risk more than MAX_FRACTION of bankroll
            const maxSize = bankroll * MAX_FRACTION;
            if (size > maxSize) {
                size = maxSize;
                log(`📊 Size capped to ${(MAX_FRACTION * 100).toFixed(0)}% of bankroll: $${size.toFixed(2)}`, asset);
            }
        }

        // FINAL MINIMUM CHECK: Polymarket requires $1 minimum
        const minDollars = 1.10;
        if (size < minDollars) {
            log(`❌ TRADE BLOCKED: $${size.toFixed(2)} below $${minDollars} minimum`, asset);
            return { success: false, error: `Minimum order size is $${minDollars}` };
        }

        const tokenType = direction === 'UP' ? 'YES' : 'NO';
        const positionId = `${asset}_${Date.now()}`;

        // Determine targets based on mode
        let target, stopLoss;
        switch (mode) {
            case 'ORACLE':
                target = null; // Hold to resolution
                stopLoss = null;
                break;
            case 'SCALP':
                target = entryPrice * CONFIG.SCALP.targetMultiple;
                stopLoss = entryPrice * 0.5;
                break;
            case 'ARBITRAGE':
                target = entryPrice * (1 + CONFIG.ARBITRAGE.targetProfit);
                stopLoss = entryPrice * (1 - CONFIG.ARBITRAGE.stopLoss);
                break;
            case 'UNCERTAINTY':
                target = direction === 'UP' ? CONFIG.UNCERTAINTY.targetReversion : (1 - CONFIG.UNCERTAINTY.targetReversion);
                stopLoss = entryPrice * (1 - CONFIG.UNCERTAINTY.stopLoss);
                break;
            case 'MOMENTUM':
                target = null; // Exit on reversal
                stopLoss = entryPrice * 0.8;
                break;
        }

        log(``, asset);
        log(`🎯 ═══════════════════════════════════════`, asset);
        log(`🎯 ${mode} TRADE ENTRY`, asset);
        log(`🎯 Direction: ${direction} (${tokenType})`, asset);
        log(`🎯 Entry: ${(entryPrice * 100).toFixed(1)}¢`, asset);
        log(`🎯 Size: $${size.toFixed(2)}`, asset);
        if (target) log(`🎯 Target: ${(target * 100).toFixed(1)}¢`, asset);
        if (stopLoss) log(`🎯 Stop: ${(stopLoss * 100).toFixed(1)}¢`, asset);
        log(`🎯 ═══════════════════════════════════════`, asset);

        if (this.mode === 'PAPER') {
            const balanceBefore = this.paperBalance;
            this.paperBalance -= size;
            this.positions[positionId] = {
                asset,
                mode,
                side: direction,
                tokenType,
                size,
                entry: entryPrice,
                time: Date.now(),
                target,
                stopLoss,
                shares: size / entryPrice
            };

            this.tradeHistory.push({
                id: positionId,
                asset,
                mode,
                side: direction,
                entry: entryPrice,
                size,
                time: Date.now(),
                status: 'OPEN'
            });

            log(`📝 PAPER FILL: Bought ${(size / entryPrice).toFixed(1)} shares @ ${(entryPrice * 100).toFixed(1)}¢`, asset);
            log(`💰 Balance: $${balanceBefore.toFixed(2)} → $${this.paperBalance.toFixed(2)} (-$${size.toFixed(2)})`, asset);
            return { success: true, positionId, mode: 'PAPER' };
        }

        // LIVE TRADING MODE - ACTUAL EXECUTION
        if (this.mode === 'LIVE') {
            log(`🔴 LIVE TRADE EXECUTION - ${mode} ${direction} $${size.toFixed(2)} @ ${(entryPrice * 100).toFixed(1)}¢`, asset);

            // Check if CLOB Client is available
            if (!ClobClient) {
                log(`❌ LIVE TRADING FAILED: @polymarket/clob-client not installed`, asset);
                log(`   Run: npm install @polymarket/clob-client`, asset);
                return { success: false, error: 'CLOB client not installed. Run: npm install @polymarket/clob-client' };
            }

            // Check if we have the required credentials
            if (!CONFIG.POLYMARKET_API_KEY || !CONFIG.POLYMARKET_SECRET || !CONFIG.POLYMARKET_PASSPHRASE) {
                log(`❌ LIVE TRADING FAILED: Missing API credentials`, asset);
                return { success: false, error: 'Missing API credentials (key/secret/passphrase)' };
            }

            if (!this.wallet) {
                log(`❌ LIVE TRADING FAILED: No wallet loaded`, asset);
                return { success: false, error: 'No wallet loaded. Add private key in Settings.' };
            }

            // Get Token ID for the market
            if (!market.tokenIds) {
                log(`❌ LIVE TRADING FAILED: No token IDs for market`, asset);
                return { success: false, error: 'No token IDs for this market yet' };
            }

            const tokenId = tokenType === 'YES' ? market.tokenIds.yes : market.tokenIds.no;

            try {
                // Initialize CLOB Client
                // CRITICAL FIX: creds is 4th param (not 5th)
                // ApiKeyCreds interface uses 'key' not 'apiKey'
                // SANITIZE: Remove any non-printable ASCII characters from credentials
                const sanitizedPassphrase = CONFIG.POLYMARKET_PASSPHRASE.replace(/[^\x20-\x7E]/g, '');

                if (sanitizedPassphrase !== CONFIG.POLYMARKET_PASSPHRASE) {
                    log(`⚠️ Passphrase had invalid chars removed. Original length: ${CONFIG.POLYMARKET_PASSPHRASE.length}, New: ${sanitizedPassphrase.length}`, asset);
                }

                const clobClient = new ClobClient(
                    'https://clob.polymarket.com',
                    POLY_CHAIN_ID,
                    this.wallet,
                    {
                        key: CONFIG.POLYMARKET_API_KEY.replace(/[^\x20-\x7E]/g, ''),
                        secret: CONFIG.POLYMARKET_SECRET.replace(/[^\x20-\x7E]/g, ''),
                        passphrase: sanitizedPassphrase
                    }
                );

                // Calculate shares to buy
                const shares = Math.floor((size / entryPrice) * 1e6) / 1e6; // 6 decimal precision

                log(`📝 Placing order: BUY ${shares.toFixed(2)} shares of ${tokenType} @ ${(entryPrice * 100).toFixed(1)}¢`, asset);

                // Create and submit limit order
                const order = await clobClient.createOrder({
                    tokenID: tokenId,
                    price: entryPrice,
                    size: shares,
                    side: 'BUY',
                    feeRateBps: 0
                });

                const response = await clobClient.postOrder(order);

                if (response && response.orderID) {
                    log(`✅ LIVE ORDER PLACED: ${response.orderID}`, asset);
                    log(`🎯 Status: ${response.status || 'SUBMITTED'}`, asset);

                    // FAILSAFE: Verify order fill with retry logic
                    let fillStatus = 'UNVERIFIED';
                    let actualShares = shares;
                    for (let attempt = 1; attempt <= 3; attempt++) {
                        await new Promise(r => setTimeout(r, 2000));
                        try {
                            const orderStatus = await clobClient.getOrder(response.orderID);
                            if (orderStatus) {
                                fillStatus = orderStatus.status || 'UNKNOWN';
                                if (['FILLED', 'MATCHED', 'LIVE'].includes(fillStatus.toUpperCase())) {
                                    log(`✅ Order CONFIRMED: ${fillStatus}`, asset);
                                    if (orderStatus.size_matched) {
                                        actualShares = parseFloat(orderStatus.size_matched);
                                    }
                                    break;
                                } else if (['CANCELLED', 'EXPIRED', 'REJECTED'].includes(fillStatus.toUpperCase())) {
                                    log(`❌ Order ${fillStatus} - trade failed`, asset);
                                    return { success: false, error: `Order was ${fillStatus}` };
                                }
                            }
                            log(`⏳ Fill check ${attempt}/3: ${fillStatus}`, asset);
                        } catch (pollErr) {
                            log(`⚠️ Fill check ${attempt}/3 failed: ${pollErr.message}`, asset);
                        }
                    }
                    if (fillStatus === 'UNVERIFIED') {
                        log(`⚠️ Order fill unconfirmed after 6s - tracking with caution`, asset);
                    }

                    // Store position with order details
                    this.positions[positionId] = {
                        asset,
                        mode,
                        side: direction,
                        tokenType,
                        size,
                        entry: entryPrice,
                        time: Date.now(),
                        target,
                        stopLoss,
                        shares,
                        isLive: true,
                        status: 'LIVE_OPEN',
                        orderID: response.orderID,
                        tokenId: tokenId
                    };

                    this.tradeHistory.push({
                        id: positionId,
                        asset,
                        mode,
                        side: direction,
                        entry: entryPrice,
                        size,
                        shares,
                        time: Date.now(),
                        status: 'LIVE_OPEN',
                        orderID: response.orderID
                    });

                    return { success: true, positionId, mode: 'LIVE' };
                } else {
                    const errorDetail = response ? JSON.stringify(response) : 'No response';
                    log(`❌ Order submission failed: ${errorDetail}`, asset);
                    // Return more specific error based on response
                    let errorMsg = 'Order submission failed';
                    if (response?.error) errorMsg = response.error;
                    else if (response?.message) errorMsg = response.message;
                    else if (typeof response === 'string') errorMsg = response;
                    else errorMsg = `API rejected: ${errorDetail.substring(0, 100)}`;
                    return { success: false, error: errorMsg };
                }

            } catch (e) {
                log(`❌ LIVE TRADE ERROR: ${e.message}`, asset);
                // Log stack trace for debugging
                if (e.stack) {
                    const stackLines = e.stack.split('\n').slice(0, 3).join('\n');
                    log(`   Stack: ${stackLines}`, asset);
                }
                // Check for specific known errors
                if (e.message.includes('signTypedData') || e.message.includes('_signTypedData')) {
                    log(`   FIX: ethers v6 compatibility issue - wallet._signTypedData wrapper may be missing`, asset);
                }
                if (e.message.includes('ENOTFOUND') || e.message.includes('ECONNREFUSED')) {
                    log(`   FIX: Network/DNS issue - check internet connection`, asset);
                }
                if (e.message.includes('401') || e.message.includes('403') || e.message.includes('Unauthorized')) {
                    log(`   FIX: API credentials may be invalid - check API key, secret, passphrase`, asset);
                }
                return { success: false, error: e.message };
            }
        }

        return { success: false, error: 'Unknown mode - not PAPER or LIVE' };
    }

    // LIVE MODE: Execute sell order to close position
    async executeSellOrder(position) {
        if (!ClobClient || !this.wallet || !position.tokenId) {
            log(`⚠️ Cannot execute live sell - missing CLOB client, wallet, or tokenId`, position.asset);
            return { success: false, error: 'Missing requirements' };
        }

        try {
            // CRITICAL FIX: creds is 4th param (not 5th)
            // ApiKeyCreds interface uses 'key' not 'apiKey'
            // SANITIZE: Remove any non-printable ASCII characters from credentials
            const clobClient = new ClobClient(
                'https://clob.polymarket.com',
                POLY_CHAIN_ID,
                this.wallet,
                {
                    key: CONFIG.POLYMARKET_API_KEY.replace(/[^\x20-\x7E]/g, ''),
                    secret: CONFIG.POLYMARKET_SECRET.replace(/[^\x20-\x7E]/g, ''),
                    passphrase: CONFIG.POLYMARKET_PASSPHRASE.replace(/[^\x20-\x7E]/g, '')
                }
            );

            // Sell at market price (low price to ensure fill)
            const sellPrice = 0.01;
            const order = await clobClient.createOrder({
                tokenID: position.tokenId,
                price: sellPrice,
                size: position.shares,
                side: 'SELL',
                feeRateBps: 0
            });

            const response = await clobClient.postOrder(order);
            if (response && response.orderID) {
                log(`📤 LIVE SELL ORDER: ${response.orderID}`, position.asset);
                return { success: true, orderID: response.orderID };
            } else {
                log(`❌ Sell order failed: ${JSON.stringify(response)}`, position.asset);
                return { success: false, error: 'Order rejected' };
            }
        } catch (e) {
            log(`❌ Live sell error: ${e.message}`, position.asset);
            return { success: false, error: e.message };
        }
    }

    // CRITICAL: Sell with retry logic - keeps trying until sold or max attempts
    async executeSellOrderWithRetry(position, maxAttempts = 5, delayMs = 3000) {
        log(`🔄 SELL RETRY: Starting sell attempts for ${position.asset} (max ${maxAttempts} attempts)`, position.asset);

        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            log(`📤 Sell attempt ${attempt}/${maxAttempts}...`, position.asset);

            const result = await this.executeSellOrder(position);

            if (result.success) {
                log(`✅ SELL SUCCESS on attempt ${attempt}: ${result.orderID}`, position.asset);
                // Remove from pending sells if it was there
                if (this.pendingSells) {
                    delete this.pendingSells[position.asset + '_' + position.tokenId];
                }
                return result;
            }

            if (attempt < maxAttempts) {
                log(`⏳ Sell failed, waiting ${delayMs / 1000}s before retry...`, position.asset);
                await new Promise(r => setTimeout(r, delayMs));
            }
        }

        // 🔮 ENHANCED: All attempts failed - add to pending sells with COMPLETE redemption info
        log(`❌ SELL FAILED after ${maxAttempts} attempts - position added to pending sells!`, position.asset);
        if (!this.pendingSells) this.pendingSells = {};

        // Get market info for additional context
        const market = currentMarkets[position.asset] || {};

        this.pendingSells[position.asset + '_' + position.tokenId] = {
            ...position,
            failedAt: Date.now(),
            attempts: maxAttempts,
            // 🔮 COMPLETE REDEMPTION INFO
            marketSlug: market.slug || 'unknown',
            marketUrl: market.slug ? `https://polymarket.com/event/${market.slug}` : null,
            conditionId: market.conditionId || position.conditionId || null,
            polygonscanUrl: position.tokenId ? `https://polygonscan.com/token/0x4D97DCd97eC945f40cF65F87097ACe5EA0476045?a=${position.tokenId}` : null,
            ctfContract: '0x4D97DCd97eC945f40cF65F87097ACe5EA0476045', // CTF Token Address
            usdcContract: USDC_ADDRESS,
            redemptionInstructions: [
                '1. Go to PolygonScan link above',
                '2. Connect your wallet that holds the shares',
                '3. If market resolved in your favor, use "redeemPositions" on CTF contract',
                '4. If still active, manually sell on Polymarket.com',
                '5. Keep tokenId and conditionId for reference'
            ]
        };

        return { success: false, error: `Failed after ${maxAttempts} attempts`, needsManualIntervention: true };
    }

    // Get pending sells that need manual intervention
    getPendingSells() {
        return this.pendingSells || {};
    }

    // Manual sell - for UI button
    async manualSell(positionId) {
        const pos = this.positions[positionId];
        if (!pos) {
            // Check pending sells
            for (const [key, pending] of Object.entries(this.pendingSells || {})) {
                if (key.startsWith(positionId) || pending.tokenId === positionId) {
                    const result = await this.executeSellOrderWithRetry(pending, 3, 2000);
                    if (result.success) {
                        delete this.pendingSells[key];
                    }
                    return result;
                }
            }
            return { success: false, error: 'Position not found' };
        }

        if (!pos.isLive || this.mode !== 'LIVE') {
            // Paper mode - just close it
            const market = currentMarkets[pos.asset];
            const exitPrice = pos.side === 'UP' ? (market?.yesPrice || 0.5) : (market?.noPrice || 0.5);
            this.closePosition(positionId, exitPrice, 'MANUAL SELL');
            return { success: true, paper: true };
        }

        // Live mode - execute with retry
        const result = await this.executeSellOrderWithRetry(pos, 3, 2000);
        if (result.success) {
            const market = currentMarkets[pos.asset];
            const exitPrice = pos.side === 'UP' ? (market?.yesPrice || 0.5) : (market?.noPrice || 0.5);
            this.closePosition(positionId, exitPrice, 'MANUAL SELL');
        }
        return result;
    }

    // Manual buy - for UI button
    async manualBuy(asset, direction, size) {
        const market = currentMarkets[asset];
        if (!market) {
            log(`❌ MANUAL BUY FAILED: No market data for ${asset}`, asset);
            return { success: false, error: 'No market data for ' + asset };
        }

        if (!market.tokenIds) {
            log(`❌ MANUAL BUY FAILED: No token IDs for ${asset}`, asset);
            return { success: false, error: 'No token IDs for market - try refreshing' };
        }

        const entryPrice = direction === 'UP' ? market.yesPrice : market.noPrice;
        const brain = Brains[asset];
        const confidence = brain ? brain.confidence : 0.5;

        log(`📝 MANUAL BUY: ${asset} ${direction} $${size} @ ${(entryPrice * 100).toFixed(1)}¢`, asset);

        // executeTrade now returns object with success/error
        const result = await this.executeTrade(asset, direction, 'MANUAL', confidence, entryPrice, market, {
            manualTrade: true,
            manualSize: size
        });

        if (result && result.success) {
            log(`✅ MANUAL BUY SUCCESS: Position ${result.positionId}`, asset);
            return { success: true, positionId: result.positionId, entryPrice };
        } else {
            const errorMsg = result?.error || 'Unknown error';
            log(`❌ MANUAL BUY FAILED: ${errorMsg}`, asset);
            return { success: false, error: errorMsg };
        }
    }

    // EXIT: Close a position
    closePosition(positionId, exitPrice, reason) {
        const pos = this.positions[positionId];
        if (!pos) return;

        // LIVE MODE: Execute actual sell order WITH RETRY
        if (pos.isLive && this.mode === 'LIVE') {
            log(`📤 Executing LIVE sell order with retry for ${pos.asset} ${pos.side}...`, pos.asset);
            // Use async retry - don't block
            this.executeSellOrderWithRetry(pos, 5, 3000).then(result => {
                if (result.success) {
                    log(`✅ Live sell executed: ${result.orderID}`, pos.asset);
                } else if (result.needsManualIntervention) {
                    log(`🚨 MANUAL INTERVENTION REQUIRED: ${pos.asset} sell failed - check /api/pending-sells`, pos.asset);
                } else {
                    log(`⚠️ Live sell issue: ${result.error}`, pos.asset);
                }
            }).catch(e => {
                log(`❌ Live sell retry failed: ${e.message}`, pos.asset);
            });
        }

        const pnl = (exitPrice - pos.entry) * pos.shares;
        const pnlPercent = ((exitPrice / pos.entry) - 1) * 100;

        this.paperBalance += pos.size + pnl;
        this.todayPnL += pnl;

        const emoji = pnl >= 0 ? '✅' : '❌';
        log(``, pos.asset);
        log(`${emoji} ═══════════════════════════════════════`, pos.asset);
        log(`${emoji} ${pos.mode} TRADE EXIT: ${reason}`, pos.asset);
        log(`${emoji} Direction: ${pos.side}`, pos.asset);
        log(`${emoji} Entry: ${(pos.entry * 100).toFixed(1)}¢ → Exit: ${(exitPrice * 100).toFixed(1)}¢`, pos.asset);
        log(`${emoji} P/L: ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)} (${pnlPercent >= 0 ? '+' : ''}${pnlPercent.toFixed(1)}%)`, pos.asset);
        log(`${emoji} Balance: $${this.paperBalance.toFixed(2)}`, pos.asset);
        log(`${emoji} ═══════════════════════════════════════`, pos.asset);

        // Update trade history
        const trade = this.tradeHistory.find(t => t.id === positionId);
        if (trade) {
            trade.exit = exitPrice;
            trade.pnl = pnl;
            trade.pnlPercent = pnlPercent;
            trade.status = 'CLOSED';
            trade.closeTime = Date.now();
            trade.reason = reason;
        }

        // Cooldown on loss
        if (pnl < 0) {
            this.lastLossTime = Date.now();
        }

        // Add WINNING live positions to redemption queue for later claiming
        // Only if position has a tokenId (live trade) and won (exitPrice = 1.0)
        if (pos.isLive && pos.tokenId && exitPrice >= 0.99) {
            this.addToRedemptionQueue(pos);
        }

        delete this.positions[positionId];
        return pnl;
    }

    // Check all positions for exit conditions
    checkExits(asset, currentPrice, elapsed, yesPrice, noPrice) {
        const now = Date.now();
        const timeToEnd = INTERVAL_SECONDS - elapsed;

        Object.entries(this.positions).forEach(([id, pos]) => {
            if (pos.asset !== asset) return;

            const currentOdds = pos.side === 'UP' ? yesPrice : noPrice;

            // Check mode-specific exits
            switch (pos.mode) {
                case 'SCALP':
                    // Exit at target
                    if (currentOdds >= pos.target) {
                        this.closePosition(id, currentOdds, 'TARGET HIT');
                        return;
                    }
                    // Exit before end
                    if (timeToEnd <= CONFIG.SCALP.exitBeforeEnd) {
                        this.closePosition(id, currentOdds, 'TIME EXIT (before resolution)');
                        return;
                    }
                    break;

                case 'ARBITRAGE':
                    // Exit at target
                    if (currentOdds >= pos.target) {
                        this.closePosition(id, currentOdds, 'ARBITRAGE TARGET');
                        return;
                    }
                    // Max hold time
                    if (now - pos.time > CONFIG.ARBITRAGE.maxHoldTime * 1000) {
                        this.closePosition(id, currentOdds, 'MAX HOLD TIME');
                        return;
                    }
                    break;

                case 'UNCERTAINTY':
                    // Exit at reversion target
                    if (pos.side === 'UP' && currentOdds >= pos.target) {
                        this.closePosition(id, currentOdds, 'REVERSION TARGET');
                        return;
                    }
                    if (pos.side === 'DOWN' && currentOdds <= (1 - CONFIG.UNCERTAINTY.targetReversion)) {
                        this.closePosition(id, currentOdds, 'REVERSION TARGET');
                        return;
                    }
                    break;

                case 'MOMENTUM':
                    // BUG FIX: Add reversal detection (CONFIG.MOMENTUM.exitOnReversal was not implemented)
                    if (CONFIG.MOMENTUM.exitOnReversal) {
                        // Detect reversal: odds moving against our position
                        const oddsMovingAgainst = (pos.side === 'UP' && currentOdds < pos.entry * 0.9) ||
                            (pos.side === 'DOWN' && currentOdds > pos.entry * 1.1);
                        if (oddsMovingAgainst) {
                            this.closePosition(id, currentOdds, 'REVERSAL DETECTED');
                            return;
                        }
                    }
                    // Exit before end
                    if (timeToEnd <= CONFIG.MOMENTUM.exitBeforeEnd) {
                        this.closePosition(id, currentOdds, 'TIME EXIT');
                        return;
                    }
                    break;
            }

            // 🔴 CRITICAL: FORCE EXIT 30 SECONDS BEFORE CYCLE END
            // For LIVE trading: exit early to guarantee sell execution and avoid resolution edge cases
            // ORACLE mode holds to resolution (binary win/loss), all other modes exit early
            if (timeToEnd <= 30 && pos.mode !== 'ORACLE') {
                log(`⏰ PRE-RESOLUTION EXIT: ${pos.mode} ${pos.side} position closing at ${(currentOdds * 100).toFixed(1)}%`, pos.asset);
                this.closePosition(id, currentOdds, 'PRE-RESOLUTION EXIT (30s)');
                return;
            }

            // Universal stop loss (all modes except ORACLE and MANUAL - user controls manual trades)
            if (pos.mode !== 'ORACLE' && pos.mode !== 'MANUAL' && pos.stopLoss && currentOdds <= pos.stopLoss) {
                this.closePosition(id, currentOdds, 'STOP LOSS');
            }
        });
    }

    // Close all positions at checkpoint resolution
    resolveOraclePositions(asset, finalOutcome, yesPrice, noPrice) {
        Object.entries(this.positions).forEach(([id, pos]) => {
            if (pos.asset !== asset || pos.mode !== 'ORACLE') return;

            const won = (pos.side === finalOutcome);
            const exitPrice = won ? 1.0 : 0.0; // Binary resolution
            this.closePosition(id, exitPrice, won ? 'ORACLE WIN' : 'ORACLE LOSS');
        });
    }

    // Close ALL positions at cycle end (not just ORACLE)
    resolveAllPositions(asset, finalOutcome, yesPrice, noPrice) {
        Object.entries(this.positions).forEach(([id, pos]) => {
            if (pos.asset !== asset) return;

            const won = (pos.side === finalOutcome);
            const exitPrice = won ? 1.0 : 0.0; // Binary resolution

            // All modes resolve at cycle end
            const reason = won ? `${pos.mode} WIN ✅` : `${pos.mode} LOSS ❌`;
            log(`🏁 CYCLE END: ${pos.asset} ${pos.side} -> Outcome: ${finalOutcome}`, asset);
            this.closePosition(id, exitPrice, reason);
        });
    }

    // ==================== WALLET MANAGEMENT ====================

    // Get live USDC balance from Polygon - RACE all RPCs for maximum speed
    async getUSDCBalance() {
        if (!this.wallet) {
            return { success: false, error: 'No wallet loaded', balance: 0 };
        }

        const walletAddress = this.wallet.address;
        const rpcEndpoints = [
            'https://polygon-rpc.com',
            'https://rpc.ankr.com/polygon',
            'https://1rpc.io/matic',
            'https://polygon-mainnet.g.alchemy.com/v2/demo'
        ];

        // Race all RPCs - first successful one wins
        const racePromises = rpcEndpoints.map(async (rpc) => {
            const provider = createDirectProvider(rpc);
            const usdcContract = new ethers.Contract(USDC_ADDRESS, USDC_ABI, provider);
            const balance = await usdcContract.balanceOf(walletAddress);
            const formatted = parseFloat(ethers.utils.formatUnits(balance, USDC_DECIMALS));
            return { rpc, balance: formatted, balanceRaw: balance.toString() };
        });

        // Add a 5-second timeout
        const timeoutPromise = new Promise((_, reject) =>
            setTimeout(() => reject(new Error('All RPCs timed out (5s)')), 5000)
        );

        try {
            const result = await Promise.race([
                Promise.any(racePromises),
                timeoutPromise
            ]);
            return {
                success: true,
                balance: result.balance,
                balanceRaw: result.balanceRaw,
                address: walletAddress
            };
        } catch (e) {
            log(`⚠️ USDC balance fetch failed: ${e.message}`);
            return { success: false, error: e.message, balance: 0 };
        }
    }

    // Get MATIC/POL balance (for gas) - RACE all RPCs for maximum speed
    async getMATICBalance() {
        if (!this.wallet) {
            return { success: false, error: 'No wallet loaded', balance: 0 };
        }

        const walletAddress = this.wallet.address;
        const rpcEndpoints = [
            'https://polygon-rpc.com',
            'https://rpc.ankr.com/polygon',
            'https://1rpc.io/matic',
            'https://polygon-mainnet.g.alchemy.com/v2/demo'
        ];

        // Race all RPCs - first successful one wins
        const racePromises = rpcEndpoints.map(async (rpc) => {
            const provider = createDirectProvider(rpc);
            const balance = await provider.getBalance(walletAddress);
            const formatted = parseFloat(ethers.utils.formatEther(balance));
            return { rpc, balance: formatted };
        });

        // Add a 5-second timeout
        const timeoutPromise = new Promise((_, reject) =>
            setTimeout(() => reject(new Error('All RPCs timed out (5s)')), 5000)
        );

        try {
            const result = await Promise.race([
                Promise.any(racePromises),
                timeoutPromise
            ]);
            return { success: true, balance: result.balance };
        } catch (e) {
            log(`⚠️ MATIC balance fetch failed: ${e.message}`);
            return { success: false, error: e.message, balance: 0 };
        }
    }

    // Transfer USDC to another address
    async transferUSDC(toAddress, amount) {
        if (!this.wallet) {
            return { success: false, error: 'No wallet loaded' };
        }

        // Validate address
        if (!ethers.utils.isAddress(toAddress)) {
            return { success: false, error: 'Invalid destination address' };
        }

        // Validate amount
        if (amount <= 0) {
            return { success: false, error: 'Amount must be positive' };
        }

        try {
            log(`💸 Initiating transfer of $${amount} USDC to ${toAddress.substring(0, 8)}...`);

            const usdcContract = new ethers.Contract(USDC_ADDRESS, USDC_ABI, this.wallet);
            const amountWei = ethers.utils.parseUnits(amount.toString(), USDC_DECIMALS);

            // Check balance first
            const balance = await usdcContract.balanceOf(this.wallet.address);
            if (balance < amountWei) {
                return { success: false, error: 'Insufficient USDC balance' };
            }

            // Execute transfer
            const tx = await usdcContract.transfer(toAddress, amountWei);
            log(`📤 Transfer TX submitted: ${tx.hash}`);

            // Wait for confirmation
            const receipt = await tx.wait();
            log(`✅ Transfer confirmed in block ${receipt.blockNumber}`);

            return {
                success: true,
                txHash: tx.hash,
                blockNumber: receipt.blockNumber,
                amount: amount,
                to: toAddress,
                explorerUrl: `https://polygonscan.com/tx/${tx.hash}`
            };
        } catch (e) {
            log(`❌ Transfer failed: ${e.message}`);
            return { success: false, error: e.message };
        }
    }

    // Get wallet info summary
    getWalletInfo() {
        return {
            loaded: !!this.wallet,
            address: this.wallet ? this.wallet.address : null,
            mode: this.mode
        };
    }

    // ==================== REDEMPTION SYSTEM ====================
    // Track resolved positions that need redemption
    // Note: This stores token IDs from closed positions for later redemption

    // Add a position to redemption queue after cycle resolution
    addToRedemptionQueue(position) {
        if (!this.redemptionQueue) this.redemptionQueue = [];
        if (position && position.tokenId) {
            this.redemptionQueue.push({
                tokenId: position.tokenId,
                asset: position.asset,
                side: position.side,
                addedAt: Date.now(),
                shares: position.shares || 0
            });
            log(`📋 Added to redemption queue: ${position.asset} ${position.side}`, position.asset);
        }
    }

    // Get redemption queue
    getRedemptionQueue() {
        return this.redemptionQueue || [];
    }

    // Check and redeem any resolved positions
    async checkAndRedeemPositions() {
        if (!this.wallet) {
            return { success: false, error: 'No wallet loaded' };
        }

        const queue = this.redemptionQueue || [];
        if (queue.length === 0) {
            return { success: true, message: 'No positions to redeem', redeemed: 0 };
        }

        log(`🔍 Checking ${queue.length} positions for redemption...`);
        let redeemed = 0;
        let failed = 0;

        try {
            // Use direct provider to avoid proxy issues
            const provider = createDirectProvider('https://polygon-rpc.com');
            const wallet = this.wallet.connect(provider);
            const ctfContract = new ethers.Contract(CTF_ADDRESS, CTF_ABI, wallet);

            for (let i = queue.length - 1; i >= 0; i--) {
                const item = queue[i];

                try {
                    // Check if we have any balance of this token
                    const balance = await ctfContract.balanceOf(wallet.address, item.tokenId);

                    if (balance.gt(0)) {
                        log(`💰 Found ${ethers.utils.formatUnits(balance, 0)} redeemable tokens for ${item.asset}`, item.asset);
                        // Has balance - this position can potentially be redeemed
                        // Note: Full redemption requires conditionId which is complex
                        // For now, just log that redemption is available
                        log(`✅ Position ${item.asset} ${item.side} has redeemable balance. Use Polymarket website to redeem.`, item.asset);
                    } else {
                        // No balance - either already redeemed or market not resolved
                        log(`ℹ️ No balance found for ${item.asset} ${item.side} token - may already be redeemed`, item.asset);
                        // Remove from queue
                        queue.splice(i, 1);
                        redeemed++;
                    }
                } catch (e) {
                    log(`⚠️ Error checking token ${item.asset}: ${e.message}`, item.asset);
                    failed++;
                }
            }

            this.redemptionQueue = queue;
            return {
                success: true,
                message: `Checked ${queue.length + redeemed} positions`,
                redeemed,
                failed,
                remaining: queue.length
            };

        } catch (e) {
            log(`❌ Redemption check failed: ${e.message}`);
            return { success: false, error: e.message };
        }
    }

    // Clear redemption queue
    clearRedemptionQueue() {
        this.redemptionQueue = [];
        log(`🗑️ Redemption queue cleared`);
    }
}

// ==================== OPPORTUNITY DETECTOR ====================
class OpportunityDetector {
    constructor() {
        this.lastScans = {};
        // Track trades per cycle per asset per mode to prevent duplicate entries
        this.tradesThisCycle = {}; // { 'BTC_MOMENTUM': timestamp, ... }
        this.currentCycleStart = 0;
    }

    // Check and reset cycle tracking
    checkCycleReset() {
        const now = Math.floor(Date.now() / 1000);
        const cycleStart = now - (now % 900); // 15 min cycles
        if (cycleStart !== this.currentCycleStart) {
            this.tradesThisCycle = {}; // Reset at new cycle
            this.currentCycleStart = cycleStart;
        }
    }

    // Check if already traded this mode+asset this cycle
    hasTraded(asset, mode) {
        this.checkCycleReset();
        return !!this.tradesThisCycle[`${asset}_${mode}`];
    }

    // Mark as traded
    markTraded(asset, mode) {
        this.checkCycleReset();
        this.tradesThisCycle[`${asset}_${mode}`] = Date.now();
    }

    // MODE 2: ARBITRAGE - Detect mispriced odds
    detectArbitrage(asset, confidence, yesPrice, noPrice, side, elapsed = 0) {
        if (!CONFIG.ARBITRAGE.enabled) return null;
        // ONE TRADE PER CYCLE PER ASSET
        if (this.hasTraded(asset, 'ARBITRAGE')) return null;

        // LATE CYCLE CUTOFF: REMOVED - User requested late entries if confident
        // Bot learns from all trades, even late-cycle ones

        const fairValue = side === 'UP' ? confidence : (1 - confidence);
        const marketOdds = side === 'UP' ? yesPrice : noPrice;
        const mispricing = fairValue - marketOdds;

        if (mispricing >= CONFIG.ARBITRAGE.minMispricing) {
            return {
                mode: 'ARBITRAGE',
                direction: side,
                entry: marketOdds,
                edge: mispricing * 100,
                reason: `Odds mispriced by ${(mispricing * 100).toFixed(1)}%`
            };
        }
        return null;
    }

    // MODE 3: SCALP - Detect ultra-cheap entry
    detectScalp(asset, confidence, yesPrice, noPrice) {
        if (!CONFIG.SCALP.enabled) return null;
        // ONE TRADE PER CYCLE PER ASSET
        if (this.hasTraded(asset, 'SCALP')) return null;

        // Calculate expectation for each side
        const yesExpect = confidence;
        const noExpect = 1 - confidence;

        // Check YES side
        if (yesPrice <= CONFIG.SCALP.maxEntryPrice) {
            if (!CONFIG.SCALP.requireLean || yesExpect > 0.55) {
                return {
                    mode: 'SCALP',
                    direction: 'UP',
                    entry: yesPrice,
                    target: yesPrice * CONFIG.SCALP.targetMultiple,
                    reason: `YES at ${(yesPrice * 100).toFixed(0)}¢ (lean: ${(yesExpect * 100).toFixed(0)}%)`
                };
            }
        }

        // Check NO side
        if (noPrice <= CONFIG.SCALP.maxEntryPrice) {
            if (!CONFIG.SCALP.requireLean || noExpect > 0.55) {
                return {
                    mode: 'SCALP',
                    direction: 'DOWN',
                    entry: noPrice,
                    target: noPrice * CONFIG.SCALP.targetMultiple,
                    reason: `NO at ${(noPrice * 100).toFixed(0)}¢ (lean: ${(noExpect * 100).toFixed(0)}%)`
                };
            }
        }

        return null;
    }

    // MODE 4: UNCERTAINTY - Trade volatility/extreme odds
    detectUncertainty(asset, yesPrice, noPrice, volatility, regime) {
        if (!CONFIG.UNCERTAINTY.enabled) return null;
        // ONE TRADE PER CYCLE PER ASSET
        if (this.hasTraded(asset, 'UNCERTAINTY')) return null;
        if (volatility < CONFIG.UNCERTAINTY.volatilityMin) return null;

        // Extreme YES odds - bet on reversion (buy NO)
        if (yesPrice >= CONFIG.UNCERTAINTY.extremeThreshold && regime !== 'TRENDING') {
            return {
                mode: 'UNCERTAINTY',
                direction: 'DOWN',
                entry: noPrice,
                reason: `YES extreme (${(yesPrice * 100).toFixed(0)}%), betting on reversion`
            };
        }

        // Extreme NO odds - bet on reversion (buy YES)
        if (noPrice >= CONFIG.UNCERTAINTY.extremeThreshold && regime !== 'TRENDING') {
            return {
                mode: 'UNCERTAINTY',
                direction: 'UP',
                entry: yesPrice,
                reason: `NO extreme (${(noPrice * 100).toFixed(0)}%), betting on reversion`
            };
        }

        return null;
    }

    // MODE 5: MOMENTUM - Ride strong trends (ENHANCED with smart gates)
    detectMomentum(asset, elapsed, priceHistory, votes, consensusRatio, force, atr, market = null) {
        if (!CONFIG.MOMENTUM.enabled) return null;
        if (elapsed < CONFIG.MOMENTUM.minElapsed) return null;

        // ONE MOMENTUM TRADE PER CYCLE PER ASSET
        // User feedback: Momentum was firing too frequently
        if (this.hasTraded(asset, 'MOMENTUM')) {
            return null; // Already traded momentum this cycle for this asset
        }

        // SMART GATE 1: Check consensus
        if (consensusRatio < CONFIG.MOMENTUM.minConsensus) return null;

        // SMART GATE 2: Check for meaningful breakout
        if (!atr || atr <= 0) return null; // Safety check
        const breakout = Math.abs(force) / atr;
        if (breakout < CONFIG.MOMENTUM.breakoutThreshold) return null;

        const direction = force > 0 ? 'UP' : 'DOWN';

        // SMART GATE 3: Odds must lean in our direction (CRITICAL)
        // If we think UP, yesPrice should be > 40%. If DOWN, noPrice should be > 40%
        if (market) {
            const yesP = market.yesPrice || 0.5;
            const noP = market.noPrice || 0.5;

            if (direction === 'UP' && yesP < 0.40) {
                // Market says <40% chance of UP - don't fight it
                return null;
            }
            if (direction === 'DOWN' && noP < 0.40) {
                // Market says <40% chance of DOWN - don't fight it
                return null;
            }

            // SMART GATE 4: Expected value check - is entry price favorable?
            // Don't buy YES at >80% or NO at >80% (poor risk/reward)
            const entryPrice = direction === 'UP' ? yesP : noP;
            if (entryPrice > 0.80) {
                return null; // Price too high, minimal upside
            }
            if (entryPrice < 0.05) {
                return null; // Price too low, probably losing bet
            }

            // SMART GATE 5: Calculate expected ROI
            // If we win, we get $1. Entry cost is entryPrice.
            // Expected ROI = (1 - entryPrice) / entryPrice
            const expectedROI = (1 - entryPrice) / entryPrice;
            if (expectedROI < 0.15) {
                return null; // Less than 15% expected gain - not worth it
            }
        }

        // SMART GATE 6: Enough time remaining?
        // Need at least 3 minutes to profit before cycle ends
        const cycleLength = 900; // 15 minutes
        const timeRemaining = cycleLength - elapsed;
        if (timeRemaining < 180) { // Less than 3 minutes
            return null; // Too close to checkpoint
        }

        return {
            mode: 'MOMENTUM',
            direction,
            reason: `Breakout ${(breakout).toFixed(1)}x ATR, ${(consensusRatio * 100).toFixed(0)}% cons, ${Math.floor(timeRemaining / 60)}m left`
        };
    }

    // Scan all modes and return best opportunity
    scanAll(asset, data) {
        const opportunities = [];

        // Arbitrage
        const arb = this.detectArbitrage(asset, data.confidence, data.yesPrice, data.noPrice, data.prediction, data.elapsed);
        if (arb) opportunities.push({ ...arb, priority: 2 });

        // Scalp
        const scalp = this.detectScalp(asset, data.confidence, data.yesPrice, data.noPrice);
        if (scalp) opportunities.push({ ...scalp, priority: 3 });

        // Uncertainty
        const unc = this.detectUncertainty(asset, data.yesPrice, data.noPrice, data.volatility, data.regime);
        if (unc) opportunities.push({ ...unc, priority: 4 });

        // Momentum (pass market data for odds alignment check)
        const market = { yesPrice: data.yesPrice, noPrice: data.noPrice };
        const mom = this.detectMomentum(asset, data.elapsed, data.history, data.votes, data.consensusRatio, data.force, data.atr, market);
        if (mom) opportunities.push({ ...mom, priority: 5 });

        // Sort by priority (lower = higher priority)
        opportunities.sort((a, b) => a.priority - b.priority);

        return opportunities;
    }
}

const tradeExecutor = new TradeExecutor();
const opportunityDetector = new OpportunityDetector();

// Logging
function log(msg, asset = null) {
    const timestamp = new Date().toLocaleTimeString();
    const prefix = asset ? `[${asset}]` : '[ORACLE]';
    console.log(`${timestamp} ${prefix} ${msg}`);
}

// ==================== MATH LIBRARY ====================
const MathLib = {
    average: (arr) => arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0,

    stdDev: (arr) => {
        if (!arr.length) return 0;
        const avg = MathLib.average(arr);
        const squareDiffs = arr.map(v => Math.pow(v - avg, 2));
        return Math.sqrt(MathLib.average(squareDiffs));
    },

    calculateATR: (history, period = 14) => {
        if (history.length < period + 1) {
            const last = history.length > 0 ? history[history.length - 1].p : 0;
            return last > 0 ? last * 0.0005 : 0.0001;
        }
        let trs = [];
        for (let i = history.length - period; i < history.length; i++) {
            const high = history[i].p;
            const low = history[i].p;
            const prevClose = history[i - 1].p;
            trs.push(Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose)));
        }
        const alpha = 2 / (period + 1);
        let ewma = trs[0];
        for (let i = 1; i < trs.length; i++) {
            ewma = (trs[i] - ewma) * alpha + ewma;
        }
        return ewma || 0.0001;
    },

    getDerivatives: (history) => {
        if (history.length < 5) return { v: 0, a: 0, j: 0, s: 0 };
        const p = history.slice(-5).map(x => x.p);
        const v = p[4] - p[3];
        const a = (p[4] - p[3]) - (p[3] - p[2]);
        const j = ((p[4] - p[3]) - (p[3] - p[2])) - ((p[3] - p[2]) - (p[2] - p[1]));
        const s = j - (((p[3] - p[2]) - (p[2] - p[1])) - ((p[2] - p[1]) - (p[1] - p[0])));
        return { v, a, j, s };
    },

    isPanic: (history) => {
        if (history.length < 20) return false;
        const prices = history.map(x => x.p);
        const mean = MathLib.average(prices);
        const std = MathLib.stdDev(prices);
        const last = prices[prices.length - 1];
        return Math.abs(last - mean) > (3 * std);
    },

    isSpoofing: (history) => {
        if (history.length < 10) return false;
        const recent = history.slice(-10);
        const start = recent[0].p;
        const maxP = Math.max(...recent.map(x => x.p));
        const minP = Math.min(...recent.map(x => x.p));
        const end = recent[recent.length - 1].p;

        const moveUp = (maxP - start) / start;
        const moveDown = (start - minP) / start;

        if (moveUp > 0.005 && (end - start) / start < 0.001) return true;
        if (moveDown > 0.005 && (start - end) / start < 0.001) return true;
        return false;
    },

    getOrderflowImbalance: (history) => {
        if (history.length < 5) return 0;
        let buyVol = 0, sellVol = 0;
        history.slice(-5).forEach((h, i) => {
            if (i === 0) return;
            const delta = h.p - history[history.length - 5 + i - 1].p;
            if (delta > 0) buyVol += Math.abs(delta);
            else sellVol += Math.abs(delta);
        });
        return (buyVol - sellVol) / (buyVol + sellVol || 1);
    },

    getOddsVelocity: (oddsHistory) => {
        if (oddsHistory.length < 5) return { yes: 0, no: 0 };
        const recent = oddsHistory.slice(-5);
        const yesVel = (recent[4].yes - recent[0].yes) / 5;
        const noVel = (recent[4].no - recent[0].no) / 5;
        return { yes: yesVel, no: noVel };
    },

    dtwDistance: (s1, s2) => {
        const n = s1.length;
        const m = s2.length;
        const dtw = Array(n + 1).fill(null).map(() => Array(m + 1).fill(Infinity));
        dtw[0][0] = 0;

        for (let i = 1; i <= n; i++) {
            for (let j = 1; j <= m; j++) {
                const cost = Math.abs(s1[i - 1] - s2[j - 1]);
                dtw[i][j] = cost + Math.min(dtw[i - 1][j], dtw[i][j - 1], dtw[i - 1][j - 1]);
            }
        }
        return dtw[n][m];
    },

    getMarketRegime: (history) => {
        if (history.length < 60) return 'UNKNOWN';
        const recent = history.slice(-60).map(x => x.p);
        const mean = MathLib.average(recent);
        const std = MathLib.stdDev(recent);
        const cv = std / mean;  // Coefficient of Variation

        if (cv < 0.002) return 'CHOPPY';
        if (cv > 0.01) return 'VOLATILE';
        return 'TRENDING';
    }
};

class KalmanFilter {
    constructor(R = 1, Q = 1, A = 1, B = 0, C = 1) {
        this.R = R; this.Q = Q; this.A = A; this.B = B; this.C = C;
        this.cov = NaN; this.x = NaN;
    }
    filter(z, u = 0) {
        if (isNaN(this.x)) {
            this.x = (1 / this.C) * z;
            this.cov = (1 / this.C) * this.R * (1 / this.C);
            return this.x;
        }
        const predX = (this.A * this.x) + (this.B * u);
        const predCov = ((this.A * this.cov) * this.A) + this.Q;
        const K = predCov * this.C * (1 / ((this.C * predCov * this.C) + this.R));
        this.x = predX + K * (z - (this.C * predX));
        this.cov = predCov - (K * this.C * predCov);
        return this.x;
    }
}

// ==================== HISTORIAN (REDIS-BACKED PATTERN STORAGE) ====================
const PATTERNS_DIR = './patterns';

// In-memory fallback if Redis unavailable
let memoryPatterns = {};

async function initPatternStorage() {
    ASSETS.forEach(asset => memoryPatterns[asset] = []);

    // Try to load from Redis
    if (redisAvailable && redis) {
        try {
            for (const asset of ASSETS) {
                const stored = await redis.get(`patterns:${asset}`);
                if (stored) {
                    memoryPatterns[asset] = JSON.parse(stored);
                    log(`📚 Loaded ${memoryPatterns[asset].length} patterns from Redis`, asset);
                }
            }
        } catch (e) {
            log(`⚠️ Redis pattern load failed: ${e.message}`);
        }
    }
    log('📚 Historian Storage Initialized');
}

async function savePattern(asset, vector, outcome) {
    try {
        const pattern = {
            id: `${asset}-${Date.now()}`,
            asset,
            vector,
            outcome,
            timestamp: Date.now(),
            wasCorrect: null,  // New: Track if this pattern prediction was correct
            matchCount: 0,     // New: Track how many times this pattern was matched
            wins: 0            // NEW: Track wins for this pattern
        };

        // Save to memory first
        memoryPatterns[asset].push(pattern);

        // AGGRESSIVE PATTERN PRUNING (God-Mode Memory Management)
        // Keep only patterns that are:
        // 1. Unproven (<5 matches) - give them a chance
        // 2. Proven winners (>=40% win rate after 5+ matches)
        // 3. Recent (<30 days old)
        const now = Date.now();
        const thirtyDaysAgo = now - (30 * 24 * 60 * 60 * 1000);

        const beforeCount = memoryPatterns[asset].length;
        memoryPatterns[asset] = memoryPatterns[asset].filter(p => {
            // Always keep recent patterns (give time to prove themselves)
            if (p.timestamp > thirtyDaysAgo) {
                // If matched enough times, check win rate
                if (p.matchCount >= 5) {
                    const winRate = p.wins / p.matchCount;
                    return winRate >= 0.40; // Keep only 40%+ win rate patterns
                }
                return true; // Keep unproven recent patterns
            }
            return false; // Remove old patterns (>30 days)
        });

        const afterCount = memoryPatterns[asset].length;
        const pruned = beforeCount - afterCount;

        if (pruned > 0) {
            log(`🧹 Pruned ${pruned} bad patterns (${afterCount} remain)`, asset);
        }

        // Hard cap at 500 (should rarely hit after pruning)
        if (memoryPatterns[asset].length > 500) {
            memoryPatterns[asset] = memoryPatterns[asset].slice(-500);
        }

        // Persist to Redis if available
        if (redisAvailable && redis) {
            try {
                await redis.set(`patterns:${asset}`, JSON.stringify(memoryPatterns[asset]));
            } catch (e) {
                log(`⚠️ Redis pattern save error: ${e.message}`, asset);
            }
        }
    } catch (e) {
        log(`⚠️ Pattern save error: ${e.message}`, asset);
    }
}

async function findSimilarPattern(asset, currentVector) {
    try {
        const patterns = memoryPatterns[asset] || [];
        if (patterns.length === 0) return null;

        let bestMatch = null;
        let minDistance = Infinity;

        patterns.forEach(p => {
            if (p.vector.length !== currentVector.length) return;
            const dist = MathLib.dtwDistance(currentVector, p.vector);

            // SMART MEMORY WEIGHTING
            // If pattern was correct before, effective distance is lower (better match)
            // If pattern was wrong before, effective distance is higher (worse match)
            let effectiveDist = dist;
            if (p.wasCorrect === true) effectiveDist *= 0.8;      // Boost good memories
            else if (p.wasCorrect === false) effectiveDist *= 1.5; // Penalize bad memories

            // FINAL SEVEN: PATTERN DECAY (Old patterns matter less)
            const ageInDays = (Date.now() - p.timestamp) / (1000 * 60 * 60 * 24);
            if (ageInDays > 30) return; // Ignore ancient patterns (>30 days)
            const decayFactor = Math.exp(-ageInDays / 30);
            effectiveDist *= (2 - decayFactor); // Older = higher distance = worse match

            if (effectiveDist < minDistance) {
                minDistance = effectiveDist;
                bestMatch = p;
            }
        });

        if (minDistance < 0.15) {
            return bestMatch;
        }

        return null;
    } catch (e) {
        return null;
    }
}

// ==================== BRAIN LOGIC ====================

class SupremeBrain {
    constructor(asset) {
        this.asset = asset;
        this.prediction = 'WAIT';
        this.confidence = 0;
        this.tier = 'NONE';
        this.edge = 0;
        this.ensembleVotes = { UP: 0, DOWN: 0 };

        // Ultra-Fast Defaults
        this.atrMultiplier = 2.2;
        this.reverseMultiplier = 4.5;

        this.winStreak = 0;
        this.lossStreak = 0;
        this.stats = { wins: 0, total: 0, convictionWins: 0, convictionTotal: 0 };

        this.lockState = 'NEUTRAL';
        this.lockStrength = 0;
        this.lastSignal = null;

        // FINAL SEVEN: CONFIDENCE CALIBRATION
        this.calibrationBuckets = {
            '0.90-0.95': { total: 0, wins: 0 },
            '0.95-0.98': { total: 0, wins: 0 },
            '0.98-1.00': { total: 0, wins: 0 }
        };

        // FINAL SEVEN: REGIME PERSISTENCE
        this.regimeHistory = [];

        // FINAL SEVEN: NEWS AWARENESS (Placeholder)
        this.newsState = 'NEUTRAL'; // NEUTRAL, NEGATIVE, POSITIVE

        this.pendingSignal = null;
        this.stabilityCounter = 0;
        this.lagCounter = 0;
        this.isProcessing = false;

        this.priceKalman = new KalmanFilter(0.0001, 0.001);
        this.derivKalman = new KalmanFilter(0.0001, 0.001);

        // CONVICTION LOCK SYSTEM (Anti-Whipsaw)
        this.convictionLocked = false;
        this.lockedDirection = null;
        this.lockTime = null;
        this.lockConfidence = 0;

        // VOTE MOMENTUM TRACKER
        this.voteHistory = [];
        this.voteTrendScore = 0;

        // RECENT FORM TRACKER (Last 10 predictions)
        this.recentOutcomes = [];  // Array of true/false (win/loss)

        // CYCLE COMMITMENT (Real-World Trading Lock)
        this.cycleCommitted = false;
        this.committedDirection = null;
        this.commitTime = null;

        // FINAL SEVEN: MODEL WEIGHT ADAPTATION (Self-Learning)
        this.modelAccuracy = {
            genesis: { wins: 0, total: 0 },
            physicist: { wins: 0, total: 0 },
            orderbook: { wins: 0, total: 0 },
            historian: { wins: 0, total: 0 },
            correlation: { wins: 0, total: 0 },
            macro: { wins: 0, total: 0 },
            funding: { wins: 0, total: 0 },
            volume: { wins: 0, total: 0 }
        };

        // EXPORT HISTORY TRACKER
        this.currentCycleHistory = [];
    }

    async update() {
        if (this.isProcessing) return;
        this.isProcessing = true;
        try {
            const currentPrice = livePrices[this.asset];
            const startPrice = checkpointPrices[this.asset];
            const history = priceHistory[this.asset];
            const elapsed = INTERVAL_SECONDS - (getNextCheckpoint() - Math.floor(Date.now() / 1000));

            if (!currentPrice || !startPrice || history.length < 10) {
                // DIAGNOSTIC: Log why prediction is not running
                if (!currentPrice) log(`⚠️ No live price available`, this.asset);
                if (!startPrice) log(`⚠️ No checkpoint price (waiting for cycle)`, this.asset);
                if (history.length < 10) log(`⚠️ Insufficient history (${history.length}/10)`, this.asset);
                this.isProcessing = false;
                return;
            }

            // PROPHET-LEVEL: FAST ADAPTIVE LEARNING (accelerated from 10 to 5 trades)
            const weights = {};
            for (const [model, stats] of Object.entries(this.modelAccuracy)) {
                if (stats.total < 5) weights[model] = 1.0; // Default weight - FASTER learning (was 10)
                else {
                    const accuracy = stats.wins / stats.total;
                    // Boost high accuracy (>60%), penalize low accuracy (<40%)
                    // Range: 0.2 to 2.0
                    weights[model] = Math.max(0.2, Math.min(2.0, Math.pow(accuracy * 2, 1.5)));
                }
            }

            // SNIPER MODE: Boost Leading Indicators in First 3 Minutes
            if (elapsed < 180) {
                weights.orderbook = (weights.orderbook || 1.0) * 1.5;
                weights.physicist = (weights.physicist || 1.0) * 1.5;
                weights.genesis = (weights.genesis || 1.0) * 1.3;
                // Reduce laggy indicators
                weights.volume = (weights.volume || 1.0) * 0.7;
                weights.macro = (weights.macro || 1.0) * 0.7;
            }
            const modelVotes = {}; // Track who voted what for learning

            // TRINITY UPGRADE: REGIME AWARENESS (Moved Up for Normalization)
            const regime = MathLib.getMarketRegime(history);

            // === ENSEMBLE VOTING SYSTEM ===
            const votes = { UP: 0, DOWN: 0 };
            let totalConfidence = 0;

            // MODEL 1: GENESIS PROTOCOL
            const atr = MathLib.calculateATR(history, 20);
            const filteredPrice = this.priceKalman.filter(currentPrice);
            const force = filteredPrice - startPrice;
            const absForce = Math.abs(force);

            const longTermTrend = history.length > 60 ? (currentPrice - history[history.length - 60].p) : 0;
            let trendBias = 1.0;
            if (longTermTrend !== 0) {
                if ((force > 0 && longTermTrend < 0) || (force < 0 && longTermTrend > 0)) {
                    trendBias = 0.85;
                }
            }

            // FINAL SEVEN: VOLATILITY NORMALIZATION
            const regimeMultiplier = regime === 'VOLATILE' ? 1.5 : (regime === 'CHOPPY' ? 0.8 : 1.0);
            const effectiveATR = this.atrMultiplier * regimeMultiplier;

            if (this.lockState === 'NEUTRAL') {
                if (absForce > atr * effectiveATR) {
                    this.lockState = force > 0 ? 'UP' : 'DOWN';
                    this.lockStrength = absForce;
                }
            } else {
                const reverseThreshold = this.lockStrength + (atr * this.reverseMultiplier);
                const opposingForce = this.lockState === 'UP' ? (startPrice - currentPrice) : (currentPrice - startPrice);
                if (opposingForce > reverseThreshold) {
                    this.lockState = this.lockState === 'UP' ? 'DOWN' : 'UP';
                    this.lockStrength = opposingForce;
                }
            }

            if (this.lockState !== 'NEUTRAL') {
                const genWeight = weights.genesis || 1.0;
                votes[this.lockState] += (elapsed < 180 ? 2 : 1) * genWeight;
                modelVotes.genesis = this.lockState;
                const physicConf = Math.min(0.95, 0.7 + (absForce / atr) * 0.05);
                totalConfidence += physicConf;
            }

            // MODEL 2: PHYSICIST
            const phys = MathLib.getDerivatives(history);
            const entropy = Math.abs(phys.s);
            const smoothV = this.derivKalman.filter(phys.v);
            const isFakeout = (Math.abs(smoothV) > atr && entropy > atr * 4);

            if (!isFakeout && Math.abs(phys.v) > atr * 0.5) {
                const physSignal = phys.v > 0 ? 'UP' : 'DOWN';
                const physWeight = weights.physicist || 1.0;
                votes[physSignal] += 1 * physWeight;
                modelVotes.physicist = physSignal;
                totalConfidence += 0.75;
            }

            // MODEL 3: ORDER BOOK
            const oddsHist = marketOddsHistory[this.asset];
            const imbalance = MathLib.getOrderflowImbalance(history);
            const currentOdds = currentMarkets[this.asset] ? currentMarkets[this.asset].yesPrice : 0.5;
            const isExtreme = currentOdds > 0.85 || currentOdds < 0.15;

            if (oddsHist && oddsHist.length >= 5) {
                const vel = MathLib.getOddsVelocity(oddsHist);
                const momentum = vel.yes - vel.no;

                if (Math.abs(momentum) > 0.01) {
                    let bookSignal = momentum > 0 ? 'UP' : 'DOWN';
                    let conf = 0.7;
                    if (isExtreme && Math.abs(imbalance) > 0.5) {
                        if ((currentOdds > 0.85 && imbalance < -0.3) || (currentOdds < 0.15 && imbalance > 0.3)) {
                            bookSignal = bookSignal === 'UP' ? 'DOWN' : 'UP';
                            conf = 0.9;
                        }
                    }
                    const obWeight = weights.orderbook || 1.0;
                    votes[bookSignal] += 1 * obWeight;
                    modelVotes.orderbook = bookSignal;
                    totalConfidence += conf;
                }
            }

            // FINAL SEVEN: ORDER BOOK DEPTH (Whale Detection)
            if (currentMarkets[this.asset]) {
                // Approximate depth from available data (best effort without full L2)
                // We use the volume24hr as a proxy for liquidity depth context
                // And check if price is holding despite volume spikes
            }

            // MODEL 4: HISTORIAN (NOW FULLY ENABLED WITH FILE STORAGE)
            if (history.length >= 10) {
                const recent = history.slice(-10).map(x => x.p);
                const base = recent[0];
                const vector = recent.map(p => (p - base) / base);

                const match = await findSimilarPattern(this.asset, vector);
                if (match) {
                    const histWeight = weights.historian || 1.0;
                    votes[match.outcome] += 1 * histWeight;
                    modelVotes.historian = match.outcome;
                    totalConfidence += 0.85;
                    // Store pattern ID to update it later
                    if (!this.lastSignal) this.lastSignal = {};
                    this.lastSignal.patternId = match.id;
                }
            }

            // MODEL 5: BTC CORRELATION
            if (this.asset !== 'BTC' && livePrices['BTC'] && checkpointPrices['BTC']) {
                const btcForce = livePrices['BTC'] - checkpointPrices['BTC'];
                const btcDirection = btcForce > 0 ? 'UP' : 'DOWN';
                const btcStrength = Math.abs(btcForce) / (MathLib.calculateATR(priceHistory['BTC'], 20) || 1);
                if (btcStrength > 1.5) {
                    const corrWeight = weights.correlation || 1.0;
                    votes[btcDirection] += 0.5 * corrWeight;
                    modelVotes.correlation = btcDirection;
                    totalConfidence += 0.6;
                }
            }

            // MODEL 6: MACRO (Fear & Greed)
            const macroWeight = weights.macro || 1.0;
            if (fearGreedIndex < 25) {
                votes.UP += 0.6 * macroWeight;
                modelVotes.macro = 'UP';
                totalConfidence += 0.65;
            }
            else if (fearGreedIndex > 75) {
                votes.DOWN += 0.6 * macroWeight;
                modelVotes.macro = 'DOWN';
                totalConfidence += 0.65;
            }

            // MODEL 7: FUNDING RATES
            const funding = fundingRates[this.asset];
            if (funding && funding.timestamp > Date.now() - 600000) {
                const fundWeight = weights.funding || 1.0;
                if (funding.rate > 0.0001) {
                    votes.DOWN += 0.5 * fundWeight;
                    modelVotes.funding = 'DOWN';
                    totalConfidence += 0.7;
                }
                else if (funding.rate < -0.0001) {
                    votes.UP += 0.5 * fundWeight;
                    modelVotes.funding = 'UP';
                    totalConfidence += 0.7;
                }
            }

            // MODEL 8: VOLUME ANALYSIS
            const vol = currentMarkets[this.asset]?.volume || 0;
            if (vol > 0 && history.length > 5) {
                const priceChange = (currentPrice - history[history.length - 5].p) / history[history.length - 5].p;
                const volSignal = priceChange > 0 ? 'UP' : 'DOWN';
                const volWeight = weights.volume || 1.0;

                if (Math.abs(priceChange) < 0.001 && vol > 100000) {
                    votes[volSignal] += 0.5 * volWeight;
                    modelVotes.volume = volSignal;
                    totalConfidence += 0.6;
                } else {
                    votes[volSignal] += 0.7 * volWeight;
                    modelVotes.volume = volSignal;
                    totalConfidence += 0.65;
                }
            }

            // === WATCHGUARDS ===
            const lag = Date.now() - (currentMarkets[this.asset]?.lastUpdated || 0);
            this.lagCounter = lag > 15000 ? this.lagCounter + 1 : 0;
            const isLagging = this.lagCounter >= 3;
            const isPanic = MathLib.isPanic(history);
            const isSpoofing = MathLib.isSpoofing(history);

            if (isLagging || isPanic || isSpoofing) {
                votes.UP = 0; votes.DOWN = 0; totalConfidence = 0;
            }

            // === DECISION LOGIC ===
            this.ensembleVotes = votes;
            const upVotes = votes.UP;
            const downVotes = votes.DOWN;
            const totalVotes = upVotes + downVotes;

            // CONSENSUS BONUS (The "Prophet" Multiplier)
            // If models are highly aligned, boost confidence
            if (totalVotes > 0) {
                const voteRatio = Math.max(upVotes, downVotes) / totalVotes;
                if (voteRatio > 0.8) {
                    // 80%+ agreement = 1.2x confidence boost
                    totalConfidence *= 1.2;
                    log(`✨ CONSENSUS BONUS: High agreement (${(voteRatio * 100).toFixed(0)}%)`, this.asset);
                }
            }

            let finalSignal = 'NEUTRAL';
            let finalConfidence = 0;

            if (totalVotes > 0) {
                const avgConf = totalConfidence / totalVotes;
                const R = MathLib.calculateATR(history.slice(-Math.min(history.length, 60)), 5);
                const margin = R / atr < 0.7 ? 1.5 : (R / atr > 1.3 ? 3.0 : 2.0);

                if (this.prediction === 'DOWN') {
                    if (upVotes > downVotes + margin) { finalSignal = 'UP'; finalConfidence = avgConf * (upVotes / totalVotes); }
                    else { finalSignal = 'DOWN'; finalConfidence = avgConf * (downVotes / totalVotes); }
                } else if (this.prediction === 'UP') {
                    if (downVotes > upVotes + margin) { finalSignal = 'DOWN'; finalConfidence = avgConf * (downVotes / totalVotes); }
                    else { finalSignal = 'UP'; finalConfidence = avgConf * (upVotes / totalVotes); }
                } else {
                    if (upVotes > downVotes) { finalSignal = 'UP'; finalConfidence = avgConf * (upVotes / totalVotes); }
                    else if (downVotes > upVotes) { finalSignal = 'DOWN'; finalConfidence = avgConf * (downVotes / totalVotes); }
                }
            }

            // FORCED PREDICTION
            if (elapsed >= 180 && finalSignal === 'NEUTRAL') {
                if (force > 0) { finalSignal = 'UP'; finalConfidence = 0.6 + (absForce / (atr * 3)); }
                else { finalSignal = 'DOWN'; finalConfidence = 0.6 + (absForce / (atr * 3)); }
                finalConfidence = Math.min(0.75, finalConfidence);
            }

            // === THRESHOLD DETERMINATION (Regime-Aware) ===
            // 🎯 AGGRESSIVE PROPHECY MODE: Optimized for £10→£1M Goal
            // Goal: Frequent, early predictions with acceptable accuracy
            let tier = 'NONE';
            let convictionThreshold = 0.70; // SNIPER MODE: Balanced Base (was 0.75)
            let advisoryThreshold = 0.55;   // Easier entry (was 0.60)

            if (regime === 'CHOPPY') {
                convictionThreshold = 0.80; // Very cautious in choppy markets
                advisoryThreshold = 0.65;
            } else if (regime === 'TRENDING') {
                convictionThreshold = 0.70; // Lower in clear trends (but still high)
                advisoryThreshold = 0.55;
            } else if (regime === 'VOLATILE') {
                convictionThreshold = 0.75; // Default
                advisoryThreshold = 0.60;
            }

            // REGIME PERSISTENCE (Smooth out regime flips)
            this.regimeHistory.push(regime);
            if (this.regimeHistory.length > 5) this.regimeHistory.shift();
            const stableRegime = this.regimeHistory.length >= 3
                ? (this.regimeHistory.slice(-3).every(r => r === regime) ? regime : this.regimeHistory[0])
                : regime;

            // Multi-Timeframe Confirmation
            const longTrend = history.length > 300 ? (currentPrice - history[0].p) : 0;
            const trendDir = longTrend > 0 ? 'UP' : 'DOWN';

            if (Math.abs(longTrend) > atr * 5 && finalSignal !== trendDir && finalSignal !== 'NEUTRAL') {
                finalConfidence *= 0.85; // Penalty for counter-trend
            }

            // Adjust based on track record
            if (this.stats.total < 24) {
                // New brain: be more aggressive to gather data
                convictionThreshold *= 0.95; // 5% easier
                advisoryThreshold *= 0.90;   // 10% easier
            }
            if (this.winStreak > 3) {
                // Hot streak: slightly more conservative
                convictionThreshold *= 1.05;
            }
            if (this.lossStreak > 1) {
                // Cold streak: much more conservative
                convictionThreshold *= 1.15;
                advisoryThreshold *= 1.10;
            }

            // SNIPER MODE: Dynamic Thresholds based on Odds (Value Betting)
            // If odds are cheap (e.g. 0.30), we need less confidence to take the bet (High EV)
            // If odds are expensive (e.g. 0.80), we need MORE confidence
            const marketOdds = finalSignal === 'UP' ? (currentMarkets[this.asset]?.yesPrice || 0.5) : (currentMarkets[this.asset]?.noPrice || 0.5);
            const oddsAdjustment = (0.5 - marketOdds) * 0.2; // +/- 0.10 adjustment
            convictionThreshold -= oddsAdjustment;
            advisoryThreshold -= oddsAdjustment;

            // REALITY CHECK: Kill confidence if price moves against us
            // If we predict UP but price drops > 4*ATR from entry, kill it (Widened from 3*ATR for Volatility)
            if (this.prediction === 'UP' && (startPrice - currentPrice) > atr * 4) {
                finalConfidence *= 0.5; // Nuke confidence
                log(`⚠️ REALITY CHECK: Price moving against UP prediction`, this.asset);
            }
            if (this.prediction === 'DOWN' && (currentPrice - startPrice) > atr * 4) {
                finalConfidence *= 0.5; // Nuke confidence
                log(`⚠️ REALITY CHECK: Price moving against DOWN prediction`, this.asset);
            }

            // MOMENTUM BOOST: Help reach Conviction if moving right way
            // Note: tier isn't assigned yet, so check confidence range directly
            if (finalConfidence > 0.55 && finalConfidence < 0.70) { // Advisory range
                // If we are close to 0.70 and price is moving in our favor
                if ((finalSignal === 'UP' && force > 0) || (finalSignal === 'DOWN' && force < 0)) {
                    finalConfidence += 0.05; // Stronger nudge (+5%)
                    log(`🚀 MOMENTUM BOOST: +5% (price moving in our favor)`, this.asset);
                }
            }

            // Penalize poor win rate
            if (this.stats.total > 10) {
                const winRate = this.stats.wins / this.stats.total;
                if (winRate < 0.5) finalConfidence *= 0.85;
            }

            // === CROSS-MARKET VALIDATION ===
            const allPredictions = ASSETS.map(a => Brains[a].prediction);
            const upCount = allPredictions.filter(p => p === 'UP').length;
            const downCount = allPredictions.filter(p => p === 'DOWN').length;

            if ((finalSignal === 'UP' && downCount > upCount + 1) ||
                (finalSignal === 'DOWN' && upCount > downCount + 1)) {
                finalConfidence *= 0.75; // Contrarian to market consensus
                log(`⚠️ Contrarian (${upCount}U/${downCount}D)`, this.asset);
            }

            if (trendBias) finalConfidence *= trendBias;

            // 🔥 EARLY PREDICTION BOOST (The "Prophet" Advantage)
            // Boost confidence for early predictions to enable frequent trading
            if (elapsed < 180 && finalSignal !== 'NEUTRAL') {
                const earlyBoost = 1.35; // SNIPER MODE: Aggressive but validated
                finalConfidence *= earlyBoost;
                log(`⚡ EARLY BOOST: +${((earlyBoost - 1) * 100).toFixed(0)}% (elapsed: ${elapsed}s)`, this.asset);
            }

            // CAP CONFIDENCE (prevent >100% from Consensus Bonus + Early Boost)
            finalConfidence = Math.min(1.0, finalConfidence);

            // === SMOOTHING (The "Pinball" Fix) ===
            // FIX: Reduced smoothing from 20/80 to 50/50 (was suppressing new signals!)
            // Alpha 0.5 = 50% new value, 50% old value (balanced)
            if (this.confidence > 0) {
                finalConfidence = (finalConfidence * 0.5) + (this.confidence * 0.5);
            }

            // Determine tier with HYSTERESIS (prevent flickering)
            // Must drop 3% below threshold to lose tier (More responsive than 5%)
            let newTier = 'NONE';
            if (finalConfidence >= convictionThreshold) newTier = 'CONVICTION';
            else if (finalConfidence >= advisoryThreshold) newTier = 'ADVISORY';

            // DIAGNOSTIC: Log every 30 seconds to see why we're not hitting CONVICTION
            if (elapsed % 30 < 2) {
                log(`📊 DIAG: Conf=${(finalConfidence * 100).toFixed(1)}% ConvThresh=${(convictionThreshold * 100).toFixed(1)}% AdvThresh=${(advisoryThreshold * 100).toFixed(1)}% Tier=${newTier} Elapsed=${elapsed}s Locked=${this.convictionLocked}`, this.asset);
            }

            // Hysteresis check
            if (this.tier === 'CONVICTION' && newTier !== 'CONVICTION') {
                if (finalConfidence > (convictionThreshold - 0.03)) newTier = 'CONVICTION'; // Hold tier
            }
            if (this.tier === 'ADVISORY' && newTier === 'NONE') {
                if (finalConfidence > (advisoryThreshold - 0.03)) newTier = 'ADVISORY'; // Hold tier
            }

            tier = newTier;

            // TIER LOCK
            if (this.tier === 'CONVICTION' && tier === 'ADVISORY' && this.prediction === finalSignal) {
                tier = 'CONVICTION';
                finalConfidence = Math.max(finalConfidence, convictionThreshold);
            }

            // === CYCLE COMMITMENT LOCK (Real-World Trading Mode) ===
            // Once committed to a direction, NEVER flip-flop for the entire cycle
            // This mimics real trading: once you buy shares, you can't switch sides
            if (this.cycleCommitted && finalSignal !== this.committedDirection) {
                // OVERRIDE: Keep committed direction NO MATTER WHAT
                finalSignal = this.committedDirection;
                // Keep existing tier but mark as committed
                if (tier === 'NONE') tier = 'ADVISORY'; // Don't drop below ADVISORY once committed
                log(`💎 CYCLE COMMITTED: Holding ${this.committedDirection} (no flip-flops allowed)`, this.asset);
            }

            // === CONVICTION LOCK SYSTEM (Anti-Whipsaw for Non-Committed) ===
            // This only applies before cycle commitment
            if (!this.cycleCommitted && this.convictionLocked && finalSignal !== this.lockedDirection) {
                const oppositeVotes = finalSignal === 'UP' ? downVotes : upVotes;
                const voteOverwhelm = oppositeVotes / totalVotes > 0.9;
                const forceOverwhelm = absForce > atr * 5.0;

                if (!voteOverwhelm && !forceOverwhelm) {
                    finalSignal = this.lockedDirection;
                    tier = 'CONVICTION';
                    log(`🔒 Lock held: Weak reversal ignored`, this.asset);
                } else {
                    this.convictionLocked = false;
                    log(`💥 Lock broken: Catastrophic reversal`, this.asset);
                }
            }

            // LIVE CONFIDENCE DECAY
            if (this.lastSignal && this.lastSignal.type !== 'NEUTRAL') {
                const priceDelta = currentPrice - checkpointPrices[this.asset];
                if ((this.lastSignal.type === 'UP' && priceDelta < -atr * 3) ||
                    (this.lastSignal.type === 'DOWN' && priceDelta > atr * 3)) {
                    finalConfidence *= 0.5;
                    tier = 'NONE';
                    log(`⚠️ CONFIDENCE DECAY: Signal invalidated`, this.asset);
                }
            }

            // Track vote history
            this.voteHistory.push({ up: upVotes, down: downVotes, time: Date.now() });
            if (this.voteHistory.length > 10) this.voteHistory.shift();

            // EXPORT HISTORY SNAPSHOT
            if (currentMarkets[this.asset]) {
                this.currentCycleHistory.push({
                    timestamp: new Date().toISOString(),
                    elapsed,
                    prediction: finalSignal,
                    confidence: finalConfidence,
                    tier,
                    edge: this.edge,
                    locked: this.convictionLocked,
                    committed: this.cycleCommitted,
                    currentPrice: currentPrice,
                    checkpointPrice: startPrice,
                    marketOdds: { yes: currentMarkets[this.asset].yesPrice, no: currentMarkets[this.asset].noPrice },
                    votes: votes,
                    modelVotes: modelVotes // Track individual votes
                });
            }

            // Calculate vote stability
            let voteFlips = 0;
            for (let i = 1; i < this.voteHistory.length; i++) {
                const prevLeader = this.voteHistory[i - 1].up > this.voteHistory[i - 1].down ? 'UP' : 'DOWN';
                const currLeader = this.voteHistory[i].up > this.voteHistory[i].down ? 'UP' : 'DOWN';
                if (prevLeader !== currLeader) voteFlips++;
            }
            const voteStability = this.voteHistory.length > 1 ? 1 - (voteFlips / (this.voteHistory.length - 1)) : 0;
            this.voteTrendScore = voteStability;

            // === DEBOUNCE & STABILITY ===
            if (finalSignal !== this.prediction) {
                if (finalSignal === this.pendingSignal) this.stabilityCounter++;
                else { this.pendingSignal = finalSignal; this.stabilityCounter = 0; }

                // Calculate required stability (FIXED: Simple calculation, no side effects)
                let requiredStability = 3;
                if (elapsed < 180) requiredStability = 3; // SNIPER MODE: Faster confirmation
                else if (elapsed < 600) requiredStability = 3;
                else requiredStability = 2; // Late cycle = faster

                // Cycle commitment (moved outside IIFE)
                if (!this.cycleCommitted && (tier === 'CONVICTION' || tier === 'ADVISORY') && elapsed < 300) {
                    const market = currentMarkets[this.asset];
                    if (market) {
                        const currentOdds = finalSignal === 'UP' ? market.yesPrice : market.noPrice;
                        if (currentOdds <= 0.85 || tier === 'CONVICTION') {
                            this.cycleCommitted = true;
                            this.committedDirection = finalSignal;
                            this.commitTime = Date.now();
                            log(`💎 CYCLE COMMITMENT: ${finalSignal} @${tier} tier, ${(currentOdds * 100).toFixed(1)}% odds (LOCKED FOR CYCLE)`, this.asset);
                        }
                    }
                }

                if (this.stabilityCounter >= requiredStability) {
                    this.prediction = finalSignal;
                    this.confidence = finalConfidence;
                    this.tier = tier;
                    this.stabilityCounter = 0;
                    this.pendingSignal = null;
                    log(`✅ PREDICTION FLIP: ${finalSignal} @ ${(finalConfidence * 100).toFixed(1)}%`, this.asset);
                }
            } else {
                this.confidence = finalConfidence;
                this.tier = tier;
                this.stabilityCounter = 0;
                this.pendingSignal = null;
                if (this.lastSignal) {
                    this.lastSignal.conf = finalConfidence;
                    this.lastSignal.tier = tier;
                }
            }

            // ==================== MULTI-MODE TRADING SYSTEM ====================
            // CRITICAL: This section is NOW OUTSIDE the debounce logic (BUG FIX)

            // MODE 1: ORACLE 🔮 - Final outcome prediction with near-certainty
            if (CONFIG.ORACLE.enabled && !this.convictionLocked && tier === 'CONVICTION' && elapsed < 300) {
                const market = currentMarkets[this.asset];
                if (market) {
                    const currentOdds = finalSignal === 'UP' ? market.yesPrice : market.noPrice;
                    const consensusVotes = Math.max(votes.UP, votes.DOWN);
                    const consensusRatio = totalVotes > 0 ? consensusVotes / totalVotes : 0;
                    const edgePercent = (finalConfidence - currentOdds) * 100;
                    const priceMovingRight = (finalSignal === 'UP' && force > 0) || (finalSignal === 'DOWN' && force < 0);
                    const isTrending = regime === 'TRENDING';
                    const stabilityMet = this.stabilityCounter >= CONFIG.ORACLE.minStability || this.prediction === finalSignal;

                    // 🔮 AGGRESSION SCALING: Higher aggression = lower thresholds = more trades
                    // Range: 0 (conservative) to 100 (aggressive)
                    // At 100%, thresholds drop by 30% (e.g., 70% consensus becomes 49%)
                    const aggression = (CONFIG.ORACLE.aggression || 50) / 100; // 0.0 to 1.0
                    const aggressionMultiplier = 1 - (aggression * 0.3); // 1.0 to 0.7

                    const adjustedMinConsensus = CONFIG.ORACLE.minConsensus * aggressionMultiplier;
                    const adjustedMinConfidence = CONFIG.ORACLE.minConfidence * aggressionMultiplier;
                    const adjustedMinEdge = CONFIG.ORACLE.minEdge * aggressionMultiplier;

                    log(`🔮 ORACLE CHECK: Cons=${(consensusRatio * 100).toFixed(0)}% Conf=${(finalConfidence * 100).toFixed(0)}% Edge=${edgePercent.toFixed(1)}% Aggression=${Math.round(aggression * 100)}%`, this.asset);

                    const oracleChecks = {
                        consensus: consensusRatio >= adjustedMinConsensus,
                        confidence: finalConfidence >= adjustedMinConfidence,
                        edge: edgePercent >= adjustedMinEdge,
                        regime: !CONFIG.ORACLE.requireTrending || isTrending,
                        momentum: !CONFIG.ORACLE.requireMomentum || priceMovingRight,
                        odds: currentOdds <= CONFIG.ORACLE.maxOdds,
                        stability: stabilityMet
                    };

                    const failedChecks = Object.entries(oracleChecks).filter(([k, v]) => !v).map(([k]) => k);

                    if (failedChecks.length === 0) {
                        this.convictionLocked = true;
                        this.lockedDirection = finalSignal;
                        this.lockTime = Date.now();
                        this.lockConfidence = finalConfidence;

                        log(`🔮🔮🔮 ORACLE MODE ACTIVATED 🔮🔮🔮`, this.asset);
                        log(`⚡ PROPHET SIGNAL: ${finalSignal} @ ${(finalConfidence * 100).toFixed(1)}% | Edge: ${edgePercent.toFixed(1)}%`, this.asset);

                        tradeExecutor.executeTrade(this.asset, finalSignal, 'ORACLE', finalConfidence, currentOdds, market);
                    } else {
                        log(`⏳ ORACLE: Missing ${failedChecks.join(', ')}`, this.asset);
                    }
                }
            }

            // MULTI-MODE SCANNING (Only if Multi-Mode is enabled)
            if (CONFIG.MULTI_MODE_ENABLED && currentMarkets[this.asset]) {
                const market = currentMarkets[this.asset];
                const yesPrice = market.yesPrice;
                const noPrice = market.noPrice;

                // Check exit conditions for existing positions
                tradeExecutor.checkExits(this.asset, currentPrice, elapsed, yesPrice, noPrice);

                // Scan for new opportunities (only if not already in ORACLE trade)
                if (!this.convictionLocked) {
                    const opportunities = opportunityDetector.scanAll(this.asset, {
                        confidence: finalConfidence,
                        prediction: finalSignal,
                        yesPrice,
                        noPrice,
                        volatility: atr / currentPrice,
                        regime,
                        elapsed,
                        history: history,
                        votes,
                        consensusRatio: totalVotes > 0 ? Math.max(votes.UP, votes.DOWN) / totalVotes : 0,
                        force,
                        atr
                    });

                    // Execute best opportunity (first in list after priority sort)
                    if (opportunities.length > 0) {
                        const opp = opportunities[0];
                        log(`📡 ${opp.mode} OPPORTUNITY: ${opp.direction} - ${opp.reason}`, this.asset);

                        const entryPrice = opp.direction === 'UP' ? yesPrice : noPrice;
                        const result = await tradeExecutor.executeTrade(this.asset, opp.direction, opp.mode, finalConfidence, entryPrice, market);

                        // Mark as traded if successful to prevent duplicate trades this cycle
                        if (result && result.success) {
                            opportunityDetector.markTraded(this.asset, opp.mode);
                        }
                    }
                }
            }

            // ==================== LATE CYCLE OPPORTUNITY DETECTION ====================
            // User Request: "odds can revert back to 50/50 in final few mins allowing another opportunity"
            // This detects when odds return to near 50/50 late in cycle with high confidence
            // MUST CHECK: Only if ORACLE mode is enabled
            if (CONFIG.ORACLE.enabled && currentMarkets[this.asset] && elapsed >= 540 && elapsed <= 780) { // 9-13 min window
                const market = currentMarkets[this.asset];
                const yesP = market.yesPrice;
                const noP = market.noPrice;

                // Check if odds are near 50/50 (between 40%-60%)
                const isNear5050 = yesP >= 0.40 && yesP <= 0.60;

                // Check if we have strong confidence that overrides the uncertainty
                const hasStrongSignal = finalConfidence >= 0.75 && tier !== 'NONE';

                // Check if we already have a position for this asset
                const hasExistingPosition = tradeExecutor.getPositionCount(this.asset) > 0;

                if (isNear5050 && hasStrongSignal && !hasExistingPosition) {
                    const lateEntryPrice = finalSignal === 'UP' ? yesP : noP;
                    const lateEdge = (finalConfidence - lateEntryPrice) * 100;

                    if (lateEdge >= 10) { // Only if 10%+ edge
                        log(`⚡ LATE CYCLE OPPORTUNITY: Odds at ${(yesP * 100).toFixed(0)}% (near 50/50), confidence ${(finalConfidence * 100).toFixed(0)}%`, this.asset);
                        log(`🎯 LATE ENTRY: ${finalSignal} @ ${(lateEntryPrice * 100).toFixed(1)}¢ with ${lateEdge.toFixed(1)}% edge`, this.asset);

                        // Execute as ORACLE trade (hold to resolution)
                        tradeExecutor.executeTrade(this.asset, finalSignal, 'ORACLE', finalConfidence, lateEntryPrice, market);
                    }
                }
            }

            // EDGE CALCULATION

            if (currentMarkets[this.asset] && this.prediction !== 'WAIT') {
                const market = currentMarkets[this.asset];
                const marketProb = this.prediction === 'UP' ? market.yesPrice : market.noPrice;
                this.edge = (this.confidence - marketProb) * 100;
            } else {
                this.edge = 0;
            }

            // CRITICAL: Save signal state for UI display
            this.lastSignal = {
                type: finalSignal,
                confidence: finalConfidence,
                tier: tier,
                modelVotes: modelVotes
            };

        } catch (e) {
            log(`❌ CRITICAL ERROR in update cycle: ${e.message}`, this.asset);
        } finally {
            this.isProcessing = false;
        }
    }

    // Check if market is tradeable (tight spread, valid prices)
    isMarketHealthy() {
        const m = currentMarkets[this.asset];
        if (!m) return false;
        const spread = Math.abs(1 - (m.yesPrice + m.noPrice));
        if (spread > 0.05) return false; // >5% spread/fee is too high
        if (m.yesPrice < 0.02 || m.yesPrice > 0.98) return false; // Too extreme
        return true;
    }

    // KELLY CRITERION (Enhanced Position Sizing)
    getKellySize() {
        if (this.confidence < 0.6 || this.tier === 'NONE') return 0;

        const market = currentMarkets[this.asset];
        if (!market) return 0;

        const marketOdds = this.prediction === 'UP' ? market.yesPrice : market.noPrice;
        const b = (1 / marketOdds) - 1;
        const p = this.confidence;
        const q = 1 - p;

        let kellyFraction = (b * p - q) / b;

        // Adjust for recent performance
        if (this.stats.total >= 10) {
            const winRate = this.stats.wins / this.stats.total;
            if (winRate < 0.4) kellyFraction *= 0.3; // Severe cut if losing badly
            else if (winRate < 0.5) kellyFraction *= 0.5; // Cut size if losing
            else if (winRate > 0.65) kellyFraction *= 1.2; // Increase if winning
        }

        // Adjust for loss streaks
        if (this.lossStreak > 2) kellyFraction *= 0.5;

        // Quarter Kelly (conservative)
        const conservativeKelly = kellyFraction * 0.25;

        // Hard caps: never risk more than 10% of bankroll
        return Math.max(0, Math.min(conservativeKelly, 0.10));
    }

    evaluateOutcome(finalPrice, startPrice) {
        if (!startPrice) return;

        const actual = finalPrice > startPrice ? 'UP' : 'DOWN';
        const predicted = this.lastSignal ? this.lastSignal.type : 'NEUTRAL';
        const tier = this.lastSignal ? this.lastSignal.tier : 'NONE';

        if (predicted !== 'NEUTRAL') {
            this.stats.total++;
            const isWin = predicted === actual;

            if (isWin) {
                this.stats.wins++;
                this.winStreak++;
                this.lossStreak = 0;
                this.atrMultiplier = Math.max(1.2, this.atrMultiplier - 0.80);
                if (tier === 'CONVICTION') { this.stats.convictionTotal++; this.stats.convictionWins++; }
                log(`✅ WIN (${tier}). Evolving: ATR x${this.atrMultiplier.toFixed(2)}`, this.asset);
            } else {
                this.winStreak = 0;
                this.lossStreak++;
                this.atrMultiplier = Math.min(3.5, this.atrMultiplier + 2.50);
                if (tier === 'CONVICTION') { this.stats.convictionTotal++; }
                log(`❌ LOSS (${tier}). Evolving: ATR x${this.atrMultiplier.toFixed(2)}`, this.asset);
            }

            // FINAL SEVEN: CALIBRATION TRACKING
            if (this.lastSignal && this.lastSignal.conf) {
                const conf = this.lastSignal.conf;
                const bucket = conf >= 0.98 ? '0.98-1.00' : (conf >= 0.95 ? '0.95-0.98' : '0.90-0.95');
                if (this.calibrationBuckets[bucket]) {
                    this.calibrationBuckets[bucket].total++;
                    if (isWin) this.calibrationBuckets[bucket].wins++;
                }
            }

            // FIX: Track recent form OUTSIDE modelVotes block (was never updating!)
            this.recentOutcomes.push(isWin);
            if (this.recentOutcomes.length > 10) this.recentOutcomes.shift();

            // FINAL SEVEN: MODEL WEIGHT ADAPTATION (Learning Loop)
            if (this.lastSignal && this.lastSignal.modelVotes) {
                for (const [model, vote] of Object.entries(this.lastSignal.modelVotes)) {
                    if (this.modelAccuracy[model]) {
                        this.modelAccuracy[model].total++;
                        if (vote === actual) {
                            this.modelAccuracy[model].wins++;
                        }
                    }
                }

                // SMART MEMORY: Update the pattern that generated this signal (if any)
                if (this.lastSignal && this.lastSignal.patternId) {
                    const pIndex = memoryPatterns[this.asset].findIndex(p => p.id === this.lastSignal.patternId);
                    if (pIndex !== -1) {
                        memoryPatterns[this.asset][pIndex].wasCorrect = isWin;
                        memoryPatterns[this.asset][pIndex].matchCount++;
                        if (isWin) {
                            memoryPatterns[this.asset][pIndex].wins = (memoryPatterns[this.asset][pIndex].wins || 0) + 1;
                        }
                        // Persist update to Redis if available
                        if (redisAvailable && redis) {
                            redis.set(`patterns:${this.asset}`, JSON.stringify(memoryPatterns[this.asset])).catch(e => { });
                        }
                    }
                }

                // Save pattern to Historian
                const history = priceHistory[this.asset];
                if (history.length >= 10) {
                    const recent = history.slice(-10).map(x => x.p);
                    const base = recent[0];
                    const vector = recent.map(p => (p - base) / base);
                    savePattern(this.asset, vector, actual);
                }

                this.lockState = 'NEUTRAL';
                this.lockStrength = 0;
                this.lastSignal = null;
                this.prediction = 'WAIT';
                this.tier = 'NONE';
                this.stabilityCounter = 0;
                this.pendingSignal = null;

                // Reset conviction lock for new cycle
                this.convictionLocked = false;
                this.lockedDirection = null;
                this.lockTime = null;
                this.lockConfidence = 0;
                this.voteHistory = [];

                // Reset cycle commitment for new cycle
                this.cycleCommitted = false;
                this.committedDirection = null;
                this.commitTime = null;

                // Clear export history for new cycle
                this.currentCycleHistory = [];
            }
        }
    }
}

const Brains = {};
ASSETS.forEach(a => Brains[a] = new SupremeBrain(a));

// ==================== DATA FETCHING ====================

// 🔮 CHAINLINK STABILITY: Track last data received for timeout-based reconnection
let lastChainlinkDataTime = Date.now();
let activeWebSocket = null;
let wsHeartbeatInterval = null;
let wsTimeoutInterval = null;

function connectWebSocket() {
    log('🔌 Attempting WebSocket connection to Polymarket...');

    // Clear any existing intervals
    if (wsHeartbeatInterval) clearInterval(wsHeartbeatInterval);
    if (wsTimeoutInterval) clearInterval(wsTimeoutInterval);

    const ws = new WebSocket(WS_ENDPOINT);
    activeWebSocket = ws;

    ws.on('open', () => {
        log('✅ Connected to Polymarket WS');
        lastChainlinkDataTime = Date.now(); // Reset on connection

        // Subscribe to Chainlink price feed (PRIMARY source)
        const chainlinkSub = { action: 'subscribe', subscriptions: [{ topic: 'crypto_prices_chainlink', type: '*' }] };
        ws.send(JSON.stringify(chainlinkSub));
        log('📡 Subscribed to crypto_prices_chainlink');

        // Backup price feed subscription
        const pricesSub = { action: 'subscribe', subscriptions: [{ topic: 'crypto_prices', type: 'update', filters: 'btcusdt,ethusdt,solusdt,xrpusdt' }] };
        ws.send(JSON.stringify(pricesSub));
        log('📡 Subscribed to crypto_prices backup');

        // Keep-alive ping every 30 seconds
        wsHeartbeatInterval = setInterval(() => {
            if (ws.readyState === WebSocket.OPEN) {
                ws.send('PING');
            }
        }, 30000);

        // 🔮 CHAINLINK STABILITY: Check for stale data every 15 seconds
        wsTimeoutInterval = setInterval(() => {
            const staleMs = Date.now() - lastChainlinkDataTime;
            if (staleMs > 60000 && ws.readyState === WebSocket.OPEN) {
                log(`⚠️ CHAINLINK TIMEOUT: No data for ${Math.floor(staleMs / 1000)}s - forcing reconnection...`);
                ws.close(4000, 'Stale data timeout');
            } else if (staleMs > 30000 && staleMs <= 60000) {
                log(`⚠️ Chainlink data stale: ${Math.floor(staleMs / 1000)}s since last update`);
            }
        }, 15000);
    });

    ws.on('message', (data) => {
        try {
            const str = data.toString();
            if (str === 'PONG') return;

            const msg = JSON.parse(str);

            // Debug first few messages to understand structure
            if (!global.wsMessageCount) global.wsMessageCount = 0;
            if (global.wsMessageCount < 5) {
                log(`📨 WS Message: ${JSON.stringify(msg).substring(0, 200)}...`);
                global.wsMessageCount++;
            }

            if (msg.topic === 'crypto_prices_chainlink') {
                const map = { 'btc/usd': 'BTC', 'eth/usd': 'ETH', 'sol/usd': 'SOL', 'xrp/usd': 'XRP' };
                const asset = map[msg.payload?.symbol];
                if (asset && msg.payload?.value) {
                    const price = parseFloat(msg.payload.value);
                    livePrices[asset] = price;
                    const now = Date.now();
                    lastUpdateTimestamp = now;
                    lastChainlinkDataTime = now; // 🔮 Update heartbeat timestamp
                    priceHistory[asset].push({ t: now, p: price });
                    if (priceHistory[asset].length > 500) priceHistory[asset].shift();

                    // Log first price for each asset
                    if (!global.firstPriceLogged) global.firstPriceLogged = {};
                    if (!global.firstPriceLogged[asset]) {
                        log(`💰 Chainlink Price: ${asset} = $${price.toFixed(2)}`, asset);
                        global.firstPriceLogged[asset] = true;
                    }
                }
            }
            if (msg.topic === 'crypto_prices' && msg.type === 'update') {
                const map = { btcusdt: 'BTC', ethusdt: 'ETH', solusdt: 'SOL', xrpusdt: 'XRP' };
                const asset = map[msg.payload?.symbol];
                if (asset && !livePrices[asset] && msg.payload?.value) {
                    const price = parseFloat(msg.payload.value);
                    livePrices[asset] = price;
                    const now = Date.now();
                    lastUpdateTimestamp = now;
                    priceHistory[asset].push({ t: now, p: price }); // 🔮 FIX: Parse to float
                    if (priceHistory[asset].length > 500) priceHistory[asset].shift();
                }
            }
        } catch (e) {
            log(`⚠️ WS Parse Error: ${e.message}`);
        }
    });

    ws.on('close', (code, reason) => {
        log(`⚠️ WS Disconnected (code: ${code}, reason: ${reason}). Reconnecting in 5s...`);
        // Clear intervals on close
        if (wsHeartbeatInterval) clearInterval(wsHeartbeatInterval);
        if (wsTimeoutInterval) clearInterval(wsTimeoutInterval);
        setTimeout(connectWebSocket, 5000);
    });

    ws.on('error', (e) => {
        log(`❌ WS Error: ${e.message}`);
        // Error will trigger close event, which handles reconnection
    });
}

async function fetchJSON(url) {
    try {
        const res = await fetch(url);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return await res.json();
    } catch (e) { return null; }
}

async function fetchCurrentMarkets() {
    const marketStart = getCurrentCheckpoint();
    for (const asset of ASSETS) {
        const slug = `${asset.toLowerCase()}-updown-15m-${marketStart}`;
        try {
            const eventUrl = `${GAMMA_API}/events/slug/${slug}`;
            const eventData = await fetchJSON(eventUrl);

            if (!eventData?.markets?.length) {
                log(`⚠️ No market found for ${slug}`, asset);
                currentMarkets[asset] = null;
                continue;
            }

            const market = eventData.markets.find(m => m.active && !m.closed) || eventData.markets[0];
            if (!market.clobTokenIds) {
                log(`⚠️ No token IDs for market`, asset);
                currentMarkets[asset] = null;
                continue;
            }

            const tokenIds = JSON.parse(market.clobTokenIds);
            const [upBook, downBook] = await Promise.all([
                fetchJSON(`${CLOB_API}/book?token_id=${tokenIds[0]}`),
                fetchJSON(`${CLOB_API}/book?token_id=${tokenIds[1]}`)
            ]);

            let yesPrice = 0.5, noPrice = 0.5;

            // Extract best ask prices from order book
            if (upBook?.asks?.length) {
                const sortedUpAsks = [...upBook.asks].sort((a, b) => parseFloat(a.price) - parseFloat(b.price));
                yesPrice = parseFloat(sortedUpAsks[0].price);
            } else if (downBook?.asks?.length) {
                const sortedDownAsks = [...downBook.asks].sort((a, b) => parseFloat(a.price) - parseFloat(b.price));
                noPrice = parseFloat(sortedDownAsks[0].price);
                yesPrice = 1 - noPrice;
            }

            if (downBook?.asks?.length) {
                const sortedDownAsks = [...downBook.asks].sort((a, b) => parseFloat(a.price) - parseFloat(b.price));
                noPrice = parseFloat(sortedDownAsks[0].price);
            } else if (upBook?.asks?.length) {
                noPrice = 1 - yesPrice;
            }

            if (!marketOddsHistory[asset]) marketOddsHistory[asset] = [];
            marketOddsHistory[asset].push({ yes: yesPrice, no: noPrice, timestamp: Date.now() });
            if (marketOddsHistory[asset].length > 100) marketOddsHistory[asset].shift();

            currentMarkets[asset] = {
                slug: eventData.slug,
                title: eventData.title,
                yesPrice,
                noPrice,
                marketUrl: `https://polymarket.com/event/${eventData.slug}`,
                volume: market.volume24hr || 0,
                lastUpdated: Date.now(),
                tokenIds: { yes: tokenIds[0], no: tokenIds[1] } // Store Token IDs for trading
            };

            log(`📊 Odds: YES ${(yesPrice * 100).toFixed(1)}% | NO ${(noPrice * 100).toFixed(1)}%`, asset);
        } catch (e) {
            log(`❌ Market fetch error: ${e.message}`, asset);

            // FINAL SEVEN: MARKET DATA FALLBACK
            // If fetch fails, use last known data if < 30 seconds old
            if (currentMarkets[asset] && (Date.now() - currentMarkets[asset].lastUpdated) < 30000) {
                log(`⚠️ Using cached market data for ${asset} (Grace Period)`);
                // Keep existing currentMarkets[asset]
            } else {
                currentMarkets[asset] = null;
            }
        }
        await new Promise(r => setTimeout(r, 300));
    }
}

async function fetchFearGreedIndex() {
    try {
        const data = await fetchJSON('https://api.alternative.me/fng/');
        if (data) {
            fearGreedIndex = parseInt(data.data[0].value);
            log(`Fear & Greed: ${fearGreedIndex}`);
        }
    } catch (e) { }
}

async function fetchFundingRates() {
    const symbolMap = { 'BTC': 'BTCUSDT', 'ETH': 'ETHUSDT', 'SOL': 'SOLUSDT', 'XRP': 'XRPUSDT' };
    for (const asset of ASSETS) {
        try {
            const data = await fetchJSON(`https://fapi.binance.com/fapi/v1/premiumIndex?symbol=${symbolMap[asset]}`);
            if (data) fundingRates[asset] = { rate: parseFloat(data.lastFundingRate), timestamp: Date.now() };
        } catch (e) { }
        await new Promise(r => setTimeout(r, 250));
    }
}

// ==================== PERSISTENCE (REDIS-BACKED) ====================
const DB_FILE = 'deity_state.json';

// ==================== PRICE VALIDATION (Chainlink-Only) ====================
// Polymarket outcomes are determined by Chainlink - DO NOT use other price sources!
async function validatePrices() {
    const now = Date.now();
    let staleAssets = [];

    for (const asset of ASSETS) {
        const lastPriceTime = priceHistory[asset]?.length > 0 ?
            priceHistory[asset][priceHistory[asset].length - 1]?.t : 0;
        const age = now - lastPriceTime;

        // Warn if Chainlink WS hasn't sent data in >30 seconds
        if (!livePrices[asset] || age > 30000) {
            staleAssets.push(asset);
        }
    }

    if (staleAssets.length > 0) {
        log(`⚠️ CHAINLINK STALE: ${staleAssets.join(', ')} - No WS data for >30s. DO NOT TRADE!`);
        log(`   Waiting for Chainlink WS to reconnect...`);
    }

    // CRITICAL: Initialize checkpoints if we have Chainlink prices but no checkpoints
    const cp = getCurrentCheckpoint();
    for (const asset of ASSETS) {
        if (!checkpointPrices[asset] && livePrices[asset]) {
            checkpointPrices[asset] = livePrices[asset];
            log(`🔄 Checkpoint initialized from Chainlink: ${asset} = $${livePrices[asset].toFixed(2)}`, asset);
        }
    }
}



async function saveState() {
    const state = {
        stats: ASSETS.reduce((acc, a) => ({ ...acc, [a]: Brains[a].stats }), {}),
        evolution: ASSETS.reduce((acc, a) => ({
            ...acc, [a]: {
                atrMultiplier: Brains[a].atrMultiplier,
                winStreak: Brains[a].winStreak,
                lossStreak: Brains[a].lossStreak
            }
        }), {}),
        // NEW: Checkpoint state for mid-cycle restart recovery
        checkpoints: {
            timestamp: getCurrentCheckpoint(),
            prices: ASSETS.reduce((acc, a) => ({ ...acc, [a]: checkpointPrices[a] }), {}),
            evaluated: ASSETS.reduce((acc, a) => ({ ...acc, [a]: lastEvaluatedCheckpoint[a] }), {})
        },
        // FINAL SEVEN: PERSISTENCE
        calibration: ASSETS.reduce((acc, a) => ({ ...acc, [a]: Brains[a].calibrationBuckets }), {}),
        regime: ASSETS.reduce((acc, a) => ({ ...acc, [a]: Brains[a].regimeHistory }), {})
    };

    // Save to Redis if available
    if (redisAvailable && redis) {
        try {
            await redis.set('deity:state', JSON.stringify(state));
        } catch (e) {
            log(`⚠️ Redis state save error: ${e.message}`);
        }
    }
}

async function loadState() {
    // Try Redis first
    if (redisAvailable && redis) {
        try {
            // LOAD PERSISTED SETTINGS FIRST (survives restarts!)
            const savedSettings = await redis.get('deity:settings');
            if (savedSettings) {
                const settings = JSON.parse(savedSettings);

                // CRITICAL: These keys should NEVER be overwritten from Redis
                // Environment variables ALWAYS take priority for security
                const protectedKeys = [
                    'POLYMARKET_PRIVATE_KEY',
                    'POLYMARKET_API_KEY',
                    'POLYMARKET_SECRET',
                    'POLYMARKET_PASSPHRASE',
                    'POLYMARKET_ADDRESS'
                ];

                // Apply persisted settings to CONFIG (except protected keys)
                for (const [key, value] of Object.entries(settings)) {
                    if (CONFIG.hasOwnProperty(key) && value !== undefined && value !== null) {
                        if (protectedKeys.includes(key)) {
                            log(`🔒 Skipping Redis override for ${key} (env var takes priority)`);
                            continue; // Skip - use env var instead
                        }
                        CONFIG[key] = value;
                    }
                }
                log('⚙️ Settings restored from Redis (credentials from env)');

                // Reload wallet with ENV credentials (not Redis!)
                tradeExecutor.mode = CONFIG.TRADE_MODE;
                tradeExecutor.paperBalance = CONFIG.PAPER_BALANCE;
                // Note: reloadWallet() is NOT called here - wallet was already loaded from env at startup
            }

            const stored = await redis.get('deity:state');
            if (stored) {
                const state = JSON.parse(stored);
                if (state.stats) ASSETS.forEach(a => { if (state.stats[a]) Brains[a].stats = state.stats[a]; });
                if (state.evolution) ASSETS.forEach(a => {
                    if (state.evolution[a]) {
                        Brains[a].atrMultiplier = state.evolution[a].atrMultiplier;
                        Brains[a].winStreak = state.evolution[a].winStreak;
                        Brains[a].lossStreak = state.evolution[a].lossStreak;
                    }
                });

                // MID-CYCLE CHECKPOINT CONTINUATION
                if (state.checkpoints) {
                    const now = Math.floor(Date.now() / 1000);
                    const currentCycle = getCurrentCheckpoint();
                    const savedCycle = state.checkpoints.timestamp;
                    const timeLeftInCycle = (savedCycle + INTERVAL_SECONDS) - now;

                    // If same cycle AND more than 5 mins left: Resume with saved checkpoints
                    if (currentCycle === savedCycle && timeLeftInCycle > 300) {
                        ASSETS.forEach(a => {
                            if (state.checkpoints.prices[a]) {
                                checkpointPrices[a] = state.checkpoints.prices[a];
                                previousCheckpointPrices[a] = state.checkpoints.prices[a];
                            }
                            if (state.checkpoints.evaluated[a]) {
                                lastEvaluatedCheckpoint[a] = state.checkpoints.evaluated[a];
                            }
                        });
                        log(`🔄 Resumed mid-cycle @ ${currentCycle} (${Math.floor(timeLeftInCycle / 60)}m ${timeLeftInCycle % 60}s remaining)`);
                    } else if (timeLeftInCycle <= 300 && timeLeftInCycle > 0) {
                        log(`⏸️ Less than 5 mins left in cycle - waiting for next checkpoint`);
                    }
                }

                // FINAL SEVEN: RESTORE CALIBRATION & REGIME
                if (state.calibration) ASSETS.forEach(a => { if (state.calibration[a]) Brains[a].calibrationBuckets = state.calibration[a]; });
                if (state.regime) ASSETS.forEach(a => { if (state.regime[a]) Brains[a].regimeHistory = state.regime[a]; });

                log('💾 State Restored from Redis');
                return;
            }
        } catch (e) {
            log(`⚠️ Redis state load error: ${e.message}`);
        }
    }

    log('ℹ️ Starting with fresh state');
}

// ==================== API & SERVER ====================

// Home route - UNIFIED ALL-IN-ONE DASHBOARD
app.get('/', (req, res) => {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    res.set('Pragma', 'no-cache');
    res.set('Expires', '0');
    res.send(`
<!DOCTYPE html>
<html>
<head>
    <title>🔮 Supreme Oracle - Prophet Trading System</title>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { font-family: 'Segoe UI', sans-serif; background: linear-gradient(135deg, #0a0f1c 0%, #1a1f3c 50%, #0d1225 100%); color: #e0e8ff; min-height: 100vh; }
        .nav { background: rgba(0,0,0,0.6); padding: 12px 25px; display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid rgba(100,150,255,0.2); position: sticky; top: 0; z-index: 100; backdrop-filter: blur(10px); }
        .nav-brand { font-size: 1.4em; font-weight: bold; color: #ffd700; }
        .nav-links { display: flex; gap: 10px; flex-wrap: wrap; }
        .nav-btn { background: rgba(100,150,255,0.2); border: 1px solid rgba(100,150,255,0.3); color: #88ccff; padding: 8px 16px; border-radius: 8px; cursor: pointer; font-size: 0.9em; transition: all 0.3s; }
        .nav-btn:hover { background: rgba(100,150,255,0.4); transform: scale(1.05); }
        .nav-btn.live { background: rgba(255,0,100,0.3); border-color: #ff0066; color: #ff88aa; }
        .nav-btn.paper { background: rgba(255,150,0,0.3); border-color: #ff9800; color: #ffcc80; }
        .status-bar { background: linear-gradient(90deg, rgba(0,255,100,0.1), rgba(0,200,255,0.1)); padding: 10px 25px; display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 10px; border-bottom: 1px solid rgba(0,255,100,0.2); }
        .countdown { font-size: 1.6em; font-weight: bold; color: #00ff88; text-shadow: 0 0 15px #00ff88; }
        .balance-display .amount { color: #ffd700; font-weight: bold; }
        .mode-badge { padding: 4px 12px; border-radius: 15px; font-weight: bold; font-size: 0.8em; }
        .mode-badge.PAPER { background: #ff9800; color: #000; }
        .mode-badge.LIVE { background: #ff0066; color: #fff; animation: pulse 2s infinite; }
        .main-container { padding: 15px; max-width: 1500px; margin: 0 auto; }
        .predictions-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); gap: 15px; margin-bottom: 20px; }
        .asset-card { background: linear-gradient(145deg, rgba(20,30,60,0.9), rgba(10,20,40,0.95)); border-radius: 14px; padding: 18px; border: 2px solid rgba(100,150,255,0.15); transition: all 0.3s; }
        .asset-card:hover { transform: translateY(-3px); border-color: rgba(100,150,255,0.4); box-shadow: 0 8px 30px rgba(0,100,255,0.2); }
        .asset-card.locked { border-color: #ff0066; box-shadow: 0 0 25px rgba(255,0,100,0.3); }
        .asset-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px; }
        .asset-name { font-size: 1.5em; font-weight: bold; }
        .asset-price { color: #88ccff; font-size: 0.9em; }
        .prediction { text-align: center; margin: 15px 0; }
        .prediction-value { font-size: 3em; font-weight: bold; text-shadow: 0 0 25px currentColor; }
        .prediction-value.UP { color: #00ff88; }
        .prediction-value.DOWN { color: #ff4466; }
        .prediction-value.WAIT { color: #ffaa00; font-size: 2em; }
        .confidence-bar { height: 6px; background: rgba(255,255,255,0.1); border-radius: 3px; margin: 12px 0 8px; overflow: hidden; }
        .confidence-fill { height: 100%; border-radius: 3px; transition: width 0.5s; }
        .confidence-fill.high { background: linear-gradient(90deg, #00ff88, #00cc66); }
        .confidence-fill.medium { background: linear-gradient(90deg, #ffaa00, #ff8800); }
        .confidence-fill.low { background: linear-gradient(90deg, #ff4466, #cc2244); }
        .tier { display: inline-block; padding: 4px 12px; border-radius: 15px; font-weight: bold; font-size: 0.8em; }
        .tier.CONVICTION { background: linear-gradient(90deg, #ff0066, #cc0055); }
        .tier.ADVISORY { background: linear-gradient(90deg, #ff9900, #cc7700); }
        .tier.NONE { background: #444; }
        .stats-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; margin-top: 12px; padding-top: 12px; border-top: 1px solid rgba(255,255,255,0.1); }
        .stat { text-align: center; }
        .stat-label { font-size: 0.7em; color: #888; text-transform: uppercase; }
        .stat-value { font-size: 1em; font-weight: bold; color: #88ccff; }
        .market-link { display: block; text-align: center; margin-top: 12px; color: #4fc3f7; text-decoration: none; font-size: 0.8em; }
        .trading-panel { background: linear-gradient(145deg, rgba(20,30,60,0.9), rgba(10,20,40,0.95)); border-radius: 14px; padding: 20px; border: 2px solid rgba(100,150,255,0.15); }
        .panel-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 15px; }
        .panel-title { font-size: 1.2em; font-weight: bold; color: #ffd700; }
        .positions-list { max-height: 180px; overflow-y: auto; }
        .position-item { display: flex; justify-content: space-between; padding: 8px 12px; background: rgba(0,0,0,0.3); border-radius: 6px; margin-bottom: 6px; font-size: 0.9em; }
        .no-positions { text-align: center; color: #666; padding: 15px; }
        .modal-overlay { display: none; position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0,0,0,0.85); z-index: 1000; justify-content: center; align-items: center; backdrop-filter: blur(5px); }
        .modal-overlay.active { display: flex; }
        .modal { background: linear-gradient(145deg, #1a2040, #0d1530); border-radius: 16px; padding: 25px; max-width: 650px; width: 92%; max-height: 85vh; overflow-y: auto; border: 2px solid rgba(100,150,255,0.3); box-shadow: 0 20px 60px rgba(0,0,0,0.5); }
        .modal-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px; border-bottom: 1px solid rgba(255,255,255,0.1); padding-bottom: 12px; }
        .modal-title { font-size: 1.3em; font-weight: bold; color: #ffd700; }
        .modal-close { background: none; border: none; font-size: 1.5em; color: #888; cursor: pointer; }
        .modal-close:hover { color: #ff4466; }
        .form-group { margin-bottom: 15px; }
        .form-group label { display: block; margin-bottom: 6px; color: #88ccff; font-weight: bold; font-size: 0.85em; }
        .form-group input, .form-group select { width: 100%; padding: 10px 12px; border: 2px solid rgba(100,150,255,0.2); border-radius: 8px; background: rgba(0,0,0,0.4); color: #fff; font-size: 0.95em; }
        .form-group input:focus { border-color: #4fc3f7; outline: none; }
        .form-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
        .btn { padding: 10px 20px; border: none; border-radius: 8px; font-size: 0.95em; font-weight: bold; cursor: pointer; transition: all 0.3s; }
        .btn-primary { background: linear-gradient(90deg, #4fc3f7, #2196f3); color: #fff; }
        .btn-primary:hover { transform: scale(1.02); box-shadow: 0 4px 15px rgba(33,150,243,0.4); }
        .btn-danger { background: linear-gradient(90deg, #ff4466, #cc2244); color: #fff; }
        .mode-toggle { display: flex; gap: 10px; margin-bottom: 15px; }
        .mode-toggle button { flex: 1; padding: 12px; border: 2px solid rgba(255,255,255,0.2); border-radius: 8px; background: rgba(0,0,0,0.3); color: #fff; cursor: pointer; font-weight: bold; }
        .mode-toggle button.active.paper { border-color: #ff9800; background: rgba(255,150,0,0.3); }
        .mode-toggle button.active.live { border-color: #ff0066; background: rgba(255,0,100,0.3); }
        .wallet-balances { display: grid; grid-template-columns: 1fr 1fr; gap: 15px; margin-bottom: 20px; }
        .balance-card { text-align: center; padding: 15px; background: rgba(0,0,0,0.3); border-radius: 10px; }
        .balance-amount { font-size: 1.8em; font-weight: bold; color: #ffd700; }
        .balance-label { color: #888; font-size: 0.85em; margin-top: 4px; }
        .address-box { background: rgba(0,0,0,0.4); padding: 12px; border-radius: 8px; font-family: monospace; font-size: 0.8em; word-break: break-all; margin-bottom: 12px; }
        .guide-section { margin-bottom: 20px; }
        .guide-section h3 { color: #00ff88; margin-bottom: 8px; font-size: 1.1em; }
        .guide-section p { color: #aaa; line-height: 1.5; font-size: 0.9em; }
        .mode-card { padding: 12px; background: rgba(0,0,0,0.3); border-radius: 8px; margin-bottom: 8px; border-left: 3px solid; font-size: 0.9em; }
        .mode-card.oracle { border-color: #9933ff; }
        .mode-card.arb { border-color: #00ff88; }
        .mode-card.scalp { border-color: #ff6600; }
        .status-msg { padding: 10px; border-radius: 6px; margin-top: 12px; text-align: center; display: none; font-size: 0.9em; }
        .status-msg.success { background: rgba(0,255,100,0.2); border: 1px solid #00ff88; display: block; }
        .status-msg.error { background: rgba(255,0,0,0.2); border: 1px solid #ff4466; display: block; }
        @keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.7; } }
        @media (max-width: 768px) { .nav { flex-direction: column; gap: 10px; } .status-bar { flex-direction: column; text-align: center; } .predictions-grid { grid-template-columns: 1fr; } .form-grid, .wallet-balances { grid-template-columns: 1fr; } .stats-grid { grid-template-columns: repeat(2, 1fr); } }
    </style>
</head>
<body>
    <nav class="nav">
        <div class="nav-brand">🔮 Supreme Oracle</div>
        <div class="nav-links">
            <button class="nav-btn" onclick="openModal('walletModal')">💰 Wallet</button>
            <button class="nav-btn" onclick="openModal('settingsModal')">⚙️ Settings</button>
            <button class="nav-btn" onclick="openModal('guideModal')">📚 Guide</button>
            <button class="nav-btn" onclick="openModal('pendingSellsModal'); loadPendingSells();">🔄 Recovery</button>
            <button class="nav-btn" id="modeBtn">📝 PAPER</button>
        </div>
    </nav>
    <div class="status-bar">
        <div><span style="color:#888;">Next:</span> <span class="countdown" id="countdown">--:--</span></div>
        <div class="balance-display">
            <span style="color:#888;">Paper:</span> <span class="amount" id="balance">$0.00</span>
            <span style="color:#888;margin-left:15px;">Live USDC:</span> <span class="amount" id="liveBalance" style="color:#00ff88;">$0.00</span>
            <span style="color:#888;margin-left:15px;">P/L:</span> <span id="pnl" style="color:#00ff88;">$0.00</span>
            <span style="color:#888;margin-left:15px;">W/L:</span> <span id="winLoss" style="color:#ffd700;">0/0</span>
        </div>
        <span class="mode-badge" id="modeBadge">PAPER</span>
    </div>
    <div class="main-container">
        <div class="predictions-grid" id="predictionsGrid"><div style="text-align:center;padding:40px;color:#666;">Loading predictions...</div></div>
        <div class="trading-panel">
            <div class="panel-header"><span class="panel-title">📊 Active Positions</span><span id="positionCount">0 positions</span></div>
            <div class="positions-list" id="positionsList"><div class="no-positions">No active positions</div></div>
        </div>
        <div class="trading-panel" style="margin-top:15px;">
            <div class="panel-header"><span class="panel-title">📜 Trade History</span><span id="historyCount">0 trades</span></div>
            <div class="positions-list" id="tradeHistory"><div class="no-positions">No trades yet</div></div>
        </div>
    </div>
    <!-- WALLET MODAL -->
    <div class="modal-overlay" id="walletModal">
        <div class="modal">
            <div class="modal-header"><span class="modal-title">💰 Wallet</span><button class="modal-close" onclick="closeModal('walletModal')">×</button></div>
            <div class="wallet-balances">
                <div class="balance-card"><div class="balance-amount" id="usdcBalance">$0.00</div><div class="balance-label">USDC (Trading)</div></div>
                <div class="balance-card"><div class="balance-amount" id="maticBalance" style="color:#8b5cf6;">0.00</div><div class="balance-label">MATIC (Gas)</div></div>
            </div>
            <h4 style="margin-bottom:8px;color:#00ff88;font-size:0.95em;">📥 Deposit Address</h4>
            <div class="address-box" id="depositAddress">Loading...</div>
            <button class="btn btn-primary" onclick="copyAddress()" style="width:100%;margin-bottom:15px;">📋 Copy Address</button>
            <h4 style="margin-bottom:10px;color:#ff9900;font-size:0.95em;">📤 Withdraw USDC</h4>
            <div class="form-group"><label>Destination</label><input type="text" id="withdrawTo" placeholder="0x..."></div>
            <div class="form-group"><label>Amount</label><input type="number" id="withdrawAmount" placeholder="0.00" step="0.01"></div>
            <button class="btn btn-danger" onclick="handleWithdraw()" style="width:100%;">💸 Send</button>
            <div class="status-msg" id="withdrawStatus"></div>
        </div>
    </div>
    <!-- SETTINGS MODAL (ENHANCED with Mode Config) -->
    <div class="modal-overlay" id="settingsModal">
        <div class="modal" style="max-width:750px;">
            <div class="modal-header"><span class="modal-title">⚙️ Settings</span><button class="modal-close" onclick="closeModal('settingsModal')">×</button></div>
            
            <h4 style="margin-bottom:10px;color:#ffd700;font-size:0.95em;">🔄 Trading Mode</h4>
            <div class="mode-toggle">
                <button class="paper" id="paperBtn" onclick="setMode('PAPER')">📝 PAPER</button>
                <button class="live" id="liveBtn" onclick="setMode('LIVE')">🔴 LIVE</button>
            </div>
            
            <h4 style="margin:15px 0 10px;color:#00ff88;font-size:0.95em;">🎮 Quick Presets (Beginner Friendly)</h4>
            <div style="display:flex;gap:10px;margin-bottom:15px;">
                <button onclick="applyPreset('CONSERVATIVE')" style="flex:1;padding:12px;border:2px solid #00ff88;border-radius:8px;background:rgba(0,255,136,0.15);color:#00ff88;cursor:pointer;font-weight:bold;">🛡️ Safe<br><small style="font-weight:normal;opacity:0.7;">Low Risk</small></button>
                <button onclick="applyPreset('BALANCED')" style="flex:1;padding:12px;border:2px solid #ffaa00;border-radius:8px;background:rgba(255,170,0,0.15);color:#ffaa00;cursor:pointer;font-weight:bold;">⚖️ Balanced<br><small style="font-weight:normal;opacity:0.7;">Medium Risk</small></button>
                <button onclick="applyPreset('AGGRESSIVE')" style="flex:1;padding:12px;border:2px solid #ff4466;border-radius:8px;background:rgba(255,68,102,0.15);color:#ff4466;cursor:pointer;font-weight:bold;">🔥 Aggressive<br><small style="font-weight:normal;opacity:0.7;">High Risk</small></button>
            </div>
            
            <h4 style="margin:15px 0 10px;color:#ffd700;font-size:0.95em;">💰 Core Parameters</h4>
            <div class="form-grid">
                <div class="form-group"><label>Paper Balance ($)</label><input type="number" id="paperBalance" value="1000"></div>
                <div class="form-group"><label>Max Position (%)</label><input type="number" id="maxPosition" value="10" min="1" max="25"></div>
            </div>
            <button class="btn" onclick="resetPaperBalance()" style="width:100%;margin-bottom:15px;background:#ff6600;">🔄 Reset Paper Balance to Starting Value</button>
            
            <!-- MODE CONFIGURATIONS -->
            <h4 style="margin:15px 0 10px;color:#00ff88;font-size:0.95em;cursor:pointer;" onclick="toggleModeConfig()">🎯 Mode Configuration ▼</h4>
            <div id="modeConfigPanel" style="display:none;background:rgba(0,0,0,0.3);border-radius:8px;padding:12px;margin-bottom:15px;">
                <!-- ORACLE -->
                <div style="margin-bottom:12px;padding:10px;background:rgba(153,51,255,0.1);border-left:3px solid #9933ff;border-radius:4px;">
                    <strong style="color:#9933ff;">🔮 ORACLE</strong>
                    <label style="float:right;color:#888;"><input type="checkbox" id="oracleEnabled" checked> Enabled</label>
                    <div class="form-grid" style="margin-top:8px;">
                        <div class="form-group"><label>Min Consensus</label><input type="number" id="oracleConsensus" value="0.85" step="0.05" min="0.5" max="1"></div>
                        <div class="form-group"><label>Min Confidence</label><input type="number" id="oracleConfidence" value="0.92" step="0.02" min="0.5" max="1"></div>
                        <div class="form-group"><label>Min Edge (%)</label><input type="number" id="oracleEdge" value="15" min="5" max="50"></div>
                        <div class="form-group"><label>Max Odds</label><input type="number" id="oracleMaxOdds" value="0.70" step="0.05" min="0.3" max="0.9"></div>
                    </div>
                    <div class="form-group" style="margin-top:10px;">
                        <label>🔮 Aggression (0=Conservative, 100=Aggressive)</label>
                        <div style="display:flex;align-items:center;gap:10px;">
                            <input type="range" id="oracleAggression" min="0" max="100" value="50" style="flex:1;" oninput="document.getElementById('aggressionValue').textContent=this.value+'%'">
                            <span id="aggressionValue" style="color:#ffd700;font-weight:bold;min-width:40px;">50%</span>
                        </div>
                        <small style="color:#888;">Higher = more trades, lower thresholds (quality still protected)</small>
                    </div>
                </div>
                <!-- SCALP -->
                <div style="margin-bottom:12px;padding:10px;background:rgba(255,102,0,0.1);border-left:3px solid #ff6600;border-radius:4px;">
                    <strong style="color:#ff6600;">🎯 SCALP</strong>
                    <label style="float:right;color:#888;"><input type="checkbox" id="scalpEnabled" checked> Enabled</label>
                    <div class="form-grid" style="margin-top:8px;">
                        <div class="form-group"><label>Max Entry (¢)</label><input type="number" id="scalpMaxEntry" value="20" min="5" max="40"></div>
                        <div class="form-group"><label>Target Multiple</label><input type="number" id="scalpTarget" value="2.0" step="0.5" min="1.5" max="5"></div>
                    </div>
                </div>
                <!-- ARBITRAGE -->
                <div style="margin-bottom:12px;padding:10px;background:rgba(0,255,136,0.1);border-left:3px solid #00ff88;border-radius:4px;">
                    <strong style="color:#00ff88;">📊 ARBITRAGE</strong>
                    <label style="float:right;color:#888;"><input type="checkbox" id="arbEnabled" checked> Enabled</label>
                    <div class="form-grid" style="margin-top:8px;">
                        <div class="form-group"><label>Min Mispricing</label><input type="number" id="arbMispricing" value="0.15" step="0.05" min="0.05" max="0.5"></div>
                        <div class="form-group"><label>Target Profit</label><input type="number" id="arbTarget" value="0.50" step="0.1" min="0.1" max="1"></div>
                        <div class="form-group"><label>Stop Loss</label><input type="number" id="arbStopLoss" value="0.30" step="0.05" min="0.1" max="0.5"></div>
                    </div>
                </div>
                <!-- UNCERTAINTY -->
                <div style="margin-bottom:12px;padding:10px;background:rgba(51,153,255,0.1);border-left:3px solid #3399ff;border-radius:4px;">
                    <strong style="color:#3399ff;">🌊 UNCERTAINTY</strong>
                    <label style="float:right;color:#888;"><input type="checkbox" id="uncEnabled" checked> Enabled</label>
                    <div class="form-grid" style="margin-top:8px;">
                        <div class="form-group"><label>Extreme Threshold</label><input type="number" id="uncThreshold" value="0.80" step="0.05" min="0.6" max="0.95"></div>
                        <div class="form-group"><label>Target Reversion</label><input type="number" id="uncTarget" value="0.60" step="0.05" min="0.4" max="0.7"></div>
                        <div class="form-group"><label>Stop Loss</label><input type="number" id="uncStopLoss" value="0.25" step="0.05" min="0.1" max="0.5"></div>
                    </div>
                </div>
                <!-- MOMENTUM -->
                <div style="margin-bottom:12px;padding:10px;background:rgba(255,51,204,0.1);border-left:3px solid #ff33cc;border-radius:4px;">
                    <strong style="color:#ff33cc;">🚀 MOMENTUM</strong>
                    <label style="float:right;color:#888;"><input type="checkbox" id="momEnabled" checked> Enabled</label>
                    <div class="form-grid" style="margin-top:8px;">
                        <div class="form-group"><label>Min Elapsed (s)</label><input type="number" id="momMinElapsed" value="300" min="60" max="600"></div>
                        <div class="form-group"><label>Min Consensus</label><input type="number" id="momConsensus" value="0.75" step="0.05" min="0.5" max="1"></div>
                        <div class="form-group"><label>Exit Before End (s)</label><input type="number" id="momExitBefore" value="180" min="60" max="300"></div>
                    </div>
                </div>
                <!-- RISK -->
                <div style="padding:10px;background:rgba(255,0,100,0.1);border-left:3px solid #ff0066;border-radius:4px;">
                    <strong style="color:#ff0066;">⚠️ RISK MANAGEMENT</strong>
                    <div class="form-grid" style="margin-top:8px;">
                        <div class="form-group"><label>Max Exposure (%)</label><input type="number" id="riskMaxExposure" value="30" min="10" max="100"></div>
                        <div class="form-group"><label>Daily Stop (%)</label><input type="number" id="riskStopLoss" value="20" min="5" max="50"></div>
                        <div class="form-group"><label>Loss Cooldown (s)</label><input type="number" id="riskCooldown" value="300" min="60" max="900"></div>
                    </div>
                </div>
            </div>
            
            <h4 style="margin-bottom:10px;color:#ffd700;font-size:0.95em;">🔑 API Credentials</h4>
            <div class="form-group"><label>API Key</label><input type="text" id="apiKey" placeholder="019aed53-..."></div>
            <div class="form-group"><label>Secret</label><input type="password" id="apiSecret" placeholder="Enter secret..."></div>
            <div class="form-group"><label>Passphrase</label><input type="password" id="apiPassphrase" placeholder="Enter passphrase..."></div>
            <div class="form-group"><label>Private Key (⚠️)</label><input type="password" id="privateKey" placeholder="0x..."></div>
            <button class="btn btn-primary" onclick="saveAllSettings()" style="width:100%;">💾 Save All Settings</button>
            <div class="status-msg" id="settingsStatus"></div>
        </div>
    </div>
    <!-- GUIDE MODAL -->
    <div class="modal-overlay" id="guideModal">
        <div class="modal" style="max-height:90vh;overflow-y:auto;">
            <div class="modal-header"><span class="modal-title">📚 Guide</span><button class="modal-close" onclick="closeModal('guideModal')">×</button></div>
            <div class="guide-section"><h3>🎯 What Is This?</h3><p>AI prediction bot for Polymarket 15-min crypto markets. 8 ML models predict BTC, ETH, SOL, XRP direction.</p></div>
            <div class="guide-section"><h3>🔮 The 5 Trading Modes</h3>
                <div class="mode-card oracle"><strong>ORACLE 🔮</strong> - Hold to resolution @ 92%+ confidence, 15%+ edge. Highest accuracy trades.</div>
                <div class="mode-card arb"><strong>ARBITRAGE 📊</strong> - Buy mispriced odds, sell when market corrects. Exit at 50% profit or 10min.</div>
                <div class="mode-card scalp"><strong>SCALP 🎯</strong> - Buy under 20¢, exit at 2x profit. Exits before resolution for safety.</div>
                <div class="mode-card" style="border-left:3px solid #3399ff;"><strong>UNCERTAINTY 🌊</strong> - When odds hit 80%+, bet on reversion to 50/50. Works in choppy markets.</div>
                <div class="mode-card" style="border-left:3px solid #ff33cc;"><strong>MOMENTUM 🚀</strong> - Ride breakouts mid-cycle. Entry after 5min with 75%+ model agreement.</div>
            </div>
            <div class="guide-section"><h3>🎚️ Oracle Aggression</h3><p><strong>0%:</strong> Conservative - base thresholds<br><strong>50%:</strong> Balanced - 15% threshold reduction<br><strong>100%:</strong> Aggressive - 30% reduction, max opportunities<br>Access: Settings → Mode Config → ORACLE</p></div>
            <div class="guide-section"><h3>📊 Dashboard</h3><p><strong>Prediction:</strong> UP/DOWN direction<br><strong>Confidence:</strong> 0-100% certainty<br><strong>Tier:</strong> CONVICTION (best) or ADVISORY<br><strong>Edge:</strong> Advantage over market</p></div>
            <div class="guide-section"><h3>🔄 Failed Sells Recovery</h3><p>If sell fails after 5 retries, saved with recovery info at <code>/api/pending-sells</code>. Includes tokenId, conditionId, marketSlug, PolygonScan link, and manual redemption instructions.</p></div>
            <div class="guide-section"><h3>⚠️ Paper vs Live</h3><p><strong>PAPER:</strong> Simulated - no risk<br><strong>LIVE:</strong> Real money - needs USDC + MATIC</p></div>
        </div>
    </div>
    <!-- PENDING SELLS / RECOVERY MODAL -->
    <div class="modal-overlay" id="pendingSellsModal">
        <div class="modal" style="max-width:850px;max-height:90vh;overflow-y:auto;">
            <div class="modal-header"><span class="modal-title">🔄 Pending Sells / Recovery</span><button class="modal-close" onclick="closeModal('pendingSellsModal')">×</button></div>
            <div style="padding:10px;background:rgba(255,150,0,0.1);border-radius:8px;margin-bottom:15px;border-left:3px solid #ff9900;">
                <p style="color:#ff9900;margin:0;font-size:0.9em;">⚠️ <strong>Failed Sells</strong>: These positions failed to sell after 5 retries. Use the info below to manually recover your funds.</p>
            </div>
            <div id="pendingSellsList" style="min-height:100px;"><div style="text-align:center;color:#666;padding:30px;">Loading...</div></div>
            <div style="margin-top:15px;padding:12px;background:rgba(0,0,0,0.3);border-radius:8px;">
                <h4 style="color:#00ff88;margin-bottom:8px;font-size:0.95em;">📖 Manual Recovery Steps</h4>
                <ol style="color:#aaa;font-size:0.85em;margin-left:20px;line-height:1.6;">
                    <li>Go to <a href="https://polymarket.com/portfolio" target="_blank" style="color:#4fc3f7;">polymarket.com/portfolio</a></li>
                    <li>Find the position in your "Open Positions"</li>
                    <li>Click "Sell" and manually complete the transaction</li>
                    <li>Or wait for market resolution and redeem winning shares</li>
                </ol>
            </div>
            <p style="color:#666;font-size:0.8em;margin-top:10px;text-align:center;">Auto-updates every 10 seconds | API: <code>/api/pending-sells</code></p>
        </div>
    </div>
    <script>
        console.log('SCRIPT STARTING v2');
        let currentData = null;
        function openModal(id) { document.getElementById(id).classList.add('active'); }
        function closeModal(id) { document.getElementById(id).classList.remove('active'); }
        document.querySelectorAll('.modal-overlay').forEach(o => o.addEventListener('click', e => { if (e.target === o) o.classList.remove('active'); }));
        
        async function fetchData() {
            try {
                console.log('fetchData called');
                const res = await fetch('/api/state');
                if (!res.ok) { console.error('API error:', res.status); return; }
                currentData = await res.json();
                console.log('Data received:', Object.keys(currentData));
                updateUI(currentData);
            } catch (e) { console.error('Fetch error:', e); }
        }
        
        function updateUI(data) {
            try {
                console.log('updateUI called');
                // Always update countdown first
                const now = Math.floor(Date.now() / 1000);
                const next = now - (now % 900) + 900;
                const remaining = next - now;
                document.getElementById('countdown').textContent = Math.floor(remaining / 60) + ':' + (remaining % 60).toString().padStart(2, '0');
                
                if (!data) { console.error('No data received'); return; }
                
                // RENDER PREDICTION CARDS
                const assets = ['BTC', 'ETH', 'SOL', 'XRP'];
                let html = '';
                assets.forEach(asset => {
                    try {
                        const d = data[asset];
                        // Handle missing data gracefully - show waiting card
                        if (!d || (!d.live && !d.checkpoint)) {
                            html += '<div class="asset-card"><div class="asset-header"><span class="asset-name">' + asset + '</span><span class="asset-price" style="color:#888;">Awaiting data...</span></div>' +
                                '<div class="prediction"><div class="prediction-value WAIT" style="font-size:1.5em;">⏳ WAITING</div></div>' +
                                '<div style="text-align:center;color:#666;padding:20px;">Waiting for Chainlink price feed...</div></div>';
                            return;
                        }
                        const conf = ((d.confidence || 0) * 100).toFixed(0);
                        const confClass = conf >= 70 ? 'high' : conf >= 50 ? 'medium' : 'low';
                        const priceDecimals = asset === 'XRP' ? 4 : 2;
                        const price = d.live ? d.live.toLocaleString('en-US', {minimumFractionDigits: priceDecimals, maximumFractionDigits: priceDecimals}) : '--';
                        const change = d.checkpoint && d.live ? (((d.live / d.checkpoint) - 1) * 100).toFixed(3) : 0;
                        const stats = d.stats || { total: 0, wins: 0 };
                        const winRate = stats.total > 0 ? ((stats.wins / stats.total) * 100).toFixed(0) : '--';
                        const marketUrl = d.market?.marketUrl || '#';
                        const cpPrice = d.checkpoint ? '$' + d.checkpoint.toLocaleString('en-US', {minimumFractionDigits: priceDecimals, maximumFractionDigits: priceDecimals}) : '--';
                        const recentOutcomes = d.recentOutcomes || [];
                        let wlTracker = '';
                        for (let i = 0; i < 10; i++) {
                            if (i < recentOutcomes.length) {
                                wlTracker += recentOutcomes[i] ? '<span style="color:#00ff88;">✓</span>' : '<span style="color:#ff4466;">✗</span>';
                            } else {
                                wlTracker += '<span style="color:#444;">○</span>';
                            }
                        }
                        const recentWins = recentOutcomes.filter(Boolean).length;
                        const recentTotal = recentOutcomes.length;
                        const yesOdds = d.market && d.market.yesPrice ? (d.market.yesPrice * 100).toFixed(1) : '--';
                        const noOdds = d.market && d.market.noPrice ? (d.market.noPrice * 100).toFixed(1) : '--';
                        html += '<div class="asset-card ' + (d.locked ? 'locked' : '') + '">' +
                            '<div class="asset-header"><span class="asset-name">' + asset + '</span><span class="asset-price">$' + price + ' <span style="color:' + (change >= 0 ? '#00ff88' : '#ff4466') + '">(' + (change >= 0 ? '+' : '') + change + '%)</span></span></div>' +
                            '<div class="prediction"><div class="prediction-value ' + (d.prediction || 'WAIT') + '">' + (d.prediction || 'WAIT') + '</div></div>' +
                            '<div class="confidence-bar"><div class="confidence-fill ' + confClass + '" style="width:' + conf + '%"></div></div>' +
                            '<div style="display:flex;justify-content:space-between;align-items:center;margin-top:8px;"><span>' + conf + '% Confidence</span><span class="tier ' + (d.tier || 'NONE') + '">' + (d.tier || 'NONE') + (d.locked ? ' 🔒' : '') + '</span></div>' +
                            '<div style="text-align:center;padding:6px;background:rgba(255,215,0,0.1);border-radius:4px;margin-top:8px;"><span style="color:#888;font-size:0.8em;">Checkpoint: </span><span style="color:#ffd700;font-weight:bold;">' + cpPrice + '</span></div>' +
                            '<div class="stats-grid"><div class="stat"><div class="stat-label">Win</div><div class="stat-value">' + winRate + '%</div></div>' +
                            '<div class="stat"><div class="stat-label">Edge</div><div class="stat-value">' + (d.edge ? d.edge.toFixed(2) : '0') + '%</div></div>' +
                            '<div class="stat"><div class="stat-label">YES</div><div class="stat-value">' + yesOdds + '¢</div></div>' +
                            '<div class="stat"><div class="stat-label">NO</div><div class="stat-value">' + noOdds + '¢</div></div></div>' +
                            '<div style="text-align:center;padding:6px;background:rgba(0,0,0,0.2);border-radius:4px;margin-top:8px;font-size:1.1em;letter-spacing:2px;"><span style="color:#888;font-size:0.7em;display:block;margin-bottom:2px;">Last 10: ' + recentWins + '/' + recentTotal + '</span>' + wlTracker + '</div>' +
                            '<div style="display:flex;gap:8px;margin-top:10px;">' +
                            '<button onclick="manualBuy(' + "'" + asset + "'" + ', ' + "'" + 'UP' + "'" + ')" style="flex:1;padding:8px;background:linear-gradient(135deg,#00ff88,#00cc66);border:none;border-radius:6px;color:#000;font-weight:bold;cursor:pointer;font-size:0.85em;">📈 BUY UP<br><small>' + yesOdds + '¢</small></button>' +
                            '<button onclick="manualBuy(' + "'" + asset + "'" + ', ' + "'" + 'DOWN' + "'" + ')" style="flex:1;padding:8px;background:linear-gradient(135deg,#ff4466,#cc2244);border:none;border-radius:6px;color:#fff;font-weight:bold;cursor:pointer;font-size:0.85em;">📉 BUY DOWN<br><small>' + noOdds + '¢</small></button>' +
                            '</div>' +
                            '<a href="' + marketUrl + '" target="_blank" class="market-link">Polymarket →</a></div>';
                    } catch (assetErr) { console.error('Error rendering asset:', asset, assetErr); }
                });
                console.log('HTML built for ' + assets.length + ' assets, length: ' + html.length);
                const grid = document.getElementById('predictionsGrid');
                if (grid) {
                    grid.innerHTML = html || '<div style="text-align:center;padding:40px;color:#ff6666;">No prediction data available</div>';
                    console.log('Grid updated successfully');
                } else {
                    console.error('predictionsGrid element not found!');
                }
                
                const t = data._trading;
                if (t) {
                    document.getElementById('balance').textContent = '$' + (t.balance || 0).toFixed(2);
                    document.getElementById('pnl').textContent = ((t.todayPnL || 0) >= 0 ? '+' : '') + '$' + (t.todayPnL || 0).toFixed(2);
                    document.getElementById('pnl').style.color = (t.todayPnL || 0) >= 0 ? '#00ff88' : '#ff4466';
                    const allTrades = t.tradeHistory || [];
                    const closedT = allTrades.filter(tr => tr.status === 'CLOSED');
                    const winsCount = closedT.filter(tr => (tr.pnl || 0) >= 0).length;
                    const lossCount = closedT.length - winsCount;
                    document.getElementById('winLoss').textContent = winsCount + '/' + lossCount;
                    document.getElementById('winLoss').style.color = winsCount >= lossCount ? '#00ff88' : '#ff4466';
                    document.getElementById('modeBadge').textContent = t.mode || 'PAPER';
                    document.getElementById('modeBadge').className = 'mode-badge ' + (t.mode || 'PAPER');
                    document.getElementById('modeBtn').textContent = t.mode === 'LIVE' ? '🔴 LIVE' : '📝 PAPER';
                    document.getElementById('modeBtn').className = 'nav-btn ' + (t.mode || 'paper').toLowerCase();
                    document.getElementById('positionCount').textContent = (t.positionCount || 0) + ' positions';
                    document.getElementById('paperBtn').className = t.mode === 'PAPER' ? 'paper active' : 'paper';
                    document.getElementById('liveBtn').className = t.mode === 'LIVE' ? 'live active' : 'live';
                    const positions = Object.entries(t.positions || {});
                    if (positions.length > 0) {
                        let posHtml = '';
                        positions.forEach(([id, p]) => { 
                            const timeHeld = Math.floor((Date.now() - (p.time || Date.now())) / 1000);
                            const mins = Math.floor(timeHeld / 60);
                            const secs = timeHeld % 60;
                            const color = p.side === 'UP' ? '#00ff88' : '#ff4466';
                            const modeEmoji = p.mode === 'ORACLE' ? '🔮' : p.mode === 'SCALP' ? '🎯' : p.mode === 'ARBITRAGE' ? '📊' : p.mode === 'MANUAL' ? '✋' : '⚡';
                            const modeColor = p.mode === 'ORACLE' ? '#9933ff' : p.mode === 'SCALP' ? '#ff6600' : p.mode === 'ARBITRAGE' ? '#00ff88' : p.mode === 'MANUAL' ? '#ffd700' : '#ffaa00';
                            posHtml += '<div class="position-item" style="flex-wrap:wrap;"><div style="display:flex;justify-content:space-between;width:100%;align-items:center;"><span style="color:' + color + '"><strong>' + (p.asset || '?') + '</strong> ' + (p.side || '?') + '</span><span style="color:' + modeColor + ';font-weight:bold;font-size:0.85em;background:rgba(0,0,0,0.3);padding:2px 6px;border-radius:4px;">' + modeEmoji + ' ' + (p.mode || '?') + '</span><span>$' + (p.size || 0).toFixed(2) + ' @ ' + ((p.entry || 0) * 100).toFixed(0) + '¢ <span style="color:#888;font-size:0.8em;">' + mins + 'm' + secs + 's</span></span><button onclick="manualSell(' + "'" + id + "'" + ')" style="padding:4px 10px;background:#ff4466;border:none;border-radius:4px;color:#fff;cursor:pointer;font-size:0.8em;font-weight:bold;">SELL</button></div></div>'; 
                        });
                        document.getElementById('positionsList').innerHTML = posHtml;
                    } else { document.getElementById('positionsList').innerHTML = '<div class="no-positions">No active positions</div>'; }
                    const trades = t.tradeHistory || [];
                    const closedTrades = trades.filter(tr => tr.status === 'CLOSED');
                    const wins = closedTrades.filter(tr => (tr.pnl || 0) >= 0).length;
                    const losses = closedTrades.length - wins;
                    const winRate = closedTrades.length > 0 ? ((wins / closedTrades.length) * 100).toFixed(0) : '--';
                    document.getElementById('historyCount').textContent = closedTrades.length + ' trades | ' + winRate + '% win rate';
                    if (trades.length > 0) {
                        let histHtml = '';
                        trades.slice(-10).reverse().forEach(tr => {
                            const emoji = tr.status === 'OPEN' ? '⏳' : ((tr.pnl || 0) >= 0 ? '✅' : '❌');
                            const pnlColor = (tr.pnl || 0) >= 0 ? '#00ff88' : '#ff4466';
                            let details = '';
                            if (tr.status === 'CLOSED') {
                                // 🔮 ENHANCED: Now shows $spent @ entry→exit +PnL
                                const spent = (tr.size || 0).toFixed(2);
                                details = '$' + spent + ' @ ' + ((tr.entry || 0) * 100).toFixed(0) + '¢→' + ((tr.exit || 0) * 100).toFixed(0) + '¢ ' + ((tr.pnl || 0) >= 0 ? '+' : '') + '$' + (tr.pnl || 0).toFixed(2);
                            } else {
                                details = 'Entry: ' + ((tr.entry || 0) * 100).toFixed(0) + '¢ | $' + (tr.size || 0).toFixed(2);
                            }
                            const modeEmoji = tr.mode === 'ORACLE' ? '🔮' : tr.mode === 'SCALP' ? '🎯' : tr.mode === 'ARBITRAGE' ? '📊' : tr.mode === 'UNCERTAINTY' ? '🌊' : tr.mode === 'MOMENTUM' ? '🚀' : '⚡';
                            const modeColor = tr.mode === 'ORACLE' ? '#9933ff' : tr.mode === 'SCALP' ? '#ff6600' : tr.mode === 'ARBITRAGE' ? '#00ff88' : tr.mode === 'UNCERTAINTY' ? '#3399ff' : tr.mode === 'MOMENTUM' ? '#ff33cc' : '#ffaa00';
                            histHtml += '<div class="position-item"><span>' + emoji + ' <strong>' + (tr.asset || '?') + '</strong> ' + (tr.side || '?') + '</span><span style="color:' + modeColor + ';font-weight:bold;font-size:0.8em;background:rgba(0,0,0,0.3);padding:2px 5px;border-radius:3px;">' + modeEmoji + ' ' + (tr.mode || '?') + '</span><span style="color:' + pnlColor + ';font-size:0.85em;">' + details + '</span></div>';
                        });
                        document.getElementById('tradeHistory').innerHTML = histHtml;
                    } else { document.getElementById('tradeHistory').innerHTML = '<div class="no-positions">No trades yet</div>'; }
                }
            } catch (err) { console.error('updateUI error:', err); }
        }
        
        async function loadWallet() {
            try {
                const res = await fetch('/api/wallet');
                const data = await res.json();
                if (data.usdc?.success) {
                    document.getElementById('usdcBalance').textContent = '$' + data.usdc.balance.toFixed(2);
                    document.getElementById('liveBalance').textContent = '$' + data.usdc.balance.toFixed(2);
                }
                if (data.matic?.success) document.getElementById('maticBalance').textContent = data.matic.balance.toFixed(4);
                if (data.address) document.getElementById('depositAddress').textContent = data.address;
            } catch (e) {}
        }
        function copyAddress() { navigator.clipboard.writeText(document.getElementById('depositAddress').textContent).then(() => alert('Copied!')); }
        async function handleWithdraw() {
            const to = document.getElementById('withdrawTo').value.trim();
            const amount = parseFloat(document.getElementById('withdrawAmount').value);
            const status = document.getElementById('withdrawStatus');
            if (!to || !amount) { status.textContent = '❌ Fill all fields'; status.className = 'status-msg error'; return; }
            if (!confirm('Send $' + amount + ' USDC to ' + to + '?')) return;
            try {
                const res = await fetch('/api/wallet/transfer', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ to, amount }) });
                const result = await res.json();
                if (result.success) { status.innerHTML = '✅ Sent! <a href="' + result.explorerUrl + '" target="_blank" style="color:#00ff88;">View TX</a>'; status.className = 'status-msg success'; loadWallet(); }
                else { status.textContent = '❌ ' + result.error; status.className = 'status-msg error'; }
            } catch (e) { status.textContent = '❌ Network error'; status.className = 'status-msg error'; }
        }
        
        async function loadSettings() {
            try {
                const res = await fetch('/api/settings');
                const data = await res.json();
                document.getElementById('paperBalance').value = data.PAPER_BALANCE || 1000;
                document.getElementById('maxPosition').value = (data.MAX_POSITION_SIZE || 0.1) * 100;
                if (data.ORACLE) { 
                    document.getElementById('oracleEnabled').checked = data.ORACLE.enabled !== false; 
                    document.getElementById('oracleConsensus').value = data.ORACLE.minConsensus || 0.85; 
                    document.getElementById('oracleConfidence').value = data.ORACLE.minConfidence || 0.92; 
                    document.getElementById('oracleEdge').value = data.ORACLE.minEdge || 15; 
                    document.getElementById('oracleMaxOdds').value = data.ORACLE.maxOdds || 0.70;
                    // 🔮 ORACLE AGGRESSION
                    const aggression = data.ORACLE.aggression || 50;
                    document.getElementById('oracleAggression').value = aggression;
                    document.getElementById('aggressionValue').textContent = aggression + '%';
                }
                if (data.SCALP) { document.getElementById('scalpEnabled').checked = data.SCALP.enabled !== false; document.getElementById('scalpMaxEntry').value = (data.SCALP.maxEntryPrice || 0.20) * 100; document.getElementById('scalpTarget').value = data.SCALP.targetMultiple || 2.0; }
                if (data.ARBITRAGE) { document.getElementById('arbEnabled').checked = data.ARBITRAGE.enabled !== false; document.getElementById('arbMispricing').value = data.ARBITRAGE.minMispricing || 0.15; document.getElementById('arbTarget').value = data.ARBITRAGE.targetProfit || 0.50; document.getElementById('arbStopLoss').value = data.ARBITRAGE.stopLoss || 0.30; }
                // 🌊 UNCERTAINTY MODE
                if (data.UNCERTAINTY) {
                    document.getElementById('uncEnabled').checked = data.UNCERTAINTY.enabled !== false;
                    document.getElementById('uncThreshold').value = data.UNCERTAINTY.extremeThreshold || 0.80;
                    document.getElementById('uncTarget').value = data.UNCERTAINTY.targetReversion || 0.60;
                    document.getElementById('uncStopLoss').value = data.UNCERTAINTY.stopLoss || 0.25;
                }
                // 🚀 MOMENTUM MODE
                if (data.MOMENTUM) {
                    document.getElementById('momEnabled').checked = data.MOMENTUM.enabled !== false;
                    document.getElementById('momMinElapsed').value = data.MOMENTUM.minElapsed || 300;
                    document.getElementById('momConsensus').value = data.MOMENTUM.minConsensus || 0.75;
                    document.getElementById('momExitBefore').value = data.MOMENTUM.exitBeforeEnd || 180;
                }
                if (data.RISK) { document.getElementById('riskMaxExposure').value = (data.RISK.maxTotalExposure || 0.30) * 100; document.getElementById('riskStopLoss').value = (data.RISK.globalStopLoss || 0.20) * 100; document.getElementById('riskCooldown').value = data.RISK.cooldownAfterLoss || 300; }
            } catch (e) { console.error(e); }
        }
        function toggleModeConfig() { const p = document.getElementById('modeConfigPanel'); if(p) p.style.display = p.style.display === 'none' ? 'block' : 'none'; }
        async function applyPreset(preset) {
            const presets = {
                CONSERVATIVE: { ORACLE: { enabled: true, minConsensus: 0.90, minConfidence: 0.92, minEdge: 20, maxOdds: 0.60 }, SCALP: { enabled: false }, ARBITRAGE: { enabled: false }, RISK: { maxTotalExposure: 0.20, globalStopLoss: 0.15, cooldownAfterLoss: 600 } },
                BALANCED: { ORACLE: { enabled: true, minConsensus: 0.85, minConfidence: 0.85, minEdge: 15, maxOdds: 0.70 }, SCALP: { enabled: true, maxEntryPrice: 0.20, targetMultiple: 2.0 }, ARBITRAGE: { enabled: true, minMispricing: 0.15, targetProfit: 0.50, stopLoss: 0.30 }, RISK: { maxTotalExposure: 0.30, globalStopLoss: 0.20, cooldownAfterLoss: 300 } },
                AGGRESSIVE: { ORACLE: { enabled: true, minConsensus: 0.75, minConfidence: 0.70, minEdge: 10, maxOdds: 0.80 }, SCALP: { enabled: true, maxEntryPrice: 0.30, targetMultiple: 1.5 }, ARBITRAGE: { enabled: true, minMispricing: 0.10, targetProfit: 0.30, stopLoss: 0.40 }, RISK: { maxTotalExposure: 0.50, globalStopLoss: 0.30, cooldownAfterLoss: 120 } }
            };
            const p = presets[preset];
            if (!p) return;
            try {
                await fetch('/api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(p) });
                loadSettings();
                const status = document.getElementById('settingsStatus');
                status.textContent = '✅ ' + preset + ' preset applied!';
                status.className = 'status-msg success';
            } catch (e) { console.error(e); }
        }
        async function setMode(mode) {
            if (mode === 'LIVE' && !confirm('WARNING: LIVE MODE - Real orders, real USDC, real losses! Continue?')) return;
            try {
                await fetch('/api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ TRADE_MODE: mode }) });
                fetchData();
                const status = document.getElementById('settingsStatus');
                status.textContent = mode === 'LIVE' ? 'LIVE MODE ENABLED' : 'Paper mode enabled';
                status.className = 'status-msg ' + (mode === 'LIVE' ? 'error' : 'success');
            } catch (e) {}
        }
        async function saveAllSettings() {
            const updates = { 
                PAPER_BALANCE: parseFloat(document.getElementById('paperBalance').value), 
                MAX_POSITION_SIZE: parseFloat(document.getElementById('maxPosition').value) / 100,
                ORACLE: { 
                    enabled: document.getElementById('oracleEnabled').checked, 
                    aggression: parseInt(document.getElementById('oracleAggression').value),
                    minConsensus: parseFloat(document.getElementById('oracleConsensus').value), 
                    minConfidence: parseFloat(document.getElementById('oracleConfidence').value), 
                    minEdge: parseFloat(document.getElementById('oracleEdge').value), 
                    maxOdds: parseFloat(document.getElementById('oracleMaxOdds').value), 
                    requireTrending: false, 
                    requireMomentum: false, 
                    minStability: 3 
                },
                SCALP: { enabled: document.getElementById('scalpEnabled').checked, maxEntryPrice: parseFloat(document.getElementById('scalpMaxEntry').value) / 100, targetMultiple: parseFloat(document.getElementById('scalpTarget').value), requireLean: true, exitBeforeEnd: 120 },
                ARBITRAGE: { enabled: document.getElementById('arbEnabled').checked, minMispricing: parseFloat(document.getElementById('arbMispricing').value), targetProfit: parseFloat(document.getElementById('arbTarget').value), stopLoss: parseFloat(document.getElementById('arbStopLoss').value), maxHoldTime: 600 },
                UNCERTAINTY: {
                    enabled: document.getElementById('uncEnabled').checked,
                    extremeThreshold: parseFloat(document.getElementById('uncThreshold').value),
                    targetReversion: parseFloat(document.getElementById('uncTarget').value),
                    stopLoss: parseFloat(document.getElementById('uncStopLoss').value),
                    volatilityMin: 0.02
                },
                MOMENTUM: {
                    enabled: document.getElementById('momEnabled').checked,
                    minElapsed: parseInt(document.getElementById('momMinElapsed').value),
                    minConsensus: parseFloat(document.getElementById('momConsensus').value),
                    exitBeforeEnd: parseInt(document.getElementById('momExitBefore').value),
                    breakoutThreshold: 0.03,
                    exitOnReversal: true
                },
                RISK: { maxTotalExposure: parseFloat(document.getElementById('riskMaxExposure').value) / 100, globalStopLoss: parseFloat(document.getElementById('riskStopLoss').value) / 100, cooldownAfterLoss: parseInt(document.getElementById('riskCooldown').value) }
            };
            const apiKey = document.getElementById('apiKey').value;
            const apiSecret = document.getElementById('apiSecret').value;
            const apiPassphrase = document.getElementById('apiPassphrase').value;
            const privateKey = document.getElementById('privateKey').value;
            if (apiKey) updates.POLYMARKET_API_KEY = apiKey;
            if (apiSecret) updates.POLYMARKET_SECRET = apiSecret;
            if (apiPassphrase) updates.POLYMARKET_PASSPHRASE = apiPassphrase;
            if (privateKey) updates.POLYMARKET_PRIVATE_KEY = privateKey;
            try {
                await fetch('/api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(updates) });
                document.getElementById('settingsStatus').textContent = '✅ All settings saved!';
                document.getElementById('settingsStatus').className = 'status-msg success';
                fetchData();
            } catch (e) { document.getElementById('settingsStatus').textContent = '❌ Error saving'; document.getElementById('settingsStatus').className = 'status-msg error'; }
        }
        async function resetPaperBalance() {
            if (!confirm('Reset paper balance? This will close all positions and reset P/L.')) return;
            try {
                const newBalance = parseFloat(document.getElementById('paperBalance').value);
                await fetch('/api/reset-balance', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ balance: newBalance }) });
                document.getElementById('settingsStatus').textContent = '✅ Paper balance reset to $' + newBalance;
                document.getElementById('settingsStatus').className = 'status-msg success';
                fetchData();
            } catch (e) { document.getElementById('settingsStatus').textContent = '❌ Reset failed'; document.getElementById('settingsStatus').className = 'status-msg error'; }
        }
        
        // MANUAL TRADING FUNCTIONS
        async function manualBuy(asset, direction) {
            const size = prompt('Enter trade size in $ (e.g. 10):', '10');
            if (!size) return;
            const sizeNum = parseFloat(size);
            if (isNaN(sizeNum) || sizeNum < 1) {
                alert('Size must be at least $1');
                return;
            }
            
            const mode = currentData?._trading?.mode || 'PAPER';
            if (mode === 'LIVE' && !confirm('⚠️ LIVE MODE: This will place a REAL order with $' + sizeNum.toFixed(2) + '. Continue?')) {
                return;
            }
            
            try {
                const res = await fetch('/api/manual-buy', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ asset, direction, size: sizeNum })
                });
                const result = await res.json();
                if (result.success) {
                    alert('✅ Buy order placed: ' + asset + ' ' + direction + ' @ ' + (result.entryPrice * 100).toFixed(1) + '¢');
                    fetchData();
                } else {
                    alert('❌ Buy failed: ' + result.error);
                }
            } catch (e) {
                alert('❌ Error: ' + e.message);
            }
        }
        
        async function manualSell(positionId) {
            const mode = currentData?._trading?.mode || 'PAPER';
            const pos = currentData?._trading?.positions?.[positionId];
            
            if (mode === 'LIVE' && !confirm('⚠️ LIVE MODE: This will SELL your ' + (pos?.asset || 'unknown') + ' position. Continue?')) {
                return;
            }
            
            try {
                const res = await fetch('/api/manual-sell', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ positionId })
                });
                const result = await res.json();
                if (result.success) {
                    alert('✅ Sell order executed' + (result.paper ? ' (paper)' : ''));
                    fetchData();
                } else {
                    alert('❌ Sell failed: ' + result.error + (result.needsManualIntervention ? '\n\nCheck /api/pending-sells for stuck positions.' : ''));
                }
            } catch (e) {
                alert('❌ Error: ' + e.message);
            }
        }
        
        // PENDING SELLS / RECOVERY FUNCTIONS
        async function loadPendingSells() {
            try {
                const res = await fetch('/api/pending-sells');
                const data = await res.json();
                const container = document.getElementById('pendingSellsList');
                
                if (!data.pendingSells || Object.keys(data.pendingSells).length === 0) {
                    container.innerHTML = '<div style="text-align:center;padding:30px;color:#00ff88;"><span style="font-size:2em;">✅</span><br><br>No pending sells! All positions sold successfully.</div>';
                    return;
                }
                
                let html = '<div style="color:#888;font-size:0.85em;margin-bottom:10px;">Found <strong style="color:#ff9900;">' + data.count + '</strong> pending sell(s)</div>';
                
                for (const [key, ps] of Object.entries(data.pendingSells)) {
                    const failTime = new Date(ps.failedAt).toLocaleString();
                    html += '<div style="background:rgba(255,0,0,0.1);border:1px solid #ff4466;border-radius:8px;padding:15px;margin-bottom:12px;">';
                    html += '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;">';
                    html += '<span style="font-weight:bold;color:#ff4466;font-size:1.1em;">❌ ' + (ps.asset || 'Unknown') + ' - ' + (ps.side || '?') + '</span>';
                    html += '<span style="color:#888;font-size:0.8em;">Failed: ' + failTime + '</span>';
                    html += '</div>';
                    html += '<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;font-size:0.85em;">';
                    html += '<div><span style="color:#888;">Size:</span> <strong>$' + (ps.size || 0).toFixed(2) + '</strong></div>';
                    html += '<div><span style="color:#888;">Entry:</span> <strong>' + ((ps.entry || 0) * 100).toFixed(1) + '¢</strong></div>';
                    html += '<div><span style="color:#888;">Token ID:</span> <code style="font-size:0.75em;background:rgba(0,0,0,0.3);padding:2px 5px;border-radius:3px;">' + (ps.tokenId ? ps.tokenId.substring(0,20) + '...' : 'N/A') + '</code></div>';
                    html += '<div><span style="color:#888;">Condition ID:</span> <code style="font-size:0.75em;background:rgba(0,0,0,0.3);padding:2px 5px;border-radius:3px;">' + (ps.conditionId ? ps.conditionId.substring(0,20) + '...' : 'N/A') + '</code></div>';
                    html += '</div>';
                    html += '<div style="margin-top:10px;display:flex;gap:8px;flex-wrap:wrap;">';
                    if (ps.marketUrl) html += '<a href="' + ps.marketUrl + '" target="_blank" style="padding:6px 12px;background:#4fc3f7;color:#000;border-radius:5px;text-decoration:none;font-size:0.8em;font-weight:bold;">📊 View Market</a>';
                    if (ps.polygonscanUrl) html += '<a href="' + ps.polygonscanUrl + '" target="_blank" style="padding:6px 12px;background:#8b5cf6;color:#fff;border-radius:5px;text-decoration:none;font-size:0.8em;font-weight:bold;">🔍 PolygonScan</a>';
                    html += '<button onclick="retrySell(' + "'" + key + "'" + ')" style="padding:6px 12px;background:#ff6600;color:#fff;border:none;border-radius:5px;cursor:pointer;font-size:0.8em;font-weight:bold;">🔄 Retry Sell</button>';
                    html += '</div>';
                    if (ps.redemptionInstructions) {
                        html += '<details style="margin-top:10px;"><summary style="color:#ffd700;cursor:pointer;font-size:0.85em;">📖 Manual Recovery Instructions</summary>';
                        html += '<div style="margin-top:8px;padding:10px;background:rgba(0,0,0,0.3);border-radius:6px;font-size:0.8em;color:#aaa;white-space:pre-wrap;">' + ps.redemptionInstructions + '</div>';
                        html += '</details>';
                    }
                    html += '</div>';
                }
                
                container.innerHTML = html;
            } catch (e) {
                document.getElementById('pendingSellsList').innerHTML = '<div style="text-align:center;padding:20px;color:#ff4466;">❌ Error loading: ' + e.message + '</div>';
            }
        }
        
        async function retrySell(key) {
            const [asset, tokenId] = key.split('_');
            if (!confirm('Retry selling ' + asset + ' position?')) return;
            try {
                const res = await fetch('/api/retry-sell', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ asset, tokenId })
                });
                const result = await res.json();
                if (result.success) {
                    alert('✅ Sell successful!');
                    loadPendingSells();
                } else {
                    alert('❌ Retry failed: ' + result.error);
                }
            } catch (e) {
                alert('❌ Error: ' + e.message);
            }
        }
        
        fetchData(); loadWallet(); loadSettings();
        setInterval(fetchData, 1000);
        setInterval(loadWallet, 30000);
        setInterval(loadPendingSells, 10000); // Auto-refresh pending sells every 10s
    </script>
</body>
</html>
    `);
});



app.get('/api/state', (req, res) => {
    const response = {};
    ASSETS.forEach(a => {
        const recentWins = Brains[a].recentOutcomes.filter(Boolean).length;
        const recentTotal = Brains[a].recentOutcomes.length;
        const recentAccuracy = recentTotal > 0 ? (recentWins / recentTotal) * 100 : 0;

        response[a] = {
            prediction: Brains[a].prediction,
            confidence: Brains[a].confidence,
            tier: Brains[a].tier,
            edge: Brains[a].edge,
            votes: Brains[a].ensembleVotes,
            stats: Brains[a].stats,
            live: livePrices[a],
            checkpoint: checkpointPrices[a],
            market: currentMarkets[a],
            locked: Brains[a].convictionLocked,
            voteStability: Brains[a].voteTrendScore,
            recentAccuracy: recentAccuracy.toFixed(1),
            recentTotal: recentTotal,
            recentOutcomes: Brains[a].recentOutcomes, // Rolling W/L for UI display
            kellySize: Brains[a].getKellySize(),
            calibration: Brains[a].calibrationBuckets,
            newsState: Brains[a].newsState,
            modelVotes: Brains[a].lastSignal ? Brains[a].lastSignal.modelVotes : {}
        };
    });

    // Add trading system data
    response._trading = {
        mode: CONFIG.TRADE_MODE,
        balance: tradeExecutor.paperBalance,
        todayPnL: tradeExecutor.todayPnL,
        positions: tradeExecutor.positions,
        positionCount: Object.keys(tradeExecutor.positions).length,
        tradeHistory: tradeExecutor.tradeHistory.slice(-20), // Last 20 trades
        modes: {
            ORACLE: CONFIG.ORACLE.enabled,
            ARBITRAGE: CONFIG.ARBITRAGE.enabled,
            SCALP: CONFIG.SCALP.enabled,
            UNCERTAINTY: CONFIG.UNCERTAINTY.enabled,
            MOMENTUM: CONFIG.MOMENTUM.enabled
        },
        inCooldown: tradeExecutor.isInCooldown()
    };

    res.json(response);
});

// Trading API - Get detailed trade data
app.get('/api/trades', (req, res) => {
    res.json({
        mode: CONFIG.TRADE_MODE,
        balance: tradeExecutor.paperBalance,
        startingBalance: tradeExecutor.startingBalance,
        todayPnL: tradeExecutor.todayPnL,
        totalReturn: ((tradeExecutor.paperBalance / tradeExecutor.startingBalance) - 1) * 100,
        positions: tradeExecutor.positions,
        tradeHistory: tradeExecutor.tradeHistory,
        modes: {
            ORACLE: { ...CONFIG.ORACLE },
            ARBITRAGE: { ...CONFIG.ARBITRAGE },
            SCALP: { ...CONFIG.SCALP },
            UNCERTAINTY: { ...CONFIG.UNCERTAINTY },
            MOMENTUM: { ...CONFIG.MOMENTUM }
        },
        risk: CONFIG.RISK,
        inCooldown: tradeExecutor.isInCooldown(),
        lastLossTime: tradeExecutor.lastLossTime
    });
});

// ==================== MANUAL TRADING API ====================

// Get pending sells that need manual intervention
app.get('/api/pending-sells', (req, res) => {
    res.json({
        pendingSells: tradeExecutor.getPendingSells(),
        count: Object.keys(tradeExecutor.getPendingSells()).length
    });
});

// Manual buy - place a trade manually via UI
app.post('/api/manual-buy', async (req, res) => {
    const { asset, direction, size } = req.body;

    if (!asset || !direction || !size) {
        return res.status(400).json({ success: false, error: 'Missing asset, direction, or size' });
    }

    if (!['BTC', 'ETH', 'SOL', 'XRP'].includes(asset)) {
        return res.status(400).json({ success: false, error: 'Invalid asset' });
    }

    if (!['UP', 'DOWN'].includes(direction)) {
        return res.status(400).json({ success: false, error: 'Direction must be UP or DOWN' });
    }

    const sizeNum = parseFloat(size);
    if (isNaN(sizeNum) || sizeNum < 1) {
        return res.status(400).json({ success: false, error: 'Size must be at least $1' });
    }

    try {
        const result = await tradeExecutor.manualBuy(asset, direction, sizeNum);
        res.json(result);
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// Manual sell - close a position manually via UI
app.post('/api/manual-sell', async (req, res) => {
    const { positionId } = req.body;

    if (!positionId) {
        return res.status(400).json({ success: false, error: 'Missing positionId' });
    }

    try {
        const result = await tradeExecutor.manualSell(positionId);
        res.json(result);
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// Retry a failed sell
app.post('/api/retry-sell', async (req, res) => {
    const { tokenId, asset } = req.body;

    const pendingSells = tradeExecutor.getPendingSells();
    const key = asset + '_' + tokenId;

    if (!pendingSells[key]) {
        return res.status(404).json({ success: false, error: 'Pending sell not found' });
    }

    try {
        const result = await tradeExecutor.executeSellOrderWithRetry(pendingSells[key], 3, 2000);
        if (result.success) {
            delete tradeExecutor.pendingSells[key];
        }
        res.json(result);
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// ==================== REDEMPTION ENDPOINTS ====================

// Get redemption queue
app.get('/api/redemption-queue', (req, res) => {
    res.json({
        success: true,
        queue: tradeExecutor.getRedemptionQueue(),
        count: tradeExecutor.getRedemptionQueue().length
    });
});

// Trigger redemption check
app.post('/api/check-redemptions', async (req, res) => {
    try {
        const result = await tradeExecutor.checkAndRedeemPositions();
        res.json(result);
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// Clear redemption queue
app.post('/api/clear-redemption-queue', (req, res) => {
    tradeExecutor.clearRedemptionQueue();
    res.json({ success: true, message: 'Queue cleared' });
});

// 🔓 Toggle Global Stop Loss Override
app.post('/api/toggle-stop-loss-override', (req, res) => {
    CONFIG.RISK.globalStopLossOverride = !CONFIG.RISK.globalStopLossOverride;
    const status = CONFIG.RISK.globalStopLossOverride ? 'BYPASSED' : 'ACTIVE';
    log(`🔓 Global Stop Loss Override: ${status}`);
    res.json({
        success: true,
        override: CONFIG.RISK.globalStopLossOverride,
        message: `Global stop loss is now ${status}. Trading will ${CONFIG.RISK.globalStopLossOverride ? 'continue even after 20% daily loss' : 'halt at 20% daily loss'}.`
    });
});

// Periodic redemption check - runs every 5 minutes
setInterval(async () => {
    if (tradeExecutor.mode === 'LIVE' && tradeExecutor.wallet) {
        const queue = tradeExecutor.getRedemptionQueue();
        if (queue.length > 0) {
            log(`🔄 Auto-checking ${queue.length} positions for redemption...`);
            await tradeExecutor.checkAndRedeemPositions();
        }
    }
}, 5 * 60 * 1000); // Every 5 minutes

// EXPORT ENDPOINT (New Feature)
app.get('/api/export', (req, res) => {
    const asset = req.query.asset || 'BTC';
    if (!Brains[asset]) return res.status(404).send('Asset not found');

    // Convert current cycle history to CSV
    const history = Brains[asset].currentCycleHistory || [];
    if (history.length === 0) return res.send('No data available');

    const headers = ['Timestamp', 'Elapsed', 'Prediction', 'Confidence', 'Tier', 'Edge', 'Locked', 'Committed', 'Price', 'Checkpoint', 'YesOdds', 'NoOdds', 'VotesUP', 'VotesDOWN'];
    const rows = history.map(h => [
        h.timestamp,
        h.elapsed,
        h.prediction,
        h.confidence.toFixed(4),
        h.tier,
        h.edge.toFixed(2),
        h.locked,
        h.committed,
        h.currentPrice,
        h.checkpointPrice,
        h.marketOdds?.yes || 0,
        h.marketOdds?.no || 0,
        h.votes?.UP || 0,
        h.votes?.DOWN || 0
    ].join(','));

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename = ${asset} _history.csv`);
    res.send([headers.join(','), ...rows].join('\n'));
});

// ==================== WALLET API ====================

// Get wallet info and balances - PARALLEL fetch for speed
app.get('/api/wallet', async (req, res) => {
    try {
        const walletInfo = tradeExecutor.getWalletInfo();

        // Fetch USDC and MATIC in parallel for maximum speed
        const [usdcBalance, maticBalance] = await Promise.all([
            tradeExecutor.getUSDCBalance(),
            tradeExecutor.getMATICBalance()
        ]);

        res.json({
            loaded: walletInfo.loaded,
            address: walletInfo.address,
            mode: walletInfo.mode,
            usdc: usdcBalance,
            matic: maticBalance,
            depositAddress: walletInfo.address // Same address to receive funds
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Get just the balance (for frequent polling) - PARALLEL fetch
app.get('/api/wallet/balance', async (req, res) => {
    try {
        const [usdc, matic] = await Promise.all([
            tradeExecutor.getUSDCBalance(),
            tradeExecutor.getMATICBalance()
        ]);
        res.json({ usdc, matic });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Transfer USDC to external address
app.post('/api/wallet/transfer', async (req, res) => {
    try {
        const { to, amount } = req.body;

        if (!to || !amount) {
            return res.status(400).json({ success: false, error: 'Missing "to" address or "amount"' });
        }

        const result = await tradeExecutor.transferUSDC(to, parseFloat(amount));
        res.json(result);
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// ==================== SETTINGS API ====================
// NOTE: express.json() is now at top of file (after cors())

// Get current settings (masked for security)
app.get('/api/settings', (req, res) => {
    res.json({
        // Masked keys (show first/last 4 chars only)
        POLYMARKET_API_KEY: CONFIG.POLYMARKET_API_KEY ? `${CONFIG.POLYMARKET_API_KEY.substring(0, 8)}...${CONFIG.POLYMARKET_API_KEY.slice(-4)}` : '',
        POLYMARKET_SECRET: CONFIG.POLYMARKET_SECRET ? '****HIDDEN****' : '',
        POLYMARKET_PASSPHRASE: CONFIG.POLYMARKET_PASSPHRASE ? '****HIDDEN****' : '',
        POLYMARKET_ADDRESS: CONFIG.POLYMARKET_ADDRESS,
        POLYMARKET_PRIVATE_KEY: CONFIG.POLYMARKET_PRIVATE_KEY ? '****HIDDEN****' : '',
        POLYMARKET_PROXY_KEY: CONFIG.POLYMARKET_PROXY_KEY ? `${CONFIG.POLYMARKET_PROXY_KEY.substring(0, 4)}...` : '',

        // Trading settings (fully visible)
        TRADE_MODE: CONFIG.TRADE_MODE,
        PAPER_BALANCE: CONFIG.PAPER_BALANCE,
        LIVE_BALANCE: CONFIG.LIVE_BALANCE,
        MAX_POSITION_SIZE: CONFIG.MAX_POSITION_SIZE,
        MAX_POSITIONS_PER_ASSET: CONFIG.MAX_POSITIONS_PER_ASSET,
        MULTI_MODE_ENABLED: CONFIG.MULTI_MODE_ENABLED,

        // Mode Configs
        ORACLE: CONFIG.ORACLE,
        ARBITRAGE: CONFIG.ARBITRAGE,
        SCALP: CONFIG.SCALP,
        UNCERTAINTY: CONFIG.UNCERTAINTY,
        MOMENTUM: CONFIG.MOMENTUM,
        RISK: CONFIG.RISK,

        // Status
        walletLoaded: !!tradeExecutor.wallet,
        walletAddress: tradeExecutor.wallet ? tradeExecutor.wallet.address : null,
        currentBalance: tradeExecutor.paperBalance,
        positions: tradeExecutor.positions,
        tradeHistory: tradeExecutor.tradeHistory || []
    });
});

// Reset paper balance endpoint
app.post('/api/reset-balance', async (req, res) => {
    const { balance } = req.body;
    const newBalance = parseFloat(balance) || 1000;

    // Reset trade executor
    tradeExecutor.paperBalance = newBalance;
    tradeExecutor.startingBalance = newBalance;
    tradeExecutor.positions = {};
    tradeExecutor.tradeHistory = [];
    tradeExecutor.todayPnL = 0;
    tradeExecutor.lastLossTime = 0;

    // Update config
    CONFIG.PAPER_BALANCE = newBalance;

    log(`🔄 Paper balance reset to $${newBalance}`);

    res.json({ success: true, balance: newBalance });
});

// Update settings
app.post('/api/settings', async (req, res) => {
    const updates = req.body;
    let reloadRequired = false;

    // Update CONFIG
    for (const [key, value] of Object.entries(updates)) {
        if (CONFIG.hasOwnProperty(key)) {
            CONFIG[key] = value;
            log(`⚙️ Setting updated: ${key}`);

            // Check if wallet reload needed
            if (['POLYMARKET_API_KEY', 'POLYMARKET_SECRET', 'POLYMARKET_PASSPHRASE', 'POLYMARKET_PRIVATE_KEY', 'TRADE_MODE'].includes(key)) {
                reloadRequired = true;
            }
        }
    }

    // Reload wallet if needed
    if (reloadRequired) {
        tradeExecutor.reloadWallet();
    }

    // PERSIST SETTINGS TO REDIS (survives restarts!)
    if (redisAvailable && redis) {
        try {
            const persistedSettings = {
                // API Credentials
                POLYMARKET_API_KEY: CONFIG.POLYMARKET_API_KEY,
                POLYMARKET_SECRET: CONFIG.POLYMARKET_SECRET,
                POLYMARKET_PASSPHRASE: CONFIG.POLYMARKET_PASSPHRASE,
                POLYMARKET_ADDRESS: CONFIG.POLYMARKET_ADDRESS,
                POLYMARKET_PRIVATE_KEY: CONFIG.POLYMARKET_PRIVATE_KEY,
                POLYMARKET_PROXY_KEY: CONFIG.POLYMARKET_PROXY_KEY,
                // Core Trading
                TRADE_MODE: CONFIG.TRADE_MODE,
                PAPER_BALANCE: CONFIG.PAPER_BALANCE,
                LIVE_BALANCE: CONFIG.LIVE_BALANCE,
                MAX_POSITION_SIZE: CONFIG.MAX_POSITION_SIZE,
                MAX_POSITIONS_PER_ASSET: CONFIG.MAX_POSITIONS_PER_ASSET,
                MULTI_MODE_ENABLED: CONFIG.MULTI_MODE_ENABLED,
                // Mode Configurations (NOW PERSISTED!)
                ORACLE: CONFIG.ORACLE,
                ARBITRAGE: CONFIG.ARBITRAGE,
                SCALP: CONFIG.SCALP,
                UNCERTAINTY: CONFIG.UNCERTAINTY,
                MOMENTUM: CONFIG.MOMENTUM,
                RISK: CONFIG.RISK
            };
            await redis.set('deity:settings', JSON.stringify(persistedSettings));
            log('💾 Settings persisted to Redis');
        } catch (e) {
            log(`⚠️ Failed to persist settings: ${e.message}`);
        }
    }

    res.json({ success: true, message: 'Settings updated and persisted', reloadRequired });
});

// Settings UI page
app.get('/settings', (req, res) => {
    res.send(`
<!DOCTYPE html>
<html>
<head>
    <title>Settings - Supreme Deity Oracle</title>
    <meta charset="UTF-8">
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
            font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
            background: linear-gradient(135deg, #1e3c72 0%, #2a5298 100%);
            color: white;
            padding: 20px;
            min-height: 100vh;
        }
        .container { max-width: 900px; margin: 0 auto; }
        h1 { text-align: center; margin-bottom: 30px; font-size: 2.5em; }
        .card {
            background: rgba(0,0,0,0.4);
            border-radius: 12px;
            padding: 25px;
            margin-bottom: 20px;
            border: 2px solid rgba(255,255,255,0.1);
        }
        .card h2 { margin-bottom: 20px; color: #4fc3f7; }
        .form-group { margin-bottom: 15px; }
        label { display: block; margin-bottom: 5px; font-weight: bold; color: #aaa; }
        input, select {
            width: 100%;
            padding: 12px;
            border: 2px solid rgba(255,255,255,0.2);
            border-radius: 8px;
            background: rgba(0,0,0,0.3);
            color: white;
            font-size: 14px;
        }
        input:focus, select:focus { border-color: #4fc3f7; outline: none; }
        .btn {
            padding: 15px 30px;
            border: none;
            border-radius: 8px;
            font-size: 16px;
            font-weight: bold;
            cursor: pointer;
            transition: all 0.3s;
            margin-right: 10px;
        }
        .btn-primary { background: #4fc3f7; color: #000; }
        .btn-primary:hover { background: #81d4fa; transform: scale(1.05); }
        .btn-danger { background: #ff4444; color: white; }
        .btn-danger:hover { background: #ff6666; }
        .btn-success { background: #00c853; color: white; }
        .btn-success:hover { background: #00e676; }
        .status { padding: 10px; border-radius: 8px; margin-top: 15px; }
        .status.success { background: rgba(0,200,100,0.3); border: 1px solid #00c853; }
        .status.error { background: rgba(255,0,0,0.3); border: 1px solid #ff4444; }
        .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 15px; }
        .back-link { display: inline-block; margin-bottom: 20px; color: #4fc3f7; text-decoration: none; }
        .back-link:hover { text-decoration: underline; }
        .mode-toggle {
            display: flex;
            gap: 10px;
        }
        .mode-btn {
            flex: 1;
            padding: 15px;
            border: 2px solid rgba(255,255,255,0.3);
            border-radius: 8px;
            background: rgba(0,0,0,0.3);
            color: white;
            cursor: pointer;
            font-weight: bold;
            transition: all 0.3s;
        }
        .mode-btn.active { border-color: #00c853; background: rgba(0,200,100,0.3); }
        .mode-btn.paper.active { border-color: #ff9800; background: rgba(255,150,0,0.3); }
        .mode-btn.live.active { border-color: #ff0066; background: rgba(255,0,100,0.3); }
        .wallet-status {
            padding: 15px;
            border-radius: 8px;
            background: rgba(0,0,0,0.3);
            margin-top: 15px;
        }
    </style>
</head>
<body>
    <div class="container">
        <a href="/" class="back-link">← Back to Dashboard</a>
        <h1>⚙️ Settings</h1>
        
        <div class="card">
            <h2>🔄 Trading Mode</h2>
            <div class="mode-toggle">
                <button class="mode-btn paper" onclick="setMode('PAPER')">📝 PAPER TRADING</button>
                <button class="mode-btn live" onclick="setMode('LIVE')">🔴 LIVE TRADING</button>
            </div>
            <div class="wallet-status" id="walletStatus">Loading...</div>
        </div>
        
        <div class="card">
            <h2>💰 Trading Parameters</h2>
            <div class="grid">
                <div class="form-group">
                    <label>Paper Balance ($)</label>
                    <input type="number" id="PAPER_BALANCE" value="1000">
                </div>
                <div class="form-group">
                    <label>Max Position Size (%)</label>
                    <input type="number" id="MAX_POSITION_SIZE" value="10" step="1" min="1" max="25">
                </div>
            </div>
        </div>
        
        <div class="card">
            <h2>🎯 Sniper Mode Thresholds</h2>
            <div class="grid">
                <div class="form-group">
                    <label>Conviction Threshold</label>
                    <input type="number" id="CONVICTION_THRESHOLD" value="0.70" step="0.05" min="0.5" max="0.95">
                </div>
                <div class="form-group">
                    <label>Advisory Threshold</label>
                    <input type="number" id="ADVISORY_THRESHOLD" value="0.55" step="0.05" min="0.3" max="0.7">
                </div>
                <div class="form-group">
                    <label>Early Boost Multiplier</label>
                    <input type="number" id="EARLY_BOOST" value="1.35" step="0.05" min="1.0" max="1.5">
                </div>
                <div class="form-group">
                    <label>Reality Check (ATR Multiple)</label>
                    <input type="number" id="REALITY_CHECK_ATR" value="4" step="1" min="2" max="6">
                </div>
            </div>
        </div>
        
        <div class="card">
            <h2>🔑 API Keys</h2>
            <div class="form-group">
                <label>Polymarket API Key</label>
                <input type="text" id="POLYMARKET_API_KEY" placeholder="019aed53-b71a-7065-9115-c35883302725">
            </div>
            <div class="form-group">
                <label>Polymarket Secret</label>
                <input type="password" id="POLYMARKET_SECRET" placeholder="Enter secret...">
            </div>
            <div class="form-group">
                <label>Polymarket Passphrase</label>
                <input type="password" id="POLYMARKET_PASSPHRASE" placeholder="Enter passphrase...">
            </div>
            <div class="form-group">
                <label>Wallet Address</label>
                <input type="text" id="POLYMARKET_ADDRESS" placeholder="0x...">
            </div>
            <div class="form-group">
                <label>Private Key (⚠️ SENSITIVE)</label>
                <input type="password" id="POLYMARKET_PRIVATE_KEY" placeholder="Enter private key...">
            </div>
        </div>
        
        <div style="text-align: center; margin-top: 20px;">
            <button class="btn btn-primary" onclick="saveSettings()">💾 Save All Settings</button>
            <button class="btn btn-danger" onclick="resetSettings()">🔄 Reset to Defaults</button>
        </div>
        
        <div id="statusMessage" class="status" style="display: none;"></div>
    </div>
    
    <script>
        let currentSettings = {};
        
        async function loadSettings() {
            try {
                const res = await fetch('/api/settings');
                currentSettings = await res.json();
                
                // Populate form
                document.getElementById('PAPER_BALANCE').value = currentSettings.PAPER_BALANCE || 1000;
                document.getElementById('MAX_POSITION_SIZE').value = (currentSettings.MAX_POSITION_SIZE || 0.10) * 100;
                document.getElementById('CONVICTION_THRESHOLD').value = currentSettings.CONVICTION_THRESHOLD || 0.70;
                document.getElementById('ADVISORY_THRESHOLD').value = currentSettings.ADVISORY_THRESHOLD || 0.55;
                document.getElementById('EARLY_BOOST').value = currentSettings.EARLY_BOOST || 1.35;
                document.getElementById('REALITY_CHECK_ATR').value = currentSettings.REALITY_CHECK_ATR || 4;
                document.getElementById('POLYMARKET_ADDRESS').value = currentSettings.POLYMARKET_ADDRESS || '';
                
                // Update mode buttons
                document.querySelectorAll('.mode-btn').forEach(btn => btn.classList.remove('active'));
                if (currentSettings.TRADE_MODE === 'PAPER') {
                    document.querySelector('.mode-btn.paper').classList.add('active');
                } else {
                    document.querySelector('.mode-btn.live').classList.add('active');
                }
                
                // Wallet status
                const walletStatus = document.getElementById('walletStatus');
                if (currentSettings.walletLoaded) {
                    walletStatus.innerHTML = '✅ Wallet Connected: <strong>' + currentSettings.walletAddress + '</strong><br>' +
                        'Mode: <strong>' + currentSettings.TRADE_MODE + '</strong> | ' +
                        'Balance: <strong>$' + (currentSettings.currentBalance?.toFixed(2) || '0.00') + '</strong>';
                } else {
                    walletStatus.innerHTML = '⚠️ No wallet loaded. Enter private key and save to connect.';
                }
            } catch (e) {
                showStatus('Error loading settings: ' + e.message, 'error');
            }
        }
        
        async function setMode(mode) {
            // SAFEGUARD: Require confirmation for LIVE mode
            if (mode === 'LIVE') {
                const confirmed = confirm(
                    '⚠️ WARNING: LIVE TRADING MODE ⚠️\n\n' +
                    'You are about to enable REAL MONEY trading!\n\n' +
                    '• Real orders will be placed on Polymarket\n' +
                    '• Real USDC will be used from your wallet\n' +
                    '• Losses are REAL and IRREVERSIBLE\n\n' +
                    'Make sure:\n' +
                    '• Your API credentials are correct\n' +
                    '• Your wallet has USDC and MATIC for gas\n' +
                    '• You understand the risks\n\n' +
                    'Click OK to enable LIVE trading, or Cancel to stay in PAPER mode.'
                );
                if (!confirmed) {
                    showStatus('Stayed in PAPER mode', 'success');
                    return;
                }
            }
            
            try {
                await fetch('/api/settings', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ TRADE_MODE: mode })
                });
                loadSettings();
                
                if (mode === 'LIVE') {
                    showStatus('🔴 LIVE MODE ENABLED - Real trades will be executed!', 'error');
                } else {
                    showStatus('📝 Paper mode enabled - Simulated trading', 'success');
                }
            } catch (e) {
                showStatus('Error: ' + e.message, 'error');
            }
        }
        
        async function saveSettings() {
            const updates = {};
            
            // Collect non-empty values
            const fields = ['POLYMARKET_API_KEY', 'POLYMARKET_SECRET', 'POLYMARKET_PASSPHRASE', 
                            'POLYMARKET_ADDRESS', 'POLYMARKET_PRIVATE_KEY'];
            fields.forEach(id => {
                const val = document.getElementById(id).value;
                if (val && val.length > 0 && !val.includes('****')) {
                    updates[id] = val;
                }
            });
            
            // Numeric fields
            updates.PAPER_BALANCE = parseFloat(document.getElementById('PAPER_BALANCE').value);
            updates.MAX_POSITION_SIZE = parseFloat(document.getElementById('MAX_POSITION_SIZE').value) / 100;
            updates.CONVICTION_THRESHOLD = parseFloat(document.getElementById('CONVICTION_THRESHOLD').value);
            updates.ADVISORY_THRESHOLD = parseFloat(document.getElementById('ADVISORY_THRESHOLD').value);
            updates.EARLY_BOOST = parseFloat(document.getElementById('EARLY_BOOST').value);
            updates.REALITY_CHECK_ATR = parseInt(document.getElementById('REALITY_CHECK_ATR').value);
            
            try {
                const res = await fetch('/api/settings', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(updates)
                });
                const result = await res.json();
                showStatus('Settings saved successfully!', 'success');
                loadSettings();
            } catch (e) {
                showStatus('Error: ' + e.message, 'error');
            }
        }
        
        function resetSettings() {
            if (confirm('Reset all settings to defaults?')) {
                location.reload();
            }
        }
        
        function showStatus(msg, type) {
            const el = document.getElementById('statusMessage');
            el.textContent = msg;
            el.className = 'status ' + type;
            el.style.display = 'block';
            setTimeout(() => el.style.display = 'none', 5000);
        }
        
        loadSettings();
        setInterval(loadSettings, 10000);
    </script>
</body>
</html>
    `);
});

// ==================== BEGINNER'S GUIDE PAGE ====================
app.get('/guide', (req, res) => {
    res.send(`
<!DOCTYPE html>
<html>
<head>
    <title>Supreme Oracle - Beginner's Guide</title>
    <meta charset="UTF-8">
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { font-family: 'Segoe UI', Tahoma, sans-serif; background: #0a0a1a; color: #e0e0e0; line-height: 1.7; }
        .container { max-width: 1000px; margin: 0 auto; padding: 20px; }
        h1 { color: #ffd700; text-align: center; margin: 30px 0; font-size: 2.5em; }
        h2 { color: #00ff88; margin: 40px 0 20px; padding-bottom: 10px; border-bottom: 2px solid #333; }
        h3 { color: #88ccff; margin: 25px 0 15px; }
        .card { background: rgba(0,0,0,0.5); border: 1px solid #333; border-radius: 12px; padding: 25px; margin: 20px 0; }
        .mode-card { border-left: 4px solid #ffd700; }
        .mode-card.oracle { border-left-color: #9933ff; }
        .mode-card.arb { border-left-color: #00ff88; }
        .mode-card.scalp { border-left-color: #ff6633; }
        .mode-card.unc { border-left-color: #3399ff; }
        .mode-card.mom { border-left-color: #ff33cc; }
        .emoji { font-size: 1.5em; margin-right: 10px; }
        .highlight { background: rgba(255,215,0,0.1); padding: 2px 8px; border-radius: 4px; color: #ffd700; }
        .term { color: #00ff88; font-weight: bold; }
        table { width: 100%; border-collapse: collapse; margin: 20px 0; }
        th, td { padding: 12px; text-align: left; border-bottom: 1px solid #333; }
        th { background: rgba(0,255,136,0.1); color: #00ff88; }
        .tip { background: rgba(0,136,255,0.1); border-left: 4px solid #0088ff; padding: 15px; margin: 20px 0; }
        .warning { background: rgba(255,102,0,0.1); border-left: 4px solid #ff6600; padding: 15px; margin: 20px 0; }
        nav { background: rgba(0,0,0,0.8); padding: 15px; margin-bottom: 30px; text-align: center; }
        nav a { color: #88ccff; text-decoration: none; margin: 0 20px; font-size: 1.1em; }
        nav a:hover { color: #00ff88; }
        .back-link { display: inline-block; color: #ffd700; text-decoration: none; margin: 30px 0; }
    </style>
</head>
<body>
    <nav>
        <a href="/">📊 Dashboard</a>
        <a href="/settings">⚙️ Settings</a>
        <a href="/guide">📚 Guide</a>
    </nav>
    
    <div class="container">
        <h1>🔮 Supreme Oracle - Beginner's Guide</h1>
        
        <div class="card">
            <h2>📖 What Is This Bot?</h2>
            <p>The Supreme Oracle is an <span class="term">AI-powered prediction bot</span> for <span class="highlight">Polymarket BTC/ETH price markets</span>. It analyzes price movements using 8 machine learning models and automatically trades when it identifies profitable opportunities.</p>
        </div>
        
        <h2>🎯 The 5 Trading Modes</h2>
        <p>The bot operates in 5 different modes simultaneously, each looking for different types of profitable opportunities:</p>
        
        <div class="card mode-card oracle">
            <h3><span class="emoji">🔮</span> ORACLE Mode</h3>
            <p><strong>Strategy:</strong> Predict the final UP/DOWN outcome with near-certainty.</p>
            <p><strong>When it trades:</strong> Only when ALL 8 models agree, confidence is 92%+, and there's a 15%+ edge over market odds.</p>
            <p><strong>Expected trades:</strong> 1-5 per day (very selective)</p>
            <p><strong>Target accuracy:</strong> 85%+</p>
        </div>
        
        <div class="card mode-card arb">
            <h3><span class="emoji">📊</span> ARBITRAGE Mode</h3>
            <p><strong>Strategy:</strong> Buy when the market odds are significantly different from our calculated fair value.</p>
            <p><strong>Example:</strong> If we calculate 60% probability but market shows 40% odds, buy at 40¢ and sell when odds correct to ~55¢.</p>
            <p><strong>Exit:</strong> At 50% profit OR after 10 minutes maximum hold time.</p>
        </div>
        
        <div class="card mode-card scalp">
            <h3><span class="emoji">🎯</span> SCALP Mode</h3>
            <p><strong>Strategy:</strong> Buy ultra-cheap options (under 20¢) and exit at 2x profit.</p>
            <p><strong>Example:</strong> Buy at 10¢, sell at 20¢ = 100% profit!</p>
            <p><strong>Safety:</strong> Exits before resolution to avoid total loss.</p>
        </div>
        
        <div class="card mode-card unc">
            <h3><span class="emoji">🌊</span> UNCERTAINTY Mode</h3>
            <p><strong>Strategy:</strong> When odds are extreme (80%+), bet on reversion toward 50/50.</p>
            <p><strong>Example:</strong> YES at 85¢ → market gets uncertain → YES drops to 60¢. We buy NO and profit!</p>
            <p><strong>Only works in:</strong> Choppy, uncertain markets (NOT trending markets).</p>
        </div>
        
        <div class="card mode-card mom">
            <h3><span class="emoji">🚀</span> MOMENTUM Mode</h3>
            <p><strong>Strategy:</strong> Ride strong trends when price breaks out mid-cycle.</p>
            <p><strong>Entry:</strong> After 5 minutes, when clear breakout + 75%+ model agreement.</p>
            <p><strong>Exit:</strong> First sign of reversal OR 3 minutes before checkpoint.</p>
        </div>
        
        <h2>📊 Understanding the Dashboard</h2>
        
        <table>
            <tr><th>Metric</th><th>What It Means</th><th>Good Values</th></tr>
            <tr><td><span class="term">Prediction</span></td><td>The bot's current prediction for price direction</td><td>UP or DOWN (not NEUTRAL)</td></tr>
            <tr><td><span class="term">Confidence</span></td><td>How certain the bot is about its prediction (0-100%)</td><td>70%+ for trading</td></tr>
            <tr><td><span class="term">Tier</span></td><td>Trade quality level based on confidence</td><td>CONVICTION (best) or ADVISORY</td></tr>
            <tr><td><span class="term">Edge</span></td><td>Our advantage over market odds</td><td>10%+ is excellent</td></tr>
            <tr><td><span class="term">Win Rate</span></td><td>Historical accuracy of predictions</td><td>55%+ is profitable</td></tr>
            <tr><td><span class="term">Vote Stability</span></td><td>How consistent the models are in agreeing</td><td>80%+ means strong signal</td></tr>
            <tr><td><span class="term">Market Odds</span></td><td>Current YES/NO prices on Polymarket</td><td>Lower odds = more profit potential</td></tr>
        </table>
        
        <h2>💰 How Trades Work</h2>
        
        <div class="card">
            <h3>Entry</h3>
            <p>When conditions are met for any mode, the bot automatically:</p>
            <ol style="margin-left: 20px; margin-top: 10px;">
                <li>Calculates optimal position size (never more than 10% of balance)</li>
                <li>Sets target prices and stop losses</li>
                <li>Executes the trade</li>
            </ol>
        </div>
        
        <div class="card">
            <h3>Exit</h3>
            <p>Trades are closed automatically when:</p>
            <ul style="margin-left: 20px; margin-top: 10px;">
                <li>Target price is hit (profit!)</li>
                <li>Stop loss is triggered (limiting losses)</li>
                <li>Maximum hold time reached</li>
                <li>Before checkpoint resolution (for non-Oracle modes)</li>
            </ul>
        </div>
        
        <div class="warning">
            <h3>⚠️ Important: Paper vs Live Trading</h3>
            <p>The bot defaults to <span class="term">PAPER</span> mode (simulated trading). This is for testing. To use real money, change <code>TRADE_MODE</code> to <code>LIVE</code> in settings after thoroughly testing.</p>
        </div>
        
        <h2>🔗 API Endpoints</h2>
        <table>
            <tr><th>Endpoint</th><th>Description</th></tr>
            <tr><td><code>/api/state</code></td><td>Current bot state, predictions, and positions</td></tr>
            <tr><td><code>/api/trades</code></td><td>Detailed trade history and P/L</td></tr>
            <tr><td><code>/api/settings</code></td><td>Current configuration</td></tr>
            <tr><td><code>/api/export?asset=BTC</code></td><td>Download CSV of prediction history</td></tr>
        </table>
        
        <div class="tip">
            <h3>💡 Pro Tips</h3>
            <ul style="margin-left: 20px; margin-top: 10px;">
                <li>Watch for 🔮🔮🔮 ORACLE MODE ACTIVATED in logs - these are the highest confidence trades</li>
                <li>SCALP mode works best when one side has very low odds (under 20¢)</li>
                <li>The bot has a 5-minute cooldown after losses to prevent emotional revenge trading</li>
                <li>Check <code>/api/trades</code> regularly to monitor performance</li>
            </ul>
        </div>
        
        <h2>🎚️ Oracle Aggression System</h2>
        
        <div class="card">
            <p>Control how frequently Oracle mode generates predictions with the <span class="term">Aggression Slider</span> (0-100%):</p>
            
            <table>
                <tr><th>Aggression</th><th>Effect</th><th>Best For</th></tr>
                <tr><td><strong>0% (Conservative)</strong></td><td>Base thresholds unchanged</td><td>High accuracy, fewer trades</td></tr>
                <tr><td><strong>50% (Balanced)</strong></td><td>15% threshold reduction</td><td>Default operation</td></tr>
                <tr><td><strong>100% (Aggressive)</strong></td><td>30% threshold reduction</td><td>Maximum opportunities</td></tr>
            </table>
            
            <div class="tip" style="margin-top: 15px;">
                <strong>Quality Protection:</strong> Even at 100% aggression, core quality gates remain active. Predictions are more frequent but still validated.
            </div>
            
            <p style="margin-top: 15px;">Access: <strong>Settings → Mode Configuration → 🔮 ORACLE</strong></p>
        </div>
        
        <h2>🔄 Failed Sells Recovery</h2>
        
        <div class="card">
            <p>If a sell order fails after 5 retries, it's saved with complete recovery info:</p>
            
            <ul style="margin-left: 20px; margin-top: 10px;">
                <li><span class="term">tokenId</span> - Position token identifier</li>
                <li><span class="term">conditionId</span> - Market condition ID</li>
                <li><span class="term">marketSlug</span> - Human-readable market name</li>
                <li><span class="term">polygonscanUrl</span> - View token on PolygonScan</li>
                <li><span class="term">redemptionInstructions</span> - Step-by-step recovery guide</li>
            </ul>
            
            <p style="margin-top: 15px;">View at: <code>/api/pending-sells</code> or in the Trading section of the dashboard.</p>
        </div>
        

        <a href="/" class="back-link">← Back to Dashboard</a>
    </div>
</body>
</html>
    `);
});

// ==================== WALLET MANAGEMENT PAGE ====================
app.get('/wallet', (req, res) => {
    res.send(`
<!DOCTYPE html>
<html>
<head>
    <title>Wallet - Supreme Oracle</title>
    <meta charset="UTF-8">
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { font-family: 'Segoe UI', Tahoma, sans-serif; background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%); color: white; min-height: 100vh; }
        .container { max-width: 800px; margin: 0 auto; padding: 20px; }
        h1 { text-align: center; margin: 30px 0; font-size: 2.5em; color: #ffd700; }
        .card { background: rgba(0,0,0,0.5); border: 1px solid #333; border-radius: 12px; padding: 25px; margin: 20px 0; }
        .balance-card { border-left: 4px solid #00ff88; }
        .transfer-card { border-left: 4px solid #ff6633; }
        .deposit-card { border-left: 4px solid #3399ff; }
        h2 { color: #00ff88; margin-bottom: 20px; }
        .balance { font-size: 3em; font-weight: bold; color: #ffd700; margin: 20px 0; text-align: center; }
        .balance-label { font-size: 0.9em; color: #888; text-align: center; }
        .address { font-family: monospace; background: rgba(0,0,0,0.5); padding: 15px; border-radius: 8px; word-break: break-all; font-size: 0.9em; margin: 10px 0; }
        .copy-btn { background: #3399ff; color: white; border: none; padding: 10px 20px; border-radius: 6px; cursor: pointer; margin-top: 10px; }
        .copy-btn:hover { background: #2277dd; }
        .form-group { margin-bottom: 20px; }
        label { display: block; margin-bottom: 8px; color: #aaa; font-weight: bold; }
        input { width: 100%; padding: 15px; border: 2px solid #333; border-radius: 8px; background: rgba(0,0,0,0.4); color: white; font-size: 16px; }
        input:focus { border-color: #ff6633; outline: none; }
        .btn { width: 100%; padding: 15px; border: none; border-radius: 8px; font-size: 18px; font-weight: bold; cursor: pointer; transition: all 0.3s; }
        .btn-transfer { background: linear-gradient(135deg, #ff6633 0%, #ff4400 100%); color: white; }
        .btn-transfer:hover { transform: scale(1.02); box-shadow: 0 5px 20px rgba(255,100,50,0.4); }
        .btn-transfer:disabled { background: #555; cursor: not-allowed; transform: none; }
        .status { padding: 15px; border-radius: 8px; margin-top: 15px; display: none; }
        .status.success { background: rgba(0,255,136,0.2); border: 1px solid #00ff88; display: block; }
        .status.error { background: rgba(255,0,0,0.2); border: 1px solid #ff4444; display: block; }
        .status.loading { background: rgba(255,200,0,0.2); border: 1px solid #ffc800; display: block; }
        nav { background: rgba(0,0,0,0.8); padding: 15px; text-align: center; }
        nav a { color: #88ccff; text-decoration: none; margin: 0 20px; font-size: 1.1em; }
        nav a:hover { color: #00ff88; }
        .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; margin-top: 10px; }
        .gas-warning { color: #ff9900; font-size: 0.9em; margin-top: 10px; }
        .tx-link { color: #00ff88; text-decoration: none; }
        .tx-link:hover { text-decoration: underline; }
        .refresh-btn { background: #444; color: white; border: none; padding: 8px 16px; border-radius: 6px; cursor: pointer; font-size: 0.9em; }
        .refresh-btn:hover { background: #555; }
    </style>
</head>
<body>
    <nav>
        <a href="/">📊 Dashboard</a>
        <a href="/settings">⚙️ Settings</a>
        <a href="/wallet">💰 Wallet</a>
        <a href="/guide">📚 Guide</a>
    </nav>
    
    <div class="container">
        <h1>💰 Wallet Management</h1>
        
        <div class="card balance-card">
            <h2>💵 Live Balances <button class="refresh-btn" onclick="loadWallet()">🔄 Refresh</button></h2>
            <div class="grid">
                <div>
                    <div class="balance" id="usdcBalance">--</div>
                    <div class="balance-label">USDC (Trading)</div>
                </div>
                <div>
                    <div class="balance" id="maticBalance" style="font-size:1.5em; color:#8b5cf6;">--</div>
                    <div class="balance-label">MATIC (Gas)</div>
                </div>
            </div>
            <p class="gas-warning" id="gasWarning" style="display:none;">⚠️ Low MATIC balance! You need MATIC to pay for transaction gas fees.</p>
        </div>
        
        <div class="card deposit-card">
            <h2>📥 Deposit (Receive USDC)</h2>
            <p style="color:#aaa; margin-bottom:15px;">Send USDC (Polygon network) to this address:</p>
            <div class="address" id="depositAddress">Loading...</div>
            <button class="copy-btn" onclick="copyAddress()">📋 Copy Address</button>
            <p style="color:#888; font-size:0.85em; margin-top:15px;">⚠️ Only send USDC on <strong>Polygon</strong> network. Sending on other networks will result in loss of funds!</p>
            <div style="margin-top:15px; padding:12px; background:rgba(255,150,0,0.1); border-radius:8px; border-left:3px solid #ff9900;">
                <p style="color:#ff9900; font-size:0.9em; margin:0;"><strong>💡 Important:</strong></p>
                <p style="color:#aaa; font-size:0.85em; margin:5px 0 0;">
                    • <strong style="color:#ffd700;">USDC</strong> = Trading balance (what you trade with)<br>
                    • <strong style="color:#8b5cf6;">POL/MATIC</strong> = Gas fees only (pays transaction costs)<br>
                    You need BOTH: USDC for trading + small POL/MATIC for gas (~0.1 POL is enough).
                </p>
            </div>
        </div>
        
        <div class="card transfer-card">
            <h2>📤 Withdraw (Send USDC)</h2>
            <form id="transferForm" onsubmit="handleTransfer(event)">
                <div class="form-group">
                    <label>Destination Address</label>
                    <input type="text" id="toAddress" placeholder="0x..." required>
                </div>
                <div class="form-group">
                    <label>Amount (USDC)</label>
                    <input type="number" id="amount" placeholder="0.00" step="0.01" min="0.01" required>
                </div>
                <button type="submit" class="btn btn-transfer" id="transferBtn">💸 Send USDC</button>
            </form>
            <div class="status" id="transferStatus"></div>
        </div>
    </div>
    
    <script>
        let walletData = null;
        
        async function loadWallet() {
            try {
                const res = await fetch('/api/wallet');
                walletData = await res.json();
                
                if (!walletData.loaded) {
                    document.getElementById('usdcBalance').textContent = 'No Wallet';
                    document.getElementById('maticBalance').textContent = '--';
                    document.getElementById('depositAddress').textContent = 'Wallet not loaded. Add private key in Settings.';
                    return;
                }
                
                // Update balances
                if (walletData.usdc.success) {
                    document.getElementById('usdcBalance').textContent = '$' + walletData.usdc.balance.toFixed(2);
                } else {
                    document.getElementById('usdcBalance').textContent = 'Error';
                }
                
                if (walletData.matic.success) {
                    document.getElementById('maticBalance').textContent = walletData.matic.balance.toFixed(4) + ' MATIC';
                    // Show warning if low MATIC
                    if (walletData.matic.balance < 0.01) {
                        document.getElementById('gasWarning').style.display = 'block';
                    } else {
                        document.getElementById('gasWarning').style.display = 'none';
                    }
                }
                
                // Update deposit address
                document.getElementById('depositAddress').textContent = walletData.address;
                
            } catch (e) {
                console.error('Error loading wallet:', e);
            }
        }
        
        function copyAddress() {
            const address = document.getElementById('depositAddress').textContent;
            navigator.clipboard.writeText(address).then(() => {
                alert('Address copied to clipboard!');
            });
        }
        
        async function handleTransfer(e) {
            e.preventDefault();
            
            const to = document.getElementById('toAddress').value.trim();
            const amount = parseFloat(document.getElementById('amount').value);
            const btn = document.getElementById('transferBtn');
            const status = document.getElementById('transferStatus');
            
            // Validate
            if (!to.startsWith('0x') || to.length !== 42) {
                status.className = 'status error';
                status.textContent = '❌ Invalid Ethereum address';
                return;
            }
            
            if (amount <= 0) {
                status.className = 'status error';
                status.textContent = '❌ Amount must be positive';
                return;
            }
            
            // Confirm
            if (!confirm('Are you sure you want to send $' + amount + ' USDC to ' + to + '?')) {
                return;
            }
            
            // Execute
            btn.disabled = true;
            btn.textContent = '⏳ Processing...';
            status.className = 'status loading';
            status.textContent = '🔄 Submitting transaction...';
            
            try {
                const res = await fetch('/api/wallet/transfer', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ to, amount })
                });
                
                const result = await res.json();
                
                if (result.success) {
                    status.className = 'status success';
                    status.innerHTML = '✅ Transfer successful! <br><a href="' + result.explorerUrl + '" target="_blank" class="tx-link">View on PolygonScan →</a>';
                    // Clear form
                    document.getElementById('toAddress').value = '';
                    document.getElementById('amount').value = '';
                    // Refresh balance
                    setTimeout(loadWallet, 2000);
                } else {
                    status.className = 'status error';
                    status.textContent = '❌ ' + result.error;
                }
            } catch (e) {
                status.className = 'status error';
                status.textContent = '❌ Network error: ' + e.message;
            }
            
            btn.disabled = false;
            btn.textContent = '💸 Send USDC';
        }
        
        // Initial load
        loadWallet();
        
        // Auto-refresh every 30 seconds
        setInterval(loadWallet, 30000);
    </script>
</body>
</html>
    `);
});

// ==================== CHECKPOINT LOGIC ====================
setInterval(() => {
    const now = Math.floor(Date.now() / 1000);
    const cp = now - (now % INTERVAL_SECONDS);

    ASSETS.forEach(a => {
        // CRITICAL FIX #1 & #3: Only process within checkpoint window WITH FRESH DATA
        if (now >= cp && now < cp + 5) {
            if (lastEvaluatedCheckpoint[a] !== cp) {

                // CRITICAL: Ensure we have FRESH price data (within 3 seconds)
                const dataAge = Date.now() - lastUpdateTimestamp;
                if (dataAge > 3000) {
                    log(`⚠️ Checkpoint skipped - stale data(${(dataAge / 1000).toFixed(1)}s old)`, a);
                    return;
                }

                // Evaluate the JUST FINISHED cycle
                // Use CONFIRMED fresh prices for accurate outcome evaluation
                if (checkpointPrices[a] && livePrices[a]) {
                    // CRITICAL: Determine final outcome and resolve ALL positions
                    const finalOutcome = livePrices[a] >= checkpointPrices[a] ? 'UP' : 'DOWN';
                    const yesPrice = currentMarkets[a]?.yesPrice || 0.5;
                    const noPrice = currentMarkets[a]?.noPrice || 0.5;

                    // Close ALL open positions at cycle end with binary resolution
                    tradeExecutor.resolveAllPositions(a, finalOutcome, yesPrice, noPrice);

                    Brains[a].evaluateOutcome(livePrices[a], checkpointPrices[a]);
                    log(`📊 Evaluated checkpoint ${cp - INTERVAL_SECONDS} (fresh data)`, a);
                }

                // Update checkpoints for the NEW cycle with FRESH price
                previousCheckpointPrices[a] = checkpointPrices[a];
                checkpointPrices[a] = livePrices[a];

                // Mark this checkpoint as evaluated
                lastEvaluatedCheckpoint[a] = cp;

                log(`🔄 NEW Checkpoint: $${checkpointPrices[a]?.toFixed(2) || 'pending'} `, a);
            }
        }
    });
}, 1000);

// ==================== STARTUP ====================
function getCurrentCheckpoint() { return Math.floor(Date.now() / 1000) - (Math.floor(Date.now() / 1000) % INTERVAL_SECONDS); }
function getNextCheckpoint() { return getCurrentCheckpoint() + INTERVAL_SECONDS; }

const PORT = process.env.PORT || 3000;

async function startup() {
    log('🚀 SUPREME DEITY: CLOUD EDITION');
    log('🔧 Initializing...');

    // Wait for Redis connection if configured
    if (process.env.REDIS_URL && redis) {
        log('⏳ Waiting for Redis connection...');
        await new Promise(resolve => {
            if (redis.status === 'ready' || redis.status === 'connect') {
                return resolve();
            }
            const onConnect = () => {
                cleanup();
                resolve();
            };
            const onError = () => {
                cleanup();
                resolve(); // Resolve anyway to fallback
            };
            const cleanup = () => {
                redis.removeListener('connect', onConnect);
                redis.removeListener('error', onError);
            };
            redis.once('connect', onConnect);
            redis.once('error', onError);
            // Timeout fallback (2s)
            setTimeout(() => {
                cleanup();
                resolve();
            }, 2000);
        });
    }

    await initPatternStorage();
    await loadState();
    connectWebSocket();

    setInterval(() => ASSETS.forEach(a => Brains[a].update()), 1000);
    setInterval(saveState, 5000);
    setInterval(fetchCurrentMarkets, 2000);

    fetchFearGreedIndex();
    fetchFundingRates();

    // CHAINLINK-ONLY: Validate prices (no external HTTP sources)
    await validatePrices();
    log('📈 Waiting for Chainlink WS prices (no HTTP fallback)');

    // Periodic price validation (every 5 seconds - warns if stale, does NOT fetch external data)
    setInterval(validatePrices, 5000);

    setInterval(fetchFearGreedIndex, 300000);
    setInterval(fetchFundingRates, 300000);

    server.listen(PORT, () => {
        log(`⚡ SUPREME DEITY SERVER ONLINE on port ${PORT} `);
        log(`🌐 Access at: http://localhost:${PORT}`);
    });
}

startup();
