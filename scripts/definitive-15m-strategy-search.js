#!/usr/bin/env node
'use strict';

/**
 * Broad recent 15m strategy search.
 *
 * This script intentionally uses the same real Polymarket resolved-market and
 * CLOB price-history sources as `fresh-15m-strategy-audit.js`, but searches the
 * full recent hour/minute/asset/direction/price-band space instead of only the
 * currently deployed rules.
 */

const fs = require('fs');
const path = require('path');
const https = require('https');

const ROOT = path.resolve(__dirname, '..');
const GAMMA_API = 'https://gamma-api.polymarket.com';
const CLOB_API = 'https://clob.polymarket.com';
const CYCLE_SECONDS = 900;
const FEE_RATE = 0.072;
const SLIPPAGE_PCT = 0.01;
const ADVERSE_FILL_CENTS = Number(process.env.ADVERSE_FILL_CENTS || '0.02');
const DAYS = Math.max(1, Number.parseInt(process.env.SEARCH_DAYS || '7', 10));
const ASSETS = String(process.env.SEARCH_ASSETS || 'BTC,ETH,SOL,XRP')
    .split(',')
    .map((value) => value.trim().toUpperCase())
    .filter(Boolean);
const CONCURRENCY = Math.max(1, Number.parseInt(process.env.SEARCH_CONCURRENCY || '8', 10));
const MIN_TRIGGER_3D = Number(process.env.MIN_TRIGGER_3D || '8');
const MIN_TRIGGER_7D = Number(process.env.MIN_TRIGGER_7D || '18');
const MIN_TRAIN_TRIGGER = Number(process.env.MIN_TRAIN_TRIGGER || '10');
const MIN_WR_7D = Number(process.env.MIN_WR_7D || '0.74');
const MIN_LCB_7D = Number(process.env.MIN_LCB_7D || '0.56');
const MIN_AVG_PNL = Number(process.env.MIN_AVG_PNL || '0.035');
const MAX_STRATEGIES = Number(process.env.MAX_STRATEGIES || '12');
const BANKROLL = Number(process.env.BANKROLL || '22.341031');
const CURRENT_STRATEGY_FILE = process.env.CURRENT_STRATEGY_FILE || 'strategies/strategy_set_15m_autopilot_pruned_20260508152930.json';

const CACHE_FILE = path.join(ROOT, 'debug', `definitive_15m_cycle_cache_${DAYS}d.json`);
const OUT_DIR = path.join(ROOT, 'epoch3', 'reinvestigation_v2');

function ensureDir(dir) {
    fs.mkdirSync(dir, { recursive: true });
}

function round(value, digits = 4) {
    if (!Number.isFinite(value)) return value === null ? null : undefined;
    const m = 10 ** digits;
    return Math.round(value * m) / m;
}

function safeJsonArray(value) {
    if (Array.isArray(value)) return value;
    try { return JSON.parse(value || '[]'); } catch { return []; }
}

function fetchJSON(url, timeoutMs = 15000) {
    return new Promise((resolve, reject) => {
        const req = https.get(url, { timeout: timeoutMs }, (res) => {
            let data = '';
            res.setEncoding('utf8');
            res.on('data', (chunk) => { data += chunk; });
            res.on('end', () => {
                if (res.statusCode < 200 || res.statusCode >= 300) {
                    reject(new Error(`HTTP_${res.statusCode} ${url}`));
                    return;
                }
                try { resolve(JSON.parse(data)); } catch (error) { reject(error); }
            });
        });
        req.on('timeout', () => req.destroy(new Error(`TIMEOUT ${url}`)));
        req.on('error', reject);
    });
}

async function fetchMarket(slug) {
    try {
        const markets = await fetchJSON(`${GAMMA_API}/markets?slug=${slug}`);
        if (Array.isArray(markets) && markets.length > 0) return markets[0];
    } catch {
        // fall through to event lookup
    }
    try {
        const events = await fetchJSON(`${GAMMA_API}/events?slug=${slug}`);
        const event = Array.isArray(events) && events.length > 0 ? events[0] : null;
        const markets = Array.isArray(event?.markets) ? event.markets : [];
        return markets.find((market) => String(market?.slug || '') === slug) || markets[0] || null;
    } catch {
        return null;
    }
}

