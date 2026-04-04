---
description: Run the full lite-runtime re-audit and refresh README truth.
---

# Runtime Reaudit

Run:

```bash
npm run reverify:full
```

This executes:

1. strategy reverify
2. local harness verification
3. live endpoint runtime audit

Artifacts:

- `debug/reverify_beam_2739_report.json`
- `debug/runtime_reaudit_report.json`

Use verdicts exactly:

- **GO** = strategy correct, tradeReady true, no active halts, balance >= $2
- **CONDITIONAL GO** = runtime healthy but underfunded or warning-only state
- **NO GO** = wrong strategy, endpoint truth mismatch, tradeReady false, or critical halt/failure

After substantial audits, sync `README.md` with the current truth.
