const fs = require('fs');
const path = require('path');
const { simulateBankrollPath } = require('./hybrid_replay_backtest');

function readArgValue(name, fallback = null) {
    const prefix = `--${name}=`;
    const hit = process.argv.find(arg => String(arg).startsWith(prefix));
    return hit ? String(hit).slice(prefix.length) : fallback;
}

function parseBoolArg(name, fallback) {
    const raw = readArgValue(name, null);
    if (raw === null) return fallback;
    const v = String(raw).trim().toLowerCase();
    if (['1', 'true', 'yes', 'on'].includes(v)) return true;
    if (['0', 'false', 'no', 'off'].includes(v)) return false;
    return fallback;
}

function parseFloatArg(name, fallback) {
    const raw = readArgValue(name, null);
    if (raw === null) return fallback;
    const n = Number.parseFloat(String(raw));
    return Number.isFinite(n) ? n : fallback;
}

function parseOptionalFloatArg(name) {
    const raw = readArgValue(name, null);
    if (raw === null) return null;
    const n = Number.parseFloat(String(raw));
    return Number.isFinite(n) ? n : null;
}

function parseIntArg(name, fallback) {
    const raw = readArgValue(name, null);
    if (raw === null) return fallback;
    const n = Number.parseInt(String(raw), 10);
    return Number.isFinite(n) ? n : fallback;
}

function parseEpochArg(name) {
    const raw = readArgValue(name, null);
    if (raw === null) return null;
    const n = Number.parseInt(String(raw), 10);
    return Number.isFinite(n) ? n : null;
}

function clamp01(value, fallback = 0) {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.max(0, Math.min(1, n));
}

function normalizeAsset(asset) {
    return String(asset || '').trim().toUpperCase();
}

function isWildcardAsset(asset) {
    const a = normalizeAsset(asset);
    return a === '*' || a === 'ALL' || a === 'ANY';
}

function tierRank(tier) {
    const t = String(tier || '').trim().toUpperCase();
    if (t === 'PLATINUM') return 3;
    if (t === 'GOLD') return 2;
    if (t === 'SILVER') return 1;
    return 0;
}

function dayKeyUtc(epochSec) {
    if (!Number.isFinite(epochSec)) return null;
    return new Date(epochSec * 1000).toISOString().slice(0, 10);
}

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

function sortCandidatesDeterministically(a, b, gates) {
    const ta = tierRank(a?.strategyTier);
    const tb = tierRank(b?.strategyTier);
    if (ta !== tb) return tb - ta;

    const la = Number(a?.strategyWinRateLCB);
    const lb = Number(b?.strategyWinRateLCB);
    if (Number.isFinite(la) && Number.isFinite(lb) && la !== lb) return lb - la;

    const momA = Number.isFinite(Number(a?.momentum)) ? Number(a.momentum) : -Infinity;
    const momB = Number.isFinite(Number(b?.momentum)) ? Number(b.momentum) : -Infinity;
    const momMarginA = momA - Number(gates?.momentumMin || 0);
    const momMarginB = momB - Number(gates?.momentumMin || 0);
    if (momMarginA !== momMarginB) return momMarginB - momMarginA;

    const volA = Number.isFinite(Number(a?.volume)) ? Number(a.volume) : -Infinity;
    const volB = Number.isFinite(Number(b?.volume)) ? Number(b.volume) : -Infinity;
    const volMarginA = volA - Number(gates?.volumeMin || 0);
    const volMarginB = volB - Number(gates?.volumeMin || 0);
    if (volMarginA !== volMarginB) return volMarginB - volMarginA;

    const pxA = Number.isFinite(Number(a?.entryPrice)) ? Number(a.entryPrice) : Infinity;
    const pxB = Number.isFinite(Number(b?.entryPrice)) ? Number(b.entryPrice) : Infinity;
    const midA = (Number(a?.priceBandMin) + Number(a?.priceBandMax)) / 2;
    const midB = (Number(b?.priceBandMin) + Number(b?.priceBandMax)) / 2;
    const distA = Math.abs(pxA - midA);
    const distB = Math.abs(pxB - midB);
    if (distA !== distB) return distA - distB;

    const assetA = String(a?.asset || '').toUpperCase();
    const assetB = String(b?.asset || '').toUpperCase();
    if (assetA !== assetB) return assetA.localeCompare(assetB);

    const idA = Number(a?.strategyId);
    const idB = Number(b?.strategyId);
    if (Number.isFinite(idA) && Number.isFinite(idB) && idA !== idB) return idA - idB;

    return String(a?.id || '').localeCompare(String(b?.id || ''));
}

