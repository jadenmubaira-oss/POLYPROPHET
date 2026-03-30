---
description: Pre-commit quality check for POLYPROPHET codebase
---

# Quality Gate Workflow

Adapted from ECC `commands/quality-gate.md`.

## Pipeline

1. **Syntax Check**: `node --check server.js` + `node --check lib/*.js`
2. **Strategy Artifacts**: Verify all configured strategy JSONs parse correctly
3. **Security Scan**: Check for hardcoded secrets, `.env` files in staging area
4. **Harness Integrity**: Verify authority files exist (README.md, AGENTS.md, DEITY SKILL.md)
5. **Git Hygiene**: Check for large files, sensitive data in diff

## Run

```bash
node scripts/verify-harness.js
```

## POLYPROPHET-Specific Checks

- No `POLYMARKET_PRIVATE_KEY` values in any committed file
- No `.env` files staged (only `.env.example` is tracked)
- Strategy files in `debug/` whitelist are present and valid JSON
- `render.yaml` points to correct start command
- `package.json` dependencies are consistent with `package-lock.json`
