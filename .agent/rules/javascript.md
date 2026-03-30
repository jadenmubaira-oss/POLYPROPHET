# JavaScript / Node.js Coding Standards

## Language Patterns

### Strict Mode
- Use `'use strict'` or ES modules
- Prefer `const` over `let`, avoid `var`
- Use arrow functions for callbacks and short functions
- Use template literals for string interpolation

### Async/Await
- Always use async/await over raw Promises where possible
- Always handle errors with try/catch or .catch()
- Use Promise.all() for parallel independent async operations
- Add timeouts to all external API calls

### Error Handling
- Custom error classes for domain errors
- Structured error responses with status codes
- Never swallow errors silently
- Log errors with context (function name, inputs, stack)

### Module Organization
- One export per file when practical
- Group related functionality in `lib/` modules
- Keep `server.js` as thin orchestrator, heavy logic in `lib/`
- Use destructured imports for clarity

## Node.js Backend Patterns

### Express Best Practices
- Validate request body/params with schema validation
- Use middleware for cross-cutting concerns (auth, logging, rate limiting)
- Set timeouts on all external HTTP calls
- Don't leak internal error details to clients

### Environment Configuration
- All config via environment variables
- Validate required env vars at startup
- Use sensible defaults for optional vars
- Never hardcode API keys, passwords, or tokens

### Performance
- Avoid synchronous I/O in request handlers
- Use streaming for large data transfers
- Implement proper connection pooling
- Cache expensive computations with TTL

## POLYPROPHET-Specific JS Conventions

- `server.js` is the Express entry point + orchestrator loop
- `lib/config.js` handles ALL env var parsing — add new vars there
- `lib/strategy-matcher.js` must not mutate strategy set objects
- `lib/risk-manager.js` returns new state objects, not mutations
- `lib/trade-executor.js` manages the CLOB order lifecycle
- Always check the IS_LIVE flag chain before adding new trade paths
