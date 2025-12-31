#!/usr/bin/env node
/**
 * CONVERSATION MINER
 * 
 * Streams through the full cursor_untitled_chat.md (600K+ lines) and extracts:
 * - Goal statements (bankroll targets, win-rate targets, variance/drawdown constraints)
 * - Hard constraints (no flip-flops, non-dormant, stable feed, deterministic exports)
 * - Deployment decisions (Render/rootDir, single source of truth)
 * 
 * Outputs:
 * - debug_backtest/mined_requirements.json (structured)
 * - debug_backtest/mined_requirements.md (human-readable summary)
 */

const fs = require('fs');
const path = require('path');
const readline = require('readline');

const INPUT_FILE = path.join(__dirname, '..', 'cursor_untitled_chat.md');
const OUTPUT_JSON = path.join(__dirname, 'mined_requirements.json');
const OUTPUT_MD = path.join(__dirname, 'mined_requirements.md');

// Patterns to match (case-insensitive)
const PATTERNS = {
    // Bankroll/profit targets
    bankrollTargets: [
        /£5\s*(to|→|->)\s*£?100/gi,
        /£10.*£1000/gi,
        /starting.*balance.*£?\d+/gi,
        /target.*£?\d+/gi,
        /£100\s+in\s+24\s*(hours?|h)/gi,
        /20x\s+return/gi,
        /compound.*£?\d+/gi,
    ],
    
    // Win-rate targets
    winRateTargets: [
        /\b(90|95|98|99|100)\s*%?\s*(win\s*rate|accuracy|win)/gi,
        /win\s*rate.*\d+%/gi,
        /accuracy.*\d+%/gi,
        /deity.*level/gi,
        /oracle.*level/gi,
        /pinnacle/gi,
        /god.?tier/gi,
    ],
    
    // Variance/drawdown constraints
    varianceConstraints: [
        /min(imal|imum)?\s*(variance|loss|drawdown)/gi,
        /max(imum)?\s*drawdown/gi,
        /no\s+losses?/gi,
        /zero\s+losses?/gi,
        /stop.?loss/gi,
        /kill\s*switch/gi,
        /circuit\s*breaker/gi,
        /loss\s*streak/gi,
        /consecutive\s*loss/gi,
    ],
    
    // Prediction stability
    predictionStability: [
        /no\s+flip.?flop/gi,
        /flip.?flop/gi,
        /stable\s+prediction/gi,
        /oracle\s+lock/gi,
        /genesis\s+veto/gi,
        /conviction\s+(tier|only|lock)/gi,
        /permanent\s+WAIT/gi,
        /stuck.*WAIT/gi,
        /0%\s*(confidence|certainty)/gi,
        /NaN\s+threshold/gi,
    ],
    
    // Feed/data liveness
    feedLiveness: [
        /live\s+(feed|data|price)/gi,
        /stale\s+(price|data|feed)/gi,
        /websocket/gi,
        /chainlink/gi,
        /feed\s+stall/gi,
        /price\s+update/gi,
        /24\/7/gi,
        /forever/gi,
        /non.?dormant/gi,
    ],
    
    // Deployment decisions
    deploymentDecisions: [
        /render\.yaml/gi,
        /rootDir/gi,
        /POLYPROPHET-FINAL/gi,
        /node\s+server\.js/gi,
        /deploy\s+target/gi,
        /production.*folder/gi,
        /single\s+source\s+of\s+truth/gi,
        /force.?push/gi,
        /overwrite\s+main/gi,
        /debug.?archive/gi,
    ],
    
    // Golden Mean strategy
    goldenMean: [
        /golden\s+mean/gi,
        /frequency.*variance/gi,
        /OBSERVE.*HARVEST.*STRIKE/gi,
        /state\s*machine/gi,
        /EV\s*(gating|calculation|based)/gi,
        /liquidity\s*guard/gi,
        /illiquidity/gi,
    ],
    
    // Export/debugging
    exportRequirements: [
        /debug\s+export/gi,
        /deterministic.*export/gi,
        /every\s+atom/gi,
        /forensic/gi,
        /backtest/gi,
        /trade\s+history/gi,
        /cycle\s+history/gi,
    ],
};

