---
description: Run a deterministic harness audit and return the top repo-specific continuity actions.
---

# Harness Audit

Use the upstream ECC audit script as the scoring source of truth.

## Command

Run:

```bash
node external/everything-claude-code/scripts/harness-audit.js repo --format text --root .
```

## Output Contract

Return:

1. overall score
2. category breakdown
3. top 3 actions from the script
4. which actions are already satisfied by `.agent/`, `.windsurf/`, `README.md`, or `AGENTS.md`
5. which remaining actions are still blocked by cross-IDE limitations

## POLYPROPHET Notes

- Treat low tool-coverage findings carefully because this repo intentionally uses a project-local `.agent/` harness instead of depending on user-global ECC installs.
- Prefer repo-local continuity improvements over user-home assumptions.
- If the script and current repo reality differ, report both truthfully.
