const fs = require('fs');
const path = require('path');

const { simulateBankrollPath } = require('./hybrid_replay_backtest.js');

const repoRoot = path.resolve(__dirname, '..');

function readArgValue(prefix) {
  const arg = process.argv.find(a => String(a).startsWith(prefix));
  return arg ? String(arg).slice(prefix.length) : null;
}

function parseBoolArg(name, defaultValue) {
  const raw = readArgValue(`--${name}=`);
  if (raw === null) return defaultValue;
  const v = String(raw).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(v)) return true;
  if (['0', 'false', 'no', 'off'].includes(v)) return false;
  return defaultValue;
}

function parseFloatArg(name, defaultValue) {
  const raw = readArgValue(`--${name}=`);
  if (raw === null) return defaultValue;
  const n = Number(raw);
  return Number.isFinite(n) ? n : defaultValue;
}

function parseIntArg(name, defaultValue) {
  const raw = readArgValue(`--${name}=`);
  if (raw === null) return defaultValue;
  const n = Number.parseInt(String(raw), 10);
  return Number.isFinite(n) ? n : defaultValue;
}

function getTradeEpochSec(t) {
  const a = Number(t?.cycleStartEpochSec);
  if (Number.isFinite(a) && a > 0) return Math.floor(a);
  const b = Number(t?.cycleStartEpoch);
  if (Number.isFinite(b) && b > 0) return Math.floor(b);
  const c = Number(t?.issuedAt);
  if (Number.isFinite(c) && c > 0) return Math.floor(c / 1000);
  const d = Number(t?.resolvedAt);
  if (Number.isFinite(d) && d > 0) return Math.floor(d / 1000);
  return 0;
}

function toCsv(rows, cols) {
  const esc = (v) => {
    if (v === null || v === undefined) return '';
    const s = String(v);
    if (s.includes(',') || s.includes('"') || s.includes('\n')) return `"${s.replace(/"/g, '""')}"`;
    return s;
  };
  return [cols.join(',')].concat(rows.map(r => cols.map(c => esc(r[c])).join(','))).join('\n');
}

function parseNumberListArg(name) {
  const raw = readArgValue(`--${name}=`);
  if (raw === null) return null;
  const parts = String(raw)
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
  const nums = parts
    .map(v => Number(v))
    .filter(n => Number.isFinite(n));
  return nums.length ? nums : null;
}

function renderMarkdownTable(rows, cols, formatters = {}) {
  const fmt = (col, v) => {
    const f = formatters[col];
    return f ? f(v) : (v === null || v === undefined ? '' : String(v));
  };

  const header = `| ${cols.join(' | ')} |`;
  const sep = `| ${cols.map(() => '---').join(' | ')} |`;
  const body = rows.map(r => `| ${cols.map(c => fmt(c, r[c])).join(' | ')} |`).join('\n');
  return [header, sep, body].join('\n');
}

