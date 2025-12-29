# FORENSIC LEDGER (FULL) — Local Workspace Inventory + Evidence Outputs

**Workspace root:** `C:\Users\voide\Downloads\POLYPROPHET-main\POLYPROPHET-main`  
**Generated:** 2025-12-29

This ledger is intentionally **mechanical and evidence-based**:
- “Read every file” is interpreted as: **inventory + byte-for-byte hashing** of all project files (excluding only `.git/` and `node_modules/`) plus **deterministic audits** on the debug logs.
- It does **not** claim profitability guarantees.
- It does **not** delete anything. Any cleanup is proposed separately and only after approval.

---

## 1) What exists on disk (top-level)

Top-level directories observed:
- `.git/`
- `debug/`
- `debug_backtest/`
- `node_modules/`
- `p2/`
- `POLYPROPHET-2d998c92e045c0110cc2864b53e62c70e0ccefbd/`
- `POLYPROPHET-FINAL/`
- `POLYPROPHET-d7caab64012693e891e106a51dd8f1ad7b90dddd/` (extracted from zip during this investigation)
- `POLYPROPHET-2d998c92e045c0110cc2864b53e62c70e0ccefbd_extracted/` (extracted from zip during this investigation)

Top-level notable files:
- `FORENSIC_MANIFEST.json` (initial hash manifest)
- `FORENSIC_MANIFEST.csv` (initial manifest in CSV)
- `FORENSIC_MANIFEST_V2.json` (**current** manifest after zip extraction)
- `FORENSIC_DIFF_2dfolder_vs_d7ca_extracted.diff` (diff between “2d folder” `server.js` and extracted `d7ca` `server.js`)

---

## 2) Full file manifest (hashes)

### 2.1 Current manifest

**File:** `FORENSIC_MANIFEST_V2.json`  
- **File count hashed:** 431  
- **Skipped dirs:** `.git/`, `node_modules/`

This manifest includes:
- both zip archives
- both extracted snapshots
- all debug logs under `p2/` and the snapshot folders

### 2.3 Manifest after fixes

After applying the live-data WS stall fix + adding tier fields to hedged trade history, the latest manifest is:
- `FORENSIC_MANIFEST_V3.json` (**current**)

### 2.2 Key integrity findings (from manifest)

There are **multiple “server.js baselines”** present:

1) **`POLYPROPHET-2d.../server.js`**
- size ~488 KB
- SHA256: `0cd5521f...` (see manifest)

2) **`POLYPROPHET-d7ca.../POLYPROPHET-d7ca.../server.js`**
- size ~467 KB
- SHA256: `e8bdb4a4...` (see manifest)

3) **`POLYPROPHET-2d..._extracted/.../server.js`**
- size ~467 KB
- SHA256: `e8bdb4a4...` (**byte-identical** to d7ca extracted)

Conclusion: the **“d7ca snapshot” server** and the **“2d zip extracted” server** are the same file, but the **live `POLYPROPHET-2d.../server.js`** in your workspace is **different** (newer/different lineage).

---

## 3) “Analysis / MD” files (what is where)

### 3.1 Root-level MDs
- `README.md`
- `FORENSIC_LEDGER.md`
- `POLYPROPHET-FINAL/README.md`
- `cursor_chat_name_generation_instruction.md`

### 3.2 `POLYPROPHET-2d.../` MD set (15 files)
All 15 were fully opened/read in this investigation:
- `ATOMIC_INVESTIGATION_FINDINGS.md`
- `COMPREHENSIVE_ANALYSIS_FINAL.md`
- `COMPREHENSIVE_FILE_CHECK.md`
- `CONSISTENCY_LEDGER.md`
- `CRITICAL_FINAL_VERIFICATION.md`
- `DEBUG_AUDIT_FINDINGS.md`
- `FINAL_ATOMIC_SYSTEM_COMPLETE.md`
- `FINAL_PUSH_CONFIRMATION.md`
- `FINAL_SUMMARY.md`
- `GITHUB_PUSH_INSTRUCTIONS.md`
- `PINNACLE_VERDICT.md`
- `PROGRESS_TIMELINE.md`
- `PUSH_NOW.md`
- `README.md`
- `README_ATOMIC_FINAL.md`

