/**
 * FAST FORWARD VALIDATION - Uses cached dataset + targeted recent API checks
 * 
 * 1. Splits cached dataset into true out-of-sample test set (last 20% by time)
 * 2. Evaluates hybrid strategies on this held-out data
 * 3. Also fetches a small sample of very recent cycles (last 24h) from API
 */

const fs = require('fs');
const path = require('path');

const ASSETS = ['BTC', 'ETH', 'SOL', 'XRP'];
const GAMMA_API = 'https://gamma-api.polymarket.com/markets';
const CLOB_API = 'https://clob.polymarket.com/prices-history';
const CYCLE_SEC = 900;

const argv = process.argv.slice(2);
const APPLY_VOLUME = argv.includes('--volume') || argv.includes('--applyVolume');
const APPLY_MOMENTUM = argv.includes('--momentum') || argv.includes('--applyMomentum');
const NO_LIVE = argv.includes('--no-live') || argv.includes('--noLive');
const liveDaysArg = argv.find(a => a.startsWith('--liveDays='));
const LIVE_DAYS = liveDaysArg ? Math.max(1, Math.min(14, parseInt(liveDaysArg.split('=')[1], 10) || 4)) : 4;

// Load strategies
const stratFile = path.join(__dirname, '..', 'optimized_strategies.json');
const stratData = JSON.parse(fs.readFileSync(stratFile, 'utf8'));
const STRATEGIES = stratData.strategies;
const COND = stratData.conditions;

// Load cached dataset
const dsFile = path.join(__dirname, '..', 'exhaustive_analysis', 'decision_dataset.json');
console.log('Loading decision dataset...');
const dataset = JSON.parse(fs.readFileSync(dsFile, 'utf8'));
console.log(`Dataset: ${dataset.length} rows`);

// ============================================================
// PART 1: OUT-OF-SAMPLE VALIDATION FROM CACHED DATA
// ============================================================

// Find date range
let minEpoch = Infinity, maxEpoch = -Infinity;
for (const row of dataset) {
    if (row.cycleStartEpochSec < minEpoch) minEpoch = row.cycleStartEpochSec;
    if (row.cycleStartEpochSec > maxEpoch) maxEpoch = row.cycleStartEpochSec;
}

// Split: first 60% = train, next 20% = val, last 20% = test (by time, chronological)
const totalSpan = maxEpoch - minEpoch;
const trainEnd = minEpoch + Math.floor(totalSpan * 0.6);
const valEnd = minEpoch + Math.floor(totalSpan * 0.8);

const trainSet = dataset.filter(r => r.cycleStartEpochSec < trainEnd);
const valSet = dataset.filter(r => r.cycleStartEpochSec >= trainEnd && r.cycleStartEpochSec < valEnd);
const testSet = dataset.filter(r => r.cycleStartEpochSec >= valEnd);

console.log(`\nDate range: ${new Date(minEpoch * 1000).toISOString()} to ${new Date(maxEpoch * 1000).toISOString()}`);
console.log(`Train: ${trainSet.length} rows (up to ${new Date(trainEnd * 1000).toISOString()})`);
console.log(`Val:   ${valSet.length} rows (up to ${new Date(valEnd * 1000).toISOString()})`);
console.log(`Test:  ${testSet.length} rows (from ${new Date(valEnd * 1000).toISOString()})`);

const pxMin = Number(COND.priceMin);
const pxMax = Number(COND.priceMax);
const volMin = Number(COND.volumeMin);
const momMin = Number(COND.momentumMin);
console.log(`Gates: price ${(pxMin * 100).toFixed(0)}-${(pxMax * 100).toFixed(0)}c | volume>$${volMin} (${APPLY_VOLUME ? 'ON' : 'OFF'}) | momentum>${(momMin * 100).toFixed(0)}% (${APPLY_MOMENTUM ? 'ON' : 'OFF'}) | liveDays=${LIVE_DAYS}${NO_LIVE ? ' (live disabled)' : ''}`);

function computeDirectionalMomentum(row, direction) {
    try {
        const dir = String(direction || '').toUpperCase();
        if (dir === 'UP') {
            const close = Number(row.upPrice);
            const trend = Number(row.upTrend);
            const open = close - trend;
            if (!Number.isFinite(open) || open <= 0 || !Number.isFinite(trend)) return null;
            return trend / open;
        }
        if (dir === 'DOWN') {
            const close = Number(row.downPrice);
            const trend = Number(row.downTrend);
            const open = close - trend;
            if (!Number.isFinite(open) || open <= 0 || !Number.isFinite(trend)) return null;
            return trend / open;
        }
        return null;
    } catch {
        return null;
    }
}

