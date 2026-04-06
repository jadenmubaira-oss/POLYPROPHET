#!/usr/bin/env node
/**
 * Build a maximally-dense 24h-coverage strategy optimized for 24-48h growth.
 * Picks the highest-WR entry for every UTC hour from recent data, 65-88c band only.
 */
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');

const ds = JSON.parse(fs.readFileSync(path.join(ROOT, 'exhaustive_analysis/decision_dataset.json'), 'utf8'));
const rows = Array.isArray(ds) ? ds : (ds.rows || []);
const rc = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/intracycle-price-data.json'), 'utf8'));
const recentCycles = rc.cycles || [];

const maxHistEpoch = rows.reduce((m, x) => Math.max(m, Number(x.cycleStartEpochSec) || 0), 0);
const histCutoff14d = maxHistEpoch - 14 * 86400;
const recentHist = rows.filter(r => Number(r.cycleStartEpochSec) >= histCutoff14d);

// Build stats for every hour/minute/direction combo in 65-88c band
const hmStats = {};
const hmKey = (h, m, d) => `H${String(h).padStart(2, '0')}_m${m}_${d}`;

for (const r of recentHist) {
    const h = Number(r.utcHour);
    const m = Number(r.entryMinute);
    const outcome = String(r.resolvedOutcome || '').toUpperCase();
    if (outcome !== 'UP' && outcome !== 'DOWN') continue;
    const upP = Number(r.upPrice);
    const dnP = Number(r.downPrice);

    if (upP >= 0.65 && upP <= 0.88) {
        const k = hmKey(h, m, 'UP');
        if (!hmStats[k]) hmStats[k] = { h, m, d: 'UP', wins: 0, losses: 0, prices: [] };
        if (outcome === 'UP') hmStats[k].wins++;
        else hmStats[k].losses++;
        hmStats[k].prices.push(upP);
    }
    if (dnP >= 0.65 && dnP <= 0.88) {
        const k = hmKey(h, m, 'DOWN');
        if (!hmStats[k]) hmStats[k] = { h, m, d: 'DOWN', wins: 0, losses: 0, prices: [] };
        if (outcome === 'DOWN') hmStats[k].wins++;
        else hmStats[k].losses++;
        hmStats[k].prices.push(dnP);
    }
}

// Also add recent intracycle data
const lastEpoch = recentCycles.length ? Math.max(...recentCycles.map(c => Number(c.epoch))) : 0;
const cutoff14d = lastEpoch - 14 * 86400;
const recent14d = recentCycles.filter(c => Number(c.epoch) >= cutoff14d);

for (const c of recent14d) {
    const epoch = Number(c.epoch);
    const h = new Date(epoch * 1000).getUTCHours();
    const res = String(c.resolution || '').toUpperCase();
    if (res !== 'UP' && res !== 'DOWN') continue;

    for (let m = 0; m <= 14; m++) {
        const yesData = c.minutePricesYes && c.minutePricesYes[m];
        const noData = c.minutePricesNo && c.minutePricesNo[m];

        if (yesData) {
            const ep = Number(yesData.last);
            if (ep >= 0.65 && ep <= 0.88) {
                const k = hmKey(h, m, 'UP');
                if (!hmStats[k]) hmStats[k] = { h, m, d: 'UP', wins: 0, losses: 0, prices: [] };
                if (res === 'UP') hmStats[k].wins++;
                else hmStats[k].losses++;
                hmStats[k].prices.push(ep);
            }
        }
        if (noData) {
            const ep = Number(noData.last);
            if (ep >= 0.65 && ep <= 0.88) {
                const k = hmKey(h, m, 'DOWN');
                if (!hmStats[k]) hmStats[k] = { h, m, d: 'DOWN', wins: 0, losses: 0, prices: [] };
                if (res === 'DOWN') hmStats[k].wins++;
                else hmStats[k].losses++;
                hmStats[k].prices.push(ep);
            }
        }
    }
}

// Rank all entries
const allEntries = Object.values(hmStats)
    .map(v => {
        const total = v.wins + v.losses;
        const wr = total > 0 ? v.wins / total : 0;
        const avgP = v.prices.length > 0 ? v.prices.reduce((s, p) => s + p, 0) / v.prices.length : 0;
        // Wilson lower bound for confidence
        const z = 1.96;
        const lcb = total > 0
            ? (wr + z * z / (2 * total) - z * Math.sqrt((wr * (1 - wr) + z * z / (4 * total)) / total)) / (1 + z * z / total)
            : 0;
        return { h: v.h, m: v.m, d: v.d, wins: v.wins, losses: v.losses, total, wr, lcb, avgP };
    })
    .filter(x => x.total >= 8 && x.lcb >= 0.60)
    .sort((a, b) => b.lcb - a.lcb || b.total - a.total);

// For 24h coverage: pick the BEST entry per hour (highest LCB), up to 2 per hour
const hourBest = new Map();
for (const e of allEntries) {
    const entries = hourBest.get(e.h) || [];
    if (entries.length < 2) {
        entries.push(e);
        hourBest.set(e.h, entries);
    }
}

const strategies = [];
for (let h = 0; h < 24; h++) {
    const entries = hourBest.get(h) || [];
    for (const e of entries) {
        strategies.push({
            name: `H${String(h).padStart(2, '0')} m${e.m} ${e.d} [65-88c]`,
            asset: 'ALL',
            utcHour: h,
            entryMinute: e.m,
            direction: e.d,
            priceMin: 0.65,
            priceMax: 0.88,
            pWinEstimate: Math.max(0.55, e.lcb),
            evWinEstimate: e.wr,
            source: 'build-24h-dense (14d recent data)',
            recentStats: { wins: e.wins, losses: e.losses, total: e.total, wr: e.wr, lcb: e.lcb, avgPrice: e.avgP }
        });
    }
}

const artifact = {
    version: '1.0-24h-dense',
    generatedAt: new Date().toISOString(),
    timeframe: '15m',
    startBalance: 10,
    description: '24h-dense strategy: maximum hour coverage for 24-48h growth. 65-88c band, up to 2 best entries per UTC hour based on 14d recent LCB.',
    config: { entryPriceBufferCents: 0, maxPerCycle: 7, stakeFraction: 0.15 },
    strategies,
    coverage: {
        hoursWithEntries: [...hourBest.keys()].sort((a, b) => a - b),
        hoursCovered: hourBest.size,
        totalStrategies: strategies.length,
        entriesPerHour: Object.fromEntries([...hourBest.entries()].sort((a, b) => a[0] - b[0]).map(([h, es]) => [h, es.length]))
    }
};

const outPath = path.join(ROOT, 'strategies', 'strategy_set_15m_24h_dense.json');
fs.writeFileSync(outPath, JSON.stringify(artifact, null, 2));
console.log(`Built ${strategies.length} strategies covering ${hourBest.size}/24 hours`);
console.log(`Saved to ${path.relative(ROOT, outPath)}`);
strategies.forEach(s => console.log(`  ${s.name} pWin=${s.pWinEstimate.toFixed(3)} wr=${s.evWinEstimate.toFixed(3)} (${s.recentStats.total} trades)`));
