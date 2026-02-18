const fs = require('fs');
const path = require('path');

function readJson(filePath) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Missing file: ${filePath}`);
  }
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

function escapeMarkdownPipes(text) {
  return String(text || '').replace(/\|/g, '\\|');
}

function fmt4(x) {
  const n = Number(x);
  if (!Number.isFinite(n)) return 'n/a';
  return n.toFixed(4);
}

function fmtBand(min, max) {
  const a = Number(min);
  const b = Number(max);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 'n/a';
  return `${a.toFixed(2)}–${b.toFixed(2)}`;
}

function parseArgs(argv) {
  const args = {
    optimized: null,
    robust: null,
    out: null,
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--optimized') args.optimized = argv[++i] || null;
    else if (a === '--robust') args.robust = argv[++i] || null;
    else if (a === '--out') args.out = argv[++i] || null;
  }

  return args;
}

function renderTableRow({ id, signature, utcHour, entryMinute, direction, bandMin, bandMax, tier, oos, live, combined }) {
  const utcEntry = `${pad2(utcHour)}:${pad2(entryMinute)}`;
  const band = fmtBand(bandMin, bandMax);
  const sigTxt = escapeMarkdownPipes(signature);

  const oosCell = `${oos.wins}/${oos.trades} (WR ${fmt4(oos.wr)}, LCB ${fmt4(oos.lcb)})`;
  const liveCell = `${live.wins}/${live.trades} (WR ${fmt4(live.wr)}, LCB ${fmt4(live.lcb)})`;
  const combinedCell = `${combined.wins}/${combined.trades} (WR ${fmt4(combined.wr)}, LCB ${fmt4(combined.lcb)})`;

  return `| ${id} | ${sigTxt} | ${utcEntry} | ${direction} | ${band} | ${tier} | ${oosCell} | ${liveCell} | ${combinedCell} |`;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const repoRoot = path.join(__dirname, '..');

  const optimizedPath = args.optimized
    ? (path.isAbsolute(args.optimized) ? args.optimized : path.join(repoRoot, args.optimized))
    : path.join(repoRoot, 'optimized_strategies.json');

  const robustPath = args.robust
    ? (path.isAbsolute(args.robust) ? args.robust : path.join(repoRoot, args.robust))
    : path.join(repoRoot, 'exhaustive_analysis', 'robust_live_check.json');

  const optimized = readJson(optimizedPath);
  const robust = readJson(robustPath);

  const strategies = Array.isArray(optimized?.strategies) ? optimized.strategies : [];
  if (strategies.length === 0) {
    throw new Error(`No strategies found in: ${optimizedPath}`);
  }

  const perStrategy = robust?.perStrategy && typeof robust.perStrategy === 'object' ? robust.perStrategy : {};
  const liveDays = Number(robust?.timeRange?.days);

  const header = `| ID | Signature | UTC Entry | Dir | Band | Tier | OOS (val+test) | Live (${Number.isFinite(liveDays) ? `${liveDays}d` : 'live'}) | Combined |`;
  const sep = '|----|-----------|----------:|-----|------|------|----------------|------------|----------|';

  const rows = [];
  for (const s of strategies.slice().sort((a, b) => Number(a.id) - Number(b.id))) {
    const signature = String(s?.signature || '').trim();
    if (!signature) {
      throw new Error('Encountered strategy missing signature');
    }

    const stats = perStrategy[signature];
    if (!stats) {
      throw new Error(`Missing perStrategy stats for signature: ${signature} (expected in ${robustPath})`);
    }

    const oos = stats?.oos;
    const live = stats?.live;
    const combined = stats?.combined;

    if (!oos || !live || !combined) {
      throw new Error(`Incomplete stats for signature: ${signature}`);
    }

    rows.push(
      renderTableRow({
        id: Number(s.id),
        signature,
        utcHour: Number(s.utcHour),
        entryMinute: Number(s.entryMinute),
        direction: String(s.direction || '').toUpperCase(),
        bandMin: s.priceMin,
        bandMax: s.priceMax,
        tier: String(s.tier || ''),
        oos,
        live,
        combined,
      })
    );
  }

  const table = [header, sep, ...rows].join('\n');

  if (args.out) {
    const outPath = path.isAbsolute(args.out) ? args.out : path.join(repoRoot, args.out);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, table + '\n', 'utf8');
  } else {
    process.stdout.write(table + '\n');
  }
}

try {
  main();
} catch (e) {
  const msg = e && e.stack ? e.stack : String(e);
  process.stderr.write(`Fatal: ${msg}\n`);
  process.exit(1);
}
