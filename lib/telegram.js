/**
 * lib/telegram.js — Production Telegram notification surface for POLYPROPHET.
 *
 * Features:
 *   - 4 priority tiers (CRITICAL, HIGH, MEDIUM, LOW)
 *   - Rate limiting (Telegram allows ~30 msgs/sec per bot, we cap conservatively)
 *   - Quiet hours (LOW + MEDIUM suppressed or digested during sleep window)
 *   - Content deduplication (same message within 60s is suppressed)
 *   - Retry with exponential backoff on 5xx / network errors
 *   - Async queue (never blocks the orchestrator tick)
 *
 * All public `notifyXxx` helpers are fire-and-forget. They never throw.
 */
const https = require('https');
const CONFIG = require('./config');

// ---------- Priority levels ----------
const PRIORITY = Object.freeze({
    CRITICAL: 'CRITICAL',   // always sends, bypasses quiet hours + rate limits
    HIGH:     'HIGH',       // always sends, bypasses quiet hours
    MEDIUM:   'MEDIUM',     // respects quiet hours (digested)
    LOW:      'LOW'         // respects verbosity + quiet hours
});

// ---------- Internal state ----------
const queue = [];
let draining = false;
const recentHashes = new Map();  // text-hash → timestamp (for dedup)
let sentInLastMinute = 0;
let lastSentMs = 0;
let minuteWindowStart = Date.now();
const digest = [];
let digestTimer = null;
const deliveryStats = {
    enqueued: 0,
    attempted: 0,
    sentOk: 0,
    failed: 0,
    suppressed: 0,
    digested: 0,
    lastQueuedMs: 0,
    lastAttemptMs: 0,
    lastOkMs: 0,
    lastFailureMs: 0,
    lastFailure: null,
    lastSuppressedReason: null
};

// ---------- Config helpers ----------
function getTelegramCfg() {
    return CONFIG.TELEGRAM || {};
}

function isEnabled() {
    const t = getTelegramCfg();
    return !!(t.enabled && t.botToken && t.chatId);
}

function maxPerMinute() {
    return Number(getTelegramCfg().maxPerMinute) || 20;
}

function dedupWindowMs() {
    return Number(getTelegramCfg().dedupWindowMs) || 60000;
}

function verbosity() {
    const v = String(getTelegramCfg().verbosity || 'NORMAL').toUpperCase();
    return ['SILENT', 'CRITICAL_ONLY', 'QUIET', 'NORMAL', 'VERBOSE'].includes(v) ? v : 'NORMAL';
}

function quietHoursActive() {
    const t = getTelegramCfg();
    const start = Number(t.quietStartHourUtc);
    const end = Number(t.quietEndHourUtc);
    if (!Number.isFinite(start) || !Number.isFinite(end) || start === end) return false;
    const hour = new Date().getUTCHours();
    if (start < end) return hour >= start && hour < end;
    return hour >= start || hour < end;  // wraps midnight
}

// ---------- Priority gating ----------
function shouldSend(priority) {
    if (!isEnabled()) return false;
    const v = verbosity();
    if (v === 'SILENT') return priority === PRIORITY.CRITICAL;
    if (v === 'CRITICAL_ONLY') return priority === PRIORITY.CRITICAL;
    if (v === 'QUIET') return [PRIORITY.CRITICAL, PRIORITY.HIGH].includes(priority);
    if (v === 'NORMAL') {
        if (quietHoursActive() && priority === PRIORITY.LOW) return false;
        return true;
    }
    return true;  // VERBOSE
}

function shouldDigest(priority) {
    return verbosity() === 'NORMAL' && quietHoursActive() && priority === PRIORITY.MEDIUM;
}

// ---------- Dedup ----------
function cleanupHashes() {
    const cutoff = Date.now() - dedupWindowMs();
    for (const [hash, ts] of recentHashes.entries()) {
        if (ts < cutoff) recentHashes.delete(hash);
    }
}

function isDuplicate(text) {
    cleanupHashes();
    let hash = 0;
    for (let i = 0; i < text.length; i++) {
        hash = ((hash << 5) - hash + text.charCodeAt(i)) | 0;
    }
    const key = String(hash);
    if (recentHashes.has(key)) return true;
    recentHashes.set(key, Date.now());
    return false;
}

