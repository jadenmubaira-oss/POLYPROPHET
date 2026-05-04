# POLYPROPHET Setup and Key Rotation Guide

This is the plug-and-play operator guide for setting up POLYPROPHET from scratch or rotating every important key.

**Website-first version:** start with [`WEBSITE_FIRST_SETUP_AND_ROTATION.md`](WEBSITE_FIRST_SETUP_AND_ROTATION.md) if you want the easiest Polymarket/Fly/Telegram website-based flow.

**Do not paste private keys, API keys, Fly tokens, Telegram bot tokens, or relayer keys into chat, screenshots, GitHub, README, or commits.**

## What the screenshots show

Your Polymarket website screenshots show these useful setup areas:

- **Settings > Profile**: shows your Polymarket user ID/profile address and email.
- **Settings > Trading**: contains website trading preferences and a website-side **Auto-Redeem** toggle.
- **Settings > Builder API Keys**: lists builder keys and can create new builder keys.
- **Settings > Relayer API Keys**: creates a relayer API key and shows two required headers:
  - `RELAYER_API_KEY`
  - `RELAYER_API_KEY_ADDRESS`

Important: the Polymarket website **Auto-Redeem** toggle is not the same as this bot clearing its already-queued redemption records. It may help future website-managed claims, but this bot still needs working proxy redemption credentials and must successfully submit the queued redemption through the relayer.

## The exact secrets this bot understands

### Required for live trading

| Secret | Where to get it | Notes |
|---|---|---|
| `POLYMARKET_PRIVATE_KEY` | Your wallet/exported private key | Must control the wallet that owns/signs for the Polymarket account. Never share it. |
| `POLYMARKET_ADDRESS` | Polymarket proxy/funder address | For proxy wallet accounts use the Polymarket profile/proxy/funder address. |
| `POLYMARKET_SIGNATURE_TYPE` | Use `1` for proxy wallet | Most Polymarket web accounts use proxy signature type `1`. |
| `POLYMARKET_API_KEY` | Derived by script or existing CLOB creds | Normal CLOB API key. |
| `POLYMARKET_SECRET` | Derived by script or existing CLOB creds | Normal CLOB API secret. |
| `POLYMARKET_PASSPHRASE` | Derived by script or existing CLOB creds | Normal CLOB API passphrase. |

### Required for unattended proxy auto-redeem

Use **one** of these two paths.

#### Preferred path A: Relayer API key from Polymarket website

| Secret | Where to get it | Notes |
|---|---|---|
| `POLYMARKET_RELAYER_API_KEY` | Polymarket **Settings > Relayer API Keys** | The API key value created by the website. |
| `POLYMARKET_RELAYER_API_KEY_ADDRESS` | Same Polymarket relayer box | This is the address shown beside `RELAYER_API_KEY_ADDRESS`. |

This is currently the clearest path because your screenshots show the website can create a relayer API key and explicitly tells you the headers the bot needs.

#### Path B: Builder credentials

| Secret | Where to get it | Notes |
|---|---|---|
| `POLYMARKET_BUILDER_API_KEY` | Polymarket builder key flow or derivation script | Needed only if using builder auth instead of relayer API key. |
| `POLYMARKET_BUILDER_SECRET` | Builder credential secret | Must be the actual secret, not only key metadata. |
| `POLYMARKET_BUILDER_PASSPHRASE` | Builder credential passphrase | Must be the actual passphrase, not only key metadata. |

If the bot/script says `Builder API key derivation returned incomplete creds`, the account/API only returned metadata and you should use the relayer API key path instead.

### Required for Telegram control center

| Secret | Where to get it | Notes |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | BotFather in Telegram | Create a bot with `/newbot`. |
| `TELEGRAM_CHAT_ID` | Send `/id` to the bot | Only this chat can control the bot. |
| `TELEGRAM_COMMANDS_ENABLED` | Set to `true` | Enables buttons/commands. |

Optional Telegram safety/control secrets:

| Secret | Recommended value | Notes |
|---|---|---|
| `TELEGRAM_WALLET_CONTROLS_ENABLED` | `false` until you understand withdrawals | Do not enable withdrawals casually. |
| `TELEGRAM_WITHDRAW_ENABLED` | `false` unless intentionally using withdrawals | Keep disabled for first setup. |

### Required for Fly deployment and Telegram secret persistence

| Secret/env | Where to set | Notes |
|---|---|---|
| `TELEGRAM_FLY_SECRETS_ENABLED=true` | `fly.toml` or Fly env | Already added in `fly.toml`. |
| `TELEGRAM_FLY_APP_NAME=polyprophet` | `fly.toml` or Fly env | Already added in `fly.toml`. |
| `TELEGRAM_FLY_API_TOKEN` | Fly secret | Lets Telegram button flow attempt to save derived builder secrets to Fly. |
| `MANUAL_SMOKE_TEST_KEY` | Fly secret | Guards live-mutating HTTP endpoints. |