function createBufferedFileWriter(filePath, flushThresholdBytes = 4 * 1024 * 1024) {
    const fd = fs.openSync(filePath, 'w');
    let parts = [];
    let bytes = 0;
    const flush = () => {
        if (!parts.length) return;
        fs.writeSync(fd, parts.join(''));
        parts = [];
        bytes = 0;
    };
    return {
        write(text) {
            const str = String(text);
            parts.push(str);
            bytes += Buffer.byteLength(str);
            if (bytes >= flushThresholdBytes) flush();
        },
        end() {
            flush();
            fs.closeSync(fd);
        }
    };
}

function streamJsonArrayObjects(filePath, onObject, opts = {}) {
    const logEvery = Number.isFinite(opts.logEvery) ? opts.logEvery : 0;
    return new Promise((resolve, reject) => {
        let settled = false;
        const safeReject = (err) => {
            if (settled) return;
            settled = true;
            reject(err);
        };
        const safeResolve = (val) => {
            if (settled) return;
            settled = true;
            resolve(val);
        };
        if (!fs.existsSync(filePath)) {
            safeReject(new Error(`Missing file: ${filePath}`));
            return;
        }
        const rs = fs.createReadStream(filePath, { encoding: 'utf8', highWaterMark: 1024 * 1024 });
        let started = false;
        let inString = false;
        let escape = false;
        let depth = 0;
        let objBuf = '';
        let seen = 0;
        const fail = (err) => {
            try { rs.destroy(); } catch { }
            safeReject(err);
        };
        rs.on('data', chunk => {
            for (let i = 0; i < chunk.length; i++) {
                const ch = chunk[i];
                if (!started) {
                    if (ch === '[') started = true;
                    continue;
                }
                if (depth === 0) {
                    if (ch === '{') {
                        depth = 1;
                        objBuf = '{';
                        inString = false;
                        escape = false;
                    }
                    continue;
                }
                objBuf += ch;
                if (inString) {
                    if (escape) escape = false;
                    else if (ch === '\\') escape = true;
                    else if (ch === '"') inString = false;
                    continue;
                }
                if (ch === '"') {
                    inString = true;
                    continue;
                }
                if (ch === '{') {
                    depth += 1;
                    continue;
                }
                if (ch === '}') {
                    depth -= 1;
                    if (depth === 0) {
                        let obj;
                        try {
                            obj = JSON.parse(objBuf);
                        } catch (e) {
                            fail(new Error(`JSON.parse failed after ${seen} objects: ${String(e && e.message ? e.message : e)}`));
                            return;
                        }
                        seen += 1;
                        try {
                            const keepGoing = onObject(obj);
                            if (keepGoing === false) {
                                try { rs.destroy(); } catch { }
                                if (logEvery) process.stdout.write(`...parsed ${seen} rows\n`);
                                safeResolve(seen);
                                return;
                            }
                        } catch (e) {
                            fail(e instanceof Error ? e : new Error(String(e)));
                            return;
                        }
                        if (logEvery && seen % logEvery === 0) process.stdout.write(`...parsed ${seen} rows\r`);
                        objBuf = '';
                    }
                }
            }
        });
        rs.on('error', err => safeReject(err));
        rs.on('end', () => {
            if (logEvery) process.stdout.write(`...parsed ${seen} rows\n`);
            safeResolve(seen);
        });
    });
}

function loadStrategyRuntime(filePath) {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const strategies = Array.isArray(parsed?.strategies) ? parsed.strategies : [];
    const conditions = parsed?.conditions || {};
    const stats = parsed?.stats || null;
    return {
        enabled: strategies.length > 0,
        filePath,
        strategies,
        conditions,
        stats,
    };
}

function chooseOperatorPrimaryStageKey(bankroll, previousStageKey = null) {
    return 'growth_top7';
}

function resolveRuntimeRiskStage(bankroll, bankrollConfig) {
    const stage1 = Number.isFinite(Number(bankrollConfig.vaultTriggerBalance)) ? Number(bankrollConfig.vaultTriggerBalance) : 100;
    const stage2 = Number.isFinite(Number(bankrollConfig.stage2Threshold)) ? Number(bankrollConfig.stage2Threshold) : 500;
    const b = Number(bankroll);
    if (!Number.isFinite(b) || b < stage1) return 0;
    if (b < stage2) return 1;
    return 2;
}

