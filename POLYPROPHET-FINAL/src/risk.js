/**
 * POLYPROPHET FINAL: RISK ENGINE
 */

class RiskEngine {
    constructor(config = {}) {
        this.maxTotalExposure = config.maxTotalExposure || 0.75;
        this.maxPositionSize = config.maxPositionSize || 0.75;
        this.drawdownLimit = config.drawdownLimit || 0.25;
        this.minTradeSize = config.minTradeSize || 1.10;
    }

    checkDrawdown(currentBankroll, peakBankroll) {
        const dd = (peakBankroll - currentBankroll) / peakBankroll;
        return dd >= this.drawdownLimit;
    }
    
    validateTrade(bankroll, stake, currentExposure) {
        if (stake < this.minTradeSize) return { valid: false, reason: 'Below minimum trade size' };
        
        const equity = bankroll + currentExposure;
        const newExposure = currentExposure + stake;
        
        if (newExposure / equity > this.maxTotalExposure) {
            return { valid: false, reason: 'Would exceed max exposure' };
        }
        
        if (stake / bankroll > this.maxPositionSize) {
            return { valid: false, reason: 'Position size too large' };
        }
        
        return { valid: true };
    }
}

module.exports = RiskEngine;

