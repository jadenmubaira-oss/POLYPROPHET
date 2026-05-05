const CONFIG = require("./config");
const https = require("https");

const POLY_CHAIN_ID = 137; // Polygon mainnet

// V1 collateral (USDC.e) — legacy, still used for on-chain balance fallback
const USDC_ADDRESS = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";
const USDC_DECIMALS = 6;
const USDC_ABI = [
  "function balanceOf(address owner) view returns (uint256)",
  "function transfer(address to, uint256 amount) returns (bool)",
];

// V2 collateral (Polymarket USD / pUSD) — primary after CTF Exchange V2 cutover (Apr 28 2026)
const PUSD_ADDRESS = "0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB";
const PUSD_ABI = USDC_ABI;
const REDEEM_COLLATERAL_ADDRESS = PUSD_ADDRESS;
const CTF_ADDRESS = "0x4D97DCd97eC945f40cF65F87097ACe5EA0476045";
const CTF_ABI = [
  "function balanceOf(address owner, uint256 id) view returns (uint256)",
  "function redeemPositions(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] indexSets) external",
];
const PROXY_FACTORY_ADDRESS = "0xaB45c5A4B0c941a2F231C04C3f49182e1A254052";
const PROXY_FACTORY_ABI = [
  "function getImplementation() view returns (address)",
];
const PROXY_CLONE_PREFIX_A = "0x3d3d606380380380913d393d73";
const PROXY_CLONE_PREFIX_B =
  "0x5af4602a57600080fd5b602d8060366000396000f3363d3d373d3d3d363d73";
const PROXY_CLONE_PREFIX_C = "0x5af43d82803e903d91602b57fd5bf3";
const DEFAULT_POLYGON_RPC_URLS = [
  "https://polygon-bor-rpc.publicnode.com",
  "https://polygon.llamarpc.com",
  "https://polygon.drpc.org",
  "https://polygon-rpc.com",
  "https://1rpc.io/matic",
  "https://rpc.ankr.com/polygon",
];

function redactClobDiagnosticText(value) {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return String(text || "")
    .replace(/0x[a-fA-F0-9]{64,}/g, (m) => `${m.slice(0, 10)}…${m.slice(-6)}`)
    .replace(/Bearer\s+[A-Za-z0-9._~+\-/=]+/gi, "Bearer [REDACTED]")
    .replace(/"?(apiKey|secret|passphrase|privateKey|proxyPassword|password)"?\s*[:=]\s*"?[^",\s}]+"?/gi, '$1=[REDACTED]')
    .slice(0, 1200);
}

function buildClobFailureDiagnostic(errorOrResponse) {
  const response = errorOrResponse?.response || errorOrResponse;
  const headers = response?.headers || {};
  const safeHeaders = {};
  for (const key of ["content-type", "cf-ray", "server", "x-request-id", "x-ratelimit-remaining"]) {
    if (headers[key] != null) safeHeaders[key] = String(headers[key]).slice(0, 160);
  }

  const data = response?.data ?? response?.body ?? null;
  return {
    status: response?.status || response?.statusCode || null,
    statusText: response?.statusText || null,
    code: errorOrResponse?.code || null,
    message: redactClobDiagnosticText(errorOrResponse?.message || response?.message || ""),
    body: data == null ? null : redactClobDiagnosticText(data),
    headers: safeHeaders,
  };
}

function formatClobFailureDiagnostic(diagnostic) {
  if (!diagnostic) return null;
  return [
    diagnostic.status ? `status=${diagnostic.status}` : null,
    diagnostic.statusText ? `statusText=${diagnostic.statusText}` : null,
    diagnostic.code ? `code=${diagnostic.code}` : null,
    diagnostic.body || diagnostic.message || null,
  ].filter(Boolean).join(" | ") || null;
}

let ClobClient = null;
let OrderType = { GTC: "GTC", FOK: "FOK", FAK: "FAK", GTD: "GTD" };
let ethers = null;
let axios = null;
let HttpsProxyAgent = null;
let CallType = null;
let encodeProxyTransactionData = null;
let deriveProxyWallet = null;
let getRelayContractConfig = null;
let BuilderConfig = null;

// EPOCH 2: V2 SDK migration — dual-path loader with positional-arg adapter
// Polymarket CTF Exchange V2 cutover: Apr 28 2026 ~11:00 UTC
// V1 SDK (@polymarket/clob-client) stops functioning after cutover.
// V2 SDK uses options-object constructor; we wrap it so existing positional calls work.
try {
  const { ClobClient: V2ClobClient, OrderType: V2OrderType } = require("@polymarket/clob-client-v2");
  if (V2ClobClient) {
    if (V2OrderType) OrderType = V2OrderType;
    const Original = V2ClobClient;
    ClobClient = function(...args) {
      if (args.length >= 2 && typeof args[0] === 'string' && typeof args[1] === 'number') {
        const [host, chain, signer, creds, signatureType, funder] = args;
        return new Original({
          host,
          chain,
          signer,
          creds,
          signatureType,
          funder,
          funderAddress: funder,
        });
      }
      return new Original(...args);
    };
    Object.setPrototypeOf(ClobClient, Original);
    ClobClient.prototype = Original.prototype;
    console.log("✅ Polymarket CLOB V2 SDK loaded (positional adapter active)");
  }
} catch (e) {
  console.log("⚠️ @polymarket/clob-client-v2 not installed — trying V1 fallback...");
  try {
    ClobClient = require("@polymarket/clob-client").ClobClient;
    console.log("⚠️ V1 SDK fallback loaded — WILL STOP WORKING after V2 cutover (Apr 28 2026)");
  } catch (e2) {
    console.log("⚠️ Neither V1 nor V2 CLOB SDK installed — LIVE trading disabled");
  }
}

try {
  ethers = require("ethers");
} catch (e) {
  console.log("⚠️ ethers not installed — wallet operations disabled");
}

try {
  axios = require("axios");
} catch (e) {
  console.log("⚠️ axios not installed — CLOB proxy routing disabled");
}

try {
  ({
    CallType,
    encodeProxyTransactionData,
  } = require("@polymarket/builder-relayer-client"));
} catch (e) {
  console.log(
    "⚠️ @polymarket/builder-relayer-client not installed — proxy auto-redemption disabled",
  );
}

try {
  ({
    deriveProxyWallet,
  } = require("@polymarket/builder-relayer-client/dist/builder"));
} catch (e) {
  console.log(
    "⚠️ builder-relayer proxy helpers unavailable — proxy auto-redemption disabled",
  );
}

try {
  ({
    getContractConfig: getRelayContractConfig,
  } = require("@polymarket/builder-relayer-client/dist/config"));
} catch (e) {
  console.log(
    "⚠️ builder-relayer config helpers unavailable — proxy auto-redemption disabled",
  );
}

try {
  ({ BuilderConfig } = require("@polymarket/builder-signing-sdk"));
} catch (e) {
  console.log(
    "⚠️ @polymarket/builder-signing-sdk not installed — builder-auth relayer submits disabled",
  );
}

try {
  ({ HttpsProxyAgent } = require("https-proxy-agent"));
} catch (e) {
  if (CONFIG.PROXY_URL) {
    console.log(
      ` https-proxy-agent not available for CLOB routing: ${e.message}`,
    );
  }
}

let clobAxiosRoutingInstalled = false;
let clobProxyAgent = null;
let lastKnownProxyFunderAddress = null;
let activeClobAuthContext = null;
let clobRoutingDiagnostics = {
  installed: false,
  proxyConfigured: !!CONFIG.PROXY_URL,
  clobForceProxy: !!CONFIG.CLOB_FORCE_PROXY,
  proxyAgentReady: false,
  lastRequest: null,
  recentRequests: [],
};

const directAgent = https.globalAgent;

function getSafeClobPath(value) {
  try {
    const parsed = new URL(String(value || ""));
    return `${parsed.pathname || "/"}${parsed.search || ""}`;
  } catch {
    return String(value || "").replace(/^https?:\/\/clob\.polymarket\.com/i, "").slice(0, 160);
  }
}

function recordClobRoutingEvent(event) {
  const entry = {
    ts: new Date().toISOString(),
    ...event,
  };
  clobRoutingDiagnostics = {
    ...clobRoutingDiagnostics,
    installed: clobAxiosRoutingInstalled,
    proxyConfigured: !!CONFIG.PROXY_URL,
    clobForceProxy: !!CONFIG.CLOB_FORCE_PROXY,
    proxyAgentReady: !!clobProxyAgent,
    lastRequest: entry,
    recentRequests: [
      ...clobRoutingDiagnostics.recentRequests.slice(-19),
      entry,
    ],
  };
}

function getClobRoutingDiagnostics() {
  return {
    ...clobRoutingDiagnostics,
    recentRequests: clobRoutingDiagnostics.recentRequests.slice(-10),
  };
}

function getConfiguredFunderAddress() {
  const raw = String(CONFIG.POLYMARKET_ADDRESS || "").trim();
  try {
    if (raw && ethers?.utils?.isAddress && ethers.utils.isAddress(raw))
      return raw;
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
    if (
      address &&
      ethers?.utils?.isAddress &&
      ethers.utils.isAddress(address)
    ) {
      lastKnownProxyFunderAddress = address;
    }
  } catch {}
}

function getKnownProxyFunderAddress() {
  return getConfiguredFunderAddress() || lastKnownProxyFunderAddress;
}

function readRequestValue(source, key) {
  if (!source) return undefined;
  if (typeof source.get === "function") return source.get(key);
  return source[key];
}

