const fs = require('fs');
const path = require('path');

function toNum(x) {
  const n = typeof x === 'number' ? x : parseFloat(x);
  return Number.isFinite(n) ? n : null;
}

function dayKeyUtc(epochSec) {
  if (!Number.isFinite(epochSec)) return null;
  return new Date(epochSec * 1000).toISOString().slice(0, 10);
}

function strategySignature(s) {
  const min = toNum(s?.priceBand?.min);
  const max = toNum(s?.priceBand?.max);
  return `${s?.entryMinute}|${s?.utcHour}|${String(s?.direction || '').toUpperCase()}|${min}|${max}`;
}

function normalizeStrategy(s) {
  return {
    entryMinute: Number(s.entryMinute),
    utcHour: Number(s.utcHour),
    direction: String(s.direction || '').toUpperCase(),
    priceBand: {
      min: toNum(s.priceBand && s.priceBand.min),
      max: toNum(s.priceBand && s.priceBand.max)
    }
  };
}

function resolveTradeSideAndPrice(row, direction) {
  if (direction === 'UP') return { tradedUp: true, entryPrice: row.upPrice };
  if (direction === 'DOWN') return { tradedUp: false, entryPrice: row.downPrice };
  const tradedUp = row.upPrice < row.downPrice;
  return { tradedUp, entryPrice: tradedUp ? row.upPrice : row.downPrice };
}

function matchesStrategy(row, strategy) {
  if (Number(row.entryMinute) !== strategy.entryMinute) return null;
  if (Number(row.utcHour) !== strategy.utcHour) return null;

  const cycleStartEpochSec = Number(row.cycleStartEpochSec);
  if (!Number.isFinite(cycleStartEpochSec)) return null;

  const { tradedUp, entryPrice } = resolveTradeSideAndPrice(row, strategy.direction);
  const p = toNum(entryPrice);
  if (p === null) return null;
  if (strategy.priceBand.min === null || strategy.priceBand.max === null) return null;
  if (p < strategy.priceBand.min || p > strategy.priceBand.max) return null;

  const winnerIsUp = !!row.winnerIsUp;
  const won = tradedUp === winnerIsUp;

  return {
    slug: row.slug,
    asset: row.asset,
    cycleStartEpochSec: row.cycleStartEpochSec,
    entryEpochSec: cycleStartEpochSec + Number(row.entryMinute) * 60,
    entryPrice: p,
    tradedUp,
    winnerIsUp,
    won
  };
}

function inc(obj, k, by = 1) {
  const key = String(k);
  obj[key] = (obj[key] || 0) + by;
}

function sortedNumericKeys(obj) {
  return Object.keys(obj)
    .map(k => ({ k, n: Number(k) }))
    .filter(x => Number.isFinite(x.n))
    .sort((a, b) => a.n - b.n)
    .map(x => x.k);
}

function computeStreaks(trades) {
  let maxWin = 0;
  let maxLoss = 0;
  const winHist = {};
  const lossHist = {};

  let curType = null;
  let curLen = 0;

  function flush() {
    if (!curType) return;
    if (curType === 'WIN') {
      inc(winHist, curLen);
      if (curLen > maxWin) maxWin = curLen;
    } else {
      inc(lossHist, curLen);
      if (curLen > maxLoss) maxLoss = curLen;
    }
  }

  for (const t of trades) {
    const nextType = t.won ? 'WIN' : 'LOSS';
    if (nextType === curType) {
      curLen++;
    } else {
      flush();
      curType = nextType;
      curLen = 1;
    }
  }
  flush();

  const win10to20 = {};
  let winGe10 = 0;
  for (const k of sortedNumericKeys(winHist)) {
    const len = Number(k);
    const c = winHist[k];
    if (len >= 10) winGe10 += c;
    if (len >= 10 && len <= 20) win10to20[k] = c;
  }

  return { maxWin, maxLoss, winHist, lossHist, win10to20, winGe10 };
}

