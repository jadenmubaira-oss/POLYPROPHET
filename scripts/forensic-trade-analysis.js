/**
 * FORENSIC TRADE ANALYSIS — Complete investigation of all 54 live trades
 * 
 * Data source: LIVE API /api/trades?limit=100
 * ALL 54 executor closed trades are now present.
 */

const { calcPolymarketTakerFeeUsd, calcPolymarketTakerFeeFrac } = require('../lib/polymarket-fees');

// ALL 54 executor closed trades from live API (fetched 2026-04-20T03:08Z)
const allExecutorClosed = [
  // Phase 1: April 4-7 (RESOLVED trades — hold to resolution)
  { id: 'ETH_15m_1775315700_1775316197086',  asset:'ETH', dir:'UP',   exit:0,     pnl:-3.300,   won:false, reason:'RESOLVED_LOSS', ts:'2026-04-04T15:33:43Z' },
  { id: 'XRP_15m_1775315700_1775316181617',  asset:'XRP', dir:'UP',   exit:0,     pnl:-2.848,   won:false, reason:'RESOLVED_LOSS', ts:'2026-04-04T15:37:01Z' },
  { id: 'BTC_15m_1775322000_1775322721372',  asset:'BTC', dir:'DOWN', exit:0,     pnl:-3.900,   won:false, reason:'RESOLVED_LOSS', ts:'2026-04-04T17:17:20Z' },
  { id: 'ETH_15m_1775322000_1775322733407',  asset:'ETH', dir:'DOWN', exit:0,     pnl:-3.550,   won:false, reason:'RESOLVED_LOSS', ts:'2026-04-04T17:18:49Z' },
  { id: 'XRP_15m_1775323800_1775324560993',  asset:'XRP', dir:'DOWN', exit:1,     pnl:+0.207,   won:true,  reason:'RESOLVED_WIN',  ts:'2026-04-04T18:02:15Z' },
  { id: 'ETH_15m_1775371500_1775372221198',  asset:'ETH', dir:'DOWN', exit:1,     pnl:+0.950,   won:true,  reason:'RESOLVED_WIN',  ts:'2026-04-05T07:03:43Z' },
  { id: 'BTC_15m_1775379600_1775380481183',  asset:'BTC', dir:'DOWN', exit:1,     pnl:+0.700,   won:true,  reason:'RESOLVED_WIN',  ts:'2026-04-05T09:19:18Z' },
  { id: 'XRP_15m_1775384100_1775384721257',  asset:'XRP', dir:'UP',   exit:1,     pnl:+1.350,   won:true,  reason:'RESOLVED_WIN',  ts:'2026-04-05T10:33:21Z' },
  { id: 'ETH_15m_1775391300_1775392172183',  asset:'ETH', dir:'DOWN', exit:0.98,  pnl:0,        won:true,  reason:'PRE_RESOLUTION_EXIT', ts:'2026-04-05T12:30:02Z' },
  { id: 'BTC_15m_1775409300_1775409802028',  asset:'BTC', dir:'DOWN', exit:0,     pnl:-4.900,   won:false, reason:'RESOLVED_LOSS', ts:'2026-04-05T17:33:02Z' },
  { id: 'BTC_15m_1775409300_1775409821322',  asset:'BTC', dir:'DOWN', exit:0,     pnl:-4.900,   won:false, reason:'RESOLVED_LOSS', ts:'2026-04-05T17:33:02Z' },  // DUPLICATE ENTRY!
  { id: 'ETH_15m_1775493000_1775493600832',  asset:'ETH', dir:'UP',   exit:0.95,  pnl:+0.850,   won:true,  reason:'PRE_RESOLUTION_EXIT', ts:'2026-04-06T16:43:17Z' },
  { id: 'XRP_15m_1775493000_1775493663458',  asset:'XRP', dir:'UP',   exit:0,     pnl:-3.450,   won:false, reason:'RESOLVED_LOSS', ts:'2026-04-06T16:49:04Z' },
  { id: 'ETH_15m_1775493900_1775494122379',  asset:'ETH', dir:'UP',   exit:0,     pnl:-4.200,   won:false, reason:'RESOLVED_LOSS', ts:'2026-04-06T17:04:51Z' },
  { id: 'BTC_15m_1775493900_1775494081975',  asset:'BTC', dir:'UP',   exit:0,     pnl:-3.600,   won:false, reason:'RESOLVED_LOSS', ts:'2026-04-06T17:05:25Z' },
  { id: 'ETH_15m_1775512800_1775513254960',  asset:'ETH', dir:'DOWN', exit:0,     pnl:-3.550,   won:false, reason:'RESOLVED_LOSS', ts:'2026-04-06T22:18:51Z' },
  { id: 'ETH_15m_1775537100_1775537624223',  asset:'ETH', dir:'DOWN', exit:0,     pnl:-0.499,   won:false, reason:'RESOLVED_LOSS', ts:'2026-04-07T05:03:02Z' },
  { id: 'ETH_15m_1775544300_1775544563629',  asset:'ETH', dir:'DOWN', exit:0,     pnl:-1.850,   won:false, reason:'RESOLVED_LOSS', ts:'2026-04-07T07:04:32Z' },

  // === 10-DAY GAP: April 7 → April 17 (no trades — likely bankroll too low or bot paused) ===

  // Phase 2: April 17-20 (PRE-RESOLUTION EXIT trades)
  { id: 'ETH_15m_1776447000_1776447445531',  asset:'ETH', dir:'UP',   exit:0.97,  pnl:+0.350,   won:true,  reason:'PRE_RESOLUTION_EXIT', ts:'2026-04-17T17:43:13Z' },
  { id: 'BTC_15m_1776450600_1776451260935',  asset:'BTC', dir:'UP',   exit:0.98,  pnl:+0.050,   won:true,  reason:'PRE_RESOLUTION_EXIT', ts:'2026-04-17T18:43:13Z' },
  { id: 'BTC_15m_1776456000_1776456684397',  asset:'BTC', dir:'UP',   exit:0.963, pnl:+0.920,   won:true,  reason:'PRE_RESOLUTION_EXIT', ts:'2026-04-17T20:13:13Z' },
  { id: 'BTC_15m_1776457800_1776458221581',  asset:'BTC', dir:'DOWN', exit:0.99,  pnl:+0.200,   won:true,  reason:'PRE_RESOLUTION_EXIT', ts:'2026-04-17T20:43:15Z' },
  { id: 'BTC_15m_1776460500_1776461144015',  asset:'BTC', dir:'UP',   exit:0.96,  pnl:+0.500,   won:true,  reason:'PRE_RESOLUTION_EXIT', ts:'2026-04-17T21:29:09Z' },
  { id: 'ETH_15m_1776462300_1776462919621',  asset:'ETH', dir:'UP',   exit:0.95,  pnl:+0.750,   won:true,  reason:'PRE_RESOLUTION_EXIT', ts:'2026-04-17T21:58:32Z' },
  { id: 'ETH_15m_1776464100_1776464789867',  asset:'ETH', dir:'UP',   exit:0.99,  pnl:+0.100,   won:true,  reason:'PRE_RESOLUTION_EXIT', ts:'2026-04-17T22:28:13Z' },
  { id: 'BTC_15m_1776474000_1776474662015',  asset:'BTC', dir:'UP',   exit:0.999, pnl:+0.245,   won:true,  reason:'PRE_RESOLUTION_EXIT', ts:'2026-04-18T01:13:00Z' },
  { id: 'BTC_15m_1776475800_1776476405793',  asset:'BTC', dir:'DOWN', exit:0.95,  pnl:+0.200,   won:true,  reason:'PRE_RESOLUTION_EXIT', ts:'2026-04-18T01:44:49Z' },
  { id: 'ETH_15m_1776481200_1776481801693',  asset:'ETH', dir:'DOWN', exit:0.95,  pnl:+0.900,   won:true,  reason:'PRE_RESOLUTION_EXIT', ts:'2026-04-18T03:13:31Z' },
  { id: 'BTC_15m_1776483000_1776483603838',  asset:'BTC', dir:'DOWN', exit:0.96,  pnl:+1.050,   won:true,  reason:'PRE_RESOLUTION_EXIT', ts:'2026-04-18T03:45:15Z' },
  { id: 'SOL_15m_1776498300_1776498681022',  asset:'SOL', dir:'DOWN', exit:0.95,  pnl:+0.800,   won:true,  reason:'PRE_RESOLUTION_EXIT', ts:'2026-04-18T08:00:06Z' },
  { id: 'SOL_15m_1776502800_1776503570041',  asset:'SOL', dir:'DOWN', exit:0.95,  pnl:+0.100,   won:true,  reason:'PRE_RESOLUTION_EXIT', ts:'2026-04-18T09:13:41Z' },
  { id: 'BTC_15m_1776506400_1776506882851',  asset:'BTC', dir:'DOWN', exit:0.997, pnl:+0.140,   won:true,  reason:'PRE_RESOLUTION_EXIT', ts:'2026-04-18T10:13:30Z' },
  { id: 'XRP_15m_1776507300_1776507809785',  asset:'XRP', dir:'DOWN', exit:0.98,  pnl:+1.260,   won:true,  reason:'PRE_RESOLUTION_EXIT', ts:'2026-04-18T10:29:53Z' },
  { id: 'BTC_15m_1776508200_1776508737169',  asset:'BTC', dir:'DOWN', exit:0.96,  pnl:+0.650,   won:true,  reason:'PRE_RESOLUTION_EXIT', ts:'2026-04-18T10:44:16Z' },
  { id: 'XRP_15m_1776510900_1776511682089',  asset:'XRP', dir:'UP',   exit:0.98,  pnl:+0.050,   won:true,  reason:'PRE_RESOLUTION_EXIT', ts:'2026-04-18T11:29:27Z' },
  { id: 'XRP_15m_1776513600_1776514026209',  asset:'XRP', dir:'UP',   exit:0.997, pnl:+0.335,   won:true,  reason:'PRE_RESOLUTION_EXIT', ts:'2026-04-18T12:13:29Z' },
  { id: 'SOL_15m_1776517200_1776517904005',  asset:'SOL', dir:'DOWN', exit:0.97,  pnl:+0.600,   won:true,  reason:'PRE_RESOLUTION_EXIT', ts:'2026-04-18T13:14:50Z' },
  { id: 'SOL_15m_1776519000_1776519665841',  asset:'SOL', dir:'DOWN', exit:0.97,  pnl:-0.050,   won:false, reason:'PRE_RESOLUTION_EXIT', ts:'2026-04-18T13:43:28Z' },
  { id: 'XRP_15m_1776527100_1776527461270',  asset:'XRP', dir:'UP',   exit:0.95,  pnl:+0.700,   won:true,  reason:'PRE_RESOLUTION_EXIT', ts:'2026-04-18T15:58:27Z' },
  { id: 'BTC_15m_1776537900_1776538588866',  asset:'BTC', dir:'UP',   exit:0.96,  pnl:+1.150,   won:true,  reason:'PRE_RESOLUTION_EXIT', ts:'2026-04-18T18:58:54Z' },
  { id: 'XRP_15m_1776542400_1776542826242',  asset:'XRP', dir:'DOWN', exit:0.98,  pnl:+1.550,   won:true,  reason:'PRE_RESOLUTION_EXIT', ts:'2026-04-18T20:14:33Z' },
  { id: 'SOL_15m_1776552300_1776553005105',  asset:'SOL', dir:'UP',   exit:0.99,  pnl:+0.100,   won:true,  reason:'PRE_RESOLUTION_EXIT', ts:'2026-04-18T22:58:50Z' },
  { id: 'BTC_15m_1776576600_1776577081388',  asset:'BTC', dir:'UP',   exit:0.969, pnl:+0.145,   won:true,  reason:'PRE_RESOLUTION_EXIT', ts:'2026-04-19T05:43:20Z' },
  { id: 'BTC_15m_1776582900_1776583267259',  asset:'BTC', dir:'DOWN', exit:0.997, pnl:+0.702,   won:true,  reason:'PRE_RESOLUTION_EXIT', ts:'2026-04-19T07:28:19Z' },
  { id: 'SOL_15m_1776591000_1776591740974',  asset:'SOL', dir:'DOWN', exit:0.95,  pnl:+0.100,   won:true,  reason:'PRE_RESOLUTION_EXIT', ts:'2026-04-19T09:43:31Z' },
  { id: 'XRP_15m_1776591900_1776592440773',  asset:'XRP', dir:'UP',   exit:0.97,  pnl:+0.950,   won:true,  reason:'PRE_RESOLUTION_EXIT', ts:'2026-04-19T09:58:58Z' },
  { id: 'ETH_15m_1776599100_1776599849207',  asset:'ETH', dir:'UP',   exit:0.95,  pnl:-0.050,   won:false, reason:'PRE_RESOLUTION_EXIT', ts:'2026-04-19T11:59:03Z' },
  { id: 'XRP_15m_1776605400_1776606095373',  asset:'XRP', dir:'DOWN', exit:0.95,  pnl:-0.280,   won:false, reason:'PRE_RESOLUTION_EXIT', ts:'2026-04-19T13:44:18Z' },
  { id: 'BTC_15m_1776606300_1776606961473',  asset:'BTC', dir:'DOWN', exit:0.99,  pnl:+0.130,   won:true,  reason:'PRE_RESOLUTION_EXIT', ts:'2026-04-19T13:58:18Z' },
  { id: 'ETH_15m_1776613500_1776613861376',  asset:'ETH', dir:'UP',   exit:0.998, pnl:+1.440,   won:true,  reason:'PRE_RESOLUTION_EXIT', ts:'2026-04-19T15:59:10Z' },
  { id: 'BTC_15m_1776618900_1776619321125',  asset:'BTC', dir:'UP',   exit:0.97,  pnl:+0.450,   won:true,  reason:'PRE_RESOLUTION_EXIT', ts:'2026-04-19T17:30:24Z' },
  { id: 'SOL_15m_1776628800_1776629222575',  asset:'SOL', dir:'DOWN', exit:0.98,  pnl:+0.600,   won:true,  reason:'PRE_RESOLUTION_EXIT', ts:'2026-04-19T20:13:21Z' },
  { id: 'XRP_15m_1776629700_1776630186565',  asset:'XRP', dir:'DOWN', exit:0.99,  pnl:+0.550,   won:true,  reason:'PRE_RESOLUTION_EXIT', ts:'2026-04-19T20:30:21Z' },
  { id: 'BTC_15m_1776646800_1776647461196',  asset:'BTC', dir:'UP',   exit:0.95,  pnl:+1.450,   won:true,  reason:'PRE_RESOLUTION_EXIT', ts:'2026-04-20T01:13:52Z' },
];

