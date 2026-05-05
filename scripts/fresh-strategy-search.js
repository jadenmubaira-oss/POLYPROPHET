#!/usr/bin/env node
const https = require('https');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const GAMMA_API = 'https://gamma-api.polymarket.com';
const CLOB_API = 'https://clob.polymarket.com';
const SERIES = { BTC: 10192, ETH: 10191, SOL: 10423, XRP: 10422 };
const CYCLE_SECONDS = 900;
const DEFAULT_MIN_ORDER_SHARES = 5;
const TAKER_FEE = Number(process.env.TAKER_FEE_PCT || 0.0315);
const SLIPPAGE = Number(process.env.SLIPPAGE_PCT || 0.01);
const START_BALANCE = Number(process.env.START_BALANCE || 10.43);
const FETCH_DAYS = Math.max(1, Number(process.env.FETCH_DAYS || 4));
const HOLDOUT_DAYS = Math.max(1, Number(process.env.HOLDOUT_DAYS || 3));
const MIN_HOLDOUT_TRADES = Math.max(3, Number(process.env.MIN_HOLDOUT_TRADES || 5));
const MIN_RECENT7_TRADES = Math.max(5, Number(process.env.MIN_RECENT7_TRADES || 10));
const MAX_ENTRY_PRICE = Math.min(0.95, Number(process.env.MAX_ENTRY_PRICE || 0.82));
const MIN_EDGE_ROI = Number(process.env.MIN_EDGE_ROI || 0.03);
const MAX_STRATEGIES = Math.max(1, Number(process.env.MAX_STRATEGIES || 12));
const BEAM_WIDTH = Math.max(5, Number(process.env.BEAM_WIDTH || 160));
const MC_TRIALS = Math.max(100, Number(process.env.MC_TRIALS || 2500));
const OUT_PREFIX = process.env.OUT_PREFIX || String(Date.now());
const FORCE_FETCH = String(process.env.FORCE_FETCH || '0') === '1';

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
function round(v, d = 4) { return Number.isFinite(Number(v)) ? Math.round(Number(v) * 10 ** d) / 10 ** d : null; }
function readJson(rel) { return JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8')); }
function writeJson(rel, value) {
  const fp = path.join(ROOT, rel);
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  fs.writeFileSync(fp, JSON.stringify(value, null, 2));
}
function fetchJson(url, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout: timeoutMs, headers: { 'user-agent': 'polyprophet-fresh-strategy-audit' } }, res => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error(`JSON_PARSE ${e.message} len=${data.length} url=${url}`)); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error(`TIMEOUT ${url}`)); });
  });
}
async function fetchWithRetry(url, retries = 3) {
  let last;
  for (let i = 0; i < retries; i++) {
    try { return await fetchJson(url); }
    catch (e) { last = e; await sleep(500 * (i + 1)); }
  }
  throw last;
}
function safeArray(val) {
  if (Array.isArray(val)) return val;
  try { return JSON.parse(val || '[]'); } catch { return []; }
}
function dayKey(epoch) { return new Date(Number(epoch) * 1000).toISOString().slice(0, 10); }
function priceAt(cycle, direction, minute) {
  const map = direction === 'UP' ? cycle.minutePricesYes : cycle.minutePricesNo;
  const raw = map?.[String(minute)] ?? map?.[minute];
  const p = Number(raw?.last);
  return Number.isFinite(p) && p > 0 && p < 1 ? p : null;
}
function spreadOk(cycle, minute) {
  const y = priceAt(cycle, 'UP', minute);
  const n = priceAt(cycle, 'DOWN', minute);
  if (y == null || n == null) return true;
  return Math.abs(y + n - 1) <= 0.08;
}
function buildMinutePrices(history, cycleStart, totalMinutes = 15) {
  const points = (history || [])
    .map(p => ({ t: Number(p?.t), p: Number(p?.p) }))
    .filter(p => Number.isFinite(p.t) && Number.isFinite(p.p) && p.t >= cycleStart && p.t < cycleStart + totalMinutes * 60)
    .sort((a, b) => a.t - b.t);
  const out = {};
  for (let m = 0; m < totalMinutes; m++) {
    const minStart = cycleStart + m * 60;
    const minEnd = minStart + 60;
    const before = points.filter(p => p.t < minEnd);
    const inMinute = points.filter(p => p.t >= minStart && p.t < minEnd);
    if (!before.length) continue;
    const last = before[before.length - 1];
    out[m] = { last: last.p, count: inMinute.length, ts: last.t };
  }
  return out;
}
async function collectFreshCycles() {
  const nowSec = Math.floor(Date.now() / 1000);
  const endEpoch = Math.floor((nowSec - 2 * CYCLE_SECONDS) / CYCLE_SECONDS) * CYCLE_SECONDS;
  const startEpoch = endEpoch - Math.ceil(FETCH_DAYS * 86400 / CYCLE_SECONDS) * CYCLE_SECONDS;
  const cycles = [];
  const errors = [];
  for (const [asset, seriesId] of Object.entries(SERIES)) {
    const events = [];
    let offset = 0;
    while (true) {
      const url = `${GAMMA_API}/events?series_id=${seriesId}&limit=100&offset=${offset}&closed=true&order=endDate&ascending=false`;
      const batch = await fetchWithRetry(url).catch(e => { errors.push({ stage: 'events', asset, offset, error: e.message }); return []; });
      if (!Array.isArray(batch) || !batch.length) break;
      events.push(...batch);
      const oldest = Math.min(...batch.map(e => Number((String(e.slug || '').match(/-(\d+)$/) || [])[1] || Infinity)));
      if (oldest <= startEpoch || batch.length < 100) break;
      offset += 100;
      await sleep(120);
    }
    const wanted = events
      .filter(e => {
        const epoch = Number((String(e.slug || '').match(/-(\d+)$/) || [])[1]);
        return Number.isFinite(epoch) && epoch >= startEpoch && epoch <= endEpoch;
      })
      .sort((a, b) => Number((String(a.slug || '').match(/-(\d+)$/) || [])[1]) - Number((String(b.slug || '').match(/-(\d+)$/) || [])[1]));
    for (let i = 0; i < wanted.length; i++) {
      const ev = wanted[i];
      const epoch = Number((String(ev.slug || '').match(/-(\d+)$/) || [])[1]);
      const market = Array.isArray(ev.markets) ? ev.markets[0] : null;
      if (!market?.closed) continue;
      const outcomes = safeArray(market.outcomes);
      const outcomePrices = safeArray(market.outcomePrices);
      const tokenIds = safeArray(market.clobTokenIds);
      if (outcomePrices.length < 2 || tokenIds.length < 2) continue;
      let yesIdx = outcomes.findIndex(o => /^(yes|up)$/i.test(String(o).trim()));
      let noIdx = outcomes.findIndex(o => /^(no|down)$/i.test(String(o).trim()));
      if (yesIdx < 0 || noIdx < 0) { yesIdx = 0; noIdx = 1; }
      const yesFinal = Number(outcomePrices[yesIdx]);
      const noFinal = Number(outcomePrices[noIdx]);
      const resolution = yesFinal >= 0.99 ? 'UP' : (noFinal >= 0.99 ? 'DOWN' : null);
      if (!resolution) continue;
      const yesTokenId = tokenIds[yesIdx];
      const noTokenId = tokenIds[noIdx];
      const [yesHist, noHist] = await Promise.all([
        fetchJson(`${CLOB_API}/prices-history?market=${yesTokenId}&startTs=${epoch}&endTs=${epoch + CYCLE_SECONDS}&fidelity=1`).catch(e => ({ error: e.message, history: [] })),
        fetchJson(`${CLOB_API}/prices-history?market=${noTokenId}&startTs=${epoch}&endTs=${epoch + CYCLE_SECONDS}&fidelity=1`).catch(e => ({ error: e.message, history: [] }))
      ]);
      const minutePricesYes = buildMinutePrices(yesHist.history || [], epoch);
      const minutePricesNo = buildMinutePrices(noHist.history || [], epoch);
      if (!Object.keys(minutePricesYes).length && !Object.keys(minutePricesNo).length) continue;
      cycles.push({
        asset,
        epoch,
        slug: ev.slug,
        resolution,
        orderMinSize: Number(market.orderMinSize || 5),
        orderPriceMinTickSize: Number(market.orderPriceMinTickSize || 0.01),
        yesMinOrderSize: Number(market.orderMinSize || 5),
        noMinOrderSize: Number(market.orderMinSize || 5),
        priceSnapshotsYes: Object.keys(minutePricesYes).length,
        priceSnapshotsNo: Object.keys(minutePricesNo).length,
        minutePricesYes,
        minutePricesNo,
        minuteCoverage: {
          yes: Object.keys(minutePricesYes).map(Number).sort((a, b) => a - b),
          no: Object.keys(minutePricesNo).map(Number).sort((a, b) => a - b)
        }
      });
      if ((i + 1) % 30 === 0) process.stderr.write(`${asset} ${i + 1}/${wanted.length} fresh cycles\n`);
      await sleep(60);
    }
  }
  return { generatedAt: new Date().toISOString(), fetchDays: FETCH_DAYS, startEpoch, endEpoch, totalCycles: cycles.length, cycles, errors };
}
function wilsonLCB(wins, total, z = 1.645) {
  if (!total) return 0;
  const p = wins / total;
  const denom = 1 + z * z / total;
  const center = p + z * z / (2 * total);
  const margin = z * Math.sqrt((p * (1 - p) + z * z / (4 * total)) / total);
  return Math.max(0, (center - margin) / denom);
}
function mergeCycles(baseCycles, freshCycles) {
  const map = new Map();
  for (const c of [...baseCycles, ...freshCycles]) {
    if (!c?.asset || !Number.isFinite(Number(c.epoch))) continue;
    map.set(`${String(c.asset).toUpperCase()}_${Number(c.epoch)}`, { ...c, asset: String(c.asset).toUpperCase(), epoch: Number(c.epoch) });
  }
  return [...map.values()].sort((a, b) => Number(a.epoch) - Number(b.epoch) || String(a.asset).localeCompare(String(b.asset)));
}
function candidateName(c) {
  return `fresh_${c.asset}_H${String(c.utcHour).padStart(2, '0')}_M${c.entryMinute}_${c.direction}_${Math.round(c.priceMin * 100)}_${Math.round(c.priceMax * 100)}`;
}
function netRoi(entry, pWin) {
  const e = Math.min(0.99, entry * (1 + SLIPPAGE));
  const winProfitPerDollar = ((1 - e) * (1 - TAKER_FEE)) / e;
  return pWin * winProfitPerDollar - (1 - pWin);
}
function matchCandidate(cycle, c) {
  if (c.asset !== 'ALL' && String(cycle.asset).toUpperCase() !== c.asset) return null;
  const hour = new Date(Number(cycle.epoch) * 1000).getUTCHours();
  if (c.utcHour !== -1 && hour !== c.utcHour) return null;
  if (!spreadOk(cycle, c.entryMinute)) return null;
  const price = priceAt(cycle, c.direction, c.entryMinute);
  if (price == null || price < c.priceMin || price > c.priceMax || price > MAX_ENTRY_PRICE) return null;
  return {
    epoch: Number(cycle.epoch),
    day: dayKey(cycle.epoch),
    asset: String(cycle.asset).toUpperCase(),
    direction: c.direction,
    entryPrice: price,
    won: String(cycle.resolution).toUpperCase() === c.direction,
    candidate: c.name
  };
}
function statsFor(trades) {
  const n = trades.length;
  const w = trades.filter(t => t.won).length;
  const avgEntry = n ? trades.reduce((s, t) => s + t.entryPrice, 0) / n : null;
  const wr = n ? w / n : null;
  const lcb = n ? wilsonLCB(w, n) : 0;
  return { n, w, l: n - w, wr, lcb, avgEntry, edgeRoiAtWR: n ? netRoi(avgEntry, wr) : null, edgeRoiAtLCB: n ? netRoi(avgEntry, lcb) : null };
}
function mineCandidates(cycles) {
  const epochs = cycles.map(c => Number(c.epoch)).filter(Number.isFinite).sort((a, b) => a - b);
  const maxEpoch = epochs[epochs.length - 1];
  const holdoutCut = maxEpoch - HOLDOUT_DAYS * 86400;
  const recent7Cut = maxEpoch - 7 * 86400;
  const trainCycles = cycles.filter(c => Number(c.epoch) < holdoutCut);
  const holdoutCycles = cycles.filter(c => Number(c.epoch) >= holdoutCut);
  const recent7Cycles = cycles.filter(c => Number(c.epoch) >= recent7Cut);
  const raw = [];
  const assets = ['ALL', 'BTC', 'ETH', 'SOL', 'XRP'];
  const bands = [];
  for (let lo = 0.35; lo <= 0.78 + 1e-9; lo += 0.05) {
    for (let hi = lo + 0.04; hi <= MAX_ENTRY_PRICE + 1e-9; hi += 0.05) bands.push([round(lo, 2), round(Math.min(MAX_ENTRY_PRICE, hi), 2)]);
  }
  for (const asset of assets) {
    for (const utcHour of [-1, ...Array.from({ length: 24 }, (_, i) => i)]) {
      for (let entryMinute = 0; entryMinute <= 14; entryMinute++) {
        for (const direction of ['UP', 'DOWN']) {
          for (const [priceMin, priceMax] of bands) {
            const c = { asset, utcHour, entryMinute, direction, priceMin, priceMax };
            c.name = candidateName(c);
            const train = trainCycles.map(cy => matchCandidate(cy, c)).filter(Boolean);
            if (train.length < 15) continue;
            const tr = statsFor(train);
            if (tr.wr < 0.76 || tr.lcb < 0.62 || tr.edgeRoiAtLCB < MIN_EDGE_ROI) continue;
            const holdout = holdoutCycles.map(cy => matchCandidate(cy, c)).filter(Boolean);
            const recent7 = recent7Cycles.map(cy => matchCandidate(cy, c)).filter(Boolean);
            const ho = statsFor(holdout);
            const r7 = statsFor(recent7);
            if (ho.n < MIN_HOLDOUT_TRADES || r7.n < MIN_RECENT7_TRADES) continue;
            if (ho.wr < 0.76 || r7.wr < 0.76 || ho.edgeRoiAtWR < MIN_EDGE_ROI || r7.edgeRoiAtWR < MIN_EDGE_ROI) continue;
            raw.push({
              ...c,
              key: `${asset}|${utcHour}|${entryMinute}|${direction}|${priceMin}|${priceMax}`,
              train: tr,
              holdout: ho,
              recent7: r7,
              allTrades: cycles.map(cy => matchCandidate(cy, c)).filter(Boolean)
            });
          }
        }
      }
    }
  }
  raw.sort((a, b) => {
    const scoreA = a.holdout.lcb * 5 + a.recent7.lcb * 3 + Math.log1p(a.recent7.n) + a.recent7.edgeRoiAtWR;
    const scoreB = b.holdout.lcb * 5 + b.recent7.lcb * 3 + Math.log1p(b.recent7.n) + b.recent7.edgeRoiAtWR;
    return scoreB - scoreA;
  });
  return { maxEpoch, holdoutCut, trainCycles: trainCycles.length, holdoutCycles: holdoutCycles.length, recent7Cycles: recent7Cycles.length, candidates: dedupeCandidateOverlaps(raw).slice(0, 80), rawCandidateCount: raw.length };
}
function dedupeCandidateOverlaps(cands) {
  const out = [];
  for (const c of cands) {
    const cSet = new Set(c.allTrades.map(t => `${t.asset}_${t.epoch}`));
    let tooClose = false;
    for (const o of out) {
      if (o.asset !== c.asset || o.utcHour !== c.utcHour || o.entryMinute !== c.entryMinute || o.direction !== c.direction) continue;
      const oSet = new Set(o.allTrades.map(t => `${t.asset}_${t.epoch}`));
      let inter = 0;
      for (const k of cSet) if (oSet.has(k)) inter++;
      if (inter / Math.max(1, Math.min(cSet.size, oSet.size)) > 0.75) { tooClose = true; break; }
    }
    if (!tooClose) out.push(c);
  }
  return out;
}
function tradesForPortfolio(strategies, cycles) {
  const all = [];
  for (const s of strategies) for (const cy of cycles) {
    const hit = matchCandidate(cy, s);
    if (hit) all.push({ ...hit, pWinEstimate: s.pWinEstimate || s.holdout?.lcb || s.recent7?.lcb || 0.5, strategy: s.name, entryMinute: s.entryMinute });
  }
  all.sort((a, b) => a.epoch !== b.epoch ? a.epoch - b.epoch : (b.pWinEstimate - a.pWinEstimate || a.entryPrice - b.entryPrice));
  return all;
}
function simulateSequence(trades, startBalance = START_BALANCE) {
  let bankroll = startBalance;
  let peak = startBalance;
  let maxDD = 0;
  let wins = 0;
  let losses = 0;
  const byCycle = new Map();
  for (const t of trades) {
    if (bankroll < 1.5) break;
    const cycleKey = String(t.epoch);
    const mpc = bankroll < 20 ? 1 : 2;
    const used = byCycle.get(cycleKey) || 0;
    if (used >= mpc) continue;
    const minCost = DEFAULT_MIN_ORDER_SHARES * t.entryPrice;
    let stakeFraction = bankroll < 20 ? 0.30 : (bankroll < 50 ? 0.32 : (bankroll < 200 ? 0.25 : 0.12));
    const stake = Math.max(minCost, bankroll * stakeFraction);
    if (stake > bankroll) continue;
    const shares = Math.floor(stake / t.entryPrice + 1e-9);
    if (shares < DEFAULT_MIN_ORDER_SHARES) continue;
    const cost = shares * t.entryPrice;
    if (cost > bankroll) continue;
    byCycle.set(cycleKey, used + 1);
    if (t.won) {
      const grossProfit = shares - cost;
      const fee = Math.max(0, grossProfit) * TAKER_FEE;
      bankroll += grossProfit - fee;
      wins++;
    } else {
      bankroll -= cost;
      losses++;
    }
    if (bankroll > peak) peak = bankroll;
    maxDD = Math.max(maxDD, peak > 0 ? (peak - bankroll) / peak : 0);
  }
  return { finalBalance: round(bankroll, 2), trades: wins + losses, wins, losses, winRate: wins + losses ? round(wins / (wins + losses)) : null, maxDD: round(maxDD), busted: bankroll < 1.5 };
}
function evaluatePortfolio(strategies, cycles, maxEpoch) {
  const allTrades = tradesForPortfolio(strategies, cycles);
  const windows = {};
  for (const days of [1, 2, 3, 7]) {
    const cutoff = maxEpoch - days * 86400;
    const wTrades = allTrades.filter(t => t.epoch >= cutoff);
    windows[`${days}d`] = { stats: statsFor(wTrades), sim: simulateSequence(wTrades) };
  }
  return { tradeCount: allTrades.length, stats: statsFor(allTrades), windows };
}
function comparePortfolio(a, b) {
  const aw = a.eval.windows['3d'];
  const bw = b.eval.windows['3d'];
  const a7 = a.eval.windows['7d'];
  const b7 = b.eval.windows['7d'];
  const scoreA = aw.sim.finalBalance * 3 + a7.sim.finalBalance + aw.stats.lcb * 20 - aw.sim.maxDD * 10;
  const scoreB = bw.sim.finalBalance * 3 + b7.sim.finalBalance + bw.stats.lcb * 20 - bw.sim.maxDD * 10;
  return scoreB - scoreA;
}
function beamSearch(candidates, cycles, maxEpoch) {
  let frontier = candidates.slice(0, 40).map(s => ({ strategies: [s], signature: s.key }));
  frontier = frontier.map(p => ({ ...p, eval: evaluatePortfolio(p.strategies, cycles, maxEpoch) })).sort(comparePortfolio).slice(0, BEAM_WIDTH);
  let best = frontier[0];
  for (let size = 2; size <= Math.min(MAX_STRATEGIES, candidates.length); size++) {
    const expanded = [];
    const seen = new Set();
    for (const base of frontier) {
      const keys = new Set(base.strategies.map(s => s.key));
      for (const c of candidates.slice(0, 80)) {
        if (keys.has(c.key)) continue;
        const next = [...base.strategies, c];
        const signature = next.map(s => s.key).sort().join('||');
        if (seen.has(signature)) continue;
        seen.add(signature);
        const ev = evaluatePortfolio(next, cycles, maxEpoch);
        if ((ev.windows['3d'].stats.wr ?? 0) < 0.72 || ev.windows['3d'].sim.busted) continue;
        expanded.push({ strategies: next, signature, eval: ev });
      }
    }
    if (!expanded.length) break;
    frontier = expanded.sort(comparePortfolio).slice(0, BEAM_WIDTH);
    if (comparePortfolio(frontier[0], best) < 0) best = frontier[0];
  }
  return { best, finalists: frontier.slice(0, 10) };
}
function bootstrap(trades, maxEpoch, days, trials) {
  const byDay = new Map();
  for (const t of trades) {
    if (!byDay.has(t.day)) byDay.set(t.day, []);
    byDay.get(t.day).push(t);
  }
  const daysList = [...byDay.keys()].sort();
  const finals = [];
  let busts = 0;
  let totalTrades = 0;
  let totalWR = 0;
  for (let i = 0; i < trials; i++) {
    const seq = [];
    for (let d = 0; d < days; d++) {
      const day = daysList[Math.floor(Math.random() * daysList.length)];
      seq.push(...(byDay.get(day) || []).map(t => ({ ...t, epoch: d * 86400 + (t.epoch % 86400) })));
    }
    seq.sort((a, b) => a.epoch - b.epoch || b.pWinEstimate - a.pWinEstimate);
    const res = simulateSequence(seq);
    finals.push(res.finalBalance);
    if (res.busted) busts++;
    totalTrades += res.trades;
    totalWR += res.winRate || 0;
  }
  finals.sort((a, b) => a - b);
  const pct = p => finals[Math.min(finals.length - 1, Math.max(0, Math.floor((finals.length - 1) * p)))];
  return { trials, days, bustRate: round(busts / trials), avgTrades: round(totalTrades / trials, 1), avgWR: round(totalWR / trials), finalBalance: { p10: pct(0.1), p25: pct(0.25), median: pct(0.5), p75: pct(0.75), p90: pct(0.9), max: finals[finals.length - 1] } };
}
async function main() {
  const local = readJson('data/intracycle-price-data.json');
  let fresh = null;
  const cachedFreshPath = path.join(ROOT, 'debug', `fresh_full_intracycle_${OUT_PREFIX}.json`);
  if (!FORCE_FETCH && fs.existsSync(cachedFreshPath)) fresh = JSON.parse(fs.readFileSync(cachedFreshPath, 'utf8'));
  else {
    fresh = await collectFreshCycles();
    fs.writeFileSync(cachedFreshPath, JSON.stringify(fresh, null, 2));
  }
  const cycles = mergeCycles(local.cycles || [], fresh.cycles || []);
  const mined = mineCandidates(cycles);
  const search = beamSearch(mined.candidates, cycles, mined.maxEpoch);
  const bestStrategies = search.best?.strategies || [];
  const bestTrades = tradesForPortfolio(bestStrategies, cycles);
  const report = {
    generatedAt: new Date().toISOString(),
    data: {
      localCycles: (local.cycles || []).length,
      freshCycles: (fresh.cycles || []).length,
      mergedCycles: cycles.length,
      range: {
        start: new Date(Math.min(...cycles.map(c => c.epoch)) * 1000).toISOString(),
        end: new Date(Math.max(...cycles.map(c => c.epoch)) * 1000).toISOString()
      },
      freshErrors: fresh.errors || []
    },
    config: { START_BALANCE, FETCH_DAYS, HOLDOUT_DAYS, MIN_HOLDOUT_TRADES, MIN_RECENT7_TRADES, MAX_ENTRY_PRICE, MIN_EDGE_ROI, MAX_STRATEGIES, BEAM_WIDTH, MC_TRIALS },
    mining: { rawCandidateCount: mined.rawCandidateCount, retainedCandidates: mined.candidates.length, split: { holdoutCut: new Date(mined.holdoutCut * 1000).toISOString(), trainCycles: mined.trainCycles, holdoutCycles: mined.holdoutCycles, recent7Cycles: mined.recent7Cycles } },
    topCandidates: mined.candidates.slice(0, 25).map(c => ({ name: c.name, key: c.key, train: c.train, holdout: c.holdout, recent7: c.recent7 })),
    bestPortfolio: search.best ? { strategyCount: bestStrategies.length, eval: search.best.eval, strategies: bestStrategies.map(s => ({ name: s.name, asset: s.asset, utcHour: s.utcHour, entryMinute: s.entryMinute, direction: s.direction, priceMin: s.priceMin, priceMax: s.priceMax, pWinEstimate: round(Math.max(s.holdout.lcb, 0.5)), evWinEstimate: round(Math.max(s.holdout.wr || 0.5, 0.5)), train: s.train, holdout: s.holdout, recent7: s.recent7 })) } : null,
    bootstrap: bestTrades.length ? { d1: bootstrap(bestTrades, mined.maxEpoch, 1, MC_TRIALS), d2: bootstrap(bestTrades, mined.maxEpoch, 2, MC_TRIALS), d7: bootstrap(bestTrades, mined.maxEpoch, 7, MC_TRIALS) } : null,
    artifacts: {
      freshData: path.relative(ROOT, cachedFreshPath),
      report: `debug/fresh_strategy_search_${OUT_PREFIX}.json`,
      strategy: `strategies/strategy_set_15m_fresh_best_${OUT_PREFIX}.json`
    }
  };
  writeJson(`debug/fresh_strategy_search_${OUT_PREFIX}.json`, report);
  if (bestStrategies.length) {
    writeJson(`strategies/strategy_set_15m_fresh_best_${OUT_PREFIX}.json`, {
      name: `fresh_best_${OUT_PREFIX}`,
      description: 'Fresh mined 15m strategy set. Do not deploy unless README addendum verdict is GO after reviewing report.',
      generatedAt: report.generatedAt,
      sourceReport: report.artifacts.report,
      methodology: 'Mined static grid candidates with fresh chronological holdout and beam-selected by recent short-horizon simulation under micro-bankroll one-trade-per-cycle mechanics.',
      stats: report.bestPortfolio.eval,
      strategies: report.bestPortfolio.strategies.map((s, i) => ({ id: i + 1, name: s.name, asset: s.asset, utcHour: s.utcHour, entryMinute: s.entryMinute, direction: s.direction, priceMin: s.priceMin, priceMax: s.priceMax, pWinEstimate: s.pWinEstimate, evWinEstimate: s.evWinEstimate, winRate: s.holdout.wr, winRateLCB: s.holdout.lcb, tier: 'FRESH_HOLDOUT' }))
    });
  }
  console.log(JSON.stringify(report, null, 2));
}

main().catch(e => { console.error(e); process.exit(1); });
