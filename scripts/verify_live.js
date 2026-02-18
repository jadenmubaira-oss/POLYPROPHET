#!/usr/bin/env node
/**
 * verify_live.js
 * 
 * Takes the top robust strategies from find_robust_strategy.js and evaluates them
 * against the live forward validation data (API-fetched recent cycles).
 * 
 * This is the FINAL check: if a strategy holds up on train, val, test, AND live,
 * it's as validated as we can make it.
 */

const fs = require('fs');
const path = require('path');

const Z = 1.96;
function wilsonLCB(wins, n) {
    if (n === 0) return 0;
    const pHat = wins / n;
    const denom = 1 + (Z * Z) / n;
    const center = pHat + (Z * Z) / (2 * n);
    const margin = Z * Math.sqrt((pHat * (1 - pHat) + (Z * Z) / (4 * n)) / n);
    return (center - margin) / denom;
}

// Load robust search results
const robustPath = path.resolve(__dirname, '../exhaustive_analysis/robust_strategy_search.json');
const robust = JSON.parse(fs.readFileSync(robustPath, 'utf-8'));

// Load all live forward validation files
const liveFiles = [
    'forward_validation_results.reaudit.live14_vol.json',
    'forward_validation_results.reaudit.live4_vol.json'
];

const allLiveSignals = [];
const seenKeys = new Set();

for (const f of liveFiles) {
    try {
        const data = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../exhaustive_analysis', f), 'utf-8'));
        const signals = data.recentLive?.signals || [];
        for (const sig of signals) {
            // Deduplicate by unique key
            const key = `${sig.asset}|${sig.utcHour}|${sig.entryMinute}|${sig.direction}|${sig.cycleStart || sig.date}`;
            if (seenKeys.has(key)) continue;
            seenKeys.add(key);
            allLiveSignals.push(sig);
        }
    } catch (e) {
        console.log(`Could not load ${f}: ${e.message}`);
    }
}

console.log(`Loaded ${allLiveSignals.length} unique live signals from forward validation files`);
console.log(`Date range: ${allLiveSignals.map(s => s.date).filter(Boolean).sort()[0]} to ${allLiveSignals.map(s => s.date).filter(Boolean).sort().pop()}`);

// Show what live signals look like
if (allLiveSignals.length > 0) {
    console.log('\nSample live signal keys:', Object.keys(allLiveSignals[0]).join(', '));
    console.log('Sample:', JSON.stringify(allLiveSignals[0], null, 2).slice(0, 500));
}

// ========== EVALUATE STRATEGIES AGAINST LIVE DATA ==========
// Each strategy signature: entryMinute|utcHour|direction|priceMin|priceMax
// Live signals have: asset, utcHour, entryMinute, direction, entryPrice, won

const topStrategies = robust.robustStrategies.slice(0, 50);
console.log(`\nEvaluating ${topStrategies.length} robust strategies against ${allLiveSignals.length} live signals...\n`);

const results = [];

for (const strat of topStrategies) {
    const em = strat.entryMinute;
    const h = strat.utcHour;
    const dir = strat.direction;
    const pMin = strat.priceMin;
    const pMax = strat.priceMax;

    let liveMatches = 0, liveWins = 0, liveLosses = 0;
    const matchedSignals = [];

    for (const sig of allLiveSignals) {
        // Match hour and entry minute
        if (Number(sig.utcHour) !== h) continue;
        if (Number(sig.entryMinute) !== em) continue;
        
        // Match direction  
        const sigDir = String(sig.direction || '').toUpperCase();
        if (sigDir !== dir && sigDir !== 'BEST') continue;

        // Match price band
        const px = Number(sig.entryPrice);
        if (!Number.isFinite(px)) continue;
        if (px < pMin || px > pMax) continue;

        liveMatches++;
        if (sig.won) {
            liveWins++;
        } else {
            liveLosses++;
        }
        matchedSignals.push({
            asset: sig.asset,
            date: sig.date,
            price: px,
            won: sig.won,
            direction: sigDir
        });
    }

    const liveWR = liveMatches > 0 ? liveWins / liveMatches : null;
    const liveLCB = liveMatches > 0 ? wilsonLCB(liveWins, liveMatches) : 0;

    results.push({
        signature: strat.signature,
        entryMinute: em,
        utcHour: h,
        direction: dir,
        priceMin: pMin,
        priceMax: pMax,
        val: strat.val,
        test: strat.test,
        oos: strat.oos,
        live: {
            matches: liveMatches,
            wins: liveWins,
            losses: liveLosses,
            wr: liveWR,
            lcb: liveLCB,
            signals: matchedSignals
        },
        // Combined ALL out-of-sample: val + test + live
        allOOS: {
            trades: strat.oos.trades + liveMatches,
            wins: strat.oos.wins + liveWins,
            wr: (strat.oos.trades + liveMatches) > 0 ? (strat.oos.wins + liveWins) / (strat.oos.trades + liveMatches) : null,
            lcb: (strat.oos.trades + liveMatches) > 0 ? wilsonLCB(strat.oos.wins + liveWins, strat.oos.trades + liveMatches) : 0
        }
    });
}

