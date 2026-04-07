#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');

const ROOT = path.join(__dirname, '..');
const LIVE_BASE_URL = String(process.env.LIVE_BASE_URL || 'https://polyprophet-1-rr1g.onrender.com').replace(/\/+$/, '');
const OUTPUT_PATH = path.join(ROOT, 'debug', 'runtime_reaudit_report.json');
const EXPECTED_15M_STRATEGY_PATH = String(process.env.EXPECTED_15M_STRATEGY_PATH || 'strategies/strategy_set_15m_combined_sub50c_tight.json').trim();
const LOCAL_15M_STRATEGY_PATH = path.isAbsolute(EXPECTED_15M_STRATEGY_PATH)
    ? EXPECTED_15M_STRATEGY_PATH
    : path.join(ROOT, EXPECTED_15M_STRATEGY_PATH);
const EXPECTED_15M_STRATEGY_BASENAME = path.basename(LOCAL_15M_STRATEGY_PATH);
const EXPECTED_5M_STRATEGY_PATH = String(process.env.EXPECTED_5M_STRATEGY_PATH || 'debug/strategy_set_5m_walkforward_top4.json').trim();
const LOCAL_5M_STRATEGY_PATH = path.isAbsolute(EXPECTED_5M_STRATEGY_PATH)
    ? EXPECTED_5M_STRATEGY_PATH
    : path.join(ROOT, EXPECTED_5M_STRATEGY_PATH);
const EXPECTED_5M_STRATEGY_BASENAME = path.basename(LOCAL_5M_STRATEGY_PATH);
const EXPECTED_MODE = String(process.env.EXPECTED_MODE || 'LIVE').trim().toUpperCase();
const EXPECTED_5M_ENABLED = String(process.env.EXPECTED_5M_ENABLED || 'true').trim().toLowerCase() !== 'false';
const REQUIRE_TRADE_READY = String(process.env.REQUIRE_TRADE_READY || (EXPECTED_MODE === 'LIVE' ? 'true' : 'false')).trim().toLowerCase() === 'true';
const EXPECTED_RISK = {
    requireRealOrderBook: String(process.env.EXPECTED_REQUIRE_REAL_ORDERBOOK || 'true').trim().toLowerCase() !== 'false',
    enforceNetEdgeGate: String(process.env.EXPECTED_ENFORCE_NET_EDGE_GATE || 'false').trim().toLowerCase() === 'true',
    maxTotalExposure: Number(process.env.EXPECTED_MAX_TOTAL_EXPOSURE ?? 0),
    riskEnvelopeEnabled: String(process.env.EXPECTED_RISK_ENVELOPE_ENABLED || 'false').trim().toLowerCase() === 'true',
    minBalanceFloor: Number(process.env.EXPECTED_MIN_BALANCE_FLOOR ?? 0),
    minOrderShares: Number(process.env.EXPECTED_MIN_ORDER_SHARES ?? 5),
    entryPriceBufferCents: Number(process.env.EXPECTED_ENTRY_BUFFER_CENTS ?? 0),
    maxPerCycle: Number(process.env.EXPECTED_MAX_PER_CYCLE ?? 1),
    stakeFraction: Number(process.env.EXPECTED_STAKE_FRACTION ?? 0.15)
};

function writeJson(filePath, value) {
    fs.writeFileSync(filePath, JSON.stringify(value, null, 2));
}

function approxEqual(a, b, tolerance = 1e-9) {
    return Number.isFinite(Number(a)) && Number.isFinite(Number(b)) && Math.abs(Number(a) - Number(b)) <= tolerance;
}

function parseEpochMs(value) {
    const parsed = Date.parse(String(value || ''));
    return Number.isFinite(parsed) ? parsed : null;
}

