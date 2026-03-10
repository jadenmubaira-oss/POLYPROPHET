# POLYPROPHET — Final Operator Guide

**Generated:** 9 March 2026  
**Primary strategy set:** `top7_drop6`  
**Target mode:** Autonomous `LIVE` 15-minute crypto trading  
**Verdict:** **CONDITIONAL GO**, with verified safeguards and explicit deployment caveats

---

## 1. What this guide is for

This is the clean operator procedure for the current evidence-backed setup.

It reflects the verified runtime in `server.js`, not the older manual-only brief.

The current intended production setup is:

- `top7_drop6` as the primary operator strategy set
- `45%` stake fraction for bankrolls `<= $10`
- `LIVE` mode with autonomous execution enabled
- 15-minute markets only
- 4H markets disabled
- Telegram and dashboard used for visibility, not as a requirement for execution logic

---

## 2. Evidence-backed operating truth

### Strategy evidence

| Source | Result | Notes |
| --- | --- | --- |
| Live trades | `57 / 63` = **90.5% WR** | Best evidence currently available for any set |
| Replay ledger | `432 / 489` = **88.3% WR** | Full oracle + strategy replay |
| Strategy-file OOS | **94.8% WR** | Useful, but less trustworthy than live/runtime evidence |

### Why `top7_drop6`

- It is the only set with meaningful live-trade validation in the repo.
- Its live result is consistent with replay evidence.
- It is materially more trustworthy than `highfreq_unique12`, whose file WR looks inflated relative to replay and has no live validation.

### Honest expectation from micro-bankrolls

For `$8-$10`, the setup is aggressive but not magic.

| Start | Stake | 14-day median | Bust risk | P($100) | P($500) | P($1k) |
| --- | --- | --- | --- | --- | --- | --- |
| `$8` | `45%` | about **$134** | about **15.1%** | **56.5%** | **14.4%** | **0.2%** |
| `$10` | `45%` | about **$174** | about **10.9%** | **62.2%** | **18.5%** | **0.3%** |

These figures are based on the live-WR audit basis, not optimistic file-only assumptions.

---

## 3. Required production environment

Use these as the target Render/runtime configuration for autonomous live trading:

```env
TRADE_MODE=LIVE
ENABLE_LIVE_TRADING=1
LIVE_AUTOTRADING_ENABLED=1
TELEGRAM_SIGNALS_ONLY=false
OPERATOR_STAKE_FRACTION=0.45
OPERATOR_STRATEGY_SET_PATH=debug/strategy_set_top7_drop6.json
MULTIFRAME_4H_ENABLED=false
MAX_POSITION_SIZE=0.45
MAX_ABSOLUTE_POSITION_SIZE=100
DEFAULT_MIN_ORDER_SHARES=5
ASSET_BTC_ENABLED=true
ASSET_ETH_ENABLED=true
ASSET_SOL_ENABLED=true
ASSET_XRP_ENABLED=true
AUTH_USERNAME=...
AUTH_PASSWORD=...
REDIS_URL=...
POLYMARKET_PRIVATE_KEY=...
POLYMARKET_API_KEY=...
POLYMARKET_SECRET=...
POLYMARKET_PASSPHRASE=...
POLYMARKET_SIGNATURE_TYPE=1
```

### Optional but often required

```env
OPERATOR_BASE_BANKROLL=8
PROXY_URL=...
CLOB_FORCE_PROXY=1
POLYMARKET_ADDRESS=...
```

Use `OPERATOR_BASE_BANKROLL` if you want the operator dashboard's advisory `stakePerSignal` display to reflect your intended starting bankroll exactly.
Use `PROXY_URL` plus `CLOB_FORCE_PROXY=1` if your hosting region is geoblocked by Polymarket.
Use `POLYMARKET_ADDRESS` only when you need to force a separate funder/profile address for signature type `1`.

### Important notes

- `ENABLE_LIVE_TRADING` alone is **not** enough.
- `LIVE_AUTOTRADING_ENABLED` must also be on, or the runtime remains advisory-only.
- `TELEGRAM_SIGNALS_ONLY=false` is required for autonomous execution. If signals-only mode is on, execution endpoints are intentionally blocked.
- `REDIS_URL` is required for reliable live-state persistence.
- `OPERATOR_BASE_BANKROLL` affects operator display sizing only; actual live sizing uses current live balance / equity, not this advisory baseline.
- `MULTIFRAME_4H_ENABLED=false` should be set for the audited 15-minute-only production setup. In the current audited runtime, this now hard-disables 4H startup/polling rather than merely suppressing 4H signals.
- `DEFAULT_MIN_ORDER_SHARES` should remain `5` for truthful CLOB sizing. The runtime clamps 15-minute crypto orders to at least 5 shares even if a lower env value is supplied.
- If the host IP is geoblocked, the proxy path is not optional. Removing it can break trading even when the rest of the deployment looks healthy.