// ---------- Rate limit ----------
function canSendNow(priority) {
    if (priority === PRIORITY.CRITICAL) return true;
    const now = Date.now();
    if (now - minuteWindowStart > 60000) {
        minuteWindowStart = now;
        sentInLastMinute = 0;
    }
    return sentInLastMinute < maxPerMinute();
}

function markSent() {
    const now = Date.now();
    if (now - minuteWindowStart > 60000) {
        minuteWindowStart = now;
        sentInLastMinute = 0;
    }
    sentInLastMinute++;
    lastSentMs = now;
}

function markAttempt() {
    deliveryStats.attempted++;
    deliveryStats.lastAttemptMs = Date.now();
}

function markSendResult(result) {
    if (result?.ok) {
        markSent();
        deliveryStats.sentOk++;
        deliveryStats.lastOkMs = Date.now();
        return;
    }
    deliveryStats.failed++;
    deliveryStats.lastFailureMs = Date.now();
    deliveryStats.lastFailure = result?.error || (result?.code ? `HTTP ${result.code}` : 'unknown send failure');
}

function markSuppressed(reason) {
    deliveryStats.suppressed++;
    deliveryStats.lastSuppressedReason = reason;
}

// ---------- HTTP send with retry ----------
function httpSend(text, chatId, token, attempt = 0) {
    return new Promise((resolve) => {
        const payload = JSON.stringify({
            chat_id: chatId,
            text,
            parse_mode: 'HTML',
            disable_web_page_preview: true
        });
        const options = {
            hostname: 'api.telegram.org',
            path: `/bot${token}/sendMessage`,
            method: 'POST',
            timeout: 15000,
            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
        };
        const req = https.request(options, (res) => {
            let data = '';
            res.on('data', (c) => { data += c; });
            res.on('end', () => {
                if (res.statusCode === 200) return resolve({ ok: true });
                if ((res.statusCode >= 500 || res.statusCode === 429) && attempt < 3) {
                    const delay = Math.min(1000 * Math.pow(2, attempt), 8000);
                    return setTimeout(() => httpSend(text, chatId, token, attempt + 1).then(resolve), delay);
                }
                console.log(`⚠️ Telegram send failed: HTTP ${res.statusCode} ${data.slice(0, 200)}`);
                resolve({ ok: false, code: res.statusCode });
            });
        });
        req.on('error', (err) => {
            if (attempt < 3) {
                const delay = Math.min(1000 * Math.pow(2, attempt), 8000);
                return setTimeout(() => httpSend(text, chatId, token, attempt + 1).then(resolve), delay);
            }
            console.log(`⚠️ Telegram send error: ${err.message}`);
            resolve({ ok: false, error: err.message });
        });
        req.on('timeout', () => {
            req.destroy(new Error('Telegram send timeout'));
        });
        req.write(payload);
        req.end();
    });
}

// ---------- Queue drain ----------
async function drain() {
    if (draining) return;
    draining = true;
    try {
        while (queue.length > 0) {
            const next = queue[0];
            if (!canSendNow(next.priority)) {
                await new Promise((r) => setTimeout(r, 500));
                continue;
            }
            queue.shift();
            const cfg = getTelegramCfg();
            markAttempt();
            const result = await httpSend(next.text, cfg.chatId, cfg.botToken);
            markSendResult(result);
        }
    } finally {
        draining = false;
    }
}

// ---------- Public low-level send ----------
function sendMessage(text, priority = PRIORITY.MEDIUM, options = {}) {
    if (!text || typeof text !== 'string') return false;
    if (!shouldSend(priority)) {
        markSuppressed(isEnabled() ? 'priority_or_quiet_hours' : 'telegram_disabled_or_unconfigured');
        return false;
    }
    if (!options.allowDuplicate && isDuplicate(text)) {
        markSuppressed('duplicate');
        return false;
    }

    if (shouldDigest(priority)) {
        digest.push(text);
        deliveryStats.digested++;
        if (!digestTimer) {
            digestTimer = setTimeout(flushDigest, 15 * 60 * 1000);
        }
        return true;
    }

    queue.push({ text, priority });
    deliveryStats.enqueued++;
    deliveryStats.lastQueuedMs = Date.now();
    setImmediate(() => { void drain(); });
    return true;
}

