# PolyProphet Goals & Acceptance Criteria

> **Single source of truth** for what "final" means. All docs/code/config must align with this.

## 1. User Profile

| Decision | Value | Rationale |
|----------|-------|-----------|
| **Risk Profile** | Aggressive | Prioritize fastest growth; accept larger drawdowns (up to ~40%) |
| **Market Scope** | Crypto cycles only | BTC, ETH, SOL, XRP 15-minute prediction markets on Polymarket |

## 2. Profit Objective

**MAX PROFIT ASAP** — maximize geometric growth rate subject to:

- No *self-inflicted* variance (bugs, false loss streaks, unnecessary halts)
- Binary outcomes accepted (win = 2x+ return, loss = position lost)
- Target: compound from small bankroll ($5-$10) to $100+ within days

### Acceptance Criteria (Profit)

| Criterion | Pass Condition |
|-----------|----------------|
| CONVICTION tier win rate | ≥ 85% over 50+ trades |
| No forced early exits on winning ORACLE positions | ORACLE holds to resolution (not force-closed at 30s) |
| No missed trades due to false halts | Halts only trigger on genuine loss streaks / drawdown |
| Trade frequency | ≥ 1 trade per hour when conditions exist |

## 3. Variance Control (Aggressive Mode)

"Min variance" in aggressive mode means **removing avoidable/self-inflicted variance**, not reducing risk:

- ✅ Remove: bugs that cause phantom losses, hedge legs polluting loss streaks, unnecessary halts
- ✅ Keep: binary outcome risk, position sizing proportional to edge, drawdown-based throttling

### Acceptance Criteria (Variance)

| Criterion | Pass Condition |
|-----------|----------------|
| Hedge legs do not trigger loss-streak logic | `consecutiveLosses` only increments on main position losses |
| Illiquidity pair legs counted as single economic trade | Net P&L of pair determines win/loss for streak logic |
| No full HALT unless drawdown ≥ 50% OR loss streak ≥ 6 | Prefer SAFE_ONLY / PROBE_ONLY throttling |
| Cooldown duration explicit and bounded | Max 30 min cooldown after 3 consecutive main-position losses |

## 4. Halt Behavior (Aggressive Profile)

Halts must be:
1. **Explicit** — reason surfaced in UI and `/api/state`
2. **Bounded** — known maximum duration
3. **Resumable** — clear path to resume trading

### Halt Ladder (Aggressive)

| Trigger | State | Effect | Resume |
|---------|-------|--------|--------|
| 2 consecutive losses | SAFE_ONLY | 50% size, no acceleration | 1 win OR 15 min |
| 4 consecutive losses | PROBE_ONLY | 25% size only | 1 win OR 30 min |
| 6 consecutive losses | HALTED | No trades | New day OR manual override |
| 15% drawdown | SAFE_ONLY | 50% size | Drawdown recovers |
| 30% drawdown | PROBE_ONLY | 25% size | Drawdown recovers |
| 50% drawdown | HALTED | No trades | New day |
| Global stop loss (30% day loss) | HALTED | No trades | New day OR override |

## 5. Reliability (Non-Negotiable)

| Criterion | Pass Condition |
|-----------|----------------|
| No "WAIT / 0%" stuck UI | Predictions update every tick; confidence ≠ NaN |
| Feed liveness | WebSocket reconnects automatically; stale price detection |
| Deploy unambiguous | `render.yaml` → root `server.js` (no rootDir confusion) |
| Crash recovery | Positions, balances, learning state persist via Redis |

## 6. Auditability

| Criterion | Pass Condition |
|-----------|----------------|
| Debug export complete | All cycle data, model votes, config version, git commit |
| Trade history includes diagnostic fields | `entryConfidence`, `configVersion`, `cycleElapsed`, `tier` |
| Backtest reproducible | `/api/backtest-proof` produces deterministic results from debug logs |
| Gate trace available | `/api/gates` shows why trades were blocked |

## 7. Codebase / Repo Hygiene

| Criterion | Pass Condition |
|-----------|----------------|
| Single runtime baseline | Root `server.js` (v45) is the only production entrypoint |
| Archived code labeled | `POLYPROPHET-FINAL/` clearly marked as reference/archive |
| No secrets in tracked files | `.env` in `.gitignore`; debug exports redact keys |
| Documentation matches reality | README, runbook align with actual code behavior |

---

## Quick Reference: What's Enabled (Aggressive Preset)

| Mode | Enabled | Notes |
|------|---------|-------|
| ORACLE | ✅ | Core prediction strategy; holds to resolution |
| ILLIQUIDITY_GAP | ✅ | True arbitrage when YES+NO < 97% |
| DEATH_BOUNCE | ❌ | Disabled by default (historically buggy) |
| HEDGING | ❌ | Disabled for aggressive (reduces returns, pollutes streak logic) |
| SCALP | ❌ | Not needed for crypto cycles |
| ARBITRAGE | ❌ | Not needed for crypto cycles |

---

**Last Updated**: 2025-12-31  
**Config Version**: 46  
**Risk Profile**: Aggressive  
**Market Scope**: Crypto cycles (BTC/ETH/SOL/XRP)

> See [`FINAL_VERIFICATION_REPORT.md`](FINAL_VERIFICATION_REPORT.md) for full verification results.
