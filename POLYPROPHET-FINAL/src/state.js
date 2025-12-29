/**
 * POLYPROPHET FINAL: STATE MACHINE
 */

class StateMachine {
    constructor() {
        this.currentState = 'OBSERVE';
        this.outcomes = [];
    }

    update(asset, metrics, tradeResult = null) {
        if (tradeResult) {
            this.outcomes.push(tradeResult.pnl > 0);
            if (this.outcomes.length > 4) this.outcomes.shift();
        }

        const recentWins = this.outcomes.filter(w => w === true).length;
        const ev = metrics.ev || 0;

        if (this.currentState === 'STRIKE') {
            if (tradeResult) {
                this.currentState = 'OBSERVE';
                this.outcomes = [];
            }
        } else if (this.currentState === 'HARVEST') {
            if (recentWins >= 3 && ev >= 0.12) {
                this.currentState = 'STRIKE';
            } else if (tradeResult && !tradeResult.win) {
                this.currentState = 'OBSERVE';
                this.outcomes = [];
            }
        } else if (this.currentState === 'OBSERVE') {
            if (ev > 0.01 && metrics.p_win > metrics.p_market) {
                this.currentState = 'HARVEST';
            }
            if (ev > 0.10 && metrics.p_win >= 0.85) {
                this.currentState = 'STRIKE';
            }
        }

        return this.currentState;
    }
}

module.exports = StateMachine;

