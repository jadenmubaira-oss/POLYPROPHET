# POLYPROPHET Log Provenance Report

**Generated**: 2026-01-03
**Current Codebase**: v70 (commit 6b4c6c3)

---

## Log File Analysis

| Log File | Config Version | Likely Commit | Notes |
|----------|---------------|---------------|-------|
| `_server_log.txt` | **Unknown (pre-v69)** | Before 63290fc | Stack trace shows `server.js:14889` but v70 has `server.listen()` at line 15636. EADDRINUSE was caught by uncaughtException handler (bug fixed in v69). |
| `_light_server.out.txt` | **55** | ~v55 | LIGHT_MODE run, no trading loops |
| `_test_server.out.txt` | **61** | ~v61 | Contains 33MB of test output |

### Critical Finding: `_server_log.txt` is from BEFORE v69

Evidence:
1. Stack trace shows `server.js:14889:12` for `server.listen()` call
2. Current v70 code has `server.listen()` at line **15636** (~750 lines later)
3. EADDRINUSE was caught by `uncaughtException` handler instead of `server.on('error')`
4. v69 changelog explicitly states: "EADDRINUSE fail-fast (ADDED)"
5. Process continued running after bind failure (lines 29-93 show continued WS activity)

**Conclusion**: The `_server_log.txt` does NOT represent v70 behavior. The EADDRINUSE fail-fast fix in v69+ should prevent this issue on the current codebase.

---

## Required Startup Banner (for Editor to Implement)

Add the following at the START of the `startup()` function callback or immediately after `server.listen()` success:

```javascript
// In server.listen() callback, add as first log:
const pkgVersion = require('./package.json').version;
let gitCommit = 'unknown';
try {
    gitCommit = require('child_process')
        .execSync('git rev-parse --short HEAD', { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] })
        .trim();
} catch (e) { /* ignore */ }

log(`========================================`);
log(`POLYPROPHET DEPLOYMENT BANNER`);
log(`  CONFIG_VERSION: ${CONFIG_VERSION}`);
log(`  package.json version: ${pkgVersion}`);
log(`  git commit: ${gitCommit}`);
log(`  TRADE_MODE: ${CONFIG.TRADE_MODE}`);
log(`  LIGHT_MODE: ${LIGHT_MODE}`);
log(`  Redis connected: ${redisAvailable}`);
log(`  Wallet loaded: ${!!tradeExecutor.wallet}`);
log(`  Timestamp: ${new Date().toISOString()}`);
log(`========================================`);
```

This ensures every log file can be traced to an exact version + commit.

---

## Verification Commands

To verify the deployed version matches v70:

```bash
# Check version endpoint
curl "https://polyprophet.onrender.com/api/version?apiKey=bandito"
# Should return: { "configVersion": 70, "version": "3.6.0-goat-v70", ... }

# Check health endpoint
curl "https://polyprophet.onrender.com/api/health?apiKey=bandito"
# Should include dataFeed and balanceFloor sections (v70 features)
```

---

## Action Items for Editor

1. **Add startup banner** (code above) to `server.js` in the `server.listen()` callback
2. **Delete or rename old log files** (`_server_log.txt`, `_light_server.out.txt`, `_test_server.out.txt`) to avoid confusion
3. **Re-run local test** and capture fresh log that shows v70 startup banner
4. **Verify deployed Render instance** is running v70 via `/api/version`

---

*Report generated as part of GOAT final audit*
