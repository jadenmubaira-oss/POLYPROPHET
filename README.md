# POLYPROPHET GOAT — FINAL FOREVER MANIFESTO (v47)

This README is the **single canonical source of truth** for PolyProphet: goals, scope, strategy, sizing/variance doctrine, halt behavior, verification, and operations.

If this README conflicts with any other file or chat export, **this README wins**.

---

## 1) The Goal (exact wording)

**MAX PROFIT ASAP WITH MIN VARIANCE**

Interpretation (what “min variance” means in aggressive mode): remove avoidable/self‑inflicted variance (false loss streaks, unnecessary halts, negative‑EV hedging, broken strategies), while accepting meaningful drawdowns when compounding aggressively.

---

## 2) Market Scope (what we trade)

**Crypto cycles only** on Polymarket:
- BTC / ETH / SOL / XRP
- 15‑minute windows

Non‑goals:
- non‑crypto markets
- politics/elections
- multi-day horizons

---

## 3) The Outcome Target

Primary target:
- Scale a small bankroll (e.g. **$5–$10**) to **$100+ quickly**, then continue compounding toward **$1,000,000**.

Constraint:
- do this with the **lowest possible avoidable variance**.

---

## 4) “Perfection” standard (how we make it “GOAT”)

No real system can guarantee 100.00% correctness forever. The GOAT standard here is:
- **Deterministic safety**: halts/throttles have explicit reasons and bounded durations.
- **No silent failure**: no permanent WAIT/0% freeze; liveness is observable.
- **Auditability**: decisions are explainable via gates, config version, and debug exports.
- **No ambiguity**: one production entrypoint; everything else is archived.

---

## 5) Deployed Baseline (proof)

- **Production runtime**: repo root `server.js`
- **Render** uses `render.yaml` (no `rootDir`)

The deployed instance currently reports:

```bash
curl https://polyprophet.onrender.com/api/version
```

Expected (as of v48):
- `configVersion: 48`
- `gitCommit: <new commit after deploy>`

---

## 6) Strategy Overview

### ORACLE (directional)
The bot predicts **UP/DOWN** for the 15‑minute cycle and only trades when gates show **positive EV** after friction.

Non-negotiables from the chats and forensic docs:
- **Genesis supremacy / veto**: Genesis should not be overridden by weak models.
- **No flip‑flop**: stable predictions (lock/commit systems).
- **No dormancy**: should trade when conditions exist (target: at least ~1 trade/hour when opportunities exist).

### ILLIQUIDITY_GAP (true arb)
If **YES + NO < 100¢** (with safety margin), buy both legs. This is the closest thing to “minimum variance.”

### Disabled by design (aggressive profile)
- **HEDGING**: disabled (historically negative EV after fees/spreads and polluted streak logic).
- **DEATH_BOUNCE**: disabled (historically low win rate / negative EV).

### Learning / Evolution (permanent improvement)
Core requirement: the bot must not keep making the same mistakes.

- Uses **calibration** and confidence‑bound logic to gate trades (verify via `GET /api/calibration`).
- When `REDIS_URL` is configured, key state persists across restarts (balances, learning state, trade history, collector snapshots).
- When Redis is not configured, state resets on restart (acceptable only for local paper experiments).

### Redemption / Settlement (LIVE)
Core requirement: winning positions must be redeemable and redemption must be idempotent.

- LIVE mode requires wallet/API credentials.
- The runtime maintains redemption tracking so it can claim winnings without double-counting.
- Verify live safety using `GET /api/state` and `GET /api/health` (and ensure no key material appears in logs/exports).

### Liveness / No-stall guarantees
Core requirement: no “WAIT / 0% forever” stalls.

- Feed liveness and stale-data behavior must be observable (use `GET /api/health`).
- The system should fail safe: if data is stale or the feed is unhealthy, it should throttle/skip trades rather than trade blindly.

### Security invariants
- `.env` must never be committed.
- Debug exports must redact secrets.
- Default dashboard credentials (`bandito` / `bandito`) are placeholders; change them in real deployments.

---

## 7) Halt Behavior (how long can it halt, will we miss profit?)

Authoritative endpoint (auth required):
- `GET /api/halts`

Current thresholds (v46, from `/api/halts`):
- **Cooldown**: after 3 consecutive losses, **30 minutes**.
- **Global stop loss**: triggers on **30% daily loss**, resumes next day or via override.
- **Circuit breaker**:
  - SAFE_ONLY at **15% drawdown** or **2 losses**
  - PROBE_ONLY at **30% drawdown** or **4 losses**
  - HALTED at **50% drawdown** or **6 losses**
  - resume rules are explicit (`resumeAfterMinutes`, `resumeOnNewDay`)

