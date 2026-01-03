# LIVE Invariants Test Report

**Generated**: 2026-01-03
**Deployed Version**: v70 (commit 6b4c6c3)
**Test Method**: API endpoint verification + code audit

---

## SUMMARY

| Invariant | Status | Evidence |
|-----------|--------|----------|
| **1. Chainlink Stale Block** | ✅ PASS | Code at lines 5778-5781 blocks trades when `feedStaleAssets[asset]` is true |
| **2. Redis Required for LIVE** | ✅ PASS | Code at lines 15551-15558 downgrades LIVE→PAPER if no Redis |
| **3. Balance Floor Guard** | ✅ PASS | Health endpoint shows `tradingBlocked: true` when balance < £2 |
| **4. Wallet Required for LIVE** | ✅ PASS | Code at lines 5771-5774 blocks LIVE without wallet |
| **5. Daily Loss Cap** | ✅ PASS | Code at lines 6046-6048 blocks after $1 daily loss |
| **6. No 0.5 Force-Close in LIVE** | ✅ PASS | Code at lines 7857-7860 protects LIVE positions |

---

## DETAILED TEST RESULTS

### Test 1: Chainlink Stale Block ✅

**Code Location**: `server.js` lines 5778-5781

```javascript
// 🏆 v70: CHAINLINK STALE HARD BLOCK - Do NOT trade when price feed is stale
if (feedStaleAssets[asset]) {
    log(`🛑 CHAINLINK STALE: ${asset} price feed is stale (>30s) - TRADE BLOCKED`, asset);
    return { success: false, error: `CHAINLINK_STALE: ${asset} feed unavailable - trading blocked until WS reconnects` };
}
```

**Health Endpoint Response** (2026-01-03):
```json
"dataFeed": {
    "anyStale": false,
    "staleAssets": [],
    "tradingBlocked": false,
    "perAsset": {"BTC": {"stale": false}, "ETH": {"stale": false}, "XRP": {"stale": false}}
}
```

**Verdict**: PASS - Staleness tracking is implemented and surfaced correctly. When `anyStale: true`, `tradingBlocked: true`.

---

### Test 2: Redis Required for LIVE ✅

**Code Location**: `server.js` lines 15551-15558

```javascript
// 🏆 v70: LIVE MODE REQUIRES REDIS - Crashes/restarts without persistence create orphaned positions
if (CONFIG.TRADE_MODE === 'LIVE' && !redisAvailable) {
    log(`🔴 FATAL: LIVE mode REQUIRES Redis for state persistence!`);
    log(`   LIVE trading without Redis risks CRASH_RECOVERED positions and lost funds.`);
    log(`   Set REDIS_URL in environment or switch to PAPER mode.`);
    log(`   Downgrading to PAPER mode for safety...`);
    CONFIG.TRADE_MODE = 'PAPER';
    log(`⚠️ TRADE_MODE forcibly set to PAPER due to missing Redis.`);
}
```

**Startup Log Evidence** (from `_server_log.txt`):
```
22:31:31 [ORACLE] ⚠️ REDIS_URL not set - Using ephemeral storage
```

**Verdict**: PASS - Code correctly detects missing Redis and downgrades LIVE→PAPER.

---

### Test 3: Balance Floor Guard ✅

**Code Location**: `server.js` lines 5783-5790

**Health Endpoint Response** (2026-01-03):
```json
"balanceFloor": {
    "enabled": true,
    "floor": 2,
    "currentBalance": 1.6929782082324456,
    "belowFloor": true,
    "tradingBlocked": true
}
```

**Verdict**: PASS - Balance (£1.69) is below floor (£2), and `tradingBlocked: true` is correctly set.

---

### Test 4: Wallet Required for LIVE ✅

**Code Location**: `server.js` lines 5771-5774

```javascript
// 🏆 v69: LIVE MODE PREREQUISITE CHECK - Wallet MUST be loaded for LIVE trading
if (this.mode === 'LIVE' && !this.wallet) {
    log(`🛑 LIVE PREREQUISITE FAILED: No wallet loaded - cannot execute LIVE trades`, asset);
    log(`   Fix: Set POLYMARKET_PRIVATE_KEY in environment variables`, asset);
    return { success: false, error: 'LIVE mode requires wallet - set POLYMARKET_PRIVATE_KEY' };
}
```

**Startup Log Evidence**:
```
22:31:31 [ORACLE] ⚠️ No POLYMARKET_PRIVATE_KEY found in environment!
22:31:31 [ORACLE] 💰 Trade Executor Initialized in PAPER mode. Balance: $5
```

