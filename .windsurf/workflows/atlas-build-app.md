---
description: ATLAS Build App Workflow (POLYPROPHET)
---

# ATLAS Build App Workflow (POLYPROPHET)

This workflow standardizes how to build/change POLYPROPHET using the ATLAS method.

Scope:

- POLYPROPHET Node.js 20.x + Express (`server.js`) app
- Polymarket 15-minute crypto Up/Down markets
- Redis-backed runtime state
- Dashboard UI in `public/`
- Optional: persistent memory tooling in `memory/` (Python + SQLite)

Non-scope:

- Deployment (Render/production) unless explicitly requested
- Live trading enablement unless explicitly requested

## A — Architect (Define what we are building)

- **Goal**: Restate the user’s request as a testable specification.
- **Constraints**:
  - Node.js `20.x` (see `package.json` engines)
  - Keep changes minimal and reversible
  - Avoid unverified claims (prefer code + live endpoint checks)
- **Acceptance criteria**:
  - Define “done” in terms of:
    - Working endpoints
    - UI behavior
    - No regression in `/api/health` + `/api/perfection-check` (when applicable)

Artifacts to produce:

- A short plan (either in chat or in `implementation_plan.md` if you use one)
- A list of files likely to be touched

## T — Trace (Map the system)

Identify the authoritative sources before changing anything:

- **Backend entry**: `server.js`
- **Frontend**: `public/index.html`, `public/mobile.html`, `public/tools.html`
- **Analysis pipeline**:
  - `npm run analysis`
  - `final_golden_strategy.js` → `final_golden_strategy.json`
- **Runtime verification endpoints**:
  - `GET /api/health`
  - `GET /api/state` / `GET /api/state-public`
  - `GET /api/perfection-check`
  - `GET /api/verify?deep=1`

Local sanity commands:

```bash
node --check server.js
npm test
```

## L — Link (Explain data flow + dependency edges)

For the change you’re making, explicitly answer:

- **What calls what?**
  - Which endpoint / timer / worker owns the behavior?
- **Where does state live?**
  - In-memory vs Redis vs on-disk JSON
- **What are the gates?**
  - Any “no-trade / no-signal” gates that must remain safe
- **What are the external dependencies?**
  - Polymarket API/Gamma/CLOB
  - Redis
  - Telegram (optional)

If changing strategy/signal behavior:

- Use the Polymarket-only pipeline outputs as the authoritative source.
- Prefer explaining behavior via:
  - `/api/gates`
  - `/api/issued-signal-ledger`

## A — Assemble (Implement in small, verifiable chunks)

Rules:

- Make the smallest change that satisfies the acceptance criteria.
- After each edit:

```bash
node --check server.js
npm test
```

Recommended implementation sequence:

- Update backend logic (if needed)
- Update/extend API output (if needed)
- Update UI rendering (if needed)
- Update docs/tests last

## S — Stress-test (Prove it works)

Local run:

```bash
npm start
```

Verification endpoints (local):

```bash
curl "http://localhost:3000/api/version"
curl "http://localhost:3000/api/health"
curl "http://localhost:3000/api/state-public"
```

If the change touches oracle/signal behavior:

- Verify no flip-flop/lock invariants
- Verify signal reasons are explainable via `/api/gates`

If the change touches analysis/strategy generation:

```bash
npm run analysis
node final_golden_strategy.js
node -e "const r=require('./final_golden_strategy.json'); console.log({auditVerdict:r.auditVerdict,auditAllPassed:r.auditAllPassed});"
```

## V — Validate (Optional)

- Validate on a clean machine/env if possible (fresh `npm ci`)
- Validate that required env vars are documented and not committed

## M — Monitor (Optional)

If running long-lived locally:

- Periodically check `/api/health` for:
  - staleness indicators
  - rolling accuracy sample sizes
- Capture discrepancies between:
  - local backtest claims
  - live rolling accuracy

## Memory (Optional, for long-running projects)

If you want persistent notes across sessions, use `memory/` tools:

- Log a decision or discovery:

```bash
python memory/memory_write.py --type insight --content "<what you learned>" --importance 7
```

- Load memory context at session start:

```bash
python memory/memory_read.py --format markdown
```
