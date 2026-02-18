#!/usr/bin/env node
/**
 * live_check_robust.js
 * 
 * Fetches REAL post-dataset resolved cycles from Polymarket API and checks
 * the top robust strategies against them. This is the ultimate out-of-sample test.
 * 
 * Strategies are cross-asset: each signature fires on ALL 4 assets.
 */

const fs = require('fs');
const path = require('path');

const ASSETS = ['BTC', 'ETH', 'SOL', 'XRP'];
const CYCLE_SEC = 900; // 15 min
const GAMMA_API = 'https://gamma-api.polymarket.com/markets';
const CLOB_API = 'https://clob.polymarket.com/prices-history';
const argv = process.argv.slice(2);
const LIVE_DAYS = parseInt(argv.find(a => a.startsWith('--days='))?.split('=')[1] || '10', 10);
const IN_ARG = argv.find(a => a.startsWith('--in='))?.split('=')[1] || null;
const OUT_ARG = argv.find(a => a.startsWith('--out='))?.split('=')[1] || null;
const MAX_STRATEGIES = parseInt(argv.find(a => a.startsWith('--maxStrategies='))?.split('=')[1] || '15', 10);
const NON_OVERLAP = argv.find(a => a.startsWith('--nonOverlap='))?.split('=')[1] || 'emhd';
const MAX_MINUTES = parseInt(argv.find(a => a.startsWith('--maxMinutes='))?.split('=')[1] || '0', 10);
const Z = 1.96;

if (MAX_MINUTES > 0) {
    setTimeout(() => {
        console.error(`Fatal: live_check_robust exceeded max runtime (${MAX_MINUTES} minutes)`);
        process.exit(2);
    }, MAX_MINUTES * 60 * 1000);
}

