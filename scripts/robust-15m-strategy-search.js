#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { calcPolymarketTakerFeeUsdPerShare } = require('../lib/polymarket-fees');

const ROOT = path.resolve(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'epoch3', 'reinvestigation_v2');
const STRATEGY_DIR = path.join(ROOT, 'strategies');
const CACHE_FILE = process.env.CYCLE_CACHE || 'debug/definitive_15m_cycle_cache_7d.json';
const START_BANKROLL = Number(process.env.BANKROLL || '14.690226');
const MAX_RULES = Math.max(1, Number(process.env.MAX_RULES || '12'));
const ADVERSE_FILL_CENTS = Number(process.env.ADVERSE_FILL_CENTS || '0.02');
const SLIPPAGE_PCT = Number(process.env.SLIPPAGE_PCT || '0.01');
const MIN_TRIGGERS_ALL = Number(process.env.MIN_TRIGGERS_ALL || '18');
const MIN_RECENT3_TRIGGERS = Number(process.env.MIN_RECENT3_TRIGGERS || '6');
const MIN_LOO_WR = Number(process.env.MIN_LOO_WR || '0.70');
const MIN_LCB = Number(process.env.MIN_LCB || '0.62');
const MIN_AVG_PNL = Number(process.env.MIN_AVG_PNL || '0.05');
const MIN_RECENT3_PNL = Number(process.env.MIN_RECENT3_PNL || '0');
const MAX_RULE_DRAWDOWN = Number(process.env.MAX_RULE_DRAWDOWN || '0.45');

function ensureDir(dir) { fs.mkdirSync(dir, { recursive: true }); }
function readJson(relPath) { return JSON.parse(fs.readFileSync(path.join(ROOT, relPath), 'utf8')); }
function round(value, digits = 6) { return Number.isFinite(value) ? Math.round(value * 10 ** digits) / 10 ** digits : null; }

function wilsonLowerBound(wins, total, z = 1.96) {
  if (!total) return 0;
  const p = wins / total;
  const d = 1 + z * z / total;
  return Math.max(0, (p + z * z / (2 * total) - z * Math.sqrt(p * (1 - p) / total + z * z / (4 * total * total))) / d);
}

function effectiveEntry(price) {
  const p = Number(price);
  if (!Number.isFinite(p) || p <= 0 || p >= 1) return null;
  return Math.min(0.99, p + ADVERSE_FILL_CENTS, p * (1 + SLIPPAGE_PCT));
}

function pnlPerShare(won, price) {
  const entry = effectiveEntry(price);
  if (!entry) return null;
  const fee = calcPolymarketTakerFeeUsdPerShare(entry);
  return won ? 1 - entry - fee : -entry - fee;
}

function dayKey(epoch) { return new Date(epoch * 1000).toISOString().slice(0, 10); }

function buildObservations(cycles) {
  const rows = [];
  for (const cycle of cycles) {
    const outcome = String(cycle.outcome || '').toUpperCase();
    if (!['UP', 'DOWN'].includes(outcome)) continue;
    for (const priceRow of cycle.prices || []) {
      const minute = Number(priceRow.minute);
      if (!Number.isFinite(minute)) continue;
      for (const direction of ['UP', 'DOWN']) {
        const price = Number(priceRow[direction]);
        if (!Number.isFinite(price) || price <= 0.02 || price >= 0.98) continue;
        const won = outcome === direction;
        const pnl = pnlPerShare(won, price);
        if (pnl === null) continue;
        rows.push({
          asset: String(cycle.asset).toUpperCase(),
          epoch: Number(cycle.epoch),
          day: dayKey(Number(cycle.epoch)),
          utcHour: Number(cycle.utcHour),
          entryMinute: minute,
          direction,
          price,
          effectiveEntry: effectiveEntry(price),
          won,
          pnlPerShare: pnl,
        });
      }
    }
  }
  return rows;
}

function binForPrice(price) {
  const low = Math.floor(Number(price) * 20) / 20;
  const high = low + 0.05;
  return { low: round(Math.max(0.02, low), 2), high: round(Math.min(0.98, high), 2) };
}

