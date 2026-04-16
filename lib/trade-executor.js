const https = require('https');
const crypto = require('crypto');
const CONFIG = require('./config');
const PolymarketCLOB = require('./clob-client');
const { fetchCLOBBook } = require('./market-discovery');

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
        this._liveReservedCapital = 0;
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

    _getPendingBuyReservedCapital() {
        return Object.values(this.pendingBuys || {}).reduce((sum, pendingBuy) => {
            const reservedCost = Number(pendingBuy?.reservedCost);
            if (Number.isFinite(reservedCost) && reservedCost > 0) {
                return sum + reservedCost;
            }

            const requestedShares = Number(pendingBuy?.requestedShares || 0);
            const recordedMatchedShares = Number(pendingBuy?.recordedMatchedShares || 0);
            const remainingSharesRaw = Number(pendingBuy?.remainingShares);
            const remainingShares = Number.isFinite(remainingSharesRaw)
                ? Math.max(0, remainingSharesRaw)
                : Math.max(0, requestedShares - Math.max(0, recordedMatchedShares));
            const orderPrice = Number(pendingBuy?.orderPrice ?? pendingBuy?.entryPrice ?? pendingBuy?.entry);
            return sum + ((remainingShares > 0 && Number.isFinite(orderPrice) && orderPrice > 0)
                ? (remainingShares * orderPrice)
                : 0);
        }, 0);
    }

    _isLastKnownGoodBalanceStale(maxAgeMs = 120000) {
        if (this.mode !== 'LIVE') return false;
        if (String(this.liveBalanceSource || '') !== 'LAST_KNOWN_GOOD') return false;
        const lastFetch = Number(this.lastBalanceFetch || 0);
        if (!(lastFetch > 0)) return true;
        return (Date.now() - lastFetch) > maxAgeMs;
    }

    getAvailableCash() {
        if (this.mode === 'LIVE') {
            if (this._isLastKnownGoodBalanceStale()) return 0;
            const raw = Math.max(0, Number(this.cachedLiveBalance || this.lastGoodBalance || this.risk?.bankroll || 0));
            return Math.max(0, raw - (this._liveReservedCapital || 0) - this._getPendingBuyReservedCapital());
        }
        return Math.max(0, Number(this.paperBalance || this.risk?.bankroll || 0));
    }

    getTotalOpenExposure() {
        const openExposure = this.getOpenPositions().reduce((sum, position) => {
            const remainingSize = Number(position?.size);
            const originalSize = Number(position?.originalSize);
            const exposure = Number.isFinite(remainingSize) && remainingSize > 0
                ? remainingSize
                : (Number.isFinite(originalSize) ? originalSize : 0);
            return sum + Math.max(0, exposure);
        }, 0);
        return openExposure + this._getPendingBuyReservedCapital();
    }

    getRiskBankrollEstimate() {
        return this.getAvailableCash() + this.getTotalOpenExposure();
    }

    _buildRiskContext() {
        const availableCash = this.getAvailableCash();
        const openExposureUsd = this.getTotalOpenExposure();
        return {
            availableCash,
            openExposureUsd,
            bankrollEstimate: availableCash + openExposureUsd
        };
    }

    _resolveEvWinRate(candidate) {
        const options = [
            candidate?.strategy?.evWinEstimate,
            candidate?.evWinEstimate,
            candidate?.strategy?.pWinEstimate,
            candidate?.pWinEstimate,
            candidate?.strategy?.winRate,
            candidate?.strategy?.winRateLCB
        ];
        for (const value of options) {
            const parsed = Number(value);
            if (Number.isFinite(parsed) && parsed > 0 && parsed < 1) return parsed;
        }
        return null;
    }

    _estimateNetEdgeRoi(entryPrice, pWinEstimate) {
        const entry = Number(entryPrice);
        const pWin = Number(pWinEstimate);
        if (!(entry > 0) || entry >= 1 || !(pWin > 0) || pWin >= 1) return null;
        const effectiveEntry = Math.min(0.99, entry * (1 + Number(CONFIG?.RISK?.slippagePct || 0)));
        if (!(effectiveEntry > 0) || effectiveEntry >= 1) return null;
        const winProfitPerDollar = ((1 - effectiveEntry) * (1 - Number(CONFIG?.RISK?.takerFeePct || 0))) / effectiveEntry;
        return (pWin * winProfitPerDollar) - (1 - pWin);
    }

    _resolveLiveExitPrice(position, market, fallbackPrice = null) {
        const sideBid = position?.direction === 'UP'
            ? Number(market?.yesBestBid)
            : Number(market?.noBestBid);
        if (Number.isFinite(sideBid) && sideBid > 0 && sideBid < 1) return sideBid;

        const sideFallback = position?.direction === 'UP'
            ? Number(market?.yesPrice)
            : Number(market?.noPrice);
        if (Number.isFinite(sideFallback) && sideFallback > 0 && sideFallback < 1) return sideFallback;

        const explicitFallback = Number(fallbackPrice);
        if (Number.isFinite(explicitFallback) && explicitFallback > 0 && explicitFallback < 1) return explicitFallback;

        const entryPrice = Number(position?.entryPrice);
        if (Number.isFinite(entryPrice) && entryPrice > 0 && entryPrice < 1) return entryPrice;
        return 0.5;
    }

    findOpenPositionByOrderId(orderID) {
        if (!orderID) return null;
        const position = this.positions.find(pos => pos?.orderID === orderID && ['OPEN', 'PENDING_RESOLUTION', 'SELL_PENDING'].includes(pos.status));
        if (!position) return null;
        return { positionId: position.id, position };
    }

    findPendingBuyByPositionId(positionId) {
        if (!positionId) return null;
        for (const [key, pendingBuy] of Object.entries(this.pendingBuys || {})) {
            if (pendingBuy?.positionId === positionId) {
                return { key, pendingBuy };
            }
        }
        return null;
    }

    _hydratePositionFromPendingBuy(position, pendingBuy) {
        if (!position || !pendingBuy) return position || null;
        if (!position.tokenType && pendingBuy.tokenType) position.tokenType = pendingBuy.tokenType;
        if (!position.tokenId && pendingBuy.tokenId) position.tokenId = pendingBuy.tokenId;
        if (!position.slug && pendingBuy.slug) position.slug = pendingBuy.slug;
        if (!position.epoch && pendingBuy.epoch) position.epoch = pendingBuy.epoch;
        if (!position.strategy && pendingBuy.strategy) position.strategy = pendingBuy.strategy;
        if (!position.conditionId && pendingBuy.conditionId) position.conditionId = pendingBuy.conditionId;
        if (!position.marketUrl && pendingBuy.marketUrl) position.marketUrl = pendingBuy.marketUrl;
        if (!position.entrySource && pendingBuy.entrySource) position.entrySource = pendingBuy.entrySource;
        if (!Number.isFinite(Number(position.evWinRate)) && Number.isFinite(Number(pendingBuy.evWinRate))) {
            position.evWinRate = Number(pendingBuy.evWinRate);
        }
        if (!Number.isFinite(Number(position.netEdgeRoi)) && Number.isFinite(Number(pendingBuy.netEdgeRoi))) {
            position.netEdgeRoi = Number(pendingBuy.netEdgeRoi);
        }
        if (!position.orderBook && pendingBuy.orderBook) position.orderBook = pendingBuy.orderBook;
        if (!position.orderID && pendingBuy.orderID) position.orderID = pendingBuy.orderID;
        if (!position.funderAddress && pendingBuy.funderAddress) position.funderAddress = pendingBuy.funderAddress;
        if (!Number.isFinite(Number(position.signatureType)) && Number.isFinite(Number(pendingBuy.signatureType))) {
            position.signatureType = Number(pendingBuy.signatureType);
        }
        if (!Number.isFinite(Number(position.requestedShares)) && Number.isFinite(Number(pendingBuy.requestedShares))) {
            position.requestedShares = Number(pendingBuy.requestedShares);
        }
        if (!position.openedAt && pendingBuy.openedAt) position.openedAt = pendingBuy.openedAt;
        return position;
    }

    _countActiveLivePositions() {
        return this.positions.filter(p => p.isLive && ['OPEN', 'PENDING_RESOLUTION', 'SELL_PENDING'].includes(p.status)).length;
    }

    _markInternalBalanceEvent() {
        this.lastInternalBalanceEventAt = Date.now();
    }

    _upsertPendingBuy(pendingBuyKey, pendingBuy) {
        if (!pendingBuyKey || !pendingBuy) return null;
        const requestedSharesRaw = Number(pendingBuy?.requestedShares || 0);
        const requestedShares = Number.isFinite(requestedSharesRaw) ? Math.max(0, requestedSharesRaw) : 0;
        const recordedMatchedSharesRaw = Number(pendingBuy?.recordedMatchedShares || 0);
        const recordedMatchedShares = Number.isFinite(recordedMatchedSharesRaw) ? Math.max(0, recordedMatchedSharesRaw) : 0;
        const remainingSharesRaw = Number(pendingBuy?.remainingShares);
        const remainingShares = Number.isFinite(remainingSharesRaw)
            ? Math.max(0, remainingSharesRaw)
            : Math.max(0, requestedShares - recordedMatchedShares);
        const orderPrice = Number(pendingBuy?.orderPrice ?? pendingBuy?.entryPrice ?? pendingBuy?.entry);
        const reservedCostRaw = Number(pendingBuy?.reservedCost);
        const reservedCost = Number.isFinite(reservedCostRaw) && reservedCostRaw > 0
            ? reservedCostRaw
            : ((remainingShares > 0 && Number.isFinite(orderPrice) && orderPrice > 0)
                ? (remainingShares * orderPrice)
                : 0);
        const nextPendingBuy = {
            ...(this.pendingBuys[pendingBuyKey] || {}),
            ...pendingBuy,
            requestedShares,
            recordedMatchedShares,
            remainingShares,
            reservedCost,
            lastUpdatedAt: new Date().toISOString()
        };
        this.pendingBuys[pendingBuyKey] = nextPendingBuy;
        this._markInternalBalanceEvent();
        return nextPendingBuy;
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
        const stale = source === 'LAST_KNOWN_GOOD' && this._isLastKnownGoodBalanceStale();
        return {
            onChainUsdc,
            clobCollateralUsdc,
            tradingBalanceUsdc,
            source,
            sourceLabel,
            stale,
            usableForTrading: !stale,
            updatedAt,
            updatedIso: updatedAt ? new Date(updatedAt).toISOString() : null
        };
    }

    getCachedBalanceBreakdown() {
        const cachedSource = String(this.liveBalanceSource || '').trim();
        if (cachedSource === 'ON_CHAIN_USDC') {
            return this.buildLiveBalanceBreakdown({ success: true, balance: this.cachedOnChainBalance }, null);
        }
        if (cachedSource === 'CLOB_COLLATERAL_FALLBACK') {
            return this.buildLiveBalanceBreakdown(null, { success: true, balance: this.cachedClobCollateralBalance });
        }
        if (cachedSource === 'ZERO_CONFIRMED') {
            return this.buildLiveBalanceBreakdown(
                { success: true, balance: 0 },
                { success: true, balance: 0 }
            );
        }
        return this.buildLiveBalanceBreakdown(null, null);
    }

    async refreshLiveBalance(force = false) {
        if (!this.clob?.wallet) return null;

        const cacheValid = !force && (Date.now() - this.lastBalanceFetch < 30000) && this.cachedLiveBalance > 0;
        if (cacheValid) return this.getCachedBalanceBreakdown();

        const lastGoodBalance = Number(this.cachedLiveBalance || this.lastGoodBalance || 0);
        const previousBalance = Number(this.cachedLiveBalance || this.lastGoodBalance || 0);

        try {
            const proxyFunder = this.clob?.getStatus?.()?.tradeReady?.selected?.funderAddress || null;
            const [usdcResult, clobResult, proxyOnChain] = await Promise.all([
                this.clob.getOnChainUsdcBalance(),
                this.clob.getClobCollateralBalance(),
                proxyFunder && proxyFunder !== this.clob?.wallet?.address
                    ? this.clob.getOnChainUsdcBalance(proxyFunder).catch(() => null)
                    : Promise.resolve(null)
            ]);

            // Use the better of EOA or proxy on-chain balance
            const effectiveUsdc = (proxyOnChain?.success && proxyOnChain.balance > 0 && proxyOnChain.balance > (usdcResult?.balance || 0))
                ? proxyOnChain : usdcResult;

            if (effectiveUsdc?.success && effectiveUsdc.balance !== undefined) {
                this.cachedOnChainBalance = Math.max(0, Number(effectiveUsdc.balance) || 0);
            }
            if (clobResult?.success && clobResult.balance !== undefined) {
                this.cachedClobCollateralBalance = Math.max(0, Number(clobResult.balance) || 0);
            }

            const breakdown = this.buildLiveBalanceBreakdown(effectiveUsdc, clobResult);
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
                this._liveReservedCapital = 0;

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
        const marketMinOrderSharesRaw = direction === 'UP' ? market?.yesMinOrderSize : market?.noMinOrderSize;
        const marketMinOrderShares = Number.isFinite(Number(marketMinOrderSharesRaw)) && Number(marketMinOrderSharesRaw) > 0
            ? Math.ceil(Number(marketMinOrderSharesRaw))
            : CONFIG.RISK.minOrderShares;
        let effectiveMinOrderShares = Math.max(CONFIG.RISK.minOrderShares, marketMinOrderShares);
        const tokenType = direction === 'UP' ? 'YES' : 'NO';
        const tokenId = direction === 'UP' ? market.yesTokenId : market.noTokenId;
        if (!tokenId) {
            return { success: false, error: 'NO_TOKEN_ID', blocked: true };
        }

        if (this.mode === 'LIVE') {
            await this.refreshLiveBalance().catch(() => null);
        }

        // Spread sanity check: skip if pricing looks stale/illiquid
        const yp = Number(market.yesPrice || 0);
        const np = Number(market.noPrice || 0);
        if (yp > 0 && np > 0 && Math.abs(yp + np - 1) > 0.08) {
            return { success: false, error: `SPREAD_TOO_WIDE (yes=${yp.toFixed(3)} no=${np.toFixed(3)} sum=${(yp+np).toFixed(3)})`, blocked: true };
        }

        let liveEntryPrice = Number(entryPrice);
        let entrySource = market?.priceSource || 'DISCOVERY';
        let freshBook = null;

        if (CONFIG?.RISK?.requireRealOrderBook) {
            freshBook = await fetchCLOBBook(tokenId).catch(() => null);
            const askLevels = Array.isArray(freshBook?.raw?.asks) ? freshBook.raw.asks.length : 0;
            const bestAsk = Number(freshBook?.bestAsk);
            const buyPrice = Number(freshBook?.buyPrice);
            const discoveredEntry = Number.isFinite(buyPrice) && buyPrice > 0
                ? buyPrice
                : (Number.isFinite(bestAsk) && bestAsk > 0 ? bestAsk : null);
            if (!(askLevels > 0) || !Number.isFinite(discoveredEntry) || discoveredEntry <= 0 || discoveredEntry >= 1) {
                return { success: false, error: `REQUIRES_REAL_ORDERBOOK (${tokenType})`, blocked: true };
            }
            liveEntryPrice = discoveredEntry;
            const freshMinOrderSize = Number(freshBook?.raw?.min_order_size);
            if (Number.isFinite(freshMinOrderSize) && freshMinOrderSize > 0) {
                effectiveMinOrderShares = Math.max(CONFIG.RISK.minOrderShares, Math.ceil(freshMinOrderSize));
            }
            entrySource = 'LIVE_ORDERBOOK';
        }

        const priceMin = Number(candidate?.strategy?.priceMin ?? candidate?.priceMin);
        const priceMax = Number(candidate?.strategy?.priceMax ?? candidate?.priceMax);
        if ((Number.isFinite(priceMin) && liveEntryPrice < priceMin) || (Number.isFinite(priceMax) && liveEntryPrice > priceMax)) {
            return {
                success: false,
                error: `LIVE_PRICE_OUTSIDE_STRATEGY_BAND (${liveEntryPrice.toFixed(4)} not in ${Number.isFinite(priceMin) ? priceMin.toFixed(4) : '0.0000'}-${Number.isFinite(priceMax) ? priceMax.toFixed(4) : '1.0000'})`,
                blocked: true
            };
        }

        const evWinRate = this._resolveEvWinRate(candidate);
        if (!(Number.isFinite(evWinRate) && evWinRate > 0 && evWinRate < 1)) {
            return { success: false, error: 'NO_EV_ESTIMATE', blocked: true };
        }
        const minNetEdgeRoi = Number(CONFIG?.RISK?.minNetEdgeRoi || 0);
        const enforceNetEdgeGate = !!CONFIG?.RISK?.enforceNetEdgeGate;
        const netEdgeRoi = this._estimateNetEdgeRoi(liveEntryPrice, evWinRate);
        if (enforceNetEdgeGate && (!Number.isFinite(netEdgeRoi) || netEdgeRoi < minNetEdgeRoi)) {
            return {
                success: false,
                error: `NEGATIVE_NET_EDGE (roi=${Number.isFinite(netEdgeRoi) ? netEdgeRoi.toFixed(4) : 'n/a'})`,
                blocked: true
            };
        }

        const bufferCents = Number(CONFIG?.RISK?.entryPriceBufferCents || 0);
        let orderPrice = liveEntryPrice;
        if (bufferCents > 0) {
            const buffered = liveEntryPrice + bufferCents / 100;
            const cap = Math.min(Number.isFinite(priceMax) ? priceMax : 0.99, 0.99);
            const candidateOrder = Math.min(buffered, cap);
            if (!enforceNetEdgeGate) {
                orderPrice = candidateOrder;
            } else {
                const bufferedEdge = this._estimateNetEdgeRoi(candidateOrder, evWinRate);
                if (Number.isFinite(bufferedEdge) && bufferedEdge >= minNetEdgeRoi) {
                    orderPrice = candidateOrder;
                }
            }
        }

        const runtimeCandidate = {
            ...candidate,
            epoch: market.epoch,
            entryPrice: liveEntryPrice,
            orderPrice,
            minOrderShares: effectiveMinOrderShares,
            evWinRate,
            netEdgeRoi,
            entrySource,
            orderBook: freshBook ? {
                bestBid: Number.isFinite(Number(freshBook.bestBid)) ? Number(freshBook.bestBid) : null,
                bestAsk: Number.isFinite(Number(freshBook.bestAsk)) ? Number(freshBook.bestAsk) : null,
                buyPrice: Number.isFinite(Number(freshBook.buyPrice)) ? Number(freshBook.buyPrice) : null,
                minOrderSize: Number.isFinite(Number(freshBook?.raw?.min_order_size)) ? Math.ceil(Number(freshBook.raw.min_order_size)) : null
            } : null
        };
        const riskContext = this._buildRiskContext();

        // Duplicate position guard: never open same asset+direction in same cycle
        const dupKey = `${asset}_${timeframe}_${market.epoch}_${direction}`;
        const hasDuplicate = this.positions.some(p =>
            p.asset === asset && p.timeframe === timeframe && p.direction === direction &&
            String(p.epoch) === String(market.epoch) && (p.status === 'OPEN' || p.status === 'PENDING' || p.status === 'PENDING_RESOLUTION' || p.status === 'SELL_PENDING')
        );
        const hasPendingBuyDup = Object.values(this.pendingBuys || {}).some(pb =>
            pb?.asset === asset && pb?.timeframe === timeframe && pb?.direction === direction &&
            String(pb?.epoch) === String(market.epoch)
        );
        if (hasDuplicate || hasPendingBuyDup) {
            return { success: false, error: `DUPLICATE_POSITION (${dupKey})`, blocked: true };
        }

        // Check risk gates
        const riskCheck = this.risk.canTrade(runtimeCandidate, riskContext);
        if (!riskCheck.allowed) {
            return { success: false, error: riskCheck.reasons.join(', '), blocked: true };
        }

        // Calculate position size
        const sizing = this.risk.calculateSize(runtimeCandidate, riskContext);
        if (sizing.blocked) {
            return { success: false, error: sizing.reason, blocked: true };
        }

        const size = sizing.size;
        if (size <= 0) {
            return { success: false, error: 'SIZE_ZERO', blocked: true };
        }

        const shares = Math.floor(size / orderPrice + 1e-9);
        if (shares < effectiveMinOrderShares) {
            return { success: false, error: `SHARES_BELOW_MIN (${shares} < ${effectiveMinOrderShares})`, blocked: true };
        }

        const positionId = `${asset}_${timeframe}_${market.epoch}_${Date.now()}`;

        console.log(`\n🎯 ═══════════════════════════════════════`);
        console.log(`🎯 ${this.mode} TRADE ENTRY — ${timeframe.toUpperCase()}`);
        console.log(`🎯 Asset: ${asset} | Direction: ${direction} (${tokenType})`);
        console.log(`🎯 Entry: ${(liveEntryPrice * 100).toFixed(1)}¢ | Limit: ${(orderPrice * 100).toFixed(1)}¢ | Shares: ${shares} | MinShares: ${effectiveMinOrderShares} | Size: $${size.toFixed(2)}`);
        console.log(`🎯 Strategy: ${name} | pWin(lcb): ${(pWinEstimate * 100).toFixed(1)}% | pWin(ev): ${(evWinRate * 100).toFixed(1)}% | netEdge=${(netEdgeRoi * 100).toFixed(2)}%`);
        console.log(`🎯 ═══════════════════════════════════════\n`);

        if (this.mode === 'PAPER') {
            return this._executePaperTrade(positionId, runtimeCandidate, market, size, shares, tokenId);
        } else {
            return this._executeLiveTrade(positionId, runtimeCandidate, market, size, shares, tokenId);
        }
    }

    _executePaperTrade(positionId, candidate, market, size, shares, tokenId) {
        const { asset, timeframe, direction, entryPrice, name } = candidate;
        const signalEntryPrice = entryPrice;
        const orderPrice = Number(candidate.orderPrice || entryPrice);

        const position = {
            id: positionId,
            asset,
            timeframe,
            direction,
            entryPrice: orderPrice,
            signalEntryPrice,
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
            entrySource: candidate.entrySource || market.priceSource || 'DISCOVERY',
            evWinRate: Number.isFinite(Number(candidate.evWinRate)) ? Number(candidate.evWinRate) : null,
            netEdgeRoi: Number.isFinite(Number(candidate.netEdgeRoi)) ? Number(candidate.netEdgeRoi) : null,
            orderBook: candidate.orderBook || null,
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
            entryPrice: orderPrice,
            signalEntryPrice,
            direction,
            asset,
            timeframe: candidate.timeframe,
            mode: 'PAPER'
        };
    }

    async _executeLiveTrade(positionId, candidate, market, size, shares, tokenId) {
        const { asset, timeframe, direction, entryPrice, name } = candidate;
        const signalEntryPrice = entryPrice;
        const orderPrice = candidate.orderPrice || entryPrice;

        if (!CONFIG.IS_LIVE) {
            return { success: false, error: 'LIVE_TRADING_NOT_ENABLED', blocked: true };
        }

        try {
            if (orderPrice !== entryPrice) {
                console.log(`📈 Limit buffer: discovery=${(entryPrice*100).toFixed(1)}¢ → order=${(orderPrice*100).toFixed(1)}¢ (+${((orderPrice-entryPrice)*100).toFixed(1)}¢)`);
            }
            // Place order via CLOB API with buffered limit price
            const order = await this._placeCLOBOrder(tokenId, orderPrice, shares, 'BUY');

            if (!order || order.error) {
                if (order?.orderID && order.error === 'NO_FILL_AFTER_RETRIES') {
                    const requestedShares = Number(order.requestedShares || shares);
                    const recordedMatchedShares = Number(order.matchedShares || 0);
                    const remainingShares = Math.max(0, Number(order.remainingShares || (requestedShares - recordedMatchedShares)));
                    if (remainingShares > 0) {
                        const pendingBuyKey = `${asset}_${tokenId}_${order.orderID}`;
                        this.risk.registerTradeOpen(candidate.timeframe, market.epoch);
                        this._upsertPendingBuy(pendingBuyKey, {
                            positionId,
                            asset,
                            timeframe,
                            direction,
                            tokenType: direction === 'UP' ? 'YES' : 'NO',
                            entryPrice,
                            orderPrice,
                            requestedSize: size,
                            requestedShares,
                            recordedMatchedShares,
                            remainingShares,
                            reservedCost: remainingShares * orderPrice,
                            countedAgainstCycle: true,
                            orderID: order.orderID,
                            tokenId,
                            slug: market.slug || null,
                            conditionId: market.conditionId || null,
                            marketUrl: market.slug ? `https://polymarket.com/event/${market.slug}` : null,
                            epoch: market.epoch,
                            strategy: name,
                            entrySource: candidate.entrySource || market.priceSource || 'DISCOVERY',
                            evWinRate: Number.isFinite(Number(candidate.evWinRate)) ? Number(candidate.evWinRate) : null,
                            netEdgeRoi: Number.isFinite(Number(candidate.netEdgeRoi)) ? Number(candidate.netEdgeRoi) : null,
                            orderBook: candidate.orderBook || null,
                            funderAddress: order.funderAddress || null,
                            signatureType: Number.isFinite(Number(order.signatureType)) ? Number(order.signatureType) : null,
                            openedAt: new Date().toISOString(),
                            partialFill: !!order.partialFill,
                            fillStatus: order.status || order.fillStatus || null,
                            cancelAttempted: !!order.cancelAttempted,
                            cancelSucceeded: !!order.cancelSucceeded
                        });
                    }
                }
                console.log(`❌ CLOB ORDER FAILED: ${order?.error || 'unknown'}`);
                return { success: false, error: `CLOB_ORDER_FAILED: ${order?.error || 'unknown'}` };
            }

            const matchedShares = Number(order.matchedShares || 0);
            const actualShares = matchedShares > 0 ? matchedShares : shares;
            const actualSize = Number(order.matchedSize || (actualShares * orderPrice));

            const position = {
                id: positionId,
                asset,
                timeframe,
                direction,
                entryPrice: orderPrice,
                signalEntryPrice,
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
                entrySource: candidate.entrySource || market.priceSource || 'DISCOVERY',
                evWinRate: Number.isFinite(Number(candidate.evWinRate)) ? Number(candidate.evWinRate) : null,
                netEdgeRoi: Number.isFinite(Number(candidate.netEdgeRoi)) ? Number(candidate.netEdgeRoi) : null,
                orderBook: candidate.orderBook || null,
                orderID: order.orderID,
                funderAddress: order.funderAddress || null,
                signatureType: Number.isFinite(Number(order.signatureType)) ? Number(order.signatureType) : null,
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
            if (Number(order.remainingShares || 0) > 0) {
                const pendingBuyKey = `${asset}_${tokenId}_${order.orderID}`;
                this._upsertPendingBuy(pendingBuyKey, {
                    positionId,
                    asset,
                    timeframe,
                    direction,
                    tokenType: direction === 'UP' ? 'YES' : 'NO',
                    entryPrice,
                    orderPrice,
                    requestedSize: size,
                    requestedShares: Number(order.requestedShares || shares),
                    recordedMatchedShares: actualShares,
                    remainingShares: Math.max(0, Number(order.remainingShares || 0)),
                    reservedCost: Math.max(0, Number(order.remainingShares || 0)) * orderPrice,
                    countedAgainstCycle: true,
                    orderID: order.orderID,
                    tokenId,
                    slug: market.slug || null,
                    conditionId: market.conditionId || null,
                    marketUrl: market.slug ? `https://polymarket.com/event/${market.slug}` : null,
                    epoch: market.epoch,
                    strategy: name,
                    entrySource: candidate.entrySource || market.priceSource || 'DISCOVERY',
                    evWinRate: Number.isFinite(Number(candidate.evWinRate)) ? Number(candidate.evWinRate) : null,
                    netEdgeRoi: Number.isFinite(Number(candidate.netEdgeRoi)) ? Number(candidate.netEdgeRoi) : null,
                    orderBook: candidate.orderBook || null,
                    funderAddress: order.funderAddress || null,
                    signatureType: Number.isFinite(Number(order.signatureType)) ? Number(order.signatureType) : null,
                    openedAt: new Date().toISOString(),
                    partialFill: true,
                    fillStatus: order.status || order.fillStatus || null,
                    cancelAttempted: !!order.cancelAttempted,
                    cancelSucceeded: !!order.cancelSucceeded
                });
            }
            this._liveReservedCapital = (this._liveReservedCapital || 0) + actualSize;
            this._markInternalBalanceEvent();
            await this.refreshLiveBalance(true).catch(() => null);

            console.log(`✅ LIVE TRADE OPENED: ${positionId} | Order: ${order.orderID}`);

            return {
                success: true,
                positionId,
                orderID: order.orderID,
                size: actualSize,
                shares: actualShares,
                entryPrice: orderPrice,
                signalEntryPrice,
                direction,
                asset,
                timeframe: candidate.timeframe,
                mode: 'LIVE',
                funderAddress: order.funderAddress || null,
                signatureType: Number.isFinite(Number(order.signatureType)) ? Number(order.signatureType) : null,
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
        const signalEntryPrice = Number(pendingBuy.entryPrice || pendingBuy.entry);
        const entryPrice = signalEntryPrice;
        const matchedSharesRaw = Number(actualShares);
        const matchedShares = Number.isFinite(matchedSharesRaw) ? matchedSharesRaw : 0;
        const orderPrice = Number(pendingBuy.orderPrice ?? pendingBuy.entryPrice ?? pendingBuy.entry);
        const effectiveFillPrice = Number.isFinite(orderPrice) && orderPrice > 0 ? orderPrice : entryPrice;
        if (!(matchedShares > 0) || !(entryPrice > 0) || !(effectiveFillPrice > 0)) {
            return { recovered: false, reason: 'NO_VERIFIED_MATCH' };
        }

        const recoveredAt = new Date().toISOString();
        const recordedMatchedShares = Math.max(0, Number(pendingBuy.recordedMatchedShares || 0));
        if (existing) {
            const deltaShares = matchedShares - recordedMatchedShares;
            this._hydratePositionFromPendingBuy(existing.position, pendingBuy);
            if (!(deltaShares > 1e-6)) {
                this._markInternalBalanceEvent();
                return { recovered: false, reason: 'NO_NEW_MATCH', positionId: existing.positionId };
            }

            const deltaSize = deltaShares * effectiveFillPrice;
            const position = existing.position;
            position.shares = Number(position.shares || 0) + deltaShares;
            position.originalShares = Number(position.originalShares || 0) + deltaShares;
            position.size = Number(position.size || 0) + deltaSize;
            position.originalSize = Number(position.originalSize || 0) + deltaSize;
            position.partialFill = Number.isFinite(Number(pendingBuy.requestedShares))
                ? matchedShares + 1e-6 < Number(pendingBuy.requestedShares)
                : false;
            position.recoveredFromPendingBuy = true;
            position.recoveredAt = recoveredAt;
            position.recoveredOrderStatus = orderStatus?.order?.status || orderStatus?.status || null;
            this._markInternalBalanceEvent();
            return {
                recovered: true,
                updated: true,
                positionId: existing.positionId,
                actualSize: deltaSize,
                actualShares: deltaShares,
                totalMatchedShares: matchedShares
            };
        }

        const actualSize = matchedShares * effectiveFillPrice;
        const positionId = pendingBuy.positionId || pendingBuy.id || `${pendingBuy.asset}_${pendingBuy.timeframe || '15m'}_${Date.now()}`;
        const position = {
            id: positionId,
            asset: pendingBuy.asset,
            timeframe: pendingBuy.timeframe,
            direction: pendingBuy.direction,
            entryPrice: effectiveFillPrice,
            signalEntryPrice,
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
            entrySource: pendingBuy.entrySource || null,
            evWinRate: Number.isFinite(Number(pendingBuy.evWinRate)) ? Number(pendingBuy.evWinRate) : null,
            netEdgeRoi: Number.isFinite(Number(pendingBuy.netEdgeRoi)) ? Number(pendingBuy.netEdgeRoi) : null,
            orderBook: pendingBuy.orderBook || null,
            orderID: pendingBuy.orderID,
            funderAddress: pendingBuy.funderAddress || null,
            signatureType: Number.isFinite(Number(pendingBuy.signatureType)) ? Number(pendingBuy.signatureType) : null,
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
        if (!pendingBuy.countedAgainstCycle) {
            this.risk.registerTradeOpen(position.timeframe, position.epoch);
        }
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
        const eps = 1e-6;

        for (const [key, pendingBuy] of pendingEntries.slice(0, Math.max(1, maxItems))) {
            processed++;
            try {
                const orderStatus = await this.clob.getOrder(pendingBuy.orderID);
                const orderLookupFailed = orderStatus?.success === false;
                const order = orderStatus?.order || {};
                let fillStatus = String(order?.status || pendingBuy?.lastKnownStatus || pendingBuy?.fillStatus || 'UNKNOWN').toUpperCase();
                const matchedSharesRaw = Number(order?.size_matched || 0);
                const matchedShares = Number.isFinite(matchedSharesRaw) ? matchedSharesRaw : 0;
                const fallbackMatchedSharesRaw = Number(pendingBuy?.lastKnownMatchedShares ?? pendingBuy?.recordedMatchedShares ?? 0);
                const fallbackMatchedShares = Number.isFinite(fallbackMatchedSharesRaw) ? Math.max(0, fallbackMatchedSharesRaw) : 0;
                const knownMatchedShares = Math.max(matchedShares, fallbackMatchedShares);
                const existing = this.findOpenPositionByOrderId(pendingBuy?.orderID);
                const recordedMatchedShares = Math.max(0, Number(pendingBuy?.recordedMatchedShares || 0));
                const ageMs = Date.now() - (Number(new Date(pendingBuy.openedAt || pendingBuy.createdAt || Date.now()).getTime()) || Date.now());
                const existingPositionShares = existing
                    ? Math.max(0, Number(existing.position?.originalShares || existing.position?.shares || 0))
                    : 0;
                const representedByExistingPosition = !!existing
                    && knownMatchedShares > eps
                    && existingPositionShares + eps >= knownMatchedShares
                    && (pendingBuy?.cancelSucceeded === true || ['MATCHED', 'FILLED', 'EXECUTED', 'MINED'].includes(fillStatus));
                if (representedByExistingPosition) {
                    this._hydratePositionFromPendingBuy(existing.position, pendingBuy);
                    delete this.pendingBuys[key];
                    this._markInternalBalanceEvent();
                    continue;
                }
                if (orderLookupFailed) {
                    failed++;
                    if (this.pendingBuys[key]) {
                        this._upsertPendingBuy(key, {
                            ...pendingBuy,
                            lastRetryAt: Date.now(),
                            lastRetryError: orderStatus?.error || 'PENDING_BUY_ORDER_LOOKUP_FAILED',
                            lastKnownStatus: fillStatus,
                            lastKnownMatchedShares: knownMatchedShares
                        });
                    }
                    continue;
                }
                if (matchedShares > recordedMatchedShares + eps || (!existing && matchedShares > eps)) {
                    const res = this.recordRecoveredPendingBuy(pendingBuy, matchedShares, orderStatus);
                    if (res?.recovered) {
                        recovered++;
                    }
                }

                const requestedSharesRaw = Number(pendingBuy?.requestedShares);
                const requestedShares = Number.isFinite(requestedSharesRaw) && requestedSharesRaw > 0
                    ? requestedSharesRaw
                    : Math.max(matchedShares, Number(pendingBuy?.remainingShares || 0));
                let remainingShares = Math.max(0, requestedShares - matchedShares);
                const isFinalZeroFill = ['CANCELLED', 'EXPIRED', 'REJECTED', 'UNMATCHED'].includes(fillStatus);
                const isFinalMatched = ['MATCHED', 'FILLED', 'EXECUTED', 'MINED'].includes(fillStatus);
                if (isFinalMatched && matchedShares > eps) {
                    remainingShares = 0;
                }
                const isTooOld = ageMs > (15 * 60 * 1000);
                const orderPrice = Number(pendingBuy?.orderPrice ?? pendingBuy?.entryPrice ?? pendingBuy?.entry);
                const reservedCost = (remainingShares > 0 && Number.isFinite(orderPrice) && orderPrice > 0)
                    ? remainingShares * orderPrice
                    : 0;

                if (remainingShares > eps && !isFinalZeroFill && isTooOld) {
                    const cancelResult = await this.clob.cancelOrder(pendingBuy.orderID).catch((e) => ({
                        success: false,
                        error: e?.message || String(e)
                    }));
                    if (this.pendingBuys[key]) {
                        this._upsertPendingBuy(key, {
                            ...pendingBuy,
                            recordedMatchedShares: matchedShares,
                            remainingShares,
                            reservedCost,
                            lastRetryAt: Date.now(),
                            lastRetryError: cancelResult?.success ? null : (cancelResult?.error || 'PENDING_BUY_CANCEL_FAILED'),
                            lastCancelRequestedAt: Date.now(),
                            fillStatus,
                            cancelAttempted: true,
                            cancelSucceeded: !!cancelResult?.success
                        });
                        continue;
                    }
                }

                if (remainingShares <= eps) {
                    delete this.pendingBuys[key];
                    this._markInternalBalanceEvent();
                    continue;
                }

                if (isFinalZeroFill) {
                    delete this.pendingBuys[key];
                    this._markInternalBalanceEvent();
                    if (!(matchedShares > eps)) failed++;
                } else if (this.pendingBuys[key]) {
                    this._upsertPendingBuy(key, {
                        ...pendingBuy,
                        recordedMatchedShares: matchedShares,
                        remainingShares,
                        reservedCost,
                        lastRetryAt: Date.now(),
                        lastKnownStatus: fillStatus,
                        lastKnownMatchedShares: matchedShares,
                        fillStatus
                    });
                }
            } catch (e) {
                failed++;
                if (this.pendingBuys[key]) {
                    this._upsertPendingBuy(key, {
                        ...pendingBuy,
                        lastRetryAt: Date.now(),
                        lastRetryError: e?.message || String(e)
                    });
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
                remainingShares: result.remainingShares,
                funderAddress: result.funderAddress || null,
                signatureType: Number.isFinite(Number(result.signatureType)) ? Number(result.signatureType) : null,
                partialFill: !!result.partialFill,
                requestedShares: result.requestedShares,
                cancelAttempted: !!result.cancelAttempted,
                cancelSucceeded: !!result.cancelSucceeded
            };
        } else {
            return {
                error: result.error || 'Order failed',
                orderID: result.orderID || null,
                status: result.fillStatus || null,
                matchedShares: result.matchedShares,
                matchedSize: result.matchedSize,
                remainingShares: result.remainingShares,
                funderAddress: result.funderAddress || null,
                signatureType: Number.isFinite(Number(result.signatureType)) ? Number(result.signatureType) : null,
                partialFill: !!result.partialFill,
                requestedShares: result.requestedShares,
                cancelAttempted: !!result.cancelAttempted,
                cancelSucceeded: !!result.cancelSucceeded
            };
        }
    }

    _finalizePosition(positionId, exitPrice, reason, options = {}) {
        const pos = this._getPosition(positionId);
        if (!pos) return null;
        if (['WON', 'LOST', 'CLOSED'].includes(pos.status)) {
            console.warn(`⚠️ _finalizePosition called on already-finalized ${positionId} (${pos.status}) — skipping`);
            return null;
        }

        const remainingShares = Number.isFinite(Number(options.remainingShares))
            ? Number(options.remainingShares)
            : Number(pos.shares || 0);
        const totalShares = Number.isFinite(Number(options.shares))
            ? Number(options.shares)
            : Number(pos.originalShares || pos.shares || 0);
        const size = Number.isFinite(Number(options.size))
            ? Number(options.size)
            : Number(pos.originalSize || pos.size || (totalShares * pos.entryPrice));
        const realizedSellProceeds = Number.isFinite(Number(options.realizedSellProceeds))
            ? Number(options.realizedSellProceeds)
            : Number(pos.soldProceeds || 0);
        const payout = Number.isFinite(Number(options.payout))
            ? Number(options.payout)
            : (realizedSellProceeds + (remainingShares * exitPrice));
        const pnl = payout - size;
        const profitable = pnl >= -1e-9;
        const resolvedWin = exitPrice >= 0.999;

        pos.exitPrice = exitPrice;
        pos.pnl = pnl;
        pos.payout = payout;
        pos.resolvedAt = new Date().toISOString();
        pos.closeReason = reason;
        pos.closedAt = pos.resolvedAt;
        pos.status = resolvedWin ? 'WON' : (exitPrice <= 0.001 ? 'LOST' : 'CLOSED');
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
                won: profitable,
                pnl,
                epoch: pos.epoch
            }, { creditBalance: false });
            if (resolvedWin && pos.tokenId && remainingShares > 0) {
                this.addToRedemptionQueue({ ...pos, shares: remainingShares });
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
            won: profitable,
            resolvedWin,
            closedAt: pos.closedAt,
            reason
        });
        if (this.closedPositions.length > 500) {
            this.closedPositions.splice(0, this.closedPositions.length - 500);
        }

        const emoji = pnl >= 0 ? '✅' : '❌';
        const outcomeLabel = resolvedWin ? 'WIN' : (profitable ? 'PROFIT EXIT' : 'LOSS');
        console.log(`${emoji} TRADE RESOLVED: ${pos.asset} ${pos.timeframe} ${pos.direction} → ${outcomeLabel} | PnL: $${pnl.toFixed(2)} | Balance: $${this.risk.bankroll.toFixed(2)}`);

        return { positionId, won: profitable, resolvedWin, pnl, payout, bankrollAfter: this.risk.bankroll, exitPrice, reason };
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
                    soldProceeds,
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
                    size: Number(pos.originalSize || (Number(sell.startShares || 0) * Number(pos.entryPrice || 0))),
                    payout: Number.isFinite(Number(sell.soldProceeds)) ? Number(sell.soldProceeds) : undefined,
                    remainingShares: 0
                })
            };
        }

        return { success: true, closed: this._finalizePosition(positionId, exitPrice, reason) };
    }

    resolvePosition(positionId, won) {
        return this._finalizePosition(positionId, won ? 1.0 : 0.0, won ? 'RESOLVED_WIN' : 'RESOLVED_LOSS');
    }

    checkPreResolutionExits(currentMarkets) {
        if (!CONFIG.RISK.preResolutionExitEnabled) return [];
        const nowSec = Math.floor(Date.now() / 1000);
        const exits = [];
        const minBid = Number(CONFIG.RISK.preResolutionMinBid) || 0.85;
        const exitSecondsMap = CONFIG.RISK.preResolutionExitSeconds || {};

        for (const pos of this.positions) {
            if (pos.status !== 'OPEN' || !pos.isLive) continue;
            const tf = CONFIG.TIMEFRAMES.find(t => t.key === pos.timeframe);
            if (!tf) continue;

            const posEndEpoch = pos.epoch + tf.seconds;
            const remaining = posEndEpoch - nowSec;
            const exitWindow = Number(exitSecondsMap[tf.key]) || 120;
            if (remaining > exitWindow || remaining <= 0) continue;

            const marketKey = `${pos.asset}_${pos.timeframe}`;
            const market = currentMarkets?.[marketKey];
            if (!market) continue;

            const exitPrice = this._resolveLiveExitPrice(pos, market);
            if (!Number.isFinite(exitPrice) || exitPrice < minBid) continue;

            console.log(`🔔 PRE-RESOLUTION EXIT: ${pos.asset} ${pos.timeframe} ${pos.direction} bid=${(exitPrice*100).toFixed(1)}¢ remaining=${remaining}s`);
            exits.push({ positionId: pos.id, exitPrice, remaining, asset: pos.asset, timeframe: pos.timeframe, direction: pos.direction });
        }
        return exits;
    }

    check4hEmergencyExit(currentMarkets) {
        const exits = [];
        for (const pos of this.positions) {
            if (pos.status !== 'OPEN' || pos.timeframe !== '4h') continue;
            const marketKey = `${pos.asset}_${pos.timeframe}`;
            const market = currentMarkets?.[marketKey];
            if (!market) continue;
            const currentPrice = this._resolveLiveExitPrice(pos, market);
            if (currentPrice <= 0) continue;
            const drop = pos.entryPrice - currentPrice;
            if (drop >= 0.20) {
                console.log(`🚨 4H EMERGENCY EXIT: ${pos.asset} dropped ${(drop*100).toFixed(1)}¢ (entry=${(pos.entryPrice*100).toFixed(1)}¢ now=${(currentPrice*100).toFixed(1)}¢)`);
                exits.push({ positionId: pos.id, exitPrice: currentPrice, drop });
            }
        }
        return exits;
    }

    checkAndResolveExpiredPositions(currentMarkets) {
        const nowSec = Math.floor(Date.now() / 1000);
        const resolved = [];

        for (const pos of this.positions) {
            if (!['OPEN', 'PENDING_RESOLUTION', 'SELL_PENDING'].includes(pos.status)) continue;

            const tf = CONFIG.TIMEFRAMES.find(t => t.key === pos.timeframe);
            if (!tf) continue;

            const posEndEpoch = pos.epoch + tf.seconds;
            if (nowSec < posEndEpoch) continue;

            // SELL_PENDING after cycle close: market is closed, sells will never fill.
            // Promote to PENDING_RESOLUTION so normal Gamma resolution can finalize it.
            if (pos.status === 'SELL_PENDING') {
                console.warn(`⚠️ SELL_PENDING after cycle close: ${pos.id} — promoting to PENDING_RESOLUTION`);
                delete this.pendingSells[pos.id];
                pos.status = 'PENDING_RESOLUTION';
                pos.sellPending = false;
                pos.pendingSince = pos.pendingSince || Date.now();
                pos.pendingSlug = pos.pendingSlug || pos.slug || `${pos.asset.toLowerCase()}-updown-${pos.timeframe}-${pos.epoch}`;
                resolved.push({ id: pos.id, status: pos.status, slug: pos.pendingSlug, recoveredFromSellPending: true });
                continue;
            }

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
            const exitPrice = this._resolveLiveExitPrice(pos, market, pending.exitPrice || pos.sellPendingPrice);

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
                size: Number(pos.originalSize || (Number(sell.startShares || 0) * Number(pos.entryPrice || 0))),
                payout: Number.isFinite(Number(sell.soldProceeds)) ? Number(sell.soldProceeds) : undefined,
                remainingShares: 0
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
            shares: (Number.isFinite(Number(position.shares)) && Number(position.shares) > 0)
                ? Number(position.shares)
                : (Number(position.originalShares || 0) > 0 ? Number(position.originalShares) : 0),
            conditionId: position.conditionId || null,
            holderAddress: position.funderAddress || position.holderAddress || null,
            signatureType: Number.isFinite(Number(position.signatureType)) ? Number(position.signatureType) : null,
            requiresManual: false,
            lastAttempt: null,
            lastChecked: null,
            lastError: null
        });
    }

    getRedemptionQueue() {
        return this.redemptionQueue || [];
    }

    getRecoveryQueue() {
        return this.recoveryQueue || [];
    }

    markPositionForRecovery(positionId, recovery = {}) {
        const pos = this._getPosition(positionId);
        if (!pos) return null;

        const reason = recovery?.reason || 'MANUAL_RECOVERY_REQUIRED';
        const tokenBalanceRaw = Number(recovery?.tokenBalance);
        const tokenBalance = Number.isFinite(tokenBalanceRaw) ? Math.max(0, tokenBalanceRaw) : null;
        const sharesRaw = Number(pos?.originalShares || pos?.shares || 0);
        const sizeRaw = Number(pos?.originalSize || pos?.size || 0);
        const record = {
            ...(this.getRecoveryQueue().find(item => item?.positionId === positionId) || {}),
            positionId,
            asset: pos.asset,
            timeframe: pos.timeframe,
            direction: pos.direction,
            orderID: pos.orderID || null,
            tokenId: pos.tokenId || null,
            conditionId: pos.conditionId || null,
            slug: pos.pendingSlug || pos.slug || null,
            marketUrl: pos.marketUrl || null,
            size: Number.isFinite(sizeRaw) ? sizeRaw : 0,
            shares: Number.isFinite(sharesRaw) ? sharesRaw : 0,
            pendingSince: pos.pendingSince || null,
            stalePending: !!pos.stalePending,
            holderAddress: recovery?.holderAddress || pos.funderAddress || null,
            tokenBalance,
            zeroVerified: !!recovery?.zeroVerified,
            redeemQueued: !!recovery?.redeemQueued,
            reason,
            lastError: recovery?.lastError || null,
            notes: recovery?.notes || null,
            markedAt: new Date().toISOString()
        };

        const existingIndex = this.getRecoveryQueue().findIndex(item => item?.positionId === positionId);
        if (existingIndex >= 0) {
            this.recoveryQueue[existingIndex] = record;
        } else {
            this.recoveryQueue.push(record);
        }

        for (const [pendingKey, pendingBuy] of Object.entries(this.pendingBuys || {})) {
            if (pendingBuy?.positionId === positionId || (pos.orderID && pendingBuy?.orderID === pos.orderID)) {
                delete this.pendingBuys[pendingKey];
            }
        }

        delete this.pendingSells[positionId];
        pos.status = 'MANUAL_RECOVERY';
        pos.sellPending = false;
        pos.stalePending = false;
        pos.manualRecovery = true;
        pos.manualRecoveryAt = record.markedAt;
        pos.manualRecoveryReason = reason;
        pos.manualRecoveryMeta = {
            holderAddress: record.holderAddress,
            tokenBalance: record.tokenBalance,
            zeroVerified: record.zeroVerified,
            redeemQueued: record.redeemQueued,
            lastError: record.lastError,
            notes: record.notes
        };
        this._markInternalBalanceEvent();
        return record;
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
                const balance = await this.clob.getTokenBalanceAcrossHolders(item.tokenId, item.holderAddress || null);
                const balanceNum = Number(balance?.balance || 0);
                eventRecord.balance = balanceNum;
                eventRecord.holderAddress = balance?.address || item.holderAddress || null;

                if (balance?.success && balanceNum > 0) {
                    item.holderAddress = balance?.address || item.holderAddress || null;
                    if (item.conditionId) {
                        const redeem = await this.clob.redeemPosition(item.conditionId, item.holderAddress || null);
                        if (redeem?.success) {
                            eventRecord.outcome = 'REDEEMED';
                            eventRecord.reason = 'Auto-redeemed successfully';
                            eventRecord.txHash = redeem.txHash || null;
                            queue.splice(i, 1);
                            redeemed++;
                            this._markInternalBalanceEvent();
                            await this.refreshLiveBalance(true).catch(() => null);
                        } else if (redeem?.requiresManual) {
                            eventRecord.outcome = 'MANUAL_REQUIRED';
                            eventRecord.reason = redeem?.error || 'Manual redemption required';
                            item.requiresManual = true;
                            item.lastAttempt = Date.now();
                            item.lastError = eventRecord.reason;
                            skipped++;
                        } else {
                            eventRecord.outcome = 'ERROR';
                            eventRecord.reason = redeem?.error || 'Redeem failed';
                            item.lastAttempt = Date.now();
                            item.attempts = (item.attempts || 0) + 1;
                            item.lastError = eventRecord.reason;
                            failed++;
                        }
                    } else {
                        eventRecord.outcome = 'MANUAL_REQUIRED';
                        eventRecord.reason = 'Missing conditionId for automatic redemption';
                        item.requiresManual = true;
                        item.lastError = eventRecord.reason;
                        skipped++;
                    }
                } else if (balance?.success && !!balance?.zeroVerified) {
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
                } else {
                    eventRecord.outcome = 'CHECK_ERROR';
                    eventRecord.reason = balance?.error || 'Token balance unavailable';
                    item.lastChecked = Date.now();
                    item.lastError = eventRecord.reason;
                    failed++;
                }
            } catch (e) {
                eventRecord.outcome = 'CHECK_ERROR';
                eventRecord.reason = e.message;
                item.lastChecked = Date.now();
                item.lastError = eventRecord.reason;
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
        const recoveryQueue = this.getRecoveryQueue();
        return {
            mode: this.mode,
            openPositions: open.length,
            openExposureUsd: this.getTotalOpenExposure(),
            riskBankrollEstimate: this.getRiskBankrollEstimate(),
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
            recoveryQueue,
            positions: open.map(p => ({
                id: p.id,
                asset: p.asset,
                timeframe: p.timeframe,
                direction: p.direction,
                entryPrice: p.entryPrice,
                signalEntryPrice: Number.isFinite(Number(p.signalEntryPrice)) ? Number(p.signalEntryPrice) : null,
                size: p.originalSize || p.size,
                strategy: p.strategy,
                entrySource: p.entrySource || null,
                netEdgeRoi: Number.isFinite(Number(p.netEdgeRoi)) ? Number(p.netEdgeRoi) : null,
                openedAt: p.openedAt,
                status: p.status,
                pendingSince: p.pendingSince || null,
                stalePending: !!p.stalePending
            }))
        };
    }
}

module.exports = TradeExecutor;
