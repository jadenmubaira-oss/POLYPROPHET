#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
let passed = 0;
let failed = 0;
const results = [];

function check(name, fn) {
    try {
        const result = fn();
        if (result) {
            results.push({ name, status: 'PASS' });
            passed++;
        } else {
            results.push({ name, status: 'FAIL', detail: 'returned false' });
            failed++;
        }
    } catch (e) {
        results.push({ name, status: 'FAIL', detail: e.message });
        failed++;
    }
}

// Authority files
check('README.md exists', () => fs.existsSync(path.join(ROOT, 'README.md')));
check('AGENTS.md exists', () => fs.existsSync(path.join(ROOT, 'AGENTS.md')));
check('DEITY SKILL.md exists', () => fs.existsSync(path.join(ROOT, '.agent/skills/DEITY/SKILL.md')));
check('ECC_BASELINE SKILL.md exists', () => fs.existsSync(path.join(ROOT, '.agent/skills/ECC_BASELINE/SKILL.md')));
check('IMPLEMENTATION_PLAN_v140.md exists', () => fs.existsSync(path.join(ROOT, 'IMPLEMENTATION_PLAN_v140.md')));

// Runtime files
check('server.js exists', () => fs.existsSync(path.join(ROOT, 'server.js')));
check('lib/config.js exists', () => fs.existsSync(path.join(ROOT, 'lib/config.js')));
check('lib/strategy-matcher.js exists', () => fs.existsSync(path.join(ROOT, 'lib/strategy-matcher.js')));
check('lib/risk-manager.js exists', () => fs.existsSync(path.join(ROOT, 'lib/risk-manager.js')));
check('lib/trade-executor.js exists', () => fs.existsSync(path.join(ROOT, 'lib/trade-executor.js')));
check('lib/market-discovery.js exists', () => fs.existsSync(path.join(ROOT, 'lib/market-discovery.js')));
check('lib/clob-client.js exists', () => fs.existsSync(path.join(ROOT, 'lib/clob-client.js')));

// Strategy artifacts
const strategyFiles = [
    'debug/strategy_set_top8_current.json',
    'debug/strategy_set_4h_maxprofit.json',
    'debug/strategy_set_5m_maxprofit.json'
];

for (const sf of strategyFiles) {
    check(`${sf} exists and parses`, () => {
        const full = path.join(ROOT, sf);
        if (!fs.existsSync(full)) return false;
        const data = JSON.parse(fs.readFileSync(full, 'utf8'));
        const count = Array.isArray(data) ? data.length : (data.strategies?.length || 0);
        return count > 0;
    });
}

// Syntax checks
const jsFiles = ['server.js', 'lib/config.js', 'lib/strategy-matcher.js', 'lib/risk-manager.js', 'lib/trade-executor.js', 'lib/market-discovery.js', 'lib/clob-client.js'];
for (const jf of jsFiles) {
    check(`node --check ${jf}`, () => {
        const full = path.join(ROOT, jf);
        if (!fs.existsSync(full)) return false;
        try {
            execSync(`node --check "${full}"`, { stdio: 'pipe' });
            return true;
        } catch {
            return false;
        }
    });
}

// Cross-IDE harness files
check('.factory/droids/ exists', () => fs.existsSync(path.join(ROOT, '.factory/droids')));
check('.claude/ exists', () => fs.existsSync(path.join(ROOT, '.claude')));
check('.cursor/rules/ exists', () => fs.existsSync(path.join(ROOT, '.cursor/rules')));
check('.codex/ exists', () => fs.existsSync(path.join(ROOT, '.codex')));
check('.agent/rules/ exists', () => fs.existsSync(path.join(ROOT, '.agent/rules')));
check('.agent/skills/ exists', () => fs.existsSync(path.join(ROOT, '.agent/skills')));
check('.agent/workflows/ exists', () => fs.existsSync(path.join(ROOT, '.agent/workflows')));
check('.windsurf/workflows/ exists', () => fs.existsSync(path.join(ROOT, '.windsurf/workflows')));

// Render config
check('render.yaml exists', () => fs.existsSync(path.join(ROOT, 'render.yaml')));
check('package.json exists', () => fs.existsSync(path.join(ROOT, 'package.json')));

// README has handoff markers
check('README has HANDOFF_STATE markers', () => {
    const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
    return readme.includes('HANDOFF_STATE_START') && readme.includes('HANDOFF_STATE_END');
});

check('README has AGENT_QUICK_START markers', () => {
    const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
    return readme.includes('AGENT_QUICK_START');
});

// gitignore whitelist check
check('.gitignore whitelists debug strategy files', () => {
    const gi = fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8');
    return gi.includes('!debug/strategy_set_');
});

// Report
console.log('\n=== POLYPROPHET Harness Verification ===\n');
for (const r of results) {
    const icon = r.status === 'PASS' ? '[OK]' : '[FAIL]';
    const detail = r.detail ? ` -- ${r.detail}` : '';
    console.log(`  ${icon} ${r.name}${detail}`);
}
console.log(`\n  Total: ${passed} passed, ${failed} failed out of ${passed + failed}`);
console.log(`  Verdict: ${failed === 0 ? 'ALL CHECKS PASSED' : 'SOME CHECKS FAILED'}\n`);

process.exit(failed > 0 ? 1 : 0);
