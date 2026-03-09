const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const DAY_SEC = 86400;
const HORIZON_DAYS = 14;
const MIN_ORDER_SHARES = 5;
const MAX_ABS_STAKE = 100;
const COOLDOWN_SECONDS = 1200;
const MAX_CONSEC_LOSSES = 3;
const MONTE_CARLO_RUNS = 100000;
const START_BALANCES = [5, 8, 10];
const STAKE_FRACTIONS = [0.3, 0.45, 0.6];
const TRAIN_DAYS = 90;
const SLIPPAGE_PCT = 0.01;

function getFeeModel() {
  return { assumeTaker: true, feeRate: 0.25, exponent: 2, minFeeUsd: 0.0001 };
}

function calcPolymarketTakerFeeUsd(shares, price, model = getFeeModel()) {
  if (!model.assumeTaker) return 0;
  const C = Number(shares);
  const p = Number(price);
  if (!Number.isFinite(C) || C <= 0) return 0;
  if (!Number.isFinite(p) || p <= 0 || p >= 1) return 0;
  const base = p * (1 - p);
  let fee = C * model.feeRate * Math.pow(base, model.exponent);
  if (!Number.isFinite(fee) || fee <= 0) return 0;
  if (fee < model.minFeeUsd) return 0;
  return fee;
}

function calcPolymarketTakerFeeUsdForStake(stakeUsd, price, model = getFeeModel()) {
  const stake = Number(stakeUsd);
  const p = Number(price);
  if (!Number.isFinite(stake) || stake <= 0) return 0;
  if (!Number.isFinite(p) || p <= 0 || p >= 1) return 0;
  return calcPolymarketTakerFeeUsd(stake / p, p, model);
}

function calcBinaryTradeDeltaUsdAfterFees(stakeUsd, entryPrice, won, options = {}) {
  const stake = Number(stakeUsd);
  if (!Number.isFinite(stake) || stake <= 0) return { deltaUsd: 0, feeUsd: 0, effectiveEntry: null };
  const epRaw = Number(entryPrice);
  if (!Number.isFinite(epRaw) || epRaw <= 0 || epRaw >= 1) return { deltaUsd: 0, feeUsd: 0, effectiveEntry: null };
  const slippagePctRaw = Number(options.slippagePct || 0);
  const slippagePct = Number.isFinite(slippagePctRaw) && slippagePctRaw > 0 ? slippagePctRaw : 0;
  const effectiveEntry = Math.min(0.99, epRaw * (1 + slippagePct));
  const feeModel = options.feeModel || getFeeModel();
  const feeUsd = calcPolymarketTakerFeeUsdForStake(stake, effectiveEntry, feeModel);
  const deltaUsd = won ? (stake / effectiveEntry - stake - feeUsd) : (-stake - feeUsd);
  return { deltaUsd, feeUsd, effectiveEntry };
}

function fmtPct(n) {
  return `${(n * 100).toFixed(2)}%`;
}

function fmtUsd(n) {
  return `$${Number(n).toFixed(2)}`;
}

function quantile(sorted, q) {
  if (!sorted.length) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor(sorted.length * q)));
  return sorted[idx];
}

function summarize(results) {
  const endBalances = results.map(r => r.endBalance).sort((a, b) => a - b);
  const busts = results.filter(r => r.busted).length;
  const belowStart = results.filter(r => r.endBalance < r.startBalance).length;
  const over20 = results.filter(r => r.endBalance >= 20).length;
  const over50 = results.filter(r => r.endBalance >= 50).length;
  return {
    windows: results.length,
    bustRate: busts / results.length,
    belowStartRate: belowStart / results.length,
    medianEnd: quantile(endBalances, 0.5),
    p25End: quantile(endBalances, 0.25),
    p75End: quantile(endBalances, 0.75),
    prob20: over20 / results.length,
    prob50: over50 / results.length
  };
}

function loadLedger(relPath) {
  const fullPath = path.join(ROOT, relPath);
  const payload = JSON.parse(fs.readFileSync(fullPath, 'utf8'));
  return (payload.trades || []).slice().sort((a, b) => (a.cycleStartEpochSec || a.cycleStartEpoch || 0) - (b.cycleStartEpochSec || b.cycleStartEpoch || 0));
}

