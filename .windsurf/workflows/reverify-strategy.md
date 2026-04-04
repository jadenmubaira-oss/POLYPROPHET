---
description: Reverify beam_2739 strategy health and trigger a replacement search only when the current edge degrades.
---

# Reverify Strategy

Run:

```bash
npm run reverify:strategy
```

Read `debug/reverify_beam_2739_report.json`.

If any trigger fires, run:

```bash
node scripts/search-15m-short-horizon-guarded.js
```

Only promote a replacement if it satisfies:

- `shortHorizonEligible=true`
- `noBust7=true`
- `noBust14=true`
- `allAboveStart=true`
- `supportOk=true`

Ranking order:

1. `medianFloor14`
2. `medianFloor7`
3. `p25Floor14`
4. `p25Floor7`
5. `recentActual.finalBalance`
6. `worstMaxDrawdown` (lower is better)

Review cadence:

- daily after funding
- weekly routine
- after every 100 resolved trades
- immediately after unusual drawdown or frequency collapse
