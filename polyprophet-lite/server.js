const express = require('express');
const path = require('path');
const fs = require('fs');
const CONFIG = require('./lib/config');
const { discoverAllMarkets, computeEpoch, getEntryMinute, fetchMarketBySlug } = require('./lib/market-discovery');
const { loadStrategySet, evaluateMatch, sortCandidates, getAllLoadedSets } = require('./lib/strategy-matcher');
const RiskManager = require('./lib/risk-manager');
const TradeExecutor = require('./lib/trade-executor');
const telegram = require('./lib/telegram');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ==================== CORE STATE ====================
const riskManager = new RiskManager(CONFIG.RISK.startingBalance);
const tradeExecutor = new TradeExecutor(riskManager);
let currentMarkets = {};
let lastOrchestrationTime = 0;
let orchestratorHeartbeat = { lastRun: null, marketsChecked: 0, candidatesFound: 0, tradesAttempted: 0 };
let diagnosticLog = [];
const startupTime = Date.now();

// ==================== LOAD STRATEGY SETS ====================
function loadAllStrategySets() {
    const strategiesDir = path.join(__dirname, 'strategies');
    for (const tf of CONFIG.TIMEFRAMES) {
        const candidates = [
            path.join(strategiesDir, `strategy_set_${tf.key}_top8.json`),
            path.join(strategiesDir, `strategy_set_${tf.key}_top5.json`),
            path.join(strategiesDir, `strategy_set_${tf.key}.json`),
        ];
        // Also check for the existing 15m strategy from the parent repo
        if (tf.key === '15m') {
            candidates.push(path.join(__dirname, '..', 'debug', 'strategy_set_top8_current.json'));
        }
        for (const fp of candidates) {
            if (fs.existsSync(fp)) {
                loadStrategySet(tf.key, fp);
                break;
            }
        }
    }
}

loadAllStrategySets();
console.log(`\n🚀 POLYPROPHET LITE — Multi-Timeframe Trading Bot`);
console.log(`   Mode: ${CONFIG.TRADE_MODE} | Live: ${CONFIG.IS_LIVE ? 'YES' : 'NO'}`);
console.log(`   Assets: ${CONFIG.ASSETS.join(', ')}`);
console.log(`   Timeframes: ${CONFIG.TIMEFRAMES.map(t => t.key).join(', ')}`);
console.log(`   Starting Balance: $${CONFIG.RISK.startingBalance}`);
console.log(`   Strategy Sets: ${JSON.stringify(getAllLoadedSets())}\n`);

// ==================== MAIN ORCHESTRATION LOOP ====================
async function orchestrate() {
    const nowSec = Math.floor(Date.now() / 1000);

    // Discover all markets across all timeframes and assets
    try {
        currentMarkets = await discoverAllMarkets(nowSec);
    } catch (e) {
        console.error(`❌ Market discovery failed: ${e.message}`);
        return;
    }

    let marketsChecked = 0;
    let candidatesFound = 0;
    let tradesAttempted = 0;
    const allCandidates = [];

    // For each timeframe, evaluate strategy matches
    for (const tf of CONFIG.TIMEFRAMES) {
        for (const asset of CONFIG.ASSETS) {
            const key = `${asset}_${tf.key}`;
            const market = currentMarkets[key];
            if (!market || market.status !== 'ACTIVE') continue;
            marketsChecked++;

            const matches = evaluateMatch(market, nowSec, tf);
            if (matches.length > 0) {
                for (const m of matches) {
                    m.epoch = market.epoch;
                    allCandidates.push({ candidate: m, market });
                }
                candidatesFound += matches.length;
            }
        }
    }

    // Sort all candidates by quality (across all timeframes)
    if (allCandidates.length > 0) {
        allCandidates.sort((a, b) => {
            const lcbA = a.candidate.strategy.winRateLCB || 0;
            const lcbB = b.candidate.strategy.winRateLCB || 0;
            return lcbB - lcbA;
        });

        // Log active windows
        const windowLog = allCandidates.map(c =>
            `${c.candidate.asset} ${c.candidate.timeframe} ${c.candidate.direction} ${c.candidate.name} @${(c.candidate.entryPrice*100).toFixed(0)}¢ pWin=${(c.candidate.pWinEstimate*100).toFixed(0)}%`
        ).join(' | ');
        console.log(`🎯 STRATEGY WINDOWS: ${windowLog}`);

        // Execute best candidates (risk manager limits how many per cycle)
        for (const { candidate, market } of allCandidates) {
            const result = await tradeExecutor.executeTrade(candidate, market);
            tradesAttempted++;

            if (result.success) {
                telegram.notifyTradeOpen(result);

                diagnosticLog.push({
                    ts: new Date().toISOString(),
                    type: 'TRADE_OPENED',
                    asset: candidate.asset,
                    timeframe: candidate.timeframe,
                    direction: candidate.direction,
                    entryPrice: candidate.entryPrice,
                    size: result.size,
                    strategy: candidate.name
                });
            } else if (result.blocked) {
                diagnosticLog.push({
                    ts: new Date().toISOString(),
                    type: 'BLOCKED',
                    asset: candidate.asset,
                    timeframe: candidate.timeframe,
                    direction: candidate.direction,
                    entryPrice: candidate.entryPrice,
                    reason: result.error,
                    strategy: candidate.name
                });
            }
        }
    }

    // Check for expired positions to resolve
    tradeExecutor.checkAndResolveExpiredPositions(currentMarkets);

    // Resolve pending paper positions
    await resolvePendingPaperPositions();

    // Update heartbeat
    orchestratorHeartbeat = {
        lastRun: new Date().toISOString(),
        marketsChecked,
        candidatesFound,
        tradesAttempted,
        activeMarkets: Object.values(currentMarkets).filter(m => m?.status === 'ACTIVE').length,
        totalMarkets: Object.keys(currentMarkets).length
    };

    // Trim diagnostic log
    if (diagnosticLog.length > 500) diagnosticLog.splice(0, diagnosticLog.length - 500);

    // Periodic heartbeat log (every 60s)
    if (nowSec - lastOrchestrationTime >= 60) {
        lastOrchestrationTime = nowSec;
        const utcHour = new Date().getUTCHours();
        const utcMin = new Date().getUTCMinutes();
        console.log(`📡 HEARTBEAT ${utcHour}:${String(utcMin).padStart(2,'0')} | Markets: ${marketsChecked}/${Object.keys(currentMarkets).length} active | Candidates: ${candidatesFound} | Trades: ${tradesAttempted} | Balance: $${riskManager.bankroll.toFixed(2)}`);
    }
}

