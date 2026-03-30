---
description: Incrementally fix build and type errors with minimal, safe changes.
---

# Build Fix

Incrementally fix build and type errors with minimal, safe changes.

## Step 1: Detect Build System

For POLYPROPHET:
- Primary: `node --check server.js`
- Secondary: `npm start` (runtime check)
- Tests: `npm test`

## Step 2: Parse and Group Errors

1. Run `node --check server.js` and capture output
2. Group errors by file path
3. Sort by dependency order (fix imports before logic errors)
4. Count total errors for progress tracking

## Step 3: Fix Loop (One Error at a Time)

For each error:

1. **Read the file** — see error context (10 lines around the error)
2. **Diagnose** — identify root cause (missing import, wrong syntax, undefined var)
3. **Fix minimally** — smallest change that resolves the error
4. **Re-run check** — `node --check server.js`
5. **Move to next** — continue with remaining errors

## Step 4: Guardrails

Stop and ask the user if:
- A fix introduces **more errors than it resolves**
- The **same error persists after 3 attempts**
- The fix requires **architectural changes**
- Build errors stem from **missing dependencies** (need `npm install`)

## Step 5: Summary

Show results:
- Errors fixed (with file paths)
- Errors remaining (if any)
- New errors introduced (should be zero)
- Suggested next steps

## Recovery Strategies

| Situation | Action |
|-----------|--------|
| Missing module/import | Check if package exists in package.json |
| Syntax error | Fix at reported line |
| Undefined variable | Declare or fix scope |
| Config issue | Check `lib/config.js` env var parsing |
| Strategy loading failure | Check `debug/` artifact paths |

Fix one error at a time for safety. Prefer minimal diffs over refactoring.
