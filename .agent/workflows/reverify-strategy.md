---
description: Reverify the live 15m beam_2739 strategy, detect regime drift, and trigger a replacement search if needed.
---

# Strategy Reverification

## Command

```bash
npm run reverify:strategy
```

This writes `debug/reverify_beam_2739_report.json`.

## Review cadence

- Daily after funding
- Weekly as part of routine maintenance
- Immediately after every 100 resolved trades
- Immediately after any unusual drawdown, frequency collapse, or repeated execution anomaly

## Hard triggers for re-search

If **any** of these fire, run the guarded search immediately:

```bash
node scripts/search-15m-short-horizon-guarded.js
```

Triggers:

1. 7d replay from `$20` ends `<= $20`
2. 14d replay from `$20` ends `<= $20`
3. 7d win rate `< 74%` with at least `30` trades
4. 14d win rate `< 76%` with at least `60` trades
5. 30d win rate `< 78%` with at least `150` trades
6. 7d trades/day falls below `60%` of the 30d trades/day baseline
7. 30d max drawdown exceeds `55%`

## Exact replacement criteria

Only accept a replacement set if it satisfies all hard eligibility checks:

- `shortHorizonEligible=true`
- `noBust7=true`
- `noBust14=true`
- `allAboveStart=true`
- `supportOk=true`

Then rank by:

1. `medianFloor14` descending
2. `medianFloor7` descending
3. `p25Floor14` descending
4. `p25Floor7` descending
5. `recentActual.finalBalance` descending
6. `worstMaxDrawdown` ascending

## Important notes

- Do **not** “fix” the Kelly sizing mismatch unless a fresh reverify proves flat-fraction is no longer superior.
- Do **not** add volatility gates or circuit breakers unless they are shown to improve both survivability and median return in the latest sim.
- If a trigger fires, document it in `README.md` before any deploy.
