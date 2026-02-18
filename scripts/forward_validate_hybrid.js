/**
 * FORWARD VALIDATION: Test hybrid strategies against REAL recent Polymarket data
 * Fetches resolved markets from Gamma API for the last N days and checks
 * which hybrid strategy signals would have fired and whether they won.
 * 
 * Usage: node scripts/forward_validate_hybrid.js [days=4]
 */

const fs = require('fs');
const path = require('path');

const GAMMA_API = 'https://gamma-api.polymarket.com/markets';
const CLOB_API = 'https://clob.polymarket.com/prices-history';
const ASSETS = ['BTC', 'ETH', 'SOL', 'XRP'];
const CYCLE_SEC = 900;
const RATE_LIMIT_MS = 120;

// Load hybrid strategies
const strategiesFile = path.join(__dirname, '..', 'optimized_strategies.json');
const strategiesData = JSON.parse(fs.readFileSync(strategiesFile, 'utf8'));
const STRATEGIES = strategiesData.strategies;
const CONDITIONS = strategiesData.conditions;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function fetchJson(url, retries = 3) {
    for (let i = 0; i < retries; i++) {
        try {
            const resp = await fetch(url, {
                headers: { 'User-Agent': 'polyprophet-forward-test/1.0' },
                signal: AbortSignal.timeout(15000)
            });
            if (resp.ok) return await resp.json();
            if (resp.status === 429) { await sleep((i + 1) * 2000); continue; }
            if (resp.status === 404) return null;
        } catch (e) {
            if (i === retries - 1) console.error(`  Failed: ${url} - ${e.message}`);
            await sleep((i + 1) * 500);
        }
    }
    return null;
}

function epochToSlug(asset, epoch) {
    return `${asset.toLowerCase()}-updown-15m-${epoch}`;
}

function alignToEpoch(ts) {
    return ts - (ts % CYCLE_SEC);
}

