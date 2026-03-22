const CONFIG = require('./config');

const POLY_CHAIN_ID = 137; // Polygon mainnet

let ClobClient = null;
let ethers = null;

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

class PolymarketCLOB {
    constructor() {
        this.wallet = null;
        this.walletAddress = null;
        this._tradeReadyCache = null;
        this._tradeReadyCacheExpiry = 0;
        this._deriveCredsPromise = null;
        this._lastSelectionKey = null;
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

                return {
                    success: matchedShares > 0,
                    orderID: response.orderID,
                    fillStatus,
                    matchedShares,
                    error: matchedShares === 0 ? 'NO_FILL_AFTER_RETRIES' : null
                };
            } else {
                return { success: false, error: `No orderID in response: ${JSON.stringify(response)}` };
            }
        } catch (e) {
            return { success: false, error: `Order failed: ${e.message}` };
        }
    }

    async getBalance() {
        const sel = await this.getTradeReadyClient({ ttlMs: 10000 });
        return sel?.balance || null;
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
