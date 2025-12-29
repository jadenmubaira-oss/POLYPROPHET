/**
 * Analyze debug logs' trade history deterministically (no Monte Carlo).
 *
 * - Scans ./debug/polyprophet_debug_*.json
 * - Extracts trades from known locations (tradeExecutor.tradeHistory, _trading.tradeHistory, etc)
 * - De-dupes by trade id
 * - Outputs summary stats and top outliers to stdout
 *
 * Usage:
 *   node tools/analyze_debug_trades.js
 */

const fs = require("fs");
const path = require("path");

function safeNumber(x) {
  const n = Number(x);
  return Number.isFinite(n) ? n : 0;
}

function getTradeHistory(log) {
  const candidates = [
    log?.tradeExecutor?.tradeHistory,
    log?._trading?.tradeHistory,
    log?.trading?.tradeHistory,
    log?.tradeHistory,
  ];
  for (const c of candidates) {
    if (Array.isArray(c)) return c;
  }
  return [];
}

function parseTimeMs(t) {
  if (!t) return null;
  if (typeof t === "number") return t;
  const ms = Date.parse(t);
  return Number.isFinite(ms) ? ms : null;
}

function main() {
  const debugDir = path.join(process.cwd(), "debug");
  const files = fs
    .readdirSync(debugDir)
    .filter((f) => f.startsWith("polyprophet_debug_") && f.endsWith(".json"))
    .sort();

  const tradesById = new Map();
  const parseErrors = [];

  for (const f of files) {
    const full = path.join(debugDir, f);
    let log;
    try {
      log = JSON.parse(fs.readFileSync(full, "utf8"));
    } catch (e) {
      parseErrors.push({ file: f, error: String(e?.message || e) });
      continue;
    }

    const th = getTradeHistory(log);
    for (const t of th) {
      const id = t?.id;
      if (!id) continue;
      if (!tradesById.has(id)) {
        tradesById.set(id, {
          ...t,
          _firstSeenIn: f,
        });
      } else {
        // prefer the most complete record (closed > open; has exit/pnl)
        const prev = tradesById.get(id);
        const prevClosed = prev?.status === "CLOSED" || prev?.exit !== undefined || prev?.closeTime;
        const curClosed = t?.status === "CLOSED" || t?.exit !== undefined || t?.closeTime;
        if (!prevClosed && curClosed) {
          tradesById.set(id, { ...t, _firstSeenIn: prev._firstSeenIn });
        }
      }
    }
  }

  const trades = Array.from(tradesById.values());
  const closed = trades.filter((t) => t.status === "CLOSED" || t.exit !== undefined || t.closeTime);

  // Normalize times
  for (const t of closed) {
    t._openMs = parseTimeMs(t.time) ?? parseTimeMs(t.openTime) ?? null;
    t._closeMs = parseTimeMs(t.closeTime) ?? null;
  }

  const wins = closed.filter((t) => safeNumber(t.pnl) > 0).length;
  const losses = closed.filter((t) => safeNumber(t.pnl) < 0).length;
  const flats = closed.length - wins - losses;
  const totalPnl = closed.reduce((s, t) => s + safeNumber(t.pnl), 0);

  const sortedPnL = closed
    .map((t) => safeNumber(t.pnl))
    .sort((a, b) => a - b);
  const medianPnl =
    sortedPnL.length === 0
      ? 0
      : sortedPnL.length % 2 === 1
        ? sortedPnL[(sortedPnL.length - 1) / 2]
        : (sortedPnL[sortedPnL.length / 2 - 1] + sortedPnL[sortedPnL.length / 2]) / 2;

  const byEntryBucket = {
    "<20¢": 0,
    "20–50¢": 0,
    "50–80¢": 0,
    "80–95¢": 0,
    "95–100¢": 0,
    "unknown": 0,
  };

  for (const t of closed) {
    const entry = safeNumber(t.entry);
    if (entry <= 0) {
      byEntryBucket.unknown += 1;
    } else if (entry < 0.2) byEntryBucket["<20¢"] += 1;
    else if (entry < 0.5) byEntryBucket["20–50¢"] += 1;
    else if (entry < 0.8) byEntryBucket["50–80¢"] += 1;
    else if (entry < 0.95) byEntryBucket["80–95¢"] += 1;
    else if (entry <= 1.0) byEntryBucket["95–100¢"] += 1;
    else byEntryBucket.unknown += 1;
  }

  // Outliers by absolute pnl (dollars)
  const topAbs = [...closed]
    .sort((a, b) => Math.abs(safeNumber(b.pnl)) - Math.abs(safeNumber(a.pnl)))
    .slice(0, 15)
    .map((t) => ({
      id: t.id,
      asset: t.asset,
      mode: t.mode,
      entry: t.entry,
      exit: t.exit,
      size: t.size,
      pnl: t.pnl,
      pnlPercent: t.pnlPercent,
      time: t.time,
      closeTime: t.closeTime,
      reason: t.reason,
      firstSeenIn: t._firstSeenIn,
    }));

  console.log("=== DEBUG TRADE HISTORY ANALYSIS ===");
  console.log(`files_scanned=${files.length} parse_errors=${parseErrors.length}`);
  console.log(`unique_trades=${trades.length} closed_trades=${closed.length}`);
  console.log(`wins=${wins} losses=${losses} flats=${flats} win_rate=${closed.length ? (wins / closed.length).toFixed(4) : "0.0000"}`);
  console.log(`total_pnl=${totalPnl.toFixed(6)} median_pnl=${medianPnl.toFixed(6)}`);
  console.log("by_entry_bucket:", byEntryBucket);
  console.log("");
  console.log("top_abs_pnl (first 15):");
  console.log(JSON.stringify(topAbs, null, 2));

  if (parseErrors.length) {
    console.log("");
    console.log("parse_errors (first 10):");
    console.log(JSON.stringify(parseErrors.slice(0, 10), null, 2));
  }
}

main();


