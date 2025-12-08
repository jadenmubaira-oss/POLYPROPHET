# 🔮 POLYPROPHET - Supreme Oracle Prediction Engine

> **AI-powered prediction bot for Polymarket 15-minute crypto markets**
> 
> Target: £10 → £1,000,000 through compounding wins

---

## 🎯 What Is This?

POLYPROPHET is a sophisticated trading bot that uses **8 machine learning models** to predict the direction of 15-minute cryptocurrency checkpoint markets on Polymarket. It monitors BTC, ETH, SOL, and XRP price movements and executes trades when high-confidence signals are detected.

### Mission Statement

The Prophet-Level mission is to achieve **£1,000,000 from £10** through strategic compounding on Polymarket's 15-minute crypto checkpoint markets. POLYPROPHET aims to be an **undisputed oracle** — capable of:

- **95%+ accuracy** on CONVICTION tier trades
- **Adaptive learning** that improves over every cycle
- **Robust failsafes** that protect capital in all scenarios
- **Seamless execution** of buy and sell orders in live trading

---

## 🚀 Quick Start

```powershell
# 1. Clone the repository
git clone https://github.com/YOUR_REPO/POLYPROPHET.git
cd POLYPROPHET-main

# 2. Install dependencies
npm install

# 3. Copy and configure environment
copy .env.example .env
# Edit .env with your settings

# 4. Start the server
npm start

# 5. Open dashboard
# http://localhost:3000
```

**Default Login**: admin / changeme (change in .env)

---

## 🧠 The 8-Model Ensemble

POLYPROPHET uses an ensemble of 8 specialized prediction models:

| Model | Focus | Weight Range |
|-------|-------|--------------|
| **Genesis Protocol** 🌅 | Early cycle momentum (first 3 mins) | 2-12% |
| **Physicist** 📊 | Kalman-filtered velocity and force | 10-20% |
| **Order Book** 📈 | Market microstructure analysis | 5-15% |
| **Historian** 📚 | Pattern matching from past cycles | 8-18% |
| **BTC Correlation** ₿ | Cross-asset momentum | 5-12% |
| **Macro (Fear & Greed)** 🌐 | Market sentiment overlay | 3-8% |
| **Funding Rates** 💰 | Perpetual futures sentiment | 3-10% |
| **Volume Analysis** 📉 | Volume anomaly detection | 5-12% |

Models are weighted adaptively based on recent performance. After 5+ trades, the system recalibrates weights every cycle.

---

## 🎮 5 Trading Modes

| Mode | Strategy | Risk | When Active |
|------|----------|------|-------------|
| **ORACLE** 🔮 | Hold to resolution at high confidence | Low | First 5 mins, 75%+ consensus |
| **ARBITRAGE** 📊 | Buy mispriced odds, sell when corrected | Medium | When edge > 15% |
| **SCALP** 🎯 | Buy under 20¢, exit at 2x | Medium | Any time, cheap entries |
| **UNCERTAINTY** 🌊 | Trade extreme odds reversion | Higher | Odds > 80% or < 20% |
| **MOMENTUM** 🚀 | Ride strong mid-cycle trends | Higher | After 5 mins, clear trend |

All modes can be **toggled on/off** and configured individually in the Settings modal.

---

## 🔮 Oracle Aggression System (NEW)

Control how frequently the Oracle mode triggers predictions with the **Aggression Slider**:

| Aggression | Description | Effect |
|------------|-------------|--------|
| **0%** (Conservative) | Only the highest-confidence signals | Base thresholds unchanged |
| **50%** (Balanced) | Moderate frequency | 15% threshold reduction |
| **100%** (Aggressive) | Maximum prediction frequency | 30% threshold reduction |

**Quality Protection**: Even at 100% aggression, the system maintains core quality gates — predictions are more frequent but still pass essential checks.

Access the slider in **Settings → Mode Configuration → 🔮 ORACLE**

---

## 📊 Dashboard Overview

| Metric | Description |
|--------|-------------|
| **Prediction** | UP or DOWN direction for each asset |
| **Confidence** | 0-100% certainty level |
| **Tier** | CONVICTION (high confidence) or ADVISORY |
| **Edge** | Calculated advantage over market odds |
| **Last 10** | Rolling window of recent prediction outcomes |
| **Win Rate** | Historical accuracy |
| **Checkpoint Price** | Cycle starting price (displayed in gold) |

