const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const repoRoot = path.resolve(__dirname, '..');
const datasetPath = path.join(repoRoot, 'exhaustive_analysis', 'decision_dataset.json');
const baseStrategyPath = path.join(repoRoot, 'debug', 'strategy_set_top7_drop6.json');
const outRoot = path.join(repoRoot, 'debug', 'fill_band_investigation');

const BANDS = [
  [0.48, 0.62],
  [0.48, 0.70],
  [0.48, 0.75],
  [0.48, 0.80],
  [0.50, 0.80],
  [0.55, 0.80],
  [0.60, 0.80],
  [0.62, 0.80],
  [0.65, 0.80],
  [0.70, 0.80],
  [0.75, 0.80],
];

const STARTING_BALANCES = [5, 10];
const STAKE_FRACTIONS = [0.2, 0.3, 0.4];
const TARGET_MULTIPLIERS = [2, 3, 5, 10, 20, 50, 100];
const STRESS_FILL_BUMPS_CENTS = Array.from({ length: 11 }, (_, i) => i); // 0..10c

const feeModel = {
  assumeTaker: true,
  feeRate: 0.25,
  exponent: 2,
  minFeeUsd: 0.0001,
};

function formatBand(min, max) {
  return `${Math.round(min * 100)}_${Math.round(max * 100)}`;
}

function toFixedOrNull(n, digits = 6) {
  return Number.isFinite(n) ? Number(n.toFixed(digits)) : null;
}

function calcTakerFeeUsdForStake(stakeUsd, price, model = feeModel) {
  if (!model || !model.assumeTaker) return 0;
  const stake = Number(stakeUsd);
  const p = Number(price);
  if (!Number.isFinite(stake) || stake <= 0) return 0;
  if (!Number.isFinite(p) || p <= 0 || p >= 1) return 0;
  const shares = stake / p;
  let fee = shares * model.feeRate * Math.pow(p * (1 - p), model.exponent);
  if (!Number.isFinite(fee) || fee <= 0) return 0;
  if (fee < model.minFeeUsd) return 0;
  return fee;
}

function percentile(sorted, p) {
  if (!sorted.length) return null;
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  const w = idx - lo;
  return sorted[lo] * (1 - w) + sorted[hi] * w;
}

function wilsonLcb(wins, total, z = 1.96) {
  const n = Number(total);
  if (!Number.isFinite(n) || n <= 0) return null;
  const p = Number(wins) / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const center = p + z2 / (2 * n);
  const margin = z * Math.sqrt((p * (1 - p) + z2 / (4 * n)) / n);
  return (center - margin) / denom;
}

function entryStatsFromTrades(trades) {
  const arr = trades
    .map(t => Number(t.entryPrice))
    .filter(Number.isFinite)
    .sort((a, b) => a - b);
  if (!arr.length) {
    return {
      mean: null,
      median: null,
      p10: null,
      p25: null,
      p75: null,
      p90: null,
      min: null,
      max: null,
    };
  }

  const mean = arr.reduce((a, b) => a + b, 0) / arr.length;
  return {
    mean,
    median: percentile(arr, 0.5),
    p10: percentile(arr, 0.1),
    p25: percentile(arr, 0.25),
    p75: percentile(arr, 0.75),
    p90: percentile(arr, 0.9),
    min: arr[0],
    max: arr[arr.length - 1],
  };
}

