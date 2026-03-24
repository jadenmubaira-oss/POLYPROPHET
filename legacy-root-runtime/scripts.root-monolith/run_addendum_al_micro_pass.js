const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

function readCliArgNow(name, fallback = null) {
  const prefix = `--${name}=`;
  const arg = process.argv.find((a) => String(a).startsWith(prefix));
  return arg ? String(arg).slice(prefix.length) : fallback;
}

const repoRoot = path.resolve(__dirname, '..');
const outputRoot = path.join(repoRoot, 'debug', readCliArgNow('outputSubdir', 'micro_6p95_5shares'));
const candidatesDir = path.join(outputRoot, 'candidates');
const replayRoot = path.join(outputRoot, 'replay');
const datasetPath = path.join(repoRoot, 'exhaustive_analysis', 'decision_dataset.json');
const validatedPath = path.join(repoRoot, 'exhaustive_analysis', 'strategies_validated.json');
const finalResultsPath = path.join(repoRoot, 'exhaustive_analysis', 'final_results.json');

function parseArg(name, fallback = null) {
  const prefix = `--${name}=`;
  const arg = process.argv.find((a) => String(a).startsWith(prefix));
  return arg ? String(arg).slice(prefix.length) : fallback;
}

function parseIntArg(name, fallback) {
  const raw = parseArg(name, null);
  if (raw === null) return fallback;
  const n = Number.parseInt(String(raw), 10);
  return Number.isFinite(n) ? n : fallback;
}

function parseFloatArg(name, fallback) {
  const raw = parseArg(name, null);
  if (raw === null) return fallback;
  const n = Number.parseFloat(String(raw));
  return Number.isFinite(n) ? n : fallback;
}

function parseBoolArg(name, fallback = false) {
  const raw = parseArg(name, null);
  if (raw === null) return fallback;
  const v = String(raw).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(v)) return true;
  if (['0', 'false', 'no', 'off'].includes(v)) return false;
  return fallback;
}

function parseOptionalBoolArg(name) {
  const raw = parseArg(name, null);
  if (raw === null) return null;
  const v = String(raw).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(v)) return true;
  if (['0', 'false', 'no', 'off'].includes(v)) return false;
  return null;
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function writeJson(filePath, value) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2));
}

function removeFileIfExists(filePath) {
  if (fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
  }
}

function toNum(value, fallback = null) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(value, lo, hi) {
  return Math.max(lo, Math.min(hi, value));
}

function round(value, digits = 6) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Number(n.toFixed(digits));
}

