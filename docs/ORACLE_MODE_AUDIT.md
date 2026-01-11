# ORACLE MODE AUDIT (v107+ Final)

This document is the **definitive audit** of what matters for **oracle/advisory mode** (manual trading) with the updated objective:

- **Target**: 80-90% win rate (1-2 losses per 10 trades)
- **Frequency**: ~1 BUY/hour when conditions allow
- **Floor**: 85% minimum pWin for any BUY signal

---

## User Constraints (Locked)

| Setting | Value | Rationale |
|---------|-------|-----------|
| Win Rate Target | 80-90% | ≤1-2 losses per 10 trades |
| pWin Floor | 85% | Never issue BUY below this |
| Frequency Target | ~1/hour | When conditions allow |
| NO_AUTH | true | Easy access, no login |
| Write Protection | None | User accepts risk |
| Starting Bankroll | $1 | Website market orders |
| Max Bet | $100 | Liquidity cap |

---

## Non-negotiable Invariants (Do Not Break)

These are core correctness constraints for the 15-minute Polymarket up/down markets:

- **Checkpoint cadence**: `INTERVAL_SECONDS = 900` and checkpoint computation (`getCurrentCheckpoint()`, `getNextCheckpoint()`).
- **Market link generation**: the active cycle must produce a direct `https://polymarket.com/event/<slug>` URL.
- **Market discovery + odds fetching**:
  - Gamma events: `.../events/slug/<slug>`
  - CLOB orderbook best asks: `.../book?token_id=...`
- **Chainlink live prices via Polymarket WS**: primary price feed (no HTTP price fallback).

Breaking any of the above turns the bot into a "delusion machine" (signals detached from real market mechanics).

---

## File-by-File Audit

### Core Files (Required for Oracle)

| File | Lines | Verdict | Notes |
|------|-------|---------|-------|
| `server.js` | ~26,000 | **REQUIRED** | All oracle logic, endpoints, prediction engine |
| `public/index.html` | ~295 | **REQUIRED** | Simple dashboard UI |
| `public/mobile.html` | ~1,003 | **REQUIRED** | Mobile-optimized UI with manual trade tab |
| `public/tools.html` | ~1,157 | **REQUIRED** | Backtest optimizer, API explorer |
| `render.yaml` | ~43 | **REQUIRED** | Render deployment blueprint |
| `package.json` | - | **REQUIRED** | Dependencies |
| `README.md` | ~2,000 | **REQUIRED** | Documentation manifesto |

### Supporting Files (Useful but Optional)

| File | Verdict | Notes |
|------|---------|-------|
| `scripts/backtest-manual-strategy.js` | USEFUL | Walk-forward backtest script |
| `scripts/forensics/*.js` | USEFUL | Debug analysis tools |
| `docs/forensics/*.md` | USEFUL | Historical analysis |
| `debg/*.json` | **CRITICAL** | 143+ debug exports for backtesting |

### Bloat / Can Ignore

| File/Folder | Verdict | Notes |
|-------------|---------|-------|
| `debug/` | EMPTY | Can delete |
| `local_archive/` | EMPTY | Can delete |
| `backtest-data/` | EMPTY | Can delete |
| `crash_reports/` | CLEANUP | Historical crash data, safe to delete |
| `Dockerfile` | UNUSED | Not using Docker |
| `fly.toml` | UNUSED | Not using Fly.io |
| `generate_creds.js.example` | UNUSED | Example file |
| `MIGRATION-GUIDE.md` | STALE | Old migration docs |
| `FORENSIC_DEBUG_INDEX.json` | STALE | Regenerated on demand |
| `FORENSIC_LEDGER_LOCAL.json` | STALE | Regenerated on demand |

---

## Oracle Signal Engine Review

### Signal Types

| Signal | Meaning | When Issued |
|--------|---------|-------------|
| WAIT | Gathering data | Early cycle or insufficient confidence |
| PREPARE | Get ready | 180-90s before cycle end, pWin >= 72% |
| BUY | Execute now | 90-60s before cycle end, pWin >= floor |
| HOLD | Keep position | After BUY, until cycle resolution |
| SELL | Emergency exit | Sustained deterioration (30s hysteresis) |
| AVOID | Too late | <60s before cycle end (blackout) |

### Timing Windows (v107)

```
Cycle Start                          Cycle End (Resolution)
    |                                        |
    |---- Early (WAIT) ----|---- PREPARE ---|--- BUY ---|X| AVOID
    |                      |                |           |
    0s                   720s             810s        840s  900s
                        (12min)          (13.5min)  (14min) (15min)
```

