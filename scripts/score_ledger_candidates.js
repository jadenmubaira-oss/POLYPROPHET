const fs = require('fs');
const path = require('path');

const { simulateBankrollPath } = require('./hybrid_replay_backtest.js');

function parseArg(name, def = null) {
  const prefix = `--${name}=`;
  const arg = process.argv.find((a) => a.startsWith(prefix));
  if (!arg) return def;
  return arg.slice(prefix.length);
}

function parseBoolArg(name, def = false) {
  const v = parseArg(name, null);
  if (v === null) return def;
  return !['0', 'false', 'no', 'off'].includes(String(v).trim().toLowerCase());
}

function toNum(x) {
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
}

function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
}

function avg(xs) {
  const ys = xs.map(Number).filter(Number.isFinite);
  if (!ys.length) return null;
  return ys.reduce((a, b) => a + b, 0) / ys.length;
}

function median(xs) {
  const ys = xs.map(Number).filter(Number.isFinite).sort((a, b) => a - b);
  if (!ys.length) return null;
  return ys[Math.floor((ys.length - 1) * 0.5)];
}

function wilsonLCB(wins, n, z = 1.96) {
  if (!n) return null;
  const phat = wins / n;
  const denom = 1 + (z * z) / n;
  const center = phat + (z * z) / (2 * n);
  const adj = z * Math.sqrt((phat * (1 - phat) + (z * z) / (4 * n)) / n);
  return (center - adj) / denom;
}

function getTradeEpochSec(t) {
  const a = Number(t?.cycleStartEpochSec);
  if (Number.isFinite(a) && a > 0) return Math.floor(a);
  const b = Number(t?.cycleStartEpoch);
  if (Number.isFinite(b) && b > 0) return Math.floor(b);
  const c = Number(t?.issuedAt);
  if (Number.isFinite(c) && c > 0) return Math.floor(c / 1000);
  const d = Number(t?.resolvedAt);
  if (Number.isFinite(d) && d > 0) return Math.floor(d / 1000);
  return 0;
}

function findLedgers(debugDir) {
  const out = [];
  const stack = [debugDir];
  while (stack.length) {
    const p = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(p, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const e of entries) {
      const full = path.join(p, e.name);
      if (e.isDirectory()) {
        stack.push(full);
        continue;
      }
      if (e.isFile() && e.name === 'hybrid_replay_executed_ledger.json') {
        out.push(full);
      }
    }
  }
  return out;
}

function loadLedger(ledgerPath) {
  const j = JSON.parse(fs.readFileSync(ledgerPath, 'utf8'));
  const trades = Array.isArray(j?.trades) ? j.trades : [];

  const epochs = trades.map(getTradeEpochSec).filter((x) => x > 0);
  const start = epochs.length ? Math.min(...epochs) : null;
  const end = epochs.length ? Math.max(...epochs) : null;
  const days = start && end ? (end - start) / 86400 : null;

  const wins = trades.filter((t) => t?.isWin === true || t?.won === true).length;
  const n = trades.length;
  const wr = n ? wins / n : null;
  const lcb = n ? wilsonLCB(wins, n) : null;

  const baseCfg =
    j?.meta?.bankrollSimulation?.config && typeof j.meta.bankrollSimulation.config === 'object'
      ? j.meta.bankrollSimulation.config
      : {};

  return { trades, start, end, days, wins, n, wr, lcb, baseCfg };
}

function runSim(trades, baseOptions, stakeFraction, bumpCents, slippagePct) {
  const bump = bumpCents / 100;
  const adjusted = trades.map((t) => {
    const ep = toNum(t?.entryPrice);
    const adj = ep === null ? t?.entryPrice : clamp(ep + bump, 0.01, 0.99);
    return { ...t, entryPrice: adj };
  });

  const sim = simulateBankrollPath(adjusted, { ...baseOptions, stakeFraction, slippagePct });
  return sim?.stats || {};
}

