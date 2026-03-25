---
name: ECC_BASELINE
description: Local research-first, testing-aware, security-aware ECC baseline adapted from everything-claude-code for POLYPROPHET and Windsurf.
---

# ECC_BASELINE

This skill adapts the useful parts of `affaan-m/everything-claude-code` to this repository **without overriding DEITY**.

## Read Order

1. `README.md`
2. `.agent/skills/DEITY/SKILL.md`
3. This file
4. Relevant `.windsurf/workflows/*.md`

## Purpose

Use this skill as the local ECC-derived baseline for:

- research-first investigation
- security-aware implementation
- evidence-backed validation
- small, reversible changes
- tool-efficient exploration

## Core Rules

### 1. Research First

Before code changes:

- identify the authoritative files
- read the relevant files fully
- map where state lives and what calls what
- distinguish primary logic from fallback paths

### 2. Parallel Exploration

When tasks are independent, batch reads/searches together instead of exploring sequentially.

Examples:

- read multiple related files in parallel
- inspect backend + UI + docs together when a surfaced behavior may drift
- compare current runtime with legacy reference files when touching central behavior

### 3. Small, Reversible Edits

- prefer the smallest change that satisfies the requirement
- avoid broad rewrites without concrete evidence they are necessary
- preserve working repo-specific harness behavior unless the user explicitly wants it changed

### 4. Security Gate

Before finishing security-relevant work, check:

- no secrets were hardcoded
- no auth/control-plane protections were weakened accidentally
- no sensitive local env files were exposed
- external input boundaries are validated where relevant

Treat `POLYPROPHET.env` and live credentials as sensitive.

### 5. Validation Gate

Use repo-realistic validation instead of generic claims.

For this repository:

- runtime JS edits -> `node --check server.js`
- runtime/API/dashboard changes -> verify `/api/health`, `/api/status`, `/api/wallet/balance`, plus UI parity when relevant
- execution/risk/runtime changes -> compare touched behavior against `legacy-root-runtime/` when that comparison is meaningful

### 6. Testing Posture

ECC's generic testing philosophy is useful, but this repo should not pretend to have blanket test coverage it does not currently maintain.

Preferred order here:

1. syntax validation
2. targeted command/test execution when available
3. API verification
4. UI/runtime truthfulness checks
5. documentation consistency check

### 7. Documentation Truthfulness

Do not claim:

- native Windsurf ECC support unless verified
- broader install compatibility than was actually researched
- repo guarantees that were not validated locally or from live/runtime evidence

## Upstream-Derived Principles Retained

These ECC ideas were intentionally retained in this local adaptation:

- research-first development
- explicit security review
- boundary validation
- evidence over assumption
- use parallel analysis when independent
- prefer focused files and explicit reasoning

## Intentionally Not Imported Verbatim

These ECC elements were intentionally **not** copied directly into repo authority:

- Claude plugin install commands
- `.claude/rules` conventions as authoritative repo behavior
- generic agent names/tools that do not exist in Windsurf here
- blanket coverage requirements detached from this repo's actual test surface
- any instruction that would override DEITY or the POLYPROPHET manifesto