function evaluateStrategySetMatchReplay(runtime, asset, direction, entryPrice, entryMinute, utcHour, momentum, volume, options = {}) {
    if (!runtime || runtime.enabled !== true) {
        return { passes: false, reason: 'OPERATOR_STRATEGY_SET_NOT_LOADED', blockedReason: 'OPERATOR_STRATEGY_SET_NOT_LOADED' };
    }
    const opts = {
        skipMomentumGate: true,
        forceVolumeGate: false,
        runtimeRiskProfileStage: 0,
        ...options,
    };
    const assetUpper = normalizeAsset(asset);
    const dirUpper = String(direction || '').trim().toUpperCase();
    const dirMatch = (dirUpper === 'DOWN' || dirUpper === 'DN') ? 'DOWN' : 'UP';
    const em = Number(entryMinute);
    const uh = Number(utcHour);
    const px = Number(entryPrice);
    if (!Number.isFinite(px)) return { passes: false, reason: 'NO_ENTRY_PRICE', blockedReason: 'NO_ENTRY_PRICE' };
    const cond = runtime.conditions || {};
    const momentumMin = Number.isFinite(Number(cond.momentumMin)) ? Number(cond.momentumMin) : 0;
    const volumeMin = Number.isFinite(Number(cond.volumeMin)) ? Number(cond.volumeMin) : 100;
    const disableMomentumGateEnv = ['1', 'true', 'yes', 'on'].includes(String(process.env.STRATEGY_DISABLE_MOMENTUM_GATE || '').trim().toLowerCase());
    const disableVolumeGateEnv = ['1', 'true', 'yes', 'on'].includes(String(process.env.STRATEGY_DISABLE_VOLUME_GATE || '').trim().toLowerCase());
    const deferVolumeGate = Number(opts.runtimeRiskProfileStage) === 0;
    const applyMomentumGate = !opts.skipMomentumGate && !disableMomentumGateEnv && cond.applyMomentumGate === true;
    const applyVolumeGate = !deferVolumeGate && !disableVolumeGateEnv && (opts.forceVolumeGate === true || cond.applyVolumeGate === true);
    if (applyMomentumGate) {
        const mom = Number(momentum);
        if (momentum !== null && momentum !== undefined && Number.isFinite(mom) && mom <= momentumMin) {
            return {
                passes: false,
                reason: `LOW_MOMENTUM: ${(mom * 100).toFixed(1)}% < ${(momentumMin * 100).toFixed(0)}% required`,
                blockedReason: 'LOW_MOMENTUM'
            };
        }
    }
    if (applyVolumeGate) {
        const volNum = Number(volume);
        if (!Number.isFinite(volNum)) return { passes: false, reason: 'NO_VOLUME', blockedReason: 'NO_VOLUME' };
        if (volNum <= volumeMin) {
            return {
                passes: false,
                reason: `LOW_VOLUME: $${volNum.toFixed(0)} < $${volumeMin} required`,
                blockedReason: 'LOW_VOLUME'
            };
        }
    }
    const candidates = runtime.strategies.filter(strategy => {
        if (!strategy) return false;
        const sAsset = normalizeAsset(strategy.asset);
        const assetOk = !sAsset || isWildcardAsset(sAsset) || sAsset === assetUpper;
        const dirOk = String(strategy.direction || '').trim().toUpperCase() === dirMatch;
        const hourOk = Number(strategy.utcHour) === uh;
        const minuteOk = Number(strategy.entryMinute) === em;
        return assetOk && dirOk && hourOk && minuteOk;
    });
    const match = candidates.find(strategy => normalizeAsset(strategy.asset) === assetUpper) || candidates[0];
    if (!match) {
        return {
            passes: false,
            reason: `NO_OPTIMIZED_STRATEGY: ${assetUpper} ${dirMatch} H${uh}:${String(em).padStart(2, '0')} - not a validated combination`,
            blockedReason: 'NO_OPTIMIZED_MATCH'
        };
    }
    const bandMin = Number.isFinite(Number(match?.priceMin ?? match?.priceBand?.min)) ? Number(match?.priceMin ?? match?.priceBand?.min) : Number(cond.priceMin || 0);
    const bandMax = Number.isFinite(Number(match?.priceMax ?? match?.priceBand?.max)) ? Number(match?.priceMax ?? match?.priceBand?.max) : Number(cond.priceMax || 1);
    if (px < bandMin || px > bandMax) {
        return {
            passes: false,
            reason: `PRICE_OUT_OF_RANGE: ${(px * 100).toFixed(0)}c not in ${(bandMin * 100).toFixed(0)}-${(bandMax * 100).toFixed(0)}c`,
            blockedReason: 'PRICE_RANGE'
        };
    }
    const wrPct = Number.isFinite(Number(match?.winRate)) ? (Number(match.winRate) * 100).toFixed(1) : '??';
    return {
        passes: true,
        reason: `${String(match.tier || 'UNKNOWN').toUpperCase()}: ${String(match.name || '').trim() || 'strategy'} - ${assetUpper} ${dirMatch} @ H${uh}:${String(em).padStart(2, '0')} (${wrPct}% WR, ${(bandMin * 100).toFixed(0)}-${(bandMax * 100).toFixed(0)}c)`,
        strategy: match,
        bandMin,
        bandMax,
    };
}

