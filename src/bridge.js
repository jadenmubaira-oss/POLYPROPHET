/**
 * OMEGA V2: MASTER ARCHITECTURE BRIDGE
 * 
 * Fuses the 'SupremeBrain' Ensemble with the OMEGA State Harvester.
 */

const StateMachine = require('./state');
const EVEngine = require('./ev');
const RiskEngine = require('./risk');

class OmegaBridge {
    constructor(brains, config) {
        this.brains = brains;
        this.config = config;
        this.stateMachines = {}; // Per-asset independence

        Object.keys(brains).forEach(asset => {
            this.stateMachines[asset] = new StateMachine(config.STATE);
        });

        this.evEngine = new EVEngine(config.EV);
        this.riskEngine = new RiskEngine(config.RISK);
    }

    /**
     * @param {string} asset - BTC, ETH, SOL, XRP
     * @param {Object} market - Current market snapshot
     * @param {number} bankroll - Total available capital
     */
    evaluate(asset, market, bankroll) {
        const brain = this.brains[asset];
        if (!brain) return null;

        // 1. Get raw brain metrics
        const p_brain = brain.confidence;
        const consensus = brain.consensusRatio || 0.5;

        // 2. Calculate OMEGA Metrics (EV + p_hat)
        // velocityScore placeholder (could come from brain.physicist or indicators)
        const p_hat = this.evEngine.estimatePHat(p_brain, 0.5, 0.5);
        const evMetrics = this.evEngine.calculate(p_hat, market.yesPrice);

        // 3. Update State Machine
        const state = this.stateMachines[asset].update(asset, {
            velocity: brain.lockStrength || 0,
            spread: Math.abs(market.yesPrice - market.noPrice),
            timeToEnd: market.timeRemaining || 900,
            edge: evMetrics.edge,
            p_win: p_hat,
            p_market: market.yesPrice,
            ev: evMetrics.ev
        });

        // 4. Calculate Sizing (Fractional Kelly)
        const sizePct = this.riskEngine.calculateSize(bankroll, evMetrics.ev, state, p_hat, market.yesPrice);
        const allowedSize = bankroll * sizePct;

        return {
            asset,
            prediction: brain.prediction,
            confidence: p_brain,
            consensus: consensus,
            state: state,
            ev: evMetrics.ev,
            edge: evMetrics.edge,
            allowedSize: allowedSize,
            isStrike: state === 'STRIKE',
            isLocked: brain.oracleLocked
        };
    }
}

module.exports = { OmegaBridge };
