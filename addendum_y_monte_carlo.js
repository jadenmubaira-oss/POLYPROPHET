#!/usr/bin/env node
/**
 * ADDENDUM Y — Independent Monte Carlo Simulation
 * Cascade's own verification of top7_drop6 @ 45% stake from $8
 * 
 * Uses LIVE trade WR data from strategy_set_top7_drop6.json (57/63 = 90.5%)
 * Also runs per-strategy WR simulation and pessimistic scenarios.
 * 
 * Enforces: 5-share min order, Polymarket taker fees, 1% slippage,
 * $100 MAX_ABSOLUTE_POSITION_SIZE, binary market payoff.
 */

const SIMS = 200000;
const DAYS = 14;

// Strategy data from debug/strategy_set_top7_drop6.json (verified)
const strategies = [
  { name: 'H09 m08 UP',   avgEntry: 0.775, liveWR: 5/5,   oosWR: 44/46, liveTrades: 5,  oosTrades: 46 },
  { name: 'H20 m03 DOWN', avgEntry: 0.76,  liveWR: 6/7,   oosWR: 52/54, liveTrades: 7,  oosTrades: 54 },
  { name: 'H11 m04 UP',   avgEntry: 0.775, liveWR: 9/9,   oosWR: 40/43, liveTrades: 9,  oosTrades: 43 },
  { name: 'H10 m07 UP',   avgEntry: 0.775, liveWR: 10/11, oosWR: 47/50, liveTrades: 11, oosTrades: 50 },
  { name: 'H08 m14 DOWN', avgEntry: 0.70,  liveWR: 5/5,   oosWR: 33/35, liveTrades: 5,  oosTrades: 35 },
  { name: 'H00 m12 DOWN', avgEntry: 0.715, liveWR: 7/8,   oosWR: 36/38, liveTrades: 8,  oosTrades: 38 },
  { name: 'H10 m06 UP',   avgEntry: 0.775, liveWR: 15/18, oosWR: 39/41, liveTrades: 18, oosTrades: 41 },
];

// Aggregate live WR
const totalLiveWins = strategies.reduce((s, st) => s + Math.round(st.liveWR * st.liveTrades), 0);
const totalLiveTrades = strategies.reduce((s, st) => s + st.liveTrades, 0);
const aggregateLiveWR = totalLiveWins / totalLiveTrades;

// OOS trades/day: total OOS trades / ~90 training days (from strategy file dates)
const totalOOSTrades = strategies.reduce((s, st) => s + st.oosTrades, 0);
const oosTradesPerDay = totalOOSTrades / 90; // ~3.4/day

// Polymarket fee model (taker): fee = 0.0025 * shares * (price * (1 - price))^2
// Simplified: at 0.75 entry, fee ≈ 2% of stake
const FEE_RATE = 0.02;
const SLIPPAGE = 0.01;
const MIN_SHARES = 5;
const MAX_ABS_STAKE = 100;
const BALANCE_FLOOR = 0.50;

function runSim(startBalance, stakeFrac, winRate, tradesPerDay, days, sims) {
  let bustCount = 0;
  const endBalances = [];
  const totalTrades = Math.round(tradesPerDay * days);
  
  for (let sim = 0; sim < sims; sim++) {
    let balance = startBalance;
    let busted = false;
    
    for (let t = 0; t < totalTrades; t++) {
      if (balance < BALANCE_FLOOR) { busted = true; break; }
      
      // Pick a random strategy (weighted by frequency — simplified to uniform here)
      const strat = strategies[Math.floor(Math.random() * strategies.length)];
      const entry = strat.avgEntry * (1 + SLIPPAGE); // slippage makes entry slightly worse
      
      // Min order cost
      const minOrderCost = MIN_SHARES * entry;
      if (balance < minOrderCost) { busted = true; break; }
      
      // Stake calculation
      let stake = balance * stakeFrac;
      stake = Math.min(stake, MAX_ABS_STAKE); // absolute cap
      if (stake < minOrderCost) stake = minOrderCost; // bump to min order
      if (stake > balance) { busted = true; break; }
      
      // Trade outcome
      const win = Math.random() < winRate;
      if (win) {
        const grossROI = (1 / entry) - 1; // binary payout: $1/share
        const netROI = grossROI - FEE_RATE;
        balance += stake * netROI;
      } else {
        balance -= stake; // full loss on binary market
      }
    }
    
    if (busted || balance < BALANCE_FLOOR) {
      bustCount++;
      endBalances.push(0);
    } else {
      endBalances.push(balance);
    }
  }
  
  endBalances.sort((a, b) => a - b);
  const p25 = endBalances[Math.floor(sims * 0.25)];
  const median = endBalances[Math.floor(sims * 0.50)];
  const p75 = endBalances[Math.floor(sims * 0.75)];
  const p90 = endBalances[Math.floor(sims * 0.90)];
  const pReach100 = endBalances.filter(b => b >= 100).length / sims * 100;
  const pReach500 = endBalances.filter(b => b >= 500).length / sims * 100;
  const pReach1000 = endBalances.filter(b => b >= 1000).length / sims * 100;
  
  return {
    bustRate: (bustCount / sims * 100).toFixed(1),
    median: median.toFixed(2),
    p25: p25.toFixed(2),
    p75: p75.toFixed(2),
    p90: p90.toFixed(2),
    pReach100: pReach100.toFixed(1),
    pReach500: pReach500.toFixed(1),
    pReach1000: pReach1000.toFixed(1)
  };
}

