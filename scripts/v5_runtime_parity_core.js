const fs = require('fs');
const path = require('path');
const CONFIG = require('../lib/config');
const {
  calcBinaryEvRoiAfterFees,
  calcPolymarketTakerFeeUsd,
  getMaxAffordableSharesForEntry,
  getPolymarketTakerFeeModel,
} = require('../lib/polymarket-fees');

const ROOT = path.join(__dirname, '..');
const ASSET_RANK = { BTC: 0, ETH: 1, SOL: 2, XRP: 3 };
const EPS = 1e-9;

function readJson(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(ROOT, relativePath), 'utf8'));
}

function loadStrategySet(relativePath = 'strategies/strategy_set_15m_optimal_10usd_v5.json') {
  return readJson(relativePath);
}

function loadIntracycleData(relativePath = 'data/intracycle-price-data.json') {
  const data = readJson(relativePath);
  return Array.isArray(data) ? data : (data.cycles || []);
}

function toFiniteNumber(value, fallback = null) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function clampPrice(value) {
  if (!Number.isFinite(value)) return null;
  return Math.min(0.999, Math.max(0.001, value));
}

function normalizeStrategy(strategy) {
  return {
    ...strategy,
    priceMin: toFiniteNumber(strategy.priceMin ?? strategy.priceBandLow, 0),
    priceMax: toFiniteNumber(strategy.priceMax ?? strategy.priceBandHigh, 1),
    utcHour: toFiniteNumber(strategy.utcHour, -1),
    entryMinute: toFiniteNumber(strategy.entryMinute, null),
    direction: String(strategy.direction || '').toUpperCase(),
    pWinEstimate: toFiniteNumber(
      strategy.pWinEstimate ?? strategy.evWinEstimate ?? strategy.winRateLCB ?? strategy.winRate,
      0.5,
    ),
    fullWR: toFiniteNumber(strategy.winRate ?? strategy.stats?.full?.wr, 0),
    oosWR: toFiniteNumber(strategy.stats?.oos?.wr, 0),
    lcb: toFiniteNumber(strategy.winRateLCB, 0),
  };
}