async function fetchPriceHistory(tokenId, startTs, endTs) {
    try {
        const data = await fetchJSON(`${CLOB_API}/prices-history?market=${tokenId}&startTs=${startTs}&endTs=${endTs}&fidelity=1`);
        return Array.isArray(data?.history) ? data.history : [];
    } catch {
        return [];
    }
}

function tokenMapFor(market) {
    const tokenIds = safeJsonArray(market?.clobTokenIds);
    const outcomes = safeJsonArray(market?.outcomes);
    if (tokenIds.length < 2) return null;
    let yesIdx = outcomes.findIndex((outcome) => /^(yes|up)$/i.test(String(outcome).trim()));
    let noIdx = outcomes.findIndex((outcome) => /^(no|down)$/i.test(String(outcome).trim()));
    if (yesIdx < 0 || noIdx < 0) {
        yesIdx = 0;
        noIdx = 1;
    }
    if (!tokenIds[yesIdx] || !tokenIds[noIdx]) return null;
    return { yesTokenId: tokenIds[yesIdx], noTokenId: tokenIds[noIdx], yesIdx, noIdx };
}

function resolutionFor(market, tokenMap) {
    const prices = safeJsonArray(market?.outcomePrices).map(Number);
    const yes = prices[tokenMap.yesIdx];
    const no = prices[tokenMap.noIdx];
    if (yes >= 0.99) return 'UP';
    if (no >= 0.99) return 'DOWN';
    return null;
}

function priceAtMinute(history, epoch, minute) {
    const minuteEnd = epoch + ((minute + 1) * 60);
    const points = (history || [])
        .map((point) => ({ t: Number(point?.t), p: Number(point?.p) }))
        .filter((point) => Number.isFinite(point.t) && Number.isFinite(point.p) && point.t >= epoch && point.t < minuteEnd)
        .sort((a, b) => a.t - b.t);
    return points.length ? points[points.length - 1].p : null;
}

function calcFeePerShare(price) {
    return FEE_RATE * price * (1 - price);
}

function tradeMath(entryPrice, won) {
    const effectiveEntry = Math.min(0.99, (entryPrice * (1 + SLIPPAGE_PCT)) + ADVERSE_FILL_CENTS);
    const costPerShare = effectiveEntry + calcFeePerShare(effectiveEntry);
    return {
        effectiveEntry,
        costPerShare,
        pnlPerShare: won ? 1 - costPerShare : -costPerShare,
    };
}

function wilsonLowerBound(wins, n, z = 1.96) {
    if (!n) return 0;
    const p = wins / n;
    const z2 = z * z;
    return (p + z2 / (2 * n) - z * Math.sqrt((p * (1 - p) + z2 / (4 * n)) / n)) / (1 + z2 / n);
}

function latestClosedEpoch() {
    const nowSec = Math.floor(Date.now() / 1000);
    return Math.floor((nowSec - CYCLE_SECONDS) / CYCLE_SECONDS) * CYCLE_SECONDS;
}

function plannedCycles() {
    const latest = latestClosedEpoch();
    const earliest = latest - (DAYS * 86400);
    const tasks = [];
    for (let epoch = earliest; epoch <= latest; epoch += CYCLE_SECONDS) {
        for (const asset of ASSETS) tasks.push({ epoch, asset });
    }
    return tasks;
}

function loadCache() {
    if (!fs.existsSync(CACHE_FILE) || process.env.FORCE_FETCH === 'true') return { cycles: [] };
    try { return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')); } catch { return { cycles: [] }; }
}

function saveCache(cache) {
    ensureDir(path.dirname(CACHE_FILE));
    fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2));
}