function isWildcardAsset(asset) {
    const a = String(asset || '').trim().toUpperCase();
    return a === '*' || a === 'ALL' || a === 'ANY';
}

function evaluateOnDataset(data, label) {
    console.log(`\n========================================`);
    console.log(`EVALUATING ON ${label.toUpperCase()} SET (${data.length} rows)`);
    console.log(`========================================`);

    let grandWins = 0, grandLosses = 0, grandOOB = 0, grandVolBlocked = 0, grandMomBlocked = 0;
    const stratResults = [];

    for (const strat of STRATEGIES) {
        let wins = 0, losses = 0, oob = 0, volBlocked = 0, momBlocked = 0, matched = 0;
        const signals = [];

        for (const row of data) {
            const sAsset = String(strat.asset || '').trim().toUpperCase();
            const rAsset = String(row.asset || '').trim().toUpperCase();
            if (sAsset && !isWildcardAsset(sAsset) && rAsset !== sAsset) continue;
            if (row.utcHour !== strat.utcHour) continue;
            if (row.entryMinute !== strat.entryMinute) continue;

            // Get entry price for this direction
            let entryPrice;
            if (strat.direction === 'UP') entryPrice = row.upPrice;
            else if (strat.direction === 'DOWN') entryPrice = row.downPrice;
            else entryPrice = Math.min(row.upPrice, row.downPrice);

            if (!Number.isFinite(entryPrice)) continue;

            // Check price band
            const sMin = Number(strat.priceMin);
            const sMax = Number(strat.priceMax);
            const bandMin = Number.isFinite(sMin) ? sMin : pxMin;
            const bandMax = Number.isFinite(sMax) ? sMax : pxMax;
            if (entryPrice < bandMin || entryPrice > bandMax) {
                oob++;
                continue;
            }

            if (APPLY_VOLUME) {
                const vol = Number(row.volume);
                if (!Number.isFinite(vol) || vol <= volMin) {
                    volBlocked++;
                    continue;
                }
            }

            if (APPLY_MOMENTUM) {
                const mom = computeDirectionalMomentum(row, strat.direction);
                if (!Number.isFinite(mom) || mom <= momMin) {
                    momBlocked++;
                    continue;
                }
            }

            matched++;

            // Check win
            let tradedUp = strat.direction === 'UP' ? true : strat.direction === 'DOWN' ? false : (row.upPrice < row.downPrice);
            const won = (tradedUp === row.winnerIsUp);

            if (won) wins++;
            else losses++;

            signals.push({
                time: new Date((row.cycleStartEpochSec + (row.entryMinute * 60)) * 1000).toISOString().substring(0, 16),
                slug: row.slug,
                entryPrice: Math.round(entryPrice * 100),
                resolved: row.resolvedOutcome,
                won
            });
        }

        const total = wins + losses;
        const wr = total > 0 ? (wins / total * 100).toFixed(1) : 'N/A';
        
        grandWins += wins;
        grandLosses += losses;
        grandOOB += oob;
        grandVolBlocked += volBlocked;
        grandMomBlocked += momBlocked;

        stratResults.push({
            id: strat.id,
            name: strat.name,
            asset: strat.asset,
            direction: strat.direction,
            hour: strat.utcHour,
            minute: strat.entryMinute,
            tier: strat.tier,
            histWR: strat.winRate,
            wins,
            losses,
            total,
            wr: total > 0 ? wins / total : null,
            oob,
            volBlocked,
            momBlocked,
            signals
        });

        if (total > 0) {
            const gatesTxt = `${APPLY_VOLUME ? ` | VOLx ${volBlocked}` : ''}${APPLY_MOMENTUM ? ` | MOMx ${momBlocked}` : ''}`;
            console.log(`  #${String(strat.id).padStart(2)} ${strat.name.padEnd(28)} | ${strat.asset} ${strat.direction.padEnd(4)} H${String(strat.utcHour).padStart(2,'0')}:m${String(strat.entryMinute).padStart(2,'0')} | ${label}: ${wins}W/${losses}L = ${wr}% | Hist: ${(strat.winRate*100).toFixed(1)}% | OOB: ${oob}${gatesTxt}`);
        } else {
            const gatesTxt = `${APPLY_VOLUME ? `, VOLx ${volBlocked}` : ''}${APPLY_MOMENTUM ? `, MOMx ${momBlocked}` : ''}`;
            console.log(`  #${String(strat.id).padStart(2)} ${strat.name.padEnd(28)} | ${strat.asset} ${strat.direction.padEnd(4)} H${String(strat.utcHour).padStart(2,'0')}:m${String(strat.entryMinute).padStart(2,'0')} | ${label}: NO SIGNALS (${oob} out-of-band${gatesTxt})`);
        }
    }

    const grandTotal = grandWins + grandLosses;
    const grandWR = grandTotal > 0 ? (grandWins / grandTotal * 100).toFixed(1) : 'N/A';
    const blockedTxt = `${APPLY_VOLUME ? `, ${grandVolBlocked} vol-blocked` : ''}${APPLY_MOMENTUM ? `, ${grandMomBlocked} mom-blocked` : ''}`;
    console.log(`\n  AGGREGATE: ${grandWins}W / ${grandLosses}L = ${grandWR}% WR | ${grandOOB} out-of-band filtered${blockedTxt}`);

    // Wilson LCB
    if (grandTotal > 0) {
        const p = grandWins / grandTotal;
        const z = 1.96;
        const n = grandTotal;
        const denom = 1 + (z * z) / n;
        const center = p + (z * z) / (2 * n);
        const margin = z * Math.sqrt((p * (1 - p) + (z * z) / (4 * n)) / n);
        const lcb = (center - margin) / denom;
        console.log(`  Wilson LCB (95%): ${(lcb * 100).toFixed(1)}%`);
    }

    return { stratResults, grandWins, grandLosses, grandTotal, grandOOB, grandVolBlocked, grandMomBlocked };
}

