# Testing Requirements

## Test Types

1. **Syntax Validation** — `node --check server.js` after every runtime edit
2. **Targeted Tests** — `npm test` when test suite exists
3. **API Verification** — `/api/health`, `/api/status`, `/api/wallet/balance`
4. **UI/Runtime Truthfulness** — Dashboard must match API truth
5. **Documentation Consistency** — README must reflect live state

## Test-Driven Development (When Applicable)

MANDATORY workflow for new features:
1. Write test first (RED)
2. Run test — it should FAIL
3. Write minimal implementation (GREEN)
4. Run test — it should PASS
5. Refactor (IMPROVE)

## POLYPROPHET Validation Chain

For this repository, the preferred validation order is:

1. `node --check server.js` — syntax gate
2. `npm test` — if tests exist
3. `GET /api/health` — runtime mode, strategy sets, timeframes
4. `GET /api/status` — risk, executor, markets, orchestrator
5. `GET /api/wallet/balance` — wallet balance breakdown
6. Dashboard inspection — does UI match API truth?
7. Lite-vs-legacy comparison — when touching behavior that existed in `legacy-root-runtime/`

## Troubleshooting Test Failures

1. Check test isolation
2. Verify mocks are correct
3. Fix implementation, not tests (unless tests are wrong)
