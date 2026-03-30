# POLYPROPHET — Codex/OpenAI Agent Instructions

## Read Order

1. `README.md` — Immortal manifesto, source of truth for all agents
2. `AGENTS.md` — Cross-harness map with installed rules, skills, workflows
3. `.agent/skills/DEITY/SKILL.md` — Unified agent protocol

## Project

POLYPROPHET is an autonomous Polymarket trading bot. The lite runtime (`server.js`) uses strategy-native entry generation across 15m/4h/5m crypto up/down markets.

## Rules

- README.md is the canonical handoff document. Update it after every substantial task.
- Research before editing. Verify before and after responding.
- Run `node --check server.js` after touching runtime code.
- Never hardcode secrets.
- State DATA SOURCE for every performance claim.
- If not certain, ask the user.

## Harness Location

- Rules: `.agent/rules/`
- Skills: `.agent/skills/`
- Workflows: `.agent/workflows/` and `.windsurf/workflows/`
- Factory droids: `.factory/droids/`
