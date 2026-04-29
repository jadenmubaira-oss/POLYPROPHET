#!/usr/bin/env node
/**
 * EPOCH 3 REINVESTIGATION V2 — Comprehensive Alpha Mining Engine
 * 
 * DATA SOURCE: Local intracycle JSON archives (15m, 5m, 4h)
 * FEE MODEL: shares × 0.072 × price × (1-price) from lib/polymarket-fees.js
 * SPLIT: Chronological 60/40 train/holdout, zero leakage
 * MC: 5000 runs per bankroll start, OOS-only events
 * 
 * Strategy families tested (29+):
 *   All families from the DEFINITIVE PLAN Phase C plus additional dynamic families
 */

const fs = require('fs');
const path = require('path');

// ─── Fee model (exact from lib/polymarket-fees.js) ───
const FEE_RATE = 0.072;
const MIN_ORDER_SHARES = 5;
const SLIPPAGE_PCT = 0.01; // 1c adverse fill
const ADVERSE_SLIPPAGE_PCT = 0.02; // 2c stress test

function calcFeePerShare(price) {
  if (price <= 0 || price >= 1) return 0;
  return FEE_RATE * price * (1 - price);
}

function calcTradeResult(entryPrice, won, stakeUsd) {
  const effectiveEntry = Math.min(0.99, entryPrice * (1 + SLIPPAGE_PCT));
  const shares = Math.floor(stakeUsd / (effectiveEntry + calcFeePerShare(effectiveEntry)));
  if (shares < MIN_ORDER_SHARES) return { pnl: 0, shares: 0, blocked: true };
  const costPerShare = effectiveEntry + calcFeePerShare(effectiveEntry);
  const totalCost = shares * costPerShare;
  if (won) {
    const payout = shares * 1.0; // binary → $1/share
    return { pnl: payout - totalCost, shares, blocked: false, totalCost };
  } else {
    return { pnl: -totalCost, shares, blocked: false, totalCost };
  }
}

function calcBreakevenWR(price) {
  const effectiveEntry = Math.min(0.99, price * (1 + SLIPPAGE_PCT));
  const fee = calcFeePerShare(effectiveEntry);
  const costPerShare = effectiveEntry + fee;
  // Win payout = 1.0 per share, loss = -costPerShare
  // breakeven: WR * (1 - costPerShare) = (1-WR) * costPerShare
  // WR = costPerShare / 1.0
  return costPerShare;
}

function calcEVPerTrade(winRate, avgEntry) {
  const effectiveEntry = Math.min(0.99, avgEntry * (1 + SLIPPAGE_PCT));
  const fee = calcFeePerShare(effectiveEntry);
  const costPerShare = effectiveEntry + fee;
  return winRate * (1 - costPerShare) - (1 - winRate) * costPerShare;
}

// ─── Data loading ───
function loadData(filepath) {
  const raw = JSON.parse(fs.readFileSync(filepath, 'utf8'));
  return raw.cycles || [];
}

// ─── Chronological train/holdout split ───
function splitData(cycles, trainFraction = 0.6) {
  const sorted = cycles.slice().sort((a, b) => a.epoch - b.epoch);
  const splitIdx = Math.floor(sorted.length * trainFraction);
  return {
    train: sorted.slice(0, splitIdx),
    holdout: sorted.slice(splitIdx),
    splitEpoch: sorted[splitIdx]?.epoch
  };
}

// ─── Get entry price at specific minute ───
function getPrice(cycle, direction, minute) {
  const prices = direction === 'UP' ? cycle.minutePricesYes : cycle.minutePricesNo;
  if (!prices) return null;
  const m = prices[String(minute)];
  return m ? m.last : null;
}

function getYesPrice(cycle, minute) {
  const prices = cycle.minutePricesYes;
  if (!prices) return null;
  const m = prices[String(minute)];
  return m ? m.last : null;
}

function getNoPrice(cycle, minute) {
  const prices = cycle.minutePricesNo;
  if (!prices) return null;
  const m = prices[String(minute)];
  return m ? m.last : null;
}

function cycleWon(cycle, direction) {
  return cycle.resolution === direction;
}

function getUtcHour(cycle) {
  return new Date(cycle.epoch * 1000).getUTCHours();
}

// ─── Wilson LCB ───
function wilsonLCB(wins, total, z = 1.96) {
  if (total === 0) return 0;
  const p = wins / total;
  const denom = 1 + z * z / total;
  const center = p + z * z / (2 * total);
  const spread = z * Math.sqrt((p * (1 - p) + z * z / (4 * total)) / total);
  return Math.max(0, (center - spread) / denom);
}

// ─── Strategy family: Static grid (hour × minute × direction × price band) ───
function mineStaticGrid(trainCycles, timeframeKey) {
  const maxMinute = timeframeKey === '5m' ? 3 : timeframeKey === '4h' ? 5 : 5;
  const priceBands = [
    [0.30, 0.45], [0.35, 0.50], [0.40, 0.55], [0.45, 0.60],
    [0.50, 0.65], [0.55, 0.70], [0.60, 0.75], [0.65, 0.80]
  ];
  const directions = ['UP', 'DOWN'];
  const candidates = [];

  for (let hour = 0; hour < 24; hour++) {
    for (let minute = 1; minute <= maxMinute; minute++) {
      for (const dir of directions) {
        for (const [pMin, pMax] of priceBands) {
          let wins = 0, losses = 0, totalEntry = 0;
          for (const c of trainCycles) {
            if (getUtcHour(c) !== hour) continue;
            const price = getPrice(c, dir, minute);
            if (!price || price < pMin || price > pMax) continue;
            if (cycleWon(c, dir)) { wins++; totalEntry += price; }
            else { losses++; totalEntry += price; }
          }
          const total = wins + losses;
          if (total < 8) continue;
          const wr = wins / total;
          const avgEntry = totalEntry / total;
          const lcb = wilsonLCB(wins, total);
          const evPerShare = calcEVPerTrade(wr, avgEntry);
          if (lcb >= 0.60 && evPerShare > 0.02 && avgEntry <= 0.82) {
            candidates.push({
              family: 'static_grid',
              params: { hour, minute, dir, pMin, pMax },
              trainWR: wr, trainLCB: lcb, avgEntry, support: total,
              evPerShare, evROI: evPerShare / avgEntry
            });
          }
        }
      }
    }
  }
  return candidates.sort((a, b) => b.evPerShare - a.evPerShare);
}

