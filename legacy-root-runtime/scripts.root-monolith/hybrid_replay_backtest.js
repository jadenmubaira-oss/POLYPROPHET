const fs = require('fs');
const path = require('path');

const argv = process.argv.slice(2);

function readArgValue(prefix) {
    const hit = argv.find(a => a.startsWith(prefix));
    if (!hit) return null;
    const idx = hit.indexOf('=');
    if (idx === -1) return null;
    return hit.slice(idx + 1);
}

function parseIntArg(name, fallback) {
    const raw = readArgValue(`--${name}=`);
    if (raw === null) return fallback;
    const n = parseInt(raw, 10);
    return Number.isFinite(n) ? n : fallback;
}

function parseFloatArg(name, fallback) {
    const raw = readArgValue(`--${name}=`);
    if (raw === null) return fallback;
    const n = parseFloat(raw);
    return Number.isFinite(n) ? n : fallback;
}

function parseOptionalFloatArg(name) {
    const raw = readArgValue(`--${name}=`);
    if (raw === null) return null;
    const n = parseFloat(raw);
    return Number.isFinite(n) ? n : null;
}

function parseOptionalIntArg(name) {
    const raw = readArgValue(`--${name}=`);
    if (raw === null) return null;
    const n = parseInt(raw, 10);
    return Number.isFinite(n) ? n : null;
}

function parseBoolArg(name, fallback) {
    const raw = readArgValue(`--${name}=`);
    if (raw === null) return fallback;
    const v = String(raw).trim().toLowerCase();
    if (['1', 'true', 'yes', 'on'].includes(v)) return true;
    if (['0', 'false', 'no', 'off'].includes(v)) return false;
    return fallback;
}

function parseNumberListArg(name) {
    const raw = readArgValue(`--${name}=`);
    if (!raw) return [];
    return String(raw)
        .split(',')
        .map(x => parseFloat(String(x).trim()))
        .filter(n => Number.isFinite(n));
}

function parseEpochArg(name) {
    const raw = readArgValue(`--${name}=`);
    if (raw === null) return null;
    const n = parseInt(raw, 10);
    return Number.isFinite(n) ? n : null;
}

function isWildcardAsset(asset) {
    const a = String(asset || '').trim().toUpperCase();
    return a === '*' || a === 'ALL' || a === 'ANY';
}

function tierRank(tier) {
    const t = String(tier || '').trim().toUpperCase();
    if (t === 'PLATINUM') return 3;
    if (t === 'GOLD') return 2;
    if (t === 'SILVER') return 1;
    return 0;
}

