# Mined Requirements from Conversation

Generated: 2025-12-31T06:58:49.874Z
Input: `cursor_untitled_chat.md`
Total lines processed: 633,454

---

## Summary by Category

| Category | Matches | Unique Patterns |
|----------|---------|-----------------|
| varianceConstraints | 14705 | 13 |
| goldenMean | 4033 | 7 |
| bankrollTargets | 3422 | 50 |
| feedLiveness | 3055 | 7 |
| exportRequirements | 3017 | 6 |
| winRateTargets | 2589 | 13 |
| predictionStability | 1101 | 7 |
| deploymentDecisions | 45 | 5 |

---

## Detailed Findings

### varianceConstraints (14705 matches)

**Unique patterns found:**
- `min variance`
- `minimal variance`
- `stop-loss`
- `circuitbreaker`
- `maxdrawdown`
- `consecutiveloss`
- `lossstreak`
- `stoploss`
- `stop loss`
- `consecutive loss`
- `loss streak`
- `kill switch`
- `circuit breaker`

**Sample extracts:**
- Line 20: `MIN VARIANCE`
  > we want MAX PROFIT ASAP WITH MIN VARIANCE.
- Line 68: `minimal variance`
  > ptions without the drawdown of turbo/option C. so minimal variance/losses, but quickest profit- however it doesn’t h...
- Line 70: `minimal variance`
  > all 3 without the drawdown of turbo/option C. so minimal variance/losses, but quickest profit- however it doesn’t h...
- Line 263: `MIN VARIANCE`
  > we want MAX PROFIT ASAP WITH MIN VARIANCE.
- Line 278: `stop-loss`
  > (b) quantify how much variance is hurting (sizes/stop-loss mechanics), and (c) revise the plan to add persis...

### goldenMean (4033 matches)

**Unique patterns found:**
- `illiquidity`
- `golden mean`
- `observe' | 'harvest' | 'strike`
- `observe/harvest/strike`
- `ev calculation`
- `liquidity guard`
- `state machine`

**Sample extracts:**
- Line 1762: `ILLIQUIDITY`
  > // MODE 2B: ILLIQUIDITY GAP 💰 - Guaranteed profit when Yes+No < 100%
