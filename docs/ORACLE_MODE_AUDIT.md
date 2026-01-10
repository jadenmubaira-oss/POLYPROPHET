# ORACLE MODE AUDIT (Bloat / Duplication / Safety Gates)

This document is a **non-destructive audit** of what matters for **oracle/advisory mode** (manual trading) vs. what is legacy / optional / “bloat” for that goal.

The intent is to **leave the chassis intact** (safer) while clearly marking what can be ignored or feature-flagged.

---

## Non‑negotiable invariants (do not rewrite)

These are core correctness constraints for the 15‑minute Polymarket up/down markets:

- **Checkpoint cadence**: `INTERVAL_SECONDS = 900` and checkpoint computation (`getCurrentCheckpoint()`, `getNextCheckpoint()`).
- **Market link generation**: the active cycle must produce a direct `https://polymarket.com/event/<slug>` URL.
- **Market discovery + odds fetching**:
  - Gamma events: `.../events/slug/<slug>`
  - CLOB orderbook best asks: `.../book?token_id=...`
- **Chainlink live prices via Polymarket WS**: primary price feed (no HTTP price fallback).

Breaking any of the above turns the bot into a “delusion machine” (signals detached from real market mechanics).

---

## What “Oracle Mode” means in this repo

- **Default**: advisory-only signals (PREPARE/BUY/SELL) sent to UI + Telegram.
- **Paper auto-trading stays on** for continuous evaluation, metrics, and learning loops.
- **LIVE auto-trading is blocked by default**.

### Safety gates (feature flags)

These are the key “don’t accidentally trade” levers:

- **`LIVE_AUTOTRADING_ENABLED`** (env):
  - Default **false**.
  - When false: `executeTrade()` blocks automated LIVE entries, and exit automation is suppressed.
  - This makes LIVE effectively “oracle only”.

- **`ENABLE_MANUAL_TRADING`** (env):
  - Required to allow `/api/manual-buy` and `/api/manual-sell` when `TRADE_MODE=LIVE`.

- **`TELEGRAM_SIGNALS_ONLY`** (env, default true):
  - Suppresses PAPER open/close spam so Telegram focuses on oracle signals + critical alerts.

- **`PROFILE_TRADE_SYNC_ENABLED`** (env, default true):
  - Controls ingestion of real trades via Polymarket Data API.

---

## “Bloat” relative to Oracle Mode (kept for safety/compat)

### 1) Full LIVE execution stack (optional)

Includes:
- wallet loading, RPC balance reads
- live buy/sell order placement
- partial fill logic
- redemption queue + retry logic
- crash recovery reconciliation

**Oracle Mode does not require** this to generate predictions/signals.

Why it still exists:
- The repo historically supported autonomous trading.
- Keeping it behind gates is safer than deleting it without full regression testing.

### 2) Vault / Monte Carlo / backtesting framework (optional)

Includes:
- Monte Carlo vault projection and optimizers
- Polymarket backtest optimizers and “perfection check”

**Oracle Mode does not require** vault modeling to issue signals.

Why it can still be useful:
- It provides a rigorous way to reason about bankroll growth and risk envelopes if you choose to paper trade.
- It’s also used heavily for self-tests / verification endpoints.

### 3) UI duplication: embedded HTML in `server.js` vs `public/*`

This repo contains:
- Static UI pages in `public/`
- Large HTML pages embedded in `server.js` for settings/guide/debug tooling

This is **duplicate surface area**. It’s not ideal, but removing it in one shot is risky.

### 4) Two realtime channels

There are multiple realtime update paths:
- Socket.IO (`omega_update`, `state_update`)
- Raw WS broadcast (`wss` + `broadcastUpdate()`)

This is duplication, but different pages use different feeds. Safer to keep.

---

## Oracle‑mode specific additions (high signal, not bloat)

- **Oracle signal engine** (`oracleSignal` in `/api/state`):
  - PREPARE/BUY/SELL/HOLD/WAIT/AVOID outputs
  - includes pWin/EV/edge + reasons + market link

- **Telegram oracle alerts**:
  - prewarning → buy → sell
  - per-cycle throttling to avoid spam

- **Profile trade sync (Polymarket Data API)**:
  - ingests your real account fills (optional)
  - persisted in state for learning/evaluation

- **Time‑to‑correct‑call metrics**:
  - derived from per-tick history and stored per cycle
  - surfaced in UI for “earlier correct calls” measurement

---

## Known limitations / risks (honest)

- **No guarantee of profit or 100% accuracy**: signals are probabilistic and markets are adversarial.
- **Profile trade ingestion is “best effort”**:
  - Polymarket Data API response fields can change.
  - Not all trades may include event slugs; mapping relies on slug extraction.
- **Large monolithic `server.js`**:
  - hard to audit and refactor safely without a test harness
  - any future cleanup should be incremental and guarded by `/api/verify` + `/api/perfection-check`.

