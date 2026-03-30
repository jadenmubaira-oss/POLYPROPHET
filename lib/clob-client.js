const CONFIG = require('./config');
const https = require('https');

const POLY_CHAIN_ID = 137; // Polygon mainnet
const USDC_ADDRESS = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';
const USDC_DECIMALS = 6;
const USDC_ABI = [
    'function balanceOf(address owner) view returns (uint256)'
];
const CTF_ADDRESS = '0x4D97DCd97eC945f40cF65F87097ACe5EA0476045';
const CTF_ABI = [
    'function balanceOf(address owner, uint256 id) view returns (uint256)',
    'function redeemPositions(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] indexSets) external'
];
const PROXY_FACTORY_ADDRESS = '0xaB45c5A4B0c941a2F231C04C3f49182e1A254052';
const PROXY_FACTORY_ABI = [
    'function getImplementation() view returns (address)'
];
const PROXY_CLONE_PREFIX_A = '0x3d3d606380380380913d393d73';
const PROXY_CLONE_PREFIX_B = '0x5af4602a57600080fd5b602d8060366000396000f3363d3d373d3d3d363d73';
const PROXY_CLONE_PREFIX_C = '0x5af43d82803e903d91602b57fd5bf3';
const DEFAULT_POLYGON_RPC_URLS = [
    'https://polygon-bor-rpc.publicnode.com',
    'https://polygon.llamarpc.com',
    'https://polygon.drpc.org',
    'https://polygon-rpc.com',
    'https://1rpc.io/matic',
    'https://rpc.ankr.com/polygon'
];

let ClobClient = null;
let ethers = null;
let axios = null;
let HttpsProxyAgent = null;

try {
    ClobClient = require('@polymarket/clob-client').ClobClient;
} catch (e) {
    console.log('⚠️ @polymarket/clob-client not installed — LIVE trading disabled');
}

try {
    ethers = require('ethers');
} catch (e) {
    console.log('⚠️ ethers not installed — wallet operations disabled');
}

try {
    axios = require('axios');
} catch (e) {
    console.log('⚠️ axios not installed — CLOB proxy routing disabled');
}

try {
    ({ HttpsProxyAgent } = require('https-proxy-agent'));
} catch (e) {
    if (CONFIG.PROXY_URL) {
        console.log(` https-proxy-agent not available for CLOB routing: ${e.message}`);
    }
}

let clobAxiosRoutingInstalled = false;
let clobProxyAgent = null;
let lastKnownProxyFunderAddress = null;
let activeClobAuthContext = null;

const directAgent = https.globalAgent;

function getConfiguredFunderAddress() {
    const raw = String(CONFIG.POLYMARKET_ADDRESS || '').trim();
    try {
        if (raw && ethers?.utils?.isAddress && ethers.utils.isAddress(raw)) return raw;
    } catch {}
    return null;
}

function normalizeSignatureType(value) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return null;
    return parsed === 1 ? 1 : 0;
}

function rememberProxyFunderAddress(address) {
    try {
        if (address && ethers?.utils?.isAddress && ethers.utils.isAddress(address)) {
            lastKnownProxyFunderAddress = address;
        }
    } catch {}
}

function getKnownProxyFunderAddress() {
    return getConfiguredFunderAddress() || lastKnownProxyFunderAddress;
}

function readRequestValue(source, key) {
    if (!source) return undefined;
    if (typeof source.get === 'function') return source.get(key);
    return source[key];
}

function parseRequestSignatureType(nextConfig) {
    const paramsSigType = normalizeSignatureType(readRequestValue(nextConfig?.params, 'signature_type'));
    if (paramsSigType !== null) return paramsSigType;

    const data = nextConfig?.data;
    if (!data) return null;

    const parsePayload = (payload) => {
        if (!payload || typeof payload !== 'object') return null;
        if (Array.isArray(payload)) {
            for (const entry of payload) {
                const nested = parsePayload(entry);
                if (nested !== null) return nested;
            }
            return null;
        }
        const direct = normalizeSignatureType(payload.signature_type ?? payload.signatureType);
        if (direct !== null) return direct;
        const orderSigType = normalizeSignatureType(payload.order?.signatureType ?? payload.order?.signature_type);
        if (orderSigType !== null) return orderSigType;
        return null;
    };

    if (typeof data === 'string') {
        try {
            return parsePayload(JSON.parse(data));
        } catch {
            return null;
        }
    }

    return parsePayload(data);
}

async function withClobAuthContext(signatureType, funderAddress, fn) {
    const previous = activeClobAuthContext;
    activeClobAuthContext = { signatureType, funderAddress };
    try {
        return await fn();
    } finally {
        activeClobAuthContext = previous;
    }
}

