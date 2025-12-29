/**
 * DEEP CYCLE ANALYSIS - ATOMIC INVESTIGATION
 * Analyzes EVERYTHING: cycles, prices, timing, patterns, market conditions
 */

const fs = require('fs');
const path = require('path');

function deepAnalyze() {
    console.log('🔬 DEEP CYCLE ANALYSIS - ATOMIC INVESTIGATION\n');
    
    const debugDir = 'POLYPROPHET-2d998c92e045c0110cc2864b53e62c70e0ccefbd/debug';
    const possiblePaths = [
        debugDir,
        'debug',
        './debug',
        '../debug'
    ];
    
    let actualDir = null;
    for (const p of possiblePaths) {
        if (fs.existsSync(p)) {
            actualDir = p;
            break;
        }
    }
    
    if (!actualDir) {
        console.error('❌ Could not find debug directory');
        return null;
    }
    
    const files = fs.readdirSync(actualDir)
        .filter(f => f.endsWith('.json'))
        .sort();
    
    console.log(`Found ${files.length} debug logs\n`);
    
    const analysis = {
        cycles: [],
        trades: [],
        pricePatterns: {},
        timePatterns: {},
        assetPatterns: {},
        winConditions: [],
        lossConditions: [],
        opportunities: []
    };
    
    files.forEach((file, idx) => {
        try {
            const logData = JSON.parse(fs.readFileSync(path.join(actualDir, file), 'utf8'));
            const timestamp = new Date(logData.exportTime);
            const hour = timestamp.getHours();
            const dayOfWeek = timestamp.getDay();
            
            // Analyze each asset
            ['BTC', 'ETH', 'SOL', 'XRP'].forEach(asset => {
                const assetData = logData.assets?.[asset];
                if (!assetData) return;
                
                const cycleHistory = assetData.cycleHistory || [];
                const currentState = assetData.currentState || {};
                const market = logData.currentMarkets?.[asset];
                
                cycleHistory.forEach(cycle => {
                    const cycleData = {
                        timestamp: timestamp,
                        hour: hour,
                        dayOfWeek: dayOfWeek,
                        asset: asset,
                        file: file,
                        cycle: cycle,
                        market: market,
                        state: currentState
                    };
                    
                    // Extract cycle information
                    const entryPrice = cycle.marketOdds ? 
                        (cycle.prediction === 'UP' ? cycle.marketOdds.yesPrice : cycle.marketOdds.noPrice) : null;
                    const exitPrice = cycle.resolvedPrice || null;
                    const wasCorrect = cycle.wasCorrect;
                    const tier = cycle.tier;
                    const confidence = cycle.confidence;
                    const certainty = cycle.certaintyAtEnd;
                    const oracleLocked = cycle.oracleWasLocked;
                    const allAgree = cycle.modelAgreementHistory && 
                        cycle.modelAgreementHistory.length >= 3 &&
                        cycle.modelAgreementHistory.every(v => v === cycle.modelAgreementHistory[0] && v !== null);
                    
                    // Price analysis
                    if (entryPrice !== null) {
                        const priceRange = entryPrice < 0.10 ? 'ULTRA_CHEAP' :
                                         entryPrice < 0.20 ? 'CHEAP' :
                                         entryPrice < 0.30 ? 'LOW' :
                                         entryPrice < 0.50 ? 'MEDIUM' :
                                         entryPrice < 0.70 ? 'HIGH' : 'VERY_HIGH';
                        
                        if (!analysis.pricePatterns[priceRange]) {
                            analysis.pricePatterns[priceRange] = { total: 0, correct: 0, incorrect: 0 };
                        }
                        analysis.pricePatterns[priceRange].total++;
                        if (wasCorrect) analysis.pricePatterns[priceRange].correct++;
                        else analysis.pricePatterns[priceRange].incorrect++;
                    }
                    
                    // Time analysis
                    const timeKey = `${hour}:00`;
                    if (!analysis.timePatterns[timeKey]) {
                        analysis.timePatterns[timeKey] = { total: 0, correct: 0, incorrect: 0, avgEntryPrice: 0, prices: [] };
                    }
                    analysis.timePatterns[timeKey].total++;
                    if (wasCorrect) analysis.timePatterns[timeKey].correct++;
                    else analysis.timePatterns[timeKey].incorrect++;
                    if (entryPrice !== null) {
                        analysis.timePatterns[timeKey].prices.push(entryPrice);
                        analysis.timePatterns[timeKey].avgEntryPrice = 
                            analysis.timePatterns[timeKey].prices.reduce((a, b) => a + b, 0) / 
                            analysis.timePatterns[timeKey].prices.length;
                    }
                    
                    // Asset analysis
                    if (!analysis.assetPatterns[asset]) {
                        analysis.assetPatterns[asset] = { total: 0, correct: 0, incorrect: 0, prices: [], tiers: {} };
                    }
                    analysis.assetPatterns[asset].total++;
                    if (wasCorrect) analysis.assetPatterns[asset].correct++;
                    else analysis.assetPatterns[asset].incorrect++;
                    if (entryPrice !== null) analysis.assetPatterns[asset].prices.push(entryPrice);
                    if (tier) {
                        if (!analysis.assetPatterns[asset].tiers[tier]) {
                            analysis.assetPatterns[asset].tiers[tier] = { total: 0, correct: 0 };
                        }
                        analysis.assetPatterns[asset].tiers[tier].total++;
                        if (wasCorrect) analysis.assetPatterns[asset].tiers[tier].correct++;
                    }
                    
                    // Win conditions
                    if (wasCorrect && entryPrice !== null) {
                        analysis.winConditions.push({
                            asset,
                            entryPrice,
                            tier,
                            confidence,
                            certainty,
                            oracleLocked,
                            allAgree,
                            hour,
                            returnMultiplier: exitPrice ? (1 / entryPrice) : null
                        });
                    }
                    
                    // Loss conditions
                    if (!wasCorrect && entryPrice !== null) {
                        analysis.lossConditions.push({
                            asset,
                            entryPrice,
                            tier,
                            confidence,
                            certainty,
                            oracleLocked,
                            allAgree,
                            hour
                        });
                    }
                    
                    // Opportunities (cycles that could have been traded)
                    if (entryPrice !== null && entryPrice < 0.80) {
                        const potentialReturn = 1 / entryPrice;
                        analysis.opportunities.push({
                            asset,
                            entryPrice,
                            potentialReturn,
                            tier,
                            confidence,
                            certainty,
                            oracleLocked,
                            allAgree,
                            wasCorrect,
                            hour,
                            timestamp
                        });
                    }
                    
                    analysis.cycles.push(cycleData);
                });
            });
            
            // Analyze trades
            const tradeHistory = logData.tradeExecutor?.tradeHistory || [];
            tradeHistory.forEach(trade => {
                if (trade.status === 'CLOSED') {
                    analysis.trades.push({
                        ...trade,
                        timestamp: new Date(trade.closeTime || trade.time),
                        hour: new Date(trade.closeTime || trade.time).getHours()
                    });
                }
            });
        } catch (e) {
            console.error(`Error processing ${file}: ${e.message}`);
        }
    });
    
    // Generate comprehensive report
    console.log('═══════════════════════════════════════════════════════');
    console.log('📊 COMPREHENSIVE ANALYSIS RESULTS');
    console.log('═══════════════════════════════════════════════════════\n');
    
    console.log(`Total Cycles Analyzed: ${analysis.cycles.length}`);
    console.log(`Total Trades: ${analysis.trades.length}`);
    console.log(`Total Opportunities: ${analysis.opportunities.length}\n`);
    
    // Price pattern analysis
    console.log('═══════════════════════════════════════════════════════');
    console.log('💰 PRICE PATTERN ANALYSIS');
    console.log('═══════════════════════════════════════════════════════\n');
    Object.entries(analysis.pricePatterns)
        .sort((a, b) => {
            const aPrice = a[0] === 'ULTRA_CHEAP' ? 0 : a[0] === 'CHEAP' ? 1 : a[0] === 'LOW' ? 2 : a[0] === 'MEDIUM' ? 3 : a[0] === 'HIGH' ? 4 : 5;
            const bPrice = b[0] === 'ULTRA_CHEAP' ? 0 : b[0] === 'CHEAP' ? 1 : b[0] === 'LOW' ? 2 : b[0] === 'MEDIUM' ? 3 : b[0] === 'HIGH' ? 4 : 5;
            return aPrice - bPrice;
        })
        .forEach(([range, data]) => {
            const winRate = data.total > 0 ? (data.correct / data.total) * 100 : 0;
            console.log(`${range}:`);
            console.log(`  Total: ${data.total}`);
            console.log(`  Correct: ${data.correct}`);
            console.log(`  Incorrect: ${data.incorrect}`);
            console.log(`  Win Rate: ${winRate.toFixed(2)}%`);
            console.log('');
        });
    
    // Time pattern analysis
    console.log('═══════════════════════════════════════════════════════');
    console.log('⏰ TIME PATTERN ANALYSIS (Best Hours)');
    console.log('═══════════════════════════════════════════════════════\n');
    Object.entries(analysis.timePatterns)
        .filter(([_, data]) => data.total >= 5) // Only hours with 5+ cycles
        .map(([hour, data]) => {
            const winRate = data.total > 0 ? (data.correct / data.total) * 100 : 0;
            return { hour, ...data, winRate };
        })
        .sort((a, b) => b.winRate - a.winRate)
        .slice(0, 10)
        .forEach(data => {
            console.log(`${data.hour}:`);
            console.log(`  Total: ${data.total}`);
            console.log(`  Win Rate: ${data.winRate.toFixed(2)}%`);
            console.log(`  Avg Entry Price: ${(data.avgEntryPrice * 100).toFixed(1)}¢`);
            console.log('');
        });
    
    // Asset analysis
    console.log('═══════════════════════════════════════════════════════');
    console.log('📈 ASSET ANALYSIS');
    console.log('═══════════════════════════════════════════════════════\n');
    Object.entries(analysis.assetPatterns).forEach(([asset, data]) => {
        const winRate = data.total > 0 ? (data.correct / data.total) * 100 : 0;
        const avgPrice = data.prices.length > 0 ? 
            data.prices.reduce((a, b) => a + b, 0) / data.prices.length : 0;
        console.log(`${asset}:`);
        console.log(`  Total Cycles: ${data.total}`);
        console.log(`  Win Rate: ${winRate.toFixed(2)}%`);
        console.log(`  Avg Entry Price: ${(avgPrice * 100).toFixed(1)}¢`);
        console.log(`  Tier Performance:`);
        Object.entries(data.tiers).forEach(([tier, tierData]) => {
            const tierWinRate = tierData.total > 0 ? (tierData.correct / tierData.total) * 100 : 0;
            console.log(`    ${tier}: ${tierWinRate.toFixed(2)}% (${tierData.correct}/${tierData.total})`);
        });
        console.log('');
    });
    
    // Best opportunities
    console.log('═══════════════════════════════════════════════════════');
    console.log('🎯 BEST OPPORTUNITIES (Top 20 by Potential Return)');
    console.log('═══════════════════════════════════════════════════════\n');
    analysis.opportunities
        .filter(o => o.wasCorrect && o.entryPrice < 0.20)
        .sort((a, b) => b.potentialReturn - a.potentialReturn)
        .slice(0, 20)
        .forEach((opp, idx) => {
            console.log(`${idx + 1}. ${opp.asset} @ ${(opp.entryPrice * 100).toFixed(1)}¢`);
            console.log(`   Return: ${opp.potentialReturn.toFixed(2)}x`);
            console.log(`   Tier: ${opp.tier}, Confidence: ${(opp.confidence * 100).toFixed(1)}%`);
            console.log(`   Oracle Locked: ${opp.oracleLocked}, All Agree: ${opp.allAgree}`);
            console.log(`   Hour: ${opp.hour}:00`);
            console.log('');
        });
    
    // Win condition patterns
    console.log('═══════════════════════════════════════════════════════');
    console.log('✅ WIN CONDITION PATTERNS');
    console.log('═══════════════════════════════════════════════════════\n');
    const winPatterns = {
        ultraCheap: analysis.winConditions.filter(w => w.entryPrice < 0.10).length,
        cheap: analysis.winConditions.filter(w => w.entryPrice >= 0.10 && w.entryPrice < 0.20).length,
        oracleLocked: analysis.winConditions.filter(w => w.oracleLocked).length,
        allAgree: analysis.winConditions.filter(w => w.allAgree).length,
        highConfidence: analysis.winConditions.filter(w => w.confidence >= 0.80).length,
        highCertainty: analysis.winConditions.filter(w => w.certainty >= 75).length
    };
    Object.entries(winPatterns).forEach(([pattern, count]) => {
        console.log(`${pattern}: ${count} wins`);
    });
    console.log('');
    
    // Loss condition patterns
    console.log('═══════════════════════════════════════════════════════');
    console.log('❌ LOSS CONDITION PATTERNS');
    console.log('═══════════════════════════════════════════════════════\n');
    const lossPatterns = {
        highPrice: analysis.lossConditions.filter(l => l.entryPrice >= 0.50).length,
        lowConfidence: analysis.lossConditions.filter(l => l.confidence < 0.70).length,
        noOracleLock: analysis.lossConditions.filter(l => !l.oracleLocked).length,
        noAgreement: analysis.lossConditions.filter(l => !l.allAgree).length
    };
    Object.entries(lossPatterns).forEach(([pattern, count]) => {
        console.log(`${pattern}: ${count} losses`);
    });
    console.log('');
    
    return analysis;
}

if (require.main === module) {
    deepAnalyze();
}

module.exports = { deepAnalyze };

