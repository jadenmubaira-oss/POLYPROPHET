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
 *   /mode                 — show current PAPER/LIVE mode and live blockers
 *   /paper                — switch runtime mode to PAPER and force pause
 *   /live                 — request LIVE switch confirmation
 *   /verbosity LVL        — set TELEGRAM verbosity runtime (SILENT|CRITICAL_ONLY|QUIET|NORMAL|VERBOSE)
 *   /id                   — show your chat id (for setup)
 *
 * Start with `startCommandLoop(deps)` — deps supplied by server.js.
 */
const https = require('https');
const CONFIG = require('./config');
const telegram = require('./telegram');

let updateOffset = 0;
let loopTimer = null;
let running = false;
let deps = null;
let pendingWithdraw = null;

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

function postJson(pathname, body) {
    return new Promise((resolve) => {
        const payload = JSON.stringify(body || {});
        const requestOptions = {
            hostname: 'api.telegram.org',
            path: pathname,
            method: 'POST',
            timeout: 15000,
            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
        };
        const req = https.request(requestOptions, (res) => {
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
        req.on('error', (err) => resolve({ ok: false, error: err.message }));
        req.on('timeout', () => { req.destroy(new Error('Telegram command POST timeout')); });
        req.write(payload);
        req.end();
    });
}

function getControlKeyboard() {
    return {
        inline_keyboard: [
            [
                { text: '📊 Dashboard', callback_data: 'pp_dashboard' },
                { text: '🩺 Health', callback_data: 'pp_health' }
            ],
            [
                { text: '⏸ Pause', callback_data: 'pp_pause' },
                { text: '▶️ Resume', callback_data: 'pp_resume' }
            ],
            [
                { text: '🧪 PAPER', callback_data: 'pp_mode_paper' },
                { text: '🔴 LIVE', callback_data: 'pp_mode_live' }
            ],
            [
                { text: '💰 Balance', callback_data: 'pp_balance' },
                { text: '🎯 Next Windows', callback_data: 'pp_next' }
            ],
            [
                { text: '📥 Deposit', callback_data: 'pp_deposit' },
                { text: '📤 Withdraw', callback_data: 'pp_withdraw' }
            ],
            [
                { text: '🧾 Live Proof', callback_data: 'pp_liveproof' },
                { text: '♻️ Reset Validator', callback_data: 'pp_reset_validator' }
            ]
        ]
    };
}

function getWithdrawConfirmKeyboard(token) {
    return {
        inline_keyboard: [
            [
                { text: '📤 Confirm Withdraw', callback_data: `pp_confirm_withdraw:${token}` },
                { text: 'Cancel', callback_data: 'pp_cancel_withdraw' }
            ],
            [
                { text: '💰 Balance', callback_data: 'pp_balance' },
                { text: '📊 Dashboard', callback_data: 'pp_dashboard' }
            ]
        ]
    };
}

function getLiveConfirmKeyboard() {
    return {
        inline_keyboard: [
            [
                { text: '🔴 Confirm LIVE + keep paused', callback_data: 'pp_confirm_mode_live' },
                { text: 'Cancel', callback_data: 'pp_cancel' }
            ],
            [
                { text: '📊 Dashboard', callback_data: 'pp_dashboard' },
                { text: '🧪 PAPER', callback_data: 'pp_mode_paper' }
            ]
        ]
    };
}

function getResetConfirmKeyboard() {
    return {
        inline_keyboard: [
            [
                { text: 'Confirm Reset', callback_data: 'pp_confirm_reset_validator' },
                { text: 'Cancel', callback_data: 'pp_cancel' }
            ],
            [
                { text: 'Status', callback_data: 'pp_status' },
                { text: 'Health', callback_data: 'pp_health' }
            ]
        ]
    };
}

function replyText(text, sendOptions = {}) {
    // fire-and-forget direct send. Bypass verbosity gating so command replies always work.
    if (!CONFIG.TELEGRAM.enabled || !CONFIG.TELEGRAM.botToken) return;
    const chatId = sendOptions.chatId || CONFIG.TELEGRAM.chatId;
    if (!chatId) return;
    void postJson(`/bot${CONFIG.TELEGRAM.botToken}/sendMessage`, {
        chat_id: chatId,
        text,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
        ...(sendOptions.replyMarkup ? { reply_markup: sendOptions.replyMarkup } : {})
    }).then((resp) => {
        if (!resp || resp.ok !== true) {
            const detail = resp?.description || resp?.error || 'unknown reply failure';
            console.log(`⚠️ Telegram command reply failed: ${detail}`);
        }
    });
}

function answerCallbackQuery(callbackQueryId, text, showAlert = false) {
    if (!callbackQueryId || !CONFIG.TELEGRAM.enabled || !CONFIG.TELEGRAM.botToken) return;
    const payload = { callback_query_id: callbackQueryId };
    if (text) payload.text = text;
    if (showAlert) payload.show_alert = true;
    void postJson(`/bot${CONFIG.TELEGRAM.botToken}/answerCallbackQuery`, payload);
}

function escHtml(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
function fmtUsd(v) { return `$${Number(v || 0).toFixed(2)}`; }
function shortAddr(addr) {
    const s = String(addr || '').trim();
    return s.length > 14 ? `${s.slice(0, 8)}…${s.slice(-6)}` : s;
}
function isAddressLike(addr) { return /^0x[a-fA-F0-9]{40}$/.test(String(addr || '').trim()); }

function getExecutorTradeLog() {
    const positions = Array.isArray(deps?.tradeExecutor?.positions) ? deps.tradeExecutor.positions : [];
    return positions
        .filter((position) => ['WON', 'LOST', 'CLOSED'].includes(String(position?.status || '').toUpperCase()))
        .map((position) => ({
            ts: position.closedAt || position.resolvedAt || position.openedAt || null,
            asset: position.asset,
            timeframe: position.timeframe,
            direction: position.direction,
            entryPrice: Number.isFinite(Number(position.signalEntryPrice)) ? Number(position.signalEntryPrice) : Number(position.entryPrice || 0),
            pnl: Number(position.pnl || 0),
            won: Number(position.pnl || 0) >= 0
        }))
        .sort((a, b) => new Date(a.ts || 0).getTime() - new Date(b.ts || 0).getTime());
}

function getOperatorTradeLog() {
    if (Array.isArray(deps?.riskManager?.tradeLog) && deps.riskManager.tradeLog.length) return deps.riskManager.tradeLog;
    const status = deps?.riskManager?.getStatus?.();
    if (Array.isArray(status?.recentTrades) && status.recentTrades.length) return status.recentTrades;
    return getExecutorTradeLog();
}

function getOperatorTradeSummary(risk, exec) {
    if (Number(risk?.totalTrades || 0) > 0) {
        return {
            totalTrades: Number(risk.totalTrades || 0),
            winRate: risk.winRate,
            source: 'validator'
        };
    }
    const execLog = getExecutorTradeLog();
    const totalTrades = execLog.length;
    const wins = execLog.filter((trade) => trade.won).length;
    return {
        totalTrades,
        winRate: totalTrades > 0 ? (wins / totalTrades * 100).toFixed(1) : 'N/A',
        source: totalTrades > 0 ? 'executor_ledger' : 'validator'
    };
}

function wilson(wins, total, z = 1.96) {
    if (!total || total <= 0) return 0;
    const p = wins / total;
    const denom = 1 + (z * z) / total;
    const centre = p + (z * z) / (2 * total);
    const margin = z * Math.sqrt((p * (1 - p) + (z * z) / (4 * total)) / total);
    return Math.max(0, (centre - margin) / denom);
}

function getModeInfo() {
    const exec = deps.tradeExecutor?.getStatus?.() || {};
    const blockers = deps.getLiveModeBlockers?.() || [];
    return {
        mode: String(exec.mode || CONFIG.TRADE_MODE || 'UNKNOWN').toUpperCase(),
        isLive: !!CONFIG.IS_LIVE,
        blockers,
        source: CONFIG.RUNTIME_MODE_SOURCE || 'env',
        updatedAt: CONFIG.RUNTIME_MODE_UPDATED_AT || null
    };
}

function getWalletClient() {
    return deps.clobClient || deps.tradeExecutor?.clob || deps.tradeExecutor?.clobClient || null;
}

function getWalletSourceAddress(clob) {
    return clob?.getSelectedFunderAddress?.()
        || clob?.getStatus?.()?.tradeReady?.selected?.funderAddress
        || clob?.getStatus?.()?.walletAddress
        || null;
}

function getExposureBlockers() {
    const risk = deps.riskManager?.getStatus?.() || {};
    const exec = deps.tradeExecutor?.getStatus?.() || {};
    const blockers = [];
    if (!risk.tradingPaused) blockers.push('trading is not paused');
    if (Number(exec.openPositions || 0) > 0) blockers.push(`${exec.openPositions} open position(s)`);
    if (Array.isArray(exec.pendingBuys) && exec.pendingBuys.length) blockers.push(`${exec.pendingBuys.length} pending buy(s)`);
    if (Array.isArray(exec.pendingSells) && exec.pendingSells.length) blockers.push(`${exec.pendingSells.length} pending sell(s)`);
    if (Array.isArray(exec.pendingSettlements) && exec.pendingSettlements.length) blockers.push(`${exec.pendingSettlements.length} pending settlement(s)`);
    return blockers;
}

async function getProxyPusdBalance(clob) {
    const source = getWalletSourceAddress(clob);
    if (!source || !isAddressLike(source) || typeof clob?.getOnChainPusdBalance !== 'function') {
        return { success: false, source, balance: 0, error: 'Proxy pUSD balance read unavailable' };
    }
    const res = await clob.getOnChainPusdBalance(source);
    return { ...(res || {}), source, balance: Number(res?.balance || 0) };
}

function clearExpiredPendingWithdraw() {
    if (pendingWithdraw && Date.now() > Number(pendingWithdraw.expiresAt || 0)) {
        pendingWithdraw = null;
    }
}

async function getFreshBalanceBreakdown(force = false) {
    const exec = deps.tradeExecutor;
    if (exec?.clob?.wallet && typeof exec.refreshLiveBalance === 'function') {
        try {
            return await exec.refreshLiveBalance(!!force);
        } catch (e) {
            const cached = exec.getCachedBalanceBreakdown?.() || {};
            return { ...cached, refreshError: e.message };
        }
    }
    return exec?.getCachedBalanceBreakdown?.() || {};
}

function getDashboardLines(balanceOverride = null) {
    const risk = deps.riskManager.getStatus();
    const exec = deps.tradeExecutor.getStatus();
    const recoveryCount = Array.isArray(exec.recoveryQueue) ? exec.recoveryQueue.length : 0;
    const tradeSummary = getOperatorTradeSummary(risk, exec);
    const halts = deps.getHalts?.() || { errorHalt: false, tradeFailureHalt: false };
    const breakdown = balanceOverride || deps.tradeExecutor.getCachedBalanceBreakdown?.() || {};
    const modeInfo = getModeInfo();
    const primaryBalanceLabel = modeInfo.mode === 'LIVE' ? 'Live cash' : 'Paper sim';
    const bal = modeInfo.mode === 'LIVE'
        ? Number(breakdown.tradingBalanceUsdc || exec.liveBalance || 0)
        : Number(risk.bankroll || exec.paperBalance || 0);
    const paused = risk.tradingPaused ? '⏸️ PAUSED' : (risk.inCooldown ? `⏳ cooldown ${risk.cooldownRemaining}s` : '✅ active');
    return [
        `<b>POLYPROPHET CONTROL CENTER</b>`,
        `${paused} | Mode: <b>${escHtml(modeInfo.mode)}${modeInfo.isLive ? ' 🔴 LIVE-ARMED' : ''}</b>`,
        `${primaryBalanceLabel}: <b>${fmtUsd(bal)}</b> | Peak: ${fmtUsd(risk.peakBalance)} | Today: ${Number(risk.todayPnL || 0) >= 0 ? '+' : ''}${fmtUsd(risk.todayPnL)}`,
        `Trades: ${tradeSummary.totalTrades} (${tradeSummary.winRate}% WR) | Loss streak: ${risk.consecutiveLosses} | DD: ${risk.drawdownFromPeak}%`,
        `Open: ${exec.openPositions} (${fmtUsd(exec.openExposureUsd)}) | Pending B/S/Settle: ${exec.pendingBuys.length}/${exec.pendingSells.length}/${exec.pendingSettlements.length}`,
        `Wallet cash: ${fmtUsd(breakdown.tradingBalanceUsdc)}${breakdown.refreshError ? ` (refresh error: ${escHtml(breakdown.refreshError)})` : ''}`,
        recoveryCount > 0 ? `Recovery queue: ${recoveryCount}` : null,
        (halts.errorHalt || halts.tradeFailureHalt) ? `🛑 Halts: error=${halts.errorHalt} tradeFail=${halts.tradeFailureHalt}` : null,
        modeInfo.mode === 'LIVE' && modeInfo.blockers.length ? `⚠️ LIVE blocked: ${escHtml(modeInfo.blockers.join('; '))}` : null,
        `Mode source: ${escHtml(modeInfo.source)}${modeInfo.updatedAt ? ` @ ${escHtml(modeInfo.updatedAt)}` : ''}`,
        `Use the buttons below as the Telegram dashboard/control center.`
    ].filter(Boolean);
}

// ---------- Command handlers ----------
function cmdHelp() {
    replyText(
        `<b>POLYPROPHET Telegram Control Center</b>\n` +
        `/dashboard — full button dashboard\n` +
        `/status — live posture\n` +
        `/balance — usdc balance\n` +
        `/wr — rolling win rate\n` +
        `/recent [N] — last N trades (def 10, max 25)\n` +
        `/next — upcoming entry windows (6h)\n` +
        `/health — validator report\n` +
        `/pause — pause trading\n` +
        `/resume — resume trading &amp; clear halts\n` +
        `/mode — PAPER/LIVE state and live blockers\n` +
        `/paper — switch to PAPER and force pause\n` +
        `/live — show LIVE confirmation button\n` +
        `/liveproof [ASSET] [UP|DOWN] — owner-only tiny live order acceptance/cancel proof\n` +
        `/deposit — show Polymarket proxy wallet deposit instructions\n` +
        `/withdraw AMOUNT — request guarded pUSD withdrawal to configured address\n` +
        `/confirm_withdraw TOKEN — confirm the latest withdrawal request\n` +
        `/verbosity LVL — SILENT|CRITICAL_ONLY|QUIET|NORMAL|VERBOSE\n` +
        `/id — show your chat id`,
        { replyMarkup: getControlKeyboard() }
    );
}

async function cmdDashboard() {
    try {
        const breakdown = await getFreshBalanceBreakdown(true);
        replyText(getDashboardLines(breakdown).join('\n'), { replyMarkup: getControlKeyboard() });
    } catch (e) {
        replyText(`error: ${escHtml(e.message)}`);
    }
}

async function cmdStatus() {
    try {
        const breakdown = await getFreshBalanceBreakdown(true);
        replyText(getDashboardLines(breakdown).join('\n'), { replyMarkup: getControlKeyboard() });
    } catch (e) {
        replyText(`error: ${escHtml(e.message)}`);
    }
}

function cmdMode() {
    const info = getModeInfo();
    const lines = [
        `<b>MODE CONTROL</b>`,
        `Current: <b>${escHtml(info.mode)}</b> ${info.isLive ? '🔴 LIVE orders enabled' : '🧪 live orders blocked/paper'}`,
        `Source: ${escHtml(info.source)}${info.updatedAt ? ` @ ${escHtml(info.updatedAt)}` : ''}`,
        info.blockers.length ? `LIVE blockers: ${escHtml(info.blockers.join('; '))}` : `LIVE blockers: none`,
        `Safety: switching mode always pauses trading. Use /resume only after checking /dashboard and balance.`
    ];
    replyText(lines.join('\n'), { replyMarkup: getControlKeyboard() });
}

async function switchModeFromTelegram(mode) {
    if (typeof deps.switchRuntimeTradeMode !== 'function') {
        throw new Error('Runtime mode switch unavailable.');
    }
    const result = await deps.switchRuntimeTradeMode(mode, { source: 'telegram' });
    const liveLine = result.mode === 'LIVE'
        ? (result.isLive ? '🔴 LIVE is armed, but trading remains paused until /resume.' : `⚠️ LIVE selected but blocked: ${escHtml((result.liveModeBlockers || []).join('; '))}`)
        : '🧪 PAPER mode active. Trading remains paused until /resume.';
    replyText(
        `<b>MODE SWITCHED</b>\n` +
        `Previous: ${escHtml(result.previousMode)}\n` +
        `Current: <b>${escHtml(result.mode)}</b>\n` +
        `${liveLine}\n` +
        `Paused: <b>${result.paused ? 'YES' : 'NO'}</b>`,
        { replyMarkup: getControlKeyboard() }
    );
}

async function cmdPaper() {
    try {
        await switchModeFromTelegram('PAPER');
    } catch (e) {
        replyText(`error: ${escHtml(e.message)}`, { replyMarkup: getControlKeyboard() });
    }
}

function cmdLive() {
    const blockers = deps.getLiveModeBlockers?.() || [];
    replyText(
        `⚠️ <b>Confirm switch to LIVE?</b>\n` +
        `This arms real-money execution only if Render live env gates are already valid. The bot will stay paused after switching.\n` +
        (blockers.length ? `Current LIVE blockers before switch: ${escHtml(blockers.join('; '))}\n` : `Current LIVE blockers before switch: none\n`) +
        `Press confirm only if wallet, balance, strategy, and timing checks are correct.`,
        { replyMarkup: getLiveConfirmKeyboard() }
    );
}

async function cmdBalance() {
    try {
        const breakdown = await getFreshBalanceBreakdown(true);
        const lines = [
            `<b>BALANCE</b>`,
            `Usable: <b>${fmtUsd(breakdown.tradingBalanceUsdc)}</b>`,
            `On-chain: ${fmtUsd(breakdown.onChainUsdc)}`,
            `CLOB collateral: ${fmtUsd(breakdown.clobCollateralUsdc)}`,
            `Source: ${escHtml(breakdown.sourceLabel || breakdown.source || 'unknown')}`,
            breakdown.refreshError ? `⚠️ Refresh error: ${escHtml(breakdown.refreshError)}` : null,
            breakdown.stale ? `⚠️ Balance is stale` : null,
            breakdown.updatedIso ? `Updated: ${escHtml(breakdown.updatedIso)}` : null
        ].filter(Boolean);
        replyText(lines.join('\n'), { replyMarkup: getControlKeyboard() });
    } catch (e) {
        replyText(`error: ${escHtml(e.message)}`);
    }
}

async function cmdDeposit() {
    try {
        const clob = getWalletClient();
        const status = clob?.getStatus?.() || {};
        const proxyAddress = getWalletSourceAddress(clob);
        const walletAddress = status.walletAddress || null;
        const balance = clob ? await getProxyPusdBalance(clob) : { success: false, balance: 0, error: 'wallet client unavailable' };
        const lines = [
            `<b>DEPOSIT / FUND WALLET</b>`,
            proxyAddress && isAddressLike(proxyAddress)
                ? `Send/bridge Polymarket collateral on Polygon to proxy/funder:`
                : `Proxy/funder address is not available yet. Check wallet envs and /balance.`,
            proxyAddress && isAddressLike(proxyAddress) ? `<code>${escHtml(proxyAddress)}</code>` : null,
            walletAddress && walletAddress !== proxyAddress ? `Signer/EOA: <code>${escHtml(walletAddress)}</code>` : null,
            `Network: <b>Polygon</b>` ,
            `Asset: <b>Polymarket USD / pUSD</b> after V2 cutover; if using the Polymarket UI, deposit normally into this account and verify /balance after it arrives.`,
            balance.success ? `Current proxy pUSD: <b>${fmtUsd(balance.balance)}</b>` : `Current proxy pUSD: unavailable (${escHtml(balance.error || 'unknown')})`,
            `Telegram cannot initiate an inbound deposit; it can only show the correct funding address and verify once funds arrive.`,
            `Never paste private keys or seed phrases into Telegram.`
        ].filter(Boolean);
        replyText(lines.join('\n'), { replyMarkup: getControlKeyboard() });
    } catch (e) {
        replyText(`error: ${escHtml(e.message)}`, { replyMarkup: getControlKeyboard() });
    }
}

async function cmdWithdraw(argStr) {
    try {
        clearExpiredPendingWithdraw();
        const amount = Number(String(argStr || '').trim());
        const clob = getWalletClient();
        const blockers = [];
        if (!CONFIG.TELEGRAM.walletControlsEnabled) blockers.push('TELEGRAM_WALLET_CONTROLS_ENABLED is not true');
        if (!CONFIG.TELEGRAM.withdrawEnabled) blockers.push('TELEGRAM_WITHDRAW_ENABLED is not true');
        if (!isAddressLike(CONFIG.TELEGRAM.withdrawToAddress)) blockers.push('TELEGRAM_WITHDRAW_TO_ADDRESS is not a valid fixed 0x address');
        if (!(Number(CONFIG.TELEGRAM.withdrawMaxUsdc) > 0)) blockers.push('TELEGRAM_WITHDRAW_MAX_USDC must be greater than 0');
        if (!clob || typeof clob.withdrawPusdFromProxy !== 'function') blockers.push('withdraw-capable wallet client is unavailable');
        blockers.push(...getExposureBlockers());
        if (!Number.isFinite(amount) || amount <= 0) {
            blockers.push('usage is /withdraw AMOUNT, for example /withdraw 5');
        }
        if (Number.isFinite(amount) && amount > Number(CONFIG.TELEGRAM.withdrawMaxUsdc || 0)) {
            blockers.push(`amount exceeds configured max ${fmtUsd(CONFIG.TELEGRAM.withdrawMaxUsdc)}`);
        }
        const balance = clob ? await getProxyPusdBalance(clob) : { success: false, balance: 0, error: 'wallet client unavailable' };
        if (!balance.success) blockers.push(`could not verify proxy pUSD balance: ${balance.error || 'unknown'}`);
        if (Number.isFinite(amount) && amount > Number(balance.balance || 0) + 0.000001) {
            blockers.push(`amount exceeds proxy pUSD balance ${fmtUsd(balance.balance)}`);
        }
        if (blockers.length) {
            pendingWithdraw = null;
            return replyText(
                `<b>WITHDRAWAL BLOCKED</b>\n` +
                blockers.map((b) => `• ${escHtml(b)}`).join('\n') +
                `\n\nDeposit instructions are still available with /deposit.`,
                { replyMarkup: getControlKeyboard() }
            );
        }
        const token = Math.random().toString(36).slice(2, 8).toUpperCase();
        pendingWithdraw = {
            token,
            amount,
            to: CONFIG.TELEGRAM.withdrawToAddress,
            source: balance.source,
            requestedAt: new Date().toISOString(),
            expiresAt: Date.now() + Math.max(30000, Number(CONFIG.TELEGRAM.withdrawConfirmTtlMs || 300000))
        };
        replyText(
            `<b>CONFIRM WITHDRAWAL</b>\n` +
            `Amount: <b>${fmtUsd(amount)}</b> pUSD\n` +
            `From proxy: <code>${escHtml(balance.source)}</code>\n` +
            `To fixed address: <code>${escHtml(CONFIG.TELEGRAM.withdrawToAddress)}</code>\n` +
            `Token: <code>${escHtml(token)}</code>\n` +
            `Expires: ${Math.round((pendingWithdraw.expiresAt - Date.now()) / 1000)}s\n\n` +
            `Press the confirm button or send /confirm_withdraw ${escHtml(token)}.`,
            { replyMarkup: getWithdrawConfirmKeyboard(token) }
        );
    } catch (e) {
        pendingWithdraw = null;
        replyText(`error: ${escHtml(e.message)}`, { replyMarkup: getControlKeyboard() });
    }
}

async function cmdConfirmWithdraw(tokenArg) {
    try {
        clearExpiredPendingWithdraw();
        const token = String(tokenArg || '').trim().toUpperCase();
        if (!pendingWithdraw || !token || token !== pendingWithdraw.token) {
            return replyText('Withdrawal confirmation failed or expired. Start again with /withdraw AMOUNT.', { replyMarkup: getControlKeyboard() });
        }
        const request = pendingWithdraw;
        pendingWithdraw = null;
        const clob = getWalletClient();
        const blockers = [];
        if (!CONFIG.TELEGRAM.walletControlsEnabled || !CONFIG.TELEGRAM.withdrawEnabled) blockers.push('withdraw controls are no longer enabled');
        if (!clob || typeof clob.withdrawPusdFromProxy !== 'function') blockers.push('withdraw-capable wallet client unavailable');
        if (!isAddressLike(request.to) || request.to !== CONFIG.TELEGRAM.withdrawToAddress) blockers.push('configured withdrawal address changed');
        if (Number(request.amount || 0) > Number(CONFIG.TELEGRAM.withdrawMaxUsdc || 0)) blockers.push('amount now exceeds configured max');
        blockers.push(...getExposureBlockers());
        if (blockers.length) {
            return replyText(
                `<b>WITHDRAWAL CANCELLED</b>\n` + blockers.map((b) => `• ${escHtml(b)}`).join('\n'),
                { replyMarkup: getControlKeyboard() }
            );
        }
        const balance = await getProxyPusdBalance(clob);
        if (!balance.success || Number(request.amount || 0) > Number(balance.balance || 0) + 0.000001) {
            return replyText(
                `<b>WITHDRAWAL CANCELLED</b>\nCould not re-verify balance or balance is insufficient. Available: ${fmtUsd(balance.balance)}.`,
                { replyMarkup: getControlKeyboard() }
            );
        }
        replyText(`📤 Submitting pUSD withdrawal via Polymarket proxy relayer: ${fmtUsd(request.amount)} → ${escHtml(shortAddr(request.to))}.`, { replyMarkup: getControlKeyboard() });
        const result = await clob.withdrawPusdFromProxy(request.to, request.amount);
        if (result?.success) {
            replyText(
                `<b>WITHDRAWAL SUBMITTED</b>\n` +
                `Amount: <b>${fmtUsd(request.amount)}</b> pUSD\n` +
                `To: <code>${escHtml(request.to)}</code>\n` +
                (result.txHash ? `Tx/relay hash: <code>${escHtml(result.txHash)}</code>\n` : '') +
                (result.relayResponse?.transactionHash ? `Relay tx: <code>${escHtml(result.relayResponse.transactionHash)}</code>\n` : '') +
                `Verify final arrival in the wallet/UI before relying on the balance.`,
                { replyMarkup: getControlKeyboard() }
            );
        } else {
            replyText(
                `<b>WITHDRAWAL FAILED / NOT SUBMITTED</b>\n${escHtml(result?.error || 'Unknown relay failure')}`,
                { replyMarkup: getControlKeyboard() }
            );
        }
    } catch (e) {
        pendingWithdraw = null;
        replyText(`error: ${escHtml(e.message)}`, { replyMarkup: getControlKeyboard() });
    }
}

function cmdWr() {
    try {
        const log = getOperatorTradeLog();
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
        replyText(out.join('\n'), { replyMarkup: getControlKeyboard() });
    } catch (e) {
        replyText(`error: ${escHtml(e.message)}`);
    }
}

function cmdRecent(argStr) {
    try {
        const n = Math.min(25, Math.max(1, parseInt(argStr, 10) || 10));
        const log = getOperatorTradeLog().slice(-n);
        if (!log.length) return replyText('No recent trades.');
        const rows = log.map((t) => {
            const icon = t.won ? '✅' : '❌';
            const pnl = Number(t.pnl || 0);
            const pnlStr = `${pnl >= 0 ? '+' : ''}${pnl.toFixed(2)}`;
            return `${icon} ${t.ts?.slice(5, 16)}  ${t.asset}/${t.timeframe} ${t.direction} @${(Number(t.entryPrice || 0) * 100).toFixed(0)}¢  ${pnlStr}`;
        });
        replyText(`<b>LAST ${log.length} TRADES</b>\n<code>${escHtml(rows.join('\n'))}</code>`, { replyMarkup: getControlKeyboard() });
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
        replyText(`<b>NEXT 6H ENTRY WINDOWS</b>\n<code>${escHtml(rows.join('\n'))}</code>`, { replyMarkup: getControlKeyboard() });
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
        replyText(out.join('\n'), { replyMarkup: getControlKeyboard() });
    } catch (e) {
        replyText(`error: ${escHtml(e.message)}`);
    }
}

async function cmdLiveProof(argStr = '') {
    try {
        if (typeof deps.runLiveOrderProof !== 'function') {
            return replyText('Live proof unavailable on this deploy.', { replyMarkup: getControlKeyboard() });
        }
        const parts = String(argStr || '').trim().split(/\s+/).filter(Boolean);
        const asset = String(parts[0] || 'BTC').toUpperCase();
        const direction = String(parts[1] || 'UP').toUpperCase();
        if (!['UP', 'DOWN'].includes(direction)) {
            return replyText('Usage: /liveproof [BTC|ETH|SOL|XRP] [UP|DOWN]\nDefault: /liveproof BTC UP', { replyMarkup: getControlKeyboard() });
        }
        replyText(`🧾 Running owner-authorized live order acceptance proof: ${escHtml(asset)} 15m ${escHtml(direction)}. Default proof aims for accepted orderID then no-fill/cancel.`);
        const proof = await deps.runLiveOrderProof({ asset, timeframe: '15m', direction });
        const order = proof.order || {};
        const lines = [
            `<b>LIVE ORDER PROOF</b> ${proof.success ? '✅' : '❌'}`,
            `Type: ${escHtml(proof.proofType || 'unknown')}`,
            `Market: ${escHtml(proof.market?.asset || asset)} ${escHtml(proof.market?.timeframe || '15m')} ${escHtml(proof.market?.direction || direction)}`,
            `Book: bid=${escHtml(proof.market?.bestBid)} ask=${escHtml(proof.market?.bestAsk)} minSize=${escHtml(proof.market?.minOrderSize)}`,
            `Accepted: <b>${order.acceptedOrder ? 'YES' : 'NO'}</b> | orderID: ${order.orderID ? `<code>${escHtml(order.orderID)}</code>` : 'none'}`,
            `Matched: ${order.success ? 'YES' : 'NO'} | shares=${escHtml(order.matchedShares || 0)} | fill=${escHtml(order.fillStatus || 'n/a')}`,
            order.error ? `Result note: ${escHtml(order.error)}` : null,
            order.clobFailureSummary ? `CLOB failure: <code>${escHtml(order.clobFailureSummary)}</code>` : null,
            `Balance before/after: ${fmtUsd(proof.beforeBalance?.tradingBalanceUsdc)} → ${fmtUsd(proof.afterBalance?.tradingBalanceUsdc)}`,
            escHtml(proof.note || '')
        ].filter(Boolean);
        return replyText(lines.join('\n'), { replyMarkup: getControlKeyboard() });
    } catch (e) {
        return replyText(`🧾 <b>LIVE ORDER PROOF BLOCKED/FAILED</b>\n${escHtml(e.message)}${e.note ? `\n${escHtml(e.note)}` : ''}`, { replyMarkup: getControlKeyboard() });
    }
}

async function pauseTrading() {
    deps.riskManager.tradingPaused = true;
    await deps.saveRuntimeState?.();
}

async function resumeTrading() {
    deps.riskManager.tradingPaused = false;
    deps.clearHalts?.();
    await deps.saveRuntimeState?.();
}

async function resetValidatorFromTelegram() {
    if (typeof deps.resetValidatorBaseline !== 'function') {
        throw new Error('Validator reset unavailable.');
    }
    return deps.resetValidatorBaseline({
        clearTradeLog: false,
        preservePause: true,
        trigger: 'TG_BUTTON',
        source: 'telegram_button'
    });
}

async function cmdPause() {
    try {
        await pauseTrading();
        replyText('⏸️ Trading paused. Use the buttons below to resume or inspect status.', { replyMarkup: getControlKeyboard() });
    } catch (e) {
        replyText(`error: ${escHtml(e.message)}`);
    }
}

async function cmdResume() {
    try {
        await resumeTrading();
        replyText('✅ Trading resumed. Halts cleared.', { replyMarkup: getControlKeyboard() });
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
    replyText(`Verbosity set to <b>${up}</b>.`, { replyMarkup: getControlKeyboard() });
}

function cmdId(chatId) {
    replyText(`Your chat id: <code>${escHtml(String(chatId))}</code>`, { chatId, replyMarkup: getControlKeyboard() });
}

// ---------- Dispatcher ----------
async function handleMessage(message) {
    const chatId = message?.chat?.id;
    const text = String(message?.text || '').trim();
    if (!chatId || !text) return;
    const [raw, ...rest] = text.split(/\s+/);
    const cmd = raw.replace(/@\w+$/, '').toLowerCase();
    const argStr = rest.join(' ');
    if (cmd === '/id') return cmdId(chatId);
    const ownerChat = String(CONFIG.TELEGRAM.chatId || '');
    if (String(chatId) !== ownerChat) {
        console.log(`⚠️ Telegram command ignored from unauthorized chat id ${chatId}`);
        return;
    }
    switch (cmd) {
        case '/help': return cmdHelp();
        case '/dashboard': return cmdDashboard();
        case '/status': return cmdStatus();
        case '/balance': return cmdBalance();
        case '/wr': return cmdWr();
        case '/recent': return cmdRecent(argStr);
        case '/next': return cmdNext();
        case '/health': return cmdHealth();
        case '/liveproof': return cmdLiveProof(argStr);
        case '/pause': return cmdPause();
        case '/resume': return cmdResume();
        case '/mode': return cmdMode();
        case '/paper': return cmdPaper();
        case '/live': return cmdLive();
        case '/deposit': return cmdDeposit();
        case '/withdraw': return cmdWithdraw(argStr);
        case '/confirm_withdraw': return cmdConfirmWithdraw(argStr);
        case '/verbosity': return cmdVerbosity(argStr);
        case '/id': return cmdId(chatId);
        case '/start': return cmdDashboard();
        default: return;
    }
}

async function handleCallbackQuery(callbackQuery) {
    const callbackId = callbackQuery?.id;
    const data = String(callbackQuery?.data || '');
    const chatId = callbackQuery?.message?.chat?.id;
    const ownerChat = String(CONFIG.TELEGRAM.chatId || '');
    if (!callbackId) return;
    if (!chatId || String(chatId) !== ownerChat) {
        answerCallbackQuery(callbackId, 'Unauthorized chat id.', true);
        return;
    }
    try {
        if (data === 'pp_dashboard' || data === 'pp_status') {
            await cmdDashboard();
            answerCallbackQuery(callbackId, 'Dashboard sent');
            return;
        }
        if (data === 'pp_balance') {
            await cmdBalance();
            answerCallbackQuery(callbackId, 'Balance sent');
            return;
        }
        if (data === 'pp_deposit') {
            await cmdDeposit();
            answerCallbackQuery(callbackId, 'Deposit instructions sent');
            return;
        }
        if (data === 'pp_withdraw') {
            await cmdWithdraw('');
            answerCallbackQuery(callbackId, 'Withdrawal status sent');
            return;
        }
        if (data === 'pp_next') {
            cmdNext();
            answerCallbackQuery(callbackId, 'Next windows sent');
            return;
        }
        if (data === 'pp_liveproof') {
            await cmdLiveProof('BTC UP');
            answerCallbackQuery(callbackId, 'Live proof started');
            return;
        }
        if (data === 'pp_health') {
            cmdHealth();
            answerCallbackQuery(callbackId, 'Health sent');
            return;
        }
        if (data === 'pp_pause') {
            await pauseTrading();
            replyText('⏸️ Trading paused. Use the buttons below to resume or inspect status.', { replyMarkup: getControlKeyboard() });
            answerCallbackQuery(callbackId, 'Trading paused');
            return;
        }
        if (data === 'pp_resume') {
            await resumeTrading();
            replyText('✅ Trading resumed. Halts cleared.', { replyMarkup: getControlKeyboard() });
            answerCallbackQuery(callbackId, 'Trading resumed');
            return;
        }
        if (data === 'pp_mode_paper') {
            await switchModeFromTelegram('PAPER');
            answerCallbackQuery(callbackId, 'Switched to PAPER and paused');
            return;
        }
        if (data === 'pp_mode_live') {
            cmdLive();
            answerCallbackQuery(callbackId, 'Confirm LIVE switch');
            return;
        }
        if (data === 'pp_confirm_mode_live') {
            await switchModeFromTelegram('LIVE');
            answerCallbackQuery(callbackId, 'LIVE selected; bot remains paused');
            return;
        }
        if (data === 'pp_reset_validator') {
            replyText(
                '⚠️ <b>Confirm validator reset?</b>\nThis will rebase monitoring and clear validator alert state. Trade history will be preserved.',
                { replyMarkup: getResetConfirmKeyboard() }
            );
            answerCallbackQuery(callbackId, 'Confirm validator reset');
            return;
        }
        if (data === 'pp_confirm_reset_validator') {
            const result = await resetValidatorFromTelegram();
            replyText(
                `♻️ <b>VALIDATOR RESET COMPLETE</b>\n` +
                `Baseline: <b>${fmtUsd(result.baselineBalance)}</b>\n` +
                `Severity: <b>${escHtml(result.report?.severity || 'UNKNOWN')}</b>`,
                { replyMarkup: getControlKeyboard() }
            );
            answerCallbackQuery(callbackId, 'Validator reset complete');
            return;
        }
        if (data.startsWith('pp_confirm_withdraw:')) {
            await cmdConfirmWithdraw(data.split(':')[1] || '');
            answerCallbackQuery(callbackId, 'Withdrawal confirmation processed');
            return;
        }
        if (data === 'pp_cancel_withdraw') {
            pendingWithdraw = null;
            answerCallbackQuery(callbackId, 'Withdrawal cancelled');
            replyText('Withdrawal cancelled. No funds were moved.', { replyMarkup: getControlKeyboard() });
            return;
        }
        if (data === 'pp_cancel') {
            answerCallbackQuery(callbackId, 'Cancelled');
            replyText('Cancelled. No control action was performed.', { replyMarkup: getControlKeyboard() });
            return;
        }
        answerCallbackQuery(callbackId, 'Unknown action');
    } catch (e) {
        replyText(`error: ${escHtml(e.message)}`, { replyMarkup: getControlKeyboard() });
        answerCallbackQuery(callbackId, 'Action failed', true);
    }
}

// ---------- Long-poll loop ----------
async function pollOnce() {
    if (!CONFIG.TELEGRAM.enabled || !CONFIG.TELEGRAM.botToken) return;
    const url = `/bot${CONFIG.TELEGRAM.botToken}/getUpdates?timeout=25&offset=${updateOffset}&allowed_updates=%5B%22message%22%2C%22callback_query%22%5D`;
    const resp = await getJson(url);
    if (!resp || resp.ok !== true) return;
    const updates = Array.isArray(resp.result) ? resp.result : [];
    for (const u of updates) {
        updateOffset = Math.max(updateOffset, (Number(u.update_id) || 0) + 1);
        try {
            if (u.message) await handleMessage(u.message);
            if (u.callback_query) await handleCallbackQuery(u.callback_query);
        } catch (e) {
            console.log(`⚠️ telegram-commands handler error: ${e.message}`);
        }
    }
}

function startCommandLoop(injectedDeps) {
    if (running) return;
    deps = injectedDeps || {};
    if (!CONFIG.TELEGRAM.enabled) return;
    if (!CONFIG.TELEGRAM.botToken) {
        console.log('⚠️ Telegram commands enabled but TELEGRAM_BOT_TOKEN is missing');
        return;
    }
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
