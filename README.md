# POLYPROPHET GOAT v3 - The Ceiling

**MAX PROFIT ASAP WITH MIN VARIANCE**

## Deployment

- **Production service**: `POLYPROPHET-FINAL/`
- **Render Blueprint**: `render.yaml` (rootDir: `POLYPROPHET-FINAL`)

### Deploy to Render

1. Render → **New +** → **Blueprint**
2. Select this repo and apply
3. Configure environment variables in Render dashboard

### Required Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `TRADE_MODE` | `PAPER` or `LIVE` | `PAPER` |
| `PAPER_BALANCE` | Starting paper balance | `5.00` |
| `AUTH_USERNAME` | Dashboard login username | `admin` |
| `AUTH_PASSWORD` | Dashboard login password | `changeme` |
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
- `GET /api/trades` - Trade history
- `GET /api/backtest-proof` - Deterministic backtest
- `GET /api/forward-test` - Forward test with collector snapshots
- `GET /api/calibration` - Calibration statistics
- `GET /api/verify` - GOAT verification checklist
- `POST /api/reset-balance` - Reset paper balance

## Documentation

- Full system documentation: `POLYPROPHET-FINAL/MANIFESTO.md`
- See `FORENSIC_LEDGER.md` for historical context

## Repository Structure

```
POLYPROPHET/
├── POLYPROPHET-FINAL/     # Production runtime (deployed via Render)
│   ├── server.js          # Main server with all GOAT features
│   ├── public/            # Dashboard UI
│   ├── package.json       # Dependencies
│   └── MANIFESTO.md       # Full system documentation
├── render.yaml            # Render Blueprint configuration
├── debug/                 # Debug exports (not deployed)
└── README.md              # This file
```

## Features

- **Variance Hardening**: CircuitBreaker + streak-aware sizing
- **Persistent Trade History**: Full PAPER/LIVE history with Redis
- **Truthful LIVE P/L**: Portfolio accounting with MTM positions
- **Calibrated Trading**: LCB (lower confidence bound) gating
- **GateTrace**: Full transparency on trade rejections
- **Forward Collector**: Real-time snapshot collection for backtesting
- **Simple Mode UI**: One-click tests with plain-English explanations
- **Final Verification**: `/api/verify` for GOAT checklist

