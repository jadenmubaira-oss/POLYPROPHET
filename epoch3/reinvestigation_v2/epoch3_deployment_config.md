# EPOCH 3 V2 — Deployment Configuration

Generated: 2026-04-28

## Strategy Selection

**Primary strategy set**: `strategies/strategy_set_15m_epoch3v2_portfolio.json`
- 19 strategies across 15m timeframe, targeting hours 1, 5, 6, 7, 9, 14, 15, 18, 20, 22, 23
- Portfolio holdout WR: 86.0% across 343 events
- Average entry: 68.0c (well below 82c hard cap)
- MC $10→7d median: $18,095 (strict), $14,891 (adverse +2c stress)
- P(≥$500 from $10): 92.4%
- Bust rate from $10: 2.1%

**Secondary strategy set**: `strategies/strategy_set_5m_epoch3v2_portfolio.json`
- 1 strategy for 5m timeframe (H5 M2 DOWN 0.60-0.75)
- Holdout WR: 85.4%, 48 events

## Render Environment Variables

```env
# === CORE ===
TRADE_MODE=PAPER
START_PAUSED=true
STARTING_BALANCE=10

# === EPOCH 3 V2 STRATEGY ===
STRATEGY_SET_15M_PATH=strategies/strategy_set_15m_epoch3v2_portfolio.json
STRATEGY_SET_5M_PATH=strategies/strategy_set_5m_epoch3v2_portfolio.json
EPOCH3_TIERED_SIZING=true

# === TIERED AGGRESSION (auto-applied by EPOCH3_TIERED_SIZING=true) ===
# These are the defaults when EPOCH3_TIERED_SIZING=true:
# OPERATOR_STAKE_FRACTION=0.40  (auto-tiered: $5-15→0.40, $15-50→0.35, $50-200→0.30, $200+→0.25)
MAX_GLOBAL_TRADES_PER_CYCLE=5
ALLOW_MICRO_MPC_OVERRIDE=true

# === TIMEFRAMES ===
TIMEFRAME_15M_ENABLED=true
TIMEFRAME_5M_ENABLED=true
TIMEFRAME_5M_MIN_BANKROLL=3
MULTIFRAME_4H_ENABLED=false

# === RISK CONTROLS ===
HARD_ENTRY_PRICE_CAP=0.82
HIGH_PRICE_EDGE_FLOOR_PRICE=0.82
MAX_CONSECUTIVE_LOSSES=4
COOLDOWN_SECONDS=300
REQUIRE_REAL_ORDERBOOK=true

# === SAFETY ===
RISK_ENVELOPE_ENABLED=false
MIN_BALANCE_FLOOR=0
```

## Post-Deploy Verification

1. Check `/api/health` for correct strategy path loaded
2. Verify `riskControls.maxGlobalTradesPerCycle` shows 5
3. Verify `riskControls.microBankrollAllowMpcOverride` shows true
4. Verify active timeframes include `15m` and `5m`
5. Confirm `hardEntryPriceCap` is 0.82

## GO/NO-GO Statement

**CONDITIONAL GO** for PAPER mode testing.

Justification:
- Portfolio holdout WR of 86.0% across 343 chronological OOS events
- All 20 strategies pass train-only selection → chronological holdout → MC validation
- Average entry 68.0c is safely below the High-Price Trap zone
- MC shows 92.4% probability of reaching $500+ from $10 within 7 days
- Adverse stress test (+2c worse fill) still shows $14,891 median

Missing for LIVE autonomy:
- No L2 order book depth replay (no historical L2 data available)
- No live smoke test (Render service was unavailable)
- No forward fill proof from actual CLOB executions
- Recommend PAPER → manual supervision → LIVE progression

## Code Changes Summary

1. `lib/config.js`: Tiered aggression sizing (EPOCH3_TIERED_SIZING), MPC override, 5m enabled at $3 min
2. `lib/risk-manager.js`: Tiered _getTierProfile matching DEFINITIVE PLAN Phase F
3. `strategies/strategy_set_15m_epoch3v2_portfolio.json`: 19 holdout-validated strategies
4. `strategies/strategy_set_5m_epoch3v2_portfolio.json`: 1 holdout-validated 5m strategy
5. `scripts/epoch3_reinvestigation_v2.js`: Full mining engine with 17 strategy families
