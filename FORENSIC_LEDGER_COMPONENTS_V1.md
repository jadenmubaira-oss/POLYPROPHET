# FORENSIC_LEDGER_COMPONENTS_V1

GeneratedAt: 2025-12-29T18:50:24.511Z

## MissionContext
- Goal: minimum 100 GBP profit within 24h from 5 GBP using Polymarket 15-min cycles.
- Constraint: maximize trade frequency without blowing up variance ("Golden Mean").
- Deploy reality: Render startCommand is `node server.js` at repo root.

## WhyProblemsNow
- Live NaN thresholds happen when server code prints/uses config keys that are undefined (schema drift), producing NaN and breaking gating/UI state.
- Repo drift: multiple parallel variants (POLYPROPHET-FINAL, p2, POLYPROPHET-2d, POLYPROPHET-d7ca) + duplicated debug logs cause mismatched expectations and brittle deploys.

## Components
### Root runtime entrypoint
- Status: ⚠️
- Why: Must become the chosen baseline server.js for Render. Current root server.js is a wrapper and will be replaced.
- Paths:
  - server.js
  - package.json
  - render.yaml

### Candidate baseline: d7ca monolith
- Status: ✅ CANDIDATE
- Why: Source of most debug logs and historically worked (UI + predictions). Needs verification against acceptance criteria.
- Paths:
  - POLYPROPHET-d7caab64012693e891e106a51dd8f1ad7b90dddd/POLYPROPHET-d7caab64012693e891e106a51dd8f1ad7b90dddd/server.js

### Candidate baseline: 2d monolith
- Status: ✅ CANDIDATE
- Why: Feature-complete variant; includes socket.io + extensive tooling. Needs verification; also duplicated in extracted folder.
- Paths:
  - POLYPROPHET-2d998c92e045c0110cc2864b53e62c70e0ccefbd/server.js
  - POLYPROPHET-2d998c92e045c0110cc2864b53e62c70e0ccefbd/public/
  - POLYPROPHET-2d998c92e045c0110cc2864b53e62c70e0ccefbd/tools/

### Variant: p2/
- Status: ⚠️ VARIANT
- Why: Contains modular libs; may be mined for components but not deploy target unless chosen.
- Paths:
  - p2/server.js
  - p2/src/

### Variant: POLYPROPHET-FINAL/
- Status: ❌ NOT BASELINE
- Why: Currently deployed but drifted and broken (NaN thresholds). Treat as reference only unless explicitly salvaged.
- Paths:
  - POLYPROPHET-FINAL/server.js
  - POLYPROPHET-FINAL/src/

### Debug logs (canonical archive)
- Status: ✅ MUST KEEP
- Why: Critical backtesting evidence. Currently duplicated; will be deduped into a single archive location (debug-archive branch).
- Paths:
  - debug/
  - POLYPROPHET-2d.../debug/
  - POLYPROPHET-d7ca.../debug/
  - p2/debug/

### AI chat exports
- Status: ✅ MUST KEEP
- Why: Define requirements and prior hypotheses/ideas; used to extract acceptance criteria and pitfalls.
- Paths:
  - Genesis Veto Verification.md
  - OMEGA V2 Data Restoration.md
  - POLYPROPHET Molecular Reconstruction.md
  - cursor_ultimate_bot_profit_optimization.md
  - cursor_polyprophet_system_pinnacle_impr.md

### Archives
- Status: ⚠️ KEEP AS EVIDENCE
- Why: Zip files are evidence; keep (preferably in debug-archive) but not in deploy main.
- Paths:
  - POLYPROPHET-2d998c92e045c0110cc2864b53e62c70e0ccefbd.zip
  - POLYPROPHET-d7caab64012693e891e106a51dd8f1ad7b90dddd.zip

## Fingerprints
- server.js: sha256:d0e2ef426c9fb7f45eafb49e66d914f84aee22bffa53c6f7180e7298e5d5f1be bytes:763 class:code_js
- package.json: sha256:224668e7c2d040af94f4754b0a1cf00248de4a8fa10ccda111e8243a2582853a bytes:718 class:package_manifest
- render.yaml: sha256:b64aa6f7c23529a90e0e3cf881e6a90e221b5001793d7f0cc66af9ea89120929 bytes:509 class:deploy_config
- POLYPROPHET-FINAL/server.js: sha256:b51e289a2dd1bd1c41f4446449993890e48376afd68758a8b68f61d7a0d3b452 bytes:34627 class:runtime_candidate_final
- POLYPROPHET-FINAL/src/supreme_brain.js: sha256:6d8847b6d38febfc40178e03050eb11aeb6824c10636e511ff4bc15cff2eee71 bytes:9745 class:runtime_candidate_final
- POLYPROPHET-2d998c92e045c0110cc2864b53e62c70e0ccefbd/server.js: sha256:5f58e1a102cb8107652738500f71ff566bf3e7346076c616339e01196357a922 bytes:480361 class:variant_2d
- POLYPROPHET-d7caab64012693e891e106a51dd8f1ad7b90dddd/POLYPROPHET-d7caab64012693e891e106a51dd8f1ad7b90dddd/server.js: sha256:9a766b0c233d1a4c8692b91bdcc90710bbcdea7870f88075e9e94331277eab4e bytes:459597 class:variant_d7ca
- FORENSIC_MANIFEST_V5.json: NOT_FOUND
- FORENSIC_DUPLICATES_V1.json: sha256:55ac006db378e9323673e0a74c72642aa958a2417fb21d30b4a087e27aa890f6 bytes:57276 class:data_json