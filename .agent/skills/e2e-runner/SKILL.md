---
name: e2e-runner
description: End-to-end verification specialist for POLYPROPHET. Tests the full signal flow from market discovery through strategy matching, sizing, order execution, and resolution. Use for pre-deploy smoke tests and operational verification.
---

# E2E Runner

Adapted from ECC `agents/e2e-runner.md` for POLYPROPHET's trading bot verification.

## Core Responsibilities

1. **Signal Flow Verification** -- Market discovery -> strategy match -> risk sizing -> order execution
2. **API Endpoint Testing** -- All `/api/*` endpoints return expected shapes
3. **Dashboard Verification** -- Dashboard renders correctly, shows truthful data
4. **Strategy Artifact Loading** -- All configured strategy files load and parse
5. **Wallet Integration** -- Balance reads, auth posture, CLOB readiness

## POLYPROPHET Test Surface

### API Smoke Tests
```bash
curl -s https://polyprophet-1-rr1g.onrender.com/api/health | node -e "const d=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8')); console.log('mode:', d.mode, 'isLive:', d.isLive, 'strategies:', JSON.stringify(d.strategySets))"
curl -s https://polyprophet-1-rr1g.onrender.com/api/status | node -e "const d=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8')); console.log('orchestrator:', d.orchestrator)"
curl -s https://polyprophet-1-rr1g.onrender.com/api/wallet/balance | node -e "const d=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8')); console.log('balance:', d)"
```

### Local Syntax Verification
```bash
node --check server.js
for f in lib/*.js; do node --check "$f"; done
```

### Strategy Artifact Verification
```bash
node -e "const fs=require('fs'); ['debug/strategy_set_top8_current.json','debug/strategy_set_4h_maxprofit.json','debug/strategy_set_5m_maxprofit.json'].forEach(f => { try { const d=JSON.parse(fs.readFileSync(f)); console.log(f, 'OK:', d.length || d.strategies?.length, 'strategies'); } catch(e) { console.error(f, 'FAIL:', e.message); } })"
```

## Verification Order

1. Local syntax check (`node --check`)
2. Strategy artifact parsing
3. Local import check (require each lib module)
4. Remote API health
5. Remote strategy set verification
6. Remote wallet/auth posture
