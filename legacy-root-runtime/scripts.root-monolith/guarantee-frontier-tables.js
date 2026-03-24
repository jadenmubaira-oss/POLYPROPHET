
const fs = require('fs');
const path = require('path');

const ASSETS = ['BTC', 'ETH', 'SOL', 'XRP'];
const WIN_RATE_THRESHOLDS = [0.9, 0.95, 0.97, 0.99];
const WILSON_LCB_THRESHOLDS = [0.75, 0.8, 0.85, 0.9];
const MIN_TRADES_OPTIONS = [20, 50, 100, 200, 500];
const BAYES_PRIORS = [
  { key: '1,1', label: 'Beta(1,1)', a: 1, b: 1 },
  { key: '0.5,0.5', label: 'Beta(0.5,0.5)', a: 0.5, b: 0.5 }
];
const BAYES_P_CUTOFFS = [0.95, 0.99, 0.999];

function toNum(x) {
  const n = typeof x === 'number' ? x : parseFloat(x);
  return Number.isFinite(n) ? n : null;
}

function fmtNum(x, digits = 4) {
  if (!Number.isFinite(x)) return 'n/a';
  return Number(x).toFixed(digits);
}

function fmtPct(x, digits = 2) {
  if (!Number.isFinite(x)) return 'n/a';
  return (x * 100).toFixed(digits) + '%';
}

function fmtBand(x) {
  if (!Number.isFinite(x)) return 'n/a';
  const fixed = Number(x).toFixed(6);
  return fixed.replace(/0+$/, '').replace(/\.$/, '');
}

function strategySignature(s) {
  const bandMin = toNum(s?.priceBand?.min ?? s?.bandMin);
  const bandMax = toNum(s?.priceBand?.max ?? s?.bandMax);
  return `${Number(s?.entryMinute)}|${Number(s?.utcHour)}|${String(s?.direction || '').toUpperCase()}|${fmtBand(bandMin)}|${fmtBand(bandMax)}`;
}

function normalizeStrategy(s) {
  const entryMinute = Number(s?.entryMinute);
  const utcHour = Number(s?.utcHour);
  const direction = String(s?.direction || '').toUpperCase();
  const bandMin = toNum(s?.priceBand?.min ?? s?.bandMin);
  const bandMax = toNum(s?.priceBand?.max ?? s?.bandMax);
  return {
    entryMinute,
    utcHour,
    direction,
    bandMin,
    bandMax,
    priceBand: { min: bandMin, max: bandMax },
    signature: null,
    valTrades: 0,
    valWins: 0,
    testTrades: 0,
    testWins: 0,
    valPerAsset: null,
    testPerAsset: null,
    valWinRate: null,
    valWinRateLCB: null,
    testWinRate: null,
    testWinRateLCB: null,
    valTradesPerDay: null,
    testTradesPerDay: null
  };
}

function buildStrategyIndex(rawStrategies) {
  const byKey = new Map();
  const all = [];

  const list = Array.isArray(rawStrategies) ? rawStrategies : [];
  for (const s of list) {
    const direction = String(s?.direction || '').toUpperCase();
    if (direction !== 'UP' && direction !== 'DOWN') continue;
    const st = normalizeStrategy(s);
    if (!Number.isFinite(st.entryMinute) || !Number.isFinite(st.utcHour)) continue;
    if (!Number.isFinite(st.bandMin) || !Number.isFinite(st.bandMax)) continue;

    st.signature = strategySignature(st);
    st.valPerAsset = Object.fromEntries(ASSETS.map(a => [a, { trades: 0, wins: 0 }]));
    st.testPerAsset = Object.fromEntries(ASSETS.map(a => [a, { trades: 0, wins: 0 }]));

    all.push(st);
    const key = `${st.entryMinute}|${st.utcHour}`;
    const bucket = byKey.get(key) || [];
    bucket.push(st);
    if (!byKey.has(key)) byKey.set(key, bucket);
  }

  return { all, byKey };
}

function wilsonLCBFromCounts(wins, total, z = 1.96) {
  if (!Number.isFinite(wins) || !Number.isFinite(total) || total <= 0) return 0;
  const pHat = wins / total;
  const denominator = 1 + (z * z) / total;
  const center = pHat + (z * z) / (2 * total);
  const margin = z * Math.sqrt((pHat * (1 - pHat) + (z * z) / (4 * total)) / total);
  return Math.max(0, (center - margin) / denominator);
}

