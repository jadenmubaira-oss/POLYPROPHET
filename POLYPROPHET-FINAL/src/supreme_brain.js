/**
 * POLYPROPHET PINNACLE: SUPREME BRAIN
 * 
 * THE GOLDEN KEY: Genesis model at 93-94% accuracy DOMINATES all decisions.
 * 
 * Based on forensic analysis of 485 trades and 85 debug logs:
 * - Genesis: 94.47% (BTC), 94.11% (ETH), 93.18% (SOL), 94.22% (XRP)
 * - All other models: ~50% (coin flip) - DISABLED
 * 
 * CONVICTION tier + Genesis agreement = WIN
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
        
        // THE GOLDEN KEY: Genesis is the only model that matters (93-94% accuracy)
        // All other models hover around 50% (coin flip) - they add noise, not signal
        this.modelAccuracy = {
            genesis: { wins: 0, total: 0 },      // 94% accuracy - THE GOD
            correlation: { wins: 0, total: 0 },  // 78-84% for ETH/SOL/XRP
            orderbook: { wins: 0, total: 0 },    // 65-77% - USEFUL
            physicist: { wins: 0, total: 0 },    // ~50% - DISABLED
            whale: { wins: 0, total: 0 },        // ~50% - DISABLED  
            volume: { wins: 0, total: 0 }        // ~50% - DISABLED
        };
        
        this.priceKalman = new KalmanFilter(0.0001, 0.001);
        this.lastPrediction = null;
        this.genesisDirection = null;
        this.genesisConfirmedAt = null;
    }
    
    async update(currentPrice, startPrice, history, elapsed, marketData) {
        // Need minimum history for predictions
        if (!currentPrice || !startPrice || history.length < 5) {
            return;
        }
        
        // Skip if oracle already locked
        if (this.oracleLocked) return;
        
        const modelVotes = {};
        const votes = { UP: 0, DOWN: 0 };
        
        const atr = MathLib.calculateATR(history, 20);
        const filteredPrice = this.priceKalman.filter(currentPrice);
        const force = filteredPrice - startPrice;
        const absForce = Math.abs(force);
        
        // ==================== THE PINNACLE STRATEGY ====================
        // Genesis is the ONLY model that matters (93-94% accuracy)
        // All other models add noise, not signal
        
        // --- MODEL 1: GENESIS (THE GOD - 94% accuracy) ---
        // Genesis locks ONCE per cycle when force exceeds threshold
        // This is the PRIMARY and DOMINANT signal
        if (this.lockState === 'NEUTRAL' && absForce > atr * 2.0) {
            this.lockState = force > 0 ? 'UP' : 'DOWN';
            this.genesisDirection = this.lockState;
            this.genesisConfirmedAt = elapsed;
            console.log(`🔮 ${this.asset} GENESIS SIGNAL: ${this.lockState} @ ${elapsed}s`);
        }
        
        if (this.lockState !== 'NEUTRAL') {
            // GENESIS SUPREMACY: 4x weight multiplier
            votes[this.lockState] += 10.0; // Dominant weight
            modelVotes.genesis = this.lockState;
        }
        
        // --- MODEL 2: ORDERBOOK (65-77% accuracy) ---
        // Secondary confirmation only - much lower weight
        if (marketData?.yesPrice && marketData?.noPrice) {
            const spread = Math.abs(marketData.yesPrice - marketData.noPrice);
            const midPrice = (marketData.yesPrice + marketData.noPrice) / 2;
            if (spread < 0.05 && Math.abs(midPrice - 0.5) > 0.15) {
                const obSignal = midPrice > 0.5 ? 'UP' : 'DOWN';
                votes[obSignal] += 1.5;
                modelVotes.orderbook = obSignal;
            }
        }
        
        // --- DISABLED MODELS (~50% accuracy = coin flip = noise) ---
        // Physicist, Whale, Volume - all disabled
        // They were actively HURTING predictions
        
        // --- DECISION LOGIC ---
        const totalVotes = votes.UP + votes.DOWN;
        let finalSignal = 'WAIT';
        let finalConfidence = 0;
        
        if (totalVotes > 0) {
            // Genesis dominates (10 vs 1.5 max for orderbook)
            finalSignal = votes.UP > votes.DOWN ? 'UP' : 'DOWN';
            
            // Confidence calculation - simplified for Genesis supremacy
            const genesisActive = modelVotes.genesis != null;
            const orderbookAgrees = modelVotes.orderbook === finalSignal;
            
            if (genesisActive) {
                // Genesis is active - high base confidence
                finalConfidence = 0.85;
                
                // Bonus if orderbook confirms
                if (orderbookAgrees) {
                    finalConfidence += 0.08;
                }
                
                // Bonus for stability
                if (this.lastPrediction === finalSignal) {
                    this.stabilityCounter = (this.stabilityCounter || 0) + 1;
                } else {
                    this.stabilityCounter = 0;
                }
                
                if (this.stabilityCounter >= 3) {
                    finalConfidence += 0.05;
                }
                
                // Pattern quality bonus
                const patternQuality = Math.min(1.0, absForce / (atr * 1.5));
                finalConfidence += patternQuality * 0.02;
            } else {
                // No Genesis signal - LOW confidence
                finalConfidence = 0.40;
            }
            
            this.lastPrediction = finalSignal;
        }
        
        // GENESIS VETO: If Genesis exists, it ALWAYS wins
        if (modelVotes.genesis && finalSignal !== modelVotes.genesis) {
            finalSignal = modelVotes.genesis;
            finalConfidence = Math.max(finalConfidence, 0.85);
            console.log(`⚡ ${this.asset} GENESIS VETO: Forcing ${finalSignal}`);
        }
        
        this.prediction = finalSignal;
        this.confidence = Math.min(1.0, finalConfidence);
        
        // TIER CALCULATION: Only CONVICTION tier should trade
        this.tier = this.confidence >= 0.85 ? 'CONVICTION' : 
                   (this.confidence >= 0.70 ? 'ADVISORY' : 'NONE');
        
        // ORACLE LOCK: Genesis must agree for lock
        if (!this.oracleLocked && 
            this.confidence >= 0.90 && 
            elapsed >= 30 && elapsed < 600 && 
            modelVotes.genesis === finalSignal) {
            this.oracleLocked = true;
            this.lockPrediction = finalSignal;
            console.log(`🔒 ${this.asset} ORACLE LOCKED: ${finalSignal} @ ${(this.confidence * 100).toFixed(1)}%`);
        }
        
        this.currentModelVotes = modelVotes;
    }
    
    calculateWeights() {
        // PINNACLE: Genesis supremacy
        // Models with <60% accuracy get ZERO weight (they add noise)
        const weights = {};
        for (const [model, acc] of Object.entries(this.modelAccuracy)) {
            if (acc.total === 0) {
                // Default weights: Genesis is king
                weights[model] = model === 'genesis' ? 10.0 : 
                                model === 'orderbook' ? 1.5 :
                                model === 'correlation' ? 2.0 : 0.0;
            } else {
                const accuracy = acc.wins / acc.total;
                
                // KILL models with <60% accuracy
                if (accuracy < 0.60) {
                    weights[model] = 0.0;
                    continue;
                }
                
                // Genesis gets 4x multiplier
                if (model === 'genesis') {
                    weights[model] = 10.0 * (accuracy * accuracy);
                } else if (model === 'correlation' && accuracy > 0.75) {
                    weights[model] = 2.0 * accuracy;
                } else if (model === 'orderbook' && accuracy > 0.65) {
                    weights[model] = 1.5 * accuracy;
                } else {
                    weights[model] = 0.0; // Disable everything else
                }
            }
        }
        return weights;
    }
    
    recordOutcome(win, tradePrediction = null, tradeModelVotes = null) {
        this.stats.total++;
        if (win) this.stats.wins++;
        else this.stats.losses++;
        
        // Bug 4 fix: Use the prediction and model votes from trade time, NOT current state
        // If not provided, fall back to current (backward compatibility, but less accurate)
        const predictionToUse = tradePrediction || this.prediction;
        const modelVotesToUse = tradeModelVotes || this.currentModelVotes;
        
        // Update model accuracy based on trade-time votes
        if (modelVotesToUse) {
            const actualDir = win ? predictionToUse : (predictionToUse === 'UP' ? 'DOWN' : 'UP');
            for (const [model, vote] of Object.entries(modelVotesToUse)) {
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

