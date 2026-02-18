const fs = require('fs');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..');
const summaryPath = path.join(repoRoot, 'debug', 'fill_band_investigation', 'summary.json');
const outRoot = path.join(repoRoot, 'debug', 'fill_band_investigation');

const summary = JSON.parse(fs.readFileSync(summaryPath, 'utf8'));

function toFixedOrEmpty(v, d = 6) {
  return Number.isFinite(v) ? Number(v.toFixed(d)) : '';
}

function csv(rows, cols) {
  const esc = (v) => {
    if (v === null || v === undefined) return '';
    const s = String(v);
    if (s.includes(',') || s.includes('"') || s.includes('\n')) return `"${s.replace(/"/g, '""')}"`;
    return s;
  };
  return [cols.join(',')].concat(rows.map(r => cols.map(c => esc(r[c])).join(','))).join('\n');
}

const keyRows = [];
const targetRows = [];
const stressRows = [];

for (const b of summary.bands) {
  const bandLabel = `${Math.round(b.bandMin * 100)}-${Math.round(b.bandMax * 100)}`;

  const s20 = b.scenarios.find(s => s.startingBalance === 10 && s.stakeFraction === 0.2);
  const s30 = b.scenarios.find(s => s.startingBalance === 10 && s.stakeFraction === 0.3);
  const s40 = b.scenarios.find(s => s.startingBalance === 10 && s.stakeFraction === 0.4);

  keyRows.push({
    band: bandLabel,
    tradeCount: b.tradeCount,
    wins: b.wins,
    losses: b.losses,
    winRate: toFixedOrEmpty(b.winRate),
    lcb95: toFixedOrEmpty(b.wilsonLcb95),
    avgEntryC: toFixedOrEmpty((b.entryStats?.mean || 0) * 100, 2),
    medianEntryC: toFixedOrEmpty((b.entryStats?.median || 0) * 100, 2),

    s10f20_executed: s20?.executed || 0,
    s10f20_blocked: s20?.blocked || 0,
    s10f20_endBal: toFixedOrEmpty(s20?.endingBalance),
    s10f20_roi: toFixedOrEmpty(s20?.roi),
    s10f20_maxDD: toFixedOrEmpty(s20?.maxDrawdownPct),

    s10f30_executed: s30?.executed || 0,
    s10f30_blocked: s30?.blocked || 0,
    s10f30_endBal: toFixedOrEmpty(s30?.endingBalance),
    s10f30_roi: toFixedOrEmpty(s30?.roi),
    s10f30_maxDD: toFixedOrEmpty(s30?.maxDrawdownPct),

    s10f40_executed: s40?.executed || 0,
    s10f40_blocked: s40?.blocked || 0,
    s10f40_endBal: toFixedOrEmpty(s40?.endingBalance),
    s10f40_roi: toFixedOrEmpty(s40?.roi),
    s10f40_maxDD: toFixedOrEmpty(s40?.maxDrawdownPct),

    firstBustFillCents_s10f30: b.firstBustFillCents,
    firstMinOrderFillCents_s10f30: b.firstMinOrderBlockFillCents,
  });

  for (const scenario of [s20, s30, s40]) {
    if (!scenario) continue;
    for (const targetKey of ['x2', 'x3', 'x5', 'x10', 'x20', 'x50', 'x100']) {
      const target = scenario.targets?.[targetKey] || null;
      targetRows.push({
        band: bandLabel,
        stakeFraction: scenario.stakeFraction,
        target: targetKey,
        hit: target ? 'yes' : 'no',
        tradesToHit: target?.tradesToHit ?? '',
        daysToHit: toFixedOrEmpty(target?.daysToHit, 4),
        timestamp: target?.timestamp ?? '',
      });
    }
  }

  for (const row of b.stress30s10 || []) {
    stressRows.push({
      band: bandLabel,
      fillBumpCents: row.fillBumpCents,
      executed: row.executed,
      blocked: row.blocked,
      wins: row.wins,
      losses: row.losses,
      winRate: toFixedOrEmpty(row.winRate),
      endingBalance: toFixedOrEmpty(row.endingBalance),
      roi: toFixedOrEmpty(row.roi),
      maxDrawdownPct: toFixedOrEmpty(row.maxDrawdownPct),
      maxLossStreak: row.maxLossStreak,
    });
  }
}

fs.writeFileSync(path.join(outRoot, 'key_table.csv'), csv(keyRows, [
  'band',
  'tradeCount',
  'wins',
  'losses',
  'winRate',
  'lcb95',
  'avgEntryC',
  'medianEntryC',
  's10f20_executed',
  's10f20_blocked',
  's10f20_endBal',
  's10f20_roi',
  's10f20_maxDD',
  's10f30_executed',
  's10f30_blocked',
  's10f30_endBal',
  's10f30_roi',
  's10f30_maxDD',
  's10f40_executed',
  's10f40_blocked',
  's10f40_endBal',
  's10f40_roi',
  's10f40_maxDD',
  'firstBustFillCents_s10f30',
  'firstMinOrderFillCents_s10f30',
]));

fs.writeFileSync(path.join(outRoot, 'targets_table.csv'), csv(targetRows, [
  'band',
  'stakeFraction',
  'target',
  'hit',
  'tradesToHit',
  'daysToHit',
  'timestamp',
]));

fs.writeFileSync(path.join(outRoot, 'stress_table.csv'), csv(stressRows, [
  'band',
  'fillBumpCents',
  'executed',
  'blocked',
  'wins',
  'losses',
  'winRate',
  'endingBalance',
  'roi',
  'maxDrawdownPct',
  'maxLossStreak',
]));

console.log('Wrote key_table.csv, targets_table.csv, stress_table.csv');
