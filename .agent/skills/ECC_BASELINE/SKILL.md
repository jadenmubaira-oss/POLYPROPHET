---
name: ECC_BASELINE
description: Local research-first, testing-aware, security-aware ECC baseline adapted from everything-claude-code for POLYPROPHET and Windsurf.
---

# ECC_BASELINE

Full ECC harness (v1.9.0) installed and adapted for this POLYPROPHET workspace. DEITY remains primary authority — ECC is additive.

## Read Order

1. `README.md`
2. `.agent/skills/DEITY/SKILL.md`
3. This file
4. `.agent/rules/*.md` — Flattened ECC rules
5. Relevant `.agent/workflows/*.md` or `.windsurf/workflows/*.md`

## What's Installed

### Rules (`.agent/rules/`)
- `coding-style.md` — Immutability, file organization, error handling, code quality
- `security.md` — OWASP checks, secret management, POLYPROPHET wallet security
- `testing.md` — Validation chain, TDD workflow, POLYPROPHET verification order
- `git-workflow.md` — Commit format, PR workflow, POLYPROPHET deploy steps
- `performance.md` — Context management, build troubleshooting, POLYPROPHET perf notes
- `patterns.md` — Repository pattern, API format, POLYPROPHET architecture patterns
- `hooks.md` — Hook reference (non-executable in Antigravity)
- `agents.md` — Agent orchestration, priority hierarchy, parallel execution
- `javascript.md` — JS/Node.js coding standards, async patterns, Express best practices

### Skills (`.agent/skills/`)
- `planner` — Implementation planning specialist
- `code-reviewer` — Security and quality review
- `security-reviewer` — OWASP and vulnerability detection
- `build-error-resolver` — Minimal-diff error fixing
- `architect` — System design and scalability
- `refactor-cleaner` — Dead code cleanup
- `doc-updater` — Documentation synchronization
- `loop-operator` — Autonomous loop execution

### Workflows (`.agent/workflows/`)
- `/plan` — Step-by-step implementation planning
- `/code-review` — Comprehensive security and quality review
- `/build-fix` — Incremental build error fixing
- `/verify` — Comprehensive codebase verification
- `/refactor-clean` — Dead code cleanup
- `/tdd` — Test-driven development

## Core Principles (from ECC)

### 1. Research First
Before code changes: identify authoritative files, read fully, map state, distinguish primary from fallback.

### 2. Parallel Exploration
Batch independent reads/searches. Read multiple files, inspect backend + UI + docs together.

### 3. Small, Reversible Edits
Prefer smallest justified change. Avoid speculative rewrites. Preserve working conventions.

### 4. Security Gate
Check: no hardcoded secrets, no auth weakening, no env files exposed, input boundaries validated.

### 5. Validation Gate
For this repository:
- Runtime JS → `node --check server.js`
- API/dashboard → verify `/api/health`, `/api/status`, `/api/wallet/balance`
- Execution/risk → compare against `legacy-root-runtime/`

### 6. Testing Posture
Preferred validation order: syntax → targeted tests → API verification → UI truthfulness → doc consistency.

### 7. Documentation Truthfulness
Never claim: unverified capabilities, broader compatibility than researched, guarantees not validated.

## Install State

See `.agent/ecc-install-state.json` for the complete manifest of installed files.

## Intentionally Not Imported

- Claude Code plugin infrastructure (hooks.json execution)
- Claude-specific install commands and paths
- Generic agent names that don't exist in Antigravity
- Blanket coverage requirements detached from this repo's test surface
- Any instruction that would override DEITY or the POLYPROPHET manifesto