function parseRequestSignatureType(nextConfig) {
  const paramsSigType = normalizeSignatureType(
    readRequestValue(nextConfig?.params, "signature_type"),
  );
  if (paramsSigType !== null) return paramsSigType;

  const data = nextConfig?.data;
  if (!data) return null;

  const parsePayload = (payload) => {
    if (!payload || typeof payload !== "object") return null;
    if (Array.isArray(payload)) {
      for (const entry of payload) {
        const nested = parsePayload(entry);
        if (nested !== null) return nested;
      }
      return null;
    }
    const direct = normalizeSignatureType(
      payload.signature_type ?? payload.signatureType,
    );
    if (direct !== null) return direct;
    const orderSigType = normalizeSignatureType(
      payload.order?.signatureType ?? payload.order?.signature_type,
    );
    if (orderSigType !== null) return orderSigType;
    return null;
  };

  if (typeof data === "string") {
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
      clobProxyAgent.toJSON = () => "[ProxyAgent]";
    } catch (e) {
      console.log(` CLOB proxy agent init failed: ${e.message}`);
    }
  }
  // Also prevent circular JSON on the direct agent
  if (directAgent && !directAgent.toJSON) {
    directAgent.toJSON = () => "[DirectAgent]";
  }

  // Do NOT set axios.defaults.httpsAgent — it causes "Converting circular structure
  // to JSON" errors in @polymarket/clob-client when it tries to serialize the config.
  // Instead, use ONLY the interceptor to inject the proxy agent at request time.
  axios.defaults.proxy = false;

  // Interceptor: route all clob.polymarket.com calls through appropriate agent.
  // Reads (book/price) go direct (not geoblocked). Writes (orders/auth) go through proxy.
  axios.interceptors.request.use((requestConfig) => {
    const nextConfig = requestConfig || {};
    const url = String(nextConfig.url || "");
    const baseURL = String(nextConfig.baseURL || "");
    const requestUrl = `${baseURL}${url}`;
    if (!requestUrl.includes("clob.polymarket.com")) return nextConfig;

    nextConfig.proxy = false;

    const requestSigType = activeClobAuthContext
      ? normalizeSignatureType(activeClobAuthContext.signatureType)
      : parseRequestSignatureType(nextConfig);
    const fallbackSigType = normalizeSignatureType(
      CONFIG.POLYMARKET_SIGNATURE_TYPE,
    );
    const sigType = requestSigType !== null ? requestSigType : fallbackSigType;
    const configuredFunder =
      activeClobAuthContext?.funderAddress || getKnownProxyFunderAddress();
    const headers = nextConfig.headers;
    const hasL2AuthHeaders =
      !!headers &&
      (typeof headers.POLY_API_KEY !== "undefined" ||
        typeof headers.poly_api_key !== "undefined" ||
        (typeof headers.get === "function" &&
          (headers.get("POLY_API_KEY") || headers.get("poly_api_key"))));
    // Do NOT override POLY_ADDRESS for L2-authed requests.
    // The @polymarket/clob-client sets POLY_ADDRESS = signer address in createL2Headers.
    // Overriding with the proxy funder causes "order signer must match API key" errors.

    const isReadOnly = /\/(book|price|prices-history)\b/.test(requestUrl);
    const routeEvent = {
      method: String(nextConfig.method || "GET").toUpperCase(),
      path: getSafeClobPath(requestUrl),
      isReadOnly,
      hasL2AuthHeaders,
      signatureType: sigType,
      funderAddressPresent: !!configuredFunder,
      agent: "none",
      proxied: false,
    };
    if (isReadOnly) {
      nextConfig.httpsAgent = directAgent;
      routeEvent.agent = "direct";
    } else if (clobProxyAgent) {
      nextConfig.httpsAgent = clobProxyAgent;
      routeEvent.agent = "proxy";
      routeEvent.proxied = true;
    }
    recordClobRoutingEvent(routeEvent);
    return nextConfig;
  });

  clobAxiosRoutingInstalled = true;
  clobRoutingDiagnostics = {
    ...clobRoutingDiagnostics,
    installed: true,
    proxyConfigured: !!CONFIG.PROXY_URL,
    clobForceProxy: !!CONFIG.CLOB_FORCE_PROXY,
    proxyAgentReady: !!clobProxyAgent,
  };

  if (CONFIG.PROXY_URL && CONFIG.CLOB_FORCE_PROXY && clobProxyAgent) {
    console.log(` CLOB proxy routing: writes via proxy, reads direct`);
  } else if (CONFIG.PROXY_URL) {
    console.log(
      " CLOB proxy available but CLOB_FORCE_PROXY not set — all direct",
    );
  }
}

function getPolygonRpcEndpoints() {
  const raw = String(process.env.POLYGON_RPC_URLS || "").trim();
  const endpoints = (
    raw
      ? raw
          .split(",")
          .map((item) => item.trim())
          .filter(Boolean)
      : DEFAULT_POLYGON_RPC_URLS.slice()
  ).slice(0, 10);
  return endpoints.length > 0
    ? endpoints
    : DEFAULT_POLYGON_RPC_URLS.slice(0, 10);
}

