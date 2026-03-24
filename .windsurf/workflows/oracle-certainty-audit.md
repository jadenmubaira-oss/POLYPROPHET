---
description: Strategy Certainty + Frequency Audit (Lite Runtime, Polymarket Cycles)
---

# Strategy Certainty + Frequency Audit (Lite Runtime)

## Scope

This workflow audits the **strategy-native execution** pipeline of `polyprophet-lite`:

- Polymarket crypto Up/Down markets (15m primary, 4h/5m when enabled)
- Strategy set matching and trade candidate generation
- Win rate and frequency of executed trades
- Risk management (adaptive sizing, min-order handling)
- Trade lifecycle (entry → hold → resolution → redemption)

It also requires:

- Dashboard/UI inspection for any surfaced strategy/runtime state
- Lite-vs-legacy comparison if the audit touches runtime, execution, safeguards, or UX decisions
- Truthful disclosure when a desired live metric is unavailable from the lite runtime

**Note**: The old oracle/ensemble system is LEGACY. The lite runtime uses **strategy-native entry generation**, not oracle signals.

## Definitions

- **A "trade"** = a strategy-matched entry that passes risk checks and is placed on the CLOB
- **Authoritative tracking**: `GET /api/status` → `strategies`, `executor`
- **Strategy sets**: `debug/strategy_set_*.json` (validated walk-forward artifacts)

## Acceptance Criteria

- **Correctness**: Strategy-matched trade win rate >= 85% after >= 30 resolved trades
  - 15m target: 88%+ (per top7_drop6 evidence)
  - 4h target: 84%+ (per 4h_maxprofit evidence)
- **Frequency**: ~4 trades/day for 15m, ~4 trades/day for 4h
- **Risk**: No trade exceeds adaptive profile limits; min-order bump path works correctly
- **Lifecycle**: Sells queue properly, resolution detection works, redemption fires for wins
- **Truthfulness**: Any unavailable live metric is explicitly marked unavailable rather than guessed

## Step 0 — Preconditions

- Node.js 20.x installed.
- Dependencies installed:

```bash
npm ci
```

## Step 1 — Static sanity

```bash
node --check server.js
npm test
```

## Step 2 — Start the server (local)

Recommended: PAPER + strategy signals.

```bash
npm start
```

Open:

- `http://localhost:3000/`
- `http://localhost:3000/tools.html`

Inspect any dashboard area relevant to enabled timeframes, strategy paths, balance state, or execution state.

## Step 3 — Baseline API verification (local)

Run these while the server is running:

```bash
curl "http://localhost:3000/api/health"
curl "http://localhost:3000/api/status"
curl "http://localhost:3000/api/wallet/balance"
curl "http://localhost:3000/api/diagnostics"
```

If auth blocks requests, set `NO_AUTH=true` in your env.

## Step 4 — Verify strategy loading and matching

Check `GET /api/health` response for:

- `strategySets` — are the correct `debug/` artifacts loaded?
- `timeframes` — are the intended timeframes enabled?
- `configuredTimeframes` — does 15m/4h/5m match expected state?

Check `GET /api/status` response for:

- `strategies` — match counts, last match time
- `executor` — active positions, sell queue state
- `risk` — current profile (MICRO_SPRINT/SPRINT_GROWTH/LARGE_BANKROLL)
- `markets` — discovered markets per timeframe

Then check the dashboard/UI and confirm it tells the same story as the API.

## Step 5 — Measure frequency + win rate over real cycles

Let the bot run and periodically record from `GET /api/status`:

- Strategy match count and frequency
- Trade execution count
- Win/loss resolution count
- Redemption success count

Compute:

- Trades/day = `executed_trades / elapsed_days`
- Win rate = `wins / (wins + losses)`

Do not trust < 30 resolved trades for final conclusions.

## Step 6 — Strategy artifact validation (offline)

Validate strategy sets against historical data:

```bash
node scripts/strategy-scan.js
```

Or collect fresh historical data:

```bash
node scripts/collect-historical.js
```

When reporting any backtest or simulation result, explicitly state:

- data source
- date span / coverage
- bankroll assumptions
- min-order behavior
- fees / execution realism assumptions
- whether risk envelopes / freezes / gating affected the result

## Step 7 — Live deployment verification

Query the production endpoint:

```bash
curl "https://polyprophet-1-rr1g.onrender.com/api/health"
curl "https://polyprophet-1-rr1g.onrender.com/api/status"
```

Verify:

- Strategy sets loaded match intended `debug/` artifacts (not fallback)
- Mode is LIVE
- Orchestrator is running
- Balance is sufficient for trading

If the audit is about changing runtime behavior, also compare the touched behavior against `legacy-root-runtime/` and note whether any old mechanic should be ported into lite.

## Outputs to capture (paste into chat)

- `GET /api/health` response
- `GET /api/status` response (strategies + executor sections)
- `GET /api/wallet/balance` response
- Dashboard findings
- Any discrepancies between local and live

If the audit is substantial, update the README addendum / Current Session State with methodology, assumptions, findings, and next actions.

## Decision Rules

- If win rate is below target, investigate:
  - Strategy set quality (check evidence in IMPLEMENTATION_PLAN_v140.md)
  - Entry price band alignment
  - Market condition changes
  - Min-order bump path issues at micro bankrolls
- If frequency is below target:
  - Check if markets are being discovered (`GET /api/status` → `markets`)
  - Check if strategy conditions are matching
  - Consider enabling additional timeframes (4h, 5m) if bankroll permits
- NEVER relax strategy matching criteria without walk-forward validation evidence
