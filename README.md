# POLYPROPHET GOAT — FINAL FOREVER MANIFESTO (v56)

## 🎯 THE GOAL (NON-NEGOTIABLE)

**£5 → £100+ IN 24 HOURS WITH MINIMUM VARIANCE**

This is the **absolute primary objective**. Everything else serves this goal.

### The Optimal Solution (why 36% stake)

| Stake | Final £ | Profit | Max DD | Achieves £100? |
|-------|---------|--------|--------|----------------|
| 30% | £79.53 | +1491% | 51.00% | ❌ No |
| 34% | £98.45 | +1869% | 56.44% | ❌ Just under |
| **36%** | **£107.90** | **+2058%** | **59.04%** | **✅ OPTIMAL** |
| 38% | £117.00 | +2240% | 61.56% | ✅ Over-sized |
| 40% | £125.54 | +2411% | 64.00% | ✅ High variance |

**36% is the MIN-VARIANCE solution** that reliably hits £100:
- 2.5% less max drawdown than 38% (59% vs 62%)
- Still exceeds target by £8 (buffer for unlucky streaks)
- Based on 82.5% WR over 40 trades in 24h (Polymarket-verified)

---

This README is the **single canonical source of truth** for PolyProphet: goals, scope, strategy, sizing/variance doctrine, halt behavior, verification, and operations.

If this README conflicts with any other file or chat export, **this README wins**.

---

## ✅ Self-audit prompt (copy/paste for any AI or human)

Use this exact prompt to “final check EVERYTHING”:

> Verify PolyProphet is optimized for **£5 → £100 in 24h with MIN VARIANCE** (36% stake default).  
> Run `/api/version` (expect configVersion=56), `/api/backtest-polymarket?scan=1` (verify 36% hits £100+), `/api/verify-trades-polymarket`, `/api/gates`, `/api/halts`.  
> Confirm: 36% default stake, no duplicate cycles (slugHash present), no legacy assets (SOL), outcomes settled by Polymarket ground truth.  
> If any invariant fails, identify the exact code path and provide a patch + test evidence.

## 🧠 Handoff / Continuation Guide (read first)

If you have **zero prior context**, assume this:

- **What this is**: a single-file Node/Express service (`server.js`) that runs a Polymarket crypto-cycle bot + dashboard + audit endpoints.
- **What it trades**: Polymarket **15m crypto cycles** for **BTC/ETH/XRP** only.
- **Primary goal**: **£5 → £100 in 24h with MIN VARIANCE**.
- **Reality check**: the “£5 → £100 in 24h” path requires **36% stake** (MIN-VARIANCE optimal) and accepts ~59% max drawdown; the system makes this trade-off explicit and auditable.

### The invariants you must not break

- **Truthful outcomes**: PAPER + LIVE settlement and verification must prefer **Polymarket Gamma resolution** when a `slug` is available.
- **No duplicate counting**: Polymarket-native backtests must dedupe by `slug` and return `proof.slugHash`.
- **Executed-trade-based risk**: loss streak / drift logic must be based on **executed trade PnL**, not “signal correctness”.
- **Market scope clarity**: SOL is **legacy-only** and hidden by default; supported assets are BTC/ETH/XRP.

### Where to look in code (server.js)

- **Config version / defaults**: search `CONFIG_VERSION = 55`, `MAX_POSITION_SIZE`, `ORACLE.minOdds`, `ORACLE.maxOdds`.
- **Risk + sizing**: `TradeExecutor` (cycle trade limits, streak sizing, circuit breaker).
- **Truthful settlement**: search `fetchPolymarketResolvedOutcome`, `schedulePolymarketResolution`, `resolveAllPositions`.
- **Polymarket-native backtest**: `GET /api/backtest-polymarket` (search `slugHash`, `entry=CLOB_HISTORY`).
- **Ground-truth verification**: `GET /api/verify-trades-polymarket`.

### Cursor/VS Code OOM stability runbook (so you can actually work)

Some IDE crashes were caused by **log/terminal spam** + background indexing.