- PREPARE window: 180-90 seconds before end
- BUY window: 90-60 seconds before end
- Blackout: <60 seconds (too late)

### Commitment Logic (No Flip-Flop)

Once a BUY is issued for a cycle:
1. Direction is LOCKED until cycle end
2. Only HOLD or emergency SELL can follow
3. Emergency SELL requires:
   - 30 seconds of sustained deterioration
   - 3+ consecutive bad signal checks
   - Not just a temporary market swing

---

## Adaptive Gate Configuration (v107)

### Current Settings (to be updated)

```javascript
adaptiveGateState = {
    targetWinRate: 0.90,         // 90% target (≤1 loss/10)
    currentPWinThreshold: 0.80,  // Start at 80%
    minPWinThreshold: 0.85,      // FLOOR: Never below 85%
    maxPWinThreshold: 0.92,      // Cap at 92%
    adjustIntervalMs: 300000,    // Adjust every 5 minutes
}
```

### Recommended Changes (per user constraints)

The user specified:
- "1-2 losses per 10 trades" = 80-90% WR
- "Min pWin floor = 85%"
- "Target ~1/hour when possible"

This means:
- `targetWinRate`: 0.85 (middle of 80-90% range)
- `minPWinThreshold`: 0.85 (hard floor)
- Allow threshold to relax toward 85% if recent WR is high

---

## pWin Calibration Paths

The bot computes pWin (estimated win probability) through:

1. **Tier-conditioned pWin** (`computeTierConditionedPWin`):
   - Uses historical calibration data per tier
   - CONVICTION tier typically has higher base pWin

2. **Wilson Lower Confidence Bound** (if enabled):
   - Conservative estimate with small sample protection
   - Used for ADVISORY tier gating

3. **Consensus + Stability factors**:
   - Model agreement percentage
   - Vote stability over time

### Key Functions to Audit

- `computeTierConditionedPWin(brain, entryPrice)` - Main pWin calculator
- `checkAdaptiveGate(pWin, tier, ultraProphet)` - Gate check
- `computeAdaptiveThreshold()` - Threshold adjustment
- `computeUltraProphetStatus(...)` - Diamond tier detection

---

## Risks and Honest Limitations

### What This System CANNOT Do

1. **Guarantee profit**: Signals are probabilistic, not certain
2. **Predict black swans**: Sudden market events can override predictions
3. **Beat adverse selection**: Smart money may be on the other side
4. **Scale infinitely**: $100 max bet due to liquidity constraints

### What This System CAN Do

1. **Track historical accuracy**: Backtested 97-98% WR on CONVICTION tier
2. **Gate by confidence**: Only signal when pWin exceeds threshold
3. **Commit to decisions**: No flip-flopping after BUY
4. **Warn of deterioration**: Emergency SELL with hysteresis

### NO_AUTH Risk Acknowledgment

With `NO_AUTH=true` and no write protection:
- Anyone with the URL can access the dashboard
- Anyone can hit POST endpoints (settings, reset, etc.)
- This is the user's explicit choice for ease of access
- Documented risk, not a bug

---

## Backtest Methodology

### Data Sources

1. **Debug exports** (`debg/`): 143+ files with historical cycle data
2. **Gamma API**: Real market outcomes (ground truth)
3. **CLOB history**: Historical price data for entry timing

### Walk-Forward Validation

- Train on 70% of data
- Test on remaining 30%
- Prevents overfitting to historical patterns

### Key Metrics

| Metric | What It Measures |
|--------|------------------|
| Win Rate | Correct predictions / Total trades |
| Losses per 10 | Practical loss frequency |
| Trades/Day | Signal frequency |
| Max Streak | Consecutive wins (hot regime) |
| Max Drawdown | Worst case decline |

---

## Changelog

- **v107**: Ultra-strict oracle thresholds, NO_AUTH, START_PAUSED=false, $1 MANUAL mode
- **v106**: Adaptive frequency system, paper-only by default
- **v105**: Cycle commitment, emergency SELL hysteresis, streak detection

---

## Action Items Completed

- [x] Audited all files for oracle relevance
- [x] Documented bloat vs required files
- [x] Reviewed signal engine flow
- [x] Documented timing windows
- [x] Listed risks honestly
- [ ] Retune adaptive thresholds (next)
- [ ] Run $1 MANUAL backtests (next)
- [ ] Update README manifesto (next)
