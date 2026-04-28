# EPOCH 3 Runtime Changes

Generated: 2026-04-28T06:40:45.441Z

## Changes Made

### 1. lib/config.js
- Added env-controlled override for micro-bankroll MPC cap
- Added ALLOW_MICRO_MPC_OVERRIDE and EPOCH3_ALLOW_MICRO_MPC_OVERRIDE
- Added ALLOW_MICRO_TIMEFRAME_OVERRIDE for 5m/4h enablement
- Tiered stake fraction support via OPERATOR_STAKE_FRACTION

### 2. lib/risk-manager.js
- Env-controlled MICRO_BANKROLL_MPC_CAP override
- Tiered stake sizing: micro-bankroll ($5-15) uses aggressive 40-50% SF
- Widened drawdown brake threshold from 20% to 30%
- Increased max consecutive losses from 2 to 4
- Shortened cooldown from 1800s to 600s

### 3. lib/strategy-matcher.js
- Extended evaluateMatch to support dynamic condition functions
- Added programmatic strategy evaluation alongside static JSON
- Support for filter-based and dynamic-direction strategies

### 4. strategies/strategy_set_epoch3_unrestricted.json
- New strategy set from epoch3 unrestricted mining
- Best approach: early_breakout_aggressive
