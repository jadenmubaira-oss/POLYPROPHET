#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const CONFIG = require('../lib/config');
const { loadStrategySet, evaluateMatch } = require('../lib/strategy-matcher');

const ROOT = path.resolve(__dirname, '..');
const STRATEGY_REL = 'strategies/strategy_set_5m_canary_0.json';
const STRATEGY_PATH = path.join(ROOT, STRATEGY_REL);
const PAPER_SHADOW_DIR = path.join(ROOT, 'data', 'paper-shadow');
const OUT_DIR = path.join(ROOT, 'debug', 'canary-runtime-audit');
const CORE_ASSETS = new Set(['BTC', 'ETH', 'SOL', 'XRP']);

function walkJsonl(dir) {
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) return walkJsonl(fullPath);
        return entry.name.endsWith('.jsonl') ? [fullPath] : [];
    });
}

function normalizeOutcome(value) {
    const normalized = String(value || '').trim().toUpperCase();
    if (normalized === 'YES' || normalized === 'UP') return 'YES';
    if (normalized === 'NO' || normalized === 'DOWN') return 'NO';
    return null;
}

function isRuntimeRecognizedStructural(strategy) {
    return String(strategy?.kind || strategy?.type || '').toUpperCase() === 'STRUCTURAL'
        || String(strategy?.kind || strategy?.type || '').toUpperCase() === 'CEX_MOMENTUM_POLYMARKET_LAG'
        || strategy?.structuralEdge?.enabled === true;
}

function getSignalAsk(record) {
    const direction = String(record?.structural?.direction || '').toUpperCase();
    if (direction === 'UP') return Number(record.bestAsk);
    if (direction === 'DOWN') return Number(record.noBestAsk || record.noPrice);
    return NaN;
}

function parsePaperShadow() {
    const files = walkJsonl(PAPER_SHADOW_DIR).filter((file) => file.includes('5m'));
    const cycles = new Map();
    const settlements = new Map();
    let lines = 0;
    let ticks = 0;
    let settlementRows = 0;

    for (const file of files) {
        const text = fs.readFileSync(file, 'utf8');
        for (const line of text.split(/\r?\n/).filter(Boolean)) {
            lines += 1;
            let record;
            try {
                record = JSON.parse(line);
            } catch {
                continue;
            }
            const key = `${record.asset}:${record.tf}:${record.epoch}`;
            if (record.__settlement__ || record.type === 'settlement') {
                settlementRows += 1;
                const outcome = normalizeOutcome(record.outcome || record.resolution);
                if (outcome) settlements.set(key, outcome);
                continue;
            }
            if (record.tf !== '5m') continue;
            ticks += 1;
            const secondsIntoEpoch = Number.isFinite(Number(record.secondsIntoEpoch))
                ? Number(record.secondsIntoEpoch)
                : (Number(record.ts) ? Number(record.ts) - Number(record.epoch) : null);
            if (!cycles.has(key)) {
                cycles.set(key, {
                    asset: String(record.asset || '').toUpperCase(),
                    tf: record.tf,
                    epoch: Number(record.epoch),
                    ticks: [],
                });
            }
            cycles.get(key).ticks.push({
                secondsIntoEpoch,
                iso: record.iso || null,
                direction: String(record.structural?.direction || '').toUpperCase(),
                absMoveBps: Math.abs(Number(record.structural?.absMoveBps ?? record.structural?.moveBps ?? 0)),
                structuralOk: Boolean(record.structural?.ok),
                ask: getSignalAsk(record),
            });
        }
    }

    return { files, lines, ticks, settlementRows, settlements, cycles };
}

function countOpportunities(cycles, settlements, options) {
    const out = [];
    for (const [key, cycle] of cycles.entries()) {
        if (options.coreAssetsOnly && !CORE_ASSETS.has(cycle.asset)) continue;
        const ticks = [...cycle.ticks].sort((a, b) => (a.secondsIntoEpoch ?? 0) - (b.secondsIntoEpoch ?? 0));
        const tick = ticks.find((item) => {
            if (!item.structuralOk) return false;
            if (item.absMoveBps <= 10) return false;
            if (item.secondsIntoEpoch < options.secondMin || item.secondsIntoEpoch > options.secondMax) return false;
            if (options.requireSanePrice && item.ask < 0.05) return false;
            if (!(item.ask <= 0.85)) return false;
            return true;
        });
        if (!tick) continue;
        const settlement = settlements.get(key) || null;
        const win = settlement
            ? ((tick.direction === 'UP' && settlement === 'YES') || (tick.direction === 'DOWN' && settlement === 'NO'))
            : null;
        out.push({ key, asset: cycle.asset, epoch: cycle.epoch, ...tick, settlement, win });
    }
    const settled = out.filter((item) => item.win !== null);
    const wins = settled.filter((item) => item.win).length;
    return {
        count: out.length,
        settled: settled.length,
        wins,
        losses: settled.length - wins,
        winRate: settled.length ? wins / settled.length : null,
        byAsset: out.reduce((acc, item) => {
            acc[item.asset] = (acc[item.asset] || 0) + 1;
            return acc;
        }, {}),
        sample: out.slice(0, 20),
    };
}

