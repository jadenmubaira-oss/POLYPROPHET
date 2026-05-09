#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');

const ROOT = path.resolve(__dirname, '..');
const GAMMA_API = 'https://gamma-api.polymarket.com';
const CLOB_API = 'https://clob.polymarket.com';
const TIMEFRAME = String(process.env.FETCH_TIMEFRAME || '5m').trim().toLowerCase();
const DAYS = Math.max(1, Number.parseInt(process.env.FETCH_DAYS || '2', 10));
const ASSETS = String(process.env.FETCH_ASSETS || 'BTC,ETH,SOL,XRP,BNB,DOGE,HYPE')
    .split(',')
    .map((asset) => asset.trim().toUpperCase())
    .filter(Boolean);
const CONCURRENCY = Math.max(1, Number.parseInt(process.env.FETCH_CONCURRENCY || '12', 10));
const CYCLE_SECONDS = { '5m': 300, '15m': 900, '1h': 3600, '4h': 14400 }[TIMEFRAME];

if (!CYCLE_SECONDS) throw new Error(`Unsupported FETCH_TIMEFRAME=${TIMEFRAME}`);

const CACHE_FILE = process.env.OUTPUT_CACHE || path.join(ROOT, 'debug', `recent_${TIMEFRAME}_cycle_cache_${DAYS}d.json`);

function ensureDir(dir) { fs.mkdirSync(dir, { recursive: true }); }

function safeJsonArray(value) {
    if (Array.isArray(value)) return value;
    try { return JSON.parse(value || '[]'); } catch { return []; }
}

function fetchJSON(url, timeoutMs = 15000) {
    return new Promise((resolve, reject) => {
        const req = https.get(url, { timeout: timeoutMs }, (res) => {
            let data = '';
            res.setEncoding('utf8');
            res.on('data', (chunk) => { data += chunk; });
            res.on('end', () => {
                if (res.statusCode < 200 || res.statusCode >= 300) {
                    reject(new Error(`HTTP_${res.statusCode} ${url}`));
                    return;
                }
                try { resolve(JSON.parse(data)); } catch (error) { reject(error); }
            });
        });
        req.on('timeout', () => req.destroy(new Error(`TIMEOUT ${url}`)));
        req.on('error', reject);
    });
}

async function fetchMarket(slug) {
    try {
        const markets = await fetchJSON(`${GAMMA_API}/markets?slug=${slug}`);
        if (Array.isArray(markets) && markets.length > 0) return markets[0];
    } catch {
        // fallback below
    }
    try {
        const events = await fetchJSON(`${GAMMA_API}/events?slug=${slug}`);
        const event = Array.isArray(events) && events.length > 0 ? events[0] : null;
        const markets = Array.isArray(event?.markets) ? event.markets : [];
        return markets.find((market) => String(market?.slug || '') === slug) || markets[0] || null;
    } catch {
        return null;
    }
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
    const outcome = String(market?.resolvedOutcome || market?.winner || market?.winningOutcome || '').toUpperCase();
    if (outcome.includes('UP') || outcome.includes('YES')) return 'UP';
    if (outcome.includes('DOWN') || outcome.includes('NO')) return 'DOWN';
    return null;
}

function priceAtMinute(history, epoch, minute) {
    const minuteEnd = epoch + ((minute + 1) * 60);
    const points = (history || [])
        .map((point) => ({ t: Number(point?.t), p: Number(point?.p) }))
        .filter((point) => Number.isFinite(point.t) && Number.isFinite(point.p) && point.t >= epoch && point.t < minuteEnd)
        .sort((a, b) => a.t - b.t);
    return points.length ? points[points.length - 1].p : null;
}

function latestClosedEpoch() {
    const nowSec = Math.floor(Date.now() / 1000);
    return Math.floor((nowSec - CYCLE_SECONDS) / CYCLE_SECONDS) * CYCLE_SECONDS;
}

function plannedCycles() {
    const latest = latestClosedEpoch();
    const earliest = latest - (DAYS * 86400);
    const tasks = [];
    for (let epoch = earliest; epoch <= latest; epoch += CYCLE_SECONDS) {
        for (const asset of ASSETS) tasks.push({ epoch, asset });
    }
    return tasks;
}

