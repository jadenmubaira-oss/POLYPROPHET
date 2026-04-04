---
description: Run the full lite-runtime reaudit (local verification + live endpoint truth + strategy reverification).
---

# Runtime Reaudit

## One-command audit

```bash
npm run reverify:full
```

This runs:

1. `node scripts/reverify-beam-strategy.js`
2. `node scripts/verify-harness.js`
3. `node scripts/runtime-reaudit.js`

Outputs:

- `debug/reverify_beam_2739_report.json`
- `debug/runtime_reaudit_report.json`

## Verdict rules

- **GO**: live strategy correct, `tradeReady.ok=true`, no halts active, diagnostics clean, balance `>= $2`
- **CONDITIONAL GO**: all code/runtime checks pass but wallet is underfunded or there are non-fatal warnings
- **NO GO**: wrong strategy, failed endpoint truth, `tradeReady.ok=false`, or critical halt/failure state

## When to run

- Before every deploy
- After every deploy
- Weekly even if no code changed
- Immediately after any funded live anomaly

## Operator requirement

After any substantial re-audit, update `README.md` with:

- current deploy truth
- latest strategy reverify summary
- current GO / CONDITIONAL GO / NO GO verdict
- next required action