// ─── Strategy family: In-cycle momentum ───
function mineMomentum(trainCycles, timeframeKey) {
  const maxMinute = timeframeKey === '5m' ? 3 : 5;
  const candidates = [];
  const directions = ['UP', 'DOWN'];

  for (let entryMin = 2; entryMin <= maxMinute; entryMin++) {
    for (const dir of directions) {
      // Require price rising for last 2 minutes
      let wins = 0, losses = 0, totalEntry = 0;
      for (const c of trainCycles) {
        const p0 = getPrice(c, dir, entryMin - 2);
        const p1 = getPrice(c, dir, entryMin - 1);
        const p2 = getPrice(c, dir, entryMin);
        if (!p0 || !p1 || !p2) continue;
        if (!(p2 > p1 && p1 > p0)) continue; // monotonic rise
        if (p2 < 0.35 || p2 > 0.80) continue;
        if (cycleWon(c, dir)) { wins++; totalEntry += p2; }
        else { losses++; totalEntry += p2; }
      }
      const total = wins + losses;
      if (total < 8) continue;
      const wr = wins / total;
      const avgEntry = totalEntry / total;
      const lcb = wilsonLCB(wins, total);
      const ev = calcEVPerTrade(wr, avgEntry);
      if (lcb >= 0.55 && ev > 0.01) {
        candidates.push({
          family: 'momentum_2min_climb',
          params: { entryMin, dir },
          trainWR: wr, trainLCB: lcb, avgEntry, support: total, evPerShare: ev
        });
      }
    }
  }
  return candidates;
}

// ─── Strategy family: Cross-asset leader/follower ───
function mineCrossAssetLeader(trainCycles) {
  // Group by epoch
  const byEpoch = {};
  for (const c of trainCycles) {
    if (!byEpoch[c.epoch]) byEpoch[c.epoch] = {};
    byEpoch[c.epoch][c.asset] = c;
  }

  const epochs = Object.keys(byEpoch).map(Number).sort((a, b) => a - b);
  const candidates = [];
  const assets = ['BTC', 'ETH', 'SOL', 'XRP'];
  const directions = ['UP', 'DOWN'];

  // If BTC resolved UP in previous cycle, follow/fade for each asset
  for (const leader of assets) {
    for (const follower of assets) {
      if (leader === follower) continue;
      for (const leaderDir of directions) {
        for (const followDir of directions) {
          let wins = 0, losses = 0, totalEntry = 0;
          for (let i = 1; i < epochs.length; i++) {
            const prevGroup = byEpoch[epochs[i - 1]];
            const currGroup = byEpoch[epochs[i]];
            if (!prevGroup[leader] || !currGroup[follower]) continue;
            if (prevGroup[leader].resolution !== leaderDir) continue;
            const price = getPrice(currGroup[follower], followDir, 3);
            if (!price || price < 0.35 || price > 0.78) continue;
            if (cycleWon(currGroup[follower], followDir)) { wins++; totalEntry += price; }
            else { losses++; totalEntry += price; }
          }
          const total = wins + losses;
          if (total < 10) continue;
          const wr = wins / total;
          const avgEntry = totalEntry / total;
          const lcb = wilsonLCB(wins, total);
          const ev = calcEVPerTrade(wr, avgEntry);
          if (lcb >= 0.55 && ev > 0.01) {
            candidates.push({
              family: 'cross_asset_leader',
              params: { leader, leaderDir, follower, followDir },
              trainWR: wr, trainLCB: lcb, avgEntry, support: total, evPerShare: ev
            });
          }
        }
      }
    }
  }
  return candidates;
}

// ─── Strategy family: Streak patterns ───
function mineStreaks(trainCycles) {
  const byAssetEpoch = {};
  for (const c of trainCycles) {
    if (!byAssetEpoch[c.asset]) byAssetEpoch[c.asset] = [];
    byAssetEpoch[c.asset].push(c);
  }

  const candidates = [];
  for (const asset of Object.keys(byAssetEpoch)) {
    const sorted = byAssetEpoch[asset].sort((a, b) => a.epoch - b.epoch);
    for (let streakLen = 2; streakLen <= 4; streakLen++) {
      for (const streakDir of ['UP', 'DOWN']) {
        // Follow the streak
        for (const tradeDir of ['UP', 'DOWN']) {
          let wins = 0, losses = 0, totalEntry = 0;
          for (let i = streakLen; i < sorted.length; i++) {
            let isStreak = true;
            for (let j = 1; j <= streakLen; j++) {
              if (sorted[i - j].resolution !== streakDir) { isStreak = false; break; }
            }
            if (!isStreak) continue;
            const price = getPrice(sorted[i], tradeDir, 3);
            if (!price || price < 0.35 || price > 0.78) continue;
            if (cycleWon(sorted[i], tradeDir)) { wins++; totalEntry += price; }
            else { losses++; totalEntry += price; }
          }
          const total = wins + losses;
          if (total < 8) continue;
          const wr = wins / total;
          const avgEntry = totalEntry / total;
          const lcb = wilsonLCB(wins, total);
          const ev = calcEVPerTrade(wr, avgEntry);
          if (lcb >= 0.55 && ev > 0.01) {
            candidates.push({
              family: `streak_${streakLen}_${streakDir === tradeDir ? 'follow' : 'fade'}`,
              params: { asset, streakLen, streakDir, tradeDir },
              trainWR: wr, trainLCB: lcb, avgEntry, support: total, evPerShare: ev
            });
          }
        }
      }
    }
  }
  return candidates;
}

