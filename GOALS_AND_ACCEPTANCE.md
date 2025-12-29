## Purpose (read this first)

This file defines **your true goals** and converts them into **machine-testable acceptance criteria**, grounded in the repo’s existing forensic evidence and chat exports.

It is explicitly meant to prevent “drift” (multiple variants, conflicting docs, schema mismatches) and to keep future work aligned with what you actually want: **maximum profit with minimum variance**, from a small bankroll, with a **stable non-dormant system**.

## Evidence sources used (local, already in this repo)

- `FORENSIC_INVESTIGATION_COMPLETE.md` (explicit “your goal” statement + high-level strategy claims)
- `Genesis Veto Verification.md` (detailed requirement language: oracle stability, no flip-flops, adaptive to microstructure)
- `PINNACLE_VERDICT.md` (evidence-based realism: what can/can’t be claimed; how logs actually behave)
- `FORENSIC_LEDGER_FULL.md` (hash-based inventory; deterministic audits on debug logs; trade-level vs cycle-level nuance)
- `POLYPROPHET-FINAL/README.md` (current “final” strategy framing + realistic 24h projections)
- `render.yaml` (what actually deploys on Render today)
- `BASELINE_DECISION.md` (why a monolith baseline was previously preferred for UI/transport coherence)
- `FORENSIC_MANIFEST_V3.json`, `repo_integrity_manifest.json` (inventory + integrity anchors)

## Your true goals (distilled)

### Money goal (primary)

- **Start small**: “starting from £5” (also seen in `render.yaml` default `PAPER_BALANCE=5.00`).
- **Grow fast**: your aspirational target appears repeatedly as **£5 → £100 in ~24h**, and more broadly “£10 → £1000 ASAP”.
IDEALLY MAX PROFIT IN MINIMMUM TIME WITN MINIMAL LOSS
- **Minimize variance**: “minimal statistical variance / minimal to no losses”, i.e. high win-rate **and** controlled drawdowns (not just high expected value).

### “Oracle” goal (product experience)

- **No flip-flopping**: predictions must not oscillate (UP/DOWN/NEUTRAL) late in the cycle, and confidence must not desync from the displayed direction.
- **Adaptive, not static**: avoid brittle “if X then Y” thresholds; system must adapt to:
  - manipulation / fake-outs,
  - liquidity drying up (especially last 60s),
  - order book gaps and time-of-day liquidity regimes,
  - “bounce” scalp opportunities (e.g., 95–96¢ early then revert enough for profit),
  - illiquidity gaps where YES+NO ≠ 100¢.

### Reliability goal (non-negotiable)

- **24/7 uptime**: long-running stability (no memory growth, no stalls, recover from WS disconnects).
- **Non-dormant**: the bot should not get stuck in permanent `WAIT/0%` due to stale feeds or overly restrictive gates.
- **Deterministic traceability**: every decision must be explainable and reproducible from logs/exports.

### Forensics + backtesting goal (how we prove improvement)

- **Export “every atom”**: one-click export of **last N cycles per asset** (N=10 is already referenced in the current root `server.js` debug-export design) including config, model votes, state, and execution context.
- **Reproducible audits**: ability to rerun deterministic analyses (cycle accuracy, trade outcomes, drawdowns, streaks) on preserved debug archives.

## Acceptance criteria (pass/fail, no vibes)

### A) Deploy / runtime is unambiguous

- **Single deploy target**: it must be clear what runs in production:
  - Today, `render.yaml` deploys from `rootDir: POLYPROPHET-FINAL` and runs `node server.js`.
- **Version/fingerprint available**:
  - `GET /api/version` exists and returns a code fingerprint or git SHA (or equivalent) so debug exports are tied to code.
- **Root start compatibility (Render reality)**:
  - The repo must support a clean start under Render’s start command model (either via `render.yaml` rootDir or root `node server.js`), without wrappers that can drift unnoticed.

### B) Dashboard + feed liveness (no permanent WAIT)

- **UI non-WAIT**: the dashboard shows non-`WAIT` predictions for each enabled asset within **≤ 1 cycle** of startup.
- **Feed liveness**:
  - Live prices update continuously (no “one-shot” fallback feed).
  - The system does not skip assets indefinitely due to “stale price” logic.
