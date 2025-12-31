# Runtime Candidates Reconciliation

Generated: 2025-12-31

## Render Configuration (render.yaml)

| Field | Value |
|-------|-------|
| service name | `polyprophet-final` |
| rootDir | `POLYPROPHET-FINAL` |
| startCommand | `node server.js` |
| healthCheckPath | `/api/health` |

## Discovered server.js Files

| Path | Size | SHA256 | Notes |
|------|------|--------|-------|
| `server.js` (root) | 626,972 B | `2A18AD52...94BD` | CONFIG_VERSION 45, /api/version present |
| `POLYPROPHET-FINAL/server.js` | 626,972 B | `2A18AD52...94BD` | Identical to root (same hash) |
| `POLYPROPHET-2d.../server.js` | 480,361 B | `5F58E1A1...A922` | Older monolith variant |
| `POLYPROPHET-2d_extracted/.../server.js` | 466,982 B | (legacy) | Even older extract from zip |
| `p2/server.js` | 15,581 B | (modular stub) | Small modular entrypoint |

## Key Findings

1. **Root `server.js` and `POLYPROPHET-FINAL/server.js` are byte-identical** (same SHA256 hash). This is good—no conflict between them.

2. **Both have `/api/version` and `/api/health` endpoints** returning `CONFIG_VERSION: 45` and `CODE_FINGERPRINT`.

3. **The d7ca snapshot folder no longer contains a server.js** (it was likely removed during prior cleanup); only the d7ca debug logs remain.

4. **p2/server.js is a small modular stub** (15 KB), not a full candidate for production.

## Conclusion

There are effectively **two candidates**:

| Candidate | Description |
|-----------|-------------|
| A: Root/FINAL (v45) | The current deployed code in root and `POLYPROPHET-FINAL/` (identical copies). GOAT v3 features. |
| B: 2d monolith | Older 480 KB server from the `POLYPROPHET-2d...` folder. No v45 features. |

Since A is already deployed and actively maintained (v45), and B is an older snapshot, the bake-off will primarily verify that A passes all acceptance checks.

## /api/version Fingerprint Path

Both root and POLYPROPHET-FINAL expose:
- `GET /api/version` → returns `{ configVersion, gitCommit, serverSha256, nodeVersion, uptime }`
- `GET /api/health` → returns status + code fingerprint

This satisfies the "reliable fingerprint" requirement.
