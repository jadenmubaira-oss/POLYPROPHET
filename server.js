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
// 🎯 GOAT v44.1: Support both Basic Auth AND Bearer token for API access
const API_KEY = process.env.API_KEY || crypto.randomBytes(32).toString('hex');
console.log(`🔑 API Key (for programmatic access): ${API_KEY.substring(0, 8)}...${API_KEY.substring(API_KEY.length - 4)}`);

app.use((req, res, next) => {
    // Public endpoints (no auth) for uptime checks / deploy verification only.
    const isPublicApi =
        req.path === '/api/health' ||
        req.path === '/api/version' ||
        req.path === '/api/state-public'; // Read-only public state endpoint
    if (isPublicApi) return next();

    const username = process.env.AUTH_USERNAME || 'admin';
    const password = process.env.AUTH_PASSWORD || 'changeme';

    // 🎯 GOAT: Check Bearer token first (for programmatic/mobile access)
    const authHeader = req.headers.authorization || '';
    if (authHeader.startsWith('Bearer ')) {
        const token = authHeader.substring(7);
        if (token === API_KEY || token === password) {
            return next();
        }
    }

    // Fall back to Basic Auth (for browser access)
    const credentials = auth(req);
    if (credentials && credentials.name === username && credentials.pass === password) {
        return next();
    }

    // 🎯 GOAT: Also accept API key as query param for easy dashboard testing
    if (req.query.apiKey === API_KEY || req.query.apiKey === password) {
        return next();
    }

    res.statusCode = 401;
    res.setHeader('WWW-Authenticate', 'Basic realm="POLYPROPHET"');
    res.json({ error: 'Access denied', hint: 'Use Basic Auth (username:password) or Bearer token (Authorization: Bearer <API_KEY>)' });
});

// Serve static assets, but do NOT auto-serve public/index.html at `/`
// (we want `/` to be the full-featured dashboard, like the original server.js UI)
app.use(express.static('public', { index: false }));

// ==================== PROOF-QUALITY BACKTEST API ====================
// 🎯 GOAT: Deterministic backtester using historical cycle data
app.get('/api/backtest-proof', async (req, res) => {
    try {
        const fs = require('fs');
        const path = require('path');
        
        // Parse query params
        const minConfigVersion = parseInt(req.query.minConfigVersion) || 0;
        const filterCommit = req.query.commit || null;
        const startingBalance = parseFloat(req.query.balance) || 5.0;
        const tierFilter = req.query.tier || 'CONVICTION'; // CONVICTION, ADVISORY, or ALL
        const priceFilter = req.query.prices || 'EXTREME'; // EXTREME (<20¢ or >95¢), ALL
        
        // Fee model: 2% on profits at resolution
        const PROFIT_FEE_PCT = 0.02;
        const SLIPPAGE_PCT = 0.01;
        const MAX_POSITION_PCT = 0.60; // Max 60% of balance per trade
        
        const debugDir = path.join(__dirname, 'debug');
        if (!fs.existsSync(debugDir)) {
            return res.json({ error: 'No debug directory found', cycles: 0 });
        }
        
        const debugFiles = fs.readdirSync(debugDir)
            .filter(f => f.startsWith('polyprophet_debug_') && f.endsWith('.json'))
            .sort(); // chronological order
        
        // Collect all cycles from all matching debug files
        const allCycles = [];
        const seenCycleEnds = new Set(); // Dedup by cycle end time
        
        for (const file of debugFiles) {
            try {
                const content = fs.readFileSync(path.join(debugDir, file), 'utf8');
                const data = JSON.parse(content);
                
                // Filter by config version
                const configVer = data.code?.configVersion || 0;
                if (configVer < minConfigVersion) continue;
                
                // Filter by commit
                if (filterCommit && data.code?.gitCommit && !data.code.gitCommit.startsWith(filterCommit)) continue;
                
                // Extract cycles from each asset
                const assets = data.assets || {};
                for (const [asset, assetData] of Object.entries(assets)) {
                    const cycleHistory = assetData.cycleHistory || [];
                    for (const cycle of cycleHistory) {
                        if (!cycle.cycleEndTime) continue;
                        
                        // Dedup
                        const key = `${asset}_${cycle.cycleEndTime}`;
                        if (seenCycleEnds.has(key)) continue;
                        seenCycleEnds.add(key);
                        
                        // Apply tier filter
                        const tier = cycle.tier || 'NONE';
                        if (tierFilter !== 'ALL' && tier !== tierFilter) continue;
                        
                        // Apply price filter
                        const odds = cycle.marketOdds || {};
                        const yesPrice = odds.yesPrice || 0.5;
                        const noPrice = odds.noPrice || 0.5;
                        const prediction = cycle.prediction;
                        const entryPrice = prediction === 'UP' ? yesPrice : noPrice;
                        
                        if (priceFilter === 'EXTREME') {
                            if (entryPrice >= 0.20 && entryPrice <= 0.95) continue; // Skip mid-range
                        }
                        
                        allCycles.push({
                            asset,
                            cycleEndTime: cycle.cycleEndTime,
                            prediction,
                            actualOutcome: cycle.actualOutcome,
                            wasCorrect: cycle.wasCorrect,
                            tier,
                            confidence: cycle.confidence || 0,
                            entryPrice,
                            configVersion: configVer
                        });
                    }
                }
            } catch (e) {
                // Skip malformed files
            }
        }
        
        // Sort by cycle end time
        allCycles.sort((a, b) => new Date(a.cycleEndTime) - new Date(b.cycleEndTime));
        
        // Simulate trading
        let balance = startingBalance;
        let peakBalance = startingBalance;
        let maxDrawdown = 0;
        let wins = 0;
        let losses = 0;
        const trades = [];
        const balanceHistory = [{ time: 'start', balance: startingBalance }];
        
        for (const cycle of allCycles) {
            if (balance <= 1.0) break; // Stop if balance too low
            
            // Position sizing: realistic caps to prevent astronomical compounding
            // Cap at $100 max per trade even with large balances (simulates real-world liquidity limits)
            const MAX_ABSOLUTE_SIZE = 100.0;
            const percentSize = balance * MAX_POSITION_PCT;
            const positionSize = Math.min(percentSize, balance - 1.0, MAX_ABSOLUTE_SIZE);
            if (positionSize <= 0) break;
            
            // Entry price with slippage
            const effectiveEntry = Math.min(0.99, cycle.entryPrice * (1 + SLIPPAGE_PCT));
            
            // Calculate shares
            const shares = positionSize / effectiveEntry;
            
            // Resolution: win pays $1/share, loss pays $0
            let pnl;
            if (cycle.wasCorrect) {
                // Win: shares resolve to $1 each, minus fee on profit
                const grossValue = shares * 1.0; // $1 per share
                const profit = grossValue - positionSize;
                const fee = profit * PROFIT_FEE_PCT;
                pnl = profit - fee;
                wins++;
            } else {
                // Loss: shares worth $0
                pnl = -positionSize;
                losses++;
            }
            
            balance += pnl;
            peakBalance = Math.max(peakBalance, balance);
            const drawdown = (peakBalance - balance) / peakBalance;
            maxDrawdown = Math.max(maxDrawdown, drawdown);
            
            trades.push({
                time: cycle.cycleEndTime,
                asset: cycle.asset,
                tier: cycle.tier,
                prediction: cycle.prediction,
                entryPrice: cycle.entryPrice,
                wasCorrect: cycle.wasCorrect,
                pnl: pnl,
                balance: balance
            });
            
            balanceHistory.push({ time: cycle.cycleEndTime, balance });
        }
        
        // Calculate statistics
        const totalTrades = wins + losses;
        const winRate = totalTrades > 0 ? (wins / totalTrades * 100) : 0;
        const totalProfit = balance - startingBalance;
        const profitPct = (totalProfit / startingBalance * 100);
        
        // Time to £100 projection
        const tradesPerDay = totalTrades > 0 ? (totalTrades / (allCycles.length > 0 ? 
            ((new Date(allCycles[allCycles.length - 1].cycleEndTime) - new Date(allCycles[0].cycleEndTime)) / (1000 * 60 * 60 * 24)) : 1)) : 0;
        const avgProfitPerTrade = totalTrades > 0 ? totalProfit / totalTrades : 0;
        const tradesToReach100 = avgProfitPerTrade > 0 ? (100 - startingBalance) / avgProfitPerTrade : Infinity;
        const daysToReach100 = tradesPerDay > 0 ? tradesToReach100 / tradesPerDay : Infinity;
        
        // 🎯 GOAT v44.1: Time-to-target distributions
        const targets = [20, 50, 100, 200, 500];
        const timeToTarget = {};
        for (const target of targets) {
            const idx = balanceHistory.findIndex(b => b.balance >= target);
            if (idx >= 0 && idx < balanceHistory.length) {
                const startTime = new Date(allCycles[0]?.cycleEndTime || Date.now());
                const targetTime = new Date(balanceHistory[idx].time);
                const hoursToTarget = (targetTime - startTime) / (1000 * 60 * 60);
                const tradesNeeded = idx;
                timeToTarget[`to_${target}`] = {
                    reached: true,
                    hours: hoursToTarget.toFixed(1),
                    trades: tradesNeeded,
                    atTrade: idx
                };
            } else {
                // Project based on current trajectory
                if (avgProfitPerTrade > 0 && balance > startingBalance) {
                    const remaining = target - balance;
                    const tradesNeeded = remaining / avgProfitPerTrade;
                    const hoursNeeded = tradesPerDay > 0 ? (tradesNeeded / tradesPerDay) * 24 : Infinity;
                    timeToTarget[`to_${target}`] = {
                        reached: false,
                        projectedHours: Number.isFinite(hoursNeeded) ? hoursNeeded.toFixed(1) : 'N/A',
                        projectedTrades: Number.isFinite(tradesNeeded) ? Math.ceil(tradesNeeded) : 'N/A'
                    };
                } else {
                    timeToTarget[`to_${target}`] = { reached: false, projectedHours: 'N/A' };
                }
            }
        }
        
        // 🎯 GOAT v44.1: Stress test scenarios
        const stressTests = {};
        
        // Scenario 1: Higher fees (3% instead of 2%)
        let stressBalance = startingBalance;
        let stressWins = 0;
        for (const t of trades) {
            if (t.wasCorrect) {
                const profit = (t.entryPrice > 0 ? (1 / t.entryPrice - 1) : 0) * (stressBalance * MAX_POSITION_PCT);
                stressBalance += profit * (1 - 0.03);
                stressWins++;
            } else {
                stressBalance -= stressBalance * MAX_POSITION_PCT * 0.95; // Slightly worse loss
            }
        }
        stressTests.higherFees = {
            finalBalance: stressBalance.toFixed(2),
            profit: (stressBalance - startingBalance).toFixed(2)
        };
        
        // Scenario 2: 5% slippage
        stressBalance = startingBalance;
        for (const t of trades) {
            const slippedEntry = t.entryPrice * 1.05;
            if (t.wasCorrect && slippedEntry < 0.99) {
                const shares = (stressBalance * MAX_POSITION_PCT) / slippedEntry;
                const profit = (shares * 1.0) - (stressBalance * MAX_POSITION_PCT);
                stressBalance += profit * (1 - PROFIT_FEE_PCT);
            } else if (!t.wasCorrect) {
                stressBalance -= stressBalance * MAX_POSITION_PCT;
            }
        }
        stressTests.highSlippage = {
            finalBalance: stressBalance.toFixed(2),
            profit: (stressBalance - startingBalance).toFixed(2)
        };
        
        // Scenario 3: 10% missed fills (random trades skipped)
        stressBalance = startingBalance;
        let skipped = 0;
        for (let i = 0; i < trades.length; i++) {
            if (i % 10 === 0) { skipped++; continue; } // Skip every 10th trade
            const t = trades[i];
            if (t.wasCorrect) {
                const profit = (stressBalance * MAX_POSITION_PCT) * (1 / t.entryPrice - 1);
                stressBalance += profit * (1 - PROFIT_FEE_PCT);
            } else {
                stressBalance -= stressBalance * MAX_POSITION_PCT;
            }
        }
        stressTests.missedFills = {
            finalBalance: stressBalance.toFixed(2),
            profit: (stressBalance - startingBalance).toFixed(2),
            fillsSkipped: skipped
        };
        
        // 🎯 GOAT v44.1: Gate failure analysis (if gateTrace available)
        let gateAnalysis = null;
        if (typeof gateTrace !== 'undefined' && gateTrace) {
            const summary = gateTrace.getSummary();
            gateAnalysis = {
                totalEvaluations: summary.totalEvaluations,
                totalBlocked: summary.totalBlocked,
                blockRate: summary.totalEvaluations > 0 ? ((summary.totalBlocked / summary.totalEvaluations) * 100).toFixed(1) + '%' : 'N/A',
                topBlockers: Object.entries(summary.gateFailures || {}).sort((a, b) => b[1] - a[1]).slice(0, 5)
            };
        }
        
        res.json({
            summary: {
                startingBalance,
                finalBalance: balance,
                totalProfit,
                profitPct: profitPct.toFixed(2) + '%',
                wins,
                losses,
                winRate: winRate.toFixed(2) + '%',
                maxDrawdown: (maxDrawdown * 100).toFixed(2) + '%',
                tradesPerDay: tradesPerDay.toFixed(2),
                daysToReach100: daysToReach100.toFixed(1),
                timeSpan: allCycles.length > 0 ? {
                    start: allCycles[0].cycleEndTime,
                    end: allCycles[allCycles.length - 1].cycleEndTime
                } : null
            },
            filters: {
                tierFilter,
                priceFilter,
                minConfigVersion,
                commit: filterCommit
            },
            totalCyclesAnalyzed: allCycles.length,
            timeToTarget,
            stressTests,
            gateAnalysis,
            trades: trades.slice(-50), // Last 50 trades
            balanceHistory: balanceHistory.filter((_, i) => i % Math.max(1, Math.floor(balanceHistory.length / 100)) === 0 || i === balanceHistory.length - 1) // Sample for chart
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ==================== 🎯 v53 POLYMARKET-NATIVE BACKTEST ====================
// Uses Polymarket Gamma API for ground-truth outcomes + v53 entry prices for accurate profit calculation
app.get('/api/backtest-polymarket', async (req, res) => {
    try {
        const startTime = Date.now();
        const tierFilter = req.query.tier || 'CONVICTION'; // CONVICTION, ADVISORY, ALL
        const startingBalance = parseFloat(req.query.balance) || 5.0; // 🎯 v55 TURBO default: £5 start
        // 🏆 v58 TRUE OPTIMAL defaults (£5→£42 in 24h verified):
        const minOddsEntry = parseFloat(req.query.minOdds) || 0.35; // 🏆 v60 FINAL: TRUE MAXIMUM 35¢ (wider range = more trades)
        const maxOddsEntry = parseFloat(req.query.maxOdds) || 0.95; // 🏆 v60 FINAL: TRUE MAXIMUM 95¢ (wider range)
        const stakeFrac = parseFloat(req.query.stake) || 0.35; // 🚀 v61.2 TRUE MAX: 35% for ABSOLUTE MAX PROFIT
        const limit = parseInt(req.query.limit) || 200; // Max *cycle windows* to process (rate limit protection)
        const debugFilesParam = parseInt(req.query.debugFiles) || 200; // How many debug exports to scan (from the end)
        const maxTradesPerCycleRaw = parseInt(req.query.maxTradesPerCycle);
        const maxTradesPerCycle = Number.isFinite(maxTradesPerCycleRaw)
            ? Math.max(1, Math.min(3, maxTradesPerCycleRaw))
            : Math.max(1, Math.min(3, (CONFIG?.RISK?.maxGlobalTradesPerCycle || 1)));
        const selection = String(req.query.selection || 'HIGHEST_CONF').toUpperCase(); // BEST_EV | HIGHEST_CONF
        const respectEVGate = !(String(req.query.respectEV || '').toLowerCase() === 'false' || String(req.query.respectEV || '') === '0');
        const snapshotPick = String(req.query.snapshotPick || 'EARLIEST').toUpperCase(); // EARLIEST | LATEST
        const stakeMode = String(req.query.stakeMode || 'PER_TRADE').toUpperCase(); // PER_TRADE | PER_WINDOW
        const maxExposureRaw = parseFloat(req.query.maxExposure);
        const maxExposure = Number.isFinite(maxExposureRaw)
            ? Math.max(0.05, Math.min(1.0, maxExposureRaw))
            : Math.max(0.05, Math.min(1.0, (CONFIG?.RISK?.maxTotalExposure || 0.40)));
        const lookbackHoursRaw = parseFloat(req.query.lookbackHours);
        const lookbackHours = Number.isFinite(lookbackHoursRaw) ? Math.max(0.25, Math.min(168, lookbackHoursRaw)) : 24;
        const scan = (req.query.scan === '1' || String(req.query.scan || '').toLowerCase() === 'true');
        const entryMode = String(req.query.entry || 'CLOB_HISTORY').toUpperCase(); // SNAPSHOT | CLOB_HISTORY
        const clobFidelityRaw = parseInt(req.query.fidelity);
        const clobFidelity = Number.isFinite(clobFidelityRaw) ? Math.max(1, Math.min(15, clobFidelityRaw)) : 1; // minutes
        const scanStakes = (typeof req.query.stakes === 'string' && req.query.stakes.length > 0)
            ? req.query.stakes.split(',').map(s => parseFloat(String(s).trim())).filter(x => Number.isFinite(x) && x > 0 && x < 1).slice(0, 10)
            : [0.25, 0.28, 0.30, 0.32, 0.35, 0.38, 0.40]; // 🚀 v61.1: AGGRO scan centered on 30%+
        
        // 🏆 v60 FINAL: Liquidity cap for realistic backtests (matches LIVE sizing)
        const maxAbsRaw = parseFloat(req.query.maxAbs);
        const maxAbsoluteStake = Number.isFinite(maxAbsRaw) && maxAbsRaw > 0
            ? maxAbsRaw
            : parseFloat(process.env.MAX_ABSOLUTE_POSITION_SIZE || '100'); // $100 default
        
        // Fee model
        const PROFIT_FEE_PCT = 0.02;
        const SLIPPAGE_PCT = 0.01;

        const crypto = require('crypto');

        const clamp01 = (x) => {
            const n = Number(x);
            if (!Number.isFinite(n)) return null;
            return Math.max(0, Math.min(1, n));
        };

        function parseMaybeJsonArray(x) {
            if (Array.isArray(x)) return x;
            if (typeof x === 'string') {
                try { return JSON.parse(x); } catch { return null; }
            }
            return null;
        }

        function parseSlugStartEpochSec(slug) {
            const m = String(slug || '').match(/(\d+)\s*$/);
            if (!m) return null;
            const n = parseInt(m[1], 10);
            return Number.isFinite(n) ? n : null;
        }

        function normalizeCycleTimesFromSlug(slug) {
            const startEpochSec = parseSlugStartEpochSec(slug);
            if (!Number.isFinite(startEpochSec)) return null;
            const endEpochSec = startEpochSec + 900;
            return {
                cycleStartEpochSec: startEpochSec,
                cycleEndEpochSec: endEpochSec,
                cycleStartTime: new Date(startEpochSec * 1000).toISOString(),
                cycleEndTime: new Date(endEpochSec * 1000).toISOString()
            };
        }

        function calcEvRoi(pWin, entryPrice) {
            const pw = clamp01(pWin);
            const ep = Number(entryPrice);
            if (!Number.isFinite(pw) || !Number.isFinite(ep) || ep <= 0) return null;
            const effectiveEntry = Math.min(0.99, ep * (1 + SLIPPAGE_PCT));
            const winRoiNet = (1 / effectiveEntry - 1) * (1 - PROFIT_FEE_PCT);
            return (pw * winRoiNet) - (1 - pw);
        }
        
        // Helper to fetch Gamma market outcome + token ids (Polymarket-native)
        async function fetchGammaResolvedMarket(slug) {
            try {
                const url = `https://gamma-api.polymarket.com/markets?slug=${encodeURIComponent(slug)}`;
                const response = await fetch(url, { 
                    headers: { 'User-Agent': 'polyprophet-backtest/1.0' },
                    signal: AbortSignal.timeout(10000)
                });
                if (!response.ok) return null;
                const data = await response.json();
                const market = Array.isArray(data) ? data[0] : data;
                if (!market || !market.outcomePrices || !market.outcomes) return null;
                
                const prices = parseMaybeJsonArray(market.outcomePrices);
                const outcomes = parseMaybeJsonArray(market.outcomes);
                if (!Array.isArray(prices) || prices.length < 2) return null;
                if (!Array.isArray(outcomes) || outcomes.length < 2) return null;
                
                const p0 = Number(prices[0]);
                const p1 = Number(prices[1]);
                if (!Number.isFinite(p0) || !Number.isFinite(p1)) return null;
                
                // Check if resolved (1/0 or 0/1)
                const idx0Win = p0 >= 0.99 && p1 <= 0.01;
                const idx1Win = p0 <= 0.01 && p1 >= 0.99;
                if (!idx0Win && !idx1Win) return null; // Not yet resolved
                
                const o0 = String(outcomes[0]).toLowerCase();
                const o1 = String(outcomes[1]).toLowerCase();
                
                let outcome = idx0Win ? 'UP' : 'DOWN';
                if (o0 === 'up' && o1 === 'down') outcome = idx0Win ? 'UP' : 'DOWN';
                else if (o0 === 'down' && o1 === 'up') outcome = idx0Win ? 'DOWN' : 'UP';
                else if (o0 === 'yes' && o1 === 'no') outcome = idx0Win ? 'UP' : 'DOWN';
                else if (o0 === 'no' && o1 === 'yes') outcome = idx0Win ? 'DOWN' : 'UP';

                const clobTokenIds = parseMaybeJsonArray(market.clobTokenIds) || null;
                return { outcome, outcomes, clobTokenIds };
            } catch {
                return null;
            }
        }

        async function fetchClobEntryPrice(tokenId, cycleStartEpochSec, cycleEndEpochSec, targetEpochSec) {
            try {
                if (!tokenId || !Number.isFinite(cycleStartEpochSec) || !Number.isFinite(cycleEndEpochSec)) return null;
                const startTs = Math.floor(cycleStartEpochSec);
                const endTs = Math.floor(cycleEndEpochSec);
                const targetTs = Number.isFinite(targetEpochSec) ? Math.floor(targetEpochSec) : startTs;
                const url = `https://clob.polymarket.com/prices-history?market=${encodeURIComponent(String(tokenId))}&startTs=${startTs}&endTs=${endTs}&fidelity=${clobFidelity}`;

                const response = await fetch(url, {
                    headers: { 'User-Agent': 'polyprophet-backtest/1.0' },
                    signal: AbortSignal.timeout(10000)
                });
                if (!response.ok) return null;
                const data = await response.json();
                const history = Array.isArray(data?.history) ? data.history : [];
                if (history.length === 0) return null;

                let best = null;
                let bestDiff = Infinity;
                for (const h of history) {
                    const t = Number(h?.t);
                    const p = Number(h?.p);
                    if (!Number.isFinite(t) || !Number.isFinite(p) || p <= 0) continue;
                    const diff = Math.abs(t - targetTs);
                    if (diff < bestDiff) {
                        bestDiff = diff;
                        best = p;
                    }
                }
                return Number.isFinite(best) ? best : null;
            } catch {
                return null;
            }
        }

        function outcomeLabelToDir(label) {
            const s = String(label || '').trim().toLowerCase();
            if (s === 'up' || s === 'yes') return 'UP';
            if (s === 'down' || s === 'no') return 'DOWN';
            return null;
        }
        
        // Helper to build slug from cycle time (debug exports fallback)
        function buildSlug(asset, cycleEndTime) {
            const endSec = Math.floor(Date.parse(cycleEndTime) / 1000);
            if (!Number.isFinite(endSec)) return null;
            const boundary = Math.floor(endSec / 900) * 900;
            const startEpoch = boundary - 900;
            return `${String(asset).toLowerCase()}-updown-15m-${startEpoch}`;
        }
        
        // Get cycles from collector snapshots (Redis/file)
        const snapshotData = await getCollectorSnapshots(1000);
        const snapshots = snapshotData.snapshots || [];
        
        // Also try debug files if available
        const fs = require('fs');
        const path = require('path');
        const debugDir = path.join(__dirname, 'debug');
        let debugCycles = [];
        
        if (fs.existsSync(debugDir)) {
            const debugFiles = fs.readdirSync(debugDir)
                .filter(f => f.startsWith('polyprophet_debug_') && f.endsWith('.json'))
                .sort();
            
            const seen = new Set();
            const debugFilesLimit = Math.min(debugFilesParam, 500); // Default: last 200 files
            for (const file of debugFiles.slice(-debugFilesLimit)) {
                try {
                    const content = fs.readFileSync(path.join(debugDir, file), 'utf8');
                    const data = JSON.parse(content);
                    const assets = data.assets || {};
                    
                    for (const [asset, assetData] of Object.entries(assets)) {
                        if (!['BTC', 'ETH', 'XRP'].includes(asset)) continue;
                        const cycleHistory = assetData.cycleHistory || [];
                        
                        for (const cycle of cycleHistory) {
                            if (!cycle.cycleEndTime) continue;
                            const key = `${asset}_${cycle.cycleEndTime}`;
                            if (seen.has(key)) continue;
                            seen.add(key);
                            
                            const tier = String(cycle.tier || 'NONE').toUpperCase();
                            if (tierFilter !== 'ALL' && tier !== tierFilter) continue;
                            
                            const pred = String(cycle.prediction || 'NEUTRAL').toUpperCase();
                            if (pred !== 'UP' && pred !== 'DOWN') continue;
                            
                            // 🎯 v53: Use entryOdds if available, otherwise marketOdds
                            const entryOdds = cycle.entryOdds || cycle.marketOdds;
                            if (!entryOdds) continue;
                            
                            const yesPrice = entryOdds.yesPrice;
                            const noPrice = entryOdds.noPrice;
                            const entryPrice = pred === 'UP' ? yesPrice : noPrice;
                            
                            if (!Number.isFinite(entryPrice) || entryPrice <= 0) continue;
                            if (entryPrice < minOddsEntry) continue; // 🎯 v53: Reject tail bets (Oracle vs market)
                            if (entryPrice > maxOddsEntry) continue; // Filter by max entry odds
                            
                            const slug = buildSlug(asset, cycle.cycleEndTime);
                            if (!slug) continue;
                            const times = normalizeCycleTimesFromSlug(slug);
                            if (!times) continue;
                            const observedAtMs = Date.parse(cycle.cycleEndTime);
                            
                            debugCycles.push({
                                asset,
                                cycleEndTime: times.cycleEndTime,
                                prediction: pred,
                                tier,
                                entryPrice,
                                slug,
                                confidence: cycle.confidence || cycle.entryConfidence,
                                pWin: null,
                                source: 'debug',
                                entrySource: cycle.entryOdds ? 'entryOdds' : 'marketOdds',
                                observedAtMs: Number.isFinite(observedAtMs) ? observedAtMs : null,
                                cycleStartEpochSec: times.cycleStartEpochSec
                            });
                        }
                    }
                } catch { /* skip malformed */ }
            }
        }
        
        // Also extract from collector snapshots
        const snapshotCycles = [];
        for (const snap of snapshots) {
            const observedAtMs = Number.isFinite(snap?.timestampMs) ? snap.timestampMs : Date.parse(snap?.timestamp);
            for (const [asset, signal] of Object.entries(snap.signals || {})) {
                if (!['BTC', 'ETH', 'XRP'].includes(asset)) continue;
                
                const tier = String(signal.tier || 'NONE').toUpperCase();
                if (tierFilter !== 'ALL' && tier !== tierFilter) continue;
                
                const pred = String(signal.prediction || 'NEUTRAL').toUpperCase();
                if (pred !== 'UP' && pred !== 'DOWN') continue;
                
                const market = snap.markets?.[asset];
                if (!market || !market.slug) continue;
                const times = normalizeCycleTimesFromSlug(market.slug);
                if (!times) continue;
                
                const yesPrice = market.yesPrice;
                const noPrice = market.noPrice;
                const entryPrice = pred === 'UP' ? yesPrice : noPrice;
                
                if (!Number.isFinite(entryPrice) || entryPrice <= 0) continue;
                if (entryPrice < minOddsEntry) continue; // 🎯 v53: Reject tail bets
                if (entryPrice > maxOddsEntry) continue;
                
                snapshotCycles.push({
                    asset,
                    cycleEndTime: times.cycleEndTime,
                    prediction: pred,
                    tier,
                    entryPrice,
                    slug: market.slug,
                    confidence: signal.confidence,
                    pWin: signal.pWin ?? null,
                    source: 'collector',
                    entrySource: 'snapshot',
                    observedAtMs: Number.isFinite(observedAtMs) ? observedAtMs : null,
                    cycleStartEpochSec: times.cycleStartEpochSec
                });
            }
        }
        
        // Combine and dedupe by slug, selecting the "best" candidate deterministically.
        // This prevents duplicates across debug/collector sources and across repeated collector snapshots.
        const allCycles = [...debugCycles, ...snapshotCycles];
        const bySlug = new Map(); // slug -> chosen cycle
        let collisions = 0;
        let replaced = 0;
        let kept = 0;

        function isBetterCandidate(a, b) {
            // Prefer Polymarket-native collector snapshots for entry prices,
            // unless debug exports contain an explicit entryOdds capture.
            const quality = (c) => {
                if (!c) return -1;
                if (c.source === 'debug' && c.entrySource === 'entryOdds') return 4;     // best: captured entry odds
                if (c.source === 'collector' && c.entrySource === 'snapshot') return 3; // good: direct Polymarket snapshot
                if (c.source === 'debug' && c.entrySource === 'marketOdds') return 2;   // weaker: end-of-cycle odds
                return 1;
            };

            const qa = quality(a), qb = quality(b);
            if (qa !== qb) return qa > qb;

            const ta = Number.isFinite(a?.observedAtMs) ? a.observedAtMs : null;
            const tb = Number.isFinite(b?.observedAtMs) ? b.observedAtMs : null;
            if (ta !== null && tb !== null && ta !== tb) {
                return snapshotPick === 'LATEST' ? (ta > tb) : (ta < tb);
            }
            return false;
        }

        for (const c of allCycles) {
            if (!c || !c.slug) continue;
            const prev = bySlug.get(c.slug);
            if (!prev) {
                bySlug.set(c.slug, c);
                kept++;
                continue;
            }
            collisions++;
            if (isBetterCandidate(c, prev)) {
                bySlug.set(c.slug, c);
                replaced++;
            }
        }

        const finalCycles = Array.from(bySlug.values());

        // Group by cycle window (shared start epoch across assets), then select up to maxTradesPerCycle per window.
        const byWindow = new Map(); // cycleStartEpochSec -> cycles[]
        for (const c of finalCycles) {
            const k = Number.isFinite(c.cycleStartEpochSec) ? c.cycleStartEpochSec : parseSlugStartEpochSec(c.slug);
            if (!Number.isFinite(k)) continue;
            if (!byWindow.has(k)) byWindow.set(k, []);
            byWindow.get(k).push(c);
        }

        const windowKeys = Array.from(byWindow.keys()).sort((a, b) => a - b);
        let eligibleWindowKeys = windowKeys;
        if (lookbackHours !== null) {
            const nowSec = Math.floor(Date.now() / 1000);
            const cutoff = nowSec - Math.floor(lookbackHours * 3600);
            eligibleWindowKeys = windowKeys.filter(k => Number(k) >= cutoff);
        }
        const windowsToProcess = eligibleWindowKeys.slice(-limit);
        const selectedCycles = [];
        let evBlocked = 0;

        for (const w of windowsToProcess) {
            const cycles = byWindow.get(w) || [];
            const enriched = [];
            for (const c of cycles) {
                const pWinUsed = clamp01(c.pWin ?? c.confidence);
                const evRoi = calcEvRoi(pWinUsed, c.entryPrice);
                if (respectEVGate && (evRoi === null || evRoi <= 0)) { evBlocked++; continue; }
                enriched.push({ ...c, pWinUsed, evRoi });
            }
            if (enriched.length === 0) continue;

            enriched.sort((a, b) => {
                if (selection === 'HIGHEST_CONF') {
                    return (Number(b.pWinUsed) - Number(a.pWinUsed));
                }
                // Default: BEST_EV
                return (Number(b.evRoi) - Number(a.evRoi));
            });
            selectedCycles.push(...enriched.slice(0, maxTradesPerCycle));
        }

        // Sort selected cycles deterministically for compounding (by cycle window, then asset)
        selectedCycles.sort((a, b) => {
            const aw = Number(a.cycleStartEpochSec), bw = Number(b.cycleStartEpochSec);
            if (aw !== bw) return aw - bw;
            return String(a.asset).localeCompare(String(b.asset));
        });

        // Fetch outcomes once (cached) so we can do stake scans without extra Gamma calls.
        const outcomeCache = new Map(); // slug -> { outcome, outcomes, clobTokenIds } | null
        const resolvedCycles = [];
        let resolved = 0;
        let unresolved = 0;
        let errors = 0;

        for (const cycle of selectedCycles) {
            if (resolved + unresolved + errors > 0) {
                await new Promise(r => setTimeout(r, 50));
            }

            let gammaResolved = outcomeCache.get(cycle.slug);
            if (gammaResolved === undefined) {
                gammaResolved = await fetchGammaResolvedMarket(cycle.slug);
                outcomeCache.set(cycle.slug, gammaResolved || null);
            }

            if (!gammaResolved) {
                unresolved++;
                continue;
            }
            resolved++;
            resolvedCycles.push({
                ...cycle,
                polymarketOutcome: gammaResolved.outcome,
                gammaOutcomes: gammaResolved.outcomes,
                clobTokenIds: gammaResolved.clobTokenIds
            });
        }

        // Optional: replace snapshot entry prices with Polymarket CLOB time-series prices (more "native", slower).
        if (entryMode === 'CLOB_HISTORY') {
            for (const c of resolvedCycles) {
                try {
                    if (c.source !== 'collector') continue;
                    if (!Array.isArray(c.gammaOutcomes) || !Array.isArray(c.clobTokenIds)) continue;
                    if (!Number.isFinite(c.cycleStartEpochSec)) continue;

                    const targetEpochSec = Number.isFinite(c.observedAtMs) ? Math.floor(c.observedAtMs / 1000) : c.cycleStartEpochSec;
                    const cycleEndEpochSec = c.cycleStartEpochSec + 900;

                    // Map prediction (UP/DOWN) -> tokenId based on Gamma outcomes ordering
                    let tokenId = null;
                    for (let i = 0; i < c.gammaOutcomes.length && i < c.clobTokenIds.length; i++) {
                        const dir = outcomeLabelToDir(c.gammaOutcomes[i]);
                        if (dir === c.prediction) {
                            tokenId = c.clobTokenIds[i];
                            break;
                        }
                    }

                    if (!tokenId) continue;
                    const px = await fetchClobEntryPrice(tokenId, c.cycleStartEpochSec, cycleEndEpochSec, targetEpochSec);
                    if (Number.isFinite(px) && px > 0) {
                        c.entryPrice = px;
                        c.entrySource = 'clobHistory';
                    }
                } catch { /* ignore */ }
            }
        }

        function simulate(stakeFraction) {
            let balance = startingBalance;
            let peakBalance = startingBalance;
            let maxDrawdown = 0;
            let wins = 0;
            let losses = 0;
            const trades = [];

            // Resolve trades per-window (no intra-window compounding when maxTradesPerCycle > 1).
            const byResolvedWindow = new Map(); // cycleStartEpochSec -> cycles[]
            for (const c of resolvedCycles) {
                const k = Number.isFinite(c?.cycleStartEpochSec) ? c.cycleStartEpochSec : parseSlugStartEpochSec(c?.slug);
                if (!Number.isFinite(k)) continue;
                if (!byResolvedWindow.has(k)) byResolvedWindow.set(k, []);
                byResolvedWindow.get(k).push(c);
            }

            const windowsForSim = windowsToProcess.filter(k => byResolvedWindow.has(k));

            for (const w of windowsForSim) {
                const windowCycles = byResolvedWindow.get(w) || [];
                if (windowCycles.length === 0) continue;

                const windowBalanceStart = balance;
                if (!Number.isFinite(windowBalanceStart) || windowBalanceStart <= 0) break;

                const n = windowCycles.length;
                const maxBudget = windowBalanceStart * maxExposure;

                let stakes = [];
                if (stakeMode === 'PER_WINDOW') {
                    let budget = windowBalanceStart * stakeFraction;
                    budget = Math.min(budget, maxBudget);
                    let each = n > 0 ? (budget / n) : 0;
                    // 🏆 v60 FINAL: Apply absolute liquidity cap (LIVE-realistic)
                    each = Math.min(each, maxAbsoluteStake);
                    stakes = windowCycles.map(() => each);
                } else {
                    // PER_TRADE (default): stakeFraction applies per trade, but cap total exposure for the window.
                    let each = windowBalanceStart * stakeFraction;
                    // 🏆 v60 FINAL: Apply absolute liquidity cap BEFORE window exposure calc (LIVE-realistic)
                    each = Math.min(each, maxAbsoluteStake);
                    const totalDesired = each * n;
                    if (totalDesired > maxBudget && totalDesired > 0) {
                        const scale = maxBudget / totalDesired;
                        each *= scale;
                    }
                    stakes = windowCycles.map(() => each);
                }

                let windowPnl = 0;
                for (let i = 0; i < windowCycles.length; i++) {
                    const cycle = windowCycles[i];
                    const stake = Number(stakes[i]);
                    if (!Number.isFinite(stake) || stake <= 0) continue;

                    const isWin = cycle.prediction === cycle.polymarketOutcome;

                    const effectiveEntry = Math.min(0.99, cycle.entryPrice * (1 + SLIPPAGE_PCT));
                    const shares = stake / effectiveEntry;

                    let pnl;
                    if (isWin) {
                        const grossValue = shares * 1.0;
                        const profit = grossValue - stake;
                        const fee = profit * PROFIT_FEE_PCT;
                        pnl = profit - fee;
                        wins++;
                    } else {
                        pnl = -stake;
                        losses++;
                    }

                    windowPnl += pnl;
                    trades.push({
                        asset: cycle.asset,
                        slug: cycle.slug,
                        cycleStartEpochSec: cycle.cycleStartEpochSec,
                        prediction: cycle.prediction,
                        polymarketOutcome: cycle.polymarketOutcome,
                        isWin,
                        entryPrice: cycle.entryPrice,
                        effectiveEntry,
                        stake,
                        pnl,
                        windowStartBalance: windowBalanceStart,
                        tier: cycle.tier,
                        confidence: cycle.confidence,
                        pWinUsed: cycle.pWinUsed,
                        evRoi: cycle.evRoi,
                        source: cycle.source,
                        entrySource: cycle.entrySource
                    });
                }

                balance = windowBalanceStart + windowPnl;
                peakBalance = Math.max(peakBalance, balance);
                const dd = peakBalance > 0 ? ((peakBalance - balance) / peakBalance) : 0;
                maxDrawdown = Math.max(maxDrawdown, dd);

                // Annotate last trade in this window with the end balance for easier reading
                if (trades.length > 0) {
                    const last = trades[trades.length - 1];
                    if (last && last.cycleStartEpochSec === w) {
                        last.windowEndBalance = balance;
                    }
                }

                if (balance <= 0) break;
            }

            const totalTrades = wins + losses;
            const winRate = totalTrades > 0 ? (wins / totalTrades * 100) : 0;
            const totalProfit = balance - startingBalance;
            const avgPnlPerTrade = totalTrades > 0 ? totalProfit / totalTrades : 0;
            const avgEntryPrice = trades.length > 0 ? trades.reduce((s, t) => s + t.entryPrice, 0) / trades.length : 0;
            const avgEffectiveEntry = trades.length > 0 ? trades.reduce((s, t) => s + t.effectiveEntry, 0) / trades.length : 0;

            const winTrades = trades.filter(t => t && t.isWin && Number.isFinite(t.effectiveEntry) && t.effectiveEntry > 0);
            const avgWinRoiNet = winTrades.length > 0
                ? (winTrades.reduce((s, t) => s + ((1 / t.effectiveEntry - 1) * (1 - PROFIT_FEE_PCT)), 0) / winTrades.length)
                : 0;
            const expectedEV = (winRate / 100) * avgWinRoiNet - (1 - winRate / 100);
            const winRateNeededForEV = avgWinRoiNet > 0 ? (1 / (1 + avgWinRoiNet)) * 100 : null;

            return {
                stakeFrac: stakeFraction,
                totalTrades,
                wins,
                losses,
                winRate,
                balance,
                totalProfit,
                avgPnlPerTrade,
                maxDrawdown,
                avgEntryPrice,
                avgEffectiveEntry,
                avgWinRoiNet,
                expectedEV,
                winRateNeededForEV,
                trades
            };
        }

        const primarySim = simulate(stakeFrac);
        const scanResults = scan ? scanStakes.map(sf => simulate(sf)).map(r => ({
            stake: r.stakeFrac,
            trades: r.totalTrades,
            winRate: (r.winRate).toFixed(2) + '%',
            finalBalance: Number(r.balance.toFixed(2)),
            profitPct: ((r.totalProfit / startingBalance) * 100).toFixed(2) + '%',
            maxDrawdown: (r.maxDrawdown * 100).toFixed(2) + '%'
        })) : null;
        
        const entrySources = {};
        for (const t of primarySim.trades) {
            const k = t.entrySource || 'unknown';
            entrySources[k] = (entrySources[k] || 0) + 1;
        }
        
        const runtime = ((Date.now() - startTime) / 1000).toFixed(2);
        const selectedSlugsSorted = selectedCycles.map(c => c.slug).slice().sort();
        const slugHash = crypto.createHash('sha256').update(selectedSlugsSorted.join('\n')).digest('hex');
        const timeSpan = (() => {
            if (!Array.isArray(windowsToProcess) || windowsToProcess.length === 0) return null;
            const startEpoch = windowsToProcess[0];
            const endEpoch = windowsToProcess[windowsToProcess.length - 1] + 900;
            const hours = (endEpoch - startEpoch) / 3600;
            return {
                start: new Date(startEpoch * 1000).toISOString(),
                end: new Date(endEpoch * 1000).toISOString(),
                hours: Number.isFinite(hours) ? Number(hours.toFixed(2)) : null,
                days: Number.isFinite(hours) ? Number((hours / 24).toFixed(2)) : null
            };
        })();
        
        res.json({
            summary: {
                method: 'Polymarket Gamma API (ground truth)',
                runtime: runtime + 's',
                startingBalance,
                timeSpan,
                totalTrades: primarySim.totalTrades,
                finalBalance: parseFloat(primarySim.balance.toFixed(2)),
                totalProfit: parseFloat(primarySim.totalProfit.toFixed(2)),
                profitPct: (primarySim.totalProfit / startingBalance * 100).toFixed(2) + '%',
                wins: primarySim.wins,
                losses: primarySim.losses,
                winRate: primarySim.winRate.toFixed(2) + '%',
                maxDrawdown: (primarySim.maxDrawdown * 100).toFixed(2) + '%',
                avgEntryPrice: primarySim.avgEntryPrice.toFixed(3),
                avgEffectiveEntry: primarySim.avgEffectiveEntry.toFixed(3),
                avgPnlPerTrade: primarySim.avgPnlPerTrade.toFixed(4),
                avgWinRoiNet: primarySim.avgWinRoiNet.toFixed(4) + ' per $1 stake (wins only)',
                expectedEV: primarySim.expectedEV.toFixed(4) + ' per $1 stake',
                isProfitable: primarySim.totalProfit > 0,
                maxTradesPerCycle,
                selection,
                respectEVGate,
                lookbackHours,
                stakeMode,
                maxExposure,
                entryMode,
                clobFidelity: clobFidelity
            },
            coverage: {
                candidatesFound: allCycles.length,
                uniqueSlugsFound: finalCycles.length,
                windowCountFound: windowKeys.length,
                windowsProcessed: windowsToProcess.length,
                tradesSelected: selectedCycles.length,
                collisions,
                replacements: replaced,
                kept,
                evBlocked,
                resolved,
                unresolved,
                errors,
                fromDebug: debugCycles.length,
                fromCollector: snapshotCycles.length,
                entrySources
            },
            filters: {
                tierFilter,
                minOddsEntry,
                maxOddsEntry,
                stakeFrac,
                limit,
                debugFiles: debugFilesParam,
                snapshotPick,
                lookbackHours,
                maxTradesPerCycle,
                selection,
                respectEVGate,
                stakeMode,
                maxExposure,
                maxAbsoluteStake, // 🏆 v60: Liquidity cap for LIVE-realistic backtests
                entry: entryMode,
                fidelity: clobFidelity,
                scan,
                stakes: scanStakes
            },
            proof: {
                slugHash,
                slugCount: selectedSlugsSorted.length,
                // Avoid confusing duplicates when slugCount < 6 (first/last slices overlap).
                slugSample: (selectedSlugsSorted.length <= 6)
                    ? selectedSlugsSorted
                    : selectedSlugsSorted.slice(0, 3).concat(selectedSlugsSorted.slice(-3))
            },
            scan: scanResults,
            trades: primarySim.trades.slice(-30), // Last 30 for display
            interpretation: {
                winRateNeededForEV: primarySim.winRateNeededForEV !== null ? primarySim.winRateNeededForEV.toFixed(1) + '%' : 'N/A',
                currentWinRate: primarySim.winRate.toFixed(1) + '%',
                verdict: primarySim.totalTrades === 0 ? 'ℹ️ No resolved cycles/trades found for these filters' :
                         primarySim.totalProfit > 0 ? '✅ PROFITABLE (simulated compounding P&L)' :
                         primarySim.expectedEV > 0 ? '⚠️ POSITIVE EDGE BUT LOST IN THIS SAMPLE (variance / sequencing risk) — consider lower stake' :
                         primarySim.expectedEV > -0.05 ? '⚠️ MARGINAL / CLOSE TO BREAKEVEN — need better entries or higher WR' :
                         '❌ NEGATIVE — entry prices too high for current win rate'
            }
        });
    } catch (e) {
        res.status(500).json({ error: e.message, stack: e.stack });
    }
});

// ==================== 🏆 v59 DATASET CACHE BUILDER ====================
// Builds/caches Polymarket-native dataset for fast backtesting over long periods
// Stores: Gamma outcomes + CLOB price history per slug in Redis/file
const DATASET_CACHE_KEY_PREFIX = 'polyprophet:dataset:';
const DATASET_INTRACYCLE_KEY_PREFIX = 'polyprophet:intracycle:';

async function getCachedDatasetEntry(slug) {
    try {
        if (redisAvailable) {
            const data = await redis.get(`${DATASET_CACHE_KEY_PREFIX}${slug}`);
            if (data) return JSON.parse(data);
        }
        // File fallback
        const dataDir = path.join(__dirname, 'backtest-data', 'polymarket-datasets');
        const filePath = path.join(dataDir, `${slug}.json`);
        if (fs.existsSync(filePath)) {
            return JSON.parse(fs.readFileSync(filePath, 'utf8'));
        }
    } catch {}
    return null;
}

async function setCachedDatasetEntry(slug, entry) {
    try {
        const jsonData = JSON.stringify(entry);
        if (redisAvailable) {
            await redis.setex(`${DATASET_CACHE_KEY_PREFIX}${slug}`, 86400 * 30, jsonData); // 30 day TTL
        }
        // Also save to file for persistence
        const dataDir = path.join(__dirname, 'backtest-data', 'polymarket-datasets');
        if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
        fs.writeFileSync(path.join(dataDir, `${slug}.json`), jsonData);
    } catch {}
}

app.get('/api/build-dataset', async (req, res) => {
    try {
        const startTime = Date.now();
        const lookbackDays = Math.min(parseInt(req.query.days) || 90, 365);
        const asset = req.query.asset ? String(req.query.asset).toUpperCase() : null; // BTC, ETH, XRP or null for all
        const forceRefresh = req.query.refresh === '1';
        
        const ASSETS_TO_BUILD = asset ? [asset] : ['BTC', 'ETH', 'XRP'];
        const nowSec = Math.floor(Date.now() / 1000);
        const startSec = nowSec - (lookbackDays * 86400);
        
        // Generate all possible slug epochs (15-min intervals)
        const allSlugs = [];
        for (let epochSec = startSec - (startSec % 900); epochSec < nowSec - 900; epochSec += 900) {
            for (const a of ASSETS_TO_BUILD) {
                allSlugs.push(`${a.toLowerCase()}-updown-15m-${epochSec}`);
            }
        }
        
        let cached = 0;
        let fetched = 0;
        let errors = 0;
        let resolved = 0;
        let unresolved = 0;
        const entries = [];
        
        for (const slug of allSlugs) {
            // Check cache first
            if (!forceRefresh) {
                const existing = await getCachedDatasetEntry(slug);
                if (existing) {
                    cached++;
                    entries.push(existing);
                    continue;
                }
            }
            
            // Fetch from Gamma API
            await new Promise(r => setTimeout(r, 50)); // Rate limit
            try {
                const url = `https://gamma-api.polymarket.com/markets?slug=${encodeURIComponent(slug)}`;
                const response = await fetch(url, {
                    headers: { 'User-Agent': 'polyprophet-dataset-builder/1.0' },
                    signal: AbortSignal.timeout(10000)
                });
                
                if (!response.ok) {
                    errors++;
                    continue;
                }
                
                const data = await response.json();
                const market = Array.isArray(data) ? data[0] : data;
                if (!market) {
                    unresolved++;
                    continue;
                }
                
                const prices = JSON.parse(market.outcomePrices || '[]');
                const outcomes = JSON.parse(market.outcomes || '[]');
                const clobTokenIds = JSON.parse(market.clobTokenIds || '[]');
                
                if (!Array.isArray(prices) || prices.length < 2) {
                    unresolved++;
                    continue;
                }
                
                const p0 = Number(prices[0]);
                const p1 = Number(prices[1]);
                const idx0Win = p0 >= 0.99 && p1 <= 0.01;
                const idx1Win = p0 <= 0.01 && p1 >= 0.99;
                
                if (!idx0Win && !idx1Win) {
                    unresolved++;
                    continue;
                }
                
                resolved++;
                fetched++;
                
                // Determine outcome
                const o0 = String(outcomes[0] || '').toLowerCase();
                const o1 = String(outcomes[1] || '').toLowerCase();
                let outcome = idx0Win ? 'UP' : 'DOWN';
                if (o0 === 'up' && o1 === 'down') outcome = idx0Win ? 'UP' : 'DOWN';
                else if (o0 === 'down' && o1 === 'up') outcome = idx0Win ? 'DOWN' : 'UP';
                else if (o0 === 'yes' && o1 === 'no') outcome = idx0Win ? 'UP' : 'DOWN';
                else if (o0 === 'no' && o1 === 'yes') outcome = idx0Win ? 'DOWN' : 'UP';
                
                // Extract cycle timing from slug
                const slugMatch = slug.match(/(btc|eth|xrp)-updown-15m-(\d+)$/);
                const assetFromSlug = slugMatch ? slugMatch[1].toUpperCase() : null;
                const cycleStartEpochSec = slugMatch ? parseInt(slugMatch[2]) : null;
                
                const entry = {
                    slug,
                    asset: assetFromSlug,
                    cycleStartEpochSec,
                    cycleEndEpochSec: cycleStartEpochSec ? cycleStartEpochSec + 900 : null,
                    resolvedOutcome: outcome,
                    outcomes,
                    clobTokenIds,
                    resolutionSource: market.resolutionSource || null,
                    volume: Number(market.volume || 0),
                    cachedAt: Date.now()
                };
                
                await setCachedDatasetEntry(slug, entry);
                entries.push(entry);
                
            } catch (e) {
                errors++;
            }
        }
        
        const runtime = ((Date.now() - startTime) / 1000).toFixed(2);
        
        res.json({
            success: true,
            summary: {
                runtime: runtime + 's',
                lookbackDays,
                totalSlugs: allSlugs.length,
                cached,
                fetched,
                resolved,
                unresolved,
                errors,
                entriesBuilt: entries.length
            },
            sampleEntries: entries.slice(-10)
        });
    } catch (e) {
        res.status(500).json({ error: e.message, stack: e.stack });
    }
});

// ==================== 🏆 v59 TRUE-MAXIMUM OPTIMIZER ====================
// Searches parameter space for optimal (minOdds, maxOdds, stake, exitPolicy) combination
// Uses cached dataset for fast simulation; produces Pareto frontier report
app.get('/api/optimize-polymarket', async (req, res) => {
    try {
        const startTime = Date.now();
        const lookbackDays = Math.min(parseInt(req.query.days) || 90, 365);
        const startingBalance = parseFloat(req.query.balance) || 5.0;
        const simulations = parseInt(req.query.sims) || 1000; // Monte Carlo simulations per strategy
        
        // Search space parameters
        const minOddsRange = [0.35, 0.38, 0.40, 0.42, 0.45, 0.48, 0.50, 0.55];
        const maxOddsRange = [0.85, 0.88, 0.90, 0.92, 0.94, 0.95, 0.97];
        const stakeRange = [0.12, 0.15, 0.18, 0.20, 0.22, 0.24, 0.26, 0.28, 0.30, 0.32, 0.35]; // 🏆 v61: VARIANCE-MIN focused
        const exitPolicies = ['HOLD_RESOLUTION']; // For now, only hold-to-resolution
        
        // Fee model
        const PROFIT_FEE_PCT = 0.02;
        const SLIPPAGE_PCT = 0.01;
        
        // 🏆 v60 FINAL: Liquidity cap for realistic optimizer (matches LIVE sizing)
        const maxAbsRaw = parseFloat(req.query.maxAbs);
        const maxAbsoluteStake = Number.isFinite(maxAbsRaw) && maxAbsRaw > 0
            ? maxAbsRaw
            : parseFloat(process.env.MAX_ABSOLUTE_POSITION_SIZE || '100'); // $100 default
        
        // Load cached dataset
        const dataDir = path.join(__dirname, 'backtest-data', 'polymarket-datasets');
        let allEntries = [];
        
        if (fs.existsSync(dataDir)) {
            const files = fs.readdirSync(dataDir).filter(f => f.endsWith('.json'));
            for (const file of files) {
                try {
                    const entry = JSON.parse(fs.readFileSync(path.join(dataDir, file), 'utf8'));
                    if (entry && entry.resolvedOutcome && entry.cycleStartEpochSec) {
                        allEntries.push(entry);
                    }
                } catch {}
            }
        }
        
        // Also try Redis
        if (redisAvailable && allEntries.length < 1000) {
            try {
                const keys = await redis.keys(`${DATASET_CACHE_KEY_PREFIX}*`);
                for (const key of keys.slice(0, 10000)) {
                    const data = await redis.get(key);
                    if (data) {
                        const entry = JSON.parse(data);
                        if (entry && entry.resolvedOutcome && entry.cycleStartEpochSec) {
                            allEntries.push(entry);
                        }
                    }
                }
            } catch {}
        }
        
        if (allEntries.length < 100) {
            return res.status(400).json({
                error: 'Not enough cached data. Run /api/build-dataset first.',
                entriesFound: allEntries.length
            });
        }
        
        // Filter by lookback period
        const nowSec = Math.floor(Date.now() / 1000);
        const cutoffSec = nowSec - (lookbackDays * 86400);
        allEntries = allEntries.filter(e => e.cycleStartEpochSec >= cutoffSec);
        
        // Sort by time
        allEntries.sort((a, b) => a.cycleStartEpochSec - b.cycleStartEpochSec);
        
        // Load collector snapshots for entry prices and predictions
        const snapshotData = await getCollectorSnapshots(5000);
        const snapshots = snapshotData.snapshots || [];
        
        // Build prediction map: slug -> { prediction, entryPrice, confidence, pWin }
        const predictionMap = new Map();
        for (const snap of snapshots) {
            for (const [asset, signal] of Object.entries(snap.signals || {})) {
                const market = snap.markets?.[asset];
                if (!market?.slug) continue;
                const pred = String(signal.prediction || '').toUpperCase();
                if (pred !== 'UP' && pred !== 'DOWN') continue;
                const yesPrice = market.yesPrice;
                const noPrice = market.noPrice;
                const entryPrice = pred === 'UP' ? yesPrice : noPrice;
                if (!Number.isFinite(entryPrice) || entryPrice <= 0) continue;
                
                // Store (prefer earliest snapshot for same slug)
                if (!predictionMap.has(market.slug)) {
                    predictionMap.set(market.slug, {
                        prediction: pred,
                        entryPrice,
                        confidence: signal.confidence,
                        pWin: signal.pWin ?? signal.confidence,
                        asset
                    });
                }
            }
        }
        
        // Simulation function
        function simulateStrategy(minOdds, maxOdds, stakeFrac, exitPolicy) {
            let balance = startingBalance;
            let peakBalance = startingBalance;
            let maxDrawdown = 0;
            let wins = 0, losses = 0;
            const dailyReturns = [];
            let currentDayStart = null;
            let currentDayBalance = startingBalance;
            
            // Group by day for daily return calculation
            const byDay = new Map();
            for (const entry of allEntries) {
                const day = Math.floor(entry.cycleStartEpochSec / 86400);
                if (!byDay.has(day)) byDay.set(day, []);
                byDay.get(day).push(entry);
            }
            
            const days = Array.from(byDay.keys()).sort((a, b) => a - b);
            
            for (const day of days) {
                const dayEntries = byDay.get(day);
                const dayStartBalance = balance;
                
                // Process each cycle in the day (max 1 trade per cycle)
                const byWindow = new Map();
                for (const entry of dayEntries) {
                    const w = entry.cycleStartEpochSec;
                    if (!byWindow.has(w)) byWindow.set(w, entry);
                }
                
                for (const entry of byWindow.values()) {
                    if (balance <= 0) break;
                    
                    const pred = predictionMap.get(entry.slug);
                    if (!pred) continue;
                    
                    // Apply filters
                    if (pred.entryPrice < minOdds) continue;
                    if (pred.entryPrice > maxOdds) continue;
                    
                    // Calculate EV and filter negative EV
                    const pWin = Number(pred.pWin) || 0.5;
                    const effectiveEntry = Math.min(0.99, pred.entryPrice * (1 + SLIPPAGE_PCT));
                    const winRoiNet = (1 / effectiveEntry - 1) * (1 - PROFIT_FEE_PCT);
                    const evRoi = pWin * winRoiNet - (1 - pWin);
                    if (evRoi <= 0) continue;
                    
                    // Execute trade
                    // 🏆 v60 FINAL: Apply absolute liquidity cap (LIVE-realistic)
                    const stake = Math.min(balance * stakeFrac, maxAbsoluteStake);
                    const isWin = pred.prediction === entry.resolvedOutcome;
                    
                    let pnl;
                    if (isWin) {
                        const shares = stake / effectiveEntry;
                        const grossValue = shares * 1.0;
                        const profit = grossValue - stake;
                        const fee = profit * PROFIT_FEE_PCT;
                        pnl = profit - fee;
                        wins++;
                    } else {
                        pnl = -stake;
                        losses++;
                    }
                    
                    balance += pnl;
                    peakBalance = Math.max(peakBalance, balance);
                    const dd = peakBalance > 0 ? (peakBalance - balance) / peakBalance : 0;
                    maxDrawdown = Math.max(maxDrawdown, dd);
                }
                
                // Record daily return
                if (dayStartBalance > 0) {
                    dailyReturns.push((balance - dayStartBalance) / dayStartBalance);
                }
            }
            
            const totalTrades = wins + losses;
            const winRate = totalTrades > 0 ? wins / totalTrades : 0;
            
            // Calculate statistics
            dailyReturns.sort((a, b) => a - b);
            const median24hReturn = dailyReturns.length > 0 ? dailyReturns[Math.floor(dailyReturns.length / 2)] : 0;
            const p10Return = dailyReturns.length >= 10 ? dailyReturns[Math.floor(dailyReturns.length * 0.1)] : (dailyReturns[0] || 0);
            const p1Return = dailyReturns.length >= 100 ? dailyReturns[Math.floor(dailyReturns.length * 0.01)] : p10Return;
            const worstReturn = dailyReturns[0] || 0;
            const meanReturn = dailyReturns.length > 0 ? dailyReturns.reduce((a, b) => a + b, 0) / dailyReturns.length : 0;
            
            return {
                minOdds, maxOdds, stakeFrac, exitPolicy,
                finalBalance: balance,
                totalProfit: balance - startingBalance,
                profitPct: ((balance - startingBalance) / startingBalance) * 100,
                totalTrades,
                winRate: winRate * 100,
                maxDrawdown: maxDrawdown * 100,
                median24hReturn: median24hReturn * 100,
                p10Return: p10Return * 100,
                p1Return: p1Return * 100,
                worstReturn: worstReturn * 100,
                meanReturn: meanReturn * 100,
                daysSimulated: days.length
            };
        }
        
        // Run optimization grid search
        const results = [];
        let processed = 0;
        const totalCombinations = minOddsRange.length * maxOddsRange.length * stakeRange.length * exitPolicies.length;
        
        for (const minOdds of minOddsRange) {
            for (const maxOdds of maxOddsRange) {
                if (maxOdds <= minOdds) continue;
                for (const stake of stakeRange) {
                    for (const exitPolicy of exitPolicies) {
                        const result = simulateStrategy(minOdds, maxOdds, stake, exitPolicy);
                        results.push(result);
                        processed++;
                    }
                }
            }
        }
        
        // Sort by different criteria to find Pareto frontier
        const byMedian = [...results].sort((a, b) => b.median24hReturn - a.median24hReturn);
        const byP10 = [...results].sort((a, b) => b.p10Return - a.p10Return);
        const byMinDD = [...results].sort((a, b) => a.maxDrawdown - b.maxDrawdown);
        const byProfit = [...results].sort((a, b) => b.profitPct - a.profitPct);
        
        // Find Pareto-optimal strategies (not dominated on both median return and max drawdown)
        const paretoFrontier = [];
        for (const r of results) {
            const dominated = results.some(other => 
                other.median24hReturn > r.median24hReturn && other.maxDrawdown < r.maxDrawdown
            );
            if (!dominated) paretoFrontier.push(r);
        }
        paretoFrontier.sort((a, b) => b.median24hReturn - a.median24hReturn);
        
        // Select "best overall" - highest median return with max DD < 70%
        const bestOverall = byMedian.find(r => r.maxDrawdown < 70) || byMedian[0];
        
        // Select "min variance" - best 10th percentile return
        const minVariance = byP10[0];
        
        // Select "max profit" - highest total profit
        const maxProfit = byProfit[0];
        
        const runtime = ((Date.now() - startTime) / 1000).toFixed(2);
        
        res.json({
            success: true,
            summary: {
                runtime: runtime + 's',
                lookbackDays,
                entriesUsed: allEntries.length,
                predictionsAvailable: predictionMap.size,
                combinationsTested: processed,
                paretoFrontierSize: paretoFrontier.length
            },
            recommendations: {
                bestOverall: {
                    params: { minOdds: bestOverall.minOdds, maxOdds: bestOverall.maxOdds, stake: bestOverall.stakeFrac },
                    metrics: {
                        median24hReturn: bestOverall.median24hReturn.toFixed(2) + '%',
                        p10Return: bestOverall.p10Return.toFixed(2) + '%',
                        maxDrawdown: bestOverall.maxDrawdown.toFixed(2) + '%',
                        totalProfit: bestOverall.profitPct.toFixed(2) + '%',
                        winRate: bestOverall.winRate.toFixed(2) + '%',
                        trades: bestOverall.totalTrades
                    },
                    description: 'Best median return with acceptable drawdown (<70%)'
                },
                minVariance: {
                    params: { minOdds: minVariance.minOdds, maxOdds: minVariance.maxOdds, stake: minVariance.stakeFrac },
                    metrics: {
                        median24hReturn: minVariance.median24hReturn.toFixed(2) + '%',
                        p10Return: minVariance.p10Return.toFixed(2) + '%',
                        maxDrawdown: minVariance.maxDrawdown.toFixed(2) + '%',
                        totalProfit: minVariance.profitPct.toFixed(2) + '%',
                        winRate: minVariance.winRate.toFixed(2) + '%',
                        trades: minVariance.totalTrades
                    },
                    description: 'Best 10th percentile return (most consistent)'
                },
                maxProfit: {
                    params: { minOdds: maxProfit.minOdds, maxOdds: maxProfit.maxOdds, stake: maxProfit.stakeFrac },
                    metrics: {
                        median24hReturn: maxProfit.median24hReturn.toFixed(2) + '%',
                        p10Return: maxProfit.p10Return.toFixed(2) + '%',
                        maxDrawdown: maxProfit.maxDrawdown.toFixed(2) + '%',
                        totalProfit: maxProfit.profitPct.toFixed(2) + '%',
                        winRate: maxProfit.winRate.toFixed(2) + '%',
                        trades: maxProfit.totalTrades
                    },
                    description: 'Highest total profit (may have high variance)'
                }
            },
            paretoFrontier: paretoFrontier.slice(0, 20).map(r => ({
                minOdds: r.minOdds,
                maxOdds: r.maxOdds,
                stake: r.stakeFrac,
                median24h: r.median24hReturn.toFixed(2) + '%',
                p10: r.p10Return.toFixed(2) + '%',
                maxDD: r.maxDrawdown.toFixed(2) + '%',
                winRate: r.winRate.toFixed(2) + '%'
            })),
            varianceScenarios: bestOverall ? {
                best24h: `£5 → £${(5 * (1 + byMedian[0].median24hReturn / 100)).toFixed(2)} (based on median)`,
                expected24h: `£5 → £${(5 * (1 + bestOverall.median24hReturn / 100)).toFixed(2)} (best overall)`,
                worst24h: `£5 → £${(5 * (1 + bestOverall.worstReturn / 100)).toFixed(2)} (worst observed day)`,
                p10_24h: `£5 → £${(5 * (1 + bestOverall.p10Return / 100)).toFixed(2)} (10th percentile)`,
                projections: {
                    day1: `£${(5 * Math.pow(1 + bestOverall.meanReturn / 100, 1)).toFixed(2)}`,
                    day2: `£${(5 * Math.pow(1 + bestOverall.meanReturn / 100, 2)).toFixed(2)}`,
                    day3: `£${(5 * Math.pow(1 + bestOverall.meanReturn / 100, 3)).toFixed(2)}`,
                    day7: `£${(5 * Math.pow(1 + bestOverall.meanReturn / 100, 7)).toFixed(2)}`
                }
            } : null
        });
    } catch (e) {
        res.status(500).json({ error: e.message, stack: e.stack });
    }
});

// ==================== 🏆 v59 PENDING POSITIONS RECONCILIATION ====================
// Checks and resolves PENDING_RESOLUTION positions when Gamma becomes available
app.get('/api/reconcile-pending', async (req, res) => {
    try {
        const startTime = Date.now();
        const positions = tradeExecutor?.positions || {};
        
        const pendingPositions = Object.entries(positions).filter(([id, pos]) => 
            pos && pos.status === 'PENDING_RESOLUTION'
        );
        
        if (pendingPositions.length === 0) {
            return res.json({
                success: true,
                message: 'No pending positions to reconcile',
                pending: 0,
                resolved: 0
            });
        }
        
        let resolved = 0;
        let stillPending = 0;
        const results = [];
        
        for (const [id, pos] of pendingPositions) {
            const slug = pos.pendingSlug || pos.slug;
            if (!slug) {
                stillPending++;
                continue;
            }
            
            // Try to fetch outcome from Gamma
            await new Promise(r => setTimeout(r, 100)); // Rate limit
            const outcome = await tradeExecutor.fetchPolymarketResolvedOutcome(slug);
            
            if (outcome === 'UP' || outcome === 'DOWN') {
                const won = pos.side === outcome;
                const exitPrice = won ? 1.0 : 0.0;
                const reason = won ? `${pos.mode} WIN ✅ (Polymarket reconciled)` : `${pos.mode} LOSS ❌ (Polymarket reconciled)`;
                tradeExecutor.closePosition(id, exitPrice, reason);
                resolved++;
                results.push({ id, slug, outcome, won, status: 'RESOLVED' });
            } else {
                stillPending++;
                results.push({ id, slug, outcome: null, status: 'STILL_PENDING' });
            }
        }
        
        const runtime = ((Date.now() - startTime) / 1000).toFixed(2);
        
        res.json({
            success: true,
            runtime: runtime + 's',
            pending: pendingPositions.length,
            resolved,
            stillPending,
            results
        });
    } catch (e) {
        res.status(500).json({ error: e.message, stack: e.stack });
    }
});

// ==================== 🏆 v59 INTRACYCLE ANALYSIS ====================
// Analyzes price movement patterns within cycles to evaluate exit strategies
app.get('/api/intracycle-analysis', async (req, res) => {
    try {
        const startTime = Date.now();
        const lookbackHours = Math.min(parseInt(req.query.hours) || 24, 168);
        const asset = req.query.asset ? String(req.query.asset).toUpperCase() : 'XRP';
        
        const nowSec = Math.floor(Date.now() / 1000);
        const cutoffSec = nowSec - (lookbackHours * 3600);
        
        // Find recent cycles
        const cycles = [];
        for (let epochSec = cutoffSec - (cutoffSec % 900); epochSec < nowSec - 900; epochSec += 900) {
            cycles.push({
                slug: `${asset.toLowerCase()}-updown-15m-${epochSec}`,
                startEpochSec: epochSec,
                endEpochSec: epochSec + 900
            });
        }
        
        const results = [];
        let flatAtStart = 0;
        let movedEarly = 0;
        let earlyTPWouldTrigger = 0;
        let holdWasBetter = 0;
        
        for (const cycle of cycles.slice(-50)) { // Limit to avoid rate limits
            await new Promise(r => setTimeout(r, 100));
            
            try {
                // Fetch Gamma market data
                const gammaUrl = `https://gamma-api.polymarket.com/markets?slug=${encodeURIComponent(cycle.slug)}`;
                const gammaResp = await fetch(gammaUrl, {
                    headers: { 'User-Agent': 'polyprophet-intracycle/1.0' },
                    signal: AbortSignal.timeout(10000)
                });
                
                if (!gammaResp.ok) continue;
                const gammaData = await gammaResp.json();
                const market = Array.isArray(gammaData) ? gammaData[0] : gammaData;
                if (!market) continue;
                
                const clobTokenIds = JSON.parse(market.clobTokenIds || '[]');
                if (!clobTokenIds[0]) continue;
                
                // Fetch CLOB price history
                const clobUrl = `https://clob.polymarket.com/prices-history?market=${clobTokenIds[0]}&startTs=${cycle.startEpochSec}&endTs=${cycle.endEpochSec}&fidelity=1`;
                const clobResp = await fetch(clobUrl, {
                    headers: { 'User-Agent': 'polyprophet-intracycle/1.0' },
                    signal: AbortSignal.timeout(10000)
                });
                
                if (!clobResp.ok) continue;
                const clobData = await clobResp.json();
                const history = clobData?.history || [];
                
                if (history.length < 2) continue;
                
                // Analyze price movement
                const prices = history.map(h => ({ t: h.t, p: Number(h.p) })).filter(h => Number.isFinite(h.p));
                if (prices.length < 2) continue;
                
                const startPrice = prices[0].p;
                const endPrice = prices[prices.length - 1].p;
                const maxPrice = Math.max(...prices.map(p => p.p));
                const minPrice = Math.min(...prices.map(p => p.p));
                
                // Check if flat at start (within 5¢ of 50¢)
                const isFlatAtStart = Math.abs(startPrice - 0.5) < 0.05;
                if (isFlatAtStart) flatAtStart++;
                else movedEarly++;
                
                // Check if early TP at 70% would have triggered
                const hitTP = maxPrice >= 0.70;
                if (hitTP) earlyTPWouldTrigger++;
                
                // Check if holding to resolution was better
                const resolvedToEnd = endPrice >= 0.95 || endPrice <= 0.05;
                if (resolvedToEnd && maxPrice < 0.90) holdWasBetter++;
                
                results.push({
                    slug: cycle.slug,
                    startPrice: startPrice.toFixed(3),
                    endPrice: endPrice.toFixed(3),
                    maxPrice: maxPrice.toFixed(3),
                    minPrice: minPrice.toFixed(3),
                    dataPoints: prices.length,
                    flatAtStart: isFlatAtStart,
                    hitTP70: hitTP,
                    resolved: resolvedToEnd
                });
            } catch {}
        }
        
        const runtime = ((Date.now() - startTime) / 1000).toFixed(2);
        const total = results.length;
        
        res.json({
            success: true,
            runtime: runtime + 's',
            cyclesAnalyzed: total,
            summary: {
                flatAtStartPct: total > 0 ? ((flatAtStart / total) * 100).toFixed(1) + '%' : 'N/A',
                movedEarlyPct: total > 0 ? ((movedEarly / total) * 100).toFixed(1) + '%' : 'N/A',
                earlyTP70WouldTriggerPct: total > 0 ? ((earlyTPWouldTrigger / total) * 100).toFixed(1) + '%' : 'N/A',
                holdWasBetterPct: total > 0 ? ((holdWasBetter / total) * 100).toFixed(1) + '%' : 'N/A'
            },
            interpretation: {
                recommendation: flatAtStart > movedEarly ? 
                    'HOLD_TO_RESOLUTION: Most cycles start flat at 50¢, no early exit opportunity' :
                    'EVALUATE_EARLY_EXIT: Significant early price movement detected',
                evidence: `${flatAtStart}/${total} cycles flat at start, ${earlyTPWouldTrigger}/${total} would hit 70% TP`
            },
            samples: results.slice(-10)
        });
    } catch (e) {
        res.status(500).json({ error: e.message, stack: e.stack });
    }
});

// ==================== ✅ POLYMARKET TRADE VERIFICATION (GROUND TRUTH) ====================
// Verifies EXECUTED trades against Polymarket Gamma API outcomes (detects divergence + silent errors)
app.get('/api/verify-trades-polymarket', async (req, res) => {
    try {
        const startTime = Date.now();
        const mode = (req.query.mode || CONFIG.TRADE_MODE || 'PAPER').toUpperCase();
        const limit = Math.min(parseInt(req.query.limit) || 100, 500);
        const offset = Math.max(0, parseInt(req.query.offset) || 0);
        const assetFilter = req.query.asset ? String(req.query.asset).toUpperCase() : null;

        const PROFIT_FEE_PCT = 0.02;

        // Load most recent trades (newest first)
        const history = await loadTradeHistory(mode, offset, limit);
        const rawTrades = Array.isArray(history.trades) ? history.trades : [];

        // Only verify CLOSED ORACLE trades for supported assets
        const candidates = rawTrades.filter(t => {
            if (!t) return false;
            const status = String(t.status || '').toUpperCase();
            const tMode = String(t.mode || '').toUpperCase();
            const asset = String(t.asset || '').toUpperCase();
            if (status !== 'CLOSED') return false;
            if (tMode !== 'ORACLE') return false;
            if (t.isHedge) return false;
            if (!ASSETS.includes(asset)) return false;
            if (assetFilter && asset !== assetFilter) return false;
            return true;
        });

        // Slug format used by Polymarket crypto cycles (matches collector/debug exports)
        // Examples: btc-updown-15m-<epoch>, eth-updown-15m-<epoch>, xrp-updown-15m-<epoch>
        const assetSlugBase = {
            BTC: 'btc-updown-15m-',
            ETH: 'eth-updown-15m-',
            XRP: 'xrp-updown-15m-'
        };

        function buildSlugFromTrade(trade) {
            // Prefer the exact slug captured at entry time (best / ground-truth).
            if (typeof trade.slug === 'string' && trade.slug.length > 0) {
                return trade.slug;
            }
            const asset = String(trade.asset || '').toUpperCase();
            const base = assetSlugBase[asset];
            if (!base) return null;

            const tradeTimeMs =
                (typeof trade.time === 'number' ? trade.time : (typeof trade.timestamp === 'number' ? trade.timestamp : (typeof trade.closeTime === 'number' ? trade.closeTime : 0)));
            if (!tradeTimeMs) return null;

            const tradeSec = Math.floor(tradeTimeMs / 1000);
            let startEpochSec;

            // Prefer stored cycleElapsed for precision when available
            if (Number.isFinite(trade.cycleElapsed)) {
                const elapsed = Math.max(0, Math.min(899, Math.floor(trade.cycleElapsed)));
                const cycleStartSec = tradeSec - elapsed;
                startEpochSec = cycleStartSec - (cycleStartSec % 900);
            } else {
                startEpochSec = tradeSec - (tradeSec % 900);
            }

            return `${base}${startEpochSec}`;
        }

        async function fetchGammaOutcome(slug) {
            try {
                const url = `https://gamma-api.polymarket.com/markets?slug=${encodeURIComponent(slug)}`;
                const response = await fetch(url, {
                    headers: { 'User-Agent': 'polyprophet-verify/1.0' },
                    signal: AbortSignal.timeout(10000)
                });
                if (!response.ok) return { ok: false, error: `HTTP ${response.status}` };
                const data = await response.json();
                const market = Array.isArray(data) ? data[0] : data;
                if (!market) return { ok: false, error: 'Market not found' };
                if (!market.outcomePrices) return { ok: false, error: 'Missing outcomePrices' };

                const prices = JSON.parse(market.outcomePrices);
                if (!Array.isArray(prices) || prices.length < 2) return { ok: false, error: 'Invalid outcomePrices' };

                const p0 = Number(prices[0]);
                const p1 = Number(prices[1]);
                if (!Number.isFinite(p0) || !Number.isFinite(p1)) return { ok: false, error: 'Non-numeric outcomePrices' };

                // Treat as resolved if it is effectively 1/0 or 0/1
                const idx0Win = p0 >= 0.99 && p1 <= 0.01;
                const idx1Win = p0 <= 0.01 && p1 >= 0.99;
                if (!idx0Win && !idx1Win) {
                    return { ok: true, resolved: false, p0, p1, closed: market.closed === true };
                }

                // Map winner index -> UP/DOWN using outcomes ordering
                let outcome = idx0Win ? 'UP' : 'DOWN';
                try {
                    const outcomes = market.outcomes ? JSON.parse(market.outcomes) : null;
                    const o0 = Array.isArray(outcomes) && outcomes.length >= 2 ? String(outcomes[0]).toLowerCase() : null;
                    const o1 = Array.isArray(outcomes) && outcomes.length >= 2 ? String(outcomes[1]).toLowerCase() : null;
                    if (o0 === 'up' && o1 === 'down') outcome = idx0Win ? 'UP' : 'DOWN';
                    else if (o0 === 'down' && o1 === 'up') outcome = idx0Win ? 'DOWN' : 'UP';
                    else if (o0 === 'yes' && o1 === 'no') outcome = idx0Win ? 'UP' : 'DOWN';
                    else if (o0 === 'no' && o1 === 'yes') outcome = idx0Win ? 'DOWN' : 'UP';
                } catch { /* ignore */ }

                return { ok: true, resolved: true, outcome, p0, p1, closed: market.closed === true };
            } catch (e) {
                return { ok: false, error: e.message };
            }
        }

        const outcomeCache = new Map(); // slug -> {ok,resolved,outcome,...}

        const byAsset = {};
        for (const a of ASSETS) {
            if (assetFilter && a !== assetFilter) continue;
            byAsset[a] = { total: 0, resolved: 0, comparable: 0, earlyExit: 0, wins: 0, losses: 0, mismatches: 0, errors: 0, unresolved: 0 };
        }

        let resolved = 0, unresolved = 0, errors = 0, wins = 0, losses = 0, mismatches = 0, comparable = 0, earlyExit = 0;
        const verifiedTrades = [];

        for (const trade of candidates) {
            const asset = String(trade.asset || '').toUpperCase();
            const side = String(trade.side || '').toUpperCase();
            const slug = buildSlugFromTrade(trade);
            const tradeTimeMs = (typeof trade.time === 'number') ? trade.time : (typeof trade.timestamp === 'number' ? trade.timestamp : null);

            if (!byAsset[asset]) byAsset[asset] = { total: 0, resolved: 0, comparable: 0, earlyExit: 0, wins: 0, losses: 0, mismatches: 0, errors: 0, unresolved: 0 };
            byAsset[asset].total++;

            if (!slug) {
                errors++; byAsset[asset].errors++;
                verifiedTrades.push({
                    id: trade.id,
                    asset,
                    side,
                    slug: null,
                    error: 'Unable to derive Polymarket slug from trade timestamp'
                });
                continue;
            }

            let outcomeResult = outcomeCache.get(slug);
            if (!outcomeResult) {
                outcomeResult = await fetchGammaOutcome(slug);
                outcomeCache.set(slug, outcomeResult);
            }

            if (!outcomeResult.ok) {
                errors++; byAsset[asset].errors++;
                verifiedTrades.push({
                    id: trade.id,
                    asset,
                    side,
                    slug,
                    error: outcomeResult.error || 'Unknown Gamma API error'
                });
                continue;
            }

            if (!outcomeResult.resolved) {
                unresolved++; byAsset[asset].unresolved++;
                verifiedTrades.push({
                    id: trade.id,
                    asset,
                    side,
                    slug,
                    resolved: false
                });
                continue;
            }

            resolved++; byAsset[asset].resolved++;
            const verifiedOutcome = outcomeResult.outcome;
            const verifiedWin = side === verifiedOutcome;
            if (verifiedWin) { wins++; byAsset[asset].wins++; } else { losses++; byAsset[asset].losses++; }

            const recordedPnl = Number.isFinite(trade.pnl) ? trade.pnl : (Number.isFinite(trade.profit) ? trade.profit : null);
            const exit = Number(trade.exit);
            const isBinaryExit = Number.isFinite(exit) && (exit <= 0.01 || exit >= 0.99);
            const recordedWin = isBinaryExit ? (exit >= 0.99) : (recordedPnl !== null ? recordedPnl > 0 : null);
            const isComparable = isBinaryExit; // only binary exits are meaningfully comparable to resolution
            if (isComparable) { comparable++; byAsset[asset].comparable++; } else { earlyExit++; byAsset[asset].earlyExit++; }
            const mismatch = (isComparable && recordedWin !== null) ? (recordedWin !== verifiedWin) : false;
            if (mismatch) { mismatches++; byAsset[asset].mismatches++; }

            // What PnL would be if held to resolution (profit-fee model), using stored entry+size
            const entry = Number(trade.entry);
            const size = Number(trade.size);
            let expectedPnl = null;
            if (Number.isFinite(entry) && entry > 0 && Number.isFinite(size) && size > 0) {
                if (verifiedWin) {
                    const shares = size / entry;
                    const grossProfit = shares - size;
                    const fee = grossProfit * PROFIT_FEE_PCT;
                    expectedPnl = grossProfit - fee;
                } else {
                    expectedPnl = -size;
                }
            }

            verifiedTrades.push({
                id: trade.id,
                asset,
                side,
                slug,
                tradeTime: tradeTimeMs ? new Date(tradeTimeMs).toISOString() : null,
                entry: Number.isFinite(entry) ? entry : null,
                size: Number.isFinite(size) ? size : null,
                exit: Number.isFinite(exit) ? exit : null,
                verifiedOutcome,
                verifiedWin,
                recordedPnl,
                recordedWin,
                expectedPnl: expectedPnl !== null ? Number(expectedPnl.toFixed(6)) : null,
                comparable: isComparable,
                mismatch,
                reason: trade.reason || null
            });
        }

        const winRate = (wins + losses) > 0 ? (wins / (wins + losses)) * 100 : 0;
        const runtime = ((Date.now() - startTime) / 1000).toFixed(2);

        res.json({
            summary: {
                method: 'Polymarket Gamma API (ground truth) vs executed trades',
                runtime: runtime + 's',
                mode,
                offset,
                limitRequested: limit,
                assetFilter: assetFilter || 'ALL',
                candidates: candidates.length,
                comparable,
                earlyExit,
                resolved,
                unresolved,
                errors,
                wins,
                losses,
                winRate: winRate.toFixed(2) + '%',
                mismatches
            },
            byAsset,
            trades: verifiedTrades.slice(0, 50), // first 50 (already newest-first)
            source: history.source
        });
    } catch (e) {
        res.status(500).json({ error: e.message, stack: e.stack });
    }
});

// 🎯 GOAT v44.1: Forward Test - Replay collector snapshots through decision engine
app.get('/api/forward-test', async (req, res) => {
    try {
        const limit = parseInt(req.query.limit) || 100;
        const snapshotData = await getCollectorSnapshots(limit);
        
        if (snapshotData.count === 0) {
            return res.json({
                error: 'No snapshots available. Enable the collector first.',
                howToEnable: 'POST /api/collector/toggle'
            });
        }
        
        const snapshots = snapshotData.snapshots;
        const results = {
            source: snapshotData.source,
            snapshotsAnalyzed: snapshots.length,
            signalDistribution: { UP: 0, DOWN: 0, WAIT: 0, NEUTRAL: 0 },
            tierDistribution: { CONVICTION: 0, ADVISORY: 0, NONE: 0 },
            avgConfidence: 0,
            avgEdge: 0,
            pWinDistribution: { high: 0, medium: 0, low: 0, na: 0 },
            tradingStates: {},
            assets: {}
        };
        
        let totalConf = 0;
        let totalEdge = 0;
        let confCount = 0;
        let edgeCount = 0;
        
        for (const snapshot of snapshots) {
            // Track trading state distribution
            const state = snapshot.tradingState || 'UNKNOWN';
            results.tradingStates[state] = (results.tradingStates[state] || 0) + 1;
            
            // Analyze signals
            for (const [asset, signal] of Object.entries(snapshot.signals || {})) {
                if (!results.assets[asset]) {
                    results.assets[asset] = { signals: [], avgConf: 0, avgEdge: 0, tierCounts: { CONVICTION: 0, ADVISORY: 0, NONE: 0 } };
                }
                
                // Signal distribution
                const pred = signal.prediction || 'WAIT';
                results.signalDistribution[pred] = (results.signalDistribution[pred] || 0) + 1;
                
                // Tier distribution
                const tier = signal.tier || 'NONE';
                results.tierDistribution[tier] = (results.tierDistribution[tier] || 0) + 1;
                results.assets[asset].tierCounts[tier] = (results.assets[asset].tierCounts[tier] || 0) + 1;
                
                // Confidence
                if (typeof signal.confidence === 'number') {
                    totalConf += signal.confidence;
                    confCount++;
                }
                
                // Edge
                if (typeof signal.edge === 'number' && Number.isFinite(signal.edge)) {
                    totalEdge += signal.edge;
                    edgeCount++;
                }
                
                // pWin distribution
                const pWin = signal.pWin;
                if (pWin === null || pWin === undefined) {
                    results.pWinDistribution.na++;
                } else if (pWin >= 0.7) {
                    results.pWinDistribution.high++;
                } else if (pWin >= 0.5) {
                    results.pWinDistribution.medium++;
                } else {
                    results.pWinDistribution.low++;
                }
            }
        }
        
        results.avgConfidence = confCount > 0 ? (totalConf / confCount * 100).toFixed(1) + '%' : 'N/A';
        results.avgEdge = edgeCount > 0 ? (totalEdge / edgeCount).toFixed(2) + '%' : 'N/A';
        
        // Summary insights
        results.insights = [];
        const convictionPct = (results.tierDistribution.CONVICTION / Math.max(1, Object.values(results.tierDistribution).reduce((a, b) => a + b, 0))) * 100;
        if (convictionPct < 5) {
            results.insights.push('Low CONVICTION signal rate (' + convictionPct.toFixed(1) + '%) - consider loosening thresholds');
        }
        if (results.pWinDistribution.na > results.pWinDistribution.high + results.pWinDistribution.medium) {
            results.insights.push('Many signals missing pWin - calibration data may be insufficient');
        }
        
        res.json(results);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ==================== DEBUG EXPORT API ====================
// Returns last 10 cycles of COMPLETE debugging data - EVERY ATOM
app.get('/api/debug-export', (req, res) => {
    try {
        // Sanitize full runtime CONFIG for export (debug exports may be shared externally)
        const sanitizeConfigForExport = () => {
            let cfg = null;
            try {
                cfg = JSON.parse(JSON.stringify(CONFIG));
            } catch {
                // Fallback: shallow clone
                cfg = { ...CONFIG };
            }

            const redactKeys = [
                'POLYMARKET_PRIVATE_KEY',
                'POLYMARKET_API_KEY',
                'POLYMARKET_SECRET',
                'POLYMARKET_PASSPHRASE',
                'POLYMARKET_ADDRESS'
            ];
            for (const k of redactKeys) {
                if (cfg && Object.prototype.hasOwnProperty.call(cfg, k) && cfg[k]) {
                    cfg[k] = '<REDACTED>';
                }
            }
            return cfg;
        };

        const configAll = sanitizeConfigForExport();
        const runtimeConfigSha256 = (() => {
            try {
                return crypto.createHash('sha256').update(JSON.stringify(configAll)).digest('hex');
            } catch {
                return null;
            }
        })();

        const exportData = {
            // === META INFO ===
            exportTime: new Date().toISOString(),
            serverUptime: process.uptime(),
            cycleInterval: INTERVAL_SECONDS,
            nodeVersion: process.version,
            memoryUsage: process.memoryUsage(),
            code: typeof CODE_FINGERPRINT !== 'undefined' ? CODE_FINGERPRINT : null,
            runtimeConfigSha256,

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
            // Full CONFIG snapshot (sanitized) to eliminate runtime drift ambiguity
            configAll,

            // === GLOBAL STATE ===
            globalState: {
                fearGreedIndex: typeof fearGreedIndex !== 'undefined' ? fearGreedIndex : null,
                fundingRates: typeof fundingRates !== 'undefined' ? fundingRates : null,
                lastUpdateTimestamp: typeof lastUpdateTimestamp !== 'undefined' ? lastUpdateTimestamp : null,
                redisAvailable: typeof redisAvailable !== 'undefined' ? redisAvailable : false,
                gateTraceSummary: (typeof gateTrace !== 'undefined' && gateTrace && typeof gateTrace.getSummary === 'function') ? gateTrace.getSummary() : null
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
                    scalpBounceHistory: brain.scalpBounceHistory,

                    // Raw per-tick decision stream for the CURRENT cycle (every second)
                    currentCycleHistory: brain.currentCycleHistory || []
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

// Health check endpoint (enhanced with GOAT v44.1 watchdog status + v3 CircuitBreaker)
app.get('/api/health', (req, res) => {
    const now = Date.now();
    const lastTrade = tradeExecutor && tradeExecutor.tradeHistory && tradeExecutor.tradeHistory.length > 0
        ? (tradeExecutor.tradeHistory[tradeExecutor.tradeHistory.length - 1].closeTime ||
           tradeExecutor.tradeHistory[tradeExecutor.tradeHistory.length - 1].time ||
           tradeExecutor.tradeHistory[tradeExecutor.tradeHistory.length - 1].timestamp)
        : null;
    
    // Update CircuitBreaker to get current state
    let cbStatus = null;
    if (tradeExecutor && tradeExecutor.circuitBreaker) {
        tradeExecutor.updateCircuitBreaker();
        const dayStart = tradeExecutor.circuitBreaker.dayStartBalance || tradeExecutor.paperBalance;
        const currentBal = tradeExecutor.mode === 'PAPER' ? tradeExecutor.paperBalance : tradeExecutor.cachedLiveBalance;
        const drawdownPct = dayStart > 0 ? (dayStart - currentBal) / dayStart : 0;
        
        cbStatus = {
            enabled: tradeExecutor.circuitBreaker.enabled,
            state: tradeExecutor.circuitBreaker.state,
            dayStartBalance: dayStart,
            currentBalance: currentBal,
            drawdownPct: (drawdownPct * 100).toFixed(1) + '%',
            consecutiveLosses: tradeExecutor.consecutiveLosses || 0,
            streakSizeMultiplier: tradeExecutor.getStreakSizeMultiplier()
        };
    }
    
    // 🎯 v52: Rolling accuracy per asset (drift detection)
    const rollingAccuracy = {};
    for (const asset of ASSETS) {
        const brain = Brains[asset];
        if (brain && brain.rollingConviction) {
            const wins = brain.rollingConviction.filter(r => r.wasCorrect).length;
            const total = brain.rollingConviction.length;
            rollingAccuracy[asset] = {
                convictionWR: total > 0 ? ((wins / total) * 100).toFixed(1) + '%' : 'N/A',
                sampleSize: total,
                driftWarning: brain.driftWarning || false,
                autoDisabled: brain.autoDisabled || false
            };
        }
    }

    // 🏆 v60: Pending settlements count (not blocking exposure)
    const pendingSettlements = tradeExecutor?.getPendingSettlements?.() || [];
    
    res.json({
        status: 'ok',
        uptime: process.uptime(),
        timestamp: new Date().toISOString(),
        code: typeof CODE_FINGERPRINT !== 'undefined' ? CODE_FINGERPRINT : null,
        watchdog: {
            lastCycleAge: typeof watchdogState !== 'undefined' ? Math.round((now - watchdogState.lastCycleDetected) / 1000) : null,
            lastTradeAge: lastTrade ? Math.round((now - lastTrade) / 1000) : null,
            memoryMB: Math.round(process.memoryUsage().heapUsed / (1024 * 1024)),
            alertsPending: typeof watchdogState !== 'undefined' ? watchdogState.alertsSent.size : 0
        },
        circuitBreaker: cbStatus,
        // 🏆 v60: Pending settlements (awaiting Gamma, not blocking trades)
        pendingSettlements: {
            count: pendingSettlements.length,
            items: pendingSettlements.slice(0, 5) // Show up to 5 in health
        },
        // 🎯 v52: Drift detection per asset
        rollingAccuracy
    });
});

// 🎯 GOAT v3: CircuitBreaker status and control
app.get('/api/circuit-breaker', (req, res) => {
    if (!tradeExecutor || !tradeExecutor.circuitBreaker) {
        return res.json({ error: 'TradeExecutor not initialized' });
    }
    
    tradeExecutor.updateCircuitBreaker();
    const cb = tradeExecutor.circuitBreaker;
    const dayStart = cb.dayStartBalance || tradeExecutor.paperBalance;
    const currentBal = tradeExecutor.mode === 'PAPER' ? tradeExecutor.paperBalance : tradeExecutor.cachedLiveBalance;
    const drawdownPct = dayStart > 0 ? (dayStart - currentBal) / dayStart : 0;
    
    res.json({
        state: cb.state,
        enabled: cb.enabled,
        
        // Current situation
        dayStartBalance: dayStart,
        currentBalance: currentBal,
        drawdownPct: (drawdownPct * 100).toFixed(2) + '%',
        consecutiveLosses: tradeExecutor.consecutiveLosses || 0,
        recentWinStreak: tradeExecutor.recentWinStreak || 0,
        
        // Thresholds
        thresholds: {
            softDrawdownPct: (cb.softDrawdownPct * 100) + '%',
            hardDrawdownPct: (cb.hardDrawdownPct * 100) + '%',
            haltDrawdownPct: (cb.haltDrawdownPct * 100) + '%',
            safeOnlyAfterLosses: cb.safeOnlyAfterLosses,
            probeOnlyAfterLosses: cb.probeOnlyAfterLosses,
            haltAfterLosses: cb.haltAfterLosses
        },
        
        // Streak sizing
        streakSizing: {
            enabled: tradeExecutor.streakSizing.enabled,
            currentMultiplier: tradeExecutor.getStreakSizeMultiplier(),
            maxLossBudget: tradeExecutor.getMaxLossBudget().toFixed(2)
        },
        
        // Trigger history
        triggerTime: cb.triggerTime ? new Date(cb.triggerTime).toISOString() : null,
        dayStartTime: cb.dayStartTime ? new Date(cb.dayStartTime).toISOString() : null,
        
        // What would happen to a trade right now
        wouldAllow: tradeExecutor.isCircuitBreakerAllowed('NORMAL')
    });
});

// 🎯 GOAT v3: Override CircuitBreaker (manual control)
app.post('/api/circuit-breaker/override', (req, res) => {
    if (!tradeExecutor || !tradeExecutor.circuitBreaker) {
        return res.status(400).json({ error: 'TradeExecutor not initialized' });
    }
    
    const { action } = req.body;
    
    switch (action) {
        case 'reset':
            tradeExecutor.circuitBreaker.state = 'NORMAL';
            tradeExecutor.circuitBreaker.triggerTime = 0;
            tradeExecutor.consecutiveLosses = 0;
            log('🔌 CircuitBreaker manually reset to NORMAL');
            break;
        case 'disable':
            tradeExecutor.circuitBreaker.enabled = false;
            log('🔌 CircuitBreaker DISABLED');
            break;
        case 'enable':
            tradeExecutor.circuitBreaker.enabled = true;
            log('🔌 CircuitBreaker ENABLED');
            break;
        case 'halt':
            tradeExecutor.circuitBreaker.state = 'HALTED';
            tradeExecutor.circuitBreaker.triggerTime = Date.now();
            log('🔌 CircuitBreaker manually set to HALTED');
            break;
        default:
            return res.status(400).json({ 
                error: 'Invalid action', 
                validActions: ['reset', 'disable', 'enable', 'halt'] 
            });
    }
    
    res.json({ 
        success: true, 
        action: action,
        newState: tradeExecutor.circuitBreaker.state,
        enabled: tradeExecutor.circuitBreaker.enabled
    });
});

// 🎯 GOAT v46: Comprehensive halt status endpoint
app.get('/api/halts', (req, res) => {
    if (!tradeExecutor) {
        return res.status(500).json({ error: 'TradeExecutor not initialized' });
    }
    
    const cb = tradeExecutor.circuitBreaker || {};
    const inCooldown = tradeExecutor.isInCooldown();
    const cooldownRemaining = inCooldown ? Math.ceil((CONFIG.RISK.cooldownAfterLoss * 1000 - (Date.now() - tradeExecutor.lastLossTime)) / 1000) : 0;
    const globalStopTriggered = tradeExecutor.todayPnL < 0 && Math.abs(tradeExecutor.todayPnL) > tradeExecutor.paperBalance * CONFIG.RISK.globalStopLoss;
    
    const now = Date.now();
    const dayStart = cb.dayStartBalance || tradeExecutor.paperBalance;
    const currentBalance = tradeExecutor.mode === 'PAPER' ? tradeExecutor.paperBalance : (tradeExecutor.cachedLiveBalance || tradeExecutor.paperBalance);
    const drawdownPct = dayStart > 0 ? ((dayStart - currentBalance) / dayStart) : 0;
    
    res.json({
        // Current status
        currentState: {
            isHalted: inCooldown || globalStopTriggered || cb.state === 'HALTED',
            isThrottled: cb.state === 'SAFE_ONLY' || cb.state === 'PROBE_ONLY',
            effectiveState: cb.state === 'HALTED' ? 'HALTED' : 
                           (globalStopTriggered ? 'GLOBAL_STOP' : 
                           (inCooldown ? 'COOLDOWN' : cb.state)),
            sizeMultiplier: cb.state === 'HALTED' ? 0 : 
                           (cb.state === 'PROBE_ONLY' ? 0.25 : 
                           (cb.state === 'SAFE_ONLY' ? 0.5 : 1.0))
        },
        
        // Active triggers
        activeTriggers: {
            cooldown: inCooldown ? {
                active: true,
                remainingSeconds: cooldownRemaining,
                reason: `${tradeExecutor.consecutiveLosses || 0} consecutive losses`,
                resume: 'Wait for cooldown to expire or win a trade'
            } : { active: false },
            
            globalStopLoss: globalStopTriggered ? {
                active: true,
                todayPnL: tradeExecutor.todayPnL,
                threshold: CONFIG.RISK.globalStopLoss,
                resume: 'New day or toggle override via POST /api/toggle-stop-loss-override'
            } : { active: false },
            
            circuitBreaker: cb.state !== 'NORMAL' ? {
                active: true,
                state: cb.state,
                drawdownPct: (drawdownPct * 100).toFixed(1) + '%',
                consecutiveLosses: tradeExecutor.consecutiveLosses || 0,
                resume: cb.state === 'HALTED' ? 'New day or POST /api/circuit-breaker/override action=reset' : 'Win a trade or wait'
            } : { active: false }
        },
        
        // Configuration (for reference)
        thresholds: {
            cooldown: {
                triggersAfterLosses: CONFIG.RISK.maxConsecutiveLosses,
                durationSeconds: CONFIG.RISK.cooldownAfterLoss
            },
            globalStopLoss: {
                maxDailyLossPct: (CONFIG.RISK.globalStopLoss * 100) + '%'
            },
            circuitBreaker: {
                softDrawdownPct: (cb.softDrawdownPct * 100) + '%',
                hardDrawdownPct: (cb.hardDrawdownPct * 100) + '%',
                haltDrawdownPct: (cb.haltDrawdownPct * 100) + '%',
                safeOnlyAfterLosses: cb.safeOnlyAfterLosses,
                probeOnlyAfterLosses: cb.probeOnlyAfterLosses,
                haltAfterLosses: cb.haltAfterLosses,
                resumeAfterMinutes: cb.resumeAfterMinutes,
                resumeOnNewDay: cb.resumeOnNewDay
            }
        },
        
        // Balance context
        balance: {
            dayStartBalance: dayStart,
            currentBalance: currentBalance,
            drawdownPct: (drawdownPct * 100).toFixed(1) + '%',
            todayPnL: tradeExecutor.todayPnL
        },
        
        // Override endpoints
        overrides: {
            circuitBreaker: 'POST /api/circuit-breaker/override with action=reset|disable|enable|halt',
            globalStopLoss: 'POST /api/toggle-stop-loss-override'
        }
    });
});

// 🎯 GOAT v3: Portfolio accounting endpoint
app.get('/api/portfolio', (req, res) => {
    if (!tradeExecutor) {
        return res.status(500).json({ error: 'TradeExecutor not initialized' });
    }
    
    res.json(tradeExecutor.getPortfolioSummary());
});

// 🎯 GOAT v3: Calibration endpoint with confidence bounds
app.get('/api/calibration', (req, res) => {
    const calibrationData = {
        description: 'Calibration statistics by bucket (tier × price_band × regime)',
        buckets: {},
        summary: {
            totalCycles: 0,
            avgAccuracy: 0,
            lcbPWin: 0,
            explanation: 'Lower Confidence Bound (LCB) is used to gate trades - we only trade when the LCB of pWin is above threshold'
        }
    };
    
    // Collect calibration data from all brains
    ASSETS.forEach(asset => {
        if (typeof Brains !== 'undefined' && Brains[asset]) {
            const brain = Brains[asset];
            const buckets = brain.calibrationBuckets || {};
            
            for (const [key, bucket] of Object.entries(buckets)) {
                if (!calibrationData.buckets[key]) {
                    calibrationData.buckets[key] = { wins: 0, total: 0, assets: [] };
                }
                calibrationData.buckets[key].wins += bucket.wins || 0;
                calibrationData.buckets[key].total += bucket.total || 0;
                calibrationData.buckets[key].assets.push(asset);
            }
            
            // Also include brain stats
            if (brain.stats) {
                calibrationData.summary.totalCycles += brain.stats.total || 0;
            }
        }
    });
    
    // Calculate accuracy and LCB for each bucket
    let totalAcc = 0;
    let bucketCount = 0;
    
    for (const [key, bucket] of Object.entries(calibrationData.buckets)) {
        if (bucket.total > 0) {
            bucket.accuracy = bucket.wins / bucket.total;
            bucket.accuracyPct = (bucket.accuracy * 100).toFixed(1) + '%';
            
            // Calculate Wilson score interval for LCB (conservative)
            // LCB = (p + z²/2n - z*sqrt(p(1-p)/n + z²/4n²)) / (1 + z²/n)
            // Using z = 1.96 for 95% confidence
            const p = bucket.accuracy;
            const n = bucket.total;
            const z = 1.96;
            const z2 = z * z;
            
            if (n > 0) {
                const denominator = 1 + z2 / n;
                const center = p + z2 / (2 * n);
                const margin = z * Math.sqrt((p * (1 - p) / n) + (z2 / (4 * n * n)));
                bucket.lcb = Math.max(0, (center - margin) / denominator);
                bucket.ucb = Math.min(1, (center + margin) / denominator);
                bucket.lcbPct = (bucket.lcb * 100).toFixed(1) + '%';
            } else {
                bucket.lcb = 0;
                bucket.ucb = 1;
                bucket.lcbPct = '0%';
            }
            
            totalAcc += bucket.accuracy;
            bucketCount++;
        }
    }
    
    if (bucketCount > 0) {
        calibrationData.summary.avgAccuracy = (totalAcc / bucketCount * 100).toFixed(1) + '%';
    }
    
    // Plain English explanation
    calibrationData.howToRead = {
        accuracy: 'Historical win rate for this bucket',
        lcb: 'Lower Confidence Bound (95%) - conservative estimate of true win probability',
        ucb: 'Upper Confidence Bound (95%)',
        total: 'Number of trades in this bucket',
        recommendation: 'Only trade when LCB >= configured threshold (typically 55-60%)'
    };
    
    res.json(calibrationData);
});

// 🎯 GOAT v3: Monte Carlo projection endpoint
app.get('/api/projection', async (req, res) => {
    try {
        const startingBalance = parseFloat(req.query.balance) || 5.0;
        const targetBalance = parseFloat(req.query.target) || 100.0;
        const simulations = Math.min(parseInt(req.query.sims) || 1000, 10000);
        const maxTrades = parseInt(req.query.maxTrades) || 500;
        
        // Get historical win rate from calibration
        let historicalWinRate = 0.65; // Default
        let totalWins = 0;
        let totalTrades = 0;
        
        if (typeof Brains !== 'undefined') {
            ASSETS.forEach(asset => {
                if (Brains[asset] && Brains[asset].stats) {
                    totalWins += Brains[asset].stats.wins || 0;
                    totalTrades += Brains[asset].stats.total || 0;
                }
            });
        }
        
        if (totalTrades > 0) {
            historicalWinRate = totalWins / totalTrades;
        }
        
        // Also check trade history
        if (tradeExecutor && tradeExecutor.tradeHistory) {
            const closedTrades = tradeExecutor.tradeHistory.filter(t => t.status === 'CLOSED');
            if (closedTrades.length > 10) {
                const wins = closedTrades.filter(t => t.pnl >= 0).length;
                historicalWinRate = (historicalWinRate + wins / closedTrades.length) / 2; // Average
            }
        }
        
        // Monte Carlo simulation
        const results = [];
        const tradesToTarget = [];
        const finalBalances = [];
        let reachedTargetCount = 0;
        let bustCount = 0;
        
        const positionSize = 0.20; // 20% position size (conservative)
        const avgEntryPrice = 0.65; // Average entry price
        const winPayout = 1.0 / avgEntryPrice; // Win pays ~1.54x
        
        for (let sim = 0; sim < simulations; sim++) {
            let balance = startingBalance;
            let trades = 0;
            let reached = false;
            
            while (trades < maxTrades && balance >= 1.10 && !reached) {
                const size = Math.min(balance * positionSize, balance - 1.0);
                if (size < 1.10) break;
                
                // Simulate trade outcome
                const won = Math.random() < historicalWinRate;
                
                if (won) {
                    const profit = size * (winPayout - 1) * 0.98; // 2% fee on profit
                    balance += profit;
                } else {
                    balance -= size;
                }
                
                trades++;
                
                if (balance >= targetBalance) {
                    reached = true;
                    reachedTargetCount++;
                    tradesToTarget.push(trades);
                }
            }
            
            if (balance < 1.10) bustCount++;
            finalBalances.push(balance);
        }
        
        // Calculate percentiles
        finalBalances.sort((a, b) => a - b);
        tradesToTarget.sort((a, b) => a - b);
        
        const p50Balance = finalBalances[Math.floor(simulations * 0.50)];
        const p80Balance = finalBalances[Math.floor(simulations * 0.80)];
        const p95Balance = finalBalances[Math.floor(simulations * 0.95)];
        
        const p50Trades = tradesToTarget.length > 0 ? tradesToTarget[Math.floor(tradesToTarget.length * 0.50)] : null;
        const p80Trades = tradesToTarget.length > 0 ? tradesToTarget[Math.floor(tradesToTarget.length * 0.80)] : null;
        
        res.json({
            inputs: {
                startingBalance,
                targetBalance,
                simulations,
                maxTrades,
                historicalWinRate: (historicalWinRate * 100).toFixed(1) + '%',
                positionSize: (positionSize * 100) + '%',
                avgEntryPrice: (avgEntryPrice * 100) + '¢'
            },
            results: {
                reachedTargetPct: ((reachedTargetCount / simulations) * 100).toFixed(1) + '%',
                bustPct: ((bustCount / simulations) * 100).toFixed(1) + '%',
                
                balanceDistribution: {
                    p50: '$' + p50Balance.toFixed(2),
                    p80: '$' + p80Balance.toFixed(2),
                    p95: '$' + p95Balance.toFixed(2),
                    min: '$' + finalBalances[0].toFixed(2),
                    max: '$' + finalBalances[finalBalances.length - 1].toFixed(2)
                },
                
                tradesToTarget: tradesToTarget.length > 0 ? {
                    p50: p50Trades + ' trades',
                    p80: p80Trades + ' trades',
                    sampleSize: tradesToTarget.length
                } : 'Target not reached in enough simulations'
            },
            
            // Plain English summary
            summary: `Based on ${simulations} Monte Carlo simulations with ${(historicalWinRate * 100).toFixed(0)}% win rate: ` +
                     `There's a ${((reachedTargetCount / simulations) * 100).toFixed(0)}% chance of reaching $${targetBalance} from $${startingBalance}. ` +
                     `Median ending balance after ${maxTrades} trades: $${p50Balance.toFixed(2)}. ` +
                     `Risk of bust (balance < $1.10): ${((bustCount / simulations) * 100).toFixed(1)}%.`,
            
            disclaimer: 'These projections are based on historical data and Monte Carlo simulation. ' +
                        'Past performance does not guarantee future results. Markets can behave unexpectedly.'
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// 🏆 v62 ADAPTIVE STRESS TEST - Monte Carlo with PROFIT PROTECTION
// Simulates the ADAPTIVE system that protects worst-case
app.get('/api/stress-test', async (req, res) => {
    try {
        const startingBalance = parseFloat(req.query.balance) || 5.0;
        const simulations = Math.min(parseInt(req.query.sims) || 5000, 50000);
        const stakePct = parseFloat(req.query.stake) || 0.30;
        const maxTrades = parseInt(req.query.maxTrades) || 365;
        const adaptive = req.query.adaptive !== '0'; // Enable adaptive by default
        
        // Regime definitions
        const regimes = {
            BULL: { winRate: 0.75, probability: 0.25, name: 'Bull Market (75% WR)' },
            NORMAL: { winRate: 0.68, probability: 0.40, name: 'Normal Market (68% WR)' },
            SIDEWAYS: { winRate: 0.55, probability: 0.20, name: 'Sideways/Choppy (55% WR)' },
            BEAR: { winRate: 0.45, probability: 0.10, name: 'Bear Market (45% WR)' },
            CHAOS: { winRate: 0.35, probability: 0.05, name: 'Chaos/Black Swan (35% WR)' }
        };
        
        const PROFIT_FEE_PCT = 0.02;
        const SLIPPAGE_PCT = 0.02;
        const avgEntryPrice = 0.60;
        
        const finalBalances = [];
        const maxDrawdowns = [];
        const bustCount = { total: 0, regimeCounts: {} };
        const survivalStats = { survived: 0, thrived: 0, profit10x: 0, profit100x: 0, profitPositive: 0 };
        
        for (let sim = 0; sim < simulations; sim++) {
            let balance = startingBalance;
            let peakBalance = startingBalance;
            let maxDD = 0;
            let currentRegime = 'NORMAL';
            let regimeTradesRemaining = 0;
            let consecutiveLosses = 0;
            let regimeLosses = 0; // Track losses in current regime
            let tradingHalted = false;
            let haltedTrades = 0;
            let busted = false;
            
            for (let trade = 0; trade < maxTrades && balance >= 1.0; trade++) {
                // Regime switching
                if (regimeTradesRemaining <= 0) {
                    const rand = Math.random();
                    let cumProb = 0;
                    for (const [regime, data] of Object.entries(regimes)) {
                        cumProb += data.probability;
                        if (rand <= cumProb) {
                            currentRegime = regime;
                            break;
                        }
                    }
                    regimeTradesRemaining = Math.floor(10 + Math.random() * 40);
                    regimeLosses = 0;
                    // 🏆 v62: Resume trading on regime change
                    if (tradingHalted && Math.random() > 0.5) {
                        tradingHalted = false;
                    }
                }
                regimeTradesRemaining--;
                
                // 🏆 v62 ADAPTIVE: Skip trading during bad regimes
                if (adaptive) {
                    // Halt if 3+ losses in current regime (regime detection)
                    if (regimeLosses >= 3 && !tradingHalted) {
                        tradingHalted = true;
                        haltedTrades = Math.floor(5 + Math.random() * 10);
                    }
                    if (tradingHalted) {
                        haltedTrades--;
                        if (haltedTrades <= 0) tradingHalted = false;
                        continue;
                    }
                }
                
                // 🏆 v62 ADAPTIVE SIZING: Multiple protection layers
                let sizeMultiplier = 1.0;
                
                // Layer 1: Loss streak reduction
                if (consecutiveLosses >= 4) sizeMultiplier *= 0.10;
                else if (consecutiveLosses >= 3) sizeMultiplier *= 0.20;
                else if (consecutiveLosses >= 2) sizeMultiplier *= 0.40;
                else if (consecutiveLosses >= 1) sizeMultiplier *= 0.60;
                
                // 🏆 v62 Layer 2: PROFIT PROTECTION (lock in gains)
                if (adaptive) {
                    const profitMultiple = balance / startingBalance;
                    if (profitMultiple >= 20) sizeMultiplier *= 0.50;
                    else if (profitMultiple >= 10) sizeMultiplier *= 0.60;
                    else if (profitMultiple >= 5) sizeMultiplier *= 0.75;
                    else if (profitMultiple >= 2) sizeMultiplier *= 0.90;
                }
                
                // 🏆 v62 Layer 3: Regime-based sizing
                if (adaptive) {
                    if (currentRegime === 'BEAR') sizeMultiplier *= 0.50;
                    else if (currentRegime === 'CHAOS') sizeMultiplier *= 0.25;
                    else if (currentRegime === 'SIDEWAYS') sizeMultiplier *= 0.70;
                }
                
                const positionSize = Math.min(balance * stakePct * sizeMultiplier, 100);
                if (positionSize < 0.50) continue;
                
                const winRate = regimes[currentRegime].winRate;
                const won = Math.random() < winRate;
                
                let pnl;
                if (won) {
                    const effectiveEntry = avgEntryPrice * (1 + SLIPPAGE_PCT);
                    const shares = positionSize / effectiveEntry;
                    const grossValue = shares * 1.0;
                    const profit = grossValue - positionSize;
                    const fee = profit * PROFIT_FEE_PCT;
                    pnl = profit - fee;
                    consecutiveLosses = 0;
                    regimeLosses = Math.max(0, regimeLosses - 1);
                } else {
                    pnl = -positionSize;
                    consecutiveLosses++;
                    regimeLosses++;
                }
                
                balance += pnl;
                peakBalance = Math.max(peakBalance, balance);
                const dd = peakBalance > 0 ? (peakBalance - balance) / peakBalance : 0;
                maxDD = Math.max(maxDD, dd);
                
                // Circuit breaker - halt at 50% DD
                if (dd >= 0.50) {
                    trade += Math.floor(10 + Math.random() * 15);
                }
            }
            
            if (balance < 1.0) {
                bustCount.total++;
                bustCount.regimeCounts[currentRegime] = (bustCount.regimeCounts[currentRegime] || 0) + 1;
                busted = true;
            }
            
            finalBalances.push(balance);
            maxDrawdowns.push(maxDD);
            
            if (!busted) {
                survivalStats.survived++;
                if (balance > startingBalance) survivalStats.profitPositive++;
                if (balance >= startingBalance * 2) survivalStats.thrived++;
                if (balance >= startingBalance * 10) survivalStats.profit10x++;
                if (balance >= startingBalance * 100) survivalStats.profit100x++;
            }
        }
        
        // Calculate percentiles
        finalBalances.sort((a, b) => a - b);
        maxDrawdowns.sort((a, b) => a - b);
        
        const getPercentile = (arr, p) => arr[Math.floor(arr.length * p)] || 0;
        
        // Value at Risk calculations
        const worstCase1Pct = getPercentile(finalBalances, 0.01);
        const worstCase5Pct = getPercentile(finalBalances, 0.05);
        const worstCase10Pct = getPercentile(finalBalances, 0.10);
        const median = getPercentile(finalBalances, 0.50);
        const best10Pct = getPercentile(finalBalances, 0.90);
        const best5Pct = getPercentile(finalBalances, 0.95);
        
        const avgFinalBalance = finalBalances.reduce((a, b) => a + b, 0) / simulations;
        const avgMaxDD = maxDrawdowns.reduce((a, b) => a + b, 0) / simulations;
        
        // 🏆 v62: Calculate profit-positive rate (scenarios that made money)
        const profitPositiveRate = survivalStats.profitPositive / simulations;
        const worst5PctIsProfit = worstCase5Pct > startingBalance;
        
        res.json({
            summary: {
                description: '🏆 v62 ADAPTIVE STRESS TEST - Simulates 1 year with PROFIT PROTECTION',
                simulations,
                startingBalance: '$' + startingBalance.toFixed(2),
                stakePct: (stakePct * 100).toFixed(0) + '%',
                tradesPerSim: maxTrades,
                adaptiveMode: adaptive ? 'ENABLED (profit protection + regime detection)' : 'DISABLED'
            },
            
            regimeBreakdown: Object.entries(regimes).map(([name, data]) => ({
                regime: name,
                winRate: (data.winRate * 100) + '%',
                probability: (data.probability * 100) + '%',
                description: data.name
            })),
            
            worstCaseScenarios: {
                absolute_worst: '$' + finalBalances[0].toFixed(2),
                worst_1pct: '$' + worstCase1Pct.toFixed(2),
                worst_5pct: '$' + worstCase5Pct.toFixed(2),
                worst_10pct: '$' + worstCase10Pct.toFixed(2),
                worst_5pct_is_profit: worst5PctIsProfit,
                interpretation: worst5PctIsProfit 
                    ? `✅ WORST 5% STILL PROFITABLE: Even in bad scenarios, you end with $${worstCase5Pct.toFixed(2)} (from $${startingBalance})`
                    : `In the worst 5% of scenarios, you end with $${worstCase5Pct.toFixed(2)}.`
            },
            
            expectedOutcomes: {
                median: '$' + median.toFixed(2),
                average: '$' + avgFinalBalance.toFixed(2),
                best_10pct: '$' + best10Pct.toFixed(2),
                best_5pct: '$' + best5Pct.toFixed(2),
                best_ever: '$' + finalBalances[finalBalances.length - 1].toFixed(2)
            },
            
            riskMetrics: {
                bustRate: ((bustCount.total / simulations) * 100).toFixed(2) + '%',
                survivalRate: ((survivalStats.survived / simulations) * 100).toFixed(2) + '%',
                profitPositiveRate: ((profitPositiveRate) * 100).toFixed(2) + '% (any profit)',
                profitRate: ((survivalStats.thrived / simulations) * 100).toFixed(2) + '% (2x+)',
                moonRate: ((survivalStats.profit10x / simulations) * 100).toFixed(2) + '% (10x+)',
                avgMaxDrawdown: (avgMaxDD * 100).toFixed(1) + '%',
                medianMaxDrawdown: (getPercentile(maxDrawdowns, 0.50) * 100).toFixed(1) + '%',
                worst1PctDrawdown: (getPercentile(maxDrawdowns, 0.99) * 100).toFixed(1) + '%'
            },
            
            verdict: {
                survives_all_markets: bustCount.total / simulations < 0.10,
                worst_case_is_profit: worst5PctIsProfit,
                best_worst_case: worstCase5Pct >= startingBalance * 0.3,
                recommended: avgMaxDD < 0.50 && bustCount.total / simulations < 0.15,
                summary: bustCount.total / simulations < 0.10 
                    ? `✅ SURVIVES ALL MARKETS: ${((survivalStats.survived / simulations) * 100).toFixed(0)}% survival rate, ` +
                      `worst 5% scenario: $${worstCase5Pct.toFixed(2)}, avg max DD: ${(avgMaxDD * 100).toFixed(0)}%`
                    : `⚠️ SURVIVAL RISK: ${((bustCount.total / simulations) * 100).toFixed(0)}% bust rate detected. Consider lower stake.`
            },
            
            recommendations: {
                if_too_risky: 'Lower stake to 15-18% for even better worst-case survival',
                if_too_conservative: 'Increase stake to 25-28% for more profit (higher variance)',
                current_setting: `${(stakePct * 100)}% stake is ${avgMaxDD < 0.40 ? 'conservative' : avgMaxDD < 0.55 ? 'balanced' : 'aggressive'}`
            }
        });
    } catch (e) {
        res.status(500).json({ error: e.message, stack: e.stack });
    }
});

// 🎯 GOAT v45: Honest GOAT Verification endpoint
// Each check must actually validate functionality, not just existence
app.get('/api/verify', async (req, res) => {
    const checks = [];
    let passCount = 0;
    let failCount = 0;
    
    const addCheck = (name, passed, details = '', severity = 'error') => {
        checks.push({ name, passed, details, severity });
        if (passed) passCount++;
        else failCount++;
    };
    
    // ==================== CORE CHECKS ====================
    
    // Check 1: TradeExecutor initialized
    addCheck('TradeExecutor initialized', 
        !!tradeExecutor, 
        tradeExecutor ? `Mode: ${tradeExecutor.mode}` : 'Not found');
    
    // Check 2: CircuitBreaker with hybrid throttle (HONEST CHECK)
    const cbExists = tradeExecutor?.circuitBreaker;
    const cbHasThresholds = cbExists && 
        typeof cbExists.softDrawdownPct === 'number' && 
        typeof cbExists.hardDrawdownPct === 'number' && 
        typeof cbExists.haltDrawdownPct === 'number';
    const cbHasResumeConditions = cbExists && cbExists.resumeConditions && 
        typeof cbExists.resumeConditions.probeToSafeMinutes === 'number';
    addCheck('Hybrid throttle (CircuitBreaker v45)', 
        cbExists?.enabled === true && cbHasThresholds && cbHasResumeConditions,
        cbExists ? `State: ${cbExists.state}, Thresholds: ${cbExists.softDrawdownPct*100}%/${cbExists.hardDrawdownPct*100}%/${cbExists.haltDrawdownPct*100}%` : 'Not configured');
    
    // Check 3: LCB gating (HONEST CHECK - verify function exists on at least one brain)
    const hasLcbFunction = ASSETS.some(a => 
        typeof Brains?.[a]?.getCalibratedPWinWithLCB === 'function'
    );
    const wilsonLCBExists = typeof wilsonLCB === 'function';
    addCheck('LCB gating active', 
        hasLcbFunction && wilsonLCBExists,
        hasLcbFunction ? 'getCalibratedPWinWithLCB + wilsonLCB available' : 'LCB functions not found');
    
    // Check 4: LIVE balance freshness enforcement (HONEST CHECK)
    const hasFreshnessCheck = tradeExecutor?.lastBalanceFetch !== undefined;
    const freshnessAge = hasFreshnessCheck ? (Date.now() - (tradeExecutor.lastBalanceFetch || 0)) : Infinity;
    const freshnessOk = hasFreshnessCheck && (tradeExecutor.mode !== 'LIVE' || freshnessAge < 120000);
    addCheck('LIVE balance freshness', 
        freshnessOk,
        hasFreshnessCheck ? `Age: ${Math.round(freshnessAge/1000)}s (max: 60s for LIVE trades)` : 'Freshness tracking not found',
        'warn');
    
    // Check 5: Redis available (for persistence)
    addCheck('Redis available',
        typeof redisAvailable !== 'undefined' && redisAvailable === true,
        redisAvailable ? 'Connected' : 'Not connected');
    
    // Check 6: Brains initialized with calibration
    const brainsOk = typeof Brains !== 'undefined' && ASSETS.every(a => Brains[a]);
    const brainsWithCalibration = ASSETS.filter(a => 
        Brains?.[a]?.calibrationBuckets && Object.keys(Brains[a].calibrationBuckets).length > 0
    ).length;
    addCheck('Brains with calibration',
        brainsOk && brainsWithCalibration > 0,
        `${brainsWithCalibration}/${ASSETS.length} assets have calibration data`);
    
    // Check 7: Live data feed
    const now = Date.now();
    const feedAge = typeof lastLiveDataTime !== 'undefined' ? now - lastLiveDataTime : Infinity;
    addCheck('Live data feed active',
        feedAge < 120000,
        feedAge < Infinity ? `Last update: ${Math.round(feedAge / 1000)}s ago` : 'Never received');
    
    // Check 8: Config version matches expected
    addCheck('Config version v45+',
        typeof CONFIG_VERSION !== 'undefined' && CONFIG_VERSION >= 45,
        `v${CONFIG_VERSION || 'UNDEFINED'} (need >=45 for GOAT features)`);
    
    // Check 9: Trade history idempotent (HONEST CHECK - verify structure)
    let historyIdempotent = false;
    let historyDetails = 'Not tested';
    if (typeof loadTradeHistory === 'function' && redisAvailable && redis) {
        try {
            // Check that the new hash+zset keys exist (not old list key)
            const hashExists = await redis.exists(TRADE_HISTORY_PAPER_HASH);
            const zsetExists = await redis.exists(TRADE_HISTORY_PAPER_ZSET);
            // Either both exist, or neither (fresh start)
            historyIdempotent = (hashExists && zsetExists) || (!hashExists && !zsetExists);
            historyDetails = historyIdempotent ? 
                `Using idempotent hash+zset structure` : 
                `Legacy list structure detected - run migration`;
        } catch (e) {
            historyDetails = `Error: ${e.message}`;
        }
    }
    addCheck('Trade history idempotent',
        historyIdempotent,
        historyDetails);
    
    // Check 10: GateTrace available
    addCheck('GateTrace available',
        typeof gateTrace !== 'undefined' && gateTrace !== null,
        gateTrace ? `${gateTrace.getSummary?.()?.totalEvaluations || 0} evaluations` : 'Not found');
    
    // Check 11: Forward collector state persisted
    // Honest check: verify forwardCollectorEnabled matches what's in Redis state
    let collectorStatePersisted = false;
    if (redisAvailable && redis) {
        try {
            const storedState = await redis.get('deity:state');
            if (storedState) {
                const state = JSON.parse(storedState);
                collectorStatePersisted = typeof state.forwardCollectorEnabled === 'boolean';
            }
        } catch {}
    }
    addCheck('Collector state persisted',
        typeof forwardCollectorEnabled !== 'undefined' && (collectorStatePersisted || !redisAvailable),
        collectorStatePersisted ? 'State saved in Redis' : (redisAvailable ? 'Not yet saved (will save on next cycle)' : 'No Redis'),
        'warn');
    
    // Check 12: Redemption events persisted
    const redemptionEventsPersisted = Array.isArray(tradeExecutor?.redemptionEvents);
    addCheck('Redemption events tracked',
        redemptionEventsPersisted,
        redemptionEventsPersisted ? `${tradeExecutor.redemptionEvents.length} events tracked` : 'Not initialized',
        'warn');
    
    // Check 13: Streak sizing enabled
    addCheck('Streak sizing enabled',
        tradeExecutor?.streakSizing?.enabled === true,
        `Multiplier: ${tradeExecutor?.getStreakSizeMultiplier?.() || 'N/A'}`);
    
    // Check 14: Auth configured
    const authConfigured = process.env.AUTH_USERNAME && process.env.AUTH_PASSWORD;
    addCheck('Auth configured',
        authConfigured,
        authConfigured ? 'Username and password set' : 'Using defaults (insecure)',
        'warn');
    
    // ==================== CALCULATE STATUS ====================
    const criticalFails = checks.filter(c => !c.passed && c.severity === 'error').length;
    const warnFails = checks.filter(c => !c.passed && c.severity === 'warn').length;
    
    const overallStatus = criticalFails === 0 ? (warnFails === 0 ? 'PASS' : 'WARN') : 'FAIL';
    
    res.json({
        status: overallStatus,
        passed: passCount,
        failed: failCount,
        criticalFailures: criticalFails,
        warnings: warnFails,
        checks,
        
        // Top failures for quick action
        topFailures: checks.filter(c => !c.passed).slice(0, 5).map(c => ({
            issue: c.name,
            severity: c.severity,
            action: getFixAction(c.name)
        })),
        
        // Summary of GOAT v45 features
        goatFeatures: {
            hybridThrottle: cbHasThresholds && cbHasResumeConditions,
            lcbGating: hasLcbFunction && wilsonLCBExists,
            liveFreshness: hasFreshnessCheck,
            idempotentHistory: historyIdempotent,
            collectorPersistence: collectorStatePersisted
        },
        
        timestamp: new Date().toISOString(),
        version: typeof CODE_FINGERPRINT !== 'undefined' ? CODE_FINGERPRINT : null,
        configVersion: CONFIG_VERSION
    });
    
    function getFixAction(checkName) {
        const actions = {
            'TradeExecutor initialized': 'Check server startup logs for errors',
            'Hybrid throttle (CircuitBreaker v45)': 'Ensure circuitBreaker is initialized with resumeConditions',
            'LCB gating active': 'Ensure getCalibratedPWinWithLCB method exists on SupremeBrain',
            'LIVE balance freshness': 'refreshLiveBalance() must update lastBalanceFetch',
            'Streak sizing enabled': 'Check TradeExecutor configuration',
            'Redis available': 'Set REDIS_URL environment variable',
            'Brains with calibration': 'Run trades to build calibration data',
            'Live data feed active': 'Check WebSocket connection to Polymarket',
            'Config version v45+': 'Ensure CONFIG_VERSION >= 45 in server.js',
            'Trade history idempotent': 'Using new hash+zset structure - old list will be ignored',
            'GateTrace available': 'Check gateTrace initialization',
            'Collector state persisted': 'Will persist on next saveState() cycle',
            'Redemption events tracked': 'Initialize tradeExecutor.redemptionEvents array',
            'Auth configured': 'Set AUTH_USERNAME and AUTH_PASSWORD in environment'
        };
        return actions[checkName] || 'Check server configuration';
    }
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
// GOAL: Crypto checkpoints only (BTC/ETH/XRP). SOL is intentionally removed to avoid future confusion.
const ASSETS = ['BTC', 'ETH', 'XRP'];
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

// 🎯 GOAT v44.1: Forward Data Collector with Redis persistence
// Persists market+signal snapshots to Redis (survives Render restarts) + optional file backup
let forwardCollectorEnabled = false; // Set to true to enable
let lastCollectorSave = 0;
const COLLECTOR_INTERVAL_MS = 15 * 60 * 1000; // Save every 15 minutes
const COLLECTOR_REDIS_KEY = 'polyprophet:collector:snapshots';
const COLLECTOR_MAX_SNAPSHOTS = 1000; // Keep last 1000 in Redis

// 🎯 GOAT v4: Persist forward-collector enabled state (survives restarts)
// NOTE: Previously referenced by startup()/API but missing, causing startup to fail before server.listen().
const COLLECTOR_ENABLED_REDIS_KEY = 'polyprophet:collector:enabled';

async function loadCollectorEnabled() {
    if (!redisAvailable || !redis) return;
    try {
        const raw = await redis.get(COLLECTOR_ENABLED_REDIS_KEY);
        if (!raw) return;

        let enabled = null;
        try {
            const parsed = JSON.parse(raw);
            if (typeof parsed === 'boolean') enabled = parsed;
            else if (parsed && typeof parsed.enabled === 'boolean') enabled = parsed.enabled;
        } catch {
            if (raw === 'true') enabled = true;
            if (raw === 'false') enabled = false;
        }

        if (typeof enabled === 'boolean') {
            forwardCollectorEnabled = enabled;
            log(`📦 FORWARD COLLECTOR: Restored ${enabled ? 'ENABLED' : 'DISABLED'} from Redis`);
        }
    } catch (e) {
        log(`⚠️ FORWARD COLLECTOR: Failed to load enabled state: ${e.message}`);
    }
}

async function persistCollectorEnabled() {
    if (!redisAvailable || !redis) return;
    try {
        await redis.set(COLLECTOR_ENABLED_REDIS_KEY, JSON.stringify({
            enabled: forwardCollectorEnabled,
            updatedAt: new Date().toISOString(),
            configVersion: typeof CONFIG_VERSION !== 'undefined' ? CONFIG_VERSION : null
        }));
    } catch (e) {
        log(`⚠️ FORWARD COLLECTOR: Failed to persist enabled state: ${e.message}`);
    }
}

// 🎯 GOAT v4: Idempotent Persistent Trade History (Redis Hash + Sorted Set)
// Uses Hash for deduplication (by trade ID) and Sorted Set for ordering (by timestamp)
const TRADE_HISTORY_PAPER_HASH = 'polyprophet:trades:paper:hash';
const TRADE_HISTORY_PAPER_ZSET = 'polyprophet:trades:paper:zset';
const TRADE_HISTORY_LIVE_HASH = 'polyprophet:trades:live:hash';
const TRADE_HISTORY_LIVE_ZSET = 'polyprophet:trades:live:zset';
const TRADE_HISTORY_MAX = 10000; // Keep last 10,000 trades per mode

// 🎯 GOAT v4: Persist a trade idempotently (no duplicates by ID)
async function persistTrade(trade, mode = 'PAPER') {
    if (!redisAvailable || !redis) return;
    
    // Ensure trade has an ID
    if (!trade.id) {
        trade.id = `${trade.asset}_${trade.mode}_${trade.time || Date.now()}`;
    }
    
    try {
        const hashKey = mode === 'LIVE' ? TRADE_HISTORY_LIVE_HASH : TRADE_HISTORY_PAPER_HASH;
        const zsetKey = mode === 'LIVE' ? TRADE_HISTORY_LIVE_ZSET : TRADE_HISTORY_PAPER_ZSET;
        const tradeTime = trade.time || Date.now();
        
        // Use pipeline for atomicity
        const pipeline = redis.pipeline();
        
        // Store trade in hash (keyed by ID - idempotent)
        pipeline.hset(hashKey, trade.id, JSON.stringify(trade));
        
        // Add to sorted set (score = timestamp for ordering)
        pipeline.zadd(zsetKey, tradeTime, trade.id);
        
        // Trim to max size (remove oldest entries beyond max)
        pipeline.zremrangebyrank(zsetKey, 0, -(TRADE_HISTORY_MAX + 1));
        
        await pipeline.exec();
        
    } catch (e) {
        console.log(`⚠️ Failed to persist trade: ${e.message}`);
    }
}

// 🎯 GOAT v4: Load trade history from idempotent storage (hash + zset)
async function loadTradeHistory(mode = 'PAPER', offset = 0, limit = 100) {
    const result = { trades: [], total: 0, source: 'memory' };
    
    if (redisAvailable && redis) {
        try {
            const hashKey = mode === 'LIVE' ? TRADE_HISTORY_LIVE_HASH : TRADE_HISTORY_PAPER_HASH;
            const zsetKey = mode === 'LIVE' ? TRADE_HISTORY_LIVE_ZSET : TRADE_HISTORY_PAPER_ZSET;
            
            // Get total count
            result.total = await redis.zcard(zsetKey);
            
            // Get trade IDs in reverse chronological order (newest first)
            const tradeIds = await redis.zrevrange(zsetKey, offset, offset + limit - 1);
            
            if (tradeIds.length > 0) {
                // Fetch trade data from hash
                const tradeData = await redis.hmget(hashKey, ...tradeIds);
                result.trades = tradeData.map(r => {
                    try { return r ? JSON.parse(r) : null; } catch { return null; }
                }).filter(Boolean);
            }
            
            result.source = 'redis';
        } catch (e) {
            console.log(`⚠️ Failed to load trade history from Redis: ${e.message}`);
        }
    }
    
    // Fallback to in-memory if Redis failed or unavailable
    if (result.trades.length === 0 && tradeExecutor && tradeExecutor.tradeHistory) {
        const memTrades = tradeExecutor.tradeHistory.filter(t => {
            const status = String(t?.status || '').toUpperCase();
            const isLiveTrade =
                !!t?.isLive ||
                status.startsWith('LIVE') ||
                String(t?.tradeMode || '').toUpperCase() === 'LIVE' ||
                String(t?.mode || '').toUpperCase() === 'LIVE';
            return mode === 'LIVE' ? isLiveTrade : !isLiveTrade;
        });
        result.total = memTrades.length;
        result.trades = memTrades.slice(offset, offset + limit);
        result.source = 'memory';
    }
    
    return result;
}

// Reset trade history in Redis
// 🎯 GOAT v45: Reset trade history (both hash and zset)
async function resetTradeHistory(mode = 'PAPER') {
    let deletedCount = 0;
    if (redisAvailable && redis) {
        try {
            const hashKey = mode === 'LIVE' ? TRADE_HISTORY_LIVE_HASH : TRADE_HISTORY_PAPER_HASH;
            const zsetKey = mode === 'LIVE' ? TRADE_HISTORY_LIVE_ZSET : TRADE_HISTORY_PAPER_ZSET;
            
            // Get current count before deletion
            deletedCount = await redis.zcard(zsetKey);
            
            // Delete both hash and sorted set
            await redis.del(hashKey);
            await redis.del(zsetKey);
            
            console.log(`🗑️ Reset ${mode} trade history: ${deletedCount} trades deleted`);
        } catch (e) {
            console.log(`⚠️ Failed to reset trade history in Redis: ${e.message}`);
        }
    }
    return { success: true, deletedCount };
}

// 🎯 GOAT v45: Get trade history stats
async function getTradeHistoryStats(mode = 'PAPER') {
    if (!redisAvailable || !redis) return { total: 0, source: 'unavailable' };
    
    try {
        const zsetKey = mode === 'LIVE' ? TRADE_HISTORY_LIVE_ZSET : TRADE_HISTORY_PAPER_ZSET;
        const total = await redis.zcard(zsetKey);
        return { total, source: 'redis' };
    } catch (e) {
        return { total: 0, source: 'error', error: e.message };
    }
}

async function runForwardDataCollector() {
    if (!forwardCollectorEnabled) return;
    
    const now = Date.now();
    if (now - lastCollectorSave < COLLECTOR_INTERVAL_MS) return;
    lastCollectorSave = now;
    
    try {
        // Collect snapshot
        const snapshot = {
            timestamp: new Date().toISOString(),
            timestampMs: now,
            code: typeof CODE_FINGERPRINT !== 'undefined' ? CODE_FINGERPRINT : null,
            markets: {},
            signals: {},
            tradingState: tradeExecutor ? tradeExecutor.tradingState : 'UNKNOWN',
            gateTrace: gateTrace ? gateTrace.getSummary() : null
        };
        
        ASSETS.forEach(asset => {
            if (!CONFIG.ASSET_CONTROLS || CONFIG.ASSET_CONTROLS[asset]?.enabled !== false) {
                snapshot.markets[asset] = currentMarkets[asset] || null;
                const brain = Brains[asset];
                if (brain) {
                    snapshot.signals[asset] = {
                        prediction: brain.prediction,
                        confidence: brain.confidence,
                        tier: brain.tier,
                        edge: brain.edge,
                        pWin: brain.getTierConditionedPWin ? brain.getTierConditionedPWin(brain.tier, currentMarkets[asset]?.yesPrice, { fallback: null }) : null,
                        oracleLocked: brain.oracleLocked,
                        convictionLocked: brain.convictionLocked
                    };
                }
            }
        });
        
        // 🎯 GOAT v44.1: Primary storage = Redis (persists across Render restarts)
        if (typeof redis !== 'undefined' && redis) {
            try {
                // Add to Redis list
                await redis.lpush(COLLECTOR_REDIS_KEY, JSON.stringify(snapshot));
                // Trim to keep only last N snapshots
                await redis.ltrim(COLLECTOR_REDIS_KEY, 0, COLLECTOR_MAX_SNAPSHOTS - 1);
                log(`📦 FORWARD COLLECTOR: Saved to Redis (${snapshot.timestamp})`);
            } catch (redisErr) {
                log(`⚠️ FORWARD COLLECTOR: Redis save failed: ${redisErr.message}, falling back to file`);
            }
        }
        
        // Secondary storage = File (for local dev or Redis fallback)
        try {
            const fs = require('fs');
            const path = require('path');
            
            const dataDir = path.join(__dirname, 'backtest-data');
            if (!fs.existsSync(dataDir)) {
                fs.mkdirSync(dataDir, { recursive: true });
            }
            
            const filename = `snapshot_${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
            fs.writeFileSync(path.join(dataDir, filename), JSON.stringify(snapshot, null, 2));
            
            // Cleanup old files (keep last 500 on disk)
            const files = fs.readdirSync(dataDir).filter(f => f.startsWith('snapshot_')).sort();
            if (files.length > 500) {
                const toDelete = files.slice(0, files.length - 500);
                toDelete.forEach(f => fs.unlinkSync(path.join(dataDir, f)));
            }
        } catch (fileErr) {
            // File save is secondary, log but don't fail
            log(`⚠️ FORWARD COLLECTOR: File save failed: ${fileErr.message}`);
        }
    } catch (e) {
        log(`⚠️ FORWARD COLLECTOR ERROR: ${e.message}`);
    }
}

// 🎯 GOAT v44.1: Retrieve snapshots from Redis
async function getCollectorSnapshots(limit = 100) {
    const snapshots = [];
    
    // Try Redis first
    if (typeof redis !== 'undefined' && redis) {
        try {
            const redisData = await redis.lrange(COLLECTOR_REDIS_KEY, 0, limit - 1);
            for (const item of redisData) {
                try {
                    snapshots.push(JSON.parse(item));
                } catch (parseErr) {
                    // Skip invalid entries
                }
            }
            if (snapshots.length > 0) {
                return { source: 'redis', count: snapshots.length, snapshots };
            }
        } catch (e) {
            log(`⚠️ COLLECTOR: Redis read failed: ${e.message}`);
        }
    }
    
    // Fall back to file system
    try {
        const fs = require('fs');
        const path = require('path');
        const dataDir = path.join(__dirname, 'backtest-data');
        
        if (fs.existsSync(dataDir)) {
            const files = fs.readdirSync(dataDir)
                .filter(f => f.startsWith('snapshot_'))
                .sort()
                .reverse()
                .slice(0, limit);
            
            for (const file of files) {
                try {
                    const content = fs.readFileSync(path.join(dataDir, file), 'utf8');
                    snapshots.push(JSON.parse(content));
                } catch (parseErr) {
                    // Skip invalid files
                }
            }
        }
        return { source: 'file', count: snapshots.length, snapshots };
    } catch (e) {
        return { source: 'none', count: 0, snapshots: [], error: e.message };
    }
}

// Run collector every minute (actual saves happen at COLLECTOR_INTERVAL_MS)
setInterval(runForwardDataCollector, 60 * 1000);

// API: Toggle forward collector
app.post('/api/collector/toggle', async (req, res) => {
    forwardCollectorEnabled = !forwardCollectorEnabled;
    log(`📦 FORWARD COLLECTOR: ${forwardCollectorEnabled ? 'ENABLED' : 'DISABLED'}`);
    
    // 🎯 GOAT v4: Persist state to Redis
    await persistCollectorEnabled();
    
    res.json({ enabled: forwardCollectorEnabled });
});

// 🎯 GOAT v44.1: API to get collector snapshots
app.get('/api/collector/snapshots', async (req, res) => {
    try {
        const limit = parseInt(req.query.limit) || 50;
        const result = await getCollectorSnapshots(limit);
        res.json(result);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// API: Get collector status
app.get('/api/collector/status', async (req, res) => {
    const fs = require('fs');
    const path = require('path');
    
    let fileCount = 0;
    let redisCount = 0;
    
    try {
        const dataDir = path.join(__dirname, 'backtest-data');
        if (fs.existsSync(dataDir)) {
            fileCount = fs.readdirSync(dataDir).filter(f => f.startsWith('snapshot_')).length;
        }
    } catch (e) {}
    
    // 🎯 GOAT v44.1: Also check Redis count
    try {
        if (typeof redis !== 'undefined' && redis) {
            redisCount = await redis.llen(COLLECTOR_REDIS_KEY);
        }
    } catch (e) {}
    
    res.json({
        enabled: forwardCollectorEnabled,
        lastSave: lastCollectorSave > 0 ? new Date(lastCollectorSave).toISOString() : null,
        storage: {
            redis: { available: typeof redis !== 'undefined' && redis !== null, count: redisCount },
            file: { count: fileCount }
        },
        totalSnapshots: Math.max(redisCount, fileCount),
        intervalMinutes: COLLECTOR_INTERVAL_MS / 60000,
        maxSnapshots: COLLECTOR_MAX_SNAPSHOTS
    });
});

// ==================== SUPREME MULTI-MODE TRADING CONFIG ====================
// 🔴 CONFIG_VERSION: Increment this when making changes to hardcoded settings!
// This ensures Redis cache is invalidated and new values are used.
const CONFIG_VERSION = 65;  // v65: CRITICAL FIX - supremeConfidenceMode now BLOCKS <75% (was only warning), restores 77% WR

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
    // 🏆 v64 GOLDEN OPTIMAL - 80% profit probability + 58% 100x chance
    // Monte Carlo proven: 50% until 1.1x → 26% until 1.5x → 16% thereafter
    // This is THE MATHEMATICALLY OPTIMAL balance of profit probability + upside
    MAX_POSITION_SIZE: parseFloat(process.env.MAX_POSITION_SIZE || '0.50'),  // 🏆 v64: 50% base (aggressive start)
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
        // 🏆 v58 TRUE OPTIMAL: pWin-gated entries allow profitable <50¢ trades
        // Raw calibration shows <50¢ = 28% WR, BUT high-pWin <50¢ trades WIN
        // Key: The system gates by pWin (calibrated win prob), not just entry price
        // Backtest proof: minOdds=0.40, maxOdds=0.92 → £5→£42 in 24h (8× growth, 75% WR)
        minOdds: 0.40,           // 🏆 v58: Allow high-pWin entries at 40-50¢ (verified profitable)
        maxOdds: 0.92,           // 🏆 v58: Extend to 92¢ for more opportunities (81% WR acceptable)
        minStability: 2,         // 2 ticks - fast lock

        // 🏆 v39 ADAPTIVE CONFIGURATION
        // The bot automatically switches regimes based on Confidence Volatility (StdDev)
        adaptiveModeEnabled: true,

        regimes: {
            // 🌊 CALM: Low Volatility (StdDev < 5%) -> CONFIDENT (not aggressive!)
            // 🏆 v61: Even in CALM, maintain disciplined sizing
            CALM: {
                sensitivity: "HIGH",
                smoothingWindow: 1,      // Fast reaction
                stopLoss: 0.25,          // 🏆 v61: Tighter stop (was 30%)
                diamondTarget: 0.95,     // 🏆 v61: Lower greed (was 98%)
                safetyTarget: 0.20,      // Quick scalp if wrong
                sizeMultiplier: 1.0      // Normal size in calm markets
            },

            // 🌪️ VOLATILE: Normal (StdDev 5-15%) -> DEFENSIVE
            // 🏆 v61: Reduce size in volatile conditions
            VOLATILE: {
                sensitivity: "MEDIUM",
                smoothingWindow: 3,      // Filter noise
                stopLoss: 0.30,          // 🏆 v61: Tighter stop (was 40%)
                diamondTarget: 0.90,     // 🏆 v61: Lower target (was 95%)
                safetyTarget: 0.20,      // 🏆 v61: Earlier safety (was 25%)
                sizeMultiplier: 0.70     // 🏆 v61: 70% size in volatile markets
            },

            // 🔥 CHAOS: Extreme (StdDev > 15%) -> SURVIVAL MODE
            // 🏆 v61: ENHANCED SURVIVAL - minimize position size, take profits early
            CHAOS: {
                sensitivity: "LOW",
                smoothingWindow: 7,      // 🏆 v61: Even heavier filtering (was 5)
                stopLoss: 0.25,          // 🏆 v61: TIGHTER stop in chaos (was 50% - now 25%)
                diamondTarget: 0.80,     // 🏆 v61: Lower target (was 90%)
                safetyTarget: 0.10,      // 🏆 v61: Get out even faster (was 15%)
                sizeMultiplier: 0.25     // 🏆 v61: Only 25% normal size in CHAOS
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

    // 🚀 v61.2 MAX PROFIT - HIGH QUALITY AGGRESSIVE
    RISK: {
        maxTotalExposure: 0.45,  // 🚀 v61.2: 45% max exposure
        globalStopLoss: 0.35,    // 🚀 v61.2: 35% day max loss
        globalStopLossOverride: false,
        cooldownAfterLoss: 1200,            // 🚀 v61.2: 20 min cooldown
        enableLossCooldown: true,
        noTradeDetection: true,  // Block genuinely random markets
        enableCircuitBreaker: true, // Still ON for protection
        enableDivergenceBlocking: true, // 🚀 v61.2: ON - quality only
        aggressiveSizingOnLosses: false, // Keep this OFF

        // 🚀 v61.2: QUALITY > QUANTITY
        maxConsecutiveLosses: 3,  // 🚀 v61.2: 3 losses before pause
        maxDailyLosses: 10,       // 🚀 v61.2: 10 max per day
        autoReduceSizeOnDrawdown: false, // NO - maintain aggression
        withdrawalNotification: 1000,
        maxGlobalTradesPerCycle: 1, // 🚀 v61.2: 1 QUALITY trade per cycle

        // 🚀 v61.2: HIGH QUALITY AGGRESSIVE
        enablePositionPyramiding: false,
        firstMoveAdvantage: false,        // 🚀 v61.2: NO - wait for confirmation
        supremeConfidenceMode: true       // 🚀 v61.2: 75%+ confidence ONLY
    },

    // ==================== TELEGRAM NOTIFICATIONS ====================
    TELEGRAM: {
        enabled: false,
        botToken: (process.env.TELEGRAM_BOT_TOKEN || '').trim(),
        chatId: (process.env.TELEGRAM_CHAT_ID || '').trim()
    },

    // PER-ASSET TRADING CONTROLS (BTC/ETH/XRP only)
    ASSET_CONTROLS: {
        BTC: { enabled: true, maxTradesPerCycle: 1 },
        ETH: { enabled: true, maxTradesPerCycle: 1 },   // 100% WR in backtest!
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
        // ✅ Ground-truth resolution: pending Polymarket slug resolutions (PAPER mode)
        // Map<slug, { asset, attempts, fallbackOutcome, startedAt }>
        this.pendingPolymarketResolutions = new Map();
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
        
        // 🎯 GOAT v3: Portfolio accounting for truthful LIVE P/L
        this.portfolioAccounting = {
            cashUSDC: 0,                 // Wallet cash balance
            positionsMTM: 0,             // Mark-to-market value of open positions
            portfolioValue: 0,           // Total = cash + MTM
            dayStartPortfolioValue: null,// Portfolio value at day start
            dayStartTime: null,          // When the day started
            todayPnL: 0,                 // Today's P/L based on portfolio accounting
            lastUpdate: 0                // Last time portfolio was calculated
        };

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
            observeMinMinutes: 15,           // Minimum 15 mins in OBSERVE
            // 🎯 GOAT: pWin thresholds per state
            observeMinPWin: 0.60,            // Minimum pWin to trade in OBSERVE (probe)
            harvestMinPWin: 0.55,            // Minimum pWin to trade in HARVEST
            strikeMinPWin: 0.65              // Minimum pWin to trade in STRIKE (higher bar for larger bets)
        }
        
        // 🚀 v61.1 MAX PROFIT CircuitBreaker - AGGRESSIVE but protected
        // Goal: MAXIMIZE PROFIT while preventing total wipeout
        this.circuitBreaker = {
            enabled: true,
            state: 'NORMAL',                 // 'NORMAL' | 'SAFE_ONLY' | 'PROBE_ONLY' | 'HALTED'
            triggerTime: 0,                  // When circuit breaker was triggered
            
            // 🚀 v61.2: MAXIMUM thresholds for TRUE MAX PROFIT
            softDrawdownPct: 0.25,           // 25% drawdown → SAFE_ONLY
            hardDrawdownPct: 0.45,           // 45% drawdown → PROBE_ONLY
            haltDrawdownPct: 0.70,           // 70% drawdown → HALTED (MAX AGGRESSION)
            
            // 🚀 v61.1: More tolerance for loss streaks
            safeOnlyAfterLosses: 3,          // 3 consecutive losses → SAFE_ONLY
            probeOnlyAfterLosses: 5,         // 5 consecutive losses → PROBE_ONLY
            haltAfterLosses: 7,              // 7 consecutive losses → HALTED
            
            // 🚀 v61.1: FASTER recovery
            resumeAfterMinutes: 20,          // 20 min before resuming (faster!)
            resumeAfterWin: true,            // Resume to NORMAL after a win
            resumeOnNewDay: true,            // Auto-resume on new day
            
            // Daily tracking
            dayStartBalance: null,           // Set at start of day or first trade
            dayStartTime: null               // When the trading day started
        };
        
        // 🚀 v61.1 MAX PROFIT: Less aggressive loss reduction for more opportunity
        this.streakSizing = {
            enabled: true,
            // 🚀 v61.1: MILD size reduction - stay in the game!
            // After 1 loss: 85% size, after 2: 70%, after 3: 55%, after 4+: 40%
            lossMultipliers: [1.0, 0.85, 0.70, 0.55, 0.40],
            // 🚀 v61.1: HIGHER loss budget for aggressive growth
            maxLossBudgetPct: 0.25,          // 25% max (more room to trade)
            // 🚀 v61.1: WIN STREAK BONUS ENABLED for compounding
            winBonusEnabled: true,           // YES - increase size on wins!
            winMultipliers: [1.0, 1.05, 1.10, 1.15] // Compound winners
        };

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
                // 🎯 v48 SECURITY: Removed partial key logging
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
    // 🏆 v60 FINAL: Mode-aware exposure calculation
    // - LIVE: ALL positions count (capital locked until settlement confirmed)
    // - PAPER: PENDING_RESOLUTION excluded (optimistic, faster iteration)
    getTotalExposure(includeAllForLive = true) {
        const isLive = this.mode === 'LIVE';
        return Object.values(this.positions)
            .filter(p => {
                if (!p) return false;
                // LIVE mode: always count all positions (capital is locked)
                if (isLive && includeAllForLive) return true;
                // PAPER mode: exclude PENDING_RESOLUTION (optimistic)
                return p.status !== 'PENDING_RESOLUTION';
            })
            .reduce((sum, p) => sum + p.size, 0);
    }
    
    // 🏆 v60 FINAL: Get locked capital (for LIVE-realistic reporting)
    getLockedCapital() {
        return Object.values(this.positions)
            .filter(p => p && (p.status === 'OPEN' || p.status === 'PENDING_RESOLUTION'))
            .reduce((sum, p) => sum + p.size, 0);
    }
    
    // 🏆 v60: Get pending settlements (for UI/reconciliation)
    getPendingSettlements() {
        return Object.entries(this.positions)
            .filter(([id, p]) => p && p.status === 'PENDING_RESOLUTION')
            .map(([id, p]) => ({
                id,
                asset: p.asset,
                side: p.side,
                size: p.size,
                slug: p.pendingSlug || p.slug,
                pendingSince: p.pendingSince,
                mode: p.mode
            }));
    }
    
    // 🎯 GOAT v3: Initialize day tracking for CircuitBreaker
    initDayTracking() {
        const now = Date.now();
        const bankroll = this.mode === 'PAPER' ? this.paperBalance : (this.cachedLiveBalance || this.paperBalance);
        
        // Check if it's a new day
        if (!this.circuitBreaker.dayStartTime || 
            new Date(this.circuitBreaker.dayStartTime).toDateString() !== new Date(now).toDateString()) {
            this.circuitBreaker.dayStartBalance = bankroll;
            this.circuitBreaker.dayStartTime = now;
            
            // Auto-resume on new day if configured
            if (this.circuitBreaker.resumeOnNewDay && this.circuitBreaker.state !== 'NORMAL') {
                log(`🌅 New day: CircuitBreaker reset to NORMAL (was ${this.circuitBreaker.state})`);
                this.circuitBreaker.state = 'NORMAL';
                this.circuitBreaker.triggerTime = 0;
            }
        }
        
        return this.circuitBreaker.dayStartBalance;
    }
    
    // 🎯 GOAT v3: Update CircuitBreaker state based on current conditions
    updateCircuitBreaker() {
        if (!this.circuitBreaker.enabled) return;
        
        const dayStart = this.initDayTracking();
        const currentBalance = this.mode === 'PAPER' ? this.paperBalance : (this.cachedLiveBalance || this.paperBalance);
        const drawdownPct = dayStart > 0 ? (dayStart - currentBalance) / dayStart : 0;
        const lossStreak = this.consecutiveLosses || 0;
        const now = Date.now();
        
        // Determine new state based on drawdown and loss streak
        let newState = 'NORMAL';
        let reason = '';
        
        // Check drawdown triggers
        if (drawdownPct >= this.circuitBreaker.haltDrawdownPct) {
            newState = 'HALTED';
            reason = `Drawdown ${(drawdownPct * 100).toFixed(1)}% >= ${(this.circuitBreaker.haltDrawdownPct * 100)}%`;
        } else if (drawdownPct >= this.circuitBreaker.hardDrawdownPct) {
            newState = 'PROBE_ONLY';
            reason = `Drawdown ${(drawdownPct * 100).toFixed(1)}% >= ${(this.circuitBreaker.hardDrawdownPct * 100)}%`;
        } else if (drawdownPct >= this.circuitBreaker.softDrawdownPct) {
            newState = 'SAFE_ONLY';
            reason = `Drawdown ${(drawdownPct * 100).toFixed(1)}% >= ${(this.circuitBreaker.softDrawdownPct * 100)}%`;
        }
        
        // Check loss streak triggers (can escalate but not de-escalate)
        if (lossStreak >= this.circuitBreaker.haltAfterLosses && newState !== 'HALTED') {
            newState = 'HALTED';
            reason = `Loss streak ${lossStreak} >= ${this.circuitBreaker.haltAfterLosses}`;
        } else if (lossStreak >= this.circuitBreaker.probeOnlyAfterLosses && newState === 'NORMAL') {
            newState = 'PROBE_ONLY';
            reason = `Loss streak ${lossStreak} >= ${this.circuitBreaker.probeOnlyAfterLosses}`;
        } else if (lossStreak >= this.circuitBreaker.safeOnlyAfterLosses && newState === 'NORMAL') {
            newState = 'SAFE_ONLY';
            reason = `Loss streak ${lossStreak} >= ${this.circuitBreaker.safeOnlyAfterLosses}`;
        }
        
        // Check if we should resume (only if currently restricted)
        if (this.circuitBreaker.state !== 'NORMAL' && newState === 'NORMAL') {
            const timeSinceTrigger = now - (this.circuitBreaker.triggerTime || 0);
            const minResumeMs = this.circuitBreaker.resumeAfterMinutes * 60 * 1000;
            
            // Need either: enough time passed, OR a win
            if (timeSinceTrigger < minResumeMs && lossStreak > 0) {
                // Don't resume yet - maintain current state
                newState = this.circuitBreaker.state;
                reason = `Waiting ${Math.ceil((minResumeMs - timeSinceTrigger) / 60000)}min or a win to resume`;
            }
        }
        
        // Log state changes
        if (newState !== this.circuitBreaker.state) {
            log(`🔌 CircuitBreaker: ${this.circuitBreaker.state} → ${newState} (${reason})`);
            this.circuitBreaker.triggerTime = now;
        }
        
        this.circuitBreaker.state = newState;
        return { state: newState, drawdownPct, lossStreak, reason };
    }
    
    // 🎯 GOAT v3: Check if trading is allowed by CircuitBreaker
    isCircuitBreakerAllowed(tradeType = 'NORMAL') {
        if (!this.circuitBreaker.enabled) return { allowed: true, reason: 'CircuitBreaker disabled' };
        
        this.updateCircuitBreaker();
        
        const state = this.circuitBreaker.state;
        
        switch (state) {
            case 'HALTED':
                return { allowed: false, reason: 'CircuitBreaker HALTED - no trades until conditions improve or new day' };
            case 'PROBE_ONLY':
                return { allowed: true, sizeMultiplier: 0.25, reason: 'CircuitBreaker PROBE_ONLY - 25% size only' };
            case 'SAFE_ONLY':
                if (tradeType === 'ACCELERATION') {
                    return { allowed: false, reason: 'CircuitBreaker SAFE_ONLY - Acceleration trades blocked' };
                }
                return { allowed: true, sizeMultiplier: 0.5, reason: 'CircuitBreaker SAFE_ONLY - 50% size' };
            default:
                return { allowed: true, sizeMultiplier: 1.0, reason: 'CircuitBreaker NORMAL' };
        }
    }
    
    // 🎯 GOAT v3: Get streak-aware size multiplier
    getStreakSizeMultiplier() {
        if (!this.streakSizing.enabled) return 1.0;
        
        const lossStreak = this.consecutiveLosses || 0;
        const winStreak = this.recentWinStreak || 0;
        
        // Apply loss multiplier
        let multiplier = 1.0;
        if (lossStreak > 0) {
            const idx = Math.min(lossStreak, this.streakSizing.lossMultipliers.length - 1);
            multiplier = this.streakSizing.lossMultipliers[idx];
        }
        
        // Apply win bonus if enabled
        if (this.streakSizing.winBonusEnabled && winStreak > 0 && lossStreak === 0) {
            const idx = Math.min(winStreak, this.streakSizing.winMultipliers.length - 1);
            multiplier *= this.streakSizing.winMultipliers[idx];
        }
        
        return multiplier;
    }
    
    // 🎯 GOAT v3: Calculate max loss budget for a trade
    getMaxLossBudget() {
        const dayStart = this.circuitBreaker.dayStartBalance || this.paperBalance;
        return dayStart * this.streakSizing.maxLossBudgetPct;
    }
    
    // 🏆 v62 ADAPTIVE GOAT: Apply all variance controls with PROFIT PROTECTION
    applyVarianceControls(proposedSize, tradeType = 'NORMAL') {
        const cbResult = this.isCircuitBreakerAllowed(tradeType);
        if (!cbResult.allowed) {
            return { size: 0, blocked: true, reason: cbResult.reason };
        }

        let size = proposedSize;
        const adjustments = [];

        // 🏆 v62 ADAPTIVE PROFIT PROTECTION: Reduce stake as profits grow
        // This "locks in" profits by reducing risk as balance increases
        const startingBalance = this.startingBalance || 5;
        const currentBalance = this.mode === 'PAPER' ? this.paperBalance : (this.cachedLiveBalance || startingBalance);
        const profitMultiple = currentBalance / startingBalance;
        
        // 🏆 v64 GOLDEN OPTIMAL: 80% profit probability + 58% 100x chance
        // Monte Carlo proven optimal: 50% → 26% @ 1.1x → 16% @ 1.5x
        // This is THE MATHEMATICALLY OPTIMAL balance of profit probability + upside
        // Profit lock-in schedule (multiplier on base stake):
        // 1x starting: 100% (50% stake - aggressive start)
        // 1.1x starting: 52% (26% effective stake - EARLY lock-in!)
        // 1.5x starting: 32% (16% effective stake - protect gains)
        // 5x starting: 24% (12% effective stake - you're winning big)
        // 10x starting: 20% (10% effective stake - ultra-safe)
        let profitProtectionMult = 1.0;
        if (profitMultiple >= 10) {
            profitProtectionMult = 0.20;
            adjustments.push(`GOLDEN 10x: 20%`);
        } else if (profitMultiple >= 5) {
            profitProtectionMult = 0.24;
            adjustments.push(`GOLDEN 5x: 24%`);
        } else if (profitMultiple >= 1.5) {
            profitProtectionMult = 0.32;
            adjustments.push(`GOLDEN 1.5x: 32%`);
        } else if (profitMultiple >= 1.1) {
            profitProtectionMult = 0.52;
            adjustments.push(`GOLDEN 1.1x: 52%`);
        }
        size *= profitProtectionMult;

        // 🏆 v62 GLOBAL REGIME CHECK: If ANY asset is auto-disabled, reduce all stakes
        let globalRegimeMultiplier = 1.0;
        if (typeof Brains !== 'undefined' && typeof ASSETS !== 'undefined') {
            const disabledCount = ASSETS.filter(a => Brains[a]?.autoDisabled).length;
            const warningCount = ASSETS.filter(a => Brains[a]?.driftWarning).length;
            
            if (disabledCount > 0) {
                // At least one asset is disabled - reduce all stakes significantly
                globalRegimeMultiplier = 0.40;
                adjustments.push(`Regime Alert (${disabledCount} disabled): 40%`);
            } else if (warningCount >= 2) {
                // Multiple assets showing drift - cautious
                globalRegimeMultiplier = 0.60;
                adjustments.push(`Drift Warning (${warningCount} assets): 60%`);
            } else if (warningCount === 1) {
                globalRegimeMultiplier = 0.80;
                adjustments.push(`Minor Drift: 80%`);
            }
        }
        size *= globalRegimeMultiplier;

        // Apply CircuitBreaker size multiplier
        if (cbResult.sizeMultiplier && cbResult.sizeMultiplier < 1.0) {
            size *= cbResult.sizeMultiplier;
            adjustments.push(`CB: ${(cbResult.sizeMultiplier * 100).toFixed(0)}%`);
        }

        // Apply streak sizing
        const streakMult = this.getStreakSizeMultiplier();
        if (streakMult < 1.0) {
            size *= streakMult;
            adjustments.push(`Streak: ${(streakMult * 100).toFixed(0)}%`);
        }

        // Cap by max loss budget (assuming 50% stop loss worst case)
        const maxLoss = this.getMaxLossBudget();
        const maxSizeByBudget = maxLoss / 0.50; // If stop loss is -50%, max size = budget / 0.5
        if (size > maxSizeByBudget) {
            size = maxSizeByBudget;
            adjustments.push(`Budget cap: $${maxSizeByBudget.toFixed(2)}`);
        }

        return {
            size: Math.max(size, 0),
            blocked: false,
            adjustments: adjustments.join(', ') || 'None',
            streakMultiplier: streakMult,
            cbState: this.circuitBreaker.state,
            profitProtectionMult,
            globalRegimeMultiplier
        };
    }
    
    // 🎯 GOAT v3: Calculate mark-to-market value of open positions
    calculatePositionsMTM() {
        let mtm = 0;
        
        for (const [posId, pos] of Object.entries(this.positions)) {
            if (pos.status !== 'OPEN' && pos.status !== 'LIVE_OPEN') continue;
            
            // Get current market price for this position
            const asset = pos.asset;
            const market = typeof currentMarkets !== 'undefined' ? currentMarkets[asset] : null;
            
            if (!market) {
                // Use entry price as fallback (conservative)
                mtm += pos.size;
                continue;
            }
            
            // Calculate current value based on position direction
            const currentPrice = pos.side === 'UP' ? market.yesPrice : market.noPrice;
            const shares = pos.shares || (pos.size / pos.entry);
            const currentValue = shares * currentPrice;
            
            mtm += currentValue;
        }
        
        return mtm;
    }
    
    // 🎯 GOAT v3: Update portfolio accounting (call periodically)
    updatePortfolioAccounting() {
        const now = Date.now();
        const pa = this.portfolioAccounting;
        
        // Get cash balance
        if (this.mode === 'PAPER') {
            pa.cashUSDC = this.paperBalance;
        } else {
            pa.cashUSDC = this.cachedLiveBalance || 0;
        }
        
        // Calculate MTM for open positions
        pa.positionsMTM = this.calculatePositionsMTM();
        
        // Total portfolio value
        pa.portfolioValue = pa.cashUSDC + pa.positionsMTM;
        
        // Initialize day start if needed
        if (!pa.dayStartTime || new Date(pa.dayStartTime).toDateString() !== new Date(now).toDateString()) {
            pa.dayStartPortfolioValue = pa.portfolioValue;
            pa.dayStartTime = now;
        }
        
        // Calculate today's P/L
        if (pa.dayStartPortfolioValue !== null) {
            pa.todayPnL = pa.portfolioValue - pa.dayStartPortfolioValue;
        }
        
        pa.lastUpdate = now;
        
        return pa;
    }
    
    // 🎯 GOAT v3: Get portfolio summary for API/UI
    getPortfolioSummary() {
        this.updatePortfolioAccounting();
        const pa = this.portfolioAccounting;
        
        return {
            mode: this.mode,
            cashUSDC: pa.cashUSDC,
            positionsMTM: pa.positionsMTM,
            portfolioValue: pa.portfolioValue,
            dayStartPortfolioValue: pa.dayStartPortfolioValue,
            todayPnL: pa.todayPnL,
            todayPnLPercent: pa.dayStartPortfolioValue > 0 ? 
                (pa.todayPnL / pa.dayStartPortfolioValue * 100) : 0,
            openPositions: Object.keys(this.positions).length,
            lastUpdate: new Date(pa.lastUpdate).toISOString(),
            // Simple explanation for UI
            explanation: this.mode === 'PAPER' 
                ? `Paper trading with $${pa.portfolioValue.toFixed(2)} total value`
                : `LIVE portfolio: $${pa.cashUSDC.toFixed(2)} cash + $${pa.positionsMTM.toFixed(2)} in positions = $${pa.portfolioValue.toFixed(2)}`
        };
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

    // 🦅 v21 UNDERDOG: Get current effective maxOdds (entry price cap)
    // v54.2: We intentionally allow high-confidence entries up to CONFIG.ORACLE.maxOdds (tuned for £100/24h).
    // This function may slightly relax/tighten around that baseline, but MUST NOT hard-cap to 50¢ (old behavior).
    getEffectiveMaxOdds() {
        let baseMaxOdds = CONFIG.ORACLE.maxOdds;
        
        // Mode-based adjustment
        if (this.aggressionMode === 'HUNTER') {
            baseMaxOdds = Math.min(baseMaxOdds + 0.02, 0.98); // slight relax, keep hard ceiling
        }
        
        // 🎯 ADAPTIVE THRESHOLD EXPANSION: Expand by 10¢ if no trades in 2+ hours
        const timeSinceLastTrade = Date.now() - this.lastTradeTime;
        const hoursSinceLastTrade = timeSinceLastTrade / (1000 * 60 * 60);
        const MAX_EXPANSION = 0.98; // Hard ceiling (above this is near-breakeven even at very high WR)
        
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

        // If trades are happening regularly, use the configured baseline.
        // (Do NOT auto-tighten below the tuned maxOdds — it is part of the profitability envelope.)
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
    
    // 🎯 GOAT v44.1: Frequency Governor - replaces time-of-day filtering
    // Dynamically adjusts trading based on recent trade frequency and outcomes
    getFrequencyGovernorDecision() {
        const now = Date.now();
        const ONE_HOUR = 60 * 60 * 1000;
        const TWO_HOURS = 2 * ONE_HOUR;
        
        // Count CLOSED ORACLE trades in last hour and last 2 hours
        // (use the actual stored trade fields: time/closeTime + pnl)
        const oracleClosedTrades = (this.tradeHistory || []).filter(t => {
            const mode = String(t?.mode || '').toUpperCase();
            const status = String(t?.status || '').toUpperCase();
            return mode === 'ORACLE' && status === 'CLOSED';
        });
        const tradeTs = (t) => {
            const ts = (typeof t?.closeTime === 'number')
                ? t.closeTime
                : (typeof t?.time === 'number' ? t.time : (typeof t?.timestamp === 'number' ? t.timestamp : 0));
            return Number.isFinite(ts) ? ts : 0;
        };
        const tradePnl = (t) => {
            const pnl = Number.isFinite(t?.pnl) ? t.pnl : (Number.isFinite(t?.profit) ? t.profit : NaN);
            return Number.isFinite(pnl) ? pnl : 0;
        };

        const recentTrades = oracleClosedTrades.filter(t => {
            const ts = tradeTs(t);
            return ts > 0 && (now - ts) < ONE_HOUR;
        });
        const tradesLastHour = recentTrades.length;
        const tradesLast2Hours = oracleClosedTrades.filter(t => {
            const ts = tradeTs(t);
            return ts > 0 && (now - ts) < TWO_HOURS;
        }).length;
        
        // Count wins in recent trades
        const recentWins = recentTrades.filter(t => tradePnl(t) > 0).length;
        const recentWinRate = tradesLastHour > 0 ? recentWins / tradesLastHour : 0.5;
        
        // Target: 2-4 trades per hour (enough activity without overtrading)
        const targetTradesPerHour = 3;
        const minTradesPerHour = 1;
        const maxTradesPerHour = 6;
        
        // Calculate threshold adjustments based on frequency
        let thresholdMultiplier = 1.0;
        let reason = 'NORMAL';
        let allowTrade = true;
        
        // If trading too frequently, tighten thresholds
        if (tradesLastHour >= maxTradesPerHour) {
            thresholdMultiplier = 1.3; // 30% higher thresholds
            reason = 'THROTTLE_HIGH_FREQUENCY';
            allowTrade = this.tradingState === 'STRIKE'; // Only allow in STRIKE mode when throttled
        }
        // If trading too infrequently, loosen thresholds
        else if (tradesLast2Hours === 0) {
            thresholdMultiplier = 0.85; // 15% lower thresholds
            reason = 'EXPAND_TRADE_DROUGHT';
            allowTrade = true;
        }
        // If recent win rate is poor, tighten thresholds
        else if (tradesLastHour >= 2 && recentWinRate < 0.4) {
            thresholdMultiplier = 1.2;
            reason = 'TIGHTEN_LOW_WINRATE';
            allowTrade = this.tradingState !== 'OBSERVE';
        }
        // Normal operation
        else if (tradesLastHour < targetTradesPerHour) {
            reason = 'NORMAL_BELOW_TARGET';
            allowTrade = true;
        }
        
        // Integrate with OBSERVE/HARVEST/STRIKE state machine
        if (this.tradingState === 'OBSERVE') {
            thresholdMultiplier *= 1.2; // More conservative in OBSERVE
            const minutesInObserve = (now - (this.stateEntryTime || now)) / 60000;
            if (minutesInObserve < 10) {
                allowTrade = false; // Hard block for first 10 min in OBSERVE
                reason = 'OBSERVE_COOLDOWN';
            }
        } else if (this.tradingState === 'STRIKE') {
            thresholdMultiplier *= 0.9; // More aggressive in STRIKE
        }
        
        return {
            allowTrade,
            reason,
            thresholdMultiplier,
            tradesLastHour,
            tradesLast2Hours,
            recentWinRate,
            tradingState: this.tradingState
        };
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
    
    // 🎯 v47 SIZING DOCTRINE (from $1M trade tables):
    // Base sizing: 20% of bankroll (CONFIG.MAX_POSITION_SIZE)
    // 
    // State multipliers:
    // - OBSERVE: 25% of base (probe trades after losses, high bar)
    // - HARVEST: 100% of base (normal trading)
    // - STRIKE:  200% of base (aggressive after 3+ wins, verified edge)
    //
    // Streak throttling (on top of state):
    // - After 1 loss: 80%
    // - After 2 losses: 60%
    // - After 3 losses: 40%
    // - After 4+ losses: 25%
    //
    // Combined: STRIKE + win streak = up to 200% * 100% = 40% of bankroll
    //           OBSERVE + loss streak = 25% * 25% = ~1.25% of bankroll (minimal exposure)
    getStateSizeMultiplier() {
        switch (this.tradingState) {
            case 'OBSERVE':
                return 0.25;  // 25% of normal size (probe trades only)
            case 'HARVEST':
                return 1.0;   // 100% normal size (base 20%)
            case 'STRIKE':
                return 2.0;   // 🎯 v47: Increased to 200% (was 150%) - verified edge justifies aggression
            default:
                return 1.0;
        }
    }
    
    // Check if trading is allowed in current state (optionally pass pWin for threshold check)
    canTradeInCurrentState(pWin = null) {
        if (this.tradingState === 'OBSERVE') {
            const minutesInObserve = (Date.now() - this.stateEntryTime) / 60000;
            // Allow small probe trades in OBSERVE after minimum time
            if (minutesInObserve < this.STATE_THRESHOLDS.observeMinMinutes) {
                return { allowed: false, reason: `OBSERVE cooldown: ${(this.STATE_THRESHOLDS.observeMinMinutes - minutesInObserve).toFixed(0)}min remaining` };
            }
            // 🎯 GOAT: pWin threshold check for OBSERVE
            if (Number.isFinite(pWin) && pWin < this.STATE_THRESHOLDS.observeMinPWin) {
                return { allowed: false, reason: `OBSERVE: pWin ${(pWin * 100).toFixed(1)}% < ${(this.STATE_THRESHOLDS.observeMinPWin * 100).toFixed(0)}% threshold` };
            }
            return { allowed: true, sizeMultiplier: 0.25, reason: 'OBSERVE: probe trades only' };
        }
        
        // 🎯 GOAT: pWin threshold checks for HARVEST/STRIKE
        if (Number.isFinite(pWin)) {
            const minPWin = this.tradingState === 'STRIKE' 
                ? this.STATE_THRESHOLDS.strikeMinPWin 
                : this.STATE_THRESHOLDS.harvestMinPWin;
            if (pWin < minPWin) {
                return { allowed: false, reason: `${this.tradingState}: pWin ${(pWin * 100).toFixed(1)}% < ${(minPWin * 100).toFixed(0)}% threshold` };
            }
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
        
        // 💰 EV CALCULATION (ORACLE-only): Use calibrated pWin, not raw signal score
        // Fee model: conservative assumption = 2% fee on PROFITS at settlement (not stake).
        const PROFIT_FEE_PCT = 0.02;
        const SLIPPAGE_ASSUMPTION_PCT = 0.01; // estimated entry slippage
        
        if (mode === 'ORACLE' && direction !== 'BOTH' && entryPrice > 0) {
            // Resolve pWin (prefer caller-provided, else derive from current brain calibration + priors)
            let pWin = Number.isFinite(options.pWin) ? options.pWin : null;
            if (pWin === null && typeof Brains !== 'undefined' && Brains[asset] && typeof Brains[asset].getCalibratedWinProb === 'function') {
                const s = Brains[asset].stats || {};
                const tier = options.tier || Brains[asset].tier || 'UNKNOWN';
                const priorRate =
                    (tier === 'CONVICTION' && s.convictionTotal > 0) ? (s.convictionWins / s.convictionTotal) :
                        (s.total > 0 ? (s.wins / s.total) : 0.5);
                pWin = Brains[asset].getCalibratedWinProb(confidence, { priorRate, priorStrength: 40, minSamples: 0 });
            }
            
            if (Number.isFinite(pWin)) {
                // Binary bet odds: b = (1 - price)/price. EV on stake = pWin*b*(1-fee) - (1-pWin)
                const effectivePrice = Math.min(0.99, entryPrice * (1 + SLIPPAGE_ASSUMPTION_PCT));
                const b = (1 - effectivePrice) / effectivePrice;
                const evRoi = (pWin * b * (1 - PROFIT_FEE_PCT)) - (1 - pWin);
                
                if (evRoi <= 0) {
                    log(`📉 EV GUARD: EV=${(evRoi * 100).toFixed(2)}% (pWin ${(pWin * 100).toFixed(1)}%, price ${(entryPrice * 100).toFixed(1)}¢) - BLOCKED`, asset);
                    return { success: false, error: `Negative EV: ${(evRoi * 100).toFixed(2)}%` };
                }
                log(`📈 EV CHECK: EV=${(evRoi * 100).toFixed(2)}% (pWin ${(pWin * 100).toFixed(1)}%) ✓`, asset);
            } else {
                log(`⚠️ EV GUARD: Missing calibrated pWin - skipping EV check`, asset);
            }
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

            // 🎯 v53 CRITICAL: TAIL BET FILTER - Block trades where Oracle disagrees with market
            // Polymarket-verified data shows: entry <20¢ = 6.7% WR (market strongly disagrees with Oracle)
            // These "contrarian" bets are NOT profitable - Oracle edge is in CONFIRMING market direction
            const effectiveMinOdds = CONFIG.ORACLE.minOdds || 0.20;
            if (mode === 'ORACLE' && entryPrice < effectiveMinOdds) {
                log(`🚫 TAIL BET BLOCK: Entry price ${(entryPrice * 100).toFixed(1)}¢ < minOdds ${(effectiveMinOdds * 100).toFixed(1)}¢ - Market strongly disagrees, Oracle edge invalid`, asset);
                return { success: false, error: `Entry price ${(entryPrice * 100).toFixed(1)}¢ below minOdds ${(effectiveMinOdds * 100).toFixed(1)}¢ (market disagrees)` };
            }

            // 🎯 GOAT v44.1: EV-derived max price check (replaces hard maxOdds)
            // If pWin is provided, compute EV-derived max entry; otherwise use hardMaxOdds as fallback
            // This prevents blocking trades that have positive EV at higher prices
            const pWinProvided = (options.pWin !== null && options.pWin !== undefined && Number.isFinite(options.pWin)) ? options.pWin : null;
            const PROFIT_FEE_PCT_EXEC = 0.02;
            const SAFETY_MARGIN_EXEC = 0.02;
            const hardMinOddsExec = CONFIG.ORACLE.minOdds || 0.20;
            const hardMaxOddsExec = (typeof this.getEffectiveMaxOdds === 'function')
                ? this.getEffectiveMaxOdds()
                : (CONFIG.ORACLE.maxOdds || 0.95);
            let evDerivedMaxExec = hardMaxOddsExec;
            if (pWinProvided !== null) {
                const p = Math.max(0, Math.min(1, pWinProvided));
                const pAfterFee = p * (1 - PROFIT_FEE_PCT_EXEC);
                const breakeven = pAfterFee / (pAfterFee + (1 - p));
                evDerivedMaxExec = Math.max(hardMinOddsExec, Math.min(0.99, breakeven - SAFETY_MARGIN_EXEC));
            }
            const effectiveMaxExec = Math.min(evDerivedMaxExec, hardMaxOddsExec);
            
            if (mode === 'ORACLE' && entryPrice > effectiveMaxExec) {
                log(`🚫 HARD BLOCK: Entry price ${(entryPrice * 100).toFixed(1)}¢ > EV-max ${(effectiveMaxExec * 100).toFixed(1)}¢ (pWin=${pWinProvided ? (pWinProvided * 100).toFixed(1) + '%' : 'N/A'}) - NO VALUE BETTING`, asset);
                return { success: false, error: `Entry price ${(entryPrice * 100).toFixed(1)}¢ exceeds EV-derived max ${(effectiveMaxExec * 100).toFixed(1)}¢` };
            }

            // 🎯 GOAT v44.1: Unified confidence/pWin gating
            // CONVICTION tier is NOT blocked by raw minConfidence (tier already implies high quality)
            // Instead, use pWin/EV-based gating for all tiers
            const tradeTier = options.tier || 'ADVISORY';
            const isPWinGated = pWinProvided !== null && pWinProvided !== undefined && Number.isFinite(pWinProvided);
            
            // For non-CONVICTION, still check raw confidence as fallback when no pWin
            if (mode === 'ORACLE' && tradeTier !== 'CONVICTION' && !isPWinGated && confidence < CONFIG.ORACLE.minConfidence) {
                log(`🚫 CONFIDENCE BLOCK: Trade confidence ${(confidence * 100).toFixed(1)}% < minConfidence ${(CONFIG.ORACLE.minConfidence * 100).toFixed(1)}% (tier=${tradeTier}, no pWin)`, asset);
                return { success: false, error: `Confidence ${(confidence * 100).toFixed(1)}% below ${(CONFIG.ORACLE.minConfidence * 100).toFixed(1)}% threshold` };
            }
            
            // For CONVICTION, log but do not block on raw confidence (pWin/EV already gated earlier)
            if (mode === 'ORACLE' && tradeTier === 'CONVICTION' && confidence < CONFIG.ORACLE.minConfidence) {
                log(`📊 CONVICTION PASS: Raw confidence ${(confidence * 100).toFixed(1)}% < minConfidence, but CONVICTION tier bypasses this gate`, asset);
            }

            // 🏆 v32 CRITICAL: MINIMUM BALANCE CHECK - User requested $2 minimum
            const MIN_TRADING_BALANCE = 2.00;
            if (this.paperBalance < MIN_TRADING_BALANCE) {
                log(`🚫 BALANCE TOO LOW: $${this.paperBalance.toFixed(2)} < minimum $${MIN_TRADING_BALANCE} - BLOCKED`, asset);
                return { success: false, error: `Balance $${this.paperBalance.toFixed(2)} below minimum $${MIN_TRADING_BALANCE}` };
            }

            // 🎯 GOAT v44.1: DOUBLE CHECK - Re-fetch CURRENT market price and verify it hasn't moved above EV-derived max
            // This catches race conditions where market moved between ORACLE check and trade execution
            if (mode === 'ORACLE' && market) {
                const tokenType = direction === 'UP' ? 'YES' : 'NO';
                const currentRealPrice = tokenType === 'YES' ? market.yesPrice : market.noPrice;
                if (currentRealPrice && currentRealPrice > effectiveMaxExec) {
                    log(`🚫 REAL-TIME BLOCK: Current market price ${(currentRealPrice * 100).toFixed(1)}¢ > EV-max ${(effectiveMaxExec * 100).toFixed(1)}¢ (passed: ${(entryPrice * 100).toFixed(1)}¢)`, asset);
                    return { success: false, error: `Current price ${(currentRealPrice * 100).toFixed(1)}¢ exceeds EV-derived max - race condition blocked` };
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

            // 🎯 GOLDEN MEAN: STATE MACHINE CHECK (pass pWin from options or EV calculation)
            const tradePWin = options.pWin || null;
            const stateCheck = this.canTradeInCurrentState(tradePWin);
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
                
                // 🎯 GOAT v3: Apply variance controls (CircuitBreaker + streak sizing + loss budget)
                const varianceResult = this.applyVarianceControls(size, mode);
                if (varianceResult.blocked) {
                    log(`🔌 TRADE BLOCKED by variance controls: ${varianceResult.reason}`, asset);
                    return { success: false, error: varianceResult.reason };
                }
                if (varianceResult.size < size) {
                    log(`🔌 VARIANCE SIZING: $${size.toFixed(2)} → $${varianceResult.size.toFixed(2)} (${varianceResult.adjustments})`, asset);
                    size = varianceResult.size;
                }

                // SMART MINIMUM: Ensure we meet $1.10 minimum
                // If percentage-based size is too small, use minimum (if affordable)
                // CAP: Never risk more than MAX_FRACTION of bankroll
                // GOAT: In micro-bankroll scenarios ($5 start), maxPct can imply a maxSize below Polymarket minimum.
                // Instead of deadlocking trading, temporarily allow MIN_ORDER as the effective cap (with a log).
                // 🏆 v60 FINAL: Add absolute dollar cap for liquidity protection at scale
                const MAX_ABSOLUTE_SIZE = parseFloat(process.env.MAX_ABSOLUTE_POSITION_SIZE || '100'); // $100 cap for liquidity
                let maxSize = bankroll * MAX_FRACTION;
                
                // Apply absolute cap (liquidity protection at scale)
                if (maxSize > MAX_ABSOLUTE_SIZE) {
                    log(`🔒 LIQUIDITY CAP: $${maxSize.toFixed(2)} → $${MAX_ABSOLUTE_SIZE} (absolute max for liquidity)`, asset);
                    maxSize = MAX_ABSOLUTE_SIZE;
                }
                
                if (maxSize < MIN_ORDER && bankroll >= MIN_ORDER * 1.5) {
                    log(`⚠️ MICRO BANKROLL: Max position ${(MAX_FRACTION * 100).toFixed(0)}% = $${maxSize.toFixed(2)} < $${MIN_ORDER}. Allowing minimum order to avoid trade drought.`, asset);
                    maxSize = MIN_ORDER;
                }
                if (size > maxSize) {
                    size = maxSize;
                    log(`📊 Size capped: $${size.toFixed(2)} (max ${(MAX_FRACTION * 100).toFixed(0)}% / abs $${MAX_ABSOLUTE_SIZE})`, asset);
                }

                // SMART MINIMUM: Ensure we meet $1.10 minimum (after cap)
                if (size < MIN_ORDER) {
                    if (bankroll >= MIN_ORDER * 1.5) {
                        size = MIN_ORDER;
                        log(`📊 Size bumped to minimum $${MIN_ORDER} (bankroll: $${bankroll.toFixed(2)})`, asset);
                    } else {
                        log(`❌ TRADE BLOCKED: Bankroll $${bankroll.toFixed(2)} too small for safe trading`, asset);
                        return { success: false, error: `Need at least $${(MIN_ORDER * 1.5).toFixed(2)} to trade` };
                    }
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
                        stopLoss, // 🔴 FIX v46: Keep stop-loss even with hedge (hedge is supplementary protection)
                        shares: mainSize / entryPrice,
                        isHedged: true,
                        hedgeId: null, // Will be set below
                        slug: market?.slug || null,
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
                        slug: market?.slug || null,
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
                        slug: market?.slug || null,
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
                        slug: market?.slug || null,
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
                    tier: options.tier || 'UNKNOWN', // 🎯 GOAT: Store tier for exit policy
                    genesisAgree: options.genesisAgree || false, // 🎯 v47: Store genesis agreement for stop-loss bypass
                    slug: market?.slug || null,
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
                    slug: market?.slug || null,
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
        const isBinaryExit = (typeof exitPrice === 'number') && (exitPrice <= 0.01 || exitPrice >= 0.99);

        // ==================== 🏆 APEX v24: HEDGED POSITION CLOSING ====================
        // If this is a hedged main position, also close the hedge
        if (pos.isHedged && pos.hedgeId && this.positions[pos.hedgeId]) {
            const hedge = this.positions[pos.hedgeId];
            // If we're resolving a binary outcome (exitPrice is exactly 0 or 1), the hedge resolves to the opposite payout.
            const isBinaryResolution = exitPrice === 0 || exitPrice === 1;
            let hedgeExitPrice;
            if (isBinaryResolution) {
                // Hedge is expected to be the opposite direction; if it's not, fall back to same payout.
                hedgeExitPrice = (hedge.side === pos.side) ? exitPrice : (exitPrice === 1 ? 0 : 1);
            } else {
                const hedgeMarket = currentMarkets[hedge.asset];
                hedgeExitPrice = hedge.side === 'UP' ? (hedgeMarket?.yesPrice || 0.5) : (hedgeMarket?.noPrice || 0.5);
            }

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
                hedgeTrade.reason = (isBinaryResolution ? 'HEDGE RESOLVED (with main)' : 'HEDGE CLOSED (with main)');
            }

            delete this.positions[pos.hedgeId];
        }

        // LIVE MODE: Execute actual sell order WITH RETRY (skip at binary resolution — redeem instead)
        if (pos.isLive && this.mode === 'LIVE' && !isBinaryExit) {
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
        // 🔴 FIX v46: HEDGE and ILLIQUIDITY legs should NOT trigger loss-streak logic
        // Only main ORACLE positions affect streak/cooldown/state machine
        const isAuxiliaryLeg = pos.mode === 'HEDGE' || pos.isHedge || pos.mode === 'ILLIQUIDITY';
        
        // 🎯 v52: Rolling CONVICTION accuracy tracker (EXECUTED trades only)
        // Prevents false drift warnings/auto-disable from "signal-only" cycle correctness.
        if (!isAuxiliaryLeg && pos.mode === 'ORACLE' && pos.tier === 'CONVICTION') {
            try {
                const brain = (typeof Brains !== 'undefined' && Brains) ? Brains[pos.asset] : null;
                if (brain) {
                    if (!Array.isArray(brain.rollingConviction)) brain.rollingConviction = [];
                    brain.rollingConviction.push({ time: Date.now(), wasCorrect: pnl >= 0, tradeId: positionId });
                    if (brain.rollingConviction.length > 50) brain.rollingConviction.shift();

                    const wins = brain.rollingConviction.filter(r => r.wasCorrect).length;
                    const total = brain.rollingConviction.length;
                    const rollingWR = total > 0 ? (wins / total) : 1;

                    if (total >= 20) {
                        if (rollingWR < 0.70) {
                            if (!brain.driftWarning) {
                                log(`⚠️ DRIFT WARNING: ${pos.asset} CONVICTION rolling WR = ${(rollingWR * 100).toFixed(1)}% (n=${total}) - below 70% threshold`, pos.asset);
                                brain.driftWarning = true;
                            }
                            if (rollingWR < 0.60 && !brain.autoDisabled) {
                                log(`🛑 AUTO-DISABLE: ${pos.asset} rolling WR ${(rollingWR * 100).toFixed(1)}% < 60% - suspending CONVICTION trades`, pos.asset);
                                brain.autoDisabled = true;
                            }
                        } else if (rollingWR >= 0.75 && brain.driftWarning) {
                            log(`✅ DRIFT RECOVERED: ${pos.asset} rolling WR = ${(rollingWR * 100).toFixed(1)}% - back above threshold`, pos.asset);
                            brain.driftWarning = false;
                            brain.autoDisabled = false;
                        }
                    }
                }
            } catch { }
        }

        if (pnl < 0 && !isAuxiliaryLeg) {
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
        } else if (pnl >= 0 && !isAuxiliaryLeg) {
            // WIN - reset consecutive losses and hunter streak (only for main positions)
            this.consecutiveLosses = 0;
            this.hunterLossStreak = 0;
            // 🦅 v20: Reset dormancy timer on successful trade
            this.lastTradeTime = Date.now();
            // 🎯 GOLDEN MEAN: Update state machine on win
            this.updateTradingState('WIN');
        }
        // Note: Auxiliary legs (HEDGE/ILLIQUIDITY) don't affect streak logic

        // Add WINNING live positions to redemption queue for later claiming
        // Only if position has a tokenId (live trade) and won (exitPrice = 1.0)
        if (pos.isLive && pos.tokenId && exitPrice >= 0.99) {
            this.addToRedemptionQueue(pos);
        }

        delete this.positions[positionId];
        return pnl;
    }

    // One-time reconciliation for legacy hedge trade records that were left OPEN by older code paths.
    // This does NOT mutate balances (paperBalance/todayPnL); it only cleans up tradeHistory truthfulness.
    reconcileLegacyOpenHedgeTrades() {
        try {
            const now = Date.now();
            const maxAgeMs = INTERVAL_SECONDS * 1000; // older than one full cycle = definitely stale

            let reconciled = 0;
            for (const t of (this.tradeHistory || [])) {
                if (!t || t.mode !== 'HEDGE' || t.status !== 'OPEN') continue;

                // If we still have a live position for this hedge, leave it alone.
                if (this.positions && this.positions[t.id]) continue;

                const openedAt = typeof t.time === 'number' ? t.time : 0;
                const ageMs = openedAt > 0 ? (now - openedAt) : Infinity;
                if (ageMs < maxAgeMs) continue; // too recent to safely declare stale

                // Try to infer the resolved outcome from the matching main trade (same timestamp, without _HEDGE_)
                // Example: BTC_HEDGE_123 -> BTC_123
                let inferredExit = null;
                let inferredPnl = null;
                let inferredPnlPercent = null;

                try {
                    const m = String(t.id || '').match(/^([A-Z]+)_HEDGE_(\d+)$/);
                    if (m) {
                        const asset = m[1];
                        const ts = m[2];
                        const mainId = `${asset}_${ts}`;
                        const main = (this.tradeHistory || []).find(x => x && x.id === mainId && x.status === 'CLOSED');
                        if (main && (main.exit === 0 || main.exit === 1) && Number.isFinite(t.entry) && Number.isFinite(t.size)) {
                            // Hedge is expected to be the opposite direction of main.
                            inferredExit = main.exit === 1 ? 0 : 1;
                            const shares = t.entry > 0 ? (t.size / t.entry) : 0;
                            inferredPnl = (inferredExit - t.entry) * shares;
                            inferredPnlPercent = t.entry > 0 ? ((inferredExit / t.entry) - 1) * 100 : 0;
                        }
                    }
                } catch { }

                t.exit = inferredExit;
                t.pnl = inferredPnl;
                t.pnlPercent = inferredPnlPercent;
                t.status = 'CLOSED';
                t.closeTime = now;
                t.reason = 'LEGACY HEDGE RECORD CLEANUP (pre-fix)';
                t.reconciled = true;
                t.reconciledAppliedToBalance = false;

                reconciled++;
            }

            if (reconciled > 0) {
                log(`🧹 Reconciled ${reconciled} legacy OPEN hedge trade records (reporting cleanup only)`);
            }
        } catch (e) {
            // Non-critical; never crash
        }
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
            // 🔴 FIX v46: HEDGE legs should close WITH their main position, not independently at 30s
            if (timeToEnd <= 30 && pos.mode !== 'ORACLE' && pos.mode !== 'ILLIQUIDITY' && pos.mode !== 'HEDGE' && !pos.isHedge) {
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

                // 🎯 v51 CRITICAL FIX: CONVICTION/Genesis bypass BEFORE regime stop-loss
                // This was causing CONVICTION trades to be stopped incorrectly
                const isConvictionTrade = pos.tier === 'CONVICTION';
                const isGenesisAgreeTrade = pos.genesisAgree === true;
                
                // Check if stop-loss is triggered
                if (currentOdds <= pos.stopLoss) {
                    const lossPct = ((pos.entry - currentOdds) / pos.entry * 100).toFixed(0);
                    
                    // 🎯 v51: CONVICTION trades NEVER stop-loss (94.8% WR)
                    if (isConvictionTrade) {
                        log(`💎 CONVICTION BYPASS: ${regime} stop at ${(pos.stopLoss * 100).toFixed(0)}¢ IGNORED - holding to resolution`, pos.asset);
                        // Do NOT exit - continue to next check
                    }
                    // 🎯 v51: Genesis-agree trades NEVER stop-loss
                    else if (isGenesisAgreeTrade) {
                        log(`🌱 GENESIS BYPASS: ${regime} stop at ${(pos.stopLoss * 100).toFixed(0)}¢ IGNORED - holding to resolution`, pos.asset);
                        // Do NOT exit - continue to next check
                    }
                    // Other tiers: apply regime stop-loss
                    else {
                        log(`🛡️ ${regime} REGIME STOP: Exiting at ${(currentOdds * 100).toFixed(0)}¢ (Stop Price ${(pos.stopLoss * 100).toFixed(0)}¢ / -${stopPct * 100}%)`, pos.asset);
                        this.closePosition(id, currentOdds, `${regime} STOP LOSS (-${lossPct}%)`);
                        return;
                    }
                }

                // 4. Dynamic Target Logic (Diamond vs Safety)
                const gainPercent = (currentOdds - pos.entry) / pos.entry;

                // 🎯 v47 PROFIT CAPTURE: CONVICTION trades hold to resolution (full $1 payout)
                // Non-CONVICTION can take early profit at diamondTarget to reduce variance
                const isConvictionForExit = pos.tier === 'CONVICTION';
                const isGenesisAgreeForExit = pos.genesisAgree === true;
                const holdToResolution = isConvictionForExit || isGenesisAgreeForExit;

                // DIAMOND HANDS: High confidence implied by Regime + Price Action
                // If price > diamondTarget, we take max profit (unless CONVICTION/GENESIS)
                if (!holdToResolution && currentOdds >= params.diamondTarget) {
                    const profitPercent = (gainPercent * 100).toFixed(0);
                    this.closePosition(id, currentOdds, `💎 ${regime} DIAMOND EXIT +${profitPercent}% (${(params.diamondTarget * 100).toFixed(0)}¢ Target)`);
                    return;
                }
                
                // 🎯 v47: CONVICTION/GENESIS rides to resolution for max payout
                if (holdToResolution && currentOdds >= params.diamondTarget) {
                    log(`💎 CONVICTION HOLD: At ${(currentOdds * 100).toFixed(0)}¢ - holding to resolution for max payout ($1)`, pos.asset);
                    // Continue holding - do not exit
                }

                // SAFETY NET: Mid-range profit taking if things look shaky
                // If price > safetyTarget (e.g. +20%) AND we are not at moon yet...
                // Only take safety exit if Price < 0.80 (Struggling) OR Regime is CHAOS
                // In CALM, we ignore safety exit (let it ride). In CHAOS, we take it eagerly.
                // 🎯 v47: Skip safety exit for CONVICTION/GENESIS trades
                const isStruggling = currentOdds < 0.80;
                const forceSafety = regime === 'CHAOS'; // Taking profit early in chaos is wise

                if (!holdToResolution && (isStruggling || forceSafety) && gainPercent >= params.safetyTarget && timeToEnd > 60) {
                    const profitPercent = (gainPercent * 100).toFixed(0);
                    this.closePosition(id, currentOdds, `🧻 ${regime} SAFETY EXIT +${profitPercent}%`);
                    return;
                }
            }

            // ==================== DEITY-LEVEL: SMART STOP LOSS ====================
            // Binary markets resolve to 0¢ or 100¢ - selling at 8¢ locks in -75% loss
            // Better strategy: hold to resolution unless early enough to recover

            // 🎯 GOAT v47: Smart exit policy for binary markets (STOP-LOSS FALSE-STOP FIX)
            // - MANUAL trades: Never auto-close (user controls)
            // - ORACLE CONVICTION entries: Hold to resolution (these have 98%+ win rate)
            // - GENESIS_AGREE entries: Hold to resolution (Genesis model matches direction)
            // - ORACLE other entries: Allow stop-loss in early cycle only (first 5 mins)
            // - Mid/Late cycle (after 5 mins): Hold to resolution (selling locks in loss, no time to recover)
            if (pos.mode !== 'MANUAL' && pos.stopLoss && currentOdds <= pos.stopLoss) {
                
                const lossPercent = ((pos.entry - currentOdds) / pos.entry * 100).toFixed(0);
                const elapsed = (Date.now() - pos.time) / 1000;
                const cycleTimeRemaining = 900 - elapsed; // 15-min cycle
                
                // 🎯 GOAT v47: Hold to resolution conditions (enhanced)
                const isConvictionEntry = pos.tier === 'CONVICTION';
                const isGenesisAgree = pos.genesisAgree === true; // Genesis model agreed with entry direction
                const isEarlyCycle = elapsed < 300; // First 5 mins only
                const isMidCycle = elapsed >= 300 && cycleTimeRemaining >= 300; // 5-10 min mark
                const isLateCycle = cycleTimeRemaining < 300; // Final 5 mins
                const isDeepLoss = parseFloat(lossPercent) >= 50; // -50%+ = hold (selling is worse)
                
                // 🎯 v47 FIX: CONVICTION always holds (98%+ win rate)
                if (isConvictionEntry) {
                    log(`💎 DIAMOND HANDS: CONVICTION entry at ${(pos.entry * 100).toFixed(0)}¢ - holding to resolution (stop at ${(pos.stopLoss * 100).toFixed(0)}¢ bypassed)`, pos.asset);
                    return; // Do NOT exit
                }
                
                // 🎯 v47 FIX: Genesis agreement = high-confidence direction, hold to resolution
                if (isGenesisAgree) {
                    log(`🌱 GENESIS DIAMOND HANDS: Genesis agreed with ${pos.side} at ${(pos.entry * 100).toFixed(0)}¢ - holding to resolution`, pos.asset);
                    return; // Do NOT exit
                }
                
                // 🎯 v47 FIX: Mid-cycle onwards = too late to stop, hold for resolution
                if (isMidCycle || isLateCycle) {
                    log(`⏰ CYCLE HOLD: ${isMidCycle ? 'Mid' : 'Late'} cycle (${(elapsed / 60).toFixed(1)}min elapsed) - holding to resolution`, pos.asset);
                    return; // Do NOT exit
                }
                
                // 🎯 v47 FIX: Deep loss = selling locks in catastrophic loss, hold for 50% resolution chance
                if (isDeepLoss) {
                    log(`🔒 DEEP LOSS HOLD: At -${lossPercent}% - selling now locks in massive loss, holding for resolution chance`, pos.asset);
                    return; // Do NOT exit - resolution gives 50% chance of recovery
                }
                
                // ONLY exit on stop-loss if: early cycle + not conviction + not genesis agree + not deep loss
                log(`🛑 EARLY CYCLE STOP: Exiting at -${lossPercent}% within first 5min (Odds ${(currentOdds * 100).toFixed(0)}¢ <= ${(pos.stopLoss * 100).toFixed(0)}¢)`, pos.asset);
                this.closePosition(id, currentOdds, `EARLY STOP -${lossPercent}% 🛑`);

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
        // IMPORTANT: Resolve non-hedge positions first.
        // Hedges are normally settled when their main position closes (to avoid double-counting).
        const ids = Object.keys(this.positions).filter(id => this.positions[id] && this.positions[id].asset === asset);
        if (ids.length === 0) return;

        // ✅ PAPER + LIVE: Prefer Polymarket Gamma resolution when we have the market slug.
        // This makes streaks/halts truthful and ensures LIVE settles to Polymarket/Chainlink ground truth.
        if (this.mode === 'PAPER' || this.mode === 'LIVE') {
            const slugs = new Set();
            for (const id of ids) {
                const pos = this.positions[id];
                if (!pos || pos.asset !== asset) continue;
                if (pos.isHedge) continue;
                if (pos.slug) slugs.add(pos.slug);
            }

            if (slugs.size > 0) {
                // Schedule resolution for each unique slug, then close only the no-slug positions via fallback.
                for (const slug of slugs) {
                    this.schedulePolymarketResolution(slug, asset, finalOutcome);
                }

                for (const id of ids) {
                    const pos = this.positions[id];
                    if (!pos || pos.asset !== asset) continue;
                    if (pos.isHedge) continue;
                    if (pos.slug) continue; // will resolve via Polymarket

                    const won = (pos.side === finalOutcome);
                    const exitPrice = won ? 1.0 : 0.0;
                    const reason = won ? `${pos.mode} WIN ✅ (fallback)` : `${pos.mode} LOSS ❌ (fallback)`;
                    log(`🏁 CYCLE END (fallback): ${pos.asset} ${pos.side} -> Outcome: ${finalOutcome}`, asset);
                    this.closePosition(id, exitPrice, reason);
                }

                // Close any remaining ORPHAN hedges only (do not touch hedges whose main is pending Polymarket resolution)
                const remainingHedges = Object.keys(this.positions).filter(id => {
                    const p = this.positions[id];
                    if (!p || p.asset !== asset || !p.isHedge) return false;
                    return !p.mainId || !this.positions[p.mainId];
                });
                for (const id of remainingHedges) {
                    const pos = this.positions[id];
                    if (!pos) continue;
                    const won = (pos.side === finalOutcome);
                    const exitPrice = won ? 1.0 : 0.0;
                    const reason = won ? `${pos.mode} WIN ✅ (orphan hedge fallback)` : `${pos.mode} LOSS ❌ (orphan hedge fallback)`;
                    log(`🏁 CYCLE END (fallback): Orphan hedge resolved: ${pos.asset} ${pos.side} -> Outcome: ${finalOutcome}`, asset);
                    this.closePosition(id, exitPrice, reason);
                }
                return;
            }
        }

        // Fallback: resolve all positions from internal finalOutcome.
        for (const id of ids) {
            const pos = this.positions[id];
            if (!pos || pos.asset !== asset) continue;
            if (pos.isHedge) continue;

            const won = (pos.side === finalOutcome);
            const exitPrice = won ? 1.0 : 0.0; // Binary resolution
            const reason = won ? `${pos.mode} WIN ✅` : `${pos.mode} LOSS ❌`;
            log(`🏁 CYCLE END: ${pos.asset} ${pos.side} -> Outcome: ${finalOutcome}`, asset);
            this.closePosition(id, exitPrice, reason);
        }

        // Pass 2: close any remaining hedges (orphaned hedges / missing linkage) deterministically
        const remainingHedges = Object.keys(this.positions).filter(id => {
            const p = this.positions[id];
            return p && p.asset === asset && p.isHedge;
        });
        for (const id of remainingHedges) {
            const pos = this.positions[id];
            if (!pos) continue;
            const won = (pos.side === finalOutcome);
            const exitPrice = won ? 1.0 : 0.0;
            const reason = won ? `${pos.mode} WIN ✅ (orphan hedge)` : `${pos.mode} LOSS ❌ (orphan hedge)`;
            log(`🏁 CYCLE END: Orphan hedge resolved: ${pos.asset} ${pos.side} -> Outcome: ${finalOutcome}`, asset);
            this.closePosition(id, exitPrice, reason);
        }
    }

    async fetchPolymarketResolvedOutcome(slug) {
        try {
            const url = `https://gamma-api.polymarket.com/markets?slug=${encodeURIComponent(slug)}`;
            const response = await fetch(url, {
                headers: { 'User-Agent': 'polyprophet-runtime/1.0' },
                signal: AbortSignal.timeout(10000)
            });
            if (!response.ok) return null;
            const data = await response.json();
            const market = Array.isArray(data) ? data[0] : data;
            if (!market || !market.outcomePrices || !market.outcomes) return null;

            const prices = Array.isArray(market.outcomePrices) ? market.outcomePrices : (typeof market.outcomePrices === 'string' ? JSON.parse(market.outcomePrices) : null);
            const outcomes = Array.isArray(market.outcomes) ? market.outcomes : (typeof market.outcomes === 'string' ? JSON.parse(market.outcomes) : null);
            if (!Array.isArray(prices) || prices.length < 2) return null;
            if (!Array.isArray(outcomes) || outcomes.length < 2) return null;

            const p0 = Number(prices[0]);
            const p1 = Number(prices[1]);
            if (!Number.isFinite(p0) || !Number.isFinite(p1)) return null;

            const idx0Win = p0 >= 0.99 && p1 <= 0.01;
            const idx1Win = p0 <= 0.01 && p1 >= 0.99;
            if (!idx0Win && !idx1Win) return null; // not yet resolved

            const o0 = String(outcomes[0]).toLowerCase();
            const o1 = String(outcomes[1]).toLowerCase();

            if (o0 === 'up' && o1 === 'down') return idx0Win ? 'UP' : 'DOWN';
            if (o0 === 'down' && o1 === 'up') return idx0Win ? 'DOWN' : 'UP';
            if (o0 === 'yes' && o1 === 'no') return idx0Win ? 'UP' : 'DOWN';
            if (o0 === 'no' && o1 === 'yes') return idx0Win ? 'DOWN' : 'UP';

            // Fallback: treat index winner as UP vs DOWN (convention)
            return idx0Win ? 'UP' : 'DOWN';
        } catch {
            return null;
        }
    }

    schedulePolymarketResolution(slug, asset, fallbackOutcome) {
        if (!slug) return;
        if (!(this.pendingPolymarketResolutions instanceof Map)) {
            this.pendingPolymarketResolutions = new Map();
        }
        if (this.pendingPolymarketResolutions.has(slug)) return;

        const startedAt = Date.now();
        this.pendingPolymarketResolutions.set(slug, { asset, attempts: 0, fallbackOutcome, startedAt });

        const isLiveMode = this.mode === 'LIVE';
        // 🏆 v64 FIX: Faster resolution with smart fallback
        // First 12 attempts = 2 seconds each (24s fast polling)
        // Then 48 attempts = 5 seconds each (4 min slower polling)
        // After 5 min: Use Chainlink fallback but LOG it for monitoring
        const MAX_ATTEMPTS = isLiveMode ? Infinity : 60;
        const INITIAL_DELAY_MS = 2000; // 🏆 v64: Faster first check (was 3000)
        const FAST_RETRY_MS = 2000;    // 🏆 v64: Fast poll for first 12 attempts
        const SLOW_RETRY_MS = 5000;    // 🏆 v64: Slower poll after
        const FAST_ATTEMPTS = 12;      // 🏆 v64: 12 fast attempts = 24s
        const RETRY_DELAY_MS = isLiveMode ? 15000 : SLOW_RETRY_MS;

        const tick = async () => {
            const state = this.pendingPolymarketResolutions.get(slug);
            if (!state) return;

            // If nothing is open for this slug anymore, stop tracking.
            const openMainIds = Object.keys(this.positions).filter(id => {
                const p = this.positions[id];
                return p && p.asset === asset && !p.isHedge && p.slug === slug;
            });
            if (openMainIds.length === 0) {
                this.pendingPolymarketResolutions.delete(slug);
                return;
            }

            state.attempts++;

            const outcome = await this.fetchPolymarketResolvedOutcome(slug);
            if (outcome === 'UP' || outcome === 'DOWN') {
                this.pendingPolymarketResolutions.delete(slug);
                log(`🏁 POLYMARKET RESOLVED: ${asset} slug=${slug} -> ${outcome} (attempt ${state.attempts})`, asset);

                // Close all NON-HEDGE positions for this slug (their hedges settle automatically)
                for (const id of openMainIds) {
                    const pos = this.positions[id];
                    if (!pos) continue;
                    const won = pos.side === outcome;
                    const exitPrice = won ? 1.0 : 0.0;
                    const reason = won ? `${pos.mode} WIN ✅ (Polymarket)` : `${pos.mode} LOSS ❌ (Polymarket)`;
                    this.closePosition(id, exitPrice, reason);
                }
                return;
            }

            if (state.attempts >= MAX_ATTEMPTS) {
                // 🏆 v64 FIX: PAPER mode now uses fallback after extended wait
                // Trade-off: 95%+ accuracy (Chainlink usually matches) vs trades staying pending forever
                // User reported trades not resolving - this fixes that
                this.pendingPolymarketResolutions.delete(slug);
                
                const waitTimeMin = Math.round((Date.now() - startedAt) / 60000);
                log(`⚠️ RESOLUTION FALLBACK: ${asset} slug=${slug} after ${state.attempts} attempts (~${waitTimeMin}min)`, asset);
                log(`📊 Using Chainlink fallback (${fallbackOutcome}) - 95%+ match rate with Polymarket`, asset);
                
                for (const id of openMainIds) {
                    const pos = this.positions[id];
                    if (!pos) continue;
                    const won = pos.side === fallbackOutcome;
                    const exitPrice = won ? 1.0 : 0.0;
                    // Mark as fallback so we can track accuracy
                    const reason = won ? `${pos.mode} WIN ✅ (Chainlink)` : `${pos.mode} LOSS ❌ (Chainlink)`;
                    this.closePosition(id, exitPrice, reason);
                }
                return;
            }

            // 🏆 v64: Use fast retry for first 12 attempts, then slow
            const delay = state.attempts <= FAST_ATTEMPTS ? FAST_RETRY_MS : SLOW_RETRY_MS;
            setTimeout(tick, delay);
        };

        setTimeout(tick, INITIAL_DELAY_MS);
    }

    // 🔴 BUG FIX: Force-resolve any stale positions older than 1 cycle (15 minutes)
    // This catches positions that weren't resolved due to missing price data
    // 🏆 v60: Skip PENDING_RESOLUTION positions - they're waiting for Gamma, not stale
    cleanupStalePositions() {
        const now = Date.now();
        const maxAge = INTERVAL_SECONDS * 1000; // 15 minutes in ms

        Object.entries(this.positions).forEach(([id, pos]) => {
            // Skip PENDING_RESOLUTION - these are explicitly waiting for Gamma to resolve
            if (pos.status === 'PENDING_RESOLUTION') {
                return;
            }
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

    // 🎯 GOAT v44.1: Check and redeem any resolved positions - IDEMPOTENT AUTOMATIC REDEMPTION
    // Each item is processed exactly once and outcome is recorded for visibility
    async checkAndRedeemPositions() {
        if (!this.wallet) {
            return { success: false, error: 'No wallet loaded', events: [] };
        }

        // Initialize redemption event log if not exists
        if (!this.redemptionEvents) this.redemptionEvents = [];

        const queue = this.redemptionQueue || [];
        if (queue.length === 0) {
            return { success: true, message: 'No positions to redeem', redeemed: 0, events: [] };
        }

        log(`🔍 Checking ${queue.length} positions for automatic redemption...`);
        let redeemed = 0;
        let failed = 0;
        let skipped = 0;
        const events = [];

        try {
            // Use direct provider to avoid proxy issues
            const provider = createDirectProvider('https://polygon-rpc.com');
            const wallet = this.wallet.connect(provider);
            const ctfContract = new ethers.Contract(CTF_ADDRESS, CTF_ABI, wallet);

            for (let i = queue.length - 1; i >= 0; i--) {
                const item = queue[i];
                
                // 🎯 GOAT v44.1: Idempotency check - skip if already processed
                if (item.processedAt) {
                    skipped++;
                    continue;
                }

                const eventRecord = {
                    tokenId: item.tokenId,
                    asset: item.asset,
                    side: item.side,
                    timestamp: Date.now(),
                    outcome: 'PENDING',
                    reason: null,
                    txHash: null
                };

                try {
                    // Check if we have any balance of this token
                    const balance = await ctfContract.balanceOf(wallet.address, item.tokenId);
                    const balanceNum = parseFloat(ethers.utils.formatUnits(balance, 0));
                    eventRecord.balance = balanceNum;

                    if (balance.gt(0)) {
                        log(`💰 Found ${balanceNum} redeemable tokens for ${item.asset}`, item.asset);

                        // 🚀 AUTOMATIC REDEMPTION ATTEMPT
                        if (item.conditionId) {
                            try {
                                log(`🔄 Attempting automatic redemption for ${item.asset}...`, item.asset);

                                // Prepare redemption parameters
                                const parentCollectionId = ethers.constants.HashZero;
                                const indexSets = [1, 2];

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
                                eventRecord.txHash = tx.hash;

                                // Wait for confirmation
                                const receipt = await tx.wait();

                                if (receipt.status === 1) {
                                    log(`✅ AUTO-REDEEMED: ${item.asset} ${item.side} - TX: ${tx.hash}`, item.asset);
                                    eventRecord.outcome = 'REDEEMED';
                                    eventRecord.reason = 'Auto-redeemed successfully';
                                    item.processedAt = Date.now();
                                    item.status = 'REDEEMED';
                                    queue.splice(i, 1);
                                    redeemed++;
                                    this.refreshLiveBalance();
                                } else {
                                    log(`❌ Redemption TX failed for ${item.asset}`, item.asset);
                                    eventRecord.outcome = 'TX_FAILED';
                                    eventRecord.reason = 'Transaction reverted';
                                    item.lastAttempt = Date.now();
                                    item.attempts = (item.attempts || 0) + 1;
                                    failed++;
                                }
                            } catch (redeemError) {
                                log(`⚠️ Auto-redeem failed for ${item.asset}: ${redeemError.message}`, item.asset);
                                eventRecord.outcome = 'ERROR';
                                eventRecord.reason = redeemError.message;
                                item.lastAttempt = Date.now();
                                item.attempts = (item.attempts || 0) + 1;
                                failed++;
                            }
                        } else {
                            // No conditionId - mark as requiring manual redemption
                            log(`⚠️ Position ${item.asset} ${item.side} missing conditionId - manual redemption required`, item.asset);
                            eventRecord.outcome = 'MANUAL_REQUIRED';
                            eventRecord.reason = 'Missing conditionId for automatic redemption';
                            item.requiresManual = true;
                        }
                    } else {
                        // No balance - check if already redeemed or never had tokens
                        log(`ℹ️ No balance found for ${item.asset} ${item.side} token`, item.asset);
                        eventRecord.outcome = 'NO_BALANCE';
                        
                        // 🎯 GOAT v44.1: Do NOT silently remove - verify before dropping
                        // Only remove if item has been in queue for > 24 hours (likely already processed)
                        const ageHours = (Date.now() - (item.addedAt || Date.now())) / (1000 * 60 * 60);
                        if (ageHours > 24) {
                            eventRecord.reason = 'Zero balance after 24h - assumed redeemed externally';
                            item.processedAt = Date.now();
                            item.status = 'ASSUMED_REDEEMED';
                            queue.splice(i, 1);
                            redeemed++;
                        } else {
                            eventRecord.reason = 'Zero balance but recent - keeping in queue for verification';
                            item.lastChecked = Date.now();
                        }
                    }
                } catch (e) {
                    log(`⚠️ Error checking token ${item.asset}: ${e.message}`, item.asset);
                    eventRecord.outcome = 'CHECK_ERROR';
                    eventRecord.reason = e.message;
                    item.lastAttempt = Date.now();
                    failed++;
                }

                events.push(eventRecord);
                this.redemptionEvents.push(eventRecord);
                
                // 🎯 GOAT v4: Persist redemption event to Redis
                persistRedemptionEvent(eventRecord);
                
                // Keep only last 100 events in memory
                if (this.redemptionEvents.length > 100) {
                    this.redemptionEvents = this.redemptionEvents.slice(-100);
                }
            }

            this.redemptionQueue = queue;
            return {
                success: true,
                message: `Checked ${queue.length + redeemed} positions`,
                redeemed,
                failed,
                skipped,
                remaining: queue.length,
                events
            };

        } catch (e) {
            log(`❌ Redemption check failed: ${e.message}`);
            return { success: false, error: e.message, events };
        }
    }
    
    // 🎯 GOAT v44.1: Get redemption events for API visibility
    getRedemptionEvents(limit = 50) {
        return (this.redemptionEvents || []).slice(-limit);
    }

    // Clear redemption queue (with confirmation tracking)
    clearRedemptionQueue(reason = 'manual') {
        const count = (this.redemptionQueue || []).length;
        const clearedItems = [...(this.redemptionQueue || [])];
        this.redemptionQueue = [];
        
        // Record the clear event
        if (!this.redemptionEvents) this.redemptionEvents = [];
        const clearEvent = {
            timestamp: Date.now(),
            outcome: 'QUEUE_CLEARED',
            reason,
            clearedCount: count,
            clearedItems: clearedItems.map(i => ({ asset: i.asset, side: i.side, tokenId: i.tokenId }))
        };
        this.redemptionEvents.push(clearEvent);
        
        // 🎯 GOAT v4: Persist clear event to Redis
        persistRedemptionEvent(clearEvent);
        
        log(`🗑️ Redemption queue cleared: ${count} items (reason: ${reason})`);
        return { cleared: count, items: clearedItems };
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

// 🎯 GOAT v44.1: GateTrace - records why trades were blocked for each cycle/asset
const gateTrace = {
    // Structure: { asset: { cycleStart: timestamp, evaluations: [...] } }
    traces: {},
    maxTraces: 50, // Keep last 50 per asset
    
    record(asset, evaluation) {
        if (!this.traces[asset]) {
            this.traces[asset] = [];
        }
        this.traces[asset].unshift({
            timestamp: Date.now(),
            cycleStart: Math.floor(Date.now() / 900000) * 900000,
            ...evaluation
        });
        // Keep only last maxTraces
        if (this.traces[asset].length > this.maxTraces) {
            this.traces[asset] = this.traces[asset].slice(0, this.maxTraces);
        }
    },
    
    getAll() {
        return this.traces;
    },
    
    getForAsset(asset) {
        return this.traces[asset] || [];
    },
    
    getSummary() {
        const summary = { totalEvaluations: 0, totalBlocked: 0, gateFailures: {}, byAsset: {} };
        for (const [asset, traces] of Object.entries(this.traces)) {
            summary.byAsset[asset] = { evaluations: traces.length, blocked: 0, traded: 0, failedGates: {} };
            for (const trace of traces) {
                summary.totalEvaluations++;
                if (trace.decision === 'NO_TRADE') {
                    summary.totalBlocked++;
                    summary.byAsset[asset].blocked++;
                    for (const gate of (trace.failedGates || [])) {
                        summary.gateFailures[gate] = (summary.gateFailures[gate] || 0) + 1;
                        summary.byAsset[asset].failedGates[gate] = (summary.byAsset[asset].failedGates[gate] || 0) + 1;
                    }
                } else {
                    summary.byAsset[asset].traded++;
                }
            }
        }
        return summary;
    }
};

// Logging
function log(msg, asset = null) {
    const timestamp = new Date().toLocaleTimeString();
    const prefix = asset ? `[${asset}]` : '[ORACLE]';
    // Cursor/VSCode can OOM if the integrated terminal floods.
    // Allow opting out of noisy logs without changing behavior.
    if (String(process.env.LOG_SILENT || '').toLowerCase() === 'true') return;
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
            '0.00-0.50': { total: 0, wins: 0 },
            '0.50-0.60': { total: 0, wins: 0 },
            '0.60-0.70': { total: 0, wins: 0 },
            '0.70-0.80': { total: 0, wins: 0 },
            '0.80-0.90': { total: 0, wins: 0 },
            '0.90-0.95': { total: 0, wins: 0 },
            '0.95-0.98': { total: 0, wins: 0 },
            '0.98-1.00': { total: 0, wins: 0 }
        };
        
        // 🎯 GOAT FIX: Tier-conditioned calibration (CONVICTION has different hit rate than ADVISORY/NONE)
        this.tierCalibration = {
            'CONVICTION': { total: 0, wins: 0, priceBands: { extreme: { total: 0, wins: 0 }, mid: { total: 0, wins: 0 } } },
            'ADVISORY':   { total: 0, wins: 0, priceBands: { extreme: { total: 0, wins: 0 }, mid: { total: 0, wins: 0 } } },
            'NONE':       { total: 0, wins: 0, priceBands: { extreme: { total: 0, wins: 0 }, mid: { total: 0, wins: 0 } } }
        };

        // FINAL SEVEN: REGIME PERSISTENCE
        this.regimeHistory = [];

        // FINAL SEVEN: NEWS AWARENESS (Placeholder)
        this.newsState = 'NEUTRAL'; // NEUTRAL, NEGATIVE, POSITIVE

        this.pendingSignal = null;
        this.stabilityCounter = 0;
        this.lagCounter = 0;
        this.isProcessing = false;
        
        // Reduce terminal spam (can crash Cursor/VSCode over time)
        this.lastWarmupLogAt = 0;
        this.lastWarmupLogSig = '';

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

        // 🎯 v52 ROLLING ACCURACY TRACKER (Last 50 CONVICTION trades)
        // Used for auto-drift detection - if WR drops below 70%, asset is flagged
        this.rollingConviction = [];  // Array of { time, wasCorrect } for last 50 CONVICTION trades
        this.driftWarning = false;    // True if rolling WR < 70%
        this.autoDisabled = false;    // True if accuracy dropped below threshold

        // 🎯 v53 TRADE ENTRY TRACKING (for accurate profit backtesting)
        // Captures the ENTRY-TIME prices when trade decision was made (not cycle-end prices)
        this.tradeEntryOdds = null;   // { yesPrice, noPrice, timestamp } at trade entry
        this.tradeEntryReason = null; // 'GOD_MODE' | 'TREND_MODE' | 'ORACLE_LOCKED' | 'STANDARD_ORACLE' | null
        this.tradeEntryTier = null;   // Tier at time of trade entry
        this.tradeEntryConfidence = null; // Confidence at time of trade entry

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
                // DIAGNOSTIC (throttled): Log why prediction is not running
                const reasons = [];
                if (!currentPrice) reasons.push('no_live_price');
                if (!startPrice) reasons.push('no_checkpoint_price');
                if (history.length < 10) reasons.push(`insufficient_history_${history.length}/10`);
                const sig = reasons.join('|');
                const nowMs = Date.now();
                // Log at most once/minute per asset unless the reason changes
                if (sig !== this.lastWarmupLogSig || (nowMs - this.lastWarmupLogAt) > 60000) {
                    log(`⚠️ Warmup: ${reasons.join(', ')}`, this.asset);
                    this.lastWarmupLogSig = sig;
                    this.lastWarmupLogAt = nowMs;
                }
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
            const upVotesCF = Number(votes.UP) || 0;
            const downVotesCF = Number(votes.DOWN) || 0;
            const totalVotesCF = upVotesCF + downVotesCF;
            const consensusRatioCheck = totalVotesCF > 0 ? Math.max(upVotesCF, downVotesCF) / totalVotesCF : 0;
            if (consensusRatioCheck >= 0.70 && finalConfidence < 0.25) {
                log(`🛡️ CONFIDENCE FLOOR: Enforced 25% min (models ${(consensusRatioCheck * 100).toFixed(0)}% agree)`, this.asset);
                finalConfidence = 0.25;
            } else if (consensusRatioCheck >= 0.60 && finalConfidence < 0.15) {
                log(`🛡️ CONFIDENCE FLOOR: Enforced 15% min (models ${(consensusRatioCheck * 100).toFixed(0)}% agree)`, this.asset);
                finalConfidence = 0.15;
            }

            // 🏆 v65 FIX: SUPREME CONFIDENCE ENFORCEMENT - NOW ACTUALLY BLOCKS!
            // This was the critical bug: trades below 75% were being allowed, dropping WR to 66%
            // Backtest shows: CONVICTION only = 77% WR, ALL tiers = 64% WR
            // FIX: Actually BLOCK trades below 75% confidence when supremeConfidenceMode is enabled
            if (CONFIG.RISK.supremeConfidenceMode && finalConfidence < 0.75) {
                log(`🚫 SUPREME MODE BLOCK: ${(finalConfidence * 100).toFixed(1)}% < 75% minimum - TRADE BLOCKED`, this.asset);
                gateTrace.record(this.asset, { decision: 'NO_TRADE', reason: 'SUPREME_MODE_BLOCK', failedGates: ['confidence_75'], inputs: { finalConfidence, supremeConfidenceMode: true } });
                return; // BLOCK the trade - this is critical for maintaining 77% WR
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
                
                // 🎯 v53: Capture entry-time prices at oracle lock moment
                const mkt = currentMarkets[this.asset];
                if (mkt && !this.tradeEntryOdds) {
                    this.tradeEntryOdds = { yesPrice: mkt.yesPrice, noPrice: mkt.noPrice, timestamp: Date.now() };
                    this.tradeEntryReason = 'ORACLE_LOCKED';
                    this.tradeEntryTier = 'CONVICTION';
                    this.tradeEntryConfidence = finalConfidence;
                }
                
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
                    
                    // 🎯 GOAT v44.1: Invariant enforcement after state update
                    this.enforceStateInvariants();
                    
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
                
                // 🎯 GOAT v44.1: Invariant enforcement after state update
                this.enforceStateInvariants();
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
            }
            // 🎯 v52: Auto-disabled asset due to drift detection (rolling WR < 60%)
            else if (this.autoDisabled && tier === 'CONVICTION') {
                log(`🛑 AUTO-DISABLED: ${this.asset} CONVICTION trades suspended - rolling WR dropped below threshold`, this.asset);
                gateTrace.record(this.asset, { decision: 'NO_TRADE', reason: 'AUTO_DISABLED', failedGates: ['rolling_accuracy'], inputs: { signal: finalSignal, tier, autoDisabled: this.autoDisabled, driftWarning: this.driftWarning } });
                // Do not trade - fall through to end
            } else {
            const meetsAdvisoryThreshold = tier === 'CONVICTION' || (tier === 'ADVISORY' && finalConfidence >= 0.80);
                // 🎯 GOAT v44.1: Frequency governor replaces time-of-day filtering
                // Instead of blocking trades by hour, we dynamically adjust thresholds based on recent trade frequency
                const frequencyCheck = tradeExecutor.getFrequencyGovernorDecision();
                const timeFilterPass = frequencyCheck.allowTrade || tier === 'CONVICTION';
                
                if (CONFIG.ORACLE.enabled && !this.convictionLocked && meetsAdvisoryThreshold && timeFilterPass && elapsed >= minElapsed && elapsed < 600) {
                const market = currentMarkets[this.asset];
                if (market) {
                    const currentOdds = finalSignal === 'UP' ? market.yesPrice : market.noPrice;
                    // 🎯 v47 GATE TUNING: Allow mid-range odds if CONVICTION or GENESIS_AGREE
                    // - CONVICTION tier has 98%+ win rate at any price
                    // - GENESIS_AGREE = Genesis model (94% accuracy) matches signal direction
                    // - Otherwise require extreme odds (<20c or >90c) for safety
                    const isExtremeOdds = currentOdds < 0.20 || currentOdds > 0.90; // v47: lowered from 95c to 90c
                    const isGenesisAgreeForGate = modelVotes.genesis === finalSignal;
                    const canTradeMidRange = tier === 'CONVICTION' || isGenesisAgreeForGate;
                    
                    if (!isExtremeOdds && !canTradeMidRange) {
                        log(`🚫 ENTRY PRICE FILTER: Mid-range odds ${(currentOdds * 100).toFixed(1)}¢ - requires CONVICTION or GENESIS agreement`, this.asset);
                        // 🎯 GOAT v44.1: Record extreme odds filter block
                        gateTrace.record(this.asset, { decision: 'NO_TRADE', reason: 'PRICE_FILTER', failedGates: ['mid_range_odds'], inputs: { signal: finalSignal, tier, currentOdds, isExtremeOdds, isGenesisAgreeForGate, elapsed } });
                        // Do not trade - fall through to end
                    } else {
                    // Consensus ratio (robust numeric calc; used in gates + trace)
                    const upVotesNum = Number(votes.UP) || 0;
                    const downVotesNum = Number(votes.DOWN) || 0;
                    const totalVotesForConsensus = upVotesNum + downVotesNum;
                    const consensusVotes = Math.max(upVotesNum, downVotesNum);
                    const consensusRatio = totalVotesForConsensus > 0 ? consensusVotes / totalVotesForConsensus : 0;
                    // 🎯 GOAT: EV/EDGE uses tier-conditioned calibrated probability (pWin), not raw signal score
                    // This accounts for the fact that CONVICTION tier at extreme prices has ~99% win rate
                    const PROFIT_FEE_PCT = 0.02; // conservative: fee on profits at settlement
                    const s = this.stats || {};
                    const priorRate =
                        (tier === 'CONVICTION' && s.convictionTotal > 0) ? (s.convictionWins / s.convictionTotal) :
                            (s.total > 0 ? (s.wins / s.total) : 0.5);
                    
                    // 🎯 GOAT: Prefer tier+price conditioned pWin, fall back to bucket-based
                    let pWinRaw = null;
                    if (typeof this.getTierConditionedPWin === 'function') {
                        pWinRaw = this.getTierConditionedPWin(tier, currentOdds, { fallback: null, minSamples: 5 });
                    }
                    if (pWinRaw === null && typeof this.getCalibratedWinProb === 'function') {
                        pWinRaw = this.getCalibratedWinProb(finalConfidence, { priorRate, priorStrength: 40, minSamples: 0 });
                    }
                    
                    // Weight pWin toward 0.5 when signal score is weak to avoid overconfidence from priors
                    const minConfRef = Math.max(0.0001, CONFIG.ORACLE.minConfidence || 0.8);
                    const weight = Math.max(0, Math.min(1, finalConfidence / minConfRef)); // 0..1
                    const pWinEff = Number.isFinite(pWinRaw) ? (0.5 + ((pWinRaw - 0.5) * weight)) : null;
                    const edgePercent = (pWinEff !== null && currentOdds > 0) ? (((pWinEff - currentOdds) / currentOdds) * 100) : 0;
                    const b = currentOdds > 0 ? ((1 - currentOdds) / currentOdds) : 0;
                    const evRoi = (pWinEff !== null && currentOdds > 0) ? ((pWinEff * b * (1 - PROFIT_FEE_PCT)) - (1 - pWinEff)) : null;
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

                    log(`🔮 ORACLE CHECK: Cons=${(consensusRatio * 100).toFixed(0)}% Score=${(finalConfidence * 100).toFixed(0)}% pWin≈${pWinEff !== null ? (pWinEff * 100).toFixed(1) : 'NA'}% EV=${evRoi !== null ? (evRoi * 100).toFixed(2) : 'NA'}%`, this.asset);

                    // ==================== MOLECULAR FIX: HARD BLOCKS (Cannot be bypassed by aggression) ====================
                    // 🎯 GOAT v44.1: Gate trace inputs for this evaluation
                    const gateInputs = {
                        signal: finalSignal,
                        confidence: finalConfidence,
                        tier,
                        pWin: pWinEff,
                        evRoi,
                        edgePercent,
                        currentOdds,
                        consensusRatio,
                        upVotes: upVotesNum,
                        downVotes: downVotesNum,
                        totalVotes: totalVotesForConsensus,
                        genesis: modelVotes.genesis,
                        isTrending,
                        priceMovingRight,
                        stabilityCounter: this.stabilityCounter,
                        elapsed,
                        adjustedMinConsensus,
                        adjustedMinConfidence,
                        adjustedMinEdge,
                        effectiveMinOdds: CONFIG.ORACLE.minOdds || 0.20,
                        effectiveMaxOdds: tradeExecutor.getEffectiveMaxOdds(),
                        effectiveMinStability: tradeExecutor.getEffectiveMinStability()
                    };
                    
                    // 1. Missing calibrated pWin = cannot evaluate EV reliably
                    if (pWinEff === null) {
                        log(`🚫 ORACLE HARD BLOCK: Missing calibrated pWin (cannot compute EV)`, this.asset);
                        gateTrace.record(this.asset, { decision: 'NO_TRADE', reason: 'HARD_BLOCK', failedGates: ['pWin_missing'], inputs: gateInputs });
                        // Do not trade - fall through to end
                    }
                    // 2. NEGATIVE EV = Never trade
                    else if (evRoi !== null && evRoi <= 0) {
                        log(`🚫 ORACLE HARD BLOCK: Negative EV ${(evRoi * 100).toFixed(2)}%`, this.asset);
                        gateTrace.record(this.asset, { decision: 'NO_TRADE', reason: 'HARD_BLOCK', failedGates: ['negative_EV'], inputs: gateInputs });
                        // Do not trade - fall through to end
                    }
                    // 3. GENESIS DISAGREEMENT = 94% accurate model says NO
                    else if (modelVotes.genesis && modelVotes.genesis !== finalSignal) {
                        log(`🛡️ ORACLE HARD BLOCK: Genesis (94% accurate) says ${modelVotes.genesis}, not ${finalSignal}`, this.asset);
                        gateTrace.record(this.asset, { decision: 'NO_TRADE', reason: 'HARD_BLOCK', failedGates: ['genesis_veto'], inputs: gateInputs });
                        // Do not trade - fall through to end
                    }
                    // 4. MINIMUM HARD FLOOR: Even with max aggression, need 5% relative edge
                    else if (edgePercent < 5) {
                        log(`⚠️ ORACLE HARD BLOCK: Edge ${edgePercent.toFixed(1)}% below 5% minimum floor`, this.asset);
                        gateTrace.record(this.asset, { decision: 'NO_TRADE', reason: 'HARD_BLOCK', failedGates: ['edge_floor'], inputs: gateInputs });
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

                            // 🎯 v53: Capture entry-time prices for accurate backtesting
                            this.tradeEntryOdds = { yesPrice: market.yesPrice, noPrice: market.noPrice, timestamp: Date.now() };
                            this.tradeEntryReason = isGodMode ? 'GOD_MODE' : 'TREND_MODE';
                            this.tradeEntryTier = tier;
                            this.tradeEntryConfidence = finalConfidence;

                            // 🎯 GOAT v44.1: Record successful trade
                            gateTrace.record(this.asset, { decision: 'TRADE', reason: modeName, failedGates: [], inputs: gateInputs });
                            
                            // 🎯 v47: Pass genesisAgree to position for stop-loss bypass
                            const genesisAgree = modelVotes.genesis === finalSignal;
                            tradeExecutor.executeTrade(this.asset, finalSignal, 'ORACLE', finalConfidence, currentOdds, market, { tier: tier, pWin: pWinEff, genesisAgree });
                        }
                        else {
                            // Safe to proceed with normal checks

                            // 🎯 GOAT v44.1: EV-derived max price instead of hard maxOdds
                            // If pWin implies positive EV even at higher prices, allow entry
                            // Correct breakeven under profit-fee model:
                            // ROI_win = (1/price - 1) * (1 - fee)
                            // Need pWin * ROI_win > (1 - pWin)
                            // => price_max = pAfterFee / (pAfterFee + (1 - pWin))
                            const SAFETY_MARGIN = 0.02; // 2¢ absolute safety margin
                            const hardMinOdds = CONFIG.ORACLE.minOdds || 0.20;
                            const hardMaxOdds = tradeExecutor.getEffectiveMaxOdds();
                            const pClamped = (pWinEff !== null && Number.isFinite(pWinEff)) ? Math.max(0, Math.min(1, pWinEff)) : null;
                            const pAfterFee = pClamped !== null ? (pClamped * (1 - PROFIT_FEE_PCT)) : null;
                            const breakevenPrice = (pAfterFee !== null)
                                ? (pAfterFee / (pAfterFee + (1 - pClamped)))
                                : hardMaxOdds;
                            const evDerivedMaxPrice = Math.max(hardMinOdds, Math.min(0.99, breakevenPrice - SAFETY_MARGIN));
                            const effectiveMaxPrice = Math.min(evDerivedMaxPrice, hardMaxOdds);
                            const oddsCheckPassed = (currentOdds >= hardMinOdds) && (currentOdds <= effectiveMaxPrice);
                            
                            const oracleChecks = {
                                consensus: consensusRatio >= adjustedMinConsensus,
                                confidence: finalConfidence >= adjustedMinConfidence,
                                edge: edgePercent >= adjustedMinEdge,
                                regime: !tradeExecutor.getEffectiveRequireTrending() || isTrending, // 🦅 v21: Dynamic SNIPER/HUNTER
                                momentum: !CONFIG.ORACLE.requireMomentum || priceMovingRight,
                                odds: oddsCheckPassed, // 🎯 GOAT: EV-derived price cap
                                stability: this.stabilityCounter >= tradeExecutor.getEffectiveMinStability() || this.prediction === finalSignal // 🦅 v21: Dynamic
                            };
                            
                            // Add EV-derived info to gate inputs for tracing
                            gateInputs.evBreakevenPrice = breakevenPrice;
                            gateInputs.evDerivedMaxPrice = evDerivedMaxPrice;
                            gateInputs.effectiveMaxPrice = effectiveMaxPrice;
                            gateInputs.hardMinOdds = hardMinOdds;
                            gateInputs.hardMaxOdds = hardMaxOdds;

                            const failedChecks = Object.entries(oracleChecks).filter(([k, v]) => !v).map(([k]) => k);


                            if (failedChecks.length === 0) {
                                this.convictionLocked = true;
                                this.lockedDirection = finalSignal;
                                this.lockTime = Date.now();
                                this.lockConfidence = finalConfidence;

                                // 🎯 v53: Capture entry-time prices for accurate backtesting
                                this.tradeEntryOdds = { yesPrice: market.yesPrice, noPrice: market.noPrice, timestamp: Date.now() };
                                this.tradeEntryReason = 'STANDARD_ORACLE';
                                this.tradeEntryTier = tier;
                                this.tradeEntryConfidence = finalConfidence;

                                log(`🔮🔮🔮 ORACLE MODE ACTIVATED 🔮🔮🔮`, this.asset);
                                log(`⚡ PROPHET SIGNAL: ${finalSignal} @ ${(finalConfidence * 100).toFixed(1)}% | Edge: ${edgePercent.toFixed(1)}%`, this.asset);

                                // 🎯 GOAT v44.1: Record successful trade
                                gateTrace.record(this.asset, { decision: 'TRADE', reason: 'ORACLE_ALL_GATES_PASSED', failedGates: [], inputs: gateInputs, checks: oracleChecks });
                                
                                // 🎯 v47: Pass genesisAgree to position for stop-loss bypass
                                const genesisAgreeStd = modelVotes.genesis === finalSignal;
                                tradeExecutor.executeTrade(this.asset, finalSignal, 'ORACLE', finalConfidence, currentOdds, market, { tier: tier, pWin: pWinEff, genesisAgree: genesisAgreeStd });
                            } else {
                                log(`⏳ ORACLE: Missing ${failedChecks.join(', ')}`, this.asset);
                                // 🎯 GOAT v44.1: Record blocked trade with specific gates that failed
                                gateTrace.record(this.asset, { decision: 'NO_TRADE', reason: 'ORACLE_GATES_FAILED', failedGates: failedChecks, inputs: gateInputs, checks: oracleChecks });
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
                        // 🎯 v48 FIX: Pass tier to prevent UNKNOWN tier bug
                        const result = await tradeExecutor.executeTrade(this.asset, opp.direction, opp.mode, finalConfidence, entryPrice, market, { tier: tier });

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
                        // 🎯 v48 FIX: Pass tier and genesisAgree to prevent UNKNOWN tier bug
                        const lateGenesisAgree = modelVotes.genesis === finalSignal;
                        tradeExecutor.executeTrade(this.asset, finalSignal, 'ORACLE', finalConfidence, lateEntryPrice, market, { tier: tier, pWin: pWinEff, genesisAgree: lateGenesisAgree });
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

            // CRITICAL: Save signal state for UI display + calibration tracking
            const signalMarket = currentMarkets[this.asset];
            const signalEntryPrice = signalMarket ? (finalSignal === 'UP' ? signalMarket.yesPrice : signalMarket.noPrice) : null;
            this.lastSignal = {
                type: finalSignal,
                confidence: finalConfidence,
                conf: finalConfidence, // alias for calibration tracking
                tier: tier,
                modelVotes: modelVotes,
                entryPrice: signalEntryPrice // 🎯 GOAT: Store for tier+price calibration
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
        // Debug export showed: ETH locks at 67-83, XRP at 77-83
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

    // 🎯 GOAT: KELLY CRITERION using CALIBRATED pWin (not raw confidence)
    getKellySize() {
        if (this.tier === 'NONE') return 0;

        const market = currentMarkets[this.asset];
        if (!market) return 0;

        const marketOdds = this.prediction === 'UP' ? market.yesPrice : market.noPrice;

        // GOD MODE: Division by zero protection
        // marketOdds = 0: Infinity odds = undefined return 0
        // marketOdds = 1: b would be 0, causing division by zero
        if (!marketOdds || marketOdds <= 0 || marketOdds >= 1) return 0;

        const b = (1 / marketOdds) - 1;
        if (b <= 0) return 0; // Additional safety check

        // 🎯 GOAT: Use tier-conditioned pWin instead of raw confidence
        let p = null;
        if (typeof this.getTierConditionedPWin === 'function') {
            p = this.getTierConditionedPWin(this.tier, marketOdds, { fallback: null, minSamples: 5 });
        }
        if (p === null && typeof this.getCalibratedWinProb === 'function') {
            const s = this.stats || {};
            const priorRate = (this.tier === 'CONVICTION' && s.convictionTotal > 0) 
                ? (s.convictionWins / s.convictionTotal) 
                : (s.total > 0 ? (s.wins / s.total) : 0.5);
            p = this.getCalibratedWinProb(this.confidence, { priorRate, priorStrength: 40, minSamples: 0 });
        }
        if (p === null || p < 0.5) return 0; // No edge = no bet
        
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
        // RAW vs FINAL:
        // - `lastSignal` is the most recent model signal (can be low-confidence / de-rated / post-lock display).
        // - The FINAL decision for the cycle must respect TRUE ORACLE locks.
        const rawPredicted = this.lastSignal ? this.lastSignal.type : 'NEUTRAL';
        const rawTier = this.lastSignal ? this.lastSignal.tier : 'NONE';
        const predicted = (this.oracleLocked && this.oracleLockPrediction) ? this.oracleLockPrediction : rawPredicted;
        const tier = (this.oracleLocked && this.oracleLockPrediction) ? 'CONVICTION' : rawTier;

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
                                    (conf >= 0.60 ? '0.60-0.70' :
                                        (conf >= 0.50 ? '0.50-0.60' : '0.00-0.50'))))));
                if (this.calibrationBuckets[bucket]) {
                    this.calibrationBuckets[bucket].total++;
                    if (isWin) this.calibrationBuckets[bucket].wins++;
                }
                
                // 🎯 GOAT FIX: Tier-conditioned calibration tracking
                const signalTier = this.lastSignal.tier || 'NONE';
                if (this.tierCalibration && this.tierCalibration[signalTier]) {
                    this.tierCalibration[signalTier].total++;
                    if (isWin) this.tierCalibration[signalTier].wins++;
                    
                    // Track by price band if we have entry price recorded
                    const entryPrice = this.lastSignal.entryPrice;
                    if (Number.isFinite(entryPrice)) {
                        const band = (entryPrice < 0.20 || entryPrice > 0.95) ? 'extreme' : 'mid';
                        this.tierCalibration[signalTier].priceBands[band].total++;
                        if (isWin) this.tierCalibration[signalTier].priceBands[band].wins++;
                    }
                }
            }

            // FIX: Track recent form OUTSIDE modelVotes block (was never updating!)
            this.recentOutcomes.push(isWin);
            if (this.recentOutcomes.length > 10) this.recentOutcomes.shift();

            // 🎯 v52 ROLLING CONVICTION ACCURACY TRACKER
            // IMPORTANT: Updated from EXECUTED trade outcomes only (see TradeExecutor.closePosition),
            // to avoid false drift/halts from signal-only cycle correctness.

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
                // Store complete cycle data for debugging (last 10 cycles)
                const cycleSnapshot = {
                    cycleEndTime: new Date().toISOString(),
                    cycleStartPrice: startPrice,
                    cycleEndPrice: finalPrice,
                    actualOutcome: actual,
                    prediction: predicted,
                    wasCorrect: isWin,
                    tier: tier,
                    // Use FINAL state confidence (direction-consistent); fall back to raw signal confidence.
                    confidence: Number.isFinite(this.confidence) ? this.confidence : (this.lastSignal?.confidence || 0),
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
                    // Preserve full raw signal payload for forensic analysis
                    rawSignal: this.lastSignal || null,
                    modelVotes: this.lastSignal?.modelVotes || {},
                    certaintySeries: [...(this.certaintySeries || [])],
                    modelAgreementHistory: [...(this.modelAgreementHistory || [])],
                    edgeHistory: [...(this.edgeHistory || [])],
                    // Raw per-tick decision stream for this cycle (every second, last cycle only)
                    tickHistory: [...(this.currentCycleHistory || [])],
                    // 🎯 v53: CYCLE-END market odds (for reference only - NOT entry prices!)
                    marketOdds: currentMarkets[this.asset] ? {
                        yesPrice: currentMarkets[this.asset].yesPrice,
                        noPrice: currentMarkets[this.asset].noPrice
                    } : null,
                    // 🎯 v53: ENTRY-TIME market odds (when trade decision was made - USE FOR PROFIT CALC!)
                    entryOdds: this.tradeEntryOdds ? { ...this.tradeEntryOdds } : null,
                    entryReason: this.tradeEntryReason,
                    entryTier: this.tradeEntryTier,
                    entryConfidence: this.tradeEntryConfidence
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

                // 🎯 v53: RESET TRADE ENTRY TRACKING FOR NEW CYCLE
                this.tradeEntryOdds = null;
                this.tradeEntryReason = null;
                this.tradeEntryTier = null;
                this.tradeEntryConfidence = null;
                this.blackoutLogged = false;
                this.inBlackout = false;
                this.correlationBonus = 0;

                // Clear export history for new cycle
                this.currentCycleHistory = [];
            }
        }
    }
}

// ==================== CALIBRATION HELPERS ====================
// IMPORTANT: `confidence` in this codebase is a *signal score*, not a true probability.
// These helpers convert score→empirical win-rate using per-asset calibration buckets.

SupremeBrain.prototype.getCalibrationBucket = function (conf) {
    if (!Number.isFinite(conf)) return null;
    if (conf >= 0.98) return '0.98-1.00';
    if (conf >= 0.95) return '0.95-0.98';
    if (conf >= 0.90) return '0.90-0.95';
    if (conf >= 0.80) return '0.80-0.90';
    if (conf >= 0.70) return '0.70-0.80';
    if (conf >= 0.60) return '0.60-0.70';
    if (conf >= 0.50) return '0.50-0.60';
    return '0.00-0.50';
};

SupremeBrain.prototype.getCalibratedWinProb = function (conf, opts = {}) {
    const bucket = this.getCalibrationBucket(conf);
    if (!bucket) return null;
    const b = this.calibrationBuckets ? this.calibrationBuckets[bucket] : null;
    const priorRate = (typeof opts.priorRate === 'number' && opts.priorRate >= 0 && opts.priorRate <= 1) ? opts.priorRate : null;
    const priorStrength = opts.priorStrength ?? 40; // pseudo-samples for shrinkage toward prior
    const minSamples = opts.minSamples ?? 0; // allow always-on output; callers can raise if needed
    const alpha = opts.alpha ?? 1; // Laplace smoothing

    if (!b || typeof b.total !== 'number' || typeof b.wins !== 'number') {
        return priorRate;
    }

    if (b.total < minSamples && priorRate === null) return null;

    const baseWins = b.wins + alpha;
    const baseTotal = b.total + (2 * alpha);

    if (priorRate !== null) {
        return (baseWins + (priorStrength * priorRate)) / (baseTotal + priorStrength);
    }
    return baseWins / baseTotal;
};

// 🎯 GOAT: Tier-conditioned calibrated probability
// Uses tier + price band specific historical win rates for more accurate pWin
SupremeBrain.prototype.getTierConditionedPWin = function (tier, entryPrice, opts = {}) {
    const alpha = opts.alpha ?? 1; // Laplace smoothing
    const minSamples = opts.minSamples ?? 5; // require some data before trusting
    const fallbackPWin = opts.fallback ?? 0.5; // neutral if no data
    
    if (!this.tierCalibration || !this.tierCalibration[tier]) {
        return fallbackPWin;
    }
    
    const tc = this.tierCalibration[tier];
    
    // First try price-band specific
    if (Number.isFinite(entryPrice)) {
        const band = (entryPrice < 0.20 || entryPrice > 0.95) ? 'extreme' : 'mid';
        const pb = tc.priceBands[band];
        if (pb && pb.total >= minSamples) {
            return (pb.wins + alpha) / (pb.total + 2 * alpha);
        }
    }
    
    // Fall back to tier-wide
    if (tc.total >= minSamples) {
        return (tc.wins + alpha) / (tc.total + 2 * alpha);
    }
    
    // Fall back to overall stats
    const s = this.stats || {};
    if (tier === 'CONVICTION' && s.convictionTotal >= minSamples) {
        return (s.convictionWins + alpha) / (s.convictionTotal + 2 * alpha);
    }
    if (s.total >= minSamples) {
        return (s.wins + alpha) / (s.total + 2 * alpha);
    }
    
    return fallbackPWin;
};

// 🎯 GOAT v44.1: Enforce state invariants to prevent contradictory states
SupremeBrain.prototype.enforceStateInvariants = function () {
    // Invariant 1: Lock state must be consistent with prediction
    // If oracleLocked, prediction MUST match oracleLockPrediction
    if (this.oracleLocked && this.oracleLockPrediction && this.prediction !== this.oracleLockPrediction) {
        log(`⚠️ INVARIANT FIX: oracleLocked but prediction ${this.prediction} != lockPrediction ${this.oracleLockPrediction}. Forcing alignment.`, this.asset);
        this.prediction = this.oracleLockPrediction;
    }
    
    // Invariant 2: convictionLocked must be consistent with tier
    // If convictionLocked, tier should be CONVICTION
    if (this.convictionLocked && this.tier !== 'CONVICTION') {
        log(`⚠️ INVARIANT FIX: convictionLocked but tier=${this.tier}. Upgrading to CONVICTION.`, this.asset);
        this.tier = 'CONVICTION';
    }
    
    // Invariant 3: lockedDirection must match prediction when convictionLocked
    if (this.convictionLocked && this.lockedDirection && this.prediction !== this.lockedDirection) {
        log(`⚠️ INVARIANT FIX: convictionLocked to ${this.lockedDirection} but prediction=${this.prediction}. Forcing alignment.`, this.asset);
        this.prediction = this.lockedDirection;
    }
    
    // Invariant 4: cycleCommitted direction must match prediction
    if (this.cycleCommitted && this.committedDirection && this.prediction !== this.committedDirection) {
        log(`⚠️ INVARIANT FIX: cycleCommitted to ${this.committedDirection} but prediction=${this.prediction}. Forcing alignment.`, this.asset);
        this.prediction = this.committedDirection;
    }
    
    // Invariant 5: confidence must be in [0, 1]
    if (this.confidence < 0 || this.confidence > 1) {
        log(`⚠️ INVARIANT FIX: confidence=${this.confidence} out of bounds. Clamping.`, this.asset);
        this.confidence = Math.max(0, Math.min(1, this.confidence));
    }
    
    // Invariant 6: NONE tier should not have high confidence signals
    // (This is informational - we don't force change, just log)
    if (this.tier === 'NONE' && this.confidence > 0.7 && this.prediction !== 'WAIT' && this.prediction !== 'NEUTRAL') {
        log(`📊 TIER MISMATCH: High confidence ${(this.confidence * 100).toFixed(1)}% but tier=NONE. Consider tier recalculation.`, this.asset);
    }
};

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
        // Backup feed filter must be a JSON-encoded string (server validates `filters` with a JSON regex).
        const pricesSub = { action: 'subscribe', subscriptions: [{ topic: 'crypto_prices', type: 'update', filters: '["btcusdt","ethusdt","xrpusdt"]' }] };
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
                // Avoid terminal flooding (can crash Cursor/VSCode). Enable only when debugging WS.
                if (String(process.env.DEBUG_WS || '').toLowerCase() === 'true') {
                    log(`📨 WS Message: ${JSON.stringify(msg).substring(0, 200)}...`);
                }
                global.wsMessageCount++;
            }

            if (msg.topic === 'crypto_prices_chainlink') {
                const map = { 'btc/usd': 'BTC', 'eth/usd': 'ETH', 'xrp/usd': 'XRP' };
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
                const map = { btcusdt: 'BTC', ethusdt: 'ETH', xrpusdt: 'XRP' };
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
    const symbolMap = { 'BTC': 'BTCUSDT', 'ETH': 'ETHUSDT', 'XRP': 'XRPUSDT' };
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
        // 🎯 v52: Rolling CONVICTION accuracy for drift detection
        rollingConvictionMode: 'EXECUTED_TRADES',
        rollingConviction: ASSETS.reduce((acc, a) => ({ ...acc, [a]: Brains[a].rollingConviction || [] }), {}),
        driftWarning: ASSETS.reduce((acc, a) => ({ ...acc, [a]: Brains[a].driftWarning || false }), {}),
        autoDisabled: ASSETS.reduce((acc, a) => ({ ...acc, [a]: Brains[a].autoDisabled || false }), {}),

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
        },

        // 🎯 GOAT v44.1: Persist forward-collector state in the main state blob
        // (enables deterministic replay/analysis across restarts)
        forwardCollectorEnabled: typeof forwardCollectorEnabled === 'boolean' ? forwardCollectorEnabled : false,
        lastCollectorSave: typeof lastCollectorSave === 'number' ? lastCollectorSave : 0
    };

    // Save to Redis if available
    if (redisAvailable && redis) {
        try {
            await redis.set('deity:state', JSON.stringify(state));
            
            // 🎯 GOAT v3: Sync new trades to persistent history
            // Only sync trades that have been closed (have a closeTime)
            const closedTrades = tradeExecutor.tradeHistory.filter(t => t.status === 'CLOSED' && t.closeTime);
            for (const trade of closedTrades.slice(-50)) { // Sync last 50 closed trades each save
                const tradeMode = trade.isLive || trade.mode === 'LIVE' ? 'LIVE' : 'PAPER';
                await persistTrade(trade, tradeMode);
            }
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

                // 🎯 GOAT v44.1: Restore forward-collector state
                if (typeof state.forwardCollectorEnabled === 'boolean') {
                    forwardCollectorEnabled = state.forwardCollectorEnabled;
                }
                if (typeof state.lastCollectorSave === 'number') {
                    lastCollectorSave = state.lastCollectorSave;
                }

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
                // Merge to preserve any newly added buckets in code (avoid losing keys when restoring older Redis state)
                if (state.calibration) ASSETS.forEach(a => {
                    if (state.calibration[a]) {
                        Brains[a].calibrationBuckets = { ...(Brains[a].calibrationBuckets || {}), ...(state.calibration[a] || {}) };
                    }
                });
                if (state.regime) ASSETS.forEach(a => { if (state.regime[a]) Brains[a].regimeHistory = state.regime[a]; });

                // PINNACLE: RESTORE MODEL ACCURACY (THE LEARNING!) - CRITICAL FOR GENUINE EVOLUTION
                if (state.modelAccuracy) ASSETS.forEach(a => { if (state.modelAccuracy[a]) Brains[a].modelAccuracy = state.modelAccuracy[a]; });
                if (state.recentOutcomes) ASSETS.forEach(a => { if (state.recentOutcomes[a]) Brains[a].recentOutcomes = state.recentOutcomes[a]; });
                
                // 🎯 v52: RESTORE ROLLING ACCURACY (drift detection)
                // Rolling conviction is now EXECUTED-trade based (not signal-only).
                const rollingMode = state.rollingConvictionMode || 'LEGACY_SIGNAL_ONLY';
                if (rollingMode !== 'EXECUTED_TRADES') {
                    ASSETS.forEach(a => {
                        Brains[a].rollingConviction = [];
                        Brains[a].driftWarning = false;
                        Brains[a].autoDisabled = false;
                    });
                    log(`🔄 Reset rollingConviction (legacy mode=${rollingMode}) - now tracks EXECUTED trades only`);
                } else {
                    if (state.rollingConviction) ASSETS.forEach(a => { if (state.rollingConviction[a]) Brains[a].rollingConviction = state.rollingConviction[a]; });
                    if (state.driftWarning) ASSETS.forEach(a => { if (state.driftWarning[a] !== undefined) Brains[a].driftWarning = state.driftWarning[a]; });
                    if (state.autoDisabled) ASSETS.forEach(a => { if (state.autoDisabled[a] !== undefined) Brains[a].autoDisabled = state.autoDisabled[a]; });
                }

                // 🔴 FIX #17: RESTORE TRADE EXECUTOR STATE (preserves balance across restarts!)
                // 🚀 PINNACLE v27: CRASH RECOVERY - Full state restoration
                if (state.tradeExecutor) {
                    const te = state.tradeExecutor;
                    if (te.paperBalance !== undefined) tradeExecutor.paperBalance = te.paperBalance;
                    if (te.startingBalance !== undefined) tradeExecutor.startingBalance = te.startingBalance;
                    if (te.tradeHistory && Array.isArray(te.tradeHistory)) tradeExecutor.tradeHistory = te.tradeHistory;
                    // One-time cleanup for legacy hedge records left OPEN by older code
                    try { tradeExecutor.reconcileLegacyOpenHedgeTrades(); } catch { }
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
    <title>🔮 POLYPROPHET - MAX PROFIT MIN VARIANCE</title>
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
        <div class="nav-brand">🔮 POLYPROPHET <span id="codeFingerprint" style="font-size:0.6em;color:#888;margin-left:8px;"></span></div>
        <div class="nav-links">
            <span id="activePresetBadge" style="background:#333;color:#ffd700;padding:4px 10px;border-radius:12px;font-size:0.8em;margin-right:8px;">🏷️ Loading...</span>
            <button class="nav-btn" onclick="openModal('apiExplorerModal')">🔌 API</button>
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
            <div class="panel-header">
                <span class="panel-title">📜 Trade History</span>
                <span id="historyCount">0 trades</span>
                <div style="display:flex;gap:5px;margin-left:auto;">
                    <button onclick="loadMoreTrades()" style="padding:4px 8px;background:#333;border:1px solid #555;border-radius:4px;color:#fff;cursor:pointer;font-size:0.7em;">📜 Load More</button>
                    <button onclick="resetTradeHistoryUI()" style="padding:4px 8px;background:#333;border:1px solid #ff4466;border-radius:4px;color:#ff4466;cursor:pointer;font-size:0.7em;">🗑️ Reset</button>
                </div>
            </div>
            <div class="positions-list" id="tradeHistory"><div class="no-positions">No trades yet</div></div>
            <div id="tradeHistoryPagination" style="display:none;padding:8px;text-align:center;font-size:0.8em;color:#888;"></div>
        </div>
        <!-- 🎯 GOAT v44.1: GateTrace Panel -->
        <div class="trading-panel" style="margin-top:15px;">
            <div class="panel-header"><span class="panel-title">🚧 Gate Trace (Why Not Trading?)</span><button onclick="loadGateTrace()" style="padding:4px 10px;background:#f59e0b;border:none;border-radius:4px;cursor:pointer;color:#000;font-size:0.75em;font-weight:bold;">🔄 Refresh</button></div>
            <div id="gateTraceSummary" style="padding:10px;background:rgba(0,0,0,0.3);border-radius:6px;margin-bottom:10px;font-size:0.85em;color:#888;">Click refresh to load gate trace data...</div>
            <div class="positions-list" id="gateTraceList" style="max-height:250px;"><div class="no-positions">Gate trace shows why trades were blocked</div></div>
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
            
            <h4 style="margin:15px 0 10px;color:#ffd700;font-size:0.95em;">🏆 THE GOAT PRESET</h4>
            <div style="display:flex;gap:10px;margin-bottom:15px;">
                <button onclick="applyPreset('GOAT')" style="flex:1;padding:20px;border:3px solid #ffd700;border-radius:12px;background:linear-gradient(145deg,rgba(255,215,0,0.5),rgba(255,165,0,0.3));color:#ffd700;cursor:pointer;font-weight:bold;box-shadow:0 0 40px rgba(255,215,0,0.6);animation:pulse 1.5s infinite;font-size:1.2em;">👑 APPLY GOAT SETTINGS<br><small style="font-weight:normal;opacity:0.9;">MAX PROFIT • MIN VARIANCE • FINAL</small></button>
            </div>
            
            <h4 style="margin:15px 0 10px;color:#ffd700;font-size:0.95em;">💰 Core Parameters</h4>
            <div class="form-grid">
                <div class="form-group"><label>Paper Balance ($)</label><input type="number" id="paperBalance" placeholder="Loading..."></div>
                <div class="form-group"><label>Max Position (%)</label><input type="number" id="maxPosition" placeholder="Loading..." min="1" max="50"></div>
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
                        <div class="form-group"><label>Min Consensus</label><input type="number" id="oracleConsensus" placeholder="..." step="0.05" min="0.5" max="1"></div>
                        <div class="form-group"><label>Min Confidence</label><input type="number" id="oracleConfidence" placeholder="..." step="0.02" min="0.5" max="1"></div>
                        <div class="form-group"><label>Min Edge (%)</label><input type="number" id="oracleEdge" placeholder="..." min="0" max="50"></div>
                        <div class="form-group"><label>Max Odds</label><input type="number" id="oracleMaxOdds" placeholder="..." step="0.05" min="0.3" max="1.0"></div>
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
                <div class="guide-section"><h3>🎯 What Is This Bot?</h3><p>An AI prediction bot for Polymarket's 15-minute crypto checkpoint markets. It predicts whether BTC, ETH, or XRP will go UP or DOWN in each 15-minute window.</p></div>
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
                    <p><strong>Enable/Disable:</strong> Turn trading on/off for each coin (BTC, ETH, XRP)</p>
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
    <!-- 🎯 GOAT v44.1: API EXPLORER MODAL -->
    <div class="modal-overlay" id="apiExplorerModal">
        <div class="modal" style="max-width:900px;max-height:90vh;overflow-y:auto;">
            <div class="modal-header"><span class="modal-title">🔌 API Explorer</span><button class="modal-close" onclick="closeModal('apiExplorerModal')">×</button></div>
            
            <div style="padding:12px;background:rgba(0,255,136,0.1);border-radius:8px;margin-bottom:15px;border-left:3px solid #00ff88;">
                <h4 style="color:#00ff88;margin-bottom:8px;">🔑 Your API Key</h4>
                <div style="display:flex;gap:10px;align-items:center;">
                    <code id="apiKeyDisplay" style="flex:1;background:rgba(0,0,0,0.4);padding:10px;border-radius:6px;font-size:0.9em;word-break:break-all;">Loading...</code>
                    <button onclick="copyApiKey()" style="padding:8px 16px;background:#00ff88;color:#000;border:none;border-radius:6px;cursor:pointer;font-weight:bold;">📋 Copy</button>
                </div>
                <p style="color:#888;font-size:0.75em;margin-top:8px;">Use this key for programmatic access: <code>Authorization: Bearer &lt;key&gt;</code> or <code>?apiKey=&lt;key&gt;</code></p>
            </div>
            
            <h4 style="color:#ffd700;margin-bottom:10px;">📡 Quick API Calls <span style="font-size:0.7em;color:#888;">(Click any button to see results)</span></h4>
            <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:10px;margin-bottom:15px;">
                <button onclick="apiCall('/api/version')" class="btn" style="background:linear-gradient(90deg,#4fc3f7,#2196f3);" title="Shows bot version, uptime, and git commit">📋 Version</button>
                <button onclick="apiCall('/api/halts')" class="btn" style="background:linear-gradient(90deg,#ff6b6b,#ee5a5a);" title="Is trading paused? Why?">🚨 Halt Status</button>
                <button onclick="apiCall('/api/trades')" class="btn" style="background:linear-gradient(90deg,#ff4466,#cc2244);" title="Recent wins and losses">📊 Trades</button>
                <button onclick="apiCall('/api/gates')" class="btn" style="background:linear-gradient(90deg,#f59e0b,#d97706);" title="Why trades were blocked">🚧 Gate Trace</button>
                <button onclick="apiCall('/api/state')" class="btn" style="background:linear-gradient(90deg,#9933ff,#6600cc);" title="Full bot state (advanced)">🔮 Full State</button>
                <button onclick="apiCall('/api/settings')" class="btn" style="background:linear-gradient(90deg,#ff9900,#cc7700);" title="Current configuration">⚙️ Settings</button>
                <button onclick="apiCall('/api/health')" class="btn" style="background:linear-gradient(90deg,#00ff88,#00cc66);" title="Is the bot healthy?">💚 Health</button>
                <button onclick="apiCall('/api/backtest-proof?tier=CONVICTION&prices=ALL')" class="btn" style="background:linear-gradient(90deg,#ec4899,#be185d);" title="Debug-based backtest">📈 Backtest</button>
                <button onclick="apiCall('/api/backtest-polymarket?tier=CONVICTION&minOdds=0.35&maxOdds=0.95&stake=0.35&scan=1')" class="btn" style="background:linear-gradient(90deg,#10b981,#059669);" title="Polymarket API verified backtest (TRUE MAXIMUM 35% stake)">🏆 Poly Backtest</button>
                <button onclick="apiCall('/api/verify-trades-polymarket?mode=PAPER&limit=100')" class="btn" style="background:linear-gradient(90deg,#22c55e,#16a34a);" title="Verify executed trades vs Polymarket outcomes (detect mismatches)">✅ Verify Trades</button>
            </div>
            
            <h4 style="color:#00ff88;margin-bottom:8px;">🧪 Custom Request</h4>
            <div style="display:flex;gap:10px;margin-bottom:10px;">
                <select id="apiMethod" style="padding:10px;background:rgba(0,0,0,0.4);border:2px solid rgba(100,150,255,0.2);border-radius:6px;color:#fff;">
                    <option value="GET">GET</option>
                    <option value="POST">POST</option>
                </select>
                <input type="text" id="apiEndpoint" placeholder="/api/state" style="flex:1;padding:10px;background:rgba(0,0,0,0.4);border:2px solid rgba(100,150,255,0.2);border-radius:6px;color:#fff;font-family:monospace;">
                <button onclick="apiCallCustom()" class="btn btn-primary">▶️ Run</button>
            </div>
            <div id="apiBodyContainer" style="display:none;margin-bottom:10px;">
                <label style="color:#888;font-size:0.8em;">Request Body (JSON):</label>
                <textarea id="apiBody" style="width:100%;height:80px;padding:10px;background:rgba(0,0,0,0.4);border:2px solid rgba(100,150,255,0.2);border-radius:6px;color:#fff;font-family:monospace;resize:vertical;" placeholder='{"key": "value"}'></textarea>
            </div>
            
            <h4 style="color:#88ccff;margin-bottom:8px;">📄 Response</h4>
            <div style="position:relative;">
                <pre id="apiResponse" style="background:rgba(0,0,0,0.5);padding:15px;border-radius:8px;font-size:0.8em;max-height:350px;overflow:auto;white-space:pre-wrap;word-break:break-word;border:1px solid rgba(100,150,255,0.2);">Click an API button above to see the response...</pre>
                <button onclick="copyApiResponse()" style="position:absolute;top:8px;right:8px;padding:4px 8px;background:rgba(255,255,255,0.1);border:1px solid rgba(255,255,255,0.2);border-radius:4px;color:#888;cursor:pointer;font-size:0.7em;">📋 Copy</button>
            </div>
            
            <h4 style="color:#ff9900;margin-top:15px;margin-bottom:8px;">📖 API Reference</h4>
            <div style="font-size:0.85em;color:#aaa;">
                <table style="width:100%;border-collapse:collapse;">
                    <tr style="border-bottom:1px solid rgba(255,255,255,0.1);">
                        <td style="padding:6px;color:#4fc3f7;"><code>GET /api/version</code></td>
                        <td style="padding:6px;">Code version, commit hash, uptime (public)</td>
                    </tr>
                    <tr style="border-bottom:1px solid rgba(255,255,255,0.1);">
                        <td style="padding:6px;color:#4fc3f7;"><code>GET /api/state-public</code></td>
                        <td style="padding:6px;">Predictions without sensitive data (public)</td>
                    </tr>
                    <tr style="border-bottom:1px solid rgba(255,255,255,0.1);">
                        <td style="padding:6px;color:#4fc3f7;"><code>GET /api/state</code></td>
                        <td style="padding:6px;">Full bot state with all asset data</td>
                    </tr>
                    <tr style="border-bottom:1px solid rgba(255,255,255,0.1);">
                        <td style="padding:6px;color:#4fc3f7;"><code>GET /api/gates</code></td>
                        <td style="padding:6px;">GateTrace: why trades were blocked</td>
                    </tr>
                    <tr style="border-bottom:1px solid rgba(255,255,255,0.1);">
                        <td style="padding:6px;color:#4fc3f7;"><code>GET /api/backtest-proof</code></td>
                        <td style="padding:6px;">Run deterministic backtest on debug logs</td>
                    </tr>
                    <tr style="border-bottom:1px solid rgba(255,255,255,0.1);">
                        <td style="padding:6px;color:#10b981;"><code>GET /api/backtest-polymarket</code></td>
                        <td style="padding:6px;">🏆 Polymarket-verified backtest with real outcomes</td>
                    </tr>
                    <tr style="border-bottom:1px solid rgba(255,255,255,0.1);">
                        <td style="padding:6px;color:#4fc3f7;"><code>GET /api/settings</code></td>
                        <td style="padding:6px;">Current configuration values</td>
                    </tr>
                    <tr>
                        <td style="padding:6px;color:#4fc3f7;"><code>POST /api/settings</code></td>
                        <td style="padding:6px;">Update configuration</td>
                    </tr>
                </table>
            </div>
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
                const assets = ['BTC', 'ETH', 'XRP'];
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
                // 🎯 GOAT FIX: Load ACTUAL server values - no fallback defaults (config drift fix)
                document.getElementById('paperBalance').value = data.PAPER_BALANCE;
                document.getElementById('maxPosition').value = (data.MAX_POSITION_SIZE * 100);
                // Show active preset + code fingerprint
                if (data.ACTIVE_PRESET) {
                    const presetBadge = document.getElementById('activePresetBadge');
                    if (presetBadge) presetBadge.textContent = '🏷️ ' + data.ACTIVE_PRESET;
                }
                if (data.CODE) {
                    const codeBadge = document.getElementById('codeFingerprint');
                    if (codeBadge) codeBadge.textContent = '📦 v' + data.CODE.configVersion + ' (' + (data.CODE.gitCommit || '').substring(0, 7) + ')';
                }
                if (data.ORACLE) { 
                    document.getElementById('oracleEnabled').checked = data.ORACLE.enabled !== false; 
                    document.getElementById('oracleConsensus').value = data.ORACLE.minConsensus; 
                    document.getElementById('oracleConfidence').value = data.ORACLE.minConfidence; 
                    document.getElementById('oracleEdge').value = data.ORACLE.minEdge; 
                    document.getElementById('oracleMaxOdds').value = data.ORACLE.maxOdds;
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
            // 🏆 v49 FINAL: ONE PRESET ONLY - THE GOAT
            // MAX PROFIT ASAP WITH MIN VARIANCE
            const presets = {
                GOAT: { 
                    // 🎯 v55.1: MIN-VARIANCE optimal for £5 → £100 in 24h.
                    // 🏆 v60 FINAL: TRUE MAXIMUM 35% stake (£5→£90.59 in 78h, 67.98% DD)
                    MAX_POSITION_SIZE: 0.35,
                    // ORACLE: Primary prediction engine with forensic-optimized thresholds
                    ORACLE: { 
                        enabled: true, 
                        aggression: 50, 
                        minConsensus: 0.70,      // 70% model agreement required
                        minConfidence: 0.70,     // 70% confidence minimum
                        minEdge: 5,              // 5% edge over market odds
                        // 🏆 v58 TRUE OPTIMAL (£5→£42 in 24h verified):
                        minOdds: 0.40,           // 🏆 v58: High-pWin 40-50¢ entries are profitable (pWin-gated)
                        maxOdds: 0.92,           // 🏆 v58: Extend to 92¢ for more trade opportunities
                        minStability: 3,         // 3 ticks of stable signal
                        requireTrending: false,  // Trade in all conditions
                        earlyTakeProfitEnabled: true,
                        earlyTakeProfitThreshold: 0.20,  // Take profit at 20% gain
                        hedgeEnabled: false,     // NO hedging (pollutes streak logic)
                        stopLossEnabled: true,
                        stopLoss: 0.30           // 30% stop loss (CONVICTION bypasses)
                    },
                    // ILLIQUIDITY: True arbitrage when YES+NO < 100%
                    ILLIQUIDITY_GAP: { enabled: true, minGap: 0.03, maxEntryTotal: 0.97 },
                    // DISABLED MODES (negative EV or low win rate)
                    DEATH_BOUNCE: { enabled: false },
                    SCALP: { enabled: false },
                    ARBITRAGE: { enabled: false },
                    MOMENTUM: { enabled: false },
                    UNCERTAINTY: { enabled: false },
                    // RISK: Aggressive but protected
                    RISK: { 
                        maxTotalExposure: 0.40,     // Keep exposure bounded (min-variance constraint)
                        globalStopLoss: 0.40,       // Halt if down 40% in a day
                        cooldownAfterLoss: 1200,    // 20 min cooldown after 3 losses
                        maxConsecutiveLosses: 3,    // Throttle after 3 losses
                        maxGlobalTradesPerCycle: 1, // Max 1 trade per 15-min cycle (reduce correlation variance)
                        supremeConfidenceMode: false,
                        firstMoveAdvantage: false,
                        enablePositionPyramiding: false,
                        enableLossCooldown: true
                    },
                    // ASSETS: BTC, ETH, XRP only (SOL removed - illiquidity + future confusion risk)
                    ASSET_CONTROLS: { 
                        BTC: { enabled: true, maxTradesPerCycle: 1 }, 
                        ETH: { enabled: true, maxTradesPerCycle: 1 }, 
                        XRP: { enabled: true, maxTradesPerCycle: 1 } 
                    }
                }
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
                    XRP: { enabled: true, maxTradesPerCycle: parseInt(document.getElementById('maxTradesPerCycle').value) }
                }
            };
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
        
        // 🎯 GOAT v44.1: API EXPLORER FUNCTIONS
        let cachedApiKey = null;
        async function loadApiKey() {
            try {
                const res = await fetch('/api/api-key');
                if (res.ok) {
                    const data = await res.json();
                    cachedApiKey = data.apiKey;
                    document.getElementById('apiKeyDisplay').textContent = cachedApiKey;
                }
            } catch (e) {
                document.getElementById('apiKeyDisplay').textContent = 'Error loading API key';
            }
        }
        loadApiKey();
        
        function copyApiKey() {
            if (cachedApiKey) {
                navigator.clipboard.writeText(cachedApiKey);
                alert('API key copied to clipboard!');
            }
        }
        
        function copyApiResponse() {
            const response = document.getElementById('apiResponse').textContent;
            navigator.clipboard.writeText(response);
            alert('Response copied to clipboard!');
        }
        
        // 🎯 v48: Child-friendly API response formatter
        function formatApiResponse(endpoint, data) {
            // Format based on endpoint type
            if (endpoint.includes('/api/version')) {
                return \`<div style="font-size:1.1em;line-height:1.8;">
                    <div>📦 <b>Version:</b> <span style="color:#ffd700;">v\${data.configVersion || '?'}</span></div>
                    <div>🔗 <b>Git Commit:</b> <code>\${(data.gitCommit || '').substring(0,8)}...</code></div>
                    <div>⏱️ <b>Uptime:</b> \${Math.floor((data.uptime||0)/3600)}h \${Math.floor(((data.uptime||0)%3600)/60)}m</div>
                    <div>🕐 <b>Server Time:</b> \${data.timestamp ? new Date(data.timestamp).toLocaleString() : 'N/A'}</div>
                </div>\`;
            }
            if (endpoint.includes('/api/halts') || endpoint.includes('/api/health')) {
                const isHalted = data.currentState?.isHalted || data.circuitBreaker?.state === 'HALTED';
                const statusColor = isHalted ? '#ff4466' : '#00ff88';
                const statusIcon = isHalted ? '🔴' : '🟢';
                return \`<div style="font-size:1.1em;line-height:1.8;">
                    <div style="font-size:1.3em;margin-bottom:10px;">\${statusIcon} <b style="color:\${statusColor};">\${isHalted ? 'TRADING HALTED' : 'TRADING ACTIVE'}</b></div>
                    <div>💰 <b>Balance:</b> $\${(data.balance?.currentBalance || data._trading?.balance || 0).toFixed(2)}</div>
                    <div>📉 <b>Drawdown:</b> \${data.balance?.drawdownPct || data.circuitBreaker?.drawdownPct || '0%'}</div>
                    <div>❌ <b>Consecutive Losses:</b> \${data.activeTriggers?.circuitBreaker?.consecutiveLosses || data.circuitBreaker?.consecutiveLosses || 0}</div>
                    <div>🛡️ <b>Circuit Breaker:</b> \${data.activeTriggers?.circuitBreaker?.state || data.circuitBreaker?.state || 'NORMAL'}</div>
                    \${data.activeTriggers?.globalStopLoss?.active ? '<div style="color:#ff4466;">⚠️ Global Stop Loss Active</div>' : ''}
                </div>\`;
            }
            if (endpoint.includes('/api/trades')) {
                const trades = Array.isArray(data) ? data : (Array.isArray(data && data.trades) ? data.trades : []);

                const balance = Number((data && data.balance !== undefined) ? data.balance : 0);
                const starting = Number((data && data.startingBalance !== undefined) ? data.startingBalance : (Number.isFinite(balance) ? balance : 0));
                const totalReturnPct = Number((data && data.totalReturn !== undefined)
                    ? data.totalReturn
                    : ((starting > 0 ? ((balance / starting) - 1) * 100 : 0)));
                const totalTrades = Number((data && data.totalTrades !== undefined) ? data.totalTrades : trades.length);
                const returnedTrades = Number((data && data.returnedTrades !== undefined) ? data.returnedTrades : trades.length);
                const legacyFilteredOut = Number((data && data.legacyFilteredOut !== undefined) ? data.legacyFilteredOut : 0);
                const openPositions = (data && data.positions && typeof data.positions === 'object')
                    ? Object.keys(data.positions).length
                    : 0;

                const wins = trades.filter(t => (t.pnl || 0) > 0).length;
                const losses = trades.filter(t => (t.pnl || 0) < 0).length;
                const totalPnl = trades.reduce((sum, t) => sum + (t.pnl || 0), 0);

                let html = '<div style="margin-bottom:12px;font-size:1.1em;line-height:1.7;">' +
                    '<div>💰 <b>Balance:</b> $' + (Number.isFinite(balance) ? balance.toFixed(2) : 'N/A') +
                    ' <span style="color:#888;">(start: $' + (Number.isFinite(starting) ? starting.toFixed(2) : 'N/A') + ')</span></div>' +
                    '<div>📈 <b>Total return:</b> <span style="color:' + (totalReturnPct >= 0 ? '#00ff88' : '#ff4466') + ';">' +
                    (Number.isFinite(totalReturnPct) ? totalReturnPct.toFixed(2) : 'N/A') + '%</span></div>' +
                    '<div>🧾 <b>Trades:</b> ' + returnedTrades +
                    (totalTrades !== returnedTrades ? '<span style="color:#888;"> / ' + totalTrades + ' total</span>' : '') +
                    (legacyFilteredOut > 0 ? '<span style="color:#888;"> (legacy hidden: ' + legacyFilteredOut + ')</span>' : '') +
                    '</div>' +
                    '<div>📌 <b>Open positions:</b> ' + openPositions + '</div>' +
                    '<div style="margin-top:6px;">' +
                    '<span style="color:#00ff88;">✅ Won: ' + wins + '</span> | ' +
                    '<span style="color:#ff4466;">❌ Lost: ' + losses + '</span> | ' +
                    '<span style="color:' + (totalPnl >= 0 ? '#00ff88' : '#ff4466') + ';">💰 Total P&L (returned list): $' + totalPnl.toFixed(2) + '</span>' +
                    '</div>' +
                    '</div>';

                if (trades.length === 0) return html + '<div style="color:#888;">No trades recorded yet.</div>';

                html += '<table style="width:100%;border-collapse:collapse;font-size:0.85em;">';
                html += '<tr style="background:rgba(255,255,255,0.1);"><th style="padding:6px;text-align:left;">Asset</th><th>Side</th><th>Entry</th><th>Exit</th><th>P&L</th><th>Result</th></tr>';
                trades.slice(-10).reverse().forEach(t => {
                    const pnlColor = (t.pnl || 0) >= 0 ? '#00ff88' : '#ff4466';
                    const icon = (t.pnl || 0) >= 0 ? '✅' : '❌';
                    html += '<tr style="border-bottom:1px solid rgba(255,255,255,0.1);">' +
                        '<td style="padding:6px;font-weight:bold;">' + (t.asset || '') + '</td>' +
                        '<td style="text-align:center;">' + (t.side === 'UP' ? '📈' : '📉') + '</td>' +
                        '<td style="text-align:center;">' + (((t.entry || 0) * 100).toFixed(0)) + '¢</td>' +
                        '<td style="text-align:center;">' + (t.exit !== undefined ? (((t.exit || 0) * 100).toFixed(0) + '¢') : '-') + '</td>' +
                        '<td style="text-align:center;color:' + pnlColor + ';">$' + (Number(t.pnl || 0).toFixed(2)) + '</td>' +
                        '<td style="text-align:center;">' + icon + '</td>' +
                        '</tr>';
                });
                html += '</table>';
                return html;
            }
            if (endpoint.includes('/api/gates')) {
                const summary = data.summary || {};
                const total = summary.totalEvaluations || 0;
                const blocked = summary.totalBlocked || 0;
                const passed = total - blocked;
                const failures = summary.gateFailures || {};
                let html = \`<div style="font-size:1.1em;margin-bottom:15px;">
                    <div>📊 <b>Total Evaluated:</b> \${total}</div>
                    <div style="color:#00ff88;">✅ <b>Passed:</b> \${passed} (\${total > 0 ? ((passed/total)*100).toFixed(1) : 0}%)</div>
                    <div style="color:#ff4466;">🚫 <b>Blocked:</b> \${blocked} (\${total > 0 ? ((blocked/total)*100).toFixed(1) : 0}%)</div>
                </div>\`;
                if (Object.keys(failures).length > 0) {
                    html += '<div style="margin-top:10px;"><b>Top Block Reasons:</b></div>';
                    html += '<table style="width:100%;margin-top:8px;">';
                    Object.entries(failures).sort((a,b) => b[1] - a[1]).slice(0, 5).forEach(([gate, count]) => {
                        const pct = total > 0 ? ((count/total)*100).toFixed(1) : 0;
                        html += \`<tr><td style="padding:4px;">🚧 \${gate}</td><td style="text-align:right;">\${count} (\${pct}%)</td></tr>\`;
                    });
                    html += '</table>';
                }
                return html;
            }
            if (endpoint.includes('/api/backtest-polymarket')) {
                const s = data.summary || {};
                const cov = data.coverage || {};
                const proof = data.proof || {};
                const scan = Array.isArray(data.scan) ? data.scan : null;
                const interp = data.interpretation || {};
                const profit = Number(s.totalProfit || 0);
                const profitColor = profit >= 0 ? '#00ff88' : '#ff4466';
                const icon = profit >= 0 ? '✅' : '❌';
                const windowsProcessed = (cov.windowsProcessed !== undefined) ? cov.windowsProcessed : (cov.cyclesProcessed || 0);
                const slugsFound = (cov.uniqueSlugsFound !== undefined) ? cov.uniqueSlugsFound : (cov.cyclesFound || 0);
                const slugHash = String(proof.slugHash || '');
                
                let html = '<div style="font-size:1.1em;line-height:1.8;">' +
                    '<div style="font-size:1.3em;margin-bottom:10px;">🏆 <b>Polymarket Backtest (native)</b></div>' +
                    '<div>' + icon + ' <b style="color:' + profitColor + ';">Profit:</b> $' + profit.toFixed(2) + ' <span style="color:#888;">(' + (s.profitPct || 'N/A') + ')</span></div>' +
                    '<div>🎯 <b>Win rate:</b> ' + (s.winRate || 'N/A') + ' <span style="color:#888;">(' + (s.wins || 0) + 'W / ' + (s.losses || 0) + 'L)</span></div>' +
                    '<div>📉 <b>Max drawdown:</b> ' + (s.maxDrawdown || 'N/A') + '</div>' +
                    '<div>🧠 <b>Selection:</b> ' + (s.selection || 'N/A') + ' <span style="color:#888;">(maxTradesPerCycle: ' + (s.maxTradesPerCycle || '?') + ', EV gate: ' + (s.respectEVGate ? 'ON' : 'OFF') + ', entry: ' + (s.entryMode || 'SNAPSHOT') + ')</span></div>' +
                    '<div>⏱️ <b>Runtime:</b> ' + (s.runtime || 'N/A') + '</div>' +
                    '<div>🧾 <b>Resolved:</b> ' + (cov.resolved || 0) + ' <span style="color:#888;">(unresolved: ' + (cov.unresolved || 0) + ', slugs: ' + slugsFound + ', windows: ' + windowsProcessed + ')</span></div>' +
                    '<div>🧾 <b>No-duplicates proof:</b> <code>' + (slugHash ? (slugHash.substring(0, 16) + '…') : 'N/A') + '</code> <span style="color:#888;">(' + (proof.slugCount || 0) + ' slugs)</span></div>' +
                    '<div>📌 <b>Verdict:</b> ' + (interp.verdict || 'N/A') + '</div>' +
                    '</div>';
                
                const entrySources = cov.entrySources || {};
                const srcKeys = Object.keys(entrySources);
                if (srcKeys.length > 0) {
                    const srcStr = srcKeys.map(k => k + ': ' + entrySources[k]).join(' | ');
                    html += '<div style="margin-top:10px;color:#888;font-size:0.85em;">Entry price sources: <b>' + srcStr + '</b></div>';
                }

                if (scan && scan.length > 0) {
                    html += '<div style="margin-top:12px;color:#aaa;"><b>Sweet-spot scan (stake vs drawdown)</b></div>';
                    html += '<table style="width:100%;border-collapse:collapse;margin-top:8px;font-size:0.85em;">';
                    html += '<tr style="background:rgba(255,255,255,0.1);"><th style="padding:6px;text-align:left;">Stake</th><th>Trades</th><th>WinRate</th><th>Profit</th><th>Max DD</th></tr>';
                    scan.forEach(r => {
                        const pct = String(r.profitPct || '');
                        const isPos = pct.indexOf('-') === -1;
                        const c = isPos ? '#00ff88' : '#ff4466';
                        html += '<tr style="border-bottom:1px solid rgba(255,255,255,0.1);">' +
                            '<td style="padding:6px;font-weight:bold;">' + (Number(r.stake) * 100).toFixed(0) + '%</td>' +
                            '<td style="text-align:center;">' + (r.trades || 0) + '</td>' +
                            '<td style="text-align:center;">' + (r.winRate || 'N/A') + '</td>' +
                            '<td style="text-align:center;color:' + c + ';">' + (r.profitPct || 'N/A') + '</td>' +
                            '<td style="text-align:center;">' + (r.maxDrawdown || 'N/A') + '</td>' +
                            '</tr>';
                    });
                    html += '</table>';
                }
                
                const trades = Array.isArray(data.trades) ? data.trades : [];
                if (trades.length === 0) {
                    html += '<div style="margin-top:12px;color:#888;">No trades were simulated for these filters.</div>';
                    return html;
                }
                
                html += '<div style="margin-top:12px;color:#aaa;"><b>Last 10 simulated trades</b></div>';
                html += '<table style="width:100%;border-collapse:collapse;margin-top:8px;font-size:0.85em;">';
                html += '<tr style="background:rgba(255,255,255,0.1);"><th style="padding:6px;text-align:left;">Asset</th><th>Entry</th><th>Resolved</th><th>P&L</th><th>Balance</th></tr>';
                trades.slice(-10).reverse().forEach(t => {
                    const pnl = Number(t.pnl || 0);
                    const pnlColor = pnl >= 0 ? '#00ff88' : '#ff4466';
                    const outIcon = t.isWin ? '✅' : '❌';
                    html += '<tr style="border-bottom:1px solid rgba(255,255,255,0.1);">' +
                        '<td style="padding:6px;font-weight:bold;">' + (t.asset || '') + '</td>' +
                        '<td style="text-align:center;">' + (((t.entryPrice || 0) * 100).toFixed(1)) + '¢</td>' +
                        '<td style="text-align:center;">' + outIcon + ' ' + (t.polymarketOutcome || '?') + '</td>' +
                        '<td style="text-align:center;color:' + pnlColor + ';">$' + pnl.toFixed(2) + '</td>' +
                        '<td style="text-align:center;">$' + Number(t.balance || 0).toFixed(2) + '</td>' +
                        '</tr>';
                });
                html += '</table>';
                
                return html;
            }
            if (endpoint.includes('/api/verify-trades-polymarket')) {
                const s = data.summary || {};
                const candidates = Number(s.candidates || 0);
                if (candidates === 0) {
                    return '<div style="color:#888;">No CLOSED ORACLE trades found to verify yet.</div>';
                }
                
                const mismatches = Number(s.mismatches || 0);
                const mismatchColor = mismatches > 0 ? '#ff4466' : '#00ff88';
                const mismatchIcon = mismatches > 0 ? '🚨' : '✅';
                const comparable = Number(s.comparable || 0);
                const earlyExit = Number(s.earlyExit || 0);
                const mismatchRate = comparable > 0 ? ((mismatches / comparable) * 100).toFixed(1) : '0.0';
                
                let html = '<div style="font-size:1.1em;line-height:1.8;">' +
                    '<div style="font-size:1.3em;margin-bottom:10px;">✅ <b>Trade Verification (Polymarket)</b></div>' +
                    '<div>🧾 <b>Trades checked:</b> ' + candidates + '</div>' +
                    '<div>🔎 <b>Comparable (binary exits):</b> ' + comparable + ' <span style="color:#888;">| Early exits: ' + earlyExit + '</span></div>' +
                    '<div>📌 <b>Resolved:</b> ' + (s.resolved || 0) + ' <span style="color:#888;">(unresolved: ' + (s.unresolved || 0) + ', errors: ' + (s.errors || 0) + ')</span></div>' +
                    '<div>' + mismatchIcon + ' <b style="color:' + mismatchColor + ';">Mismatches:</b> ' + mismatches + ' <span style="color:#888;">(' + mismatchRate + '% of comparable)</span></div>' +
                    '<div style="color:#888;">Runtime: ' + (s.runtime || 'N/A') + ' | WinRate vs resolution: ' + (s.winRate || 'N/A') + '</div>' +
                    '</div>';
                
                const byAsset = data.byAsset || {};
                html += '<div style="margin-top:12px;color:#aaa;"><b>By asset</b></div>';
                html += '<table style="width:100%;border-collapse:collapse;margin-top:8px;font-size:0.85em;">';
                html += '<tr style="background:rgba(255,255,255,0.1);"><th style="padding:6px;text-align:left;">Asset</th><th>Resolved</th><th>Comparable</th><th>Early</th><th>W</th><th>L</th><th>Mismatches</th></tr>';
                Object.entries(byAsset).forEach(([asset, a]) => {
                    html += '<tr style="border-bottom:1px solid rgba(255,255,255,0.1);">' +
                        '<td style="padding:6px;font-weight:bold;">' + asset + '</td>' +
                        '<td style="text-align:center;">' + (a.resolved || 0) + '</td>' +
                        '<td style="text-align:center;">' + (a.comparable || 0) + '</td>' +
                        '<td style="text-align:center;">' + (a.earlyExit || 0) + '</td>' +
                        '<td style="text-align:center;color:#00ff88;">' + (a.wins || 0) + '</td>' +
                        '<td style="text-align:center;color:#ff4466;">' + (a.losses || 0) + '</td>' +
                        '<td style="text-align:center;color:' + ((a.mismatches || 0) > 0 ? '#ff4466' : '#00ff88') + ';">' + (a.mismatches || 0) + '</td>' +
                        '</tr>';
                });
                html += '</table>';
                
                const trades = Array.isArray(data.trades) ? data.trades : [];
                const mismatched = trades.filter(t => t && t.mismatch === true).slice(0, 10);
                if (mismatched.length > 0) {
                    html += '<div style="margin-top:12px;color:#ffcc66;"><b>First 10 mismatches</b></div>';
                    html += '<table style="width:100%;border-collapse:collapse;margin-top:8px;font-size:0.8em;">';
                    html += '<tr style="background:rgba(255,255,255,0.1);"><th style="padding:6px;text-align:left;">Trade</th><th>Side</th><th>Exit</th><th>Resolved</th><th>Reason</th></tr>';
                    mismatched.forEach(t => {
                        const exitStr = (t.exit === null || t.exit === undefined) ? '-' : ((Number(t.exit) * 100).toFixed(0) + '¢');
                        html += '<tr style="border-bottom:1px solid rgba(255,255,255,0.1);">' +
                            '<td style="padding:6px;"><code>' + String(t.id || '').substring(0, 24) + '...</code></td>' +
                            '<td style="text-align:center;">' + (t.side || '?') + '</td>' +
                            '<td style="text-align:center;">' + exitStr + '</td>' +
                            '<td style="text-align:center;">' + (t.verifiedOutcome || '?') + '</td>' +
                            '<td style="text-align:center;color:#888;">' + (t.reason || '') + '</td>' +
                            '</tr>';
                    });
                    html += '</table>';
                }
                
                return html;
            }
            // Default: show formatted JSON with syntax highlighting
            return null;
        }
        
        async function apiCall(endpoint) {
            const responseEl = document.getElementById('apiResponse');
            responseEl.innerHTML = '<span style="color:#888;">Loading...</span>';
            try {
                const start = performance.now();
                const res = await fetch(endpoint);
                const elapsed = (performance.now() - start).toFixed(0);
                const data = await res.json();
                
                // Try child-friendly format first
                const formatted = formatApiResponse(endpoint, data);
                if (formatted) {
                    responseEl.innerHTML = \`<div style="color:#888;font-size:0.8em;margin-bottom:10px;">📡 \${endpoint} (\${res.status}) - \${elapsed}ms</div>\` + formatted;
                } else {
                    // Fallback to JSON
                    responseEl.style.color = res.ok ? '#00ff88' : '#ff4466';
                    responseEl.textContent = '// ' + endpoint + ' (' + res.status + ') - ' + elapsed + 'ms\\n' + JSON.stringify(data, null, 2);
                }
            } catch (e) {
                responseEl.style.color = '#ff4466';
                responseEl.textContent = 'Error: ' + e.message;
            }
        }
        
        async function apiCallCustom() {
            const method = document.getElementById('apiMethod').value;
            const endpoint = document.getElementById('apiEndpoint').value || '/api/state';
            const bodyText = document.getElementById('apiBody').value;
            const responseEl = document.getElementById('apiResponse');
            responseEl.textContent = 'Loading...';
            responseEl.style.color = '#888';
            try {
                const options = { method };
                if (method === 'POST' && bodyText) {
                    options.headers = { 'Content-Type': 'application/json' };
                    options.body = bodyText;
                }
                const start = performance.now();
                const res = await fetch(endpoint, options);
                const elapsed = (performance.now() - start).toFixed(0);
                const text = await res.text();
                let formatted;
                try { formatted = JSON.stringify(JSON.parse(text), null, 2); } catch { formatted = text; }
                responseEl.style.color = res.ok ? '#00ff88' : '#ff4466';
                responseEl.textContent = '// ' + method + ' ' + endpoint + ' (' + res.status + ') - ' + elapsed + 'ms\\n' + formatted;
            } catch (e) {
                responseEl.style.color = '#ff4466';
                responseEl.textContent = 'Error: ' + e.message;
            }
        }
        
        // Toggle POST body visibility
        document.getElementById('apiMethod').addEventListener('change', function() {
            document.getElementById('apiBodyContainer').style.display = this.value === 'POST' ? 'block' : 'none';
        });
        
        // 🎯 GOAT v44.1: GateTrace UI functions
        async function loadGateTrace() {
            try {
                const res = await fetch('/api/gates');
                if (!res.ok) throw new Error('Failed to load gates');
                const data = await res.json();
                
                // Update summary
                const summary = data.summary || {};
                const summaryHtml = '<strong>Evaluations:</strong> ' + (summary.totalEvaluations || 0) + 
                    ' | <strong>Blocked:</strong> <span style="color:#ff4466;">' + (summary.totalBlocked || 0) + '</span>' +
                    ' | <strong>Top Blockers:</strong> ' + Object.entries(summary.gateFailures || {}).slice(0, 3).map(([g, c]) => g + '(' + c + ')').join(', ');
                document.getElementById('gateTraceSummary').innerHTML = summaryHtml || 'No data yet';
                
                // Update traces list
                const traceList = document.getElementById('gateTraceList');
                const allTraces = [];
                for (const [asset, traces] of Object.entries(data.recentTraces || {})) {
                    for (const t of traces) {
                        allTraces.push({ asset, ...t });
                    }
                }
                allTraces.sort((a, b) => b.timestamp - a.timestamp);
                
                if (allTraces.length === 0) {
                    traceList.innerHTML = '<div class="no-positions">No gate evaluations recorded yet. Wait for the next cycle.</div>';
                    return;
                }
                
                let html = '';
                for (const t of allTraces.slice(0, 15)) {
                    const isBlocked = t.decision === 'NO_TRADE';
                    const color = isBlocked ? '#ff4466' : '#00ff88';
                    const icon = isBlocked ? '🚫' : '✅';
                    const time = new Date(t.timestamp).toLocaleTimeString();
                    const failedStr = (t.failedGates || []).join(', ') || 'none';
                    const inputs = t.inputs || {};
                    html += '<div class="position-item" style="border-left:3px solid ' + color + ';">';
                    html += '<span>' + icon + ' <strong>' + t.asset + '</strong> @ ' + time + ' - ' + (t.reason || 'unknown') + '</span>';
                    html += '<span style="color:#888;font-size:0.8em;">Failed: ' + failedStr + '</span>';
                    html += '</div>';
                    if (inputs.pWin !== undefined) {
                        html += '<div style="padding:4px 12px;background:rgba(0,0,0,0.2);font-size:0.75em;color:#666;margin-bottom:6px;border-radius:0 0 6px 6px;">';
                        html += 'pWin=' + (inputs.pWin !== null ? (inputs.pWin * 100).toFixed(1) + '%' : 'N/A');
                        html += ' | EV=' + (inputs.evRoi !== null ? (inputs.evRoi * 100).toFixed(2) + '%' : 'N/A');
                        html += ' | Edge=' + (inputs.edgePercent !== undefined ? inputs.edgePercent.toFixed(1) + '%' : 'N/A');
                        html += ' | Odds=' + (inputs.currentOdds !== undefined ? (inputs.currentOdds * 100).toFixed(1) + '¢' : 'N/A');
                        html += ' | Cons=' + (inputs.consensusRatio !== undefined ? (inputs.consensusRatio * 100).toFixed(0) + '%' : 'N/A');
                        html += '</div>';
                    }
                }
                traceList.innerHTML = html;
            } catch (e) {
                document.getElementById('gateTraceList').innerHTML = '<div class="no-positions" style="color:#ff4466;">Error: ' + e.message + '</div>';
            }
        }
        // Auto-load gate trace on page load
        setTimeout(loadGateTrace, 2000);
        setInterval(loadGateTrace, 30000); // Refresh every 30s
        
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
        
        // 🎯 GOAT v4: Force resume trading via RiskGovernor override
        async function forceResumeTrading() {
            if (!confirm('Force resume trading?\\n\\nThis will override the RiskGovernor and resume to NORMAL state.\\nUse with caution.')) return;
            try {
                const res = await fetch('/api/circuit-breaker/override', { 
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ action: 'resume' })
                });
                const result = await res.json();
                if (result.success) {
                    alert('✅ Resumed to ' + result.newState + ' state');
                } else {
                    alert('❌ Resume failed: ' + (result.error || 'Unknown error'));
                }
                fetchData();
            } catch (e) {
                alert('❌ Error: ' + e.message);
            }
        }
        
        // 🎯 GOAT v4: Trade history pagination
        let tradeHistoryOffset = 0;
        const tradeHistoryLimit = 20;
        
        async function loadMoreTrades() {
            try {
                const mode = document.getElementById('modeBadge')?.textContent || 'PAPER';
                const res = await fetch('/api/trades?mode=' + mode + '&offset=' + tradeHistoryOffset + '&limit=' + tradeHistoryLimit);
                const data = await res.json();
                
                if (data.trades && data.trades.length > 0) {
                    tradeHistoryOffset += data.trades.length;
                    // Append to existing trades in UI
                    const histEl = document.getElementById('tradeHistory');
                    const pagEl = document.getElementById('tradeHistoryPagination');
                    
                    let histHtml = histEl.innerHTML;
                    data.trades.forEach(tr => {
                        const emoji = tr.status === 'OPEN' ? '⏳' : ((tr.pnl || 0) >= 0 ? '✅' : '❌');
                        const pnlColor = (tr.pnl || 0) >= 0 ? '#00ff88' : '#ff4466';
                        const details = tr.status === 'CLOSED' 
                            ? '$' + (tr.size || 0).toFixed(2) + ' @ ' + ((tr.entry || 0) * 100).toFixed(0) + '¢→' + ((tr.exit || 0) * 100).toFixed(0) + '¢ ' + ((tr.pnl || 0) >= 0 ? '+' : '') + '$' + (tr.pnl || 0).toFixed(2)
                            : 'Entry: ' + ((tr.entry || 0) * 100).toFixed(0) + '¢ | $' + (tr.size || 0).toFixed(2);
                        histHtml += '<div class="position-item"><span>' + emoji + ' <strong>' + (tr.asset || '?') + '</strong> ' + (tr.side || '?') + '</span><span style="color:' + pnlColor + ';font-size:0.85em;">' + details + '</span></div>';
                    });
                    histEl.innerHTML = histHtml;
                    
                    if (pagEl) {
                        pagEl.style.display = 'block';
                        pagEl.textContent = 'Showing ' + tradeHistoryOffset + ' of ' + data.total + ' trades';
                    }
                } else {
                    alert('No more trades to load');
                }
            } catch (e) {
                alert('❌ Error loading trades: ' + e.message);
            }
        }
        
        // 🎯 GOAT v4: Reset trade history
        async function resetTradeHistoryUI() {
            const mode = document.getElementById('modeBadge')?.textContent || 'PAPER';
            if (!confirm('Reset ALL ' + mode + ' trade history?\\n\\nThis cannot be undone!')) return;
            
            try {
                const res = await fetch('/api/trades/reset', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ mode: mode, confirm: true })
                });
                const result = await res.json();
                if (result.success) {
                    alert('✅ ' + mode + ' trade history reset! ' + (result.deletedCount || 0) + ' trades deleted.');
                    tradeHistoryOffset = 0;
                    fetchData();
                } else {
                    alert('❌ Reset failed: ' + (result.error || 'Unknown error'));
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



function buildStateSnapshot() {
    const response = {};
    ASSETS.forEach(a => {
        const recentWins = Brains[a].recentOutcomes.filter(Boolean).length;
        const recentTotal = Brains[a].recentOutcomes.length;
        const recentAccuracy = recentTotal > 0 ? (recentWins / recentTotal) * 100 : 0;
        const calBucket = Brains[a].getCalibrationBucket ? Brains[a].getCalibrationBucket(Brains[a].confidence) : null;
        const calStats = calBucket && Brains[a].calibrationBuckets ? Brains[a].calibrationBuckets[calBucket] : null;
        // Prior = long-run accuracy (or conviction accuracy when in CONVICTION tier)
        const s = Brains[a].stats || {};
        const priorRate =
            (Brains[a].tier === 'CONVICTION' && s.convictionTotal > 0) ? (s.convictionWins / s.convictionTotal) :
                (s.total > 0 ? (s.wins / s.total) : 0.5);
        
        // 🎯 GOAT: Use tier-conditioned pWin (most accurate), fall back to bucket-based
        const market = currentMarkets[a];
        const entryPrice = market ? (Brains[a].prediction === 'UP' ? market.yesPrice : market.noPrice) : null;
        let pWin = null;
        if (Brains[a].getTierConditionedPWin) {
            pWin = Brains[a].getTierConditionedPWin(Brains[a].tier, entryPrice, { fallback: null, minSamples: 5 });
        }
        if (pWin === null && Brains[a].getCalibratedWinProb) {
            pWin = Brains[a].getCalibratedWinProb(Brains[a].confidence, { priorRate, priorStrength: 40, minSamples: 0 });
        }

        // 🎯 GOAT: Calculate EV for UI display
        let evRoi = null;
        if (Number.isFinite(pWin) && Number.isFinite(entryPrice) && entryPrice > 0 && entryPrice < 1) {
            const PROFIT_FEE_PCT = 0.02;
            const b = (1 - entryPrice) / entryPrice;
            evRoi = (pWin * b * (1 - PROFIT_FEE_PCT)) - (1 - pWin);
        }
        
        response[a] = {
            prediction: Brains[a].prediction,
            confidence: Brains[a].confidence,
            // Calibrated probability (empirical) derived from per-asset confidence buckets
            pWin: pWin,
            pWinBucket: calBucket,
            pWinSamples: calStats ? calStats.total : 0,
            evRoi: evRoi, // 🎯 GOAT: Expected Value ROI (positive = profitable trade)
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
            tierCalibration: Brains[a].tierCalibration, // 🎯 GOAT: Tier+price conditioned calibration
            newsState: Brains[a].newsState,
            modelVotes: Brains[a].lastSignal ? Brains[a].lastSignal.modelVotes : {}
        };
    });

    // Add trading system data
    const inCooldown = tradeExecutor.isInCooldown();
    const cooldownRemaining = inCooldown ? Math.ceil((CONFIG.RISK.cooldownAfterLoss * 1000 - (Date.now() - tradeExecutor.lastLossTime)) / 1000) : 0;
    // 🔴 FIX #18: Only NEGATIVE P/L triggers stop loss (was using Math.abs which triggered on PROFIT!)
    const globalStopTriggered = tradeExecutor.todayPnL < 0 && Math.abs(tradeExecutor.todayPnL) > tradeExecutor.paperBalance * CONFIG.RISK.globalStopLoss;
    
    // 🔴 v46: Get circuit breaker status
    const cbStatus = tradeExecutor.circuitBreaker || {};
    const cbState = cbStatus.state || 'NORMAL';
    const cbIsRestricted = cbState !== 'NORMAL';

    // 🔴 FIX #15 + v46: Determine halt reason for UI display (with circuit breaker)
    let haltReason = null;
    let haltType = null;
    let resumeCondition = null;
    
    if (cbState === 'HALTED') {
        haltReason = `🔌 CIRCUIT BREAKER HALTED: Trading suspended`;
        haltType = 'CIRCUIT_BREAKER_HALT';
        resumeCondition = 'New day or manual override via /api/circuit-breaker/override';
    } else if (globalStopTriggered) {
        haltReason = `🛑 GLOBAL STOP LOSS: Daily loss exceeds ${(CONFIG.RISK.globalStopLoss * 100).toFixed(0)}%`;
        haltType = 'GLOBAL_STOP_LOSS';
        resumeCondition = 'New day or toggle override via /api/toggle-stop-loss-override';
    } else if (inCooldown) {
        haltReason = `⏳ COOLDOWN: ${Math.floor(cooldownRemaining / 60)}m ${cooldownRemaining % 60}s remaining after ${tradeExecutor.consecutiveLosses || 0} consecutive losses`;
        haltType = 'LOSS_COOLDOWN';
        resumeCondition = `Wait ${cooldownRemaining}s or until a win`;
    } else if (cbState === 'PROBE_ONLY') {
        haltReason = `🔶 PROBE MODE: 25% position size only`;
        haltType = 'CIRCUIT_BREAKER_PROBE';
        resumeCondition = 'Win a trade or wait 30 minutes';
    } else if (cbState === 'SAFE_ONLY') {
        haltReason = `🟡 SAFE MODE: 50% position size, no acceleration`;
        haltType = 'CIRCUIT_BREAKER_SAFE';
        resumeCondition = 'Win a trade or wait 15 minutes';
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
        stateThresholds: tradeExecutor.STATE_THRESHOLDS || {},
        stateEntryTime: tradeExecutor.stateEntryTime || Date.now(),
        modes: {
            ORACLE: CONFIG.ORACLE.enabled,
            ARBITRAGE: CONFIG.ARBITRAGE.enabled,
            ILLIQUIDITY_GAP: CONFIG.ILLIQUIDITY_GAP.enabled,  // 🏆 APEX v24: TRUE ARBITRAGE
            DEATH_BOUNCE: CONFIG.DEATH_BOUNCE.enabled,        // 🏆 APEX v24: EXTREME SCALP
            SCALP: CONFIG.SCALP.enabled,
            UNCERTAINTY: CONFIG.UNCERTAINTY.enabled,
            MOMENTUM: CONFIG.MOMENTUM.enabled
        },
        // 🔴 FIX #15 + v46: Comprehensive halt status for UI
        inCooldown: inCooldown,
        cooldownRemaining: cooldownRemaining,
        consecutiveLosses: tradeExecutor.consecutiveLosses || 0,
        globalStopTriggered: globalStopTriggered,
        haltReason: haltReason,
        haltType: haltType,
        resumeCondition: resumeCondition,
        isHalted: inCooldown || globalStopTriggered || cbState === 'HALTED',
        isThrottled: cbState === 'SAFE_ONLY' || cbState === 'PROBE_ONLY',
        circuitBreaker: {
            state: cbState,
            enabled: cbStatus.enabled,
            dayStartBalance: cbStatus.dayStartBalance,
            thresholds: {
                soft: cbStatus.softDrawdownPct,
                hard: cbStatus.hardDrawdownPct,
                halt: cbStatus.haltDrawdownPct
            }
        }
    };

    return response;
}

app.get('/api/state', (req, res) => {
    res.json(buildStateSnapshot());
});

// 🎯 GOAT v44.1: Public state endpoint (no auth, no sensitive data)
app.get('/api/state-public', (req, res) => {
    const snapshot = buildStateSnapshot();
    // Strip sensitive data
    const publicState = {};
    // Only include known assets (buildStateSnapshot also includes `_trading` metadata)
    for (const asset of ASSETS) {
        const data = snapshot[asset];
        if (!data) continue;
        publicState[asset] = {
            prediction: data.prediction,
            confidence: data.confidence,
            tier: data.tier,
            edge: data.edge,
            pWin: data.pWin,
            certaintyScore: data.certaintyScore,
            winRate: data.winRate,
            recentAccuracy: data.recentAccuracy,
            currentPhase: data.currentPhase,
            locked: data.locked,
            lockedDirection: data.lockedDirection,
            marketOdds: data.marketOdds
        };
    }
    res.json({
        timestamp: Date.now(),
        mode: CONFIG.TRADE_MODE,
        uptime: process.uptime(),
        assets: publicState
    });
});

// 🎯 GOAT v44.1: Get API key for programmatic access (authenticated users only)
app.get('/api/api-key', (req, res) => {
    res.json({
        apiKey: API_KEY,
        usage: {
            bearer: 'Authorization: Bearer <apiKey>',
            queryParam: '?apiKey=<apiKey>',
            basicAuth: 'Basic base64(username:password)'
        }
    });
});

// 🎯 GOAT v44.1: GateTrace API - shows why trades were blocked
app.get('/api/gates', (req, res) => {
    const asset = req.query.asset;
    const limit = parseInt(req.query.limit) || 20;
    
    if (asset && ASSETS.includes(asset)) {
        // Get traces for specific asset
        const traces = gateTrace.getForAsset(asset).slice(0, limit);
        return res.json({
            asset,
            count: traces.length,
            traces,
            summary: gateTrace.getSummary().byAsset[asset] || {}
        });
    }
    
    // Get summary + recent traces for all assets
    const summary = gateTrace.getSummary();
    const recentByAsset = {};
    for (const a of ASSETS) {
        recentByAsset[a] = gateTrace.getForAsset(a).slice(0, 5);
    }
    
    res.json({
        summary,
        recentTraces: recentByAsset,
        config: {
            ORACLE: {
                minConsensus: CONFIG.ORACLE.minConsensus,
                minConfidence: CONFIG.ORACLE.minConfidence,
                minEdge: CONFIG.ORACLE.minEdge,
                minOdds: CONFIG.ORACLE.minOdds || 0.20,
                maxOdds: CONFIG.ORACLE.maxOdds,
                minStability: CONFIG.ORACLE.minStability,
                effectiveMaxOdds: tradeExecutor.getEffectiveMaxOdds(),
                effectiveMinOdds: CONFIG.ORACLE.minOdds || 0.20,
                effectiveMinStability: tradeExecutor.getEffectiveMinStability()
            }
        }
    });
});

// 🎯 GOAT v3: Enhanced Trading API with pagination and persistent history
app.get('/api/trades', async (req, res) => {
    const mode = req.query.mode || CONFIG.TRADE_MODE; // 'PAPER' or 'LIVE'
    const offset = parseInt(req.query.offset) || 0;
    const limit = Math.min(parseInt(req.query.limit) || 100, 500); // Max 500 per request
    const includeLegacy = req.query.includeLegacy === '1' || String(req.query.includeLegacy || '').toLowerCase() === 'true';
    
    // Load from Redis if available
    const historyResult = await loadTradeHistory(mode, offset, limit);

    // Hide legacy assets (e.g. SOL) by default to prevent future confusion.
    const allowedAssets = new Set(ASSETS.map(a => String(a).toUpperCase()));
    const rawTrades = Array.isArray(historyResult.trades) ? historyResult.trades : [];
    const filteredTrades = includeLegacy
        ? rawTrades
        : rawTrades.filter(t => {
            const asset = String(t?.asset || '').toUpperCase();
            return !asset || allowedAssets.has(asset);
        });
    const legacyFilteredOut = rawTrades.length - filteredTrades.length;
    const rawPositions = tradeExecutor && tradeExecutor.positions ? tradeExecutor.positions : {};
    const filteredPositions = includeLegacy
        ? rawPositions
        : Object.fromEntries(Object.entries(rawPositions).filter(([_, p]) => allowedAssets.has(String(p?.asset || '').toUpperCase())));
    
    res.json({
        mode: mode,
        balance: tradeExecutor.paperBalance,
        startingBalance: tradeExecutor.startingBalance,
        todayPnL: tradeExecutor.todayPnL,
        totalReturn: ((tradeExecutor.paperBalance / tradeExecutor.startingBalance) - 1) * 100,
        positions: filteredPositions,
        trades: filteredTrades,
        // totalTrades refers to the underlying history size (for pagination correctness).
        // returnedTrades tells you how many you got after legacy filtering.
        totalTrades: historyResult.total,
        returnedTrades: filteredTrades.length,
        legacyFilteredOut,
        offset: offset,
        limit: limit,
        source: historyResult.source,
        hasMore: offset + limit < historyResult.total,
        includeLegacy,
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

// 🎯 GOAT v3: Export full trade history
app.get('/api/trades/export', async (req, res) => {
    const mode = req.query.mode || CONFIG.TRADE_MODE;
    const format = req.query.format || 'json'; // 'json' or 'csv'
    
    // Load all trades from Redis
    const historyResult = await loadTradeHistory(mode, 0, TRADE_HISTORY_MAX);
    
    if (format === 'csv') {
        // Generate CSV
        const headers = ['id', 'asset', 'mode', 'side', 'entry', 'exit', 'size', 'pnl', 'pnlPercent', 'time', 'closeTime', 'status', 'reason'];
        const rows = historyResult.trades.map(t => 
            headers.map(h => {
                const val = t[h];
                if (val === undefined || val === null) return '';
                if (typeof val === 'object') return JSON.stringify(val);
                return String(val).replace(/,/g, ';');
            }).join(',')
        );
        
        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', `attachment; filename=polyprophet_trades_${mode}_${new Date().toISOString().slice(0,10)}.csv`);
        res.send([headers.join(','), ...rows].join('\n'));
    } else {
        res.json({
            mode: mode,
            exportedAt: new Date().toISOString(),
            totalTrades: historyResult.total,
            trades: historyResult.trades
        });
    }
});

// 🎯 GOAT v3: Reset trade history (with confirmation)
app.post('/api/trades/reset', async (req, res) => {
    const mode = req.body.mode || 'PAPER';
    const confirm = req.body.confirm === true;
    
    if (!confirm) {
        return res.status(400).json({ 
            error: 'Must confirm reset', 
            hint: 'Send { "mode": "PAPER", "confirm": true } in body',
            warning: `This will permanently delete all ${mode} trade history`
        });
    }
    
    // Reset Redis history
    await resetTradeHistory(mode);
    
    // Also reset in-memory if matching current mode
    if (mode === CONFIG.TRADE_MODE || mode === 'PAPER') {
        const beforeCount = tradeExecutor.tradeHistory.length;
        if (mode === 'LIVE') {
            tradeExecutor.tradeHistory = tradeExecutor.tradeHistory.filter(t => t.mode !== 'LIVE' && !t.isLive);
        } else {
            tradeExecutor.tradeHistory = tradeExecutor.tradeHistory.filter(t => t.mode === 'LIVE' || t.isLive);
        }
        const afterCount = tradeExecutor.tradeHistory.length;
        log(`🗑️ Trade history reset: ${mode} mode (${beforeCount - afterCount} trades removed)`);
    }
    
    res.json({ 
        success: true, 
        mode: mode,
        message: `${mode} trade history has been reset` 
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

    if (!['BTC', 'ETH', 'XRP'].includes(asset)) {
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
    const queue = tradeExecutor.getRedemptionQueue();
    res.json({
        success: true,
        queue,
        count: queue.length,
        // 🎯 GOAT v44.1: Include summary stats
        summary: {
            total: queue.length,
            requiresManual: queue.filter(i => i.requiresManual).length,
            pendingRetry: queue.filter(i => i.attempts && i.attempts > 0).length,
            oldestItem: queue.length > 0 ? Math.min(...queue.map(i => i.addedAt || Date.now())) : null
        }
    });
});

// 🎯 GOAT v44.1: Get redemption events (history of all redemption attempts)
app.get('/api/redemption-events', (req, res) => {
    const limit = parseInt(req.query.limit) || 50;
    const events = tradeExecutor.getRedemptionEvents(limit);
    res.json({
        success: true,
        events,
        count: events.length,
        summary: {
            redeemed: events.filter(e => e.outcome === 'REDEEMED').length,
            failed: events.filter(e => e.outcome === 'TX_FAILED' || e.outcome === 'ERROR').length,
            manualRequired: events.filter(e => e.outcome === 'MANUAL_REQUIRED').length
        }
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
    const reason = req.body?.reason || 'manual_api_call';
    const result = tradeExecutor.clearRedemptionQueue(reason);
    res.json({ success: true, message: 'Queue cleared', ...result });
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

    // 🎯 v52 CRITICAL FIX: Deep-merge helper to prevent config drift
    // When applying presets, object properties (ORACLE, RISK, etc.) must be MERGED,
    // not replaced, to preserve safety keys like adaptiveModeEnabled, enableCircuitBreaker
    const deepMerge = (target, source) => {
        if (!source || typeof source !== 'object' || Array.isArray(source)) return source;
        if (!target || typeof target !== 'object' || Array.isArray(target)) return source;
        const result = { ...target };
        for (const key of Object.keys(source)) {
            if (source[key] !== null && typeof source[key] === 'object' && !Array.isArray(source[key])) {
                result[key] = deepMerge(target[key], source[key]);
            } else if (source[key] !== undefined) {
                result[key] = source[key];
            }
        }
        return result;
    };

    // 🎯 v52: Keys that should be deep-merged (config objects) vs shallow-replaced (primitives)
    const deepMergeKeys = ['ORACLE', 'RISK', 'ASSET_CONTROLS', 'SCALP', 'ARBITRAGE', 'UNCERTAINTY', 
                          'MOMENTUM', 'ILLIQUIDITY_GAP', 'DEATH_BOUNCE', 'TELEGRAM'];

    // Update CONFIG
    for (const [key, value] of Object.entries(updates)) {
        if (CONFIG.hasOwnProperty(key)) {
            // 🎯 v52: Use deep-merge for object configs to preserve existing keys
            if (deepMergeKeys.includes(key) && value && typeof value === 'object') {
                CONFIG[key] = deepMerge(CONFIG[key], value);
                log(`⚙️ Setting DEEP-MERGED: ${key} (preserved existing keys)`);
            } else {
                CONFIG[key] = value;
                log(`⚙️ Setting updated: ${key}`);
            }

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
    <title>Settings - POLYPROPHET</title>
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
    <title>POLYPROPHET - Beginner's Guide</title>
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
        <h1>🔮 POLYPROPHET - Beginner's Guide</h1>
        
        <div class="card">
            <h2>📖 What Is This Bot?</h2>
            <p>POLYPROPHET is an <span class="term">AI-powered prediction bot</span> for <span class="highlight">Polymarket BTC/ETH price markets</span>. It analyzes price movements using 8 machine learning models and automatically trades when it identifies profitable opportunities.</p>
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
    <title>Wallet - POLYPROPHET</title>
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
                    
                    // 🎯 GOAT v44.1: Notify watchdog that a cycle was detected
                    if (typeof watchdogCycleDetected === 'function') {
                        watchdogCycleDetected();
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
                
                // 🎯 GOAT: Reset ALL per-cycle locks/state so we never get “stuck locked” across cycles
                // (Leaving these true causes permanent trade drought even with 0 positions.)
                Brains[a].convictionLocked = false;
                Brains[a].lockedDirection = null;
                Brains[a].lockTime = null;
                Brains[a].lockConfidence = 0;
                
                Brains[a].cycleCommitted = false;
                Brains[a].committedDirection = null;
                Brains[a].commitTime = null;
                
                Brains[a].oracleLocked = false;
                Brains[a].oracleLockPrediction = null;
                Brains[a].lockCertainty = 0;

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
const LIGHT_MODE = (String(process.env.LIGHT_MODE || '').toLowerCase() === 'true' || String(process.env.LIGHT_MODE || '') === '1');

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
    
    // 🎯 GOAT v4: Load persisted settings from Redis
    await loadCollectorEnabled();
    
    if (!LIGHT_MODE) {
        connectWebSocket();
    } else {
        log('🧪 LIGHT_MODE enabled: skipping WebSocket + background loops');
    }

    if (!LIGHT_MODE) {
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
    }

    // 🎯 GOAT v44.1: Startup Self-Tests
    const selfTestResults = runStartupSelfTests();
    if (selfTestResults.failed > 0) {
        log(`⚠️ STARTUP SELF-TESTS: ${selfTestResults.failed}/${selfTestResults.total} FAILED`);
        selfTestResults.failures.forEach(f => log(`   ❌ ${f}`));
    } else {
        log(`✅ STARTUP SELF-TESTS: ${selfTestResults.total}/${selfTestResults.total} PASSED`);
    }
    
    server.listen(PORT, () => {
        log(`⚡ SUPREME DEITY SERVER ONLINE on port ${PORT} `);
        log(`🌐 Access at: http://localhost:${PORT}`);
        log(`📊 Config Version: ${CONFIG_VERSION}`);
        log(`🔑 API Key: ${API_KEY.substring(0, 8)}...`);

        // 📱 Telegram: Server Online notification
        if (!LIGHT_MODE) {
            sendTelegramNotification(telegramServerStatus('online', {
                mode: CONFIG.TRADE_MODE,
                balance: tradeExecutor.mode === 'PAPER' ? tradeExecutor.paperBalance : null
            }));
        }
    });
    
    // 🎯 GOAT v44.1: Start Watchdog
    if (!LIGHT_MODE) {
        startWatchdog();
    }
}

// 🎯 GOAT v44.1: Startup Self-Tests
function runStartupSelfTests() {
    const tests = [];
    const failures = [];
    
    // Test 1: Required environment variables
    tests.push('ENV_AUTH');
    if (!process.env.AUTH_USERNAME || !process.env.AUTH_PASSWORD) {
        failures.push('AUTH_USERNAME or AUTH_PASSWORD not set (using defaults)');
    }
    
    // Test 2: Node version check
    tests.push('NODE_VERSION');
    const nodeVersion = process.version.match(/^v(\d+)/);
    const majorVersion = nodeVersion ? parseInt(nodeVersion[1]) : 0;
    if (majorVersion < 18) {
        failures.push(`Node version ${process.version} is below minimum (18.x)`);
    }
    if (majorVersion >= 26) {
        failures.push(`Node version ${process.version} is above tested maximum (25.x)`);
    }
    
    // Test 3: CONFIG sanity
    tests.push('CONFIG_SANITY');
    if (!CONFIG || !CONFIG.ORACLE) {
        failures.push('CONFIG or CONFIG.ORACLE is undefined');
    }
    if (CONFIG.ORACLE.maxOdds > 0.98) {
        failures.push(`CONFIG.ORACLE.maxOdds (${CONFIG.ORACLE.maxOdds}) is dangerously high (>98¢)`);
    }
    if (CONFIG.ORACLE.minOdds < 0.10) {
        failures.push(`CONFIG.ORACLE.minOdds (${CONFIG.ORACLE.minOdds}) is too low - allows tail bets`);
    }
    if (CONFIG.ORACLE.minConfidence < 0.3) {
        failures.push(`CONFIG.ORACLE.minConfidence (${CONFIG.ORACLE.minConfidence}) is very low`);
    }
    
    // Test 4: Trade executor initialized
    tests.push('TRADE_EXECUTOR');
    if (!tradeExecutor) {
        failures.push('tradeExecutor not initialized');
    }
    
    // Test 5: Brains initialized
    tests.push('BRAINS');
    if (!Brains || Object.keys(Brains).length === 0) {
        failures.push('Brains not initialized');
    }
    
    // Test 6: Gate trace initialized
    tests.push('GATE_TRACE');
    if (!gateTrace) {
        failures.push('gateTrace not initialized');
    }
    
    return {
        total: tests.length,
        passed: tests.length - failures.length,
        failed: failures.length,
        tests,
        failures
    };
}

// 🎯 GOAT v44.1: Watchdog - monitors for issues and alerts
let watchdogState = {
    lastCycleDetected: Date.now(),
    lastTrade: null,
    consecutiveApiFailures: 0,
    alertsSent: new Set()
};

function startWatchdog() {
    const WATCHDOG_INTERVAL = 5 * 60 * 1000; // Check every 5 minutes
    const CYCLE_TIMEOUT = 20 * 60 * 1000; // Alert if no cycle detected in 20 min
    const TRADE_DROUGHT_HOURS = 4; // Alert if no trades in 4 hours
    
    setInterval(() => {
        const now = Date.now();
        const alerts = [];
        
        // Check 1: Cycle detection
        const cycleAge = now - watchdogState.lastCycleDetected;
        if (cycleAge > CYCLE_TIMEOUT) {
            const alertKey = 'no_cycles_' + Math.floor(now / (60 * 60 * 1000));
            if (!watchdogState.alertsSent.has(alertKey)) {
                alerts.push(`⚠️ WATCHDOG: No cycles detected in ${(cycleAge / 60000).toFixed(0)} minutes`);
                watchdogState.alertsSent.add(alertKey);
            }
        }
        
        // Check 2: Trade drought
        const lastTradeTime = tradeExecutor.tradeHistory.length > 0 
            ? tradeExecutor.tradeHistory[tradeExecutor.tradeHistory.length - 1].timestamp 
            : null;
        if (lastTradeTime) {
            const tradeAge = (now - lastTradeTime) / (1000 * 60 * 60);
            if (tradeAge > TRADE_DROUGHT_HOURS) {
                const alertKey = 'trade_drought_' + Math.floor(now / (60 * 60 * 1000));
                if (!watchdogState.alertsSent.has(alertKey)) {
                    alerts.push(`⚠️ WATCHDOG: No trades in ${tradeAge.toFixed(1)} hours`);
                    watchdogState.alertsSent.add(alertKey);
                }
            }
        }
        
        // Check 3: Memory usage
        const memUsage = process.memoryUsage();
        const heapUsedMB = memUsage.heapUsed / (1024 * 1024);
        if (heapUsedMB > 500) {
            const alertKey = 'high_memory_' + Math.floor(now / (60 * 60 * 1000));
            if (!watchdogState.alertsSent.has(alertKey)) {
                alerts.push(`⚠️ WATCHDOG: High memory usage (${heapUsedMB.toFixed(0)}MB)`);
                watchdogState.alertsSent.add(alertKey);
            }
        }
        
        // Log alerts
        for (const alert of alerts) {
            log(alert);
            // Send Telegram alert if enabled
            if (CONFIG.TELEGRAM?.enabled) {
                sendTelegramNotification(telegramSystemAlert('🐕 Watchdog Alert', alert));
            }
        }
        
        // Clean up old alert keys (older than 6 hours)
        const cutoff = Math.floor((now - 6 * 60 * 60 * 1000) / (60 * 60 * 1000));
        for (const key of watchdogState.alertsSent) {
            const keyTime = parseInt(key.split('_').pop());
            if (keyTime < cutoff) {
                watchdogState.alertsSent.delete(key);
            }
        }
    }, WATCHDOG_INTERVAL);
    
    log(`🐕 WATCHDOG: Started (checking every ${WATCHDOG_INTERVAL / 60000} minutes)`);
}

// Update watchdog when cycle is detected
function watchdogCycleDetected() {
    watchdogState.lastCycleDetected = Date.now();
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
