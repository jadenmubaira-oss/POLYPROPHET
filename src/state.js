/**
 * POLYPROPHET-V2: STATE MACHINE
 * 
 * Rules:
 * - OBSERVE: Default state. Gathering metrics. Probing allowed (<5%).
 * - HARVEST: Directional rhythm detected. Consistent small trades (12%).
 * - STRIKE: High-conviction windows. Aggressive compounding (40%).
 */

class StateMachine {
    constructor(config = {}) {
        this.currentState = 'OBSERVE';
        this.config = Object.assign({
            observeWindowMinutes: 30,
            strikeGates: { N: 3, M: 4, T: 180, S: 0.08 }
        }, config);

        this.outcomes = []; // Last M harvest outcomes
        this.startTime = Date.now();
    }

    update(asset, metrics, tradeResult = null) {
        if (tradeResult) {
            this.outcomes.push(tradeResult.pnl > 0);
            if (this.outcomes.length > this.config.strikeGates.M) this.outcomes.shift();
        }

        const recentWins = this.outcomes.filter(w => w === true).length;
        const timeToExpiry = metrics.timeToEnd || 900;
        const ev = metrics.ev || 0;

        // Transition Logic
        if (this.currentState === 'STRIKE') {
            // Reset on any trade result (win or loss) - one-and-done
            if (tradeResult) {
                this.transition('OBSERVE');
                this.outcomes = []; // Reset outcomes
            }
        }
        else if (this.currentState === 'HARVEST') {
            const strikeReady = recentWins >= this.config.strikeGates.N &&
                timeToExpiry <= this.config.strikeGates.T &&
                ev >= 0.12 &&
                metrics.spread >= this.config.strikeGates.S;

            if (strikeReady) {
                this.transition('STRIKE');
            } else if (tradeResult && !tradeResult.win) {
                // Loss in HARVEST -> retreat to OBSERVE
                this.transition('OBSERVE');
                this.outcomes = []; // Reset
            }
        }
        else if (this.currentState === 'OBSERVE') {
            // CRITICAL FIX: Remove strict gates - transition on ANY positive EV
            // This fixes the catch-22 where system can't enter HARVEST without trades
            if (metrics.ev > 0.01 && metrics.p_win > metrics.p_market) {
                this.transition('HARVEST');
            }
            // Also allow direct STRIKE entry if oracle locked or very high confidence
            if (metrics.ev > 0.10 && metrics.p_win >= 0.85) {
                this.transition('STRIKE');
            }
        }

        return this.currentState;
    }

    transition(newState) {
        console.log(`[V2-STATE] ${this.currentState} -> ${newState}`);
        this.currentState = newState;
    }

    getMaxSizePct() {
        switch (this.currentState) {
            case 'STRIKE': return 0.40;
            case 'HARVEST': return 0.15;
            case 'OBSERVE': return 0.05;
            default: return 0.01;
        }
    }
}

module.exports = StateMachine;
