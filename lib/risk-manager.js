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

    canTrade(candidate) {
        this._resetDayIfNeeded();
        const reasons = [];

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

        // Global stop loss (20% of day-start balance)
        const maxDayLoss = this.dayStartBalance * CONFIG.RISK.globalStopLoss;
        if (this.todayPnL < -maxDayLoss) {
            reasons.push(`GLOBAL_STOP_LOSS (lost $${Math.abs(this.todayPnL).toFixed(2)} / max $${maxDayLoss.toFixed(2)})`);
            return { allowed: false, reasons };
        }

        // Min balance floor
        if (this.bankroll < CONFIG.RISK.minBalanceFloor) {
            reasons.push(`BELOW_FLOOR ($${this.bankroll.toFixed(2)} < $${CONFIG.RISK.minBalanceFloor.toFixed(2)})`);
            return { allowed: false, reasons };
        }

        const cycleKey = `${candidate.timeframe}_${candidate.epoch || 'unknown'}`;
        const cycleCount = this.globalTradesThisCycle[cycleKey] || 0;
        const tier = this._getTierProfile(this.bankroll);
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

    calculateSize(candidate) {
        const bankroll = this.bankroll;
        const entryPrice = candidate.entryPrice;
        const pWin = candidate.pWinEstimate || 0.5;

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

        // Minimum order enforcement
        const minOrderCost = CONFIG.RISK.minOrderShares * entryPrice;

        if (size < minOrderCost) {
            // MICRO_SPRINT: allow bump to min order if bankroll can handle it
            // At micro bankrolls, skip the 5% buffer — just need to afford the min order
            const minCashNeeded = bankroll < CONFIG.RISK.microBankrollThreshold
                ? minOrderCost
                : minOrderCost * 1.05;
            if (bankroll >= minCashNeeded) {
                size = minOrderCost;
            } else {
                return { size: 0, blocked: true, reason: `BELOW_MIN_ORDER ($${size.toFixed(2)} < $${minOrderCost.toFixed(2)})` };
            }
        }

        // Floor: never risk so much that a loss drops below min balance floor
        const maxRisk = bankroll - CONFIG.RISK.minBalanceFloor;
        if (size > maxRisk && this.bankroll < CONFIG.RISK.microBankrollThreshold) {
            // For micro-bankroll, allow going below floor (user accepts bust risk)
        } else if (size > maxRisk) {
            size = Math.max(minOrderCost, maxRisk);
        }

        return { size: Math.max(0, size), blocked: false, reason: null };
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