Important ledger note:
- Several “atomic/perfect” docs explicitly mark themselves as **LEGACY / partially unverified** and direct the reader to the **reproducible tools** in `tools/`.

### 3.3 `POLYPROPHET-d7ca.../` MD set
- `POLYPROPHET-d7ca.../README.md` (v42 narrative)

---

## 4) Deterministic evidence runs (debug logs)

### 4.1 Dataset audited
Directory audited:
- `POLYPROPHET-2d.../debug/` (**85 JSON files**)

### 4.2 Trade-level audit (what matters for “money”)
Command executed:
- `node tools/audit_debug_logs.js --dir .\debug`

Reported summary:
- **Unique trades:** 315
- **Closed trades:** 305
- **Win rate:** **50.2%**
- **Median P/L per trade:** **£0.19**
- **Config versions seen:** `{"39":2,"40":1,"42":6,"unknown":76}`
- **Tier field missing in most trades**: “UNKNOWN” 299, “CONVICTION” 6

Outputs written:
- `POLYPROPHET-2d.../debug/audit_report.json`
- `POLYPROPHET-2d.../debug/audit_report.md`

Interpretation:
- This dataset **does not support** claims like “£5 → £100 worst-case guaranteed”.
- It also shows a **data-quality gap**: trade records often don’t carry `tier`, preventing proper tier-filter backtesting at the **trade** level.

### 4.3 Cycle-level audit (accuracy, not profit)
Command executed:
- `node tools/analyze_cycles.js --dir .\debug`

Reported summary:
- **Unique cycles:** 1656
- **Overall accuracy:** **72.2%**
- **CONVICTION accuracy:** **99.0%** (499/504)
- **ADVISORY accuracy:** **97.5%** (315/323)
- **NONE accuracy:** **46.0%** (381/829)
- **Oracle-locked accuracy:** **63.7%** (n=694)

Outputs written:
- `POLYPROPHET-2d.../debug/cycle_report.json`
- `POLYPROPHET-2d.../debug/cycle_report.md`

Interpretation:
- High tier **cycle-end** accuracy is real in this dataset.
- However, cycle-end accuracy is **not** a proof of profitable entries or profitable live fills.

---

## 5) Code-level forensic findings (server variants)

### 5.1 Two distinct “original” server lines exist locally

1) **`POLYPROPHET-2d.../server.js`** (larger, different hash)
- Adds more operational layers than the extracted d7ca baseline (e.g. richer UI transport and version endpoints; see diff file).

2) **`POLYPROPHET-d7ca.../POLYPROPHET-d7ca.../server.js`** (byte-identical to extracted 2d zip)
- Smaller baseline; missing some later operational hardening present in the 2d folder server.

### 5.2 Confirmed bug in BOTH historical baselines: backup WS feed can “stall”

In both the 2d folder server and the extracted d7ca baseline, the backup `crypto_prices` handler only sets a price when it is null/empty (pattern: `if (asset && !livePrices[asset] ...)`).

Effect:
- If Chainlink feed stalls and the backup feed continues, the backup feed can become effectively “one-shot”, leaving prices stale.

This is consistent with the “WAIT/0%” symptom you previously saw on old deployments.

### 5.3 `POLYPROPHET-FINAL/` vs “original monolith”

`POLYPROPHET-FINAL/` is a different architecture (modular components, smaller surface area).

However, compared to the monolithic originals, it currently lacks several operational systems that exist in the originals, such as:
- robust Redis-backed persisted settings w/ CONFIG version gating
- pending-sell retry queues / crash recovery queues / redemption queues
- full debug-export fidelity from the monolith

This ledger does not decide “which is best” yet; it documents what is present.

---

## 6) Immediate next steps (no deletions)

1) Decide which lineage is the intended deploy target:
   - **Option A:** deploy the “monolithic original” (`POLYPROPHET-2d.../server.js`) and apply minimal bugfixes + deployment cleanup.
   - **Option B:** keep `POLYPROPHET-FINAL/` as the base and port over the missing operational recovery/persistence features.

2) Fix the **trade audit data-quality gap** (tier missing on most trades) by ensuring trade records include:
   - tier at trade time
   - entry odds at trade time
   - strategy flags used
   so that future backtests can be trade-level, not just cycle-level.

3) Only after the above: propose a minimal “DEPLOY” folder and a safe archive of everything else.