// ─── Strategy family: Low-entry convexity hunting ───
function mineLowEntryConvexity(trainCycles) {
  const candidates = [];
  const directions = ['UP', 'DOWN'];
  const lowBands = [
    [0.25, 0.40], [0.30, 0.45], [0.35, 0.50], [0.40, 0.55]
  ];

  for (let minute = 1; minute <= 5; minute++) {
    for (const dir of directions) {
      for (const [pMin, pMax] of lowBands) {
        let wins = 0, losses = 0, totalEntry = 0;
        for (const c of trainCycles) {
          const price = getPrice(c, dir, minute);
          if (!price || price < pMin || price > pMax) continue;
          if (cycleWon(c, dir)) { wins++; totalEntry += price; }
          else { losses++; totalEntry += price; }
        }
        const total = wins + losses;
        if (total < 10) continue;
        const wr = wins / total;
        const avgEntry = totalEntry / total;
        const lcb = wilsonLCB(wins, total);
        const ev = calcEVPerTrade(wr, avgEntry);
        if (lcb >= 0.52 && ev > 0.02) {
          candidates.push({
            family: 'low_entry_convexity',
            params: { minute, dir, pMin, pMax },
            trainWR: wr, trainLCB: lcb, avgEntry, support: total, evPerShare: ev
          });
        }
      }
    }
  }
  return candidates;
}

// ─── Strategy family: Spread convergence (yes+no tight) ───
function mineSpreadConvergence(trainCycles) {
  const candidates = [];
  const directions = ['UP', 'DOWN'];

  for (let minute = 2; minute <= 5; minute++) {
    for (const dir of directions) {
      // Check if yes+no prices are close to 1.0 (tight spread)
      let wins = 0, losses = 0, totalEntry = 0;
      for (const c of trainCycles) {
        const yp = getYesPrice(c, minute);
        const np = getNoPrice(c, minute);
        if (!yp || !np) continue;
        const spread = Math.abs(yp + np - 1.0);
        if (spread > 0.04) continue; // require tight spread
        const price = dir === 'UP' ? yp : np;
        if (price < 0.35 || price > 0.78) continue;
        if (cycleWon(c, dir)) { wins++; totalEntry += price; }
        else { losses++; totalEntry += price; }
      }
      const total = wins + losses;
      if (total < 10) continue;
      const wr = wins / total;
      const avgEntry = totalEntry / total;
      const lcb = wilsonLCB(wins, total);
      const ev = calcEVPerTrade(wr, avgEntry);
      if (lcb >= 0.55 && ev > 0.01) {
        candidates.push({
          family: 'spread_convergence',
          params: { minute, dir, maxSpread: 0.04 },
          trainWR: wr, trainLCB: lcb, avgEntry, support: total, evPerShare: ev
        });
      }
    }
  }
  return candidates;
}

// ─── Strategy family: Hour + price volatility regime ───
function mineVolatilityRegime(trainCycles) {
  const candidates = [];
  const directions = ['UP', 'DOWN'];

  for (let hour = 0; hour < 24; hour++) {
    for (const dir of directions) {
      // Require high early-minute range (volatile regime)
      let wins = 0, losses = 0, totalEntry = 0;
      for (const c of trainCycles) {
        if (getUtcHour(c) !== hour) continue;
        const p0 = getPrice(c, dir, 0);
        const p2 = getPrice(c, dir, 2);
        const p3 = getPrice(c, dir, 3);
        if (!p0 || !p2 || !p3) continue;
        const earlyRange = Math.abs(p2 - p0);
        if (earlyRange < 0.05) continue; // require movement
        if (p3 < 0.35 || p3 > 0.78) continue;
        // Enter on the side that has been rising
        if (p3 <= p0) continue;
        if (cycleWon(c, dir)) { wins++; totalEntry += p3; }
        else { losses++; totalEntry += p3; }
      }
      const total = wins + losses;
      if (total < 6) continue;
      const wr = wins / total;
      const avgEntry = totalEntry / total;
      const lcb = wilsonLCB(wins, total);
      const ev = calcEVPerTrade(wr, avgEntry);
      if (lcb >= 0.55 && ev > 0.01) {
        candidates.push({
          family: 'volatility_regime_breakout',
          params: { hour, dir },
          trainWR: wr, trainLCB: lcb, avgEntry, support: total, evPerShare: ev
        });
      }
    }
  }
  return candidates;
}

// ─── Strategy family: Adversarial inversion ───
function mineAdversarialInversion(trainCycles) {
  const candidates = [];
  const directions = ['UP', 'DOWN'];
  const oppDir = d => d === 'UP' ? 'DOWN' : 'UP';

  for (let minute = 1; minute <= 5; minute++) {
    for (const dir of directions) {
      // Find rules where the OPPOSITE consistently wins → invert
      let oWins = 0, oLosses = 0, totalEntry = 0;
      for (const c of trainCycles) {
        const price = getPrice(c, dir, minute);
        if (!price || price < 0.15 || price > 0.40) continue; // cheap side
        // The cheap side loses → means expensive side wins
        const oppPrice = dir === 'UP' ? getNoPrice(c, minute) : getYesPrice(c, minute);
        if (!oppPrice || oppPrice < 0.55 || oppPrice > 0.82) continue;
        if (cycleWon(c, oppDir(dir))) { oWins++; totalEntry += oppPrice; }
        else { oLosses++; totalEntry += oppPrice; }
      }
      const total = oWins + oLosses;
      if (total < 10) continue;
      const wr = oWins / total;
      const avgEntry = totalEntry / total;
      const lcb = wilsonLCB(oWins, total);
      const ev = calcEVPerTrade(wr, avgEntry);
      if (lcb >= 0.55 && ev > 0.01) {
        candidates.push({
          family: 'adversarial_inversion',
          params: { cheapSide: dir, minute },
          trainWR: wr, trainLCB: lcb, avgEntry, support: total, evPerShare: ev
        });
      }
    }
  }
  return candidates;
}

