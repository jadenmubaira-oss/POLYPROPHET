#!/usr/bin/env node
const { testProxyInput } = require('../lib/proxy-tester');

async function readInput() {
    const argInput = process.argv.slice(2).join(' ').trim();
    if (argInput) return argInput;
    if (process.env.PROXY_TEST_INPUT) return process.env.PROXY_TEST_INPUT;
    if (!process.stdin.isTTY) {
        let data = '';
        for await (const chunk of process.stdin) data += chunk;
        if (data.trim()) return data.trim();
    }
    throw new Error('Usage: node scripts/test-proxy.js "curl -i --proxy HOST:PORT --proxy-user USER:PASS -k"');
}

function shortTest(name, result) {
    const data = result?.data || {};
    const parts = [`${name}: status=${result?.status ?? 'n/a'}`, `ok=${!!result?.ok}`];
    if (data.blocked != null) parts.push(`blocked=${data.blocked}`);
    if (data.country) parts.push(`country=${data.country}`);
    if (data.region) parts.push(`region=${data.region}`);
    if (data.ip) parts.push(`ip=${data.ip}`);
    if (data.org) parts.push(`org=${data.org}`);
    if (result?.error) parts.push(`error=${result.error}`);
    if (typeof result?.body === 'string' && result.body) parts.push(`body=${result.body.slice(0, 160).replace(/\s+/g, ' ')}`);
    return parts.join(' | ');
}

(async () => {
    const input = await readInput();
    const result = await testProxyInput(input);
    console.log(`Verdict: ${result.verdict.pass ? 'PASS / CANDIDATE' : 'FAIL / NO-GO'} (${result.verdict.grade})`);
    console.log(result.verdict.summary);
    for (const warning of result.verdict.warnings || []) console.log(`WARNING: ${warning}`);
    console.log('');
    console.log(`Proxy route: ${result.redactedProxyUrl}`);
    if (result.insecureTls) console.log('TLS note: ran with diagnostic -k style TLS verification disabled, matching the raw curl examples.');
    console.log(shortTest('BrightData welcome', result.tests.brightDataWelcome));
    console.log(shortTest('ipinfo', result.tests.ipinfo));
    console.log(shortTest('Polymarket public geoblock', result.tests.publicGeoblock));
    console.log(shortTest('CLOB /time', result.tests.clobTime));
    console.log(shortTest('CLOB /order invalid preflight', result.tests.clobOrderPreflight));
    console.log('');
    if (result.verdict.pass) {
        console.log('Render envs to set:');
        console.log(`PROXY_URL=${result.renderEnv.PROXY_URL}`);
        console.log(`CLOB_FORCE_PROXY=${result.renderEnv.CLOB_FORCE_PROXY}`);
        console.log('');
        console.log(result.verdict.expectedNextProof);
    } else {
        console.log('Do not use this route for live trading. No Render env recommended.');
    }
    process.exit(result.verdict.pass ? 0 : 2);
})().catch((e) => {
    console.error(`Proxy test failed: ${e.message}`);
    process.exit(1);
});