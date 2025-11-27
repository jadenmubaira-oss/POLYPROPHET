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
            timestamp: Date.now()
        };

        // Save to memory first
        memoryPatterns[asset].push(pattern);
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
            if (dist < minDistance) {
                minDistance = dist;
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

        this.pendingSignal = null;
        this.stabilityCounter = 0;
        this.lagCounter = 0;
        this.isProcessing = false;

        this.priceKalman = new KalmanFilter(0.0001, 0.001);
        this.derivKalman = new KalmanFilter(0.0001, 0.001);
    }

    async update() {
        if (this.isProcessing) return;
        this.isProcessing = true;
        try {
            const currentPrice = livePrices[this.asset];
            const startPrice = checkpointPrices[this.asset];
            const history = priceHistory[this.asset];
            const elapsed = INTERVAL_SECONDS - (getNextCheckpoint() - Math.floor(Date.now() / 1000));

            if (!currentPrice || !startPrice || history.length < 10) return;

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

            if (this.lockState === 'NEUTRAL') {
                if (absForce > atr * this.atrMultiplier) {
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
                votes[this.lockState] += (elapsed < 180 ? 2 : 1);
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
                votes[physSignal] += 1;
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
                    votes[bookSignal] += 1;
                    totalConfidence += conf;
                }
            }

            // MODEL 4: HISTORIAN (NOW FULLY ENABLED WITH FILE STORAGE)
            if (history.length >= 10) {
                const recent = history.slice(-10).map(x => x.p);
                const base = recent[0];
                const vector = recent.map(p => (p - base) / base);

                const match = await findSimilarPattern(this.asset, vector);
                if (match) {
                    votes[match.outcome] += 1;
                    totalConfidence += 0.85;
                }
            }

            // MODEL 5: CORRELATION
            if (this.asset !== 'BTC' && livePrices['BTC'] && checkpointPrices['BTC']) {
                const btcForce = livePrices['BTC'] - checkpointPrices['BTC'];
                const btcDirection = btcForce > 0 ? 'UP' : 'DOWN';
                const btcStrength = Math.abs(btcForce) / (MathLib.calculateATR(priceHistory['BTC'], 20) || 1);
                if (btcStrength > 1.5) {
                    votes[btcDirection] += 0.5;
                    totalConfidence += 0.6;
                }
            }

            // MODEL 6: MACRO
            if (fearGreedIndex < 25) { votes.UP += 0.6; totalConfidence += 0.65; }
            else if (fearGreedIndex > 75) { votes.DOWN += 0.6; totalConfidence += 0.65; }

            // MODEL 7: FUNDING
            const funding = fundingRates[this.asset];
            if (funding && funding.timestamp > Date.now() - 600000) {
                if (funding.rate > 0.0001) { votes.DOWN += 0.5; totalConfidence += 0.7; }
                else if (funding.rate < -0.0001) { votes.UP += 0.5; totalConfidence += 0.7; }
            }

            // MODEL 8: VOLUME
            const vol = currentMarkets[this.asset]?.volume || 0;
            if (vol > 0 && history.length > 5) {
                const priceChange = (currentPrice - history[history.length - 5].p) / history[history.length - 5].p;
                const volSignal = priceChange > 0 ? 'UP' : 'DOWN';
                if (Math.abs(priceChange) < 0.001 && vol > 100000) {
                    votes[volSignal] += 0.5; totalConfidence += 0.6;
                } else {
                    votes[volSignal] += 0.7; totalConfidence += 0.65;
                }
            }

            // WATCHGUARDS
            const lag = Date.now() - (currentMarkets[this.asset]?.lastUpdated || 0);
            this.lagCounter = lag > 15000 ? this.lagCounter + 1 : 0;
            const isLagging = this.lagCounter >= 3;
            const isPanic = MathLib.isPanic(history);
            const isSpoofing = MathLib.isSpoofing(history);

            if (isLagging || isPanic || isSpoofing) {
                votes.UP = 0; votes.DOWN = 0; totalConfidence = 0;
            }

            // DECISION
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

            // FORCED PREDICTION
            if (elapsed >= 180 && finalSignal === 'NEUTRAL') {
                if (force > 0) { finalSignal = 'UP'; finalConfidence = 0.6 + (absForce / (atr * 3)); }
                else { finalSignal = 'DOWN'; finalConfidence = 0.6 + (absForce / (atr * 3)); }
                finalConfidence = Math.min(0.75, finalConfidence);
            }

            // THRESHOLD
            let tier = 'NONE';
            let effectiveThreshold = 0.95;
            if (this.stats.total < 24) effectiveThreshold = 0.80;
            if (this.winStreak > 3) effectiveThreshold = 0.90;
            if (this.lossStreak > 1) effectiveThreshold = 0.98;

            if (this.stats.total > 10) {
                const winRate = this.stats.wins / this.stats.total;
                if (winRate < 0.5) finalConfidence *= 0.9;
            }
            if (trendBias) finalConfidence *= trendBias;

            if (finalConfidence >= effectiveThreshold) tier = 'CONVICTION';
            else if (finalConfidence >= 0.70) tier = 'ADVISORY';

            // DEBOUNCE
            if (finalSignal !== this.prediction) {
                if (finalSignal === this.pendingSignal) this.stabilityCounter++;
                else { this.pendingSignal = finalSignal; this.stabilityCounter = 0; }

                const requiredStability = (elapsed >= 180) ? 0 : (this.stats.total < 24 ? 1 : 3);

                if (this.stabilityCounter >= requiredStability) {
                    this.prediction = finalSignal;
                    this.confidence = finalConfidence;
                    this.tier = tier;
                    this.lastSignal = { type: finalSignal, conf: finalConfidence, tier, time: Date.now() };
                    this.stabilityCounter = 0;
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

            // EDGE
            if (currentMarkets[this.asset] && this.prediction !== 'WAIT') {
                const market = currentMarkets[this.asset];
                const marketProb = this.prediction === 'UP' ? market.yesPrice : market.noPrice;
                this.edge = (this.confidence - marketProb) * 100;
            } else {
                this.edge = 0;
            }

        } finally {
            this.isProcessing = false;
        }
    }

    evaluateOutcome(finalPrice, startPrice) {
        if (!startPrice) return;

        const actual = finalPrice > startPrice ? 'UP' : 'DOWN';
        const predicted = this.lastSignal ? this.lastSignal.type : 'NEUTRAL';
        const tier = this.lastSignal ? this.lastSignal.tier : 'NONE';

        if (predicted !== 'NEUTRAL') {
            this.stats.total++;
            if (predicted === actual) {
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
            currentMarkets[asset] = null;
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
        }), {})
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
app.get('/api/state', (req, res) => {
    const response = {};
    ASSETS.forEach(a => {
        response[a] = {
            prediction: Brains[a].prediction,
            confidence: Brains[a].confidence,
            tier: Brains[a].tier,
            edge: Brains[a].edge,
            votes: Brains[a].ensembleVotes,
            stats: Brains[a].stats,
            live: livePrices[a],
            checkpoint: checkpointPrices[a],
            market: currentMarkets[a]
        };
    });
    res.json(response);
});

// ==================== CHECKPOINT LOGIC ====================
setInterval(() => {
    const now = Math.floor(Date.now() / 1000);
    const cp = now - (now % INTERVAL_SECONDS);

    ASSETS.forEach(a => {
        // Only process within the 5-second checkpoint window
        if (now >= cp && now < cp + 5) {
            // CRITICAL FIX: Only evaluate if we haven't already evaluated this checkpoint
            if (lastEvaluatedCheckpoint[a] !== cp) {

                // Evaluate the JUST FINISHED cycle (Live vs Checkpoint)
                // checkpointPrices[a] = Start of the cycle that just ended
                // livePrices[a] = End of the cycle that just ended
                if (checkpointPrices[a] && livePrices[a]) {
                    Brains[a].evaluateOutcome(livePrices[a], checkpointPrices[a]);
                    log(`📊 Evaluated checkpoint ${cp - INTERVAL_SECONDS}`, a);
                }

                // Update checkpoints for the NEW cycle
                previousCheckpointPrices[a] = checkpointPrices[a];
                checkpointPrices[a] = livePrices[a];

                // Mark this checkpoint as evaluated
                lastEvaluatedCheckpoint[a] = cp;

                log(`🔄 Checkpoint: ${checkpointPrices[a]?.toFixed(2) || 'pending'}`, a);
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