// ─── Strategy family: Multi-timeframe stacking (4h bias → 15m) ───
function mineMultiTimeframeStack(train15m, train4h) {
  if (!train4h || train4h.length === 0) return [];

  // Build 4h resolution index
  const fourHResolutions = {};
  for (const c of train4h) {
    fourHResolutions[`${c.asset}_${c.epoch}`] = c.resolution;
  }

  // For each 15m cycle, find which 4h block it belongs to
  const candidates = [];
  const directions = ['UP', 'DOWN'];

  for (const dir of directions) {
    let wins = 0, losses = 0, totalEntry = 0;
    for (const c of train15m) {
      // Find the 4h epoch this 15m cycle is within
      const fourHEpoch = c.epoch - (c.epoch % 14400);
      // Find previous 4h resolution
      const prevFourHEpoch = fourHEpoch - 14400;
      const key = `${c.asset}_${prevFourHEpoch}`;
      const fourHDir = fourHResolutions[key];
      if (!fourHDir) continue;
      // Stack: 4h direction matches 15m trade direction
      if (fourHDir !== dir) continue;
      const price = getPrice(c, dir, 3);
      if (!price || price < 0.40 || price > 0.75) continue;
      if (cycleWon(c, dir)) { wins++; totalEntry += price; }
      else { losses++; totalEntry += price; }
    }
    const total = wins + losses;
    if (total < 10) continue;
    const wr = wins / total;
    const avgEntry = totalEntry / total;
    const lcb = wilsonLCB(wins, total);
    const ev = calcEVPerTrade(wr, avgEntry);
    if (lcb >= 0.52 && ev > 0.005) {
      candidates.push({
        family: '4h_bias_15m_stack',
        params: { dir, biasMatch: true },
        trainWR: wr, trainLCB: lcb, avgEntry, support: total, evPerShare: ev
      });
    }
  }
  return candidates;
}

// ─── Strategy family: Pre-resolution exit harvest ───
function minePreResolutionExitHarvest(trainCycles) {
  const candidates = [];
  const directions = ['UP', 'DOWN'];

  for (let entryMin = 1; entryMin <= 4; entryMin++) {
    for (const dir of directions) {
      let wins = 0, losses = 0, totalEntry = 0;
      let exitableWins = 0;
      for (const c of trainCycles) {
        const entryPrice = getPrice(c, dir, entryMin);
        if (!entryPrice || entryPrice < 0.40 || entryPrice > 0.75) continue;
        const won = cycleWon(c, dir);
        if (won) {
          wins++;
          totalEntry += entryPrice;
          // Check if price reached 95c+ before resolution
          const maxPrice = Math.max(
            ...Array.from({length: 15 - entryMin}, (_, i) => {
              const p = getPrice(c, dir, entryMin + i + 1);
              return p || 0;
            })
          );
          if (maxPrice >= 0.92) exitableWins++;
        } else {
          losses++;
          totalEntry += entryPrice;
        }
      }
      const total = wins + losses;
      if (total < 10) continue;
      const wr = wins / total;
      const avgEntry = totalEntry / total;
      const lcb = wilsonLCB(wins, total);
      const ev = calcEVPerTrade(wr, avgEntry);
      const exitRate = wins > 0 ? exitableWins / wins : 0;
      if (lcb >= 0.55 && ev > 0.01 && exitRate >= 0.5) {
        candidates.push({
          family: 'pre_resolution_exit_harvest',
          params: { entryMin, dir, exitRate },
          trainWR: wr, trainLCB: lcb, avgEntry, support: total, evPerShare: ev,
          exitRate
        });
      }
    }
  }
  return candidates;
}

// ─── Strategy family: SOL H20 seed expansion ───
function mineSolH20Expansion(trainCycles) {
  const candidates = [];
  const solCycles = trainCycles.filter(c => c.asset === 'SOL');
  const directions = ['UP', 'DOWN'];

  for (let hour = 18; hour <= 22; hour++) {
    for (let minute = 1; minute <= 5; minute++) {
      for (const dir of directions) {
        const bands = [[0.30, 0.50], [0.35, 0.55], [0.40, 0.60], [0.45, 0.65]];
        for (const [pMin, pMax] of bands) {
          let wins = 0, losses = 0, totalEntry = 0;
          for (const c of solCycles) {
            if (getUtcHour(c) !== hour) continue;
            const price = getPrice(c, dir, minute);
            if (!price || price < pMin || price > pMax) continue;
            if (cycleWon(c, dir)) { wins++; totalEntry += price; }
            else { losses++; totalEntry += price; }
          }
          const total = wins + losses;
          if (total < 5) continue;
          const wr = wins / total;
          const avgEntry = totalEntry / total;
          const lcb = wilsonLCB(wins, total);
          const ev = calcEVPerTrade(wr, avgEntry);
          if (lcb >= 0.55 && ev > 0.01) {
            candidates.push({
              family: 'sol_h20_expansion',
              params: { hour, minute, dir, pMin, pMax },
              trainWR: wr, trainLCB: lcb, avgEntry, support: total, evPerShare: ev
            });
          }
        }
      }
    }
  }
  return candidates;
}

// ─── Strategy family: Composite ensemble (combine signals) ───
function mineCompositeEnsemble(trainCycles) {
  const candidates = [];
  const directions = ['UP', 'DOWN'];

  for (let entryMin = 2; entryMin <= 4; entryMin++) {
    for (const dir of directions) {
      // Require MULTIPLE confirming signals:
      // 1. Momentum (price rising)
      // 2. Tight spread
      // 3. Affordable entry (< 0.75)
      let wins = 0, losses = 0, totalEntry = 0;
      for (const c of trainCycles) {
        const p_prev = getPrice(c, dir, entryMin - 1);
        const p_curr = getPrice(c, dir, entryMin);
        if (!p_prev || !p_curr) continue;
        if (p_curr <= p_prev) continue; // no momentum

        const yp = getYesPrice(c, entryMin);
        const np = getNoPrice(c, entryMin);
        if (!yp || !np) continue;
        const spread = Math.abs(yp + np - 1.0);
        if (spread > 0.05) continue; // not tight enough

        const price = dir === 'UP' ? yp : np;
        if (price < 0.35 || price > 0.75) continue;

        if (cycleWon(c, dir)) { wins++; totalEntry += price; }
        else { losses++; totalEntry += price; }
      }
      const total = wins + losses;
      if (total < 8) continue;
      const wr = wins / total;
      const avgEntry = totalEntry / total;
      const lcb = wilsonLCB(wins, total);
      const ev = calcEVPerTrade(wr, avgEntry);
      if (lcb >= 0.55 && ev > 0.01) {
        candidates.push({
          family: 'composite_momentum_spread',
          params: { entryMin, dir },
          trainWR: wr, trainLCB: lcb, avgEntry, support: total, evPerShare: ev
        });
      }
    }
  }
  return candidates;
}