If Telegram says `Fly persistence: Not authorized to manage this app`, the token exists but Fly rejected it for secret mutation. Create/set a Fly token that has permission to manage the `polyprophet` app, or set secrets manually with `flyctl secrets set`.

## Starting from scratch: exact steps

### 1. Install prerequisites

Install:

- Node.js 20.x
- Git
- Fly CLI (`flyctl`)

Then in PowerShell from the repo folder:

```powershell
npm install
```

### 2. Create or choose a dedicated wallet

For safety, use a fresh wallet/account for the bot.

- Fund only what you are willing to risk.
- Keep the recovery phrase/private key offline.
- Do not reuse your main wallet if you plan to rotate and isolate funds.

### 3. Log into Polymarket with that wallet

On Polymarket:

1. Connect the wallet.
2. Go to **Settings > Profile**.
3. Copy the relevant Polymarket/proxy/funder address.
4. Do not expose the private key.

### 4. Create normal CLOB API credentials

The bot can often derive these from the private key.

Create a local `POLYPROPHET.env` file. Minimum local template:

```env
TRADE_MODE=LIVE
ENABLE_LIVE_TRADING=true
LIVE_AUTOTRADING_ENABLED=false
START_PAUSED=true

POLYMARKET_PRIVATE_KEY=0xYOUR_PRIVATE_KEY_HERE
POLYMARKET_ADDRESS=0xYOUR_POLYMARKET_PROXY_OR_FUNDER_ADDRESS
POLYMARKET_SIGNATURE_TYPE=1
POLYMARKET_AUTO_DERIVE_CREDS=true

TELEGRAM_BOT_TOKEN=YOUR_TELEGRAM_BOT_TOKEN
TELEGRAM_CHAT_ID=YOUR_TELEGRAM_CHAT_ID
TELEGRAM_COMMANDS_ENABLED=true

MANUAL_SMOKE_TEST_KEY=make-a-long-random-password
```

Then run:

```powershell
node scripts\generate-polymarket-builder-creds.js
```

The script prints a `flyctl secrets set POLYMARKET_API_KEY=... POLYMARKET_SECRET=... POLYMARKET_PASSPHRASE=...` command as soon as normal CLOB credentials are available. Run that command locally, but do not paste its output into chat or GitHub.

If it also prints a complete builder command, run that too. If it says builder credential creation did not return secret/passphrase values, that is OK; use the relayer key path below for redemption.

### 5. Create a Polymarket relayer API key

From your screenshots this is available at **Polymarket > Settings > Relayer API Keys**.

1. Click **Create New**.
2. Copy the generated API key once.
3. Copy the shown `RELAYER_API_KEY_ADDRESS`.
4. Set both into Fly as bot secrets.

PowerShell:

```powershell
flyctl secrets set POLYMARKET_RELAYER_API_KEY="PASTE_RELAYER_API_KEY_HERE" POLYMARKET_RELAYER_API_KEY_ADDRESS="PASTE_RELAYER_API_KEY_ADDRESS_HERE" --app polyprophet
```

### 6. Set all required Fly secrets

Run this from the repo folder, replacing placeholders:

```powershell
flyctl secrets set `
  POLYMARKET_PRIVATE_KEY="0xYOUR_PRIVATE_KEY_HERE" `
  POLYMARKET_ADDRESS="0xYOUR_POLYMARKET_PROXY_OR_FUNDER_ADDRESS" `
  POLYMARKET_SIGNATURE_TYPE="1" `
  POLYMARKET_API_KEY="YOUR_CLOB_API_KEY" `
  POLYMARKET_SECRET="YOUR_CLOB_SECRET" `
  POLYMARKET_PASSPHRASE="YOUR_CLOB_PASSPHRASE" `
  POLYMARKET_RELAYER_API_KEY="YOUR_RELAYER_API_KEY" `
  POLYMARKET_RELAYER_API_KEY_ADDRESS="YOUR_RELAYER_API_KEY_ADDRESS" `
  TELEGRAM_BOT_TOKEN="YOUR_TELEGRAM_BOT_TOKEN" `
  TELEGRAM_CHAT_ID="YOUR_TELEGRAM_CHAT_ID" `
  TELEGRAM_COMMANDS_ENABLED="true" `
  MANUAL_SMOKE_TEST_KEY="YOUR_LONG_RANDOM_ADMIN_KEY" `
  TELEGRAM_FLY_API_TOKEN="YOUR_FLY_TOKEN_WITH_APP_SECRET_PERMISSION" `
  --app polyprophet
```

