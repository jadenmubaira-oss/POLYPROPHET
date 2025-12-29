# 🚀 POLYPROPHET OMEGA: DEPLOYMENT GUIDE

## Quick Start (5 Minutes)

### 1. Local Testing

```bash
# Install dependencies
npm install

# Copy environment template
cp .env.example .env

# Edit .env with your settings
# TRADE_MODE=PAPER
# PAPER_BALANCE=5.00

# Start server
node server.js

# Access dashboard
# http://localhost:3000
# Username: admin
# Password: changeme (or set AUTH_PASSWORD)
```

### 2. Render.com Deployment

1. **Push to GitHub**
   ```bash
   git init
   git add .
   git commit -m "PolyProphet Omega Pinnacle"
   git remote add origin https://github.com/yourusername/POLYPROPHET.git
   git push -u origin main
   ```

2. **Create Render Service**
   - Go to https://render.com
   - New → Web Service
   - Connect GitHub repository
   - Settings:
     - **Build Command**: `npm install`
     - **Start Command**: `node server.js`
     - **Environment**: Node 18+

3. **Set Environment Variables**
   ```
   TRADE_MODE=PAPER
   PAPER_BALANCE=5.00
   AUTH_USERNAME=admin
   AUTH_PASSWORD=your_secure_password
   REDIS_URL=your_redis_url (optional)
   PROXY_URL=your_proxy (optional, for Cloudflare bypass)
   ```

4. **Generate API Credentials** (for LIVE mode)
   ```bash
   node generate_creds.js 0x_your_private_key
   ```
   Copy output to Render environment variables:
   ```
   POLYMARKET_API_KEY=...
   POLYMARKET_SECRET=...
   POLYMARKET_PASSPHRASE=...
   POLYMARKET_PRIVATE_KEY=...
   ```

5. **Deploy**
   - Click "Create Web Service"
   - Wait for build to complete
   - Access at `https://your-service.onrender.com`

### 3. Mobile App Setup (Vibecode)

1. **Open `mobile.html` in Vibecode**
2. **Enter Render URL** in settings (⚙️ button)
3. **App connects automatically**
4. **Background operation**:
   - App keeps WebSocket alive
   - Notifications for trades
   - Auto-reconnects on disconnect

---

## Configuration Reference

### Oracle Mode (Main Trading)

```javascript
ORACLE: {
    enabled: true,
    minConsensus: 0.70,      // 70% model agreement required
    minConfidence: 0.75,      // 75% confidence minimum
    minEdge: 0.05,            // 5% edge minimum
    maxOdds: 0.65,            // Won't buy above 65¢
    minStability: 2,          // 2 ticks stability
    minElapsedSeconds: 30     // Wait 30s after cycle start
}
```

### Risk Management

```javascript
RISK: {
    k_frac: 0.5,              // 50% Kelly (conservative)
    drawdownLimit: 0.30,       // 30% max drawdown
    maxTotalExposure: 0.70,    // 70% max exposure
    globalStopLoss: 0.40,      // 40% daily stop loss
    cooldownAfterLoss: 300,    // 5 min cooldown
    maxConsecutiveLosses: 3,   // Pause after 3 losses
    minTradeSize: 1.10         // $1.10 minimum
}
```

### State Machine

```javascript
STATE: {
    observeWindowMinutes: 30,
    strikeGates: {
        N: 3,    // 3 of last 4 trades must win
        M: 4,    // Look at last 4 trades
        T: 180,  // Time to expiry <= 180s
        S: 0.08  // Spread >= 8¢
    }
}
```

---

## Monitoring

### Dashboard
- **Desktop**: `https://your-server.onrender.com`
- **Mobile**: `https://your-server.onrender.com/mobile.html`

### API Endpoints
- `GET /api/state` - Current state
- `GET /api/health` - Health check
- `GET /api/debug-export` - Complete debug data
- `GET /api/settings` - Current config
- `POST /api/settings` - Update config

### Logs
- **Render**: View in Render dashboard
- **Local**: Console output
- **Debug**: `/api/debug-export` endpoint

---

## Troubleshooting

### Bot Not Trading

1. **Check Confidence**: May be below 75% threshold
2. **Check State**: May be stuck in OBSERVE
3. **Check EV**: May be negative (no edge)
4. **Check Cooldown**: May be paused after losses
5. **Check Cycle Limits**: May have hit max trades

### WebSocket Issues

- **Mobile**: Falls back to polling automatically
- **Desktop**: Check browser console for errors
- **Server**: Check Render logs

### Live Trading Issues

1. **API Credentials**: Verify all 4 are set correctly
2. **Wallet Balance**: Check USDC and MATIC
3. **CLOB Client**: Check initialization in logs
4. **Proxy**: May need PROXY_URL for Render

---

## Performance Tuning

### For More Trades (Lower Dormancy)

```javascript
ORACLE: {
    minConfidence: 0.70,  // Lower from 0.75
    minEdge: 0.03,        // Lower from 0.05
    minElapsedSeconds: 15 // Lower from 30
}
```

### For Higher Accuracy (Fewer Trades)

```javascript
ORACLE: {
    minConfidence: 0.85,  // Higher from 0.75
    minEdge: 0.10,        // Higher from 0.05
    minConsensus: 0.80    // Higher from 0.70
}
```

### For Faster Compounding

```javascript
RISK: {
    k_frac: 0.75,         // Higher from 0.50 (more aggressive)
    maxTotalExposure: 0.80 // Higher from 0.70
}
STATE: {
    strikeGates: {
        N: 2,    // Lower from 3 (easier to enter STRIKE)
        T: 240   // Higher from 180 (more time for STRIKE)
    }
}
```

---

## Security Checklist

- [ ] Rotate all API keys after deployment
- [ ] Use strong AUTH_PASSWORD
- [ ] Use dedicated trading wallet (not main wallet)
- [ ] Enable Redis for state persistence
- [ ] Monitor balance alerts
- [ ] Review trades regularly
- [ ] Test in PAPER mode first

---

## Support

- **Debug Data**: `/api/debug-export`
- **State File**: `omega_state.json` (local) or Redis (production)
- **Logs**: Render dashboard or console

---

**Ready to deploy. 🔮**