function computeDailyStats(trades, eligibleDaysSet) {
  const tradesByDay = {};
  for (const t of trades) {
    const d = dayKeyUtc(t.entryEpochSec);
    if (!d) continue;
    inc(tradesByDay, d);
  }

  const eligibleDaysSorted = Array.from(eligibleDaysSet).sort();

  let zeroSignalDays = 0;
  let longestZeroSignalStreak = 0;
  let curZero = 0;

  const tradesPerDayDist = {};

  for (const d of eligibleDaysSorted) {
    const c = tradesByDay[d] || 0;
    inc(tradesPerDayDist, c);
    if (c === 0) {
      zeroSignalDays++;
      curZero++;
      if (curZero > longestZeroSignalStreak) longestZeroSignalStreak = curZero;
    } else {
      curZero = 0;
    }
  }

  return {
    eligibleDays: eligibleDaysSorted.length,
    eligibleDaysSorted,
    zeroSignalDays,
    longestZeroSignalStreak,
    tradesByDay,
    tradesPerDayDist
  };
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
              reject(
                new Error(`JSON.parse failed after ${seen} objects: ${String(e && e.message ? e.message : e)}`)
              );
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

function parseArgs(argv) {
  const args = { topLCB: 0, validated: 0, logEvery: 0, out: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--topLCB') args.topLCB = parseInt(argv[++i] || '0', 10) || 0;
    else if (a === '--validated') args.validated = parseInt(argv[++i] || '0', 10) || 0;
    else if (a === '--logEvery') args.logEvery = parseInt(argv[++i] || '0', 10) || 0;
    else if (a === '--out') args.out = argv[++i] || null;
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));

  const repoRoot = path.join(__dirname, '..', '..');
  const finalPath = path.join(repoRoot, 'final_golden_strategy.json');
  const datasetPath = path.join(repoRoot, 'exhaustive_analysis', 'decision_dataset.json');

  if (!fs.existsSync(finalPath)) {
    console.error('Missing final_golden_strategy.json at:', finalPath);
    process.exit(1);
  }
  if (!fs.existsSync(datasetPath)) {
    console.error('Missing decision_dataset.json at:', datasetPath);
    process.exit(1);
  }

  const final = JSON.parse(fs.readFileSync(finalPath, 'utf8'));

  const strategies = [];
  if (final && final.goldenStrategy) {
    strategies.push({
      label: 'goldenStrategy',
      source: 'final_golden_strategy.json',
      strategy: normalizeStrategy(final.goldenStrategy),
      fromFile: final.goldenStrategy,
      trades: [],
      eligibleDays: new Set(),
      eligibleCycles: 0
    });
  }

  const topLCB = Array.isArray(final.topStrategiesByLCB) ? final.topStrategiesByLCB.slice(0, args.topLCB) : [];
  for (let i = 0; i < topLCB.length; i++) {
    strategies.push({
      label: `topLCB#${i + 1}`,
      source: 'final_golden_strategy.json.topStrategiesByLCB',
      strategy: normalizeStrategy(topLCB[i]),
      fromFile: topLCB[i],
      trades: [],
      eligibleDays: new Set(),
      eligibleCycles: 0
    });
  }

  const validated = Array.isArray(final.validatedStrategies) ? final.validatedStrategies.slice(0, args.validated) : [];
  for (let i = 0; i < validated.length; i++) {
    strategies.push({
      label: `validated#${i + 1}`,
      source: 'final_golden_strategy.json.validatedStrategies',
      strategy: normalizeStrategy(validated[i]),
      fromFile: validated[i],
      trades: [],
      eligibleDays: new Set(),
      eligibleCycles: 0
    });
  }

  if (strategies.length === 0) {
    console.error('No strategies found in final_golden_strategy.json');
    process.exit(1);
  }

  console.log('Forensics: golden strategy streaks');
  console.log('Strategies:', strategies.length);
  console.log('Dataset:', datasetPath);
  console.log('');

  return streamJsonArrayObjects(
    datasetPath,
    row => {
      if (!row || typeof row !== 'object') return;

      const entryMinute = Number(row.entryMinute);
      const utcHour = Number(row.utcHour);
      const cycleStart = Number(row.cycleStartEpochSec);
      if (!Number.isFinite(entryMinute) || !Number.isFinite(utcHour) || !Number.isFinite(cycleStart)) return;

      for (const st of strategies) {
        if (entryMinute === st.strategy.entryMinute && utcHour === st.strategy.utcHour) {
          const entryEpochSec = cycleStart + entryMinute * 60;
          const d = dayKeyUtc(entryEpochSec);
          if (d) st.eligibleDays.add(d);
          st.eligibleCycles++;

          const trade = matchesStrategy(row, st.strategy);
          if (trade) st.trades.push(trade);
        }
      }
    },
    { logEvery: args.logEvery }
  ).then(totalRows => {
    const report = {
      generatedAt: new Date().toISOString(),
      totalRows,
      paths: {
        decisionDataset: path.relative(repoRoot, datasetPath),
        finalGoldenStrategy: path.relative(repoRoot, finalPath)
      },
      strategies: []
    };

    for (const st of strategies) {
      st.trades.sort((a, b) => a.entryEpochSec - b.entryEpochSec || String(a.slug).localeCompare(String(b.slug)));
      const wins = st.trades.reduce((acc, t) => acc + (t.won ? 1 : 0), 0);
      const losses = st.trades.length - wins;
      const winRate = st.trades.length ? wins / st.trades.length : null;

      const streaks = computeStreaks(st.trades);
      const daily = computeDailyStats(st.trades, st.eligibleDays);

      const minEpoch = st.trades.length ? st.trades[0].entryEpochSec : null;
      const maxEpoch = st.trades.length ? st.trades[st.trades.length - 1].entryEpochSec : null;
      const spanDays =
        minEpoch !== null && maxEpoch !== null && maxEpoch > minEpoch ? (maxEpoch - minEpoch) / 86400 : null;
      const tradesPerDaySpan = spanDays && spanDays > 0 ? st.trades.length / spanDays : null;
      const tradesPerEligibleDay = daily.eligibleDays > 0 ? st.trades.length / daily.eligibleDays : null;

      const item = {
        label: st.label,
        source: st.source,
        signature: strategySignature(st.strategy),
        strategy: st.strategy,
        fromFile: st.fromFile || null,
        computed: {
          eligibleCycles: st.eligibleCycles,
          eligibleDays: daily.eligibleDays,
          trades: st.trades.length,
          wins,
          losses,
          winRate,
          tradesPerEligibleDay,
          tradesPerDaySpan,
          spanDays,
          minTradeDay: minEpoch ? dayKeyUtc(minEpoch) : null,
          maxTradeDay: maxEpoch ? dayKeyUtc(maxEpoch) : null,
          streaks,
          daily
        }
      };

      report.strategies.push(item);

      console.log('='.repeat(70));
      console.log(`${st.label}  (${item.signature})`);
      console.log(`Eligible cycles: ${st.eligibleCycles}`);
      console.log(`Eligible days: ${daily.eligibleDays}`);
      console.log(
        `Trades: ${st.trades.length}  Wins: ${wins}  Losses: ${losses}  WR: ${winRate !== null ? (winRate * 100).toFixed(2) + '%' : 'n/a'}`
      );
      console.log(
        `Zero-signal days: ${daily.zeroSignalDays}  Longest zero-signal streak: ${daily.longestZeroSignalStreak}`
      );
      console.log(`Max win streak: ${streaks.maxWin}  Max loss streak: ${streaks.maxLoss}`);
      console.log(`Win streaks >=10: ${streaks.winGe10}`);
      const tenToTwentyKeys = Object.keys(streaks.win10to20);
      if (tenToTwentyKeys.length) {
        const parts = tenToTwentyKeys
          .sort((a, b) => Number(a) - Number(b))
          .map(k => `${k}:${streaks.win10to20[k]}`);
        console.log(`Win streaks 10-20: ${parts.join(' ')}`);
      } else {
        console.log('Win streaks 10-20: none');
      }
      if (tradesPerEligibleDay !== null) console.log(`Trades/eligible-day: ${tradesPerEligibleDay.toFixed(4)}`);
      if (tradesPerDaySpan !== null) {
        console.log(`Trades/day (trade-span): ${tradesPerDaySpan.toFixed(4)} (spanDays=${spanDays.toFixed(2)})`);
      }
    }

    if (args.out) {
      const outPath = path.isAbsolute(args.out) ? args.out : path.join(repoRoot, args.out);
      fs.mkdirSync(path.dirname(outPath), { recursive: true });
      fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
      console.log('');
      console.log('Wrote report:', outPath);
    }

    return report;
  });
}

main().catch(err => {
  console.error('Fatal:', String(err && err.stack ? err.stack : err));
  process.exit(1);
});
