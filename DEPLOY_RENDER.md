# Deploy POLYPROPHET on Render

This is the current live-lite deployment guide for a fresh machine and a different Polymarket account.

## Baseline

- Runtime: root `server.js`
- Workspace target 15m strategy: `strategies/strategy_set_15m_24h_ultra_tight.json`
- Current live host may still be on an older deploy. Treat `/api/health` and `/api/status` as the only live truth.
- Node: `20.x`
- Health endpoint: `/api/health`

## 1. Local prep

1. Clone the repo.
2. Install Node `20.x`.
3. Run:
   - `npm ci`
4. Copy `.env.example` to `.env` or `POLYPROPHET.env` for local testing.

## 2. Render deploy

### Blueprint path

1. Push the repo to GitHub.
2. In Render, click **New +** -> **Blueprint**.
3. Select the repository and branch.
4. Apply the blueprint from `render.yaml`.

Blueprint defaults are intentionally paper-safe. Before enabling live trading, override the envs below in the Render dashboard.
For unattended live trading, use a Render plan that does not sleep the service.

### Manual web service path

Use:

- Build command: `npm ci`
- Start command: `npm start`
- Health check path: `/api/health`
- Runtime: Node `20.x`

## 3. Required envs for a new live account

Set these explicitly for the current intended posture:

```env
TRADE_MODE=LIVE
ENABLE_LIVE_TRADING=1
LIVE_AUTOTRADING_ENABLED=true
TELEGRAM_SIGNALS_ONLY=false
START_PAUSED=true

TIMEFRAME_15M_ENABLED=true
TIMEFRAME_15M_MIN_BANKROLL=2
TIMEFRAME_5M_ENABLED=false
MULTIFRAME_4H_ENABLED=false
TIMEFRAME_4H_MIN_BANKROLL=10
TIMEFRAME_5M_MIN_BANKROLL=50

STRATEGY_SET_15M_PATH=strategies/strategy_set_15m_24h_ultra_tight.json

DEFAULT_MIN_ORDER_SHARES=5
REQUIRE_REAL_ORDERBOOK=true
ENTRY_PRICE_BUFFER_CENTS=0
ENFORCE_NET_EDGE_GATE=false
MAX_GLOBAL_TRADES_PER_CYCLE=3
OPERATOR_STAKE_FRACTION=0.15

POLYMARKET_PRIVATE_KEY=<new account signer private key>
POLYMARKET_SIGNATURE_TYPE=1
POLYMARKET_ADDRESS=<new account profile/proxy/funder address>

REDIS_URL=<recommended for live continuity>
PROXY_URL=<required if your Render region needs proxy-backed CLOB writes>
CLOB_FORCE_PROXY=1
```

## 4. Optional auth / redemption envs

If auto-derive is insufficient, add:

```env
POLYMARKET_API_KEY=
POLYMARKET_SECRET=
POLYMARKET_PASSPHRASE=
```

For proxy redemption readiness, add either:

```env
POLYMARKET_RELAYER_API_KEY=
POLYMARKET_RELAYER_API_KEY_ADDRESS=
```

or:

```env
POLYMARKET_BUILDER_API_KEY=
POLYMARKET_BUILDER_SECRET=
POLYMARKET_BUILDER_PASSPHRASE=
```

Optional notifications:

```env
TELEGRAM_BOT_TOKEN=
TELEGRAM_CHAT_ID=
```

## 5. Verification after deploy

Check these endpoints on the Render URL:

1. `/api/health`
2. `/api/status`
3. `/api/wallet/balance`
4. `/api/clob-status`
5. `/api/diagnostics`

Expected before unpausing:

- `mode: LIVE`
- `isLive: true`
- `strategySets["15m"].filePath` ends with `strategy_set_15m_24h_ultra_tight.json`
- `strategySets["15m"].strategies` is `48`
- 4h disabled, 5m disabled
- `walletLoaded: true`
- `tradeReady.ok: true`
- `proxyRedeemAuthReady: true`

## 6. Safe go-live sequence

1. Deploy with `START_PAUSED=true`.
2. Fund the new account with Polygon USDC.
3. Verify the endpoints above.
4. Run:
   - `npm run reverify:full`
5. Only then set `START_PAUSED=false` and redeploy or restart.

## 7. Important caveats

- The current 24-48h median-first posture is **not** a capital-preservation guarantee.
- `render.yaml` is a starting point, not the final live truth surface.
- Never trust docs or env screenshots alone; re-check the live runtime surfaces after every deploy.
- A deploy is **NO-GO** if the live runtime still reports `maxgrowth_v5`, `ENTRY_PRICE_BUFFER_CENTS=2`, or anything other than the exact intended env posture.
