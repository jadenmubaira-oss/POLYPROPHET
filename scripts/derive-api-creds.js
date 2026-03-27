#!/usr/bin/env node
/**
 * Derive Polymarket API credentials from private key.
 * Run this locally (NOT on Render) to get API key/secret/passphrase,
 * then set them as Render environment variables.
 * 
 * Usage: POLYMARKET_PRIVATE_KEY=0x... node scripts/derive-api-creds.js
 */

const pk = process.env.POLYMARKET_PRIVATE_KEY;
if (!pk) {
    console.error('ERROR: Set POLYMARKET_PRIVATE_KEY env var first');
    console.error('Usage: POLYMARKET_PRIVATE_KEY=0x... node scripts/derive-api-creds.js');
    process.exit(1);
}

async function main() {
    let ClobClient, ethers;
    try {
        ClobClient = require('@polymarket/clob-client').ClobClient;
        ethers = require('ethers');
    } catch (e) {
        console.error('ERROR: Missing dependencies. Run: npm install @polymarket/clob-client ethers');
        process.exit(1);
    }

    const provider = new ethers.providers.JsonRpcProvider('https://polygon-bor-rpc.publicnode.com');
    const wallet = new ethers.Wallet(pk, provider);
    console.log('Wallet address:', wallet.address);

    const host = 'https://clob.polymarket.com';
    const chainId = 137;

    console.log('Deriving API credentials...');
    const client = new ClobClient(host, chainId, wallet);
    
    try {
        const creds = await client.createOrDeriveApiKey();
        console.log('\n========== SET THESE IN RENDER ENV ==========\n');
        console.log('POLYMARKET_API_KEY=' + creds.key);
        console.log('POLYMARKET_SECRET=' + creds.secret);
        console.log('POLYMARKET_PASSPHRASE=' + creds.passphrase);
        console.log('\n=============================================');
        console.log('\nAdd these 3 variables to your Render environment.');
        console.log('The bot will use them directly instead of trying to auto-derive.');
    } catch (e) {
        console.error('ERROR deriving creds:', e.message);
        console.error('\nIf you get a geoblock error, try running with a VPN to a non-US region.');
        process.exit(1);
    }
}

main();
