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

---

## Current Session State

> **Update this section at the end of every AI session.**

**Last Agent**: Claude Opus (Cascade) operating as DEITY agent
**Date**: 25 March 2026
**What was done**: Full atomic-level runtime hardening audit. Read every line of server.js + all lib/*.js + all 3 strategy artifacts + dashboard + legacy monolith comparison. Found and fixed CRITICAL bug: TELEGRAM_SIGNALS_ONLY defaulted to true, silently blocking all live trades. Ran Monte Carlo profit sim (10k trials). Documented all findings in README addendum.
**What is pending**: (1) Deploy the TELEGRAM_SIGNALS_ONLY fix to Render. (2) Verify `isLive: true` in live `/api/health`. (3) Verify Render env vars match IS_LIVE chain requirements. (4) Run funded end-to-end live smoke test. (5) Consider adding 4h mid-cycle emergency exit for when 4h is enabled.
**Discrepancies found**: TELEGRAM_SIGNALS_ONLY bug (FIXED in code, needs deploy). Live strategy artifact mismatch still pending verification. User mentioned Render env screenshot but it was not visible — need user to re-share or confirm env vars.
**Methodology**: Read every character of runtime code, validated strategy artifacts against their claimed evidence, ran realistic Monte Carlo sim with min-order/cooldown/global-stop constraints, compared lite vs 35,828-line legacy monolith for missing safeguards, audited dashboard HTML against API contract.
**Assumptions**: Profit sim uses winRateLCB (conservative). Does not model Polymarket fees (~3.15%). Does not model fill failures. Assumes sufficient liquidity.
**Next action**: Deploy fix → verify isLive → confirm Render env → funded smoke test.