// Risk manager recent trades with known entry prices and sizes (since baseline)
const recentTrades = [
  { ts: '2026-04-19T13:44:18Z', asset: 'XRP', dir: 'DOWN', entryPrice: 0.97, size: 13.58, won: false, pnl: -0.280, bankrollAfter: 17.121 },
  { ts: '2026-04-19T13:58:18Z', asset: 'BTC', dir: 'DOWN', entryPrice: 0.98, size: 12.74, won: true,  pnl:  0.130, bankrollAfter: 17.241 },
  { ts: '2026-04-19T15:59:10Z', asset: 'ETH', dir: 'UP',   entryPrice: 0.71, size:  3.55, won: true,  pnl:  1.440, bankrollAfter: 10.441 },
  { ts: '2026-04-19T17:30:24Z', asset: 'BTC', dir: 'UP',   entryPrice: 0.88, size:  4.40, won: true,  pnl:  0.450, bankrollAfter: 15.978 },
  { ts: '2026-04-19T20:13:21Z', asset: 'SOL', dir: 'DOWN', entryPrice: 0.94, size: 14.10, won: true,  pnl:  0.600, bankrollAfter: 19.728 },
  { ts: '2026-04-19T20:30:21Z', asset: 'XRP', dir: 'DOWN', entryPrice: 0.88, size:  4.40, won: true,  pnl:  0.550, bankrollAfter: 15.675 },
  { ts: '2026-04-20T01:13:52Z', asset: 'BTC', dir: 'UP',   entryPrice: 0.66, size:  3.30, won: true,  pnl:  1.450, bankrollAfter:  7.956 },
];

