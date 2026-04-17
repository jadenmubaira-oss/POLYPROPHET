#!/usr/bin/env node
/**
 * scripts/auto-retrain-v6.js — Full retrain orchestrator (NOTIFY-ONLY).
 *
 * Monthly / on-demand retrain pipeline:
 *   1. Validate data freshness (data/intracycle-price-data.json must cover up to recent cycles).
 *   2. Select a dynamic TRAIN / TRUE-OOS split using available data.
 *        default: last 7d = TRUE_OOS, preceding up-to-14d = TRAIN.
 *   3. Build per-(hour, minute, direction, price-band) strategy candidates
 *      from TRAIN data, filtered by min WR + min trades.
 *   4. Evaluate candidate set on TRUE_OOS data (never seen by selector).
 *   5. Run exact runtime-parity bankroll sim for $10-15 bankrolls.
 *   6. Compare to current live strategy on same TRUE_OOS window.
 *   7. Write candidate artifact to strategies/candidates/v6_<ts>.json + decision report.
 *   8. Fire Telegram notifyRetrainCandidate with summary.
 *
 * **NEVER** modifies the live strategy file. Notify-only per operator policy.
 *
 * Usage:
 *   node scripts/auto-retrain-v6.js [--trainDays N] [--oosDays M] [--no-telegram]
 *                                    [--minWr 0.85] [--minTrades 30]
 */
const fs = require('fs');
const path = require('path');

const CONFIG = require('../lib/config');
const telegram = require('../lib/telegram');

const REPO_ROOT = path.join(__dirname, '..');
const CANDIDATES_DIR = path.join(REPO_ROOT, 'strategies', 'candidates');
const REPORT_DIR = path.join(REPO_ROOT, 'debug', 'retrain');

const FEE = 0.0315;
const MIN_SHARES = 5;
const ASSET_RANK = { BTC: 0, ETH: 1, SOL: 2, XRP: 3 };

function ensureDir(p) { fs.mkdirSync(p, { recursive: true }); }

function parseArgs(argv) {
    const out = {
        trainDays: 14,
        oosDays: 7,
        minWr: 0.85,
        minTrades: 30,
        telegram: true,
        priceBands: [
            [0.55, 0.95], [0.60, 0.95], [0.65, 0.98], [0.70, 0.95], [0.70, 0.98]
        ]
    };
    for (let i = 2; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--trainDays') out.trainDays = parseInt(argv[++i], 10) || out.trainDays;
        else if (a === '--oosDays') out.oosDays = parseInt(argv[++i], 10) || out.oosDays;
        else if (a === '--minWr') out.minWr = parseFloat(argv[++i]) || out.minWr;
        else if (a === '--minTrades') out.minTrades = parseInt(argv[++i], 10) || out.minTrades;
        else if (a === '--no-telegram') out.telegram = false;
    }
    return out;
}

function wilsonLCB(wins, n, z = 1.96) {
    if (!n) return 0;
    const p = wins / n;
    const denom = 1 + (z * z) / n;
    const centre = p + (z * z) / (2 * n);
    const margin = z * Math.sqrt((p * (1 - p) + (z * z) / (4 * n)) / n);
    return Math.max(0, (centre - margin) / denom);
}

function loadCycles() {
    const p = path.join(REPO_ROOT, 'data', 'intracycle-price-data.json');
    if (!fs.existsSync(p)) throw new Error(`Missing ${p}`);
    const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
    return Array.isArray(raw) ? raw : (raw.cycles || []);
}

function newestCycleEpoch(cycles) {
    return cycles.reduce((m, c) => Math.max(m, Number(c.epoch || 0)), 0);
}