### 7. Deploy

```powershell
flyctl deploy --app polyprophet --remote-only
```

### 8. Verify without trading

Keep the bot paused first.

```powershell
Invoke-RestMethod https://polyprophet.fly.dev/api/health
Invoke-RestMethod https://polyprophet.fly.dev/api/status
Invoke-RestMethod https://polyprophet.fly.dev/api/wallet/balance
```

In Telegram:

1. Send `/dashboard`.
2. Press `🗝 Fly Secrets`.
3. Press `🏁 Redeem Status`.
4. Press `🔐 Derive Redeem Auth`.
5. Press `♻️ Auto Redeem` only when you intentionally want to attempt queued redemption.

Expected healthy redemption state:

- `Auth ready: YES`
- `manualRequired=0` after successful clear
- `redemptionQueue=0` after queued wins clear
- `walletSettled=YES` or cash increased after redemption
- `Balance` increases from previously stuck cash

## Key rotation: exact steps

Use this when you want to rotate everything after moving funds to a new/separate account.

### 1. Pause first

In Telegram press pause or run:

```powershell
flyctl secrets set START_PAUSED="true" LIVE_AUTOTRADING_ENABLED="false" --app polyprophet
```

Deploy/restart if needed.

### 2. Move funds manually

On Polymarket/wallet:

1. Redeem or withdraw old funds if possible.
2. Move funds to the new dedicated account.
3. Confirm the old account has no funds you expect the bot to manage.

### 3. Revoke old keys

On Polymarket:

- Revoke/delete old Builder API keys.
- Revoke/delete old Relayer API keys.
- If you are abandoning the old wallet, stop using its private key entirely.

On Fly:

```powershell
flyctl secrets unset POLYMARKET_API_KEY POLYMARKET_SECRET POLYMARKET_PASSPHRASE POLYMARKET_BUILDER_API_KEY POLYMARKET_BUILDER_SECRET POLYMARKET_BUILDER_PASSPHRASE POLYMARKET_RELAYER_API_KEY POLYMARKET_RELAYER_API_KEY_ADDRESS --app polyprophet
```

### 4. Set new keys

Repeat the scratch setup with the new wallet/account:

- New `POLYMARKET_PRIVATE_KEY`
- New `POLYMARKET_ADDRESS`
- New normal CLOB keys
- New relayer API key and relayer address
- New Telegram bot token/chat ID only if you also rotate Telegram
- New Fly token only if you rotate Fly access

### 5. Deploy and verify while paused

```powershell
flyctl deploy --app polyprophet --remote-only
```

Then check:

```powershell
Invoke-RestMethod https://polyprophet.fly.dev/api/health
Invoke-RestMethod https://polyprophet.fly.dev/api/status
Invoke-RestMethod https://polyprophet.fly.dev/api/wallet/balance
```

Telegram checks:

- `/dashboard`
- `🗝 Fly Secrets`
- `🏁 Redeem Status`
- `🔐 Derive Redeem Auth`

Only resume trading after wallet cash, auth readiness, and queue state are correct.

## Why your current $10 redeem did not clear

Your Telegram output shows:

```text
Auth ready: YES
mode: builder
manualRequired=4
Redeemed: 0 failed=4 skipped=0 remaining=4
Balance: $0.44
```

That means the bot now sees redemption auth as configured, but the actual redemption submit still did not clear the four queued positions. The website **Auto-Redeem** toggle did not retroactively clear this bot's existing recovery/redemption queue.

The next patched Telegram `/auto_redeem` output will include safe `Last errors:` lines so you can see the exact non-secret relayer failure reason. If the reason is authorization/permission-related, use the relayer API key path from the Polymarket website and set `POLYMARKET_RELAYER_API_KEY` plus `POLYMARKET_RELAYER_API_KEY_ADDRESS`. If it says the transaction failed or no transaction ID was returned, manually redeem once on Polymarket, then re-run `Redeem Status` so the bot can zero-verify and clear stale queued items.

## What counts as 100% autonomous-ready

Do not call the bot fully autonomous until all of these are true on the live Fly host:

- `manualPause=true` while testing.
- `/api/wallet/balance` shows the expected wallet cash.
- Telegram `Redeem Status` shows `Auth ready: YES`.
- `redemptionQueue=0` or every queued item is zero-verified.
- A real queued winning position auto-redeems without manual website action.
- Cash increases after redemption.
- The bot state saves and still looks correct after restart.
- Only then consider turning `LIVE_AUTOTRADING_ENABLED=true` and resuming.
