/**
 * Finalize v5 strategy set with all required runtime fields:
 * - winRate (full-period)
 * - winRateLCB (lower confidence bound, Wilson)
 * - pWinEstimate (OOS WR - most recent estimate)
 * - evWinEstimate (OOS WR)
 * - asset ('all' or specific)
 * - id, name, signature, tier
 */
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');

const v5 = JSON.parse(fs.readFileSync(path.join(ROOT, 'strategies/strategy_set_15m_optimal_10usd_v5.json'), 'utf8'));

// Wilson lower confidence bound (95%)
function wilsonLCB(wins, n, z = 1.96) {
    if (n === 0) return 0;
    const p = wins / n;
    const denom = 1 + (z * z) / n;
    const center = p + (z * z) / (2 * n);
    const margin = z * Math.sqrt((p * (1 - p) + (z * z) / (4 * n)) / n);
    return Math.max(0, (center - margin) / denom);
}

// Enhance each strategy with full required fields
for (let i = 0; i < v5.strategies.length; i++) {
    const s = v5.strategies[i];
    const stats = s.stats || {};
    const full = stats.full || {};
    const oos = stats.oos || {};

    const fullTrades = full.trades || 0;
    const fullWins = Math.round((full.wr || 0) * fullTrades);
    const lcb = wilsonLCB(fullWins, fullTrades);

    // Use OOS WR as pWinEstimate (most recent, most predictive)
    const oosWR = oos.wr || 0;
    const fullWR = full.wr || 0;

    const enhanced = {
        id: `v5_${i + 1}`,
        name: `V5_H${String(s.utcHour).padStart(2, '0')}_m${s.entryMinute}_${s.direction}`,
        signature: `H${s.utcHour}|${s.entryMinute}|${s.direction}|${s.priceMin}|${s.priceMax}`,
        tier: oosWR >= 0.95 ? 'S' : oosWR >= 0.90 ? 'A' : oosWR >= 0.85 ? 'B' : 'C',
        asset: 'all',

        // Runtime-required fields
        utcHour: s.utcHour,
        entryMinute: s.entryMinute,
        direction: s.direction,
        priceMin: s.priceMin,
        priceMax: s.priceMax,
        priceBandLow: s.priceMin,
        priceBandHigh: s.priceMax,

        // Probability estimates (required by executor gate)
        winRate: fullWR,
        winRateLCB: lcb,
        pWinEstimate: oosWR > 0 ? oosWR : fullWR,    // use OOS as most recent
        evWinEstimate: oosWR > 0 ? oosWR : fullWR,

        // Stats for visibility
        stats: s.stats
    };

    v5.strategies[i] = enhanced;
}

// Add set-level metadata
v5.loadNotes = 'v5 - TRUE OOS validated. pWinEstimate = OOS WR (Apr 8-16 data). winRateLCB = Wilson 95% LCB over full 23-day sample.';
v5.dataRange = '2026-03-24 to 2026-04-16 (23 days, 8984 cycles)';
v5.buildDate = new Date().toISOString();

fs.writeFileSync(
    path.join(ROOT, 'strategies/strategy_set_15m_optimal_10usd_v5.json'),
    JSON.stringify(v5, null, 2)
);
console.log(`Finalized v5 set with ${v5.strategies.length} strategies`);
console.log('\nFirst 3 strategies (full shape):');
for (const s of v5.strategies.slice(0, 3)) {
    console.log(JSON.stringify({
        id: s.id, name: s.name, asset: s.asset,
        utcHour: s.utcHour, entryMinute: s.entryMinute, direction: s.direction,
        priceMin: s.priceMin, priceMax: s.priceMax,
        winRate: s.winRate, winRateLCB: s.winRateLCB.toFixed(3), pWinEstimate: s.pWinEstimate, tier: s.tier
    }));
}

// Verify against strategy-matcher normalization
const matcher = require(path.join(ROOT, 'lib/strategy-matcher.js'));
matcher.loadStrategySet('15m', 'strategies/strategy_set_15m_optimal_10usd_v5.json');
const loaded = matcher.getStrategySet('15m');
console.log(`\nMatcher loaded ${loaded.strategies.length} strategies, load error: ${loaded.loadError || 'none'}`);
if (loaded.strategies[0]) {
    const s = loaded.strategies[0];
    console.log('Sample normalized (runtime-ready):');
    console.log({
        id: s.id, name: s.name,
        utcHour: s.utcHour, entryMinute: s.entryMinute, direction: s.direction,
        pWinEstimate: s.pWinEstimate, evWinEstimate: s.evWinEstimate, winRate: s.winRate
    });
}
