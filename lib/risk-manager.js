const CONFIG = require('./config');

class RiskManager {
    constructor(startingBalance) {
        this.bankroll = startingBalance || CONFIG.RISK.startingBalance;
        this.dayStartBalance = this.bankroll;
        this.peakBalance = this.bankroll;
        this.todayPnL = 0;
        this.consecutiveLosses = 0;
        this.cooldownUntil = 0;
        this.totalTrades = 0;
        this.totalWins = 0;
        this.totalLosses = 0;
        this.globalTradesThisCycle = {};
        this.tradingPaused = false;
        this.lastDayReset = this._dayKey();
        this.tradeLog = [];
        this.lastRebaseAt = 0;
    }

    _dayKey() {
        return new Date().toISOString().split('T')[0];
    }

    _resetDayIfNeeded() {
        const today = this._dayKey();
        if (today !== this.lastDayReset) {
            this.dayStartBalance = this.bankroll;
            this.todayPnL = 0;
            this.consecutiveLosses = 0;
            this.cooldownUntil = 0;
            this.lastDayReset = today;
            console.log(`🌅 New day: Reset daily stats. Balance: $${this.bankroll.toFixed(2)}`);
        }
    }

    resetCycleCount(cycleKey) {
        this.globalTradesThisCycle[cycleKey] = 0;
    }

    _resolveRiskContext(context = {}) {
        const availableCashRaw = Number.isFinite(Number(context.availableCash))
            ? Number(context.availableCash)
            : this.bankroll;
        const availableCash = Math.max(0, availableCashRaw);
        const openExposureUsdRaw = Number.isFinite(Number(context.openExposureUsd))
            ? Number(context.openExposureUsd)
            : 0;
        const openExposureUsd = Math.max(0, openExposureUsdRaw);
        const bankrollEstimateRaw = Number.isFinite(Number(context.bankrollEstimate))
            ? Number(context.bankrollEstimate)
            : (availableCash + openExposureUsd);
        const bankrollEstimate = Math.max(availableCash, bankrollEstimateRaw);
        const maxTotalExposure = Number(CONFIG?.RISK?.maxTotalExposure);
        const exposureCapEnabled =
            Number.isFinite(maxTotalExposure) &&
            maxTotalExposure > 0 &&
            bankrollEstimate >= Number(CONFIG?.RISK?.maxTotalExposureMinBankroll || 0);
        const maxExposureUsd = exposureCapEnabled
            ? Math.max(0, bankrollEstimate * maxTotalExposure)
            : Infinity;
        const remainingExposureUsd = Number.isFinite(maxExposureUsd)
            ? Math.max(0, maxExposureUsd - openExposureUsd)
            : Infinity;

        return {
            availableCash,
            openExposureUsd,
            bankrollEstimate,
            exposureCapEnabled,
            maxExposureUsd,
            remainingExposureUsd
        };
    }

    getTieredMaxAbsoluteStake(bankroll) {
        const b = Number(bankroll);
        if (!Number.isFinite(b) || b < 1000) {
            return Number(CONFIG?.RISK?.maxAbsoluteStakeSmall || 100);
        }
        if (b < 10000) {
            return Math.max(
                Number(CONFIG?.RISK?.maxAbsoluteStakeSmall || 100),
                Number(CONFIG?.RISK?.maxAbsoluteStakeMedium || 200)
            );
        }
        return Math.max(
            Number(CONFIG?.RISK?.maxAbsoluteStakeSmall || 100),
            Number(CONFIG?.RISK?.maxAbsoluteStakeLarge || 500)
        );
    }