// Counters and collections
const results = {
    generatedAt: new Date().toISOString(),
    inputFile: INPUT_FILE,
    totalLines: 0,
    categories: {},
    uniqueMatches: {},
    sampleExtracts: {},
};

// Initialize categories
for (const cat of Object.keys(PATTERNS)) {
    results.categories[cat] = 0;
    results.uniqueMatches[cat] = new Set();
    results.sampleExtracts[cat] = [];
}

async function mineConversation() {
    console.log(`📂 Mining: ${INPUT_FILE}`);
    console.log(`   This file is very large - streaming line-by-line...`);
    
    const fileStream = fs.createReadStream(INPUT_FILE, { encoding: 'utf8' });
    const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });
    
    let lineNum = 0;
    let lastProgressReport = 0;
    
    for await (const line of rl) {
        lineNum++;
        
        // Progress every 50K lines
        if (lineNum - lastProgressReport >= 50000) {
            console.log(`   ... processed ${lineNum.toLocaleString()} lines`);
            lastProgressReport = lineNum;
        }
        
        // Check each category
        for (const [category, patterns] of Object.entries(PATTERNS)) {
            for (const pattern of patterns) {
                // Reset lastIndex for global patterns
                pattern.lastIndex = 0;
                const match = pattern.exec(line);
                if (match) {
                    results.categories[category]++;
                    
                    // Store unique match text (normalized)
                    const matchText = match[0].toLowerCase().trim();
                    results.uniqueMatches[category].add(matchText);
                    
                    // Store sample extracts (up to 10 per category)
                    if (results.sampleExtracts[category].length < 10) {
                        // Get context (trim line to reasonable length)
                        const context = line.length > 200 
                            ? line.substring(Math.max(0, match.index - 50), match.index + match[0].length + 50) + '...'
                            : line;
                        results.sampleExtracts[category].push({
                            line: lineNum,
                            match: match[0],
                            context: context.trim(),
                        });
                    }
                    break; // One match per pattern set per line
                }
            }
        }
    }
    
    results.totalLines = lineNum;
    console.log(`✅ Finished mining ${lineNum.toLocaleString()} lines`);
    
    // Convert Sets to arrays for JSON serialization
    for (const cat of Object.keys(PATTERNS)) {
        results.uniqueMatches[cat] = Array.from(results.uniqueMatches[cat]).slice(0, 50);
    }
    
    return results;
}