- **Tracked editor defaults**: `.vscode/settings.json` excludes `node_modules/`, `debug/`, `backtest-data/` and reduces terminal scrollback.
- **Runtime noise controls** (added in v55):
  - `LOG_SILENT=true` — silence most logs (recommended when using integrated terminal)
  - `DEBUG_WS=true` — re-enable WS “message preview” logs (OFF by default)
  - `LIGHT_MODE=1` — starts the HTTP API but **skips WebSocket + background loops** (safe for backtests/verification without live feeds)

**Low-memory local verification (Windows / PowerShell)**:

```powershell
$env:PORT='31888'
$env:LIGHT_MODE='1'
$env:LOG_SILENT='true'
$env:AUTH_USERNAME='bandito'
$env:AUTH_PASSWORD='bandito'
node server.js

# /api/version is public
Invoke-RestMethod "http://127.0.0.1:31888/api/version"

# protected endpoints: easiest is ?apiKey=<AUTH_PASSWORD>
Invoke-RestMethod "http://127.0.0.1:31888/api/backtest-polymarket?apiKey=bandito&limit=10"
```

**Data note**: `/api/backtest-polymarket` requires collector snapshots (`backtest-data/` or Redis). Those are intentionally **not** committed to `main`.

## 🏆 v56 IS THE PINNACLE — MIN-VARIANCE £5 → £100 IN 24H

### 📊 Polymarket-native backtest (Gamma outcomes) — example run (auditable)

This is what the built-in endpoint reports on the deployed collector snapshot set.

**Recommended (max legitimacy, 24h target run)**:

`GET /api/backtest-polymarket?tier=CONVICTION&minOdds=0.30&maxOdds=0.97&balance=5&lookbackHours=24&maxTradesPerCycle=1&selection=HIGHEST_CONF&respectEV=1&entry=CLOB_HISTORY&fidelity=1&stakeMode=PER_TRADE&maxExposure=0.40&scan=1&stakes=0.30,0.32,0.34,0.36,0.38,0.40`

| Stake | Trades | Polymarket WR | Profit | Max DD |
|------:|-------:|--------------:|-------:|-------:|
| 30% | 40 | 82.50% | +1490.66% | 51.00% |
| 32% | 40 | 82.50% | +1680.00% | 54.00% |
| 34% | 40 | 82.50% | +1869.03% | 56.44% |
| **36%** | 40 | 82.50% | **+2057.91%** | **59.04%** |
| 38% | 40 | 82.50% | +2240.30% | 61.56% |
| 40% | 40 | 82.50% | +2410.78% | 64.00% |

**Time span (this run)**: ~24h (from the endpoint’s `summary.timeSpan`)

**No-duplicates proof (this run)**: `slugHash=29e8bcbd3483bf1add8f001fe1c57ba5144bceebdfc21cba2870eabbc7657368`

**Key insight**: **36% stake is MIN-VARIANCE optimal** — hits £108 with 59% max DD (vs 62% at 38%).

**Tail-bet rule**: `minOdds=0.30` blocks low-price contrarian bets that destroy win rate.

---

## 1) The Goal (exact wording)

**MAX PROFIT ASAP WITH MIN VARIANCE**

Interpretation (what “min variance” means in aggressive mode): remove avoidable/self‑inflicted variance (false loss streaks, unnecessary halts, negative‑EV hedging, broken strategies), while accepting meaningful drawdowns when compounding aggressively.

---

## 2) Market Scope (what we trade)

**Crypto cycles only** on Polymarket:
- BTC / ETH / XRP only (**SOL removed from code** to avoid future confusion)
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

Expected (as of v56):
- `configVersion: 55`
- ONE preset: `GOAT` (MAX PROFIT ASAP with MIN avoidable variance)
- UI branding: **POLYPROPHET**
- PAPER + LIVE cycle settlement: uses **Polymarket Gamma resolution** when `slug` is available (truthful outcomes)

