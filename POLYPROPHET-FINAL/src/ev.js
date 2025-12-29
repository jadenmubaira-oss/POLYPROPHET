/**
 * POLYPROPHET FINAL: EV ENGINE
 * 
 * Binary contract expected value calculation.
 */

class EVEngine {
    constructor() {
        this.FEES = 0.02; // 2% fee buffer
    }

    calculate(p_hat, p_market) {
        if (p_market === 0 || p_market === 1) return { ev: 0, edge: 0 };

        // EV = p_hat * (1 - p_market) - (1 - p_hat) * p_market
        const ev = p_hat * (1 - p_market) - (1 - p_hat) * p_market;
        const feeAdjustedEv = ev - this.FEES;
        const edge = p_hat - p_market;

        return {
            ev: feeAdjustedEv,
            edge,
            p_hat,
            p_market,
            isViable: feeAdjustedEv > 0
        };
    }

    estimatePHat(brainConfidence, velocityScore, winRate) {
        const w1 = 0.65; // Brain confidence (most reliable)
        const w2 = 0.25; // Velocity
        const w3 = 0.10; // Historical win rate

        let p_hat = (brainConfidence * w1) + (velocityScore * w2) + (winRate * w3);
        
        // Boost for high confidence
        if (brainConfidence >= 0.94) {
            p_hat = Math.min(0.98, p_hat * 1.15);
        } else if (brainConfidence >= 0.85) {
            p_hat = Math.min(0.95, p_hat * 1.10);
        }
        
        return Math.max(0.01, Math.min(0.99, p_hat));
    }
}

module.exports = EVEngine;

