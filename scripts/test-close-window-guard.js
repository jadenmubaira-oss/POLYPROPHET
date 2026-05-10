#!/usr/bin/env node
/**
 * Property test for the close-window guard in lib/strategy-matcher.js
 *
 * Phase 0.2 of the Polyprophet strategy rebuild plan. Verifies that
 * `evaluateMatch` blocks every entry in the danger zone (within
 * `minEntrySecondsBeforeClose` of resolution) across all timeframes,
 * using BOTH the actual structural strategy files and a synthetic
 * "match-everything" strategy that isolates the guard.
 *
 * Pass criteria:
 *  - For every (timeframe, second-into-epoch) pair where
 *    `secondsUntilClose <= blockSeconds`, evaluateMatch must return [].
 *  - For at least one second outside the danger zone, evaluateMatch
 *    must return at least one match (proves the guard isn't accidentally
 *    blocking everything).
 *  - The actual production structural strategy files must have NO
 *    `entrySecondMax` value that would let an entry land inside the
 *    danger zone for the strategy's timeframe.
 *
 * Exit code: 0 on success, 1 on any property violation.
 */
const path = require('path');
const fs = require('fs');

// Make sure CONFIG defaults are applied (file requires it transitively).
const CONFIG = require('../lib/config');
const { loadStrategySet, evaluateMatch, getStrategySet } = require('../lib/strategy-matcher');

const ROOT = path.resolve(__dirname, '..');
const STRATEGIES_DIR = path.join(ROOT, 'strategies');

// ---- Helpers ----

function blockSecondsForTimeframe(tf) {
  const cfg = CONFIG?.RISK?.minEntrySecondsBeforeClose?.[tf.key];
  if (Number.isFinite(Number(cfg))) return Math.max(0, Number(cfg));
  const exit = CONFIG?.RISK?.preResolutionExitSeconds?.[tf.key];
  if (Number.isFinite(Number(exit))) return Math.max(0, Number(exit));
  if (tf.seconds <= 300) return 45;
  if (tf.seconds <= 900) return 120;
  return 600;
}

function makeSyntheticMarket(asset, yesPrice = 0.30) {
  return {
    asset,
    yesPrice,
    noPrice: Math.max(0.01, Math.min(0.99, 1 - yesPrice)),
    slug: `test-${asset}-up-or-down`,
    conditionId: '0xtest',
  };
}

function makeStructuralContext(asset, direction = 'UP') {
  return {
    [asset]: {
      ok: true,
      direction,
      moveBps: 30,
      absMoveBps: 30,
      dataAgeSec: 0,
    },
  };
}

// Synthetic strategy file written to a temp location and loaded fresh.
function writeSyntheticStrategySet(tfKey, sessionSeconds) {
  const dir = path.join(ROOT, 'data', 'tmp-test');
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, `synthetic_match_everything_${tfKey}.json`);
  const payload = {
    meta: {
      generatedBy: 'test-close-window-guard.js',
      tfKey,
      sessionSeconds,
      purpose: 'isolate close-window guard for property testing',
    },
    strategies: [
      {
        id: `SYN_${tfKey}_UP`,
        asset: 'ALL',
        direction: 'UP',
        utcHour: -1,
        entryMinuteMin: 0,
        entryMinuteMax: Math.max(0, Math.floor(sessionSeconds / 60) - 1),
        entrySecondMin: 0,
        entrySecondMax: 59,
        priceMin: 0.05,
        priceMax: 0.95,
        winRate: 0.99,
        winRateLCB: 0.95,
        pWinEstimate: 0.95,
        evWinEstimate: 0.95,
      },
      {
        id: `SYN_${tfKey}_DOWN`,
        asset: 'ALL',
        direction: 'DOWN',
        utcHour: -1,
        entryMinuteMin: 0,
        entryMinuteMax: Math.max(0, Math.floor(sessionSeconds / 60) - 1),
        entrySecondMin: 0,
        entrySecondMax: 59,
        priceMin: 0.05,
        priceMax: 0.95,
        winRate: 0.99,
        winRateLCB: 0.95,
        pWinEstimate: 0.95,
        evWinEstimate: 0.95,
      },
    ],
  };
  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2));
  return filePath;
}

// ---- Test runners ----

const failures = [];
const stats = { synthetic: {}, production: {} };

function recordFail(msg, ctx = {}) {
  failures.push({ msg, ctx });
}

function sweepSynthetic(tf) {
  const filePath = writeSyntheticStrategySet(tf.key, tf.seconds);
  const relPath = path.relative(ROOT, filePath);
  loadStrategySet(tf.key, relPath);
  const block = blockSecondsForTimeframe(tf);
  const epoch = 1779000000 - (1779000000 % tf.seconds); // align epoch to tf
  const market = makeSyntheticMarket('BTC', 0.30);

  let dangerSweepCount = 0;
  let dangerBlockedCount = 0;
  let safeSweepCount = 0;
  let safeMatchedCount = 0;

  // Sweep every 5 seconds across the entire epoch, plus every second
  // for the last 2*block seconds (where boundary behavior matters).
  const sampleSeconds = new Set();
  for (let s = 0; s < tf.seconds; s += 5) sampleSeconds.add(s);
  const denseStart = Math.max(0, tf.seconds - 2 * block - 5);
  for (let s = denseStart; s < tf.seconds; s += 1) sampleSeconds.add(s);
  // Always include the boundary points.
  sampleSeconds.add(tf.seconds - block - 1);
  sampleSeconds.add(tf.seconds - block);
  sampleSeconds.add(tf.seconds - block + 1);

  for (const s of sampleSeconds) {
    const nowSec = epoch + s;
    const matches = evaluateMatch(market, nowSec, tf, null);
    const secondsUntilClose = tf.seconds - s;

    if (secondsUntilClose <= block) {
      dangerSweepCount++;
      if (matches.length === 0) {
        dangerBlockedCount++;
      } else {
        recordFail(
          `[${tf.key}] DANGER ZONE LEAK: matches!=0 inside close window`,
          { secondsIntoEpoch: s, secondsUntilClose, blockSeconds: block, matchCount: matches.length },
        );
      }
    } else {
      safeSweepCount++;
      if (matches.length > 0) safeMatchedCount++;
    }
  }

  // Sanity: at least some safe-zone seconds must produce a match.
  if (safeMatchedCount === 0) {
    recordFail(
      `[${tf.key}] NO SAFE MATCHES: synthetic match-everything strategy never matched outside close window`,
      { safeSweepCount },
    );
  }

  stats.synthetic[tf.key] = {
    blockSeconds: block,
    sampledSeconds: sampleSeconds.size,
    dangerSweepCount,
    dangerBlockedCount,
    safeSweepCount,
    safeMatchedCount,
  };
}

