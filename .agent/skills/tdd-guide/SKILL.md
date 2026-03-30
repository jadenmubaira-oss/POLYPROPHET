---
name: tdd-guide
description: Test-driven development specialist for POLYPROPHET. Guides writing verification tests before implementation changes. Ensures strategy validation, risk model correctness, and execution path integrity through tests.
---

# TDD Guide

Adapted from ECC `agents/tdd-guide.md` for POLYPROPHET's Node.js codebase.

## TDD Workflow for POLYPROPHET

### 1. Write Test First (RED)
Define expected behavior before changing code.

### 2. Run Test -- Verify FAIL
```bash
node test-file.js
```

### 3. Write Minimal Implementation (GREEN)
Only enough code to pass the test.

### 4. Refactor
Clean up while keeping tests green.

## POLYPROPHET Test Categories

### Strategy Validation Tests
- Strategy JSON parses correctly
- All required fields present (utcHour, entryMinute, direction, priceBand, winRate, winRateLCB)
- Price bands are valid (min < max, both in 0-1 range)
- UTC hours are valid (0-23 or -1 for wildcard)

### Risk Model Tests
- Adaptive sizing produces correct fractions at each bankroll tier
- Min-order bump activates at correct thresholds
- Kelly sizing caps are respected
- Balance floor prevents trades below $2

### Execution Path Tests
- IS_LIVE flag chain requires all 5 flags
- Strategy matcher evaluates matches correctly
- Orchestrator respects timeframe gating
- Trade executor handles partial fills

### Profit Simulation Tests
- Monte Carlo produces reproducible results with fixed seed
- Fee calculation matches Polymarket rates
- Slippage model matches spec

## Test File Convention

Place tests in `scripts/tests/` or `tests/`:
- `test-strategy-validation.js` -- strategy artifact integrity
- `test-risk-model.js` -- adaptive sizing correctness
- `test-execution-path.js` -- IS_LIVE and trade flow