function getPolygonRpcTimeoutMs() {
  const parsed = Number(process.env.POLYGON_RPC_TIMEOUT_MS || 8000);
  return Number.isFinite(parsed)
    ? Math.max(2000, Math.min(20000, parsed))
    : 8000;
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
    this._orderEndpointPreflightCache = null;
    this._orderEndpointPreflightExpiry = 0;
    installClobAxiosRouting();
  }

  _isClobOrderEndpointBlockedPreflight(diagnostic) {
    const status = Number(diagnostic?.status || 0);
    const text = `${diagnostic?.message || ""} ${diagnostic?.body || ""}`.toLowerCase();
    return (
      status === 403 &&
      (text.includes("trading restricted") ||
        text.includes("geoblock") ||
        text.includes("restricted in your region"))
    );
  }

  async checkClobOrderEndpointPreflight(opts = {}) {
    const now = Date.now();
    const ttlMs = Number(opts.ttlMs || 60000);
    const force = !!opts.force;
    if (!force && this._orderEndpointPreflightCache && this._orderEndpointPreflightExpiry > now) {
      return this._orderEndpointPreflightCache;
    }
    if (!axios) {
      return { ok: false, blocked: false, reason: "axios unavailable" };
    }

    try {
      // This is intentionally not a valid trade. It probes the exact CLOB write endpoint
      // before we risk a real order. A healthy route should fail validation/auth, not geoblock.
      await axios.post(
        "https://clob.polymarket.com/order",
        { order: {}, owner: this.wallet?.address || "0x0000000000000000000000000000000000000000", orderType: "GTC" },
        { timeout: 15000, proxy: false, httpsAgent: clobProxyAgent || directAgent },
      );
      const out = { ok: true, blocked: false, reason: "unexpected order preflight success" };
      this._orderEndpointPreflightCache = out;
      this._orderEndpointPreflightExpiry = now + ttlMs;
      return out;
    } catch (e) {
      const diagnostic = buildClobFailureDiagnostic(e);
      const summary = formatClobFailureDiagnostic(diagnostic);
      const blocked = this._isClobOrderEndpointBlockedPreflight(diagnostic);
      const ok = !blocked && Number(diagnostic?.status || 0) !== 0;
      const out = {
        ok,
        blocked,
        status: diagnostic.status,
        reason: blocked
          ? `CLOB_ORDER_ENDPOINT_GEOBLOCKED: ${summary || e.message}`
          : `CLOB_ORDER_ENDPOINT_PREFLIGHT_${ok ? "VALIDATION_REACHED" : "FAILED"}: ${summary || e.message}`,
        clobFailure: diagnostic,
        clobFailureSummary: summary || null,
      };
      this._orderEndpointPreflightCache = out;
      this._orderEndpointPreflightExpiry = now + (blocked ? ttlMs : Math.min(ttlMs, 15000));
      return out;
    }
  }

  _getProvider() {
    if (this.wallet?.provider) return this.wallet.provider;
    if (!ethers?.providers?.JsonRpcProvider) return null;
    return new ethers.providers.JsonRpcProvider(getPolygonRpcEndpoints()[0]);
  }

  loadWallet() {
    if (!CONFIG.POLYMARKET_PRIVATE_KEY) {
      console.log(" No POLYMARKET_PRIVATE_KEY — wallet not loaded");
      return false;
    }
    if (!ethers) {
      console.log(" ethers not available — cannot load wallet");
      return false;
    }

    try {
      const provider = new ethers.providers.JsonRpcProvider(
        getPolygonRpcEndpoints()[0],
      );
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
    if (!ClobClient || !this.wallet)
      return { ok: false, reason: "Missing client or wallet" };

    const hasCreds =
      CONFIG.POLYMARKET_API_KEY &&
      CONFIG.POLYMARKET_SECRET &&
      CONFIG.POLYMARKET_PASSPHRASE;
    if (hasCreds) return { ok: true, source: "env" };
    if (!CONFIG.POLYMARKET_AUTO_DERIVE_CREDS)
      return {
        ok: false,
        reason: "Missing API creds and auto-derive disabled",
      };

    if (this._deriveCredsPromise) return await this._deriveCredsPromise;

    this._deriveCredsPromise = (async () => {
      try {
        const host = "https://clob.polymarket.com";
        const signerAddr = this.wallet?.address;
        const proxyAddr = getConfiguredFunderAddress();
        const prefSigType = this._getPreferredSignatureType();

        const extractCreds = (raw) => {
          const k = String(raw?.key || raw?.apiKey || "").trim();
          const s = String(raw?.secret || raw?.apiSecret || "").trim();
          const p = String(raw?.passphrase || raw?.apiPassphrase || "").trim();
          return k && s && p ? { key: k, secret: s, passphrase: p } : null;
        };

        const tryDerive = async (sigType, funder, label) => {
          try {
            console.log(
              ` Deriving creds: sigType=${sigType} funder=${funder?.slice(0, 10)}... (${label})`,
            );
            const tmp = new ClobClient(
              host,
              POLY_CHAIN_ID,
              this.wallet,
              undefined,
              sigType,
              funder,
            );
            const raw = await Promise.race([
              tmp.deriveApiKey(),
              new Promise((_, rej) =>
                setTimeout(() => rej(new Error("DERIVE_TIMEOUT_20s")), 20000),
              ),
            ]);
            return extractCreds(raw);
          } catch (e) {
            console.log(` Derive (${label}) failed: ${e.message}`);
            return null;
          }
        };

        // Try preferred sigType first, then fallback
        const attempts = [];
        if (prefSigType === 1 && proxyAddr) {
          attempts.push([1, proxyAddr, "proxy-sigType1"]);
        }
        attempts.push([0, signerAddr, "eoa-sigType0"]);
        if (
          prefSigType === 1 &&
          proxyAddr &&
          !attempts.some((a) => a[0] === 1)
        ) {
          attempts.push([1, proxyAddr, "proxy-sigType1-fallback"]);
        }

        for (const [sigType, funder, label] of attempts) {
          const creds = await tryDerive(sigType, funder, label);
          if (creds) {
            CONFIG.POLYMARKET_API_KEY = creds.key;
            CONFIG.POLYMARKET_SECRET = creds.secret;
            CONFIG.POLYMARKET_PASSPHRASE = creds.passphrase;
            this._lastDerivedClobCreds = {
              POLYMARKET_API_KEY: creds.key,
              POLYMARKET_SECRET: creds.secret,
              POLYMARKET_PASSPHRASE: creds.passphrase,
            };
            console.log(
              ` API creds derived via ${label} (key=${creds.key.slice(0, 8)}...)`,
            );
            return { ok: true, source: `derived-${label}` };
          }
        }

        return {
          ok: false,
          reason: "All derive attempts returned empty creds",
        };
      } catch (e) {
        console.log(` Derive error: ${e.message}`);
        return { ok: false, reason: `Derive failed: ${e.message}` };
      } finally {
        this._deriveCredsPromise = null;
      }
    })();

    return await this._deriveCredsPromise;
  }

  async rederiveCreds() {
    CONFIG.POLYMARKET_API_KEY = "";
    CONFIG.POLYMARKET_SECRET = "";
    CONFIG.POLYMARKET_PASSPHRASE = "";
    this._deriveCredsPromise = null;
    return await this.ensureCreds();
  }

  _buildCreds() {
    return {
      key: String(CONFIG.POLYMARKET_API_KEY || "").replace(/[^\x20-\x7E]/g, ""),
      secret: String(CONFIG.POLYMARKET_SECRET || "").replace(
        /[^\x20-\x7E]/g,
        "",
      ),
      passphrase: String(CONFIG.POLYMARKET_PASSPHRASE || "").replace(
        /[^\x20-\x7E]/g,
        "",
      ),
    };
  }

  getLastDerivedClobSecrets() {
    const creds = this._lastDerivedClobCreds || null;
    if (!creds) return null;
    const k = String(creds.POLYMARKET_API_KEY || "").trim();
    const s = String(creds.POLYMARKET_SECRET || "").trim();
    const p = String(creds.POLYMARKET_PASSPHRASE || "").trim();
    if (!k || !s || !p) return null;
    return {
      POLYMARKET_API_KEY: k,
      POLYMARKET_SECRET: s,
      POLYMARKET_PASSPHRASE: p,
    };
  }

  _isAddress(a) {
    try {
      return !!a && ethers?.utils?.isAddress && ethers.utils.isAddress(a);
    } catch {
      return false;
    }
  }

  _getPreferredSignatureType() {
    const configured = normalizeSignatureType(CONFIG.POLYMARKET_SIGNATURE_TYPE);
    return configured !== null ? configured : 0;
  }

  _getRelayerUrl() {
    const configured = String(CONFIG.POLYMARKET_RELAYER_URL || "").trim();
    return configured || "https://relayer-v2.polymarket.com";
  }

  _getRelayerAuthMode() {
    if (String(CONFIG.POLYMARKET_RELAYER_API_KEY || "").trim())
      return "relayer_api_key";
    const hasBuilderCreds = !!(
      String(CONFIG.POLYMARKET_BUILDER_API_KEY || "").trim() &&
      String(CONFIG.POLYMARKET_BUILDER_SECRET || "").trim() &&
      String(CONFIG.POLYMARKET_BUILDER_PASSPHRASE || "").trim()
    );
    return hasBuilderCreds ? "builder" : null;
  }

  async _ensureBuilderCreds() {
    if (this._getRelayerAuthMode()) return true;
    if (this._deriveBuilderCredsPromise)
      return await this._deriveBuilderCredsPromise;
    if (!ClobClient || !this.wallet) return false;
    const hasClobCreds = !!(
      CONFIG.POLYMARKET_API_KEY &&
      CONFIG.POLYMARKET_SECRET &&
      CONFIG.POLYMARKET_PASSPHRASE
    );
    if (!hasClobCreds) return false;

    this._deriveBuilderCredsPromise = (async () => {
      try {
        const host = "https://clob.polymarket.com";
        const sigType = Number(CONFIG.POLYMARKET_SIGNATURE_TYPE) === 1 ? 1 : 0;
        const funder =
          sigType === 1 ? getConfiguredFunderAddress() : this.wallet.address;
        const creds = {
          key: CONFIG.POLYMARKET_API_KEY,
          secret: CONFIG.POLYMARKET_SECRET,
          passphrase: CONFIG.POLYMARKET_PASSPHRASE,
        };
        const tmp = new ClobClient(
          host,
          POLY_CHAIN_ID,
          this.wallet,
          creds,
          sigType,
          funder,
        );
        const raw = await Promise.race([
          tmp.createBuilderApiKey(),
          new Promise((_, rej) =>
            setTimeout(
              () => rej(new Error("BUILDER_DERIVE_TIMEOUT_20s")),
              20000,
            ),
          ),
        ]);
        const k = String(raw?.key || raw?.apiKey || "").trim();
        const s = String(raw?.secret || raw?.apiSecret || "").trim();
        const p = String(raw?.passphrase || raw?.apiPassphrase || "").trim();
        if (k && s && p) {
          CONFIG.POLYMARKET_BUILDER_API_KEY = k;
          CONFIG.POLYMARKET_BUILDER_SECRET = s;
          CONFIG.POLYMARKET_BUILDER_PASSPHRASE = p;
          console.log(
            ` Builder API key auto-derived (key=${k.slice(0, 8)}...)`,
          );
          return true;
        }
        console.log(" Builder API key derivation returned incomplete creds");
        return false;
      } catch (e) {
        console.log(` Builder API key auto-derivation failed: ${e.message}`);
        return false;
      } finally {
        this._deriveBuilderCredsPromise = null;
      }
    })();
    return await this._deriveBuilderCredsPromise;
  }

  async ensureProxyRedeemAuth() {
    const creds = await this.ensureCreds();
    const builderReady = await this._ensureBuilderCreds();
    const authMode = this._getRelayerAuthMode();
    const ok = !!authMode;
    return {
      ok,
      derived: !!(creds?.ok || builderReady),
      authMode,
      proxyRedeemAuthReady: ok,
      proxyRedeemAuthDerivable: !!this.wallet,
      relayerAuthConfigured: !!authMode,
      lastBuilderDerive: this._lastBuilderDeriveStatus || null,
    };
  }

  _getRelayerApiKeyAddress() {
    const configured = String(
      CONFIG.POLYMARKET_RELAYER_API_KEY_ADDRESS || "",
    ).trim();
    if (this._isAddress(configured)) return ethers.utils.getAddress(configured);
    return this._isAddress(this.wallet?.address)
      ? ethers.utils.getAddress(this.wallet.address)
      : null;
  }

  _getRelayerRequestConfig(extra = {}, useProxy = false) {
    const requestConfig = Object.assign(
      { timeout: 30000, proxy: false },
      extra || {},
    );
    if (!requestConfig.httpsAgent) {
      if (useProxy && clobProxyAgent) requestConfig.httpsAgent = clobProxyAgent;
      else if (directAgent) requestConfig.httpsAgent = directAgent;
      else if (clobProxyAgent) requestConfig.httpsAgent = clobProxyAgent;
    }
    return requestConfig;
  }

  _formatAxiosError(error) {
    if (axios?.isAxiosError?.(error)) {
      const status = Number(error?.response?.status) || null;
      const payload = error?.response?.data;
      const detail =
        typeof payload === "string"
          ? payload
          : payload?.error || payload?.message || null;
      return {
        status,
        message: status
          ? `HTTP ${status}: ${detail || error.message}`
          : detail || error.message,
        payload,
      };
    }
    return {
      status: null,
      message: error?.message || String(error),
      payload: null,
    };
  }

  _isProxyTransportError(error) {
    const formatted = this._formatAxiosError(error);
    const message = String(formatted?.message || "").toLowerCase();
    return (
      Number(formatted?.status) === 407 ||
      message.includes("proxy") ||
      message.includes("tunneling socket") ||
      message.includes("econnrefused") ||
      message.includes("socket hang up")
    );
  }

  async _relayGet(path, params = null, headers = null) {
    if (!axios) throw new Error("axios not available");
    try {
      const response = await axios.get(
        `${this._getRelayerUrl()}${path}`,
        this._getRelayerRequestConfig(
          {
            params: params || undefined,
            headers: headers || undefined,
          },
          false,
        ),
      );
      return response?.data;
    } catch (directError) {
      if (!clobProxyAgent) throw directError;
      const response = await axios.get(
        `${this._getRelayerUrl()}${path}`,
        this._getRelayerRequestConfig(
          {
            params: params || undefined,
            headers: headers || undefined,
          },
          true,
        ),
      );
      return response?.data;
    }
  }

  async _relayPost(path, body, headers = null) {
    if (!axios) throw new Error("axios not available");
    if (clobProxyAgent) {
      try {
        const response = await axios.post(
          `${this._getRelayerUrl()}${path}`,
          body,
          this._getRelayerRequestConfig(
            {
              headers: headers || undefined,
            },
            true,
          ),
        );
        return response?.data;
      } catch (proxyError) {
        if (!this._isProxyTransportError(proxyError)) throw proxyError;
      }
    }

    const response = await axios.post(
      `${this._getRelayerUrl()}${path}`,
      body,
      this._getRelayerRequestConfig(
        {
          headers: headers || undefined,
        },
        false,
      ),
    );
    return response?.data;
  }

  async _buildRelayerSubmitHeaders(path, body) {
    const authMode = this._getRelayerAuthMode();
    if (authMode === "relayer_api_key") {
      const apiKey = String(CONFIG.POLYMARKET_RELAYER_API_KEY || "").trim();
      const ownerAddress = this._getRelayerApiKeyAddress();
      if (!apiKey || !ownerAddress) {
        return {
          ok: false,
          authMode,
          error:
            "PROXY_REDEEM_AUTH_INVALID (RELAYER_API_KEY or RELAYER_API_KEY_ADDRESS missing/invalid)",
        };
      }
      return {
        ok: true,
        authMode,
        headers: {
          RELAYER_API_KEY: apiKey,
          RELAYER_API_KEY_ADDRESS: ownerAddress,
        },
      };
    }

    if (authMode === "builder") {
      if (!BuilderConfig) {
        return {
          ok: false,
          authMode,
          error:
            "PROXY_REDEEM_AUTH_INVALID (@polymarket/builder-signing-sdk unavailable)",
        };
      }

      try {
        const builderConfig = new BuilderConfig({
          localBuilderCreds: {
            key: String(CONFIG.POLYMARKET_BUILDER_API_KEY || "").trim(),
            secret: String(CONFIG.POLYMARKET_BUILDER_SECRET || "").trim(),
            passphrase: String(
              CONFIG.POLYMARKET_BUILDER_PASSPHRASE || "",
            ).trim(),
          },
        });
        const headers = await builderConfig.generateBuilderHeaders(
          "POST",
          path,
          body,
        );
        if (!headers) {
          return {
            ok: false,
            authMode,
            error:
              "PROXY_REDEEM_AUTH_INVALID (builder header generation returned empty payload)",
          };
        }
        return { ok: true, authMode, headers };
      } catch (e) {
        return {
          ok: false,
          authMode,
          error: `PROXY_REDEEM_AUTH_INVALID (${e.message})`,
        };
      }
    }

    return {
      ok: false,
      authMode: null,
      error:
        "PROXY_REDEEM_AUTH_MISSING (set POLYMARKET_RELAYER_API_KEY or POLYMARKET_BUILDER_* creds)",
    };
  }

  _calculateProxyRelayGasLimit(transactionCount = 1) {
    const safeCount = Math.max(1, Number(transactionCount) || 1);
    const baseGasPerTx = 150000;
    const relayHubPadding = 3450000;
    const overheadBuffer = 450000;
    const intrinsicCost = 30000;
    const minExecutionBuffer = 500000;
    const txGas = safeCount * baseGasPerTx;
    const relayerWillSend = txGas + relayHubPadding;
    const maxSignable = relayerWillSend - intrinsicCost - overheadBuffer;
    const executionNeeds = txGas + minExecutionBuffer;
    return String(Math.min(maxSignable, Math.max(executionNeeds, 3000000)));
  }

  async _buildProxyRelayRequest(
    encodedData,
    relayPayload,
    metadata = "",
    transactionCount = 1,
  ) {
    if (!ethers) throw new Error("ethers not available");
    if (!getRelayContractConfig)
      throw new Error("builder-relayer config helpers unavailable");

    const signerAddress = this._isAddress(this.wallet?.address)
      ? ethers.utils.getAddress(this.wallet.address)
      : null;
    if (!signerAddress) throw new Error("Invalid wallet address");

    const proxyContracts = getRelayContractConfig(POLY_CHAIN_ID).ProxyContracts;
    if (!proxyContracts?.ProxyFactory || !proxyContracts?.RelayHub) {
      throw new Error("Unsupported relay contract config");
    }

    let proxyWallet = null;
    if (typeof deriveProxyWallet === "function") {
      proxyWallet = deriveProxyWallet(
        signerAddress,
        proxyContracts.ProxyFactory,
      );
    }
    if (!this._isAddress(proxyWallet)) {
      const derived = await this._deriveProxyWalletAddress(60000);
      proxyWallet = derived?.address || null;
    }
    if (!this._isAddress(proxyWallet)) {
      throw new Error(
        "Unable to derive proxy wallet address for relayer submit",
      );
    }

    const gasLimit = this._calculateProxyRelayGasLimit(transactionCount);
    const gasPrice = "0";
    const relayerFee = "0";
    const to = proxyContracts.ProxyFactory;
    const dataToHash = ethers.utils.hexConcat([
      ethers.utils.hexlify(ethers.utils.toUtf8Bytes("rlx:")),
      signerAddress,
      to,
      encodedData,
      ethers.utils.hexZeroPad(
        ethers.BigNumber.from(relayerFee).toHexString(),
        32,
      ),
      ethers.utils.hexZeroPad(
        ethers.BigNumber.from(gasPrice).toHexString(),
        32,
      ),
      ethers.utils.hexZeroPad(
        ethers.BigNumber.from(gasLimit).toHexString(),
        32,
      ),
      ethers.utils.hexZeroPad(
        ethers.BigNumber.from(String(relayPayload?.nonce || "0")).toHexString(),
        32,
      ),
      proxyContracts.RelayHub,
      relayPayload.address,
    ]);
    const relayHash = ethers.utils.keccak256(dataToHash);
    const signature = await this.wallet.signMessage(
      ethers.utils.arrayify(relayHash),
    );

    return {
      from: signerAddress,
      to,
      proxyWallet: ethers.utils.getAddress(proxyWallet),
      data: encodedData,
      nonce: String(relayPayload?.nonce || "0"),
      signature,
      signatureParams: {
        gasPrice,
        gasLimit,
        relayerFee,
        relayHub: proxyContracts.RelayHub,
        relay: relayPayload.address,
      },
      type: "PROXY",
      metadata: metadata || "",
    };
  }

  async _pollRelayerTransaction(transactionID, maxPolls = 100, pollMs = 2000) {
    for (let attempt = 0; attempt < maxPolls; attempt++) {
      const txns = await this._relayGet("/transaction", { id: transactionID });
      const txn = Array.isArray(txns) ? txns[0] : null;
      if (
        txn &&
        ["STATE_MINED", "STATE_CONFIRMED"].includes(String(txn.state || ""))
      ) {
        return txn;
      }
      if (
        txn &&
        ["STATE_FAILED", "STATE_INVALID"].includes(String(txn.state || ""))
      ) {
        return txn;
      }
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
    return null;
  }

  async _submitProxyRelayTransactions(transactions, metadata = "") {
    if (!this.wallet || !ethers) {
      return {
        success: false,
        error: "No wallet loaded",
        requiresManual: true,
      };
    }
    if (
      !axios ||
      !CallType ||
      !encodeProxyTransactionData ||
      !getRelayContractConfig
    ) {
      return {
        success: false,
        error:
          "PROXY_REDEEM_UNAVAILABLE (builder relayer dependencies missing)",
        requiresManual: true,
      };
    }

    try {
      await this._ensureBuilderCreds();
      const authMode = this._getRelayerAuthMode();
      if (!authMode) {
        return {
          success: false,
          error:
            "PROXY_REDEEM_AUTH_MISSING (auto-derivation failed; set POLYMARKET_RELAYER_API_KEY or POLYMARKET_BUILDER_* creds)",
          authMode: null,
          requiresManual: true,
        };
      }

      const proxyTransactions = (
        Array.isArray(transactions) ? transactions : []
      )
        .map((txn) => ({
          to: txn?.to,
          typeCode: CallType.Call,
          data: txn?.data,
          value: String(txn?.value ?? "0"),
        }))
        .filter(
          (txn) =>
            this._isAddress(txn.to) &&
            typeof txn.data === "string" &&
            txn.data.startsWith("0x"),
        );

      if (proxyTransactions.length === 0) {
        return {
          success: false,
          error: "No valid proxy transactions to submit",
        };
      }

      const relayPayload = await this._relayGet("/relay-payload", {
        address: ethers.utils.getAddress(this.wallet.address),
        type: "PROXY",
      });
      const encodedData = encodeProxyTransactionData(proxyTransactions);
      const request = await this._buildProxyRelayRequest(
        encodedData,
        relayPayload,
        metadata,
        proxyTransactions.length,
      );
      const body = JSON.stringify(request);
      const headerState = await this._buildRelayerSubmitHeaders(
        "/submit",
        body,
      );
      if (!headerState?.ok) {
        return {
          success: false,
          error: headerState?.error || "Failed to build relayer auth headers",
          authMode: headerState?.authMode || null,
          requiresManual: true,
        };
      }

      console.log(
        ` Executing proxy relayer submit (${proxyTransactions.length} tx, auth=${headerState.authMode})`,
      );
      const submit = await this._relayPost("/submit", body, {
        "Content-Type": "application/json",
        ...headerState.headers,
      });
      const transactionID = String(submit?.transactionID || "").trim();
      if (!transactionID) {
        return {
          success: false,
          error: "Relayer submit returned no transactionID",
          authMode: headerState.authMode,
        };
      }

      const result = await this._pollRelayerTransaction(
        transactionID,
        100,
        2000,
      );
      if (!result) {
        return {
          success: false,
          error: `Relayer transaction ${transactionID} did not confirm before timeout`,
          transactionID,
          authMode: headerState.authMode,
        };
      }
      if (
        ["STATE_FAILED", "STATE_INVALID"].includes(String(result.state || ""))
      ) {
        return {
          success: false,
          error: `Relayer transaction ${transactionID} ended in ${result.state}`,
          transactionID,
          authMode: headerState.authMode,
        };
      }

      return {
        success: true,
        txHash: result.transactionHash || submit?.transactionHash || null,
        transactionID,
        authMode: headerState.authMode,
        result,
      };
    } catch (e) {
      const formatted = this._formatAxiosError(e);
      const authFailure =
        [401, 403].includes(Number(formatted.status)) ||
        /invalid authorization|not allowed/i.test(
          String(formatted.message || ""),
        );
      return {
        success: false,
        error: `PROXY_REDEEM_RELAYER_ERROR (${formatted.message})`,
        authMode: this._getRelayerAuthMode(),
        status: formatted.status,
        requiresManual: authFailure,
      };
    }
  }

  async _redeemPositionViaProxyRelayer(conditionId, targetHolder) {
    try {
      const iface = new ethers.utils.Interface(CTF_ABI);
      const parentCollectionId = ethers.constants.HashZero;
      const indexSets = [1, 2];
      const calldata = iface.encodeFunctionData("redeemPositions", [
        REDEEM_COLLATERAL_ADDRESS,
        parentCollectionId,
        conditionId,
        indexSets,
      ]);
      const submitted = await this._submitProxyRelayTransactions(
        [{ to: CTF_ADDRESS, data: calldata, value: "0" }],
        `redeem positions ${conditionId}`,
      );
      if (submitted?.success) {
        return {
          success: true,
          txHash: submitted.txHash,
          transactionID: submitted.transactionID,
          authMode: submitted.authMode,
          address: targetHolder,
        };
      }
      return {
        success: false,
        error: submitted?.error || "Proxy relayer redeem failed",
        authMode: submitted?.authMode || null,
        address: targetHolder,
        requiresManual: !!submitted?.requiresManual,
        status: submitted?.status || null,
      };
    } catch (e) {
      return {
        success: false,
        error: e.message,
        address: targetHolder,
      };
    }
  }

  async _isContractDeployed(address) {
    if (!this._isAddress(address)) return false;
    const provider = this._getProvider();
    if (!provider?.getCode) return false;
    try {
      const code = await provider.getCode(address);
      return typeof code === "string" && code !== "0x";
    } catch {
      return false;
    }
  }

  async _deriveProxyWalletAddress(ttlMs = 300000) {
    if (!this.wallet || !ethers) {
      return {
        ok: false,
        address: null,
        source: "derived",
        reason: "Wallet not loaded",
      };
    }

    const now = Date.now();
    if (this._proxyResolutionCache && this._proxyResolutionExpiry > now) {
      return this._proxyResolutionCache;
    }

    try {
      const provider = this._getProvider();
      if (
        !provider ||
        !ethers.Contract ||
        !ethers.utils?.Interface ||
        !ethers.utils?.hexConcat
      ) {
        return {
          ok: false,
          address: null,
          source: "derived",
          reason: "Provider or ethers utils unavailable",
        };
      }

      const factory = new ethers.Contract(
        PROXY_FACTORY_ADDRESS,
        PROXY_FACTORY_ABI,
        provider,
      );
      const implementation = await factory.getImplementation();
      if (!this._isAddress(implementation)) {
        return {
          ok: false,
          address: null,
          source: "derived",
          reason: "Proxy factory returned invalid implementation",
        };
      }

      const iface = new ethers.utils.Interface([
        "function cloneConstructor(bytes)",
      ]);
      const constructorData = iface.encodeFunctionData("cloneConstructor", [
        "0x",
      ]);
      const salt = ethers.utils.keccak256(
        ethers.utils.solidityPack(["address"], [this.wallet.address]),
      );
      const initCode = ethers.utils.hexConcat([
        PROXY_CLONE_PREFIX_A,
        PROXY_FACTORY_ADDRESS,
        PROXY_CLONE_PREFIX_B,
        implementation,
        PROXY_CLONE_PREFIX_C,
        constructorData,
      ]);
      const initCodeHash = ethers.utils.keccak256(initCode);
      const address = ethers.utils.getCreate2Address(
        PROXY_FACTORY_ADDRESS,
        salt,
        initCodeHash,
      );
      const deployed = await this._isContractDeployed(address);
      const out = {
        ok: this._isAddress(address),
        address,
        deployed,
        implementation,
        source: "proxy_factory_create2",
        reason: null,
      };
      if (out.ok) {
        rememberProxyFunderAddress(address);
      }
      this._proxyResolutionCache = out;
      this._proxyResolutionExpiry = now + ttlMs;
      return out;
    } catch (e) {
      const out = {
        ok: false,
        address: null,
        source: "derived",
        reason: e.message,
      };
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
        source: "env",
        reason: null,
      };
    }

    return await this._deriveProxyWalletAddress(ttlMs);
  }

  async _probeTradeClients(opts = {}) {
    if (!ClobClient)
      return {
        ok: false,
        reason: "Missing @polymarket/clob-client",
        probes: [],
        preferredSigType: 0,
        closedOnly: null,
        closedOnlyErr: null,
        proxyResolution: null,
      };
    if (!this.wallet)
      return {
        ok: false,
        reason: "No wallet loaded",
        probes: [],
        preferredSigType: 0,
        closedOnly: null,
        closedOnlyErr: null,
        proxyResolution: null,
      };

    const ttlMs = opts.ttlMs || 60000;
    if (
      !CONFIG.POLYMARKET_API_KEY ||
      !CONFIG.POLYMARKET_SECRET ||
      !CONFIG.POLYMARKET_PASSPHRASE
    ) {
      const derived = await this.ensureCreds().catch(() => ({ ok: false }));
      if (!derived?.ok) {
        return {
          ok: false,
          reason: "Missing API creds and auto-derive failed",
          probes: [],
          preferredSigType: 0,
          closedOnly: null,
          closedOnlyErr: null,
          proxyResolution: null,
        };
      }
    }

    const host = "https://clob.polymarket.com";
    const creds = this._buildCreds();
    const signerAddress = this.wallet.address || undefined;
    const proxyResolution = await this._resolveProxyFunderAddress(
      Math.max(ttlMs, 60000),
    );
    const preferredSigType =
      normalizeSignatureType(CONFIG.POLYMARKET_SIGNATURE_TYPE) ??
      (proxyResolution?.ok ? 1 : 0);
    const configuredFunderAddress = getConfiguredFunderAddress();
    // For sigType=1: use configured address, then derived proxy, then signer as last resort
    const primarySigType1Funder =
      configuredFunderAddress ||
      (proxyResolution?.ok && this._isAddress(proxyResolution.address)
        ? proxyResolution.address
        : null) ||
      signerAddress;

    const candidates = [
      {
        signatureType: 0,
        funderAddress: signerAddress,
        source: "eoa",
        client: new ClobClient(
          host,
          POLY_CHAIN_ID,
          this.wallet,
          creds,
          0,
          signerAddress,
        ),
      },
    ];

    if (this._isAddress(primarySigType1Funder)) {
      const primarySource = configuredFunderAddress
        ? "env"
        : proxyResolution?.ok &&
            primarySigType1Funder === proxyResolution.address
          ? "proxy_derived"
          : "wallet";
      if (primarySigType1Funder !== signerAddress || configuredFunderAddress) {
        rememberProxyFunderAddress(primarySigType1Funder);
      }
      candidates.push({
        signatureType: 1,
        funderAddress: primarySigType1Funder,
        source: primarySource,
        deployed:
          primarySigType1Funder !== signerAddress
            ? await this._isContractDeployed(primarySigType1Funder)
            : null,
        client: new ClobClient(
          host,
          POLY_CHAIN_ID,
          this.wallet,
          creds,
          1,
          primarySigType1Funder,
        ),
      });
    }

    if (
      proxyResolution?.ok &&
      this._isAddress(proxyResolution.address) &&
      proxyResolution.address !== primarySigType1Funder
    ) {
      rememberProxyFunderAddress(proxyResolution.address);
      candidates.push({
        signatureType: 1,
        funderAddress: proxyResolution.address,
        source: proxyResolution.source,
        deployed: proxyResolution.deployed,
        client: new ClobClient(
          host,
          POLY_CHAIN_ID,
          this.wallet,
          creds,
          1,
          proxyResolution.address,
        ),
      });
    }

    // Always derive the proxy wallet from the private key, even when POLYMARKET_ADDRESS is set.
    // If the configured address doesn't match the derived address, add the derived as extra candidate.
    if (getConfiguredFunderAddress()) {
      try {
        const derivedCheck = await this._deriveProxyWalletAddress(
          Math.max(ttlMs, 60000),
        );
        if (derivedCheck?.ok && this._isAddress(derivedCheck.address)) {
          const alreadyCandidate = candidates.some(
            (c) =>
              c.funderAddress?.toLowerCase() ===
              derivedCheck.address.toLowerCase(),
          );
          if (!alreadyCandidate) {
            console.log(
              `⚠️ Auto-derived proxy ${derivedCheck.address} differs from configured POLYMARKET_ADDRESS ${getConfiguredFunderAddress()} — adding as extra candidate`,
            );
            rememberProxyFunderAddress(derivedCheck.address);
            candidates.push({
              signatureType: 1,
              funderAddress: derivedCheck.address,
              source: "auto_derived",
              deployed: derivedCheck.deployed,
              client: new ClobClient(
                host,
                POLY_CHAIN_ID,
                this.wallet,
                creds,
                1,
                derivedCheck.address,
              ),
            });
          }
        }
      } catch (e) {
        console.log(` Proxy auto-derive check failed: ${e.message}`);
      }
    }

    const toBigIntOrNull = (raw) => {
      const value = String(raw ?? "").trim();
      if (!value || !/^\d+$/.test(value)) return null;
      try {
        return BigInt(value);
      } catch {
        return null;
      }
    };

    const computeMaxAllowance = (allowances, allowanceRaw) => {
      if (!allowances || typeof allowances !== "object") {
        return {
          maxRaw: allowanceRaw != null ? String(allowanceRaw) : null,
          spender: null,
          max: toBigIntOrNull(allowanceRaw) || 0n,
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
        status: null,
      };

      const updated = await withClobAuthContext(
        candidate.signatureType,
        candidate.funderAddress,
        () =>
          candidate.client
            .updateBalanceAllowance({ asset_type: "COLLATERAL" })
            .catch((e) => ({ error: e?.message || String(e) })),
      );
      if (
        updated &&
        typeof updated === "object" &&
        Object.prototype.hasOwnProperty.call(updated, "error")
      ) {
        out.refreshed = false;
        out.refreshError = String(updated.error);
      } else {
        out.refreshed = true;
      }

      const balanceAllowance = await withClobAuthContext(
        candidate.signatureType,
        candidate.funderAddress,
        () =>
          candidate.client
            .getBalanceAllowance({ asset_type: "COLLATERAL" })
            .catch((e) => ({ error: e?.message || String(e) })),
      );
      if (
        balanceAllowance &&
        typeof balanceAllowance === "object" &&
        Object.prototype.hasOwnProperty.call(balanceAllowance, "error")
      ) {
        out.error = String(balanceAllowance.error);
        out.status = balanceAllowance?.status || null;
        return out;
      }

      out.balanceRaw = String(balanceAllowance?.balance ?? "").trim() || null;
      const { maxRaw, spender, max } = computeMaxAllowance(
        balanceAllowance?.allowances,
        balanceAllowance?.allowance,
      );
      out.allowanceMaxRaw = maxRaw;
      out.allowanceMaxSpender = spender;
      const balance = toBigIntOrNull(out.balanceRaw) || 0n;
      out.ok = balance > 0n && max > 0n;
      return out;
    };

    const closedOnlyResponse = await withClobAuthContext(0, signerAddress, () =>
      candidates[0].client
        .getClosedOnlyMode()
        .catch((e) => ({ error: e?.message || String(e) })),
    );
    const closedOnly =
      closedOnlyResponse &&
      typeof closedOnlyResponse === "object" &&
      Object.prototype.hasOwnProperty.call(closedOnlyResponse, "error")
        ? null
        : !!closedOnlyResponse?.closed_only;
    const closedOnlyErr =
      closedOnlyResponse &&
      typeof closedOnlyResponse === "object" &&
      Object.prototype.hasOwnProperty.call(closedOnlyResponse, "error")
        ? String(closedOnlyResponse.error)
        : null;

    const probes = [];
    for (const candidate of candidates) {
      probes.push(await probe(candidate));
    }

    // If a sigType=1 probe fails, only allow an on-chain fallback for that exact funder
    // address. Never copy balances from the EOA or a different proxy into another probe.
    const failedProxyProbes = probes.filter(
      (p) => p.signatureType === 1 && (p.status === 401 || !p.ok),
    );
    for (const failedProbe of failedProxyProbes) {
      const proxyAddr = failedProbe.funderAddress;
      if (!this._isAddress(proxyAddr)) {
        console.log(
          ` Proxy probe ${failedProbe.funderAddress?.slice(0, 10)} ${failedProbe.status || "failed"} — invalid funder address`,
        );
        continue;
      }

      let verifiedProxyBalance = 0;
      try {
        const onChainProxy = await this.getOnChainUsdcBalance(proxyAddr);
        if (onChainProxy?.success) {
          verifiedProxyBalance = Math.max(0, Number(onChainProxy.balance) || 0);
        }
      } catch {}
      try {
        const onChainProxyPusd = await this.getOnChainPusdBalance(proxyAddr);
        if (onChainProxyPusd?.success) {
          verifiedProxyBalance = Math.max(
            verifiedProxyBalance,
            Number(onChainProxyPusd.balance) || 0,
          );
        }
      } catch {}

      if (verifiedProxyBalance <= 0) {
        console.log(
          ` Proxy probe ${proxyAddr.slice(0, 10)} ${failedProbe.status || "failed"} — no verified collateral balance at that address`,
        );
        continue;
      }

      const balRaw = String(Math.round(verifiedProxyBalance * 1e6));
      console.log(
        ` Proxy probe ${proxyAddr.slice(0, 10)} ${failedProbe.status || "failed"} — forcing trade-ready with same-address on-chain fallback $${verifiedProxyBalance.toFixed(2)}`,
      );
      failedProbe.balanceRaw = balRaw;
      failedProbe.allowanceMaxRaw =
        "115792089237316195423570985008687907853269984665640564039457584007913129639935";
      failedProbe.ok = true;
      failedProbe.refreshed = true;
      failedProbe.refreshError = null;
      failedProbe.error = null;
      failedProbe.status = null;
    }

    return {
      ok: true,
      reason: null,
      probes,
      preferredSigType,
      closedOnly,
      closedOnlyErr,
      proxyResolution,
    };
  }

  _selectTradeProbe(probes, preferredSigType, closedOnly) {
    if (!Array.isArray(probes) || probes.length === 0) return null;
    const preferred =
      probes.find((probe) => probe.signatureType === preferredSigType) || null;
    const ready = probes.filter((probe) => !closedOnly && !!probe.ok);

    if (preferred && !closedOnly && preferred.ok) return preferred;
    if (ready.length > 0) {
      return (
        ready.find((probe) => probe.signatureType !== preferredSigType) ||
        ready[0]
      );
    }
    return preferred || probes[0];
  }

  _buildAttemptOrder(probes, preferredSigType, closedOnly) {
    if (!Array.isArray(probes) || probes.length === 0 || closedOnly) return [];
    const ready = probes.filter((probe) => !!probe.ok);
    const preferredReady = ready.find(
      (probe) => probe.signatureType === preferredSigType,
    );
    const ordered = [];
    if (preferredReady) ordered.push(preferredReady);
    for (const probe of ready) {
      if (!ordered.includes(probe)) ordered.push(probe);
    }
    return ordered;
  }

  _isRetryableAuthError(message) {
    const raw = String(message || "").toLowerCase();
    if (
      raw.includes("trading restricted") ||
      raw.includes("geoblock") ||
      raw.includes("restricted in your region")
    ) {
      return false;
    }
    return (
      raw.includes("invalid signature") ||
      raw.includes("invalid funder") ||
      (raw.includes("funder") && raw.includes("address")) ||
      raw.includes("l2 auth") ||
      raw.includes("unauthorized") ||
      raw.includes("authentication")
    );
  }

  _getDefaultV2OrderOptions() {
    return {
      tickSize: "0.01",
      negRisk: false,
    };
  }

  async _placeOrderWithCandidate(candidate, tokenId, price, shares, side, opts = {}) {
    try {
      const result = await withClobAuthContext(
        candidate.signatureType,
        candidate.funderAddress,
        async () => {
          const orderArgs = {
            tokenID: tokenId,
            price: price,
            size: shares,
            side: side,
          };
          const orderOptions = opts.orderOptions || this._getDefaultV2OrderOptions();
          const configuredOrderType = String(CONFIG.CLOB_ORDER_TYPE || "FAK").toUpperCase();
          const orderType = opts.orderType || OrderType[configuredOrderType] || configuredOrderType || OrderType.FAK || "FAK";
          const routeBefore = getClobRoutingDiagnostics();

          let response = null;
          if (typeof candidate.client.createAndPostOrder === "function") {
            response = await candidate.client.createAndPostOrder(
              orderArgs,
              orderOptions,
              orderType,
            );
          } else {
            const order = await candidate.client.createOrder(orderArgs, orderOptions);
            response = await candidate.client.postOrder(order, orderType);
          }
          const routeAfter = getClobRoutingDiagnostics();

          if (response && response.orderID) {
            console.log(
              `✅ CLOB ORDER PLACED: ${response.orderID} | sigType=${candidate.signatureType} | ${side} ${shares} @ ${(price * 100).toFixed(1)}¢`,
            );

            let fillStatus = "UNVERIFIED";
            let matchedShares = 0;
            for (let attempt = 1; attempt <= 3; attempt++) {
              await new Promise((r) => setTimeout(r, 2000));
              try {
                const orderStatus = await candidate.client.getOrder(
                  response.orderID,
                );
                if (orderStatus) {
                  fillStatus = String(orderStatus.status || "UNKNOWN");
                  matchedShares = Number(orderStatus.size_matched || 0);

                  if (matchedShares > 0) {
                    console.log(
                      `✅ Order MATCHED: ${matchedShares.toFixed(4)} shares`,
                    );
                    break;
                  } else if (
                    ["CANCELLED", "EXPIRED", "REJECTED"].includes(
                      fillStatus.toUpperCase(),
                    )
                  ) {
                    return {
                      success: false,
                      error: `Order ${fillStatus}`,
                      orderID: response.orderID,
                      signatureType: candidate.signatureType,
                    };
                  }
                }
              } catch {}
            }

            const safeMatchedShares = Number.isFinite(matchedShares)
              ? matchedShares
              : 0;
            const eps = 1e-6;
            const partialFill =
              safeMatchedShares > eps && safeMatchedShares + eps < shares;
            const remainingShares = Math.max(0, shares - safeMatchedShares);
            let cancelAttempted = false;
            let cancelSucceeded = false;

            if (remainingShares > eps) {
              cancelAttempted = true;
              try {
                await candidate.client.cancelOrder({
                  orderID: response.orderID,
                });
                cancelSucceeded = true;
              } catch {}
            }

            return {
              success: safeMatchedShares > eps,
              acceptedOrder: true,
              orderID: response.orderID,
              fillStatus,
              matchedShares: safeMatchedShares,
              matchedSize: safeMatchedShares * price,
              requestedShares: shares,
              remainingShares,
              partialFill,
              cancelAttempted,
              cancelSucceeded,
              signatureType: candidate.signatureType,
              funderAddress: candidate.funderAddress,
              orderType,
              orderOptions,
              clobRoute: routeAfter,
              error: safeMatchedShares <= eps ? "NO_FILL_AFTER_RETRIES" : null,
            };
          }

          const failure = buildClobFailureDiagnostic(response);
          const summary = formatClobFailureDiagnostic(failure);
          return {
            success: false,
            error: `No orderID in response: ${JSON.stringify(response)}${summary ? ` | ${summary}` : ""}`,
            clobFailure: failure,
            clobFailureSummary: summary || null,
            signatureType: candidate.signatureType,
            funderAddress: candidate.funderAddress,
            clobRoute: routeAfter,
            clobRouteBefore: routeBefore,
          };
        },
      );

      return result;
    } catch (e) {
      const failure = buildClobFailureDiagnostic(e);
      const summary = formatClobFailureDiagnostic(failure);
      return {
        success: false,
        error: `Order failed: ${e.message}${summary ? ` | ${summary}` : ""}`,
        clobFailure: failure,
        clobFailureSummary: summary || null,
        signatureType: candidate.signatureType,
        funderAddress: candidate.funderAddress,
        clobRoute: getClobRoutingDiagnostics(),
      };
    }
  }

  async getTradeReadyClient(opts = {}) {
    if (!ClobClient)
      return {
        ok: false,
        reason: "Missing @polymarket/clob-client",
        client: null,
      };
    if (!this.wallet)
      return { ok: false, reason: "No wallet loaded", client: null };

    const now = Date.now();
    const ttlMs = opts.ttlMs || 60000;
    const force = !!opts.force;

    if (!force && this._tradeReadyCache && this._tradeReadyCacheExpiry > now) {
      return this._tradeReadyCache;
    }

    try {
      const probeState = await this._probeTradeClients({ ttlMs });
      if (!probeState.ok) {
        const out = {
          ok: false,
          reason: probeState.reason || "CLOB not ready",
          client: null,
        };
        this._tradeReadyCache = out;
        this._tradeReadyCacheExpiry = now + ttlMs;
        return out;
      }

      const closedBlocks = probeState.closedOnly === true;
      const probeResult = this._selectTradeProbe(
        probeState.probes,
        probeState.preferredSigType,
        closedBlocks,
      );
      const client = probeResult?.client || null;
      const sigType = probeResult?.signatureType ?? probeState.preferredSigType;

      const selectedBalance =
        probeResult?.balanceRaw != null
          ? parseFloat(String(probeResult.balanceRaw)) / 1e6
          : null;
      const ok = !closedBlocks && !!probeResult?.ok;
      const selKey = `${sigType}:${String(probeResult?.funderAddress || "")}:${closedBlocks ? "CLOSED" : ok ? "READY" : "NOT_READY"}`;
      if (selKey !== this._lastSelectionKey) {
        this._lastSelectionKey = selKey;
        console.log(
          `🔐 CLOB: sigType=${sigType} ${closedBlocks ? "CLOSED_ONLY" : ok ? "READY" : "NOT_READY"} balance=${Number.isFinite(selectedBalance) ? selectedBalance : "n/a"}`,
        );
      }

      const out = {
        ok,
        client,
        sigType,
        balance: Number.isFinite(selectedBalance) ? selectedBalance : null,
        reason: closedBlocks
          ? "Account is in closed-only mode"
          : ok
            ? null
            : probeResult?.error ||
              probeResult?.refreshError ||
              `Not trade-ready (sigType=${sigType})`,
        summary: closedBlocks
          ? "closedOnly=true"
          : ok
            ? `OK sigType=${sigType}`
            : `NOT_READY sigType=${sigType}`,
        closedOnly: probeState.closedOnly,
        closedOnlyErr: probeState.closedOnlyErr,
        proxyResolution: probeState.proxyResolution,
        selected: probeResult
          ? {
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
              ok: !!probeResult.ok,
            }
          : null,
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
          ok: !!candidate.ok,
        })),
      };

      this._tradeReadyCache = out;
      this._tradeReadyCacheExpiry = now + ttlMs;
      return out;
    } catch (e) {
      return { ok: false, reason: `CLOB error: ${e.message}`, client: null };
    }
  }

  _isGeoblockError(message) {
    const raw = String(message || "").toLowerCase();
    return (
      raw.includes("trading restricted") ||
      raw.includes("geoblock") ||
      raw.includes('status\":403')
    );
  }

  async placeOrder(tokenId, price, shares, side = "BUY") {
    const endpointPreflight = await this.checkClobOrderEndpointPreflight({ ttlMs: 60000 });
    if (!endpointPreflight.ok) {
      return {
        success: false,
        error: endpointPreflight.reason || "CLOB order endpoint preflight failed",
        blocked: true,
        nonRetryable: !!endpointPreflight.blocked,
        clobFailure: endpointPreflight.clobFailure || null,
        clobFailureSummary: endpointPreflight.clobFailureSummary || null,
      };
    }

    const probeState = await this._probeTradeClients({ ttlMs: 10000 });
    if (!probeState.ok) {
      return { success: false, error: probeState.reason || "CLOB not ready" };
    }

    const attemptOrder = this._buildAttemptOrder(
      probeState.probes,
      probeState.preferredSigType,
      probeState.closedOnly,
    );
    if (attemptOrder.length === 0) {
      const selected = this._selectTradeProbe(
        probeState.probes,
        probeState.preferredSigType,
        probeState.closedOnly,
      );
      return {
        success: false,
        error: probeState.closedOnly
          ? "Account is in closed-only mode"
          : selected?.error || selected?.refreshError || "CLOB not ready",
      };
    }

    const maxGeoblockRetries = 0;
    const errors = [];
    for (let index = 0; index < attemptOrder.length; index++) {
      const candidate = attemptOrder[index];

      // Retry geoblock errors with delay (proxy IP rotation)
      let result = null;
      for (let geoRetry = 0; geoRetry <= maxGeoblockRetries; geoRetry++) {
        if (geoRetry > 0) {
          console.log(
            `  Geoblock retry ${geoRetry}/${maxGeoblockRetries} after 3s...`,
          );
          await new Promise((r) => setTimeout(r, 3000));
        }
        result = await this._placeOrderWithCandidate(
          candidate,
          tokenId,
          price,
          shares,
          side,
        );
        if (result?.success || !this._isGeoblockError(result?.error)) break;
      }

      if (result?.success) return result;

      if (this._isGeoblockError(result?.error)) {
        return Object.assign({}, result || { success: false }, {
          error: `NON_RETRYABLE_CLOB_GEOBLOCK: ${result?.error || "Order endpoint geoblocked"}`,
          blocked: true,
          nonRetryable: true,
        });
      }

      errors.push(
        `sigType=${candidate.signatureType}${candidate.funderAddress ? ` funder=${candidate.funderAddress}` : ""}: ${result?.error || "Unknown order error"}`,
      );
      if (
        !this._isRetryableAuthError(result?.error) ||
        index === attemptOrder.length - 1
      ) {
        return Object.assign(
          {},
          result || { success: false, error: "Order failed" },
          {
            error: errors.join(" | "),
          },
        );
      }
    }

    return { success: false, error: errors.join(" | ") || "Order failed" };
  }

  async getOrder(orderID) {
    const sel = await this.getTradeReadyClient({ ttlMs: 10000 });
    if (!sel?.client) {
      return { success: false, error: sel?.reason || "CLOB not ready" };
    }

    try {
      const order = await withClobAuthContext(
        sel.sigType,
        sel?.selected?.funderAddress || this.wallet?.address,
        () => sel.client.getOrder(orderID),
      );
      return { success: true, order };
    } catch (e) {
      return { success: false, error: e.message };
    }
  }

  async cancelOrder(orderID) {
    const sel = await this.getTradeReadyClient({ ttlMs: 10000 });
    if (!sel?.client) {
      return { success: false, error: sel?.reason || "CLOB not ready" };
    }

    try {
      const result = await withClobAuthContext(
        sel.sigType,
        sel?.selected?.funderAddress || this.wallet?.address,
        () => sel.client.cancelOrder({ orderID }),
      );
      return { success: true, result };
    } catch (e) {
      return { success: false, error: e.message };
    }
  }

  async getOnChainUsdcBalance(addressOverride = null) {
    if (!this.wallet || !ethers) {
      return {
        success: false,
        error: "No wallet loaded",
        balance: 0,
        source: "ON_CHAIN_USDC",
      };
    }

    const targetAddress = addressOverride || this.wallet.address;
    let errors = [];

    if (!axios || !ethers?.utils?.Interface) {
      try {
        const provider = this._getProvider();
        const contract = new ethers.Contract(USDC_ADDRESS, USDC_ABI, provider);
        const rawBalance = await contract.balanceOf(targetAddress);
        const balance = parseFloat(
          ethers.utils.formatUnits(rawBalance, USDC_DECIMALS),
        );
        return {
          success: true,
          balance: Number.isFinite(balance) ? balance : 0,
          balanceRaw: rawBalance.toString(),
          address: targetAddress,
          source: "ON_CHAIN_USDC",
        };
      } catch (e) {
        return {
          success: false,
          error: e.message,
          balance: 0,
          source: "ON_CHAIN_USDC",
        };
      }
    }

    try {
      const iface = new ethers.utils.Interface(USDC_ABI);
      const data = iface.encodeFunctionData("balanceOf", [targetAddress]);
      const timeoutMs = getPolygonRpcTimeoutMs();
      const rpcEndpoints = getPolygonRpcEndpoints();
      errors = [];

      const racePromises = rpcEndpoints.map(async (rpc) => {
        try {
          const response = await axios.post(
            rpc,
            {
              jsonrpc: "2.0",
              id: 1,
              method: "eth_call",
              params: [{ to: USDC_ADDRESS, data }, "latest"],
            },
            {
              timeout: timeoutMs,
              httpsAgent: https.globalAgent,
              proxy: false,
              headers: { "Content-Type": "application/json" },
            },
          );

          const resultHex = response?.data?.result;
          if (!resultHex || typeof resultHex !== "string") {
            throw new Error("Invalid JSON-RPC response (no result)");
          }

          const rawBalance = ethers.BigNumber.from(resultHex);
          const balance = parseFloat(
            ethers.utils.formatUnits(rawBalance, USDC_DECIMALS),
          );
          return { rpc, rawBalance: rawBalance.toString(), balance };
        } catch (e) {
          errors.push({
            rpc,
            error: e?.message ? String(e.message) : String(e),
          });
          throw e;
        }
      });

      const result = await Promise.any(racePromises);
      return {
        success: true,
        balance: Number.isFinite(result.balance) ? result.balance : 0,
        balanceRaw: result.rawBalance,
        address: targetAddress,
        rpcUsed: result.rpc,
        source: "ON_CHAIN_USDC",
      };
    } catch (e) {
      const message =
        Array.isArray(e?.errors) && e.errors.length > 0
          ? String(e.errors[0]?.message || e.message || "Unknown RPC error")
          : String(e?.message || e);
      const detail =
        errors.length > 0
          ? `${message} | ${errors
              .map((item) => `${item.rpc}: ${item.error}`)
              .slice(0, 4)
              .join(" ; ")}`
          : message;
      return {
        success: false,
        error: detail,
        balance: 0,
        source: "ON_CHAIN_USDC",
      };
    }
  }

  async getOnChainPusdBalance(addressOverride = null) {
    if (!this.wallet || !ethers) {
      return {
        success: false,
        error: "No wallet loaded",
        balance: 0,
        source: "ON_CHAIN_PUSD",
      };
    }

    const targetAddress = addressOverride || this.wallet.address;
    let errors = [];

    if (!axios || !ethers?.utils?.Interface) {
      try {
        const provider = this._getProvider();
        const contract = new ethers.Contract(PUSD_ADDRESS, PUSD_ABI, provider);
        const rawBalance = await contract.balanceOf(targetAddress);
        const balance = parseFloat(
          ethers.utils.formatUnits(rawBalance, USDC_DECIMALS),
        );
        return {
          success: true,
          balance: Number.isFinite(balance) ? balance : 0,
          balanceRaw: rawBalance.toString(),
          address: targetAddress,
          source: "ON_CHAIN_PUSD",
        };
      } catch (e) {
        return {
          success: false,
          error: e.message,
          balance: 0,
          source: "ON_CHAIN_PUSD",
        };
      }
    }

    try {
      const iface = new ethers.utils.Interface(PUSD_ABI);
      const data = iface.encodeFunctionData("balanceOf", [targetAddress]);
      const timeoutMs = getPolygonRpcTimeoutMs();
      const rpcEndpoints = getPolygonRpcEndpoints();
      errors = [];

      const racePromises = rpcEndpoints.map(async (rpc) => {
        try {
          const response = await axios.post(
            rpc,
            {
              jsonrpc: "2.0",
              id: 1,
              method: "eth_call",
              params: [{ to: PUSD_ADDRESS, data }, "latest"],
            },
            {
              timeout: timeoutMs,
              httpsAgent: https.globalAgent,
              proxy: false,
              headers: { "Content-Type": "application/json" },
            },
          );

          const resultHex = response?.data?.result;
          if (!resultHex || typeof resultHex !== "string") {
            throw new Error("Invalid JSON-RPC response (no result)");
          }

          const rawBalance = ethers.BigNumber.from(resultHex);
          const balance = parseFloat(
            ethers.utils.formatUnits(rawBalance, USDC_DECIMALS),
          );
          return { rpc, rawBalance: rawBalance.toString(), balance };
        } catch (e) {
          errors.push({
            rpc,
            error: e?.message ? String(e.message) : String(e),
          });
          throw e;
        }
      });

      const result = await Promise.any(racePromises);
      return {
        success: true,
        balance: Number.isFinite(result.balance) ? result.balance : 0,
        balanceRaw: result.rawBalance,
        address: targetAddress,
        rpcUsed: result.rpc,
        source: "ON_CHAIN_PUSD",
      };
    } catch (e) {
      const message =
        Array.isArray(e?.errors) && e.errors.length > 0
          ? String(e.errors[0]?.message || e.message || "Unknown RPC error")
          : String(e?.message || e);
      const detail =
        errors.length > 0
          ? `${message} | ${errors
              .map((item) => `${item.rpc}: ${item.error}`)
              .slice(0, 4)
              .join(" ; ")}`
          : message;
      return {
        success: false,
        error: detail,
        balance: 0,
        source: "ON_CHAIN_PUSD",
      };
    }
  }

  async getClobCollateralBalance(force = false) {
    if (!this.wallet) {
      return {
        success: false,
        error: "No wallet loaded",
        balance: 0,
        source: "CLOB_COLLATERAL",
      };
    }

    try {
      const cachedTradeReady = this.getStatus()?.tradeReady || null;
      const cachedRawBalance = cachedTradeReady?.selected?.balanceRaw;
      const cachedBalance =
        cachedRawBalance != null
          ? parseFloat(String(cachedRawBalance)) / 1e6
          : null;
      if (
        !force &&
        cachedTradeReady?.ok &&
        Number.isFinite(cachedBalance) &&
        cachedBalance > 0
      ) {
        return {
          success: true,
          balance: cachedBalance,
          balanceRaw: String(cachedRawBalance),
          address: this.wallet.address,
          source: "CLOB_COLLATERAL",
        };
      }

      const sel = await this.getTradeReadyClient({ force, ttlMs: 30000 });
      const selectedRawBalance = sel?.selected?.balanceRaw;
      const selectedBalance =
        selectedRawBalance != null
          ? parseFloat(String(selectedRawBalance)) / 1e6
          : null;
      const authFunderAddress =
        sel?.selected?.funderAddress || this.wallet.address;
      if (!sel?.client) {
        const balanceFromSelection = Number.isFinite(selectedBalance)
          ? selectedBalance
          : null;
        return {
          success: Number.isFinite(balanceFromSelection),
          error: sel?.summary || sel?.reason || "CLOB client unavailable",
          balance: Number.isFinite(balanceFromSelection)
            ? balanceFromSelection
            : 0,
          balanceRaw: Number.isFinite(balanceFromSelection)
            ? String(selectedRawBalance)
            : "0",
          address: this.wallet.address,
          source: "CLOB_COLLATERAL",
        };
      }

      await withClobAuthContext(sel.sigType, authFunderAddress, () =>
        sel.client
          .updateBalanceAllowance({ asset_type: "COLLATERAL" })
          .catch(() => {}),
      );
      const ba = await withClobAuthContext(sel.sigType, authFunderAddress, () =>
        sel.client
          .getBalanceAllowance({ asset_type: "COLLATERAL" })
          .catch((e) => ({ error: e.message || String(e) })),
      );
      const baError =
        ba &&
        typeof ba === "object" &&
        Object.prototype.hasOwnProperty.call(ba, "error")
          ? String(ba.error)
          : null;
      const rawBalance = baError ? null : ba?.balance;
      const balance =
        rawBalance != null
          ? parseFloat(rawBalance) / 1e6
          : Number.isFinite(selectedBalance)
            ? selectedBalance
            : 0;
      if (rawBalance == null && !Number.isFinite(selectedBalance)) {
        return {
          success: false,
          error: baError || "CLOB collateral unavailable",
          balance: 0,
          address: this.wallet.address,
          source: "CLOB_COLLATERAL",
        };
      }

      return {
        success: Number.isFinite(balance),
        balance: Number.isFinite(balance) ? balance : 0,
        balanceRaw:
          rawBalance != null
            ? String(rawBalance)
            : String(selectedRawBalance || "0"),
        address: this.wallet.address,
        source: "CLOB_COLLATERAL",
      };
    } catch (e) {
      return {
        success: false,
        error: e.message,
        balance: 0,
        address: this.wallet.address,
        source: "CLOB_COLLATERAL",
      };
    }
  }

  getSelectedFunderAddress() {
    const candidate =
      this._tradeReadyCache?.selected?.funderAddress ||
      getKnownProxyFunderAddress() ||
      this.wallet?.address ||
      null;
    return this._isAddress(candidate)
      ? ethers.utils.getAddress(candidate)
      : null;
  }

  getKnownHolderAddresses(preferredAddress = null) {
    const addresses = [];
    const push = (address) => {
      if (!this._isAddress(address)) return;
      const normalized = ethers.utils.getAddress(address);
      if (!addresses.includes(normalized)) addresses.push(normalized);
    };

    push(preferredAddress);
    push(this._tradeReadyCache?.selected?.funderAddress);
    push(getConfiguredFunderAddress());
    push(getKnownProxyFunderAddress());
    push(this.wallet?.address);

    return addresses;
  }

  async getDataApiPositions(params = {}) {
    const baseUrl = String(CONFIG.DATA_API || "https://data-api.polymarket.com")
      .trim()
      .replace(/\/+$/, "");
    const user = params?.user || null;
    if (!this._isAddress(user)) {
      return { success: false, error: "Invalid user address", positions: [] };
    }
    if (!axios) {
      return { success: false, error: "axios unavailable", positions: [] };
    }

    const limitRaw = Number(params?.limit);
    const limit = Number.isFinite(limitRaw)
      ? Math.max(1, Math.min(200, Math.floor(limitRaw)))
      : 100;
    const sizeThresholdRaw = Number(params?.sizeThreshold);
    const sizeThreshold = Number.isFinite(sizeThresholdRaw)
      ? Math.max(0, sizeThresholdRaw)
      : undefined;
    const redeemable = params?.redeemable === true;

    try {
      const response = await axios.get(`${baseUrl}/positions`, {
        timeout: 15000,
        httpsAgent: https.globalAgent,
        proxy: false,
        params: {
          user,
          limit,
          ...(sizeThreshold != null ? { sizeThreshold } : {}),
          ...(redeemable ? { redeemable: true } : {}),
        },
      });
      const positions = Array.isArray(response?.data) ? response.data : [];
      return { success: true, positions };
    } catch (e) {
      return { success: false, error: e.message, positions: [] };
    }
  }

  async getRedeemablePositionsAcrossKnownHolders(opts = {}) {
    const limitRaw = Number(opts?.limit);
    const limit = Number.isFinite(limitRaw)
      ? Math.max(1, Math.min(200, Math.floor(limitRaw)))
      : 200;
    const sizeThresholdRaw = Number(opts?.sizeThreshold);
    const sizeThreshold = Number.isFinite(sizeThresholdRaw)
      ? Math.max(0, sizeThresholdRaw)
      : 0;
    const preferredAddress = opts?.preferredAddress || null;
    const addresses = this.getKnownHolderAddresses(preferredAddress);
    const map = new Map();
    const errors = [];
    let succeeded = 0;

    for (const address of addresses) {
      const result = await this.getDataApiPositions({
        user: address,
        redeemable: true,
        limit,
        sizeThreshold,
      }).catch((e) => ({ success: false, error: e.message, positions: [] }));
      if (!result?.success) {
        errors.push({ address, error: result?.error || "DATA_API_ERROR" });
        continue;
      }
      succeeded++;
      for (const pos of result.positions || []) {
        const conditionId = pos?.conditionId || null;
        const tokenId = pos?.asset || null;
        const outcomeIndex = Number.isFinite(Number(pos?.outcomeIndex))
          ? Number(pos.outcomeIndex)
          : null;
        const proxyWallet = pos?.proxyWallet || address;
        const key = `${String(conditionId)}:${String(tokenId)}:${String(outcomeIndex)}:${String(proxyWallet)}`;
        if (!map.has(key)) map.set(key, pos);
      }
    }

    return {
      success: succeeded > 0,
      attempted: addresses.length,
      succeeded,
      positions: Array.from(map.values()),
      errors,
    };
  }

  async getTokenBalance(tokenId, addressOverride = null) {
    if (!this.wallet || !ethers) {
      return { success: false, error: "No wallet loaded", balance: 0 };
    }

    const targetAddress =
      addressOverride && this._isAddress(addressOverride)
        ? ethers.utils.getAddress(addressOverride)
        : this.wallet.address;
    let errors = [];

    if (!axios || !ethers?.utils?.Interface) {
      try {
        const provider = this._getProvider();
        const contract = new ethers.Contract(CTF_ADDRESS, CTF_ABI, provider);
        const rawBalance = await contract.balanceOf(targetAddress, tokenId);
        const balance = parseFloat(ethers.utils.formatUnits(rawBalance, 0));
        return {
          success: true,
          balance: Number.isFinite(balance) ? balance : 0,
          balanceRaw: rawBalance.toString(),
          tokenId,
          address: targetAddress,
          source: "CTF_BALANCE",
        };
      } catch (e) {
        return {
          success: false,
          error: e.message,
          balance: 0,
          tokenId,
          address: targetAddress,
          source: "CTF_BALANCE",
        };
      }
    }

    try {
      const iface = new ethers.utils.Interface(CTF_ABI);
      const data = iface.encodeFunctionData("balanceOf", [
        targetAddress,
        tokenId,
      ]);
      const timeoutMs = getPolygonRpcTimeoutMs();
      const rpcEndpoints = getPolygonRpcEndpoints();
      errors = [];

      const racePromises = rpcEndpoints.map(async (rpc) => {
        try {
          const response = await axios.post(
            rpc,
            {
              jsonrpc: "2.0",
              id: 1,
              method: "eth_call",
              params: [{ to: CTF_ADDRESS, data }, "latest"],
            },
            {
              timeout: timeoutMs,
              httpsAgent: https.globalAgent,
              proxy: false,
              headers: { "Content-Type": "application/json" },
            },
          );

          const resultHex = response?.data?.result;
          if (!resultHex || typeof resultHex !== "string") {
            throw new Error("Invalid JSON-RPC response (no result)");
          }

          const rawBalance = ethers.BigNumber.from(resultHex);
          const balance = parseFloat(ethers.utils.formatUnits(rawBalance, 0));
          return { rpc, rawBalance: rawBalance.toString(), balance };
        } catch (e) {
          errors.push({
            rpc,
            error: e?.message ? String(e.message) : String(e),
          });
          throw e;
        }
      });

      const result = await Promise.any(racePromises);
      return {
        success: true,
        balance: Number.isFinite(result.balance) ? result.balance : 0,
        balanceRaw: result.rawBalance,
        tokenId,
        address: targetAddress,
        rpcUsed: result.rpc,
        source: "CTF_BALANCE",
      };
    } catch (e) {
      const message =
        Array.isArray(e?.errors) && e.errors.length > 0
          ? String(e.errors[0]?.message || e.message || "Unknown RPC error")
          : String(e?.message || e);
      const detail =
        errors.length > 0
          ? `${message} | ${errors
              .map((item) => `${item.rpc}: ${item.error}`)
              .slice(0, 4)
              .join(" ; ")}`
          : message;
      return {
        success: false,
        error: detail,
        balance: 0,
        tokenId,
        address: targetAddress,
        source: "CTF_BALANCE",
      };
    }
  }

  async getTokenBalanceAcrossHolders(tokenId, preferredAddress = null) {
    const addresses = this.getKnownHolderAddresses(preferredAddress);
    if (addresses.length === 0) {
      return {
        success: false,
        error: "No holder addresses available",
        balance: 0,
        tokenId,
        address: null,
        balances: [],
      };
    }

    const balances = [];
    let best = null;
    for (const address of addresses) {
      const result = await this.getTokenBalance(tokenId, address).catch(
        (e) => ({
          success: false,
          error: e.message,
          balance: 0,
          tokenId,
          address,
        }),
      );
      const entry = {
        success: !!result?.success,
        error: result?.error || null,
        balance: Number.isFinite(Number(result?.balance))
          ? Number(result.balance)
          : 0,
        balanceRaw: result?.balanceRaw || null,
        tokenId,
        address,
      };
      balances.push(entry);
      if (
        !best ||
        (entry.success && entry.balance > best.balance) ||
        (!best.success && entry.success)
      ) {
        best = entry;
      }
    }

    const normalizedPreferred = this._isAddress(preferredAddress)
      ? ethers.utils.getAddress(preferredAddress)
      : null;
    const preferredEntry = normalizedPreferred
      ? balances.find((entry) => entry.address === normalizedPreferred) || null
      : null;
    const zeroVerified = preferredEntry
      ? !!preferredEntry.success && preferredEntry.balance <= 0
      : balances.length > 0 &&
        balances.every((entry) => entry.success && entry.balance <= 0);
    if (best?.success) {
      return {
        success: true,
        balance: best.balance,
        balanceRaw: best.balanceRaw,
        tokenId,
        address: best.address,
        zeroVerified,
        balances,
      };
    }

    return {
      success: false,
      error:
        balances.find((entry) => !entry.success && entry.error)?.error ||
        "Token balance unavailable",
      balance: 0,
      tokenId,
      address: addresses[0] || null,
      zeroVerified,
      balances,
    };
  }

  async redeemPosition(conditionId, holderAddress = null) {
    if (!this.wallet || !ethers) {
      return { success: false, error: "No wallet loaded" };
    }

    try {
      const signerAddress = this._isAddress(this.wallet.address)
        ? ethers.utils.getAddress(this.wallet.address)
        : null;
      const targetHolder = this._isAddress(holderAddress)
        ? ethers.utils.getAddress(holderAddress)
        : this.getSelectedFunderAddress() || signerAddress;

      if (targetHolder && signerAddress && targetHolder !== signerAddress) {
        return await this._redeemPositionViaProxyRelayer(
          conditionId,
          targetHolder,
        );
      }

      const provider = this._getProvider();
      const wallet = this.wallet.connect(provider);
      const contract = new ethers.Contract(CTF_ADDRESS, CTF_ABI, wallet);
      const parentCollectionId = ethers.constants.HashZero;
      const indexSets = [1, 2];
      const gasEstimate = await contract.estimateGas.redeemPositions(
        REDEEM_COLLATERAL_ADDRESS,
        parentCollectionId,
        conditionId,
        indexSets,
      );
      const tx = await contract.redeemPositions(
        REDEEM_COLLATERAL_ADDRESS,
        parentCollectionId,
        conditionId,
        indexSets,
        { gasLimit: gasEstimate.mul(120).div(100) },
      );
      const receipt = await tx.wait();
      return {
        success: receipt?.status === 1,
        txHash: tx.hash,
        receipt,
        address: signerAddress,
      };
    } catch (e) {
      return { success: false, error: e.message };
    }
  }

  async getBalance() {
    const result = await this.getClobCollateralBalance();
    return result?.success ? result.balance : null;
  }

  async withdrawPusdFromProxy(toAddress, amountUsdc) {
    if (!this.wallet || !ethers) {
      return { success: false, error: "No wallet loaded", requiresManual: true };
    }
    if (!this._isAddress(toAddress)) {
      return { success: false, error: "Invalid withdrawal destination address" };
    }
    const amount = Number(amountUsdc);
    if (!Number.isFinite(amount) || amount <= 0) {
      return { success: false, error: "Invalid withdrawal amount" };
    }

    try {
      const destination = ethers.utils.getAddress(toAddress);
      const proxyFunder = this.getSelectedFunderAddress?.() || this.getStatus?.()?.tradeReady?.selected?.funderAddress || null;
      const source = this._isAddress(proxyFunder) ? ethers.utils.getAddress(proxyFunder) : null;
      if (!source) {
        return { success: false, error: "No proxy/funder wallet selected for pUSD withdrawal", requiresManual: true };
      }
      const balanceResult = await this.getOnChainPusdBalance(source);
      const balance = Number(balanceResult?.balance || 0);
      if (!balanceResult?.success) {
        return { success: false, error: balanceResult?.error || "Unable to read proxy pUSD balance", source };
      }
      if (amount > balance + 0.000001) {
        return { success: false, error: `Insufficient proxy pUSD balance (${balance.toFixed(6)} available)`, source, balance };
      }

      const iface = new ethers.utils.Interface(PUSD_ABI);
      const calldata = iface.encodeFunctionData("transfer", [
        destination,
        ethers.utils.parseUnits(amount.toFixed(6), USDC_DECIMALS),
      ]);
      const submitted = await this._submitProxyRelayTransactions(
        [{ to: PUSD_ADDRESS, data: calldata, value: "0" }],
        `telegram withdraw ${amount.toFixed(6)} pUSD to ${destination}`,
      );
      return {
        ...(submitted || {}),
        source,
        destination,
        amountUsdc: amount,
        asset: "pUSD",
      };
    } catch (e) {
      return { success: false, error: e.message };
    }
  }

  isReady() {
    return !!ClobClient && !!ethers && !!this.wallet;
  }

  getStatus() {
    const relayerAuthMode = this._getRelayerAuthMode();
    const builderAutoDerivable = !!(
      BuilderConfig &&
      CallType &&
      encodeProxyTransactionData &&
      getRelayContractConfig &&
      ClobClient &&
      this.wallet &&
      CONFIG.POLYMARKET_API_KEY &&
      CONFIG.POLYMARKET_SECRET &&
      CONFIG.POLYMARKET_PASSPHRASE
    );
    const tradeReady =
      this._tradeReadyCache && typeof this._tradeReadyCache === "object"
        ? {
            ok: !!this._tradeReadyCache.ok,
            summary: this._tradeReadyCache.summary || null,
            reason: this._tradeReadyCache.reason || null,
            sigType: Number.isFinite(Number(this._tradeReadyCache.sigType))
              ? Number(this._tradeReadyCache.sigType)
              : null,
            balance: Number.isFinite(Number(this._tradeReadyCache.balance))
              ? Number(this._tradeReadyCache.balance)
              : null,
            closedOnly: this._tradeReadyCache.closedOnly ?? null,
            closedOnlyErr: this._tradeReadyCache.closedOnlyErr || null,
            selected: this._tradeReadyCache.selected || null,
            candidates: Array.isArray(this._tradeReadyCache.candidates)
              ? this._tradeReadyCache.candidates
              : [],
          }
        : null;
    return {
      clientAvailable: !!ClobClient,
      ethersAvailable: !!ethers,
      walletLoaded: !!this.wallet,
      walletAddress: this.walletAddress,
      hasCreds: !!(
        CONFIG.POLYMARKET_API_KEY &&
        CONFIG.POLYMARKET_SECRET &&
        CONFIG.POLYMARKET_PASSPHRASE
      ),
      sigType: Number(CONFIG.POLYMARKET_SIGNATURE_TYPE) || 0,
      lastProbe: this._lastSelectionKey,
      proxyConfigured: !!CONFIG.PROXY_URL,
      clobForceProxy: !!CONFIG.CLOB_FORCE_PROXY,
      clobRouting: getClobRoutingDiagnostics(),
      relayerUrl: this._getRelayerUrl(),
      relayerAuthMode,
      relayerAuthReady: !!relayerAuthMode,
      relayerAuthConfigured: !!relayerAuthMode,
      builderAutoDerivable,
      proxyRedeemAuthReady: !!relayerAuthMode || builderAutoDerivable,
      rpcEndpointCount: getPolygonRpcEndpoints().length,
      tradeReady,
    };
  }
}

module.exports = PolymarketCLOB;