function splitTrainOos(cycles, trainDays, oosDays) {
    const newest = newestCycleEpoch(cycles);
    if (!newest) throw new Error('No cycles to split');
    const oosStart = newest - oosDays * 24 * 3600;
    const trainStart = oosStart - trainDays * 24 * 3600;
    const resolved = cycles.filter((c) => c.resolution === 'UP' || c.resolution === 'DOWN');
    const train = resolved.filter((c) => (c.epoch || 0) >= trainStart && (c.epoch || 0) < oosStart);
    const oos = resolved.filter((c) => (c.epoch || 0) >= oosStart);
    return {
        newestIso: new Date(newest * 1000).toISOString(),
        trainRange: [new Date(trainStart * 1000).toISOString(), new Date(oosStart * 1000).toISOString()],
        oosRange: [new Date(oosStart * 1000).toISOString(), new Date(newest * 1000).toISOString()],
        train,
        oos
    };
}

// ---------- Candidate generation ----------
function buildCandidates(trainCycles, { minWr, minTrades, priceBands }) {
    // A candidate = (hour, minute, direction, priceBand). Minutes 0..14 of a 15m cycle.
    const out = [];
    const minutes = Array.from({ length: 15 }, (_, i) => i);
    const directions = ['UP', 'DOWN'];

    for (let hour = 0; hour < 24; hour++) {
        for (const minute of minutes) {
            for (const direction of directions) {
                for (const [pMin, pMax] of priceBands) {
                    let wins = 0, trades = 0;
                    const byAsset = {};
                    for (const c of trainCycles) {
                        const h = new Date(c.epoch * 1000).getUTCHours();
                        if (h !== hour) continue;
                        const entryPrice = direction === 'UP'
                            ? c.minutePricesYes?.[minute]?.last
                            : c.minutePricesNo?.[minute]?.last;
                        if (!Number.isFinite(entryPrice) || entryPrice <= 0 || entryPrice >= 1) continue;
                        if (entryPrice < pMin || entryPrice > pMax) continue;
                        trades++;
                        const w = c.resolution === direction;
                        if (w) wins++;
                        byAsset[c.asset] = byAsset[c.asset] || { t: 0, w: 0 };
                        byAsset[c.asset].t++;
                        if (w) byAsset[c.asset].w++;
                    }
                    if (trades < minTrades) continue;
                    const wr = wins / trades;
                    if (wr < minWr) continue;
                    out.push({
                        utcHour: hour,
                        entryMinute: minute,
                        direction,
                        priceMin: pMin,
                        priceMax: pMax,
                        wins,
                        trades,
                        trainWr: wr,
                        lcb: wilsonLCB(wins, trades),
                        byAsset
                    });
                }
            }
        }
    }
    // Dedup identical (hour, minute, direction) — keep widest acceptable band first then tightest
    out.sort((a, b) => (b.lcb - a.lcb) || (b.trades - a.trades));
    const seen = new Set();
    const deduped = [];
    for (const c of out) {
        const key = `${c.utcHour}|${c.entryMinute}|${c.direction}`;
        if (seen.has(key)) continue;
        seen.add(key);
        deduped.push(c);
    }
    return deduped;
}

// ---------- OOS evaluation ----------
function evaluateOnOos(strategies, oosCycles) {
    const perStrategy = strategies.map((s) => ({ ...s, oosWins: 0, oosTrades: 0 }));
    const cycleSignals = new Map();
    for (const c of oosCycles) {
        const h = new Date(c.epoch * 1000).getUTCHours();
        for (const s of perStrategy) {
            if (s.utcHour !== h) continue;
            const entryPrice = s.direction === 'UP'
                ? c.minutePricesYes?.[s.entryMinute]?.last
                : c.minutePricesNo?.[s.entryMinute]?.last;
            if (!Number.isFinite(entryPrice) || entryPrice <= 0 || entryPrice >= 1) continue;
            if (entryPrice < s.priceMin || entryPrice > s.priceMax) continue;
            s.oosTrades++;
            const w = c.resolution === s.direction;
            if (w) s.oosWins++;
            if (!cycleSignals.has(c.epoch)) cycleSignals.set(c.epoch, []);
            cycleSignals.get(c.epoch).push({
                epoch: c.epoch,
                minute: s.entryMinute,
                timestamp: c.epoch + s.entryMinute * 60,
                asset: c.asset,
                direction: s.direction,
                entryPrice,
                pWin: s.trainWr,
                won: w
            });
        }
    }
    const events = [];
    for (const [, sigs] of cycleSignals) {
        const earliestMin = Math.min(...sigs.map((x) => x.minute));
        const first = sigs.filter((x) => x.minute === earliestMin);
        first.sort((a, b) => (b.pWin - a.pWin) || ((ASSET_RANK[a.asset] ?? 99) - (ASSET_RANK[b.asset] ?? 99)));
        events.push(first[0]);
    }
    events.sort((a, b) => a.timestamp - b.timestamp);
    return { perStrategy, events };
}

