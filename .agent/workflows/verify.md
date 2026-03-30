---
description: Run comprehensive verification on current codebase state.
---

# Verification Command

Run comprehensive verification on current codebase state.

## Instructions

Execute verification in this exact order:

1. **Syntax Check**
   - Run `node --check server.js`
   - If it fails, report errors and STOP

2. **Test Suite**
   - Run `npm test`
   - Report pass/fail count

3. **API Verification** (if server running)
   - `GET /api/health` — mode, version, strategy sets
   - `GET /api/status` — risk, executor, orchestrator
   - `GET /api/wallet/balance` — wallet state

4. **Console.log Audit**
   - Search for console.log in source files (except debug/legacy)
   - Report locations of non-essential logging

5. **Secrets Scan**
   - Search for hardcoded API keys, passwords, tokens
   - Check `.env` files are in `.gitignore`
   - Verify `POLYPROPHET.env` is not committed

6. **Git Status**
   - Show uncommitted changes
   - Show files modified since last commit

## Output

Produce a concise verification report:

```
VERIFICATION: [PASS/FAIL]

Syntax:   [OK/FAIL]
Tests:    [X/Y passed]
API:      [OK/SKIP (not running)/FAIL]
Secrets:  [OK/X found]
Logs:     [OK/X console.logs]

Ready for commit: [YES/NO]
```

If any critical issues, list them with fix suggestions.

## Arguments

- `quick` — Only syntax + secrets
- `full` — All checks (default)
- `pre-commit` — Syntax + secrets + git status
- `pre-deploy` — Full checks plus API verification
