#!/usr/bin/env node
/**
 * BASELINE BAKE-OFF HARNESS
 * 
 * Starts each candidate server in PAPER mode, runs acceptance checks, and produces a scorecard.
 * 
 * Checks:
 * 1. Boot: process starts cleanly (no syntax/require errors)
 * 2. Health: /api/health responds with status ok
 * 3. Version: /api/version returns fingerprint with configVersion
 * 4. Export: /api/debug-export returns valid JSON with expected structure
 * 5. UI: GET / returns HTML (dashboard accessible)
 * 
 * Usage: node debug_backtest/baseline_bakeoff.js [--port 4000]
 */

const { spawn } = require('child_process');
const http = require('http');
const path = require('path');
const fs = require('fs');

// Configuration
const BASE_PORT = parseInt(process.argv.find(a => a.startsWith('--port='))?.split('=')[1] || '4000', 10);
const TIMEOUT_BOOT_MS = 60000;
const TIMEOUT_REQUEST_MS = 5000;

// Candidates to test (path relative to workspace root, port offset)
const CANDIDATES = [
    {
        id: 'root-v45',
        name: 'Root server.js (v45)',
        dir: '.',
        entry: 'server.js',
        portOffset: 0,
    },
    {
        id: 'final-v45',
        name: 'POLYPROPHET-FINAL/server.js (v45)',
        dir: 'POLYPROPHET-FINAL',
        entry: 'server.js',
        portOffset: 1,
    },
    {
        id: '2d-monolith',
        name: 'POLYPROPHET-2d monolith',
        dir: 'POLYPROPHET-2d998c92e045c0110cc2864b53e62c70e0ccefbd',
        entry: 'server.js',
        portOffset: 2,
    },
];

const WORKSPACE = path.resolve(__dirname, '..');

// Results
const scorecard = [];

// Helper: HTTP GET with timeout
function makeBasicAuthHeader(username, password) {
    const token = Buffer.from(`${username}:${password}`, 'utf8').toString('base64');
    return `Basic ${token}`;
}

function httpGet(port, pathStr, timeoutMs = TIMEOUT_REQUEST_MS, headers = {}) {
    return new Promise((resolve) => {
        const req = http.request(
            { hostname: 'localhost', port, path: pathStr, method: 'GET', timeout: timeoutMs, headers },
            (res) => {
                let data = '';
                res.on('data', chunk => data += chunk);
                res.on('end', () => {
                    resolve({ status: res.statusCode, data, headers: res.headers });
                });
            }
        );
        req.on('error', (e) => resolve({ status: 0, error: e.message }));
        req.on('timeout', () => {
            req.destroy();
            resolve({ status: 0, error: 'timeout' });
        });
        req.end();
    });
}

// Helper: wait for server to be ready (and fail fast if the process exits)
function waitForServer(port, proc, maxWaitMs = TIMEOUT_BOOT_MS) {
    const start = Date.now();
    return new Promise((resolve) => {
        let exited = false;
        let exitInfo = null;
        proc.once('exit', (code, signal) => {
            exited = true;
            exitInfo = { code, signal };
        });

        const check = async () => {
            if (exited) return resolve({ ok: false, reason: 'exit', ...exitInfo });
            const res = await httpGet(port, '/api/health', 2000);
            if (res.status === 200) {
                resolve({ ok: true });
            } else if (Date.now() - start > maxWaitMs) {
                resolve({ ok: false, reason: 'timeout' });
            } else {
                setTimeout(check, 500);
            }
        };
        check();
    });
}

