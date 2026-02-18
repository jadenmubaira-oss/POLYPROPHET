---
description: Oracle Certainty + Frequency Audit (Local, 15m Polymarket Cycles)
---

# Oracle Certainty + Frequency Audit (Local, 15m Polymarket Cycles)

## Scope

This workflow is ONLY about:

- 15-minute Polymarket Up/Down markets (BTC/ETH/SOL/XRP)
- Oracle issuing **BUY** signals (UP or DOWN) with maximum correctness
- Measuring **win rate** and **frequency** of issued BUY signals
- Ensuring **no flip-flop** behavior and **anti-manipulation** guards are active

It intentionally ignores LIVE auto-trading.

## Definitions

- **A “trade / signal”** in this workflow means an **issued BUY oracle signal**.
- The authoritative tracking source is:
  - `GET /api/issued-signal-ledger`

## Acceptance Criteria (practical)

- **Correctness**: Issued BUY win rate is **>= 0.90** after **>= 20 resolved** BUY signals.
  - If WR is 0.87-0.89, that is “NEAR-PASS” and requires explicit decision.
- **Frequency**: Aim for **~1 BUY/hour total** across all enabled assets.
  - If correctness target is met but frequency is lower, do NOT relax thresholds without documenting the tradeoff.
- **No flip-flop**:
  - After a BUY is issued for an asset+cycle, direction must not oscillate within that cycle.
  - Locks (`oracleLocked` / `convictionLocked` / cycle commitment) must prevent contradictory signals.
- **Manipulation resistance**:
  - Volatility/spike guard must be enabled and block entries when manipulation conditions trigger.

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

Recommended: PAPER + oracle signals.

```bash
npm start
```

Open:

- `http://localhost:3000/`
- `http://localhost:3000/tools.html`

## Step 3 — Baseline API verification (local)

Run these while the server is running:

```bash
curl "http://localhost:3000/api/version"
curl "http://localhost:3000/api/health"
curl "http://localhost:3000/api/state-public"
curl "http://localhost:3000/api/state"
```

If auth blocks requests, append `?apiKey=<API_KEY>` or set `NO_AUTH=true` in your env.

## Step 4 — Prove no-flip-flop + see why signals are blocked

These endpoints are the “truth layer” for behavior:

```bash
curl "http://localhost:3000/api/gates?limit=50"
curl "http://localhost:3000/api/issued-signal-ledger"
```

Interpretation:

- If frequency is low, `/api/gates` must explain which gate is suppressing BUY.
- If win rate is low, `/api/issued-signal-ledger` will show it (independent of manual confirmation).

## Step 5 — Measure frequency + win rate over real cycles

Let the bot run and periodically record:

- Current issued-signal stats:
  - `GET /api/issued-signal-ledger`
- Recent blocked reasons:
  - `GET /api/gates?limit=200`

Compute:

- Signals/hour = `resolved_total / elapsed_hours`
- Win rate = `wins / (wins + losses)`

Do not trust < 20 resolved signals for final conclusions.

## Step 6 — Offline backtest to tune the pWin threshold (maximize frequency for a target WR)

This uses the repo’s debug corpus (if present):

```bash
node scripts/backtest-manual-strategy.js --data=debg --target-wr=0.90
```

Optional:

```bash
node scripts/backtest-manual-strategy.js --data=debg --target-wr=0.85
```

## Step 7 — Polymarket-only strategy artifact regeneration (optional but recommended)

```bash
npm run analysis
node final_golden_strategy.js
node -e "const r=require('./final_golden_strategy.json'); console.log({auditVerdict:r.auditVerdict,auditAllPassed:r.auditAllPassed,gs:r.goldenStrategy});"
```

## Outputs to capture (paste into chat)

- `/api/health`
- `/api/state-public`
- `/api/gates?limit=50`
- `/api/issued-signal-ledger`
- Offline backtest result summary (from backtest-manual-strategy.js)

## Decision Rules

- If correctness is below target, do NOT “turn up aggression” blindly.
  - First identify which part is wrong: pWin calibration, timing window, flip-flop/lock, manipulation guard false negatives, or strategy constraints.
- If correctness is high but frequency is low, increase frequency only by:
  - adding assets (if you were running a subset), or
  - lowering the pWin threshold **minimally**, validated by offline backtest.