function summarise(rows) {
  const wins = rows.filter((row) => row.won).length;
  const pnl = rows.reduce((sum, row) => sum + row.pnlPerShare, 0);
  const avgEntry = rows.length ? rows.reduce((sum, row) => sum + row.effectiveEntry, 0) / rows.length : 0;
  return { triggers: rows.length, wins, losses: rows.length - wins, winRate: rows.length ? wins / rows.length : 0, wilsonLCB95: wilsonLowerBound(wins, rows.length), avgPnlPerShare: rows.length ? pnl / rows.length : 0, avgEntry };
}

function simulateRule(rows, startBankroll = START_BANKROLL) {
  let bankroll = startBankroll;
  let peak = startBankroll;
  let minBankroll = startBankroll;
  let trades = 0;
  let wins = 0;
  let losses = 0;
  for (const row of [...rows].sort((a, b) => a.epoch - b.epoch)) {
    const stakeFraction = bankroll < 15 ? 0.40 : bankroll < 50 ? 0.35 : 0.30;
    const cost = Math.max(5 * row.effectiveEntry, Math.min(bankroll * stakeFraction, 100));
    if (cost > bankroll) continue;
    const shares = cost / row.effectiveEntry;
    const pnl = shares * row.pnlPerShare;
    bankroll += pnl;
    peak = Math.max(peak, bankroll);
    minBankroll = Math.min(minBankroll, bankroll);
    trades += 1;
    wins += row.won ? 1 : 0;
    losses += row.won ? 0 : 1;
    if (bankroll <= 0) break;
  }
  return { endBankroll: bankroll, profit: bankroll - startBankroll, minBankroll, maxDrawdownPct: peak > 0 ? (peak - minBankroll) / peak : 1, trades, wins, losses, winRate: trades ? wins / trades : 0 };
}

function leaveOneDayOut(rows) {
  const days = [...new Set(rows.map((row) => row.day))].sort();
  const folds = days.map((day) => {
    const fold = rows.filter((row) => row.day === day);
    return { day, ...summarise(fold) };
  });
  return {
    days: folds,
    minWinRate: folds.length ? Math.min(...folds.map((fold) => fold.winRate)) : 0,
    minAvgPnlPerShare: folds.length ? Math.min(...folds.map((fold) => fold.avgPnlPerShare)) : 0,
    negativeDays: folds.filter((fold) => fold.avgPnlPerShare <= 0).length,
  };
}

function candidateKey(row, allAsset = false) {
  const bin = binForPrice(row.price);
  return [allAsset ? 'ALL' : row.asset, row.utcHour, row.entryMinute, row.direction, bin.low, bin.high].join('|');
}

function candidateFromKey(key, rows) {
  const [asset, utcHour, entryMinute, direction, priceMin, priceMax] = key.split('|');
  const all = summarise(rows);
  const maxEpoch = Math.max(...rows.map((row) => row.epoch));
  const recent3 = summarise(rows.filter((row) => row.epoch >= maxEpoch - 3 * 86400));
  const loo = leaveOneDayOut(rows);
  const sim = simulateRule(rows);
  const score = (recent3.avgPnlPerShare * 4) + (all.avgPnlPerShare * 2) + (all.wilsonLCB95 * 0.5) - (sim.maxDrawdownPct * 0.8) - (loo.negativeDays * 0.2);
  return { key, asset, utcHour: Number(utcHour), entryMinute: Number(entryMinute), direction, priceMin: Number(priceMin), priceMax: Number(priceMax), all, recent3, loo, sim, score };
}

function discoverCandidates(rows) {
  const buckets = new Map();
  for (const row of rows) {
    for (const key of [candidateKey(row, false), candidateKey(row, true)]) {
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key).push(row);
    }
  }
  return [...buckets.entries()].map(([key, bucketRows]) => candidateFromKey(key, bucketRows)).filter((c) =>
    c.all.triggers >= MIN_TRIGGERS_ALL &&
    c.recent3.triggers >= MIN_RECENT3_TRIGGERS &&
    c.all.wilsonLCB95 >= MIN_LCB &&
    c.all.avgPnlPerShare >= MIN_AVG_PNL &&
    c.recent3.avgPnlPerShare >= MIN_RECENT3_PNL &&
    c.loo.minWinRate >= MIN_LOO_WR &&
    c.loo.negativeDays === 0 &&
    c.sim.maxDrawdownPct <= MAX_RULE_DRAWDOWN
  ).sort((a, b) => b.score - a.score);
}