function wilsonLCB(wins, n) {
    if (n === 0) return 0;
    const pHat = wins / n;
    const denom = 1 + (Z * Z) / n;
    const center = pHat + (Z * Z) / (2 * n);
    const margin = Z * Math.sqrt((pHat * (1 - pHat) + (Z * Z) / (4 * n)) / n);
    return (center - margin) / denom;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function fetchJson(url, retries = 3) {
    for (let i = 0; i < retries; i++) {
        try {
            const resp = await fetch(url, {
                headers: { 'User-Agent': 'polyprophet-robust/1.0' },
                signal: AbortSignal.timeout(15000)
            });
            if (resp.ok) return await resp.json();
            if (resp.status === 429) { await sleep(3000); continue; }
            if (resp.status === 404) return null;
        } catch (e) {
            await sleep(1000);
        }
    }
    return null;
}

// Load top robust strategies
const robustPath = IN_ARG ? path.resolve(process.cwd(), IN_ARG) : path.resolve(__dirname, '../exhaustive_analysis/robust_strategy_search.json');
const robust = JSON.parse(fs.readFileSync(robustPath, 'utf-8'));

// Take top 15 non-overlapping strategies (different em|h|dir combos)
const usedSlots = new Set();
const strategies = [];
for (const s of robust.robustStrategies) {
    const slot = NON_OVERLAP === 'emh' ? `${s.entryMinute}|${s.utcHour}` : `${s.entryMinute}|${s.utcHour}|${s.direction}`;
    if (usedSlots.has(slot)) continue;
    usedSlots.add(slot);
    strategies.push(s);
    if (strategies.length >= MAX_STRATEGIES) break;
}

console.log(`Testing ${strategies.length} robust strategies against last ${LIVE_DAYS} days of LIVE Polymarket data`);
console.log('Strategies:');
for (const s of strategies) {
    console.log(`  ${s.signature} | OOS: ${s.oos.trades}t/${s.oos.wins}w/${(s.oos.wr*100).toFixed(1)}% LCB=${(s.oos.lcb*100).toFixed(1)}%`);
}

async function main() {
    const nowSec = Math.floor(Date.now() / 1000);
    const nowDayStartSec = nowSec - (nowSec % 86400);
    const startSec = nowDayStartSec - ((LIVE_DAYS - 1) * 86400);
    const endSec = nowSec - CYCLE_SEC; // exclude current cycle

    console.log(`\nTime range: ${new Date(startSec * 1000).toISOString()} to ${new Date(endSec * 1000).toISOString()}`);

    let totalChecked = 0, totalMatched = 0, totalWins = 0, totalLosses = 0;
    let totalOOB = 0, totalNoData = 0, totalUnresolved = 0;
    const allSignals = [];
    const daily = {};
    const perStrategy = {};

    const getDayKey = (epochSec) => new Date(epochSec * 1000).toISOString().slice(0, 10);
    const ensureDay = (dayKey) => {
        if (!daily[dayKey]) daily[dayKey] = { checked: 0, matched: 0, wins: 0, losses: 0, oob: 0, noData: 0, unresolved: 0 };
        return daily[dayKey];
    };

    function extractEntryPrice(priceData, entryMinStart, entryMinEnd) {
        if (!priceData?.history?.length) return null;
        const ticks = priceData.history.map(h => ({ t: h.t, p: Number(h.p) })).filter(t => t.p > 0 && t.p < 1);
        if (!ticks.length) return null;
        const entryTicks = ticks.filter(t => t.t >= entryMinStart && t.t < entryMinEnd);
        if (entryTicks.length > 0) return entryTicks[entryTicks.length - 1].p;
        const before = ticks.filter(t => t.t <= entryMinEnd).sort((a, b) => b.t - a.t);
        if (before.length > 0) return before[0].p;
        return null;
    }

    for (const strat of strategies) {
        const stratKey = strat.signature;
        perStrategy[stratKey] = { trades: 0, wins: 0, losses: 0, signals: [] };

        for (const asset of ASSETS) {
            // For each day and each cycle within the strategy's hour
            for (let dayOffset = 0; dayOffset < LIVE_DAYS + 1; dayOffset++) {
                const dayBase = (nowDayStartSec - ((LIVE_DAYS - 1) * 86400)) + (dayOffset * 86400);

                // 4 cycles per hour at :00, :15, :30, :45
                for (let c = 0; c < 4; c++) {
                    const cycleEpoch = dayBase + (strat.utcHour * 3600) + (c * CYCLE_SEC);
                    if (cycleEpoch < startSec || cycleEpoch >= endSec) continue;

                    const d = ensureDay(getDayKey(cycleEpoch));
                    d.checked++;
                    totalChecked++;

                    const slug = `${asset.toLowerCase()}-updown-15m-${cycleEpoch}`;
                    const data = await fetchJson(`${GAMMA_API}?slug=${encodeURIComponent(slug)}`);
                    await sleep(80);

                    if (!data || (Array.isArray(data) && data.length === 0)) { totalNoData++; d.noData++; continue; }
                    const market = Array.isArray(data) ? data[0] : data;
                    if (!market?.id) { totalNoData++; d.noData++; continue; }

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
                    if (!isResolved) { totalUnresolved++; d.unresolved++; continue; }

                    const idx0Win = p0 >= 0.99;
                    const o0 = String(outcomes[0] || '').toLowerCase();
                    let resolvedOutcome;
                    if (o0 === 'up' || o0 === 'yes') resolvedOutcome = idx0Win ? 'UP' : 'DOWN';
                    else resolvedOutcome = idx0Win ? 'DOWN' : 'UP';

                    if (clobTokenIds.length < 2) { totalNoData++; d.noData++; continue; }
                    const upTokenIdx = (o0 === 'up' || o0 === 'yes') ? 0 : 1;
                    const downTokenIdx = 1 - upTokenIdx;
                    const entryMinStart = cycleEpoch + (strat.entryMinute * 60);
                    const entryMinEnd = entryMinStart + 60;
                    const upTokenId = clobTokenIds[upTokenIdx];
                    const downTokenId = clobTokenIds[downTokenIdx];

                    let entryPrice = null;
                    let chosenDirection = null;
                    let upEntryPrice = null;
                    let downEntryPrice = null;

                    if (strat.direction === 'UP' || strat.direction === 'DOWN') {
                        chosenDirection = strat.direction;
                        const tokenId = chosenDirection === 'UP' ? upTokenId : downTokenId;
                        const priceUrl = `${CLOB_API}?market=${tokenId}&startTs=${cycleEpoch}&endTs=${cycleEpoch + CYCLE_SEC}&fidelity=1`;
                        const priceData = await fetchJson(priceUrl);
                        await sleep(80);
                        entryPrice = extractEntryPrice(priceData, entryMinStart, entryMinEnd);
                        if (!Number.isFinite(entryPrice)) { totalNoData++; d.noData++; continue; }
                    } else {
                        const upUrl = `${CLOB_API}?market=${upTokenId}&startTs=${cycleEpoch}&endTs=${cycleEpoch + CYCLE_SEC}&fidelity=1`;
                        const downUrl = `${CLOB_API}?market=${downTokenId}&startTs=${cycleEpoch}&endTs=${cycleEpoch + CYCLE_SEC}&fidelity=1`;
                        const upData = await fetchJson(upUrl);
                        await sleep(80);
                        const downData = await fetchJson(downUrl);
                        await sleep(80);
                        upEntryPrice = extractEntryPrice(upData, entryMinStart, entryMinEnd);
                        downEntryPrice = extractEntryPrice(downData, entryMinStart, entryMinEnd);
                        if (!Number.isFinite(upEntryPrice) || !Number.isFinite(downEntryPrice)) { totalNoData++; d.noData++; continue; }
                        chosenDirection = upEntryPrice < downEntryPrice ? 'UP' : 'DOWN';
                        entryPrice = Math.min(upEntryPrice, downEntryPrice);
                    }

                    if (entryPrice < strat.priceMin || entryPrice > strat.priceMax) { totalOOB++; d.oob++; continue; }

                    const won = (chosenDirection === resolvedOutcome);
                    totalMatched++;
                    d.matched++;
                    if (won) { totalWins++; d.wins++; } else { totalLosses++; d.losses++; }

                    perStrategy[stratKey].trades++;
                    if (won) perStrategy[stratKey].wins++; else perStrategy[stratKey].losses++;

                    const sig = {
                        time: new Date((cycleEpoch + (strat.entryMinute * 60)) * 1000).toISOString().substring(0, 16),
                        asset,
                        direction: strat.direction,
                        chosenDirection,
                        entryPrice: Math.round(entryPrice * 100),
                        upEntryPrice: Number.isFinite(upEntryPrice) ? Math.round(upEntryPrice * 100) : null,
                        downEntryPrice: Number.isFinite(downEntryPrice) ? Math.round(downEntryPrice * 100) : null,
                        resolved: resolvedOutcome,
                        won,
                        signature: stratKey
                    };
                    allSignals.push(sig);
                    perStrategy[stratKey].signals.push(sig);

                    const icon = won ? '✅' : '❌';
                    const dirTxt = strat.direction === 'BEST' ? `BEST→${chosenDirection}` : chosenDirection;
                    console.log(`  ${icon} ${sig.time} | ${asset} ${dirTxt} @ ${sig.entryPrice}c → ${resolvedOutcome} | ${stratKey}`);
                }
            }
        }
        console.log(`  [${stratKey}] Live: ${perStrategy[stratKey].trades}t/${perStrategy[stratKey].wins}w/${perStrategy[stratKey].losses}l`);
    }

    allSignals.sort((a, b) => a.time.localeCompare(b.time));

    // Summary
    console.log('\n' + '='.repeat(80));
    console.log('LIVE CHECK SUMMARY');
    console.log('='.repeat(80));
    console.log(`Cycles checked: ${totalChecked}`);
    console.log(`Signals in-band: ${totalMatched}`);
    console.log(`Wins: ${totalWins}`);
    console.log(`Losses: ${totalLosses}`);
    console.log(`Live WR: ${totalMatched > 0 ? (totalWins / totalMatched * 100).toFixed(1) : 'N/A'}%`);
    console.log(`Live LCB: ${totalMatched > 0 ? (wilsonLCB(totalWins, totalMatched) * 100).toFixed(1) : 'N/A'}%`);
    console.log(`OOB: ${totalOOB}, NoData: ${totalNoData}, Unresolved: ${totalUnresolved}`);

    console.log('\nPER-STRATEGY LIVE RESULTS:');
    for (const strat of strategies) {
        const ps = perStrategy[strat.signature];
        const lwr = ps.trades > 0 ? (ps.wins / ps.trades * 100).toFixed(1) : 'N/A';
        const llcb = ps.trades > 0 ? (wilsonLCB(ps.wins, ps.trades) * 100).toFixed(1) : 'N/A';
        // Combined: OOS (val+test) + live
        const combT = strat.oos.trades + ps.trades;
        const combW = strat.oos.wins + ps.wins;
        const combWR = combT > 0 ? (combW / combT * 100).toFixed(1) : 'N/A';
        const combLCB = combT > 0 ? (wilsonLCB(combW, combT) * 100).toFixed(1) : 'N/A';
        console.log(`  ${strat.signature.padEnd(24)} | OOS: ${String(strat.oos.trades).padStart(3)}t/${(strat.oos.wr*100).toFixed(1).padStart(5)}%/LCB=${(strat.oos.lcb*100).toFixed(1).padStart(5)}% | Live: ${String(ps.trades).padStart(3)}t/${lwr.padStart(5)}%/LCB=${llcb.padStart(5)}% | Combined: ${String(combT).padStart(3)}t/${combWR.padStart(5)}%/LCB=${combLCB.padStart(5)}%`);
    }

    console.log('\nDAILY BREAKDOWN:');
    const dayKeys = Object.keys(daily).sort();
    for (const day of dayKeys) {
        const d = daily[day];
        const wr = d.matched > 0 ? (d.wins / d.matched * 100).toFixed(1) : 'N/A';
        console.log(`  ${day} | signals ${String(d.matched).padStart(3)} | ${String(d.wins).padStart(2)}W/${String(d.losses).padStart(2)}L (${wr.padStart(5)}%) | OOB ${d.oob} | noData ${d.noData} | unresolved ${d.unresolved}`);
    }

    // Save results
    const output = {
        generatedAt: new Date().toISOString(),
        methodology: 'Live API check of top 15 robust strategies (selected by val+test OOS LCB). Cross-asset evaluation against Polymarket resolved cycles.',
        timeRange: {
            start: new Date(startSec * 1000).toISOString(),
            end: new Date(endSec * 1000).toISOString(),
            days: LIVE_DAYS
        },
        strategiesTested: strategies.length,
        aggregate: {
            checked: totalChecked,
            matched: totalMatched,
            wins: totalWins,
            losses: totalLosses,
            wr: totalMatched > 0 ? totalWins / totalMatched : null,
            lcb: totalMatched > 0 ? wilsonLCB(totalWins, totalMatched) : null,
            oob: totalOOB,
            noData: totalNoData,
            unresolved: totalUnresolved
        },
        perStrategy: Object.fromEntries(strategies.map(s => {
            const ps = perStrategy[s.signature];
            const combT = s.oos.trades + ps.trades;
            const combW = s.oos.wins + ps.wins;
            return [s.signature, {
                oos: s.oos,
                live: { trades: ps.trades, wins: ps.wins, losses: ps.losses, wr: ps.trades > 0 ? ps.wins / ps.trades : null, lcb: ps.trades > 0 ? wilsonLCB(ps.wins, ps.trades) : null },
                combined: { trades: combT, wins: combW, wr: combT > 0 ? combW / combT : null, lcb: combT > 0 ? wilsonLCB(combW, combT) : null },
                signals: ps.signals
            }];
        })),
        dailyBreakdown: daily,
        allSignals
    };

    const outPath = OUT_ARG ? path.resolve(process.cwd(), OUT_ARG) : path.resolve(__dirname, '../exhaustive_analysis/robust_live_check.json');
    fs.writeFileSync(outPath, JSON.stringify(output, null, 2));
    console.log(`\nSaved to: ${outPath}`);
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