---

## ⚙️ Configuration

### Environment Variables (.env)

```env
# Polymarket API Credentials (get from polymarket.com/api)
POLYMARKET_API_KEY=your-api-key
POLYMARKET_SECRET=your-secret
POLYMARKET_PASSPHRASE=your-passphrase
POLYMARKET_ADDRESS=0xYourWalletAddress
POLYMARKET_PRIVATE_KEY=0xYourPrivateKey

# Trading Mode
TRADE_MODE=PAPER  # or LIVE

# Balances
PAPER_BALANCE=1000
LIVE_BALANCE=1000  # Fallback when cache expires

# Risk
MAX_POSITION_SIZE=0.10  # 10% max per trade

# Authentication
AUTH_USERNAME=admin
AUTH_PASSWORD=changeme

# Persistence (optional but recommended)
REDIS_URL=redis://localhost:6379

# Proxy (optional, for CLOB client)
PROXY_URL=http://your-proxy:port
```

### Beginner Presets

Click one button to configure all modes:

| Preset | Oracle Confidence | Max Exposure | Description |
|--------|------------------|--------------|-------------|
| 🛡️ **Safe** | 92%+ | 20% | Conservative, fewer trades |
| ⚖️ **Balanced** | 85%+ | 30% | Default settings |
| 🔥 **Aggressive** | 70%+ | 50% | More trades, higher risk |

---

## 🛡️ Live Trading Failsafes

| Guard | Protection |
|-------|------------|
| **Order Fill Verification** | 3 retries over 6 seconds to confirm fills |
| **Sell Order Retry** | 5 retry attempts with 3-second delays |
| **Pending Sells Tracker** | Failed sells stored with full recovery info |
| **Smart Position Sizing** | Min $1.10, max 30% of bankroll |
| **Global Stop Loss** | Halts trading at 20% daily loss (resets daily) |
| **Late Cycle Guard** | Arb: 13min, Momentum: 12min cutoffs |
| **Stale Data Guard** | Requires data < 3 seconds old |
| **Chainlink Heartbeat** | Auto-reconnects if no data for 60 seconds |
| **Cycle Commitment Lock** | Prevents prediction flip-flopping |

---

## 🔄 Failed Sell Recovery

If a sell order fails after 5 retries, the position is saved with complete recovery information:

- **tokenId** - Polymarket position token identifier
- **conditionId** - Market condition identifier
- **marketSlug** - Human-readable market name
- **polygonscanUrl** - Direct link to view token on PolygonScan
- **ctfContract** - CTF token contract address (0x4D97DCd97eC945f40cF65F87097ACe5EA0476045)
- **usdcContract** - USDC contract address
- **redemptionInstructions** - Step-by-step manual recovery guide

View failed sells at `/api/pending-sells` or in the UI's Trading section.

---

## 🔧 API Endpoints

| Endpoint | Description |
|----------|-------------|
| `GET /api/state` | Current predictions, positions, trading data |
| `GET /api/trades` | Trade history and P/L |
| `GET /api/settings` | Current configuration |
| `POST /api/settings` | Update configuration |
| `GET /api/wallet` | Wallet balances (USDC, MATIC) |
| `POST /api/wallet/transfer` | Send USDC to external address |
| `GET /api/export?asset=BTC` | Download prediction history as CSV |
| `POST /api/reset-balance` | Reset paper balance and positions |
| `GET /api/pending-sells` | List failed sells with recovery info |
| `POST /api/manual-buy` | Manual buy: `{ asset, direction, size }` |
| `POST /api/manual-sell` | Manual sell: `{ positionId }` |
| `POST /api/retry-sell` | Retry failed sell: `{ tokenId, asset }` |
| `GET /api/redemption-queue` | Winning positions awaiting redemption |

---

## 📁 Project Structure

```
POLYPROPHET-main/
├── server.js          # Main application (4,900+ lines)
├── package.json       # Dependencies
├── .env               # Configuration (API keys, etc.)
├── .env.example       # Template for .env
└── README.md          # This file
```

---

## 🔧 Complete Reproduction Steps