function flushDigest() {
    digestTimer = null;
    if (digest.length === 0) return;
    const joined = `🔕 <b>QUIET HOURS DIGEST</b> (${digest.length} items)\n\n` + digest.slice(0, 20).join('\n\n---\n\n');
    digest.length = 0;
    if (shouldSend(PRIORITY.MEDIUM)) {
        queue.push({ text: joined, priority: PRIORITY.MEDIUM });
        deliveryStats.enqueued++;
        deliveryStats.lastQueuedMs = Date.now();
        setImmediate(() => { void drain(); });
    }
}

// ---------- Formatters ----------
function fmtUsd(v) { return `$${Number(v || 0).toFixed(2)}`; }
function fmtPct(v) { return `${(Number(v || 0) * 100).toFixed(1)}%`; }
function fmtCents(v) { return `${(Number(v || 0) * 100).toFixed(1)}¢`; }
function escHtml(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

// ======================================================================
// NOTIFICATION FUNCTIONS
// ======================================================================

function notifyBootStartup(info) {
    const mode = String(info?.mode || 'PAPER');
    const isLive = !!info?.isLive;
    const balance = Number(info?.balance || 0);
    const strategy = info?.strategyFile || 'unknown';
    const stratCount = Number(info?.strategyCount || 0);
    const emoji = isLive ? '🟢' : '📝';
    const msg = `${emoji} <b>POLYPROPHET BOOTED</b>\n` +
        `Mode: <b>${mode}</b> | Live: ${isLive ? 'YES' : 'NO'}\n` +
        `Balance: <b>${fmtUsd(balance)}</b>\n` +
        `Strategy: <code>${escHtml(strategy)}</code> (${stratCount} rules)\n` +
        `Deploy: <code>${escHtml(info?.deployVersion || 'local').slice(0, 12)}</code>\n` +
        `Host: ${escHtml(info?.host || 'local')}`;
    return sendMessage(msg, PRIORITY.HIGH, { allowDuplicate: true });
}

function notifyTradeOpen(result) {
    if (!result) return false;
    if (getTelegramCfg().signalsOnly) return false;
    const emoji = result.mode === 'LIVE' ? '🔴' : '📝';
    const sizeNum = Number(result.size || 0);
    const sharesNum = Number(result.shares || 0);
    const msg = `${emoji} <b>${escHtml(result.mode)} TRADE OPENED</b>\n` +
        `${escHtml(result.asset)} ${escHtml(result.timeframe)} ${escHtml(result.direction)} @ ${fmtCents(result.entryPrice)}\n` +
        `Size: ${fmtUsd(sizeNum)} (${sharesNum.toFixed(2)} sh)\n` +
        `pWin: ${fmtPct(result.pWin || result.pWinEstimate || 0)} | Strategy: <code>${escHtml(result.strategy || result.name || '')}</code>`;
    return sendMessage(msg, PRIORITY.HIGH, { allowDuplicate: true });
}

function notifyTradeClose(result) {
    if (!result) return false;
    if (getTelegramCfg().signalsOnly) return false;
    const pnl = Number(result.pnl || 0);
    const bal = Number(result.bankrollAfter || 0);
    const won = !!result.won;
    const emoji = won ? '✅' : '❌';
    const asset = escHtml(result.asset || '');
    const tf = escHtml(result.timeframe || '');
    const dir = escHtml(result.direction || '');
    const msg = `${emoji} <b>TRADE ${won ? 'WON' : 'LOST'}</b>  ${asset} ${tf} ${dir}\n` +
        `PnL: <b>${pnl >= 0 ? '+' : ''}${fmtUsd(pnl)}</b>\n` +
        `Balance: <b>${fmtUsd(bal)}</b>${result.consecutiveLosses ? ` | ConsecLoss: ${result.consecutiveLosses}` : ''}`;
    return sendMessage(msg, won ? PRIORITY.MEDIUM : PRIORITY.HIGH, { allowDuplicate: true });
}

function notifyDailySummary(status) {
    if (!status) return false;
    const bal = Number(status.bankroll || 0);
    const pnl = Number(status.todayPnL || 0);
    const peak = Number(status.peakBalance || 0);
    const trades = Number(status.totalTrades || 0);
    const wr = status.winRate || 'N/A';
    const dd = status.drawdownFromPeak || '0.0';
    const pnlEmoji = pnl > 0 ? '📈' : (pnl < 0 ? '📉' : '➡️');
    const msg = `📊 <b>DAILY SUMMARY</b> ${pnlEmoji}\n` +
        `Balance: <b>${fmtUsd(bal)}</b>\n` +
        `Today P&amp;L: <b>${pnl >= 0 ? '+' : ''}${fmtUsd(pnl)}</b>\n` +
        `Trades: ${trades} (${wr}% WR)\n` +
        `Peak: ${fmtUsd(peak)} | DD: ${dd}%` +
        (Number(status.consecutiveLosses || 0) > 0 ? `\nConsecLosses: ${status.consecutiveLosses}` : '') +
        (status.inCooldown ? `\n⏳ In cooldown (${status.cooldownRemaining}s)` : '') +
        (status.tradingPaused ? `\n⏸️ Paused` : '');
    return sendMessage(msg, PRIORITY.HIGH);
}

function notifySignal(candidate) {
    if (!candidate) return false;
    const msg = `📡 <b>SIGNAL</b>: ${escHtml(candidate.asset)} ${escHtml(candidate.timeframe)} ${escHtml(candidate.direction)}\n` +
        `Entry: ${fmtCents(candidate.entryPrice)} | pWin: ${fmtPct(candidate.pWinEstimate)}\n` +
        `Strategy: <code>${escHtml(candidate.name || '')}</code>`;
    return sendMessage(msg, PRIORITY.LOW);
}

function notifyCooldownHit(details) {
    const consec = Number(details?.consecutiveLosses || 0);
    const secs = Number(details?.cooldownSeconds || 0);
    const bal = Number(details?.bankroll || 0);
    const msg = `⏳ <b>COOLDOWN TRIGGERED</b>\n` +
        `Consecutive losses: <b>${consec}</b>\n` +
        `Pause duration: ${Math.round(secs / 60)}min\n` +
        `Balance: ${fmtUsd(bal)}`;
    return sendMessage(msg, PRIORITY.CRITICAL);
}

function notifyHaltTriggered(details) {
    const kind = String(details?.kind || 'UNKNOWN');
    const reason = String(details?.reason || details?.lastError || 'unspecified');
    const msg = `🛑 <b>HALT TRIGGERED: ${escHtml(kind)}</b>\n` +
        `Reason: ${escHtml(reason).slice(0, 200)}\n` +
        `Consecutive: ${Number(details?.count || 0)} / threshold ${Number(details?.threshold || 0)}\n\n` +
        `Recover via <code>POST /api/resume-errors</code> or <code>/resume</code>`;
    return sendMessage(msg, PRIORITY.CRITICAL, { allowDuplicate: true });
}

function notifyHaltResumed(info) {
    const msg = `✅ <b>HALT CLEARED</b>\n` +
        (info?.source ? `Source: ${escHtml(info.source)}\n` : '') +
        `Resuming trading`;
    return sendMessage(msg, PRIORITY.HIGH);
}

function notifyDepositDetected(info) {
    const delta = Number(info?.delta || 0);
    const newBal = Number(info?.newBalance || 0);
    const prev = Number(info?.previousBalance || 0);
    const emoji = delta >= 0 ? '💰' : '🔻';
    const msg = `${emoji} <b>BALANCE CHANGE</b>\n` +
        `${prev.toFixed(2)} → <b>${newBal.toFixed(2)}</b> USDC (Δ ${delta >= 0 ? '+' : ''}${delta.toFixed(2)})\n` +
        `Baseline rebased. Peak reset.`;
    return sendMessage(msg, PRIORITY.HIGH);
}

function notifyPeakBalance(info) {
    const peak = Number(info?.peak || 0);
    const prev = Number(info?.previousPeak || 0);
    const msg = `🏆 <b>NEW PEAK</b>\n` +
        `${prev.toFixed(2)} → <b>${peak.toFixed(2)}</b> USDC`;
    return sendMessage(msg, PRIORITY.LOW);
}

function notifyDrawdownAlert(info) {
    const ddPct = Number(info?.drawdownPct || 0);
    const bal = Number(info?.bankroll || 0);
    const peak = Number(info?.peak || 0);
    const emoji = ddPct >= 0.5 ? '🔥' : '⚠️';
    const msg = `${emoji} <b>DRAWDOWN ALERT</b>: ${(ddPct * 100).toFixed(1)}% from peak\n` +
        `Balance: ${fmtUsd(bal)} | Peak: ${fmtUsd(peak)}`;
    return sendMessage(msg, ddPct >= 0.5 ? PRIORITY.CRITICAL : PRIORITY.HIGH);
}

function notifyValidatorAlert(report) {
    const kind = String(report?.kind || 'HEALTH_CHECK');
    const severity = String(report?.severity || 'INFO').toUpperCase();
    const icon = severity === 'CRITICAL' ? '🚨' : severity === 'WARN' ? '⚠️' : 'ℹ️';
    const summary = String(report?.summary || '').slice(0, 500);
    const lines = Array.isArray(report?.lines) ? report.lines.slice(0, 10) : [];
    const body = lines.length ? '\n\n' + lines.map(escHtml).join('\n') : '';
    const msg = `${icon} <b>STRATEGY VALIDATOR: ${escHtml(kind)}</b>\n` +
        `Severity: <b>${escHtml(severity)}</b>\n\n` +
        `${escHtml(summary)}${body}`;
    const priority = severity === 'CRITICAL' ? PRIORITY.CRITICAL : (severity === 'WARN' ? PRIORITY.HIGH : PRIORITY.MEDIUM);
    return sendMessage(msg, priority);
}

function notifyRetrainCandidate(info) {
    const candidate = String(info?.candidateFile || 'unknown');
    const beat = !!info?.beatsCurrent;
    const emoji = beat ? '🔬✅' : '🔬';
    const summary = String(info?.summary || '').slice(0, 600);
    const msg = `${emoji} <b>RETRAIN CANDIDATE READY</b>\n` +
        `File: <code>${escHtml(candidate)}</code>\n` +
        `Beats current: ${beat ? 'YES' : 'NO'}\n\n${escHtml(summary)}\n\n` +
        `Action: review report, run /handover-sync, then manually swap if accepted.`;
    return sendMessage(msg, PRIORITY.HIGH);
}

function notifyError(context, error) {
    const msg = `❗ <b>ERROR</b> (${escHtml(context || 'unknown')})\n<code>${escHtml(String(error?.message || error).slice(0, 500))}</code>`;
    return sendMessage(msg, PRIORITY.HIGH);
}

// ---------- Introspection for commands ----------
function getQueueState() {
    const cfg = getTelegramCfg();
    return {
        queued: queue.length,
        sentInLastMinute,
        maxPerMinute: maxPerMinute(),
        lastSentMs,
        deliveryStats: { ...deliveryStats },
        quietHoursActive: quietHoursActive(),
        verbosity: verbosity(),
        digestPending: digest.length,
        enabled: isEnabled(),
        configured: {
            enabledFlag: !!cfg.enabled,
            botTokenPresent: !!cfg.botToken,
            chatIdPresent: !!cfg.chatId,
            commandsEnabled: !!cfg.commandsEnabled,
            signalsOnly: !!cfg.signalsOnly
        }
    };
}

module.exports = {
    PRIORITY,
    sendMessage,
    notifyBootStartup,
    notifyTradeOpen,
    notifyTradeClose,
    notifyDailySummary,
    notifySignal,
    notifyCooldownHit,
    notifyHaltTriggered,
    notifyHaltResumed,
    notifyDepositDetected,
    notifyPeakBalance,
    notifyDrawdownAlert,
    notifyValidatorAlert,
    notifyRetrainCandidate,
    notifyError,
    getQueueState
};
