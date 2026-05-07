const CONFIG = require('./config');

const POLYGON_CHAIN_ID = 137;
const PUSD_ADDRESS = '0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB';
const CTF_EXCHANGE_V2 = '0xE111180000d2663C0091e4f400237545B87B996B';
const NEG_RISK_CTF_EXCHANGE_V2 = '0xe2222d279d744050d28e00520010520000310F59';
const CTF_COLLATERAL_ADAPTER = '0xAdA100Db00Ca00073811820692005400218FcE1f';
const NEG_RISK_CTF_COLLATERAL_ADAPTER = '0xadA2005600Dec949baf300f4C6120000bDB6eAab';
const MAX_TEST_FUND_USD = 5;

const ERC20_ABI = [
    'function balanceOf(address owner) view returns (uint256)',
    'function allowance(address owner, address spender) view returns (uint256)',
    'function transfer(address to, uint256 amount) returns (bool)',
    'function approve(address spender, uint256 amount) returns (bool)',
];

let ethersLib = null;
try {
    ethersLib = require('ethers');
} catch (e) {
    ethersLib = null;
}

function getEthers() {
    return ethersLib?.ethers || ethersLib;
}

function getRpcUrl() {
    const multi = String(process.env.POLYGON_RPC_URLS || '').trim();
    if (multi) {
        const first = multi.split(',').map((item) => item.trim()).find(Boolean);
        if (first) return first;
    }
    return String(process.env.POLYGON_RPC_URL || process.env.RPC_URL || 'https://polygon-rpc.com').trim();
}

function getBuilderCreds(required = true) {
    const key = String(CONFIG.POLYMARKET_BUILDER_API_KEY || process.env.BUILDER_API_KEY || '').trim();
    const secret = String(CONFIG.POLYMARKET_BUILDER_SECRET || process.env.BUILDER_SECRET || '').trim();
    const passphrase = String(CONFIG.POLYMARKET_BUILDER_PASSPHRASE || process.env.BUILDER_PASS_PHRASE || process.env.BUILDER_PASSPHRASE || '').trim();
    if (!key || !secret || !passphrase) {
        if (!required) return null;
        throw new Error('BUILDER_CREDS_MISSING');
    }
    return { key, secret, passphrase };
}

async function loadSdk() {
    const [relayer, signing, viem, accounts, chains] = await Promise.all([
        import('@polymarket/builder-relayer-client'),
        import('@polymarket/builder-signing-sdk'),
        import('viem'),
        import('viem/accounts'),
        import('viem/chains'),
    ]);
    return { relayer, signing, viem, accounts, chains };
}

function getProvider() {
    const ethers = getEthers();
    if (!ethers?.providers?.JsonRpcProvider) {
        throw new Error('ETHERS_PROVIDER_UNAVAILABLE');
    }
    return new ethers.providers.JsonRpcProvider(getRpcUrl());
}

async function createRelayerContext(options = {}) {
    if (!CONFIG.POLYMARKET_PRIVATE_KEY) {
        throw new Error('POLYMARKET_PRIVATE_KEY_MISSING');
    }
    const { relayer, signing, viem, accounts, chains } = await loadSdk();
    const privateKey = CONFIG.POLYMARKET_PRIVATE_KEY.startsWith('0x')
        ? CONFIG.POLYMARKET_PRIVATE_KEY
        : `0x${CONFIG.POLYMARKET_PRIVATE_KEY}`;
    const account = accounts.privateKeyToAccount(privateKey);
    const walletClient = viem.createWalletClient({
        account,
        chain: chains.polygon,
        transport: viem.http(getRpcUrl()),
    });
    const builderCreds = getBuilderCreds(!!options.requireBuilder);
    const builderConfig = builderCreds
        ? new signing.BuilderConfig({ localBuilderCreds: builderCreds })
        : undefined;
    const relayClient = new relayer.RelayClient(
        CONFIG.POLYMARKET_RELAYER_URL || 'https://relayer-v2.polymarket.com',
        POLYGON_CHAIN_ID,
        walletClient,
        builderConfig,
        options.relayTxType,
    );
    return { relayClient, ownerAddress: account.address, relayer };
}

async function deriveDepositWalletAddress() {
    const { relayClient, ownerAddress } = await createRelayerContext();
    const depositWalletAddress = await relayClient.deriveDepositWalletAddress();
    return { ownerAddress, depositWalletAddress };
}

