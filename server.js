// ==================== POLYPROPHET SUPREME - PART 1 ====================
// Core Infrastructure & Backend Logic

const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const cors = require('cors');
const Redis = require('ioredis');
const auth = require('basic-auth');
const nodemailer = require('nodemailer');
const twilio = require('twilio');
const fs = require('fs');
const path = require('path');

// Initialize App
const app = express();
app.use(cors());
app.use(express.json());

// ==================== PASSWORD PROTECTION ====================
app.use((req, res, next) => {
    // Skip auth for Service Worker and Icons (Public)
    if (req.path === '/sw.js' || req.path === '/icon.png') {
        return next();
    }

    const credentials = auth(req);
    const username = process.env.AUTH_USERNAME || 'admin';
    const password = process.env.AUTH_PASSWORD || 'changeme';

    if (!credentials || credentials.name !== username || credentials.pass !== password) {
        res.statusCode = 401;
        res.setHeader('WWW-Authenticate', 'Basic realm="PolyProphet Supreme"');
        res.end('Access denied');
    } else {
        next();
    }
});

app.use(express.static('public'));
const server = http.createServer(app);

// ==================== REDIS SETUP (FALLBACK-SAFE) ====================
}

// ==================== NOTIFICATION SYSTEM SETUP ====================

// Email (Nodemailer)
let emailTransporter = null;
if (process.env.GMAIL_USER && process.env.GMAIL_APP_PASSWORD) {
    emailTransporter = nodemailer.createTransport({
        service: 'gmail',
        auth: {
            user: process.env.GMAIL_USER,
            pass: process.env.GMAIL_APP_PASSWORD
        }
    });
    log('âœ… Email Notifications Enabled');
} else {
    log('âš ï¸ Email not configured (GMAIL_USER/PASS missing)');
}

// SMS (Twilio)
let twilioClient = null;
if (process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && process.env.TWILIO_PHONE) {
    twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
    log('âœ… SMS Notifications Enabled');
} else {
    log('âš ï¸ SMS not configured (Twilio vars missing)');
}

// Notification Preferences (In-Memory Cache, backed by Redis)
let systemConfig = {
    twilioSid: process.env.TWILIO_ACCOUNT_SID || '',
    twilioToken: process.env.TWILIO_AUTH_TOKEN || '',
    twilioPhone: process.env.TWILIO_PHONE || '',
    gmailUser: process.env.GMAIL_USER || '',
    gmailPass: process.env.GMAIL_APP_PASSWORD || ''
};

let subscribers = []; // Array of { type: 'email'|'sms', value: '...', active: true }
let userPreferences = { // Legacy support / Global toggles
    alertOnSniper: true,
    alertOnStandard: false
};

// Alert Tracking
let lastAlertSent = {};
let alertHistory = [];
const ALERT_COOLDOWN = 5 * 60 * 1000; // 5 minutes

// ==================== CORE DATA STRUCTURES ====================
const ASSETS = ['BTC', 'ETH', 'SOL', 'XRP'];
const INTERVAL_SECONDS = 900; // 15 minutes

// State
let livePrices = {};
let livePriceTimestamps = {};
let checkpointPrices = {};
let previousCheckpointPrices = {};
let lastEvaluatedCheckpoint = {};
let priceHistory = {};
let currentMarkets = {};
let lastUpdateTimestamp = Date.now();
let fearGreedIndex = 50;
let fundingRates = {};

// Initialize State
ASSETS.forEach(asset => {
    priceHistory[asset] = [];
    checkpointPrices[asset] = null;
    previousCheckpointPrices[asset] = null;
    lastEvaluatedCheckpoint[asset] = 0;
    livePrices[asset] = null;
    livePriceTimestamps[asset] = 0;
    currentMarkets[asset] = null;
    lastAlertSent[asset] = 0;
});

// System Health
let systemAlerts = []; // { type: 'error'|'warning', msg: 'Twilio: Out of credits', timestamp: 123 }

function log(msg, asset = null) {
    const timestamp = new Date().toLocaleTimeString();
    const prefix = asset ? `[${asset}]` : '[ORACLE]';
    console.log(`${timestamp} ${prefix} ${msg}`);
}