To recreate this bot from scratch:

### 1. Initialize Project
```bash
mkdir POLYPROPHET && cd POLYPROPHET
npm init -y
```

### 2. Install Dependencies
```bash
npm install express ethers@5 ioredis @polymarket/clob-client axios https-proxy-agent ws dotenv basic-auth cors
```

### 3. Create server.js
The main file (~5,000+ lines) contains:
- Express server with basic auth
- WebSocket connection to Polymarket (Chainlink price feed)
- 8-model ensemble prediction engine
- TradeExecutor class for position management
- OpportunityDetector for multi-mode scanning
- SupremeBrain class for each asset (adaptive learning)
- All API endpoints and HTML dashboard

### 4. Create .env
Copy the environment variables section above and fill in your credentials.

### 5. Run
```bash
npm start
```

---

## 🧬 Complete System Architecture (For Recreation)

This section documents the entire bot architecture for anyone wanting to understand, audit, or recreate the system from scratch.

### Core Goal
**Turn £10 into £1,000,000** through strategic compounding on Polymarket's 15-minute crypto checkpoint markets. Only trade CONVICTION tier signals with 95%+ target accuracy.

### Data Flow
```
Chainlink WebSocket → priceHistory → SupremeBrain → Prediction → TradeExecutor → Polymarket CLOB
         ↓                               ↓
   checkpointPrices              8-Model Ensemble Voting
                                        ↓
                                 Confidence + Tier Assignment
                                        ↓
                                 Trade Decision (if passes thresholds)
```

### The 8 Prediction Models

| # | Model | Logic | Weight Range |
|---|-------|-------|--------------|
| 1 | **Genesis Protocol** | Early cycle momentum detection using Kalman-filtered force vs ATR | 2-12% |
| 2 | **Physicist** | Velocity/acceleration derivatives with fakeout detection | 10-20% |
| 3 | **Order Book** | Market odds velocity + orderflow imbalance + extreme reversion | 5-15% |
| 4 | **Historian** | DTW pattern matching against past cycles (Redis-persisted) | 8-18% |
| 5 | **BTC Correlation** | Cross-asset momentum (alts follow BTC) | 5-12% |
| 6 | **Macro** | Fear & Greed Index sentiment overlay | 3-8% |
| 7 | **Funding Rates** | Binance perpetual futures sentiment | 3-10% |
| 8 | **Volume Analysis** | Volume anomaly detection vs recent average | 5-12% |

### Adaptive Learning Loop
After each 15-minute cycle:
1. Evaluate outcome (was final price > or < checkpoint?)
2. Record each model's vote vs actual outcome
3. Recalculate weights: accurate models get higher weights (up to 2x), inaccurate get penalized (down to 0.2x)
4. Store pattern in Historian for future matching
5. Update regime awareness (TRENDING/CHOPPY/VOLATILE)

### Key Classes

| Class | Purpose |
|-------|---------|
| `TradeExecutor` | Position management, live/paper trading, balance caching, sell retry, pending sells recovery |
| `SupremeBrain` | Per-asset prediction engine with 8-model ensemble, Kalman filters, adaptive weights |
| `OpportunityDetector` | Multi-mode scanning (ORACLE/ARBITRAGE/SCALP/UNCERTAINTY/MOMENTUM) |
| `MathLib` | Technical analysis (ATR, derivatives, DTW, regime detection) |
| `KalmanFilter` | Noise reduction for price and derivative smoothing |

### Failsafe Mechanisms

| Failsafe | Implementation |
|----------|----------------|
| **Order Fill Verification** | 3 retries over 6s after placing order |
| **Sell Retry** | 5 attempts with 3s delays before marking as pendingSell |
| **Pending Sells Recovery** | Stores tokenId, conditionId, PolygonScan link, manual instructions |
| **Global Stop Loss** | Halts trading at 20% daily loss (resets each day) |
| **Balance Caching** | Caches last known balance, never shows $0 flash |
| **Chainlink Heartbeat** | 60s timeout triggers auto-reconnect |
| **Cycle Commitment Lock** | Once committed to a direction in first 5min, cannot flip |
| **Late Cycle Guard** | ARBITRAGE: 13min, MOMENTUM: 12min cutoffs |
| **Stale Data Guard** | Requires price data < 3s old for trading |

