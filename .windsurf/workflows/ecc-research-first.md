---
description: ECC Research-First Workflow (Windsurf Adaptation for POLYPROPHET)
---

# ECC Research-First Workflow (Windsurf Adaptation)

Use this workflow when you want ECC-style research-first execution inside Windsurf **without replacing** the repository's DEITY protocol.

## Purpose

Apply the useful ECC baseline to this workspace:

- research before implementation
- validate claims with evidence
- keep changes small and reversible
- include security and truthfulness checks
- use parallel exploration for independent work

## Step 1 — Establish authority

Before changing code, read the local authority chain:

1. `README.md`
2. `.agent/skills/DEITY/SKILL.md`
3. `.agent/skills/ECC_BASELINE/SKILL.md`
4. Relevant `.windsurf/workflows/*.md`

If they conflict, the repo-specific DEITY/README guidance wins.

## Step 2 — Map the task before editing

Identify:

- the authoritative file(s)
- primary vs fallback logic
- state ownership (memory, disk, Redis, API, UI)
- likely consumers that could drift if a central behavior changes
- whether `legacy-root-runtime/` contains relevant reference behavior

## Step 3 — Research first

Before implementation:

- read the most relevant source files fully
- inspect UI/API/docs together when surfaced behavior is involved
- use parallel file reads/searches for independent investigation
- check what is *not* mentioned, not just what is mentioned

## Step 4 — Implement conservatively

- choose the smallest justified change
- avoid speculative rewrites
- preserve working repo-specific harness and runtime conventions unless explicitly asked to change them

## Step 5 — Run repo-realistic validation

### If runtime JavaScript changed

```bash
node --check server.js
```

### If runtime/API/dashboard behavior changed

Verify:

- `GET /api/health`
- `GET /api/status`
- `GET /api/wallet/balance`
- the corresponding dashboard surface

### If security/auth/proxy/config changed

Review:

- secrets exposure risk
- auth bypass risk
- settings/control-plane risk
- proxy routing implications

## Step 6 — Keep conclusions honest

When reporting findings:

- distinguish local code truth from live proof
- distinguish upstream ECC support from local adaptation
- explicitly state assumptions, limitations, and unresolved ambiguity
- do not claim native Windsurf ECC support unless verified directly

## Step 7 — Handover cleanly

For substantial work:

- update `README.md` Current Session State
- record what was changed
- record what remains pending
- record why the chosen adaptation was safer than more invasive alternatives
