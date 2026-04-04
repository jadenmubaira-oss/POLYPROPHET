#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const https = require('https');

const ROOT = path.join(__dirname, '..');
const LIVE_BASE_URL = String(process.env.LIVE_BASE_URL || 'https://polyprophet-1-rr1g.onrender.com').replace(/\/+$/, '');
const OUTPUT_PATH = path.join(ROOT, 'debug', 'runtime_reaudit_report.json');
const LOCAL_15M_STRATEGY_PATH = path.join(ROOT, 'strategies', 'strategy_set_15m_beam_2739_uncapped.json');

function writeJson(filePath, value) {
    fs.writeFileSync(filePath, JSON.stringify(value, null, 2));
}

function getJson(url) {
    return new Promise((resolve, reject) => {
        https.get(url, (res) => {
            let data = '';
            res.on('data', (chunk) => { data += chunk; });
            res.on('end', () => {
                if (res.statusCode && res.statusCode >= 400) {
                    return reject(new Error(`HTTP ${res.statusCode}: ${url}`));
                }
                try {
                    resolve(JSON.parse(data));
                } catch (err) {
                    reject(new Error(`JSON parse failed for ${url}: ${err.message}`));
                }
            });
        }).on('error', reject);
    });
}

function verdictFromChecks(checks, health, clobStatus, diagnostics) {
    const failures = checks.filter((check) => check.status === 'FAIL');
    if (failures.length > 0) return 'NO_GO';
    const warnings = checks.filter((check) => check.status === 'WARN');
    if (!Number.isFinite(Number(health?.balance)) || Number(health.balance) < 2) return 'CONDITIONAL_GO';
    if (warnings.length > 0) return 'CONDITIONAL_GO';
    if (Array.isArray(diagnostics?.log) && diagnostics.log.some((entry) =>
        ['ERROR_HALT', 'TRADE_FAILURE_HALT'].includes(String(entry?.type || ''))
    )) return 'CONDITIONAL_GO';
    if (!clobStatus?.tradeReady?.ok) return 'NO_GO';
    return 'GO';
}

async function main() {
    const local15mStrategyCount = (() => {
        try {
            const parsed = JSON.parse(fs.readFileSync(LOCAL_15M_STRATEGY_PATH, 'utf8'));
            return Array.isArray(parsed?.strategies) ? parsed.strategies.length : null;
        } catch {
            return null;
        }
    })();

    const [health, status, clobStatus, diagnostics, walletBalance] = await Promise.all([
        getJson(`${LIVE_BASE_URL}/api/health`),
        getJson(`${LIVE_BASE_URL}/api/status`),
        getJson(`${LIVE_BASE_URL}/api/clob-status`),
        getJson(`${LIVE_BASE_URL}/api/diagnostics`),
        getJson(`${LIVE_BASE_URL}/api/wallet/balance`).catch(() => null)
    ]);

    const checks = [
        {
            name: 'Health endpoint',
            status: health?.status === 'ok' ? 'PASS' : 'FAIL',
            detail: health?.status || null
        },
        {
            name: 'Mode is LIVE',
            status: health?.mode === 'LIVE' && health?.isLive === true ? 'PASS' : 'FAIL',
            detail: `${health?.mode} / isLive=${health?.isLive}`
        },
        {
            name: 'Correct 15m strategy loaded',
            status: String(health?.strategySets?.['15m']?.filePath || '').endsWith('strategy_set_15m_beam_2739_uncapped.json') ? 'PASS' : 'FAIL',
            detail: health?.strategySets?.['15m']?.filePath || null
        },
        {
            name: '15m strategy count',
            status: local15mStrategyCount !== null && Number(health?.strategySets?.['15m']?.strategies) === local15mStrategyCount ? 'PASS' : 'FAIL',
            detail: {
                live: Number(health?.strategySets?.['15m']?.strategies || 0),
                localExpected: local15mStrategyCount
            }
        },
        {
            name: 'CLOB tradeReady',
            status: clobStatus?.tradeReady?.ok === true ? 'PASS' : 'FAIL',
            detail: clobStatus?.tradeReady?.summary || clobStatus?.tradeReady?.reason || null
        },
        {
            name: 'Runtime persistence',
            status: health?.runtimeState?.mode === 'redis+file' && health?.runtimeState?.redisConnected === true ? 'PASS' : 'WARN',
            detail: health?.runtimeState || null
        },
        {
            name: 'Error halt clear',
            status: health?.errorHalt?.halted === false ? 'PASS' : 'WARN',
            detail: health?.errorHalt || null
        },
        {
            name: 'Trade-failure halt clear',
            status: health?.tradeFailureHalt ? (health.tradeFailureHalt.halted === false ? 'PASS' : 'WARN') : 'WARN',
            detail: health?.tradeFailureHalt || 'not deployed yet'
        },
        {
            name: 'Diagnostics clean',
            status: Array.isArray(diagnostics?.log) && diagnostics.log.length === 0 ? 'PASS' : 'WARN',
            detail: Array.isArray(diagnostics?.log) ? diagnostics.log.slice(-5) : null
        },
        {
            name: 'Proxy redemption autonomy',
            status: Array.isArray(status?.executor?.redemptionQueue) && status.executor.redemptionQueue.some((item) => item?.requiresManual) ? 'FAIL' : 'PASS',
            detail: Array.isArray(status?.executor?.redemptionQueue)
                ? status.executor.redemptionQueue
                    .filter((item) => item?.requiresManual)
                    .map((item) => ({
                        asset: item.asset || null,
                        timeframe: item.timeframe || null,
                        holderAddress: item.holderAddress || null,
                        lastError: item.lastError || null
                    }))
                : null
        },
        {
            name: 'Funding threshold',
            status: Number(health?.balance) >= 2 ? 'PASS' : 'WARN',
            detail: Number(health?.balance || 0)
        }
    ];

    const report = {
        generatedAt: new Date().toISOString(),
        liveBaseUrl: LIVE_BASE_URL,
        deployVersion: health?.deployVersion || null,
        verdict: verdictFromChecks(checks, health, clobStatus, diagnostics),
        checks,
        live: {
            health,
            status,
            clobStatus,
            diagnostics,
            walletBalance
        }
    };

    writeJson(OUTPUT_PATH, report);

    console.log(`Runtime reaudit saved to ${path.relative(ROOT, OUTPUT_PATH)}`);
    console.log(`Deploy: ${report.deployVersion}`);
    console.log(`Verdict: ${report.verdict}`);
    for (const check of checks) {
        console.log(`[${check.status}] ${check.name}`);
    }
}

main().catch((err) => {
    console.error(`runtime-reaudit failed: ${err.message}`);
    process.exit(1);
});
