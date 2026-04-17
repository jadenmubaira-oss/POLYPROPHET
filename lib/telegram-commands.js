/**
 * lib/telegram-commands.js — Inbound command handler for POLYPROPHET's Telegram bot.
 *
 * Uses Telegram's long-polling getUpdates endpoint. No webhook infra required.
 * Only responds to messages from the configured `TELEGRAM_CHAT_ID` (owner guard).
 *
 * Supported commands:
 *   /help                 — list commands
 *   /status               — compact live status (balance, WR, halts, posture)
 *   /balance              — just the balance + source
 *   /wr                   — rolling 20/50/100-trade WR with Wilson LCB
 *   /recent [N]           — last N trades (default 10, max 25)
 *   /next                 — upcoming best OOS entry window (next 6h)
 *   /health               — full validator report
 *   /pause                — pause trading (sets tradingPaused=true)
 *   /resume               — resume trading (+ clears error/trade-fail halts)
 *   /verbosity LVL        — set TELEGRAM verbosity runtime (SILENT|CRITICAL_ONLY|QUIET|NORMAL|VERBOSE)
 *   /id                   — show your chat id (for setup)
 *
 * Start with `startCommandLoop(deps)` — deps supplied by server.js.
 */
const https = require('https');
const path = require('path');
const fs = require('fs');
const CONFIG = require('./config');
const telegram = require('./telegram');

let updateOffset = 0;
let loopTimer = null;
let running = false;
let deps = null;

// ---------- HTTP helpers ----------
function getJson(pathname, attempt = 0) {
    return new Promise((resolve) => {
        const options = {
            hostname: 'api.telegram.org',
            path: pathname,
            method: 'GET',
            timeout: 60000
        };
        const req = https.request(options, (res) => {
            let data = '';
            res.on('data', (c) => { data += c; });
            res.on('end', () => {
                try {
                    resolve(JSON.parse(data));
                } catch (e) {
                    resolve(null);
                }
            });
        });
        req.on('error', () => resolve(null));
        req.on('timeout', () => { req.destroy(); resolve(null); });
        req.end();
    });
}

function replyText(text) {
    // fire-and-forget direct send. Bypass verbosity gating so replies always work.
    if (!CONFIG.TELEGRAM.enabled || !CONFIG.TELEGRAM.botToken || !CONFIG.TELEGRAM.chatId) return;
    const payload = JSON.stringify({
        chat_id: CONFIG.TELEGRAM.chatId,
        text,
        parse_mode: 'HTML',
        disable_web_page_preview: true
    });
    const options = {
        hostname: 'api.telegram.org',
        path: `/bot${CONFIG.TELEGRAM.botToken}/sendMessage`,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
    };
    const req = https.request(options, (res) => {
        res.on('data', () => {});
        res.on('end', () => {});
    });
    req.on('error', () => {});
    req.write(payload);
    req.end();
}