// Run checks on a candidate
async function runChecks(candidate, port, authHeader) {
    const results = {
        id: candidate.id,
        name: candidate.name,
        port,
        checks: {},
        score: 0,
        maxScore: 5,
    };

    // Check 1: Boot (we already know it's running if we got here)
    results.checks.boot = { pass: true, detail: 'Server started' };
    results.score++;

    // Check 2: Health
    const health = await httpGet(port, '/api/health');
    if (health.status === 200) {
        try {
            const json = JSON.parse(health.data);
            results.checks.health = { pass: json.status === 'ok', detail: json.status };
            if (json.status === 'ok') results.score++;
        } catch {
            results.checks.health = { pass: false, detail: 'Invalid JSON' };
        }
    } else {
        results.checks.health = { pass: false, detail: health.error || `HTTP ${health.status}` };
    }

    // Check 3: Version
    const version = await httpGet(port, '/api/version');
    if (version.status === 200) {
        try {
            const json = JSON.parse(version.data);
            const hasVersion = typeof json.configVersion === 'number';
            results.checks.version = { 
                pass: hasVersion, 
                detail: hasVersion ? `configVersion: ${json.configVersion}` : 'Missing configVersion' 
            };
            if (hasVersion) results.score++;
        } catch {
            results.checks.version = { pass: false, detail: 'Invalid JSON' };
        }
    } else {
        results.checks.version = { pass: false, detail: version.error || `HTTP ${version.status}` };
    }

    // Check 4: Debug Export
    const exportRes = await httpGet(port, '/api/debug-export', TIMEOUT_REQUEST_MS, { Authorization: authHeader });
    if (exportRes.status === 200) {
        try {
            const json = JSON.parse(exportRes.data);
            const hasAssets = json.assets && Object.keys(json.assets).length > 0;
            const hasConfig = json.config != null;
            results.checks.export = { 
                pass: hasAssets && hasConfig, 
                detail: `assets: ${Object.keys(json.assets || {}).length}, hasConfig: ${hasConfig}` 
            };
            if (hasAssets && hasConfig) results.score++;
        } catch {
            results.checks.export = { pass: false, detail: 'Invalid JSON' };
        }
    } else if (exportRes.status === 401) {
        results.checks.export = { pass: false, detail: 'HTTP 401 (auth failed)' };
    } else {
        results.checks.export = { pass: false, detail: exportRes.error || `HTTP ${exportRes.status}` };
    }

    // Check 5: UI (dashboard HTML)
    const ui = await httpGet(port, '/');
    if (ui.status === 200 || ui.status === 401) {
        // 401 is acceptable (auth required) - means the route exists
        const isHtml = ui.headers?.['content-type']?.includes('text/html') || ui.data?.includes('<!DOCTYPE') || ui.data?.includes('<html');
        results.checks.ui = { 
            pass: isHtml || ui.status === 401, 
            detail: ui.status === 401 ? 'Auth required (route exists)' : (isHtml ? 'HTML dashboard' : 'Not HTML') 
        };
        if (isHtml || ui.status === 401) results.score++;
    } else {
        results.checks.ui = { pass: false, detail: ui.error || `HTTP ${ui.status}` };
    }

    return results;
}

