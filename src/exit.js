/**
 * OMEGA V2: EXIT ENGINE
 * 
 * Monitors active positions and triggers exits for:
 * 1. Directional Reversal (Brain Flip)
 * 2. Confidence Drain (Brain Death)
 * 3. Trailing Stop-Loss
 */

class OmegaExit {
    constructor(config = {}) {
        this.STOP_LOSS = config.trailingStopLoss || 0.15; // 15% Trail
        this.BRAIN_FLIP_THRESHOLD = 0.60; // Confidence needed to flip
    }

    /**
     * @param {Object} pos - Active position object
     * @param {Object} verdict - Current brain verdict for the asset
     * @param {Object} market - Current market prices
     */
    evaluateExit(pos, verdict, market) {
        if (!pos || pos.status !== 'OPEN') return null;

        const currentPrice = pos.prediction === 'UP' ? market.yesPrice : market.noPrice;
        const profit = currentPrice - pos.entryPrice;

        // 🛡️ 1. DIRECTIONAL REVERSAL (The "Flip" Protection)
        if (!verdict.isLocked && verdict.prediction !== pos.prediction && verdict.confidence > this.BRAIN_FLIP_THRESHOLD) {
            return { reason: 'BRAIN_REVERSAL', type: 'EXIT' };
        }

        // 🧠 2. CONFIDENCE DRAIN (The "Brain Death" Protection)
        if (!verdict.isLocked && verdict.confidence < 0.15 && verdict.prediction !== 'WAIT') {
            return { reason: 'CONFIDENCE_DRAIN', type: 'EXIT' };
        }

        // 🛑 3. TRAILING STOP-LOSS
        if (profit < -this.STOP_LOSS) {
            return { reason: 'STOP_LOSS_HIT', type: 'EXIT' };
        }

        return null;
    }
}

module.exports = OmegaExit;