function getDefaultSettings(overrides = {}) {
  const cycleSeconds = toFiniteNumber(overrides.cycleSeconds, 900);
  const configuredStakeFraction = toFiniteNumber(overrides.stakeFraction, CONFIG.RISK.stakeFraction);
  return {
    cycleSeconds,
    oosStartEpoch: toFiniteNumber(
      overrides.oosStartEpoch,
      Math.floor(new Date('2026-04-08T00:00:00Z').getTime() / 1000),
    ),
    priceMaxCap: Number.isFinite(Number(overrides.priceMaxCap))
      ? Number(overrides.priceMaxCap)
      : Infinity,
    entryPriceBufferCents: toFiniteNumber(
      overrides.entryPriceBufferCents,
      CONFIG.RISK.entryPriceBufferCents,
    ),
    preResolutionExitEnabled:
      overrides.preResolutionExitEnabled ?? CONFIG.RISK.preResolutionExitEnabled,
    preResolutionMinBid: toFiniteNumber(
      overrides.preResolutionMinBid,
      CONFIG.RISK.preResolutionMinBid,
    ),
    preResolutionExitSeconds: toFiniteNumber(
      overrides.preResolutionExitSeconds,
      CONFIG.RISK.preResolutionExitSeconds?.['15m'] ?? 120,
    ),
    feeModel: overrides.feeModel || getPolymarketTakerFeeModel(),
    minNetEdgeRoi: toFiniteNumber(
      overrides.minNetEdgeRoi,
      CONFIG.RISK.minNetEdgeRoi,
    ),
    enforceNetEdgeGate:
      overrides.enforceNetEdgeGate ?? CONFIG.RISK.enforceNetEdgeGate,
    enforceHighPriceEdgeFloor:
      overrides.enforceHighPriceEdgeFloor ??
      CONFIG.RISK.enforceHighPriceEdgeFloor,
    highPriceEdgeFloorPrice: toFiniteNumber(
      overrides.highPriceEdgeFloorPrice,
      CONFIG.RISK.highPriceEdgeFloorPrice,
    ),
    highPriceEdgeFloorMinRoi: toFiniteNumber(
      overrides.highPriceEdgeFloorMinRoi,
      CONFIG.RISK.highPriceEdgeFloorMinRoi,
    ),
    minOrderShares: Math.max(
      1,
      Math.ceil(toFiniteNumber(overrides.minOrderShares, CONFIG.RISK.minOrderShares)),
    ),
    stakeFraction: Math.min(1, Math.max(0, configuredStakeFraction)),
    kellyFraction: toFiniteNumber(overrides.kellyFraction, CONFIG.RISK.kellyFraction),
    kellyMaxFraction: toFiniteNumber(
      overrides.kellyMaxFraction,
      CONFIG.RISK.kellyMaxFraction,
    ),
    kellyMinPWin: toFiniteNumber(overrides.kellyMinPWin, CONFIG.RISK.kellyMinPWin),
    slippagePct: toFiniteNumber(overrides.slippagePct, CONFIG.RISK.slippagePct),
    peakDrawdownBrakePct: toFiniteNumber(
      overrides.peakDrawdownBrakePct,
      CONFIG.RISK.peakDrawdownBrakePct,
    ),
    peakDrawdownBrakeMinBankroll: toFiniteNumber(
      overrides.peakDrawdownBrakeMinBankroll,
      CONFIG.RISK.peakDrawdownBrakeMinBankroll,
    ),
    peakDrawdownBrakeStakeFraction: toFiniteNumber(
      overrides.peakDrawdownBrakeStakeFraction,
      0.12,
    ),
    maxConsecutiveLosses: Math.max(
      1,
      Math.floor(toFiniteNumber(overrides.maxConsecutiveLosses, CONFIG.RISK.maxConsecutiveLosses)),
    ),
    cooldownSeconds: Math.max(
      0,
      Math.floor(toFiniteNumber(overrides.cooldownSeconds, CONFIG.RISK.cooldownSeconds)),
    ),
    microBankrollThreshold: toFiniteNumber(
      overrides.microBankrollThreshold,
      CONFIG.RISK.microBankrollThreshold,
    ),
    minBalanceFloor: Math.max(
      0,
      toFiniteNumber(overrides.minBalanceFloor, CONFIG.RISK.minBalanceFloor),
    ),
    maxAbsoluteStakeSmall: toFiniteNumber(
      overrides.maxAbsoluteStakeSmall,
      CONFIG.RISK.maxAbsoluteStakeSmall,
    ),
    maxAbsoluteStakeMedium: toFiniteNumber(
      overrides.maxAbsoluteStakeMedium,
      CONFIG.RISK.maxAbsoluteStakeMedium,
    ),
    maxAbsoluteStakeLarge: toFiniteNumber(
      overrides.maxAbsoluteStakeLarge,
      CONFIG.RISK.maxAbsoluteStakeLarge,
    ),
    assetRank: overrides.assetRank || ASSET_RANK,
  };
}

function getTieredMaxAbsoluteStake(bankroll, settings) {
  if (!Number.isFinite(bankroll) || bankroll < 1000) {
    return settings.maxAbsoluteStakeSmall;
  }
  if (bankroll < 10000) {
    return Math.max(settings.maxAbsoluteStakeSmall, settings.maxAbsoluteStakeMedium);
  }
  return Math.max(settings.maxAbsoluteStakeSmall, settings.maxAbsoluteStakeLarge);
}

function getSideMinutePrices(cycle, direction) {
  return direction === 'UP' ? cycle.minutePricesYes : cycle.minutePricesNo;
}

function estimateNetEdgeRoi(entryPrice, pWinEstimate, settings) {
  const entry = Number(entryPrice);
  const pWin = Number(pWinEstimate);
  if (!(entry > 0) || entry >= 1 || !(pWin > 0) || pWin >= 1) return null;
  return calcBinaryEvRoiAfterFees(pWin, entry, {
    slippagePct: settings.slippagePct,
    feeModel: settings.feeModel,
  });
}

function shouldEnforceHighPriceEdgeFloor(entryPrice, settings) {
  return (
    !!settings.enforceHighPriceEdgeFloor &&
    Number.isFinite(settings.highPriceEdgeFloorPrice) &&
    settings.highPriceEdgeFloorPrice > 0 &&
    settings.highPriceEdgeFloorPrice < 1 &&
    Number(entryPrice) >= settings.highPriceEdgeFloorPrice
  );
}

