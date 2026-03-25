# AGENTS.md

This repository uses a **hybrid harness**:

- **Primary authority**: `README.md` + `.agent/skills/DEITY/SKILL.md`
- **Additive baseline**: local ECC adaptation derived from `affaan-m/everything-claude-code`

This file is the cross-harness entrypoint for agents that understand `AGENTS.md`.

## Read Order

1. `README.md`
2. `.agent/skills/DEITY/SKILL.md`
3. `.agent/skills/ECC_BASELINE/SKILL.md`
4. Relevant `.windsurf/workflows/*.md`

## Operating Rules

- Research before editing.
- Prefer parallel reads/searches for independent investigation.
- Keep changes small and reversible.
- Verify before and after responding.
- Do not replace DEITY with generic harness defaults.
- Treat local ECC guidance as **additive**, not authoritative over repo-specific rules.

## Repository Validation Gates

### Runtime / JavaScript changes

- Run `node --check server.js` after touching runtime code.
- Run targeted verification commands/tests when relevant.

### Runtime / dashboard / execution changes

- Verify `/api/health`, `/api/status`, and `/api/wallet/balance`.
- Check dashboard/API truthfulness parity.
- Compare against `legacy-root-runtime/` when changing behavior that used to exist there.

### Security-sensitive changes

- Never hardcode secrets.
- Keep `POLYPROPHET.env` and live credentials out of commits.
- Review auth, proxy, and settings/control-plane implications before finalizing.

## ECC Adaptation Boundary

The upstream ECC repository was investigated directly before this file was created.

Verified from inspected upstream files:

- ECC provides portable rules, skills, agents, commands, and install tooling.
- ECC explicitly documents install targets for Claude Code, Cursor, and Antigravity in the inspected install docs.
- I did **not** verify a native Windsurf install target in the upstream install flow I inspected.

Because of that, this workspace uses a **local Windsurf adaptation** instead of pretending a one-command native ECC-to-Windsurf install exists.

## Local ECC Adaptation Files

- `AGENTS.md`
- `.agent/skills/ECC_BASELINE/SKILL.md`
- `.windsurf/workflows/ecc-research-first.md`

These files import the useful ECC principles that fit this repo:

- research-first development
- evidence-backed verification
- security checks before risky changes
- parallel exploration when independent
- small, focused implementation steps

They intentionally do **not** import generic ECC behavior that would conflict with POLYPROPHET-specific DEITY rules.
