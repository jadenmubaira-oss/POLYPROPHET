# 🔮 POLYPROPHET - Supreme Oracle Prediction Engine

> **AI-powered prediction bot for Polymarket 15-minute crypto markets**
> 
> Mission: £10 → £1,000,000 through compounding wins

---

## 📋 Table of Contents

1. [What Is This?](#-what-is-this)
2. [Prerequisites](#-prerequisites)
3. [Getting Your Polymarket API Credentials](#-getting-your-polymarket-api-credentials)
4. [Deployment Options](#-deployment-options)
   - [Option A: Local Deployment](#option-a-local-deployment-your-computer)
   - [Option B: Cloud Deployment via GitHub + Render (Manual)](#option-b-cloud-deployment-via-github--render-manual)
   - [Option C: Automated Cloud Deployment](#option-c-automated-cloud-deployment-script)
5. [Configuration Reference](#-configuration-reference)
6. [Dashboard Overview](#-dashboard-overview)
7. [The 8-Model Ensemble](#-the-8-model-ensemble)
8. [5 Trading Modes](#-5-trading-modes)
9. [Live Trading Failsafes](#-live-trading-failsafes)
10. [API Endpoints](#-api-endpoints)
11. [Troubleshooting](#-troubleshooting)
12. [Recent Updates](#-recent-updates)

---

## 🎯 What Is This?

POLYPROPHET is a sophisticated trading bot that uses **8 machine learning models** to predict the direction of 15-minute cryptocurrency checkpoint markets on Polymarket. It monitors BTC, ETH, SOL, and XRP price movements and executes trades when high-confidence signals are detected.

### Key Features

| Feature | Description |
|---------|-------------|
| **8-Model Ensemble** | Genesis Protocol, Physicist, Order Book, Historian, BTC Correlation, Macro, Funding, Volume |
| **5 Trading Modes** | ORACLE 🔮, ARBITRAGE 📊, SCALP 🎯, UNCERTAINTY 🌊, MOMENTUM 🚀 |
| **Adaptive Learning** | Model weights recalibrate after 5 trades based on accuracy |
| **Pattern Memory** | DTW pattern matching against past cycles (Redis-persisted) |
| **Anti-Whipsaw** | Cycle commitment lock prevents prediction flip-flopping |
| **Complete Failsafes** | Order retry, pending sells recovery, global stop loss |
| **Telegram Alerts** | Real-time notifications for trades and system events |
| **Web Dashboard** | Real-time predictions, positions, trade history |

---

## 📋 Prerequisites

Before you begin, you'll need:

1. **Node.js 18+** - Download from [nodejs.org](https://nodejs.org/)
2. **A Polymarket Account** - Go to [polymarket.com](https://polymarket.com)
3. **A Crypto Wallet** - Trust Wallet, MetaMask, or any Ethereum wallet
4. **USDC on Polygon** - For live trading (minimum $5-10 to start)
5. **MATIC/POL on Polygon** - For gas fees (minimum 0.1 MATIC)
6. **Git** - Download from [git-scm.com](https://git-scm.com/)
7. **(Optional) A Proxy Service** - Required for UK/blocked regions

---

## 🔑 Getting Your Polymarket API Credentials

This is the most important step. You need 5 credentials:
- `POLYMARKET_PRIVATE_KEY`
- `POLYMARKET_API_KEY`
- `POLYMARKET_SECRET`
- `POLYMARKET_PASSPHRASE`
- `POLYMARKET_ADDRESS`

### Step 1: Get Your Private Key

Your private key is the secret that controls your wallet. **NEVER SHARE IT!**

#### From Trust Wallet:
1. Open Trust Wallet app
2. Tap the Settings icon (⚙️)
3. Go to **Wallets** → Select your wallet
4. Tap **Show Secret Phrase** or **Export Private Key**
5. Enter your passcode
6. Copy the private key (starts with `0x`)

#### From MetaMask:
1. Click the three dots menu (⋮) next to your account
2. Click **Account Details**
3. Click **Show Private Key**
4. Enter your password
5. Copy the private key (add `0x` prefix if missing)

### Step 2: Get Your Wallet Address

This is your PUBLIC address (safe to share):
- In Trust Wallet: Tap on any coin → Copy address
- In MetaMask: Click your account name at the top → Copy

It looks like: `0x1234...abcd`

### Step 3: Generate API Credentials

The bot includes a script to generate your API credentials by signing a message with your wallet.

#### On Windows (PowerShell):
```powershell
# Navigate to the project folder
cd C:\path\to\POLYPROPHET-main

# Install dependencies first
npm install

# Generate credentials (replace with YOUR private key)
node generate_creds.js 0xYOUR_PRIVATE_KEY_HERE
```

#### On Mac/Linux:
```bash
cd /path/to/POLYPROPHET-main
npm install
node generate_creds.js 0xYOUR_PRIVATE_KEY_HERE
```

#### Expected Output:
```
🔄 Initializing Wallet and CLOB Client...
✅ Wallet Address: 0xYourAddress
⚠️  VERIFY this matches your Trust Wallet address!
🔐 Deriving API Credentials (signing message)...

✅ SUCCESS! Here are your NEW credentials:
=====================================================
POLYMARKET_PRIVATE_KEY=0x...
POLYMARKET_API_KEY=019xxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
POLYMARKET_SECRET=xxxxxxxxxxxxxxxxxxxxxxxx==
POLYMARKET_PASSPHRASE=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
=====================================================
```

**⚠️ IMPORTANT**: 
- Verify the wallet address matches your actual wallet
- Save these credentials securely - you'll need them for deployment
- If you see a `403 error`, you need a proxy (see [Troubleshooting](#-troubleshooting))

### Step 4: Save Your Credentials

Create a `.env` file with your credentials:

```env
# REQUIRED: Polymarket API Credentials
POLYMARKET_PRIVATE_KEY=0xYourPrivateKeyHere
POLYMARKET_API_KEY=019xxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
POLYMARKET_SECRET=YourSecretHere==
POLYMARKET_PASSPHRASE=YourPassphraseHere
POLYMARKET_ADDRESS=0xYourWalletAddress

# Trading Configuration
TRADE_MODE=PAPER
PAPER_BALANCE=1000
MAX_POSITION_SIZE=0.10

# Dashboard Login
AUTH_USERNAME=admin
AUTH_PASSWORD=YourSecurePassword123

# Optional: Persistence (highly recommended)
REDIS_URL=redis://your-redis-url

# Optional: Telegram Notifications
TELEGRAM_BOT_TOKEN=
TELEGRAM_CHAT_ID=

# Optional: Proxy for UK/blocked regions
PROXY_URL=http://user:pass@proxy.com:port
```

---

## 🚀 Deployment Options

### Option A: Local Deployment (Your Computer)

Best for: Testing, development, learning how the bot works.

#### Step 1: Download the Code

```powershell
# Clone the repository
git clone https://github.com/YOUR_USERNAME/POLYPROPHET.git
cd POLYPROPHET-main

# Or if you downloaded a ZIP, extract it and navigate there
cd C:\Users\YourName\Downloads\POLYPROPHET-main
```

#### Step 2: Install Dependencies

```powershell
npm install
```

Expected output:
```
added 150 packages in 15s
```

#### Step 3: Create .env File

```powershell
# Windows
copy .env.example .env
notepad .env

# Mac/Linux
cp .env.example .env
nano .env
```

Fill in your credentials from [Getting Your Polymarket API Credentials](#-getting-your-polymarket-api-credentials).

#### Step 4: Start the Bot

```powershell
npm start
```

Expected output:
```
✅ GLOBAL PROXY ACTIVE: ALL HTTPS via http://***:***@...
✅ Redis Connected - Persistence Enabled
🔑 Loading wallet from key: 0x0a9e6f...
✅ Wallet Loaded: 0xcd03c2a5...
💰 Trade Executor Initialized in PAPER mode. Balance: $1000
📚 Historian Storage Initialized
💾 State Restored from Redis
🔌 Attempting WebSocket connection to Polymarket...
✅ Connected to Polymarket WS
📡 Subscribed to crypto_prices_chainlink
⚡ SUPREME DEITY SERVER ONLINE on port 3000
🌐 Access at: http://localhost:3000
```

#### Step 5: Access the Dashboard

Open your browser and go to: **http://localhost:3000**

Login with your `AUTH_USERNAME` and `AUTH_PASSWORD`.

#### Keeping It Running (Optional)

To keep the bot running after closing your terminal:

```powershell
# Install PM2 globally
npm install -g pm2

# Start with PM2
pm2 start server.js --name polyprophet

# Make it restart on system reboot
pm2 startup
pm2 save

# View logs
pm2 logs polyprophet

# Stop the bot
pm2 stop polyprophet
```

---

### Option B: Cloud Deployment via GitHub + Render (Manual)

Best for: 24/7 operation, production use. **Recommended for live trading.**

#### Prerequisites for Cloud Deployment

1. **GitHub Account** - Free at [github.com](https://github.com)
2. **Render Account** - Free at [render.com](https://render.com)

#### Step 1: Create GitHub Repository

1. Go to [github.com/new](https://github.com/new)
2. Repository name: `polyprophet` (or any name)
3. Keep it **Private** for security
4. Click **Create repository**

#### Step 2: Push Code to GitHub

```powershell
# Navigate to your project
cd C:\path\to\POLYPROPHET-main

# Initialize git
git init

# Add all files
git add .

# Commit
git commit -m "Initial commit - POLYPROPHET bot"

# Connect to your GitHub repo (replace URL)
git remote add origin https://github.com/YOUR_USERNAME/polyprophet.git

# Push to GitHub
git branch -M main
git push -u origin main
```

If asked for credentials:
- Username: Your GitHub username
- Password: Use a [Personal Access Token](https://github.com/settings/tokens) (not your password!)

#### Step 3: Create Render Web Service

1. Go to [dashboard.render.com](https://dashboard.render.com)
2. Click **New** → **Web Service**
3. Connect your GitHub account if not already connected
4. Select your `polyprophet` repository
5. Configure:
   - **Name**: `polyprophet`
   - **Region**: Choose closest to you
   - **Branch**: `main`
   - **Runtime**: `Node`
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`
   - **Instance Type**: **Starter ($7/month)** - Recommended for 24/7 operation
     - Free tier works but sleeps after 15 minutes of inactivity

#### Step 4: Add Redis for Persistence

**This is critical for 24/7 operation!** Without Redis, the bot loses all learning data on restart.

1. In Render dashboard, click **New** → **Redis**
2. Configure:
   - **Name**: `polyprophet-redis`
   - **Instance Type**: **Free** (25MB) or **Starter** ($10/month for 100MB)
3. Wait for creation (takes 1-2 minutes)
4. Copy the **Internal URL** (looks like `redis://red-xxxxx:6379`)

#### Step 5: Set Environment Variables on Render

In your Web Service dashboard, go to **Environment** tab and add:

| Variable | Value |
|----------|-------|
| `AUTH_USERNAME` | Your dashboard login username |
| `AUTH_PASSWORD` | Your secure dashboard password |
| `TRADE_MODE` | `PAPER` (or `LIVE` for real trading) |
| `PAPER_BALANCE` | `1000` |
| `MAX_POSITION_SIZE` | `0.10` |
| `POLYMARKET_API_KEY` | From generate_creds.js output |
| `POLYMARKET_SECRET` | From generate_creds.js output |
| `POLYMARKET_PASSPHRASE` | From generate_creds.js output |
| `POLYMARKET_ADDRESS` | Your wallet address |
| `POLYMARKET_PRIVATE_KEY` | Your wallet private key |
| `REDIS_URL` | Redis internal URL from Step 4 |
| `PROXY_URL` | (Optional) Your proxy if in UK |

**⚠️ Security Note**: Render encrypts environment variables. They are never exposed in logs.

#### Step 6: Deploy

1. Click **Manual Deploy** → **Deploy latest commit**
2. Wait for build to complete (2-5 minutes)
3. Once "Live", click the URL (e.g., `https://polyprophet.onrender.com`)
4. Login with your AUTH_USERNAME and AUTH_PASSWORD

#### Step 7: Keep Awake (Free Tier Only)

If using free tier, Render sleeps your app after 15 minutes of inactivity.

1. Go to [uptimerobot.com](https://uptimerobot.com) (free)
2. Create account and add a new monitor:
   - **Monitor Type**: HTTP(s)
   - **Friendly Name**: POLYPROPHET
   - **URL**: `https://polyprophet.onrender.com/api/state`
   - **Monitoring Interval**: 5 minutes
3. This pings your app every 5 minutes to prevent sleep

---

### Option C: Automated Cloud Deployment (Script)

For users who want a one-click deployment experience.

#### Create Deploy Script

Save this as `deploy.ps1` (Windows) or `deploy.sh` (Mac/Linux):

**Windows (deploy.ps1):**
```powershell
# POLYPROPHET Auto-Deploy Script
# Run: .\deploy.ps1

$ErrorActionPreference = "Stop"

Write-Host "🚀 POLYPROPHET Auto-Deploy Script" -ForegroundColor Cyan
Write-Host "=================================" -ForegroundColor Cyan

# Check prerequisites
Write-Host "`n📋 Checking prerequisites..." -ForegroundColor Yellow

# Check Node.js
$nodeVersion = node --version 2>$null
if (-not $nodeVersion) {
    Write-Host "❌ Node.js not found! Download from https://nodejs.org" -ForegroundColor Red
    exit 1
}
Write-Host "✅ Node.js: $nodeVersion" -ForegroundColor Green

# Check Git
$gitVersion = git --version 2>$null
if (-not $gitVersion) {
    Write-Host "❌ Git not found! Download from https://git-scm.com" -ForegroundColor Red
    exit 1
}
Write-Host "✅ Git: $gitVersion" -ForegroundColor Green

# Install dependencies
Write-Host "`n📦 Installing dependencies..." -ForegroundColor Yellow
npm install
if ($LASTEXITCODE -ne 0) { exit 1 }
Write-Host "✅ Dependencies installed" -ForegroundColor Green

# Check for .env file
if (Test-Path ".env") {
    Write-Host "✅ .env file found" -ForegroundColor Green
} else {
    Write-Host "⚠️ No .env file found. Creating from template..." -ForegroundColor Yellow
    if (Test-Path ".env.example") {
        Copy-Item ".env.example" ".env"
        Write-Host "📝 Please edit .env with your credentials before continuing" -ForegroundColor Cyan
        notepad .env
        Read-Host "Press Enter after saving .env"
    } else {
        Write-Host "❌ No .env.example found. Please create .env manually" -ForegroundColor Red
        exit 1
    }
}

# Syntax check
Write-Host "`n🔍 Running syntax check..." -ForegroundColor Yellow
node --check server.js
if ($LASTEXITCODE -ne 0) {
    Write-Host "❌ Syntax error in server.js" -ForegroundColor Red
    exit 1
}
Write-Host "✅ Syntax check passed" -ForegroundColor Green

# Ask for deployment type
Write-Host "`n📍 Where do you want to deploy?" -ForegroundColor Yellow
Write-Host "1. Local (this computer)"
Write-Host "2. GitHub + Render (cloud)"
$choice = Read-Host "Enter choice (1 or 2)"

if ($choice -eq "1") {
    # Local deployment
    Write-Host "`n🖥️ Starting local server..." -ForegroundColor Cyan
    npm start
} elseif ($choice -eq "2") {
    # GitHub deployment
    Write-Host "`n☁️ Preparing for GitHub deployment..." -ForegroundColor Cyan
    
    $repoUrl = Read-Host "Enter your GitHub repo URL (e.g., https://github.com/user/repo.git)"
    
    git init 2>$null
    git add .
    git commit -m "Deploy POLYPROPHET $(Get-Date -Format 'yyyy-MM-dd HH:mm')"
    git remote remove origin 2>$null
    git remote add origin $repoUrl
    git branch -M main
    git push -u origin main --force
    
    Write-Host "`n✅ Code pushed to GitHub!" -ForegroundColor Green
    Write-Host "📋 Next steps:" -ForegroundColor Cyan
    Write-Host "   1. Go to https://dashboard.render.com" -ForegroundColor White
    Write-Host "   2. Click 'New' → 'Web Service'" -ForegroundColor White
    Write-Host "   3. Connect your repo: $repoUrl" -ForegroundColor White
    Write-Host "   4. Add environment variables from your .env" -ForegroundColor White
    Write-Host "   5. Deploy!" -ForegroundColor White
} else {
    Write-Host "❌ Invalid choice" -ForegroundColor Red
    exit 1
}
```

**Mac/Linux (deploy.sh):**
```bash
#!/bin/bash

echo "🚀 POLYPROPHET Auto-Deploy Script"
echo "================================="

# Check Node.js
if ! command -v node &> /dev/null; then
    echo "❌ Node.js not found! Install from https://nodejs.org"
    exit 1
fi
echo "✅ Node.js: $(node --version)"

# Check Git
if ! command -v git &> /dev/null; then
    echo "❌ Git not found! Install from https://git-scm.com"
    exit 1
fi
echo "✅ Git: $(git --version)"

# Install dependencies
echo "📦 Installing dependencies..."
npm install || exit 1
echo "✅ Dependencies installed"

# Check .env
if [ -f ".env" ]; then
    echo "✅ .env file found"
else
    echo "⚠️ No .env file. Creating from template..."
    cp .env.example .env 2>/dev/null || touch .env
    echo "📝 Please edit .env with your credentials"
    nano .env
fi

# Syntax check
echo "🔍 Running syntax check..."
node --check server.js || { echo "❌ Syntax error"; exit 1; }
echo "✅ Syntax check passed"

# Deploy options
echo ""
echo "📍 Where do you want to deploy?"
echo "1. Local (this computer)"
echo "2. GitHub + Render (cloud)"
read -p "Enter choice (1 or 2): " choice

if [ "$choice" == "1" ]; then
    echo "🖥️ Starting local server..."
    npm start
elif [ "$choice" == "2" ]; then
    read -p "Enter your GitHub repo URL: " repoUrl
    git init
    git add .
    git commit -m "Deploy POLYPROPHET $(date '+%Y-%m-%d %H:%M')"
    git remote remove origin 2>/dev/null
    git remote add origin "$repoUrl"
    git branch -M main
    git push -u origin main --force
    echo "✅ Pushed to GitHub! Now deploy on Render."
else
    echo "❌ Invalid choice"
    exit 1
fi
```

#### Run the Script

```powershell
# Windows
.\deploy.ps1

# Mac/Linux
chmod +x deploy.sh
./deploy.sh
```

---

## ⚙️ Configuration Reference

### All Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `POLYMARKET_PRIVATE_KEY` | ✅ Live | - | Your wallet private key (starts with 0x) |
| `POLYMARKET_API_KEY` | ✅ Live | - | Generated by generate_creds.js |
| `POLYMARKET_SECRET` | ✅ Live | - | Generated by generate_creds.js |
| `POLYMARKET_PASSPHRASE` | ✅ Live | - | Generated by generate_creds.js |
| `POLYMARKET_ADDRESS` | ✅ Live | - | Your wallet address |
| `TRADE_MODE` | ✅ | `PAPER` | `PAPER` (simulated) or `LIVE` (real money) |
| `PAPER_BALANCE` | ✅ Paper | `1000` | Starting paper balance in USD |
| `MAX_POSITION_SIZE` | ❌ | `0.10` | Max fraction per trade (0.10 = 10%) |
| `AUTH_USERNAME` | ✅ | `admin` | Dashboard login username |
| `AUTH_PASSWORD` | ✅ | `changeme` | Dashboard login password |
| `REDIS_URL` | ❌ | - | Redis connection URL for persistence |
| `PROXY_URL` | ❌ | - | HTTP proxy for UK/blocked regions |
| `PORT` | ❌ | `3000` | Server port |
| `TELEGRAM_BOT_TOKEN` | ❌ | - | Telegram bot token from @BotFather |
| `TELEGRAM_CHAT_ID` | ❌ | - | Your Telegram chat ID from @userinfobot |

### Telegram Setup (Optional)

1. Open Telegram, search for **@BotFather**
2. Send `/newbot` and follow prompts
3. Copy the bot token (looks like `123456789:ABC-xyz...`)
4. Search for **@userinfobot**, start it, and get your Chat ID
5. Add both to your .env or Render environment variables

---

## 📊 Dashboard Overview

| Section | What It Shows |
|---------|---------------|
| **Prediction Cards** | Direction (UP/DOWN), Confidence %, Tier, Edge |
| **Buy Buttons** | Manual buy UP/DOWN for each asset |
| **Active Positions** | Current open trades with sell buttons |
| **Trade History** | Past trades with P/L |
| **Balance** | Paper balance, Live USDC, Daily P/L, Win/Loss ratio |

### Understanding Predictions

| Metric | Meaning |
|--------|---------|
| **UP/DOWN** | Predicted direction when checkpoint resolves |
| **Confidence** | 0-100% certainty level |
| **CONVICTION** | High confidence (trade automatically) |
| **ADVISORY** | Medium confidence (informational) |
| **Edge** | Your advantage over market odds (higher = better) |

---

## 🧠 The 8-Model Ensemble

| Model | What It Analyzes | Weight Adaptation |
|-------|------------------|-------------------|
| **Genesis Protocol** 🌅 | Early cycle momentum (first 3 mins) | Boosted early, reduced late |
| **Physicist** 📊 | Kalman-filtered velocity and acceleration | Based on recent accuracy |
| **Order Book** 📈 | Market odds velocity, orderflow imbalance | Based on recent accuracy |
| **Historian** 📚 | Pattern matching against past cycles | Based on pattern win rate |
| **BTC Correlation** ₿ | Cross-asset momentum (alts follow BTC) | Based on recent accuracy |
| **Macro** 🌐 | Fear & Greed Index sentiment | Based on recent accuracy |
| **Funding Rates** 💰 | Binance perpetual futures sentiment | Based on recent accuracy |
| **Volume** 📉 | Volume anomaly detection | Reduced early, boosted late |

---

## 🎮 5 Trading Modes

| Mode | Strategy | When Active | Risk Level |
|------|----------|-------------|------------|
| **ORACLE** 🔮 | Hold to binary resolution | First 5 mins, 70%+ consensus | Low |
| **ARBITRAGE** 📊 | Buy mispriced odds, sell when corrected | When edge > 15% | Medium |
| **SCALP** 🎯 | Buy under 20¢, exit at 2x | Any time, cheap entries | Medium |
| **UNCERTAINTY** 🌊 | Bet on extreme odds reverting to 50/50 | Odds > 80% or < 20% | Higher |
| **MOMENTUM** 🚀 | Ride strong mid-cycle trends | After 5 mins, clear breakout | Higher |

All modes can be toggled on/off in Settings → Mode Configuration.

### Oracle Aggression Slider

Control trade frequency via the aggression slider (0-100%):
- **0%**: Conservative - Only highest confidence signals
- **50%**: Balanced - Default settings
- **100%**: Aggressive - Maximum prediction frequency

---

## 🛡️ Live Trading Failsafes

| Protection | What It Does |
|------------|--------------|
| **Order Fill Verification** | 3 retries over 6 seconds to confirm fills |
| **Sell Order Retry** | 5 attempts with 3-second delays |
| **Pending Sells Tracker** | Failed sells stored with recovery info (tokenId, PolygonScan link) |
| **Smart Position Sizing** | Min $1.10, max 30% of bankroll |
| **Global Stop Loss** | Halts at 20% daily loss (resets each day, overridable) |
| **Cycle Commitment Lock** | Once committed, no flip-flopping |
| **Stale Data Guard** | Requires price data < 3 seconds old |
| **Chainlink Heartbeat** | Auto-reconnects after 60s of no data |
| **Pre-Resolution Exit** | Non-ORACLE closes 30s before checkpoint |

---

## 🔧 API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/state` | GET | Current predictions, positions, trading data |
| `/api/trades` | GET | Trade history and P/L |
| `/api/settings` | GET/POST | View/update configuration |
| `/api/wallet` | GET | Wallet balances (USDC, MATIC) |
| `/api/wallet/transfer` | POST | Send USDC: `{ to, amount }` |
| `/api/manual-buy` | POST | Buy: `{ asset, direction, size }` |
| `/api/manual-sell` | POST | Sell: `{ positionId }` |
| `/api/pending-sells` | GET | Failed sells with recovery info |
| `/api/export?asset=BTC` | GET | Download prediction history as CSV |
| `/api/reset-balance` | POST | Reset paper balance |
| `/api/toggle-stop-loss-override` | POST | Resume trading after stop loss |

---

## 🔧 Troubleshooting

### ❌ "403 Forbidden" or "Cloudflare Error"

**Problem**: Polymarket blocks requests from certain IPs (cloud providers, UK, etc.)

**Solution**: Use a proxy service:

1. Sign up at [IPRoyal](https://iproyal.com/), [Bright Data](https://brightdata.com/), or [Oxylabs](https://oxylabs.io/)
2. Get a residential proxy (datacenter proxies often blocked)
3. Add to your environment:
   ```env
   PROXY_URL=http://username:password@proxy.example.com:port
   ```

### ❌ "Cannot read property of undefined" in Dashboard

**Problem**: Data not loading, predictions blank.

**Solution**: 
1. Check browser console for errors (F12 → Console)
2. Verify WebSocket is connected (look for "Connected to Polymarket WS" in server logs)
3. Wait 60 seconds for Chainlink data to flow

### ❌ "Balance showing as $0"

**Problem**: Live balance not fetching.

**Solution**:
1. Verify `POLYMARKET_PRIVATE_KEY` is correct
2. Check wallet address matches your private key
3. Ensure you have USDC on Polygon network
4. Try `/api/wallet` endpoint to force refresh

### ❌ "Order placement failed"

**Problem**: Live trades not executing.

**Solutions**:
1. Verify all API credentials are correct
2. Check wallet has USDC (for trading) and MATIC (for gas)
3. Minimum order size is $1.10
4. Check if you're in a blocked region (need proxy)

### ❌ "WebSocket connection failed"

**Problem**: No price data coming through.

**Solution**:
1. Check internet connectivity
2. Bot auto-reconnects after 60 seconds
3. Look for "CHAINLINK TIMEOUT" in logs

### ❌ Redis Connection Error

**Problem**: "Redis connection failed" message.

**Solution**:
- Bot works fine without Redis (uses memory)
- For persistence, verify `REDIS_URL` format
- On Render, use the Internal URL, not External

### ❌ "401 Unauthorized" on Dashboard

**Problem**: Can't login to web interface.

**Solution**:
1. Verify `AUTH_USERNAME` and `AUTH_PASSWORD` are set
2. Try incognito mode (clears cached credentials)
3. Check Render/environment variables are saved

### ❌ Generate Credentials Fails with 403

**Problem**: `generate_creds.js` shows 403 error.

**Solution**:
1. The script needs a proxy for UK users
2. Edit line 10 of `generate_creds.js` with your proxy
3. Or run from a non-blocked location (VPN, different country)

---

## 📜 Recent Updates

- ✅ **Telegram Notifications** - Trade alerts, stop loss events, server status
- ✅ **ORACLE Stop Loss UI** - Optional emergency stop loss for ORACLE trades
- ✅ **Oracle Aggression Slider** - Control prediction frequency (0-100%)
- ✅ **Complete Recovery System** - Failed sells with tokenId, PolygonScan links
- ✅ **Chainlink Heartbeat** - 60s timeout with auto-reconnect
- ✅ **Daily P/L Reset** - Global stop loss resets each day
- ✅ **Balance Never $0** - Caches last known balance

---

## 🛠️ Tech Stack

| Component | Technology | Purpose |
|-----------|------------|---------|
| **Runtime** | Node.js 18+ | Server-side JavaScript |
| **Server** | Express.js | HTTP API and dashboard |
| **Authentication** | basic-auth | Dashboard login protection |
| **WebSocket** | ws | Real-time Polymarket Chainlink feed |
| **Blockchain** | ethers.js v5 | Polygon wallet operations |
| **Trading** | @polymarket/clob-client | Order placement/management |
| **Persistence** | ioredis | Redis state storage |
| **Proxy** | https-proxy-agent | Bypass Cloudflare blocks |
| **HTTP Client** | axios | External API requests |
| **Environment** | dotenv | Configuration management |
| **CORS** | cors | Cross-origin requests |

---

## 🧬 Complete System Architecture

This section documents the **entire bot architecture** for anyone wanting to understand, audit, or recreate the system from scratch.

### Mission Statement

**Turn £10 into £1,000,000** through strategic compounding on Polymarket's 15-minute crypto checkpoint markets. Only trade CONVICTION tier signals with 95%+ target accuracy.

### Data Flow Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           POLYPROPHET DATA FLOW                              │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│   Polymarket WebSocket (wss://ws-subscriptions-clob.polymarket.com/ws/...)  │
│              │                                                               │
│              ▼                                                               │
│   ┌──────────────────┐        ┌──────────────────┐                          │
│   │ Chainlink Prices │───────▶│   priceHistory   │ (500 ticks per asset)    │
│   │ BTC/ETH/SOL/XRP  │        │ checkpointPrices │ (15-min boundaries)      │
│   └──────────────────┘        └────────┬─────────┘                          │
│                                        │                                     │
│              ┌─────────────────────────┴─────────────────────────┐          │
│              ▼                                                    │          │
│   ┌──────────────────┐                                           │          │
│   │  SupremeBrain    │ (One per asset: BTC, ETH, SOL, XRP)       │          │
│   │  ───────────────  │                                          │          │
│   │  • 8-Model Voting │                                          │          │
│   │  • Kalman Filters │                                          │          │
│   │  • Adaptive Weights│                                         │          │
│   │  • Tier Assignment │                                         │          │
│   └────────┬─────────┘                                           │          │
│            │                                                      │          │
│            ▼                                                      ▼          │
│   ┌──────────────────┐                               ┌──────────────────┐   │
│   │ OpportunityDetect│                               │   Gamma API      │   │
│   │ ─────────────────│    ◀─────Market Odds────────  │   Market Data    │   │
│   │ • ORACLE Mode    │                               │   YES/NO prices  │   │
│   │ • ARBITRAGE Mode │                               └──────────────────┘   │
│   │ • SCALP Mode     │                                                      │
│   │ • UNCERTAINTY    │                                                      │
│   │ • MOMENTUM Mode  │                                                      │
│   └────────┬─────────┘                                                      │
│            │                                                                 │
│            ▼                                                                 │
│   ┌──────────────────┐                               ┌──────────────────┐   │
│   │  TradeExecutor   │───────▶ CLOB API ───────────▶ │   Polymarket     │   │
│   │  ───────────────  │        (via proxy)           │   Order Book     │   │
│   │  • Paper/Live    │                               └──────────────────┘   │
│   │  • Order Retry   │                                                      │
│   │  • Sell Recovery │                               ┌──────────────────┐   │
│   │  • Balance Cache │◀────── Position Updates ────── │   Polygon RPC    │   │
│   └──────────────────┘        (via ethers.js)        │   (Alchemy)      │   │
│                                                       └──────────────────┘   │
│                                                                              │
│   ┌───────────────────────────────────────────────────────────────────────┐ │
│   │                            PERSISTENCE (Redis)                        │ │
│   │   • Pattern Memory (30-day, 40%+ win rate filter)                     │ │
│   │   • Model Weights (per-asset accuracy tracking)                       │ │
│   │   • Brain State (predictions, calibration buckets)                    │ │
│   │   • Trading State (positions, history, P/L)                           │ │
│   │   • Settings (all CONFIG values)                                      │ │
│   └───────────────────────────────────────────────────────────────────────┘ │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

### The 8 Prediction Models (Detailed)

| # | Model | Logic | Vote Weight | Learning |
|---|-------|-------|-------------|----------|
| 1 | **Genesis Protocol** | Kalman-filtered price force vs ATR threshold. Double vote in first 3 mins. Lock state mechanism prevents oscillation. | 2-12% | Boosted early, tracks accuracy |
| 2 | **Physicist** | Calculates velocity, acceleration, jerk, snap (4th derivative). Detects fakeouts via entropy. | 10-20% | Based on recent accuracy |
| 3 | **Order Book** | Market odds velocity + orderflow imbalance. Detects extreme odds (>85%) for reversion plays. | 5-15% | Based on recent accuracy |
| 4 | **Historian** | DTW (Dynamic Time Warping) pattern matching against stored 10-tick vectors. Patterns pruned if <40% win rate. | 8-18% | Patterns decay over 30 days |
| 5 | **BTC Correlation** | For non-BTC assets, follows BTC momentum if >1.5x ATR move. Crypto markets are correlated. | 5-12% | Based on recent accuracy |
| 6 | **Macro** | Fear & Greed Index integration. <25 = extreme fear (bullish), >75 = extreme greed (bearish). | 3-8% | Based on recent accuracy |
| 7 | **Funding Rates** | Binance perpetual funding rates. Positive = overleveraged longs (bearish), negative = overleveraged shorts (bullish). | 3-10% | Based on recent accuracy |
| 8 | **Volume Analysis** | Volume anomaly detection. High volume + low price change = accumulation signal. | 5-12% | Reduced early, boosted late |

### Adaptive Learning Loop

After each 15-minute cycle ends:

```
1. evaluateOutcome() triggered
   │
   ▼
2. Compare predicted direction vs actual (was final price > checkpoint?)
   │
   ▼
3. For each model that voted:
   │   modelAccuracy[model].total++
   │   if (vote === actual) modelAccuracy[model].wins++
   │
   ▼
4. Recalculate weights (after 5+ trades):
   │   weight = (accuracy * 2) ^ 1.5
   │   Range: 0.2 (penalized) to 2.0 (boosted)
   │
   ▼
5. Update pattern memory:
   │   Save 10-tick vector → Redis
   │   Mark matched pattern as correct/incorrect
   │   Prune patterns with <40% win rate after 5+ matches
   │
   ▼
6. Evolve ATR multiplier:
   │   Win: decrease by 0.80 (more sensitive)
   │   Loss: increase by 2.50 (more conservative)
   │
   ▼
7. Reset for new cycle:
   │   cycleCommitted = false
   │   convictionLocked = false
   │   prediction = 'WAIT'
```

### Key Classes

| Class | Purpose | Key Methods |
|-------|---------|-------------|
| `TradeExecutor` | Position management, paper/live trading, balance caching | `executeTrade()`, `closePosition()`, `executeSellOrderWithRetry()` |
| `SupremeBrain` | Per-asset prediction engine with 8-model ensemble | `update()`, `evaluateOutcome()`, `getKellySize()` |
| `OpportunityDetector` | Multi-mode trading detection | `detectArbitrage()`, `detectScalp()`, `detectMomentum()`, etc. |
| `MathLib` | Technical analysis utilities | `calculateATR()`, `getDerivatives()`, `dtwDistance()`, `getMarketRegime()` |
| `KalmanFilter` | Noise reduction for price/derivatives | `filter()` |

### Failsafe Mechanisms (Detailed)

| Failsafe | Implementation | Code Location |
|----------|----------------|---------------|
| **Order Fill Verification** | 3 retries over 6s, checks order status via CLOB API | `executeTrade()` L743-764 |
| **Sell Order Retry** | 5 attempts with 3s delays, exponential backoff | `executeSellOrderWithRetry()` L898-949 |
| **Pending Sells Recovery** | Stores tokenId, conditionId, marketSlug, PolygonScan URL, manual instructions | L928-946 |
| **Smart Position Sizing** | Min $1.10, max 30% of available balance, Kelly-based | L524-580 |
| **Global Stop Loss** | Halts at -20% daily P/L, resets each day at midnight, UI override button | L420-433, L517-522 |
| **Cycle Commitment Lock** | Once direction committed in first 5 mins, no flip-flopping allowed | L2434-2440 |
| **Conviction Lock** | Requires 90%+ reversal votes OR 5x ATR move to unlock | L2444-2457 |
| **Stale Data Guard** | Won't trade if price data >3 seconds old | L2235-2243 |
| **Chainlink Heartbeat** | Auto-reconnects WebSocket after 60s of no data | L2889-2897 |
| **Pre-Resolution Exit** | Non-ORACLE positions close 30s before checkpoint | L1165-1169 |
| **Balance Caching** | Never shows $0 flash, caches for 30s with fallback | L435-469 |

### 15-Minute Cycle Timeline

```
00:00 ─────────────────────────────────────────────────────▶ 15:00
  │                                                            │
  │  0-3 min: Genesis Protocol boosted (2x votes)              │
  │           Early boost +35% confidence                      │
  │           Orderbook/Physicist weights increased            │
  │                                                            │
  │  0-5 min: ORACLE mode window                               │
  │           Cycle commitment can lock                        │
  │                                                            │
  │  5-10 min: MOMENTUM mode active                            │
  │            ARBITRAGE scanning                              │
  │            Pattern matching peaks                          │
  │                                                            │
  │  9-13 min: Late cycle opportunity detection                │
  │            (50/50 odds with high confidence)               │
  │                                                            │
  │  12-13 min: MOMENTUM cutoff (3 mins before end)            │
  │  13 min: ARBITRAGE cutoff (2 mins before end)              │
  │                                                            │
  │  14:30: Non-ORACLE positions force-close                   │
  │  14:59: All positions captured for resolution              │
  │                                                            │
  └──────── 15:00: Checkpoint! Binary resolution ──────────────┘
           Win = 100% (price went our way)
           Loss = 0% (price went against us)
```

### Configuration Object Structure

```javascript
CONFIG = {
  // API Credentials
  POLYMARKET_PRIVATE_KEY: '0x...',
  POLYMARKET_API_KEY: '...',
  POLYMARKET_SECRET: '...',
  POLYMARKET_PASSPHRASE: '...',
  POLYMARKET_ADDRESS: '0x...',
  
  // Trading
  TRADE_MODE: 'PAPER' | 'LIVE',
  PAPER_BALANCE: 1000,
  MAX_POSITION_SIZE: 0.10,
  MAX_POSITIONS_PER_ASSET: 2,
  MULTI_MODE_ENABLED: true,
  
  // ORACLE Mode
  ORACLE: {
    enabled: true,
    minConsensus: 0.70,      // 70% model agreement
    minConfidence: 0.70,     // 70% confidence
    minEdge: 10,             // 10% edge over odds
    maxOdds: 0.85,           // Don't buy >85¢
    aggression: 50,          // 0-100 slider
    stopLossEnabled: false,  // Optional emergency exit
    stopLoss: 0.25           // 25% loss trigger
  },
  
  // Other Modes
  ARBITRAGE: { enabled, minMispricing, targetProfit, stopLoss, maxHoldTime },
  SCALP: { enabled, maxEntryPrice, targetMultiple, requireLean },
  UNCERTAINTY: { enabled, extremeThreshold, targetReversion, stopLoss },
  MOMENTUM: { enabled, minElapsed, minConsensus, breakoutThreshold },
  
  // Risk Management
  RISK: {
    maxTotalExposure: 0.30,      // 30% max total
    globalStopLoss: 0.20,         // 20% daily loss limit
    globalStopLossOverride: false // UI override
  },
  
  // Telegram
  TELEGRAM: { enabled, botToken, chatId }
}
```

---

## 🤖 Complete AI Recreation Prompt

Use this prompt to recreate the bot from scratch with any AI coding assistant:

```
Create a production-ready Node.js trading bot for Polymarket's 15-minute cryptocurrency 
checkpoint markets. The bot should achieve £10 → £1,000,000 through strategic compounding. 

## Core Requirements

### 1. Data Infrastructure
- Connect to Polymarket's WebSocket (wss://ws-subscriptions-clob.polymarket.com/ws/market)
- Subscribe to crypto_prices_chainlink topic for real-time BTC/ETH/SOL/XRP prices
- Track checkpoint prices at :00/:15/:30/:45 minute boundaries (var INTERVAL_SECONDS = 900)
- Fetch market odds from Gamma API (https://gamma-api.polymarket.com)
- Store 500 price ticks per asset in priceHistory[]

### 2. 8-Model Prediction Ensemble
Implement these 8 voting models, each contributing weighted votes:

1. **Genesis Protocol**: Kalman-filtered price force vs 2.2x ATR threshold. Lock state mechanism.
   - Double votes in first 3 minutes
   - Includes long-term trend bias check

2. **Physicist**: Calculate velocity, acceleration, jerk, snap derivatives.
   - Fakeout detection via entropy (if entropy > 4x ATR, skip)
   - Kalman filter on derivatives

3. **Order Book**: Market odds velocity + orderflow imbalance.
   - Detect extreme odds (>85%) for mean reversion plays
   - Use MathLib.getOddsVelocity() and getOrderflowImbalance()

4. **Historian**: DTW pattern matching against stored 10-tick normalized vectors.
   - Store patterns in Redis with win rate tracking
   - Prune patterns with <40% accuracy after 5+ matches
   - 30-day decay on pattern age

5. **BTC Correlation**: For non-BTC assets, follow BTC momentum if >1.5x ATR.

6. **Macro**: Fear & Greed Index (https://api.alternative.me/fng/).
   - <25 = bullish, >75 = bearish

7. **Funding Rates**: Binance perpetual funding (https://fapi.binance.com/fapi/v1/premiumIndex).
   - Positive = bearish, Negative = bullish

8. **Volume Analysis**: Detect accumulation (high volume, low price change).

### 3. Adaptive Learning System
- Track each model's accuracy: modelAccuracy[model] = { wins, total }
- After 5 trades, recalculate weights: weight = (accuracy * 2)^1.5, clamped to [0.2, 2.0]
- Boost leading indicators (orderbook, physicist, genesis) in first 3 minutes
- Reduce lagging indicators (volume, macro) early
- Evolve ATR multiplier: Win → decrease 0.80, Loss → increase 2.50
- Calibration buckets for 90-95%, 95-98%, 98-100% confidence ranges

### 4. Five Trading Modes
1. **ORACLE**: Hold to binary resolution. Only trade first 5 mins with 70%+ consensus.
2. **ARBITRAGE**: Buy mispriced odds (15%+ edge), exit at 50% profit or 10 minutes.
3. **SCALP**: Buy under 20¢, exit at 2x or before cycle end.
4. **UNCERTAINTY**: Bet on extreme odds (>80%) reverting to 50/50.
5. **MOMENTUM**: Ride mid-cycle breakouts (>3% of ATR) with 75%+ consensus.

### 5. Anti-Whipsaw Protections
- **Cycle Commitment Lock**: Once committed in first 5 mins, direction cannot flip.
- **Conviction Lock**: Requires 90%+ opposite votes OR 5x ATR reversal to unlock.
- **Stability Counter**: Signal must persist 3+ ticks before registering.
- **Reality Check**: Kill confidence if price moves 4x ATR against prediction.

### 6. Trade Execution (TradeExecutor class)
- Paper mode: Simulate trades with fake balance
- Live mode: Use @polymarket/clob-client with proxy
- **Order fill verification**: 3 retries over 6 seconds
- **Sell retry**: 5 attempts with 3s delays
- **Pending sells tracker**: Store tokenId, conditionId, PolygonScan URL for failed sells
- **Smart sizing**: Min $1.10, max 30% balance, Kelly criterion based
- **Balance caching**: 30s cache, fallback to lastGoodBalance
- Position ID format: `${asset}_${mode}_${Date.now()}`

### 7. Failsafes
- Global stop loss: Halt at 20% daily loss (reset each day)
- Pre-resolution exit: Close non-ORACLE positions 30s before checkpoint
- Stale data guard: Require price data <3s old
- Chainlink heartbeat: Auto-reconnect WebSocket after 60s silence
- Watchguards: Zero confidence on panic, spoofing, or lagging data

### 8. Web Dashboard (Express.js)
- Single-page app with prediction cards for BTC/ETH/SOL/XRP
- Show: Prediction, Confidence %, Tier, Edge, Checkpoint Price
- Active positions with SELL buttons
- Trade history with P/L
- Settings modal for all mode configurations
- Recovery modal for pending sells
- Wallet modal for balances and withdrawals
- Basic auth protection

### 9. API Endpoints
- GET /api/state - All predictions, positions, trading data
- GET /api/settings - Current configuration
- POST /api/settings - Update configuration (persist to Redis)
- POST /api/manual-buy - { asset, direction, size }
- POST /api/manual-sell - { positionId }
- GET /api/pending-sells - Failed sells with recovery info
- GET /api/wallet - USDC and MATIC balances

### 10. Persistence (Redis)
- Store pattern memory per asset
- Store model weights and accuracy tracking
- Store brain state (predictions, calibration)
- Store trading state (positions, history)
- Store all settings (survives restarts)
- Memory fallback if Redis unavailable

### 11. Proxy Handling
Use https-proxy-agent for CLOB client (Polymarket blocks cloud IPs).
Do NOT proxy ethers.js RPC calls (time out).

### 12. Key Libraries
- express, basic-auth, cors - Server
- ethers@5 - Blockchain (NOT v6!)
- @polymarket/clob-client - Trading
- ioredis - Persistence
- axios - HTTP requests
- https-proxy-agent - Proxy
- ws - WebSocket
- dotenv - Environment

The goal is 95%+ accuracy on CONVICTION tier trades to enable compounding from £10 to £1,000,000.
```

---

## 📁 Project Structure

```
POLYPROPHET-main/
├── server.js          # Main application (5,200+ lines)
│   ├── Lines 1-200      # Imports, proxy config, Redis
│   ├── Lines 200-400    # CONFIG object, Telegram helpers
│   ├── Lines 400-1500   # TradeExecutor class
│   ├── Lines 1500-1700  # OpportunityDetector class
│   ├── Lines 1700-1900  # MathLib, KalmanFilter
│   ├── Lines 1900-2850  # SupremeBrain class (8 models)
│   ├── Lines 2850-3100  # WebSocket, data fetching
│   ├── Lines 3100-4100  # Dashboard HTML/CSS/JS
│   ├── Lines 4100-4500  # API endpoints
│   └── Lines 4500-5294  # Settings, wallet, startup
│
├── generate_creds.js   # API credential generator
├── package.json        # Dependencies
├── .env.example        # Configuration template
├── .env                # Your configuration (not in git!)
└── README.md           # This documentation
```

---

## 🎯 The Goal

**Turn £10 into £1,000,000** through strategic compounding on Polymarket's 15-minute crypto markets.

### Success Requirements

1. **Trade CONVICTION tier only** - High-confidence signals (70%+)
2. **Maintain 95%+ accuracy** - Let the bot learn and adapt
3. **Be patient** - Learning takes 5+ trades per asset to calibrate
4. **Use aggression slider** - Balance frequency vs quality
5. **Trust the system** - Don't override unless necessary

### Compounding Math

| Starting | Win Rate | Trades | Kelly Fraction | Ending (Approx) |
|----------|----------|--------|----------------|-----------------|
| £10 | 60% | 100 | 5% | £40 |
| £40 | 70% | 100 | 10% | £500 |
| £500 | 80% | 100 | 15% | £10,000 |
| £10,000 | 85% | 100 | 20% | £100,000 |
| £100,000 | 90% | 100 | 25% | £1,000,000 |

As the bot learns and accuracy improves, position sizing can increase.

---

*Built for the £10 to £1,000,000 mission* 🚀

*Last Updated: December 2025*