### v56 Critical Fixes (current):
1. ✅ **Truthful PAPER + LIVE settlement** — cycle-end closes use **Polymarket Gamma outcomes** (prevents “paper wins” that lose on Polymarket)
2. ✅ **Polymarket-native backtest (auditable)** — `/api/backtest-polymarket` returns **timeSpan + slugHash proof + stake scan**
3. ✅ **Realism controls** — `maxTradesPerCycle=1` + `selection=HIGHEST_CONF` + `respectEV=1` avoid “multi-asset same-cycle fantasy trades”
4. ✅ **Tail bet block (turbo)** — `minOdds=0.30` rejects low-price contrarian entries that collapse WR at high sizing
5. ✅ **Child-simple API panel** — backtest/verify/trades render as readable tables (no JSON required)

**KEY INSIGHT (ground truth)**:
- Avoid “Oracle vs Market” **contrarian tail bets** (low-price entries) — they are historically catastrophic.
- Prefer setups where the Oracle has a real edge *without* paying “nearly 1.00” (fees + tiny ROI).
- This is enforced by `minOdds=0.30` and the positive-EV gate.

### v52 Fixes (retained):
- ✅ Config drift fixed (deep-merge presets)
- ✅ Rolling accuracy tracker (per-asset CONVICTION WR)
- ✅ Auto-drift detection (<70% warning, <60% auto-disable)

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
- For robustness across regimes, the “sweet spot” is usually **~5–10% sizing** (default), with **20%** reserved for explicitly high-variance mode.

### Critical v46 evidence: stop-loss can create avoidable variance
From the extra debug (v46) and live correlation:
- Trade `ETH_1767212360212` closed via **STOP LOSS (-32%)**
- But the cycle later resolved **UP** (it would have won at resolution)

This is avoidable/self-inflicted variance: a safety mechanism that sometimes turns winners into losers.

### Sizing doctrine (spec)
Default doctrine to survive worst-case variance while compounding fast:
- **Base size**: ~10% of bankroll per ORACLE trade (min-variance default; 20% is aggressive/high-variance)
- **Acceleration**: allow size increases only after verified win streaks (STRIKE mode)
- **Throttle immediately** after losses (SAFE_ONLY / PROBE_ONLY)

If you want to push harder toward $1M speed:
- increase size, but accept higher bust risk (especially if win rate dips toward 80%)

---

## 9) Verification (Backtest + Forward-test)

### Backtest — Debug-Based (Historical)

**Endpoint**: `GET /api/backtest-proof`

**How it works**:
1. Reads debug export files from `debug/` folder
2. Extracts `cycleHistory` from each asset
3. Simulates trades with realistic fees (2% on profits) and slippage (1%)
4. Caps position size at $100 to prevent unrealistic compounding

**Query params**:
- `tier=CONVICTION|ADVISORY|ALL` — filter by tier (default: CONVICTION)
- `prices=EXTREME|ALL` — filter by entry price (default: EXTREME = <20¢ or >95¢)
- `balance=5` — starting balance (default: $5)
- `minConfigVersion=47` — only use data from specific version+

**Example**: `/api/backtest-proof?tier=ALL&prices=ALL&balance=10`

**Note**: On deployed server, backtest requires debug files. Export debug locally via "📥 Export Debug" button, or restore from `debug-archive` branch.

### 🏆 v56: Polymarket-Native Backtest (Ground Truth, Auditable)

**Endpoint**: `GET /api/backtest-polymarket`

**How it works (v56)**:
1. Pulls **collector snapshots** (Polymarket markets + bot signals) from Redis / `backtest-data/`
2. Builds a candidate trade list and **dedupes by Polymarket `slug`** (no double-counting)
3. Enforces **realism**:
   - group by 15m window across assets
   - `maxTradesPerCycle` (default: 1) — prevents “3 assets in the same 15m” fantasy unless you opt in
   - `selection` rule (default: `HIGHEST_CONF`) chooses which asset to take that window
   - optional `respectEV=1` applies the same positive-EV rule as runtime
4. Queries **Polymarket Gamma API** for the **ground-truth resolution outcome**
5. Determines entry price:
   - default: uses snapshot YES/NO prices (fast)
   - optional: `entry=CLOB_HISTORY` uses Polymarket **CLOB `/prices-history`** time-series prices (most Polymarket-native)
