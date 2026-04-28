# Epoch 3 Deployment Config

Generated: 2026-04-28T04:38:59Z

## GO / NO-GO

**NO-GO for autonomous live trading.**

Do not deploy a new Epoch 3 strategy from this expanded 29-family run.

## Evidence

- Fresh data audit: `epoch3/final/epoch3_data_audit.json`
- Strategy discovery: `epoch3/final/epoch3_strategy_discovery.md`
- Candidate rankings: `epoch3/final/epoch3_candidate_rankings.json`
- MC results: `epoch3/final/epoch3_mc_results.json`
- Raw trade paths: `epoch3/final/epoch3_raw_trade_paths.json`
- L2 boundary summary: `epoch3/final/epoch3_l2_forward_capture_summary.md`
- Expanded families tested: 29
- MC runs: 5,000

## Best local candidate

`spread_convergence_orderbook_proxy`

- Holdout events: 78
- Holdout WR: 58.97%
- Average entry: 63.38c
- $10 7d strict median: $13.55
- $5 strict bust: 28.86%
- $7 strict bust: 13.60%
- $10 strict bust: 1.24%
- $10 adverse bust: 11.94%
- $10 worst bust: 18.82%

This fails the required $500+ target and fails micro-bankroll survival gates.

## Live runtime truth used in proof

`/api/health`, `/api/status`, `/api/wallet/balance`, and `/api/diagnostics` were reachable:

- Runtime mode: LIVE
- Health: degraded
- Risk tradingPaused: true
- Wallet trading balance: 3.735043 USDC
- Balance source: `CONFIRMED_CONSERVATIVE_MIN`
- Trade ready: true
- Active timeframes: 15m
- Pending buys: 0
- Pending settlements: 0
- Diagnostics endpoint: available

## If the operator still wants supervised PAPER observation

Use current runtime only; do **not** point Render to any new Epoch 3 strategy artifact from this expanded run.

Suggested safe posture:

```text
TRADE_MODE=PAPER
START_PAUSED=true
TIMEFRAME_15M_ENABLED=true
TIMEFRAME_5M_ENABLED=false
MULTIFRAME_4H_ENABLED=false
STRATEGY_SET_15M_PATH=strategies/strategy_set_15m_micro_recovery.json
HARD_ENTRY_PRICE_CAP=0.82
```

This is not an alpha-promotion config. It is only a no-new-risk observation posture.