function simulateLedgerWindow(trades, startIndex, startBalance, stakeFraction) {
  const startTs = trades[startIndex].cycleStartEpochSec || trades[startIndex].cycleStartEpoch;
  const endTs = startTs + HORIZON_DAYS * DAY_SEC;
  const globalMinCost = Math.min(...trades.map(t => MIN_ORDER_SHARES * Number(t.entryPrice)));
  let balance = startBalance;
  let busted = false;
  let cooldownUntil = 0;
  let consecutiveLosses = 0;
  let executed = 0;
  let skippedFunds = 0;
  let skippedCooldown = 0;

  for (let i = startIndex; i < trades.length; i++) {
    const t = trades[i];
    const ts = t.cycleStartEpochSec || t.cycleStartEpoch;
    if (ts >= endTs) break;
    const entryPrice = Number(t.entryPrice);
    const minOrderCost = MIN_ORDER_SHARES * entryPrice;

    if (balance < globalMinCost) {
      busted = true;
      break;
    }

    if (ts < cooldownUntil) {
      skippedCooldown++;
      continue;
    }

    if (balance < minOrderCost) {
      skippedFunds++;
      continue;
    }

    let stake = Math.max(balance * stakeFraction, minOrderCost);
    stake = Math.min(stake, balance, MAX_ABS_STAKE);
    const settled = calcBinaryTradeDeltaUsdAfterFees(stake, entryPrice, !!(t.won === true || t.isWin === true || t.outcome === 'WIN'), { slippagePct: 0, feeModel: getFeeModel() });
    balance += Number(settled.deltaUsd || 0);
    executed++;

    if (t.won === true || t.isWin === true || t.outcome === 'WIN') {
      consecutiveLosses = 0;
    } else {
      consecutiveLosses++;
      if (consecutiveLosses >= MAX_CONSEC_LOSSES) {
        cooldownUntil = ts + COOLDOWN_SECONDS;
      }
    }
  }

  if (balance < globalMinCost) busted = true;
  return { startBalance, endBalance: balance, busted, executed, skippedFunds, skippedCooldown };
}

function runLedgerWindowAudit(label, relPath) {
  const trades = loadLedger(relPath);
  console.log(`\n=== HISTORICAL 14-DAY WINDOW REPLAY :: ${label} ===`);
  console.log(`Trades loaded: ${trades.length}`);
  for (const startBalance of START_BALANCES) {
    for (const stakeFraction of STAKE_FRACTIONS) {
      const windows = [];
      for (let i = 0; i < trades.length; i++) {
        windows.push(simulateLedgerWindow(trades, i, startBalance, stakeFraction));
      }
      const s = summarize(windows);
      console.log([
        `start=${fmtUsd(startBalance)}`,
        `stake=${Math.round(stakeFraction * 100)}%`,
        `bust=${fmtPct(s.bustRate)}`,
        `belowStart=${fmtPct(s.belowStartRate)}`,
        `median=${fmtUsd(s.medianEnd)}`,
        `p25=${fmtUsd(s.p25End)}`,
        `p75=${fmtUsd(s.p75End)}`,
        `p20=${fmtPct(s.prob20)}`,
        `p50=${fmtPct(s.prob50)}`
      ].join(' | '));
    }
  }
}

function loadCorrectedSet(strategySetFile) {
  const setPayload = JSON.parse(fs.readFileSync(path.join(ROOT, strategySetFile), 'utf8'));
  const results = JSON.parse(fs.readFileSync(path.join(ROOT, 'exhaustive_analysis', 'final_results.json'), 'utf8'));
  return setPayload.strategies.map((s) => {
    const bandMin = Number(s.priceMin ?? s.priceBand?.min);
    const bandMax = Number(s.priceMax ?? s.priceBand?.max);
    const row = results.validatedStrategies.find((x) =>
      Number(x.utcHour) === Number(s.utcHour) &&
      Number(x.entryMinute) === Number(s.entryMinute) &&
      String(x.direction).toUpperCase() === String(s.direction).toUpperCase() &&
      Number(x.priceBand?.min) === bandMin &&
      Number(x.priceBand?.max) === bandMax
    );
    if (!row) {
      throw new Error(`No validated row for ${JSON.stringify(s)}`);
    }
    return {
      name: `${s.utcHour}:${s.entryMinute} ${String(s.direction).toUpperCase()}`,
      entryPrice: (bandMin + bandMax) / 2,
      valWR: Number(row.valWinRate),
      valTrades: Number(row.valTrades),
      trainTrades: Number(row.trades),
      firesPerDay: Number(row.trades) / TRAIN_DAYS
    };
  });
}

