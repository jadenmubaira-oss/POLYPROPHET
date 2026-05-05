#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const STRATEGY_PATH = process.env.STRATEGY_PATH || 'strategies/strategy_set_15m_fresh_best_may5_fresh_v1.json';
const FRESH_PATH = process.env.FRESH_PATH || 'debug/fresh_full_intracycle_may5_fresh_v1.json';
const OUT_PATH = process.env.OUT_PATH || 'debug/fresh_strategy_validation_may5_fresh_v1.json';
const START_BALANCE = Number(process.env.START_BALANCE || 10.43);
const TAKER_FEE = Number(process.env.TAKER_FEE_PCT || 0.0315);
const SLIPPAGE = Number(process.env.SLIPPAGE_PCT || 0.01);
const MIN_SHARES = Math.max(5, Number(process.env.MIN_SHARES || 5));
const HARD_ENTRY_PRICE_CAP = Math.min(0.99, Number(process.env.HARD_ENTRY_PRICE_CAP || 0.82));
const MC_TRIALS = Math.max(100, Number(process.env.MC_TRIALS || 5000));
const COOLDOWN_LOSSES = Math.max(1, Number(process.env.MAX_CONSECUTIVE_LOSSES || 4));
const COOLDOWN_SECONDS = Math.max(0, Number(process.env.COOLDOWN_SECONDS || 300));
const GLOBAL_STOP_LOSS = Math.max(0, Number(process.env.GLOBAL_STOP_LOSS || 0.20));
const MIN_BALANCE_FLOOR = Math.max(0, Number(process.env.MIN_BALANCE_FLOOR || 0));

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
function match(cycle, strategy) {
  const asset = String(strategy.asset || 'ALL').toUpperCase();
  if (asset !== 'ALL' && asset !== String(cycle.asset).toUpperCase()) return null;
  const utcHour = new Date(Number(cycle.epoch) * 1000).getUTCHours();
  if (Number(strategy.utcHour) !== -1 && Number(strategy.utcHour) !== utcHour) return null;
  const entryMinute = Number(strategy.entryMinute);
  if (!spreadOk(cycle, entryMinute)) return null;
  const direction = String(strategy.direction || '').toUpperCase();
  const entryPrice = priceAt(cycle, direction, entryMinute);
  if (entryPrice == null) return null;
  if (entryPrice > HARD_ENTRY_PRICE_CAP) return null;
  if (entryPrice < Number(strategy.priceMin) || entryPrice > Number(strategy.priceMax)) return null;
  const resolution = String(cycle.resolution || '').toUpperCase();
  return {
    asset: cycle.asset,
    epoch: Number(cycle.epoch),
    entryTs: Number(cycle.epoch) + entryMinute * 60,
    exitTs: Number(cycle.epoch) + 900,
    day: dayKey(cycle.epoch),
    direction,
    entryMinute,
    entryPrice,
    won: resolution === direction,
    strategy: strategy.name,
    pWinEstimate: Number(strategy.pWinEstimate || strategy.winRateLCB || strategy.winRate || 0.5),
    evWinEstimate: Number(strategy.evWinEstimate || strategy.pWinEstimate || strategy.winRate || 0.5),
    cycleKey: `15m_${cycle.epoch}`
  };
}
function buildMatches(cycles, strategies) {
  const rows = [];
  for (const cycle of cycles) {
    for (const strategy of strategies) {
      const hit = match(cycle, strategy);
      if (hit) rows.push(hit);
    }
  }
  rows.sort((a, b) => a.entryTs - b.entryTs || b.pWinEstimate - a.pWinEstimate || a.entryPrice - b.entryPrice);
  return rows;
}
function basicStats(rows) {
  const n = rows.length;
  const w = rows.filter(r => r.won).length;
  const avgEntry = n ? rows.reduce((s, r) => s + r.entryPrice, 0) / n : null;
  return { n, w, l: n - w, wr: n ? round(w / n) : null, avgEntry: round(avgEntry) };
}
function tier(bankroll) {
  if (bankroll < 15) return { maxPerCycle: 1, stakeFraction: 0.40, label: 'BOOTSTRAP' };
  if (bankroll < 50) return { maxPerCycle: 2, stakeFraction: 0.35, label: 'GROWTH' };
  if (bankroll < 200) return { maxPerCycle: 3, stakeFraction: 0.30, label: 'ACCELERATE' };
  return { maxPerCycle: 5, stakeFraction: 0.25, label: 'PRESERVE' };
}
function maxAbsStake(bankroll) {
  if (bankroll < 1000) return 100;
  if (bankroll < 10000) return 200;
  return 500;
}
function sizeFor(bankroll, peak, entryPrice, pWin) {
  const t = tier(bankroll);
  let stakeFraction = t.stakeFraction;
  if (peak > 20 && (peak - bankroll) / peak >= 0.20) stakeFraction = Math.min(stakeFraction, 0.12);
  let size = bankroll * stakeFraction;
  if (pWin >= 0.55 && entryPrice > 0 && entryPrice < 1) {
    const effectiveEntry = Math.min(0.99, entryPrice * (1 + SLIPPAGE));
    const b = (1 / effectiveEntry) - 1;
    if (b > 0) {
      const fullKelly = (b * pWin - (1 - pWin)) / b;
      if (fullKelly > 0) size = Math.min(size, bankroll * Math.min(fullKelly * 0.35, 0.45));
    }
  }
  size = Math.min(size, maxAbsStake(bankroll), bankroll);
  const minCost = MIN_SHARES * entryPrice;
  if (size < minCost) {
    if (bankroll >= minCost) size = minCost;
    else return { blocked: true, size: 0, reason: 'BELOW_MIN_ORDER' };
  }
  return { blocked: false, size };
}
function simulate(rows, startBalance = START_BALANCE) {
  let cash = startBalance;
  let peakEquity = startBalance;
  let dayStartEquity = startBalance;
  let currentDay = null;
  let cooldownUntil = -Infinity;
  let consecutiveLosses = 0;
  let totalTrades = 0;
  let wins = 0;
  let losses = 0;
  let maxDrawdown = 0;
  let worstCash = startBalance;
  const open = [];
  const cycleCounts = new Map();
  const daily = [];
  const tradeLog = [];
  function equity() {
    return cash + open.reduce((s, p) => s + p.cost, 0);
  }
  function updateDD() {
    const eq = equity();
    if (eq > peakEquity) peakEquity = eq;
    maxDrawdown = Math.max(maxDrawdown, peakEquity > 0 ? (peakEquity - eq) / peakEquity : 0);
    if (cash < worstCash) worstCash = cash;
  }
  function settleUpTo(ts) {
    open.sort((a, b) => a.exitTs - b.exitTs);
    while (open.length && open[0].exitTs <= ts) {
      const p = open.shift();
      if (p.won) {
        const grossProfit = p.shares - p.cost;
        const fee = Math.max(0, grossProfit) * TAKER_FEE;
        cash += p.shares - fee;
        wins++;
        consecutiveLosses = 0;
      } else {
        losses++;
        consecutiveLosses++;
        if (consecutiveLosses >= COOLDOWN_LOSSES) {
          cooldownUntil = p.exitTs + COOLDOWN_SECONDS;
          consecutiveLosses = 0;
        }
      }
      totalTrades++;
      updateDD();
    }
  }
  for (const r of rows) {
    settleUpTo(r.entryTs);
    const d = dayKey(Math.floor(r.entryTs / 900) * 900);
    if (currentDay !== d) {
      if (currentDay) daily.push({ day: currentDay, equity: round(equity(), 2), cash: round(cash, 2), trades: totalTrades, wins, losses });
      currentDay = d;
      dayStartEquity = equity();
    }
    if (cash < MIN_BALANCE_FLOOR) continue;
    if (r.entryTs < cooldownUntil) continue;
    if (GLOBAL_STOP_LOSS > 0 && equity() < dayStartEquity * (1 - GLOBAL_STOP_LOSS)) continue;
    const t = tier(equity());
    const used = cycleCounts.get(r.cycleKey) || 0;
    if (used >= t.maxPerCycle) continue;
    const sizing = sizeFor(equity(), peakEquity, r.entryPrice, r.pWinEstimate);
    if (sizing.blocked) continue;
    const shares = Math.floor(sizing.size / r.entryPrice + 1e-9);
    if (shares < MIN_SHARES) continue;
    const cost = shares * r.entryPrice;
    if (cost > cash) continue;
    cash -= cost;
    cycleCounts.set(r.cycleKey, used + 1);
    open.push({ exitTs: r.exitTs, cost, shares, won: r.won });
    tradeLog.push({ iso: new Date(r.entryTs * 1000).toISOString(), asset: r.asset, strategy: r.strategy, entryPrice: round(r.entryPrice), cost: round(cost, 2), won: r.won, cashAfterEntry: round(cash, 2) });
    updateDD();
  }
  settleUpTo(Number.MAX_SAFE_INTEGER);
  if (currentDay) daily.push({ day: currentDay, equity: round(equity(), 2), cash: round(cash, 2), trades: totalTrades, wins, losses });
  return { finalBalance: round(cash, 2), totalTrades, wins, losses, winRate: totalTrades ? round(wins / totalTrades) : null, maxDrawdown: round(maxDrawdown), worstCash: round(worstCash, 2), busted: cash < 1.5, daily, tradeLog: tradeLog.slice(0, 250) };
}
function selectOnePerCycle(rows) {
  const by = new Map();
  for (const r of rows) {
    const existing = by.get(r.cycleKey);
    if (!existing || r.pWinEstimate > existing.pWinEstimate || (r.pWinEstimate === existing.pWinEstimate && r.entryPrice < existing.entryPrice)) by.set(r.cycleKey, r);
  }
  return [...by.values()].sort((a, b) => a.entryTs - b.entryTs);
}
function byDayStats(rows) {
  const map = new Map();
  for (const r of rows) {
    if (!map.has(r.day)) map.set(r.day, []);
    map.get(r.day).push(r);
  }
  return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([day, dayRows]) => ({ day, ...basicStats(dayRows), selectedOnePerCycle: basicStats(selectOnePerCycle(dayRows)), sim: simulate(dayRows) }));
}
function bootstrapFromDays(dayRows, days, trials) {
  const map = new Map();
  for (const r of dayRows) {
    if (!map.has(r.day)) map.set(r.day, []);
    map.get(r.day).push(r);
  }
  const keys = [...map.keys()].sort();
  const finals = [];
  let busts = 0;
  let trades = 0;
  let wr = 0;
  let dd = 0;
  for (let i = 0; i < trials; i++) {
    const seq = [];
    for (let d = 0; d < days; d++) {
      const sourceDay = keys[Math.floor(Math.random() * keys.length)];
      for (const r of map.get(sourceDay) || []) {
        const offset = r.entryTs % 86400;
        seq.push({ ...r, entryTs: d * 86400 + offset, exitTs: d * 86400 + (r.exitTs % 86400), cycleKey: `${d}_${r.cycleKey}`, day: `D${d}` });
      }
    }
    seq.sort((a, b) => a.entryTs - b.entryTs || b.pWinEstimate - a.pWinEstimate || a.entryPrice - b.entryPrice);
    const res = simulate(seq);
    finals.push(res.finalBalance);
    if (res.busted) busts++;
    trades += res.totalTrades;
    wr += res.winRate || 0;
    dd += res.maxDrawdown || 0;
  }
  finals.sort((a, b) => a - b);
  const pct = p => round(finals[Math.min(finals.length - 1, Math.max(0, Math.floor((finals.length - 1) * p)))], 2);
  return { trials, days, sourceDays: keys.length, bustRate: round(busts / trials), avgTrades: round(trades / trials, 1), avgWinRate: round(wr / trials), avgMaxDrawdown: round(dd / trials), finalBalance: { min: pct(0), p10: pct(0.1), p25: pct(0.25), median: pct(0.5), p75: pct(0.75), p90: pct(0.9), max: pct(1) } };
}
function lossStress(avgEntry) {
  const rows = [];
  for (let i = 0; i < 10; i++) {
    rows.push({ entryTs: i * 900 + 360, exitTs: (i + 1) * 900, day: 'stress', asset: 'STRESS', strategy: 'forced_loss', entryPrice: avgEntry, won: false, pWinEstimate: 0.6, cycleKey: `stress_${i}` });
  }
  return simulate(rows);
}
function main() {
  const local = readJson('data/intracycle-price-data.json').cycles || [];
  const fresh = readJson(FRESH_PATH).cycles || [];
  const strategySet = readJson(STRATEGY_PATH);
  const cycles = mergeCycles(local, fresh);
  const matches = buildMatches(cycles, strategySet.strategies || []);
  const epochs = cycles.map(c => c.epoch).sort((a, b) => a - b);
  const maxEpoch = epochs[epochs.length - 1];
  const windows = {};
  for (const days of [1, 2, 3, 7, 14]) {
    const cutoff = maxEpoch - days * 86400;
    const rows = matches.filter(r => r.epoch >= cutoff);
    const selected = selectOnePerCycle(rows);
    windows[`${days}d`] = { allMatches: basicStats(rows), selectedOnePerCycle: basicStats(selected), sim: simulate(rows) };
  }
  const holdoutRows = matches.filter(r => r.epoch >= maxEpoch - 3 * 86400);
  const report = {
    generatedAt: new Date().toISOString(),
    inputs: { STRATEGY_PATH, FRESH_PATH, START_BALANCE, TAKER_FEE, SLIPPAGE, MIN_SHARES, HARD_ENTRY_PRICE_CAP, COOLDOWN_LOSSES, COOLDOWN_SECONDS, GLOBAL_STOP_LOSS, MIN_BALANCE_FLOOR },
    data: { localCycles: local.length, freshCycles: fresh.length, mergedCycles: cycles.length, range: { start: new Date(epochs[0] * 1000).toISOString(), end: new Date(maxEpoch * 1000).toISOString() } },
    strategy: { name: strategySet.name, count: (strategySet.strategies || []).length },
    allMatches: basicStats(matches),
    selectedOnePerCycleAll: basicStats(selectOnePerCycle(matches)),
    windows,
    dayByDay: byDayStats(matches),
    bootstrapFreshHoldoutDays: { d1: bootstrapFromDays(holdoutRows, 1, MC_TRIALS), d2: bootstrapFromDays(holdoutRows, 2, MC_TRIALS), d7: bootstrapFromDays(holdoutRows, 7, MC_TRIALS) },
    stress: { tenConsecutiveLossesAtAvgEntry: lossStress(basicStats(matches).avgEntry || 0.62) }
  };
  writeJson(OUT_PATH, report);
  console.log(JSON.stringify(report, null, 2));
}

main();
