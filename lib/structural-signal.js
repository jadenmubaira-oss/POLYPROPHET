const https = require('https');
const { computeEpoch } = require('./market-discovery');

const BINANCE_SYMBOLS = {
    BTC: 'BTCUSDT',
    ETH: 'ETHUSDT',
    SOL: 'SOLUSDT',
    XRP: 'XRPUSDT',
    BNB: 'BNBUSDT',
    DOGE: 'DOGEUSDT',
};

const cache = new Map();
const CACHE_TTL_MS = Number(process.env.STRUCTURAL_SIGNAL_CACHE_TTL_MS || 15000);
const MAX_SIGNAL_AGE_SEC = Number(process.env.STRUCTURAL_SIGNAL_MAX_AGE_SEC || 120);
const CLOSED_CANDLE_BUFFER_SEC = Number(process.env.STRUCTURAL_SIGNAL_CLOSED_CANDLE_BUFFER_SEC || 5);
const REQUIRE_CLOSED_CANDLE = String(process.env.STRUCTURAL_SIGNAL_REQUIRE_CLOSED_CANDLE || 'false').toLowerCase() === 'true';

function fetchJson(url, timeoutMs = 8000) {
    return new Promise((resolve, reject) => {
        const req = https.get(url, { timeout: timeoutMs }, (res) => {
            let body = '';
            res.setEncoding('utf8');
            res.on('data', (chunk) => { body += chunk; });
            res.on('end', () => {
                if (res.statusCode < 200 || res.statusCode >= 300) {
                    reject(new Error(`HTTP_${res.statusCode}`));
                    return;
                }
                try {
                    resolve(JSON.parse(body));
                } catch (error) {
                    reject(error);
                }
            });
        });
        req.on('timeout', () => req.destroy(new Error('STRUCTURAL_SIGNAL_TIMEOUT')));
        req.on('error', reject);
    });
}

function parseKline(row) {
    if (!Array.isArray(row)) return null;
    const openTimeMs = Number(row[0]);
    const open = Number(row[1]);
    const high = Number(row[2]);
    const low = Number(row[3]);
    const close = Number(row[4]);
    if (!Number.isFinite(openTimeMs) || !Number.isFinite(open) || !Number.isFinite(close)) return null;
    return {
        openTimeSec: Math.floor(openTimeMs / 1000),
        closeTimeSec: Math.floor(Number(row[6] || openTimeMs + 59999) / 1000),
        open,
        high,
        low,
        close,
    };
}

async function fetchRecentKlines(symbol, nowSec, lookbackMinutes = 300) {
    const endTime = Math.max(0, nowSec * 1000);
    const startTime = Math.max(0, endTime - (lookbackMinutes * 60 * 1000));
    const url = `https://api.binance.com/api/v3/klines?symbol=${encodeURIComponent(symbol)}&interval=1m&startTime=${startTime}&endTime=${endTime}&limit=500`;
    const rows = await fetchJson(url);
    return Array.isArray(rows) ? rows.map(parseKline).filter(Boolean) : [];
}

function findCycleOpen(klines, epoch) {
    return klines.find((row) => row.openTimeSec === epoch)
        || klines.filter((row) => row.openTimeSec <= epoch).sort((a, b) => b.openTimeSec - a.openTimeSec)[0]
        || null;
}

function findLatestClosed(klines, nowSec) {
    return klines
        .filter((row) => Number(row.closeTimeSec) <= nowSec - CLOSED_CANDLE_BUFFER_SEC)
        .sort((a, b) => b.openTimeSec - a.openTimeSec)[0]
        || null;
}

function findLatestUsable(klines, nowSec) {
    if (REQUIRE_CLOSED_CANDLE) return findLatestClosed(klines, nowSec);
    return klines
        .filter((row) => row.openTimeSec <= nowSec - 10)
        .sort((a, b) => b.openTimeSec - a.openTimeSec)[0]
        || null;
}

async function getStructuralSignal(asset, timeframe, nowSec = Math.floor(Date.now() / 1000)) {
    const assetKey = String(asset || '').toUpperCase();
    const symbol = BINANCE_SYMBOLS[assetKey];
    if (!symbol || !timeframe?.seconds) {
        return { ok: false, asset: assetKey, error: 'UNSUPPORTED_ASSET_OR_TIMEFRAME' };
    }
    const epoch = computeEpoch(nowSec, timeframe.seconds);
    const cacheKey = `${assetKey}:${timeframe.key}:${epoch}`;
    const cached = cache.get(cacheKey);
    if (cached && (Date.now() - cached.cachedAtMs) < CACHE_TTL_MS) return cached.value;

    try {
        const lookbackMinutes = Math.max(10, Math.ceil(timeframe.seconds / 60) + 5);
        const klines = await fetchRecentKlines(symbol, nowSec, lookbackMinutes);
        const open = findCycleOpen(klines, epoch);
        const latest = findLatestUsable(klines, nowSec);
        if (!open || !latest || !Number.isFinite(open.open) || open.open <= 0 || !Number.isFinite(latest.close)) {
            throw new Error('MISSING_BINANCE_KLINES');
        }
        const moveBps = ((latest.close - open.open) / open.open) * 10000;
        const dataAgeSec = Math.max(0, nowSec - (REQUIRE_CLOSED_CANDLE ? latest.closeTimeSec : latest.openTimeSec));
        const value = {
            ok: dataAgeSec <= MAX_SIGNAL_AGE_SEC,
            asset: assetKey,
            symbol,
            timeframe: timeframe.key,
            epoch,
            openPrice: open.open,
            latestPrice: latest.close,
            latestOpenTimeSec: latest.openTimeSec,
            dataAgeSec,
            requireClosedCandle: REQUIRE_CLOSED_CANDLE,
            moveBps,
            absMoveBps: Math.abs(moveBps),
            direction: moveBps >= 0 ? 'UP' : 'DOWN',
            error: dataAgeSec <= MAX_SIGNAL_AGE_SEC ? null : 'STRUCTURAL_SIGNAL_STALE',
        };
        cache.set(cacheKey, { cachedAtMs: Date.now(), value });
        return value;
    } catch (error) {
        const value = { ok: false, asset: assetKey, symbol, timeframe: timeframe.key, epoch, error: error.message };
        cache.set(cacheKey, { cachedAtMs: Date.now(), value });
        return value;
    }
}

async function getStructuralSignals(assets, timeframe, nowSec = Math.floor(Date.now() / 1000)) {
    const result = {};
    const pairs = await Promise.all((assets || []).map(async (asset) => [
        String(asset || '').toUpperCase(),
        await getStructuralSignal(asset, timeframe, nowSec),
    ]));
    for (const [asset, signal] of pairs) result[asset] = signal;
    return result;
}

module.exports = {
    getStructuralSignal,
    getStructuralSignals,
};