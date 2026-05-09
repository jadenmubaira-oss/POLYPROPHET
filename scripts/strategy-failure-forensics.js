#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');
const { calcPolymarketTakerFeeUsdPerShare } = require('../lib/polymarket-fees');

const ROOT = path.resolve(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'epoch3', 'reinvestigation_v2');
const STRATEGY_FILE = process.env.STRATEGY_FILE || 'strategies/strategy_set_15m_definitive_search_20260508T184521Z.json';
const CACHE_FILE = process.env.CYCLE_CACHE || 'debug/definitive_15m_cycle_cache_7d.json';
const BANKROLL = Number(process.env.BANKROLL || '14.690226');
const ADVERSE_FILL_CENTS = Number(process.env.ADVERSE_FILL_CENTS || '0.02');
const SLIPPAGE_PCT = Number(process.env.SLIPPAGE_PCT || '0.01');
const MIN_SELL_NOTIONAL = Number(process.env.MIN_SELL_NOTIONAL || '1');
const LIVE_API = String(process.env.LIVE_API || 'https://polyprophet.fly.dev').replace(/\/$/, '');

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function round(value, digits = 6) {
  if (!Number.isFinite(value)) return null;
  const m = 10 ** digits;
  return Math.round(value * m) / m;
}

function getJson(url, timeoutMs = 90000) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout: timeoutMs }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(`HTTP_${res.statusCode} ${url}`));
          return;
        }
        try { resolve(JSON.parse(data)); } catch (error) { reject(error); }
      });
    });
    req.on('timeout', () => req.destroy(new Error(`TIMEOUT ${url}`)));
    req.on('error', reject);
  });
}

function loadJson(relPath) {
  return JSON.parse(fs.readFileSync(path.join(ROOT, relPath), 'utf8'));
}

function wilsonLowerBound(wins, total, z = 1.96) {
  if (!total) return 0;
  const phat = wins / total;
  const denom = 1 + (z * z) / total;
  const centre = phat + (z * z) / (2 * total);
  const margin = z * Math.sqrt((phat * (1 - phat) + (z * z) / (4 * total)) / total);
  return (centre - margin) / denom;
}

function entryPrice(rawPrice) {
  const raw = Number(rawPrice);
  if (!Number.isFinite(raw) || raw <= 0 || raw >= 1) return null;
  return Math.min(0.99, raw + ADVERSE_FILL_CENTS, raw * (1 + SLIPPAGE_PCT));
}

function pnlPerShare(direction, outcome, rawPrice) {
  const entry = entryPrice(rawPrice);
  if (!entry) return null;
  const fee = calcPolymarketTakerFeeUsdPerShare(entry);
  return String(outcome).toUpperCase() === String(direction).toUpperCase()
    ? 1 - entry - fee
    : -entry - fee;
}

function cycleRowsForStrategy(strategy, cycles) {
  const rows = [];
  for (const cycle of cycles) {
    if (String(strategy.asset || 'ALL').toUpperCase() !== 'ALL' && String(cycle.asset).toUpperCase() !== String(strategy.asset).toUpperCase()) continue;
    if (Number(cycle.utcHour) !== Number(strategy.utcHour)) continue;
    const priceRow = (cycle.prices || []).find((row) => Number(row.minute) === Number(strategy.entryMinute));
    if (!priceRow) continue;
    const direction = String(strategy.direction || '').toUpperCase();
    const raw = Number(priceRow[direction]);
    if (!Number.isFinite(raw)) continue;
    if (raw < Number(strategy.priceMin) || raw > Number(strategy.priceMax)) continue;
    const pnl = pnlPerShare(direction, cycle.outcome, raw);
    if (pnl === null) continue;
    rows.push({
      asset: cycle.asset,
      epoch: Number(cycle.epoch),
      iso: cycle.iso,
      utcHour: cycle.utcHour,
      entryMinute: Number(strategy.entryMinute),
      direction,
      outcome: cycle.outcome,
      price: raw,
      effectiveEntry: entryPrice(raw),
      pnlPerShare: pnl,
      won: String(cycle.outcome).toUpperCase() === direction,
      strategyId: strategy.id,
      strategyName: strategy.name || null,
    });
  }
  return rows;
}

function summarise(rows) {
  const wins = rows.filter((row) => row.won).length;
  const losses = rows.length - wins;
  const avgPnl = rows.length ? rows.reduce((sum, row) => sum + row.pnlPerShare, 0) / rows.length : 0;
  const avgEntry = rows.length ? rows.reduce((sum, row) => sum + row.effectiveEntry, 0) / rows.length : 0;
  return {
    triggers: rows.length,
    wins,
    losses,
    winRate: rows.length ? wins / rows.length : 0,
    wilsonLCB95: wilsonLowerBound(wins, rows.length),
    avgPnlPerShare: avgPnl,
    avgEntry,
  };
}