function installClobAxiosRouting() {
    if (clobAxiosRoutingInstalled || !axios) return;

    if (CONFIG.PROXY_URL && HttpsProxyAgent) {
        try {
            clobProxyAgent = new HttpsProxyAgent(CONFIG.PROXY_URL);
            // Prevent "Converting circular structure to JSON" when @polymarket/clob-client
            // serializes the axios config for request signing
            clobProxyAgent.toJSON = () => '[ProxyAgent]';
        } catch (e) {
            console.log(` CLOB proxy agent init failed: ${e.message}`);
        }
    }
    // Also prevent circular JSON on the direct agent
    if (directAgent && !directAgent.toJSON) {
        directAgent.toJSON = () => '[DirectAgent]';
    }

    // Do NOT set axios.defaults.httpsAgent — it causes "Converting circular structure
    // to JSON" errors in @polymarket/clob-client when it tries to serialize the config.
    // Instead, use ONLY the interceptor to inject the proxy agent at request time.
    axios.defaults.proxy = false;

    // Interceptor: route all clob.polymarket.com calls through appropriate agent.
    // Reads (book/price) go direct (not geoblocked). Writes (orders/auth) go through proxy.
    axios.interceptors.request.use((requestConfig) => {
        const nextConfig = requestConfig || {};
        const url = String(nextConfig.url || '');
        if (!url.includes('clob.polymarket.com')) return nextConfig;

        nextConfig.proxy = false;

        const requestSigType = activeClobAuthContext
            ? normalizeSignatureType(activeClobAuthContext.signatureType)
            : parseRequestSignatureType(nextConfig);
        const fallbackSigType = normalizeSignatureType(CONFIG.POLYMARKET_SIGNATURE_TYPE);
        const sigType = requestSigType !== null ? requestSigType : fallbackSigType;
        const configuredFunder = activeClobAuthContext?.funderAddress || getKnownProxyFunderAddress();
        const headers = nextConfig.headers;
        const hasL2AuthHeaders = !!headers && (
            typeof headers.POLY_API_KEY !== 'undefined' ||
            typeof headers.poly_api_key !== 'undefined' ||
            (typeof headers.get === 'function' && (headers.get('POLY_API_KEY') || headers.get('poly_api_key')))
        );
        if (configuredFunder && sigType === 1 && hasL2AuthHeaders) {
            if (headers && typeof headers.set === 'function') {
                headers.set('POLY_ADDRESS', configuredFunder);
            } else {
                nextConfig.headers = Object.assign({}, headers || {}, { POLY_ADDRESS: configuredFunder });
            }
        }

        const isReadOnly = /\/(book|price|prices-history)\b/.test(url);
        if (isReadOnly) {
            nextConfig.httpsAgent = directAgent;
        } else if (clobProxyAgent) {
            nextConfig.httpsAgent = clobProxyAgent;
        }
        return nextConfig;
    });

    clobAxiosRoutingInstalled = true;

    if (CONFIG.PROXY_URL && CONFIG.CLOB_FORCE_PROXY && clobProxyAgent) {
        console.log(` CLOB proxy routing: writes via proxy, reads direct`);
    } else if (CONFIG.PROXY_URL) {
        console.log(' CLOB proxy available but CLOB_FORCE_PROXY not set — all direct');
    }
}

function getPolygonRpcEndpoints() {
    const raw = String(process.env.POLYGON_RPC_URLS || '').trim();
    const endpoints = (raw
        ? raw.split(',').map(item => item.trim()).filter(Boolean)
        : DEFAULT_POLYGON_RPC_URLS.slice()).slice(0, 10);
    return endpoints.length > 0 ? endpoints : DEFAULT_POLYGON_RPC_URLS.slice(0, 10);
}

function getPolygonRpcTimeoutMs() {
    const parsed = Number(process.env.POLYGON_RPC_TIMEOUT_MS || 8000);
    return Number.isFinite(parsed) ? Math.max(2000, Math.min(20000, parsed)) : 8000;
}

class PolymarketCLOB {
    constructor() {
        this.wallet = null;
        this.walletAddress = null;
        this._tradeReadyCache = null;
        this._tradeReadyCacheExpiry = 0;
        this._deriveCredsPromise = null;
        this._lastSelectionKey = null;
        this._proxyResolutionCache = null;
        this._proxyResolutionExpiry = 0;
        installClobAxiosRouting();
    }

    _getProvider() {
        if (this.wallet?.provider) return this.wallet.provider;
        if (!ethers?.providers?.JsonRpcProvider) return null;
        return new ethers.providers.JsonRpcProvider(getPolygonRpcEndpoints()[0]);
    }

    loadWallet() {
        if (!CONFIG.POLYMARKET_PRIVATE_KEY) {
            console.log(' No POLYMARKET_PRIVATE_KEY — wallet not loaded');
            return false;
        }
        if (!ethers) {
            console.log(' ethers not available — cannot load wallet');
            return false;
        }

        try {
            const provider = new ethers.providers.JsonRpcProvider(getPolygonRpcEndpoints()[0]);
            this.wallet = new ethers.Wallet(CONFIG.POLYMARKET_PRIVATE_KEY, provider);
            this.walletAddress = this.wallet.address;
            console.log(` Wallet loaded: ${this.walletAddress}`);
            return true;
        } catch (e) {
            console.error(` Wallet load failed: ${e.message}`);
            return false;
        }
    }