Profit impact:
- Most of the time, the system **throttles** (SAFE_ONLY / PROBE_ONLY) instead of fully halting.
- Full halts are reserved for severe conditions (big drawdown or heavy loss streak).

---

## 8) Statistical Variance + Sizing (your “trades to $1M” tables)

You provided “trades to $1M” grids by:
- win rate regime (90/80/70/60%)
- ROI per win (10–100%)
- size fraction risked per trade (10–100%)

High-level conclusions:
- If performance can degrade to **80%** for a window, **50%+ sizing** becomes bust-prone unless ROI is very high.
- For robustness across regimes, the “sweet spot” is usually **~20–30% sizing**, plus fast throttling after losses.

### Critical v46 evidence: stop-loss can create avoidable variance
From the extra debug (v46) and live correlation:
- Trade `ETH_1767212360212` closed via **STOP LOSS (-32%)**
- But the cycle later resolved **UP** (it would have won at resolution)

This is avoidable/self-inflicted variance: a safety mechanism that sometimes turns winners into losers.

### Sizing doctrine (spec)
Default doctrine to survive worst-case variance while compounding fast:
- **Base size**: ~20% of bankroll per ORACLE trade
- **Acceleration**: allow size increases only after verified win streaks (STRIKE mode)
- **Throttle immediately** after losses (SAFE_ONLY / PROBE_ONLY)

If you want to push harder toward $1M speed:
- increase size, but accept higher bust risk (especially if win rate dips toward 80%)

---

## 9) Verification (Backtest + Forward-test)

Protected endpoints:
- `GET /api/backtest-proof` (deterministic backtest from debug logs)
- `GET /api/forward-test` (replay collector snapshots through decision engine)

Public baseline checks:
- `GET /api/health`
- `GET /api/version`

---

## 10) Operations / Deployment

### Deploy to Render
1. Render → New → Blueprint
2. Select repo
3. Set environment variables

### Required environment variables
| Variable | Description | Default |
|----------|-------------|---------|
| `TRADE_MODE` | `PAPER` or `LIVE` | `PAPER` |
| `PAPER_BALANCE` | Starting paper balance | `10.00` |
| `AUTH_USERNAME` | Dashboard login username | `bandito` |
| `AUTH_PASSWORD` | Dashboard login password | `bandito` |
| `REDIS_URL` | Redis connection string (optional) | - |
| `POLYMARKET_PRIVATE_KEY` | Wallet private key (LIVE) | - |
| `POLYMARKET_API_KEY` | API key (LIVE) | - |
| `POLYMARKET_SECRET` | secret (LIVE) | - |
| `POLYMARKET_PASSPHRASE` | passphrase (LIVE) | - |

Security rule: never commit secrets; use `.env` locally and Render env vars in prod.

---

## 11) API Endpoints

### Public
- `GET /api/health`
- `GET /api/version`
- `GET /api/state-public`

### Protected (Basic auth)
- `GET /api/state`
- `GET /api/gates`
- `GET /api/halts`
- `GET /api/trades`
- `GET /api/backtest-proof`
- `GET /api/forward-test`
- `GET /api/calibration`
- `GET /api/circuit-breaker`
- `GET /api/verify`
- `POST /api/reset-balance`
- `POST /api/circuit-breaker/override`
- `POST /api/toggle-stop-loss-override`

---

## 12) Repository policy (NO confusion, ever again)

### Main branch must stay minimal
After cleanup, `main` should contain only:
- `server.js` (production runtime)
- `public/`
- `package.json`, `package-lock.json`
- `render.yaml`
- `.env.example`, `generate_creds.js.example`
- `.gitignore`
- `README.md` (this manifesto)

### Archive branch contains history
All historical runtimes, debug artifacts, forensic docs, and chat exports go to an `archive` branch (preserved, but not in `main`).

---

## 13) Opus 4.5 — server.js implementation tasks (COMPLETED in v47)

1. **Stop-loss false-stop fix (critical)**
   - Prevent STOP LOSS from closing high-confidence trades that later win at cycle end.
   - Options:
     - disable stop-loss for CONVICTION+Genesis-agree trades
     - make stop-loss phase-aware (early cycle vs late cycle)

2. **Profit capture vs resolution**
   - Decide whether CONVICTION trades should hold to resolution (higher ROI) vs early exit (lower variance).
   - Backtest both.

3. **Sizing policy enforcement**
   - Implement the base/accelerate/throttle doctrine explicitly.
   - Validate against your $1M trade tables under 90% and 80% regimes.

