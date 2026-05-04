# POLYPROPHET Website-First Setup, Key Rotation, and 100/100 Readiness Guide

This is the beginner-friendly setup guide for someone who downloaded the GitHub repo and wants to get the bot ready with mostly website steps.

**Never share or commit real secret values.** This guide lists secret names and placeholders only.

## Choose your path

### Path A — brand-new user, brand-new bot account

Use this if this is your first setup.

1. Create a dedicated wallet/account.
2. Log into Polymarket with that wallet.
3. Use Polymarket website settings to get addresses/API keys.
4. Create a Telegram bot.
5. Add the secret names below in Fly.
6. Deploy.
7. Verify everything in Telegram while paused.
8. Resume only after the final 100/100 checklist passes.

### Path B — rotating all keys and moving funds to a new account

Use this if you are replacing the current wallet/API keys.

1. Keep the bot paused.
2. Redeem/withdraw/move old-account funds manually first.
3. Revoke old Polymarket Builder/Relayer keys.
4. Create new Polymarket wallet/account credentials.
5. Set new Fly secrets.
6. Deploy.
7. Run Telegram **Rotation Reset** only after old funds are handled.
8. Verify no stale queues remain.

### Path C — only fixing stuck auto-redeem

Use this if the wallet is staying the same, but winnings are stuck.

1. Keep the bot paused.
2. In Telegram press **Redeem Status**.
3. Press **Auto Redeem**.
4. Read the redacted `Last errors:` line.
5. If it is auth/permission-related, create a Polymarket website Relayer API key and set the relayer secrets.
6. If it says transaction failed/no tx id, manually redeem once on Polymarket, then press **Redeem Status** again.

## Polymarket website setup

### Settings > Profile

Copy the Polymarket proxy/funder/profile address for the bot account.

Set it as:

```text
POLYMARKET_ADDRESS=0xYOUR_POLYMARKET_PROXY_OR_FUNDER_ADDRESS
POLYMARKET_SIGNATURE_TYPE=1
```

For normal Polymarket web accounts, `POLYMARKET_SIGNATURE_TYPE=1` is the expected proxy-wallet mode.

### Settings > Relayer API Keys

This is the recommended website-first auto-redeem path.

Click **Create New**, then copy:

```text
RELAYER_API_KEY
RELAYER_API_KEY_ADDRESS
```

Set them in Fly as:

```text
POLYMARKET_RELAYER_API_KEY=PASTE_RELAYER_API_KEY
POLYMARKET_RELAYER_API_KEY_ADDRESS=PASTE_RELAYER_API_KEY_ADDRESS
```

This is currently the clearest path for unattended proxy redemption.

### Settings > Builder API Keys

Only use Builder keys if you have all three values:

```text
POLYMARKET_BUILDER_API_KEY=...
POLYMARKET_BUILDER_SECRET=...
POLYMARKET_BUILDER_PASSPHRASE=...
```

If the website only shows key metadata and not the secret/passphrase, use **Relayer API Keys** instead.

### Settings > Trading > Auto-Redeem

You can enable website Auto-Redeem, but remember:

- Website Auto-Redeem is Polymarket-side behavior.
- It does **not** automatically clear this bot's already-saved `redemptionQueue`.
- The bot still needs working relayer/builder redemption credentials.
- Old bot queue items may require successful bot auto-redeem, manual website redeem plus zero-verification, or confirmed Rotation Reset after account migration.

## Telegram website setup

### Create the bot

1. Open **BotFather** in Telegram.
2. Run `/newbot`.
3. Copy the bot token.

Set in Fly:

```text
TELEGRAM_BOT_TOKEN=PASTE_BOTFATHER_TOKEN
```

### Get your chat ID

After deploy:

1. Message your bot.
2. Send `/id`.
3. Copy the chat ID.

Set in Fly:

```text
TELEGRAM_CHAT_ID=YOUR_CHAT_ID
TELEGRAM_COMMANDS_ENABLED=true
```

Only this Telegram chat can control the bot.

## Fly.io website setup

Preferred beginner route:

1. Go to Fly.io.
2. Open app `polyprophet`.
3. Go to **Secrets**.
4. Add each required secret name below.
5. Never put real values in GitHub, README, screenshots, or Telegram chat.

