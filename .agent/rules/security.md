# Security Guidelines

## Mandatory Security Checks

Before ANY commit:
- [ ] No hardcoded secrets (API keys, passwords, tokens)
- [ ] All user inputs validated
- [ ] SQL injection prevention (parameterized queries)
- [ ] XSS prevention (sanitized HTML)
- [ ] CSRF protection enabled
- [ ] Authentication/authorization verified
- [ ] Rate limiting on all endpoints
- [ ] Error messages don't leak sensitive data

## Secret Management

- NEVER hardcode secrets in source code
- ALWAYS use environment variables or a secret manager
- Validate that required secrets are present at startup
- Rotate any secrets that may have been exposed

## POLYPROPHET-Specific Security

- `POLYPROPHET.env` and live credentials MUST stay out of commits
- `POLYMARKET_PRIVATE_KEY` is the most sensitive credential — never log or expose
- Auth endpoints (`NO_AUTH`, `AUTH_USERNAME`, `AUTH_PASSWORD`) must be reviewed before deploy
- Proxy credentials (`PROXY_URL`) must not leak via error messages or logs

## Security Response Protocol

If security issue found:
1. STOP immediately
2. Assess exposure scope
3. Fix CRITICAL issues before continuing
4. Rotate any exposed secrets
5. Review entire codebase for similar issues
