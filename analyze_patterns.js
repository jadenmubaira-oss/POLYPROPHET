/**
 * DEEP PATTERN ANALYSIS - Finding the Golden Key
 */

const fs = require('fs');
const path = require('path');

function analyzePatterns() {
    const files = fs.readdirSync('debug')
        .filter(f => f.endsWith('.json'))
        .sort()
        .slice(-20); // Last 20 logs
    
    const patterns = {
        perfect: [], // All models agree + high certainty + oracle lock
        nearPerfect: [], // Most models agree + high certainty
        good: [], // Conviction tier
        risky: [] // Everything else
    };
    
    files.forEach(file => {
        try {
            const data = JSON.parse(fs.readFileSync(path.join('debug', file), 'utf8'));
            
            Object.values(data.assets || {}).forEach(asset => {
                (asset.cycleHistory || []).forEach(cycle => {
                    if (cycle.wasCorrect === undefined) return;
                    
                    const modelAgreement = cycle.modelAgreementHistory || [];
                    const allAgree = modelAgreement.length >= 3 && 
                        modelAgreement.every(v => v === modelAgreement[0] && v !== null);
                    const certainty = cycle.certaintyAtEnd || 0;
                    const oracleLocked = cycle.oracleWasLocked || false;
                    const tier = cycle.tier || 'NONE';
                    const confidence = cycle.confidence || 0;
                    
                    const pattern = {
                        asset,
                        wasCorrect: cycle.wasCorrect,
                        tier,
                        confidence,
                        certainty,
                        oracleLocked,
                        allModelsAgree: allAgree,
                        modelAgreement,
                        winStreak: cycle.winStreak || 0,
                        marketOdds: cycle.marketOdds
                    };
                    
                    // PERFECT: All models agree + high certainty + oracle lock
                    if (allAgree && certainty >= 75 && oracleLocked && tier === 'CONVICTION') {
                        patterns.perfect.push(pattern);
                    }
                    // NEAR PERFECT: All models agree + high certainty
                    else if (allAgree && certainty >= 70 && tier === 'CONVICTION') {
                        patterns.nearPerfect.push(pattern);
                    }
                    // GOOD: Conviction tier
                    else if (tier === 'CONVICTION') {
                        patterns.good.push(pattern);
                    }
                    // RISKY: Everything else
                    else {
                        patterns.risky.push(pattern);
                    }
                });
            });
        } catch (e) {
            console.error(`Error processing ${file}: ${e.message}`);
        }
    });
    
    // Calculate win rates
    const stats = {};
    Object.keys(patterns).forEach(key => {
        const arr = patterns[key];
        const wins = arr.filter(p => p.wasCorrect).length;
        const total = arr.length;
        stats[key] = {
            total,
            wins,
            winRate: total > 0 ? (wins / total * 100).toFixed(2) : '0.00',
            avgCertainty: total > 0 ? (arr.reduce((sum, p) => sum + (p.certainty || 0), 0) / total).toFixed(1) : '0'
        };
    });
    
    console.log('═══════════════════════════════════════════════════════');
    console.log('🔬 PATTERN ANALYSIS RESULTS');
    console.log('═══════════════════════════════════════════════════════\n');
    
    console.log('PERFECT PATTERN (All models agree + Certainty ≥75 + Oracle Lock + CONVICTION):');
    console.log(`  Total: ${stats.perfect.total}`);
    console.log(`  Wins: ${stats.perfect.wins}`);
    console.log(`  Win Rate: ${stats.perfect.winRate}%`);
    console.log(`  Avg Certainty: ${stats.perfect.avgCertainty}\n`);
    
    console.log('NEAR PERFECT (All models agree + Certainty ≥70 + CONVICTION):');
    console.log(`  Total: ${stats.nearPerfect.total}`);
    console.log(`  Wins: ${stats.nearPerfect.wins}`);
    console.log(`  Win Rate: ${stats.nearPerfect.winRate}%`);
    console.log(`  Avg Certainty: ${stats.nearPerfect.avgCertainty}\n`);
    
    console.log('GOOD (CONVICTION tier):');
    console.log(`  Total: ${stats.good.total}`);
    console.log(`  Wins: ${stats.good.wins}`);
    console.log(`  Win Rate: ${stats.good.winRate}%`);
    console.log(`  Avg Certainty: ${stats.good.avgCertainty}\n`);
    
    console.log('RISKY (Everything else):');
    console.log(`  Total: ${stats.risky.total}`);
    console.log(`  Wins: ${stats.risky.wins}`);
    console.log(`  Win Rate: ${stats.risky.winRate}%`);
    console.log(`  Avg Certainty: ${stats.risky.avgCertainty}\n`);
    
    // Show sample perfect patterns
    if (patterns.perfect.length > 0) {
        console.log('Sample PERFECT patterns:');
        patterns.perfect.slice(0, 5).forEach((p, i) => {
            console.log(`  ${i+1}. ${p.asset} | Certainty: ${p.certainty} | Oracle: ${p.oracleLocked} | Models: ${p.modelAgreement.join(',')} | Win: ${p.wasCorrect}`);
        });
    }
    
    return { patterns, stats };
}

if (require.main === module) {
    analyzePatterns();
}

module.exports = { analyzePatterns };