4. **Gate tuning**
   - `mid_range_odds` is the top blocker in recent debug; verify we aren’t missing high-EV cycles.

---

## 14) CRITICAL BUGS FIXED — v48 (COMPLETED)

### Post-deployment forensics (2026-01-01) revealed tier propagation failures:

| Trade ID | Recorded Tier | Entry Confidence | Outcome | Expected Tier |
|----------|---------------|------------------|---------|---------------|
| ETH_1767221643946 | UNKNOWN | 80.5% | STOP -49% | CONVICTION |
| BTC_1767224431695 | UNKNOWN | 75.8% | LOSS -100% | ADVISORY |
| SOL_1767223247407 | CONVICTION | 81.0% | LOSS -100% | N/A (SOL disabled) |

### ROOT CAUSE 1: Missing tier in LATE CYCLE path (Line 7400) ✅ FIXED

Added `{ tier: tier, pWin: pWinEff, genesisAgree: lateGenesisAgree }` to executeTrade call

### ROOT CAUSE 2: Missing tier in ILLIQUIDITY path (Line 7362) ✅ FIXED

Added `{ tier: tier }` to executeTrade call

### ROOT CAUSE 3: SOL enabled in PINNACLE_OPTIMAL preset (Line 9897) ✅ FIXED

Changed to `SOL: { enabled: false, maxTradesPerCycle: 1 }`

### ROOT CAUSE 4: UI button mislabeled (Line 8980) ✅ FIXED

Renamed from 'PINNACLE v27' to 'APEX v24' to match actual preset

### ADDITIONAL v48 TASKS ✅ COMPLETED

5. **Child-friendly API panel**: Added formatted tables/cards for trades, gates, version, halts endpoints with tooltips

6. **Security audit**: Removed partial key logging (keyPreview)

---

## Appendix A — Trades to $1M tables (from chat)

### Trades from 10 to 1 million

1 LOSS PER 10 (90% WIN RATE)
| ROI \\ Size | 10% | 20% | 30% | 40% | 50% | 60% | 70% | 80% | 90% | 100% |
|---|---|---|---|---|---|---|---|---|---|---|
| 10% | 1583 | 919 | 733 | 664 | 647 | 661 | 703 | 779 | 913 | BUST |
| 20% | 794 | 433 | 325 | 277 | 255 | 247 | 249 | 260 | 283 | BUST |
| 30% | 531 | 281 | 205 | 170 | 152 | 143 | 140 | 142 | 149 | BUST |
| 40% | 400 | 208 | 149 | 121 | 107 | 99 | 95 | 94 | 97 | BUST |
| 50% | 321 | 165 | 117 | 94 | 82 | 75 | 71 | 70 | 70 | BUST |
| 60% | 269 | 137 | 96 | 77 | 66 | 60 | 57 | 55 | 55 | BUST |
| 70% | 231 | 117 | 82 | 65 | 56 | 50 | 47 | 45 | 45 | BUST |
| 80% | 203 | 102 | 71 | 57 | 48 | 43 | 40 | 38 | 37 | BUST |
| 90% | 181 | 91 | 63 | 50 | 42 | 38 | 35 | 33 | 32 | BUST |
| 100% | 163 | 82 | 57 | 45 | 38 | 33 | 31 | 29 | 28 | BUST |

2 LOSSES PER 10 (80% WIN RATE)
| ROI \\ Size | 10% | 20% | 30% | 40% | 50% | 60% | 70% | 80% | 90% | 100% |
|---|---|---|---|---|---|---|---|---|---|---|
| 10% | 2505 | 2154 | 4247 | BUST | BUST | BUST | BUST | BUST | BUST | BUST |
| 20% | 1184 | 829 | 948 | 1640 | BUST | BUST | BUST | BUST | BUST | BUST |
| 30% | 772 | 496 | 479 | 604 | 1106 | BUST | BUST | BUST | BUST | BUST |
| 40% | 576 | 356 | 315 | 348 | 465 | 935 | BUST | BUST | BUST | BUST |
| 50% | 460 | 278 | 234 | 241 | 289 | 418 | 986 | BUST | BUST | BUST |
| 60% | 384 | 228 | 187 | 183 | 206 | 266 | 435 | 1678 | BUST | BUST |
| 70% | 329 | 193 | 155 | 148 | 160 | 193 | 271 | 557 | BUST | BUST |
| 80% | 288 | 168 | 133 | 124 | 130 | 150 | 192 | 302 | BUST | BUST |
| 90% | 256 | 148 | 116 | 107 | 109 | 123 | 148 | 203 | 473 | BUST |
| 100% | 231 | 132 | 104 | 94 | 94 | 103 | 120 | 152 | 268 | BUST |

