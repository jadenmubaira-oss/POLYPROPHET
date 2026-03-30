# Agent Orchestration

## Available Skills (Agents)

| Skill | Purpose | When to Use |
|-------|---------|-------------|
| DEITY | Unified POLYPROPHET agent | All POLYPROPHET tasks (PRIMARY) |
| EXECUTION | High-precision implementation | Code changes, deployment |
| ULTRATHINK | Deep analysis mode | Strategy research, architecture |
| ECC_BASELINE | Research-first baseline | Additive principles (never overrides DEITY) |
| planner | Implementation planning | Complex features, refactoring |
| architect | System design | Architectural decisions |
| code-reviewer | Code review | After writing/modifying code |
| security-reviewer | Security analysis | Before commits, sensitive code |
| build-error-resolver | Fix build errors | When build fails |
| refactor-cleaner | Dead code cleanup | Code maintenance |
| doc-updater | Documentation sync | Updating docs |
| loop-operator | Autonomous loop execution | Run loops safely, monitor stalls |
| harness-optimizer | Harness quality and continuity improvement | When improving repo handoff, workflows, or local agent infrastructure |
| typescript-reviewer | JavaScript and TypeScript review specialist | After JS/TS runtime, dashboard, or harness changes |

## Priority Hierarchy

1. **DEITY** — Always primary authority for POLYPROPHET
2. **EXECUTION / ULTRATHINK** — Specialized modes of DEITY
3. **ECC Skills** — Additive, never override DEITY

## Parallel Task Execution

ALWAYS use parallel execution for independent operations:

```markdown
# GOOD: Parallel exploration
- Read strategy-matcher.js AND risk-manager.js simultaneously
- Query /api/health AND /api/status together
- Check README AND implementation plan in parallel

# BAD: Sequential when unnecessary
- First read one file, then the other, then the third
```
