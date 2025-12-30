# POLYPROPHET GOAT v3 MANIFESTO

## The Final System: MAX PROFIT ASAP WITH MIN VARIANCE

---

## 1. WHY THIS BOT EXISTS

PolyProphet was built to trade Polymarket's 15-minute cryptocurrency checkpoint markets. These markets resolve every 15 minutes based on whether BTC, ETH, SOL, or XRP went up or down from the checkpoint price.

**The opportunity**: Markets often misprice outcomes. A well-calibrated prediction system can identify positive expected value (EV) trades.

**The goal**: Compound a small starting balance ($5-$10) into significant profits as quickly as possible, while keeping variance (drawdowns) bounded.

---

## 2. DESIGN PHILOSOPHY

### Core Principles

1. **Evidence-Based**: Every parameter comes from forensic analysis of 1,973+ historical cycles
2. **Fail-Closed**: When in doubt, don't trade. Silent failures are worse than missed opportunities.
3. **Observable**: Every decision can be traced through GateTrace. No "black box" behavior.
4. **Bounded Risk**: CircuitBreaker and streak-aware sizing ensure no single bad run can wipe out the account.
5. **Honest Accounting**: Portfolio value reflects reality, not just cash balance.

### What We Optimize For

- **Primary**: Expected Value (EV) - only trade when edge is positive
- **Secondary**: Win rate - higher confidence = more consistent compounding
- **Tertiary**: Speed - more trades = faster compounding (but never at the cost of edge)

### What We Explicitly Avoid

- Trading based on "gut feel" or untested intuition
- Over-leveraging during winning streaks
- Ignoring statistical variance (it WILL happen)
- Silent failures that could go unnoticed for days

---

## 3. ARCHITECTURE

```
┌─────────────────────────────────────────────────────────────┐
│                     DATA SOURCES                             │
├─────────────────────────────────────────────────────────────┤
│  Polymarket Live WS  │  Gamma API  │  Chainlink Prices      │
└──────────┬───────────┴──────┬──────┴────────────┬───────────┘
           │                  │                   │
           v                  v                   v
┌─────────────────────────────────────────────────────────────┐
│                    SupremeBrain (per asset)                  │
│  - 8 voting models (momentum, regression, ML, patterns...)   │
│  - Certainty scoring and oracle locking                      │
│  - Confidence and tier calculation                           │
└──────────────────────────┬──────────────────────────────────┘
                           │
                           v
┌─────────────────────────────────────────────────────────────┐
│                    Decision Pipeline                         │
│  1. Signal generation (UP/DOWN/WAIT)                         │
│  2. Tier assignment (CONVICTION/ADVISORY/NONE)               │
│  3. EV calculation with calibrated pWin                      │
│  4. Gate checks (via GateTrace)                              │
│  5. CircuitBreaker check                                     │
│  6. Position sizing with streak adjustment                   │
└──────────────────────────┬──────────────────────────────────┘
                           │
                           v
┌─────────────────────────────────────────────────────────────┐
│                    TradeExecutor                             │
│  - Paper mode: simulated execution                           │
│  - Live mode: Polymarket CLOB orders                         │
│  - Position tracking and P/L calculation                     │
│  - Redemption queue for resolved positions                   │
└─────────────────────────────────────────────────────────────┘
```

---

## 4. KEY COMPONENTS

### 4.1 SupremeBrain

Eight models vote on each prediction:
- Momentum (price trend)
- Mean Reversion
- Volatility Analysis
- Genesis (15-min cycle patterns)
- Pattern Memory
- Correlation Analysis
- Neural approximation
- Ensemble consensus

**Output**: Direction (UP/DOWN/WAIT), Confidence (0-100%), Tier (CONVICTION/ADVISORY/NONE)

### 4.2 GateTrace

Every signal evaluation is logged:
- What was the signal?
- What gates did it pass/fail?
- Why was it blocked or allowed?

Access via `/api/gates` or the UI.

### 4.3 CircuitBreaker

Protects against variance spirals:

| Trigger | Action | Resume |
|---------|--------|--------|
| 15% daily drawdown | SAFE_ONLY (50% sizing) | Win or 30min |
| 30% daily drawdown | PROBE_ONLY (25% sizing) | Win or new day |
| 4 consecutive losses | PROBE_ONLY | Win |
| 50% daily drawdown | HALTED | New day only |

### 4.4 Streak-Aware Sizing

After losses, size is automatically reduced:
- After 1 loss: 80% of normal
- After 2 losses: 60%
- After 3 losses: 40%
- After 4+ losses: 25%

This prevents the "martingale death spiral".

### 4.5 Portfolio Accounting

True portfolio value = Cash + Mark-to-Market positions

Daily P/L is calculated against the portfolio value at day start, not just realized trades.

---

## 5. DECISION POLICY

### When to Trade

