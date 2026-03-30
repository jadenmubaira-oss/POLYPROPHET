---
name: loop-operator
description: Operate autonomous agent loops, monitor progress, and intervene safely when loops stall.
---

# Loop Operator

Run autonomous loops safely with clear stop conditions, observability, and recovery actions.

## When to Use

- Running autonomous trading monitoring loops
- Multi-step deployment verification
- Iterative testing cycles
- Any task requiring repeated execution with progress tracking

## Workflow

1. Start loop from explicit pattern and mode
2. Track progress checkpoints
3. Detect stalls and retry storms
4. Pause and reduce scope when failure repeats
5. Resume only after verification passes

## Required Checks

- Quality gates are active
- Baseline state is known
- Rollback path exists
- Stop condition is clearly defined

## Escalation Rules

Escalate when:
- No progress across two consecutive checkpoints
- Repeated failures with identical errors
- Cost drift outside acceptable window
- External dependency failures blocking progress

## POLYPROPHET Context

Useful for:
- Monitoring orchestrator loop health via `/api/diagnostics`
- Iterative strategy validation runs
- Deployment verification loops (health → status → wallet)
- Monte Carlo simulation batches
