---
description: ATLAS Build App Workflow (POLYPROPHET)
---

# ATLAS Build App Workflow (POLYPROPHET)

This workflow standardizes how to build/change POLYPROPHET using the ATLAS method.

Scope:

- POLYPROPHET `polyprophet-lite` runtime (Node.js 20.x + Express)
- Entry point: `server.js` at repo root (~22KB)
- Config: `lib/config.js` (all env vars)
- Polymarket crypto Up/Down markets (15m, 4h, 5m timeframes)
- Strategy-native execution via `lib/strategy-matcher.js`
- Risk management via `lib/risk-manager.js`
- Trade execution via `lib/trade-executor.js` + `lib/clob-client.js`
- Redis-backed runtime state + disk persistence (`data/runtime-state.json`)
- Dashboard UI in `public/`
- Legacy reference surface in `legacy-root-runtime/` for comparison before major runtime/UI/execution changes

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
    - No regression in `GET /api/health` + `GET /api/status`

Artifacts to produce:

- A short plan (in chat or via todo_list tool)
- A list of files likely to be touched
- A README addendum / Current Session State update if the work is substantial

## T — Trace (Map the system)

Identify the authoritative sources before changing anything:

- **Backend entry**: `server.js` (lite runtime orchestrator)
- **Configuration**: `lib/config.js` (all env vars and defaults)
- **Core libs**: `lib/strategy-matcher.js`, `lib/risk-manager.js`, `lib/trade-executor.js`, `lib/market-discovery.js`, `lib/clob-client.js`, `lib/telegram.js`
- **Frontend**: `public/` directory
- **Strategy artifacts**: `debug/strategy_set_*.json` (preferred) or `strategies/` (fallback)
- **Legacy comparison surface**: `legacy-root-runtime/`
- **Runtime verification endpoints** (lite runtime):
  - `GET /api/health` — mode, version, balance, timeframes, strategy sets
  - `GET /api/status` — risk, executor, markets, orchestrator
  - `GET /api/diagnostics` — diagnostic log, heartbeat
  - `GET /api/wallet/balance` — wallet balance breakdown

**Legacy endpoints (DO NOT USE — return 404 on lite)**:
`/api/version`, `/api/state`, `/api/state-public`, `/api/perfection-check`, `/api/verify`, `/api/gates`, `/api/issued-signal-ledger`

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
- **What did legacy do here?**
  - Is there any still-useful mechanic, safeguard, UI signal, or recovery path in `legacy-root-runtime/` worth porting to lite?

If changing strategy/signal behavior:

- Verify strategy set loading via `GET /api/health` → `strategySets`
- Check strategy match activity via `GET /api/status` → `strategies`
- Review executor state via `GET /api/status` → `executor`

## A — Assemble (Implement in small, verifiable chunks)

Rules:

- Make the smallest change that satisfies the acceptance criteria.
- Keep simulations/backtests/profit claims honest: include gates, min-order effects, fees, and survivability constraints when relevant.
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
curl "http://localhost:3000/api/health"
curl "http://localhost:3000/api/status"
curl "http://localhost:3000/api/wallet/balance"
```

UI verification (local):

- Open `/`
- Open any dashboard surface touched by the change
- Confirm the UI matches runtime truth from the APIs

If the change touches strategy matching:

- Verify strategy sets still load via `GET /api/health` → `strategySets`
- Check `GET /api/status` → `strategies` for match counts

If the change touches risk management:

- Verify adaptive profile selection via `GET /api/status` → `risk`
- Check min-order bump path at micro bankrolls

If the change touches runtime, strategy, dashboard, or execution behavior:

- Compare lite behavior against `legacy-root-runtime/`
- Document why any legacy mechanic should or should not be ported

## V — Validate (Optional)

- Validate on a clean machine/env if possible (fresh `npm ci`)
- Validate that required env vars are documented and not committed

## M — Monitor (Optional)

If running long-lived locally:

- Periodically check `GET /api/health` for:
  - Orchestrator status
  - Strategy set loading
  - Balance changes
- Check `GET /api/diagnostics` for error patterns

## Handover

At end of session, update README.md "Current Session State" section with:
- What was done
- What was discovered
- What is pending
- Any discrepancies found
- Methodology used
- Any assumptions made