function main() {
  const ledgerPath = readArgValue('--ledger=') || path.join(repoRoot, 'debug', 'final_set_scan', 'top7_drop6', 'hybrid_replay_executed_ledger.json');
  const outDir = readArgValue('--outDir=') || path.join(repoRoot, 'debug');

  const runName = readArgValue('--runName=') || path.basename(path.dirname(ledgerPath));

  const startingBalance = Math.max(0.01, parseFloatArg('startingBalance', 10));
  const minOrderShares = Math.max(1, parseIntArg('minOrderShares', 1));
  const minOddsEntry = Math.max(0.01, Math.min(0.99, parseFloatArg('minOddsEntry', 0.35)));

  const minOrderCostOverrideRaw = parseFloatArg('minOrderCostOverride', NaN);
  const minOrderCostOverride = Number.isFinite(minOrderCostOverrideRaw) ? Math.max(0, minOrderCostOverrideRaw) : null;

  const maxAbsoluteStake = Math.max(0.01, parseFloatArg('maxAbsoluteStake', 1_000_000_000));
  const tieredMaxAbsoluteStake = parseBoolArg('tieredMaxAbsoluteStake', false);
  const maxExposure = Math.max(0.01, Math.min(0.99, parseFloatArg('maxExposure', 0.60)));

  const simulateHalts = parseBoolArg('simulateHalts', false);
  const kellyEnabled = parseBoolArg('kellyEnabled', false);
  const adaptiveMode = parseBoolArg('adaptiveMode', false);
  const autoProfileEnabled = parseBoolArg('autoProfileEnabled', false);
  const allowDynamicStake = parseBoolArg('allowDynamicStake', false);
  const riskEnvelopeEnabled = parseBoolArg('riskEnvelopeEnabled', false);
  const streakSizingEnabled = parseBoolArg('streakSizingEnabled', false);
  const inheritLedgerConfig = parseBoolArg('inheritLedgerConfig', false);

  fs.mkdirSync(outDir, { recursive: true });

  if (!fs.existsSync(ledgerPath)) {
    throw new Error(`Missing ledger: ${ledgerPath}`);
  }

  const ledger = JSON.parse(fs.readFileSync(ledgerPath, 'utf8'));
  const allTrades = Array.isArray(ledger?.trades) ? ledger.trades : [];

  const tradeEpochs = allTrades.map(getTradeEpochSec).filter(n => Number.isFinite(n) && n > 0);
  const endEpochSec = tradeEpochs.length ? Math.max(...tradeEpochs) : Math.floor(Date.now() / 1000);

  const windows = [
    { key: '1w', seconds: 7 * 86400 },
    { key: '2w', seconds: 14 * 86400 },
    { key: '3w', seconds: 21 * 86400 },
    { key: '1m', seconds: 30 * 86400 },
    { key: 'full', seconds: null },
  ];

  const stakeFractions = (parseNumberListArg('stakeFractions') || [0.2, 0.3, 0.4])
    .map(n => Math.max(0.01, Math.min(0.50, n)));
  const fillBumpCentsList = Array.from({ length: 11 }, (_, i) => i);
  const slippagePctList = [0, 0.01, 0.02];

  const baseConfigFromLedger = inheritLedgerConfig
    && ledger?.meta?.bankrollSimulation?.config
    && typeof ledger.meta.bankrollSimulation.config === 'object'
    ? ledger.meta.bankrollSimulation.config
    : {};

  const baseOptions = {
    ...baseConfigFromLedger,
    startingBalance,
    maxExposure,
    maxAbsoluteStake,
    tieredMaxAbsoluteStake,
    minOrderShares,
    minOddsEntry,
    minOrderCostOverride,
    simulateHalts,
    kellyEnabled,
    adaptiveMode,
    autoProfileEnabled,
    allowDynamicStake,
    riskEnvelopeEnabled,
    streakSizingEnabled,
    winBonusEnabled: false,
  };

  const matrixRows = [];
  const worstRows = [];
  const scenariosRows = [];

  for (const w of windows) {
    const startEpochSec = Number.isFinite(w.seconds) && w.seconds !== null
      ? (endEpochSec - w.seconds)
      : null;

    const windowTrades = startEpochSec === null
      ? allTrades
      : allTrades.filter(t => getTradeEpochSec(t) >= startEpochSec);

    for (const stakeFraction of stakeFractions) {
      let worst = null;
      let baseRow = null;
      let maxRow = null;

      for (const slippagePct of slippagePctList) {
        for (const fillBumpCents of fillBumpCentsList) {
          const bump = fillBumpCents / 100;
          const adjustedTrades = windowTrades.map(t => {
            const ep = Number(t?.entryPrice);
            const adj = Number.isFinite(ep) ? Math.min(0.99, ep + bump) : ep;
            return { ...t, entryPrice: adj };
          });

          const sim = simulateBankrollPath(adjustedTrades, {
            ...baseOptions,
            stakeFraction,
            slippagePct,
          });

          const s = sim?.stats || {};
          const roiPct = Number.isFinite(Number(s.roi)) ? Number(s.roi) * 100 : null;
          const maxDdPct = Number.isFinite(Number(s.maxDrawdownPct)) ? Number(s.maxDrawdownPct) * 100 : null;
          const winRatePct = Number.isFinite(Number(s.winRate)) ? Number(s.winRate) * 100 : null;

          const row = {
            window: w.key,
            stakeFraction,
            fillBumpCents,
            slippagePct,
            endingBalance: Number.isFinite(Number(s.endingBalance)) ? Number(s.endingBalance) : null,
            roiPct,
            maxDrawdownPct: maxDdPct,
            executed: Number.isFinite(Number(s.executed)) ? Number(s.executed) : null,
            blocked: Number.isFinite(Number(s.blocked)) ? Number(s.blocked) : null,
            wins: Number.isFinite(Number(s.wins)) ? Number(s.wins) : null,
            losses: Number.isFinite(Number(s.losses)) ? Number(s.losses) : null,
            winRatePct,
            halt_globalStop: Number(s?.haltCounts?.globalStop || 0),
            halt_cooldown: Number(s?.haltCounts?.cooldown || 0),
            halt_circuitBreaker: Number(s?.haltCounts?.circuitBreaker || 0),
            halt_floor: Number(s?.haltCounts?.floor || 0),
            halt_ruin: Number(s?.haltCounts?.ruin || 0),
            halt_riskEnvelope: Number(s?.haltCounts?.riskEnvelope || 0),
            halt_minOrder: Number(s?.haltCounts?.minOrder || 0),
            halt_miss: Number(s?.haltCounts?.miss || 0),
          };

          matrixRows.push(row);

          if (fillBumpCents === 0 && slippagePct === 0) {
            baseRow = { ...row };
          }

          if (fillBumpCents === 10 && slippagePct === 0.02) {
            maxRow = { ...row };
          }

          if (!worst || (Number.isFinite(row.endingBalance) && row.endingBalance < worst.endingBalance)) {
            worst = { ...row };
          }
        }
      }

      if (worst) worstRows.push(worst);

      if (baseRow) {
        scenariosRows.push({
          runName,
          startingBalance,
          window: w.key,
          stakeFraction,
          scenario: 'BASE',
          ...baseRow,
        });
      }

      if (maxRow) {
        scenariosRows.push({
          runName,
          startingBalance,
          window: w.key,
          stakeFraction,
          scenario: 'MAX_10c_2pct',
          ...maxRow,
        });
      }

      if (worst) {
        scenariosRows.push({
          runName,
          startingBalance,
          window: w.key,
          stakeFraction,
          scenario: 'WORST_IN_GRID',
          ...worst,
        });
      }
    }
  }

  const matrixPath = path.join(outDir, `${runName}_simulateBankrollPath_stress_matrix.csv`);
  const worstPath = path.join(outDir, `${runName}_simulateBankrollPath_stress_worst.csv`);
  const scenariosPath = path.join(outDir, `${runName}_simulateBankrollPath_stress_scenarios_detail.csv`);

  const matrixCols = [
    'window',
    'stakeFraction',
    'fillBumpCents',
    'slippagePct',
    'endingBalance',
    'roiPct',
    'maxDrawdownPct',
    'executed',
    'blocked',
    'wins',
    'losses',
    'winRatePct',
    'halt_globalStop',
    'halt_cooldown',
    'halt_circuitBreaker',
    'halt_floor',
    'halt_ruin',
    'halt_riskEnvelope',
    'halt_minOrder',
    'halt_miss',
  ];

  fs.writeFileSync(matrixPath, toCsv(matrixRows, matrixCols));
  fs.writeFileSync(worstPath, toCsv(worstRows, matrixCols));

  const scenariosCols = [
    'runName',
    'startingBalance',
    'window',
    'stakeFraction',
    'scenario',
    'fillBumpCents',
    'slippagePct',
    'endingBalance',
    'roiPct',
    'maxDrawdownPct',
    'executed',
    'blocked',
    'wins',
    'losses',
    'winRatePct',
    'halt_globalStop',
    'halt_cooldown',
    'halt_circuitBreaker',
    'halt_floor',
    'halt_ruin',
    'halt_riskEnvelope',
    'halt_minOrder',
    'halt_miss',
  ];
  fs.writeFileSync(scenariosPath, toCsv(scenariosRows, scenariosCols));

  const mdCols = ['window', 'stakeFraction', 'fillBumpCents', 'slippagePct', 'endingBalance', 'roiPct', 'maxDrawdownPct', 'executed', 'blocked'];
  const md = renderMarkdownTable(worstRows, mdCols, {
    endingBalance: v => Number.isFinite(Number(v)) ? Number(v).toFixed(6) : '',
    roiPct: v => Number.isFinite(Number(v)) ? `${Number(v).toFixed(2)}` : '',
    maxDrawdownPct: v => Number.isFinite(Number(v)) ? `${Number(v).toFixed(2)}` : '',
    slippagePct: v => Number.isFinite(Number(v)) ? Number(v).toFixed(2) : '',
    stakeFraction: v => Number.isFinite(Number(v)) ? Number(v).toFixed(2) : '',
  });

  console.log(`Ledger: ${ledgerPath}`);
  console.log(`End epoch (sec): ${endEpochSec}`);
  console.log(`Wrote matrix: ${matrixPath}`);
  console.log(`Wrote worst:  ${worstPath}`);
  console.log(`Wrote scenarios: ${scenariosPath}`);
  console.log('');
  console.log(md);
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
}
