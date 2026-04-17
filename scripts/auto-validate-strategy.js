#!/usr/bin/env node
/**
 * scripts/auto-validate-strategy.js
 *
 * Scheduled strategy health validator (CLI entrypoint). Intended cadence:
 *   - every 50 live trades (or every 3-7 days, whichever comes first)
 *   - daily as a lightweight sanity check on recent OOS replay
 *
 * What it does:
 *   1. Loads the live strategy file (LIVE_STRATEGY_FILE_15M or default).
 *   2. Loads intracycle OOS data (data/intracycle-price-data.json).
 *   3. Slices a TRAILING OOS window (default: last 7 days) — simulates strategy
 *      replay + runtime-parity bankroll sim (SF=0.15 + MPC=1).
 *   4. Compares current-window WR vs strategy artifact's stated OOS WR.
 *   5. Compares against live recent trades (runtime-state.json) when available.
 *   6. Writes a JSON report to debug/validator/validator-<ts>.json.
 *   7. Fires a Telegram notifyValidatorAlert on any WARN/CRITICAL severity
 *      (notify-only — never mutates state or swaps strategies).
 *
 * Usage:
 *   node scripts/auto-validate-strategy.js [--days N] [--no-telegram]
 *
 * Exit codes:
 *   0 = OK
 *   1 = internal error
 *   2 = WARN (degradation warning)
 *   3 = CRITICAL (hard kill condition)
 */
const fs = require('fs');
const path = require('path');

const CONFIG = require('../lib/config');
const telegram = require('../lib/telegram');

const REPO_ROOT = path.join(__dirname, '..');
const REPORT_DIR = path.join(REPO_ROOT, 'debug', 'validator');

function ensureDir(p) { fs.mkdirSync(p, { recursive: true }); }

function parseArgs(argv) {
    const out = { days: 7, telegram: true, strategy: null };
    for (let i = 2; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--days') out.days = parseInt(argv[++i], 10) || out.days;
        else if (a === '--no-telegram') out.telegram = false;
        else if (a === '--strategy') out.strategy = argv[++i];
    }
    return out;
}

function resolveStrategyPath(explicit) {
    if (explicit) return path.resolve(REPO_ROOT, explicit);
    const envFile = String(process.env.LIVE_STRATEGY_FILE_15M || process.env.STRATEGY_FILE_15M || '').trim();
    if (envFile) return path.resolve(REPO_ROOT, envFile);
    return path.join(REPO_ROOT, 'strategies', 'strategy_set_15m_optimal_10usd_v5.json');
}

