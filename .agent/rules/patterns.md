# Common Patterns

## Repository Pattern

Encapsulate data access behind a consistent interface:
- Define standard operations: findAll, findById, create, update, delete
- Concrete implementations handle storage details (database, API, file, etc.)
- Business logic depends on the abstract interface, not the storage mechanism
- Enables easy swapping of data sources and simplifies testing with mocks

## API Response Format

Use a consistent envelope for all API responses:
- Include a success/status indicator
- Include the data payload (nullable on error)
- Include an error message field (nullable on success)
- Include metadata for paginated responses (total, page, limit)

## POLYPROPHET Architecture Patterns

### Signal Flow
```
Market Discovery (Gamma API) → Strategy Matcher → Risk Manager → Trade Executor → Resolution → Bankroll Update
```

### Config-Driven Behavior
- All runtime behavior controlled via `lib/config.js` and env vars
- Strategy sets loaded from `debug/strategy_set_*.json` artifacts
- Adaptive bankroll profiles auto-select based on balance thresholds

### State Persistence
- In-memory runtime state with `data/runtime-state.json` disk backup
- Crash recovery via state reload on restart
- Sell retry queue for partial fills and retries
