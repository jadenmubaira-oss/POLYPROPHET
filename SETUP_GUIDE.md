# POLYPROPHET — Full Setup Guide (download → live operation)

This guide lets a brand-new user run their **own** copy of the bot on their **own** Polymarket
account, from zero. It is written for someone who has never deployed a bot before. Follow it top to
bottom. If you get stuck, see **Troubleshooting** at the end.

> **What this bot is.** POLYPROPHET is a Polymarket **near-close binary SNIPE** bot. It watches the
> 6 crypto up/down markets (BTC, ETH, SOL, XRP, DOGE, BNB) and, in the last seconds before a 15-minute
> or 1-hour market settles, it buys the side that has *already* moved decisively (a `z ≥ 3` confidence
> gate) at a high ask (≈ 0.95–0.99). Each win is small (~1–3% of the stake); losses are rare but, when
> they happen, large — so the whole design is about **almost never losing**.

> **Honest expectations (read this first — RULE ZERO).**
> - This is a **slow compounding** machine, not a get-rich-quick bot. From ~$10–$40 it makes single-digit
>   to low-double-digit fills/day, each ~1–3% of stake.
> - **+$100 profit is a multi-week path** (~3–8 weeks depending on bankroll and how many fills the market
>   offers). **$100 in 7 days is NOT possible** from a small bankroll — it would need ~45–60 fills/day and
>   the market only supplies ~3–14/day under the safe gate. Anyone promising faster is wrong.
> - The bot has been near-lossless **live**: on the original account the **15-minute** timeframe has
>   **never lost a live trade**; the only live loss ever was a single **1-hour** trade, which the current
>   gate (1h restricted to the last ~2 minutes) now blocks. "Near-lossless" is **not** "zero-risk":
>   reversals can still happen (see **Risks**).
> - You can lose money. Only trade what you can afford to lose.

---

## 1. What you need (prerequisites)

| Thing | Why | Cost |
|---|---|---|
| A computer with **Node.js 20+** | to run/build the bot | free |
| A **Fly.io** account (`flyctl` CLI) | hosts the bot 24/7 | ~$2–5/mo for a tiny VM |
| A **Polymarket** account + a **Polygon wallet** funded with **USDC** | the money the bot trades | your bankroll (start ~$10–$40) |
| A **Telegram** account | to control + watch the bot from your phone | free |
| ~30 minutes | one-time setup | — |

You must be somewhere Polymarket is usable (e.g. via the normal Polymarket app/site). Funds live on
**Polygon**; you control them with **your private key** — see **Money & self-custody**.

---

## 2. Get the code

**Option A — clone (recommended, lets you `git pull` updates):**
```
git clone <YOUR_GITHUB_REPO_URL> polyprophet
cd polyprophet
```
**Option B — download ZIP** from GitHub ("Code → Download ZIP"), unzip, and `cd` into the folder.

---

## 3. Install dependencies
```
npm ci
node --check server.js     # should print nothing and exit 0 = code is intact
```

---

## 4. Your Polymarket wallet + funds

The bot trades from a Polymarket **proxy wallet** that is controlled by an **EOA private key** you hold.

1. Create / use a Polymarket account and complete its wallet setup.
2. **Fund it with USDC on Polygon.** Start small (e.g. ~$10–$40). Deposits from another chain
   (e.g. Base) must **bridge to Polygon** before they show up — this can take a little while.
3. You will need three values:
   - `POLYMARKET_PRIVATE_KEY` — the private key of the EOA that signs orders (**secret — never share/commit**).
   - `POLYMARKET_ADDRESS` — your Polymarket funder/proxy address (the wallet that holds the pUSD).
   - `POLYMARKET_SIGNATURE_TYPE` — usually **`3`** for the Polymarket proxy ("deposit wallet") model.
     If your account uses a different model, set the type Polymarket documents for it.

> **Where do I get the private key?** From the wallet Polymarket created for you (export per Polymarket's
> instructions) or the wallet you connected. Treat this key like cash: anyone with it controls the money.

---

## 5. Your Telegram bot (control + screenshots)

