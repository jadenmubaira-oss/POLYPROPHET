require('dotenv').config({ path: process.env.ENV_FILE || 'POLYPROPHET.env' });
require('dotenv').config();

const { ClobClient } = require('@polymarket/clob-client');
const { ethers } = require('ethers');

const host = process.env.POLYMARKET_CLOB_HOST || 'https://clob.polymarket.com';
const chainId = Number(process.env.POLYMARKET_CHAIN_ID || 137);
const privateKey = String(process.env.POLYMARKET_PRIVATE_KEY || process.argv[2] || '').trim();
const signatureType = Number(process.env.POLYMARKET_SIGNATURE_TYPE || 1) === 1 ? 1 : 0;
const funder = String(process.env.POLYMARKET_ADDRESS || process.env.POLYMARKET_FUNDER_ADDRESS || '').trim();

function pickCreds(raw) {
  const key = String(raw?.key || raw?.apiKey || raw?.api_key || '').trim();
  const secret = String(raw?.secret || raw?.apiSecret || raw?.api_secret || '').trim();
  const passphrase = String(raw?.passphrase || raw?.apiPassphrase || raw?.api_passphrase || '').trim();
  return key && secret && passphrase ? { key, secret, passphrase } : null;
}

function redact(raw) {
  if (!raw || typeof raw !== 'object') return raw;
  const out = {};
  for (const [k, v] of Object.entries(raw)) {
    const text = typeof v === 'string' ? v : JSON.stringify(v);
    out[k] = typeof text === 'string' && text.length > 12 ? `${text.slice(0, 6)}...${text.slice(-4)}` : text;
  }
  return out;
}

async function main() {
  if (!privateKey || !privateKey.startsWith('0x')) {
    throw new Error('Set POLYMARKET_PRIVATE_KEY or pass it as argv[2].');
  }
  if (signatureType === 1 && !ethers.utils.isAddress(funder)) {
    throw new Error('POLYMARKET_SIGNATURE_TYPE=1 requires POLYMARKET_ADDRESS/POLYMARKET_FUNDER_ADDRESS proxy address.');
  }

  const provider = new ethers.providers.JsonRpcProvider(process.env.POLYGON_RPC_URL || 'https://polygon-rpc.com');
  const wallet = new ethers.Wallet(privateKey, provider);
  const l1Client = new ClobClient(host, chainId, wallet, undefined, signatureType, signatureType === 1 ? funder : wallet.address);

  let apiCreds = pickCreds({
    key: process.env.POLYMARKET_API_KEY,
    secret: process.env.POLYMARKET_SECRET,
    passphrase: process.env.POLYMARKET_PASSPHRASE,
  });

  if (!apiCreds) {
    const raw = await l1Client.createOrDeriveApiKey();
    apiCreds = pickCreds(raw);
    if (!apiCreds) {
      console.error('CLOB credential response was incomplete:', JSON.stringify(redact(raw), null, 2));
      throw new Error('Could not derive complete POLYMARKET_API_KEY/SECRET/PASSPHRASE.');
    }
  }

  const l2Client = new ClobClient(host, chainId, wallet, apiCreds, signatureType, signatureType === 1 ? funder : wallet.address);
  const rawBuilder = await l2Client.createBuilderApiKey();
  const builderCreds = pickCreds(rawBuilder);

  console.log('Wallet:', wallet.address);
  console.log('Funder:', signatureType === 1 ? funder : wallet.address);
  console.log('SignatureType:', signatureType);
  console.log('Run this CLOB command exactly:');
  console.log(`flyctl secrets set POLYMARKET_API_KEY="${apiCreds.key}" POLYMARKET_SECRET="${apiCreds.secret}" POLYMARKET_PASSPHRASE="${apiCreds.passphrase}" --app polyprophet`);

  if (!builderCreds) {
    console.error('Builder credential response was incomplete:', JSON.stringify(redact(rawBuilder), null, 2));
    const existing = await l2Client.getBuilderApiKeys().catch((e) => ({ error: e.message }));
    console.error('Existing builder keys metadata:', JSON.stringify(existing, null, 2));
    console.log('Builder credential creation did not return secret/passphrase values.');
    console.log('Use Polymarket Settings > Relayer API Keys and set POLYMARKET_RELAYER_API_KEY plus POLYMARKET_RELAYER_API_KEY_ADDRESS instead.');
    return;
  }

  console.log('Run this builder command exactly, then re-run /api/auto-redeem:');
  console.log(`flyctl secrets set POLYMARKET_BUILDER_API_KEY="${builderCreds.key}" POLYMARKET_BUILDER_SECRET="${builderCreds.secret}" POLYMARKET_BUILDER_PASSPHRASE="${builderCreds.passphrase}" --app polyprophet`);
}

main().catch((e) => {
  console.error('FAILED:', e.message);
  process.exit(1);
});
