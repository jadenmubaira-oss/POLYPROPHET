#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const IC_PATH = path.join(ROOT, 'data', 'intracycle-price-data.json');

function loadCycles() {
  const raw = JSON.parse(fs.readFileSync(IC_PATH, 'utf8'));
  return Array.isArray(raw) ? raw : raw.cycles || [];
}

function breakevenWinProb(entryPrice, takerFee) {
  const p = Number(entryPrice);
  if (!(p > 0) || p >= 1) return null;
  return p / (p + (1 - p) * (1 - takerFee));
}

function wilsonLCB(wins, n, z) {
  const w = Number(wins);
  const N = Number(n);
  if (!(N > 0)) return null;
  const phat = w / N;
  const z2 = z * z;
  const den = 1 + z2 / N;
  const center = phat + z2 / (2 * N);
  const adj = z * Math.sqrt((phat * (1 - phat) + z2 / (4 * N)) / N);
  return (center - adj) / den;
}

function key(hour, minute, dir, minP, maxP) {
  return String(minP) + '-' + String(maxP) + '|H' + String(hour).padStart(2, '0') + '|m' + String(minute).padStart(2, '0') + '|' + dir;
}

function build() {
  const cycles = loadCycles();
  const takerFee = 0.0315;
  const z = 1.96;
  const oosStartEpoch = Math.floor(new Date('2026-04-08T00:00:00Z').getTime() / 1000);

  const bands = [
    [0.55, 0.82],
    [0.60, 0.78],
    [0.65, 0.80],
    [0.65, 0.88],
  ];

  const minMatches = 30;
  const minWinRate = 0.9;
  const minDayCount = 5;

  const stats = new Map();

  for (const c of cycles) {
    if (!c || Number(c.epoch || 0) < oosStartEpoch) continue;
    const resolution = String(c.resolution || '').toUpperCase();
    if (resolution !== 'UP' && resolution !== 'DOWN') continue;

    const epoch = Number(c.epoch);
    const hour = new Date(epoch * 1000).getUTCHours();
    const day = new Date(epoch * 1000).toISOString().slice(0, 10);

    for (let minute = 0; minute < 15; minute++) {
      const yes = Number(c.minutePricesYes?.[String(minute)]?.last);
      const no = Number(c.minutePricesNo?.[String(minute)]?.last);

      for (const b of bands) {
        const minP = b[0];
        const maxP = b[1];

        if (yes > 0 && yes < 1 && yes >= minP && yes <= maxP) {
          const k = key(hour, minute, 'UP', minP, maxP);
          const o = stats.get(k) || { hour, minute, dir: 'UP', minP, maxP, n: 0, w: 0, sum: 0, days: new Set() };
          o.n++;
          if (resolution === 'UP') o.w++;
          o.sum += yes;
          o.days.add(day);
          stats.set(k, o);
        }

        if (no > 0 && no < 1 && no >= minP && no <= maxP) {
          const k = key(hour, minute, 'DOWN', minP, maxP);
          const o = stats.get(k) || { hour, minute, dir: 'DOWN', minP, maxP, n: 0, w: 0, sum: 0, days: new Set() };
          o.n++;
          if (resolution === 'DOWN') o.w++;
          o.sum += no;
          o.days.add(day);
          stats.set(k, o);
        }
      }
    }
  }

  const rows = [...stats.values()]
    .map((r) => {
      const wr = r.n > 0 ? r.w / r.n : 0;
      const avg = r.n > 0 ? r.sum / r.n : 0;
      const be = breakevenWinProb(avg, takerFee) || 0;
      const edge = wr - be;
      const lcb = wilsonLCB(r.w, r.n, z) || 0.5;
      return {
        hour: r.hour,
        minute: r.minute,
        direction: r.dir,
        priceMin: r.minP,
        priceMax: r.maxP,
        matches: r.n,
        wins: r.w,
        winRate: wr,
        avgEntry: avg,
        edge,
        dayCount: r.days.size,
        pWinEstimate: lcb,
      };
    })
    .filter((r) => r.matches >= minMatches && r.winRate >= minWinRate && r.dayCount >= minDayCount)
    .sort((a, b) => (b.edge - a.edge) || (b.matches - a.matches));

  const strategies = rows.map((r) => {
    return {
      name:
        'APR21_H' +
        String(r.hour).padStart(2, '0') +
        '_m' +
        String(r.minute).padStart(2, '0') +
        '_' +
        r.direction +
        '_[' +
        String(r.priceMin) +
        '-' +
        String(r.priceMax) +
        ']',
      utcHour: r.hour,
      entryMinute: r.minute,
      direction: r.direction,
      priceMin: r.priceMin,
      priceMax: r.priceMax,
      pWinEstimate: Number(r.pWinEstimate.toFixed(4)),
      stats: {
        matches: r.matches,
        wins: r.wins,
        winRate: Number(r.winRate.toFixed(4)),
        dayCount: r.dayCount,
        avgEntry: Number(r.avgEntry.toFixed(4)),
        edge: Number(r.edge.toFixed(6)),
      },
    };
  });

  const out = {
    generated: new Date().toISOString(),
    source: 'intracycle-price-data.json',
    oosStartEpoch,
    criteria: { minMatches, minWinRate, minDayCount, bands, z },
    strategies,
  };

  const outPath = path.join(ROOT, 'strategies', 'strategy_set_15m_apr21_edge32.json');
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2));

  process.stdout.write(
    'WROTE ' +
      path.relative(ROOT, outPath) +
      ' strategies=' +
      strategies.length +
      ' from cycles=' +
      cycles.length +
      '\n',
  );

  for (const s of strategies.slice(0, 10)) {
    process.stdout.write(s.name + ' matches=' + s.stats.matches + ' wr=' + (s.stats.winRate * 100).toFixed(1) + '% lcb=' + s.pWinEstimate + ' avg=' + s.stats.avgEntry + '\n');
  }
}

build();
