# POLYPROPHET PAPER Fronttest Status Report

**Generated**: 2026-01-03
**Current Version**: v70 (deployed)
**Mode**: PAPER

---

## CURRENT STATUS

| Metric | Value | Notes |
|--------|-------|-------|
| **Starting Balance** | £5.00 | Standard test capital |
| **Current Balance** | £1.69 | **Below floor** |
| **Balance Floor** | £2.00 | Trading halted |
| **Total Return** | -66.14% | Loss from starting capital |
| **Today's PnL** | +£1.09 | Partial recovery today |
| **Total Trades** | 144 | Across multiple versions |
| **Positions Open** | 0 | No pending trades |

---

## TRADING STATUS

**HALTED** - Balance (£1.69) is below minimum floor (£2.00)

This is the balance floor guard working correctly - it has prevented further losses.

---

## RECENT TRADE ANALYSIS (Last 20)

| Time | Asset | Side | Entry | Exit | PnL | Result | Version |
|------|-------|------|-------|------|-----|--------|---------|
| 1767392367941 | XRP | UP | 0.59 | 1 | +£0.76 | WIN | 60 |
| 1767391388768 | XRP | UP | 0.78 | 0 | -£1.10 | LOSS | 60 |
| 1767390750677 | ETH | UP | 0.77 | 1 | +£0.33 | WIN | 60 |
| 1767382592239 | BTC | DOWN | 0.59 | 0 | -£1.10 | LOSS | 60 |
| 1767379730332 | XRP | DOWN | 0.55 | 1 | +£0.90 | WIN | 59 |
| 1767378785217 | XRP | DOWN | 0.74 | 1 | +£0.39 | WIN | 59 |
| 1767376987932 | XRP | UP | 0.55 | 0 | -£1.10 | LOSS | 59 |
| 1767375246128 | BTC | DOWN | 0.70 | 1 | +£0.47 | WIN | 58 |
| 1767372730634 | ETH | DOWN | 0.87 | 0 | -£2.00 | LOSS | 58 |
| 1767370682117 | XRP | UP | 0.79 | 1 | +£0.29 | WIN | 58 |

### Win/Loss Summary (Last 20)
- Wins: 12 (60%)
- Losses: 8 (40%)
- Net PnL: -£2.26

**Note**: The win rate dropped to 60% in recent trades, below the 70% threshold.

---

## VERSION HISTORY IN FRONTTEST

This fronttest has run across multiple code versions:

| Version | Trades | Notes |
|---------|--------|-------|
| 53 | Multiple | Early version |
| 54 | Multiple | Bug fixes |
| 55 | Multiple | Improvements |
| 58 | Multiple | LIVE safety |
| 59 | Multiple | pWinEff fix |
| 60 | 4 | Recent trades |
| **70** | 0 | **Current (halted)** |

The fronttest data includes trades from OLDER versions (53-60), which may not reflect v70 behavior.

---

## ISSUES IDENTIFIED

### 1. Balance Below Floor
- Current: £1.69
- Floor: £2.00
- **Trading correctly halted**

### 2. Mixed Version Data
- Fronttest includes trades from v53-v60
- v70 specific validation not yet accumulated
- Need fresh £5 restart to validate v70

### 3. Win Rate Degradation
- Recent 20 trades: 60% WR (below 70% threshold)
- This may have triggered drift warnings

---

## RECOMMENDATIONS

### To Complete 72h PAPER Fronttest on v70:

1. **Reset paper balance** to £5 via Settings or API:
```bash
curl -X POST "https://polyprophet.onrender.com/api/settings" \
  -H "Content-Type: application/json" \
  -d '{"PAPER_BALANCE": 5}' \
  -u bandito:bandito
```

2. **Clear trade history** (optional) to isolate v70 data

3. **Monitor for 72h** with:
   - `/api/health` checks every hour
   - `/api/trades` logging
   - No manual interventions

4. **Success criteria**:
   - No critical errors
   - No CRASH_RECOVERED trades
   - Win rate >70%
   - No balance floor triggers (ideally)

### For LIVE Mode Enablement:

**DO NOT enable LIVE until:**
- [ ] 72h clean PAPER run on v70
- [ ] Redis connected (REQUIRED for LIVE)
- [ ] Wallet loaded (POLYMARKET_PRIVATE_KEY set)
- [ ] Win rate >70% confirmed
- [ ] No critical errors in health check

---

## BALANCE FLOOR GUARD VALIDATION

**STATUS: ✅ WORKING CORRECTLY**

The balance floor guard successfully halted trading when balance dropped below £2:

```json
{
    "balanceFloor": {
        "enabled": true,
        "floor": 2,
        "currentBalance": 1.6929782082324456,
        "belowFloor": true,
        "tradingBlocked": true
    }
}
```

This prevented further losses beyond the £1.69 current balance.

---

*Report generated as part of GOAT final audit*
