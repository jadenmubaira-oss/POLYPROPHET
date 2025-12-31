# Baseline Decision (FINAL): Root `server.js` (v45)

## Decision
**Production baseline is the repo root `server.js` (CONFIG_VERSION 45).**

This eliminates all Render ambiguity and makes `render.yaml`/`startCommand` unambiguous:

- Render starts **repo root**: `node server.js`
- `POLYPROPHET-FINAL/` and other variants remain **archived/reference only**

## Evidence

The bake-off harness shows all candidates can boot, but root v45 is preferred for clarity:

- `debug_backtest/bakeoff_scorecard.md`
- `debug_backtest/bakeoff_scorecard.json`
- Detailed decision doc: `debug_backtest/BASELINE_DECISION.md`

## Why this is final

- **Single source of truth**: only one entrypoint for production (`server.js` at repo root)
- **Forensic traceability**: `/api/version` exposes `CONFIG_VERSION`, `gitCommit`, `serverSha256`
- **Deploy predictability**: no `rootDir` indirection, no subdir drift