function escHtml(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
function fmtUsd(v) { return `$${Number(v || 0).toFixed(2)}`; }

function wilson(wins, total, z = 1.96) {
    if (!total || total <= 0) return 0;
    const p = wins / total;
    const denom = 1 + (z * z) / total;
    const centre = p + (z * z) / (2 * total);
    const margin = z * Math.sqrt((p * (1 - p) + (z * z) / (4 * total)) / total);
    return Math.max(0, (centre - margin) / denom);
}

// ---------- Command handlers ----------
function cmdHelp() {
    replyText(
        `<b>POLYPROPHET commands</b>\n` +
        `/status — live posture\n` +
        `/balance — usdc balance\n` +
        `/wr — rolling win rate\n` +
        `/recent [N] — last N trades (def 10, max 25)\n` +
        `/next — upcoming entry windows (6h)\n` +
        `/health — validator report\n` +
        `/pause — pause trading\n` +
        `/resume — resume trading &amp; clear halts\n` +
        `/verbosity LVL — SILENT|CRITICAL_ONLY|QUIET|NORMAL|VERBOSE\n` +
        `/id — show your chat id`
    );
}

function cmdStatus() {
    try {
        const risk = deps.riskManager.getStatus();
        const exec = deps.tradeExecutor.getStatus();
        const pending = exec.pendingBuys.length + exec.pendingSells.length + exec.pendingSettlements.length;
        const halts = deps.getHalts?.() || { errorHalt: false, tradeFailureHalt: false };
        const bal = exec.mode === 'LIVE' ? Number(exec.liveBalance || 0) : Number(risk.bankroll || 0);
        const mode = `${exec.mode}${CONFIG.IS_LIVE ? ' 🔴' : ''}`;
        const paused = risk.tradingPaused ? '⏸️ PAUSED' : (risk.inCooldown ? `⏳ cooldown ${risk.cooldownRemaining}s` : '✅ active');
        const lines = [
            `<b>STATUS</b> ${paused}`,
            `Mode: ${mode}`,
            `Balance: <b>${fmtUsd(bal)}</b>  (peak ${fmtUsd(risk.peakBalance)})`,
            `Today P&amp;L: ${Number(risk.todayPnL || 0) >= 0 ? '+' : ''}${fmtUsd(risk.todayPnL)}`,
            `Trades: ${risk.totalTrades} (${risk.winRate}% WR)`,
            `ConsecLoss: ${risk.consecutiveLosses} | DD: ${risk.drawdownFromPeak}%`,
            `Pending: buys=${exec.pendingBuys.length} sells=${exec.pendingSells.length} settle=${exec.pendingSettlements.length}`,
            `Open positions: ${exec.openPositions} (exposure ${fmtUsd(exec.openExposureUsd)})`,
            (halts.errorHalt || halts.tradeFailureHalt) ? `🛑 Halts: error=${halts.errorHalt} tradeFail=${halts.tradeFailureHalt}` : null
        ].filter(Boolean);
        replyText(lines.join('\n'));
    } catch (e) {
        replyText(`error: ${escHtml(e.message)}`);
    }
}

function cmdBalance() {
    try {
        const breakdown = deps.tradeExecutor.getCachedBalanceBreakdown?.() || {};
        const lines = [
            `<b>BALANCE</b>`,
            `Usable: <b>${fmtUsd(breakdown.tradingBalanceUsdc)}</b>`,
            `On-chain: ${fmtUsd(breakdown.onChainUsdc)}`,
            `CLOB collateral: ${fmtUsd(breakdown.clobCollateralUsdc)}`,
            `Source: ${escHtml(breakdown.sourceLabel || breakdown.source || 'unknown')}`,
            breakdown.stale ? `⚠️ Balance is stale` : null,
            breakdown.updatedIso ? `Updated: ${escHtml(breakdown.updatedIso)}` : null
        ].filter(Boolean);
        replyText(lines.join('\n'));
    } catch (e) {
        replyText(`error: ${escHtml(e.message)}`);
    }
}

function cmdWr() {
    try {
        const risk = deps.riskManager.getStatus();
        const log = Array.isArray(risk.recentTrades) ? risk.recentTrades : [];
        const windows = [20, 50, 100];
        const out = [`<b>ROLLING WIN RATE</b>`];
        for (const n of windows) {
            const slice = log.slice(-n);
            if (!slice.length) continue;
            const wins = slice.filter((t) => t.won).length;
            const total = slice.length;
            const wr = total ? (wins / total * 100).toFixed(1) : 'N/A';
            const lcb = total >= 10 ? (wilson(wins, total) * 100).toFixed(1) + '%' : 'low-n';
            out.push(`Last ${total}: ${wr}% WR (LCB ${lcb})`);
        }
        const cutoff = new Date(); cutoff.setUTCHours(0, 0, 0, 0);
        const today = log.filter((t) => new Date(t.ts || 0).getTime() >= cutoff.getTime());
        if (today.length > 0) {
            const w = today.filter((t) => t.won).length;
            out.push(`Today: ${today.length}t ${(w / today.length * 100).toFixed(1)}% WR`);
        }
        replyText(out.join('\n'));
    } catch (e) {
        replyText(`error: ${escHtml(e.message)}`);
    }
}

function cmdRecent(argStr) {
    try {
        const n = Math.min(25, Math.max(1, parseInt(argStr, 10) || 10));
        const risk = deps.riskManager.getStatus();
        const log = Array.isArray(risk.recentTrades) ? risk.recentTrades.slice(-n) : [];
        if (!log.length) return replyText('No recent trades.');
        const rows = log.map((t) => {
            const icon = t.won ? '✅' : '❌';
            const pnl = Number(t.pnl || 0);
            const pnlStr = `${pnl >= 0 ? '+' : ''}${pnl.toFixed(2)}`;
            return `${icon} ${t.ts?.slice(5, 16)}  ${t.asset}/${t.timeframe} ${t.direction} @${(Number(t.entryPrice || 0) * 100).toFixed(0)}¢  ${pnlStr}`;
        });
        replyText(`<b>LAST ${log.length} TRADES</b>\n<code>${escHtml(rows.join('\n'))}</code>`);
    } catch (e) {
        replyText(`error: ${escHtml(e.message)}`);
    }
}

function cmdNext() {
    try {
        const windows = deps.getUpcomingWindows?.(6) || null;
        if (!windows || windows.length === 0) {
            return replyText('No upcoming OOS windows computable. Check /api/health.');
        }
        const rows = windows.slice(0, 12).map((w) => {
            return `${w.timeIso} tier=${w.tier} WR=${(w.oosWr * 100).toFixed(1)}% n=${w.trades} ${w.asset || 'any'} ${w.direction}`;
        });
        replyText(`<b>NEXT 6H ENTRY WINDOWS</b>\n<code>${escHtml(rows.join('\n'))}</code>`);
    } catch (e) {
        replyText(`error: ${escHtml(e.message)}`);
    }
}

function cmdHealth() {
    try {
        const report = deps.runValidator?.();
        if (!report) return replyText('Validator disabled or no data.');
        const out = [
            `<b>HEALTH: ${escHtml(report.severity)}</b>`,
            `Trigger: ${escHtml(report.trigger || 'MANUAL')}`,
            report.summary,
            '',
            ...report.lines.slice(0, 12)
        ];
        if (report.alerts?.length) {
            out.push('');
            out.push('<b>Alerts</b>:');
            for (const a of report.alerts.slice(0, 8)) {
                out.push(`• [${a.severity}] ${escHtml(a.msg)}`);
            }
        }
        replyText(out.join('\n'));
    } catch (e) {
        replyText(`error: ${escHtml(e.message)}`);
    }
}

function cmdPause() {
    try {
        deps.riskManager.tradingPaused = true;
        deps.saveRuntimeState?.();
        replyText('⏸️ Trading paused. Use /resume to re-enable.');
    } catch (e) {
        replyText(`error: ${escHtml(e.message)}`);
    }
}

function cmdResume() {
    try {
        deps.riskManager.tradingPaused = false;
        deps.clearHalts?.();
        deps.saveRuntimeState?.();
        replyText('✅ Trading resumed. Halts cleared.');
    } catch (e) {
        replyText(`error: ${escHtml(e.message)}`);
    }
}

function cmdVerbosity(arg) {
    const valid = ['SILENT', 'CRITICAL_ONLY', 'QUIET', 'NORMAL', 'VERBOSE'];
    const up = String(arg || '').trim().toUpperCase();
    if (!valid.includes(up)) {
        return replyText(`Usage: /verbosity ${valid.join('|')}`);
    }
    CONFIG.TELEGRAM.verbosity = up;
    replyText(`Verbosity set to <b>${up}</b>.`);
}

function cmdId(chatId) {
    replyText(`Your chat id: <code>${escHtml(String(chatId))}</code>`);
}

// ---------- Dispatcher ----------
function handleMessage(message) {
    const chatId = message?.chat?.id;
    const text = String(message?.text || '').trim();
    if (!chatId || !text) return;
    const ownerChat = String(CONFIG.TELEGRAM.chatId || '');
    if (String(chatId) !== ownerChat) {
        replyText('⚠️ Unauthorized chat id.');
        return;
    }
    const [raw, ...rest] = text.split(/\s+/);
    const cmd = raw.replace(/@\w+$/, '').toLowerCase();
    const argStr = rest.join(' ');
    switch (cmd) {
        case '/help': return cmdHelp();
        case '/status': return cmdStatus();
        case '/balance': return cmdBalance();
        case '/wr': return cmdWr();
        case '/recent': return cmdRecent(argStr);
        case '/next': return cmdNext();
        case '/health': return cmdHealth();
        case '/pause': return cmdPause();
        case '/resume': return cmdResume();
        case '/verbosity': return cmdVerbosity(argStr);
        case '/id': return cmdId(chatId);
        case '/start': return cmdHelp();
        default: return;
    }
}

// ---------- Long-poll loop ----------
async function pollOnce() {
    if (!CONFIG.TELEGRAM.enabled || !CONFIG.TELEGRAM.botToken) return;
    const url = `/bot${CONFIG.TELEGRAM.botToken}/getUpdates?timeout=25&offset=${updateOffset}&allowed_updates=%5B%22message%22%5D`;
    const resp = await getJson(url);
    if (!resp || resp.ok !== true) return;
    const updates = Array.isArray(resp.result) ? resp.result : [];
    for (const u of updates) {
        updateOffset = Math.max(updateOffset, (Number(u.update_id) || 0) + 1);
        try {
            if (u.message) handleMessage(u.message);
        } catch (e) {
            console.log(`⚠️ telegram-commands handler error: ${e.message}`);
        }
    }
}

function startCommandLoop(injectedDeps) {
    if (running) return;
    deps = injectedDeps || {};
    if (!CONFIG.TELEGRAM.enabled) return;
    if (!CONFIG.TELEGRAM.commandsEnabled) {
        console.log('ℹ️ Telegram commands disabled via config');
        return;
    }
    running = true;
    const interval = Number(CONFIG.TELEGRAM.commandsPollIntervalMs) || 15000;
    const tick = async () => {
        if (!running) return;
        try { await pollOnce(); }
        catch (e) { console.log(`⚠️ telegram poll error: ${e.message}`); }
        finally {
            if (running) loopTimer = setTimeout(tick, interval);
        }
    };
    void tick();
    console.log(`📡 Telegram command loop started (poll ${interval}ms)`);
}

function stopCommandLoop() {
    running = false;
    if (loopTimer) clearTimeout(loopTimer);
    loopTimer = null;
}

module.exports = { startCommandLoop, stopCommandLoop };
