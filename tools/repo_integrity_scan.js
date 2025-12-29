/**
 * Repo Integrity Scan (deterministic, whole-tree)
 *
 * - Walks the working directory recursively
 * - Computes SHA-256 for every file (including untracked), excluding:
 *   - node_modules/, .git/, .cursor/
 * - Optionally parses JavaScript files with acorn to catch syntax errors
 * - Writes a manifest JSON to ./repo_integrity_manifest.json
 *
 * Usage:
 *   node tools/repo_integrity_scan.js
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

let acorn = null;
try {
  // devDependency in this repo
  acorn = require("acorn");
} catch (_) {
  // ok: scan will still hash everything
}

const ROOT = process.cwd();
const OUT_FILE = path.join(ROOT, "repo_integrity_manifest.json");

const EXCLUDED_DIRS = new Set(["node_modules", ".git", ".cursor"]);

function isExcludedDirName(name) {
  return EXCLUDED_DIRS.has(name);
}

function sha256File(filePath) {
  const hash = crypto.createHash("sha256");
  const data = fs.readFileSync(filePath);
  hash.update(data);
  return hash.digest("hex");
}

function tryParseJs(filePath) {
  if (!acorn) return { ok: true, reason: "acorn_not_installed" };
  const code = fs.readFileSync(filePath, "utf8");
  try {
    acorn.parse(code, {
      ecmaVersion: "latest",
      sourceType: "script",
      allowHashBang: true,
    });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e && e.message ? e.message : e) };
  }
}

function walk(dir, results) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const ent of entries) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      if (isExcludedDirName(ent.name)) continue;
      walk(full, results);
      continue;
    }
    if (!ent.isFile()) continue;

    const rel = path.relative(ROOT, full).replace(/\\/g, "/");
    const stat = fs.statSync(full);
    const sha256 = sha256File(full);

    const rec = {
      path: rel,
      size: stat.size,
      sha256,
    };

    if (/\.(cjs|mjs|js)$/i.test(ent.name)) {
      rec.jsParse = tryParseJs(full);
    }

    results.push(rec);
  }
}

function main() {
  const results = [];
  walk(ROOT, results);
  results.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  const totals = results.reduce(
    (acc, r) => {
      acc.files += 1;
      acc.bytes += r.size;
      if (r.jsParse && r.jsParse.ok === false) acc.jsParseErrors += 1;
      return acc;
    },
    { files: 0, bytes: 0, jsParseErrors: 0 }
  );

  const manifest = {
    root: path.basename(ROOT),
    generatedAt: new Date().toISOString(),
    exclusions: Array.from(EXCLUDED_DIRS),
    totals,
    files: results,
  };

  fs.writeFileSync(OUT_FILE, JSON.stringify(manifest, null, 2), "utf8");

  // Minimal console output (don’t spam logs)
  console.log(
    `[repo_integrity_scan] files=${totals.files} bytes=${totals.bytes} jsParseErrors=${totals.jsParseErrors}`
  );
  console.log(`[repo_integrity_scan] wrote ${path.relative(ROOT, OUT_FILE)}`);
}

main();


