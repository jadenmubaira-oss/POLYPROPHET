#!/usr/bin/env node
/**
 * Fresh 15m strategy audit for the currently deployed strategy set.
 *
 * This is intentionally targeted: it checks only the active strategy windows
 * against recently resolved Polymarket crypto 15m markets, so it can answer
 * whether the deployed rules are still transferring without overwriting the
 * canonical historical dataset.
 */

const fs = require('fs');
const https = require('https');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const GAMMA_API = 'https://gamma-api.polymarket.com';
const CLOB_API = 'https://clob.polymarket.com';
const STRATEGY_FILE = process.env.STRATEGY_FILE || 'strategies/strategy_set_15m_epoch3v2_portfolio.json';
const DAYS = Math.max(1, Number.parseInt(process.env.RECENT_DAYS || '6', 10));
const ASSETS = String(process.env.ASSETS || 'BTC,ETH,SOL,XRP')
    .split(',')
    .map((asset) => asset.trim().toUpperCase())
    .filter(Boolean);
const CYCLE_SECONDS = 900;
const FEE_RATE = 0.072;
const SLIPPAGE_PCT = 0.01;
const ADVERSE_FILL_CENTS = Number(process.env.ADVERSE_FILL_CENTS || '0.02');
const MIN_ORDER_SHARES = 5;