### API Credential Flow
```
Environment Variables (.env)
         ↓
CONFIG object (with .trim() sanitization)
         ↓
ClobClient initialization (4 params: URL, chainId, wallet, {key, secret, passphrase})
         ↓
Redis persistence (credentials masked, overwritten by env vars on load)
```

### UI Components
- **Dashboard** (`/`): 4 asset cards, positions panel, trade history, nav with Wallet/Settings/Guide/Recovery
- **Settings** (`/settings`): Mode toggles, parameter config, API credentials
- **Guide** (`/guide`): Comprehensive documentation of all 5 trading modes
- **Recovery Modal**: Failed sells with retry buttons and manual recovery instructions

### Environment Variables Reference

```env
# REQUIRED for Live Trading
POLYMARKET_API_KEY=xxx        # From polymarket.com/api
POLYMARKET_SECRET=xxx         # API secret
POLYMARKET_PASSPHRASE=xxx     # API passphrase
POLYMARKET_ADDRESS=0x...       # Your wallet address
POLYMARKET_PRIVATE_KEY=0x...   # Your wallet private key

# REQUIRED
TRADE_MODE=PAPER              # PAPER or LIVE
AUTH_USERNAME=admin           # Dashboard login
AUTH_PASSWORD=changeme        # Dashboard password

# OPTIONAL
PAPER_BALANCE=1000            # Starting paper balance
LIVE_BALANCE=1000             # Fallback balance for LIVE mode
MAX_POSITION_SIZE=0.10        # Max 10% per trade
REDIS_URL=redis://...         # For state persistence
PROXY_URL=http://...          # For cloud deployments (bypass Cloudflare)
```

### Prompt to Recreate This Bot

If feeding to an AI to recreate:

> Create a Node.js trading bot for Polymarket's 15-minute cryptocurrency checkpoint markets. The bot should:
>
> 1. Connect to Polymarket's Chainlink WebSocket for real-time BTC/ETH/SOL/XRP prices
> 2. Track checkpoint prices at :00/:15/:30/:45 minute boundaries
> 3. Implement an 8-model ensemble prediction engine (Genesis Protocol, Physicist, Order Book, Historian, BTC Correlation, Macro, Funding, Volume) with adaptive weights that learn from outcomes
> 4. Support 5 trading modes: ORACLE (hold to resolution), ARBITRAGE (mispricing), SCALP (cheap entry), UNCERTAINTY (reversion), MOMENTUM (mid-cycle trends)
> 5. Include TradeExecutor class with paper/live trading, sell retry logic with 5 attempts, pending sells recovery with full redemption info
> 6. Use Kalman filters for noise reduction, detect market regimes (trending/choppy/volatile)
> 7. Include cycle commitment lock to prevent prediction flip-flopping
> 8. Have a web dashboard with real-time updates, settings modal, wallet management, and recovery page
> 9. Support Redis for persistence with memory fallback
> 10. Use proxy agent for CLOB client (bypass Cloudflare), direct agent for RPC calls
> 11. Target 95%+ accuracy on CONVICTION tier trades for £10 to £1,000,000 compounding strategy


---

## 🚀 Deployment Guide

### Local Development

```bash
# Clone and setup
git clone https://github.com/YOUR_USERNAME/POLYPROPHET.git
cd POLYPROPHET-main

# Install dependencies
npm install

# Create .env file
copy .env.example .env
# Edit .env with your credentials

# Start development server
npm start
# or with nodemon for auto-reload:
npx nodemon server.js
```

Dashboard available at: `http://localhost:3000`

---

### Deploy to Render (Recommended)

