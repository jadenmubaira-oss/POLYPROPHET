// 🔥 LATENCY ARBITRAGE DETECTOR
// Based on 0x8dxd strategy that achieved 98-99% WR ($300 → $550K)
// 
// STRATEGY: Compare real-time CEX price to Polymarket odds
// If CEX shows clear direction but Polymarket still at 50/50, BET WITH EDGE
//
// NOTE: Polymarket added dynamic fees (up to 3.15%) to counter this
// Must factor in fees to calculate true edge

const https = require('https');

// Polymarket market data
async function getPolymarketOdds(slug) {
    return new Promise((resolve) => {
        const url = `https://gamma-api.polymarket.com/markets?slug=${encodeURIComponent(slug)}`;
        https.get(url, { timeout: 5000 }, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    const parsed = JSON.parse(data);
                    const market = parsed[0];
                    if (!market) return resolve(null);

                    const prices = JSON.parse(market.outcomePrices || '[]');
                    resolve({
                        slug,
                        upPrice: Number(prices[0]) || 0.5,
                        downPrice: Number(prices[1]) || 0.5,
                        active: market.active && !market.closed,
                        volume: market.volumeNum,
                        lastTradePrice: market.lastTradePrice
                    });
                } catch {
                    resolve(null);
                }
            });
        }).on('error', () => resolve(null));
    });
}

// Binance real-time price
async function getBinancePrice(symbol) {
    return new Promise((resolve) => {
        const url = `https://api.binance.com/api/v3/ticker/price?symbol=${symbol}`;
        https.get(url, { timeout: 5000 }, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    const parsed = JSON.parse(data);
                    resolve(Number(parsed.price) || 0);
                } catch {
                    resolve(0);
                }
            });
        }).on('error', () => resolve(0));
    });
}

// Calculate if there's a latency arbitrage opportunity
function detectLatencyArbitrage(startPrice, currentPrice, polymarketOdds) {
    const priceChange = (currentPrice - startPrice) / startPrice;
    const priceDirection = priceChange > 0 ? 'UP' : 'DOWN';
    const priceMovement = Math.abs(priceChange) * 100; // in percent

    // If price moved significantly but Polymarket still near 50/50
    const isNear5050 = polymarketOdds.upPrice >= 0.40 && polymarketOdds.upPrice <= 0.60;

    // Dynamic fee is highest at 50/50 (can be 3.15%)
    // Need significant movement to overcome fee
    const estimatedFee = isNear5050 ? 0.0315 : 0.01;
    const minMovementForEdge = 0.5; // 0.5% price movement minimum

    const hasEdge = priceMovement >= minMovementForEdge && isNear5050;
    const potentialProfit = hasEdge ? (1 / polymarketOdds.upPrice - 1) - estimatedFee : 0;

    return {
        priceChange: priceChange * 100,
        priceDirection,
        polymarketUp: polymarketOdds.upPrice,
        polymarketDown: polymarketOdds.downPrice,
        isNear5050,
        hasEdge,
        betDirection: priceDirection,
        estimatedProfitAfterFees: potentialProfit * 100,
        signal: hasEdge ? `🚨 ARBITRAGE: Bet ${priceDirection} @ ${(priceDirection === 'UP' ? polymarketOdds.upPrice : polymarketOdds.downPrice) * 100}¢` : 'No edge'
    };
}

// Get current 15-min cycle epoch
function getCurrentCycleEpoch() {
    const now = Math.floor(Date.now() / 1000);
    return now - (now % 900);
}

async function main() {
    console.log('🔥 LATENCY ARBITRAGE DETECTOR v1.0');
    console.log('Based on 0x8dxd strategy (98-99% WR, $300 → $550K)');
    console.log('-------------------------------------------\n');

    const epoch = getCurrentCycleEpoch();
    const elapsed = Math.floor(Date.now() / 1000) - epoch;
    const remaining = 900 - elapsed;

    console.log(`Current cycle: ${new Date(epoch * 1000).toISOString()}`);
    console.log(`Time elapsed: ${elapsed}s, Remaining: ${remaining}s\n`);

    // Get current Polymarket odds
    const btcSlug = `btc-updown-15m-${epoch}`;
    const ethSlug = `eth-updown-15m-${epoch}`;
    const solSlug = `sol-updown-15m-${epoch}`;

    const [btcOdds, ethOdds, solOdds] = await Promise.all([
        getPolymarketOdds(btcSlug),
        getPolymarketOdds(ethSlug),
        getPolymarketOdds(solSlug)
    ]);

    // Get current Binance prices
    const [btcPrice, ethPrice, solPrice] = await Promise.all([
        getBinancePrice('BTCUSDT'),
        getBinancePrice('ETHUSDT'),
        getBinancePrice('SOLUSDT')
    ]);

    console.log('=== CURRENT STATE ===\n');

    if (btcOdds) {
        console.log(`BTC Polymarket: UP=${(btcOdds.upPrice * 100).toFixed(1)}¢, DOWN=${(btcOdds.downPrice * 100).toFixed(1)}¢`);
        console.log(`BTC Binance: $${btcPrice.toFixed(2)}`);
        console.log(`BTC Status: ${btcOdds.active ? 'ACTIVE' : 'CLOSED'}\n`);
    }

    if (ethOdds) {
        console.log(`ETH Polymarket: UP=${(ethOdds.upPrice * 100).toFixed(1)}¢, DOWN=${(ethOdds.downPrice * 100).toFixed(1)}¢`);
        console.log(`ETH Binance: $${ethPrice.toFixed(2)}`);
        console.log(`ETH Status: ${ethOdds.active ? 'ACTIVE' : 'CLOSED'}\n`);
    }

    if (solOdds) {
        console.log(`SOL Polymarket: UP=${(solOdds.upPrice * 100).toFixed(1)}¢, DOWN=${(solOdds.downPrice * 100).toFixed(1)}¢`);
        console.log(`SOL Binance: $${solPrice.toFixed(2)}`);
        console.log(`SOL Status: ${solOdds.active ? 'ACTIVE' : 'CLOSED'}\n`);
    }

    console.log('-------------------------------------------');
    console.log('💡 TO DETECT LATENCY ARBITRAGE:');
    console.log('1. Note the price at cycle START');
    console.log('2. Monitor price movement during cycle');
    console.log('3. If price moves 0.5%+ but Polymarket still 50/50, BET!');
    console.log('4. Account for ~3% dynamic fee at 50/50 odds');
    console.log('-------------------------------------------');
    console.log('\n⚠️ NOTE: Polymarket added dynamic fees to counter this strategy.');
    console.log('Edge may be reduced but not eliminated.\n');
}

main().catch(console.error);