function fetchJSON(url, timeoutMs = 20000) {
    return new Promise((resolve, reject) => {
        const req = https.get(url, { timeout: timeoutMs }, (res) => {
            let data = '';
            res.on('data', (chunk) => { data += chunk; });
            res.on('end', () => {
                if (res.statusCode < 200 || res.statusCode >= 300) {
                    reject(new Error(`HTTP ${res.statusCode} for ${url}`));
                    return;
                }
                try { resolve(JSON.parse(data)); }
                catch (error) { reject(new Error(`JSON parse error: ${error.message}`)); }
            });
        });
        req.on('error', reject);
        req.on('timeout', () => {
            req.destroy();
            reject(new Error(`timeout for ${url}`));
        });
    });
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function safeJsonArray(value) {
    if (Array.isArray(value)) return value;
    try { return JSON.parse(value || '[]'); }
    catch { return []; }
}

async function fetchMarket(slug) {
    try {
        const markets = await fetchJSON(`${GAMMA_API}/markets?slug=${slug}`);
        if (Array.isArray(markets) && markets.length > 0) return markets[0];
    } catch {
        // fall through to event lookup
    }
    const events = await fetchJSON(`${GAMMA_API}/events?slug=${slug}`);
    const event = Array.isArray(events) && events.length > 0 ? events[0] : null;
    const markets = Array.isArray(event?.markets) ? event.markets : [];
    return markets.find((market) => String(market?.slug || '') === slug) || markets[0] || null;
}

async function fetchPriceHistory(tokenId, startTs, endTs) {
    try {
        const data = await fetchJSON(`${CLOB_API}/prices-history?market=${tokenId}&startTs=${startTs}&endTs=${endTs}&fidelity=1`);
        return Array.isArray(data?.history) ? data.history : [];
    } catch {
        return [];
    }
}

function tokenMapFor(market) {
    const tokenIds = safeJsonArray(market?.clobTokenIds);
    const outcomes = safeJsonArray(market?.outcomes);
    if (tokenIds.length < 2) return null;
    let yesIdx = outcomes.findIndex((outcome) => /^(yes|up)$/i.test(String(outcome).trim()));
    let noIdx = outcomes.findIndex((outcome) => /^(no|down)$/i.test(String(outcome).trim()));
    if (yesIdx < 0 || noIdx < 0) {
        yesIdx = 0;
        noIdx = 1;
    }
    if (!tokenIds[yesIdx] || !tokenIds[noIdx]) return null;
    return { yesTokenId: tokenIds[yesIdx], noTokenId: tokenIds[noIdx], yesIdx, noIdx };
}

function resolutionFor(market, tokenMap) {
    const prices = safeJsonArray(market?.outcomePrices).map(Number);
    const yes = prices[tokenMap.yesIdx];
    const no = prices[tokenMap.noIdx];
    if (yes >= 0.99) return 'UP';
    if (no >= 0.99) return 'DOWN';
    return null;
}

function priceAtMinute(history, epoch, entryMinute) {
    const minuteEnd = epoch + ((entryMinute + 1) * 60);
    const points = (history || [])
        .map((point) => ({ t: Number(point?.t), p: Number(point?.p) }))
        .filter((point) => Number.isFinite(point.t) && Number.isFinite(point.p) && point.t >= epoch && point.t < minuteEnd)
        .sort((a, b) => a.t - b.t);
    return points.length ? points[points.length - 1].p : null;
}

function calcFeePerShare(price) {
    return FEE_RATE * price * (1 - price);
}

function tradeMath(entryPrice, won) {
    const effectiveEntry = Math.min(0.99, (entryPrice * (1 + SLIPPAGE_PCT)) + ADVERSE_FILL_CENTS);
    const costPerShare = effectiveEntry + calcFeePerShare(effectiveEntry);
    const pnlPerShare = won ? 1 - costPerShare : -costPerShare;
    return { effectiveEntry, costPerShare, pnlPerShare, minCost: costPerShare * MIN_ORDER_SHARES };
}

function recentEpochsFor(strategy) {
    const nowSec = Math.floor(Date.now() / 1000);
    const latestClosedEpoch = Math.floor((nowSec - CYCLE_SECONDS) / CYCLE_SECONDS) * CYCLE_SECONDS;
    const earliestEpoch = latestClosedEpoch - (DAYS * 86400);
    const epochs = [];
    for (let epoch = earliestEpoch; epoch <= latestClosedEpoch; epoch += CYCLE_SECONDS) {
        const date = new Date(epoch * 1000);
        if (date.getUTCHours() !== Number(strategy.utcHour)) continue;
        epochs.push(epoch);
    }
    return epochs;
}

function summarise(rows) {
    const triggered = rows.filter((row) => row.triggered);
    const wins = triggered.filter((row) => row.won).length;
    const pnlPerShare = triggered.reduce((sum, row) => sum + row.pnlPerShare, 0);
    return {
        checked: rows.length,
        triggered: triggered.length,
        wins,
        losses: triggered.length - wins,
        winRate: triggered.length ? wins / triggered.length : null,
        avgPnlPerShare: triggered.length ? pnlPerShare / triggered.length : null,
    };
}

function safeOutputStem(value) {
    return path.basename(String(value || 'strategy'), '.json').replace(/[^a-z0-9_-]+/gi, '_').toLowerCase();
}

async function main() {
    const strategyPath = path.join(ROOT, STRATEGY_FILE);
    const data = JSON.parse(fs.readFileSync(strategyPath, 'utf8'));
    const strategies = Array.isArray(data?.strategies) ? data.strategies : [];
    if (!strategies.length) throw new Error(`No strategies found in ${STRATEGY_FILE}`);

    const grouped = new Map();
    for (const strategy of strategies) {
        const strategyAssets = String(strategy.asset || 'ALL').toUpperCase() === 'ALL'
            ? ASSETS
            : [String(strategy.asset).toUpperCase()];
        for (const epoch of recentEpochsFor(strategy)) {
            for (const asset of strategyAssets) {
                const key = `${epoch}_${asset}`;
                if (!grouped.has(key)) grouped.set(key, { epoch, asset, strategies: [] });
                grouped.get(key).strategies.push(strategy);
            }
        }
    }

    const marketRows = [...grouped.values()].sort((a, b) => a.epoch - b.epoch || a.asset.localeCompare(b.asset));
    const results = [];
    let processed = 0;
    let skipped = 0;

    for (const row of marketRows) {
        processed += 1;
        if (processed % 25 === 0) {
            console.log(`[fresh-audit] processed ${processed}/${marketRows.length}, results=${results.length}, skipped=${skipped}`);
        }
        const slug = `${row.asset.toLowerCase()}-updown-15m-${row.epoch}`;
        try {
            const market = await fetchMarket(slug);
            if (!market || !market.closed) { skipped += 1; continue; }
            const tokens = tokenMapFor(market);
            if (!tokens) { skipped += 1; continue; }
            const resolution = resolutionFor(market, tokens);
            if (!resolution) { skipped += 1; continue; }
            const [yesHistory, noHistory] = await Promise.all([
                fetchPriceHistory(tokens.yesTokenId, row.epoch, row.epoch + CYCLE_SECONDS),
                fetchPriceHistory(tokens.noTokenId, row.epoch, row.epoch + CYCLE_SECONDS),
            ]);

            for (const strategy of row.strategies) {
                const history = strategy.direction === 'UP' ? yesHistory : noHistory;
                const price = priceAtMinute(history, row.epoch, Number(strategy.entryMinute));
                if (!Number.isFinite(price)) continue;
                const triggered = price >= Number(strategy.priceMin) && price <= Number(strategy.priceMax);
                const won = resolution === strategy.direction;
                const math = triggered ? tradeMath(price, won) : { effectiveEntry: null, costPerShare: null, pnlPerShare: null, minCost: null };
                results.push({
                    id: strategy.id,
                    name: strategy.name,
                    asset: row.asset,
                    epoch: row.epoch,
                    iso: new Date(row.epoch * 1000).toISOString(),
                    utcHour: strategy.utcHour,
                    entryMinute: strategy.entryMinute,
                    direction: strategy.direction,
                    priceMin: strategy.priceMin,
                    priceMax: strategy.priceMax,
                    price,
                    resolution,
                    triggered,
                    won: triggered ? won : null,
                    ...math,
                });
            }
            await sleep(75);
        } catch (error) {
            skipped += 1;
            console.warn(`[fresh-audit] ${slug}: ${error.message}`);
            await sleep(200);
        }
    }

    const byStrategy = {};
    for (const strategy of strategies) {
        const rows = results.filter((row) => row.id === strategy.id);
        byStrategy[strategy.id] = {
            id: strategy.id,
            name: strategy.name,
            direction: strategy.direction,
            utcHour: strategy.utcHour,
            entryMinute: strategy.entryMinute,
            priceBand: `${strategy.priceMin}-${strategy.priceMax}`,
            modelWinRate: strategy.pWinEstimate || strategy.winRate,
            holdoutEvents: strategy.holdoutEvents,
            ...summarise(rows),
        };
    }

    const triggered = results.filter((row) => row.triggered);
    const wins = triggered.filter((row) => row.won).length;
    const summary = {
        generatedAt: new Date().toISOString(),
        strategyFile: STRATEGY_FILE,
        recentDays: DAYS,
        assets: ASSETS,
        uniqueMarketsPlanned: marketRows.length,
        uniqueMarketsProcessed: processed,
        skippedMarkets: skipped,
        observations: results.length,
        triggered: triggered.length,
        wins,
        losses: triggered.length - wins,
        winRate: triggered.length ? wins / triggered.length : null,
        avgPnlPerShare: triggered.length ? triggered.reduce((sum, row) => sum + row.pnlPerShare, 0) / triggered.length : null,
        firstTriggered: triggered.length ? triggered[0].iso : null,
        lastTriggered: triggered.length ? triggered[triggered.length - 1].iso : null,
        byStrategy,
    };

    const outDir = path.join(ROOT, 'epoch3', 'reinvestigation_v2');
    fs.mkdirSync(outDir, { recursive: true });
    const outPath = path.join(outDir, `fresh_15m_strategy_audit_${safeOutputStem(STRATEGY_FILE)}_${DAYS}d.json`);
    fs.writeFileSync(outPath, JSON.stringify({ summary, results }, null, 2));

    console.log(JSON.stringify(summary, null, 2));
    console.log(`fresh audit saved: ${path.relative(ROOT, outPath)}`);
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});