const fs = require('fs');
const path = require('path');

const { simulateBankrollPath } = require('./hybrid_replay_backtest');

function num(x) {
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
}

function wilsonLCB(wins, total, z = 1.96) {
  const n = Number(total);
  const w = Number(wins);
  if (!Number.isFinite(n) || !Number.isFinite(w) || n <= 0) return 0;
  const pHat = w / n;
  const denom = 1 + (z * z) / n;
  const center = pHat + (z * z) / (2 * n);
  const margin = z * Math.sqrt((pHat * (1 - pHat) + (z * z) / (4 * n)) / n);
  return Math.max(0, (center - margin) / denom);
}

function median(sorted) {
  const arr = Array.isArray(sorted) ? sorted : [];
  if (!arr.length) return null;
  const mid = Math.floor(arr.length / 2);
  return arr.length % 2 === 0 ? (arr[mid - 1] + arr[mid]) / 2 : arr[mid];
}

function mean(arr) {
  const a = Array.isArray(arr) ? arr : [];
  if (!a.length) return null;
  const s = a.reduce((sum, v) => sum + v, 0);
  return s / a.length;
}

function geoMean(arr) {
  const a = Array.isArray(arr) ? arr : [];
  if (!a.length) return null;
  const positives = a.filter(v => Number.isFinite(v) && v > 0);
  if (positives.length !== a.length) return null;
  const s = positives.reduce((sum, v) => sum + Math.log(v), 0);
  return Math.exp(s / positives.length);
}

function parseCsv(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');
  const lines = raw.split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) return [];
  const headers = lines[0].split(',').map(h => String(h || '').trim());
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(',');
    const row = {};
    for (let j = 0; j < headers.length; j++) {
      const key = headers[j];
      const value = String(cols[j] || '').trim();
      const n = Number(value);
      row[key] = Number.isFinite(n) ? n : value;
    }
    rows.push(row);
  }
  return rows;
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

function riskSortKey(row) {
  return {
    pBelowStart: Number.isFinite(Number(row?.pBelowStart)) ? Number(row.pBelowStart) : 1,
    stressEnd: Number.isFinite(Number(row?.stressEnd)) ? Number(row.stressEnd) : (Number.isFinite(Number(row?.minEnd)) ? Number(row.minEnd) : -Infinity),
    medianEnd: Number.isFinite(Number(row?.medianEnd)) ? Number(row.medianEnd) : -Infinity,
    meanEnd: Number.isFinite(Number(row?.meanEnd)) ? Number(row.meanEnd) : -Infinity,
  };
}

function pickBestRiskAdjusted(rows) {
  const list = Array.isArray(rows) ? rows.slice() : [];
  if (!list.length) return null;
  list.sort((a, b) => {
    const ka = riskSortKey(a);
    const kb = riskSortKey(b);
    if (ka.pBelowStart !== kb.pBelowStart) return ka.pBelowStart - kb.pBelowStart;
    if (ka.stressEnd !== kb.stressEnd) return kb.stressEnd - ka.stressEnd;
    if (ka.medianEnd !== kb.medianEnd) return kb.medianEnd - ka.medianEnd;
    return kb.meanEnd - ka.meanEnd;
  });
  return list[0];
}

function pickRobust(rows) {
  const list = Array.isArray(rows) ? rows.slice() : [];
  if (!list.length) return null;

  const zeros = list.filter(r => Number(r?.pBelowStart) === 0);
  const candidates = zeros.length ? zeros : list;

  candidates.sort((a, b) => {
    const aMin = Number.isFinite(Number(a?.stressEnd)) ? Number(a.stressEnd) : Number(a?.minEnd);
    const bMin = Number.isFinite(Number(b?.stressEnd)) ? Number(b.stressEnd) : Number(b?.minEnd);
    if (aMin !== bMin) return bMin - aMin;

    const aMed = Number.isFinite(Number(a?.medianEnd)) ? Number(a.medianEnd) : -Infinity;
    const bMed = Number.isFinite(Number(b?.medianEnd)) ? Number(b.medianEnd) : -Infinity;
    if (aMed !== bMed) return bMed - aMed;

    const aMean = Number.isFinite(Number(a?.meanEnd)) ? Number(a.meanEnd) : -Infinity;
    const bMean = Number.isFinite(Number(b?.meanEnd)) ? Number(b.meanEnd) : -Infinity;
    return bMean - aMean;
  });

  return candidates[0];
}

