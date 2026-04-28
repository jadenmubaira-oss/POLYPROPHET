const fs = require('fs');
const path = require('path');
const {
  calcPolymarketTakerFeeUsd,
  getMaxAffordableSharesForEntry,
  getPolymarketTakerFeeModel,
} = require('../lib/polymarket-fees');
const {
  computeTradeOpen,
  computeTradeClose,
  computeTradabilityFloor,
  estimateNetEdgeRoi,
  summarizeRuns,
} = require('./v5_runtime_parity_core');

const ROOT = path.join(__dirname, '..');
const OUT_DIR = path.join(ROOT, process.env.FINAL_OUT_DIR || path.join('epoch3', 'final'));
const EPS = 1e-9;
const ASSET_RANK = { BTC: 0, ETH: 1, SOL: 2, XRP: 3, BNB: 4, DOGE: 5, HYPE: 6 };

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function readJson(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(ROOT, relativePath), 'utf8'));
}

function writeJson(fileName, value) {
  fs.writeFileSync(path.join(OUT_DIR, fileName), JSON.stringify(value, null, 2));
}

function writeText(fileName, value) {
  fs.writeFileSync(path.join(OUT_DIR, fileName), value);
}

function toFiniteNumber(value, fallback = null) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function iso(epoch) {
  return Number.isFinite(Number(epoch)) ? new Date(Number(epoch) * 1000).toISOString() : null;
}

function dayKey(epoch) {
  const value = Number(epoch);
  return Number.isFinite(value) ? new Date(value * 1000).toISOString().slice(0, 10) : null;
}

function stableHash(value) {
  const str = String(value);
  let h = 2166136261;
  for (let i = 0; i < str.length; i += 1) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) / 4294967296;
}

function quantile(values, p) {
  const finite = values.filter((value) => Number.isFinite(Number(value))).map(Number).sort((a, b) => a - b);
  if (!finite.length) return 0;
  return finite[Math.min(finite.length - 1, Math.floor(p * finite.length))];
}

function wilsonLCB(wins, n, z = 1.96) {
  const w = Number(wins);
  const total = Number(n);
  if (!(total > 0)) return 0;
  const phat = w / total;
  const z2 = z * z;
  const den = 1 + z2 / total;
  const center = phat + z2 / (2 * total);
  const adj = z * Math.sqrt((phat * (1 - phat) + z2 / (4 * total)) / total);
  return Math.max(0, Math.min(1, (center - adj) / den));
}

function loadCycles(relativePath) {
  const raw = readJson(relativePath);
  const cycles = Array.isArray(raw) ? raw : raw.cycles || raw.data || [];
  return cycles
    .filter((cycle) => Number.isFinite(Number(cycle.epoch)))
    .map((cycle) => ({ ...cycle, sourcePath: relativePath, timeframe: cycle.timeframe || raw.timeframe || null }))
    .sort((a, b) => Number(a.epoch) - Number(b.epoch));
}

function sidePrices(cycle, direction) {
  return direction === 'UP' ? cycle.minutePricesYes : cycle.minutePricesNo;
}

function oppositePrices(cycle, direction) {
  return direction === 'UP' ? cycle.minutePricesNo : cycle.minutePricesYes;
}

function snapshotAt(cycle, direction, minute) {
  const prices = sidePrices(cycle, direction);
  return prices?.[String(minute)] || prices?.[minute] || null;
}

function oppositeSnapshotAt(cycle, direction, minute) {
  const prices = oppositePrices(cycle, direction);
  return prices?.[String(minute)] || prices?.[minute] || null;
}

function priceAt(cycle, direction, minute) {
  return toFiniteNumber(snapshotAt(cycle, direction, minute)?.last, null);
}

function oppositePriceAt(cycle, direction, minute) {
  return toFiniteNumber(oppositeSnapshotAt(cycle, direction, minute)?.last, null);
}

function countAt(cycle, direction, minute) {
  return Math.max(0, Math.floor(toFiniteNumber(snapshotAt(cycle, direction, minute)?.count, 0)));
}

function oppositeCountAt(cycle, direction, minute) {
  return Math.max(0, Math.floor(toFiniteNumber(oppositeSnapshotAt(cycle, direction, minute)?.count, 0)));
}

function observedRange(cycle, direction, minute) {
  const values = [];
  for (let m = 0; m <= minute; m += 1) {
    const price = priceAt(cycle, direction, m);
    if (Number.isFinite(price)) values.push(price);
  }
  if (values.length < 2) return 0;
  return Math.max(...values) - Math.min(...values);
}

function datasetSummary(relativePath) {
  const fullPath = path.join(ROOT, relativePath);
  const st = fs.statSync(fullPath);
  const raw = readJson(relativePath);
  const cycles = Array.isArray(raw) ? raw : raw.cycles || raw.data || [];
  const epochs = cycles.map((cycle) => Number(cycle.epoch)).filter(Number.isFinite);
  const resolutions = { UP: 0, DOWN: 0, OTHER: 0 };
  const assets = {};
  const orderMins = {};
  const minuteCounts = [];
  let point50 = 0;
  let priceSlots = 0;
  for (const cycle of cycles) {
    const resolution = String(cycle.resolution || cycle.winner || '').toUpperCase();
    if (resolution === 'UP' || resolution === 'DOWN') resolutions[resolution] += 1;
    else resolutions.OTHER += 1;
    const asset = String(cycle.asset || '?').toUpperCase();
    assets[asset] = (assets[asset] || 0) + 1;
    const orderMin = cycle.orderMinSize ?? cycle.yesMinOrderSize ?? cycle.noMinOrderSize;
    if (orderMin !== undefined) orderMins[String(orderMin)] = (orderMins[String(orderMin)] || 0) + 1;
    if (cycle.minutePricesYes) minuteCounts.push(Object.keys(cycle.minutePricesYes).length);
    for (const side of ['minutePricesYes', 'minutePricesNo']) {
      const prices = cycle[side];
      if (!prices || typeof prices !== 'object') continue;
      for (const snap of Object.values(prices)) {
        const last = Number(snap?.last);
        if (Number.isFinite(last)) {
          priceSlots += 1;
          if (last === 0.5) point50 += 1;
        }
      }
    }
  }
  return {
    path: relativePath,
    bytes: st.size,
    mtime: st.mtime.toISOString(),
    generatedAt: raw.generatedAt || null,
    timeframe: raw.timeframe || cycles[0]?.timeframe || null,
    cycleSeconds: raw.cycleSeconds || null,
    items: cycles.length,
    minIso: epochs.length ? iso(Math.min(...epochs)) : null,
    maxIso: epochs.length ? iso(Math.max(...epochs)) : null,
    resolutions,
    assets,
    orderMins,
    minuteCoverage: {
      min: minuteCounts.length ? Math.min(...minuteCounts) : null,
      max: minuteCounts.length ? Math.max(...minuteCounts) : null,
    },
    exactPoint50Slots: {
      count: point50,
      total: priceSlots,
      pct: priceSlots ? point50 / priceSlots : null,
    },
  };
}

function defaultSimSettings(overrides = {}) {
  return {
    minOrderShares: 5,
    stakeFraction: 0.30,
    kellyFraction: 0.25,
    kellyMaxFraction: 0.45,
    kellyMinPWin: 0.55,
    slippagePct: 0.01,
    peakDrawdownBrakePct: 0.20,
    peakDrawdownBrakeMinBankroll: 20,
    peakDrawdownBrakeStakeFraction: 0.12,
    maxConsecutiveLosses: 2,
    cooldownSeconds: 1800,
    globalStopLoss: 0.20,
    microBankrollThreshold: 20,
    minBalanceFloor: 0,
    maxAbsoluteStakeSmall: 100000,
    maxAbsoluteStakeMedium: 100000,
    maxAbsoluteStakeLarge: 100000,
    feeModel: getPolymarketTakerFeeModel(),
    hardEntryPriceCap: 0.82,
    minNetEdgeRoi: 0.01,
    enforceNetEdgeGate: true,
    enforceHighPriceEdgeFloor: true,
    highPriceEdgeFloorPrice: 0.82,
    highPriceEdgeFloorMinRoi: 0.02,
    preResolutionExitEnabled: true,
    preResolutionMinBid: 0.95,
    preResolutionExitSeconds: 120,
    cycleSeconds: 900,
    assetRank: ASSET_RANK,
    ...overrides,
  };
}

function passesEdgeGuards(entryPrice, pWinEstimate, settings) {
  const netEdgeRoi = estimateNetEdgeRoi(entryPrice, pWinEstimate, settings);
  if (settings.enforceNetEdgeGate && (!Number.isFinite(netEdgeRoi) || netEdgeRoi < settings.minNetEdgeRoi)) return false;
  if (
    settings.enforceHighPriceEdgeFloor &&
    Number(entryPrice) >= settings.highPriceEdgeFloorPrice &&
    (!Number.isFinite(netEdgeRoi) || netEdgeRoi < settings.highPriceEdgeFloorMinRoi)
  ) return false;
  return true;
}

function findPreResolutionExit(cycle, direction, settings, earliestTimestamp = -Infinity) {
  if (!settings.preResolutionExitEnabled) return null;
  const prices = sidePrices(cycle, direction);
  if (!prices || typeof prices !== 'object') return null;
  const snapshots = Object.entries(prices)
    .map(([minuteKey, snapshot]) => ({
      minute: Number(minuteKey),
      price: toFiniteNumber(snapshot?.last, null),
      timestamp: toFiniteNumber(snapshot?.ts, Number(cycle.epoch) + Number(minuteKey) * 60),
    }))
    .filter((snapshot) => Number.isFinite(snapshot.minute) && snapshot.price > 0 && snapshot.price < 1)
    .sort((a, b) => a.timestamp - b.timestamp);
  for (const snapshot of snapshots) {
    if (snapshot.timestamp <= earliestTimestamp) continue;
    const remaining = Number(cycle.epoch) + settings.cycleSeconds - snapshot.timestamp;
    if (remaining <= 0 || remaining > settings.preResolutionExitSeconds) continue;
    if (snapshot.price + EPS < settings.preResolutionMinBid) continue;
    return {
      minute: snapshot.minute,
      timestamp: snapshot.timestamp,
      exitPrice: snapshot.price,
      remaining,
    };
  }
  return null;
}

