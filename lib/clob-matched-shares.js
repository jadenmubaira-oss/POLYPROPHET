const CONFIG = require("./config");

function toFiniteNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function getMaxMatchedSharesMultiplier() {
  const configured = toFiniteNumber(
    CONFIG.RISK?.maxMatchedSharesMultiplier ??
      process.env.MAX_MATCHED_SHARES_MULTIPLIER,
    1.05,
  );
  return configured > 0 ? configured : 1.05;
}

function normalizeClobMatchedShares(rawValue, requestedSharesValue, options = {}) {
  const eps = toFiniteNumber(options.eps, 1e-6);
  const rawMatchedShares = Math.max(0, toFiniteNumber(rawValue, 0));
  const requestedShares = Math.max(0, toFiniteNumber(requestedSharesValue, 0));
  const multiplier = getMaxMatchedSharesMultiplier();

  if (!(requestedShares > eps)) {
    return {
      matchedShares: rawMatchedShares,
      rawMatchedShares,
      requestedShares: null,
      capped: false,
      reason: null,
      cap: null,
      multiplier,
    };
  }

  if (rawMatchedShares > requestedShares + eps) {
    const reason = rawMatchedShares > requestedShares * multiplier
      ? "IMPOSSIBLE_OVERFILL"
      : "OVER_REQUESTED_ROUNDING";
    return {
      matchedShares: requestedShares,
      rawMatchedShares,
      requestedShares,
      capped: true,
      reason,
      cap: requestedShares,
      multiplier,
    };
  }

  return {
    matchedShares: rawMatchedShares,
    rawMatchedShares,
    requestedShares,
    capped: false,
    reason: null,
    cap: requestedShares,
    multiplier,
  };
}

function formatMatchedSharesNormalization(normalized) {
  if (!normalized?.capped) return null;
  return [
    normalized.reason || "MATCHED_SHARES_CAPPED",
    `raw=${Number(normalized.rawMatchedShares || 0).toFixed(6)}`,
    `requested=${Number(normalized.requestedShares || 0).toFixed(6)}`,
    `used=${Number(normalized.matchedShares || 0).toFixed(6)}`,
  ].join(" ");
}

module.exports = {
  normalizeClobMatchedShares,
  formatMatchedSharesNormalization,
};