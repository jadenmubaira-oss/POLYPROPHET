---
description: Start a managed autonomous work loop with README-first safety gates.
---

# Loop Start

Use this workflow to prepare a bounded autonomous loop.

## Required Preconditions

1. Read `README.md` fully.
2. Read `.agent/skills/DEITY/SKILL.md`.
3. Confirm the loop has a concrete stop condition.
4. Confirm the repo state is documented in `README.md`.
5. Confirm the task will not cause unverified live-trading claims.

## Loop Setup

- choose a loop pattern
- define success criteria
- define stop criteria
- define required verification gates
- define which files must be updated before handoff

## Required Safety Gates

- if runtime code changes, run `node --check server.js`
- if surfaced runtime truth changes, verify API and README parity
- if strategy or live-trading posture changes, verify live endpoints before making claims
- end every loop cycle with a README handoff update when repo truth changed