function fileSlug(label) {
  return String(label || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function signatureFromParts(entryMinute, utcHour, direction, priceMin, priceMax) {
  return `${entryMinute}|${utcHour}|${String(direction || '').toUpperCase()}|${priceMin}|${priceMax}`;
}

function prettyBand(priceMin, priceMax) {
  return `(${Math.round(priceMin * 100)}-${Math.round(priceMax * 100)}c)`;
}

function prettyStrategyName(prefix, entryMinute, utcHour, direction, priceMin, priceMax) {
  const hour = String(utcHour).padStart(2, '0');
  const minute = String(entryMinute).padStart(2, '0');
  const head = prefix ? `${prefix} ` : '';
  return `${head}H${hour} m${minute} ${String(direction || '').toUpperCase()} ${prettyBand(priceMin, priceMax)}`.trim();
}

function getPriceMin(raw) {
  const direct = toNum(raw?.priceMin, null);
  if (direct !== null) return direct;
  return toNum(raw?.priceBand?.min, null);
}

function getPriceMax(raw) {
  const direct = toNum(raw?.priceMax, null);
  if (direct !== null) return direct;
  return toNum(raw?.priceBand?.max, null);
}

function getOosTrades(raw) {
  const direct = toNum(raw?.oosTrades, null);
  if (direct !== null) return direct;
  return (toNum(raw?.valTrades, 0) || 0) + (toNum(raw?.testTrades, 0) || 0);
}

function getOosWins(raw) {
  const direct = toNum(raw?.oosWins, null);
  if (direct !== null) return direct;
  return (toNum(raw?.valWins, 0) || 0) + (toNum(raw?.testWins, 0) || 0);
}

function tierForRank(index) {
  if (index < 2) return 'PLATINUM';
  if (index < 6) return 'GOLD';
  return 'SILVER';
}

function dedupeStrategies(strategies) {
  const seen = new Set();
  const out = [];
  for (const strategy of strategies || []) {
    const key = String(strategy?.signature || '');
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(strategy);
  }
  return out;
}

function standardizeStrategy(raw, index, prefix = '') {
  const entryMinute = toNum(raw?.entryMinute, null);
  const utcHour = toNum(raw?.utcHour, null);
  const direction = String(raw?.direction || '').trim().toUpperCase();
  const priceMin = getPriceMin(raw);
  const priceMax = getPriceMax(raw);
  if (!Number.isFinite(entryMinute) || !Number.isFinite(utcHour) || !direction || !Number.isFinite(priceMin) || !Number.isFinite(priceMax)) {
    return null;
  }
  const signature = String(raw?.signature || signatureFromParts(entryMinute, utcHour, direction, priceMin, priceMax));
  const winRate = toNum(raw?.winRate, null) ?? toNum(raw?.oosWinRate, null);
  const winRateLCB = toNum(raw?.winRateLCB, null) ?? toNum(raw?.oosLcb, null) ?? toNum(raw?.valWinRateLCB, null) ?? toNum(raw?.valLcb, null);
  const oosTrades = getOosTrades(raw);
  const oosWins = getOosWins(raw);
  const oosWinRate = oosTrades > 0 ? (oosWins / oosTrades) : (toNum(raw?.oosWinRate, null) ?? null);
  const lossesPerTen = winRate !== null ? round((1 - winRate) * 10, 6) : null;
  const name = String(raw?.name || prettyStrategyName(prefix, entryMinute, utcHour, direction, priceMin, priceMax));
  return {
    id: index + 1,
    name,
    asset: String(raw?.asset || 'ALL').trim().toUpperCase() || 'ALL',
    utcHour,
    entryMinute,
    direction,
    priceMin,
    priceMax,
    tier: String(raw?.tier || tierForRank(index)).trim().toUpperCase(),
    signature,
    historicalWins: toNum(raw?.historicalWins, null) ?? toNum(raw?.wins, null),
    historicalTrades: toNum(raw?.historicalTrades, null) ?? toNum(raw?.trades, null),
    winRate,
    lossesPerTen,
    winRateLCB,
    oosTrades,
    oosWins,
    oosWinRate,
    liveTrades: toNum(raw?.liveTrades, 0) || 0,
    liveWins: toNum(raw?.liveWins, 0) || 0,
    valTrades: toNum(raw?.valTrades, null),
    valWins: toNum(raw?.valWins, null),
    valWinRate: toNum(raw?.valWinRate, null),
    valWinRateLCB: toNum(raw?.valWinRateLCB, null) ?? toNum(raw?.valLcb, null),
    testTrades: toNum(raw?.testTrades, null),
    testWins: toNum(raw?.testWins, null),
    testWinRate: toNum(raw?.testWinRate, null),
    testWinRateLCB: toNum(raw?.testWinRateLCB, null) ?? toNum(raw?.testLcb, null),
    tradesPerDay: toNum(raw?.tradesPerDay, null),
    score: toNum(raw?.score, null),
  };
}

function buildConditions(strategies) {
  const mins = strategies.map((s) => toNum(s?.priceMin, null)).filter(Number.isFinite);
  const maxs = strategies.map((s) => toNum(s?.priceMax, null)).filter(Number.isFinite);
  const priceMin = mins.length ? Math.min(...mins) : 0.6;
  const priceMax = maxs.length ? Math.max(...maxs) : 0.8;
  return {
    priceMin,
    priceMax,
    momentumMin: 0.03,
    volumeMin: 500,
    applyMomentumGate: true,
    applyVolumeGate: false,
    description: `Signal fires when: price inside the matched strategy band (union ${Math.round(priceMin * 100)}-${Math.round(priceMax * 100)}c), momentum > 3%. Volume gate OFF for current live-structure parity.`,
  };
}

function buildStrategySet({ label, description, source, strategies }) {
  const deduped = dedupeStrategies(strategies).map((strategy, index) => ({ ...strategy, id: index + 1 }));
  return {
    version: 'AL-1.0',
    generatedAt: new Date().toISOString(),
    description,
    conditions: buildConditions(deduped),
    stats: {
      totalStrategies: deduped.length,
      source,
    },
    strategies: deduped,
  };
}

function makeCandidate(label, description, sourceTags, strategies) {
  const slug = fileSlug(label);
  const filePath = path.join(candidatesDir, `${slug}.json`);
  const strategySet = buildStrategySet({
    label,
    description,
    source: Array.isArray(sourceTags) ? sourceTags.join('+') : String(sourceTags || ''),
    strategies,
  });
  writeJson(filePath, strategySet);
  return {
    label,
    slug,
    description,
    sourceTags: Array.isArray(sourceTags) ? sourceTags : [String(sourceTags || '')],
    filePath,
    relativeFilePath: path.relative(repoRoot, filePath).replace(/\\/g, '/'),
    strategyCount: strategySet.strategies.length,
    signatures: strategySet.strategies.map((s) => s.signature),
    totalOosTrades: strategySet.strategies.reduce((sum, s) => sum + (toNum(s.oosTrades, 0) || 0), 0),
    totalTradesPerDay: round(strategySet.strategies.reduce((sum, s) => sum + (toNum(s.tradesPerDay, 0) || 0), 0), 6),
  };
}

function combinations(items, size) {
  const out = [];
  const pick = [];
  function walk(start) {
    if (pick.length === size) {
      out.push(pick.slice());
      return;
    }
    for (let i = start; i < items.length; i += 1) {
      pick.push(items[i]);
      walk(i + 1);
      pick.pop();
    }
  }
  walk(0);
  return out;
}

function comboScore(strategies) {
  const combinedTradesPerDay = strategies.reduce((sum, s) => sum + (toNum(s.tradesPerDay, 0) || 0), 0);
  const combinedOosTrades = strategies.reduce((sum, s) => sum + (toNum(s.oosTrades, 0) || 0), 0);
  const combinedLcb = strategies.reduce((sum, s) => sum + (toNum(s.winRateLCB, 0) || 0), 0);
  return {
    combinedTradesPerDay,
    combinedOosTrades,
    combinedLcb,
  };
}

function generateFrequencyCombos(validatedStrategies, size, count, poolSize) {
  const pool = validatedStrategies.slice(0, Math.max(size, poolSize));
  return combinations(pool, size)
    .map((combo) => ({ combo, metrics: comboScore(combo) }))
    .sort((a, b) => {
      if (a.metrics.combinedTradesPerDay !== b.metrics.combinedTradesPerDay) {
        return b.metrics.combinedTradesPerDay - a.metrics.combinedTradesPerDay;
      }
      if (a.metrics.combinedOosTrades !== b.metrics.combinedOosTrades) {
        return b.metrics.combinedOosTrades - a.metrics.combinedOosTrades;
      }
      if (a.metrics.combinedLcb !== b.metrics.combinedLcb) {
        return b.metrics.combinedLcb - a.metrics.combinedLcb;
      }
      const aKey = a.combo.map((s) => s.signature).join('+');
      const bKey = b.combo.map((s) => s.signature).join('+');
      return aKey.localeCompare(bKey);
    })
    .slice(0, count)
    .map((entry) => entry.combo);
}

function buildReplayArgs(strategiesPath, replayDir, config) {
  const signalOut = path.join(replayDir, 'hybrid_replay_signal_ledger.json');
  const executedOut = path.join(replayDir, 'hybrid_replay_executed_ledger.json');
  return {
    signalOut,
    executedOut,
    args: [
      path.join(repoRoot, 'scripts', 'hybrid_replay_backtest.js'),
      `--dataset=${datasetPath}`,
      `--strategies=${strategiesPath}`,
      `--outDir=${replayDir}`,
      `--signalOut=${signalOut}`,
      `--executedOut=${executedOut}`,
      '--simulateBankroll=true',
      `--startingBalance=${config.startingBalance}`,
      `--stakeFraction=${config.stakeFraction}`,
      `--maxExposure=${config.maxExposure}`,
      `--maxAbsoluteStake=${config.maxAbsoluteStake}`,
      `--tieredMaxAbsoluteStake=${String(config.tieredMaxAbsoluteStake)}`,
      `--slippagePct=${config.slippagePct}`,
      `--kellyEnabled=${String(config.kellyEnabled)}`,
      `--kellyFraction=${config.kellyFraction}`,
      `--kellyMaxFraction=${config.kellyMaxFraction}`,
      `--adaptiveMode=${String(config.adaptiveMode)}`,
      `--autoProfileEnabled=${String(config.autoProfileEnabled)}`,
      `--allowDynamicStake=${String(config.allowDynamicStake)}`,
      `--riskEnvelopeEnabled=${String(config.riskEnvelopeEnabled)}`,
      `--simulateHalts=${String(config.simulateHalts)}`,
      `--maxConsecutiveLosses=${config.maxConsecutiveLosses}`,
      `--cooldownSeconds=${config.cooldownSeconds}`,
      `--globalStopLoss=${config.globalStopLoss}`,
      `--minOrderShares=${config.minOrderShares}`,
      `--minOddsEntry=${config.minOddsEntry}`,
      `--minBalanceFloorEnabled=${String(config.minBalanceFloorEnabled)}`,
      `--minBalanceFloor=${config.minBalanceFloor}`,
      `--minBalanceFloorDynamicEnabled=${String(config.minBalanceFloorDynamicEnabled)}`,
      `--minBalanceFloorDynamicFraction=${config.minBalanceFloorDynamicFraction}`,
      `--minBalanceFloorDynamicMin=${config.minBalanceFloorDynamicMin}`,
      `--relativeThresholds=${String(config.relativeThresholds)}`,
      `--vaultTriggerBalance=${config.vaultTriggerBalance}`,
      `--stage2Threshold=${config.stage2Threshold}`,
      `--streakSizingEnabled=${String(config.streakSizingEnabled)}`,
      `--winBonusEnabled=${String(config.winBonusEnabled)}`,
      `--autoBankrollProfileEnabled=${String(config.autoBankrollProfileEnabled)}`,
      `--autoBankrollMode=${config.autoBankrollMode}`,
      `--autoBankrollCutover=${config.autoBankrollCutover}`,
      `--autoBankrollLargeCutover=${config.autoBankrollLargeCutover}`,
      `--autoBankrollKellyLow=${config.autoBankrollKellyLow}`,
      `--autoBankrollKellyHigh=${config.autoBankrollKellyHigh}`,
      `--autoBankrollKellyLarge=${config.autoBankrollKellyLarge}`,
      `--autoBankrollMaxPosLow=${config.autoBankrollMaxPosLow}`,
      `--autoBankrollMaxPosHigh=${config.autoBankrollMaxPosHigh}`,
      `--autoBankrollMaxPosLarge=${config.autoBankrollMaxPosLarge}`,
      `--autoBankrollRiskEnvelopeLow=${String(config.autoBankrollRiskEnvelopeLow)}`,
      `--autoBankrollRiskEnvelopeHigh=${String(config.autoBankrollRiskEnvelopeHigh)}`,
      `--autoBankrollRiskEnvelopeLarge=${String(config.autoBankrollRiskEnvelopeLarge)}`,
      `--peakDrawdownBrakeEnabled=${String(config.peakDrawdownBrakeEnabled)}`,
      `--peakDrawdownBrakePct=${config.peakDrawdownBrakePct}`,
      `--peakDrawdownBrakeMinBankroll=${config.peakDrawdownBrakeMinBankroll}`,
      `--peakDrawdownBrakeMaxPosFraction=${config.peakDrawdownBrakeMaxPosFraction}`,
      `--circuitBreakerEnabled=${String(config.circuitBreakerEnabled)}`,
      `--circuitBreakerSoftDrawdownPct=${config.circuitBreakerSoftDrawdownPct}`,
      `--circuitBreakerHardDrawdownPct=${config.circuitBreakerHardDrawdownPct}`,
      `--circuitBreakerHaltDrawdownPct=${config.circuitBreakerHaltDrawdownPct}`,
      `--circuitBreakerSafeOnlyAfterLosses=${config.circuitBreakerSafeOnlyAfterLosses}`,
      `--circuitBreakerProbeOnlyAfterLosses=${config.circuitBreakerProbeOnlyAfterLosses}`,
      `--circuitBreakerHaltAfterLosses=${config.circuitBreakerHaltAfterLosses}`,
      `--circuitBreakerResumeAfterMinutes=${config.circuitBreakerResumeAfterMinutes}`,
      `--circuitBreakerResumeAfterWin=${String(config.circuitBreakerResumeAfterWin)}`,
      `--circuitBreakerResumeOnNewDay=${String(config.circuitBreakerResumeOnNewDay)}`,
    ],
  };
}

function objectiveTuple(summary) {
  return {
    endingBalance: toNum(summary?.bankroll?.endingBalance, null),
    executedTrades: toNum(summary?.bankroll?.executed, 0) || 0,
    blockedMinOrder: toNum(summary?.bankroll?.haltCounts?.minOrder, 0) || 0,
    blockedRiskEnvelope: toNum(summary?.bankroll?.haltCounts?.riskEnvelope, 0) || 0,
    winRate: toNum(summary?.executedStats?.winRate, null),
    maxDrawdownPct: toNum(summary?.bankroll?.maxDrawdownPct, null),
  };
}

function compareObjectives(a, b) {
  const av = objectiveTuple(a);
  const bv = objectiveTuple(b);
  if ((av.endingBalance ?? -Infinity) !== (bv.endingBalance ?? -Infinity)) {
    return (bv.endingBalance ?? -Infinity) - (av.endingBalance ?? -Infinity);
  }
  if (av.executedTrades !== bv.executedTrades) {
    return bv.executedTrades - av.executedTrades;
  }
  if (av.blockedMinOrder !== bv.blockedMinOrder) {
    return av.blockedMinOrder - bv.blockedMinOrder;
  }
  if (av.blockedRiskEnvelope !== bv.blockedRiskEnvelope) {
    return av.blockedRiskEnvelope - bv.blockedRiskEnvelope;
  }
  if ((av.winRate ?? -Infinity) !== (bv.winRate ?? -Infinity)) {
    return (bv.winRate ?? -Infinity) - (av.winRate ?? -Infinity);
  }
  if ((av.maxDrawdownPct ?? Infinity) !== (bv.maxDrawdownPct ?? Infinity)) {
    return (av.maxDrawdownPct ?? Infinity) - (bv.maxDrawdownPct ?? Infinity);
  }
  return String(a.candidateId || '').localeCompare(String(b.candidateId || ''));
}

function summarizeReplay(candidate, executedLedger) {
  const stats = executedLedger?.stats || {};
  const bankroll = stats?.bankroll || {};
  const haltCounts = bankroll?.haltCounts || {};
  const tradesSeen = toNum(bankroll?.tradesSeen, 0) || 0;
  const freezeBlocks = (toNum(haltCounts?.minOrder, 0) || 0) + (toNum(haltCounts?.riskEnvelope, 0) || 0);
  const freezeBlockRate = tradesSeen > 0 ? freezeBlocks / tradesSeen : null;
  return {
    candidateId: candidate.slug,
    label: candidate.label,
    description: candidate.description,
    sourceTags: candidate.sourceTags,
    strategyCount: candidate.strategyCount,
    candidateFile: candidate.relativeFilePath,
    replayDir: path.relative(repoRoot, path.join(replayRoot, candidate.slug)).replace(/\\/g, '/'),
    executedStats: {
      trades: toNum(stats?.trades, null),
      wins: toNum(stats?.wins, null),
      losses: toNum(stats?.losses, null),
      pending: toNum(stats?.pending, null),
      winRate: toNum(stats?.winRate, null),
      wilsonLCB: toNum(stats?.wilsonLCB, null),
      avgRoi: toNum(stats?.avgRoi, null),
      tradesPerDay: toNum(stats?.tradesPerDay, null),
      daysWithTrades: toNum(stats?.daysWithTrades, null),
      collisionCycles: toNum(stats?.collisionCycles, null),
      collisionBlockedCandidates: toNum(stats?.collisionBlockedCandidates, null),
    },
    bankroll: {
      tradesSeen: toNum(bankroll?.tradesSeen, null),
      executed: toNum(bankroll?.executed, null),
      blocked: toNum(bankroll?.blocked, null),
      pending: toNum(bankroll?.pending, null),
      wins: toNum(bankroll?.wins, null),
      losses: toNum(bankroll?.losses, null),
      winRate: toNum(bankroll?.winRate, null),
      startingBalance: toNum(bankroll?.startingBalance, null),
      endingBalance: toNum(bankroll?.endingBalance, null),
      roi: toNum(bankroll?.roi, null),
      totalFeesUsd: toNum(bankroll?.totalFeesUsd, null),
      maxDrawdownPct: toNum(bankroll?.maxDrawdownPct, null),
      maxLossStreak: toNum(bankroll?.maxLossStreak, null),
      envelopeCaps: toNum(bankroll?.envelopeCaps, null),
      peakBrakeCaps: toNum(bankroll?.peakBrakeCaps, null),
      blockedByReason: bankroll?.blockedByReason || {},
      haltCounts: haltCounts,
    },
    objective: objectiveTuple({ bankroll, executedStats: stats }),
    freezeAssessment: {
      totalFreezeBlocks: freezeBlocks,
      tradesSeen,
      freezeBlockRate: freezeBlockRate !== null ? round(freezeBlockRate, 6) : null,
      heuristicThreshold: 0.1,
      freezesTooOften: freezeBlockRate !== null ? freezeBlockRate >= 0.1 : freezeBlocks > 0,
    },
    firstLossTrade: executedLedger?.bankrollSimulation?.firstLossTrade || null,
  };
}

function sourceFreshnessMeta() {
  if (!fs.existsSync(finalResultsPath)) {
    return {
      present: false,
      sourceRefreshSatisfied: false,
      reason: 'missing_final_results',
    };
  }
  const finalResults = readJson(finalResultsPath);
  const completedAt = finalResults?.completedAt ? new Date(finalResults.completedAt) : null;
  const ageHours = completedAt && Number.isFinite(completedAt.getTime())
    ? ((Date.now() - completedAt.getTime()) / 3600000)
    : null;
  return {
    present: true,
    startedAt: finalResults?.startedAt || null,
    completedAt: finalResults?.completedAt || null,
    datasetRows: toNum(finalResults?.counts?.datasetRows, null),
    validatedStrategies: toNum(finalResults?.counts?.validatedStrategies, null),
    ageHours: ageHours !== null ? round(ageHours, 2) : null,
    sourceRefreshSatisfied: ageHours !== null ? ageHours <= 24 : false,
  };
}

function main() {
  if (!fs.existsSync(datasetPath)) throw new Error(`Missing dataset: ${datasetPath}`);
  if (!fs.existsSync(validatedPath)) throw new Error(`Missing validated strategies: ${validatedPath}`);

  const buildOnly = parseBoolArg('buildOnly', false);
  const forceReplay = parseBoolArg('forceReplay', true);
  const keepSignalLedgers = parseBoolArg('keepSignalLedgers', false);
  const includeLegacyTop30 = parseBoolArg('includeLegacyTop30', false);
  const singleCount = parseIntArg('singleCount', 6);
  const pairCount = parseIntArg('pairCount', 3);
  const tripletCount = parseIntArg('tripletCount', 3);
  const comboPoolSize = parseIntArg('comboPoolSize', 10);
  const vaultTriggerBalanceOverride = parseFloatArg('vaultTriggerBalance', null);
  const stage2ThresholdOverride = parseFloatArg('stage2Threshold', null);
  const maxExposureOverride = parseFloatArg('maxExposure', null);
  const globalStopLossOverride = parseFloatArg('globalStopLoss', null);
  const relativeThresholdsOverride = parseOptionalBoolArg('relativeThresholds');
  const riskEnvelopeEnabledOverride = parseOptionalBoolArg('riskEnvelopeEnabled');
  const autoProfileEnabledOverride = parseOptionalBoolArg('autoProfileEnabled');
  const autoBankrollRiskEnvelopeLowOverride = parseOptionalBoolArg('autoBankrollRiskEnvelopeLow');
  const autoBankrollRiskEnvelopeHighOverride = parseOptionalBoolArg('autoBankrollRiskEnvelopeHigh');
  const autoBankrollRiskEnvelopeLargeOverride = parseOptionalBoolArg('autoBankrollRiskEnvelopeLarge');
  const autoBankrollModeOverrideRaw = parseArg('autoBankrollMode', null);
  const autoBankrollModeOverride = autoBankrollModeOverrideRaw ? String(autoBankrollModeOverrideRaw).trim().toUpperCase() : null;

  ensureDir(outputRoot);
  ensureDir(candidatesDir);
  ensureDir(replayRoot);

  const validatedRaw = Array.isArray(readJson(validatedPath)) ? readJson(validatedPath) : [];
  const validated = dedupeStrategies(
    validatedRaw
      .slice()
      .sort((a, b) => {
        const aScore = toNum(a?.score, -Infinity);
        const bScore = toNum(b?.score, -Infinity);
        if (aScore !== bScore) return bScore - aScore;
        const aFreq = toNum(a?.tradesPerDay, -Infinity);
        const bFreq = toNum(b?.tradesPerDay, -Infinity);
        return bFreq - aFreq;
      })
      .map((raw, index) => {
        const entryMinute = toNum(raw?.entryMinute, null);
        const utcHour = toNum(raw?.utcHour, null);
        const direction = String(raw?.direction || '').trim().toUpperCase();
        const priceMin = getPriceMin(raw);
        const priceMax = getPriceMax(raw);
        const prefix = `VAL${String(index + 1).padStart(2, '0')}`;
        return standardizeStrategy({
          ...raw,
          name: prettyStrategyName(prefix, entryMinute, utcHour, direction, priceMin, priceMax),
          tier: tierForRank(index),
          asset: 'ALL',
        }, index, prefix);
      })
      .filter(Boolean)
  );

  const legacyFiles = [
    { label: 'baseline_top7_drop6', path: path.join(repoRoot, 'debug', 'strategy_set_top7_drop6.json'), description: 'Baseline current primary operator strategy set', source: ['baseline', 'top7_drop6'] },
    { label: 'legacy_top3_robust', path: path.join(repoRoot, 'debug', 'strategy_set_top3_robust.json'), description: 'Legacy top3 robust comparator', source: ['legacy', 'top3_robust'] },
    { label: 'legacy_top5_robust', path: path.join(repoRoot, 'debug', 'strategy_set_top5_robust.json'), description: 'Legacy top5 robust comparator', source: ['legacy', 'top5_robust'] },
    { label: 'legacy_top8_current', path: path.join(repoRoot, 'debug', 'strategy_set_top8_current.json'), description: 'Legacy top8 current comparator', source: ['legacy', 'top8_current'] },
  ];

  if (includeLegacyTop30) {
    legacyFiles.push({
      label: 'legacy_top30_robust',
      path: path.join(repoRoot, 'debug', 'top30_robust_strategies.json'),
      description: 'Legacy top30 robust comparator',
      source: ['legacy', 'top30_robust'],
    });
  }

  const candidates = [];

  for (const legacy of legacyFiles) {
    if (!fs.existsSync(legacy.path)) continue;
    const raw = readJson(legacy.path);
    const strategies = dedupeStrategies((Array.isArray(raw?.strategies) ? raw.strategies : [])
      .map((strategy, index) => standardizeStrategy(strategy, index))
      .filter(Boolean));
    candidates.push(makeCandidate(legacy.label, legacy.description, legacy.source, strategies));
  }

  for (const size of [3, 5, 8, 12]) {
    if (validated.length >= size) {
      candidates.push(makeCandidate(
        `union_validated_top${String(size).padStart(2, '0')}`,
        `Top ${size} validated strategies by current certainty-first ranking, standardized for Addendum AL replay`,
        ['validated', `union_top${size}`],
        validated.slice(0, size),
      ));
    }
  }

  for (let i = 0; i < Math.min(singleCount, validated.length); i += 1) {
    const strategy = validated[i];
    candidates.push(makeCandidate(
      `single_validated_${String(i + 1).padStart(2, '0')}`,
      `Single validated candidate ${strategy.signature}`,
      ['validated', 'single'],
      [strategy],
    ));
  }

  const pairCombos = generateFrequencyCombos(validated, 2, pairCount, comboPoolSize);
  pairCombos.forEach((combo, index) => {
    candidates.push(makeCandidate(
      `pair_freq_${String(index + 1).padStart(2, '0')}`,
      `Validated pair ranked by combined trades/day and OOS coverage`,
      ['validated', 'pair_freq'],
      combo,
    ));
  });

  const tripletCombos = generateFrequencyCombos(validated, 3, tripletCount, comboPoolSize);
  tripletCombos.forEach((combo, index) => {
    candidates.push(makeCandidate(
      `triplet_freq_${String(index + 1).padStart(2, '0')}`,
      `Validated triplet ranked by combined trades/day and OOS coverage`,
      ['validated', 'triplet_freq'],
      combo,
    ));
  });

  const replayConfig = {
    startingBalance: 6.95,
    stakeFraction: 0.2,
    maxExposure: 0.6,
    maxAbsoluteStake: 100,
    tieredMaxAbsoluteStake: true,
    slippagePct: 0.01,
    kellyEnabled: true,
    kellyFraction: 0.75,
    kellyMaxFraction: 0.45,
    adaptiveMode: true,
    autoProfileEnabled: true,
    allowDynamicStake: true,
    riskEnvelopeEnabled: true,
    simulateHalts: true,
    maxConsecutiveLosses: 3,
    cooldownSeconds: 1200,
    globalStopLoss: 0.2,
    minOrderShares: 5,
    minOddsEntry: 0.35,
    minBalanceFloorEnabled: true,
    minBalanceFloor: 2.0,
    minBalanceFloorDynamicEnabled: true,
    minBalanceFloorDynamicFraction: 0.4,
    minBalanceFloorDynamicMin: 0.5,
    relativeThresholds: false,
    vaultTriggerBalance: 11,
    stage2Threshold: 20,
    streakSizingEnabled: true,
    winBonusEnabled: true,
    autoBankrollProfileEnabled: true,
    autoBankrollMode: 'SPRINT',
    autoBankrollCutover: 20,
    autoBankrollLargeCutover: 1000,
    autoBankrollKellyLow: 0.17,
    autoBankrollKellyHigh: 0.32,
    autoBankrollKellyLarge: 0.12,
    autoBankrollMaxPosLow: 0.17,
    autoBankrollMaxPosHigh: 0.32,
    autoBankrollMaxPosLarge: 0.07,
    autoBankrollRiskEnvelopeLow: true,
    autoBankrollRiskEnvelopeHigh: false,
    autoBankrollRiskEnvelopeLarge: true,
    peakDrawdownBrakeEnabled: true,
    peakDrawdownBrakePct: 0.2,
    peakDrawdownBrakeMinBankroll: 20,
    peakDrawdownBrakeMaxPosFraction: 0.12,
    circuitBreakerEnabled: true,
    circuitBreakerSoftDrawdownPct: 0.25,
    circuitBreakerHardDrawdownPct: 0.45,
    circuitBreakerHaltDrawdownPct: 0.7,
    circuitBreakerSafeOnlyAfterLosses: 3,
    circuitBreakerProbeOnlyAfterLosses: 5,
    circuitBreakerHaltAfterLosses: 7,
    circuitBreakerResumeAfterMinutes: 20,
    circuitBreakerResumeAfterWin: true,
    circuitBreakerResumeOnNewDay: true,
  };

  if (vaultTriggerBalanceOverride !== null) replayConfig.vaultTriggerBalance = vaultTriggerBalanceOverride;
  if (stage2ThresholdOverride !== null) replayConfig.stage2Threshold = stage2ThresholdOverride;
  if (maxExposureOverride !== null) replayConfig.maxExposure = maxExposureOverride;
  if (globalStopLossOverride !== null) replayConfig.globalStopLoss = globalStopLossOverride;
  if (relativeThresholdsOverride !== null) replayConfig.relativeThresholds = relativeThresholdsOverride;
  if (riskEnvelopeEnabledOverride !== null) replayConfig.riskEnvelopeEnabled = riskEnvelopeEnabledOverride;
  if (autoProfileEnabledOverride !== null) replayConfig.autoProfileEnabled = autoProfileEnabledOverride;
  if (autoBankrollRiskEnvelopeLowOverride !== null) replayConfig.autoBankrollRiskEnvelopeLow = autoBankrollRiskEnvelopeLowOverride;
  if (autoBankrollRiskEnvelopeHighOverride !== null) replayConfig.autoBankrollRiskEnvelopeHigh = autoBankrollRiskEnvelopeHighOverride;
  if (autoBankrollRiskEnvelopeLargeOverride !== null) replayConfig.autoBankrollRiskEnvelopeLarge = autoBankrollRiskEnvelopeLargeOverride;
  if (autoBankrollModeOverride) replayConfig.autoBankrollMode = autoBankrollModeOverride;

  const manifestPath = path.join(outputRoot, 'candidate_manifest.json');
  const manifest = {
    generatedAt: new Date().toISOString(),
    datasetPath: path.relative(repoRoot, datasetPath).replace(/\\/g, '/'),
    validatedPath: path.relative(repoRoot, validatedPath).replace(/\\/g, '/'),
    sourceFreshness: sourceFreshnessMeta(),
    replayConfig,
    candidates: candidates.map((candidate) => ({
      label: candidate.label,
      slug: candidate.slug,
      description: candidate.description,
      sourceTags: candidate.sourceTags,
      candidateFile: candidate.relativeFilePath,
      strategyCount: candidate.strategyCount,
      totalOosTrades: candidate.totalOosTrades,
      totalTradesPerDay: candidate.totalTradesPerDay,
      signatures: candidate.signatures,
    })),
  };
  writeJson(manifestPath, manifest);

  if (buildOnly) {
    console.log(`Built ${candidates.length} candidates`);
    console.log(`Manifest: ${manifestPath}`);
    return;
  }

  const replaySummaries = [];
  for (const candidate of candidates) {
    const replayDir = path.join(replayRoot, candidate.slug);
    ensureDir(replayDir);
    const { signalOut, executedOut, args } = buildReplayArgs(candidate.filePath, replayDir, replayConfig);
    if (forceReplay || !fs.existsSync(executedOut)) {
      execFileSync(process.execPath, args, {
        cwd: repoRoot,
        stdio: 'pipe',
        maxBuffer: 128 * 1024 * 1024,
      });
    }
    const executedLedger = readJson(executedOut);
    replaySummaries.push(summarizeReplay(candidate, executedLedger));
    if (!keepSignalLedgers) {
      removeFileIfExists(signalOut);
    }
  }

  replaySummaries.sort(compareObjectives);
  replaySummaries.forEach((summary, index) => {
    summary.rank = index + 1;
  });

  const baseline = replaySummaries.find((summary) => summary.candidateId === 'baseline_top7_drop6') || null;
  const winner = replaySummaries[0] || null;
  const runnerUp = replaySummaries[1] || null;

  const replaySummaryPath = path.join(replayRoot, 'summary.json');
  const replaySummary = {
    generatedAt: new Date().toISOString(),
    sourceFreshness: sourceFreshnessMeta(),
    replayConfig,
    rankingObjective: {
      order: [
        'endingBalance desc',
        'executedTrades desc',
        'blockedMinOrder asc',
        'blockedRiskEnvelope asc',
        'winRate desc',
        'maxDrawdownPct asc',
      ],
    },
    candidates: replaySummaries,
  };
  writeJson(replaySummaryPath, replaySummary);

  const winnerPath = path.join(outputRoot, 'winner.json');
  const winnerReport = {
    generatedAt: new Date().toISOString(),
    sourceFreshness: sourceFreshnessMeta(),
    replayConfig,
    winningCandidateId: winner?.candidateId || null,
    runnerUpCandidateId: runnerUp?.candidateId || null,
    winner: winner || null,
    runnerUp: runnerUp || null,
    winnerBeatsTop7Drop6: baseline && winner
      ? compareObjectives(baseline, winner) > 0
      : null,
    baselineTop7Drop6: baseline,
    winnerFreezeAssessment: winner?.freezeAssessment || null,
    winnerStillFreezesTooOften: winner?.freezeAssessment?.freezesTooOften ?? null,
  };
  writeJson(winnerPath, winnerReport);

  console.log(`Built ${candidates.length} candidates`);
  console.log(`Manifest: ${manifestPath}`);
  console.log(`Replay summary: ${replaySummaryPath}`);
  console.log(`Winner: ${winnerPath}`);
}

main();
