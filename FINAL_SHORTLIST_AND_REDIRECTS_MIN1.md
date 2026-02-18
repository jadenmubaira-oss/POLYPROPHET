# Final Shortlist + Redirected Signals (Min Order £1, Manual Mode)

Generated: 2026-02-13T11:50:12.696Z

## Final shortlist (overall profit+certainty compromise)
- **Primary set:** `top7_drop6` (Top8 minus signature `1|20|DOWN|0.68|0.8`)
- Signal WR: 88.34% (LCB 85.20%) over 489 trades
- Compared with Top8 current: WR 86.78% over 522 trades

## Redirected signals output
- Source Top8 trades: 522
- Kept under shortlist: 489
- Redirected (dropped): 33
- Removed signature(s): `1|20|DOWN|0.68|0.8`
- Redirect artifact: `debug/final_shortlist_redirected_signals.json`

## Start £10 manual no-halts scan (slippage 1%, min order share=1)
| Set | Stake % | End Balance | ROI | Max DD | Executed | Blocked | WR |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Top8 | 20% | 532,860.4 | 5328504.01% | 77.03% | 522 | 0 | 86.78% |
| Top8 | 30% | 16,085,185.82 | 160851758.15% | 93.31% | 522 | 0 | 86.78% |
| Top8 | 40% | 0.53 | -94.67% | 98.09% | 83 | 439 | 77.11% |
| Top8 | 50% | 0.54 | -94.56% | 98.25% | 72 | 450 | 79.17% |
| Top7-drop6 | 20% | 1,785,276.38 | 17852663.82% | 60.23% | 489 | 0 | 88.34% |
| Top7-drop6 | 30% | 121,197,407.42 | 1211973974.18% | 80.00% | 489 | 0 | 88.34% |
| Top7-drop6 | 40% | 1,751,808,552.93 | 17518085429.32% | 91.82% | 489 | 0 | 88.34% |
| Top7-drop6 | 50% | 5,098,909,486.77 | 50989094767.66% | 97.87% | 489 | 0 | 88.34% |
| Top3-robust | 30% | 28,709.29 | 286992.92% | 66.94% | 160 | 0 | 93.13% |

## Stress on final shortlist (Top7-drop6, start £10)
| Scenario | End Balance | ROI | Max DD | Executed | Miss Blocks |
| --- | --- | --- | --- | --- | --- |
| base_s20_slip1_miss0 | 1,785,276.38 | 17852663.82% | 60.23% | 489 | 0 |
| base_s30_slip1_miss0 | 121,197,407.42 | 1211973974.18% | 80.00% | 489 | 0 |
| s30_slip3_miss0 | 6,869,165.17 | 68691551.71% | 82.42% | 489 | 0 |
| s30_slip5_miss0 | 426,478.09 | 4264680.85% | 85.24% | 489 | 0 |
| s30_slip1_miss10 | 12,312,246.2 | 123122361.99% | 75.69% | 439 | 50 |
| s30_slip3_miss10 | 944,553.04 | 9445430.44% | 80.14% | 439 | 50 |

## Notes
- Results above are historical replay, not live guarantees.
- At high stake %, drawdowns are extreme (80-98%), so path risk is severe despite positive replay totals.
- Liquidity/impact/capacity are not fully modeled in these simulations.