3 LOSSES PER 10 (70% WIN RATE)
| ROI \\ Size | 10% | 20% | 30% | 40% | 50% | 60% | 70% | 80% | 90% | 100% |
|---|---|---|---|---|---|---|---|---|---|---|
| 10% | 6059 | BUST | BUST | BUST | BUST | BUST | BUST | BUST | BUST | BUST |
| 20% | 2307 | 4516 | BUST | BUST | BUST | BUST | BUST | BUST | BUST | BUST |
| 30% | 1391 | 1541 | BUST | BUST | BUST | BUST | BUST | BUST | BUST | BUST |
| 40% | 1000 | 884 | 2061 | BUST | BUST | BUST | BUST | BUST | BUST | BUST |
| 50% | 780 | 622 | 962 | BUST | BUST | BUST | BUST | BUST | BUST | BUST |
| 60% | 640 | 483 | 614 | 1629 | BUST | BUST | BUST | BUST | BUST | BUST |
| 70% | 542 | 396 | 459 | 785 | BUST | BUST | BUST | BUST | BUST | BUST |
| 80% | 471 | 336 | 368 | 535 | 1680 | BUST | BUST | BUST | BUST | BUST |
| 90% | 416 | 292 | 308 | 410 | 832 | BUST | BUST | BUST | BUST | BUST |
| 100% | 373 | 258 | 265 | 332 | 556 | 2393 | BUST | BUST | BUST | BUST |

4 LOSSES PER 10 (60% WIN RATE)
| ROI \\ Size | 10% | 20% | 30% | 40% | 50% | 60% | 70% | 80% | 90% | 100% |
|---|---|---|---|---|---|---|---|---|---|---|
| 10% | BUST | BUST | BUST | BUST | BUST | BUST | BUST | BUST | BUST | BUST |
| 20% | 9015 | BUST | BUST | BUST | BUST | BUST | BUST | BUST | BUST | BUST |
| 30% | 3672 | BUST | BUST | BUST | BUST | BUST | BUST | BUST | BUST | BUST |
| 40% | 2242 | BUST | BUST | BUST | BUST | BUST | BUST | BUST | BUST | BUST |
| 50% | 1583 | 3124 | BUST | BUST | BUST | BUST | BUST | BUST | BUST | BUST |
| 60% | 1215 | 1541 | 3901 | BUST | BUST | BUST | BUST | BUST | BUST | BUST |
| 70% | 986 | 1039 | 1629 | BUST | BUST | BUST | BUST | BUST | BUST | BUST |
| 80% | 831 | 794 | 1041 | 1141 | BUST | BUST | BUST | BUST | BUST | BUST |
| 90% | 720 | 644 | 778 | 1362 | BUST | BUST | BUST | BUST | BUST | BUST |
| 100% | 636 | 542 | 614 | 868 | BUST | BUST | BUST | BUST | BUST | BUST |

5 LOSSES PER 10 (50% WIN RATE)
| ROI 10-100% | 10% | 20% | 30% | 40% | 50% | 60% | 70% | 80% | 90% | 100% |
|---|---|---|---|---|---|---|---|---|---|---|
| ROI 10-100% | BUST | BUST | BUST | BUST | BUST | BUST | BUST | BUST | BUST | BUST |

---

## Appendix B — Trades from 5 to 1 million (from chat)

1 LOSS PER 10 (90% WIN RATE)
| ROI \\ Size | 10% | 20% | 30% | 40% | 50% | 60% | 70% | 80% | 90% | 100% |
|---|---|---|---|---|---|---|---|---|---|---|
| 10% | 1679 | 974 | 778 | 704 | 686 | 701 | 746 | 826 | 969 | BUST |
| 20% | 842 | 459 | 345 | 294 | 270 | 262 | 264 | 276 | 300 | BUST |
| 30% | 563 | 298 | 218 | 181 | 161 | 152 | 149 | 151 | 158 | BUST |
| 40% | 424 | 221 | 158 | 128 | 114 | 105 | 101 | 100 | 103 | BUST |
| 50% | 340 | 175 | 124 | 100 | 87 | 79 | 75 | 74 | 75 | BUST |
| 60% | 285 | 145 | 102 | 82 | 70 | 64 | 60 | 58 | 58 | BUST |
| 70% | 245 | 124 | 87 | 69 | 59 | 53 | 50 | 48 | 48 | BUST |
| 80% | 215 | 109 | 76 | 61 | 51 | 46 | 43 | 41 | 40 | BUST |
| 90% | 192 | 96 | 67 | 53 | 45 | 40 | 37 | 35 | 34 | BUST |
| 100% | 173 | 87 | 60 | 48 | 40 | 35 | 33 | 31 | 30 | BUST |

