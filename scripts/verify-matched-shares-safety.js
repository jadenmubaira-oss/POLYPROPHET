#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');
const {
  normalizeClobMatchedShares,
} = require('../lib/clob-matched-shares');

function read(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
}

const impossible = normalizeClobMatchedShares(249.76, 5.25);
assert.strictEqual(impossible.matchedShares, 5.25, 'impossible overfill must cap to requested shares');
assert.strictEqual(impossible.capped, true, 'impossible overfill must be flagged');
assert.strictEqual(impossible.reason, 'IMPOSSIBLE_OVERFILL', 'impossible overfill reason must be explicit');

const rounding = normalizeClobMatchedShares(5.02, 5);
assert.strictEqual(rounding.matchedShares, 5, 'small over-requested values must still cap to requested shares');
assert.strictEqual(rounding.capped, true, 'small over-requested values must be flagged');
assert.strictEqual(rounding.reason, 'OVER_REQUESTED_ROUNDING', 'rounding cap reason must be explicit');

const exact = normalizeClobMatchedShares(4.75, 5);
assert.strictEqual(exact.matchedShares, 4.75, 'valid partial fill must not be changed');
assert.strictEqual(exact.capped, false, 'valid partial fill must not be flagged');

const unknownRequested = normalizeClobMatchedShares(3.5, null);
assert.strictEqual(unknownRequested.matchedShares, 3.5, 'unknown requested shares must preserve raw matched shares');
assert.strictEqual(unknownRequested.capped, false, 'unknown requested shares must not invent a cap');

const clobClient = read('lib/clob-client.js');
const tradeExecutor = read('lib/trade-executor.js');
assert(
  clobClient.includes('normalizeClobMatchedShares') &&
    clobClient.includes('orderStatus.size_matched') &&
    clobClient.includes('shares'),
  'clob-client live order polling must normalize size_matched against requested shares',
);
assert(
  tradeExecutor.includes('normalizeClobMatchedShares') &&
    tradeExecutor.includes('order?.size_matched') &&
    tradeExecutor.includes('pendingBuy?.requestedShares'),
  'trade-executor pending-buy recovery must normalize size_matched against requested shares',
);

console.log(JSON.stringify({
  verdict: 'MATCHED_SHARES_SAFETY_PASS',
  impossible,
  rounding,
  exact,
  unknownRequested,
}, null, 2));