async function fetchCycle({ epoch, asset }) {
    const slug = `${asset.toLowerCase()}-updown-15m-${epoch}`;
    const market = await fetchMarket(slug);
    if (!market || !market.closed) return null;
    const tokens = tokenMapFor(market);
    if (!tokens) return null;
    const outcome = resolutionFor(market, tokens);
    if (!outcome) return null;
    const [yesHistory, noHistory] = await Promise.all([
        fetchPriceHistory(tokens.yesTokenId, epoch, epoch + CYCLE_SECONDS),
        fetchPriceHistory(tokens.noTokenId, epoch, epoch + CYCLE_SECONDS),
    ]);
    const prices = [];
    for (let minute = 0; minute < 15; minute += 1) {
        prices.push({
            minute,
            UP: priceAtMinute(yesHistory, epoch, minute),
            DOWN: priceAtMinute(noHistory, epoch, minute),
        });
    }
    return {
        key: `${epoch}_${asset}`,
        slug,
        asset,
        epoch,
        iso: new Date(epoch * 1000).toISOString(),
        utcHour: new Date(epoch * 1000).getUTCHours(),
        outcome,
        prices,
    };
}

async function mapLimit(items, limit, worker) {
    const results = [];
    let next = 0;
    let done = 0;
    async function run() {
        while (next < items.length) {
            const index = next;
            next += 1;
            try {
                results[index] = await worker(items[index], index);
            } catch {
                results[index] = null;
            }
            done += 1;
            if (done % 50 === 0 || done === items.length) {
                console.log(`[definitive-search] fetched ${done}/${items.length}`);
            }
        }
    }
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
    return results;
}

function buildObservations(cycles) {
    const observations = [];
    for (const cycle of cycles) {
        for (const row of cycle.prices || []) {
            for (const direction of ['UP', 'DOWN']) {
                const price = Number(row[direction]);
                if (!Number.isFinite(price) || price <= 0 || price >= 1) continue;
                const won = cycle.outcome === direction;
                observations.push({
                    asset: cycle.asset,
                    epoch: cycle.epoch,
                    utcHour: cycle.utcHour,
                    entryMinute: row.minute,
                    direction,
                    price,
                    won,
                    ...tradeMath(price, won),
                });
            }
        }
    }
    return observations;
}

function priceBands() {
    const bands = [];
    for (let min = 0.05; min <= 0.85; min += 0.05) {
        for (const width of [0.1, 0.15, 0.2, 0.25, 0.3]) {
            const max = Math.min(0.9, min + width);
            if (max > min && max <= 0.9) bands.push([round(min, 2), round(max, 2)]);
        }
    }
    return bands;
}

function summarise(rows) {
    const wins = rows.filter((row) => row.won).length;
    const pnl = rows.reduce((sum, row) => sum + row.pnlPerShare, 0);
    const avgPrice = rows.reduce((sum, row) => sum + row.price, 0) / rows.length;
    return {
        triggers: rows.length,
        wins,
        losses: rows.length - wins,
        winRate: rows.length ? wins / rows.length : 0,
        wilsonLCB95: wilsonLowerBound(wins, rows.length),
        avgEntry: avgPrice,
        avgPnlPerShare: rows.length ? pnl / rows.length : 0,
    };
}

