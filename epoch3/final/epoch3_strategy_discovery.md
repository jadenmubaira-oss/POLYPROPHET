# EPOCH 3 Final Reinvestigation Harness

Generated: 2026-04-28T04:38:59.981Z

## Data source statement
- **Live runtime status**: /api/health degraded LIVE isLive=true runtimeBankroll=3.735043 pendingBuys=0 pendingSettlements=0; /api/status risk.tradingPaused=true; /api/wallet/balance LIVE tradingBalance=3.735043 source=CONFIRMED_CONSERVATIVE_MIN tradeReady=true activeTimeframes=15m; /api/diagnostics available=true; checkedAt=2026-04-28T04:19:08Z
- **Local proof source**: local intracycle JSON archives and runtime-parity fee/sizing functions.
- **Latency correction**: delayed entries are repriced from the later minute snapshot before sizing, edge gates, and close logic.
- **Remaining missing proof**: no historical L2 replay or real fill ledger is present.

## Dataset inventory
- **data/intracycle-price-data.json**: 6404 items, 15m, 2026-04-11T00:30:00.000Z -> 2026-04-27T17:30:00.000Z, mtime=2026-04-27T18:02:37.450Z, orderMins={"5":6404}, exact0.50=0.329%
- **data/intracycle-price-data-5m.json**: 16045 items, 5m, 2026-04-13T18:00:00.000Z -> 2026-04-27T17:55:00.000Z, mtime=2026-04-27T19:22:06.771Z, orderMins={"5":16045}, exact0.50=0.631%
- **data/intracycle-price-data-4h.json**: 336 items, 4h, 2026-04-13T12:00:00.000Z -> 2026-04-27T08:00:00.000Z, mtime=2026-04-27T18:04:58.611Z, orderMins={"5":336}, exact0.50=0.824%
- **data/btc_5m_30d.json**: 8641 items, 5m, 2026-02-20T14:50:00.000Z -> 2026-03-22T14:50:00.000Z, mtime=2026-03-22T15:38:22.567Z, orderMins={}, exact0.50=n/a

## Split
- **train15**: 3712 cycles, 2026-04-11T00:30:00.000Z -> 2026-04-20T17:15:00.000Z
- **holdout15**: 2692 cycles, 2026-04-20T17:30:00.000Z -> 2026-04-27T17:30:00.000Z
- **train5**: 14890 cycles, 2026-04-13T18:00:00.000Z -> 2026-04-26T17:50:00.000Z
- **holdout5**: 1155 cycles, 2026-04-26T17:55:00.000Z -> 2026-04-27T17:55:00.000Z
- **train4**: 164 cycles, 2026-04-13T12:00:00.000Z -> 2026-04-20T04:00:00.000Z
- **holdout4**: 172 cycles, 2026-04-20T08:00:00.000Z -> 2026-04-27T08:00:00.000Z

