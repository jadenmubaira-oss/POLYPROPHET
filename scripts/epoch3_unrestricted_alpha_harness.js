/**
 * EPOCH 3 UNRESTRICTED ALPHA MINING HARNESS
 * 
 * This script goes beyond the previous 29-family investigation by:
 * 1. Massively expanding the strategy search space
 * 2. Using aggressive compounding simulation parameters
 * 3. Implementing ensemble/stacking across multiple signals
 * 4. Multi-timeframe signal combination (15m + 5m)
 * 5. Tiered aggressive bankroll sizing for micro-bankroll escape
 * 6. Relaxed training gates to find more signals, validated via holdout
 * 7. Combined-signal confidence boosting
 */

const fs = require('fs');
const path = require('path');
const {
  calcPolymarketTakerFeeUsd,
  getMaxAffordableSharesForEntry,
  getPolymarketTakerFeeModel,
  calcBinaryEvRoiAfterFees,
  calcPolymarketTakerFeeUsdPerShare,
} = require('../lib/polymarket-fees');

const ROOT = path.join(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'epoch3', 'unrestricted');
const EPS = 1e-9;
const ASSET_RANK = { BTC: 0, ETH: 1, SOL: 2, XRP: 3, BNB: 4, DOGE: 5, HYPE: 6 };

function ensureDir(dir) { fs.mkdirSync(dir, { recursive: true }); }
function readJson(p) { return JSON.parse(fs.readFileSync(path.join(ROOT, p), 'utf8')); }
function writeJson(name, val) { fs.writeFileSync(path.join(OUT_DIR, name), JSON.stringify(val, null, 2)); }
function writeText(name, val) { fs.writeFileSync(path.join(OUT_DIR, name), val); }
function toNum(v, fb = null) { const p = Number(v); return Number.isFinite(p) ? p : fb; }
function iso(e) { return Number.isFinite(Number(e)) ? new Date(Number(e) * 1000).toISOString() : null; }
function dayKey(e) { const v = Number(e); return Number.isFinite(v) ? new Date(v * 1000).toISOString().slice(0, 10) : null; }

function stableHash(value) {
  const str = String(value);
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0) / 4294967296;
}

function quantile(values, p) {
  const f = values.filter(v => Number.isFinite(Number(v))).map(Number).sort((a, b) => a - b);
  if (!f.length) return 0;
  return f[Math.min(f.length - 1, Math.floor(p * f.length))];
}

function wilsonLCB(wins, n, z = 1.96) {
  const w = Number(wins), total = Number(n);
  if (!(total > 0)) return 0;
  const phat = w / total, z2 = z * z, den = 1 + z2 / total;
  const center = phat + z2 / (2 * total);
  const adj = z * Math.sqrt((phat * (1 - phat) + z2 / (4 * total)) / total);
  return Math.max(0, Math.min(1, (center - adj) / den));
}

function estimateNetEdgeRoi(entryPrice, pWin, settings) {
  const entry = Number(entryPrice), p = Number(pWin);
  if (!(entry > 0) || entry >= 1 || !(p > 0) || p >= 1) return null;
  return calcBinaryEvRoiAfterFees(p, entry, { slippagePct: settings.slippagePct, feeModel: settings.feeModel });
}

function loadCycles(relPath) {
  const raw = readJson(relPath);
  const cycles = Array.isArray(raw) ? raw : raw.cycles || raw.data || [];
  return cycles.filter(c => Number.isFinite(Number(c.epoch)))
    .map(c => ({ ...c, sourcePath: relPath, timeframe: c.timeframe || raw.timeframe || null }))
    .sort((a, b) => Number(a.epoch) - Number(b.epoch));
}

function sidePrices(cycle, dir) { return dir === 'UP' ? cycle.minutePricesYes : cycle.minutePricesNo; }
function oppositePrices(cycle, dir) { return dir === 'UP' ? cycle.minutePricesNo : cycle.minutePricesYes; }
function priceAt(cycle, dir, min) { const p = sidePrices(cycle, dir); return toNum(p?.[String(min)]?.last ?? p?.[min]?.last, null); }
function oppPriceAt(cycle, dir, min) { const p = oppositePrices(cycle, dir); return toNum(p?.[String(min)]?.last ?? p?.[min]?.last, null); }
function countAt(cycle, dir, min) { const p = sidePrices(cycle, dir); return Math.max(0, Math.floor(toNum(p?.[String(min)]?.count ?? p?.[min]?.count, 0))); }
function oppCountAt(cycle, dir, min) { const p = oppositePrices(cycle, dir); return Math.max(0, Math.floor(toNum(p?.[String(min)]?.count ?? p?.[min]?.count, 0))); }

function observedRange(cycle, dir, min) {
  const vals = [];
  for (let m = 0; m <= min; m++) { const p = priceAt(cycle, dir, m); if (Number.isFinite(p)) vals.push(p); }
  return vals.length < 2 ? 0 : Math.max(...vals) - Math.min(...vals);
}

// ==================== AGGRESSIVE SIMULATION SETTINGS ====================
function aggressiveSimSettings(overrides = {}) {
  return {
    minOrderShares: 5,
    // AGGRESSIVE: tiered stake fraction - starts high for micro-bankroll
    stakeFraction: 0.40,        // was 0.30
    kellyFraction: 0.35,        // was 0.25
    kellyMaxFraction: 0.55,     // was 0.45
    kellyMinPWin: 0.52,         // was 0.55
    slippagePct: 0.01,
    peakDrawdownBrakePct: 0.30, // was 0.20 - wider drawdown tolerance
    peakDrawdownBrakeMinBankroll: 30, // was 20 - let micro-bankroll run
    peakDrawdownBrakeStakeFraction: 0.15,
    maxConsecutiveLosses: 4,    // was 2 - more resilient
    cooldownSeconds: 600,       // was 1800 - shorter cooldown
    globalStopLoss: 0.35,       // was 0.20 - wider daily stop
    microBankrollThreshold: 20,
    minBalanceFloor: 0,
    maxAbsoluteStakeSmall: 100000,
    maxAbsoluteStakeMedium: 100000,
    maxAbsoluteStakeLarge: 100000,
    feeModel: getPolymarketTakerFeeModel(),
    hardEntryPriceCap: 0.78,    // was 0.82 - tighter to avoid high-price trap
    minNetEdgeRoi: 0.005,       // was 0.01 - slightly more permissive
    enforceNetEdgeGate: true,
    enforceHighPriceEdgeFloor: true,
    highPriceEdgeFloorPrice: 0.78,
    highPriceEdgeFloorMinRoi: 0.015,
    preResolutionExitEnabled: true,
    preResolutionMinBid: 0.94,  // slightly lower threshold to capture more exits
    preResolutionExitSeconds: 150, // wider window
    cycleSeconds: 900,
    assetRank: ASSET_RANK,
    ...overrides,
  };
}

// Tiered stake sizing for micro-bankroll escape
function tieredStakeFraction(bankroll) {
  if (bankroll < 6) return 0.65;     // extreme escape: bet big or bust
  if (bankroll < 10) return 0.55;    // ultra-aggressive escape zone
  if (bankroll < 18) return 0.45;    // aggressive growth
  if (bankroll < 35) return 0.38;    // moderate aggression
  if (bankroll < 75) return 0.32;    // standard aggressive
  if (bankroll < 200) return 0.26;   // normal Kelly
  if (bankroll < 500) return 0.22;   // moderate preservation
  return 0.18;                        // capital preservation
}

// ==================== EDGE GUARDS ====================
function passesEdgeGuards(entryPrice, pWin, settings) {
  const netEdge = estimateNetEdgeRoi(entryPrice, pWin, settings);
  if (settings.enforceNetEdgeGate && (!Number.isFinite(netEdge) || netEdge < settings.minNetEdgeRoi)) return false;
  if (settings.enforceHighPriceEdgeFloor && Number(entryPrice) >= settings.highPriceEdgeFloorPrice &&
      (!Number.isFinite(netEdge) || netEdge < settings.highPriceEdgeFloorMinRoi)) return false;
  return true;
}

// ==================== MICROSTRUCTURE FILTERS ====================
function passesBaseMicro(cycle, dir, min, price, cfg, settings) {
  const opp = oppPriceAt(cycle, dir, min);
  const cnt = countAt(cycle, dir, min);
  const oCnt = oppCountAt(cycle, dir, min);
  if (!(price > 0) || price >= 1) return false;
  if (cfg.requirePrints && !(cnt > 0)) return false;
  if (cfg.requireOpposite && !(opp > 0)) return false;
  if (cfg.requireOppositePrint && !(oCnt > 0)) return false;
  if (cfg.maxSpreadDeviation !== null && cfg.maxSpreadDeviation !== undefined && opp > 0 && Math.abs(price + opp - 1) > cfg.maxSpreadDeviation) return false;
  if (settings.hardEntryPriceCap > 0 && price > settings.hardEntryPriceCap) return false;
  return true;
}

// Extended filter set
function passesFilter(cycle, dir, min, price, cfg, settings) {
  if (!cfg.filter) return true;
  
  if (cfg.filter === 'pre_exit_seen') {
    return !!findPreResExit(cycle, dir, settings, Number(cycle.epoch) + min * 60);
  }
  if (cfg.filter === 'print_imbalance') {
    const c = countAt(cycle, dir, min), o = oppCountAt(cycle, dir, min);
    return c >= Math.max(2, o * 2);
  }
  if (cfg.filter === 'early_breakout') {
    if (min < 1) return false;
    const prev = priceAt(cycle, dir, min - 1), start = priceAt(cycle, dir, 0);
    return prev > 0 && start > 0 && price - start >= 0.04 && price - prev >= 0.005;
  }
  if (cfg.filter === 'late_inversion_low_side') {
    const expOpp = oppPriceAt(cycle, dir, min);
    return expOpp >= 0.75 && price <= 0.32;
  }
  if (cfg.filter === 'one_minute_momentum') {
    if (min < 1) return false;
    const prev = priceAt(cycle, dir, min - 1);
    return prev > 0 && price - prev >= 0.015;
  }
  if (cfg.filter === 'multi_minute_momentum') {
    if (min < 2) return false;
    const prev = priceAt(cycle, dir, min - 1), prev2 = priceAt(cycle, dir, min - 2);
    return prev2 > 0 && prev > 0 && prev > prev2 && price > prev && price - prev2 >= 0.035;
  }
  if (cfg.filter === 'opposite_early_breakout_fade') {
    if (min < 2) return false;
    const oNow = oppPriceAt(cycle, dir, min), oPrev = oppPriceAt(cycle, dir, min - 1), oStart = oppPriceAt(cycle, dir, 0);
    return oStart > 0 && oPrev > 0 && oNow > oPrev && oNow - oStart >= 0.05 && price <= 0.45;
  }
  if (cfg.filter === 'open_reversal') {
    const open = priceAt(cycle, dir, 0);
    return open > 0 && open - price >= 0.08 && price <= 0.45;
  }
  if (cfg.filter === 'early_realized_volatility') {
    return observedRange(cycle, dir, min) >= 0.10;
  }
  // NEW FILTERS for expanded search
  if (cfg.filter === 'strong_momentum_2min') {
    if (min < 2) return false;
    const prev = priceAt(cycle, dir, min - 1), prev2 = priceAt(cycle, dir, min - 2);
    return prev2 > 0 && prev > 0 && price > prev && prev > prev2 && price - prev2 >= 0.025;
  }
  if (cfg.filter === 'volume_surge') {
    const c = countAt(cycle, dir, min);
    return c >= 4; // high print count = real volume
  }
  if (cfg.filter === 'tight_spread_momentum') {
    if (min < 1) return false;
    const opp = oppPriceAt(cycle, dir, min);
    const prev = priceAt(cycle, dir, min - 1);
    return opp > 0 && Math.abs(price + opp - 1) <= 0.03 && prev > 0 && price >= prev;
  }
  if (cfg.filter === 'reversal_from_cheap') {
    if (min < 2) return false;
    const start = priceAt(cycle, dir, 0);
    const mid = priceAt(cycle, dir, Math.max(1, min - 1));
    return start > 0 && mid > 0 && start < 0.45 && price > mid && price - mid >= 0.02;
  }
  return true;
}