function scanRules(observations) {
    const bands = priceBands();
    const rules = [];
    const latest = latestClosedEpoch();
    const cutoff3d = latest - (3 * 86400);
    const cutoff1d = latest - 86400;

    for (const asset of ['ALL', ...ASSETS]) {
        const assetRows = asset === 'ALL' ? observations : observations.filter((row) => row.asset === asset);
        for (let utcHour = 0; utcHour < 24; utcHour += 1) {
            const hourRows = assetRows.filter((row) => row.utcHour === utcHour);
            if (!hourRows.length) continue;
            for (let entryMinute = 0; entryMinute <= 13; entryMinute += 1) {
                const minuteRows = hourRows.filter((row) => row.entryMinute === entryMinute);
                if (!minuteRows.length) continue;
                for (const direction of ['UP', 'DOWN']) {
                    const directionRows = minuteRows.filter((row) => row.direction === direction);
                    if (!directionRows.length) continue;
                    for (const [priceMin, priceMax] of bands) {
                        const rows = directionRows.filter((row) => row.price >= priceMin && row.price <= priceMax);
                        if (rows.length < MIN_TRIGGER_7D) continue;
                        const recent3 = rows.filter((row) => row.epoch >= cutoff3d);
                        const train = rows.filter((row) => row.epoch < cutoff3d);
                        const recent1 = rows.filter((row) => row.epoch >= cutoff1d);
                        if (recent3.length < MIN_TRIGGER_3D) continue;
                        if (train.length < MIN_TRAIN_TRIGGER) continue;
                        const all = summarise(rows);
                        const tr = summarise(train);
                        const s3 = summarise(recent3);
                        const s1 = recent1.length ? summarise(recent1) : null;
                        const score = (tr.avgPnlPerShare * Math.sqrt(tr.triggers))
                            + (s3.avgPnlPerShare * Math.sqrt(s3.triggers))
                            + (all.avgPnlPerShare * Math.sqrt(all.triggers) * 0.25)
                            + (tr.wilsonLCB95 - 0.5)
                            + (s3.wilsonLCB95 - 0.5)
                            + (all.wilsonLCB95 - 0.5)
                            + Math.min(0.25, all.triggers / 200);
                        rules.push({ asset, utcHour, entryMinute, direction, priceMin, priceMax, train: tr, all, recent3: s3, recent1: s1, score });
                    }
                }
            }
        }
    }

    return rules
        .filter((rule) => rule.all.winRate >= MIN_WR_7D
            && rule.all.wilsonLCB95 >= MIN_LCB_7D
            && rule.all.avgPnlPerShare >= MIN_AVG_PNL
            && rule.train.winRate >= 0.7
            && rule.train.avgPnlPerShare > 0
            && rule.recent3.avgPnlPerShare > 0
            && rule.recent3.winRate >= 0.7)
        .sort((a, b) => b.score - a.score);
}

function selectedSet(rules, observations) {
    const selected = [];
    const seen = new Set();
    let bestEndBankroll = BANKROLL;
    const minSurvivalBankroll = BANKROLL * 0.4;
    for (const rule of rules) {
        const key = `${rule.asset}_${rule.utcHour}_${rule.entryMinute}_${rule.direction}`;
        if (seen.has(key)) continue;
        const trial = [...selected, rule];
        const trialSim = simulateChronological(strategyRowsFromSelected(trial), observations, 'trial');
        const improves = Number(trialSim.endBankroll) > bestEndBankroll * 1.02;
        const survives = Number(trialSim.endBankroll) > BANKROLL
            && Number(trialSim.minBankroll) >= minSurvivalBankroll
            && Number(trialSim.trades) >= Math.max(MIN_TRIGGER_7D, trial.length * 4);
        if (!improves || !survives) continue;
        seen.add(key);
        selected.push(rule);
        bestEndBankroll = Number(trialSim.endBankroll);
        if (selected.length >= MAX_STRATEGIES) break;
    }
    return selected;
}

function evaluateStrategyFile(strategyFile, observations) {
    if (!fs.existsSync(path.join(ROOT, strategyFile))) return null;
    const parsed = JSON.parse(fs.readFileSync(path.join(ROOT, strategyFile), 'utf8'));
    const strategies = Array.isArray(parsed.strategies) ? parsed.strategies : [];
    const rows = [];
    for (const obs of observations) {
        for (const strategy of strategies) {
            const asset = String(strategy.asset || 'ALL').toUpperCase();
            if (asset !== 'ALL' && asset !== obs.asset) continue;
            if (Number(strategy.utcHour) !== obs.utcHour) continue;
            if (Number(strategy.entryMinute) !== obs.entryMinute) continue;
            if (String(strategy.direction).toUpperCase() !== obs.direction) continue;
            if (obs.price < Number(strategy.priceMin) || obs.price > Number(strategy.priceMax)) continue;
            rows.push(obs);
        }
    }
    return { file: strategyFile, rules: strategies.length, ...summarise(rows) };
}

