const https = require('https');
const crypto = require('crypto');
const CONFIG = require('./config');
const PolymarketCLOB = require('./clob-client');

class TradeExecutor {
    constructor(riskManager) {
        this.risk = riskManager;
        this.positions = [];
        this.pendingRedemptions = [];
        this.pendingSells = {};
        this.pendingBuys = {};
        this.redemptionQueue = [];
        this.redemptionEvents = [];
        this.recoveryQueue = [];
        this.closedPositions = [];
        this.mode = CONFIG.TRADE_MODE;
        this.paperBalance = CONFIG.RISK.startingBalance;
        this.startingBalance = CONFIG.RISK.startingBalance;
        this.cachedLiveBalance = 0;
        this.lastGoodBalance = 0;
        this.lastBalanceFetch = 0;
        this.cachedOnChainBalance = 0;
        this.cachedClobCollateralBalance = 0;
        this.liveBalanceSource = 'UNINITIALIZED';
        this.baselineBankroll = CONFIG.RISK.startingBalance;
        this.baselineBankrollInitialized = CONFIG.TRADE_MODE !== 'LIVE';
        this.baselineBankrollSource = CONFIG.TRADE_MODE === 'LIVE' ? 'pending_live_fetch' : 'paper_balance';
        this.lastInternalBalanceEventAt = 0;
        this.startupTime = Date.now();
        this.clob = new PolymarketCLOB();
        if (CONFIG.POLYMARKET_PRIVATE_KEY) {
            this.clob.loadWallet();
        }
    }

    _positionIndex(positionId) {
        return this.positions.findIndex(p => p.id === positionId);
    }

    _getPosition(positionId) {
        return this.positions.find(p => p.id === positionId) || null;
    }

    getPendingSells() {
        return this.pendingSells || {};
    }

    getPendingBuys() {
        return this.pendingBuys || {};
    }

    findOpenPositionByOrderId(orderID) {
        if (!orderID) return null;
        const position = this.positions.find(pos => pos?.orderID === orderID && ['OPEN', 'PENDING_RESOLUTION', 'SELL_PENDING'].includes(pos.status));
        if (!position) return null;
        return { positionId: position.id, position };
    }

    _countActiveLivePositions() {
        return this.positions.filter(p => p.isLive && ['OPEN', 'PENDING_RESOLUTION', 'SELL_PENDING'].includes(p.status)).length;
    }

    _markInternalBalanceEvent() {
        this.lastInternalBalanceEventAt = Date.now();
    }

    buildLiveBalanceBreakdown(usdcResult = null, clobResult = null) {
        const sanitize = (n) => {
            const val = Number(n);
            return Number.isFinite(val) ? Math.max(0, val) : 0;
        };

        const onChainSuccess = !!(usdcResult && usdcResult.success && usdcResult.balance !== undefined);
        const clobSuccess = !!(clobResult && clobResult.success && clobResult.balance !== undefined);
        const onChainUsdc = onChainSuccess ? sanitize(usdcResult.balance) : sanitize(this.cachedOnChainBalance);
        const clobCollateralUsdc = clobSuccess ? sanitize(clobResult.balance) : sanitize(this.cachedClobCollateralBalance);
        const lastKnownTradingBalance = sanitize(this.cachedLiveBalance || this.lastGoodBalance);

        let tradingBalanceUsdc = 0;
        let source = 'UNKNOWN';

        if (onChainSuccess && onChainUsdc > 0) {
            tradingBalanceUsdc = onChainUsdc;
            source = 'ON_CHAIN_USDC';
        } else if (clobSuccess && clobCollateralUsdc > 0) {
            tradingBalanceUsdc = clobCollateralUsdc;
            source = 'CLOB_COLLATERAL_FALLBACK';
        } else if (onChainSuccess && clobSuccess) {
            tradingBalanceUsdc = 0;
            source = 'ZERO_CONFIRMED';
        } else if (lastKnownTradingBalance > 0) {
            tradingBalanceUsdc = lastKnownTradingBalance;
            source = 'LAST_KNOWN_GOOD';
        }

        const sourceLabel = source === 'ON_CHAIN_USDC'
            ? 'On-chain USDC'
            : source === 'CLOB_COLLATERAL_FALLBACK'
                ? 'CLOB collateral fallback'
                : source === 'ZERO_CONFIRMED'
                    ? 'Confirmed zero balance'
                    : source === 'LAST_KNOWN_GOOD'
                        ? 'Last known good balance'
                        : 'Unknown';

        const updatedAt = this.lastBalanceFetch || 0;
        return {
            onChainUsdc,
            clobCollateralUsdc,
            tradingBalanceUsdc,
            source,
            sourceLabel,
            updatedAt,
            updatedIso: updatedAt ? new Date(updatedAt).toISOString() : null
        };
    }

    getCachedBalanceBreakdown() {
        return this.buildLiveBalanceBreakdown(null, null);
    }