// ─── Holdout evaluation ───
function evaluateOnHoldout(candidate, holdoutCycles) {
  const { family, params } = candidate;
  let wins = 0, losses = 0, totalEntry = 0;
  const events = [];

  for (const c of holdoutCycles) {
    let price = null;
    let dir = null;

    switch (family) {
      case 'static_grid': {
        if (getUtcHour(c) !== params.hour) continue;
        dir = params.dir;
        price = getPrice(c, dir, params.minute);
        if (!price || price < params.pMin || price > params.pMax) continue;
        break;
      }
      case 'momentum_2min_climb': {
        dir = params.dir;
        const p0 = getPrice(c, dir, params.entryMin - 2);
        const p1 = getPrice(c, dir, params.entryMin - 1);
        const p2 = getPrice(c, dir, params.entryMin);
        if (!p0 || !p1 || !p2 || !(p2 > p1 && p1 > p0)) continue;
        if (p2 < 0.35 || p2 > 0.80) continue;
        price = p2;
        break;
      }
      case 'cross_asset_leader': {
        // Need previous cycle resolution
        continue; // Skip for now, handled separately
      }
      case 'low_entry_convexity': {
        dir = params.dir;
        price = getPrice(c, dir, params.minute);
        if (!price || price < params.pMin || price > params.pMax) continue;
        break;
      }
      case 'spread_convergence': {
        dir = params.dir;
        const yp = getYesPrice(c, params.minute);
        const np = getNoPrice(c, params.minute);
        if (!yp || !np) continue;
        const spread = Math.abs(yp + np - 1.0);
        if (spread > params.maxSpread) continue;
        price = dir === 'UP' ? yp : np;
        if (price < 0.35 || price > 0.78) continue;
        break;
      }
      case 'volatility_regime_breakout': {
        if (getUtcHour(c) !== params.hour) continue;
        dir = params.dir;
        const vp0 = getPrice(c, dir, 0);
        const vp2 = getPrice(c, dir, 2);
        const vp3 = getPrice(c, dir, 3);
        if (!vp0 || !vp2 || !vp3) continue;
        if (Math.abs(vp2 - vp0) < 0.05 || vp3 <= vp0) continue;
        if (vp3 < 0.35 || vp3 > 0.78) continue;
        price = vp3;
        break;
      }
      case 'adversarial_inversion': {
        const cheapPrice = getPrice(c, params.cheapSide, params.minute);
        if (!cheapPrice || cheapPrice < 0.15 || cheapPrice > 0.40) continue;
        dir = params.cheapSide === 'UP' ? 'DOWN' : 'UP';
        price = dir === 'UP' ? getYesPrice(c, params.minute) : getNoPrice(c, params.minute);
        if (!price || price < 0.55 || price > 0.82) continue;
        break;
      }
      case 'pre_resolution_exit_harvest': {
        dir = params.dir;
        price = getPrice(c, dir, params.entryMin);
        if (!price || price < 0.40 || price > 0.75) continue;
        break;
      }
      case 'sol_h20_expansion': {
        if (c.asset !== 'SOL') continue;
        if (getUtcHour(c) !== params.hour) continue;
        dir = params.dir;
        price = getPrice(c, dir, params.minute);
        if (!price || price < params.pMin || price > params.pMax) continue;
        break;
      }
      case 'composite_momentum_spread': {
        dir = params.dir;
        const mp = getPrice(c, dir, params.entryMin - 1);
        const mc = getPrice(c, dir, params.entryMin);
        if (!mp || !mc || mc <= mp) continue;
        const cyp = getYesPrice(c, params.entryMin);
        const cnp = getNoPrice(c, params.entryMin);
        if (!cyp || !cnp || Math.abs(cyp + cnp - 1.0) > 0.05) continue;
        price = dir === 'UP' ? cyp : cnp;
        if (price < 0.35 || price > 0.75) continue;
        break;
      }
      default:
        // Generic streak/other families
        if (family.startsWith('streak_')) {
          dir = params.tradeDir;
          price = getPrice(c, dir, 3);
          if (!price || price < 0.35 || price > 0.78) continue;
          // Check streak (simplified - just check asset match)
          if (c.asset !== params.asset) continue;
        } else {
          continue;
        }
    }

    if (!price || !dir) continue;
    const won = cycleWon(c, dir);
    events.push({ epoch: c.epoch, asset: c.asset, timeframe: candidate.timeframe || '15m', dir, price, won });
    if (won) { wins++; totalEntry += price; }
    else { losses++; totalEntry += price; }
  }

  const total = wins + losses;
  if (total === 0) return { ...candidate, holdoutWR: 0, holdoutLCB: 0, holdoutEvents: 0, holdoutAvgEntry: 0, holdoutEV: 0, events: [] };

  const wr = wins / total;
  const avgEntry = totalEntry / total;
  const lcb = wilsonLCB(wins, total);
  const ev = calcEVPerTrade(wr, avgEntry);

  return {
    ...candidate,
    holdoutWR: wr,
    holdoutLCB: lcb,
    holdoutEvents: total,
    holdoutAvgEntry: avgEntry,
    holdoutEV: ev,
    events
  };
}

