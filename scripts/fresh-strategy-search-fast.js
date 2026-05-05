#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const OUT_PREFIX = process.env.OUT_PREFIX || 'may5_fresh_fast_v1';
const FRESH_PATH = process.env.FRESH_PATH || 'debug/fresh_full_intracycle_may5_fresh_v1.json';
const START_BALANCE = Number(process.env.START_BALANCE || 10.43);
const HOLDOUT_DAYS = Math.max(1, Number(process.env.HOLDOUT_DAYS || 3));
const MAX_ENTRY_PRICE = Math.min(0.95, Number(process.env.MAX_ENTRY_PRICE || 0.82));
const MIN_TRAIN_TRADES = Math.max(5, Number(process.env.MIN_TRAIN_TRADES || 20));
const MIN_HOLDOUT_TRADES = Math.max(3, Number(process.env.MIN_HOLDOUT_TRADES || 5));
const MIN_RECENT7_TRADES = Math.max(5, Number(process.env.MIN_RECENT7_TRADES || 10));
const MIN_HOLDOUT_WR = Number(process.env.MIN_HOLDOUT_WR || 0.76);
const MIN_RECENT7_WR = Number(process.env.MIN_RECENT7_WR || 0.76);
const MAX_STRATEGIES = Math.max(1, Number(process.env.MAX_STRATEGIES || 12));
const BEAM_WIDTH = Math.max(5, Number(process.env.BEAM_WIDTH || 160));
const MC_TRIALS = Math.max(100, Number(process.env.MC_TRIALS || 5000));
const TAKER_FEE = Number(process.env.TAKER_FEE_PCT || 0.0315);
const SLIPPAGE = Number(process.env.SLIPPAGE_PCT || 0.01);
const MIN_SHARES = Math.max(5, Number(process.env.MIN_SHARES || 5));