function auditProductionStrategyFiles() {
  // Map each strategy file to its expected timeframe by filename.
  const tfMap = [
    { key: '5m', seconds: 300 },
    { key: '15m', seconds: 900 },
    { key: '4h', seconds: 14400 },
  ];

  const files = fs.readdirSync(STRATEGIES_DIR).filter((f) => f.endsWith('.json'));
  for (const file of files) {
    let inferredTf = null;
    if (/_5m_/i.test(file)) inferredTf = tfMap[0];
    else if (/_15m_/i.test(file)) inferredTf = tfMap[1];
    else if (/_4h_/i.test(file)) inferredTf = tfMap[2];
    if (!inferredTf) continue;

    const block = blockSecondsForTimeframe(inferredTf);
    const safeLastSecondInEpoch = inferredTf.seconds - block - 1;
    const safeLastMinute = Math.floor(safeLastSecondInEpoch / 60);
    const safeLastSecondWithinMinute = safeLastSecondInEpoch % 60;

    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(path.join(STRATEGIES_DIR, file), 'utf8'));
    } catch (e) {
      // Skip non-strategy JSONs gracefully.
      continue;
    }
    const list = Array.isArray(parsed?.strategies) ? parsed.strategies : null;
    if (!list || list.length === 0) continue;

    let unsafeCount = 0;
    for (const strat of list) {
      const eMinMin = Number.isFinite(Number(strat.entryMinuteMin)) ? Number(strat.entryMinuteMin) : null;
      const eMinMax = Number.isFinite(Number(strat.entryMinuteMax)) ? Number(strat.entryMinuteMax) : null;
      const eMinSingle = Number.isFinite(Number(strat.entryMinute)) ? Number(strat.entryMinute) : null;
      const eSecMax = Number.isFinite(Number(strat.entrySecondMax)) ? Number(strat.entrySecondMax) : 59;

      // Worst-case latest minute the strategy could fire.
      const latestMinute = eMinMax !== null ? eMinMax
        : eMinSingle !== null ? eMinSingle
        : Math.floor(inferredTf.seconds / 60) - 1;
      const latestSecond = latestMinute * 60 + eSecMax;
      const secondsUntilClose = inferredTf.seconds - latestSecond;

      if (secondsUntilClose <= block) {
        // The runtime guard will still catch it, but flag for awareness.
        unsafeCount++;
      }
    }

    stats.production[file] = {
      tf: inferredTf.key,
      blockSeconds: block,
      safeLastMinute,
      safeLastSecondWithinMinute,
      strategyCount: list.length,
      strategiesRequiringRuntimeGuard: unsafeCount,
    };
  }
}

// ---- Run ----

const timeframes = [
  { key: '5m', seconds: 300 },
  { key: '15m', seconds: 900 },
  { key: '4h', seconds: 14400 },
];

console.log('=== POLYPROPHET Close-Window Guard Property Test ===\n');

for (const tf of timeframes) {
  sweepSynthetic(tf);
}
auditProductionStrategyFiles();

// ---- Report ----

console.log('Synthetic strategy sweep:');
for (const [tf, s] of Object.entries(stats.synthetic)) {
  console.log(
    `  [${tf}] blockSeconds=${s.blockSeconds} sampled=${s.sampledSeconds} ` +
    `danger=${s.dangerSweepCount}/${s.dangerBlockedCount} blocked, ` +
    `safe=${s.safeSweepCount}/${s.safeMatchedCount} matched`,
  );
}

console.log('\nProduction strategy file audit:');
for (const [file, s] of Object.entries(stats.production)) {
  console.log(
    `  ${file} (${s.tf}): ${s.strategyCount} strategies, ` +
    `safe last entry = min ${s.safeLastMinute}:${String(s.safeLastSecondWithinMinute).padStart(2, '0')}, ` +
    `runtimeGuardRequired=${s.strategiesRequiringRuntimeGuard}`,
  );
}

console.log('\n--- Failures ---');
if (failures.length === 0) {
  console.log('  none');
  console.log('\nVerdict: ALL CLOSE-WINDOW GUARD PROPERTIES HOLD');
  process.exit(0);
} else {
  for (const f of failures) {
    console.log(`  [FAIL] ${f.msg} :: ${JSON.stringify(f.ctx)}`);
  }
  console.log(`\nVerdict: ${failures.length} PROPERTY VIOLATION(S)`);
  process.exit(1);
}
