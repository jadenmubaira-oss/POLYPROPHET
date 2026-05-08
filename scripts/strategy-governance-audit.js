#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const DEFAULT_CURRENT = 'strategies/strategy_set_15m_autopilot_pruned_20260508152930.json';
const DEFAULT_SOURCE = 'strategies/strategy_set_15m_epoch3v2_portfolio.json';

function numberEnv(name, fallback) {
    const value = Number(process.env[name]);
    return Number.isFinite(value) ? value : fallback;
}

function boolEnv(name, fallback = false) {
    const raw = process.env[name];
    if (raw === undefined || raw === null || raw === '') return fallback;
    return ['1', 'true', 'yes', 'on'].includes(String(raw).toLowerCase());
}

function safeOutputStem(strategyFile) {
    return String(strategyFile || 'strategy')
        .replace(/\\/g, '/')
        .split('/')
        .pop()
        .replace(/\.json$/i, '')
        .replace(/[^a-z0-9_-]+/gi, '_')
        .slice(0, 100);
}

function readJson(file) {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function writeJson(file, value) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(value, null, 2));
}

function round(value, digits = 4) {
    if (!Number.isFinite(value)) return value === null ? null : undefined;
    const m = 10 ** digits;
    return Math.round(value * m) / m;
}

function quantile(values, q) {
    const xs = values.filter(Number.isFinite).sort((a, b) => a - b);
    if (!xs.length) return null;
    const pos = (xs.length - 1) * q;
    const lo = Math.floor(pos);
    const hi = Math.ceil(pos);
    if (lo === hi) return xs[lo];
    return xs[lo] + (xs[hi] - xs[lo]) * (pos - lo);
}

function wilsonLowerBound(wins, n, z = 1.96) {
    if (!n) return 0;
    const p = wins / n;
    const z2 = z * z;
    return (p + z2 / (2 * n) - z * Math.sqrt((p * (1 - p) + z2 / (4 * n)) / n)) / (1 + z2 / n);
}

function fetchJson(url, timeoutMs = 20000) {
    return new Promise((resolve, reject) => {
        const req = https.get(url, { timeout: timeoutMs }, (res) => {
            let body = '';
            res.setEncoding('utf8');
            res.on('data', (chunk) => { body += chunk; });
            res.on('end', () => {
                if (res.statusCode < 200 || res.statusCode >= 300) {
                    reject(new Error(`HTTP_${res.statusCode} ${url} ${body.slice(0, 300)}`));
                    return;
                }
                try { resolve(JSON.parse(body)); } catch (error) { reject(error); }
            });
        });
        req.on('timeout', () => req.destroy(new Error(`TIMEOUT ${url}`)));
        req.on('error', reject);
    });
}

function runFreshAudit(strategyFile, days) {
    const relFile = strategyFile.replace(/\\/g, '/');
    const reportPath = path.join(ROOT, 'epoch3', 'reinvestigation_v2', `fresh_15m_strategy_audit_${safeOutputStem(relFile)}_${days}d.json`);
    if (boolEnv('FORCE_FRESH_AUDIT', false) || !fs.existsSync(reportPath)) {
        const result = spawnSync(process.execPath, ['scripts/fresh-15m-strategy-audit.js'], {
            cwd: ROOT,
            env: { ...process.env, STRATEGY_FILE: relFile, RECENT_DAYS: String(days) },
            encoding: 'utf8',
            timeout: numberEnv('GOVERNANCE_AUDIT_TIMEOUT_MS', 600000)
        });
        if (result.error) throw result.error;
        if (result.status !== 0) throw new Error(`fresh audit failed for ${relFile} ${days}d: ${(result.stderr || result.stdout || '').slice(-2000)}`);
    }
    return readJson(reportPath);
}