Terminal fallback:

```powershell
flyctl secrets set SECRET_NAME="SECRET_VALUE" --app polyprophet
```

## Required secrets for fresh live setup

### Wallet / Polymarket trading

```text
POLYMARKET_PRIVATE_KEY=0xYOUR_PRIVATE_KEY
POLYMARKET_ADDRESS=0xYOUR_POLYMARKET_PROXY_OR_FUNDER_ADDRESS
POLYMARKET_SIGNATURE_TYPE=1
POLYMARKET_AUTO_DERIVE_CREDS=true
```

### Normal CLOB API credentials

Set these if you have them:

```text
POLYMARKET_API_KEY=...
POLYMARKET_SECRET=...
POLYMARKET_PASSPHRASE=...
```

If you do not have them, local helper fallback:

```powershell
node scripts\generate-polymarket-builder-creds.js
```

The helper prints a local `flyctl secrets set` command if derivation succeeds. Do not paste that output into chat/GitHub.

### Auto-redeem credentials

Recommended website relayer path:

```text
POLYMARKET_RELAYER_API_KEY=...
POLYMARKET_RELAYER_API_KEY_ADDRESS=...
```

Alternative complete builder path:

```text
POLYMARKET_BUILDER_API_KEY=...
POLYMARKET_BUILDER_SECRET=...
POLYMARKET_BUILDER_PASSPHRASE=...
```

### Telegram control

```text
TELEGRAM_BOT_TOKEN=...
TELEGRAM_CHAT_ID=...
TELEGRAM_COMMANDS_ENABLED=true
TELEGRAM_VERBOSITY=NORMAL
```

Recommended first setup safety:

```text
TELEGRAM_WALLET_CONTROLS_ENABLED=false
TELEGRAM_WITHDRAW_ENABLED=false
TELEGRAM_SIGNALS_ONLY=false
```

### Fly / admin control

```text
MANUAL_SMOKE_TEST_KEY=LONG_RANDOM_PASSWORD
TELEGRAM_FLY_API_TOKEN=FLY_TOKEN_WITH_APP_SECRET_PERMISSION
TELEGRAM_FLY_SECRETS_ENABLED=true
TELEGRAM_FLY_APP_NAME=polyprophet
```

`MANUAL_SMOKE_TEST_KEY` guards live-mutating HTTP endpoints.

## Current Fly app key-name inventory

This section records observed key names only, not values.

### Current `fly.toml` non-secret env keys

```text
NODE_ENV
PORT
START_PAUSED
TRADE_MODE
ENABLE_LIVE_TRADING
LIVE_AUTOTRADING_ENABLED
TIMEFRAME_15M_ENABLED
TIMEFRAME_15M_MIN_BANKROLL
TIMEFRAME_5M_ENABLED
MULTIFRAME_4H_ENABLED
STRATEGY_SET_15M_PATH
POLYMARKET_SIGNATURE_TYPE
POLYMARKET_AUTO_DERIVE_CREDS
TELEGRAM_FLY_SECRETS_ENABLED
TELEGRAM_FLY_APP_NAME
CLOB_FORCE_PROXY
DEFAULT_MIN_ORDER_SHARES
REQUIRE_REAL_ORDERBOOK
HARD_ENTRY_PRICE_CAP
MAX_GLOBAL_TRADES_PER_CYCLE
OPERATOR_STAKE_FRACTION
```

### Current observed deployed Fly secret names

Observed from `flyctl secrets list --app polyprophet`:

