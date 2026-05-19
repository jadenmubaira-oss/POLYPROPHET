const CONFIG = require('./config');

function parseBool(value, fallback = false) {
  if (value === undefined || value === null || String(value).trim() === '') return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (['true', '1', 'yes', 'on'].includes(normalized)) return true;
  if (['false', '0', 'no', 'off'].includes(normalized)) return false;
  return fallback;
}

function safeJsonParse(raw, fallback = null) {
  try {
    const text = String(raw || '').replace(/^\uFEFF/, '').trim();
    if (!text) return fallback;
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

function clamp01(p) {
  const n = Number(p);
  if (!Number.isFinite(n)) return null;
  return Math.max(0, Math.min(1, n));
}

async function fetchJson(url, { timeoutMs = 20_000, headers = {} } = {}) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: ac.signal,
      headers: {
        'user-agent': 'polyprophet-hit-sleeve',
        ...headers,
      },
    });
    const text = await res.text();
    if (!res.ok) {
      const preview = text.slice(0, 200);
      const err = new Error(`HTTP_${res.status}`);
      err.httpStatus = res.status;
      err.bodyPreview = preview;
      err.url = url;
      throw err;
    }
    return safeJsonParse(text);
  } finally {
    clearTimeout(t);
  }
}

function safeJsonArray(v) {
  if (Array.isArray(v)) return v;
  return safeJsonParse(v, []);
}

function resolveTokenId(gammaMarket, side) {
  const outcomes = safeJsonArray(gammaMarket?.outcomes);
  const tokenIds = safeJsonArray(gammaMarket?.clobTokenIds);
  if (!outcomes.length || !tokenIds.length) return null;
  const normalizedSide = String(side || '').trim().toLowerCase();
  const idx = outcomes.findIndex(o => String(o).trim().toLowerCase() === normalizedSide);
  return tokenIds[idx >= 0 ? idx : 0] || null;
}

function normalizeBookLevels(levels) {
  const arr = Array.isArray(levels) ? levels : [];
  return arr
    .map(l => ({ price: Number(l?.price), size: Number(l?.size) }))
    .filter(l => Number.isFinite(l.price) && Number.isFinite(l.size));
}

function bestBid(levels) {
  const bids = normalizeBookLevels(levels);
  if (!bids.length) return null;
  return bids.reduce((a, b) => (b.price > a.price ? b : a));
}

function bestAsk(levels) {
  const asks = normalizeBookLevels(levels);
  if (!asks.length) return null;
  return asks.reduce((a, b) => (b.price < a.price ? b : a));
}

function depthAtOrBelowAsk(asks, maxPrice) {
  const levs = normalizeBookLevels(asks);
  const cap = Number(maxPrice);
  if (!Number.isFinite(cap)) return null;
  let shares = 0;
  let notional = 0;
  for (const l of levs) {
    if (l.price > cap) continue;
    shares += l.size;
    notional += l.size * l.price;
  }
  return {
    shares: Math.round(shares * 10_000) / 10_000,
    notional: Math.round(notional * 10_000) / 10_000,
  };
}

function loadHitSleeveOrders() {
  const enabled = parseBool(process.env.HIT_SLEEVE_ENABLED, false);
  const raw = process.env.HIT_SLEEVE_ORDERS_JSON;
  const orders = safeJsonParse(raw, []);
  const normalized = Array.isArray(orders)
    ? orders
      .map(o => ({
        slug: String(o?.slug || '').trim(),
        side: String(o?.side || '').trim().toUpperCase(),
        maxPrice: clamp01(o?.maxPrice),
        stakeFraction: clamp01(o?.stakeFraction),
      }))
      .filter(o => o.slug && (o.side === 'YES' || o.side === 'NO'))
    : [];

  return {
    enabled,
    orders: normalized,
    rawCount: Array.isArray(orders) ? orders.length : 0,
  };
}

async function fetchGammaMarketBySlug(slug) {
  const url = `${CONFIG.GAMMA_API}/markets/slug/${encodeURIComponent(slug)}`;
  return fetchJson(url, { timeoutMs: 20_000 });
}

async function fetchClobBook(tokenId) {
  const url = `${CONFIG.CLOB_API}/book?token_id=${encodeURIComponent(tokenId)}`;
  return fetchJson(url, { timeoutMs: 20_000 });
}

module.exports = {
  loadHitSleeveOrders,
  fetchGammaMarketBySlug,
  fetchClobBook,
  resolveTokenId,
  bestBid,
  bestAsk,
  depthAtOrBelowAsk,
};
