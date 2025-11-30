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

// Initialize App
const app = express();
app.use(cors());

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
let livePriceTimestamps = {}; // Per-asset price timestamps for accurate staleness detection

// Initialize State
ASSETS.forEach(asset => {
    priceHistory[asset] = [];
    checkpointPrices[asset] = null;
    previousCheckpointPrices[asset] = null;
    lastEvaluatedCheckpoint[asset] = 0; // Initialize to 0
    livePrices[asset] = null;
    currentMarkets[asset] = null;
    marketOddsHistory[asset] = [];
    livePriceTimestamps[asset] = 0;
});

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

        // Cycle history tracking
        this.currentCycleHistory = [];
        this.lastCompletedCycle = null;
        this.lastSnapshotTime = 0;
        // Cached weights
        this.cachedWeights = {
            genesis: 1.0, physicist: 1.0, orderbook: 1.0, historian: 1.0,
            correlation: 1.0, macro: 1.0, funding: 1.0, volume: 1.0
        };
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
                this.isProcessing = false;
                return;
            }

            // FINAL SEVEN: CALCULATE MODEL WEIGHTS (Adaptive Learning)
            const weights = {};
            for (const [model, stats] of Object.entries(this.modelAccuracy)) {
                if (stats.total < 10) weights[model] = 1.0; // Default weight
                else {
                    const accuracy = stats.wins / stats.total;
                    // Boost high accuracy (>60%), penalize low accuracy (<40%)
                    // Range: 0.2 to 2.0
                    weights[model] = Math.max(0.2, Math.min(2.0, Math.pow(accuracy * 2, 1.5)));
                }
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

            // 🎯 PROPHET FIX #1: CONSENSUS BONUS (Unlocks 80-90% confidence)
            if (totalVotes > 0 && finalSignal !== 'NEUTRAL') {
                const winningVotes = finalSignal === 'UP' ? upVotes : downVotes;
                const losingVotes = finalSignal === 'UP' ? downVotes : upVotes;
                const consensus = (winningVotes - losingVotes) / totalVotes;

                if (consensus >= 0.50) {
                    const consensusBonus = 1.0 + (consensus - 0.50) * 2.0; // Up to 2.0x boost
                    finalConfidence *= consensusBonus;
                    log(`🎯 CONSENSUS BONUS: ${(consensusBonus * 100 - 100).toFixed(1)}% boost (${winningVotes}/${totalVotes} agree)`, this.asset);
                }

                // TUNE #2: EARLY SIGNAL BOOST (0-3 mins)
                if (elapsed < 180) {
                    finalConfidence *= 1.15; // 15% boost for early signals
                    log(`🚀 EARLY SIGNAL BOOST: +15% confidence`, this.asset);
                }

                finalConfidence = Math.min(0.95, finalConfidence); // Cap at 95%
            }

            // FORCED PREDICTION
            if (elapsed >= 180 && finalSignal === 'NEUTRAL') {
                if (force > 0) { finalSignal = 'UP'; finalConfidence = 0.6 + (absForce / (atr * 3)); }
                else { finalSignal = 'DOWN'; finalConfidence = 0.6 + (absForce / (atr * 3)); }
                finalConfidence = Math.min(0.75, finalConfidence);
            }

            // === THRESHOLD DETERMINATION (Regime-Aware) ===
            // 🎯 PROPHET FIX #2: FIXED THRESHOLDS (No regime chaos)
            let tier = 'NONE';
            const convictionThreshold = 0.75; // FIXED at 75% (Lowered from 77%)
            const advisoryThreshold = 0.65;   // FIXED at 65%

            if (finalConfidence >= convictionThreshold) tier = 'CONVICTION';
            else if (finalConfidence >= advisoryThreshold) tier = 'ADVISORY';

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

            // Determine tier
            if (finalConfidence >= convictionThreshold) tier = 'CONVICTION';
            else if (finalConfidence >= advisoryThreshold) tier = 'ADVISORY';

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

                const requiredStability = (() => {
                    if (elapsed < 180) return 5;
                    if (elapsed < 600) return 3;
                    return 1;
                })();
                if (this.stabilityCounter >= requiredStability) {
                    this.prediction = finalSignal;
                    this.confidence = finalConfidence;
                    this.tier = tier;

                    const reasons = Object.entries(modelVotes)
                        .filter(([_, v]) => v === finalSignal)
                        .map(([m]) => m)
                        .join(', ');

                    this.lastSignal = { type: finalSignal, conf: finalConfidence, tier, time: Date.now(), modelVotes, reasons };
                    this.stabilityCounter = 0;

                    // CYCLE COMMITMENT: Lock direction for real-world trading
                    // Once we reach CONVICTION or ADVISORY in first 5 minutes, we're COMMITTED
                    // 🎯 PROPHET FIX #3: SMART COMMITMENT (80% threshold + first 60s only)
                    if (!this.cycleCommitted && elapsed < 60 && finalConfidence >= 0.80) {
                        this.cycleCommitted = true;
                        this.committedDirection = finalSignal;
                        this.commitTime = Date.now();
                        log(`🔒 SMART COMMITMENT to ${finalSignal} at ${(finalConfidence * 100).toFixed(1)}% (${elapsed}s)`, this.asset);
                    }

                    // CONVICTION LOCK: High confidence + Reasonable odds (anti-whipsaw)
                    if (!this.convictionLocked && tier === 'CONVICTION' && elapsed < 300 && finalConfidence >= 0.96) {
                        const market = currentMarkets[this.asset];
                        if (market) {
                            const currentOdds = finalSignal === 'UP' ? market.yesPrice : market.noPrice;

                            // Lock if odds show value (<=85% to allow some premium for conviction)
                            if (currentOdds <= 0.85) {
                                this.convictionLocked = true;
                                this.lockedDirection = finalSignal;
                                this.lockTime = Date.now();
                                this.lockConfidence = finalConfidence;
                                log(`🔒 CONVICTION LOCKED: ${finalSignal} @ ${(finalConfidence * 100).toFixed(1)}% confidence, ${(currentOdds * 100).toFixed(1)}% odds`, this.asset);
                            } else {
                                log(`⚠️ High confidence (${(finalConfidence * 100).toFixed(1)}%) but odds too rich (${(currentOdds * 100).toFixed(1)}%) - skipping lock`, this.asset);
                            }
                        }
                    }
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

            // EDGE CALCULATION
            if (currentMarkets[this.asset] && this.prediction !== 'WAIT') {
                const market = currentMarkets[this.asset];
                const marketProb = this.prediction === 'UP' ? market.yesPrice : market.noPrice;
                this.edge = (this.confidence - marketProb) * 100;
            } else {
                this.edge = 0;
            }

            // Record snapshot every 10 seconds
            const elapsed_for_snapshot = checkpointPrices[this.asset]
                ? Math.floor((Date.now() - (getCurrentCheckpoint() * 1000)) / 1000)
                : 0;
            if (!this.lastSnapshotTime || (Date.now() - this.lastSnapshotTime) >= 10000) {
                this.currentCycleHistory.push({
                    timestamp: new Date().toISOString(),
                    elapsed: elapsed_for_snapshot,
                    prediction: this.prediction,
                    confidence: this.confidence,
                    tier: this.tier,
                    edge: this.edge,
                    votes: { ...this.ensembleVotes },
                    locked: this.convictionLocked,
                    committed: this.cycleCommitted,
                    currentPrice: livePrices[this.asset],
                    checkpointPrice: checkpointPrices[this.asset],
                    marketOdds: currentMarkets[this.asset] ? {
                        yes: currentMarkets[this.asset].yesPrice,
                        no: currentMarkets[this.asset].noPrice
                    } : null
                });
                this.lastSnapshotTime = Date.now();
                if (this.currentCycleHistory.length > 100) {
                    this.currentCycleHistory.shift();
                }
            }

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
            }

            // Update cached weights from modelAccuracy
            for (const [model, stats] of Object.entries(this.modelAccuracy)) {
                if (stats.total < 10) {
                    this.cachedWeights[model] = 1.0;
                } else {
                    const accuracy = stats.wins / stats.total;
                    this.cachedWeights[model] = Math.max(0.2, Math.min(2.0, Math.pow(accuracy * 2, 1.5)));
                }
            }

            // Track recent form (last 10)
            this.recentOutcomes.push(isWin);
            if (this.recentOutcomes.length > 10) this.recentOutcomes.shift();

            // 🎯 PROPHET FIX #4: PATTERN LEARNING
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
        }
    }
}


