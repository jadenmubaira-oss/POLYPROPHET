# Baseline Decision

**Date**: 2025-12-31T13:30:33Z  
**Decision**: **Root `server.js` (v45)** is the production baseline.

## Bake-off Results

| Candidate | Score | CONFIG_VERSION | Notes |
|-----------|-------|----------------|-------|
| Root server.js | 5/5 | 45 | ✅ **WINNER** - Latest fixes, simplest deploy path |
| POLYPROPHET-FINAL/server.js | 5/5 | 45 | Same code as root, but Render `rootDir` adds complexity |
| POLYPROPHET-2d monolith | 5/5 | 43 | Older version, missing v44-v45 features |

## Rationale

1. **CONFIG_VERSION 45** includes all critical fixes:
   - `loadCollectorEnabled()` / `persistCollectorEnabled()` (fixed boot hang)
   - Idempotent trade history (hash+zset, no duplicates)
   - Redemption event tracking
   - Forward collector persistence
   - Hybrid throttle for trade gates

2. **Simplest deployment**: Root `server.js` means no `rootDir` in `render.yaml`, eliminating past confusion about which file Render actually runs.

3. **Both v45 candidates are identical** after today's fixes, so root is preferred for clarity.

## Next Steps

1. **Consolidate deploy**: Update `render.yaml` to remove `rootDir`, ensure `startCommand: node server.js` points to root.
2. **Archive POLYPROPHET-FINAL**: Keep for reference but don't deploy from it.
3. **Implement Golden Mean strategy** in the chosen baseline.

## Evidence

- Scorecard: `debug_backtest/bakeoff_scorecard.md`
- JSON: `debug_backtest/bakeoff_scorecard.json`
- Logs: `debug_backtest/bakeoff_*.log`