function simulateBankroll(trades, options) {
  const startingBalance = Number(options.startingBalance);
  const stakeFraction = Number(options.stakeFraction);
  const slippagePct = Number(options.slippagePct ?? 0.01);
  const minOrderShares = Number(options.minOrderShares ?? 1);
  const fillBumpCents = Number(options.fillBumpCents ?? 0);
  const fillBump = fillBumpCents / 100;

  let balance = startingBalance;
  let peak = startingBalance;
  let maxDrawdownPct = 0;
  let wins = 0;
  let losses = 0;
  let blocked = 0;
  let totalFeesUsd = 0;
  let maxLossStreak = 0;
  let currentLossStreak = 0;
  let executed = 0;

  let firstTradeEpochMs = null;
  const targets = {};
  for (const mult of TARGET_MULTIPLIERS) {
    targets[`x${mult}`] = null;
  }

  for (const trade of trades) {
    const rawEntry = Number(trade.entryPrice) + fillBump;
    if (!Number.isFinite(rawEntry) || rawEntry <= 0 || rawEntry >= 1) {
      continue;
    }

    const effectiveEntry = Math.min(0.99, rawEntry * (1 + slippagePct));
    const minOrderCost = Math.max(1, minOrderShares) * effectiveEntry;
    const stake = balance * stakeFraction;

    if (!Number.isFinite(stake) || stake <= 0 || stake < minOrderCost) {
      blocked += 1;
      continue;
    }

    const feeUsd = calcTakerFeeUsdForStake(stake, effectiveEntry, feeModel);
    const won = trade.won === true || trade.isWin === true;
    const deltaUsd = won
      ? (stake / effectiveEntry - stake - feeUsd)
      : (-stake - feeUsd);

    const prevBalance = balance;
    balance = Math.max(0, balance + deltaUsd);
    totalFeesUsd += feeUsd;
    executed += 1;

    if (won) {
      wins += 1;
      currentLossStreak = 0;
    } else {
      losses += 1;
      currentLossStreak += 1;
      if (currentLossStreak > maxLossStreak) maxLossStreak = currentLossStreak;
    }

    if (balance > peak) peak = balance;
    const drawdownPct = peak > 0 ? (peak - balance) / peak : 0;
    if (drawdownPct > maxDrawdownPct) maxDrawdownPct = drawdownPct;

    const ts = Number(trade.resolvedAt) || Number(trade.issuedAt) || (Number(trade.cycleStartEpochSec) * 1000);
    if (!firstTradeEpochMs && Number.isFinite(ts) && ts > 0) firstTradeEpochMs = ts;

    for (const mult of TARGET_MULTIPLIERS) {
      const key = `x${mult}`;
      if (targets[key]) continue;
      const targetBalance = startingBalance * mult;
      if (balance >= targetBalance && firstTradeEpochMs && Number.isFinite(ts) && ts >= firstTradeEpochMs) {
        targets[key] = {
          targetBalance,
          balanceAtHit: balance,
          tradesToHit: executed,
          daysToHit: (ts - firstTradeEpochMs) / 86400000,
          timestamp: new Date(ts).toISOString(),
        };
      }
    }

    if (prevBalance <= 0 && balance <= 0) {
      // Can no longer place trades in a meaningful way.
      break;
    }
  }

  const winRate = executed > 0 ? wins / executed : null;
  const endingBalance = balance;
  const roi = startingBalance > 0 ? (endingBalance - startingBalance) / startingBalance : null;

  return {
    startingBalance,
    stakeFraction,
    fillBumpCents,
    executed,
    blocked,
    wins,
    losses,
    winRate,
    endingBalance,
    roi,
    maxDrawdownPct,
    maxLossStreak,
    totalFeesUsd,
    targets,
  };
}

function buildCentTable(trades, slippagePct = 0.01) {
  const map = new Map();

  for (const t of trades) {
    const p = Number(t.entryPrice);
    if (!Number.isFinite(p) || p <= 0 || p >= 1) continue;
    const cent = Math.round(p * 100);
    if (!map.has(cent)) {
      map.set(cent, { cent, count: 0, wins: 0, losses: 0 });
    }
    const row = map.get(cent);
    row.count += 1;
    if (t.won === true || t.isWin === true) row.wins += 1;
    else row.losses += 1;
  }

  const rows = Array.from(map.values())
    .sort((a, b) => a.cent - b.cent)
    .map(r => {
      const wr = r.count > 0 ? r.wins / r.count : null;
      const entry = r.cent / 100;
      const eff = Math.min(0.99, entry * (1 + slippagePct));
      const feePer1 = calcTakerFeeUsdForStake(1, eff, feeModel);
      const winDeltaPer1 = 1 / eff - 1 - feePer1;
      const lossDeltaPer1 = -1 - feePer1;
      const evPer1 = Number.isFinite(wr)
        ? (wr * winDeltaPer1 + (1 - wr) * lossDeltaPer1)
        : null;

      return {
        cent: r.cent,
        entry,
        count: r.count,
        wins: r.wins,
        losses: r.losses,
        winRate: wr,
        wilsonLcb95: wilsonLcb(r.wins, r.count),
        winDeltaPer1,
        lossDeltaPer1,
        evPer1,
      };
    });

  return rows;
}

