# TypeScript / JavaScript Review Guardrails

## Scope

Apply these rules to `.ts`, `.tsx`, `.js`, and `.jsx` changes.

## Mandatory Checks

- Establish real diff scope before reviewing.
- Run the project's canonical typecheck or syntax validation when relevant.
- Stop and report if lint, type, or syntax checks fail.
- Read surrounding context before reporting issues.

## Security

- Never allow hardcoded secrets, proxy credentials, or private keys.
- Reject dynamic execution with untrusted input.
- Reject unsafe filesystem paths built from unvalidated input.
- Validate external inputs at request boundaries.

## Async Correctness

- No floating promises without explicit handling.
- No silent `catch` blocks.
- Use parallelization for independent async work.
- Avoid `async` callbacks inside `forEach`.

## Runtime Integrity

- Keep `server.js` thin when practical.
- Add new env parsing in `lib/config.js`.
- Preserve truthful API and dashboard surfaces.
- Compare against `legacy-root-runtime/` before changing central execution behavior.
- Do not claim live readiness without real accepted order proof.

## Documentation Continuity

- After substantial JS or TS changes, update `README.md` if repo truth changed.
- Keep `AGENTS.md` and workflow docs aligned with actual harness behavior.
