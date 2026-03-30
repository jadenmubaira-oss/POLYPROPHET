# POLYPROPHET — Claude Code Instructions

This file redirects Claude Code to the project's unified harness.

## Read Order

1. `README.md` — Immortal manifesto, source of truth for all agents
2. `AGENTS.md` — Cross-harness map with installed rules, skills, workflows
3. `.agent/skills/DEITY/SKILL.md` — Unified agent protocol
4. `.agent/skills/ECC_BASELINE/SKILL.md` — Research-first baseline
5. `IMPLEMENTATION_PLAN_v140.md` — Detailed audit trail

## Key Rules

- README.md is the canonical handoff document. Update it after every substantial task.
- DEITY is the primary authority. ECC is additive, never overrides DEITY.
- Never hardcode secrets. Keep `POLYPROPHET.env` out of commits.
- Research before editing. Verify before and after responding.
- Run `node --check server.js` after touching runtime code.

## Project Summary

POLYPROPHET is an autonomous Polymarket trading bot. The lite runtime (`server.js`) uses strategy-native entry generation across 15m/4h/5m crypto up/down markets with adaptive bankroll sizing, walk-forward validated strategies, and CLOB order execution via proxy.

See `README.md` for current runtime truth, live deployment status, and the full agent collaboration protocol.
