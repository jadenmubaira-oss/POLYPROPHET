const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const repoRoot = path.resolve(__dirname, '..');
const datasetPath = path.join(repoRoot, 'exhaustive_analysis', 'decision_dataset.json');
const baseStrategyPath = path.join(repoRoot, 'debug', 'strategy_set_top7_drop6.json');
const outRoot = path.join(repoRoot, 'debug', 'fill_min_sweep_keepmax');

const MINS = [0.48, 0.50, 0.55, 0.60, 0.62, 0.65, 0.70, 0.75];
const STARTING_BALANCES = [5, 10];
const STAKE_FRACTIONS = [0.2, 0.3, 0.4];

const feeModel = {
  assumeTaker: true,
  feeRate: 0.25,
  exponent: 2,
  minFeeUsd: 0.0001,
};

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

function simulate(trades, cfg) {
  const startingBalance = Number(cfg.startingBalance);
  const stakeFraction = Number(cfg.stakeFraction);
  const slippagePct = Number(cfg.slippagePct ?? 0.01);
  const minOrderShares = Number(cfg.minOrderShares ?? 1);

  let balance = startingBalance;
  let peak = startingBalance;
  let maxDrawdownPct = 0;
  let wins = 0;
  let losses = 0;
  let executed = 0;
  let blocked = 0;

  for (const t of trades) {
    const ep = Number(t.entryPrice);
    if (!Number.isFinite(ep) || ep <= 0 || ep >= 1) continue;
    const effectiveEntry = Math.min(0.99, ep * (1 + slippagePct));
    const minOrderCost = Math.max(1, minOrderShares) * effectiveEntry;
    const stake = balance * stakeFraction;

    if (!Number.isFinite(stake) || stake <= 0 || stake < minOrderCost) {
      blocked += 1;
      continue;
    }

    const feeUsd = calcTakerFeeUsdForStake(stake, effectiveEntry, feeModel);
    const won = t.won === true || t.isWin === true;
    const delta = won ? (stake / effectiveEntry - stake - feeUsd) : (-stake - feeUsd);
    balance = Math.max(0, balance + delta);
    executed += 1;
    if (won) wins += 1;
    else losses += 1;

    if (balance > peak) peak = balance;
    const dd = peak > 0 ? (peak - balance) / peak : 0;
    if (dd > maxDrawdownPct) maxDrawdownPct = dd;
  }

  return {
    startingBalance,
    stakeFraction,
    executed,
    blocked,
    wins,
    losses,
    winRate: executed > 0 ? wins / executed : null,
    endingBalance: balance,
    roi: startingBalance > 0 ? (balance - startingBalance) / startingBalance : null,
    maxDrawdownPct,
  };
}