function loadJson(file) {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function wilsonLCB(wins, total, z = 1.96) {
    if (!total) return 0;
    const p = wins / total;
    const denom = 1 + (z * z) / total;
    const centre = p + (z * z) / (2 * total);
    const margin = z * Math.sqrt((p * (1 - p) + (z * z) / (4 * total)) / total);
    return Math.max(0, (centre - margin) / denom);
}

function sliceTrailingCycles(cycles, days) {
    const cutoff = Math.floor((Date.now() - days * 24 * 3600 * 1000) / 1000);
    return cycles.filter((c) => (c.epoch || 0) >= cutoff);
}

function replaySignals(strategy, cycles) {
    const strats = strategy.strategies || [];
    const cycleSignals = new Map();
    for (const c of cycles) {
        const h = new Date(c.epoch * 1000).getUTCHours();
        for (const s of strats) {
            if (s.utcHour !== h) continue;
            const entryPrice = s.direction === 'UP'
                ? c.minutePricesYes?.[s.entryMinute]?.last
                : c.minutePricesNo?.[s.entryMinute]?.last;
            if (!Number.isFinite(entryPrice) || entryPrice < s.priceMin || entryPrice > s.priceMax) continue;
            if (!c.resolution) continue;
            const sig = {
                epoch: c.epoch,
                minute: s.entryMinute,
                timestamp: c.epoch + s.entryMinute * 60,
                asset: c.asset,
                strategy: s.name,
                tier: s.tier || 'A',
                direction: s.direction,
                entryPrice,
                pWin: s.pWinEstimate || s.winRate || 0.9,
                won: s.direction === c.resolution
            };
            if (!cycleSignals.has(c.epoch)) cycleSignals.set(c.epoch, []);
            cycleSignals.get(c.epoch).push(sig);
        }
    }
    const firingEvents = [];
    for (const [, sigs] of cycleSignals) {
        const earliestMinute = Math.min(...sigs.map((sig) => sig.minute));
        const earliest = sigs.filter((sig) => sig.minute === earliestMinute);
        earliest.sort((a, b) => (b.pWin - a.pWin));
        firingEvents.push(earliest[0]);
    }
    firingEvents.sort((a, b) => a.timestamp - b.timestamp);
    return firingEvents;
}

function aggregateWindow(signals) {
    const wins = signals.filter((s) => s.won).length;
    const total = signals.length;
    const byDay = {};
    for (const s of signals) {
        const day = new Date(s.timestamp * 1000).toISOString().slice(0, 10);
        byDay[day] = byDay[day] || { total: 0, wins: 0 };
        byDay[day].total++;
        if (s.won) byDay[day].wins++;
    }
    let maxConsecLoss = 0, cur = 0;
    for (const s of signals) {
        if (!s.won) { cur++; if (cur > maxConsecLoss) maxConsecLoss = cur; }
        else cur = 0;
    }
    return { wins, total, wr: total ? wins / total : null, byDay, maxConsecLoss };
}

function readRuntimeState() {
    const p = path.join(REPO_ROOT, 'data', 'runtime-state.json');
    try {
        if (!fs.existsSync(p)) return null;
        return JSON.parse(fs.readFileSync(p, 'utf8'));
    } catch (e) {
        return null;
    }
}

function recentLiveTrades(runtimeState, days) {
    if (!runtimeState?.risk?.tradeLog) return [];
    const cutoff = Date.now() - days * 24 * 3600 * 1000;
    return runtimeState.risk.tradeLog.filter((t) => new Date(t.ts || 0).getTime() >= cutoff);
}

function main() {
    const args = parseArgs(process.argv);
    ensureDir(REPORT_DIR);

    const stratPath = resolveStrategyPath(args.strategy);
    if (!fs.existsSync(stratPath)) {
        console.error(`❌ Strategy file not found: ${stratPath}`);
        return 1;
    }
    const dataPath = path.join(REPO_ROOT, 'data', 'intracycle-price-data.json');
    if (!fs.existsSync(dataPath)) {
        console.error(`❌ Data file not found: ${dataPath}`);
        return 1;
    }

    const strategy = loadJson(stratPath);
    const rawData = loadJson(dataPath);
    const cycles = Array.isArray(rawData) ? rawData : (rawData.cycles || []);
    if (!cycles.length) {
        console.error('❌ No cycles in intracycle-price-data.json');
        return 1;
    }

    const trailing = sliceTrailingCycles(cycles, args.days);
    console.log(`Validator window: last ${args.days}d — ${trailing.length} cycles`);
    const events = replaySignals(strategy, trailing);
    const agg = aggregateWindow(events);
    const expectedOosWr = Number(strategy?.projections?.oosWR ?? strategy?.projections?.fullWR ?? 0.88);
    const expectedFullWr = Number(strategy?.projections?.fullWR ?? 0.88);

    const runtimeState = readRuntimeState();
    const liveTrades = recentLiveTrades(runtimeState, args.days);
    const liveWins = liveTrades.filter((t) => t.won).length;
    const liveWr = liveTrades.length ? liveWins / liveTrades.length : null;
    const liveLcb = liveTrades.length >= 20 ? wilsonLCB(liveWins, liveTrades.length) : null;

    // ---------- Severity scoring ----------
    const vCfg = CONFIG.STRATEGY_VALIDATOR || {};
    const alerts = [];
    const lines = [];
    let severity = 'INFO';

    if (agg.total > 0 && Number.isFinite(agg.wr)) {
        const degradation = expectedOosWr - agg.wr;
        lines.push(`Trailing OOS: ${agg.total}t ${(agg.wr * 100).toFixed(1)}% WR (expected ${(expectedOosWr * 100).toFixed(1)}%, Δ ${-degradation >= 0 ? '+' : ''}${(-degradation * 100).toFixed(1)}pp)`);
        if (degradation >= 0.10) alerts.push({ key: 'OOS_FADE_CRITICAL', severity: 'CRITICAL', msg: `Trailing OOS WR fades ${(degradation * 100).toFixed(1)}pp below artifact projection` });
        else if (degradation >= 0.05) alerts.push({ key: 'OOS_FADE_WARN', severity: 'WARN', msg: `Trailing OOS WR fades ${(degradation * 100).toFixed(1)}pp below artifact projection` });
    }

    if (liveTrades.length >= 20 && Number.isFinite(liveWr)) {
        lines.push(`Live recent: ${liveTrades.length}t ${(liveWr * 100).toFixed(1)}% WR (LCB ${(liveLcb * 100).toFixed(1)}%)`);
        if (liveWr < Number(vCfg.rolling50WrFloor || 0.76) && liveTrades.length >= 50) {
            alerts.push({ key: 'LIVE_ROLLING50_WR_LOW', severity: 'CRITICAL', msg: `Live rolling 50-trade WR ${(liveWr * 100).toFixed(1)}% < ${(vCfg.rolling50WrFloor * 100).toFixed(0)}% floor` });
        } else if (liveWr < Number(vCfg.rolling20WrFloor || 0.65) && liveTrades.length >= 20) {
            alerts.push({ key: 'LIVE_ROLLING20_WR_LOW', severity: 'CRITICAL', msg: `Live rolling 20-trade WR ${(liveWr * 100).toFixed(1)}% < ${(vCfg.rolling20WrFloor * 100).toFixed(0)}% floor` });
        }
    } else {
        lines.push(`Live trades (last ${args.days}d): ${liveTrades.length} — insufficient for drift test`);
    }

    // Strategy age
    const strategyStat = fs.statSync(stratPath);
    const ageDays = (Date.now() - strategyStat.mtimeMs) / (1000 * 60 * 60 * 24);
    lines.push(`Strategy file: ${path.basename(stratPath)} (${ageDays.toFixed(1)}d old)`);
    const warnAge = Number(vCfg.strategyMaxAgeDaysWarn || 21);
    const critAge = Number(vCfg.strategyMaxAgeDaysCritical || 30);
    if (ageDays >= critAge) alerts.push({ key: 'STRATEGY_AGE_CRITICAL', severity: 'CRITICAL', msg: `Strategy file ${ageDays.toFixed(1)}d old >= ${critAge}d ceiling. Retrain REQUIRED.` });
    else if (ageDays >= warnAge) alerts.push({ key: 'STRATEGY_AGE_WARN', severity: 'WARN', msg: `Strategy file ${ageDays.toFixed(1)}d old >= ${warnAge}d warn threshold.` });

    // Max consec loss + daily breakdown (visual only)
    if (agg.maxConsecLoss >= 4) alerts.push({ key: 'MAX_CONSEC_LOSS_HIGH', severity: 'WARN', msg: `Trailing OOS max consec loss = ${agg.maxConsecLoss}` });
    const days = Object.keys(agg.byDay).sort();
    for (const d of days) {
        const { total, wins } = agg.byDay[d];
        if (total >= 10 && wins / total < Number(vCfg.dailyWrFloor || 0.70)) {
            alerts.push({ key: `DAILY_WR_${d}`, severity: 'WARN', msg: `OOS ${d}: ${total}t ${(wins / total * 100).toFixed(1)}% WR below daily floor` });
        }
    }

    // Aggregate severity
    for (const a of alerts) {
        if (a.severity === 'CRITICAL') severity = 'CRITICAL';
        else if (a.severity === 'WARN' && severity !== 'CRITICAL') severity = 'WARN';
    }

    const report = {
        generatedAt: new Date().toISOString(),
        trigger: 'CLI_AUTO_VALIDATE',
        severity,
        summary: alerts.length
            ? alerts.slice(0, 4).map((a) => `[${a.severity}] ${a.msg}`).join(' | ')
            : `OK — trailing ${args.days}d WR ${(agg.wr * 100).toFixed(1)}% vs expected ${(expectedOosWr * 100).toFixed(1)}%`,
        lines,
        alerts,
        strategy: {
            path: stratPath,
            name: strategy?.name,
            projections: strategy?.projections,
            ageDays
        },
        windowDays: args.days,
        trailingOos: {
            total: agg.total,
            wins: agg.wins,
            wr: agg.wr,
            maxConsecLoss: agg.maxConsecLoss,
            byDay: agg.byDay
        },
        expectedOosWr,
        expectedFullWr,
        live: {
            tradeCount: liveTrades.length,
            wins: liveWins,
            wr: liveWr,
            lcb: liveLcb
        }
    };

    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const outPath = path.join(REPORT_DIR, `validator-${ts}.json`);
    fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
    console.log(`\n=== VALIDATOR REPORT (${severity}) ===`);
    console.log(report.summary);
    for (const l of lines) console.log(`  ${l}`);
    console.log(`\nReport: ${outPath}`);

    if (args.telegram && severity !== 'INFO') {
        telegram.notifyValidatorAlert({
            kind: `AUTO_VALIDATE_${args.days}D`,
            severity,
            summary: report.summary,
            lines
        });
    } else if (args.telegram) {
        // Low-priority OK ping once per day is fine; keep LOW so quiet hours digest
        telegram.sendMessage(
            `ℹ️ <b>VALIDATOR OK</b> (${args.days}d)\n` +
            `${(agg.wr * 100).toFixed(1)}% WR on ${agg.total}t\n` +
            (liveTrades.length >= 20 ? `Live: ${(liveWr * 100).toFixed(1)}% on ${liveTrades.length}t\n` : '') +
            `File age: ${ageDays.toFixed(1)}d`,
            telegram.PRIORITY.LOW
        );
    }

    if (severity === 'CRITICAL') return 3;
    if (severity === 'WARN') return 2;
    return 0;
}

try {
    const code = main();
    process.exit(code || 0);
} catch (e) {
    console.error(`Validator error: ${e.stack || e.message}`);
    try { telegram.notifyError('auto-validate-strategy', e); } catch {}
    process.exit(1);
}
