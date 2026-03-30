# Hooks & Automation Reference

> **Note**: ECC's hooks system (hooks.json) relies on Claude Code's plugin infrastructure.
> In Antigravity, these are documented as reference principles — not executable hooks.

## Hook-Like Checks to Apply Manually

### Pre-Edit Checks
- Before editing `server.js` or `lib/*.js`: verify you understand the current behavior
- Before editing config: verify env var implications
- Before editing strategy artifacts: verify walk-forward validation evidence

### Post-Edit Checks
- After editing runtime JS: `node --check server.js`
- After editing config: verify downstream impact on IS_LIVE flag chain
- After editing dashboard: verify UI matches API truth
- After any change: `npm test` if tests exist

### Pre-Commit Checks
- No secrets in source code (grep for API keys, tokens, passwords)
- No `console.log` in production paths
- README reflects current state

## TodoWrite Best Practices

Use todo lists to:
- Track progress on multi-step tasks
- Verify understanding of instructions
- Show granular implementation steps

Todo list reveals:
- Out of order steps
- Missing items
- Extra unnecessary items
- Wrong granularity
- Misinterpreted requirements