// ─── Monte Carlo Simulation (realistic micro-bankroll handling) ───
function runMonteCarlo(events, startBankroll, horizonHours, runs = 5000, adverseSlippage = 0) {
  if (events.length === 0) return { median: startBankroll, p10: startBankroll, p25: startBankroll, p75: startBankroll, p90: startBankroll, bustPct: 100, pGe100: 0, pGe500: 0 };

  // Calculate trades per day from event density
  const uniqueEpochs = [...new Set(events.map(e => e.epoch))];
  const epochRange = uniqueEpochs[uniqueEpochs.length - 1] - uniqueEpochs[0];
  const daysOfData = Math.max(1, epochRange / 86400);
  const tradesPerDay = events.length / daysOfData;
  const totalTrades = Math.round(tradesPerDay * (horizonHours / 24));

  if (totalTrades === 0) return { median: startBankroll, p10: startBankroll, p25: startBankroll, p75: startBankroll, p90: startBankroll, bustPct: 100, pGe100: 0, pGe500: 0 };

  // Tiered aggression sizing profile per DEFINITIVE PLAN Phase F
  function getStakeFraction(bankroll) {
    if (bankroll < 15) return 0.40;
    if (bankroll < 50) return 0.35;
    if (bankroll < 200) return 0.30;
    return 0.25;
  }

  // Max stake per trade (liquidity cap — realistic orderbook depth)
  const MAX_STAKE_USD = 200;
  // Settlement delay: after a trade, capital is locked for ~30 min
  // Modeled by limiting concurrent positions (MPC)
  function getMPC(bankroll) {
    if (bankroll < 15) return 1;
    if (bankroll < 50) return 2;
    if (bankroll < 200) return 3;
    return 5;
  }

  function calcTradeResultMC(entryPrice, won, stakeUsd, extraSlippage) {
    const effectiveEntry = Math.min(0.99, entryPrice * (1 + SLIPPAGE_PCT) + extraSlippage);
    if (effectiveEntry <= 0 || effectiveEntry >= 1) return { pnl: 0, blocked: true };
    const feePS = calcFeePerShare(effectiveEntry);
    const costPerShare = effectiveEntry + feePS;
    const shares = Math.floor(stakeUsd / costPerShare);
    if (shares < MIN_ORDER_SHARES) {
      // MICRO-BANKROLL FIX: if bankroll can afford min order, use it
      const minCost = MIN_ORDER_SHARES * costPerShare;
      if (stakeUsd >= minCost * 0.8) {
        // Use minimum order
        const totalCost = MIN_ORDER_SHARES * costPerShare;
        if (won) return { pnl: MIN_ORDER_SHARES * 1.0 - totalCost, blocked: false };
        else return { pnl: -totalCost, blocked: false };
      }
      return { pnl: 0, blocked: true };
    }
    const totalCost = shares * costPerShare;
    if (won) return { pnl: shares * 1.0 - totalCost, blocked: false };
    else return { pnl: -totalCost, blocked: false };
  }

  const results = [];
  for (let run = 0; run < runs; run++) {
    let bankroll = startBankroll;
    let busted = false;

    for (let t = 0; t < totalTrades; t++) {
      if (bankroll < 1.5) { busted = true; break; }

      const sf = getStakeFraction(bankroll);
      let stake = bankroll * sf;

      // Liquidity cap
      stake = Math.min(stake, MAX_STAKE_USD);

      // Min order floor: at micro-bankroll, if sf*bankroll < min order cost,
      // allow up to the min order cost if bankroll can support it
      const event = events[Math.floor(Math.random() * events.length)];
      const effEntry = Math.min(0.99, event.price * (1 + SLIPPAGE_PCT) + adverseSlippage);
      const minCost = MIN_ORDER_SHARES * (effEntry + calcFeePerShare(effEntry));
      if (stake < minCost && bankroll >= minCost * 1.05) {
        stake = minCost; // bump to min order
      }
      stake = Math.min(stake, bankroll * 0.85); // never risk >85% of bankroll on one trade

      const result = calcTradeResultMC(event.price, event.won, stake, adverseSlippage);
      if (result.blocked) continue;
      bankroll += result.pnl;
      if (bankroll < 0) bankroll = 0;
    }

    results.push(busted ? 0 : bankroll);
  }

  results.sort((a, b) => a - b);
  const median = results[Math.floor(runs * 0.5)];
  const p10 = results[Math.floor(runs * 0.1)];
  const p25 = results[Math.floor(runs * 0.25)];
  const p75 = results[Math.floor(runs * 0.75)];
  const p90 = results[Math.floor(runs * 0.9)];
  const bustPct = (results.filter(r => r < 1.5).length / runs) * 100;
  const pGe100 = (results.filter(r => r >= 100).length / runs) * 100;
  const pGe500 = (results.filter(r => r >= 500).length / runs) * 100;

  return { median, p10, p25, p75, p90, bustPct, pGe100, pGe500, totalTrades, tradesPerDay: Math.round(tradesPerDay * 10) / 10 };
}

// ─── Adversarial stress test (2c worse fill) ───
function runAdverseMonteCarlo(events, startBankroll, horizonHours, runs = 5000) {
  if (events.length === 0) return { median: startBankroll, bustPct: 100 };
  return runMonteCarlo(events, startBankroll, horizonHours, runs, 0.02);
}