1. In Telegram, message **@BotFather** → `/newbot` → follow prompts → copy the **bot token**
   (`TELEGRAM_BOT_TOKEN`).
2. Message your new bot once (say "hi"), then get your **chat id** (`TELEGRAM_CHAT_ID`): message
   **@userinfobot**, or open `https://api.telegram.org/bot<TOKEN>/getUpdates` and read `chat.id`.
3. Keep both — you'll set them as secrets in the next step.

---

## 6. Deploy to Fly.io

1. Install the CLI: https://fly.io/docs/flyctl/install/ , then `fly auth login`.
2. From the project folder, create your **own** app (pick a unique name):
   ```
   fly apps create my-polyprophet
   ```
3. Edit `fly.toml` and set `app = "my-polyprophet"` (and `primary_region` to a region you like, e.g. `lhr`/`iad`/`gru`).
4. Create the data volume (the bot stores its ledger/state here so it survives restarts):
   ```
   fly volumes create polyprophet_data --size 1 -a my-polyprophet -r <your_region>
   ```
5. **Set your secrets** (these are per-user and must NOT live in the repo). Minimum required:
   ```
   fly secrets set -a my-polyprophet `
     POLYMARKET_PRIVATE_KEY="0x...your_key..." `
     POLYMARKET_ADDRESS="0x...your_proxy..." `
     POLYMARKET_SIGNATURE_TYPE="3" `
     POLYMARKET_AUTO_DERIVE_CREDS="true" `
     TELEGRAM_BOT_TOKEN="123456:ABC..." `
     TELEGRAM_CHAT_ID="123456789" `
     AUTH_PASSWORD="pick-a-dashboard-password"
   ```
   (The many other tuning values — stake fraction, timeframes, gates — already have safe defaults in
   `fly.toml [env]`, so you do **not** need to set them to start.)
6. **Start in PAPER first** (no real money) to confirm everything works. In `fly.toml [env]` (or as a
   secret) set `SNIPE_PAPER_MODE = "true"` for the first run. Then deploy:
   ```
   fly deploy -a my-polyprophet --remote-only
   ```

---

## 7. Verify it's working

Replace `my-polyprophet` with your app name:
```
fly status -a my-polyprophet
curl https://my-polyprophet.fly.dev/api/health      # status: ok, mode, balance
curl https://my-polyprophet.fly.dev/api/status      # look for the "snipe" object
```
In `/api/status` the `snipe` object should show `enabled:true`, your `bankroll`, `stakeFraction`,
`maxConcurrent`, `allowedTimeframes:["15m","1h"]`, `minBankrollFloor`, and `settled/wins/losses`.
In Telegram, send **`/snipe`** — you should get the status card. Send **`/streamer`** for the
money-free screenshot view (see §9).

---

## 8. Go LIVE (only after paper looks correct)

Live trading needs the live gates ON. Set these (secrets or `fly.toml [env]`) and redeploy:
```
TRADE_MODE=LIVE
ENABLE_LIVE_TRADING=true
LIVE_AUTOTRADING_ENABLED=true
SNIPE_PAPER_MODE=false
```
Then in Telegram confirm: **`/snipe_live confirm`**. Verify `/api/status` shows `snipe.mode:LIVE`,
`paperMode:false`, and your real `bankroll`. The bot now places real CLOB orders when its gates pass.

**Key safe defaults already set** (you can leave these):
- `SNIPE_STAKE_FRACTION=0.85` with a **floor-aware guard** so a single loss leaves ≥ the floor.
- `SNIPE_MIN_BANKROLL=5.5` — the emergency floor; the bot refuses new entries below it.
- `SNIPE_MAX_CONCURRENT=2`, `TIMEFRAME_15M_ENABLED=true`, `TIMEFRAME_1H_ENABLED=true`, `TIMEFRAME_5M_ENABLED=false`.

---

## 9. Day-to-day operation (Telegram)

| Command / button | What it does |
|---|---|
| `/snipe` (🎯 Snipe Status) | full status incl. balance, stake, floor, W/L record, open/pending |
| `/streamer` (🎬 Streamer View) | **money-free** snapshot for screenshots/streaming — shows record + win-rate + open side, **hides balance / stake / P&L** |
| `/snipe_live confirm` / `/snipe_paper` | switch live ↔ paper |
| `/snipe_enable` / `/snipe_disable` | turn the strategy on/off |
| `/snipe_mute` / `/snipe_unmute` | silence/relisten to per-trade notifications |
| `/pause` / `/resume` | stop/resume all new entries |

- **Top up** any time by sending USDC to your Polymarket wallet — more bankroll = more $/fill (the clean
  way to go faster) without changing the per-trade risk.
- **Watch the floor:** keep ≳ $11 working so a single loss can never strand you below the floor.

---

## 10. Money & self-custody (you control the funds)

- The bot signs with **your** `POLYMARKET_PRIVATE_KEY`. **Whoever holds that key controls the money** —
  independent of this bot, of Fly, or of the Polymarket website. A site lock cannot freeze on-chain funds
  you can sign for.
- **Back up your key offline.** Copy your secrets to a USB/offline drive (and import the key into a
  personal wallet you control). That one key = full control of the funds forever.
- **Withdraw any time** via the Polymarket UI/app. (An optional in-bot Telegram `/withdraw` to a fixed
  address you own can be enabled with `TELEGRAM_WALLET_CONTROLS_ENABLED=true`,
  `TELEGRAM_WITHDRAW_ENABLED=true`, `TELEGRAM_WITHDRAW_TO_ADDRESS=0x...you`, `TELEGRAM_WITHDRAW_MAX_USDC=...`.)
- **NEVER** commit your private key or `POLYPROPHET.env`/secrets to GitHub. The repo's `.gitignore`
  already excludes secret/env/backup files — keep it that way.

---

## 11. Honest risks

- **Reversals.** A "near-certainty" move can still flip before settlement. The gate (`z≥3`, basis-point
  floors, ask caps, depth ≥ 5) makes this rare, but not impossible. 15-minute trades are small, so a
  rare 15m loss is a setback, not a bust. **1-hour** trades are larger — that is why 1h is restricted to
  the last ~2 minutes.
- **One big loss math.** At a 0.99 ask a win pays ~1% but a loss costs ~100% — so one loss ≈ 100 small
  wins. The floor-aware guard keeps a single loss survivable while your bankroll is above ~$11.
- **It will not hit $100 in a week** from a small bankroll. Plan in weeks.
- **Liquidity.** Above roughly a few-hundred-dollar bankroll, order size starts to be limited by how deep
  the order books are near close.

---

## 12. Troubleshooting

| Symptom | Fix |
|---|---|
| `/api/health` unreachable | `fly status -a <app>`; `fly logs -a <app>`; ensure the machine is started |
| `snipe.mode` is PAPER | set `SNIPE_PAPER_MODE=false` + `TRADE_MODE=LIVE`, redeploy, then `/snipe_live confirm` |
| `NO_FILL_AFTER_RETRIES` in `lastError` | **benign** — the order didn't fill (FOK) and was correctly skipped; not an error |
| No trades for a while | normal — fills only happen when a qualifying signal appears AND fills; it's volatility-driven |
| Telegram silent | check `TELEGRAM_BOT_TOKEN`/`TELEGRAM_CHAT_ID`; message the bot once so it has your chat |
| Balance looks stale | always trust `/api/status` (re-pull); the bot refreshes from the live wallet |

---

## 13. (Repo owner) keeping GitHub up to date

This working copy may be a ZIP download with no git remote. To publish/update:
```
git init                       # if not already a repo
git add -A
git commit -m "Update"          # secrets are gitignored
git branch -M main
git remote add origin <YOUR_GITHUB_REPO_URL>   # only the first time
git push -u origin main
```
> Before pushing, confirm no secrets are staged: `git status` should NOT list `POLYPROPHET.env`,
> `*.env.secrets`, `wallet.json`, or any backup folder. The `.gitignore` is set up to exclude them.

---

*Single source of truth for strategy/status is `README_v36.md`. Always re-pull `/api/status` for the
live balance — never trust a number written in a doc; it goes stale.*