function passesEdgeGuards(entryPrice, pWinEstimate, settings) {
  const netEdgeRoi = estimateNetEdgeRoi(entryPrice, pWinEstimate, settings);
  if (
    settings.enforceNetEdgeGate &&
    (!Number.isFinite(netEdgeRoi) || netEdgeRoi < settings.minNetEdgeRoi)
  ) {
    return false;
  }
  if (
    shouldEnforceHighPriceEdgeFloor(entryPrice, settings) &&
    (!Number.isFinite(netEdgeRoi) ||
      netEdgeRoi < settings.highPriceEdgeFloorMinRoi)
  ) {
    return false;
  }
  return true;
}

function findPreResolutionExit(cycle, direction, settings) {
  if (!settings.preResolutionExitEnabled) return null;
  const sidePrices = getSideMinutePrices(cycle, direction);
  if (!sidePrices || typeof sidePrices !== 'object') return null;
  const snapshots = Object.entries(sidePrices)
    .map(([minuteKey, snapshot]) => {
      const minute = Number(minuteKey);
      const price = toFiniteNumber(snapshot?.last, null);
      const timestamp = toFiniteNumber(snapshot?.ts, cycle.epoch + minute * 60);
      return { minute, price, timestamp };
    })
    .filter(
      (snapshot) =>
        Number.isFinite(snapshot.minute) &&
        Number.isFinite(snapshot.price) &&
        snapshot.price > 0 &&
        snapshot.price < 1 &&
        Number.isFinite(snapshot.timestamp),
    )
    .sort((a, b) => a.timestamp - b.timestamp);

  for (const snapshot of snapshots) {
    const remaining = cycle.epoch + settings.cycleSeconds - snapshot.timestamp;
    if (remaining <= 0 || remaining > settings.preResolutionExitSeconds) continue;
    if (snapshot.price + EPS < settings.preResolutionMinBid) continue;
    return {
      minute: snapshot.minute,
      timestamp: snapshot.timestamp,
      exitPrice: snapshot.price,
      remaining,
    };
  }

  return null;
}

function buildRuntimeEvents(strategies, cycles, overrides = {}) {
  const settings = getDefaultSettings(overrides);
  const normalized = strategies.map(normalizeStrategy);
  const filteredCycles = cycles.filter(
    (cycle) =>
      Number(cycle?.epoch || 0) >= settings.oosStartEpoch &&
      (cycle?.resolution === 'UP' || cycle?.resolution === 'DOWN'),
  );
  const buckets = new Map();

  for (const cycle of filteredCycles) {
    const cycleHour = new Date(cycle.epoch * 1000).getUTCHours();
    for (const strategy of normalized) {
      if (
        Number.isFinite(strategy.utcHour) &&
        strategy.utcHour !== -1 &&
        strategy.utcHour !== cycleHour
      ) {
        continue;
      }
      if (!Number.isFinite(strategy.entryMinute)) continue;
      const sidePrices = getSideMinutePrices(cycle, strategy.direction);
      const entrySnapshot = sidePrices?.[String(strategy.entryMinute)] ?? sidePrices?.[strategy.entryMinute];
      const signalEntryPrice = toFiniteNumber(entrySnapshot?.last, null);
      if (!(signalEntryPrice > 0) || signalEntryPrice >= 1) continue;
      const cappedPriceMax = Number.isFinite(settings.priceMaxCap)
        ? Math.min(strategy.priceMax, settings.priceMaxCap)
        : strategy.priceMax;
      if (signalEntryPrice < strategy.priceMin || signalEntryPrice > cappedPriceMax) {
        continue;
      }
      if (!passesEdgeGuards(signalEntryPrice, strategy.pWinEstimate, settings)) {
        continue;
      }
      let orderPrice = clampPrice(
        signalEntryPrice + settings.entryPriceBufferCents / 100,
      );
      if (!(orderPrice > 0) || orderPrice >= 1) continue;
      if (!passesEdgeGuards(orderPrice, strategy.pWinEstimate, settings)) {
        orderPrice = signalEntryPrice;
      }
      const marketMinOrderShares = Math.max(
        settings.minOrderShares,
        Math.ceil(
          Math.max(
            toFiniteNumber(cycle.orderMinSize, settings.minOrderShares),
            toFiniteNumber(
              strategy.direction === 'UP' ? cycle.yesMinOrderSize : cycle.noMinOrderSize,
              settings.minOrderShares,
            ),
          ),
        ),
      );
      const event = {
        epoch: cycle.epoch,
        minute: strategy.entryMinute,
        timestamp: cycle.epoch + strategy.entryMinute * 60,
        asset: cycle.asset,
        direction: strategy.direction,
        signalEntryPrice,
        orderPrice,
        pWinEstimate: strategy.pWinEstimate,
        resolutionWon: strategy.direction === cycle.resolution,
        strategy: strategy.name || strategy.id,
        tier: strategy.tier || null,
        minOrderShares: marketMinOrderShares,
        orderMinSize: marketMinOrderShares,
        preResolutionExit: findPreResolutionExit(cycle, strategy.direction, settings),
      };
      if (!buckets.has(cycle.epoch)) buckets.set(cycle.epoch, []);
      buckets.get(cycle.epoch).push(event);
    }
  }

  const events = [];
  let totalSignals = 0;
  let suppressedSignals = 0;

  for (const [epoch, signals] of [...buckets.entries()].sort((a, b) => a[0] - b[0])) {
    totalSignals += signals.length;
    const earliestMinute = Math.min(...signals.map((signal) => signal.minute));
    const earliestSignals = signals.filter((signal) => signal.minute === earliestMinute);
    earliestSignals.sort((a, b) => {
      if (b.pWinEstimate !== a.pWinEstimate) return b.pWinEstimate - a.pWinEstimate;
      return (settings.assetRank[a.asset] ?? 99) - (settings.assetRank[b.asset] ?? 99);
    });
    const selected = earliestSignals[0];
    suppressedSignals += signals.length - 1;
    events.push({
      ...selected,
      cycleKey: String(epoch),
      signalsInCycle: signals.length,
      suppressedSignals: signals.length - 1,
    });
  }

  const days = [...new Set(events.map((event) => new Date(event.timestamp * 1000).toISOString().slice(0, 10)))].sort();
  const preResolutionEligible = events.filter((event) => event.preResolutionExit).length;

  return {
    settings,
    strategies: normalized,
    events,
    totalSignals,
    suppressedSignals,
    days,
    preResolutionEligible,
  };
}