- **Diagnostics endpoint (recommended / already referenced in forensic docs)**:
  - `GET /api/diagnostics` returns per-asset last update age + WS status so liveness is measurable.

### C) State integrity

- **Cycle tracking**: cycle start/end, phase, and commitment/lock logic reset correctly at cycle boundaries.
- **Persistence**: if Redis/persistence is enabled, critical state survives restart (balances, learning/accuracy, settings versions, etc).

### D) Debug export (forensics-grade)

Export must include, at minimum:

- **Meta**: exportTime, serverUptime, nodeVersion, memoryUsage, code fingerprint.
- **Config**: full effective config used (including any UI/Redis overrides), and a config version identifier.
- **Per-asset** (for each of BTC/ETH/SOL/XRP):
  - prediction, confidence, tier, edge/EV,
  - model votes + weights used for that tick/cycle,
  - lock/commit state (oracle lock, conviction lock, hysteresis counters),
  - market snapshot (YES/NO odds, spread, liquidity metrics where available),
  - feature flags/mode states influencing decisions (OBSERVE/HARVEST/STRIKE).
- **Execution**:
  - open positions, pending orders/sells, fills, realized P&L, fees assumptions.

### E) “Golden Mean” strategy behavior (frequency without variance blow-up)

Because “maximum profit” and “minimum variance” are in tension, the acceptance criteria must be metric-based:

- **Trade frequency**: target trades/hour band (configurable per mode).
- **Risk bounds**:
  - max position size as % bankroll (cap),
  - max daily drawdown % (kill switch),
  - max consecutive losses before cooldown/OBSERVE,
  - max exposure per asset.
- **EV permissioning**:
  - no trades that are negative EV after fees + slippage assumptions.
- **Liquidity guards**:
  - do not trade into unfillable spreads / illiquid books.

### F) Proof via deterministic backtests + reports

From `FORENSIC_LEDGER_FULL.md` and `PINNACLE_VERDICT.md`, “cycle-end accuracy” is not enough.

To count as “proven”:

- We can run the repo’s audit tools over the preserved debug archive and get:
  - trade-level win rate,
  - ROI distribution,
  - drawdown + worst streak analysis,
  - frequency distribution,
  - strat/tier × odds bucket breakdown.
- Trade records must include fields required for strat-level backtests:
  - **tier at trade time** + entry odds + strategy flags (explicitly called out as a current gap).

## Reality constraints (how we reconcile ambition with evidence)

- **No honest guarantee**: external dependencies + probabilistic markets mean “0% chance of loss” and “worst-case guaranteed £5→£100” are not defensible claims. What we *can* do is maximize the probability of hitting targets while bounding risk.
- **Math trade-off**: high win-rate, high-frequency “high-price compounding” tends to produce **small per-trade ROI**; reaching £100 from £5 in 24h generally requires either:
  - much higher trade frequency,
  - higher per-trade ROI opportunities (higher variance),
  - or higher starting capital / leverage-like sizing (higher ruin risk).

## How to realize these goals (execution path, in order)

1. **Lock the runtime baseline**: choose one code lineage as the deploy target and eliminate ambiguity (Render rootDir vs root entrypoint).
2. **Guarantee liveness**: price feed updates + diagnostics; no permanent WAIT; verify with measurable “last update age”.
3. **Make debug export authoritative**: ensure the export captures full effective config + per-decision trace.
4. **Close the trade-audit data gap**: include tier/odds/flags in trade records so backtests are trade-level, not just cycle-level.
5. **Implement/validate Golden Mean state engine**:
   - OBSERVE → HARVEST → STRIKE with EV gating, liquidity guards, and drawdown kill switches.
6. **Backtest + report** on the preserved debug archive, then iterate only with evidence.

## Definition of “done”

This project is “done” only when:

- The deployed service shows **non-WAIT** predictions quickly and stays live for days without stalls.
- Debug exports are sufficient to reproduce decisions and audits deterministically.
- Backtest reports exist and reflect the same schema as live exports (no drift).
- The strategy meets defined frequency + drawdown bounds while improving profit relative to baseline, with clear evidence.
STRATEGY MEETS MISSION/GOAL

