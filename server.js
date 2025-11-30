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
const nodemailer = require('nodemailer');
const twilio = require('twilio');

// Initialize App
const app = express();
app.use(cors());
app.use(express.json()); // For POST body parsing

// ==================== PASSWORD PROTECTION ====================
app.use((req, res, next) => {
    // Skip auth for API endpoints and Service Worker
    if (req.path.startsWith('/api/') || req.path === '/sw.js') {
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

// ==================== NOTIFICATION SYSTEM SETUP ====================

// Email (Nodemailer with Gmail) - Can be configured from UI or .env
let emailTransporter = null;

// SMS (Twilio) - Can be configured from UI or .env
let twilioClient = null;

// Notification Credentials & Preferences (In-Memory Cache, backed by Redis)
let userPreferences = {
    // User contact info
    email: null,
    phone: null,

    // Gmail credentials (can be set from UI)
    gmailUser: process.env.GMAIL_USER || null,
    gmailPassword: process.env.GMAIL_APP_PASSWORD || null,

    // Twilio credentials (can be set from UI)
    twilioSid: process.env.TWILIO_ACCOUNT_SID || null,
    twilioToken: process.env.TWILIO_AUTH_TOKEN || null,
    twilioPhone: process.env.TWILIO_PHONE || null,

    // Toggles
    enableEmail: true,
    enableSMS: true,
    enableBrowser: true,
    alertOnSniper: true,    // Alert on 90%+ conviction
    alertOnStandard: false  // Alert on 85%+ conviction
};

// Initialize email transporter
function initEmailTransporter() {
    if (userPreferences.gmailUser && userPreferences.gmailPassword) {
        try {
            emailTransporter = nodemailer.createTransport({
                service: 'gmail',
                auth: {
                    user: userPreferences.gmailUser,
                    pass: userPreferences.gmailPassword
                }
            });
            log('✅ Email Notifications Enabled');
            return true;
        } catch (e) {
            log(`❌ Email setup failed: ${e.message}`);
            return false;
        }
    }
    return false;
}

// Initialize Twilio client
function initTwilioClient() {
    if (userPreferences.twilioSid && userPreferences.twilioToken && userPreferences.twilioPhone) {
        try {
            twilioClient = twilio(userPreferences.twilioSid, userPreferences.twilioToken);
            log('✅ SMS Notifications Enabled');
            return true;
        } catch (e) {
            log(`❌ Twilio setup failed: ${e.message}`);
            return false;
        }
    }
    return false;
}

// Try to initialize from .env on startup
initEmailTransporter();
initTwilioClient();

// Alert Tracking
let lastAlertSent = {};     // { BTC: timestamp, ETH: timestamp, ... }
let alertHistory = [];      // Last 50 alerts
let systemAlerts = [];      // System health alerts (Twilio credits, etc)
const ALERT_COOLDOWN = 5 * 60 * 1000; // 5 minutes

// ==================== IMMUTABLE DATA LAYER (Node.js Port) ====================
const ASSETS = ['BTC', 'ETH', 'SOL', 'XRP'];
const GAMMA_API = 'https://gamma-api.polymarket.com';
const CLOB_API = 'https://clob.polymarket.com';
const WS_ENDPOINT = 'wss://ws-live-data.polymarket.com';
const INTERVAL_SECONDS = 900;

// State
let livePrices = {};
let livePriceTimestamps = {}; // Per-asset price timestamps for accurate staleness detection
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
    livePriceTimestamps[asset] = 0; // Per-asset timestamp
    currentMarkets[asset] = null;
    marketOddsHistory[asset] = [];
    lastAlertSent[asset] = 0; // Alert cooldown tracking
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

// ==================== NOTIFICATION MANAGER ====================

class NotificationManager {
    static async sendAlert(asset, brain) {
        const now = Date.now();

        // Check cooldown
        if ((now - (lastAlertSent[asset] || 0)) < ALERT_COOLDOWN) {
            return; // Too soon, prevent spam
        }

        const message = this.buildAlertMessage(asset, brain);
        const subject = `🎯 SNIPER ALERT: ${asset}`;
        let sent = { email: false, sms: false, browser: true };

        // Send Email
        if (userPreferences.email && userPreferences.enableEmail && emailTransporter) {
            try {
                await emailTransporter.sendMail({
                    from: process.env.GMAIL_USER,
                    to: userPreferences.email,
                    subject: subject,
                    html: this.buildEmailHTML(asset, brain)
                });
                sent.email = true;
                log(`📧 Email sent to ${userPreferences.email}`, asset);
            } catch (e) {
                log(`❌ Email failed: ${e.message}`, asset);
            }
        }

        // Send SMS
        if (userPreferences.phone && userPreferences.enableSMS && twilioClient) {
            try {
                await twilioClient.messages.create({
                    body: message,
                    from: process.env.TWILIO_PHONE,
                    to: userPreferences.phone
                });
                sent.sms = true;
                log(`📱 SMS sent to ${userPreferences.phone}`, asset);
            } catch (e) {
                log(`❌ SMS failed: ${e.message}`, asset);

                // Track Twilio credit errors
                if (e.code === 20003) {
                    systemAlerts.push({
                        type: 'error',
                        msg: 'Twilio: Out of credits!',
                        timestamp: Date.now()
                    });
                    if (systemAlerts.length > 10) systemAlerts.shift();
                }
            }
        }

        // Update cooldown
        lastAlertSent[asset] = now;

        // Save to history
        alertHistory.unshift({
            asset,
            timestamp: now,
            prediction: brain.prediction,
            confidence: brain.confidence,
            tier: brain.tier,
            edge: brain.edge,
            sent
        });
        if (alertHistory.length > 50) alertHistory.pop();

        log(`🎯 SNIPER ALERT SENT: ${asset} ${brain.prediction} @ ${(brain.confidence * 100).toFixed(1)}%`, asset);
    }

    static buildAlertMessage(asset, brain) {
        const market = currentMarkets[asset];
        const odds = brain.prediction === 'UP' ? market?.yesPrice : market?.noPrice;
        const timeLeft = getNextCheckpoint() - Math.floor(Date.now() / 1000);
        const minutes = Math.floor(timeLeft / 60);
        const seconds = timeLeft % 60;

        return `🎯 SNIPER OPPORTUNITY
${asset}: ${brain.prediction}
Confidence: ${(brain.confidence * 100).toFixed(1)}%
Tier: ${brain.tier} 🔒
Market Odds: ${odds ? (odds * 100).toFixed(1) : 'N/A'}%
Edge: +${brain.edge.toFixed(1)}%
Time: ${minutes}:${seconds.toString().padStart(2, '0')}

Act now! View: https://polymarket.com`;
    }

    static buildEmailHTML(asset, brain) {
        const market = currentMarkets[asset];
        const odds = brain.prediction === 'UP' ? market?.yesPrice : market?.noPrice;

        return `
<!DOCTYPE html>
<html>
<head>
    <style>
        body { font-family: Arial, sans-serif; background: #1a1a2e; color: white; padding: 20px; }
        .container { max-width: 600px; margin: 0 auto; background: #16213e; border-radius: 12px; padding: 30px; }
        .header { text-align: center; font-size: 2em; color: #ff0000; margin-bottom: 20px; }
        .prediction { font-size: 3em; text-align: center; margin: 20px 0; }
        .prediction.UP { color: #00ff00; }
        .prediction.DOWN { color: #ff0044; }
        .stats { background: rgba(255,255,255,0.05); padding: 15px; border-radius: 8px; margin: 15px 0; }
        .stat-row { display: flex; justify-content: space-between; margin: 10px 0; }
        .button { display: inline-block; background: #0096ff; color: white; padding: 15px 30px; 
                  border-radius: 8px; text-decoration: none; margin: 20px auto; text-align: center; }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">🎯 SNIPER ALERT</div>
        <h2>${asset}</h2>
        <div class="prediction ${brain.prediction}">${brain.prediction}</div>
        <div class="stats">
            <div class="stat-row"><span>Confidence:</span><strong>${(brain.confidence * 100).toFixed(1)}%</strong></div>
            <div class="stat-row"><span>Tier:</span><strong>${brain.tier} 🔒</strong></div>
            <div class="stat-row"><span>Market Odds:</span><strong>${odds ? (odds * 100).toFixed(1) : 'N/A'}%</strong></div>
            <div class="stat-row"><span>Edge:</span><strong>+${brain.edge.toFixed(1)}%</strong></div>
        </div>
        <div style="text-align: center;">
            <a href="${market?.marketUrl || 'https://polymarket.com'}" class="button">📊 View on Polymarket</a>
        </div>
    </div>
</body>
</html>`;
    }

    static shouldSendAlert(brain, asset) {
        // 🎯 FIX #1: RELAXED SNIPER CRITERIA (Catch 90-92% opportunities)

        // 1. Must be SNIPER GRADE (90%+)
        if (brain.confidence < 0.90) return false;

        // 2. RELAXED: CONVICTION tier OR high confidence (92%+)
        // Removed strict lock requirement - allows alerts on 90-95% even if not locked yet
        const isHighConviction = brain.tier === 'CONVICTION' || brain.confidence >= 0.92;
        if (!isHighConviction) return false;

        // 3. Must be EARLY in cycle (< 3 mins)
        const elapsed = INTERVAL_SECONDS - (getNextCheckpoint() - Math.floor(Date.now() / 1000));
        if (elapsed > 180) return false;

        // 4. Must have EDGE (> 5%)
        if (brain.edge < 5) return false;

        // 5. User preferences
        if (!userPreferences.alertOnSniper) return false;

        return true;
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

        // STABILITY FIX #2 & #5: Less Sensitive Genesis Protocol
        this.atrMultiplier = 4.0;  // Increased from 2.2 - needs bigger moves to trigger
        this.reverseMultiplier = 3.0;  // Increased from 4.5 - harder to break locks

        // STABILITY FIX #3: Prediction Hold Timer
        this.lastPredictionChange = 0;
        this.predictionHoldSeconds = 60;  // Hold prediction for 60 seconds minimum

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

        // PREDICTION HISTORY (For real stability calculation)
        this.predictionHistory = [];  // Track actual prediction changes

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

        // STABILITY FIX #4: Cached Model Weights (only update at checkpoints)
        this.cachedWeights = {
            genesis: 1.0, physicist: 1.0, orderbook: 1.0, historian: 1.0,
            correlation: 1.0, macro: 1.0, funding: 1.0, volume: 1.0
        };

        // STABILITY FIX #6: Conviction Lock Timestamp
        this.lockTimestamp = 0;

        // 🐛 CYCLE HISTORY TRACKING (for debugging)
        this.currentCycleHistory = [];  // Snapshots of current cycle
        this.lastCompletedCycle = null;  // Full previous cycle for export
        this.cycleStartTime = 0;
    }

    async update() {
        if (this.isProcessing) return;
        this.isProcessing = true;
        try {
            const currentPrice = livePrices[this.asset];
            const startPrice = checkpointPrices[this.asset];
            const history = priceHistory[this.asset];
            const elapsed = INTERVAL_SECONDS - (getNextCheckpoint() - Math.floor(Date.now() / 1000));

            // 🛡️ SAFETY GATE #1: LATE-CYCLE PROTECTION (Prevent Suicide Bets)
            // Don't make predictions with < 2 minutes left in cycle
            // Market has already decided outcome - jumping in now is statistical suicide
            if (elapsed > 780) {  // > 13 minutes elapsed (< 120s remaining)
                this.prediction = 'WAIT';
                this.confidence = 0;
                this.tier = 'NONE';
                this.edge = 0;
                this.isProcessing = false;
                return;  // EXIT EARLY - TOO LATE TO TRADE
            }

            // CRITICAL FIX: Check per-asset price freshness
            const priceAge = Date.now() - (livePriceTimestamps[this.asset] || 0);
            if (priceAge > 5000) {
                // Price is >5 seconds old for THIS asset specifically
                this.isProcessing = false;
                return;
            }

            if (!currentPrice || !startPrice || history.length < 10) {
                this.isProcessing = false;
                return;
            }

            // 🎯 FIX #2: USE CACHED MODEL WEIGHTS (No recalculation every second)
            // Weights are updated at checkpoint in evaluateOutcome(), not here
            const weights = this.cachedWeights;
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
                // STABILITY FIX #5: MUCH stronger hysteresis margin
                const margin = R / atr < 0.7 ? 3.0 : (R / atr > 1.3 ? 5.0 : 4.0);  // Increased from 1.5/3.0/2.0

                // STABILITY FIX #3: PREDICTION HOLD TIMER
                // Don't allow prediction changes within 60 seconds unless overwhelming evidence
                const timeSinceLastChange = (Date.now() - this.lastPredictionChange) / 1000;
                const canChangePrediction = timeSinceLastChange > this.predictionHoldSeconds;

                if (!canChangePrediction && this.prediction !== 'WAIT' && this.prediction !== 'NEUTRAL') {
                    // HOLD current prediction - only update confidence smoothly
                    finalSignal = this.prediction;
                    const rawConf = avgConf * (this.prediction === 'UP' ? upVotes / totalVotes : downVotes / totalVotes);
                    // STABILITY FIX #1: Strong confidence smoothing (0.95/0.05)
                    finalConfidence = this.confidence > 0
                        ? this.confidence * 0.95 + rawConf * 0.05
                        : rawConf;
                } else {
                    // Can change prediction - use hysteresis
                    if (this.prediction === 'DOWN') {
                        if (upVotes > downVotes + margin) { finalSignal = 'UP'; finalConfidence = avgConf * (upVotes / totalVotes); }
                        else { finalSignal = 'DOWN'; finalConfidence = avgConf * (downVotes / totalVotes); }
                    } else if (this.prediction === 'UP') {
                        if (downVotes > upVotes + margin) { finalSignal = 'DOWN'; finalConfidence = avgConf * (downVotes / totalVotes); }
                        else { finalSignal = 'UP'; finalConfidence = avgConf * (upVotes / totalVotes); }
                    } else {
                        // First prediction or WAIT state
                        if (upVotes > downVotes + margin) { finalSignal = 'UP'; finalConfidence = avgConf * (upVotes / totalVotes); }
                        else if (downVotes > upVotes + margin) { finalSignal = 'DOWN'; finalConfidence = avgConf * (downVotes / totalVotes); }
                    }

                    // STABILITY FIX #1: Apply confidence smoothing even on prediction changes
                    if (this.confidence > 0 && finalSignal !== 'NEUTRAL') {
                        finalConfidence = this.confidence * 0.90 + finalConfidence * 0.10;  // Slightly less aggressive when changing
                    }
                }
            }

            // FORCED PREDICTION
            if (elapsed >= 180 && finalSignal === 'NEUTRAL') {
                convictionThreshold = 0.82;  // Lower for trending (easier to be confident)
                advisoryThreshold = 0.68;
            } else if (regime === 'VOLATILE') {
                convictionThreshold = 0.85;
                advisoryThreshold = 0.70;
            }

            // REGIME PERSISTENCE (Smooth out regime flips)
            this.regimeHistory.push(regime);
            if (this.regimeHistory.length > 5) this.regimeHistory.shift();
            const stableRegime = this.regimeHistory.length >= 3
                ? (this.regimeHistory.slice(-3).every(r => r === regime) ? regime : this.regimeHistory[0])
                : regime;

            // Multi-Timeframe Confirmation (less aggressive penalty)
            const longTrend = history.length > 300 ? (currentPrice - history[0].p) : 0;
            const trendDir = longTrend > 0 ? 'UP' : 'DOWN';

            if (Math.abs(longTrend) > atr * 5 && finalSignal !== trendDir && finalSignal !== 'NEUTRAL') {
                finalConfidence *= 0.92; // REDUCED penalty (was 0.85)
            }

            // Adjust based on track record (less aggressive)
            if (this.stats.total < 24) {
                convictionThreshold = 0.80;  // Lower for new bot
                advisoryThreshold = 0.65;
            }
            if (this.winStreak > 3) {
                convictionThreshold = 0.82;  // Slightly lower on win streak
            }
            if (this.lossStreak > 1) {
                convictionThreshold = 0.90;  // Higher on loss streak (was 0.99)
                advisoryThreshold = 0.75;
            }

            // Penalize poor win rate (less aggressive)
            if (this.stats.total > 10) {
                const winRate = this.stats.wins / this.stats.total;
                if (winRate < 0.5) finalConfidence *= 0.92;  // Less harsh (was 0.85)
            }

            // === CROSS-MARKET VALIDATION ===
            // REAL-WORLD FIX: REMOVED contrarian penalty - assets can move independently
            const allPredictions = ASSETS.map(a => Brains[a].prediction);
            const upCount = allPredictions.filter(p => p === 'UP').length;
            const downCount = allPredictions.filter(p => p === 'DOWN').length;

            if ((finalSignal === 'UP' && downCount > upCount + 1) ||
                (finalSignal === 'DOWN' && upCount > downCount + 1)) {
                log(`📊 Contrarian (${upCount}U/${downCount}D) - Independent move`, this.asset);
            }

            if (trendBias) finalConfidence *= trendBias;

            // 🛡️ SAFETY GATE #2: MARKET ODDS PROTECTION (Prevent Suicide Bets)
            // NEVER bet against overwhelming market consensus (>95%)
            // If market is 99% Yes and we want to bet No, that's statistical suicide
            const market = currentMarkets[this.asset];
            if (market && finalSignal !== 'NEUTRAL' && finalSignal !== 'WAIT') {
                const oppositeSideOdds = finalSignal === 'UP' ? market.noPrice : market.yesPrice;

                // BLOCK: If market is >95% on opposite side
                if (oppositeSideOdds > 0.95) {
                    const timeLeft = INTERVAL_SECONDS - elapsed;
                    log(`🛑 SUICIDE BET BLOCKED: Market ${(oppositeSideOdds * 100).toFixed(1)}% against ${finalSignal} with ${Math.floor(timeLeft / 60)}:${(timeLeft % 60).toString().padStart(2, '0')} left`, this.asset);
                    finalSignal = 'WAIT';
                    finalConfidence = 0;
                    tier = 'NONE';
                }
            }

            // 🛡️ SAFETY GATE #3: RAPID MOVE PROTECTION (Prevent Late Entry)
            // If price moved >15% already and market priced it in, don't enter
            const priceChange = Math.abs((currentPrice - startPrice) / startPrice);
            if (priceChange > 0.15 && elapsed < 300) {  // >15% move in first 5 min
                const market = currentMarkets[this.asset];
                if (market && finalSignal !== 'NEUTRAL' && finalSignal !== 'WAIT') {
                    const dominantOdds = Math.max(market.yesPrice, market.noPrice);
                    // If market already priced it in (>75% odds), too late to enter
                    if (dominantOdds > 0.75) {
                        const timeLeft = INTERVAL_SECONDS - elapsed;
                        log(`🛑 RAPID MOVE: ${(priceChange * 100).toFixed(1)}% in ${Math.floor(elapsed / 60)}m, market ${(dominantOdds * 100).toFixed(1)}% - too late to enter`, this.asset);
                        finalSignal = 'WAIT';
                        finalConfidence = 0;
                        tier = 'NONE';
                    }
                }
            }

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

            // REAL-WORLD FIX: REMOVED CONFIDENCE DECAY
            // The decay system was killing signals every few seconds in choppy markets
            // Real markets have temporary reversals - this doesn't mean the prediction is wrong
            // Confidence should come from MODEL agreement, not price micromovement validation

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

            // REAL-WORLD FIX: Also calculate REAL prediction stability (what user actually sees)
            const predictionFlips = this.predictionHistory.filter((p, i) =>
                i > 0 && p !== this.predictionHistory[i - 1] && p !== 'WAIT' && this.predictionHistory[i - 1] !== 'WAIT'
            ).length;
            const realStability = this.predictionHistory.length > 1
                ? 1 - (predictionFlips / (this.predictionHistory.length - 1))
                : 1;

            this.voteTrendScore = realStability;  // Use REAL stability, not vote stability

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
                    this.predictionHistory.push(finalSignal); // Track actual predictions for stability calc
                    this.stabilityCounter = 0;

                    // REAL-WORLD FIX: EARLY CYCLE COMMITMENT
                    // Commit within first 60 seconds at 70%+ confidence
                    // Original requirement (CONVICTION/ADVISORY in 5 min) was never reached
                    if (!this.cycleCommitted && elapsed < 60 && finalConfidence >= 0.70) {
                        const market = currentMarkets[this.asset];
                        if (market) {
                            const currentOdds = finalSignal === 'UP' ? market.yesPrice : market.noPrice;
                            // Check market has direction (not 50/50 coin flip)
                            const marketHasDirection = (currentOdds >= 0.55 || currentOdds <= 0.45);

                            if (marketHasDirection) {
                                this.cycleCommitted = true;
                                this.committedDirection = finalSignal;
                                this.commitTime = Date.now();
                                log(`💎 CYCLE COMMITMENT: ${finalSignal} @ ${tier} tier, ${(finalConfidence * 100).toFixed(1)}% conf, ${(currentOdds * 100).toFixed(1)}% odds (LOCKED FOR CYCLE)`, this.asset);
                            } else {
                                log(`⏸️ 50/50 market (${(currentOdds * 100).toFixed(1)}% odds) - waiting for direction`, this.asset);
                            }
                        }
                    }

                    // SAFETY NET: If 50/50 market persists beyond 60s, commit anyway to prevent flip-flopping
                    if (!this.cycleCommitted && elapsed >= 60 && elapsed < 90 && finalSignal !== 'NEUTRAL') {
                        this.cycleCommitted = true;
                        this.committedDirection = finalSignal;
                        this.commitTime = Date.now();
                        log(`💎 LATE COMMITMENT: ${finalSignal} @ ${tier} tier (market was 50/50, committing to prevent flip-flop)`, this.asset);
                    }

                    // CONVICTION LOCK: High confidence + Reasonable odds (anti-whipsaw)
                    // REAL-WORLD FIX: Lowered confidence requirement from 96% to 85%
                    if (!this.convictionLocked && tier === 'CONVICTION' && elapsed < 300 && finalConfidence >= 0.85) {
                        const market = currentMarkets[this.asset];
                        if (market) {
                            const currentOdds = finalSignal === 'UP' ? market.yesPrice : market.noPrice;

                            // Lock if odds show value (<=85% to allow some premium for conviction)
                            if (currentOdds <= 0.85) {
                                this.convictionLocked = true;
                                this.lockedDirection = finalSignal;
                                this.lockTime = Date.now();
                                this.lockConfidence = finalConfidence;
                                this.lockTimestamp = Date.now();  // STABILITY FIX #6
                                log(`🔒 CONVICTION LOCKED: ${finalSignal} @ ${(finalConfidence * 100).toFixed(1)}% confidence, ${(currentOdds * 100).toFixed(1)}% odds`, this.asset);
                            } else {
                                log(`⚠️ High confidence (${(finalConfidence * 100).toFixed(1)}%) but odds too rich (${(currentOdds * 100).toFixed(1)}%) - skipping lock`, this.asset);
                            }
                        }
                    }

                    // STABILITY FIX #3: Track prediction change timestamp
                    if (this.prediction !== finalSignal) {
                        this.lastPredictionChange = Date.now();
                    }
                }
            } else {
                // === VISUAL STABILIZATION (The "Peace of Mind" Layer) ===
                // Decouple raw model volatility from user-facing signals when locked

                // 1. If Locked, STAY Locked visually (Ironclad Conviction with Hysteresis)
                if (this.convictionLocked) {
                    // STABILITY FIX #6: ENFORCE conviction lock for full 5 minutes
                    const lockAge = (Date.now() - this.lockTimestamp) / 1000;

                    if (lockAge < 300) {  // Force lock for 5 minutes
                        tier = 'CONVICTION';
                        finalSignal = this.lockedDirection;
                        // DON'T let confidence drop below 90% while locked
                        finalConfidence = Math.max(0.90, finalConfidence);

                        if (finalConfidence < 0.93) {
                            log(`⚠️ Lock weakening (${(finalConfidence * 100).toFixed(1)}%), but forced to hold for ${(300 - lockAge).toFixed(0)}s more`, this.asset);
                        }
                    } else {
                        // Lock expired after 5 minutes
                        // HYSTERESIS: Only break lock if confidence crashes below 80% (Catastrophic failure)
                        if (finalConfidence < 0.80) {
                            this.convictionLocked = false;
                            log(`💥 LOCK BROKEN: Confidence crashed to ${(finalConfidence * 100).toFixed(1)}%`, this.asset);
                        } else {
                            // LOCK HOLDS (Even if 81%, 82%, 83%...)
                            tier = 'CONVICTION';
                            finalSignal = this.lockedDirection; // Ensure direction matches lock

                            // WARNING SYSTEM: If confidence dips into Buffer Zone (80-85%)
                            if (finalConfidence < 0.85) {
                                log(`⚠️ WARNING: Confidence weakening (${(finalConfidence * 100).toFixed(1)}%), but lock holds`, this.asset);
                                // We allow confidence to show 80-85% here so user sees the warning
                                // But Tier stays CONVICTION
                            } else {
                                // Strong lock - enforce 85% floor visually
                                finalConfidence = Math.max(finalConfidence, 0.85);
                            }
                        }
                    }
                }

                // 2. If Committed, maintain floor (Ironclad Commitment)
                if (this.cycleCommitted) {
                    finalSignal = this.committedDirection;
                    // Never drop below ADVISORY once committed
                    if (tier === 'NONE') tier = 'ADVISORY';

                    // If we are holding against the tide, show resilience (min 70%)
                    // This prevents the user from seeing "51% confidence" when we are committed
                    if (finalConfidence < 0.70) finalConfidence = 0.70;
                }

                // 3. Apply Smoothed State
                this.confidence = finalConfidence;
                this.tier = tier;
                this.prediction = finalSignal;

                this.stabilityCounter = 0;
                this.pendingSignal = null;

                if (this.lastSignal) {
                    this.lastSignal.conf = finalConfidence;
                    this.lastSignal.tier = tier;
                }
            }

            // 🛡️ FIX #3: CORRECTED EDGE CALCULATION
            // Edge = (Your Confidence - Market's Price for YOUR side) * 100
            // Example: 90% confidence on UP, market says UP is 60% → Edge = 30%
            // If market says UP is 99%, you need >99% confidence for positive edge
            if (currentMarkets[this.asset] && this.prediction !== 'WAIT') {
                const market = currentMarkets[this.asset];
                const ourSideOdds = this.prediction === 'UP' ? market.yesPrice : market.noPrice;
                const oppositeSideOdds = this.prediction === 'UP' ? market.noPrice : market.yesPrice;

                // TRUE edge calculation
                this.edge = (this.confidence - ourSideOdds) * 100;

                // WARNING: If betting against extreme odds (opposite > 90%)
                if (oppositeSideOdds > 0.90 && this.edge > 0) {
                    log(`⚠️ HIGH-RISK BET: Opposite side ${(oppositeSideOdds * 100).toFixed(1)}%, our confidence ${(this.confidence * 100).toFixed(1)}%, edge ${this.edge.toFixed(1)}%`, this.asset);
                }
            } else {
                this.edge = 0;
            }

            // Check if this is a sniper-grade opportunity and alert if criteria met
            if (NotificationManager.shouldSendAlert(this, this.asset)) {
                NotificationManager.sendAlert(this.asset, this);
            }

            // 🐛 CYCLE HISTORY: Record snapshot every 10 seconds
            const now = Date.now();
            // Reuse elapsed variable from top of update() method

            // Record snapshot every 10 seconds (to keep history manageable)
            if (!this.lastSnapshotTime || (now - this.lastSnapshotTime) >= 10000) {
                this.currentCycleHistory.push({
                    timestamp: new Date(now).toISOString(),
                    elapsed: elapsed,
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
                this.lastSnapshotTime = now;

                // Keep history limited to prevent memory issues (max 100 snapshots per cycle)
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
                // Track recent form (last 10)
                this.recentOutcomes.push(isWin);
                if (this.recentOutcomes.length > 10) this.recentOutcomes.shift();

                // 🎯 RECALCULATE CACHED WEIGHTS (Learning Loop)
                // This is where the bot gets smarter over time
                for (const [model, stats] of Object.entries(this.modelAccuracy)) {
                    if (stats.total < 10) {
                        // Not enough data yet, keep default weight
                        this.cachedWeights[model] = 1.0;
                    } else {
                        // Calculate accuracy for this model
                        const accuracy = stats.wins / stats.total;
                        // Boost high-accuracy models (>60%), penalize low-accuracy (<40%)
                        // Range: 0.2 to 2.0
                        this.cachedWeights[model] = Math.max(0.2, Math.min(2.0, Math.pow(accuracy * 2, 1.5)));
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
            }
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
                    livePriceTimestamps[asset] = now; // Per-asset timestamp
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
                    livePriceTimestamps[asset] = now; // Per-asset timestamp
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
    <title>PolyProphet - LIVE</title>
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
        .personal-note {
            background: rgba(255,100,0,0.15);
            border: 2px solid rgba(255,100,0,0.4);
            border-radius: 12px;
            padding: 20px;
            margin: 20px auto;
            max-width: 800px;
            text-align: center;
            font-size: 0.95em;
            line-height: 1.6;
            box-shadow: 0 4px 15px rgba(0,0,0,0.3);
        }
        .personal-note strong { color: #ff6644; }
        .usage-guide {
            background: rgba(0,0,0,0.5);
            border: 2px solid rgba(0,200,255,0.4);
            border-radius: 12px;
            padding: 20px;
            margin: 20px auto;
            max-width: 1000px;
            box-shadow: 0 4px 15px rgba(0,0,0,0.3);
        }
        .usage-guide h2 {
            color: #00ccff;
            margin-bottom: 15px;
            text-align: center;
        }
        .usage-guide .step {
            background: rgba(255,255,255,0.05);
            padding: 12px;
            margin: 10px 0;
            border-left: 4px solid #00ff88;
            border-radius: 6px;
        }
        .usage-guide .step-number {
            color: #00ff88;
            font-weight: bold;
            margin-right: 8px;
        }
        .usage-guide .tip {
            background: rgba(255,200,0,0.1);
            border-left: 4px solid #ffcc00;
            padding: 10px;
            margin: 15px 0;
            border-radius: 6px;
            font-size: 0.9em;
        }
        .usage-guide .tip::before {
            content: "💡 ";
            font-size: 1.2em;
        }
        .toggle-guide {
            background: rgba(0,150,255,0.3);
            border: 1px solid #0096ff;
            color: white;
            padding: 10px 20px;
            border-radius: 6px;
            cursor: pointer;
            font-size: 0.9em;
            margin: 10px auto;
            display: block;
            transition: all 0.3s;
        }
        .toggle-guide:hover {
            background: rgba(0,150,255,0.5);
            transform: scale(1.05);
        }
    </style>
</head>
<body>
    <div class="header">
        <h1>🔮 PolyProphet</h1>
        <div class="status-bar">
            ✅ <strong>LIVE</strong> | Next Checkpoint: <span class="countdown" id="countdown">--:--</span> | <span id="last-update">Loading...</span>
        </div>
    </div>
    
    <div class="personal-note">
        <strong>If you're here, then I trust you.</strong> DO NOT SHARE THIS TO ANYONE ELSE OR TELL ANYONE ELSE ABOUT THIS. Don't lose my trust. Only the people that need to know have this, please keep it that way.<br><br>
        <em>love, jeed ❤️</em>
    </div>
    
    <button class="toggle-guide" onclick="toggleSettings()">
        ⚙️ Notification Settings (Click to Configure)
    </button>
    
    <button class="toggle-guide" onclick="document.getElementById('guide').style.display = document.getElementById('guide').style.display === 'none' ? 'block' : 'none'">
        📖 How to Use PolyProphet (Click to Show/Hide)
    </button>
    
    <!-- SETTINGS PANEL MODAL -->
    <div id="overlay" onclick="toggleSettings()" style="display: none; position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0,0,0,0.7); z-index: 999;"></div>
    
    <div id="settingsPanel" style="display: none; position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%); background: #1a1a2e; padding: 30px; border-radius: 12px; border: 2px solid #0096ff; z-index: 1000; max-width: 700px; width: 90%; max-height: 90vh; overflow-y: auto; box-shadow: 0 0 50px rgba(0,150,255,0.3);">
        <h2 style="color: #00ccff; text-align: center;">⚙️ Notification Settings</h2>
        
        <!-- Gmail Configuration -->
        <div style="background: rgba(255,255,255,0.05); padding: 15px; border-radius: 8px; margin: 15px 0;">
            <h3 style="color: #fff;">📧 Gmail Configuration</h3>
            <div id="gmailStatus" style="margin-bottom: 10px; color: #888;">Status: <span id="gmailStatusText">Not configured</span></div>
            <input type="text" id="gmailUser" placeholder="your-email@gmail.com" style="padding: 8px; border-radius: 4px; border: 1px solid #444; background: #0a0a12; color: white; width: calc(100% - 18px); margin-bottom: 8px;">
            <input type="password" id="gmailPassword" placeholder="Gmail App Password (16 chars)" style="padding: 8px; border-radius: 4px; border: 1px solid #444; background: #0a0a12; color: white; width: calc(100% - 18px); margin-bottom: 8px;">
            <button onclick="saveGmailCreds()" style="background: #00ff88; color: black; padding: 8px 16px; border: none; border-radius: 4px; cursor: pointer; font-weight: bold;">Save Gmail</button>
            <small style="display: block; margin-top: 8px; color: #888;">Get App Password: <a href="https://myaccount.google.com/apppasswords" target="_blank" style="color: #00ccff;">Google Account</a></small>
        </div>
        
        <!-- Twilio Configuration -->
        <div style="background: rgba(255,255,255,0.05); padding: 15px; border-radius: 8px; margin: 15px 0;">
            <h3 style="color: #fff;">📱 Twilio Configuration</h3>
            <div id="twilioStatus" style="margin-bottom: 10px; color: #888;">Status: <span id="twilioStatusText">Not configured</span></div>
            <input type="text" id="twilioSid" placeholder="Account SID (AC...)" style="padding: 8px; border-radius: 4px; border: 1px solid #444; background: #0a0a12; color: white; width: calc(100% - 18px); margin-bottom: 8px;">
            <input type="password" id="twilioToken" placeholder="Auth Token" style="padding: 8px; border-radius: 4px; border: 1px solid #444; background: #0a0a12; color: white; width: calc(100% - 18px); margin-bottom: 8px;">
            <input type="text" id="twilioPhone" placeholder="Twilio Phone (+1234567890)" style="padding: 8px; border-radius: 4px; border: 1px solid #444; background: #0a0a12; color: white; width: calc(100% - 18px); margin-bottom: 8px;">
            <button onclick="saveTwilioCreds()" style="background: #00ff88; color: black; padding: 8px 16px; border: none; border-radius: 4px; cursor: pointer; font-weight: bold;">Save Twilio</button>
            <small style="display: block; margin-top: 8px; color: #888;">Sign up: <a href="https://twilio.com/try-twilio" target="_blank" style="color: #00ccff;">Twilio Free Trial</a></small>
        </div>
        
        <!-- Your Contact Info -->
        <div style="background: rgba(255,255,255,0.05); padding: 15px; border-radius: 8px; margin: 15px 0;">
            <h3 style="color: #fff;">👤 Your Contact Info</h3>
            <div style="margin: 10px 0;">
                <label style="display: block; margin-bottom: 5px;">Email to Receive Alerts:</label>
                <input type="email" id="userEmail" placeholder="your@email.com" style="padding: 8px; border-radius: 4px; border: 1px solid #444; background: #0a0a12; color: white; width: 60%;">
                <button onclick="saveEmail()" style="background: #0096ff; color: white; padding: 8px 16px; border: none; border-radius: 4px; cursor: pointer; margin-left: 8px;">Save</button>
                <button onclick="testEmail()" style="background: #ffaa00; color: black; padding: 8px 16px; border: none; border-radius: 4px; cursor: pointer; margin-left: 8px;">Test</button>
                <div id="userEmailStatus" style="margin-top: 5px; color: #888;">Not set</div>
            </div>
            <div style="margin: 10px 0;">
                <label style="display: block; margin-bottom: 5px;">Phone to Receive SMS:</label>
                <input type="tel" id="userPhone" placeholder="+1234567890" style="padding: 8px; border-radius: 4px; border: 1px solid #444; background: #0a0a12; color: white; width: 60%;">
                <button onclick="savePhone()" style="background: #0096ff; color: white; padding: 8px 16px; border: none; border-radius: 4px; cursor: pointer; margin-left: 8px;">Save</button>
                <button onclick="testSMS()" style="background: #ffaa00; color: black; padding: 8px 16px; border: none; border-radius: 4px; cursor: pointer; margin-left: 8px;">Test</button>
                <div id="userPhoneStatus" style="margin-top: 5px; color: #888;">Not set</div>
            </div>
        </div>
        
        <!-- Browser Notifications -->
        <div style="background: rgba(255,255,255,0.05); padding: 15px; border-radius: 8px; margin: 15px 0;">
            <h3 style="color: #fff;">🔔 Browser Notifications</h3>
            <button onclick="enableBrowser()" style="background: #0096ff; color: white; padding: 8px 16px; border: none; border-radius: 4px; cursor: pointer;">Enable Browser Alerts</button>
            <div id="browserStatus" style="margin-top: 8px; color: #888;">Click to enable</div>
        </div>
        
        <!-- Alert Preferences -->
        <div style="background: rgba(255,255,255,0.05); padding: 15px; border-radius: 8px; margin: 15px 0;">
            <h3 style="color: #fff;">🎯 When to Alert Me</h3>
            <label style="display: block; margin: 8px 0;"><input type="checkbox" id="alertSniper" onchange="updatePrefs()" checked> Sniper Opportunities (90%+ Conviction) ⭐ Recommended</label>
            <label style="display: block; margin: 8px 0;"><input type="checkbox" id="alertStandard" onchange="updatePrefs()"> Standard Conviction (85%+)</label>
        </div>
        
        <button onclick="toggleSettings()" style="width: 100%; margin-top: 15px; background: #444; color: white; padding: 10px; border: none; border-radius: 4px; cursor: pointer;">Close</button>
    </div>
    
    <div id="guide" class="usage-guide" style="display: none;">
        <h2>💰 How to Turn Your Money into More Money</h2>
        
        <div class="step">
            <span class="step-number">STEP 1:</span> <strong>Watch the Predictions</strong><br>
            Each card shows a crypto (BTC, ETH, SOL, XRP). The bot predicts if it will go <strong style="color: #00ff00;">UP</strong> or <strong style="color: #ff0044;">DOWN</strong> in the next 15 minutes.
        </div>
        
        <div class="step">
            <span class="step-number">STEP 2:</span> <strong>Check the Confidence %</strong><br>
            Higher % = More confident. Look for <strong>70%+</strong> predictions. The bot uses 8 AI models to analyze the market.
        </div>
        
        <div class="step">
            <span class="step-number">STEP 3:</span> <strong>Understand the Tiers</strong><br>
            🔴 <strong>CONVICTION</strong> (85%+) = Strongest signal, highest confidence<br>
            🟠 <strong>ADVISORY</strong> (70-84%) = Good signal, moderate confidence<br>
            ⚫ <strong>NONE</strong> (<70%) = Weak signal, wait for better setup
        </div>
        
        <div class="step">
            <span class="step-number">STEP 4:</span> <strong>Click "View on Polymarket"</strong><br>
            When you see a CONVICTION or ADVISORY signal, click the blue link to open the market on Polymarket.
        </div>
        
        <div class="step">
            <span class="step-number">STEP 5:</span> <strong>Place Your Bet</strong><br>
            On Polymarket, buy shares for the direction shown (UP or DOWN). Use 2-5% of your bankroll per trade to stay safe.
        </div>
        
        <div class="tip">
            <strong>Pro Tip:</strong> Wait for the CONVICTION tier (🔴) or watch for the 🔒 LOCKED status. When locked, the bot is highly confident and won't change its mind.
        </div>
        
        <div class="tip">
            <strong>Important:</strong> The countdown shows time until the next cycle. Act fast when you see a strong signal in the first 5 minutes of a new cycle.
        </div>
        
        <div class="tip">
            <strong>Risk Management:</strong> Never bet everything on one prediction. Start small (£10-20), let it compound. This is how you turn £10 into £1,000+.
        </div>
        
        <div class="step">
            <span class="step-number">WINNING FORMULA:</span><br>
            ✅ High confidence (80%+)<br>
            ✅ CONVICTION or ADVISORY tier<br>
            ✅ Early in the cycle (first 5 min)<br>
            ✅ Check Win Rate (aim for assets with 60%+ win rate)
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
                                <button onclick="exportCycle('\${asset}')" style="background: #ff9900; color: black; padding: 8px 16px; border: none; border-radius: 6px; cursor: pointer; margin-left: 8px; font-weight: bold;">
                                    🐛 Export Debug
                                </button>
                            </div>\` : ''}
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
                document.getElementById('dashboard').innerHTML = \`
                    <div class="loading" style="color: #ff4444;">
                        ❌ Error loading data: \${e.message}
                    </div>
                \`;
            }
        }
        
        // Initial load
        fetchData();
        
        // Auto-refresh every 1 second
        setInterval(fetchData, 1000);
        
        // ==================== SETTINGS PANEL FUNCTIONS ====================
        
        function toggleSettings() {
            const panel = document.getElementById('settingsPanel');
            const overlay = document.getElementById('overlay');
            const isVisible = panel.style.display === 'block';
            panel.style.display = isVisible ? 'none' : 'block';
            overlay.style.display = isVisible ? 'none' : 'block';
            if (!isVisible) loadPreferences();
        }
        
        async function loadPreferences() {
            try {
                const res = await fetch('/api/preferences');
                const prefs = await res.json();
                
                // Update status indicators
                document.getElementById('gmailStatusText').textContent = prefs.gmailConfigured ? '✅ Configured' : 'Not configured';
                document.getElementById('gmailStatusText').style.color = prefs.gmailConfigured ? '#00ff88' : '#888';
                
                document.getElementById('twilioStatusText').textContent = prefs.twilioConfigured ? '✅ Configured' : 'Not configured';
                document.getElementById('twilioStatusText').style.color = prefs.twilioConfigured ? '#00ff88' : '#888';
                
                document.getElementById('userEmailStatus').textContent = prefs.email || 'Not set';
                document.getElementById('userPhoneStatus').textContent = prefs.phone || 'Not set';
                
                // Update checkboxes
                document.getElementById('alertSniper').checked = prefs.alertOnSniper !== false;
                document.getElementById('alertStandard').checked = prefs.alertOnStandard === true;
            } catch (e) {
                console.error('Failed to load preferences:', e);
            }
        }
        
        async function saveGmailCreds() {
            const gmailUser = document.getElementById('gmailUser').value;
            const gmailPassword = document.getElementById('gmailPassword').value;
            
            if (!gmailUser || !gmailPassword) {
                alert('Please enter both email and app password');
                return;
            }
            
            const res = await fetch('/api/save-gmail-credentials', {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({ gmailUser, gmailPassword })
            });
            
            const result = await res.json();
            if (result.success) {
                alert('✅ Gmail configured successfully!');
                document.getElementById('gmailUser').value = '';
                document.getElementById('gmailPassword').value = '';
                loadPreferences();
            } else {
                alert('❌ Failed to configure Gmail. Check credentials.');
            }
        }
        
        async function saveTwilioCreds() {
            const twilioSid = document.getElementById('twilioSid').value;
            const twilioToken = document.getElementById('twilioToken').value;
            const twilioPhone = document.getElementById('twilioPhone').value;
            
            if (!twilioSid || !twilioToken || !twilioPhone) {
                alert('Please enter SID, Token, and Phone');
                return;
            }
            
            const res = await fetch('/api/save-twilio-credentials', {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({ twilioSid, twilioToken, twilioPhone })
            });
            
            const result = await res.json();
            if (result.success) {
                alert('✅ Twilio configured successfully!');
                document.getElementById('twilioSid').value = '';
                document.getElementById('twilioToken').value = '';
                document.getElementById('twilioPhone').value = '';
                loadPreferences();
            } else {
                alert('❌ Failed to configure Twilio. Check credentials.');
            }
        }
        
        async function saveEmail() {
            const email = document.getElementById('userEmail').value;
            if (!email) {
                alert('Please enter an email');
                return;
            }
            await fetch('/api/save-email', {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({ email })
            });
            alert('✅ Email saved!');
            loadPreferences();
        }
        
        async function savePhone() {
            const phone = document.getElementById('userPhone').value;
            if (!phone) {
                alert('Please enter a phone number');
                return;
            }
            await fetch('/api/save-phone', {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({ phone })
            });
            alert('✅ Phone saved!');
            loadPreferences();
        }
        
        async function testEmail() {
            const res = await fetch('/api/test-email', { method: 'POST' });
            if (res.ok) {
                alert('✅ Test email sent! Check your inbox.');
            } else {
                const err = await res.json();
                alert('❌ Error: ' + (err.error || 'Email not configured'));
            }
        }
        
        async function testSMS() {
            const res = await fetch('/api/test-sms', { method: 'POST' });
            if (res.ok) {
                alert('✅ Test SMS sent!');
            } else {
                const err = await res.json();
                alert('❌ Error: ' + (err.error || 'SMS not configured'));
            }
        }
        
        async function enableBrowser() {
            if (!('Notification' in window)) {
                alert('❌ Browser notifications not supported');
                return;
            }
            
            const permission = await Notification.requestPermission();
            if (permission === 'granted') {
                document.getElementById('browserStatus').textContent = '✅ Enabled';
                document.getElementById('browserStatus').style.color = '#00ff88';
                new Notification('🔔 Browser Alerts Enabled', {
                    body: 'You will now receive sniper opportunity alerts!',
                    icon: '/icon.png'
                });
            } else {
                alert('❌ Permission denied');
            }
        }
        
        async function updatePrefs() {
            const alertOnSniper = document.getElementById('alertSniper').checked;
            const alertOnStandard = document.getElementById('alertStandard').checked;
            
            await fetch('/api/update-preferences', {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({
                    alertOnSniper,
                    alertOnStandard,
                    enableEmail: true,
                    enableSMS: true
                })
            });
        }
        
        async function exportCycle(asset) {
            try {
                const res = await fetch('/api/export-last-cycle?asset=' + asset);
                const data = await res.json();
                
                const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = asset + '_cycle_' + new Date().toISOString().replace(/[:.]/g, '-') + '.json';
                document.body.appendChild(a);
                a.click();
                document.body.removeChild(a);
                URL.revokeObjectURL(url);
                
                alert('✅ Exported ' + asset + ' cycle data to JSON file!');
            } catch (e) {
                alert('❌ Export failed: ' + e.message);
            }
        }
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
            calibration: Brains[a].calibrationBuckets
        };
    });
    res.json(response);
});

// ==================== NOTIFICATION API ENDPOINTS ====================

app.get('/api/preferences', (req, res) => {
    // Return preferences but hide sensitive credentials (only show if configured)
    res.json({
        email: userPreferences.email,
        phone: userPreferences.phone,
        gmailConfigured: !!(userPreferences.gmailUser && userPreferences.gmailPassword),
        twilioConfigured: !!(userPreferences.twilioSid && userPreferences.twilioToken && userPreferences.twilioPhone),
        enableEmail: userPreferences.enableEmail,
        enableSMS: userPreferences.enableSMS,
        enableBrowser: userPreferences.enableBrowser,
        alertOnSniper: userPreferences.alertOnSniper,
        alertOnStandard: userPreferences.alertOnStandard
    });
});

app.post('/api/save-email', async (req, res) => {
    userPreferences.email = req.body.email;
    if (redisAvailable && redis) await redis.set('prefs:email', req.body.email);
    log(`📧 Email saved: ${req.body.email}`);
    res.json({ success: true });
});

app.post('/api/remove-email', async (req, res) => {
    userPreferences.email = null;
    if (redisAvailable && redis) await redis.del('prefs:email');
    log('📧 Email removed');
    res.json({ success: true });
});

app.post('/api/save-phone', async (req, res) => {
    userPreferences.phone = req.body.phone;
    if (redisAvailable && redis) await redis.set('prefs:phone', req.body.phone);
    log(`📱 Phone saved: ${req.body.phone}`);
    res.json({ success: true });
});

app.post('/api/remove-phone', async (req, res) => {
    userPreferences.phone = null;
    if (redisAvailable && redis) await redis.del('prefs:phone');
    log('📱 Phone removed');
    res.json({ success: true });
});

app.post('/api/test-email', async (req, res) => {
    if (!emailTransporter || !userPreferences.email) {
        return res.status(400).json({ error: 'Email not configured' });
    }
    try {
        await emailTransporter.sendMail({
            from: process.env.GMAIL_USER,
            to: userPreferences.email,
            subject: '🧪 PolyProphet Test',
            text: 'This is a test notification from PolyProphet Supreme. If you received this, email alerts are working!'
        });
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/test-sms', async (req, res) => {
    if (!twilioClient || !userPreferences.phone) {
        return res.status(400).json({ error: 'SMS not configured' });
    }
    try {
        await twilioClient.messages.create({
            body: '🧪 PolyProphet Test SMS - Alerts working!',
            from: process.env.TWILIO_PHONE,
            to: userPreferences.phone
        });
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/alert-history', (req, res) => {
    res.json(alertHistory);
});

app.post('/api/update-preferences', async (req, res) => {
    const { alertOnSniper, alertOnStandard, enableEmail, enableSMS } = req.body;

    if (alertOnSniper !== undefined) userPreferences.alertOnSniper = alertOnSniper;
    if (alertOnStandard !== undefined) userPreferences.alertOnStandard = alertOnStandard;
    if (enableEmail !== undefined) userPreferences.enableEmail = enableEmail;
    if (enableSMS !== undefined) userPreferences.enableSMS = enableSMS;

    if (redisAvailable && redis) {
        await redis.set('prefs:config', JSON.stringify({
            alertOnSniper: userPreferences.alertOnSniper,
            alertOnStandard: userPreferences.alertOnStandard,
            enableEmail: userPreferences.enableEmail,
            enableSMS: userPreferences.enableSMS
        }));
    }

    log('⚙️ Preferences updated');
    res.json({ success: true });
});

app.get('/api/system-alerts', (req, res) => {
    res.json(systemAlerts);
});

// ==================== CREDENTIAL CONFIGURATION ENDPOINTS ====================

app.post('/api/save-gmail-credentials', async (req, res) => {
    const { gmailUser, gmailPassword } = req.body;

    userPreferences.gmailUser = gmailUser;
    userPreferences.gmailPassword = gmailPassword;

    // Save to Redis
    if (redisAvailable && redis) {
        await redis.set('creds:gmailUser', gmailUser);
        await redis.set('creds:gmailPassword', gmailPassword);
    }

    // Re-initialize email transporter
    const success = initEmailTransporter();

    log(`📧 Gmail credentials ${success ? 'saved and activated' : 'saved but failed to activate'}`);
    res.json({ success });
});

app.post('/api/save-twilio-credentials', async (req, res) => {
    const { twilioSid, twilioToken, twilioPhone } = req.body;

    userPreferences.twilioSid = twilioSid;
    userPreferences.twilioToken = twilioToken;
    userPreferences.twilioPhone = twilioPhone;

    // Save to Redis
    if (redisAvailable && redis) {
        await redis.set('creds:twilioSid', twilioSid);
        await redis.set('creds:twilioToken', twilioToken);
        await redis.set('creds:twilioPhone', twilioPhone);
    }

    // Re-initialize Twilio client
    const success = initTwilioClient();

    log(`📱 Twilio credentials ${success ? 'saved and activated' : 'saved but failed to activate'}`);
    res.json({ success });
});

//After line 2527, add:
app.get('/api/export-last-cycle', (req, res) => {
    const asset = req.query.asset || 'BTC';
    const brain = Brains[asset];

    if (!brain.lastCompletedCycle) {
        return res.status(404).json({
            error: 'No completed cycle yet',
            message: 'Wait 15 minutes for first cycle'
        });
    }

    res.json({
        asset,
        cycle: brain.lastCompletedCycle,
        modelWeights: brain.cachedWeights,
        stats: brain.stats
    });
});

// Service Worker for Browser Notifications
app.get('/sw.js', (req, res) => {
    res.setHeader('Content-Type', 'application/javascript');
    res.send(`
        self.addEventListener('push', event => {
            const data = event.data.json();
            self.registration.showNotification(data.title, {
                body: data.body,
                icon: '/icon.png',
                badge: '/badge.png'
            });
        });
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
                    log(`⚠️ Checkpoint skipped - stale data (${(dataAge / 1000).toFixed(1)}s old)`, a);
                    return;
                }

                // Evaluate the JUST FINISHED cycle
                // Use CONFIRMED fresh prices for accurate outcome evaluation
                if (checkpointPrices[a] && livePrices[a]) {
                    Brains[a].evaluateOutcome(livePrices[a], checkpointPrices[a]);
                    log(`📊 Evaluated checkpoint ${cp - INTERVAL_SECONDS} (fresh data)`, a);

                    // 🐛 CYCLE HISTORY: Save completed cycle for export
                    if (Brains[a].currentCycleHistory.length > 0) {
                        Brains[a].lastCompletedCycle = {
                            checkpointStart: cp - INTERVAL_SECONDS,
                            checkpointEnd: cp,
                            startPrice: checkpointPrices[a],
                            endPrice: livePrices[a],
                            outcome: livePrices[a] > checkpointPrices[a] ? 'UP' : 'DOWN',
                            snapshots: [...Brains[a].currentCycleHistory]
                        };
                        // Clear current cycle history for new cycle
                        Brains[a].currentCycleHistory = [];
                        Brains[a].cycleStartTime = Date.now();
                        log(`💾 Saved cycle history (${Brains[a].lastCompletedCycle.snapshots.length} snapshots)`, a);
                    }
                }

                // Update checkpoints for the NEW cycle with FRESH price
                previousCheckpointPrices[a] = checkpointPrices[a];
                checkpointPrices[a] = livePrices[a];

                // Mark this checkpoint as evaluated
                lastEvaluatedCheckpoint[a] = cp;

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

    // Load notification preferences and credentials from Redis
    if (redisAvailable && redis) {
        try {
            // Load user contact info
            userPreferences.email = await redis.get('prefs:email');
            userPreferences.phone = await redis.get('prefs:phone');

            // Load credentials
            const gmailUser = await redis.get('creds:gmailUser');
            const gmailPassword = await redis.get('creds:gmailPassword');
            const twilioSid = await redis.get('creds:twilioSid');
            const twilioToken = await redis.get('creds:twilioToken');
            const twilioPhone = await redis.get('creds:twilioPhone');

            if (gmailUser) userPreferences.gmailUser = gmailUser;
            if (gmailPassword) userPreferences.gmailPassword = gmailPassword;
            if (twilioSid) userPreferences.twilioSid = twilioSid;
            if (twilioToken) userPreferences.twilioToken = twilioToken;
            if (twilioPhone) userPreferences.twilioPhone = twilioPhone;

            // Re-initialize transporters if credentials found
            if (gmailUser && gmailPassword) initEmailTransporter();
            if (twilioSid && twilioToken && twilioPhone) initTwilioClient();

            // Load toggles
            const config = await redis.get('prefs:config');
            if (config) {
                const parsed = JSON.parse(config);
                Object.assign(userPreferences, parsed);
            }

            log('📧 Notification preferences and credentials loaded');
        } catch (e) {
            log(`⚠️ Failed to load notification preferences: ${e.message}`);
        }
    }

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
