# 🔮 POLYPROPHET - Supreme Oracle Prediction Engine

> **AI-powered prediction bot for Polymarket 15-minute crypto markets**
> 
> Target: £10 → £1,000,000 through compounding wins

## 🎯 What Is This?

POLYPROPHET is a sophisticated trading bot that uses **8 machine learning models** to predict the direction of 15-minute cryptocurrency checkpoint markets on Polymarket. It monitors BTC, ETH, SOL, and XRP price movements and executes trades when high-confidence signals are detected.

### Key Features

- **8-Model Ensemble Voting** - Genesis Protocol, Physicist, Order Book, Historian, BTC Correlation, Macro, Funding Rates, Volume Analysis
- **5 Trading Modes** - ORACLE (hold to resolution), ARBITRAGE (mispricing), SCALP (cheap entries), UNCERTAINTY (reversion), MOMENTUM (trend riding)
- **Adaptive Learning** - Models adjust weights based on real performance
- **Pattern Memory** - Historian stores and learns from past price patterns
- **Paper & Live Trading** - Test with fake money before risking real USDC
- **Beginner Presets** - Safe, Balanced, and Aggressive one-click configurations
- **Live Trading Failsafes** - Order fill verification, retry logic, proper sell orders

---

## 🚀 Quick Start

```powershell
# 1. Install dependencies
npm install

# 2. Start the server
npm start

# 3. Open dashboard
# http://localhost:3000
```

---

## 📊 Dashboard Overview

| Metric | Description |
|--------|-------------|
| **Prediction** | UP or DOWN direction for each asset |
| **Confidence** | 0-100% certainty level |
| **Tier** | CONVICTION (high confidence) or ADVISORY |
| **Edge** | Our calculated advantage over market odds |
| **Win Rate** | Historical accuracy |
| **Checkpoint Price** | Cycle starting price (displayed in gold) |

---

## ⚙️ Configuration

### Environment Variables (.env)

```env
# Polymarket API Credentials
POLYMARKET_API_KEY=your-api-key
POLYMARKET_SECRET=your-secret
POLYMARKET_PASSPHRASE=your-passphrase
POLYMARKET_ADDRESS=0xYourWalletAddress
POLYMARKET_PRIVATE_KEY=0xYourPrivateKey

# Trading Mode
TRADE_MODE=PAPER  # or LIVE

# Balances
PAPER_BALANCE=1000
LIVE_BALANCE=1000  # Used when cache expires

# Risk
MAX_POSITION_SIZE=0.10  # 10% max per trade

# Authentication
AUTH_USERNAME=admin
AUTH_PASSWORD=changeme

# Persistence (optional)
REDIS_URL=redis://...
```

### Trading Modes

| Mode | Description | Risk |
|------|-------------|------|
| **ORACLE** 🔮 | Hold to resolution @ 92%+ confidence | Low (selective) |
| **ARBITRAGE** 📊 | Buy mispriced odds, sell when corrected | Medium |
| **SCALP** 🎯 | Buy under 20¢, exit at 2x | Medium |
| **UNCERTAINTY** 🌊 | Trade extreme odds reversion | Higher |
| **MOMENTUM** 🚀 | Ride strong mid-cycle trends | Higher |

### Beginner Presets

Click one button to configure all modes:

| Preset | Oracle Confidence | Max Exposure | Description |
|--------|------------------|--------------|-------------|
| 🛡️ **Safe** | 92%+ | 20% | Conservative, fewer trades |
| ⚖️ **Balanced** | 85%+ | 30% | Default settings |
| 🔥 **Aggressive** | 70%+ | 50% | More trades, higher risk |

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

---

## 🛡️ Live Trading Failsafes

| Guard | Protection |
|-------|------------|
| **Order Fill Verification** | 3 retries over 6 seconds to confirm fills |
| **Entry Price Guard** | Blocks trades at ≥98¢ or ≤2¢ |
| **Late Cycle Guard** | Arb: 13min, Momentum: 12min cutoffs |
| **Stale Data Guard** | Requires data < 3 seconds old |
| **Real Balance** | Uses actual USDC for position sizing |
| **Cycle Lock** | Prevents prediction flip-flopping |
| **Sell Order Execution** | Actually sells shares when closing LIVE positions |

---

## 📁 Project Structure

```
POLYPROPHET-main/
├── server.js          # Main application (3,900+ lines)
├── package.json       # Dependencies
├── .env               # Configuration (API keys, etc.)
├── .env.example       # Template for .env
└── README.md          # This file
```

---

## ⚠️ Important Notes

1. **Paper Mode First** - Always test with `TRADE_MODE=PAPER` before going live
2. **Checkpoint Timing** - Predictions activate at 15-minute boundaries (:00, :15, :30, :45)
3. **USDC + MATIC Required** - For live trading, fund your wallet on Polygon network
4. **Learning Period** - The bot improves over time as it gathers more data
5. **Position Auto-Close** - All positions resolve at cycle end with binary outcome

---

## 🎲 The Goal

Turn **£10 into £1,000,000** through strategic compounding on Polymarket's 15-minute crypto markets.

The key is:
- Only trading **CONVICTION tier** signals
- Maintaining **95%+ accuracy** on high-confidence predictions
- Letting the bot learn and adapt over cycles

---

## 📜 Recent Updates

- ✅ **Live Trading Failsafes** - Order fill verification, retry logic, sell orders
- ✅ **Increased Decimal Precision** - Shows 2 decimals for prices, 1 for odds
- ✅ **Beginner Presets** - Safe, Balanced, Aggressive one-click configs
- ✅ **Checkpoint Price Display** - Gold-highlighted in each asset card
- ✅ **Position Auto-Close** - All positions resolve at cycle end
- ✅ **Trade Mode Badges** - Colored badges showing ORACLE/SCALP/etc.

---

## 🛠️ Tech Stack

- **Runtime**: Node.js 18+
- **Server**: Express.js
- **WebSocket**: Real-time Polymarket data via Chainlink
- **Blockchain**: ethers.js (Polygon/USDC)
- **Persistence**: Redis (optional), memory fallback
- **Trading**: @polymarket/clob-client

---

*Built for the £10 to £1,000,000 mission* 🚀