// ═══════════════════════════════════════════════════════════════════
console.log('='.repeat(80));
console.log('FORENSIC TRADE ANALYSIS — ALL 54 LIVE TRADES');
console.log('='.repeat(80));
console.log(`Analysis date: ${new Date().toISOString()}`);
console.log(`Data source: LIVE API /api/trades?limit=100 (fetched 2026-04-20T03:08Z)`);
console.log(`Total trades in dataset: ${allExecutorClosed.length}`);
console.log();

// ── SECTION 1: Phase breakdown ──
console.log('#'.repeat(80));
console.log('SECTION 1: TWO-PHASE BREAKDOWN');
console.log('#'.repeat(80));

const phase1 = allExecutorClosed.filter(t => new Date(t.ts) < new Date('2026-04-10'));
const phase2 = allExecutorClosed.filter(t => new Date(t.ts) >= new Date('2026-04-10'));

const p1wins = phase1.filter(t => t.won).length;
const p1losses = phase1.length - p1wins;
const p1pnl = phase1.reduce((s, t) => s + t.pnl, 0);
const p2wins = phase2.filter(t => t.won).length;
const p2losses = phase2.length - p2wins;
const p2pnl = phase2.reduce((s, t) => s + t.pnl, 0);

console.log(`\nPHASE 1: April 4-7 (Hold-to-resolution era)`);
console.log(`  Trades: ${phase1.length} | ${p1wins}W / ${p1losses}L (${(p1wins/phase1.length*100).toFixed(1)}% WR)`);
console.log(`  Net PnL: $${p1pnl.toFixed(2)}`);
console.log(`  RESOLVED_LOSS count: ${phase1.filter(t => t.reason === 'RESOLVED_LOSS').length}`);
console.log(`  Avg loss size: $${(phase1.filter(t=>!t.won).reduce((s,t)=>s+Math.abs(t.pnl),0) / p1losses).toFixed(2)}`);
console.log(`  Avg win size:  $${p1wins > 0 ? (phase1.filter(t=>t.won).reduce((s,t)=>s+t.pnl,0) / p1wins).toFixed(2) : 'N/A'}`);

