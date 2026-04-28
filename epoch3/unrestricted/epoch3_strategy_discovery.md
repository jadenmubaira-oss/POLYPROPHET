# EPOCH 3 Unrestricted Alpha Mining Discovery Report

Generated: 2026-04-28T06:40:45.440Z

## Data Sources
- **15m**: 6404 cycles, 2026-04-11T00:30:00.000Z to 2026-04-27T17:30:00.000Z
- **5m**: 16045 cycles, 2026-04-13T18:00:00.000Z to 2026-04-27T17:55:00.000Z
- **4h**: 336 cycles, 2026-04-13T12:00:00.000Z to 2026-04-27T08:00:00.000Z

## Simulation Parameters
- **Stake fractions**: Tiered: $<8=50%, $8-15=42%, $15-30=35%, $30-75=30%, $75-200=25%, $200+=20%
- **Kelly**: fraction=0.35, max=0.55, minPWin=0.52
- **Max consecutive losses before cooldown**: 4 (was 2)
- **Cooldown**: 600s (was 1800s)
- **Global stop loss**: 35% (was 20%)
- **Hard entry cap**: 0.78 (was 0.82)
- **MC runs**: 5000, starts: $5/$7/$10, horizons: 24h/48h/168h

## Approaches Tested: 32

| Rank | Approach | TF | $10/7d Median | $10 Bust% | P≥$100 | P≥$500 | Adverse Median |
|---:|---|---|---:|---:|---:|---:|---:|
| 1 | early_breakout_aggressive | 15m | $14.62 | 12.8% | 0.0% | 0.0% | $10.13 |
| 2 | ensemble_combined | multi | $5.53 | 8.9% | 0.0% | 0.0% | $3.49 |
| 3 | 4h_low_convexity_wide | 4h | $4.07 | 9.0% | 0.0% | 0.0% | $3.86 |
| 4 | momentum_cascade | 15m | $2.12 | 9.3% | 0.0% | 0.0% | $2.21 |
| 5 | streak_fade_aggressive | 15m | $3.79 | 10.6% | 0.0% | 0.0% | $6.91 |
| 6 | multi_min_momentum_wide | 15m | $9.85 | 16.8% | 0.0% | 0.0% | $2.59 |
| 7 | aggressive_spread_conv | 15m | $4.16 | 17.9% | 0.0% | 0.0% | $6.35 |
| 8 | ultra_low_entry_growth | 15m | $9.10 | 25.2% | 0.0% | 0.0% | $9.37 |
| 9 | tight_spread_momentum_combo | 15m | $2.67 | 23.3% | 0.0% | 0.0% | $1.99 |
| 10 | early_minute_dense | 15m | $1.78 | 24.7% | 0.0% | 0.0% | $1.70 |
| 11 | ultra_convex_low_band | 15m | $3.77 | 26.9% | 0.0% | 0.0% | $2.45 |
| 12 | mid_entry_all_signals | 15m | $3.92 | 30.9% | 0.0% | 0.0% | $1.55 |
| 13 | alternating_pattern | 15m | $1.96 | 32.4% | 0.0% | 0.0% | $3.50 |
| 14 | cross_asset_follow_wide | 15m | $3.31 | 33.5% | 0.0% | 0.0% | $4.10 |
| 15 | opposite_breakout_fade_wide | 15m | $0.32 | 61.0% | 0.0% | 0.0% | $0.72 |
| 16 | theta_sniping_extended | 15m | $33.38 | 100.0% | 0.0% | 0.0% | $32.59 |
| 17 | 4h_spread_conv_wide | 4h | $11.79 | 100.0% | 0.0% | 0.0% | $7.29 |
| 18 | reversal_from_cheap_15m | 15m | $10.00 | 100.0% | 0.0% | 0.0% | $10.00 |
| 19 | 5m_low_entry_convexity | 5m | $10.00 | 100.0% | 0.0% | 0.0% | $10.00 |
| 20 | 4h_momentum_wide | 4h | $9.09 | 100.0% | 0.0% | 0.0% | $9.00 |
| 21 | 5m_momentum_aggressive | 5m | $8.35 | 100.0% | 0.0% | 0.0% | $10.08 |
| 22 | 5m_dense_mid_band | 5m | $6.30 | 100.0% | 0.0% | 0.0% | $6.42 |
| 23 | 5m_ultra_low_entry | 5m | $5.53 | 100.0% | 0.0% | 0.0% | $5.54 |
| 24 | 5m_spread_conv_aggressive | 5m | $5.15 | 100.0% | 0.0% | 0.0% | $6.19 |
| 25 | sol_h20_expanded | 15m | $4.10 | 100.0% | 0.0% | 0.0% | $4.00 |
| 26 | volume_surge_entry | 15m | $0.00 | 100.0% | 0.0% | 0.0% | $0.00 |
| 27 | print_imbalance_wide | 15m | $0.00 | 100.0% | 0.0% | 0.0% | $0.00 |
| 28 | cross_majority_wide | 15m | $0.00 | 100.0% | 0.0% | 0.0% | $0.00 |
| 29 | four_h_bias_follow_wide | 15m | $0.00 | 100.0% | 0.0% | 0.0% | $0.00 |
| 30 | three_streak_follow_wide | 15m | $0.00 | 100.0% | 0.0% | 0.0% | $0.00 |
| 31 | 5m_print_imbalance_wide | 5m | $0.00 | 100.0% | 0.0% | 0.0% | $0.00 |
| 32 | 5m_streak_fade_wide | 5m | $0.00 | 100.0% | 0.0% | 0.0% | $0.00 |

## Best Approach: early_breakout_aggressive
- **Name**: Aggressive Early Breakout
- **$10 strict median**: $14.62
- **$10 strict bust**: 12.8%
- **P(≥$100)**: 0.0%
- **P(≥$500)**: 0.0%
- **Holdout WR**: 59.8%
- **Avg entry**: 0.635