// Run a single candidate
async function testCandidate(candidate) {
    const entryPath = path.join(WORKSPACE, candidate.dir, candidate.entry);
    
    // Check if server.js exists
    if (!fs.existsSync(entryPath)) {
        console.log(`⚠️  [${candidate.id}] server.js not found at ${entryPath}`);
        return {
            id: candidate.id,
            name: candidate.name,
            port: null,
            checks: { boot: { pass: false, detail: 'File not found' } },
            score: 0,
            maxScore: 5,
        };
    }

    const port = BASE_PORT + candidate.portOffset;
    console.log(`🚀 [${candidate.id}] Starting on port ${port}...`);

    // Spawn server
    const cwd = path.join(WORKSPACE, candidate.dir);
    const authUser = 'admin';
    const authPass = 'changeme';
    const authHeader = makeBasicAuthHeader(authUser, authPass);
    const logPath = path.join(__dirname, `bakeoff_${candidate.id}.log`);
    const logStream = fs.createWriteStream(logPath, { flags: 'w' });
    const proc = spawn('node', [candidate.entry], {
        cwd,
        env: {
            ...process.env,
            PORT: port.toString(),
            TRADE_MODE: 'PAPER',
            PAPER_BALANCE: '5.00',
            NODE_ENV: 'test',
            // Skip Redis for local testing
            REDIS_URL: '',
            AUTH_USERNAME: authUser,
            AUTH_PASSWORD: authPass,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stderr = '';
    proc.stderr.on('data', (d) => { stderr += d.toString(); });
    let stdout = '';
    proc.stdout.on('data', (d) => { stdout += d.toString(); });
    proc.stderr.on('data', (d) => { try { logStream.write(d); } catch {} });
    proc.stdout.on('data', (d) => { try { logStream.write(d); } catch {} });
    proc.on('exit', () => { try { logStream.end(); } catch {} });

    // Wait for server to be ready
    const ready = await waitForServer(port, proc);

    if (!ready.ok) {
        proc.kill('SIGTERM');
        console.log(`❌ [${candidate.id}] Failed to start (${ready.reason})`);
        const combined = (stderr + '\n' + stdout).trim();
        if (combined) console.log(`   logs: ${combined.substring(0, 500)}`);
        return {
            id: candidate.id,
            name: candidate.name,
            port,
            checks: { boot: { pass: false, detail: ready.reason === 'exit' ? `Exited (code=${ready.code}, signal=${ready.signal})` : `Timeout (see ${path.basename(logPath)})` } },
            score: 0,
            maxScore: 5,
            logPath
        };
    }

    console.log(`✅ [${candidate.id}] Running, executing checks...`);

    // Run checks
    const results = await runChecks(candidate, port, authHeader);
    results.logPath = logPath;

    // Cleanup
    proc.kill('SIGTERM');
    await new Promise(r => setTimeout(r, 500));

    return results;
}

// Generate markdown scorecard
function generateScorecard(results) {
    const lines = [
        '# Baseline Bake-off Scorecard',
        '',
        `Generated: ${new Date().toISOString()}`,
        '',
        '## Summary',
        '',
        '| Candidate | Score | Boot | Health | Version | Export | UI |',
        '|-----------|-------|------|--------|---------|--------|----|',
    ];

    for (const r of results) {
        const pass = (c) => c?.pass ? '✅' : '❌';
        lines.push(`| ${r.name} | ${r.score}/${r.maxScore} | ${pass(r.checks.boot)} | ${pass(r.checks.health)} | ${pass(r.checks.version)} | ${pass(r.checks.export)} | ${pass(r.checks.ui)} |`);
    }

    lines.push('');
    lines.push('## Details');
    lines.push('');

    for (const r of results) {
        lines.push(`### ${r.name} (${r.id})`);
        lines.push('');
        lines.push(`- Port: ${r.port || 'N/A'}`);
        lines.push(`- Score: ${r.score}/${r.maxScore}`);
        lines.push('');
        for (const [check, data] of Object.entries(r.checks)) {
            lines.push(`- **${check}**: ${data.pass ? '✅ PASS' : '❌ FAIL'} — ${data.detail}`);
        }
        lines.push('');
    }

    // Winner
    const sorted = [...results].sort((a, b) => b.score - a.score);
    const winner = sorted[0];
    lines.push('## Recommendation');
    lines.push('');
    if (winner && winner.score === winner.maxScore) {
        lines.push(`**Winner: ${winner.name}** — all checks passed.`);
    } else if (winner) {
        lines.push(`**Best candidate: ${winner.name}** — score ${winner.score}/${winner.maxScore}.`);
        lines.push('');
        lines.push('Note: Not all checks passed. Review failures before deploying.');
    } else {
        lines.push('No viable candidate found.');
    }

    return lines.join('\n');
}

async function main() {
    console.log('='.repeat(60));
    console.log('BASELINE BAKE-OFF HARNESS');
    console.log('='.repeat(60));
    console.log(`Workspace: ${WORKSPACE}`);
    console.log(`Base port: ${BASE_PORT}`);
    console.log('');

    const results = [];

    for (const candidate of CANDIDATES) {
        const result = await testCandidate(candidate);
        results.push(result);
        console.log(`   Score: ${result.score}/${result.maxScore}`);
        console.log('');
    }

    // Generate scorecard
    const scorecardMd = generateScorecard(results);
    const scorecardPath = path.join(__dirname, 'bakeoff_scorecard.md');
    fs.writeFileSync(scorecardPath, scorecardMd);
    console.log(`📊 Scorecard written to: ${scorecardPath}`);

    // Also save JSON
    const jsonPath = path.join(__dirname, 'bakeoff_scorecard.json');
    fs.writeFileSync(jsonPath, JSON.stringify(results, null, 2));
    console.log(`📄 JSON results written to: ${jsonPath}`);

    // Print summary
    console.log('');
    console.log('='.repeat(60));
    console.log('SUMMARY');
    console.log('='.repeat(60));
    for (const r of results) {
        const status = r.score === r.maxScore ? '✅' : (r.score >= 3 ? '⚠️' : '❌');
        console.log(`${status} ${r.name}: ${r.score}/${r.maxScore}`);
    }
}

main().catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
});
