const https = require('https');
const crypto = require('crypto');
const CONFIG = require('./config');
const PolymarketCLOB = require('./clob-client');

class TradeExecutor {
    constructor(riskManager) {
        this.risk = riskManager;
        this.positions = [];
        this.pendingRedemptions = [];
        this.mode = CONFIG.TRADE_MODE;
        this.paperBalance = CONFIG.RISK.startingBalance;
        this.cachedLiveBalance = null;
        this.startupTime = Date.now();
        this.clob = new PolymarketCLOB();
        if (CONFIG.POLYMARKET_PRIVATE_KEY) {
            this.clob.loadWallet();
        }
    }

    async executeTrade(candidate, market) {
        const { asset, timeframe, direction, entryPrice, pWinEstimate, name, signature } = candidate;

        // Check risk gates
        const riskCheck = this.risk.canTrade({ ...candidate, epoch: market.epoch });
        if (!riskCheck.allowed) {
            return { success: false, error: riskCheck.reasons.join(', '), blocked: true };
        }

        // Calculate position size
        const sizing = this.risk.calculateSize(candidate);
        if (sizing.blocked) {
            return { success: false, error: sizing.reason, blocked: true };
        }

        const size = sizing.size;
        if (size <= 0) {
            return { success: false, error: 'SIZE_ZERO', blocked: true };
        }

        const shares = Math.floor(size / entryPrice);
        if (shares < CONFIG.RISK.minOrderShares) {
            return { success: false, error: `SHARES_BELOW_MIN (${shares} < ${CONFIG.RISK.minOrderShares})`, blocked: true };
        }

        const tokenType = direction === 'UP' ? 'YES' : 'NO';
        const tokenId = direction === 'UP' ? market.yesTokenId : market.noTokenId;

        if (!tokenId) {
            return { success: false, error: 'NO_TOKEN_ID', blocked: true };
        }

        const positionId = `${asset}_${timeframe}_${market.epoch}_${Date.now()}`;

        console.log(`\n🎯 ═══════════════════════════════════════`);
        console.log(`🎯 ${this.mode} TRADE ENTRY — ${timeframe.toUpperCase()}`);
        console.log(`🎯 Asset: ${asset} | Direction: ${direction} (${tokenType})`);
        console.log(`🎯 Entry: ${(entryPrice * 100).toFixed(1)}¢ | Shares: ${shares} | Size: $${size.toFixed(2)}`);
        console.log(`🎯 Strategy: ${name} | pWin: ${(pWinEstimate * 100).toFixed(1)}%`);
        console.log(`🎯 ═══════════════════════════════════════\n`);

        if (this.mode === 'PAPER') {
            return this._executePaperTrade(positionId, candidate, market, size, shares, tokenId);
        } else {
            return this._executeLiveTrade(positionId, candidate, market, size, shares, tokenId);
        }
    }

    _executePaperTrade(positionId, candidate, market, size, shares, tokenId) {
        const { asset, timeframe, direction, entryPrice, name } = candidate;

        const position = {
            id: positionId,
            asset,
            timeframe,
            direction,
            entryPrice,
            size,
            shares,
            tokenId,
            slug: market.slug,
            epoch: market.epoch,
            strategy: name,
            openedAt: new Date().toISOString(),
            status: 'OPEN',
            isLive: false
        };

        this.positions.push(position);
        this.paperBalance -= size;
        // BUG 4 FIX: Sync risk manager bankroll on trade open (lock capital)
        this.risk.bankroll -= size;

        console.log(`📝 PAPER TRADE OPENED: ${positionId} | Balance: $${this.paperBalance.toFixed(2)}`);

        return {
            success: true,
            positionId,
            size,
            shares,
            entryPrice,
            direction,
            asset,
            timeframe: candidate.timeframe,
            mode: 'PAPER'
        };
    }

    async _executeLiveTrade(positionId, candidate, market, size, shares, tokenId) {
        const { asset, timeframe, direction, entryPrice, name } = candidate;

        if (!CONFIG.IS_LIVE) {
            return { success: false, error: 'LIVE_TRADING_NOT_ENABLED', blocked: true };
        }

        try {
            // Place order via CLOB API
            const order = await this._placeCLOBOrder(tokenId, entryPrice, shares, 'BUY');

            if (!order || order.error) {
                console.log(`❌ CLOB ORDER FAILED: ${order?.error || 'unknown'}`);
                return { success: false, error: `CLOB_ORDER_FAILED: ${order?.error || 'unknown'}` };
            }

            const position = {
                id: positionId,
                asset,
                timeframe,
                direction,
                entryPrice,
                size,
                shares,
                tokenId,
                slug: market.slug,
                epoch: market.epoch,
                strategy: name,
                conditionId: market.conditionId,
                orderID: order.orderID,
                openedAt: new Date().toISOString(),
                status: 'OPEN',
                isLive: true
            };

            this.positions.push(position);

            console.log(`✅ LIVE TRADE OPENED: ${positionId} | Order: ${order.orderID}`);

            return {
                success: true,
                positionId,
                orderID: order.orderID,
                size,
                shares,
                entryPrice,
                direction,
                asset,
                timeframe: candidate.timeframe,
                mode: 'LIVE'
            };
        } catch (e) {
            console.error(`❌ LIVE TRADE ERROR: ${e.message}`);
            return { success: false, error: `LIVE_TRADE_ERROR: ${e.message}` };
        }
    }

