#!/usr/bin/env node
const { calcPolymarketTakerFeeUsd } = require('../lib/polymarket-fees');
const START = 12.892746;
const MIN = 5;
const P = 0.97;
const PW = 0.9869158878504672;
const FILL = 0.72;
const RATE = 12.738095238095237;
const CAP = 8;
const DEPTH = 40;
const SAFE = 1.05;
const RUNS = Number(process.env.KELLY_SWEEP_RUNS || '5000');

function rng(s) {
  let t = s >>> 0;
  return () => {
    t += 0x6D2B79F5;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}
function pct(a, q) {
  const s = a.slice().sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.max(0, Math.floor(q * s.length)))];
}
function choose(b, kf, cap) {
  const odd = (1 / P) - 1;
  const fk = Math.max(0, (odd * PW - (1 - PW)) / odd);
  const raw = b * Math.min(fk * kf, kf, cap);
  const minS = MIN * P;
  const mxDep = Math.floor(DEPTH / SAFE) * P;
  const stake = Math.min(Math.max(raw, minS), b, mxDep);
  const sh = Math.floor(stake / P + 1e-9);
  if (sh < MIN) return { blk: true };
  const adj = sh * P;
  const fee = calcPolymarketTakerFeeUsd(sh, P);
  if (adj + fee > b + 1e-9) return { blk: true };
  return { stake: adj, sh, fee };
}
function sim(hours, kf, cap, hc) {
  const rand = rng(20260512 + hours * 7 + Math.floor(kf * 1e4) + Math.floor(hc * 100));
  const eff = Math.min(RATE * FILL * hc, CAP);
  const att = Math.floor(hours * eff);
  const end = [];
  const bust = [];
  for (let r = 0; r < RUNS; r++) {
    let b = START;
    for (let i = 0; i < att; i++) {
      const o = choose(b, kf, cap);
      if (o.blk) break;
      b -= o.stake + o.fee;
      if (rand() < PW) b += o.sh;
      if (b < MIN * P) break;
    }
    end.push(b);
    bust.push(b < MIN * P ? 1 : 0);
  }
  return {
    med: pct(end, 0.5), p10: pct(end, 0.10), p25: pct(end, 0.25),
    p75: pct(end, 0.75), p90: pct(end, 0.90), p99: pct(end, 0.99),
    max: Math.max(...end), bust: bust.reduce((a, b) => a + b, 0) / RUNS,
  };
}
const rows = [];
for (const k of [0.45, 0.50, 0.55, 0.60, 0.65, 0.70, 0.75, 0.85, 1.00]) {
  for (const hours of [24, 48, 168]) {
    const f = sim(hours, k, k, 1);
    const h = sim(hours, k, k, 0.45);
    rows.push({ k, h: hours, hc: 1.0, med: +f.med.toFixed(1), p10: +f.p10.toFixed(1), p25: +f.p25.toFixed(1), p75: +f.p75.toFixed(1), p90: +f.p90.toFixed(1), max: +f.max.toFixed(0), bust: +(f.bust * 100).toFixed(2) });
    rows.push({ k, h: hours, hc: 0.45, med: +h.med.toFixed(1), p10: +h.p10.toFixed(1), p25: +h.p25.toFixed(1), p75: +h.p75.toFixed(1), p90: +h.p90.toFixed(1), max: +h.max.toFixed(0), bust: +(h.bust * 100).toFixed(2) });
  }
}
console.table(rows);
