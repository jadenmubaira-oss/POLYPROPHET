---
name: performance-optimizer
description: Node.js runtime performance analysis and optimization for POLYPROPHET. Identifies bottlenecks in the orchestrator loop, market discovery, strategy matching, and order execution. Use when the bot is slow, hanging, or consuming excessive resources.
---

# Performance Optimizer

Adapted from ECC `agents/performance-optimizer.md` for POLYPROPHET's Node.js trading runtime.

## Core Responsibilities

1. **Orchestrator Loop** -- Identify tick delays, blocking calls, memory leaks in the 2s tick loop
2. **Market Discovery** -- Profile Gamma API and CLOB price fetch latency
3. **Order Execution** -- Measure CLOB order submission, fill verification, and retry timing
4. **Memory** -- Detect state accumulation in diagnosticLog, trade history, market cache
5. **Network** -- Profile proxy vs direct fetch paths, timeout handling

## POLYPROPHET-Specific Checks

- `server.js` orchestrator tick interval vs actual tick duration
- `lib/market-discovery.js` fetch timeouts and retry behavior
- `lib/trade-executor.js` balance refresh blocking
- `lib/clob-client.js` proxy overhead
- `data/runtime-state.json` disk persistence frequency

## Analysis Commands

```bash
node --check server.js
node --prof server.js
node --inspect server.js
```

## Performance Targets

| Metric | Target | Why |
|--------|--------|-----|
| Tick loop completion | < 2s | Must complete before next tick |
| Market discovery | < 5s per cycle | Timeout currently 15s |
| Balance refresh | < 5s | Was previously blocking indefinitely |
| Order submission | < 10s | Including proxy round-trip |
| Memory growth | < 50MB/hour | Prevent OOM on free-tier Render |