2 LOSSES PER 10 (80% WIN RATE)
| ROI \\ Size | 10% | 20% | 30% | 40% | 50% | 60% | 70% | 80% | 90% | 100% |
|---|---|---|---|---|---|---|---|---|---|---|
| 10% | 2657 | 2285 | 4505 | BUST | BUST | BUST | BUST | BUST | BUST | BUST |
| 20% | 1256 | 880 | 1006 | 1740 | BUST | BUST | BUST | BUST | BUST | BUST |
| 30% | 819 | 526 | 508 | 641 | 1173 | BUST | BUST | BUST | BUST | BUST |
| 40% | 611 | 378 | 334 | 369 | 493 | 992 | BUST | BUST | BUST | BUST |
| 50% | 488 | 295 | 248 | 256 | 306 | 444 | 1046 | BUST | BUST | BUST |
| 60% | 407 | 242 | 198 | 194 | 219 | 282 | 461 | 1780 | BUST | BUST |
| 70% | 349 | 204 | 164 | 157 | 170 | 205 | 287 | 591 | BUST | BUST |
| 80% | 306 | 178 | 141 | 131 | 138 | 159 | 204 | 321 | BUST | BUST |
| 90% | 272 | 157 | 123 | 114 | 116 | 130 | 157 | 215 | 502 | BUST |
| 100% | 245 | 140 | 110 | 100 | 100 | 109 | 128 | 161 | 284 | BUST |

3 LOSSES PER 10 (70% WIN RATE)
| ROI \\ Size | 10% | 20% | 30% | 40% | 50% | 60% | 70% | 80% | 90% | 100% |
|---|---|---|---|---|---|---|---|---|---|---|
| 10% | 6427 | BUST | BUST | BUST | BUST | BUST | BUST | BUST | BUST | BUST |
| 20% | 2447 | 4790 | BUST | BUST | BUST | BUST | BUST | BUST | BUST | BUST |
| 30% | 1475 | 1635 | BUST | BUST | BUST | BUST | BUST | BUST | BUST | BUST |
| 40% | 1061 | 938 | 2186 | BUST | BUST | BUST | BUST | BUST | BUST | BUST |
| 50% | 827 | 660 | 1021 | BUST | BUST | BUST | BUST | BUST | BUST | BUST |
| 60% | 679 | 512 | 651 | 1728 | BUST | BUST | BUST | BUST | BUST | BUST |
| 70% | 575 | 420 | 487 | 833 | BUST | BUST | BUST | BUST | BUST | BUST |
| 80% | 500 | 357 | 390 | 568 | 1782 | BUST | BUST | BUST | BUST | BUST |
| 90% | 441 | 310 | 327 | 435 | 883 | BUST | BUST | BUST | BUST | BUST |
| 100% | 396 | 274 | 281 | 352 | 590 | 2538 | BUST | BUST | BUST | BUST |

4 LOSSES PER 10 (60% WIN RATE)
| ROI \\ Size | 10% | 20% | 30% | 40% | 50% | 60% | 70% | 80% | 90% | 100% |
|---|---|---|---|---|---|---|---|---|---|---|
| 20% | 9562 | BUST | BUST | BUST | BUST | BUST | BUST | BUST | BUST | BUST |
| 30% | 3895 | BUST | BUST | BUST | BUST | BUST | BUST | BUST | BUST | BUST |
| 40% | 2378 | BUST | BUST | BUST | BUST | BUST | BUST | BUST | BUST | BUST |
| 50% | 1679 | 3314 | BUST | BUST | BUST | BUST | BUST | BUST | BUST | BUST |
| 60% | 1289 | 1635 | 4138 | BUST | BUST | BUST | BUST | BUST | BUST | BUST |
| 70% | 1046 | 1102 | 1728 | BUST | BUST | BUST | BUST | BUST | BUST | BUST |
| 80% | 882 | 842 | 1105 | 1210 | BUST | BUST | BUST | BUST | BUST | BUST |
| 90% | 764 | 683 | 825 | 1445 | BUST | BUST | BUST | BUST | BUST | BUST |
| 100% | 675 | 575 | 651 | 921 | BUST | BUST | BUST | BUST | BUST | BUST |

5 LOSSES PER 10 (50% WIN RATE)
| ROI 10-100% | 10% - 100% |
|---|---|
| ROI 10-100% | BUST |

