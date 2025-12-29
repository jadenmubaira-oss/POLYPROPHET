# Baseline Decision: Use `POLYPROPHET-2d...` as the “original PolyProphet” base

## Context
Your current Render service runs `node server.js` from the **repo root**. The repo drifted into multiple competing variants (`POLYPROPHET-FINAL/`, `p2/`, `POLYPROPHET-2d.../`, `POLYPROPHET-d7ca.../`) and the live deploy showed **NaN thresholds / WAITING**, caused by config-schema mismatch in the modular `POLYPROPHET-FINAL` path.

We need a single coherent, self-contained baseline that:
- renders the full dashboard,
- exposes `/api/state` consistently,
- keeps live-data WS + checkpoint logic,
- is easiest to make the root deploy target (Render reality).

## Candidates compared

### Candidate A — d7ca monolith
- File: `POLYPROPHET-d7caab64012693e891e106a51dd8f1ad7b90dddd/POLYPROPHET-d7caab64012693e891e106a51dd8f1ad7b90dddd/server.js`
- Package: no `socket.io` dependency; UI is served from an inline HTML template at `app.get('/')`.
- Transport: updates are primarily via polling `/api/state` (inline UI fetch loop).
- Oracle defaults: `maxOdds: 0.60` and `MAX_POSITION_SIZE` default ~40% (more aggressive sizing, more restrictive odds cap).

### Candidate B — 2d monolith (chosen)
- File: `POLYPROPHET-2d998c92e045c0110cc2864b53e62c70e0ccefbd/server.js`
- Package: includes `socket.io` and ships `public/index.html` / `public/mobile.html` alongside the full inline dashboard route.
- Transport: supports both Socket.IO events (e.g. `state_update`, `omega_update`) and `/api/state` via a single shared `buildStateSnapshot()` function.
- Forensics: includes a `CODE_FINGERPRINT` (git commit + sha256) to tie debug exports to the exact running code.
- Oracle defaults: `maxOdds: 0.90` (explicitly aligned with the “high-price / high-win-rate” strategy surfaced in later analysis), and `MAX_POSITION_SIZE` default ~20% (more conservative).

## Why the 2d monolith is the best base
- **Coherent UI + transport**: the 2d baseline has the cleanest single-source-of-truth state snapshot (`buildStateSnapshot()`), reducing the chance of UI/WS drift and “WAITING” regressions.
- **Mobile + dashboard compatibility**: it includes both an inline full dashboard and dedicated `public/` dashboards, matching how you’ve been monitoring on Render.
- **Forensic traceability**: the code fingerprint makes future audits deterministic (“which exact code produced this debug export?”).
- **Better starting point for Golden Mean**: the 2d config already incorporates later “high-price” findings (e.g., higher `maxOdds`), so we’re not fighting the defaults while we implement OBSERVE/HARVEST/STRIKE.

## Decision
We will rebuild the repo so the **root deploy target** (`node server.js`) is the **2d monolith**, and treat d7ca (and other variants) as archived references.


