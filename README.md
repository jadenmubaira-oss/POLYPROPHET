# POLYPROPHET — Autonomous Polymarket Trading Bot

> **THE IMMORTAL MANIFESTO** — Source of truth for all AI agents and operators.
> Read fully before ANY changes. Continue building upon this document.

**Last Updated**: 31 March 2026 | **Runtime**: `polyprophet-lite` (promoted to repo root) | **Deploy**: Render (Oregon) + proxy-backed CLOB routing

---

## Quick Start For New Agents

<!-- AGENT_QUICK_START -->
> **Read this first.** 10-line summary of current project state.

| Field | Value |
|-------|-------|
| **Objective** | Autonomous Polymarket crypto trading bot, $5 -> max profit via compounding |
| **Runtime** | `polyprophet-lite` (root `server.js`), deployed on Render (Oregon) |
| **Live URL** | `https://polyprophet-1-rr1g.onrender.com` |
| **Current Blocker** | NONE. Bot is LIVE and trading. First trade placed 30 Mar 23:40 UTC (BTC DOWN at 56c, lost). Auth, signing, order placement all confirmed working. |
| **Active Strategy (15m)** | `debug/strategy_set_15m_oos_validated_v1.json` (6 OOS-validated strategies, 45-95c, m11-m14) |
| **Active Strategy (4h)** | `debug/strategy_set_4h_maxprofit.json` (8 strategies, bankroll-gated at $4) |
| **Wallet Balance** | $0.349 USDC (BUSTED), `sigType=1`, proxy funder `0xe7E89BA00F43A38F457d30c2F72f68fE75E2850A` — needs $5-10 deposit to resume |
| **Next Action** | DEPOSIT $5-10, then remove bootstrap strategies (40-51% OOS WR = below break-even). Keep m14 resolution (90% OOS WR) + m12 momentum (82% OOS WR). 15% stake deployed. |
| **Harness** | `.agent/` (Antigravity) + `.windsurf/` + `.claude/` + `.cursor/` + `.codex/` + `.factory/droids/` |
| **Authority Chain** | README.md -> AGENTS.md -> `.agent/skills/DEITY/SKILL.md` -> `.agent/skills/ECC_BASELINE/SKILL.md` |
<!-- /AGENT_QUICK_START -->

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
  - `4h` is deployed and strategy-loaded on the live host, but remains **bankroll-gated inactive** until the truthful runtime bankroll reaches **$10**.
  - `5m` is signal-valid and runtime-gated at **$50 bankroll** when enabled, but the current live env still keeps it disabled.
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

- **`debug/strategy_set_top7_drop6_per_asset_lcb60_min12.json`** as the authoritative 15m strategy set on the current live deploy (**20 strategies loaded live**)
- **Strategy-native 15m entry generation** (not oracle-driven)
- **Adaptive sizing** via `MICRO_SPRINT` profile at micro bankrolls
- **Disk-backed runtime persistence** via `data/runtime-state.json`
- **Optional proxy-backed CLOB routing** plus direct multi-RPC wallet reads for live balance truthfulness
- **Auto-sell / resolution / redemption lifecycle** handling

### Live Deployment

| Field | Value |
|-------|-------|
| **URL** | `https://polyprophet-1-rr1g.onrender.com` |
| **Runtime** | `polyprophet-lite` (root-promoted) |
| **Version** | `polyprophet-lite-1.0.0` |
| **Last Deploy Commit** | `461c3b5` (`Port legacy wallet truth surfaces and bankroll-gated runtime defaults`) |
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

From live `GET /api/health` (26 March 2026, post-deploy of `461c3b5`):

- `mode`: LIVE
- `isLive`: true
- Active assets: BTC, ETH, SOL, XRP
- Active timeframes: `15m` only
- `runtimeBankrollForTimeframes`: `0` (so live bankroll gating is currently suppressing `4h`)
- `configuredTimeframes`:
  - `15m`: `enabled=true`, `active=true`, `minBankroll=0`
  - `4h`: `enabled=true`, `active=false`, `minBankroll=10`
  - `5m`: `enabled=false`, `active=false`, `minBankroll=50`
- `15m` strategy set: loaded from `/app/debug/strategy_set_top7_drop6_per_asset_lcb60_min12.json` with `20` strategies
- `4h` strategy set: loaded from `/app/debug/strategy_set_4h_maxprofit.json` with `8` strategies
- Orchestrator: running and discovering markets (`activeMarkets=1`, `totalMarkets=4` at verification time)

### Wallet Endpoint Verification Status

- The deploy-level runtime changes are confirmed live through `GET /api/health`.
- Remote verification of `GET /api/wallet/balance` timed out twice during this 26 March 2026 pass, so wallet endpoint **responsiveness** remains an explicit re-check item.
- Because of that timeout, do **not** claim a fresh 26 March wallet truthfulness verification beyond what is visible in `/api/health`.

---

## Strategy Readiness

### Honest Readiness Table (26 March 2026 live posture)

| Timeframe | Strategy Set | Default State | Evidence | Verdict |
|-----------|-------------|---------------|----------|---------|
| **15m** | `debug/strategy_set_top7_drop6_per_asset_lcb60_min12.json` | ENABLED + ACTIVE | Live `/api/health` shows `20` strategies loaded from `/app/debug/...` | **READY — Primary active path** |
| **4h** | `debug/strategy_set_4h_maxprofit.json` | ENABLED + BANKROLL-GATED | Live `/api/health` shows `loaded=true`, `active=false`, `minBankroll=10` | **READY — waits for funded balance** |
| **5m** | `debug/strategy_set_5m_maxprofit.json` | DISABLED IN LIVE ENV | Runtime gate remains `minBankroll=50` when enabled; micro-bankroll survivability still fragile | **SIGNAL-VALID but not live-active** |
| **1h** | None | N/A | Polymarket does not offer 1h markets | **NOT SUPPORTED** |

### 15m Strategy Details (`top7_drop6_per_asset_lcb60_min12`)

- **Source**: `debug/strategy_set_top7_drop6_per_asset_lcb60_min12.json`
- **Deploy proof**: live `/api/health` shows `/app/debug/strategy_set_top7_drop6_per_asset_lcb60_min12.json` with `20` strategies loaded
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
- **Live runtime posture**: currently loaded on the deployed host but inactive until truthful trading bankroll reaches `>= $10`

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
STRATEGY_SET_15M_PATH=debug/strategy_set_top7_drop6_per_asset_lcb60_min12.json
STRATEGY_SET_4H_PATH=debug/strategy_set_4h_maxprofit.json
STRATEGY_SET_5M_PATH=debug/strategy_set_5m_maxprofit.json
OPERATOR_STAKE_FRACTION=0.45
MAX_POSITION_SIZE=0.45
DEFAULT_MIN_ORDER_SHARES=5
AUTO_BANKROLL_MODE=SPRINT

# Timeframes
TIMEFRAME_15M_ENABLED=true
TIMEFRAME_5M_ENABLED=true
MULTIFRAME_4H_ENABLED=true
ENABLE_4H_TRADING=true
TIMEFRAME_4H_MIN_BANKROLL=10
TIMEFRAME_5M_MIN_BANKROLL=50

# Assets
ASSETS=BTC,ETH,SOL,XRP

# Wallet
POLYMARKET_PRIVATE_KEY=<set>
POLYMARKET_SIGNATURE_TYPE=1

# Proxy (required if geoblocked)
PROXY_URL=<set>
CLOB_FORCE_PROXY=0

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