function summarizeScenarioGrid(gridRows, startingBalance, includeWindowField) {
  const rowsByStake = new Map();
  for (const r of gridRows) {
    const stake = Number(r?.stakeFraction);
    if (!Number.isFinite(stake)) continue;
    const arr = rowsByStake.get(stake) || [];
    arr.push(r);
    rowsByStake.set(stake, arr);
  }

  const outRows = [];
  for (const [stakeFraction, stakeRows] of Array.from(rowsByStake.entries()).sort((a, b) => a[0] - b[0])) {
    const ends = stakeRows
      .map(r => Number(r?.endingBalance))
      .filter(v => Number.isFinite(v));
    ends.sort((a, b) => a - b);

    const scenarios = ends.length;
    const meanEnd = mean(ends);
    const medEnd = median(ends);
    const gMean = geoMean(ends);
    const minEnd = ends.length ? ends[0] : null;
    const maxEnd = ends.length ? ends[ends.length - 1] : null;

    const pBelowStart = scenarios
      ? (ends.filter(v => v < startingBalance).length / scenarios)
      : null;

    const base = stakeRows.find(r => Number(r?.fillBumpCents) === 0 && Number(r?.slippagePct) === 0);
    const baseEnd = base && Number.isFinite(Number(base.endingBalance)) ? Number(base.endingBalance) : null;

    const stressEnd = minEnd;

    const row = {
      stakeFraction,
      scenarios,
      meanEnd,
      medianEnd: medEnd,
      geoMeanEnd: gMean,
      minEnd,
      maxEnd,
      pBelowStart,
      baseEnd,
      stressEnd,
    };

    if (includeWindowField) {
      row.window = String(stakeRows[0]?.window || '');
    }

    if (Number.isFinite(baseEnd) && startingBalance > 0) {
      row.baseRoiPct = ((baseEnd - startingBalance) / startingBalance) * 100;
    }
    if (Number.isFinite(stressEnd) && startingBalance > 0) {
      row.stressRoiPct = ((stressEnd - startingBalance) / startingBalance) * 100;
    }

    outRows.push(row);
  }

  const bestMean = outRows.length
    ? outRows.slice().sort((a, b) => (Number(b.meanEnd) - Number(a.meanEnd)))[0]
    : null;

  const bestMedian = outRows.length
    ? outRows.slice().sort((a, b) => (Number(b.medianEnd) - Number(a.medianEnd)))[0]
    : null;

  const bestRiskAdj = pickBestRiskAdjusted(outRows);

  return { rows: outRows, bestMean, bestMedian, bestRiskAdj };
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
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

function computeWindowStats(trades, endEpochSec, windowSeconds) {
  const startEpochSec = windowSeconds === null ? null : (endEpochSec - windowSeconds);
  const subset = startEpochSec === null
    ? trades
    : trades.filter(t => getTradeEpochSec(t) >= startEpochSec);

  let wins = 0;
  let losses = 0;
  for (const t of subset) {
    if (t?.won === true || t?.isWin === true) wins += 1;
    else if (t?.won === false || t?.isWin === false) losses += 1;
  }
  const resolved = wins + losses;
  const winRate = resolved ? wins / resolved : 0;
  const winRateLCB = resolved ? wilsonLCB(wins, resolved) : 0;

  return {
    trades: subset.length,
    wins,
    losses,
    winRate,
    winRateLCB,
  };
}

function buildStrategyWindowSummary(sets) {
  const windows = [
    { key: '24h', seconds: 86400 },
    { key: '48h', seconds: 2 * 86400 },
    { key: '1w', seconds: 7 * 86400 },
    { key: '2w', seconds: 14 * 86400 },
    { key: '1m', seconds: 30 * 86400 },
    { key: 'full', seconds: null },
  ];

  const out = { generatedAt: new Date().toISOString(), sets: {} };

  for (const s of sets) {
    const ledger = readJson(s.ledgerPath);
    const trades = Array.isArray(ledger?.trades) ? ledger.trades : [];
    const epochs = trades.map(getTradeEpochSec).filter(v => Number.isFinite(v) && v > 0);
    const endEpochSec = epochs.length ? Math.max(...epochs) : Math.floor(Date.now() / 1000);

    const full = computeWindowStats(trades, endEpochSec, null);
    const days = windows.find(w => w.key === 'full') ? ((windows.find(w => w.key === 'full')?.seconds ?? null)) : null;

    const byDaySet = new Set(trades.map(t => {
      const e = getTradeEpochSec(t);
      if (!e) return null;
      return new Date(e * 1000).toISOString().slice(0, 10);
    }).filter(Boolean));

    out.sets[s.outKey] = {
      trades: full.trades,
      wins: full.wins,
      winRate: full.winRate,
      winRateLCB: full.winRateLCB,
      tradesPerDay: byDaySet.size ? full.trades / byDaySet.size : 0,
      windows: {},
    };

    for (const w of windows) {
      const ws = computeWindowStats(trades, endEpochSec, w.seconds);
      out.sets[s.outKey].windows[w.key] = {
        trades: ws.trades,
        wins: ws.wins,
        losses: ws.losses,
        winRate: ws.winRate,
        winRateLCB: ws.winRateLCB,
      };
    }
  }

  return out;
}

function buildStressExpectedAllSets(debugDir, stressDir, sets) {
  const windows = ['1w', '2w', '3w', '1m', 'full'];
  const out = {
    generatedAt: new Date().toISOString(),
    source: 'stress_min1 matrices',
    summary: {
      SB5: {},
      SB10: {},
    },
  };

  for (const sb of [5, 10]) {
    const sbKey = sb === 5 ? 'SB5' : 'SB10';

    for (const s of sets) {
      const filePath = path.join(stressDir, `${s.stressPrefix}_min1_sb${sb}_simulateBankrollPath_stress_matrix.csv`);
      const rows = parseCsv(filePath);

      const perWindow = {};
      for (const w of windows) {
        const grid = rows.filter(r => String(r.window || '') === w);
        perWindow[w] = summarizeScenarioGrid(grid, sb, true);
      }

      out.summary[sbKey][s.outKey] = {};
      for (const w of windows) {
        out.summary[sbKey][s.outKey][w] = perWindow[w];
      }
    }
  }

  return out;
}

function buildStressExpectedCompact(stressAllSets, sets) {
  const windows = ['1w', '2w', '3w', '1m', 'full'];
  const out = {
    generatedAt: stressAllSets.generatedAt,
    windowsBySet: { SB5: {}, SB10: {} },
    winners: { SB5: {}, SB10: {} },
  };

  for (const sbKey of ['SB5', 'SB10']) {
    for (const s of sets) {
      out.windowsBySet[sbKey][s.outKey] = {};
      for (const w of windows) {
        const rows = stressAllSets?.summary?.[sbKey]?.[s.outKey]?.[w]?.rows || [];
        const bestMean = stressAllSets?.summary?.[sbKey]?.[s.outKey]?.[w]?.bestMean || null;
        const bestRiskAdj = stressAllSets?.summary?.[sbKey]?.[s.outKey]?.[w]?.bestRiskAdj || pickBestRiskAdjusted(rows);
        const robust = pickRobust(rows);

        const normalize = (r) => (r ? {
          set: s.outKey,
          stakeFraction: num(r.stakeFraction),
          meanEnd: num(r.meanEnd),
          medianEnd: num(r.medianEnd),
          pBelowStart: num(r.pBelowStart),
          minEnd: num(r.minEnd),
          stressEnd: num(r.stressEnd),
        } : null);

        out.windowsBySet[sbKey][s.outKey][w] = {
          bestMean: normalize(bestMean),
          bestRiskAdj: normalize(bestRiskAdj),
          robust: normalize(robust),
        };
      }
    }

    out.winners[sbKey] = {};
    for (const w of windows) {
      const candidates = sets.map(s => {
        const r = out.windowsBySet[sbKey][s.outKey][w]?.bestRiskAdj;
        return r ? { ...r, set: s.outKey, window: w } : null;
      }).filter(Boolean);

      const meanCandidates = sets.map(s => {
        const r = out.windowsBySet[sbKey][s.outKey][w]?.bestMean;
        return r ? { ...r, set: s.outKey, window: w } : null;
      }).filter(Boolean);

      const highestMean = meanCandidates.length
        ? meanCandidates.slice().sort((a, b) => Number(b.meanEnd) - Number(a.meanEnd))[0]
        : null;

      const highestRiskAdjMedian = candidates.length
        ? pickBestRiskAdjusted(candidates)
        : null;

      out.winners[sbKey][w] = {
        highestMean,
        highestRiskAdjMedian,
      };
    }
  }

  return out;
}

function buildExpected24h48hAllSets(debugDir, sets) {
  const windows = [
    { key: '24h', seconds: 86400 },
    { key: '48h', seconds: 2 * 86400 },
  ];
  const slippages = [0, 0.01, 0.02];
  const fillBumpCentsList = Array.from({ length: 11 }, (_, i) => i);
  const stakeFractions = [0.05, 0.1, 0.15, 0.2, 0.25, 0.3];

  const out = {
    generatedAt: new Date().toISOString(),
    windows: { SB5: {}, SB10: {} },
  };

  for (const sb of [5, 10]) {
    const sbKey = sb === 5 ? 'SB5' : 'SB10';
    out.windows[sbKey] = {};

    for (const s of sets) {
      const ledger = readJson(s.ledgerPath);
      const allTrades = Array.isArray(ledger?.trades) ? ledger.trades : [];
      const epochs = allTrades.map(getTradeEpochSec).filter(v => Number.isFinite(v) && v > 0);
      const endEpochSec = epochs.length ? Math.max(...epochs) : Math.floor(Date.now() / 1000);

      out.windows[sbKey][s.outKey] = {};

      for (const w of windows) {
        const startEpochSec = endEpochSec - w.seconds;
        const windowTrades = allTrades.filter(t => getTradeEpochSec(t) >= startEpochSec);

        const gridRows = [];
        for (const stakeFraction of stakeFractions) {
          for (const slippagePct of slippages) {
            for (const fillBumpCents of fillBumpCentsList) {
              const bump = fillBumpCents / 100;
              const adjustedTrades = windowTrades.map(t => {
                const ep = Number(t?.entryPrice);
                const adj = Number.isFinite(ep) ? Math.min(0.99, ep + bump) : ep;
                return { ...t, entryPrice: adj };
              });

              const sim = simulateBankrollPath(adjustedTrades, {
                startingBalance: sb,
                stakeFraction,
                maxExposure: 0.60,
                maxAbsoluteStake: 1_000_000_000,
                tieredMaxAbsoluteStake: false,
                minOrderShares: 1,
                minOddsEntry: 0.35,
                minOrderCostOverride: 1,
                simulateHalts: false,
                kellyEnabled: false,
                adaptiveMode: false,
                autoProfileEnabled: false,
                allowDynamicStake: false,
                riskEnvelopeEnabled: false,
                streakSizingEnabled: false,
                winBonusEnabled: false,
                slippagePct,
              });

              const endBal = num(sim?.stats?.endingBalance);
              gridRows.push({
                window: w.key,
                stakeFraction,
                fillBumpCents,
                slippagePct,
                endingBalance: endBal,
              });
            }
          }
        }

        const summary = summarizeScenarioGrid(gridRows, sb, false);
        const rows = summary.rows.map(r => ({
          stakeFraction: r.stakeFraction,
          scenarios: r.scenarios,
          meanEnd: r.meanEnd,
          medianEnd: r.medianEnd,
          minEnd: r.minEnd,
          maxEnd: r.maxEnd,
          pBelowStart: r.pBelowStart,
          baseEnd: r.baseEnd,
          stressEnd: r.stressEnd,
        }));

        const bestMean = summary.bestMean ? {
          stakeFraction: summary.bestMean.stakeFraction,
          scenarios: summary.bestMean.scenarios,
          meanEnd: summary.bestMean.meanEnd,
          medianEnd: summary.bestMean.medianEnd,
          minEnd: summary.bestMean.minEnd,
          maxEnd: summary.bestMean.maxEnd,
          pBelowStart: summary.bestMean.pBelowStart,
          baseEnd: summary.bestMean.baseEnd,
          stressEnd: summary.bestMean.stressEnd,
        } : null;

        const bestRiskAdj = summary.bestRiskAdj ? {
          stakeFraction: summary.bestRiskAdj.stakeFraction,
          scenarios: summary.bestRiskAdj.scenarios,
          meanEnd: summary.bestRiskAdj.meanEnd,
          medianEnd: summary.bestRiskAdj.medianEnd,
          minEnd: summary.bestRiskAdj.minEnd,
          maxEnd: summary.bestRiskAdj.maxEnd,
          pBelowStart: summary.bestRiskAdj.pBelowStart,
          baseEnd: summary.bestRiskAdj.baseEnd,
          stressEnd: summary.bestRiskAdj.stressEnd,
        } : null;

        out.windows[sbKey][s.outKey][w.key] = {
          rows,
          bestMean,
          bestRiskAdj,
        };
      }
    }
  }

  return out;
}

function buildExpected24h48hCompact(expectedAllSets, sets) {
  const out = {
    generatedAt: expectedAllSets.generatedAt,
    windowsBySet: { SB5: {}, SB10: {} },
    winners: { SB5: {}, SB10: {} },
  };

  for (const sbKey of ['SB5', 'SB10']) {
    out.windowsBySet[sbKey] = {};

    for (const s of sets) {
      out.windowsBySet[sbKey][s.outKey] = {};
      for (const w of ['24h', '48h']) {
        const src = expectedAllSets?.windows?.[sbKey]?.[s.outKey]?.[w] || {};

        const normalize = (r) => (r ? {
          set: s.outKey,
          stakeFraction: num(r.stakeFraction),
          meanEnd: num(r.meanEnd),
          medianEnd: num(r.medianEnd),
          pBelowStart: num(r.pBelowStart),
          minEnd: num(r.minEnd),
          stressEnd: num(r.stressEnd),
        } : null);

        out.windowsBySet[sbKey][s.outKey][w] = {
          bestMean: normalize(src.bestMean),
          bestRiskAdj: normalize(src.bestRiskAdj),
        };
      }
    }

    out.winners[sbKey] = {};
    for (const w of ['24h', '48h']) {
      const meanCandidates = sets.map(s => {
        const r = out.windowsBySet[sbKey][s.outKey][w]?.bestMean;
        return r ? { ...r, set: s.outKey, window: w } : null;
      }).filter(Boolean);

      const riskCandidates = sets.map(s => {
        const r = out.windowsBySet[sbKey][s.outKey][w]?.bestRiskAdj;
        return r ? { ...r, set: s.outKey, window: w } : null;
      }).filter(Boolean);

      const highestMean = meanCandidates.length
        ? meanCandidates.slice().sort((a, b) => Number(b.meanEnd) - Number(a.meanEnd))[0]
        : null;

      const highestRiskAdjMedian = riskCandidates.length
        ? pickBestRiskAdjusted(riskCandidates)
        : null;

      out.winners[sbKey][w] = {
        highestMean,
        highestRiskAdjMedian,
      };
    }
  }

  return out;
}

function main() {
  const repoRoot = path.resolve(__dirname, '..');
  const debugDir = path.join(repoRoot, 'debug');
  const analysisDir = path.join(debugDir, 'analysis');
  const stressDir = path.join(debugDir, 'stress_min1');

  fs.mkdirSync(analysisDir, { recursive: true });

  const sets = [
    {
      outKey: 'top3',
      stressPrefix: 'top3_robust',
      ledgerPath: path.join(debugDir, 'final_set_scan', 'top3_robust', 'hybrid_replay_executed_ledger.json'),
    },
    {
      outKey: 'top7',
      stressPrefix: 'top7_drop6',
      ledgerPath: path.join(debugDir, 'final_set_scan', 'top7_drop6', 'hybrid_replay_executed_ledger.json'),
    },
    {
      outKey: 'opt8',
      stressPrefix: 'optimized8',
      ledgerPath: path.join(debugDir, 'final_full_default', 'hybrid_replay_executed_ledger.json'),
    },
  ];

  const strategyWindowSummary = buildStrategyWindowSummary(sets);
  fs.writeFileSync(
    path.join(analysisDir, 'strategy_window_summary_top3_top7_opt8.json'),
    JSON.stringify(strategyWindowSummary, null, 2),
  );

  const stressAllSets = buildStressExpectedAllSets(debugDir, stressDir, sets);
  fs.writeFileSync(
    path.join(analysisDir, 'stress_expected_all_sets.json'),
    JSON.stringify(stressAllSets, null, 2),
  );

  const stressCompact = buildStressExpectedCompact(stressAllSets, sets);
  fs.writeFileSync(
    path.join(analysisDir, 'stress_expected_compact.json'),
    JSON.stringify(stressCompact, null, 2),
  );

  const expected24h48hAllSets = buildExpected24h48hAllSets(debugDir, sets);
  fs.writeFileSync(
    path.join(analysisDir, 'expected_24h48h_all_sets.json'),
    JSON.stringify(expected24h48hAllSets, null, 2),
  );

  const expected24h48hCompact = buildExpected24h48hCompact(expected24h48hAllSets, sets);
  fs.writeFileSync(
    path.join(analysisDir, 'expected_24h48h_compact.json'),
    JSON.stringify(expected24h48hCompact, null, 2),
  );

  process.stdout.write('Wrote debug/analysis artifacts.\n');
}

try {
  main();
} catch (e) {
  const msg = e && e.stack ? e.stack : String(e);
  process.stderr.write(`Fatal: ${msg}\n`);
  process.exit(1);
}
