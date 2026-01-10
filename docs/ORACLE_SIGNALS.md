# ORACLE SIGNALS (PREPARE / BUY / SELL)

This repo now supports an **oracle/advisory mode** designed to guide **manual** trading on Polymarket 15‑minute up/down markets for:

- **BTC**
- **ETH**
- **XRP**
- **SOL**

By default, the bot **does not place real LIVE orders automatically** (see `LIVE_AUTOTRADING_ENABLED` in `server.js`).

---

## Where signals live

- **UI + API**: `GET /api/state` includes `oracleSignal` under each asset.
- **Telegram**: PREPARE → BUY → SELL messages are built in `server.js` and emitted once-per-cycle (throttled).

---

## The `oracleSignal` object (shape)

Returned as `state[ASSET].oracleSignal`:

```json
{
  "asset": "BTC",
  "cycleStartEpochSec": 1700000000,
  "cycleEndEpochSec": 1700000900,
  "timestampMs": 1700000123456,
  "elapsedSec": 123,
  "timeLeftSec": 777,
  "marketUrl": "https://polymarket.com/event/btc-updown-15m-1700000000",

  "action": "BUY",
  "direction": "UP",
  "tier": "CONVICTION",
  "confidence": 0.86,

  "implied": 0.42,
  "pWin": 0.66,
  "evRoi": 0.18,
  "mispricingEdge": 0.24,
  "oddsDelta60s": 0.03,
  "oddsVelocityPerMin": 0.02,

  "position": {
    "id": "BTC_...",
    "side": "UP",
    "entry": 0.38,
    "currentOdds": 0.52,
    "pnl": 12.34,
    "pnlPercent": 36.8
  },

  "reasons": [
    "pWin=66.0% vs implied=42.0% (edge=24.0%)",
    "EV=18.0% ROI, stability=0.90/2, tLeft=777s"
  ]
}
```

Notes:
- **`implied`** is the current ask price for the predicted side: YES for UP, NO for DOWN.
- **`pWin`** is the tier/price‑conditioned calibrated probability (if available; otherwise falls back to calibrated bucket probability).
- **`evRoi`** is expected ROI after fees (positive = edge).
- **`mispricingEdge`** is \(pWin - implied\) (probability points, not %).

---

## Action semantics (what you should do)

### `WAIT`
- The bot is **not confident enough** or the signal is not stable.
- Common reasons: insufficient calibration samples, low stability, too early in the cycle, or no market data.

### `PREPARE`
- A high‑quality opportunity is forming.
- **Open the market link** and be ready.
- This is intentionally earlier and “lighter” than BUY (prewarning).

### `BUY`
- The bot believes the edge is **certified** right now.
- Message includes: direction, odds, pWin, EV, edge, and a market link.
- You manually execute the buy on Polymarket.

### `HOLD`
- You have an open position (paper‑tracked or manually tracked) and the bot recommends holding.

### `SELL`
- The bot recommends **exiting your current position**.
- SELL is triggered by: profit capture, loss cut, or a high‑stability prediction flip against your held side.

### `AVOID`
- The cycle is not safe to enter (e.g. final seconds blackout, stale feed).

---

## Signal gating rules (high level)

The oracle layer is intentionally conservative and will prefer **silence** over low-quality calls.

Key gates (see `server.js`):
- **Time gates**
  - `CONFIG.ORACLE.minElapsedSeconds`: wait before acting.
  - Final‑minute **blackout**: suppress new entries.
- **Stability gate**
  - Uses `Brains[asset].voteTrendScore` vs `CONFIG.ORACLE.minStability`.
- **Edge + EV gates**
  - BUY requires calibrated pWin + positive EV + minimum edge, OR severe mispricing.
  - **Severe mispricing** currently triggers when `(pWin - implied) ≥ 0.15` and `pWin ≥ 0.70`.

---

## Time-to-correct-call (TTC) metrics

After each cycle resolves, `cycleDebugHistory` records timing metrics:
- **`timeToCorrectCallSec`**: earliest time (seconds into cycle) after the last wrong-side prediction where the bot predicted the correct outcome and never predicted the wrong side again.
- **`timeToCertifiedCallSec`**: same, but requiring a “certified” tier (`ADVISORY`/`CONVICTION`).

These are surfaced in `GET /api/state`:
- `timeToCorrectCallSecLast`, `avgTimeToCorrectCallSec10`
- `timeToCertifiedCallSecLast`, `avgTimeToCertifiedCallSec10`

---

## Recommended human workflow

1. **PREPARE**: open the market link, watch odds/price, decide sizing.
2. **BUY**: execute buy manually on Polymarket.
3. **SELL**: take profit or cut quickly when told (or hold to resolution if you choose).
4. Use `/mobile.html` or `/index.html` to monitor signals and links in real time.