async function main() {
    const DAYS = parseInt(process.argv[2]) || 4;
    const nowSec = Math.floor(Date.now() / 1000);
    const startSec = alignToEpoch(nowSec - (DAYS * 86400));
    const endSec = alignToEpoch(nowSec) - CYCLE_SEC; // Exclude current (unresolved) cycle

    console.log(`\n========================================`);
    console.log(`FORWARD VALIDATION: Hybrid Strategies`);
    console.log(`========================================`);
    console.log(`Period: ${new Date(startSec * 1000).toISOString()} to ${new Date(endSec * 1000).toISOString()}`);
    console.log(`Days: ${DAYS}`);
    console.log(`Strategies: ${STRATEGIES.length}`);
    console.log(`Price band: ${CONDITIONS.priceMin * 100}c - ${CONDITIONS.priceMax * 100}c`);
    console.log(`Momentum min: ${CONDITIONS.momentumMin * 100}%`);
    console.log(`Volume min: $${CONDITIONS.volumeMin}`);
    console.log(`========================================\n`);

    // For each strategy, find the cycles that match its hour and check them
    const results = [];
    let totalChecked = 0;
    let totalMatched = 0;
    let totalWins = 0;
    let totalLosses = 0;
    let totalSkippedUnresolved = 0;
    let totalSkippedNoPriceData = 0;
    let totalSkippedOutOfBand = 0;

    for (const strat of STRATEGIES) {
        console.log(`\n--- Strategy #${strat.id}: ${strat.name} (${strat.asset} ${strat.direction} H${strat.utcHour}:m${strat.entryMinute}) ---`);
        
        const stratResults = {
            id: strat.id,
            name: strat.name,
            asset: strat.asset,
            direction: strat.direction,
            utcHour: strat.utcHour,
            entryMinute: strat.entryMinute,
            tier: strat.tier,
            historicalWR: strat.winRate,
            forwardSignals: [],
            wins: 0,
            losses: 0,
            skippedOutOfBand: 0,
            skippedNoData: 0,
            skippedUnresolved: 0,
            cyclesChecked: 0
        };

        // Find all cycles at this UTC hour in the date range
        // Each hour has 4 cycles (00, 15, 30, 45)
        // The strategy's entryMinute tells us WHEN to enter within a cycle
        // But the cycle itself starts at :00, :15, :30, :45 of the hour
        
        // For each day in range, find cycles at the target UTC hour
        for (let dayStart = startSec; dayStart < endSec; dayStart += 86400) {
            // 4 cycles per hour: :00, :15, :30, :45
            for (let cycleOffset = 0; cycleOffset < 4; cycleOffset++) {
                const cycleEpoch = dayStart + (strat.utcHour * 3600) + (cycleOffset * CYCLE_SEC);
                if (cycleEpoch < startSec || cycleEpoch >= endSec) continue;

                const slug = epochToSlug(strat.asset, cycleEpoch);
                stratResults.cyclesChecked++;
                totalChecked++;

                // Fetch market data
                const data = await fetchJson(`${GAMMA_API}?slug=${encodeURIComponent(slug)}`);
                await sleep(RATE_LIMIT_MS);

                if (!data || (Array.isArray(data) && data.length === 0)) {
                    stratResults.skippedNoData++;
                    totalSkippedNoPriceData++;
                    continue;
                }

                const market = Array.isArray(data) ? data[0] : data;
                if (!market || !market.id) { stratResults.skippedNoData++; totalSkippedNoPriceData++; continue; }

                // Check if resolved
                let outcomePrices, outcomes, clobTokenIds;
                try {
                    outcomePrices = JSON.parse(market.outcomePrices || '[]');
                    outcomes = JSON.parse(market.outcomes || '[]');
                    clobTokenIds = JSON.parse(market.clobTokenIds || '[]');
                } catch {
                    outcomePrices = market.outcomePrices || [];
                    outcomes = market.outcomes || [];
                    clobTokenIds = market.clobTokenIds || [];
                }

                const p0 = Number(outcomePrices[0] || 0);
                const p1 = Number(outcomePrices[1] || 0);
                const isResolved = (p0 >= 0.99 && p1 <= 0.01) || (p0 <= 0.01 && p1 >= 0.99);

                if (!isResolved) {
                    stratResults.skippedUnresolved++;
                    totalSkippedUnresolved++;
                    continue;
                }

                // Determine winner
                const idx0Win = p0 >= 0.99;
                const o0 = String(outcomes[0] || '').toLowerCase();
                let resolvedOutcome;
                if (o0 === 'up') resolvedOutcome = idx0Win ? 'UP' : 'DOWN';
                else if (o0 === 'down') resolvedOutcome = idx0Win ? 'DOWN' : 'UP';
                else if (o0 === 'yes') resolvedOutcome = idx0Win ? 'UP' : 'DOWN';
                else resolvedOutcome = idx0Win ? 'UP' : 'DOWN';

                // Now fetch intracycle price data at entry minute
                if (clobTokenIds.length < 2) { stratResults.skippedNoData++; totalSkippedNoPriceData++; continue; }

                // Determine which token is UP vs DOWN
                const o0Lower = String(outcomes[0] || '').toLowerCase();
                const upTokenIdx = (o0Lower === 'up' || o0Lower === 'yes') ? 0 : 1;
                const downTokenIdx = 1 - upTokenIdx;
                const targetTokenIdx = strat.direction === 'UP' ? upTokenIdx : downTokenIdx;
                const tokenId = clobTokenIds[targetTokenIdx];

                const priceUrl = `${CLOB_API}?market=${tokenId}&startTs=${cycleEpoch}&endTs=${cycleEpoch + CYCLE_SEC}&fidelity=1`;
                const priceData = await fetchJson(priceUrl);
                await sleep(RATE_LIMIT_MS);

                if (!priceData || !priceData.history || priceData.history.length === 0) {
                    stratResults.skippedNoData++;
                    totalSkippedNoPriceData++;
                    continue;
                }

                // Find price at entry minute
                const entryMinStart = cycleEpoch + (strat.entryMinute * 60);
                const entryMinEnd = entryMinStart + 60;
                const entryTicks = priceData.history
                    .map(h => ({ t: h.t, p: Number(h.p) }))
                    .filter(t => t.t >= entryMinStart && t.t < entryMinEnd && t.p > 0 && t.p < 1);

                if (entryTicks.length === 0) {
                    // Try to get closest tick before entry minute end
                    const allTicks = priceData.history
                        .map(h => ({ t: h.t, p: Number(h.p) }))
                        .filter(t => t.t <= entryMinEnd && t.p > 0 && t.p < 1)
                        .sort((a, b) => b.t - a.t);
                    if (allTicks.length === 0) {
                        stratResults.skippedNoData++;
                        totalSkippedNoPriceData++;
                        continue;
                    }
                    // Use most recent tick before entry time
                    var entryPrice = allTicks[0].p;
                } else {
                    var entryPrice = entryTicks[entryTicks.length - 1].p; // Close of entry minute
                }

                // Check price band
                if (entryPrice < CONDITIONS.priceMin || entryPrice > CONDITIONS.priceMax) {
                    stratResults.skippedOutOfBand++;
                    totalSkippedOutOfBand++;
                    continue;
                }

                // We also need to check momentum - approximate from price trend
                const allTicksSorted = priceData.history
                    .map(h => ({ t: h.t, p: Number(h.p) }))
                    .filter(t => t.p > 0 && t.p < 1)
                    .sort((a, b) => a.t - b.t);

                let momentum = 0;
                if (allTicksSorted.length >= 2) {
                    const firstPrice = allTicksSorted[0].p;
                    momentum = (entryPrice - firstPrice) / Math.max(0.01, firstPrice);
                }

                // For now, we'll check signal regardless of momentum (to see raw opportunity)
                // But mark if momentum would have blocked it
                const momentumPasses = Math.abs(momentum) >= CONDITIONS.momentumMin;

                // Volume check (from market data)
                const volume = Number(market.volume || 0);
                const volumePasses = volume >= CONDITIONS.volumeMin;

                // Would signal have won?
                const won = (strat.direction === resolvedOutcome);

                const cycleTime = new Date(cycleEpoch * 1000).toISOString();
                const signalRecord = {
                    cycleEpoch,
                    cycleTime,
                    slug,
                    entryPrice: Math.round(entryPrice * 100) / 100,
                    resolvedOutcome,
                    direction: strat.direction,
                    won,
                    momentumPasses,
                    volumePasses,
                    allConditionsMet: momentumPasses && volumePasses,
                    volume: Math.round(volume),
                    momentum: Math.round(momentum * 10000) / 100
                };

                stratResults.forwardSignals.push(signalRecord);

                if (won) {
                    stratResults.wins++;
                    totalWins++;
                } else {
                    stratResults.losses++;
                    totalLosses++;
                }
                totalMatched++;

                const icon = won ? '✅' : '❌';
                const condIcon = signalRecord.allConditionsMet ? '🟢' : '🟡';
                console.log(`  ${icon} ${condIcon} ${cycleTime.substring(0, 16)} | ${strat.asset} ${strat.direction} @ ${(entryPrice * 100).toFixed(0)}c | Resolved: ${resolvedOutcome} | Vol: $${Math.round(volume)} | Mom: ${signalRecord.momentum}%`);
            }
        }

        const forwardWR = stratResults.forwardSignals.length > 0
            ? (stratResults.wins / stratResults.forwardSignals.length * 100).toFixed(1)
            : 'N/A';
        console.log(`  Summary: ${stratResults.wins}W / ${stratResults.losses}L = ${forwardWR}% WR | ${stratResults.skippedOutOfBand} out-of-band | ${stratResults.skippedNoData} no-data | ${stratResults.skippedUnresolved} unresolved`);

        results.push(stratResults);
    }

    // Final summary
    console.log(`\n\n========================================`);
    console.log(`FORWARD VALIDATION SUMMARY`);
    console.log(`========================================`);
    console.log(`Period: ${new Date(startSec * 1000).toISOString()} to ${new Date(endSec * 1000).toISOString()}`);
    console.log(`Total cycles checked: ${totalChecked}`);
    console.log(`Signals in-band (matched): ${totalMatched}`);
    console.log(`  Wins: ${totalWins}`);
    console.log(`  Losses: ${totalLosses}`);
    console.log(`  Forward Win Rate: ${totalMatched > 0 ? (totalWins / totalMatched * 100).toFixed(1) : 'N/A'}%`);
    console.log(`Skipped - out of price band: ${totalSkippedOutOfBand}`);
    console.log(`Skipped - no price data: ${totalSkippedNoPriceData}`);
    console.log(`Skipped - unresolved: ${totalSkippedUnresolved}`);
    console.log(`========================================`);

    // Per-strategy breakdown
    console.log(`\nPER-STRATEGY BREAKDOWN:`);
    console.log(`${'#'.padStart(3)} | ${'Name'.padEnd(28)} | ${'Asset'.padEnd(5)} | ${'Dir'.padEnd(4)} | ${'H'.padStart(2)}:${'m'.padStart(2)} | Hist WR | Fwd W/L | Fwd WR  | OOB`);
    console.log('-'.repeat(105));
    for (const r of results) {
        const fwdTotal = r.wins + r.losses;
        const fwdWR = fwdTotal > 0 ? (r.wins / fwdTotal * 100).toFixed(1) + '%' : 'N/A';
        console.log(`${String(r.id).padStart(3)} | ${r.name.padEnd(28)} | ${r.asset.padEnd(5)} | ${r.direction.padEnd(4)} | H${String(r.utcHour).padStart(2, '0')}:m${String(r.entryMinute).padStart(2, '0')} | ${(r.historicalWR * 100).toFixed(1)}%   | ${r.wins}W/${r.losses}L${' '.repeat(Math.max(0, 4 - String(r.wins).length - String(r.losses).length))} | ${fwdWR.padStart(7)} | ${r.skippedOutOfBand}`);
    }

    // All individual signals chronologically
    const allSignals = [];
    for (const r of results) {
        for (const sig of r.forwardSignals) {
            allSignals.push({ ...sig, stratId: r.id, stratName: r.name, asset: r.asset, tier: r.tier });
        }
    }
    allSignals.sort((a, b) => a.cycleEpoch - b.cycleEpoch);

    console.log(`\n\nCHRONOLOGICAL SIGNAL LOG (${allSignals.length} signals):`);
    console.log(`${'Time'.padEnd(17)} | ${'Asset'.padEnd(5)} | ${'Dir'.padEnd(4)} | ${'Entry'.padEnd(5)} | ${'Result'.padEnd(6)} | ${'Won'.padEnd(4)} | ${'AllCond'.padEnd(7)} | Strategy`);
    console.log('-'.repeat(100));
    for (const sig of allSignals) {
        const t = sig.cycleTime.substring(0, 16).replace('T', ' ');
        const icon = sig.won ? '✅' : '❌';
        const condIcon = sig.allConditionsMet ? '✅' : '⚠️';
        console.log(`${t} | ${sig.asset.padEnd(5)} | ${sig.direction.padEnd(4)} | ${(sig.entryPrice * 100).toFixed(0)}c${' '.repeat(2)} | ${sig.resolvedOutcome.padEnd(6)} | ${icon}   | ${condIcon}      | ${sig.stratName}`);
    }

    // Save results
    const outputPath = path.join(__dirname, '..', 'exhaustive_analysis', 'forward_validation_results.json');
    fs.writeFileSync(outputPath, JSON.stringify({
        generatedAt: new Date().toISOString(),
        period: {
            start: new Date(startSec * 1000).toISOString(),
            end: new Date(endSec * 1000).toISOString(),
            days: DAYS
        },
        summary: {
            totalCyclesChecked: totalChecked,
            signalsMatched: totalMatched,
            wins: totalWins,
            losses: totalLosses,
            forwardWinRate: totalMatched > 0 ? totalWins / totalMatched : null,
            skippedOutOfBand: totalSkippedOutOfBand,
            skippedNoData: totalSkippedNoPriceData,
            skippedUnresolved: totalSkippedUnresolved
        },
        strategies: results,
        chronologicalSignals: allSignals
    }, null, 2));
    console.log(`\nResults saved to: ${outputPath}`);
}

main().catch(e => {
    console.error('FATAL:', e);
    process.exit(1);
});