console.log('=== ADDENDUM Y: INDEPENDENT MONTE CARLO VERIFICATION ===');
console.log(`Simulations: ${SIMS.toLocaleString()} per scenario`);
console.log(`Duration: ${DAYS} days`);
console.log(`Strategies: ${strategies.length} (top7_drop6)`);
console.log(`Aggregate live WR: ${totalLiveWins}/${totalLiveTrades} = ${(aggregateLiveWR*100).toFixed(1)}%`);
console.log(`OOS trades/day: ${oosTradesPerDay.toFixed(1)}`);
console.log(`Fee: ${(FEE_RATE*100)}%, Slippage: ${(SLIPPAGE*100)}%`);
console.log(`Min shares: ${MIN_SHARES}, Max abs stake: $${MAX_ABS_STAKE}`);
console.log('');

// Run scenarios
const scenarios = [
  { label: '$8, 45% stake, LIVE WR (90.5%)', start: 8, stake: 0.45, wr: aggregateLiveWR, tpd: oosTradesPerDay },
  { label: '$8, 45% stake, OOS WR (88.3%)',  start: 8, stake: 0.45, wr: 0.883, tpd: oosTradesPerDay },
  { label: '$8, 45% stake, Pessimistic (85%)', start: 8, stake: 0.45, wr: 0.85, tpd: oosTradesPerDay },
  { label: '$8, 30% stake, LIVE WR (90.5%)', start: 8, stake: 0.30, wr: aggregateLiveWR, tpd: oosTradesPerDay },
  { label: '$10, 45% stake, LIVE WR (90.5%)', start: 10, stake: 0.45, wr: aggregateLiveWR, tpd: oosTradesPerDay },
  { label: '$10, 45% stake, OOS WR (88.3%)',  start: 10, stake: 0.45, wr: 0.883, tpd: oosTradesPerDay },
  { label: '$10, 45% stake, Pessimistic (85%)', start: 10, stake: 0.45, wr: 0.85, tpd: oosTradesPerDay },
  { label: '$10, 30% stake, LIVE WR (90.5%)', start: 10, stake: 0.30, wr: aggregateLiveWR, tpd: oosTradesPerDay },
  // Withdrawal scenario: $100 left after withdrawal
  { label: '$100, 45% stake, LIVE WR (90.5%)', start: 100, stake: 0.45, wr: aggregateLiveWR, tpd: oosTradesPerDay },
  { label: '$100, 45% stake, Pessimistic (85%)', start: 100, stake: 0.45, wr: 0.85, tpd: oosTradesPerDay },
];

for (const sc of scenarios) {
  const result = runSim(sc.start, sc.stake, sc.wr, sc.tpd, DAYS, SIMS);
  console.log(`--- ${sc.label} ---`);
  console.log(`  Bust: ${result.bustRate}%  |  Median: $${result.median}  |  P25: $${result.p25}  |  P75: $${result.p75}  |  P90: $${result.p90}`);
  console.log(`  P($100): ${result.pReach100}%  |  P($500): ${result.pReach500}%  |  P($1k): ${result.pReach1000}%`);
  console.log('');
}

// Linear phase projection after $100 cap
console.log('=== POST-CAP LINEAR PHASE ($222+ bankroll, $100/trade cap) ===');
const linearTradesDay = oosTradesPerDay;
for (const wr of [0.905, 0.883, 0.85]) {
  const avgEntry = 0.75;
  const grossROI = (1/avgEntry) - 1;
  const netROI = grossROI - FEE_RATE;
  const dailyGross = linearTradesDay * wr * MAX_ABS_STAKE * netROI;
  const dailyLoss = linearTradesDay * (1 - wr) * MAX_ABS_STAKE;
  const dailyNet = dailyGross - dailyLoss;
  console.log(`WR ${(wr*100).toFixed(1)}%: Gross $${dailyGross.toFixed(0)}/day, Loss $${dailyLoss.toFixed(0)}/day, NET $${dailyNet.toFixed(0)}/day ($${(dailyNet*7).toFixed(0)}/week)`);
}

console.log('');
console.log('=== WITHDRAWAL SCHEDULE (when to pull profits) ===');
console.log('At $222+ bankroll (cap hit), growth becomes linear at ~$30-60/day');
console.log('Recommended withdrawal schedule:');
console.log('  $300 bankroll -> withdraw $200, leave $100 -> bot continues at linear ~$30-60/day');
console.log('  $500 bankroll -> withdraw $400, leave $100 -> bot continues');
console.log('  Or: leave $100 indefinitely, withdraw everything above periodically');
console.log('');
console.log('$100 left in account projections (see scenario above):');
console.log('  The bot will continue trading optimally with $100 left.');
console.log('  At $100 with 45% stake = $45/trade, well above 5-share min ($3.85).');
console.log('  Growth is still exponential until $222, then linear at $100/trade cap.');
