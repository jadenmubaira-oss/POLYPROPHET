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

function installClobAxiosRouting() {
    if (clobAxiosRoutingInstalled || !axios) return;

    if (CONFIG.PROXY_URL && HttpsProxyAgent) {
        try {
            clobProxyAgent = new HttpsProxyAgent(CONFIG.PROXY_URL);
        } catch (e) {
            console.log(`⚠️ CLOB proxy agent init failed: ${e.message}`);
        }
    }

    axios.interceptors.request.use((requestConfig) => {
        const nextConfig = requestConfig || {};
        const url = String(nextConfig.url || '');
        if (!url.includes('clob.polymarket.com')) return nextConfig;

        nextConfig.proxy = false;
        if (CONFIG.CLOB_FORCE_PROXY && clobProxyAgent) {
            nextConfig.httpsAgent = clobProxyAgent;
        } else if (nextConfig.httpsAgent) {
            nextConfig.httpsAgent = https.globalAgent;
        }
        return nextConfig;
    });

    clobAxiosRoutingInstalled = true;

    if (CONFIG.PROXY_URL && CONFIG.CLOB_FORCE_PROXY && clobProxyAgent) {
        console.log(`✅ CLOB proxy routing active: ${CONFIG.PROXY_URL.replace(/:[^:@]+@/, ':***@')}`);
    } else if (CONFIG.PROXY_URL) {
        console.log('ℹ️ CLOB proxy routing: direct by default, set CLOB_FORCE_PROXY=1 to force proxy');
    }
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
        return new ethers.providers.JsonRpcProvider('https://polygon-rpc.com');
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
            const provider = new ethers.providers.JsonRpcProvider('https://polygon-rpc.com');
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
                const tmp = new ClobClient(host, POLY_CHAIN_ID, this.wallet);
                const creds = await tmp.createOrDeriveApiKey();
                const key = String(creds?.key || '').trim();
                const secret = String(creds?.secret || '').trim();
                const passphrase = String(creds?.passphrase || '').trim();

                if (!key || !secret || !passphrase) {
                    return { ok: false, reason: 'Derive returned empty creds' };
                }

                CONFIG.POLYMARKET_API_KEY = key;
                CONFIG.POLYMARKET_SECRET = secret;
                CONFIG.POLYMARKET_PASSPHRASE = passphrase;
                console.log(`🔐 API creds derived from wallet (key=${key.slice(0, 8)}...)`);
                return { ok: true, source: 'derived' };
            } catch (e) {
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

            const probe = async (client) => {
                try {
                    const ba = await client.getBalanceAllowance({ asset_type: 'COLLATERAL' });
                    if (ba?.error) return { ok: false, balance: null };
                    const balance = String(ba?.balance ?? '').trim();
                    const balNum = parseFloat(balance) || 0;
                    const allowances = ba?.allowances || {};
                    let maxAllow = 0;
                    for (const val of Object.values(allowances)) {
                        const n = parseFloat(String(val)) || 0;
                        if (n > maxAllow) maxAllow = n;
                    }
                    return { ok: balNum > 0 && maxAllow > 0, balance: balNum / 1e6, allowance: maxAllow };
                } catch {
                    return { ok: false, balance: null };
                }
            };

            const [r0, r1] = await Promise.all([probe(client0), probe(client1)]);

            let client, sigType, probeResult;
            if (preferredSigType === 1) {
                if (r1.ok) { client = client1; sigType = 1; probeResult = r1; }
                else if (r0.ok) { client = client0; sigType = 0; probeResult = r0; }
                else { client = client1; sigType = 1; probeResult = r1; }
            } else {
                if (r0.ok) { client = client0; sigType = 0; probeResult = r0; }
                else if (r1.ok) { client = client1; sigType = 1; probeResult = r1; }
                else { client = client0; sigType = 0; probeResult = r0; }
            }

            const ok = !!probeResult.ok;
            const selKey = `${sigType}:${ok}`;
            if (selKey !== this._lastSelectionKey) {
                this._lastSelectionKey = selKey;
                console.log(`🔐 CLOB: sigType=${sigType} ${ok ? 'READY' : 'NOT_READY'} balance=${probeResult.balance}`);
            }

            const out = {
                ok,
                client,
                sigType,
                balance: probeResult.balance,
                reason: ok ? null : `Not trade-ready (sigType=${sigType})`,
                summary: ok ? `OK sigType=${sigType}` : `NOT_READY sigType=${sigType}`
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

    async getClobCollateralBalance() {
        if (!this.wallet) {
            return { success: false, error: 'No wallet loaded', balance: 0, source: 'CLOB_COLLATERAL' };
        }

        try {
            const sel = await this.getTradeReadyClient({ ttlMs: 30000 });
            if (!(sel?.client && sel?.ok)) {
                return {
                    success: false,
                    error: sel?.summary || sel?.reason || 'CLOB client unavailable',
                    balance: 0,
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
        return {
            clientAvailable: !!ClobClient,
            ethersAvailable: !!ethers,
            walletLoaded: !!this.wallet,
            walletAddress: this.walletAddress,
            hasCreds: !!(CONFIG.POLYMARKET_API_KEY && CONFIG.POLYMARKET_SECRET && CONFIG.POLYMARKET_PASSPHRASE),
            sigType: Number(CONFIG.POLYMARKET_SIGNATURE_TYPE) || 0,
            lastProbe: this._lastSelectionKey
        };
    }
}

module.exports = PolymarketCLOB;