function scoreLedger(ledgerPath, opts) {
  const { trades, days, n, wins, wr, lcb, baseCfg } = loadLedger(ledgerPath);

  const startBal = opts.startBalance;
  // Important: DO NOT inherit per-ledger bankrollSimulation config.
  // Many ledgers in debug/ are outputs from other stress runners and embed
  // non-comparable knobs like missRate / autoBankroll profiles / pre-set slippage.
  // We re-simulate using a fixed baseline config so all candidates are scored
  // under the same assumptions.
  const baseOptions = {
    startingBalance: startBal,

    // keep stable + comparable across ledgers
    maxExposure: 0.6,
    maxAbsoluteStake: 1e9,
    tieredMaxAbsoluteStake: false,

    minOrderShares: 1,
    minOddsEntry: 0.35,

    // treat missed trades as zero (manual mode = you can always choose to take)
    missRate: 0,

    simulateHalts: true,

    // disable adaptive sizing features for fair comparisons
    kellyEnabled: false,
    adaptiveMode: false,
    autoProfileEnabled: false,
    allowDynamicStake: false,
    riskEnvelopeEnabled: false,
    streakSizingEnabled: false,
    winBonusEnabled: false,
  };

  const stakeFractions = opts.stakeFractions;
  const bumps = opts.bumpCents;
  const slips = opts.slippages;

  const stakeRows = stakeFractions.map((sf) => {
    const ends = [];
    let worst = null;

    for (const slip of slips) {
      for (const bump of bumps) {
        const s = runSim(trades, baseOptions, sf, bump, slip);
        ends.push(s.endingBalance);
        if (bump === Math.max(...bumps) && slip === Math.max(...slips)) worst = s;
      }
    }

    const pBelowStart = ends.filter((e) => Number.isFinite(e) && e < startBal).length / ends.length;
    const pBelow5 = ends.filter((e) => Number.isFinite(e) && e < 5).length / ends.length;

    return {
      stakeFraction: sf,
      meanEnd: avg(ends),
      medianEnd: median(ends),
      minEnd: ends.map(Number).filter(Number.isFinite).reduce((m, x) => Math.min(m, x), Infinity),
      pEndBelowStart: pBelowStart,
      pEndBelow5: pBelow5,
      worstEnd: worst?.endingBalance ?? null,
      worstBlocked: worst?.blocked ?? null,
      worstExecuted: worst?.executed ?? null,
      worstHaltMinOrder: worst?.haltCounts?.minOrder ?? 0,
    };
  });

  // Choose stake by: (1) minimize bust risk, (2) maximize worst-case, (3) maximize expected.
  // bust risk proxy = P(endingBalance < startBalance) across bump/slip grid.
  const best = stakeRows
    .slice()
    .sort((a, b) => {
      const aP = a.pEndBelowStart ?? 1;
      const bP = b.pEndBelowStart ?? 1;
      if (aP !== bP) return aP - bP;

      const aW = Number.isFinite(a.worstEnd) ? a.worstEnd : -Infinity;
      const bW = Number.isFinite(b.worstEnd) ? b.worstEnd : -Infinity;
      if (aW !== bW) return bW - aW;

      const aM = Number.isFinite(a.meanEnd) ? a.meanEnd : -Infinity;
      const bM = Number.isFinite(b.meanEnd) ? b.meanEnd : -Infinity;
      return bM - aM;
    })[0];

  return {
    ledgerPath,
    label: path
      .relative(opts.debugDir, ledgerPath)
      .replace(/\\/g, '/')
      .replace(/\/hybrid_replay_executed_ledger\.json$/, ''),
    trades: n,
    wins,
    winRate: wr,
    winRateLCB: lcb,
    days,
    tradesPerDay: days && days > 0 ? n / days : null,
    best,
    stakeRows,
  };
}

function fmt(n) {
  const x = Number(n);
  if (!Number.isFinite(x)) return '';
  if (Math.abs(x) >= 1e6) return x.toExponential(2);
  if (Math.abs(x) >= 1000) return x.toFixed(0);
  return x.toFixed(2);
}