// Sort by combined all-OOS LCB
results.sort((a, b) => b.allOOS.lcb - a.allOOS.lcb);

// ========== REPORT ==========
console.log('='.repeat(130));
console.log('STRATEGY PERFORMANCE: VAL + TEST + LIVE (sorted by all-OOS Wilson LCB)');
console.log('='.repeat(130));
console.log('Rank | Signature              | Val(t/WR%)       | Test(t/WR%)      | Live(t/w/WR%)     | All-OOS(t/w/WR%/LCB%)');
console.log('-'.repeat(130));

for (let i = 0; i < Math.min(30, results.length); i++) {
    const r = results[i];
    const v = r.val;
    const t = r.test;
    const l = r.live;
    const a = r.allOOS;
    console.log(
        `#${String(i+1).padStart(2)} | ${r.signature.padEnd(22)} | ` +
        `${String(v.trades).padStart(3)}t/${(v.wr*100).toFixed(1).padStart(5)}% | ` +
        `${String(t.trades).padStart(3)}t/${(t.wr*100).toFixed(1).padStart(5)}% | ` +
        `${String(l.matches).padStart(3)}t/${String(l.wins).padStart(2)}w/${l.wr !== null ? (l.wr*100).toFixed(1).padStart(5) : '  N/A'}% | ` +
        `${String(a.trades).padStart(3)}t/${String(a.wins).padStart(3)}w/${(a.wr*100).toFixed(1).padStart(5)}%/LCB=${(a.lcb*100).toFixed(1)}%`
    );
}

// Show live signal details for strategies with live matches
console.log('\n' + '='.repeat(100));
console.log('LIVE SIGNAL DETAILS FOR STRATEGIES WITH MATCHES');
console.log('='.repeat(100));

for (const r of results) {
    if (r.live.matches > 0) {
        console.log(`\n${r.signature}: ${r.live.matches} live matches (${r.live.wins}W/${r.live.losses}L)`);
        for (const s of r.live.signals) {
            console.log(`  ${s.date} ${s.asset} ${s.direction} @${(s.price*100).toFixed(1)}c → ${s.won ? 'WIN' : 'LOSS'}`);
        }
    }
}

// ========== FIND BEST ENSEMBLE WITH LIVE CONFIRMATION ==========
console.log('\n' + '='.repeat(100));
console.log('STRATEGIES WITH LIVE CONFIRMATION (live matches > 0, live WR >= 70%)');
console.log('='.repeat(100));

const liveConfirmed = results.filter(r => r.live.matches >= 2 && r.live.wr >= 0.70);
liveConfirmed.sort((a, b) => b.allOOS.lcb - a.allOOS.lcb);

if (liveConfirmed.length === 0) {
    console.log('No strategies have >= 2 live matches with >= 70% WR.');
    console.log('\nStrategies with ANY live matches:');
    const anyLive = results.filter(r => r.live.matches > 0);
    for (const r of anyLive) {
        console.log(`  ${r.signature}: live=${r.live.matches}t/${r.live.wins}w/${r.live.wr !== null ? (r.live.wr*100).toFixed(1) : 'NA'}% allOOS=${r.allOOS.trades}t/${(r.allOOS.wr*100).toFixed(1)}%/LCB=${(r.allOOS.lcb*100).toFixed(1)}%`);
    }
} else {
    for (const r of liveConfirmed) {
        console.log(`  ${r.signature}: live=${r.live.matches}t/${r.live.wins}w/${(r.live.wr*100).toFixed(1)}% | allOOS=${r.allOOS.trades}t/${r.allOOS.wins}w/${(r.allOOS.wr*100).toFixed(1)}%/LCB=${(r.allOOS.lcb*100).toFixed(1)}%`);
    }
}

// ========== SAVE ==========
const outPath = path.resolve(__dirname, '../exhaustive_analysis/robust_strategy_live_verified.json');
fs.writeFileSync(outPath, JSON.stringify({
    generatedAt: new Date().toISOString(),
    methodology: 'Top 50 robust strategies (val+test validated) checked against live forward data. allOOS = val + test + live combined.',
    liveSignalsCount: allLiveSignals.length,
    results: results.slice(0, 50),
    liveConfirmed,
    summary: {
        totalEvaluated: results.length,
        withLiveMatches: results.filter(r => r.live.matches > 0).length,
        liveConfirmedCount: liveConfirmed.length
    }
}, null, 2));
console.log(`\nSaved to: ${outPath}`);