function productionTier(bankroll) {
  if (bankroll < 15) return { stakeFraction: 0.40, maxPerCycle: 1, maxAbsoluteStake: 100 };
  if (bankroll < 50) return { stakeFraction: 0.35, maxPerCycle: 2, maxAbsoluteStake: 100 };
  if (bankroll < 200) return { stakeFraction: 0.30, maxPerCycle: 2, maxAbsoluteStake: 100 };
  if (bankroll < 1000) return { stakeFraction: 0.25, maxPerCycle: 2, maxAbsoluteStake: 100 };
  if (bankroll < 10000) return { stakeFraction: 0.25, maxPerCycle: 2, maxAbsoluteStake: 200 };
  return { stakeFraction: 0.25, maxPerCycle: 2, maxAbsoluteStake: 500 };
}

function simulate(rows, startBankroll = BANKROLL) {
  const byEpoch = new Map();
  for (const row of rows) {
    if (!byEpoch.has(row.epoch)) byEpoch.set(row.epoch, []);
    byEpoch.get(row.epoch).push(row);
  }
  let bankroll = startBankroll;
  let peak = startBankroll;
  let minBankroll = startBankroll;
  let maxDrawdownPct = 0;
  let trades = 0;
  let wins = 0;
  let losses = 0;
  const days = new Map();
  for (const [epoch, epochRows] of [...byEpoch.entries()].sort((a, b) => a[0] - b[0])) {
    const tier = productionTier(bankroll);
    let available = bankroll;
    let opened = 0;
    let cyclePnl = 0;
    for (const row of epochRows.sort((a, b) => b.pnlPerShare - a.pnlPerShare)) {
      if (opened >= tier.maxPerCycle) break;
      const minCost = 5 * row.effectiveEntry;
      let cost = Math.min(bankroll * tier.stakeFraction, tier.maxAbsoluteStake, available);
      if (cost < minCost) {
        if (available >= minCost) cost = minCost;
        else continue;
      }
      const shares = cost / row.effectiveEntry;
      const notionalExitIfSoldAtEntry = shares * row.effectiveEntry;
      const blockedByMinSell = notionalExitIfSoldAtEntry < MIN_SELL_NOTIONAL;
      const pnl = shares * row.pnlPerShare;
      available -= cost;
      cyclePnl += pnl;
      trades += 1;
      wins += row.won ? 1 : 0;
      losses += row.won ? 0 : 1;
      opened += 1;
      const day = new Date(epoch * 1000).toISOString().slice(0, 10);
      const stat = days.get(day) || { trades: 0, wins: 0, losses: 0, pnl: 0, blockedByMinSell: 0 };
      stat.trades += 1;
      stat.wins += row.won ? 1 : 0;
      stat.losses += row.won ? 0 : 1;
      stat.pnl += pnl;
      stat.blockedByMinSell += blockedByMinSell ? 1 : 0;
      days.set(day, stat);
    }
    bankroll += cyclePnl;
    peak = Math.max(peak, bankroll);
    minBankroll = Math.min(minBankroll, bankroll);
    maxDrawdownPct = peak > 0 ? Math.max(maxDrawdownPct, (peak - bankroll) / peak) : maxDrawdownPct;
    if (bankroll <= 0) break;
  }
  return { startBankroll, endBankroll: bankroll, profit: bankroll - startBankroll, minBankroll, maxDrawdownPct, trades, wins, losses, winRate: trades ? wins / trades : 0, days: [...days.entries()].map(([day, stat]) => ({ day, ...stat })) };
}

function liveTradeEpoch(trade) {
  const match = String(trade.id || '').match(/_(\d{10})_/);
  return match ? Number(match[1]) : null;
}

function liveTradeRule(trade, strategies) {
  const epoch = liveTradeEpoch(trade);
  const closed = Date.parse(trade.closedAt || trade.ts || '');
  const utcHour = epoch ? new Date(epoch * 1000).getUTCHours() : Number.isFinite(closed) ? new Date(closed).getUTCHours() : null;
  return strategies.filter((strategy) => {
    const asset = String(strategy.asset || 'ALL').toUpperCase();
    if (asset !== 'ALL' && asset !== String(trade.asset || '').toUpperCase()) return false;
    if (utcHour !== null && Number(strategy.utcHour) !== utcHour) return false;
    if (String(strategy.direction || '').toUpperCase() !== String(trade.direction || '').toUpperCase()) return false;
    const entry = Number(trade.entryPrice);
    return Number.isFinite(entry) && entry >= Number(strategy.priceMin) && entry <= Number(strategy.priceMax);
  });
}

function roundSummary(summary) {
  return Object.fromEntries(Object.entries(summary).map(([key, value]) => [key, Number.isFinite(value) ? round(value, 6) : value]));
}