function main() {
  const repoRoot = path.resolve(__dirname, '..');
  const debugDir = path.join(repoRoot, 'debug');

  const startBalance = toNum(parseArg('startBalance', '10')) ?? 10;
  const listTop = toNum(parseArg('top', '25')) ?? 25;
  const printAll = parseBoolArg('all', false);
  const includeStressLedgers = parseBoolArg('includeStressLedgers', false);
  const only = parseArg('only', null);

  const stakeFractionsRaw = String(parseArg('stakes', '0.05,0.075,0.10,0.15,0.20,0.25,0.30'));
  const stakeFractions = stakeFractionsRaw
    .split(',')
    .map((s) => Number(s.trim()))
    .filter((x) => Number.isFinite(x) && x > 0 && x < 1);

  const bumpsRaw = String(parseArg('bumps', '1,2,3,4,5,6,7,8,9,10'));
  const bumpCents = bumpsRaw
    .split(',')
    .map((s) => Number(s.trim()))
    .filter((x) => Number.isFinite(x) && x >= 0);

  const slipsRaw = String(parseArg('slips', '0,0.01,0.02'));
  const slippages = slipsRaw
    .split(',')
    .map((s) => Number(s.trim()))
    .filter((x) => Number.isFinite(x) && x >= 0);

  let ledgerPaths = findLedgers(debugDir);
  if (!includeStressLedgers) {
    ledgerPaths = ledgerPaths.filter((p) => {
      const norm = String(p).replace(/\\/g, '/');
      return !norm.includes('/debug/top7_drop6_stress_matrix/') && !norm.includes('/debug/top7_drop6_stress_sb') && !norm.includes('/debug/top7_drop6_stress_') && !norm.includes('/debug/top7_original_fill_profile/');
    });
  }
  if (only) {
    const needle = String(only).trim().toLowerCase();
    ledgerPaths = ledgerPaths.filter((p) => String(p).replace(/\\/g, '/').toLowerCase().includes(needle));
  }

  const opts = { debugDir, startBalance, stakeFractions, bumpCents, slippages };

  const scored = ledgerPaths.map((p) => scoreLedger(p, opts));
  // Rank by: (1) bust risk, (2) worst-case, (3) expected, (4) frequency.
  scored.sort((a, b) => {
    const aBest = a.best || {};
    const bBest = b.best || {};

    const aP = aBest.pEndBelowStart ?? 1;
    const bP = bBest.pEndBelowStart ?? 1;
    if (aP !== bP) return aP - bP;

    const aW = Number.isFinite(aBest.worstEnd) ? aBest.worstEnd : -Infinity;
    const bW = Number.isFinite(bBest.worstEnd) ? bBest.worstEnd : -Infinity;
    if (aW !== bW) return bW - aW;

    const aM = Number.isFinite(aBest.meanEnd) ? aBest.meanEnd : -Infinity;
    const bM = Number.isFinite(bBest.meanEnd) ? bBest.meanEnd : -Infinity;
    if (aM !== bM) return bM - aM;

    const aF = a.tradesPerDay ?? 0;
    const bF = b.tradesPerDay ?? 0;
    return bF - aF;
  });

  const rowsToPrint = printAll ? scored : scored.slice(0, listTop);

  console.log(
    [
      'rank',
      'label',
      'trades',
      'trades/day',
      'winRate',
      'LCB',
      'bestStake',
      'meanEnd',
      'medianEnd',
      'worstEnd',
      'P(end<start)',
      'P(end<5)',
      'worstBlocked',
      'worstHaltMinOrder',
    ].join('\t'),
  );

  rowsToPrint.forEach((s, i) => {
    const b = s.best || {};
    console.log(
      [
        String(i + 1),
        s.label,
        String(s.trades ?? ''),
        s.tradesPerDay !== null ? s.tradesPerDay.toFixed(2) : '',
        s.winRate !== null ? s.winRate.toFixed(4) : '',
        s.winRateLCB !== null ? s.winRateLCB.toFixed(4) : '',
        b.stakeFraction !== undefined ? b.stakeFraction.toFixed(3) : '',
        fmt(b.meanEnd),
        fmt(b.medianEnd),
        fmt(b.worstEnd),
        b.pEndBelowStart !== undefined ? `${(b.pEndBelowStart * 100).toFixed(1)}%` : '',
        b.pEndBelow5 !== undefined ? `${(b.pEndBelow5 * 100).toFixed(1)}%` : '',
        b.worstBlocked ?? '',
        b.worstHaltMinOrder ?? '',
      ].join('\t'),
    );
  });

  const jsonOutPath = parseArg('jsonOut', null);
  if (jsonOutPath) {
    fs.writeFileSync(path.resolve(repoRoot, jsonOutPath), JSON.stringify(scored, null, 2));
  }
}

main();
