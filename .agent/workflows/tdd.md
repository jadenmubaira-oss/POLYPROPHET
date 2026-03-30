---
description: Test-driven development workflow. Write tests first, implement, verify.
---

# Test-Driven Development

## TDD Workflow

### 1. RED — Write Test First

- Write a test that describes the expected behavior
- Run the test — it MUST fail
- If the test passes immediately, the test is wrong or the feature already exists

### 2. GREEN — Minimal Implementation

- Write the minimum code to make the test pass
- Don't over-engineer — solve ONLY what the test requires
- Run the test — it MUST pass

### 3. IMPROVE — Refactor

- Clean up the implementation
- Verify test still passes
- Check coverage

## POLYPROPHET Testing Approach

Since POLYPROPHET is a trading bot with no formal test suite yet:

### Syntax-Level TDD
1. Before editing `server.js` or `lib/*.js`: note the current `node --check` state
2. Make the change
3. Verify `node --check server.js` still passes

### API-Level TDD
1. Document expected API response before change
2. Make the change
3. Verify API response matches expectation via `/api/health`, `/api/status`

### Strategy-Level TDD
1. Document expected strategy match behavior
2. Make the change
3. Verify strategy loading and matching via `/api/health` → strategySets

## Troubleshooting

1. Check test isolation
2. Verify assumptions about state
3. Fix implementation, not tests (unless tests are wrong)
4. When in doubt, add more assertions, not less
