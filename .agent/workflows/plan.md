---
description: Restate requirements, assess risks, and create step-by-step implementation plan. WAIT for user CONFIRM before touching any code.
---

# Plan Command

This workflow invokes the **planner** skill to create a comprehensive implementation plan before writing any code.

## What This Command Does

1. **Restate Requirements** — Clarify what needs to be built
2. **Identify Risks** — Surface potential issues and blockers
3. **Create Step Plan** — Break down implementation into phases
4. **Wait for Confirmation** — MUST receive user approval before proceeding

## When to Use

Use `/plan` when:
- Starting a new feature
- Making significant architectural changes
- Working on complex refactoring
- Multiple files/components will be affected
- Requirements are unclear or ambiguous

## How It Works

1. **Analyze the request** and restate requirements in clear terms
2. **Break down into phases** with specific, actionable steps
3. **Identify dependencies** between components
4. **Assess risks** and potential blockers
5. **Estimate complexity** (High/Medium/Low)
6. **Present the plan** and WAIT for explicit confirmation

## Important Notes

**CRITICAL**: The planner will **NOT** write any code until you explicitly confirm the plan.

If you want changes, respond with:
- "modify: [your changes]"
- "different approach: [alternative]"
- "skip phase 2 and do phase 3 first"

## Integration

After planning:
- Use `/build-fix` if build errors occur
- Use `/code-review` to review completed implementation
- Use `/verify` for comprehensive checks

## POLYPROPHET Context

When planning for POLYPROPHET, always consider:
- IS_LIVE flag chain implications
- Strategy set integrity
- Min-order bump path at micro bankrolls
- Lite-vs-legacy comparison for affected systems