function runBacktestForBand(strategyPath, outDir) {
  fs.mkdirSync(outDir, { recursive: true });
  const signalOut = path.join(outDir, 'hybrid_replay_signal_ledger.json');
  const executedOut = path.join(outDir, 'hybrid_replay_executed_ledger.json');

  const args = [
    path.join(repoRoot, 'scripts', 'hybrid_replay_backtest.js'),
    `--dataset=${datasetPath}`,
    `--strategies=${strategyPath}`,
    `--outDir=${outDir}`,
    `--signalOut=${signalOut}`,
    `--executedOut=${executedOut}`,
    '--simulateBankroll=false',
  ];

  execFileSync(process.execPath, args, {
    cwd: repoRoot,
    stdio: 'pipe',
    maxBuffer: 64 * 1024 * 1024,
  });

  return JSON.parse(fs.readFileSync(executedOut, 'utf8'));
}

function toCsv(rows, columns) {
  const escape = (value) => {
    if (value === null || value === undefined) return '';
    const s = String(value);
    if (s.includes(',') || s.includes('"') || s.includes('\n')) {
      return `"${s.replace(/"/g, '""')}"`;
    }
    return s;
  };

  const header = columns.join(',');
  const body = rows.map(row => columns.map(col => escape(row[col])).join(',')).join('\n');
  return `${header}\n${body}`;
}