// Run on all three sets
const trainResults = evaluateOnDataset(trainSet, 'TRAIN');
const valResults = evaluateOnDataset(valSet, 'VAL');
const testResults = evaluateOnDataset(testSet, 'TEST');

// ============================================================
// PART 2: TARGETED RECENT API CHECK (last ~24h, just a few cycles)
// ============================================================

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function fetchJson(url, retries = 2) {
    for (let i = 0; i < retries; i++) {
        try {
            const resp = await fetch(url, {
                headers: { 'User-Agent': 'polyprophet-fwd/1.0' },
                signal: AbortSignal.timeout(10000)
            });
            if (resp.ok) return await resp.json();
            if (resp.status === 429) { await sleep(2000); continue; }
            if (resp.status === 404) return null;
        } catch (e) {
            await sleep(500);
        }
    }
    return null;
}

async function recentCheck() {
    console.log(`\n\n========================================`);
    console.log(`PART 2: LIVE RECENT CHECK (Last ~${LIVE_DAYS}d from API)`);
    console.log(`========================================`);

    const nowSec = Math.floor(Date.now() / 1000);
    const nowDayStartSec = nowSec - (nowSec % 86400);
    const startSec = nowDayStartSec - ((LIVE_DAYS - 1) * 86400);
    const endSec = nowSec - CYCLE_SEC; // exclude current cycle

    let totalChecked = 0, totalMatched = 0, totalWins = 0, totalLosses = 0, totalOOB = 0, totalNoData = 0, totalUnresolved = 0, totalVolBlocked = 0, totalMomBlocked = 0;
    const allSignals = [];
    const daily = {};

    const getDayKey = (epochSec) => new Date(epochSec * 1000).toISOString().slice(0, 10);
    const ensureDay = (dayKey) => {
        if (!daily[dayKey]) {
            daily[dayKey] = { checked: 0, matched: 0, wins: 0, losses: 0, oob: 0, noData: 0, unresolved: 0, volBlocked: 0, momBlocked: 0 };
        }
        return daily[dayKey];
    };

    // Only check the specific cycles that match our strategies
    for (const strat of STRATEGIES) {
        // Find all cycle epochs for this strategy's UTC hour in the last 48h
        const dayStartSec = startSec - (startSec % 86400); // Align to day
        
        for (let dayOffset = 0; dayOffset < (LIVE_DAYS + 2); dayOffset++) {
            const dayBase = dayStartSec + (dayOffset * 86400);
            
            // 4 cycles per hour at :00, :15, :30, :45
            for (let c = 0; c < 4; c++) {
                const cycleEpoch = dayBase + (strat.utcHour * 3600) + (c * CYCLE_SEC);
                if (cycleEpoch < startSec || cycleEpoch >= endSec) continue;

                const sAsset = String(strat.asset || '').trim().toUpperCase();
                const assetsToCheck = (!sAsset || isWildcardAsset(sAsset)) ? ASSETS : [sAsset];
                for (const asset of assetsToCheck) {
                    const d = ensureDay(getDayKey(cycleEpoch));
                    d.checked++;

                    totalChecked++;
                    const slug = `${String(asset).toLowerCase()}-updown-15m-${cycleEpoch}`;

                    const data = await fetchJson(`${GAMMA_API}?slug=${encodeURIComponent(slug)}`);
                    await sleep(100);

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

                // Get intracycle price at entry minute
                    if (clobTokenIds.length < 2) { totalNoData++; d.noData++; continue; }
                    const upTokenIdx = (o0 === 'up' || o0 === 'yes') ? 0 : 1;
                    const downTokenIdx = 1 - upTokenIdx;
                    const targetIdx = strat.direction === 'UP' ? upTokenIdx : downTokenIdx;
                    const tokenId = clobTokenIds[targetIdx];

                    const priceUrl = `${CLOB_API}?market=${tokenId}&startTs=${cycleEpoch}&endTs=${cycleEpoch + CYCLE_SEC}&fidelity=1`;
                    const priceData = await fetchJson(priceUrl);
                    await sleep(100);

                    if (!priceData?.history?.length) { totalNoData++; d.noData++; continue; }

                const entryMinStart = cycleEpoch + (strat.entryMinute * 60);
                const entryMinEnd = entryMinStart + 60;
                const ticks = priceData.history.map(h => ({ t: h.t, p: Number(h.p) })).filter(t => t.p > 0 && t.p < 1);
                const entryTicks = ticks.filter(t => t.t >= entryMinStart && t.t < entryMinEnd);

                let entryPrice;
                if (entryTicks.length > 0) {
                    entryPrice = entryTicks[entryTicks.length - 1].p;
                } else {
                    const before = ticks.filter(t => t.t <= entryMinEnd).sort((a, b) => b.t - a.t);
                    if (before.length > 0) entryPrice = before[0].p;
                    else { totalNoData++; d.noData++; continue; }
                }

                    const sMin = Number(strat.priceMin);
                    const sMax = Number(strat.priceMax);
                    const bandMin = Number.isFinite(sMin) ? sMin : pxMin;
                    const bandMax = Number.isFinite(sMax) ? sMax : pxMax;
                    if (entryPrice < bandMin || entryPrice > bandMax) { totalOOB++; d.oob++; continue; }

                const vol = Number(market.volume || 0);
                if (APPLY_VOLUME && (!Number.isFinite(vol) || vol <= volMin)) {
                    totalVolBlocked++;
                    d.volBlocked++;
                    continue;
                }

                let momentum = null;
                if (APPLY_MOMENTUM) {
                    const openMinStart = cycleEpoch;
                    const openMinEnd = openMinStart + 60;
                    const openTicks = ticks.filter(t => t.t >= openMinStart && t.t < openMinEnd).sort((a, b) => a.t - b.t);
                    const openPrice = openTicks.length > 0 ? openTicks[0].p : (ticks.length > 0 ? ticks[0].p : entryPrice);
                    if (Number.isFinite(openPrice) && openPrice > 0) {
                        momentum = (entryPrice - openPrice) / openPrice;
                    }
                    if (!Number.isFinite(momentum) || momentum <= momMin) {
                        totalMomBlocked++;
                        d.momBlocked++;
                        continue;
                    }
                }

                const won = (strat.direction === resolvedOutcome);
                totalMatched++;
                d.matched++;
                if (won) totalWins++; else totalLosses++;
                if (won) d.wins++; else d.losses++;

                    const sig = {
                        time: new Date((cycleEpoch + (strat.entryMinute * 60)) * 1000).toISOString().substring(0, 16),
                        asset,
                        direction: strat.direction,
                        entryPrice: Math.round(entryPrice * 100),
                        resolved: resolvedOutcome,
                        won,
                        stratName: strat.name,
                        stratId: strat.id,
                        volume: Math.round(vol),
                        momentum
                    };
                    allSignals.push(sig);

                    const icon = won ? '✅' : '❌';
                    const momTxt = APPLY_MOMENTUM ? ` | Mom: ${Number.isFinite(sig.momentum) ? (sig.momentum * 100).toFixed(1) : 'N/A'}%` : '';
                    console.log(`  ${icon} ${sig.time} | ${asset} ${strat.direction} @ ${sig.entryPrice}c → ${resolvedOutcome} | ${strat.name} | Vol: $${sig.volume}${momTxt}`);
                }
            }
        }
    }

    allSignals.sort((a, b) => a.time.localeCompare(b.time));

    console.log(`\n  LIVE RECENT SUMMARY:`);
    console.log(`  Cycles checked: ${totalChecked}`);
    console.log(`  Signals in-band: ${totalMatched}`);
    console.log(`  Wins: ${totalWins}`);
    console.log(`  Losses: ${totalLosses}`);
    console.log(`  Forward WR: ${totalMatched > 0 ? (totalWins / totalMatched * 100).toFixed(1) : 'N/A'}%`);
    console.log(`  Out-of-band: ${totalOOB}`);
    if (APPLY_VOLUME) console.log(`  Volume-blocked: ${totalVolBlocked}`);
    if (APPLY_MOMENTUM) console.log(`  Momentum-blocked: ${totalMomBlocked}`);
    console.log(`  No data: ${totalNoData}`);
    console.log(`  Unresolved: ${totalUnresolved}`);

    const dayKeys = Object.keys(daily).sort();
    console.log(`\n  DAILY BREAKDOWN:`);
    for (const day of dayKeys) {
        const d = daily[day];
        const wr = d.matched > 0 ? (d.wins / d.matched * 100).toFixed(1) : 'N/A';
        const gatesTxt = `${APPLY_VOLUME ? ` | VOLx ${d.volBlocked}` : ''}${APPLY_MOMENTUM ? ` | MOMx ${d.momBlocked}` : ''}`;
        console.log(`  ${day} | signals ${d.matched} | ${d.wins}W/${d.losses}L (${wr}%) | OOB ${d.oob}${gatesTxt} | noData ${d.noData} | unresolved ${d.unresolved}`);
    }

    return { totalChecked, totalMatched, totalWins, totalLosses, totalOOB, totalNoData, totalUnresolved, totalVolBlocked, totalMomBlocked, allSignals, dailyBreakdown: daily };
}