console.log(`\nPHASE 2: April 17-20 (Pre-resolution exit era)`);
console.log(`  Trades: ${phase2.length} | ${p2wins}W / ${p2losses}L (${(p2wins/phase2.length*100).toFixed(1)}% WR)`);
console.log(`  Net PnL: $${p2pnl.toFixed(2)}`);
console.log(`  Avg win size:  $${p2wins > 0 ? (phase2.filter(t=>t.won).reduce((s,t)=>s+t.pnl,0) / p2wins).toFixed(2) : 'N/A'}`);
console.log(`  Avg loss size: $${p2losses > 0 ? (phase2.filter(t=>!t.won).reduce((s,t)=>s+Math.abs(t.pnl),0) / p2losses).toFixed(2) : 'N/A'}`);

console.log(`\n  10-DAY GAP: April 7-17 — NO TRADES (bot likely bankroll-busted or paused)`);
console.log(`\n  GRAND TOTAL PnL (all 54 trades): $${(p1pnl + p2pnl).toFixed(2)}`);

// ── SECTION 2: Phase 1 catastrophe detail ──
console.log('\n' + '#'.repeat(80));
console.log('SECTION 2: PHASE 1 CATASTROPHE — TRADE-BY-TRADE');
console.log('#'.repeat(80));

// Detect multi-entry cycles
const cycleMap = {};
for (const t of phase1) {
  const cycle = t.id.split('_')[2]; // market epoch
  if (!cycleMap[cycle]) cycleMap[cycle] = [];
  cycleMap[cycle].push(t);
}