function loadCache() {
    if (!fs.existsSync(CACHE_FILE) || process.env.FORCE_FETCH === 'true') return { cycles: [], skipped: [] };
    try { return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')); } catch { return { cycles: [], skipped: [] }; }
}

function saveCache(cache) {
    ensureDir(path.dirname(CACHE_FILE));
    fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2));
}

async function fetchCycle({ epoch, asset }) {
    const slug = `${asset.toLowerCase()}-updown-${TIMEFRAME}-${epoch}`;
    const market = await fetchMarket(slug);
    if (!market || !market.closed) return { skipped: true, reason: 'not_closed_or_missing', key: `${epoch}_${asset}`, slug, asset, epoch };
    const tokens = tokenMapFor(market);
    if (!tokens) return { skipped: true, reason: 'no_tokens', key: `${epoch}_${asset}`, slug, asset, epoch };
    const outcome = resolutionFor(market, tokens);
    if (!outcome) return { skipped: true, reason: 'no_resolution', key: `${epoch}_${asset}`, slug, asset, epoch };
    const [yesHistory, noHistory] = await Promise.all([
        fetchPriceHistory(tokens.yesTokenId, epoch, epoch + CYCLE_SECONDS),
        fetchPriceHistory(tokens.noTokenId, epoch, epoch + CYCLE_SECONDS),
    ]);
    const prices = [];
    for (let minute = 0; minute < CYCLE_SECONDS / 60; minute += 1) {
        prices.push({
            minute,
            UP: priceAtMinute(yesHistory, epoch, minute),
            DOWN: priceAtMinute(noHistory, epoch, minute),
        });
    }
    return {
        key: `${epoch}_${asset}`,
        slug,
        asset,
        timeframe: TIMEFRAME,
        epoch,
        utcHour: new Date(epoch * 1000).getUTCHours(),
        outcome,
        resolution: outcome,
        prices,
        marketId: market.id,
    };
}

async function mapLimit(items, limit, fn) {
    const out = new Array(items.length);
    let next = 0;
    async function worker() {
        while (next < items.length) {
            const index = next++;
            out[index] = await fn(items[index], index);
            if ((index + 1) % 250 === 0) console.error(`processed ${index + 1}/${items.length}`);
        }
    }
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
    return out;
}

async function main() {
    const cache = loadCache();
    const existing = new Map((cache.cycles || []).map((cycle) => [cycle.key, cycle]));
    const skipped = Array.isArray(cache.skipped) ? cache.skipped : [];
    const skippedKeys = new Set(skipped.map((item) => item.key));
    const tasks = plannedCycles().filter((task) => !existing.has(`${task.epoch}_${task.asset}`) && !skippedKeys.has(`${task.epoch}_${task.asset}`));
    console.error(`Fetching ${tasks.length} missing ${TIMEFRAME} cycles (${ASSETS.join(',')}, ${DAYS}d)`);
    const results = await mapLimit(tasks, CONCURRENCY, fetchCycle);
    for (const result of results) {
        if (!result) continue;
        if (result.skipped) skipped.push(result);
        else existing.set(result.key, result);
    }
    const cycles = [...existing.values()].sort((a, b) => a.epoch - b.epoch || a.asset.localeCompare(b.asset));
    const output = {
        generatedAt: new Date().toISOString(),
        timeframe: TIMEFRAME,
        days: DAYS,
        assets: ASSETS,
        cycleSeconds: CYCLE_SECONDS,
        cycles,
        skipped,
    };
    saveCache(output);
    const assetsFound = [...new Set(cycles.map((cycle) => cycle.asset))].sort();
    const epochs = cycles.map((cycle) => cycle.epoch);
    console.log(JSON.stringify({
        cacheFile: path.relative(ROOT, CACHE_FILE),
        cycles: cycles.length,
        skipped: skipped.length,
        assetsFound,
        from: epochs.length ? new Date(Math.min(...epochs) * 1000).toISOString() : null,
        to: epochs.length ? new Date(Math.max(...epochs) * 1000).toISOString() : null,
    }, null, 2));
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});