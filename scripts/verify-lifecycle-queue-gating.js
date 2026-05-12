#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const serverPath = path.join(root, 'server.js');
const source = fs.readFileSync(serverPath, 'utf8');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

assert(
  source.includes("entriesBlocked: CONFIG.TRADE_MODE === 'LIVE' && actionableRecoveryQueue"),
  'Lifecycle entry suppression must be tied to recovery queue only; redemption queue is non-blocking.',
);
assert(
  source.includes("ACTIONABLE_REDEMPTION_QUEUE_NON_BLOCKING"),
  'Redemption queue reason must be marked non-blocking for smoke-test resume.',
);
assert(
  source.includes('redemptionQueueBlocksEntries: false'),
  'Lifecycle status must expose redemptionQueueBlocksEntries=false.',
);

console.log(JSON.stringify({
  verdict: 'LIFECYCLE_QUEUE_GATING_PASS',
  recoveryQueueBlocksEntries: true,
  redemptionQueueBlocksEntries: false,
  rationale: 'Redeemable/dust queue records stay visible but do not suppress new entries; spendable balance and order sizing remain the hard execution gates.',
}, null, 2));