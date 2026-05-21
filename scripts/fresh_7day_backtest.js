/**
 * Fresh 7-day backtest for ALL 15m UP/DOWN hours & directions.
 * Pulls live Polymarket closed-cycle data via Gamma API.
 * Tests the deployed 7-signal portfolio and scans all hours for best regime-stable pattern.
 *
 * Run: node scripts/fresh_7day_backtest.js
 */

'use strict';
const https = require('https');
const fs = require('fs');

const ACTIVE_STRATEGY_PATH = process.env.STRATEGY_SET_15M_PATH || 'strategies/strategy_set_15m_crossval_7signal_v2.json';

const ASSETS = ['btc', 'eth', 'sol', 'xrp', 'bnb', 'doge'];
const DAYS_BACK = 7;
const CYCLE_SECONDS = 900; // 15m

// Polymarket slugs use unix epoch of cycle start
function cycleSlug(asset, epoch) {
  return `${asset}-updown-15m-${epoch}`;
}

function httpGet(url) {
  return new Promise((resolve) => {
    const req = https.get(url, { timeout: 12000 }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        try { resolve(JSON.parse(chunks.join(''))); }
        catch { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

// Fetch market by slug using the path endpoint (works for historical slugs)
async function fetchMarketBySlug(slug) {
  const url = `https://gamma-api.polymarket.com/markets/slug/${encodeURIComponent(slug)}`;
  const data = await httpGet(url);
  if (!data) return null;
  if (Array.isArray(data)) return data.length > 0 ? data[0] : null;
  if (typeof data === 'object' && data.id) return data;
  return null;
}

// Parse market outcome
function parseOutcome(market) {
  if (!market) return null;
  if (!market.closed) return null; // not resolved yet
  try {
    const prices = JSON.parse(market.outcomePrices || '[]');
    if (prices.length < 2) return null;
    const upPrice = Number(prices[0]);
    const downPrice = Number(prices[1]);
    if (upPrice > 0.95) return 'UP';
    if (downPrice > 0.95) return 'DOWN';
    return null; // ambiguous/partial
  } catch { return null; }
}

// Get intra-cycle price snapshot at specific minute (0 or 1)
// Gamma API has prices_history or we approximate from market data
function getIntracyclePrice(market, minute) {
  // We use outcomePrices as final but we want entry price at minute 0 or 1
  // The actual mid-cycle price isn't stored in gamma API - we use lastTradePrice as proxy
  if (!market) return null;
  const ask = Number(market.bestAsk || 0);
  const bid = Number(market.bestBid || 0);
  return ask > 0 ? ask : (bid > 0 ? bid : null);
}

function loadActiveStrategySet() {
  try {
    const parsed = JSON.parse(fs.readFileSync(ACTIVE_STRATEGY_PATH, 'utf8'));
    const strategies = Array.isArray(parsed.strategies) ? parsed.strategies : [];
    return {
      path: ACTIVE_STRATEGY_PATH,
      strategies: strategies.map((strategy) => ({
        name: strategy.name || `H${strategy.utcHour}_M${strategy.utcMinute}_${strategy.direction}`,
        utcHour: Number(strategy.utcHour),
        utcMinute: Number(strategy.utcMinute),
        direction: String(strategy.direction || '').toUpperCase(),
        pWinEstimate: Number(strategy.pWinEstimate || 0),
      })).filter((strategy) => Number.isFinite(strategy.utcHour)
        && Number.isFinite(strategy.utcMinute)
        && ['UP', 'DOWN'].includes(strategy.direction)),
    };
  } catch (err) {
    return { path: ACTIVE_STRATEGY_PATH, strategies: [], error: err.message };
  }
}

async function main() {
  const now = Math.floor(Date.now() / 1000);
  const nowCycleStart = now - (now % CYCLE_SECONDS);
  
  // Go back 7 days + 1 buffer
  const totalCycles = Math.ceil((DAYS_BACK * 24 * 3600) / CYCLE_SECONDS) + 4; // ~673 cycles
  
  console.log(`\n=== FRESH 7-DAY BACKTEST ===`);
  console.log(`Fetching ${totalCycles} cycles × ${ASSETS.length} assets = up to ${totalCycles * ASSETS.length} markets`);
  console.log(`Time range: ${new Date((nowCycleStart - totalCycles * CYCLE_SECONDS) * 1000).toISOString()} → now\n`);

  // Collect all resolved cycles
  const records = []; // { epoch, utcHour, utcMinute, asset, outcome, resolvedUp, resolvedDown }
  
  let fetched = 0;
  let resolved = 0;
  let errors = 0;

  // Fetch in batches to avoid rate limiting
  const BATCH_SIZE = 20;
  
  for (let i = 2; i <= totalCycles; i++) {
    const epoch = nowCycleStart - (i * CYCLE_SECONDS);
    const dt = new Date(epoch * 1000);
    const utcHour = dt.getUTCHours();
    const utcMinute = dt.getUTCMinutes();
    
    // Only fetch if this is a :00 or :15 or :30 or :45 minute mark (15m cycles start on these)
    // All epochs are already on 15m boundaries since we use epoch % 900 == 0

    const promises = ASSETS.map(asset => fetchMarketBySlug(cycleSlug(asset, epoch)));
    const results = await Promise.all(promises);
    
    for (let ai = 0; ai < ASSETS.length; ai++) {
      const market = results[ai];
      const asset = ASSETS[ai].toUpperCase();
      fetched++;
      
      const outcome = parseOutcome(market);
      if (outcome) {
        resolved++;
        records.push({
          epoch,
          iso: dt.toISOString(),
          utcHour,
          utcMinute,
          asset,
          outcome,
          slug: cycleSlug(ASSETS[ai], epoch),
          volume: market?.volumeNum || 0
        });
      } else if (market === null) {
        errors++;
      }
    }
    
    // Progress every 50 cycles
    if (i % 50 === 0) {
      process.stdout.write(`  Cycles fetched: ${i}/${totalCycles}, resolved records: ${resolved}\r`);
    }
    
    // Small delay to avoid hammering API
    if (i % BATCH_SIZE === 0) {
      await new Promise(r => setTimeout(r, 300));
    }
  }
  
  console.log(`\n\nFetch complete: ${fetched} queries, ${resolved} resolved, ${errors} API misses\n`);
  
  if (records.length < 10) {
    console.log('ERROR: Not enough data to backtest. Check API connectivity.');
    return;
  }
  
  // Save raw data
  const rawPath = 'debug/7day_backtest_raw.json';
  fs.mkdirSync('debug', { recursive: true });
  fs.writeFileSync(rawPath, JSON.stringify(records, null, 2));
  console.log(`Raw data saved: ${rawPath} (${records.length} records)`);
  
  // ===========================
  // STRATEGY BACKTEST
  // ===========================
  
  // Test every hour × direction combination
  const hourResults = {};
  
  for (let h = 0; h < 24; h++) {
    for (const dir of ['UP', 'DOWN']) {
      const key = `H${h}_${dir}`;
      // M0 = entry at minute 0 of the hour (cycle starts at :00)
      // M1 = entry at minute 1 of the hour (cycle starts at :15)
      // Actually for 15m: each cycle is 15min, so:
      //   minute 0 = cycle starting at HH:00
      //   minute 1 = cycle starting at HH:15
      //   minute 2 = cycle starting at HH:30
      //   minute 3 = cycle starting at HH:45
      // The strategy uses utcMinute from the cycle epoch, which is 0, 15, 30, or 45
      
      for (const entryMin of [0, 15, 30, 45]) {
        const k2 = `H${h}_M${entryMin}_${dir}`;
        const matching = records.filter(r => r.utcHour === h && r.utcMinute === entryMin);
        const wins = matching.filter(r => r.outcome === dir).length;
        const total = matching.length;
        
        if (total >= 3) { // minimum sample
          hourResults[k2] = {
            utcHour: h,
            utcMinute: entryMin,
            direction: dir,
            wins,
            total,
            winRate: wins / total,
            // Simple Kelly stake at assumed market price of 0.55 (typical UP price)
            // Kelly = (p*(1/price-1) - (1-p)) / (1/price-1) at price=0.55 → payout=0.818
            // We'll compute for multiple price bands
          };
        }
      }
    }
  }
  
  // Sort by win rate
  const sorted = Object.entries(hourResults)
    .filter(([, v]) => v.total >= 5)
    .sort((a, b) => b[1].winRate - a[1].winRate);
  
  console.log('\n=== ALL HOUR/DIRECTION WIN RATES (7-day, min 5 samples) ===');
  console.log('Key                  | WR%   | W/T  | Direction');
  console.log('---------------------|-------|------|----------');
  sorted.slice(0, 30).forEach(([key, v]) => {
    console.log(`${key.padEnd(20)} | ${(v.winRate*100).toFixed(1).padStart(5)}% | ${v.wins}/${v.total} | ${v.direction}`);
  });
  
  // ==========================
  // TEST DEPLOYED STRATEGY SET
  // ==========================
  const activeStrategySet = loadActiveStrategySet();
  console.log(`\n=== DEPLOYED STRATEGY SET: ${activeStrategySet.path} ===`);
  if (activeStrategySet.error) {
    console.log(`ERROR: could not load active strategy file: ${activeStrategySet.error}`);
  }

  const activeStrategyResults = activeStrategySet.strategies.map((strategy) => {
    const matching = records.filter(r => r.utcHour === strategy.utcHour && r.utcMinute === strategy.utcMinute);
    const wins = matching.filter(r => r.outcome === strategy.direction).length;
    const total = matching.length;
    const winRate = total > 0 ? wins / total : null;
    console.log(`${strategy.name.padEnd(30)} H${String(strategy.utcHour).padStart(2, '0')}:M${String(strategy.utcMinute).padStart(2, '0')} ${strategy.direction.padEnd(4)} ${wins}W/${total}T = ${winRate !== null ? (winRate * 100).toFixed(1) : 'N/A'}% WR | pWinEstimate=${strategy.pWinEstimate || 'N/A'}`);
    return { ...strategy, wins, total, winRate };
  });

  const allCurrentTrades = activeStrategySet.strategies.flatMap((strategy) => records
    .filter(r => r.utcHour === strategy.utcHour && r.utcMinute === strategy.utcMinute)
    .map(r => ({ ...r, strategy: strategy.name, stratDir: strategy.direction, win: r.outcome === strategy.direction })));
  const comboWins = allCurrentTrades.filter(r => r.win).length;
  console.log(`\nCombined:     ${comboWins}W / ${allCurrentTrades.length}T = ${allCurrentTrades.length > 0 ? (comboWins/allCurrentTrades.length*100).toFixed(1) : 'N/A'}% WR`);
  
  // ==========================
  // FULL MONTE CARLO SIMULATION ON BEST STRATEGY
  // Uses deterministic RNG for reproducibility + enforces 5-share minimum
  // ==========================
  const MIN_ORDER_SHARES = 5;
  function createRng(seed) {
    let state = (seed >>> 0);
    return () => { state = (1664525 * state + 1013904223) >>> 0; return state / 0x100000000; };
  }
  function runMonteCarlo(winRate, tradeCount, startBalance, stakeF, priceEntry, simCount = 10000, seed = 42) {
    const payout = (1 / priceEntry) - 1; // net profit per $ staked if win
    const minOrderCost = MIN_ORDER_SHARES * priceEntry;
    const rng = createRng(seed);
    const outcomes = [];
    for (let s = 0; s < simCount; s++) {
      let b = startBalance;
      for (let t = 0; t < tradeCount; t++) {
        let stake = b * stakeF;
        if (stake < minOrderCost) stake = minOrderCost; // enforce 5-share minimum
        if (stake > b) { b = 0; break; } // bust: can't afford minimum order
        if (rng() < winRate) b += stake * payout;
        else b -= stake;
      }
      outcomes.push(b);
    }
    outcomes.sort((a, b) => a - b);
    const bustCount = outcomes.filter(x => x === 0).length;
    return {
      median: outcomes[Math.floor(simCount / 2)],
      p10: outcomes[Math.floor(simCount * 0.1)],
      p25: outcomes[Math.floor(simCount * 0.25)],
      p75: outcomes[Math.floor(simCount * 0.75)],
      p90: outcomes[Math.floor(simCount * 0.9)],
      bustRate: bustCount / simCount
    };
  }
  
  // Use current live bankroll as start (prefer fresh API, fall back to $10.59)
  const mcStartBalance = 10.591971;
  
  console.log(`\n=== MONTE CARLO SIMULATIONS (10k runs, start=$${mcStartBalance}, 49 trades, 5-share min) ===`);
  console.log('NOTE: Use node scripts/final_mc_simulation.js for full 100k run authoritative MC');
  
  // Current combo WR
  const comboWR = allCurrentTrades.length > 0 ? comboWins / allCurrentTrades.length : 0.68;
  const tradePeriodCycles = 49; // 7 signals × 7 days
  
  // Test different stake fractions
  for (const sf of [0.35, 0.45, 0.60]) {
    const mc = runMonteCarlo(comboWR, tradePeriodCycles, mcStartBalance, sf, 0.50, 10000, 42);
    console.log(`  SF=${(sf*100).toFixed(0)}% WR=${(comboWR*100).toFixed(1)}%: median=$${mc.median.toFixed(0)} p10=$${mc.p10.toFixed(0)} p90=$${mc.p90.toFixed(0)} bust=${(mc.bustRate*100).toFixed(1)}%`);
  }
  
  // ==========================
  // FIND BEST SINGLE RULE
  // ==========================
  console.log('\n=== TOP 10 SINGLE RULES (7-day WR >= 60%) ===');
  const topRules = sorted.filter(([, v]) => v.winRate >= 0.60 && v.total >= 5).slice(0, 10);
  topRules.forEach(([key, v]) => {
    const mc = runMonteCarlo(v.winRate, 100, 7.93, 1.0, 0.55, 5000);
    console.log(`  ${key.padEnd(20)} WR=${(v.winRate*100).toFixed(1)}% ${v.wins}/${v.total} | 100%-stake median=$${mc.median.toFixed(0)} bust=${(mc.bustRate*100).toFixed(1)}%`);
  });
  
  // ==========================
  // DAILY BREAKDOWN FOR DEPLOYED STRATEGY SET
  // ==========================
  console.log('\n=== DAILY BREAKDOWN (DEPLOYED STRATEGY SET) ===');
  const byDate = {};
  for (const trade of allCurrentTrades) {
    const date = trade.iso.split('T')[0];
    if (!byDate[date]) byDate[date] = { w: 0, l: 0 };
    if (trade.win) byDate[date].w++; else byDate[date].l++;
  }
  Object.entries(byDate).sort((a,b) => a[0].localeCompare(b[0])).forEach(([date, r]) => {
    const wr = r.w + r.l > 0 ? (r.w / (r.w + r.l) * 100).toFixed(0) : 0;
    console.log(`  ${date}: ${r.w}W/${r.l}L = ${wr}%`);
  });
  
  // Save report
  const report = {
    generatedAt: new Date().toISOString(),
    dataRange: {
      from: new Date((nowCycleStart - totalCycles * CYCLE_SECONDS) * 1000).toISOString(),
      to: new Date(nowCycleStart * 1000).toISOString(),
      totalRecords: records.length
    },
    activeStrategy: {
      path: activeStrategySet.path,
      error: activeStrategySet.error || null,
      signals: activeStrategyResults,
      combo: { wins: comboWins, total: allCurrentTrades.length, wr: allCurrentTrades.length > 0 ? comboWins/allCurrentTrades.length : null }
    },
    topRules: sorted.slice(0, 30).map(([key, v]) => ({ key, ...v })),
    dailyBreakdown: byDate
  };
  
  const reportPath = 'debug/7day_backtest_report.json';
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
  console.log(`\nReport saved: ${reportPath}`);
  console.log('\n=== DONE ===\n');
}

main().catch(e => { console.error('FATAL:', e); process.exit(1); });
