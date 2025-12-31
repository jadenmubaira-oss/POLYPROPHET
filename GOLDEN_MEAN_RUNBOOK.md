# POLYPROPHET: Golden Mean Deployment Runbook

> **Source of truth for goals**: See [`GOALS_AND_ACCEPTANCE.md`](GOALS_AND_ACCEPTANCE.md)

## Current Status

- **Config Version**: 46
- **Runtime**: Root `server.js` (deployed via `render.yaml`)
- **Risk Profile**: Aggressive (crypto cycles only)

> See [`FINAL_VERIFICATION_REPORT.md`](FINAL_VERIFICATION_REPORT.md) for verification results.

---

## Golden Mean Features (Implemented)

### 1. EV + Liquidity Guards

- **EV Calculation**: Trades blocked if Expected Value < 0 after 3% friction (2% fees + 1% slippage)
- **Spread Guard**: Trades blocked if bid-ask spread > 15%
- **Purpose**: Ensures only mathematically positive trades execute

### 2. OBSERVE/HARVEST/STRIKE State Machine

| State | Description | Size Multiplier |
|-------|-------------|-----------------|
| OBSERVE | Cooldown after 3+ losses; minimum 15 min | 25% (probe trades) |
| HARVEST | Normal trading mode | 100% |
| STRIKE | After 3+ consecutive wins | 150% (aggressive) |

### 3. State Transitions

- **HARVEST -> STRIKE**: 3 consecutive wins
- **STRIKE -> HARVEST**: 1 loss
- **HARVEST -> OBSERVE**: 3 consecutive losses
- **OBSERVE -> HARVEST**: Win after 15min cooldown

### 4. CircuitBreaker (Variance Hardening)

| Trigger | State | Effect |
|---------|-------|--------|
| 2 consecutive losses | SAFE_ONLY | 50% size |
| 4 consecutive losses | PROBE_ONLY | 25% size |
| 6 consecutive losses | HALTED | No trades until new day |
| 15% drawdown | SAFE_ONLY | 50% size |
| 30% drawdown | PROBE_ONLY | 25% size |
| 50% drawdown | HALTED | No trades until new day |

---

## Live Deployment

| Setting | Value |
|---------|-------|
| **URL** | https://polyprophet.onrender.com/ |
| **Auth** | bandito / bandito |
| **Branch** | `main` |
| **Start Command** | `node server.js` |

### Key Endpoints

| Endpoint | Purpose |
|----------|---------|
| `GET /` | Dashboard with real-time predictions |
| `GET /api/state` | Full state including Golden Mean fields |
| `GET /api/gates` | GateTrace: why trades were blocked |
| `GET /api/verify` | GOAT verification checklist |
| `GET /api/backtest-proof` | Deterministic backtest from debug logs |

---

## Risk Controls (Aggressive Profile)

| Control | Setting | Purpose |
|---------|---------|---------|
| Max Position Size | 20% | Single trade cap |
| Max Total Exposure | 40% | Portfolio cap |
| Global Stop Loss | 30% | Daily drawdown halt |
| Loss Cooldown | 30 min | After 3 consecutive main-position losses |
| EV Floor | > 0% | After fees/slippage |

---

## Monitoring

### Key Metrics

1. `tradingState` - Should be HARVEST or STRIKE for active trading
2. `circuitBreaker.state` - NORMAL for unrestricted trading
3. `recentWinStreak` / `recentLossStreak` - State machine triggers
4. `todayPnL` - Daily P/L tracking
5. `consecutiveLosses` - Cooldown trigger (main positions only)

### Debug Export

Click "Debug Export" in dashboard to download full cycle history for analysis.

---

## Performance Notes

Based on debug log analysis:

| Metric | Value | Notes |
|--------|-------|-------|
| CONVICTION tier accuracy | ~98-99% | Highest-confidence predictions |
| ADVISORY tier accuracy | ~98% | Secondary tier |
| Overall cycle accuracy | ~72% | Includes NONE tier (no trade) |
| Oracle-locked accuracy | ~64% | When oracle lock triggers |

> **Important**: Backtest projections are indicative only. Real-world performance depends on market conditions, slippage, timing, and gas costs.

---

## Acceptance Criteria Status

| Criterion | Status |
|-----------|--------|
| Non-WAIT predictions | Verified |
| Feed liveness | Continuous updates |
| State integrity | Cycle tracking works |
| Debug export | Full trace available |
| EV gating | Implemented |
| Liquidity guards | Implemented |
| State machine | OBSERVE/HARVEST/STRIKE |
| CircuitBreaker | Implemented |

See [`GOALS_AND_ACCEPTANCE.md`](GOALS_AND_ACCEPTANCE.md) for complete acceptance criteria.

---

**Last Updated**: 2025-12-31  
**Version**: v45
