/**
 * lib/strategy-validator.js — In-process POLYPROPHET strategy health monitor.
 *
 * Responsibilities:
 *   1. Watch rolling live-trade WR and trigger Telegram alerts on drift.
 *   2. Detect per-day WR collapse, drawdown alerts, and cooldown hits.
 *   3. Track age of the loaded strategy file and warn before 21d / 30d ceilings.
 *   4. Emit a single consolidated JSON report for API exposure.
 *
 * Designed to be safe inside the orchestrator tick — cheap, synchronous,
 * and never throws. Telegram pushes are fire-and-forget.
 */
const fs = require('fs');
const path = require('path');
const CONFIG = require('./config');
const telegram = require('./telegram');

const state = {
    lastCheckedAt: 0,
    lastPeriodicAt: 0,
    lastTradeCount: 0,
    strategyFileMtime: 0,
    strategyFilePath: '',
    lastReport: null,
    firedSeverities: {},  // key → lastFiredMs (to rate-limit alerts)
    cooldownPreviousState: false,
    haltPreviousState: { error: false, tradeFailure: false }
};

const ALERT_MIN_INTERVAL_MS = 30 * 60 * 1000;  // same-kind alerts max every 30min

function _now() { return Date.now(); }

function _wilsonLowerBound(wins, total, z = 1.96) {
    if (!total || total <= 0) return 0;
    const p = wins / total;
    const denom = 1 + (z * z) / total;
    const centre = p + (z * z) / (2 * total);
    const margin = z * Math.sqrt((p * (1 - p) + (z * z) / (4 * total)) / total);
    return Math.max(0, (centre - margin) / denom);
}

function _shouldFire(key) {
    const last = state.firedSeverities[key] || 0;
    if (_now() - last < ALERT_MIN_INTERVAL_MS) return false;
    state.firedSeverities[key] = _now();
    return true;
}

function _clearFired(key) {
    delete state.firedSeverities[key];
}

function _getStrategyFileStat(activeFiles) {
    // activeFiles: array of absolute paths returned from strategy-matcher.getAllLoadedSets()
    if (!Array.isArray(activeFiles) || activeFiles.length === 0) {
        return { path: '', mtime: 0, ageDays: null };
    }
    let best = { path: '', mtime: 0 };
    for (const p of activeFiles) {
        try {
            const st = fs.statSync(p);
            if (!best.mtime || st.mtimeMs < best.mtime) {
                best = { path: p, mtime: st.mtimeMs };
            }
        } catch (e) {
            // ignore missing files
        }
    }
    if (!best.mtime) return { path: '', mtime: 0, ageDays: null };
    const ageDays = (_now() - best.mtime) / (1000 * 60 * 60 * 24);
    return { path: best.path, mtime: best.mtime, ageDays };
}

function _deriveTradeWindow(tradeLog, cutoffMs = null) {
    const trades = Array.isArray(tradeLog) ? tradeLog : [];
    const filtered = cutoffMs
        ? trades.filter((t) => new Date(t.ts || 0).getTime() >= cutoffMs)
        : trades;
    const wins = filtered.filter((t) => !!t.won).length;
    const total = filtered.length;
    return { total, wins, wr: total ? wins / total : null };
}