- Line 1764: `ILLIQUIDITY`
  > ILLIQUIDITY_GAP: {
- Line 1982: `GOLDEN MEAN`
  > // 🎯 GOLDEN MEAN: OBSERVE/HARVEST/STRIKE State Machine
- Line 1986: `OBSERVE' | 'HARVEST' | 'STRIKE`
  > this.tradingState = 'HARVEST';      // Current state: 'OBSERVE' | 'HARVEST' | 'STRIKE'
- Line 2248: `OBSERVE/HARVEST/STRIKE`
  > // Integrate with OBSERVE/HARVEST/STRIKE state machine

### bankrollTargets (3422 matches)

**Unique patterns found:**
- `starting paper balance | `5.00`
- `startingbalance = parsefloat(req.query.balance) || 5.0`
- `startingbalance * 100`
- `targets = [20, 50, 100, 200, 500`
- `target = (targettime - starttime) / (1000 * 60 * 60`
- `target.tofixed(1`
- `startingbalance).tofixed(2`
- `target: 0.98`
- `target: 0.20`
- `target: 0.95`
- `target: 0.25`
- `target: 0.90`
- `target: 0.15`
- `targetprofit: 0.50,      // exit at 50`
- `targetprice: 0.18,       // target 18¢ for exit (2-3`
- `targetmultiple: 2.0,     // exit at 2`
- `targetreversion: 0.60,   // exit when odds hit 60%/40`
- `target) msg += `🎯 target: <code>${(target * 100).tofixed(1`
- `target: 2-4`
- `targettradesperhour = 3`
- ... and 30 more

**Sample extracts:**
- Line 363: `Starting paper balance | `5.00`
  > | `PAPER_BALANCE` | Starting paper balance | `5.00` |
- Line 579: `startingBalance = parseFloat(req.query.balance) || 5.0`
  > const startingBalance = parseFloat(req.query.balance) || 5.0;
- Line 721: `startingBalance * 100`
  > const profitPct = (totalProfit / startingBalance * 100);
- Line 731: `targets = [20, 50, 100, 200, 500`
  > const targets = [20, 50, 100, 200, 500];
- Line 738: `Target = (targetTime - startTime) / (1000 * 60 * 60`
  > const hoursToTarget = (targetTime - startTime) / (1000 * 60 * 60);

### feedLiveness (3055 matches)

**Unique patterns found:**
- `forever`
- `24/7`
- `websocket`
- `stale data`
- `live price`
- `chainlink`
- `live data`

**Sample extracts:**
- Line 36: `forever`
  > (just make sure not to go into executing code loop where you try to execute forever)
- Line 428: `24/7`
  > // 24/7 Node.js Server - Ultra-Fast Edition - COMPLETE WITH ALL 8 MODELS
- Line 432: `WebSocket`
  > const WebSocket = require('ws');
- Line 1184: `WEBSOCKET`
  > // ==================== WEBSOCKET SERVER FOR REAL-TIME DASHBOARD ====================
- Line 1185: `WebSocket`
  > const wss = new WebSocket.Server({ server });

### exportRequirements (3017 matches)

**Unique patterns found:**
- `backtest`
- `debug export`
- `trade history`
- `forensic`
- `every atom`
- `cycle history`

**Sample extracts:**
- Line 26: `backtest`
  > and then you can also perform a backtest + forward test using api endpoint and then once again you need to consider absolutely every angle/investigate...
- Line 43: `backtest`
  > i would like you to forward collect/future test as well, backtest + future test and tell me what i will make.
- Line 84: `debug export`
  > (features/API surface), and (c) read your newest debug export to see if anything still blocks trades or creates...
- Line 218: `backtest`
  > + when it comes to backtesting + front/future testing, will you (the ai) be able to do so?
- Line 229: `debug export`
  > uirements, then I’ll inspect the *newly attached* debug export for any fresh red flags (trade blocks, sizing, re...

### winRateTargets (2589 matches)

**Unique patterns found:**
- `90% win rate`
- `pinnacle`
- `oracle-level`
- `deity-level`
- `winrate >= 0.40; // keep only 40%`
- `accuracy * 100).tofixed(0)}% < 50%`
- `god-tier`
- `accuracy >90%`
- `win rate, advisory = 98.0%`
- `99% win rate`
- `accuracy:</strong> 85%`
- `win rate</span></td><td>historical accuracy of predictions</td><td>55%`
- `accuracy ~72%`

**Sample extracts:**
- Line 95: `90% WIN RATE`
  > 1 LOSS PER 10 (90% WIN RATE)
- Line 156: `90% WIN RATE`
  > 1 LOSS PER 10 (90% WIN RATE)
- Line 222: `pinnacle`
  > that the plan for the bot is truly the final, the pinnacle. make sure there’s nothing else i would possibly ...
- Line 237: `pinnacle`
  > that the plan for the bot is truly the final, the pinnacle. make sure there’s nothing else i would possibly ...
- Line 1051: `PINNACLE`
  > // PINNACLE EVOLUTION

### predictionStability (1101 matches)

**Unique patterns found:**
- `conviction tier`
- `conviction lock`
- `oracle lock`
- `genesis veto`
- `flip-flop`
- `no flip-flop`
- `0% confidence`

**Sample extracts:**
- Line 2641: `CONVICTION tier`
  > // CONVICTION tier is NOT blocked by raw minConfidence (tier already implies high quality)
- Line 2654: `CONVICTION tier`
  > log(`📊 CONVICTION PASS: Raw confidence ${(confidence * 100).toFixed(1)}% < minConfidence, but CONVICTION tier bypasses this gate`, asset);
- Line 5414: `CONVICTION LOCK`
  > // CONVICTION LOCK SYSTEM (Anti-Whipsaw)
- Line 5451: `ORACLE LOCK`
  > this.oracleLocked = false;                  // TRUE ORACLE LOCK - NEVER changes once set
- Line 5864: `GENESIS VETO`
  > log(`⚠️ GENESIS VETO ACTIVATED ⚠️`, this.asset);

### deploymentDecisions (45 matches)

**Unique patterns found:**
- `render.yaml`
- `polyprophet-final`
- `node server.js`
- `debug-archive`
- `rootdir`

**Sample extracts:**
- Line 84: `render.yaml`
  > to (a) confirm what GitHub says is “production” (`render.yaml` + `POLYPROPHET-FINAL/`), (b) compare that to wha...
- Line 297: `POLYPROPHET-FINAL`
  > 1. Replace `POLYPROPHET-FINAL/server.js` with the fully-featured repo-root `server.js`
- Line 298: `POLYPROPHET-FINAL`
  > 2. Copy the root `public/` folder contents to `POLYPROPHET-FINAL/public/`
- Line 299: `POLYPROPHET-FINAL`
  > 3. Update `POLYPROPHET-FINAL/package.json` to match root dependencies
- Line 303: `POLYPROPHET-FINAL`
  > Now I'll implement the unification. First, let me copy the repo-root `server.js` to `POLYPROPHET-FINAL/server.js`:

---

## Key Extracted Requirements

Based on pattern frequency and context:

### Bankroll Goals
- Start from £5, target rapid growth
- Aspirational: £5 → £100 in 24 hours (requires ~20x compound)
- Realistic projections vary by strategy (see POLYPROPHET-FINAL/README.md)

### Win-Rate Targets
- Target: 90%+ (aspirational deity/oracle level)
- Backtest evidence: CONVICTION tier at high prices shows 98-99% accuracy
- Genesis model: 93-94% accuracy (dominant signal)

### Variance Constraints
- Minimal to zero losses
- Kill switches on loss streaks
- Circuit breaker with drawdown thresholds

### Prediction Stability
- No flip-flopping: once locked, hold the prediction
- Oracle lock with Genesis veto (Genesis must agree)
- No permanent WAIT/0% confidence states

### Feed Liveness
- 24/7 non-dormant operation
- Live price feed updates continuously
- Backup feed handling (no stale prices)

### Deployment
- Single source of truth for production
- Render deploy via render.yaml
- Debug/archive artifacts separated from main deploy

### Golden Mean Strategy
- Balance trade frequency with variance control
- State machine: OBSERVE → HARVEST → STRIKE
- EV-based gating with liquidity guards
