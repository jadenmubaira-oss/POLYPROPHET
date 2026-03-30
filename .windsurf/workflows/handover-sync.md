---
description: Mandatory README + harness synchronization before ending a substantial task
---

# Handover Sync Workflow

Use this workflow at the end of any substantial task so a new agent can continue with minimal chat history.

## Required Updates

1. Update `README.md` with:
   - what was done
   - what remains pending
   - any discrepancies or caveats
   - the next best action
2. Update `AGENTS.md` if read order, harness structure, or installed local workflows changed.
3. Update task state or plan state so pending work is explicit.
4. If repo truth changed, ensure the relevant `.agent/` or `.windsurf/` workflow text still matches reality.

## Truthfulness Rules

- Do not claim live proof you do not have.
- Do not carry stale deployment or runtime claims forward.
- If a prior README section is stale, append a corrective addendum or update the relevant handoff section.

## Final Check

Before closing the task, verify that a new agent could answer all of the following from repo files alone:

- What is the current objective?
- What was just changed?
- What is still blocked?
- What should happen next?
- Which files are authoritative?