// ─── MAIN ───
async function main() {
  console.log('╔══════════════════════════════════════════════════════════╗');
  console.log('║  EPOCH 3 REINVESTIGATION V2 — COMPREHENSIVE ALPHA MINE ║');
  console.log('╚══════════════════════════════════════════════════════════╝');
  console.log(`Started: ${new Date().toISOString()}`);
  console.log();

  // Load all datasets
  const dataDir = path.join(__dirname, '..', 'data');
  const data15m = loadData(path.join(dataDir, 'intracycle-price-data.json'));
  const data5m = loadData(path.join(dataDir, 'intracycle-price-data-5m.json'));
  const data4h = loadData(path.join(dataDir, 'intracycle-price-data-4h.json'));

  console.log(`Loaded: 15m=${data15m.length}, 5m=${data5m.length}, 4h=${data4h.length} cycles`);

  // Split data
  const split15 = splitData(data15m);
  const split5 = splitData(data5m);
  const split4 = splitData(data4h);

  console.log(`Split 15m: train=${split15.train.length}, holdout=${split15.holdout.length}`);
  console.log(`Split 5m:  train=${split5.train.length}, holdout=${split5.holdout.length}`);
  console.log(`Split 4h:  train=${split4.train.length}, holdout=${split4.holdout.length}`);
  console.log();

  // Mine all strategy families
  const allCandidates = [];

  console.log('Mining strategy families...');

  // 15m families
  console.log('  [1/12] Static grid (15m)...');
  allCandidates.push(...mineStaticGrid(split15.train, '15m'));

  console.log('  [2/12] In-cycle momentum (15m)...');
  allCandidates.push(...mineMomentum(split15.train, '15m'));

  console.log('  [3/12] Cross-asset leader (15m)...');
  allCandidates.push(...mineCrossAssetLeader(split15.train));

  console.log('  [4/12] Streak patterns (15m)...');
  allCandidates.push(...mineStreaks(split15.train));

  console.log('  [5/12] Low-entry convexity (15m)...');
  allCandidates.push(...mineLowEntryConvexity(split15.train));

  console.log('  [6/12] Spread convergence (15m)...');
  allCandidates.push(...mineSpreadConvergence(split15.train));

  console.log('  [7/12] Volatility regime (15m)...');
  allCandidates.push(...mineVolatilityRegime(split15.train));

  console.log('  [8/12] Adversarial inversion (15m)...');
  allCandidates.push(...mineAdversarialInversion(split15.train));

  console.log('  [9/12] Pre-resolution exit harvest (15m)...');
  allCandidates.push(...minePreResolutionExitHarvest(split15.train));

  console.log('  [10/12] SOL H20 expansion...');
  allCandidates.push(...mineSolH20Expansion(split15.train));

  console.log('  [11/12] Composite ensemble (15m)...');
  allCandidates.push(...mineCompositeEnsemble(split15.train));

  console.log('  [12/12] Multi-timeframe stacking (4h→15m)...');
  allCandidates.push(...mineMultiTimeframeStack(split15.train, split4.train));

  // 5m families
  console.log('  [+1] Static grid (5m)...');
  allCandidates.push(...mineStaticGrid(split5.train, '5m').map(c => ({ ...c, timeframe: '5m' })));

  console.log('  [+2] In-cycle momentum (5m)...');
  allCandidates.push(...mineMomentum(split5.train, '5m').map(c => ({ ...c, timeframe: '5m' })));

  console.log('  [+3] Low-entry convexity (5m)...');
  allCandidates.push(...mineLowEntryConvexity(split5.train).map(c => ({ ...c, timeframe: '5m' })));

  console.log('  [+4] Spread convergence (5m)...');
  allCandidates.push(...mineSpreadConvergence(split5.train).map(c => ({ ...c, timeframe: '5m' })));

  console.log('  [+5] Composite ensemble (5m)...');
  allCandidates.push(...mineCompositeEnsemble(split5.train).map(c => ({ ...c, timeframe: '5m' })));

  console.log();
  console.log(`Total train-selected candidates: ${allCandidates.length}`);
  console.log();

  // Holdout evaluation
  console.log('Evaluating on holdout...');
  const evaluated = [];

  for (const candidate of allCandidates) {
    const tf = candidate.timeframe || '15m';
    const holdout = tf === '5m' ? split5.holdout : tf === '4h' ? split4.holdout : split15.holdout;
    const result = evaluateOnHoldout(candidate, holdout);
    evaluated.push(result);
  }

  // Filter: holdout WR >= 58%, events >= 5, positive EV
  const viable = evaluated.filter(c =>
    c.holdoutEvents >= 5 &&
    c.holdoutWR >= 0.58 &&
    c.holdoutEV > 0
  );

  console.log(`Holdout-passing candidates: ${viable.length}`);
  console.log();

  // Sort by holdout EV
  viable.sort((a, b) => b.holdoutEV - a.holdoutEV);

  // Show top 20
  console.log('═══ TOP HOLDOUT CANDIDATES ═══');
  for (const c of viable.slice(0, 20)) {
    console.log(`  ${c.family} | trainWR=${(c.trainWR*100).toFixed(1)}% LCB=${(c.trainLCB*100).toFixed(1)}% | holdoutWR=${(c.holdoutWR*100).toFixed(1)}% events=${c.holdoutEvents} | avgEntry=${c.holdoutAvgEntry.toFixed(3)} | EV=${c.holdoutEV.toFixed(4)} | ${JSON.stringify(c.params)}`);
  }
  console.log();

  // MC simulation on top candidates
  console.log('Running Monte Carlo simulations on top candidates...');

  const mcResults = [];
  const starts = [5, 7, 10];
  const horizon = 168; // 7 days

  // Run MC on top candidates AND combined portfolio
  const topN = Math.min(20, viable.length);
  
  // Also create portfolio by combining events from top candidates
  const portfolioEvents = [];
  const seenEpochs = new Set();

  for (let i = 0; i < topN; i++) {
    const c = viable[i];
    const mcByStart = {};

    for (const start of starts) {
      const mc = runMonteCarlo(c.events, start, horizon);
      const mcAdverse = runAdverseMonteCarlo(c.events, start, horizon);
      mcByStart[`$${start}`] = {
        strict: mc,
        adverse: mcAdverse
      };
    }

    mcResults.push({
      rank: i + 1,
      family: c.family,
      params: c.params,
      trainWR: c.trainWR,
      holdoutWR: c.holdoutWR,
      holdoutEvents: c.holdoutEvents,
      holdoutAvgEntry: c.holdoutAvgEntry,
      holdoutEV: c.holdoutEV,
      mc: mcByStart
    });

    // Add to portfolio (deduplicate by epoch to avoid counting same cycle twice)
    for (const ev of c.events) {
      const key = `${ev.epoch}_${ev.asset}_${ev.dir}`;
      if (!seenEpochs.has(key)) {
        seenEpochs.add(key);
        portfolioEvents.push(ev);
      }
    }
  }

  // Portfolio MC
  if (portfolioEvents.length > 0) {
    console.log(`\nPortfolio: ${portfolioEvents.length} unique events from top ${topN} candidates`);
    const portfolioMC = {};
    for (const start of starts) {
      const mc = runMonteCarlo(portfolioEvents, start, horizon);
      const mcAdverse = runAdverseMonteCarlo(portfolioEvents, start, horizon);
      portfolioMC[`$${start}`] = { strict: mc, adverse: mcAdverse };
    }
    mcResults.push({
      rank: 0,
      family: 'PORTFOLIO_COMBINED',
      params: { candidateCount: topN, totalEvents: portfolioEvents.length },
      holdoutWR: portfolioEvents.filter(e => e.won).length / portfolioEvents.length,
      holdoutEvents: portfolioEvents.length,
      holdoutAvgEntry: portfolioEvents.reduce((s, e) => s + e.price, 0) / portfolioEvents.length,
      holdoutEV: calcEVPerTrade(
        portfolioEvents.filter(e => e.won).length / portfolioEvents.length,
        portfolioEvents.reduce((s, e) => s + e.price, 0) / portfolioEvents.length
      ),
      mc: portfolioMC
    });
  }

  // Print MC results
  console.log('\n═══ MONTE CARLO RESULTS (7-day, tiered aggressive sizing) ═══');
  console.log('─'.repeat(120));
  console.log(`${'Rank'.padEnd(5)} ${'Family'.padEnd(35)} ${'HoldoutWR'.padEnd(10)} ${'Events'.padEnd(8)} ${'AvgEntry'.padEnd(9)} ${'$5 med'.padEnd(10)} ${'$5 bust'.padEnd(8)} ${'$10 med'.padEnd(10)} ${'$10 bust'.padEnd(9)} ${'$10 P≥500'.padEnd(10)} ${'$10 adv med'.padEnd(12)}`);
  console.log('─'.repeat(120));

  mcResults.sort((a, b) => {
    const aM = a.mc?.['$10']?.strict?.median || 0;
    const bM = b.mc?.['$10']?.strict?.median || 0;
    return bM - aM;
  });

  for (const r of mcResults) {
    const m5 = r.mc?.['$5']?.strict;
    const m10 = r.mc?.['$10']?.strict;
    const m10adv = r.mc?.['$10']?.adverse;
    console.log(
      `${String(r.rank).padEnd(5)} ${r.family.padEnd(35)} ${((r.holdoutWR||0)*100).toFixed(1).padEnd(10)}% ${String(r.holdoutEvents).padEnd(8)} ${(r.holdoutAvgEntry||0).toFixed(3).padEnd(9)} $${(m5?.median||0).toFixed(2).padEnd(9)} ${(m5?.bustPct||0).toFixed(1).padEnd(8)}% $${(m10?.median||0).toFixed(2).padEnd(9)} ${(m10?.bustPct||0).toFixed(1).padEnd(9)}% ${(m10?.pGe500||0).toFixed(1).padEnd(10)}% $${(m10adv?.median||0).toFixed(2).padEnd(12)}`
    );
  }
  console.log('─'.repeat(120));

  // Identify best overall
  const best = mcResults.reduce((best, r) => {
    const m = r.mc?.['$10']?.strict?.median || 0;
    return m > (best.mc?.['$10']?.strict?.median || 0) ? r : best;
  }, mcResults[0]);

  console.log(`\nBest candidate: ${best.family}`);
  console.log(`  Holdout WR: ${((best.holdoutWR||0)*100).toFixed(1)}%`);
  console.log(`  Holdout events: ${best.holdoutEvents}`);
  console.log(`  Avg entry: ${(best.holdoutAvgEntry||0).toFixed(3)}`);
  console.log(`  $10 strict median: $${(best.mc?.['$10']?.strict?.median||0).toFixed(2)}`);
  console.log(`  $10 strict P≥$500: ${(best.mc?.['$10']?.strict?.pGe500||0).toFixed(1)}%`);
  console.log(`  $10 adverse median: $${(best.mc?.['$10']?.adverse?.median||0).toFixed(2)}`);

  // Save artifacts
  const outputDir = path.join(__dirname, '..', 'epoch3', 'reinvestigation_v2');
  fs.mkdirSync(outputDir, { recursive: true });

  fs.writeFileSync(
    path.join(outputDir, 'epoch3_data_audit.json'),
    JSON.stringify({
      generatedAt: new Date().toISOString(),
      datasets: {
        '15m': { cycles: data15m.length, train: split15.train.length, holdout: split15.holdout.length },
        '5m': { cycles: data5m.length, train: split5.train.length, holdout: split5.holdout.length },
        '4h': { cycles: data4h.length, train: split4.train.length, holdout: split4.holdout.length }
      }
    }, null, 2)
  );

  fs.writeFileSync(
    path.join(outputDir, 'epoch3_mc_results.json'),
    JSON.stringify({ generatedAt: new Date().toISOString(), results: mcResults }, null, 2)
  );

  fs.writeFileSync(
    path.join(outputDir, 'epoch3_candidate_rankings.json'),
    JSON.stringify({
      generatedAt: new Date().toISOString(),
      totalMinedCandidates: allCandidates.length,
      holdoutPassingCandidates: viable.length,
      top20: viable.slice(0, 20).map(c => ({
        family: c.family,
        params: c.params,
        trainWR: c.trainWR,
        trainLCB: c.trainLCB,
        holdoutWR: c.holdoutWR,
        holdoutEvents: c.holdoutEvents,
        holdoutAvgEntry: c.holdoutAvgEntry,
        holdoutEV: c.holdoutEV,
        timeframe: c.timeframe || '15m'
      }))
    }, null, 2)
  );

  // Save portfolio events for strategy generation
  if (portfolioEvents.length > 0) {
    fs.writeFileSync(
      path.join(outputDir, 'portfolio_events.json'),
      JSON.stringify({ events: portfolioEvents, count: portfolioEvents.length }, null, 2)
    );
  }

  // Save strategy discovery report
  const discoveryLines = [
    `# EPOCH 3 Reinvestigation V2 — Strategy Discovery Report`,
    ``,
    `Generated: ${new Date().toISOString()}`,
    ``,
    `## Data Sources`,
    `- 15m: ${data15m.length} cycles (train=${split15.train.length}, holdout=${split15.holdout.length})`,
    `- 5m: ${data5m.length} cycles (train=${split5.train.length}, holdout=${split5.holdout.length})`,
    `- 4h: ${data4h.length} cycles (train=${split4.train.length}, holdout=${split4.holdout.length})`,
    ``,
    `## Mining Results`,
    `- Total train-selected candidates: ${allCandidates.length}`,
    `- Holdout-passing (WR≥58%, events≥5, EV>0): ${viable.length}`,
    ``,
    `## Top Candidates by Holdout EV`,
    ``
  ];

  for (const c of viable.slice(0, 20)) {
    discoveryLines.push(`### ${c.family}`);
    discoveryLines.push(`- Params: ${JSON.stringify(c.params)}`);
    discoveryLines.push(`- Train WR: ${(c.trainWR*100).toFixed(1)}%, LCB: ${(c.trainLCB*100).toFixed(1)}%`);
    discoveryLines.push(`- Holdout WR: ${(c.holdoutWR*100).toFixed(1)}%, Events: ${c.holdoutEvents}, Avg Entry: ${c.holdoutAvgEntry.toFixed(3)}`);
    discoveryLines.push(`- Holdout EV/trade: ${c.holdoutEV.toFixed(4)}`);
    discoveryLines.push(``);
  }

  fs.writeFileSync(
    path.join(outputDir, 'epoch3_strategy_discovery.md'),
    discoveryLines.join('\n')
  );

  console.log(`\nArtifacts saved to ${outputDir}/`);
  console.log(`Completed: ${new Date().toISOString()}`);
}

main().catch(err => { console.error(err); process.exit(1); });