function findPreResExit(cycle, dir, settings, earliestTs = -Infinity) {
  if (!settings.preResolutionExitEnabled) return null;
  const prices = sidePrices(cycle, dir);
  if (!prices || typeof prices !== 'object') return null;
  const snaps = Object.entries(prices)
    .map(([mk, s]) => ({ minute: Number(mk), price: toNum(s?.last, null), timestamp: toNum(s?.ts, Number(cycle.epoch) + Number(mk) * 60) }))
    .filter(s => Number.isFinite(s.minute) && s.price > 0 && s.price < 1)
    .sort((a, b) => a.timestamp - b.timestamp);
  for (const s of snaps) {
    if (s.timestamp <= earliestTs) continue;
    const remaining = Number(cycle.epoch) + settings.cycleSeconds - s.timestamp;
    if (remaining <= 0 || remaining > settings.preResolutionExitSeconds) continue;
    if (s.price + EPS < settings.preResolutionMinBid) continue;
    return { minute: s.minute, timestamp: s.timestamp, exitPrice: s.price, remaining };
  }
  return null;
}

// ==================== DYNAMIC DIRECTION HELPERS ====================
function previousCycleByAsset(cycles, cs) {
  const m = new Map();
  for (const c of cycles) m.set(`${c.asset}|${c.epoch}`, c);
  return (c) => m.get(`${c.asset}|${Number(c.epoch) - cs}`) || null;
}

function majorityPrevByEpoch(cycles, cs) {
  const m = new Map();
  for (const c of cycles) { const a = m.get(Number(c.epoch)) || []; a.push(c); m.set(Number(c.epoch), a); }
  return (c) => {
    const prev = m.get(Number(c.epoch) - cs) || [];
    const up = prev.filter(x => x.resolution === 'UP').length;
    const dn = prev.filter(x => x.resolution === 'DOWN').length;
    if (up > dn) return 'UP'; if (dn > up) return 'DOWN'; return null;
  };
}

function byAssetEpochMap(cycles) {
  const m = new Map();
  for (const c of cycles) m.set(`${String(c.asset || '').toUpperCase()}|${Number(c.epoch)}`, c);
  return m;
}

function prevCompletedByAsset(cycles, cs) {
  const grouped = new Map();
  for (const c of cycles) {
    const a = String(c.asset || '').toUpperCase();
    if (!grouped.has(a)) grouped.set(a, []);
    grouped.get(a).push(c);
  }
  for (const v of grouped.values()) v.sort((a, b) => Number(a.epoch) - Number(b.epoch));
  return (c) => {
    const vals = grouped.get(String(c.asset || '').toUpperCase()) || [];
    const cutoff = Number(c.epoch) - Number(cs || 0);
    let lo = 0, hi = vals.length - 1, found = null;
    while (lo <= hi) {
      const mid = Math.floor((lo + hi) / 2);
      if (Number(vals[mid].epoch) <= cutoff) { found = vals[mid]; lo = mid + 1; }
      else hi = mid - 1;
    }
    return found;
  };
}

function sameDirectionStreak(cycle, helpers, length) {
  let cursor = cycle, direction = null;
  for (let i = 0; i < length; i++) {
    cursor = helpers.prevByAsset(cursor);
    const res = String(cursor?.resolution || '').toUpperCase();
    if (res !== 'UP' && res !== 'DOWN') return null;
    if (!direction) direction = res;
    if (res !== direction) return null;
  }
  return direction;
}

function oppRes(r) { return r === 'UP' ? 'DOWN' : r === 'DOWN' ? 'UP' : null; }

function buildHelpers(cycles, settings, ctx = {}) {
  return {
    prevByAsset: previousCycleByAsset(cycles, settings.cycleSeconds),
    prevMajority: majorityPrevByEpoch(cycles, settings.cycleSeconds),
    byAssetEpoch: byAssetEpochMap(cycles),
    prevCompleted4h: prevCompletedByAsset(ctx.cycles4 || [], 14400),
    cycleSeconds: settings.cycleSeconds,
  };
}

function dynamicDir(cycle, cfg, helpers, params = {}) {
  if (cfg.dynamic === 'streak_fade') {
    const p1 = helpers.prevByAsset(cycle);
    if (!p1) return null;
    const p2 = helpers.prevByAsset(p1);
    if (!p2) return null;
    if (p1.resolution === p2.resolution && (p1.resolution === 'UP' || p1.resolution === 'DOWN'))
      return oppRes(p1.resolution);
  }
  if (cfg.dynamic === 'streak_follow3' || cfg.dynamic === 'streak_fade3') {
    const dir = sameDirectionStreak(cycle, helpers, 3);
    if (!dir) return null;
    return cfg.dynamic === 'streak_follow3' ? dir : oppRes(dir);
  }
  if (cfg.dynamic === 'cross_asset_leader_follow' || cfg.dynamic === 'cross_asset_leader_fade') {
    const la = String(params.leaderAsset || '').toUpperCase();
    const lag = Math.max(1, Math.floor(toNum(params.lagCycles, 1)));
    if (!la) return null;
    const leader = helpers.byAssetEpoch.get(`${la}|${Number(cycle.epoch) - lag * Number(helpers.cycleSeconds)}`);
    const res = String(leader?.resolution || '').toUpperCase();
    if (res !== 'UP' && res !== 'DOWN') return null;
    return cfg.dynamic === 'cross_asset_leader_follow' ? res : oppRes(res);
  }
  if (cfg.dynamic === 'previous_4h_bias_follow' || cfg.dynamic === 'previous_4h_bias_fade') {
    const prev4 = helpers.prevCompleted4h(cycle);
    const res = String(prev4?.resolution || '').toUpperCase();
    if (res !== 'UP' && res !== 'DOWN') return null;
    return cfg.dynamic === 'previous_4h_bias_follow' ? res : oppRes(res);
  }
  if (cfg.dynamic === 'cross_asset_prev_majority') return helpers.prevMajority(cycle);
  // NEW: alternating pattern
  if (cfg.dynamic === 'alternating') {
    const p1 = helpers.prevByAsset(cycle);
    if (!p1) return null;
    return oppRes(String(p1.resolution || '').toUpperCase());
  }
  return null;
}

// ==================== CANDIDATE SELECTION ====================
function makeStaticParams(cfg) {
  const params = [];
  for (const h of cfg.hours)
    for (const m of cfg.minutes)
      for (const d of cfg.directions)
        for (const [pMin, pMax] of cfg.bands)
          params.push({ hour: h, minute: m, direction: d, priceMin: pMin, priceMax: pMax, filter: cfg.filter || null, asset: cfg.asset || 'ALL' });
  return params;
}

function candidateKey(id, p) {
  return [id, p.asset || 'ALL', p.leaderAsset || 'NL', p.lagCycles ?? 'NL', p.hour ?? 'ALL', p.minute ?? 'DYN', p.direction || 'DYN', p.priceMin, p.priceMax, p.filter || 'none'].join('|');
}

function collectStats(cycles, cfg, settings, ctx = {}) {
  const stats = new Map();
  const helpers = buildHelpers(cycles, settings, ctx);
  const paramsList = cfg.dynamic ? cfg.dynamicParams : makeStaticParams(cfg);
  for (const cycle of cycles) {
    const epoch = Number(cycle.epoch);
    const res = String(cycle.resolution || '').toUpperCase();
    if (res !== 'UP' && res !== 'DOWN') continue;
    const hour = new Date(epoch * 1000).getUTCHours();
    const day = dayKey(epoch);
    for (const params of paramsList) {
      const ar = String(params.asset || cfg.asset || 'ALL').toUpperCase();
      if (ar !== 'ALL' && String(cycle.asset || '').toUpperCase() !== ar) continue;
      const ep = { ...params, asset: ar };
      if (params.hour !== -1 && params.hour !== hour) continue;
      const dir = cfg.dynamic ? dynamicDir(cycle, cfg, helpers, ep) : params.direction;
      if (dir !== 'UP' && dir !== 'DOWN') continue;
      const price = priceAt(cycle, dir, params.minute);
      if (!(price >= params.priceMin && price <= params.priceMax)) continue;
      if (!passesBaseMicro(cycle, dir, params.minute, price, cfg, settings)) continue;
      if (!passesFilter(cycle, dir, params.minute, price, cfg, settings)) continue;
      const preExit = findPreResExit(cycle, dir, settings, epoch + params.minute * 60);
      const key = candidateKey(cfg.id, { ...ep, direction: dir, filter: cfg.filter || cfg.dynamic || null });
      let s = stats.get(key);
      if (!s) { s = { n: 0, w: 0, sumEntry: 0, days: new Set(), zeroPrints: 0, preExit: 0, params: { ...ep, direction: dir, filter: cfg.filter || cfg.dynamic || null } }; stats.set(key, s); }
      s.n++; if (res === dir) s.w++; s.sumEntry += price; s.days.add(day);
      if (countAt(cycle, dir, params.minute) === 0) s.zeroPrints++;
      if (preExit) s.preExit++;
    }
  }
  return stats;
}

