const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const sourcePath = path.join(__dirname, "..", "lib", "clob-client.js");
const source = fs.readFileSync(sourcePath, "utf8");

const normalizeMatch = source.match(
  /function normalizeSignatureType\(value\) \{[\s\S]*?\n\}/,
);
assert(normalizeMatch, "normalizeSignatureType function not found");

const sandbox = {};
vm.runInNewContext(`${normalizeMatch[0]}; this.normalizeSignatureType = normalizeSignatureType;`, sandbox);

assert.strictEqual(sandbox.normalizeSignatureType(0), 0, "sigType 0 must remain EOA");
assert.strictEqual(sandbox.normalizeSignatureType(1), 1, "sigType 1 must remain proxy");
assert.strictEqual(sandbox.normalizeSignatureType(2), 2, "sigType 2 must be preserved");
assert.strictEqual(sandbox.normalizeSignatureType(3), 3, "sigType 3 must be preserved for V2 smart-wallet orders");
assert.strictEqual(sandbox.normalizeSignatureType(99), null, "unknown signature types must be rejected");

assert(
  source.includes("addAttempt(prefSigType, proxyAddr || signerAddr"),
  "credential derivation must try the preferred configured signature type first",
);
assert(
  /await addCandidate\(\s*preferredSigType,/.test(source),
  "trade-ready probing must add the preferred non-0/1 signature type candidate",
);
assert(
  source.includes('raw.includes("order signer") && raw.includes("api key")') &&
    source.includes('raw.includes("signer address") && raw.includes("api key")'),
  "order signer/API-key mismatch must be retryable across ready CLOB candidates",
);
assert(
  source.includes("_refreshOrderSignerCredsForCandidate") &&
    source.includes("createOrDeriveApiKey") &&
    source.includes("order-signer-api-key-mismatch"),
  "order signer/API-key mismatch must rederive order-capable API credentials before retrying",
);
assert(
  source.includes("response?.data ?? response?.body ?? response?.error ?? null") &&
    source.includes("response?.message || response?.error"),
  "CLOB SDK {error,status} order failures must be surfaced so signer/API-key mismatch is retryable",
);
assert(
  source.includes("POLYMARKET_ORDER_AUTH_DERIVE"),
  "order-auth credential derivation must have an explicit env kill switch",
);
assert(
  source.includes("POLYMARKET_RAW_POLY1271_SIGNING") &&
    source.includes("CONFIG.POLYMARKET_RAW_POLY1271_SIGNING && candidate.signatureType === 3"),
  "custom raw POLY_1271 signing must be optional so upgraded SDK path can be preferred",
);
assert(
  source.includes("_buildPoly1271SignedOrder") &&
    source.includes("maker: ethers.utils.getAddress(funder)") &&
    source.includes("signer: ethers.utils.getAddress(funder)") &&
    source.includes("TypedDataSign") &&
    source.includes("Order(uint256 salt,address maker,address signer"),
  "sigType-3 deposit-wallet orders must use raw ERC-7739 wrapped signing with maker=signer=funder",
);
assert(
  source.includes("candidate.client = new ClobClient") &&
    source.includes("candidate.credsSource = attempt.label"),
  "credential refresh must rebuild the candidate client with the refreshed API key",
);
assert(
  source.includes("new ClobClient({") &&
    !source.includes("new ClobClient(\n        host,") &&
    !source.includes("new ClobClient(\n          host,"),
  "clob-client-v2 must use object-style constructor, not legacy positional constructor",
);

console.log("✅ V2 sigType preservation verified");