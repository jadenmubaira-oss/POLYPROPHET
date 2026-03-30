---
description: Create or verify a workspace checkpoint for safe rollback
---

# Checkpoint Workflow

Adapted from ECC `commands/checkpoint.md`.

## Create Checkpoint

1. Run `node --check server.js` to ensure syntax is clean
2. Run `git stash` or `git commit` with checkpoint name
3. Log: `echo "[date] | [name] | [sha]" >> .agent/checkpoints.log`
4. Report checkpoint created

## Verify Checkpoint

1. Read checkpoint from `.agent/checkpoints.log`
2. Compare current state: files changed, tests passing
3. Report delta since checkpoint

## POLYPROPHET Usage

```
/checkpoint create "pre-strategy-change"
/checkpoint verify "pre-strategy-change"
/checkpoint list
```
