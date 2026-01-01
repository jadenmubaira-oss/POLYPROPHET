# POLYPROPHET v51 — FINAL ACCEPTANCE CHECKLIST

**Generated**: 2026-01-01T15:15:00Z  
**Verified by**: GPT-5.2 (Architect/Planner)  
**For implementation by**: Claude/Opus 4.5

---

## EXECUTIVE SUMMARY

| Category | Status | Notes |
|----------|--------|-------|
| **Backtest (cycleHistory)** | ⚠️ PASS WITH CAVEATS | 94.5% CONVICTION WR, but data is model predictions not executed trades |
| **Forward Test (Polymarket-verified)** | ⚠️ NEEDS ATTENTION | 77.3% CONVICTION WR (n=44) - lower than backtest |
| **Config Drift** | ❌ FAIL | GOAT preset shallow-replaces CONFIG, drops safety keys |
| **SOL Disabled** | ✅ PASS | No v51 SOL trades, SOL.enabled=false confirmed |
| **Liveness** | ✅ PASS | Health endpoint reports ok, circuit breaker active |

---

## A) ONE-PRESET / NO-CONFUSION INVARIANTS

### A1. Single Preset ✅ PASS
- UI exposes only **GOAT** preset button
- `/api/settings` reports `ACTIVE_PRESET: "GOAT"`

### A2. No Config Drift ❌ FAIL (CRITICAL)
**Evidence**: After GOAT preset applied, these safety keys are **NULL/MISSING**:
- `ORACLE.adaptiveModeEnabled` = null (should be true)
- `RISK.enableCircuitBreaker` = null (should be true)  
- `RISK.enableDivergenceBlocking` = null (should be true)

**Root cause**: `applyPreset()` does shallow replace of `CONFIG.ORACLE` and `CONFIG.RISK`, overwriting the baseline with only the keys defined in the preset.

**Required fix (for Opus/Claude)**:
```javascript
// In applyPreset(), change from:
Object.assign(CONFIG.ORACLE, preset.ORACLE);
// To deep-merge that preserves existing keys:
CONFIG.ORACLE = { ...CONFIG.ORACLE, ...preset.ORACLE };
CONFIG.RISK = { ...CONFIG.RISK, ...preset.RISK };
```

### A3. SOL Permanently Disabled ✅ PASS
- `ASSET_CONTROLS.SOL.enabled = false` in deployed config
- Collector snapshots do NOT include SOL markets
- v51 trade history: **0 SOL trades**
- Legacy SOL trades (v45-v47) still visible but clearly labeled with old configVersion

---

## B) BACKTEST LEGITIMACY

### B1. Dedupe Proof ✅ PASS
- **Debug files**: 121
- **Raw cycles**: 3,524
- **Unique cycles** (dedup by asset+cycleEndTime): **2,234**
- **Duplicates removed**: 1,290
- **Runtime**: ~10.3 seconds

### B2. Backtest Scope Clarity ⚠️ NEEDS UI FIX
Current `/api/backtest-proof` is **oracle-cycle prediction backtest**, NOT executed-trade backtest.
- Uses `cycleHistory.wasCorrect` which is `predicted === (finalPrice >= startPrice ? 'UP' : 'DOWN')`
- Does NOT include ILLIQUIDITY_GAP trades
- Does NOT apply live gates (genesis veto, EV gate, spread guard)

**UI Issue**: Backtest button calls `tier=ALL&prices=ALL` which **BUSTS** (balance goes to $1 after 7 trades)

**Required fix (for Opus/Claude)**:
- Change default backtest params to `tier=CONVICTION&prices=ALL`
- Add clear label: "Oracle Cycle Prediction Backtest (not executed trades)"

### B3. Polymarket-Native Backtest ❌ NOT IMPLEMENTED
The ideal backtest would:
1. Use collector snapshots (Polymarket-sourced prices)
2. Label outcomes by querying Gamma API after resolution
3. Replay the actual live gates

**Current state**: Collector has 29 snapshots with ~7 hours coverage (gaps up to 42h)

---

## C) FORWARD TEST VALIDITY

### C1. Coverage ⚠️ INSUFFICIENT
- **Snapshots**: 29 (in Redis)
- **Time span**: 48.9 hours
- **Max gap**: 42.4 hours
- **Required**: ≥200 snapshots, max gap ≤30 minutes

### C2. Outcomes ✅ VERIFIABLE
Outcomes CAN be determined from Polymarket Gamma API:
- `outcomePrices = "[\"1\", \"0\"]"` means UP won
- `outcomePrices = "[\"0\", \"1\"]"` means DOWN won

### C3. Price Correctness ⚠️ NEEDS CLARIFICATION
- Snapshot `yesPrice`/`noPrice` differs from Gamma `outcomePrices`
- Snapshot may be mid-cycle, Gamma shows post-resolution
- Need to document: snapshot prices are live mid-cycle, not resolution prices

---

## D) GOAL FIT: MAX PROFIT ASAP + MIN VARIANCE

### D1. CONVICTION Quality ⚠️ INVESTIGATION NEEDED
**Backtest (cycleHistory)**:
- CONVICTION: 727W/42L = **94.54%** (n=769)

**Forward Test (Polymarket-verified, all assets, 29 snapshots)**:
- CONVICTION: 34W/10L = **77.3%** (n=44)

**Gap**: ~17% accuracy drop from backtest to forward test

