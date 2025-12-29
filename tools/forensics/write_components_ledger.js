/**
 * Writes a human-readable component ledger with ✅/⚠️/❌ style statuses.
 * PowerShell-safe: avoid complex `node -e` quoting by using a real script.
 */
const fs = require("fs");

const manifestPath = "FORENSIC_MANIFEST_V5.json";
const outPath = "FORENSIC_LEDGER_COMPONENTS_V1.md";

function loadJson(p) {
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

function findFile(manifest, relPath) {
  return manifest.files.find((f) => f.path === relPath) || null;
}

function fp(manifest, relPath) {
  const f = findFile(manifest, relPath);
  if (!f) return "NOT_FOUND";
  return `sha256:${f.sha256} bytes:${f.bytes} class:${f.class}`;
}

function addSection(lines, name, status, why, paths) {
  lines.push(`### ${name}`);
  lines.push(`- Status: ${status}`);
  lines.push(`- Why: ${why}`);
  if (paths && paths.length) {
    lines.push(`- Paths:`);
    for (const p of paths) lines.push(`  - ${p}`);
  }
  lines.push("");
}

function main() {
  const manifest = loadJson(manifestPath);
  const lines = [];

  lines.push("# FORENSIC_LEDGER_COMPONENTS_V1");
  lines.push("");
  lines.push(`GeneratedAt: ${new Date().toISOString()}`);
  lines.push("");

  lines.push("## MissionContext");
  lines.push("- Goal: minimum 100 GBP profit within 24h from 5 GBP using Polymarket 15-min cycles.");
  lines.push('- Constraint: maximize trade frequency without blowing up variance ("Golden Mean").');
  lines.push("- Deploy reality: Render startCommand is `node server.js` at repo root.");
  lines.push("");

  lines.push("## WhyProblemsNow");
  lines.push("- Live NaN thresholds happen when server code prints/uses config keys that are undefined (schema drift), producing NaN and breaking gating/UI state.");
  lines.push("- Repo drift: multiple parallel variants (POLYPROPHET-FINAL, p2, POLYPROPHET-2d, POLYPROPHET-d7ca) + duplicated debug logs cause mismatched expectations and brittle deploys.");
  lines.push("");

  lines.push("## Components");
  addSection(
    lines,
    "Root runtime entrypoint",
    "⚠️",
    "Must become the chosen baseline server.js for Render. Current root server.js is a wrapper and will be replaced.",
    ["server.js", "package.json", "render.yaml"]
  );

  addSection(
    lines,
    "Candidate baseline: d7ca monolith",
    "✅ CANDIDATE",
    "Source of most debug logs and historically worked (UI + predictions). Needs verification against acceptance criteria.",
    ["POLYPROPHET-d7caab64012693e891e106a51dd8f1ad7b90dddd/POLYPROPHET-d7caab64012693e891e106a51dd8f1ad7b90dddd/server.js"]
  );

  addSection(
    lines,
    "Candidate baseline: 2d monolith",
    "✅ CANDIDATE",
    "Feature-complete variant; includes socket.io + extensive tooling. Needs verification; also duplicated in extracted folder.",
    [
      "POLYPROPHET-2d998c92e045c0110cc2864b53e62c70e0ccefbd/server.js",
      "POLYPROPHET-2d998c92e045c0110cc2864b53e62c70e0ccefbd/public/",
      "POLYPROPHET-2d998c92e045c0110cc2864b53e62c70e0ccefbd/tools/",
    ]
  );

  addSection(
    lines,
    "Variant: p2/",
    "⚠️ VARIANT",
    "Contains modular libs; may be mined for components but not deploy target unless chosen.",
    ["p2/server.js", "p2/src/"]
  );

  addSection(
    lines,
    "Variant: POLYPROPHET-FINAL/",
    "❌ NOT BASELINE",
    "Currently deployed but drifted and broken (NaN thresholds). Treat as reference only unless explicitly salvaged.",
    ["POLYPROPHET-FINAL/server.js", "POLYPROPHET-FINAL/src/"]
  );

  addSection(
    lines,
    "Debug logs (canonical archive)",
    "✅ MUST KEEP",
    "Critical backtesting evidence. Currently duplicated; will be deduped into a single archive location (debug-archive branch).",
    ["debug/", "POLYPROPHET-2d.../debug/", "POLYPROPHET-d7ca.../debug/", "p2/debug/"]
  );

  addSection(
    lines,
    "AI chat exports",
    "✅ MUST KEEP",
    "Define requirements and prior hypotheses/ideas; used to extract acceptance criteria and pitfalls.",
    [
      "Genesis Veto Verification.md",
      "OMEGA V2 Data Restoration.md",
      "POLYPROPHET Molecular Reconstruction.md",
      "cursor_ultimate_bot_profit_optimization.md",
      "cursor_polyprophet_system_pinnacle_impr.md",
    ]
  );

  addSection(
    lines,
    "Archives",
    "⚠️ KEEP AS EVIDENCE",
    "Zip files are evidence; keep (preferably in debug-archive) but not in deploy main.",
    ["POLYPROPHET-2d998c92e045c0110cc2864b53e62c70e0ccefbd.zip", "POLYPROPHET-d7caab64012693e891e106a51dd8f1ad7b90dddd.zip"]
  );

  lines.push("## Fingerprints");
  const criticalPaths = [
    "server.js",
    "package.json",
    "render.yaml",
    "POLYPROPHET-FINAL/server.js",
    "POLYPROPHET-FINAL/src/supreme_brain.js",
    "POLYPROPHET-2d998c92e045c0110cc2864b53e62c70e0ccefbd/server.js",
    "POLYPROPHET-d7caab64012693e891e106a51dd8f1ad7b90dddd/POLYPROPHET-d7caab64012693e891e106a51dd8f1ad7b90dddd/server.js",
    "FORENSIC_MANIFEST_V5.json",
    "FORENSIC_DUPLICATES_V1.json",
  ];
  for (const p of criticalPaths) lines.push(`- ${p}: ${fp(manifest, p)}`);

  fs.writeFileSync(outPath, lines.join("\n"));
  console.log("WROTE", outPath, "lines=", lines.length);
}

main();