    async refreshLiveBalance(force = false) {
        if (!this.clob?.wallet) return null;

        const cacheValid = !force && (Date.now() - this.lastBalanceFetch < 30000) && this.cachedLiveBalance > 0;
        if (cacheValid) return this.getCachedBalanceBreakdown();

        const lastGoodBalance = Number(this.cachedLiveBalance || this.lastGoodBalance || 0);
        const previousBalance = Number(this.cachedLiveBalance || this.lastGoodBalance || 0);

        try {
            const [usdcResult, clobResult] = await Promise.all([
                this.clob.getOnChainUsdcBalance(),
                this.clob.getClobCollateralBalance()
            ]);

            if (usdcResult?.success && usdcResult.balance !== undefined) {
                this.cachedOnChainBalance = Math.max(0, Number(usdcResult.balance) || 0);
            }
            if (clobResult?.success && clobResult.balance !== undefined) {
                this.cachedClobCollateralBalance = Math.max(0, Number(clobResult.balance) || 0);
            }

            const breakdown = this.buildLiveBalanceBreakdown(usdcResult, clobResult);
            const tradingBalance = breakdown.tradingBalanceUsdc;

            if (breakdown.source === 'ZERO_CONFIRMED') {
                this.cachedLiveBalance = 0;
                this.lastGoodBalance = 0;
                this.liveBalanceSource = 'ZERO_CONFIRMED';
                this.lastBalanceFetch = Date.now();
                if (this.mode === 'LIVE') {
                    this.risk.rebaseBalance(0, { resetDay: false });
                }
                return breakdown;
            }

            if (tradingBalance > 0) {
                this.cachedLiveBalance = tradingBalance;
                this.lastGoodBalance = tradingBalance;
                this.liveBalanceSource = breakdown.source;
                this.lastBalanceFetch = Date.now();

                if (this.mode === 'LIVE' && !this.baselineBankrollInitialized) {
                    this.baselineBankroll = tradingBalance;
                    this.baselineBankrollInitialized = true;
                    this.baselineBankrollSource = 'first_live_fetch';
                    this.startingBalance = tradingBalance;
                } else if (
                    this.mode === 'LIVE' &&
                    this.baselineBankrollInitialized &&
                    previousBalance > 0 &&
                    Math.abs(tradingBalance - previousBalance) >= 0.5 &&
                    this._countActiveLivePositions() === 0 &&
                    (Date.now() - (this.lastInternalBalanceEventAt || 0)) > 120000
                ) {
                    this.baselineBankroll = tradingBalance;
                    this.baselineBankrollSource = 'external_balance_rebase';
                    this.startingBalance = tradingBalance;
                    this.risk.rebaseBalance(tradingBalance, { resetDay: true, forcePeak: true });
                    return this.getCachedBalanceBreakdown();
                }

                if (this.mode === 'LIVE') {
                    this.risk.rebaseBalance(tradingBalance, { resetDay: false });
                }

                return this.getCachedBalanceBreakdown();
            }

            if (lastGoodBalance > 0) {
                this.cachedLiveBalance = lastGoodBalance;
                this.liveBalanceSource = 'LAST_KNOWN_GOOD';
                if (this.mode === 'LIVE') {
                    this.risk.rebaseBalance(lastGoodBalance, { resetDay: false });
                }
            }

            return this.getCachedBalanceBreakdown();
        } catch (e) {
            if (lastGoodBalance > 0) {
                this.cachedLiveBalance = lastGoodBalance;
                this.liveBalanceSource = 'LAST_KNOWN_GOOD';
                if (this.mode === 'LIVE') {
                    this.risk.rebaseBalance(lastGoodBalance, { resetDay: false });
                }
            }
            return this.getCachedBalanceBreakdown();
        }
    }

    async executeTrade(candidate, market) {
        const { asset, timeframe, direction, entryPrice, pWinEstimate, name, signature } = candidate;

        if (this.mode === 'LIVE') {
            await this.refreshLiveBalance().catch(() => null);
        }

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

        const shares = Math.floor(size / entryPrice + 1e-9);
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
            originalSize: size,
            shares,
            originalShares: shares,
            tokenType: direction === 'UP' ? 'YES' : 'NO',
            tokenId,
            slug: market.slug,
            epoch: market.epoch,
            strategy: name,
            conditionId: market.conditionId || null,
            marketUrl: market.slug ? `https://polymarket.com/event/${market.slug}` : null,
            openedAt: new Date().toISOString(),
            status: 'OPEN',
            isLive: false,
            mode: 'PAPER'
        };