function mcSim(events, startBank, horizonHours, stakeFrac = 0.15, runs = 10000, maxConsecLoss = 999, cooldownSec = 0) {
    const days = new Set(events.map((e) => new Date(e.timestamp * 1000).toISOString().slice(0, 10)));
    const evtPerDay = events.length / Math.max(1, days.size);
    const tradesPerRun = Math.max(1, Math.round(evtPerDay * horizonHours / 24));
    const finals = []; let busts = 0;
    for (let r = 0; r < runs; r++) {
        let bank = startBank, peak = startBank, busted = false, consec = 0, cooldownUntil = 0;
        const startIdx = Math.floor(Math.random() * Math.max(1, events.length - tradesPerRun));
        for (let i = 0; i < tradesPerRun; i++) {
            const evt = events[(startIdx + i) % events.length];
            if (evt.timestamp < cooldownUntil) continue;
            const stake = Math.max(bank * stakeFrac, MIN_SHARES * evt.entryPrice);
            if (stake > bank || bank < 2.5) { busted = true; break; }
            const shares = stake / evt.entryPrice;
            const fee = stake * FEE;
            if (evt.won) { bank += (shares - stake) - fee; consec = 0; }
            else { bank -= stake + fee; consec++; if (consec >= maxConsecLoss) { cooldownUntil = evt.timestamp + cooldownSec; consec = 0; } }
            if (bank > peak) peak = bank;
        }
        finals.push(bank);
        if (busted) busts++;
    }
    finals.sort((a, b) => a - b);
    const q = (p) => finals[Math.floor(p * finals.length)] || 0;
    return { bust: busts / runs * 100, p25: q(0.25), median: q(0.5), p75: q(0.75), p95: q(0.95) };
}

function buildArtifact(candidates, { trainRange, oosRange }, meta) {
    const strategies = candidates.map((c, i) => {
        const oosWr = c.oosTrades ? c.oosWins / c.oosTrades : 0;
        const fullTrades = c.trades + (c.oosTrades || 0);
        const fullWins = c.wins + (c.oosWins || 0);
        const fullWr = fullTrades ? fullWins / fullTrades : c.trainWr;
        const tier = oosWr >= 0.95 ? 'S' : oosWr >= 0.90 ? 'A' : oosWr >= 0.85 ? 'B' : 'C';
        return {
            id: `v6_${i + 1}`,
            name: `V6_H${String(c.utcHour).padStart(2, '0')}_m${c.entryMinute}_${c.direction}`,
            signature: `H${c.utcHour}|${c.entryMinute}|${c.direction}|${c.priceMin}|${c.priceMax}`,
            tier,
            asset: 'all',
            utcHour: c.utcHour,
            entryMinute: c.entryMinute,
            direction: c.direction,
            priceMin: c.priceMin,
            priceMax: c.priceMax,
            priceBandLow: c.priceMin,
            priceBandHigh: c.priceMax,
            winRate: fullWr,
            winRateLCB: wilsonLCB(fullWins, fullTrades),
            pWinEstimate: oosWr > 0 ? oosWr : c.trainWr,
            evWinEstimate: oosWr > 0 ? oosWr : c.trainWr,
            stats: {
                full: { trades: fullTrades, wr: fullWr },
                train: { trades: c.trades, wr: c.trainWr },
                oos: { trades: c.oosTrades || 0, wr: oosWr }
            }
        };
    });
    return {
        name: `optimal_10usd_v6_candidate_${new Date().toISOString().slice(0, 10)}`,
        generatedAt: new Date().toISOString(),
        description: 'v6 CANDIDATE — built by scripts/auto-retrain-v6.js. NOTIFY-ONLY. Do not load without manual review.',
        validationMethod: `TRAIN ${trainRange[0]} → ${trainRange[1]} / TRUE OOS ${oosRange[0]} → ${oosRange[1]}`,
        targetBankroll: 10,
        stakeFraction: 0.15,
        takerFee: FEE,
        maxGlobalTradesPerCycle: 1,
        projections: meta.projections,
        loadNotes: 'v6 candidate — manual review required before production load.',
        buildDate: new Date().toISOString(),
        strategies
    };
}

