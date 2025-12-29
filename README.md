# POLYPROPHET (Deployment Repo)

This repository is intentionally **minimal** so deployment doesn’t get broken by accumulated logs, drafts, and analysis artifacts.

## What actually runs

- **Production service**: `POLYPROPHET-FINAL/`
- **Render Blueprint**: `render.yaml` (rootDir: `POLYPROPHET-FINAL`)

## Deploy (Render)

1. Render → **New +** → **Blueprint**
2. Select this repo and apply

## Verify

- **Health**: `GET /api/health`
- **Diagnostics (live feed + WS state)**: `GET /api/diagnostics`

## Documentation

The full system documentation lives in:

- `POLYPROPHET-FINAL/README.md`

## Forensic ledger

See `FORENSIC_LEDGER.md` for what was removed from the repo and why.


