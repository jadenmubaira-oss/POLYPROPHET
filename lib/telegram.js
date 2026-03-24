const https = require('https');
const CONFIG = require('./config');

function sendMessage(text) {
    if (!CONFIG.TELEGRAM.enabled || !CONFIG.TELEGRAM.botToken || !CONFIG.TELEGRAM.chatId) return;

    const payload = JSON.stringify({
        chat_id: CONFIG.TELEGRAM.chatId,
        text,
        parse_mode: 'HTML'
    });

    const options = {
        hostname: 'api.telegram.org',
        path: `/bot${CONFIG.TELEGRAM.botToken}/sendMessage`,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
    };

    const req = https.request(options, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
            if (res.statusCode !== 200) {
                console.log(`⚠️ Telegram send failed: ${res.statusCode}`);
            }
        });
    });
    req.on('error', () => {});
    req.write(payload);
    req.end();
}

function notifyTradeOpen(result) {
    if (CONFIG.TELEGRAM.signalsOnly) return;
    const emoji = result.mode === 'LIVE' ? '🔴' : '📝';
    const msg = `${emoji} <b>${result.mode} TRADE OPENED</b>\n` +
        `Asset: <b>${result.asset}</b> | TF: ${result.timeframe}\n` +
        `Direction: ${result.direction} @ ${(result.entryPrice * 100).toFixed(1)}¢\n` +
        `Size: $${result.size.toFixed(2)} (${result.shares} shares)`;
    sendMessage(msg);
}

function notifyTradeClose(result) {
    if (CONFIG.TELEGRAM.signalsOnly) return;
    const emoji = result.won ? '✅' : '❌';
    const msg = `${emoji} <b>TRADE ${result.won ? 'WON' : 'LOST'}</b>\n` +
        `PnL: $${result.pnl.toFixed(2)}\n` +
        `Balance: $${result.bankrollAfter.toFixed(2)}`;
    sendMessage(msg);
}

function notifyDailySummary(status) {
    const msg = `📊 <b>DAILY SUMMARY</b>\n` +
        `Balance: $${status.bankroll.toFixed(2)}\n` +
        `Today P&L: $${status.todayPnL.toFixed(2)}\n` +
        `Total: ${status.totalTrades} trades (${status.winRate}% WR)\n` +
        `Peak: $${status.peakBalance.toFixed(2)} | DD: ${status.drawdownFromPeak}%`;
    sendMessage(msg);
}

function notifySignal(candidate, market) {
    const msg = `📡 <b>SIGNAL</b>: ${candidate.asset} ${candidate.timeframe} ${candidate.direction}\n` +
        `Entry: ${(candidate.entryPrice * 100).toFixed(1)}¢ | pWin: ${(candidate.pWinEstimate * 100).toFixed(1)}%\n` +
        `Strategy: ${candidate.name}`;
    sendMessage(msg);
}

module.exports = { sendMessage, notifyTradeOpen, notifyTradeClose, notifyDailySummary, notifySignal };
