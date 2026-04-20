function toFiniteNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function toBool(value, fallback = false) {
  if (typeof value === 'boolean') return value;
  if (value === undefined || value === null || String(value).trim() === '') {
    return fallback;
  }
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return fallback;
}

function getPolymarketTakerFeeModel(overrides = {}) {
  const assumeTaker =
    typeof overrides.assumeTaker === 'boolean'
      ? overrides.assumeTaker
      : toBool(
          process.env.POLYMARKET_ASSUME_TAKER ??
            process.env.ASSUME_TAKER_FEES ??
            'true',
          true,
        );
  const feeRate = toFiniteNumber(
    overrides.feeRate,
    toFiniteNumber(
      process.env.POLYMARKET_TAKER_FEE_RATE ?? process.env.TAKER_FEE_RATE,
      0.072,
    ),
  );
  const minFeeUsd = Math.max(
    0,
    toFiniteNumber(
      overrides.minFeeUsd,
      toFiniteNumber(
        process.env.POLYMARKET_TAKER_FEE_MIN_USD ?? process.env.TAKER_FEE_MIN_USD,
        0.0001,
      ),
    ),
  );
  return {
    assumeTaker,
    feeRate: Math.max(0, feeRate),
    minFeeUsd,
  };
}

function calcPolymarketTakerFeeUsd(shares, price, overrides = {}) {
  const model = getPolymarketTakerFeeModel(overrides);
  if (!model.assumeTaker) return 0;
  const shareCount = Number(shares);
  const entryPrice = Number(price);
  if (!Number.isFinite(shareCount) || shareCount <= 0) return 0;
  if (!Number.isFinite(entryPrice) || entryPrice <= 0 || entryPrice >= 1) {
    return 0;
  }
  const fee = shareCount * model.feeRate * entryPrice * (1 - entryPrice);
  if (!Number.isFinite(fee) || fee <= 0) return 0;
  if (model.minFeeUsd > 0 && fee < model.minFeeUsd) return 0;
  return fee;
}

function calcPolymarketTakerFeeUsdPerShare(price, overrides = {}) {
  const model = getPolymarketTakerFeeModel(overrides);
  if (!model.assumeTaker) return 0;
  const entryPrice = Number(price);
  if (!Number.isFinite(entryPrice) || entryPrice <= 0 || entryPrice >= 1) {
    return 0;
  }
  const fee = model.feeRate * entryPrice * (1 - entryPrice);
  if (!Number.isFinite(fee) || fee <= 0) return 0;
  if (model.minFeeUsd > 0 && fee < model.minFeeUsd) return 0;
  return fee;
}

function calcPolymarketTakerFeeUsdForStake(stakeUsd, price, overrides = {}) {
  const stake = Number(stakeUsd);
  const entryPrice = Number(price);
  if (!Number.isFinite(stake) || stake <= 0) return 0;
  if (!Number.isFinite(entryPrice) || entryPrice <= 0 || entryPrice >= 1) {
    return 0;
  }
  return calcPolymarketTakerFeeUsd(stake / entryPrice, entryPrice, overrides);
}

function calcPolymarketTakerFeeFrac(price, overrides = {}) {
  const entryPrice = Number(price);
  if (!Number.isFinite(entryPrice) || entryPrice <= 0 || entryPrice >= 1) {
    return 0;
  }
  const perShareFeeUsd = calcPolymarketTakerFeeUsdPerShare(entryPrice, overrides);
  const feeFrac = perShareFeeUsd / entryPrice;
  return Number.isFinite(feeFrac) && feeFrac > 0 ? feeFrac : 0;
}

function getMaxAffordableSharesForEntry(cashUsd, price, overrides = {}) {
  const cash = Number(cashUsd);
  const entryPrice = Number(price);
  if (!Number.isFinite(cash) || cash <= 0) return 0;
  if (!Number.isFinite(entryPrice) || entryPrice <= 0 || entryPrice >= 1) {
    return 0;
  }
  const feePerShareUsd = calcPolymarketTakerFeeUsdPerShare(entryPrice, overrides);
  const totalPerShareUsd = entryPrice + feePerShareUsd;
  if (!Number.isFinite(totalPerShareUsd) || totalPerShareUsd <= 0) return 0;
  return Math.max(0, Math.floor(cash / totalPerShareUsd + 1e-9));
}

function calcBinaryEvRoiAfterFees(pWin, entryPrice, options = {}) {
  const probability = Number(pWin);
  if (!Number.isFinite(probability)) return null;
  const boundedProbability = Math.max(0, Math.min(1, probability));
  const rawEntry = Number(entryPrice);
  if (!Number.isFinite(rawEntry) || rawEntry <= 0 || rawEntry >= 1) {
    return null;
  }
  const slippagePct = Math.max(0, Number(options.slippagePct || 0));
  const effectiveEntry = Math.min(0.99, rawEntry * (1 + slippagePct));
  const feeFrac = calcPolymarketTakerFeeFrac(effectiveEntry, options.feeModel || options);
  return boundedProbability / effectiveEntry - 1 - feeFrac;
}

module.exports = {
  getPolymarketTakerFeeModel,
  calcPolymarketTakerFeeUsd,
  calcPolymarketTakerFeeUsdPerShare,
  calcPolymarketTakerFeeUsdForStake,
  calcPolymarketTakerFeeFrac,
  getMaxAffordableSharesForEntry,
  calcBinaryEvRoiAfterFees,
};