    async ensureCreds() {
        if (!ClobClient || !this.wallet) return { ok: false, reason: 'Missing client or wallet' };

        const hasCreds = CONFIG.POLYMARKET_API_KEY && CONFIG.POLYMARKET_SECRET && CONFIG.POLYMARKET_PASSPHRASE;
        if (hasCreds) return { ok: true, source: 'env' };
        if (!CONFIG.POLYMARKET_AUTO_DERIVE_CREDS) return { ok: false, reason: 'Missing API creds and auto-derive disabled' };

        if (this._deriveCredsPromise) return await this._deriveCredsPromise;

        this._deriveCredsPromise = (async () => {
            try {
                const host = 'https://clob.polymarket.com';
                console.log(` Attempting API cred derivation... wallet=${this.wallet?.address?.slice(0, 10)}...`);

                // Use deriveApiKey with sigType=0 (standard L1 auth).
                // createOrDeriveApiKey hits a circular JSON error through proxy on the create path.
                // deriveApiKey works correctly and returns valid creds.
                const tmp = new ClobClient(host, POLY_CHAIN_ID, this.wallet, undefined, 0, this.wallet.address);
                console.log(` Calling deriveApiKey (sigType=0)...`);

                const derivePromise = tmp.deriveApiKey();
                const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error('DERIVE_TIMEOUT_20s')), 20000));
                const creds = await Promise.race([derivePromise, timeoutPromise]);

                console.log(` Derive response: keys=${creds ? Object.keys(creds).join(',') : 'null'}`);

                const key = String(creds?.key || creds?.apiKey || '').trim();
                const secret = String(creds?.secret || creds?.apiSecret || '').trim();
                const passphrase = String(creds?.passphrase || creds?.apiPassphrase || '').trim();

                if (!key || !secret || !passphrase) {
                    console.log(` Derive returned empty: raw=${JSON.stringify(creds).slice(0, 200)}`);
                    return { ok: false, reason: `Derive returned empty creds (raw keys: ${creds ? Object.keys(creds).join(',') : 'null'})` };
                }

                CONFIG.POLYMARKET_API_KEY = key;
                CONFIG.POLYMARKET_SECRET = secret;
                CONFIG.POLYMARKET_PASSPHRASE = passphrase;
                console.log(` API creds derived from wallet (key=${key.slice(0, 8)}...)`);
                return { ok: true, source: 'derived' };
            } catch (e) {
                console.log(` Derive error: ${e.message}`);
                return { ok: false, reason: `Derive failed: ${e.message}` };
            } finally {
                this._deriveCredsPromise = null;
            }
        })();

        return await this._deriveCredsPromise;
    }

    _buildCreds() {
        return {
            key: String(CONFIG.POLYMARKET_API_KEY || '').replace(/[^\x20-\x7E]/g, ''),
            secret: String(CONFIG.POLYMARKET_SECRET || '').replace(/[^\x20-\x7E]/g, ''),
            passphrase: String(CONFIG.POLYMARKET_PASSPHRASE || '').replace(/[^\x20-\x7E]/g, '')
        };
    }

    _isAddress(a) {
        try {
            return !!a && ethers?.utils?.isAddress && ethers.utils.isAddress(a);
        } catch { return false; }
    }

    _getPreferredSignatureType() {
        const configured = normalizeSignatureType(CONFIG.POLYMARKET_SIGNATURE_TYPE);
        return configured !== null ? configured : 0;
    }

    async _isContractDeployed(address) {
        if (!this._isAddress(address)) return false;
        const provider = this._getProvider();
        if (!provider?.getCode) return false;
        try {
            const code = await provider.getCode(address);
            return typeof code === 'string' && code !== '0x';
        } catch {
            return false;
        }
    }

    async _deriveProxyWalletAddress(ttlMs = 300000) {
        if (!this.wallet || !ethers) {
            return { ok: false, address: null, source: 'derived', reason: 'Wallet not loaded' };
        }

        const now = Date.now();
        if (this._proxyResolutionCache && this._proxyResolutionExpiry > now) {
            return this._proxyResolutionCache;
        }

        try {
            const provider = this._getProvider();
            if (!provider || !ethers.Contract || !ethers.utils?.Interface || !ethers.utils?.hexConcat) {
                return { ok: false, address: null, source: 'derived', reason: 'Provider or ethers utils unavailable' };
            }

            const factory = new ethers.Contract(PROXY_FACTORY_ADDRESS, PROXY_FACTORY_ABI, provider);
            const implementation = await factory.getImplementation();
            if (!this._isAddress(implementation)) {
                return { ok: false, address: null, source: 'derived', reason: 'Proxy factory returned invalid implementation' };
            }

            const iface = new ethers.utils.Interface(['function cloneConstructor(bytes)']);
            const constructorData = iface.encodeFunctionData('cloneConstructor', ['0x']);
            const salt = ethers.utils.keccak256(ethers.utils.solidityPack(['address'], [this.wallet.address]));
            const initCode = ethers.utils.hexConcat([
                PROXY_CLONE_PREFIX_A,
                PROXY_FACTORY_ADDRESS,
                PROXY_CLONE_PREFIX_B,
                implementation,
                PROXY_CLONE_PREFIX_C,
                constructorData
            ]);
            const initCodeHash = ethers.utils.keccak256(initCode);
            const address = ethers.utils.getCreate2Address(PROXY_FACTORY_ADDRESS, salt, initCodeHash);
            const deployed = await this._isContractDeployed(address);
            const out = {
                ok: this._isAddress(address),
                address,
                deployed,
                implementation,
                source: 'proxy_factory_create2',
                reason: null
            };
            if (out.ok) {
                rememberProxyFunderAddress(address);
            }
            this._proxyResolutionCache = out;
            this._proxyResolutionExpiry = now + ttlMs;
            return out;
        } catch (e) {
            const out = { ok: false, address: null, source: 'derived', reason: e.message };
            this._proxyResolutionCache = out;
            this._proxyResolutionExpiry = now + Math.min(ttlMs, 60000);
            return out;
        }
    }

    async _resolveProxyFunderAddress(ttlMs = 300000) {
        const configured = getConfiguredFunderAddress();
        if (configured) {
            rememberProxyFunderAddress(configured);
            return {
                ok: true,
                address: configured,
                deployed: await this._isContractDeployed(configured),
                source: 'env',
                reason: null
            };
        }

        return await this._deriveProxyWalletAddress(ttlMs);
    }

    async _probeTradeClients(opts = {}) {
        if (!ClobClient) return { ok: false, reason: 'Missing @polymarket/clob-client', probes: [], preferredSigType: 0, closedOnly: null, closedOnlyErr: null, proxyResolution: null };
        if (!this.wallet) return { ok: false, reason: 'No wallet loaded', probes: [], preferredSigType: 0, closedOnly: null, closedOnlyErr: null, proxyResolution: null };

        const ttlMs = opts.ttlMs || 60000;
        if (!CONFIG.POLYMARKET_API_KEY || !CONFIG.POLYMARKET_SECRET || !CONFIG.POLYMARKET_PASSPHRASE) {
            const derived = await this.ensureCreds().catch(() => ({ ok: false }));
            if (!derived?.ok) {
                return { ok: false, reason: 'Missing API creds and auto-derive failed', probes: [], preferredSigType: 0, closedOnly: null, closedOnlyErr: null, proxyResolution: null };
            }
        }

        const host = 'https://clob.polymarket.com';
        const creds = this._buildCreds();
        const signerAddress = this.wallet.address || undefined;
        const proxyResolution = await this._resolveProxyFunderAddress(Math.max(ttlMs, 60000));
        const preferredSigType = normalizeSignatureType(CONFIG.POLYMARKET_SIGNATURE_TYPE) ?? (proxyResolution?.ok ? 1 : 0);
        const configuredFunderAddress = getConfiguredFunderAddress();
        // For sigType=1: use configured address, then derived proxy, then signer as last resort
        const primarySigType1Funder = configuredFunderAddress
            || (proxyResolution?.ok && this._isAddress(proxyResolution.address) ? proxyResolution.address : null)
            || signerAddress;

        const candidates = [
            {
                signatureType: 0,
                funderAddress: signerAddress,
                source: 'eoa',
                client: new ClobClient(host, POLY_CHAIN_ID, this.wallet, creds, 0, signerAddress)
            }
        ];

        if (this._isAddress(primarySigType1Funder)) {
            const primarySource = configuredFunderAddress ? 'env'
                : (proxyResolution?.ok && primarySigType1Funder === proxyResolution.address) ? 'proxy_derived'
                : 'wallet';
            if (primarySigType1Funder !== signerAddress || configuredFunderAddress) {
                rememberProxyFunderAddress(primarySigType1Funder);
            }
            candidates.push({
                signatureType: 1,
                funderAddress: primarySigType1Funder,
                source: primarySource,
                deployed: primarySigType1Funder !== signerAddress ? await this._isContractDeployed(primarySigType1Funder) : null,
                client: new ClobClient(host, POLY_CHAIN_ID, this.wallet, creds, 1, primarySigType1Funder)
            });
        }

        if (proxyResolution?.ok && this._isAddress(proxyResolution.address) && proxyResolution.address !== primarySigType1Funder) {
            rememberProxyFunderAddress(proxyResolution.address);
            candidates.push({
                signatureType: 1,
                funderAddress: proxyResolution.address,
                source: proxyResolution.source,
                deployed: proxyResolution.deployed,
                client: new ClobClient(host, POLY_CHAIN_ID, this.wallet, creds, 1, proxyResolution.address)
            });
        }

        const toBigIntOrNull = (raw) => {
            const value = String(raw ?? '').trim();
            if (!value || !/^\d+$/.test(value)) return null;
            try {
                return BigInt(value);
            } catch {
                return null;
            }
        };

        const computeMaxAllowance = (allowances, allowanceRaw) => {
            if (!allowances || typeof allowances !== 'object') {
                return {
                    maxRaw: allowanceRaw != null ? String(allowanceRaw) : null,
                    spender: null,
                    max: toBigIntOrNull(allowanceRaw) || 0n
                };
            }

            let max = 0n;
            let spender = null;
            let maxRaw = null;
            for (const [addr, value] of Object.entries(allowances)) {
                const parsed = toBigIntOrNull(value);
                if (parsed === null) continue;
                if (parsed > max) {
                    max = parsed;
                    spender = addr;
                    maxRaw = String(value);
                }
            }

            return { maxRaw, spender, max };
        };

        const probe = async (candidate) => {
            const out = {
                signatureType: candidate.signatureType,
                funderAddress: candidate.funderAddress,
                source: candidate.source,
                deployed: candidate.deployed ?? null,
                client: candidate.client,
                refreshed: null,
                refreshError: null,
                balanceRaw: null,
                allowanceMaxRaw: null,
                allowanceMaxSpender: null,
                ok: false,
                error: null,
                status: null
            };

            const updated = await withClobAuthContext(candidate.signatureType, candidate.funderAddress, () => candidate.client.updateBalanceAllowance({ asset_type: 'COLLATERAL' }).catch((e) => ({ error: e?.message || String(e) })));
            if (updated && typeof updated === 'object' && Object.prototype.hasOwnProperty.call(updated, 'error')) {
                out.refreshed = false;
                out.refreshError = String(updated.error);
            } else {
                out.refreshed = true;
            }

            const balanceAllowance = await withClobAuthContext(candidate.signatureType, candidate.funderAddress, () => candidate.client.getBalanceAllowance({ asset_type: 'COLLATERAL' }).catch((e) => ({ error: e?.message || String(e) })));
            if (balanceAllowance && typeof balanceAllowance === 'object' && Object.prototype.hasOwnProperty.call(balanceAllowance, 'error')) {
                out.error = String(balanceAllowance.error);
                out.status = balanceAllowance?.status || null;
                return out;
            }

            out.balanceRaw = String(balanceAllowance?.balance ?? '').trim() || null;
            const { maxRaw, spender, max } = computeMaxAllowance(balanceAllowance?.allowances, balanceAllowance?.allowance);
            out.allowanceMaxRaw = maxRaw;
            out.allowanceMaxSpender = spender;
            const balance = toBigIntOrNull(out.balanceRaw) || 0n;
            out.ok = balance > 0n && max > 0n;
            return out;
        };

        const closedOnlyResponse = await withClobAuthContext(0, signerAddress, () => candidates[0].client.getClosedOnlyMode().catch((e) => ({ error: e?.message || String(e) })));
        const closedOnly = (closedOnlyResponse && typeof closedOnlyResponse === 'object' && Object.prototype.hasOwnProperty.call(closedOnlyResponse, 'error'))
            ? null
            : !!closedOnlyResponse?.closed_only;
        const closedOnlyErr = (closedOnlyResponse && typeof closedOnlyResponse === 'object' && Object.prototype.hasOwnProperty.call(closedOnlyResponse, 'error'))
            ? String(closedOnlyResponse.error)
            : null;

        const probes = [];
        for (const candidate of candidates) {
            probes.push(await probe(candidate));
        }
        return { ok: true, reason: null, probes, preferredSigType, closedOnly, closedOnlyErr, proxyResolution };
    }

    _selectTradeProbe(probes, preferredSigType, closedOnly) {
        if (!Array.isArray(probes) || probes.length === 0) return null;
        const preferred = probes.find((probe) => probe.signatureType === preferredSigType) || null;
        const ready = probes.filter((probe) => !closedOnly && !!probe.ok);

        if (preferred && !closedOnly && preferred.ok) return preferred;
        if (ready.length > 0) {
            return ready.find((probe) => probe.signatureType !== preferredSigType) || ready[0];
        }
        return preferred || probes[0];
    }

    _buildAttemptOrder(probes, preferredSigType, closedOnly) {
        if (!Array.isArray(probes) || probes.length === 0 || closedOnly) return [];
        const ready = probes.filter((probe) => !!probe.ok);
        const preferredReady = ready.find((probe) => probe.signatureType === preferredSigType);
        const ordered = [];
        if (preferredReady) ordered.push(preferredReady);
        for (const probe of ready) {
            if (!ordered.includes(probe)) ordered.push(probe);
        }
        return ordered;
    }

    _isRetryableAuthError(message) {
        const raw = String(message || '').toLowerCase();
        return raw.includes('invalid signature') ||
            raw.includes('invalid funder') ||
            (raw.includes('funder') && raw.includes('address')) ||
            raw.includes('l2 auth') ||
            raw.includes('unauthorized') ||
            raw.includes('authentication');
    }

    async _placeOrderWithCandidate(candidate, tokenId, price, shares, side) {
        try {
            const result = await withClobAuthContext(candidate.signatureType, candidate.funderAddress, async () => {
                const order = await candidate.client.createOrder({
                    tokenID: tokenId,
                    price: price,
                    size: shares,
                    side: side
                });

                const response = await candidate.client.postOrder(order);

                if (response && response.orderID) {
                    console.log(`✅ CLOB ORDER PLACED: ${response.orderID} | sigType=${candidate.signatureType} | ${side} ${shares} @ ${(price*100).toFixed(1)}¢`);

                    let fillStatus = 'UNVERIFIED';
                    let matchedShares = 0;
                    for (let attempt = 1; attempt <= 3; attempt++) {
                        await new Promise(r => setTimeout(r, 2000));
                        try {
                            const orderStatus = await candidate.client.getOrder(response.orderID);
                            if (orderStatus) {
                                fillStatus = String(orderStatus.status || 'UNKNOWN');
                                matchedShares = Number(orderStatus.size_matched || 0);

                                if (matchedShares > 0) {
                                    console.log(`✅ Order MATCHED: ${matchedShares.toFixed(4)} shares`);
                                    break;
                                } else if (['CANCELLED', 'EXPIRED', 'REJECTED'].includes(fillStatus.toUpperCase())) {
                                    return { success: false, error: `Order ${fillStatus}`, orderID: response.orderID, signatureType: candidate.signatureType };
                                }
                            }
                        } catch {}
                    }

                    const safeMatchedShares = Number.isFinite(matchedShares) ? matchedShares : 0;
                    const eps = 1e-6;
                    const partialFill = safeMatchedShares > eps && safeMatchedShares + eps < shares;

                    if (safeMatchedShares + eps < shares) {
                        try {
                            await candidate.client.cancelOrder({ orderID: response.orderID });
                        } catch {}
                    }

                    return {
                        success: safeMatchedShares > eps,
                        orderID: response.orderID,
                        fillStatus,
                        matchedShares: safeMatchedShares,
                        matchedSize: safeMatchedShares * price,
                        requestedShares: shares,
                        partialFill,
                        signatureType: candidate.signatureType,
                        funderAddress: candidate.funderAddress,
                        error: safeMatchedShares <= eps ? 'NO_FILL_AFTER_RETRIES' : null
                    };
                }

                return { success: false, error: `No orderID in response: ${JSON.stringify(response)}`, signatureType: candidate.signatureType, funderAddress: candidate.funderAddress };
            });

            return result;
        } catch (e) {
            return { success: false, error: `Order failed: ${e.message}`, signatureType: candidate.signatureType, funderAddress: candidate.funderAddress };
        }
    }

    async getTradeReadyClient(opts = {}) {
        if (!ClobClient) return { ok: false, reason: 'Missing @polymarket/clob-client', client: null };
        if (!this.wallet) return { ok: false, reason: 'No wallet loaded', client: null };

        const now = Date.now();
        const ttlMs = opts.ttlMs || 60000;
        const force = !!opts.force;

        if (!force && this._tradeReadyCache && this._tradeReadyCacheExpiry > now) {
            return this._tradeReadyCache;
        }

        try {
            const probeState = await this._probeTradeClients({ ttlMs });
            if (!probeState.ok) {
                const out = { ok: false, reason: probeState.reason || 'CLOB not ready', client: null };
                this._tradeReadyCache = out;
                this._tradeReadyCacheExpiry = now + ttlMs;
                return out;
            }

            const closedBlocks = probeState.closedOnly === true;
            const probeResult = this._selectTradeProbe(probeState.probes, probeState.preferredSigType, closedBlocks);
            const client = probeResult?.client || null;
            const sigType = probeResult?.signatureType ?? probeState.preferredSigType;

            const selectedBalance = probeResult?.balanceRaw != null ? (parseFloat(String(probeResult.balanceRaw)) / 1e6) : null;
            const ok = !closedBlocks && !!probeResult?.ok;
            const selKey = `${sigType}:${String(probeResult?.funderAddress || '')}:${closedBlocks ? 'CLOSED' : (ok ? 'READY' : 'NOT_READY')}`;
            if (selKey !== this._lastSelectionKey) {
                this._lastSelectionKey = selKey;
                console.log(`🔐 CLOB: sigType=${sigType} ${closedBlocks ? 'CLOSED_ONLY' : (ok ? 'READY' : 'NOT_READY')} balance=${Number.isFinite(selectedBalance) ? selectedBalance : 'n/a'}`);
            }

            const out = {
                ok,
                client,
                sigType,
                balance: Number.isFinite(selectedBalance) ? selectedBalance : null,
                reason: closedBlocks
                    ? 'Account is in closed-only mode'
                    : (ok ? null : (probeResult?.error || probeResult?.refreshError || `Not trade-ready (sigType=${sigType})`)),
                summary: closedBlocks
                    ? 'closedOnly=true'
                    : (ok ? `OK sigType=${sigType}` : `NOT_READY sigType=${sigType}`),
                closedOnly: probeState.closedOnly,
                closedOnlyErr: probeState.closedOnlyErr,
                proxyResolution: probeState.proxyResolution,
                selected: probeResult ? {
                    signatureType: probeResult.signatureType,
                    funderAddress: probeResult.funderAddress,
                    source: probeResult.source || null,
                    deployed: probeResult.deployed ?? null,
                    balanceRaw: probeResult.balanceRaw,
                    allowanceMaxRaw: probeResult.allowanceMaxRaw,
                    allowanceMaxSpender: probeResult.allowanceMaxSpender,
                    refreshed: probeResult.refreshed,
                    refreshError: probeResult.refreshError,
                    error: probeResult.error,
                    status: probeResult.status,
                    ok: !!probeResult.ok
                } : null,
                candidates: probeState.probes.map((candidate) => ({
                    signatureType: candidate.signatureType,
                    funderAddress: candidate.funderAddress,
                    source: candidate.source || null,
                    deployed: candidate.deployed ?? null,
                    balanceRaw: candidate.balanceRaw,
                    allowanceMaxRaw: candidate.allowanceMaxRaw,
                    allowanceMaxSpender: candidate.allowanceMaxSpender,
                    refreshed: candidate.refreshed,
                    refreshError: candidate.refreshError,
                    error: candidate.error,
                    status: candidate.status,
                    ok: !!candidate.ok
                }))
            };

            this._tradeReadyCache = out;
            this._tradeReadyCacheExpiry = now + ttlMs;
            return out;
        } catch (e) {
            return { ok: false, reason: `CLOB error: ${e.message}`, client: null };
        }
    }

    async placeOrder(tokenId, price, shares, side = 'BUY') {
        const probeState = await this._probeTradeClients({ ttlMs: 10000 });
        if (!probeState.ok) {
            return { success: false, error: probeState.reason || 'CLOB not ready' };
        }

        const attemptOrder = this._buildAttemptOrder(probeState.probes, probeState.preferredSigType, probeState.closedOnly);
        if (attemptOrder.length === 0) {
            const selected = this._selectTradeProbe(probeState.probes, probeState.preferredSigType, probeState.closedOnly);
            return { success: false, error: probeState.closedOnly ? 'Account is in closed-only mode' : (selected?.error || selected?.refreshError || 'CLOB not ready') };
        }

        const errors = [];
        for (let index = 0; index < attemptOrder.length; index++) {
            const candidate = attemptOrder[index];
            const result = await this._placeOrderWithCandidate(candidate, tokenId, price, shares, side);
            if (result?.success) {
                return result;
            }

            errors.push(`sigType=${candidate.signatureType}${candidate.funderAddress ? ` funder=${candidate.funderAddress}` : ''}: ${result?.error || 'Unknown order error'}`);
            if (!this._isRetryableAuthError(result?.error) || index === attemptOrder.length - 1) {
                return Object.assign({}, result || { success: false, error: 'Order failed' }, {
                    error: errors.join(' | ')
                });
            }
        }

        return { success: false, error: errors.join(' | ') || 'Order failed' };
    }

    async getOrder(orderID) {
        const sel = await this.getTradeReadyClient({ ttlMs: 10000 });
        if (!sel?.client) {
            return { success: false, error: sel?.reason || 'CLOB not ready' };
        }

        try {
            const order = await withClobAuthContext(sel.sigType, sel?.selected?.funderAddress || this.wallet?.address, () => sel.client.getOrder(orderID));
            return { success: true, order };
        } catch (e) {
            return { success: false, error: e.message };
        }
    }

    async cancelOrder(orderID) {
        const sel = await this.getTradeReadyClient({ ttlMs: 10000 });
        if (!sel?.client) {
            return { success: false, error: sel?.reason || 'CLOB not ready' };
        }

        try {
            const result = await withClobAuthContext(sel.sigType, sel?.selected?.funderAddress || this.wallet?.address, () => sel.client.cancelOrder({ orderID }));
            return { success: true, result };
        } catch (e) {
            return { success: false, error: e.message };
        }
    }

    async getOnChainUsdcBalance() {
        if (!this.wallet || !ethers) {
            return { success: false, error: 'No wallet loaded', balance: 0, source: 'ON_CHAIN_USDC' };
        }

        let errors = [];

        if (!axios || !ethers?.utils?.Interface) {
            try {
                const provider = this._getProvider();
                const contract = new ethers.Contract(USDC_ADDRESS, USDC_ABI, provider);
                const rawBalance = await contract.balanceOf(this.wallet.address);
                const balance = parseFloat(ethers.utils.formatUnits(rawBalance, USDC_DECIMALS));
                return {
                    success: true,
                    balance: Number.isFinite(balance) ? balance : 0,
                    balanceRaw: rawBalance.toString(),
                    address: this.wallet.address,
                    source: 'ON_CHAIN_USDC'
                };
            } catch (e) {
                return { success: false, error: e.message, balance: 0, source: 'ON_CHAIN_USDC' };
            }
        }

        try {
            const iface = new ethers.utils.Interface(USDC_ABI);
            const data = iface.encodeFunctionData('balanceOf', [this.wallet.address]);
            const timeoutMs = getPolygonRpcTimeoutMs();
            const rpcEndpoints = getPolygonRpcEndpoints();
            errors = [];

            const racePromises = rpcEndpoints.map(async (rpc) => {
                try {
                    const response = await axios.post(rpc, {
                        jsonrpc: '2.0',
                        id: 1,
                        method: 'eth_call',
                        params: [{ to: USDC_ADDRESS, data }, 'latest']
                    }, {
                        timeout: timeoutMs,
                        httpsAgent: https.globalAgent,
                        proxy: false,
                        headers: { 'Content-Type': 'application/json' }
                    });

                    const resultHex = response?.data?.result;
                    if (!resultHex || typeof resultHex !== 'string') {
                        throw new Error('Invalid JSON-RPC response (no result)');
                    }

                    const rawBalance = ethers.BigNumber.from(resultHex);
                    const balance = parseFloat(ethers.utils.formatUnits(rawBalance, USDC_DECIMALS));
                    return { rpc, rawBalance: rawBalance.toString(), balance };
                } catch (e) {
                    errors.push({ rpc, error: e?.message ? String(e.message) : String(e) });
                    throw e;
                }
            });

            const result = await Promise.any(racePromises);
            return {
                success: true,
                balance: Number.isFinite(result.balance) ? result.balance : 0,
                balanceRaw: result.rawBalance,
                address: this.wallet.address,
                rpcUsed: result.rpc,
                source: 'ON_CHAIN_USDC'
            };
        } catch (e) {
            const message = Array.isArray(e?.errors) && e.errors.length > 0
                ? String(e.errors[0]?.message || e.message || 'Unknown RPC error')
                : String(e?.message || e);
            const detail = errors.length > 0
                ? `${message} | ${errors.map(item => `${item.rpc}: ${item.error}`).slice(0, 4).join(' ; ')}`
                : message;
            return { success: false, error: detail, balance: 0, source: 'ON_CHAIN_USDC' };
        }
    }

    async getClobCollateralBalance() {
        if (!this.wallet) {
            return { success: false, error: 'No wallet loaded', balance: 0, source: 'CLOB_COLLATERAL' };
        }

        try {
            const cachedTradeReady = this.getStatus()?.tradeReady || null;
            const cachedRawBalance = cachedTradeReady?.selected?.balanceRaw;
            const cachedBalance = cachedRawBalance != null ? parseFloat(String(cachedRawBalance)) / 1e6 : null;
            if (cachedTradeReady?.ok && Number.isFinite(cachedBalance) && cachedBalance > 0) {
                return {
                    success: true,
                    balance: cachedBalance,
                    balanceRaw: String(cachedRawBalance),
                    address: this.wallet.address,
                    source: 'CLOB_COLLATERAL'
                };
            }

            const sel = await this.getTradeReadyClient({ ttlMs: 30000 });
            const selectedRawBalance = sel?.selected?.balanceRaw;
            const selectedBalance = selectedRawBalance != null ? parseFloat(String(selectedRawBalance)) / 1e6 : null;
            const authFunderAddress = sel?.selected?.funderAddress || this.wallet.address;
            if (!sel?.client) {
                const balanceFromSelection = Number.isFinite(selectedBalance)
                    ? selectedBalance
                    : null;
                return {
                    success: Number.isFinite(balanceFromSelection),
                    error: sel?.summary || sel?.reason || 'CLOB client unavailable',
                    balance: Number.isFinite(balanceFromSelection) ? balanceFromSelection : 0,
                    balanceRaw: Number.isFinite(balanceFromSelection) ? String(selectedRawBalance) : '0',
                    address: this.wallet.address,
                    source: 'CLOB_COLLATERAL'
                };
            }

            await withClobAuthContext(sel.sigType, authFunderAddress, () => sel.client.updateBalanceAllowance({ asset_type: 'COLLATERAL' }).catch(() => { }));
            const ba = await withClobAuthContext(sel.sigType, authFunderAddress, () => sel.client.getBalanceAllowance({ asset_type: 'COLLATERAL' }).catch((e) => ({ error: e.message || String(e) })));
            const baError = ba && typeof ba === 'object' && Object.prototype.hasOwnProperty.call(ba, 'error')
                ? String(ba.error)
                : null;
            const rawBalance = baError ? null : ba?.balance;
            const balance = rawBalance != null
                ? parseFloat(rawBalance) / 1e6
                : (Number.isFinite(selectedBalance) ? selectedBalance : 0);
            if (rawBalance == null && !Number.isFinite(selectedBalance)) {
                return { success: false, error: baError || 'CLOB collateral unavailable', balance: 0, address: this.wallet.address, source: 'CLOB_COLLATERAL' };
            }

            return {
                success: Number.isFinite(balance),
                balance: Number.isFinite(balance) ? balance : 0,
                balanceRaw: rawBalance != null ? String(rawBalance) : String(selectedRawBalance || '0'),
                address: this.wallet.address,
                source: 'CLOB_COLLATERAL'
            };
        } catch (e) {
            return { success: false, error: e.message, balance: 0, address: this.wallet.address, source: 'CLOB_COLLATERAL' };
        }
    }

    async getTokenBalance(tokenId) {
        if (!this.wallet || !ethers) {
            return { success: false, error: 'No wallet loaded', balance: 0 };
        }

        try {
            const provider = this._getProvider();
            const contract = new ethers.Contract(CTF_ADDRESS, CTF_ABI, provider);
            const rawBalance = await contract.balanceOf(this.wallet.address, tokenId);
            const balance = parseFloat(ethers.utils.formatUnits(rawBalance, 0));
            return {
                success: true,
                balance: Number.isFinite(balance) ? balance : 0,
                balanceRaw: rawBalance.toString(),
                tokenId,
                address: this.wallet.address
            };
        } catch (e) {
            return { success: false, error: e.message, balance: 0, tokenId };
        }
    }

    async redeemPosition(conditionId) {
        if (!this.wallet || !ethers) {
            return { success: false, error: 'No wallet loaded' };
        }

        try {
            const provider = this._getProvider();
            const wallet = this.wallet.connect(provider);
            const contract = new ethers.Contract(CTF_ADDRESS, CTF_ABI, wallet);
            const parentCollectionId = ethers.constants.HashZero;
            const indexSets = [1, 2];
            const gasEstimate = await contract.estimateGas.redeemPositions(
                USDC_ADDRESS,
                parentCollectionId,
                conditionId,
                indexSets
            );
            const tx = await contract.redeemPositions(
                USDC_ADDRESS,
                parentCollectionId,
                conditionId,
                indexSets,
                { gasLimit: gasEstimate.mul(120).div(100) }
            );
            const receipt = await tx.wait();
            return { success: receipt?.status === 1, txHash: tx.hash, receipt };
        } catch (e) {
            return { success: false, error: e.message };
        }
    }

    async getBalance() {
        const result = await this.getClobCollateralBalance();
        return result?.success ? result.balance : null;
    }

    isReady() {
        return !!ClobClient && !!ethers && !!this.wallet;
    }

    getStatus() {
        const tradeReady = this._tradeReadyCache && typeof this._tradeReadyCache === 'object'
            ? {
                ok: !!this._tradeReadyCache.ok,
                summary: this._tradeReadyCache.summary || null,
                reason: this._tradeReadyCache.reason || null,
                sigType: Number.isFinite(Number(this._tradeReadyCache.sigType)) ? Number(this._tradeReadyCache.sigType) : null,
                balance: Number.isFinite(Number(this._tradeReadyCache.balance)) ? Number(this._tradeReadyCache.balance) : null,
                closedOnly: this._tradeReadyCache.closedOnly ?? null,
                closedOnlyErr: this._tradeReadyCache.closedOnlyErr || null,
                selected: this._tradeReadyCache.selected || null,
                candidates: Array.isArray(this._tradeReadyCache.candidates) ? this._tradeReadyCache.candidates : []
            }
            : null;
        return {
            clientAvailable: !!ClobClient,
            ethersAvailable: !!ethers,
            walletLoaded: !!this.wallet,
            walletAddress: this.walletAddress,
            hasCreds: !!(CONFIG.POLYMARKET_API_KEY && CONFIG.POLYMARKET_SECRET && CONFIG.POLYMARKET_PASSPHRASE),
            sigType: Number(CONFIG.POLYMARKET_SIGNATURE_TYPE) || 0,
            lastProbe: this._lastSelectionKey,
            proxyConfigured: !!CONFIG.PROXY_URL,
            clobForceProxy: !!CONFIG.CLOB_FORCE_PROXY,
            rpcEndpointCount: getPolygonRpcEndpoints().length,
            tradeReady
        };
    }
}

module.exports = PolymarketCLOB;