---

## 4. Pre-flight checklist before letting it run

Before you trust the bot in `LIVE`, verify these in order.

### 4.1 Version and deployment identity

Check:

- `/api/version`

Confirm:

- expected commit is deployed
- expected config version is live

### 4.2 Health state

Check:

- `/api/health`

What you want:

- no stale feed block
- no manual pause unless intentional
- no circuit-breaker degradation you were not expecting
- wallet checks healthy in deep verification
- rolling accuracy visible

### 4.3 Deep live verification

Check:

- `/api/verify?deep=1`

This is the key live-readiness endpoint.

It should confirm:

- wallet loaded
- wallet RPC reachable
- CLOB client present
- Polymarket API credentials present
- CLOB trading permission + collateral allowance pass
- live prerequisites satisfied

Interpretation rule:

- the official Polymarket geoblock check reflects the host IP and can warn even while proxy-routed CLOB access still works
- when you are using a proxy, the decisive execution-readiness check is the deep `CLOB trading permission + collateral allowance` result
- if the host is geoblocked, treat proxy health as mandatory, not optional

### 4.4 Operator configuration

Check:

- `/api/live-op-config`

Confirm all of the following:

- `operatorMode` is `AUTO_LIVE`
- effective strategy path is `debug/strategy_set_top7_drop6.json`
- stake fraction is `0.45`
- strategy runtime is loaded
- no unexpected gate overrides are active

### 4.5 Runtime state

Check:

- `/api/state`

Confirm:

- `_trading.mode` is `LIVE`
- live balance is populated
- there are no obvious suppression states

---

## 5. What the bot will and will not do

### It will trade automatically only when all of these are true

- mode is `LIVE`
- wallet is loaded
- live autotrading is enabled
- signals-only mode is off
- feed is not stale
- manual pause is not active
- strategy and runtime gates agree
- bankroll is above effective tradeability thresholds

### It will refuse to auto-trade when any of these are true

- `LIVE_AUTOTRADING_ENABLED` is off
- `TELEGRAM_SIGNALS_ONLY=true`
- no wallet is loaded
- Chainlink/feed data is stale
- balance is below effective floor or minimum tradable size
- live credentials / CLOB readiness fail
- circuit breaker or manual pause suppresses entries

### Exit behavior

For live non-binary exits, the bot does **not** mark a trade closed until the sell is actually confirmed.

If a live sell fails:

- the position stays open
- it is marked pending for retry/recovery
- recovery can be inspected through the pending-sell flow

---

## 6. Minimum order reality at $8-$10

Polymarket runtime trading is CLOB-native.

The enforced minimum is effectively:

- `5` shares minimum
- actual minimum USDC cost depends on entry price

At roughly `77¢`, the minimum usable stake is about:

- `5 × 0.77 = $3.85`

That matters because:

- `$8 × 45% = $3.60`
- the runtime may need to clamp upward toward the minimum executable order size
- at tiny bankrolls, your effective stake fraction can end up slightly above the nominal `45%`

This is one reason the bust risk is real.

Two losses from a tiny bankroll can leave you below minimum executable size.

---

## 7. How live balance is interpreted

The live runtime does **not** treat all balances the same.

The balance display and risk logic use a live balance breakdown built from:

- on-chain USDC
- CLOB collateral fallback
- last known good balance if fresh reads are unavailable

### Source priority

The runtime prefers:

1. **On-chain USDC**
2. **CLOB collateral fallback**
3. **Last known good balance**

### What that means operationally

- If on-chain USDC is detected, that is treated as the trading balance source.
- If on-chain USDC is zero but CLOB collateral is available, the runtime can fall back to collateral balance.
- If both fresh reads fail, the UI may still show the last known good balance. That is useful for observability, but you should not treat stale fallback balance as guaranteed spendable cash.

---

## 8. Deposits and withdrawals: what actually happens

This was explicitly verified in `server.js`.

The runtime has **auto-transfer detection** for both deposits and withdrawals.

### Refresh cadence

A background loop refreshes live balances roughly every `30s`.

### Transfer detection conditions

A transfer is classified only when the account is quiet long enough and the balance change is large enough.

Default thresholds below `$1,000`:

- minimum change: **15%**
- minimum absolute change: **$5**
- quiet period: **120s** since last trade

