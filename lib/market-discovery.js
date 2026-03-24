const https = require('https');
const http = require('http');
const { URL } = require('url');
const CONFIG = require('./config');

let proxyAgent = null;
if (CONFIG.PROXY_URL) {
    try {
        const { HttpsProxyAgent } = require('https-proxy-agent');
        proxyAgent = new HttpsProxyAgent(CONFIG.PROXY_URL);
        console.log(`✅ Proxy configured: ${CONFIG.PROXY_URL.replace(/:[^:@]+@/, ':***@')}`);
    } catch (e) {
        console.log(`⚠️ https-proxy-agent not available: ${e.message}`);
    }
}

const marketCache = {};
const CACHE_TTL_MS = 10000;

 function getEnabledTimeframes() {
     return CONFIG.TIMEFRAMES.filter(tf => tf && tf.enabled !== false);
 }

function fetchJSON(url, timeoutMs = 10000) {
    return new Promise((resolve, reject) => {
        const opts = { timeout: timeoutMs };
        if (proxyAgent) {
            const useProxy = !String(url || '').includes('clob.polymarket.com') || CONFIG.CLOB_FORCE_PROXY;
            if (useProxy) opts.agent = proxyAgent;
        }
        const req = https.get(url, opts, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try { resolve(JSON.parse(data)); }
                catch (e) { reject(new Error(`JSON parse: ${e.message}`)); }
            });
        });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    });
}

function computeEpoch(nowSec, sessionSeconds) {
    return Math.floor(nowSec / sessionSeconds) * sessionSeconds;
}

function buildSlug(asset, timeframe, epoch) {
    return `${asset.toLowerCase()}-updown-${timeframe}-${epoch}`;
}

async function fetchMarketBySlug(slug) {
    const cached = marketCache[slug];
    if (cached && (Date.now() - cached.ts) < CACHE_TTL_MS) return cached.data;

    try {
        const markets = await fetchJSON(`${CONFIG.GAMMA_API}/markets?slug=${slug}`);
        const market = Array.isArray(markets) && markets.length > 0 ? markets[0] : null;
        marketCache[slug] = { data: market, ts: Date.now() };
        return market;
    } catch (e) {
        return null;
    }
}

async function fetchCLOBBook(tokenId) {
    try {
        const book = await fetchJSON(`${CONFIG.CLOB_API}/book?token_id=${tokenId}`);
        if (!book || book.error) return null;
        const bestBid = book.bids && book.bids.length > 0 ? parseFloat(book.bids[0].price) : null;
        const bestAsk = book.asks && book.asks.length > 0 ? parseFloat(book.asks[0].price) : null;
        const midpoint = bestBid !== null && bestAsk !== null ? (bestBid + bestAsk) / 2 : (bestBid || bestAsk);
        return { bestBid, bestAsk, midpoint, raw: book };
    } catch {
        return null;
    }
}

function safeParseJsonArray(val) {
    if (Array.isArray(val)) return val;
    try { return JSON.parse(val || '[]'); } catch { return []; }
}

async function discoverMarket(asset, tf, nowSec) {
    const epoch = computeEpoch(nowSec, tf.seconds);
    const slug = buildSlug(asset, tf.key, epoch);

    const market = await fetchMarketBySlug(slug);
    if (!market) return { asset, timeframe: tf.key, epoch, slug, status: 'NOT_FOUND', data: null };

    if (market.closed || !market.active || !market.acceptingOrders) {
        return { asset, timeframe: tf.key, epoch, slug, status: 'CLOSED', data: market };
    }

    const tokenIds = safeParseJsonArray(market.clobTokenIds);
    if (tokenIds.length < 2) {
        return { asset, timeframe: tf.key, epoch, slug, status: 'NO_TOKENS', data: market };
    }

    const outcomes = safeParseJsonArray(market.outcomes);
    let yesTokenId = tokenIds[0];
    let noTokenId = tokenIds[1];
    if (Array.isArray(outcomes) && outcomes.length >= 2) {
        const yesIdx = outcomes.findIndex(o => /^(yes|up)$/i.test(String(o).trim()));
        const noIdx = outcomes.findIndex(o => /^(no|down)$/i.test(String(o).trim()));
        if (yesIdx >= 0 && noIdx >= 0 && tokenIds[yesIdx] && tokenIds[noIdx]) {
            yesTokenId = tokenIds[yesIdx];
            noTokenId = tokenIds[noIdx];
        }
    }

    const [yesBook, noBook] = await Promise.all([
        fetchCLOBBook(yesTokenId),
        fetchCLOBBook(noTokenId)
    ]);

    const yesPrice = yesBook?.midpoint || null;
    const noPrice = noBook?.midpoint || null;

    if (yesPrice === null && noPrice === null) {
        return { asset, timeframe: tf.key, epoch, slug, status: 'NO_LIQUIDITY', data: market };
    }

    return {
        asset,
        timeframe: tf.key,
        epoch,
        slug,
        status: 'ACTIVE',
        yesPrice,
        noPrice,
        yesTokenId,
        noTokenId,
        volume: market.volume ? parseFloat(market.volume) : 0,
        conditionId: market.conditionId,
        marketUrl: `https://polymarket.com/event/${slug}`,
        data: market
    };
}

async function discoverAllMarkets(nowSec) {
    const results = {};

    const promises = [];
    for (const asset of CONFIG.ASSETS) {
        for (const tf of getEnabledTimeframes()) {
            promises.push(
                discoverMarket(asset, tf, nowSec).then(r => {
                    const key = `${asset}_${tf.key}`;
                    results[key] = r;
                })
            );
        }
    }

    await Promise.all(promises);
    return results;
}

function getElapsedInCycle(nowSec, sessionSeconds) {
    const epoch = computeEpoch(nowSec, sessionSeconds);
    return nowSec - epoch;
}

function getEntryMinute(nowSec, sessionSeconds) {
    const elapsed = getElapsedInCycle(nowSec, sessionSeconds);
    const maxMinute = Math.floor(sessionSeconds / 60) - 1;
    return Math.max(0, Math.min(maxMinute, Math.floor(elapsed / 60)));
}

module.exports = {
    fetchJSON,
    computeEpoch,
    buildSlug,
    discoverMarket,
    discoverAllMarkets,
    getElapsedInCycle,
    getEntryMinute,
    fetchCLOBBook,
    fetchMarketBySlug
};
