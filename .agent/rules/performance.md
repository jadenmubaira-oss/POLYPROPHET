# Performance Optimization

## Context Window Management

Avoid last 20% of context window for:
- Large-scale refactoring
- Feature implementation spanning multiple files
- Debugging complex interactions

Lower context sensitivity tasks:
- Single-file edits
- Independent utility creation
- Documentation updates
- Simple bug fixes

## Build Troubleshooting

If build fails:
1. Analyze error messages
2. Fix incrementally
3. Verify after each fix with `node --check server.js`
4. Run `npm test` if tests exist

## POLYPROPHET Performance Notes

- `server.js` is ~22KB — keep it lean
- Strategy matching runs on every orchestrator cycle — keep it O(n) where n = strategy count
- Min-order bump path is the critical fast-path at micro bankrolls
- Avoid blocking I/O in the orchestrator loop
- Polymarket CLOB API calls should have timeouts configured