## Strategy families tested
- **sol_h20_seed_expansion**: selected=3, holdoutEvents=7, holdoutWR=85.71%, avgEntry=0.4993 — Expand the prior SOL H20 sparse lead around UTC hour 20 using train-only selection and fresh chronological holdout.
- **time_of_day_volatility_regime**: selected=12, holdoutEvents=138, holdoutWR=66.67%, avgEntry=0.5764 — Cluster-like proxy: only mine hours where the selected side shows large early realized range before entry.
- **theta_decay_final_minutes**: selected=0, holdoutEvents=0, holdoutWR=0.00%, avgEntry=0.0000 — Buy the side already in a profitable mid-price band during minutes 10-13 and require historical pre-resolution exit evidence.
- **low_entry_convexity**: selected=5, holdoutEvents=74, holdoutWR=60.81%, avgEntry=0.5712 — Search lower entry bands where a win has high unit ROI and require Wilson-LCB EV after fees and slippage.
- **spread_convergence_orderbook_proxy**: selected=7, holdoutEvents=78, holdoutWR=58.97%, avgEntry=0.6338 — Use yes/no minute prices as a historical orderbook proxy and accept only tight yes+no convergence.
- **high_lcb_sparse_spread_convergence**: selected=2, holdoutEvents=23, holdoutWR=78.26%, avgEntry=0.6665 — Restrict spread-convergence to sparse train-only high Wilson-LCB rules before any holdout evaluation.
- **print_imbalance_l2_proxy**: selected=0, holdoutEvents=0, holdoutWR=0.00%, avgEntry=0.0000 — Treat trade-print imbalance as a proxy for executable pressure and buy only when target prints dominate opposite prints.
- **early_breakout_follow**: selected=9, holdoutEvents=86, holdoutWR=55.81%, avgEntry=0.6163 — Trade minutes 1-4 only when the side price moved up from minute 0 and continues upward into an affordable band.
- **late_extreme_inversion**: selected=8, holdoutEvents=49, holdoutWR=12.24%, avgEntry=0.1349 — When one side is expensive late in-cycle, buy the cheap opposite side only if it remains convex and affordable.
- **previous_cycle_streak_fade**: selected=0, holdoutEvents=0, holdoutWR=0.00%, avgEntry=0.0000 — If the same asset resolved the same way in the previous two cycles, buy the opposite direction in a tradable band.
- **cross_asset_latency_previous_majority**: selected=0, holdoutEvents=0, holdoutWR=0.00%, avgEntry=0.0000 — Use the previous 15m cycle majority direction across BTC/ETH/SOL/XRP as a latency proxy for the next cycle direction.
- **one_minute_momentum_reprice**: selected=9, holdoutEvents=78, holdoutWR=53.85%, avgEntry=0.6143 — Enter only when the latest minute price has risen versus the prior minute, then stress with actual delayed snapshot repricing.
- **open_reversal_convexity**: selected=8, holdoutEvents=78, holdoutWR=28.21%, avgEntry=0.3097 — Buy a side that sold off sharply from minute 0 into a low-price convex band, testing whether early overreaction reverses.
- **multi_minute_momentum_path**: selected=9, holdoutEvents=48, holdoutWR=58.33%, avgEntry=0.6236 — Require a two-minute monotonic side-price climb and mine the path feature rather than a single static minute.
- **pre_resolution_exit_harvest**: selected=12, holdoutEvents=50, holdoutWR=100.00%, avgEntry=0.5652 — Mine entries whose historical winners often reached a 95c pre-resolution exit window before settlement.
- **cross_asset_leader_follow**: selected=1, holdoutEvents=225, holdoutWR=56.44%, avgEntry=0.5931 — Use BTC/ETH/SOL/XRP resolution from one or two prior cycles as a leader signal for the current asset.
- **cross_asset_leader_fade**: selected=1, holdoutEvents=195, holdoutWR=49.74%, avgEntry=0.4962 — Invert prior-cycle leader signals to test whether apparent cross-asset continuation is a trap.
- **three_streak_follow**: selected=1, holdoutEvents=34, holdoutWR=64.71%, avgEntry=0.6100 — After three same-direction same-asset resolutions, test continuation in tradable mid-price bands.
- **three_streak_fade**: selected=1, holdoutEvents=53, holdoutWR=54.72%, avgEntry=0.4534 — After three same-direction same-asset resolutions, buy the opposite side when convex and affordable.
- **four_hour_bias_15m_follow**: selected=0, holdoutEvents=0, holdoutWR=0.00%, avgEntry=0.0000 — Use only the previous completed 4h resolution as a directional filter for current 15m entries.
- **four_hour_bias_15m_fade**: selected=1, holdoutEvents=164, holdoutWR=42.68%, avgEntry=0.4549 — Fade the previous completed 4h resolution when the opposite 15m side is still convex and tradable.
- **opposite_breakout_fade**: selected=10, holdoutEvents=60, holdoutWR=40.00%, avgEntry=0.3091 — Find early opposite-side breakouts that historically fail, then buy the cheap fading side.
- **five_minute_spread_convergence**: selected=0, holdoutEvents=0, holdoutWR=0.00%, avgEntry=0.0000 — Mine 5m cycles for early tight yes/no convergence in executable mid-price bands.
- **five_minute_micro_momentum**: selected=2, holdoutEvents=11, holdoutWR=45.45%, avgEntry=0.5627 — Enter only when a 5m side has strengthened versus the previous minute, then stress with delayed-minute repricing.
- **five_minute_print_imbalance**: selected=0, holdoutEvents=0, holdoutWR=0.00%, avgEntry=0.0000 — Use 5m trade-print imbalance as a lightweight order-flow proxy in affordable bands.
- **five_minute_streak_fade**: selected=0, holdoutEvents=0, holdoutWR=0.00%, avgEntry=0.0000 — Fade two same-direction resolved 5m cycles on the same asset when the opposite side is still tradable.
- **four_hour_intracycle_momentum**: selected=0, holdoutEvents=0, holdoutWR=0.00%, avgEntry=0.0000 — Trade 4h mid-cycle momentum only when the side has improved versus the previous minute and remains below the hard cap.
- **four_hour_spread_convergence**: selected=0, holdoutEvents=0, holdoutWR=0.00%, avgEntry=0.0000 — Use refreshed 4h yes/no minute convergence as a historical proxy for executable consensus.
- **four_hour_low_entry_convexity**: selected=0, holdoutEvents=0, holdoutWR=0.00%, avgEntry=0.0000 — Search 4h lower entry bands where a win can materially accelerate micro-bankroll compounding.