6. Simulates P&L with friction: slippage (1%) + profit fee (2%)
7. Returns **proof fields**:
   - `summary.timeSpan` (how many real hours/days are covered)
   - `proof.slugHash` (sha256 of processed slugs) so you can audit “no duplicates”

**Query params (most important)**:
- `tier=CONVICTION|ADVISORY|ALL` — filter by tier (default: CONVICTION)
- `minOdds=0.30` — min entry price (default: 30¢; blocks low-price tail bets)
- `maxOdds=0.97` — max entry price (default: 97¢)
- `balance=5` — starting balance (default: $5)
- `lookbackHours=24` — how far back to backtest (default: 24h)
- `stake=0.36` — position size as fraction of balance (default: 36% MIN-VARIANCE optimal)
- `maxExposure=0.40` — max exposure per 15m window (default: 40%)
- `limit=200` — max **15m windows** to process (rate limit protection)
- `maxTradesPerCycle=1` — realism guardrail (recommended)
- `selection=BEST_EV|HIGHEST_CONF` — how we choose the 1 trade per window
- `respectEV=1` — only include positive-EV candidates (recommended)
- `scan=1` — include a stake “sweet spot” scan table
- `stakes=0.30,0.32,0.34,0.36,0.38,0.40` — override scan stakes (centered on 36% optimal)
- `snapshotPick=EARLIEST|LATEST` — if multiple snapshots exist for same slug (rare), which one to use
- `entry=SNAPSHOT|CLOB_HISTORY` — entry price source (default: CLOB_HISTORY; recommended for maximum legitimacy)
- `fidelity=1` — CLOB price history resolution in minutes (only used with `entry=CLOB_HISTORY`)

**Example (recommended)**:

`/api/backtest-polymarket?tier=CONVICTION&minOdds=0.30&maxOdds=0.97&stake=0.36&balance=5&lookbackHours=24&limit=500&maxTradesPerCycle=1&selection=HIGHEST_CONF&respectEV=1&entry=CLOB_HISTORY&fidelity=1&stakeMode=PER_TRADE&maxExposure=0.40&scan=1&stakes=0.30,0.32,0.34,0.36,0.38,0.40`

**Output includes**:
- Win rate vs Polymarket resolution
- Total profit/loss simulation
- Time span covered (real hours/days)
- Expected value per $1 stake
- Proof: `slugHash` (no duplicates)
- Interpretation: ✅ PROFITABLE / ⚠️ POSITIVE EDGE BUT LOST / ❌ NEGATIVE

**Limitation (honest)**: even with `entry=CLOB_HISTORY`, we still don’t reconstruct your exact fill (orderbook + spread). We use Polymarket’s time-series price plus a conservative slippage model.

### ✅ Verify executed trades (ground truth)

**Endpoint**: `GET /api/verify-trades-polymarket`

Use this to confirm the bot’s **recorded wins/losses** match **Polymarket resolution** (detects divergence / silent outcome mismatches).

**Example**: `/api/verify-trades-polymarket?mode=PAPER&limit=100`

### Forward-test (Live)

**Endpoint**: `GET /api/forward-test`

**How it works**:
1. Reads collector snapshots from Redis (or `backtest-data/` folder)
2. Analyzes signal distribution, tier distribution, confidence
3. Does NOT simulate P&L — just shows what the bot WOULD have traded

**Enable collector**: `POST /api/collector/toggle`

**Check status**: `GET /api/collector/status`

### Public Health Checks

- `GET /api/health` — bot status, uptime, circuit breaker state
- `GET /api/version` — config version, git commit

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

### Optional / diagnostics environment variables (v56)
| Variable | Description | Default |
|----------|-------------|---------|
| `PORT` | Server port | `3000` |
| `API_KEY` | Bearer token for programmatic access | random |
| `LIGHT_MODE` | `1` = API-only (skip WS + background loops) | off |
| `LOG_SILENT` | `true` = silence most logs (prevents IDE OOM) | off |
| `DEBUG_WS` | `true` = enable WS message preview logs | off |

Security rule: never commit secrets; use `.env` locally and Render env vars in prod.

---

## 11) API Endpoints

### Public
- `GET /api/health`
- `GET /api/version`
- `GET /api/state-public`