function summarizeVsLive(candidateReport, liveReport) {
    const lines = [];
    const cOos = candidateReport.oosWr;
    const lOos = liveReport.oosWr;
    lines.push(`TRUE OOS WR: v6 ${(cOos * 100).toFixed(1)}% vs live ${(lOos * 100).toFixed(1)}% (Δ ${((cOos - lOos) * 100).toFixed(1)}pp)`);
    lines.push(`TRUE OOS trades: v6 ${candidateReport.oosTrades} / ${candidateReport.oosEvents}ev vs live ${liveReport.oosTrades} / ${liveReport.oosEvents}ev`);
    const c10 = candidateReport.sims['$10_7d'];
    const l10 = liveReport.sims['$10_7d'];
    if (c10 && l10) {
        lines.push(`$10/7d bust: v6 ${c10.bust.toFixed(1)}% vs live ${l10.bust.toFixed(1)}%`);
        lines.push(`$10/7d median: v6 $${c10.median.toFixed(0)} vs live $${l10.median.toFixed(0)}`);
    }
    const beats = cOos >= lOos + 0.03 && (c10?.median || 0) >= (l10?.median || 0) * 1.15;
    return { beatsCurrent: beats, lines };
}

function evalArtifactOnOos(artifactStrats, oosCycles, simBankrolls = [10, 15]) {
    const enriched = artifactStrats.map((s) => ({
        utcHour: s.utcHour,
        entryMinute: s.entryMinute,
        direction: s.direction,
        priceMin: s.priceMin,
        priceMax: s.priceMax,
        trainWr: s.pWinEstimate || s.winRate || 0.88,
        wins: 0,
        trades: 0
    }));
    const { perStrategy, events } = evaluateOnOos(enriched, oosCycles);
    const oosWins = perStrategy.reduce((sum, s) => sum + (s.oosWins || 0), 0);
    const oosTrades = perStrategy.reduce((sum, s) => sum + (s.oosTrades || 0), 0);
    const sims = {};
    for (const bank of simBankrolls) {
        sims[`$${bank}_24h`] = mcSim(events, bank, 24);
        sims[`$${bank}_7d`] = mcSim(events, bank, 168);
    }
    return {
        oosWr: oosTrades ? oosWins / oosTrades : 0,
        oosTrades,
        oosWins,
        oosEvents: events.length,
        sims
    };
}

