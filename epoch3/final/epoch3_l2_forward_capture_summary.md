# Epoch 3 L2 / Fill Proof Boundary

Generated: 2026-04-28T04:38:59Z

## Status

Historical L2 order-book replay and real fill-ledger proof are **not available** in the completed expanded Epoch 3 local proof run.

The mining harness used the closest available local proxy:

- 1-minute CLOB price-history snapshots for YES and NO tokens.
- Opposite-side price availability.
- Target/opposite print counts.
- `yes + no` spread-deviation proxy.
- Repriced latency using delayed minute snapshots.
- No-fill, packet-drop, adverse-fill, progressive-slippage, lockup, fee, and minimum-order stress profiles.

## Existing forward capture tool

The repo contains `scripts/collect_live_l2_snapshots.js`, which can append live L2 snapshots to JSONL via:

```powershell
$env:L2_TIMEFRAMES='15m,5m,4h'
$env:L2_DURATION_MIN='60'
$env:L2_INTERVAL_MS='5000'
$env:L2_OUT='epoch3/final/epoch3_l2_fill_proof.jsonl'
node scripts/collect_live_l2_snapshots.js
```

This was **not** run as a substitute for historical proof because the completed expanded 29-family mining result was already NO-GO.

## Promotion implication

No strategy should be promoted to autonomous live trading from the current Epoch 3 run. If future mining produces a candidate that passes the MC gate, forward L2 capture should be run in PAPER / supervised mode before any LIVE autonomy.
