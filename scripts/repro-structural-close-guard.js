#!/usr/bin/env node
const assert = require('assert');
const path = require('path');
const { loadStrategySet, evaluateMatch } = require('../lib/strategy-matcher');

const strategyFile = path.join(
  'strategies',
  'strategy_set_15m_structural_edge_20260509T190152Z.json',
);

loadStrategySet('15m', strategyFile);

const timeframe = { key: '15m', seconds: 900 };
const epoch = 1778391000;
const market = {
  asset: 'BTC',
  yesPrice: 0.14,
  noPrice: 0.86,
};
const structuralContext = {
  BTC: {
    ok: true,
    direction: 'UP',
    moveBps: 20,
    absMoveBps: 20,
    dataAgeSec: 0,
  },
};

const safeMinuteMatches = evaluateMatch(
  market,
  epoch + 10 * 60 + 55,
  timeframe,
  structuralContext,
);
assert(
  safeMinuteMatches.length > 0,
  'Expected structural strategy to match outside close-block window',
);

const finalSecondsMatches = evaluateMatch(
  market,
  epoch + 14 * 60 + 55,
  timeframe,
  structuralContext,
);
assert.strictEqual(
  finalSecondsMatches.length,
  0,
  'Final-seconds 15m entries must be blocked before market close',
);

console.log(JSON.stringify({
  ok: true,
  safeMinuteMatches: safeMinuteMatches.length,
  finalSecondsMatches: finalSecondsMatches.length,
  blockedCase: '15m epoch+14:55',
}, null, 2));