function normCdf(z) {
  if (!Number.isFinite(z)) return null;
  const sign = z < 0 ? -1 : 1;
  const x = Math.abs(z) / Math.sqrt(2);
  const t = 1 / (1 + 0.3275911 * x);
  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const erf =
    1 - (((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t) * Math.exp(-x * x);
  const erfSigned = sign * erf;
  return 0.5 * (1 + erfSigned);
}

function posteriorProbWinRateAtLeast(wins, total, threshold, priorA = 1, priorB = 1) {
  if (!Number.isFinite(wins) || !Number.isFinite(total) || total <= 0) return 0;
  const losses = total - wins;
  const a = wins + priorA;
  const b = losses + priorB;
  const mean = a / (a + b);
  const variance = (a * b) / (((a + b) * (a + b)) * (a + b + 1));
  const sd = Math.sqrt(Math.max(0, variance));
  if (!Number.isFinite(sd) || sd === 0) return mean >= threshold ? 1 : 0;
  const z = (threshold - mean) / sd;
  const cdf = normCdf(z);
  if (cdf === null) return null;
  return Math.max(0, Math.min(1, 1 - cdf));
}

function streamJsonArrayObjects(filePath, onObject, opts = {}) {
  const logEvery = Number.isFinite(opts.logEvery) ? opts.logEvery : 0;

  return new Promise((resolve, reject) => {
    if (!fs.existsSync(filePath)) {
      reject(new Error(`Missing file: ${filePath}`));
      return;
    }

    const rs = fs.createReadStream(filePath, { encoding: 'utf8', highWaterMark: 1024 * 1024 });

    let started = false;
    let inString = false;
    let escape = false;
    let depth = 0;
    let objBuf = '';
    let seen = 0;

    rs.on('data', chunk => {
      for (let i = 0; i < chunk.length; i++) {
        const ch = chunk[i];

        if (!started) {
          if (ch === '[') started = true;
          continue;
        }

        if (depth === 0) {
          if (ch === '{') {
            depth = 1;
            objBuf = '{';
            inString = false;
            escape = false;
          }
          continue;
        }

        objBuf += ch;

        if (inString) {
          if (escape) {
            escape = false;
          } else if (ch === '\\') {
            escape = true;
          } else if (ch === '"') {
            inString = false;
          }
          continue;
        }

        if (ch === '"') {
          inString = true;
          continue;
        }

        if (ch === '{') {
          depth++;
          continue;
        }

        if (ch === '}') {
          depth--;
          if (depth === 0) {
            let obj;
            try {
              obj = JSON.parse(objBuf);
            } catch (e) {
              rs.destroy();
              reject(new Error(`JSON.parse failed after ${seen} objects: ${String(e && e.message ? e.message : e)}`));
              return;
            }

            seen++;
            onObject(obj);
            if (logEvery && seen % logEvery === 0) {
              process.stdout.write(`...parsed ${seen} rows\r`);
            }
            objBuf = '';
          }
        }
      }
    });

    rs.on('error', err => reject(err));
    rs.on('end', () => {
      if (logEvery) process.stdout.write(`...parsed ${seen} rows\n`);
      resolve(seen);
    });
  });
}

function readJsonFile(absPath) {
  return JSON.parse(fs.readFileSync(absPath, 'utf8'));
}

function parseArgs(argv) {
  const args = {
    out: null,
    logEvery: 0,
    showTop3: true,
    skipVariance: false,
    verify: true
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--out') args.out = argv[++i] || null;
    else if (a === '--logEvery') args.logEvery = parseInt(argv[++i] || '0', 10) || 0;
    else if (a === '--noTop3') args.showTop3 = false;
    else if (a === '--skipVariance') args.skipVariance = true;
    else if (a === '--noVerify') args.verify = false;
  }
  return args;
}

async function buildMarketSlugSplits(datasetPath, trainRatio, valRatio, opts = {}) {
  const bySlug = new Map();
  await streamJsonArrayObjects(
    datasetPath,
    row => {
      if (!row || typeof row !== 'object') return;
      if (!row.slug) return;
      const slug = row.slug;
      const epoch = Number(row.cycleStartEpochSec);
      const existing = bySlug.get(slug);
      if (!existing) {
        bySlug.set(slug, { slug, epoch: Number.isFinite(epoch) ? epoch : Infinity });
      } else if (Number.isFinite(epoch) && epoch < existing.epoch) {
        existing.epoch = epoch;
      }
    },
    { logEvery: opts.logEvery }
  );

  const markets = Array.from(bySlug.values()).sort((a, b) => {
    if (a.epoch !== b.epoch) return a.epoch - b.epoch;
    return String(a.slug).localeCompare(String(b.slug));
  });

  const trainEnd = Math.max(0, Math.floor(markets.length * trainRatio));
  const valEnd = Math.max(trainEnd, Math.floor(markets.length * (trainRatio + valRatio)));

  const trainSlugs = new Set(markets.slice(0, trainEnd).map(m => m.slug));
  const valSlugs = new Set(markets.slice(trainEnd, valEnd).map(m => m.slug));
  const testSlugs = new Set(markets.slice(valEnd).map(m => m.slug));

  return {
    markets,
    trainSlugs,
    valSlugs,
    testSlugs
  };
}

function resetHoldoutMetrics(strategyIndex) {
  for (const st of strategyIndex.all) {
    st.valTrades = 0;
    st.valWins = 0;
    st.testTrades = 0;
    st.testWins = 0;
    if (st.valPerAsset) {
      for (const a of ASSETS) {
        st.valPerAsset[a] = { trades: 0, wins: 0 };
      }
    }
    if (st.testPerAsset) {
      for (const a of ASSETS) {
        st.testPerAsset[a] = { trades: 0, wins: 0 };
      }
    }
    st.valWinRate = null;
    st.valWinRateLCB = null;
    st.testWinRate = null;
    st.testWinRateLCB = null;
    st.valTradesPerDay = null;
    st.testTradesPerDay = null;
  }
}

async function evaluateStrategiesOnHoldouts(datasetPath, split, strategyIndex, opts = {}) {
  const valSlugs = split?.valSlugs || new Set();
  const testSlugs = split?.testSlugs || new Set();

  let valRows = 0;
  let testRows = 0;
  let minValEntryEpoch = Infinity;
  let maxValEntryEpoch = -Infinity;
  let minTestEntryEpoch = Infinity;
  let maxTestEntryEpoch = -Infinity;

  resetHoldoutMetrics(strategyIndex);

  await streamJsonArrayObjects(
    datasetPath,
    row => {
      if (!row || typeof row !== 'object') return;
      const slug = row.slug;
      if (!slug) return;
      let prefix = null;
      if (valSlugs.has(slug)) prefix = 'val';
      else if (testSlugs.has(slug)) prefix = 'test';
      else return;

      const entryMinute = Number(row.entryMinute);
      const utcHour = Number(row.utcHour);
      const cycleStartEpochSec = Number(row.cycleStartEpochSec);
      if (!Number.isFinite(entryMinute) || !Number.isFinite(utcHour) || !Number.isFinite(cycleStartEpochSec)) return;
      const entryEpochSec = cycleStartEpochSec + entryMinute * 60;

      if (prefix === 'val') {
        valRows++;
        if (Number.isFinite(entryEpochSec)) {
          if (entryEpochSec < minValEntryEpoch) minValEntryEpoch = entryEpochSec;
          if (entryEpochSec > maxValEntryEpoch) maxValEntryEpoch = entryEpochSec;
        }
      } else {
        testRows++;
        if (Number.isFinite(entryEpochSec)) {
          if (entryEpochSec < minTestEntryEpoch) minTestEntryEpoch = entryEpochSec;
          if (entryEpochSec > maxTestEntryEpoch) maxTestEntryEpoch = entryEpochSec;
        }
      }

      const key = `${entryMinute}|${utcHour}`;
      const bucket = strategyIndex.byKey.get(key);
      if (!bucket || bucket.length === 0) return;

      const winnerIsUp = !!row.winnerIsUp;
      const assetKey = row.asset;
      const upPrice = toNum(row.upPrice);
      const downPrice = toNum(row.downPrice);

      for (const st of bucket) {
        const entryPrice = st.direction === 'UP' ? upPrice : downPrice;
        if (entryPrice === null) continue;
        if (entryPrice < st.bandMin || entryPrice > st.bandMax) continue;
        const won = (st.direction === 'UP') === winnerIsUp;
        if (prefix === 'val') {
          st.valTrades++;
          if (won) st.valWins++;
          const agg = st.valPerAsset?.[assetKey];
          if (agg) {
            agg.trades++;
            if (won) agg.wins++;
          }
        } else {
          st.testTrades++;
          if (won) st.testWins++;
          const agg = st.testPerAsset?.[assetKey];
          if (agg) {
            agg.trades++;
            if (won) agg.wins++;
          }
        }
      }
    },
    { logEvery: opts.logEvery }
  );

  const valDays =
    Number.isFinite(minValEntryEpoch) && Number.isFinite(maxValEntryEpoch)
      ? Math.max(1, (maxValEntryEpoch - minValEntryEpoch) / 86400)
      : 1;
  const testDays =
    Number.isFinite(minTestEntryEpoch) && Number.isFinite(maxTestEntryEpoch)
      ? Math.max(1, (maxTestEntryEpoch - minTestEntryEpoch) / 86400)
      : 1;

  const z = 1.96;
  for (const st of strategyIndex.all) {
    if (st.valTrades > 0) {
      st.valWinRate = st.valWins / st.valTrades;
      st.valWinRateLCB = wilsonLCBFromCounts(st.valWins, st.valTrades, z);
      st.valPosteriorPWinRateGE90 = posteriorProbWinRateAtLeast(st.valWins, st.valTrades, 0.9, 1, 1);
    }
    if (st.testTrades > 0) {
      st.testWinRate = st.testWins / st.testTrades;
      st.testWinRateLCB = wilsonLCBFromCounts(st.testWins, st.testTrades, z);
      st.testPosteriorPWinRateGE90 = posteriorProbWinRateAtLeast(st.testWins, st.testTrades, 0.9, 1, 1);
    }
    st.valTradesPerDay = valDays > 0 ? st.valTrades / valDays : null;
    st.testTradesPerDay = testDays > 0 ? st.testTrades / testDays : null;
  }

  return {
    valRows,
    testRows,
    valDays,
    testDays,
    minValEntryEpoch: Number.isFinite(minValEntryEpoch) ? minValEntryEpoch : null,
    maxValEntryEpoch: Number.isFinite(maxValEntryEpoch) ? maxValEntryEpoch : null,
    minTestEntryEpoch: Number.isFinite(minTestEntryEpoch) ? minTestEntryEpoch : null,
    maxTestEntryEpoch: Number.isFinite(maxTestEntryEpoch) ? maxTestEntryEpoch : null
  };
}

function safeNum(x, fallback = null) {
  const n = Number(x);
  return Number.isFinite(n) ? n : fallback;
}

function holdoutKeys(prefix) {
  return {
    trades: `${prefix}Trades`,
    wins: `${prefix}Wins`,
    winRate: `${prefix}WinRate`,
    winRateLCB: `${prefix}WinRateLCB`,
    tradesPerDay: `${prefix}TradesPerDay`
  };
}

function compareStrategiesByHoldout(prefix) {
  const keys = holdoutKeys(prefix);
  return (a, b) => {
    const aLCB = safeNum(a?.[keys.winRateLCB], -Infinity);
    const bLCB = safeNum(b?.[keys.winRateLCB], -Infinity);
    if (aLCB !== bLCB) return bLCB - aLCB;

    const aTPD = safeNum(a?.[keys.tradesPerDay], -Infinity);
    const bTPD = safeNum(b?.[keys.tradesPerDay], -Infinity);
    if (aTPD !== bTPD) return bTPD - aTPD;

    const aWR = safeNum(a?.[keys.winRate], -Infinity);
    const bWR = safeNum(b?.[keys.winRate], -Infinity);
    if (aWR !== bWR) return bWR - aWR;

    const aT = safeNum(a?.[keys.trades], -Infinity);
    const bT = safeNum(b?.[keys.trades], -Infinity);
    if (aT !== bT) return bT - aT;

    return String(a?.signature || '').localeCompare(String(b?.signature || ''));
  };
}

function fmtPosterior(x, digits = 4) {
  if (!Number.isFinite(x)) return 'n/a';
  return Number(x).toFixed(digits);
}

function formatStrategyCompact(st, prefix, extra = {}) {
  const keys = holdoutKeys(prefix);
  const trades = safeNum(st?.[keys.trades], 0);
  const wins = safeNum(st?.[keys.wins], 0);
  const wr = safeNum(st?.[keys.winRate], null);
  const lcb = safeNum(st?.[keys.winRateLCB], null);
  const tpd = safeNum(st?.[keys.tradesPerDay], null);
  const post = Number.isFinite(extra.posterior) ? ` post=${fmtPosterior(extra.posterior, 4)}` : '';
  return `${st.signature} tpd=${fmtNum(tpd, 4)} n=${trades} w=${wins} wr=${fmtPct(wr, 2)} lcb=${fmtPct(lcb, 2)}${post}`;
}

function bestByTradesPerDay(candidates, prefix) {
  const keys = holdoutKeys(prefix);
  let best = null;
  let bestTPD = -Infinity;
  for (const st of candidates) {
    const tpd = safeNum(st?.[keys.tradesPerDay], -Infinity);
    if (tpd > bestTPD) {
      bestTPD = tpd;
      best = st;
    } else if (tpd === bestTPD && best) {
      const aLCB = safeNum(st?.[keys.winRateLCB], -Infinity);
      const bLCB = safeNum(best?.[keys.winRateLCB], -Infinity);
      if (aLCB > bLCB) best = st;
    }
  }
  return best;
}

function computeFrontierCells(strategies, prefix, guarantee, minTradesOptions, thresholds, extra = {}) {
  const keys = holdoutKeys(prefix);
  const out = {};
  for (const minTrades of minTradesOptions) {
    out[minTrades] = {};
    for (const thr of thresholds) {
      const candidates = [];
      for (const st of strategies) {
        const trades = safeNum(st?.[keys.trades], 0);
        if (trades < minTrades) continue;
        if (!guarantee(st, thr, { prefix })) continue;
        candidates.push(st);
      }
      candidates.sort(compareStrategiesByHoldout(prefix));
      const top3 = candidates.slice(0, 3);
      const best = bestByTradesPerDay(candidates, prefix);
      out[minTrades][thr] = {
        prefix,
        minTrades,
        threshold: thr,
        candidates: candidates.length,
        best: best
          ? {
              signature: best.signature,
              trades: safeNum(best?.[keys.trades], 0),
              wins: safeNum(best?.[keys.wins], 0),
              winRate: safeNum(best?.[keys.winRate], null),
              winRateLCB: safeNum(best?.[keys.winRateLCB], null),
              tradesPerDay: safeNum(best?.[keys.tradesPerDay], null),
              posterior: extra.posteriorFn ? extra.posteriorFn(best, thr) : null
            }
          : null,
        top3: top3.map(s => ({
          signature: s.signature,
          trades: safeNum(s?.[keys.trades], 0),
          wins: safeNum(s?.[keys.wins], 0),
          winRate: safeNum(s?.[keys.winRate], null),
          winRateLCB: safeNum(s?.[keys.winRateLCB], null),
          tradesPerDay: safeNum(s?.[keys.tradesPerDay], null),
          posterior: extra.posteriorFn ? extra.posteriorFn(s, thr) : null
        }))
      };
    }
  }
  return out;
}

function renderFrontierTable(cells, thresholds, minTradesOptions, formatCell) {
  const header = ['minTrades', ...thresholds.map(t => `>=${(t * 100).toFixed(0)}%`)];
  const rows = [header];
  for (const m of minTradesOptions) {
    const row = [String(m)];
    for (const t of thresholds) {
      row.push(formatCell(cells?.[m]?.[t] || null));
    }
    rows.push(row);
  }
  const widths = header.map((_, i) => {
    let w = 0;
    for (const r of rows) w = Math.max(w, String(r[i] || '').length);
    return w;
  });
  const lines = rows.map(r => r.map((c, i) => String(c || '').padEnd(widths[i])).join('  '));
  return lines.join('\n');
}

function printTop3(cells, thresholds, minTradesOptions, prefix, opts = {}) {
  if (!opts.showTop3) return;
  for (const m of minTradesOptions) {
    for (const t of thresholds) {
      const cell = cells?.[m]?.[t];
      if (!cell || !Array.isArray(cell.top3) || cell.top3.length === 0) continue;
      const parts = cell.top3.map(s => {
        const post = Number.isFinite(s.posterior) ? ` post=${fmtPosterior(s.posterior, 4)}` : '';
        return `${s.signature} tpd=${fmtNum(s.tradesPerDay, 4)} n=${s.trades} wr=${fmtPct(s.winRate, 2)} lcb=${fmtPct(s.winRateLCB, 2)}${post}`;
      });
      console.log(`${prefix} minTrades=${m} thr>=${(t * 100).toFixed(0)}% top3: ${parts.join(' | ')}`);
    }
  }
}

function buildSignatureMap(strategies) {
  const m = new Map();
  for (const st of strategies) {
    if (!st || !st.signature) continue;
    if (!m.has(st.signature)) m.set(st.signature, st);
  }
  return m;
}

function verifyAgainstValidated(validatedStrategies, strategyIndex) {
  if (!Array.isArray(validatedStrategies) || validatedStrategies.length === 0) return { ok: true, checked: 0, mismatches: [] };
  const bySig = buildSignatureMap(strategyIndex.all);
  const mismatches = [];

  for (const v of validatedStrategies) {
    const sig = strategySignature(v);
    const st = bySig.get(sig);
    if (!st) {
      mismatches.push({ signature: sig, reason: 'missing_in_computed' });
      continue;
    }
    const vTrades = safeNum(v?.valTrades, null);
    const vWins = safeNum(v?.valWins, null);
    const cTrades = safeNum(st?.valTrades, null);
    const cWins = safeNum(st?.valWins, null);
    if (vTrades !== cTrades || vWins !== cWins) {
      mismatches.push({
        signature: sig,
        reason: 'val_counts_mismatch',
        expected: { valTrades: vTrades, valWins: vWins },
        got: { valTrades: cTrades, valWins: cWins }
      });
      continue;
    }
    const vLCB = safeNum(v?.valWinRateLCB, null);
    const cLCB = safeNum(st?.valWinRateLCB, null);
    if (vLCB !== null && cLCB !== null && Math.abs(vLCB - cLCB) > 1e-12) {
      mismatches.push({
        signature: sig,
        reason: 'val_lcb_mismatch',
        expected: { valWinRateLCB: vLCB },
        got: { valWinRateLCB: cLCB }
      });
    }
  }

  return { ok: mismatches.length === 0, checked: validatedStrategies.length, mismatches };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const repoRoot = path.join(__dirname, '..');
  const analysisDir = path.join(repoRoot, 'exhaustive_analysis');

  const finalResultsPath = path.join(analysisDir, 'final_results.json');
  const datasetPath = path.join(analysisDir, 'decision_dataset.json');
  const validatedPath = path.join(analysisDir, 'strategies_validated.json');

  if (!fs.existsSync(finalResultsPath)) {
    throw new Error(`Missing: ${finalResultsPath}`);
  }
  if (!fs.existsSync(datasetPath)) {
    throw new Error(`Missing: ${datasetPath}`);
  }

  const finalResults = readJsonFile(finalResultsPath);
  const rawStrategies = Array.isArray(finalResults?.strategies) ? finalResults.strategies : [];
  const trainRatio = safeNum(finalResults?.datasetSplit?.trainRatio, 0.6);
  const valRatio = safeNum(finalResults?.datasetSplit?.valRatio, 0.2);

  console.log('Guarantee Frontier Tables');
  console.log(`Strategies (raw): ${rawStrategies.length}`);
  console.log(`Dataset: ${path.relative(repoRoot, datasetPath)}`);
  console.log(`Split: train=${trainRatio} val=${valRatio}`);
  console.log('');

  const strategyIndex = buildStrategyIndex(rawStrategies);
  console.log(`Strategies (UP/DOWN): ${strategyIndex.all.length}`);
  console.log('');

  console.time('split_markets');
  const split = await buildMarketSlugSplits(datasetPath, trainRatio, valRatio, { logEvery: args.logEvery });
  console.timeEnd('split_markets');
  console.log(`Markets: ${split.markets.length}`);
  console.log(`Val markets: ${split.valSlugs.size}`);
  console.log(`Test markets: ${split.testSlugs.size}`);
  console.log('');

  console.time('eval_holdouts');
  const evalInfo = await evaluateStrategiesOnHoldouts(datasetPath, split, strategyIndex, { logEvery: args.logEvery });
  console.timeEnd('eval_holdouts');
  console.log(`Val rows: ${evalInfo.valRows}  Test rows: ${evalInfo.testRows}`);
  console.log(`Val days: ${fmtNum(evalInfo.valDays, 4)}  Test days: ${fmtNum(evalInfo.testDays, 4)}`);
  console.log('');

  if (args.verify && fs.existsSync(validatedPath)) {
    const validated = readJsonFile(validatedPath);
    const v = verifyAgainstValidated(validated, strategyIndex);
    if (!v.ok) {
      console.log(`VERIFY: FAIL (checked=${v.checked} mismatches=${v.mismatches.length})`);
      console.log(JSON.stringify(v.mismatches.slice(0, 10), null, 2));
      if (v.mismatches.length > 10) console.log(`...and ${v.mismatches.length - 10} more`);
      console.log('');
    } else {
      console.log(`VERIFY: PASS (checked=${v.checked})`);
      console.log('');
    }
  }

  const strategies = strategyIndex.all;

  const report = {
    generatedAt: new Date().toISOString(),
    paths: {
      finalResults: path.relative(repoRoot, finalResultsPath),
      decisionDataset: path.relative(repoRoot, datasetPath),
      strategiesValidated: fs.existsSync(validatedPath) ? path.relative(repoRoot, validatedPath) : null
    },
    split: {
      trainRatio,
      valRatio,
      markets: split.markets.length,
      valMarkets: split.valSlugs.size,
      testMarkets: split.testSlugs.size
    },
    evalInfo,
    frontiers: {
      valSelected: {},
      testOnly: {}
    }
  };

  function guaranteeObserved(st, thr, ctx) {
    const keys = holdoutKeys(ctx.prefix);
    const wr = safeNum(st?.[keys.winRate], null);
    return wr !== null && wr >= thr;
  }

  function guaranteeWilson(st, thr, ctx) {
    const keys = holdoutKeys(ctx.prefix);
    const lcb = safeNum(st?.[keys.winRateLCB], null);
    return lcb !== null && lcb >= thr;
  }

  function makeGuaranteeBayes(priorA, priorB, cutoff) {
    return (st, thr, ctx) => {
      const keys = holdoutKeys(ctx.prefix);
      const wins = safeNum(st?.[keys.wins], 0);
      const trades = safeNum(st?.[keys.trades], 0);
      if (trades <= 0) return false;
      const p = posteriorProbWinRateAtLeast(wins, trades, thr, priorA, priorB);
      return Number.isFinite(p) && p >= cutoff;
    };
  }

  function makePosteriorFn(prefix, priorA, priorB) {
    const keys = holdoutKeys(prefix);
    return (st, thr) => {
      const wins = safeNum(st?.[keys.wins], 0);
      const trades = safeNum(st?.[keys.trades], 0);
      if (trades <= 0) return null;
      const p = posteriorProbWinRateAtLeast(wins, trades, thr, priorA, priorB);
      return Number.isFinite(p) ? p : null;
    };
  }

  function cellFmtValSelected(cell) {
    if (!cell || !cell.best) return 'n/a';
    const sig = cell.best.signature;
    const st = buildSignatureMap(strategies).get(sig);
    const valTPD = safeNum(cell.best.tradesPerDay, null);
    const testTPD = safeNum(st?.testTradesPerDay, null);
    if (!Number.isFinite(valTPD)) return 'n/a';
    if (Number.isFinite(testTPD)) return `${fmtNum(valTPD, 4)}/${fmtNum(testTPD, 4)}`;
    return fmtNum(valTPD, 4);
  }

  function cellFmtSinglePrefix(cell) {
    if (!cell || !cell.best) return 'n/a';
    const tpd = safeNum(cell.best.tradesPerDay, null);
    return Number.isFinite(tpd) ? fmtNum(tpd, 4) : 'n/a';
  }

  console.log('VAL-SELECTED FRONTIERS (cell = valTradesPerDay / testTradesPerDay for chosen strategy)');
  console.log('');

  const valObserved = computeFrontierCells(strategies, 'val', guaranteeObserved, MIN_TRADES_OPTIONS, WIN_RATE_THRESHOLDS);
  report.frontiers.valSelected.observed = valObserved;
  console.log('Observed Win Rate');
  console.log(renderFrontierTable(valObserved, WIN_RATE_THRESHOLDS, MIN_TRADES_OPTIONS, cellFmtValSelected));
  console.log('');
  printTop3(valObserved, WIN_RATE_THRESHOLDS, MIN_TRADES_OPTIONS, 'VAL_OBS', { showTop3: args.showTop3 });
  console.log('');

  const valWilson = computeFrontierCells(strategies, 'val', guaranteeWilson, MIN_TRADES_OPTIONS, WILSON_LCB_THRESHOLDS);
  report.frontiers.valSelected.wilsonLCB = valWilson;
  console.log('Wilson LCB');
  console.log(renderFrontierTable(valWilson, WILSON_LCB_THRESHOLDS, MIN_TRADES_OPTIONS, cellFmtValSelected));
  console.log('');
  printTop3(valWilson, WILSON_LCB_THRESHOLDS, MIN_TRADES_OPTIONS, 'VAL_WILSON', { showTop3: args.showTop3 });
  console.log('');

  report.frontiers.valSelected.bayes = {};
  for (const prior of BAYES_PRIORS) {
    for (const cutoff of BAYES_P_CUTOFFS) {
      const key = `${prior.key}|${cutoff}`;
      const guarantee = makeGuaranteeBayes(prior.a, prior.b, cutoff);
      const posteriorFn = makePosteriorFn('val', prior.a, prior.b);
      const valBayes = computeFrontierCells(
        strategies,
        'val',
        guarantee,
        MIN_TRADES_OPTIONS,
        WIN_RATE_THRESHOLDS,
        { posteriorFn }
      );
      report.frontiers.valSelected.bayes[key] = { prior: prior.label, cutoff, cells: valBayes };
      console.log(`Bayesian Posterior  prior=${prior.label}  cutoff>=${cutoff}`);
      console.log(renderFrontierTable(valBayes, WIN_RATE_THRESHOLDS, MIN_TRADES_OPTIONS, cellFmtValSelected));
      console.log('');
      printTop3(valBayes, WIN_RATE_THRESHOLDS, MIN_TRADES_OPTIONS, `VAL_BAYES(${prior.key},${cutoff})`, {
        showTop3: args.showTop3
      });
      console.log('');
    }
  }

  console.log('TEST-ONLY FRONTIERS (cell = testTradesPerDay)');
  console.log('');

  const testObserved = computeFrontierCells(strategies, 'test', guaranteeObserved, MIN_TRADES_OPTIONS, WIN_RATE_THRESHOLDS);
  report.frontiers.testOnly.observed = testObserved;
  console.log('Observed Win Rate');
  console.log(renderFrontierTable(testObserved, WIN_RATE_THRESHOLDS, MIN_TRADES_OPTIONS, cellFmtSinglePrefix));
  console.log('');
  printTop3(testObserved, WIN_RATE_THRESHOLDS, MIN_TRADES_OPTIONS, 'TEST_OBS', { showTop3: args.showTop3 });
  console.log('');

  const testWilson = computeFrontierCells(strategies, 'test', guaranteeWilson, MIN_TRADES_OPTIONS, WILSON_LCB_THRESHOLDS);
  report.frontiers.testOnly.wilsonLCB = testWilson;
  console.log('Wilson LCB');
  console.log(renderFrontierTable(testWilson, WILSON_LCB_THRESHOLDS, MIN_TRADES_OPTIONS, cellFmtSinglePrefix));
  console.log('');
  printTop3(testWilson, WILSON_LCB_THRESHOLDS, MIN_TRADES_OPTIONS, 'TEST_WILSON', { showTop3: args.showTop3 });
  console.log('');

  report.frontiers.testOnly.bayes = {};
  for (const prior of BAYES_PRIORS) {
    for (const cutoff of BAYES_P_CUTOFFS) {
      const key = `${prior.key}|${cutoff}`;
      const guarantee = makeGuaranteeBayes(prior.a, prior.b, cutoff);
      const posteriorFn = makePosteriorFn('test', prior.a, prior.b);
      const testBayes = computeFrontierCells(
        strategies,
        'test',
        guarantee,
        MIN_TRADES_OPTIONS,
        WIN_RATE_THRESHOLDS,
        { posteriorFn }
      );
      report.frontiers.testOnly.bayes[key] = { prior: prior.label, cutoff, cells: testBayes };
      console.log(`Bayesian Posterior  prior=${prior.label}  cutoff>=${cutoff}`);
      console.log(renderFrontierTable(testBayes, WIN_RATE_THRESHOLDS, MIN_TRADES_OPTIONS, cellFmtSinglePrefix));
      console.log('');
      printTop3(testBayes, WIN_RATE_THRESHOLDS, MIN_TRADES_OPTIONS, `TEST_BAYES(${prior.key},${cutoff})`, {
        showTop3: args.showTop3
      });
      console.log('');
    }
  }

  if (args.out) {
    const outPath = path.isAbsolute(args.out) ? args.out : path.join(repoRoot, args.out);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
    console.log(`Wrote: ${outPath}`);
  }
}

main().catch(err => {
  console.error('Fatal:', String(err && err.stack ? err.stack : err));
  process.exit(1);
});
