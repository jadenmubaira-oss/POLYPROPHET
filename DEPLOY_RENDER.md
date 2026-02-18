# Deploy POLYPROPHET on Render (GitHub First-Time)

This repo is configured for Render Blueprint deploys via `render.yaml`.

## Fastest path (recommended)

1. Push this repo to GitHub.
2. In Render, click **New +** -> **Blueprint**.
3. Connect your GitHub account/repo.
4. Select this repository and branch.
5. Click **Apply**.

Render will automatically use:

- Build command: `npm ci`
- Start command: `npm start`
- Health check: `/api/health`
- Node runtime: from `package.json` (`20.x`)
- Preconfigured env vars from `render.yaml`

## What is already preconfigured for first deploy

- `TRADE_MODE=PAPER` (safe default)
- `NO_AUTH=true` (dashboard opens without login)
- `START_PAUSED=false` (starts active in paper mode)
- TOP7 operator lock enabled:
  - `OPERATOR_STRATEGY_SET_ENFORCED=true`
  - `OPERATOR_PRIMARY_GATES_ENFORCED=true`
  - `OPERATOR_STRATEGY_SET_PATH=debug/strategy_set_top7_drop6.json`

## After deploy: quick verification

Open these endpoints on your Render URL:

1. `/api/health`
2. `/api/version`
3. `/api/state-public`
4. `/` (dashboard)

Expected:

- Service is running
- Dashboard loads
- TOP7 appears as enforced primary execution set

## Optional (only when you are ready)

### Enable Telegram alerts

Set in Render Environment tab:

- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_CHAT_ID`

### Enable LIVE mode (real money)

Set all required vars first:

- `ENABLE_LIVE_TRADING=true`
- `TRADE_MODE=LIVE`
- `REDIS_URL=<your redis url>`
- Polymarket credentials (`POLYMARKET_*`)

If `TRADE_MODE=LIVE` is set without required safety env vars, the app will downgrade to PAPER mode.

## Manual Web Service setup (if you do not use Blueprint)

If you create a standard Web Service instead of Blueprint, use:

- Build Command: `npm ci`
- Start Command: `npm start`
- Health Check Path: `/api/health`
- Environment: add the same vars listed in `render.yaml`
