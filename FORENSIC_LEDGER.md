# FORENSIC LEDGER (Repo Cleanup + Runtime Fixes)

> **HISTORICAL DOCUMENT**: This records the initial repo cleanup. The production baseline has since moved to root `server.js` (v45). For current goals, see [`GOALS_AND_ACCEPTANCE.md`](GOALS_AND_ACCEPTANCE.md).

## Goal (Historical)

Make the repository **deployment-safe** (no giant logs/drafts slowing or destabilizing deploys), and fix the observed runtime symptom (**UI stuck on `WAIT / 0%`**) by hardening the live price feed ingestion.

## Findings (high signal)

- **Render deploy root is `POLYPROPHET-FINAL/`**, but the repo previously contained hundreds of tracked artifacts (debug logs, drafts, analysis outputs). While they don’t change runtime code directly, they:
  - slow down cloning/builds
  - create confusion about “which server.js is real”
  - increase the chance of deploying the wrong thing

- **Runtime root cause for “WAIT / 0%”** (high-confidence):
  - In `POLYPROPHET-FINAL/server.js`, the fallback `crypto_prices` topic updated a price **only once** because of a `!livePrices[asset]` gate, then stopped updating forever.
  - After ~60s, the price became “stale” and the main loop skipped the asset entirely, leaving the UI showing `WAIT` and 0% confidence.

## Fixes applied (POLYPROPHET-FINAL)

- **Live-data WS hardening**
  - Treat *either* feed (`crypto_prices_chainlink` OR `crypto_prices`) as liveness signal.
  - Always refresh prices on `crypto_prices` updates (remove “only once” gate).
  - Add reconnect backoff + log WS close/error details.

- **Diagnostics**
  - Added `GET /api/diagnostics` returning:
    - WS state and reconnect counters
    - last live-data age
    - per-asset last update age
    - last WS error/close reason

## Repo cleanup actions (deployment-only)

### Kept (tracked)

- `POLYPROPHET-FINAL/` (the only deployable service)
- `render.yaml` (Render blueprint)
- `.gitignore`
- `README.md` (minimal deployment README)
- `FORENSIC_LEDGER.md` (this file)

### Removed (untracked from git / deleted from repo)

These were removed to eliminate clutter and reduce clone/build time:

- Large chat/draft artifacts (multi‑MB `.md`)
- Huge analysis outputs (multi‑MB `.json`)
- Bulk debug logs (`debug/` trees)
- Duplicate/legacy documentation dumps
- Broken/dirty gitlink entries (`p2`, `POLYPROPHET-2d998c92…`) that acted like submodules without a `.gitmodules`

> Note: this cleanup is about **deployment reliability**, not “erasing history”. If you want a separate archival repo, we can create one and push all historical artifacts there.

## Post-cleanup verification checklist

- **Render**: redeploy and confirm:
  - `GET /api/health` returns ok
  - `GET /api/diagnostics` shows recent live price updates (< 10s typical)
  - Dashboard shows live prices and non-zero confidence once enough history accumulates

- **Trading loop**:
  - Assets are not skipped due to stale price feed
  - Market adapter is returning market odds (yes/no not stuck at 0.5)


