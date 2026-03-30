---
description: Resume work from a previous AI session using README handoff state
---

# Resume Session Workflow

Adapted from ECC `commands/resume-session.md` for POLYPROPHET's README-based handoff.

## Process

### Step 1: Load Session State

1. Read `README.md` fully
2. Find the `<!-- HANDOFF_STATE_START -->` / `<!-- HANDOFF_STATE_END -->` block
3. Extract: last agent, date, what was done, what is pending, discrepancies, next action

### Step 2: Verify Current State

1. Run `git status` to check for uncommitted changes
2. Run `git log --oneline -5` for recent commits
3. Run `node --check server.js` for syntax health
4. Optionally query `/api/health` for live runtime state

### Step 3: Orient and Report

State to the user:
```
I am [Agent] resuming from [Last Agent]'s session on [Date].
Current state: [summary from handoff block]
Pending: [list from handoff block]
Next action: [from handoff block]
```

### Step 4: Continue Work

Pick up from the documented next action. Do not re-investigate what the previous agent already verified unless there is reason to doubt it.

## POLYPROPHET-Specific

- Always read DEITY SKILL.md after README
- Check IMPLEMENTATION_PLAN_v140.md for detailed audit trail
- If live runtime claims seem stale (>24h), re-verify with live endpoints