function summarizeCand(stats, settings) {
  const wr = stats.n ? stats.w / stats.n : 0;
  const lcb = wilsonLCB(stats.w, stats.n);
  const avgEntry = stats.n ? stats.sumEntry / stats.n : 0;
  const evRoi = estimateNetEdgeRoi(avgEntry, lcb, settings);
  return { matches: stats.n, wins: stats.w, losses: stats.n - stats.w, winRate: wr, lcb, avgEntry, dayCount: stats.days.size, noPrintFrac: stats.n ? stats.zeroPrints / stats.n : 0, preExitFrac: stats.n ? stats.preExit / stats.n : 0, evRoi };
}

function selectCandidates(trainCycles, holdoutCycles, cfg, baseSettings, ctx = {}) {
  const settings = aggressiveSimSettings({ ...baseSettings, cycleSeconds: cfg.cycleSeconds });
  const trainStats = collectStats(trainCycles, cfg, settings, ctx);
  const holdStats = collectStats(holdoutCycles, cfg, settings, ctx);
  const rows = [];
  for (const [key, raw] of trainStats.entries()) {
    const train = summarizeCand(raw, settings);
    if (train.matches < cfg.minTrainMatches) continue;
    if (train.dayCount < cfg.minTrainDays) continue;
    if (train.lcb < cfg.minTrainLcb) continue;
    if (!Number.isFinite(train.evRoi) || train.evRoi < cfg.minTrainEvRoi) continue;
    if (train.noPrintFrac > cfg.maxNoPrintFrac) continue;
    const holdRaw = holdStats.get(key);
    const holdout = holdRaw ? summarizeCand(holdRaw, settings) : null;
    rows.push({
      key, params: raw.params, train, holdout,
      score: train.evRoi + train.lcb + Math.min(0.15, train.matches / 400) + Math.min(0.05, train.preExitFrac * 0.05),
    });
  }
  rows.sort((a, b) => b.score - a.score || b.train.matches - a.train.matches);
  const selected = [];
  const perHour = new Map();
  for (const r of rows) {
    const hk = r.params.hour;
    const cnt = perHour.get(hk) || 0;
    if (cnt >= cfg.maxPerHour) continue;
    selected.push(r);
    perHour.set(hk, cnt + 1);
    if (selected.length >= cfg.maxSelected) break;
  }
  return { candidates: rows, selected };
}

// ==================== EVENT BUILDING ====================
function buildEvents(cycles, cfg, selected, baseSettings, ctx = {}) {
  const settings = aggressiveSimSettings({ ...baseSettings, cycleSeconds: cfg.cycleSeconds });
  const helpers = buildHelpers(cycles, settings, ctx);
  const rules = selected.map(r => ({ ...r, pWinEstimate: r.train.lcb }));
  const buckets = new Map();
  for (const cycle of cycles) {
    const epoch = Number(cycle.epoch);
    const res = String(cycle.resolution || '').toUpperCase();
    if (res !== 'UP' && res !== 'DOWN') continue;
    const hour = new Date(epoch * 1000).getUTCHours();
    for (const rule of rules) {
      const p = rule.params;
      const ar = String(p.asset || cfg.asset || 'ALL').toUpperCase();
      if (ar !== 'ALL' && String(cycle.asset || '').toUpperCase() !== ar) continue;
      if (p.hour !== -1 && p.hour !== hour) continue;
      const dir = cfg.dynamic ? dynamicDir(cycle, cfg, helpers, p) : p.direction;
      if (dir !== 'UP' && dir !== 'DOWN') continue;
      const min = p.minute;
      const sigPrice = priceAt(cycle, dir, min);
      if (!(sigPrice >= p.priceMin && sigPrice <= p.priceMax)) continue;
      if (!passesBaseMicro(cycle, dir, min, sigPrice, cfg, settings)) continue;
      if (!passesFilter(cycle, dir, min, sigPrice, cfg, settings)) continue;
      if (!passesEdgeGuards(sigPrice, rule.pWinEstimate, settings)) continue;
      const minShares = Math.max(5, Math.ceil(toNum(cycle.orderMinSize ?? cycle.yesMinOrderSize ?? cycle.noMinOrderSize, 5)));
      const ts = epoch + min * 60;
      const ev = {
        epoch, minute: min, timestamp: ts, asset: cycle.asset, timeframe: cfg.timeframe,
        direction: dir, signalEntryPrice: sigPrice, orderPrice: sigPrice,
        oppositePrice: oppPriceAt(cycle, dir, min),
        pWinEstimate: rule.pWinEstimate, resolutionWon: res === dir,
        strategy: `${cfg.id}:${rule.key}`, tier: cfg.id, minOrderShares: minShares,
        preResolutionExit: findPreResExit(cycle, dir, settings, ts),
        noFillHash: stableHash(`${cfg.id}|${epoch}|${cycle.asset}|${min}|${dir}`),
        packetHash: stableHash(`packet|${cfg.id}|${epoch}|${cycle.asset}|${min}|${dir}`),
        netEdgeRoi: estimateNetEdgeRoi(sigPrice, rule.pWinEstimate, settings),
        printCount: countAt(cycle, dir, min), oppositePrintCount: oppCountAt(cycle, dir, min),
        params: p, sourcePath: cycle.sourcePath,
      };
      if (!buckets.has(`${cfg.id}|${epoch}`)) buckets.set(`${cfg.id}|${epoch}`, []);
      buckets.get(`${cfg.id}|${epoch}`).push(ev);
    }
  }
  const events = [];
  for (const [, sigs] of [...buckets.entries()].sort((a, b) => Number(a[1][0].timestamp) - Number(b[1][0].timestamp))) {
    sigs.sort((a, b) => { if (a.minute !== b.minute) return a.minute - b.minute; return b.pWinEstimate - a.pWinEstimate; });
    events.push({ ...sigs[0], signalsInCycle: sigs.length });
  }
  return events.sort((a, b) => a.timestamp - b.timestamp);
}

// ==================== REPRICING & FRICTION ====================
function repriceEvent(ev, cycle, cfg, settings, friction) {
  const shift = Math.max(0, Math.floor(toNum(friction.latencyShiftMinutes, 0)));
  const dMin = Number(ev.minute) + shift;
  if (dMin < 0 || dMin >= Math.ceil(settings.cycleSeconds / 60)) return { rejected: true, reason: 'LATENCY_PAST_CYCLE' };
  let actualPrice = priceAt(cycle, ev.direction, dMin);
  if (!(actualPrice > 0) || actualPrice >= 1) return { rejected: true, reason: 'MISSING_REPRICED' };
  if (!passesBaseMicro(cycle, ev.direction, dMin, actualPrice, cfg, settings)) return { rejected: true, reason: 'REPRICED_MICRO_REJECT' };
  if (!passesEdgeGuards(actualPrice, ev.pWinEstimate, settings)) return { rejected: true, reason: 'REPRICED_EDGE_REJECT' };
  const adverse = Number(friction.adverseFillCents || 0) / 100;
  if (adverse > 0) actualPrice += adverse;
  actualPrice = Math.min(0.999, Math.max(0.001, actualPrice));
  if (settings.hardEntryPriceCap > 0 && actualPrice > settings.hardEntryPriceCap) return { rejected: true, reason: 'REPRICED_CAP_REJECT' };
  if (!passesEdgeGuards(actualPrice, ev.pWinEstimate, settings)) return { rejected: true, reason: 'REPRICED_ADV_EDGE_REJECT' };
  return {
    ...ev, originalMinute: ev.minute, minute: dMin,
    timestamp: Number(ev.epoch) + dMin * 60,
    latencyShifted: shift > 0, signalEntryPrice: actualPrice, orderPrice: actualPrice,
    oppositePrice: oppPriceAt(cycle, ev.direction, dMin),
    preResolutionExit: findPreResExit(cycle, ev.direction, settings, Number(ev.epoch) + dMin * 60),
    netEdgeRoi: estimateNetEdgeRoi(actualPrice, ev.pWinEstimate, settings),
  };
}

function prepareEvents(events, cfg, settings, friction, cycleLookup) {
  const prepared = [], rejects = {};
  for (const ev of events) {
    const cycle = cycleLookup.get(`${ev.sourcePath}|${ev.asset}|${ev.epoch}`);
    if (!cycle) { rejects.MISSING_CYCLE = (rejects.MISSING_CYCLE || 0) + 1; continue; }
    const r = repriceEvent(ev, cycle, cfg, settings, friction);
    if (r.rejected) { rejects[r.reason] = (rejects[r.reason] || 0) + 1; continue; }
    prepared.push(r);
  }
  return { events: prepared.sort((a, b) => a.timestamp - b.timestamp), rejects };
}

// ==================== SIMULATION WITH TIERED SIZING ====================
function computeTradeOpen(cash, peak, event, settings) {
  const entry = Number(event.orderPrice || event.signalEntryPrice);
  if (!(entry > 0) || entry >= 1 || cash <= 0) return { blocked: true, reason: 'INVALID' };
  
  // TIERED stake fraction based on current bankroll
  const sf = tieredStakeFraction(cash);
  let size = cash * sf;
  
  // Kelly adjustment
  const pWin = event.pWinEstimate || 0.5;
  if (pWin >= settings.kellyMinPWin && entry > 0 && entry < 1) {
    const b = (1 / entry) - 1;
    if (b > 0) {
      const fullKelly = (b * pWin - (1 - pWin)) / b;
      if (fullKelly > 0) {
        const kellySize = cash * Math.min(fullKelly * settings.kellyFraction, settings.kellyMaxFraction);
        if (kellySize < size) size = kellySize;
      }
    }
  }
  
  // Peak drawdown brake
  if (cash >= settings.peakDrawdownBrakeMinBankroll && peak > 0) {
    const dd = (peak - cash) / peak;
    if (dd >= settings.peakDrawdownBrakePct) {
      size = Math.min(size, cash * settings.peakDrawdownBrakeStakeFraction);
    }
  }
  
  size = Math.min(size, cash);
  
  const feePerShare = calcPolymarketTakerFeeUsdPerShare(entry, settings.feeModel);
  const costPerShare = entry + feePerShare;
  if (costPerShare <= 0) return { blocked: true, reason: 'ZERO_COST' };
  let shares = Math.floor(size / costPerShare + 1e-9);
  shares = Math.max(0, shares);
  const minShares = Math.max(settings.minOrderShares, Number(event.minOrderShares) || 5);
  
  if (shares < minShares) {
    // Try to afford minimum
    const minCost = minShares * costPerShare;
    if (cash >= minCost) { shares = minShares; }
    else return { blocked: true, reason: 'BELOW_MIN' };
  }
  
  const totalCost = shares * costPerShare;
  if (totalCost > cash + EPS) return { blocked: true, reason: 'EXCEEDS_CASH' };
  
  return { blocked: false, shares, entryPrice: entry, entryDebit: totalCost, feePerShare, pWinEstimate: pWin };
}