1. **Re-check `/api/wallet/balance` responsiveness** — the endpoint timed out during this remote verification pass and should be rechecked directly on the deployed host
2. **Run one funded live smoke test** — one buy fills, one sell/resolve, one redeem, balance reconciles
3. **Enable authentication** — set `NO_AUTH=false` + credentials
4. **Inspect dashboard parity** — confirm dashboard reflects the same enabled timeframes, strategy paths, balance, and runtime status seen in the APIs
5. **Optional**: top up bankroll toward `$10` so the deployed `4h` path can activate truthfully under the current bankroll gate

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
  "balance": 5,
  "balanceBreakdown": { "source": "UNKNOWN", "tradingBalanceUsdc": 0 },
  "timeframes": ["15m"],
  "runtimeBankrollForTimeframes": 0,
  "configuredTimeframes": [
    { "key": "5m", "enabled": false, "active": false, "minBankroll": 50 },
    { "key": "15m", "enabled": true, "active": true, "minBankroll": 0 },
    { "key": "4h", "enabled": true, "active": false, "minBankroll": 10 }
  ],
  "strategySets": {
    "15m": { "loaded": true, "filePath": "/app/debug/strategy_set_top7_drop6_per_asset_lcb60_min12.json", "strategies": 20 },
    "4h": { "loaded": true, "filePath": "/app/debug/strategy_set_4h_maxprofit.json", "strategies": 8 }
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

Timeframes are controlled by environment flags **and** runtime bankroll thresholds:
- `TIMEFRAME_15M_ENABLED` (default: true)
- `TIMEFRAME_5M_ENABLED` (blueprint default: true, live env may override)
- `MULTIFRAME_4H_ENABLED` / `ENABLE_4H_TRADING` (blueprint default: true)
- `TIMEFRAME_4H_MIN_BANKROLL` (default: `10`)
- `TIMEFRAME_5M_MIN_BANKROLL` (default: `50`)

Only **active** timeframes participate in market discovery and strategy evaluation. A timeframe can be `enabled=true` but still `active=false` when the truthful runtime bankroll is below its gate.

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

Live service previously loaded fallback bundled strategies instead of validated `debug/` artifacts.
- **Root cause**: Render env/file resolution mismatch
- **Status**: Resolved on 26 March 2026 live deploy (`15m` and `4h` now load from `/app/debug/...`)

### Deployment Authority Mismatch (2026-03-23)

`render.yaml` and `DEPLOY_RENDER.md` pointed at different entrypoints.
- **Fix**: Unified both to root runtime (AO30.31), then promoted lite to root (AO30.36)

---

## Version History

### Current: polyprophet-lite (root-promoted)

| Date | Change | Reference |
|------|--------|-----------|
| 2026-03-31 | **OOS VALIDATION**: 992 cycles, 3333 matches. Overall 74.4% WR (vs 79% in-sample). m14 resolution 83-92% VALIDATED, m10 bootstrap 40-51% FAILED. Honest profit sims: median $201-$5,111 from $5 depending on strategy mix. Extreme sensitivity: 5% WR drop = 1000x less profit. | Session 31 Mar |
| 2026-03-31 | **BUSTED**: 3 consecutive losses at 45% stake, balance $5->$0.35. Risk fix deployed: stake 45%->15%. m10 bootstrap identified as root cause (40% OOS WR vs 65% claimed). | Commits b584d4f, dd85fef |
| 2026-03-31 | **FIRST LIVE TRADE**: BTC DOWN at 56c, $2.80 stake via m10 bootstrap strategy. Auth chain fully working (sigType=1, proxy funder). Trade lost. | Session 30-31 Mar |
| 2026-03-30 | Fixed POLY_ADDRESS header override (root cause of "order signer must match API key"). Reduced minOrderShares 5->1 for micro-bankroll. Deployed lateminute_v1 strategy set. | Commits d1a5263, 369fbec |
| 2026-03-30 | Full harness install (50 files): Factory droids, cross-IDE layers, 4 ECC skills, 3 workflows. Verification script passing 35 checks. | Commit 4232195 |
| 2026-03-26 | Manual Render deploy verified promoted 15m artifact, debug 4h artifact loading, and bankroll-gated timeframe activation on live host | README addendum |
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

### Full Redeploy + Exact-Runtime Re-Backtest + Strategy Audit (25 March 2026, 09:00 UTC)

#### Scope

Complete redeploy, live re-audit, exact-runtime profit simulation of every strategy combination at $5/$7/$10/$20 starts, and comprehensive strategy recommendation.

#### Methodology

1. **Full code read**: `README.md`, `IMPLEMENTATION_PLAN_v140.md` (latest addenda), `server.js`, `lib/config.js`, `lib/risk-manager.js`, `lib/trade-executor.js`, `lib/strategy-matcher.js`, `lib/market-discovery.js`
2. **Git push + Render redeploy**: Committed `893d5a9` with proxy fix, 15m/4h fallback hardening, stale 4h artifact replacement. Pushed to `origin/main`. Render picked up the deploy.
3. **Live re-audit**: Queried `/api/health` and `/api/status` after fresh deploy landed.
4. **Exact-runtime profit simulation**: Built `scripts/profit-sim-exact-runtime.js` that replicates the EXACT mechanics of `risk-manager.js` and `trade-executor.js`:
   - Adaptive sizing (`stakeFraction=0.30` at ≤$10, `0.20` above)
   - Kelly half-sizing (`kellyFraction=0.25`, `kellyMaxFraction=0.45`)
   - Peak drawdown brake (20% DD from peak when bankroll >$20)
   - Min-order bump path (5 shares × entry price)
   - Polymarket fees (3.15% on winning profit)
   - 1% slippage on all entries
   - 1 trade/cycle at micro bankroll (<$10), 2/cycle above
   - Cooldown (1200s after 3 consecutive losses)
   - Global stop loss (20% of day-start balance)
   - Balance floor ($2.00)
5. **Data source**: Real decision datasets — 15m: 963 matched trades over 150 days; 4h: 438 matched trades over 105 days; 5m: 1,353 matched trades over 16 days
6. **Monte Carlo**: 3,000 trials per scenario, 30-day simulation, random day-sampling from empirical trade calendars

⚠️ **DATA SOURCE**: Local exact-runtime simulation using real decision datasets
⚠️ **LIVE RUNTIME STATUS**: Deploy landed at `2026-03-25T09:16:48Z`, `isLive=true`, markets discovered (`NO_LIQUIDITY` — Gamma working, CLOB prices pending proxy resolution)
⚠️ **LIVE METRIC AVAILABILITY**: Rolling accuracy unavailable on lite runtime
⚠️ **DISCREPANCIES**: CLOB price fetch still returning `NO_LIQUIDITY` for all 8 markets — likely CLOB proxy path issue remaining

#### Raw Trade Quality (from real datasets)

| Strategy Set | Trades | Win Rate | WR LCB | Days | Trades/Day | Avg Entry |
|:-------------|-------:|---------:|-------:|-----:|-----------:|----------:|
| 15m top7_drop6 | 963 | 86.9% | 84.6% | 150 | 6.42 | 75.6c |
| 4h maxprofit | 438 | 84.7% | 81.0% | 105 | 4.17 | 70.3c |
| 5m maxprofit | 1,353 | 76.5% | 74.2% | 16 | 84.56 | 66.8c |

#### Exact-Runtime Profit Simulation Results (30 days, 3,000 trials)

**From $5 start:**

| Scenario | Bust Rate | Median | p5 | p75 | p95 | Avg WR | Max DD |
|:---------|----------:|-------:|----:|-----:|------:|-------:|-------:|
| **15m only** | **19.1%** | **$31.58** | $1.11 | $126.42 | $272.52 | 71.2% | 78.3% |
| 15m + 4h | 18.8% | $6.30 | $1.04 | $70.80 | $439.48 | 71.7% | 75.7% |
| 4h only | 21.8% | $6.22 | $1.01 | $6.96 | $92.47 | 69.7% | 76.5% |
| 15m+4h+5m | 20.0% | $5.29 | $0.96 | $6.56 | $15,018 | 54.0% | 73.6% |
| 5m only | 27.4% | $2.17 | $0.47 | $6.23 | $63,949 | 41.6% | 73.6% |

**From $7 start:**

| Scenario | Bust Rate | Median | p5 | p75 | p95 | Avg WR | Max DD |
|:---------|----------:|-------:|----:|-----:|------:|-------:|-------:|
| **15m only** | **7.0%** | **$92.71** | $1.38 | $158.14 | $307.88 | 77.4% | 72.7% |
| **15m + 4h** | **10.5%** | **$81.94** | $0.55 | $207.95 | $611.17 | 73.6% | 77.4% |
| 4h only | 12.2% | $21.46 | $0.46 | $58.74 | $150.50 | 70.8% | 78.9% |
| 15m+4h+5m | 23.8% | $5.43 | $0.41 | $6.87 | $95,762 | 53.3% | 85.4% |

**From $10 start:**

| Scenario | Bust Rate | Median | p5 | p75 | p95 | Avg WR | Max DD |
|:---------|----------:|-------:|----:|-----:|------:|-------:|-------:|
| **15m + 4h** | **3.8%** | **$130.91** | $2.30 | $288.30 | $771.97 | 79.2% | 71.2% |
| **15m only** | **2.6%** | **$123.63** | $2.59 | $193.60 | $365.93 | 83.5% | 65.1% |
| 4h only | 6.9% | $42.79 | $1.47 | $76.41 | $184.22 | 75.2% | 72.8% |

**From $20 start:**

| Scenario | Bust Rate | Median | p5 | p75 | p95 | Avg WR | Max DD |
|:---------|----------:|-------:|-----:|-------:|--------:|-------:|-------:|
| **15m + 4h** | **0.4%** | **$336.06** | $59.64 | $632.13 | $1,516 | 85.4% | 56.9% |
| **15m only** | **0.3%** | **$171.96** | $58.70 | $268.29 | $495.90 | 87.4% | 49.6% |
| 4h only | 0.8% | $91.22 | $21.20 | $145.33 | $273.19 | 82.4% | 57.4% |

#### Strategy Ranking Verdict

**Rank 1 — 15m only (recommended at $5-$7):**
- Best median profit at micro bankroll ($31.58 from $5, $92.71 from $7)
- Lowest bust rate at every starting balance tested
- Highest realized win rate (71-87% depending on bankroll tier)
- Proven over 150 days of empirical data (963 matched trades)

**Rank 2 — 15m + 4h (recommended at $10+):**
- Highest median profit from $10 ($130.91) and $20 ($336.06)
- Higher p95 upside than 15m-only at every level
- Slightly higher bust rate at micro bankrolls due to 4h's lower WR (84.7% vs 86.9%)
- Optimal crossover point: **$10 bankroll** is where 15m+4h median overtakes 15m-only

**Rank 3 — 4h only:**
- Reasonable standalone option at $20+ ($91.22 median, 0.8% bust)
- Not recommended at $5-$7 due to lower WR and fewer daily opportunities

**DO NOT USE at micro bankrolls — 5m strategies:**
- 5m trades are toxic at all micro bankrolls ($5-$20)
- 76.5% WR is too low for min-order-dominated sizing
- Median falls below starting balance in every $5-$10 scenario
- Extreme variance: p95 can reach millions but median is near-bust
- Only 16 days of empirical data (unreliable sample)
- **Enable 5m only at $50+ bankroll** as documented in the existing guidance

#### Why Median Is More Important Than p95

The p95 values for 5m-including scenarios look spectacular ($63K-$95K from $5) but this is misleading:
- Median $2.17-$5.43 means **more than half of all trials end below start**
- The extreme p95 comes from rare lucky compounding sequences
- At micro bankroll, one early loss drops you below tradability
- The user's constraint ("first few trades CANNOT lose") makes median and bust rate the binding metrics, not p95

#### Live Server Status After Redeploy

| Field | Value | Assessment |
|-------|-------|------------|
| Deploy commit | `893d5a9` | ✅ Landed |
| Uptime | 152s at check | ✅ Fresh restart |
| `isLive` | `true` | ✅ All IS_LIVE flags pass |
| 15m strategies | 7 from `/app/debug/strategy_set_top7_drop6.json` | ✅ Correct artifact |
| 4h strategies | 8 from `/app/strategies/strategy_set_4h_top8.json` | ✅ Aligned fallback (was 6, now 8) |
| Timeframes | 15m + 4h enabled | ✅ Matches config |
| Market discovery | All 8 markets: `NO_LIQUIDITY` | ⚠️ Gamma working, CLOB prices not populating |
| Balance source | `UNKNOWN` / `UNINITIALIZED` | ⚠️ Wallet hasn't fetched live balance yet |
| Active markets | 0 | ⚠️ No prices = no strategy matching = no trades |

#### Will It Trade on the Next Cycle?

**NOT YET.** The bot will not trade until CLOB price data populates. Currently all markets show `NO_LIQUIDITY` even though Gamma slug discovery is now working (the proxy fix resolved the old `NOT_FOUND` issue).

**Remaining blocker**: CLOB book/price API calls through the proxy are returning empty data. The `fetchCLOBBook()` function correctly passes `useProxy: true` when `CLOB_FORCE_PROXY=1`, but the proxy may be failing silently for CLOB-specific endpoints.

**To fix**: Either the proxy URL needs to be verified for CLOB API access, or the CLOB client itself (`lib/clob-client.js`) needs proxy wiring since it uses `axios` internally rather than `fetchJSON`.

#### Alternative Approaches Considered

| Approach | Verdict | Why |
|----------|---------|-----|
| **Death bounce (5-25c entries)** | ❌ Not deployment-valid | All hold-to-resolution bounce variants were negative EV in refreshed 30-day data |
| **Resolution sniping (last 30s)** | ❌ Not validated | 57.1% WR at 45-55c, insufficient for micro bankroll |
| **Cross-asset momentum** | ❌ Not implemented | Would need real-time cross-asset correlation engine |
| **Lower entry price strategies (10-40c)** | ⚠️ Worth investigating | Better risk profile at micro bankroll, but current datasets don't include enough low-price entries |
| **Increased stake fraction** | ❌ Zero effect | At $5-$7, min-order bump already binds sizing above any fraction setting |
| **More assets** | ❌ Already at max | BTC/ETH/SOL/XRP covers all available Polymarket crypto up/down |

#### Recommendations

1. **Keep 15m-only as the live primary strategy** until bankroll reaches $10
2. **Enable 4h at $10+ bankroll** by setting `MULTIFRAME_4H_ENABLED=true` (already set in Render env — the system is ready)
3. **Do NOT enable 5m at micro bankrolls** — keep disabled until $50+
4. **Fix the CLOB proxy issue** — this is the only remaining hard blocker preventing actual trades
5. **Consider topping up to $7-$10** — bust rate drops from 19.1% to 7.0% at $7 and 2.6% at $10
6. **No new strategies needed** — the current walk-forward validated sets are the strongest available approach for this market structure
7. **Death bounce and resolution sniping are research artifacts only** — do not deploy them

#### Honest $5→$xxxx Projection (30-day, 15m only)

| Outcome | Probability | Final Balance |
|---------|------------|---------------|
| Bust (<$2) | 19.1% | Lost |
| Survive but flat | 5-10% | $2-$10 |
| Moderate growth | ~30% | $10-$100 |
| Strong growth | ~25% | $100-$270 |
| Exceptional | ~5% | $270+ |
| **Median** | **50th percentile** | **$31.58** |

At $7 start, the picture improves dramatically: 7% bust, $92.71 median, $307.88 at p95.

---

### Full Server Audit + Strategy Overhaul + Operational Fix (27 March 2026)

#### Executive Summary

**The bot has never traded because of THREE compounding failures:**

1. **Strategy price bands are wrong for current market conditions** (0% in-band rate in 48h)
2. **Orchestrator hangs on wallet balance fetch** (blocks all discovery and matching)
3. **CLOB discovery doesn't respect proxy config** (markets misclassified as NO_LIQUIDITY)

All three are now fixed in commits `80ffd04` through `3dde15a`. A **new strategy based on real recent market data** replaces the old one.

#### Investigation Methodology

1. Full read of README.md (1363 lines), IMPLEMENTATION_PLAN_v140.md, all strategy artifacts, all lib/*.js files
2. Direct Gamma API queries for 12 specific market slugs across strategy-hour cycles
3. Direct CLOB price-history queries for exact token IDs at exact strategy entry minutes
4. Exhaustive 1344-cycle CLOB price-history analysis (7 days, 4 assets, all 24 UTC hours, fidelity=1)
5. 478 qualifying strategy candidates scanned across minutes 8-13, all price bands, both directions
6. 10,000-trial Monte Carlo profit simulations with exact runtime risk-manager logic
7. Live endpoint verification (`/api/health`, `/api/status`, `/api/wallet/balance`, `/api/markets`)

#### CRITICAL FINDING: Why the Old Strategies Never Traded

**The old strategy set (`top7_drop6_per_asset_lcb60_min12`) has a 0% in-band match rate over the last 48 hours.**

The strategies require prices of 60-80c at minutes 3-14 of the 15m cycle. But real CLOB data shows:

| Time in Cycle | Actual YES Price | Actual NO Price | Strategy Expects |
|:-------------:|:----------------:|:---------------:|:----------------:|
| Minute 3 | ~48-52c | ~48-52c | 72-80c (DOWN) |
| Minute 7 | ~45-55c | ~45-55c | 75-80c (UP) |
| Minute 8 | ~50-72c | ~28-50c | 75-80c (UP) |
| Minute 10 | ~60-95c | ~5-40c | N/A (no strategy) |
| Minute 12 | ~70-99c | ~1-30c | N/A (no strategy) |

**Root cause**: The old strategies were backtested on historical data (Oct 2025 - Jan 2026) where market prices were in the 60-80c range at early minutes. Current market microstructure has prices near 50c in early minutes, only diverging to extremes in minutes 8-14. The backtests and profit sims were truthful for their training period but **do not reflect current live market behavior**.

This is why the profit sims said "4.4 trades per day" but reality produced zero: the sims used historical entry prices from the training dataset, not live CLOB prices.

#### New Strategy: Late-Minute Momentum (`strategy_set_15m_lateminute_v1.json`)

**Source**: `debug/strategy_set_15m_lateminute_v1.json` — 12 strategies, minutes 10-12, all UTC hours

**Data basis**: 1344 resolved 15m cycles from live CLOB price-history API (7 days, BTC/ETH/SOL/XRP)

**Why it works**: By minutes 10-12 of a 15m cycle, the underlying crypto price direction is already established. CLOB prices reflect this — the winning side trades at 70-95c while the losing side trades at 5-30c. Trading with the established direction at these minutes captures the momentum with 80-87% win rates.

| Tier | Minutes | Price Band | WR | LCB | Avg Entry | Unlocks At |
|------|---------|-----------|-----|-----|-----------|------------|
| BOOTSTRAP | m10-11 | 40-65c | 66-68% | 57-59% | ~55c | $0 (always) |
| GROWTH | m10-11 | 50-80c | 71-84% | 66-80% | ~66-79c | $6 |
| ACCELERATE | m10 | 60-95c | 82-84% | 79-81% | ~76-81c | $8 |
| HIGH_CONFIDENCE | m12 | 65-95c | 85-87% | 81-83% | ~83c | $10 |

**Key design**: Uses `utcHour: -1` (wildcard) so strategies fire **every 15-minute cycle, every hour**. This maximizes trade frequency — up to 4-8 trades per day across all 4 assets.

#### Profit Simulation Results (Corrected, 10,000 trials, 30 days)

Using exact `risk-manager.js` logic: adaptive sizing, Kelly, min-order bump path, fees, slippage, cooldown.

| Strategy | Start | Bust | Median | p75 | p95 | Max |
|----------|-------|------|--------|-----|-----|-----|
| OLD (broken, 0 trades) | $5 | 0% | $5.00 | $5.00 | $5.00 | $5 |
| NEW tiered m10-12 | $5 | 21.1% | $2.07 | $32.80 | $87.52 | $255 |
| NEW tiered m10-12 | $7 | 19.3% | $2.61 | $56.24 | $102.20 | $280 |
| NEW m10 UP low-entry | $5 | 22.9% | $2.22 | $29.30 | $64.16 | $129 |

**Honest interpretation**: At $5 bankroll with Polymarket's 5-share minimum order ($2.75-$4.00 per trade), bust risk is inherent regardless of strategy. No strategy at $5 has a median above starting balance because one early loss at 55-77% of bankroll is devastating. However, the NEW tiered approach gives the best survivable upside: **p75=$33, p95=$88** vs the old approach producing literally zero trades.

#### Code Fixes Applied

| Fix | Commit | Impact |
|-----|--------|--------|
| **Orchestrator balance timeout** | `80ffd04`, `9b546aa` | `refreshLiveBalance()` now has 15s hard timeout. Previously hung indefinitely, blocking ALL discovery and matching. |
| **Non-overlapping tick loop** | `80ffd04` | Replaced `setInterval` with self-scheduling `setTimeout`. Prevents OOM from stacking async orchestration runs. |
| **CLOB discovery proxy fix** | `80ffd04` | Discovery now respects `CLOB_FORCE_PROXY` and retries proxy when direct responses are unusable. |
| **Wildcard UTC hour support** | `9b546aa` | Strategy matcher now supports `utcHour: -1` (all hours). Required for late-minute strategies that fire every cycle. |
| **New strategy as primary** | `3dde15a` | Late-minute strategy loads before env var override. |

#### Remaining Blockers Before Autonomous Operation

| Blocker | Status | Required Action |
|---------|--------|----------------|
| **Manual Render deploy needed** | PENDING | Trigger deploy of `3dde15a` from Render dashboard |
| **Wallet balance fetch** | UNKNOWN | `/api/wallet/balance` still times out — may need proxy fix for CLOB client balance calls |
| **Funded smoke test** | NOT DONE | Need one successful buy+resolve+redeem cycle before trusting autonomous operation |

#### Alternative Approaches Evaluated

| Approach | Verdict | Evidence |
|----------|---------|----------|
| **Old walk-forward strategies (m3-m14, 60-80c)** | BROKEN | 0/40 in-band matches in 48h of live data |
| **Death bounce (5-25c entries)** | NEGATIVE EV | All hold-to-resolution variants negative in refreshed 30-day data. Best scalp rule: 17.8% WR, -0.36c EV/share |
| **Resolution sniping (m13-14, 80-99c)** | MARGINAL | 84-87% WR but very high entry cost ($4.25+ per trade), unaffordable at $5 bankroll |
| **Late-minute momentum (m10-12)** | BEST AVAILABLE | 66-87% WR across tiers, affordable at micro bankroll via bootstrap tier, proven on 1344 recent cycles |
| **Cross-asset momentum** | NOT VALIDATED | Would need real-time implementation; no backtest data available |
| **4h strategies** | VALID BUT GATED | 84.7% WR, but bankroll-gated at $10 minimum. Keep as growth accelerator. |
| **5m strategies** | TOO RISKY | 76.5% WR insufficient at micro bankroll. Enable at $50+. |

#### Honest $5 to $xxx+ Projection

The fundamental constraint is Polymarket's 5-share minimum order:
- At $5 bankroll with 55c entry: each trade costs $2.75 = **55% of bankroll**
- At $5 bankroll with 76c entry: each trade costs $3.83 = **77% of bankroll**
- One loss at any entry price is catastrophic at $5

**No strategy can eliminate this structural risk at $5.** The best we can do is:
1. Use the highest-WR affordable strategies (late-minute momentum)
2. Tier the approach so higher-WR strategies unlock as bankroll grows
3. Accept 20% bust risk as the price of admission

**If you want to materially reduce bust risk**: top up to $10-$15 before enabling live trading. At $10, bust rate drops to ~5% and median outcome improves to $50-$130 in 30 days.

#### Server Operational Checklist (After Manual Deploy)

After triggering manual deploy of commit `3dde15a` on Render:

1. Verify `GET /api/health` shows `strategies: 12` and `filePath` contains `lateminute_v1`
2. Verify `orchestrator.lastRun` is populated (balance timeout no longer blocks)
3. Verify `orchestrator.activeMarkets >= 1` (CLOB discovery working)
4. Wait for a minute 10, 11, or 12 of any 15m cycle and check `candidatesFound > 0`
5. If candidates appear but `liveBalance: 0`, the wallet/CLOB readiness path needs further debugging

### Live Runtime + Strategy Audit Addendum (28 March 2026, UTC)

This addendum supersedes older README claims that the live host was still waiting on its first strategy-match proof or that the current live 15m path was `top7_drop6_per_asset_lcb60_min12.json` with `20` strategies.

#### Data Source Statement

- **DATA SOURCE**: Live API (`/api/health`, `/api/status`, `/api/diagnostics`, `/api/clob-status`, `/api/derive-debug`), current code analysis, official Polymarket docs, corrected local exact-runtime simulation (`scripts/profit-sim-exact-runtime.js`)
- **LIVE RUNTIME STATUS**: Live host is up, strategy files load, markets are discovered and priced, wallet/balance surfaces are populated, but autonomous order placement is still blocked by CLOB signing/auth mismatch
- **LIVE METRIC AVAILABILITY**: Lite runtime still does **not** expose a rolling live accuracy field; do not invent one
- **DISCREPANCIES**: Earlier README sections describing the live 15m artifact, deploy method, and “ready” posture are stale relative to current 28 March live truth

#### Verified 28 March Live Runtime Truth

From live `GET /api/health` / `GET /api/status` / `GET /api/debug/strategy-paths`:

- Deploy version: `2026-03-28T09:55Z-lateminute-v1-final`
- Runtime URL: `https://polyprophet-1-rr1g.onrender.com`
- Balance: `4.999209` USDC trading balance (currently surfaced from last-known-good / CLOB collateral fallback chain)
- Active timeframes: `15m` and `4h` are both active at current bankroll because `TIMEFRAME_4H_MIN_BANKROLL` now resolves to `4`
- Current live 15m file: `/app/debug/strategy_set_top7_drop6.json`
- Current live 15m strategy count: `14`
- Current live 4h file: `/app/debug/strategy_set_4h_maxprofit.json`
- Current live 4h strategy count: `8`
- Live debug endpoint proves `strategy_set_15m_lateminute_v1.json` and `strategy_set_15m_v2_resolution_momentum.json` do **not** exist on Render, so the host is loading the repurposed `strategy_set_top7_drop6.json` fallback

#### Critical Live Discovery: The Bot Already Tried To Trade

Live `GET /api/diagnostics` now proves the root problem is **not** “no signals.”

At `11:40-11:45 UTC`, the live runtime generated multiple 15m candidates and attempted real BUY orders across BTC / ETH / SOL / XRP for minute-10 / minute-11 / minute-12 / minute-14 strategies, including:

- `m10 DOWN late-momentum [45-95c]`
- `m10 DOWN bootstrap [35-60c]`
- `m10 UP bootstrap [35-60c]`
- `m11 DOWN wide-momentum [45-95c]`
- `m11 UP wide-momentum [55-95c]`
- `m12 UP late-momentum [55-95c]`
- `m12 DOWN late-momentum [55-95c]`
- `m14 DOWN resolution [80-95c]`
- `m14 UP resolution [65-95c]`

Every live order failed with the same execution-layer error:

- `CLOB_ORDER_FAILED: No orderID in response: {"error":"invalid signature","status":400}`

So the truthful current blocker is:

- **Discovery works**
- **Strategy matching works**
- **Candidate generation works**
- **Live order posting is still broken**

#### Root Cause: Proxy-Wallet (`signatureType=1`) Signing / Funder Mismatch

Official Polymarket docs state that `signatureType=1` (`POLY_PROXY`) requires the **Polymarket profile/proxy wallet address** as the `funder` address, not merely the exported signer EOA.

Current repo/live evidence:

- Live env is using `POLYMARKET_SIGNATURE_TYPE=1`
- `.env.example` includes `POLYMARKET_ADDRESS`, but it is blank by default
- Current runtime previously fell back to `wallet.address` when `POLYMARKET_ADDRESS` was missing
- Official Polymarket docs say proxy-wallet users must use the wallet shown on polymarket.com/settings / profile dropdown as the funder address
- Upstream `@polymarket/clob-client` issue `#248` documents a related `sigType=1` bug where authenticated order-post headers can use the signer EOA instead of the required funder/profile address

That combination explains the live behavior:

- `/api/clob-status` can still report `tradeReady.ok=true` because balance/allowance probes succeed under the selected client posture
- But the actual signed order payload or authenticated order-post request still fails at submission time with `invalid signature`

#### Local Code Hardening Applied

`lib/clob-client.js` has now been hardened locally so that:

- `POLYMARKET_SIGNATURE_TYPE=1` now requires an explicit valid `POLYMARKET_ADDRESS`
- Authenticated CLOB requests in proxy-wallet mode override `POLY_ADDRESS` to the configured funder/profile address instead of trusting the upstream default

This does **not** by itself fix the live host until the service is redeployed with the real `POLYMARKET_ADDRESS` value set.

#### Corrected Exact-Runtime Simulation Findings (`exact-runtime-v2`)

The local simulation engine was corrected to match the current runtime more closely:

- wildcard `utcHour=-1` strategies now match correctly
- micro-bankroll min-order bump logic now matches the current `risk-manager.js`
- buy cost now uses raw entry price like the current runtime path instead of an extra slippage-charged cost basis

##### Key comparative results

At **$5 start**:

- Current live 15m hybrid (`strategy_set_top7_drop6.json`): `bustRate=25.1%`, `median=$5.44`
- Current live 15m hybrid + 4h: `bustRate=22.27%`, `median=$5.65`
- Older hour-filtered 15m set only: `bustRate=19.9%`, `median=$5.41`
- Older hour-filtered 15m + 4h: `bustRate=16.43%`, `median=$5.94`
- 4h only: `bustRate=21.1%`, `median=$6.26`

At **$10 start**:

- Current live 15m hybrid + 4h: `bustRate=15.53%`, `median=$6.82`
- Older hour-filtered 15m + 4h: `bustRate=10.9%`, `median=$11.43`
- 4h only: `bustRate=6.37%`, `median=$48.31`

At **$20 start**:

- Current live 15m hybrid + 4h: `bustRate=5.57%`, `median=$20.56`
- Older hour-filtered 15m + 4h: `bustRate=3.23%`, `median=$25.89`
- 4h only: `bustRate=0.6%`, `median=$102.34`

#### Strategy Verdict From Corrected Sim

- The currently deployed 14-strategy 15m hybrid is **not** the best low-bust median path in the corrected local simulation
- The older hour-filtered 15m artifact outperforms the current live 15m hybrid on survivability and median in the tested `$5-$20` range when paired with `4h`
- `5m` outputs remain dominated by extreme outliers and fragile bankroll dynamics; they are **not** honest unattended-autonomy candidates at current bankroll
- None of the corrected `$5` scenarios satisfy the user's “first few trades cannot lose” constraint honestly

#### Current Go / No-Go Status

**NO-GO for unattended live autonomy right now.**

Reasons:

1. Live execution is still failing with `invalid signature`
2. The required proxy-wallet `POLYMARKET_ADDRESS` / funder posture is not yet verified live
3. The currently deployed 15m hybrid is not the best corrected-sim choice for low-bust median growth
4. The `$5` bankroll remains structurally dominated by Polymarket's 5-share minimum order size

#### Required Fixes Before Honest GO

1. Set `POLYMARKET_ADDRESS` in Render to the **actual Polymarket profile / proxy wallet address** for the funded account
2. Redeploy the service with the `clob-client.js` hardening now in repo
3. Re-check `GET /api/clob-status` and `GET /api/diagnostics` during an active minute window (`10-14`)
4. Confirm at least one live order returns a real `orderID` instead of `invalid signature`
5. Re-evaluate whether the live 15m primary should remain the 14-strategy hybrid or revert to the older hour-filtered 15m artifact for better corrected-sim survivability
6. Do not claim readiness until one full funded smoke path is proven: buy -> fill/partial-fill handling -> resolve/sell -> redemption/balance reconciliation

#### Current Session State

> **Update this section at the end of every AI session.**

**Last Agent**: Claude Opus (Cascade) operating as DEITY agent
**Date**: 28 March 2026 (UTC)
**What was done**: (1) Reconciled the current live host against repo truth and proved the live 15m artifact is `/app/debug/strategy_set_top7_drop6.json` with `14` strategies, not the older `20`-strategy hour-filtered file. (2) Verified live host is discovering/pricing markets and that both `15m` and `4h` are currently active. (3) Proved via `/api/diagnostics` that the bot already generated many real 15m trade attempts at minutes `10-14`. (4) Identified the actual live blocker as CLOB order submission failing with `400 invalid signature`, not lack of candidate generation. (5) Cross-checked official Polymarket docs and upstream client behavior, isolating `signatureType=1` + missing/incorrect `POLYMARKET_ADDRESS` as the key execution-auth defect. (6) Hardened `lib/clob-client.js` locally to require explicit `POLYMARKET_ADDRESS` in proxy-wallet mode and override authenticated `POLY_ADDRESS` headers to the configured funder. (7) Corrected `scripts/profit-sim-exact-runtime.js` so wildcard hours and current micro-bankroll order sizing match the current runtime more closely, then reran comparative sims for current 15m vs older hour-filtered 15m.
**What is pending**: (1) Set the real Polymarket profile/proxy wallet address in Render as `POLYMARKET_ADDRESS`. (2) Redeploy the current repo state. (3) Re-verify live `clob-status` / `diagnostics` during an active minute window and confirm at least one real `orderID`. (4) Decide whether to keep the 14-strategy live hybrid or restore the older hour-filtered 15m set based on corrected-sim priorities. (5) Perform one end-to-end funded smoke path before declaring unattended autonomy readiness.
**Discrepancies found**: Earlier README sections claiming live `15m` was `top7_drop6_per_asset_lcb60_min12.json` with `20` strategies are stale. Earlier README text claiming manual deploy only is stale relative to current `render.yaml` (`autoDeploy: true`). `/api/health` and `/api/status` can look healthy while hiding earlier failed order attempts unless `/api/diagnostics` is checked.
**Key insight**: The core bot is now far enough along that it *does* generate real live entries, but proxy-wallet signing semantics remain the hard blocker between “signal engine works” and “autonomous trading works.”
**Methodology**: Full read of current runtime code paths, live endpoint verification, current artifact inspection, corrected exact-runtime simulation, official Polymarket auth documentation review, upstream client issue comparison.
**Next action**: Set `POLYMARKET_ADDRESS`, redeploy, verify a real order submission succeeds, then finalize the 15m artifact choice using the corrected-sim evidence.

### Addendum — 29 March 2026 Live Reverification + Straight-Handover Audit

⚠️ **DATA SOURCE**: Live API (`/api/health?ts=1774789000`, `/api/status`, `/api/debug/strategy-paths`, `/api/clob-status`, `/api/diagnostics`, `/api/wallet/balance`) plus local code verification (`node --check server.js`, `node --check lib/clob-client.js`) plus local `scripts/profit-sim-exact-runtime.js` (`exact-runtime-v2`) replays.

⚠️ **LIVE RUNTIME STATUS**: The currently reachable host is `https://polyprophet-1-rr1g.onrender.com`, deploy version `2026-03-28T09:55Z-lateminute-v1-final`, mode `LIVE`, wallet loaded, proxy configured, and using `sigType=1`.

⚠️ **LIVE METRIC AVAILABILITY**: Rolling live accuracy is still unavailable for decision use because the current deploy has `0` completed trades since restart.

⚠️ **DISCREPANCIES**: Bare `/api/health` returned a stale startup snapshot through the cached fetch path; cache-busted `/api/health?ts=...` matched `/api/status` and `/api/wallet/balance`. Treat the cache-busted health result as authoritative for this addendum.

#### Verified 29 March 2026 Live Runtime Truth

- Runtime URL: `https://polyprophet-1-rr1g.onrender.com`
- Deploy version: `2026-03-28T09:55Z-lateminute-v1-final`
- Mode: `LIVE`
- Wallet loaded: `true`
- Active wallet address exposed by the runtime: `0x1fcb9065142AFDFa4eE1cFFC107B6a7fd1d49612`
- Balance: `4.999209` USDC
- Balance source: `LAST_KNOWN_GOOD` / CLOB collateral fallback chain
- Active timeframes: `15m` and `4h`
- Disabled timeframe: `5m`
- Current live 15m artifact: `/app/debug/strategy_set_top7_drop6.json`
- Current live 15m strategy count: `14`
- Current live 4h artifact: `/app/debug/strategy_set_4h_maxprofit.json`
- Current live 4h strategy count: `8`
- Current live 5m posture: disabled, bankroll floor `50`
- Orchestrator state during verification: running, `activeMarkets=8`, `candidatesFound=0`, `tradesAttempted=0`

#### CLOB / Auth Truth On The Current Host

From live `/api/clob-status`:

- `clientAvailable=true`
- `walletLoaded=true`
- `hasCreds=true`
- `sigType=1`
- `proxyConfigured=true`
- `clobForceProxy=true`
- `tradeReady.ok=true`
- Selected trade candidate uses `signatureType=1`
- Selected `funderAddress=0x1fcb9065142AFDFa4eE1cFFC107B6a7fd1d49612`
- Selected collateral balance raw: `4999209`
- Selected allowance is already maxed for spender `0xC5d563A36AE78145C45a50134d48A1215220f80a`

This means the current live deploy is past the old “wallet not loaded / proxy missing / allowance missing” class of failures. What is **not** yet proven on this restart is an actual accepted order submission returning a real `orderID`.

#### Repo Truth vs Live Host Truth

The checked-in blueprint and the live host are **not** identical.

`render.yaml` currently says:

- `region: oregon`
- `autoDeploy: true`
- default `TRADE_MODE=PAPER`
- default `ENABLE_LIVE_TRADING=false`
- default `LIVE_AUTOTRADING_ENABLED=false`
- `TIMEFRAME_4H_MIN_BANKROLL=10`
- `STRATEGY_SET_15M_PATH=debug/strategy_set_top7_drop6_per_asset_lcb60_min12.json`

The live host currently proves env overrides are in effect:

- mode is actually `LIVE`
- `4h` is active at bankroll `4.999209`, so the effective live `TIMEFRAME_4H_MIN_BANKROLL` is `4`
- the active live 15m artifact is `strategy_set_top7_drop6.json`, not the checked-in default `top7_drop6_per_asset_lcb60_min12.json`

Handoff consequence: **`render.yaml` is the deploy path, but it is not the authoritative description of the current live posture. The live env dashboard overrides matter.**

#### Local Verification Completed In This Session

- `node --check server.js` -> passed
- `node --check lib/clob-client.js` -> passed
- Current branch: `main`
- Deploy path from this workspace: push a curated commit to `main`, then Render auto-deploys
- Important operational caveat: the local working tree is dirty with many unrelated modified/untracked files, so a blind deploy from the current workspace would be unsafe

#### What The Bot Can Honestly Be Expected To Do Right Now

The bot is currently capable of polling and evaluating live markets, but it is **not honest** to claim “it will definitely trade on the next cycle.”

What is true:

- The 15m live artifact uses wildcard `utcHour=-1` schedules, so it can evaluate every hour
- The live 15m entry minutes are `10`, `11`, `12`, and `14`
- The live 4h artifact has windows at UTC hours `1`, `9`, `13`, `17`, and `21` with entry minutes `120` or `180`
- Therefore the bot has many upcoming eligible windows

What is **not** guaranteed:

- A trade only happens if live prices also land inside the strategy price bands at the scheduled minute
- During this verification window the orchestrator found `0` candidates and attempted `0` trades
- `/api/diagnostics` was empty because the current restart was fresh and had not yet accumulated logs for an active match window

So the truthful statement is:

- **The bot can trade on upcoming valid windows**
- **The bot is not yet proven to trade on the very next cycle**

#### Exact-Runtime-v2 Comparative Replay Findings

These are **local replay / Monte Carlo** results from `scripts/profit-sim-exact-runtime.js`. They are not live fills.

##### `$5` start

| Scenario | Bust Rate | Median | p5 | p95 |
|----------|-----------|--------|----|-----|
| Current live `15m only` | `25.1%` | `$5.44` | `$0.32` | `$6.72` |
| Current live `15m + 4h` | `22.27%` | `$5.65` | `$0.32` | `$6.89` |
| `4h only` | `21.1%` | `$6.26` | `$1.05` | `$108.86` |
| `top7_drop6_per_asset_lcb60_min12 only` | `19.9%` | `$5.41` | `$0.63` | `$6.77` |
| `top7_drop6_per_asset_lcb60_min12 + 4h` | `16.43%` | `$5.94` | `$0.83` | `$14.24` |
| `top8_current only` | `20.3%` | `$6.67` | `$1.15` | `$328.57` |
| `top8_current + 4h` | `19.03%` | `$6.33` | `$1.05` | `$467.34` |

##### `$10` start

| Scenario | Bust Rate | Median | p5 | p95 |
|----------|-----------|--------|----|-----|
| Current live `15m only` | `24.2%` | `$5.75` | `$0.28` | `$18.17` |
| Current live `15m + 4h` | `15.53%` | `$6.82` | `$0.42` | `$37.29` |
| `4h only` | `6.37%` | `$48.31` | `$1.55` | `$207.11` |
| `top7_drop6_per_asset_lcb60_min12 only` | `17.37%` | `$6.17` | `$0.28` | `$29.76` |
| `top7_drop6_per_asset_lcb60_min12 + 4h` | `10.9%` | `$11.43` | `$0.54` | `$49.84` |
| `top8_current only` | `2.5%` | `$139.27` | `$2.53` | `$460.26` |
| `top8_current + 4h` | `4.33%` | `$167.08` | `$2.25` | `$950.39` |

##### `$20` start

| Scenario | Bust Rate | Median | p5 | p95 |
|----------|-----------|--------|----|-----|
| Current live `15m only` | `13.6%` | `$8.41` | `$0.53` | `$30.49` |
| Current live `15m + 4h` | `5.57%` | `$20.56` | `$1.78` | `$56.96` |
| `4h only` | `0.6%` | `$102.34` | `$23.12` | `$330.42` |
| `top7_drop6_per_asset_lcb60_min12 only` | `6.73%` | `$15.82` | `$1.18` | `$48.57` |
| `top7_drop6_per_asset_lcb60_min12 + 4h` | `3.23%` | `$25.89` | `$5.05` | `$72.88` |
| `top8_current only` | `0.47%` | `$197.87` | `$57.77` | `$610.14` |
| `top8_current + 4h` | `0.57%` | `$411.85` | `$75.27` | `$2107.90` |

#### How To Interpret Those Replays Honestly

- The currently deployed `top7_drop6` live artifact is **not** the strongest local replay winner in this session
- If prioritizing **conservative improvement over the current live setup in the `$5-$20` band**, `top7_drop6_per_asset_lcb60_min12 + 4h` beats the current live `top7_drop6 + 4h` on both bust rate and median
- If prioritizing **maximum median upside in the current local replay**, `top8_current` and especially `top8_current + 4h` dominate the tested field
- However, `top8_current` is **not** the currently deployed live artifact, and this session did **not** re-prove it on the present live execution path
- None of the `$5` scenarios honestly satisfy the user's “first few trades cannot lose” constraint

#### 5m Verdict From The Same Exact-Runtime-v2 Run

| Start | Scenario | Bust Rate | Median | p5 | p95 |
|-------|----------|-----------|--------|----|-----|
| `$5` | `5m only` | `29.47%` | `$2.20` | `$0.76` | `$195,362.99` |
| `$5` | `15m + 5m` | `31.97%` | `$5.35` | `$0.18` | `$6.90` |
| `$5` | `15m + 4h + 5m` | `24.3%` | `$5.76` | `$0.27` | `$21.92` |
| `$10` | `5m only` | `31.23%` | `$2.71` | `$0.37` | `$4,226,870.34` |
| `$10` | `15m + 5m` | `23.57%` | `$6.00` | `$0.27` | `$38.19` |
| `$10` | `15m + 4h + 5m` | `15.0%` | `$10.67` | `$0.48` | `$57.36` |
| `$20` | `5m only` | `18.4%` | `$3,810.69` | `$0.71` | `$85,227,387.31` |
| `$20` | `15m + 5m` | `10.0%` | `$16.94` | `$0.80` | `$207.22` |
| `$20` | `15m + 4h + 5m` | `4.73%` | `$28.28` | `$4.20` | `$177.89` |

Interpretation:

- The 5m outputs remain dominated by extreme outliers and fragile path dependence
- The gigantic `p95` values are exactly why 5m is **not** an honest unattended-micro-bankroll recommendation
- The present live choice to keep `5m` disabled remains correct

#### Current GO / NO-GO Verdict For Straight Handover

**Current verdict: NO-GO for claiming fully proven unattended live autonomy right this second.**

Reasons:

1. The current live deploy is healthy enough to poll, price, and present balances, but it still has `0` completed trades on this restart
2. `tradeReady.ok=true` is encouraging, but it is **not** the same thing as a verified live order submission returning `orderID`
3. The checked-in blueprint and the live env posture are divergent, so a handoff that ignores env overrides would be misleading
4. The currently deployed 15m artifact is not obviously the best choice by the current local replay evidence
5. The `$5` bankroll remains structurally constrained by the 5-share minimum order reality

#### Honest Best-Current Strategy Verdict

- **Do not enable 5m** for unattended micro-bankroll live trading
- **Current live stack**: `top7_drop6` + `4h_maxprofit`
- **Most conservative improvement over current live replay**: `top7_drop6_per_asset_lcb60_min12 + 4h`
- **Highest median upside in this session's local replay**: `top8_current + 4h`
- **But** no artifact change should be called production-best until it is re-proven against the actual current live execution path and not just replay data

#### Required Pre-GO Checklist From Here

1. Curate the dirty local workspace into a clean deployable commit set
2. Push that curated commit to `main` so Render auto-deploy picks it up
3. Verify the live `deployVersion` changes after deploy
4. Watch a real eligible window (`15m` minute `10/11/12/14` or a valid `4h` window)
5. Confirm one live order returns a real `orderID`
6. Confirm the rest of the funded smoke path works: fill or partial fill handling -> settlement -> balance reconciliation
7. Only after that should the project be described as fully handoff-ready for unattended live autonomy

#### Current Session State

> **Update this section at the end of every AI session.**

**Last Agent**: Cascade operating as DEITY agent
**Date**: 29 March 2026 (UTC)
**What was done**: (1) Re-read the governing README and implementation-plan materials needed for a truthful handoff. (2) Verified the current workspace deploy path: repo is on `main`, `render.yaml` uses `autoDeploy: true`, but the local tree is dirty and must be curated before any safe deploy. (3) Verified live host truth via `/api/health?ts=...`, `/api/status`, `/api/debug/strategy-paths`, `/api/clob-status`, `/api/diagnostics`, and `/api/wallet/balance`. (4) Proved the current host is `LIVE`, has `4.999209` balance, has both `15m` and `4h` active, is loading `strategy_set_top7_drop6.json` and `strategy_set_4h_maxprofit.json`, and is CLOB-trade-ready in the narrow probe sense. (5) Re-ran exact-runtime-v2 comparisons for the current live 15m artifact versus `top7_drop6_per_asset_lcb60_min12` and `top8_current`, plus 5m scenario comparisons. (6) Verified `server.js` and `lib/clob-client.js` parse cleanly with `node --check`.
**What is pending**: (1) Curate and deploy the intended local changes. (2) Verify that the next live deploy still passes the balance/CLOB truth endpoints. (3) Capture one real live order submission with `orderID` on the current execution path. (4) Decide whether to keep `top7_drop6`, switch to `top7_drop6_per_asset_lcb60_min12`, or test-deploy `top8_current` based on the desired trade-off between conservative survivability and replay median upside.
**Discrepancies found**: `render.yaml` defaults do not match the live env posture. Bare cached `/api/health` can mislead unless a cache-busted query string is used. Current live artifact choice differs from the checked-in default 15m path.
**Key insight**: The bot is now much closer to honest handoff than in the old “invalid signature” state, but the present deploy is still missing the one proof that matters most: a fresh, current-deploy live order that actually returns `orderID` and completes the funded path.
**Methodology**: Live endpoint verification, local syntax verification, local exact-runtime-v2 replay comparisons, local strategy schedule extraction, repo/deploy state inspection.
**Next action**: Curate the workspace, deploy intentionally, then verify one real live order path before calling the project fully handoff-ready.

### Addendum — 30 March 2026 Runtime Recovery + Proof-Path Preparation

⚠️ **DATA SOURCE**: Live API (`/api/health`, `/api/status`, `/api/diagnostics`, `/api/clob-status`, `/api/wallet/balance`, `/api/debug/strategy-paths`) plus local strategy-file inspection of `debug/strategy_set_top8_current.json` plus local syntax-checked code changes in `server.js` and `lib/clob-client.js`.

⚠️ **LIVE RUNTIME STATUS**: The live host is again healthy enough to evaluate both `15m` and `4h` honestly. Trading bankroll is back to `4.999209`, `15m` loads `/app/debug/strategy_set_top8_current.json`, `4h` loads `/app/debug/strategy_set_4h_maxprofit.json`, and the selected `sigType=1` wallet funder is `0x1fcb9065142AFDFa4eE1cFFC107B6a7fd1d49612` with collateral/allowance visible.

⚠️ **LIVE METRIC AVAILABILITY**: Rolling live accuracy is still unavailable because the current restart has `0` completed trades.

⚠️ **DISCREPANCIES**: The live host now shows recovered bankroll and active `4h`, but `/api/health.deployVersion` still reports the old static label and top-level `/api/clob-status.tradeReady` can still show `TIMEOUT_5s` even while nested `clobStatus.tradeReady.ok=true`. Those are truth-surface mismatches, not proof of failed wallet auth.

#### Verified 30 March 2026 Recovery State

- Runtime URL remains `https://polyprophet-1-rr1g.onrender.com`
- Live bankroll/runtime bankroll: `4.999209`
- Active timeframes: `15m` and `4h`
- `15m` artifact: `/app/debug/strategy_set_top8_current.json` (`8` strategies)
- `4h` artifact: `/app/debug/strategy_set_4h_maxprofit.json` (`8` strategies)
- Current executor posture: `0` open positions, `0` completed trades on this restart
- Current diagnostics no longer show new balance-timeout entries after runtime recovery

#### Current Honest Boundary

- The runtime is healthy enough to monitor, discover, price, and size trades again.
- The wallet/auth layer is healthy enough to report a ready `sigType=1` selected candidate with visible collateral balance and allowance.
- What is **still not proven** is a fresh live order returning a real `orderID` on the current deploy path.

#### Why No Natural Trade Proof Exists Yet

`top8_current` does **not** trade every cycle. It only opens when both the scheduled UTC window and the required entry band are hit.

The currently loaded `top8_current` schedule is:

- `H08 m14 DOWN 60-80c`
- `H09 m08 UP 75-80c`
- `H10 m06 UP 75-80c`
- `H10 m07 UP 75-80c`
- `H11 m04 UP 75-80c`
- `H20 m01 DOWN 68-80c`
- `H20 m03 DOWN 72-80c`
- `H00 m12 DOWN 65-78c`

During the current verification slice, live 15m prices were mostly around `44-55c`, so the runtime honestly found `0` candidates and attempted `0` trades.

#### Local Proof-Path Hardening Prepared

Two local code changes were prepared to improve verification honesty and manual proof capability:

1. `lib/clob-client.js`
   - preserves the selected `sigType=1` auth context for collateral balance refreshes
   - reuses the already-probed selected collateral balance instead of collapsing the runtime to false-zero on transient follow-up failures

2. `server.js`
   - exposes a guarded `POST /api/manual-smoke-test` route that reuses the normal `tradeExecutor.executeTrade()` path
   - requires explicit secret authorization plus `confirmLive=true`
   - validates market key, side, slug, and optional max entry price before attempting a real live smoke trade

This route is intended for **one intentional funded smoke test**, not for ordinary runtime operation.

#### Current GO / NO-GO Verdict

**Still NO-GO for claiming fully proven unattended live autonomy.**

Reasons:

1. No fresh live `orderID` has been observed on the current restart.
2. Natural proof depends on scheduled windows and in-band prices, which have not aligned yet.
3. The guarded manual smoke-test route exists locally for intentional verification, but that path still needs deploy + explicit invocation.

#### Updated Next Action

1. Deploy the local guarded smoke-test route and the balance-refresh hardening.
2. Verify the route and the restored bankroll truth on the live host.
3. Either:
   - wait for the next natural `top8_current` eligible window, or
   - invoke one guarded intentional smoke test with explicit confirmation.
4. Only after a real `orderID` is captured should the project be described as fully handoff-ready.

#### Current Session State — 31 March 2026

> **Update this section at the end of every AI session.**

**Last Agent**: Factory Droid (Claude Opus 4.6)
**Date**: 31 March 2026 01:30 UTC
**What was done**: (1) Fixed CLOB signing (removed POLY_ADDRESS override in d1a5263). (2) Placed FIRST LIVE TRADE: BTC DOWN at 56c, lost $2.80 using m10 bootstrap. (3) Discovered 45% stake fraction = guaranteed bust via Monte Carlo. (4) Reduced stake to 15% across all tiers (b584d4f). (5) Ran OUT-OF-SAMPLE validation on 992 cycles (March 28-31): overall 74.4% WR vs 79% in-sample. (6) Identified FAILED strategies: m10 bootstrap 40-51% OOS WR (below break-even), m11 mid-momentum 56-66% OOS WR. (7) Validated GOOD strategies: m14 resolution 83-92% OOS WR, m12 momentum 79-87% OOS WR. (8) Ran honest profit sims showing extreme sensitivity: 5% WR drop turns $12k median into $22.
**What is pending**: (1) User must deposit $5-10. (2) Remove m10 bootstrap and m11 mid-momentum strategies from active set. (3) Monitor first 50 trades with validated strategies. (4) If actual WR < 65%, halt and reassess. (5) Research maker orders for 0% fees.
**Discrepancies found**: Previous profit sims claimed "median $291k" but used in-sample WRs without sensitivity analysis. At OOS WRs (74.4%), the median drops by 3 orders of magnitude. The first 3 real trades all lost, confirming the m10 bootstrap strategy is non-viable.
**Key insight**: Compounding math is real but EXTREMELY sensitive to edge quality. The strategies need to be filtered to only validated ones (m14 resolution + m12 momentum) before resuming live trading.
**Next action**: Deposit funds, remove failed strategies, resume with validated strategies at 10-15% stake.

### Final Handoff — 30 March 2026 Post-Patch Live State

⚠️ **DATA SOURCE**: Live API (`/api/health`, `/api/status`, `/api/diagnostics`, `/api/clob-status`) plus local code analysis of the shipped `lib/clob-client.js` and `server.js` changes.

⚠️ **LIVE RUNTIME STATUS**: The current live host is `https://polyprophet-1-rr1g.onrender.com` and is serving deploy `055de786be39bdd25d9356aedb107776baaff82b`. Runtime is `LIVE`, bankroll is `4.999209`, both `15m` and `4h` are active, `15m` is loading `/app/debug/strategy_set_top8_current.json`, `4h` is loading `/app/debug/strategy_set_4h_maxprofit.json`, and `/api/clob-status` currently reports `tradeReady.ok=true` for `sigType=1` with selected funder `0x1fcb9065142AFDFa4eE1cFFC107B6a7fd1d49612`.

⚠️ **LIVE METRIC AVAILABILITY**: Rolling live accuracy remains unavailable because the current patched restart still has `0` completed trades.

⚠️ **DISCREPANCIES**: Earlier README notes that said the latest guarded smoke-test / order-path fixes were still undeployed are now stale. The current live host has already advanced to `055de78`. What remains stale is not deploy state but proof state: there is still no post-patch accepted live `orderID`.

#### What Was Actually Proven This Session

1. The live host previously reached the real funded path and produced honest `TRADE_FAILED` diagnostics with `{"error":"invalid signature","status":400}` on natural 15m attempts. The blocker was therefore real order submission, not market discovery.
2. The order path in `lib/clob-client.js` was then narrowed against the legacy runtime and patched so `_placeOrderWithCandidate()` uses the direct upstream `createOrder()` / `postOrder()` flow again.
3. That patch is now live on deploy `055de78`.
4. The patched restart is healthy: diagnostics are currently empty, bankroll is preserved at `4.999209`, and the readiness / allowance surfaces remain good.

#### What Is Still Not Proven

1. No post-patch live order has yet returned a real `orderID`.
2. The current patched restart has `0` completed trades and `0` open positions.
3. The first natural post-patch window checked during this session (`09:08 UTC`, `UP 75-80c`) produced `0` candidates because actual 15m YES prices were far below band.
4. The guarded manual smoke-test route exists on the live host but has not been intentionally invoked in this session.

#### Why The Patched Runtime Still Has No Trade Proof

`top8_current` is sparse by design. It only trades when a scheduled UTC minute and the required price band align together.

At the latest post-patch live check:

- `BTC_15m yesPrice = 0.11`
- `ETH_15m yesPrice = 0.02`
- `XRP_15m yesPrice = 0.01`
- `SOL_15m yesPrice = 0.00`

Those prices are nowhere near the near-term `UP 75-80c` windows, so `candidatesFound=0` and `tradesAttempted=0` is the honest outcome, not a fresh failure.

#### Exact Next Proof Gates

The next natural `top8_current` windows after this handoff are:

- `10:06 UTC` — `UP 75-80c`
- `10:07 UTC` — `UP 75-80c`
- `11:04 UTC` — `UP 75-80c`

If those windows do not land in-band, the fastest honest proof path is the guarded live smoke test.

#### Guarded Smoke-Test Route Handoff

Current live route:

- `POST /api/manual-smoke-test`

Current safeguards:

- requires secret via `x-manual-smoke-key` header or `manualSmokeKey` body field
- requires `confirmLive=true`
- requires valid `marketKey`
- requires `direction` of `UP` or `DOWN`
- optionally enforces `expectedSlug`
- optionally enforces `maxEntryPrice`
- routes through normal `tradeExecutor.executeTrade()` instead of a fake path

This is the cleanest way to prove the current patched execution path if natural windows stay out of band.

#### Final Truthful Verdict

**NO-GO for claiming fully proven unattended live autonomy.**

Reason:

- the runtime is healthy
- the wallet/auth readiness layer is healthy
- the previously failing order path has been patched and deployed
- but there is still **no post-patch accepted order with real `orderID`**

The project is therefore **handoff-ready for continued verification**, but **not handoff-ready for claiming proven live autonomy**.

#### Final Session Closeout — 30 March 2026

> **Update this section at the end of every AI session.**

**Last Agent**: Cascade operating as DEITY agent
**Date**: 30 March 2026 (UTC)
**What was done**: (1) Re-verified the promoted live posture and confirmed `top8_current` + `4h_maxprofit` were active on the host. (2) Captured real pre-patch `invalid signature` order failures from live diagnostics, proving the blocker was actual order submission. (3) Compared the current order path against the legacy runtime and narrowed the likely regression to the wrapped order-submission flow. (4) Patched `lib/clob-client.js` so actual order creation/submission returned to the direct upstream client path. (5) Deployed that patch as commit `055de78` and re-verified the patched host. (6) Confirmed the patched restart remained healthy but did not yet receive an in-band natural order opportunity.
**What is pending**: (1) Capture one post-patch accepted live `orderID`. (2) If natural windows stay out of band, run one guarded manual smoke test. (3) After one accepted live order, verify the rest of the funded path: fill or partial fill handling, resolution / sell behavior, redemption, and balance reconciliation. (4) Only then append a true GO-ready autonomy note.
**Discrepancies found**: Earlier README notes still imply the newest guarded-route / patched-order deploy had not landed. That is now stale; `055de78` is live. The remaining uncertainty is execution proof, not deployment state.
**Key insight**: The real milestone was shifting from “the bot looks ready” to “the bot previously failed on a real funded order path, that path was patched, and the remaining gap is now only a post-patch proof trade.”
**Methodology**: Live endpoint polling, legacy-vs-lite order-path comparison, targeted runtime patching, syntax verification, deploy verification, and natural-window monitoring.
**Next action**: Use either the next natural in-band `top8_current` window or the guarded `/api/manual-smoke-test` route to capture one post-patch real `orderID`.

### Harness Continuity Addendum — 30 March 2026

⚠️ **DATA SOURCE**: Local harness file creation, direct authority-file edits, and deterministic ECC harness audit output from `node external/everything-claude-code/scripts/harness-audit.js repo --format text --root .`.

#### What Was Added

Repo-local harness coverage was expanded with:

- `.agent/skills/harness-optimizer/SKILL.md`
- `.agent/skills/typescript-reviewer/SKILL.md`
- `.agent/rules/typescript.md`
- `.agent/workflows/harness-audit.md`
- `.agent/workflows/loop-start.md`
- `.agent/workflows/loop-status.md`
- `.windsurf/workflows/handover-sync.md`

Additionally, these existing authority files were synchronized toward current repo truth:

- `.agent/skills/DEITY/SKILL.md`
- `.agent/skills/EXECUTION/SKILL.md`
- `.agent/skills/ULTRATHINK/SKILL.md`
- `.agent/rules/agents.md`
- `.windsurf/workflows/skill.md`
- `.agent/ecc-install-state.json`

#### What Was Verified

ECC harness audit result after the repo-local harness additions:

- overall score: `8/29`
- Tool Coverage: `0/10` (`0/7 pts`)
- Context Efficiency: `6/10` (`3/5 pts`)
- Quality Gates: `4/10` (`3/7 pts`)
- Memory Persistence: `0/10` (`0/2 pts`)
- Eval Coverage: `0/10` (`0/2 pts`)
- Security Guardrails: `3/10` (`2/6 pts`)

#### Why The Score Is Still Low

The upstream ECC audit is heavily biased toward a Claude/ECC install shape such as user-level plugin state and project-local `.claude/` assets.

This repo now has a meaningful project-local harness in `.agent/` and `.windsurf/`, but the audit still penalizes:

1. missing user/plugin installation that cannot be guaranteed by the repo alone
2. lack of checked-in automated tests
3. lack of project-local `.claude/` mirrors or equivalents for Claude-specific discovery

#### Honest Remaining Limits

1. `AGENTS.md` is semantically updated but still has unresolved markdown table-style lint. Multiple direct patch attempts on that file failed due tool-context mismatch, so this remains a formatting issue rather than a truth issue.
2. The repo still lacks checked-in automated tests, so quality-gate automation remains weak.
3. The repo still does not ship a `.claude/` mirror layer, so some ECC/Claude-specific audit checks remain uncredited even though `.agent/` and `.windsurf/` coverage improved.
4. None of this changes the separate live-trading proof status: the project still lacks a post-patch accepted live `orderID` and therefore still cannot be described as proven unattended live autonomy.

#### Best Next Harness Actions

1. Add a minimal `.claude/` compatibility layer that points Claude-oriented agents at `README.md`, `AGENTS.md`, and the local `.agent/` harness.
2. Add at least one checked-in verification script or smoke-testable test suite so harness workflows can validate changes automatically.
3. Fix `AGENTS.md` markdown formatting once a non-brittle edit path is available.
4. Keep updating this README at the end of each substantial task so handoff truth remains repo-native rather than chat-dependent.

<!-- HANDOFF_STATE_START -->
### Current Handoff State (Machine-Parseable)

**Last Agent**: Factory Droid (Claude Opus 4.6)
**Date**: 31 March 2026 01:30 UTC
**Deploy Version**: `dd85fef` (Render auto-deployed)

**STATUS: BUSTED — $0.349 balance, cannot trade (min order $0.90)**

**First trade**: BTC 15m DOWN at 56c, $2.80 stake, m10 bootstrap strategy, 30 Mar 23:40 UTC. Result: LOSS.
**Subsequent trades**: 2 more losses at 45% stake fraction -> balance crashed $5 -> $0.35.
**Root cause**: Used m10 bootstrap strategy (40-51% OOS WR, below 56% break-even) with 45% stake (>2x full Kelly).

**Auth chain (RESOLVED)**:
- sigType=1 (Magic Link / POLY_PROXY), proxy funder `0xe7E89BA00F43A38F457d30c2F72f68fE75E2850A`
- EOA signer: `0x1fcb9065142AFDFa4eE1cFFC107B6a7fd1d49612`
- Fixed: POLY_ADDRESS header override removed (`d1a5263`), minOrderShares 5->1 (`369fbec`), stake fractions 45%->15% (`b584d4f`).

**OUT-OF-SAMPLE VALIDATION (992 cycles, March 28-31, 4 assets, 3,333 strategy matches)**:

| Strategy | In-Sample WR | OOS WR | Verdict |
|----------|-------------|--------|---------|
| m14 resolution (80c+) | 88-94% | 83-92% | VALIDATED |
| m12 momentum (55-95c) | 80-84% | 79-87% | VALIDATED |
| m11 wide-momentum | 80-85% | 75-84% | VALIDATED |
| m10 late-momentum | 76-79% | 72-76% | MARGINAL |
| m11 mid-momentum (45-70c) | 67-74% | 56-66% | DEGRADED |
| m10 bootstrap (35-60c) | 65-68% | 40-51% | FAILED |

**Overall OOS WR: 74.4%** (vs 79% in-sample). 5% degradation from overfitting.

**HONEST Profit Projections (all assumptions flagged)**:
- Resolution farm only (m14, 91% WR, 20 trades/day, 10% stake, $5 start): median $201/30d
- Combined res+momentum (35 trades/day, 10% stake): median $5,111/30d
- Conservative (WR -5%, 15 trades/day, 10% stake): median $10/30d
- CRITICAL: 5% WR degradation turns $12k median into $22. Extreme sensitivity to WR assumptions.

**Env vars on Render**: `TRADE_MODE=LIVE`, `ENABLE_LIVE_TRADING=true`, `LIVE_AUTOTRADING_ENABLED=true`, `POLYMARKET_SIGNATURE_TYPE=1`, `POLYMARKET_ADDRESS=0xe7E89BA00F43A38F457d30c2F72f68fE75E2850A`, `CLOB_FORCE_PROXY=1`, proxy URL set.

**What works**: Auth, cred derivation, balance probes, strategy matching, order placement, position tracking, resolution detection, win/loss recording, risk manager with 15% stake.

**What is pending**:
1. **User must deposit $5-10** to proxy wallet `0xe7E89BA00F43A38F457d30c2F72f68fE75E2850A`
2. **Remove failed strategies**: m10 bootstrap (40-51% OOS WR) and m11 mid-momentum (56-66% OOS WR) from strategy set
3. **Monitor first 50 real trades** with validated strategies, compare actual WR to OOS WR
4. **If actual WR < 65%**: halt and reassess entire approach
5. Research maker orders (0% fees) vs current taker orders (~3.15% fee)

**Key commits (session 30-31 Mar)**:
- `dd85fef`: README with profit sim results and new stake fractions
- `b584d4f`: Reduce stake fractions to 15% (prevent guaranteed bust)
- `5b62dd1`: README update with first trade details
- `369fbec`: Reduce minOrderShares 5->1
- `d1a5263`: Remove POLY_ADDRESS header override (root cause fix)
<!-- HANDOFF_STATE_END -->
