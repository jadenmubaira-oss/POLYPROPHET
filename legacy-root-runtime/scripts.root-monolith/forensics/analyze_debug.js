/**
 * PolyProphet Forensics — Debug Corpus Analyzer
 *
 * Deterministically ingests ALL JSON files in /debug (no sampling) and outputs:
 * - cycle-level signal accuracy (from debug exports)
 * - trade-level outcomes (from tradeHistory snapshots)
 * - gating reasons (from live_gates snapshots if present)
 * - file-level integrity metadata (bytes + sha256)
 *
 * Usage:
 *   node scripts/forensics/analyze_debug.js
 *   node scripts/forensics/analyze_debug.js --out docs/forensics/DEBUG_CORPUS_REPORT_v96.json
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function sha256File(filePath) {
  const buf = fs.readFileSync(filePath);
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function safeJsonParse(filePath) {
  try {
    let raw = fs.readFileSync(filePath, 'utf8');
    // Some debug exports are written with a UTF-8 BOM. JSON.parse does not accept BOM.
    if (raw && raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
    return { ok: true, value: JSON.parse(raw), rawBytes: Buffer.byteLength(raw, 'utf8') };
  } catch (e) {
    return { ok: false, error: String(e && e.message ? e.message : e) };
  }
}

function listJsonFiles(dir) {
  const out = [];
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop();
    const entries = fs.readdirSync(d, { withFileTypes: true });
    for (const ent of entries) {
      const full = path.join(d, ent.name);
      if (ent.isDirectory()) stack.push(full);
      else if (ent.isFile() && ent.name.toLowerCase().endsWith('.json')) out.push(full);
    }
  }
  out.sort();
  return out;
}

function median(values) {
  const arr = values.slice().sort((a, b) => a - b);
  if (arr.length === 0) return null;
  const mid = Math.floor(arr.length / 2);
  return arr.length % 2 ? arr[mid] : (arr[mid - 1] + arr[mid]) / 2;
}

function toNum(x) {
  const n = typeof x === 'number' ? x : parseFloat(x);
  return Number.isFinite(n) ? n : null;
}

function bucketEntryPrice(entry) {
  const p = toNum(entry);
  if (p === null) return 'unknown';
  if (p < 0.2) return '<20¢';
  if (p < 0.5) return '20–50¢';
  if (p < 0.8) return '50–80¢';
  if (p < 0.95) return '80–95¢';
  return '95–100¢';
}

function classifyTier(t) {
  const s = String(t || '').toUpperCase();
  if (s === 'CONVICTION') return 'CONVICTION';
  if (s === 'ADVISORY') return 'ADVISORY';
  if (s === 'NONE') return 'NONE';
  return 'UNKNOWN';
}

function inferTradeWin(trade) {
  // Prefer explicit exit 0/1 if present
  const exit = toNum(trade && trade.exit);
  if (exit === 1) return { outcome: 'WIN' };
  if (exit === 0) return { outcome: 'LOSS' };

  // Fallback to pnl
  const pnl = toNum(trade && trade.pnl);
  if (pnl !== null) {
    if (pnl > 0) return { outcome: 'WIN' };
    if (pnl < 0) return { outcome: 'LOSS' };
    return { outcome: 'FLAT' };
  }

  return { outcome: 'UNKNOWN' };
}

function cycleKeyFor(asset, cycleEndTime) {
  if (!cycleEndTime) return null;
  const ms = Date.parse(String(cycleEndTime));
  if (!Number.isFinite(ms)) return `${asset}|${String(cycleEndTime)}`;
  // Canonicalize to the 15-minute boundary (900s) to de-dupe exports that differ only by milliseconds.
  const rounded = Math.floor(ms / 900000) * 900000;
  return `${asset}|${rounded}`;
}

function main() {
  const args = process.argv.slice(2);
  const outIdx = args.indexOf('--out');
  const outPath = outIdx >= 0 ? args[outIdx + 1] : path.join('docs', 'forensics', 'DEBUG_CORPUS_REPORT_v96.json');

  const repoRoot = process.cwd();
  const debugDir = path.join(repoRoot, 'debug');
  if (!fs.existsSync(debugDir)) {
    console.error('Missing debug dir:', debugDir);
    process.exit(1);
  }

  const files = listJsonFiles(debugDir);
  const report = {
    generatedAt: new Date().toISOString(),
    debugDir: path.relative(repoRoot, debugDir),
    fileCount: files.length,
    parseErrors: [],
    files: [],
    summaries: {
      cycles: {
        dedupe: { key: 'asset|floor(Date.parse(cycleEndTime)/900000)*900000', unique: 0 },
        byTier: { CONVICTION: { n: 0, correct: 0 }, ADVISORY: { n: 0, correct: 0 }, NONE: { n: 0, correct: 0 }, UNKNOWN: { n: 0, correct: 0 } },
        byAsset: {},
        overall: { n: 0, correct: 0 },
        missed: {
          // Tier=NONE but would have been correct (missed winners if we had traded everything)
          noneButCorrect: 0,
          // Tier in {CONVICTION, ADVISORY} but incorrect (bad signals in "would-trade" tiers)
          tradeTierButIncorrect: 0
        }
      },
      trades: {
        uniqueTrades: 0,
        closedTrades: 0,
        wins: 0,
        losses: 0,
        flats: 0,
        unknown: 0,
        byTier: {
          CONVICTION: { n: 0, wins: 0, losses: 0, flats: 0, unknown: 0, winRate: null },
          ADVISORY: { n: 0, wins: 0, losses: 0, flats: 0, unknown: 0, winRate: null },
          NONE: { n: 0, wins: 0, losses: 0, flats: 0, unknown: 0, winRate: null },
          UNKNOWN: { n: 0, wins: 0, losses: 0, flats: 0, unknown: 0, winRate: null }
        },
        byAsset: {},
        byEntryBucket: { '<20¢': 0, '20–50¢': 0, '50–80¢': 0, '80–95¢': 0, '95–100¢': 0, unknown: 0 },
        pnl: { total: 0, mean: null, median: null },
        reasons: {
          // Top-level histogram of trade close reasons (string match; non-normalized)
          totalUniqueReasons: 0,
          top: []
        },
        oracleResolved: {
          // Only ORACLE trades that resolved to binary outcome (exit 0/1)
          n: 0,
          wins: 0,
          losses: 0,
          winRate: null,
          byTier: {
            CONVICTION: { n: 0, wins: 0, losses: 0, winRate: null },
            ADVISORY: { n: 0, wins: 0, losses: 0, winRate: null },
            NONE: { n: 0, wins: 0, losses: 0, winRate: null },
            UNKNOWN: { n: 0, wins: 0, losses: 0, winRate: null }
          },
          byAsset: {}
        }
      },
      liveGates: {
        totalEvaluations: 0,
        totalBlocked: 0,
        gateFailures: {},
        byAsset: {}
      }
    }
  };

  // Trade de-dup across files by id
  const tradeSeen = new Map(); // id -> trade snapshot (first seen)
  const pnlValues = [];
  const cycleSeen = new Set(); // asset|cycleEndEpochRoundedMs (see cycleKeyFor)

  for (const abs of files) {
    const rel = path.relative(repoRoot, abs);
    const bytes = fs.statSync(abs).size;
    const sha = sha256File(abs);
    const parsed = safeJsonParse(abs);

    const fileEntry = { path: rel, bytes, sha256: sha, ok: parsed.ok };
    if (!parsed.ok) {
      fileEntry.error = parsed.error;
      report.parseErrors.push({ path: rel, error: parsed.error });
      report.files.push(fileEntry);
      continue;
    }

    const json = parsed.value;
    // Heuristics by filename and/or keys
    const name = path.basename(rel).toLowerCase();

    // 1) PolyProphet debug exports: cycleHistory + tradeHistory
    if (name.startsWith('polyprophet_debug_') && json && typeof json === 'object') {
      // Cycle-level: per asset cycleHistory array contains wasCorrect + tier
      const assets = json.assets && typeof json.assets === 'object' ? json.assets : null;
      if (assets) {
        for (const [asset, aobj] of Object.entries(assets)) {
          if (!report.summaries.cycles.byAsset[asset]) {
            report.summaries.cycles.byAsset[asset] = { n: 0, correct: 0, byTier: { CONVICTION: { n: 0, correct: 0 }, ADVISORY: { n: 0, correct: 0 }, NONE: { n: 0, correct: 0 }, UNKNOWN: { n: 0, correct: 0 } } };
          }
          const ch = aobj && Array.isArray(aobj.cycleHistory) ? aobj.cycleHistory : [];
          for (const c of ch) {
            const cycleKey = cycleKeyFor(asset, c && c.cycleEndTime ? c.cycleEndTime : null);
            if (cycleKey && cycleSeen.has(cycleKey)) continue; // de-dupe across overlapping exports
            if (cycleKey) cycleSeen.add(cycleKey);

            const tier = classifyTier(c && c.tier);
            const wasCorrect = !!(c && c.wasCorrect);
            report.summaries.cycles.overall.n++;
            report.summaries.cycles.byTier[tier].n++;
            report.summaries.cycles.byAsset[asset].n++;
            report.summaries.cycles.byAsset[asset].byTier[tier].n++;
            if (wasCorrect) {
              report.summaries.cycles.overall.correct++;
              report.summaries.cycles.byTier[tier].correct++;
              report.summaries.cycles.byAsset[asset].correct++;
              report.summaries.cycles.byAsset[asset].byTier[tier].correct++;
            }

            // Missed/allowed accounting (signal-level, not execution-level)
            if (tier === 'NONE' && wasCorrect) report.summaries.cycles.missed.noneButCorrect++;
            if ((tier === 'CONVICTION' || tier === 'ADVISORY') && !wasCorrect) report.summaries.cycles.missed.tradeTierButIncorrect++;
          }
        }
      }

      // Trade-level: tradeExecutor.tradeHistory list
      const te = json.tradeExecutor && typeof json.tradeExecutor === 'object' ? json.tradeExecutor : null;
      const th = te && Array.isArray(te.tradeHistory) ? te.tradeHistory : [];
      for (const t of th) {
        if (!t || !t.id) continue;
        const id = String(t.id);
        if (!tradeSeen.has(id)) {
          tradeSeen.set(id, { firstSeenIn: rel, trade: t });
        }
      }
    }

    // 2) live_gates snapshots: gateFailures + traces (used for trade-block reasons)
    if (name.startsWith('live_gates_') && json && typeof json === 'object') {
      const s = json.summary || {};
      if (Number.isFinite(s.totalEvaluations)) report.summaries.liveGates.totalEvaluations += s.totalEvaluations;
      if (Number.isFinite(s.totalBlocked)) report.summaries.liveGates.totalBlocked += s.totalBlocked;
      if (s.gateFailures && typeof s.gateFailures === 'object') {
        for (const [k, v] of Object.entries(s.gateFailures)) {
          const n = toNum(v);
          if (n === null) continue;
          report.summaries.liveGates.gateFailures[k] = (report.summaries.liveGates.gateFailures[k] || 0) + n;
        }
      }
      if (s.byAsset && typeof s.byAsset === 'object') {
        for (const [asset, a] of Object.entries(s.byAsset)) {
          if (!report.summaries.liveGates.byAsset[asset]) {
            report.summaries.liveGates.byAsset[asset] = { evaluations: 0, blocked: 0, traded: 0, failedGates: {} };
          }
          const dst = report.summaries.liveGates.byAsset[asset];
          dst.evaluations += toNum(a.evaluations) || 0;
          dst.blocked += toNum(a.blocked) || 0;
          dst.traded += toNum(a.traded) || 0;
          if (a.failedGates && typeof a.failedGates === 'object') {
            for (const [k, v] of Object.entries(a.failedGates)) {
              const n = toNum(v);
              if (n === null) continue;
              dst.failedGates[k] = (dst.failedGates[k] || 0) + n;
            }
          }
        }
      }
    }

    report.files.push(fileEntry);
  }

  // Summarize trades
  report.summaries.trades.uniqueTrades = tradeSeen.size;
  const reasonCounts = new Map();
  for (const [id, rec] of tradeSeen.entries()) {
    const t = rec.trade;
    const status = String(t.status || '').toUpperCase();
    const asset = String(t.asset || 'UNKNOWN');
    const tier = classifyTier(t.tier);
    const entry = toNum(t.entry);

    if (!report.summaries.trades.byAsset[asset]) {
      report.summaries.trades.byAsset[asset] = { n: 0, wins: 0, losses: 0, flats: 0, unknown: 0 };
    }
    report.summaries.trades.byAsset[asset].n++;
    report.summaries.trades.byTier[tier].n++;

    const bucket = bucketEntryPrice(entry);
    report.summaries.trades.byEntryBucket[bucket] = (report.summaries.trades.byEntryBucket[bucket] || 0) + 1;

    if (status === 'CLOSED' || status === 'CRASH_RECOVERED') {
      report.summaries.trades.closedTrades++;
    }

    const o = inferTradeWin(t);
    if (o.outcome === 'WIN') {
      report.summaries.trades.wins++;
      report.summaries.trades.byAsset[asset].wins++;
      report.summaries.trades.byTier[tier].wins++;
    } else if (o.outcome === 'LOSS') {
      report.summaries.trades.losses++;
      report.summaries.trades.byAsset[asset].losses++;
      report.summaries.trades.byTier[tier].losses++;
    } else if (o.outcome === 'FLAT') {
      report.summaries.trades.flats++;
      report.summaries.trades.byAsset[asset].flats++;
      report.summaries.trades.byTier[tier].flats++;
    } else {
      report.summaries.trades.unknown++;
      report.summaries.trades.byAsset[asset].unknown++;
      report.summaries.trades.byTier[tier].unknown++;
    }

    const pnl = toNum(t.pnl);
    if (pnl !== null) {
      report.summaries.trades.pnl.total += pnl;
      pnlValues.push(pnl);
    }

    // Reason histogram (only meaningful for CLOSED-like trades)
    if (status === 'CLOSED' || status === 'CRASH_RECOVERED') {
      const r = t.reason ? String(t.reason) : 'UNKNOWN';
      reasonCounts.set(r, (reasonCounts.get(r) || 0) + 1);
    }

    // ORACLE resolved-only stats (prediction purity; excludes early exits)
    const mode = String(t.mode || '').toUpperCase();
    const exit = toNum(t.exit);
    const isResolvedBinary = exit === 0 || exit === 1;
    if (mode === 'ORACLE' && isResolvedBinary) {
      if (!report.summaries.trades.oracleResolved.byAsset[asset]) {
        report.summaries.trades.oracleResolved.byAsset[asset] = { n: 0, wins: 0, losses: 0, winRate: null };
      }
      report.summaries.trades.oracleResolved.n++;
      report.summaries.trades.oracleResolved.byTier[tier].n++;
      report.summaries.trades.oracleResolved.byAsset[asset].n++;
      if (exit === 1) {
        report.summaries.trades.oracleResolved.wins++;
        report.summaries.trades.oracleResolved.byTier[tier].wins++;
        report.summaries.trades.oracleResolved.byAsset[asset].wins++;
      } else {
        report.summaries.trades.oracleResolved.losses++;
        report.summaries.trades.oracleResolved.byTier[tier].losses++;
        report.summaries.trades.oracleResolved.byAsset[asset].losses++;
      }
    }
  }

  if (pnlValues.length > 0) {
    report.summaries.trades.pnl.mean = report.summaries.trades.pnl.total / pnlValues.length;
    report.summaries.trades.pnl.median = median(pnlValues);
  }

  // Compute accuracies
  report.summaries.cycles.dedupe.unique = cycleSeen.size;
  report.summaries.cycles.overall.accuracy = report.summaries.cycles.overall.n > 0
    ? report.summaries.cycles.overall.correct / report.summaries.cycles.overall.n
    : null;
  for (const [tier, v] of Object.entries(report.summaries.cycles.byTier)) {
    v.accuracy = v.n > 0 ? v.correct / v.n : null;
  }
  for (const [asset, v] of Object.entries(report.summaries.cycles.byAsset)) {
    v.accuracy = v.n > 0 ? v.correct / v.n : null;
    for (const [tier, t] of Object.entries(v.byTier)) {
      t.accuracy = t.n > 0 ? t.correct / t.n : null;
    }
  }

  report.summaries.trades.winRate = report.summaries.trades.closedTrades > 0
    ? report.summaries.trades.wins / report.summaries.trades.closedTrades
    : null;

  // Per-tier win rates (trade-level, based on closedTrades within tier)
  for (const [tier, v] of Object.entries(report.summaries.trades.byTier)) {
    const denom = v.wins + v.losses + v.flats;
    v.winRate = denom > 0 ? v.wins / denom : null;
  }

  // Top close reasons
  const reasonsSorted = Array.from(reasonCounts.entries()).sort((a, b) => b[1] - a[1]);
  report.summaries.trades.reasons.totalUniqueReasons = reasonsSorted.length;
  report.summaries.trades.reasons.top = reasonsSorted.slice(0, 25).map(([reason, count]) => ({ reason, count }));

  // Oracle-resolved win rates
  report.summaries.trades.oracleResolved.winRate = report.summaries.trades.oracleResolved.n > 0
    ? report.summaries.trades.oracleResolved.wins / report.summaries.trades.oracleResolved.n
    : null;
  for (const [tier, v] of Object.entries(report.summaries.trades.oracleResolved.byTier)) {
    v.winRate = v.n > 0 ? v.wins / v.n : null;
  }
  for (const [asset, v] of Object.entries(report.summaries.trades.oracleResolved.byAsset)) {
    v.winRate = v.n > 0 ? v.wins / v.n : null;
  }

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
  console.log('Wrote:', outPath);
  console.log('Files:', report.fileCount, '| Parse errors:', report.parseErrors.length);
  console.log('Unique trades:', report.summaries.trades.uniqueTrades, '| Closed:', report.summaries.trades.closedTrades, '| WinRate:', report.summaries.trades.winRate);
  console.log('Cycle accuracy:', report.summaries.cycles.overall.accuracy);
}

main();