function summariseTriggered(report, days) {
    const rows = Array.isArray(report.results) ? report.results : [];
    const triggered = rows.filter((row) => row.triggered);
    const wins = triggered.filter((row) => row.won).length;
    const pnl = triggered.map((row) => Number(row.pnlPerShare)).filter(Number.isFinite);
    const winPnl = triggered.filter((row) => row.won).map((row) => Number(row.pnlPerShare)).filter(Number.isFinite);
    const lossPnl = triggered.filter((row) => row.won === false).map((row) => Number(row.pnlPerShare)).filter(Number.isFinite);
    const costs = triggered.map((row) => Number(row.costPerShare || row.effectiveEntry)).filter(Number.isFinite);
    const pLcb95 = wilsonLowerBound(wins, triggered.length, 1.96);
    const avgWinPnl = winPnl.length ? winPnl.reduce((a, b) => a + b, 0) / winPnl.length : quantile(pnl, 0.75) || 0;
    const avgLossPnl = lossPnl.length ? lossPnl.reduce((a, b) => a + b, 0) / lossPnl.length : -Math.max(0.65, quantile(costs, 0.75) || 0.65);
    const byRule = report.summary?.byStrategy || {};
    const ruleRows = Object.values(byRule).map((row) => ({
        id: row.id,
        name: row.name,
        triggered: Number(row.triggered || 0),
        wins: Number(row.wins || 0),
        losses: Number(row.losses || 0),
        winRate: Number.isFinite(Number(row.winRate)) ? Number(row.winRate) : null,
        avgPnlPerShare: Number.isFinite(Number(row.avgPnlPerShare)) ? Number(row.avgPnlPerShare) : null,
        lcb95: wilsonLowerBound(Number(row.wins || 0), Number(row.triggered || 0), 1.96)
    }));
    return {
        days,
        observations: Number(report.summary?.observations || rows.length),
        triggered: triggered.length,
        wins,
        losses: triggered.length - wins,
        winRate: triggered.length ? wins / triggered.length : null,
        wilsonWinRateLCB95: pLcb95,
        avgPnlPerShare: pnl.length ? pnl.reduce((a, b) => a + b, 0) / pnl.length : null,
        medianPnlPerShare: quantile(pnl, 0.5),
        p10PnlPerShare: quantile(pnl, 0.1),
        avgWinPnlPerShare: avgWinPnl,
        avgLossPnlPerShare: avgLossPnl,
        conservativePnlPerShare: pLcb95 * avgWinPnl + (1 - pLcb95) * avgLossPnl,
        triggersPerDay: days ? triggered.length / days : null,
        rules: ruleRows.length,
        minRuleTriggers: ruleRows.length ? Math.min(...ruleRows.map((row) => row.triggered)) : 0,
        worstRuleLCB95: ruleRows.length ? Math.min(...ruleRows.map((row) => row.lcb95)) : 0,
        weakRules: ruleRows.filter((row) => row.triggered < 10 || row.lcb95 < 0.5 || Number(row.avgPnlPerShare || 0) <= 0)
    };
}

function project7d(summary, bankroll) {
    const avgEntry = Math.max(0.01, numberEnv('GOVERNANCE_AVG_ENTRY_PRICE', 0.68));
    const minShares = Math.max(1, numberEnv('GOVERNANCE_MIN_SHARES', 5));
    const stakeFrac = Math.min(0.95, Math.max(0.01, numberEnv('GOVERNANCE_STAKE_FRACTION', 0.15)));
    return [
        ['adverse_lcb95', summary.triggersPerDay * 0.65, summary.conservativePnlPerShare],
        ['base_recent_mean', summary.triggersPerDay, summary.avgPnlPerShare || 0],
        ['optimistic_recent', summary.triggersPerDay * 1.15, summary.medianPnlPerShare || summary.avgPnlPerShare || 0]
    ].map(([name, tradesPerDay, pnlPerShare]) => {
        let b = bankroll;
        const daily = [];
        for (let day = 1; day <= 7; day += 1) {
            const costPerTrade = Math.max(minShares * avgEntry, b * stakeFrac);
            const shares = costPerTrade / avgEntry;
            const dailyPnl = tradesPerDay * shares * pnlPerShare;
            b += dailyPnl;
            daily.push({ day, tradesPerDay: round(tradesPerDay, 2), dailyPnl: round(dailyPnl, 2), endBankroll: round(b, 2) });
        }
        return { name, pnlPerShare: round(pnlPerShare, 4), daily, day7Bankroll: round(b, 2) };
    });
}