let runningPnl = 0;
console.log('\n  #  | Timestamp          | Asset Dir   | Reason          | PnL       | Running  | Notes');
console.log('  ' + '-'.repeat(95));
phase1.forEach((t, i) => {
  runningPnl += t.pnl;
  const cycle = t.id.split('_')[2];
  const multiEntry = cycleMap[cycle].length > 1;
  const isDupe = phase1.filter(x => x.id.split('_')[2] === cycle && x.asset === t.asset && x.dir === t.dir).length > 1;
  let notes = '';
  if (isDupe) notes = 'DUPLICATE ENTRY!';
  else if (multiEntry) notes = `MULTI-ASSET CYCLE (${cycleMap[cycle].length} entries)`;
  
  console.log(`  ${String(i+1).padStart(2)} | ${t.ts.slice(0,19)} | ${t.asset.padEnd(3)} ${t.dir.padEnd(4)}  | ${t.reason.padEnd(15)} | ${(t.pnl >= 0 ? '+' : '') + t.pnl.toFixed(2).padStart(7)} | ${runningPnl.toFixed(2).padStart(7)} | ${notes}`);
});

console.log(`\n  CRITICAL FINDINGS:`);
console.log(`  - 4 trades lost on first cycle alone: -$${Math.abs(phase1.slice(0,4).reduce((s,t)=>s+t.pnl,0)).toFixed(2)}`);
console.log(`  - DUPLICATE BTC entry (same market, same direction): 2x -$4.90 = -$9.80`);
console.log(`  - Multiple simultaneous positions per cycle depleted all capital`);
console.log(`  - 12 RESOLVED_LOSS trades = total position wipeout (exit price $0)`);

// ── SECTION 3: Phase 2 performance ──
console.log('\n' + '#'.repeat(80));
console.log('SECTION 3: PHASE 2 PERFORMANCE (Pre-resolution exits)');
console.log('#'.repeat(80));

let p2running = 0;
console.log('\n  #  | Timestamp          | Asset Dir   | Exit  | PnL       | Running');
console.log('  ' + '-'.repeat(75));
phase2.forEach((t, i) => {
  p2running += t.pnl;
  console.log(`  ${String(i+1).padStart(2)} | ${t.ts.slice(0,19)} | ${t.asset.padEnd(3)} ${t.dir.padEnd(4)}  | ${t.exit.toFixed(3)} | ${(t.pnl >= 0 ? '+' : '') + t.pnl.toFixed(2).padStart(7)} | ${p2running.toFixed(2).padStart(7)}`);
});