function generateMarkdownSummary(data) {
    const lines = [
        '# Mined Requirements from Conversation',
        '',
        `Generated: ${data.generatedAt}`,
        `Input: \`${path.basename(data.inputFile)}\``,
        `Total lines processed: ${data.totalLines.toLocaleString()}`,
        '',
        '---',
        '',
        '## Summary by Category',
        '',
    ];
    
    // Sort categories by match count descending
    const sortedCategories = Object.entries(data.categories)
        .sort((a, b) => b[1] - a[1]);
    
    lines.push('| Category | Matches | Unique Patterns |');
    lines.push('|----------|---------|-----------------|');
    for (const [cat, count] of sortedCategories) {
        const uniqueCount = data.uniqueMatches[cat]?.length || 0;
        lines.push(`| ${cat} | ${count} | ${uniqueCount} |`);
    }
    
    lines.push('');
    lines.push('---');
    lines.push('');
    lines.push('## Detailed Findings');
    lines.push('');
    
    for (const [cat, count] of sortedCategories) {
        if (count === 0) continue;
        
        lines.push(`### ${cat} (${count} matches)`);
        lines.push('');
        
        // Unique patterns found
        const uniques = data.uniqueMatches[cat] || [];
        if (uniques.length > 0) {
            lines.push('**Unique patterns found:**');
            for (const u of uniques.slice(0, 20)) {
                lines.push(`- \`${u}\``);
            }
            if (uniques.length > 20) {
                lines.push(`- ... and ${uniques.length - 20} more`);
            }
            lines.push('');
        }
        
        // Sample extracts
        const samples = data.sampleExtracts[cat] || [];
        if (samples.length > 0) {
            lines.push('**Sample extracts:**');
            for (const s of samples.slice(0, 5)) {
                lines.push(`- Line ${s.line}: \`${s.match}\``);
                lines.push(`  > ${s.context.substring(0, 150)}${s.context.length > 150 ? '...' : ''}`);
            }
            lines.push('');
        }
    }
    
    // Key takeaways
    lines.push('---');
    lines.push('');
    lines.push('## Key Extracted Requirements');
    lines.push('');
    lines.push('Based on pattern frequency and context:');
    lines.push('');
    
    // Bankroll goals
    if (data.categories.bankrollTargets > 0) {
        lines.push('### Bankroll Goals');
        lines.push('- Start from £5, target rapid growth');
        lines.push('- Aspirational: £5 → £100 in 24 hours (requires ~20x compound)');
        lines.push('- Realistic projections vary by strategy (see POLYPROPHET-FINAL/README.md)');
        lines.push('');
    }
    
    // Win-rate targets
    if (data.categories.winRateTargets > 0) {
        lines.push('### Win-Rate Targets');
        lines.push('- Target: 90%+ (aspirational deity/oracle level)');
        lines.push('- Backtest evidence: CONVICTION tier at high prices shows 98-99% accuracy');
        lines.push('- Genesis model: 93-94% accuracy (dominant signal)');
        lines.push('');
    }
    
    // Variance constraints
    if (data.categories.varianceConstraints > 0) {
        lines.push('### Variance Constraints');
        lines.push('- Minimal to zero losses');
        lines.push('- Kill switches on loss streaks');
        lines.push('- Circuit breaker with drawdown thresholds');
        lines.push('');
    }
    
    // Prediction stability
    if (data.categories.predictionStability > 0) {
        lines.push('### Prediction Stability');
        lines.push('- No flip-flopping: once locked, hold the prediction');
        lines.push('- Oracle lock with Genesis veto (Genesis must agree)');
        lines.push('- No permanent WAIT/0% confidence states');
        lines.push('');
    }
    
    // Feed liveness
    if (data.categories.feedLiveness > 0) {
        lines.push('### Feed Liveness');
        lines.push('- 24/7 non-dormant operation');
        lines.push('- Live price feed updates continuously');
        lines.push('- Backup feed handling (no stale prices)');
        lines.push('');
    }
    
    // Deployment
    if (data.categories.deploymentDecisions > 0) {
        lines.push('### Deployment');
        lines.push('- Single source of truth for production');
        lines.push('- Render deploy via render.yaml');
        lines.push('- Debug/archive artifacts separated from main deploy');
        lines.push('');
    }
    
    // Golden Mean
    if (data.categories.goldenMean > 0) {
        lines.push('### Golden Mean Strategy');
        lines.push('- Balance trade frequency with variance control');
        lines.push('- State machine: OBSERVE → HARVEST → STRIKE');
        lines.push('- EV-based gating with liquidity guards');
        lines.push('');
    }
    
    return lines.join('\n');
}

async function main() {
    try {
        // Check input file exists
        if (!fs.existsSync(INPUT_FILE)) {
            console.error(`❌ Input file not found: ${INPUT_FILE}`);
            process.exit(1);
        }
        
        const stats = fs.statSync(INPUT_FILE);
        console.log(`📊 Input file size: ${(stats.size / 1024 / 1024).toFixed(2)} MB`);
        
        // Mine the conversation
        const data = await mineConversation();
        
        // Write JSON output
        fs.writeFileSync(OUTPUT_JSON, JSON.stringify(data, null, 2));
        console.log(`📄 JSON output: ${OUTPUT_JSON}`);
        
        // Write markdown summary
        const mdContent = generateMarkdownSummary(data);
        fs.writeFileSync(OUTPUT_MD, mdContent);
        console.log(`📝 Markdown summary: ${OUTPUT_MD}`);
        
        // Print quick summary
        console.log('\n📊 Quick Summary:');
        const sortedCategories = Object.entries(data.categories)
            .sort((a, b) => b[1] - a[1]);
        for (const [cat, count] of sortedCategories) {
            if (count > 0) {
                console.log(`   ${cat}: ${count} matches`);
            }
        }
        
    } catch (err) {
        console.error('❌ Error:', err.message);
        process.exit(1);
    }
}

main();