        this.positions.push(position);
        this.paperBalance -= size;
        // BUG 4 FIX: Sync risk manager bankroll on trade open (lock capital)
        this.risk.bankroll -= size;
        this.risk.registerTradeOpen(candidate.timeframe, market.epoch);

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
                if (order?.orderID && order.error === 'NO_FILL_AFTER_RETRIES') {
                    const pendingBuyKey = `${asset}_${tokenId}_${order.orderID}`;
                    this.pendingBuys[pendingBuyKey] = {
                        positionId,
                        asset,
                        timeframe,
                        direction,
                        tokenType: direction === 'UP' ? 'YES' : 'NO',
                        entryPrice,
                        requestedSize: size,
                        requestedShares: Number(order.requestedShares || shares),
                        orderID: order.orderID,
                        tokenId,
                        slug: market.slug || null,
                        conditionId: market.conditionId || null,
                        marketUrl: market.slug ? `https://polymarket.com/event/${market.slug}` : null,
                        epoch: market.epoch,
                        strategy: name,
                        openedAt: new Date().toISOString(),
                        partialFill: !!order.partialFill,
                        fillStatus: order.status || null
                    };
                }
                console.log(`❌ CLOB ORDER FAILED: ${order?.error || 'unknown'}`);
                return { success: false, error: `CLOB_ORDER_FAILED: ${order?.error || 'unknown'}` };
            }

            const matchedShares = Number(order.matchedShares || 0);
            const actualShares = matchedShares > 0 ? matchedShares : shares;
            const actualSize = Number(order.matchedSize || (actualShares * entryPrice));

            const position = {
                id: positionId,
                asset,
                timeframe,
                direction,
                entryPrice,
                size: actualSize,
                originalSize: actualSize,
                shares: actualShares,
                originalShares: actualShares,
                tokenType: direction === 'UP' ? 'YES' : 'NO',
                tokenId,
                slug: market.slug,
                epoch: market.epoch,
                strategy: name,
                conditionId: market.conditionId || null,
                marketUrl: market.slug ? `https://polymarket.com/event/${market.slug}` : null,
                orderID: order.orderID,
                partialFill: !!order.partialFill,
                requestedShares: Number(order.requestedShares || shares),
                openedAt: new Date().toISOString(),
                status: 'OPEN',
                isLive: true,
                mode: 'LIVE'
            };

            this.positions.push(position);
            for (const [pendingKey, pendingBuy] of Object.entries(this.pendingBuys || {})) {
                if (pendingBuy?.orderID === order.orderID) {
                    delete this.pendingBuys[pendingKey];
                }
            }
            this.risk.registerTradeOpen(candidate.timeframe, market.epoch);
            this._markInternalBalanceEvent();
            await this.refreshLiveBalance(true).catch(() => null);

            console.log(`✅ LIVE TRADE OPENED: ${positionId} | Order: ${order.orderID}`);

            return {
                success: true,
                positionId,
                orderID: order.orderID,
                size: actualSize,
                shares: actualShares,
                entryPrice,
                direction,
                asset,
                timeframe: candidate.timeframe,
                mode: 'LIVE',
                partialFill: !!order.partialFill,
                requestedShares: Number(order.requestedShares || shares)
            };
        } catch (e) {
            console.error(`❌ LIVE TRADE ERROR: ${e.message}`);
            return { success: false, error: `LIVE_TRADE_ERROR: ${e.message}` };
        }
    }

    recordRecoveredPendingBuy(pendingBuy, actualShares, orderStatus = null) {
        if (!pendingBuy || !pendingBuy.orderID) return { recovered: false, reason: 'INVALID_PENDING_BUY' };

        const existing = this.findOpenPositionByOrderId(pendingBuy.orderID);
        if (existing) {
            return { recovered: false, reason: 'POSITION_ALREADY_EXISTS', positionId: existing.positionId };
        }

        const entryPrice = Number(pendingBuy.entryPrice || pendingBuy.entry);
        const matchedSharesRaw = Number(actualShares);
        const matchedShares = Number.isFinite(matchedSharesRaw) ? matchedSharesRaw : 0;
        if (!(matchedShares > 0) || !(entryPrice > 0)) {
            return { recovered: false, reason: 'NO_VERIFIED_MATCH' };
        }

        const actualSize = matchedShares * entryPrice;
        const positionId = pendingBuy.positionId || pendingBuy.id || `${pendingBuy.asset}_${pendingBuy.timeframe || '15m'}_${Date.now()}`;
        const recoveredAt = new Date().toISOString();
        const position = {
            id: positionId,
            asset: pendingBuy.asset,
            timeframe: pendingBuy.timeframe,
            direction: pendingBuy.direction,
            entryPrice,
            size: actualSize,
            originalSize: actualSize,
            shares: matchedShares,
            originalShares: matchedShares,
            tokenType: pendingBuy.tokenType || (pendingBuy.direction === 'UP' ? 'YES' : 'NO'),
            tokenId: pendingBuy.tokenId || null,
            slug: pendingBuy.slug || null,
            epoch: pendingBuy.epoch || null,
            strategy: pendingBuy.strategy || pendingBuy.name || null,
            conditionId: pendingBuy.conditionId || null,
            marketUrl: pendingBuy.marketUrl || null,
            orderID: pendingBuy.orderID,
            partialFill: Number.isFinite(Number(pendingBuy.requestedShares))
                ? matchedShares + 1e-6 < Number(pendingBuy.requestedShares)
                : false,
            requestedShares: Number(pendingBuy.requestedShares || matchedShares),
            openedAt: pendingBuy.openedAt || recoveredAt,
            status: 'OPEN',
            isLive: true,
            mode: 'LIVE',
            recoveredFromPendingBuy: true,
            recoveredAt,
            recoveredOrderStatus: orderStatus?.order?.status || orderStatus?.status || null
        };

        this.positions.push(position);
        this.risk.registerTradeOpen(position.timeframe, position.epoch);
        this._markInternalBalanceEvent();
        return { recovered: true, positionId, actualSize, actualShares: matchedShares };
    }

    async processPendingBuys(maxItems = 2) {
        if (this.mode !== 'LIVE') return { success: true, processed: 0, recovered: 0, failed: 0 };

        const pendingEntries = Object.entries(this.pendingBuys || {});
        if (pendingEntries.length === 0) return { success: true, processed: 0, recovered: 0, failed: 0 };

        let processed = 0;
        let recovered = 0;
        let failed = 0;

        for (const [key, pendingBuy] of pendingEntries.slice(0, Math.max(1, maxItems))) {
            processed++;
            try {
                const existing = this.findOpenPositionByOrderId(pendingBuy?.orderID);
                if (existing) {
                    delete this.pendingBuys[key];
                    continue;
                }

                const orderStatus = await this.clob.getOrder(pendingBuy.orderID);
                const order = orderStatus?.order || {};
                const fillStatus = String(order?.status || 'UNKNOWN').toUpperCase();
                const matchedSharesRaw = Number(order?.size_matched || 0);
                const matchedShares = Number.isFinite(matchedSharesRaw) ? matchedSharesRaw : 0;

                if (matchedShares > 0) {
                    if (Number.isFinite(Number(pendingBuy.requestedShares)) && matchedShares + 1e-6 < Number(pendingBuy.requestedShares)) {
                        await this.clob.cancelOrder(pendingBuy.orderID).catch(() => null);
                    }

                    const res = this.recordRecoveredPendingBuy(pendingBuy, matchedShares, orderStatus);
                    delete this.pendingBuys[key];
                    if (res?.recovered) {
                        recovered++;
                    }
                    continue;
                }

                const ageMs = Date.now() - (Number(new Date(pendingBuy.openedAt || pendingBuy.createdAt || Date.now()).getTime()) || Date.now());
                const isFinalZeroFill = ['CANCELLED', 'EXPIRED', 'REJECTED', 'UNMATCHED'].includes(fillStatus);
                const isTooOld = ageMs > (15 * 60 * 1000);

                if (isFinalZeroFill || isTooOld) {
                    delete this.pendingBuys[key];
                    failed++;
                } else if (this.pendingBuys[key]) {
                    this.pendingBuys[key].lastRetryAt = Date.now();
                    this.pendingBuys[key].lastKnownStatus = fillStatus;
                    this.pendingBuys[key].lastKnownMatchedShares = matchedShares;
                }
            } catch (e) {
                failed++;
                if (this.pendingBuys[key]) {
                    this.pendingBuys[key].lastRetryAt = Date.now();
                    this.pendingBuys[key].lastRetryError = e?.message || String(e);
                }
            }
        }

        return { success: true, processed, recovered, failed };
    }

    async _placeCLOBOrder(tokenId, price, size, side) {
        if (!this.clob.isReady()) {
            return { error: 'CLOB client not ready (wallet/deps missing)' };
        }

        const result = await this.clob.placeOrder(tokenId, price, size, side);
        if (result.success) {
            return {
                orderID: result.orderID,
                status: result.fillStatus,
                matchedShares: result.matchedShares,
                matchedSize: result.matchedSize,
                partialFill: !!result.partialFill,
                requestedShares: result.requestedShares
            };
        } else {
            return {
                error: result.error || 'Order failed',
                orderID: result.orderID || null,
                status: result.fillStatus || null,
                matchedShares: result.matchedShares,
                matchedSize: result.matchedSize,
                partialFill: !!result.partialFill,
                requestedShares: result.requestedShares
            };
        }
    }

    _finalizePosition(positionId, exitPrice, reason, options = {}) {
        const pos = this._getPosition(positionId);
        if (!pos) return null;

        const shares = Number.isFinite(Number(options.shares))
            ? Number(options.shares)
            : Number(pos.originalShares || pos.shares || 0);
        const size = Number.isFinite(Number(options.size))
            ? Number(options.size)
            : Number(pos.originalSize || pos.size || (shares * pos.entryPrice));
        const payout = shares * exitPrice;
        const pnl = payout - size;
        const won = exitPrice >= 0.999;

        pos.exitPrice = exitPrice;
        pos.pnl = pnl;
        pos.payout = payout;
        pos.resolvedAt = new Date().toISOString();
        pos.closeReason = reason;
        pos.closedAt = pos.resolvedAt;
        pos.status = won ? 'WON' : (exitPrice <= 0.001 ? 'LOST' : 'CLOSED');
        pos.sellPending = false;
        pos.shares = 0;
        pos.size = 0;

        if (this.mode === 'PAPER' || !pos.isLive) {
            this.paperBalance += payout;
            this.risk.bankroll += payout;
            this.risk.recordTrade({
                asset: pos.asset,
                timeframe: pos.timeframe,
                direction: pos.direction,
                entryPrice: pos.entryPrice,
                size,
                won: pnl >= 0,
                pnl,
                epoch: pos.epoch
            }, { creditBalance: false });
        } else {
            this.risk.recordTrade({
                asset: pos.asset,
                timeframe: pos.timeframe,
                direction: pos.direction,
                entryPrice: pos.entryPrice,
                size,
                won,
                pnl,
                epoch: pos.epoch
            }, { creditBalance: false });
            if (won && pos.tokenId) {
                this.addToRedemptionQueue({ ...pos, shares });
            }
        }

        delete this.pendingSells[positionId];
        this.closedPositions.push({
            id: positionId,
            asset: pos.asset,
            timeframe: pos.timeframe,
            direction: pos.direction,
            exitPrice,
            pnl,
            won,
            closedAt: pos.closedAt,
            reason
        });
        if (this.closedPositions.length > 500) {
            this.closedPositions.splice(0, this.closedPositions.length - 500);
        }

        const emoji = pnl >= 0 ? '✅' : '❌';
        console.log(`${emoji} TRADE RESOLVED: ${pos.asset} ${pos.timeframe} ${pos.direction} → ${won ? 'WIN' : 'LOSS'} | PnL: $${pnl.toFixed(2)} | Balance: $${this.risk.bankroll.toFixed(2)}`);

        return { positionId, won, pnl, payout, bankrollAfter: this.risk.bankroll, exitPrice, reason };
    }

    async executeSellOrderWithRetry(position, exitPrice, maxAttempts = 3, delayMs = 2000) {
        const eps = 1e-6;
        const startShares = Number(position?.originalShares || position?.shares || 0);
        let remainingShares = Number(position?.shares || 0);
        let soldShares = Number(position?.soldShares || 0);
        let soldProceeds = Number(position?.soldProceeds || 0);
        let lastOrderID = null;

        if (!(remainingShares > eps)) {
            return { success: false, error: 'NO_REMAINING_SHARES', positionId: position?.id || null };
        }

        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            const result = await this._placeCLOBOrder(position.tokenId, exitPrice, remainingShares, 'SELL');

            if (result?.orderID) lastOrderID = result.orderID;
            if (result?.error) {
                if (attempt < maxAttempts) {
                    await new Promise(r => setTimeout(r, delayMs * Math.pow(2, attempt - 1)));
                }
                continue;
            }

            const matchedShares = Number(result?.matchedShares || 0);
            if (matchedShares > eps) {
                soldShares += matchedShares;
                soldProceeds += matchedShares * Number(exitPrice || 0);
                remainingShares = Math.max(0, remainingShares - matchedShares);
                position.soldShares = soldShares;
                position.soldProceeds = soldProceeds;
                position.shares = remainingShares;
                position.size = remainingShares * Number(position.entryPrice || 0);
            }

            if (remainingShares <= eps) {
                this._markInternalBalanceEvent();
                return {
                    success: true,
                    orderID: lastOrderID,
                    sellPrice: Number(exitPrice || 0),
                    avgExitPrice: soldShares > eps ? (soldProceeds / soldShares) : Number(exitPrice || 0),
                    soldShares,
                    startShares,
                    positionId: position.id
                };
            }

            if (attempt < maxAttempts) {
                await new Promise(r => setTimeout(r, delayMs * Math.pow(2, attempt - 1)));
            }
        }

        position.status = 'SELL_PENDING';
        position.sellPending = true;
        position.sellPendingSince = Date.now();
        position.sellPendingPrice = exitPrice;
        this.pendingSells[position.id] = {
            positionId: position.id,
            asset: position.asset,
            timeframe: position.timeframe,
            tokenId: position.tokenId,
            exitPrice,
            soldShares,
            soldProceeds,
            startShares,
            failedAt: Date.now()
        };

        return {
            success: false,
            error: `SELL_FAILED_AFTER_${maxAttempts}_ATTEMPTS`,
            positionId: position.id,
            soldShares,
            startShares
        };
    }

    async closePosition(positionId, exitPrice, reason = 'MANUAL_SELL') {
        const pos = this._getPosition(positionId);
        if (!pos) return { success: false, error: 'POSITION_NOT_FOUND' };
        if (!['OPEN', 'SELL_PENDING', 'PENDING_RESOLUTION'].includes(pos.status)) {
            return { success: false, error: `POSITION_NOT_OPEN (${pos.status})` };
        }

        if (pos.isLive && this.mode === 'LIVE' && exitPrice > 0.001 && exitPrice < 0.999) {
            const sell = await this.executeSellOrderWithRetry(pos, exitPrice, 3, 2000);
            if (!sell.success) return sell;
            await this.refreshLiveBalance(true).catch(() => null);
            return {
                success: true,
                closed: this._finalizePosition(positionId, Number(sell.avgExitPrice || exitPrice), reason, {
                    shares: Number(sell.startShares || pos.originalShares || 0),
                    size: Number(pos.originalSize || (Number(sell.startShares || 0) * Number(pos.entryPrice || 0)))
                })
            };
        }

        return { success: true, closed: this._finalizePosition(positionId, exitPrice, reason) };
    }

    resolvePosition(positionId, won) {
        return this._finalizePosition(positionId, won ? 1.0 : 0.0, won ? 'RESOLVED_WIN' : 'RESOLVED_LOSS');
    }

    checkAndResolveExpiredPositions(currentMarkets) {
        const nowSec = Math.floor(Date.now() / 1000);
        const resolved = [];

        for (const pos of this.positions) {
            if (!['OPEN', 'PENDING_RESOLUTION'].includes(pos.status)) continue;

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
                if (pos.status !== 'OPEN') continue;
                // Check if we can determine the outcome
                // The position wins if the direction matches the resolution
                // We'll check the next cycle's market to see if this one resolved
                const slug = `${pos.asset.toLowerCase()}-updown-${pos.timeframe}-${pos.epoch}`;
                // Mark for async resolution check
                pos.status = 'PENDING_RESOLUTION';
                pos.pendingSince = Date.now();
                pos.pendingSlug = slug;
                this.pendingRedemptions.push({ positionId: pos.id, slug, epoch: pos.epoch, tf: tf.key });
            } else if (pos.isLive) {
                pos.status = 'PENDING_RESOLUTION';
                pos.pendingSince = pos.pendingSince || Date.now();
                pos.pendingSlug = pos.pendingSlug || pos.slug || `${pos.asset.toLowerCase()}-updown-${pos.timeframe}-${pos.epoch}`;
                const staleThresholdMs = pos.timeframe === '4h' ? (6 * 60 * 60 * 1000) : (30 * 60 * 1000);
                pos.stalePending = (Date.now() - Number(pos.pendingSince || Date.now())) > staleThresholdMs;
                resolved.push({ id: pos.id, status: pos.status, slug: pos.pendingSlug, stalePending: !!pos.stalePending });
            }
        }

        return resolved;
    }

    getPendingSettlements() {
        return this.positions
            .filter(p => p && p.status === 'PENDING_RESOLUTION')
            .map(p => ({
                id: p.id,
                asset: p.asset,
                timeframe: p.timeframe,
                direction: p.direction,
                size: p.originalSize || p.size,
                slug: p.pendingSlug || p.slug,
                pendingSince: p.pendingSince || null,
                stalePending: !!p.stalePending,
                mode: p.mode
            }));
    }

    async processPendingSells(currentMarkets, maxItems = 2) {
        if (this.mode !== 'LIVE') return { success: true, processed: 0, closed: 0, failed: 0 };

        const pendingEntries = Object.entries(this.pendingSells || {});
        if (pendingEntries.length === 0) return { success: true, processed: 0, closed: 0, failed: 0 };

        let processed = 0;
        let closed = 0;
        let failed = 0;

        for (const [positionId, pending] of pendingEntries.slice(0, Math.max(1, maxItems))) {
            const pos = this._getPosition(positionId);
            if (!pos) {
                delete this.pendingSells[positionId];
                continue;
            }

            const marketKey = `${pos.asset}_${pos.timeframe}`;
            const market = currentMarkets?.[marketKey] || null;
            const exitPrice = Number(pending.exitPrice || pos.sellPendingPrice || (pos.direction === 'UP' ? market?.yesPrice : market?.noPrice) || pos.entryPrice || 0.5);

            processed++;
            const sell = await this.executeSellOrderWithRetry(pos, exitPrice, 2, 2000);
            if (!sell.success) {
                failed++;
                this.pendingSells[positionId] = { ...pending, lastRetryAt: Date.now(), exitPrice };
                continue;
            }

            await this.refreshLiveBalance(true).catch(() => null);
            this._finalizePosition(positionId, Number(sell.avgExitPrice || exitPrice), 'AUTO_PENDING_SELL_RETRY', {
                shares: Number(sell.startShares || pos.originalShares || 0),
                size: Number(pos.originalSize || (Number(sell.startShares || 0) * Number(pos.entryPrice || 0)))
            });
            delete this.pendingSells[positionId];
            closed++;
        }

        return { success: true, processed, closed, failed };
    }

    addToRedemptionQueue(position) {
        if (!position || !position.tokenId) return;
        if (!this.redemptionQueue) this.redemptionQueue = [];
        const exists = this.redemptionQueue.some(item => item.tokenId === position.tokenId && item.conditionId === (position.conditionId || null));
        if (exists) return;

        this.redemptionQueue.push({
            tokenId: position.tokenId,
            asset: position.asset,
            timeframe: position.timeframe,
            side: position.direction,
            addedAt: Date.now(),
            shares: position.originalShares || position.shares || 0,
            conditionId: position.conditionId || null
        });
    }

    getRedemptionQueue() {
        return this.redemptionQueue || [];
    }

    async checkAndRedeemPositions() {
        if (!this.clob?.wallet) {
            return { success: false, error: 'No wallet loaded', events: [] };
        }

        if (!this.redemptionEvents) this.redemptionEvents = [];
        const queue = this.redemptionQueue || [];
        if (queue.length === 0) {
            return { success: true, message: 'No positions to redeem', redeemed: 0, events: [] };
        }

        let redeemed = 0;
        let failed = 0;
        let skipped = 0;
        const events = [];

        for (let i = queue.length - 1; i >= 0; i--) {
            const item = queue[i];
            const eventRecord = {
                tokenId: item.tokenId,
                asset: item.asset,
                side: item.side,
                timestamp: Date.now(),
                outcome: 'PENDING',
                reason: null,
                txHash: null
            };

            try {
                const balance = await this.clob.getTokenBalance(item.tokenId);
                const balanceNum = Number(balance?.balance || 0);
                eventRecord.balance = balanceNum;

                if (balance?.success && balanceNum > 0) {
                    if (item.conditionId) {
                        const redeem = await this.clob.redeemPosition(item.conditionId);
                        if (redeem?.success) {
                            eventRecord.outcome = 'REDEEMED';
                            eventRecord.reason = 'Auto-redeemed successfully';
                            eventRecord.txHash = redeem.txHash || null;
                            queue.splice(i, 1);
                            redeemed++;
                            this._markInternalBalanceEvent();
                            await this.refreshLiveBalance(true).catch(() => null);
                        } else {
                            eventRecord.outcome = 'ERROR';
                            eventRecord.reason = redeem?.error || 'Redeem failed';
                            item.lastAttempt = Date.now();
                            item.attempts = (item.attempts || 0) + 1;
                            failed++;
                        }
                    } else {
                        eventRecord.outcome = 'MANUAL_REQUIRED';
                        eventRecord.reason = 'Missing conditionId for automatic redemption';
                        item.requiresManual = true;
                        skipped++;
                    }
                } else {
                    const ageHours = (Date.now() - Number(item.addedAt || Date.now())) / (1000 * 60 * 60);
                    eventRecord.outcome = 'NO_BALANCE';
                    if (ageHours > 24) {
                        eventRecord.reason = 'Zero balance after 24h - assumed redeemed externally';
                        queue.splice(i, 1);
                        redeemed++;
                    } else {
                        eventRecord.reason = 'Zero balance but recent - keeping in queue for verification';
                        item.lastChecked = Date.now();
                        skipped++;
                    }
                }
            } catch (e) {
                eventRecord.outcome = 'CHECK_ERROR';
                eventRecord.reason = e.message;
                failed++;
            }

            events.push(eventRecord);
            this.redemptionEvents.push(eventRecord);
            if (this.redemptionEvents.length > 100) {
                this.redemptionEvents = this.redemptionEvents.slice(-100);
            }
        }

        this.redemptionQueue = queue;
        return {
            success: true,
            redeemed,
            failed,
            skipped,
            remaining: queue.length,
            events
        };
    }

    exportState() {
        return {
            positions: Array.isArray(this.positions) ? [...this.positions] : [],
            pendingRedemptions: Array.isArray(this.pendingRedemptions) ? [...this.pendingRedemptions] : [],
            pendingSells: { ...(this.pendingSells || {}) },
            pendingBuys: { ...(this.pendingBuys || {}) },
            redemptionQueue: Array.isArray(this.redemptionQueue) ? [...this.redemptionQueue] : [],
            redemptionEvents: Array.isArray(this.redemptionEvents) ? [...this.redemptionEvents] : [],
            recoveryQueue: Array.isArray(this.recoveryQueue) ? [...this.recoveryQueue] : [],
            closedPositions: Array.isArray(this.closedPositions) ? [...this.closedPositions] : [],
            mode: this.mode,
            paperBalance: this.paperBalance,
            startingBalance: this.startingBalance,
            cachedLiveBalance: this.cachedLiveBalance,
            lastGoodBalance: this.lastGoodBalance,
            lastBalanceFetch: this.lastBalanceFetch,
            cachedOnChainBalance: this.cachedOnChainBalance,
            cachedClobCollateralBalance: this.cachedClobCollateralBalance,
            liveBalanceSource: this.liveBalanceSource,
            baselineBankroll: this.baselineBankroll,
            baselineBankrollInitialized: this.baselineBankrollInitialized,
            baselineBankrollSource: this.baselineBankrollSource,
            lastInternalBalanceEventAt: this.lastInternalBalanceEventAt,
            startupTime: this.startupTime
        };
    }

    importState(state = {}) {
        if (!state || typeof state !== 'object') return;
        if (Array.isArray(state.positions)) this.positions = [...state.positions];
        if (Array.isArray(state.pendingRedemptions)) this.pendingRedemptions = [...state.pendingRedemptions];
        if (state.pendingSells && typeof state.pendingSells === 'object') this.pendingSells = { ...state.pendingSells };
        if (state.pendingBuys && typeof state.pendingBuys === 'object') this.pendingBuys = { ...state.pendingBuys };
        if (Array.isArray(state.redemptionQueue)) this.redemptionQueue = [...state.redemptionQueue];
        if (Array.isArray(state.redemptionEvents)) this.redemptionEvents = [...state.redemptionEvents].slice(-100);
        if (Array.isArray(state.recoveryQueue)) this.recoveryQueue = [...state.recoveryQueue];
        if (Array.isArray(state.closedPositions)) this.closedPositions = [...state.closedPositions].slice(-500);
        if (typeof state.mode === 'string') this.mode = state.mode;
        if (Number.isFinite(Number(state.paperBalance))) this.paperBalance = Number(state.paperBalance);
        if (Number.isFinite(Number(state.startingBalance))) this.startingBalance = Number(state.startingBalance);
        if (Number.isFinite(Number(state.cachedLiveBalance))) this.cachedLiveBalance = Number(state.cachedLiveBalance);
        if (Number.isFinite(Number(state.lastGoodBalance))) this.lastGoodBalance = Number(state.lastGoodBalance);
        if (Number.isFinite(Number(state.lastBalanceFetch))) this.lastBalanceFetch = Number(state.lastBalanceFetch);
        if (Number.isFinite(Number(state.cachedOnChainBalance))) this.cachedOnChainBalance = Number(state.cachedOnChainBalance);
        if (Number.isFinite(Number(state.cachedClobCollateralBalance))) this.cachedClobCollateralBalance = Number(state.cachedClobCollateralBalance);
        if (typeof state.liveBalanceSource === 'string') this.liveBalanceSource = state.liveBalanceSource;
        if (Number.isFinite(Number(state.baselineBankroll))) this.baselineBankroll = Number(state.baselineBankroll);
        if (typeof state.baselineBankrollInitialized === 'boolean') this.baselineBankrollInitialized = state.baselineBankrollInitialized;
        if (typeof state.baselineBankrollSource === 'string') this.baselineBankrollSource = state.baselineBankrollSource;
        if (Number.isFinite(Number(state.lastInternalBalanceEventAt))) this.lastInternalBalanceEventAt = Number(state.lastInternalBalanceEventAt);
        if (Number.isFinite(Number(state.startupTime))) this.startupTime = Number(state.startupTime);
    }

    getOpenPositions() {
        return this.positions.filter(p => ['OPEN', 'PENDING_RESOLUTION', 'SELL_PENDING'].includes(p.status));
    }

    getRecentTrades(limit = 20) {
        return this.positions.slice(-limit);
    }

    getStatus() {
        const open = this.getOpenPositions();
        const closed = this.positions.filter(p => ['WON', 'LOST', 'CLOSED'].includes(p.status));
        const wins = closed.filter(p => Number(p.pnl) >= 0);
        const losses = closed.filter(p => Number(p.pnl) < 0);
        return {
            mode: this.mode,
            openPositions: open.length,
            totalTrades: this.positions.length,
            wins: wins.length,
            losses: losses.length,
            winRate: (wins.length + losses.length) > 0
                ? (wins.length / (wins.length + losses.length) * 100).toFixed(1)
                : 'N/A',
            paperBalance: this.mode === 'PAPER' ? this.paperBalance : null,
            liveBalance: this.mode === 'LIVE' ? this.cachedLiveBalance : null,
            liveBalanceSource: this.liveBalanceSource,
            lastBalanceFetch: this.lastBalanceFetch || null,
            balanceBreakdown: this.getCachedBalanceBreakdown(),
            baselineBankroll: this.baselineBankroll,
            baselineBankrollInitialized: this.baselineBankrollInitialized,
            baselineBankrollSource: this.baselineBankrollSource,
            pendingSells: Object.values(this.pendingSells || {}),
            pendingBuys: Object.values(this.pendingBuys || {}),
            pendingSettlements: this.getPendingSettlements(),
            redemptionQueue: this.getRedemptionQueue(),
            positions: open.map(p => ({
                id: p.id,
                asset: p.asset,
                timeframe: p.timeframe,
                direction: p.direction,
                entryPrice: p.entryPrice,
                size: p.originalSize || p.size,
                strategy: p.strategy,
                openedAt: p.openedAt,
                status: p.status,
                pendingSince: p.pendingSince || null,
                stalePending: !!p.stalePending
            }))
        };
    }
}

module.exports = TradeExecutor;