function computeTradabilityFloor(events, overrides = {}) {
  const settings = getDefaultSettings(overrides);
  const costs = events
    .map((event) => {
      const minShares = Math.max(settings.minOrderShares, Math.ceil(event.minOrderShares || 0));
      const orderPrice = Number(event.orderPrice || event.signalEntryPrice || 0);
      const cost = minShares * orderPrice;
      const entryFee = calcPolymarketTakerFeeUsd(minShares, orderPrice, settings.feeModel);
      return cost + entryFee;
    })
    .filter((cost) => Number.isFinite(cost) && cost > 0);
  return costs.length ? Math.min(...costs) : settings.minOrderShares * 0.5;
}

function computeTradeOpen(bankroll, peakBalance, event, overrides = {}) {
  const settings = getDefaultSettings(overrides);
  const entryPrice = Number(event.signalEntryPrice);
  const orderPrice = Number(event.orderPrice || event.signalEntryPrice);
  const pWinEstimate = Number(event.pWinEstimate || 0.5);
  const effectiveMinOrderShares = Math.max(
    settings.minOrderShares,
    Math.ceil(Number(event.minOrderShares || 0) || 0),
  );

  if (!(bankroll > 0) || !(entryPrice > 0) || entryPrice >= 1 || !(orderPrice > 0) || orderPrice >= 1) {
    return { blocked: true, reason: 'INVALID_SIZING_INPUTS' };
  }

  let stakeFraction = settings.stakeFraction;
  if (peakBalance > settings.peakDrawdownBrakeMinBankroll) {
    const drawdownPct = (peakBalance - bankroll) / peakBalance;
    if (drawdownPct >= settings.peakDrawdownBrakePct) {
      stakeFraction = Math.min(stakeFraction, settings.peakDrawdownBrakeStakeFraction);
    }
  }

  let requestedSize = bankroll * stakeFraction;
  if (pWinEstimate >= settings.kellyMinPWin && entryPrice > 0 && entryPrice < 1) {
    const effectiveEntry = Math.min(0.99, entryPrice * (1 + settings.slippagePct));
    const b = (1 / effectiveEntry) - 1;
    if (b > 0) {
      const fullKelly = (b * pWinEstimate - (1 - pWinEstimate)) / b;
      if (fullKelly > 0) {
        const kellySize = bankroll * Math.min(fullKelly * settings.kellyFraction, settings.kellyMaxFraction);
        if (kellySize < requestedSize) requestedSize = kellySize;
      }
    }
  }

  requestedSize = Math.min(requestedSize, bankroll * stakeFraction);
  requestedSize = Math.min(requestedSize, getTieredMaxAbsoluteStake(bankroll, settings));
  requestedSize = Math.min(requestedSize, bankroll);

  const minOrderCost = effectiveMinOrderShares * entryPrice;
  if (requestedSize + EPS < minOrderCost) {
    const minCashNeeded = bankroll < settings.microBankrollThreshold ? minOrderCost : minOrderCost * 1.05;
    if (bankroll + EPS >= minCashNeeded) {
      requestedSize = minOrderCost;
    } else {
      return {
        blocked: true,
        reason: `BELOW_MIN_ORDER ($${requestedSize.toFixed(2)} < $${minOrderCost.toFixed(2)})`,
      };
    }
  }

  const floorEnabled = bankroll >= settings.microBankrollThreshold;
  if (floorEnabled) {
    const maxSafeStake = Math.max(0, bankroll - settings.minBalanceFloor);
    requestedSize = Math.min(requestedSize, maxSafeStake);
  }
  if (requestedSize + EPS < minOrderCost) {
    return {
      blocked: true,
      reason: `SIZE_BELOW_MIN_AFTER_GUARDS ($${requestedSize.toFixed(2)} < $${minOrderCost.toFixed(2)})`,
    };
  }

  let shares = Math.floor(requestedSize / orderPrice + EPS);
  const maxAffordableShares = getMaxAffordableSharesForEntry(
    bankroll,
    orderPrice,
    settings.feeModel,
  );
  if (maxAffordableShares < shares) {
    shares = maxAffordableShares;
  }
  if (shares < effectiveMinOrderShares) {
    return {
      blocked: true,
      reason: `SHARES_BELOW_MIN (${shares} < ${effectiveMinOrderShares})`,
    };
  }

  const cost = shares * orderPrice;
  const entryFee = calcPolymarketTakerFeeUsd(shares, orderPrice, settings.feeModel);
  const entryDebit = cost + entryFee;
  if (!(cost > 0) || entryDebit > bankroll + EPS) {
    return { blocked: true, reason: 'INSUFFICIENT_CASH_FOR_ROUNDED_SHARES' };
  }

  return {
    blocked: false,
    shares,
    cost,
    entryFee,
    entryDebit,
    requestedSize,
    effectiveMinOrderShares,
    signalEntryPrice: entryPrice,
    orderPrice,
    stakeFraction,
  };
}

