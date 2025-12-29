// ==================== SUPREME DEITY: CLOUD BRAIN ====================
// 24/7 Node.js Server - Ultra-Fast Edition - COMPLETE WITH ALL 8 MODELS

const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const cors = require('cors');
const Redis = require('ioredis');
const auth = require('basic-auth');
require('dotenv').config();
const { ethers } = require('ethers');
const axios = require('axios');
const { HttpsProxyAgent } = require('https-proxy-agent');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

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
    // Public endpoints (no auth) for uptime checks / deploy verification only.
    // Everything else (including trading APIs) requires Basic Auth.
    const isPublicApi =
        req.path === '/api/health' ||
        req.path === '/api/version';
    if (isPublicApi) return next();

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

// Serve static assets, but do NOT auto-serve public/index.html at `/`
// (we want `/` to be the full-featured dashboard, like the original server.js UI)
app.use(express.static('public', { index: false }));

// ==================== DEBUG EXPORT API ====================
// Returns last 10 cycles of COMPLETE debugging data - EVERY ATOM
app.get('/api/debug-export', (req, res) => {
    try {
        const exportData = {
            // === META INFO ===
            exportTime: new Date().toISOString(),
            serverUptime: process.uptime(),
            cycleInterval: INTERVAL_SECONDS,
            nodeVersion: process.version,
            memoryUsage: process.memoryUsage(),
            code: typeof CODE_FINGERPRINT !== 'undefined' ? CODE_FINGERPRINT : null,

            // === GLOBAL CONFIG (ALL MODES) ===
            config: {
                TRADE_MODE: CONFIG.TRADE_MODE,
                MULTI_MODE_ENABLED: CONFIG.MULTI_MODE_ENABLED,
                ORACLE: CONFIG.ORACLE,
                ARBITRAGE: CONFIG.ARBITRAGE,
                SCALP: CONFIG.SCALP,
                UNCERTAINTY: CONFIG.UNCERTAINTY,
                MOMENTUM: CONFIG.MOMENTUM,
                RISK: CONFIG.RISK,
                ASSET_CONTROLS: CONFIG.ASSET_CONTROLS,
                TELEGRAM_ENABLED: CONFIG.TELEGRAM?.enabled || false
            },

            // === GLOBAL STATE ===
            globalState: {
                fearGreedIndex: typeof fearGreedIndex !== 'undefined' ? fearGreedIndex : null,
                fundingRates: typeof fundingRates !== 'undefined' ? fundingRates : null,
                lastUpdateTimestamp: typeof lastUpdateTimestamp !== 'undefined' ? lastUpdateTimestamp : null,
                redisAvailable: typeof redisAvailable !== 'undefined' ? redisAvailable : false
            },

            // === TRADE EXECUTOR STATE ===
            tradeExecutor: typeof tradeExecutor !== 'undefined' ? {
                mode: tradeExecutor.mode,
                paperBalance: tradeExecutor.paperBalance,
                startingBalance: tradeExecutor.startingBalance,
                todayPnL: tradeExecutor.todayPnL,
                positions: tradeExecutor.positions,
                pendingSells: tradeExecutor.pendingSells,
                tradeHistory: tradeExecutor.tradeHistory.slice(-50), // Last 50 trades
                dailyLossCount: tradeExecutor.dailyLossCount,
                consecutiveLosses: tradeExecutor.consecutiveLosses,
                lastLossTime: tradeExecutor.lastLossTime,
                tradesThisCycle: tradeExecutor.tradesThisCycle,
                assetCycleTradeCounts: tradeExecutor.assetCycleTradeCounts,
                cachedLiveBalance: tradeExecutor.cachedLiveBalance,
                cachedGasBalance: tradeExecutor.cachedGasBalance
            } : null,

            // === OPPORTUNITY DETECTOR STATE ===
            opportunityDetector: typeof opportunityDetector !== 'undefined' ? {
                tradesThisCycle: opportunityDetector.tradesThisCycle,
                currentCycleStart: opportunityDetector.currentCycleStart
            } : null,

            // === PER-ASSET DATA ===
            assets: {}
        };

        ASSETS.forEach(asset => {
            const brain = typeof Brains !== 'undefined' ? Brains[asset] : null;

            exportData.assets[asset] = {
                // === CURRENT BRAIN STATE (EVERY PROPERTY) ===
                currentState: brain ? {
                    // Core prediction
                    prediction: brain.prediction,
                    confidence: brain.confidence,
                    tier: brain.tier,
                    edge: brain.edge,

                    // TRUE ORACLE: Certainty System
                    certaintyScore: brain.certaintyScore,
                    certaintyHistory: brain.certaintyHistory,
                    oracleLocked: brain.oracleLocked,
                    lockCertainty: brain.lockCertainty,
                    oracleLockPrediction: brain.oracleLockPrediction,

                    // Certainty Components
                    modelAgreementHistory: brain.modelAgreementHistory,
                    priceConfirmationScore: brain.priceConfirmationScore,
                    manipulationScore: brain.manipulationScore,
                    edgeHistory: brain.edgeHistory,
                    lastPriceDirection: brain.lastPriceDirection,

                    // PINNACLE EVOLUTION
                    certaintySeries: brain.certaintySeries,
                    certaintyVelocity: brain.certaintyVelocity,
                    certaintyAcceleration: brain.certaintyAcceleration,
                    currentPhase: brain.currentPhase,
                    phaseThresholdModifier: brain.phaseThresholdModifier,
                    genesisTraded: brain.genesisTraded,
                    genesisTradeDirection: brain.genesisTradeDirection,
                    lastBlackoutPrediction: brain.lastBlackoutPrediction,
                    blackoutLogged: brain.blackoutLogged,
                    inBlackout: brain.inBlackout,
                    correlationBonus: brain.correlationBonus,

                    // Conviction & Commitment
                    convictionLocked: brain.convictionLocked,
                    lockedDirection: brain.lockedDirection,
                    lockTime: brain.lockTime,
                    lockConfidence: brain.lockConfidence,
                    cycleCommitted: brain.cycleCommitted,
                    committedDirection: brain.committedDirection,
                    commitTime: brain.commitTime,

                    // Stability & Debounce
                    stabilityCounter: brain.stabilityCounter,
                    pendingSignal: brain.pendingSignal,
                    lockState: brain.lockState,
                    lockStrength: brain.lockStrength,

                    // Vote History
                    voteHistory: brain.voteHistory,
                    voteTrendScore: brain.voteTrendScore,

                    // Stats & Streaks
                    stats: brain.stats,
                    winStreak: brain.winStreak,
                    lossStreak: brain.lossStreak,
                    atrMultiplier: brain.atrMultiplier,

                    // Model Accuracy (Learning)
                    modelAccuracy: brain.modelAccuracy,
                    calibrationBuckets: brain.calibrationBuckets,
                    recentOutcomes: brain.recentOutcomes,

                    // Last Signal
                    lastSignal: brain.lastSignal,

                    // Processing State
                    isProcessing: brain.isProcessing,

                    // Scalp Tracking
                    scalpBounceHistory: brain.scalpBounceHistory
                } : null,

                // === HISTORICAL CYCLES (Last 10) ===
                cycleHistory: cycleDebugHistory[asset] || [],

                // === CURRENT PRICES ===
                livePrice: livePrices[asset],
                checkpointPrice: checkpointPrices[asset],
                previousCheckpointPrice: previousCheckpointPrices[asset],
                lastEvaluatedCheckpoint: lastEvaluatedCheckpoint[asset],

                // === MARKET DATA ===
                market: currentMarkets[asset],
                marketOddsHistory: (marketOddsHistory[asset] || []).slice(-50),

                // === PRICE HISTORY (Last 200 points) ===
                priceHistory: (priceHistory[asset] || []).slice(-200),

                // === MEMORY PATTERNS (if available) ===
                memoryPatterns: typeof memoryPatterns !== 'undefined' ?
                    (memoryPatterns[asset] || []).slice(-20) : []
            };
        });

        res.json(exportData);
    } catch (e) {
        res.status(500).json({ error: e.message, stack: e.stack });
    }
});

// Health check endpoint
app.get('/api/health', (req, res) => {
    res.json({
        status: 'ok',
        uptime: process.uptime(),
        timestamp: new Date().toISOString(),
        code: typeof CODE_FINGERPRINT !== 'undefined' ? CODE_FINGERPRINT : null
    });
});

// Version endpoint - helps confirm Render/GitHub deployment matches expected code
app.get('/api/version', (req, res) => {
    res.json({
        ...CODE_FINGERPRINT,
        nodeVersion: process.version,
        uptime: process.uptime(),
        timestamp: new Date().toISOString()
    });
});

const server = http.createServer(app);

// ==================== SOCKET.IO FOR UI DASHBOARD ====================
const { Server: SocketIOServer } = require('socket.io');
const io = new SocketIOServer(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

// Emit the current full state snapshot to a newly connected socket.io client
// (mobile.html expects `state_update`)
io.on('connection', (socket) => {
    try {
        socket.emit('state_update', buildStateSnapshot());
    } catch (e) {
        // UI is non-critical; never crash on UI emission
    }
});

// ==================== WEBSOCKET SERVER FOR REAL-TIME DASHBOARD ====================
const wss = new WebSocket.Server({ server });
let wsClients = new Set();

wss.on('connection', (ws) => {
    wsClients.add(ws);
    console.log(`🔌 WebSocket client connected (${wsClients.size} total)`);

    ws.on('close', () => {
        wsClients.delete(ws);
        console.log(`🔌 WebSocket client disconnected (${wsClients.size} remaining)`);
    });

    ws.on('error', (err) => {
        console.log(`⚠️ WebSocket error: ${err.message}`);
        wsClients.delete(ws);
    });
});

// Broadcast prediction updates to all connected clients
function broadcastUpdate() {
    if (wsClients.size === 0) return;

    const update = {
        type: 'update',
        timestamp: Date.now(),
        predictions: {},
        markets: currentMarkets,
        prices: livePrices,
        checkpointPrices: checkpointPrices,
        tradeMode: CONFIG.TRADE_MODE,
        balance: tradeExecutor ? (tradeExecutor.mode === 'PAPER' ? tradeExecutor.paperBalance : tradeExecutor.cachedLiveBalance) : 0,
        todayPnL: tradeExecutor ? tradeExecutor.todayPnL : 0,
        positions: tradeExecutor ? Object.values(tradeExecutor.positions) : [],
        trades: tradeExecutor ? tradeExecutor.tradeHistory.slice(-20) : []
    };

    // Add prediction data from each brain
    if (typeof Brains !== 'undefined') {
        ASSETS.forEach(asset => {
            if (Brains[asset]) {
                update.predictions[asset] = {
                    signal: Brains[asset].prediction || 'NEUTRAL',
                    confidence: Brains[asset].confidence || 0,
                    tier: Brains[asset].tier || 'NONE',
                    edge: Brains[asset].edge || 0,
                    locked: Brains[asset].convictionLocked || false,
                    committed: Brains[asset].cycleCommitted || false,
                    lockedDirection: Brains[asset].lockedDirection || null,
                    stats: Brains[asset].stats || { wins: 0, losses: 0, total: 0 },
                    // TRUE ORACLE: Certainty system state
                    certaintyScore: Brains[asset].certaintyScore || 0,
                    oracleLocked: Brains[asset].oracleLocked || false,
                    oracleLockPrediction: Brains[asset].oracleLockPrediction || null,
                    manipulationScore: Brains[asset].manipulationScore || 0,
                    // PINNACLE EVOLUTION: Advanced state
                    certaintyVelocity: Brains[asset].certaintyVelocity || 0,
                    currentPhase: Brains[asset].currentPhase || 'GENESIS',
                    correlationBonus: Brains[asset].correlationBonus || 0,
                    inBlackout: Brains[asset].inBlackout || false
                };
            }
        });
    }

    const message = JSON.stringify(update);
    wsClients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            try {
                client.send(message);
            } catch (e) {
                console.log(`⚠️ WebSocket send error: ${e.message}`);
            }
        }
    });
}

// ==================== SOCKET.IO UI UPDATES ====================
// Emit updates to UI in the format expected by index.html
function emitUIUpdate() {
    try {
        if (!io || !tradeExecutor || typeof Brains === 'undefined' || !ASSETS) return;
        
        const bankroll = tradeExecutor.mode === 'PAPER' ? tradeExecutor.paperBalance : (tradeExecutor.cachedLiveBalance || 0);
        const assets = {};
        
        ASSETS.forEach(asset => {
            if (Brains[asset]) {
                const brain = Brains[asset];
                const stats = brain.stats || { wins: 0, losses: 0 };
                const streak = stats.wins > 0 ? stats.wins : (stats.losses > 0 ? -stats.losses : 0);
                
                // Determine state based on tier and prediction
                let state = 'OBSERVE';
                if (brain.tier === 'CONVICTION' || brain.tier === 'ADVISORY') {
                    state = brain.prediction === 'UP' ? 'STRIKE' : (brain.prediction === 'DOWN' ? 'HARVEST' : 'OBSERVE');
                }
                
                assets[asset] = {
                    streak: streak,
                    state: state,
                    lastSignal: brain.lastSignal ? {
                        side: brain.lastSignal.direction || brain.prediction,
                        entryPrice: brain.lastSignal.entryPrice || (currentMarkets[asset]?.yesPrice || 0),
                        status: brain.lastSignal.status || 'PENDING'
                    } : null,
                    tier: brain.tier || 'NONE',
                    confidence: brain.confidence || 0,
                    prediction: brain.prediction || 'WAIT'
                };
            }
        });
        
        io.emit('omega_update', {
            bankroll: bankroll,
            assets: assets,
            todayPnL: tradeExecutor.todayPnL || 0,
            mode: CONFIG.TRADE_MODE,
            timestamp: Date.now()
        });
    } catch (e) {
        // Silently fail - UI updates are not critical
        // console.log(`⚠️ UI update error: ${e.message}`);
    }
}

// Emit full /api/state payload over socket.io for real-time dashboards
function emitStateUpdate() {
    try {
        if (!io) return;
        io.emit('state_update', buildStateSnapshot());
    } catch (e) {
        // UI is non-critical
    }
}

// Broadcast every second for real-time updates
setInterval(broadcastUpdate, 1000);

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

// ==================== DEBUG EXPORT: CYCLE HISTORY STORAGE ====================
// Stores last 5 complete cycles of debugging data for each asset
let cycleDebugHistory = {};
ASSETS.forEach(asset => {
    cycleDebugHistory[asset] = []; // Array of cycle objects
});

// ==================== SUPREME MULTI-MODE TRADING CONFIG ====================
// 🔴 CONFIG_VERSION: Increment this when making changes to hardcoded settings!
// This ensures Redis cache is invalidated and new values are used.
const CONFIG_VERSION = 43;  // v43 CONSISTENCY: invalidate stale Redis settings when defaults change

// Code fingerprint for forensic consistency (ties debug exports to exact code/config)
const CODE_FINGERPRINT = (() => {
    let serverSha256 = null;
    try {
        const buf = fs.readFileSync(path.join(__dirname, 'server.js'));
        serverSha256 = crypto.createHash('sha256').update(buf).digest('hex');
    } catch (e) {
        // ignore (hash is optional)
    }

    const gitCommit =
        process.env.RENDER_GIT_COMMIT ||
        process.env.SOURCE_VERSION ||
        process.env.GIT_COMMIT ||
        null;

    return {
        configVersion: CONFIG_VERSION,
        gitCommit,
        serverSha256
    };
})();

const CONFIG = {
    // API Keys - .trim() removes any hidden newlines/spaces from env vars
    // CRITICAL: NO DEFAULTS - user MUST set these in .env
    POLYMARKET_API_KEY: (process.env.POLYMARKET_API_KEY || '').trim(),
    POLYMARKET_SECRET: (process.env.POLYMARKET_SECRET || '').trim(),
    POLYMARKET_PASSPHRASE: (process.env.POLYMARKET_PASSPHRASE || '').trim(),
    POLYMARKET_ADDRESS: (process.env.POLYMARKET_ADDRESS || '').trim(),
    POLYMARKET_PRIVATE_KEY: (process.env.POLYMARKET_PRIVATE_KEY || '').trim(),

    // Core Trading Settings
    TRADE_MODE: process.env.TRADE_MODE || 'PAPER',
    PAPER_BALANCE: parseFloat(process.env.PAPER_BALANCE || '10'),   // 🔴 FIXED: Default £10 (was 1000)
    LIVE_BALANCE: parseFloat(process.env.LIVE_BALANCE || '100'),     // Configurable live balance
    MAX_POSITION_SIZE: parseFloat(process.env.MAX_POSITION_SIZE || '0.20'),  // Default 20% max risk per trade (can be changed via settings/env)
    MAX_POSITIONS_PER_ASSET: 2,  // Max simultaneous positions per asset

    // ==================== MULTI-MODE SYSTEM ====================
    MULTI_MODE_ENABLED: true,    // Master switch for multi-mode operation
    // UI/ops metadata (does not affect trading unless you explicitly use it)
    ACTIVE_PRESET: process.env.ACTIVE_PRESET || 'CUSTOM',

    // MODE 1: ORACLE 🔮 - Final outcome prediction with near-certainty
    // 🏆 v39 ADAPTIVE STRATEGY: Real-time Regime Detection
    ORACLE: {
        enabled: true,
        aggression: 50,          // 🔮 0-100 scale
        minElapsedSeconds: 60,   // 1 min - catch VERY early
        minConsensus: 0.70,      // 70% model agreement
        minConfidence: 0.80,     // 80% entry threshold
        minEdge: 0,              // DISABLED - broken
        maxOdds: 0.90,           // 🎯 ATOMIC: 90¢ max (HIGH prices = 98.96% win rate!)
        minStability: 2,         // 2 ticks - fast lock

        // 🏆 v39 ADAPTIVE CONFIGURATION
        // The bot automatically switches regimes based on Confidence Volatility (StdDev)
        adaptiveModeEnabled: true,

        regimes: {
            // 🌊 CALM: Low Volatility (StdDev < 5%) -> AGGRESSIVE
            CALM: {
                sensitivity: "HIGH",
                smoothingWindow: 1,      // Fast reaction
                stopLoss: 0.30,          // Tight stop
                diamondTarget: 0.98,     // Max greed
                safetyTarget: 0.20       // Quick scalp if wrong
            },

            // 🌪️ VOLATILE: Normal (StdDev 5-15%) -> DEFENSIVE (v38 Standard)
            VOLATILE: {
                sensitivity: "MEDIUM",
                smoothingWindow: 3,      // Filter noise
                stopLoss: 0.40,          // Standard stop
                diamondTarget: 0.95,     // Standard target
                safetyTarget: 0.25       // Standard safety
            },

            // 🔥 CHAOS: Extreme (StdDev > 15%) -> SURVIVAL
            CHAOS: {
                sensitivity: "LOW",
                smoothingWindow: 5,      // Heavy filtering
                stopLoss: 0.50,          // Max room to breathe
                diamondTarget: 0.90,     // Lower expectations
                safetyTarget: 0.15       // Get out fast
            }
        },

        // DEFAULT VALUES (Used if adaptive mode off or initializing)
        stopLoss: 0.40,
        stopLossEnabled: true,
        earlyTakeProfitEnabled: true,
        dynamicExitEnabled: true,
        confidenceSmoothingWindow: 3,
        confidenceKeepThreshold: 0.80,
        diamondTarget: 0.95,
        safetyTarget: 0.25,

        hedgeEnabled: false,     // NO HEDGING
        hedgeRatio: 0.20,
        velocityMode: true       // Aggressive sizing for small accounts
    },

    // MODE 2: ARBITRAGE 📊 - Buy mispriced odds, sell when corrected
    // MOLECULAR: DISABLED - Focus on Oracle mode only for now
    ARBITRAGE: {
        enabled: false,          // 🔮 MOLECULAR: Disabled for focus
        minMispricing: 0.15,     // 15%+ difference between fair value and odds
        targetProfit: 0.50,      // Exit at 50% profit
        maxHoldTime: 600,        // Exit after 10 mins max
        stopLoss: 0.30           // Exit at 30% loss
    },

    // MODE 2B: ILLIQUIDITY GAP 💰 - Guaranteed profit when Yes+No < 100%
    // 🏆 APEX v24: ENABLED - TRUE ZERO VARIANCE (Layer 1)
    ILLIQUIDITY_GAP: {
        enabled: true,           // 🏆 APEX v24: TRUE ARBITRAGE - ZERO VARIANCE
        minGap: 0.03,            // 3% minimum gap (covers fees + profit)
        maxEntryTotal: 0.97      // Only enter if Yes+No <= 97%
    },

    // MODE 2C: DEATH BOUNCE 💀 - Buy ultra-cheap shares on overreaction
    // 🚨 VELOCITY v26: DISABLED - Stop-loss ordering bug caused -80% losses
    // Bug: TIME EXIT check came before STOP LOSS check, causing massive losses
    DEATH_BOUNCE: {
        enabled: false,          // 🚨 DISABLED - Loss machine until bugs fixed
        minPrice: 0.03,          // 3¢ minimum (below = probably stays dead)
        maxPrice: 0.12,          // 12¢ maximum (above = not "death" level)
        targetPrice: 0.18,       // Target 18¢ for exit (2-3x profit)
        minScore: 1.5            // Minimum R:R score to trigger
    },

    // MODE 3: SCALP 🎯 - Buy ultra-cheap, exit at 2-3x
    // MOLECULAR: DISABLED - Focus on Oracle mode only for now
    SCALP: {
        enabled: false,          // 🔮 MOLECULAR: Disabled for focus
        maxEntryPrice: 0.20,     // Only buy under 20¢
        targetMultiple: 2.0,     // Exit at 2x
        requireLean: true,       // Must lean (>55%) our direction
        exitBeforeEnd: 120       // Exit 2 mins before checkpoint
    },

    // MODE 4: UNCERTAINTY 🌊 - Trade volatility/reversion
    // MOLECULAR: DISABLED - Focus on Oracle mode only for now
    UNCERTAINTY: {
        enabled: false,          // 🔮 MOLECULAR: Disabled for focus
        extremeThreshold: 0.80,  // Entry when odds >80% or <20%
        volatilityMin: 0.02,     // Minimum ATR ratio
        targetReversion: 0.60,   // Exit when odds hit 60%/40%
        stopLoss: 0.25           // Exit at 25% loss
    },

    // MODE 5: MOMENTUM 🚀 - Ride strong mid-cycle trends
    // MOLECULAR: DISABLED - Focus on Oracle mode only for now
    MOMENTUM: {
        enabled: false,          // 🔮 MOLECULAR: Disabled for focus
        minElapsed: 300,         // Only after 5 mins
        breakoutThreshold: 0.03, // 3% price breakout
        minConsensus: 0.75,      // 75%+ model agreement
        exitOnReversal: true,    // Exit on first reversal sign
        exitBeforeEnd: 180       // Exit 3 mins before checkpoint
    },

    // Risk Management - 🏆 v33 FINAL ENDGAME (95%+ Win Rate, Zero Variance)
    RISK: {
        maxTotalExposure: 0.40,  // 🏆 v33: 40% max (was 50% - Kelly optimal)
        globalStopLoss: 0.30,    // 🏆 v33: 30% day max loss (was 40% - tighter)
        globalStopLossOverride: false,
        cooldownAfterLoss: 1800,            // 🏆 v33: 30 min cooldown (was 20 - more recovery)
        enableLossCooldown: true,
        noTradeDetection: true,  // Block genuinely random markets
        enableCircuitBreaker: true, // 🏆 v33: ON - halt on volatility spikes
        enableDivergenceBlocking: true, // 🏆 v33: ON - trust when aligned
        aggressiveSizingOnLosses: false, // 🏆 v33: OFF - reduce after losses

        // 🔮 ORACLE SAFEGUARDS
        maxConsecutiveLosses: 3,  // 🔴 FIX: Reduced from 5 to 3 (pause earlier)
        maxDailyLosses: 8,        // More trades allowed (from 5)
        autoReduceSizeOnDrawdown: false, // Maintain aggression
        withdrawalNotification: 1000,
        maxGlobalTradesPerCycle: 1, // 🛡️ v18 SINGLETON PROTOCOL: Only 1 trade globally per cycle - eliminates correlation wipeouts

        // 🔮 NEW: ORACLE-LEVEL FEATURES
        enablePositionPyramiding: false,  // 🛡️ v18: Disabled - no adding to positions in singleton mode
        firstMoveAdvantage: false,        // 🔴 UNBOUNDED FIX: Disabled (was true - <30s is noisy)
        supremeConfidenceMode: true      // Only trade 75%+ confidence
    },

    // ==================== TELEGRAM NOTIFICATIONS ====================
    TELEGRAM: {
        enabled: false,
        botToken: (process.env.TELEGRAM_BOT_TOKEN || '').trim(),
        chatId: (process.env.TELEGRAM_CHAT_ID || '').trim()
    },

    // PER-ASSET TRADING CONTROLS - 🏆 v30: SOL DISABLED (50% WR in backtest)
    ASSET_CONTROLS: {
        BTC: { enabled: true, maxTradesPerCycle: 1 },
        ETH: { enabled: true, maxTradesPerCycle: 1 },   // 100% WR in backtest!
        SOL: { enabled: false, maxTradesPerCycle: 1 },  // 🚫 v30: DISABLED - 50% WR kills profits
        XRP: { enabled: true, maxTradesPerCycle: 1 }
    }
};

// ==================== TELEGRAM NOTIFICATION HELPER ====================
async function sendTelegramNotification(message, silent = false) {
    if (!CONFIG.TELEGRAM.enabled || !CONFIG.TELEGRAM.botToken || !CONFIG.TELEGRAM.chatId) return;
    try {
        const url = `https://api.telegram.org/bot${CONFIG.TELEGRAM.botToken}/sendMessage`;
        await axios.post(url, {
            chat_id: CONFIG.TELEGRAM.chatId,
            text: message,
            parse_mode: 'HTML',
            disable_notification: silent
        }, { timeout: 5000 });
        log(`📱 Telegram notification sent`);
    } catch (e) {
        log(`⚠️ Telegram notification failed: ${e.message}`);
    }
}

// 📱 TELEGRAM: Styled notification builders
// Dashboard URL for quick access
const DASHBOARD_URL = process.env.RENDER_EXTERNAL_URL || 'https://polyprophet.onrender.com/';

function telegramTradeOpen(asset, direction, mode, entryPrice, size, stopLoss, target, market = null) {
    const emoji = direction === 'UP' ? '📈' : '📉';
    const modeEmoji = mode === 'ORACLE' ? '🔮' : mode === 'SCALP' ? '🎯' : mode === 'ARBITRAGE' ? '📊' : mode === 'MOMENTUM' ? '🚀' : '🌊';
    let msg = `${modeEmoji} <b>NEW ${mode} TRADE</b> ${emoji}\n`;
    msg += `━━━━━━━━━━━━━━━━━\n`;
    msg += `📍 <b>${asset}</b> ${direction}\n`;
    msg += `💰 Entry: <code>${(entryPrice * 100).toFixed(1)}¢</code>\n`;
    msg += `💵 Size: <code>$${size.toFixed(2)}</code>\n`;
    if (stopLoss) msg += `🛑 Stop: <code>${(stopLoss * 100).toFixed(1)}¢</code>\n`;
    if (target) msg += `🎯 Target: <code>${(target * 100).toFixed(1)}¢</code>\n`;
    msg += `━━━━━━━━━━━━━━━━━\n`;
    // Add clickable links
    if (market?.marketUrl) msg += `🔗 <a href="${market.marketUrl}">View on Polymarket</a>\n`;
    msg += `🖥️ <a href="${DASHBOARD_URL}">Open Dashboard</a>`;
    return msg;
}

function telegramTradeClose(asset, direction, mode, entryPrice, exitPrice, pnl, pnlPercent, reason, balance, market = null) {
    const won = pnl >= 0;
    const emoji = won ? '✅' : '❌';
    const modeEmoji = mode === 'ORACLE' ? '🔮' : mode === 'SCALP' ? '🎯' : mode === 'ARBITRAGE' ? '📊' : mode === 'MOMENTUM' ? '🚀' : '🌊';
    let msg = `${emoji} <b>${mode} ${direction} CLOSED</b> ${emoji}\n`;
    msg += `━━━━━━━━━━━━━━━━━\n`;
    msg += `📍 <b>${asset}</b>\n`;
    msg += `📊 Entry: <code>${(entryPrice * 100).toFixed(1)}¢</code> → Exit: <code>${(exitPrice * 100).toFixed(1)}¢</code>\n`;
    msg += `${won ? '💰' : '💸'} P/L: <b>${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)}</b> (${pnlPercent >= 0 ? '+' : ''}${pnlPercent.toFixed(1)}%)\n`;
    msg += `📋 Reason: ${reason}\n`;
    msg += `💼 Balance: <code>$${balance.toFixed(2)}</code>\n`;
    msg += `━━━━━━━━━━━━━━━━━\n`;
    // Add clickable links
    if (market?.marketUrl) msg += `🔗 <a href="${market.marketUrl}">View on Polymarket</a>\n`;
    msg += `🖥️ <a href="${DASHBOARD_URL}">Open Dashboard</a>`;
    return msg;
}

function telegramSystemAlert(title, message, emoji = '⚠️') {
    let msg = `${emoji} <b>${title}</b> ${emoji}\n`;
    msg += `━━━━━━━━━━━━━━━━━\n`;
    msg += `${message}\n`;
    msg += `━━━━━━━━━━━━━━━━━`;
    return msg;
}

function telegramServerStatus(status, details = '') {
    const emoji = status === 'ONLINE' ? '🟢' : status === 'OFFLINE' ? '🔴' : '🟡';
    let msg = `${emoji} <b>SERVER ${status}</b>\n`;
    msg += `━━━━━━━━━━━━━━━━━\n`;
    msg += `🕐 Time: ${new Date().toLocaleString()}\n`;
    if (details) msg += `📋 ${details}\n`;
    msg += `━━━━━━━━━━━━━━━━━`;
    return msg;
}