A trade is executed when ALL of these are true:
1. Signal is UP or DOWN (not WAIT/NEUTRAL)
2. Tier is CONVICTION or ADVISORY
3. Confidence >= threshold for tier
4. EV (expected value) > 0
5. Entry price within acceptable range
6. CircuitBreaker allows it
7. Not in cooldown from recent losses
8. Not at max exposure
9. Minimum trade size ($1.10) is affordable

### Position Sizing

```
BaseSize = Bankroll × BaseFraction (typically 8-20%)
AdjustedSize = BaseSize × StateMultiplier × StreakMultiplier × CBMultiplier
FinalSize = min(AdjustedSize, MaxLossBudget / 0.50, Bankroll × MaxFraction)
```

### Exit Policy

- **Oracle Mode**: Hold to cycle resolution (15 minutes)
- **Stop Loss**: Optional, typically -50% of entry
- **Target**: Typically 95¢ for high-price exits

---

## 6. RISK MANAGEMENT

### Daily Limits

- Soft stop: -15% of day start balance
- Hard stop: -30% of day start balance
- Loss budget: -10% per single trade (worst case)

### Per-Trade Limits

- Max position: 20% of bankroll (configurable)
- Max total exposure: 70% of bankroll
- Minimum trade: $1.10 (Polymarket requirement)

### What Happens When Things Go Wrong

1. **Single loss**: Streak counter increments, sizing reduces
2. **Loss streak**: CircuitBreaker triggers, trading restricted
3. **Major drawdown**: HALTED state until new day
4. **System error**: Fail-closed, no trades executed

---

## 7. OPERATIONAL PLAYBOOK

### Deployment

```bash
# Deploy to Render via Blueprint
# render.yaml points to POLYPROPHET-FINAL/
```

### Required Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| TRADE_MODE | Yes | PAPER or LIVE |
| AUTH_USERNAME | Yes | Dashboard login |
| AUTH_PASSWORD | Yes | Dashboard login |
| REDIS_URL | Recommended | For persistence |
| POLYMARKET_PRIVATE_KEY | For LIVE | Wallet key |
| POLYMARKET_API_KEY | For LIVE | API credentials |

### Monitoring

- `/api/health` - System health + CircuitBreaker status
- `/api/verify` - Full GOAT verification checklist
- `/api/gates` - Recent trade decisions
- `/api/portfolio` - Current P/L and positions

### Recovery Procedures

**If trading stops unexpectedly**:
1. Check `/api/health` for CircuitBreaker state
2. Check `/api/gates` for why trades are blocked
3. If HALTED, wait for new day or manual reset

**If positions are stuck**:
1. Check `/api/redemption-queue`
2. Manually trigger `/api/check-redemptions`
3. See recovery queue for manual intervention needed

---

## 8. WHAT THIS SYSTEM CANNOT GUARANTEE

### Explicit Limits

1. **No guaranteed profit**: Markets are unpredictable. Historical edge may not persist.
2. **No zero-drawdown**: Variance happens. Losing streaks are statistically certain over time.
3. **No perfect timing**: Market conditions change. What worked before may stop working.
4. **No infinite scaling**: Large positions move markets. Edge diminishes with size.

### What We CAN Guarantee

1. **Bounded risk**: Daily and per-trade limits are enforced
2. **Full transparency**: Every decision is logged and traceable
3. **Fail-closed behavior**: Errors result in no trades, not bad trades
4. **Honest accounting**: P/L reflects reality, not wishful thinking

---

## 9. REPRODUCIBILITY

To rebuild this system from scratch:

1. **Data Collection**: Gather 1,000+ 15-minute cycles with outcomes
2. **Model Training**: Implement the 8 voting models
3. **Calibration**: Calculate win rates by tier and price band
4. **Gate Implementation**: Build the decision pipeline with GateTrace
5. **Risk Controls**: Implement CircuitBreaker and streak sizing
6. **Testing**: Backtest on historical data, forward-test on live data
7. **Deployment**: Run 24/7 with monitoring and alerts

The key insight: **Don't optimize for profit. Optimize for edge. Profit follows.**

---

## 10. VERSION HISTORY

- **v1.0**: Basic Oracle mode
- **v2.0**: GOAT features (GateTrace, Watchdog, API Explorer)
- **v3.0**: The Ceiling (CircuitBreaker, Streak Sizing, Portfolio Accounting, Verification)

---

## 11. FINAL NOTE

This is the ceiling. Not because further improvement is impossible, but because further improvement would require:
- Different markets (not 15-minute checkpoints)
- Significantly more capital (liquidity becomes the constraint)
- Different risk tolerance (this system is optimized for min-variance)

For the goal of "MAX PROFIT ASAP WITH MIN VARIANCE" on Polymarket 15-minute crypto checkpoints, starting with $5-$10, this system represents the limit of what is achievable with sound risk management.

**Trade responsibly. Never risk more than you can afford to lose.**

---

*Last updated: December 2024*
*Version: 3.0.0-goat*


