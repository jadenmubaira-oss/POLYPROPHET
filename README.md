# POLYPROPHET GOAT v3 - The Ceiling

**MAX PROFIT ASAP WITH MIN VARIANCE**

> See [`GOALS_AND_ACCEPTANCE.md`](GOALS_AND_ACCEPTANCE.md) for the definitive goals, acceptance criteria, and configuration decisions.

## Deployment

- **Production runtime**: repo root `server.js` (**v46 baseline**)
- **Render Blueprint**: `render.yaml` (no `rootDir` — deploys from repo root)
- **Verification**: See [`FINAL_VERIFICATION_REPORT.md`](FINAL_VERIFICATION_REPORT.md)

### Deploy to Render

1. Render → **New +** → **Blueprint**
2. Select this repo and apply
3. Configure environment variables in Render dashboard

### Required Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `TRADE_MODE` | `PAPER` or `LIVE` | `PAPER` |
| `PAPER_BALANCE` | Starting paper balance | `10.00` |
| `AUTH_USERNAME` | Dashboard login username | `bandito` |
| `AUTH_PASSWORD` | Dashboard login password | `bandito` |
| `REDIS_URL` | Redis connection string (optional) | - |
| `POLYMARKET_PRIVATE_KEY` | Wallet private key (for LIVE) | - |
| `POLYMARKET_API_KEY` | Polymarket API key (for LIVE) | - |
| `POLYMARKET_SECRET` | Polymarket secret (for LIVE) | - |
| `POLYMARKET_PASSPHRASE` | Polymarket passphrase (for LIVE) | - |

## API Endpoints

### Public (no auth required)
- `GET /api/health` - Health check with watchdog status
- `GET /api/version` - Code version and deployment info
- `GET /api/state-public` - Read-only public state

### Protected (auth required)
- `GET /api/state` - Full state snapshot
- `GET /api/gates` - GateTrace: why trades are blocked
- `GET /api/halts` - Halt status, reasons, and resume conditions
- `GET /api/trades` - Trade history
- `GET /api/backtest-proof` - Deterministic backtest
- `GET /api/forward-test` - Forward test with collector snapshots
- `GET /api/calibration` - Calibration statistics
- `GET /api/circuit-breaker` - Circuit breaker status
- `GET /api/verify` - GOAT verification checklist
- `POST /api/reset-balance` - Reset paper balance
- `POST /api/circuit-breaker/override` - Manual circuit breaker control
- `POST /api/toggle-stop-loss-override` - Override global stop loss

## Documentation

| Document | Purpose |
|----------|---------|
| [`GOALS_AND_ACCEPTANCE.md`](GOALS_AND_ACCEPTANCE.md) | **Source of truth**: goals, acceptance criteria, config decisions |
| [`GOLDEN_MEAN_RUNBOOK.md`](GOLDEN_MEAN_RUNBOOK.md) | Deployment runbook and monitoring guide |
| `POLYPROPHET-FINAL/MANIFESTO.md` | Archived reference (not production) |
| `FORENSIC_REBUILD_COMPLETE.md` | Historical: forensic rebuild notes |
| `FORENSIC_LEDGER.md` | Historical: repo cleanup notes |

## Repository Structure

```
POLYPROPHET/
├── server.js              # ✅ PRODUCTION RUNTIME (Render starts here)
├── public/                # ✅ Dashboard UI assets
├── render.yaml            # Render Blueprint configuration
├── GOALS_AND_ACCEPTANCE.md # ✅ Source of truth for goals/criteria
├── GOLDEN_MEAN_RUNBOOK.md # Deployment runbook
├── README.md              # This file
├── debug/                 # Debug exports (local only, not deployed)
└── POLYPROPHET-FINAL/     # ⚠️ ARCHIVED - Reference only, NOT deployed
    ├── server.js          # (historical variant)
    ├── public/
    └── MANIFESTO.md
```

> **Important**: Only `server.js` at repo root is deployed. `POLYPROPHET-FINAL/` is archived for reference.

## Features

- **Variance Hardening**: CircuitBreaker + streak-aware sizing
- **Persistent Trade History**: Full PAPER/LIVE history with Redis
- **Truthful LIVE P/L**: Portfolio accounting with MTM positions
- **Calibrated Trading**: LCB (lower confidence bound) gating
- **GateTrace**: Full transparency on trade rejections
- **Forward Collector**: Real-time snapshot collection for backtesting
- **Simple Mode UI**: One-click tests with plain-English explanations
- **Final Verification**: `/api/verify` for GOAT checklist

