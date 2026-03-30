# AGENTS.md

This repository uses a **hybrid harness**:

- **Primary authority**: `README.md` + `.agent/skills/DEITY/SKILL.md`
- **Full ECC baseline**: Adapted from `affaan-m/everything-claude-code` (v1.9.0)

This file is the cross-harness entrypoint for agents that understand `AGENTS.md`.

**Continuity rule**: `README.md` is the canonical handoff document. After every substantial task, update `README.md` so a new agent can continue with minimal or zero chat history.

## Read Order

1. `README.md`
2. `.agent/skills/DEITY/SKILL.md`
3. `.agent/skills/ECC_BASELINE/SKILL.md`
4. `IMPLEMENTATION_PLAN_v140.md`
5. `.agent/rules/*.md` — ECC-derived rules (security, coding style, testing, etc.)
6. Relevant `.agent/workflows/*.md` or `.windsurf/workflows/*.md`

## Installed ECC Components

### Rules (`.agent/rules/`)

| Rule | Source |
|------|--------|
| `coding-style.md` | ECC `rules/common/coding-style.md` |
| `security.md` | ECC `rules/common/security.md` + POLYPROPHET tailoring |
| `testing.md` | ECC `rules/common/testing.md` + POLYPROPHET validation chain |
| `git-workflow.md` | ECC `rules/common/git-workflow.md` + POLYPROPHET deploy |
| `performance.md` | ECC `rules/common/performance.md` + POLYPROPHET notes |
| `patterns.md` | ECC `rules/common/patterns.md` + POLYPROPHET architecture |
| `hooks.md` | ECC `rules/common/hooks.md` (reference only) |
| `agents.md` | ECC `rules/common/agents.md` + POLYPROPHET hierarchy |
| `javascript.md` | JS/Node.js standards for this project |
| `typescript.md` | TS/JS review guardrails adapted for this Node.js-heavy workspace |

### Skills (`.agent/skills/`)

| Skill | Origin | Purpose |
|-------|--------|---------|
| **DEITY** | POLYPROPHET | Unified oracle agent (PRIMARY) |
| **EXECUTION** | POLYPROPHET | High-precision implementation |
| **ULTRATHINK** | POLYPROPHET | Deep analysis mode |
| **ECC_BASELINE** | Local ECC adaptation | Research-first baseline |
| planner | ECC `agents/planner.md` | Implementation planning |
| code-reviewer | ECC `agents/code-reviewer.md` | Code quality and security review |
| security-reviewer | ECC `agents/security-reviewer.md` | Vulnerability detection |
| build-error-resolver | ECC `agents/build-error-resolver.md` | Build error fixing |
| architect | ECC `agents/architect.md` | System design |
| refactor-cleaner | ECC `agents/refactor-cleaner.md` | Dead code cleanup |
| doc-updater | ECC `agents/doc-updater.md` | Documentation sync |
| loop-operator | ECC `agents/loop-operator.md` | Autonomous loop execution |
| harness-optimizer | ECC-derived + POLYPROPHET tailored | Improve repo harness quality and continuity |
| typescript-reviewer | ECC-derived + POLYPROPHET tailored | JS/TS review specialist for runtime and dashboard code |
| performance-optimizer | ECC `agents/performance-optimizer.md` + POLYPROPHET | Node.js runtime bottleneck analysis |
| e2e-runner | ECC `agents/e2e-runner.md` + POLYPROPHET | End-to-end signal flow verification |
| tdd-guide | ECC `agents/tdd-guide.md` + POLYPROPHET | Test-driven development for verification tests |
| docs-lookup | ECC `agents/docs-lookup.md` + POLYPROPHET | Polymarket API and library documentation research |

### Workflows (`.agent/workflows/` + `.windsurf/workflows/`)