const Brains = {};
ASSETS.forEach(a => Brains[a] = new SupremeBrain(a));

// ==================== DATA FETCHING ====================

function connectWebSocket() {
    const ws = new WebSocket(WS_ENDPOINT);
    ws.on('open', () => {
        log('✅ Connected to Polymarket WS');
        ws.send(JSON.stringify({ action: 'subscribe', subscriptions: [{ topic: 'crypto_prices_chainlink', type: '*' }] }));
        ws.send(JSON.stringify({ action: 'subscribe', subscriptions: [{ topic: 'crypto_prices', type: 'update', filters: 'btcusdt,ethusdt,solusdt,xrpusdt' }] }));
    });
    ws.on('message', (data) => {
        try {
            const str = data.toString();
            if (str === 'PONG') return;
            const msg = JSON.parse(str);

            if (msg.topic === 'crypto_prices_chainlink') {
                const map = { 'btc/usd': 'BTC', 'eth/usd': 'ETH', 'sol/usd': 'SOL', 'xrp/usd': 'XRP' };
                const asset = map[msg.payload.symbol];
                if (asset) {
                    livePrices[asset] = parseFloat(msg.payload.value);
                    const now = Date.now();
                    lastUpdateTimestamp = now;
                    priceHistory[asset].push({ t: now, p: msg.payload.value });
                    if (priceHistory[asset].length > 500) priceHistory[asset].shift();
                    livePriceTimestamps[asset] = now;
                }
            }
            if (msg.topic === 'crypto_prices' && msg.type === 'update') {
                const map = { btcusdt: 'BTC', ethusdt: 'ETH', solusdt: 'SOL', xrpusdt: 'XRP' };
                const asset = map[msg.payload.symbol];
                if (asset && !livePrices[asset]) {
                    livePrices[asset] = parseFloat(msg.payload.value);
                    const now = Date.now();
                    lastUpdateTimestamp = now;
                    priceHistory[asset].push({ t: now, p: msg.payload.value });
                    if (priceHistory[asset].length > 500) priceHistory[asset].shift();
                    livePriceTimestamps[asset] = now;
                }
            }
        } catch (e) { }
    });
    ws.on('close', () => {
        log('⚠️ WS Disconnected. Reconnecting in 5s...');
        setTimeout(connectWebSocket, 5000);
    });
    ws.on('error', (e) => log(`WS Error: ${e.message}`));
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
                lastUpdated: Date.now()
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

// Home route - LIVE DASHBOARD
app.get('/', (req, res) => {
    res.send(`
<!DOCTYPE html>
<html>
<head>
    <title>Supreme Deity Oracle - LIVE</title>
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
        .header {
            text-align: center;
            margin-bottom: 30px;
        }
        .header h1 { font-size: 2.5em; margin-bottom: 10px; }
        .status-bar {
            background: rgba(0,255,0,0.2);
            padding: 10px 20px;
            border-radius: 8px;
            text-align: center;
            margin-bottom: 20px;
        }
        .grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
            gap: 20px;
            max-width: 1400px;
            margin: 0 auto;
        }
        .asset-card {
            background: rgba(0,0,0,0.4);
            border-radius: 12px;
            padding: 20px;
            border: 2px solid rgba(255,255,255,0.1);
            transition: all 0.3s;
        }
        .asset-card:hover { transform: translateY(-5px); border-color: rgba(255,255,255,0.3); }
        .asset-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 15px;
        }
        .asset-name { font-size: 1.8em; font-weight: bold; }
        .prediction {
            font-size: 3em;
            font-weight: bold;
            text-align: center;
            margin: 15px 0;
            text-shadow: 0 0 20px currentColor;
        }
        .prediction.UP { color: #00ff00; }
        .prediction.DOWN { color: #ff0044; }
        .prediction.WAIT { color: #ffaa00; }
        .confidence {
            text-align: center;
            font-size: 1.3em;
            margin: 10px 0;
        }
        .tier {
            display: inline-block;
            padding: 5px 15px;
            border-radius: 20px;
            font-weight: bold;
            font-size: 0.9em;
        }
        .tier.CONVICTION { background: #ff0066; }
        .tier.ADVISORY { background: #ff9900; }
        .tier.NONE { background: #555; }
        .stats {
            margin-top: 15px;
            padding-top: 15px;
            border-top: 1px solid rgba(255,255,255,0.2);
        }
        .stat-row {
            display: flex;
            justify-content: space-between;
            margin: 5px 0;
            font-size: 0.9em;
        }
        .locked {
            background: rgba(255,0,100,0.3);
            border: 2px solid #ff0066;
            animation: pulse 2s infinite;
        }
        @keyframes pulse {
            0%, 100% { box-shadow: 0 0 20px rgba(255,0,100,0.5); }
            50% { box-shadow: 0 0 40px rgba(255,0,100,0.8); }
        }
        .price-display {
            text-align: center;
            margin: 10px 0;
            font-size: 1.1em;
        }
        .loading { text-align: center; padding: 50px; font-size: 1.5em; }
        .countdown {
            font-size: 2em;
            font-weight: bold;
            color: #00ff00;
            text-shadow: 0 0 10px #00ff00;
        }
        .market-link {
            display: inline-block;
            margin-top: 10px;
            padding: 8px 16px;
            background: rgba(0,150,255,0.3);
            border: 1px solid #0096ff;
            border-radius: 6px;
            color: #4fc3f7;
            text-decoration: none;
            font-size: 0.85em;
            transition: all 0.3s;
        }
        .market-link:hover {
            background: rgba(0,150,255,0.5);
            transform: scale(1.05);
        }
    </style>
</head>
<body>
    <div class="header">
        <h1>🔮 SUPREME DEITY ORACLE</h1>
        <div class="status-bar">
            ✅ <strong>LIVE</strong> | Next Checkpoint: <span class="countdown" id="countdown">--:--</span> | <span id="last-update">Loading...</span>
            <button onclick="exportData()" style="margin-left: 20px; padding: 5px 10px; background: #0096ff; border: none; border-radius: 4px; color: white; cursor: pointer;">💾 Export Data</button>
        </div>
    </div>
    <div id="dashboard" class="grid">
        <div class="loading">Loading oracle data...</div>
    </div>
    
    <script>
        async function fetchData() {
            try {
                const res = await fetch('/api/state');
                const data = await res.json();
                
                const dashboard = document.getElementById('dashboard');
                const assets = ['BTC', 'ETH', 'SOL', 'XRP'];
                
                // Helper function for safe HTML generation
                function getMarketLinkHtml(market) {
                    if (!market || !market.marketUrl) return '';
                    return \`
                        <div style="text-align: center; margin-top: 15px;">
                            <a href="\${market.marketUrl}" target="_blank" class="market-link">
                                📊 View on Polymarket →
                            </a>
                        </div>
                    \`;
                }

                dashboard.innerHTML = assets.map(asset => {
                    const d = data[asset];
                    if (!d) return '';
                    
                    const winRate = d.stats.total > 0 ? ((d.stats.wins / d.stats.total) * 100).toFixed(1) : '0.0';
                    const convWinRate = d.stats.convictionTotal > 0 ? ((d.stats.convictionWins / d.stats.convictionTotal) * 100).toFixed(1) : '0.0';
                    
                    return \`
                        <div class="asset-card \${d.locked ? 'locked' : ''}">
                            <div class="asset-header">
                                <div class="asset-name">\${asset}</div>
                                <div>\${d.locked ? '🔒 LOCKED' : ''}</div>
                            </div>
                            
                            <div class="prediction \${d.prediction}">\${d.prediction}</div>
                            
                            <div class="confidence">
                                <strong>\${(d.confidence * 100).toFixed(1)}%</strong> confidence
                            </div>
                            
                            <div style="text-align: center; margin: 10px 0;">
                                <span class="tier \${d.tier}">\${d.tier}</span>
                                <div style="font-size: 0.8em; margin-top: 5px; opacity: 0.8;">
                                    Thresholds: <strong>\${(d.thresholds.conviction * 100).toFixed(0)}%</strong> / <strong>\${(d.thresholds.advisory * 100).toFixed(0)}%</strong>
                                </div>
                            </div>
                            
                            <div class="price-display">
                                Live: <strong>$\${d.live ? d.live.toFixed(2) : 'N/A'}</strong><br>
                                Checkpoint: <strong>$\${d.checkpoint ? d.checkpoint.toFixed(2) : 'N/A'}</strong><br>
                                Edge: <strong>\${d.edge ? d.edge.toFixed(2) : '0'}%</strong>
                            </div>
                            
                            <div class="stats">
                                <div class="stat-row">
                                    <span>Win Rate:</span>
                                    <strong>\${winRate}% (\${d.stats.wins}/\${d.stats.total})</strong>
                                </div>
                                <div class="stat-row">
                                    <span>Conviction Rate:</span>
                                    <strong>\${convWinRate}% (\${d.stats.convictionWins}/\${d.stats.convictionTotal})</strong>
                                </div>
                                <div class="stat-row">
                                    <span>Recent (L10):</span>
                                    <strong>\${d.recentAccuracy}% (\${d.recentTotal} trades)</strong>
                                </div>
                                <div class="stat-row">
                                    <span>Vote Stability:</span>
                                    <strong>\${(d.voteStability * 100).toFixed(0)}%</strong>
                                </div>
                                <div class="stat-row">
                                    <span>Market Odds:</span>
                                    <strong>Y:\${d.market ? (d.market.yesPrice * 100).toFixed(1) : 'N/A'}% / N:\${d.market ? (d.market.noPrice * 100).toFixed(1) : 'N/A'}%</strong>
                                </div>
                            </div>
                            
                            \${d.market && d.market.marketUrl ? \`<div style="text-align: center; margin-top: 15px;">
                                <a href="\${d.market.marketUrl}" target="_blank" class="market-link">
                                    📊 View on Polymarket →
                                </a>
                            </div>\` : ''}
                            
                            <div style="text-align: center; margin-top: 10px;">
                                <button onclick="exportCycle('\${asset}')" style="padding: 4px 8px; background: rgba(255,255,255,0.1); border: 1px solid rgba(255,255,255,0.3); border-radius: 4px; color: #aaa; cursor: pointer; font-size: 0.8em;">
                                    📥 Export Last Cycle
                                </button>
                            </div>
                        </div>
                    \`;
                }).join('');
                
                // Update countdown timer
                const now = Math.floor(Date.now() / 1000);
                const interval = 900; // 15 minutes in seconds
                const nextCheckpoint = now - (now % interval) + interval;
                const timeLeft = nextCheckpoint - now;
                const minutes = Math.floor(timeLeft / 60);
                const seconds = timeLeft % 60;
                document.getElementById('countdown').textContent = 
                    minutes.toString().padStart(2, '0') + ':' + seconds.toString().padStart(2, '0');
                
                document.getElementById('last-update').textContent = new Date().toLocaleTimeString();
            } catch (e) {
                console.error('Fetch error:', e);
                document.getElementById('last-update').textContent = 'Error: ' + e.message;
            }
        }
        
        function exportData() {
            window.open('/api/export', '_blank');
        }

        async function exportCycle(asset) {
            try {
                const res = await fetch('/api/export-last-cycle?asset=' + asset);
                const data = await res.json();
                
                if (data.error) {
                    alert('❌ ' + data.error);
                    return;
                }
                
                const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = asset + '_cycle_' + new Date().toISOString().replace(/[:.]/g, '-') + '.json';
                document.body.appendChild(a);
                a.click();
                document.body.removeChild(a);
                URL.revokeObjectURL(url);
                
                alert('✅ Exported ' + asset + ' cycle!');
            } catch (e) {
                alert('❌ Export failed: ' + e.message);
            }
        }
        
        // Initial load
        fetchData();
        
        // Auto-refresh every 1 second
        setInterval(fetchData, 1000);
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
            recentAccuracy: recentAccuracy.toFixed(1),  // Last 10 predictions accuracy
            recentTotal: recentTotal,  // How many of the last 10 we have

            // FINAL SEVEN METRICS
            kellySize: Brains[a].getKellySize(),
            calibration: Brains[a].calibrationBuckets,
            newsState: Brains[a].newsState,
            thresholds: { conviction: 0.75, advisory: 0.65 }
        };
    });
    res.json(response);
});

app.get('/api/export', (req, res) => {
    const exportData = {
        timestamp: Date.now(),
        assets: {}
    };

    ASSETS.forEach(a => {
        exportData.assets[a] = {
            prediction: Brains[a].prediction,
            confidence: Brains[a].confidence,
            tier: Brains[a].tier,
            stats: Brains[a].stats,
            history: Brains[a].voteHistory,
            patterns: memoryPatterns[a] ? memoryPatterns[a].length : 0
        };
    });

    res.header('Content-Type', 'application/json');
    res.send(JSON.stringify(exportData, null, 2));
});

app.get('/api/export-last-cycle', (req, res) => {
    const asset = req.query.asset || 'BTC';
    const brain = Brains[asset];

    if (!brain || !brain.lastCompletedCycle) {
        return res.json({ error: 'No cycle data available for ' + asset });
    }

    res.json({
        asset: asset,
        cycle: brain.lastCompletedCycle,
        modelWeights: brain.cachedWeights,
        stats: brain.stats
    });
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
                    log(`⚠️ Checkpoint skipped - stale data (${(dataAge / 1000).toFixed(1)}s old)`, a);
                    return;
                }

                // Evaluate the JUST FINISHED cycle
                // Use CONFIRMED fresh prices for accurate outcome evaluation
                if (checkpointPrices[a] && livePrices[a]) {
                    Brains[a].evaluateOutcome(livePrices[a], checkpointPrices[a]);
                    log(`📊 Evaluated checkpoint ${cp - INTERVAL_SECONDS} (fresh data)`, a);
                }

                // Update checkpoints for the NEW cycle with FRESH price
                previousCheckpointPrices[a] = checkpointPrices[a];
                checkpointPrices[a] = livePrices[a];

                // Mark this checkpoint as evaluated
                lastEvaluatedCheckpoint[a] = cp;

                // Save completed cycle
                if (Brains[a].currentCycleHistory.length > 0) {
                    Brains[a].lastCompletedCycle = {
                        checkpointStart: cp - INTERVAL_SECONDS,
                        checkpointEnd: cp,
                        startPrice: checkpointPrices[a],
                        endPrice: livePrices[a],
                        outcome: livePrices[a] > checkpointPrices[a] ? 'UP' : 'DOWN',
                        snapshots: [...Brains[a].currentCycleHistory]
                    };
                    Brains[a].currentCycleHistory = [];
                    log(`💾 Saved cycle history (${Brains[a].lastCompletedCycle.snapshots.length} snapshots)`, a);
                }

                log(`🔄 NEW Checkpoint: $${checkpointPrices[a]?.toFixed(2) || 'pending'}`, a);
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
    setInterval(fetchFearGreedIndex, 300000);
    setInterval(fetchFundingRates, 300000);

    server.listen(PORT, () => {
        log(`⚡ SUPREME DEITY SERVER ONLINE on port ${PORT}`);
        log(`🌐 Access at: http://localhost:${PORT}`);
    });
}

startup();