function passesBaseMicrostructure(cycle, direction, minute, price, cfg, settings) {
  const opposite = oppositePriceAt(cycle, direction, minute);
  const count = countAt(cycle, direction, minute);
  const oppCount = oppositeCountAt(cycle, direction, minute);
  if (!(price > 0) || price >= 1) return false;
  if (cfg.requirePrints && !(count > 0)) return false;
  if (cfg.requireOpposite && !(opposite > 0)) return false;
  if (cfg.requireOppositePrint && !(oppCount > 0)) return false;
  if (cfg.maxSpreadDeviation !== null && opposite > 0 && Math.abs(price + opposite - 1) > cfg.maxSpreadDeviation) return false;
  if (settings.hardEntryPriceCap > 0 && price > settings.hardEntryPriceCap) return false;
  return true;
}

function passesCustomFilter(cycle, direction, minute, price, cfg, settings) {
  if (cfg.filter === 'pre_exit_seen') return !!findPreResolutionExit(cycle, direction, settings, Number(cycle.epoch) + minute * 60);
  if (cfg.filter === 'print_imbalance') {
    const c = countAt(cycle, direction, minute);
    const o = oppositeCountAt(cycle, direction, minute);
    return c >= Math.max(2, o * 2);
  }
  if (cfg.filter === 'early_breakout') {
    if (minute < 1) return false;
    const prev = priceAt(cycle, direction, minute - 1);
    const start = priceAt(cycle, direction, 0);
    return prev > 0 && start > 0 && price - start >= 0.04 && price - prev >= 0.005;
  }
  if (cfg.filter === 'late_inversion_low_side') {
    const expensiveOpposite = oppositePriceAt(cycle, direction, minute);
    return expensiveOpposite >= 0.75 && price <= 0.32;
  }
  if (cfg.filter === 'one_minute_momentum') {
    if (minute < 1) return false;
    const prev = priceAt(cycle, direction, minute - 1);
    return prev > 0 && price - prev >= 0.015;
  }
  if (cfg.filter === 'multi_minute_momentum') {
    if (minute < 2) return false;
    const prev = priceAt(cycle, direction, minute - 1);
    const prev2 = priceAt(cycle, direction, minute - 2);
    return prev2 > 0 && prev > 0 && prev > prev2 && price > prev && price - prev2 >= 0.035;
  }
  if (cfg.filter === 'opposite_early_breakout_fade') {
    if (minute < 2) return false;
    const oppositeNow = oppositePriceAt(cycle, direction, minute);
    const oppositePrev = oppositePriceAt(cycle, direction, minute - 1);
    const oppositeStart = oppositePriceAt(cycle, direction, 0);
    return oppositeStart > 0 && oppositePrev > 0 && oppositeNow > oppositePrev && oppositeNow - oppositeStart >= 0.05 && price <= 0.45;
  }
  if (cfg.filter === 'open_reversal') {
    const open = priceAt(cycle, direction, 0);
    return open > 0 && open - price >= 0.08 && price <= 0.45;
  }
  if (cfg.filter === 'early_realized_volatility') {
    return observedRange(cycle, direction, minute) >= 0.10;
  }
  return true;
}

function candidateKey(approachId, params) {
  return [
    approachId,
    params.asset || 'ALL',
    params.leaderAsset || 'NOLEADER',
    params.lagCycles ?? 'NOLAG',
    params.hour ?? 'ALL',
    params.minute ?? 'DYN',
    params.direction || 'DYN',
    params.priceMin,
    params.priceMax,
    params.filter || 'none',
  ].join('|');
}

function recordStats(map, key, eventLike) {
  let stats = map.get(key);
  if (!stats) {
    stats = {
      n: 0,
      w: 0,
      sumEntry: 0,
      days: new Set(),
      zeroPrints: 0,
      onePrints: 0,
      preExit: 0,
      params: eventLike.params,
    };
    map.set(key, stats);
  }
  stats.n += 1;
  if (eventLike.won) stats.w += 1;
  stats.sumEntry += eventLike.price;
  stats.days.add(eventLike.day);
  if (eventLike.count === 0) stats.zeroPrints += 1;
  if (eventLike.count === 1) stats.onePrints += 1;
  if (eventLike.preExit) stats.preExit += 1;
}

function summarizeCandidate(stats, settings) {
  const winRate = stats.n ? stats.w / stats.n : 0;
  const lcb = wilsonLCB(stats.w, stats.n);
  const avgEntry = stats.n ? stats.sumEntry / stats.n : 0;
  const evRoi = estimateNetEdgeRoi(avgEntry, lcb, settings);
  return {
    matches: stats.n,
    wins: stats.w,
    losses: stats.n - stats.w,
    winRate,
    lcb,
    avgEntry,
    dayCount: stats.days.size,
    noPrintFrac: stats.n ? stats.zeroPrints / stats.n : 0,
    onePrintFrac: stats.n ? stats.onePrints / stats.n : 0,
    preExitFrac: stats.n ? stats.preExit / stats.n : 0,
    evRoi,
  };
}

function makeStaticParams(cfg) {
  const params = [];
  for (const hour of cfg.hours) {
    for (const minute of cfg.minutes) {
      for (const direction of cfg.directions) {
        for (const [priceMin, priceMax] of cfg.bands) {
          params.push({ hour, minute, direction, priceMin, priceMax, filter: cfg.filter || null, asset: cfg.asset || 'ALL' });
        }
      }
    }
  }
  return params;
}

function previousCycleByAsset(cycles, cycleSeconds) {
  const byAssetEpoch = new Map();
  for (const cycle of cycles) byAssetEpoch.set(`${cycle.asset}|${cycle.epoch}`, cycle);
  return (cycle) => byAssetEpoch.get(`${cycle.asset}|${Number(cycle.epoch) - cycleSeconds}`) || null;
}

function majorityPreviousByEpoch(cycles, cycleSeconds) {
  const byEpoch = new Map();
  for (const cycle of cycles) {
    const arr = byEpoch.get(Number(cycle.epoch)) || [];
    arr.push(cycle);
    byEpoch.set(Number(cycle.epoch), arr);
  }
  return (cycle) => {
    const prev = byEpoch.get(Number(cycle.epoch) - cycleSeconds) || [];
    const up = prev.filter((item) => item.resolution === 'UP').length;
    const down = prev.filter((item) => item.resolution === 'DOWN').length;
    if (up > down) return 'UP';
    if (down > up) return 'DOWN';
    return null;
  };
}

function byAssetEpoch(cycles) {
  const out = new Map();
  for (const cycle of cycles) out.set(`${String(cycle.asset || '').toUpperCase()}|${Number(cycle.epoch)}`, cycle);
  return out;
}