function main() {
  fs.mkdirSync(outRoot, { recursive: true });

  const base = JSON.parse(fs.readFileSync(baseStrategyPath, 'utf8'));
  const now = new Date().toISOString();

  const summary = {
    generatedAt: now,
    datasetPath,
    baseStrategyPath,
    assumptions: {
      slippagePct: 0.01,
      minOrderShares: 1,
      stakeFractions: STAKE_FRACTIONS,
      startingBalances: STARTING_BALANCES,
      fillStressCents: STRESS_FILL_BUMPS_CENTS,
      note: 'Manual no-halts profile approximation: fixed-fraction staking, no adaptive sizing, no halts, min order shares=1.',
    },
    bands: [],
  };

  const bandTableRows = [];

  for (const [minBand, maxBand] of BANDS) {
    const tag = formatBand(minBand, maxBand);
    const bandDir = path.join(outRoot, `band_${tag}`);
    fs.mkdirSync(bandDir, { recursive: true });

    const strategy = JSON.parse(JSON.stringify(base));
    strategy.generatedAt = now;
    strategy.description = `top7_drop6 with uniform ${Math.round(minBand * 100)}-${Math.round(maxBand * 100)}c bands`;
    strategy.conditions = {
      ...(strategy.conditions || {}),
      priceMin: minBand,
      priceMax: maxBand,
      momentumMin: 0.03,
      volumeMin: 500,
    };
    strategy.strategies = (strategy.strategies || []).map(s => ({
      ...s,
      priceMin: minBand,
      priceMax: maxBand,
      name: String(s.name || '').replace(/\([^)]*\)$/, '').trim() + ` (${Math.round(minBand * 100)}-${Math.round(maxBand * 100)}c)`,
    }));

    const strategyPath = path.join(bandDir, `strategy_${tag}.json`);
    fs.writeFileSync(strategyPath, JSON.stringify(strategy, null, 2));

    const replay = runBacktestForBand(strategyPath, bandDir);
    const trades = Array.isArray(replay.trades) ? replay.trades : [];
    const wins = trades.filter(t => t.won === true || t.isWin === true).length;
    const losses = trades.length - wins;
    const winRate = trades.length > 0 ? wins / trades.length : null;
    const lcb = wilsonLcb(wins, trades.length);
    const entryStats = entryStatsFromTrades(trades);

    const scenarios = [];
    for (const startingBalance of STARTING_BALANCES) {
      for (const stakeFraction of STAKE_FRACTIONS) {
        scenarios.push(simulateBankroll(trades, {
          startingBalance,
          stakeFraction,
          slippagePct: 0.01,
          minOrderShares: 1,
          fillBumpCents: 0,
        }));
      }
    }

    const stress30s10 = STRESS_FILL_BUMPS_CENTS.map(fillBumpCents =>
      simulateBankroll(trades, {
        startingBalance: 10,
        stakeFraction: 0.3,
        slippagePct: 0.01,
        minOrderShares: 1,
        fillBumpCents,
      })
    );

    let firstBustFillCents = null;
    let firstMinOrderBlockFillCents = null;

    for (const row of stress30s10) {
      if (firstBustFillCents === null && row.endingBalance < 10) {
        firstBustFillCents = row.fillBumpCents;
      }
      if (firstMinOrderBlockFillCents === null && row.blocked > 0) {
        firstMinOrderBlockFillCents = row.fillBumpCents;
      }
    }

    const row20 = scenarios.find(s => s.startingBalance === 10 && s.stakeFraction === 0.2);
    const row30 = scenarios.find(s => s.startingBalance === 10 && s.stakeFraction === 0.3);
    const row40 = scenarios.find(s => s.startingBalance === 10 && s.stakeFraction === 0.4);

    const bandSummary = {
      tag,
      bandMin: minBand,
      bandMax: maxBand,
      tradeCount: trades.length,
      wins,
      losses,
      winRate,
      wilsonLcb95: lcb,
      entryStats,
      scenarios,
      stress30s10,
      firstBustFillCents,
      firstMinOrderBlockFillCents,
    };

    summary.bands.push(bandSummary);

    bandTableRows.push({
      band: `${Math.round(minBand * 100)}-${Math.round(maxBand * 100)}`,
      trades: trades.length,
      wins,
      losses,
      winRate: toFixedOrNull(winRate, 6),
      wilsonLcb95: toFixedOrNull(lcb, 6),
      avgEntryC: toFixedOrNull(entryStats.mean ? entryStats.mean * 100 : null, 2),
      medianEntryC: toFixedOrNull(entryStats.median ? entryStats.median * 100 : null, 2),
      s10_f20_endBal: toFixedOrNull(row20?.endingBalance, 4),
      s10_f20_roi: toFixedOrNull(row20?.roi, 6),
      s10_f20_dd: toFixedOrNull(row20?.maxDrawdownPct, 6),
      s10_f30_endBal: toFixedOrNull(row30?.endingBalance, 4),
      s10_f30_roi: toFixedOrNull(row30?.roi, 6),
      s10_f30_dd: toFixedOrNull(row30?.maxDrawdownPct, 6),
      s10_f40_endBal: toFixedOrNull(row40?.endingBalance, 4),
      s10_f40_roi: toFixedOrNull(row40?.roi, 6),
      s10_f40_dd: toFixedOrNull(row40?.maxDrawdownPct, 6),
      s10_f30_firstBustFillCents: firstBustFillCents,
      s10_f30_firstMinOrderBlockFillCents: firstMinOrderBlockFillCents,
    });

    const centTable = buildCentTable(trades, 0.01);
    fs.writeFileSync(
      path.join(bandDir, `entry_cent_table_${tag}.csv`),
      toCsv(centTable.map(r => ({
        cent: r.cent,
        entry: toFixedOrNull(r.entry, 4),
        count: r.count,
        wins: r.wins,
        losses: r.losses,
        winRate: toFixedOrNull(r.winRate, 6),
        wilsonLcb95: toFixedOrNull(r.wilsonLcb95, 6),
        winDeltaPer1: toFixedOrNull(r.winDeltaPer1, 6),
        lossDeltaPer1: toFixedOrNull(r.lossDeltaPer1, 6),
        evPer1: toFixedOrNull(r.evPer1, 6),
      })), ['cent', 'entry', 'count', 'wins', 'losses', 'winRate', 'wilsonLcb95', 'winDeltaPer1', 'lossDeltaPer1', 'evPer1'])
    );
  }

  const bandCsv = toCsv(bandTableRows, [
    'band',
    'trades',
    'wins',
    'losses',
    'winRate',
    'wilsonLcb95',
    'avgEntryC',
    'medianEntryC',
    's10_f20_endBal',
    's10_f20_roi',
    's10_f20_dd',
    's10_f30_endBal',
    's10_f30_roi',
    's10_f30_dd',
    's10_f40_endBal',
    's10_f40_roi',
    's10_f40_dd',
    's10_f30_firstBustFillCents',
    's10_f30_firstMinOrderBlockFillCents',
  ]);

  fs.writeFileSync(path.join(outRoot, 'band_summary.csv'), bandCsv);
  fs.writeFileSync(path.join(outRoot, 'summary.json'), JSON.stringify(summary, null, 2));

  console.log(`Done. Wrote ${summary.bands.length} band summaries to ${outRoot}`);
}

main();
