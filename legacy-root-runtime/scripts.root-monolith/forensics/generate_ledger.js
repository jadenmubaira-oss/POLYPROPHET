/**
 * PolyProphet Forensics — Local Integrity Ledger Generator
 *
 * Generates `FORENSIC_LEDGER_LOCAL.json` with:
 * - sha256
 * - byte size
 * - line count
 * - short purpose note (1–2 sentences)
 *
 * Usage (from repo root):
 *   node scripts/forensics/generate_ledger.js
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execSync } = require('child_process');

const REPO_ROOT = path.resolve(__dirname, '..', '..');

const IGNORE_DIRS = new Set([
  '.git',
  'node_modules',
  '.cursor',
  'terminals',
]);

const IGNORE_FILES = new Set([
  // Prevent self-referential ledger hashing loops.
  'FORENSIC_LEDGER_LOCAL.json',
]);

const REQUIRED_FILES = [
  'server.js',
  'package.json',
  'package-lock.json',
  'README.md',
  '.env.example',
  'generate_creds.js.example',
  '.gitignore',
  'render.yaml',
  path.join('public', 'tools.html'),
  path.join('public', 'index.html'),
  path.join('public', 'mobile.html'),
];

const PURPOSE_OVERRIDES = new Map([
  ['server.js', 'Main PolyProphet server + trading engine: prediction, gating, execution, redemption, recovery, persistence, dashboards, and API routes.'],
  ['package.json', 'Node package manifest: dependency graph, scripts, and engine version pin used for deploy parity.'],
  ['package-lock.json', 'Dependency lockfile ensuring deterministic installs across machines and deployment platforms.'],
  ['README.md', 'Primary operator/deployment/verification documentation (the “single source of truth” narrative).'],
  ['.env.example', 'Environment variable template showing supported configuration knobs (no secrets).'],
  ['generate_creds.js.example', 'Utility example for deriving Polymarket API credentials from a private key (operator-side).'],
  ['.gitignore', 'Git ignore rules to keep secrets/build artifacts out of source control.'],
  ['render.yaml', 'Render blueprint defining how the service is built and started in Render.'],
  [path.join('public', 'tools.html'), 'Web tools UI for verification/optimization endpoints (vault tools, checks, and helpers).'],
  [path.join('public', 'index.html'), 'Primary dashboard UI for monitoring bot state and recent activity.'],
  [path.join('public', 'mobile.html'), 'Mobile-optimized dashboard UI for monitoring bot state on small screens.'],
  [path.join('scripts', 'forensics', 'analyze_debug.js'), 'Deterministically ingests all debug JSON to produce the v96 debug corpus report + replay markdown.'],
  [path.join('scripts', 'forensics', 'generate_ledger.js'), 'Generates integrity ledger (sha256/lines/bytes) for repo files to prove what was ingested.'],
]);

function safeGitCommit() {
  try {
    return execSync('git rev-parse HEAD', { cwd: REPO_ROOT, stdio: ['ignore', 'pipe', 'ignore'] })
      .toString('utf8')
      .trim();
  } catch {
    return null;
  }
}

function normalizeRel(p) {
  // Keep Windows-friendly separators in output, matching earlier ledgers.
  return p.replace(/\//g, path.sep);
}

function purposeFor(relPath) {
  const key = normalizeRel(relPath);
  if (PURPOSE_OVERRIDES.has(key)) return PURPOSE_OVERRIDES.get(key);

  const rel = key;
  const lower = rel.toLowerCase();

  if (rel.startsWith(`debug${path.sep}`) || rel.startsWith('debug/')) {
    if (lower.endsWith('.md')) return 'Debug/forensics markdown output captured alongside the JSON corpus (human-readable).';
    if (lower.endsWith('.json')) {
      if (lower.includes('polyprophet_debug_')) return 'PolyProphet runtime debug export (cycle history + trades + gates snapshots) used for deterministic forensic replay.';
      return 'Debug/forensics JSON artifact (derived from the debug corpus or saved runtime snapshots).';
    }
    return 'Debug corpus artifact captured from PolyProphet runtime.';
  }

  if (rel.startsWith(`docs${path.sep}`) || rel.startsWith('docs/')) {
    return 'Documentation / forensic reports generated from deterministic scripts (non-runtime).';
  }

  if (rel.startsWith(`public${path.sep}`) || rel.startsWith('public/')) {
    return 'Static web asset for dashboards/tools UI served by the PolyProphet server.';
  }

  if (rel.startsWith(`scripts${path.sep}`) || rel.startsWith('scripts/')) {
    return 'Operator/forensics scripts (not used by the live trading loop unless invoked).';
  }

  if (lower.endsWith('.md')) return 'Documentation/notes for operators or forensic tracking.';
  if (lower.endsWith('.json')) return 'Structured data/config used by the repo or produced by scripts.';
  if (lower.endsWith('.js')) return 'JavaScript source file in this repository.';
  if (lower.endsWith('.yml') || lower.endsWith('.yaml')) return 'YAML configuration used for deployment or tooling.';

  return 'Repository file (see path/name for its specific role).';
}

function hashBytesLines(filePath) {
  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(filePath, 'r');
  const buf = Buffer.alloc(1024 * 1024); // 1MB

  let bytes = 0;
  let lines = 0;
  let nonEmptyLines = 0;
  let lineHasContent = false;
  let lastByte = null;

  try {
    while (true) {
      const n = fs.readSync(fd, buf, 0, buf.length, null);
      if (n === 0) break;
      bytes += n;
      const slice = buf.subarray(0, n);
      hash.update(slice);
      for (let i = 0; i < n; i++) {
        const b = slice[i];
        if (b === 10) {
          lines += 1;
          if (lineHasContent) nonEmptyLines += 1;
          lineHasContent = false;
        } else if (b !== 13) {
          // Treat any non-newline byte as "content" so whitespace-only lines are counted as non-empty,
          // matching PowerShell's Measure-Object -Line behavior.
          lineHasContent = true;
        }
      }
      lastByte = slice[n - 1];
    }
  } finally {
    fs.closeSync(fd);
  }

  // "lines" counts total lines (including blank lines). Add 1 if file is non-empty and does not end with '\n'.
  if (bytes > 0 && lastByte !== 10) lines += 1;

  // Count the trailing line as non-empty if it has content and did not end with '\n'.
  if (bytes > 0 && lastByte !== 10 && lineHasContent) nonEmptyLines += 1;

  return {
    bytes,
    lines,
    nonEmptyLines,
    sha256: hash.digest('hex'),
  };
}

function walkFiles(dir, out) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const ent of entries) {
    const full = path.join(dir, ent.name);
    const rel = path.relative(REPO_ROOT, full);

    if (ent.isDirectory()) {
      if (IGNORE_DIRS.has(ent.name)) continue;
      walkFiles(full, out);
      continue;
    }

    if (ent.isFile()) {
      if (IGNORE_FILES.has(rel) || IGNORE_FILES.has(ent.name)) continue;
      out.push(full);
    }
  }
}

function main() {
  const files = [];
  walkFiles(REPO_ROOT, files);

  files.sort((a, b) => a.localeCompare(b));

  const requiredSet = new Set(REQUIRED_FILES.map((p) => normalizeRel(p)));

  const requiredFiles = [];
  const debugFiles = [];
  const otherFiles = [];

  for (const abs of files) {
    const relRaw = path.relative(REPO_ROOT, abs);
    const rel = normalizeRel(relRaw);
    const meta = hashBytesLines(abs);
    const item = {
      path: rel,
      bytes: meta.bytes,
      lines: meta.lines,
      nonEmptyLines: meta.nonEmptyLines,
      sha256: meta.sha256,
      purpose: purposeFor(rel),
    };

    if (requiredSet.has(rel)) requiredFiles.push(item);
    else if (rel.startsWith(`debug${path.sep}`) || rel.startsWith('debug/')) debugFiles.push(item);
    else otherFiles.push(item);
  }

  // Ensure requiredFiles are in the canonical order defined above.
  requiredFiles.sort((a, b) => REQUIRED_FILES.map(normalizeRel).indexOf(a.path) - REQUIRED_FILES.map(normalizeRel).indexOf(b.path));

  const ledger = {
    timestamp: new Date().toISOString(),
    gitCommit: safeGitCommit(),
    counts: {
      requiredFiles: requiredFiles.length,
      debugFiles: debugFiles.length,
      otherFiles: otherFiles.length,
      totalFiles: requiredFiles.length + debugFiles.length + otherFiles.length,
    },
    requiredFiles,
    debugFiles,
    otherFiles,
  };

  const outPath = path.join(REPO_ROOT, 'FORENSIC_LEDGER_LOCAL.json');
  fs.writeFileSync(outPath, JSON.stringify(ledger, null, 4), 'utf8');

  // eslint-disable-next-line no-console
  console.log(`Wrote ${outPath}`);
  // eslint-disable-next-line no-console
  console.log(`Files: required=${ledger.counts.requiredFiles} debug=${ledger.counts.debugFiles} other=${ledger.counts.otherFiles} total=${ledger.counts.totalFiles}`);
}

main();