function previousCompletedByAsset(cycles, cycleSeconds) {
  const grouped = new Map();
  for (const cycle of cycles) {
    const asset = String(cycle.asset || '').toUpperCase();
    if (!grouped.has(asset)) grouped.set(asset, []);
    grouped.get(asset).push(cycle);
  }
  for (const values of grouped.values()) values.sort((a, b) => Number(a.epoch) - Number(b.epoch));
  return (cycle) => {
    const values = grouped.get(String(cycle.asset || '').toUpperCase()) || [];
    const cutoff = Number(cycle.epoch) - Number(cycleSeconds || 0);
    let lo = 0;
    let hi = values.length - 1;
    let found = null;
    while (lo <= hi) {
      const mid = Math.floor((lo + hi) / 2);
      if (Number(values[mid].epoch) <= cutoff) {
        found = values[mid];
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    return found;
  };
}

function oppositeResolution(resolution) {
  if (resolution === 'UP') return 'DOWN';
  if (resolution === 'DOWN') return 'UP';
  return null;
}

function sameDirectionStreak(cycle, helpers, length) {
  let cursor = cycle;
  let direction = null;
  for (let i = 0; i < length; i += 1) {
    cursor = helpers.prevByAsset(cursor);
    const resolution = String(cursor?.resolution || '').toUpperCase();
    if (resolution !== 'UP' && resolution !== 'DOWN') return null;
    if (!direction) direction = resolution;
    if (resolution !== direction) return null;
  }
  return direction;
}

function buildDynamicHelpers(cycles, settings, context = {}) {
  return {
    prevByAsset: previousCycleByAsset(cycles, settings.cycleSeconds),
    prevMajority: majorityPreviousByEpoch(cycles, settings.cycleSeconds),
    byAssetEpoch: byAssetEpoch(cycles),
    prevCompleted4h: previousCompletedByAsset(context.cycles4 || [], 14400),
    cycleSeconds: settings.cycleSeconds,
  };
}

function dynamicDirection(cycle, cfg, helpers, params = {}) {
  if (cfg.dynamic === 'streak_fade') {
    const prev1 = helpers.prevByAsset(cycle);
    if (!prev1) return null;
    const prev2 = helpers.prevByAsset(prev1);
    if (!prev2) return null;
    if (prev1.resolution === prev2.resolution && (prev1.resolution === 'UP' || prev1.resolution === 'DOWN')) {
      return prev1.resolution === 'UP' ? 'DOWN' : 'UP';
    }
  }
  if (cfg.dynamic === 'streak_follow3' || cfg.dynamic === 'streak_fade3') {
    const direction = sameDirectionStreak(cycle, helpers, 3);
    if (!direction) return null;
    return cfg.dynamic === 'streak_follow3' ? direction : oppositeResolution(direction);
  }
  if (cfg.dynamic === 'cross_asset_leader_follow' || cfg.dynamic === 'cross_asset_leader_fade') {
    const leaderAsset = String(params.leaderAsset || '').toUpperCase();
    const lagCycles = Math.max(1, Math.floor(toFiniteNumber(params.lagCycles, 1)));
    if (!leaderAsset) return null;
    const leader = helpers.byAssetEpoch.get(`${leaderAsset}|${Number(cycle.epoch) - lagCycles * Number(helpers.cycleSeconds || cfg.cycleSeconds || 0)}`);
    const resolution = String(leader?.resolution || '').toUpperCase();
    if (resolution !== 'UP' && resolution !== 'DOWN') return null;
    return cfg.dynamic === 'cross_asset_leader_follow' ? resolution : oppositeResolution(resolution);
  }
  if (cfg.dynamic === 'previous_4h_bias_follow' || cfg.dynamic === 'previous_4h_bias_fade') {
    const previous4h = helpers.prevCompleted4h(cycle);
    const resolution = String(previous4h?.resolution || '').toUpperCase();
    if (resolution !== 'UP' && resolution !== 'DOWN') return null;
    return cfg.dynamic === 'previous_4h_bias_follow' ? resolution : oppositeResolution(resolution);
  }
  if (cfg.dynamic === 'cross_asset_prev_majority') return helpers.prevMajority(cycle);
  return null;
}

function collectCandidateStats(cycles, cfg, settings, context = {}) {
  const stats = new Map();
  const helpers = buildDynamicHelpers(cycles, settings, context);
  const paramsList = cfg.dynamic ? cfg.dynamicParams : makeStaticParams(cfg);
  for (const cycle of cycles) {
    const epoch = Number(cycle.epoch);
    const resolution = String(cycle.resolution || '').toUpperCase();
    if (resolution !== 'UP' && resolution !== 'DOWN') continue;
    const hour = new Date(epoch * 1000).getUTCHours();
    const day = dayKey(epoch);
    for (const params of paramsList) {
      const assetRule = String(params.asset || cfg.asset || 'ALL').toUpperCase();
      if (assetRule !== 'ALL' && String(cycle.asset || '').toUpperCase() !== assetRule) continue;
      const effectiveParams = { ...params, asset: assetRule };
      const minute = params.minute;
      if (params.hour !== -1 && params.hour !== hour) continue;
      const direction = cfg.dynamic ? dynamicDirection(cycle, cfg, helpers, effectiveParams) : params.direction;
      if (direction !== 'UP' && direction !== 'DOWN') continue;
      const price = priceAt(cycle, direction, minute);
      if (!(price >= params.priceMin && price <= params.priceMax)) continue;
      if (!passesBaseMicrostructure(cycle, direction, minute, price, cfg, settings)) continue;
      if (!passesCustomFilter(cycle, direction, minute, price, cfg, settings)) continue;
      const preExit = findPreResolutionExit(cycle, direction, settings, epoch + minute * 60);
      const key = candidateKey(cfg.id, { ...effectiveParams, direction, filter: cfg.filter || cfg.dynamic || null });
      recordStats(stats, key, {
        params: { ...effectiveParams, direction, filter: cfg.filter || cfg.dynamic || null },
        won: resolution === direction,
        price,
        day,
        count: countAt(cycle, direction, minute),
        preExit,
      });
    }
  }
  return stats;
}

function selectCandidates(trainCycles, holdoutCycles, cfg, baseSettings, context = {}) {
  const settings = defaultSimSettings({ ...baseSettings, cycleSeconds: cfg.cycleSeconds });
  const trainStats = collectCandidateStats(trainCycles, cfg, settings, context);
  const holdStats = collectCandidateStats(holdoutCycles, cfg, settings, context);
  const rows = [];
  for (const [key, raw] of trainStats.entries()) {
    const train = summarizeCandidate(raw, settings);
    if (train.matches < cfg.minTrainMatches) continue;
    if (train.dayCount < cfg.minTrainDays) continue;
    if (train.lcb < cfg.minTrainLcb) continue;
    if (!Number.isFinite(train.evRoi) || train.evRoi < cfg.minTrainEvRoi) continue;
    if (train.noPrintFrac > cfg.maxNoPrintFrac) continue;
    const holdRaw = holdStats.get(key);
    const holdout = holdRaw ? summarizeCandidate(holdRaw, settings) : null;
    const holdoutEvUsingTrain = holdout ? estimateNetEdgeRoi(holdout.avgEntry, train.lcb, settings) : null;
    rows.push({
      key,
      params: raw.params,
      train,
      holdout,
      holdoutEvUsingTrain,
      score: train.evRoi + train.lcb + Math.min(0.15, train.matches / 400) + Math.min(0.05, train.preExitFrac * 0.05),
    });
  }
  rows.sort((a, b) => b.score - a.score || b.train.matches - a.train.matches);
  const selected = [];
  const perHour = new Map();
  for (const row of rows) {
    const hourKey = row.params.hour;
    const count = perHour.get(hourKey) || 0;
    if (count >= cfg.maxPerHour) continue;
    selected.push(row);
    perHour.set(hourKey, count + 1);
    if (selected.length >= cfg.maxSelected) break;
  }
  return { candidates: rows, selected };
}

function buildEvents(cycles, cfg, selected, baseSettings, context = {}) {
  const settings = defaultSimSettings({ ...baseSettings, cycleSeconds: cfg.cycleSeconds });
  const helpers = buildDynamicHelpers(cycles, settings, context);
  const selectedRules = selected.map((row) => ({ ...row, pWinEstimate: row.train.lcb }));
  const buckets = new Map();
  const paramsList = cfg.dynamic ? cfg.dynamicParams : null;
  for (const cycle of cycles) {
    const epoch = Number(cycle.epoch);
    const resolution = String(cycle.resolution || '').toUpperCase();
    if (resolution !== 'UP' && resolution !== 'DOWN') continue;
    const hour = new Date(epoch * 1000).getUTCHours();
    for (const rule of selectedRules) {
      const params = rule.params;
      const assetRule = String(params.asset || cfg.asset || 'ALL').toUpperCase();
      if (assetRule !== 'ALL' && String(cycle.asset || '').toUpperCase() !== assetRule) continue;
      if (params.hour !== -1 && params.hour !== hour) continue;
      const direction = cfg.dynamic ? dynamicDirection(cycle, cfg, helpers, params) : params.direction;
      if (direction !== 'UP' && direction !== 'DOWN') continue;
      if (cfg.dynamic && !paramsList?.length) continue;
      const minute = params.minute;
      const signalEntryPrice = priceAt(cycle, direction, minute);
      if (!(signalEntryPrice >= params.priceMin && signalEntryPrice <= params.priceMax)) continue;
      if (!passesBaseMicrostructure(cycle, direction, minute, signalEntryPrice, cfg, settings)) continue;
      if (!passesCustomFilter(cycle, direction, minute, signalEntryPrice, cfg, settings)) continue;
      if (!passesEdgeGuards(signalEntryPrice, rule.pWinEstimate, settings)) continue;
      const minOrderShares = Math.max(5, Math.ceil(toFiniteNumber(cycle.orderMinSize ?? cycle.yesMinOrderSize ?? cycle.noMinOrderSize, 5)));
      const timestamp = epoch + minute * 60;
      const event = {
        epoch,
        minute,
        timestamp,
        asset: cycle.asset,
        timeframe: cfg.timeframe,
        direction,
        signalEntryPrice,
        orderPrice: signalEntryPrice,
        oppositePrice: oppositePriceAt(cycle, direction, minute),
        spreadAbsDeviation: oppositePriceAt(cycle, direction, minute) > 0 ? Math.abs(signalEntryPrice + oppositePriceAt(cycle, direction, minute) - 1) : null,
        pWinEstimate: rule.pWinEstimate,
        resolutionWon: resolution === direction,
        strategy: `${cfg.id}:${rule.key}`,
        tier: cfg.id,
        minOrderShares,
        orderMinSize: minOrderShares,
        preResolutionExit: findPreResolutionExit(cycle, direction, settings, timestamp),
        noFillHash: stableHash(`${cfg.id}|${epoch}|${cycle.asset}|${minute}|${direction}`),
        packetHash: stableHash(`packet|${cfg.id}|${epoch}|${cycle.asset}|${minute}|${direction}`),
        netEdgeRoi: estimateNetEdgeRoi(signalEntryPrice, rule.pWinEstimate, settings),
        printCount: countAt(cycle, direction, minute),
        oppositePrintCount: oppositeCountAt(cycle, direction, minute),
        params,
        sourcePath: cycle.sourcePath,
      };
      if (!buckets.has(`${cfg.id}|${epoch}`)) buckets.set(`${cfg.id}|${epoch}`, []);
      buckets.get(`${cfg.id}|${epoch}`).push(event);
    }
  }
  const events = [];
  for (const [, signals] of [...buckets.entries()].sort((a, b) => Number(a[1][0].timestamp) - Number(b[1][0].timestamp))) {
    signals.sort((a, b) => {
      if (a.minute !== b.minute) return a.minute - b.minute;
      if (b.pWinEstimate !== a.pWinEstimate) return b.pWinEstimate - a.pWinEstimate;
      return (ASSET_RANK[a.asset] ?? 99) - (ASSET_RANK[b.asset] ?? 99);
    });
    events.push({ ...signals[0], cycleKey: `${signals[0].asset}|${signals[0].epoch}`, signalsInCycle: signals.length, suppressedSignals: signals.length - 1 });
  }
  return events.sort((a, b) => a.timestamp - b.timestamp);
}

function cycleLookupKey(event) {
  return `${event.sourcePath}|${event.asset}|${event.epoch}`;
}

function buildCycleLookup(...cycleLists) {
  const lookup = new Map();
  for (const cycles of cycleLists) {
    for (const cycle of cycles) lookup.set(`${cycle.sourcePath}|${cycle.asset}|${cycle.epoch}`, cycle);
  }
  return lookup;
}

function repriceEvent(event, cycle, cfg, settings, friction) {
  const latencyShiftMinutes = Math.max(0, Math.floor(toFiniteNumber(friction.latencyShiftMinutes, 0)));
  const delayedMinute = Number(event.minute) + latencyShiftMinutes;
  if (delayedMinute < 0 || delayedMinute >= Math.ceil(settings.cycleSeconds / 60)) return { rejected: true, reason: 'LATENCY_PAST_CYCLE' };
  const direction = event.direction;
  let actualPrice = priceAt(cycle, direction, delayedMinute);
  if (!(actualPrice > 0) || actualPrice >= 1) return { rejected: true, reason: 'MISSING_REPRICED_SNAPSHOT' };
  if (!passesBaseMicrostructure(cycle, direction, delayedMinute, actualPrice, cfg, settings)) return { rejected: true, reason: 'REPRICED_MICROSTRUCTURE_REJECT' };
  if (!passesEdgeGuards(actualPrice, event.pWinEstimate, settings)) return { rejected: true, reason: 'REPRICED_EDGE_REJECT' };
  const adverse = Number(friction.adverseFillCents || 0) / 100;
  if (adverse > 0) actualPrice += adverse;
  if (Number(friction.progressiveSlippagePer50Shares || 0) > 0) {
    const tentativeShares = getMaxAffordableSharesForEntry(100, actualPrice, settings.feeModel);
    const extra = Math.floor(Math.max(0, tentativeShares - 50) / 50) * Number(friction.progressiveSlippagePer50Shares);
    if (extra > 0) actualPrice += extra;
  }
  actualPrice = Math.min(0.999, Math.max(0.001, actualPrice));
  if (settings.hardEntryPriceCap > 0 && actualPrice > settings.hardEntryPriceCap) return { rejected: true, reason: 'REPRICED_HARD_CAP_REJECT' };
  if (!passesEdgeGuards(actualPrice, event.pWinEstimate, settings)) return { rejected: true, reason: 'REPRICED_ADVERSE_EDGE_REJECT' };
  const timestamp = Number(event.epoch) + delayedMinute * 60;
  return {
    ...event,
    originalMinute: event.minute,
    minute: delayedMinute,
    timestamp,
    latencyShifted: latencyShiftMinutes > 0,
    signalEntryPrice: actualPrice,
    orderPrice: actualPrice,
    oppositePrice: oppositePriceAt(cycle, direction, delayedMinute),
    spreadAbsDeviation: oppositePriceAt(cycle, direction, delayedMinute) > 0 ? Math.abs(actualPrice + oppositePriceAt(cycle, direction, delayedMinute) - 1) : null,
    preResolutionExit: findPreResolutionExit(cycle, direction, settings, timestamp),
    netEdgeRoi: estimateNetEdgeRoi(actualPrice, event.pWinEstimate, settings),
    printCount: countAt(cycle, direction, delayedMinute),
    oppositePrintCount: oppositeCountAt(cycle, direction, delayedMinute),
  };
}

function prepareEventsForFriction(events, cfg, settings, friction, cycleLookup) {
  const prepared = [];
  const rejects = {};
  for (const event of events) {
    const cycle = cycleLookup.get(cycleLookupKey(event));
    if (!cycle) {
      rejects.MISSING_CYCLE = (rejects.MISSING_CYCLE || 0) + 1;
      continue;
    }
    const repriced = repriceEvent(event, cycle, cfg, settings, friction);
    if (repriced.rejected) {
      rejects[repriced.reason] = (rejects[repriced.reason] || 0) + 1;
      continue;
    }
    prepared.push(repriced);
  }
  return { events: prepared.sort((a, b) => a.timestamp - b.timestamp), rejects };
}

function simulateFrictionSequence(events, cfg, startBank, baseSettings, friction, cycleLookup, prepricedRejects = null) {
  const settings = defaultSimSettings({ ...baseSettings, cycleSeconds: cfg.cycleSeconds });
  const prepared = prepricedRejects
    ? { events, rejects: prepricedRejects }
    : prepareEventsForFriction(events, cfg, settings, friction, cycleLookup);
  const adjustedEvents = prepared.events;
  const tradabilityFloor = computeTradabilityFloor(adjustedEvents, settings);
  let cash = startBank;
  let peak = startBank;
  let maxDD = 0;
  let cooldownUntil = -Infinity;
  let consecutiveLosses = 0;
  let executedTrades = 0;
  let wins = 0;
  let losses = 0;
  let preResolutionExits = 0;
  let blockedEntries = 0;
  let noFills = 0;
  let packetDrops = 0;
  let globalStopLossSkips = 0;
  let currentDayKey = null;
  let dayStartBalance = startBank;
  let todayPnL = 0;
  let dayStopped = false;
  const pendingReleases = [];
  const tradeLog = [];
  for (const event of adjustedEvents) {
    const timestamp = Number(event.timestamp || event.epoch || 0);
    pendingReleases.sort((a, b) => a.timestamp - b.timestamp);
    while (pendingReleases.length && pendingReleases[0].timestamp <= timestamp) cash += pendingReleases.shift().amount;
    const currentDay = dayKey(timestamp);
    if (currentDay !== currentDayKey) {
      currentDayKey = currentDay;
      dayStartBalance = cash;
      todayPnL = 0;
      dayStopped = false;
    }
    const stopLossPct = Number(settings.globalStopLoss);
    if (!dayStopped && stopLossPct > 0 && dayStartBalance > 0) {
      const usedLoss = Math.max(0, -todayPnL, dayStartBalance - cash);
      if (usedLoss + EPS >= dayStartBalance * stopLossPct) dayStopped = true;
    }
    if (dayStopped) {
      globalStopLossSkips += 1;
      continue;
    }
    if (timestamp < cooldownUntil) continue;
    if (event.packetHash < Number(friction.packetDropRate || 0)) {
      packetDrops += 1;
      continue;
    }
    if (event.noFillHash < Number(friction.noFillRate || 0)) {
      noFills += 1;
      continue;
    }
    const openTrade = computeTradeOpen(cash, peak, event, settings);
    if (openTrade.blocked) {
      blockedEntries += 1;
      if (cash + EPS < tradabilityFloor) break;
      continue;
    }
    cash -= Number(openTrade.entryDebit || openTrade.cost || 0);
    const closeTrade = computeTradeClose(openTrade, event, settings);
    let pnl = closeTrade.pnl;
    if (closeTrade.reason === 'RESOLVED_WIN' && Number(friction.redemptionGasUsd || 0) > 0) pnl -= Number(friction.redemptionGasUsd);
    if (closeTrade.reason === 'RESOLVED_WIN' && Number(friction.lockupWinSeconds || 0) > 0) {
      const payout = Math.max(0, closeTrade.payout - Number(friction.redemptionGasUsd || 0));
      pendingReleases.push({ timestamp: closeTrade.closeTimestamp + Number(friction.lockupWinSeconds), amount: payout });
    } else {
      cash += Math.max(0, closeTrade.payout - (closeTrade.reason === 'RESOLVED_WIN' ? Number(friction.redemptionGasUsd || 0) : 0));
    }
    todayPnL += pnl;
    executedTrades += 1;
    if (closeTrade.reason === 'PRE_RESOLUTION_EXIT') preResolutionExits += 1;
    if (pnl >= -EPS) {
      wins += 1;
      consecutiveLosses = 0;
    } else {
      losses += 1;
      consecutiveLosses += 1;
      if (consecutiveLosses >= settings.maxConsecutiveLosses) {
        cooldownUntil = closeTrade.closeTimestamp + settings.cooldownSeconds;
        consecutiveLosses = 0;
      }
    }
    if (cash > peak) peak = cash;
    const dd = peak > 0 ? (peak - cash) / peak : 0;
    if (dd > maxDD) maxDD = dd;
    if (tradeLog.length < 50) {
      tradeLog.push({
        ts: iso(event.timestamp),
        asset: event.asset,
        direction: event.direction,
        minute: event.minute,
        originalMinute: event.originalMinute,
        entry: event.orderPrice,
        shares: openTrade.shares,
        pnl,
        cash,
        closeReason: closeTrade.reason,
      });
    }
  }
  for (const release of pendingReleases) cash += release.amount;
  return {
    final: cash,
    peak,
    maxDD,
    trades: executedTrades,
    wins,
    losses,
    blockedEntries,
    preResolutionExits,
    globalStopLossSkips,
    noFills,
    packetDrops,
    winRate: executedTrades > 0 ? wins / executedTrades : 0,
    busted: cash + EPS < tradabilityFloor,
    tradabilityFloor,
    repricedRejects: prepared.rejects,
    repricedEvents: adjustedEvents.length,
    tradeLog,
  };
}

function buildWindows(events, horizonHours) {
  if (!events.length) return [];
  const horizonSeconds = horizonHours * 3600;
  const windows = [];
  let endIdx = 0;
  for (let startIdx = 0; startIdx < events.length; startIdx += 1) {
    const startTs = events[startIdx].timestamp;
    while (endIdx < events.length && events[endIdx].timestamp < startTs + horizonSeconds) endIdx += 1;
    if (endIdx > startIdx) windows.push({ startIdx, endIdx });
  }
  return windows;
}

function buildPreparedWindows(sourceEvents, preparedEvents, horizonHours) {
  if (!sourceEvents.length) return [];
  const horizonSeconds = horizonHours * 3600;
  const sourceWindows = buildWindows(sourceEvents, horizonHours);
  const out = [];
  let startIdx = 0;
  let endIdx = 0;
  for (const window of sourceWindows) {
    const startTs = Number(sourceEvents[window.startIdx].timestamp);
    const endTs = startTs + horizonSeconds;
    while (startIdx < preparedEvents.length && Number(preparedEvents[startIdx].timestamp) < startTs) startIdx += 1;
    if (endIdx < startIdx) endIdx = startIdx;
    while (endIdx < preparedEvents.length && Number(preparedEvents[endIdx].timestamp) < endTs) endIdx += 1;
    out.push({ startIdx, endIdx });
  }
  return out;
}

function simulateBootstrapFriction(events, cfg, start, horizonHours, settings, friction, runs, cycleLookup) {
  const frictionSettings = defaultSimSettings({ ...settings, cycleSeconds: cfg.cycleSeconds });
  const prepared = prepareEventsForFriction(events, cfg, frictionSettings, friction, cycleLookup);
  const windows = buildPreparedWindows(events, prepared.events, horizonHours);
  const results = [];
  if (!windows.length) {
    results.push(simulateFrictionSequence(prepared.events, cfg, start, settings, friction, cycleLookup, prepared.rejects));
    return { summary: summarizeRuns(results), results, preparedRejects: prepared.rejects };
  }
  for (let i = 0; i < runs; i += 1) {
    const window = windows[Math.floor(stableHash(`${i}|${start}|${horizonHours}|${events.length}|${cfg.id}`) * windows.length)];
    results.push(simulateFrictionSequence(prepared.events.slice(window.startIdx, window.endIdx), cfg, start, settings, friction, cycleLookup, {}));
  }
  return { summary: summarizeRuns(results), results, preparedRejects: prepared.rejects };
}

function aggregateRejects(results) {
  const out = {};
  for (const result of results) {
    for (const [key, value] of Object.entries(result.repricedRejects || {})) out[key] = (out[key] || 0) + Number(value || 0);
  }
  return out;
}

function runtimeCompatibility(cfg) {
  const blockers = [];
  if (cfg.dynamic) blockers.push(`dynamic_direction:${cfg.dynamic}`);
  if (cfg.filter) blockers.push(`historical_filter:${cfg.filter}`);
  if (cfg.requireOppositePrint) blockers.push('historical_opposite_print_count');
  if (cfg.requirePrints) blockers.push('historical_target_print_count');
  if (Number.isFinite(Number(cfg.maxSpreadDeviation))) blockers.push('spread_deviation_matcher_extension');
  return {
    existingMatcherCompatible: blockers.length === 0,
    blockers,
    matcher: 'lib/strategy-matcher.js',
  };
}

function evaluateApproach(cfg, trainCycles, holdoutCycles, settings, frictionProfiles, starts, horizons, runs, cycleLookup, context = {}) {
  const selectedInfo = selectCandidates(trainCycles, holdoutCycles, cfg, settings, context);
  const trainEvents = buildEvents(trainCycles, cfg, selectedInfo.selected, settings, context);
  const events = buildEvents(holdoutCycles, cfg, selectedInfo.selected, settings, context);
  const result = {
    id: cfg.id,
    name: cfg.name,
    category: cfg.category,
    timeframe: cfg.timeframe,
    dataScope: cfg.dataScope,
    deployableData: !!cfg.deployableData,
    logic: cfg.logic,
    runtimeCompatibility: runtimeCompatibility(cfg),
    cycles: { train: trainCycles.length, holdout: holdoutCycles.length },
    candidatesFound: selectedInfo.candidates.length,
    selectedCount: selectedInfo.selected.length,
    selected: selectedInfo.selected.map((row) => ({
      key: row.key,
      params: row.params,
      train: row.train,
      holdout: row.holdout,
      holdoutEvUsingTrain: row.holdoutEvUsingTrain,
    })),
    eventSurface: {
      trainEvents: trainEvents.length,
      holdoutEvents: events.length,
      holdoutDays: [...new Set(events.map((event) => dayKey(event.timestamp)))].filter(Boolean).length,
      preResolutionExitEvents: events.filter((event) => event.preResolutionExit).length,
      avgEntry: events.length ? events.reduce((sum, event) => sum + event.signalEntryPrice, 0) / events.length : 0,
      holdoutWR: events.length ? events.filter((event) => event.resolutionWon).length / events.length : 0,
    },
    simulations: {},
    samples: events.slice(0, 30),
  };
  for (const [frictionName, friction] of Object.entries(frictionProfiles)) {
    result.simulations[frictionName] = {};
    for (const start of starts) {
      result.simulations[frictionName][String(start)] = {};
      for (const horizon of horizons) {
        const detailed = simulateBootstrapFriction(events, cfg, start, horizon, { ...settings, cycleSeconds: cfg.cycleSeconds }, friction, runs, cycleLookup);
        result.simulations[frictionName][String(start)][String(horizon)] = {
          ...detailed.summary,
          probabilityGte20: detailed.results.length ? detailed.results.filter((run) => run.final >= 20).length / detailed.results.length : 0,
          probabilityGte100: detailed.results.length ? detailed.results.filter((run) => run.final >= 100).length / detailed.results.length : 0,
          probabilityGte500: detailed.results.length ? detailed.results.filter((run) => run.final >= 500).length / detailed.results.length : 0,
          medianNoFills: quantile(detailed.results.map((run) => run.noFills || 0), 0.5),
          medianPacketDrops: quantile(detailed.results.map((run) => run.packetDrops || 0), 0.5),
          medianRepricedEvents: quantile(detailed.results.map((run) => run.repricedEvents || 0), 0.5),
          repricedRejects: detailed.preparedRejects || aggregateRejects(detailed.results),
          firstTradeSamples: detailed.results.find((run) => run.tradeLog?.length)?.tradeLog?.slice(0, 3) || [],
        };
      }
    }
  }
  return result;
}

function getApproachDefs() {
  const common15 = {
    timeframe: '15m',
    cycleSeconds: 900,
    hours: Array.from({ length: 24 }, (_, i) => i),
    directions: ['UP', 'DOWN'],
    minTrainMatches: 24,
    minTrainDays: 5,
    minTrainLcb: 0.70,
    minTrainEvRoi: 0.02,
    maxNoPrintFrac: 0.20,
    maxSelected: 12,
    maxPerHour: 1,
    requirePrints: true,
    requireOpposite: true,
    requireOppositePrint: false,
    maxSpreadDeviation: 0.08,
    dataScope: 'fresh_15m_apr11_apr26_roll7d_oos',
    deployableData: true,
  };
  const common5 = {
    timeframe: '5m',
    cycleSeconds: 300,
    hours: Array.from({ length: 24 }, (_, i) => i),
    directions: ['UP', 'DOWN'],
    minTrainMatches: 36,
    minTrainDays: 5,
    minTrainLcb: 0.62,
    minTrainEvRoi: 0.03,
    maxNoPrintFrac: 0.25,
    maxSelected: 12,
    maxPerHour: 1,
    requirePrints: true,
    requireOpposite: true,
    requireOppositePrint: false,
    maxSpreadDeviation: 0.08,
    dataScope: 'fresh_5m_roll1d_oos',
    deployableData: true,
  };
  const common4 = {
    timeframe: '4h',
    cycleSeconds: 14400,
    hours: Array.from({ length: 24 }, (_, i) => i),
    directions: ['UP', 'DOWN'],
    minTrainMatches: 8,
    minTrainDays: 4,
    minTrainLcb: 0.58,
    minTrainEvRoi: 0.02,
    maxNoPrintFrac: 0.30,
    maxSelected: 8,
    maxPerHour: 2,
    requirePrints: true,
    requireOpposite: true,
    requireOppositePrint: false,
    maxSpreadDeviation: 0.10,
    dataScope: 'fresh_4h_roll7d_oos',
    deployableData: true,
  };
  return [
    {
      ...common15,
      id: 'sol_h20_seed_expansion',
      name: 'SOL H20 Seed Expansion',
      category: 'sol_sparse_seed',
      logic: 'Expand the prior SOL H20 sparse lead around UTC hour 20 using train-only selection and fresh chronological holdout.',
      asset: 'SOL',
      hours: [19, 20, 21],
      minutes: [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
      bands: [[0.42, 0.60], [0.48, 0.66], [0.54, 0.72], [0.60, 0.80]],
      minTrainMatches: 6,
      minTrainDays: 3,
      minTrainLcb: 0.42,
      minTrainEvRoi: -0.05,
      maxSelected: 8,
      maxPerHour: 3,
    },
    {
      ...common15,
      id: 'time_of_day_volatility_regime',
      name: 'Time-of-Day Volatility Regime',
      category: 'volatility_regime',
      logic: 'Cluster-like proxy: only mine hours where the selected side shows large early realized range before entry.',
      minutes: [3, 4, 5, 6, 7, 8],
      bands: [[0.35, 0.55], [0.45, 0.65], [0.55, 0.75]],
      filter: 'early_realized_volatility',
      minTrainMatches: 12,
      minTrainLcb: 0.52,
      minTrainEvRoi: 0.00,
      maxSelected: 12,
    },
    {
      ...common15,
      id: 'theta_decay_final_minutes',
      name: 'Theta Decay Final-Minute Sniping',
      category: 'time_decay',
      logic: 'Buy the side already in a profitable mid-price band during minutes 10-13 and require historical pre-resolution exit evidence.',
      minutes: [10, 11, 12, 13],
      bands: [[0.55, 0.70], [0.60, 0.75], [0.65, 0.82]],
      filter: 'pre_exit_seen',
      minTrainLcb: 0.68,
    },
    {
      ...common15,
      id: 'low_entry_convexity',
      name: 'Low-Entry Convexity Harvest',
      category: 'low_entry_growth',
      logic: 'Search lower entry bands where a win has high unit ROI and require Wilson-LCB EV after fees and slippage.',
      minutes: [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
      bands: [[0.25, 0.45], [0.30, 0.50], [0.35, 0.55], [0.40, 0.60], [0.45, 0.65], [0.50, 0.70]],
      minTrainMatches: 18,
      minTrainLcb: 0.62,
      minTrainEvRoi: 0.08,
    },
    {
      ...common15,
      id: 'spread_convergence_orderbook_proxy',
      name: 'Adversarial Spread-Convergence Proxy',
      category: 'orderbook_proxy',
      logic: 'Use yes/no minute prices as a historical orderbook proxy and accept only tight yes+no convergence.',
      minutes: [3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
      bands: [[0.50, 0.65], [0.55, 0.70], [0.60, 0.75]],
      maxSpreadDeviation: 0.02,
      requireOppositePrint: true,
      minTrainLcb: 0.64,
    },
    {
      ...common15,
      id: 'high_lcb_sparse_spread_convergence',
      name: 'High-LCB Sparse Spread-Convergence',
      category: 'orderbook_proxy',
      logic: 'Restrict spread-convergence to sparse train-only high Wilson-LCB rules before any holdout evaluation.',
      minutes: [3, 4],
      bands: [[0.60, 0.75]],
      maxSpreadDeviation: 0.02,
      requireOppositePrint: true,
      minTrainMatches: 24,
      minTrainLcb: 0.78,
      minTrainEvRoi: 0.08,
      maxSelected: 4,
    },
    {
      ...common15,
      id: 'print_imbalance_l2_proxy',
      name: 'L2 Print-Imbalance Proxy',
      category: 'l2_imbalance_proxy',
      logic: 'Treat trade-print imbalance as a proxy for executable pressure and buy only when target prints dominate opposite prints.',
      minutes: [4, 5, 6, 7, 8, 9, 10, 11, 12],
      bands: [[0.45, 0.65], [0.50, 0.70], [0.55, 0.75], [0.60, 0.80]],
      filter: 'print_imbalance',
      minTrainMatches: 14,
      minTrainLcb: 0.62,
    },
    {
      ...common15,
      id: 'early_breakout_follow',
      name: 'Early Micro-Breakout Follow',
      category: 'early_momentum',
      logic: 'Trade minutes 1-4 only when the side price moved up from minute 0 and continues upward into an affordable band.',
      minutes: [1, 2, 3, 4],
      bands: [[0.52, 0.62], [0.55, 0.68], [0.58, 0.72]],
      filter: 'early_breakout',
      minTrainMatches: 12,
      minTrainLcb: 0.58,
    },
    {
      ...common15,
      id: 'late_extreme_inversion',
      name: 'Adversarial Inversion of Expensive Consensus',
      category: 'inversion_logic',
      logic: 'When one side is expensive late in-cycle, buy the cheap opposite side only if it remains convex and affordable.',
      minutes: [9, 10, 11, 12, 13],
      bands: [[0.05, 0.18], [0.08, 0.22], [0.10, 0.28], [0.15, 0.32]],
      filter: 'late_inversion_low_side',
      minTrainMatches: 12,
      minTrainLcb: 0.18,
      minTrainEvRoi: -0.25,
      maxSelected: 8,
    },
    {
      ...common15,
      id: 'previous_cycle_streak_fade',
      name: 'Previous-Cycle Streak Fade',
      category: 'streak_reversion',
      logic: 'If the same asset resolved the same way in the previous two cycles, buy the opposite direction in a tradable band.',
      dynamic: 'streak_fade',
      dynamicParams: [5, 6, 7, 8, 9, 10, 11, 12].flatMap((minute) => [[0.45, 0.65], [0.50, 0.70], [0.55, 0.73]].map(([priceMin, priceMax]) => ({ hour: -1, minute, priceMin, priceMax }))),
      minTrainMatches: 20,
      minTrainLcb: 0.54,
      minTrainEvRoi: 0.00,
    },
    {
      ...common15,
      id: 'cross_asset_latency_previous_majority',
      name: 'Cross-Asset Previous-Majority Latency Proxy',
      category: 'cross_asset_latency',
      logic: 'Use the previous 15m cycle majority direction across BTC/ETH/SOL/XRP as a latency proxy for the next cycle direction.',
      dynamic: 'cross_asset_prev_majority',
      dynamicParams: [2, 3, 4, 5, 6, 7, 8, 9].flatMap((minute) => [[0.45, 0.65], [0.50, 0.70], [0.55, 0.75]].map(([priceMin, priceMax]) => ({ hour: -1, minute, priceMin, priceMax }))),
      minTrainMatches: 30,
      minTrainLcb: 0.54,
      minTrainEvRoi: 0.00,
    },
    {
      ...common15,
      id: 'one_minute_momentum_reprice',
      name: 'One-Minute Momentum Reprice',
      category: 'latency_momentum',
      logic: 'Enter only when the latest minute price has risen versus the prior minute, then stress with actual delayed snapshot repricing.',
      minutes: [2, 3, 4, 5, 6, 7, 8],
      bands: [[0.48, 0.62], [0.52, 0.68], [0.56, 0.74]],
      filter: 'one_minute_momentum',
      minTrainMatches: 16,
      minTrainLcb: 0.58,
      minTrainEvRoi: 0.00,
    },
    {
      ...common15,
      id: 'open_reversal_convexity',
      name: 'Open-Reversal Convexity',
      category: 'mean_reversion',
      logic: 'Buy a side that sold off sharply from minute 0 into a low-price convex band, testing whether early overreaction reverses.',
      minutes: [3, 4, 5, 6, 7, 8, 9, 10],
      bands: [[0.18, 0.32], [0.22, 0.38], [0.25, 0.45]],
      filter: 'open_reversal',
      minTrainMatches: 12,
      minTrainLcb: 0.32,
      minTrainEvRoi: -0.10,
      maxSelected: 8,
    },
    {
      ...common15,
      id: 'multi_minute_momentum_path',
      name: 'Multi-Minute In-Cycle Momentum Path',
      category: 'trajectory_momentum',
      logic: 'Require a two-minute monotonic side-price climb and mine the path feature rather than a single static minute.',
      minutes: [2, 3, 4, 5, 6, 7, 8, 9],
      bands: [[0.42, 0.58], [0.48, 0.64], [0.54, 0.72]],
      filter: 'multi_minute_momentum',
      minTrainMatches: 12,
      minTrainLcb: 0.56,
      minTrainEvRoi: 0.00,
      maxSelected: 12,
    },
    {
      ...common15,
      id: 'pre_resolution_exit_harvest',
      name: 'Pre-Resolution Exit Harvest',
      category: 'pre_resolution_exit',
      logic: 'Mine entries whose historical winners often reached a 95c pre-resolution exit window before settlement.',
      minutes: [6, 7, 8, 9, 10, 11, 12],
      bands: [[0.42, 0.58], [0.48, 0.66], [0.54, 0.74], [0.60, 0.82]],
      filter: 'pre_exit_seen',
      minTrainMatches: 10,
      minTrainLcb: 0.54,
      minTrainEvRoi: 0.00,
      maxSelected: 12,
      maxPerHour: 2,
    },
    {
      ...common15,
      id: 'cross_asset_leader_follow',
      name: 'Cross-Asset Leader Follow',
      category: 'cross_asset_leading_indicator',
      logic: 'Use BTC/ETH/SOL/XRP resolution from one or two prior cycles as a leader signal for the current asset.',
      dynamic: 'cross_asset_leader_follow',
      dynamicParams: ['BTC', 'ETH', 'SOL', 'XRP'].flatMap((leaderAsset) => [1, 2].flatMap((lagCycles) => [2, 3, 4, 5, 6, 7, 8].flatMap((minute) => [[0.40, 0.60], [0.48, 0.68], [0.55, 0.75]].map(([priceMin, priceMax]) => ({ hour: -1, minute, priceMin, priceMax, leaderAsset, lagCycles }))))),
      minTrainMatches: 20,
      minTrainLcb: 0.54,
      minTrainEvRoi: 0.00,
      maxSelected: 12,
    },
    {
      ...common15,
      id: 'cross_asset_leader_fade',
      name: 'Cross-Asset Leader Fade',
      category: 'cross_asset_leading_indicator',
      logic: 'Invert prior-cycle leader signals to test whether apparent cross-asset continuation is a trap.',
      dynamic: 'cross_asset_leader_fade',
      dynamicParams: ['BTC', 'ETH', 'SOL', 'XRP'].flatMap((leaderAsset) => [1, 2].flatMap((lagCycles) => [2, 3, 4, 5, 6, 7, 8].flatMap((minute) => [[0.25, 0.45], [0.35, 0.55], [0.45, 0.65]].map(([priceMin, priceMax]) => ({ hour: -1, minute, priceMin, priceMax, leaderAsset, lagCycles }))))),
      minTrainMatches: 20,
      minTrainLcb: 0.50,
      minTrainEvRoi: -0.03,
      maxSelected: 12,
    },
    {
      ...common15,
      id: 'three_streak_follow',
      name: 'Three-Cycle Streak Follow',
      category: 'cycle_streak_patterns',
      logic: 'After three same-direction same-asset resolutions, test continuation in tradable mid-price bands.',
      dynamic: 'streak_follow3',
      dynamicParams: [3, 4, 5, 6, 7, 8, 9, 10].flatMap((minute) => [[0.42, 0.62], [0.50, 0.70], [0.58, 0.78]].map(([priceMin, priceMax]) => ({ hour: -1, minute, priceMin, priceMax }))),
      minTrainMatches: 10,
      minTrainLcb: 0.50,
      minTrainEvRoi: -0.02,
      maxSelected: 10,
    },
    {
      ...common15,
      id: 'three_streak_fade',
      name: 'Three-Cycle Streak Fade',
      category: 'cycle_streak_patterns',
      logic: 'After three same-direction same-asset resolutions, buy the opposite side when convex and affordable.',
      dynamic: 'streak_fade3',
      dynamicParams: [3, 4, 5, 6, 7, 8, 9, 10].flatMap((minute) => [[0.22, 0.42], [0.30, 0.50], [0.40, 0.62]].map(([priceMin, priceMax]) => ({ hour: -1, minute, priceMin, priceMax }))),
      minTrainMatches: 8,
      minTrainLcb: 0.38,
      minTrainEvRoi: -0.10,
      maxSelected: 10,
    },
    {
      ...common15,
      id: 'four_hour_bias_15m_follow',
      name: '4h Bias Filters 15m Follow',
      category: 'multi_timeframe_stacking',
      logic: 'Use only the previous completed 4h resolution as a directional filter for current 15m entries.',
      dynamic: 'previous_4h_bias_follow',
      dynamicParams: [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].flatMap((minute) => [[0.42, 0.62], [0.50, 0.70], [0.58, 0.78]].map(([priceMin, priceMax]) => ({ hour: -1, minute, priceMin, priceMax }))),
      minTrainMatches: 20,
      minTrainLcb: 0.52,
      minTrainEvRoi: -0.01,
      maxSelected: 12,
    },
    {
      ...common15,
      id: 'four_hour_bias_15m_fade',
      name: '4h Bias Filters 15m Fade',
      category: 'multi_timeframe_stacking',
      logic: 'Fade the previous completed 4h resolution when the opposite 15m side is still convex and tradable.',
      dynamic: 'previous_4h_bias_fade',
      dynamicParams: [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].flatMap((minute) => [[0.22, 0.42], [0.30, 0.50], [0.40, 0.62]].map(([priceMin, priceMax]) => ({ hour: -1, minute, priceMin, priceMax }))),
      minTrainMatches: 16,
      minTrainLcb: 0.40,
      minTrainEvRoi: -0.08,
      maxSelected: 12,
    },
    {
      ...common15,
      id: 'opposite_breakout_fade',
      name: 'Adversarial Opposite-Breakout Fade',
      category: 'adversarial_inversion',
      logic: 'Find early opposite-side breakouts that historically fail, then buy the cheap fading side.',
      minutes: [2, 3, 4, 5, 6, 7, 8],
      bands: [[0.15, 0.32], [0.22, 0.40], [0.30, 0.48]],
      filter: 'opposite_early_breakout_fade',
      minTrainMatches: 8,
      minTrainLcb: 0.28,
      minTrainEvRoi: -0.18,
      maxSelected: 10,
    },
    {
      ...common5,
      id: 'five_minute_spread_convergence',
      name: '5m Tight Spread-Convergence',
      category: '5m_orderbook_proxy',
      logic: 'Mine 5m cycles for early tight yes/no convergence in executable mid-price bands.',
      minutes: [1, 2, 3],
      bands: [[0.48, 0.62], [0.52, 0.68], [0.56, 0.74], [0.60, 0.80]],
      maxSpreadDeviation: 0.02,
      requireOppositePrint: true,
      minTrainLcb: 0.60,
    },
    {
      ...common5,
      id: 'five_minute_micro_momentum',
      name: '5m Micro Momentum Reprice',
      category: '5m_momentum',
      logic: 'Enter only when a 5m side has strengthened versus the previous minute, then stress with delayed-minute repricing.',
      minutes: [1, 2, 3],
      bands: [[0.45, 0.62], [0.50, 0.70], [0.55, 0.78]],
      filter: 'one_minute_momentum',
      minTrainMatches: 28,
      minTrainLcb: 0.58,
      minTrainEvRoi: 0.00,
    },
    {
      ...common5,
      id: 'five_minute_print_imbalance',
      name: '5m Print-Imbalance Proxy',
      category: '5m_l2_imbalance_proxy',
      logic: 'Use 5m trade-print imbalance as a lightweight order-flow proxy in affordable bands.',
      minutes: [1, 2, 3],
      bands: [[0.40, 0.60], [0.45, 0.65], [0.50, 0.72]],
      filter: 'print_imbalance',
      minTrainMatches: 20,
      minTrainLcb: 0.56,
      minTrainEvRoi: 0.00,
      maxSelected: 10,
    },
    {
      ...common5,
      id: 'five_minute_streak_fade',
      name: '5m Previous-Cycle Streak Fade',
      category: '5m_streak_reversion',
      logic: 'Fade two same-direction resolved 5m cycles on the same asset when the opposite side is still tradable.',
      dynamic: 'streak_fade',
      dynamicParams: [1, 2, 3].flatMap((minute) => [[0.42, 0.62], [0.48, 0.68], [0.54, 0.76]].map(([priceMin, priceMax]) => ({ hour: -1, minute, priceMin, priceMax }))),
      minTrainMatches: 24,
      minTrainLcb: 0.54,
      minTrainEvRoi: 0.00,
    },
    {
      ...common4,
      id: 'four_hour_intracycle_momentum',
      name: '4h Intracycle Momentum',
      category: '4h_momentum',
      logic: 'Trade 4h mid-cycle momentum only when the side has improved versus the previous minute and remains below the hard cap.',
      minutes: [30, 60, 90, 120, 150, 180, 210],
      bands: [[0.45, 0.62], [0.50, 0.70], [0.55, 0.78]],
      filter: 'one_minute_momentum',
      minTrainMatches: 8,
      minTrainLcb: 0.56,
      minTrainEvRoi: 0.00,
    },
    {
      ...common4,
      id: 'four_hour_spread_convergence',
      name: '4h Spread-Convergence Proxy',
      category: '4h_orderbook_proxy',
      logic: 'Use refreshed 4h yes/no minute convergence as a historical proxy for executable consensus.',
      minutes: [30, 60, 90, 120, 150, 180, 210],
      bands: [[0.50, 0.65], [0.55, 0.72], [0.60, 0.80]],
      maxSpreadDeviation: 0.03,
      requireOppositePrint: true,
      minTrainMatches: 8,
      minTrainLcb: 0.56,
      minTrainEvRoi: 0.00,
    },
    {
      ...common4,
      id: 'four_hour_low_entry_convexity',
      name: '4h Low-Entry Convexity',
      category: '4h_low_entry_growth',
      logic: 'Search 4h lower entry bands where a win can materially accelerate micro-bankroll compounding.',
      minutes: [60, 90, 120, 150, 180, 210],
      bands: [[0.22, 0.38], [0.28, 0.45], [0.35, 0.55], [0.42, 0.62]],
      minTrainMatches: 6,
      minTrainLcb: 0.42,
      minTrainEvRoi: -0.05,
      maxSelected: 8,
    },
  ];
}

function getFrictionProfiles() {
  return {
    strict_repriced_latency: {
      label: 'Strict repriced latency baseline',
      noFillRate: 0.107,
      packetDropRate: 0.01,
      adverseFillCents: 1,
      lockupWinSeconds: 900,
      redemptionGasUsd: 0.01,
      progressiveSlippagePer50Shares: 0.0025,
      latencyShiftMinutes: 1,
    },
    adverse_repriced_latency: {
      label: 'Adversarial repriced latency',
      noFillRate: 0.18,
      packetDropRate: 0.03,
      adverseFillCents: 2,
      lockupWinSeconds: 1800,
      redemptionGasUsd: 0.05,
      progressiveSlippagePer50Shares: 0.005,
      latencyShiftMinutes: 1,
    },
    no_latency_control: {
      label: 'No-latency control',
      noFillRate: 0.107,
      packetDropRate: 0.01,
      adverseFillCents: 1,
      lockupWinSeconds: 900,
      redemptionGasUsd: 0.01,
      progressiveSlippagePer50Shares: 0.0025,
      latencyShiftMinutes: 0,
    },
    combined_worst_repriced_latency: {
      label: 'Combined worst repriced latency',
      noFillRate: 0.25,
      packetDropRate: 0.15,
      adverseFillCents: 4,
      lockupWinSeconds: 1800,
      redemptionGasUsd: 0.05,
      progressiveSlippagePer50Shares: 0.005,
      latencyShiftMinutes: 1,
    },
  };
}

function rankingRows(evaluated) {
  return evaluated.map((approach) => {
    const strict10 = approach.simulations.strict_repriced_latency?.['10']?.['168'] || {};
    const strict7 = approach.simulations.strict_repriced_latency?.['7']?.['168'] || {};
    const strict5 = approach.simulations.strict_repriced_latency?.['5']?.['168'] || {};
    const adverse10 = approach.simulations.adverse_repriced_latency?.['10']?.['168'] || {};
    const worst10 = approach.simulations.combined_worst_repriced_latency?.['10']?.['168'] || {};
    const noTradePenalty = approach.selectedCount <= 0 || approach.eventSurface.holdoutEvents <= 0 || Number(strict10.medianTrades || 0) <= 0 ? 10000 : 0;
    const liveDataPenalty = approach.deployableData ? 0 : 1000;
    const bustPenalty = Number(strict10.bust || 100) * 2 + Number(strict5.bust || 100) + Number(adverse10.bust || 100);
    const score = Number(strict10.median || 0) + Number(strict7.median || 0) * 0.25 + Number(strict5.median || 0) * 0.1 - bustPenalty - noTradePenalty - liveDataPenalty;
    return {
      id: approach.id,
      name: approach.name,
      category: approach.category,
      deployableData: approach.deployableData,
      existingMatcherCompatible: !!approach.runtimeCompatibility?.existingMatcherCompatible,
      runtimeBlockers: approach.runtimeCompatibility?.blockers || [],
      selectedCount: approach.selectedCount,
      holdoutEvents: approach.eventSurface.holdoutEvents,
      holdoutWR: approach.eventSurface.holdoutWR,
      avgEntry: approach.eventSurface.avgEntry,
      score,
      start5StrictMedian: Number(strict5.median) || 0,
      start5StrictBust: Number(strict5.bust) || 100,
      start7StrictMedian: Number(strict7.median) || 0,
      start7StrictBust: Number(strict7.bust) || 100,
      start10StrictMedian: Number(strict10.median) || 0,
      start10StrictBust: Number(strict10.bust) || 100,
      start10StrictMedianTrades: Number(strict10.medianTrades) || 0,
      start10AdverseMedian: Number(adverse10.median) || 0,
      start10AdverseBust: Number(adverse10.bust) || 100,
      start10WorstMedian: Number(worst10.median) || 0,
      start10WorstBust: Number(worst10.bust) || 100,
      repricedRejectsStrict10: strict10.repricedRejects || {},
    };
  }).sort((a, b) => b.score - a.score);
}

function verdictFromRanking(ranking, liveStatus) {
  const best = ranking.find((row) => row.deployableData && row.start10StrictMedianTrades > 0);
  if (!best) return 'NO-GO: no deployable-data approach produced executable $10 strict repriced-latency trades.';
  const pass =
    best.start5StrictBust <= 10 &&
    best.start7StrictBust <= 7 &&
    best.start10StrictBust <= 5 &&
    best.start10StrictMedian > 10 &&
    best.start10AdverseBust <= 10 &&
    best.start10WorstBust <= 20;
  if (!pass) {
    return `NO-GO: best deployable approach ${best.id} failed the corrected micro-bankroll gate under repriced latency ($5 bust ${best.start5StrictBust.toFixed(2)}%, $7 bust ${best.start7StrictBust.toFixed(2)}%, $10 strict median $${best.start10StrictMedian.toFixed(2)}, adverse bust ${best.start10AdverseBust.toFixed(2)}%).`;
  }
  if (!best.existingMatcherCompatible) {
    return `RUNTIME-SUPPORT REQUIRED: ${best.id} passed the local corrected proxy gate, but current lib/strategy-matcher.js cannot enforce required filters (${(best.runtimeBlockers || []).join(', ') || 'unknown blockers'}). Do not deploy as a static JSON-only set.`;
  }
  if (liveStatus.health !== 'VERIFIED') {
    return `SUPERVISED PAPER-ONLY: ${best.id} passed the local corrected proxy gate, but live /api health/status/balance were not verified in this run.`;
  }
  return `CONDITIONAL PAPER-FORWARD CANDIDATE: ${best.id} passed local corrected proxy gates. Live L2/fill proof is still required before autonomous live trading.`;
}

function splitIsStale(cycles, maxAgeSeconds) {
  if (!Array.isArray(cycles) || cycles.length === 0) return true;
  const maxEpoch = Math.max(...cycles.map((cycle) => Number(cycle.epoch)).filter(Number.isFinite));
  if (!Number.isFinite(maxEpoch)) return true;
  return Math.floor(Date.now() / 1000) - maxEpoch > maxAgeSeconds;
}

function buildLiveStatus() {
  const health = String(process.env.FINAL_LIVE_HEALTH || '').trim() || 'UNVERIFIED';
  const summary = String(process.env.FINAL_LIVE_SUMMARY || '').trim()
    || 'Live endpoints /api/health, /api/status, and /api/wallet/balance were not verified inside this local harness process.';
  return { health, summary };
}

function markdownReport(payload) {
  const lines = [];
  lines.push('# EPOCH 3 Final Reinvestigation Harness');
  lines.push('');
  lines.push(`Generated: ${payload.generatedAt}`);
  lines.push('');
  lines.push('## Data source statement');
  lines.push(`- **Live runtime status**: ${payload.liveStatus.summary}`);
  lines.push('- **Local proof source**: local intracycle JSON archives and runtime-parity fee/sizing functions.');
  lines.push('- **Latency correction**: delayed entries are repriced from the later minute snapshot before sizing, edge gates, and close logic.');
  lines.push('- **Remaining missing proof**: no historical L2 replay or real fill ledger is present.');
  lines.push('');
  lines.push('## Dataset inventory');
  for (const item of payload.datasetInventory) {
    lines.push(`- **${item.path}**: ${item.items} items, ${item.timeframe || 'unknown'}, ${item.minIso || 'n/a'} -> ${item.maxIso || 'n/a'}, mtime=${item.mtime}, orderMins=${JSON.stringify(item.orderMins)}, exact0.50=${item.exactPoint50Slots.pct === null ? 'n/a' : (item.exactPoint50Slots.pct * 100).toFixed(3) + '%'}`);
  }
  lines.push('');
  lines.push('## Split');
  for (const [key, value] of Object.entries(payload.split)) lines.push(`- **${key}**: ${value.count} cycles, ${value.start || 'n/a'} -> ${value.end || 'n/a'}${value.stale ? ', STALE/CONTEXT ONLY' : ''}`);
  lines.push('');
  lines.push('## Strategy families tested');
  for (const approach of payload.approaches) {
    lines.push(`- **${approach.id}**: selected=${approach.selectedCount}, holdoutEvents=${approach.eventSurface.holdoutEvents}, holdoutWR=${(approach.eventSurface.holdoutWR * 100).toFixed(2)}%, avgEntry=${approach.eventSurface.avgEntry.toFixed(4)} — ${approach.logic}`);
  }
  lines.push('');
  lines.push('## Approach ranking');
  lines.push('| Rank | Approach | Data | Runtime | Selected | Holdout events | Holdout WR | Avg entry | $10 7d strict median | $10 strict bust | $10 adverse bust | $10 worst bust |');
  lines.push('|---:|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|');
  payload.ranking.forEach((row, idx) => {
    lines.push(`| ${idx + 1} | ${row.id} | ${row.deployableData ? 'fresh/live-refresh' : 'stale/research'} | ${row.existingMatcherCompatible ? 'existing matcher' : `needs support (${row.runtimeBlockers.length})`} | ${row.selectedCount} | ${row.holdoutEvents} | ${(row.holdoutWR * 100).toFixed(1)}% | ${(row.avgEntry * 100).toFixed(1)}¢ | $${row.start10StrictMedian.toFixed(2)} | ${row.start10StrictBust.toFixed(1)}% | ${row.start10AdverseBust.toFixed(1)}% | ${row.start10WorstBust.toFixed(1)}% |`);
  });
  lines.push('');
  lines.push('## Runtime compatibility');
  for (const row of payload.ranking.slice(0, 10)) {
    const blockers = row.runtimeBlockers?.length ? row.runtimeBlockers.join(', ') : 'none';
    lines.push(`- **${row.id}**: ${row.existingMatcherCompatible ? 'existing matcher compatible' : `requires runtime support: ${blockers}`}`);
  }
  lines.push('');
  lines.push('## Verdict');
  lines.push(payload.verdict);
  lines.push('');
  return lines.join('\n');
}

function main() {
  ensureDir(OUT_DIR);
  const generatedAt = new Date().toISOString();
  const runs = Math.max(200, Math.floor(toFiniteNumber(process.env.FINAL_RUNS, 1200)));
  const starts = [5, 7, 10];
  const horizons = [24, 48, 168];
  const datasetInventory = [
    datasetSummary('data/intracycle-price-data.json'),
    datasetSummary('data/intracycle-price-data-5m.json'),
    datasetSummary('data/intracycle-price-data-4h.json'),
    datasetSummary('data/btc_5m_30d.json'),
  ];
  const cycles15 = loadCycles('data/intracycle-price-data.json');
  const cycles5 = loadCycles('data/intracycle-price-data-5m.json');
  const cycles4 = loadCycles('data/intracycle-price-data-4h.json');
  const max15 = Math.max(...cycles15.map((cycle) => Number(cycle.epoch)));
  const holdout15 = max15 - 7 * 24 * 60 * 60;
  const max5 = Math.max(...cycles5.map((cycle) => Number(cycle.epoch)));
  const holdout5 = max5 - 24 * 60 * 60;
  const max4 = Math.max(...cycles4.map((cycle) => Number(cycle.epoch)));
  const holdout4 = max4 - 7 * 24 * 60 * 60;
  const train15 = cycles15.filter((cycle) => Number(cycle.epoch) < holdout15);
  const test15 = cycles15.filter((cycle) => Number(cycle.epoch) >= holdout15);
  const train5 = cycles5.filter((cycle) => Number(cycle.epoch) < holdout5);
  const test5 = cycles5.filter((cycle) => Number(cycle.epoch) >= holdout5);
  const train4 = cycles4.filter((cycle) => Number(cycle.epoch) < holdout4);
  const test4 = cycles4.filter((cycle) => Number(cycle.epoch) >= holdout4);
  const stale = {
    '15m': splitIsStale(cycles15, 24 * 60 * 60),
    '5m': splitIsStale(cycles5, 24 * 60 * 60),
    '4h': splitIsStale(cycles4, 48 * 60 * 60),
  };
  const split = {
    train15: { count: train15.length, start: iso(train15[0]?.epoch), end: iso(train15[train15.length - 1]?.epoch), stale: stale['15m'] },
    holdout15: { count: test15.length, start: iso(test15[0]?.epoch), end: iso(test15[test15.length - 1]?.epoch), stale: stale['15m'] },
    train5: { count: train5.length, start: iso(train5[0]?.epoch), end: iso(train5[train5.length - 1]?.epoch), stale: stale['5m'] },
    holdout5: { count: test5.length, start: iso(test5[0]?.epoch), end: iso(test5[test5.length - 1]?.epoch), stale: stale['5m'] },
    train4: { count: train4.length, start: iso(train4[0]?.epoch), end: iso(train4[train4.length - 1]?.epoch), stale: stale['4h'] },
    holdout4: { count: test4.length, start: iso(test4[0]?.epoch), end: iso(test4[test4.length - 1]?.epoch), stale: stale['4h'] },
  };
  const baseSettings = defaultSimSettings();
  const frictionProfiles = getFrictionProfiles();
  const cycleLookup = buildCycleLookup(cycles15, cycles5, cycles4);
  const context = { cycles4 };
  const approaches = getApproachDefs();
  const evaluated = [];
  for (const cfg of approaches) {
    const train = cfg.timeframe === '5m' ? train5 : cfg.timeframe === '4h' ? train4 : train15;
    const test = cfg.timeframe === '5m' ? test5 : cfg.timeframe === '4h' ? test4 : test15;
    evaluated.push(evaluateApproach(cfg, train, test, baseSettings, frictionProfiles, starts, horizons, runs, cycleLookup, context));
  }
  const ranking = rankingRows(evaluated);
  const liveStatus = buildLiveStatus();
  const verdict = verdictFromRanking(ranking, liveStatus);
  const payload = {
    generatedAt,
    runs,
    starts,
    horizons,
    liveStatus,
    datasetInventory,
    split,
    frictionProfiles,
    correction: {
      repricedLatency: true,
      latencyMethod: 'For latencyShiftMinutes > 0, the event minute/timestamp, signalEntryPrice, orderPrice, oppositePrice, edge gate, hard cap, and pre-resolution exit are recomputed from the delayed minute snapshot.',
      historicalL2ReplayAvailable: false,
      liveApiVerified: liveStatus.health === 'VERIFIED',
    },
    approaches: evaluated,
    ranking,
    verdict,
  };
  const tradeSamples = Object.fromEntries(evaluated.map((approach) => [approach.id, approach.samples]));
  writeJson('final_reinvestigation_results.json', payload);
  writeJson('final_raw_trade_samples.json', tradeSamples);
  writeText('final_reinvestigation_report.md', markdownReport(payload));
  writeJson('epoch3_candidate_rankings.json', payload.ranking);
  writeJson('epoch3_mc_results.json', payload);
  writeJson('epoch3_raw_trade_paths.json', tradeSamples);
  writeText('epoch3_strategy_discovery.md', markdownReport(payload));
  process.stdout.write(`FINAL_REINVESTIGATION_COMPLETE out=${path.relative(ROOT, OUT_DIR)} approaches=${evaluated.length} runs=${runs}\n`);
  process.stdout.write(`BEST ${ranking[0] ? ranking[0].id : 'none'} median10=$${ranking[0] ? ranking[0].start10StrictMedian.toFixed(2) : '0.00'} bust10=${ranking[0] ? ranking[0].start10StrictBust.toFixed(2) : '100.00'}%\n`);
  process.stdout.write(`${verdict}\n`);
}

main();