// ── SECTION 4: Total PnL reconciliation ──
console.log('\n' + '#'.repeat(80));
console.log('SECTION 4: BALANCE RECONCILIATION');
console.log('#'.repeat(80));

const totalPnl = allExecutorClosed.reduce((s, t) => s + t.pnl, 0);
const currentBal = 9.21;
const impliedStart = currentBal - totalPnl;

console.log(`\n  All-time net PnL:           $${totalPnl.toFixed(2)}`);
console.log(`  Current balance:            $${currentBal.toFixed(2)}`);
console.log(`  Implied starting capital:   $${impliedStart.toFixed(2)}`);
console.log(`  (Starting + PnL = Current:  $${impliedStart.toFixed(2)} + $${totalPnl.toFixed(2)} = $${(impliedStart + totalPnl).toFixed(2)})`);
console.log(`\n  Phase 1 destroyed:          $${Math.abs(p1pnl).toFixed(2)}`);
console.log(`  Phase 2 recovered:          $${p2pnl.toFixed(2)}`);
console.log(`  Net hole remaining:         $${(p1pnl + p2pnl).toFixed(2)}`);

// ── SECTION 5: Win/Loss asymmetry ──
console.log('\n' + '#'.repeat(80));
console.log('SECTION 5: WIN vs LOSS ASYMMETRY');
console.log('#'.repeat(80));

const resolvedLosses = allExecutorClosed.filter(t => t.reason === 'RESOLVED_LOSS');
const preResLosses = allExecutorClosed.filter(t => !t.won && t.reason === 'PRE_RESOLUTION_EXIT');
const resolvedWins = allExecutorClosed.filter(t => t.reason === 'RESOLVED_WIN');
const preResWins = allExecutorClosed.filter(t => t.won && t.reason === 'PRE_RESOLUTION_EXIT');

console.log(`\n  RESOLVED_LOSS:  ${resolvedLosses.length} trades, total: $${resolvedLosses.reduce((s,t)=>s+t.pnl,0).toFixed(2)}, avg: $${(resolvedLosses.reduce((s,t)=>s+t.pnl,0)/resolvedLosses.length).toFixed(2)}`);
console.log(`  RESOLVED_WIN:   ${resolvedWins.length} trades, total: $${resolvedWins.reduce((s,t)=>s+t.pnl,0).toFixed(2)}, avg: $${(resolvedWins.reduce((s,t)=>s+t.pnl,0)/resolvedWins.length).toFixed(2)}`);
console.log(`  PRE_RES wins:   ${preResWins.length} trades, total: $${preResWins.reduce((s,t)=>s+t.pnl,0).toFixed(2)}, avg: $${(preResWins.reduce((s,t)=>s+t.pnl,0)/preResWins.length).toFixed(2)}`);
console.log(`  PRE_RES losses: ${preResLosses.length} trades, total: $${preResLosses.reduce((s,t)=>s+t.pnl,0).toFixed(2)}, avg: $${preResLosses.length > 0 ? (preResLosses.reduce((s,t)=>s+t.pnl,0)/preResLosses.length).toFixed(2) : 'N/A'}`);

console.log(`\n  KEY INSIGHT: Average RESOLVED_LOSS is $${Math.abs(resolvedLosses.reduce((s,t)=>s+t.pnl,0)/resolvedLosses.length).toFixed(2)} per trade.`);
console.log(`  Average pre-res WIN is only +$${(preResWins.reduce((s,t)=>s+t.pnl,0)/preResWins.length).toFixed(2)} per trade.`);
console.log(`  It takes ${Math.ceil(Math.abs(resolvedLosses.reduce((s,t)=>s+t.pnl,0)/resolvedLosses.length) / (preResWins.reduce((s,t)=>s+t.pnl,0)/preResWins.length))} consecutive pre-res wins to recover ONE resolved loss.`);

// ── SECTION 6: Bankroll trajectory since baseline ──
console.log('\n' + '#'.repeat(80));
console.log('SECTION 6: RECENT BANKROLL TRAJECTORY (since baseline)');
console.log('#'.repeat(80));