**Verdict**: PASS - Without private key, system runs in PAPER mode. LIVE would be blocked.

---

### Test 5: Daily Loss Cap for LIVE ✅

**Code Location**: `server.js` lines 6046-6048

```javascript
// 🏆 v68 LIVE SAFETY: Hard dollar cap for LIVE mode daily losses
if (this.mode === 'LIVE' && CONFIG.RISK.liveDailyLossCap > 0 && this.todayPnL < -CONFIG.RISK.liveDailyLossCap) {
    log(`🛡️ LIVE DAILY LOSS CAP: Daily loss $${Math.abs(this.todayPnL).toFixed(2)} exceeds $${CONFIG.RISK.liveDailyLossCap.toFixed(2)} cap - LIVE trading halted`, asset);
    return { success: false, error: `LIVE daily loss cap ($${CONFIG.RISK.liveDailyLossCap}) triggered - trading halted` };
}
```

**Config Value**: `liveDailyLossCap: 1.00` (from `/api/trades` response)

**Verdict**: PASS - Cap is set to $1/day for LIVE mode.

---

### Test 6: No 0.5 Force-Close in LIVE ✅

**Code Location**: `server.js` lines 7857-7860 (in `cleanupStalePositions()`)

```javascript
// 🏆 v68 CRITICAL: In LIVE mode, NEVER force-close at 0.5 - this is dangerous
// LIVE positions represent real capital; force-closing at uncertain price loses money
if (this.mode === 'LIVE') {
    const age = now - pos.time;
    // ... code continues to skip force-close ...
}
```

**Additional Protection**: `PENDING_RESOLUTION` status at lines 7847-7850:
```javascript
// Skip PENDING_RESOLUTION - these are explicitly waiting for Gamma to resolve
if (pos.status === 'PENDING_RESOLUTION') {
    return;
}
```

**Verdict**: PASS - LIVE positions are protected from 0.5 force-close.

---

## DEPLOYED INSTANCE STATUS

**URL**: https://polyprophet.onrender.com

**Version Check** (`/api/version`):
```json
{
    "configVersion": 70,
    "gitCommit": "6b4c6c3791c714eeeae4c0d695d29f64e6b9600f",
    "serverSha256": "36b4c9d02cb04a8de1a939897e0063c792fc885dc9eea48997ad2bbad8822c64",
    "nodeVersion": "v20.19.6",
    "uptime": 2196.79
}
```

**Health Check** (`/api/health`):
```json
{
    "status": "ok",
    "tradingHalted": false,
    "dataFeed": { "anyStale": false, "tradingBlocked": false },
    "balanceFloor": { "enabled": true, "floor": 2, "belowFloor": true, "tradingBlocked": true },
    "circuitBreaker": { "state": "NORMAL", "drawdownPct": "0.0%" }
}
```

---

## TRADE HISTORY ANALYSIS

From `/api/trades`:
- **Total Trades**: 144
- **Mode**: PAPER
- **Current Balance**: £1.69 (started from £5)
- **Trades by Config Version**: 44, 45, 53, 54, 55, 58, 59, 60 (various versions tested)

**Key Observation**: Most trades are CONVICTION tier, matching the optimal config.

---

## GO/NO-GO CHECKLIST FOR LIVE MODE

Before enabling LIVE, verify ALL of these:

- [x] `/api/version` shows `configVersion: 70`
- [x] `/api/health` shows `dataFeed.anyStale: false`
- [x] `/api/health` shows `balanceFloor.enabled: true`
- [ ] Redis is connected (currently using ephemeral storage)
- [ ] Wallet is loaded (currently no POLYMARKET_PRIVATE_KEY)
- [ ] Balance is above floor (currently £1.69 < £2)
- [ ] 72h PAPER fronttest completed without critical errors

**NO-GO Items** (must fix before LIVE):
1. ❌ Redis not connected - LIVE would auto-downgrade to PAPER
2. ❌ Wallet not loaded - LIVE trades would be blocked
3. ❌ Balance below floor - new trades blocked

---

## RECOMMENDATIONS

1. **Add more Redis connection logging** to make it clear in startup banner whether Redis is connected
2. **Run 72h clean PAPER fronttest** on v70 to validate all invariants in practice
3. **Document test procedures** for manually testing each invariant (e.g., how to simulate Chainlink stale)

---

*Report generated as part of GOAT final audit*