async function liveForwardSummary() {
    if (!boolEnv('FETCH_LIVE_TRADES', true)) return { fetched: false, reason: 'DISABLED' };
    try {
        const data = await fetchJson(process.env.LIVE_TRADES_URL || 'https://polyprophet.fly.dev/api/trades?limit=200');
        const recent = Array.isArray(data.recentTrades) ? data.recentTrades : [];
        const settled = recent.filter((trade) => String(trade.status || '').toUpperCase().includes('CLOSED') || trade.actualOutcome || trade.exitReason || trade.won !== undefined || Number.isFinite(Number(trade.pnl)));
        const pnlValues = settled.map((trade) => Number(trade.realizedPnl ?? trade.pnl ?? trade.profit ?? trade.netPnl)).filter(Number.isFinite);
        const wins = pnlValues.filter((value) => value > 0).length;
        return { fetched: true, endpointCount: data.counts || null, inspectedRecentTrades: recent.length, settledWithNumericPnl: pnlValues.length, wins, losses: pnlValues.filter((value) => value < 0).length, winRate: pnlValues.length ? wins / pnlValues.length : null, pnl: pnlValues.length ? pnlValues.reduce((a, b) => a + b, 0) : null, sampleAdequateForProjection: pnlValues.length >= 30 };
    } catch (error) {
        return { fetched: false, error: error.message };
    }
}

function verdictFor(current7d, source7d, live) {
    const issues = [];
    if (current7d.triggered < 100) issues.push('FRESH_SAMPLE_UNDER_100_TRIGGERS');
    if (current7d.minRuleTriggers < 10) issues.push('ONE_OR_MORE_RULES_UNDER_10_TRIGGERS');
    if (current7d.conservativePnlPerShare <= 0) issues.push('LCB95_CONSERVATIVE_EXPECTANCY_NOT_POSITIVE');
    if (source7d && current7d.triggersPerDay < source7d.triggersPerDay * 0.4) issues.push('CURRENT_MUCH_LOWER_FREQUENCY_THAN_SOURCE');
    if (!live.sampleAdequateForProjection) issues.push('LIVE_FORWARD_SAMPLE_UNDER_30_NUMERIC_SETTLED_TRADES');
    return { goForCurrentRisk: current7d.avgPnlPerShare > 0, noGoForSurefireClaim: true, noGoForRiskIncrease: issues.length > 0, confidence: issues.length === 0 ? 'MEDIUM' : 'LOW_TO_MEDIUM', issues };
}

async function main() {
    const currentFile = (process.env.CURRENT_STRATEGY_FILE || process.env.STRATEGY_SET_15M_PATH || DEFAULT_CURRENT).replace(/\\/g, '/');
    const sourceRaw = String(process.env.SOURCE_STRATEGY_FILE || DEFAULT_SOURCE).trim();
    const sourceFile = /^(none|skip|current-only)$/i.test(sourceRaw) ? null : sourceRaw.replace(/\\/g, '/');
    const horizons = String(process.env.GOVERNANCE_HORIZONS || '3,5,7').split(',').map((x) => Number(x.trim())).filter((x) => Number.isFinite(x) && x > 0);
    const bankroll = numberEnv('BANKROLL', 22.341031);
    const current = horizons.map((days) => summariseTriggered(runFreshAudit(currentFile, days), days));
    const source = sourceFile ? horizons.map((days) => summariseTriggered(runFreshAudit(sourceFile, days), days)) : [];
    const maxDays = Math.max(...horizons);
    const currentMax = current.find((row) => row.days === maxDays) || current[current.length - 1];
    const sourceMax = source.find((row) => row.days === maxDays) || source[source.length - 1] || null;
    const live = await liveForwardSummary();
    const output = {
        generatedAt: new Date().toISOString(),
        method: 'Fresh multi-horizon governance audit. Historical-only evidence is penalized by Wilson lower bounds and live-forward sample adequacy. This is not a profit guarantee.',
        currentStrategyFile: currentFile,
        sourceStrategyFile: sourceFile,
        bankroll,
        horizons,
        current: current.map((row) => ({ ...row, weakRules: row.weakRules.map((rule) => ({ ...rule, lcb95: round(rule.lcb95, 4), winRate: round(rule.winRate, 4), avgPnlPerShare: round(rule.avgPnlPerShare, 4) })) })),
        source: source.map((row) => ({ ...row, weakRules: row.weakRules.slice(0, 20).map((rule) => ({ ...rule, lcb95: round(rule.lcb95, 4), winRate: round(rule.winRate, 4), avgPnlPerShare: round(rule.avgPnlPerShare, 4) })) })),
        liveForward: live,
        sevenDayProjection: project7d(currentMax, bankroll),
        verdict: verdictFor(currentMax, sourceMax, live)
    };
    const outPath = path.join(ROOT, 'epoch3', 'reinvestigation_v2', `strategy_governance_audit_${safeOutputStem(currentFile)}.json`);
    writeJson(outPath, output);
    console.log(JSON.stringify(output, null, 2));
    console.log(`strategy governance audit saved: ${path.relative(ROOT, outPath)}`);
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});