```text
CLOB_FORCE_PROXY
COOLDOWN_SECONDS
DEFAULT_MIN_ORDER_SHARES
ENABLE_4H_TRADING
ENABLE_LIVE_TRADING
ENFORCE_HIGH_PRICE_EDGE_FLOOR
ENFORCE_NET_EDGE_GATE
ENTRY_PRICE_BUFFER_CENTS
EPOCH3_TIERED_SIZING
FORWARD_TRADE_LOG_ENABLED
FORWARD_TRADE_LOG_MAX
HARD_ENTRY_PRICE_CAP
HIGH_PRICE_EDGE_FLOOR_MIN_ROI
HIGH_PRICE_EDGE_FLOOR_PRICE
LIVE_AUTOTRADING_ENABLED
LIVE_FILLS_ONLY
MANUAL_SMOKE_TEST_KEY
MAX_ABSOLUTE_STAKE
MAX_CONSECUTIVE_LOSSES
MAX_GLOBAL_TRADES_PER_CYCLE
MAX_TOTAL_EXPOSURE
MICRO_BANKROLL_MPC_CAP
MIN_BALANCE_FLOOR
MIN_NET_EDGE_ROI
MULTIFRAME_4H_ENABLED
OPERATOR_STAKE_FRACTION
ORDERBOOK_DEPTH_GUARD_ENABLED
POLYMARKET_ADDRESS
POLYMARKET_PRIVATE_KEY
POLYMARKET_SIGNATURE_TYPE
PRE_RESOLUTION_EXIT_15M_SECONDS
PRE_RESOLUTION_EXIT_ENABLED
PRE_RESOLUTION_MIN_BID
REDIS_ENABLED
REDIS_URL
REQUIRE_REAL_ORDERBOOK
RISK_ENVELOPE_ENABLED
STARTING_BALANCE
START_PAUSED
STRATEGY_DISABLE_MOMENTUM_GATE
STRATEGY_SET_15M_PATH
STRATEGY_VALIDATOR_ENABLED
TELEGRAM_BOT_TOKEN
TELEGRAM_CHAT_ID
TELEGRAM_COMMANDS_ENABLED
TELEGRAM_DAILY_SUMMARY_UTC_HOUR
TELEGRAM_FLY_API_TOKEN
TELEGRAM_QUIET_END_UTC
TELEGRAM_QUIET_START_UTC
TELEGRAM_SIGNALS_ONLY
TELEGRAM_VERBOSITY
TIMEFRAME_15M_ENABLED
TIMEFRAME_15M_MIN_BANKROLL
TIMEFRAME_5M_ENABLED
TRADE_MODE
```

### Important missing-or-must-verify names after rotation

The observed Fly secret-name list did **not** visibly include these durable auth names:

```text
POLYMARKET_RELAYER_API_KEY
POLYMARKET_RELAYER_API_KEY_ADDRESS
POLYMARKET_BUILDER_API_KEY
POLYMARKET_BUILDER_SECRET
POLYMARKET_BUILDER_PASSPHRASE
POLYMARKET_API_KEY
POLYMARKET_SECRET
POLYMARKET_PASSPHRASE
```

For clean post-rotation readiness, set normal CLOB credentials and **either** relayer credentials **or** complete builder credentials.

## Strategy/risk keys to keep or review

Current 15m-first posture:

```text
STRATEGY_SET_15M_PATH=strategies/strategy_set_15m_epoch3v2_portfolio.json
TIMEFRAME_15M_ENABLED=true
TIMEFRAME_15M_MIN_BANKROLL=3
TIMEFRAME_5M_ENABLED=false
MULTIFRAME_4H_ENABLED=false
ENABLE_4H_TRADING=false
MAX_GLOBAL_TRADES_PER_CYCLE=1
OPERATOR_STAKE_FRACTION=0.25
DEFAULT_MIN_ORDER_SHARES=5
REQUIRE_REAL_ORDERBOOK=true
HARD_ENTRY_PRICE_CAP=0.82
ENFORCE_NET_EDGE_GATE=true
ENFORCE_HIGH_PRICE_EDGE_FLOOR=true
MIN_NET_EDGE_ROI=0
START_PAUSED=true
LIVE_AUTOTRADING_ENABLED=false
```

For first post-rotation testing, keep `START_PAUSED=true` and `LIVE_AUTOTRADING_ENABLED=false`.

## Key rotation checklist

### Step 1 — pause and protect

In Telegram:

1. Press **Pause**.
2. Confirm dashboard says paused.

In Fly, keep:

```text
START_PAUSED=true
LIVE_AUTOTRADING_ENABLED=false
```

### Step 2 — handle old account funds

Before switching wallets:

1. Go to Polymarket.
2. Manually redeem old winning positions if needed.
3. Withdraw/move funds to the new wallet/account.
4. Revoke old Relayer API keys.
5. Revoke old Builder API keys.

Do not run Rotation Reset until old funds are handled.

### Step 3 — create new website credentials

On the new Polymarket account:

1. Copy the proxy/funder address.
2. Create a new Relayer API key.
3. Optionally create Builder API credentials if full secret/passphrase are available.
4. Confirm website Auto-Redeem is enabled if desired.

### Step 4 — update Fly secrets

Set new values for:

```text
POLYMARKET_PRIVATE_KEY
POLYMARKET_ADDRESS
POLYMARKET_SIGNATURE_TYPE
POLYMARKET_API_KEY
POLYMARKET_SECRET
POLYMARKET_PASSPHRASE
POLYMARKET_RELAYER_API_KEY
POLYMARKET_RELAYER_API_KEY_ADDRESS
```

If rotating Telegram/Fly too:

```text
TELEGRAM_BOT_TOKEN
TELEGRAM_CHAT_ID
TELEGRAM_FLY_API_TOKEN
MANUAL_SMOKE_TEST_KEY
```

### Step 5 — deploy

```powershell
flyctl deploy --app polyprophet --remote-only
```

### Step 6 — clear old bot-local state after migration

After deploy and after old funds are handled:

1. Open Telegram dashboard.
2. Press **Rotation Reset**.
3. Confirm only if:
   - old-account funds are moved/redeemed,
   - new wallet secrets are installed,
   - bot is paused.

This clears bot-local open/pending/recovery/redemption queues and stale balance caches while keeping trading paused.

HTTP fallback:

```powershell
Invoke-RestMethod https://polyprophet.fly.dev/api/rotation-reset `
  -Method Post `
  -Headers @{ "x-manual-smoke-key" = "YOUR_MANUAL_SMOKE_TEST_KEY" } `
  -ContentType "application/json" `
  -Body '{ "confirmRotationReset": true, "preserveClosedPositions": true }'
```

## Telegram verification sequence

Run these after deploy:

1. `/dashboard`
2. **Balance**
3. **Redeem Status**
4. **Derive Redeem Auth**
5. **Auto Redeem**
6. **Live Proof** while still paused
7. **Dashboard** again

Expected before resume:

```text
manualPause=true
Auth ready: YES
redemptionQueue=0
manualRequired=0
authBlocked=0
recoveryQueue=0
pendingBuys=0
pendingSells=0
wallet balance matches expected new account funds
```

## Current live status at guide update

Live Fly API showed:

```text
mode=LIVE
manualPause=true
tradingBalanceUsdc=0.439322
redemptionQueue=4
manualRequired=4
authBlocked=0
proxyRedeemAuthReady=true
relayerAuthMode=builder
entriesBlocked=true due ACTIONABLE_REDEMPTION_QUEUE
15m strategy loaded
5m disabled
4h disabled
```

This is not 100/100 yet because four manual-required old redemption queue items still block entries.

After key/account rotation, the queue must be cleared by successful redeem, manual old-account redeem plus zero-verification, or confirmed Rotation Reset after migration.

## Final 100/100 readiness gate

Do not resume live trading until every item is true:

- **Wallet**: new wallet/private key is installed and funded.
- **Polymarket address**: `POLYMARKET_ADDRESS` matches the new proxy/funder account.
- **Signature type**: `POLYMARKET_SIGNATURE_TYPE=1`.
- **CLOB auth**: normal CLOB API credentials are present or derivable.
- **Redeem auth**: relayer or complete builder credentials are present.
- **Telegram**: bot token/chat ID work and commands respond.
- **Runtime state**: no stale old-account queues remain.
- **Redemption**: `redemptionQueue=0`, `manualRequired=0`, `authBlocked=0`.
- **Recovery**: `recoveryQueue=0`.
- **Pending orders**: `pendingBuys=0`, `pendingSells=0`, no pending settlements.
- **Balance**: `/api/wallet/balance` matches the funds you expect.
- **Strategy**: 15m strategy file is loaded with no load error.
- **Risk**: 5m and 4h remain disabled unless deliberately re-enabled after bankroll allows it.
- **Live proof**: a paused live-order proof succeeds or gives an understood non-dangerous result.
- **Safety**: `START_PAUSED=true` until you intentionally resume.

Only after all gates pass should you consider:

```text
LIVE_AUTOTRADING_ENABLED=true
```

Then press **Resume** in Telegram at a deliberately chosen strong window.