async function getDepositWalletStatus() {
    const ethers = getEthers();
    const { relayClient, ownerAddress, relayer } = await createRelayerContext();
    const provider = getProvider();
    const depositWalletAddress = await relayClient.deriveDepositWalletAddress();
    let deployed = false;
    try {
        deployed = await relayClient.getDeployed(depositWalletAddress, relayer.TransactionType?.WALLET || 'WALLET');
    } catch (e) {
        deployed = await provider.getCode(depositWalletAddress).then((code) => code && code !== '0x').catch(() => false);
    }
    const pUsd = new ethers.Contract(PUSD_ADDRESS, ERC20_ABI, provider);
    const proxyAddress = String(CONFIG.POLYMARKET_ADDRESS || '').trim();
    const [depositRaw, proxyRaw, exchangeAllowanceRaw, negRiskAllowanceRaw, adapterAllowanceRaw, negRiskAdapterAllowanceRaw] = await Promise.all([
        pUsd.balanceOf(depositWalletAddress).catch(() => ethers.BigNumber.from(0)),
        proxyAddress ? pUsd.balanceOf(proxyAddress).catch(() => ethers.BigNumber.from(0)) : Promise.resolve(ethers.BigNumber.from(0)),
        pUsd.allowance(depositWalletAddress, CTF_EXCHANGE_V2).catch(() => ethers.BigNumber.from(0)),
        pUsd.allowance(depositWalletAddress, NEG_RISK_CTF_EXCHANGE_V2).catch(() => ethers.BigNumber.from(0)),
        pUsd.allowance(depositWalletAddress, CTF_COLLATERAL_ADAPTER).catch(() => ethers.BigNumber.from(0)),
        pUsd.allowance(depositWalletAddress, NEG_RISK_CTF_COLLATERAL_ADAPTER).catch(() => ethers.BigNumber.from(0)),
    ]);
    return {
        ownerAddress,
        proxyAddress: proxyAddress || null,
        depositWalletAddress,
        deployed,
        balances: {
            proxyPusd: Number(ethers.utils.formatUnits(proxyRaw, 6)),
            depositWalletPusd: Number(ethers.utils.formatUnits(depositRaw, 6)),
        },
        allowances: {
            ctfExchangeV2: exchangeAllowanceRaw.gt(0),
            negRiskCtfExchangeV2: negRiskAllowanceRaw.gt(0),
            ctfCollateralAdapter: adapterAllowanceRaw.gt(0),
            negRiskCtfCollateralAdapter: negRiskAdapterAllowanceRaw.gt(0),
        },
        contracts: {
            pUsd: PUSD_ADDRESS,
            ctfExchangeV2: CTF_EXCHANGE_V2,
            negRiskCtfExchangeV2: NEG_RISK_CTF_EXCHANGE_V2,
            ctfCollateralAdapter: CTF_COLLATERAL_ADAPTER,
            negRiskCtfCollateralAdapter: NEG_RISK_CTF_COLLATERAL_ADAPTER,
        },
    };
}

async function deployDepositWallet() {
    const { relayClient } = await createRelayerContext({ requireBuilder: true });
    const response = await relayClient.deployDepositWallet();
    const confirmed = typeof response.wait === 'function' ? await response.wait() : null;
    return {
        transactionID: response.transactionID,
        state: response.state,
        transactionHash: response.transactionHash || response.hash || null,
        confirmed: confirmed ? {
            state: confirmed.state,
            transactionHash: confirmed.transactionHash || null,
            type: confirmed.type || null,
        } : null,
    };
}

async function approveDepositWallet() {
    const ethers = getEthers();
    const { relayClient } = await createRelayerContext({ requireBuilder: true });
    const depositWalletAddress = await relayClient.deriveDepositWalletAddress();
    const iface = new ethers.utils.Interface(ERC20_ABI);
    const max = ethers.constants.MaxUint256.toString();
    const calls = [CTF_EXCHANGE_V2, NEG_RISK_CTF_EXCHANGE_V2, CTF_COLLATERAL_ADAPTER, NEG_RISK_CTF_COLLATERAL_ADAPTER]
        .map((spender) => ({
            target: PUSD_ADDRESS,
            value: '0',
            data: iface.encodeFunctionData('approve', [spender, max]),
        }));
    const deadline = String(Math.floor(Date.now() / 1000) + 240);
    const response = await relayClient.executeDepositWalletBatch(calls, depositWalletAddress, deadline);
    const confirmed = typeof response.wait === 'function' ? await response.wait() : null;
    return {
        depositWalletAddress,
        calls: calls.length,
        transactionID: response.transactionID,
        state: response.state,
        transactionHash: response.transactionHash || response.hash || null,
        confirmed: confirmed ? {
            state: confirmed.state,
            transactionHash: confirmed.transactionHash || null,
            type: confirmed.type || null,
        } : null,
    };
}

async function fundDepositWalletFromProxy(amountUsd) {
    const ethers = getEthers();
    const amount = Number(amountUsd);
    if (!Number.isFinite(amount) || amount <= 0 || amount > MAX_TEST_FUND_USD) {
        throw new Error(`TEST_FUND_AMOUNT_MUST_BE_0_TO_${MAX_TEST_FUND_USD}`);
    }
    const proxyAddress = String(CONFIG.POLYMARKET_ADDRESS || '').trim();
    if (!proxyAddress) throw new Error('POLYMARKET_ADDRESS_MISSING');
    const { relayClient, relayer } = await createRelayerContext({ relayTxType: 'PROXY', requireBuilder: true });
    const depositWalletAddress = await relayClient.deriveDepositWalletAddress();
    const iface = new ethers.utils.Interface(ERC20_ABI);
    const amountRaw = ethers.utils.parseUnits(amount.toFixed(6), 6);
    const response = await relayClient.execute(
        [{ to: PUSD_ADDRESS, value: '0', data: iface.encodeFunctionData('transfer', [depositWalletAddress, amountRaw]) }],
        `deposit-wallet-test-fund:${amount.toFixed(6)}`,
    );
    const confirmed = typeof response.wait === 'function' ? await response.wait() : null;
    return {
        fromProxyAddress: proxyAddress,
        depositWalletAddress,
        amountUsd: amount,
        amountRaw: amountRaw.toString(),
        relayerMode: relayer.RelayerTxType?.PROXY || 'PROXY',
        transactionID: response.transactionID,
        state: response.state,
        transactionHash: response.transactionHash || response.hash || null,
        confirmed: confirmed ? {
            state: confirmed.state,
            transactionHash: confirmed.transactionHash || null,
            type: confirmed.type || null,
        } : null,
    };
}

module.exports = {
    MAX_TEST_FUND_USD,
    deriveDepositWalletAddress,
    getDepositWalletStatus,
    deployDepositWallet,
    approveDepositWallet,
    fundDepositWalletFromProxy,
};