    getDynamicRiskProfile(bankroll) {
        const stage1Threshold = Math.max(0, Number(CONFIG?.RISK?.vaultTriggerBalance || 100));
        const stage2Threshold = Math.max(stage1Threshold, Number(CONFIG?.RISK?.stage2Threshold || 1000));

        if (bankroll < stage1Threshold) {
            return {
                stage: 0,
                stageName: 'BOOTSTRAP',
                intradayLossBudgetPct: 0.50,
                trailingDrawdownPct: 0.40,
                perTradeLossCap: 0.75,
                minOrderRiskOverride: true,
                thresholds: { vaultTriggerBalance: stage1Threshold, stage2Threshold }
            };
        }

        if (bankroll < stage2Threshold) {
            return {
                stage: 1,
                stageName: 'TRANSITION',
                intradayLossBudgetPct: 0.35,
                trailingDrawdownPct: 0.20,
                perTradeLossCap: 0.50,
                minOrderRiskOverride: false,
                thresholds: { vaultTriggerBalance: stage1Threshold, stage2Threshold }
            };
        }

        return {
            stage: 2,
            stageName: 'LOCK_IN',
            intradayLossBudgetPct: 0.25,
            trailingDrawdownPct: 0.10,
            perTradeLossCap: 0.25,
            minOrderRiskOverride: false,
            thresholds: { vaultTriggerBalance: stage1Threshold, stage2Threshold }
        };
    }

    getRiskEnvelopeBudget(candidate = {}, context = {}) {
        const riskContext = this._resolveRiskContext(context);
        const entryPrice = Number(candidate?.entryPrice);
        const candidateMinOrderShares = Number(candidate?.minOrderShares);
        const effectiveMinOrderShares = Number.isFinite(candidateMinOrderShares) && candidateMinOrderShares > 0
            ? Math.max(CONFIG.RISK.minOrderShares, Math.ceil(candidateMinOrderShares))
            : CONFIG.RISK.minOrderShares;
        const minOrderCostUsd = Number.isFinite(entryPrice) && entryPrice > 0
            ? effectiveMinOrderShares * entryPrice
            : null;
        const envelopeEnabled =
            !!CONFIG?.RISK?.riskEnvelopeEnabled &&
            riskContext.bankrollEstimate >= Number(CONFIG?.RISK?.riskEnvelopeMinBankroll || 0);

        if (!envelopeEnabled) {
            return {
                maxTradeSize: Infinity,
                effectiveBudget: Infinity,
                remainingIntradayBudget: Infinity,
                remainingTrailingBudget: Infinity,
                currentBalance: riskContext.bankrollEstimate,
                availableCash: riskContext.availableCash,
                minOrderCostUsd,
                profile: null,
                exposureContext: riskContext,
                reason: 'Risk envelope inactive'
            };
        }

        const currentBalance = riskContext.bankrollEstimate;
        const dayStart = Number.isFinite(Number(context.dayStartBalanceEstimate))
            ? Number(context.dayStartBalanceEstimate)
            : (Number.isFinite(Number(this.dayStartBalance)) ? Number(this.dayStartBalance) : currentBalance);
        const peakBalance = Math.max(
            Number.isFinite(Number(this.peakBalance)) ? Number(this.peakBalance) : currentBalance,
            currentBalance
        );
        const profile = this.getDynamicRiskProfile(currentBalance);
        const maxIntradayLoss = dayStart * profile.intradayLossBudgetPct;
        const usedIntradayLoss = Math.max(0, dayStart - currentBalance);
        const remainingIntradayBudget = Math.max(0, maxIntradayLoss - usedIntradayLoss);
        const maxTrailingLoss = peakBalance * profile.trailingDrawdownPct;
        const usedTrailingLoss = Math.max(0, peakBalance - currentBalance);
        const remainingTrailingBudget = Math.max(0, maxTrailingLoss - usedTrailingLoss);
        const effectiveBudget = Math.min(remainingIntradayBudget, remainingTrailingBudget);
        const rawMaxTradeSize = effectiveBudget * profile.perTradeLossCap;
        const maxTradeSize = Number.isFinite(minOrderCostUsd) && effectiveBudget >= minOrderCostUsd
            ? Math.max(minOrderCostUsd, rawMaxTradeSize)
            : rawMaxTradeSize;

        return {
            maxTradeSize,
            effectiveBudget,
            remainingIntradayBudget,
            remainingTrailingBudget,
            currentBalance,
            availableCash: riskContext.availableCash,
            minOrderCostUsd,
            profile,
            exposureContext: riskContext,
            reason: remainingTrailingBudget < remainingIntradayBudget
                ? `Trailing drawdown budget (${(profile.trailingDrawdownPct * 100).toFixed(0)}% of peak)`
                : `Intraday loss budget (${(profile.intradayLossBudgetPct * 100).toFixed(0)}% of day start)`
        };
    }

