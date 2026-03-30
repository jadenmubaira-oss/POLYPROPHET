---
description: Dead code cleanup and refactoring with minimal, safe changes.
---

# Refactor Clean

Identify and remove dead code, simplify complex structures, improve maintainability.

## Step 1: Identify Targets

Scan for:
- Unused imports and variables
- Commented-out code blocks (>5 lines)
- Unreachable code branches
- Duplicate functionality across files
- Functions exceeding 50 lines
- Files exceeding 800 lines

## Step 2: Assess Impact

For each target:
1. **What depends on it?** — grep for usages across codebase
2. **Is it intentionally preserved?** — check comments, README references
3. **Will removal break anything?** — trace call graph

## Step 3: Remove Incrementally

1. Remove one target at a time
2. Run `node --check server.js` after each removal
3. Run `npm test` after each removal
4. If anything breaks, revert and move on

## Step 4: Verify

- Syntax check passes
- Tests pass
- No functional regression
- File sizes reduced where targeted

## POLYPROPHET Exclusions

Do NOT clean:
- `legacy-root-runtime/` — intentionally preserved archive
- `strategies/` fallback sets — safety net
- `debug/` artifacts — validated strategy data
- Any code explicitly marked "keep for reference"
