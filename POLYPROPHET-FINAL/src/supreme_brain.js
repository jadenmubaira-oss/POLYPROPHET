/**
 * POLYPROPHET FINAL: SUPREME BRAIN
 * 
 * Multi-model ensemble prediction engine.
 * Preserved and battle-tested logic from 1,973 cycles.
 */

const { KalmanFilter, MathLib } = require('./math_utils');

class SupremeBrain {
    constructor(asset) {
        this.asset = asset;
        this.prediction = 'WAIT';
        this.confidence = 0;
        this.tier = 'NONE';
        this.oracleLocked = false;
        this.lockPrediction = 'NEUTRAL';
        this.lockState = 'NEUTRAL';
        this.stabilityCounter = 0;
        
        this.stats = { wins: 0, losses: 0, total: 0 };
        this.modelAccuracy = {
            genesis: { wins: 0, total: 0 },
            physicist: { wins: 0, total: 0 },
            whale: { wins: 0, total: 0 },
            volume: { wins: 0, total: 0 }
        };
        
        this.priceKalman = new KalmanFilter(0.0001, 0.001);
        this.lastPrediction = null;
    }
    
    async update(currentPrice, startPrice, history, elapsed, marketData) {
        // Need minimum history for predictions
        if (!currentPrice || !startPrice || history.length < 5) {
            return;
        }
        
        // Skip if oracle already locked
        if (this.oracleLocked) return;
        
        const weights = this.calculateWeights();
        const votes = { UP: 0, DOWN: 0 };
        const modelVotes = {};
        let totalConfidence = 0;
        
        const atr = MathLib.calculateATR(history, 20);
        const filteredPrice = this.priceKalman.filter(currentPrice);
        const force = filteredPrice - startPrice;
        const absForce = Math.abs(force);
        
        // --- MODEL 1: GENESIS PROTOCOL (The Force) ---
        if (this.lockState === 'NEUTRAL' && absForce > atr * 2.2) {
            this.lockState = force > 0 ? 'UP' : 'DOWN';
        }
        if (this.lockState !== 'NEUTRAL') {
            const genWeight = weights.genesis || 2.5;
            votes[this.lockState] += (elapsed < 180 ? 2 : 1) * genWeight;
            modelVotes.genesis = this.lockState;
            totalConfidence += 0.85;
        }
        
        // --- MODEL 2: PHYSICIST (Derivatives) ---
        const phys = MathLib.getDerivatives(history);
        if (Math.abs(phys.v) > atr * 0.5) {
            const physSignal = phys.v > 0 ? 'UP' : 'DOWN';
            votes[physSignal] += weights.physicist || 1.2;
            modelVotes.physicist = physSignal;
            totalConfidence += 0.75;
        }
        
        // --- MODEL 3: WHALE (Market Odds Analysis) ---
        if (marketData?.yesPrice && marketData?.noPrice) {
            const spread = Math.abs(marketData.yesPrice - marketData.noPrice);
            const midPrice = (marketData.yesPrice + marketData.noPrice) / 2;
            if (spread < 0.05 && Math.abs(midPrice - 0.5) > 0.15) {
                const whaleSignal = midPrice > 0.5 ? 'UP' : 'DOWN';
                votes[whaleSignal] += 1.5 * (weights.whale || 1.0);
                modelVotes.whale = whaleSignal;
                totalConfidence += 0.85;
            }
        }
        
        // --- MODEL 4: VOLUME CONFIRMATION ---
        const vol = marketData?.volume || 0;
        if (vol > 100000 && history.length > 5) {
            const priceChange = (currentPrice - history[history.length - 5].p) / (history[history.length - 5].p || 1);
            const volSignal = priceChange > 0 ? 'UP' : 'DOWN';
            votes[volSignal] += weights.volume || 1.0;
            modelVotes.volume = volSignal;
            totalConfidence += 0.65;
        }
        
        // --- DECISION LOGIC ---
        const totalVotes = votes.UP + votes.DOWN;
        let finalSignal = 'WAIT';
        let finalConfidence = 0;
        
        let agreement = 0;
        let priceConfirmation = 0.5;
        let manipFactor = 1.0;
        let patternQuality = 0;
        let stabilityFactor = 0;
        
        if (totalVotes > 0) {
            finalSignal = votes.UP > votes.DOWN ? 'UP' : (votes.DOWN > votes.UP ? 'DOWN' : 'WAIT');
            
            // 1. Model Agreement
            agreement = Math.max(votes.UP, votes.DOWN) / totalVotes;
            
            // 2. Price Confirmation
            const priceTrend = force > 0 ? 'UP' : 'DOWN';
            priceConfirmation = finalSignal === priceTrend ? 1.0 : 0.5;
            
            // 3. Manipulation Detection
            const spread = Math.abs((marketData?.yesPrice || 0.5) - (marketData?.noPrice || 0.5));
            manipFactor = spread > 0.15 ? 0.7 : 1.0;
            
            // 4. Pattern Quality
            patternQuality = Math.min(1.0, absForce / (atr * 1.5));
            
            // 5. Stability
            if (this.lastPrediction === finalSignal) {
                this.stabilityCounter = (this.stabilityCounter || 0) + 1;
            } else {
                this.stabilityCounter = 0;
            }
            stabilityFactor = Math.min(1.0, this.stabilityCounter / 10);
            
            // COMPOSITE CONFIDENCE
            finalConfidence = (agreement * 0.4) +
                (priceConfirmation * 0.2) +
                (manipFactor * 0.1) +
                (patternQuality * 0.2) +
                (stabilityFactor * 0.1);
            
            this.lastPrediction = finalSignal;
        }
        
        // GENESIS VETO (High-accuracy model overrides)
        if (modelVotes.genesis && finalSignal !== 'WAIT' && finalSignal !== modelVotes.genesis) {
            const genAcc = this.modelAccuracy.genesis.wins / (this.modelAccuracy.genesis.total || 1);
            if (genAcc > 0.90 || this.modelAccuracy.genesis.total < 5) {
                finalSignal = modelVotes.genesis;
                finalConfidence = Math.max(finalConfidence, 0.82);
            }
        }
        
        this.prediction = finalSignal;
        this.confidence = Math.min(1.0, finalConfidence);
        this.tier = this.confidence > 0.85 ? 'CONVICTION' : (this.confidence > 0.65 ? 'ADVISORY' : 'NONE');
        
        // ORACLE LOCK (High-confidence commitment)
        if (!this.oracleLocked && this.confidence >= 0.94 && elapsed < 600 && modelVotes.genesis === finalSignal) {
            this.oracleLocked = true;
            this.lockPrediction = finalSignal;
            console.log(`🔒 ${this.asset} ORACLE LOCKED: ${finalSignal} @ ${(this.confidence * 100).toFixed(1)}%`);
        }
        
        this.currentModelVotes = modelVotes;
    }
    