[Render](https://render.com) provides free tier hosting with easy setup:

#### Step 1: Prepare Repository

1. Push your code to GitHub:
   ```bash
   git init
   git add .
   git commit -m "Initial commit"
   git remote add origin https://github.com/YOUR_USERNAME/POLYPROPHET.git
   git push -u origin main
   ```

2. Ensure `package.json` has start script:
   ```json
   {
     "scripts": {
       "start": "node server.js"
     }
   }
   ```

#### Step 2: Create Render Web Service

1. Go to [Render Dashboard](https://dashboard.render.com)
2. Click **New** → **Web Service**
3. Connect your GitHub repository
4. Configure:
   - **Name**: `polyprophet`
   - **Runtime**: Node
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`
   - **Instance Type**: Free (or paid for better performance)

#### Step 3: Configure Environment Variables

In Render dashboard → **Environment** tab, add:

| Variable | Value |
|----------|-------|
| `AUTH_USERNAME` | your-username |
| `AUTH_PASSWORD` | your-secure-password |
| `TRADE_MODE` | PAPER |
| `PAPER_BALANCE` | 1000 |
| `MAX_POSITION_SIZE` | 0.10 |
| `POLYMARKET_API_KEY` | your-api-key |
| `POLYMARKET_SECRET` | your-secret |
| `POLYMARKET_PASSPHRASE` | your-passphrase |
| `POLYMARKET_ADDRESS` | 0xYourAddress |
| `POLYMARKET_PRIVATE_KEY` | 0xYourKey |
| `PROXY_URL` | (see troubleshooting) |

#### Step 4: Add Redis (Optional but Recommended)

1. In Render, click **New** → **Redis**
2. Create free Redis instance
3. Copy the internal URL
4. Add to environment: `REDIS_URL=redis://...`

#### Step 5: Deploy

Click **Deploy** - Render will build and start your service.

Your bot will be live at: `https://polyprophet.onrender.com`

---

### Deploy to Heroku

```bash
# Login to Heroku
heroku login

# Create app
heroku create polyprophet

# Add Redis
heroku addons:create heroku-redis:hobby-dev

# Set environment variables
heroku config:set AUTH_USERNAME=admin
heroku config:set AUTH_PASSWORD=your-password
heroku config:set TRADE_MODE=PAPER
# ... add all other variables

# Deploy
git push heroku main
```

---

### Deploy to VPS (DigitalOcean, AWS, etc.)

```bash
# SSH into your server
ssh user@your-server

# Install Node.js 18+
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
sudo apt-get install -y nodejs

# Clone repository
git clone https://github.com/YOUR_USERNAME/POLYPROPHET.git
cd POLYPROPHET-main

# Install dependencies
npm install

# Create .env file
nano .env
# Paste your configuration

# Install PM2 for process management
sudo npm install -g pm2

# Start with PM2
pm2 start server.js --name polyprophet

# Auto-restart on reboot
pm2 startup
pm2 save

# View logs
pm2 logs polyprophet
```

---

## 🔧 Troubleshooting

### Common Issues

#### ❌ "Cloudflare 403 Error" on Render

**Problem**: Polymarket CLOB API blocks requests from cloud providers.

**Solution**: Use a proxy service:
```env
PROXY_URL=http://your-proxy-service:port
```

Options:
- [IPRoyal](https://iproyal.com/) - Residential proxies
- [Bright Data](https://brightdata.com/) - Enterprise proxies
- [Oxylabs](https://oxylabs.io/) - Datacenter proxies

#### ❌ "ethers timeout" or "Network Error"

**Problem**: RPC calls timing out on cloud platforms.

**Solution**: The bot already bypasses proxy for ethers.js calls. If issues persist:
1. Check Polygon RPC status at [Alchemy Status](https://status.alchemy.com/)
2. Try different RPC endpoints in server.js

#### ❌ "WebSocket connection failed"

**Problem**: Chainlink WebSocket not connecting.

**Solution**: 
1. Check internet connectivity
2. Bot auto-reconnects after 60 seconds of no data
3. Check logs for specific error messages

#### ❌ "Order placement failed"

**Problem**: Live trading orders not executing.

**Solutions**:
1. Verify API credentials are correct
2. Check wallet has USDC (for trading) and MATIC (for gas)
3. Minimum order size is $1.10
4. Check Polymarket API status

#### ❌ "Balance showing as 0"

**Problem**: Live balance not fetching correctly.

**Solutions**:
1. Verify `POLYMARKET_PRIVATE_KEY` is correct
2. Check wallet address matches private key
3. Bot caches last known balance - wait for refresh
4. Try `/api/wallet` endpoint to force refresh

#### ❌ "Redis connection error"

**Problem**: Redis not connecting (optional persistence).

**Solution**: 
- Bot works without Redis (uses memory)
- Check `REDIS_URL` format
- Verify Redis is running

#### ❌ "401 Unauthorized" on dashboard

**Problem**: Can't access the web interface.

**Solution**:
1. Check `AUTH_USERNAME` and `AUTH_PASSWORD` are set
2. Clear browser cache
3. Try incognito mode

#### ❌ "SyntaxError: Invalid or unexpected token" in Browser Console

**Problem**: Dashboard won't load, predictions don't appear, buttons unresponsive.

**Cause**: Template literal escape bug in JavaScript sent to browser. When Node.js processes template literals (backticks), `\n` becomes a physical newline, breaking JavaScript string syntax.

**Solution** (Fixed 2025-12-08):
In `server.js`, search for any `alert()` or string containing `\n` inside a template literal and change:
- `'\n\n'` → `'\\n\\n'` (double escape the backslash)

Example fix at line 3788:
```javascript
// WRONG: \n becomes physical newline
alert('❌ Error' + (flag ? '\n\nDetails' : ''));

// CORRECT: \\n sends literal \n to browser  
alert('❌ Error' + (flag ? '\\n\\nDetails' : ''));
```

### Performance Optimization

| Issue | Solution |
|-------|----------|
| Slow predictions | Reduce number of assets tracked |
| Memory issues | Add Redis for state persistence |
| High latency | Use paid Render/Heroku tier |
| Missed cycles | Ensure stable internet connection |

### Logs and Debugging

```bash
# View recent logs (local)
# All logs appear in terminal

# View logs on Render
# Dashboard → Logs tab

# View logs on Heroku
heroku logs --tail

# View logs with PM2
pm2 logs polyprophet --lines 100
```

### Getting Help

1. Check the `/guide` page in the dashboard
2. Review API at `/api/state` for current bot state
3. Export cycle data at `/api/export?asset=BTC`
4. Check pending sells at `/api/pending-sells`

---

## 📜 Recent Updates

- ✅ **Oracle Aggression Slider** - Control prediction frequency (0-100%)
- ✅ **UNCERTAINTY Mode UI** - Toggle on/off with configurable thresholds
- ✅ **MOMENTUM Mode UI** - Toggle on/off with configurable parameters
- ✅ **Chainlink Heartbeat** - Auto-reconnect after 60s of no data
- ✅ **Trade History Enhanced** - Shows amount spent for closed trades
- ✅ **Failed Sells Info** - Complete redemption data with PolygonScan links
- ✅ **Smart Position Sizing** - Min $1.10, max 30% bankroll
- ✅ **Pre-Cycle-End Exit** - Non-ORACLE positions close 30s before checkpoint
- ✅ **Global Stop Loss** - Halts trading at 20% daily loss (resets each day)
- ✅ **Daily P/L Reset** - Prevents permanent stop-loss triggering
- ✅ **Balance Fetching Optimized** - Multi-RPC parallel fetch with 5s timeout

---

## 🛠️ Tech Stack

- **Runtime**: Node.js 18+
- **Server**: Express.js with Basic Auth
- **WebSocket**: Real-time Polymarket data via Chainlink
- **Blockchain**: ethers.js v5 (Polygon/USDC)
- **Persistence**: Redis (optional), memory fallback
- **Trading**: @polymarket/clob-client

---

## ⚠️ Important Notes

1. **Paper Mode First** - Always test with `TRADE_MODE=PAPER` before going live
2. **Checkpoint Timing** - Predictions activate at 15-minute boundaries (:00, :15, :30, :45)
3. **USDC + MATIC Required** - For live trading, fund your wallet on Polygon network
4. **Learning Period** - The bot improves over time as it gathers more data
5. **Position Auto-Close** - All positions resolve at cycle end with binary outcome
6. **Chainlink-Only Data** - Price data comes exclusively from Chainlink oracle feed

---

## 🎲 The Goal

Turn **£10 into £1,000,000** through strategic compounding on Polymarket's 15-minute crypto markets.

The key is:
- Only trading **CONVICTION tier** signals
- Maintaining **95%+ accuracy** on high-confidence predictions
- Letting the bot learn and adapt over cycles
- Using the **Oracle Aggression Slider** to balance frequency vs. quality

---

*Built for the £10 to £1,000,000 mission* 🚀
