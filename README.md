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

---

## ⚙️ Configuration

### Environment Variables (.env)

```env
POLYMARKET_API_KEY=your-api-key
POLYMARKET_SECRET=your-secret
POLYMARKET_PASSPHRASE=your-passphrase
POLYMARKET_PRIVATE_KEY=0x...your-private-key
TRADE_MODE=PAPER  # or LIVE
PAPER_BALANCE=1000
```

### Trading Modes

| Mode | Description | Risk |
|------|-------------|------|
| **ORACLE** 🔮 | Hold to resolution @ 92%+ confidence | Low (selective) |
| **ARBITRAGE** 📊 | Buy mispriced odds, sell when corrected | Medium |
| **SCALP** 🎯 | Buy under 20¢, exit at 2x | Medium |
| **UNCERTAINTY** 🌊 | Trade extreme odds reversion | Higher |
| **MOMENTUM** 🚀 | Ride strong mid-cycle trends | Higher |

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

---

## 📁 Project Structure

```
POLYPROPHET-main/
├── server.js          # Main application (3,600+ lines)
├── package.json       # Dependencies
├── .env               # Configuration (API keys, etc.)
└── README.md          # This file
```

---

## ⚠️ Important Notes

1. **Paper Mode First** - Always test with `TRADE_MODE=PAPER` before going live
2. **Checkpoint Timing** - Predictions activate at 15-minute boundaries (:00, :15, :30, :45)
3. **USDC + MATIC Required** - For live trading, fund your wallet on Polygon network
4. **Learning Period** - The bot improves over time as it gathers more data

---

## 🎲 The Goal

Turn **£10 into £1,000,000** through strategic compounding on Polymarket's 15-minute crypto markets.

The key is:
- Only trading **CONVICTION tier** signals
- Maintaining **95%+ accuracy** on high-confidence predictions
- Letting the bot learn and adapt over cycles

---

## 📜 Recent Updates

- ✅ Fixed wallet transfer API (JSON parsing)
- ✅ Added diagnostic logging for prediction debugging
- ✅ Enhanced UI with trade history panel
- ✅ Improved balance tracking with before/after logging
- ✅ Enhanced positions display (mode, entry price, time held)

---

## 🛠️ Tech Stack

- **Runtime**: Node.js 18+
- **Server**: Express.js
- **WebSocket**: Real-time Polymarket data
- **Blockchain**: ethers.js (Polygon/USDC)
- **Persistence**: Redis (optional), JSON file fallback
- **Trading**: @polymarket/clob-client

---

*Built for the £10 to £1,000,000 mission* 🚀
