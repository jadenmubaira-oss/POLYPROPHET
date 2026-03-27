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
        console.log(`⚠️ https-proxy-agent not available for CLOB routing: ${e.message}`);
    }
}

let clobAxiosRoutingInstalled = false;
let clobProxyAgent = null;

const directAgent = https.globalAgent;

function installClobAxiosRouting() {
    if (clobAxiosRoutingInstalled || !axios) return;

    if (CONFIG.PROXY_URL && HttpsProxyAgent) {
        try {
            clobProxyAgent = new HttpsProxyAgent(CONFIG.PROXY_URL);
        } catch (e) {
            console.log(`⚠️ CLOB proxy agent init failed: ${e.message}`);
        }
    }

    // Match legacy monolith behavior: when CLOB_FORCE_PROXY=1, set axios defaults
    // so ALL @polymarket/clob-client internal calls go through proxy.
    // This is required because the npm package uses axios internally and some calls
    // (createOrDeriveApiKey, postOrder) need proxy to bypass US geoblock.
    if (CONFIG.CLOB_FORCE_PROXY && clobProxyAgent) {
        axios.defaults.proxy = false;
        axios.defaults.httpsAgent = clobProxyAgent;
        console.log(`✅ CLOB axios defaults set to proxy: ${CONFIG.PROXY_URL.replace(/:[^:@]+@/, ':***@')}`);
    }

    // Interceptor: override for read-only CLOB endpoints to use direct (faster, not geoblocked)
    axios.interceptors.request.use((requestConfig) => {
        const nextConfig = requestConfig || {};
        const url = String(nextConfig.url || '');
        if (!url.includes('clob.polymarket.com')) return nextConfig;

        nextConfig.proxy = false;

        // CLOB read endpoints (book, price, prices-history) are NOT geoblocked — use direct.
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
        console.log(`✅ CLOB proxy routing: writes via proxy, reads direct`);
    } else if (CONFIG.PROXY_URL) {
        console.log('ℹ️ CLOB proxy available but CLOB_FORCE_PROXY not set — all direct');
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
        installClobAxiosRouting();
    }

    _getProvider() {
        if (this.wallet?.provider) return this.wallet.provider;
        if (!ethers?.providers?.JsonRpcProvider) return null;
        return new ethers.providers.JsonRpcProvider(getPolygonRpcEndpoints()[0]);
    }

    loadWallet() {
        if (!CONFIG.POLYMARKET_PRIVATE_KEY) {
            console.log('⚠️ No POLYMARKET_PRIVATE_KEY — wallet not loaded');
            return false;
        }
        if (!ethers) {
            console.log('⚠️ ethers not available — cannot load wallet');
            return false;
        }

        try {
            const provider = new ethers.providers.JsonRpcProvider(getPolygonRpcEndpoints()[0]);
            this.wallet = new ethers.Wallet(CONFIG.POLYMARKET_PRIVATE_KEY, provider);
            this.walletAddress = this.wallet.address;
            console.log(`✅ Wallet loaded: ${this.walletAddress}`);
            return true;
        } catch (e) {
            console.error(`❌ Wallet load failed: ${e.message}`);
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
                const sigType = Number(CONFIG.POLYMARKET_SIGNATURE_TYPE) || 0;
                const funderRaw = String(CONFIG.POLYMARKET_ADDRESS || '').trim();
                const funder = this._isAddress(funderRaw) ? funderRaw : (this.wallet.address || undefined);
                console.log(`🔐 Attempting API cred derivation... wallet=${this.wallet?.address?.slice(0, 10)}... sigType=${sigType} funder=${String(funder).slice(0,10)}...`);
                const tmp = new ClobClient(host, POLY_CHAIN_ID, this.wallet, undefined, sigType, funder);

                const derivePromise = tmp.createOrDeriveApiKey();
                const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error('DERIVE_TIMEOUT_30s')), 30000));
                const creds = await Promise.race([derivePromise, timeoutPromise]);

                console.log(`🔐 Derive response type=${typeof creds} keys=${creds ? Object.keys(creds).join(',') : 'null'}`);

                const key = String(creds?.key || creds?.apiKey || '').trim();
                const secret = String(creds?.secret || creds?.apiSecret || '').trim();
                const passphrase = String(creds?.passphrase || creds?.apiPassphrase || '').trim();

                if (!key || !secret || !passphrase) {
                    console.log(`🔐 Derive returned empty: raw=${JSON.stringify(creds).slice(0, 200)}`);
                    return { ok: false, reason: `Derive returned empty creds (raw keys: ${creds ? Object.keys(creds).join(',') : 'null'})` };
                }

                CONFIG.POLYMARKET_API_KEY = key;
                CONFIG.POLYMARKET_SECRET = secret;
                CONFIG.POLYMARKET_PASSPHRASE = passphrase;
                console.log(`🔐 API creds derived from wallet (key=${key.slice(0, 8)}...)`);
                return { ok: true, source: 'derived' };
            } catch (e) {
                console.log(`🔐 Derive error: ${e.message}`);
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

    async getTradeReadyClient(opts = {}) {
        if (!ClobClient) return { ok: false, reason: 'Missing @polymarket/clob-client', client: null };
        if (!this.wallet) return { ok: false, reason: 'No wallet loaded', client: null };

        const now = Date.now();
        const ttlMs = opts.ttlMs || 60000;
        const force = !!opts.force;

        if (!force && this._tradeReadyCache && this._tradeReadyCacheExpiry > now) {
            return this._tradeReadyCache;
        }

        // Ensure creds
        if (!CONFIG.POLYMARKET_API_KEY || !CONFIG.POLYMARKET_SECRET || !CONFIG.POLYMARKET_PASSPHRASE) {
            const derived = await this.ensureCreds().catch(() => ({ ok: false }));
            if (!derived?.ok) {
                const out = { ok: false, reason: 'Missing API creds and auto-derive failed', client: null };
                this._tradeReadyCache = out;
                this._tradeReadyCacheExpiry = now + ttlMs;
                return out;
            }
        }

        const host = 'https://clob.polymarket.com';
        const creds = this._buildCreds();

        const sigTypeRaw = Number(CONFIG.POLYMARKET_SIGNATURE_TYPE);
        const preferredSigType = Number.isFinite(sigTypeRaw) ? (sigTypeRaw === 1 ? 1 : 0) : 0;

        const funderRaw = String(CONFIG.POLYMARKET_ADDRESS || '').trim();
        const funder = this._isAddress(funderRaw) ? funderRaw : (this.wallet.address || undefined);

        try {
            const client0 = new ClobClient(host, POLY_CHAIN_ID, this.wallet, creds, 0, (this.wallet.address || undefined));
            const client1 = new ClobClient(host, POLY_CHAIN_ID, this.wallet, creds, 1, funder);

            const toBigIntOrNull = (raw) => {
                const value = String(raw ?? '').trim();
                if (!value || !/^\d+$/.test(value)) return null;
                try {
                    return BigInt(value);
                } catch {
                    return null;
                }
            };

            const computeMaxAllowance = (allowances) => {
                if (!allowances || typeof allowances !== 'object') {
                    return { maxRaw: null, spender: null, max: 0n };
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

            const probe = async (client, signatureType, funderAddress) => {
                const out = {
                    signatureType,
                    funderAddress,
                    refreshed: null,
                    refreshError: null,
                    balanceRaw: null,
                    allowanceMaxRaw: null,
                    allowanceMaxSpender: null,
                    ok: false,
                    error: null,
                    status: null
                };

                const updated = await client.updateBalanceAllowance({ asset_type: 'COLLATERAL' }).catch((e) => ({ error: e?.message || String(e) }));
                if (updated && typeof updated === 'object' && Object.prototype.hasOwnProperty.call(updated, 'error')) {
                    out.refreshed = false;
                    out.refreshError = String(updated.error);
                } else {
                    out.refreshed = true;
                }

                const balanceAllowance = await client.getBalanceAllowance({ asset_type: 'COLLATERAL' }).catch((e) => ({ error: e?.message || String(e) }));
                if (balanceAllowance && typeof balanceAllowance === 'object' && Object.prototype.hasOwnProperty.call(balanceAllowance, 'error')) {
                    out.error = String(balanceAllowance.error);
                    out.status = balanceAllowance?.status || null;
                    return out;
                }

                out.balanceRaw = String(balanceAllowance?.balance ?? '').trim() || null;
                const { maxRaw, spender, max } = computeMaxAllowance(balanceAllowance?.allowances);
                out.allowanceMaxRaw = maxRaw;
                out.allowanceMaxSpender = spender;
                const balance = toBigIntOrNull(out.balanceRaw) || 0n;
                out.ok = balance > 0n && max > 0n;
                return out;
            };

            const closedOnlyResponse = await client0.getClosedOnlyMode().catch((e) => ({ error: e?.message || String(e) }));
            const closedOnly = (closedOnlyResponse && typeof closedOnlyResponse === 'object' && Object.prototype.hasOwnProperty.call(closedOnlyResponse, 'error'))
                ? null
                : !!closedOnlyResponse?.closed_only;
            const closedOnlyErr = (closedOnlyResponse && typeof closedOnlyResponse === 'object' && Object.prototype.hasOwnProperty.call(closedOnlyResponse, 'error'))
                ? String(closedOnlyResponse.error)
                : null;

            const [r0, r1] = await Promise.all([
                probe(client0, 0, (this.wallet.address || undefined)),
                probe(client1, 1, funder)
            ]);

            const closedBlocks = closedOnly === true;
            const ok0 = !closedBlocks && !!r0.ok;
            const ok1 = !closedBlocks && !!r1.ok;

            let client;
            let sigType;
            let probeResult;
            if (preferredSigType === 1) {
                if (ok1) { client = client1; sigType = 1; probeResult = r1; }
                else if (ok0) { client = client0; sigType = 0; probeResult = r0; }
                else { client = client1; sigType = 1; probeResult = r1; }
            } else {
                if (ok0) { client = client0; sigType = 0; probeResult = r0; }
                else if (ok1) { client = client1; sigType = 1; probeResult = r1; }
                else { client = client0; sigType = 0; probeResult = r0; }
            }

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
                closedOnly,
                closedOnlyErr,
                selected: probeResult ? {
                    signatureType: probeResult.signatureType,
                    funderAddress: probeResult.funderAddress,
                    balanceRaw: probeResult.balanceRaw,
                    allowanceMaxRaw: probeResult.allowanceMaxRaw,
                    allowanceMaxSpender: probeResult.allowanceMaxSpender,
                    refreshed: probeResult.refreshed,
                    refreshError: probeResult.refreshError,
                    error: probeResult.error,
                    status: probeResult.status,
                    ok: !!probeResult.ok
                } : null,
                candidates: [r0, r1].map((candidate) => ({
                    signatureType: candidate.signatureType,
                    funderAddress: candidate.funderAddress,
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
        const sel = await this.getTradeReadyClient();
        if (!sel?.ok || !sel?.client) {
            return { success: false, error: sel?.reason || 'CLOB not ready' };
        }

        try {
            const order = await sel.client.createOrder({
                tokenID: tokenId,
                price: price,
                size: shares,
                side: side
            });

            const response = await sel.client.postOrder(order);

            if (response && response.orderID) {
                console.log(`✅ CLOB ORDER PLACED: ${response.orderID} | ${side} ${shares} @ ${(price*100).toFixed(1)}¢`);

                // Verify fill with retry
                let fillStatus = 'UNVERIFIED';
                let matchedShares = 0;
                for (let attempt = 1; attempt <= 3; attempt++) {
                    await new Promise(r => setTimeout(r, 2000));
                    try {
                        const orderStatus = await sel.client.getOrder(response.orderID);
                        if (orderStatus) {
                            fillStatus = String(orderStatus.status || 'UNKNOWN');
                            matchedShares = Number(orderStatus.size_matched || 0);

                            if (matchedShares > 0) {
                                console.log(`✅ Order MATCHED: ${matchedShares.toFixed(4)} shares`);
                                break;
                            } else if (['CANCELLED', 'EXPIRED', 'REJECTED'].includes(fillStatus.toUpperCase())) {
                                return { success: false, error: `Order ${fillStatus}`, orderID: response.orderID };
                            }
                        }
                    } catch {}
                }

                const safeMatchedShares = Number.isFinite(matchedShares) ? matchedShares : 0;
                const eps = 1e-6;
                const partialFill = safeMatchedShares > eps && safeMatchedShares + eps < shares;

                if (safeMatchedShares + eps < shares) {
                    try {
                        await sel.client.cancelOrder({ orderID: response.orderID });
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
                    error: safeMatchedShares <= eps ? 'NO_FILL_AFTER_RETRIES' : null
                };
            } else {
                return { success: false, error: `No orderID in response: ${JSON.stringify(response)}` };
            }
        } catch (e) {
            return { success: false, error: `Order failed: ${e.message}` };
        }
    }

    async getOrder(orderID) {
        const sel = await this.getTradeReadyClient({ ttlMs: 10000 });
        if (!sel?.client) {
            return { success: false, error: sel?.reason || 'CLOB not ready' };
        }

        try {
            const order = await sel.client.getOrder(orderID);
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
            const result = await sel.client.cancelOrder({ orderID });
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
            const sel = await this.getTradeReadyClient({ ttlMs: 30000 });
            if (!sel?.client) {
                const balanceFromSelection = sel?.selected?.balanceRaw != null
                    ? parseFloat(String(sel.selected.balanceRaw)) / 1e6
                    : null;
                return {
                    success: Number.isFinite(balanceFromSelection),
                    error: sel?.summary || sel?.reason || 'CLOB client unavailable',
                    balance: Number.isFinite(balanceFromSelection) ? balanceFromSelection : 0,
                    balanceRaw: sel?.selected?.balanceRaw != null ? String(sel.selected.balanceRaw) : '0',
                    address: this.wallet.address,
                    source: 'CLOB_COLLATERAL'
                };
            }

            await sel.client.updateBalanceAllowance({ asset_type: 'COLLATERAL' }).catch(() => { });
            const ba = await sel.client.getBalanceAllowance({ asset_type: 'COLLATERAL' }).catch(() => null);
            const rawBalance = ba?.balance;
            const balance = rawBalance != null ? parseFloat(rawBalance) / 1e6 : 0;

            return {
                success: Number.isFinite(balance),
                balance: Number.isFinite(balance) ? balance : 0,
                balanceRaw: rawBalance != null ? String(rawBalance) : '0',
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
