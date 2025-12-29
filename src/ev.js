/**
 * POLYPROPHET-V2: EV ENGINE
 * 
 * Formula: EV = p_hat * (1 - p_market) - (1 - p_hat) * p_market
 */

class EVEngine {
    constructor(config = {}) {
        this.FEES = config.fees || 0.02; // 2% fee buffer
    }

    /**
     * @param {number} p_hat - Our estimated win probability (0.0 - 1.0)
     * @param {number} p_market - Market implied probability (price 0.0 - 1.0)
     */
    calculate(p_hat, p_market) {
        if (p_market === 0) return { ev: 0, edge: 0 };

        // Expected Value per £1 staked
        const ev = p_hat * (1 - p_market) - (1 - p_hat) * p_market;

        // Fee-adjusted EV
        const feeAdjustedEv = ev - this.FEES;
        const edge = p_hat - p_market;

        return {
            ev: feeAdjustedEv,
            edge: edge,
            p_hat,
            p_market,
            isViable: feeAdjustedEv > 0
        };
    }

    // Logistic estimator for p_hat combining brain certainty + priors
    estimatePHat(brainCertainty, velocityScore, winRate) {
        // CRITICAL FIX: Use actual velocity, not placeholder
        // If velocity is not provided, estimate from brain certainty momentum
        const actualVelocity = velocityScore !== 0.5 ? velocityScore : Math.min(1.0, brainCertainty * 1.2);
        
        const w1 = 0.65; // Brain Prior (increased - it's the most reliable)
        const w2 = 0.25; // Velocity (real value now)
        const w3 = 0.10; // Historical Win Rate

        let p_hat = (brainCertainty * w1) + (actualVelocity * w2) + (winRate * w3);
        
        // CRITICAL: Oracle locks boost p_hat significantly
        // If brain has oracle lock, it means confidence >= 0.94, so boost p_hat
        if (brainCertainty >= 0.94) {
            p_hat = Math.min(0.98, p_hat * 1.15); // Boost by 15%, cap at 98%
        }
        
        // Conviction tier also boosts
        if (brainCertainty >= 0.85) {
            p_hat = Math.min(0.95, p_hat * 1.10); // Boost by 10%, cap at 95%
        }
        
        return Math.max(0.01, Math.min(0.99, p_hat)); // Clamp to valid range
    }
}

module.exports = EVEngine;
