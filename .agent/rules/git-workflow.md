# Git Workflow

## Commit Message Format
```
<type>: <description>

<optional body>
```

Types: feat, fix, refactor, docs, test, chore, perf, ci

## Pull Request Workflow

When creating PRs:
1. Analyze full commit history (not just latest commit)
2. Use `git diff [base-branch]...HEAD` to see all changes
3. Draft comprehensive PR summary
4. Include test plan with TODOs
5. Push with `-u` flag if new branch

## POLYPROPHET Deploy Workflow

1. Push to `origin/main`
2. Open Render dashboard → polyprophet service → Manual Deploy
3. Wait for build (~2-5 min)
4. Verify via `GET /api/health`

**Note**: Auto-deploy is NOT configured. Manual deploy via Render dashboard is required.
