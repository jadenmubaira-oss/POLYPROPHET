#!/usr/bin/env node
/**
 * Paper-Shadow Recorder — Phase 1.1 of STRATEGY_REBUILD_2026_05_10.md
 *
 * Runs alongside the bot (or standalone) and records, at every tick, the
 * live executable bid/ask/depth snapshot plus the current strategy-matcher
 * decision. This is the forward-truth stream every prior search lacked.
 *
 * Output: data/paper-shadow/YYYY-MM-DD/{asset}_{timeframe}.jsonl
 *   - one JSON line per (asset, timeframe, cycle-second) observation
 *   - fields: ts, iso, asset, tf, epoch, secondsIntoEpoch, yesPrice, noPrice,
 *             bestBid, bestAsk, bidDepth, askDepth, matched[], rejectedReasons[]
 *
 * At cycle close, a '__settlement__' line is appended with the resolved
 * outcome so Phase 3 forward-validation can compute WR and PnL without
 * guessing.
 *
 * Env:
 *   PAPER_SHADOW_TICK_MS           — poll interval (default 15000 = 15s)
 *   PAPER_SHADOW_ASSETS            — CSV (default BTC,ETH,SOL,XRP,BNB,DOGE)
 *   PAPER_SHADOW_TIMEFRAMES        — CSV of '5m,15m,4h' (default '5m,15m')
 *   PAPER_SHADOW_STRATEGY_5M_PATH  — override strategy file for 5m
 *   PAPER_SHADOW_STRATEGY_15M_PATH — override strategy file for 15m
 *   PAPER_SHADOW_STRATEGY_4H_PATH  — override strategy file for 4h
 *   PAPER_SHADOW_OUT_DIR           — override output directory
 *
 * Standalone usage:
 *   node scripts/paper-shadow-recorder.js
 *
 * Stop with Ctrl+C. State is written per-tick, so interruption is safe.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');

const CONFIG = require('../lib/config');
const {
  discoverMarket,
  fetchCLOBBook,
  computeEpoch,
  getEntryMinute,
} = require('../lib/market-discovery');
const {
  loadStrategySet,
  evaluateMatch,
  getStrategySet,
} = require('../lib/strategy-matcher');
const { getStructuralSignals } = require('../lib/structural-signal');

const ROOT = path.resolve(__dirname, '..');
const OUT_DIR = process.env.PAPER_SHADOW_OUT_DIR
  || path.join(ROOT, 'data', 'paper-shadow');
const TICK_MS = Math.max(5000, Number(process.env.PAPER_SHADOW_TICK_MS) || 15000);
const ASSETS = String(process.env.PAPER_SHADOW_ASSETS || 'BTC,ETH,SOL,XRP,BNB,DOGE')
  .split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
const TF_KEYS = String(process.env.PAPER_SHADOW_TIMEFRAMES || '5m,15m')
  .split(',').map((s) => s.trim()).filter(Boolean);

const TIMEFRAME_TABLE = {
  '5m': { key: '5m', seconds: 300 },
  '15m': { key: '15m', seconds: 900 },
  '4h': { key: '4h', seconds: 14400 },
};
const TIMEFRAMES = TF_KEYS
  .map((k) => TIMEFRAME_TABLE[k])
  .filter(Boolean);
if (TIMEFRAMES.length === 0) {
  throw new Error(`No valid timeframes selected from PAPER_SHADOW_TIMEFRAMES=${TF_KEYS.join(',')}`);
}

const DEFAULT_STRATEGY_PATHS = {
  '5m': process.env.PAPER_SHADOW_STRATEGY_5M_PATH
    || CONFIG?.STRATEGY?.paths?.['5m']
    || 'strategies/strategy_set_5m_structural_edge_20260509T190152Z.json',
  '15m': process.env.PAPER_SHADOW_STRATEGY_15M_PATH
    || CONFIG?.STRATEGY?.paths?.['15m']
    || 'strategies/strategy_set_15m_structural_edge_20260509T190152Z.json',
  '4h': process.env.PAPER_SHADOW_STRATEGY_4H_PATH
    || CONFIG?.STRATEGY?.paths?.['4h']
    || 'strategies/strategy_set_4h_top8.json',
};

function ensureDir(dir) { fs.mkdirSync(dir, { recursive: true }); }

function dayKey(ts) { return new Date(ts * 1000).toISOString().slice(0, 10); }

function outPathFor(asset, tfKey, ts) {
  const dayDir = path.join(OUT_DIR, dayKey(ts));
  ensureDir(dayDir);
  return path.join(dayDir, `${asset}_${tfKey}.jsonl`);
}

function appendJsonl(filePath, record) {
  fs.appendFileSync(filePath, JSON.stringify(record) + '\n');
}

function bookBestAndDepth(book, side = 'asks') {
  // fetchCLOBBook returns { bestBid, bestAsk, buyPrice, midpoint, raw }
  // where raw.bids / raw.asks are the actual book rows { price, size }.
  const rows = Array.isArray(book?.raw?.[side]) ? book.raw[side] : [];
  if (rows.length === 0) {
    const fallback = side === 'asks' ? book?.bestAsk : book?.bestBid;
    return { price: Number.isFinite(fallback) ? fallback : null, depth: 0, levels: 0 };
  }
  const prices = rows.map((r) => Number(r?.price)).filter(Number.isFinite);
  if (prices.length === 0) return { price: null, depth: 0, levels: 0 };
  const bestPrice = side === 'asks' ? Math.min(...prices) : Math.max(...prices);
  let depth = 0;
  let levels = 0;
  for (const r of rows) {
    const p = Number(r?.price);
    const s = Number(r?.size);
    if (!Number.isFinite(p) || !Number.isFinite(s)) continue;
    // aggregate depth within 2c of best (generous for micro-bankroll entries)
    if (side === 'asks' && p <= bestPrice + 0.02) { depth += s; levels++; }
    if (side === 'bids' && p >= bestPrice - 0.02) { depth += s; levels++; }
  }
  return { price: bestPrice, depth, levels };
}

function gammaMarketResolutionOutcome(market) {
  // Returns 'YES' | 'NO' | null
  if (!market) return null;
  const resolved = market?.resolved === true || market?.closed === true;
  if (!resolved) return null;
  const outcomePrices = (() => {
    try { return JSON.parse(market.outcomePrices || '[]'); }
    catch { return []; }
  })();
  if (Array.isArray(outcomePrices) && outcomePrices.length >= 2) {
    const y = Number(outcomePrices[0]);
    const n = Number(outcomePrices[1]);
    if (Number.isFinite(y) && Number.isFinite(n)) {
      if (y >= 0.99) return 'YES';
      if (n >= 0.99) return 'NO';
    }
  }
  return null;
}

const recordedCycles = new Set();       // "asset:tf:epoch" we have an observation for
const settledCycles = new Set();        // "asset:tf:epoch" already settled

async function recordTick() {
  const nowSec = Math.floor(Date.now() / 1000);
  const isoNow = new Date(nowSec * 1000).toISOString();

  // Structural context once per tick per tf
  const structuralByTf = {};
  for (const tf of TIMEFRAMES) {
    try {
      structuralByTf[tf.key] = await getStructuralSignals(ASSETS, tf, nowSec);
    } catch (e) {
      structuralByTf[tf.key] = {};
    }
  }

  for (const tf of TIMEFRAMES) {
    const epoch = computeEpoch(nowSec, tf.seconds);
    const secondsIntoEpoch = Math.max(0, nowSec - epoch);
    const secondsUntilClose = Math.max(0, tf.seconds - secondsIntoEpoch);
    const entryMinute = getEntryMinute(nowSec, tf.seconds);
    const entrySecond = secondsIntoEpoch % 60;

    for (const asset of ASSETS) {
      let discovered = null;
      try {
        discovered = await discoverMarket(asset, tf, nowSec);
      } catch {
        discovered = null;
      }
      if (!discovered || discovered.status !== 'ACTIVE') {
        // Record a skeletal observation so the absence is visible for Phase 3.
        const outPath = outPathFor(asset, tf.key, nowSec);
        appendJsonl(outPath, {
          ts: nowSec,
          iso: isoNow,
          asset,
          tf: tf.key,
          epoch,
          secondsIntoEpoch,
          secondsUntilClose,
          marketStatus: discovered?.status || 'NOT_FOUND',
          skipReason: 'MARKET_INACTIVE',
        });
        continue;
      }

      // discoverMarket already fetched YES + NO books; fetch YES again only
      // if we need raw depth (best-bid/ask + levels are already available).
      let yesBook = null;
      try {
        if (discovered.yesTokenId) yesBook = await fetchCLOBBook(discovered.yesTokenId);
      } catch {
        yesBook = null;
      }
      const bestAsk = bookBestAndDepth(yesBook, 'asks');
      const bestBid = bookBestAndDepth(yesBook, 'bids');

      // Build the shape that evaluateMatch expects.
      const marketForMatcher = {
        asset,
        yesPrice: Number(discovered.yesPrice),
        noPrice: Number(discovered.noPrice),
        slug: discovered.slug,
        conditionId: discovered.conditionId,
      };

      let matched = [];
      let rejectReasons = null;
      try {
        const matches = evaluateMatch(marketForMatcher, nowSec, tf, structuralByTf[tf.key] || null);
        matched = matches.map((m) => ({
          id: m.strategy?.id || m.name,
          direction: m.direction,
          entryPrice: m.entryPrice,
          pWin: m.pWinEstimate,
          evWin: m.evWinEstimate,
          structural: m.structuralContext || null,
        }));
      } catch (e) {
        rejectReasons = [`EVAL_ERROR:${e.message}`];
      }

      const record = {
        ts: nowSec,
        iso: isoNow,
        asset,
        tf: tf.key,
        epoch,
        secondsIntoEpoch,
        secondsUntilClose,
        entryMinute,
        entrySecond,
        yesPrice: Number(discovered.yesPrice),
        noPrice: Number(discovered.noPrice),
        bestAsk: bestAsk.price ?? discovered.yesBestAsk ?? null,
        bestBid: bestBid.price ?? discovered.yesBestBid ?? null,
        askDepthShares: bestAsk.depth,
        bidDepthShares: bestBid.depth,
        bookLevelsAsk: bestAsk.levels,
        bookLevelsBid: bestBid.levels,
        priceSource: discovered.priceSource,
        yesMinOrderSize: discovered.yesMinOrderSize ?? null,
        structural: (structuralByTf[tf.key] || {})[asset] || null,
        strategySetSize: getStrategySet(tf.key)?.strategies?.length || 0,
        matched,
        rejectReasons,
      };

      const outPath = outPathFor(asset, tf.key, nowSec);
      appendJsonl(outPath, record);
      recordedCycles.add(`${asset}:${tf.key}:${epoch}`);
    }
  }
}

async function checkSettlements() {
  // Walk recent recorded cycles that are now past resolution + 30s,
  // fetch resolved market, and append a '__settlement__' row once per cycle.
  const nowSec = Math.floor(Date.now() / 1000);
  for (const key of Array.from(recordedCycles)) {
    if (settledCycles.has(key)) continue;
    const [asset, tfKey, epochStr] = key.split(':');
    const tf = TIMEFRAME_TABLE[tfKey];
    if (!tf) { recordedCycles.delete(key); continue; }
    const epoch = Number(epochStr);
    const cycleEndSec = epoch + tf.seconds;
    if (nowSec < cycleEndSec + 30) continue;

    // Settlement grace: up to 5 minutes after close before giving up
    if (nowSec > cycleEndSec + 300) {
      settledCycles.add(key);
      recordedCycles.delete(key);
      continue;
    }

    let discovered = null;
    try {
      discovered = await discoverMarket(asset, tf, cycleEndSec + 1);
    } catch { discovered = null; }
    const outcome = gammaMarketResolutionOutcome(discovered?.data);
    if (!outcome) continue;

    const outPath = outPathFor(asset, tfKey, cycleEndSec);
    appendJsonl(outPath, {
      __settlement__: true,
      ts: nowSec,
      iso: new Date(nowSec * 1000).toISOString(),
      asset,
      tf: tfKey,
      epoch,
      cycleEndSec,
      outcome,
    });
    settledCycles.add(key);
    recordedCycles.delete(key);
  }
}

async function loadAllStrategies() {
  for (const tf of TIMEFRAMES) {
    const p = DEFAULT_STRATEGY_PATHS[tf.key];
    if (!p) continue;
    const count = loadStrategySet(tf.key, p);
    console.log(`[paper-shadow] loaded ${count} strategies for ${tf.key} from ${p}`);
  }
}

async function main() {
  ensureDir(OUT_DIR);
  console.log('=== POLYPROPHET Paper-Shadow Recorder ===');
  console.log(`  out   : ${OUT_DIR}`);
  console.log(`  tick  : ${TICK_MS}ms`);
  console.log(`  assets: ${ASSETS.join(',')}`);
  console.log(`  tf    : ${TIMEFRAMES.map((t) => t.key).join(',')}`);
  await loadAllStrategies();

  let ticks = 0;
  let tickErrs = 0;
  const loop = async () => {
    try {
      await recordTick();
      await checkSettlements();
      ticks++;
      if (ticks % 20 === 0) {
        console.log(`[paper-shadow] ticks=${ticks} errs=${tickErrs} recordedCycles=${recordedCycles.size} settled=${settledCycles.size}`);
      }
    } catch (e) {
      tickErrs++;
      console.error(`[paper-shadow] tick error: ${e.message}`);
    } finally {
      setTimeout(loop, TICK_MS);
    }
  };
  loop();
}

if (require.main === module) {
  main().catch((e) => {
    console.error('[paper-shadow] fatal:', e);
    process.exit(1);
  });
}

module.exports = { main };