function computeTradeClose(openTrade, event, overrides = {}) {
  const settings = getDefaultSettings(overrides);
  const cost = Number(openTrade.cost || 0);
  const shares = Number(openTrade.shares || 0);
  const entryFee = Number(openTrade.entryFee || 0);

  let exitPrice = 0;
  let closeTimestamp = event.epoch + settings.cycleSeconds;
  let grossPayout = 0;
  let payout = 0;
  let exitFee = 0;
  let reason = 'RESOLVED_LOSS';

  if (event.preResolutionExit) {
    exitPrice = Number(event.preResolutionExit.exitPrice || 0);
    closeTimestamp = Number(event.preResolutionExit.timestamp || closeTimestamp);
    grossPayout = shares * exitPrice;
    exitFee = calcPolymarketTakerFeeUsd(shares, exitPrice, settings.feeModel);
    payout = grossPayout - exitFee;
    reason = 'PRE_RESOLUTION_EXIT';
  } else if (event.resolutionWon) {
    exitPrice = 1;
    grossPayout = shares;
    payout = grossPayout;
    reason = 'RESOLVED_WIN';
  }

  const fee = entryFee + exitFee;
  const pnl = payout - cost - entryFee;
  return {
    payout,
    grossPayout,
    pnl,
    fee,
    entryFee,
    exitFee,
    exitPrice,
    closeTimestamp,
    reason,
    profitable: pnl >= -EPS,
    resolvedWin: reason === 'RESOLVED_WIN',
  };
}