async function main() {
    const recent = NO_LIVE ? null : await recentCheck();

    // Save comprehensive results
    const outputPath = path.join(__dirname, '..', 'exhaustive_analysis', 'forward_validation_results.reaudit.json');
    fs.writeFileSync(outputPath, JSON.stringify({
        generatedAt: new Date().toISOString(),
        gates: {
            priceMin: pxMin,
            priceMax: pxMax,
            volumeMin: volMin,
            momentumMin: momMin,
            applyVolume: APPLY_VOLUME,
            applyMomentum: APPLY_MOMENTUM
        },
        liveWindow: {
            enabled: !NO_LIVE,
            liveDays: LIVE_DAYS
        },
        cachedDatasetRange: {
            start: new Date(minEpoch * 1000).toISOString(),
            end: new Date(maxEpoch * 1000).toISOString()
        },
        trainSplit: {
            rows: trainSet.length,
            wins: trainResults.grandWins,
            losses: trainResults.grandLosses,
            wr: trainResults.grandTotal > 0 ? trainResults.grandWins / trainResults.grandTotal : null,
            oob: trainResults.grandOOB,
            volBlocked: trainResults.grandVolBlocked,
            momBlocked: trainResults.grandMomBlocked
        },
        valSplit: {
            rows: valSet.length,
            wins: valResults.grandWins,
            losses: valResults.grandLosses,
            wr: valResults.grandTotal > 0 ? valResults.grandWins / valResults.grandTotal : null,
            oob: valResults.grandOOB,
            volBlocked: valResults.grandVolBlocked,
            momBlocked: valResults.grandMomBlocked
        },
        testSplit: {
            rows: testSet.length,
            wins: testResults.grandWins,
            losses: testResults.grandLosses,
            wr: testResults.grandTotal > 0 ? testResults.grandWins / testResults.grandTotal : null,
            oob: testResults.grandOOB,
            volBlocked: testResults.grandVolBlocked,
            momBlocked: testResults.grandMomBlocked
        },
        recentLive: recent ? {
            checked: recent.totalChecked,
            matched: recent.totalMatched,
            wins: recent.totalWins,
            losses: recent.totalLosses,
            wr: recent.totalMatched > 0 ? recent.totalWins / recent.totalMatched : null,
            oob: recent.totalOOB,
            volumeBlocked: recent.totalVolBlocked,
            momentumBlocked: recent.totalMomBlocked,
            noData: recent.totalNoData,
            unresolved: recent.totalUnresolved,
            dailyBreakdown: recent.dailyBreakdown,
            signals: recent.allSignals
        } : null
    }, null, 2));
    console.log(`\nResults saved to: ${outputPath}`);
}

main().catch(e => { console.error('FATAL:', e); process.exit(1); });
