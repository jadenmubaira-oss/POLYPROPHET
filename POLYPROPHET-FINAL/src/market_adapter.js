/**
 * POLYPROPHET FINAL: MARKET ADAPTER
 * 
 * Polymarket API integration with retry logic.
 */

const axios = require('axios');
const https = require('https');
const { HttpsProxyAgent } = require('https-proxy-agent');

class MarketAdapter {
    constructor() {
        this.GAMMA_API = 'https://gamma-api.polymarket.com';
        this.proxyAgent = process.env.PROXY_URL ? new HttpsProxyAgent(process.env.PROXY_URL) : null;
        this.client = axios.create({
            timeout: 10000,
            httpsAgent: this.proxyAgent || https.globalAgent
        });
    }

    getCurrentCheckpoint() {
        const now = Math.floor(Date.now() / 1000);
        return Math.floor(now / 900) * 900;
    }

    async getMarketState(asset, checkpoint = null, retries = 3) {
        if (!checkpoint) checkpoint = this.getCurrentCheckpoint();

        for (let attempt = 1; attempt <= retries; attempt++) {
            try {
                const slug = `${asset.toLowerCase()}-price-checkpoint`;
                let resp = await this.client.get(`${this.GAMMA_API}/markets?slug=${slug}`, { timeout: 8000 });
                let markets = resp.data;

                if (!markets || markets.length === 0) {
                    const preciseSlug = `${asset.toLowerCase()}-price-${checkpoint}`;
                    resp = await this.client.get(`${this.GAMMA_API}/markets?slug=${preciseSlug}`, { timeout: 8000 });
                    markets = resp.data;
                }

                const market = markets && markets[0];
                if (!market) {
                    if (attempt < retries) {
                        await new Promise(r => setTimeout(r, 2000 * attempt));
                        continue;
                    }
                    return null;
                }

                return this.formatMarket(market);
            } catch (err) {
                if (attempt < retries) {
                    await new Promise(r => setTimeout(r, 2000 * attempt));
                    continue;
                }
                console.error(`[ADAPTER] Market fetch failed for ${asset}: ${err.message}`);
                return null;
            }
        }
        return null;
    }

    formatMarket(market) {
        return {
            id: market.id,
            conditionId: market.conditionId,
            yesPrice: parseFloat(market.outcomePrices?.[0] || market.outcome_prices?.[0] || 0.5),
            noPrice: parseFloat(market.outcomePrices?.[1] || market.outcome_prices?.[1] || 0.5),
            timeRemaining: this.calculateSecondsToExpiry(market.end_date_iso),
            volume: parseFloat(market.volume || 0),
            slug: market.slug
        };
    }

    calculateSecondsToExpiry(isoDate) {
        if (!isoDate) return 900;
        const expiry = new Date(isoDate).getTime();
        return Math.max(0, Math.floor((expiry - Date.now()) / 1000));
    }
}

module.exports = MarketAdapter;