async function resolvePendingPaperPositions() {
    const pending = [...tradeExecutor.pendingRedemptions];
    tradeExecutor.pendingRedemptions = [];

    for (const p of pending) {
        try {
            const market = await fetchMarketBySlug(p.slug);
            if (!market || !market.closed) {
                tradeExecutor.pendingRedemptions.push(p);
                continue;
            }

            let outcomes = [];
            let prices = [];
            try { outcomes = JSON.parse(market.outcomes || '[]'); } catch {}
            try { prices = JSON.parse(market.outcomePrices || '[]'); } catch {}

            const upIdx = outcomes.findIndex(o => /^(yes|up)$/i.test(String(o).trim()));
            const downIdx = outcomes.findIndex(o => /^(no|down)$/i.test(String(o).trim()));
            const upPrice = upIdx >= 0 && prices[upIdx] ? parseFloat(prices[upIdx]) : null;
            const downPrice = downIdx >= 0 && prices[downIdx] ? parseFloat(prices[downIdx]) : null;

            let winner = null;
            if (upPrice !== null && upPrice >= 0.95) winner = 'UP';
            else if (downPrice !== null && downPrice >= 0.95) winner = 'DOWN';
            else if (upPrice !== null && upPrice <= 0.05) winner = 'DOWN';
            else if (downPrice !== null && downPrice <= 0.05) winner = 'UP';

            if (winner) {
                const pos = tradeExecutor.positions.find(pos => pos.id === p.positionId);
                if (pos && pos.status === 'OPEN') {
                    const won = pos.direction === winner;
                    const result = tradeExecutor.resolvePosition(p.positionId, won);
                    if (result) {
                        telegram.notifyTradeClose(result);
                    }
                }
            } else {
                tradeExecutor.pendingRedemptions.push(p);
            }
        } catch {
            tradeExecutor.pendingRedemptions.push(p);
        }
    }
}

// ==================== API ENDPOINTS ====================
app.get('/api/health', (req, res) => {
    const uptime = (Date.now() - startupTime) / 1000;
    res.json({
        status: 'ok',
        version: 'polyprophet-lite-1.0.0',
        uptime,
        mode: CONFIG.TRADE_MODE,
        isLive: CONFIG.IS_LIVE,
        balance: riskManager.bankroll,
        assets: CONFIG.ASSETS,
        timeframes: CONFIG.TIMEFRAMES.map(t => t.key),
        orchestrator: orchestratorHeartbeat,
        strategySets: getAllLoadedSets()
    });
});

app.get('/api/status', (req, res) => {
    res.json({
        risk: riskManager.getStatus(),
        executor: tradeExecutor.getStatus(),
        markets: Object.fromEntries(
            Object.entries(currentMarkets).map(([k, v]) => [k, {
                status: v?.status,
                yesPrice: v?.yesPrice,
                noPrice: v?.noPrice,
                slug: v?.slug
            }])
        ),
        orchestrator: orchestratorHeartbeat,
        strategies: getAllLoadedSets()
    });
});

app.get('/api/trades', (req, res) => {
    const limit = parseInt(req.query.limit) || 50;
    res.json({
        trades: tradeExecutor.getRecentTrades(limit),
        openPositions: tradeExecutor.getOpenPositions(),
        risk: riskManager.getStatus()
    });
});

app.get('/api/diagnostics', (req, res) => {
    res.json({
        log: diagnosticLog.slice(-100),
        orchestrator: orchestratorHeartbeat,
        uptime: (Date.now() - startupTime) / 1000
    });
});

app.get('/api/markets', (req, res) => {
    res.json(currentMarkets);
});

// ==================== DASHBOARD ====================
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ==================== START ====================
const TICK_INTERVAL_MS = 2000;
let tickTimer = null;

async function tick() {
    try {
        await orchestrate();
    } catch (e) {
        console.error(`❌ Orchestration error: ${e.message}`);
    }
}

const server = app.listen(CONFIG.PORT, () => {
    console.log(`\n🌐 Dashboard: http://localhost:${CONFIG.PORT}`);
    console.log(`📡 Health: http://localhost:${CONFIG.PORT}/api/health`);
    console.log(`📊 Status: http://localhost:${CONFIG.PORT}/api/status\n`);

    // Start orchestration loop
    tickTimer = setInterval(tick, TICK_INTERVAL_MS);
    tick(); // First tick immediately
});

server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
        console.error(`🔴 Port ${CONFIG.PORT} in use — exiting`);
        process.exit(1);
    }
});

process.on('SIGTERM', () => {
    console.log('Received SIGTERM, shutting down...');
    if (tickTimer) clearInterval(tickTimer);
    server.close(() => process.exit(0));
});