**Possible causes**:
1. Different time periods (backtest: Dec 18 - Jan 1, forward: ~7 hours of Jan 1)
2. Sample size (769 vs 44)
3. Regime shift (Jan 1 shows worse performance)
4. XRP anomaly: cycleHistory shows XRP CONVICTION at 48.8% on Jan 1

**Per-asset forward test (Polymarket-verified)**:
| Asset | CONVICTION W/L | Win Rate |
|-------|----------------|----------|
| BTC | 9W/2L | 81.8% |
| ETH | 10W/2L | 83.3% |
| XRP | 15W/6L | 71.4% |

### D2. Streak Risk ✅ BOUNDED
- **Max consecutive CONVICTION losses**: 3 (in backtest)
- **Circuit breaker**: Active, currently in SAFE_ONLY state
- **Current drawdown**: 23.5% (from $4.25 to $3.25)

### D3. Regime Shifts ⚠️ NOT AUTO-DETECTED
System does NOT automatically detect accuracy drift and disable assets.

**Required fix (for Opus/Claude)**:
- Implement rolling accuracy tracker per asset
- Auto-disable asset when rolling CONVICTION WR drops below 70%
- Add drift detection to `/api/health`

---

## E) SAFETY / FAILURE MODES

### E1. Genesis/Oracle Failure Handling ⚠️ PARTIAL
- Circuit breaker exists and is working (currently in SAFE_ONLY)
- BUT: No explicit "genesis unavailable" detection
- No health gate for stale/missing Genesis model

### E2. Liveness ✅ PASS
- `/api/health` reports `status: "ok"`
- Watchdog: `lastCycleAge: 341s`, `lastTradeAge: 1241s`
- Memory: 46MB (healthy)

### E3. Redemption ⚠️ UNTESTED IN PAPER
- Redemption logic exists in code
- Cannot verify in PAPER mode
- Requires LIVE mode integration test

---

## IMPLEMENTATION ROADMAP FOR OPUS/CLAUDE

### Priority 1: Fix Config Drift (CRITICAL)
**File**: `server.js`
**Location**: `applyPreset()` function (~line 9897)
**Change**: Deep-merge preset into CONFIG instead of shallow replace

```javascript
async function applyPreset(preset) {
    const base = presets[preset];
    if (!base) return;
    
    // DEEP MERGE - preserve existing keys
    if (base.ORACLE) CONFIG.ORACLE = { ...CONFIG.ORACLE, ...base.ORACLE };
    if (base.RISK) CONFIG.RISK = { ...CONFIG.RISK, ...base.RISK };
    if (base.ASSET_CONTROLS) CONFIG.ASSET_CONTROLS = { ...CONFIG.ASSET_CONTROLS, ...base.ASSET_CONTROLS };
    // ... etc for other sections
    
    CONFIG.ACTIVE_PRESET = preset;
    await saveState(); // Persist to Redis
}
```

### Priority 2: Fix UI Backtest Button
**File**: `server.js`
**Location**: UI HTML (~line 9467)
**Change**: Default to `tier=CONVICTION&prices=ALL`

### Priority 3: Implement Rolling Accuracy Tracker
**File**: `server.js`
**Add**: Per-asset rolling accuracy (last 50 trades)
**Add**: Auto-disable when rolling WR < 70%
**Add**: Report in `/api/health` and `/api/state`

### Priority 4: Add Polymarket-Native Forward Test Labeling
**File**: `server.js`
**Add**: After each cycle resolution, query Gamma API to get actual outcome
**Store**: `resolvedOutcome`, `polymarketVerified` in cycleHistory
**Add**: `/api/forward-test-verified` endpoint that uses labeled data

### Priority 5: Document Price Sources
**File**: `README.md`
**Add**: Section explaining snapshot price vs resolution price
**Add**: Clarify that `wasCorrect` is based on price movement, not Polymarket bet payout

---

## FINAL VERDICT

**Is this the PINNACLE?** 

**NOT YET** — but close. The core prediction engine shows strong backtest results (94.5% CONVICTION), but:

1. **Config drift bug** means safety features can silently disappear
2. **Forward test accuracy** (77.3%) is significantly lower than backtest — needs investigation
3. **No auto-drift detection** to protect against regime changes
4. **Collector coverage** is too sparse for robust forward testing

After Opus/Claude implements the fixes above, re-run verification and the bot will be ready for "PINNACLE" status.

---

## VERIFICATION COMMANDS

After fixes are deployed, run these to verify:

```powershell
# Check config drift is fixed
$pair='bandito:bandito'; $b=[Convert]::ToBase64String([Text.Encoding]::ASCII.GetBytes($pair))
Invoke-RestMethod -Uri "https://polyprophet.onrender.com/api/settings" -Headers @{ Authorization = "Basic $b" } | Select-Object -ExpandProperty ORACLE | Select-Object adaptiveModeEnabled, minConfidence
Invoke-RestMethod -Uri "https://polyprophet.onrender.com/api/settings" -Headers @{ Authorization = "Basic $b" } | Select-Object -ExpandProperty RISK | Select-Object enableCircuitBreaker, enableDivergenceBlocking

# Check backtest button works
curl "https://polyprophet.onrender.com/api/backtest-proof?tier=CONVICTION&prices=ALL" -u bandito:bandito

# Check forward test has outcomes
curl "https://polyprophet.onrender.com/api/forward-test" -u bandito:bandito
```

---

*Checklist generated by GPT-5.2 (Architect) for Claude/Opus 4.5 implementation*