console.log('\n  Baseline: $17.282\n');
for (const t of recentTrades) {
  const shares = Math.round(t.size / t.entryPrice);
  const entryFee = calcPolymarketTakerFeeUsd(shares, t.entryPrice);
  const roi = (t.pnl / t.size * 100).toFixed(1);
  const marker = t.won ? 'WIN ' : 'LOSS';
  console.log(`  ${marker} ${t.ts.slice(5,16)} | ${t.asset} ${t.dir.padEnd(4)} @ ${t.entryPrice} | $${t.size.toFixed(2).padStart(5)} | PnL: ${t.pnl >= 0 ? '+' : ''}$${t.pnl.toFixed(2)} (${roi}%) | fee: ~$${entryFee.toFixed(3)} | bal: $${t.bankrollAfter.toFixed(2)}`);
}
const recentPnl = recentTrades.reduce((s,t) => s + t.pnl, 0);
console.log(`\n  Current balance: $${currentBal}`);
console.log(`  Reported PnL since baseline: +$${recentPnl.toFixed(2)}`);
console.log(`  Actual balance change:       $${(currentBal - 17.282).toFixed(2)}`);
console.log(`  DISCREPANCY:                 $${(currentBal - 17.282 - recentPnl).toFixed(2)}`);
console.log(`  (Discrepancy = baseline was set too high while capital was in open positions)`);

// ── SECTION 7: Capital efficiency ──
console.log('\n' + '#'.repeat(80));
console.log('SECTION 7: CAPITAL EFFICIENCY (last 7 trades with known sizes)');
console.log('#'.repeat(80));

const totalSize = recentTrades.reduce((s, t) => s + t.size, 0);
const highSizeRecent = recentTrades.filter(t => t.entryPrice >= 0.90);
const lowSizeRecent = recentTrades.filter(t => t.entryPrice < 0.90);
const highCapital = highSizeRecent.reduce((s, t) => s + t.size, 0);
const lowCapital = lowSizeRecent.reduce((s, t) => s + t.size, 0);
const highPnlRecent = highSizeRecent.reduce((s, t) => s + t.pnl, 0);
const lowPnlRecent = lowSizeRecent.reduce((s, t) => s + t.pnl, 0);

console.log(`\n  High-price (>=0.90): $${highCapital.toFixed(2)} deployed (${(highCapital/totalSize*100).toFixed(0)}%) -> PnL: $${highPnlRecent.toFixed(2)} -> ROI: ${highCapital > 0 ? (highPnlRecent/highCapital*100).toFixed(2) : 0}%`);
console.log(`  Low-price  (<0.90):  $${lowCapital.toFixed(2)} deployed (${(lowCapital/totalSize*100).toFixed(0)}%) -> PnL: $${lowPnlRecent.toFixed(2)} -> ROI: ${lowCapital > 0 ? (lowPnlRecent/lowCapital*100).toFixed(2) : 0}%`);
console.log(`\n  CAPITAL EFFICIENCY GAP: Low-price trades return ${lowCapital > 0 && highCapital > 0 ? ((lowPnlRecent/lowCapital)/(highPnlRecent/highCapital)).toFixed(0) : '?'}x more per dollar deployed`);

// ── SECTION 8: Root cause and recommendations ──
console.log('\n' + '#'.repeat(80));
console.log('SECTION 8: ROOT CAUSE DIAGNOSIS & RECOMMENDATIONS');
console.log('#'.repeat(80));

