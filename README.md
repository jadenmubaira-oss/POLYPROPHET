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
The main file (~4,900 lines) contains:
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