function computeTradeClose(open, event, settings) {
  const shares = open.shares;
  const entry = open.entryPrice;
  
  // Check pre-resolution exit
  if (event.preResolutionExit && settings.preResolutionExitEnabled) {
    const exitPrice = event.preResolutionExit.exitPrice;
    const exitFee = calcPolymarketTakerFeeUsdPerShare(exitPrice, settings.feeModel) * shares;
    const payout = shares * exitPrice - exitFee;
    const pnl = payout - open.entryDebit;
    return { reason: 'PRE_RESOLUTION_EXIT', payout: Math.max(0, payout), pnl, closeTimestamp: event.preResolutionExit.timestamp };
  }
  
  // Resolution
  if (event.resolutionWon) {
    const payout = shares; // $1 per share on win
    const pnl = payout - open.entryDebit;
    return { reason: 'RESOLVED_WIN', payout, pnl, closeTimestamp: Number(event.epoch) + settings.cycleSeconds };
  } else {
    return { reason: 'RESOLVED_LOSS', payout: 0, pnl: -open.entryDebit, closeTimestamp: Number(event.epoch) + settings.cycleSeconds };
  }
}

function computeTradabilityFloor(events, settings) {
  let minCost = Infinity;
  for (const ev of events) {
    const entry = Number(ev.orderPrice || ev.signalEntryPrice);
    if (!(entry > 0) || entry >= 1) continue;
    const feePerShare = calcPolymarketTakerFeeUsdPerShare(entry, settings.feeModel);
    const minShares = Math.max(settings.minOrderShares, Number(ev.minOrderShares) || 5);
    const cost = minShares * (entry + feePerShare);
    if (cost < minCost) minCost = cost;
  }
  return Number.isFinite(minCost) ? minCost : 3;
}

function simSequence(events, cfg, startBank, baseSettings, friction, cycleLookup, prepRejects = null) {
  const settings = aggressiveSimSettings({ ...baseSettings, cycleSeconds: cfg.cycleSeconds });
  const prepared = prepRejects !== null
    ? { events, rejects: prepRejects }
    : prepareEvents(events, cfg, settings, friction, cycleLookup);
  const adj = prepared.events;
  const tradFloor = computeTradabilityFloor(adj, settings);
  let cash = startBank, peak = startBank, maxDD = 0;
  let cooldownUntil = -Infinity, consLosses = 0;
  let trades = 0, wins = 0, losses = 0, preExits = 0, blocked = 0, noFills = 0, packets = 0, stopSkips = 0;
  let currentDay = null, dayStart = startBank, todayPnL = 0, dayStopped = false;
  const pendingReleases = [];
  
  for (const ev of adj) {
    const ts = Number(ev.timestamp || ev.epoch || 0);
    pendingReleases.sort((a, b) => a.timestamp - b.timestamp);
    while (pendingReleases.length && pendingReleases[0].timestamp <= ts) cash += pendingReleases.shift().amount;
    
    const cd = dayKey(ts);
    if (cd !== currentDay) { currentDay = cd; dayStart = cash; todayPnL = 0; dayStopped = false; }
    
    if (!dayStopped && settings.globalStopLoss > 0 && dayStart > 0) {
      const loss = Math.max(0, -todayPnL, dayStart - cash);
      if (loss + EPS >= dayStart * settings.globalStopLoss) dayStopped = true;
    }
    if (dayStopped) { stopSkips++; continue; }
    if (ts < cooldownUntil) continue;
    if (ev.packetHash < Number(friction.packetDropRate || 0)) { packets++; continue; }
    if (ev.noFillHash < Number(friction.noFillRate || 0)) { noFills++; continue; }
    
    const openTrade = computeTradeOpen(cash, peak, ev, settings);
    if (openTrade.blocked) { blocked++; if (cash < 1.0) break; continue; }
    
    cash -= openTrade.entryDebit;
    const closeTrade = computeTradeClose(openTrade, ev, settings);
    let pnl = closeTrade.pnl;
    if (closeTrade.reason === 'RESOLVED_WIN' && Number(friction.redemptionGasUsd || 0) > 0) pnl -= Number(friction.redemptionGasUsd);
    if (closeTrade.reason === 'RESOLVED_WIN' && Number(friction.lockupWinSeconds || 0) > 0) {
      const payout = Math.max(0, closeTrade.payout - Number(friction.redemptionGasUsd || 0));
      pendingReleases.push({ timestamp: closeTrade.closeTimestamp + Number(friction.lockupWinSeconds), amount: payout });
    } else {
      cash += Math.max(0, closeTrade.payout - (closeTrade.reason === 'RESOLVED_WIN' ? Number(friction.redemptionGasUsd || 0) : 0));
    }
    todayPnL += pnl;
    trades++;
    if (closeTrade.reason === 'PRE_RESOLUTION_EXIT') preExits++;
    if (pnl >= -EPS) { wins++; consLosses = 0; }
    else {
      losses++; consLosses++;
      if (consLosses >= settings.maxConsecutiveLosses) { cooldownUntil = closeTrade.closeTimestamp + settings.cooldownSeconds; consLosses = 0; }
    }
    if (cash > peak) peak = cash;
    const dd = peak > 0 ? (peak - cash) / peak : 0;
    if (dd > maxDD) maxDD = dd;
  }
  for (const r of pendingReleases) cash += r.amount;
  return {
    final: cash, peak, maxDD, trades, wins, losses, blockedEntries: blocked,
    preResolutionExits: preExits, globalStopLossSkips: stopSkips, noFills, packetDrops: packets,
    winRate: trades > 0 ? wins / trades : 0, busted: cash < 1.0,
    tradabilityFloor: tradFloor, repricedRejects: prepared.rejects, repricedEvents: adj.length,
  };
}

function summarizeRuns(results) {
  const finals = results.map(r => r.final).filter(Number.isFinite);
  const tradeCounts = results.map(r => r.trades).filter(Number.isFinite);
  const wrArr = results.map(r => r.winRate).filter(Number.isFinite);
  return {
    median: quantile(finals, 0.5), p10: quantile(finals, 0.1), p25: quantile(finals, 0.25),
    p75: quantile(finals, 0.75), p90: quantile(finals, 0.9), p95: quantile(finals, 0.95),
    mean: finals.length ? finals.reduce((a, b) => a + b, 0) / finals.length : 0,
    min: finals.length ? Math.min(...finals) : 0, max: finals.length ? Math.max(...finals) : 0,
    bust: results.length ? (results.filter(r => r.busted).length / results.length * 100) : 100,
    medianTrades: quantile(tradeCounts, 0.5), medianWR: quantile(wrArr, 0.5),
    medianMaxDD: quantile(results.map(r => r.maxDD).filter(Number.isFinite), 0.5),
    runs: results.length,
  };
}

function buildWindows(events, horizonHours) {
  if (!events.length) return [];
  const hs = horizonHours * 3600;
  const windows = [];
  let endIdx = 0;
  for (let si = 0; si < events.length; si++) {
    const sTs = events[si].timestamp;
    while (endIdx < events.length && events[endIdx].timestamp < sTs + hs) endIdx++;
    if (endIdx > si) windows.push({ startIdx: si, endIdx });
  }
  return windows;
}

function buildPreparedWindows(sourceEvents, preparedEvents, horizonHours) {
  if (!sourceEvents.length) return [];
  const hs = horizonHours * 3600;
  const sourceWindows = buildWindows(sourceEvents, horizonHours);
  const out = [];
  let si = 0, ei = 0;
  for (const w of sourceWindows) {
    const sTs = Number(sourceEvents[w.startIdx].timestamp);
    const eTs = sTs + hs;
    while (si < preparedEvents.length && Number(preparedEvents[si].timestamp) < sTs) si++;
    if (ei < si) ei = si;
    while (ei < preparedEvents.length && Number(preparedEvents[ei].timestamp) < eTs) ei++;
    out.push({ startIdx: si, endIdx: ei });
  }
  return out;
}

function simBootstrap(events, cfg, start, horizonHours, settings, friction, runs, cycleLookup) {
  const fSettings = aggressiveSimSettings({ ...settings, cycleSeconds: cfg.cycleSeconds });
  const prepared = prepareEvents(events, cfg, fSettings, friction, cycleLookup);
  const windows = buildPreparedWindows(events, prepared.events, horizonHours);
  const results = [];
  if (!windows.length) {
    results.push(simSequence(prepared.events, cfg, start, settings, friction, cycleLookup, prepared.rejects));
    return { summary: summarizeRuns(results), results, preparedRejects: prepared.rejects };
  }
  for (let i = 0; i < runs; i++) {
    const w = windows[Math.floor(stableHash(`${i}|${start}|${horizonHours}|${events.length}|${cfg.id}`) * windows.length)];
    results.push(simSequence(prepared.events.slice(w.startIdx, w.endIdx), cfg, start, settings, friction, cycleLookup, {}));
  }
  return { summary: summarizeRuns(results), results, preparedRejects: prepared.rejects };
}

// ==================== ENSEMBLE COMBINER ====================
// Combine events from multiple approaches into a multi-signal stream
// KEY CHANGE: allow multiple trades per epoch - deduplicate only exact same signal
function combineEventStreams(eventStreams, maxPerEpochAsset = 3) {
  const all = [];
  for (const stream of eventStreams) {
    for (const ev of stream.events) all.push(ev);
  }
  // Deduplicate exact same signal (same epoch+asset+direction+minute)
  // but ALLOW different signals on same epoch+asset
  const byExact = new Map();
  for (const ev of all) {
    const key = `${ev.epoch}|${ev.asset}|${ev.direction}|${ev.minute}`;
    const existing = byExact.get(key);
    if (!existing || ev.pWinEstimate > existing.pWinEstimate) byExact.set(key, ev);
  }
  // Now limit per epoch+asset to maxPerEpochAsset
  const deduped = [...byExact.values()];
  const perEpochAsset = new Map();
  deduped.sort((a, b) => b.pWinEstimate - a.pWinEstimate);
  const kept = [];
  for (const ev of deduped) {
    const key = `${ev.epoch}|${ev.asset}`;
    const cnt = perEpochAsset.get(key) || 0;
    if (cnt >= maxPerEpochAsset) continue;
    perEpochAsset.set(key, cnt + 1);
    kept.push(ev);
  }
  return kept.sort((a, b) => a.timestamp - b.timestamp);
}

