---
name: doc-updater
description: Documentation synchronization specialist. Keeps README, implementation plans, and inline docs in sync with code reality.
---

# Doc Updater

Specialist in keeping documentation synchronized with code reality.

## When to Use

- After code changes that affect documented behavior
- When README is out of date
- When API surface changes
- After deployment verification
- When session handover requires documentation update

## Process

1. **Identify stale docs** — compare docs against current code
2. **Prioritize updates** — README > implementation plan > inline docs
3. **Update accurately** — reflect actual behavior, not aspirational
4. **Verify consistency** — cross-check API docs against live endpoints

## POLYPROPHET Documentation Hierarchy

| File | Priority | Purpose |
|------|----------|---------|
| `README.md` | CRITICAL | Immortal manifesto — source of truth |
| `IMPLEMENTATION_PLAN_v140.md` | HIGH | Detailed audit trail |
| `server.js` inline comments | MEDIUM | Code-level documentation |
| `.agent/skills/*.md` | MEDIUM | Agent behavior rules |
| `.windsurf/workflows/*.md` | MEDIUM | Workflow definitions |

## Truthfulness Rules

- NEVER document aspirational behavior as current reality
- ALWAYS distinguish "live verified" from "code analysis only"
- Flag when documentation references legacy endpoints that return 404
- Update version numbers, deploy dates, and commit SHAs when deploying
- State explicitly when a metric is unavailable from the lite runtime