function _buildReport({ risk, executor, strategyFile, deployInfo }) {
    const vCfg = CONFIG.STRATEGY_VALIDATOR || {};
    const lines = [];
    const alerts = [];
    let severity = 'INFO';

    const tradeLog = Array.isArray(risk?.recentTrades) ? risk.recentTrades : [];
    const totalTrades = Number(risk?.totalTrades || 0);
    const consecutiveLosses = Number(risk?.consecutiveLosses || 0);
    const peakBalance = Number(risk?.peakBalance || 0);
    const bankroll = Number(risk?.bankroll || 0);
    const drawdownPct = peakBalance > 0 ? (peakBalance - bankroll) / peakBalance : 0;

    const last20 = _deriveTradeWindow(tradeLog.slice(-20));
    const last50 = _deriveTradeWindow(tradeLog.slice(-50));
    const last100 = _deriveTradeWindow(tradeLog.slice(-100));

    lines.push(`TotalTrades: ${totalTrades} | ConsecLoss: ${consecutiveLosses} | DD: ${(drawdownPct * 100).toFixed(1)}%`);
    if (last20.total >= 10) lines.push(`Last 20: ${last20.total}t ${(last20.wr * 100).toFixed(1)}% WR (LCB=${(_wilsonLowerBound(last20.wins, last20.total) * 100).toFixed(1)}%)`);
    if (last50.total >= 30) lines.push(`Last 50: ${last50.total}t ${(last50.wr * 100).toFixed(1)}% WR (LCB=${(_wilsonLowerBound(last50.wins, last50.total) * 100).toFixed(1)}%)`);
    if (last100.total >= 60) lines.push(`Last 100: ${last100.total}t ${(last100.wr * 100).toFixed(1)}% WR`);

    // ---- Rolling WR drift (hard-kill triggers) ----
    if (last20.total >= 20 && last20.wr < Number(vCfg.rolling20WrFloor)) {
        alerts.push({ key: 'ROLLING20_WR_LOW', severity: 'CRITICAL', msg: `Rolling 20-trade WR ${(last20.wr * 100).toFixed(1)}% < ${(vCfg.rolling20WrFloor * 100).toFixed(0)}% floor` });
    }
    if (last50.total >= 50 && last50.wr < Number(vCfg.rolling50WrFloor)) {
        alerts.push({ key: 'ROLLING50_WR_LOW', severity: 'CRITICAL', msg: `Rolling 50-trade WR ${(last50.wr * 100).toFixed(1)}% < ${(vCfg.rolling50WrFloor * 100).toFixed(0)}% floor` });
    }
    if (last100.total >= 100 && last100.wr < Number(vCfg.rolling100WrFloor)) {
        alerts.push({ key: 'ROLLING100_WR_LOW', severity: 'WARN', msg: `Rolling 100-trade WR ${(last100.wr * 100).toFixed(1)}% < ${(vCfg.rolling100WrFloor * 100).toFixed(0)}% floor` });
    }

    // ---- Per-day WR collapse ----
    const dayStart = new Date();
    dayStart.setUTCHours(0, 0, 0, 0);
    const today = _deriveTradeWindow(tradeLog, dayStart.getTime());
    if (today.total >= Number(vCfg.dailyMinTradesForWrCheck) && today.wr !== null && today.wr < Number(vCfg.dailyWrFloor)) {
        alerts.push({ key: 'DAILY_WR_COLLAPSE', severity: 'CRITICAL', msg: `Today ${today.total}t ${(today.wr * 100).toFixed(1)}% WR < ${(vCfg.dailyWrFloor * 100).toFixed(0)}% floor` });
    }

    // ---- Drawdown alerts ----
    if (peakBalance > 0 && drawdownPct >= Number(vCfg.drawdownCriticalPct)) {
        alerts.push({ key: 'DRAWDOWN_CRITICAL', severity: 'CRITICAL', msg: `Drawdown ${(drawdownPct * 100).toFixed(1)}% from peak ${peakBalance.toFixed(2)}` });
    } else if (peakBalance > 0 && drawdownPct >= Number(vCfg.drawdownAlertPct)) {
        alerts.push({ key: 'DRAWDOWN_WARN', severity: 'WARN', msg: `Drawdown ${(drawdownPct * 100).toFixed(1)}% from peak ${peakBalance.toFixed(2)}` });
    }

    // ---- Strategy file age ----
    const fileStat = strategyFile || { path: '', mtime: 0, ageDays: null };
    if (Number.isFinite(fileStat.ageDays)) {
        lines.push(`Strategy: ${path.basename(fileStat.path)} (age: ${fileStat.ageDays.toFixed(1)}d)`);
        if (fileStat.ageDays >= Number(vCfg.strategyMaxAgeDaysCritical)) {
            alerts.push({ key: 'STRATEGY_AGE_CRITICAL', severity: 'CRITICAL', msg: `Strategy file ${fileStat.ageDays.toFixed(1)}d old >= ${vCfg.strategyMaxAgeDaysCritical}d hard ceiling. Retrain v6 REQUIRED.` });
        } else if (fileStat.ageDays >= Number(vCfg.strategyMaxAgeDaysWarn)) {
            alerts.push({ key: 'STRATEGY_AGE_WARN', severity: 'WARN', msg: `Strategy file ${fileStat.ageDays.toFixed(1)}d old >= ${vCfg.strategyMaxAgeDaysWarn}d warn threshold. Schedule retrain.` });
        }
    }

    // ---- Severity aggregation ----
    for (const a of alerts) {
        if (a.severity === 'CRITICAL') severity = 'CRITICAL';
        else if (a.severity === 'WARN' && severity !== 'CRITICAL') severity = 'WARN';
    }

    return {
        generatedAt: new Date().toISOString(),
        severity,
        summary: alerts.length ? alerts.map((a) => `[${a.severity}] ${a.msg}`).join(' | ') : 'All checks passed',
        lines,
        alerts,
        windows: { last20, last50, last100, today },
        drawdownPct,
        strategyFile: fileStat,
        deployInfo: deployInfo || null
    };
}