## Approach ranking
| Rank | Approach | Data | Runtime | Selected | Holdout events | Holdout WR | Avg entry | $10 7d strict median | $10 strict bust | $10 adverse bust | $10 worst bust |
|---:|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|
| 1 | spread_convergence_orderbook_proxy | fresh/live-refresh | needs support (3) | 7 | 78 | 59.0% | 63.4¢ | $13.55 | 1.2% | 11.9% | 18.8% |
| 2 | open_reversal_convexity | fresh/live-refresh | needs support (3) | 8 | 78 | 28.2% | 31.0¢ | $3.72 | 2.6% | 3.7% | 23.7% |
| 3 | low_entry_convexity | fresh/live-refresh | needs support (2) | 5 | 74 | 60.8% | 57.1¢ | $14.88 | 15.6% | 20.6% | 21.5% |
| 4 | cross_asset_leader_fade | fresh/live-refresh | needs support (3) | 1 | 195 | 49.7% | 49.6¢ | $6.00 | 5.5% | 2.1% | 44.6% |
| 5 | multi_minute_momentum_path | fresh/live-refresh | needs support (3) | 9 | 48 | 58.3% | 62.4¢ | $14.68 | 16.7% | 14.3% | 4.1% |
| 6 | time_of_day_volatility_regime | fresh/live-refresh | needs support (3) | 12 | 138 | 66.7% | 57.6¢ | $4.26 | 24.6% | 16.3% | 15.8% |
| 7 | opposite_breakout_fade | fresh/live-refresh | needs support (3) | 10 | 60 | 40.0% | 30.9¢ | $11.15 | 1.6% | 100.0% | 100.0% |
| 8 | four_hour_bias_15m_fade | fresh/live-refresh | needs support (3) | 1 | 164 | 42.7% | 45.5¢ | $2.05 | 24.7% | 16.5% | 15.7% |
| 9 | three_streak_fade | fresh/live-refresh | needs support (3) | 1 | 53 | 54.7% | 45.3¢ | $3.33 | 19.3% | 30.0% | 100.0% |
| 10 | one_minute_momentum_reprice | fresh/live-refresh | needs support (3) | 9 | 78 | 53.8% | 61.4¢ | $4.51 | 24.7% | 22.1% | 16.9% |
| 11 | cross_asset_leader_follow | fresh/live-refresh | needs support (3) | 1 | 225 | 56.4% | 59.3¢ | $2.41 | 47.4% | 29.5% | 36.4% |
| 12 | early_breakout_follow | fresh/live-refresh | needs support (3) | 9 | 86 | 55.8% | 61.6¢ | $1.89 | 53.0% | 54.1% | 26.6% |
| 13 | high_lcb_sparse_spread_convergence | fresh/live-refresh | needs support (3) | 2 | 23 | 78.3% | 66.7¢ | $13.81 | 100.0% | 100.0% | 100.0% |
| 14 | three_streak_follow | fresh/live-refresh | needs support (3) | 1 | 34 | 64.7% | 61.0¢ | $10.75 | 100.0% | 100.0% | 100.0% |
| 15 | late_extreme_inversion | fresh/live-refresh | needs support (3) | 8 | 49 | 12.2% | 13.5¢ | $3.41 | 100.0% | 100.0% | 100.0% |
| 16 | pre_resolution_exit_harvest | fresh/live-refresh | needs support (3) | 12 | 50 | 100.0% | 56.5¢ | $47.25 | 100.0% | 100.0% | 100.0% |
| 17 | sol_h20_seed_expansion | fresh/live-refresh | needs support (2) | 3 | 7 | 85.7% | 49.9¢ | $12.05 | 100.0% | 100.0% | 100.0% |
| 18 | five_minute_micro_momentum | fresh/live-refresh | needs support (3) | 2 | 11 | 45.5% | 56.3¢ | $7.75 | 100.0% | 100.0% | 100.0% |
| 19 | theta_decay_final_minutes | fresh/live-refresh | needs support (3) | 0 | 0 | 0.0% | 0.0¢ | $10.00 | 100.0% | 100.0% | 100.0% |
| 20 | print_imbalance_l2_proxy | fresh/live-refresh | needs support (3) | 0 | 0 | 0.0% | 0.0¢ | $10.00 | 100.0% | 100.0% | 100.0% |
| 21 | previous_cycle_streak_fade | fresh/live-refresh | needs support (3) | 0 | 0 | 0.0% | 0.0¢ | $10.00 | 100.0% | 100.0% | 100.0% |
| 22 | cross_asset_latency_previous_majority | fresh/live-refresh | needs support (3) | 0 | 0 | 0.0% | 0.0¢ | $10.00 | 100.0% | 100.0% | 100.0% |
| 23 | four_hour_bias_15m_follow | fresh/live-refresh | needs support (3) | 0 | 0 | 0.0% | 0.0¢ | $10.00 | 100.0% | 100.0% | 100.0% |
| 24 | five_minute_spread_convergence | fresh/live-refresh | needs support (3) | 0 | 0 | 0.0% | 0.0¢ | $10.00 | 100.0% | 100.0% | 100.0% |
| 25 | five_minute_print_imbalance | fresh/live-refresh | needs support (3) | 0 | 0 | 0.0% | 0.0¢ | $10.00 | 100.0% | 100.0% | 100.0% |
| 26 | five_minute_streak_fade | fresh/live-refresh | needs support (3) | 0 | 0 | 0.0% | 0.0¢ | $10.00 | 100.0% | 100.0% | 100.0% |
| 27 | four_hour_intracycle_momentum | fresh/live-refresh | needs support (3) | 0 | 0 | 0.0% | 0.0¢ | $10.00 | 100.0% | 100.0% | 100.0% |
| 28 | four_hour_spread_convergence | fresh/live-refresh | needs support (3) | 0 | 0 | 0.0% | 0.0¢ | $10.00 | 100.0% | 100.0% | 100.0% |
| 29 | four_hour_low_entry_convexity | fresh/live-refresh | needs support (2) | 0 | 0 | 0.0% | 0.0¢ | $10.00 | 100.0% | 100.0% | 100.0% |

