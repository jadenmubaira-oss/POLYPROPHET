---
description: Weekly strategy health check (non-invasive). Notify-only. Follows DEITY anti-hallucination rules.
---

# /validate-strategy — Weekly Health Check

Purpose: Verify that the currently loaded v5 (or later) strategy is still operating within its documented OOS WR window using the most recent data available, and surface any drift via Telegram + written report.

**This workflow MUTATES NOTHING in production.** It writes a report to `debug/validator/validator-<ts>.json` and (if configured) fires a Telegram alert for WARN/CRITICAL severity.

## When to run

- Every **50 live trades** since the last run (hard rule)
- Every **7 calendar days** from the last run (soft schedule)
- **Immediately** after any hard-kill trigger observed on live:
  - 2+ cooldown hits in 24h
  - rolling 20-trade WR < 65%
  - any day with ≥ 10 trades and WR < 70%
  - drawdown from peak > 50%

## Steps

1. **Refresh live data**
   - Confirm `data/intracycle-price-data.json` is up to date (usually auto-extended by the runtime).
   - If it's more than 48h stale, run the appropriate collector:
     ```powershell
     node scripts/collect-intracycle-data.js
     ```
   // turbo

2. **Run the auto validator (7-day window)**
   ```powershell
   node scripts/auto-validate-strategy.js --days 7
   ```
   // turbo

3. **Inspect report**
   - Open the newest file in `debug/validator/`.
   - If `severity=INFO`: document nothing. Telegram sends a LOW-priority OK ping.
   - If `severity=WARN`: open a todo list item for the next check-in, but do NOT pause.
   - If `severity=CRITICAL`: **pause immediately** via `/pause` Telegram command or `POST /api/telegram/test`-class endpoint, then investigate.

4. **Cross-check with live recent trades** (only if balance > $2 and trades exist)
   - Pull live status: `curl -s https://polyprophet-1-rr1g.onrender.com/api/status | jq '.risk.recentTrades'`
   - Compare the `recentTrades` win rate to the validator's `trailingOos.wr`.
   - Flag a divergence >= 10pp as an anti-hallucination finding per DEITY rules.

5. **Update README handoff state**
   - Append a one-line note to `README.md`'s current handoff block:
     `Validator <date> → <severity>, trailing 7d WR <X>% on <N>t (report: <path>)`.
   - Run `/handover-sync` to confirm README + live match.

## Interpreting severity

| Severity | Meaning | Required action |
|---|---|---|
| `INFO` | All checks passed within thresholds | None. File the report. |
| `WARN` | Fade ≥ 5pp from projection, or >= 21d strategy age | Schedule a retrain within 7 days |
| `CRITICAL` | Fade ≥ 10pp, rolling WR below hard floor, or >= 30d age | Pause, run full re-audit, then run `/retrain-v6` |

## What NOT to do

- Do NOT modify `strategies/strategy_set_15m_optimal_10usd_v5.json` in this workflow.
- Do NOT swap a candidate without running `/retrain-v6` first.
- Do NOT dismiss a CRITICAL without at least 24h of fresh live data to confirm.