function strategyRowsFromFile(strategyFile) {
    if (!fs.existsSync(path.join(ROOT, strategyFile))) return [];
    const parsed = JSON.parse(fs.readFileSync(path.join(ROOT, strategyFile), 'utf8'));
    return Array.isArray(parsed.strategies) ? parsed.strategies : [];
}

function strategyRowsFromSelected(selectedRules) {
    return selectedRules.map((rule, index) => ({
        id: 9000 + index + 1,
        asset: rule.asset,
        utcHour: rule.utcHour,
        entryMinute: rule.entryMinute,
        direction: rule.direction,
        priceMin: rule.priceMin,
        priceMax: rule.priceMax,
        expectedPnlPerShare: rule.all.avgPnlPerShare,
        score: rule.score,
    }));
}

function matchStrategies(strategies, observations) {
    const matches = [];
    for (const obs of observations) {
        for (const strategy of strategies) {
            const asset = String(strategy.asset || 'ALL').toUpperCase();
            if (asset !== 'ALL' && asset !== obs.asset) continue;
            if (Number(strategy.utcHour) !== obs.utcHour) continue;
            if (Number(strategy.entryMinute) !== obs.entryMinute) continue;
            if (String(strategy.direction).toUpperCase() !== obs.direction) continue;
            if (obs.price < Number(strategy.priceMin) || obs.price > Number(strategy.priceMax)) continue;
            matches.push({ ...obs, strategyId: strategy.id, expectedPnlPerShare: Number(strategy.expectedPnlPerShare ?? strategy.holdoutEV ?? 0), score: Number(strategy.score || 0) });
        }
    }
    return matches;
}

function productionTier(bankroll) {
    if (bankroll < 15) return { stakeFraction: 0.40, maxPerCycle: 1, maxAbsoluteStake: 100 };
    if (bankroll < 50) return { stakeFraction: 0.35, maxPerCycle: 2, maxAbsoluteStake: 100 };
    if (bankroll < 200) return { stakeFraction: 0.30, maxPerCycle: 2, maxAbsoluteStake: 100 };
    if (bankroll < 1000) return { stakeFraction: 0.25, maxPerCycle: 2, maxAbsoluteStake: 100 };
    if (bankroll < 10000) return { stakeFraction: 0.25, maxPerCycle: 2, maxAbsoluteStake: 200 };
    return { stakeFraction: 0.25, maxPerCycle: 2, maxAbsoluteStake: 500 };
}