    applyRiskEnvelope(proposedSize, candidate = {}, context = {}) {
        const envelope = this.getRiskEnvelopeBudget(candidate, context);
        if (envelope.maxTradeSize === Infinity) {
            return { size: proposedSize, capped: false, blocked: false, envelope, reason: envelope.reason };
        }

        const riskContext = envelope.exposureContext || this._resolveRiskContext(context);
        const minOrderCostUsd = Number(envelope.minOrderCostUsd);
        const floorEnabled = riskContext.availableCash >= CONFIG.RISK.microBankrollThreshold;
        const maxSafeStake = floorEnabled
            ? Math.max(0, riskContext.availableCash - CONFIG.RISK.minBalanceFloor)
            : Infinity;
        const canLose = (loss) => maxSafeStake === Infinity || Number(loss) <= maxSafeStake + 1e-9;

        if (Number.isFinite(minOrderCostUsd) && envelope.effectiveBudget < minOrderCostUsd) {
            if (envelope.profile?.minOrderRiskOverride && riskContext.availableCash >= minOrderCostUsd && canLose(minOrderCostUsd)) {
                return {
                    size: minOrderCostUsd,
                    capped: proposedSize > minOrderCostUsd,
                    blocked: false,
                    envelope,
                    reason: `Bootstrap min-order override (${envelope.profile.stageName})`
                };
            }
            return {
                size: 0,
                capped: false,
                blocked: true,
                envelope,
                reason: `RISK_BUDGET_EXHAUSTED ($${envelope.effectiveBudget.toFixed(2)} < $${minOrderCostUsd.toFixed(2)})`
            };
        }

        if (Number.isFinite(minOrderCostUsd) && envelope.maxTradeSize < minOrderCostUsd) {
            if (envelope.profile?.minOrderRiskOverride && riskContext.availableCash >= minOrderCostUsd && canLose(minOrderCostUsd)) {
                return {
                    size: minOrderCostUsd,
                    capped: proposedSize > minOrderCostUsd,
                    blocked: false,
                    envelope,
                    reason: `Bootstrap min-order override (${envelope.profile.stageName})`
                };
            }
            return {
                size: 0,
                capped: false,
                blocked: true,
                envelope,
                reason: `RISK_CAP_BELOW_MIN_ORDER ($${envelope.maxTradeSize.toFixed(2)} < $${minOrderCostUsd.toFixed(2)})`
            };
        }

        let size = proposedSize;
        let capped = false;
        let reason = envelope.reason;

        if (size > envelope.maxTradeSize) {
            size = envelope.maxTradeSize;
            capped = true;
        }
        if (size > riskContext.availableCash) {
            size = riskContext.availableCash;
            capped = true;
            reason = 'AVAILABLE_CASH_CAP';
        }
        if (Number.isFinite(riskContext.remainingExposureUsd) && size > riskContext.remainingExposureUsd) {
            size = riskContext.remainingExposureUsd;
            capped = true;
            reason = 'EXPOSURE_BUDGET_CAP';
        }
        if (floorEnabled && size > maxSafeStake) {
            size = maxSafeStake;
            capped = true;
            reason = 'SURVIVAL_FLOOR_CAP';
        }
        if (Number.isFinite(minOrderCostUsd) && size + 1e-9 < minOrderCostUsd) {
            return {
                size: 0,
                capped,
                blocked: true,
                envelope,
                reason: `SIZE_BELOW_MIN_ORDER_AFTER_GUARDS ($${Math.max(0, size).toFixed(2)} < $${minOrderCostUsd.toFixed(2)})`
            };
        }

        return {
            size: Math.max(0, size),
            capped,
            blocked: false,
            envelope,
            reason: capped ? reason : 'Within envelope'
        };
    }

