#!/usr/bin/env node
/**
 * Regression: when preferred sigType=3 has retryable auth failure but the same
 * funder is balance-proven via another probe, order attempts must try sigType=3
 * before sigType=1. This prevents the known deposit-wallet maker-policy halt.
 */

process.env.POLYMARKET_SIGNATURE_TYPE = '3';

const PolymarketCLOB = require('../lib/clob-client');

const clob = new PolymarketCLOB();
const funder = '0x49756ECdA82F999EfB75F93f8B70a0Ff4Ea36e97';
const probes = [
    {
        signatureType: 1,
        funderAddress: funder,
        source: 'env',
        ok: true,
        balanceRaw: '7929836',
        allowanceMaxRaw: '115792089237316195423570985008687907853269984665640564039457584007913129639935',
    },
    {
        signatureType: 3,
        funderAddress: funder,
        source: 'env_sigType3',
        ok: false,
        status: 401,
        error: 'Unauthorized/Invalid api key',
    },
];

const ordered = clob._buildAttemptOrder(probes, 3, false);
const summary = ordered.map((probe) => `${probe.signatureType}:${probe.source}`);

if (summary[0] !== '3:env_sigType3' || summary[1] !== '1:env') {
    console.error('FAIL_CLOB_ATTEMPT_ORDER');
    console.error(JSON.stringify({ summary }, null, 2));
    process.exit(1);
}

console.log('PASS_CLOB_ATTEMPT_ORDER');
console.log(JSON.stringify({ summary }, null, 2));