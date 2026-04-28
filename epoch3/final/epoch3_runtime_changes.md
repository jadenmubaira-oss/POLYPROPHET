# Epoch 3 Runtime Changes

Generated: 2026-04-28T04:38:59Z

## Result

No new live-runtime strategy promotion was applied after the Epoch 3 mining run.

The expanded fresh-data + 5,000-run MC proof returned **NO-GO** for autonomous live trading:

> NO-GO: best deployable approach `spread_convergence_orderbook_proxy` failed the corrected micro-bankroll gate under repriced latency ($5 bust 28.86%, $7 bust 13.60%, $10 strict median $13.55, adverse bust 11.94%).

## Files changed for Epoch 3 proof work

- `scripts/final_reinvestigation_harness.js`
  - Expanded the search from 20 to 29 strategy families.
  - Added 5m and 4h strategy-family coverage.
  - Added SOL H20 seed expansion and time-of-day volatility-regime families.
  - Added cross-asset leader/fade, three-streak follow/fade, 4h-bias 15m stacking, multi-minute momentum, pre-resolution exit harvest, and adversarial opposite-breakout fade families.
  - Added asset-specific candidate enforcement to avoid contaminating SOL-only rules with all assets.
  - Added dynamic helper support for prior-cycle, cross-asset, and previous-completed-4h rules.
  - Added data-driven stale flags and env-injected live runtime status.
  - Added runtime-compatibility labeling for current `lib/strategy-matcher.js` limitations.
  - Optimized MC simulation by preparing repriced/friction-adjusted event surfaces once per approach/friction instead of once per bootstrap run.
  - Added Epoch 3 deliverable outputs in `epoch3/final/`.
- `scripts/epoch3-data-audit.js`
  - New audit script for data freshness, cycle counts, resolution distribution, minute coverage, and exact-0.50 price sanity.
- `data/intracycle-price-data-5m.json`
  - Refreshed to 2026-04-13T18:00:00Z -> 2026-04-27T17:55:00Z, 16,045 cycles.
- `epoch3/final/*`
  - Generated proof artifacts for 29 tested families and 5,000 MC runs.

## Runtime promotion status

- **15m**: live runtime still loads `strategy_set_15m_micro_recovery.json` per live API summary.
- **5m**: no new 5m strategy promoted.
- **4h**: no new 4h strategy promoted.
- **Dynamic matcher rewrite**: not applied because no mined candidate reached the required profit/survival gate.

## Runtime blockers found

The top-ranked local approaches require logic the current static matcher cannot enforce directly:

- Historical target/opposite print-count conditions.
- Spread-deviation matcher extension.
- Historical in-cycle filters such as `open_reversal`, `one_minute_momentum`, `multi_minute_momentum`, `opposite_early_breakout_fade`, `early_breakout`, and volatility range.
- Dynamic direction rules such as `cross_asset_leader_follow`, `cross_asset_leader_fade`, `streak_follow3`, `streak_fade3`, and `previous_4h_bias_fade`.

Because the best candidate still failed the MC gate, these matcher extensions are not sufficient for a GO by themselves.
