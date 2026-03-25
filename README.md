# POLYPROPHET — Autonomous Polymarket Trading Bot

> **THE IMMORTAL MANIFESTO** — Source of truth for all AI agents and operators.
> Read fully before ANY changes. Continue building upon this document.

**Last Updated**: 25 March 2026 | **Runtime**: `polyprophet-lite` (promoted to repo root) | **Deploy**: Render (Oregon) + Japan proxy

---

## Table of Contents

1. [Mission](#mission)
2. [AI Collaboration Protocol](#ai-collaboration-protocol)
3. [Architecture Overview](#architecture-overview)
4. [Current Runtime Truth](#current-runtime-truth)
5. [Strategy Readiness](#strategy-readiness)
6. [Risk & Bankroll Model](#risk--bankroll-model)
7. [Deployment](#deployment)
8. [Operator Pre-Flight Checklist](#operator-pre-flight-checklist)
9. [API Reference](#api-reference)
10. [Key Mechanics](#key-mechanics)
11. [Lessons Learned](#lessons-learned)
12. [Version History](#version-history)
13. [Legacy Archive Reference](#legacy-archive-reference)

---

## Mission

**Goal**: $5 → $1M via compounding on Polymarket crypto up/down markets.

**Starting Point**: ~$5-$7 USDC, aggressive sizing until ~$20, then 80% sizing.

**CRITICAL**: User CANNOT lose the first few trades. One loss at $5 = severe setback.

### Required Metrics

| Metric | Target | Current Reality |
|--------|--------|-----------------|
| Win Rate | ≥88% | Check live runtime first; if rolling accuracy is unavailable on lite, say so |
| ROI/Trade | 20-50% | Depends on entry price band |
| Frequency | Use the combined 15m + 4h + 5m stack when honestly executable | Strategy-set and bankroll dependent |
| First Trades | CANNOT LOSE | Must verify before user trades |

### From Risk Tables (88% WR, ~30% avg ROI, 32% sizing)

- **$20 start, 4h strategies**: median $1,581 in 30 days (Monte Carlo)
- **$7 start, 4h strategies**: median $961 in 30 days, 8% bust risk
- **80% sizing at 90% WR**: Survives variance
- **100% sizing**: BUST even at 90% WR

### Bankroll Growth Path

| Phase | Bankroll | Strategy | Sizing |
|-------|----------|----------|--------|
| Bootstrap | $5-$20 | 15m only, all-in accepted | MICRO_SPRINT (0.32 cap, 0.45 exceptional) |
| Growth | $20-$50 | 15m + 4h enabled | SPRINT_GROWTH (0.32 cap) |
| Expansion | $50+ | 15m + 4h + 5m enabled | SPRINT_GROWTH |
| Preservation | $1,000+ | All timeframes | LARGE_BANKROLL (0.07 cap) |

### Current Autonomy Target and Honest Boundary

- **Target posture**: coordinated autonomous trading across **15m + 4h + 5m** so the combined strategy stack maximizes profit in the shortest realistic time.
- **Current honest boundary**:
  - `15m` is the only fully active primary path.
  - `4h` is strategy-validated and ready to enable, but still needs env posture + live verification.
  - `5m` is signal-valid but should remain disabled for execution below roughly **$50 bankroll** because replay survivability is fragile at micro bankrolls.
- **Non-negotiable truthfulness rule**: never present theoretical, best-case, or inflated projections without explicitly stating the runtime gates, bankroll constraints, min-order effects, fees, and survivability assumptions.

---

## AI Collaboration Protocol

### Dual-Agent Workflow (Claude Opus + ChatGPT)

POLYPROPHET uses a **dual-AI agentic workflow** where Claude Opus (via Windsurf/Cascade) and ChatGPT (via browser/API) work consecutively on the same codebase.

#### Agent Self-Identification

Every AI agent MUST identify itself at session start:

```
I am [Claude Opus / ChatGPT / Other] operating as DEITY agent.
Session started: [timestamp]
Last known state: [from README.md]
```

#### Agent Roles

| Agent | Primary Strength | Use For |
|-------|-----------------|---------|
| **Claude Opus** (Cascade/Windsurf) | Code execution, file editing, terminal access, deployment | Implementation, debugging, deployment, code changes |
| **ChatGPT** (Browser/API) | Deep analysis, strategy research, long-form reasoning | Strategy validation, mathematical proofs, research, planning |

#### Handover Protocol

When ending a session, the outgoing agent MUST:

1. Update this README's "Current Session State" section
2. Document what was done, what was discovered, what is pending
3. Note any discrepancies found
4. Leave clear next-action items

When starting a session, the incoming agent MUST:

1. Read this entire README first
2. Read the DEITY skill file
3. Check `IMPLEMENTATION_PLAN_v140.md` for pending work
4. Query `/api/health` for current live state
5. Inspect the relevant dashboard surface when auditing runtime behavior
6. State what it found and what it plans to do

#### Mandatory README Addendum Protocol

For any substantial analysis, audit, deployment verification, or directional change, the acting agent MUST append or update a README addendum-style note covering:

1. What was investigated
2. Exact methodology used
3. Data sources used
4. Any assumptions made
5. Discrepancies or unresolved ambiguity
6. Why the chosen direction is better than rejected alternatives

If an agent wants to reverse or materially redirect prior work, it must first re-read the prior reasoning in `README.md` and `IMPLEMENTATION_PLAN_v140.md`, then document the comparison before changing course.

#### Mandatory Lite vs Legacy Comparison Protocol

Before major runtime, strategy, dashboard, or execution changes, agents MUST compare the touched lite behavior against `legacy-root-runtime/` and explicitly check whether any still-useful mechanics, safeguards, UI signals, or recovery features should be ported into lite.

This does **not** mean blindly reintroducing legacy code. It means using the archived monolith as a feature/reference bank and documenting why something should or should not be carried over.

#### Mandatory Audit Scope

When performing an audit, agents must verify more than API responses. The minimum audit surface is:

1. Runtime endpoints (`/api/health`, `/api/status`, `/api/diagnostics`, `/api/wallet/balance`)
2. Dashboard/UI surfaces relevant to the change
3. Runtime-vs-README consistency
4. Lite-vs-legacy feature comparison for touched systems
5. Real-world execution path assumptions: balance source, entry, fills, partial fills, exits, redemption, and failure handling

#### Mandatory Response Brief

Every substantive response MUST begin with:

```
## BRIEF
**Task**: [What was asked]
**Approach**: [How you will do it]
**Data Sources**: [LIVE API / Debug Logs / Code Analysis]
**Risks**: [What could go wrong]
**Confidence**: [HIGH/MEDIUM/LOW + justification]
**Verification Plan**: [How you will verify correctness]
```

### Agent Rules (ENFORCED — NO EXCEPTIONS)

| Rule | Meaning |
|------|---------|
| NO LYING | Report exactly what you find, even if bad news |
| NO SKIMMING | Read every character of README + Skills |
| NO HALLUCINATING | If data doesn't exist, say "I don't know" |
| NO ASSUMING | Verify with data, code, or backtest |
| NO COMPLACENCY | Never conclude "impossible" without exhaustive testing |
| ASK QUESTIONS | When not 100% certain, ask user |
| VERIFY TWICE | Check before AND after every response |
| WORST VARIANCE | Always assume worst possible luck |
| REAL-WORLD CHECK | Ensure everything works on actual Polymarket |

### Anti-Hallucination Rules

If presenting ANY performance data:

```
DATA SOURCE: [Live API / Local Debug File dated X / Code Analysis]
LIVE RUNTIME STATUS: [query /api/health + /api/status first]
LIVE METRIC AVAILABILITY: [If rolling accuracy is unavailable on lite, explicitly say unavailable]
DISCREPANCIES: [None / Describe any mismatch]
```

| Rule | Enforcement |
|------|-------------|
| NEVER trust local debug logs blindly | Always check file dates first |
| ALWAYS verify with LIVE data | Query `/api/health` and `/api/status` first |
| CROSS-CHECK all claims | If backtest says X but live says Y, REPORT IT |
| ENTRY PRICE SANITY CHECK | If all prices identical = SYNTHETIC data |
| RECENCY CHECK | Anything >24h old must be flagged |

### Key Files

| File | Purpose |
|------|---------|
| `README.md` | This file — immortal manifesto, source of truth |
| `IMPLEMENTATION_PLAN_v140.md` | Detailed audit trail with all addenda (AO30.x series) |
| `server.js` | Lite runtime entry point |
| `lib/config.js` | All configuration and env var handling |
| `lib/strategy-matcher.js` | Strategy set loading and signal evaluation |
| `lib/risk-manager.js` | Bankroll management, adaptive sizing |
| `lib/trade-executor.js` | CLOB order execution, sell queue, redemption |
| `lib/market-discovery.js` | Polymarket market discovery per timeframe |
| `lib/clob-client.js` | Polymarket CLOB API client with proxy support |
| `render.yaml` | Render deployment blueprint |
| `.windsurf/workflows/` | AI agent workflow definitions |

---

## Architecture Overview

### Runtime: `polyprophet-lite`

As of **23 March 2026** (Addendum AO30.36), `polyprophet-lite` was promoted to the repository root, replacing the old monolith runtime.

**What this means:**
- `npm start` at repo root runs the lite runtime (`server.js`)
- `render.yaml` points to root `npm ci` / `npm start`
- The old monolith is archived in `legacy-root-runtime/`
- The lite runtime is ~22KB vs the old ~1.85MB monolith

### Core Components

```
server.js                    <- Express app, orchestrator loop, API endpoints
lib/
  config.js                  <- ENV-driven configuration, timeframe definitions
  market-discovery.js        <- Polymarket Gamma API market discovery
  strategy-matcher.js        <- Walk-forward validated strategy set loading/matching
  risk-manager.js            <- Adaptive bankroll profiles (MICRO_SPRINT -> LARGE_BANKROLL)
  trade-executor.js          <- CLOB order placement, sell retry queue, redemption
  clob-client.js             <- @polymarket/clob-client wrapper with proxy support
  telegram.js                <- Telegram signal notifications
public/                      <- Dashboard UI
scripts/
  collect-historical.js      <- Historical market data collector
  strategy-scan.js           <- Walk-forward strategy search
strategies/                  <- Bundled fallback strategy sets
debug/                       <- Validated strategy artifacts (preferred over strategies/)
data/                        <- Runtime state persistence
```

### Signal Flow

```
1. Market Discovery (Gamma API) -> find active markets per enabled timeframe
2. Strategy Matcher -> evaluate loaded strategy set against current market state
3. Risk Manager -> size the trade (adaptive profile + min-order handling)
4. Trade Executor -> place order on Polymarket CLOB (with proxy if geoblocked)
5. Resolution -> auto-detect outcome, queue redemption for wins
6. Bankroll Update -> adjust profile if balance crosses tier thresholds
```

### Strategy-Native Execution (NOT Oracle-Driven)

The lite runtime uses **strategy-native entry generation**:
- Strategy sets define exact UTC hour, entry minute, direction, and price band
- When current market conditions match a loaded strategy, a trade candidate is generated
- The old oracle/ensemble model system is legacy — it is NOT the 15m BUY trigger
- Oracle role is now telemetry/confidence context only

---

## Current Runtime Truth

### What Is Actually Running

POLYPROPHET is configured for autonomous Polymarket crypto up/down trading using:

- **`top7_drop6`** as the authoritative 15m strategy set (7 strategies, 88.3% WR over 110 days)
- **Strategy-native 15m entry generation** (not oracle-driven)
- **Adaptive sizing** via `MICRO_SPRINT` profile at micro bankrolls
- **Redis-backed persistence** for state recovery
- **Proxy-backed CLOB routing** when geoblocked (Oregon -> Japan proxy)
- **Auto-sell / resolution / redemption lifecycle** handling

### Live Deployment

| Field | Value |
|-------|-------|
| **URL** | `https://polyprophet-1-rr1g.onrender.com` |
| **Runtime** | `polyprophet-lite` (root-promoted) |
| **Version** | `polyprophet-lite-1.0.0` |
| **Last Deploy Commit** | `1c3c90f` (root-lite promotion) |
| **Deploy Method** | Manual Render dashboard (auto-deploy not configured) |

### Live API Surface (Lite Runtime)

The lite runtime exposes different endpoints than the old monolith. These are the current live endpoints:

| Endpoint | Purpose |
|----------|---------|
| `GET /api/health` | Runtime mode, balance, enabled timeframes, loaded strategy sets |
| `GET /api/status` | Risk state, executor state, markets, orchestrator, strategies |
| `GET /api/diagnostics` | Diagnostic log, orchestrator heartbeat |
| `GET /api/wallet/balance` | Wallet balance breakdown |

**Legacy endpoints that NO LONGER EXIST** (return 404):
- `/api/version`, `/api/live-op-config`, `/api/multiframe/status`, `/api/state`
- `/api/verify`, `/api/perfection-check`, `/api/gates`

### Verified Live Configuration

From live `GET /api/health` (24 March 2026):

- `mode`: LIVE
- `isLive`: true
- Active assets: BTC, ETH, SOL, XRP
- Enabled timeframes: 15m, 4h (per live env overrides)
- 5m: disabled
- Orchestrator: running, discovering markets

### Known Live Mismatch (Strategy Artifacts)

**Important**: The live service is currently loading **fallback bundled** strategy sets (`/app/strategies/strategy_set_*_top8.json`) instead of the intended validated `debug/` artifacts specified in `render.yaml`.

Root cause candidates:
1. Render env vars overriding blueprint values
2. `debug/` artifacts not resolving on the deployed host

**Action required**: Re-check Render service environment and confirm host can resolve the `debug/` strategy files, then redeploy and verify.

---

## Strategy Readiness

### Honest Readiness Table (25 March 2026)

| Timeframe | Strategy Set | Default State | Evidence | Verdict |
|-----------|-------------|---------------|----------|---------|
| **15m** | `debug/strategy_set_top7_drop6.json` | ENABLED | 489 trades, 88.3% WR, 110 days | **READY — Primary active path** |
| **4h** | `debug/strategy_set_4h_maxprofit.json` | DISABLED | 438 trades, 84.7% WR, 108 days, 4 assets | **READY TO ENABLE — needs env flag** |
| **5m** | `debug/strategy_set_5m_maxprofit.json` | DISABLED | 923 signals, 80.7% WR, 10 days, 4 assets | **SIGNAL-VALID but micro-bankroll fragile** |
| **1h** | None | N/A | Polymarket does not offer 1h markets | **NOT SUPPORTED** |

### 15m Strategy Details (`top7_drop6`)

- **Source**: `debug/strategy_set_top7_drop6.json`
- **Replay evidence**: 432/489 = 88.3% WR over 110 days at ~4.4 trades/day
- **Strategy artifact evidence**: historical 94.1%, OOS 94.8%, live sample 90.5%
- **Deployment-level live proof**: Still N/A until funded autonomous fills accumulate
- **Entry price range**: 60-80c

### 4h Strategy Details (`4h_maxprofit`)

- **Source**: `debug/strategy_set_4h_maxprofit.json` — 8 walk-forward validated strategies
- **Dataset**: 532,560 rows from 2,219 resolved 4h markets, 108.7 days, all 4 assets
- **Aggregate**: 438 trades, 84.7% WR, 81.0% LCB, ~4.09 trades/day
- **Replay from $20**: -> $7,617 (380x), max DD 54.6%
- **Monte Carlo from $20**: median $1,581 in 30 days, 1.12% bust rate
- **Stress**: survives +5c adverse fill (still profitable), degrades at +10c
- **To enable**: Set `MULTIFRAME_4H_ENABLED=true` in Render env

### 5m Strategy Details (`5m_maxprofit`)

- **Source**: `debug/strategy_set_5m_maxprofit.json` — 10 walk-forward validated strategies
- **Dataset**: 56,720 rows from 11,344 CLOB-enriched markets, all 4 assets, 39.3 days
- **Raw signal quality**: 923 matches, 80.7% WR — genuine predictive edge
- **Problem**: Replay at $20 start **failed** — 4 early losses wiped below min-order threshold
- **Recommended minimum bankroll**: $50+ for 5m execution
- **Verdict**: Enable signal display/monitoring now; enable live execution when bankroll permits

---

## Risk & Bankroll Model

### Adaptive Bankroll Profiles (AUTO_BANKROLL_MODE=SPRINT)

| Bankroll | Profile | Max Position | Kelly | Risk Envelope | Profit Protection |
|---------:|---------|:------------:|:-----:|:-------------:|:-----------------:|
| < $20 | MICRO_SPRINT | 0.32 (0.45 exceptional) | ON (k=0.25, cap 0.32) | ON | OFF |
| $20-$999 | SPRINT_GROWTH | 0.32 (0.45 exceptional) | ON (k=0.25, cap 0.32) | ON | OFF |
| >= $1,000 | LARGE_BANKROLL | 0.07 | ON (cap 0.12) | ON | ON |

### Polymarket Minimum Order Reality

- CLOB minimum: **5 shares** for crypto up/down markets
- At 75c entry: min order = $3.75
- At 65c entry: min order = $3.25
- At 60c entry: min order = $3.00

**At micro bankrolls ($5-$7)**: The `MICRO_SPRINT` profile's 0.32 max position fraction produces a base size below every min-order cost. The runtime **bumps to min-order** via the bootstrap override path. This means:
- Actual trade sizes are min-order dominated, not fraction-driven
- Effective risk per trade is 43-58% of bankroll depending on entry band
- One early high-band loss can materially reduce tradability

### First-Trade Risk at $6.95

| Entry Band | Bumped To | % of Bankroll | Remaining After Loss |
|:----------:|:---------:|:-------------:|:--------------------:|
| 60c | $3.00 | 43.2% | ~$3.95 |
| 65c | $3.25 | 46.8% | ~$3.70 |
| 72c | $3.60 | 51.8% | ~$3.35 |
| 75c | $3.75 | 54.0% | ~$3.20 |
| 80c | $4.00 | 57.6% | ~$2.95 |

### Safeguards

| Safeguard | Setting | Purpose |
|-----------|---------|---------|
| Hard stop-loss | 15c drop | Instant exit on 15m (20c for 4h) |
| Post-entry momentum | 10c drop in 60s | Catches genuine reversals |
| Fast emergency | 25c drop, 5s hysteresis | Prevents catastrophic loss |
| Velocity gate | 5c drop in 60s | Don't enter falling markets |
| Global stop | 20% daily loss | Halt all trading |
| Loss cooldown | 3 consecutive losses | 20 min pause |
| Balance floor | $2.00 | Hard stop for new trades |

### Operator Stake Configuration

- `OPERATOR_STAKE_FRACTION=0.45` — keep at 0.45 for bankrolls <= $20
- At $6.95, changing to 0.50 or 0.60 has **zero effect** because all three are capped to 0.32 by MICRO_SPRINT's `maxPositionFraction`
- The binding constraint at micro bankrolls is the **min-order bump path**, not the operator stake fraction

---

## Deployment

### Render Configuration

**Blueprint**: `render.yaml` at repo root

```yaml
services:
  - type: web
    name: polyprophet
    runtime: node
    buildCommand: npm ci
    startCommand: npm start
    healthCheckPath: /api/health
```

### Required Environment Variables

```env
# Trading Mode
TRADE_MODE=LIVE
ENABLE_LIVE_TRADING=1
LIVE_AUTOTRADING_ENABLED=true
TELEGRAM_SIGNALS_ONLY=false
START_PAUSED=false

# Strategy
STRATEGY_SET_15M_PATH=debug/strategy_set_top7_drop6.json
STRATEGY_SET_4H_PATH=debug/strategy_set_4h_maxprofit.json
STRATEGY_SET_5M_PATH=debug/strategy_set_5m_maxprofit.json
OPERATOR_STAKE_FRACTION=0.45
MAX_POSITION_SIZE=0.45
DEFAULT_MIN_ORDER_SHARES=5
AUTO_BANKROLL_MODE=SPRINT

# Timeframes
TIMEFRAME_15M_ENABLED=true
TIMEFRAME_5M_ENABLED=false
MULTIFRAME_4H_ENABLED=false
ENABLE_4H_TRADING=false

# Assets
ASSETS=BTC,ETH,SOL,XRP

# Wallet
POLYMARKET_PRIVATE_KEY=<set>
POLYMARKET_SIGNATURE_TYPE=1

# Proxy (required if geoblocked)
PROXY_URL=<set>
CLOB_FORCE_PROXY=1

# Persistence
REDIS_ENABLED=true
REDIS_URL=<set>

# Auth
NO_AUTH=false
AUTH_USERNAME=<set>
AUTH_PASSWORD=<set>

# Notifications (recommended)
TELEGRAM_BOT_TOKEN=<set>
TELEGRAM_CHAT_ID=<set>
```

### Deploy Steps

1. Push to `origin/main`
2. Open Render dashboard -> polyprophet service -> **Manual Deploy** -> Deploy latest commit
3. Wait for build (~2-5 min)
4. Verify via `GET /api/health`

**Note**: Auto-deploy is NOT configured. Manual deploy via Render dashboard is required.

### Legacy Runtime Archive

The old monolith runtime is preserved in `legacy-root-runtime/`:
- `server.root-monolith.js` — the original ~1.85MB server
- `public.root-monolith/` — old dashboard
- `scripts.root-monolith/` — old scripts
- `render.root-monolith.yaml` — old deploy blueprint

---

## Operator Pre-Flight Checklist

Before allowing autonomous operation, verify these lite runtime endpoints:

1. `GET /api/health` — check `version`, `mode`, `timeframes`, `strategySets`
2. `GET /api/status` — check `risk`, `executor`, `markets`, `strategies`
3. `GET /api/wallet/balance` — check `walletLoaded`, `balanceBreakdown`

You want to see:
- Mode = LIVE
- Strategy sets loaded for enabled timeframes
- Wallet loaded with sufficient balance
- Correct timeframes enabled
- Orchestrator running and discovering markets

### Remaining Actions Before GO

1. **Verify strategy artifact loading** — confirm live `/api/health` shows `debug/` paths, not fallback `strategies/`
2. **Run one funded live smoke test** — one buy fills, one sell/resolve, one redeem, balance reconciles
3. **Enable authentication** — set `NO_AUTH=false` + credentials
4. **Inspect dashboard parity** — confirm dashboard reflects the same enabled timeframes, strategy paths, balance, and runtime status seen in the APIs
5. **Optional**: top up bankroll toward $8-$10 for smoother post-loss survivability

---

## API Reference

### Lite Runtime Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/health` | GET | Runtime mode, version, balance, timeframes, strategy sets |
| `/api/status` | GET | Full status: risk, executor, markets, orchestrator, strategies |
| `/api/diagnostics` | GET | Diagnostic log, heartbeat |
| `/api/wallet/balance` | GET | Wallet balance breakdown |
| `/` | GET | Dashboard UI |

### Common Health Response Fields

```json
{
  "version": "polyprophet-lite-1.0.0",
  "mode": "LIVE",
  "isLive": true,
  "balance": { "available": "...", "source": "..." },
  "timeframes": ["15m"],
  "configuredTimeframes": { "5m": false, "15m": true, "4h": false },
  "strategySets": {
    "15m": { "loaded": true, "path": "...", "strategies": 7 }
  }
}
```

---

## Key Mechanics

### Strategy Set Execution Model

Each strategy in a set defines:
- **UTC hour** and **entry minute** within the cycle
- **Direction** (UP or DOWN)
- **Price band** (min/max entry price, e.g., 60-80c)
- **Asset scope** (ALL or specific)

When the orchestrator detects a matching market condition, it generates a trade candidate. The risk manager then sizes and approves/blocks based on current bankroll state.

### Timeframe Gating

Timeframes are controlled by environment flags:
- `TIMEFRAME_15M_ENABLED` (default: true)
- `TIMEFRAME_5M_ENABLED` (default: false)
- `MULTIFRAME_4H_ENABLED` / `ENABLE_4H_TRADING` (default: false)

Only enabled timeframes participate in market discovery and strategy evaluation.

### Min-Order Bump Path (Micro Bankrolls)

At micro bankrolls, the adaptive sizing chain works as follows:

1. Adaptive policy -> `maxPositionFraction = 0.32`
2. `basePct = min(0.32, operatorStakeFraction)` -> base size
3. If base size < min order cost -> **bump to min order**
4. `MICRO_SPRINT` relaxes survival floor -> `minCashForMinOrder = cost * 1.05`
5. `BOOTSTRAP` override allows trade if `balance >= minOrderCost`

### Resolution and Redemption

- The runtime auto-detects market resolution via Gamma API
- Winning positions are queued for CTF contract redemption
- Sell retry queue handles partial fills and retries
- State persists to disk (`data/runtime-state.json`) for crash recovery

---

## Lessons Learned

### The Hallucination Incident (2026-01-16)

Agent presented 100% WR backtest; live reality was 25% WR.
- **Root cause**: Stale debug logs from Dec 2025, synthetic entry prices
- **Fix**: Anti-hallucination rules, mandatory DATA SOURCE statement

### The Complacency Incident (2026-01-16)

Agent concluded "50/50 random, impossible to predict."
- **Root cause**: Surface-level analysis
- **Fix**: Exhaustive research found 5 exploitable edges (latency arb, cross-asset correlation, volume patterns, streak reversion, time-of-day)

### Strategy Artifact Mismatch (2026-03-24)

Live service loaded fallback bundled strategies instead of validated `debug/` artifacts.
- **Root cause**: Render env/file resolution mismatch
- **Status**: Documented, pending resolution

### Deployment Authority Mismatch (2026-03-23)

`render.yaml` and `DEPLOY_RENDER.md` pointed at different entrypoints.
- **Fix**: Unified both to root runtime (AO30.31), then promoted lite to root (AO30.36)

---

## Version History

### Current: polyprophet-lite (root-promoted)

| Date | Change | Reference |
|------|--------|-----------|
| 2026-03-24 | Manual Render redeploy verified lite is live | AO30.37 |
| 2026-03-23 | Promoted polyprophet-lite to repo root | AO30.36 |
| 2026-03-23 | Lite finalization: timeframe gating, artifact wiring | AO30.35 |
| 2026-03-23 | Deployment push + live verification | AO30.34 |
| 2026-03-23 | Fresh 5m all-asset validation (80.7% WR, 923 signals) | AO30.33 |
| 2026-03-23 | Fresh 4h max-profit set (84.7% WR, 438 trades) | AO30.32 |
| 2026-03-23 | Deploy blocker analysis + render.yaml fix | AO30.31 |
| 2026-03-23 | 5m all-asset coverage boundary | AO30.30 |
| 2026-03-23 | Live runtime truth re-check | AO30.29 |
| 2026-03-22 | Fresh 5m + 4h strategy validation pass | AO30.28 |

### Legacy Monolith Versions (Archived)

The old monolith went through v105-v140 with features including:
- v138: GOLDEN HOURS system (6 UTC hours, avg WR 88.4%)
- v122: CONVICTION PERFECTION + anti-flip + dashboard signals
- v116: Two-tier oracle (Forecast vs CALL separation)
- v115: Stale-safe, non-gambling oracle
- v113: Final oracle mode with confirm-gated trading
- v112: Bankroll-sensitive oracle parameters
- v109: NO_AUTH + paper auto-trading

Full version history is preserved in git history and `IMPLEMENTATION_PLAN_v140.md`.

---

## Legacy Archive Reference

The following documents contain detailed historical context:

- **`IMPLEMENTATION_PLAN_v140.md`** — Full audit trail with 37+ addenda covering every investigation, strategy validation, deployment verification, and design decision
- **`legacy-root-runtime/`** — Archived old monolith server, dashboard, scripts, and deploy config
- **`FINAL_OPERATOR_GUIDE.md`** — Previous operator guide (some content now superseded by this README)

The legacy README content (3000+ lines of version-by-version oracle documentation) has been replaced by this consolidated document. The old content remains accessible in git history.

### Housekeeping Addendum — Manifesto and Harness Reverification (25 March 2026)

This housekeeping pass independently reverified the consolidated README and workflow harness against the current repo state.

#### Scope

- Re-read the current `README.md`
- Re-read the relevant AO30 implementation-plan addenda
- Re-read the active Windsurf workflow files and global rules
- Re-check the lite runtime surface in `server.js`
- Re-check the existence and structure of `legacy-root-runtime/`

#### Methodology

1. Verified the live lite endpoint model against actual `server.js` routes.
2. Checked the root promotion and archive claims against the current repo layout.
3. Searched the harness for stale legacy endpoint references and legacy-oracle assumptions.
4. Compared workflow requirements against the user's requested Claude Opus + ChatGPT consecutive-agent process.
5. Tightened the manifesto so audits require dashboard inspection, lite-vs-legacy comparison, README addendum logging, and explicit treatment of unavailable live metrics.

#### Verified Truths

- The repo root currently runs `polyprophet-lite`.
- The legacy monolith is archived in `legacy-root-runtime/`.
- The active lite API surface is `/api/health`, `/api/status`, `/api/diagnostics`, and `/api/wallet/balance`.
- `15m` is the active primary path.
- `4h` is validated and ready to enable subject to env posture and live verification.
- `5m` is validated for signal quality but remains execution-fragile at micro bankrolls.

#### Unresolved Risks

- Live strategy artifact resolution still appears to prefer fallback `strategies/` files over intended `debug/` artifacts.
- No funded end-to-end live smoke test has yet proven the full autonomy chain.
- Lite does not expose a built-in rolling-accuracy field comparable to older runtime expectations, so agents must state that explicitly rather than inventing it.

### Runtime Hardening Audit — Full Code + Strategy + Profit Sim + Legacy Comparison (25 March 2026)

#### Scope

Full atomic-level audit of `polyprophet-lite` runtime to verify the bot will genuinely trade autonomously on the next matching strategy cycle. Includes:
- Complete read of `server.js`, `lib/config.js`, `lib/strategy-matcher.js`, `lib/risk-manager.js`, `lib/trade-executor.js`, `lib/market-discovery.js`, `lib/clob-client.js`, `lib/telegram.js`
- Validation of all 3 strategy artifacts
- Monte Carlo profit simulation (10,000 trials, 30 days)
- Dashboard audit (`public/index.html`)
- Lite-vs-legacy comparison against `legacy-root-runtime/server.root-monolith.js` (35,828 lines)

#### CRITICAL BUG FOUND AND FIXED

**`TELEGRAM_SIGNALS_ONLY` defaulted to `true` when not set in env.**

In `lib/config.js` line 76, the old code was:
```js
signalsOnly: String(process.env.TELEGRAM_SIGNALS_ONLY || '').trim().toLowerCase() !== 'false',
```
This evaluated to `true` when the env var was empty or unset (`'' !== 'false'` = `true`).

Since `CONFIG.IS_LIVE` requires `!CONFIG.TELEGRAM.signalsOnly`, this silently blocked ALL live trades. The `_executeLiveTrade()` method returned `LIVE_TRADING_NOT_ENABLED` for every trade attempt.

**Fix applied:**
```js
signalsOnly: ['true', '1', 'yes'].includes(String(process.env.TELEGRAM_SIGNALS_ONLY || '').trim().toLowerCase()),
```
Now defaults to `false` (allow trading) unless explicitly set to `true`.

#### IS_LIVE Flag Chain (Must ALL Be True)

For the bot to genuinely place live CLOB orders, ALL of these must hold:
1. `TRADE_MODE=LIVE`
2. `ENABLE_LIVE_TRADING=true` or `1`
3. `LIVE_AUTOTRADING_ENABLED=true`
4. `TELEGRAM_SIGNALS_ONLY` must NOT be `true` (fixed above)
5. `POLYMARKET_PRIVATE_KEY` must be set (wallet loads from it)
6. Wallet must successfully derive API credentials via `ensureCreds()`

If any one fails, trades are silently blocked.

#### Strategy Artifact Validation

All three strategy artifacts are legitimate walk-forward validated sets:

**15m (`debug/strategy_set_top7_drop6.json`):**
- 7 strategies, asset="ALL", UTC hours: 0,8,9,10,11,20
- Entry minutes: 3,4,6,7,8,12,14 (each is a 60-second window)
- Price bands: 60-80c, individual WRs: 91.5%-96.1%
- winRateLCBs: 81.6%-86.8%
- OOS and live sample data present

**4h (`debug/strategy_set_4h_maxprofit.json`):**
- 8 strategies, asset="ALL", UTC hours: 1,9,13,17,21
- Entry minutes: 120 or 180 (2h or 3h into the 4h cycle)
- Price bands: 55-80c, individual WRs: 80.5%-91.3%
- Train/test split documented, aggregate 84.7% WR

**5m (`debug/strategy_set_5m_maxprofit.json`):**
- 10 strategies, asset="ALL", UTC hours: 0,1,2,3,4,16,18,20,23
- Entry minutes: 0-3 (first 3 minutes of each 5m cycle)
- Price bands: 55-80c, individual WRs: 75.5%-92.0%
- Train/test split documented, aggregate 80.7% WR

**.gitignore whitelists** all three debug artifacts — confirmed they will deploy to Render.

#### Profit Simulation Results (Monte Carlo, 10,000 trials, 30 days)

**ASSUMPTIONS (read carefully):**
- Win rates use winRateLCB (lower confidence bound) — conservative
- Entry prices uniformly random within strategy bands
- 1% slippage on all entries
- Binary resolution: win = $1/share, loss = $0
- Each strategy fires ~1 opportunity/day (conservative for 15m/4h)
- 5m strategies fire ~2 opportunities/day each
- Polymarket fees NOT modeled (up to 3.15% on winning profit)
- No fill failures or partial fills modeled
- Cooldown, global stop, and balance floor enforced

| Scenario | Start | Bust Rate | Median 30d | p5 | p95 | Max |
|----------|-------|-----------|------------|-----|------|------|
| 15m only | $5 | 24.9% | $28.91 | $0.94 | $306 | $1,143 |
| 15m + 4h | $5 | 39.4% | $2.26 | $0.31 | $204 | $6,621 |
| All three | $5 | 45.1% | $2.13 | $0.27 | $286 | $59,812 |
| 15m + 4h | $7 | 33.7% | $2.70 | $0.23 | $249 | $11,696 |

**Critical interpretation:**
- At $5 bankroll with 5-share min orders (cost $3-4 per trade), the effective risk per trade is 60-75% of bankroll
- One early loss drops bankroll below tradability threshold
- Adding 4h (84.7% WR) and 5m (80.7% WR) at micro bankroll INCREASES bust risk because lower-WR trades have higher loss probability
- The simulation confirms the README's existing guidance: **15m only at $5, enable 4h at $20+, enable 5m at $50+**
- Median outcome for 15m-only from $5 is $28.91 in 30 days — positive but path-dependent

#### Lite vs Legacy Comparison — Missing Mechanics

The legacy monolith (35,828 lines) had these safeguards that lite does NOT have:

| Feature | Legacy Status | Lite Status | Risk Impact |
|---------|--------------|-------------|-------------|
| Hard stop-loss (15c/20c drop) | Implemented | **MISSING** | Medium — strategies resolve at cycle end anyway |
| Post-entry momentum check | Implemented | **MISSING** | Low for 15m (short cycles) |
| Fast emergency exit (25c drop) | Implemented | **MISSING** | Medium — catastrophic mid-cycle events |
| Velocity gate (5c/60s pre-entry) | Implemented | **MISSING** | Low — strategy match already constrains entry |
| Spread gate (>5c) | Implemented | **MISSING** | Low — CLOB midpoint used for matching |
| Blackout window (60s + 30s) | Implemented | **MISSING** | Low — entry minute matching handles this |
| Anti-flip-flop commitment | Implemented | **MISSING** | N/A — strategy-native doesn't flip |
| Circuit breaker (soft/hard DD) | Implemented | **MISSING** | Medium — only cooldown + global stop in lite |
| Redis persistence | Required for LIVE | **NOT REQUIRED** | Low — disk persistence exists |
| Oracle/ensemble models | Core system | **NOT USED** | N/A — strategy-native replaces oracle |

**Assessment:** Most legacy safeguards were designed for the oracle-driven execution model where the bot monitored prices during a position's lifetime. Lite uses strategy-native entry and holds to resolution — there is no active mid-cycle monitoring. This is acceptable for 15m (short cycle) but carries more risk for 4h (long cycle where mid-cycle exits could save capital).

**Recommendation:** For 4h positions specifically, consider adding a basic mid-cycle price monitoring + emergency exit mechanism. This is not blocking for 15m-only operation.

#### Dashboard Audit

`public/index.html` (380 lines) renders:
- Balance, day P&L, peak, drawdown
- Win rate, total trades, consecutive losses, cooldown status
- Orchestrator heartbeat (last run, active markets, candidates, trades attempted)
- Strategy sets (loaded count, file path, load timestamp)
- Live market prices (YES/NO per asset per timeframe)
- Recent trades with P&L
- Wallet breakdown (on-chain USDC, CLOB collateral, baseline bankroll)
- Open positions with full details
- Pending queues (buys, settlements, sells, redemptions)
- Diagnostics log
- Reconcile Pending button

**Dashboard assessment:** Functional and comprehensive for lite runtime. Correctly shows `isLive` flag, strategy set file paths, and all pending queue states. No misrepresentation found between API data and dashboard display.

#### Trade Execution Path Verification

The bot will genuinely trade when:
1. Orchestrator ticks every 2 seconds (`TICK_INTERVAL_MS = 2000`)
2. `discoverAllMarkets()` queries Gamma API for active markets across enabled timeframes
3. For each asset+timeframe, `evaluateMatch()` checks if current UTC hour + entry minute + price band matches any loaded strategy
4. Matching candidates sorted by `winRateLCB` (best first)
5. `executeTrade()` refreshes live balance, checks risk gates, calculates size, computes shares
6. If shares >= 5 and all gates pass, `_executeLiveTrade()` calls `_placeCLOBOrder()`
7. `_placeCLOBOrder()` creates order via `@polymarket/clob-client`, verifies fill with 3 retries
8. On fill: position tracked, balance updated, Telegram notified
9. On cycle expiry: position marked `PENDING_RESOLUTION`
10. `reconcilePendingLivePositions()` checks Gamma API for market closure and resolves

**Will the bot trade on the next matching cycle?** YES, provided:
- All IS_LIVE flags are correctly set (the TELEGRAM_SIGNALS_ONLY bug is now fixed)
- Wallet has USDC balance >= min order cost (~$3-4)
- A strategy match occurs (specific UTC hour + minute + price in band)
- The proxy is working (required for Render Oregon → Polymarket CLOB)

#### Render Env Variables

**NOTE**: User mentioned attaching a Render env screenshot but it was not visible in the conversation. The IS_LIVE flag chain requires these env vars to be set correctly:

```
TRADE_MODE=LIVE
ENABLE_LIVE_TRADING=1 (or true)
LIVE_AUTOTRADING_ENABLED=true
TELEGRAM_SIGNALS_ONLY=false (or unset — now safe after bug fix)
POLYMARKET_PRIVATE_KEY=<set>
PROXY_URL=<set>
CLOB_FORCE_PROXY=1
```

**ACTION REQUIRED**: After deploying the `TELEGRAM_SIGNALS_ONLY` bug fix, verify via `GET /api/health` that `isLive: true` appears in the response.

### Maximum Profit Strategy Research Plan (25 March 2026)

#### Why Current Strategies Alone Can't Reach $xxx→$xxxx+ from $5

The fundamental problem is not strategy quality — it's **min-order-dominated sizing at micro bankroll**:

- Current strategies enter at 60-80c → 5 shares × 75c = **$3.75 per trade = 75% of $5 bankroll**
- One loss = bankroll drops to $1.25 → below tradability threshold
- Even at 88% WR, P(first loss in first 3 trades) ≈ 33%
- Result: 25% bust rate, median $28.91 in 30 days

The solution is to **flip the risk/reward asymmetry** by trading at extreme prices.

#### The Death Bounce / Floor Bounce Opportunity

**What it is:** In Polymarket 15m crypto markets, price occasionally flips from one extreme to the other (e.g., YES goes from 85c→15c, or from 10c→80c). This happens when the underlying crypto asset reverses sharply mid-cycle.

**Why it's transformative:**

| Entry Price | Cost (5 shares) | % of $5 Bankroll | Win Payout | ROI | Required WR for BE |
|:-----------:|:---------------:|:----------------:|:----------:|:---:|:------------------:|
| 10c | $0.50 | 10% | $5.00 | 900% | 10% |
| 15c | $0.75 | 15% | $5.00 | 567% | 15% |
| 20c | $1.00 | 20% | $5.00 | 400% | 20% |
| 75c (current) | $3.75 | 75% | $5.00 | 33% | 75% |

At 10c entry, you can survive **8+ consecutive losses** before bust. At 75c entry, you survive **0-1 losses**.

**What causes death bounces:**
1. Crypto price reversal mid-cycle (BTC was going UP, suddenly drops → YES crashes)
2. Late-cycle momentum shifts from external price action
3. Resolution sniping by informed traders who know the oracle snapshot timing
4. Mean reversion from extreme overextension

#### Profit Simulation Results — Death Bounce Strategies

Monte Carlo, 10,000 trials, 30 days, from $5 start:

**A) Death Bounce ONLY (entry 5-20c, 4 trades/day):**

| WR | Bust Rate | Median 30d | p75 | p95 |
|----|-----------|------------|-----|-----|
| 20% | 46.5% | $15.97 | $44.12 | $69.19 |
| 25% | 29.6% | $51.71 | $73.21 | $101.26 |
| 30% | 19.3% | **$81.74** | $103.05 | $132.20 |
| 35% | 12.5% | **$113.93** | $135.71 | $166.85 |
| 40% | 7.5% | **$147.41** | $169.43 | $202.26 |

**B) Death Bounce (25% WR, 5-20c) + Standard 15m (85% WR, 70-80c):**

| DB Freq | Bust Rate | Median 30d | p75 | p95 | Max |
|---------|-----------|------------|-----|-----|-----|
| 2/day | 36.7% | $68 | $269 | **$1,202** | $23,047 |
| 4/day | 33.6% | **$106** | **$355** | **$1,557** | $27,068 |
| 6/day | 31.8% | **$125** | **$350** | **$1,258** | $14,043 |

**C) Higher Entry Bounces (15-30c) + Standard 15m:**

| WR | Bust Rate | Median 30d | p75 | p95 | Max |
|----|-----------|------------|-----|-----|-----|
| 35% | 43.6% | $70 | **$329** | **$1,569** | $23,662 |
| 40% | 31.1% | **$210** | **$634** | **$2,535** | $57,537 |
| 45% | 22.5% | **$362** | **$964** | **$3,669** | $55,339 |

**D) Combined from $7 start (DB 25% + Std 85%):**
- Bust: 18.0% | Median: **$231** | p75: **$671** | p95: **$3,077** | Max: **$154,922**

**E) Resolution Sniping (95% WR at 40-60c) + Standard 15m:**

| Freq | Bust Rate | Median 30d | p75 | p95 | Max |
|------|-----------|------------|-----|-----|-----|
| 2/day | 3.0% | **$524** | **$1,183** | **$4,045** | $84,403 |
| 4/day | 1.0% | **$1,018** | **$2,240** | **$7,612** | $188,492 |
| 6/day | 0.8% | **$1,522** | **$3,448** | **$11,314** | $157,995 |

#### Ranked Strategy Approaches (by expected profit potential)

**TIER 1 — Highest potential, must investigate first:**

**1. Resolution Sniping (Latency Arbitrage)**
- Previously documented at 98-99% WR in IMPLEMENTATION_PLAN
- Entry at 40-60c near resolution when outcome is highly predictable
- Sim shows median **$1,018 in 30 days** at 4/day frequency (1.0% bust)
- **To validate**: Need to understand Chainlink oracle snapshot timing and whether the outcome is predictable 5-30 seconds before resolution
- **To implement**: Monitor underlying crypto price near cycle end, compare to opening snapshot, trade if direction is clear
- **Risk**: May require sub-second execution speed; liquidity may dry up near resolution

**2. Death Bounce / Floor Bounce Strategy**
- Buy at 5-25c when market is at extreme AND crypto is reversing
- Sim shows median **$106-$362 in 30 days** depending on WR achieved
- **To validate**: Collect intracycle minute-by-minute price data for thousands of 15m cycles, identify how often bounces occur and what predicts them
- **To implement**: Real-time monitor for extreme prices + crypto reversal detection
- **Risk**: WR is unknown until validated with data; liquidity at extremes may be thin

**TIER 2 — Solid secondary approaches:**

**3. Cross-Asset Momentum Cascade**
- BTC and ETH ~74% correlated
- Watch BTC resolution, immediately trade correlated assets
- Could add 2-4 high-probability trades per day
- **To validate**: Analyze cross-asset correlation in intracycle data
- **To implement**: When BTC market resolves UP, immediately buy ETH UP if price is favorable

**4. Intracycle Momentum (First N Minutes → Outcome)**
- If the first 3-5 minutes of a cycle show strong directional movement, the outcome is biased
- The existing strategy sets partially capture this (specific minute entries)
- **To validate**: Analyze minute-by-minute price evolution vs outcome
- **To implement**: Extend strategy matcher to consider momentum signals

**TIER 3 — Enhancement/optimization:**

**5. Optimized Walk-Forward Strategies (Current Approach, Improved)**
- Run fresh strategy scan on latest data
- Look specifically for LOW-entry-price strategies (10-40c) which have better risk profile at micro bankroll
- Consider asset-specific strategies instead of "ALL"
- **To validate**: Run `exhaustive_market_analysis.js` with modified price band search

**6. 4h and 5m Integration (After Bankroll Growth)**
- Keep as planned: 4h at $20+, 5m at $50+
- Not suitable at micro bankroll

#### Investigation and Implementation Plan

**Phase 1: Data Collection (1-2 hours)**
1. Run `exhaustive_market_analysis.js` to collect fresh 15m intracycle data (30+ days, all 4 assets)
2. The existing pipeline already fetches minute-by-minute CLOB prices via `/prices-history`
3. Ensure `fidelity=1` (1-minute resolution) is used for maximum granularity
4. Output: `exhaustive_analysis/intracycle_data.json` with full price paths

**Phase 2: Death Bounce Analysis (1-2 hours)**
1. Write analysis script to scan intracycle data for "death bounces":
   - Identify cycles where price swung ≥30c from peak to trough
   - Identify cycles where price was <20c at any point and then won (resolved at $1)
   - Calculate: how often bounces happen, at what minute, from what price level
   - Correlate with underlying crypto price movement
2. Walk-forward validate bounce detection rules
3. Output: death bounce frequency, achievable WR, optimal entry conditions

**Phase 3: Resolution Sniping Analysis (1-2 hours)**
1. Analyze the last 1-2 minutes of each cycle:
   - What was the price at minute 13-14?
   - What was the actual outcome?
   - How predictable is the outcome from minute 13 prices?
2. Investigate Chainlink oracle snapshot timing
3. Output: resolution sniping WR, optimal entry timing

**Phase 4: Strategy Implementation (2-4 hours)**
1. Implement the highest-validated approach as a new strategy type in the runtime
2. Add to orchestrator loop alongside existing walk-forward strategies
3. Test locally in PAPER mode
4. Deploy and verify

**Phase 5: Live Validation (ongoing)**
1. Monitor first 24-48 hours of combined operation
2. Track actual WR, frequency, and P&L
3. Adjust sizing and frequency based on real results

#### Render Env Verification (From Screenshot)

All IS_LIVE flags are correctly set:
- `TRADE_MODE=LIVE` ✅
- `ENABLE_LIVE_TRADING=1` ✅
- `LIVE_AUTOTRADING_ENABLED=true` ✅
- `TELEGRAM_SIGNALS_ONLY=false` ✅ (explicitly set)
- `POLYMARKET_PRIVATE_KEY` set ✅
- `POLYMARKET_SIGNATURE_TYPE=1` ✅
- `PROXY_URL` set (Japan proxy) ✅
- `CLOB_FORCE_PROXY=1` ✅
- `MULTIFRAME_4H_ENABLED=true` ✅
- `STRATEGY_SET_15M_PATH=debug/strategy_set_top7_drop6.json` ✅
- `STRATEGY_SET_4H_PATH=debug/strategy_set_4h_maxprofit.json` ✅
- `STRATEGY_SET_5M_PATH=debug/strategy_set_5m_maxprofit.json` ✅

**Note**: `ENABLE_4H_TRADING=false` conflicts with `MULTIFRAME_4H_ENABLED=true`, but the code uses `??` (nullish coalescing) so `MULTIFRAME_4H_ENABLED=true` takes precedence. 4h IS enabled.

**Note**: `MAX_POSITION_SIZE=0.32` — this is fine for current operation. The death bounce approach would use min-order sizing at extreme prices, so this cap doesn't constrain it.

### Live Audit Reverification + Refreshed Death Bounce Findings (24 March 2026, UTC)

This addendum supersedes the earlier assumption-based death-bounce projections in this README.

#### Verified Live Runtime Findings

- Live `walletLoaded=true` behavior still comes from `POLYMARKET_PRIVATE_KEY` auto-loading correctly. The unresolved balance issue occurs later in confirmed balance fetch/merge, not during initial private-key load.

- The live `50/50` odds display was a runtime pricing bug, not a real Polymarket market condition. A local fix is prepared in `lib/market-discovery.js` to use the CLOB best-buy price endpoint and sorted bid/ask fallback instead of unsorted first levels.

- The dashboard trading-balance display could show baseline bankroll while the live balance source was `UNKNOWN`. A local fix is prepared in `public/index.html` so the dashboard stops implying confirmed live funds when balance provenance is unknown.

- Lite still appears to prefer fallback bundled `4h` strategy artifacts on the deployed host. That remains a deploy-time artifact-resolution issue to re-check after the next Render redeploy.

#### Refreshed Intracycle Dataset

- Incremental refresh extended cached analysis coverage from `2026-03-15T06:45:00.000Z` to `2026-03-24T10:15:00.000Z`.

- `manifest_combined.json` now contains `59,900` markets.

- The refreshed 30-day death-bounce pass loaded `11,495` recent manifest markets, `7,899` valid intracycle markets, and `31` distinct trading days.

#### Refreshed Death Bounce Findings

- All refreshed hold-to-resolution bounce variants remained negative expectancy over the latest 30-day window.

- Best raw scalp rule by refreshed expected daily profit was:

  - `entryBand=5-20c`
  - `window=m3-m12`
  - `target=35c`
  - `stopFactor=80%`
  - `winRate=17.8504%`
  - `winRateLCB=16.9639%`
  - `avgEntry=14.7022c`
  - `avgWinPnlPerShare=18.4223c`
  - `avgLossAbsPerShare=2.8894c`

- Raw observed frequency for that rule was `222.10 trades/day`, which is not executable for a `$5` bankroll and must not be treated as a real live-server operating point.

#### Best Current Server / Setup Recommendation

- Keep live trading focused on the validated `15m` path until the price fix, balance-display fix, and live artifact-resolution re-check are deployed and verified.

- Keep `4h` and `5m` disabled for live bankroll deployment until the strategy-path mismatch is resolved and the bankroll threshold justifies additional frequency.

- Do **not** enable death-bounce auto-trading live yet.

- If death-bounce logic is shadow-tested only, the least-bad conservative setup found in refreshed Monte Carlo was:

  - `MAX_TRADES_PER_DAY=3`
  - `GLOBAL_STOP_LOSS_PCT=0.10`
  - `MAX_CONSECUTIVE_LOSSES=3`
  - `COOLDOWN_DAYS=1`
  - candidate rule `scalp 5-20c m3-m12 target=35c stop=80%`

- Even under that throttled `winRateLCB` setup from a `$5` start, 30-day Monte Carlo still showed:

  - `bustRate=7.14%`
  - `medianFinal=$6.79`
  - `p5=$1.97`
  - probability of the first `3` trades all losing remains about `57.25%` under the same lower-bound win rate

- Optimistic `mean`-win-rate sensitivity still did not make this safe enough for the user's stated constraint; the best capped setup remained around `5.6%` bust over 30 days.

- Conclusion: refreshed death-bounce analysis is research-valid, but it is **not** deployment-valid for the user's current "$5 and the first few trades cannot lose" requirement.

#### Next Proof Gate

- Deploy the local price-fix and balance-display-fix changes to Render.

- Re-verify `/api/health`, `/api/status`, and `/api/wallet/balance` after redeploy.

- Confirm live strategy artifact resolution on the deployed host.

- Keep death-bounce in analysis or shadow mode only until a materially safer empirical profile is proven.

#### Live Blocker Root-Cause Update (25 March 2026, UTC)

- `debug/strategy_set_top7_drop6.json`, `debug/strategy_set_4h_maxprofit.json`, and `debug/strategy_set_5m_maxprofit.json` are currently tracked by git. `git ls-files` returned all three paths, and `git check-ignore` returned no matching ignore rule. That means the present repo state does **not** support the earlier theory that `.gitignore` is the active blocker.

- The zero/blank live market state had a stronger local root-cause match in `lib/market-discovery.js`: when `PROXY_URL` existed, `fetchJSON()` forced all non-CLOB requests through the proxy. Because Gamma market discovery uses non-CLOB URLs, a bad or mismatched proxy could turn otherwise-valid slug lookups into `NOT_FOUND` markets even while the rest of the runtime stayed up.

- This matters for live because the operator docs and README deployment examples explicitly describe geoblocked operation with `PROXY_URL` and `CLOB_FORCE_PROXY=1`. Under the old code, that combination also routed Gamma through the proxy by default, even though only CLOB actually needed forced proxy behavior.

- The local fix now makes Gamma slug discovery direct-first with proxy fallback, while keeping CLOB proxy usage explicit behind `CLOB_FORCE_PROXY`. That hardens market discovery against proxy-only Gamma failures without removing the geoblock workaround for CLOB.

- The local `4h` blocker was also reduced materially: `strategies/strategy_set_4h_top8.json` was stale (`6` strategies, adapted artifact) while `debug/strategy_set_4h_maxprofit.json` is the validated walk-forward set (`8` strategies). The bundled fallback file has now been replaced with the validated `8`-strategy artifact, and a local JSON equality check returned `same: true`.

- A related `15m` mismatch was also confirmed locally: live had previously reported falling back to `/app/strategies/strategy_set_15m_top8.json`, and that bundled file is not the validated `debug/strategy_set_top7_drop6.json` primary set. `server.js` has now been patched so `15m` checks `debug/strategy_set_top7_drop6.json` and `debug/strategy_set_top8_current.json` before bundled `strategies/` fallbacks.

- Fresh live re-audit on `25 March 2026` showed the public Render host is still pre-patch: `/api/health` reported `uptime` ~`58987s`, `15m` loaded `/app/debug/strategy_set_top7_drop6.json`, but `4h` still loaded stale `/app/strategies/strategy_set_4h_top8.json` with `6` strategies and `loadedAt` still `2026-03-24T13:36:27.708Z`. `/api/status` still showed all `8` markets as `NOT_FOUND`, and `/api/wallet/balance` still reported trading balance `0` with source `UNKNOWN`.
- Honest boundary: the local fixes are verified in code, but the public deployment still does **not** reflect them. Live proof now requires the patched Render build to actually land, then be re-audited.

### Harness Adaptation Addendum — ECC to Windsurf (25 March 2026)

This session investigated `affaan-m/everything-claude-code` specifically to determine whether it could be installed directly into this Windsurf workspace.

#### Methodology

- Read the upstream `README.md`.
- Read the upstream `rules/README.md`.
- Read the upstream `install.ps1` entrypoint.
- Read the upstream `manifests/install-profiles.json`.
- Read representative upstream rule files from `rules/common/` and `rules/typescript/`.
- Compared those findings against this repo's current authority chain: `README.md`, `.agent/skills/DEITY/SKILL.md`, and `.windsurf/workflows/*.md`.

#### Verified Findings

- ECC is a portable harness system with rules, skills, agents, commands, hooks, and install tooling.
- In the install docs inspected during this session, ECC explicitly documented install targets for Claude Code, Cursor, and Antigravity.
- A native Windsurf install target was **not** verified from the upstream install flow that was inspected.
- Because of that, the honest implementation for this repo is a **local Windsurf adaptation**, not a claimed one-command upstream ECC install.

#### Local Adaptation Applied

- Added root `AGENTS.md` as a cross-harness entrypoint.
- Added `.agent/skills/ECC_BASELINE/SKILL.md` as an additive baseline skill.
- Added `.windsurf/workflows/ecc-research-first.md` as a Windsurf-native workflow.

#### Design Choice

- `DEITY` remains the authoritative repo-specific protocol.
- The ECC-derived layer is intentionally **additive** and imports only the parts that fit this repo cleanly:
  - research-first development
  - evidence-backed verification
  - security checks before risky changes
  - parallel exploration when independent
  - small, reversible implementation steps
- The adaptation intentionally does **not** replace the repo's manifesto, DEITY rules, or existing POLYPROPHET-specific workflows.

---

## Current Session State

> **Update this section at the end of every AI session.**

**Last Agent**: Claude Opus (Cascade) operating as DEITY agent
**Date**: 25 March 2026 (UTC)
**What was done**: (1) Investigated `affaan-m/everything-claude-code` directly from upstream docs/files rather than relying on summaries. (2) Verified that ECC provides portable rules, skills, agents, commands, and install tooling, but did **not** verify a native Windsurf install target from the inspected install flow. (3) Designed and applied a local workspace adaptation instead of pretending upstream had one-click Windsurf support. (4) Added root `AGENTS.md` as a cross-harness entrypoint. (5) Added `.agent/skills/ECC_BASELINE/SKILL.md` as an additive ECC-derived baseline skill. (6) Added `.windsurf/workflows/ecc-research-first.md` as a Windsurf-native research-first workflow adapted for POLYPROPHET. (7) Preserved `README.md` + `DEITY` as the authoritative harness and kept the ECC-derived layer additive only.
**What is pending**: (1) If desired later, selectively import more ECC-derived workflows or conventions after file-by-file compatibility review. (2) If the user wants a deeper cross-tool setup, evaluate whether project-level `.claude/` or `.cursor/` artifacts should also be added deliberately. (3) The previously identified live runtime/deploy blocker work remains pending and unaffected by this harness adaptation session.
**Discrepancies found**: Upstream ECC markets itself as cross-platform and supports several agent harnesses, but from the install/docs files inspected in this session I did **not** verify a native Windsurf target. The honest repo implementation is therefore a local adaptation, not a claimed direct upstream install.
**Key insight**: The correct way to apply ECC here is to import its useful research/security/validation principles into files Windsurf and this workspace actually use, while keeping the repo-specific DEITY manifesto authoritative.
**Methodology**: Compared upstream ECC `README.md`, `rules/README.md`, `install.ps1`, `manifests/install-profiles.json`, and representative common/typescript rule files against this repo's existing `README.md`, `.agent/skills/DEITY/SKILL.md`, and `.windsurf/workflows/` files before creating the local adaptation layer.
**Next action**: Use the new local ECC adaptation files as the workspace baseline for future Windsurf sessions, and only expand the adaptation further if a specific additional ECC component is wanted and verified compatible.
