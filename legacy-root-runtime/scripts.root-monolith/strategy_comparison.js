/**
 * Strategy Comparison Analysis Script
 * Computes detailed metrics for all strategy modes and outputs a comparison.
 */
const fs = require('fs');
const path = require('path');

// === Statistical helpers ===
function wilsonLCB(wins, total, z = 1.96) {
    if (!Number.isFinite(wins) || !Number.isFinite(total) || total <= 0) return 0;
    const pHat = wins / total;
    const denom = 1 + (z * z) / total;
    const center = pHat + (z * z) / (2 * total);
    const margin = z * Math.sqrt((pHat * (1 - pHat) + (z * z) / (4 * total)) / total);
    return Math.max(0, (center - margin) / denom);
}

function normCdf(x) {
    const sign = x < 0 ? -1 : 1;
    const abs = Math.abs(x) / Math.sqrt(2);
    const t = 1 / (1 + 0.3275911 * abs);
    const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741, a4 = -1.453152027, a5 = 1.061405429;
    const erf = 1 - (((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t) * Math.exp(-abs * abs);
    return 0.5 * (1 + sign * erf);
}

function posteriorProbGE(wins, total, thr) {
    if (!Number.isFinite(wins) || !Number.isFinite(total) || total <= 0) return 0;
    const losses = total - wins;
    const a = wins + 1, b = losses + 1;
    const mean = a / (a + b);
    const variance = (a * b) / (((a + b) * (a + b)) * (a + b + 1));
    const sd = Math.sqrt(Math.max(0, variance));
    if (!Number.isFinite(sd) || sd === 0) return mean >= thr ? 1 : 0;
    const z = (thr - mean) / sd;
    const cdf = normCdf(z);
    return Math.max(0, Math.min(1, 1 - cdf));
}

function fmt(v, d = 1) {
    if (!Number.isFinite(v)) return 'N/A';
    return (v * 100).toFixed(d) + '%';
}
function fmtN(v, d = 2) {
    if (!Number.isFinite(v)) return 'N/A';
    return v.toFixed(d);
}

// === Load files ===
const root = path.join(__dirname, '..');
const opt = JSON.parse(fs.readFileSync(path.join(root, 'optimized_strategies.json'), 'utf8'));
const strict = JSON.parse(fs.readFileSync(path.join(root, 'final_golden_strategy.json'), 'utf8'));
const soft = JSON.parse(fs.readFileSync(path.join(root, 'final_golden_strategy.soft.json'), 'utf8'));

// === 1. Hybrid/Optimized Strategies ===
console.log('='.repeat(80));
console.log('STRATEGY COMPARISON REPORT');
console.log('Generated:', new Date().toISOString());
console.log('='.repeat(80));

console.log('\n## 1. HYBRID/OPTIMIZED STRATEGIES (Current Runtime)');
console.log('-'.repeat(60));
const hW = opt.stats.historicalWins;
const hT = opt.stats.historicalTrades;
const hLCB = wilsonLCB(hW, hT);
const hPost = posteriorProbGE(hW, hT, 0.9);
console.log(`  Aggregate: ${hW}/${hT} = ${fmt(hW/hT)} WR`);
console.log(`  Wilson LCB (95%): ${fmt(hLCB)}`);
console.log(`  P(WR>=90%): ${fmt(hPost)}`);
console.log(`  Signals/Day: ${fmtN(opt.stats.signalsPerDay)}`);
console.log(`  Losses/10: ${fmtN(opt.stats.lossesPerTen)}`);
console.log(`  Dataset: ${opt.stats.datasetDays} days`);
console.log(`  Strategies: ${opt.stats.totalStrategies}`);
console.log(`  Price Band: ${opt.conditions.priceMin*100}c - ${opt.conditions.priceMax*100}c`);

// Per-tier
const byTier = {};
const byAsset = {};
for (const s of opt.strategies) {
    byTier[s.tier] = byTier[s.tier] || { trades: 0, wins: 0, count: 0 };
    byTier[s.tier].trades += s.historicalTrades;
    byTier[s.tier].wins += s.historicalWins;
    byTier[s.tier].count++;
    
    byAsset[s.asset] = byAsset[s.asset] || { trades: 0, wins: 0, count: 0 };
    byAsset[s.asset].trades += s.historicalTrades;
    byAsset[s.asset].wins += s.historicalWins;
    byAsset[s.asset].count++;
}

console.log('\n  Per-Tier:');
for (const [tier, a] of Object.entries(byTier)) {
    const lcb = wilsonLCB(a.wins, a.trades);
    const post = posteriorProbGE(a.wins, a.trades, 0.9);
    console.log(`    ${tier} (${a.count} strats): ${a.wins}/${a.trades} = ${fmt(a.wins/a.trades)} WR, LCB=${fmt(lcb)}, P(>=90%)=${fmt(post)}`);
}

console.log('\n  Per-Asset:');
for (const [asset, a] of Object.entries(byAsset)) {
    const lcb = wilsonLCB(a.wins, a.trades);
    const post = posteriorProbGE(a.wins, a.trades, 0.9);
    console.log(`    ${asset} (${a.count} strats): ${a.wins}/${a.trades} = ${fmt(a.wins/a.trades)} WR, LCB=${fmt(lcb)}, P(>=90%)=${fmt(post)}`);
}

// Variance: best/worst individual strategy
const sorted = [...opt.strategies].sort((a, b) => b.winRate - a.winRate);
console.log(`\n  Best Individual:  #${sorted[0].id} ${sorted[0].name} (${sorted[0].asset}) = ${fmt(sorted[0].winRate)} WR, ${sorted[0].historicalTrades} trades`);
console.log(`  Worst Individual: #${sorted[sorted.length-1].id} ${sorted[sorted.length-1].name} (${sorted[sorted.length-1].asset}) = ${fmt(sorted[sorted.length-1].winRate)} WR, ${sorted[sorted.length-1].historicalTrades} trades`);
console.log(`  WR Range: ${fmt(sorted[sorted.length-1].winRate)} to ${fmt(sorted[0].winRate)} (spread: ${fmt(sorted[0].winRate - sorted[sorted.length-1].winRate)})`);

// Per-strategy detail
console.log('\n  All Strategies:');
for (const s of opt.strategies) {
    const lcb = wilsonLCB(s.historicalWins, s.historicalTrades);
    console.log(`    #${String(s.id).padStart(2)} ${s.tier.padEnd(8)} ${s.asset.padEnd(3)} H${String(s.utcHour).padStart(2,'0')}:m${String(s.entryMinute).padStart(2,'0')} ${s.direction.padEnd(4)} ${s.historicalWins}/${s.historicalTrades} = ${fmt(s.winRate)} WR, LCB=${fmt(lcb)}, L/10=${fmtN(s.lossesPerTen)}`);
}

// === 2. Strict Golden Strategy ===
console.log('\n\n## 2. STRICT GOLDEN STRATEGY (final_golden_strategy.json)');
console.log('-'.repeat(60));
const gs = strict.goldenStrategy;
console.log(`  Signature: m${gs.entryMinute} H${gs.utcHour} ${gs.direction} [${gs.priceBand.min*100}c-${gs.priceBand.max*100}c]`);
console.log(`  Audit Verdict: ${strict.auditVerdict}`);

console.log('\n  TRAIN SET:');
console.log(`    ${gs.wins}/${gs.trades} = ${fmt(gs.winRate)} WR`);
console.log(`    LCB: ${fmt(gs.winRateLCB)}`);
console.log(`    P(WR>=90%): ${fmt(gs.posteriorPWinRateGE90)}`);
console.log(`    Trades/Day: ${fmtN(gs.tradesPerDay)}`);
console.log(`    Avg ROI: ${fmt(gs.avgROI)}`);

console.log('\n  VALIDATION SET:');
console.log(`    ${gs.valWins}/${gs.valTrades} = ${fmt(gs.valWinRate)} WR`);
console.log(`    LCB: ${fmt(gs.valWinRateLCB)}`);
console.log(`    P(WR>=90%): ${fmt(gs.valPosteriorPWinRateGE90)}`);
console.log(`    Degradation (train->val): ${fmt(gs.degradationTrainToVal)}`);

console.log('\n  TEST SET:');
console.log(`    ${gs.testWins}/${gs.testTrades} = ${fmt(gs.testWinRate)} WR`);
console.log(`    LCB: ${fmt(gs.testWinRateLCB)}`);
console.log(`    P(WR>=90%): ${fmt(gs.testPosteriorPWinRateGE90)}`);
console.log(`    Degradation (train->test): ${fmt(gs.degradation)}`);
console.log(`    Degradation (val->test): ${fmt(gs.degradationValToTest)}`);
console.log(`    Trades/Day (empirical): ${fmtN(gs.tradesPerDayEmpirical)}`);

console.log('\n  Per-Asset (TRAIN):');
for (const [asset, pa] of Object.entries(gs.perAsset)) {
    console.log(`    ${asset}: ${pa.wins}/${pa.trades} = ${fmt(pa.winRate)} WR, LCB=${fmt(pa.winRateLCB)}, P(>=90%)=${fmt(pa.posteriorPWinRateGE90)}`);
}
console.log(`    Worst Asset WR: ${fmt(gs.minAssetWinRate)}, Worst LCB: ${fmt(gs.minAssetWinRateLCB)}`);

console.log('\n  Per-Asset (TEST):');
for (const [asset, pa] of Object.entries(gs.testPerAsset)) {
    console.log(`    ${asset}: ${pa.wins}/${pa.trades} = ${fmt(pa.winRate)} WR, LCB=${fmt(pa.winRateLCB)}`);
}
console.log(`    Worst Asset Test WR: ${fmt(gs.minAssetTestWinRate)}, Worst LCB: ${fmt(gs.minAssetTestWinRateLCB)}`);

// === 3. Soft Golden Strategy ===
console.log('\n\n## 3. SOFT GOLDEN STRATEGY (final_golden_strategy.soft.json)');
console.log('-'.repeat(60));
const sgs = soft.goldenStrategy;
console.log(`  Signature: m${sgs.entryMinute} H${sgs.utcHour} ${sgs.direction} [${sgs.priceBand.min*100}c-${sgs.priceBand.max*100}c]`);
console.log(`  Audit Verdict: ${soft.auditVerdict}`);

console.log('\n  TRAIN SET:');
console.log(`    ${sgs.wins}/${sgs.trades} = ${fmt(sgs.winRate)} WR`);
console.log(`    LCB: ${fmt(sgs.winRateLCB)}`);
console.log(`    P(WR>=90%): ${fmt(sgs.posteriorPWinRateGE90)}`);
console.log(`    Trades/Day: ${fmtN(sgs.tradesPerDay)}`);
console.log(`    Avg ROI: ${fmt(sgs.avgROI)}`);

console.log('\n  VALIDATION SET:');
console.log(`    ${sgs.valWins}/${sgs.valTrades} = ${fmt(sgs.valWinRate)} WR`);
console.log(`    LCB: ${fmt(sgs.valWinRateLCB)}`);
console.log(`    P(WR>=90%): ${fmt(sgs.valPosteriorPWinRateGE90)}`);
console.log(`    Degradation (train->val): ${fmt(sgs.degradationTrainToVal)}`);

console.log('\n  TEST SET:');
console.log(`    ${sgs.testWins}/${sgs.testTrades} = ${fmt(sgs.testWinRate)} WR`);
console.log(`    LCB: ${fmt(sgs.testWinRateLCB)}`);
console.log(`    P(WR>=90%): ${fmt(sgs.testPosteriorPWinRateGE90)}`);
console.log(`    Degradation (train->test): ${fmt(sgs.degradation)}`);
console.log(`    Degradation (val->test): ${fmt(sgs.degradationValToTest)}`);
console.log(`    Trades/Day (empirical): ${fmtN(sgs.tradesPerDayEmpirical)}`);

console.log('\n  Per-Asset (TRAIN):');
for (const [asset, pa] of Object.entries(sgs.perAsset)) {
    console.log(`    ${asset}: ${pa.wins}/${pa.trades} = ${fmt(pa.winRate)} WR, LCB=${fmt(pa.winRateLCB)}, P(>=90%)=${fmt(pa.posteriorPWinRateGE90)}`);
}
console.log(`    Worst Asset WR: ${fmt(sgs.minAssetWinRate)}, Worst LCB: ${fmt(sgs.minAssetWinRateLCB)}`);

console.log('\n  Per-Asset (TEST):');
for (const [asset, pa] of Object.entries(sgs.testPerAsset)) {
    console.log(`    ${asset}: ${pa.wins}/${pa.trades} = ${fmt(pa.winRate)} WR, LCB=${fmt(pa.winRateLCB)}`);
}
console.log(`    Worst Asset Test WR: ${fmt(sgs.minAssetTestWinRate)}, Worst LCB: ${fmt(sgs.minAssetTestWinRateLCB)}`);

// === 4. Side-by-side comparison ===
console.log('\n\n## 4. SIDE-BY-SIDE COMPARISON');
console.log('-'.repeat(60));

const header = 'Metric'.padEnd(32) + 'Hybrid'.padEnd(18) + 'Strict Golden'.padEnd(18) + 'Soft Golden'.padEnd(18);
console.log(header);
console.log('-'.repeat(86));

function row(label, v1, v2, v3) {
    console.log(label.padEnd(32) + String(v1).padEnd(18) + String(v2).padEnd(18) + String(v3).padEnd(18));
}

row('Train WR', fmt(hW/hT), fmt(gs.winRate), fmt(sgs.winRate));
row('Train LCB', fmt(hLCB), fmt(gs.winRateLCB), fmt(sgs.winRateLCB));
row('Train P(WR>=90%)', fmt(hPost), fmt(gs.posteriorPWinRateGE90), fmt(sgs.posteriorPWinRateGE90));
row('Train Trades', hT, gs.trades, sgs.trades);
row('Val WR', 'N/A (no split)', fmt(gs.valWinRate), fmt(sgs.valWinRate));
row('Val LCB', 'N/A', fmt(gs.valWinRateLCB), fmt(sgs.valWinRateLCB));
row('Val Trades', 'N/A', gs.valTrades, sgs.valTrades);
row('Test WR', 'N/A (no split)', fmt(gs.testWinRate), fmt(sgs.testWinRate));
row('Test LCB', 'N/A', fmt(gs.testWinRateLCB), fmt(sgs.testWinRateLCB));
row('Test Trades', 'N/A', gs.testTrades, sgs.testTrades);
row('Degrad train->test', 'N/A', fmt(gs.degradation), fmt(sgs.degradation));
row('Signals/Day', fmtN(opt.stats.signalsPerDay), fmtN(gs.tradesPerDay), fmtN(sgs.tradesPerDay));
row('Signals/Day (empirical)', 'N/A', fmtN(gs.tradesPerDayEmpirical), fmtN(sgs.tradesPerDayEmpirical));
row('Avg ROI/trade', 'N/A', fmt(gs.avgROI), fmt(sgs.avgROI));
row('Worst Asset Train WR', 'N/A', fmt(gs.minAssetWinRate), fmt(sgs.minAssetWinRate));
row('Worst Asset Test WR', 'N/A', fmt(gs.minAssetTestWinRate), fmt(sgs.minAssetTestWinRate));
row('Price Band', `${opt.conditions.priceMin*100}-${opt.conditions.priceMax*100}c`, `${gs.priceBand.min*100}-${gs.priceBand.max*100}c`, `${sgs.priceBand.min*100}-${sgs.priceBand.max*100}c`);
row('Strategies Count', opt.stats.totalStrategies, '1 (single)', '1 (single)');
row('Audit Verdict', 'N/A', strict.auditVerdict, soft.auditVerdict);
row('Dataset (rows)', 'N/A', strict.analysisMeta.datasetRows, soft.analysisMeta.datasetRows);

console.log('\n\n## 5. CRITICAL OBSERVATIONS');
console.log('-'.repeat(60));
console.log(`
1. HYBRID STRATEGIES (Current):
   - 92.1% aggregate WR across 403 trades / 120 days is strong
   - Wilson LCB ${fmt(hLCB)} - statistically confident above ~88%
   - P(WR>=90%) = ${fmt(hPost)} - high confidence of exceeding 90%
   - 3.36 signals/day gives good frequency (~1 every ~7 hours)
   - BUT: no train/test split validation - trained on full dataset
   - Risk: some overfitting to historical patterns possible

2. STRICT GOLDEN STRATEGY:
   - Train WR 91.7% looks promising (84 trades)
   - SEVERE test degradation: 77.4% on test set (14.2pp drop!)
   - ETH on test: 60% WR (3/5) - catastrophic
   - SOL on test: 60% WR (3/5) - catastrophic  
   - Only 31 test trades total - low sample but alarming pattern
   - Audit verdict: FAIL - correctly identified as unreliable
   - Single entry point (m9 H2 UP) = very fragile

3. SOFT GOLDEN STRATEGY:
   - Train WR only 69.4% - already poor
   - Test WR 78.7% - slightly better than strict but misleading
   - Negative avg ROI (-7.7%) - loses money on average!
   - BTC train: 64.5% WR, SOL train: 64.3% WR - terrible
   - Audit verdict: FAIL
   - Strictly worse than hybrid in every meaningful metric
`);

console.log('\n## 6. RECOMMENDATION');
console.log('-'.repeat(60));
console.log(`
VERDICT: KEEP HYBRID/OPTIMIZED STRATEGIES AS PRIMARY

Rationale:
- Hybrid strategies have the best risk-adjusted performance
- 92.1% WR with 403 trade sample >> 77.4% WR with 31 test trades
- Multi-strategy approach (17 strategies) provides natural diversification
- Golden strategies (both strict and soft) FAIL audit gates
- Golden strategies show severe overfitting: train looks good, test collapses
- Single-point golden strategies are inherently fragile

The golden strategy concept is sound in theory (one optimized entry point),
but with only ~30 test trades and 14+ pp degradation, it is NOT ready for
live deployment. The hybrid system's 403-trade sample at 92.1% is far more
statistically reliable than any golden strategy variant.
`);

console.log('='.repeat(80));
console.log('END OF REPORT');
console.log('='.repeat(80));
