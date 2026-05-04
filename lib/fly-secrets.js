const https = require('https');
const CONFIG = require('./config');

function getCfg() {
    return {
        enabled: !!CONFIG.TELEGRAM?.flySecretsEnabled,
        token: String(CONFIG.TELEGRAM?.flyApiToken || '').trim(),
        appName: String(CONFIG.TELEGRAM?.flyAppName || process.env.FLY_APP_NAME || process.env.FLY_APP || 'polyprophet').trim()
    };
}

function isConfigured() {
    const cfg = getCfg();
    return !!(cfg.enabled && cfg.token && cfg.appName);
}

function redactValue(value) {
    const s = String(value || '');
    if (!s) return '';
    if (s.length <= 10) return `${s.slice(0, 2)}...`;
    return `${s.slice(0, 6)}...${s.slice(-4)}`;
}

function publicState() {
    const cfg = getCfg();
    return {
        enabled: cfg.enabled,
        tokenPresent: !!cfg.token,
        appName: cfg.appName || null,
        configured: isConfigured()
    };
}

function postGraphql(token, payload) {
    return new Promise((resolve) => {
        const body = JSON.stringify(payload);
        const req = https.request({
            hostname: 'api.fly.io',
            path: '/graphql',
            method: 'POST',
            timeout: 30000,
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(body),
                'Authorization': `Bearer ${token}`
            }
        }, (res) => {
            let data = '';
            res.on('data', (chunk) => { data += chunk; });
            res.on('end', () => {
                let parsed = null;
                try { parsed = JSON.parse(data); } catch {}
                resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, statusCode: res.statusCode, data: parsed, raw: data.slice(0, 500) });
            });
        });
        req.on('error', (err) => resolve({ ok: false, error: err.message }));
        req.on('timeout', () => req.destroy(new Error('Fly secrets request timeout')));
        req.write(body);
        req.end();
    });
}

async function setSecrets(secretMap) {
    const cfg = getCfg();
    const entries = Object.entries(secretMap || {})
        .map(([key, value]) => ({ key: String(key || '').trim(), value: String(value || '').trim() }))
        .filter((entry) => entry.key && entry.value);
    if (!cfg.enabled) return { success: false, skipped: true, reason: 'TELEGRAM_FLY_SECRETS_ENABLED_FALSE', state: publicState() };
    if (!cfg.token) return { success: false, skipped: true, reason: 'FLY_API_TOKEN_MISSING', state: publicState() };
    if (!cfg.appName) return { success: false, skipped: true, reason: 'FLY_APP_NAME_MISSING', state: publicState() };
    if (!entries.length) return { success: false, skipped: true, reason: 'NO_SECRETS_TO_SET', state: publicState() };

    const payload = {
        query: 'mutation($input: SetSecretsInput!) { setSecrets(input: $input) { app { name } release { id version } } }',
        variables: { input: { appId: cfg.appName, secrets: entries } }
    };
    const result = await postGraphql(cfg.token, payload);
    const errors = Array.isArray(result.data?.errors) ? result.data.errors.map((e) => e.message || String(e)) : [];
    const release = result.data?.data?.setSecrets?.release || null;
    const app = result.data?.data?.setSecrets?.app || null;
    return {
        success: !!(result.ok && !errors.length && release),
        statusCode: result.statusCode || null,
        app: app?.name || cfg.appName,
        release,
        errors,
        rawError: result.error || null,
        keys: entries.map((entry) => entry.key),
        redacted: Object.fromEntries(entries.map((entry) => [entry.key, redactValue(entry.value)])),
        state: publicState()
    };
}

module.exports = { isConfigured, publicState, setSecrets, redactValue };
