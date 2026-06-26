// v36W (2026-06-26): AUTHORITATIVE re-audit of the live snipe ledger from PRIMARY data.
// Answers, recomputed this pass (RULE ZERO), and labelled OBSERVED:
//   (1) per-timeframe LIVE W/L split + net P&L  -> proves the ONLY live loss is 1h, 15m = 0L live
//   (2) the FULL live loss record(s)            -> asset/tf/side/ask/shares/bps/z/tLeft/pnl
//   (3) live entry-ask distribution             -> the "cheaper-but-gated" share (< 0.99)
//   (4) OBSERVED per-UTC-day live fills          -> fills/day, NOT a backtest projection
//   (5) unparseable/corrupt + truncation check   -> storage-crash integrity check
// Dedup key = tf:asset:epoch:side (later reconciliation rows update the same outcome).
// Usage: node scripts/v36w-ledger-audit.js [path-to-ledger.jsonl]
const fs = require('fs');
const path = require('path');
const LED = process.argv[2] || path.join(__dirname, '..', 'debug', 'live_ledger.jsonl');
const raw = fs.readFileSync(LED, 'utf8');
const endsClean = /\}\s*$/.test(raw.trimEnd()); // last non-blank char should close a JSON object
const lines = raw.split(/\r?\n/);

let total = 0, blank = 0, corrupt = 0, rejected = 0;
const corruptSamples = [];
const liveByKey = new Map();
const paperByKey = new Map();

function acc(map, o) {
  const key = `${o.tf}:${o.asset}:${o.epoch}:${o.side}`;
  let r = map.get(key);
  if (!r) { r = { tf: o.tf, asset: o.asset, epoch: o.epoch, side: o.side, win: null, pnl: null, ask: null, shares: null, bps: null, z: null, tLeft: null }; map.set(key, r); }
  const sig = o.sig || o.signal || {};
  if (typeof o.win === 'boolean') r.win = o.win;
  if (r.pnl == null && typeof o.pnl === 'number') r.pnl = o.pnl;
  if (r.ask == null && typeof o.ask === 'number') r.ask = o.ask;
  if (r.shares == null && typeof o.shares === 'number') r.shares = o.shares;
  const b = (typeof o.bps === 'number') ? o.bps : sig.bps;
  const z = (typeof o.z === 'number') ? o.z : sig.z;
  const t = (typeof o.tLeft === 'number') ? o.tLeft : sig.tLeft;
  if (r.bps == null && typeof b === 'number') r.bps = b;
  if (r.z == null && typeof z === 'number') r.z = z;
  if (r.tLeft == null && typeof t === 'number') r.tLeft = t;
}

for (const ln of lines) {
  if (ln.trim() === '') { blank++; continue; }
  total++;
  let o; try { o = JSON.parse(ln); } catch { corrupt++; if (corruptSamples.length < 3) corruptSamples.push(ln.slice(0, 80)); continue; }
  if (o.type === 'LIVE_ORDER_REJECTED') { rejected++; continue; }
  if (o.live === true) acc(liveByKey, o);
  else if (o.live === false || o.type === 'SETTLE') acc(paperByKey, o);
}

const live = [...liveByKey.values()].filter(r => r.win !== null);
const paper = [...paperByKey.values()].filter(r => r.win !== null);

console.log(`Ledger: ${LED}`);
console.log(`Integrity: nonblank=${total} | blank=${blank} | corrupt(JSON-parse-fail)=${corrupt} | endsCleanly=${endsClean} | LIVE_ORDER_REJECTED=${rejected}`);
if (corrupt) console.log(`  corrupt samples: ${JSON.stringify(corruptSamples)}`);
console.log(`Settled (deduped, win!=null): LIVE=${live.length} | PAPER=${paper.length}`);

const lw = live.filter(r => r.win).length, ll = live.length - lw;
console.log(`\nLIVE total: ${lw}W / ${ll}L  (win-rate ${live.length ? (lw / live.length * 100).toFixed(2) : '0'}%)`);
for (const tf of ['15m', '1h', '5m']) {
  const r = live.filter(x => x.tf === tf); if (!r.length) continue;
  const w = r.filter(x => x.win).length, l = r.length - w;
  const wp = r.filter(x => typeof x.pnl === 'number');
  const net = wp.reduce((s, x) => s + x.pnl, 0);
  const winPnl = wp.filter(x => x.win).reduce((s, x) => s + x.pnl, 0);
  const lossPnl = wp.filter(x => !x.win).reduce((s, x) => s + x.pnl, 0);
  console.log(`  ${tf}: ${w}W/${l}L | NET=$${net.toFixed(4)} | winPnl=$${winPnl.toFixed(4)} | lossPnl=$${lossPnl.toFixed(4)}`);
}

const losses = live.filter(r => !r.win);
console.log(`\nLIVE LOSS RECORD(S): ${losses.length}`);
for (const L of losses) console.log(`  ${L.asset} ${L.tf} side=${L.side} ask=${L.ask} shares=${L.shares} bps=${L.bps} z=${L.z} tLeft=${L.tLeft} pnl=$${L.pnl}`);

const dist = {};
for (const r of live) { const a = (typeof r.ask === 'number') ? r.ask.toFixed(2) : '?'; dist[a] = (dist[a] || 0) + 1; }
const cheaper = live.filter(r => typeof r.ask === 'number' && r.ask < 0.99).length;
console.log(`\nLIVE entry-ask distribution:`);
Object.keys(dist).sort().forEach(a => console.log(`  ${a}: ${dist[a]}`));
console.log(`  cheaper-than-0.99 (gated): ${cheaper}/${live.length} = ${live.length ? (cheaper / live.length * 100).toFixed(1) : '0'}%`);

const byDay = {};
for (const r of live) {
  if (!Number.isFinite(r.epoch)) continue;
  const d = new Date(r.epoch * 1000).toISOString().slice(0, 10);
  byDay[d] = byDay[d] || { n: 0, tf: {} };
  byDay[d].n++; byDay[d].tf[r.tf] = (byDay[d].tf[r.tf] || 0) + 1;
}
console.log(`\nOBSERVED live fills per UTC day (epoch-dated):`);
Object.keys(byDay).sort().forEach(d => {
  const t = byDay[d].tf;
  console.log(`  ${d}: ${byDay[d].n}  (${Object.keys(t).sort().map(k => k + ':' + t[k]).join(', ')})`);
});