/**
 * Run a validator pass. Returns a report. Triggers Telegram alerts when needed.
 *
 * @param {object} context
 * @param {object} context.risk      - risk manager status object (from getStatus())
 * @param {object} context.executor  - executor status object (from getStatus())
 * @param {string[]} context.activeStrategyFiles - array of loaded strategy file paths
 * @param {object} context.deployInfo - { deployVersion, mode, isLive }
 * @param {string} context.trigger   - label e.g. 'TRADE_BATCH' | 'PERIODIC' | 'MANUAL'
 */
function runCheck(context = {}) {
    const vCfg = CONFIG.STRATEGY_VALIDATOR || {};
    if (!vCfg.enabled) return null;

    const strategyFile = _getStrategyFileStat(context.activeStrategyFiles || []);
    const report = _buildReport({
        risk: context.risk || {},
        executor: context.executor || {},
        strategyFile,
        deployInfo: context.deployInfo
    });
    report.trigger = String(context.trigger || 'PERIODIC');

    state.lastReport = report;
    state.lastCheckedAt = _now();
    state.strategyFilePath = strategyFile.path;
    state.strategyFileMtime = strategyFile.mtime;

    // Fire Telegram alerts with rate-limiting per alert-kind
    for (const alert of report.alerts) {
        if (!_shouldFire(alert.key)) continue;
        telegram.notifyValidatorAlert({
            kind: alert.key,
            severity: alert.severity,
            summary: alert.msg,
            lines: report.lines
        });
    }

    // Clear rate-limit keys that didn't fire this round — so a later re-trip alerts again
    const firedThisRound = new Set(report.alerts.map((a) => a.key));
    for (const key of Object.keys(state.firedSeverities)) {
        if (!firedThisRound.has(key)) {
            const last = state.firedSeverities[key] || 0;
            if (_now() - last > ALERT_MIN_INTERVAL_MS * 2) _clearFired(key);
        }
    }

    return report;
}

/**
 * Decide whether to run the validator this tick. Cheap.
 * Call from orchestrator tick on every run — it short-circuits when not needed.
 */
function maybeRunCheck(context = {}) {
    const vCfg = CONFIG.STRATEGY_VALIDATOR || {};
    if (!vCfg.enabled) return null;
    const totalTrades = Number(context.risk?.totalTrades || 0);
    const since = _now() - state.lastPeriodicAt;
    const tradeDelta = totalTrades - state.lastTradeCount;
    const batch = Number(vCfg.tradeBatchInterval || 20);
    const periodic = Number(vCfg.periodicCheckIntervalMs || 3600000);

    if (tradeDelta >= batch) {
        state.lastTradeCount = totalTrades;
        state.lastPeriodicAt = _now();
        return runCheck({ ...context, trigger: 'TRADE_BATCH' });
    }
    if (!state.lastPeriodicAt || since >= periodic) {
        state.lastPeriodicAt = _now();
        state.lastTradeCount = totalTrades;
        return runCheck({ ...context, trigger: 'PERIODIC' });
    }
    return null;
}

function getLastReport() {
    return state.lastReport;
}

module.exports = {
    runCheck,
    maybeRunCheck,
    getLastReport
};