function runBacktest(strategyPath, outDir) {
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
  fs.mkdirSync(outRoot, { recursive: true });
  const base = JSON.parse(fs.readFileSync(baseStrategyPath, 'utf8'));
  const baseStrategies = Array.isArray(base.strategies) ? base.strategies : [];
  const originalMax = baseStrategies.reduce((m, s) => Math.max(m, Number(s.priceMax) || 0), 0.8);

  const summary = {
    generatedAt: new Date().toISOString(),
    mode: 'lower_min_keep_original_max_per_strategy',
    datasetPath,
    baseStrategyPath,
    mins: MINS,
    rows: [],
  };

  const csvRows = [];

  for (const minBand of MINS) {
    const tag = `${Math.round(minBand * 100)}_origMax`;
    const outDir = path.join(outRoot, `min_${Math.round(minBand * 100)}`);
    fs.mkdirSync(outDir, { recursive: true });

    const strategy = JSON.parse(JSON.stringify(base));
    strategy.generatedAt = new Date().toISOString();
    strategy.description = `top7_drop6 with min=${Math.round(minBand * 100)}c and original strategy max caps`;
    strategy.conditions = {
      ...(strategy.conditions || {}),
      priceMin: minBand,
      priceMax: originalMax,
      momentumMin: 0.03,
      volumeMin: 500,
    };

    strategy.strategies = (strategy.strategies || []).map(s => {
      const sMax = Number(s.priceMax);
      const maxBand = Number.isFinite(sMax) ? sMax : originalMax;
      return {
        ...s,
        priceMin: minBand,
        priceMax: maxBand,
      };
    });

    const strategyPath = path.join(outDir, `strategy_${tag}.json`);
    fs.writeFileSync(strategyPath, JSON.stringify(strategy, null, 2));

    const replay = runBacktest(strategyPath, outDir);
    const trades = Array.isArray(replay.trades) ? replay.trades : [];
    const wins = trades.filter(t => t.won === true || t.isWin === true).length;
    const losses = trades.length - wins;
    const winRate = trades.length > 0 ? wins / trades.length : null;
    const lcb = wilsonLcb(wins, trades.length);

    const scenarios = [];
    for (const sb of STARTING_BALANCES) {
      for (const sf of STAKE_FRACTIONS) {
        scenarios.push(simulate(trades, {
          startingBalance: sb,
          stakeFraction: sf,
          slippagePct: 0.01,
          minOrderShares: 1,
        }));
      }
    }

    const s10f20 = scenarios.find(s => s.startingBalance === 10 && s.stakeFraction === 0.2);
    const s10f30 = scenarios.find(s => s.startingBalance === 10 && s.stakeFraction === 0.3);
    const s10f40 = scenarios.find(s => s.startingBalance === 10 && s.stakeFraction === 0.4);

    summary.rows.push({
      minBand,
      tradeCount: trades.length,
      wins,
      losses,
      winRate,
      lcb95: lcb,
      scenarios,
    });

    csvRows.push({
      minBandC: Math.round(minBand * 100),
      maxRule: 'orig',
      tradeCount: trades.length,
      wins,
      losses,
      winRate: toFixedOrNull(winRate),
      lcb95: toFixedOrNull(lcb),
      s10f20_executed: s10f20?.executed || 0,
      s10f20_blocked: s10f20?.blocked || 0,
      s10f20_endBal: toFixedOrNull(s10f20?.endingBalance),
      s10f20_roi: toFixedOrNull(s10f20?.roi),
      s10f20_dd: toFixedOrNull(s10f20?.maxDrawdownPct),
      s10f30_executed: s10f30?.executed || 0,
      s10f30_blocked: s10f30?.blocked || 0,
      s10f30_endBal: toFixedOrNull(s10f30?.endingBalance),
      s10f30_roi: toFixedOrNull(s10f30?.roi),
      s10f30_dd: toFixedOrNull(s10f30?.maxDrawdownPct),
      s10f40_executed: s10f40?.executed || 0,
      s10f40_blocked: s10f40?.blocked || 0,
      s10f40_endBal: toFixedOrNull(s10f40?.endingBalance),
      s10f40_roi: toFixedOrNull(s10f40?.roi),
      s10f40_dd: toFixedOrNull(s10f40?.maxDrawdownPct),
    });
  }

  fs.writeFileSync(path.join(outRoot, 'summary.json'), JSON.stringify(summary, null, 2));
  fs.writeFileSync(path.join(outRoot, 'summary.csv'), toCsv(csvRows, [
    'minBandC',
    'maxRule',
    'tradeCount',
    'wins',
    'losses',
    'winRate',
    'lcb95',
    's10f20_executed',
    's10f20_blocked',
    's10f20_endBal',
    's10f20_roi',
    's10f20_dd',
    's10f30_executed',
    's10f30_blocked',
    's10f30_endBal',
    's10f30_roi',
    's10f30_dd',
    's10f40_executed',
    's10f40_blocked',
    's10f40_endBal',
    's10f40_roi',
    's10f40_dd',
  ]));

  console.log('Wrote fill_min_sweep_keepmax summaries to', outRoot);
}

main();