function readJson(rel) { return JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8')); }
function writeJson(rel, value) {
  const fp = path.join(ROOT, rel);
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  fs.writeFileSync(fp, JSON.stringify(value, null, 2));
}
function round(v, d = 4) { return Number.isFinite(Number(v)) ? Math.round(Number(v) * 10 ** d) / 10 ** d : null; }
function dayKey(epoch) { return new Date(Number(epoch) * 1000).toISOString().slice(0, 10); }
function priceAt(c, direction, minute) {
  const map = direction === 'UP' ? c.minutePricesYes : c.minutePricesNo;
  const raw = map?.[String(minute)] ?? map?.[minute];
  const p = Number(raw?.last);
  return Number.isFinite(p) && p > 0 && p < 1 ? p : null;
}
function spreadOk(c, minute) {
  const y = priceAt(c, 'UP', minute);
  const n = priceAt(c, 'DOWN', minute);
  if (y == null || n == null) return true;
  return Math.abs(y + n - 1) <= 0.08;
}
function wilsonLCB(wins, total, z = 1.645) {
  if (!total) return 0;
  const p = wins / total;
  const denom = 1 + z * z / total;
  const center = p + z * z / (2 * total);
  const margin = z * Math.sqrt((p * (1 - p) + z * z / (4 * total)) / total);
  return Math.max(0, (center - margin) / denom);
}
function netRoi(entry, pWin) {
  const e = Math.min(0.99, entry * (1 + SLIPPAGE));
  const winProfitPerDollar = ((1 - e) * (1 - TAKER_FEE)) / e;
  return pWin * winProfitPerDollar - (1 - pWin);
}
function stats(rows) {
  const n = rows.length;
  const w = rows.filter(r => r.won).length;
  const avgEntry = n ? rows.reduce((s, r) => s + r.entryPrice, 0) / n : null;
  const wr = n ? w / n : null;
  const lcb = n ? wilsonLCB(w, n) : 0;
  return { n, w, l: n - w, wr: round(wr), lcb: round(lcb), avgEntry: round(avgEntry), roiAtWR: round(n ? netRoi(avgEntry, wr) : null), roiAtLCB: round(n ? netRoi(avgEntry, lcb) : null) };
}
function mergeCycles(local, fresh) {
  const map = new Map();
  for (const c of [...local, ...fresh]) {
    const asset = String(c.asset || '').toUpperCase();
    const epoch = Number(c.epoch);
    if (!asset || !Number.isFinite(epoch)) continue;
    map.set(`${asset}_${epoch}`, { ...c, asset, epoch });
  }
  return [...map.values()].sort((a, b) => a.epoch - b.epoch || a.asset.localeCompare(b.asset));
}
function buildIndex(cycles) {
  const index = new Map();
  function add(key, row) {
    if (!index.has(key)) index.set(key, []);
    index.get(key).push(row);
  }
  for (const c of cycles) {
    const hour = new Date(c.epoch * 1000).getUTCHours();
    const resolution = String(c.resolution || '').toUpperCase();
    if (resolution !== 'UP' && resolution !== 'DOWN') continue;
    for (let minute = 0; minute <= 14; minute++) {
      if (!spreadOk(c, minute)) continue;
      for (const direction of ['UP', 'DOWN']) {
        const entryPrice = priceAt(c, direction, minute);
        if (entryPrice == null || entryPrice > MAX_ENTRY_PRICE) continue;
        const row = { asset: c.asset, epoch: c.epoch, day: dayKey(c.epoch), hour, minute, direction, entryPrice, won: resolution === direction };
        add(`ALL|-1|${minute}|${direction}`, row);
        add(`${c.asset}|-1|${minute}|${direction}`, row);
        add(`ALL|${hour}|${minute}|${direction}`, row);
        add(`${c.asset}|${hour}|${minute}|${direction}`, row);
      }
    }
  }
  return index;
}
function bands() {
  const out = [];
  const lows = [0.35, 0.4, 0.45, 0.5, 0.55, 0.6, 0.65, 0.7, 0.75];
  const widths = [0.08, 0.12, 0.18, 0.25, 0.35, 0.47];
  for (const lo of lows) {
    for (const width of widths) {
      const hi = Math.min(MAX_ENTRY_PRICE, lo + width);
      if (hi - lo >= 0.05) out.push([round(lo, 2), round(hi, 2)]);
    }
  }
  return [...new Map(out.map(b => [b.join('|'), b])).values()];
}
function splitRows(rows, holdoutCut, recent7Cut) {
  return {
    train: rows.filter(r => r.epoch < holdoutCut),
    holdout: rows.filter(r => r.epoch >= holdoutCut),
    recent7: rows.filter(r => r.epoch >= recent7Cut)
  };
}
function mine(index, maxEpoch) {
  const holdoutCut = maxEpoch - HOLDOUT_DAYS * 86400;
  const recent7Cut = maxEpoch - 7 * 86400;
  const candidates = [];
  const priceBands = bands();
  for (const [key, rows] of index.entries()) {
    if (rows.length < MIN_TRAIN_TRADES + MIN_HOLDOUT_TRADES) continue;
    const [asset, utcHourRaw, entryMinuteRaw, direction] = key.split('|');
    for (const [priceMin, priceMax] of priceBands) {
      const bandRows = rows.filter(r => r.entryPrice >= priceMin && r.entryPrice <= priceMax);
      const split = splitRows(bandRows, holdoutCut, recent7Cut);
      if (split.train.length < MIN_TRAIN_TRADES || split.holdout.length < MIN_HOLDOUT_TRADES || split.recent7.length < MIN_RECENT7_TRADES) continue;
      const train = stats(split.train);
      const holdout = stats(split.holdout);
      const recent7 = stats(split.recent7);
      if (train.wr < 0.72 || train.roiAtLCB < 0) continue;
      if (holdout.wr < MIN_HOLDOUT_WR || recent7.wr < MIN_RECENT7_WR) continue;
      if (holdout.roiAtWR < 0.02 || recent7.roiAtWR < 0.02) continue;
      const utcHour = Number(utcHourRaw);
      const entryMinute = Number(entryMinuteRaw);
      const name = `fast_${asset}_H${utcHour === -1 ? 'ALL' : String(utcHour).padStart(2, '0')}_M${entryMinute}_${direction}_${Math.round(priceMin * 100)}_${Math.round(priceMax * 100)}`;
      candidates.push({
        name,
        key: `${asset}|${utcHour}|${entryMinute}|${direction}|${priceMin}|${priceMax}`,
        asset,
        utcHour,
        entryMinute,
        direction,
        priceMin,
        priceMax,
        pWinEstimate: Math.max(0.5, holdout.lcb),
        evWinEstimate: Math.max(0.5, holdout.wr),
        train,
        holdout,
        recent7,
        rows: bandRows
      });
    }
  }
  candidates.sort((a, b) => scoreCandidate(b) - scoreCandidate(a));
  return dedupe(candidates).slice(0, 120);
}
function scoreCandidate(c) {
  return c.holdout.lcb * 7 + c.recent7.lcb * 5 + c.train.lcb * 2 + Math.log1p(c.holdout.n) + Math.log1p(c.recent7.n) + c.recent7.roiAtWR;
}
function dedupe(candidates) {
  const out = [];
  for (const c of candidates) {
    const cSet = new Set(c.rows.map(r => `${r.asset}_${r.epoch}`));
    let skip = false;
    for (const o of out) {
      if (o.asset !== c.asset || o.utcHour !== c.utcHour || o.entryMinute !== c.entryMinute || o.direction !== c.direction) continue;
      const oSet = new Set(o.rows.map(r => `${r.asset}_${r.epoch}`));
      let inter = 0;
      for (const k of cSet) if (oSet.has(k)) inter++;
      if (inter / Math.max(1, Math.min(cSet.size, oSet.size)) > 0.7) { skip = true; break; }
    }
    if (!skip) out.push(c);
  }
  return out;
}
function portfolioTrades(strategies) {
  const rows = [];
  for (const s of strategies) {
    for (const r of s.rows) rows.push({ ...r, strategy: s.name, pWinEstimate: s.pWinEstimate, evWinEstimate: s.evWinEstimate, cycleKey: String(r.epoch) });
  }
  rows.sort((a, b) => a.epoch - b.epoch || b.pWinEstimate - a.pWinEstimate || a.entryPrice - b.entryPrice);
  return rows;
}
function simulate(rows, startBalance = START_BALANCE) {
  let bankroll = startBalance;
  let peak = bankroll;
  let wins = 0;
  let losses = 0;
  let maxDD = 0;
  const cycleCounts = new Map();
  for (const r of rows) {
    if (bankroll < 1.5) break;
    const maxPerCycle = bankroll < 20 ? 1 : 2;
    const used = cycleCounts.get(r.cycleKey) || 0;
    if (used >= maxPerCycle) continue;
    const minCost = MIN_SHARES * r.entryPrice;
    const stakeFraction = bankroll < 20 ? 0.3 : (bankroll < 50 ? 0.32 : (bankroll < 200 ? 0.25 : 0.12));
    const stake = Math.max(minCost, bankroll * stakeFraction);
    if (stake > bankroll) continue;
    const shares = Math.floor(stake / r.entryPrice + 1e-9);
    if (shares < MIN_SHARES) continue;
    const cost = shares * r.entryPrice;
    if (cost > bankroll) continue;
    cycleCounts.set(r.cycleKey, used + 1);
    if (r.won) {
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
function evalPortfolio(strategies, maxEpoch) {
  const rows = portfolioTrades(strategies);
  const windows = {};
  for (const days of [1, 2, 3, 7, 14]) {
    const cutoff = maxEpoch - days * 86400;
    const wRows = rows.filter(r => r.epoch >= cutoff);
    windows[`${days}d`] = { stats: stats(wRows), sim: simulate(wRows) };
  }
  return { stats: stats(rows), sim: simulate(rows), windows };
}
function comparePortfolio(a, b) {
  const a3 = a.eval.windows['3d'];
  const b3 = b.eval.windows['3d'];
  const a7 = a.eval.windows['7d'];
  const b7 = b.eval.windows['7d'];
  const sa = a3.sim.finalBalance * 4 + a7.sim.finalBalance * 1.5 + (a3.stats.lcb || 0) * 15 + (a7.stats.lcb || 0) * 8 - a3.sim.maxDD * 15;
  const sb = b3.sim.finalBalance * 4 + b7.sim.finalBalance * 1.5 + (b3.stats.lcb || 0) * 15 + (b7.stats.lcb || 0) * 8 - b3.sim.maxDD * 15;
  return sb - sa;
}
function beam(candidates, maxEpoch) {
  let frontier = candidates.slice(0, 60).map(s => ({ strategies: [s], signature: s.key }));
  frontier = frontier.map(p => ({ ...p, eval: evalPortfolio(p.strategies, maxEpoch) })).sort(comparePortfolio).slice(0, BEAM_WIDTH);
  let best = frontier[0] || null;
  for (let size = 2; size <= Math.min(MAX_STRATEGIES, candidates.length); size++) {
    const expanded = [];
    const seen = new Set();
    for (const base of frontier) {
      const keys = new Set(base.strategies.map(s => s.key));
      for (const c of candidates) {
        if (keys.has(c.key)) continue;
        const next = [...base.strategies, c];
        const signature = next.map(s => s.key).sort().join('||');
        if (seen.has(signature)) continue;
        seen.add(signature);
        const ev = evalPortfolio(next, maxEpoch);
        if ((ev.windows['3d'].stats.wr || 0) < 0.74) continue;
        if (ev.windows['3d'].sim.busted || ev.windows['7d'].sim.busted) continue;
        expanded.push({ strategies: next, signature, eval: ev });
      }
    }
    if (!expanded.length) break;
    frontier = expanded.sort(comparePortfolio).slice(0, BEAM_WIDTH);
    if (!best || comparePortfolio(frontier[0], best) < 0) best = frontier[0];
  }
  return { best, finalists: frontier.slice(0, 10) };
}
function bootstrap(rows, days, trials) {
  const byDay = new Map();
  for (const r of rows) {
    if (!byDay.has(r.day)) byDay.set(r.day, []);
    byDay.get(r.day).push(r);
  }
  const keys = [...byDay.keys()].sort();
  const finals = [];
  let busts = 0;
  let trades = 0;
  let wr = 0;
  let dd = 0;
  for (let i = 0; i < trials; i++) {
    const seq = [];
    for (let d = 0; d < days; d++) {
      const key = keys[Math.floor(Math.random() * keys.length)];
      for (const r of byDay.get(key) || []) seq.push({ ...r, epoch: d * 86400 + (r.epoch % 86400), cycleKey: `${d}_${r.cycleKey}` });
    }
    seq.sort((a, b) => a.epoch - b.epoch || b.pWinEstimate - a.pWinEstimate || a.entryPrice - b.entryPrice);
    const res = simulate(seq);
    finals.push(res.finalBalance);
    if (res.busted) busts++;
    trades += res.trades;
    wr += res.winRate || 0;
    dd += res.maxDD || 0;
  }
  finals.sort((a, b) => a - b);
  const pct = p => round(finals[Math.min(finals.length - 1, Math.max(0, Math.floor((finals.length - 1) * p)))], 2);
  return { trials, days, bustRate: round(busts / trials), avgTrades: round(trades / trials, 1), avgWinRate: round(wr / trials), avgMaxDD: round(dd / trials), finalBalance: { min: pct(0), p10: pct(0.1), p25: pct(0.25), median: pct(0.5), p75: pct(0.75), p90: pct(0.9), max: pct(1) } };
}
function main() {
  const local = readJson('data/intracycle-price-data.json').cycles || [];
  const fresh = readJson(FRESH_PATH).cycles || [];
  const cycles = mergeCycles(local, fresh);
  const epochs = cycles.map(c => c.epoch).sort((a, b) => a - b);
  const maxEpoch = epochs[epochs.length - 1];
  const index = buildIndex(cycles);
  const candidates = mine(index, maxEpoch);
  const search = beam(candidates, maxEpoch);
  const best = search.best;
  const bestRows = best ? portfolioTrades(best.strategies) : [];
  const report = {
    generatedAt: new Date().toISOString(),
    data: {
      localCycles: local.length,
      freshCycles: fresh.length,
      mergedCycles: cycles.length,
      range: { start: new Date(epochs[0] * 1000).toISOString(), end: new Date(maxEpoch * 1000).toISOString() }
    },
    config: { START_BALANCE, HOLDOUT_DAYS, MAX_ENTRY_PRICE, MIN_TRAIN_TRADES, MIN_HOLDOUT_TRADES, MIN_RECENT7_TRADES, MIN_HOLDOUT_WR, MIN_RECENT7_WR, MAX_STRATEGIES, BEAM_WIDTH, MC_TRIALS, TAKER_FEE, SLIPPAGE, MIN_SHARES },
    mining: { indexedBuckets: index.size, candidates: candidates.length, topCandidates: candidates.slice(0, 25).map(c => ({ name: c.name, asset: c.asset, utcHour: c.utcHour, entryMinute: c.entryMinute, direction: c.direction, priceMin: c.priceMin, priceMax: c.priceMax, train: c.train, holdout: c.holdout, recent7: c.recent7 })) },
    bestPortfolio: best ? {
      strategyCount: best.strategies.length,
      eval: best.eval,
      bootstrap: { d1: bootstrap(bestRows, 1, MC_TRIALS), d2: bootstrap(bestRows, 2, MC_TRIALS), d7: bootstrap(bestRows, 7, MC_TRIALS) },
      strategies: best.strategies.map(s => ({ name: s.name, asset: s.asset, utcHour: s.utcHour, entryMinute: s.entryMinute, direction: s.direction, priceMin: s.priceMin, priceMax: s.priceMax, pWinEstimate: round(s.pWinEstimate), evWinEstimate: round(s.evWinEstimate), train: s.train, holdout: s.holdout, recent7: s.recent7 }))
    } : null,
    finalists: search.finalists.map(f => ({ strategyCount: f.strategies.length, eval: f.eval, names: f.strategies.map(s => s.name) })),
    artifacts: { report: `debug/fresh_strategy_search_fast_${OUT_PREFIX}.json`, strategy: best ? `strategies/strategy_set_15m_fresh_fast_${OUT_PREFIX}.json` : null }
  };
  writeJson(report.artifacts.report, report);
  if (best) {
    writeJson(report.artifacts.strategy, {
      name: `fresh_fast_${OUT_PREFIX}`,
      description: 'Fresh fast-mined 15m strategy set. Deployment requires explicit GO verdict after reviewing source report.',
      generatedAt: report.generatedAt,
      sourceReport: report.artifacts.report,
      stats: report.bestPortfolio.eval,
      bootstrap: report.bestPortfolio.bootstrap,
      strategies: report.bestPortfolio.strategies.map((s, i) => ({ id: i + 1, name: s.name, asset: s.asset, utcHour: s.utcHour, entryMinute: s.entryMinute, direction: s.direction, priceMin: s.priceMin, priceMax: s.priceMax, pWinEstimate: s.pWinEstimate, evWinEstimate: s.evWinEstimate, winRate: s.holdout.wr, winRateLCB: s.holdout.lcb, tier: 'FRESH_FAST_HOLDOUT' }))
    });
  }
  console.log(JSON.stringify(report, null, 2));
}

main();
