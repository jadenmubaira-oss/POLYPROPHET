---
description: Full v6 retrain with fresh data. Notify-only candidate generation. Manual promotion required.
---

# /retrain-v6 — Full Retrain (NOTIFY-ONLY)

Purpose: Build a new candidate 15m strategy set from the freshest available intracycle data, validate it on a held-out OOS window, compare it against the current live strategy, and surface a summary via Telegram. **NEVER SWAPS LIVE.**

## When to run

- **Hard ceiling**: v5 strategy file age ≥ 30 days → this workflow is MANDATORY.
- **Recommended**: 21-28 days after last retrain, if ≥ 200 live trades have accumulated.
- **On demand**: after `/validate-strategy` returns `CRITICAL` twice in a row.

## Pre-flight

1. **Refresh live data**
   - Confirm `data/intracycle-price-data.json` covers up to within 24h of now.
   - If stale, run the collector:
     ```powershell
     node scripts/collect-intracycle-data.js
     ```
   // turbo

2. **Check baseline truth**
   - Run a final re-audit of v5 on the OOS window you plan to use:
     ```powershell
     node scripts/v5_reverify.js
     node scripts/v5_proper_runtime_sim.js
     ```
   // turbo
   - Record the current v5 numbers (WR, 7d bust, 7d median).

## Retrain

3. **Run the retrain pipeline**
   ```powershell
   node scripts/auto-retrain-v6.js --trainDays 14 --oosDays 7 --minWr 0.85 --minTrades 30
   ```
   // turbo

   Outputs:
   - Candidate artifact: `strategies/candidates/strategy_set_15m_v6_candidate_<ts>.json`
   - Decision report:    `debug/retrain/retrain-<ts>.json`
   - Telegram alert via `notifyRetrainCandidate(...)` summarizing beat/no-beat.

4. **Review the report**
   - Open the newest file in `debug/retrain/`.
   - Confirm TRUE-OOS WR is ≥ 88% on ≥ 200 events.
   - Confirm $10/7d bust is ≤ 5%.
   - Confirm v6 beats v5 by ≥ 3pp OOS WR AND ≥ 15% $10/7d median.
   - Confirm price-band distribution looks sane (not skewed to only 0.9+).

## Promotion (manual only — per DEITY notify-only policy)

5. **Finalize the candidate**
   - If the candidate passes all four gates above, enrich it with runtime metadata:
     ```powershell
     # Copy candidate out of candidates/ first
     Copy-Item "strategies/candidates/strategy_set_15m_v6_candidate_<ts>.json" "strategies/strategy_set_15m_optimal_10usd_v6.json"
     node scripts/finalize_v5.js  # reuse: edit the path inside to point at v6 if needed
     ```
   - Verify it loads cleanly:
     ```powershell
     node --check strategies/strategy_set_15m_optimal_10usd_v6.json  # JSON sanity
     node -e "require('./lib/strategy-matcher').loadStrategySet('15m', 'strategies/strategy_set_15m_optimal_10usd_v6.json')"
     ```

6. **Shadow for 24h** (strongly recommended)
   - Deploy v6 to a staging / paper env first, or temporarily set `TRADE_MODE=PAPER` on production.
   - Compare v6 live signals against v5 signals across 24h.
   - Abort promotion if they diverge by > 30% on signal count or price-band distribution.

7. **Swap in production**
   - Set env on Render: `LIVE_STRATEGY_FILE_15M=strategies/strategy_set_15m_optimal_10usd_v6.json`
   - Redeploy.
   - Confirm via Telegram boot notification: new deploy hash + v6 strategy name + N rules.
   - Run `/validate-strategy --days 3` after 3 days of live fire.

## Rollback

- If v6 produces 3 losses in the first 20 trades OR WR < 70% in first 50 trades:
  - Pause via `/pause`.
  - Revert `LIVE_STRATEGY_FILE_15M` to v5.
  - Redeploy.
  - Move the failed v6 artifact out of `strategies/` and document the regression in README.

## What NOT to do

- Do NOT auto-swap. Every promotion is human.
- Do NOT skip the 24h shadow unless you explicitly accept the risk.
- Do NOT promote a v6 that doesn't beat v5 on the held-out OOS.
