# EPOCH 3 V2 — Runtime Changes Documentation

Generated: 2026-04-28

## Changes to `lib/config.js`

### Tiered Aggression Sizing
- New env var `EPOCH3_TIERED_SIZING` (default: `true`)
- When enabled, stake fractions follow DEFINITIVE PLAN Phase F:
  - $5-$15: SF=0.40 (aggressive bootstrap)
  - $15-$50: SF=0.35 (growth phase)
  - $50-$200: SF=0.30 (acceleration)
  - $200+: SF=0.25 (profit preservation)
- Previous behavior: flat SF=0.15 at ≤$10, SF=0.12 otherwise

### MPC Override
- `MAX_GLOBAL_TRADES_PER_CYCLE` default raised from 2 to 5
- `ALLOW_MICRO_MPC_OVERRIDE` now defaults to `true` when `EPOCH3_TIERED_SIZING` is enabled
- Removes the forced MPC=1 cap at micro-bankroll when override is active

### 5m Timeframe Enabled
- 5m is now enabled by default when `EPOCH3_TIERED_SIZING` is active
- Min bankroll for 5m lowered to $3 (from $50)

### Consecutive Loss Handling
- `MAX_CONSECUTIVE_LOSSES` default: 4 (from 999) when tiered sizing active
- `COOLDOWN_SECONDS` default: 300 (from 0) when tiered sizing active
- Prevents tilt-driven bust sequences while allowing recovery

## Changes to `lib/risk-manager.js`

### `_getTierProfile()` Rewrite
- Implements DEFINITIVE PLAN Phase F tiered aggression:
  - BOOTSTRAP ($0-$15): SF=0.40, MPC=1 (sequential only)
  - GROWTH ($15-$50): SF=0.35, MPC=2
  - ACCELERATE ($50-$200): SF=0.30, MPC=3
  - PRESERVE ($200+): SF=0.25, MPC=3-5
- Removed the hard-coded `bankroll < 20 → MPC capped at 2` safety cap
- Each tier's MPC is bounded by the global configured max

## New Strategy Files

### `strategies/strategy_set_15m_epoch3v2_portfolio.json`
- 19 strategies mined from 324 train-selected candidates
- All pass chronological holdout (WR≥58%, events≥5, EV>0)
- Portfolio holdout WR: 86.0%, 343 events, avg entry 68.0c
- Covers hours: 1, 5, 6, 7, 9, 14, 15, 18, 20, 22, 23

### `strategies/strategy_set_5m_epoch3v2_portfolio.json`
- 1 strategy: H5 M2 DOWN 0.60-0.75
- Holdout WR: 85.4%, 48 events

## Backward Compatibility

Set `EPOCH3_TIERED_SIZING=false` to restore all pre-patch behavior:
- SF=0.15 at ≤$10
- MPC=1 at micro-bankroll
- 5m disabled at micro-bankroll
- No cooldown, no consecutive loss limit
