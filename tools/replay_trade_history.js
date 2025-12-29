/**
 * Replay historical trades from debug logs with deterministic position sizing.
 *
 * Why this exists:
 * - The debug logs include trades with very large notional sizes (after compounding).
 * - To answer "what could £5 have become", we replay the same trade *returns* (ROI),
 *   but size each trade as a fraction of *current cash* with a global exposure cap.
 *
 * This is NOT a guarantee. It assumes you can get fills at the logged entry/exit.
 *
 * Usage (defaults):
 *   node tools/replay_trade_history.js
 *
 * Options (env vars):
 *   START=5
 *   MAX_FRAC=0.25          (max fraction of available cash per new trade)
 *   MAX_EXPOSURE=0.70      (max total open exposure / equity)
 *   MIN_ORDER=1.10
 *   FEE_FRAC=0.00          (apply fee as fraction of stake on close, conservative)
 *   MIN_ENTRY=0.00         (ignore trades with entry < MIN_ENTRY)
 */

const fs = require("fs");
const path = require("path");

function num(x) {
  const n = Number(x);
  return Number.isFinite(n) ? n : 0;
}

function parseMs(t) {
  if (t == null) return null;
  if (typeof t === "number") return t;
  const ms = Date.parse(t);
  return Number.isFinite(ms) ? ms : null;
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

function loadClosedTrades(debugDir) {
  const files = fs
    .readdirSync(debugDir)
    .filter((f) => f.startsWith("polyprophet_debug_") && f.endsWith(".json"))
    .sort();

  const tradesById = new Map();

  for (const f of files) {
    const full = path.join(debugDir, f);
    let log;
    try {
      log = JSON.parse(fs.readFileSync(full, "utf8"));
    } catch {
      continue;
    }

    const th = getTradeHistory(log);
    for (const t of th) {
      const id = t?.id;
      if (!id) continue;
      const isClosed = t.status === "CLOSED" || t.exit !== undefined || t.closeTime;
      if (!isClosed) continue;
      if (!tradesById.has(id)) {
        tradesById.set(id, { ...t, _firstSeenIn: f });
      }
    }
  }

  const closed = Array.from(tradesById.values())
    .map((t) => {
      const entry = num(t.entry);
      const exit = num(t.exit);
      const roi = entry > 0 ? (exit / entry) - 1 : 0; // ROI per $1 staked
      return {
        id: t.id,
        asset: t.asset || "UNKNOWN",
        mode: t.mode || "UNKNOWN",
        tier: t.tier || "UNKNOWN",
        entry,
        exit,
        roi,
        openMs: parseMs(t.time) ?? parseMs(t.openTime) ?? null,
        closeMs: parseMs(t.closeTime) ?? null,
        reason: t.reason || null,
        firstSeenIn: t._firstSeenIn,
      };
    })
    .filter((t) => t.openMs != null && t.closeMs != null)
    .sort((a, b) => (a.openMs - b.openMs) || (a.closeMs - b.closeMs) || (a.id < b.id ? -1 : 1));

  return { filesScanned: files.length, closedTrades: closed };
}

function replay(trades, params) {
  let cash = params.start;
  const open = new Map(); // id -> { stake, roi, closeMs }

  let peakEquity = cash;
  let maxDrawdown = 0;

  const events = [];
  for (const t of trades) {
    events.push({ t: t.openMs, type: "OPEN", trade: t });
    events.push({ t: t.closeMs, type: "CLOSE", trade: t });
  }
  events.sort((a, b) => (a.t - b.t) || (a.type === "CLOSE" ? -1 : 1) || (a.trade.id < b.trade.id ? -1 : 1));

  let taken = 0;
  let skipped = 0;
  let wins = 0;
  let losses = 0;
  let flats = 0;

  // Track equity over time
  const equitySeries = [];

  function currentExposure() {
    let s = 0;
    for (const v of open.values()) s += v.stake;
    return s;
  }

  function equity() {
    return cash + currentExposure();
  }

  for (const e of events) {
    if (e.type === "CLOSE") {
      const pos = open.get(e.trade.id);
      if (!pos) continue; // wasn’t taken

      const grossPnl = pos.stake * pos.roi;
      const fee = Math.abs(pos.stake) * params.feeFrac;
      const netPnl = grossPnl - fee;
      const payout = Math.max(0, pos.stake + netPnl); // stake + pnl; clamp at 0

      cash += payout;
      open.delete(e.trade.id);

      if (netPnl > 0) wins += 1;
      else if (netPnl < 0) losses += 1;
      else flats += 1;
    } else {
      // OPEN
      if (open.has(e.trade.id)) continue;
      if (e.trade.entry < params.minEntry) {
        skipped += 1;
        continue;
      }
      if (cash < params.minOrder) {
        skipped += 1;
        continue;
      }

      const exp = currentExposure();
      const eq = cash + exp;
      const maxExp = eq * params.maxExposure;
      const remaining = maxExp - exp;
      if (remaining <= 0) {
        skipped += 1;
        continue;
      }

      let stake = cash * params.maxFrac;
      stake = Math.min(stake, remaining);
      stake = Math.min(stake, cash);

      if (stake < params.minOrder) {
        skipped += 1;
        continue;
      }

      // take it
      cash -= stake;
      open.set(e.trade.id, { stake, roi: e.trade.roi, closeMs: e.trade.closeMs });
      taken += 1;
    }

    const eqNow = equity();
    peakEquity = Math.max(peakEquity, eqNow);
    const dd = peakEquity > 0 ? (peakEquity - eqNow) / peakEquity : 0;
    maxDrawdown = Math.max(maxDrawdown, dd);
    equitySeries.push([e.t, eqNow, cash, currentExposure(), open.size]);
  }

  return {
    start: params.start,
    end: cash,
    totalReturnPct: params.start > 0 ? ((cash / params.start) - 1) * 100 : 0,
    tradesTaken: taken,
    tradesSkipped: skipped,
    wins,
    losses,
    flats,
    winRatePct: taken ? (wins / taken) * 100 : 0,
    maxDrawdownPct: maxDrawdown * 100,
    params,
    equitySeriesSample: equitySeries.slice(0, 25),
  };
}

function main() {
  const params = {
    start: num(process.env.START ?? 5),
    maxFrac: num(process.env.MAX_FRAC ?? 0.25),
    maxExposure: num(process.env.MAX_EXPOSURE ?? 0.7),
    minOrder: num(process.env.MIN_ORDER ?? 1.1),
    feeFrac: num(process.env.FEE_FRAC ?? 0),
    minEntry: num(process.env.MIN_ENTRY ?? 0),
  };

  const debugDir = path.join(process.cwd(), "debug");
  const { filesScanned, closedTrades } = loadClosedTrades(debugDir);

  const result = replay(closedTrades, params);
  const out = {
    filesScanned,
    closedTrades: closedTrades.length,
    result,
  };

  const outPath = path.join(debugDir, "trade_replay_backtest_v2.json");
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2), "utf8");
  console.log(`[replay_trade_history] wrote ${path.relative(process.cwd(), outPath)}`);
  console.log(JSON.stringify(out.result, null, 2));
}

main();