async function main() {
  ensureDir(OUT_DIR);
  const strategies = loadJson(STRATEGY_FILE).strategies || [];
  const cycles = loadJson(CACHE_FILE).cycles || [];
  const rows = strategies.flatMap((strategy) => cycleRowsForStrategy(strategy, cycles));
  const allSummary = summarise(rows);
  const cutoff1d = Math.max(...cycles.map((cycle) => Number(cycle.epoch || 0))) - 86400;
  const cutoff3d = Math.max(...cycles.map((cycle) => Number(cycle.epoch || 0))) - 3 * 86400;
  const recent1Rows = rows.filter((row) => row.epoch >= cutoff1d);
  const recent3Rows = rows.filter((row) => row.epoch >= cutoff3d);
  const byRule = strategies.map((strategy) => {
    const ruleRows = rows.filter((row) => row.strategyId === strategy.id);
    const r3 = ruleRows.filter((row) => row.epoch >= cutoff3d);
    return {
      id: strategy.id,
      name: strategy.name || null,
      asset: strategy.asset,
      utcHour: strategy.utcHour,
      entryMinute: strategy.entryMinute,
      direction: strategy.direction,
      priceMin: strategy.priceMin,
      priceMax: strategy.priceMax,
      all: roundSummary(summarise(ruleRows)),
      recent3: roundSummary(summarise(r3)),
    };
  });
  const live = await getJson(`${LIVE_API}/api/trades?limit=200`).catch((error) => ({ error: error.message }));
  const liveSince = Array.isArray(live.executorClosedTradesSinceBaseline) ? live.executorClosedTradesSinceBaseline : [];
  const liveMapped = liveSince.map((trade) => ({
    id: trade.id,
    asset: trade.asset,
    direction: trade.direction,
    size: trade.size,
    entryPrice: trade.entryPrice,
    won: trade.won,
    pnl: trade.pnl,
    reason: trade.reason,
    closedAt: trade.closedAt,
    epoch: liveTradeEpoch(trade),
    matchingRules: liveTradeRule(trade, strategies).map((rule) => rule.id),
  }));
  const liveWins = liveMapped.filter((trade) => trade.won).length;
  const livePnl = liveMapped.reduce((sum, trade) => sum + Number(trade.pnl || 0), 0);
  const sims = {
    currentFromCurrentBankroll: simulate(rows, BANKROLL),
    currentFromPreDefinitive24_989783: simulate(rows, 24.989783),
    recent3FromCurrentBankroll: simulate(recent3Rows, BANKROLL),
  };
  const rootCauses = [];
  if (liveMapped.length && liveWins / liveMapped.length < 0.7) rootCauses.push('LIVE_FORWARD_SAMPLE_FAILED_70_PERCENT_WIN_GATE');
  if (livePnl < 0) rootCauses.push('LIVE_FORWARD_PNL_NEGATIVE');
  if (allSummary.triggers < 400) rootCauses.push('HISTORICAL_SAMPLE_SMALL_FOR_PROPHECY_CLAIM');
  if (byRule.some((rule) => rule.recent3.triggers < 10 || rule.recent3.winRate < 0.75)) rootCauses.push('RULE_LEVEL_RECENT_WEAKNESS_EXISTS');
  if (sims.currentFromCurrentBankroll.maxDrawdownPct > 0.3) rootCauses.push('CHRONOLOGICAL_REPLAY_HAS_LARGE_DRAWDOWN');
  const report = {
    generatedAt: new Date().toISOString(),
    strategyFile: STRATEGY_FILE,
    cacheFile: CACHE_FILE,
    liveApi: LIVE_API,
    assumptions: { bankroll: BANKROLL, adverseFillCents: ADVERSE_FILL_CENTS, slippagePct: SLIPPAGE_PCT, minSellNotional: MIN_SELL_NOTIONAL },
    historical: {
      all: roundSummary(allSummary),
      recent3: roundSummary(summarise(recent3Rows)),
      recent1: roundSummary(summarise(recent1Rows)),
      simulations: Object.fromEntries(Object.entries(sims).map(([key, sim]) => [key, roundSummary({ ...sim, days: undefined })])),
      byRule,
    },
    liveForward: {
      count: liveMapped.length,
      wins: liveWins,
      losses: liveMapped.length - liveWins,
      winRate: liveMapped.length ? liveWins / liveMapped.length : 0,
      pnl: livePnl,
      trades: liveMapped,
      counts: live.counts || null,
    },
    rootCauses,
    verdict: rootCauses.length ? 'NO_GO_UNPAUSED_UNTIL_ROOT_CAUSES_FIXED_OR_ACCEPTED' : 'INCONCLUSIVE_NOT_PROVEN',
  };
  const out = path.join(OUT_DIR, `strategy_failure_forensics_${new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')}.json`);
  fs.writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ report: path.relative(ROOT, out), verdict: report.verdict, liveForward: report.liveForward, historical: report.historical.all, rootCauses }, null, 2));
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});