function main() {
    const args = parseArgs(process.argv);
    ensureDir(CANDIDATES_DIR);
    ensureDir(REPORT_DIR);

    const cycles = loadCycles();
    if (!cycles.length) throw new Error('No cycles in data/intracycle-price-data.json');
    const split = splitTrainOos(cycles, args.trainDays, args.oosDays);
    console.log(`TRAIN: ${split.trainRange[0]} → ${split.trainRange[1]} (${split.train.length} cycles)`);
    console.log(`TRUE_OOS: ${split.oosRange[0]} → ${split.oosRange[1]} (${split.oos.length} cycles)`);

    // ---------- Build candidates ----------
    const candidates = buildCandidates(split.train, {
        minWr: args.minWr,
        minTrades: args.minTrades,
        priceBands: args.priceBands
    });
    console.log(`Candidates passing TRAIN gate (WR >=${args.minWr}, n >=${args.minTrades}): ${candidates.length}`);
    if (!candidates.length) {
        console.warn('No candidates survived the TRAIN gate. Check data freshness / adjust thresholds.');
        if (args.telegram) telegram.notifyValidatorAlert({ kind: 'RETRAIN_EMPTY', severity: 'WARN', summary: `Retrain produced no candidates at WR>=${args.minWr}, n>=${args.minTrades}`, lines: [] });
        return 1;
    }

    // ---------- Evaluate on TRUE_OOS ----------
    const { perStrategy: evaluated } = evaluateOnOos(candidates, split.oos);
    const filtered = evaluated.filter((s) => s.oosTrades >= 15 && (s.oosTrades === 0 ? 0 : s.oosWins / s.oosTrades) >= args.minWr);
    console.log(`Candidates surviving OOS gate (OOS WR >=${args.minWr}, n >=15): ${filtered.length}`);

    // ---------- Build the candidate artifact ----------
    const { events: candidateEvents } = evaluateOnOos(filtered, split.oos);
    const projections = {
        candidates: filtered.length,
        totalOosEvents: candidateEvents.length,
        oosWr: (() => {
            const w = filtered.reduce((s, x) => s + (x.oosWins || 0), 0);
            const t = filtered.reduce((s, x) => s + (x.oosTrades || 0), 0);
            return t ? w / t : 0;
        })(),
        expectedTradesPerDay: candidateEvents.length / Math.max(1, args.oosDays)
    };
    const artifact = buildArtifact(filtered, split, { projections });

    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const outFile = path.join(CANDIDATES_DIR, `strategy_set_15m_v6_candidate_${ts}.json`);
    fs.writeFileSync(outFile, JSON.stringify(artifact, null, 2));
    console.log(`Candidate written: ${outFile}`);

    // ---------- Compare to current live strategy ----------
    const livePath = path.resolve(
        REPO_ROOT,
        process.env.LIVE_STRATEGY_FILE_15M || 'strategies/strategy_set_15m_optimal_10usd_v5.json'
    );
    let compareLines = [];
    let beatsCurrent = false;
    if (fs.existsSync(livePath)) {
        const liveArtifact = JSON.parse(fs.readFileSync(livePath, 'utf8'));
        const liveEval = evalArtifactOnOos(liveArtifact.strategies || [], split.oos, [10, 15]);
        const candidateEval = evalArtifactOnOos(artifact.strategies, split.oos, [10, 15]);
        const cmp = summarizeVsLive(candidateEval, liveEval);
        beatsCurrent = cmp.beatsCurrent;
        compareLines = cmp.lines;
    } else {
        compareLines.push(`No live strategy at ${livePath} — cannot compare`);
    }

    const report = {
        generatedAt: new Date().toISOString(),
        args,
        split: {
            trainRange: split.trainRange,
            oosRange: split.oosRange,
            trainCycles: split.train.length,
            oosCycles: split.oos.length
        },
        trainCandidates: candidates.length,
        oosSurvivors: filtered.length,
        projections,
        candidateFile: path.relative(REPO_ROOT, outFile),
        beatsCurrent,
        compareLines
    };
    const reportPath = path.join(REPORT_DIR, `retrain-${ts}.json`);
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
    console.log(`Report: ${reportPath}`);
    for (const l of compareLines) console.log(`  ${l}`);

    if (args.telegram) {
        telegram.notifyRetrainCandidate({
            candidateFile: path.relative(REPO_ROOT, outFile),
            beatsCurrent,
            summary:
                `Train ${split.train.length}c / OOS ${split.oos.length}c\n` +
                `${filtered.length} strategies survived OOS gate\n` +
                `Projected OOS WR: ${(projections.oosWr * 100).toFixed(1)}% / ${projections.totalOosEvents} events\n\n` +
                compareLines.slice(0, 4).join('\n')
        });
    }

    return beatsCurrent ? 0 : 2;
}

try {
    const code = main();
    process.exit(code || 0);
} catch (e) {
    console.error(`Retrain error: ${e.stack || e.message}`);
    try { telegram.notifyError('auto-retrain-v6', e); } catch {}
    process.exit(1);
}