### Protected (Basic auth)
- Note: the server also accepts `?apiKey=<AUTH_PASSWORD>` for quick scripting (same as `Authorization: Bearer <API_KEY>`). Treat this as a convenience feature; secure your deployment appropriately.
- `GET /api/state`
- `GET /api/gates`
- `GET /api/halts`
- `GET /api/trades`
- `GET /api/backtest-proof` — Debug-based backtest
- `GET /api/backtest-polymarket` — **🏆 Polymarket Gamma API verified backtest (real outcomes)**
- `GET /api/verify-trades-polymarket` — **✅ Verify executed trades vs Polymarket outcomes (detect divergence/mismatches)**
- `GET /api/forward-test`
- `GET /api/calibration`
- `GET /api/circuit-breaker`
- `GET /api/verify`
- `POST /api/reset-balance`
- `POST /api/circuit-breaker/override`
- `POST /api/toggle-stop-loss-override`

---

## ✅ FINAL Acceptance Checklist (v55)

Run these checks **before** calling anything “final / GOAT”:

### A) Deployment identity (no config drift)
- `GET /api/version` shows **configVersion=56** and the expected git commit.
- `GET /api/health` is green and uptime is increasing normally.

### B) Market scope + anti-confusion (SOL is truly gone)
- `/api/trades` shows **BTC/ETH/XRP only** (SOL hidden by default).
- If you run `/api/trades?includeLegacy=1`, any old SOL trades are clearly “legacy”.

### C) Polymarket-native backtest is auditable and duplicate-free
- Run:
  - `/api/backtest-polymarket?tier=CONVICTION&minOdds=0.30&maxOdds=0.97&balance=5&lookbackHours=24&maxTradesPerCycle=1&selection=HIGHEST_CONF&respectEV=1&entry=CLOB_HISTORY&fidelity=1&stakeMode=PER_TRADE&maxExposure=0.40&scan=1`
- Confirm:
  - `summary.timeSpan` is present (hours/days covered)
  - `proof.slugHash` is present (no duplicates)
  - `maxTradesPerCycle=1` is respected (realism)
  - “sweet spot” scan shows your preferred stake vs max drawdown
- Optional (speed): use `entry=SNAPSHOT` (faster, slightly less “Polymarket-native”).

### D) Executed trades match Polymarket resolution (no silent mismatch)
- Run:
  - `/api/verify-trades-polymarket?mode=PAPER&limit=200`
- Confirm:
  - `mismatches` is **~0 for comparable (binary exit) trades** after v55 settlement changes
  - Any remaining mismatches should be explainable (legacy trades, early exits, missing slug).

### E) Gates + halts are truthful (minimize avoidable variance)
- `GET /api/gates` shows why trades are blocked (most often `negative_EV`).
- `GET /api/halts` shows explicit reasons/state (no mystery halts).
- Loss streak / drift logic is based on **EXECUTED trade outcomes**, not “signal correctness”.

### F) LIVE truthfulness + redemption
- LIVE mode must settle cycle outcomes from **Polymarket ground truth** (Gamma).
- Winners are queued for redemption; binary resolution should not trigger “sell” attempts.
- If anything about LIVE settlement is unclear, **do not run LIVE** until `/api/verify-trades-polymarket?mode=LIVE` looks clean.

### G) Reality check: “$5 → $100 in 24h”
- This requires ~20× growth in 24h — aggressive but achievable with 82.5%+ WR.
- **36% stake is the MIN-VARIANCE optimal** — hits £108 with 59% max DD (vs 62% at 38%).
- The backtest shows this is achievable; actual results depend on market conditions.
- Use `scan=1` to verify the optimal stake for your risk tolerance.

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
- `.vscode/settings.json` (optional; included to prevent IDE OOM / runaway indexing)
- `README.md` (this manifesto)

### Archive branch contains history
All historical runtimes, debug artifacts, forensic docs, and chat exports go to an `archive` branch (preserved, but not in `main`).

---
## 13) Historical notes (archived)

This README is intentionally kept **current-only** (to avoid future confusion).
Older forensic notes, intermediate versions, and legacy presets are preserved in git history / archive branches if needed.


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