    canTrade(candidate, context = {}) {
        this._resetDayIfNeeded();
        const reasons = [];
        const riskContext = this._resolveRiskContext(context);

        // Manual pause
        if (this.tradingPaused) {
            reasons.push('TRADING_PAUSED');
            return { allowed: false, reasons };
        }

        // Cooldown after consecutive losses
        if (Date.now() < this.cooldownUntil) {
            const remaining = Math.ceil((this.cooldownUntil - Date.now()) / 1000);
            reasons.push(`COOLDOWN_${remaining}s`);
            return { allowed: false, reasons };
        }

        // Min balance floor
        if (riskContext.availableCash < CONFIG.RISK.minBalanceFloor) {
            reasons.push(`BELOW_FLOOR ($${riskContext.availableCash.toFixed(2)} < $${CONFIG.RISK.minBalanceFloor.toFixed(2)})`);
            return { allowed: false, reasons };
        }

        if (riskContext.exposureCapEnabled && riskContext.remainingExposureUsd <= 1e-9) {
            reasons.push(`MAX_TOTAL_EXPOSURE ($${riskContext.openExposureUsd.toFixed(2)} / $${riskContext.maxExposureUsd.toFixed(2)})`);
            return { allowed: false, reasons };
        }

        const cycleKey = `${candidate.timeframe}_${candidate.epoch || 'unknown'}`;
        const cycleCount = this.globalTradesThisCycle[cycleKey] || 0;
        const tier = this._getTierProfile(riskContext.bankrollEstimate);
        const maxPerCycle = tier.maxPerCycle;
        if (cycleCount >= maxPerCycle) {
            reasons.push(`MAX_TRADES_CYCLE (${cycleCount}/${maxPerCycle})`);
            return { allowed: false, reasons };
        }

        return { allowed: true, reasons: [] };
    }

    _getTierProfile(bankroll) {
        if (bankroll < 10) return { maxPerCycle: 1, stakeFraction: 0.15, label: 'BOOTSTRAP' };
        if (bankroll < 50) return { maxPerCycle: 2, stakeFraction: 0.15, label: 'GROWTH' };
        if (bankroll < 200) return { maxPerCycle: 2, stakeFraction: 0.12, label: 'ACCELERATE' };
        return { maxPerCycle: 2, stakeFraction: 0.10, label: 'PRESERVE' };
    }