// ==================== APPROACH DEFINITIONS ====================
function getApproachDefs() {
  const common15 = {
    timeframe: '15m', cycleSeconds: 900,
    hours: Array.from({ length: 24 }, (_, i) => i),
    directions: ['UP', 'DOWN'],
    minTrainMatches: 14, minTrainDays: 3, minTrainLcb: 0.56, minTrainEvRoi: -0.02,
    maxNoPrintFrac: 0.30, maxSelected: 20, maxPerHour: 3,
    requirePrints: true, requireOpposite: true, requireOppositePrint: false,
    maxSpreadDeviation: 0.08,
    dataScope: 'fresh_15m', deployableData: true,
  };
  const common5 = {
    timeframe: '5m', cycleSeconds: 300,
    hours: Array.from({ length: 24 }, (_, i) => i),
    directions: ['UP', 'DOWN'],
    minTrainMatches: 20, minTrainDays: 3, minTrainLcb: 0.52, minTrainEvRoi: -0.02,
    maxNoPrintFrac: 0.35, maxSelected: 20, maxPerHour: 3,
    requirePrints: true, requireOpposite: true, requireOppositePrint: false,
    maxSpreadDeviation: 0.08,
    dataScope: 'fresh_5m', deployableData: true,
  };
  const common4 = {
    timeframe: '4h', cycleSeconds: 14400,
    hours: Array.from({ length: 24 }, (_, i) => i),
    directions: ['UP', 'DOWN'],
    minTrainMatches: 5, minTrainDays: 2, minTrainLcb: 0.44, minTrainEvRoi: -0.05,
    maxNoPrintFrac: 0.40, maxSelected: 12, maxPerHour: 4,
    requirePrints: true, requireOpposite: true, requireOppositePrint: false,
    maxSpreadDeviation: 0.10,
    dataScope: 'fresh_4h', deployableData: true,
  };

  return [
    // ===== 15m APPROACHES =====
    { ...common15, id: 'aggressive_spread_conv', name: 'Aggressive Spread-Convergence',
      category: 'orderbook_proxy', logic: 'Tight yes/no convergence with relaxed gates',
      minutes: [3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
      bands: [[0.45, 0.60], [0.48, 0.65], [0.52, 0.70], [0.55, 0.75], [0.58, 0.78]],
      maxSpreadDeviation: 0.025, requireOppositePrint: true, minTrainLcb: 0.60 },
    { ...common15, id: 'ultra_low_entry_growth', name: 'Ultra Low-Entry Growth',
      category: 'low_entry', logic: 'Convex low-price entries for maximum unit ROI',
      minutes: [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
      bands: [[0.25, 0.42], [0.30, 0.48], [0.35, 0.52], [0.38, 0.55], [0.40, 0.58], [0.42, 0.62], [0.45, 0.65]],
      minTrainLcb: 0.55, minTrainEvRoi: 0.02 },
    { ...common15, id: 'momentum_cascade', name: 'Momentum Cascade',
      category: 'momentum', logic: 'Strong 2-min momentum with volume confirmation',
      minutes: [2, 3, 4, 5, 6, 7, 8],
      bands: [[0.42, 0.58], [0.46, 0.62], [0.50, 0.68], [0.54, 0.72]],
      filter: 'strong_momentum_2min', minTrainLcb: 0.56, minTrainMatches: 12 },
    { ...common15, id: 'volume_surge_entry', name: 'Volume Surge Entry',
      category: 'volume', logic: 'Enter only when real volume confirms direction',
      minutes: [3, 4, 5, 6, 7, 8, 9],
      bands: [[0.45, 0.62], [0.50, 0.68], [0.55, 0.74]],
      filter: 'volume_surge', minTrainLcb: 0.58 },
    { ...common15, id: 'tight_spread_momentum_combo', name: 'Tight Spread + Momentum',
      category: 'combo', logic: 'Combined tight spread and upward price movement',
      minutes: [2, 3, 4, 5, 6, 7, 8, 9, 10],
      bands: [[0.48, 0.64], [0.52, 0.70], [0.56, 0.76]],
      filter: 'tight_spread_momentum', minTrainLcb: 0.58 },
    { ...common15, id: 'early_breakout_aggressive', name: 'Aggressive Early Breakout',
      category: 'breakout', logic: 'Follow early price breakouts with wider bands',
      minutes: [1, 2, 3, 4, 5],
      bands: [[0.50, 0.60], [0.52, 0.64], [0.54, 0.68], [0.56, 0.72], [0.58, 0.76]],
      filter: 'early_breakout', minTrainLcb: 0.55, minTrainMatches: 10, maxSelected: 20, maxPerHour: 3 },
    { ...common15, id: 'print_imbalance_wide', name: 'Wide Print-Imbalance',
      category: 'l2_proxy', logic: 'Print imbalance across wider price bands',
      minutes: [3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
      bands: [[0.40, 0.58], [0.45, 0.62], [0.48, 0.68], [0.52, 0.72], [0.55, 0.78]],
      filter: 'print_imbalance', minTrainLcb: 0.56, minTrainMatches: 12 },
    { ...common15, id: 'theta_sniping_extended', name: 'Extended Theta Sniping',
      category: 'theta', logic: 'Late-cycle entry with pre-resolution exit evidence',
      minutes: [8, 9, 10, 11, 12, 13],
      bands: [[0.50, 0.65], [0.55, 0.70], [0.58, 0.74], [0.60, 0.78]],
      filter: 'pre_exit_seen', minTrainLcb: 0.62 },
    { ...common15, id: 'reversal_from_cheap_15m', name: 'Reversal From Cheap',
      category: 'mean_reversion', logic: 'Buy reversals from cheap side',
      minutes: [3, 4, 5, 6, 7, 8, 9, 10],
      bands: [[0.30, 0.48], [0.35, 0.52], [0.38, 0.56], [0.42, 0.60]],
      filter: 'reversal_from_cheap', minTrainLcb: 0.52, minTrainMatches: 10 },
    { ...common15, id: 'streak_fade_aggressive', name: 'Aggressive Streak Fade',
      category: 'streak', logic: 'Fade 2-cycle same-direction streaks with wider params',
      dynamic: 'streak_fade',
      dynamicParams: [3, 4, 5, 6, 7, 8, 9, 10, 11, 12].flatMap(m => [[0.40, 0.58], [0.45, 0.65], [0.50, 0.72], [0.55, 0.78]].map(([pMin, pMax]) => ({ hour: -1, minute: m, priceMin: pMin, priceMax: pMax }))),
      minTrainLcb: 0.52, minTrainMatches: 16 },
    { ...common15, id: 'cross_asset_follow_wide', name: 'Cross-Asset Leader Follow Wide',
      category: 'cross_asset', logic: 'Follow cross-asset leaders with wider bands',
      dynamic: 'cross_asset_leader_follow',
      dynamicParams: ['BTC', 'ETH', 'SOL', 'XRP'].flatMap(la => [1, 2].flatMap(lag => [2, 3, 4, 5, 6, 7, 8, 9].flatMap(m => [[0.38, 0.56], [0.44, 0.62], [0.50, 0.70], [0.55, 0.76]].map(([pMin, pMax]) => ({ hour: -1, minute: m, priceMin: pMin, priceMax: pMax, leaderAsset: la, lagCycles: lag }))))),
      minTrainLcb: 0.52, minTrainMatches: 16 },
    { ...common15, id: 'multi_min_momentum_wide', name: 'Multi-Minute Momentum Wide',
      category: 'trajectory', logic: 'Two-minute climb with extended price bands',
      minutes: [2, 3, 4, 5, 6, 7, 8, 9, 10],
      bands: [[0.38, 0.54], [0.42, 0.58], [0.46, 0.64], [0.50, 0.70], [0.54, 0.76]],
      filter: 'multi_minute_momentum', minTrainLcb: 0.52, minTrainMatches: 10 },
    { ...common15, id: 'alternating_pattern', name: 'Alternating Resolution Pattern',
      category: 'alternating', logic: 'Bet opposite of previous cycle resolution',
      dynamic: 'alternating',
      dynamicParams: [2, 3, 4, 5, 6, 7, 8, 9, 10].flatMap(m => [[0.42, 0.58], [0.46, 0.64], [0.50, 0.70], [0.55, 0.76]].map(([pMin, pMax]) => ({ hour: -1, minute: m, priceMin: pMin, priceMax: pMax }))),
      minTrainLcb: 0.51, minTrainMatches: 20 },
    { ...common15, id: 'cross_majority_wide', name: 'Cross-Asset Majority Wide',
      category: 'cross_asset_majority', logic: 'Follow cross-asset majority direction',
      dynamic: 'cross_asset_prev_majority',
      dynamicParams: [2, 3, 4, 5, 6, 7, 8, 9, 10].flatMap(m => [[0.40, 0.58], [0.45, 0.65], [0.50, 0.72], [0.55, 0.78]].map(([pMin, pMax]) => ({ hour: -1, minute: m, priceMin: pMin, priceMax: pMax }))),
      minTrainLcb: 0.52, minTrainMatches: 24 },
    { ...common15, id: 'four_h_bias_follow_wide', name: '4h Bias Follow Wide',
      category: 'multi_tf', logic: 'Use 4h resolution as directional filter for 15m',
      dynamic: 'previous_4h_bias_follow',
      dynamicParams: [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].flatMap(m => [[0.40, 0.58], [0.45, 0.65], [0.50, 0.72], [0.55, 0.78]].map(([pMin, pMax]) => ({ hour: -1, minute: m, priceMin: pMin, priceMax: pMax }))),
      minTrainLcb: 0.50, minTrainMatches: 16 },
    { ...common15, id: 'three_streak_follow_wide', name: 'Three-Streak Follow Wide',
      category: 'streak', logic: 'Follow 3-cycle same-direction streaks',
      dynamic: 'streak_follow3',
      dynamicParams: [3, 4, 5, 6, 7, 8, 9, 10].flatMap(m => [[0.38, 0.56], [0.44, 0.64], [0.50, 0.72], [0.56, 0.78]].map(([pMin, pMax]) => ({ hour: -1, minute: m, priceMin: pMin, priceMax: pMax }))),
      minTrainLcb: 0.48, minTrainMatches: 8 },
    { ...common15, id: 'opposite_breakout_fade_wide', name: 'Opposite Breakout Fade Wide',
      category: 'adversarial', logic: 'Buy cheap side when opposite breaks out early',
      minutes: [2, 3, 4, 5, 6, 7, 8],
      bands: [[0.15, 0.30], [0.20, 0.38], [0.25, 0.42], [0.28, 0.48], [0.32, 0.52]],
      filter: 'opposite_early_breakout_fade', minTrainLcb: 0.26, minTrainEvRoi: -0.15, minTrainMatches: 6 },
    // SOL H20 expansion
    { ...common15, id: 'sol_h20_expanded', name: 'SOL H20 Expanded',
      category: 'sol_sparse', logic: 'SOL-specific around UTC H20 with wider search',
      asset: 'SOL', hours: [18, 19, 20, 21, 22],
      minutes: [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
      bands: [[0.38, 0.55], [0.42, 0.60], [0.46, 0.65], [0.50, 0.70], [0.54, 0.76]],
      minTrainMatches: 5, minTrainDays: 2, minTrainLcb: 0.38, minTrainEvRoi: -0.05, maxSelected: 10, maxPerHour: 4 },
    
    // ===== 5m APPROACHES =====
    { ...common5, id: '5m_spread_conv_aggressive', name: '5m Aggressive Spread-Conv',
      category: '5m_orderbook', logic: '5m tight spread convergence with relaxed gates',
      minutes: [1, 2, 3],
      bands: [[0.44, 0.58], [0.48, 0.64], [0.52, 0.70], [0.56, 0.76], [0.60, 0.78]],
      maxSpreadDeviation: 0.025, requireOppositePrint: true, minTrainLcb: 0.55 },
    { ...common5, id: '5m_momentum_aggressive', name: '5m Aggressive Momentum',
      category: '5m_momentum', logic: '5m momentum with wider bands and lower thresholds',
      minutes: [1, 2, 3],
      bands: [[0.42, 0.58], [0.46, 0.64], [0.50, 0.72], [0.54, 0.78]],
      filter: 'one_minute_momentum', minTrainLcb: 0.54, minTrainMatches: 22 },
    { ...common5, id: '5m_print_imbalance_wide', name: '5m Wide Print Imbalance',
      category: '5m_l2', logic: '5m print imbalance with wider coverage',
      minutes: [1, 2, 3],
      bands: [[0.38, 0.55], [0.42, 0.62], [0.46, 0.68], [0.50, 0.74]],
      filter: 'print_imbalance', minTrainLcb: 0.52, minTrainMatches: 16 },
    { ...common5, id: '5m_streak_fade_wide', name: '5m Streak Fade Wide',
      category: '5m_streak', logic: '5m streak fading with wider bands',
      dynamic: 'streak_fade',
      dynamicParams: [1, 2, 3].flatMap(m => [[0.38, 0.56], [0.44, 0.64], [0.50, 0.72], [0.55, 0.78]].map(([pMin, pMax]) => ({ hour: -1, minute: m, priceMin: pMin, priceMax: pMax }))),
      minTrainLcb: 0.50, minTrainMatches: 20 },
    { ...common5, id: '5m_low_entry_convexity', name: '5m Low Entry Convexity',
      category: '5m_low_entry', logic: '5m low-price entries for high unit ROI',
      minutes: [1, 2, 3],
      bands: [[0.28, 0.44], [0.32, 0.48], [0.36, 0.52], [0.40, 0.58], [0.44, 0.62]],
      minTrainLcb: 0.50, minTrainEvRoi: 0.01, minTrainMatches: 20 },
    
    // ===== 4h APPROACHES =====
    { ...common4, id: '4h_momentum_wide', name: '4h Momentum Wide',
      category: '4h_momentum', logic: '4h momentum across wider minutes and bands',
      minutes: [30, 45, 60, 90, 120, 150, 180, 210],
      bands: [[0.40, 0.58], [0.45, 0.65], [0.50, 0.72], [0.55, 0.78]],
      filter: 'one_minute_momentum', minTrainLcb: 0.50 },
    { ...common4, id: '4h_spread_conv_wide', name: '4h Spread-Conv Wide',
      category: '4h_orderbook', logic: '4h spread convergence with relaxed parameters',
      minutes: [30, 60, 90, 120, 150, 180, 210],
      bands: [[0.45, 0.62], [0.50, 0.70], [0.55, 0.78]],
      maxSpreadDeviation: 0.04, requireOppositePrint: true, minTrainLcb: 0.50 },
    { ...common4, id: '4h_low_convexity_wide', name: '4h Low-Entry Wide',
      category: '4h_low_entry', logic: '4h low-entry for maximum compounding',
      minutes: [45, 60, 90, 120, 150, 180, 210],
      bands: [[0.20, 0.38], [0.25, 0.42], [0.30, 0.50], [0.35, 0.55], [0.40, 0.62]],
      minTrainLcb: 0.38, minTrainEvRoi: -0.08 },
    
    // ===== ADDITIONAL LOW-ENTRY FOCUS =====
    { ...common15, id: 'ultra_convex_low_band', name: 'Ultra-Convex Low Band',
      category: 'convex_low', logic: 'Extreme low entry for convex payoff structure',
      minutes: [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
      bands: [[0.18, 0.32], [0.22, 0.38], [0.25, 0.42], [0.28, 0.45], [0.30, 0.48], [0.33, 0.50]],
      minTrainLcb: 0.30, minTrainEvRoi: -0.20, minTrainMatches: 8, minTrainDays: 2,
      maxSelected: 24, maxPerHour: 4, requireOppositePrint: false },
    { ...common15, id: 'mid_entry_all_signals', name: 'Mid-Entry All Signals',
      category: 'broad_mid', logic: 'Broad mid-price entry capturing maximum signal density',
      minutes: [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
      bands: [[0.38, 0.52], [0.40, 0.55], [0.42, 0.58], [0.44, 0.60], [0.46, 0.62], [0.48, 0.65]],
      minTrainLcb: 0.55, minTrainMatches: 12, maxSelected: 24, maxPerHour: 3 },
    { ...common15, id: 'early_minute_dense', name: 'Early Minute Dense Mining',
      category: 'early_dense', logic: 'Dense signal mining at minutes 2-5 for maximum trade velocity',
      minutes: [2, 3, 4, 5],
      bands: [[0.35, 0.50], [0.38, 0.54], [0.40, 0.58], [0.42, 0.60], [0.45, 0.65], [0.48, 0.68], [0.50, 0.72]],
      minTrainLcb: 0.52, minTrainMatches: 10, maxSelected: 30, maxPerHour: 4 },
    { ...common5, id: '5m_ultra_low_entry', name: '5m Ultra-Low Entry',
      category: '5m_convex', logic: '5m extreme low-entry for convex payoffs',
      minutes: [1, 2, 3],
      bands: [[0.20, 0.35], [0.25, 0.40], [0.28, 0.45], [0.30, 0.48], [0.32, 0.50], [0.35, 0.55]],
      minTrainLcb: 0.30, minTrainEvRoi: -0.15, minTrainMatches: 12, maxSelected: 20, maxPerHour: 4 },
    { ...common5, id: '5m_dense_mid_band', name: '5m Dense Mid-Band',
      category: '5m_broad', logic: '5m broad mid-price mining for signal density',
      minutes: [1, 2, 3],
      bands: [[0.38, 0.52], [0.40, 0.56], [0.42, 0.60], [0.45, 0.62], [0.48, 0.66], [0.50, 0.70]],
      minTrainLcb: 0.50, minTrainMatches: 16, maxSelected: 24, maxPerHour: 4 },
  ];
}

function getFrictionProfiles() {
  return {
    strict_repriced: { label: 'Strict repriced', noFillRate: 0.107, packetDropRate: 0.01, adverseFillCents: 1, lockupWinSeconds: 900, redemptionGasUsd: 0.01, latencyShiftMinutes: 1 },
    adverse_repriced: { label: 'Adverse repriced', noFillRate: 0.18, packetDropRate: 0.03, adverseFillCents: 2, lockupWinSeconds: 1800, redemptionGasUsd: 0.05, latencyShiftMinutes: 1 },
    no_latency: { label: 'No latency', noFillRate: 0.107, packetDropRate: 0.01, adverseFillCents: 1, lockupWinSeconds: 900, redemptionGasUsd: 0.01, latencyShiftMinutes: 0 },
    worst_case: { label: 'Worst case', noFillRate: 0.25, packetDropRate: 0.15, adverseFillCents: 4, lockupWinSeconds: 1800, redemptionGasUsd: 0.05, latencyShiftMinutes: 1 },
  };
}

// ==================== MAIN EXECUTION ====================
function main() {
  ensureDir(OUT_DIR);
  console.log('=== EPOCH 3 UNRESTRICTED ALPHA MINING ===');
  console.log('Output dir:', OUT_DIR);
  console.log('');

  // Load data
  console.log('Loading datasets...');
  const data15 = loadCycles('data/intracycle-price-data.json');
  const data5 = loadCycles('data/intracycle-price-data-5m.json');
  const data4 = loadCycles('data/intracycle-price-data-4h.json');
  console.log(`  15m: ${data15.length} cycles`);
  console.log(`  5m:  ${data5.length} cycles`);
  console.log(`  4h:  ${data4.length} cycles`);

  // Dataset audit
  const dataAudit = {
    generatedAt: new Date().toISOString(),
    datasets: {
      '15m': { cycles: data15.length, minEpoch: iso(data15[0]?.epoch), maxEpoch: iso(data15[data15.length - 1]?.epoch) },
      '5m': { cycles: data5.length, minEpoch: iso(data5[0]?.epoch), maxEpoch: iso(data5[data5.length - 1]?.epoch) },
      '4h': { cycles: data4.length, minEpoch: iso(data4[0]?.epoch), maxEpoch: iso(data4[data4.length - 1]?.epoch) },
    },
  };

  // Split: 65% train / 35% holdout (chronological)
  const splitIdx15 = Math.floor(data15.length * 0.65);
  const train15 = data15.slice(0, splitIdx15);
  const hold15 = data15.slice(splitIdx15);
  const splitIdx5 = Math.floor(data5.length * 0.92); // 5m has more data, use later 8% as holdout
  const train5 = data5.slice(0, splitIdx5);
  const hold5 = data5.slice(splitIdx5);
  const splitIdx4 = Math.floor(data4.length * 0.5);
  const train4 = data4.slice(0, splitIdx4);
  const hold4 = data4.slice(splitIdx4);

  console.log(`\nSplits:`);
  console.log(`  15m: train=${train15.length} holdout=${hold15.length}`);
  console.log(`  5m:  train=${train5.length} holdout=${hold5.length}`);
  console.log(`  4h:  train=${train4.length} holdout=${hold4.length}`);

  // Build cycle lookup
  const cycleLookup = new Map();
  for (const list of [data15, data5, data4]) {
    for (const c of list) cycleLookup.set(`${c.sourcePath}|${c.asset}|${c.epoch}`, c);
  }

  const approaches = getApproachDefs();
  const frictionProfiles = getFrictionProfiles();
  const starts = [5, 7, 10];
  const horizons = [24, 48, 168]; // 1d, 2d, 7d
  const runs = 5000;

  console.log(`\nRunning ${approaches.length} approach definitions...`);
  console.log(`MC runs: ${runs}, starts: ${starts}, horizons: ${horizons}h`);

  const allResults = [];
  const allEventStreams = [];

  for (let i = 0; i < approaches.length; i++) {
    const cfg = approaches[i];
    const tc = cfg.timeframe === '15m' ? train15 : cfg.timeframe === '5m' ? train5 : train4;
    const hc = cfg.timeframe === '15m' ? hold15 : cfg.timeframe === '5m' ? hold5 : hold4;
    const allc = cfg.timeframe === '15m' ? data15 : cfg.timeframe === '5m' ? data5 : data4;
    const ctx = { cycles4: data4 };
    
    console.log(`\n[${i + 1}/${approaches.length}] ${cfg.name} (${cfg.timeframe})`);
    
    const selectedInfo = selectCandidates(tc, hc, cfg, {}, ctx);
    console.log(`  candidates: ${selectedInfo.candidates.length}, selected: ${selectedInfo.selected.length}`);
    
    if (selectedInfo.selected.length === 0) {
      console.log(`  SKIPPED: no candidates passed training gates`);
      allResults.push({ id: cfg.id, name: cfg.name, category: cfg.category, timeframe: cfg.timeframe, selectedCount: 0, eventSurface: { holdoutEvents: 0 }, simulations: {} });
      continue;
    }

    const holdEvents = buildEvents(hc, cfg, selectedInfo.selected, {}, ctx);
    console.log(`  holdout events: ${holdEvents.length}`);
    
    if (holdEvents.length === 0) {
      allResults.push({ id: cfg.id, name: cfg.name, category: cfg.category, timeframe: cfg.timeframe, selectedCount: selectedInfo.selected.length, eventSurface: { holdoutEvents: 0, holdoutWR: 0 }, simulations: {} });
      continue;
    }

    allEventStreams.push({ id: cfg.id, events: holdEvents, cfg });

    const holdWR = holdEvents.filter(e => e.resolutionWon).length / holdEvents.length;
    const avgEntry = holdEvents.reduce((s, e) => s + e.signalEntryPrice, 0) / holdEvents.length;
    console.log(`  holdout WR: ${(holdWR * 100).toFixed(1)}%, avg entry: ${avgEntry.toFixed(3)}`);

    const result = {
      id: cfg.id, name: cfg.name, category: cfg.category, timeframe: cfg.timeframe,
      deployableData: cfg.deployableData, logic: cfg.logic,
      selectedCount: selectedInfo.selected.length,
      selected: selectedInfo.selected.slice(0, 5).map(r => ({ key: r.key, params: r.params, trainWR: r.train.winRate, trainLCB: r.train.lcb, trainMatches: r.train.matches, holdoutWR: r.holdout?.winRate, holdoutMatches: r.holdout?.matches })),
      eventSurface: {
        holdoutEvents: holdEvents.length,
        holdoutDays: [...new Set(holdEvents.map(e => dayKey(e.timestamp)))].filter(Boolean).length,
        avgEntry, holdoutWR: holdWR,
        preExitEvents: holdEvents.filter(e => e.preResolutionExit).length,
      },
      simulations: {},
    };

    for (const [fn, friction] of Object.entries(frictionProfiles)) {
      result.simulations[fn] = {};
      for (const start of starts) {
        result.simulations[fn][String(start)] = {};
        for (const horizon of horizons) {
          const sim = simBootstrap(holdEvents, cfg, start, horizon, {}, friction, runs, cycleLookup);
          result.simulations[fn][String(start)][String(horizon)] = {
            ...sim.summary,
            pGte20: sim.results.length ? sim.results.filter(r => r.final >= 20).length / sim.results.length : 0,
            pGte100: sim.results.length ? sim.results.filter(r => r.final >= 100).length / sim.results.length : 0,
            pGte500: sim.results.length ? sim.results.filter(r => r.final >= 500).length / sim.results.length : 0,
            pGte1000: sim.results.length ? sim.results.filter(r => r.final >= 1000).length / sim.results.length : 0,
            repricedRejects: sim.preparedRejects || {},
          };
        }
      }
    }

    // Print key metrics
    const s10_168 = result.simulations.strict_repriced?.['10']?.['168'] || {};
    const a10_168 = result.simulations.adverse_repriced?.['10']?.['168'] || {};
    console.log(`  $10/7d strict: median=$${(s10_168.median || 0).toFixed(2)} bust=${(s10_168.bust || 100).toFixed(1)}% P≥$100=${((s10_168.pGte100 || 0) * 100).toFixed(1)}% P≥$500=${((s10_168.pGte500 || 0) * 100).toFixed(1)}%`);
    console.log(`  $10/7d adverse: median=$${(a10_168.median || 0).toFixed(2)} bust=${(a10_168.bust || 100).toFixed(1)}%`);

    allResults.push(result);
  }

  // ==================== ENSEMBLE STRATEGY ====================
  console.log('\n=== ENSEMBLE COMBINATION ===');
  
  // Take the best individual approaches and combine their event streams
  const scoredStreams = allEventStreams
    .map(s => {
      const r = allResults.find(ar => ar.id === s.id);
      const s10 = r?.simulations?.strict_repriced?.['10']?.['168'] || {};
      return { ...s, median: s10.median || 0, bust: s10.bust || 100, pGte100: s10.pGte100 || 0 };
    })
    .filter(s => s.events.length >= 5 && (s.median > 5 || s.bust < 50))
    .sort((a, b) => b.median - a.median);

  console.log(`Eligible streams for ensemble: ${scoredStreams.length}`);
  
  if (scoredStreams.length >= 2) {
    const topStreams = scoredStreams.slice(0, Math.min(8, scoredStreams.length));
    console.log(`Top streams: ${topStreams.map(s => `${s.id}($${s.median.toFixed(0)})`).join(', ')}`);
    
    const combinedEvents = combineEventStreams(topStreams);
    console.log(`Combined event count: ${combinedEvents.length}`);
    
    if (combinedEvents.length > 0) {
      const ensembleCfg = { id: 'ensemble_combined', timeframe: '15m', cycleSeconds: 900 };
      const ensembleResult = {
        id: 'ensemble_combined', name: 'Ensemble Combined Top Approaches',
        category: 'ensemble', timeframe: 'multi', deployableData: true,
        logic: `Ensemble of top ${topStreams.length} approaches by holdout median: ${topStreams.map(s => s.id).join(', ')}`,
        selectedCount: topStreams.length,
        eventSurface: {
          holdoutEvents: combinedEvents.length,
          holdoutDays: [...new Set(combinedEvents.map(e => dayKey(e.timestamp)))].filter(Boolean).length,
          avgEntry: combinedEvents.reduce((s, e) => s + e.signalEntryPrice, 0) / combinedEvents.length,
          holdoutWR: combinedEvents.filter(e => e.resolutionWon).length / combinedEvents.length,
        },
        simulations: {},
      };

      for (const [fn, friction] of Object.entries(frictionProfiles)) {
        ensembleResult.simulations[fn] = {};
        for (const start of starts) {
          ensembleResult.simulations[fn][String(start)] = {};
          for (const horizon of horizons) {
            // For ensemble, simulate directly on combined events
            const sim = simBootstrap(combinedEvents, ensembleCfg, start, horizon, {}, friction, runs, cycleLookup);
            ensembleResult.simulations[fn][String(start)][String(horizon)] = {
              ...sim.summary,
              pGte20: sim.results.length ? sim.results.filter(r => r.final >= 20).length / sim.results.length : 0,
              pGte100: sim.results.length ? sim.results.filter(r => r.final >= 100).length / sim.results.length : 0,
              pGte500: sim.results.length ? sim.results.filter(r => r.final >= 500).length / sim.results.length : 0,
              pGte1000: sim.results.length ? sim.results.filter(r => r.final >= 1000).length / sim.results.length : 0,
            };
          }
        }
      }

      const es10 = ensembleResult.simulations.strict_repriced?.['10']?.['168'] || {};
      const ea10 = ensembleResult.simulations.adverse_repriced?.['10']?.['168'] || {};
      console.log(`  Ensemble $10/7d strict: median=$${(es10.median || 0).toFixed(2)} bust=${(es10.bust || 100).toFixed(1)}% P≥$100=${((es10.pGte100 || 0) * 100).toFixed(1)}% P≥$500=${((es10.pGte500 || 0) * 100).toFixed(1)}%`);
      console.log(`  Ensemble $10/7d adverse: median=$${(ea10.median || 0).toFixed(2)} bust=${(ea10.bust || 100).toFixed(1)}%`);

      allResults.push(ensembleResult);
    }
  }

  // ==================== RANKING ====================
  console.log('\n=== FINAL RANKINGS ===');
  const ranking = allResults
    .map(r => {
      const s10 = r.simulations?.strict_repriced?.['10']?.['168'] || {};
      const s7 = r.simulations?.strict_repriced?.['7']?.['168'] || {};
      const s5 = r.simulations?.strict_repriced?.['5']?.['168'] || {};
      const a10 = r.simulations?.adverse_repriced?.['10']?.['168'] || {};
      const w10 = r.simulations?.worst_case?.['10']?.['168'] || {};
      const noTrade = r.selectedCount <= 0 || (r.eventSurface?.holdoutEvents || 0) <= 0 ? 10000 : 0;
      const score = (s10.median || 0) + (s7.median || 0) * 0.25 + (s5.median || 0) * 0.1 - (s10.bust || 100) * 2 - noTrade;
      return {
        id: r.id, name: r.name, category: r.category, timeframe: r.timeframe || 'multi',
        selectedCount: r.selectedCount, holdoutEvents: r.eventSurface?.holdoutEvents || 0,
        holdoutWR: r.eventSurface?.holdoutWR || 0, avgEntry: r.eventSurface?.avgEntry || 0,
        score,
        s5_median: s5.median || 0, s5_bust: s5.bust || 100,
        s7_median: s7.median || 0, s7_bust: s7.bust || 100,
        s10_median: s10.median || 0, s10_bust: s10.bust || 100, s10_trades: s10.medianTrades || 0,
        s10_pGte100: s10.pGte100 || 0, s10_pGte500: s10.pGte500 || 0, s10_pGte1000: s10.pGte1000 || 0,
        a10_median: a10.median || 0, a10_bust: a10.bust || 100,
        w10_median: w10.median || 0, w10_bust: w10.bust || 100,
      };
    })
    .sort((a, b) => b.score - a.score);

  console.log('\nTop 10 approaches:');
  ranking.slice(0, 10).forEach((r, i) => {
    console.log(`  ${i + 1}. ${r.id} (${r.timeframe}) $10/7d: median=$${r.s10_median.toFixed(2)} bust=${r.s10_bust.toFixed(1)}% P≥$500=${(r.s10_pGte500 * 100).toFixed(1)}% | adverse=$${r.a10_median.toFixed(2)}`);
  });

  // ==================== BUILD STRATEGY SET ====================
  const bestApproach = ranking[0];
  console.log(`\nBest approach: ${bestApproach.id} - ${bestApproach.name}`);

  // Find the best approach's selected rules and build a deployable strategy set
  const bestResult = allResults.find(r => r.id === bestApproach.id);
  const strategySet = {
    generatedAt: new Date().toISOString(),
    source: 'epoch3_unrestricted_alpha_harness',
    approach: bestApproach.id,
    name: bestApproach.name,
    metrics: {
      s10_median: bestApproach.s10_median,
      s10_bust: bestApproach.s10_bust,
      s10_pGte100: bestApproach.s10_pGte100,
      s10_pGte500: bestApproach.s10_pGte500,
      a10_median: bestApproach.a10_median,
      a10_bust: bestApproach.a10_bust,
      holdoutWR: bestApproach.holdoutWR,
      holdoutEvents: bestApproach.holdoutEvents,
    },
    strategies: (bestResult?.selected || []).map((sel, idx) => ({
      id: idx + 1,
      name: `${bestApproach.id}_${idx + 1}`,
      utcHour: sel.params?.hour ?? -1,
      entryMinute: sel.params?.minute ?? 5,
      direction: sel.params?.direction || 'UP',
      priceMin: sel.params?.priceMin || 0.40,
      priceMax: sel.params?.priceMax || 0.75,
      asset: sel.params?.asset || 'ALL',
      winRate: sel.trainWR || sel.train?.winRate || 0.75,
      winRateLCB: sel.trainLCB || sel.train?.lcb || 0.65,
      pWinEstimate: sel.trainLCB || sel.train?.lcb || 0.65,
      evWinEstimate: sel.trainLCB || sel.train?.lcb || 0.65,
      tier: 'EPOCH3_UNRESTRICTED',
      signature: sel.key || `${bestApproach.id}_${idx}`,
      trainMatches: sel.trainMatches || sel.train?.matches || 0,
      holdoutWR: sel.holdoutWR || sel.holdout?.winRate || null,
      holdoutMatches: sel.holdoutMatches || sel.holdout?.matches || null,
      dynamic: bestResult?.logic?.includes('dynamic') ? bestApproach.category : null,
    })),
    conditions: {
      hardEntryPriceCap: 0.78,
      minNetEdgeRoi: 0.005,
      enforceNetEdgeGate: true,
      preResolutionExitEnabled: true,
      preResolutionMinBid: 0.94,
    },
    stats: {
      trainCycles: bestResult?.cycles?.train || 0,
      holdoutCycles: bestResult?.cycles?.holdout || 0,
    },
  };

  // ==================== SAVE OUTPUTS ====================
  writeJson('epoch3_data_audit.json', dataAudit);
  writeJson('epoch3_mc_results.json', { generatedAt: new Date().toISOString(), runs, starts, horizons, results: allResults });
  writeJson('epoch3_candidate_rankings.json', ranking);
  writeJson('epoch3_raw_trade_paths.json', { generatedAt: new Date().toISOString(), topApproaches: ranking.slice(0, 5) });

  // Save strategy set
  const stratPath = path.join(ROOT, 'strategies', 'strategy_set_epoch3_unrestricted.json');
  fs.writeFileSync(stratPath, JSON.stringify(strategySet, null, 2));
  console.log(`\nStrategy set saved: ${stratPath}`);

  // Strategy discovery report
  const discoveryMd = generateDiscoveryReport(ranking, allResults, dataAudit, bestApproach);
  writeText('epoch3_strategy_discovery.md', discoveryMd);

  // Deployment config
  const deployConfig = generateDeployConfig(bestApproach, strategySet);
  writeText('epoch3_deployment_config.md', deployConfig);

  // Runtime changes doc
  const runtimeChanges = generateRuntimeChanges(bestApproach);
  writeText('epoch3_runtime_changes.md', runtimeChanges);

  // L2 fill proof placeholder
  writeText('epoch3_l2_fill_proof.jsonl', JSON.stringify({ note: 'L2 fill proof requires live smoke test deployment. Historical L2 replay not available via API.', proxyUsed: 'minute-snapshot trade print counts as L2 imbalance proxy', timestamp: new Date().toISOString() }) + '\n');

  console.log('\n=== COMPLETE ===');
  console.log(`All artifacts saved to: ${OUT_DIR}`);
  console.log(`Strategy set: ${stratPath}`);
  
  return { ranking, bestApproach, strategySet };
}

function generateDiscoveryReport(ranking, allResults, dataAudit, bestApproach) {
  let md = `# EPOCH 3 Unrestricted Alpha Mining Discovery Report\n\n`;
  md += `Generated: ${new Date().toISOString()}\n\n`;
  md += `## Data Sources\n`;
  for (const [tf, info] of Object.entries(dataAudit.datasets)) {
    md += `- **${tf}**: ${info.cycles} cycles, ${info.minEpoch} to ${info.maxEpoch}\n`;
  }
  md += `\n## Simulation Parameters\n`;
  md += `- **Stake fractions**: Tiered: $<8=50%, $8-15=42%, $15-30=35%, $30-75=30%, $75-200=25%, $200+=20%\n`;
  md += `- **Kelly**: fraction=0.35, max=0.55, minPWin=0.52\n`;
  md += `- **Max consecutive losses before cooldown**: 4 (was 2)\n`;
  md += `- **Cooldown**: 600s (was 1800s)\n`;
  md += `- **Global stop loss**: 35% (was 20%)\n`;
  md += `- **Hard entry cap**: 0.78 (was 0.82)\n`;
  md += `- **MC runs**: 5000, starts: $5/$7/$10, horizons: 24h/48h/168h\n`;
  md += `\n## Approaches Tested: ${ranking.length}\n\n`;
  md += `| Rank | Approach | TF | $10/7d Median | $10 Bust% | P≥$100 | P≥$500 | Adverse Median |\n`;
  md += `|---:|---|---|---:|---:|---:|---:|---:|\n`;
  ranking.forEach((r, i) => {
    md += `| ${i + 1} | ${r.id} | ${r.timeframe} | $${r.s10_median.toFixed(2)} | ${r.s10_bust.toFixed(1)}% | ${(r.s10_pGte100 * 100).toFixed(1)}% | ${(r.s10_pGte500 * 100).toFixed(1)}% | $${r.a10_median.toFixed(2)} |\n`;
  });
  md += `\n## Best Approach: ${bestApproach.id}\n`;
  md += `- **Name**: ${bestApproach.name}\n`;
  md += `- **$10 strict median**: $${bestApproach.s10_median.toFixed(2)}\n`;
  md += `- **$10 strict bust**: ${bestApproach.s10_bust.toFixed(1)}%\n`;
  md += `- **P(≥$100)**: ${(bestApproach.s10_pGte100 * 100).toFixed(1)}%\n`;
  md += `- **P(≥$500)**: ${(bestApproach.s10_pGte500 * 100).toFixed(1)}%\n`;
  md += `- **Holdout WR**: ${(bestApproach.holdoutWR * 100).toFixed(1)}%\n`;
  md += `- **Avg entry**: ${bestApproach.avgEntry.toFixed(3)}\n`;
  return md;
}

function generateDeployConfig(bestApproach, strategySet) {
  return `# EPOCH 3 Deployment Configuration\n\n` +
    `Generated: ${new Date().toISOString()}\n\n` +
    `## Strategy: ${bestApproach.name}\n\n` +
    `## Render Environment Variables\n\n` +
    '```env\n' +
    `TRADE_MODE=PAPER\n` +
    `START_PAUSED=true\n` +
    `STARTING_BALANCE=10\n` +
    `OPERATOR_STAKE_FRACTION=0.40\n` +
    `MAX_GLOBAL_TRADES_PER_CYCLE=5\n` +
    `ALLOW_MICRO_MPC_OVERRIDE=true\n` +
    `MICRO_BANKROLL_MPC_CAP=5\n` +
    `STRATEGY_SET_15M_PATH=strategies/strategy_set_epoch3_unrestricted.json\n` +
    `TIMEFRAME_15M_ENABLED=true\n` +
    `TIMEFRAME_15M_MIN_BANKROLL=3\n` +
    `TIMEFRAME_5M_ENABLED=true\n` +
    `TIMEFRAME_5M_MIN_BANKROLL=3\n` +
    `ALLOW_MICRO_TIMEFRAME_OVERRIDE=true\n` +
    `MICRO_BANKROLL_ALLOW_5M=true\n` +
    `MULTIFRAME_4H_ENABLED=true\n` +
    `MICRO_BANKROLL_ALLOW_4H=true\n` +
    `TIMEFRAME_4H_MIN_BANKROLL=3\n` +
    `HARD_ENTRY_PRICE_CAP=0.78\n` +
    `HIGH_PRICE_EDGE_FLOOR_PRICE=0.78\n` +
    `ENFORCE_NET_EDGE_GATE=true\n` +
    `MIN_NET_EDGE_ROI=0.005\n` +
    `MAX_CONSECUTIVE_LOSSES=4\n` +
    `COOLDOWN_SECONDS=600\n` +
    `KELLY_MAX_FRACTION=0.55\n` +
    `PRE_RESOLUTION_EXIT_ENABLED=true\n` +
    `PRE_RESOLUTION_MIN_BID=0.94\n` +
    '```\n\n' +
    `## Deployment Steps\n\n` +
    `1. Start in PAPER mode, paused\n` +
    `2. Set all env vars in Render dashboard\n` +
    `3. Push to main/master to trigger deploy\n` +
    `4. Verify /api/health shows correct strategy loaded\n` +
    `5. Unpause via Telegram or API\n` +
    `6. Monitor first 5-10 trades manually\n` +
    `7. Switch to LIVE only after PAPER validation\n`;
}

function generateRuntimeChanges(bestApproach) {
  return `# EPOCH 3 Runtime Changes\n\n` +
    `Generated: ${new Date().toISOString()}\n\n` +
    `## Changes Made\n\n` +
    `### 1. lib/config.js\n` +
    `- Added env-controlled override for micro-bankroll MPC cap\n` +
    `- Added ALLOW_MICRO_MPC_OVERRIDE and EPOCH3_ALLOW_MICRO_MPC_OVERRIDE\n` +
    `- Added ALLOW_MICRO_TIMEFRAME_OVERRIDE for 5m/4h enablement\n` +
    `- Tiered stake fraction support via OPERATOR_STAKE_FRACTION\n\n` +
    `### 2. lib/risk-manager.js\n` +
    `- Env-controlled MICRO_BANKROLL_MPC_CAP override\n` +
    `- Tiered stake sizing: micro-bankroll ($5-15) uses aggressive 40-50% SF\n` +
    `- Widened drawdown brake threshold from 20% to 30%\n` +
    `- Increased max consecutive losses from 2 to 4\n` +
    `- Shortened cooldown from 1800s to 600s\n\n` +
    `### 3. lib/strategy-matcher.js\n` +
    `- Extended evaluateMatch to support dynamic condition functions\n` +
    `- Added programmatic strategy evaluation alongside static JSON\n` +
    `- Support for filter-based and dynamic-direction strategies\n\n` +
    `### 4. strategies/strategy_set_epoch3_unrestricted.json\n` +
    `- New strategy set from epoch3 unrestricted mining\n` +
    `- Best approach: ${bestApproach.id}\n`;
}

main();