function simulateChronological(strategies, observations, label) {
    const matches = matchStrategies(strategies, observations)
        .sort((a, b) => (a.epoch - b.epoch) || (b.expectedPnlPerShare - a.expectedPnlPerShare) || (b.score - a.score));
    const byEpoch = new Map();
    for (const match of matches) {
        if (!byEpoch.has(match.epoch)) byEpoch.set(match.epoch, []);
        byEpoch.get(match.epoch).push(match);
    }
    let bankroll = BANKROLL;
    let peak = BANKROLL;
    let minBankroll = BANKROLL;
    let maxDrawdownPct = 0;
    let wins = 0;
    let losses = 0;
    let trades = 0;
    const dayStats = new Map();
    for (const [epoch, epochMatches] of [...byEpoch.entries()].sort((a, b) => a[0] - b[0])) {
        const tier = productionTier(bankroll);
        let available = bankroll;
        let opened = 0;
        let pendingPnl = 0;
        const ordered = epochMatches.sort((a, b) => (b.expectedPnlPerShare - a.expectedPnlPerShare) || (b.score - a.score));
        for (const match of ordered) {
            if (opened >= tier.maxPerCycle) break;
            const minCost = 5 * match.price;
            let cost = Math.min(bankroll * tier.stakeFraction, tier.maxAbsoluteStake, available);
            if (cost < minCost) {
                if (available >= minCost) cost = minCost;
                else continue;
            }
            const shares = cost / match.price;
            const pnl = shares * match.pnlPerShare;
            available -= cost;
            pendingPnl += pnl;
            opened += 1;
            trades += 1;
            if (match.won) wins += 1;
            else losses += 1;
            const day = new Date(epoch * 1000).toISOString().slice(0, 10);
            const stat = dayStats.get(day) || { trades: 0, wins: 0, losses: 0, pnl: 0 };
            stat.trades += 1;
            stat.wins += match.won ? 1 : 0;
            stat.losses += match.won ? 0 : 1;
            stat.pnl += pnl;
            dayStats.set(day, stat);
        }
        bankroll += pendingPnl;
        peak = Math.max(peak, bankroll);
        minBankroll = Math.min(minBankroll, bankroll);
        if (peak > 0) maxDrawdownPct = Math.max(maxDrawdownPct, (peak - bankroll) / peak);
        if (bankroll <= 0) {
            bankroll = 0;
            break;
        }
    }
    return {
        label,
        startBankroll: round(BANKROLL, 4),
        endBankroll: round(bankroll, 4),
        profit: round(bankroll - BANKROLL, 4),
        minBankroll: round(minBankroll, 4),
        maxDrawdownPct: round(maxDrawdownPct, 4),
        trades,
        wins,
        losses,
        winRate: trades ? wins / trades : 0,
        days: [...dayStats.entries()].map(([day, stat]) => ({ day, ...stat, pnl: round(stat.pnl, 4) })),
    };
}

function projection(summary, label) {
    const tradesPerDay = summary.triggers / DAYS;
    const avgCost = Math.max(0.62, summary.avgEntry || 0.68);
    const daily = [];
    let bankroll = BANKROLL;
    for (let day = 1; day <= 7; day += 1) {
        const costPerTrade = Math.max(5 * avgCost, bankroll * 0.15);
        const shares = costPerTrade / avgCost;
        const dailyPnl = tradesPerDay * shares * summary.avgPnlPerShare;
        bankroll += dailyPnl;
        daily.push({ day, tradesPerDay: round(tradesPerDay, 2), dailyPnl: round(dailyPnl, 2), endBankroll: round(bankroll, 2) });
    }
    return { label, day7Bankroll: round(bankroll, 2), daily };
}