For `$1,000+` accounts, the thresholds become more sensitive:

- **5%**
- **$20**

### What resets after a deposit or withdrawal

When a qualifying external transfer is detected, the runtime resets:

- lifetime peak balance
- baseline bankroll
- starting balance compatibility field
- day-start balance
- peak balance

### Why this exists

This is intentional.

It prevents:

- a **withdrawal** from being misread as a trading drawdown
- a **deposit** from falsely inflating profit-multiple logic
- peak-drawdown braking from staying stuck after external cash movement

### Practical operator meaning

Deposits and withdrawals do **not** inherently break the bot.

But they do change the reference point used by:

- profit-lock logic
- drawdown/peak-based risk logic
- baseline bankroll reporting

After a top-up or withdrawal:

- wait for the next balance refresh
- re-check `/api/health` or `/api/state`
- confirm the new balance baseline has been recognized before judging sizing behavior
- note that leaving `$100` is still comfortably tradable, but under the current live thresholds it sits in `TRANSITION`, not `BOOTSTRAP`; that is fine because a `45%` target stake is already far above minimum order cost

### Important micro-bankroll warning

If a withdrawal leaves you below the minimum executable order cost, the bot will not be able to place new trades even if strategy conditions are perfect.

---

## 9. Daily operating procedure

Use this routine.

### Start of session

- confirm deploy identity via `/api/version`
- confirm health via `/api/health`
- confirm deep live readiness via `/api/verify?deep=1`
- confirm operator config via `/api/live-op-config`
- confirm live balance via `/api/state`

### While running

- leave the service up continuously
- use a paid tier or equivalent to avoid cold-start misses
- keep Telegram enabled for visibility even when autonomy is on
- periodically review pending sells / recovery state if any live sell failed

### If you change bankroll externally

- deposit or withdraw
- wait for balance refresh
- re-check health/state
- verify new baseline was recognized

### If you need to stop execution immediately

Use one of these:

- enable signals-only mode
- disable live autotrading
- use manual pause / trading pause controls

---

## 10. Recovery and failure handling

If something goes wrong, inspect in this order:

- `/api/health`
- `/api/verify?deep=1`
- `/api/live-op-config`
- `/api/state`
- pending-sell / reconcile endpoints if exits are involved

Typical causes of no-trade or degraded behavior:

- stale data feed
- geoblock / proxy issue
- missing wallet or Polymarket credentials
- signals-only mode left on
- live autotrading disabled
- balance too low after losses or withdrawal
- circuit breaker / manual pause suppression

---

## 11. Final recommendation

For the current repo and evidence base:

- use `top7_drop6`
- use `45%` stake at `$8-$10`
- keep 4H disabled
- keep `MULTIFRAME_4H_ENABLED=false` so 4H remains operationally off, not just hidden in status reporting
- run only after deep verification passes
- if the host region is geoblocked, keep proxy-routed CLOB access enabled and verified
- set auth before exposing the dashboard publicly
- accept that the setup is **high-upside but not bust-proof** at tiny bankrolls

### Honest bottom line

This is the best verified aggressive setup currently in the repo.

It is good enough for a **conditional GO**.

It is **not** a clean unconditional GO from the raw host IP, because the official geoblock check can fail on the deployment region while proxy-routed CLOB access remains the real execution path.

It is **not** a guarantee of turning `$8` into `$1,000` in two weeks.

The correct production reading is:

- **GO** if `/api/verify?deep=1` passes the deep CLOB permission/allowance checks and your proxy path remains healthy
- **NO-GO** if auth is unset or proxy/geoblock routing breaks
- strong upside if live WR holds
- meaningful bust risk at tiny bankroll size
- much better survivability once bankroll is materially above the minimum order constraint

---

## 12. Operator one-screen summary

- **Strategy:** `top7_drop6`
- **Stake fraction:** `0.45`
- **Mode:** `LIVE`
- **Autonomy:** on only when `LIVE_AUTOTRADING_ENABLED=1` and `TELEGRAM_SIGNALS_ONLY=false`
- **Redis:** required
- **4H:** off
- **Min tradable size:** effectively `5` shares
- **Best live evidence:** `57/63` = `90.5% WR`
- **$8 reality:** median about `$134` in 14 days, bust about `15.1%`
- **Deposits/withdrawals:** detected automatically and reset baseline/peak references
- **Auth:** must be set before public live operation
- **Host geoblock:** host-IP warning can coexist with a working proxy; deep CLOB permission pass is the decisive readiness check

---

*This file is the clean operator procedure for the final audited setup. If code and docs ever disagree, trust the runtime in `server.js` and re-audit before trading.*