| Workflow | Origin | Purpose |
|----------|--------|---------|
| `/plan` | ECC `commands/plan.md` | Implementation planning |
| `/code-review` | ECC `commands/code-review.md` | Security and quality review |
| `/build-fix` | ECC `commands/build-fix.md` | Incremental error fixing |
| `/verify` | ECC `commands/verify.md` | Comprehensive verification |
| `/refactor-clean` | ECC `commands/refactor-clean.md` | Dead code cleanup |
| `/tdd` | ECC `commands/tdd.md` | Test-driven development |
| `/harness-audit` | ECC `commands/harness-audit.md` | Deterministic harness score + top actions |
| `/loop-start` | ECC `commands/loop-start.md` | Managed autonomous loop kickoff |
| `/loop-status` | ECC `commands/loop-status.md` | Loop monitoring and intervention guidance |
| `/checkpoint` | ECC `commands/checkpoint.md` | Save/restore workspace checkpoints |
| `/resume-session` | ECC `commands/resume-session.md` | Resume from README handoff state |
| `/quality-gate` | ECC `commands/quality-gate.md` | Pre-commit quality checks |
| `/skill` | POLYPROPHET | Full DEITY protocol |
| `atlas-build-app` | POLYPROPHET | ATLAS build methodology |
| `ecc-research-first` | Local ECC adaptation | Research-first workflow |
| `handover-sync` | POLYPROPHET | Mandatory README + repo handoff synchronization |
| `oracle-certainty-audit` | POLYPROPHET | Strategy certainty audit |
| `review` | POLYPROPHET | Code review for bugs |

## Operating Rules

- Research before editing.
- Prefer parallel reads/searches for independent investigation.
- Keep changes small and reversible.
- Verify before and after responding.
- Do not replace DEITY with generic harness defaults.
- Treat ECC guidance as **additive**, not authoritative over repo-specific rules.
- Treat `README.md` as the primary cross-agent transfer surface and keep it current after substantial work.
- If the repo's current truth differs from older README/plan/harness text, update the docs instead of silently carrying stale assumptions.

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

## ECC Install State

The full ECC install is tracked in `.agent/ecc-install-state.json`. This file records:
- Which files ECC installed (for safe uninstall/repair)
- Which files are preserved (repo-specific, not from ECC)
- Version and adaptation type

## ECC Adaptation Boundary

**Source**: `affaan-m/everything-claude-code` v1.9.0

All ECC-derived files have been:
1. Mapped via the official Antigravity target (`rules/` → `.agent/rules/`, `agents/` → `.agent/skills/`, `commands/` → `.agent/workflows/`)
2. Tailored with POLYPROPHET-specific context (IS_LIVE flag chain, strategy sets, wallet security, etc.)
3. Constrained so they never override DEITY or the POLYPROPHET manifesto

## Cross-IDE / Cross-Agent Boundary

This workspace carries a **project-local harness** that works across all supported IDEs and AI agents:

| Layer | Path | Purpose |
|-------|------|---------|
| Primary handoff | `README.md` | Human + agent source of truth |
| Harness map | `AGENTS.md` | This file -- cross-IDE entrypoint |
| Antigravity | `.agent/` | Local skills/rules/workflows (ECC-adapted) |
| Windsurf | `.windsurf/workflows/` | Windsurf-native workflow entrypoints |
| Claude Code | `.claude/` + `CLAUDE.md` | Claude Code settings and redirect |
| Cursor | `.cursor/rules/` | Cursor MDC rules file |
| Codex/OpenAI | `.codex/` | Codex-compatible instructions |
| Factory/Droid | `.factory/droids/` | Factory project droids (auditor, researcher, verifier, handover) |
| ECC upstream | `external/everything-claude-code/` | Pinned reference clone for re-audit/re-sync |

### Factory Droids (`.factory/droids/`)

| Droid | Purpose |
|-------|---------|
| `polyprophet-auditor` | Full runtime, strategy, dashboard, truth-surface audit |
| `strategy-researcher` | Strategy investigation, profit sims, evidence-backed recommendations |
| `deploy-verifier` | Post-deploy endpoint verification and GO/NO-GO status |
| `handover-agent` | End-of-session README update and handoff preparation |

### Automated Verification

Run `node scripts/verify-harness.js` to check all authority files, strategy artifacts, code syntax, and cross-IDE layers exist and are valid.

Practical limit: no repository can force every external IDE or AI to auto-install support universally. The repo ships enough local authority and handoff structure that any agent which reads repo files can resume work accurately.
