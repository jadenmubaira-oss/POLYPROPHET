const axios = require('axios');
const { HttpsProxyAgent } = require('https-proxy-agent');

const DEFAULT_TIMEOUT_MS = 35000;

function cleanInput(raw) {
    return String(raw || '')
        .replace(/\(\s*remove\s+space\s*\)/gi, '')
        .replace(/\s+-\s+/g, '-')
        .replace(/\s+/g, ' ')
        .trim();
}

function stripOuterQuotes(value) {
    const s = String(value || '').trim();
    if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
        return s.slice(1, -1);
    }
    return s;
}

function tokenizeShellish(raw) {
    const input = cleanInput(raw);
    const tokens = [];
    let current = '';
    let quote = null;
    let escape = false;
    for (const ch of input) {
        if (escape) {
            current += ch;
            escape = false;
            continue;
        }
        if (ch === '\\') {
            escape = true;
            continue;
        }
        if (quote) {
            if (ch === quote) quote = null;
            else current += ch;
            continue;
        }
        if (ch === '"' || ch === "'") {
            quote = ch;
            continue;
        }
        if (/\s/.test(ch)) {
            if (current) {
                tokens.push(current);
                current = '';
            }
            continue;
        }
        current += ch;
    }
    if (current) tokens.push(current);
    return tokens;
}

function normaliseProxyUrl(value) {
    const raw = stripOuterQuotes(cleanInput(value));
    if (!raw) throw new Error('Proxy input is empty.');
    const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`;
    let url;
    try {
        url = new URL(withScheme);
    } catch (e) {
        throw new Error(`Invalid proxy URL: ${e.message}`);
    }
    if (!url.hostname || !url.port) throw new Error('Proxy must include host and port.');
    if (!url.username || !url.password) throw new Error('Proxy must include username and password.');
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Proxy scheme must be http:// or https://.');
    return url.toString();
}

function parseProxyInput(rawInput) {
    const input = cleanInput(rawInput);
    if (!input) throw new Error('Usage: provide a proxy URL, user:pass@host:port, or raw curl command.');
    const tokens = tokenizeShellish(input);
    let proxy = null;
    let proxyUser = null;
    for (let i = 0; i < tokens.length; i++) {
        const token = tokens[i];
        if (token === '--proxy' || token === '-x') proxy = tokens[++i] || '';
        else if (token.startsWith('--proxy=')) proxy = token.slice('--proxy='.length);
        else if (token === '--proxy-user' || token === '-U') proxyUser = tokens[++i] || '';
        else if (token.startsWith('--proxy-user=')) proxyUser = token.slice('--proxy-user='.length);
    }

    if (proxy) {
        proxy = stripOuterQuotes(proxy);
        proxyUser = stripOuterQuotes(proxyUser || '');
        const proxyUrl = /^[a-z][a-z0-9+.-]*:\/\//i.test(proxy) ? new URL(proxy) : new URL(`http://${proxy}`);
        if (proxyUser && !proxyUrl.username && !proxyUrl.password) {
            const [username, ...passwordParts] = proxyUser.split(':');
            proxyUrl.username = username || '';
            proxyUrl.password = passwordParts.join(':') || '';
        }
        return {
            kind: 'curl',
            input,
            renderProxyUrl: normaliseProxyUrl(proxyUrl.toString())
        };
    }

    const candidate = tokens.find(t => /@[^\s/]+:\d+/.test(t) || /^[a-z][a-z0-9+.-]*:\/\//i.test(t)) || input;
    return {
        kind: 'proxy',
        input,
        renderProxyUrl: normaliseProxyUrl(candidate)
    };
}

function redactProxyUrl(proxyUrl) {
    try {
        const url = new URL(proxyUrl);
        const username = decodeURIComponent(url.username || '');
        const redactedUser = username ? `${username.slice(0, 8)}…` : '';
        const auth = redactedUser ? `${redactedUser}:[REDACTED]@` : '';
        return `${url.protocol}//${auth}${url.host}`;
    } catch {
        return '[invalid proxy url]';
    }
}

function redactBody(value) {
    return String(typeof value === 'string' ? value : JSON.stringify(value || null))
        .replace(/0x[a-fA-F0-9]{40,}/g, (m) => `${m.slice(0, 10)}…${m.slice(-6)}`)
        .replace(/Bearer\s+[A-Za-z0-9._~+\-/=]+/gi, 'Bearer [REDACTED]')
        .replace(/"?(apiKey|secret|passphrase|privateKey|proxyPassword|password)"?\s*[:=]\s*"?[^",\s}]+"?/gi, '$1=[REDACTED]')
        .slice(0, 1000);
}