function getJson(url) {
    return new Promise((resolve, reject) => {
        const client = String(url).startsWith('http://') ? http : https;
        client.get(url, (res) => {
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
    const local5mStrategyCount = (() => {
        try {
            const parsed = JSON.parse(fs.readFileSync(LOCAL_5M_STRATEGY_PATH, 'utf8'));
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
    const clobSurface = clobStatus?.clobStatus || {};
    const tradeReadySurface = clobStatus?.tradeReady || clobSurface?.tradeReady || null;
    const startupMs = parseEpochMs(diagnostics?.startedAt || health?.startedAt);
    const liveDiagnosticsLog = Array.isArray(diagnostics?.log)
        ? diagnostics.log.filter((entry) => {
            if (!Number.isFinite(startupMs)) return true;
            const entryMs = parseEpochMs(entry?.ts);
            return Number.isFinite(entryMs) ? entryMs >= (startupMs - 1000) : false;
        })
        : [];
    const actionableDiagnostics = liveDiagnosticsLog.filter((entry) =>
        [
            'ERROR_HALT',
            'TRADE_FAILURE_HALT',
            'LIVE_SETTLEMENT_ERROR',
            'BALANCE_REFRESH_TIMEOUT',
            'TRADE_FAILED'
        ].includes(String(entry?.type || ''))
    );

    const checks = [
        {
            name: 'Health endpoint',
            status: health?.status === 'ok' ? 'PASS' : 'FAIL',
            detail: health?.status || null
        },
        {
            name: `Mode is ${EXPECTED_MODE}`,
            status: health?.mode === EXPECTED_MODE && health?.isLive === (EXPECTED_MODE === 'LIVE') ? 'PASS' : 'FAIL',
            detail: `${health?.mode} / isLive=${health?.isLive}`
        },
        {
            name: 'Correct 15m strategy loaded',
            status: String(health?.strategySets?.['15m']?.filePath || '').endsWith(EXPECTED_15M_STRATEGY_BASENAME) ? 'PASS' : 'FAIL',
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
            name: '5m timeframe active',
            status: !EXPECTED_5M_ENABLED || (
                Array.isArray(health?.timeframes) &&
                health.timeframes.includes('5m') &&
                Number(health?.configuredTimeframes?.find?.((tf) => tf?.key === '5m')?.minBankroll) === 2
            ) ? 'PASS' : 'FAIL',
            detail: {
                activeTimeframes: health?.timeframes || [],
                configured5m: health?.configuredTimeframes?.find?.((tf) => tf?.key === '5m') || null
            }
        },
        {
            name: 'Correct 5m strategy loaded',
            status: !EXPECTED_5M_ENABLED || String(health?.strategySets?.['5m']?.filePath || '').endsWith(EXPECTED_5M_STRATEGY_BASENAME) ? 'PASS' : 'FAIL',
            detail: health?.strategySets?.['5m']?.filePath || null
        },
        {
            name: '5m strategy count',
            status: !EXPECTED_5M_ENABLED || (local5mStrategyCount !== null && Number(health?.strategySets?.['5m']?.strategies) === local5mStrategyCount) ? 'PASS' : 'FAIL',
            detail: {
                live: Number(health?.strategySets?.['5m']?.strategies || 0),
                localExpected: local5mStrategyCount
            }
        },
        {
            name: 'CLOB tradeReady',
            status: !REQUIRE_TRADE_READY || tradeReadySurface?.ok === true ? 'PASS' : 'FAIL',
            detail: REQUIRE_TRADE_READY
                ? (tradeReadySurface?.summary || tradeReadySurface?.reason || null)
                : 'not required for this reaudit mode'
        },
        {
            name: 'Proxy redemption auth ready',
            status: clobSurface?.proxyRedeemAuthReady === true ? 'PASS' : 'WARN',
            detail: {
                proxyRedeemAuthReady: !!clobSurface?.proxyRedeemAuthReady,
                relayerAuthMode: clobSurface?.relayerAuthMode || null,
                relayerAuthConfigured: !!clobSurface?.relayerAuthConfigured,
                builderAutoDerivable: !!clobSurface?.builderAutoDerivable
            }
        },
        {
            name: '15m risk posture',
            status: (
                health?.riskControls?.requireRealOrderBook === EXPECTED_RISK.requireRealOrderBook &&
                health?.riskControls?.enforceNetEdgeGate === EXPECTED_RISK.enforceNetEdgeGate &&
                approxEqual(health?.riskControls?.maxTotalExposure, EXPECTED_RISK.maxTotalExposure) &&
                health?.riskControls?.riskEnvelopeEnabled === EXPECTED_RISK.riskEnvelopeEnabled &&
                approxEqual(health?.riskControls?.minBalanceFloor, EXPECTED_RISK.minBalanceFloor) &&
                Number(health?.riskControls?.minOrderShares) === EXPECTED_RISK.minOrderShares &&
                approxEqual(health?.riskControls?.entryPriceBufferCents, EXPECTED_RISK.entryPriceBufferCents) &&
                Number(health?.riskControls?.currentTierProfile?.maxPerCycle) === EXPECTED_RISK.maxPerCycle &&
                approxEqual(health?.riskControls?.currentTierProfile?.stakeFraction, EXPECTED_RISK.stakeFraction)
            ) ? 'PASS' : 'FAIL',
            detail: health?.riskControls || null
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
            status: actionableDiagnostics.length === 0 ? 'PASS' : 'WARN',
            detail: {
                restoredHistoricalEntries: Number(diagnostics?.restoredHistoricalEntries || 0),
                postStartupEntries: liveDiagnosticsLog.length,
                actionableEntries: actionableDiagnostics.slice(-5)
            }
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
        expected: {
            mode: EXPECTED_MODE,
            strategy15m: EXPECTED_15M_STRATEGY_BASENAME,
            strategy5m: EXPECTED_5M_STRATEGY_BASENAME,
            expected5mEnabled: EXPECTED_5M_ENABLED,
            tradeReadyRequired: REQUIRE_TRADE_READY,
            risk: EXPECTED_RISK
        },
        deployVersion: health?.deployVersion || null,
        verdict: verdictFromChecks(checks, health, { ...clobStatus, tradeReady: tradeReadySurface }, { log: actionableDiagnostics }),
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
