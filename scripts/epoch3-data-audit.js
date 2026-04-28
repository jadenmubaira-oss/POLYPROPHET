const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const OUT_DIR = path.join(ROOT, process.env.EPOCH3_OUT_DIR || path.join('epoch3', 'final'));

function readJson(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(ROOT, relativePath), 'utf8'));
}

function iso(epoch) {
  const value = Number(epoch);
  return Number.isFinite(value) ? new Date(value * 1000).toISOString() : null;
}

function finiteValues(values) {
  return values.map(Number).filter(Number.isFinite);
}

function median(values) {
  const sorted = finiteValues(values).sort((a, b) => a - b);
  if (!sorted.length) return null;
  return sorted[Math.floor(sorted.length / 2)];
}

function quantile(values, p) {
  const sorted = finiteValues(values).sort((a, b) => a - b);
  if (!sorted.length) return null;
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
}

function minMax(values) {
  let min = null;
  let max = null;
  for (const value of values) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) continue;
    min = min === null ? parsed : Math.min(min, parsed);
    max = max === null ? parsed : Math.max(max, parsed);
  }
  return { min, max };
}

function priceStatsForCycle(cycle) {
  const rows = [];
  for (const side of ['minutePricesYes', 'minutePricesNo']) {
    for (const snapshot of Object.values(cycle?.[side] || {})) {
      const price = Number(snapshot?.last);
      if (Number.isFinite(price)) rows.push(price);
    }
  }
  return rows;
}

function summarizeDataset(label, relativePath, cycleSeconds, freshnessSeconds) {
  const fullPath = path.join(ROOT, relativePath);
  const stat = fs.statSync(fullPath);
  const raw = readJson(relativePath);
  const cycles = Array.isArray(raw) ? raw : raw.cycles || raw.data || [];
  const valid = cycles.filter((cycle) => Number.isFinite(Number(cycle.epoch)));
  const epochs = valid.map((cycle) => Number(cycle.epoch));
  const uniqueEpochs = [...new Set(epochs)].sort((a, b) => a - b);
  const minEpoch = Math.min(...epochs);
  const maxEpoch = Math.max(...epochs);
  const expectedSlots = Number.isFinite(minEpoch) && Number.isFinite(maxEpoch)
    ? Math.floor((maxEpoch - minEpoch) / cycleSeconds) + 1
    : 0;
  const missingEpochSlots = Math.max(0, expectedSlots - uniqueEpochs.length);
  const byAsset = {};
  const resolutions = { UP: 0, DOWN: 0, OTHER: 0 };
  let exactHalfPrices = 0;
  let totalPrices = 0;
  const prices = [];
  const minuteCoverage = [];
  for (const cycle of valid) {
    const asset = String(cycle.asset || 'UNKNOWN').toUpperCase();
    if (!byAsset[asset]) byAsset[asset] = { total: 0, up: 0, down: 0, other: 0, minEpoch: null, maxEpoch: null };
    byAsset[asset].total += 1;
    byAsset[asset].minEpoch = byAsset[asset].minEpoch === null ? Number(cycle.epoch) : Math.min(byAsset[asset].minEpoch, Number(cycle.epoch));
    byAsset[asset].maxEpoch = byAsset[asset].maxEpoch === null ? Number(cycle.epoch) : Math.max(byAsset[asset].maxEpoch, Number(cycle.epoch));
    const resolution = String(cycle.resolution || '').toUpperCase();
    if (resolution === 'UP') {
      resolutions.UP += 1;
      byAsset[asset].up += 1;
    } else if (resolution === 'DOWN') {
      resolutions.DOWN += 1;
      byAsset[asset].down += 1;
    } else {
      resolutions.OTHER += 1;
      byAsset[asset].other += 1;
    }
    const cyclePrices = priceStatsForCycle(cycle);
    totalPrices += cyclePrices.length;
    exactHalfPrices += cyclePrices.filter((price) => price === 0.5).length;
    prices.push(...cyclePrices);
    const yesCoverage = Object.keys(cycle.minutePricesYes || {}).length;
    const noCoverage = Object.keys(cycle.minutePricesNo || {}).length;
    minuteCoverage.push(Math.max(yesCoverage, noCoverage));
  }
  const nowSec = Math.floor(Date.now() / 1000);
  const stale = !Number.isFinite(maxEpoch) || nowSec - maxEpoch > freshnessSeconds;
  const priceRange = minMax(prices);
  const assetSummaries = Object.fromEntries(Object.entries(byAsset).map(([asset, row]) => [asset, {
    ...row,
    start: iso(row.minEpoch),
    end: iso(row.maxEpoch),
    upRate: row.total ? row.up / row.total : 0,
    downRate: row.total ? row.down / row.total : 0,
  }]));
  return {
    label,
    relativePath,
    exists: fs.existsSync(fullPath),
    fileModifiedAt: stat.mtime.toISOString(),
    generatedAt: raw.generatedAt || null,
    timeframe: raw.timeframe || label,
    cycleSeconds,
    totalCycles: valid.length,
    startEpoch: Number.isFinite(minEpoch) ? minEpoch : null,
    endEpoch: Number.isFinite(maxEpoch) ? maxEpoch : null,
    start: iso(minEpoch),
    end: iso(maxEpoch),
    ageSeconds: Number.isFinite(maxEpoch) ? nowSec - maxEpoch : null,
    stale,
    freshnessThresholdSeconds: freshnessSeconds,
    uniqueEpochs: uniqueEpochs.length,
    expectedEpochSlots: expectedSlots,
    missingEpochSlots,
    assets: assetSummaries,
    resolutions,
    upRate: valid.length ? resolutions.UP / valid.length : 0,
    downRate: valid.length ? resolutions.DOWN / valid.length : 0,
    priceSanity: {
      totalPrices,
      exactHalfPrices,
      exactHalfFraction: totalPrices ? exactHalfPrices / totalPrices : 0,
      min: priceRange.min,
      p10: quantile(prices, 0.1),
      median: median(prices),
      p90: quantile(prices, 0.9),
      max: priceRange.max,
    },
    minuteCoverage: {
      median: median(minuteCoverage),
      p10: quantile(minuteCoverage, 0.1),
      p90: quantile(minuteCoverage, 0.9),
    },
  };
}

function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const datasets = [
    summarizeDataset('15m', 'data/intracycle-price-data.json', 900, 24 * 60 * 60),
    summarizeDataset('5m', 'data/intracycle-price-data-5m.json', 300, 24 * 60 * 60),
    summarizeDataset('4h', 'data/intracycle-price-data-4h.json', 14400, 48 * 60 * 60),
  ];
  const audit = {
    generatedAt: new Date().toISOString(),
    datasets,
    allFresh: datasets.every((dataset) => !dataset.stale),
    primaryBlockers: datasets.filter((dataset) => dataset.stale).map((dataset) => `${dataset.label}:stale`),
  };
  const outPath = path.join(OUT_DIR, 'epoch3_data_audit.json');
  fs.writeFileSync(outPath, JSON.stringify(audit, null, 2));
  process.stdout.write(`EPOCH3_DATA_AUDIT ${path.relative(ROOT, outPath)} allFresh=${audit.allFresh}\n`);
  for (const dataset of datasets) {
    process.stdout.write(`${dataset.label}: cycles=${dataset.totalCycles} ${dataset.start || 'n/a'} -> ${dataset.end || 'n/a'} stale=${dataset.stale} halfFrac=${dataset.priceSanity.exactHalfFraction.toFixed(4)}\n`);
  }
}

main();