function productionTier(bankroll) {
  if (bankroll < 15) return { stakeFraction: 0.40, maxPerCycle: 1, maxAbsoluteStake: 100 };
  if (bankroll < 50) return { stakeFraction: 0.35, maxPerCycle: 2, maxAbsoluteStake: 100 };
  if (bankroll < 200) return { stakeFraction: 0.30, maxPerCycle: 2, maxAbsoluteStake: 100 };
  if (bankroll < 1000) return { stakeFraction: 0.25, maxPerCycle: 2, maxAbsoluteStake: 100 };
  if (bankroll < 10000) return { stakeFraction: 0.25, maxPerCycle: 2, maxAbsoluteStake: 200 };
  return { stakeFraction: 0.25, maxPerCycle: 2, maxAbsoluteStake: 500 };
}

function matchRule(rule, row) {
  return (rule.asset === 'ALL' || rule.asset === row.asset) &&
    rule.utcHour === row.utcHour &&
    rule.entryMinute === row.entryMinute &&
    rule.direction === row.direction &&
    row.price >= rule.priceMin &&
    row.price <= rule.priceMax;
}

function simulateSet(rules, rows, startBankroll = START_BANKROLL) {
  const matches = [];
  for (const row of rows) {
    for (const rule of rules) {
      if (matchRule(rule, row)) matches.push({ ...row, ruleKey: rule.key, ruleScore: rule.score });
    }
  }
  const byEpoch = new Map();
  for (const match of matches) {
    if (!byEpoch.has(match.epoch)) byEpoch.set(match.epoch, []);
    byEpoch.get(match.epoch).push(match);
  }
  let bankroll = startBankroll;
  let peak = startBankroll;
  let minBankroll = startBankroll;
  let trades = 0;
  let wins = 0;
  let losses = 0;
  const dayStats = new Map();
  for (const [epoch, epochRows] of [...byEpoch.entries()].sort((a, b) => a[0] - b[0])) {
    const tier = productionTier(bankroll);
    let available = bankroll;
    let opened = 0;
    let cyclePnl = 0;
    const ordered = epochRows.sort((a, b) => b.ruleScore - a.ruleScore || b.pnlPerShare - a.pnlPerShare);
    for (const row of ordered) {
      if (opened >= tier.maxPerCycle) break;
      let cost = Math.min(bankroll * tier.stakeFraction, tier.maxAbsoluteStake, available);
      const minCost = 5 * row.effectiveEntry;
      if (cost < minCost) {
        if (available >= minCost) cost = minCost;
        else continue;
      }
      const shares = cost / row.effectiveEntry;
      const pnl = shares * row.pnlPerShare;
      available -= cost;
      cyclePnl += pnl;
      trades += 1;
      wins += row.won ? 1 : 0;
      losses += row.won ? 0 : 1;
      opened += 1;
      const stat = dayStats.get(row.day) || { trades: 0, wins: 0, losses: 0, pnl: 0 };
      stat.trades += 1;
      stat.wins += row.won ? 1 : 0;
      stat.losses += row.won ? 0 : 1;
      stat.pnl += pnl;
      dayStats.set(row.day, stat);
    }
    bankroll += cyclePnl;
    peak = Math.max(peak, bankroll);
    minBankroll = Math.min(minBankroll, bankroll);
    if (bankroll <= 0) break;
  }
  const days = [...dayStats.entries()].map(([day, stat]) => ({ day, ...stat, pnl: round(stat.pnl, 4) }));
  return { startBankroll, endBankroll: bankroll, profit: bankroll - startBankroll, minBankroll, maxDrawdownPct: peak > 0 ? (peak - minBankroll) / peak : 1, trades, wins, losses, winRate: trades ? wins / trades : 0, days };
}