async function requestViaProxy({ label, method = 'GET', url, proxyAgent, timeoutMs, data, headers }) {
    try {
        const resp = await axios({
            method,
            url,
            data,
            headers,
            timeout: timeoutMs,
            proxy: false,
            httpAgent: proxyAgent,
            httpsAgent: proxyAgent,
            validateStatus: () => true
        });
        return {
            label,
            ok: resp.status >= 200 && resp.status < 300,
            status: resp.status,
            data: resp.data,
            body: typeof resp.data === 'string' ? resp.data.slice(0, 1000) : null,
            headers: {
                'content-type': resp.headers?.['content-type'] || null,
                'cf-ray': resp.headers?.['cf-ray'] || null,
                server: resp.headers?.server || null,
                'x-request-id': resp.headers?.['x-request-id'] || null
            }
        };
    } catch (e) {
        return {
            label,
            ok: false,
            status: e.response?.status || null,
            error: e.message,
            data: e.response?.data == null ? null : redactBody(e.response.data),
            body: e.response?.data == null ? null : redactBody(e.response.data)
        };
    }
}

function isTradingRestrictedResult(result) {
    const haystack = `${result?.error || ''} ${result?.body || ''} ${typeof result?.data === 'string' ? result.data : JSON.stringify(result?.data || '')}`;
    return Number(result?.status) === 403 || /trading restricted|geoblock|geo.?block|forbidden/i.test(haystack);
}

function buildVerdict(results) {
    const geoData = results.publicGeoblock?.data || {};
    const publicBlocked = geoData.blocked === true;
    const orderBlocked = isTradingRestrictedResult(results.clobOrderPreflight);
    const clobTimeOk = !!results.clobTime?.ok;
    const orderStatus = Number(results.clobOrderPreflight?.status || 0);
    const orderReachedAuth = [400, 401, 422].includes(orderStatus) && !orderBlocked;
    const pass = !publicBlocked && clobTimeOk && orderReachedAuth;
    const warnings = [];
    if (publicBlocked) warnings.push(`public geoblock blocked=${geoData.blocked} country=${geoData.country || 'unknown'} region=${geoData.region || 'unknown'}`);
    if (!clobTimeOk) warnings.push(`CLOB /time failed status=${results.clobTime?.status || 'n/a'}`);
    if (orderBlocked) warnings.push('CLOB /order is geoblocked/forbidden on this route');
    if (!orderBlocked && !orderReachedAuth) warnings.push(`CLOB /order returned unexpected status=${orderStatus || 'n/a'}; expected 401/400/422 rather than 403`);
    return {
        pass,
        grade: pass ? (orderStatus === 401 ? 'PASS_STRICT_EXPECTED_401' : 'PASS_NON_GEOBLOCK_ORDER_VALIDATION') : 'FAIL_NO_GO',
        summary: pass
            ? 'Proxy route reaches Polymarket public geoblock, CLOB /time, and CLOB /order without geographic rejection. This is still not a real authenticated order fill proof.'
            : 'Proxy route is not safe to use for live trading based on non-trading checks.',
        warnings,
        expectedNextProof: pass ? 'Next proof is owner-authorized /liveproof while paused; only an accepted orderID proves authenticated order acceptance.' : 'Do not set/resume this proxy for live trading.'
    };
}

async function testProxyInput(rawInput, options = {}) {
    const parsed = parseProxyInput(rawInput);
    const timeoutMs = Number(options.timeoutMs || DEFAULT_TIMEOUT_MS);
    const proxyAgent = new HttpsProxyAgent(parsed.renderProxyUrl, { rejectUnauthorized: false });
    const previousTlsRejectUnauthorized = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    const results = {
        parsed,
        checkedAt: new Date().toISOString(),
        redactedProxyUrl: redactProxyUrl(parsed.renderProxyUrl),
        renderEnv: {
            PROXY_URL: parsed.renderProxyUrl,
            CLOB_FORCE_PROXY: '1'
        },
        tests: {}
    };
    try {
        if (options.insecureTls !== false) {
            process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
            results.insecureTls = true;
        }
        const brightDataUrl = options.brightDataUrl || 'https://geo.brdtest.com/welcome.txt?product=resi&method=native';
        results.tests.brightDataWelcome = await requestViaProxy({ label: 'brightdata_welcome', url: brightDataUrl, proxyAgent, timeoutMs });
        results.tests.ipinfo = await requestViaProxy({ label: 'ipinfo', url: 'https://ipinfo.io/json', proxyAgent, timeoutMs });
        results.tests.publicGeoblock = await requestViaProxy({ label: 'polymarket_public_geoblock', url: 'https://polymarket.com/api/geoblock', proxyAgent, timeoutMs });
        results.tests.clobTime = await requestViaProxy({ label: 'clob_time', url: 'https://clob.polymarket.com/time', proxyAgent, timeoutMs });
        results.tests.clobOrderPreflight = await requestViaProxy({
            label: 'clob_order_preflight_invalid_payload',
            method: 'POST',
            url: 'https://clob.polymarket.com/order',
            proxyAgent,
            timeoutMs,
            data: {},
            headers: { 'Content-Type': 'application/json' }
        });
        results.verdict = buildVerdict(results.tests);
        return results;
    } finally {
        if (previousTlsRejectUnauthorized == null) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
        else process.env.NODE_TLS_REJECT_UNAUTHORIZED = previousTlsRejectUnauthorized;
    }
}

module.exports = {
    cleanInput,
    parseProxyInput,
    testProxyInput,
    redactProxyUrl,
    isTradingRestrictedResult
};