// ==================== ENHANCED TRADE EXECUTOR (Multi-Position) ====================
class TradeExecutor {
    constructor() {
        this.mode = CONFIG.TRADE_MODE;
        this.paperBalance = CONFIG.PAPER_BALANCE;
        this.startingBalance = CONFIG.PAPER_BALANCE;
        this.positions = {};           // { 'BTC_1': { mode, side, size, entry, time, target, stopLoss } }
        this.wallet = null;
        this.tradeHistory = [];
        // 🚀 PINNACLE v28: CRASH RECOVERY - Initialize recovery queues
        this.pendingSells = {};         // Failed sell orders awaiting retry
        this.redemptionQueue = [];      // Winning positions to claim
        this.recoveryQueue = [];        // Orphaned/crashed positions needing attention
        this.lastLossTime = 0;         // For cooldown tracking
        this.todayPnL = 0;             // Daily P/L tracking
        this.lastDayReset = Date.now(); // Track when we last reset daily P/L
        this.cachedLiveBalance = 0;    // Cached USDC balance for LIVE mode
        this.lastGoodBalance = 0;      // Last known successful balance (prevents $0 flash)
        this.lastBalanceFetch = 0;     // Timestamp of last balance fetch

        // 💰 GAS ESTIMATION & LOW BALANCE ALERTS
        this.cachedMATICBalance = 0;   // Cached MATIC/POL balance
        this.lastMATICFetch = 0;       // Timestamp of last MATIC fetch
        this.lastLowBalanceAlert = 0;  // Prevent alert spam (1 per hour)
        this.lastLowGasAlert = 0;      // Prevent gas alert spam (1 per hour)
        this.GAS_PER_TRADE = 0.005;    // Approximate MATIC cost per Polymarket trade
        this.LOW_GAS_THRESHOLD = 0.05; // Alert when MATIC below this (~10 trades)
        this.LOW_USDC_THRESHOLD = 5;   // Alert when USDC below this

        // 📊 CYCLE TRADE TRACKING - Max trades per cycle per asset
        this.cycleTradeCount = {};     // { 'BTC': 1, 'ETH': 0, ... }
        this.currentCycleStart = 0;    // Timestamp of current cycle start

        // 🔴 FIX #14: Track consecutive losses for cooldown trigger
        this.consecutiveLosses = 0;    // Resets on win, triggers cooldown after maxConsecutiveLosses

        // 🔒 GOD MODE: TRADE EXECUTION MUTEX - Prevent race conditions
        // Without this, two trades could pass balance checks simultaneously
        this.tradeMutex = false;        // Simple mutex lock for trade execution

        //  FIX #23: WARMUP PERIOD - Reduce risk on fresh startup
        // For first 2 cycles after startup, use reduced position sizes
        this.startupTime = Date.now();
        this.warmupCycles = 2;          // Number of cycles to stay in warmup mode
        this.warmupSizeMultiplier = 0.5; // Use 50% of normal size during warmup

        // 🦅 v20 DYNAMIC AGGRESSION: Hunter-Gatherer Protocol
        // Auto-switches between SNIPER (strict) and HUNTER (relaxed) based on market activity
        this.aggressionMode = 'SNIPER';     // Current mode: 'SNIPER' or 'HUNTER'
        this.lastTradeTime = Date.now();    // Track when last trade was executed
        this.autoAggressionEnabled = true;  // UI toggle for auto-switching
        this.hunterLossStreak = 0;          // Track losses while in HUNTER mode (resets on mode switch)
        this.DORMANCY_THRESHOLD_MS = 90 * 60 * 1000;  // 90 minutes = switch to HUNTER
        this.HUNTER_LOSS_LIMIT = 2;         // 2 losses in HUNTER mode = retreat to SNIPER

        // 🎯 GOLDEN MEAN: OBSERVE/HARVEST/STRIKE State Machine
        // - OBSERVE: Cooldown/learning mode (no trades, ≤5% probe sizes)
        // - HARVEST: Normal trading mode (standard sizes, EV-gated)
        // - STRIKE: Aggressive mode (larger sizes after verified edge/streak)
        this.tradingState = 'HARVEST';      // Current state: 'OBSERVE' | 'HARVEST' | 'STRIKE'
        this.stateEntryTime = Date.now();   // When we entered current state
        this.recentWinStreak = 0;           // Consecutive wins (for STRIKE upgrade)
        this.recentLossStreak = 0;          // Consecutive losses (for OBSERVE downgrade)
        this.STATE_THRESHOLDS = {
            observeToHarvest: 2,             // 2 cycles in OBSERVE before returning to HARVEST
            harvestToStrike: 3,              // 3 consecutive wins to enter STRIKE
            strikeToHarvest: 1,              // 1 loss exits STRIKE back to HARVEST
            harvestToObserve: 3,             // 3 consecutive losses enters OBSERVE
            observeMinMinutes: 15            // Minimum 15 mins in OBSERVE
        }

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

    // 🔒 Check if asset trading is enabled
    isAssetEnabled(asset) {
        return CONFIG.ASSET_CONTROLS?.[asset]?.enabled !== false;
    }

    // 📊 Get max trades per cycle for an asset
    getMaxTradesPerCycle(asset) {
        return CONFIG.ASSET_CONTROLS?.[asset]?.maxTradesPerCycle || 1;
    }

    // 📊 Get current cycle trade count for an asset
    getCycleTradeCount(asset) {
        // Check if we're in a new cycle
        const now = Math.floor(Date.now() / 1000);
        const cycleStart = now - (now % 900); // 15 min cycles
        if (cycleStart !== this.currentCycleStart) {
            this.cycleTradeCount = {}; // Reset counts for new cycle
            this.currentCycleStart = cycleStart;
        }
        return this.cycleTradeCount[asset] || 0;
    }

    // 📊 Increment cycle trade count for an asset
    incrementCycleTradeCount(asset) {
        this.getCycleTradeCount(asset); // Ensure cycle is current
        this.cycleTradeCount[asset] = (this.cycleTradeCount[asset] || 0) + 1;
    }

    // 📊 FIX #21: Get GLOBAL cycle trade count (all assets combined)
    getGlobalCycleTradeCount() {
        this.getCycleTradeCount('BTC'); // Ensure cycle is current
        return Object.values(this.cycleTradeCount).reduce((sum, count) => sum + count, 0);
    }

    // 🦅 v20 DYNAMIC AGGRESSION: Check and auto-switch between SNIPER/HUNTER modes
    checkDynamicAggression() {
        if (!this.autoAggressionEnabled) return;

        const timeSinceLastTrade = Date.now() - this.lastTradeTime;

        // SNIPER → HUNTER: If dormant for too long, relax thresholds
        if (this.aggressionMode === 'SNIPER' && timeSinceLastTrade > this.DORMANCY_THRESHOLD_MS) {
            this.setAggressionMode('HUNTER');
            log(`🔥 DYNAMIC AGGRESSION: Switching to HUNTER mode (dormant ${Math.round(timeSinceLastTrade / 60000)}min)`);
        }

        // HUNTER → SNIPER: If taking losses in aggressive mode, retreat to safety
        if (this.aggressionMode === 'HUNTER' && this.hunterLossStreak >= this.HUNTER_LOSS_LIMIT) {
            this.setAggressionMode('SNIPER');
            log(`🛡️ DYNAMIC AGGRESSION: Switching to SNIPER mode (${this.hunterLossStreak} losses in HUNTER)`);
            this.hunterLossStreak = 0; // Reset counter
        }
    }

    // 🦅 v20: Set aggression mode (also callable from UI)
    setAggressionMode(mode) {
        const validModes = ['SNIPER', 'HUNTER'];
        if (!validModes.includes(mode)) return;

        const oldMode = this.aggressionMode;
        this.aggressionMode = mode;

        // Reset hunter loss streak when switching modes
        if (mode === 'HUNTER') {
            this.hunterLossStreak = 0;
        }

        log(`🦅 AGGRESSION MODE: ${oldMode} → ${mode}`);
    }

    // 🦅 v21 UNDERDOG: Get current mode-adjusted maxOdds
    // SNIPER = strict (0.48), HUNTER = fair value (0.50) - NEVER above breakeven
    // 🎯 ADAPTIVE THRESHOLD: Expands by 10¢ when no trades in 2+ hours, tightens when trades resume
    getEffectiveMaxOdds() {
        let baseMaxOdds = CONFIG.ORACLE.maxOdds;
        
        // Mode-based adjustment
        if (this.aggressionMode === 'HUNTER') {
            baseMaxOdds = Math.min(baseMaxOdds + 0.02, 0.50); // 🛡️ v21: Cap at 50¢ (breakeven)
        }
        
        // 🎯 ADAPTIVE THRESHOLD EXPANSION: Expand by 10¢ if no trades in 2+ hours
        const timeSinceLastTrade = Date.now() - this.lastTradeTime;
        const hoursSinceLastTrade = timeSinceLastTrade / (1000 * 60 * 60);
        const MAX_EXPANSION = 0.90; // Cap at 90¢ maximum
        
        if (hoursSinceLastTrade >= 2) {
            // Expand by 10¢ (0.10) for every 2 hours of dormancy
            const expansionHours = Math.floor(hoursSinceLastTrade / 2);
            const expansion = Math.min(expansionHours * 0.10, MAX_EXPANSION - baseMaxOdds);
            const expandedOdds = baseMaxOdds + expansion;
            
            if (expansion > 0) {
                log(`🎯 ADAPTIVE THRESHOLD: Expanded maxOdds from ${(baseMaxOdds * 100).toFixed(1)}¢ to ${(expandedOdds * 100).toFixed(1)}¢ (no trades in ${hoursSinceLastTrade.toFixed(1)} hours)`);
            }
            
            return Math.min(expandedOdds, MAX_EXPANSION);
        }
        
        // If trades are happening regularly, use base (or slightly tightened if recent trades)
        // Tighten slightly if we've had trades in the last hour (more selective)
        if (hoursSinceLastTrade < 1 && this.lastTradeTime > 0) {
            // Recent trades = tighten by 2¢ to maintain quality
            return Math.max(baseMaxOdds - 0.02, 0.20); // Don't go below 20¢
        }
        
        return baseMaxOdds;
    }

    // 🦅 v21 UNDERDOG: Get current mode-adjusted requireTrending
    // SNIPER = strict (true), HUNTER = relaxed (false) to snipe choppy dips
    getEffectiveRequireTrending() {
        if (this.aggressionMode === 'HUNTER') {
            return false; // 🦅 v21: Allow choppy markets in HUNTER to find cheap entries
        }
        return CONFIG.ORACLE.requireTrending; // Default: true in SNIPER
    }

    // 🦅 v21: Get current mode-adjusted minStability
    // SNIPER = strict (4), HUNTER = relaxed (3)
    getEffectiveMinStability() {
        if (this.aggressionMode === 'HUNTER') {
            return Math.max(CONFIG.ORACLE.minStability - 1, 2); // Min 2 in HUNTER
        }
        return CONFIG.ORACLE.minStability; // Default in SNIPER
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

    // 🎯 GOLDEN MEAN: State Machine Management
    // Updates trading state based on trade outcomes
    updateTradingState(outcome) {
        const prevState = this.tradingState;
        
        if (outcome === 'WIN') {
            this.recentWinStreak++;
            this.recentLossStreak = 0;
            
            // Check for STRIKE upgrade
            if (this.tradingState === 'HARVEST' && this.recentWinStreak >= this.STATE_THRESHOLDS.harvestToStrike) {
                this.tradingState = 'STRIKE';
                this.stateEntryTime = Date.now();
                log(`🎯 STATE: HARVEST → STRIKE (${this.recentWinStreak} consecutive wins)`);
            }
            // Check for OBSERVE → HARVEST
            else if (this.tradingState === 'OBSERVE') {
                const minutesInObserve = (Date.now() - this.stateEntryTime) / 60000;
                if (minutesInObserve >= this.STATE_THRESHOLDS.observeMinMinutes) {
                    this.tradingState = 'HARVEST';
                    this.stateEntryTime = Date.now();
                    this.recentWinStreak = 0;
                    log(`🎯 STATE: OBSERVE → HARVEST (win after ${minutesInObserve.toFixed(0)}min cooldown)`);
                }
            }
        } else if (outcome === 'LOSS') {
            this.recentLossStreak++;
            this.recentWinStreak = 0;
            
            // STRIKE → HARVEST on any loss
            if (this.tradingState === 'STRIKE' && this.recentLossStreak >= this.STATE_THRESHOLDS.strikeToHarvest) {
                this.tradingState = 'HARVEST';
                this.stateEntryTime = Date.now();
                log(`🎯 STATE: STRIKE → HARVEST (loss while in STRIKE)`);
            }
            // HARVEST → OBSERVE on loss streak
            else if (this.tradingState === 'HARVEST' && this.recentLossStreak >= this.STATE_THRESHOLDS.harvestToObserve) {
                this.tradingState = 'OBSERVE';
                this.stateEntryTime = Date.now();
                log(`🎯 STATE: HARVEST → OBSERVE (${this.recentLossStreak} consecutive losses)`);
            }
        }
        
        if (prevState !== this.tradingState) {
            log(`🎯 GOLDEN MEAN: State changed ${prevState} → ${this.tradingState}`);
        }
    }
    
    // Get position size multiplier based on trading state
    getStateSizeMultiplier() {
        switch (this.tradingState) {
            case 'OBSERVE':
                return 0.25;  // 25% of normal size (probe trades only)
            case 'HARVEST':
                return 1.0;   // 100% normal size
            case 'STRIKE':
                return 1.5;   // 150% of normal size (aggressive after verified edge)
            default:
                return 1.0;
        }
    }
    
    // Check if trading is allowed in current state
    canTradeInCurrentState() {
        if (this.tradingState === 'OBSERVE') {
            const minutesInObserve = (Date.now() - this.stateEntryTime) / 60000;
            // Allow small probe trades in OBSERVE after minimum time
            if (minutesInObserve < this.STATE_THRESHOLDS.observeMinMinutes) {
                return { allowed: false, reason: `OBSERVE cooldown: ${(this.STATE_THRESHOLDS.observeMinMinutes - minutesInObserve).toFixed(0)}min remaining` };
            }
            return { allowed: true, sizeMultiplier: 0.25, reason: 'OBSERVE: probe trades only' };
        }
        return { allowed: true, sizeMultiplier: this.getStateSizeMultiplier() };
    }

    // Refresh cached LIVE balance (call every 30s or before trades)
    // NOTE: Refreshes regardless of mode - user wants to see wallet balance even in PAPER mode
    async refreshLiveBalance() {
        if (!this.wallet) return;

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

    // 💰 Refresh cached MATIC balance (for gas estimation)
    // NOTE: Refreshes regardless of mode - user wants to see wallet balance even in PAPER mode
    async refreshMATICBalance() {
        if (!this.wallet) return;

        // Only refresh if cache is older than 60 seconds
        const cacheValid = Date.now() - this.lastMATICFetch < 60000 && this.cachedMATICBalance > 0;
        if (cacheValid) return;

        try {
            const result = await this.getMATICBalance();
            if (result.success && result.balance !== undefined) {
                this.cachedMATICBalance = result.balance;
                this.lastMATICFetch = Date.now();
                log(`⛽ MATIC balance updated: ${this.cachedMATICBalance.toFixed(4)} POL`);
            }
        } catch (e) {
            log(`⚠️ MATIC refresh failed: ${e.message}`);
        }
    }

    // 📊 Calculate estimated trades remaining based on gas
    // Always returns cached values - Infinity means wallet not loaded
    getEstimatedTradesRemaining() {
        if (!this.wallet) {
            return { gas: Infinity, usdc: Infinity };
        }
        const gasTradesRemaining = this.cachedMATICBalance > 0
            ? Math.floor(this.cachedMATICBalance / this.GAS_PER_TRADE)
            : 0;
        const usdcTradesRemaining = this.cachedLiveBalance > 0
            ? Math.floor(this.cachedLiveBalance / 1.10) // Min trade size is $1.10
            : 0;
        return { gas: gasTradesRemaining, usdc: usdcTradesRemaining };
    }

    // 🚨 Check for low balances and send alerts (call periodically)
    // NOTE: Always monitors wallet, but only sends alerts in LIVE mode
    async checkLowBalances() {
        if (!this.wallet) return;

        await this.refreshLiveBalance();
        await this.refreshMATICBalance();

        // Only send alerts if in LIVE mode (don't spam during paper testing)
        if (this.mode !== 'LIVE') return;

        const now = Date.now();
        const ONE_HOUR = 60 * 60 * 1000;

        // Check low USDC
        if (this.cachedLiveBalance < this.LOW_USDC_THRESHOLD &&
            this.cachedLiveBalance > 0 &&
            (now - this.lastLowBalanceAlert) > ONE_HOUR) {

            this.lastLowBalanceAlert = now;
            const tradesLeft = this.getEstimatedTradesRemaining();
            log(`🚨 LOW USDC BALANCE: $${this.cachedLiveBalance.toFixed(2)} (~${tradesLeft.usdc} trades remaining)`);

            sendTelegramNotification(telegramSystemAlert('⚠️ LOW USDC BALANCE',
                `Balance: $${this.cachedLiveBalance.toFixed(2)}\nEstimated Trades Left: ${tradesLeft.usdc}\n\nDeposit more USDC to continue trading.`
            ));
        }

        // Check low MATIC (gas)
        if (this.cachedMATICBalance < this.LOW_GAS_THRESHOLD &&
            this.cachedMATICBalance > 0 &&
            (now - this.lastLowGasAlert) > ONE_HOUR) {

            this.lastLowGasAlert = now;
            const tradesLeft = this.getEstimatedTradesRemaining();
            log(`⛽ LOW GAS BALANCE: ${this.cachedMATICBalance.toFixed(4)} MATIC (~${tradesLeft.gas} trades remaining)`);

            sendTelegramNotification(telegramSystemAlert('⛽ LOW GAS BALANCE',
                `MATIC/POL: ${this.cachedMATICBalance.toFixed(4)}\nEstimated Trades Left: ${tradesLeft.gas}\n\nDeposit more MATIC/POL for gas fees.`
            ));
        }

        // Critical: Out of money entirely
        if (this.cachedLiveBalance <= 0 && (now - this.lastLowBalanceAlert) > ONE_HOUR) {
            this.lastLowBalanceAlert = now;
            log(`🚫 OUT OF USDC: Trading halted!`);
            sendTelegramNotification(telegramSystemAlert('🚫 OUT OF USDC',
                `Your USDC balance is $0.\nTrading is halted until you deposit funds.`
            ));
        }

        if (this.cachedMATICBalance <= 0 && (now - this.lastLowGasAlert) > ONE_HOUR) {
            this.lastLowGasAlert = now;
            log(`🚫 OUT OF GAS: Trading halted!`);
            sendTelegramNotification(telegramSystemAlert('🚫 OUT OF GAS',
                `Your MATIC/POL balance is 0.\nTrading is halted - no gas for transactions.`
            ));
        }

        // 🔄 RESET ALERTS: If balances recovered, allow new alerts after 1 hour
        // This prevents "alert forever" after user funds the wallet
        if (this.cachedLiveBalance >= this.LOW_USDC_THRESHOLD * 2) {
            this.lastLowBalanceAlert = 0; // Reset - can alert again if drops
        }
        if (this.cachedMATICBalance >= this.LOW_GAS_THRESHOLD * 2) {
            this.lastLowGasAlert = 0; // Reset - can alert again if drops
        }
    }

    // ENTRY: Execute a trade for any mode
    async executeTrade(asset, direction, mode, confidence, entryPrice, market, options = {}) {
        log(`🔍 executeTrade called: ${asset} ${direction} ${mode} @ ${(entryPrice * 100).toFixed(1)}¢`, asset);

        // ==================== 🎯 GOLDEN MEAN: EV + LIQUIDITY GUARDS ====================
        // These checks ensure we only trade when Expected Value is positive after fees
        // and liquidity is sufficient to execute without excessive slippage.
        
        // 💰 EV CALCULATION: Account for ~2% round-trip fees on Polymarket
        const POLYMARKET_FEE_PCT = 0.02; // 2% round-trip (buy + sell)
        const SLIPPAGE_ASSUMPTION = 0.01; // 1% estimated slippage
        const TOTAL_FRICTION = POLYMARKET_FEE_PCT + SLIPPAGE_ASSUMPTION; // 3% total cost
        
        if (mode === 'ORACLE' && direction !== 'BOTH' && entryPrice > 0) {
            // EV = (P_win * Profit) - (P_lose * Loss) - Friction
            // For binary: Profit = (1 - entryPrice) / entryPrice, Loss = 1 (total stake)
            // Simplified: EV_after_fees = confidence * (1/entryPrice - 1) - (1 - confidence) - TOTAL_FRICTION
            const rawProfit = (1 - entryPrice) / entryPrice; // Win: get $1 back, paid entryPrice
            const expectedProfit = confidence * rawProfit;
            const expectedLoss = (1 - confidence) * 1; // Lose full stake
            const evBeforeFees = expectedProfit - expectedLoss;
            const evAfterFees = evBeforeFees - TOTAL_FRICTION;
            
            if (evAfterFees <= 0) {
                log(`📉 EV GUARD: EV after fees = ${(evAfterFees * 100).toFixed(2)}% (conf: ${(confidence * 100).toFixed(1)}%, price: ${(entryPrice * 100).toFixed(1)}¢) - BLOCKED`, asset);
                return { success: false, error: `Negative EV after fees: ${(evAfterFees * 100).toFixed(2)}%` };
            }
            log(`📈 EV CHECK: EV after fees = +${(evAfterFees * 100).toFixed(2)}% ✓`, asset);
        }
        
        // 📊 SPREAD/LIQUIDITY GUARD: Reject if bid-ask spread is too wide
        const MAX_SPREAD_PCT = 0.15; // 15% max spread (YES + NO should sum to ~100%)
        if (market && market.yesPrice && market.noPrice) {
            const spreadDeficit = 1 - (market.yesPrice + market.noPrice);
            // A "deficit" > 0 means illiquidity gap (YES 40 + NO 50 = 90, gap = 10)
            // A "surplus" < 0 means spread (YES 55 + NO 55 = 110, spread = 10)
            const effectiveSpread = Math.abs(spreadDeficit);
            
            if (effectiveSpread > MAX_SPREAD_PCT && mode !== 'ILLIQUIDITY') {
                log(`💧 LIQUIDITY GUARD: Spread ${(effectiveSpread * 100).toFixed(1)}% > max ${(MAX_SPREAD_PCT * 100).toFixed(0)}% - BLOCKED`, asset);
                return { success: false, error: `Spread too wide: ${(effectiveSpread * 100).toFixed(1)}%` };
            }
        }
        // ==================== END GOLDEN MEAN GUARDS ====================

        // 🔒 GOD MODE: MUTEX LOCK - Prevent race conditions
        // Wait for any concurrent trade execution to complete (max 5s timeout)
        const mutexTimeout = 5000;
        const mutexStart = Date.now();
        while (this.tradeMutex) {
            if (Date.now() - mutexStart > mutexTimeout) {
                log(`⚠️ TRADE BLOCKED: Mutex timeout after ${mutexTimeout}ms`, asset);
                return { success: false, error: 'Trade execution mutex timeout - concurrent trade blocking' };
            }
            await new Promise(r => setTimeout(r, 50)); // Wait 50ms between checks
        }
        this.tradeMutex = true; // Acquire lock

        // CRITICAL: All trade logic must be in try/finally to ensure mutex release
        try {

            if (!market) {
                log(`❌ TRADE BLOCKED: No market data for ${asset}`, asset);
                return { success: false, error: 'No market data available' };
            }

            if (!market.tokenIds) {
                log(`❌ TRADE BLOCKED: No token IDs for ${asset} market`, asset);
                return { success: false, error: 'No token IDs - market not tradeable yet' };
            }

            // ==================== 💰 TRUE ARBITRAGE (ILLIQUIDITY GAP) ====================
            // Special paired trade: buy BOTH YES + NO when YES_ASK + NO_ASK < 1.0.
            // Must bypass the single-direction guard, because direction='BOTH' is valid ONLY here.
            if (mode === 'ILLIQUIDITY' && direction === 'BOTH') {
                return await this.executeIlliquidityGapPair(asset, market);
            }

            // ⚠️ CRITICAL SAFEGUARD: DIRECTION MUST BE UP OR DOWN
            // This is the FINAL GUARD - catches any bugs where invalid direction slips through
            if (direction !== 'UP' && direction !== 'DOWN') {
                log(`🚨 CRITICAL BLOCK: Invalid direction '${direction}' - ONLY UP/DOWN ALLOWED`, asset);
                return { success: false, error: `Invalid direction: ${direction}. Must be UP or DOWN.` };
            }

            // 🔴 FORENSIC FIX: ENTRY PRICE GUARD - Prevent division by zero
            // shares = size / entryPrice - if entryPrice is 0, shares = Infinity = catastrophic P&L
            if (!entryPrice || entryPrice <= 0) {
                log(`🚨 CRITICAL BLOCK: Invalid entry price ${entryPrice} - MUST BE > 0`, asset);
                return { success: false, error: `Invalid entry price: ${entryPrice}. Must be > 0.` };
            }

            // 🔴 UNBOUNDED FIX #11: HARD maxOdds check - FINAL GUARD against race conditions
            // This check cannot be bypassed by market movements between ORACLE check and execution
            if (mode === 'ORACLE' && entryPrice > CONFIG.ORACLE.maxOdds) {
                log(`🚫 HARD BLOCK: Entry price ${(entryPrice * 100).toFixed(1)}¢ > maxOdds ${(CONFIG.ORACLE.maxOdds * 100).toFixed(1)}¢ - NO VALUE BETTING`, asset);
                return { success: false, error: `Entry price ${(entryPrice * 100).toFixed(1)}¢ exceeds maxOdds limit` };
            }

            // 🏆 v30 CRITICAL FIX: HARD minConfidence check - MUST be enforced here!
            // Bug: minConfidence was set to 0.80 but never checked - trades at 28% were executing!
            if (mode === 'ORACLE' && confidence < CONFIG.ORACLE.minConfidence) {
                log(`🚫 CONFIDENCE BLOCK: Trade confidence ${(confidence * 100).toFixed(1)}% < minConfidence ${(CONFIG.ORACLE.minConfidence * 100).toFixed(1)}% - BLOCKED`, asset);
                return { success: false, error: `Confidence ${(confidence * 100).toFixed(1)}% below ${(CONFIG.ORACLE.minConfidence * 100).toFixed(1)}% threshold` };
            }

            // 🏆 v32 CRITICAL: MINIMUM BALANCE CHECK - User requested $2 minimum
            const MIN_TRADING_BALANCE = 2.00;
            if (this.paperBalance < MIN_TRADING_BALANCE) {
                log(`🚫 BALANCE TOO LOW: $${this.paperBalance.toFixed(2)} < minimum $${MIN_TRADING_BALANCE} - BLOCKED`, asset);
                return { success: false, error: `Balance $${this.paperBalance.toFixed(2)} below minimum $${MIN_TRADING_BALANCE}` };
            }

            // 🔴 BUG FIX: DOUBLE CHECK - Re-fetch CURRENT market price and verify it hasn't moved above maxOdds
            // This catches race conditions where market moved between ORACLE check and trade execution
            if (mode === 'ORACLE' && market) {
                const tokenType = direction === 'UP' ? 'YES' : 'NO';
                const currentRealPrice = tokenType === 'YES' ? market.yesPrice : market.noPrice;
                if (currentRealPrice && currentRealPrice > CONFIG.ORACLE.maxOdds) {
                    log(`🚫 REAL-TIME BLOCK: Current market price ${(currentRealPrice * 100).toFixed(1)}¢ > maxOdds ${(CONFIG.ORACLE.maxOdds * 100).toFixed(1)}¢ (passed: ${(entryPrice * 100).toFixed(1)}¢)`, asset);
                    return { success: false, error: `Current price ${(currentRealPrice * 100).toFixed(1)}¢ exceeds maxOdds - race condition blocked` };
                }
                // Use the HIGHER of passed vs current to be conservative
                if (currentRealPrice && currentRealPrice > entryPrice) {
                    log(`⚠️ PRICE MOVED: Using actual price ${(currentRealPrice * 100).toFixed(1)}¢ instead of passed ${(entryPrice * 100).toFixed(1)}¢`, asset);
                    entryPrice = currentRealPrice;
                }
            }

            // 🔒 ASSET TRADING ENABLED CHECK
            if (!this.isAssetEnabled(asset)) {
                log(`⏸️ TRADE BLOCKED: Trading disabled for ${asset}`, asset);
                return { success: false, error: `Trading disabled for ${asset}` };
            }

            // 🎯 GOLDEN MEAN: STATE MACHINE CHECK
            const stateCheck = this.canTradeInCurrentState();
            if (!stateCheck.allowed) {
                log(`⏸️ STATE BLOCKED: ${stateCheck.reason}`, asset);
                return { success: false, error: `Trading state: ${stateCheck.reason}` };
            }
            // Store multiplier for position sizing
            options.stateMultiplier = stateCheck.sizeMultiplier || 1.0;
            if (stateCheck.sizeMultiplier && stateCheck.sizeMultiplier !== 1.0) {
                log(`🎯 STATE: ${this.tradingState} - size multiplier ${stateCheck.sizeMultiplier}x`, asset);
            }

            // 📊 MAX TRADES PER CYCLE CHECK (per asset)
            const cycleTradeCount = this.getCycleTradeCount(asset);
            const maxTrades = this.getMaxTradesPerCycle(asset);
            if (cycleTradeCount >= maxTrades) {
                log(`⚠️ TRADE BLOCKED: Max trades (${maxTrades}) reached for ${asset} this cycle`, asset);
                return { success: false, error: `Max trades (${maxTrades}) per cycle reached for ${asset}` };
            }

            // 📊 FIX #21: GLOBAL MAX TRADES PER CYCLE CHECK (all assets combined)
            // Prevents correlated losses when multiple assets move against predictions simultaneously
            const globalCycleCount = this.getGlobalCycleTradeCount();
            const maxGlobalTrades = CONFIG.RISK.maxGlobalTradesPerCycle || 4;
            if (globalCycleCount >= maxGlobalTrades) {
                log(`⚠️ TRADE BLOCKED: Global max trades (${maxGlobalTrades}) reached across all assets this cycle`, asset);
                return { success: false, error: `Global max trades (${maxGlobalTrades}) per cycle reached` };
            }

            // ENTRY PRICE GUARD: REMOVED - Bot learns from all trades, even at extreme prices
            // The bot's learning loop will naturally penalize bad patterns
            // User requested: allow 2¢-99¢ trades if confident

            // 🔴 FIX: LOSS COOLDOWN CHECK - Pause 1 hour after 3 consecutive losses
            if (CONFIG.RISK.enableLossCooldown && this.isInCooldown()) {
                const remainingCooldown = Math.ceil((CONFIG.RISK.cooldownAfterLoss * 1000 - (Date.now() - this.lastLossTime)) / 1000);
                log(`⏳ TRADE BLOCKED: In cooldown for ${remainingCooldown}s after consecutive losses`, asset);
                return { success: false, error: `In cooldown for ${remainingCooldown}s after loss streak` };
            }

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
                // Cap position size by configured max fraction of bankroll (safety)
                // NOTE: even with high accuracy, binary outcomes can produce large drawdowns.
                const MAX_FRACTION = Math.max(0.01, Math.min(CONFIG.MAX_POSITION_SIZE || 0.20, 0.50)); // hard-cap at 50%

                // Calculate base percentage
                let basePct;
                switch (mode) {
                    case 'ORACLE':
                        // 🚀 v37 ULTRA-AGGRESSIVE: Based on Kelly Matrix analysis
                        // $5→$100 path: 70% sizing @ 90% WR = only 5-6 trades needed!
                        // Mathematical basis: See uploaded chart (70% row, 1-2 Loss column)
                        const tradeTier = options.tier || 'ADVISORY';
                        const isVelocityMode = CONFIG.ORACLE.velocityMode && bankroll < 200; // $200 threshold

                        if (tradeTier === 'CONVICTION') {
                            basePct = MAX_FRACTION; // full allocation up to configured max
                            log(`💎 CONVICTION sizing: ${(basePct * 100).toFixed(0)}% of bankroll cap`, asset);
                            } else {
                            basePct = Math.max(0.01, MAX_FRACTION * 0.8);
                            log(`📊 ADVISORY sizing: ${(basePct * 100).toFixed(0)}% of bankroll cap`, asset);
                        }
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

                //  FIX #23: WARMUP PERIOD - Reduce size for first 2 cycles after startup
                const elapsedSinceStartup = Date.now() - this.startupTime;
                const warmupDuration = this.warmupCycles * INTERVAL_SECONDS * 1000;
                if (elapsedSinceStartup < warmupDuration) {
                    size = size * this.warmupSizeMultiplier;
                    log(` WARMUP MODE: Size reduced to ${(this.warmupSizeMultiplier * 100).toFixed(0)}% (${size.toFixed(2)})`, asset);
                }

                // 🎯 GOLDEN MEAN: Apply state machine size multiplier
                if (options.stateMultiplier && options.stateMultiplier !== 1.0) {
                    const originalSize = size;
                    size = size * options.stateMultiplier;
                    log(`🎯 STATE SIZING: ${this.tradingState} mode - ${(options.stateMultiplier * 100).toFixed(0)}% (${originalSize.toFixed(2)} → ${size.toFixed(2)})`, asset);
                }

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
                    // 🛡️ ORACLE STOP LOSS: Optional emergency protection
                    if (CONFIG.ORACLE.stopLossEnabled && CONFIG.ORACLE.stopLoss > 0) {
                        stopLoss = entryPrice * (1 - CONFIG.ORACLE.stopLoss);
                        log(`🛡️ ORACLE STOP LOSS SET: ${(stopLoss * 100).toFixed(1)}¢ (${(CONFIG.ORACLE.stopLoss * 100).toFixed(0)}% protection)`, asset);
                    } else {
                        stopLoss = null; // Pure hold-to-resolution (default)
                    }
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

            // 📱 TELEGRAM NOTIFICATION: Trade opened (with market links)
            sendTelegramNotification(telegramTradeOpen(asset, direction, mode, entryPrice, size, stopLoss, target, market));


            if (this.mode === 'PAPER') {
                const balanceBefore = this.paperBalance;

                // ==================== 🏆 APEX v24: HEDGED ORACLE (Layer 3) ====================
                // If hedging is enabled for ORACLE trades, split position into main + hedge
                const shouldHedge = mode === 'ORACLE' && CONFIG.ORACLE.hedgeEnabled && CONFIG.ORACLE.hedgeRatio > 0;

                if (shouldHedge) {
                    // Calculate split sizes
                    const hedgeRatio = CONFIG.ORACLE.hedgeRatio || 0.20;
                    const mainSize = size * (1 - hedgeRatio);
                    const hedgeSize = size * hedgeRatio;

                    // Determine hedge direction and prices
                    const hedgeDirection = direction === 'UP' ? 'DOWN' : 'UP';
                    const hedgeTokenType = hedgeDirection === 'UP' ? 'YES' : 'NO';
                    const hedgePrice = hedgeDirection === 'UP' ? market.yesPrice : market.noPrice;

                    // Deduct total from balance
                    this.paperBalance -= size;

                    // ---- MAIN POSITION ----
                    const now = Math.floor(Date.now() / 1000);
                    const cycleStart = now - (now % INTERVAL_SECONDS);
                    const cycleElapsed = now - cycleStart;

                    const mainPositionId = `${asset}_${Date.now()}`;
                    this.positions[mainPositionId] = {
                        asset,
                        mode: 'ORACLE',
                        side: direction,
                        tokenType,
                        size: mainSize,
                        entry: entryPrice,
                        time: Date.now(),
                        target,
                        stopLoss: null, // No stop loss needed - hedge provides protection
                        shares: mainSize / entryPrice,
                        isHedged: true,
                        hedgeId: null, // Will be set below
                        // v32: DIAGNOSTIC FIELDS
                        entryConfidence: confidence,
                        configVersion: CONFIG_VERSION,
                        cycleElapsed: cycleElapsed
                    };

                    // ---- HEDGE POSITION ----
                    const hedgePositionId = `${asset}_HEDGE_${Date.now()}`;
                    this.positions[hedgePositionId] = {
                        asset,
                        mode: 'HEDGE',
                        side: hedgeDirection,
                        tokenType: hedgeTokenType,
                        size: hedgeSize,
                        entry: hedgePrice,
                        time: Date.now(),
                        target: null,
                        stopLoss: null,
                        shares: hedgeSize / hedgePrice,
                        isHedge: true,
                        mainId: mainPositionId
                    };

                    // Link main to hedge
                    this.positions[mainPositionId].hedgeId = hedgePositionId;

                    // Record both in trade history
                    this.tradeHistory.push({
                        id: mainPositionId,
                        asset,
                        mode: 'ORACLE',
                        side: direction,
                        entry: entryPrice,
                        size: mainSize,
                        time: Date.now(),
                        status: 'OPEN',
                        isHedged: true,
                        // v37+: DIAGNOSTIC FIELDS for forensics / backtests
                        entryConfidence: confidence,
                        configVersion: CONFIG_VERSION,
                        cycleElapsed: cycleElapsed,
                        tier: options.tier || 'UNKNOWN'
                    });

                    this.tradeHistory.push({
                        id: hedgePositionId,
                        asset,
                        mode: 'HEDGE',
                        side: hedgeDirection,
                        entry: hedgePrice,
                        size: hedgeSize,
                        time: Date.now(),
                        status: 'OPEN',
                        isHedge: true,
                        // v37+: keep same forensic fields so audits can attribute behaviour
                        entryConfidence: confidence,
                        configVersion: CONFIG_VERSION,
                        cycleElapsed: cycleElapsed,
                        tier: options.tier || 'UNKNOWN'
                    });

                    // PINNACLE: Prevent memory leak
                    if (this.tradeHistory.length > 1000) this.tradeHistory.shift();

                    log(`🏆 APEX HEDGED ORACLE: Main ${direction} $${mainSize.toFixed(2)} @ ${(entryPrice * 100).toFixed(1)}¢`, asset);
                    log(`🛡️ HEDGE: ${hedgeDirection} $${hedgeSize.toFixed(2)} @ ${(hedgePrice * 100).toFixed(1)}¢ (${(hedgeRatio * 100).toFixed(0)}% protection)`, asset);
                    log(`💰 Balance: $${balanceBefore.toFixed(2)} → $${this.paperBalance.toFixed(2)} (-$${size.toFixed(2)} total)`, asset);

                    // 📊 Track cycle trade count
                    this.incrementCycleTradeCount(asset);

                    return { success: true, positionId: mainPositionId, hedgeId: hedgePositionId, mode: 'PAPER', hedged: true };
                }

                // ---- STANDARD (Non-Hedged) POSITION ----
                const now = Math.floor(Date.now() / 1000);
                const cycleStart = now - (now % INTERVAL_SECONDS);
                const cycleElapsed = now - cycleStart;

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
                    shares: size / entryPrice,
                    // v32: DIAGNOSTIC FIELDS
                    entryConfidence: confidence,
                    configVersion: CONFIG_VERSION,
                    cycleElapsed: cycleElapsed
                };

                this.tradeHistory.push({
                    id: positionId,
                    asset,
                    mode,
                    side: direction,
                    entry: entryPrice,
                    size,
                    time: Date.now(),
                    status: 'OPEN',
                    // v37: DIAGNOSTIC FIELDS for forensics
                    entryConfidence: confidence,
                    configVersion: CONFIG_VERSION,
                    cycleElapsed: cycleElapsed,
                    tier: options.tier || 'UNKNOWN'
                });

                // PINNACLE: Prevent memory leak - keep max 1000 trades in history
                if (this.tradeHistory.length > 1000) this.tradeHistory.shift();

                log(`📝 PAPER FILL: Bought ${(size / entryPrice).toFixed(1)} shares @ ${(entryPrice * 100).toFixed(1)}¢`, asset);
                log(`💰 Balance: $${balanceBefore.toFixed(2)} → $${this.paperBalance.toFixed(2)} (-$${size.toFixed(2)})`, asset);

                // 📊 Track cycle trade count
                this.incrementCycleTradeCount(asset);

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

                        // PINNACLE: Prevent memory leak - keep max 1000 trades in history
                        if (this.tradeHistory.length > 1000) this.tradeHistory.shift();

                        // 📊 Track cycle trade count
                        this.incrementCycleTradeCount(asset);

                        // ==================== 🏆 APEX v24: LIVE HEDGED ORACLE ====================
                        // If hedging is enabled for ORACLE trades, place a hedge order on opposite side
                        const shouldLiveHedge = mode === 'ORACLE' && CONFIG.ORACLE.hedgeEnabled && CONFIG.ORACLE.hedgeRatio > 0;

                        if (shouldLiveHedge && market && market.tokenIds) {
                            try {
                                const hedgeRatio = CONFIG.ORACLE.hedgeRatio || 0.20;
                                const hedgeSize = size * hedgeRatio;
                                const hedgeDirection = direction === 'UP' ? 'DOWN' : 'UP';
                                const hedgeTokenType = hedgeDirection === 'UP' ? 'YES' : 'NO';
                                const hedgeTokenId = hedgeTokenType === 'YES' ? market.tokenIds.yes : market.tokenIds.no;
                                const hedgePrice = hedgeTokenType === 'YES' ? market.yesPrice : market.noPrice;
                                const hedgeShares = Math.floor((hedgeSize / hedgePrice) * 1e6) / 1e6;

                                log(`🛡️ LIVE HEDGE: Placing ${hedgeDirection} ${hedgeShares.toFixed(2)} shares @ ${(hedgePrice * 100).toFixed(1)}¢`, asset);

                                const hedgeOrder = await clobClient.createOrder({
                                    tokenID: hedgeTokenId,
                                    price: hedgePrice,
                                    size: hedgeShares,
                                    side: 'BUY',
                                    feeRateBps: 0
                                });

                                const hedgeResponse = await clobClient.postOrder(hedgeOrder);

                                if (hedgeResponse && hedgeResponse.orderID) {
                                    log(`✅ LIVE HEDGE PLACED: ${hedgeResponse.orderID}`, asset);

                                    // Store hedge position
                                    const hedgePositionId = `${asset}_HEDGE_${Date.now()}`;
                                    this.positions[hedgePositionId] = {
                                        asset,
                                        mode: 'HEDGE',
                                        side: hedgeDirection,
                                        tokenType: hedgeTokenType,
                                        size: hedgeSize,
                                        entry: hedgePrice,
                                        time: Date.now(),
                                        shares: hedgeShares,
                                        isLive: true,
                                        isHedge: true,
                                        mainId: positionId,
                                        status: 'LIVE_OPEN',
                                        orderID: hedgeResponse.orderID,
                                        tokenId: hedgeTokenId
                                    };

                                    // Link main to hedge
                                    this.positions[positionId].hedgeId = hedgePositionId;
                                    this.positions[positionId].isHedged = true;

                                    this.tradeHistory.push({
                                        id: hedgePositionId,
                                        asset,
                                        mode: 'HEDGE',
                                        side: hedgeDirection,
                                        entry: hedgePrice,
                                        size: hedgeSize,
                                        time: Date.now(),
                                        status: 'LIVE_OPEN',
                                        isHedge: true
                                    });
                                } else {
                                    log(`⚠️ LIVE HEDGE FAILED: ${JSON.stringify(hedgeResponse)}`, asset);
                                }
                            } catch (hedgeErr) {
                                log(`⚠️ LIVE HEDGE ERROR: ${hedgeErr.message}`, asset);
                            }
                        }

                        return { success: true, positionId, mode: 'LIVE', hedged: shouldLiveHedge };
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
        } finally {
            // 🔒 GOD MODE: Always release mutex, even on error/early return
            this.tradeMutex = false;
        }
    }

    // ==================== 💰 TRUE ARBITRAGE: ILLIQUIDITY GAP ====================
    // Buy BOTH YES + NO with equal share size when YES_ASK + NO_ASK < 1.0.
    // In PAPER this is deterministic. In LIVE this is still subject to fill risk.
    async executeIlliquidityGapPair(asset, market) {
        try {
            if (!CONFIG.ILLIQUIDITY_GAP?.enabled) {
                return { success: false, error: 'ILLIQUIDITY_GAP disabled' };
            }

            // Respect asset enable + per-cycle limits (pair counts as ONE trade).
            if (!this.isAssetEnabled(asset)) {
                return { success: false, error: `Trading disabled for ${asset}` };
            }
            const cycleCount = this.getCycleTradeCount(asset);
            const maxTrades = this.getMaxTradesPerCycle(asset);
            if (cycleCount >= maxTrades) {
                return { success: false, error: `Max trades (${maxTrades}) per cycle reached for ${asset}` };
            }

            // Need room for two legs within per-asset max position cap.
            const existingPositions = this.getPositionCount(asset);
            const maxPos = CONFIG.MAX_POSITIONS_PER_ASSET || 2;
            if (existingPositions > (maxPos - 2)) {
                return { success: false, error: `Not enough position slots for ILLIQUIDITY pair (need 2, have ${maxPos - existingPositions})` };
            }

            const yesPrice = market?.yesPrice;
            const noPrice = market?.noPrice;
            if (typeof yesPrice !== 'number' || typeof noPrice !== 'number' || !Number.isFinite(yesPrice) || !Number.isFinite(noPrice)) {
                return { success: false, error: `Invalid market prices YES=${yesPrice} NO=${noPrice}` };
            }

            const totalOdds = yesPrice + noPrice;
            const gap = 1 - totalOdds;
            const minGap = CONFIG.ILLIQUIDITY_GAP.minGap ?? 0.03;
            const maxEntryTotal = CONFIG.ILLIQUIDITY_GAP.maxEntryTotal ?? 0.97;

            // Hard filters (must be real arb on asks)
            if (totalOdds > maxEntryTotal) {
                return { success: false, error: `Total ${(totalOdds * 100).toFixed(1)}¢ > maxEntryTotal ${(maxEntryTotal * 100).toFixed(1)}¢` };
            }
            if (gap < minGap) {
                return { success: false, error: `Gap ${(gap * 100).toFixed(2)}% < minGap ${(minGap * 100).toFixed(2)}%` };
            }

            // Refresh LIVE balance if needed
            if (this.mode === 'LIVE') {
                await this.refreshLiveBalance();
            }

            const bankroll = this.mode === 'LIVE'
                ? (this.cachedLiveBalance || CONFIG.LIVE_BALANCE || 0)
                : this.paperBalance;

            // Per-leg minimum (same buffer used elsewhere)
            const MIN_ORDER = 1.10;
            const minLegPrice = Math.min(yesPrice, noPrice);
            const minTotalForMinOrders = (MIN_ORDER * totalOdds) / Math.max(minLegPrice, 1e-9);

            if (bankroll < minTotalForMinOrders) {
                return { success: false, error: `Bankroll $${bankroll.toFixed(2)} too small for pair min (~$${minTotalForMinOrders.toFixed(2)})` };
            }

            // Sizing: use MAX_POSITION_SIZE as the cap for total pair cost, but auto-bump to meet minimums.
            const maxFraction = Math.max(0.01, Math.min(CONFIG.MAX_POSITION_SIZE || 0.20, 0.50)); // UI caps at 50%
            let totalBudget = bankroll * maxFraction;
            if (totalBudget < minTotalForMinOrders) totalBudget = minTotalForMinOrders;
            totalBudget = Math.min(totalBudget, bankroll);

            const rawShares = totalBudget / totalOdds;
            const shares = Math.floor(rawShares * 1e6) / 1e6; // 6 decimals
            const sizeYes = shares * yesPrice;
            const sizeNo = shares * noPrice;
            const totalCost = sizeYes + sizeNo;

            if (shares <= 0 || sizeYes < MIN_ORDER || sizeNo < MIN_ORDER) {
                return { success: false, error: 'Illiquidity sizing produced sub-minimum leg(s)' };
            }

            log(`💰 ILLIQUIDITY: YES ${(yesPrice * 100).toFixed(1)}¢ + NO ${(noPrice * 100).toFixed(1)}¢ = ${(totalOdds * 100).toFixed(1)}¢ (Gap ${(gap * 100).toFixed(2)}%)`, asset);
            log(`💰 ILLIQUIDITY SIZE: shares=${shares.toFixed(4)} | YES=$${sizeYes.toFixed(2)} | NO=$${sizeNo.toFixed(2)} | total=$${totalCost.toFixed(2)} (bankroll=$${bankroll.toFixed(2)})`, asset);

            // PAPER MODE: open two legs, hold to resolution (resolveAllPositions closes at 1.0/0.0)
            const groupId = `${asset}_ILLIQ_${Date.now()}`;
            const yesId = `${groupId}_YES`;
            const noId = `${groupId}_NO`;

            if (this.mode === 'PAPER') {
                this.paperBalance -= totalCost;

                this.positions[yesId] = {
                    asset,
                    mode: 'ILLIQUIDITY',
                    side: 'UP',
                    tokenType: 'YES',
                    size: sizeYes,
                    entry: yesPrice,
                    time: Date.now(),
                    target: null,
                    stopLoss: null,
                    shares,
                    configVersion: CONFIG_VERSION
                };

                this.positions[noId] = {
                    asset,
                    mode: 'ILLIQUIDITY',
                    side: 'DOWN',
                    tokenType: 'NO',
                    size: sizeNo,
                    entry: noPrice,
                    time: Date.now(),
                    target: null,
                    stopLoss: null,
                    shares,
                    configVersion: CONFIG_VERSION
                };

                this.tradeHistory.push({
                    id: yesId,
                    asset,
                    mode: 'ILLIQUIDITY',
                    side: 'UP',
                    entry: yesPrice,
                    size: sizeYes,
                    shares,
                    time: Date.now(),
                    status: 'OPEN',
                    reason: `ILLIQUIDITY GAP ${(gap * 100).toFixed(2)}% (PAIR)`
                });
                this.tradeHistory.push({
                    id: noId,
                    asset,
                    mode: 'ILLIQUIDITY',
                    side: 'DOWN',
                    entry: noPrice,
                    size: sizeNo,
                    shares,
                    time: Date.now(),
                    status: 'OPEN',
                    reason: `ILLIQUIDITY GAP ${(gap * 100).toFixed(2)}% (PAIR)`
                });

                if (this.tradeHistory.length > 1000) this.tradeHistory.shift();

                // Count as ONE cycle trade (paired)
                this.incrementCycleTradeCount(asset);

                return { success: true, mode: 'ILLIQUIDITY', groupId, legs: [yesId, noId], shares, totalCost, gap };
            }

            // LIVE MODE: place 2 limit buys (best-effort). If either fails, cancel the other.
            if (!ClobClient) return { success: false, error: 'CLOB client not installed' };
            if (!CONFIG.POLYMARKET_API_KEY || !CONFIG.POLYMARKET_SECRET || !CONFIG.POLYMARKET_PASSPHRASE) {
                return { success: false, error: 'Missing API credentials (key/secret/passphrase)' };
            }
            if (!this.wallet) return { success: false, error: 'No wallet loaded' };
            if (!market?.tokenIds?.yes || !market?.tokenIds?.no) return { success: false, error: 'Missing token IDs' };

            const sanitizedPassphrase = CONFIG.POLYMARKET_PASSPHRASE.replace(/[^\x20-\x7E]/g, '');
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

            const yesTokenId = market.tokenIds.yes;
            const noTokenId = market.tokenIds.no;

            const yesOrder = await clobClient.createOrder({ tokenID: yesTokenId, price: yesPrice, size: shares, side: 'BUY', feeRateBps: 0 });
            const noOrder = await clobClient.createOrder({ tokenID: noTokenId, price: noPrice, size: shares, side: 'BUY', feeRateBps: 0 });

            const [yesResp, noResp] = await Promise.all([clobClient.postOrder(yesOrder), clobClient.postOrder(noOrder)]);
            const yesOrderID = yesResp?.orderID;
            const noOrderID = noResp?.orderID;

            if (!yesOrderID || !noOrderID) {
                // Best-effort cancel anything that did submit
                if (yesOrderID) await clobClient.cancelOrder({ orderID: yesOrderID }).catch(() => { });
                if (noOrderID) await clobClient.cancelOrder({ orderID: noOrderID }).catch(() => { });
                return { success: false, error: 'Failed to place both illiquidity orders' };
            }

            // Store positions (resolution will close them)
            this.positions[yesId] = { asset, mode: 'ILLIQUIDITY', side: 'UP', tokenType: 'YES', size: sizeYes, entry: yesPrice, time: Date.now(), target: null, stopLoss: null, shares, isLive: true, status: 'LIVE_OPEN', orderID: yesOrderID, tokenId: yesTokenId };
            this.positions[noId] = { asset, mode: 'ILLIQUIDITY', side: 'DOWN', tokenType: 'NO', size: sizeNo, entry: noPrice, time: Date.now(), target: null, stopLoss: null, shares, isLive: true, status: 'LIVE_OPEN', orderID: noOrderID, tokenId: noTokenId };

            this.tradeHistory.push({ id: yesId, asset, mode: 'ILLIQUIDITY', side: 'UP', entry: yesPrice, size: sizeYes, shares, time: Date.now(), status: 'LIVE_OPEN', orderID: yesOrderID });
            this.tradeHistory.push({ id: noId, asset, mode: 'ILLIQUIDITY', side: 'DOWN', entry: noPrice, size: sizeNo, shares, time: Date.now(), status: 'LIVE_OPEN', orderID: noOrderID });
            if (this.tradeHistory.length > 1000) this.tradeHistory.shift();

            this.incrementCycleTradeCount(asset);

            return { success: true, mode: 'ILLIQUIDITY', groupId, legs: [yesId, noId], shares, totalCost, gap, orders: { yes: yesOrderID, no: noOrderID } };
        } catch (e) {
            log(`❌ ILLIQUIDITY ERROR: ${e.message}`, asset);
            return { success: false, error: `Illiquidity error: ${e.message}` };
        }
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

            // 🔮 DYNAMIC SELL PRICE: Fetch best bid for better fills
            let sellPrice = 0.01; // Fallback minimum
            try {
                const orderbook = await clobClient.getOrderBook(position.tokenId);
                if (orderbook && orderbook.bids && orderbook.bids.length > 0) {
                    // Sort bids descending and take best (highest) bid
                    const sortedBids = [...orderbook.bids].sort((a, b) => parseFloat(b.price) - parseFloat(a.price));
                    const bestBid = parseFloat(sortedBids[0].price);
                    // Sell slightly below best bid to ensure fill
                    sellPrice = Math.max(0.01, bestBid - 0.01);
                    log(`📊 Best bid: ${(bestBid * 100).toFixed(1)}¢, selling at ${(sellPrice * 100).toFixed(1)}¢`, position.asset);
                }
            } catch (obErr) {
                log(`⚠️ Orderbook fetch failed, using minimum price: ${obErr.message}`, position.asset);
            }

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
    // 🔄 EXPONENTIAL BACKOFF: 3s, 6s, 12s, 24s, 48s (doubles each attempt)
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
                // EXPONENTIAL BACKOFF: 3s, 6s, 12s, 24s, 48s
                const backoffDelay = delayMs * Math.pow(2, attempt - 1);
                log(`⏳ Sell failed, waiting ${(backoffDelay / 1000).toFixed(0)}s before retry (exponential backoff)...`, position.asset);
                await new Promise(r => setTimeout(r, backoffDelay));
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

        // ==================== 🏆 APEX v24: HEDGED POSITION CLOSING ====================
        // If this is a hedged main position, also close the hedge
        if (pos.isHedged && pos.hedgeId && this.positions[pos.hedgeId]) {
            const hedge = this.positions[pos.hedgeId];
            const hedgeMarket = currentMarkets[hedge.asset];
            const hedgeExitPrice = hedge.side === 'UP' ? (hedgeMarket?.yesPrice || 0.5) : (hedgeMarket?.noPrice || 0.5);

            // Calculate hedge P&L
            const hedgePnl = (hedgeExitPrice - hedge.entry) * hedge.shares;
            const hedgePnlPercent = hedge.entry > 0 ? ((hedgeExitPrice / hedge.entry) - 1) * 100 : 0;

            // Add hedge returns to balance
            this.paperBalance += hedge.size + hedgePnl;
            this.todayPnL += hedgePnl;

            log(`🛡️ HEDGE CLOSED: ${hedge.side} Entry ${(hedge.entry * 100).toFixed(1)}¢ → Exit ${(hedgeExitPrice * 100).toFixed(1)}¢ = ${hedgePnl >= 0 ? '+' : ''}$${hedgePnl.toFixed(2)}`, hedge.asset);

            // Update hedge trade history
            const hedgeTrade = this.tradeHistory.find(t => t.id === pos.hedgeId);
            if (hedgeTrade) {
                hedgeTrade.exit = hedgeExitPrice;
                hedgeTrade.pnl = hedgePnl;
                hedgeTrade.pnlPercent = hedgePnlPercent;
                hedgeTrade.status = 'CLOSED';
                hedgeTrade.closeTime = Date.now();
                hedgeTrade.reason = 'HEDGE CLOSED (with main)';
            }

            delete this.positions[pos.hedgeId];
        }

        // Skip closing if this is a hedge being closed from main (already handled above)
        if (pos.isHedge) {
            // Just remove - P&L already calculated when main closed
            delete this.positions[positionId];
            return;
        }


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
        // 🔴 FORENSIC FIX: Guard against division by zero in pnl percentage
        const pnlPercent = pos.entry > 0 ? ((exitPrice / pos.entry) - 1) * 100 : 0;

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

        // 📱 TELEGRAM NOTIFICATION: Trade closed (with market links)
        const market = currentMarkets[pos.asset];
        sendTelegramNotification(telegramTradeClose(pos.asset, pos.side, pos.mode, pos.entry, exitPrice, pnl, pnlPercent, reason, this.paperBalance, market));

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

        // 🔴 FIX #14: Track CONSECUTIVE losses - only trigger cooldown after maxConsecutiveLosses
        if (pnl < 0) {
            this.consecutiveLosses = (this.consecutiveLosses || 0) + 1;
            // 🦅 v20: Track losses in HUNTER mode for retreat trigger
            if (this.aggressionMode === 'HUNTER') {
                this.hunterLossStreak++;
                log(`🔥 HUNTER Loss #${this.hunterLossStreak}/${this.HUNTER_LOSS_LIMIT}`, pos.asset);
            }
            // Only trigger cooldown after maxConsecutiveLosses (default 3)
            if (this.consecutiveLosses >= CONFIG.RISK.maxConsecutiveLosses) {
                this.lastLossTime = Date.now();
                log(`🔴 CONSECUTIVE LOSSES: ${this.consecutiveLosses} - Triggering ${CONFIG.RISK.cooldownAfterLoss}s cooldown`, pos.asset);
            }
            // 🎯 GOLDEN MEAN: Update state machine on loss
            this.updateTradingState('LOSS');
        } else {
            // WIN - reset consecutive losses and hunter streak
            this.consecutiveLosses = 0;
            this.hunterLossStreak = 0;
            // 🦅 v20: Reset dormancy timer on successful trade
            this.lastTradeTime = Date.now();
            // 🎯 GOLDEN MEAN: Update state machine on win
            this.updateTradingState('WIN');
        }

        // Add WINNING live positions to redemption queue for later claiming
        // Only if position has a tokenId (live trade) and won (exitPrice = 1.0)
        if (pos.isLive && pos.tokenId && exitPrice >= 0.99) {
            this.addToRedemptionQueue(pos);
        }

        delete this.positions[positionId];
        return pnl;
    }

    // 🧊 PINNACLE v28: ASSET COOLDOWN - Pause trading on specific asset after loss
    // This prevents the bot from immediately re-entering a losing asset
    coolOffAsset(asset, durationSeconds) {
        if (!this.assetCooldowns) this.assetCooldowns = {};

        this.assetCooldowns[asset] = Date.now() + (durationSeconds * 1000);
        log(`🧊 COOLDOWN: ${asset} paused for ${durationSeconds}s after stop loss`, asset);
    }

    // 🧊 Check if asset is in cooldown
    isAssetInCooldown(asset) {
        if (!this.assetCooldowns || !this.assetCooldowns[asset]) return false;

        if (Date.now() > this.assetCooldowns[asset]) {
            // Cooldown expired, clear it
            delete this.assetCooldowns[asset];
            return false;
        }

        const remainingMs = this.assetCooldowns[asset] - Date.now();
        log(`🧊 ${asset} still in cooldown: ${Math.ceil(remainingMs / 1000)}s remaining`, asset);
        return true;
    }

    // 🔮 ORACLE: POSITION PYRAMIDING - Add to Winning Positions
    async checkPyramiding() {
        if (!CONFIG.RISK.enablePositionPyramiding) return;

        // Iterate over positions object (not openPositions which doesn't exist)
        for (const [positionId, trade] of Object.entries(this.positions)) {
            // Only pyramid ORACLE positions
            if (trade.mode !== 'ORACLE') continue;

            // Only pyramid once per position
            if (trade.pyramided) continue;

            // Must be held for at least 2 minutes
            // Position uses 'time' not 'entryTime'
            const holdTime = (Date.now() - trade.time) / 1000;
            if (holdTime < 120) continue;

            // Check if position is profitable
            const market = currentMarkets[trade.asset];
            if (!market) continue;

            // Position uses 'side' with values 'UP'/'DOWN', not 'YES'/'NO'
            const currentPrice = trade.side === 'UP' ? market.yesPrice : market.noPrice;
            const pnlPercent = ((currentPrice - trade.entry) / trade.entry) * 100;

            // Must be profitable by at least 15%
            if (pnlPercent < 15) continue;

            // Calculate pyramid size (50% of original position)
            const pyramidSize = trade.size * 0.5;
            const pyramidCost = pyramidSize * currentPrice;

            // Check if we have balance (use correct property)
            const balance = this.mode === 'PAPER' ? this.paperBalance : this.cachedLiveBalance;
            if (pyramidCost > balance * 0.1) continue; // Max 10% of balance for pyramid

            log(`🔺 PYRAMIDING: Adding ${pyramidSize.toFixed(0)} shares @ ${(currentPrice * 100).toFixed(1)}¢ to ${trade.asset} position (+${pnlPercent.toFixed(1)}%)`, trade.asset);

            // Execute pyramid trade - use trade.side for direction
            const pyramidResult = await this.executeTrade(trade.asset, trade.side, 'ORACLE', 0.9, currentPrice, market, {
                isPyramid: true,
                originalTradeId: positionId,
                pyramidSize: pyramidSize
            });

            if (pyramidResult.success) {
                // Mark original trade as pyramided
                trade.pyramided = true;
                trade.pyramidTime = Date.now();
                log(`✅ Pyramid added successfully`, trade.asset);
            }
        }
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

                // 🏆 APEX v24 FIX: DEATH_BOUNCE was MISSING from exit cases!
                // 🚀 VELOCITY v26 FIX: Stop-loss check MUST come FIRST
                case 'DEATH_BOUNCE':
                    // STOP LOSS FIRST (prevents 80% losses from TIME EXIT at 1¢)
                    if (currentOdds <= pos.stopLoss) {
                        log(`💀 DEATH BOUNCE STOP: ${(currentOdds * 100).toFixed(0)}¢ <= ${(pos.stopLoss * 100).toFixed(0)}¢`, pos.asset);
                        this.closePosition(id, currentOdds, 'DEATH_BOUNCE STOP LOSS');
                        return;
                    }
                    // Exit at target price
                    if (currentOdds >= pos.target) {
                        log(`💀 DEATH BOUNCE TARGET HIT: ${(currentOdds * 100).toFixed(0)}¢ >= ${(pos.target * 100).toFixed(0)}¢`, pos.asset);
                        this.closePosition(id, currentOdds, 'DEATH_BOUNCE TARGET HIT');
                        return;
                    }
                    // Exit on time - must close before cycle ends with buffer
                    if (timeToEnd <= 60) { // 60 seconds buffer for DEATH_BOUNCE
                        log(`💀 DEATH BOUNCE TIME EXIT: ${timeToEnd}s remaining`, pos.asset);
                        this.closePosition(id, currentOdds, 'DEATH_BOUNCE TIME EXIT');
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
            // ILLIQUIDITY is true-arb and should hold to resolution (do not force-close at 30s).
            if (timeToEnd <= 30 && pos.mode !== 'ORACLE' && pos.mode !== 'ILLIQUIDITY') {
                log(`⏰ PRE-RESOLUTION EXIT: ${pos.mode} ${pos.side} position closing at ${(currentOdds * 100).toFixed(1)}%`, pos.asset);
                this.closePosition(id, currentOdds, 'PRE-RESOLUTION EXIT (30s)');
                return;
            }

            // ==================== v39 ADAPTIVE MARKET REGIMES ====================
            // 🧠 INTELLIGENCE: Auto-adapt to Market Mood (Calm/Volatile/Chaos)

            if (pos.mode === 'ORACLE' && CONFIG.ORACLE.adaptiveModeEnabled) {
                // 1. Detect Regime (Real-time volatility analysis)
                // Use global opportunityDetector instance to get regime
                const regime = (typeof opportunityDetector !== 'undefined')
                    ? opportunityDetector.detectRegime(asset)
                    : 'VOLATILE';

                // 2. Load Regime Parameters
                const params = CONFIG.ORACLE.regimes[regime] || CONFIG.ORACLE.regimes.VOLATILE;

                // 3. Dynamic Stop Loss Update (CRITICAL FIX v40)
                // PREVIOUS BUG (v39): pos.stopLoss = params.stopLoss (0.50) -> ABSOLUTE PRICE -> INSTANT EXIT
                // v40 FIX: Calculate RELATIVE Stop Price based on Entry
                // Formula: StopPrice = Entry * (1 - StopPct)

                const stopPct = params.stopLoss; // e.g., 0.50 (50%)
                const stopPrice = pos.entry * (1 - stopPct);

                // Update the position's stop loss to the calculated price
                pos.stopLoss = stopPrice;

                // Explicit Check for logging clarity
                if (currentOdds <= pos.stopLoss) {
                    const lossPct = ((pos.entry - currentOdds) / pos.entry * 100).toFixed(0);
                    log(`🛡️ ${regime} REGIME STOP: Exiting at ${(currentOdds * 100).toFixed(0)}¢ (Stop Price ${(pos.stopLoss * 100).toFixed(0)}¢ / -${stopPct * 100}%)`, pos.asset);
                    this.closePosition(id, currentOdds, `${regime} STOP LOSS (-${lossPct}%)`);
                    return;
                }

                // 4. Dynamic Target Logic (Diamond vs Safety)
                const gainPercent = (currentOdds - pos.entry) / pos.entry;

                // DIAMOND HANDS: High confidence implied by Regime + Price Action
                // If price > diamondTarget, we take max profit
                if (currentOdds >= params.diamondTarget) {
                    const profitPercent = (gainPercent * 100).toFixed(0);
                    this.closePosition(id, currentOdds, `💎 ${regime} DIAMOND EXIT +${profitPercent}% (${(params.diamondTarget * 100).toFixed(0)}¢ Target)`);
                    return;
                }

                // SAFETY NET: Mid-range profit taking if things look shaky
                // If price > safetyTarget (e.g. +20%) AND we are not at moon yet...
                // Only take safety exit if Price < 0.80 (Struggling) OR Regime is CHAOS
                // In CALM, we ignore safety exit (let it ride). In CHAOS, we take it eagerly.
                const isStruggling = currentOdds < 0.80;
                const forceSafety = regime === 'CHAOS'; // Taking profit early in chaos is wise

                if ((isStruggling || forceSafety) && gainPercent >= params.safetyTarget && timeToEnd > 60) {
                    const profitPercent = (gainPercent * 100).toFixed(0);
                    this.closePosition(id, currentOdds, `🧻 ${regime} SAFETY EXIT +${profitPercent}%`);
                    return;
                }
            }

            // ==================== DEITY-LEVEL: SMART STOP LOSS ====================
            // Binary markets resolve to 0¢ or 100¢ - selling at 8¢ locks in -75% loss
            // Better strategy: hold to resolution unless early enough to recover

            // Universal stop loss check (with smart binary market awareness)
            // - MANUAL trades: Never auto-close (user controls)
            // - ORACLE trades: Only if stopLoss is enabled AND smart conditions met
            // - Other modes: Respect stopLoss but with smart overrides
            if (pos.mode !== 'MANUAL' && pos.stopLoss && currentOdds <= pos.stopLoss) {

                // ==================== v23 GUARDIAN UPDATE ====================
                // PREVIOUSLY: "Diamond Hands" (Held last 120s). Resulted in -100% losses.
                // NOW: ALWAYS TRIGGER. If we are losing -30%, we SELL.

                const lossPercent = ((pos.entry - currentOdds) / pos.entry * 100).toFixed(0);
                log(`🛑 GUARDIAN STOP LOSS: Exiting at -${lossPercent}% (Odds ${currentOdds} <= ${pos.stopLoss})`, pos.asset);
                this.closePosition(id, currentOdds, `STOP LOSS -${lossPercent}% 🛑`);

                this.coolOffAsset(pos.asset, CONFIG.RISK.cooldownAfterLoss || 300);
                return;
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

    // 🔴 BUG FIX: Force-resolve any stale positions older than 1 cycle (15 minutes)
    // This catches positions that weren't resolved due to missing price data
    cleanupStalePositions() {
        const now = Date.now();
        const maxAge = INTERVAL_SECONDS * 1000; // 15 minutes in ms

        Object.entries(this.positions).forEach(([id, pos]) => {
            const age = now - pos.time;
            if (age > maxAge) {
                log(`⚠️ STALE POSITION: ${pos.asset} ${pos.side} opened ${Math.floor(age / 60000)}m ago - force closing`, pos.asset);
                // Force close at 50¢ (uncertain outcome) to be conservative
                this.closePosition(id, 0.5, 'STALE POSITION CLEANUP ⚠️');
            }
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
    // 🚀 VELOCITY v26: Now stores conditionId for automatic redemption
    addToRedemptionQueue(position) {
        if (!this.redemptionQueue) this.redemptionQueue = [];
        if (position && position.tokenId) {
            // Extract conditionId from market if available
            let conditionId = position.conditionId || null;

            // Try to get conditionId from current market data
            if (!conditionId && position.asset && currentMarkets[position.asset]) {
                const market = currentMarkets[position.asset];
                // Polymarket encodes conditionId in the token itself, or we can derive from market
                if (market.conditionId) {
                    conditionId = market.conditionId;
                }
            }

            this.redemptionQueue.push({
                tokenId: position.tokenId,
                asset: position.asset,
                side: position.side,
                addedAt: Date.now(),
                shares: position.shares || 0,
                conditionId: conditionId // For automatic redemption
            });
            log(`📋 Added to redemption queue: ${position.asset} ${position.side}${conditionId ? ' (auto-redeemable)' : ' (manual)'}`, position.asset);
        }
    }

    // Get redemption queue
    getRedemptionQueue() {
        return this.redemptionQueue || [];
    }

    // Check and redeem any resolved positions - AUTOMATIC REDEMPTION
    async checkAndRedeemPositions() {
        if (!this.wallet) {
            return { success: false, error: 'No wallet loaded' };
        }

        const queue = this.redemptionQueue || [];
        if (queue.length === 0) {
            return { success: true, message: 'No positions to redeem', redeemed: 0 };
        }

        log(`🔍 Checking ${queue.length} positions for automatic redemption...`);
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

                        // 🚀 VELOCITY v26: AUTOMATIC REDEMPTION ATTEMPT
                        // If we have conditionId stored, try to redeem automatically
                        if (item.conditionId) {
                            try {
                                log(`🔄 Attempting automatic redemption for ${item.asset}...`, item.asset);

                                // Prepare redemption parameters
                                const parentCollectionId = ethers.constants.HashZero; // bytes32(0) for Polymarket
                                const indexSets = [1, 2]; // Both outcomes for binary markets

                                // Estimate gas first
                                const gasEstimate = await ctfContract.estimateGas.redeemPositions(
                                    USDC_ADDRESS,
                                    parentCollectionId,
                                    item.conditionId,
                                    indexSets
                                );

                                // Execute redemption with 20% gas buffer
                                const tx = await ctfContract.redeemPositions(
                                    USDC_ADDRESS,
                                    parentCollectionId,
                                    item.conditionId,
                                    indexSets,
                                    { gasLimit: gasEstimate.mul(120).div(100) }
                                );

                                log(`📝 Redemption TX submitted: ${tx.hash}`, item.asset);

                                // Wait for confirmation
                                const receipt = await tx.wait();

                                if (receipt.status === 1) {
                                    log(`✅ AUTO-REDEEMED: ${item.asset} ${item.side} - TX: ${tx.hash}`, item.asset);
                                    queue.splice(i, 1);
                                    redeemed++;

                                    // Refresh balance
                                    this.refreshLiveBalance();
                                } else {
                                    log(`❌ Redemption TX failed for ${item.asset}`, item.asset);
                                    failed++;
                                }
                            } catch (redeemError) {
                                log(`⚠️ Auto-redeem failed for ${item.asset}: ${redeemError.message}`, item.asset);
                                log(`   Fallback: Use Polymarket website to redeem manually`, item.asset);
                                failed++;
                            }
                        } else {
                            // No conditionId - can't auto-redeem
                            log(`⚠️ Position ${item.asset} ${item.side} missing conditionId - manual redemption required`, item.asset);
                            log(`   Use Polymarket website: https://polymarket.com/portfolio`, item.asset);
                        }
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
        this.confidenceHistory = {}; // 🏆 v39: Track confidence volatility
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

    // 🏆 v39: Update confidence history for volatility analysis
    updateConfidenceHistory(asset, confidence) {
        if (!this.confidenceHistory[asset]) this.confidenceHistory[asset] = [];
        this.confidenceHistory[asset].push(confidence);
        // Keep last 10 ticks (~1 min) for StdDev calculation
        if (this.confidenceHistory[asset].length > 10) this.confidenceHistory[asset].shift();
    }

    // 🏆 v39: Detect Market Regime based on volatility
    detectRegime(asset) {
        if (!CONFIG.ORACLE.adaptiveModeEnabled) return 'VOLATILE'; // Default if disabled

        const history = this.confidenceHistory[asset];
        if (!history || history.length < 5) return 'VOLATILE'; // Not enough data -> Default

        // Calculate Standard Deviation
        const mean = history.reduce((a, b) => a + b, 0) / history.length;
        const variance = history.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / history.length;
        const stdDev = Math.sqrt(variance);

        // Determine Regime
        if (stdDev < 0.05) return 'CALM';      // 🌊 Low Volatility (<5%) -> Aggressive
        if (stdDev > 0.15) return 'CHAOS';     // 🔥 Extreme Volatility (>15%) -> Survival
        return 'VOLATILE';                     // 🌪️ Normal (5-15%) -> Defensive
    }

    // MODE 2: VALUE_BET - Detect mispriced odds (RENAMED from ARBITRAGE)
    // ⚠️ WARNING: This is NOT true arbitrage! True arbitrage buys BOTH sides
    // simultaneously when Yes+No<100% for guaranteed profit. This only buys
    // ONE side based on predicted mispricing. Should be called VALUE_BET.
    detectArbitrage(asset, confidence, yesPrice, noPrice, side, elapsed = 0) {
        if (!CONFIG.ARBITRAGE.enabled) return null;
        // ONE TRADE PER CYCLE PER ASSET
        if (this.hasTraded(asset, 'ARBITRAGE')) return null;

        // ⚠️ CRITICAL FIX: REJECT NEUTRAL/WAIT PREDICTIONS
        // Bug: scanAll passes data.prediction which can be 'NEUTRAL', 'WAIT', etc.
        // This caused trades to execute with NEUTRAL direction = catastrophic
        if (side !== 'UP' && side !== 'DOWN') {
            return null; // HARD BLOCK: Only UP or DOWN allowed
        }

        // ⚠️ CRITICAL BUG FIX: CYCLE BOUNDARY GUARD
        // At cycle boundary, old market has extreme odds (1-5¢) but new market resets to ~50%
        // Without this guard, trades open at 1¢ using stale data, then immediately close at 50¢
        // for fake 5000%+ profits. Block first 30 seconds of each cycle.
        const now = Math.floor(Date.now() / 1000);
        const cycleStart = now - (now % 900); // 15 min cycles
        const elapsedInCycle = now - cycleStart;
        const CYCLE_BOUNDARY_COOLDOWN = 30; // 30 seconds

        if (elapsedInCycle < CYCLE_BOUNDARY_COOLDOWN) {
            return null; // BLOCK: Market data may be stale from previous cycle
        }

        // LATE CYCLE CUTOFF: REMOVED - User requested late entries if confident
        // Bot learns from all trades, even late-cycle ones

        const fairValue = side === 'UP' ? confidence : (1 - confidence);
        const marketOdds = side === 'UP' ? yesPrice : noPrice;
        const mispricing = fairValue - marketOdds;

        if (mispricing >= CONFIG.ARBITRAGE.minMispricing) {
            return {
                mode: 'VALUE_BET', // RENAMED: Not true arbitrage - only buys ONE side
                direction: side,
                entry: marketOdds,
                edge: mispricing * 100,
                reason: `Value bet: ${(mispricing * 100).toFixed(1)}% mispricing (single-sided)`
            };
        }
        return null;
    }

    // ==================== STRATEGIC TRINITY #2: ILLIQUIDITY GAP ====================
    // MOLECULAR RECONSTRUCTION: Detect Yes + No != 100 for guaranteed profit
    // When market makers don't keep spread tight, we get FREE MONEY
    detectIlliquidityGap(asset, yesPrice, noPrice) {
        if (!CONFIG.ILLIQUIDITY_GAP.enabled) return null; // Uses own toggle now
        if (this.hasTraded(asset, 'ILLIQUIDITY')) return null;

        // Require real numeric prices (best asks). If a side is missing, do NOT treat it as an arb signal.
        if (typeof yesPrice !== 'number' || typeof noPrice !== 'number' || !Number.isFinite(yesPrice) || !Number.isFinite(noPrice)) {
            return null;
        }

        // Calculate the gap: In a perfect market, Yes + No = $1 (100%)
        // Any deviation is exploitable
        const totalOdds = yesPrice + noPrice;
        const gap = 1 - totalOdds; // Positive = underpriced overall

        // Enforce maxEntryTotal (explicit guard, even if minGap implies it under defaults)
        if (typeof CONFIG.ILLIQUIDITY_GAP.maxEntryTotal === 'number' && Number.isFinite(CONFIG.ILLIQUIDITY_GAP.maxEntryTotal)) {
            if (totalOdds > CONFIG.ILLIQUIDITY_GAP.maxEntryTotal) return null;
        }

        // GUARANTEED PROFIT: If gap >= minGap (default 3%), profit is possible
        if (gap >= CONFIG.ILLIQUIDITY_GAP.minGap) {
            log(`💰 ILLIQUIDITY GAP FOUND: Yes=${(yesPrice * 100).toFixed(1)}¢ + No=${(noPrice * 100).toFixed(1)}¢ = ${(totalOdds * 100).toFixed(1)}¢ (Gap: ${(gap * 100).toFixed(1)}%)`, asset);
            return {
                mode: 'ILLIQUIDITY',
                direction: 'BOTH', // Special: buy both YES and NO
                entry: totalOdds, // Total cost to buy both
                edge: gap * 100, // Guaranteed profit percentage
                yesPrice,
                noPrice,
                reason: `GUARANTEED ${(gap * 100).toFixed(1)}% profit (Yes+No=${(totalOdds * 100).toFixed(0)}%)`
            };
        }

        // NEGATIVE GAP: If Yes + No > 100%, market is overpriced (rare but possible)
        // Not exploitable for guaranteed profit, but indicates market inefficiency
        if (gap < -0.05) {
            log(`⚠️ Negative gap: Yes+No=${(totalOdds * 100).toFixed(1)}% (overpriced by ${(-gap * 100).toFixed(1)}%)`, asset);
        }

        return null;
    }

    // ==================== STRATEGIC TRINITY #3: DEATH BOUNCE SCALP ====================
    // MOLECULAR RECONSTRUCTION: Buy shares <10¢ when market overreacts, sell on bounce
    // Logic: When one side hits 5¢-10¢, uncertainty spikes often cause 10-15¢ bounce
    detectDeathBounce(asset, yesPrice, noPrice, elapsed, atr, regime) {
        if (!CONFIG.DEATH_BOUNCE.enabled) return null; // Uses own toggle now
        if (this.hasTraded(asset, 'DEATH_BOUNCE')) return null;

        // DEATH BOUNCE ZONE: From config
        const DEATH_ZONE_MIN = CONFIG.DEATH_BOUNCE.minPrice;
        const DEATH_ZONE_MAX = CONFIG.DEATH_BOUNCE.maxPrice;
        const BOUNCE_TARGET = CONFIG.DEATH_BOUNCE.targetPrice;
        const MIN_SCORE = CONFIG.DEATH_BOUNCE.minScore;

        // Time windows: Best bounces happen in specific periods
        // Early cycle (0-180s): Too early, odds still forming
        // Mid cycle (180-600s): GOLDEN WINDOW - uncertainty highest
        // Late cycle (600-840s): Still ok, but decreasing
        // Final (840+): Too close to resolution, hold risk high

        // 🏆 APEX v24 FIX: HARD BLOCK first 120 seconds - prevents cycle start trades!
        if (elapsed < 120) {
            return null; // BLOCK: Too early in cycle, market forming, stale data risk
        }

        // 🏆 APEX v24 FIX: HARD BLOCK if not enough time to exit (need 90s buffer)
        const timeToEnd = INTERVAL_SECONDS - elapsed;
        if (timeToEnd < 90) {
            return null; // BLOCK: Not enough time to exit position safely
        }

        const isGoldenWindow = elapsed >= 180 && elapsed <= 600;
        const isLateWindow = elapsed > 600 && elapsed <= 780;
        const windowMultiplier = isGoldenWindow ? 1.2 : (isLateWindow ? 0.9 : 0.5);

        // Volatility check: Higher ATR = more bounce potential
        const volBonus = (regime === 'VOLATILE') ? 1.3 : (regime === 'CHOPPY') ? 1.1 : 1.0;

        // ==================== 🏆 APEX v24 FIX: GENESIS SUPREMACY CHECK ====================
        // DEATH_BOUNCE must align with Genesis model (94.2% accurate)
        // If Genesis says UP, only buy YES (direction UP)
        // If Genesis says DOWN, only buy NO (direction DOWN)
        const brain = Brains[asset];
        let genesisDirection = null;
        let genesisAccuracy = 0;

        if (brain && brain.modelAccuracy && brain.modelAccuracy.genesis) {
            const genAcc = brain.modelAccuracy.genesis;
            if (genAcc.total >= 10) {
                genesisAccuracy = genAcc.wins / genAcc.total;
            }
        }

        if (brain && brain.lastSignal && brain.lastSignal.modelVotes) {
            genesisDirection = brain.lastSignal.modelVotes.genesis;
        }

        // If Genesis is >85% accurate and has a vote, we MUST align with it
        const requireGenesisAlignment = genesisAccuracy > 0.85 && genesisDirection !== null;

        // Check YES side death bounce
        if (yesPrice >= DEATH_ZONE_MIN && yesPrice <= DEATH_ZONE_MAX) {
            const potentialProfit = BOUNCE_TARGET - yesPrice;
            const riskReward = potentialProfit / yesPrice; // e.g., 0.13/0.05 = 2.6x
            const score = riskReward * windowMultiplier * volBonus;

            if (score >= MIN_SCORE) {
                // 🏆 APEX v24: Genesis alignment check for YES side (direction = UP)
                if (requireGenesisAlignment && genesisDirection !== 'UP') {
                    log(`🛡️ DEATH BOUNCE BLOCKED: Genesis says ${genesisDirection}, not UP`, asset);
                    // Don't return - continue to check NO side
                } else {
                    log(`💀 DEATH BOUNCE: YES at ${(yesPrice * 100).toFixed(0)}¢ | R:R=${riskReward.toFixed(1)}x | Score=${score.toFixed(1)} | Genesis: ${genesisDirection || 'N/A'}`, asset);
                    return {
                        mode: 'DEATH_BOUNCE',
                        direction: 'UP',
                        entry: yesPrice,
                        target: BOUNCE_TARGET,
                        stopLoss: Math.max(0.01, yesPrice * 0.5), // 50% stop (still cheap)
                        reason: `YES ${(yesPrice * 100).toFixed(0)}¢→${(BOUNCE_TARGET * 100).toFixed(0)}¢ (${riskReward.toFixed(1)}x R:R) [Genesis: ${genesisDirection}]`
                    };
                }
            }
        }

        // Check NO side death bounce
        if (noPrice >= DEATH_ZONE_MIN && noPrice <= DEATH_ZONE_MAX) {
            const potentialProfit = BOUNCE_TARGET - noPrice;
            const riskReward = potentialProfit / noPrice;
            const score = riskReward * windowMultiplier * volBonus;

            if (score >= MIN_SCORE) {
                // 🏆 APEX v24: Genesis alignment check for NO side (direction = DOWN)
                if (requireGenesisAlignment && genesisDirection !== 'DOWN') {
                    log(`🛡️ DEATH BOUNCE BLOCKED: Genesis says ${genesisDirection}, not DOWN`, asset);
                    return null; // Block - Genesis disagrees
                }
                log(`💀 DEATH BOUNCE: NO at ${(noPrice * 100).toFixed(0)}¢ | R:R=${riskReward.toFixed(1)}x | Score=${score.toFixed(1)} | Genesis: ${genesisDirection || 'N/A'}`, asset);
                return {
                    mode: 'DEATH_BOUNCE',
                    direction: 'DOWN',
                    entry: noPrice,
                    target: BOUNCE_TARGET,
                    stopLoss: Math.max(0.01, noPrice * 0.5),
                    reason: `NO ${(noPrice * 100).toFixed(0)}¢→${(BOUNCE_TARGET * 100).toFixed(0)}¢ (${riskReward.toFixed(1)}x R:R) [Genesis: ${genesisDirection}]`
                };
            }
        }

        return null;
    }

    // MODE 3: SCALP - Detect ultra-cheap entry
    detectScalp(asset, confidence, yesPrice, noPrice) {
        if (!CONFIG.SCALP.enabled) return null;
        // ONE TRADE PER CYCLE PER ASSET
        if (this.hasTraded(asset, 'SCALP')) return null;

        // ⚠️ CRITICAL BUG FIX: CYCLE BOUNDARY GUARD
        // At cycle boundary, old market has extreme odds (1-5¢) but new market resets to ~50%
        // Without this guard, trades open at 1¢ using stale data, then immediately close at 50¢
        // for fake 5000%+ profits. Block first 30 seconds of each cycle.
        const now = Math.floor(Date.now() / 1000);
        const cycleStart = now - (now % 900); // 15 min cycles
        const elapsedInCycle = now - cycleStart;
        const CYCLE_BOUNDARY_COOLDOWN = 30; // 30 seconds

        if (elapsedInCycle < CYCLE_BOUNDARY_COOLDOWN) {
            return null; // BLOCK: Market data may be stale from previous cycle
        }

        // ==================== 🏆 APEX v24: SMART SCALP CONDITIONS ====================
        const timeRemaining = 900 - elapsedInCycle;

        // 🏆 SMART CONDITION 1: TIME WINDOW (60-600 seconds)
        // Too early = price unstable, too late = not enough time to profit
        const MIN_ELAPSED = 60;   // At least 1 minute into cycle
        const MAX_ELAPSED = 600;  // No later than 10 minutes (need 5 min to exit)

        if (elapsedInCycle < MIN_ELAPSED || elapsedInCycle > MAX_ELAPSED) {
            return null; // BLOCK: Outside optimal scalp window
        }

        // 🏆 SMART CONDITION 2: EXIT BUFFER
        // Ensure we have at least 2 minutes to exit before cycle ends
        const MIN_TIME_REMAINING = CONFIG.SCALP.exitBeforeEnd || 120;
        if (timeRemaining < MIN_TIME_REMAINING) {
            return null; // BLOCK: Too close to resolution
        }

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
        // v39: Update confidence history for regime detection
        if (data && typeof data.confidence === 'number') {
            this.updateConfidenceHistory(asset, data.confidence);
        }

        const opportunities = [];

        // ==================== STRATEGIC TRINITY: HIGHEST PRIORITY ====================

        // ILLIQUIDITY GAP (Priority 0 - GUARANTEED PROFIT)
        const illiqGap = this.detectIlliquidityGap(asset, data.yesPrice, data.noPrice);
        if (illiqGap) opportunities.push({ ...illiqGap, priority: 0 }); // Highest priority - free money!

        // DEATH BOUNCE (Priority 1 - High R:R Scalp)
        const deathBounce = this.detectDeathBounce(asset, data.yesPrice, data.noPrice, data.elapsed, data.atr, data.regime);
        if (deathBounce) opportunities.push({ ...deathBounce, priority: 1 });

        // ==================== STANDARD MODES ====================

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

        // PINNACLE FIX: Threshold increased from 0.15 to 0.35
        // Debug export showed: matchCount=0 for ALL patterns - threshold too strict
        // Loosening enables pattern memory to actually function
        if (minDistance < 0.35) {
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

        // FINAL SEVEN: CONFIDENCE CALIBRATION (FIXED: Added all confidence ranges)
        this.calibrationBuckets = {
            '0.50-0.60': { total: 0, wins: 0 },
            '0.60-0.70': { total: 0, wins: 0 },
            '0.70-0.80': { total: 0, wins: 0 },
            '0.80-0.90': { total: 0, wins: 0 },
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

        // ==================== TRUE ORACLE: CERTAINTY SYSTEM ====================
        // Meta-awareness: "How confident am I that my confidence is REAL?"
        this.certaintyScore = 0;                    // 0-100 scale
        this.certaintyHistory = [];                 // Last 10 readings for stability check
        this.oracleLocked = false;                  // TRUE ORACLE LOCK - NEVER changes once set
        this.lockCertainty = 0;                     // Certainty when locked
        this.oracleLockPrediction = null;           // Direction when locked

        // Certainty Components (each contributes to total certainty)
        this.modelAgreementHistory = [];            // Last 5 model vote snapshots
        this.priceConfirmationScore = 0;            // 0-25: Is price moving our way?
        this.manipulationScore = 0;                 // 0-1: Higher = more manipulation detected
        this.edgeHistory = [];                      // Last 5 edge calculations for stability
        this.lastPriceDirection = null;             // Track price movement direction

        // Scalp tracking
        this.scalpBounceHistory = [];               // Track historical bounces for learning

        // ==================== PINNACLE EVOLUTION: NEW SYSTEMS ====================

        // 1. CERTAINTY VELOCITY TRACKING
        this.certaintySeries = [];                  // Last 5 certainty readings
        this.certaintyVelocity = 0;                 // Rate of certainty change
        this.certaintyAcceleration = 0;             // Is velocity increasing?

        // 2. CYCLE PHASE AWARENESS
        this.currentPhase = 'GENESIS';              // Current cycle phase
        this.phaseThresholdModifier = 1.0;          // Dynamic threshold adjustment

        // 3. GENESIS WINDOW TRADING
        this.genesisTraded = false;                 // Has genesis trade been placed?
        this.genesisTradeDirection = null;          // Direction of genesis trade

        // 4. BLACKOUT ENFORCEMENT
        this.lastBlackoutPrediction = null;         // Prediction before blackout
        this.blackoutLogged = false;                // Only log blackout once
        this.inBlackout = false;                    // Are we in blackout period?

        // 5. CROSS-ASSET ALPHA TRANSFER
        this.correlationBonus = 0;                  // Bonus from correlated assets
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

            // ==================== DEITY-LEVEL: DYNAMIC MODEL WEIGHTING ====================
            // Models with <50% accuracy are DISABLED - they actively hurt predictions
            // Models with >70% accuracy get boosted - they are making money
            const weights = {};
            const MIN_TRADES_FOR_TRUST = 10; // Need sufficient data before adjusting

            for (const [model, stats] of Object.entries(this.modelAccuracy)) {
                if (stats.total < MIN_TRADES_FOR_TRUST) {
                    // Not enough data - use default weight
                    weights[model] = 1.0;
                } else {
                    const accuracy = stats.wins / stats.total;

                    // 🚫 KILL SWITCH: <50% accuracy = ZERO weight (worse than coin flip)
                    if (accuracy < 0.50) {
                        weights[model] = 0; // DISABLED
                        log(`🔕 MODEL DISABLED: ${model} (${(accuracy * 100).toFixed(0)}% < 50%)`, this.asset);
                        continue;
                    }

                    // ⚠️ PENALTY ZONE: 50-60% = ZERO weight (still dilutes high-accuracy models)
                    // 🔴 UNBOUNDED FIX: Was 0.25 weight - now ZERO (50-55% is still harmful)
                    if (accuracy < 0.60) {
                        weights[model] = 0; // DISABLED - too close to coin flip
                        continue;
                    }

                    // ✅ NORMAL: 55-70% = standard weight based on performance
                    if (accuracy < 0.70) {
                        weights[model] = Math.pow(accuracy * 2, 1.3);
                        continue;
                    }

                    // 🌟 BOOST: >70% = amplified weight (high performer)
                    weights[model] = Math.pow(accuracy * 2, 1.5) * 1.5;
                }
            }

            // ==================== GENESIS SUPREMACY MODE ====================
            // Genesis historically has 92% accuracy - make it DOMINANT
            // If Genesis disagrees with ensemble, VETO the prediction
            const genesisAcc = this.modelAccuracy.genesis;
            if (genesisAcc.total >= MIN_TRADES_FOR_TRUST) {
                const genesisAccuracy = genesisAcc.wins / genesisAcc.total;
                if (genesisAccuracy > 0.80) {
                    // Genesis is a god-tier model - give it 4x weight
                    weights.genesis = 4.0;
                    log(`👑 GENESIS SUPREMACY: ${(genesisAccuracy * 100).toFixed(0)}% accuracy = 4x weight`, this.asset);
                } else if (genesisAccuracy > 0.70) {
                    weights.genesis = 3.0;
                }
            } else {
                // Default Genesis weight before we have enough data
                weights.genesis = 2.5;
            }

            // SNIPER MODE: Boost Leading Indicators in First 3 Minutes
            if (elapsed < 180) {
                weights.orderbook = (weights.orderbook || 1.0) * 1.5;
                weights.physicist = (weights.physicist || 1.0) * 1.5;
                weights.genesis = (weights.genesis || 1.0) * 1.3;  // Additional early boost
                weights.macro = (weights.macro || 1.0) * 0.5;
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
            // MODEL 9: WHALE DETECTION (Track large orders)
            const market = currentMarkets[this.asset];
            if (market && market.yesPrice && market.noPrice) {
                const spread = Math.abs(market.yesPrice - market.noPrice);
                const midPrice = (market.yesPrice + market.noPrice) / 2;
                // Detect whale activity: tight spread + price movement suggests informed trading
                if (spread < 0.05 && Math.abs(midPrice - 0.5) > 0.15) {
                    const whaleSignal = midPrice > 0.5 ? 'UP' : 'DOWN';
                    const whaleWeight = (weights.whale || 1.5); // Whales get priority
                    votes[whaleSignal] += 1.5 * whaleWeight;
                    modelVotes.whale = whaleSignal;
                    totalConfidence += 0.85; // High confidence in whale moves
                }
            }

            // Volume variable needed by MODEL 10 - must be defined BEFORE usage
            const vol = currentMarkets[this.asset]?.volume || 0;

            // MODEL 10: MARKET SENTIMENT (Aggregate market behavior)
            if (history.length > 10 && vol > 0) {
                const recentVolatility = MathLib.calculateATR(history.slice(-20), 5);
                const priceAcceleration = history.length > 3 ?
                    (history[history.length - 1].p - history[history.length - 3].p) : 0;
                const sentimentScore = (priceAcceleration / atr) + (vol > 100000 ? 0.3 : 0);
                const sentimentSignal = sentimentScore > 0 ? 'UP' : 'DOWN';
                const sentimentWeight = weights.sentiment || 1.0;
                if (Math.abs(sentimentScore) > 0.2) {
                    votes[sentimentSignal] += Math.abs(sentimentScore) * sentimentWeight;
                    modelVotes.sentiment = sentimentSignal;
                    totalConfidence += 0.70;
                }
            }

            // MODEL 8: VOLUME ANALYSIS (uses vol defined above)
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

            // === WATCHGUARDS + VOLATILITY CIRCUIT BREAKER ===
            const lag = Date.now() - (currentMarkets[this.asset]?.lastUpdated || 0);
            this.lagCounter = lag > 15000 ? this.lagCounter + 1 : 0;
            const isLagging = this.lagCounter >= 3;
            const isPanic = MathLib.isPanic(history);
            const isSpoofing = MathLib.isSpoofing(history);

            // 🔴 VOLATILITY CIRCUIT BREAKER: Pause if extreme volatility (3x normal ATR)
            const currentATR = MathLib.calculateATR(history.slice(-30), 5);
            const normalATR = MathLib.calculateATR(history.slice(-100, -30), 20);
            const isExtremeVolatility = currentATR > normalATR * 3.0;

            // 🔴 GOD MODE: LIQUIDITY VOID DETECTION (Wide spreads = danger zone)
            // If Yes + No significantly != 100 (spread > 5%), liquidity is thin
            const marketData = currentMarkets[this.asset];
            // 🔴 FORENSIC FIX: Null market = assume liquidity void (not safe), was defaulting to 0 (safe)
            const spread = marketData ? Math.abs(1 - (marketData.yesPrice + marketData.noPrice)) : 1.0;
            const isLiquidityVoid = spread > 0.05 || !marketData; // Explicit: no market = void
            if (isLiquidityVoid && marketData) {
                log(`⚠️ LIQUIDITY VOID: Spread ${(spread * 100).toFixed(1)}% (Yes ${(marketData.yesPrice * 100).toFixed(0)}¢ + No ${(marketData.noPrice * 100).toFixed(0)}¢ ≠ 100%)`, this.asset);
            }

            // 🔴 GOD MODE: FINAL 90 SECONDS BLOCK - No NEW predictions in last 90 seconds
            // Existing predictions are held via blackout, but new signals are killed
            // 🔴 UNBOUNDED FIX #7: 60s was too tight for sell execution, extended to 90s
            const isFinalMinute = elapsed >= 810; // 900-810 = 90 seconds before end

            if (isLagging || isPanic || isSpoofing || isExtremeVolatility || isLiquidityVoid || isFinalMinute) {
                votes.UP = 0; votes.DOWN = 0; totalConfidence = 0;
                if (isExtremeVolatility) log(`⚠️ CIRCUIT BREAKER: Extreme volatility detected (${(currentATR / normalATR).toFixed(1)}x normal)`, this.asset);
                if (isFinalMinute && !this.inBlackout) log(`⏱️ FINAL MINUTE: No new signals - holding current prediction`, this.asset);
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

            // 🔴🔴🔴 GENESIS HARD VETO 🔴🔴🔴
            // When Genesis accuracy >90%, it OVERRIDES the ensemble if it disagrees
            // Genesis has 94.4% accuracy - trust it over low-accuracy models
            const genesisAccForVeto = this.modelAccuracy.genesis;
            if (genesisAccForVeto.total >= 10) {
                const genesisAccuracyForVeto = genesisAccForVeto.wins / genesisAccForVeto.total;
                const genesisVote = modelVotes.genesis;

                if (genesisAccuracyForVeto > 0.90 && genesisVote && finalSignal !== 'NEUTRAL') {
                    if (finalSignal !== genesisVote) {
                        log(`⚠️ GENESIS VETO ACTIVATED ⚠️`, this.asset);
                        log(`   Ensemble says: ${finalSignal}`, this.asset);
                        log(`   Genesis says: ${genesisVote} (${(genesisAccuracyForVeto * 100).toFixed(1)}% accurate)`, this.asset);
                        log(`   OVERRIDING to: ${genesisVote}`, this.asset);
                        finalSignal = genesisVote;
                        finalConfidence = Math.max(finalConfidence, 0.85); // High confidence when Genesis vetoes
                    } else {
                        // Genesis agrees with ensemble - boost confidence
                        finalConfidence = Math.min(0.95, finalConfidence * 1.1);
                    }
                }
            }

            // === THRESHOLD DETERMINATION (Regime-Aware) ===
            // 🎯 AGGRESSIVE PROPHECY MODE: Optimized for £10→£1M Goal
            // Goal: Frequent, early predictions with acceptable accuracy
            // 🚀 PINNACLE v27: LOWERED THRESHOLDS to enable more 50% velocity trades
            let tier = 'NONE';
            let convictionThreshold = 0.70; // 🚀 LOWERED: 70% (was 75%) - Genesis protects us
            let advisoryThreshold = 0.55;   // 🚀 LOWERED: 55% (was 65%) - more trade opportunities

            // 🌍 ALL-WEATHER LOGIC: Adapt strategy to market regime
            // 🚀 PINNACLE v27: All thresholds lowered by 5-10% for more velocity
            if (regime === 'CHOPPY') {
                convictionThreshold = 0.75; // 🚀 LOWERED: 75% (was 80%) - still cautious but not frozen
                advisoryThreshold = 0.60;
                // Boost pattern matching  +  reduce momentum in choppy markets
                if (weights.pattern) weights.pattern *= 1.5;
                if (weights.physicist) weights.physicist *= 0.7;
            } else if (regime === 'TRENDING') {
                convictionThreshold = 0.60; // 🚀 LOWERED: 60% (was 65%) - ride the trend aggressively
                advisoryThreshold = 0.50;
                // Boost momentum + physicist in trending markets
                if (weights.physicist) weights.physicist *= 1.3;
                if (weights.genesis) weights.genesis *= 1.2;
            } else if (regime === 'VOLATILE') {
                convictionThreshold = 0.70; // 🚀 LOWERED: 70% (was 75%) - more opportunities
                advisoryThreshold = 0.55;
                // Boost ATR-based models in volatile markets
                if (weights.historian) weights.historian *= 1.2;
            } else { // STABLE
                convictionThreshold = 0.65; // 🚀 LOWERED: 65% (was 70%) - stable = predictable
                advisoryThreshold = 0.50;
                // Boost pattern matching in stable/predictable markets
                if (weights.pattern) weights.pattern *= 1.3;
            }

            // REGIME PERSISTENCE (Smooth out regime flips)
            this.regimeHistory.push(regime);
            if (this.regimeHistory.length > 5) this.regimeHistory.shift();
            const stableRegime = this.regimeHistory.length >= 3
                ? (this.regimeHistory.slice(-3).every(r => r === regime) ? regime : this.regimeHistory[0])
                : regime;

            // 🔮 NO-TRADE DETECTION: Genuinely random markets = don't gamble
            // If CHOPPY AND low vote differential AND confidence below 60%, REFUSE TO TRADE
            // Can be disabled from UI via CONFIG.RISK.noTradeDetection
            const voteDifferential = Math.abs(upVotes - downVotes) / (totalVotes || 1);
            const isGenuinelyRandom = stableRegime === 'CHOPPY' && voteDifferential < 0.25 && finalConfidence < 0.50; // OPTIMIZED: Stricter (only block really bad trades)

            if (CONFIG.RISK.noTradeDetection && isGenuinelyRandom) {
                finalSignal = 'NEUTRAL';
                finalConfidence = 0;
                log(`🎲 NO-TRADE: Market genuinely random (choppy + weak signal). Waiting for edge.`, this.asset);
            }

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
                // Cold streak: mild caution (was 15%/10% - too aggressive, blocked 82% trades)
                // 🔴 UNBOUNDED FIX: Reduced from 1.15/1.10 to 1.05/1.03
                convictionThreshold *= 1.05;  // +5% (vs +15%)
                advisoryThreshold *= 1.03;    // +3% (vs +10%)
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
            // === MOMENTUM BOOST (Advisory → Conviction Promotion) ===
            if (finalConfidence > 0.55 && finalConfidence < 0.70) { // Advisory range
                // If we are close to 0.70 and price is moving in our favor
                if ((finalSignal === 'UP' && force > 0) || (finalSignal === 'DOWN' && force < 0)) {
                    finalConfidence += 0.08; // OPTIMIZED: Stronger boost (+8%, was +5%)
                    log(`🚀 MOMENTUM BOOST: +8% (price moving in our favor)`, this.asset);
                }
            }

            // 🔮 ORACLE: FIRST-MOVE ADVANTAGE (Bonus for trading <30s)
            if (CONFIG.RISK.firstMoveAdvantage && elapsed < 30 && finalConfidence > 0.60) {
                const earlyBonus = ((30 - elapsed) / 30) * 0.10; // 0-10% bonus
                finalConfidence += earlyBonus;
                finalConfidence = Math.min(0.99, finalConfidence);
                log(`⚡ FIRST-MOVE ADVANTAGE: +${(earlyBonus * 100).toFixed(1)}% (${elapsed}s elapsed)`, this.asset);
            }

            // ==================== DEITY-LEVEL: CONFIDENCE FLOOR PROTECTION ====================
            // Prevent confidence death spiral - if models agree, maintain minimum confidence
            const consensusRatioCheck = totalVotes > 0 ? Math.max(votes.UP, votes.DOWN) / totalVotes : 0;
            if (consensusRatioCheck >= 0.70 && finalConfidence < 0.25) {
                log(`🛡️ CONFIDENCE FLOOR: Enforced 25% min (models ${(consensusRatioCheck * 100).toFixed(0)}% agree)`, this.asset);
                finalConfidence = 0.25;
            } else if (consensusRatioCheck >= 0.60 && finalConfidence < 0.15) {
                log(`🛡️ CONFIDENCE FLOOR: Enforced 15% min (models ${(consensusRatioCheck * 100).toFixed(0)}% agree)`, this.asset);
                finalConfidence = 0.15;
            }

            // 🔮 ORACLE: SUPREME CONFIDENCE ENFORCEMENT (softened - warn don't block)
            // DEITY: Instead of blocking, just log warning - let trades happen
            if (CONFIG.RISK.supremeConfidenceMode && finalConfidence < 0.75 && finalConfidence >= 0.50) {
                log(`🔮 SUPREME MODE: Warning - ${(finalConfidence * 100).toFixed(1)}% < 75% (trade allowed but lower tier)`, this.asset);
                // Don't block - just reduce tier if needed
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

            // ULTRA-OPTIMIZED: Block trades only if enabled AND extreme divergence (3+ assets disagree)
            if (CONFIG.RISK.enableDivergenceBlocking) {
                if ((finalSignal === 'UP' && downCount >= upCount + 3) ||
                    (finalSignal === 'DOWN' && upCount >= downCount + 3)) {
                    finalSignal = 'NEUTRAL'; // BLOCK trade entirely
                    finalConfidence = 0;
                    log(`🚫 BLOCKED: Extreme divergence from market (${upCount}U/${downCount}D)`, this.asset);
                }
            }
            // Mild divergence warning (doesn't block, just reduces confidence)
            if ((finalSignal === 'UP' && downCount > upCount + 1) ||
                (finalSignal === 'DOWN' && upCount > downCount + 1)) {
                finalConfidence *= 0.75; // Contrarian penalty
                log(`⚠️ Contrarian (${upCount}U/${downCount}D)`, this.asset);
            }

            if (trendBias) finalConfidence *= trendBias;

            // 🚫 EARLY BOOST REMOVED - User feedback: trading too early (first 15-20s)
            // Let confidence build naturally instead of artificially inflating it
            // The minElapsedSeconds config now prevents premature trading

            // CAP CONFIDENCE (prevent >100%)
            finalConfidence = Math.min(1.0, finalConfidence);

            // === SMOOTHING (The "Pinball" Fix) ===
            // ULTRA-OPTIMIZED: 70/30 smoothing (favor new data for faster response)
            // Alpha 0.7 = 70% new value, 30% old value (responsive)
            if (this.confidence > 0) {
                finalConfidence = (finalConfidence * 0.70) + (this.confidence * 0.30);
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

            // ==================== PINNACLE EVOLUTION: PHASE AWARENESS ====================
            // Know where we are in the cycle - different behavior at different times
            this.currentPhase = this.getCyclePhase(elapsed);

            // ==================== PINNACLE EVOLUTION: BLACKOUT ENFORCEMENT ====================
            // In final 60 seconds, NO PREDICTION CHANGES ALLOWED
            if (this.currentPhase === 'BLACKOUT') {
                this.inBlackout = true;
                if (this.lastBlackoutPrediction !== null) {
                    finalSignal = this.lastBlackoutPrediction;
                    if (!this.blackoutLogged) {
                        log(`⬛ BLACKOUT ACTIVE: Holding ${finalSignal} for final 60s - NO CHANGES`, this.asset);
                        this.blackoutLogged = true;
                    }
                }
                // Skip all further prediction changes during blackout
            } else {
                // Store prediction in case we enter blackout
                this.lastBlackoutPrediction = finalSignal;
                this.blackoutLogged = false;
                this.inBlackout = false;
            }

            // ==================== TRUE ORACLE: CERTAINTY CALCULATION ====================
            // Calculate meta-awareness: How certain are we that our confidence is REAL?
            const certainty = this.calculateCertainty(finalSignal, finalConfidence, votes, history, force, atr);

            // ==================== PINNACLE EVOLUTION: CERTAINTY VELOCITY ====================
            // Track rate of certainty change - is confidence growing or shrinking?
            const velocityData = this.calculateCertaintyVelocity(certainty);

            // ==================== PINNACLE EVOLUTION: CROSS-ASSET ALPHA ====================
            // Boost certainty if correlated with BTC's locked prediction
            const alphaBonus = this.getCrossAssetAlpha(finalSignal);
            const adjustedCertainty = Math.max(0, Math.min(100, certainty + alphaBonus));
            this.correlationBonus = alphaBonus;

            // ==================== TRUE ORACLE: DYNAMIC UNBREAKABLE LOCK ====================
            // Lock threshold adjusts based on velocity and phase
            const dynamicThreshold = this.getDynamicLockThreshold();

            // MOLECULAR FIX: Genesis MUST be defined AND agree with lock direction
            // Genesis has 94% accuracy - NEVER lock without it
            const genesisKnown = modelVotes.genesis !== undefined && modelVotes.genesis !== null;
            const genesisAgrees = genesisKnown && modelVotes.genesis === finalSignal;

            // Once certainty reaches threshold, the oracle has spoken. NO CHANGES ALLOWED.
            // CRITICAL: Genesis MUST agree for lock to activate (92% accuracy = trust it)
            if (!this.oracleLocked && !this.inBlackout &&
                adjustedCertainty >= dynamicThreshold && finalSignal !== 'NEUTRAL' &&
                genesisAgrees) {  // NEW: Genesis veto requirement
                this.oracleLocked = true;
                this.oracleLockPrediction = finalSignal;
                this.lockCertainty = adjustedCertainty;
                log(`🔮 ═══════════════════════════════════════════════════`, this.asset);
                log(`🔮 TRUE ORACLE LOCK: ${finalSignal} @ ${adjustedCertainty.toFixed(0)} certainty`, this.asset);
                log(`🔮 Threshold: ${dynamicThreshold} | Velocity: ${velocityData.velocity.toFixed(1)} | Phase: ${this.currentPhase}`, this.asset);
                log(`🔮 Genesis: ${modelVotes.genesis || 'N/A'} (AGREES ✅)`, this.asset);
                if (alphaBonus !== 0) log(`🔮 Alpha Bonus: ${alphaBonus > 0 ? '+' : ''}${alphaBonus} (BTC correlation)`, this.asset);
                log(`🔮 This prediction is FINAL and will NOT change this cycle.`, this.asset);
                log(`🔮 ═══════════════════════════════════════════════════`, this.asset);
            } else if (!this.oracleLocked && !this.inBlackout &&
                adjustedCertainty >= dynamicThreshold && finalSignal !== 'NEUTRAL' &&
                !genesisAgrees) {
                // Genesis VETO - don't lock yet
                log(`🛡️ GENESIS VETO: Would lock ${finalSignal} but genesis says ${modelVotes.genesis}`, this.asset);
            }

            // IF ORACLE LOCKED: Override EVERYTHING to maintain locked prediction
            if (this.oracleLocked) {
                // UNBREAKABLE: No matter what the models say, we hold our position
                finalSignal = this.oracleLockPrediction;
                tier = 'CONVICTION';  // Always show as CONVICTION when oracle locked
                // Confidence can still update for display, but direction is FIXED
                // Only log every 30s to reduce spam
                if (elapsed % 30 < 2) {
                    log(`🔮 ORACLE HOLDING: ${finalSignal} | Certainty: ${adjustedCertainty.toFixed(0)} | Vel: ${velocityData.velocity.toFixed(1)}`, this.asset);
                }
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
                // ULTRA-OPTIMIZED: Instant entry for high-confidence signals
                let requiredStability = 1; // Instant (was 2) - trust the ensemble
                if (tier === 'CONVICTION' && finalConfidence >= 0.80) requiredStability = 1; // INSTANT for ultra-high confidence
                else if (elapsed < 180) requiredStability = 1; // SNIPER: Immediate
                else requiredStability = 1; // Always instant now

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
                    // ATOMIC UPDATE: Prediction + Confidence + Tier all change TOGETHER
                    this.prediction = finalSignal;
                    this.confidence = finalConfidence;
                    this.tier = tier;
                    // CRITICAL: Calculate and store edge for API/dashboard
                    const market = currentMarkets[this.asset];
                    if (market && finalSignal !== 'NEUTRAL') {
                        const marketProb = finalSignal === 'UP' ? market.yesPrice : market.noPrice;
                        this.edge = marketProb > 0 ? ((finalConfidence - marketProb) / marketProb) * 100 : 0;
                    } else {
                        this.edge = 0; // Zero edge for NEUTRAL
                    }
                    this.stabilityCounter = 0;
                    this.pendingSignal = null;
                    log(`✅ PREDICTION FLIP: ${finalSignal} @ ${(finalConfidence * 100).toFixed(1)}%`, this.asset);
                }
                // REMOVED: The broken code that updated confidence separately from prediction
                // That was causing "UP at 0%" and "NEUTRAL at 40%" bugs
            } else {
                // Signal is SAME as current prediction - safe to update confidence/tier
                this.confidence = finalConfidence;
                this.tier = tier;
                // CRITICAL: Also update edge on same-direction confidence updates
                const market = currentMarkets[this.asset];
                if (market && this.prediction !== 'NEUTRAL' && this.prediction !== 'WAIT') {
                    const marketProb = this.prediction === 'UP' ? market.yesPrice : market.noPrice;
                    this.edge = marketProb > 0 ? ((finalConfidence - marketProb) / marketProb) * 100 : 0;
                }
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
            // 🕐 minElapsedSeconds: Wait for confidence to build before trading
            const minElapsed = CONFIG.ORACLE.minElapsedSeconds || 60;
            // 🎯 COMPREHENSIVE ANALYSIS FIX: ONLY trade CONVICTION/ADVISORY tiers (NONE tier blocked - 43.9% win rate)
            // CONVICTION = 98.9% win rate, ADVISORY = 98.0% win rate
            // 🚫 CRITICAL: XRP NONE tier has 0.5% accuracy - BLOCK COMPLETELY
            if (tier === 'NONE' && this.asset === 'XRP') {
                log(`🚫 HARD BLOCK: XRP NONE tier has 0.5% accuracy - BLOCKED`, this.asset);
                // Do not trade - fall through to end
            } else {
            const meetsAdvisoryThreshold = tier === 'CONVICTION' || (tier === 'ADVISORY' && finalConfidence >= 0.80);
                // 🎯 COMPREHENSIVE ANALYSIS: Time-based filtering - prefer best hours (14:00-16:00 = 80%+ win rate)
                const currentHour = new Date().getUTCHours(); // Use UTC for consistency
                const isBestHour = currentHour >= 14 && currentHour <= 16;
                // Allow trading in best hours OR if CONVICTION tier (high confidence overrides time)
                const timeFilterPass = isBestHour || tier === 'CONVICTION';
                
                if (CONFIG.ORACLE.enabled && !this.convictionLocked && meetsAdvisoryThreshold && timeFilterPass && elapsed >= minElapsed && elapsed < 600) {
                const market = currentMarkets[this.asset];
                if (market) {
                    const currentOdds = finalSignal === 'UP' ? market.yesPrice : market.noPrice;
                    // 🎯 COMPREHENSIVE ANALYSIS: Only trade at extreme odds (<20c or >95c) unless CONVICTION
                    // CONVICTION can trade mid-range (50-80c) but extremes are preferred (99%+ win rate)
                    const isExtremeOdds = currentOdds < 0.20 || currentOdds > 0.95;
                    if (!isExtremeOdds && tier !== 'CONVICTION') {
                        log(`🚫 ENTRY PRICE FILTER: Mid-range odds ${(currentOdds * 100).toFixed(1)}¢ - only CONVICTION can trade mid-range`, this.asset);
                        // Do not trade - fall through to end
                    } else {
                    const consensusVotes = Math.max(votes.UP, votes.DOWN);
                    const consensusRatio = totalVotes > 0 ? consensusVotes / totalVotes : 0;
                    // CRITICAL FIX: Use RELATIVE edge formula (not absolute) AND account for 2% Polymarket fee
                    const POLYMARKET_FEE = 0.02; // 2% fee on winnings
                    const effectiveConfidence = finalConfidence * (1 - POLYMARKET_FEE); // Reduce by fee
                    const edgePercent = currentOdds > 0 ? ((effectiveConfidence - currentOdds) / currentOdds) * 100 : 0;
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

                    // ==================== MOLECULAR FIX: HARD BLOCKS (Cannot be bypassed by aggression) ====================
                    // 1. NEGATIVE EDGE = GUARANTEED LOSS - Never trade!
                    if (edgePercent < 0) {
                        log(`🚫 ORACLE HARD BLOCK: Negative edge ${edgePercent.toFixed(1)}% = guaranteed loss`, this.asset);
                        // Do not trade - fall through to end
                    }
                    // 2. GENESIS DISAGREEMENT = 94% accurate model says NO
                    else if (modelVotes.genesis && modelVotes.genesis !== finalSignal) {
                        log(`🛡️ ORACLE HARD BLOCK: Genesis (94% accurate) says ${modelVotes.genesis}, not ${finalSignal}`, this.asset);
                        // Do not trade - fall through to end
                    }
                    // 3. MINIMUM HARD FLOOR: Even with max aggression, need 5% absolute edge
                    else if (edgePercent < 5) {
                        log(`⚠️ ORACLE HARD BLOCK: Edge ${edgePercent.toFixed(1)}% below 5% minimum floor`, this.asset);
                        // Do not trade - fall through to end
                    }
                    else {
                        // ==================== v42 IMMUTABLE PROPHET: GOD / TREND MODES ====================

                        // 1. GOD MODE (>90%): 0 Historical Failures -> EXECUTE IMMEDIATELY
                        const isGodMode = finalConfidence > 0.90;

                        // 2. TREND MODE (80-90%): Execute ONLY if Trend Aligned (Buy High / Short Low)
                        // This CAPTURES the 5:45 velocity trade (60c) and BLOCKS the 80% reversals
                        let isTrendMode = false;
                        if (!isGodMode && finalConfidence > 0.80) {
                            const isTrendUP = finalSignal === 'UP' && currentOdds > 0.50;
                            const isTrendDOWN = finalSignal === 'DOWN' && currentOdds > 0.50; // FIX: Trend = NO price > 0.50
                            if (isTrendUP || isTrendDOWN) {
                                isTrendMode = true;
                            }
                        }

                        if (isGodMode || isTrendMode) {
                            // BYPASS ALL STANDARD CHECKS (Consensus, Momentum, Regime, etc.)
                            this.convictionLocked = true;
                            this.lockedDirection = finalSignal;
                            this.lockTime = Date.now();
                            this.lockConfidence = finalConfidence;

                            const modeName = isGodMode ? "GOD MODE (>90%) ⚡" : "TREND MODE (80-90% + Trend) 🌊";
                            log(`🔮🔮🔮 ${modeName} ACTIVATED 🔮🔮🔮`, this.asset);
                            log(`⚡ PROPHET SIGNAL: ${finalSignal} @ ${(finalConfidence * 100).toFixed(1)}% | Edge: ${edgePercent.toFixed(1)}% | Odds: ${currentOdds}`, this.asset);

                            tradeExecutor.executeTrade(this.asset, finalSignal, 'ORACLE', finalConfidence, currentOdds, market, { tier: tier });
                        }
                        else {
                            // Safe to proceed with normal checks

                            const oracleChecks = {
                                consensus: consensusRatio >= adjustedMinConsensus,
                                confidence: finalConfidence >= adjustedMinConfidence,
                                edge: edgePercent >= adjustedMinEdge,
                                regime: !tradeExecutor.getEffectiveRequireTrending() || isTrending, // 🦅 v21: Dynamic SNIPER/HUNTER
                                momentum: !CONFIG.ORACLE.requireMomentum || priceMovingRight,
                                odds: currentOdds <= tradeExecutor.getEffectiveMaxOdds(), // 🦅 v21: Dynamic (0.48 SNIPER / 0.50 HUNTER)
                                stability: this.stabilityCounter >= tradeExecutor.getEffectiveMinStability() || this.prediction === finalSignal // 🦅 v21: Dynamic
                            };

                            const failedChecks = Object.entries(oracleChecks).filter(([k, v]) => !v).map(([k]) => k);


                            if (failedChecks.length === 0) {
                                this.convictionLocked = true;
                                this.lockedDirection = finalSignal;
                                this.lockTime = Date.now();
                                this.lockConfidence = finalConfidence;

                                log(`🔮🔮🔮 ORACLE MODE ACTIVATED 🔮🔮🔮`, this.asset);
                                log(`⚡ PROPHET SIGNAL: ${finalSignal} @ ${(finalConfidence * 100).toFixed(1)}% | Edge: ${edgePercent.toFixed(1)}%`, this.asset);

                                tradeExecutor.executeTrade(this.asset, finalSignal, 'ORACLE', finalConfidence, currentOdds, market, { tier: tier });
                            } else {
                                log(`⏳ ORACLE: Missing ${failedChecks.join(', ')}`, this.asset);
                            }
                        }
                            }
                        }
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

                        // ILLIQUIDITY is a paired trade (BOTH sides). Use total entry cost for logging.
                        const entryPrice = opp.direction === 'BOTH' ? (yesPrice + noPrice) : (opp.direction === 'UP' ? yesPrice : noPrice);
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
                    // BUG FIX #24: Use RELATIVE edge formula like all other edge calculations
                    const lateEdge = lateEntryPrice > 0 ? ((finalConfidence - lateEntryPrice) / lateEntryPrice) * 100 : 0;

                    if (lateEdge >= 10) { // Only if 10%+ edge
                        log(`⚡ LATE CYCLE OPPORTUNITY: Odds at ${(yesP * 100).toFixed(0)}% (near 50/50), confidence ${(finalConfidence * 100).toFixed(0)}%`, this.asset);
                        log(`🎯 LATE ENTRY: ${finalSignal} @ ${(lateEntryPrice * 100).toFixed(1)}¢ with ${lateEdge.toFixed(1)}% edge`, this.asset);

                        // Execute as ORACLE trade (hold to resolution)
                        tradeExecutor.executeTrade(this.asset, finalSignal, 'ORACLE', finalConfidence, lateEntryPrice, market);
                    }
                }
            }

            // EDGE CALCULATION - Use CURRENT cycle values, not stale ones
            // BUG FIX: Was using this.confidence (previous) instead of finalConfidence (current)
            // BUG FIX 2: Must use RELATIVE formula ((conf-market)/market) like lines 2954/2967
            // v32 FIX: Add comprehensive validation and logging to prevent 0% edge bugs
            if (currentMarkets[this.asset] && finalSignal !== 'NEUTRAL') {
                const market = currentMarkets[this.asset];
                const marketProb = finalSignal === 'UP' ? market.yesPrice : market.noPrice;

                // v32: VALIDATE market data before calculation
                if (!marketProb || marketProb <= 0 || marketProb >= 1) {
                    log(`⚠️ INVALID MARKET PROB: ${marketProb} for ${finalSignal} - edge set to 0`, this.asset);
                    this.edge = 0;
                } else {
                    // v33 FINAL ENDGAME: Apply 1% slippage buffer to edge calculation
                    // This accounts for real execution costs and prevents false-positive edges
                    const SLIPPAGE_BUFFER = 0.01; // 1% slippage assumption
                    const adjustedMarketProb = marketProb * (1 + SLIPPAGE_BUFFER);
                    this.edge = ((finalConfidence - adjustedMarketProb) / adjustedMarketProb) * 100;

                    // v33: Enhanced logging for ALL high-conf predictions
                    if (finalConfidence >= 0.70) {
                        log(`📊 EDGE: conf=${(finalConfidence * 100).toFixed(1)}% vs market=${(marketProb * 100).toFixed(1)}% (+1% slip) = ${this.edge.toFixed(1)}% edge`, this.asset);
                    }
                }
            } else {
                // v32: Log why edge is 0
                if (!currentMarkets[this.asset]) {
                    log(`⚠️ NO MARKET DATA - edge set to 0`, this.asset);
                } else if (finalSignal === 'NEUTRAL') {
                    log(`ℹ️ NEUTRAL signal - edge set to 0`, this.asset);
                }
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

    // ==================== TRUE ORACLE: CERTAINTY CALCULATION ====================
    // Meta-awareness: Calculate how certain we are that our confidence is REAL

    calculateCertainty(finalSignal, finalConfidence, votes, history, force, atr) {
        let certainty = 0;

        // === COMPONENT 1: Model Agreement Stability (0-25 points) ===
        // Not just "models agree NOW" but "have they agreed consistently?"
        const currentAgreement = finalSignal !== 'NEUTRAL' ? finalSignal : null;
        this.modelAgreementHistory.push(currentAgreement);
        if (this.modelAgreementHistory.length > 5) this.modelAgreementHistory.shift();

        if (this.modelAgreementHistory.length >= 3 && currentAgreement) {
            const consistentCount = this.modelAgreementHistory.filter(a => a === currentAgreement).length;
            const stability = consistentCount / this.modelAgreementHistory.length;
            certainty += stability * 25;
        }

        // === COMPONENT 2: Price Confirmation (0-25 points) ===
        // Is price actually moving in our predicted direction?
        const currentPrice = livePrices[this.asset];
        const checkpointPrice = checkpointPrices[this.asset];
        if (currentPrice && checkpointPrice && finalSignal !== 'NEUTRAL') {
            const priceDirection = currentPrice > checkpointPrice ? 'UP' : 'DOWN';
            const priceChange = Math.abs(currentPrice - checkpointPrice) / checkpointPrice;

            if (priceDirection === finalSignal) {
                // Price moving our way - add points based on magnitude
                const confirmStrength = Math.min(1, priceChange / (atr * 3));
                this.priceConfirmationScore = confirmStrength * 25;
                certainty += this.priceConfirmationScore;
            } else if (priceChange > atr * 0.5) {
                // Price moving against us significantly - reduce certainty
                certainty -= 10;
            }
        }

        // === COMPONENT 3: Manipulation Detection (0-20 points) ===
        // Detect fake-outs, wash trading, volume divergence
        this.manipulationScore = this.detectManipulation(history, force, atr);
        const manipPoints = (1 - this.manipulationScore) * 20;
        certainty += manipPoints;

        // === COMPONENT 4: Pattern Match Quality (0-15 points) ===
        // How well does this match winning vs losing patterns?
        const patternQuality = this.getPatternMatchQuality(history, finalSignal);
        certainty += patternQuality;

        // === COMPONENT 5: Edge Persistence (0-15 points) ===
        // Has edge been stable or bouncing wildly?
        const market = currentMarkets[this.asset];
        if (market && finalSignal !== 'NEUTRAL') {
            const currentOdds = finalSignal === 'UP' ? market.yesPrice : market.noPrice;
            const currentEdge = currentOdds > 0 ? ((finalConfidence - currentOdds) / currentOdds) * 100 : 0;

            this.edgeHistory.push(currentEdge);
            if (this.edgeHistory.length > 5) this.edgeHistory.shift();

            if (this.edgeHistory.length >= 3) {
                const avgEdge = this.edgeHistory.reduce((a, b) => a + b, 0) / this.edgeHistory.length;
                const variance = this.edgeHistory.reduce((sum, e) => sum + Math.pow(e - avgEdge, 2), 0) / this.edgeHistory.length;
                const stdDev = Math.sqrt(variance);

                // Stable edge (low variance) = high points
                if (stdDev < 5 && avgEdge > 10) {
                    certainty += 15;
                } else if (stdDev < 10 && avgEdge > 5) {
                    certainty += 10;
                } else if (stdDev < 15) {
                    certainty += 5;
                }
                // High variance = bouncing = no points (already at 0)
            }
        }

        // Track certainty history
        this.certaintyHistory.push(certainty);
        if (this.certaintyHistory.length > 10) this.certaintyHistory.shift();

        this.certaintyScore = Math.max(0, Math.min(100, certainty));
        return this.certaintyScore;
    }

    // Detect manipulation: volume divergence, rapid reversals, wash trading
    detectManipulation(history, force, atr) {
        if (!history || history.length < 20) return 0;

        let manipulationIndicators = 0;

        // 1. Volume Divergence: Big price move without volume
        const recentPrices = history.slice(-10).map(h => h.p);
        const priceMove = Math.abs(recentPrices[recentPrices.length - 1] - recentPrices[0]);
        // If price moved > 2 ATR but we don't have volume confirmation, suspicious
        if (priceMove > atr * 2) {
            manipulationIndicators += 0.3;
        }

        // 2. Rapid Reversal: Price spiked then immediately reversed
        if (history.length >= 5) {
            const last5 = history.slice(-5).map(h => h.p);
            const max5 = Math.max(...last5);
            const min5 = Math.min(...last5);
            const range5 = max5 - min5;
            const currentPos = (last5[4] - min5) / range5; // Where is current price in range?

            // If we're near middle of recent range, there was a reversal
            if (currentPos > 0.3 && currentPos < 0.7 && range5 > atr * 2) {
                manipulationIndicators += 0.3;
            }
        }

        // 3. Extreme Force but no follow-through
        const absForce = Math.abs(force);
        if (absForce > atr * 3) {
            // Check if force is slowing down (derivative decreasing)
            if (history.length >= 3) {
                const forces = [];
                for (let i = history.length - 3; i < history.length - 1; i++) {
                    forces.push(history[i + 1].p - history[i].p);
                }
                const forceDecelerating = Math.abs(forces[1]) < Math.abs(forces[0]) * 0.5;
                if (forceDecelerating) {
                    manipulationIndicators += 0.2;
                }
            }
        }

        return Math.min(1, manipulationIndicators);
    }

    // Get pattern match quality score (0-15)
    getPatternMatchQuality(history, signal) {
        if (!history || history.length < 10 || !memoryPatterns[this.asset]) return 7.5; // Neutral

        try {
            const recent = history.slice(-10).map(x => x.p);
            const base = recent[0];
            const vector = recent.map(p => (p - base) / base);

            const patterns = memoryPatterns[this.asset];
            if (patterns.length === 0) return 7.5;

            let bestMatchScore = 0;
            let matchToWinner = false;

            for (const pattern of patterns) {
                if (!pattern.vector || pattern.vector.length !== vector.length) continue;

                // Dynamic Time Warping distance
                const dist = MathLib.dtwDistance(vector, pattern.vector);
                const similarity = Math.max(0, 1 - dist);

                if (similarity > bestMatchScore) {
                    bestMatchScore = similarity;
                    // Check if this pattern has good track record
                    if (pattern.wins && pattern.matchCount) {
                        matchToWinner = (pattern.wins / pattern.matchCount) > 0.6;
                    }
                }
            }

            // High similarity to winning pattern = high points
            if (bestMatchScore > 0.8 && matchToWinner) {
                return 15;
            } else if (bestMatchScore > 0.6 && matchToWinner) {
                return 12;
            } else if (bestMatchScore > 0.5) {
                return 8;
            }
            return 5;
        } catch (e) {
            return 7.5;
        }
    }

    // ==================== PINNACLE EVOLUTION: NEW METHODS ====================

    // 1. CYCLE PHASE AWARENESS - Know where we are in the 15-minute cycle
    getCyclePhase(elapsed) {
        if (elapsed < 60) return 'GENESIS';        // 0-1 min: High uncertainty, best odds
        if (elapsed < 300) return 'FORMATION';     // 1-5 min: Trend forming
        if (elapsed < 600) return 'CONFIRMATION';  // 5-10 min: Trend confirmed
        if (elapsed < 840) return 'RESOLUTION';    // 10-14 min: Die mostly cast
        return 'BLACKOUT';                         // 14-15 min: NO CHANGES ALLOWED
    }

    // Dynamic threshold adjustment based on cycle phase
    getPhaseAdjustedThreshold(phase, baseThreshold) {
        switch (phase) {
            case 'GENESIS': return baseThreshold * 1.05;      // Slightly higher bar early (less data)
            case 'FORMATION': return baseThreshold;           // Normal threshold
            case 'CONFIRMATION': return baseThreshold * 0.92; // Lower bar mid-cycle (more data)
            case 'RESOLUTION': return baseThreshold * 0.85;   // Even lower late (trend confirmed)
            case 'BLACKOUT': return 999;                      // Never trigger new trades
            default: return baseThreshold;
        }
    }

    // 2. CERTAINTY VELOCITY TRACKING - Rate of confidence change
    calculateCertaintyVelocity(currentCertainty) {
        this.certaintySeries.push(currentCertainty);
        if (this.certaintySeries.length > 5) this.certaintySeries.shift();

        if (this.certaintySeries.length >= 2) {
            const prev = this.certaintySeries[this.certaintySeries.length - 2];
            this.certaintyVelocity = currentCertainty - prev;

            if (this.certaintySeries.length >= 3) {
                const prevVel = this.certaintySeries[this.certaintySeries.length - 2] -
                    this.certaintySeries[this.certaintySeries.length - 3];
                this.certaintyAcceleration = this.certaintyVelocity - prevVel;
            }
        }

        return {
            velocity: this.certaintyVelocity,
            acceleration: this.certaintyAcceleration,
            isGrowing: this.certaintyVelocity > 0,
            isAccelerating: this.certaintyAcceleration > 0
        };
    }

    // Get dynamic lock threshold based on velocity
    getDynamicLockThreshold() {
        // PINNACLE FIX: Base threshold lowered from 80 to 70
        // Debug export showed: ETH locks at 67-83, SOL at 68-79, XRP at 77-83
        // BTC never reaches 80 (max 54) - lowering enables more locks
        let threshold = 70;

        // VOTE RATIO TRIGGER: If models strongly agree, lower threshold further
        const lastVote = this.voteHistory[this.voteHistory.length - 1];
        if (lastVote) {
            const ratio = Math.max(lastVote.up, lastVote.down) / (Math.min(lastVote.up, lastVote.down) || 1);
            if (ratio > 3.0) {
                threshold -= 8;  // Strong consensus = lock at 62
            } else if (ratio > 2.0) {
                threshold -= 5;  // Good consensus = lock at 65
            }
        }

        if (this.certaintyVelocity > 5) {
            threshold -= 8;  // Growing fast = lock at 62 (was 72)
        } else if (this.certaintyVelocity > 2) {
            threshold -= 5;  // Growing = lock at 65 (was 75)
        } else if (this.certaintyVelocity < -3) {
            threshold += 5;  // Shrinking = require 75 (was 85)
        }

        // Phase adjustment
        if (this.currentPhase === 'RESOLUTION') {
            threshold -= 5;  // Late cycle = lower threshold
        } else if (this.currentPhase === 'GENESIS') {
            threshold += 5;  // Early = higher threshold
        }

        // MOLECULAR FIX: Min threshold now 80 (was 55) - only lock on HIGH certainty
        // Max threshold 95 to allow locks on exceptional signals
        return Math.max(80, Math.min(95, threshold));
    }

    // 3. CROSS-ASSET ALPHA TRANSFER - Boost from correlated assets
    getCrossAssetAlpha(finalSignal) {
        if (this.asset === 'BTC') return 0; // BTC is the leader, no boost

        // Check BTC's state
        const btcBrain = typeof Brains !== 'undefined' ? Brains['BTC'] : null;
        if (!btcBrain) return 0;

        const btcCertainty = btcBrain.certaintyScore || 0;
        const btcDirection = btcBrain.prediction;
        const btcLocked = btcBrain.oracleLocked || false;

        // Only transfer alpha if BTC is highly certain and locked
        if (!btcLocked || btcCertainty < 85) return 0;

        // Direction must match for positive alpha
        if (btcDirection !== finalSignal) return -5; // Penalty for disagreeing with BTC

        // Correlation strength varies by asset
        if (this.asset === 'ETH') {
            return 10; // ETH strongly follows BTC
        } else if (this.asset === 'SOL') {
            return 7;  // SOL follows but is more volatile
        } else if (this.asset === 'XRP') {
            return 4;  // XRP is less correlated
        }

        return 0;
    }

    // 4. DYNAMIC SCALP EXPECTED VALUE
    calculateScalpEV(odds, timeRemaining, atr) {
        // Historical bounce rate based on current odds
        const extremeness = Math.abs(odds - 0.5) * 2;
        let bounceProb = 0;

        if (odds >= 0.95 || odds <= 0.05) bounceProb = 0.45;
        else if (odds >= 0.90 || odds <= 0.10) bounceProb = 0.35;
        else if (odds >= 0.85 || odds <= 0.15) bounceProb = 0.25;
        else bounceProb = 0.15;

        // Adjust for time remaining (more time = more chance of bounce)
        bounceProb *= Math.min(1, timeRemaining / 600);

        // Adjust for volatility (higher vol = more bounce potential)
        const normalATR = this.atrMultiplier * 0.002; // Baseline ATR
        if (atr > 0 && normalATR > 0) {
            bounceProb *= Math.min(2, 1 + (atr / normalATR) * 0.5);
        }

        // Expected value calculation
        // If odds are 95% YES, we buy NO at 5¢
        // Potential profit if bounces to 50%: ~45¢ (9x)
        // But more realistically bounces to 20%: ~15¢ (3x)
        const entryPrice = odds > 0.5 ? (1 - odds) : odds;
        const targetBounce = 0.35; // Conservative target (not 50%)
        const potentialProfit = targetBounce - entryPrice;
        const maxLoss = entryPrice; // If it goes to 0

        const expectedValue = (bounceProb * potentialProfit) - ((1 - bounceProb) * maxLoss * 0.5);

        return {
            bounceProb: bounceProb,
            expectedValue: expectedValue,
            potentialProfit: potentialProfit,
            shouldTrade: expectedValue > 0.03 && bounceProb > 0.25
        };
    }

    // 5. BLACKOUT CHECK - Is trading allowed?
    isInBlackout(elapsed) {
        return elapsed >= 840; // Final 60 seconds
    }

    // KELLY CRITERION (Enhanced Position Sizing)
    getKellySize() {
        if (this.confidence < 0.6 || this.tier === 'NONE') return 0;

        const market = currentMarkets[this.asset];
        if (!market) return 0;

        const marketOdds = this.prediction === 'UP' ? market.yesPrice : market.noPrice;

        // GOD MODE: Division by zero protection
        // marketOdds = 0: Infinity odds = undefined return 0
        // marketOdds = 1: b would be 0, causing division by zero
        if (!marketOdds || marketOdds <= 0 || marketOdds >= 1) return 0;

        const b = (1 / marketOdds) - 1;
        if (b <= 0) return 0; // Additional safety check

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

        // ULTRA-OPTIMIZED: Aggressive sizing mode (don't reduce on losses)
        if (this.lossStreak > 2 && !CONFIG.RISK.aggressiveSizingOnLosses) {
            kellyFraction *= 0.5; // Only reduce if aggressive mode is OFF
        }

        // ULTRA-OPTIMIZED: Dynamic sizing based on market liquidity
        let maxSize = 0.15; // Default 15%

        // Reduce size if market is illiquid (thin order book)
        if (market && market.volume) {
            if (market.volume < 50000) maxSize = 0.10; // Small market = smaller positions
            else if (market.volume > 200000) maxSize = 0.20; // Liquid market = larger positions OK
        }

        // Half Kelly for aggressive compounding
        const aggressiveKelly = kellyFraction * 0.50;

        return Math.max(0, Math.min(aggressiveKelly, maxSize));
    }

    evaluateOutcome(finalPrice, startPrice) {
        if (!startPrice) return;

        const actual = finalPrice >= startPrice ? 'UP' : 'DOWN'; // FIXED: Tie = UP wins
        const predicted = this.lastSignal ? this.lastSignal.type : 'NEUTRAL';
        const tier = this.lastSignal ? this.lastSignal.tier : 'NONE';

        if (predicted !== 'NEUTRAL') {
            this.stats.total++;
            const isWin = predicted === actual;

            if (isWin) {
                this.stats.wins++;
                this.winStreak++;
                this.lossStreak = 0;
                this.atrMultiplier = Math.max(1.0, this.atrMultiplier - 1.2); // OPTIMIZED: Faster adaptation (was -0.80)
                if (tier === 'CONVICTION') { this.stats.convictionTotal++; this.stats.convictionWins++; }
                log(`✅ WIN (${tier}). Evolving: ATR x${this.atrMultiplier.toFixed(2)}`, this.asset);
            } else {
                this.winStreak = 0;
                this.lossStreak++;
                this.atrMultiplier = Math.min(4.0, this.atrMultiplier + 3.5); // OPTIMIZED: Faster caution (was +2.50)
                if (tier === 'CONVICTION') { this.stats.convictionTotal++; }
                log(`❌ LOSS (${tier}). Evolving: ATR x${this.atrMultiplier.toFixed(2)}`, this.asset);
            }

            // FINAL SEVEN: CALIBRATION TRACKING
            if (this.lastSignal && this.lastSignal.conf) {
                const conf = this.lastSignal.conf;
                const bucket = conf >= 0.98 ? '0.98-1.00' :
                    (conf >= 0.95 ? '0.95-0.98' :
                        (conf >= 0.90 ? '0.90-0.95' :
                            (conf >= 0.80 ? '0.80-0.90' :
                                (conf >= 0.70 ? '0.70-0.80' :
                                    (conf >= 0.60 ? '0.60-0.70' : '0.50-0.60')))));
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

                // ==================== DEBUG EXPORT: SAVE CYCLE DATA ====================
                // Store complete cycle data for debugging (last 5 cycles)
                const cycleSnapshot = {
                    cycleEndTime: new Date().toISOString(),
                    cycleStartPrice: startPrice,
                    cycleEndPrice: finalPrice,
                    actualOutcome: actual,
                    prediction: predicted,
                    wasCorrect: isWin,
                    tier: tier,
                    confidence: this.lastSignal?.confidence || 0,
                    certaintyAtEnd: this.certaintyScore,
                    certaintyVelocityAtEnd: this.certaintyVelocity,
                    phaseAtEnd: this.currentPhase,
                    oracleWasLocked: this.oracleLocked,
                    oracleLockPrediction: this.oracleLockPrediction,
                    lockCertainty: this.lockCertainty,
                    manipulationScore: this.manipulationScore,
                    correlationBonus: this.correlationBonus,
                    wasInBlackout: this.inBlackout,
                    cycleCommitted: this.cycleCommitted,
                    committedDirection: this.committedDirection,
                    genesisTraded: this.genesisTraded,
                    genesisTradeDirection: this.genesisTradeDirection,
                    stats: { ...this.stats },
                    winStreak: this.winStreak,
                    lossStreak: this.lossStreak,
                    modelVotes: this.lastSignal?.modelVotes || {},
                    certaintySeries: [...(this.certaintySeries || [])],
                    modelAgreementHistory: [...(this.modelAgreementHistory || [])],
                    edgeHistory: [...(this.edgeHistory || [])],
                    marketOdds: currentMarkets[this.asset] ? {
                        yesPrice: currentMarkets[this.asset].yesPrice,
                        noPrice: currentMarkets[this.asset].noPrice
                    } : null
                };

                // Add to history (max 10 cycles)
                if (!cycleDebugHistory[this.asset]) cycleDebugHistory[this.asset] = [];
                cycleDebugHistory[this.asset].push(cycleSnapshot);
                if (cycleDebugHistory[this.asset].length > 10) {
                    cycleDebugHistory[this.asset].shift();
                }
                log(`📊 DEBUG: Saved cycle data (${cycleDebugHistory[this.asset].length}/10 cycles stored)`, this.asset);

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

                // ==================== TRUE ORACLE: RESET FOR NEW CYCLE ====================
                this.oracleLocked = false;
                this.oracleLockPrediction = null;
                this.lockCertainty = 0;
                this.certaintyScore = 0;
                this.certaintyHistory = [];
                this.modelAgreementHistory = [];
                this.edgeHistory = [];
                this.priceConfirmationScore = 0;
                this.manipulationScore = 0;

                // ==================== PINNACLE EVOLUTION: RESET FOR NEW CYCLE ====================
                this.certaintySeries = [];
                this.certaintyVelocity = 0;
                this.certaintyAcceleration = 0;
                this.currentPhase = 'GENESIS';
                this.phaseThresholdModifier = 1.0;
                this.genesisTraded = false;
                this.genesisTradeDirection = null;
                this.lastBlackoutPrediction = null;
                this.blackoutLogged = false;
                this.inBlackout = false;
                this.correlationBonus = 0;

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
// Treat ANY valid feed (chainlink OR backup) as "live" to prevent total stalls.
// We still track chainlink separately for diagnostics.
let lastLiveDataTime = Date.now();
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
        lastLiveDataTime = Date.now(); // Reset on connection

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

        // 🔮 FEED STABILITY: Check for stale data every 15 seconds
        wsTimeoutInterval = setInterval(() => {
            const staleAnyMs = Date.now() - lastLiveDataTime;
            const staleChainlinkMs = Date.now() - lastChainlinkDataTime;
            // 🔴 FORENSIC FIX: Reduced from 60s to 15s - 60s is too long for 15-min markets
            if (staleAnyMs > 15000 && ws.readyState === WebSocket.OPEN) {
                log(`⚠️ LIVE-DATA TIMEOUT: No data for ${Math.floor(staleAnyMs / 1000)}s - forcing reconnection...`);
                ws.close(4000, 'Stale data timeout');
            } else if (staleChainlinkMs > 30000 && staleChainlinkMs <= 60000) {
                // Warn specifically about Chainlink staleness, even if backup feed is alive.
                log(`⚠️ Chainlink data stale: ${Math.floor(staleChainlinkMs / 1000)}s since last update`);
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
                    // 🔴 FORENSIC FIX: Guard against NaN prices
                    if (isNaN(price) || price <= 0) {
                        log(`⚠️ Invalid price received for ${asset}: ${msg.payload.value}`);
                        return;
                    }
                    livePrices[asset] = price;
                    const now = Date.now();
                    lastUpdateTimestamp = now;
                    lastChainlinkDataTime = now; // 🔮 Update heartbeat timestamp
                    lastLiveDataTime = now; // any valid data counts as live
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
                if (asset && msg.payload?.value) {
                    const price = parseFloat(msg.payload.value);
                    if (isNaN(price) || price <= 0) return;
                    livePrices[asset] = price;
                    const now = Date.now();
                    lastUpdateTimestamp = now;
                    lastLiveDataTime = now; // backup feed keeps system alive
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

async function fetchJSON(url, retries = 3, baseDelay = 1000) {
    for (let attempt = 0; attempt < retries; attempt++) {
        try {
            const res = await fetch(url);

            // GOD MODE: API Rate Limit Detection
            if (res.status === 429) {
                const retryAfter = parseInt(res.headers.get('Retry-After') || '5');
                log(`⚠️ RATE LIMITED (429): Waiting ${retryAfter}s before retry ${attempt + 1}/${retries}`);
                await new Promise(r => setTimeout(r, retryAfter * 1000));
                continue;
            }

            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            return await res.json();
        } catch (e) {
            if (attempt < retries - 1) {
                // Exponential backoff: 1s, 2s, 4s
                const delay = baseDelay * Math.pow(2, attempt);
                await new Promise(r => setTimeout(r, delay));
            }
        }
    }
    return null;
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

            // 🔴 FORENSIC FIX: Default to null (not 50/50) when no order book
            // 50/50 default causes cross-cycle bug: old cycle 1¢ + new cycle 50¢ default = fake profits
            let yesPrice = null, noPrice = null;

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

            // 🔴 FORENSIC FIX: If no order book data at all, market is not tradeable
            if (yesPrice === null && noPrice === null) {
                log(`⚠️ NO ORDER BOOK DATA for ${asset} - market not tradeable yet`, asset);
                currentMarkets[asset] = null;
                continue;
            }

            // Fallback: if only one side has data, derive the other
            if (yesPrice === null && noPrice !== null) yesPrice = 1 - noPrice;
            if (noPrice === null && yesPrice !== null) noPrice = 1 - yesPrice;

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
        regime: ASSETS.reduce((acc, a) => ({ ...acc, [a]: Brains[a].regimeHistory }), {}),
        // PINNACLE: Model accuracy (THE LEARNING!) - MUST be persisted
        modelAccuracy: ASSETS.reduce((acc, a) => ({ ...acc, [a]: Brains[a].modelAccuracy }), {}),
        recentOutcomes: ASSETS.reduce((acc, a) => ({ ...acc, [a]: Brains[a].recentOutcomes }), {}),

        // 🔴 FIX #17: PERSIST TRADE EXECUTOR STATE (survives restarts!)
        // 🚀 PINNACLE v27 CRASH RECOVERY: Now persists OPEN POSITIONS + recovery queues
        tradeExecutor: {
            paperBalance: tradeExecutor.paperBalance,
            startingBalance: tradeExecutor.startingBalance,
            tradeHistory: tradeExecutor.tradeHistory.slice(-200), // Keep last 200 trades
            todayPnL: tradeExecutor.todayPnL,
            consecutiveLosses: tradeExecutor.consecutiveLosses || 0,
            lastLossTime: tradeExecutor.lastLossTime || 0,
            lastDayReset: tradeExecutor.lastDayReset,
            // 🚀 PINNACLE v27: CRASH RECOVERY - Persist open positions!
            positions: tradeExecutor.positions || {},
            // 🚀 PINNACLE v27: Persist pending sells (failed sell orders)
            pendingSells: tradeExecutor.pendingSells || {},
            // 🚀 PINNACLE v27: Persist redemption queue (winning positions to claim)
            redemptionQueue: tradeExecutor.redemptionQueue || [],
            // 🚀 PINNACLE v27: Persist recovery queue (orphaned/crashed positions)
            recoveryQueue: tradeExecutor.recoveryQueue || []
        }
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

                // 🔴 CONFIG_VERSION CHECK: If version changed, CLEAR old settings and use new code!
                const savedVersion = settings._CONFIG_VERSION || 0;
                if (savedVersion !== CONFIG_VERSION) {
                    log(`⚠️ CONFIG_VERSION mismatch: Redis v${savedVersion} != Code v${CONFIG_VERSION}`);
                    log(`🔄 CLEARING stale Redis settings - using fresh hardcoded values!`);
                    await redis.del('deity:settings');
                    // Don't apply any settings - use hardcoded CONFIG as-is
                } else {
                    // Version matches - safe to apply Redis settings
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
                        if (key.startsWith('_')) continue; // Skip internal keys like _CONFIG_VERSION
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

                // PINNACLE: RESTORE MODEL ACCURACY (THE LEARNING!) - CRITICAL FOR GENUINE EVOLUTION
                if (state.modelAccuracy) ASSETS.forEach(a => { if (state.modelAccuracy[a]) Brains[a].modelAccuracy = state.modelAccuracy[a]; });
                if (state.recentOutcomes) ASSETS.forEach(a => { if (state.recentOutcomes[a]) Brains[a].recentOutcomes = state.recentOutcomes[a]; });

                // 🔴 FIX #17: RESTORE TRADE EXECUTOR STATE (preserves balance across restarts!)
                // 🚀 PINNACLE v27: CRASH RECOVERY - Full state restoration
                if (state.tradeExecutor) {
                    const te = state.tradeExecutor;
                    if (te.paperBalance !== undefined) tradeExecutor.paperBalance = te.paperBalance;
                    if (te.startingBalance !== undefined) tradeExecutor.startingBalance = te.startingBalance;
                    if (te.tradeHistory && Array.isArray(te.tradeHistory)) tradeExecutor.tradeHistory = te.tradeHistory;
                    if (te.todayPnL !== undefined) tradeExecutor.todayPnL = te.todayPnL;
                    if (te.consecutiveLosses !== undefined) tradeExecutor.consecutiveLosses = te.consecutiveLosses;
                    if (te.lastLossTime !== undefined) tradeExecutor.lastLossTime = te.lastLossTime;
                    if (te.lastDayReset !== undefined) tradeExecutor.lastDayReset = te.lastDayReset;

                    // 🚀 PINNACLE v27: CRASH RECOVERY - Restore open positions!
                    if (te.positions && Object.keys(te.positions).length > 0) {
                        const restoredCount = Object.keys(te.positions).length;
                        tradeExecutor.positions = te.positions;
                        log(`🔄 CRASH RECOVERY: Restored ${restoredCount} open positions`);

                        // Check if any restored positions are from a PREVIOUS cycle (orphaned)
                        const now = Math.floor(Date.now() / 1000);
                        const currentCycle = now - (now % 900);

                        Object.entries(te.positions).forEach(([posId, pos]) => {
                            const posCycle = Math.floor(pos.time / 1000);
                            const posCycleStart = posCycle - (posCycle % 900);

                            // If position is from a previous cycle, it's orphaned
                            if (posCycleStart < currentCycle) {
                                log(`⚠️ ORPHANED POSITION: ${posId} from previous cycle - adding to recovery queue`);

                                // Add to recovery queue with FULL info
                                if (!tradeExecutor.recoveryQueue) tradeExecutor.recoveryQueue = [];
                                tradeExecutor.recoveryQueue.push({
                                    id: posId,
                                    asset: pos.asset,
                                    mode: pos.mode,
                                    side: pos.side,
                                    entry: pos.entry,
                                    size: pos.size,
                                    shares: pos.shares,
                                    time: pos.time,
                                    tokenId: pos.tokenId || null,
                                    tokenType: pos.tokenType || null,
                                    orderID: pos.orderID || null,
                                    isLive: pos.isLive || false,
                                    status: 'ORPHANED_BY_CRASH',
                                    reason: 'Server crashed before cycle resolution',
                                    recoveryTime: Date.now(),
                                    recoveryInstructions: pos.isLive ? [
                                        '1. Check Polymarket portfolio for this position',
                                        '2. If resolved, claim winnings manually or wait for auto-redemption',
                                        '3. If still open, it will resolve at cycle end',
                                        `Token ID: ${pos.tokenId || 'N/A'}`,
                                        `Order ID: ${pos.orderID || 'N/A'}`
                                    ] : [
                                        'PAPER TRADE - No real money involved',
                                        'Position was simulated and lost in crash',
                                        `Entry: ${(pos.entry * 100).toFixed(1)}¢, Size: $${pos.size.toFixed(2)}`
                                    ]
                                });

                                // Remove from active positions (it's now in recovery)
                                delete tradeExecutor.positions[posId];

                                // Update trade history to mark as CRASH_RECOVERED
                                const trade = tradeExecutor.tradeHistory.find(t => t.id === posId);
                                if (trade) {
                                    trade.status = 'CRASH_RECOVERED';
                                    trade.reason = 'Moved to recovery queue after crash';
                                }
                            } else {
                                log(`✅ VALID POSITION: ${posId} is in current cycle - keeping active`);
                            }
                        });
                    }

                    // 🚀 PINNACLE v27: Restore pending sells
                    if (te.pendingSells && Object.keys(te.pendingSells).length > 0) {
                        tradeExecutor.pendingSells = te.pendingSells;
                        log(`🔄 CRASH RECOVERY: Restored ${Object.keys(te.pendingSells).length} pending sells`);
                    }

                    // 🚀 PINNACLE v27: Restore redemption queue
                    if (te.redemptionQueue && Array.isArray(te.redemptionQueue) && te.redemptionQueue.length > 0) {
                        tradeExecutor.redemptionQueue = te.redemptionQueue;
                        log(`🔄 CRASH RECOVERY: Restored ${te.redemptionQueue.length} items in redemption queue`);
                    }

                    // 🚀 PINNACLE v27: Restore recovery queue (orphaned/crashed positions)
                    if (te.recoveryQueue && Array.isArray(te.recoveryQueue) && te.recoveryQueue.length > 0) {
                        tradeExecutor.recoveryQueue = te.recoveryQueue;
                        log(`🔄 CRASH RECOVERY: Restored ${te.recoveryQueue.length} items in recovery queue`);
                    }

                    log(`💰 Trade state restored: Balance=$${tradeExecutor.paperBalance.toFixed(2)}, History=${tradeExecutor.tradeHistory.length} trades, Positions=${Object.keys(tradeExecutor.positions || {}).length}, Recovery=${(tradeExecutor.recoveryQueue || []).length}`);
                }

                log('💾 State Restored from Redis (including model learning!)');
                return;
            }
        } catch (e) {
            log(`⚠️ Redis state load error: ${e.message}`);
        }
    }

    log('ℹ️ Starting with fresh state');
}

// ==================== API & SERVER ====================

// Home route - FULL FEATURE DASHBOARD (original-style)
// ==================== ROOT ROUTE ====================
// This is the feature-complete UI with:
// - Wallet / Withdraw
// - Settings modal (no code edits)
// - Guide
// - Recovery / pending sells
// - Manual buy/sell
// - Debug export
// NOTE: `/index.html` remains available as a lightweight dashboard if you want it.

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
            <span style="color:#888;margin-left:15px;">⛽</span> <span id="estimatedTrades" style="color:#ff9900;" title="Estimated trades remaining (Gas | USDC)">-- | --</span>
            <button id="resumeTradingBtn" onclick="toggleStopLossOverride()" style="margin-left:15px;padding:4px 10px;border-radius:4px;border:1px solid #ff9900;background:transparent;color:#ff9900;cursor:pointer;font-size:0.75em;display:none;">🔓 Resume Trading</button>
        </div>
        <span class="mode-badge" id="modeBadge">PAPER</span>
        <!-- 🔴 FIX #15: Visual halt indicator -->
        <div id="haltIndicator" style="display:none;background:linear-gradient(135deg,#ff0000,#ff4400);color:white;padding:8px 16px;border-radius:6px;font-weight:bold;animation:pulse 1s infinite;margin-left:15px;font-size:0.9em;box-shadow:0 0 20px rgba(255,0,0,0.5);">
            🛑 <span id="haltReason">TRADING HALTED</span>
        </div>
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
            <div style="display:flex;gap:10px;margin-bottom:10px;">
                <button onclick="applyPreset('PINNACLE_OPTIMAL')" style="flex:1;padding:15px;border:3px solid #ffd700;border-radius:10px;background:linear-gradient(145deg,rgba(255,215,0,0.4),rgba(255,165,0,0.25));color:#ffd700;cursor:pointer;font-weight:bold;box-shadow:0 0 30px rgba(255,215,0,0.5);animation:pulse 1.5s infinite;font-size:1.1em;">👑 PINNACLE<br><small style="font-weight:normal;opacity:0.9;">ALL OPTIMAL SETTINGS</small></button>
            </div>
            <div style="display:flex;gap:10px;margin-bottom:10px;">
                <button onclick="applyPreset('APEX_V24')" style="flex:1;padding:12px;border:2px solid #00ffaa;border-radius:8px;background:linear-gradient(145deg,rgba(0,255,170,0.35),rgba(0,200,100,0.2));color:#00ffaa;cursor:pointer;font-weight:bold;box-shadow:0 0 20px rgba(0,255,170,0.4);animation:pulse 2s infinite;">🏆 PINNACLE v27<br><small style="font-weight:normal;opacity:0.8;">FINAL ENDGAME</small></button>
            </div>
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
                    <div style="margin-top:10px;padding:8px;background:rgba(255,0,0,0.1);border-radius:4px;border:1px solid rgba(255,0,0,0.3);">
                        <label style="color:#ff6666;display:block;margin-bottom:6px;"><input type="checkbox" id="oracleStopLossEnabled"> 🛑 Enable Emergency Stop Loss</label>
                        <div style="display:flex;align-items:center;gap:10px;">
                            <label style="color:#888;font-size:0.85em;min-width:70px;">Loss %:</label>
                            <input type="number" id="oracleStopLoss" value="25" min="10" max="50" step="5" style="width:80px;padding:5px;border-radius:4px;border:1px solid #444;background:rgba(0,0,0,0.3);color:#fff;">
                            <small style="color:#888;">Exit ORACLE trades if they drop this much (default: hold to resolution)</small>
                        </div>
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
                <!-- ILLIQUIDITY_GAP (TRUE ARBITRAGE) -->
                <div style="margin-bottom:12px;padding:10px;background:rgba(255,215,0,0.15);border-left:3px solid #ffd700;border-radius:4px;">
                    <strong style="color:#ffd700;">💰 ILLIQUIDITY GAP (True Arbitrage)</strong>
                    <label style="float:right;color:#888;"><input type="checkbox" id="ilGapEnabled" checked> Enabled</label>
                    <div class="form-grid" style="margin-top:8px;">
                        <div class="form-group"><label>Min Gap</label><input type="number" id="ilGapMinGap" value="0.03" step="0.01" min="0.01" max="0.10"></div>
                        <div class="form-group"><label>Max Entry Total</label><input type="number" id="ilGapMaxEntry" value="0.97" step="0.01" min="0.90" max="0.99"></div>
                    </div>
                </div>
                <!-- DEATH_BOUNCE (Genesis-Aligned Contrarian) -->
                <div style="margin-bottom:12px;padding:10px;background:rgba(255,0,0,0.15);border-left:3px solid #ff4444;border-radius:4px;">
                    <strong style="color:#ff4444;">💀 DEATH BOUNCE (Genesis-Aligned)</strong>
                    <label style="float:right;color:#888;"><input type="checkbox" id="dbEnabled" checked> Enabled</label>
                    <div class="form-grid" style="margin-top:8px;">
                        <div class="form-group"><label>Min Price (¢)</label><input type="number" id="dbMinPrice" value="3" min="1" max="10"></div>
                        <div class="form-group"><label>Max Price (¢)</label><input type="number" id="dbMaxPrice" value="12" min="5" max="20"></div>
                        <div class="form-group"><label>Target Price (¢)</label><input type="number" id="dbTargetPrice" value="18" min="10" max="30"></div>
                        <div class="form-group"><label>Min Score</label><input type="number" id="dbMinScore" value="1.5" step="0.5" min="1" max="5"></div>
                    </div>
                </div>
                <!-- RISK -->
                <div style="padding:10px;background:rgba(255,0,100,0.1);border-left:3px solid #ff0066;border-radius:4px;">
                    <strong style="color:#ff0066;">⚠️ RISK MANAGEMENT - SMART AGGRESSIVE MODE</strong>
                    
                    <!-- Preset Profiles -->
                    <div style="margin:12px 0;padding:10px;background:rgba(0,0,0,0.3);border-radius:6px;">
                        <label style="color:#888;font-size:0.9em;display:block;margin-bottom:8px;">📋 Quick Presets:</label>
                        <div style="display:grid;grid-template-columns:1fr 1fr 1fr 1fr;gap:8px;">
                            <button onclick="applyRiskPreset('SAFE')" style="padding:8px;background:rgba(0,255,136,0.2);border:1px solid #00ff88;color:#00ff88;border-radius:4px;cursor:pointer;font-size:0.85em;">🛡️ Safe</button>
                            <button onclick="applyRiskPreset('BALANCED')" style="padding:8px;background:rgba(255,215,0,0.2);border:1px solid #ffd700;color:#ffd700;border-radius:4px;cursor:pointer;font-size:0.85em;">⚖️ Balanced</button>
                            <button onclick="applyRiskPreset('AGGRESSIVE')" style="padding:8px;background:rgba(255,68,102,0.2);border:1px solid #ff4466;color:#ff4466;border-radius:4px;cursor:pointer;font-size:0.85em;">🔥 Aggressive</button>
                            <button onclick="applyRiskPreset('ORACLE')" style="padding:8px;background:rgba(153,51,255,0.2);border:1px solid #9933ff;color:#9933ff;border-radius:4px;cursor:pointer;font-size:0.85em;">🔮 Oracle</button>
                        </div>
                    </div>

                    <div class="form-grid" style="margin-top:8px;">
                        <!-- Safety Toggles -->
                        <div style="grid-column:1/-1;margin-bottom:12px;padding:10px;background:rgba(0,0,0,0.2);border-radius:6px;">
                            <label style="color:#ff9966;font-weight:bold;display:block;margin-bottom:10px;">🎯 Safety Features:</label>
                            <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;">
                                <label style="color:#aaa;display:flex;align-items:center;gap:6px;cursor:pointer;">
                                    <input type="checkbox" id="enableLossCooldown" checked style="width:16px;height:16px;"> Loss Cooldown
                                </label>
                                <label style="color:#aaa;display:flex;align-items:center;gap:6px;cursor:pointer;">
                                    <input type="checkbox" id="enableCircuitBreaker" checked style="width:16px;height:16px;"> Circuit Breaker
                                </label>
                                <label style="color:#aaa;display:flex;align-items:center;gap:6px;cursor:pointer;">
                                    <input type="checkbox" id="enableDivergenceBlocking" checked style="width:16px;height:16px;"> Divergence Block
                                </label>
                                <label style="color:#aaa;display:flex;align-items:center;gap:6px;cursor:pointer;">
                                    <input type="checkbox" id="aggressiveSizingOnLosses" style="width:16px;height:16px;"> Maintain Size on Loss
                                </label>
                            </div>
                            <small style="display:block;color:#888;margin-top:8px;line-height:1.4;">Cooldown: pause after loss | Circuit: pause extreme volatility | Divergence: block market chaos | Maintain: don't reduce position after losses</small>
                        </div>
                        
                        <!-- 🔮 ORACLE FEATURES -->
                        <div style="grid-column:1/-1;margin-bottom:12px;padding:10px;background:rgba(153,51,255,0.1);border-radius:6px;border-left:3px solid #9933ff;">
                            <label style="color:#9933ff;font-weight:bold;display:block;margin-bottom:10px;">🔮 Oracle Mode Features:</label>
                            <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;">
                                <label style="color:#aaa;display:flex;align-items:center;gap:6px;cursor:pointer;">
                                    <input type="checkbox" id="firstMoveAdvantage" checked style="width:16px;height:16px;"> First-Move Advantage
                                </label>
                                <label style="color:#aaa;display:flex;align-items:center;gap:6px;cursor:pointer;">
                                    <input type="checkbox" id="supremeConfidenceMode" checked style="width:16px;height:16px;"> Supreme Confidence (75%+)
                                </label>
                                <label style="color:#aaa;display:flex;align-items:center;gap:6px;cursor:pointer;">
                                    <input type="checkbox" id="enablePositionPyramiding" checked style="width:16px;height:16px;"> Position Pyramiding
                                </label>
                            </div>
                            <small style="display:block;color:#888;margin-top:8px;line-height:1.4;">First-Move: +10% confidence <30s | Supreme: block trades <75% | Pyramid: add 50% to winners after 2min</small>
                        </div>

                        <!-- No-Trade Detection (existing) -->
                        <div style="grid-column:1/-1;margin-bottom:12px;padding:10px;background:rgba(0,0,0,0.2);border-radius:6px;border-left:3px solid #ff9966;">
                            <label style="color:#ff9966;display:flex;align-items:center;gap:8px;cursor:pointer;font-weight:bold;">
                                <input type="checkbox" id="noTradeDetection" checked style="width:18px;height:18px;"> 
                                <span>🎲 No-Trade Detection (Capital Protection)</span>
                            </label>
                            <small style="display:block;color:#aaa;margin-left:26px;margin-top:4px;line-height:1.4;">When enabled, bot refuses to trade when markets are genuinely random/choppy with no edge. Protects capital from gambling.</small>
                        </div>

                        <!-- Position Limits -->
                        <div class="form-group"><label>Max Exposure (%)</label><input type="number" id="riskMaxExposure" value="50" min="10" max="100"></div>
                        <div class="form-group"><label>Max Position (%)</label><input type="number" id="maxPositionSize" value="20" min="5" max="50"></div>
                        
                        <!-- Cooldown & Stop Loss -->
                        <div class="form-group"><label>Loss Cooldown (s)</label><input type="number" id="riskCooldown" value="60" min="0" max="900"></div>
                        <div class="form-group"><label>Daily Stop (%)</label><input type="number" id="riskStopLoss" value="30" min="5" max="50"></div>

                        <!-- Smart Safeguards -->
                        <div class="form-group"><label>Max Consecutive Losses</label><input type="number" id="maxConsecutiveLosses" value="3" min="1" max="10"></div>
                        <div class="form-group"><label>Max Daily Losses</label><input type="number" id="maxDailyLosses" value="5" min="1" max="20"></div>
                        
                        <!-- Trades Per Asset -->
                        <div class="form-group"><label>Trades/Asset/Cycle</label><input type="number" id="maxTradesPerCycle" value="3" min="1" max="10"></div>
                        <div class="form-group"><label>Withdrawal Alert (£)</label><input type="number" id="withdrawalNotification" value="1000" min="100" max="10000"></div>
                    </div>
                </div>
            </div>
            
            <!-- DEBUG EXPORT SECTION -->
            <h4 style="margin:15px 0 10px;color:#ff6600;font-size:0.95em;">📥 Debug Export</h4>
            <div style="padding:15px;background:rgba(255,102,0,0.1);border-left:3px solid #ff6600;border-radius:4px;margin-bottom:15px;">
                <p style="color:#aaa;font-size:0.85em;margin-bottom:12px;">Download complete debugging data for last 10 cycles (all assets, predictions, certainty, trades, patterns).</p>
                <button id="exportDebugBtn" onclick="exportDebug()" style="padding:12px 24px;background:linear-gradient(135deg, #ff6600, #ff9933);border:none;color:#fff;border-radius:8px;cursor:pointer;font-weight:bold;font-size:1em;width:100%;transition:all 0.3s;">📥 Export Debug (10 Cycles)</button>
            </div>
            
            <h4 style="margin:15px 0 10px;color:#00bcd4;font-size:0.95em;">📱 Telegram Notifications</h4>
            <div style="padding:10px;background:rgba(0,188,212,0.1);border-left:3px solid #00bcd4;border-radius:4px;margin-bottom:15px;">
                <label style="color:#888;display:block;margin-bottom:8px;">
                    <input type="checkbox" id="telegramEnabled"> Enable Telegram Notifications
                </label>
                <div class="form-grid">
                    <div class="form-group"><label>Bot Token</label><input type="password" id="telegramToken" placeholder="123456789:ABC-DEF..."></div>
                    <div class="form-group"><label>Chat ID</label><input type="text" id="telegramChatId" placeholder="123456789"></div>
                </div>
                <small style="color:#666;display:block;margin-top:8px;">Create bot via @BotFather. Get Chat ID via @userinfobot. Receive trade alerts in real-time.</small>
            </div>
            
            <h4 style="margin:15px 0 10px;color:#ff9900;font-size:0.95em;">🎛️ Per-Asset Trading Controls</h4>
            <div style="padding:12px;background:rgba(255,153,0,0.1);border-left:3px solid #ff9900;border-radius:4px;margin-bottom:15px;">
                <small style="color:#888;display:block;margin-bottom:12px;">Enable/disable trading for individual assets and set max trades per cycle</small>
                <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;">
                    <div style="display:flex;align-items:center;justify-content:space-between;padding:8px;background:rgba(0,0,0,0.2);border-radius:4px;">
                        <span style="color:#ffd700;">₿ BTC</span>
                        <label style="display:flex;align-items:center;gap:8px;">
                            <input type="checkbox" id="btcEnabled" checked> Enabled
                            <input type="number" id="btcMaxTrades" value="1" min="1" max="10" style="width:50px;padding:4px;border-radius:4px;border:1px solid #444;background:rgba(0,0,0,0.3);color:#fff;"> /cycle
                        </label>
                    </div>
                    <div style="display:flex;align-items:center;justify-content:space-between;padding:8px;background:rgba(0,0,0,0.2);border-radius:4px;">
                        <span style="color:#627eea;">Ξ ETH</span>
                        <label style="display:flex;align-items:center;gap:8px;">
                            <input type="checkbox" id="ethEnabled" checked> Enabled
                            <input type="number" id="ethMaxTrades" value="1" min="1" max="10" style="width:50px;padding:4px;border-radius:4px;border:1px solid #444;background:rgba(0,0,0,0.3);color:#fff;"> /cycle
                        </label>
                    </div>
                    <div style="display:flex;align-items:center;justify-content:space-between;padding:8px;background:rgba(0,0,0,0.2);border-radius:4px;">
                        <span style="color:#14f195;">◎ SOL</span>
                        <label style="display:flex;align-items:center;gap:8px;">
                            <input type="checkbox" id="solEnabled" checked> Enabled
                            <input type="number" id="solMaxTrades" value="1" min="1" max="10" style="width:50px;padding:4px;border-radius:4px;border:1px solid #444;background:rgba(0,0,0,0.3);color:#fff;"> /cycle
                        </label>
                    </div>
                    <div style="display:flex;align-items:center;justify-content:space-between;padding:8px;background:rgba(0,0,0,0.2);border-radius:4px;">
                        <span style="color:#00d4ff;">✕ XRP</span>
                        <label style="display:flex;align-items:center;gap:8px;">
                            <input type="checkbox" id="xrpEnabled" checked> Enabled
                            <input type="number" id="xrpMaxTrades" value="1" min="1" max="10" style="width:50px;padding:4px;border-radius:4px;border:1px solid #444;background:rgba(0,0,0,0.3);color:#fff;"> /cycle
                        </label>
                    </div>
                </div>
                <div style="margin-top:12px;">
                    <label style="color:#888;display:block;margin-bottom:6px;">🕐 Min Wait Before Trading (seconds)</label>
                    <input type="number" id="minElapsedSeconds" value="60" min="0" max="300" step="10" style="width:100%;padding:8px;border-radius:4px;border:1px solid #444;background:rgba(0,0,0,0.3);color:#fff;">
                    <small style="color:#666;display:block;margin-top:4px;">Bot will wait this many seconds before trading in each cycle (prevents premature trades)</small>
                </div>
            </div>
            
            <h4 style="margin-bottom:10px;color:#ffd700;font-size:0.95em;">🔑 API Credentials</h4>
            <div class="form-group"><label>API Key</label><input type="text" id="apiKey" placeholder="019aed53-..."></div>
            <div class="form-group"><label>Secret</label><input type="password" id="apiSecret" placeholder="Enter secret..."></div>
            <div class="form-group"><label>Passphrase</label><input type="password" id="apiPassphrase" placeholder="Enter passphrase..."></div>
            <div class="form-group"><label>Private Key (⚠️)</label><input type="password" id="privateKey" placeholder="0x..."></div>
            <button class="btn btn-primary" onclick="saveAllSettings()" style="width:100%;">💾 Save All Settings</button>
            <div style="margin-top:10px;color:#88ccff;font-size:0.85em;">Active preset: <span id="activePresetLabel">CUSTOM</span></div>
            <div class="status-msg" id="settingsStatus"></div>
        </div>
    </div>
    <!-- GUIDE MODAL (ENHANCED with Settings Explanations) -->
    <div class="modal-overlay" id="guideModal">
        <div class="modal" style="max-width:900px;max-height:90vh;overflow-y:auto;">
            <div class="modal-header"><span class="modal-title">📚 Complete Guide & Settings Help</span><button class="modal-close" onclick="closeModal('guideModal')">×</button></div>
            
            <!-- TAB NAVIGATION -->
            <div style="display:flex;gap:5px;margin-bottom:15px;border-bottom:1px solid #333;padding-bottom:10px;">
                <button onclick="showGuideTab('basics')" class="guide-tab active" id="tab-basics">🎯 Basics</button>
                <button onclick="showGuideTab('modes')" class="guide-tab" id="tab-modes">🔮 Trading Modes</button>
                <button onclick="showGuideTab('settings')" class="guide-tab" id="tab-settings">⚙️ Settings Explained</button>
                <button onclick="showGuideTab('risk')" class="guide-tab" id="tab-risk">⚠️ Risk Controls</button>
            </div>
            
            <!-- BASICS TAB -->
            <div id="guide-basics" class="guide-content active">
                <div class="guide-section"><h3>🎯 What Is This Bot?</h3><p>An AI prediction bot for Polymarket's 15-minute crypto checkpoint markets. It uses 8 machine learning models to predict whether BTC, ETH, SOL, or XRP will go UP or DOWN in each 15-minute window.</p></div>
                <div class="guide-section"><h3>📊 Reading the Dashboard</h3>
                    <p><strong>Prediction:</strong> The direction the bot thinks the price will go (UP = 📈 green, DOWN = 📉 red)</p>
                    <p><strong>Confidence:</strong> How sure the bot is (0-100%). Higher = more certain.</p>
                    <p><strong>Tier:</strong> CONVICTION = best quality trade, ADVISORY = lower confidence</p>
                    <p><strong>Edge:</strong> Your advantage over the market odds. +15% edge means you have 15% better odds than what the market offers.</p>
                </div>
                <div class="guide-section"><h3>⚠️ Paper vs Live Mode</h3>
                    <p><strong>📝 PAPER:</strong> Practice mode with fake money. Safe to experiment!</p>
                    <p><strong>🔴 LIVE:</strong> Real money trading. Needs USDC (for trades) + MATIC (for gas fees) in your wallet.</p>
                </div>
                <div class="guide-section"><h3>🚀 Quick Start Presets</h3>
                    <p>In Settings, use these presets instead of configuring manually:</p>
                    <p>🛡️ <strong>Safe:</strong> Fewer trades, higher accuracy. Best for beginners.</p>
                    <p>⚖️ <strong>Balanced:</strong> Mix of trades and accuracy. Good all-rounder.</p>
                    <p>🔥 <strong>Aggressive:</strong> More trades, lower thresholds. Higher risk/reward.</p>
                </div>
            </div>
            
            <!-- TRADING MODES TAB -->
            <div id="guide-modes" class="guide-content">
                <div class="guide-section" style="border-left:3px solid #9933ff;padding-left:12px;margin-bottom:15px;">
                    <h3>🔮 ORACLE Mode (Recommended)</h3>
                    <p><strong>What it does:</strong> Makes high-confidence predictions and holds until the market resolves.</p>
                    <p><strong>Best for:</strong> Maximum accuracy. This is your main money-maker.</p>
                    <p><strong>Settings explained:</strong></p>
                    <ul style="color:#aaa;font-size:0.9em;">
                        <li><strong>Min Consensus:</strong> What % of the 8 AI brains must agree (0.85 = 7 out of 8)</li>
                        <li><strong>Min Confidence:</strong> How sure the bot must be (0.92 = 92% certainty)</li>
                        <li><strong>Min Edge:</strong> The minimum profit advantage over market odds (15 = 15%)</li>
                        <li><strong>Max Odds:</strong> Won't buy if shares cost more than this (0.70 = 70¢)</li>
                        <li><strong>Aggression:</strong> 0% = very picky, 100% = more trades with lower thresholds</li>
                    </ul>
                </div>
                <div class="guide-section" style="border-left:3px solid #ff6600;padding-left:12px;margin-bottom:15px;">
                    <h3>🎯 SCALP Mode</h3>
                    <p><strong>What it does:</strong> Buys cheap shares and sells when they double in price.</p>
                    <p><strong>Best for:</strong> Quick profits on volatile markets.</p>
                    <ul style="color:#aaa;font-size:0.9em;">
                        <li><strong>Max Entry (¢):</strong> Only buy shares cheaper than this (20 = 20 cents)</li>
                        <li><strong>Target Multiple:</strong> Sell when price hits this multiple (2.0 = double your money)</li>
                    </ul>
                </div>
                <div class="guide-section" style="border-left:3px solid #00ff88;padding-left:12px;margin-bottom:15px;">
                    <h3>📊 ARBITRAGE Mode</h3>
                    <p><strong>What it does:</strong> Exploits when the market price is "wrong" vs what the bot thinks.</p>
                    <p><strong>Best for:</strong> Profiting from market inefficiencies.</p>
                    <ul style="color:#aaa;font-size:0.9em;">
                        <li><strong>Min Mispricing:</strong> How wrong the market must be (0.15 = 15% difference)</li>
                        <li><strong>Target Profit:</strong> Sell when this much of the gap closes (0.50 = 50%)</li>
                        <li><strong>Stop Loss:</strong> Exit if trade goes against you by this much</li>
                    </ul>
                </div>
                <div class="guide-section" style="border-left:3px solid #3399ff;padding-left:12px;margin-bottom:15px;">
                    <h3>🌊 UNCERTAINTY Mode</h3>
                    <p><strong>What it does:</strong> Bets that extreme odds (80%+) will revert back toward 50/50.</p>
                    <p><strong>Best for:</strong> Choppy, unpredictable markets.</p>
                    <ul style="color:#aaa;font-size:0.9em;">
                        <li><strong>Extreme Threshold:</strong> How lopsided odds must be (0.80 = 80%+ one way)</li>
                        <li><strong>Target Reversion:</strong> Exit when odds return to this level (0.60 = 60%)</li>
                        <li><strong>Stop Loss:</strong> Exit if odds keep going extreme</li>
                    </ul>
                </div>
                <div class="guide-section" style="border-left:3px solid #ff33cc;padding-left:12px;">
                    <h3>🚀 MOMENTUM Mode</h3>
                    <p><strong>What it does:</strong> Rides strong price trends mid-cycle.</p>
                    <p><strong>Best for:</strong> Trending markets with clear direction.</p>
                    <ul style="color:#aaa;font-size:0.9em;">
                        <li><strong>Min Elapsed (s):</strong> Wait this long before trading (300 = 5 minutes)</li>
                        <li><strong>Min Consensus:</strong> Model agreement needed (0.75 = 75%)</li>
                        <li><strong>Exit Before End (s):</strong> Sell this long before cycle ends (180 = 3 min)</li>
                    </ul>
                </div>
            </div>
            
            <!-- SETTINGS EXPLAINED TAB -->
            <div id="guide-settings" class="guide-content">
                <div class="guide-section">
                    <h3>💰 Core Parameters</h3>
                    <p><strong>Paper Balance ($):</strong> Your fake practice money. Only used in PAPER mode.</p>
                    <p><strong>Max Position (%):</strong> Maximum % of your money to risk on ONE trade. If you have $100 and this is 10%, the bot won't bet more than $10 on any single trade.</p>
                </div>
                <div class="guide-section">
                    <h3>🎛️ Per-Asset Controls</h3>
                    <p><strong>Enable/Disable:</strong> Turn trading on/off for each coin (BTC, ETH, SOL, XRP)</p>
                    <p><strong>Max Trades /cycle:</strong> Limit how many trades per 15-minute period per coin. Default is 1 to prevent overtrading.</p>
                    <p><strong>Min Wait Before Trading:</strong> How many seconds to wait after a cycle starts before allowing trades. Default 60s prevents premature trades from noisy early data.</p>
                </div>
                <div class="guide-section">
                    <h3>📱 Telegram Notifications</h3>
                    <p>Get trade alerts on your phone! Setup:</p>
                    <ol style="color:#aaa;font-size:0.9em;">
                        <li>Message @BotFather on Telegram, send /newbot</li>
                        <li>Copy the token it gives you → paste in "Bot Token" field</li>
                        <li>Message @userinfobot → it replies with your ID number</li>
                        <li>Paste that number in "Chat ID" field</li>
                    </ol>
                </div>
                <div class="guide-section">
                    <h3>📋 Settings Cheat Sheet</h3>
                    <table style="width:100%;font-size:0.85em;border-collapse:collapse;">
                        <tr style="background:rgba(0,0,0,0.3);"><th style="padding:8px;text-align:left;">Setting</th><th>Safe Value</th><th>Aggressive</th><th>What It Does</th></tr>
                        <tr><td style="padding:6px;">Min Consensus</td><td>0.90</td><td>0.75</td><td>More agreement = fewer trades</td></tr>
                        <tr style="background:rgba(0,0,0,0.2);"><td style="padding:6px;">Min Confidence</td><td>0.92</td><td>0.70</td><td>More certainty = fewer trades</td></tr>
                        <tr><td style="padding:6px;">Min Edge</td><td>20%</td><td>10%</td><td>Bigger edge = fewer trades</td></tr>
                        <tr style="background:rgba(0,0,0,0.2);"><td style="padding:6px;">Max Position</td><td>10%</td><td>25%</td><td>Larger = more $ per trade</td></tr>
                        <tr><td style="padding:6px;">Daily Stop</td><td>15%</td><td>30%</td><td>Lower = stops losses earlier</td></tr>
                    </table>
                </div>
            </div>
            
            <!-- RISK CONTROLS TAB -->
            <div id="guide-risk" class="guide-content">
                <div class="guide-section" style="border-left:3px solid #ff0066;padding-left:12px;margin-bottom:15px;">
                    <h3>⚠️ Risk Management Settings</h3>
                    <p><strong>Max Exposure (%):</strong> Maximum % of your money in active trades at once. If 30%, you can never have more than 30% at risk simultaneously.</p>
                    <p><strong>Daily Stop (%):</strong> Stop trading if you lose this much in one day. At 20%, if your $100 drops to $80, trading halts to prevent further damage. This is your circuit breaker!</p>
                    <p><strong>Loss Cooldown (s):</strong> Wait time after each loss before trading again. Prevents "revenge trading".</p>
                </div>
                <div class="guide-section">
                    <h3>🛡️ Built-in Protections</h3>
                    <p>The bot has 12 automatic failsafes:</p>
                    <ul style="color:#aaa;font-size:0.9em;">
                        <li>✅ 3x retry on buy orders</li>
                        <li>✅ 5x retry with increasing delays on sell orders</li>
                        <li>✅ Failed sells saved with recovery info</li>
                        <li>✅ Daily P/L reset at midnight</li>
                        <li>✅ Low balance alerts (USDC + MATIC)</li>
                        <li>✅ Stale data detection (auto-reconnects)</li>
                        <li>✅ Conviction lock (prevents flip-flopping)</li>
                        <li>✅ Reality check (nukes bad predictions)</li>
                    </ul>
                </div>
                <div class="guide-section">
                    <h3>🔄 Failed Sells Recovery</h3>
                    <p>If a sell fails after 5 retries:</p>
                    <ol style="color:#aaa;font-size:0.9em;">
                        <li>Position saved with complete recovery info</li>
                        <li>Use "Retry Sell" in Recovery modal</li>
                        <li>Or manually sell at <a href="https://polymarket.com/portfolio" target="_blank" style="color:#4fc3f7;">polymarket.com/portfolio</a></li>
                        <li>Or wait for market resolution and redeem</li>
                    </ol>
                </div>
            </div>
        </div>
    </div>
    <style>
        .guide-tab { padding:8px 12px; background:rgba(0,0,0,0.3); border:1px solid #333; border-radius:6px; color:#888; cursor:pointer; font-size:0.85em; transition:all 0.2s; }
        .guide-tab:hover { background:rgba(255,255,255,0.1); color:#fff; }
        .guide-tab.active { background:rgba(0,200,100,0.2); border-color:#00ff88; color:#00ff88; }
        .guide-content { display:none; }
        .guide-content.active { display:block; }
    </style>
    <script>
        function showGuideTab(tab) {
            document.querySelectorAll('.guide-content').forEach(c => c.classList.remove('active'));
            document.querySelectorAll('.guide-tab').forEach(t => t.classList.remove('active'));
            document.getElementById('guide-' + tab).classList.add('active');
            document.getElementById('tab-' + tab).classList.add('active');
        }
    </script>

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
        
        // ==================== DEBUG EXPORT FUNCTION ====================
        async function exportDebug() {
            try {
                const btn = document.getElementById('exportDebugBtn');
                if (btn) { btn.textContent = '⏳ Exporting...'; btn.disabled = true; }
                
                const res = await fetch('/api/debug-export');
                if (!res.ok) throw new Error('Export failed: ' + res.status);
                
                const data = await res.json();
                const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
                const url = URL.createObjectURL(blob);
                
                const a = document.createElement('a');
                a.href = url;
                a.download = 'polyprophet_debug_' + new Date().toISOString().replace(/[:.]/g, '-') + '.json';
                document.body.appendChild(a);
                a.click();
                document.body.removeChild(a);
                URL.revokeObjectURL(url);
                
                if (btn) { btn.textContent = '📥 Export Debug (10 Cycles)'; btn.disabled = false; }
                console.log('✅ Debug export downloaded:', Object.keys(data.assets || {}).length, 'assets');
            } catch (e) {
                console.error('❌ Export error:', e);
                alert('Export failed: ' + e.message);
                const btn = document.getElementById('exportDebugBtn');
                if (btn) { btn.textContent = '📥 Export Debug (10 Cycles)'; btn.disabled = false; }
            }
        }
        
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
                    // Update live USDC balance
                    if (t.liveBalance !== undefined) {
                        document.getElementById('liveBalance').textContent = '$' + (t.liveBalance || 0).toFixed(2);
                    }
                    // Update estimated trades remaining (Gas | USDC)
                    if (t.estimatedTradesRemaining) {
                        const etr = t.estimatedTradesRemaining;
                        const gasText = etr.gas === Infinity ? '∞' : (etr.gas || 0);
                        const usdcText = etr.usdc === Infinity ? '∞' : (etr.usdc || 0);
                        const etEl = document.getElementById('estimatedTrades');
                        etEl.textContent = gasText + ' | ' + usdcText;
                        // Color warning if low
                        if (etr.gas !== Infinity && etr.gas < 10) {
                            etEl.style.color = '#ff4466';
                        } else if (etr.gas !== Infinity && etr.gas < 25) {
                            etEl.style.color = '#ff9900';
                        } else {
                            etEl.style.color = '#00ff88';
                        }
                    }
                    document.getElementById('modeBadge').textContent = t.mode || 'PAPER';
                    document.getElementById('modeBadge').className = 'mode-badge ' + (t.mode || 'PAPER');
                    document.getElementById('modeBtn').textContent = t.mode === 'LIVE' ? '🔴 LIVE' : '📝 PAPER';
                    document.getElementById('modeBtn').className = 'nav-btn ' + (t.mode || 'paper').toLowerCase();
                    document.getElementById('positionCount').textContent = (t.positionCount || 0) + ' positions';
                    document.getElementById('paperBtn').className = t.mode === 'PAPER' ? 'paper active' : 'paper';
                    document.getElementById('liveBtn').className = t.mode === 'LIVE' ? 'live active' : 'live';
                    
                    // 🔴 FIX #15: Update halt indicator visibility and reason
                    const haltIndicator = document.getElementById('haltIndicator');
                    const haltReasonEl = document.getElementById('haltReason');
                    if (t.isHalted && t.haltReason) {
                        haltIndicator.style.display = 'block';
                        haltReasonEl.textContent = t.haltReason;
                    } else {
                        haltIndicator.style.display = 'none';
                    }
                    
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
                // IMPORTANT: Use nullish coalescing so valid 0 values are preserved (e.g. minEdge=0)
                document.getElementById('paperBalance').value = (data.PAPER_BALANCE ?? 1000);
                document.getElementById('maxPosition').value = ((data.MAX_POSITION_SIZE ?? 0.1) * 100);
                if (data.ORACLE) { 
                    document.getElementById('oracleEnabled').checked = data.ORACLE.enabled !== false; 
                    document.getElementById('oracleConsensus').value = (data.ORACLE.minConsensus ?? 0.85); 
                    document.getElementById('oracleConfidence').value = (data.ORACLE.minConfidence ?? 0.92); 
                    document.getElementById('oracleEdge').value = (data.ORACLE.minEdge ?? 15); 
                    document.getElementById('oracleMaxOdds').value = (data.ORACLE.maxOdds ?? 0.70);
                    // 🔮 ORACLE AGGRESSION
                    const aggression = (data.ORACLE.aggression ?? 50);
                    document.getElementById('oracleAggression').value = aggression;
                    document.getElementById('aggressionValue').textContent = aggression + '%';
                    // 🛑 ORACLE STOP LOSS
                    document.getElementById('oracleStopLossEnabled').checked = (data.ORACLE.stopLossEnabled ?? false);
                    document.getElementById('oracleStopLoss').value = ((data.ORACLE.stopLoss ?? 0.25) * 100);
                }
                if (data.SCALP) { document.getElementById('scalpEnabled').checked = data.SCALP.enabled !== false; document.getElementById('scalpMaxEntry').value = ((data.SCALP.maxEntryPrice ?? 0.20) * 100); document.getElementById('scalpTarget').value = (data.SCALP.targetMultiple ?? 2.0); }
                if (data.ARBITRAGE) { document.getElementById('arbEnabled').checked = data.ARBITRAGE.enabled !== false; document.getElementById('arbMispricing').value = (data.ARBITRAGE.minMispricing ?? 0.15); document.getElementById('arbTarget').value = (data.ARBITRAGE.targetProfit ?? 0.50); document.getElementById('arbStopLoss').value = (data.ARBITRAGE.stopLoss ?? 0.30); }
                // 🌊 UNCERTAINTY MODE
                if (data.UNCERTAINTY) {
                    document.getElementById('uncEnabled').checked = data.UNCERTAINTY.enabled !== false;
                    document.getElementById('uncThreshold').value = (data.UNCERTAINTY.extremeThreshold ?? 0.80);
                    document.getElementById('uncTarget').value = (data.UNCERTAINTY.targetReversion ?? 0.60);
                    document.getElementById('uncStopLoss').value = (data.UNCERTAINTY.stopLoss ?? 0.25);
                }
                // 🚀 MOMENTUM MODE
                if (data.MOMENTUM) {
                    document.getElementById('momEnabled').checked = data.MOMENTUM.enabled !== false;
                    document.getElementById('momMinElapsed').value = (data.MOMENTUM.minElapsed ?? 300);
                    document.getElementById('momConsensus').value = (data.MOMENTUM.minConsensus ?? 0.75);
                    document.getElementById('momExitBefore').value = (data.MOMENTUM.exitBeforeEnd ?? 180);
                }
                // 💰 ILLIQUIDITY_GAP (True Arbitrage)
                if (data.ILLIQUIDITY_GAP) {
                    document.getElementById('ilGapEnabled').checked = data.ILLIQUIDITY_GAP.enabled !== false;
                    document.getElementById('ilGapMinGap').value = (data.ILLIQUIDITY_GAP.minGap ?? 0.03);
                    document.getElementById('ilGapMaxEntry').value = (data.ILLIQUIDITY_GAP.maxEntryTotal ?? 0.97);
                }
                // 💀 DEATH_BOUNCE (Genesis-Aligned)
                if (data.DEATH_BOUNCE) {
                    document.getElementById('dbEnabled').checked = data.DEATH_BOUNCE.enabled !== false;
                    document.getElementById('dbMinPrice').value = (((data.DEATH_BOUNCE.minPrice ?? 0.03) * 100));
                    document.getElementById('dbMaxPrice').value = (((data.DEATH_BOUNCE.maxPrice ?? 0.12) * 100));
                    document.getElementById('dbTargetPrice').value = (((data.DEATH_BOUNCE.targetPrice ?? 0.18) * 100));
                    document.getElementById('dbMinScore').value = (data.DEATH_BOUNCE.minScore ?? 1.5);
                }
                if (data.RISK) { 
                    document.getElementById('riskMaxExposure').value = ((data.RISK.maxTotalExposure ?? 0.75) * 100); 
                    document.getElementById('riskStopLoss').value = ((data.RISK.globalStopLoss ?? 0.40) * 100); 
                    document.getElementById('riskCooldown').value = (data.RISK.cooldownAfterLoss ?? 0);
                    document.getElementById('noTradeDetection').checked = data.RISK.noTradeDetection !== false;
                    // Smart Aggressive toggles
                    document.getElementById('enableLossCooldown').checked = data.RISK.enableLossCooldown === true;
                    document.getElementById('enableCircuitBreaker').checked = data.RISK.enableCircuitBreaker === true;
                    document.getElementById('enableDivergenceBlocking').checked = data.RISK.enableDivergenceBlocking === true;
                    document.getElementById('aggressiveSizingOnLosses').checked = data.RISK.aggressiveSizingOnLosses === true;
                    // 🔮 Oracle Mode features
                    document.getElementById('firstMoveAdvantage').checked = data.RISK.firstMoveAdvantage !== false;
                    document.getElementById('supremeConfidenceMode').checked = data.RISK.supremeConfidenceMode !== false;
                    document.getElementById('enablePositionPyramiding').checked = data.RISK.enablePositionPyramiding !== false;
                    // Smart Safeguards
                    document.getElementById('maxConsecutiveLosses').value = (data.RISK.maxConsecutiveLosses ?? 5);
                    document.getElementById('maxDailyLosses').value = (data.RISK.maxDailyLosses ?? 8);
                    document.getElementById('withdrawalNotification').value = (data.RISK.withdrawalNotification ?? 1000);
                    // Max position size
                    document.getElementById('maxPositionSize').value = ((data.MAX_POSITION_SIZE ?? 0.25) * 100);
                    // Resume button visibility
                    const resumeBtn = document.getElementById('resumeTradingBtn');
                    if (resumeBtn) {
                        const needsResume = (data.RISK.globalStopLossOverride ?? false);
                        resumeBtn.style.display = needsResume ? 'none' : 'inline-block';
                        resumeBtn.textContent = needsResume ? '✅ Override Active' : '🔓 Resume Trading';
                    }
                }
                // 📱 TELEGRAM SETTINGS
                if (data.TELEGRAM) {
                    document.getElementById('telegramEnabled').checked = (data.TELEGRAM.enabled ?? false);
                    // Don't populate token (security) - only show if set
                    if (data.TELEGRAM.chatId) document.getElementById('telegramChatId').value = data.TELEGRAM.chatId;
                }
                // Active preset label (source-of-truth from server)
                const presetLabel = document.getElementById('activePresetLabel');
                if (presetLabel) presetLabel.textContent = (data.ACTIVE_PRESET ?? 'CUSTOM');
                // 🎛️ PER-ASSET CONTROLS
                if (data.ASSET_CONTROLS) {
                    if (data.ASSET_CONTROLS.BTC) {
                        const btcEnabledEl = document.getElementById('btcEnabled');
                        const btcMaxEl = document.getElementById('btcMaxTrades');
                        if (btcEnabledEl) btcEnabledEl.checked = data.ASSET_CONTROLS.BTC.enabled !== false;
                        if (btcMaxEl) btcMaxEl.value = (data.ASSET_CONTROLS.BTC.maxTradesPerCycle ?? 1);
                    }
                    if (data.ASSET_CONTROLS.ETH) {
                        const ethEnabledEl = document.getElementById('ethEnabled');
                        const ethMaxEl = document.getElementById('ethMaxTrades');
                        if (ethEnabledEl) ethEnabledEl.checked = data.ASSET_CONTROLS.ETH.enabled !== false;
                        if (ethMaxEl) ethMaxEl.value = (data.ASSET_CONTROLS.ETH.maxTradesPerCycle ?? 1);
                    }
                    if (data.ASSET_CONTROLS.SOL) {
                        const solEnabledEl = document.getElementById('solEnabled');
                        const solMaxEl = document.getElementById('solMaxTrades');
                        if (solEnabledEl) solEnabledEl.checked = data.ASSET_CONTROLS.SOL.enabled !== false;
                        if (solMaxEl) solMaxEl.value = (data.ASSET_CONTROLS.SOL.maxTradesPerCycle ?? 1);
                    }
                    if (data.ASSET_CONTROLS.XRP) {
                        const xrpEnabledEl = document.getElementById('xrpEnabled');
                        const xrpMaxEl = document.getElementById('xrpMaxTrades');
                        if (xrpEnabledEl) xrpEnabledEl.checked = data.ASSET_CONTROLS.XRP.enabled !== false;
                        if (xrpMaxEl) xrpMaxEl.value = (data.ASSET_CONTROLS.XRP.maxTradesPerCycle ?? 1);
                    }
                }
                // 🕐 MIN ELAPSED SECONDS
                if (data.ORACLE && data.ORACLE.minElapsedSeconds !== undefined) {
                    document.getElementById('minElapsedSeconds').value = data.ORACLE.minElapsedSeconds;
                }
            } catch (e) { console.error(e); }
        }
        function toggleModeConfig() { const p = document.getElementById('modeConfigPanel'); if(p) p.style.display = p.style.display === 'none' ? 'block' : 'none'; }
        async function applyPreset(preset) {
            const presets = {
                // 👑 PINNACLE_OPTIMAL: THE ULTIMATE - ALL forensic-analysis-derived optimal settings
                PINNACLE_OPTIMAL: { 
                    ORACLE: { enabled: true, aggression: 50, minConsensus: 0.70, minConfidence: 0.70, minEdge: 5, maxOdds: 0.48, minStability: 3, requireTrending: false, earlyTakeProfitEnabled: true, earlyTakeProfitThreshold: 0.20, hedgeEnabled: true, hedgeRatio: 0.20, stopLossEnabled: true, stopLoss: 0.30 }, 
                    ILLIQUIDITY_GAP: { enabled: true, minGap: 0.03, maxEntryTotal: 0.97 },
                    DEATH_BOUNCE: { enabled: true, minPrice: 0.03, maxPrice: 0.12, targetPrice: 0.18, minScore: 1.5 },
                    SCALP: { enabled: false }, 
                    ARBITRAGE: { enabled: false }, 
                    MOMENTUM: { enabled: false }, 
                    UNCERTAINTY: { enabled: false }, 
                    RISK: { maxTotalExposure: 0.50, globalStopLoss: 0.40, cooldownAfterLoss: 1200, maxConsecutiveLosses: 3, maxGlobalTradesPerCycle: 2, supremeConfidenceMode: false, firstMoveAdvantage: false, enablePositionPyramiding: false, enableLossCooldown: true },
                    ASSET_CONTROLS: { BTC: { enabled: true, maxTradesPerCycle: 1 }, ETH: { enabled: true, maxTradesPerCycle: 1 }, SOL: { enabled: true, maxTradesPerCycle: 1 }, XRP: { enabled: true, maxTradesPerCycle: 1 } }
                },
                // 🏆 APEX v24: 5-Layer Zero-Variance System (THE PINNACLE)
                APEX_V24: { 
                    ORACLE: { enabled: true, aggression: 50, minConsensus: 0.85, minConfidence: 0.85, minEdge: 10, maxOdds: 0.48, minStability: 4, requireTrending: true, earlyTakeProfitEnabled: true, earlyTakeProfitThreshold: 0.20, hedgeEnabled: true, hedgeRatio: 0.20 }, 
                    ILLIQUIDITY_GAP: { enabled: true, minGap: 0.03, maxEntryTotal: 0.97 },
                    DEATH_BOUNCE: { enabled: true, minPrice: 0.03, maxPrice: 0.12, targetPrice: 0.18, minScore: 1.5 },
                    SCALP: { enabled: false }, 
                    ARBITRAGE: { enabled: false }, 
                    MOMENTUM: { enabled: false }, 
                    UNCERTAINTY: { enabled: false }, 
                    RISK: { maxTotalExposure: 0.50, globalStopLoss: 0.40, cooldownAfterLoss: 1200, maxConsecutiveLosses: 3, maxGlobalTradesPerCycle: 1, supremeConfidenceMode: true, firstMoveAdvantage: false, enablePositionPyramiding: false } 
                },
                GUARDIAN_V23: { ORACLE: { enabled: true, aggression: 50, minConsensus: 0.70, minConfidence: 0.70, minEdge: 10, maxOdds: 0.48, minStability: 4, requireTrending: true, earlyTakeProfitEnabled: true, earlyTakeProfitThreshold: 0.20 }, SCALP: { enabled: false }, ARBITRAGE: { enabled: false }, MOMENTUM: { enabled: false }, UNCERTAINTY: { enabled: false }, RISK: { maxTotalExposure: 0.50, globalStopLoss: 0.40, cooldownAfterLoss: 1200, maxConsecutiveLosses: 3, maxGlobalTradesPerCycle: 1, supremeConfidenceMode: true, firstMoveAdvantage: false, enablePositionPyramiding: false } },
                CONSERVATIVE: { ORACLE: { enabled: true, minConsensus: 0.90, minConfidence: 0.92, minEdge: 20, maxOdds: 0.60 }, SCALP: { enabled: false }, ARBITRAGE: { enabled: false }, RISK: { maxTotalExposure: 0.20, globalStopLoss: 0.15, cooldownAfterLoss: 600 } },
                BALANCED: { ORACLE: { enabled: true, minConsensus: 0.85, minConfidence: 0.85, minEdge: 15, maxOdds: 0.70 }, SCALP: { enabled: true, maxEntryPrice: 0.20, targetMultiple: 2.0 }, ARBITRAGE: { enabled: true, minMispricing: 0.15, targetProfit: 0.50, stopLoss: 0.30 }, RISK: { maxTotalExposure: 0.30, globalStopLoss: 0.20, cooldownAfterLoss: 300 } },
                AGGRESSIVE: { ORACLE: { enabled: true, minConsensus: 0.75, minConfidence: 0.70, minEdge: 10, maxOdds: 0.80 }, SCALP: { enabled: true, maxEntryPrice: 0.30, targetMultiple: 1.5 }, ARBITRAGE: { enabled: true, minMispricing: 0.10, targetProfit: 0.30, stopLoss: 0.40 }, RISK: { maxTotalExposure: 0.50, globalStopLoss: 0.30, cooldownAfterLoss: 120 } }
            };

            const base = presets[preset];
            const p = base ? { ...base, ACTIVE_PRESET: preset } : null;
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
                ACTIVE_PRESET: 'CUSTOM',
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
                    minStability: 3,
                    stopLossEnabled: document.getElementById('oracleStopLossEnabled').checked,
                    stopLoss: parseFloat(document.getElementById('oracleStopLoss').value) / 100
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
                // 💰 ILLIQUIDITY_GAP (True Arbitrage)
                ILLIQUIDITY_GAP: {
                    enabled: document.getElementById('ilGapEnabled').checked,
                    minGap: parseFloat(document.getElementById('ilGapMinGap').value),
                    maxEntryTotal: parseFloat(document.getElementById('ilGapMaxEntry').value)
                },
                // 💀 DEATH_BOUNCE (Genesis-Aligned)
                DEATH_BOUNCE: {
                    enabled: document.getElementById('dbEnabled').checked,
                    minPrice: parseFloat(document.getElementById('dbMinPrice').value) / 100,
                    maxPrice: parseFloat(document.getElementById('dbMaxPrice').value) / 100,
                    targetPrice: parseFloat(document.getElementById('dbTargetPrice').value) / 100,
                    minScore: parseFloat(document.getElementById('dbMinScore').value)
                },
                RISK: { 
                    maxTotalExposure: parseFloat(document.getElementById('riskMaxExposure').value) / 100, 
                    globalStopLoss: parseFloat(document.getElementById('riskStopLoss').value) / 100, 
                    cooldownAfterLoss: parseInt(document.getElementById('riskCooldown').value),
                    noTradeDetection: document.getElementById('noTradeDetection').checked,
                    // Smart Aggressive toggles
                    enableLossCooldown: document.getElementById('enableLossCooldown').checked,
                    enableCircuitBreaker: document.getElementById('enableCircuitBreaker').checked,
                    enableDivergenceBlocking: document.getElementById('enableDivergenceBlocking').checked,
                    aggressiveSizingOnLosses: document.getElementById('aggressiveSizingOnLosses').checked,
                    // 🔮 Oracle features
                    firstMoveAdvantage: document.getElementById('firstMoveAdvantage').checked,
                    supremeConfidenceMode: document.getElementById('supremeConfidenceMode').checked,
                    enablePositionPyramiding: document.getElementById('enablePositionPyramiding').checked,
                    // Smart Safeguards
                    maxConsecutiveLosses: parseInt(document.getElementById('maxConsecutiveLosses').value),
                    maxDailyLosses: parseInt(document.getElementById('maxDailyLosses').value),
                    withdrawalNotification: parseInt(document.getElementById('withdrawalNotification').value)
                },
                // Also save maxTradesPerCycle to all assets
                ASSET_CONTROLS: {
                    BTC: { enabled: true, maxTradesPerCycle: parseInt(document.getElementById('maxTradesPerCycle').value) },
                    ETH: { enabled: true, maxTradesPerCycle: parseInt(document.getElementById('maxTradesPerCycle').value) },
                    SOL: { enabled: true, maxTradesPerCycle: parseInt(document.getElementById('maxTradesPerCycle').value) },
                    XRP: { enabled: true, maxTradesPerCycle: parseInt(document.getElementById('maxTradesPerCycle').value) }
                }
            }; updates.MAX_POSITION_SIZE = parseFloat(document.getElementById('maxPositionSize').value) / 100;
            const apiKey = document.getElementById('apiKey').value;
            const apiSecret = document.getElementById('apiSecret').value;
            const apiPassphrase = document.getElementById('apiPassphrase').value;
            const privateKey = document.getElementById('privateKey').value;
            if (apiKey) updates.POLYMARKET_API_KEY = apiKey;
            if (apiSecret) updates.POLYMARKET_SECRET = apiSecret;
            if (apiPassphrase) updates.POLYMARKET_PASSPHRASE = apiPassphrase;
            if (privateKey) updates.POLYMARKET_PRIVATE_KEY = privateKey;
            
            // 📱 TELEGRAM SETTINGS
            const telegramToken = document.getElementById('telegramToken').value;
            const telegramChatId = document.getElementById('telegramChatId').value;
            updates.TELEGRAM = {
                enabled: document.getElementById('telegramEnabled').checked,
                botToken: telegramToken || undefined,
                chatId: telegramChatId || undefined
            };
            
            // 🎛️ PER-ASSET CONTROLS
            updates.ASSET_CONTROLS = {
                BTC: { enabled: document.getElementById('btcEnabled').checked, maxTradesPerCycle: parseInt(document.getElementById('btcMaxTrades').value) || 1 },
                ETH: { enabled: document.getElementById('ethEnabled').checked, maxTradesPerCycle: parseInt(document.getElementById('ethMaxTrades').value) || 1 },
                SOL: { enabled: document.getElementById('solEnabled').checked, maxTradesPerCycle: parseInt(document.getElementById('solMaxTrades').value) || 1 },
                XRP: { enabled: document.getElementById('xrpEnabled').checked, maxTradesPerCycle: parseInt(document.getElementById('xrpMaxTrades').value) || 1 }
            };
            
            // 🕐 MIN ELAPSED SECONDS (add to ORACLE config)
            updates.ORACLE.minElapsedSeconds = parseInt(document.getElementById('minElapsedSeconds').value) || 60;
            
            try {
                await fetch('/api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(updates) });
                document.getElementById('settingsStatus').textContent = '✅ All settings saved!';
                document.getElementById('settingsStatus').className = 'status-msg success';
                fetchData();
            } catch (e) { document.getElementById('settingsStatus').textContent = '❌ Error saving'; document.getElementById('settingsStatus').className = 'status-msg error'; }
        }
        
        function applyRiskPreset(preset) {
            if (preset === 'SAFE') {
                document.getElementById('riskMaxExposure').value = 30;
                document.getElementById('maxPositionSize').value = 10;
                document.getElementById('riskCooldown').value = 300;
                document.getElementById('riskStopLoss').value = 20;
                document.getElementById('maxConsecutiveLosses').value = 2;
                document.getElementById('maxDailyLosses').value = 3;
                document.getElementById('maxTradesPerCycle').value = 1;
                document.getElementById('enableLossCooldown').checked = true;
                document.getElementById('enableCircuitBreaker').checked = true;
                document.getElementById('enableDivergenceBlocking').checked = true;
                document.getElementById('aggressiveSizingOnLosses').checked = false;
                document.getElementById('firstMoveAdvantage').checked = false;
                document.getElementById('supremeConfidenceMode').checked = false;
                document.getElementById('enablePositionPyramiding').checked = false;
            } else if (preset === 'BALANCED') {
                document.getElementById('riskMaxExposure').value = 50;
                document.getElementById('maxPositionSize').value = 20;
                document.getElementById('riskCooldown').value = 60;
                document.getElementById('riskStopLoss').value = 30;
                document.getElementById('maxConsecutiveLosses').value = 3;
                document.getElementById('maxDailyLosses').value = 5;
                document.getElementById('maxTradesPerCycle').value = 3;
                document.getElementById('enableLossCooldown').checked = true;
                document.getElementById('enableCircuitBreaker').checked = true;
                document.getElementById('enableDivergenceBlocking').checked = true;
                document.getElementById('aggressiveSizingOnLosses').checked = false;
                document.getElementById('firstMoveAdvantage').checked = false;
                document.getElementById('supremeConfidenceMode').checked = false;
                document.getElementById('enablePositionPyramiding').checked = false;
            } else if (preset === 'AGGRESSIVE') {
                document.getElementById('riskMaxExposure').value = 100;
                document.getElementById('maxPositionSize').value = 25;
                document.getElementById('riskCooldown').value = 0;
                document.getElementById('riskStopLoss').value = 50;
                document.getElementById('maxConsecutiveLosses').value = 5;
                document.getElementById('maxDailyLosses').value = 10;
                document.getElementById('maxTradesPerCycle').value = 5;
                document.getElementById('enableLossCooldown').checked = false;
                document.getElementById('enableCircuitBreaker').checked = false;
                document.getElementById('enableDivergenceBlocking').checked = false;
                document.getElementById('aggressiveSizingOnLosses').checked = true;
                document.getElementById('firstMoveAdvantage').checked = false;
                document.getElementById('supremeConfidenceMode').checked = false;
                document.getElementById('enablePositionPyramiding').checked = false;
            } else if (preset === 'ORACLE') {
                document.getElementById('riskMaxExposure').value = 75;
                document.getElementById('maxPositionSize').value = 25;
                document.getElementById('riskCooldown').value = 0;
                document.getElementById('riskStopLoss').value = 40;
                document.getElementById('maxConsecutiveLosses').value = 5;
                document.getElementById('maxDailyLosses').value = 8;
                document.getElementById('maxTradesPerCycle').value = 5;
                document.getElementById('enableLossCooldown').checked = false;
                document.getElementById('enableCircuitBreaker').checked = false;
                document.getElementById('enableDivergenceBlocking').checked = false;
                document.getElementById('aggressiveSizingOnLosses').checked = true;
                document.getElementById('firstMoveAdvantage').checked = true;
                document.getElementById('supremeConfidenceMode').checked = true;
                document.getElementById('enablePositionPyramiding').checked = true;
            }
            saveAllSettings();
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
                    alert('❌ Sell failed: ' + result.error + (result.needsManualIntervention ? '\\n\\nCheck /api/pending-sells for stuck positions.' : ''));
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
        
        // 🔓 TOGGLE GLOBAL STOP LOSS OVERRIDE (Resume Trading)
        async function toggleStopLossOverride() {
            if (!confirm('Override global stop loss and resume trading?\\n\\nThis bypasses the 20% daily loss protection. Use with caution.')) return;
            try {
                const res = await fetch('/api/toggle-stop-loss-override', { method: 'POST' });
                const result = await res.json();
                alert(result.message);
                fetchData();
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



function buildStateSnapshot() {
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
    const inCooldown = tradeExecutor.isInCooldown();
    const cooldownRemaining = inCooldown ? Math.ceil((CONFIG.RISK.cooldownAfterLoss * 1000 - (Date.now() - tradeExecutor.lastLossTime)) / 1000) : 0;
    // 🔴 FIX #18: Only NEGATIVE P/L triggers stop loss (was using Math.abs which triggered on PROFIT!)
    const globalStopTriggered = tradeExecutor.todayPnL < 0 && Math.abs(tradeExecutor.todayPnL) > tradeExecutor.paperBalance * CONFIG.RISK.globalStopLoss;

    // 🔴 FIX #15: Determine halt reason for UI display
    let haltReason = null;
    if (inCooldown) {
        haltReason = `⏳ COOLDOWN: ${Math.floor(cooldownRemaining / 60)}m ${cooldownRemaining % 60}s remaining after ${tradeExecutor.consecutiveLosses || 0} consecutive losses`;
    } else if (globalStopTriggered) {
        haltReason = `🛑 GLOBAL STOP LOSS: Daily loss exceeds ${(CONFIG.RISK.globalStopLoss * 100).toFixed(0)}%`;
    }

    response._trading = {
        mode: CONFIG.TRADE_MODE,
        balance: tradeExecutor.paperBalance,
        liveBalance: tradeExecutor.cachedLiveBalance,
        maticBalance: tradeExecutor.cachedMATICBalance,
        estimatedTradesRemaining: tradeExecutor.getEstimatedTradesRemaining(),
        todayPnL: tradeExecutor.todayPnL,
        positions: tradeExecutor.positions,
        positionCount: Object.keys(tradeExecutor.positions).length,
        tradeHistory: tradeExecutor.tradeHistory.slice(-20), // Last 20 trades
        // 🎯 GOLDEN MEAN: State machine info
        tradingState: tradeExecutor.tradingState || 'HARVEST',
        stateSizeMultiplier: tradeExecutor.getStateSizeMultiplier ? tradeExecutor.getStateSizeMultiplier() : 1.0,
        recentWinStreak: tradeExecutor.recentWinStreak || 0,
        recentLossStreak: tradeExecutor.recentLossStreak || 0,
        modes: {
            ORACLE: CONFIG.ORACLE.enabled,
            ARBITRAGE: CONFIG.ARBITRAGE.enabled,
            ILLIQUIDITY_GAP: CONFIG.ILLIQUIDITY_GAP.enabled,  // 🏆 APEX v24: TRUE ARBITRAGE
            DEATH_BOUNCE: CONFIG.DEATH_BOUNCE.enabled,        // 🏆 APEX v24: EXTREME SCALP
            SCALP: CONFIG.SCALP.enabled,
            UNCERTAINTY: CONFIG.UNCERTAINTY.enabled,
            MOMENTUM: CONFIG.MOMENTUM.enabled
        },
        // 🔴 FIX #15: Comprehensive halt status for UI
        inCooldown: inCooldown,
        cooldownRemaining: cooldownRemaining,
        consecutiveLosses: tradeExecutor.consecutiveLosses || 0,
        globalStopTriggered: globalStopTriggered,
        haltReason: haltReason,
        isHalted: inCooldown || globalStopTriggered
    };

    return response;
}

app.get('/api/state', (req, res) => {
    res.json(buildStateSnapshot());
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

    // 📱 Telegram notification
    if (CONFIG.RISK.globalStopLossOverride) {
        sendTelegramNotification(telegramSystemAlert('⚠️ Stop Loss Override', 'Global stop loss has been BYPASSED. Trading will continue even after exceeding daily loss limit.'));
    } else {
        sendTelegramNotification(telegramSystemAlert('✅ Stop Loss Restored', 'Global stop loss is now ACTIVE. Trading will halt at 20% daily loss.'));
    }

    res.json({
        success: true,
        override: CONFIG.RISK.globalStopLossOverride,
        message: `Global stop loss is now ${status}. Trading will ${CONFIG.RISK.globalStopLossOverride ? 'continue even after 20% daily loss' : 'halt at 20% daily loss'}.`
    });
});

// 🚀 PINNACLE v27: CRASH RECOVERY QUEUE API ENDPOINTS

// Get recovery queue (orphaned/crashed positions)
app.get('/api/recovery-queue', (req, res) => {
    const queue = tradeExecutor.recoveryQueue || [];
    res.json({
        success: true,
        count: queue.length,
        items: queue,
        summary: queue.map(item => ({
            id: item.id,
            asset: item.asset,
            side: item.side,
            entry: item.entry,
            size: item.size,
            isLive: item.isLive,
            status: item.status,
            reason: item.reason
        }))
    });
});

// Acknowledge and clear a specific recovery item
app.post('/api/recovery-acknowledge', (req, res) => {
    const { id } = req.body;
    if (!id) {
        return res.status(400).json({ success: false, error: 'Missing id parameter' });
    }

    if (!tradeExecutor.recoveryQueue) {
        return res.status(404).json({ success: false, error: 'No recovery queue' });
    }

    const index = tradeExecutor.recoveryQueue.findIndex(item => item.id === id);
    if (index === -1) {
        return res.status(404).json({ success: false, error: 'Item not found in recovery queue' });
    }

    const removed = tradeExecutor.recoveryQueue.splice(index, 1)[0];
    log(`✅ RECOVERY ACKNOWLEDGED: ${removed.id} (${removed.asset} ${removed.side})`);

    res.json({
        success: true,
        message: `Acknowledged and removed: ${id}`,
        removed
    });
});

// Clear entire recovery queue
app.post('/api/clear-recovery-queue', (req, res) => {
    const count = (tradeExecutor.recoveryQueue || []).length;
    tradeExecutor.recoveryQueue = [];
    log(`🧹 RECOVERY QUEUE CLEARED: ${count} items removed`);

    res.json({
        success: true,
        message: `Cleared ${count} items from recovery queue`
    });
});

// Get pending sells (failed sell orders)
app.get('/api/pending-sells', (req, res) => {
    const pending = tradeExecutor.pendingSells || {};
    res.json({
        success: true,
        count: Object.keys(pending).length,
        items: pending
    });
});

// Retry pending sells
app.post('/api/retry-pending-sells', async (req, res) => {
    const pending = tradeExecutor.pendingSells || {};
    const count = Object.keys(pending).length;

    if (count === 0) {
        return res.json({ success: true, message: 'No pending sells to retry' });
    }

    log(`🔄 RETRYING ${count} pending sells...`);

    for (const [key, position] of Object.entries(pending)) {
        try {
            const result = await tradeExecutor.executeSellOrderWithRetry(position, 3, 2000);
            if (result.success) {
                delete tradeExecutor.pendingSells[key];
                log(`✅ Pending sell resolved: ${key}`);
            }
        } catch (e) {
            log(`❌ Pending sell retry failed: ${key} - ${e.message}`);
        }
    }

    res.json({
        success: true,
        message: `Retried ${count} pending sells`,
        remaining: Object.keys(tradeExecutor.pendingSells || {}).length
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
            depositAddress: walletInfo.address, // Same address to receive funds
            estimatedTradesRemaining: tradeExecutor.getEstimatedTradesRemaining()
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

        // Execute the transfer
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
        // Build fingerprint (tie UI + debug exports to exact deployed code/config)
        CODE: typeof CODE_FINGERPRINT !== 'undefined' ? CODE_FINGERPRINT : null,
        ACTIVE_PRESET: CONFIG.ACTIVE_PRESET || 'CUSTOM',

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
        ILLIQUIDITY_GAP: CONFIG.ILLIQUIDITY_GAP,  // 🏆 APEX v24: TRUE ARBITRAGE
        DEATH_BOUNCE: CONFIG.DEATH_BOUNCE,        // 🏆 APEX v24: EXTREME SCALP
        SCALP: CONFIG.SCALP,
        UNCERTAINTY: CONFIG.UNCERTAINTY,
        MOMENTUM: CONFIG.MOMENTUM,
        RISK: CONFIG.RISK,

        // 📱 Telegram (chatId visible, token masked)
        TELEGRAM: {
            enabled: CONFIG.TELEGRAM?.enabled || false,
            botToken: CONFIG.TELEGRAM?.botToken ? '****HIDDEN****' : '',
            chatId: CONFIG.TELEGRAM?.chatId || ''
        },

        // 🎛️ Per-Asset Trading Controls
        ASSET_CONTROLS: CONFIG.ASSET_CONTROLS,

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
                // 🔴 CONFIG_VERSION: Used to invalidate stale settings when code changes
                _CONFIG_VERSION: CONFIG_VERSION,
                // UI / Ops metadata
                ACTIVE_PRESET: CONFIG.ACTIVE_PRESET,
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
                // 🏆 APEX v24 MODES (CRITICAL: Must persist to survive restarts!)
                ILLIQUIDITY_GAP: CONFIG.ILLIQUIDITY_GAP,
                DEATH_BOUNCE: CONFIG.DEATH_BOUNCE,
                RISK: CONFIG.RISK,
                // 📱 Telegram Settings
                TELEGRAM: CONFIG.TELEGRAM,
                // 🎛️ Per-Asset Trading Controls
                ASSET_CONTROLS: CONFIG.ASSET_CONTROLS
            };
            await redis.set('deity:settings', JSON.stringify(persistedSettings));
            log('💾 Settings persisted to Redis');
        } catch (e) {
            log(`⚠️ Failed to persist settings: ${e.message}`);
        }
    }

    // 📱 Telegram: Silent notification for settings update (won't ding user's phone)
    sendTelegramNotification(telegramSystemAlert('⚙️ Settings Updated', `${Object.keys(req.body).join(', ')} values changed`), true);

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
                <div class="form-group" style="grid-column: span 2;">
                    <label style="display: flex; align-items: center; gap: 10px; cursor: pointer;">
                        <input type="checkbox" id="NO_TRADE_DETECTION" checked style="width: 20px; height: 20px;">
                        <span>🎲 No-Trade Detection (Skip genuinely random markets)</span>
                    </label>
                    <small style="color: #888; display: block; margin-top: 5px;">
                        When enabled, refuses to trade in choppy markets with weak signals. Disable to force trades in all conditions.
                    </small>
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
                
                // No-Trade Detection checkbox
                document.getElementById('NO_TRADE_DETECTION').checked = currentSettings.RISK?.noTradeDetection !== false;
                
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
        
        <h2>🔮 Oracle Mode Features (PINNACLE)</h2>
        
        <div class="card mode-card oracle">
            <h3>⚡ First-Move Advantage</h3>
            <p><strong>What:</strong> +0-10% confidence bonus for trades within first 30 seconds of cycle.</p>
            <p><strong>Why:</strong> Early entry = better odds before market catches up.</p>
            <p><strong>Enable:</strong> Settings → Risk Management → Oracle Mode Features → First-Move Advantage</p>
        </div>
        
        <div class="card mode-card oracle">
            <h3>👑 Supreme Confidence Mode</h3>
            <p><strong>What:</strong> Blocks ALL trades below 75% confidence.</p>
            <p><strong>Why:</strong> Only trades with highest conviction execute.</p>
            <p><strong>Enable:</strong> Settings → Risk Management → Oracle Mode Features → Supreme Confidence</p>
        </div>
        
        <div class="card mode-card oracle">
            <h3>📈 Position Pyramiding</h3>
            <p><strong>What:</strong> Adds 50% more capital to winning Oracle positions (held >2min, +15% profit).</p>
            <p><strong>Why:</strong> Compound winners while they're winning.</p>
            <p><strong>Enable:</strong> Settings → Risk Management → Oracle Mode Features → Position Pyramiding</p>
        </div>
        
        <div class="tip">
            <h3>🎯 Recommended Oracle Settings</h3>
            <ul style="margin-left: 20px; margin-top: 10px;">
                <li><strong>For 90%+ Win Rate:</strong> Enable Supreme Confidence + First-Move Advantage</li>
                <li><strong>For Maximum Compounding:</strong> Also enable Position Pyramiding</li>
                <li><strong>Quick Setup:</strong> Click "🔮 Oracle" preset in Risk Management</li>
            </ul>
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
        // Process within checkpoint window (first 5 seconds of new cycle)
        if (now >= cp && now < cp + 5) {
            if (lastEvaluatedCheckpoint[a] !== cp) {

                // Check data freshness but DO NOT BLOCK - locks MUST reset!
                const dataAge = Date.now() - lastUpdateTimestamp;
                const isStale = dataAge > 3000;

                if (isStale) {
                    log(`⚠️ STALE DATA WARNING: ${(dataAge / 1000).toFixed(1)}s old - using last known prices`, a);
                }

                // 🔮 CRITICAL: ALWAYS reset locks at cycle end to prevent dormancy
                // This was the bug - stale data was blocking lock reset!
                Brains[a].convictionLocked = false;
                Brains[a].lockedDirection = null;
                Brains[a].lockTime = null;
                Brains[a].lockConfidence = 0;
                Brains[a].cycleCommitted = false;
                Brains[a].committedDirection = null;
                Brains[a].commitTime = null;
                Brains[a].lockState = 'NEUTRAL';
                Brains[a].lockStrength = 0;
                log(`🔓 LOCKS RESET for new cycle`, a);

                // Evaluate the JUST FINISHED cycle (use last known prices if stale)
                if (checkpointPrices[a] && livePrices[a]) {
                    // CRITICAL: Determine final outcome and resolve ALL positions
                    const finalOutcome = livePrices[a] >= checkpointPrices[a] ? 'UP' : 'DOWN';
                    const yesPrice = currentMarkets[a]?.yesPrice || 0.5;
                    const noPrice = currentMarkets[a]?.noPrice || 0.5;

                    // Close ALL open positions at cycle end with binary resolution
                    tradeExecutor.resolveAllPositions(a, finalOutcome, yesPrice, noPrice);

                    // Only run full evaluation if data is fresh (for accurate learning)
                    if (!isStale) {
                        Brains[a].evaluateOutcome(livePrices[a], checkpointPrices[a]);
                        log(`📊 Evaluated checkpoint ${cp - INTERVAL_SECONDS} (fresh data)`, a);
                    } else {
                        log(`⚠️ Skipping learning evaluation (stale data) but positions resolved`, a);
                    }
                }

                // Update checkpoints for the NEW cycle
                previousCheckpointPrices[a] = checkpointPrices[a];
                checkpointPrices[a] = livePrices[a];

                // Clear brain state for new cycle
                Brains[a].lastSignal = null;
                Brains[a].prediction = 'WAIT';
                Brains[a].tier = 'NONE';
                Brains[a].stabilityCounter = 0;
                Brains[a].pendingSignal = null;
                Brains[a].voteHistory = [];
                Brains[a].currentCycleHistory = [];

                // 🔄 EXPLICIT RESET: Clear trade counts for new cycle
                // This ensures trade limits reset even if internal checks fail
                tradeExecutor.cycleTradeCount[a] = 0;
                tradeExecutor.currentCycleStart = cp;

                // 🔴 BUG FIX: Cleanup any stale positions that weren't resolved
                tradeExecutor.cleanupStalePositions();

                // 🔄 EXPLICIT RESET: Clear opportunity detector's cycle tracking
                opportunityDetector.tradesThisCycle = {};
                opportunityDetector.currentCycleStart = cp;

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

    // 🔮 MAIN UPDATE LOOP: Every second, update brains AND check exit conditions
    setInterval(() => {
        ASSETS.forEach(a => {
            Brains[a].update();

            // 🔴 CRITICAL: Check exit conditions for all positions
            // This was MISSING - checkExits was never called!
            const now = Math.floor(Date.now() / 1000);
            const elapsed = now % INTERVAL_SECONDS;
            const market = currentMarkets[a];
            if (market) {
                tradeExecutor.checkExits(a, livePrices[a], elapsed, market.yesPrice, market.noPrice);
            }
        });
    }, 1000);

    // Update UI dashboard every second (start after initialization)
    setInterval(emitUIUpdate, 1000);
    setInterval(emitStateUpdate, 1000);

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

    // 💰 Periodic balance monitoring (every 5 minutes) - alerts on low gas/USDC
    setInterval(() => tradeExecutor.checkLowBalances(), 300000);
    // Initial check after 30 seconds (give server time to start)
    setTimeout(() => tradeExecutor.checkLowBalances(), 30000);

    server.listen(PORT, () => {
        log(`⚡ SUPREME DEITY SERVER ONLINE on port ${PORT} `);
        log(`🌐 Access at: http://localhost:${PORT}`);

        // 📱 Telegram: Server Online notification
        sendTelegramNotification(telegramServerStatus('online', {
            mode: CONFIG.TRADE_MODE,
            balance: tradeExecutor.mode === 'PAPER' ? tradeExecutor.paperBalance : null
        }));
    });
}

// ==================== GLOBAL ERROR HANDLERS ====================
// CRITICAL: Prevent server crashes - catch ALL errors

process.on('uncaughtException', (error) => {
    log(`🔴 UNCAUGHT EXCEPTION: ${error.message}`);
    log(`Stack: ${error.stack}`);
    // DON'T EXIT - keep running
    // Log to file or monitoring service if needed
});

process.on('unhandledRejection', (reason, promise) => {
    log(`🔴 UNHANDLED REJECTION: ${reason}`);
    if (reason instanceof Error) {
        log(`Stack: ${reason.stack}`);
    }
    // DON'T EXIT - keep running
});

// Graceful shutdown handlers
process.on('SIGTERM', () => {
    log('🛑 SIGTERM received - shutting down gracefully...');
    saveState();
    process.exit(0);
});

process.on('SIGINT', () => {
    log('🛑 SIGINT received - shutting down gracefully...');
    saveState();
    process.exit(0);
});

startup();