    calculateSize(candidate, context = {}) {
        const riskContext = this._resolveRiskContext(context);
        const bankroll = riskContext.bankrollEstimate;
        const availableCash = riskContext.availableCash;
        const entryPrice = Number(candidate.entryPrice);
        const pWin = candidate.pWinEstimate || 0.5;
        const candidateMinOrderShares = Number(candidate?.minOrderShares);
        const effectiveMinOrderShares = Number.isFinite(candidateMinOrderShares) && candidateMinOrderShares > 0
            ? Math.max(CONFIG.RISK.minOrderShares, Math.ceil(candidateMinOrderShares))
            : CONFIG.RISK.minOrderShares;
        if (!(entryPrice > 0) || entryPrice >= 1 || bankroll <= 0 || availableCash <= 0) {
            return { size: 0, blocked: true, reason: 'INVALID_SIZING_INPUTS' };
        }

        const tier = this._getTierProfile(bankroll);
        let stakeFraction = tier.stakeFraction;

        // Peak drawdown brake
        if (this.peakBalance > CONFIG.RISK.peakDrawdownBrakeMinBankroll) {
            const ddPct = (this.peakBalance - bankroll) / this.peakBalance;
            if (ddPct >= CONFIG.RISK.peakDrawdownBrakePct) {
                stakeFraction = Math.min(stakeFraction, 0.12);
            }
        }

        let size = bankroll * stakeFraction;

        // Kelly sizing — reduce size for lower-edge trades
        if (pWin >= CONFIG.RISK.kellyMinPWin && entryPrice > 0 && entryPrice < 1) {
            const effectiveEntry = Math.min(0.99, entryPrice * (1 + CONFIG.RISK.slippagePct));
            const b = (1 / effectiveEntry) - 1;
            if (b > 0) {
                const fullKelly = (b * pWin - (1 - pWin)) / b;
                if (fullKelly > 0) {
                    const kellySize = bankroll * Math.min(fullKelly * CONFIG.RISK.kellyFraction, CONFIG.RISK.kellyMaxFraction);
                    if (kellySize < size) {
                        size = kellySize;
                    }
                }
            }
        }

        // Cap at stake fraction
        const maxSize = bankroll * stakeFraction;
        if (size > maxSize) size = maxSize;
        size = Math.min(size, this.getTieredMaxAbsoluteStake(bankroll));
        if (Number.isFinite(riskContext.remainingExposureUsd)) {
            size = Math.min(size, riskContext.remainingExposureUsd);
        }
        size = Math.min(size, availableCash);

        // Minimum order enforcement
        const minOrderCost = effectiveMinOrderShares * entryPrice;

        if (size < minOrderCost) {
            const minCashNeeded = availableCash < CONFIG.RISK.microBankrollThreshold
                ? minOrderCost
                : minOrderCost * 1.05;
            const exposureAllowsMinOrder = !riskContext.exposureCapEnabled || riskContext.remainingExposureUsd + 1e-9 >= minOrderCost;
            if (availableCash >= minCashNeeded && exposureAllowsMinOrder) {
                size = minOrderCost;
            } else {
                return { size: 0, blocked: true, reason: `BELOW_MIN_ORDER ($${size.toFixed(2)} < $${minOrderCost.toFixed(2)})` };
            }
        }

        const envelopeResult = this.applyRiskEnvelope(
            size,
            { ...candidate, entryPrice, minOrderShares: effectiveMinOrderShares },
            riskContext
        );
        if (envelopeResult.blocked) {
            return { size: 0, blocked: true, reason: envelopeResult.reason, envelope: envelopeResult.envelope };
        }
        size = envelopeResult.size;
        size = Math.min(size, availableCash);
        if (Number.isFinite(riskContext.remainingExposureUsd)) {
            size = Math.min(size, riskContext.remainingExposureUsd);
        }

        const floorEnabled = availableCash >= CONFIG.RISK.microBankrollThreshold;
        const maxSafeStake = floorEnabled
            ? Math.max(0, availableCash - CONFIG.RISK.minBalanceFloor)
            : Infinity;
        if (floorEnabled && size > maxSafeStake) {
            size = maxSafeStake;
        }
        if (size + 1e-9 < minOrderCost) {
            return { size: 0, blocked: true, reason: `SIZE_BELOW_MIN_AFTER_GUARDS ($${Math.max(0, size).toFixed(2)} < $${minOrderCost.toFixed(2)})` };
        }

        return {
            size: Math.max(0, size),
            blocked: false,
            reason: null,
            envelope: envelopeResult.envelope || null,
            riskContext
        };
    }

    registerTradeOpen(timeframe, epoch) {
        const cycleKey = `${timeframe}_${epoch || 'unknown'}`;
        this.globalTradesThisCycle[cycleKey] = (this.globalTradesThisCycle[cycleKey] || 0) + 1;
    }

    recordTrade(result, options = {}) {
        const { asset, timeframe, direction, entryPrice, size, won, pnl, epoch } = result;
        const creditBalance = options.creditBalance !== false;

        if (creditBalance) {
            this.bankroll += pnl;
        }
        this.todayPnL += pnl;
        this.totalTrades++;

        if (won) {
            this.totalWins++;
            this.consecutiveLosses = 0;
            if (this.bankroll > this.peakBalance) {
                this.peakBalance = this.bankroll;
            }
        } else {
            this.totalLosses++;
            this.consecutiveLosses++;
            if (this.consecutiveLosses >= CONFIG.RISK.maxConsecutiveLosses) {
                this.cooldownUntil = Date.now() + (CONFIG.RISK.cooldownSeconds * 1000);
                console.log(`⏳ Cooldown triggered: ${this.consecutiveLosses} consecutive losses. Resuming in ${CONFIG.RISK.cooldownSeconds}s`);
            }
        }

        this.tradeLog.push({
            ts: new Date().toISOString(),
            asset,
            timeframe,
            direction,
            entryPrice,
            size,
            won,
            pnl,
            bankrollAfter: this.bankroll,
            consecutiveLosses: this.consecutiveLosses
        });

        // Keep log bounded
        if (this.tradeLog.length > 500) this.tradeLog.splice(0, this.tradeLog.length - 500);
    }