// ==================== MATH LIBRARY ====================
const MathLib = {
    mean: (data) => data.reduce((a, b) => a + b, 0) / data.length,

    stdDev: (data) => {
        const m = MathLib.mean(data);
        return Math.sqrt(data.reduce((sq, n) => sq + Math.pow(n - m, 2), 0) / data.length);
    },

    rsi: (prices, period = 14) => {
        if (prices.length < period + 1) return 50;
        let gains = 0, losses = 0;
        for (let i = 1; i <= period; i++) {
            const diff = prices[prices.length - i] - prices[prices.length - i - 1];
            if (diff >= 0) gains += diff; else losses -= diff;
        }
        if (losses === 0) return 100;
        return 100 - (100 / (1 + (gains / losses)));
    },

    ema: (prices, period) => {
        const sd = MathLib.stdDev(slice);
        return { upper: sma + (sd * stdDev), lower: sma - (sd * stdDev), middle: sma };
    },

    atr: (highs, lows, closes, period = 14) => {
        if (highs.length < period) return 0;
        let trs = [];
        for (let i = 1; i < highs.length; i++) {
            const tr = Math.max(
                highs[i] - lows[i],
                Math.abs(highs[i] - closes[i - 1]),
                Math.abs(lows[i] - closes[i - 1])
            );
            trs.push(tr);
        }
        return MathLib.ema(trs, period);
    }
};

// ==================== KALMAN FILTER ====================
class KalmanFilter {
    constructor(R = 0.01, Q = 0.1) {
        this.R = R; // Noise covariance
        this.Q = Q; // Process covariance
        this.x = null; // Value
        this.P = 1.0; // Error covariance
        this.K = 0; // Kalman gain
    }

    update(measurement) {
        if (this.x === null) {
            this.x = measurement;
            return this.x;
        }
        this.P = this.P + this.Q;
        this.K = this.P / (this.P + this.R);
        this.x = this.x + this.K * (measurement - this.x);
        this.P = (1 - this.K) * this.P;
        return this.x;
    }
}

// ==================== HISTORIAN (PATTERN ENGINE) ====================
const Historian = {
    patterns: {}, // { 'BTC': { 'UP-UP-DOWN': { wins: 5, total: 8 } } }

    async init() {
        if (redisAvailable) {
            for (const asset of ASSETS) {
                const data = await redis.get(`patterns:${asset}`);
                if (data) this.patterns[asset] = JSON.parse(data);
                else this.patterns[asset] = {};
            }
            log('📚 Historical patterns loaded from Redis');
        } else {
            ASSETS.forEach(a => this.patterns[a] = {});
        }
    },

    recordOutcome(asset, sequence, actualOutcome) {
        if (!this.patterns[asset]) this.patterns[asset] = {};
        if (!this.patterns[asset][sequence]) {
            this.patterns[asset][sequence] = { wins: 0, total: 0 };
        }

        this.patterns[asset][sequence].total++;
        if (actualOutcome === 'WIN') {
            // Logic: If prediction matched outcome, it's a win for that prediction.
            // But here we are recording the sequence -> outcome.
            // For simplicity in this engine, we just track total occurrences.
            // The 'wins' field is legacy from the complex version, but we'll keep it incrementing.
            this.patterns[asset][sequence].wins++;
        }
    },

    // Simplified for Supreme: We just want to know if a pattern is bullish or bearish
    getSignal(asset, recentHistory) {
        const seq = recentHistory.slice(-3).join('-'); // Last 3 moves
        const stats = this.patterns[asset]?.[seq];
        if (!stats || stats.total < 3) return 0; // Not enough data

        // Simple heuristic: If this sequence appears often, does it have a directional bias?
        // For this version, we return 0 to rely on Math models, unless we have deep history.
        return 0;
    },

    async save() {
        if (redisAvailable) {
            for (const asset of ASSETS) {
                await redis.set(`patterns:${asset}`, JSON.stringify(this.patterns[asset]));
            }
        }
    }
};
// ==================== NOTIFICATION MANAGER ====================
class NotificationManager {
    static async sendAlert(asset, brain) {
        const now = Date.now();

        // Check cooldown
        if ((now - (lastAlertSent[asset] || 0)) < ALERT_COOLDOWN) {
            return; // Too soon
        }


        setInterval(() => ASSETS.forEach(a => Brains[a].update()), 1000);
        setInterval(fetchCurrentMarkets, 2000);
        setInterval(Historian.save, 60000);

        server.listen(process.env.PORT || 3000, () => {
            log(`âœ… Server running on port ${process.env.PORT || 3000}`);
        });
    }

    startup();
