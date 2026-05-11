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

console.log("✅ V2 sigType preservation verified");