    rebaseBalance(balance, options = {}) {
        if (!Number.isFinite(Number(balance))) return;
        const nextBalance = Number(balance);
        this.bankroll = nextBalance;
        if (options.resetDay !== false) {
            this.dayStartBalance = nextBalance;
            this.todayPnL = 0;
            this.cooldownUntil = 0;
            this.consecutiveLosses = 0;
            this.lastDayReset = this._dayKey();
        }
        if (nextBalance > this.peakBalance || options.forcePeak === true) {
            this.peakBalance = nextBalance;
        }
        this.lastRebaseAt = Date.now();
    }

    exportState() {
        return {
            bankroll: this.bankroll,
            dayStartBalance: this.dayStartBalance,
            peakBalance: this.peakBalance,
            todayPnL: this.todayPnL,
            consecutiveLosses: this.consecutiveLosses,
            cooldownUntil: this.cooldownUntil,
            totalTrades: this.totalTrades,
            totalWins: this.totalWins,
            totalLosses: this.totalLosses,
            globalTradesThisCycle: { ...(this.globalTradesThisCycle || {}) },
            tradingPaused: this.tradingPaused,
            lastDayReset: this.lastDayReset,
            tradeLog: Array.isArray(this.tradeLog) ? [...this.tradeLog] : [],
            lastRebaseAt: this.lastRebaseAt || 0
        };
    }

    importState(state = {}) {
        if (!state || typeof state !== 'object') return;
        if (Number.isFinite(Number(state.bankroll))) this.bankroll = Number(state.bankroll);
        if (Number.isFinite(Number(state.dayStartBalance))) this.dayStartBalance = Number(state.dayStartBalance);
        if (Number.isFinite(Number(state.peakBalance))) this.peakBalance = Number(state.peakBalance);
        if (Number.isFinite(Number(state.todayPnL))) this.todayPnL = Number(state.todayPnL);
        if (Number.isFinite(Number(state.consecutiveLosses))) this.consecutiveLosses = Number(state.consecutiveLosses);
        if (Number.isFinite(Number(state.cooldownUntil))) this.cooldownUntil = Number(state.cooldownUntil);
        if (Number.isFinite(Number(state.totalTrades))) this.totalTrades = Number(state.totalTrades);
        if (Number.isFinite(Number(state.totalWins))) this.totalWins = Number(state.totalWins);
        if (Number.isFinite(Number(state.totalLosses))) this.totalLosses = Number(state.totalLosses);
        if (state.globalTradesThisCycle && typeof state.globalTradesThisCycle === 'object') {
            this.globalTradesThisCycle = { ...state.globalTradesThisCycle };
        }
        if (typeof state.tradingPaused === 'boolean') this.tradingPaused = state.tradingPaused;
        if (typeof state.lastDayReset === 'string' && state.lastDayReset) this.lastDayReset = state.lastDayReset;
        if (Array.isArray(state.tradeLog)) this.tradeLog = [...state.tradeLog].slice(-500);
        if (Number.isFinite(Number(state.lastRebaseAt))) this.lastRebaseAt = Number(state.lastRebaseAt);
    }

    getStatus() {
        this._resetDayIfNeeded();
        const wr = this.totalTrades > 0 ? (this.totalWins / this.totalTrades * 100).toFixed(1) : 'N/A';
        return {
            bankroll: this.bankroll,
            dayStartBalance: this.dayStartBalance,
            peakBalance: this.peakBalance,
            todayPnL: this.todayPnL,
            totalTrades: this.totalTrades,
            totalWins: this.totalWins,
            totalLosses: this.totalLosses,
            winRate: wr,
            consecutiveLosses: this.consecutiveLosses,
            inCooldown: Date.now() < this.cooldownUntil,
            cooldownRemaining: Math.max(0, Math.ceil((this.cooldownUntil - Date.now()) / 1000)),
            tradingPaused: this.tradingPaused,
            drawdownFromPeak: this.peakBalance > 0 ? ((this.peakBalance - this.bankroll) / this.peakBalance * 100).toFixed(1) : '0.0',
            lastRebaseAt: this.lastRebaseAt || null,
            recentTrades: this.tradeLog.slice(-20)
        };
    }

    setBankroll(balance) {
        this.bankroll = balance;
        if (balance > this.peakBalance) this.peakBalance = balance;
    }
}

module.exports = RiskManager;