## Runtime compatibility
- **spread_convergence_orderbook_proxy**: requires runtime support: historical_opposite_print_count, historical_target_print_count, spread_deviation_matcher_extension
- **open_reversal_convexity**: requires runtime support: historical_filter:open_reversal, historical_target_print_count, spread_deviation_matcher_extension
- **low_entry_convexity**: requires runtime support: historical_target_print_count, spread_deviation_matcher_extension
- **cross_asset_leader_fade**: requires runtime support: dynamic_direction:cross_asset_leader_fade, historical_target_print_count, spread_deviation_matcher_extension
- **multi_minute_momentum_path**: requires runtime support: historical_filter:multi_minute_momentum, historical_target_print_count, spread_deviation_matcher_extension
- **time_of_day_volatility_regime**: requires runtime support: historical_filter:early_realized_volatility, historical_target_print_count, spread_deviation_matcher_extension
- **opposite_breakout_fade**: requires runtime support: historical_filter:opposite_early_breakout_fade, historical_target_print_count, spread_deviation_matcher_extension
- **four_hour_bias_15m_fade**: requires runtime support: dynamic_direction:previous_4h_bias_fade, historical_target_print_count, spread_deviation_matcher_extension
- **three_streak_fade**: requires runtime support: dynamic_direction:streak_fade3, historical_target_print_count, spread_deviation_matcher_extension
- **one_minute_momentum_reprice**: requires runtime support: historical_filter:one_minute_momentum, historical_target_print_count, spread_deviation_matcher_extension

## Verdict
NO-GO: best deployable approach spread_convergence_orderbook_proxy failed the corrected micro-bankroll gate under repriced latency ($5 bust 28.86%, $7 bust 13.60%, $10 strict median $13.55, adverse bust 11.94%).