function wilsonLCBFromCounts(wins, total, z = 1.96) {
    if (!Number.isFinite(wins) || !Number.isFinite(total) || total <= 0) return 0;
    const pHat = wins / total;
    const denom = 1 + (z * z) / total;
    const center = pHat + (z * z) / (2 * total);
    const margin = z * Math.sqrt((pHat * (1 - pHat) + (z * z) / (4 * total)) / total);
    return Math.max(0, (center - margin) / denom);
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

function toIsoMinute(epochSec) {
    return new Date(epochSec * 1000).toISOString().substring(0, 19) + 'Z';
}

function computeMaxLossStreak(executedTradesSorted) {
    let current = 0;
    let max = 0;
    for (const t of executedTradesSorted) {
        if (!t || t.won !== false) {
            current = 0;
            continue;
        }
        current += 1;
        if (current > max) max = current;
    }
    return max;
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
    const momMarginA = momA - gates.momentumMin;
    const momMarginB = momB - gates.momentumMin;
    if (momMarginA !== momMarginB) return momMarginB - momMarginA;

    const volA = Number.isFinite(Number(a?.volume)) ? Number(a.volume) : -Infinity;
    const volB = Number.isFinite(Number(b?.volume)) ? Number(b.volume) : -Infinity;
    const volMarginA = volA - gates.volumeMin;
    const volMarginB = volB - gates.volumeMin;
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

    const slugA = String(a?.slug || '');
    const slugB = String(b?.slug || '');
    return slugA.localeCompare(slugB);
}

function normalizeAsset(asset) {
    return String(asset || '').trim().toUpperCase();
}

function checkHybridStrategyReplay(asset, direction, entryPrice, entryMinute, utcHour, momentum, volume, strategies, gates) {
    const assetUpper = String(asset || '').toUpperCase();
    const dirUpper = String(direction || '').trim().toUpperCase();
    const dirMatch = (dirUpper === 'DOWN' || dirUpper === 'DN') ? 'DOWN' : 'UP';
    const em = Number(entryMinute);
    const uh = Number(utcHour);
    const px = Number(entryPrice);

    if (!Number.isFinite(px)) {
        return { passes: false, reason: 'NO_ENTRY_PRICE', blockedReason: 'NO_ENTRY_PRICE' };
    }

    const defaultPriceMin = Number(gates?.priceMin);
    const defaultPriceMax = Number(gates?.priceMax);
    const momentumMin = Number.isFinite(Number(gates?.momentumMin)) ? Number(gates.momentumMin) : 0.03;
    const volumeMin = Number.isFinite(Number(gates?.volumeMin)) ? Number(gates.volumeMin) : 500;
    const applyMomentumGate = gates?.applyMomentumGate === true;
    const applyVolumeGate = gates?.applyVolumeGate === true;

    if (applyMomentumGate) {
        const mom = Number(momentum);
        if (momentum === null || momentum === undefined || !Number.isFinite(mom)) {
            return { passes: false, reason: 'NO_MOMENTUM_BASELINE', blockedReason: 'NO_MOMENTUM' };
        }
        if (mom <= momentumMin) {
            return {
                passes: false,
                reason: `LOW_MOMENTUM: ${(mom * 100).toFixed(1)}% < ${(momentumMin * 100).toFixed(0)}% required`,
                blockedReason: 'LOW_MOMENTUM',
            };
        }
    }

    if (applyVolumeGate) {
        const volNum = Number(volume);
        if (volume === null || volume === undefined || !Number.isFinite(volNum)) {
            return { passes: false, reason: 'NO_VOLUME', blockedReason: 'NO_VOLUME' };
        }
        if (volNum <= volumeMin) {
            return {
                passes: false,
                reason: `LOW_VOLUME: $${volNum.toFixed(0)} < $${volumeMin} required`,
                blockedReason: 'LOW_VOLUME',
            };
        }
    }

    const candidates = strategies.filter(s => {
        if (!s) return false;
        const sAsset = normalizeAsset(s.asset);
        const assetOk = !sAsset || isWildcardAsset(sAsset) || sAsset === assetUpper;
        const dirOk = String(s.direction || '').trim().toUpperCase() === dirMatch;
        const hourOk = Number(s.utcHour) === uh;
        const minuteOk = Number(s.entryMinute) === em;
        return assetOk && dirOk && hourOk && minuteOk;
    });

    const match = candidates.find(s => normalizeAsset(s.asset) === assetUpper) || candidates[0];
    if (!match) {
        return {
            passes: false,
            reason: `NO_OPTIMIZED_STRATEGY: ${assetUpper} ${dirMatch} H${uh}:${String(em).padStart(2, '0')} - not a validated combination`,
            blockedReason: 'NO_OPTIMIZED_MATCH',
        };
    }

    const sMin = Number(match?.priceMin ?? match?.priceBand?.min);
    const sMax = Number(match?.priceMax ?? match?.priceBand?.max);
    const bandMin = Number.isFinite(sMin) ? sMin : (Number.isFinite(defaultPriceMin) ? defaultPriceMin : 0);
    const bandMax = Number.isFinite(sMax) ? sMax : (Number.isFinite(defaultPriceMax) ? defaultPriceMax : 1);

    if (px < bandMin || px > bandMax) {
        return {
            passes: false,
            reason: `PRICE_OUT_OF_RANGE: ${(px * 100).toFixed(0)}c not in ${(bandMin * 100).toFixed(0)}-${(bandMax * 100).toFixed(0)}c`,
            blockedReason: 'PRICE_RANGE',
            strategy: match,
            bandMin,
            bandMax,
        };
    }

    const tierIcon = match.tier === 'PLATINUM' ? '💎' : match.tier === 'GOLD' ? '🥇' : '🥈';
    const wrPct = match.winRate ? (match.winRate * 100).toFixed(1) : match.historicalWR || '??';
    return {
        passes: true,
        tier: match.tier,
        reason: `${tierIcon} ${match.tier}: ${match.name} - ${assetUpper} ${dirMatch} @ H${uh}:${String(em).padStart(2, '0')} (${wrPct}% WR, ${(bandMin * 100).toFixed(0)}-${(bandMax * 100).toFixed(0)}c)`,
        strategy: match,
        warningMinutes: 3,
        bandMin,
        bandMax,
    };
}

function createBufferedFileWriter(filePath, flushThresholdBytes = 4 * 1024 * 1024) {
    const fd = fs.openSync(filePath, 'w');
    let parts = [];
    let bytes = 0;

    const flush = () => {
        if (!parts.length) return;
        const chunk = parts.join('');
        parts = [];
        bytes = 0;
        fs.writeSync(fd, chunk);
    };

    const write = (str) => {
        const s = String(str ?? '');
        parts.push(s);
        bytes += Buffer.byteLength(s, 'utf8');
        if (bytes >= flushThresholdBytes) flush();
    };

    const end = () => {
        flush();
        fs.closeSync(fd);
    };

    return { write, flush, end };
}

function dayKeyUtc(epochSec) {
    if (!Number.isFinite(epochSec)) return null;
    return new Date(epochSec * 1000).toISOString().slice(0, 10);
}

function clamp01(value, fallback = 0) {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.max(0, Math.min(1, n));
}

function clampFraction(value, fallback = 0.20) {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.max(0.01, Math.min(0.50, n));
}

function pickOperatorStakeFractionDefault(baseBankroll) {
    const b = Number(baseBankroll);
    if (!Number.isFinite(b) || b <= 0) return 0.45;
    if (b <= 20) return 0.45;
    return 0.30;
}

function createSeededRng(seed) {
    let s;
    if (Number.isFinite(seed)) {
        s = (Math.floor(seed) >>> 0);
    } else {
        s = ((Date.now() ^ Math.floor(Math.random() * 0x100000000)) >>> 0);
    }

    return {
        seed: s,
        next() {
            let t = (s += 0x6D2B79F5);
            t = Math.imul(t ^ (t >>> 15), t | 1);
            t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
            return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
        },
    };
}

function getPolymarketTakerFeeModel() {
    const assumeRaw = String(process.env.POLYMARKET_ASSUME_TAKER || process.env.ASSUME_TAKER_FEES || 'true').trim().toLowerCase();
    const assumeTaker = !['0', 'false', 'no', 'off'].includes(assumeRaw);
    const feeRateRaw = Number(process.env.POLYMARKET_TAKER_FEE_RATE || process.env.TAKER_FEE_RATE);
    const exponentRaw = Number(process.env.POLYMARKET_TAKER_FEE_EXPONENT || process.env.TAKER_FEE_EXPONENT);
    const minFeeRaw = Number(process.env.POLYMARKET_TAKER_FEE_MIN_USD || process.env.TAKER_FEE_MIN_USD);
    const feeRate = (Number.isFinite(feeRateRaw) && feeRateRaw >= 0) ? feeRateRaw : 0.25;
    const exponent = (Number.isFinite(exponentRaw) && exponentRaw > 0) ? exponentRaw : 2;
    const minFeeUsd = (Number.isFinite(minFeeRaw) && minFeeRaw >= 0) ? minFeeRaw : 0.0001;
    return { assumeTaker, feeRate, exponent, minFeeUsd };
}

function calcPolymarketTakerFeeUsd(shares, price, model = getPolymarketTakerFeeModel()) {
    if (!model?.assumeTaker) return 0;
    const C = Number(shares);
    const p = Number(price);
    if (!Number.isFinite(C) || C <= 0) return 0;
    if (!Number.isFinite(p) || p <= 0 || p >= 1) return 0;
    const feeRate = Number(model.feeRate);
    const exponent = Number(model.exponent);
    if (!Number.isFinite(feeRate) || feeRate <= 0) return 0;
    const base = p * (1 - p);
    let fee = C * feeRate * Math.pow(base, (Number.isFinite(exponent) ? exponent : 2));
    if (!Number.isFinite(fee) || fee <= 0) return 0;
    const minFeeUsd = Number(model.minFeeUsd);
    if (Number.isFinite(minFeeUsd) && minFeeUsd > 0 && fee < minFeeUsd) return 0;
    return fee;
}

function calcPolymarketTakerFeeUsdForStake(stakeUsd, price, model = getPolymarketTakerFeeModel()) {
    if (!model?.assumeTaker) return 0;
    const stake = Number(stakeUsd);
    const p = Number(price);
    if (!Number.isFinite(stake) || stake <= 0) return 0;
    if (!Number.isFinite(p) || p <= 0 || p >= 1) return 0;
    return calcPolymarketTakerFeeUsd(stake / p, p, model);
}

function calcPolymarketTakerFeeUsdPerShare(price, model = getPolymarketTakerFeeModel()) {
    if (!model?.assumeTaker) return 0;
    const p = Number(price);
    if (!Number.isFinite(p) || p <= 0 || p >= 1) return 0;
    const feeRate = Number(model.feeRate);
    const exponent = Number(model.exponent);
    if (!Number.isFinite(feeRate) || feeRate <= 0) return 0;
    const base = p * (1 - p);
    const fee = feeRate * Math.pow(base, (Number.isFinite(exponent) ? exponent : 2));
    return Number.isFinite(fee) && fee > 0 ? fee : 0;
}

function calcPolymarketTakerFeeFrac(price, model = getPolymarketTakerFeeModel()) {
    if (!model?.assumeTaker) return 0;
    const p = Number(price);
    if (!Number.isFinite(p) || p <= 0 || p >= 1) return 0;
    const perShare = calcPolymarketTakerFeeUsdPerShare(p, model);
    const frac = perShare / p;
    return Number.isFinite(frac) && frac > 0 ? frac : 0;
}

function calcBinaryTradeDeltaUsdAfterFees(stakeUsd, entryPrice, won, options = {}) {
    const stake = Number(stakeUsd);
    if (!Number.isFinite(stake) || stake <= 0) return { deltaUsd: 0, feeUsd: 0, effectiveEntry: null };

    const epRaw = Number(entryPrice);
    if (!Number.isFinite(epRaw) || epRaw <= 0 || epRaw >= 1) return { deltaUsd: 0, feeUsd: 0, effectiveEntry: null };

    const slippagePctRaw = Number(options.slippagePct || 0);
    const slippagePct = (Number.isFinite(slippagePctRaw) && slippagePctRaw > 0) ? slippagePctRaw : 0;
    const effectiveEntry = Math.min(0.99, epRaw * (1 + slippagePct));

    const feeModel = options.feeModel || getPolymarketTakerFeeModel();
    const feeUsd = calcPolymarketTakerFeeUsdForStake(stake, effectiveEntry, feeModel);

    const deltaUsd = won
        ? (stake / effectiveEntry - stake - feeUsd)
        : (-stake - feeUsd);

    return { deltaUsd, feeUsd, effectiveEntry };
}

function calcKellyFraction(pWin, entryPrice, slippagePct, feeModel) {
    if (!Number.isFinite(pWin) || !Number.isFinite(entryPrice) || pWin < 0.5 || entryPrice <= 0 || entryPrice >= 1) {
        return null;
    }
    const effectiveEntry = Math.min(0.99, entryPrice * (1 + slippagePct));
    const b = (1 / effectiveEntry - 1);
    const feeFrac = calcPolymarketTakerFeeFrac(effectiveEntry, feeModel);
    const denom = (1 + feeFrac) * (b - feeFrac);
    if (!Number.isFinite(denom) || denom <= 0) return null;
    const fStar = (b * pWin - (1 - pWin) - feeFrac) / denom;
    return fStar > 0 ? fStar : null;
}

function getProfitLockMultiplier(profitMultiple) {
    if (profitMultiple >= 10) return 0.25;
    if (profitMultiple >= 5) return 0.30;
    if (profitMultiple >= 2.0) return 0.40;
    if (profitMultiple >= 1.1) return 0.65;
    return 1.0;
}

function getVaultThresholds(overrides = {}) {
    const relativeMode = overrides.relativeMode === true;
    const startingBalance = Number.isFinite(Number(overrides.startingBalance))
        ? Number(overrides.startingBalance)
        : 5;

    const DEFAULT_STAGE1_MULT = 1.47;
    const DEFAULT_STAGE2_MULT = 2.67;

    let vaultTriggerBalance = 11;
    let stage2Threshold = 20;

    if (Number.isFinite(Number(overrides.vaultTriggerBalance))) {
        vaultTriggerBalance = Number(overrides.vaultTriggerBalance);
    } else if (relativeMode) {
        const m1 = Number.isFinite(Number(overrides.stage1Mult)) ? Number(overrides.stage1Mult) : DEFAULT_STAGE1_MULT;
        vaultTriggerBalance = startingBalance * m1;
    }

    if (Number.isFinite(Number(overrides.stage2Threshold))) {
        stage2Threshold = Number(overrides.stage2Threshold);
    } else if (relativeMode) {
        const m2 = Number.isFinite(Number(overrides.stage2Mult)) ? Number(overrides.stage2Mult) : DEFAULT_STAGE2_MULT;
        stage2Threshold = startingBalance * m2;
    }

    return {
        vaultTriggerBalance,
        stage2Threshold,
        relativeMode,
        startingBalance,
    };
}

function getTieredMaxAbsoluteStake(bankroll, baseAbsoluteStake = 100) {
    const b = Number(bankroll);
    const base = Number.isFinite(Number(baseAbsoluteStake)) ? Number(baseAbsoluteStake) : 100;
    if (!Number.isFinite(b) || b < 1000) return base;
    if (b < 10000) return Math.max(base, 200);
    return Math.max(base, 500);
}

function getBankrollAdaptivePolicy(bankroll, cfg = {}) {
    const enabled = cfg.autoBankrollProfileEnabled !== false;

    const b = Number(bankroll);
    const cutover = Number.isFinite(Number(cfg.autoBankrollCutover))
        ? Number(cfg.autoBankrollCutover)
        : 20;

    const largeCutover = Number.isFinite(Number(cfg.autoBankrollLargeCutover))
        ? Number(cfg.autoBankrollLargeCutover)
        : 1000;

    const lowKelly = Number.isFinite(Number(cfg.autoBankrollKellyLow))
        ? Number(cfg.autoBankrollKellyLow)
        : 0.17;
    const highKelly = Number.isFinite(Number(cfg.autoBankrollKellyHigh))
        ? Number(cfg.autoBankrollKellyHigh)
        : 0.32;
    const largeKelly = Number.isFinite(Number(cfg.autoBankrollKellyLarge))
        ? Number(cfg.autoBankrollKellyLarge)
        : 0.12;

    const lowMaxPos = Number.isFinite(Number(cfg.autoBankrollMaxPosLow))
        ? Number(cfg.autoBankrollMaxPosLow)
        : lowKelly;
    const highMaxPos = Number.isFinite(Number(cfg.autoBankrollMaxPosHigh))
        ? Number(cfg.autoBankrollMaxPosHigh)
        : highKelly;
    const largeMaxPos = Number.isFinite(Number(cfg.autoBankrollMaxPosLarge))
        ? Number(cfg.autoBankrollMaxPosLarge)
        : 0.07;

    const envLow = (cfg.autoBankrollRiskEnvelopeLow !== undefined)
        ? !!cfg.autoBankrollRiskEnvelopeLow
        : true;
    const envHigh = (cfg.autoBankrollRiskEnvelopeHigh !== undefined)
        ? !!cfg.autoBankrollRiskEnvelopeHigh
        : false;
    const envLarge = (cfg.autoBankrollRiskEnvelopeLarge !== undefined)
        ? !!cfg.autoBankrollRiskEnvelopeLarge
        : true;

    const rawMode = String(cfg.autoBankrollMode || 'SAFE').trim().toUpperCase();
    const mode = (rawMode === 'SPRINT' || rawMode === 'SAFE') ? rawMode : 'SAFE';

    const defaultKellyEnabled = cfg.kellyEnabledDefault !== false;
    const defaultKellyFraction = clamp01(cfg.kellyFractionDefault, 0.25);
    const defaultProfitProtectionEnabled = true;

    const fallback = {
        maxPositionFraction: clampFraction(cfg.defaultMaxPositionFraction, 0.20),
        kellyMaxFraction: clampFraction(cfg.defaultKellyMaxFraction, 0.17),
        riskEnvelopeEnabled: cfg.defaultRiskEnvelopeEnabled !== undefined ? !!cfg.defaultRiskEnvelopeEnabled : true,
        kellyEnabled: defaultKellyEnabled,
        kellyFraction: defaultKellyFraction,
        profitProtectionEnabled: defaultProfitProtectionEnabled,
        profitProtectionSchedule: 'V96',
        autoBankrollMode: mode,
    };

    if (!enabled) {
        return { enabled: false, cutover, largeCutover, ...fallback, profile: 'DISABLED', reason: 'disabled' };
    }

    if (!Number.isFinite(b)) {
        const base = {
            enabled: true,
            cutover,
            largeCutover,
            maxPositionFraction: clampFraction(highMaxPos, fallback.maxPositionFraction),
            kellyMaxFraction: clampFraction(highKelly, fallback.kellyMaxFraction),
            riskEnvelopeEnabled: envHigh,
            kellyEnabled: defaultKellyEnabled,
            kellyFraction: defaultKellyFraction,
            profitProtectionEnabled: defaultProfitProtectionEnabled,
            profitProtectionSchedule: 'V96',
            autoBankrollMode: mode,
            profile: 'GROWTH',
            reason: 'non_finite_bankroll',
        };

        if (mode === 'SPRINT') {
            base.profile = 'SPRINT_GROWTH';
            base.riskEnvelopeEnabled = true;
            base.profitProtectionEnabled = false;
            base.profitProtectionSchedule = 'SPRINT';
            base.kellyEnabled = defaultKellyEnabled;
            base.reason = 'non_finite_bankroll (SPRINT, Kelly ON)';
        }
        return base;
    }

    if (b >= largeCutover) {
        return {
            enabled: true,
            cutover,
            largeCutover,
            maxPositionFraction: clampFraction(largeMaxPos, fallback.maxPositionFraction),
            kellyMaxFraction: clampFraction(largeKelly, fallback.kellyMaxFraction),
            riskEnvelopeEnabled: envLarge,
            kellyEnabled: defaultKellyEnabled,
            kellyFraction: defaultKellyFraction,
            profitProtectionEnabled: true,
            profitProtectionSchedule: (mode === 'SPRINT') ? 'SPRINT' : 'V96',
            autoBankrollMode: mode,
            profile: 'LARGE_BANKROLL',
            reason: `bankroll>=$${largeCutover} (preserve+balanced mode)`,
        };
    }

    if (b < cutover) {
        if (mode === 'SPRINT') {
            return {
                enabled: true,
                cutover,
                largeCutover,
                maxPositionFraction: clampFraction(highMaxPos, fallback.maxPositionFraction),
                kellyMaxFraction: clampFraction(highKelly, fallback.kellyMaxFraction),
                kellyEnabled: defaultKellyEnabled,
                kellyFraction: defaultKellyFraction,
                riskEnvelopeEnabled: true,
                profitProtectionEnabled: false,
                profitProtectionSchedule: 'SPRINT',
                autoBankrollMode: mode,
                profile: 'MICRO_SPRINT',
                reason: `bankroll<$${cutover} (SPRINT)`,
            };
        }

        return {
            enabled: true,
            cutover,
            largeCutover,
            maxPositionFraction: clampFraction(lowMaxPos, fallback.maxPositionFraction),
            kellyMaxFraction: clampFraction(lowKelly, fallback.kellyMaxFraction),
            riskEnvelopeEnabled: envLow,
            kellyEnabled: defaultKellyEnabled,
            kellyFraction: defaultKellyFraction,
            profitProtectionEnabled: true,
            profitProtectionSchedule: 'V96',
            autoBankrollMode: mode,
            profile: 'MICRO_SAFE',
            reason: `bankroll<$${cutover}`,
        };
    }

    if (mode === 'SPRINT') {
        return {
            enabled: true,
            cutover,
            largeCutover,
            maxPositionFraction: clampFraction(highMaxPos, fallback.maxPositionFraction),
            kellyMaxFraction: clampFraction(highKelly, fallback.kellyMaxFraction),
            riskEnvelopeEnabled: true,
            kellyEnabled: defaultKellyEnabled,
            kellyFraction: defaultKellyFraction,
            profitProtectionEnabled: false,
            profitProtectionSchedule: 'SPRINT',
            autoBankrollMode: mode,
            profile: 'SPRINT_GROWTH',
            reason: `bankroll>=$${cutover} and <$${largeCutover} (SPRINT)`,
        };
    }

    return {
        enabled: true,
        cutover,
        largeCutover,
        maxPositionFraction: clampFraction(highMaxPos, fallback.maxPositionFraction),
        kellyMaxFraction: clampFraction(highKelly, fallback.kellyMaxFraction),
        riskEnvelopeEnabled: envHigh,
        kellyEnabled: defaultKellyEnabled,
        kellyFraction: defaultKellyFraction,
        profitProtectionEnabled: true,
        profitProtectionSchedule: 'V96',
        autoBankrollMode: mode,
        profile: 'GROWTH',
        reason: `bankroll>=$${cutover} and <$${largeCutover}`,
    };
}

function getPeakDrawdownBrakePolicy(currentBalance, lifetimePeakBalance, bankrollPolicy = null, cfg = {}) {
    const enabled = cfg.peakDrawdownBrakeEnabled !== false;

    const ddCapPct = Number.isFinite(Number(cfg.peakDrawdownBrakePct))
        ? Number(cfg.peakDrawdownBrakePct)
        : 0.20;

    const defaultMinBankroll = Number.isFinite(Number(cfg.autoBankrollCutover))
        ? Number(cfg.autoBankrollCutover)
        : 20;
    const minBankroll = Number.isFinite(Number(cfg.peakDrawdownBrakeMinBankroll))
        ? Number(cfg.peakDrawdownBrakeMinBankroll)
        : defaultMinBankroll;

    const capFracRaw = Number.isFinite(Number(cfg.peakDrawdownBrakeMaxPosFraction))
        ? Number(cfg.peakDrawdownBrakeMaxPosFraction)
        : 0.12;
    const capFraction = clampFraction(capFracRaw, 0.12);

    const cur = Number(currentBalance);
    let peak = Number(lifetimePeakBalance);
    if (!Number.isFinite(peak) || peak <= 0) peak = Number.isFinite(cur) ? cur : 0;

    const ddPct = (Number.isFinite(cur) && peak > 0)
        ? Math.max(0, (peak - cur) / peak)
        : 0;

    const inScope = Number.isFinite(cur) && cur >= minBankroll;
    const active = !!enabled && inScope && ddPct >= ddCapPct;

    return {
        enabled: !!enabled,
        active,
        ddCapPct,
        ddPct,
        minBankroll,
        capFraction,
        currentBalance: cur,
        peakBalance: peak,
        profile: bankrollPolicy?.profile || null,
        reason: active
            ? `ddFromPeak ${(ddPct * 100).toFixed(1)}% >= ${(ddCapPct * 100).toFixed(0)}% (cap ${(capFraction * 100).toFixed(0)}%)`
            : (inScope
                ? `ddFromPeak ${(ddPct * 100).toFixed(1)}% < ${(ddCapPct * 100).toFixed(0)}%`
                : `bankroll<$${minBankroll}`),
    };
}

function computeReferenceMinOrderCost(minOrderShares, minOddsReference) {
    const shares = Number.isFinite(Number(minOrderShares))
        ? Math.max(1, Number(minOrderShares))
        : 2;
    const minOdds = Number.isFinite(Number(minOddsReference))
        ? Math.max(0.01, Math.min(0.99, Number(minOddsReference)))
        : 0.35;
    return shares * minOdds;
}

function getEffectiveBalanceFloor(balance, floorCfg, referenceMinOrderCost) {
    const enabled = !!floorCfg?.minBalanceFloorEnabled;
    if (!enabled) return 0;

    const baseFloor = Number(floorCfg?.minBalanceFloor);
    if (!Number.isFinite(baseFloor) || baseFloor <= 0) return 0;

    const bal = Number(balance);
    if (!Number.isFinite(bal) || bal <= 0) return baseFloor;

    const dynEnabled = floorCfg?.minBalanceFloorDynamicEnabled !== false;
    if (!dynEnabled) return baseFloor;

    const frac = Number.isFinite(Number(floorCfg?.minBalanceFloorDynamicFraction))
        ? Math.max(0, Math.min(0.95, Number(floorCfg.minBalanceFloorDynamicFraction)))
        : 0.40;

    const minFloor = Number.isFinite(Number(floorCfg?.minBalanceFloorDynamicMin))
        ? Math.max(0, Number(floorCfg.minBalanceFloorDynamicMin))
        : 0.50;

    let floor = Math.min(baseFloor, Math.max(minFloor, bal * frac));

    const minOrder = Number.isFinite(Number(referenceMinOrderCost)) && Number(referenceMinOrderCost) > 0
        ? Number(referenceMinOrderCost)
        : computeReferenceMinOrderCost(2, 0.35);

    if (bal >= minOrder) {
        const maxFloorToAllowMinOrder = Math.max(minFloor, bal - minOrder);
        floor = Math.min(floor, maxFloorToAllowMinOrder);
    }

    return (Number.isFinite(floor) && floor >= 0) ? floor : 0;
}

function getRuinFloor(floorCfg, referenceMinOrderCost) {
    const minOrder = Number.isFinite(Number(referenceMinOrderCost)) && Number(referenceMinOrderCost) > 0
        ? Number(referenceMinOrderCost)
        : computeReferenceMinOrderCost(2, 0.35);

    const enabled = !!floorCfg?.minBalanceFloorEnabled;
    if (!enabled) return minOrder;

    const baseFloor = Number.isFinite(Number(floorCfg?.minBalanceFloor))
        ? Math.max(0, Number(floorCfg.minBalanceFloor))
        : 0;

    const dynEnabled = floorCfg?.minBalanceFloorDynamicEnabled !== false;
    if (!dynEnabled) {
        return baseFloor + minOrder;
    }

    const minFloor = Number.isFinite(Number(floorCfg?.minBalanceFloorDynamicMin))
        ? Math.max(0, Number(floorCfg.minBalanceFloorDynamicMin))
        : 0.50;

    return minFloor + minOrder;
}

function getSurvivalFloor(balance, floorCfg, referenceMinOrderCost) {
    const enabled = !!floorCfg?.minBalanceFloorEnabled;
    if (!enabled) return 0;
    const eff = getEffectiveBalanceFloor(balance, floorCfg, referenceMinOrderCost);
    const ruin = getRuinFloor(floorCfg, referenceMinOrderCost);
    const s = Math.max(Number(eff) || 0, Number(ruin) || 0);
    return Number.isFinite(s) ? Math.max(0, s) : 0;
}

function createCircuitBreakerConfig(overrides = {}) {
    return {
        enabled: overrides.circuitBreakerEnabled !== false,
        state: 'NORMAL',
        triggerTime: 0,
        softDrawdownPct: Number.isFinite(Number(overrides.circuitBreakerSoftDrawdownPct))
            ? Number(overrides.circuitBreakerSoftDrawdownPct)
            : 0.25,
        hardDrawdownPct: Number.isFinite(Number(overrides.circuitBreakerHardDrawdownPct))
            ? Number(overrides.circuitBreakerHardDrawdownPct)
            : 0.45,
        haltDrawdownPct: Number.isFinite(Number(overrides.circuitBreakerHaltDrawdownPct))
            ? Number(overrides.circuitBreakerHaltDrawdownPct)
            : 0.70,
        safeOnlyAfterLosses: Number.isFinite(Number(overrides.circuitBreakerSafeOnlyAfterLosses))
            ? Math.max(1, Math.floor(Number(overrides.circuitBreakerSafeOnlyAfterLosses)))
            : 3,
        probeOnlyAfterLosses: Number.isFinite(Number(overrides.circuitBreakerProbeOnlyAfterLosses))
            ? Math.max(1, Math.floor(Number(overrides.circuitBreakerProbeOnlyAfterLosses)))
            : 5,
        haltAfterLosses: Number.isFinite(Number(overrides.circuitBreakerHaltAfterLosses))
            ? Math.max(1, Math.floor(Number(overrides.circuitBreakerHaltAfterLosses)))
            : 7,
        resumeAfterMinutes: Number.isFinite(Number(overrides.circuitBreakerResumeAfterMinutes))
            ? Math.max(0, Number(overrides.circuitBreakerResumeAfterMinutes))
            : 20,
        resumeAfterWin: overrides.circuitBreakerResumeAfterWin !== false,
        resumeOnNewDay: overrides.circuitBreakerResumeOnNewDay !== false,
        dayStartBalance: null,
        dayStartTime: null,
        peakBalance: null,
    };
}

function updateCircuitBreakerState(cb, context = {}) {
    if (!cb?.enabled) {
        return {
            state: cb?.state || 'NORMAL',
            drawdownPct: 0,
            lossStreak: Number(context?.consecutiveLosses) || 0,
            reason: 'CircuitBreaker disabled',
        };
    }

    const nowMs = Number.isFinite(Number(context.nowMs)) ? Number(context.nowMs) : Date.now();
    const currentBalance = Number(context.currentBalance);
    const lossStreak = Number.isFinite(Number(context.consecutiveLosses))
        ? Math.max(0, Math.floor(Number(context.consecutiveLosses)))
        : 0;
    const dayChanged = context.dayChanged === true;

    if (dayChanged || !Number.isFinite(Number(cb.dayStartBalance)) || Number(cb.dayStartBalance) <= 0) {
        cb.dayStartBalance = Number.isFinite(currentBalance)
            ? currentBalance
            : (Number(cb.dayStartBalance) || 0);
        cb.dayStartTime = nowMs;
        cb.peakBalance = Number.isFinite(currentBalance)
            ? currentBalance
            : (Number(cb.peakBalance) || cb.dayStartBalance);
        if (cb.resumeOnNewDay && cb.state !== 'NORMAL') {
            cb.state = 'NORMAL';
            cb.triggerTime = nowMs;
        }
    }

    if (!Number.isFinite(Number(cb.peakBalance)) || currentBalance > cb.peakBalance) {
        cb.peakBalance = currentBalance;
    }

    const dayStart = Number.isFinite(Number(context.dayStartBalance))
        ? Number(context.dayStartBalance)
        : Number(cb.dayStartBalance);

    const drawdownPct = (Number.isFinite(currentBalance) && Number.isFinite(dayStart) && dayStart > 0)
        ? Math.max(0, (dayStart - currentBalance) / dayStart)
        : 0;

    let newState = 'NORMAL';
    let reason = '';

    if (drawdownPct >= cb.haltDrawdownPct) {
        newState = 'HALTED';
        reason = `Drawdown ${(drawdownPct * 100).toFixed(1)}% >= ${(cb.haltDrawdownPct * 100).toFixed(0)}%`;
    } else if (drawdownPct >= cb.hardDrawdownPct) {
        newState = 'PROBE_ONLY';
        reason = `Drawdown ${(drawdownPct * 100).toFixed(1)}% >= ${(cb.hardDrawdownPct * 100).toFixed(0)}%`;
    } else if (drawdownPct >= cb.softDrawdownPct) {
        newState = 'SAFE_ONLY';
        reason = `Drawdown ${(drawdownPct * 100).toFixed(1)}% >= ${(cb.softDrawdownPct * 100).toFixed(0)}%`;
    }

    if (lossStreak >= cb.haltAfterLosses && newState !== 'HALTED') {
        newState = 'HALTED';
        reason = `Loss streak ${lossStreak} >= ${cb.haltAfterLosses}`;
    } else if (lossStreak >= cb.probeOnlyAfterLosses && newState === 'NORMAL') {
        newState = 'PROBE_ONLY';
        reason = `Loss streak ${lossStreak} >= ${cb.probeOnlyAfterLosses}`;
    } else if (lossStreak >= cb.safeOnlyAfterLosses && newState === 'NORMAL') {
        newState = 'SAFE_ONLY';
        reason = `Loss streak ${lossStreak} >= ${cb.safeOnlyAfterLosses}`;
    }

    if (cb.state !== 'NORMAL' && newState === 'NORMAL') {
        const timeSinceTrigger = nowMs - (Number(cb.triggerTime) || 0);
        const minResumeMs = Number(cb.resumeAfterMinutes) * 60 * 1000;
        if (timeSinceTrigger < minResumeMs && lossStreak > 0) {
            newState = cb.state;
            reason = `Waiting ${Math.ceil((minResumeMs - timeSinceTrigger) / 60000)}min or a win to resume`;
        }
    }

    if (newState !== cb.state) {
        cb.triggerTime = nowMs;
    }

    cb.state = newState;
    return { state: newState, drawdownPct, lossStreak, reason };
}

function getCircuitBreakerAllowance(cb, tradeType = 'NORMAL') {
    if (!cb?.enabled) return { allowed: true, sizeMultiplier: 1.0, reason: 'CircuitBreaker disabled' };

    switch (cb.state) {
        case 'HALTED':
            return { allowed: false, reason: 'CircuitBreaker HALTED - no trades until conditions improve or new day' };
        case 'PROBE_ONLY':
            return { allowed: true, sizeMultiplier: 0.25, reason: 'CircuitBreaker PROBE_ONLY - 25% size only' };
        case 'SAFE_ONLY':
            if (tradeType === 'ACCELERATION') {
                return { allowed: false, reason: 'CircuitBreaker SAFE_ONLY - Acceleration trades blocked' };
            }
            return { allowed: true, sizeMultiplier: 0.5, reason: 'CircuitBreaker SAFE_ONLY - 50% size' };
        default:
            return { allowed: true, sizeMultiplier: 1.0, reason: 'CircuitBreaker NORMAL' };
    }
}

function getStreakSizeMultiplier(consecutiveLosses, recentWinStreak, streakCfg = {}) {
    if (streakCfg?.enabled === false) return 1.0;

    const lossMultipliers = (Array.isArray(streakCfg.lossMultipliers) && streakCfg.lossMultipliers.length)
        ? streakCfg.lossMultipliers
        : [1.0, 0.85, 0.70, 0.55, 0.40];
    const winMultipliers = (Array.isArray(streakCfg.winMultipliers) && streakCfg.winMultipliers.length)
        ? streakCfg.winMultipliers
        : [1.0, 1.05, 1.10, 1.15];
    const winBonusEnabled = streakCfg.winBonusEnabled !== false;

    const lossStreak = Number.isFinite(Number(consecutiveLosses)) ? Math.max(0, Math.floor(Number(consecutiveLosses))) : 0;
    const winStreak = Number.isFinite(Number(recentWinStreak)) ? Math.max(0, Math.floor(Number(recentWinStreak))) : 0;

    let multiplier = 1.0;
    if (lossStreak > 0) {
        const idx = Math.min(lossStreak, lossMultipliers.length - 1);
        const m = Number(lossMultipliers[idx]);
        if (Number.isFinite(m) && m > 0) multiplier = m;
    }

    if (winBonusEnabled && winStreak > 0 && lossStreak === 0) {
        const idx = Math.min(winStreak, winMultipliers.length - 1);
        const m = Number(winMultipliers[idx]);
        if (Number.isFinite(m) && m > 0) multiplier *= m;
    }

    return Number.isFinite(multiplier) && multiplier > 0 ? multiplier : 1.0;
}

function getMaxLossBudget(dayStartBalance, streakCfg = {}) {
    const dayStart = Number(dayStartBalance);
    if (!Number.isFinite(dayStart) || dayStart <= 0) return 0;
    const budgetPct = Number.isFinite(Number(streakCfg.maxLossBudgetPct))
        ? Math.max(0, Number(streakCfg.maxLossBudgetPct))
        : 0.25;
    return dayStart * budgetPct;
}

function getDynamicRiskProfile(bankroll, thresholdOverrides = {}) {
    const b = Number(bankroll);
    const thresholds = getVaultThresholds(thresholdOverrides);
    const stage1 = Number(thresholds.vaultTriggerBalance);
    const stage2 = Number(thresholds.stage2Threshold);

    if (!Number.isFinite(b) || b < stage1) {
        return {
            stage: 0,
            stageName: 'BOOTSTRAP',
            intradayLossBudgetPct: 0.50,
            trailingDrawdownPct: 0.40,
            perTradeLossCap: 0.75,
            minOrderRiskOverride: true,
            thresholds,
        };
    }

    if (b < stage2) {
        return {
            stage: 1,
            stageName: 'TRANSITION',
            intradayLossBudgetPct: 0.35,
            trailingDrawdownPct: 0.20,
            perTradeLossCap: 0.25,
            minOrderRiskOverride: false,
            thresholds,
        };
    }

    return {
        stage: 2,
        stageName: 'LOCK_IN',
        intradayLossBudgetPct: 0.25,
        trailingDrawdownPct: 0.10,
        perTradeLossCap: 0.10,
        minOrderRiskOverride: false,
        thresholds,
    };
}

function applyRiskEnvelopeToStake(proposedStakeUsd, context = {}) {
    const stake = Number(proposedStakeUsd);
    if (!Number.isFinite(stake) || stake <= 0) {
        return { size: 0, blocked: true, capped: false, reason: 'Invalid stake', profile: null, envelope: null };
    }

    const balance = Number(context.balance);
    const dayStartBalance = Number(context.dayStartBalance);
    const peakBalance = Number(context.peakBalance);
    const minOrderCost = Number(context.minOrderCost);
    const floorCfg = context.floorCfg || {};
    const referenceMinOrderCost = Number(context.referenceMinOrderCost);
    const thresholdOverrides = context.thresholdOverrides || {};
    const bankrollPolicy = context.bankrollPolicy || null;

    const profile = getDynamicRiskProfile(balance, thresholdOverrides);

    const intradayBudget = dayStartBalance * profile.intradayLossBudgetPct - Math.max(0, dayStartBalance - balance);
    const trailingBudget = peakBalance * profile.trailingDrawdownPct - Math.max(0, peakBalance - balance);
    const effectiveBudget = Math.max(0, Math.min(intradayBudget, trailingBudget));

    let maxTradeSize = effectiveBudget * profile.perTradeLossCap;
    if (Number.isFinite(minOrderCost) && effectiveBudget >= minOrderCost) {
        maxTradeSize = Math.max(minOrderCost, maxTradeSize);
    }

    const floorEnabled = !!floorCfg.minBalanceFloorEnabled;
    const isEnvMicroSprint = bankrollPolicy?.profile === 'MICRO_SPRINT';
    const survivalFloor = (floorEnabled && !isEnvMicroSprint) ? getSurvivalFloor(balance, floorCfg, referenceMinOrderCost) : 0;
    const maxSafeStake = (floorEnabled && !isEnvMicroSprint) ? Math.max(0, balance - survivalFloor) : Infinity;

    if (Number.isFinite(minOrderCost) && effectiveBudget < minOrderCost) {
        if (profile.minOrderRiskOverride && balance >= minOrderCost && minOrderCost <= maxSafeStake) {
            return {
                size: minOrderCost,
                capped: stake > minOrderCost,
                blocked: false,
                overrideUsed: true,
                profile,
                envelope: { effectiveBudget, maxTradeSize, intradayBudget, trailingBudget },
            };
        }
        return {
            size: 0,
            capped: false,
            blocked: true,
            reason: `Risk budget exhausted: $${effectiveBudget.toFixed(2)} < minOrderCost $${minOrderCost.toFixed(2)} (${profile.stageName})`,
            profile,
            envelope: { effectiveBudget, maxTradeSize, intradayBudget, trailingBudget },
        };
    }

    let size = stake;
    let capped = false;

    if (size > maxTradeSize) {
        size = maxTradeSize;
        capped = true;
    }

    if (size > maxSafeStake) {
        size = maxSafeStake;
        capped = true;
    }

    if (Number.isFinite(minOrderCost) && size < minOrderCost) {
        return {
            size: 0,
            capped,
            blocked: true,
            reason: `Size $${size.toFixed(2)} < minOrderCost $${minOrderCost.toFixed(2)} after caps (${profile.stageName})`,
            profile,
            envelope: { effectiveBudget, maxTradeSize, intradayBudget, trailingBudget },
        };
    }

    return {
        size,
        capped,
        blocked: false,
        profile,
        envelope: { effectiveBudget, maxTradeSize, intradayBudget, trailingBudget },
    };
}

function simulateBankrollPath(executedTradesInput, options = {}) {
    const trades = Array.isArray(executedTradesInput) ? executedTradesInput.slice() : [];
    trades.sort((a, b) => {
        const ta = Number(a?.cycleStartEpochSec ?? a?.cycleStartEpoch ?? (Number(a?.issuedAt) / 1000));
        const tb = Number(b?.cycleStartEpochSec ?? b?.cycleStartEpoch ?? (Number(b?.issuedAt) / 1000));
        if (Number.isFinite(ta) && Number.isFinite(tb) && ta !== tb) return ta - tb;
        return String(a?.id || '').localeCompare(String(b?.id || ''));
    });

    const startingBalance = Number.isFinite(Number(options.startingBalance))
        ? Math.max(0.01, Number(options.startingBalance))
        : 5;
    const stakeFraction = clampFraction(options.stakeFraction, 0.20);
    const operatorStakeFractionOverride = Number.isFinite(Number(options.operatorStakeFractionOverride)) && Number(options.operatorStakeFractionOverride) > 0
        ? clampFraction(options.operatorStakeFractionOverride, stakeFraction)
        : null;
    const operatorStakeFractionBankrollAware = options.operatorStakeFractionBankrollAware === true;
    const maxExposure = clamp01(options.maxExposure, 0.60);
    const maxAbsoluteStake = Number.isFinite(Number(options.maxAbsoluteStake))
        ? Math.max(0.01, Number(options.maxAbsoluteStake))
        : 100;
    const tieredAbsEnabled = options.tieredMaxAbsoluteStake !== false;

    const slippagePct = Number.isFinite(Number(options.slippagePct))
        ? Math.max(0, Number(options.slippagePct))
        : 0.01;
    const feeModel = options.feeModel || getPolymarketTakerFeeModel();

    const stakeProvided = Number.isFinite(Number(options.fixedStakeUsd)) && Number(options.fixedStakeUsd) > 0;
    const fixedStakeUsd = stakeProvided ? Number(options.fixedStakeUsd) : null;

    const kellyRequested = options.kellyEnabled !== false;
    const kellyFraction = clamp01(options.kellyFraction, 0.25);
    const kellyMaxFraction = clampFraction(options.kellyMaxFraction, 0.32);

    const adaptiveRequested = options.adaptiveMode !== false;
    const autoProfileEnabled = options.autoProfileEnabled !== false;
    const allowDynamicStake = options.allowDynamicStake !== false;

    const riskEnvelopeBase = options.riskEnvelopeEnabled !== false;
    const simulateHalts = options.simulateHalts !== false;
    const maxConsecutiveLosses = Number.isFinite(Number(options.maxConsecutiveLosses))
        ? Math.max(1, Math.floor(Number(options.maxConsecutiveLosses)))
        : 3;
    const cooldownSeconds = Number.isFinite(Number(options.cooldownSeconds))
        ? Math.max(0, Math.floor(Number(options.cooldownSeconds)))
        : 1200;
    const globalStopLoss = clamp01(options.globalStopLoss, 0.20);

    const minOrderShares = Number.isFinite(Number(options.minOrderShares))
        ? Math.max(1, Math.floor(Number(options.minOrderShares)))
        : 2;
    const minOddsEntry = Number.isFinite(Number(options.minOddsEntry))
        ? Math.max(0.01, Math.min(0.99, Number(options.minOddsEntry)))
        : 0.35;

    const minOrderCostOverride = (options.minOrderCostOverride !== null && options.minOrderCostOverride !== undefined && Number.isFinite(Number(options.minOrderCostOverride)))
        ? Math.max(0, Number(options.minOrderCostOverride))
        : null;

    const floorCfg = {
        minBalanceFloorEnabled: options.minBalanceFloorEnabled !== false,
        minBalanceFloor: Number.isFinite(Number(options.minBalanceFloor)) ? Math.max(0, Number(options.minBalanceFloor)) : 2.0,
        minBalanceFloorDynamicEnabled: options.minBalanceFloorDynamicEnabled !== false,
        minBalanceFloorDynamicFraction: Number.isFinite(Number(options.minBalanceFloorDynamicFraction))
            ? Number(options.minBalanceFloorDynamicFraction)
            : 0.40,
        minBalanceFloorDynamicMin: Number.isFinite(Number(options.minBalanceFloorDynamicMin))
            ? Number(options.minBalanceFloorDynamicMin)
            : 0.50,
    };

    const referenceMinOrderCost = minOrderCostOverride !== null
        ? minOrderCostOverride
        : computeReferenceMinOrderCost(minOrderShares, minOddsEntry);

    const thresholdOverrides = {
        startingBalance,
        relativeMode: options.relativeThresholds === true,
        stage1Mult: options.stage1Mult,
        stage2Mult: options.stage2Mult,
        vaultTriggerBalance: options.vaultTriggerBalance,
        stage2Threshold: options.stage2Threshold,
    };
    const vaultThresholds = getVaultThresholds(thresholdOverrides);

    const streakCfg = {
        enabled: options.streakSizingEnabled !== false,
        lossMultipliers: (Array.isArray(options.lossMultipliers) && options.lossMultipliers.length)
            ? options.lossMultipliers
            : [1.0, 0.85, 0.70, 0.55, 0.40],
        winBonusEnabled: options.winBonusEnabled !== false,
        winMultipliers: (Array.isArray(options.winMultipliers) && options.winMultipliers.length)
            ? options.winMultipliers
            : [1.0, 1.05, 1.10, 1.15],
        maxLossBudgetPct: Number.isFinite(Number(options.maxLossBudgetPct))
            ? Math.max(0, Number(options.maxLossBudgetPct))
            : 0.25,
    };

    const cb = createCircuitBreakerConfig(options);

    const missRate = clamp01(options.missRate, 0);
    const rng = missRate > 0 ? createSeededRng(options.seed) : null;

    let balance = startingBalance;
    let dayStartBalance = startingBalance;
    let peakBalanceToday = startingBalance;
    let lifetimePeakBalance = startingBalance;
    let currentDay = null;

    let globalStopTriggeredToday = false;
    let consecutiveLosses = 0;
    let recentWinStreak = 0;
    let lossStreakObserved = 0;
    let lastLossEpochSec = -Infinity;

    let executed = 0;
    let blocked = 0;
    let wins = 0;
    let losses = 0;
    let pending = 0;
    let totalFeesUsd = 0;
    let maxDrawdownPct = 0;
    let envelopeCaps = 0;
    let peakBrakeCaps = 0;

    const blockedByReason = {};
    const haltCounts = {
        globalStop: 0,
        cooldown: 0,
        circuitBreaker: 0,
        floor: 0,
        ruin: 0,
        riskEnvelope: 0,
        minOrder: 0,
        miss: 0,
    };

    let firstLossTrade = null;

    for (const t of trades) {
        const won = t?.won;
        if (won !== true && won !== false) {
            pending += 1;
            continue;
        }

        const cycleEpochSecRaw = Number(t?.cycleStartEpochSec ?? t?.cycleStartEpoch ?? (Number(t?.issuedAt) / 1000));
        const cycleEpochSec = Number.isFinite(cycleEpochSecRaw) ? Math.floor(cycleEpochSecRaw) : 0;
        const cycleDay = dayKeyUtc(cycleEpochSec);
        const isNewDay = !!cycleDay && cycleDay !== currentDay;

        if (isNewDay) {
            currentDay = cycleDay;
            dayStartBalance = balance;
            peakBalanceToday = balance;
            globalStopTriggeredToday = false;
        }

        if (balance > lifetimePeakBalance) lifetimePeakBalance = balance;
        if (balance > peakBalanceToday) peakBalanceToday = balance;

        const entryPriceRaw = Number(t?.entryPrice);
        if (!Number.isFinite(entryPriceRaw) || entryPriceRaw <= 0 || entryPriceRaw >= 1) {
            blocked += 1;
            blockedByReason.INVALID_ENTRY_PRICE = (blockedByReason.INVALID_ENTRY_PRICE || 0) + 1;
            continue;
        }

        const effectiveEntryForMin = Math.min(0.99, entryPriceRaw * (1 + slippagePct));
        const minOrderCost = minOrderCostOverride !== null
            ? minOrderCostOverride
            : computeReferenceMinOrderCost(minOrderShares, effectiveEntryForMin);
        const effectiveFloor = getEffectiveBalanceFloor(balance, floorCfg, referenceMinOrderCost);
        const ruinFloor = getRuinFloor(floorCfg, referenceMinOrderCost);

        let blockedReason = null;
        let cbAllowance = { allowed: true, sizeMultiplier: 1.0, reason: 'CircuitBreaker disabled' };

        if (simulateHalts) {
            const todayPnl = balance - dayStartBalance;
            const maxDayLoss = dayStartBalance * globalStopLoss;
            if (todayPnl < -maxDayLoss && !globalStopTriggeredToday) {
                globalStopTriggeredToday = true;
            }
            if (globalStopTriggeredToday) {
                blockedReason = 'GLOBAL_STOP_LOSS';
                haltCounts.globalStop += 1;
            }

            if (!blockedReason && consecutiveLosses >= maxConsecutiveLosses) {
                const sinceLoss = cycleEpochSec - lastLossEpochSec;
                if (sinceLoss < cooldownSeconds) {
                    blockedReason = 'COOLDOWN_ACTIVE';
                    haltCounts.cooldown += 1;
                } else {
                    consecutiveLosses = 0;
                }
            }

            if (!blockedReason) {
                updateCircuitBreakerState(cb, {
                    currentBalance: balance,
                    dayStartBalance,
                    consecutiveLosses,
                    nowMs: cycleEpochSec * 1000,
                    dayChanged: isNewDay,
                });
                cbAllowance = getCircuitBreakerAllowance(cb, 'NORMAL');
                if (!cbAllowance.allowed) {
                    blockedReason = 'CIRCUIT_BREAKER_BLOCK';
                    haltCounts.circuitBreaker += 1;
                }
            }
        }

        if (!blockedReason && floorCfg.minBalanceFloorEnabled && balance < effectiveFloor) {
            blockedReason = 'MIN_BALANCE_FLOOR';
            haltCounts.floor += 1;
        }
        if (!blockedReason && balance <= ruinFloor) {
            blockedReason = 'RUIN_FLOOR';
            haltCounts.ruin += 1;
        }

        if (!blockedReason && missRate > 0 && rng && rng.next() < missRate) {
            blockedReason = 'MISSED_TRADE';
            haltCounts.miss += 1;
        }

        if (blockedReason) {
            blocked += 1;
            blockedByReason[blockedReason] = (blockedByReason[blockedReason] || 0) + 1;
            continue;
        }

        const balanceBefore = balance;
        const policy = autoProfileEnabled ? getBankrollAdaptivePolicy(balanceBefore, options) : null;
        const isMicroSprint = policy?.profile === 'MICRO_SPRINT';
        const survivalFloor = (floorCfg.minBalanceFloorEnabled && !isMicroSprint)
            ? getSurvivalFloor(balanceBefore, floorCfg, referenceMinOrderCost)
            : 0;

        let effectiveStakeFraction = Number.isFinite(Number(t?.operatorStakeFraction)) && Number(t?.operatorStakeFraction) > 0
            ? clampFraction(t.operatorStakeFraction, stakeFraction)
            : stakeFraction;
        if (!stakeProvided && !(Number.isFinite(Number(t?.operatorStakeFraction)) && Number(t?.operatorStakeFraction) > 0)) {
            if (operatorStakeFractionOverride !== null) {
                effectiveStakeFraction = operatorStakeFractionOverride;
            } else if (operatorStakeFractionBankrollAware) {
                effectiveStakeFraction = clampFraction(pickOperatorStakeFractionDefault(balanceBefore), effectiveStakeFraction);
            }
        }

        if (!stakeProvided && allowDynamicStake && policy && Number.isFinite(Number(policy.maxPositionFraction))) {
            effectiveStakeFraction = clampFraction(policy.maxPositionFraction, effectiveStakeFraction);
        }

        const profitProtectionEnabled = adaptiveRequested && !(policy && policy.profitProtectionEnabled === false);
        let profitProtectionMult = 1.0;
        if (profitProtectionEnabled) {
            profitProtectionMult = getProfitLockMultiplier(balanceBefore / startingBalance);
            effectiveStakeFraction = clampFraction(effectiveStakeFraction * profitProtectionMult, effectiveStakeFraction);
        }

        const effectiveKellyEnabled = kellyRequested && !(policy && policy.kellyEnabled === false);
        const effectiveKellyFraction = (policy && Number.isFinite(Number(policy.kellyFraction)))
            ? clamp01(policy.kellyFraction, kellyFraction)
            : kellyFraction;
        let effectiveKellyMaxFraction = (policy && Number.isFinite(Number(policy.kellyMaxFraction)))
            ? clampFraction(policy.kellyMaxFraction, kellyMaxFraction)
            : kellyMaxFraction;

        const peakBrake = getPeakDrawdownBrakePolicy(balanceBefore, lifetimePeakBalance, policy, options);
        if (peakBrake.active && effectiveKellyMaxFraction > peakBrake.capFraction) {
            effectiveKellyMaxFraction = peakBrake.capFraction;
            peakBrakeCaps += 1;
        }

        let stake = 0;
        if (stakeProvided) {
            stake = fixedStakeUsd;
        } else if (effectiveKellyEnabled) {
            const pWinRaw = Number(t?.pWin ?? t?.strategyWinRateLCB);
            const pWin = Number.isFinite(pWinRaw) ? clamp01(pWinRaw, 0.55) : 0.55;
            const kellyF = calcKellyFraction(pWin, entryPriceRaw, slippagePct, feeModel);
            if (kellyF !== null) {
                stake = balanceBefore * Math.min(kellyF * effectiveKellyFraction, effectiveKellyMaxFraction);
                if (profitProtectionEnabled) stake *= profitProtectionMult;
            } else {
                stake = balanceBefore * effectiveStakeFraction;
            }
        } else {
            stake = balanceBefore * effectiveStakeFraction;
        }

        const maxBudget = balanceBefore * maxExposure;
        const maxAbsStake = tieredAbsEnabled
            ? getTieredMaxAbsoluteStake(balanceBefore, maxAbsoluteStake)
            : maxAbsoluteStake;
        stake = Math.min(stake, maxBudget, maxAbsStake);

        if (cbAllowance.sizeMultiplier && cbAllowance.sizeMultiplier < 1.0) {
            stake *= cbAllowance.sizeMultiplier;
        }

        const streakMult = getStreakSizeMultiplier(consecutiveLosses, recentWinStreak, streakCfg);
        stake *= streakMult;

        const maxLossBudget = getMaxLossBudget(dayStartBalance, streakCfg);
        const maxSizeByBudget = maxLossBudget / 0.50;
        if (Number.isFinite(maxSizeByBudget) && maxSizeByBudget > 0 && stake > maxSizeByBudget) {
            stake = maxSizeByBudget;
        }

        if (!Number.isFinite(stake) || stake <= 0) {
            blocked += 1;
            blockedByReason.INVALID_STAKE = (blockedByReason.INVALID_STAKE || 0) + 1;
            continue;
        }

        if (stake < minOrderCost) {
            const minBankrollForMinOrder = (floorCfg.minBalanceFloorEnabled && !isMicroSprint)
                ? (survivalFloor + minOrderCost)
                : (minOrderCost * 1.05);
            if (balanceBefore >= minBankrollForMinOrder) {
                stake = minOrderCost;
                envelopeCaps += 1;
            } else {
                blocked += 1;
                blockedByReason.MIN_ORDER_UNAFFORDABLE = (blockedByReason.MIN_ORDER_UNAFFORDABLE || 0) + 1;
                haltCounts.minOrder += 1;
                continue;
            }
        }

        if (floorCfg.minBalanceFloorEnabled && !isMicroSprint) {
            const maxSafeStake = Math.max(0, balanceBefore - survivalFloor);
            if (stake > maxSafeStake) {
                stake = maxSafeStake;
                envelopeCaps += 1;
            }
            if (stake < minOrderCost) {
                blocked += 1;
                blockedByReason.SURVIVAL_FLOOR = (blockedByReason.SURVIVAL_FLOOR || 0) + 1;
                haltCounts.floor += 1;
                continue;
            }
        }

        const effectiveRiskEnvelopeEnabled = (policy && policy.riskEnvelopeEnabled !== undefined)
            ? !!policy.riskEnvelopeEnabled
            : !!riskEnvelopeBase;

        if (effectiveRiskEnvelopeEnabled) {
            const envelopeRes = applyRiskEnvelopeToStake(stake, {
                balance: balanceBefore,
                dayStartBalance,
                peakBalance: peakBalanceToday,
                minOrderCost,
                floorCfg,
                referenceMinOrderCost,
                bankrollPolicy: policy,
                thresholdOverrides: {
                    ...thresholdOverrides,
                    vaultTriggerBalance: vaultThresholds.vaultTriggerBalance,
                    stage2Threshold: vaultThresholds.stage2Threshold,
                },
            });

            if (envelopeRes.blocked) {
                blocked += 1;
                blockedByReason.RISK_ENVELOPE = (blockedByReason.RISK_ENVELOPE || 0) + 1;
                haltCounts.riskEnvelope += 1;
                continue;
            }

            if (envelopeRes.capped) envelopeCaps += 1;
            stake = envelopeRes.size;
        }

        if (!Number.isFinite(stake) || stake <= 0 || stake < minOrderCost) {
            blocked += 1;
            blockedByReason.MIN_ORDER_POST_CAP = (blockedByReason.MIN_ORDER_POST_CAP || 0) + 1;
            haltCounts.minOrder += 1;
            continue;
        }

        const tradeRes = calcBinaryTradeDeltaUsdAfterFees(stake, entryPriceRaw, won === true, { slippagePct, feeModel });
        const deltaUsd = Number(tradeRes.deltaUsd);
        const feeUsd = Number.isFinite(Number(tradeRes.feeUsd)) ? Number(tradeRes.feeUsd) : 0;
        balance = Math.max(0, balanceBefore + (Number.isFinite(deltaUsd) ? deltaUsd : 0));
        totalFeesUsd += feeUsd;
        executed += 1;

        if (balance > peakBalanceToday) peakBalanceToday = balance;
        if (balance > lifetimePeakBalance) lifetimePeakBalance = balance;
        const ddPct = lifetimePeakBalance > 0 ? Math.max(0, (lifetimePeakBalance - balance) / lifetimePeakBalance) : 0;
        if (ddPct > maxDrawdownPct) maxDrawdownPct = ddPct;

        if (won === true) {
            wins += 1;
            recentWinStreak += 1;
            consecutiveLosses = 0;
            if (cb.resumeAfterWin && cb.state !== 'NORMAL') {
                cb.state = 'NORMAL';
                cb.triggerTime = cycleEpochSec * 1000;
            }
        } else {
            losses += 1;
            consecutiveLosses += 1;
            recentWinStreak = 0;
            if (consecutiveLosses > lossStreakObserved) lossStreakObserved = consecutiveLosses;
            lastLossEpochSec = cycleEpochSec;

            if (!firstLossTrade) {
                firstLossTrade = {
                    id: t?.id ?? null,
                    asset: t?.asset ?? null,
                    direction: t?.direction ?? null,
                    cycleStartEpochSec: cycleEpochSec,
                    entryPrice: entryPriceRaw,
                    stake,
                    feeUsd,
                    deltaUsd,
                    balanceBefore,
                    balanceAfter: balance,
                };
            }
        }
    }

    const resolved = wins + losses;
    const winRate = resolved > 0 ? wins / resolved : 0;
    const roi = startingBalance > 0 ? (balance - startingBalance) / startingBalance : null;

    return {
        config: {
            startingBalance,
            stakeFraction,
            operatorStakeFractionOverride,
            operatorStakeFractionBankrollAware,
            maxExposure,
            maxAbsoluteStake,
            tieredAbsEnabled,
            slippagePct,
            kellyRequested,
            kellyFraction,
            kellyMaxFraction,
            adaptiveRequested,
            autoProfileEnabled,
            riskEnvelopeBase,
            simulateHalts,
            maxConsecutiveLosses,
            cooldownSeconds,
            globalStopLoss,
            floorCfg,
            minOrderShares,
            minOddsEntry,
            vaultThresholds,
            missRate,
        },
        stats: {
            tradesSeen: trades.length,
            executed,
            blocked,
            pending,
            wins,
            losses,
            resolved,
            winRate,
            startingBalance,
            endingBalance: balance,
            roi,
            totalFeesUsd,
            maxDrawdownPct,
            maxLossStreak: lossStreakObserved,
            envelopeCaps,
            peakBrakeCaps,
            blockedByReason,
            haltCounts,
        },
        firstLossTrade,
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
                    if (escape) {
                        escape = false;
                    } else if (ch === '\\') {
                        escape = true;
                    } else if (ch === '"') {
                        inString = false;
                    }
                    continue;
                }

                if (ch === '"') {
                    inString = true;
                    continue;
                }

                if (ch === '{') {
                    depth++;
                    continue;
                }

                if (ch === '}') {
                    depth--;
                    if (depth === 0) {
                        let obj;
                        try {
                            obj = JSON.parse(objBuf);
                        } catch (e) {
                            fail(
                                new Error(`JSON.parse failed after ${seen} objects: ${String(e && e.message ? e.message : e)}`)
                            );
                            return;
                        }

                        seen++;
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

                        if (logEvery && seen % logEvery === 0) {
                            process.stdout.write(`...parsed ${seen} rows\r`);
                        }
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

async function main() {
    const repoRoot = path.resolve(__dirname, '..');

    const datasetPath = readArgValue('--dataset=') || path.join(repoRoot, 'exhaustive_analysis', 'decision_dataset.json');
    const strategiesPath = readArgValue('--strategies=') || path.join(repoRoot, 'optimized_strategies.json');

    if (!fs.existsSync(datasetPath)) {
        throw new Error(`Missing dataset file: ${datasetPath}`);
    }
    if (!fs.existsSync(strategiesPath)) {
        throw new Error(`Missing strategies file: ${strategiesPath}`);
    }

    const outDir = readArgValue('--outDir=') || path.join(repoRoot, 'debug');
    fs.mkdirSync(outDir, { recursive: true });

    const signalOutPath = readArgValue('--signalOut=') || path.join(outDir, 'hybrid_replay_signal_ledger.json');
    const executedOutPath = readArgValue('--executedOut=') || path.join(outDir, 'hybrid_replay_executed_ledger.json');

    const startEpochSec = parseEpochArg('startEpochSec');
    const endEpochSec = parseEpochArg('endEpochSec');
    const maxRows = parseIntArg('maxRows', null);

    const simulateBankroll = parseBoolArg('simulateBankroll', true);
    const fixedStakeUsdArg = parseOptionalFloatArg('fixedStakeUsd');
    const stage1MultArg = parseOptionalFloatArg('stage1Mult');
    const stage2MultArg = parseOptionalFloatArg('stage2Mult');
    const vaultTriggerBalanceArg = parseOptionalFloatArg('vaultTriggerBalance');
    const stage2ThresholdArg = parseOptionalFloatArg('stage2Threshold');
    const seedArg = parseOptionalIntArg('seed');

    const bankrollSimConfig = {
        startingBalance: parseFloatArg('startingBalance', 5),
        stakeFraction: parseFloatArg('stakeFraction', 0.20),
        maxExposure: parseFloatArg('maxExposure', 0.60),
        maxAbsoluteStake: parseFloatArg('maxAbsoluteStake', 100),
        tieredMaxAbsoluteStake: parseBoolArg('tieredMaxAbsoluteStake', true),
        slippagePct: parseFloatArg('slippagePct', 0.01),
        fixedStakeUsd: Number.isFinite(fixedStakeUsdArg) ? fixedStakeUsdArg : undefined,

        kellyEnabled: parseBoolArg('kellyEnabled', true),
        kellyFraction: parseFloatArg('kellyFraction', 0.25),
        kellyMaxFraction: parseFloatArg('kellyMaxFraction', 0.32),

        adaptiveMode: parseBoolArg('adaptiveMode', true),
        autoProfileEnabled: parseBoolArg('autoProfileEnabled', true),
        allowDynamicStake: parseBoolArg('allowDynamicStake', true),
        riskEnvelopeEnabled: parseBoolArg('riskEnvelopeEnabled', true),

        simulateHalts: parseBoolArg('simulateHalts', true),
        maxConsecutiveLosses: parseIntArg('maxConsecutiveLosses', 3),
        cooldownSeconds: parseIntArg('cooldownSeconds', 1200),
        globalStopLoss: parseFloatArg('globalStopLoss', 0.20),

        minOrderShares: parseIntArg('minOrderShares', 2),
        minOddsEntry: parseFloatArg('minOddsEntry', 0.35),

        minBalanceFloorEnabled: parseBoolArg('minBalanceFloorEnabled', true),
        minBalanceFloor: parseFloatArg('minBalanceFloor', 2.0),
        minBalanceFloorDynamicEnabled: parseBoolArg('minBalanceFloorDynamicEnabled', true),
        minBalanceFloorDynamicFraction: parseFloatArg('minBalanceFloorDynamicFraction', 0.40),
        minBalanceFloorDynamicMin: parseFloatArg('minBalanceFloorDynamicMin', 0.50),

        relativeThresholds: parseBoolArg('relativeThresholds', false),
        stage1Mult: Number.isFinite(stage1MultArg) ? stage1MultArg : undefined,
        stage2Mult: Number.isFinite(stage2MultArg) ? stage2MultArg : undefined,
        vaultTriggerBalance: Number.isFinite(vaultTriggerBalanceArg) ? vaultTriggerBalanceArg : undefined,
        stage2Threshold: Number.isFinite(stage2ThresholdArg) ? stage2ThresholdArg : undefined,

        streakSizingEnabled: parseBoolArg('streakSizingEnabled', true),
        lossMultipliers: parseNumberListArg('lossMultipliers'),
        winBonusEnabled: parseBoolArg('winBonusEnabled', true),
        winMultipliers: parseNumberListArg('winMultipliers'),
        maxLossBudgetPct: parseFloatArg('maxLossBudgetPct', 0.25),

        missRate: parseFloatArg('missRate', 0),
        seed: Number.isFinite(seedArg) ? seedArg : undefined,

        autoBankrollProfileEnabled: parseBoolArg('autoBankrollProfileEnabled', true),
        autoBankrollMode: String(readArgValue('--autoBankrollMode=') || 'SAFE').trim().toUpperCase(),
        autoBankrollCutover: parseFloatArg('autoBankrollCutover', 20),
        autoBankrollLargeCutover: parseFloatArg('autoBankrollLargeCutover', 1000),
        autoBankrollKellyLow: parseFloatArg('autoBankrollKellyLow', 0.17),
        autoBankrollKellyHigh: parseFloatArg('autoBankrollKellyHigh', 0.32),
        autoBankrollKellyLarge: parseFloatArg('autoBankrollKellyLarge', 0.12),
        autoBankrollMaxPosLow: parseFloatArg('autoBankrollMaxPosLow', 0.17),
        autoBankrollMaxPosHigh: parseFloatArg('autoBankrollMaxPosHigh', 0.32),
        autoBankrollMaxPosLarge: parseFloatArg('autoBankrollMaxPosLarge', 0.07),
        autoBankrollRiskEnvelopeLow: parseBoolArg('autoBankrollRiskEnvelopeLow', true),
        autoBankrollRiskEnvelopeHigh: parseBoolArg('autoBankrollRiskEnvelopeHigh', false),
        autoBankrollRiskEnvelopeLarge: parseBoolArg('autoBankrollRiskEnvelopeLarge', true),

        peakDrawdownBrakeEnabled: parseBoolArg('peakDrawdownBrakeEnabled', true),
        peakDrawdownBrakePct: parseFloatArg('peakDrawdownBrakePct', 0.20),
        peakDrawdownBrakeMinBankroll: parseFloatArg('peakDrawdownBrakeMinBankroll', 20),
        peakDrawdownBrakeMaxPosFraction: parseFloatArg('peakDrawdownBrakeMaxPosFraction', 0.12),

        circuitBreakerEnabled: parseBoolArg('circuitBreakerEnabled', true),
        circuitBreakerSoftDrawdownPct: parseFloatArg('circuitBreakerSoftDrawdownPct', 0.25),
        circuitBreakerHardDrawdownPct: parseFloatArg('circuitBreakerHardDrawdownPct', 0.45),
        circuitBreakerHaltDrawdownPct: parseFloatArg('circuitBreakerHaltDrawdownPct', 0.70),
        circuitBreakerSafeOnlyAfterLosses: parseIntArg('circuitBreakerSafeOnlyAfterLosses', 3),
        circuitBreakerProbeOnlyAfterLosses: parseIntArg('circuitBreakerProbeOnlyAfterLosses', 5),
        circuitBreakerHaltAfterLosses: parseIntArg('circuitBreakerHaltAfterLosses', 7),
        circuitBreakerResumeAfterMinutes: parseFloatArg('circuitBreakerResumeAfterMinutes', 20),
        circuitBreakerResumeAfterWin: parseBoolArg('circuitBreakerResumeAfterWin', true),
        circuitBreakerResumeOnNewDay: parseBoolArg('circuitBreakerResumeOnNewDay', true),
    };

    const maxGlobalTradesPerCycle = 1;

    const rawStrategies = fs.readFileSync(strategiesPath, 'utf8');
    const parsed = JSON.parse(rawStrategies);
    const strategies = Array.isArray(parsed?.strategies) ? parsed.strategies : [];
    if (!strategies.length) {
        throw new Error(`No strategies found in: ${strategiesPath}`);
    }

    const cond = parsed?.conditions || {};
    const bandMins = strategies
        .map(s => Number(s?.priceMin ?? s?.priceBand?.min))
        .filter(n => Number.isFinite(n));
    const bandMaxs = strategies
        .map(s => Number(s?.priceMax ?? s?.priceBand?.max))
        .filter(n => Number.isFinite(n));

    const gates = {
        priceMin: Number.isFinite(Number(cond.priceMin))
            ? Number(cond.priceMin)
            : (bandMins.length ? Math.min(...bandMins) : 0),
        priceMax: Number.isFinite(Number(cond.priceMax))
            ? Number(cond.priceMax)
            : (bandMaxs.length ? Math.max(...bandMaxs) : 1),
        momentumMin: Number.isFinite(Number(cond.momentumMin)) ? Number(cond.momentumMin) : 0.03,
        volumeMin: Number.isFinite(Number(cond.volumeMin)) ? Number(cond.volumeMin) : 500,
        applyMomentumGate: parseBoolArg('applyMomentumGate', cond.applyMomentumGate === true),
        applyVolumeGate: parseBoolArg('applyVolumeGate', cond.applyVolumeGate === true),
    };

    const meta = {
        generatedAt: new Date().toISOString(),
        datasetPath,
        strategiesPath,
        outputs: {
            signalLedger: signalOutPath,
            executedLedger: executedOutPath,
        },
        gates,
        collisionPolicy: {
            maxGlobalTradesPerCycle,
        },
        filters: {
            startEpochSec,
            endEpochSec,
            maxRows,
        },
        bankrollSimulation: {
            enabled: simulateBankroll,
            config: bankrollSimConfig,
        },
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
    let minCycleStartEpochSec = null;
    let maxCycleStartEpochSec = null;

    const passCandidatesByCycle = new Map();
    let passCandidates = 0;

    try {
        signalWriter.write('{"signals":[\n');

        parsedRows = await streamJsonArrayObjects(
            datasetPath,
            (row) => {
                const cycleStartEpochSec = Number(row?.cycleStartEpochSec);
                if (!Number.isFinite(cycleStartEpochSec)) return true;

                if (startEpochSec !== null && cycleStartEpochSec < startEpochSec) return true;
                if (endEpochSec !== null && cycleStartEpochSec > endEpochSec) return false;
                if (maxRows !== null && rowsEvaluated >= maxRows) return false;

                rowsEvaluated += 1;

                const dk = dayKeyUtc(cycleStartEpochSec);
                if (dk) daysEvaluated.add(dk);
                if (minCycleStartEpochSec === null || cycleStartEpochSec < minCycleStartEpochSec) {
                    minCycleStartEpochSec = cycleStartEpochSec;
                }
                if (maxCycleStartEpochSec === null || cycleStartEpochSec > maxCycleStartEpochSec) {
                    maxCycleStartEpochSec = cycleStartEpochSec;
                }

                const entryMinute = Number(row?.entryMinute);
                const utcHour = Number(row?.utcHour);
                const slug = String(row?.slug || '');
                const asset = String(row?.asset || '');
                const volume = row?.volume;

                for (const dir of ['UP', 'DOWN']) {
                    const entryPrice = dir === 'UP' ? row?.upPrice : row?.downPrice;
                    const momentum = computeDirectionalMomentum(row, dir);
                    const res = checkHybridStrategyReplay(
                        asset,
                        dir,
                        entryPrice,
                        entryMinute,
                        utcHour,
                        momentum,
                        volume,
                        strategies,
                        gates,
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
                        strategyWinRateLCB: (strategy && Number.isFinite(Number(strategy.winRateLCB)))
                            ? Number(strategy.winRateLCB)
                            : null,
                        priceBandMin: Number.isFinite(Number(res?.bandMin)) ? Number(res.bandMin) : null,
                        priceBandMax: Number.isFinite(Number(res?.bandMax)) ? Number(res.bandMax) : null,
                        resolvedOutcome: row?.resolvedOutcome ?? null,
                        won: typeof row?.resolvedOutcome === 'string'
                            ? String(row.resolvedOutcome).toUpperCase() === dir
                            : null,
                        roi: dir === 'UP'
                            ? (Number.isFinite(Number(row?.upROI)) ? Number(row.upROI) : null)
                            : (Number.isFinite(Number(row?.downROI)) ? Number(row.downROI) : null),
                    };

                    signalWriter.write(firstSignal ? '' : ',\n');
                    firstSignal = false;
                    signalWriter.write(JSON.stringify(signal));
                    signalsWritten += 1;

                    if (res?.passes) {
                        passSignals += 1;

                        let arr = passCandidatesByCycle.get(cycleStartEpochSec);
                        if (!arr) {
                            arr = [];
                            passCandidatesByCycle.set(cycleStartEpochSec, arr);
                        }
                        arr.push(signal);
                        passCandidates += 1;
                    } else {
                        blockedSignals += 1;
                        const br = String(res?.blockedReason || 'UNKNOWN');
                        blockedByReason[br] = (blockedByReason[br] || 0) + 1;
                    }
                }

                return true;
            },
            { logEvery: 50000 },
        );

        const signalStats = {
            parsedRows,
            rowsEvaluated,
            signalsWritten,
            passSignals,
            blockedSignals,
            blockedByReason,
            passCandidates,
            daysEvaluated: daysEvaluated.size,
            minCycleStartEpochSec,
            maxCycleStartEpochSec,
        };

        signalWriter.write('\n],');
        signalWriter.write(`"meta":${JSON.stringify(meta)},`);
        signalWriter.write(`"stats":${JSON.stringify(signalStats)}`);
        signalWriter.write('}\n');
    } finally {
        try { signalWriter.end(); } catch { }
    }

    const executedTrades = [];
    const collisions = [];
    let collisionCycles = 0;
    let collisionBlockedCandidates = 0;

    const cycleKeys = Array.from(passCandidatesByCycle.keys()).sort((a, b) => a - b);
    for (const cycleStartEpochSec of cycleKeys) {
        const candidates = passCandidatesByCycle.get(cycleStartEpochSec) || [];
        if (!candidates.length) continue;

        candidates.sort((a, b) => sortCandidatesDeterministically(a, b, gates));
        const winners = candidates.slice(0, maxGlobalTradesPerCycle);
        const blocked = candidates.slice(maxGlobalTradesPerCycle);

        if (blocked.length) {
            collisionCycles += 1;
            collisionBlockedCandidates += blocked.length;
            collisions.push({
                cycleStartEpochSec,
                candidateCount: candidates.length,
                executedIds: winners.map(s => s?.id).filter(Boolean),
                blockedIds: blocked.map(s => s?.id).filter(Boolean),
            });
        }

        for (const w of winners) {
            const cycleSec = Number(w?.cycleStartEpochSec);
            const em = Number(w?.entryMinute);
            const issuedAt = Number.isFinite(cycleSec)
                ? (Number.isFinite(em) ? (cycleSec + em * 60) * 1000 : cycleSec * 1000)
                : null;
            const resolvedAt = Number.isFinite(cycleSec) ? (cycleSec + 15 * 60) * 1000 : null;
            const outcome = w?.won === true ? 'WIN' : w?.won === false ? 'LOSS' : null;
            const isWin = w?.won === true ? true : w?.won === false ? false : null;

            executedTrades.push({
                id: w?.id ?? null,
                asset: w?.asset ?? null,
                slug: w?.slug || w?.asset || null,
                direction: w?.direction ?? null,
                entryPrice: w?.entryPrice ?? null,
                pWin: w?.strategyWinRateLCB ?? null,
                tier: w?.strategyTier ?? null,
                cycleStartEpoch: w?.cycleStartEpochSec ?? null,
                issuedAt,
                resolvedAt,
                outcome,
                isWin,
                cycleStartEpochSec: w?.cycleStartEpochSec ?? null,
                entryMinute: w?.entryMinute ?? null,
                utcHour: w?.utcHour ?? null,
                momentum: w?.momentum ?? null,
                volume: w?.volume ?? null,
                strategyId: w?.strategyId ?? null,
                strategyName: w?.strategyName ?? null,
                strategyTier: w?.strategyTier ?? null,
                strategyWinRateLCB: w?.strategyWinRateLCB ?? null,
                priceBandMin: w?.priceBandMin ?? null,
                priceBandMax: w?.priceBandMax ?? null,
                resolvedOutcome: w?.resolvedOutcome ?? null,
                won: w?.won ?? null,
                roi: w?.roi ?? null,
                collisionCandidateCount: candidates.length,
                collisionBlockedCount: blocked.length,
            });
        }
    }

    executedTrades.sort((a, b) => {
        const ca = Number(a?.cycleStartEpochSec);
        const cb = Number(b?.cycleStartEpochSec);
        if (Number.isFinite(ca) && Number.isFinite(cb) && ca !== cb) return ca - cb;
        const aa = String(a?.asset || '').toUpperCase();
        const ab = String(b?.asset || '').toUpperCase();
        if (aa !== ab) return aa.localeCompare(ab);
        return String(a?.id || '').localeCompare(String(b?.id || ''));
    });

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

    for (const t of executedTrades) {
        const won = t?.won;
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

        const roi = Number(t?.roi);
        if (Number.isFinite(roi)) {
            totalRoi += roi;
            roiCount += 1;
        }

        const sidNum = Number(t?.strategyId);
        const sidKey = Number.isFinite(sidNum) ? String(sidNum) : 'UNKNOWN';
        if (!byStrategy[sidKey]) {
            byStrategy[sidKey] = {
                strategyId: Number.isFinite(sidNum) ? sidNum : null,
                strategyName: t?.strategyName ?? null,
                tier: t?.strategyTier ?? null,
                trades: 0,
                wins: 0,
                losses: 0,
                pending: 0,
                winRate: 0,
                wilsonLCB: 0,
            };
        }
        byStrategy[sidKey].trades += 1;
        if (won === true) byStrategy[sidKey].wins += 1;
        else if (won === false) byStrategy[sidKey].losses += 1;
        else byStrategy[sidKey].pending += 1;

        const dk = dayKeyUtc(Number(t?.cycleStartEpochSec));
        if (dk) {
            daysWithTrades.add(dk);
            if (!byDay[dk]) {
                byDay[dk] = {
                    day: dk,
                    trades: 0,
                    wins: 0,
                    losses: 0,
                    pending: 0,
                    winRate: 0,
                    wilsonLCB: 0,
                };
            }
            byDay[dk].trades += 1;
            if (won === true) byDay[dk].wins += 1;
            else if (won === false) byDay[dk].losses += 1;
            else byDay[dk].pending += 1;
        }
    }

    for (const k of Object.keys(byStrategy)) {
        const s = byStrategy[k];
        const resolved = (s.wins || 0) + (s.losses || 0);
        s.winRate = resolved > 0 ? s.wins / resolved : 0;
        s.wilsonLCB = resolved > 0 ? wilsonLCBFromCounts(s.wins, resolved) : 0;
    }

    for (const k of Object.keys(byDay)) {
        const d = byDay[k];
        const resolved = (d.wins || 0) + (d.losses || 0);
        d.winRate = resolved > 0 ? d.wins / resolved : 0;
        d.wilsonLCB = resolved > 0 ? wilsonLCBFromCounts(d.wins, resolved) : 0;
    }

    const executedResolved = executedWins + executedLosses;
    const executedWinRate = executedResolved > 0 ? executedWins / executedResolved : 0;
    const executedWilsonLCB = executedResolved > 0 ? wilsonLCBFromCounts(executedWins, executedResolved) : 0;
    const avgRoi = roiCount > 0 ? totalRoi / roiCount : null;

    const executedStats = {
        trades: executedTrades.length,
        wins: executedWins,
        losses: executedLosses,
        pending: executedPending,
        winRate: executedWinRate,
        wilsonLCB: executedWilsonLCB,
        avgRoi,
        totalRoi: roiCount > 0 ? totalRoi : null,
        daysWithTrades: daysWithTrades.size,
        tradesPerDay: daysWithTrades.size > 0 ? executedTrades.length / daysWithTrades.size : 0,
        currentWinStreak,
        currentLossStreak,
        maxWinStreak,
        maxLossStreak,
        collisionCycles,
        collisionBlockedCandidates,
    };

    const bankrollSimulation = simulateBankroll
        ? simulateBankrollPath(executedTrades, bankrollSimConfig)
        : null;

    if (bankrollSimulation?.stats) {
        executedStats.bankroll = bankrollSimulation.stats;
    }

    const executedLedger = {
        trades: executedTrades,
        collisions,
        stats: executedStats,
        byStrategy,
        byDay,
        bankrollSimulation,
        meta,
    };
    fs.writeFileSync(executedOutPath, JSON.stringify(executedLedger, null, 2));

    console.log(`Loaded ${strategies.length} strategies from ${strategiesPath}`);
    console.log(
        `Gates: price ${(gates.priceMin * 100).toFixed(0)}-${(gates.priceMax * 100).toFixed(0)}c | ` +
        `momentum>${(gates.momentumMin * 100).toFixed(0)}% (${gates.applyMomentumGate ? 'ON' : 'OFF'}) | ` +
        `volume>$${gates.volumeMin} (${gates.applyVolumeGate ? 'ON' : 'OFF'})`
    );
    console.log(`Dataset: ${datasetPath}`);
    console.log(`Parsed ${parsedRows} dataset rows; evaluated ${rowsEvaluated} rows`);
    console.log(`Wrote ${signalsWritten} signals (${passSignals} pass, ${blockedSignals} blocked)`);
    console.log(`Signal ledger: ${signalOutPath}`);
    console.log(`Pass candidates: ${passCandidates}`);
    console.log(`Executed trades: ${executedTrades.length} (maxGlobalTradesPerCycle=${maxGlobalTradesPerCycle})`);
    console.log(`Collision cycles: ${collisionCycles}; collision-blocked pass candidates: ${collisionBlockedCandidates}`);
    if (bankrollSimulation?.stats) {
        const bs = bankrollSimulation.stats;
        const roiPct = Number.isFinite(bs.roi) ? `${(bs.roi * 100).toFixed(2)}%` : 'n/a';
        console.log(
            `Bankroll sim: start=$${Number(bs.startingBalance).toFixed(2)} end=$${Number(bs.endingBalance).toFixed(2)} ROI=${roiPct}`
        );
        console.log(
            `Bankroll sim trades: executed=${bs.executed} blocked=${bs.blocked} pending=${bs.pending} maxDD=${(Number(bs.maxDrawdownPct) * 100).toFixed(2)}%`
        );
        console.log(`Bankroll sim halts: ${JSON.stringify(bs.haltCounts)}`);
        if (bankrollSimulation.firstLossTrade) {
            console.log(`Bankroll sim first loss trade: ${JSON.stringify(bankrollSimulation.firstLossTrade)}`);
        } else {
            console.log('Bankroll sim first loss trade: none');
        }
    }
    console.log(`Executed ledger: ${executedOutPath}`);
}

module.exports = {
    simulateBankrollPath,
};

if (require.main === module) {
    main().catch(err => {
        console.error(err);
        process.exit(1);
    });
}
