#!/usr/bin/env node
/**
 * Non-destructive live trade-readiness gate for Fly deployment.
 *
 * This does not place an order. It verifies that the live bot is unpaused,
 * strategy-loaded, funded, CLOB-authenticated, and using the same signature
 * route selected by the readiness probe.
 */

const BASE_URL = process.env.POLYPROPHET_BASE_URL || 'https://polyprophet.fly.dev';
const MIN_ORDER_SHARES = 5;

async function fetchJson(path) {
    const response = await fetch(`${BASE_URL}${path}`, {
        signal: AbortSignal.timeout(30000),
    });
    if (!response.ok) {
        const body = await response.text().catch(() => '');
        throw new Error(`${path} returned HTTP ${response.status}: ${body.slice(0, 300)}`);
    }
    return response.json();
}

function assertReady(condition, message, details = undefined) {
    if (!condition) {
        const suffix = details === undefined ? '' : ` :: ${JSON.stringify(details)}`;
        throw new Error(`${message}${suffix}`);
    }
}

async function main() {
    const [health, status, wallet, clob] = await Promise.all([
        fetchJson('/api/health'),
        fetchJson('/api/status'),
        fetchJson('/api/wallet/balance'),
        fetchJson('/api/clob-status'),
    ]);

    const clobStatus = clob.clobStatus || clob;
    const tradeReady = clobStatus.tradeReady || {};
    const selected = tradeReady.selected || {};
    const risk = status.risk || {};
    const bankroll = Number(risk.bankroll ?? status.balance ?? 0);
    const selectedBalanceRaw = Number(selected.balanceRaw ?? 0);
    const selectedSigType = Number(selected.signatureType);
    const configuredSigType = Number(clobStatus.sigType);
    const strategy15m = health.strategySets && health.strategySets['15m'];

    assertReady(health.isLive === true, 'Health is not live', { isLive: health.isLive, mode: health.mode });
    assertReady(health.manualPause !== true, 'Manual pause is enabled', { manualPause: health.manualPause });
    assertReady(!Array.isArray(health.liveModeBlockers) || health.liveModeBlockers.length === 0, 'Live mode blockers present', health.liveModeBlockers);
    assertReady(strategy15m && strategy15m.strategies === 7, 'Active 15m strategy set is not the expected 7-signal set', strategy15m);
    assertReady(String(strategy15m.filePath || '').includes('strategy_set_15m_crossval_7signal_v2.json'), 'Unexpected active strategy path', strategy15m);

    assertReady(status.isLive === true, 'Status endpoint is not live', { isLive: status.isLive, mode: status.mode });
    assertReady(status.tradingPaused !== true && risk.tradingPaused !== true, 'Trading is paused', { tradingPaused: status.tradingPaused, riskTradingPaused: risk.tradingPaused });
    assertReady(risk.errorHalted !== true, 'Risk manager error halt is active', risk);
    assertReady(risk.tradeFailureHalted !== true, 'Risk manager trade failure halt is active', risk);
    assertReady(bankroll >= 2.5, 'Bankroll cannot afford a likely 5-share 50c order', { bankroll });

    assertReady(wallet.walletLoaded === true || wallet.ok === true || wallet.address, 'Wallet endpoint does not show loaded wallet', wallet);
    assertReady(clobStatus.walletLoaded === true, 'CLOB wallet is not loaded', clobStatus);
    assertReady(clobStatus.hasCreds === true, 'CLOB credentials are missing', clobStatus);
    assertReady(tradeReady.ok === true, 'CLOB tradeReady probe failed', tradeReady);
    assertReady(Number.isFinite(configuredSigType), 'Configured CLOB signature type is invalid', { configuredSigType: clobStatus.sigType });
    if (selectedSigType !== configuredSigType) {
        const candidates = Array.isArray(tradeReady.candidates) ? tradeReady.candidates : [];
        const configuredCandidate = candidates.find((candidate) => Number(candidate.signatureType) === configuredSigType);
        assertReady(
            configuredSigType === 3 && selectedSigType === 1 && configuredCandidate && String(configuredCandidate.funderAddress || '').toLowerCase() === String(selected.funderAddress || '').toLowerCase(),
            'Selected CLOB route does not match configured signature type and no same-funder deposit-wallet candidate exists',
            { configuredSigType, selectedSigType, selected, configuredCandidate },
        );
    }
    assertReady(selectedBalanceRaw > 0, 'Selected CLOB route has no funded balance', selected);
    assertReady(selected.allowanceMaxRaw !== undefined && selected.allowanceMaxRaw !== null, 'Selected CLOB route has no max allowance proof', selected);

    const minAffordablePrice = bankroll / MIN_ORDER_SHARES;
    console.log('PASS_LIVE_TRADE_READINESS');
    console.log(JSON.stringify({
        baseUrl: BASE_URL,
        isLive: health.isLive,
        manualPause: health.manualPause ?? null,
        liveModeBlockers: health.liveModeBlockers || [],
        strategyPath: strategy15m.filePath,
        strategyCount: strategy15m.strategies,
        tradingPaused: status.tradingPaused,
        bankroll,
        minAffordablePrice,
        clobSigType: configuredSigType,
        selectedSigType,
        selectedFunder: selected.funderAddress,
        selectedBalanceRaw: selected.balanceRaw,
        allowanceMaxRawPresent: selected.allowanceMaxRaw !== undefined && selected.allowanceMaxRaw !== null,
    }, null, 2));
}

main().catch((error) => {
    console.error('FAIL_LIVE_TRADE_READINESS');
    console.error(error.stack || error.message || error);
    process.exit(1);
});