    calculateWeights() {
        const weights = {};
        for (const [model, acc] of Object.entries(this.modelAccuracy)) {
            if (acc.total === 0) {
                weights[model] = model === 'genesis' ? 2.5 : 1.0;
            } else {
                const accuracy = acc.wins / acc.total;
                const baseWeight = model === 'genesis' ? 2.5 : 1.0;
                weights[model] = baseWeight * (accuracy * accuracy);
            }
        }
        return weights;
    }
    
    recordOutcome(win) {
        this.stats.total++;
        if (win) this.stats.wins++;
        else this.stats.losses++;
        
        // Update model accuracy
        if (this.currentModelVotes) {
            const actualDir = win ? this.prediction : (this.prediction === 'UP' ? 'DOWN' : 'UP');
            for (const [model, vote] of Object.entries(this.currentModelVotes)) {
                if (this.modelAccuracy[model]) {
                    this.modelAccuracy[model].total++;
                    if (vote === actualDir) {
                        this.modelAccuracy[model].wins++;
                    }
                }
            }
        }
    }
    
    reset() {
        this.oracleLocked = false;
        this.lockPrediction = 'NEUTRAL';
        this.lockState = 'NEUTRAL';
        this.stabilityCounter = 0;
        this.prediction = 'WAIT';
        this.tier = 'NONE';
    }
}

module.exports = SupremeBrain;

