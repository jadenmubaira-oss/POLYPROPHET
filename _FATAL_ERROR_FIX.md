# Fatal Error Handling Fix Documentation

**For Editor Implementation**
**Generated**: 2026-01-03

---

## Current Status (v70)

The v69 fix added `server.on('error')` handler that correctly exits on EADDRINUSE:

```javascript:15625:15634:server.js
// 🏆 v69: Handle listen errors properly - EADDRINUSE should exit so Render restarts
server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
        log(`🔴 FATAL: Port ${PORT} is already in use - exiting to allow restart`);
        process.exit(1);
    } else {
        log(`🔴 SERVER ERROR: ${err.message}`);
        process.exit(1);
    }
});
```

**This fix is in place and should work correctly for EADDRINUSE.**

---

## Remaining Risk: Global uncaughtException Handler

The global handlers at lines 15804-15817 catch ALL uncaught errors and explicitly say "DON'T EXIT - keep running":

```javascript:15804:15817:server.js
process.on('uncaughtException', (error) => {
    log(`🔴 UNCAUGHT EXCEPTION: ${error.message}`);
    log(`Stack: ${error.stack}`);
    // DON'T EXIT - keep running
});

process.on('unhandledRejection', (reason, promise) => {
    log(`🔴 UNHANDLED REJECTION: ${reason}`);
    if (reason instanceof Error) {
        log(`Stack: ${reason.stack}`);
    }
    // DON'T EXIT - keep running
});
```

### Why This Is a Problem

1. **Pre-startup errors** - If ANY error occurs before `server.listen()` succeeds, the process continues in a broken state
2. **Fatal runtime errors** - Certain errors should ALWAYS exit (out-of-memory, assertion failures, invariant violations)
3. **LIVE mode risk** - A half-alive process in LIVE mode could make unexpected trades or fail to execute critical safety blocks

---

## Recommended Fix (for Editor to Implement)

### Option A: Startup Completion Flag (Recommended)

Add a flag to track startup completion, and exit on ANY error during startup:

```javascript
// Add near the top of server.js (after imports, before startup())
let startupCompleted = false;

// Modify the uncaughtException handler:
process.on('uncaughtException', (error) => {
    log(`🔴 UNCAUGHT EXCEPTION: ${error.message}`);
    log(`Stack: ${error.stack}`);
    
    // 🏆 v71: ALWAYS exit during startup - can't recover from startup failures
    if (!startupCompleted) {
        log(`🔴 FATAL: Uncaught exception during startup - exiting`);
        process.exit(1);
    }
    
    // After startup, only continue for non-fatal errors
    // Fatal errors should still exit
    const fatalCodes = ['EADDRINUSE', 'EACCES', 'ENOENT', 'ENOMEM'];
    if (error.code && fatalCodes.includes(error.code)) {
        log(`🔴 FATAL: ${error.code} - exiting`);
        process.exit(1);
    }
    
    // For non-fatal runtime errors, keep running but log clearly
    log(`⚠️ Non-fatal error - continuing operation`);
});

// Set the flag in server.listen() callback:
server.listen(PORT, () => {
    startupCompleted = true;  // <-- ADD THIS LINE
    log(`⚡ SUPREME DEITY SERVER ONLINE on port ${PORT}`);
    // ... rest of callback
});
```

### Option B: Exit on All uncaughtExceptions (Simpler but Stricter)

```javascript
process.on('uncaughtException', (error) => {
    log(`🔴 UNCAUGHT EXCEPTION: ${error.message}`);
    log(`Stack: ${error.stack}`);
    // v71: Always exit - uncaught exceptions indicate programming errors
    process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
    log(`🔴 UNHANDLED REJECTION: ${reason}`);
    if (reason instanceof Error) {
        log(`Stack: ${reason.stack}`);
    }
    // v71: Always exit - unhandled rejections are bugs
    process.exit(1);
});
```

**Note**: Option B is stricter and may cause restarts on minor network errors that are currently survived. Option A is the recommended balance.

---

## Testing the Fix

After implementing:

1. **Test EADDRINUSE**: Start server twice on same port
   - Expected: Second instance exits immediately with "Port already in use"
   
2. **Test startup error**: Temporarily add `throw new Error('test')` before `server.listen()`
   - Expected: Process exits with "FATAL: Uncaught exception during startup"

3. **Test runtime non-fatal**: After server is running, trigger a non-critical error
   - Expected (Option A): Process logs warning but continues
   - Expected (Option B): Process exits

---

## Summary

| Scenario | Current v70 | After Fix |
|----------|------------|-----------|
| EADDRINUSE | ✅ Exits correctly (v69 fix) | ✅ Exits correctly |
| Other startup error | ❌ Continues broken | ✅ Exits (Option A/B) |
| Runtime fatal error | ❌ Continues | ✅ Exits |
| Runtime non-fatal | ✅ Continues | Option A: ✅ Continues / Option B: ❌ Exits |

---

*Documentation for v71 fatal error handling improvement*