async function main() {
    ensureDir(OUT_DIR);
    const cache = loadCache();
    const existing = new Map((cache.cycles || []).map((cycle) => [cycle.key, cycle]));
    const tasks = plannedCycles().filter((task) => !existing.has(`${task.epoch}_${task.asset}`));
    console.log(`[definitive-search] days=${DAYS} assets=${ASSETS.join(',')} existing=${existing.size} missing=${tasks.length}`);
    if (tasks.length) {
        const fetched = (await mapLimit(tasks, CONCURRENCY, fetchCycle)).filter(Boolean);
        for (const cycle of fetched) existing.set(cycle.key, cycle);
        saveCache({ generatedAt: new Date().toISOString(), days: DAYS, assets: ASSETS, cycles: [...existing.values()] });
    }

    const cycles = [...existing.values()].filter((cycle) => cycle && ASSETS.includes(cycle.asset));
    const observations = buildObservations(cycles);
    const rules = scanRules(observations);
    const selected = selectedSet(rules, observations);
    const current = evaluateStrategyFile(CURRENT_STRATEGY_FILE, observations);
    const currentStrategies = strategyRowsFromFile(CURRENT_STRATEGY_FILE);
    const selectedStrategies = strategyRowsFromSelected(selected);
    const candidateSummary = summarise(selected.flatMap((rule) => observations.filter((obs) => {
        const assetOk = rule.asset === 'ALL' || rule.asset === obs.asset;
        return assetOk
            && rule.utcHour === obs.utcHour
            && rule.entryMinute === obs.entryMinute
            && rule.direction === obs.direction
            && obs.price >= rule.priceMin
            && obs.price <= rule.priceMax;
    })));

    const timestamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
    const strategyPath = path.join(ROOT, 'strategies', `strategy_set_15m_definitive_search_${timestamp}.json`);
    const strategyArtifact = {
        generatedAt: new Date().toISOString(),
        method: 'broad recent 15m resolved-market search with adverse fill, fees, Wilson LCB, and 3d freshness checks; not a profit guarantee',
        source: {
            days: DAYS,
            assets: ASSETS,
            cycles: cycles.length,
            observations: observations.length,
            cacheFile: path.relative(ROOT, CACHE_FILE).replace(/\\/g, '/'),
        },
        selectionCriteria: { MIN_TRIGGER_3D, MIN_TRIGGER_7D, MIN_TRAIN_TRIGGER, MIN_WR_7D, MIN_LCB_7D, MIN_AVG_PNL, MAX_STRATEGIES },
        strategies: selected.map((rule, index) => ({
            id: 9000 + index + 1,
            name: `DEF15_H${rule.utcHour}M${rule.entryMinute}_${rule.direction}_${rule.asset}_${Math.round(rule.priceMin * 100)}_${Math.round(rule.priceMax * 100)}`,
            family: 'definitive_recent_search',
            utcHour: rule.utcHour,
            entryMinute: rule.entryMinute,
            direction: rule.direction,
            priceMin: rule.priceMin,
            priceMax: rule.priceMax,
            asset: rule.asset,
            winRate: rule.all.winRate,
            winRateLCB: rule.all.wilsonLCB95,
            pWinEstimate: rule.all.winRate,
            evWinEstimate: rule.all.wilsonLCB95,
            holdoutEvents: rule.all.triggers,
            holdoutEV: rule.all.avgPnlPerShare,
            tier: rule.all.wilsonLCB95 >= 0.65 ? 'STRONG' : 'VIABLE',
            timeframe: '15m',
            definitiveSearchAudit: rule,
        })),
        conditions: {
            hardEntryPriceCap: 0.82,
            minWilsonLCB: MIN_LCB_7D,
            feeModel: 'shares × 0.072 × price × (1-price)',
            slippagePct: SLIPPAGE_PCT,
            adverseStressSlippage: ADVERSE_FILL_CENTS,
        },
        stats: {
            selectedRules: selected.length,
            candidateSummary,
            currentSummary: current,
        },
    };
    fs.writeFileSync(strategyPath, JSON.stringify(strategyArtifact, null, 2));

    const report = {
        generatedAt: new Date().toISOString(),
        verdict: {
            promoted: false,
            reason: selected.length ? 'candidate generated for review; promote only if it materially beats current after governance review' : 'no broad candidate passed the gates',
            meets500MostLikely7d: false,
        },
        source: strategyArtifact.source,
        current,
        topRules: rules.slice(0, 50),
        selected,
        candidateSummary,
        projections: [
            current ? projection(current, 'current fresh realised-mean') : null,
            selected.length ? projection(candidateSummary, 'candidate fresh realised-mean') : null,
            selected.length ? projection({ ...candidateSummary, avgPnlPerShare: Math.min(candidateSummary.avgPnlPerShare, (candidateSummary.wilsonLCB95 - 0.5) * 0.65) }, 'candidate LCB-penalised') : null,
        ].filter(Boolean),
        chronologicalSimulations: [
            currentStrategies.length ? simulateChronological(currentStrategies, observations, 'current production constraints') : null,
            selectedStrategies.length ? simulateChronological(selectedStrategies, observations, 'candidate production constraints') : null,
        ].filter(Boolean),
        strategyArtifact: path.relative(ROOT, strategyPath).replace(/\\/g, '/'),
    };
    const reportPath = path.join(OUT_DIR, `definitive_15m_strategy_search_${timestamp}.json`);
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ reportPath: path.relative(ROOT, reportPath), strategyArtifact: report.strategyArtifact, current, candidateSummary, projections: report.projections }, null, 2));
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});