function runtimeProbe() {
    const loadedCount = loadStrategySet('5m', STRATEGY_REL);
    const timeframe = { key: '5m', seconds: 300 };
    const epoch = 1779000000 - (1779000000 % 300);
    const structuralContext = {
        BTC: { ok: true, direction: 'UP', moveBps: 12, absMoveBps: 12, dataAgeSec: 5 },
    };
    const market = { asset: 'BTC', yesPrice: 0.5, noPrice: 0.5, slug: 'test-btc', conditionId: '0xtest' };
    const seconds = [181, 194, 241, 254, 255];
    return {
        loadedCount,
        probes: seconds.map((second) => {
            const matches = evaluateMatch(market, epoch + second, timeframe, structuralContext);
            return {
                secondsIntoEpoch: second,
                entryMinute: Math.floor(second / 60),
                entrySecond: second % 60,
                secondsUntilClose: 300 - second,
                closeGuardBlockSeconds: CONFIG.RISK?.minEntrySecondsBeforeClose?.['5m'] ?? null,
                matches: matches.length,
                matchNames: matches.map((match) => match.name),
            };
        }),
    };
}

function main() {
    if (!fs.existsSync(STRATEGY_PATH)) throw new Error(`Missing ${STRATEGY_REL}`);
    fs.mkdirSync(OUT_DIR, { recursive: true });

    const strategyPayload = JSON.parse(fs.readFileSync(STRATEGY_PATH, 'utf8'));
    const strategies = Array.isArray(strategyPayload.strategies) ? strategyPayload.strategies : [];
    const schemaAudit = strategies.map((strategy) => ({
        id: strategy.id,
        kind: strategy.kind,
        direction: strategy.direction,
        recognizedStructural: isRuntimeRecognizedStructural(strategy),
        directionValidWithStructuralSubstitution: ['UP', 'DOWN', 'ANY'].includes(String(strategy.direction || '').toUpperCase()),
        entryMinuteMin: strategy.entryMinuteMin,
        entryMinuteMax: strategy.entryMinuteMax,
        entrySecondMin: strategy.entrySecondMin,
        entrySecondMax: strategy.entrySecondMax,
        requireClosedCandle: strategy.requireClosedCandle,
    }));

    const paper = parsePaperShadow();
    const claimedWindowRawAllAssets = countOpportunities(paper.cycles, paper.settlements, {
        secondMin: 241,
        secondMax: 254,
        requireSanePrice: false,
        coreAssetsOnly: false,
    });
    const claimedWindowSaneAllAssets = countOpportunities(paper.cycles, paper.settlements, {
        secondMin: 241,
        secondMax: 254,
        requireSanePrice: true,
        coreAssetsOnly: false,
    });
    const claimedWindowSaneCoreAssets = countOpportunities(paper.cycles, paper.settlements, {
        secondMin: 241,
        secondMax: 254,
        requireSanePrice: true,
        coreAssetsOnly: true,
    });
    const artifactWholeWindowSaneCoreAssets = countOpportunities(paper.cycles, paper.settlements, {
        secondMin: 181,
        secondMax: 254,
        requireSanePrice: true,
        coreAssetsOnly: true,
    });

    const probe = runtimeProbe();
    const issues = [];
    if (schemaAudit.some((item) => !item.recognizedStructural)) issues.push('CANARY_KIND_NOT_RECOGNIZED_BY_RUNTIME_STRUCTURAL_MATCHER');
    if (schemaAudit.some((item) => !item.directionValidWithStructuralSubstitution)) issues.push('CANARY_DIRECTION_NOT_SUPPORTED_BY_RUNTIME');
    if (probe.probes.every((item) => item.matches === 0)) issues.push('RUNTIME_PROBE_FOUND_ZERO_MATCHES_IN_CLAIMED_WINDOW');
    if (paper.settlementRows === 0) issues.push('LOCAL_PAPER_SHADOW_HAS_ZERO_SETTLEMENT_ROWS_FOR_WIN_RATE_REPRODUCTION');
    if (claimedWindowSaneCoreAssets.count !== 79) issues.push('LOCAL_STRICT_CORE_ASSET_OPPORTUNITY_COUNT_DOES_NOT_MATCH_DOCUMENTED_79');
    if (claimedWindowSaneCoreAssets.settled !== 24) issues.push('LOCAL_STRICT_CORE_ASSET_SETTLED_COUNT_DOES_NOT_MATCH_DOCUMENTED_24_EXECUTED');

    const report = {
        generatedAt: new Date().toISOString(),
        strategyFile: STRATEGY_REL,
        verdict: issues.length ? 'NO_GO_CANARY_NOT_RUNTIME_PROVEN' : 'CANARY_REPRODUCED_REQUIRES_LIVE_APPROVAL',
        issues,
        schemaAudit,
        runtimeProbe: probe,
        paperShadow: {
            files: paper.files.length,
            lines: paper.lines,
            ticks5m: paper.ticks,
            cycles5m: paper.cycles.size,
            settlementRows: paper.settlementRows,
            settlements: paper.settlements.size,
            claimedWindowRawAllAssets,
            claimedWindowSaneAllAssets,
            claimedWindowSaneCoreAssets,
            artifactWholeWindowSaneCoreAssets,
        },
    };

    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
    const reportPath = path.join(OUT_DIR, `canary_runtime_audit_${stamp}.json`);
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
    console.log(JSON.stringify({
        report: path.relative(ROOT, reportPath),
        verdict: report.verdict,
        issues,
        runtimeProbe: probe,
        paperShadowSummary: {
            files: report.paperShadow.files,
            ticks5m: report.paperShadow.ticks5m,
            cycles5m: report.paperShadow.cycles5m,
            settlementRows: report.paperShadow.settlementRows,
            claimedWindowRawAllAssets: report.paperShadow.claimedWindowRawAllAssets.count,
            claimedWindowSaneAllAssets: report.paperShadow.claimedWindowSaneAllAssets.count,
            claimedWindowSaneCoreAssets: report.paperShadow.claimedWindowSaneCoreAssets.count,
            claimedWindowSaneCoreSettled: report.paperShadow.claimedWindowSaneCoreAssets.settled,
        },
    }, null, 2));
}

main();