async function main() {
    const repoRoot = path.resolve(__dirname, '..');
    const datasetPath = readArgValue('dataset', path.join(repoRoot, 'exhaustive_analysis', 'decision_dataset.json'));
    const outDir = readArgValue('outDir', path.join(repoRoot, 'debug', 'operator_stage_runtime_replay'));
    const signalOutPath = readArgValue('signalOut', path.join(outDir, 'hybrid_replay_signal_ledger.json'));
    const executedOutPath = readArgValue('executedOut', path.join(outDir, 'hybrid_replay_executed_ledger.json'));
    const startEpochSec = parseEpochArg('startEpochSec');
    const endEpochSec = parseEpochArg('endEpochSec');
    const maxRows = parseIntArg('maxRows', null);
    const maxGlobalTradesPerCycle = Math.max(1, parseIntArg('maxGlobalTradesPerCycle', 2));
    const keepSignalLedgers = parseBoolArg('keepSignalLedgers', true);
    const bankrollConfig = {
        startingBalance: parseFloatArg('startingBalance', 5),
        stakeFraction: parseFloatArg('stakeFraction', 0.45),
        operatorStakeFractionOverride: parseOptionalFloatArg('operatorStakeFractionOverride'),
        operatorStakeFractionBankrollAware: parseBoolArg('operatorStakeFractionBankrollAware', true),
        maxExposure: parseFloatArg('maxExposure', 0.5),
        maxAbsoluteStake: parseFloatArg('maxAbsoluteStake', 100),
        tieredMaxAbsoluteStake: parseBoolArg('tieredMaxAbsoluteStake', true),
        slippagePct: parseFloatArg('slippagePct', 0.01),
        fixedStakeUsd: parseOptionalFloatArg('fixedStakeUsd') ?? undefined,
        kellyEnabled: parseBoolArg('kellyEnabled', true),
        kellyFraction: parseFloatArg('kellyFraction', 0.75),
        kellyMaxFraction: parseFloatArg('kellyMaxFraction', 0.45),
        adaptiveMode: parseBoolArg('adaptiveMode', true),
        autoProfileEnabled: parseBoolArg('autoProfileEnabled', true),
        allowDynamicStake: parseBoolArg('allowDynamicStake', true),
        riskEnvelopeEnabled: parseBoolArg('riskEnvelopeEnabled', true),
        simulateHalts: parseBoolArg('simulateHalts', true),
        maxConsecutiveLosses: parseIntArg('maxConsecutiveLosses', 3),
        cooldownSeconds: parseIntArg('cooldownSeconds', 1200),
        globalStopLoss: parseFloatArg('globalStopLoss', 0.2),
        minOrderShares: parseIntArg('minOrderShares', 5),
        minOddsEntry: parseFloatArg('minOddsEntry', 0.6),
        minBalanceFloorEnabled: parseBoolArg('minBalanceFloorEnabled', true),
        minBalanceFloor: parseFloatArg('minBalanceFloor', 2),
        minBalanceFloorDynamicEnabled: parseBoolArg('minBalanceFloorDynamicEnabled', true),
        minBalanceFloorDynamicFraction: parseFloatArg('minBalanceFloorDynamicFraction', 0.4),
        minBalanceFloorDynamicMin: parseFloatArg('minBalanceFloorDynamicMin', 0.5),
        relativeThresholds: parseBoolArg('relativeThresholds', false),
        stage1Mult: parseOptionalFloatArg('stage1Mult') ?? undefined,
        stage2Mult: parseOptionalFloatArg('stage2Mult') ?? undefined,
        vaultTriggerBalance: parseFloatArg('vaultTriggerBalance', 100),
        stage2Threshold: parseFloatArg('stage2Threshold', 500),
        streakSizingEnabled: parseBoolArg('streakSizingEnabled', true),
        lossMultipliers: [],
        winBonusEnabled: parseBoolArg('winBonusEnabled', true),
        winMultipliers: [],
        maxLossBudgetPct: parseFloatArg('maxLossBudgetPct', 0.25),
        missRate: parseFloatArg('missRate', 0),
        autoBankrollProfileEnabled: parseBoolArg('autoBankrollProfileEnabled', true),
        autoBankrollMode: String(readArgValue('autoBankrollMode', 'SPRINT')).trim().toUpperCase(),
        autoBankrollCutover: parseFloatArg('autoBankrollCutover', 20),
        autoBankrollLargeCutover: parseFloatArg('autoBankrollLargeCutover', 1000),
        autoBankrollKellyLow: parseFloatArg('autoBankrollKellyLow', 0.45),
        autoBankrollKellyHigh: parseFloatArg('autoBankrollKellyHigh', 0.45),
        autoBankrollKellyLarge: parseFloatArg('autoBankrollKellyLarge', 0.12),
        autoBankrollMaxPosLow: parseFloatArg('autoBankrollMaxPosLow', 0.45),
        autoBankrollMaxPosHigh: parseFloatArg('autoBankrollMaxPosHigh', 0.45),
        autoBankrollMaxPosLarge: parseFloatArg('autoBankrollMaxPosLarge', 0.07),
        autoBankrollRiskEnvelopeLow: parseBoolArg('autoBankrollRiskEnvelopeLow', true),
        autoBankrollRiskEnvelopeHigh: parseBoolArg('autoBankrollRiskEnvelopeHigh', false),
        autoBankrollRiskEnvelopeLarge: parseBoolArg('autoBankrollRiskEnvelopeLarge', true),
        peakDrawdownBrakeEnabled: parseBoolArg('peakDrawdownBrakeEnabled', true),
        peakDrawdownBrakePct: parseFloatArg('peakDrawdownBrakePct', 0.2),
        peakDrawdownBrakeMinBankroll: parseFloatArg('peakDrawdownBrakeMinBankroll', 20),
        peakDrawdownBrakeMaxPosFraction: parseFloatArg('peakDrawdownBrakeMaxPosFraction', 0.12),
        circuitBreakerEnabled: parseBoolArg('circuitBreakerEnabled', true),
        circuitBreakerSoftDrawdownPct: parseFloatArg('circuitBreakerSoftDrawdownPct', 0.25),
        circuitBreakerHardDrawdownPct: parseFloatArg('circuitBreakerHardDrawdownPct', 0.45),
        circuitBreakerHaltDrawdownPct: parseFloatArg('circuitBreakerHaltDrawdownPct', 0.7),
        circuitBreakerSafeOnlyAfterLosses: parseIntArg('circuitBreakerSafeOnlyAfterLosses', 3),
        circuitBreakerProbeOnlyAfterLosses: parseIntArg('circuitBreakerProbeOnlyAfterLosses', 5),
        circuitBreakerHaltAfterLosses: parseIntArg('circuitBreakerHaltAfterLosses', 7),
        circuitBreakerResumeAfterMinutes: parseFloatArg('circuitBreakerResumeAfterMinutes', 20),
        circuitBreakerResumeAfterWin: parseBoolArg('circuitBreakerResumeAfterWin', true),
        circuitBreakerResumeOnNewDay: parseBoolArg('circuitBreakerResumeOnNewDay', true),
    };
    fs.mkdirSync(outDir, { recursive: true });
    const stageProfiles = [
        {
            key: 'survival_top3',
            label: 'SURVIVAL',
            strategySetPath: readArgValue('operatorStageSurvival', path.join(repoRoot, 'debug', 'strategy_set_top3_robust.json')),
        },
        {
            key: 'balanced_top5',
            label: 'BALANCED',
            strategySetPath: readArgValue('operatorStageBalanced', path.join(repoRoot, 'debug', 'strategy_set_top5_robust.json')),
        },
        {
            key: 'growth_top7',
            label: 'GROWTH',
            strategySetPath: readArgValue('operatorStageGrowth', path.join(repoRoot, 'debug', 'strategy_set_top8_current.json')),
        },
    ].map(profile => ({ ...profile, runtime: loadStrategyRuntime(profile.strategySetPath) }));
    const stageProfileByKey = Object.fromEntries(stageProfiles.map(profile => [profile.key, profile]));
    const meta = {
        generatedAt: new Date().toISOString(),
        datasetPath,
        outputs: { signalLedger: signalOutPath, executedLedger: executedOutPath },
        filters: { startEpochSec, endEpochSec, maxRows },
        operatorStageProfiles: stageProfiles.map(profile => ({
            key: profile.key,
            label: profile.label,
            strategySetPath: profile.strategySetPath,
            strategyCount: Array.isArray(profile.runtime?.strategies) ? profile.runtime.strategies.length : 0,
            conditions: profile.runtime?.conditions || null,
        })),
        bankrollSimulation: { enabled: true, config: bankrollConfig },
        maxGlobalTradesPerCycle,
    };
    const signalWriter = createBufferedFileWriter(signalOutPath);
    let firstSignal = true;
    let rowsEvaluated = 0;
    let signalsWritten = 0;
    let passSignals = 0;
    let blockedSignals = 0;
    const blockedByReason = {};
    let parsedRows = 0;
    const daysEvaluated = new Set();
    const executedTrades = [];
    const collisions = [];
    const stageTransitions = [];
    let collisionCycles = 0;
    let collisionBlockedCandidates = 0;
    let currentBalance = bankrollConfig.startingBalance;
    let currentStageKey = null;
    let currentCycle = null;
    let lastBankrollSimulation = null;

    function recalcBalance() {
        lastBankrollSimulation = simulateBankrollPath(executedTrades, bankrollConfig);
        currentBalance = Number(lastBankrollSimulation?.stats?.endingBalance);
        if (!Number.isFinite(currentBalance)) currentBalance = bankrollConfig.startingBalance;
    }

    function openCycle(cycleStartEpochSec) {
        const nextStageKey = chooseOperatorPrimaryStageKey(currentBalance, currentStageKey);
        const profile = stageProfileByKey[nextStageKey];
        if (!profile) throw new Error(`Missing stage profile: ${nextStageKey}`);
        if (currentStageKey !== profile.key) {
            stageTransitions.push({
                cycleStartEpochSec,
                bankroll: currentBalance,
                fromStageKey: currentStageKey,
                toStageKey: profile.key,
            });
        }
        currentStageKey = profile.key;
        currentCycle = {
            cycleStartEpochSec,
            balanceBeforeCycle: currentBalance,
            stageKey: profile.key,
            stageLabel: profile.label,
            runtime: profile.runtime,
            strategySetPath: profile.strategySetPath,
            candidates: [],
        };
    }

    function flushCycle() {
        if (!currentCycle) return;
        const candidates = currentCycle.candidates;
        if (candidates.length) {
            candidates.sort((a, b) => sortCandidatesDeterministically(a, b, currentCycle.runtime.conditions || {}));
            const winners = candidates.slice(0, maxGlobalTradesPerCycle);
            const blocked = candidates.slice(maxGlobalTradesPerCycle);
            if (blocked.length) {
                collisionCycles += 1;
                collisionBlockedCandidates += blocked.length;
                collisions.push({
                    cycleStartEpochSec: currentCycle.cycleStartEpochSec,
                    stageKey: currentCycle.stageKey,
                    candidateCount: candidates.length,
                    executedIds: winners.map(s => s.id),
                    blockedIds: blocked.map(s => s.id),
                });
            }
            for (const winner of winners) {
                const cycleSec = Number(winner.cycleStartEpochSec);
                const em = Number(winner.entryMinute);
                const issuedAt = Number.isFinite(cycleSec) ? (cycleSec + em * 60) * 1000 : null;
                const resolvedAt = Number.isFinite(cycleSec) ? (cycleSec + 15 * 60) * 1000 : null;
                executedTrades.push({
                    id: winner.id,
                    asset: winner.asset,
                    slug: winner.slug,
                    direction: winner.direction,
                    entryPrice: winner.entryPrice,
                    pWin: winner.strategyWinRateLCB,
                    tier: winner.strategyTier,
                    cycleStartEpoch: winner.cycleStartEpochSec,
                    issuedAt,
                    resolvedAt,
                    outcome: winner.won === true ? 'WIN' : winner.won === false ? 'LOSS' : null,
                    isWin: winner.won === true ? true : winner.won === false ? false : null,
                    cycleStartEpochSec: winner.cycleStartEpochSec,
                    entryMinute: winner.entryMinute,
                    utcHour: winner.utcHour,
                    momentum: winner.momentum,
                    volume: winner.volume,
                    strategyId: winner.strategyId,
                    strategyName: winner.strategyName,
                    strategyTier: winner.strategyTier,
                    strategyWinRateLCB: winner.strategyWinRateLCB,
                    priceBandMin: winner.priceBandMin,
                    priceBandMax: winner.priceBandMax,
                    resolvedOutcome: winner.resolvedOutcome,
                    won: winner.won,
                    roi: winner.roi,
                    collisionCandidateCount: candidates.length,
                    collisionBlockedCount: blocked.length,
                    stageKey: currentCycle.stageKey,
                    stageLabel: currentCycle.stageLabel,
                    stageStrategySetPath: currentCycle.strategySetPath,
                });
            }
            recalcBalance();
        }
        currentCycle = null;
    }

    try {
        signalWriter.write('{"signals":[\n');
        parsedRows = await streamJsonArrayObjects(datasetPath, (row) => {
            const cycleStartEpochSec = Number(row?.cycleStartEpochSec);
            if (!Number.isFinite(cycleStartEpochSec)) return true;
            if (startEpochSec !== null && cycleStartEpochSec < startEpochSec) return true;
            if (endEpochSec !== null && cycleStartEpochSec > endEpochSec) return false;
            if (maxRows !== null && rowsEvaluated >= maxRows) return false;
            rowsEvaluated += 1;
            const dk = dayKeyUtc(cycleStartEpochSec);
            if (dk) daysEvaluated.add(dk);
            if (!currentCycle || currentCycle.cycleStartEpochSec !== cycleStartEpochSec) {
                flushCycle();
                openCycle(cycleStartEpochSec);
            }
            const entryMinute = Number(row?.entryMinute);
            const utcHour = Number(row?.utcHour);
            const slug = String(row?.slug || '');
            const asset = String(row?.asset || '');
            const volume = row?.volume;
            const runtimeRiskProfileStage = resolveRuntimeRiskStage(currentCycle.balanceBeforeCycle, bankrollConfig);
            for (const dir of ['UP', 'DOWN']) {
                const entryPrice = dir === 'UP' ? row?.upPrice : row?.downPrice;
                const momentum = computeDirectionalMomentum(row, dir);
                const res = evaluateStrategySetMatchReplay(
                    currentCycle.runtime,
                    asset,
                    dir,
                    entryPrice,
                    entryMinute,
                    utcHour,
                    momentum,
                    volume,
                    { skipMomentumGate: true, forceVolumeGate: false, runtimeRiskProfileStage }
                );
                const strategy = res?.strategy || null;
                const signal = {
                    id: `HR_${asset}_${cycleStartEpochSec}_${entryMinute}_${dir}`,
                    asset,
                    slug,
                    cycleStartEpochSec,
                    entryMinute,
                    utcHour,
                    direction: dir,
                    entryPrice: Number.isFinite(Number(entryPrice)) ? Number(entryPrice) : null,
                    momentum: Number.isFinite(Number(momentum)) ? Number(momentum) : null,
                    volume: Number.isFinite(Number(volume)) ? Number(volume) : null,
                    passes: !!res?.passes,
                    blockedReason: res?.blockedReason ?? null,
                    reason: res?.reason ?? null,
                    strategyId: strategy ? Number(strategy.id) : null,
                    strategyName: strategy ? (strategy.name ?? null) : null,
                    strategyTier: strategy ? (strategy.tier ?? null) : null,
                    strategyWinRateLCB: strategy && Number.isFinite(Number(strategy.winRateLCB)) ? Number(strategy.winRateLCB) : null,
                    priceBandMin: Number.isFinite(Number(res?.bandMin)) ? Number(res.bandMin) : null,
                    priceBandMax: Number.isFinite(Number(res?.bandMax)) ? Number(res.bandMax) : null,
                    resolvedOutcome: row?.resolvedOutcome ?? null,
                    won: typeof row?.resolvedOutcome === 'string' ? String(row.resolvedOutcome).toUpperCase() === dir : null,
                    roi: dir === 'UP' ? (Number.isFinite(Number(row?.upROI)) ? Number(row.upROI) : null) : (Number.isFinite(Number(row?.downROI)) ? Number(row.downROI) : null),
                    stageKey: currentCycle.stageKey,
                    stageLabel: currentCycle.stageLabel,
                    stageStrategySetPath: currentCycle.strategySetPath,
                    bankrollBeforeCycle: currentCycle.balanceBeforeCycle,
                };
                signalWriter.write(firstSignal ? '' : ',\n');
                firstSignal = false;
                signalWriter.write(JSON.stringify(signal));
                signalsWritten += 1;
                if (res?.passes) {
                    passSignals += 1;
                    currentCycle.candidates.push(signal);
                } else {
                    blockedSignals += 1;
                    const br = String(res?.blockedReason || 'UNKNOWN');
                    blockedByReason[br] = (blockedByReason[br] || 0) + 1;
                }
            }
            return true;
        }, { logEvery: 50000 });
        flushCycle();
        const signalStats = {
            parsedRows,
            rowsEvaluated,
            signalsWritten,
            passSignals,
            blockedSignals,
            blockedByReason,
            daysEvaluated: daysEvaluated.size,
            stageTransitions,
        };
        signalWriter.write('\n],');
        signalWriter.write(`"meta":${JSON.stringify(meta)},`);
        signalWriter.write(`"stats":${JSON.stringify(signalStats)}`);
        signalWriter.write('}\n');
    } finally {
        try { signalWriter.end(); } catch { }
        if (!keepSignalLedgers) {
            try { fs.unlinkSync(signalOutPath); } catch { }
        }
    }

    if (!lastBankrollSimulation) recalcBalance();

    let executedWins = 0;
    let executedLosses = 0;
    let executedPending = 0;
    let totalRoi = 0;
    let roiCount = 0;
    let currentWinStreak = 0;
    let currentLossStreak = 0;
    let maxWinStreak = 0;
    let maxLossStreak = 0;
    const byStrategy = {};
    const byDay = {};
    const daysWithTrades = new Set();

    executedTrades.sort((a, b) => {
        const ca = Number(a?.cycleStartEpochSec);
        const cb = Number(b?.cycleStartEpochSec);
        if (Number.isFinite(ca) && Number.isFinite(cb) && ca !== cb) return ca - cb;
        const aa = String(a?.asset || '').toUpperCase();
        const ab = String(b?.asset || '').toUpperCase();
        if (aa !== ab) return aa.localeCompare(ab);
        return String(a?.id || '').localeCompare(String(b?.id || ''));
    });

    for (const trade of executedTrades) {
        const won = trade?.won;
        if (won === true) {
            executedWins += 1;
            currentWinStreak += 1;
            currentLossStreak = 0;
            if (currentWinStreak > maxWinStreak) maxWinStreak = currentWinStreak;
        } else if (won === false) {
            executedLosses += 1;
            currentLossStreak += 1;
            currentWinStreak = 0;
            if (currentLossStreak > maxLossStreak) maxLossStreak = currentLossStreak;
        } else {
            executedPending += 1;
            currentWinStreak = 0;
            currentLossStreak = 0;
        }
        const roi = Number(trade?.roi);
        if (Number.isFinite(roi)) {
            totalRoi += roi;
            roiCount += 1;
        }
        const strategyKey = `${String(trade?.stageKey || 'unknown')}:${String(trade?.strategyId || 'UNKNOWN')}`;
        if (!byStrategy[strategyKey]) {
            byStrategy[strategyKey] = {
                strategyKey,
                stageKey: trade?.stageKey || null,
                strategyId: Number.isFinite(Number(trade?.strategyId)) ? Number(trade.strategyId) : null,
                strategyName: trade?.strategyName ?? null,
                tier: trade?.strategyTier ?? null,
                trades: 0,
                wins: 0,
                losses: 0,
                pending: 0,
            };
        }
        byStrategy[strategyKey].trades += 1;
        if (won === true) byStrategy[strategyKey].wins += 1;
        else if (won === false) byStrategy[strategyKey].losses += 1;
        else byStrategy[strategyKey].pending += 1;
        const dk = dayKeyUtc(Number(trade?.cycleStartEpochSec));
        if (dk) {
            daysWithTrades.add(dk);
            if (!byDay[dk]) byDay[dk] = { day: dk, trades: 0, wins: 0, losses: 0, pending: 0 };
            byDay[dk].trades += 1;
            if (won === true) byDay[dk].wins += 1;
            else if (won === false) byDay[dk].losses += 1;
            else byDay[dk].pending += 1;
        }
    }

    const executedResolved = executedWins + executedLosses;
    const executedStats = {
        trades: executedTrades.length,
        wins: executedWins,
        losses: executedLosses,
        pending: executedPending,
        winRate: executedResolved > 0 ? executedWins / executedResolved : 0,
        avgRoi: roiCount > 0 ? totalRoi / roiCount : null,
        totalRoi: roiCount > 0 ? totalRoi : null,
        daysWithTrades: daysWithTrades.size,
        tradesPerDay: daysWithTrades.size > 0 ? executedTrades.length / daysWithTrades.size : 0,
        currentWinStreak,
        currentLossStreak,
        maxWinStreak,
        maxLossStreak,
        collisionCycles,
        collisionBlockedCandidates,
        bankroll: lastBankrollSimulation?.stats || null,
    };

    const executedLedger = {
        trades: executedTrades,
        collisions,
        stats: executedStats,
        byStrategy,
        byDay,
        bankrollSimulation: lastBankrollSimulation,
        meta: {
            ...meta,
            stageTransitions,
            finalStageKey: currentStageKey,
            finalBankrollEstimate: currentBalance,
        },
    };

    fs.writeFileSync(executedOutPath, JSON.stringify(executedLedger, null, 2));
    console.log(`Dataset: ${datasetPath}`);
    console.log(`Signals written: ${signalsWritten}`);
    console.log(`Executed trades: ${executedTrades.length}`);
    console.log(`Stage transitions: ${stageTransitions.length}`);
    if (lastBankrollSimulation?.stats) {
        const bs = lastBankrollSimulation.stats;
        console.log(`Bankroll sim: start=$${Number(bs.startingBalance).toFixed(2)} end=$${Number(bs.endingBalance).toFixed(2)}`);
        console.log(`Bankroll sim trades: executed=${bs.executed} blocked=${bs.blocked} pending=${bs.pending}`);
        console.log(`Bankroll sim halts: ${JSON.stringify(bs.haltCounts)}`);
    }
    console.log(`Executed ledger: ${executedOutPath}`);
}

main().catch(err => {
    console.error(err);
    process.exit(1);
});