function runCorrectedMonteCarlo(label, strategies, startBalance, stakeFraction) {
  const cheapest = Math.min(...strategies.map(s => MIN_ORDER_SHARES * s.entryPrice));
  const ends = [];
  let busts = 0;
  let belowStart = 0;
  let over20 = 0;
  let over50 = 0;

  for (let run = 0; run < MONTE_CARLO_RUNS; run++) {
    let balance = startBalance;
    let busted = false;
    for (let day = 0; day < HORIZON_DAYS && !busted; day++) {
      for (const s of strategies) {
        let fires = Math.floor(s.firesPerDay);
        if (Math.random() < s.firesPerDay - fires) fires++;
        for (let f = 0; f < fires; f++) {
          const minOrderCost = MIN_ORDER_SHARES * s.entryPrice;
          if (balance < minOrderCost) {
            if (balance < cheapest) {
              busted = true;
              break;
            }
            continue;
          }
          let stake = Math.max(balance * stakeFraction, minOrderCost);
          stake = Math.min(stake, balance, MAX_ABS_STAKE);
          const won = Math.random() < s.valWR;
          const settled = calcBinaryTradeDeltaUsdAfterFees(stake, s.entryPrice, won, { slippagePct: SLIPPAGE_PCT, feeModel: getFeeModel() });
          balance += Number(settled.deltaUsd || 0);
          if (balance < cheapest) {
            busted = true;
            break;
          }
        }
        if (busted) break;
      }
    }
    if (busted) busts++;
    if (balance < startBalance) belowStart++;
    if (balance >= 20) over20++;
    if (balance >= 50) over50++;
    ends.push(Math.max(0, balance));
  }

  ends.sort((a, b) => a - b);
  console.log([
    label,
    `start=${fmtUsd(startBalance)}`,
    `stake=${Math.round(stakeFraction * 100)}%`,
    `bust=${fmtPct(busts / MONTE_CARLO_RUNS)}`,
    `belowStart=${fmtPct(belowStart / MONTE_CARLO_RUNS)}`,
    `median=${fmtUsd(quantile(ends, 0.5))}`,
    `p25=${fmtUsd(quantile(ends, 0.25))}`,
    `p75=${fmtUsd(quantile(ends, 0.75))}`,
    `p20=${fmtPct(over20 / MONTE_CARLO_RUNS)}`,
    `p50=${fmtPct(over50 / MONTE_CARLO_RUNS)}`
  ].join(' | '));
}

console.log('=== FRESH MICRO AUDIT ===');
console.log(`Runtime-consistent assumptions: 5-share minimum, taker fees, selected-side prices, maxAbsStake=${MAX_ABS_STAKE}, horizon=${HORIZON_DAYS}d`);
console.log('');

runLedgerWindowAudit('CURRENT_RUNTIME_HIGHFREQ_UNIQUE12', 'debug/highfreq_unique12/hybrid_replay_executed_ledger.json');
runLedgerWindowAudit('REFERENCE_TOP3_ROBUST', 'debug/final_set_scan/top3_robust/hybrid_replay_executed_ledger.json');
runLedgerWindowAudit('REFERENCE_TOP7_DROP6', 'debug/final_set_scan/top7_drop6/hybrid_replay_executed_ledger.json');

const correctedTop8 = loadCorrectedSet('debug/strategy_set_top8_unique_golden.json');
const correctedDown5 = loadCorrectedSet('debug/strategy_set_down5_golden.json');

console.log('\n=== CORRECTED MONTE CARLO :: TOP8_UNIQUE_GOLDEN / DOWN5_GOLDEN ===');
console.log('Selected-side entry prices use strategy band midpoints, not the complement side.');
for (const startBalance of START_BALANCES) {
  for (const stakeFraction of STAKE_FRACTIONS) {
    runCorrectedMonteCarlo('TOP8_UNIQUE_GOLDEN', correctedTop8, startBalance, stakeFraction);
    runCorrectedMonteCarlo('DOWN5_GOLDEN', correctedDown5, startBalance, stakeFraction);
  }
}