    async _placeCLOBOrder(tokenId, price, size, side) {
        if (!this.clob.isReady()) {
            return { error: 'CLOB client not ready (wallet/deps missing)' };
        }

        const result = await this.clob.placeOrder(tokenId, price, size, side);
        if (result.success) {
            return { orderID: result.orderID, status: result.fillStatus, matchedShares: result.matchedShares };
        } else {
            return { error: result.error || 'Order failed' };
        }
    }

    resolvePosition(positionId, won) {
        const pos = this.positions.find(p => p.id === positionId);
        if (!pos) return null;

        pos.status = won ? 'WON' : 'LOST';
        pos.resolvedAt = new Date().toISOString();

        const payout = won ? pos.shares * 1.0 : 0;
        const pnl = payout - pos.size;

        if (this.mode === 'PAPER') {
            // BUG 4 FIX: Add back payout (not size — size was already deducted on open)
            this.paperBalance += payout;
            // Sync risk manager: add back the locked capital + pnl
            this.risk.bankroll += pos.size + pnl;
        }

        this.risk.recordTrade({
            asset: pos.asset,
            timeframe: pos.timeframe,
            direction: pos.direction,
            entryPrice: pos.entryPrice,
            size: pos.size,
            won,
            pnl,
            epoch: pos.epoch
        });

        const emoji = won ? '✅' : '❌';
        console.log(`${emoji} TRADE RESOLVED: ${pos.asset} ${pos.timeframe} ${pos.direction} → ${won ? 'WIN' : 'LOSS'} | PnL: $${pnl.toFixed(2)} | Balance: $${this.risk.bankroll.toFixed(2)}`);

        return { positionId, won, pnl, payout, bankrollAfter: this.risk.bankroll };
    }

    checkAndResolveExpiredPositions(currentMarkets) {
        const nowSec = Math.floor(Date.now() / 1000);
        const resolved = [];

        for (const pos of this.positions) {
            if (pos.status !== 'OPEN') continue;

            const tf = CONFIG.TIMEFRAMES.find(t => t.key === pos.timeframe);
            if (!tf) continue;

            const posEndEpoch = pos.epoch + tf.seconds;
            if (nowSec < posEndEpoch) continue;

            // Position's cycle has ended — check resolution
            const marketKey = `${pos.asset}_${pos.timeframe}`;
            const market = currentMarkets[marketKey];

            // For paper mode, simulate resolution based on whether the cycle market resolved
            // In live mode, the CLOB handles settlement
            if (this.mode === 'PAPER') {
                // Check if we can determine the outcome
                // The position wins if the direction matches the resolution
                // We'll check the next cycle's market to see if this one resolved
                const slug = `${pos.asset.toLowerCase()}-updown-${pos.timeframe}-${pos.epoch}`;
                // Mark for async resolution check
                this.pendingRedemptions.push({ positionId: pos.id, slug, epoch: pos.epoch, tf: tf.key });
            }
        }

        return resolved;
    }

    getOpenPositions() {
        return this.positions.filter(p => p.status === 'OPEN');
    }

    getRecentTrades(limit = 20) {
        return this.positions.slice(-limit);
    }

    getStatus() {
        const open = this.positions.filter(p => p.status === 'OPEN');
        const won = this.positions.filter(p => p.status === 'WON');
        const lost = this.positions.filter(p => p.status === 'LOST');
        return {
            mode: this.mode,
            openPositions: open.length,
            totalTrades: this.positions.length,
            wins: won.length,
            losses: lost.length,
            winRate: (won.length + lost.length) > 0
                ? (won.length / (won.length + lost.length) * 100).toFixed(1)
                : 'N/A',
            paperBalance: this.mode === 'PAPER' ? this.paperBalance : null,
            positions: open.map(p => ({
                id: p.id,
                asset: p.asset,
                timeframe: p.timeframe,
                direction: p.direction,
                entryPrice: p.entryPrice,
                size: p.size,
                strategy: p.strategy,
                openedAt: p.openedAt
            }))
        };
    }
}

module.exports = TradeExecutor;