function simulateSequence(events, startBank, overrides = {}) {
  const settings = getDefaultSettings(overrides);
  const tradabilityFloor = toFiniteNumber(
    overrides.tradabilityFloor,
    computeTradabilityFloor(events, settings),
  );
  let bankroll = startBank;
  let peakBalance = startBank;
  let maxDrawdown = 0;
  let cooldownUntil = -Infinity;
  let consecutiveLosses = 0;
  let executedTrades = 0;
  let blockedEntries = 0;
  let wins = 0;
  let losses = 0;
  let preResolutionExits = 0;

  for (const event of events) {
    if (event.timestamp < cooldownUntil) continue;
    const openTrade = computeTradeOpen(bankroll, peakBalance, event, settings);
    if (openTrade.blocked) {
      blockedEntries++;
      if (bankroll + EPS < tradabilityFloor) break;
      continue;
    }

    bankroll -= Number(openTrade.entryDebit || openTrade.cost || 0);
    const closeTrade = computeTradeClose(openTrade, event, settings);
    bankroll += closeTrade.payout;
    executedTrades++;

    if (closeTrade.reason === 'PRE_RESOLUTION_EXIT') preResolutionExits++;
    if (closeTrade.profitable) {
      wins++;
      consecutiveLosses = 0;
    } else {
      losses++;
      consecutiveLosses++;
      if (consecutiveLosses >= settings.maxConsecutiveLosses) {
        cooldownUntil = closeTrade.closeTimestamp + settings.cooldownSeconds;
        consecutiveLosses = 0;
      }
    }

    if (bankroll > peakBalance) peakBalance = bankroll;
    const drawdown = peakBalance > 0 ? (peakBalance - bankroll) / peakBalance : 0;
    if (drawdown > maxDrawdown) maxDrawdown = drawdown;
  }

  return {
    final: bankroll,
    peak: peakBalance,
    maxDD: maxDrawdown,
    trades: executedTrades,
    wins,
    losses,
    blockedEntries,
    preResolutionExits,
    winRate: executedTrades > 0 ? wins / executedTrades : 0,
    busted: bankroll + EPS < tradabilityFloor,
    tradabilityFloor,
  };
}

function summarizeRuns(runs) {
  const finals = runs.map((run) => run.final).sort((a, b) => a - b);
  const drawdowns = runs.map((run) => run.maxDD).sort((a, b) => a - b);
  const trades = runs.map((run) => run.trades).sort((a, b) => a - b);
  const preResolutionExits = runs.map((run) => run.preResolutionExits).sort((a, b) => a - b);
  const blockedEntries = runs.map((run) => run.blockedEntries).sort((a, b) => a - b);
  const quantile = (values, p) => values[Math.min(values.length - 1, Math.floor(p * values.length))] || 0;
  return {
    bust: (runs.filter((run) => run.busted).length / Math.max(1, runs.length)) * 100,
    p5: quantile(finals, 0.05),
    p10: quantile(finals, 0.10),
    p25: quantile(finals, 0.25),
    median: quantile(finals, 0.50),
    p75: quantile(finals, 0.75),
    p90: quantile(finals, 0.90),
    p95: quantile(finals, 0.95),
    medianDD: quantile(drawdowns, 0.50) * 100,
    p90DD: quantile(drawdowns, 0.90) * 100,
    medianTrades: quantile(trades, 0.50),
    medianPreResolutionExits: quantile(preResolutionExits, 0.50),
    medianBlockedEntries: quantile(blockedEntries, 0.50),
  };
}

function buildTimeWindows(events, horizonHours) {
  if (!events.length) return [];
  const horizonSeconds = horizonHours * 3600;
  const windows = [];
  let endIdx = 0;
  for (let startIdx = 0; startIdx < events.length; startIdx++) {
    const startTs = events[startIdx].timestamp;
    while (endIdx < events.length && events[endIdx].timestamp < startTs + horizonSeconds) {
      endIdx++;
    }
    if (endIdx > startIdx) {
      windows.push({ startIdx, endIdx });
    }
  }
  return windows;
}

function simulateBlockBootstrap(events, startBank, horizonHours, overrides = {}) {
  const runs = Math.max(1, Math.floor(toFiniteNumber(overrides.runs, 10000)));
  const windows = buildTimeWindows(events, horizonHours);
  if (!windows.length) return summarizeRuns([simulateSequence(events, startBank, overrides)]);
  const results = [];
  for (let run = 0; run < runs; run++) {
    const window = windows[Math.floor(Math.random() * windows.length)];
    results.push(
      simulateSequence(events.slice(window.startIdx, window.endIdx), startBank, overrides),
    );
  }
  return summarizeRuns(results);
}

module.exports = {
  ASSET_RANK,
  getDefaultSettings,
  loadStrategySet,
  loadIntracycleData,
  normalizeStrategy,
  buildRuntimeEvents,
  computeTradabilityFloor,
  computeTradeOpen,
  computeTradeClose,
  estimateNetEdgeRoi,
  simulateSequence,
  simulateBlockBootstrap,
  summarizeRuns,
};