function sanitizeRule(candidate, id) {
  return {
    id,
    name: `robust15m_${candidate.asset}_${candidate.utcHour}_${candidate.entryMinute}_${candidate.direction}_${candidate.priceMin}_${candidate.priceMax}`,
    timeframe: '15m',
    asset: candidate.asset,
    utcHour: candidate.utcHour,
    entryMinute: candidate.entryMinute,
    direction: candidate.direction,
    priceMin: candidate.priceMin,
    priceMax: candidate.priceMax,
    pWinEstimate: round(candidate.recent3.winRate, 6),
    winRateLCB: round(candidate.all.wilsonLCB95, 6),
    expectedPnlPerShare: round(candidate.recent3.avgPnlPerShare, 6),
    source: 'robust_15m_walkforward_search_20260509',
  };
}

function main() {
  ensureDir(OUT_DIR);
  ensureDir(STRATEGY_DIR);
  const cache = readJson(CACHE_FILE);
  const rows = buildObservations(cache.cycles || []);
  const candidates = discoverCandidates(rows);
  const selected = [];
  const occupied = new Set();
  for (const candidate of candidates) {
    const slot = `${candidate.asset}|${candidate.utcHour}|${candidate.entryMinute}|${candidate.direction}`;
    if (occupied.has(slot)) continue;
    selected.push(candidate);
    occupied.add(slot);
    if (selected.length >= MAX_RULES) break;
  }
  const current = readJson('strategies/strategy_set_15m_definitive_search_20260508T184521Z.json').strategies || [];
  const currentRules = current.map((rule, index) => ({ key: String(rule.id || index), asset: String(rule.asset || 'ALL').toUpperCase(), utcHour: Number(rule.utcHour), entryMinute: Number(rule.entryMinute), direction: String(rule.direction).toUpperCase(), priceMin: Number(rule.priceMin), priceMax: Number(rule.priceMax), score: Number(rule.score || rule.expectedPnlPerShare || 0) }));
  const currentSim = simulateSet(currentRules, rows, START_BANKROLL);
  const selectedSim = simulateSet(selected, rows, START_BANKROLL);
  const ts = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  const strategyArtifact = path.join(STRATEGY_DIR, `strategy_set_15m_robust_walkforward_${ts}.json`);
  const reportArtifact = path.join(OUT_DIR, `robust_15m_strategy_search_${ts}.json`);
  const strategySet = {
    version: 'robust-15m-walkforward-20260509',
    generatedAt: new Date().toISOString(),
    description: 'Strict recent 15m strategy candidates requiring rule-level leave-one-day-out positive days, adverse fill modelling, recent 3d profitability, and bounded drawdown.',
    strategies: selected.map((candidate, index) => sanitizeRule(candidate, 9501 + index)),
  };
  fs.writeFileSync(strategyArtifact, `${JSON.stringify(strategySet, null, 2)}\n`);
  const report = {
    generatedAt: strategySet.generatedAt,
    cacheFile: CACHE_FILE,
    assumptions: { startBankroll: START_BANKROLL, adverseFillCents: ADVERSE_FILL_CENTS, slippagePct: SLIPPAGE_PCT, minTriggersAll: MIN_TRIGGERS_ALL, minRecent3Triggers: MIN_RECENT3_TRIGGERS, minLeaveOneDayOutWinRate: MIN_LOO_WR, minWilsonLCB: MIN_LCB, minAvgPnl: MIN_AVG_PNL, maxRuleDrawdown: MAX_RULE_DRAWDOWN },
    totalObservations: rows.length,
    candidatesFound: candidates.length,
    selectedCount: selected.length,
    selected: selected.map((candidate, index) => ({ id: 9501 + index, ...sanitizeRule(candidate, 9501 + index), all: candidate.all, recent3: candidate.recent3, loo: candidate.loo, sim: candidate.sim, score: candidate.score })),
    simulations: { current: currentSim, selected: selectedSim },
    strategyArtifact: path.relative(ROOT, strategyArtifact),
    verdict: selected.length >= 3 && selectedSim.profit > currentSim.profit && selectedSim.maxDrawdownPct <= 0.45 ? 'CANDIDATE_FOUND_BUT_REQUIRES_LIVE_FORWARD_APPROVAL' : 'NO_STRATEGY_MEETS_STRICT_GOAL_GATE',
  };
  fs.writeFileSync(reportArtifact, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ report: path.relative(ROOT, reportArtifact), strategyArtifact: path.relative(ROOT, strategyArtifact), verdict: report.verdict, candidatesFound: candidates.length, selectedCount: selected.length, simulations: report.simulations }, null, 2));
}

main();