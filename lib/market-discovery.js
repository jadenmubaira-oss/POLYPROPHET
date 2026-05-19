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
const CACHE_PRUNE_AFTER_MS = 60 * 60 * 1000;
const CACHE_MAX_KEYS = 512;

function pruneMarketCache(now = Date.now()) {
    const entries = Object.entries(marketCache);
    for (const [slug, cached] of entries) {
        if (!cached || !Number.isFinite(Number(cached.ts)) || (now - Number(cached.ts)) > CACHE_PRUNE_AFTER_MS) {
            delete marketCache[slug];
        }
    }
    const freshEntries = Object.entries(marketCache);
    if (freshEntries.length <= CACHE_MAX_KEYS) return;
    freshEntries
        .sort((a, b) => Number(a[1]?.ts || 0) - Number(b[1]?.ts || 0))
        .slice(0, freshEntries.length - CACHE_MAX_KEYS)
        .forEach(([slug]) => delete marketCache[slug]);
}

 function getConfiguredTimeframes() {
     return CONFIG.TIMEFRAMES.filter(tf => tf && tf.enabled !== false);
 }

function fetchJSON(url, timeoutMs = 10000, options = {}) {
    return new Promise((resolve, reject) => {
        const opts = { timeout: timeoutMs };
        if (proxyAgent && options.useProxy) {
            opts.agent = proxyAgent;
        }
        const req = https.get(url, opts, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                if (res.statusCode >= 400) {
                    return reject(new Error(`HTTP ${res.statusCode}`));
                }
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

    const cacheNow = Date.now();

    const slugPathUrl = `${CONFIG.GAMMA_API}/markets/slug/${encodeURIComponent(String(slug))}`;
    const queryUrl = `${CONFIG.GAMMA_API}/markets?slug=${encodeURIComponent(String(slug))}`;

    const coerceMarket = (payload) => {
        if (!payload) return null;
        if (Array.isArray(payload)) return payload.length > 0 ? payload[0] : null;
        if (typeof payload === 'object') return payload;
        return null;
    };

    const fetchWithFallbacks = async (useProxy = false) => {
        // Prefer the dedicated slug endpoint (works for historical slugs).
        // Fallback to list endpoint for backwards compatibility.
        const primary = await fetchJSON(slugPathUrl, 10000, { useProxy }).catch(() => null);
        const primaryMarket = coerceMarket(primary);
        if (primaryMarket) return primaryMarket;

        const secondary = await fetchJSON(queryUrl, 10000, { useProxy }).catch(() => null);
        return coerceMarket(secondary);
    };

    try {
        const market = await fetchWithFallbacks(false);
        marketCache[slug] = { data: market, ts: cacheNow };
        pruneMarketCache(cacheNow);
        return market;
    } catch {
        if (!proxyAgent) return null;
        try {
            const market = await fetchWithFallbacks(true);
            marketCache[slug] = { data: market, ts: cacheNow };
            pruneMarketCache(cacheNow);
            return market;
        } catch {
            return null;
        }
    }
}

async function fetchCLOBBook(tokenId) {
     try {
        const bookUrl = `${CONFIG.CLOB_API}/book?token_id=${tokenId}`;
        const priceUrl = `${CONFIG.CLOB_API}/price?token_id=${tokenId}&side=BUY`;
        const fetchPair = async (useProxy = false) => Promise.allSettled([
            fetchJSON(bookUrl, 10000, { useProxy }),
            fetchJSON(priceUrl, 10000, { useProxy })
        ]);

        const getPayload = (result) => result.status === 'fulfilled' ? result.value : null;
        const isUsableBook = (payload) => {
            if (!payload || payload.error) return false;
            return Array.isArray(payload.bids) || Array.isArray(payload.asks);
        };
        const isUsablePrice = (payload) => {
            if (!payload || payload.error) return false;
            return Number.isFinite(parseFloat(payload.price));
        };

        // CLOB read endpoints (book/price) are NOT geoblocked.
        // Always try direct first for discovery, proxy fallback only if direct fails.
        // CLOB_FORCE_PROXY only affects write operations (order placement in clob-client.js).
        let [bookResult, buyPriceResult] = await fetchPair(false);

        const bookPayload = getPayload(bookResult);
        const pricePayload = getPayload(buyPriceResult);

        if (!isUsableBook(bookPayload) && !isUsablePrice(pricePayload) && proxyAgent) {
            [bookResult, buyPriceResult] = await fetchPair(true);
        }

        const book = getPayload(bookResult);
        const buyPricePayload = getPayload(buyPriceResult);

        if ((!book || book.error) && (!buyPricePayload || buyPricePayload.error)) return null;

        const bidLevels = Array.isArray(book?.bids)
            ? book.bids.map(level => parseFloat(level?.price)).filter(Number.isFinite)
            : [];
        const askLevels = Array.isArray(book?.asks)
            ? book.asks.map(level => parseFloat(level?.price)).filter(Number.isFinite)
            : [];

        const bestBid = bidLevels.length > 0 ? Math.max(...bidLevels) : null;
        const bestAsk = askLevels.length > 0 ? Math.min(...askLevels) : null;
        const quoteBuyPriceRaw = parseFloat(buyPricePayload?.price);
        const quoteBuyPrice = Number.isFinite(quoteBuyPriceRaw) ? quoteBuyPriceRaw : null;
        const buyPrice = bestAsk ?? quoteBuyPrice;
        const midpoint = bestBid !== null && bestAsk !== null ? (bestBid + bestAsk) / 2 : (bestBid ?? bestAsk ?? buyPrice);
        return { bestBid, bestAsk, buyPrice, quoteBuyPrice, midpoint, raw: book };
     } catch {
         return null;
     }
 }

function parseMinOrderSize(book) {
    const raw = Number(book?.raw?.min_order_size);
    if (!Number.isFinite(raw) || raw <= 0) return null;
    return Math.ceil(raw);
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
    let yesOutcomeIdx = 0;
    let noOutcomeIdx = 1;
    if (Array.isArray(outcomes) && outcomes.length >= 2) {
        const yesIdx = outcomes.findIndex(o => /^(yes|up)$/i.test(String(o).trim()));
        const noIdx = outcomes.findIndex(o => /^(no|down)$/i.test(String(o).trim()));
        if (yesIdx >= 0 && noIdx >= 0 && tokenIds[yesIdx] && tokenIds[noIdx]) {
            yesTokenId = tokenIds[yesIdx];
            noTokenId = tokenIds[noIdx];
            yesOutcomeIdx = yesIdx;
            noOutcomeIdx = noIdx;
        }
    }

    const [yesBook, noBook] = await Promise.all([
        fetchCLOBBook(yesTokenId),
        fetchCLOBBook(noTokenId)
    ]);
    const yesMinOrderSize = parseMinOrderSize(yesBook);
    const noMinOrderSize = parseMinOrderSize(noBook);

    let yesPrice = yesBook?.bestAsk ?? yesBook?.buyPrice ?? yesBook?.midpoint ?? null;
    let noPrice = noBook?.bestAsk ?? noBook?.buyPrice ?? noBook?.midpoint ?? null;
    let priceSource = 'CLOB';

    // Fallback: use Gamma outcomePrices when CLOB book returns nothing
    if (yesPrice === null && noPrice === null) {
        const gammaPrices = safeParseJsonArray(market.outcomePrices);
        if (gammaPrices.length >= 2) {
            const gYes = parseFloat(gammaPrices[yesOutcomeIdx] ?? gammaPrices[0]);
            const gNo = parseFloat(gammaPrices[noOutcomeIdx] ?? gammaPrices[1]);
            if (Number.isFinite(gYes) && gYes > 0) yesPrice = gYes;
            if (Number.isFinite(gNo) && gNo > 0) noPrice = gNo;
            if (yesPrice !== null || noPrice !== null) priceSource = 'GAMMA_FALLBACK';
        }
    }

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
        yesBestBid: yesBook?.bestBid ?? null,
        yesBestAsk: yesBook?.bestAsk ?? null,
        noBestBid: noBook?.bestBid ?? null,
        noBestAsk: noBook?.bestAsk ?? null,
        yesTokenId,
        noTokenId,
        yesMinOrderSize,
        noMinOrderSize,
        priceSource,
        volume: market.volume ? parseFloat(market.volume) : 0,
        conditionId: market.conditionId,
        marketUrl: `https://polymarket.com/event/${slug}`,
        data: market
    };
}

async function discoverAllMarkets(nowSec, timeframes = null) {
    const results = {};
    const runtimeTimeframes = Array.isArray(timeframes) && timeframes.length > 0
        ? timeframes.filter(tf => tf && tf.enabled !== false)
        : getConfiguredTimeframes();

    const promises = [];
    for (const asset of CONFIG.ASSETS) {
        for (const tf of runtimeTimeframes) {
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