console.log(`
=== ROOT CAUSES (ordered by impact) ===

1. CATASTROPHIC PHASE 1 LOSSES (-$${Math.abs(p1pnl).toFixed(2)} in 18 trades)
   - Bot entered MULTIPLE positions simultaneously in same 15m cycle
   - Cycle 1775315700: ETH UP + XRP UP both lost = -$6.15
   - Cycle 1775322000: BTC DOWN + ETH DOWN both lost = -$7.45
   - Cycle 1775409300: DUPLICATE BTC DOWN entry = -$9.80 (same direction twice!)
   - Cycle 1775493000/1775493900: 3 more RESOLVED_LOSS = -$11.25
   - These 12 resolved losses at $0 exit = TOTAL position wipeout each time

2. HOLD-TO-RESOLUTION = BINARY RUIN
   - RESOLVED_LOSS exit price is $0 = you lose 100% of position
   - Avg resolved loss: $${Math.abs(resolvedLosses.reduce((s,t)=>s+t.pnl,0)/resolvedLosses.length).toFixed(2)} per trade
   - This is why Phase 2 (pre-res exits) performs FAR better:
     losses are capped at ~$0.05-0.28 instead of $3-5

3. MULTI-POSITION CORRELATED RISK
   - Entering multiple assets in the same cycle = correlated bets
   - If the 15m direction call is wrong, ALL positions lose simultaneously
   - With SF=0.80 across 2-4 positions, one bad cycle can destroy 50%+ of capital

4. STAKE FRACTION 0.80 IS TOO AGGRESSIVE
   - At $9 bankroll: $7.20 per trade
   - One resolved loss = $7.20 gone = only $1.80 left
   - Even with pre-res exits, SF=0.80 means excessive drawdown on any loss

=== WHAT IS ACTUALLY WORKING ===

Phase 2 (pre-res exits) is MUCH better:
  - 36 trades, 33W/3L = ${(p2wins/phase2.length*100).toFixed(1)}% WR
  - Net PnL: +$${p2pnl.toFixed(2)}
  - Pre-res exits cap losses to $0.05-0.28 instead of $3-5
  - But growth is slow: avg win only +$${(phase2.filter(t=>t.won).reduce((s,t)=>s+t.pnl,0)/p2wins).toFixed(2)}

=== IMMEDIATE ACTIONS REQUIRED ===

1. REDUCE STAKE FRACTION: SF=0.80 -> SF=0.25
   - Limits any single loss to ~$2.30 (25% of $9) instead of $7.20
   - Survivability > growth at micro bankroll

2. ENFORCE 1 TRADE PER CYCLE (already set, verify it's working)
   - MAX_GLOBAL_TRADES_PER_CYCLE=1 is in render.yaml
   - But Phase 1 had multi-entries — was this setting active then?

3. ENFORCE NET EDGE GATE: Set ENFORCE_NET_EDGE_GATE=true
   - Currently false — bot enters even negative EV trades
   - Critical at high entry prices where edge after fees is near zero

4. LOWER PRICE CAP: Set highPriceEdgeFloorPrice to 0.90
   - Currently 0.95 — still allows terrible asymmetry trades
   - At 0.90: max win ROI = 11.1%, break-even WR ~90.7%
   - At 0.95: max win ROI = 5.3%, break-even WR ~95.2%

5. KEEP PRE-RESOLUTION EXITS ENABLED
   - Phase 1 (no pre-res): 12 resolved losses, avg -$${Math.abs(resolvedLosses.reduce((s,t)=>s+t.pnl,0)/resolvedLosses.length).toFixed(2)}
   - Phase 2 (with pre-res): 3 losses, avg -$${preResLosses.length > 0 ? Math.abs(preResLosses.reduce((s,t)=>s+t.pnl,0)/preResLosses.length).toFixed(2) : 'N/A'}
   - Pre-res exits are the ONLY reason the bot survived Phase 2

=== HONEST GROWTH PROJECTION (Phase 2 parameters) ===
`);

// Honest projection using Phase 2 data only
const p2avgPnl = p2pnl / phase2.length;
const p2wr = p2wins / phase2.length;
const p2avgWin = phase2.filter(t=>t.won).reduce((s,t)=>s+t.pnl,0) / p2wins;
const p2avgLoss = p2losses > 0 ? phase2.filter(t=>!t.won).reduce((s,t)=>s+t.pnl,0) / p2losses : 0;
const p2tradesPerDay = phase2.length / 3; // 36 trades over ~3 days

console.log(`  Phase 2 stats:`);
console.log(`    WR: ${(p2wr*100).toFixed(1)}%, Avg win: +$${p2avgWin.toFixed(3)}, Avg loss: $${p2avgLoss.toFixed(3)}`);
console.log(`    EV per trade: $${p2avgPnl.toFixed(4)}`);
console.log(`    Trades/day: ~${p2tradesPerDay.toFixed(0)}`);
console.log(`    Daily expected PnL: ~$${(p2avgPnl * p2tradesPerDay).toFixed(2)}`);
console.log();

// If avg position is ~$7 (SF=0.8 on $9 bankroll) and avg PnL is $0.52:
const avgPositionSize = 7; // approximate
const avgRoiPerTrade = p2avgPnl / avgPositionSize;
const dailyGrowthRate = avgRoiPerTrade * p2tradesPerDay;

console.log(`  Compound growth projection from $${currentBal}:`);
for (const days of [1, 7, 14, 30, 60, 90]) {
  const projected = currentBal * Math.pow(1 + dailyGrowthRate, days);
  console.log(`    ${String(days).padStart(2)}d: $${projected.toFixed(2)}`);
}

console.log(`\n  WARNING: These projections assume Phase 2 performance continues.`);
console.log(`  Phase 1 showed how quickly things can collapse.`);
console.log(`  With SF=0.80, one bad day could repeat Phase 1 catastrophe.`);

console.log('\n' + '='.repeat(80));
console.log('END OF FORENSIC ANALYSIS');
console.log('='.repeat(80));
