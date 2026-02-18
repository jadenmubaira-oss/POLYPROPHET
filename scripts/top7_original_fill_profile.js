const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const repoRoot = path.resolve(__dirname, '..');
const datasetPath = path.join(repoRoot, 'exhaustive_analysis', 'decision_dataset.json');
const strategiesPath = path.join(repoRoot, 'debug', 'strategy_set_top7_drop6.json');
const outDir = path.join(repoRoot, 'debug', 'top7_original_fill_profile');

const STARTING_BALANCES = [5, 10];
const STAKE_FRACTIONS = [0.2, 0.3, 0.4];
const TARGET_MULTIPLIERS = [2, 3, 5, 10, 20, 50, 100];
const FILL_BUMPS = Array.from({ length: 11 }, (_, i) => i);

const feeModel = {
  assumeTaker: true,
  feeRate: 0.25,
  exponent: 2,
  minFeeUsd: 0.0001,
};

function calcFee(stakeUsd, price) {
  if (!feeModel.assumeTaker) return 0;
  if (!Number.isFinite(stakeUsd) || stakeUsd <= 0) return 0;
  if (!Number.isFinite(price) || price <= 0 || price >= 1) return 0;
  const shares = stakeUsd / price;
  let fee = shares * feeModel.feeRate * Math.pow(price * (1 - price), feeModel.exponent);
  if (!Number.isFinite(fee) || fee <= 0) return 0;
  if (fee < feeModel.minFeeUsd) return 0;
  return fee;
}

