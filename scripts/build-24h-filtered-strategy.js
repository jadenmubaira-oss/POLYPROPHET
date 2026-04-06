#!/usr/bin/env node
/**
 * Build a filtered 24h strategy using only the highest-LCB entries.
 * Goal: reduce bust rate while maintaining hour coverage.
 */
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');

const dense = JSON.parse(fs.readFileSync(path.join(ROOT, 'strategies/strategy_set_15m_24h_dense.json'), 'utf8'));
const strategies = dense.strategies;

// Filter: only keep strategies with LCB >= 0.78 AND WR >= 0.85
const filtered = strategies.filter(s => {
    const stats = s.recentStats || {};
    return stats.lcb >= 0.78 && stats.wr >= 0.85;
});

// If some hours lost both entries, try to pick at least ONE per hour with lcb >= 0.74
const hourCoverage = new Set(filtered.map(s => Number(s.utcHour)));
const fallback = strategies.filter(s => {
    const stats = s.recentStats || {};
    return !hourCoverage.has(Number(s.utcHour)) && stats.lcb >= 0.74 && stats.wr >= 0.83;
});

const final = [...filtered, ...fallback];
const finalHours = new Set(final.map(s => Number(s.utcHour)));

const artifact = {
    version: '1.0-24h-filtered',
    generatedAt: new Date().toISOString(),
    timeframe: '15m',
    description: '24h-filtered: only highest-LCB strategies from 24h-dense (LCB>=0.78, WR>=0.85, fallback LCB>=0.74 WR>=0.83 for missing hours)',
    config: { entryPriceBufferCents: 0, maxPerCycle: 7, stakeFraction: 0.15 },
    strategies: final,
    coverage: {
        hoursCovered: finalHours.size,
        hoursWithEntries: [...finalHours].sort((a, b) => a - b),
        totalStrategies: final.length,
        filteredCount: filtered.length,
        fallbackCount: fallback.length
    }
};

const outPath = path.join(ROOT, 'strategies', 'strategy_set_15m_24h_filtered.json');
fs.writeFileSync(outPath, JSON.stringify(artifact, null, 2));
console.log(`Built ${final.length} strategies covering ${finalHours.size}/24 hours`);
console.log(`Filtered: ${filtered.length}, Fallback: ${fallback.length}`);
final.forEach(s => console.log(`  ${s.name} lcb=${s.recentStats?.lcb?.toFixed(3)} wr=${s.recentStats?.wr?.toFixed(3)}`));