function runReplay() {
  fs.mkdirSync(outDir, { recursive: true });
  const signalOut = path.join(outDir, 'hybrid_replay_signal_ledger.json');
  const executedOut = path.join(outDir, 'hybrid_replay_executed_ledger.json');

  const args = [
    path.join(repoRoot, 'scripts', 'hybrid_replay_backtest.js'),
    `--dataset=${datasetPath}`,
    `--strategies=${strategiesPath}`,
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

function percentile(sorted, p) {
  if (!sorted.length) return null;
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  const w = idx - lo;
  return sorted[lo] * (1 - w) + sorted[hi] * w;
}

function entryStats(trades) {
  const arr = trades.map(t => Number(t.entryPrice)).filter(Number.isFinite).sort((a, b) => a - b);
  if (!arr.length) return null;
  const mean = arr.reduce((a, b) => a + b, 0) / arr.length;
  return {
    min: arr[0],
    p10: percentile(arr, 0.1),
    p25: percentile(arr, 0.25),
    median: percentile(arr, 0.5),
    p75: percentile(arr, 0.75),
    p90: percentile(arr, 0.9),
    max: arr[arr.length - 1],
    mean,
  };
}

function simulate(trades, cfg) {
  const startingBalance = Number(cfg.startingBalance);
  const stakeFraction = Number(cfg.stakeFraction);
  const fillBumpCents = Number(cfg.fillBumpCents || 0);
  const fillBump = fillBumpCents / 100;
  const slippagePct = Number(cfg.slippagePct || 0.01);
  const minOrderShares = Number(cfg.minOrderShares || 1);

  let balance = startingBalance;
  let peak = startingBalance;
  let maxDrawdownPct = 0;
  let wins = 0;
  let losses = 0;
  let executed = 0;
  let blocked = 0;
  let maxLossStreak = 0;
  let lossStreak = 0;
  let totalFeesUsd = 0;

  let firstEpochMs = null;
  const targets = {};
  for (const x of TARGET_MULTIPLIERS) targets[`x${x}`] = null;

  for (const t of trades) {
    const p = Number(t.entryPrice) + fillBump;
    if (!Number.isFinite(p) || p <= 0 || p >= 1) continue;

    const effectiveEntry = Math.min(0.99, p * (1 + slippagePct));
    const minOrderCost = Math.max(1, minOrderShares) * effectiveEntry;
    const stake = balance * stakeFraction;

    if (!Number.isFinite(stake) || stake <= 0 || stake < minOrderCost) {
      blocked += 1;
      continue;
    }

    const fee = calcFee(stake, effectiveEntry);
    const won = t.won === true || t.isWin === true;
    const delta = won ? (stake / effectiveEntry - stake - fee) : (-stake - fee);

    balance = Math.max(0, balance + delta);
    totalFeesUsd += fee;
    executed += 1;

    if (won) {
      wins += 1;
      lossStreak = 0;
    } else {
      losses += 1;
      lossStreak += 1;
      if (lossStreak > maxLossStreak) maxLossStreak = lossStreak;
    }

    if (balance > peak) peak = balance;
    const dd = peak > 0 ? (peak - balance) / peak : 0;
    if (dd > maxDrawdownPct) maxDrawdownPct = dd;

    const ts = Number(t.resolvedAt) || Number(t.issuedAt) || (Number(t.cycleStartEpochSec) * 1000);
    if (!firstEpochMs && Number.isFinite(ts) && ts > 0) firstEpochMs = ts;

    for (const x of TARGET_MULTIPLIERS) {
      const key = `x${x}`;
      if (targets[key]) continue;
      if (balance >= startingBalance * x && firstEpochMs && Number.isFinite(ts) && ts >= firstEpochMs) {
        targets[key] = {
          targetBalance: startingBalance * x,
          balanceAtHit: balance,
          tradesToHit: executed,
          daysToHit: (ts - firstEpochMs) / 86400000,
          timestamp: new Date(ts).toISOString(),
        };
      }
    }
  }

  return {
    startingBalance,
    stakeFraction,
    fillBumpCents,
    executed,
    blocked,
    wins,
    losses,
    winRate: executed > 0 ? wins / executed : null,
    endingBalance: balance,
    roi: startingBalance > 0 ? (balance - startingBalance) / startingBalance : null,
    maxDrawdownPct,
    maxLossStreak,
    totalFeesUsd,
    targets,
  };
}

function toCsv(rows, cols) {
  const esc = (v) => {
    if (v === null || v === undefined) return '';
    const s = String(v);
    if (s.includes(',') || s.includes('"') || s.includes('\n')) return `"${s.replace(/"/g, '""')}"`;
    return s;
  };
  return [cols.join(',')].concat(rows.map(r => cols.map(c => esc(r[c])).join(','))).join('\n');
}

function main() {
  const replay = runReplay();
  const trades = Array.isArray(replay.trades) ? replay.trades : [];
  const wins = trades.filter(t => t.won === true || t.isWin === true).length;
  const losses = trades.length - wins;

  const summary = {
    generatedAt: new Date().toISOString(),
    datasetPath,
    strategiesPath,
    tradeCount: trades.length,
    wins,
    losses,
    winRate: trades.length > 0 ? wins / trades.length : null,
    lcb95: wilsonLcb(wins, trades.length),
    entryStats: entryStats(trades),
    scenarios: [],
    stressS10F30: [],
  };

  for (const sb of STARTING_BALANCES) {
    for (const sf of STAKE_FRACTIONS) {
      summary.scenarios.push(simulate(trades, {
        startingBalance: sb,
        stakeFraction: sf,
        fillBumpCents: 0,
        slippagePct: 0.01,
        minOrderShares: 1,
      }));
    }
  }

  for (const cents of FILL_BUMPS) {
    summary.stressS10F30.push(simulate(trades, {
      startingBalance: 10,
      stakeFraction: 0.3,
      fillBumpCents: cents,
      slippagePct: 0.01,
      minOrderShares: 1,
    }));
  }

  fs.writeFileSync(path.join(outDir, 'summary.json'), JSON.stringify(summary, null, 2));

  const rows = summary.scenarios.map(s => ({
    startingBalance: s.startingBalance,
    stakeFraction: s.stakeFraction,
    executed: s.executed,
    blocked: s.blocked,
    wins: s.wins,
    losses: s.losses,
    winRate: Number.isFinite(s.winRate) ? Number(s.winRate.toFixed(6)) : '',
    endingBalance: Number.isFinite(s.endingBalance) ? Number(s.endingBalance.toFixed(6)) : '',
    roi: Number.isFinite(s.roi) ? Number(s.roi.toFixed(6)) : '',
    maxDrawdownPct: Number.isFinite(s.maxDrawdownPct) ? Number(s.maxDrawdownPct.toFixed(6)) : '',
    x2_days: s.targets?.x2?.daysToHit ?? '',
    x5_days: s.targets?.x5?.daysToHit ?? '',
    x10_days: s.targets?.x10?.daysToHit ?? '',
    x20_days: s.targets?.x20?.daysToHit ?? '',
    x50_days: s.targets?.x50?.daysToHit ?? '',
    x100_days: s.targets?.x100?.daysToHit ?? '',
  }));

  fs.writeFileSync(path.join(outDir, 'scenario_table.csv'), toCsv(rows, [
    'startingBalance',
    'stakeFraction',
    'executed',
    'blocked',
    'wins',
    'losses',
    'winRate',
    'endingBalance',
    'roi',
    'maxDrawdownPct',
    'x2_days',
    'x5_days',
    'x10_days',
    'x20_days',
    'x50_days',
    'x100_days',
  ]));

  const stressRows = summary.stressS10F30.map(s => ({
    fillBumpCents: s.fillBumpCents,
    executed: s.executed,
    blocked: s.blocked,
    wins: s.wins,
    losses: s.losses,
    winRate: Number.isFinite(s.winRate) ? Number(s.winRate.toFixed(6)) : '',
    endingBalance: Number.isFinite(s.endingBalance) ? Number(s.endingBalance.toFixed(6)) : '',
    roi: Number.isFinite(s.roi) ? Number(s.roi.toFixed(6)) : '',
    maxDrawdownPct: Number.isFinite(s.maxDrawdownPct) ? Number(s.maxDrawdownPct.toFixed(6)) : '',
  }));

  fs.writeFileSync(path.join(outDir, 'stress_s10_f30_fillbump.csv'), toCsv(stressRows, [
    'fillBumpCents',
    'executed',
    'blocked',
    'wins',
    'losses',
    'winRate',
    'endingBalance',
    'roi',
    'maxDrawdownPct',
  ]));

  console.log('Wrote top7 original fill profile outputs to', outDir);
}

main();
